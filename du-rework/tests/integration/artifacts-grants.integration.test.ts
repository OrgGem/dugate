import { createHash, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import {
  ArtifactAccessGrantSchema,
  ArtifactUploadGrantSchema,
  BusinessJobV1Schema,
  BusinessManifestSchema,
  ClaimResultSchema,
  InvocationGrantSchema,
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
const ADMIN_TOKEN = `integration-admin-${randomUUID()}`;
const API_KEY = `integration-api-${randomUUID()}`;
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
const BUSINESS_ID = `artifacts-proof-${randomUUID().replaceAll('-', '')}`;
const BUSINESS_VERSION = '1.0.0';
const INVOCATION_GRANT_SECRET = `secret-${randomUUID()}`;

const manifest = BusinessManifestSchema.parse({
  contractVersion: '1',
  businessId: BUSINESS_ID,
  version: BUSINESS_VERSION,
  displayName: 'Artifact + invocation grant integration proof',
  description: 'Synthetic cross-service fixture',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: true, resume: false, parallel: false },
  actions: [
    {
      name: 'process',
      displayName: 'Process with artifact + grant',
      description: 'Root task that writes an artifact and requests a connector grant',
      inputSchema: {
        type: 'object',
        required: ['text'],
        properties: { text: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [{ name: 'slot-1', required: false, acceptedCapabilities: ['test-capability'] }],
      artifactPolicy: { minFiles: 0, maxFiles: 5 },
      capabilities: { cancel: true, resume: false },
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
  if (path.includes('/blob/')) return { status: response.status, body: text };
  return { status: response.status, body: text ? JSON.parse(text) as unknown : undefined };
}

async function startOrchestrator(): Promise<{ app: App; baseUrl: string }> {
  const app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    runtimeToken: RUNTIME_TOKEN,
    adminToken: ADMIN_TOKEN,
    invocationGrantSecret: INVOCATION_GRANT_SECRET,
    connectorId: 'default-connector',
    connectorRevision: 1,
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

async function waitForOperationJob(queue: Queue, operationId: string) {
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

import { PgSqlClient } from '@du/connector';

describe('Orchestrator artifact + invocation-grant boundary', () => {
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

  test('claims a task, uploads+finalizes an artifact, gets an access grant, and issues a connector-verifiable invocation grant', async () => {
    let runtime = await startOrchestrator();
    app = runtime.app;

    const registration = await request(
      runtime.baseUrl,
      `/api/runtime/v1/businesses/${BUSINESS_ID}/versions/${BUSINESS_VERSION}`,
      { method: 'PUT', headers: { authorization: `Bearer ${RUNTIME_TOKEN}` }, body: manifest },
    );
    expect([200, 201]).toContain(registration.status);
    await app.enableVersionForTest(BUSINESS_ID, BUSINESS_VERSION);

    const submission = await request(runtime.baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY, 'idempotency-key': `submit-${randomUUID()}` },
      body: { input: { text: 'artifact + grant proof' } },
    });
    expect(submission.status).toBe(202);

    queue = new Queue(`du-business-${BUSINESS_ID}-${BUSINESS_VERSION}`, {
      connection: { url: REDIS_URL },
    });
    const dispatchJob = await waitForOperationJob(queue, (submission.body as { operationId: string }).operationId);
    const dispatch = BusinessJobV1Schema.parse(dispatchJob.data);

    const claimResponse = await request(runtime.baseUrl, `/api/runtime/v1/tasks/${dispatch.taskId}/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { deliveryId: dispatch.deliveryId, workerInstanceId: 'integration-worker', businessId: BUSINESS_ID },
    });
    expect(claimResponse.status).toBe(200);
    const claim = ClaimResultSchema.parse(claimResponse.body);
    const leaseEpoch = claim.leaseEpoch;

    // 1. request an upload grant
    const uploadResp = await request(runtime.baseUrl, `/api/runtime/v1/tasks/${dispatch.taskId}/artifacts`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { leaseEpoch, purpose: 'output', mimeType: 'application/octet-stream', sizeBytes: 42 },
    });
    expect(uploadResp.status).toBe(201);
    if (uploadResp.status !== 201) console.error('UPLOAD BODY', JSON.stringify(uploadResp.body));
    const upload = ArtifactUploadGrantSchema.parse(uploadResp.body);

    // 2. PUT blob bytes behind the grant
    const putResp = await fetch(`${upload.uploadUrl}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from('hello artifact world'),
    });
    expect(putResp.status).toBe(204);

    // 3. finalize
    const sha = 'a'.repeat(64); // test fixture; the slice only stores + marks READY
    const finalizeResp = await request(runtime.baseUrl, `/api/runtime/v1/artifacts/${upload.artifactId}/finalize`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { sizeBytes: 19, sha256: sha },
    });
    expect(finalizeResp.status).toBe(200);
    expect((finalizeResp.body as { state: string }).state).toBe('READY');

    // 4. access grant + GET blob
    const accessResp = await request(runtime.baseUrl, `/api/runtime/v1/artifacts/${upload.artifactId}/access`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { taskId: dispatch.taskId, leaseEpoch, mode: 'read' },
    });
    expect(accessResp.status).toBe(200);
    const access = ArtifactAccessGrantSchema.parse(accessResp.body);
    expect(access.downloadUrl).toBeDefined();
    const getResp = await fetch(`${access.downloadUrl}`);
    expect(getResp.status).toBe(200);
    // FIX-CR-13 binary wire: GET returns stored bytes raw (octet-stream),
    // never base64/JSON-encoded.
    const got = Buffer.from(await getResp.arrayBuffer()).toString('utf8');
    expect(got).toBe('hello artifact world');

    // 5. invocation grant (Connector-verifiable HS256)
    const grantResp = await request(runtime.baseUrl, `/api/runtime/v1/tasks/${dispatch.taskId}/invocation-grants`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { leaseEpoch, stepKey: 'step-1', bindingSlot: 'slot-1', inputHash: `hash-${randomUUID()}` },
    });
    expect(grantResp.status).toBe(201);
    const grant = InvocationGrantSchema.parse(grantResp.body);
    expect(grant.connectorId).toBe('default-connector');
    expect(grant.connectorRevision).toBe(1);
    expect(grant.grant.split('.')).toHaveLength(3); // header.payload.signature

    // 6. complete the task so the operation closes
    const resultRef = `integration://result/${dispatch.operationId}`;
    const completeResp = await request(runtime.baseUrl, `/api/runtime/v1/tasks/${dispatch.taskId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
    expect(completeResp.status).toBe(200);
    expect(TaskReportAckSchema.parse(completeResp.body).state).toBe('SUCCEEDED');

    await dispatchJob.remove();
  });
});
