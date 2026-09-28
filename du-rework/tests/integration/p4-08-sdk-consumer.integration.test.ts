import { createHash, createHmac, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { Queue } from 'bullmq';
import {
  BusinessManifestSchema,
  SubmitAckSchema,
} from '@du/contracts';
import { createApp, type App } from '@du/orchestrator';
import {
  AesCredentialCipher,
  ContractSignedGrantVerifier,
  HmacServiceIdentityVerifier,
  HmacSignedGrantSource,
  PgSqlClient,
  PostgresConnectorConfigRepository,
  createConnectorComposition,
} from '@du/connector';

// SDK + connector-client are imported from SOURCE (relative) so this suite
// needs no dependency/lockfile edits in the shared integration package.
import {
  defineBusiness,
  runConnectorStep,
  startWorker,
} from '../../packages/worker-sdk/src/index';
import type { WorkerHandle } from '../../packages/worker-sdk/src/index';
import {
  createHttpTransport,
  createSdkConnectorInvoker,
} from '../../packages/connector-client/src/index';

import { MockProviderServer } from '../stubs/provider/mock-provider';

import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../isolation/namespace';

/**
 * P4-08 integration proof (W40-CC): SDK consumer integration against REAL
 * P2 (orchestrator) and P3 (connector) — the acceptance text explicitly
 * requires real consumers, not mocks. The only synthetic component is the
 * upstream AI provider (MockProviderServer, per lane directive: no real AI).
 *
 * Full G3 path exercised end-to-end:
 *   submit → outbox dispatch (real Redis/BullMQ) → SDK startWorker consumes
 *   → claim (lease) → runConnectorStep → runtime invocation grant (stable
 *   invocationId) → connector-client HTTP transport → REAL connector service
 *   → mock provider says 202 PENDING → SDK yields via PendingInvocationError
 *   → failTask(retryable) → RETRY_PENDING → outbox due_at re-dispatch →
 *   second delivery replays the SAME stable invocationId → provider now 200
 *   → artifact write (real upload grant) → complete → operation SUCCEEDED.
 *
 * Also proves the acceptance invariant "worker has no DB credential": the
 * worker config carries only runtimeUrl/token + queue URL + connector HTTP
 * wiring — no postgres connection string anywhere near the SDK worker.
 */

const CONNECTOR_MIGRATION_DIRECTORY =
  process.env.CONNECTOR_MIGRATION_DIRECTORY ??
  join(__dirname, '..', '..', 'services', 'connector', 'src', 'db', 'migrations');

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({ runId: process.env.TEST_RUN_ID });

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const DATABASE_URL = isolationCtx
  ? isolationCtx.getDatabaseUrlWithSchema(BASE_DATABASE_URL)
  : BASE_DATABASE_URL;

const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const REDIS_URL = process.env.REDIS_URL ?? (
  isolationCtx && process.env.REDIS_DB_INDEX
    ? `redis://localhost:6380/${process.env.REDIS_DB_INDEX}`
    : BASE_REDIS_URL
);

const RUNTIME_TOKEN = `integration-runtime-${randomUUID()}`;
const ADMIN_TOKEN = `integration-admin-${randomUUID()}`;
const API_KEY = `integration-api-${randomUUID()}`;
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const BUSINESS_ID = `p408-sdk-consumer-${randomUUID().replaceAll('-', '')}`;
const BUSINESS_VERSION = '1.0.0';
const INVOCATION_GRANT_SECRET = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');
const IDENTITY_SECRET = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');
const ENCRYPTION_KEY = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');

const manifest = BusinessManifestSchema.parse({
  contractVersion: '1',
  businessId: BUSINESS_ID,
  version: BUSINESS_VERSION,
  displayName: 'P4-08 SDK consumer integration proof',
  description: 'Real SDK worker against real orchestrator + connector with a mock provider',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: false, resume: false, parallel: false },
  actions: [
    {
      name: 'run',
      displayName: 'Run one connector step',
      description: 'Root task invoking the reasoning slot through the real connector',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [
        { name: 'reasoning', required: false, acceptedCapabilities: ['chat-completion'] },
      ],
      artifactPolicy: { minFiles: 0, maxFiles: 2 },
      capabilities: { cancel: false, resume: false },
      defaultLimits: { maxParallelTasks: 1 },
    },
  ],
});

/** Same derivation as orchestrator grants.ts stableInvocationId (read-only replica). */
function stableInvocationId(taskId: string, stepKey: string, bindingSlot: string): string {
  const ns = '1b671a64-40d5-491e-99b0-190777e0c4e3';
  const frame = (v: string) => `${v.length}:${v}`;
  const digest = createHmac('sha256', ns)
    .update(frame(taskId) + '|' + frame(stepKey) + '|' + frame(bindingSlot))
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

function serviceIdentityToken(): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode({ sub: 'p4-08-sdk-worker', aud: 'connector', scopes: ['connector:invoke'] });
  const signature = createHmac('sha256', IDENTITY_SECRET).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

interface HttpResult {
  status: number;
  body: unknown;
}

async function request(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? (JSON.parse(text) as unknown) : undefined };
}

