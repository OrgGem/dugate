import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { type ChildProcess } from 'node:child_process';
import {
  ArtifactAccessGrant,
  InvocationGrant,
  type InvocationResponse,
  type ProblemDetails,
} from '@du/contracts';
import { createApp, type App } from '@du/orchestrator';
import {
  createConnectorComposition,
  ContractSignedGrantVerifier,
  HmacSignedGrantSource,
  HttpUsageSink,
  PostgresConnectorConfigRepository,
  PgSqlClient,
  AesCredentialCipher,
  hashInvocationInput,
  type GrantVerifier,
  type GrantClaims,
  type ConnectorComposition,
  type LocalInvocationRequest,
} from '@du/connector';
import { defineBusiness, startWorker, type TaskHandler } from '@du/worker-sdk';
import { documentCoreManifest } from '../src/manifest/document-core.manifest';
import { startDocumentCoreWorker, type WorkerHandle, documentCoreHandlers } from '../src/worker';
import { validateTestDatabaseTarget, validateTestRedisTarget } from './helpers/test-target-guard';
import { ManagedChildProcessTracker } from './helpers/child-process-manager';
import { ProfileBindingFixtureClient } from './helpers/profile-binding-fixture';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

/**
 * Cross-Service Process E2E Suite (R08-04 / W09-A1 / W10-A1 / W12-A / W13-A / W14-A Integration)
 *
 * Runs unshimmed against live Orchestrator, Connector, and Document-Core Worker
 * using real HMAC-signed grants with canonical SDK/Connector invocation input hashing.
 * Independent admin and runtime credentials enforce fail-closed authorization.
 *
 * Shared-DB Concurrency Limitation (Wave 13 / 14):
 * This end-to-end integration test suite uses PostgreSQL on 5433 and Redis on 6380.
 * Because parallel test suites (such as services/orchestrator/tests/runtime.test.ts)
 * execute global TRUNCATE on business_versions, operations, and tasks, this suite
 * must be run sequentially (--runInBand) until isolated per-suite databases/schemas
 * are provisioned by the platform lane.
 */
