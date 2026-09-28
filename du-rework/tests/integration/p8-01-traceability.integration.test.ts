import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as path from 'node:path';
import {
  AesCredentialCipher,
  ContractSignedGrantVerifier,
  HmacSignedGrantSource,
  HttpUsageSink,
  PgSqlClient,
  PostgresConnectorConfigRepository,
  createConnectorComposition,
  type ConnectorComposition,
  type GrantVerifier,
} from '@du/connector';
import { createApp, type App } from '@du/orchestrator';
import { startDocumentCoreWorker, type WorkerHandle } from '../../businesses/document-core/src/worker';
import { documentCoreManifest } from '../../businesses/document-core/src/manifest/document-core.manifest';
import { ProfileBindingFixtureClient } from '../../businesses/document-core/tests/helpers/profile-binding-fixture';
import {
  validateTestDatabaseTarget,
  validateTestRedisTarget,
} from '../../businesses/document-core/tests/helpers/test-target-guard';
import {
  assertSafeIsolationConfig,
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../isolation/namespace';

const isolationContext: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({
        runId: process.env.TEST_RUN_ID,
        redisDbIndex: process.env.REDIS_DB_INDEX ? Number(process.env.REDIS_DB_INDEX) : undefined,
      });

const baseDatabaseUrl =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const databaseUrl = isolationContext
  ? isolationContext.getDatabaseUrlWithSchema(baseDatabaseUrl)
  : baseDatabaseUrl;
const baseRedisUrl = process.env.REDIS_URL ?? 'redis://localhost:6380';
const redisUrl = isolationContext
  ? isolationContext.getRedisUrl(baseRedisUrl)
  : baseRedisUrl;

const tenantId = '00000000-0000-0000-0000-000000000001';

// WINDOW GUARD (fleet standard, cycles 103/104): this suite boots PG :5433 /
// Redis :6380 inside its hooks. Without DU_LIVE_INFRA=1 the whole suite —
// including beforeAll/afterAll, which live INSIDE it — is skipped, so a plain
// integration run outside a claimed DB window opens zero connections.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('p8-01-traceability: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}
const apiKey = `p8-01-${randomUUID()}`;
const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
const runtimeToken = `p8-01-runtime-${randomUUID()}`;
const workerIdentityToken = `p8-01-worker-${randomUUID()}`;
const adminToken = `p8-01-admin-${randomUUID()}`;
const usageToken = `p8-01-usage-${randomUUID()}`;
const invocationGrantSecret = `p8-01-grant-${randomUUID()}`;
const connectorId = `p8-01-${randomUUID().replace(/-/g, '').slice(0, 20)}`;
const credentialRef = `credential-${connectorId}`;
const connectorMigrationDirectory = path.resolve(
  __dirname,
  '../../services/connector/src/db/migrations'
);
const encryptionKey = randomBytes(32);

interface ProviderObservation {
  body: Record<string, unknown>;
  idempotencyKey: string | undefined;
}

interface RootTraceRow {
  id: string;
  operation_id: string;
  task_key: string;
  kind: string;
  state: string;
}

interface GrantTraceRow {
  invocation_id: string;
  operation_id: string;
  task_id: string;
  step_key: string;
  connector_id: string;
  binding_slot: string;
}

interface ConnectorTraceRow {
  invocation_id: string;
  operation_id: string;
  task_id: string;
  state: string;
  provider_request_id: string | null;
}

interface UsageTraceRow {
  event_id: string;
  payload: {
    invocationId?: string;
    operationId?: string;
    taskId?: string;
  };
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, ms));
}

async function waitForValue<T>(
  description: string,
  read: () => Promise<T | undefined>,
  timeoutMs = 25_000
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = await read();
    if (value !== undefined) return value;
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo | null;
  if (!address || typeof address === 'string') throw new Error('Server did not bind a TCP port');
  return address.port;
}