async function pollOperationState(
  baseUrl: string,
  operationId: string,
  accept: string[],
  timeoutMs: number
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    const res = await request(baseUrl, `/api/v1/operations/${operationId}`, {
      headers: { 'x-api-key': API_KEY },
    });
    if (res.status === 200) {
      const view = res.body as { state?: string };
      last = view.state ?? '';
      if (accept.includes(last)) return last;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`operation ${operationId} did not reach [${accept.join('|')}] within ${timeoutMs}ms (last: ${last})`);
}

describe('P4-08 — SDK consumer against real P2 orchestrator + real P3 connector', () => {
  let app: App | undefined;
  let queue: Queue | undefined;
  let worker: WorkerHandle | undefined;
  let provider: MockProviderServer | undefined;
  let connectorComposition: ReturnType<typeof createConnectorComposition> | undefined;
  let connectorDb: PgSqlClient | undefined;
  let baseUrl = '';

  beforeAll(async () => {
    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await client.close();
    }
  });

  afterAll(async () => {
    await worker?.stop(5_000).catch(() => undefined);
    await queue?.close().catch(() => undefined);
    await connectorComposition?.shutdown().catch(() => undefined);
    await provider?.stop().catch(() => undefined);
    await connectorDb?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    if (isolationCtx && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      await client.close();
    }
  });

  test('full cross-service run: submit → dispatch → SDK worker → pending yield → retry → stable invocation → SUCCEEDED', async () => {
    /* ---------------- P2: real orchestrator ---------------- */
    const runtime = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      adminToken: ADMIN_TOKEN,
      invocationGrantSecret: INVOCATION_GRANT_SECRET.toString('utf8'),
      connectorId: 'default-connector',
      connectorRevision: 1,
      autoDispatch: true,
      autoMigrate: true,
    });
    app = runtime;
    await runtime.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'test','ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), TENANT_ID, hashKey(API_KEY)]
    );
    const server = await runtime.listen();
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('Orchestrator did not bind.');
    baseUrl = `http://127.0.0.1:${addr.port}`;
    const runtimeBase = `${baseUrl}/api/runtime/v1`;

    /* ------------- upstream provider (synthetic) ------------- */
    provider = new MockProviderServer();
    await provider.start();
    // First phase: provider is async — 202 pending (forces the yield path).
    provider.setDefaultResponse({
      status: 202,
      headers: { 'content-type': 'application/json' },
      body: { state: 'pending', nextPollAt: new Date(Date.now() + 1_500).toISOString() },
    });

    /* ---------------- P3: real connector ---------------- */
    connectorDb = new PgSqlClient({
      connectionString: DATABASE_URL,
      migrationDirectory: CONNECTOR_MIGRATION_DIRECTORY,
    });
    await connectorDb.migrate();
    const repository = new PostgresConnectorConfigRepository(connectorDb);
    const credentialRef = `${BUSINESS_ID}:credential`;
    await repository.put(credentialRef, new AesCredentialCipher(ENCRYPTION_KEY).encrypt('provider-secret'));
    await repository.createRevision({
      connectorId: 'default-connector',
      adapter: 'json-http',
      config: {
        baseUrl: provider.baseUrl,
        path: '/',
        timeoutMs: 5_000,
        asyncPollingMode: 'idempotency-key-replay',
      },
      credentialRef,
      state: 'ACTIVE',
    });
    connectorComposition = createConnectorComposition({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      migrationDirectory: CONNECTOR_MIGRATION_DIRECTORY,
      serviceIdentityVerifier: new HmacServiceIdentityVerifier(IDENTITY_SECRET),
      grantVerifier: new ContractSignedGrantVerifier(new HmacSignedGrantSource(INVOCATION_GRANT_SECRET)),
      credentialCipher: new AesCredentialCipher(ENCRYPTION_KEY),
      providerAllowHosts: ['127.0.0.1'],
    });
    await connectorComposition.start();
    const connectorAddr = connectorComposition.address();
    if (!connectorAddr || typeof connectorAddr === 'string') throw new Error('Connector did not bind.');
    const connectorBase = `http://127.0.0.1:${connectorAddr.port}`;

    /* ---------------- register + enable business ---------------- */
    const registration = await request(
      baseUrl,
      `/api/runtime/v1/businesses/${BUSINESS_ID}/versions/${BUSINESS_VERSION}`,
      { method: 'PUT', headers: { authorization: `Bearer ${RUNTIME_TOKEN}` }, body: manifest }
    );
    expect([200, 201]).toContain(registration.status);
    await runtime.enableVersionForTest(BUSINESS_ID, BUSINESS_VERSION);

    /* ---------------- SDK worker (no DB credential) ---------------- */
    const sdkInvokeConnector = createSdkConnectorInvoker(
      createHttpTransport({ baseUrl: connectorBase, token: () => serviceIdentityToken() })
    );
    const workerConfig: Parameters<typeof startWorker>[1] = {
      runtimeUrl: runtimeBase,
      runtimeToken: RUNTIME_TOKEN,
      redis: { url: REDIS_URL },
      concurrency: 1,
      // Compile the connector-client adapter directly against the frozen
      // WorkerConfig.invokeConnector seam; both use the canonical wire input.
      invokeConnector: sdkInvokeConnector,
      tempSweep: { enabled: false },
      component: 'p4-08-integration-worker',
    };
    // ACCEPTANCE: the worker process carries NO database credential — only
    // runtime HTTP + queue transport + connector HTTP wiring.
    expect(JSON.stringify(workerConfig)).not.toMatch(/postgres(ql)?:\/\//);
    expect(Object.keys(workerConfig)).not.toContain('databaseUrl');

    const definition = defineBusiness(manifest, {
      root: async (ctx) => {
        const step = await runConnectorStep(ctx, {
          stepKey: 'summarize',
          slot: 'reasoning',
          input: { text: String(ctx.input['text'] ?? '') },
        });
        const ref = await ctx.artifacts.write(
          JSON.stringify(step.result),
          'result.json',
          'application/json',
          'output'
        );
        return { kind: 'completed', resultRef: `artifact://${ref.artifactId}` };
      },
    });
    worker = await startWorker(definition, workerConfig);

    /* ---------------- submit a real operation ---------------- */
    const submission = await request(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/run`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'idempotency-key': `submit-${randomUUID()}` },
      body: { input: { text: 'P4-08 cross-service proof' } },
    });
    expect(submission.status).toBe(202);
    const ack = SubmitAckSchema.parse(submission.body);

    queue = new Queue(`du-business-${BUSINESS_ID}-${BUSINESS_VERSION}`, {
      connection: { url: REDIS_URL },
    });

    /* ------- phase 1: provider pending → the SDK must YIELD ------- */
    const yielded = await pollOperationState(baseUrl, ack.operationId, ['RETRY_PENDING'], 45_000);
    expect(yielded).toBe('RETRY_PENDING');
    expect(provider!.callCount).toBeGreaterThanOrEqual(1);

    /* ------- phase 2: provider completes → retry redelivery ------- */
    provider.setDefaultResponse({
      status: 200,
      headers: { 'content-type': 'application/json' },
      body: {
        content: 'P4-08 provider final answer',
        providerRequestId: `prov-${randomUUID()}`,
        usage: { inputTokens: 11, outputTokens: 7, costMicrousd: 13, measurement: 'measured' },
      },
    });
    const final = await pollOperationState(baseUrl, ack.operationId, ['SUCCEEDED'], 60_000);
    expect(final).toBe('SUCCEEDED');

    /* ------- stable invocation: ONE ledger row across the yield ------- */
    const taskRows = await connectorDb.query(
      `SELECT t.id FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE o.id=$1`,
      [ack.operationId]
    );
    expect(taskRows.rows.length).toBeGreaterThanOrEqual(1);
    const rootTaskId = (taskRows.rows[0] as { id: string }).id;
    const expectedInvocationId = stableInvocationId(rootTaskId, 'summarize', 'reasoning');

    const ledger = await connectorDb.query(
      `SELECT invocation_id, state FROM connector_invocations WHERE task_id=$1`,
      [rootTaskId]
    );
    expect(ledger.rows).toHaveLength(1); // deduped by the stable invocationId
    const row = ledger.rows[0] as { invocation_id: string; state: string };
    expect(row.invocation_id).toBe(expectedInvocationId);
    expect(row.state).toBe('SUCCEEDED');

    // The provider saw ≥2 HTTP attempts (pending + completion) while the
    // ledger kept exactly one invocation identity — no duplicate identity,
    // no lost work.
    expect(provider!.callCount).toBeGreaterThanOrEqual(2);

    /* ------- result landed as a real artifact ------- */
    const resultResp = await request(baseUrl, `/api/v1/operations/${ack.operationId}/result`, {
      headers: { 'x-api-key': API_KEY },
    });
    expect(resultResp.status).toBe(200);
    const envelope = resultResp.body as { data?: { resultRef?: string } };
    expect(envelope.data?.resultRef).toMatch(/^artifact:\/\/[0-9a-f-]{36}/);
  }, 180_000);
});
