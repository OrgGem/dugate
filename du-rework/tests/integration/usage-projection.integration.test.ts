import { createHash, randomUUID } from 'node:crypto';
import { Queue, type Job } from 'bullmq';
import { HttpUsageSink, type UsageEvent, PgSqlClient } from '@du/connector';
import {
  BusinessJobV1Schema,
  BusinessManifestSchema,
  ClaimResultSchema,
  ResultEnvelopeSchema,
  SubmitAckSchema,
  TaskReportAckSchema,
  contentHash,
} from '@du/contracts';
import { createApp, type App } from '@du/orchestrator';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../isolation/namespace';

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({
        runId: process.env.TEST_RUN_ID,
      });

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
const USAGE_TOKEN = `integration-usage-${randomUUID()}`;
const API_KEY = `integration-api-${randomUUID()}`;
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
const BUSINESS_ID = `usage-proof-${randomUUID().replaceAll('-', '')}`;
const BUSINESS_VERSION = '1.0.0';

const manifest = BusinessManifestSchema.parse({
  contractVersion: '1',
  businessId: BUSINESS_ID,
  version: BUSINESS_VERSION,
  displayName: 'Usage projection integration proof',
  description: 'Synthetic cross-service fixture',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: false, resume: false, parallel: false },
  actions: [
    {
      name: 'verify',
      displayName: 'Verify usage',
      description: 'Creates one real operation and root task',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 0 },
      capabilities: { cancel: false, resume: false },
      defaultLimits: { maxParallelTasks: 1 },
    },
  ],
});

interface HttpResult {
  status: number;
  body: unknown;
}

async function request(
  baseUrl: string,
  path: string,
  options: { method?: string; headers?: Record<string, string>; body?: unknown } = {},
): Promise<HttpResult> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(options.headers ?? {}) },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as unknown : undefined };
}

async function startOrchestrator(): Promise<{ app: App; baseUrl: string }> {
  const app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    runtimeToken: RUNTIME_TOKEN,
    usageToken: USAGE_TOKEN,
    autoDispatch: true,
    autoMigrate: true,
  });
  await app.db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ($1,$2,$3,'test', 'ACTIVE')
     ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
    [randomUUID(), TENANT_ID, hashKey(API_KEY)],
  );
  const server = await app.listen();
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Orchestrator did not bind a TCP port.');
  return { app, baseUrl: `http://127.0.0.1:${address.port}` };
}

async function waitForOperationJob(queue: Queue, operationId: string): Promise<Job> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    const jobs = await queue.getJobs(['waiting', 'delayed', 'active', 'completed']);
    const match = jobs.find((job) => {
      const parsed = BusinessJobV1Schema.safeParse(job.data);
      return parsed.success && parsed.data.operationId === operationId;
    });
    if (match) return match;
    await new Promise<void>((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`No dispatch job appeared for operation ${operationId}.`);
}

describe('Orchestrator + Connector usage path', () => {
  let app: App | undefined;
  let queue: Queue | undefined;

  beforeAll(async () => {
    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await client.close();
    }
  });

  afterAll(async () => {
    if (isolationCtx && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      await client.close();
    }
  });

  afterEach(async () => {
    await queue?.close().catch(() => undefined);
    await app?.close().catch(() => undefined);
    queue = undefined;
    app = undefined;
  });

  test('deduplicates a real HttpUsageSink event and preserves its projection across restart', async () => {
    let runtime = await startOrchestrator();
    app = runtime.app;

    const registration = await request(
      runtime.baseUrl,
      `/api/runtime/v1/businesses/${BUSINESS_ID}/versions/${BUSINESS_VERSION}`,
      {
        method: 'PUT',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: manifest,
      },
    );
    expect([200, 201]).toContain(registration.status);

    // Integration bootstrap only: the admin/RBAC enable endpoint is not in the
    // current runtime slice. The exercised operation/task path remains HTTP.
    await app.enableVersionForTest(BUSINESS_ID, BUSINESS_VERSION);

    const submission = await request(runtime.baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/verify`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'idempotency-key': `submit-${randomUUID()}` },
      body: { input: { text: 'cross-service usage proof' } },
    });
    expect(submission.status).toBe(202);
    const submitAck = SubmitAckSchema.parse(submission.body);

    queue = new Queue(`du-business-${BUSINESS_ID}-${BUSINESS_VERSION}`, {
      connection: { url: REDIS_URL },
    });
    const job = await waitForOperationJob(queue, submitAck.operationId);
    const dispatch = BusinessJobV1Schema.parse(job.data);

    const claimResponse = await request(runtime.baseUrl, `/api/runtime/v1/tasks/${dispatch.taskId}/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { deliveryId: dispatch.deliveryId, workerInstanceId: 'integration-worker', businessId: BUSINESS_ID },
    });
    expect(claimResponse.status).toBe(200);
    const claim = ClaimResultSchema.parse(claimResponse.body);

    const resultRef = `integration://result/${submitAck.operationId}`;
    const completionResponse = await request(
      runtime.baseUrl,
      `/api/runtime/v1/tasks/${dispatch.taskId}/complete`,
      {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { leaseEpoch: claim.leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
      },
    );
    expect(completionResponse.status).toBe(200);
    expect(TaskReportAckSchema.parse(completionResponse.body).state).toBe('SUCCEEDED');

    const event: UsageEvent = {
      eventId: `usage-${randomUUID()}`,
      invocationId: `invocation-${randomUUID()}`,
      operationId: submitAck.operationId,
      taskId: dispatch.taskId,
      usage: {
        inputTokens: 41,
        outputTokens: 17,
        pages: 2,
        costMicrousd: 725,
        measurement: 'measured',
      },
      createdAt: new Date().toISOString(),
    };
    const sink = new HttpUsageSink(`${runtime.baseUrl}/api/runtime/v1/usage-events`, USAGE_TOKEN);
    await sink.send(event);
    await sink.send(event);

    const beforeRestart = await request(
      runtime.baseUrl,
      `/api/v1/operations/${submitAck.operationId}/result`,
      { headers: { 'x-api-key': API_KEY } },
    );
    expect(beforeRestart.status).toBe(200);
    const projectedBeforeRestart = ResultEnvelopeSchema.parse(beforeRestart.body);
    expect(projectedBeforeRestart.usage).toEqual({
      inputTokens: 41,
      outputTokens: 17,
      costMicrousd: 725,
      measurement: 'measured',
    });

    await app.close();
    app = undefined;
    runtime = await startOrchestrator();
    app = runtime.app;

    const restartedSink = new HttpUsageSink(`${runtime.baseUrl}/api/runtime/v1/usage-events`, USAGE_TOKEN);
    await restartedSink.send(event);

    const afterRestart = await request(
      runtime.baseUrl,
      `/api/v1/operations/${submitAck.operationId}/result`,
      { headers: { 'x-api-key': API_KEY } },
    );
    expect(afterRestart.status).toBe(200);
    const projectedAfterRestart = ResultEnvelopeSchema.parse(afterRestart.body);
    expect(projectedAfterRestart.data).toEqual({ resultRef });
    expect(projectedAfterRestart.usage).toEqual(projectedBeforeRestart.usage);

    await job.remove();
  });
});