describe('Cross-Service Process E2E (Orchestrator + Connector + Document-Core Worker)', () => {
  let orchestratorApp: App | undefined;
  let orchestratorUrl: string;
  let connectorComposition: ConnectorComposition | undefined;
  let connectorUrl: string;
  let providerServer: Server | undefined;
  let providerPort: number;
  let workerHandle: WorkerHandle | undefined;

  let providerCalls = 0;
  let lastProviderRequest: Record<string, unknown> | undefined;

  // Track primary operation & invocation across scoped tests
  let primaryOperationId = '';
  let primaryInvocationId = '';

  // Suite-owned profile client and profile ID (W19/W20)
  let profileClient: ProfileBindingFixtureClient | undefined;
  let suiteProfileId = '';

  // Deterministic failure barrier controls for interrupted-task recovery test
  let simulateFailureForOperationId: string | null = null;
  let failureBarrierTriggered = false;

  // Version pinning barrier controls: hold in-flight task at step barrier
  let versionPinningHoldNextDocCore = false;
  let versionPinningHoldTaskId: string | null = null;
  let versionPinningBarrierPromise: Promise<void> | null = null;
  let versionPinningBarrierRelease: (() => void) | null = null;
  let versionPinningReachedBarrierPromise: Promise<void> | null = null;
  let versionPinningReachedBarrierSignal: (() => void) | null = null;

  // Connector revision pinning barrier controls (PRF-02 / W20)
  let connectorPinningHoldNext = false;
  let connectorPinningHoldTaskId: string | null = null;
  let connectorPinningBarrierPromise: Promise<void> | null = null;
  let connectorPinningBarrierRelease: (() => void) | null = null;
  let connectorPinningReachedBarrierPromise: Promise<void> | null = null;
  let connectorPinningReachedBarrierSignal: (() => void) | null = null;

  // Dedicated child process tracker for lifecycle and crash testing
  const childTracker = new ManagedChildProcessTracker();

  // Track all partially created resources for failure-proof aggregated teardown
  const partiallyCreatedResources = {
    dbClients: [] as PgSqlClient[],
    servers: [] as Server[],
    workers: [] as WorkerHandle[],
    compositions: [] as ConnectorComposition[],
    apps: [] as App[],
    childProcesses: [] as ChildProcess[],
  };

  const adminToken = `admin-token-${randomUUID()}`;
  const runtimeToken = `runtime-token-${randomUUID()}`;
  const usageToken = `usage-token-${randomUUID()}`;
  const apiKey = `api-key-${randomUUID()}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');
  const invocationGrantSecret = `grant-secret-${randomUUID()}`;
  const grantSecretBytes = Buffer.from(invocationGrantSecret, 'utf8');
  const encryptionKey = randomBytes(32);
  // Suite-owned unique connector ID to prevent deleting shared connector revisions
  const connectorId = `doc-core-conn-${randomUUID().slice(0, 8)}`;
  const credentialRef = `cred-${connectorId}`;
  const migrationDirectory = path.resolve(__dirname, '../../../services/connector/src/db/migrations');

  let initialExtractProfileRevision = 1;
  let initialConnectorRevision = 1;

  // Track extra suite-created API keys and profile IDs for deterministic scoped SQL teardown
  const trackedApiKeys: string[] = [apiKeyHash];
  const trackedProfileIds: string[] = [];

  // Route-specific provider request counters for observable revision routing
  let providerRev1Calls = 0;
  let providerRev2Calls = 0;

  const invoiceExtractionData = {
    invoiceNumber: 'INV-2026-X01',
    supplier: {
      name: 'Acme Global Corp',
      taxId: 'US-987654321',
    },
    buyer: {
      name: 'Dugate Platforms Inc',
    },
    invoiceDate: '2026-03-20',
    total: 4200,
    subtotal: 4200,
    currency: 'USD',
    lineItems: [
      {
        description: 'Cloud Infrastructure Gateway Service',
        quantity: 1,
        unitPrice: 4200,
        amount: 4200,
      },
    ],
  };

  const invocationUsage = {
    inputTokens: 160,
    outputTokens: 80,
    costMicrousd: 2400,
    measurement: 'measured' as const,
  };

  const customFetch: typeof fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;

    let reqPurpose = '';
    if (init?.body) {
      try {
        const parsed = JSON.parse(typeof init.body === 'string' ? init.body : init.body.toString());
        reqPurpose = parsed.purpose || '';
      } catch {
        // ignore
      }
    }

    // Deterministic failure barrier for interrupted-task recovery test:
    // Intercepts final output artifact upload grant on attempt 1 with a 429 rate limit error,
    // which worker-sdk classifies as retryable (calling runtime.failTask with retryable: true)
    // and triggers Orchestrator to transition the task to RETRY_PENDING after step checkpoints are saved.
    if (
      simulateFailureForOperationId &&
      url.includes('/artifacts') &&
      init?.method === 'POST' &&
      !url.includes('/access') &&
      reqPurpose === 'output' &&
      !failureBarrierTriggered
    ) {
      failureBarrierTriggered = true;
      return new Response(
        JSON.stringify({
          type: 'urn:du:error:rate_limit_exceeded',
          title: 'Rate Limit Exceeded',
          status: 429,
          code: 'RATE_LIMIT_EXCEEDED',
          detail: 'Simulated transient infrastructure 429 barrier on final output',
        }),
        { status: 429, headers: { 'content-type': 'application/json' } }
      );
    }

    // Intercept claim to lock onto the in-flight task ID for version pinning barrier
    if (versionPinningHoldNextDocCore && url.includes('/claim') && init?.method === 'POST') {
      const resp = await fetch(input, init);
      if (resp.ok) {
        const clone = resp.clone();
        try {
          const body = (await clone.json()) as { taskId?: string; executionSnapshot?: { businessId: string } };
          if (body?.taskId && body.executionSnapshot?.businessId === 'document-core') {
            versionPinningHoldTaskId = body.taskId;
            versionPinningHoldNextDocCore = false;
          }
        } catch {
          // ignore
        }
      }
      return resp;
    }

    // Deterministic in-flight version pinning barrier:
    // Pauses Op1 during step execution while state is RUNNING until the test enables version 1.1.0 and submits Op2
    if (
      versionPinningHoldTaskId &&
      versionPinningBarrierPromise &&
      url.includes(`/tasks/${versionPinningHoldTaskId}/steps/`) &&
      init?.method === 'PUT'
    ) {
      if (versionPinningReachedBarrierSignal) {
        versionPinningReachedBarrierSignal();
        versionPinningReachedBarrierSignal = null;
      }
      await versionPinningBarrierPromise;
    }

    // Intercept claim to lock onto the in-flight task ID for connector revision pinning barrier (PRF-02)
    if (connectorPinningHoldNext && url.includes('/claim') && init?.method === 'POST') {
      const resp = await fetch(input, init);
      if (resp.ok) {
        const clone = resp.clone();
        try {
          const body = (await clone.json()) as { taskId?: string; executionSnapshot?: { businessId: string } };
          if (body?.taskId && body.executionSnapshot?.businessId === 'document-core') {
            connectorPinningHoldTaskId = body.taskId;
            connectorPinningHoldNext = false;
          }
        } catch {
          // ignore
        }
      }
      return resp;
    }

    // Deterministic in-flight connector revision pinning barrier:
    // Pauses OpA during step execution while state is RUNNING until new profile revision 2 is appended and OpB submitted
    if (
      connectorPinningHoldTaskId &&
      connectorPinningBarrierPromise &&
      url.includes(`/tasks/${connectorPinningHoldTaskId}/steps/`) &&
      init?.method === 'PUT'
    ) {
      if (connectorPinningReachedBarrierSignal) {
        connectorPinningReachedBarrierSignal();
        connectorPinningReachedBarrierSignal = null;
      }
      await connectorPinningBarrierPromise;
    }

    return fetch(input, init);
  };

  beforeAll(async () => {
    // Strict parsed test environment guards: prevent execution against non-test databases or Redis
    validateTestDatabaseTarget(DATABASE_URL);
    validateTestRedisTarget(REDIS_URL);

    // Prerequisite build check: ensure compiled worker dist artifact exists
    const workerDistPath = path.resolve(__dirname, '../dist/worker.js');
    if (!fs.existsSync(workerDistPath)) {
      throw new Error(
        `Prerequisite build missing: "${workerDistPath}" does not exist. Run "pnpm --filter @du/document-core build:deps" or "pnpm --filter @du/document-core build" before running integration tests.`
      );
    }

    // 1. Controllable provider HTTP mock server (the ONLY simulated boundary)
    providerServer = createServer(async (req, res) => {
      providerCalls += 1;
      const isRev2Route = (req.url ?? '').startsWith('/rev2');
      if (isRev2Route) {
        providerRev2Calls += 1;
      } else {
        providerRev1Calls += 1;
      }

      let body = '';
      for await (const chunk of req) {
        body += chunk;
      }
      if (body) {
        try {
          lastProviderRequest = JSON.parse(body);
        } catch {
          lastProviderRequest = { raw: body };
        }
      }
      const reqText = String((lastProviderRequest as { text?: unknown })?.text || '');
      const isOpA = reqText.includes('OpA') || reqText.includes('Revision 1');
      let responsePayload: unknown = isRev2Route
        ? {
            ...invoiceExtractionData,
            invoiceNumber: 'INV-2026-REV2',
            revisionMarker: 'connector-rev-2',
          }
        : isOpA
        ? {
            ...invoiceExtractionData,
            invoiceNumber: 'INV-2026-REV1',
            revisionMarker: 'connector-rev-1',
          }
        : {
            ...invoiceExtractionData,
            revisionMarker: 'connector-rev-1',
          };
      if (lastProviderRequest && typeof lastProviderRequest === 'object') {
        const prompt = String((lastProviderRequest as { prompt?: unknown })?.prompt || '');
        if (prompt.includes('generate_summary') || prompt.includes('generate') || prompt.includes('summary')) {
          responsePayload = {
            content: 'Executive summary: Acme Global Corp reported $4,200 revenue for Cloud Infrastructure Gateway Service in Q1 2026.',
          };
        } else if (prompt.includes('analyze_classify') || prompt.includes('classify')) {
          responsePayload = {
            category: 'financial',
            confidence: 0.98,
            reasoning: 'Quarterly financial earnings report for Acme Global Corp',
            secondaryCategories: ['business'],
          };
        }
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          data: responsePayload,
          content: JSON.stringify(responsePayload),
          usage: invocationUsage,
          providerRequestId: `mock-provider-${Date.now()}`,
        })
      );
    });

    partiallyCreatedResources.servers.push(providerServer);
    await new Promise<void>((resolve) => providerServer!.listen(0, '127.0.0.1', resolve));
    const provAddress = providerServer.address() as AddressInfo;
    providerPort = provAddress.port;

    // 2. Start live Orchestrator with P2-07 capabilities (artifacts + grants + usage)
    orchestratorApp = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      adminToken,
      runtimeToken,
      usageToken,
      invocationGrantSecret,
      connectorId,
      connectorRevision: 1,
      autoDispatch: true,
      // With autoDispatch on, createApp arms a 5s expired-lease sweeper that sets leased_by=NULL on
      // RUNNING tasks (runtime.ts → sweepExpiredLeases). That races this suite's lease assertions and
      // its manual expiry step, and nothing here drives the sweeper, so recovery stays test-driven.
      leaseRecoveryIntervalMs: 0,
    });
    partiallyCreatedResources.apps.push(orchestratorApp);

    const orchServer = await orchestratorApp.listen();
    const orchAddress = orchServer.address();
    if (!orchAddress || typeof orchAddress === 'string') {
      throw new Error('Orchestrator failed to bind ephemeral port');
    }
    orchestratorUrl = `http://127.0.0.1:${orchAddress.port}`;

    // Seed active API key in PostgreSQL (R08-01 fail-closed auth requirement)
    await orchestratorApp.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'test', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), '00000000-0000-0000-0000-000000000001', apiKeyHash]
    );

    // 3. Register document-core manifest & enable version 1.0.0 via published API
    const regResp = await fetch(
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
    expect([200, 201]).toContain(regResp.status);

    // Published Admin enablement with dedicated adminToken (fail-closed role separation)
    const enableResp = await fetch(
      `${orchestratorUrl}/api/v1/admin/businesses/${documentCoreManifest.businessId}/versions/${documentCoreManifest.version}/enable`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
      }
    );
    expect(enableResp.status).toBe(200);

    // `/enable` only sets status; `is_active` defaults to false (migration 0006) and
    // resolveEnabledVersion selects submissions by `is_active = true`. Without this activate the
    // suite only works when a previous run already left the pointer set, and a freshly migrated
    // database fails every submission with 404 "no active version for business document-core".
    const activateResp = await fetch(
      `${orchestratorUrl}/api/v1/admin/businesses/${documentCoreManifest.businessId}/versions/${documentCoreManifest.version}/activate`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
      }
    );
    expect([200, 202]).toContain(activateResp.status);

    const activeRow = await orchestratorApp.db.query<{ status: string; is_active: boolean }>(
      'SELECT status, is_active FROM business_versions WHERE business_id = $1 AND version = $2',
      [documentCoreManifest.businessId, documentCoreManifest.version]
    );
    expect(activeRow.rows[0]).toEqual({ status: 'ENABLED', is_active: true });

    // 4. Provision connector config repository & active revision in PostgreSQL
    const dbClient = new PgSqlClient({
      connectionString: DATABASE_URL,
      migrationDirectory,
    });
    partiallyCreatedResources.dbClients.push(dbClient);

    try {
      await dbClient.migrate();

      // Clean any prior state for this connectorId to guarantee revision 1
      await dbClient.query('DELETE FROM connector_revisions WHERE connector_id = $1', [connectorId]);
      await dbClient.query('DELETE FROM secret_versions WHERE credential_ref = $1', [credentialRef]);

      const repo = new PostgresConnectorConfigRepository(dbClient);
      const cipher = new AesCredentialCipher(encryptionKey);
      await repo.put(credentialRef, cipher.encrypt('mock-provider-secret'));
      const rev1Created = await repo.createRevision({
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
      initialConnectorRevision = rev1Created.revision;
      expect(initialConnectorRevision).toBeGreaterThanOrEqual(1);
    } finally {
      const idx = partiallyCreatedResources.dbClients.indexOf(dbClient);
      if (idx !== -1) partiallyCreatedResources.dbClients.splice(idx, 1);
      await dbClient.close();
    }

    // 5. Start real Connector composition with durable ledger, quota, outbox dispatcher, and unshimmed signed grant verification
    const grantVerifier: GrantVerifier = new ContractSignedGrantVerifier(
      new HmacSignedGrantSource(grantSecretBytes)
    );

    connectorComposition = createConnectorComposition({
      port: 0,
      host: '127.0.0.1',
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      migrationDirectory,
      serviceIdentityVerifier: {
        verify: async () => ({
          subject: 'document-core-worker',
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
    partiallyCreatedResources.compositions.push(connectorComposition);

    await connectorComposition.start();
    const connAddress = connectorComposition.address();
    if (!connAddress || typeof connAddress === 'string') {
      throw new Error('Connector failed to bind ephemeral port');
    }
    connectorUrl = `http://127.0.0.1:${connAddress.port}`;

    // 5b. Provision suite-owned profile bindings via published Admin HTTP route (POST /api/v1/admin/profile-bindings)
    profileClient = new ProfileBindingFixtureClient({
      orchestratorUrl,
      adminToken,
    });
    const bindResult = await profileClient.bindDocumentCoreActions({
      apiKey,
      connectorId,
      connectorRevision: initialConnectorRevision,
      businessVersion: documentCoreManifest.version,
    });
    suiteProfileId = bindResult.profileId;
    trackedProfileIds.push(suiteProfileId);
    initialExtractProfileRevision = bindResult.revisionsByAction['extract'] ?? 1;

    // 6. Start real document-core worker connected to live Orchestrator and Connector
    workerHandle = await startSuiteWorker(`worker-e2e-${randomUUID()}`);
  }, 35_000);

  async function startSuiteWorker(workerInstanceId: string): Promise<WorkerHandle> {
    const handle = await startDocumentCoreWorker({
      runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
      runtimeToken,
      connectorUrl,
      redis: { url: REDIS_URL },
      workerInstanceId,
      concurrency: 2,
      heartbeatIntervalMs: 2000,
      fetchImpl: customFetch,
    });
    partiallyCreatedResources.workers.push(handle);
    return handle;
  }

  afterEach(async () => {
    // The crash/lease test stops the suite worker on purpose and only replaces it in its final
    // steps. If it fails before that point, every later test submits work nobody claims, turning
    // one failure into a barrier-timeout cascade — so restore the worker unconditionally.
    if (orchestratorApp && !workerHandle) {
      workerHandle = await startSuiteWorker(`worker-restored-${randomUUID()}`);
    }
  });

  afterAll(async () => {
    const cleanupErrors: Error[] = [];

    // 1. Terminate all test-owned child processes tracked by childTracker with awaited exit and PID-scoped fallback
    const childErrors = await childTracker.terminateAll(5000);
    cleanupErrors.push(...childErrors);

    // 2. Stop all worker handles
    for (const w of partiallyCreatedResources.workers) {
      try {
        await w.stop(5000);
      } catch (err) {
        cleanupErrors.push(err as Error);
      }
    }

    // 3. Shutdown connector compositions
    for (const c of partiallyCreatedResources.compositions) {
      try {
        await c.shutdown();
      } catch (err) {
        cleanupErrors.push(err as Error);
      }
    }

    // 4. Close mock Provider HTTP servers (drop keep-alive connections)
    for (const s of partiallyCreatedResources.servers) {
      try {
        s.closeAllConnections?.();
        await new Promise<void>((resolve, reject) => {
          s.close((err) => (err ? reject(err) : resolve()));
        });
      } catch (err) {
        cleanupErrors.push(err as Error);
      }
    }

    // 5. Scoped SQL cleanup: remove all tracked profile bindings and revoke/delete tracked API keys
    if (orchestratorApp) {
      for (const pid of trackedProfileIds) {
        try {
          await orchestratorApp.db.query('DELETE FROM profile_bindings WHERE profile_id = $1', [pid]);
        } catch (err) {
          cleanupErrors.push(err as Error);
        }
      }
      for (const keyHash of trackedApiKeys) {
        try {
          await orchestratorApp.db.query("UPDATE api_keys SET status = 'REVOKED' WHERE hash = $1", [keyHash]);
          await orchestratorApp.db.query(
            'DELETE FROM api_keys WHERE hash = $1 AND id NOT IN (SELECT api_key_id FROM operations WHERE api_key_id IS NOT NULL)',
            [keyHash]
          );
        } catch (err) {
          cleanupErrors.push(err as Error);
        }
      }
      try {
        await orchestratorApp.db.query('DELETE FROM connector_revisions WHERE connector_id = $1', [connectorId]);
        await orchestratorApp.db.query('DELETE FROM secret_versions WHERE credential_ref = $1', [credentialRef]);
      } catch (err) {
        cleanupErrors.push(err as Error);
      }
      try {
        await orchestratorApp.close();
      } catch (err) {
        cleanupErrors.push(err as Error);
      }
    }

    // 6. Close any lingering DB clients
    for (const dbc of partiallyCreatedResources.dbClients) {
      try {
        await dbc.close();
      } catch (err) {
        if (!String(err).includes('more than once')) {
          cleanupErrors.push(err as Error);
        }
      }
    }

    // Fail if any cleanup failed rather than silently swallowing leaks
    if (cleanupErrors.length > 0) {
      const summary = cleanupErrors.map((e) => `[Cleanup Error] ${e.message}`).join('\n');
      console.error(`E2E Cleanup completed with ${cleanupErrors.length} failure(s):\n${summary}`);
      throw new Error(`E2E Cleanup encountered ${cleanupErrors.length} failure(s) during teardown.`);
    }
  }, 35_000);

  async function pollOperationState(operationId: string, timeoutMs = 25_000): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    let state = 'PENDING';
    while (Date.now() < deadline) {
      const pollResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}`, {
        headers: { 'x-api-key': apiKey },
      });
      if (pollResp.ok) {
        const op = (await pollResp.json()) as { state: string };
        state = op.state;
        if (state === 'SUCCEEDED' || state === 'FAILED') break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    return state;
  }

  /**
   * Downloads an artifact over the real runtime HTTP blob route with no fetch rewriting and
   * verifies the received bytes against the integrity columns the platform finalized from the
   * stored bytes. FIX-CR-13 made the blob route serve stored bytes byte-for-byte, so a re-encode
   * on either side must fail here instead of being masked by a decode fallback.
   */
  async function downloadArtifactBytes(
    artifactId: string,
    taskId: string,
    leaseEpoch: number
  ): Promise<Buffer> {
    const accessResp = await fetch(`${orchestratorUrl}/api/runtime/v1/artifacts/${artifactId}/access`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtimeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        taskId,
        leaseEpoch,
        mode: 'read',
      }),
    });
    expect(accessResp.status).toBe(200);
    const accessGrant = (await accessResp.json()) as ArtifactAccessGrant;
    expect(accessGrant.downloadUrl).toBeDefined();

    const blobResp = await fetch(accessGrant.downloadUrl!);
    expect(blobResp.status).toBe(200);
    const bytes = Buffer.from(await blobResp.arrayBuffer());

    const stored = await orchestratorApp!.db.query<{ sha256: string | null; size_bytes: string | null }>(
      'SELECT sha256, size_bytes FROM artifacts WHERE id = $1',
      [artifactId]
    );
    expect(stored.rowCount).toBe(1);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(stored.rows[0]!.sha256);
    expect(bytes.byteLength).toBe(Number(stored.rows[0]!.size_bytes));

    return bytes;
  }

  async function readResultArtifactEnvelope(
    operationId: string,
    resultRef: string
  ): Promise<Record<string, unknown>> {
    const artifactId = resultRef.replace('artifact://', '');
    const taskRows = await orchestratorApp!.db.query<{ id: string; lease_epoch: number }>(
      "SELECT id, lease_epoch FROM tasks WHERE operation_id = $1 AND task_key = 'root' ORDER BY id",
      [operationId]
    );
    expect(taskRows.rowCount).toBeGreaterThan(0);
    const rootTask = taskRows.rows[0]!;

    const bytes = await downloadArtifactBytes(artifactId, rootTask.id, rootTask.lease_epoch);
    return JSON.parse(bytes.toString('utf8')) as Record<string, unknown>;
  }

  /**
   * Mints an invocation grant for a stored connector invocation, for the two cases that call the
   * connector HTTP GET directly instead of going through the worker SDK. Connector requires
   * `x-invocation-grant` on GET/cancel and validates it against the stored request
   * (services/connector/src/services.ts → authorizeInvocation → validateGrant), so a missing grant
   * is a correct 403, not a connector bug. Every binding claim is read back from
   * connector_invocations rather than reconstructed: hand-written claims could pass here while
   * proving nothing about the real tenant/operation/task/step/input binding.
   */
  async function signedInvocationGrant(invocationId: string): Promise<string> {
    const stored = await orchestratorApp!.db.query<{
      request: Pick<
        LocalInvocationRequest,
        'invocationId' | 'tenantId' | 'operationId' | 'taskId' | 'stepKey' | 'bindingSlot'
      >;
      input_hash: string;
    }>(
      'SELECT request, input_hash FROM connector_invocations WHERE invocation_id = $1',
      [invocationId]
    );
    expect(stored.rowCount).toBe(1);
    const record = stored.rows[0]!;
    const request = record.request;

    const issuedAt = Math.floor(Date.now() / 1000);
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const payload = encode({
      audience: 'connector',
      tenantId: request.tenantId,
      operationId: request.operationId,
      taskId: request.taskId,
      stepKey: request.stepKey,
      invocationId: request.invocationId,
      inputHash: record.input_hash,
      connectorId,
      connectorRevision: initialConnectorRevision,
      bindingSlot: request.bindingSlot,
      exp: issuedAt + 300,
      iat: issuedAt,
    });
    const signature = createHmac('sha256', grantSecretBytes)
      .update(`${header}.${payload}`)
      .digest('base64url');
    return `${header}.${payload}.${signature}`;
  }

  test('submits extract/invoice through live Orchestrator, processes via real Connector pipeline and mock provider, asserts ledger, outbox, usage, artifact, and step checkpoints', async () => {
    // 1. Submit extract/invoice operation to Orchestrator public API
    const idempotencyKey = `submit-extract-invoice-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/extract`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          input: {
            type: 'invoice',
            text: 'Invoice INV-2026-X01 from Acme Global Corp Total $4200 for Cloud Infrastructure Gateway Service',
            outputFormat: 'json',
          },
        }),
      }
    );

    expect(submitResp.status).toBe(202);
    const submitBody = (await submitResp.json()) as { operationId: string; state: string };
    const operationId = submitBody.operationId;
    expect(operationId).toBeDefined();

    // 2. Poll Orchestrator until operation reaches SUCCEEDED
    const deadline = Date.now() + 25_000;
    let operationState = submitBody.state;
    while (Date.now() < deadline) {
      const pollResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}`, {
        headers: { 'x-api-key': apiKey },
      });
      if (pollResp.ok) {
        const op = (await pollResp.json()) as { state: string };
        operationState = op.state;
        if (operationState === 'SUCCEEDED' || operationState === 'FAILED') {
          break;
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 250));
    }

    expect(operationState).toBe('SUCCEEDED');

    // 3. Verify mock provider HTTP boundary was actually called by Connector
    expect(providerCalls).toBeGreaterThanOrEqual(1);
    expect(lastProviderRequest).toBeDefined();

    // 4. Verify Connector Invocation Ledger in PostgreSQL
    let primaryInvocation:
      | { invocation_id: string; operation_id: string; step_key: string; state: string }
      | undefined;
    const ledgerDeadline = Date.now() + 5000;
    while (Date.now() < ledgerDeadline) {
      const ledgerRows = await orchestratorApp!.db.query<{
        invocation_id: string;
        operation_id: string;
        step_key: string;
        state: string;
      }>(
        'SELECT invocation_id, operation_id, step_key, state FROM connector_invocations WHERE operation_id = $1',
        [operationId]
      );
      if (ledgerRows.rowCount && ledgerRows.rows[0]?.state === 'SUCCEEDED') {
        primaryInvocation = ledgerRows.rows[0];
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    expect(primaryInvocation).toBeDefined();
    expect(primaryInvocation!.state).toBe('SUCCEEDED');
    expect(primaryInvocation!.step_key).toBe('extract:connector-inference');

    // Record primary IDs for subsequent scoped tests
    primaryOperationId = operationId;
    primaryInvocationId = primaryInvocation!.invocation_id;

    // 5. Verify Connector Usage Outbox in PostgreSQL
    const outboxRows = await orchestratorApp!.db.query<{
      event_id: string;
      invocation_id: string;
      delivered_at: string | null;
    }>(
      'SELECT event_id, invocation_id, delivered_at FROM connector_usage_outbox WHERE invocation_id = $1',
      [primaryInvocation!.invocation_id]
    );
    expect(outboxRows.rowCount).toBeGreaterThanOrEqual(1);

    // 6. Verify Orchestrator Ingested Usage Event in PostgreSQL
    // Allow small window for UsageOutboxDispatcher to deliver to Orchestrator
    let orchUsageCount = 0;
    const usageDeadline = Date.now() + 5000;
    while (Date.now() < usageDeadline) {
      const usageRes = await orchestratorApp!.db.query<{ count: string }>(
        'SELECT count(*) FROM usage_events WHERE operation_id = $1',
        [operationId]
      );
      orchUsageCount = Number(usageRes.rows[0]?.count ?? 0);
      if (orchUsageCount > 0) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
    expect(orchUsageCount).toBeGreaterThanOrEqual(1);

    // 7. Query operation result: verify status, resultRef, and projected usage
    const resultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resultResp.status).toBe(200);
    const resultBody = (await resultResp.json()) as {
      schemaVersion: string;
      data: { resultRef?: string };
      usage: {
        inputTokens: number;
        outputTokens: number;
        costMicrousd: number;
        measurement: string;
      };
    };

    expect(resultBody.schemaVersion).toBe('1');
    expect(resultBody.data.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}$/);

    expect(resultBody.usage).toEqual({
      inputTokens: invocationUsage.inputTokens,
      outputTokens: invocationUsage.outputTokens,
      costMicrousd: invocationUsage.costMicrousd,
      measurement: 'measured',
    });

    // 8. Verify the generated result artifact
    const artifactId = resultBody.data.resultRef!.replace('artifact://', '');
    const taskRows = await orchestratorApp!.db.query<{ id: string; lease_epoch: number }>(
      "SELECT id, lease_epoch FROM tasks WHERE operation_id = $1 AND task_key = 'root' ORDER BY id",
      [operationId]
    );
    expect(taskRows.rowCount).toBeGreaterThan(0);
    const rootTask = taskRows.rows[0]!;

    // Fetch blob bytes through the real HTTP route and parse the ResultEnvelope natively
    const envelopeBytes = await downloadArtifactBytes(artifactId, rootTask.id, rootTask.lease_epoch);
    const envelope = JSON.parse(envelopeBytes.toString('utf8')) as Record<string, unknown>;

    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance).toMatchObject({
      method: 'llm_extraction',
      modelSlot: 'reasoning',
    });
    expect(envelope.data).toMatchObject({
      invoiceNumber: 'INV-2026-X01',
      total: 4200,
      currency: 'USD',
      supplier: {
        name: 'Acme Global Corp',
      },
    });

    // 9. Verify durable step checkpoints were recorded in database
    const checkpoints = await orchestratorApp!.db.query<{
      step_key: string;
      generation: number;
      status: string;
    }>(
      'SELECT step_key, generation, status FROM step_checkpoints WHERE task_id = $1 ORDER BY step_key ASC',
      [rootTask.id]
    );

    const stepKeys = checkpoints.rows.map((r: { step_key: string }) => r.step_key);
    expect(stepKeys).toContain('extract:build-prompt');
    expect(stepKeys).toContain('extract:connector-inference');
    expect(stepKeys).toContain('extract:validate-schema');

    for (const checkpoint of checkpoints.rows) {
      expect(checkpoint.status).toBe('SUCCEEDED');
      expect(checkpoint.generation).toBeGreaterThanOrEqual(1);
    }
  }, 40_000);

  test('verifies Connector invocation query: GET /invocations/:id returns existing invocation state without duplicate provider execution (idempotent query)', async () => {
    const callsBefore = providerCalls;

    // Scoped query for primaryInvocationId created by test 1
    expect(primaryInvocationId).toBeTruthy();
    // Fail-closed proof first: a direct GET without a grant is denied 403 (services.ts
    // authorizeInvocation → BINDING_DENIED). Asserting this keeps the 200 below meaningful — it then
    // demonstrates the signed grant authorizes the read, not that the endpoint is open.
    const ungrantedResp = await fetch(`${connectorUrl}/invocations/${primaryInvocationId}`);
    expect(ungrantedResp.status).toBe(403);

    const invResp = await fetch(`${connectorUrl}/invocations/${primaryInvocationId}`, {
      headers: { 'x-invocation-grant': await signedInvocationGrant(primaryInvocationId) },
    });
    expect(invResp.status).toBe(200);
    const invBody = (await invResp.json()) as InvocationResponse;
    expect(invBody.invocationId).toBe(primaryInvocationId);
    expect(invBody.state).toBe('SUCCEEDED');
    expect(invBody.result?.data).toMatchObject({ invoiceNumber: 'INV-2026-X01' });

    // Assert zero additional provider calls on idempotent GET lookup
    expect(providerCalls).toBe(callsBefore);
  });

  test('verifies secondary idle worker startup preserves existing durable checkpoints without issuing duplicate provider calls', async () => {
    const callsBefore = providerCalls;

    // Start a secondary worker instance representing process restart/recovery
    const restartedWorker = await startDocumentCoreWorker({
      runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
      runtimeToken,
      connectorUrl,
      redis: { url: REDIS_URL },
      workerInstanceId: `worker-idle-${randomUUID()}`,
      concurrency: 1,
      heartbeatIntervalMs: 2000,
      fetchImpl: customFetch,
    });
    partiallyCreatedResources.workers.push(restartedWorker);

    try {
      // Query completed invocation strictly scoped to primaryOperationId
      const ledgerRows = await orchestratorApp!.db.query<{ invocation_id: string }>(
        'SELECT invocation_id FROM connector_invocations WHERE operation_id = $1 AND state = $2',
        [primaryOperationId, 'SUCCEEDED']
      );
      expect(ledgerRows.rowCount).toBeGreaterThan(0);
      const invocationId = ledgerRows.rows[0]!.invocation_id;

      // Same gate as the other direct GET: denied without a grant, 200 with the bound grant.
      const ungrantedPoll = await fetch(`${connectorUrl}/invocations/${invocationId}`);
      expect(ungrantedPoll.status).toBe(403);

      const pollResp = await fetch(`${connectorUrl}/invocations/${invocationId}`, {
        headers: { 'x-invocation-grant': await signedInvocationGrant(invocationId) },
      });
      expect(pollResp.status).toBe(200);
      const pollBody = (await pollResp.json()) as InvocationResponse;
      expect(pollBody.state).toBe('SUCCEEDED');

      // Provider calls must not have incremented during secondary worker startup
      expect(providerCalls).toBe(callsBefore);
    } finally {
      const idx = partiallyCreatedResources.workers.indexOf(restartedWorker);
      if (idx !== -1) partiallyCreatedResources.workers.splice(idx, 1);
      await restartedWorker.stop(2000);
    }
  });

  test('verifies cooperative retry and checkpoint replay: simulated 429 rate limit barrier triggers RETRY_PENDING, redelivered task reuses completed checkpoints with zero duplicate provider calls (not process crash)', async () => {
    // Note: This test verifies cooperative retry handling via runtime.failTask({ retryable: true }).
    // It tests checkpoint replay across retry attempts, NOT process termination/crash.
    const callsBeforeTest = providerCalls;
    const idempotencyKey = `submit-interrupted-recovery-${randomUUID()}`;

    // Enable failure barrier for this test in customFetch
    simulateFailureForOperationId = idempotencyKey;
    failureBarrierTriggered = false;

    // 1. Submit extract/invoice
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/extract`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          input: {
            type: 'invoice',
            text: 'Invoice INV-RECOVERY-001 from Acme Recovery Corp Total $1500 for Emergency Repair',
            outputFormat: 'json',
          },
        }),
      }
    );
    expect(submitResp.status).toBe(202);
    const { operationId } = (await submitResp.json()) as { operationId: string };
    expect(operationId).toBeDefined();

    // 2. Wait until attempt 1 hits failure barrier and enters RETRY_PENDING
    const retryDeadline = Date.now() + 15_000;
    let reachedRetryPending = false;
    let rootTaskId = '';
    while (Date.now() < retryDeadline) {
      const taskRes = await orchestratorApp!.db.query<{ id: string; state: string; attempt: number }>(
        "SELECT id, state, attempt FROM tasks WHERE operation_id = $1 AND task_key = 'root' ORDER BY id",
        [operationId]
      );
      if (taskRes.rowCount && taskRes.rows[0]?.state === 'RETRY_PENDING') {
        reachedRetryPending = true;
        rootTaskId = taskRes.rows[0].id;
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 150));
    }

    expect(reachedRetryPending).toBe(true);
    expect(failureBarrierTriggered).toBe(true);

    // 3. Verify attempt 1 execution evidence:
    // - Checkpoints were saved in PostgreSQL for extract:build-prompt and extract:connector-inference
    const initialCheckpoints = await orchestratorApp!.db.query<{ step_key: string; generation: number; status: string }>(
      'SELECT step_key, generation, status FROM step_checkpoints WHERE task_id = $1 ORDER BY step_key ASC',
      [rootTaskId]
    );
    const initialStepKeys = initialCheckpoints.rows.map((r) => r.step_key);
    expect(initialStepKeys).toContain('extract:build-prompt');
    expect(initialStepKeys).toContain('extract:connector-inference');

    // - Provider was called exactly ONCE during attempt 1
    const providerCallsAfterAttempt1 = providerCalls;
    expect(providerCallsAfterAttempt1).toBe(callsBeforeTest + 1);

    // 4. Trigger redelivery: accelerate outbox row and trigger dispatcher
    await orchestratorApp!.db.query(
      'UPDATE outbox SET due_at = now() WHERE aggregate_id = $1',
      [rootTaskId]
    );
    await orchestratorApp!.dispatcher.dispatchOnce();

    // 5. Poll operation until SUCCEEDED on attempt 2
    let finalState = 'RETRY_PENDING';
    const finalDeadline = Date.now() + 20_000;
    while (Date.now() < finalDeadline) {
      const pollResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}`, {
        headers: { 'x-api-key': apiKey },
      });
      if (pollResp.ok) {
        const op = (await pollResp.json()) as { state: string };
        finalState = op.state;
        if (finalState === 'SUCCEEDED' || finalState === 'FAILED') break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    expect(finalState).toBe('SUCCEEDED');

    // 6. Verify task was reclaimed on attempt 2
    const finalTaskRes = await orchestratorApp!.db.query<{ attempt: number; lease_epoch: number }>(
      'SELECT attempt, lease_epoch FROM tasks WHERE id = $1',
      [rootTaskId]
    );
    expect(finalTaskRes.rows[0]?.attempt).toBeGreaterThanOrEqual(2);
    expect(finalTaskRes.rows[0]?.lease_epoch).toBeGreaterThanOrEqual(2);

    // 7. Critical assertion: Provider calls did NOT increment during redelivery/replay
    expect(providerCalls).toBe(providerCallsAfterAttempt1);

    // 8. Result artifact is complete and valid
    const resultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resultResp.status).toBe(200);
    const resultBody = (await resultResp.json()) as { data: { resultRef?: string } };
    expect(resultBody.data.resultRef).toMatch(/^artifact:\/\//);

    const envelope = await readResultArtifactEnvelope(operationId, resultBody.data.resultRef!);
    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.data).toMatchObject({ invoiceNumber: 'INV-2026-X01' });

    // Clean up failure barrier flag
    simulateFailureForOperationId = null;
  }, 40_000);

  test('submits analyze/classify through live Orchestrator and exercises the live Connector reasoning pipeline', async () => {
    const idempotencyKey = `submit-analyze-classify-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/analyze`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          input: {
            task: 'classify',
            text: 'Quarterly financial earnings report for Acme Global Corp Q1 2026',
            categories: ['financial', 'legal', 'technical'],
          },
        }),
      }
    );

    expect(submitResp.status).toBe(202);
    const submitBody = (await submitResp.json()) as { operationId: string; state: string };
    const operationId = submitBody.operationId;
    expect(operationId).toBeDefined();

    // Poll until SUCCEEDED
    const operationState = await pollOperationState(operationId);
    expect(operationState).toBe('SUCCEEDED');

    // Query result & usage
    const resultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resultResp.status).toBe(200);
    const resultBody = (await resultResp.json()) as {
      data: { resultRef?: string };
      usage: { inputTokens: number; costMicrousd: number };
    };
    expect(resultBody.data.resultRef).toMatch(/^artifact:\/\//);
    expect(resultBody.usage.costMicrousd).toBe(invocationUsage.costMicrousd);

    // Semantic artifact assertion
    const envelope = await readResultArtifactEnvelope(operationId, resultBody.data.resultRef!);
    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance).toMatchObject({
      method: 'llm_evaluation',
      modelSlot: 'reasoning',
    });
    expect(envelope.data).toMatchObject({
      category: 'financial',
      confidence: 0.98,
      reasoning: 'Quarterly financial earnings report for Acme Global Corp',
    });

    // Scoped ledger query for this operationId
    const ledgerRes = await orchestratorApp!.db.query<{ invocation_id: string }>(
      'SELECT invocation_id FROM connector_invocations WHERE operation_id = $1',
      [operationId]
    );
    expect(ledgerRes.rowCount).toBeGreaterThanOrEqual(1);
  }, 35_000);

  test('submits generate/summary through live Orchestrator and exercises the live Connector reasoning pipeline', async () => {
    const idempotencyKey = `submit-generate-summary-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/generate`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          input: {
            task: 'summary',
            text: 'Acme Global Corp announced financial revenue of $4200 for Q1 2026.',
            format: 'paragraph',
            maxWords: 50,
          },
        }),
      }
    );

    expect(submitResp.status).toBe(202);
    const submitBody = (await submitResp.json()) as { operationId: string; state: string };
    const operationId = submitBody.operationId;
    expect(operationId).toBeDefined();

    const operationState = await pollOperationState(operationId);
    expect(operationState).toBe('SUCCEEDED');

    const resultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resultResp.status).toBe(200);
    const resultBody = (await resultResp.json()) as {
      data: { resultRef?: string };
      usage: { inputTokens: number; costMicrousd: number };
    };
    expect(resultBody.data.resultRef).toMatch(/^artifact:\/\//);
    expect(resultBody.usage.costMicrousd).toBe(invocationUsage.costMicrousd);

    // Semantic artifact assertion
    const envelope = await readResultArtifactEnvelope(operationId, resultBody.data.resultRef!);
    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance).toMatchObject({
      method: 'llm_evaluation',
      modelSlot: 'reasoning',
    });
    const summaryData = envelope.data as { content?: string };
    expect(summaryData.content).toContain('Executive summary: Acme Global Corp reported $4,200 revenue');

    // Scoped ledger query for this operationId
    const ledgerRes = await orchestratorApp!.db.query<{ invocation_id: string }>(
      'SELECT invocation_id FROM connector_invocations WHERE operation_id = $1',
      [operationId]
    );
    expect(ledgerRes.rowCount).toBeGreaterThanOrEqual(1);
  }, 35_000);

  test('submits ingest/parse through live Orchestrator and verifies native parsing and artifact creation (zero provider calls)', async () => {
    const callsBefore = providerCalls;
    const idempotencyKey = `submit-ingest-parse-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/ingest`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          input: {
            mode: 'parse',
            text: 'Enterprise document plain text ingestion payload.',
            outputFormat: 'json',
          },
        }),
      }
    );

    expect(submitResp.status).toBe(202);
    const submitBody = (await submitResp.json()) as { operationId: string; state: string };
    const operationId = submitBody.operationId;
    expect(operationId).toBeDefined();

    const operationState = await pollOperationState(operationId);
    expect(operationState).toBe('SUCCEEDED');

    const resultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resultResp.status).toBe(200);
    const resultBody = (await resultResp.json()) as { data: { resultRef?: string } };
    expect(resultBody.data.resultRef).toMatch(/^artifact:\/\//);

    // Semantic artifact assertion
    const envelope = await readResultArtifactEnvelope(operationId, resultBody.data.resultRef!);
    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance).toMatchObject({ method: 'native_parse' });
    expect(envelope.data).toMatchObject({
      text: 'Enterprise document plain text ingestion payload.',
      metadata: {
        parser: 'inline-text',
        detectedFormat: 'txt',
      },
    });

    // Scoped negative assertions: native parsing does not call provider or connector
    const ledgerRes = await orchestratorApp!.db.query<{ count: string }>(
      'SELECT count(*) FROM connector_invocations WHERE operation_id = $1',
      [operationId]
    );
    expect(Number(ledgerRes.rows[0]?.count ?? 0)).toBe(0);

    const usageRes = await orchestratorApp!.db.query<{ count: string }>(
      'SELECT count(*) FROM usage_events WHERE operation_id = $1',
      [operationId]
    );
    expect(Number(usageRes.rows[0]?.count ?? 0)).toBe(0);

    expect(providerCalls).toBe(callsBefore);
  }, 35_000);

  test('submits transform/redact through live Orchestrator and verifies native redaction and artifact creation (zero provider calls)', async () => {
    const callsBefore = providerCalls;
    const idempotencyKey = `submit-transform-redact-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/transform`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          input: {
            variant: 'redact',
            text: 'Direct contact is user@example.com or telephone 555-0199.',
            redactPatterns: ['email', 'phone'],
            outputFormat: 'json',
          },
        }),
      }
    );

    expect(submitResp.status).toBe(202);
    const submitBody = (await submitResp.json()) as { operationId: string; state: string };
    const operationId = submitBody.operationId;
    expect(operationId).toBeDefined();

    const operationState = await pollOperationState(operationId);
    expect(operationState).toBe('SUCCEEDED');

    const resultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resultResp.status).toBe(200);
    const resultBody = (await resultResp.json()) as { data: { resultRef?: string } };
    expect(resultBody.data.resultRef).toMatch(/^artifact:\/\//);

    // Semantic artifact assertion: verify actual absence of original PII and presence of redactions
    const envelope = await readResultArtifactEnvelope(operationId, resultBody.data.resultRef!);
    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance).toMatchObject({ method: 'native_parse' });

    const transformData = envelope.data as {
      transformedText: string;
      metadata: { redactionsCount: number; countsByPattern: Record<string, number> };
    };
    expect(transformData.transformedText).not.toContain('user@example.com');
    expect(transformData.transformedText).not.toContain('555-0199');
    expect(transformData.transformedText).toContain('[REDACTED:EMAIL]');
    expect(transformData.transformedText).toContain('[REDACTED:PHONE]');
    expect(transformData.metadata.redactionsCount).toBe(2);

    // Scoped negative assertions
    const ledgerRes = await orchestratorApp!.db.query<{ count: string }>(
      'SELECT count(*) FROM connector_invocations WHERE operation_id = $1',
      [operationId]
    );
    expect(Number(ledgerRes.rows[0]?.count ?? 0)).toBe(0);

    const usageRes = await orchestratorApp!.db.query<{ count: string }>(
      'SELECT count(*) FROM usage_events WHERE operation_id = $1',
      [operationId]
    );
    expect(Number(usageRes.rows[0]?.count ?? 0)).toBe(0);

    expect(providerCalls).toBe(callsBefore);
  }, 35_000);

  test('submits compare/diff through live Orchestrator and verifies native diffing and artifact creation (zero provider calls)', async () => {
    const callsBefore = providerCalls;
    const idempotencyKey = `submit-compare-diff-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/compare`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          input: {
            mode: 'diff',
            source: { text: 'Initial baseline document revision 1.' },
            target: { text: 'Updated production document revision 2.' },
            outputFormat: 'json',
          },
        }),
      }
    );

    expect(submitResp.status).toBe(202);
    const submitBody = (await submitResp.json()) as { operationId: string; state: string };
    const operationId = submitBody.operationId;
    expect(operationId).toBeDefined();

    const operationState = await pollOperationState(operationId);
    expect(operationState).toBe('SUCCEEDED');

    const resultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resultResp.status).toBe(200);
    const resultBody = (await resultResp.json()) as { data: { resultRef?: string } };
    expect(resultBody.data.resultRef).toMatch(/^artifact:\/\//);

    // Semantic artifact assertion: verify actual diff statistics and unified diff hunk text
    const envelope = await readResultArtifactEnvelope(operationId, resultBody.data.resultRef!);
    expect(envelope.status).toBe('COMPLETED');
    expect(envelope.provenance).toMatchObject({ method: 'diff' });

    const compareData = envelope.data as {
      diffStats: { additions: number; deletions: number; unmodified: number };
      unifiedDiff: string;
    };
    expect(compareData.diffStats.additions).toBeGreaterThan(0);
    expect(compareData.diffStats.deletions).toBeGreaterThan(0);
    expect(compareData.unifiedDiff).toContain('+ Updated production document revision 2.');
    expect(compareData.unifiedDiff).toContain('- Initial baseline document revision 1.');

    // Scoped negative assertions
    const ledgerRes = await orchestratorApp!.db.query<{ count: string }>(
      'SELECT count(*) FROM connector_invocations WHERE operation_id = $1',
      [operationId]
    );
    expect(Number(ledgerRes.rows[0]?.count ?? 0)).toBe(0);

    const usageRes = await orchestratorApp!.db.query<{ count: string }>(
      'SELECT count(*) FROM usage_events WHERE operation_id = $1',
      [operationId]
    );
    expect(Number(usageRes.rows[0]?.count ?? 0)).toBe(0);

    expect(providerCalls).toBe(callsBefore);
  }, 35_000);

  test('verifies business version pinning: in-flight operations remain pinned to version 1.0.0 while new submissions resolve to newly enabled version 1.1.0', async () => {
    const manifestV2 = {
      ...documentCoreManifest,
      version: '1.1.0',
    };

    let workerV2: WorkerHandle | undefined;
    let v2Registered = false;
    let v2Activated = false;

    try {
      // The in-flight barrier depends on customFetch seeing this worker's claim and step PUT calls.
      expect(workerHandle).toBeDefined();

      // 1. Arm barrier to hold Op1 in-flight during step execution while in RUNNING state
      versionPinningHoldNextDocCore = true;
      versionPinningHoldTaskId = null;
      versionPinningReachedBarrierPromise = new Promise<void>((resolve) => {
        versionPinningReachedBarrierSignal = resolve;
      });
      versionPinningBarrierPromise = new Promise<void>((resolve) => {
        versionPinningBarrierRelease = resolve;
      });

      // 2. Submit operation Op1 while version 1.0.0 is enabled
      const idempotencyKeyV1 = `submit-version-pin-v1-${randomUUID()}`;
      const submitV1Resp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/extract`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'idempotency-key': idempotencyKeyV1,
          },
          body: JSON.stringify({
            input: {
              type: 'invoice',
              text: 'Invoice INV-PIN-001 from Baseline Corp Total $1000',
              outputFormat: 'json',
            },
          }),
        }
      );
      expect(submitV1Resp.status).toBe(202);
      const { operationId: op1Id } = (await submitV1Resp.json()) as { operationId: string };

      // 3. Wait until Op1 is actively claimed and paused at the step checkpoint barrier in RUNNING state
      await versionPinningReachedBarrierPromise;
      expect(versionPinningHoldTaskId).toBeTruthy();

      // Verify Op1 task is actively RUNNING
      const op1TaskRunning = await orchestratorApp!.db.query<{ state: string }>(
        'SELECT state FROM tasks WHERE id = $1',
        [versionPinningHoldTaskId]
      );
      expect(op1TaskRunning.rows[0]?.state).toBe('RUNNING');

      // Verify Op1 operation is actively RUNNING and pinned to businessVersion 1.0.0 in DB and API
      const op1OpRunning = await orchestratorApp!.db.query<{ state: string; business_version: string }>(
        'SELECT state, business_version FROM operations WHERE id = $1',
        [op1Id]
      );
      expect(op1OpRunning.rows[0]?.state).toBe('RUNNING');
      expect(op1OpRunning.rows[0]?.business_version).toBe('1.0.0');

      // 4. While Op1 is actively RUNNING and held at the barrier, register version 1.1.0 via runtime API
      const regV2Resp = await fetch(
        `${orchestratorUrl}/api/runtime/v1/businesses/${manifestV2.businessId}/versions/${manifestV2.version}`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${runtimeToken}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify(manifestV2),
        }
      );
      expect([200, 201]).toContain(regV2Resp.status);
      v2Registered = true;

      // 5. Enable version 1.1.0 via admin API (published enable endpoint)
      const enableV2Resp = await fetch(
        `${orchestratorUrl}/api/v1/admin/businesses/${manifestV2.businessId}/versions/${manifestV2.version}/enable`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${adminToken}`,
            'content-type': 'application/json',
          },
        }
      );
      expect(enableV2Resp.status).toBe(200);

      // `/enable` only flips status; new submissions resolve the version through the separate
      // active pointer (modules/operations/submission.ts → WHERE is_active=true). Pinning a
      // submission to v2 therefore requires `/activate`, and asserting this split here keeps the
      // test from silently passing again if enable ever starts implying activate.
      const afterEnable = await orchestratorApp!.db.query<{ version: string; status: string; is_active: boolean }>(
        'SELECT version, status, is_active FROM business_versions WHERE business_id = $1 AND version = $2',
        [manifestV2.businessId, manifestV2.version]
      );
      expect(afterEnable.rows[0]).toEqual({ version: '1.1.0', status: 'ENABLED', is_active: false });

      const activateV2Resp = await fetch(
        `${orchestratorUrl}/api/v1/admin/businesses/${manifestV2.businessId}/versions/${manifestV2.version}/activate`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${adminToken}`,
            'content-type': 'application/json',
          },
        }
      );
      expect([200, 202]).toContain(activateV2Resp.status);
      v2Activated = true;

      const afterActivate = await orchestratorApp!.db.query<{ is_active: boolean }>(
        'SELECT is_active FROM business_versions WHERE business_id = $1 AND version = $2',
        [manifestV2.businessId, manifestV2.version]
      );
      expect(afterActivate.rows[0]?.is_active).toBe(true);

      // 5b. Explicitly bind action 'extract' for businessVersion 1.1.0 using suite-owned profile (PRF-01 / W20)
      await profileClient!.createRevision({
        profileId: suiteProfileId,
        apiKey,
        businessId: manifestV2.businessId,
        businessVersion: manifestV2.version,
        action: 'extract',
        connectorBindings: {
          reasoning: { connectorId, revision: initialConnectorRevision },
        },
      });

      // 6. Submit a new operation Op2 under newly enabled version
      const idempotencyKeyV2 = `submit-version-pin-v2-${randomUUID()}`;
      const submitV2Resp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/${manifestV2.businessId}/actions/extract`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'idempotency-key': idempotencyKeyV2,
          },
          body: JSON.stringify({
            input: {
              type: 'invoice',
              text: 'Invoice INV-PIN-002 from Upgraded Corp Total $2000',
              outputFormat: 'json',
            },
          }),
        }
      );
      expect(submitV2Resp.status).toBe(202);
      const { operationId: op2Id } = (await submitV2Resp.json()) as { operationId: string };

      // 7. Verify Op2 is pinned to newly selected businessVersion 1.1.0
      const op2Resp = await fetch(`${orchestratorUrl}/api/v1/operations/${op2Id}`, {
        headers: { 'x-api-key': apiKey },
      });
      const op2Body = (await op2Resp.json()) as { businessVersion: string };
      expect(op2Body.businessVersion).toBe('1.1.0');

      // 8. Crucial in-flight pinning assertion: verify Op1 REMAINS pinned to 1.0.0 while still RUNNING
      const op1After = await fetch(`${orchestratorUrl}/api/v1/operations/${op1Id}`, {
        headers: { 'x-api-key': apiKey },
      });
      const op1AfterBody = (await op1After.json()) as { businessVersion: string; state: string };
      expect(op1AfterBody.businessVersion).toBe('1.0.0');
      expect(op1AfterBody.state).toBe('RUNNING');

      // Verify in PostgreSQL table directly
      const dbOp1 = await orchestratorApp!.db.query<{ business_version: string; state: string }>(
        'SELECT business_version, state FROM operations WHERE id = $1',
        [op1Id]
      );
      expect(dbOp1.rows[0]?.business_version).toBe('1.0.0');
      expect(dbOp1.rows[0]?.state).toBe('RUNNING');

      const dbOp2 = await orchestratorApp!.db.query<{ business_version: string }>(
        'SELECT business_version FROM operations WHERE id = $1',
        [op2Id]
      );
      expect(dbOp2.rows[0]?.business_version).toBe('1.1.0');

      // 9. Release barrier on Op1 so it can complete execution
      if (versionPinningBarrierRelease) {
        versionPinningBarrierRelease();
        versionPinningBarrierRelease = null;
      }

      // 10. Start worker for version 1.1.0 to process and complete Op2
      const v2Definition = defineBusiness(manifestV2, documentCoreHandlers as Record<string, TaskHandler>);
      workerV2 = await startWorker(v2Definition, {
        runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
        runtimeToken,
        connectorUrl,
        redis: { url: REDIS_URL },
        workerInstanceId: `worker-v2-${randomUUID()}`,
        concurrency: 1,
        heartbeatIntervalMs: 2000,
        fetchImpl: customFetch,
      });
      partiallyCreatedResources.workers.push(workerV2);

      const op1State = await pollOperationState(op1Id);
      expect(op1State).toBe('SUCCEEDED');

      const op2State = await pollOperationState(op2Id);
      expect(op2State).toBe('SUCCEEDED');

      // Verify result envelopes carry completed outcomes
      const op1ResultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${op1Id}/result`, {
        headers: { 'x-api-key': apiKey },
      });
      const op1ResultBody = (await op1ResultResp.json()) as { data: { resultRef?: string } };
      const op1Envelope = await readResultArtifactEnvelope(op1Id, op1ResultBody.data.resultRef!);
      expect(op1Envelope.status).toBe('COMPLETED');

      const op2ResultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${op2Id}/result`, {
        headers: { 'x-api-key': apiKey },
      });
      const op2ResultBody = (await op2ResultResp.json()) as { data: { resultRef?: string } };
      const op2Envelope = await readResultArtifactEnvelope(op2Id, op2ResultBody.data.resultRef!);
      expect(op2Envelope.status).toBe('COMPLETED');
    } finally {
      // Release barrier if still held
      if (versionPinningBarrierRelease) {
        versionPinningBarrierRelease();
        versionPinningBarrierRelease = null;
      }

      if (workerV2) {
        const workerToStop = workerV2;
        workerV2 = undefined;
        try {
          await workerToStop.stop(2000);
        } finally {
          const idx = partiallyCreatedResources.workers.indexOf(workerToStop);
          if (idx !== -1) partiallyCreatedResources.workers.splice(idx, 1);
        }
      }

      // Reset barrier controls
      versionPinningHoldNextDocCore = false;
      versionPinningHoldTaskId = null;
      versionPinningBarrierPromise = null;
      versionPinningBarrierRelease = null;
      versionPinningReachedBarrierPromise = null;
      versionPinningReachedBarrierSignal = null;

      // Scoped cleanup: restore the suite's active pointer, then drop the registered 1.1.0 row.
      // Order matters: activateVersion clears the previous pointer, so deleting the active 1.1.0
      // row first would leave document-core with no active version, and every later submission in
      // this file would then fail closed with 404.
      if (v2Activated) {
        const reactivateV1Resp = await fetch(
          `${orchestratorUrl}/api/v1/admin/businesses/${documentCoreManifest.businessId}/versions/${documentCoreManifest.version}/activate`,
          {
            method: 'PUT',
            headers: {
              authorization: `Bearer ${adminToken}`,
              'content-type': 'application/json',
            },
          }
        );
        expect([200, 202]).toContain(reactivateV1Resp.status);
      }

      // Scoped cleanup: delete registered 1.1.0 row and assert deletion (fail without swallowing)
      if (v2Registered) {
        const delRes = await orchestratorApp!.db.query(
          'DELETE FROM business_versions WHERE business_id = $1 AND version = $2',
          [manifestV2.businessId, manifestV2.version]
        );
        expect(delRes.rowCount).toBe(1);
      }
    }
  }, 40_000);

  test('verifies worker process crash and lease recovery: abrupt SIGKILL of test-owned child worker leaves task RUNNING with unreleased lease, replacement worker claims expired lease and completes execution with zero duplicate provider calls', async () => {
    const callsBeforeTest = providerCalls;
    const idempotencyKey = `submit-crash-recovery-${randomUUID()}`;
    const childWorkerInstanceId = `child-worker-crash-${randomUUID().slice(0, 8)}`;

    // 1. Temporarily stop the in-process workerHandle so only the child worker can claim this task
    if (workerHandle) {
      const activeWorker = workerHandle;
      workerHandle = undefined;
      try {
        await activeWorker.stop(2000);
      } finally {
        const idx = partiallyCreatedResources.workers.indexOf(activeWorker);
        if (idx !== -1) partiallyCreatedResources.workers.splice(idx, 1);
      }
    }

    // 2. Spawn dedicated test-owned child worker process configured with HOLD_STEP barrier
    const childWorker = childTracker.spawn(path.resolve(__dirname, 'helpers/child-worker-runner.cjs'), [], {
      env: {
        ...process.env,
        RUNTIME_URL: `${orchestratorUrl}/api/runtime/v1`,
        RUNTIME_TOKEN: runtimeToken,
        REDIS_URL: REDIS_URL,
        CONNECTOR_URL: connectorUrl,
        WORKER_INSTANCE_ID: childWorkerInstanceId,
        HOLD_STEP: 'extract:connector-inference',
      },
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    // Wait for child worker ready signal with prompt rejection on early exit/error
    await childTracker.waitForMessage(childWorker, 'ready', 10_000);

    // Promise that resolves when child worker hits the HOLD_STEP barrier after saving inference checkpoint
    const stepHeldPromise = childTracker.waitForMessage(childWorker, 'step_held', 20_000);

    // 3. Submit extract action
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/${documentCoreManifest.businessId}/actions/extract`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
          'idempotency-key': idempotencyKey,
        },
        body: JSON.stringify({
          input: {
            type: 'invoice',
            text: 'Invoice INV-CRASH-001 from Crashed Corp Total $9999 for Crash Safety Audit',
            outputFormat: 'json',
          },
        }),
      }
    );
    expect(submitResp.status).toBe(202);
    const { operationId } = (await submitResp.json()) as { operationId: string };
    expect(operationId).toBeDefined();

    // 4. Wait for child worker to execute inference and hold execution at the checkpoint barrier
    await stepHeldPromise;

    // Verify durable checkpoint in PostgreSQL directly.
    // The root task is selected by task_key, not by an unordered single-row read: an operation can
    // own several task rows (runtime.ts inserts fan-out children with parent_id), so `LIMIT 1`
    // without ORDER BY can hand back a task this child never claimed and make a healthy lease look
    // like a null-leased production bug.
    const opTaskRows = await orchestratorApp!.db.query<{
      id: string;
      task_key: string;
      parent_id: string | null;
      state: string;
      leased_by: string | null;
      lease_epoch: number;
      attempt: number;
    }>(
      'SELECT id, task_key, parent_id, state, leased_by, lease_epoch, attempt FROM tasks WHERE operation_id = $1 ORDER BY task_key, id',
      [operationId]
    );
    const taskInventory = opTaskRows.rows
      .map(
        (r) =>
          `${r.task_key}(parent=${r.parent_id ?? 'none'}) id=${r.id} state=${r.state} ` +
          `leased_by=${r.leased_by} epoch=${r.lease_epoch} attempt=${r.attempt}`
      )
      .join(' | ');
    const rootTaskRows = opTaskRows.rows.filter((r) => r.task_key === 'root');
    expect(rootTaskRows).toHaveLength(1);
    const rootTask = rootTaskRows[0]!;
    if (rootTask.leased_by !== childWorkerInstanceId) {
      console.error(
        `[crash-recovery] expected root task leased by "${childWorkerInstanceId}" for operation ${operationId}; all task rows: ${taskInventory}`
      );
    }
    expect(rootTask.leased_by).toBe(childWorkerInstanceId);
    expect(rootTask.state).toBe('RUNNING');
    expect(rootTask.attempt).toBe(1);
    expect(rootTask.lease_epoch).toBe(1);

    const cpRows = await orchestratorApp!.db.query<{ step_key: string; status: string }>(
      'SELECT step_key, status FROM step_checkpoints WHERE task_id = $1 AND step_key = $2',
      [rootTask.id, 'extract:connector-inference']
    );
    expect(cpRows.rowCount).toBe(1);
    expect(cpRows.rows[0]?.status).toBe('SUCCEEDED');

    // Exactly 1 provider call made so far
    expect(providerCalls).toBe(callsBeforeTest + 1);

    // 5. Abruptly kill the child worker process (SIGKILL / TerminateProcess) and await termination
    await childTracker.terminate(childWorker, 5000);

    // 6. Assert ungraceful crash evidence:
    // - Child process is dead and tracker is safely empty
    expect(childWorker.killed).toBe(true);
    expect(childTracker.trackedCount).toBe(0);
    // - NO failTask was called: task state remains 'RUNNING' in PostgreSQL, lease is NOT cleared
    const crashedTaskRows = await orchestratorApp!.db.query<{ state: string; leased_by: string; error_code: string | null; attempt: number }>(
      'SELECT state, leased_by, error_code, attempt FROM tasks WHERE id = $1',
      [rootTask.id]
    );
    expect(crashedTaskRows.rows[0]?.state).toBe('RUNNING');
    expect(crashedTaskRows.rows[0]?.leased_by).toBe(childWorkerInstanceId);
    expect(crashedTaskRows.rows[0]?.error_code).toBeNull();
    expect(crashedTaskRows.rows[0]?.attempt).toBe(1);

    // 7. Expire lease in DB and re-enqueue outbox delivery (the test drives recovery itself;
    // beforeAll sets leaseRecoveryIntervalMs: 0 so no background sweeper competes with this step).
    await orchestratorApp!.db.query(
      "UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id = $1",
      [rootTask.id]
    );
    const retryDeliveryId = `${rootTask.id}:crash-recovery:${randomUUID()}`;
    await orchestratorApp!.db.query(
      `INSERT INTO outbox (aggregate_id, type, delivery_id, payload, due_at)
       VALUES ($1, 'task.dispatch', $2, $3, now())
       ON CONFLICT (delivery_id) DO NOTHING`,
      [
        rootTask.id,
        retryDeliveryId,
        JSON.stringify({
          contractVersion: '1',
          deliveryId: retryDeliveryId,
          taskId: rootTask.id,
          operationId,
          businessId: documentCoreManifest.businessId,
          businessVersion: documentCoreManifest.version,
          action: 'extract',
          kind: 'extract',
          correlationId: `crash-corr-${randomUUID()}`,
        }),
      ]
    );
    await orchestratorApp!.dispatcher.dispatchOnce();

    // 8. Start replacement worker to claim the expired lease
    const replacementWorkerInstanceId = `replacement-worker-${randomUUID().slice(0, 8)}`;
    workerHandle = await startDocumentCoreWorker({
      runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
      runtimeToken,
      connectorUrl,
      redis: { url: REDIS_URL },
      workerInstanceId: replacementWorkerInstanceId,
      concurrency: 1,
      heartbeatIntervalMs: 2000,
      fetchImpl: customFetch,
    });
    partiallyCreatedResources.workers.push(workerHandle);

    // 9. Poll operation to terminal SUCCEEDED state
    const opFinalState = await pollOperationState(operationId);
    expect(opFinalState).toBe('SUCCEEDED');

    // 10. Assert task lease epoch, attempt advancement, and replacement lease holder
    const recoveredTaskRows = await orchestratorApp!.db.query<{
      state: string;
      leased_by: string;
      lease_epoch: number;
      attempt: number;
    }>('SELECT state, leased_by, lease_epoch, attempt FROM tasks WHERE id = $1', [rootTask.id]);
    expect(recoveredTaskRows.rows[0]?.state).toBe('SUCCEEDED');
    expect(recoveredTaskRows.rows[0]?.lease_epoch).toBeGreaterThan(1);
    expect(recoveredTaskRows.rows[0]?.attempt).toBeGreaterThan(1);
    expect(recoveredTaskRows.rows[0]?.leased_by).toBe(replacementWorkerInstanceId);

    // 11. Assert result artifact carries valid completed outcome
    const resultResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resultResp.status).toBe(200);
    const resultBody = (await resultResp.json()) as { data: { resultRef?: string } };
    expect(resultBody.data.resultRef).toMatch(/^artifact:\/\//);
    const envelope = await readResultArtifactEnvelope(operationId, resultBody.data.resultRef!);
    expect(envelope.status).toBe('COMPLETED');

    // 12. Crucial idempotency assertion: provider calls must NOT have incremented on recovery!
    expect(providerCalls).toBe(callsBeforeTest + 1);
  }, 45_000);

  /**
   * Test 12: Deterministic Connector Revision Pinning across Mid-Operation Profile Updates (PRF-02)
   *
   * Verifies that when an in-flight operation (OpA) is running with connector revision 1,
   * appending a new profile revision pointing to connector revision 2 pins subsequent
   * operations (OpB) to connector revision 2, while OpA remains pinned to connector revision 1.
   * Grants minted for OpA reflect revision 1, and OpB reflects revision 2.
   *
   * Observable revision routing:
   * - Distinct mock provider route (/rev2 vs /rev1)
   * - Distinct provider response markers (connector-rev-1 vs connector-rev-2)
   * - Route-specific provider request counters and zero extra provider calls
   * - Distinct extracted payload content
   */
  it('12. Enforces deterministic connector revision pinning across mid-operation profile updates (PRF-02)', async () => {
    // 1. Provision second revision for connectorId in PostgreSQL targeting /rev2
    const dbClient = new PgSqlClient({
      connectionString: DATABASE_URL,
      migrationDirectory,
    });
    let rev2ConfigRevision = 2;
    try {
      const repo = new PostgresConnectorConfigRepository(dbClient);
      const rev2Created = await repo.createRevision({
        connectorId,
        adapter: 'json-http',
        config: {
          baseUrl: `http://127.0.0.1:${providerPort}`,
          path: '/rev2',
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
      rev2ConfigRevision = rev2Created.revision;
      expect(rev2Created.revision).toBeGreaterThan(1);
    } finally {
      await dbClient.close();
    }

    const rev1CallsBefore = providerRev1Calls;
    const rev2CallsBefore = providerRev2Calls;

    // Helper for bounded barrier wait to prevent hanging workers / teardown on failure
    const waitForBarrier = async (promise: Promise<void> | null, timeoutMs = 15_000) => {
      if (!promise) return;
      let timer: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Timed out waiting for connector pinning barrier after ${timeoutMs}ms`)),
          timeoutMs
        );
      });
      try {
        await Promise.race([promise, timeoutPromise]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    // The barrier is released by a worker whose fetchImpl is customFetch. With no live suite worker
    // this test would only burn the 15-second barrier timeout and look like a connector-pinning
    // defect, so assert the precondition instead of inferring it from a timeout.
    expect(workerHandle).toBeDefined();

    // 2. Arm connector revision pinning barrier for OpA
    connectorPinningBarrierPromise = new Promise<void>((resolve) => {
      connectorPinningBarrierRelease = resolve;
    });
    connectorPinningReachedBarrierPromise = new Promise<void>((resolve) => {
      connectorPinningReachedBarrierSignal = resolve;
    });
    connectorPinningHoldNext = true;

    try {
      // 3. Submit OpA (bound to connector revision 1)
      const idempotencyKeyA = `submit-conn-pin-a-${randomUUID()}`;
      const submitAResp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/document-core/actions/extract`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'idempotency-key': idempotencyKeyA,
          },
          body: JSON.stringify({
            input: {
              type: 'invoice',
              text: 'Invoice OpA under Connector Revision 1 Total $1000',
              outputFormat: 'json',
            },
          }),
        }
      );
      expect(submitAResp.status).toBe(202);
      const { operationId: opAId } = (await submitAResp.json()) as { operationId: string };

      // 4. Await OpA reaching step execution barrier with bounded timeout
      await waitForBarrier(connectorPinningReachedBarrierPromise, 15_000);

      // 5. While OpA is in-flight at barrier, append new profile revision pointing to connector revision 2
      const rev2Result = await profileClient!.createRevision({
        profileId: suiteProfileId,
        apiKey,
        businessId: 'document-core',
        businessVersion: documentCoreManifest.version,
        action: 'extract',
        connectorBindings: {
          reasoning: { connectorId, revision: rev2ConfigRevision },
        },
      });
      expect(rev2Result.revision).toBeGreaterThan(initialExtractProfileRevision);

      // 6. Submit OpB (must resolve newly appended profile revision)
      const idempotencyKeyB = `submit-conn-pin-b-${randomUUID()}`;
      const submitBResp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/document-core/actions/extract`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
            'idempotency-key': idempotencyKeyB,
          },
          body: JSON.stringify({
            input: {
              type: 'invoice',
              text: 'Invoice OpB under Connector Revision 2 Total $2000',
              outputFormat: 'json',
            },
          }),
        }
      );
      expect(submitBResp.status).toBe(202);
      const { operationId: opBId } = (await submitBResp.json()) as { operationId: string };

      // 7. Verify in PostgreSQL that OpA retains its pinned revision while OpB pins new revision
      const opARow = await orchestratorApp!.db.query<{ profile_revision: number; state: string }>(
        'SELECT profile_revision, state FROM operations WHERE id = $1',
        [opAId]
      );
      expect(opARow.rows[0]?.profile_revision).toBe(initialExtractProfileRevision);
      expect(opARow.rows[0]?.state).toBe('RUNNING');

      const opBRow = await orchestratorApp!.db.query<{ profile_revision: number }>(
        'SELECT profile_revision FROM operations WHERE id = $1',
        [opBId]
      );
      expect(opBRow.rows[0]?.profile_revision).toBe(rev2Result.revision);

      // 8. Release barrier for OpA to complete execution
      if (connectorPinningBarrierRelease) {
        connectorPinningBarrierRelease();
        connectorPinningBarrierRelease = null;
      }

      // 9. Poll both operations to terminal SUCCEEDED state
      const opAFinal = await pollOperationState(opAId);
      expect(opAFinal).toBe('SUCCEEDED');
      const opBFinal = await pollOperationState(opBId);
      expect(opBFinal).toBe('SUCCEEDED');

      // 10. Assert minted invocation grants in PostgreSQL: OpA used connector revision 1, OpB used revision 2
      const opATasks = await orchestratorApp!.db.query<{ id: string }>(
        'SELECT id FROM tasks WHERE operation_id = $1',
        [opAId]
      );
      const opBTasks = await orchestratorApp!.db.query<{ id: string }>(
        'SELECT id FROM tasks WHERE operation_id = $1',
        [opBId]
      );

      const grantARows = await orchestratorApp!.db.query<{ connector_revision: number }>(
        'SELECT connector_revision FROM invocation_grants WHERE task_id = $1',
        [opATasks.rows[0]?.id]
      );
      const grantBRows = await orchestratorApp!.db.query<{ connector_revision: number }>(
        'SELECT connector_revision FROM invocation_grants WHERE task_id = $1',
        [opBTasks.rows[0]?.id]
      );

      expect(grantARows.rows[0]?.connector_revision).toBe(initialConnectorRevision);
      expect(grantBRows.rows[0]?.connector_revision).toBe(rev2ConfigRevision);

      // 11. Observable revision routing assertions (distinct routes, response markers, no extra calls)
      expect(providerRev1Calls).toBe(rev1CallsBefore + 1);
      expect(providerRev2Calls).toBe(rev2CallsBefore + 1);

      // 12. Verify semantic output artifacts via resultRef contain the respective connector revision markers
      const resOpA = await fetch(`${orchestratorUrl}/api/v1/operations/${opAId}/result`, {
        headers: { 'x-api-key': apiKey },
      });
      expect(resOpA.status).toBe(200);
      const bodyOpA = (await resOpA.json()) as { data: { resultRef?: string } };
      expect(bodyOpA.data.resultRef).toMatch(/^artifact:\/\//);
      const envelopeOpA = await readResultArtifactEnvelope(opAId, bodyOpA.data.resultRef!);
      expect(envelopeOpA.status).toBe('COMPLETED');
      const dataOpA = envelopeOpA.data as { invoiceNumber?: string; revisionMarker?: string };
      expect(dataOpA.revisionMarker).toBe('connector-rev-1');
      expect(dataOpA.invoiceNumber).toBe('INV-2026-REV1');

      const resOpB = await fetch(`${orchestratorUrl}/api/v1/operations/${opBId}/result`, {
        headers: { 'x-api-key': apiKey },
      });
      expect(resOpB.status).toBe(200);
      const bodyOpB = (await resOpB.json()) as { data: { resultRef?: string } };
      expect(bodyOpB.data.resultRef).toMatch(/^artifact:\/\//);
      const envelopeOpB = await readResultArtifactEnvelope(opBId, bodyOpB.data.resultRef!);
      expect(envelopeOpB.status).toBe('COMPLETED');
      const dataOpB = envelopeOpB.data as { invoiceNumber?: string; revisionMarker?: string };
      expect(dataOpB.revisionMarker).toBe('connector-rev-2');
      expect(dataOpB.invoiceNumber).toBe('INV-2026-REV2');
    } finally {
      // Always release and reset barrier so worker and cleanup are never stranded on failure
      connectorPinningHoldNext = false;
      connectorPinningHoldTaskId = null;
      if (connectorPinningBarrierRelease) {
        connectorPinningBarrierRelease();
        connectorPinningBarrierRelease = null;
      }
      connectorPinningBarrierPromise = null;
      connectorPinningReachedBarrierPromise = null;
      connectorPinningReachedBarrierSignal = null;
    }
  }, 45_000);

  /**
   * Test 13: Fail-Closed Authorization for Unbound Actions (PRF-01)
   *
   * Verifies that when an API key has profile bindings, submitting an action that
   * was not authorized in profile_bindings immediately rejects with 403 Forbidden,
   * enqueues zero tasks, and causes zero provider side-effects.
   */
  it('13. Rejects submission with 403 Forbidden for actions not authorized in profile bindings (PRF-01)', async () => {
    // 1. Create a restricted API key in active state and track for teardown
    const restrictedKey = `restricted-key-${randomUUID()}`;
    const restrictedKeyHash = createHash('sha256').update(restrictedKey).digest('hex');
    trackedApiKeys.push(restrictedKeyHash);

    await orchestratorApp!.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'test', 'ACTIVE')`,
      [randomUUID(), '00000000-0000-0000-0000-000000000001', restrictedKeyHash]
    );

    // 2. Bind ONLY 'extract' action for this key and track profileId for teardown
    const restrictedBinding = await profileClient!.createRevision({
      apiKey: restrictedKey,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'extract',
      connectorBindings: {
        reasoning: { connectorId, revision: initialConnectorRevision },
      },
    });
    trackedProfileIds.push(restrictedBinding.profileId);

    const callsBefore = providerCalls;

    // 3. Attempt to submit 'analyze' (an unbound action) with this restricted key
    const deniedResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/document-core/actions/analyze`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': restrictedKey,
        },
        body: JSON.stringify({
          input: {
            task: 'classify',
            text: 'Sample document for classification test',
          },
        }),
      }
    );

    // 4. Assert fail-closed 403 Forbidden response with ProblemDetails envelope
    expect(deniedResp.status).toBe(403);
    const problem = (await deniedResp.json()) as ProblemDetails;
    expect(problem.status).toBe(403);
    expect(problem.code).toBe('PERMISSION_DENIED');
    expect(problem.title).toMatch(/not authorized for action analyze/);

    // 5. Assert zero operations or tasks enqueued for this key
    const opCount = await orchestratorApp!.db.query<{ count: string }>(
      `SELECT count(*) as count FROM operations o
       JOIN api_keys k ON o.api_key_id = k.id
       WHERE k.hash = $1`,
      [restrictedKeyHash]
    );
    expect(Number(opCount.rows[0]?.count)).toBe(0);

    // 6. Assert zero provider effects
    expect(providerCalls).toBe(callsBefore);
  });
});