async function closeServer(server: Server | undefined): Promise<void> {
  if (!server?.listening) return;
  server.closeAllConnections?.();
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

liveDescribe('P8-01 persisted operation-to-audit traceability', () => {
  let app: App | undefined;
  let orchestratorUrl = '';
  let connector: ConnectorComposition | undefined;
  let connectorUrl = '';
  let providerServer: Server | undefined;
  let worker: WorkerHandle | undefined;
  let connectorSetupClient: PgSqlClient | undefined;
  let schemaSetupClient: PgSqlClient | undefined;
  let profileId: string | undefined;

  let resolveStepSaveGate!: () => void;
  let stepSaveGateReleased = false;
  let releaseStepSave: (() => void) | undefined;
  let signalStepSaveReached: (() => void) | undefined;
  let stepSaveWasIntercepted = false;
  const stepSaveReached = new Promise<void>((resolve) => {
    signalStepSaveReached = resolve;
  });
  const stepSaveGate = new Promise<void>((resolve) => {
    resolveStepSaveGate = resolve;
  });
  releaseStepSave = () => {
    if (stepSaveGateReleased) return;
    stepSaveGateReleased = true;
    resolveStepSaveGate();
  };
  let activeRootTaskId: string | undefined;

  function withTimeout<T>(promise: Promise<T>, timeoutMs: number, description: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Timed out waiting for ${description}`)), timeoutMs);
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error: unknown) => {
          clearTimeout(timer);
          reject(error);
        }
      );
    });
  }

  let resolveProviderRequest!: (observation: ProviderObservation) => void;
  const providerRequestSeen = new Promise<ProviderObservation>((resolve) => {
    resolveProviderRequest = resolve;
  });

  const providerRequestId = `p8-01-provider-${randomUUID()}`;
  const providerPayload = {
    invoiceNumber: 'P8-01-TRACE-001',
    supplier: { name: 'Traceability Test Supplier', taxId: 'US-123456789' },
    buyer: { name: 'DUGate Traceability Test' },
    invoiceDate: '2026-09-25',
    lineItems: [{ description: 'Traceability harness', quantity: 1, unitPrice: 4200, amount: 4200 }],
    subtotal: 4200,
    total: 4200,
    currency: 'USD',
  };

  const customFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
    const method = init?.method?.toUpperCase() ?? 'GET';
    const stepRoute = url.match(/\/tasks\/([^/]+)\/steps\//);
    if (!stepSaveWasIntercepted && method === 'PUT' && stepRoute) {
      stepSaveWasIntercepted = true;
      activeRootTaskId = stepRoute[1];
      signalStepSaveReached?.();
      // Keep this below RuntimeClient's fetch deadline even if an assertion stalls.
      const safetyRelease = setTimeout(() => releaseStepSave?.(), 5_000);
      safetyRelease.unref?.();
      try {
        await stepSaveGate;
      } finally {
        clearTimeout(safetyRelease);
      }
    }
    return fetch(input, init);
  };

  beforeAll(async () => {
    validateTestDatabaseTarget(baseDatabaseUrl);
    validateTestRedisTarget(baseRedisUrl);
    validateTestDatabaseTarget(databaseUrl);
    validateTestRedisTarget(redisUrl);
    assertSafeIsolationConfig({
      databaseUrl,
      redisUrl,
      isolationCtx: isolationContext,
      allowUnsafeShared: process.env.ALLOW_UNSAFE_SHARED_DB === 'true',
    });

    if (isolationContext) {
      schemaSetupClient = new PgSqlClient({ connectionString: baseDatabaseUrl });
      try {
        await schemaSetupClient.query(generateSchemaSetupDdl(isolationContext.dbSchema));
      } finally {
        await schemaSetupClient.close();
        schemaSetupClient = undefined;
      }
    }

    providerServer = createServer(async (request, response) => {
      let rawBody = '';
      for await (const chunk of request) rawBody += chunk.toString();
      let body: Record<string, unknown> = {};
      try {
        body = rawBody ? (JSON.parse(rawBody) as Record<string, unknown>) : {};
      } catch {
        response.writeHead(400, { 'content-type': 'application/json' });
        response.end(JSON.stringify({ error: 'invalid JSON' }));
        return;
      }
      const rawIdempotencyKey = request.headers['idempotency-key'];
      resolveProviderRequest({
        body,
        idempotencyKey: Array.isArray(rawIdempotencyKey)
          ? rawIdempotencyKey[0]
          : rawIdempotencyKey,
      });
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(
        JSON.stringify({
          data: providerPayload,
          content: JSON.stringify(providerPayload),
          usage: {
            inputTokens: 24,
            outputTokens: 12,
            costMicrousd: 36,
            measurement: 'measured',
          },
          providerRequestId,
        })
      );
    });
    const providerPort = await listen(providerServer);

    app = await createApp({
      port: 0,
      databaseUrl,
      redisUrl,
      runtimeToken,
      workerIdentityTokensByBusiness: {
        [documentCoreManifest.businessId]: workerIdentityToken,
      },
      adminToken,
      usageToken,
      invocationGrantSecret,
      connectorId,
      connectorRevision: 1,
      autoDispatch: true,
      autoMigrate: true,
      leaseRecoveryIntervalMs: 0,
    });
    const orchestratorServer = await app.listen();
    const orchestratorAddress = orchestratorServer.address();
    if (!orchestratorAddress || typeof orchestratorAddress === 'string') {
      throw new Error('Orchestrator failed to bind an ephemeral port');
    }
    orchestratorUrl = `http://127.0.0.1:${orchestratorAddress.port}`;

    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'p8-01', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status = 'ACTIVE'`,
      [randomUUID(), tenantId, apiKeyHash]
    );

    const registerResponse = await fetch(
      `${orchestratorUrl}/api/runtime/v1/businesses/${documentCoreManifest.businessId}/versions/${documentCoreManifest.version}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(documentCoreManifest),
      }
    );
    if (![200, 201].includes(registerResponse.status)) {
      throw new Error(`Manifest registration failed with HTTP ${registerResponse.status}`);
    }

    for (const action of ['enable', 'activate']) {
      const versionResponse = await fetch(
        `${orchestratorUrl}/api/v1/admin/businesses/${documentCoreManifest.businessId}/versions/${documentCoreManifest.version}/${action}`,
        { method: 'PUT', headers: { authorization: `Bearer ${adminToken}` } }
      );
      if (action === 'enable' && versionResponse.status !== 200) {
        throw new Error(`Manifest enable failed with HTTP ${versionResponse.status}`);
      }
      if (action === 'activate' && ![200, 202].includes(versionResponse.status)) {
        throw new Error(`Manifest activation failed with HTTP ${versionResponse.status}`);
      }
    }

    connectorSetupClient = new PgSqlClient({
      connectionString: databaseUrl,
      migrationDirectory: connectorMigrationDirectory,
    });
    await connectorSetupClient.migrate();
    const cipher = new AesCredentialCipher(encryptionKey);
    const repository = new PostgresConnectorConfigRepository(connectorSetupClient);
    await repository.put(credentialRef, cipher.encrypt('synthetic-provider-credential'));
    const revision = await repository.createRevision({
      connectorId,
      adapter: 'json-http',
      config: {
        baseUrl: `http://127.0.0.1:${providerPort}`,
        path: '/',
        timeoutMs: 10_000,
        requestMapping: {
          prompt: 'input.prompt',
          text: 'input.text',
          options: 'options',
        },
        responseMapping: {
          content: 'content',
          data: 'data',
          usage: 'usage',
          providerRequestId: 'providerRequestId',
        },
      },
      credentialRef,
      state: 'ACTIVE',
    });
    await connectorSetupClient.close();
    connectorSetupClient = undefined;

    const grantVerifier: GrantVerifier = new ContractSignedGrantVerifier(
      new HmacSignedGrantSource(Buffer.from(invocationGrantSecret, 'utf8'))
    );
    connector = createConnectorComposition({
      port: 0,
      host: '127.0.0.1',
      databaseUrl,
      redisUrl,
      migrationDirectory: connectorMigrationDirectory,
      serviceIdentityVerifier: {
        verify: async () => ({
          subject: 'p8-01-document-core-worker',
          audience: 'connector',
          scopes: ['connector:invoke', 'connector:manage'],
        }),
      },
      grantVerifier,
      credentialCipher: new AesCredentialCipher(encryptionKey),
      providerAllowHosts: ['127.0.0.1'],
      allowPrivateProviderNetworks: true,
      usageSink: new HttpUsageSink(`${orchestratorUrl}/api/runtime/v1/usage-events`, usageToken),
      usageDispatcher: { pollIntervalMs: 25, batchSize: 10 },
    });
    await connector.start();
    const connectorAddress = connector.address();
    if (!connectorAddress || typeof connectorAddress === 'string') {
      throw new Error('Connector failed to bind an ephemeral port');
    }
    connectorUrl = `http://127.0.0.1:${connectorAddress.port}`;

    const profileClient = new ProfileBindingFixtureClient({ orchestratorUrl, adminToken });
    const binding = await profileClient.bindDocumentCoreActions({
      apiKey,
      connectorId,
      connectorRevision: revision.revision,
      businessVersion: documentCoreManifest.version,
      actions: ['extract'],
    });
    profileId = binding.profileId;

    worker = await startDocumentCoreWorker({
      runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
      runtimeToken: workerIdentityToken,
      connectorUrl,
      redis: { url: redisUrl },
      workerInstanceId: `p8-01-worker-${randomUUID()}`,
      concurrency: 1,
      heartbeatIntervalMs: 2_000,
      fetchImpl: customFetch,
    });
  }, 45_000);

  afterAll(async () => {
    releaseStepSave?.();
    const cleanupErrors: Error[] = [];
    const attemptCleanup = async (name: string, cleanup: () => Promise<void>): Promise<void> => {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(new Error(`${name}: ${error instanceof Error ? error.message : String(error)}`));
      }
    };
    if (worker) await attemptCleanup('stop worker', () => worker!.stop(5_000));
    if (connector) await attemptCleanup('shutdown connector', () => connector!.shutdown());
    await attemptCleanup('close provider server', () => closeServer(providerServer));
    if (connectorSetupClient) {
      await attemptCleanup('close connector setup database client', () => connectorSetupClient!.close());
    }
    if (schemaSetupClient) {
      await attemptCleanup('close schema setup database client', () => schemaSetupClient!.close());
    }
    if (app) {
      if (profileId) {
        await attemptCleanup('delete test profile binding', async () => {
          await app!.db.query('DELETE FROM profile_bindings WHERE profile_id = $1', [profileId]);
        });
      }
      await attemptCleanup('close orchestrator app', () => app!.close());
    }
    if (isolationContext) {
      const cleanupClient = new PgSqlClient({ connectionString: baseDatabaseUrl });
      try {
        await attemptCleanup('drop isolated test schema', async () => {
          await cleanupClient.query(generateSchemaTeardownDdl(isolationContext.dbSchema));
        });
      } finally {
        await attemptCleanup('close schema cleanup database client', () => cleanupClient.close());
        await attemptCleanup('cleanup isolated artifact directory', async () => {
          isolationContext.cleanupArtifactDir();
        });
      }
    }
    if (cleanupErrors.length > 0) {
      console.error('P8-01 fixture cleanup incomplete:', cleanupErrors);
    }
  }, 30_000);

  test('joins operation, root task, invocation grant, provider request, usage, and audit event', async () => {
    if (!app) throw new Error('Orchestrator fixture was not initialized');

    const submissionCorrelationId = `p8-01-submit-${randomUUID()}`;
    const submitResponse = await fetch(
      `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/extract`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': `p8-01-${randomUUID()}`,
          'x-correlation-id': submissionCorrelationId,
        },
        body: JSON.stringify({
          input: {
            type: 'invoice',
            text: 'P8-01 traceability invoice P8-01-TRACE-001 total $4200',
            outputFormat: 'json',
          },
        }),
      }
    );
    expect(submitResponse.status).toBe(202);
    const submission = (await submitResponse.json()) as { operationId: string };
    expect(submission.operationId).toMatch(/^[0-9a-f-]{36}$/i);

    const operation = await waitForValue('persisted operation root task', async () => {
      const result = await app!.db.query<{
        id: string;
        root_task_id: string | null;
        tenant_id: string;
        action: string;
        correlation_id: string;
        state: string;
      }>(
        'SELECT id, root_task_id, tenant_id, action, correlation_id, state FROM operations WHERE id = $1',
        [submission.operationId]
      );
      const row = result.rows[0];
      return row?.root_task_id ? row : undefined;
    });
    expect(operation.id).toBe(submission.operationId);
    expect(operation.tenant_id).toBe(tenantId);
    expect(operation.action).toBe('extract');
    expect(operation.correlation_id).toBe(submissionCorrelationId);

    const rootTask = await app.db.query<RootTraceRow>(
      `SELECT id, operation_id, task_key, kind, state
       FROM tasks WHERE id = $1`,
      [operation.root_task_id]
    );
    expect(rootTask.rowCount).toBe(1);
    expect(rootTask.rows[0]).toMatchObject({
      id: operation.root_task_id,
      operation_id: operation.id,
      task_key: 'root',
      kind: 'root',
    });
    const providerObservationPromise = providerRequestSeen;
    await withTimeout(stepSaveReached, 30_000, 'post-provider step checkpoint');
    expect(activeRootTaskId).toBe(operation.root_task_id);
    const providerObservation = await providerObservationPromise;

    try {
      const auditCorrelationId = submissionCorrelationId;
      const cancelResponse = await fetch(`${orchestratorUrl}/api/v1/admin/actions`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
          'x-correlation-id': auditCorrelationId,
        },
        body: JSON.stringify({
          action: 'operations.cancel',
          params: { operationId: operation.id },
        }),
      });
      expect(cancelResponse.status).toBe(200);
      expect((await cancelResponse.json() as { state?: string }).state).toBe('CANCELLED');

      const audit = await app.db.query<{
        tenant_id: string | null;
        actor: string;
        action: string;
        resource: string;
        correlation_id: string | null;
      }>(
        `SELECT tenant_id, actor, action, resource, correlation_id
         FROM admin_audit_events WHERE resource = $1 AND correlation_id = $2`,
        [`operation:${operation.id}`, auditCorrelationId]
      );
      expect(audit.rowCount).toBe(1);
      expect(audit.rows[0]).toMatchObject({
        actor: 'admin',
        action: 'operation.cancel',
        resource: `operation:${operation.id}`,
        correlation_id: auditCorrelationId,
      });
    } finally {
      releaseStepSave?.();
    }

    const grant = await waitForValue('invocation grant for root task', async () => {
      const result = await app!.db.query<GrantTraceRow>(
        `SELECT invocation_id, operation_id, task_id, step_key, connector_id, binding_slot
         FROM invocation_grants WHERE operation_id = $1 AND task_id = $2
         ORDER BY created_at DESC LIMIT 1`,
        [operation.id, rootTask.rows[0]!.id]
      );
      return result.rows[0];
    });
    expect(grant).toMatchObject({
      operation_id: operation.id,
      task_id: rootTask.rows[0]!.id,
      step_key: 'extract:connector-inference',
      connector_id: connectorId,
      binding_slot: 'reasoning',
    });
    expect(providerObservation.idempotencyKey).toBe(grant.invocation_id);

    const connectorInvocation = await waitForValue('successful Connector invocation ledger row', async () => {
      const result = await app!.db.query<ConnectorTraceRow>(
        `SELECT invocation_id, operation_id, task_id, state, provider_request_id
         FROM connector_invocations WHERE invocation_id = $1`,
        [grant.invocation_id]
      );
      const row = result.rows[0];
      return row?.state === 'SUCCEEDED' ? row : undefined;
    });
    expect(connectorInvocation).toMatchObject({
      invocation_id: grant.invocation_id,
      operation_id: operation.id,
      task_id: rootTask.rows[0]!.id,
      state: 'SUCCEEDED',
      provider_request_id: providerRequestId,
    });
    expect(providerObservation.body).toMatchObject({
      prompt: expect.any(String),
      text: expect.stringContaining('P8-01-TRACE-001'),
    });

    const usage = await waitForValue('usage ledger event linked to invocation grant', async () => {
      const result = await app!.db.query<UsageTraceRow>(
        `SELECT event_id, payload FROM usage_events WHERE operation_id = $1 AND task_id = $2`,
        [operation.id, rootTask.rows[0]!.id]
      );
      const row = result.rows.find((candidate) => candidate.payload.invocationId === grant.invocation_id);
      return row;
    });
    expect(usage.payload).toMatchObject({
      operationId: operation.id,
      taskId: rootTask.rows[0]!.id,
      invocationId: grant.invocation_id,
    });

    await waitForValue('cancelled operation state', async () => {
      const result = await app!.db.query<{ state: string }>(
        'SELECT state FROM operations WHERE id = $1',
        [operation.id]
      );
      return result.rows[0]?.state === 'CANCELLED' ? result.rows[0] : undefined;
    });
  }, 90_000);
});
