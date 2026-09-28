import { createHash, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { createApp, type App } from '../src/server';
import { contentHash, hashInvocationInput } from '@du/contracts';
import {
  deliverWebhooks,
  signWebhookBody,
  verifyWebhookSignature,
} from '../src/modules/webhooks/webhooks';
import { toOperationView, isTerminal, resultHttpStatus, waitForTerminal } from '../src/modules/operations/facade';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  assertSafeIsolationConfig,
  type TestIsolationContext,
} from '../../../tests/isolation/namespace';

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({
        runId: process.env.TEST_RUN_ID,
        redisDbIndex: process.env.REDIS_DB_INDEX ? Number(process.env.REDIS_DB_INDEX) : undefined,
      });

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const DATABASE_URL = isolationCtx
  ? isolationCtx.getDatabaseUrlWithSchema(BASE_DATABASE_URL)
  : BASE_DATABASE_URL;

const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const REDIS_URL = process.env.REDIS_URL ?? (
  isolationCtx
    ? isolationCtx.getRedisUrl(BASE_REDIS_URL)
    : BASE_REDIS_URL
);

const RUNTIME_TOKEN = 'test-runtime-token-' + randomUUID();
const WORKER_IDENTITY_TOKEN = 'test-worker-identity-token-' + randomUUID();
const ADMIN_TOKEN = 'test-admin-token-' + randomUUID();
const USAGE_TOKEN = 'test-usage-token-' + randomUUID();
const GRANT_SECRET = 'test-grant-secret-' + randomUUID();
const RAW_API_KEY = 'du_test_' + randomUUID().replace(/-/g, '');
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

const MANIFEST = {
  contractVersion: '1' as const,
  businessId: isolationCtx ? `test-biz-${isolationCtx.runId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-') : 'test-biz',
  version: '1.0.0',
  displayName: 'Test Business',
  description: 'runtime slice fixture',
  imageDigest: 'sha256:aa',
  runtime: { wireVersion: '1' as const, handlerKinds: ['root'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [
    {
      name: 'extract',
      displayName: 'Extract',
      description: 'Test action',
      inputSchema: {
        type: 'object',
        required: ['q'],
        properties: { q: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [{ name: 'reasoning', required: true, acceptedCapabilities: ['test-capability'] }],
      artifactPolicy: { minFiles: 0, maxFiles: 0 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 2 },
    },
  ],
};

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

async function http(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown>; headers: Record<string, string> }> {
  const requestBody = path.endsWith('/claim') && typeof opts.body === 'object' && opts.body !== null && !Array.isArray(opts.body)
    ? { businessId: MANIFEST.businessId, ...opts.body }
    : opts.body;
  const requestHeaders: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
  if (path.endsWith('/claim') && requestHeaders.authorization === `Bearer ${RUNTIME_TOKEN}`) {
    requestHeaders.authorization = `Bearer ${WORKER_IDENTITY_TOKEN}`;
  }
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: requestHeaders,
    body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
  });
  const text = await res.text();
  const responseBody: Record<string, unknown> = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const responseHeaders: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    responseHeaders[k] = v;
  });
  return { status: res.status, body: responseBody, headers: responseHeaders };
}

let app: App;
let baseUrl: string;
let queueName: string;

/**
 * W13-C test-DB isolation. Suites share PG :5433 / Redis :6380, so this
 * suite must never wipe another suite's rows: cleanup is scoped to this
 * suite's business_id/tenant, the Redis drain is scoped to this suite's
 * queue, and any cleanup refuses to run against a non-test database.
 * Interim policy: shared-DB suites still run serially (documented in the
 * Claude lane report); parallel compatibility is NOT certified.
 */
function assertTestDatabase(): void {
  const dbName = new URL(DATABASE_URL).pathname.split("/").pop() ?? ".";
  if (!/test/i.test(dbName)) {
    throw new Error(
      `refusing test cleanup: DATABASE_URL database "${dbName}" does not look like a test database`
    );
  }
  assertSafeIsolationConfig({
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    isolationCtx,
    allowUnsafeShared: process.env.ALLOW_UNSAFE_SHARED_DB === 'true',
  });
}

/** Delete only this suite's rows (E2E/other suites' business_versions survive). */
async function scopedCleanup(): Promise<void> {
  assertTestDatabase();
  const biz = MANIFEST.businessId;
  const ops = await app.db.query<{ id: string }>('SELECT id FROM operations WHERE business_id=$1', [biz]);
  const opIds = ops.rows.map((r) => r.id);
  if (opIds.length > 0) {
    await app.db.query('DELETE FROM usage_events WHERE operation_id = ANY($1)', [opIds]);
    const tasks = await app.db.query<{ id: string }>('SELECT id FROM tasks WHERE operation_id = ANY($1)', [opIds]);
    const taskIds = tasks.rows.map((r) => r.id);
    if (taskIds.length > 0) {
      await app.db.query('DELETE FROM invocation_grants WHERE task_id = ANY($1)', [taskIds]);
      await app.db.query('DELETE FROM step_checkpoints WHERE task_id = ANY($1)', [taskIds]);
      await app.db.query('DELETE FROM artifacts WHERE task_id = ANY($1)', [taskIds]);
      await app.db.query('DELETE FROM human_waits WHERE task_id = ANY($1)', [taskIds]);
      await app.db.query(
        'DELETE FROM task_dependencies WHERE parent_id = ANY($1) OR child_id = ANY($1)',
        [taskIds]
      );
      await app.db.query('DELETE FROM outbox WHERE aggregate_id = ANY($1)', [taskIds]);
      await app.db.query('DELETE FROM tasks WHERE id = ANY($1)', [taskIds]);
    }
    // Submission keys point at operations (FK): delete this suite's keys by
    // operation before deleting the operations themselves.
    await app.db.query('DELETE FROM submission_keys WHERE operation_id = ANY($1)', [opIds]);
    // P2-08: webhook deliveries reference operations (FK).
    await app.db.query('DELETE FROM webhook_deliveries WHERE operation_id = ANY($1)', [opIds]);
    await app.db.query('DELETE FROM operations WHERE id = ANY($1)', [opIds]);
  }
  await app.db.query('DELETE FROM business_versions WHERE business_id=$1', [biz]);
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('runtime.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  if (isolationCtx) {
    const { Pool: AdminPool } = await import('pg');
    const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
    await adminPool.end();
  }

  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    runtimeToken: RUNTIME_TOKEN,
    workerIdentityTokensByBusiness: { [MANIFEST.businessId]: WORKER_IDENTITY_TOKEN },
    adminToken: ADMIN_TOKEN,
    usageToken: USAGE_TOKEN,
    invocationGrantSecret: GRANT_SECRET,
    connectorId: 'test-connector',
    connectorRevision: 3,
    autoDispatch: false, // tests drive dispatchOnce() explicitly
    autoMigrate: true, // zero-config boot: apply pending migrations so the fixture schema is ready
  });
  // Seed an API key for RAW_API_KEY.
  await app.db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ($1,$2,$3,'test', 'ACTIVE')
     ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
    [randomUUID(), TENANT_ID, hashKey(RAW_API_KEY)]
  );
  const server = await app.listen();
  const addr = server.address() as { port: number };
  baseUrl = `http://127.0.0.1:${addr.port}`;
  // Scoped cleanup only (never global TRUNCATE / flushdb): other suites'
  // rows and queues on the shared infra survive this suite's setup.
  await scopedCleanup();
  // Drain only this suite's BullMQ queue (deterministic name for test-biz);
  // never flushdb() — E2E and integration suites own their own queues.
  {
    const { Queue: Q } = await import('bullmq');
    const q = new Q(`du-business-${MANIFEST.businessId}-${MANIFEST.version}`, {
      connection: { url: REDIS_URL },
    });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close().catch(() => undefined);
  }

  const reg = await http(baseUrl, `/api/runtime/v1/businesses/${MANIFEST.businessId}/versions/${MANIFEST.version}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
    body: MANIFEST,
  });
  expect([200, 201]).toContain(reg.status);
  await app.enableVersionForTest(MANIFEST.businessId, MANIFEST.version);
  queueName = (reg.body.queue as string) ?? `du-business-${MANIFEST.businessId}-${MANIFEST.version}`;
}, 120_000);

afterAll(async () => {
  await app?.close();
  if (isolationCtx && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
    const { Pool: AdminPool } = await import('pg');
    const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
    try {
      await adminPool.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
    } catch {
      // Ignore if already dropped
    } finally {
      await adminPool.end().catch(() => undefined);
    }
  }
  isolationCtx?.cleanupArtifactDir();
}, 30_000);

function rtHeaders(): Record<string, string> {
  return { authorization: `Bearer ${RUNTIME_TOKEN}` };
}
function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}` };
}
function pubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-api-key': RAW_API_KEY, ...extra };
}

function usageHeaders(): Record<string, string> {
  return { authorization: `Bearer ${USAGE_TOKEN}` };
}

async function findJobForOperation(
  operationId: string
): Promise<{ taskId: string; deliveryId: string }> {
  const q = app.getQueue(queueName) as Queue;
  const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
  const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId);
  expect(job).toBeDefined();
  const payload = job!.data as { taskId: string; deliveryId: string };
  return { taskId: payload.taskId, deliveryId: payload.deliveryId };
}

async function createUsageTarget(label: string): Promise<{ operationId: string; taskId: string }> {
  const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
    method: 'POST',
    headers: pubHeaders(),
    body: { input: { q: label } },
  });
  expect(submit.status).toBe(202);
  const operationId = submit.body.operationId as string;
  const operation = await app.db.query<{ root_task_id: string }>(
    'SELECT root_task_id FROM operations WHERE id=$1',
    [operationId]
  );
  return { operationId, taskId: operation.rows[0]!.root_task_id };
}

function usageEvent(
  target: { operationId: string; taskId: string },
  overrides: Partial<{
    eventId: string;
    invocationId: string;
    units: { inputTokens: number; outputTokens: number; pages?: number };
    costMicrousd: number;
    measurement: 'measured' | 'estimated';
    occurredAt: string;
  }> = {}
) {
  return {
    eventId: overrides.eventId ?? `usage-${randomUUID()}`,
    invocationId: overrides.invocationId ?? `invocation-${randomUUID()}`,
    operationId: target.operationId,
    taskId: target.taskId,
    units: overrides.units ?? { inputTokens: 3, outputTokens: 2 },
    costMicrousd: overrides.costMicrousd ?? 11,
    currency: 'USD' as const,
    measurement: overrides.measurement ?? ('measured' as const),
    occurredAt: overrides.occurredAt ?? new Date().toISOString(),
  };
}

describe('runtime vertical slice (isolated PG/Redis)', () => {
  test('submit → outbox → dispatch → claim → heartbeat → checkpoint → complete → result', async () => {
    const idemKey = `idem-${randomUUID()}`;
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders({ 'idempotency-key': idemKey }),
      body: { input: { q: 'hello slice' } },
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    expect(operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(submit.body.correlationId).toBeDefined();

    // Poll operation GET
    const got = await http(baseUrl, `/api/v1/operations/${operationId}`, {
      headers: pubHeaders(),
    });
    expect(got.status).toBe(200);
    expect(got.body.id).toBe(operationId);

    // List envelope is { items, nextCursor }
    const list = await http(baseUrl, `/api/v1/operations?limit=5`, { headers: pubHeaders() });
    expect(list.status).toBe(200);
    expect(Array.isArray(list.body.items)).toBe(true);
    expect(list.body.nextCursor).toBeNull();

    // Outbox row exists; dispatch publishes to BullMQ with stable jobId
    const dispatched = await app.dispatcher.dispatchOnce();
    expect(dispatched).toBeGreaterThanOrEqual(1);

    const q = app.getQueue(queueName) as Queue;
    // Find the job for this operation (at-least-once: may have older jobs)
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId);
    expect(job).toBeDefined();
    const payload = job!.data as Record<string, unknown>;
    expect(payload.contractVersion).toBe('1');
    expect(payload.taskId).toBeDefined();
    expect(payload.correlationId).toBeDefined();
    const taskId = payload.taskId as string;
    const deliveryId = payload.deliveryId as string;

    // Idempotent dispatch: a second sweep must not re-enqueue THIS delivery.
    // (The sweeper is global by design for HA: it may legitimately dispatch
    // another suite's pending rows on shared infra, so assert per-delivery
    // idempotency — exactly one queue job for this operation — not a global 0.)
    await app.dispatcher.dispatchOnce();
    const jobsAfter = await q.getJobs(['waiting', 'delayed', 'active']);
    const mineAfter = jobsAfter.filter((j) => (j.data as { operationId?: string }).operationId === operationId);
    expect(mineAfter.length).toBe(1);

    // Claim
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-1' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    expect(leaseEpoch).toBeGreaterThanOrEqual(1);
    expect(claim.body.taskId).toBe(taskId);

    // Heartbeat
    const hb = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/heartbeat`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch },
    });
    expect(hb.status).toBe(200);
    expect(hb.body.leaseExpiresAt).toBeDefined();

    // Stale heartbeat → 409 LEASE_LOST
    const staleHb = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/heartbeat`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: leaseEpoch - 1 },
    });
    expect(staleHb.status).toBe(409);
    expect((staleHb.body as { code?: string }).code).toBe('LEASE_LOST');

    // Checkpoint: first write 201, identical replay 200, different inputHash 409
    const inputHash = contentHash({ step: 1 });
    const ck1 = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/steps/step-a`, {
      method: 'PUT',
      headers: rtHeaders(),
      body: { leaseEpoch, inputHash, outputRef: 's3://bucket/out.json', status: 'SUCCEEDED' },
    });
    expect(ck1.status).toBe(201);
    expect(ck1.body.replayed).toBe(false);
    expect(ck1.body.stepKey).toBe('step-a');

    const ckReplay = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/steps/step-a`, {
      method: 'PUT',
      headers: rtHeaders(),
      body: { leaseEpoch, inputHash, outputRef: 's3://bucket/out.json', status: 'SUCCEEDED' },
    });
    expect(ckReplay.status).toBe(200);
    expect(ckReplay.body.replayed).toBe(true);

    const ckMismatch = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/steps/step-a`, {
      method: 'PUT',
      headers: rtHeaders(),
      body: { leaseEpoch, inputHash: contentHash({ step: 2 }), outputRef: 's3://bucket/other.json', status: 'SUCCEEDED' },
    });
    expect(ckMismatch.status).toBe(409);
    expect((ckMismatch.body as { code?: string }).code).toBe('INPUT_HASH_MISMATCH');

    // Result before completion → 409
    const preResult = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(preResult.status).toBe(409);

    // Complete (resultRef hashed with contentHash)
    const resultRef = 's3://bucket/result.json';
    const complete = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
    expect(complete.status).toBe(200);
    expect(complete.body.state).toBe('SUCCEEDED');

    // Idempotent complete replay
    const completeReplay = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
    expect(completeReplay.status).toBe(200);
    expect(completeReplay.body.replayed).toBe(true);

    // Result envelope now succeeds with required usage.measurement
    const result = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(result.status).toBe(200);
    expect(result.body.schemaVersion).toBe('1');
    expect((result.body.usage as { measurement?: string }).measurement).toBe('pending');
    expect((result.body.data as { resultRef?: string }).resultRef).toBe(resultRef);

    // Claim on terminal task → 410
    const terminalClaim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: `d2-${randomUUID()}`, workerInstanceId: 'worker-2' },
    });
    expect(terminalClaim.status).toBe(410);

    await q.remove(job!.id!);
  });

  test('idempotency: same key + same body replays, different body → 409', async () => {
    const key = `k-${randomUUID()}`;
    const body = { input: { q: 'idem-a' } };
    const first = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders({ 'idempotency-key': key }),
      body,
    });
    expect(first.status).toBe(202);
    const replay = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders({ 'idempotency-key': key }),
      body,
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.operationId).toBe(first.body.operationId);

    const conflict = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders({ 'idempotency-key': key }),
      body: { input: { q: 'different' } },
    });
    expect(conflict.status).toBe(409);
    expect((conflict.body as { code?: string }).code).toBe('IDEMPOTENCY_CONFLICT');
  });

  test('lease expiry allows reclaim by another worker', async () => {
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'lease-test' } },
    });
    expect(submit.status).toBe(202);
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === submit.body.operationId);
    expect(job).toBeDefined();
    const taskId = (job!.data as { taskId: string }).taskId;
    const deliveryId = (job!.data as { deliveryId: string }).deliveryId;

    const claim1 = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-A' },
    });
    expect(claim1.status).toBe(200);

    // Same delivery replay is idempotent, different worker with same delivery OK
    // But a different delivery while lease held → 409
    const busy = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: `other-${randomUUID()}`, workerInstanceId: 'worker-B' },
    });
    expect(busy.status).toBe(409);

    // Expire the lease, then reclaim with new delivery
    await app.db.query(`UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id=$1`, [taskId]);
    const reclaim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: `reclaim-${randomUUID()}`, workerInstanceId: 'worker-B' },
    });
    expect(reclaim.status).toBe(200);
    expect((reclaim.body.leaseEpoch as number)).toBeGreaterThan(claim1.body.leaseEpoch as number);

    await q.remove(job!.id!);
  });

  test('fail retryable enqueues continuation with future due_at; dispatch respects due_at', async () => {
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'retry-test' } },
    });
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === submit.body.operationId)!;
    const taskId = (job.data as { taskId: string }).taskId;
    const deliveryId = (job.data as { deliveryId: string }).deliveryId;
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-1' },
    });
    const leaseEpoch = claim.body.leaseEpoch as number;

    const fail = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/fail`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, errorCode: 'TRANSIENT', retryable: true, retryAfterMs: 60_000 },
    });
    expect(fail.status).toBe(200);
    expect(fail.body.state).toBe('RETRY_PENDING');

    // Outbox retry row is due in the future → not dispatched yet
    const pending = await app.db.query(
      `SELECT id, due_at, dispatched_at FROM outbox WHERE aggregate_id=$1::uuid AND type='task.dispatch' ORDER BY created_at DESC LIMIT 1`,
      [taskId]
    );
    expect(pending.rowCount).toBe(1);
    expect(pending.rows[0]!.dispatched_at).toBeNull();
    const dueAt = new Date(pending.rows[0]!.due_at as string).getTime();
    expect(dueAt).toBeGreaterThan(Date.now());

    // A sweep now must not dispatch this specific row (due in the future),
    // even though leftover rows from earlier tests may dispatch.
    await app.dispatcher.dispatchOnce();
    const stillPending = await app.db.query(`SELECT dispatched_at FROM outbox WHERE id=$1`, [pending.rows[0]!.id]);
    expect(stillPending.rows[0]!.dispatched_at).toBeNull();

    // Make it due and dispatch — row gets published, payload is BusinessJobV1
    await app.db.query(`UPDATE outbox SET due_at = now() - interval '1 second' WHERE id=$1`, [pending.rows[0]!.id]);
    await app.dispatcher.dispatchOnce();
    const nowDispatched = await app.db.query(`SELECT dispatched_at, attempts FROM outbox WHERE id=$1`, [pending.rows[0]!.id]);
    expect(nowDispatched.rows[0]!.dispatched_at).not.toBeNull();

    await q.remove(job.id!);
    // Clean up the retry job too (best-effort)
    const retryJobs = await q.getJobs(['waiting', 'delayed']);
    for (const j of retryJobs) {
      if ((j.data as { taskId?: string }).taskId === taskId && j.id !== job.id) await q.remove(j.id!);
    }
  });

  test('input validation returns 422 on bad submission', async () => {
    const bad = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: '' } },
    });
    expect(bad.status).toBe(422);
  });

  test('runtime auth rejects missing token', async () => {
    // Use the real queue task from a fresh submit to test auth path
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'auth-test' } },
    });
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === submit.body.operationId)!;
    const taskId = (job.data as { taskId: string }).taskId;
    const noAuth = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      // no auth header
      body: { deliveryId: 'x', workerInstanceId: 'w' },
    });
    expect(noAuth.status).toBe(401);
    await q.remove(job.id!);
  });

  test('usage ingest accepts the Connector single-event shape with dedicated auth', async () => {
    const target = await createUsageTarget('usage-single');
    const event = usageEvent(target);

    const missing = await http(baseUrl, '/api/runtime/v1/usage-events', {
      method: 'POST',
      body: event,
    });
    expect(missing.status).toBe(401);
    expect(missing.headers['content-type']).toContain('application/problem+json');

    const wrongIdentity = await http(baseUrl, '/api/runtime/v1/usage-events', {
      method: 'POST',
      headers: rtHeaders(),
      body: event,
    });
    expect(wrongIdentity.status).toBe(403);
    expect(wrongIdentity.body.code).toBe('PERMISSION_DENIED');

    const accepted = await http(baseUrl, '/api/runtime/v1/usage-events', {
      method: 'POST',
      headers: usageHeaders(),
      body: event,
    });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toEqual({ accepted: [event.eventId], duplicates: [] });
  });

  test('usage batch projects totals and identical replay is a duplicate', async () => {
    const target = await createUsageTarget('usage-batch');
    const measured = usageEvent(target, {
      units: { inputTokens: 12, outputTokens: 5, pages: 2 },
      costMicrousd: 101,
    });
    const estimated = usageEvent(target, {
      units: { inputTokens: 8, outputTokens: 7 },
      costMicrousd: 49,
      measurement: 'estimated',
    });
    const batch = await http(baseUrl, '/api/runtime/v1/usage-events', {
      method: 'POST',
      headers: usageHeaders(),
      body: { events: [measured, estimated] },
    });
    expect(batch.status).toBe(200);
    expect(batch.body).toEqual({
      accepted: [measured.eventId, estimated.eventId].sort(),
      duplicates: [],
    });

    const replay = await http(baseUrl, '/api/runtime/v1/usage-events', {
      method: 'POST',
      headers: usageHeaders(),
      body: measured,
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual({ accepted: [], duplicates: [measured.eventId] });

    await app.db.query("UPDATE operations SET state='SUCCEEDED', result_ref='s3://usage/batch' WHERE id=$1", [
      target.operationId,
    ]);
    const result = await http(baseUrl, `/api/v1/operations/${target.operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(result.status).toBe(200);
    expect(result.body.usage).toEqual({
      inputTokens: 20,
      outputTokens: 12,
      costMicrousd: 150,
      measurement: 'estimated',
    });
  });

  test('same usage event ID with a conflicting payload returns 409 without changing totals', async () => {
    const target = await createUsageTarget('usage-conflict');
    const event = usageEvent(target, { costMicrousd: 17 });
    const first = await http(baseUrl, '/api/runtime/v1/usage-events', {
      method: 'POST',
      headers: usageHeaders(),
      body: event,
    });
    expect(first.status).toBe(200);

    const conflict = await http(baseUrl, '/api/runtime/v1/usage-events', {
      method: 'POST',
      headers: usageHeaders(),
      body: { ...event, costMicrousd: 18 },
    });
    expect(conflict.status).toBe(409);
    expect(conflict.body.code).toBe('IDEMPOTENCY_CONFLICT');

    const stored = await app.db.query<{ count: string; cost: string }>(
      `SELECT count(*)::text AS count,
              sum((payload->>'costMicrousd')::numeric)::text AS cost
       FROM usage_events WHERE operation_id=$1`,
      [target.operationId]
    );
    expect(stored.rows[0]).toMatchObject({ count: '1', cost: '17' });
  });

  test('usage task must belong to the supplied operation and a rejected batch is atomic', async () => {
    const firstTarget = await createUsageTarget('usage-binding-a');
    const secondTarget = await createUsageTarget('usage-binding-b');
    const valid = usageEvent(firstTarget);
    const mismatched = {
      ...usageEvent(firstTarget),
      taskId: secondTarget.taskId,
    };
    const rejected = await http(baseUrl, '/api/runtime/v1/usage-events', {
      method: 'POST',
      headers: usageHeaders(),
      body: { events: [valid, mismatched] },
    });
    expect(rejected.status).toBe(422);
    expect(rejected.body.code).toBe('INVALID_ARGUMENT');

    const persisted = await app.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM usage_events WHERE event_id = ANY($1::text[])',
      [[valid.eventId, mismatched.eventId]]
    );
    expect(persisted.rows[0]!.count).toBe('0');
  });

  test('usage arriving after terminal completion is reflected in the result', async () => {
    const target = await createUsageTarget('usage-late');
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((candidate) =>
      (candidate.data as { operationId?: string }).operationId === target.operationId
    );
    expect(job).toBeDefined();
    const deliveryId = (job!.data as { deliveryId: string }).deliveryId;
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${target.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'usage-late-worker' },
    });
    expect(claim.status).toBe(200);
    const resultRef = 's3://usage/late-result';
    const complete = await http(baseUrl, `/api/runtime/v1/tasks/${target.taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: {
        leaseEpoch: claim.body.leaseEpoch,
        resultRef,
        resultHash: contentHash(resultRef),
      },
    });
    expect(complete.status).toBe(200);

    const lateEvent = usageEvent(target, {
      units: { inputTokens: 21, outputTokens: 13 },
      costMicrousd: 345,
    });
    const ingest = await http(baseUrl, '/api/runtime/v1/usage-events', {
      method: 'POST',
      headers: usageHeaders(),
      body: lateEvent,
    });
    expect(ingest.status).toBe(200);

    const result = await http(baseUrl, `/api/v1/operations/${target.operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(result.status).toBe(200);
    expect(result.body.usage).toEqual({
      inputTokens: 21,
      outputTokens: 13,
      costMicrousd: 345,
      measurement: 'measured',
    });
    await q.remove(job!.id!);
  });

  test('cancel is tenant-scoped, idempotent, and terminals the task', async () => {
    const target = await createUsageTarget('cancel-flow');
    const first = await http(baseUrl, `/api/v1/operations/${target.operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
    });
    expect(first.status).toBe(202);
    expect(first.body).toMatchObject({ operationId: target.operationId, state: 'CANCELLED', replayed: false });

    const op = await http(baseUrl, `/api/v1/operations/${target.operationId}`, { headers: pubHeaders() });
    expect(op.status).toBe(200);
    expect(op.body.state).toBe('CANCELLED');

    const task = await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [target.taskId]);
    expect(task.rows[0]!.state).toBe('CANCELLED');

    // Replay against a terminal operation returns the terminal state with replayed=true.
    const replay = await http(baseUrl, `/api/v1/operations/${target.operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
    });
    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({ operationId: target.operationId, state: 'CANCELLED', replayed: true });
  });

  test('cancel of an unknown operation returns 404', async () => {
    const res = await http(baseUrl, `/api/v1/operations/${randomUUID()}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('deadline sweeper times out past-due operations and cancels their tasks', async () => {
    const target = await createUsageTarget('deadline-sweep');
    await app.db.query('UPDATE operations SET deadline_at = now() - interval \'1 minute\' WHERE id=$1', [
      target.operationId,
    ]);
    const sweep = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(sweep.status).toBe(200);
    expect(sweep.body.timedOut).toBeGreaterThanOrEqual(1);

    const op = await app.db.query<{ state: string }>('SELECT state FROM operations WHERE id=$1', [
      target.operationId,
    ]);
    expect(op.rows[0]!.state).toBe('TIMED_OUT');
    const task = await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [target.taskId]);
    expect(task.rows[0]!.state).toBe('CANCELLED');

    // A second sweep finds nothing left to time out (no re-processing).
    const again = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(again.status).toBe(200);
    expect(again.body.timedOut).toBe(0);
  });

  test('deadline sweeper ignores operations whose deadline is in the future', async () => {
    const target = await createUsageTarget('deadline-future');
    await app.db.query('UPDATE operations SET deadline_at = now() + interval \'1 hour\' WHERE id=$1', [
      target.operationId,
    ]);
    const sweep = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(sweep.status).toBe(200);
    const op = await app.db.query<{ state: string }>('SELECT state FROM operations WHERE id=$1', [
      target.operationId,
    ]);
    expect(op.rows[0]!.state).not.toBe('TIMED_OUT');
  });

  test('cancel and sweep-deadlines reject missing auth', async () => {
    const target = await createUsageTarget('cancel-auth');
    const noKey = await http(baseUrl, `/api/v1/operations/${target.operationId}/cancel`, { method: 'POST' });
    expect(noKey.status).toBe(401);

    const noAdmin = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', { method: 'POST' });
    expect(noAdmin.status).toBe(401);
  });

  test('R08-01: unknown and revoked API keys are denied fail-closed', async () => {
    const unknown = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: { 'x-api-key': `du_unknown_${randomUUID().replace(/-/g, '')}` },
      body: { input: { q: 'unknown key' } },
    });
    expect(unknown.status).toBe(401);

    // Revoke the suite's seeded key: the same raw key must then be denied.
    await app.db.query('UPDATE api_keys SET status=$2 WHERE hash=$1', [hashKey(RAW_API_KEY), 'REVOKED']);
    const revoked = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'revoked key' } },
    });
    expect(revoked.status).toBe(401);
    // Restore for the remaining suites in this file (same process, same key).
    await app.db.query('UPDATE api_keys SET status=$2 WHERE hash=$1', [hashKey(RAW_API_KEY), 'ACTIVE']);
  });

  test('R08-01: admin and runtime credentials cannot substitute for each other', async () => {
    // Runtime token on an admin route is rejected.
    const runtimeOnAdmin = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: rtHeaders(),
    });
    expect(runtimeOnAdmin.status).toBe(401);

    // The public x-api-key header grants no admin access.
    const apiKeyOnAdmin = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: pubHeaders(),
    });
    expect(apiKeyOnAdmin.status).toBe(401);

    // The admin token grants no runtime access.
    const target = await createUsageTarget('admin-no-runtime');
    const adminOnRuntime = await http(baseUrl, `/api/runtime/v1/tasks/${target.taskId}/heartbeat`, {
      method: 'POST',
      headers: adminHeaders(),
      body: { leaseEpoch: 0 },
    });
    expect(adminOnRuntime.status).toBe(401);

    // Cross-tenant isolation: a key from another tenant cannot see this operation.
    const otherTenant = randomUUID();
    await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1, 'other-suite') ON CONFLICT (id) DO NOTHING`, [
      otherTenant,
    ]);
    const otherRaw = `du_other_${randomUUID().replace(/-/g, '')}`;
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'other','ACTIVE') ON CONFLICT (hash) DO NOTHING`,
      [randomUUID(), otherTenant, hashKey(otherRaw)]
    );
    const cross = await http(baseUrl, `/api/v1/operations/${target.operationId}`, {
      headers: { 'x-api-key': otherRaw },
    });
    expect(cross.status).toBe(404);
  });

  test('R08-01/W11-C1: unsafe credential configuration is rejected, not silently weakened', async () => {
    // Equal admin/runtime tokens collapse role separation to a single secret:
    // the server must refuse to boot this configuration rather than imply
    // the two roles are separated by field name alone.
    const { createApp: createUnsafeApp } = await import('../src/server');
    await expect(
      createUnsafeApp({
        port: 0,
        databaseUrl: DATABASE_URL,
        redisUrl: REDIS_URL,
        runtimeToken: 'same-secret-both-roles',
        adminToken: 'same-secret-both-roles',
        autoDispatch: false,
      })
    ).rejects.toThrow(/adminToken and runtimeToken must be distinct/);

    // Missing runtime token closes runtime endpoints fail-closed instead of
    // leaving them open (the old slice defaulted to open when unconfigured).
    const closedApp = await createUnsafeApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      adminToken: `closed-admin-${randomUUID()}`,
      autoDispatch: false,
    });
    try {
      const closedServer = await closedApp.listen();
      const closedAddr = closedServer.address() as { port: number };
      const closedBase = `http://127.0.0.1:${closedAddr.port}`;
      const target = await createUsageTarget('closed-runtime-config');
      const closed = await http(closedBase, `/api/runtime/v1/tasks/${target.taskId}/heartbeat`, {
        method: 'POST',
        headers: { authorization: 'Bearer anything' },
        body: { leaseEpoch: 0 },
      });
      expect(closed.status).toBe(401);
    } finally {
      await closedApp.close({ timeoutMs: 100 });
    }
  });

  test('R08-02/W11-C1: invocation grants carry stable identity, replay the same ID, and conflict on differing hash', async () => {
    const target = await createUsageTarget('stable-grant');
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(target.operationId);
    const taskId = job.taskId as string;

    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: 'grant-worker' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    const opId = claim.body.operationId as string;

    const wireHash = hashInvocationInput({
      contractVersion: '1',
      tenantId: TENANT_ID,
      operationId: opId,
      taskId,
      stepKey: 'connector-inference',
      bindingSlot: 'reasoning',
      input: { prompt: 'classify' },
      options: {},
      sessionRef: null,
      deadlineAt: '2026-09-21T12:00:00.000Z',
    });
    async function issueGrant(inputHash: string) {
      return http(baseUrl, `/api/runtime/v1/tasks/${taskId}/invocation-grants`, {
        method: 'POST',
        headers: rtHeaders(),
        body: { leaseEpoch, stepKey: 'connector-inference', bindingSlot: 'reasoning', inputHash },
      });
    }

    // First issuance: deterministic UUID identity, pinned connector binding.
    const first = await issueGrant(wireHash);
    expect(first.status).toBe(201);
    const firstId = first.body.invocationId as string;
    expect(firstId).toMatch(/^[0-9a-f-]{36}$/);
    expect(first.body.connectorId).toBe('test-connector');
    expect(first.body.connectorRevision).toBe(3);
    const signed = JSON.parse(Buffer.from((first.body.grant as string).split('.')[1]!, 'base64url').toString('utf8')) as {
      inputHash: string;
      invocationId: string;
      taskId: string;
      bindingSlot: string;
    };
    expect(signed.inputHash).toBe(wireHash);
    expect(signed.invocationId).toBe(firstId);
    expect(signed.taskId).toBe(taskId);
    expect(signed.bindingSlot).toBe('reasoning');

    // Replay with the same logical key: the SAME identity, no new row.
    const replay = await issueGrant(wireHash);
    expect(replay.status).toBe(201);
    expect(replay.body.invocationId).toBe(firstId);
    const rows = await app.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM invocation_grants WHERE task_id=$1 AND step_key=$2',
      [taskId, 'connector-inference']
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);

    // Conflicting input for the same (task, step, slot): 409, never a fresh ID.
    const otherHash = hashInvocationInput({
      contractVersion: '1',
      tenantId: TENANT_ID,
      operationId: opId,
      taskId,
      stepKey: 'connector-inference',
      bindingSlot: 'reasoning',
      input: { prompt: 'different' },
      options: {},
      sessionRef: null,
      deadlineAt: '2026-09-21T12:00:00.000Z',
    });
    const mismatch = await issueGrant(otherHash);
    expect(mismatch.status).toBe(409);
    expect(mismatch.body.code).toBe('INPUT_HASH_MISMATCH');

    // Undeclared slot against the pinned manifest: 409 BINDING_DENIED.
    const badSlot = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/invocation-grants`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, stepKey: 'connector-inference', bindingSlot: 'undeclared-slot', inputHash: wireHash },
    });
    expect(badSlot.status).toBe(409);
    expect(badSlot.body.code).toBe('BINDING_DENIED');

    // Stale lease: 409 LEASE_LOST.
    const stale = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/invocation-grants`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: leaseEpoch + 99, stepKey: 'connector-inference', bindingSlot: 'reasoning', inputHash: wireHash },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('LEASE_LOST');

    // Non-RUNNING task (complete it first): 409 STATE_CONFLICT.
    const resultRef = `grant://done/${target.operationId}`;
    const done = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
    expect(done.status).toBe(200);
    const afterTerminal = await issueGrant(wireHash);
    expect(afterTerminal.status).toBe(409);
    expect(afterTerminal.body.code).toBe('STATE_CONFLICT');
  });

  test('W12-C: expired lease cannot mint a grant even before sweep/reclaim', async () => {
    const target = await createUsageTarget('expired-lease-grant');
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(target.operationId);
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: 'expiry-worker' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    const opId = claim.body.operationId as string;
    // Age the lease out without sweeping: the row still holds our epoch, but
    // the timestamp is in the past — issuance must fail closed.
    await app.db.query("UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id=$1", [job.taskId]);
    const expired = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/invocation-grants`, {
      method: 'POST',
      headers: rtHeaders(),
      body: {
        leaseEpoch,
        stepKey: 'connector-inference',
        bindingSlot: 'reasoning',
        inputHash: hashInvocationInput({
          contractVersion: '1',
          tenantId: TENANT_ID,
          operationId: opId,
          taskId: job.taskId,
          stepKey: 'connector-inference',
          bindingSlot: 'reasoning',
          input: { prompt: 'classify' },
          options: {},
          sessionRef: null,
          deadlineAt: '2026-09-21T12:00:00.000Z',
        }),
      },
    });
    expect(expired.status).toBe(409);
    expect(expired.body.code).toBe('LEASE_LOST');
  });

  test('W12-C: concurrent identical grant requests converge on one identity and one row', async () => {
    const target = await createUsageTarget('concurrent-grant');
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(target.operationId);
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: 'race-worker' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    const opId = claim.body.operationId as string;
    const wireHash = hashInvocationInput({
      contractVersion: '1',
      tenantId: TENANT_ID,
      operationId: opId,
      taskId: job.taskId,
      stepKey: 'connector-inference',
      bindingSlot: 'reasoning',
      input: { prompt: 'classify' },
      options: {},
      sessionRef: null,
      deadlineAt: '2026-09-21T12:00:00.000Z',
    });
    const attempts = await Promise.all(
      Array.from({ length: 8 }, () =>
        http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/invocation-grants`, {
          method: 'POST',
          headers: rtHeaders(),
          body: { leaseEpoch, stepKey: 'connector-inference', bindingSlot: 'reasoning', inputHash: wireHash },
        })
      )
    );
    const ok = attempts.filter((r) => r.status === 201);
    // At least one wins; every winner carries the SAME invocationId and only
    // one ledger row exists for the logical key.
    expect(ok.length).toBeGreaterThanOrEqual(1);
    const ids = new Set(ok.map((r) => r.body.invocationId as string));
    expect(ids.size).toBe(1);
    const rows = await app.db.query<{ n: string }>(
      'SELECT count(*) AS n FROM invocation_grants WHERE task_id=$1 AND step_key=$2',
      [job.taskId, 'connector-inference']
    );
    expect(Number(rows.rows[0]!.n)).toBe(1);
  });

  test('W12-C: an action declaring no connector slots grants no slot (fail closed)', async () => {
    // Register a slotless action on the same enabled manifest, then prove ANY
    // requested binding is denied.
    const reg = await app.db.query<{ manifest: { actions: Array<{ name: string; connectorSlots: unknown[] }> } }>(
      'SELECT manifest FROM business_versions WHERE business_id=$1 AND version=$2',
      [MANIFEST.businessId, MANIFEST.version]
    );
    const manifest = reg.rows[0]!.manifest;
    const slotlessName = 'slotless-action';
    if (!manifest.actions.some((a) => a.name === slotlessName)) {
      manifest.actions.push({ ...(manifest.actions[0] as object), name: slotlessName, connectorSlots: [] });
      await app.db.query('UPDATE business_versions SET manifest=$1 WHERE business_id=$2 AND version=$3', [
        JSON.stringify(manifest),
        MANIFEST.businessId,
        MANIFEST.version,
      ]);
    }
    const target = await createUsageTarget('slotless-grant');
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(target.operationId);
    // Retarget the task's action to the slotless action (same enabled version).
    await app.db.query('UPDATE operations SET action=$2 WHERE id=$1', [target.operationId, slotlessName]);
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: 'slotless-worker' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    const opId = claim.body.operationId as string;
    const denied = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/invocation-grants`, {
      method: 'POST',
      headers: rtHeaders(),
      body: {
        leaseEpoch,
        stepKey: 'connector-inference',
        bindingSlot: 'reasoning',
        inputHash: hashInvocationInput({
          contractVersion: '1',
          tenantId: TENANT_ID,
          operationId: opId,
          taskId: job.taskId,
          stepKey: 'connector-inference',
          bindingSlot: 'reasoning',
          input: { prompt: 'classify' },
          deadlineAt: '2026-09-21T12:00:00.000Z',
        }),
      },
    });
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('BINDING_DENIED');
  });

  /* ---------------- W13-C profile-bound grants (P2-02/R08-02) ---------------- */

  async function createProfileApiKey(): Promise<{ raw: string; id: string }> {
    const raw = 'du_test_' + randomUUID().replace(/-/g, '');
    const res = await app.db.query<{ id: string }>(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'test','ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE' RETURNING id`,
      [randomUUID(), TENANT_ID, hashKey(raw)]
    );
    return { raw, id: res.rows[0]!.id };
  }

  async function createProfileBinding(
    rawKey: string,
    opts: { profileId?: string; action?: string; connectorBindings?: unknown } = {}
  ): Promise<{ profileId: string; revision: number }> {
    const res = await http(baseUrl, '/api/v1/admin/profile-bindings', {
      method: 'POST',
      headers: adminHeaders(),
      body: {
        ...(opts.profileId ? { profileId: opts.profileId } : {}),
        apiKey: rawKey,
        businessId: MANIFEST.businessId,
        businessVersion: MANIFEST.version,
        action: opts.action ?? 'extract',
        connectorBindings: opts.connectorBindings ?? { reasoning: { connectorId: 'pin-conn', revision: 7 } },
      },
    });
    expect(res.status).toBe(201);
    return res.body as { profileId: string; revision: number };
  }

  async function submitAsKey(rawKey: string, action: string, input: unknown) {
    return http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/${action}`, {
      method: 'POST',
      headers: { 'x-api-key': rawKey },
      body: { input },
    });
  }

  async function claimOperation(operationId: string, worker: string) {
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(operationId);
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: worker },
    });
    expect(claim.status).toBe(200);
    const snapshot = claim.body.executionSnapshot as {
      pinned: { profileRevision: number; connectorBindings: Record<string, string> };
    };
    return {
      taskId: job.taskId,
      leaseEpoch: claim.body.leaseEpoch as number,
      operationId: claim.body.operationId as string,
      pinned: snapshot.pinned,
    };
  }

  function profileWireHash(operationId: string, taskId: string, bindingSlot: string, input: unknown) {
    return hashInvocationInput({
      contractVersion: '1',
      tenantId: TENANT_ID,
      operationId,
      taskId,
      stepKey: 'connector-inference',
      bindingSlot,
      input,
      options: {},
      sessionRef: null,
      deadlineAt: '2026-09-21T12:00:00.000Z',
    });
  }

  async function issuePinnedGrant(taskId: string, leaseEpoch: number, operationId: string, bindingSlot: string) {
    return http(baseUrl, `/api/runtime/v1/tasks/${taskId}/invocation-grants`, {
      method: 'POST',
      headers: rtHeaders(),
      body: {
        leaseEpoch,
        stepKey: 'connector-inference',
        bindingSlot,
        inputHash: profileWireHash(operationId, taskId, bindingSlot, { prompt: 'classify' }),
      },
    });
  }

  test('W13-C/PRF-01: profile-mode key submitting an unauthorized action gets 403 and nothing is enqueued', async () => {
    const { raw, id: keyId } = await createProfileApiKey();
    await createProfileBinding(raw, { action: 'other-action' });
    const denied = await submitAsKey(raw, 'extract', { q: 'blocked' });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    // Rejected before any write: no operation row exists for this key.
    const ops = await app.db.query('SELECT id FROM operations WHERE api_key_id=$1', [keyId]);
    expect(ops.rowCount).toBe(0);
  });

  test('W13-C: pinned operations grant the pinned connector, and claims carry the pin', async () => {
    const { raw } = await createProfileApiKey();
    const binding = await createProfileBinding(raw);
    expect(binding.revision).toBe(1);

    const submit = await submitAsKey(raw, 'extract', { q: 'pinned grant' });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;

    const claimed = await claimOperation(operationId, 'pin-worker');
    expect(claimed.pinned.profileRevision).toBe(1);
    expect(claimed.pinned.connectorBindings).toEqual({ reasoning: 'pin-conn@7' });

    const grant = await issuePinnedGrant(claimed.taskId, claimed.leaseEpoch, operationId, 'reasoning');
    expect(grant.status).toBe(201);
    // Pinned identity — NOT the deployment opts (test-connector/3).
    expect(grant.body.connectorId).toBe('pin-conn');
    expect(grant.body.connectorRevision).toBe(7);
    const claims = JSON.parse(
      Buffer.from((grant.body.grant as string).split('.')[1]!, 'base64url').toString('utf8')
    ) as { connectorId: string; connectorRevision: number };
    expect(claims.connectorId).toBe('pin-conn');
    expect(claims.connectorRevision).toBe(7);
    const stored = await app.db.query<{ connector_id: string; connector_revision: number }>(
      'SELECT connector_id, connector_revision FROM invocation_grants WHERE task_id=$1',
      [claimed.taskId]
    );
    expect(stored.rows[0]).toMatchObject({ connector_id: 'pin-conn', connector_revision: 7 });
  });

  test('W13-C/PRF-02: a revision change mid-operation keeps the in-flight pin; new submissions pin the new revision', async () => {
    const { raw } = await createProfileApiKey();
    const rev1 = await createProfileBinding(raw);
    const submitA = await submitAsKey(raw, 'extract', { q: 'in flight' });
    expect(submitA.status).toBe(202);
    const opA = submitA.body.operationId as string;
    const claimedA = await claimOperation(opA, 'rev-worker');

    // The revision change lands AFTER op A was submitted and claimed.
    const rev2 = await createProfileBinding(raw, {
      profileId: rev1.profileId,
      connectorBindings: { reasoning: { connectorId: 'pin-conn-2', revision: 9 } },
    });
    expect(rev2.revision).toBe(2);

    // In-flight op A still grants the OLD pin.
    const grantA = await issuePinnedGrant(claimedA.taskId, claimedA.leaseEpoch, opA, 'reasoning');
    expect(grantA.status).toBe(201);
    expect(grantA.body.connectorId).toBe('pin-conn');
    expect(grantA.body.connectorRevision).toBe(7);

    // A new submission pins the NEW revision.
    const submitB = await submitAsKey(raw, 'extract', { q: 'after revision' });
    expect(submitB.status).toBe(202);
    const claimedB = await claimOperation(submitB.body.operationId as string, 'rev-worker-2');
    expect(claimedB.pinned.profileRevision).toBe(2);
    expect(claimedB.pinned.connectorBindings).toEqual({ reasoning: 'pin-conn-2@9' });
  });

  test('W13-C: a manifest-declared slot missing from the operation pin is denied (BINDING_DENIED)', async () => {
    // Idempotent second-slot fixture (same pattern as the W12-C slotless test).
    const reg = await app.db.query<{
      manifest: { actions: Array<{ name: string; connectorSlots: Array<{ name: string }> }> };
    }>('SELECT manifest FROM business_versions WHERE business_id=$1 AND version=$2', [
      MANIFEST.businessId,
      MANIFEST.version,
    ]);
    const manifest = reg.rows[0]!.manifest;
    const extract = manifest.actions.find((a) => a.name === 'extract')!;
    if (!extract.connectorSlots.some((s) => s.name === 'embeddings')) {
      extract.connectorSlots.push({ name: 'embeddings' });
      await app.db.query('UPDATE business_versions SET manifest=$1 WHERE business_id=$2 AND version=$3', [
        JSON.stringify(manifest),
        MANIFEST.businessId,
        MANIFEST.version,
      ]);
    }
    const { raw } = await createProfileApiKey();
    await createProfileBinding(raw); // pins `reasoning` only
    const submit = await submitAsKey(raw, 'extract', { q: 'pin confined' });
    expect(submit.status).toBe(202);
    const claimed = await claimOperation(submit.body.operationId as string, 'pin-confine-worker');
    // Declared by the manifest but absent from the operation pin → 409.
    const denied = await issuePinnedGrant(claimed.taskId, claimed.leaseEpoch, claimed.operationId, 'embeddings');
    expect(denied.status).toBe(409);
    expect(denied.body.code).toBe('BINDING_DENIED');
  });

  /* ---------------- W13-C item 4: typed continuation (RUN-05/RUN-06) ---------------- */

  const CONT_INPUT_SCHEMA = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  };

  /** Submit + dispatch + claim the root task; returns claimed RUNNING root. */
  async function claimRoot(label: string, worker: string) {
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: label } },
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(operationId);
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: worker },
    });
    expect(claim.status).toBe(200);
    return { operationId, taskId: job.taskId, leaseEpoch: claim.body.leaseEpoch as number };
  }

  function childSpecs(n: number, opts: { kind?: string; hashOverride?: string } = {}) {
    return Array.from({ length: n }, (_, i) => {
      const payloadRef = { shard: i, q: 'fan' };
      return {
        taskKey: `shard-${i}`,
        kind: opts.kind ?? 'root',
        payloadRef,
        payloadHash: opts.hashOverride ?? contentHash(payloadRef),
      };
    });
  }

  async function spawn(taskId: string, leaseEpoch: number, children: unknown[], continuationRef = 'cont-1') {
    return http(baseUrl, `/api/runtime/v1/tasks/${taskId}/children`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, children, joinPolicy: 'all-success', continuationRef },
    });
  }

  async function complete(taskId: string, leaseEpoch: number, resultRef = 'ref://child-out') {
    return http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
  }

  async function getOpState(operationId: string): Promise<{ state: string; stateVersion: number }> {
    const got = await http(baseUrl, `/api/v1/operations/${operationId}`, { headers: pubHeaders() });
    expect(got.status).toBe(200);
    return { state: got.body.state as string, stateVersion: got.body.stateVersion as number };
  }

  test('W13-C/children: spawn → WAITING_CHILDREN → GET children → join completes exactly once', async () => {
    const root = await claimRoot('fanout-ok', 'fan-worker');
    const res = await spawn(root.taskId, root.leaseEpoch, childSpecs(2));
    expect(res.status).toBe(202);
    expect(res.body.parentState).toBe('WAITING_CHILDREN');
    const childIds = res.body.childTaskIds as string[];
    expect(childIds).toHaveLength(2);

    // Idempotent replay: same keys + same hashes replays the same children.
    const replay = await spawn(root.taskId, root.leaseEpoch, childSpecs(2));
    expect(replay.status).toBe(202);
    expect(replay.body.childTaskIds).toEqual(childIds);

    const listed = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/children`, {
      headers: rtHeaders(),
    });
    expect(listed.status).toBe(200);
    expect((listed.body.children as unknown[])).toHaveLength(2);
    expect((listed.body.children as { taskKey: string }[]).map((c) => c.taskKey).sort()).toEqual([
      'shard-0',
      'shard-1',
    ]);

    const opMid = await getOpState(root.operationId);
    expect(opMid.state).toBe('WAITING_CHILDREN');

    // Claim + complete each child; the last completion closes the join.
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const byTask = new Map(jobs.map((j) => [(j.data as { taskId: string }).taskId, j.data as { deliveryId: string }]));
    for (const [idx, childId] of childIds.entries()) {
      const delivery = byTask.get(childId);
      expect(delivery).toBeDefined();
      const claim = await http(baseUrl, `/api/runtime/v1/tasks/${childId}/claim`, {
        method: 'POST',
        headers: rtHeaders(),
        body: { deliveryId: (delivery as { deliveryId: string }).deliveryId, workerInstanceId: `child-w-${idx}` },
      });
      expect(claim.status).toBe(200);
      const done = await complete(childId, claim.body.leaseEpoch as number, `ref://shard-${idx}`);
      expect(done.status).toBe(200);
      if (idx === 0) {
        expect(done.body.state).toBe('SUCCEEDED');
        // Child 0's claim put work in flight, so the shared operation reads
        // RUNNING — but the join itself rides on the PARENT TASK, which must
        // still be WAITING_CHILDREN with the join open.
        expect(done.body.operationState).toBe('RUNNING');
        const parentMid = await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [
          root.taskId,
        ]);
        expect(parentMid.rows[0]!.state).toBe('WAITING_CHILDREN');
      } else {
        // Last child closes the join: parent continuation emitted.
        expect(done.body.operationState).toBe('QUEUED');
      }
    }

    const parentRow = await app.db.query<{ state: string; payload_ref: { joinSummary: Record<string, string> } }>(
      'SELECT state, payload_ref FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(parentRow.rows[0]!.state).toBe('QUEUED');
    expect(parentRow.rows[0]!.payload_ref.joinSummary).toMatchObject({
      'shard-0': 'ref://shard-0',
      'shard-1': 'ref://shard-1',
    });

    // Exactly one task.continuation outbox row for the parent.
    const cont = await app.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox
       WHERE aggregate_id=$1 AND type='task.continuation' AND delivery_id=$2`,
      [root.taskId, `${root.taskId}:join:2`]
    );
    expect(cont.rows[0]!.n).toBe('1');
  });

  test('W13-C/children: concurrent completions emit exactly one parent continuation', async () => {
    const root = await claimRoot('fanout-race', 'fan-race-worker');
    const res = await spawn(root.taskId, root.leaseEpoch, childSpecs(2));
    expect(res.status).toBe(202);
    const childIds = res.body.childTaskIds as string[];

    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const byTask = new Map(jobs.map((j) => [(j.data as { taskId: string }).taskId, j.data as { deliveryId: string }]));
    const epochs: number[] = [];
    for (const [idx, childId] of childIds.entries()) {
      const claim = await http(baseUrl, `/api/runtime/v1/tasks/${childId}/claim`, {
        method: 'POST',
        headers: rtHeaders(),
        body: {
          deliveryId: (byTask.get(childId) as { deliveryId: string }).deliveryId,
          workerInstanceId: `race-w-${idx}`,
        },
      });
      expect(claim.status).toBe(200);
      epochs.push(claim.body.leaseEpoch as number);
    }

    // Fire both completions concurrently: parent FOR UPDATE serializes the
    // two join reconciliations, so exactly one emits the continuation.
    const [doneA, doneB] = await Promise.all([
      complete(childIds[0]!, epochs[0]!, 'ref://race-0'),
      complete(childIds[1]!, epochs[1]!, 'ref://race-1'),
    ]);
    expect(doneA.status).toBe(200);
    expect(doneB.status).toBe(200);
    const states = [doneA.body.operationState, doneB.body.operationState].sort();
    expect(states).toContain('QUEUED');

    const parentRow = await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [root.taskId]);
    expect(parentRow.rows[0]!.state).toBe('QUEUED');
    const cont = await app.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox
       WHERE aggregate_id=$1 AND type='task.continuation' AND delivery_id=$2`,
      [root.taskId, `${root.taskId}:join:2`]
    );
    expect(cont.rows[0]!.n).toBe('1');
  });

  test('W13-C/children: one child failure fails the parent join and cancels siblings', async () => {
    const root = await claimRoot('fanout-fail', 'fan-fail-worker');
    const res = await spawn(root.taskId, root.leaseEpoch, childSpecs(2));
    expect(res.status).toBe(202);
    const childIds = res.body.childTaskIds as string[];

    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const byTask = new Map(jobs.map((j) => [(j.data as { taskId: string }).taskId, j.data as { deliveryId: string }]));
    const claim0 = await http(baseUrl, `/api/runtime/v1/tasks/${childIds[0]}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: (byTask.get(childIds[0]!) as { deliveryId: string }).deliveryId, workerInstanceId: 'ff-w-0' },
    });
    expect(claim0.status).toBe(200);
    const failed = await http(baseUrl, `/api/runtime/v1/tasks/${childIds[0]}/fail`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: claim0.body.leaseEpoch, errorCode: 'E_CHILD', retryable: false },
    });
    expect(failed.status).toBe(200);
    expect(failed.body.operationState).toBe('FAILED');

    const parentRow = await app.db.query<{ state: string; error_code: string }>(
      'SELECT state, error_code FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(parentRow.rows[0]).toMatchObject({ state: 'FAILED', error_code: 'JOIN_FAILED' });
    const sibRow = await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [childIds[1]]);
    expect(sibRow.rows[0]!.state).toBe('CANCELLED');
    const op = await getOpState(root.operationId);
    expect(op.state).toBe('FAILED');
  });

  test('W13-C/children: spawn rejects stale lease, unknown kind, overlap, and capacity', async () => {
    // Stale lease → 409 LEASE_LOST.
    const stale = await claimRoot('spawn-stale', 'spawn-stale-w');
    const badEpoch = await spawn(stale.taskId, stale.leaseEpoch + 99, childSpecs(1));
    expect(badEpoch.status).toBe(409);
    expect(badEpoch.body.code).toBe('LEASE_LOST');

    // Unknown child kind (fixture manifest only declares 'root') → 422.
    const badKind = await spawn(stale.taskId, stale.leaseEpoch, childSpecs(1, { kind: 'nope-kind' }));
    expect(badKind.status).toBe(422);
    expect(badKind.body.code).toBe('UNREGISTERED_HANDLER');

    // payloadHash mismatch → 422.
    const badHash = await spawn(stale.taskId, stale.leaseEpoch, childSpecs(1, { hashOverride: 'deadbeef' }));
    expect(badHash.status).toBe(422);

    // OK spawn of 1 child, then conflicting payload for an existing key →
    // 409 INPUT_HASH_MISMATCH.
    const first = await spawn(stale.taskId, stale.leaseEpoch, childSpecs(1));
    expect(first.status).toBe(202);
    const differentPayload = await spawn(stale.taskId, stale.leaseEpoch, [
      {
        taskKey: 'shard-0',
        kind: 'root',
        payloadRef: { shard: 999 },
        payloadHash: contentHash({ shard: 999 }),
      },
    ]);
    expect(differentPayload.status).toBe(409);
    expect(differentPayload.body.code).toBe('INPUT_HASH_MISMATCH');

    // Full identical retry while the parent waits replays (idempotent).
    const again = await spawn(stale.taskId, stale.leaseEpoch, childSpecs(1));
    expect(again.status).toBe(202);
    expect(again.body.childTaskIds).toEqual(first.body.childTaskIds);

    // A NEW child key while the parent is WAITING_CHILDREN (not RUNNING) → 409.
    const fresh = await spawn(stale.taskId, stale.leaseEpoch, [
      {
        taskKey: 'shard-9',
        kind: 'root',
        payloadRef: { shard: 9 },
        payloadHash: contentHash({ shard: 9 }),
      },
    ]);
    expect(fresh.status).toBe(409);
    expect(fresh.body.code).toBe('STATE_CONFLICT');

    // Capacity: fixture maxParallelTasks is 2; a fresh parent spawning 3 → 409 CAPACITY.
    const cap = await claimRoot('spawn-cap', 'spawn-cap-w');
    const over = await spawn(cap.taskId, cap.leaseEpoch, childSpecs(3));
    expect(over.status).toBe(409);
    expect(over.body.code).toBe('CAPACITY');
  });

  test('W13-C/children: spawn on a terminal task is 410 TASK_TERMINAL', async () => {
    const root = await claimRoot('spawn-terminal', 'spawn-term-w');
    const done = await complete(root.taskId, root.leaseEpoch, 'ref://root-done');
    expect(done.status).toBe(200);
    const res = await spawn(root.taskId, root.leaseEpoch, childSpecs(1));
    expect(res.status).toBe(410);
    expect(res.body.code).toBe('TASK_TERMINAL');
  });

  test('W13-C/wait+resume: wait opens WAITING_INPUT; resume validates, CAS-guards, and re-queues', async () => {
    const root = await claimRoot('human-ok', 'human-w');
    const wait = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch, waitKey: 'approval', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(wait.status).toBe(200);
    const waitId = wait.body.waitId as string;
    expect(waitId).toMatch(/^wait_/);

    // Same waitKey + identical schema replays the stored waitId.
    const waitReplay = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch, waitKey: 'approval', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(waitReplay.status).toBe(200);
    expect(waitReplay.body.waitId).toBe(waitId);

    const opWaiting = await getOpState(root.operationId);
    expect(opWaiting.state).toBe('WAITING_INPUT');

    // A second distinct waitKey while one is OPEN → 409.
    const second = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch, waitKey: 'other', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(second.status).toBe(409);

    // Stale CAS → 409.
    const staleCas = await http(baseUrl, `/api/v1/operations/${root.operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId, input: { answer: 'yes' }, expectedStateVersion: opWaiting.stateVersion - 1 },
    });
    expect(staleCas.status).toBe(409);

    // Invalid input vs the persisted schema → 422.
    const badInput = await http(baseUrl, `/api/v1/operations/${root.operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId, input: { answer: 42 }, expectedStateVersion: opWaiting.stateVersion },
    });
    expect(badInput.status).toBe(422);
    expect(badInput.body.code).toBe('INVALID_SCHEMA');

    // Valid resume → 202, task QUEUED with the resume input, operation bumped.
    const resume = await http(baseUrl, `/api/v1/operations/${root.operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId, input: { answer: 'yes' }, expectedStateVersion: opWaiting.stateVersion },
    });
    expect(resume.status).toBe(202);
    expect(resume.body.replayed).toBe(false);
    expect(resume.body.taskId).toBe(root.taskId);
    expect(resume.body.stateVersion).toBe(opWaiting.stateVersion + 1);

    const taskRow = await app.db.query<{ state: string; payload_ref: { resumeInput: unknown; waitId: string } }>(
      'SELECT state, payload_ref FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(taskRow.rows[0]!.state).toBe('QUEUED');
    expect(taskRow.rows[0]!.payload_ref.resumeInput).toEqual({ answer: 'yes' });
    expect(taskRow.rows[0]!.payload_ref.waitId).toBe(waitId);

    // Redelivery dispatch row for the resume exists.
    const redel = await app.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox
       WHERE aggregate_id=$1 AND type='task.dispatch' AND delivery_id=$2`,
      [root.taskId, `${root.taskId}:resume:${opWaiting.stateVersion + 1}`]
    );
    expect(redel.rows[0]!.n).toBe('1');

    // Replay of the same waitId → 200 replayed ack.
    const opAfter = await getOpState(root.operationId);
    const replayResume = await http(baseUrl, `/api/v1/operations/${root.operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId, input: { answer: 'yes' }, expectedStateVersion: opAfter.stateVersion },
    });
    expect(replayResume.status).toBe(200);
    expect(replayResume.body.replayed).toBe(true);

    // The resumed task is claimable again via dispatch.
    await app.dispatcher.dispatchOnce();
    const rejob = await findJobForOperation(root.operationId);
    expect(rejob.taskId).toBe(root.taskId);
  });

  test('W13-C/resume: unknown wait → 404, terminal operation → 409, cross-tenant → 404', async () => {
    const root = await claimRoot('human-edge', 'human-edge-w');
    const wait = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch, waitKey: 'approval', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(wait.status).toBe(200);
    const op = await getOpState(root.operationId);

    const unknown = await http(baseUrl, `/api/v1/operations/${root.operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId: 'wait_does-not-exist', input: { answer: 'x' }, expectedStateVersion: op.stateVersion },
    });
    expect(unknown.status).toBe(404);

    // Terminal operation (cancel) → 409 on resume.
    const cancel = await http(baseUrl, `/api/v1/operations/${root.operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: {},
    });
    expect(cancel.status).toBe(202);
    const opCancelled = await getOpState(root.operationId);
    const terminal = await http(baseUrl, `/api/v1/operations/${root.operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId: wait.body.waitId, input: { answer: 'x' }, expectedStateVersion: opCancelled.stateVersion },
    });
    expect(terminal.status).toBe(409);

    // Cross-tenant: a different tenant's key cannot see the operation.
    const otherRaw = 'du_test_' + randomUUID().replace(/-/g, '');
    await app.db.query(
      `INSERT INTO tenants (id, name) VALUES ('00000000-0000-0000-0000-000000000002','cross-tenant')
       ON CONFLICT (id) DO NOTHING`
    );
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'test','ACTIVE')`,
      [randomUUID(), '00000000-0000-0000-0000-000000000002', hashKey(otherRaw)]
    );
    const cross = await http(baseUrl, `/api/v1/operations/${root.operationId}/resume`, {
      method: 'POST',
      headers: { 'x-api-key': otherRaw },
      body: { waitId: wait.body.waitId, input: { answer: 'x' }, expectedStateVersion: opCancelled.stateVersion },
    });
    expect(cross.status).toBe(404);
  });

  test('W13-C/wait-input: rejects stale lease and terminal task', async () => {
    const root = await claimRoot('wait-edge', 'wait-edge-w');
    const stale = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch + 7, waitKey: 'k', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(stale.status).toBe(409);
    expect(stale.body.code).toBe('LEASE_LOST');

    const done = await complete(root.taskId, root.leaseEpoch, 'ref://wait-edge-done');
    expect(done.status).toBe(200);
    const terminal = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch, waitKey: 'k', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(terminal.status).toBe(410);
    expect(terminal.body.code).toBe('TASK_TERMINAL');
  });

  test('W13-C: continuation GET rejects missing runtime auth', async () => {
    const probe = await http(baseUrl, `/api/runtime/v1/tasks/${randomUUID()}/children`, {
      headers: {},
    });
    expect(probe.status).toBe(401);
  });

  // ── W27-C: cancellation persistence consistency ──────────────────────────

  test('W27-C/cancel: terminal operation closes OPEN human_waits to CANCELLED; no dispatch', async () => {
    // Open a human wait on a running task.
    const root = await claimRoot('cancel-wait-close', 'cancel-w-c');
    const wait = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch, waitKey: 'approval', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(wait.status).toBe(200);
    const waitId = wait.body.waitId as string;
    const opBefore = await getOpState(root.operationId);
    expect(opBefore.state).toBe('WAITING_INPUT');

    // Cancel while the wait is OPEN.
    const cancel = await http(baseUrl, `/api/v1/operations/${root.operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
    });
    expect(cancel.status).toBe(202);

    // Wait row is now CANCELLED — terminal wait state, not OPEN.
    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId],
    );
    expect(waitRow.rows[0]!.status).toBe('CANCELLED');

    // Operation is terminal.
    const opAfter = await getOpState(root.operationId);
    expect(opAfter.state).toBe('CANCELLED');

    // Resume on CANCELLED wait correctly fails 409 (terminal).
    const resumeAttempt = await http(baseUrl, `/api/v1/operations/${root.operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId, input: { answer: 'late' }, expectedStateVersion: opAfter.stateVersion },
    });
    expect(resumeAttempt.status).toBe(409);
    expect(resumeAttempt.body.code).toBe('STATE_CONFLICT');

    // No undelivered dispatch was created by cancel — the only task.dispatch
    // row is the one claimRoot already dispatched (dispatched_at IS NOT NULL).
    const dispatchCheck = await app.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM outbox WHERE aggregate_id=$1 AND type='task.dispatch' AND dispatched_at IS NULL",
      [root.taskId],
    );
    expect(Number(dispatchCheck.rows[0]!.n)).toBe(0);
  });

  test('W27-C/deadline: sweep closes OPEN human_waits to EXPIRED', async () => {
    // Submit and open a human wait, then set a past deadline and sweep.
    const root = await claimRoot('deadline-wait-close', 'deadline-w-c');
    const wait = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch, waitKey: 'approval', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(wait.status).toBe(200);
    const waitId = wait.body.waitId as string;

    // Force a past deadline.
    await app.db.query(
      "UPDATE operations SET deadline_at = now() - interval '1 minute' WHERE id=$1",
      [root.operationId],
    );
    const sweep = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(sweep.status).toBe(200);
    expect(sweep.body.timedOut).toBeGreaterThanOrEqual(1);

    // Wait row is now EXPIRED (terminal wait state for deadline path).
    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId],
    );
    expect(waitRow.rows[0]!.status).toBe('EXPIRED');

    // Task and operation are terminal.
    const taskRow = await app.db.query<{ state: string }>(
      'SELECT state FROM tasks WHERE id=$1',
      [root.taskId],
    );
    expect(taskRow.rows[0]!.state).toBe('CANCELLED');
    const opRow = await getOpState(root.operationId);
    expect(opRow.state).toBe('TIMED_OUT');
  });

  test('W27-C/cancel-resume race: resume wins before cancel; wait is ANSWERED then closed', async () => {
    // Open a wait, then resume it successfully (resume wins the race).
    const root = await claimRoot('race-resume-win', 'race-r-w');
    const wait = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch, waitKey: 'approval', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(wait.status).toBe(200);
    const waitId = wait.body.waitId as string;
    const opBefore = await getOpState(root.operationId);

    // Resume first (locks op, marks wait ANSWERED, updates task → QUEUED, op → QUEUED).
    const resume = await http(baseUrl, `/api/v1/operations/${root.operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId, input: { answer: 'y' }, expectedStateVersion: opBefore.stateVersion },
    });
    expect(resume.status).toBe(202);
    expect(resume.body.replayed).toBe(false);

    // Now cancel — op is QUEUED (not terminal), so cancel proceeds.
    const cancel = await http(baseUrl, `/api/v1/operations/${root.operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
    });
    expect(cancel.status).toBe(202);

    // The wait row is ANSWERED (not re-closed to CANCELLED because it was already answered).
    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId],
    );
    expect(waitRow.rows[0]!.status).toBe('ANSWERED');

    // Operation ends up CANCELLED (cancel ran after resume).
    const opAfter = await getOpState(root.operationId);
    expect(opAfter.state).toBe('CANCELLED');
  });

  test('W27-C/repeated cancel: idempotent with no duplicate dispatch or state churn', async () => {
    const root = await claimRoot('cancel-repeated', 'cancel-r');
    const wait = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: root.leaseEpoch, waitKey: 'approval', inputSchema: CONT_INPUT_SCHEMA },
    });
    expect(wait.status).toBe(200);
    const waitId = wait.body.waitId as string;

    // First cancel.
    const first = await http(baseUrl, `/api/v1/operations/${root.operationId}/cancel`, {
      method: 'POST', headers: pubHeaders(), body: {},
    });
    expect(first.status).toBe(202);
    expect(first.body.replayed).toBe(false);

    // Second cancel is a replay (idempotent) — route returns 200 for replay.
    const second = await http(baseUrl, `/api/v1/operations/${root.operationId}/cancel`, {
      method: 'POST', headers: pubHeaders(), body: {},
    });
    expect(second.status).toBe(200);
    expect(second.body.replayed).toBe(true);

    // Wait is still CANCELLED, op still CANCELLED.
    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId],
    );
    expect(waitRow.rows[0]!.status).toBe('CANCELLED');

    // No undelivered dispatch was emitted for the cancelled wait.
    const dispatchCheck = await app.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM outbox WHERE aggregate_id=$1 AND type='task.dispatch' AND dispatched_at IS NULL",
      [root.taskId],
    );
    expect(Number(dispatchCheck.rows[0]!.n)).toBe(0);
  });
});

/* ---------------- W28-C: version activation / drain / rollback ---------------- */

describe('W28-C: version activation / drain / rollback', () => {
  const BIZ = MANIFEST.businessId;
  const V1 = MANIFEST.version;
  const V2 = '2.0.0';
  const V2_QUEUE = `du-business-${BIZ}-${V2}`;

  // A manifest for v2 — same actions, different version.
  const MANIFEST_V2 = { ...MANIFEST, version: V2 };

  let v2Created = false;

  async function registerV2() {
    if (v2Created) return;
    // Register v2 via direct DB insert (avoids going through the public register
    // endpoint, which requires a full manifest shape).
    await app.db.query(
      `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
       VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5, false)
       ON CONFLICT (business_id, version) DO NOTHING`,
      [BIZ, V2, JSON.stringify(MANIFEST_V2), 'sha256:bb', V2_QUEUE]
    );
    v2Created = true;
  }

  beforeAll(async () => {
    await registerV2();
    // Drain the v2 BullMQ queue so leftover jobs don't leak across tests.
    const { Queue: Q } = await import('bullmq');
    const q = new Q(V2_QUEUE, { connection: { url: REDIS_URL } });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  });

  afterAll(async () => {
    // Restore v1 as the only active+enabled version.
    await app.enableVersionForTest(BIZ, V1);
    // Remove v2 row so it doesn't leak into other test suites.
    await app.db.query('DELETE FROM business_versions WHERE business_id=$1 AND version=$2', [BIZ, V2]);
    const { Queue: Q } = await import('bullmq');
    const q = new Q(V2_QUEUE, { connection: { url: REDIS_URL } });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  });

  test('activate v2: new submissions select v2, in-flight v1 stays pinned', async () => {
    // 1. Submit against v1 (which is still active from beforeAll).
    const subV1 = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'v1-inflight' } },
    });
    expect(subV1.status).toBe(202);
    const opV1 = subV1.body.operationId as string;
    const opV1Row = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1', [opV1]
    );
    expect(opV1Row.rows[0]!.business_version).toBe(V1);

    // 2. Enable + activate v2.
    const en = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/enable`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(en.status).toBe(200);
    const act = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(act.status).toBe(202);
    expect(act.body.active).toBe(true);

    // 3. New submission now goes to v2.
    const subV2 = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'v2-new' } },
    });
    expect(subV2.status).toBe(202);
    const opV2 = subV2.body.operationId as string;
    const opV2Row = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1', [opV2]
    );
    expect(opV2Row.rows[0]!.business_version).toBe(V2);

    // 4. The old v1 operation is still pinned to v1.
    const v1Check = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1', [opV1]
    );
    expect(v1Check.rows[0]!.business_version).toBe(V1);
  });

  test('activate v1 rollback: re-activating v1 redirects new submissions back to v1', async () => {
    // v2 is currently active; activate v1 to roll back.
    const act = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(act.status).toBe(202);
    expect(act.body.active).toBe(true);

    const sub = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'rollback-v1' } },
    });
    expect(sub.status).toBe(202);
    const row = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1',
      [sub.body.operationId as string]
    );
    expect(row.rows[0]!.business_version).toBe(V1);
  });

  test('drain v2: fail-closed when sole active version is drained; explicit re-activate restores', async () => {
    // 1. Make v2 the sole active version (v1 gets implicitly deactivated).
    await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });

    // 2. Deactivate v2 (drain). v2 stays ENABLED but is no longer active.
    const deact = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/deactivate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(deact.status).toBe(202);
    expect(deact.body.active).toBe(false);

    // v2 is still ENABLED in the registry.
    const v2Row = await app.db.query<{ status: string }>(
      'SELECT status FROM business_versions WHERE business_id=$1 AND version=$2',
      [BIZ, V2]
    );
    expect(v2Row.rows[0]!.status).toBe('ENABLED');

    // 3. No active version — new submissions fail closed (W28-C review fix).
    // The drained version is NOT silently re-selected by a "newest ENABLED"
    // heuristic; this is the exact W27-A Case 10 gap.
    const blocked = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'should-fail' } },
    });
    expect(blocked.status).toBe(404);
    expect(blocked.body.code).toBe('NOT_FOUND');

    // 4. Activating v1 restores submissions.
    const act = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(act.status).toBe(202);
    expect(act.body.active).toBe(true);

    const sub = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'drained-then-restored' } },
    });
    expect(sub.status).toBe(202);
    const row = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1',
      [sub.body.operationId as string]
    );
    expect(row.rows[0]!.business_version).toBe(V1);
  });

  test('activate invalid version → 404', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/99.99.99/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('activate rejects missing admin auth (401)', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  test('concurrent activate(v2) and activate(v1) resolve without deadlock (W28-C review item 3)', async () => {
    // Pre-condition: v1 active (from previous drain-test restore step).
    // Fire two concurrent activates for different versions — each must lock ALL
    // business_versions rows in deterministic (version ASC) order first, so
    // one wins and the other waits (no deadlock → no 500).
    const [resA, resB] = await Promise.all([
      http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/activate`, {
        method: 'PUT',
        headers: adminHeaders(),
      }),
      http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
        method: 'PUT',
        headers: adminHeaders(),
      }),
    ]);
    // Neither is a 500 (deadlock would show up as 500 or a PG abort).
    expect(resA.status).not.toBe(500);
    expect(resB.status).not.toBe(500);
    // Both are valid results (200 replay or 202).
    expect([200, 202]).toContain(resA.status);
    expect([200, 202]).toContain(resB.status);

    // Exactly one version is active — the partial unique index held.
    const activeCount = await app.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM business_versions WHERE business_id=$1 AND is_active = true",
      [BIZ],
    );
    expect(Number(activeCount.rows[0]!.n)).toBe(1);

    // Whichever won the race, the final active version is a valid choice.
    const activeRow = await app.db.query<{ version: string }>(
      'SELECT version FROM business_versions WHERE business_id=$1 AND is_active = true',
      [BIZ],
    );
    expect([V1, V2]).toContain(activeRow.rows[0]!.version);
  });

  test('activate is idempotent: re-activating the active version returns 200 replayed', async () => {
    // Ensure v1 is active, then re-activate it — should be 200 replayed.
    await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.active).toBe(true);
  });
});

/* ---------------- W29-C: Admin authorization negative tests ---------------- */

describe('W29-C: Admin authorization negative tests', () => {
  const BIZ = MANIFEST.businessId;
  const V1 = MANIFEST.version;

  // -- Unauthenticated: all admin routes reject 401 when no bearer token is sent --

  test('enable rejects missing admin auth (401)', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/enable`, {
      method: 'PUT',
      headers: {},
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('deactivate rejects missing admin auth (401)', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/deactivate`, {
      method: 'PUT',
      headers: {},
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('profile-bindings rejects missing admin auth (401)', async () => {
    const res = await http(baseUrl, '/api/v1/admin/profile-bindings', {
      method: 'POST',
      headers: {},
      body: { apiKey: `du_noauth_${randomUUID()}`, businessId: BIZ, businessVersion: V1, action: 'extract', connectorBindings: {} },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  // -- Role substitution: runtime token does not grant admin access --

  test('enable rejects runtime token (401) — role substitution denied', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/enable`, {
      method: 'PUT',
      headers: rtHeaders(),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  // -- W29-C Fix 1: enable on non-existent version → 404 (not false 200) --

  test('enable on unregistered version → 404 NOT_FOUND (W29-C fix)', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/99.99.99/enable`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  // -- Cross-tenant operation isolation: cancel and resume fail-closed --

  test('cross-tenant cancel → 404 (no information leakage)', async () => {
    // Create an operation as the suite's API key (tenant 0000...01).
    const submit = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'w29-cancel-tenant' } },
    });
    expect(submit.status).toBe(202);
    const opId = submit.body.operationId as string;

    // Create an API key for a different tenant.
    const otherTenant = randomUUID();
    await app.db.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'w29-other') ON CONFLICT (id) DO NOTHING`,
      [otherTenant]
    );
    const otherRaw = `du_w29other_${randomUUID().replace(/-/g, '')}`;
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'w29o','ACTIVE') ON CONFLICT (hash) DO NOTHING`,
      [randomUUID(), otherTenant, hashKey(otherRaw)]
    );

    // Cross-tenant cancel must 404, not 403 or 200.
    const cancel = await http(baseUrl, `/api/v1/operations/${opId}/cancel`, {
      method: 'POST',
      headers: { 'x-api-key': otherRaw },
    });
    expect(cancel.status).toBe(404);
    expect(cancel.body.code).toBe('NOT_FOUND');

    // Cleanup the operation to avoid leaking into other suites.
    await app.db.query('DELETE FROM usage_events WHERE operation_id=$1', [opId]);
    const tasks = await app.db.query<{ id: string }>('SELECT id FROM tasks WHERE operation_id=$1', [opId]);
    const taskIds = tasks.rows.map((r) => r.id);
    if (taskIds.length) {
      await app.db.query('DELETE FROM outbox WHERE aggregate_id = ANY($1)', [taskIds]);
      await app.db.query('DELETE FROM tasks WHERE id = ANY($1)', [taskIds]);
    }
    await app.db.query('DELETE FROM submission_keys WHERE operation_id=$1', [opId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [opId]);
  });

  test('cross-tenant resume → 404 (no information leakage)', async () => {
    // Submit as suite's key; then create an operation for a second tenant
    // by direct insert (we need an operation that belongs to a different tenant).
    const otherTenant = randomUUID();
    await app.db.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'w29-resume-tenant') ON CONFLICT (id) DO NOTHING`,
      [otherTenant]
    );
    const otherRaw = `du_w29resume_${randomUUID().replace(/-/g, '')}`;
    const otherKeyId = randomUUID();
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'w29r','ACTIVE') ON CONFLICT (hash) DO NOTHING`,
      [otherKeyId, otherTenant, hashKey(otherRaw)]
    );

    // Create an operation under the other tenant via direct DB insert.
    const opId = randomUUID();
    const rootTaskId = randomUUID();
    await app.db.query(
      `INSERT INTO operations
         (id, tenant_id, api_key_id, business_id, business_version, action, state, state_version, root_task_id, input_ref, correlation_id)
       VALUES ($1,$2,$3,$4,$5,'extract','RUNNING',1,$6,$7,$8)`,
      [opId, otherTenant, otherKeyId, BIZ, V1, rootTaskId, JSON.stringify({ q: 'w29-resume' }), randomUUID()]
    );
    await app.db.query(
      `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, due_at)
       VALUES ($1,$2,'root','root',$3,'WAITING_CHILDREN',0, now())`,
      [rootTaskId, opId, JSON.stringify({ q: 'w29-resume' })]
    );

    // The suite's own API key (tenant 0000...01) tries to resume — cross-tenant → 404.
    const resume = await http(baseUrl, `/api/v1/operations/${opId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId: randomUUID(), input: { ok: true }, expectedStateVersion: 1 },
    });
    expect(resume.status).toBe(404);
    expect(resume.body.code).toBe('NOT_FOUND');

    // Cleanup: the other tenant's operation + tasks.
    await app.db.query('DELETE FROM outbox WHERE aggregate_id=$1', [rootTaskId]);
    await app.db.query('DELETE FROM tasks WHERE id=$1', [rootTaskId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [opId]);
  });
});

describe('W30-C: expired-lease recovery', () => {
  /** Submit → dispatch → claim, return task + operation ids + claim epoch. */
  async function claimedTask(label: string) {
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: label } },
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    const opRes = await app.db.query<{ root_task_id: string }>(
      'SELECT root_task_id FROM operations WHERE id=$1',
      [operationId]
    );
    const taskId = opRes.rows[0]!.root_task_id;
    const dispatched = await app.dispatcher.dispatchOnce();
    expect(dispatched).toBeGreaterThanOrEqual(1);
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId)!;
    const deliveryId = (job.data as { deliveryId: string }).deliveryId;
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-expired-test' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    // Remove the original BullMQ job so recovery-dispatched job is distinct.
    await q.remove(job.id!);
    return { operationId, taskId, leaseEpoch, deliveryId };
  }

  test('expired RUNNING task is recovered: re-dispatched via outbox, old epoch fenced', async () => {
    const { operationId, taskId, leaseEpoch } = await claimedTask('expired-recovery');
    // Expire the lease to simulate a crashed worker.
    await app.db.query(
      `UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id=$1`,
      [taskId]
    );
    const handled = await app.runtime.sweepExpiredLeases();
    expect(handled).toBeGreaterThanOrEqual(1);
    // Task was requeued: state READY, lease cleared, epoch bumped.
    const t = (
      await app.db.query<{ state: string; lease_epoch: number; lease_expires_at: string | null }>(
        'SELECT state, lease_epoch, lease_expires_at FROM tasks WHERE id=$1',
        [taskId]
      )
    ).rows[0]!;
    expect(t.state).toBe('READY');
    expect(t.lease_expires_at).toBeNull();
    expect(t.lease_epoch).toBeGreaterThan(leaseEpoch);
    // New outbox row exists with a recovery delivery.
    const ob = (
      await app.db.query<{ delivery_id: string }>(
        "SELECT delivery_id FROM outbox WHERE aggregate_id=$1 AND delivery_id LIKE '%recover%'",
        [taskId]
      )
    ).rows;
    expect(ob.length).toBeGreaterThanOrEqual(1);
    // Dispatcher publishes the recovery job.
    const dispatched = await app.dispatcher.dispatchOnce();
    expect(dispatched).toBeGreaterThanOrEqual(1);
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const recovJob = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId);
    expect(recovJob).toBeDefined();
    // Old worker heartbeat with stale epoch → 409 LEASE_LOST.
    const staleHb = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/heartbeat`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch },
    });
    expect(staleHb.status).toBe(409);
    expect((staleHb.body as { code?: string }).code).toBe('LEASE_LOST');
    // Cleanup.
    await app.db.query('DELETE FROM outbox WHERE aggregate_id=$1', [taskId]);
    await app.db.query('DELETE FROM tasks WHERE operation_id=$1', [operationId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [operationId]);
  });

  test('unexpired lease is not touched by sweep', async () => {
    const { taskId } = await claimedTask('unexpired-skip');
    const before = (
      await app.db.query<{ lease_epoch: number }>('SELECT lease_epoch FROM tasks WHERE id=$1', [taskId])
    ).rows[0]!;
    const handled = await app.runtime.sweepExpiredLeases();
    expect(handled).toBe(0);
    const after = (
      await app.db.query<{ lease_epoch: number }>('SELECT lease_epoch FROM tasks WHERE id=$1', [taskId])
    ).rows[0]!;
    expect(after.lease_epoch).toBe(before.lease_epoch);
    // Cleanup.
    const opRes = await app.db.query<{ operation_id: string }>('SELECT operation_id FROM tasks WHERE id=$1', [taskId]);
    const opId = opRes.rows[0]!.operation_id;
    await app.db.query('DELETE FROM outbox WHERE aggregate_id=$1', [taskId]);
    await app.db.query('DELETE FROM tasks WHERE id=$1', [taskId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [opId]);
  });

  test('READY task with NULL lease is excluded (idle, not crashed)', async () => {
    // Submit but do not claim — task is READY, no lease.
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'ready-idle' } },
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    const taskId = (await app.db.query<{ root_task_id: string }>('SELECT root_task_id FROM operations WHERE id=$1', [operationId])).rows[0]!.root_task_id;
    const before = (
      await app.db.query<{ state: string; lease_expires_at: null }>(
        'SELECT state, lease_expires_at FROM tasks WHERE id=$1',
        [taskId]
      )
    ).rows[0]!;
    expect(before.state).toBe('READY');
    expect(before.lease_expires_at).toBeNull();
    const handled = await app.runtime.sweepExpiredLeases();
    expect(handled).toBe(0);
    await app.db.query('DELETE FROM outbox WHERE aggregate_id=$1', [taskId]);
    await app.db.query('DELETE FROM tasks WHERE id=$1', [taskId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [operationId]);
  });

  test('WAITING_INPUT and WAITING_CHILDREN tasks are excluded', async () => {
    // Manually create a RUNNING task under WAITING_INPUT op with expired lease.
    const opId = randomUUID();
    const taskId = randomUUID();
    const otherTenant = TENANT_ID;
    await app.db.query(
      `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, state_version, correlation_id, input_ref)
       VALUES ($1,$2,'${MANIFEST.businessId}','1.0.0','extract','WAITING_INPUT',1,$3,'{}')`,
      [opId, otherTenant, randomUUID()]
    );
    await app.db.query(
      `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts, lease_epoch, lease_expires_at, leased_by, due_at)
       VALUES ($1,$2,'root','root',$3,'WAITING_INPUT',0,3,1,now()-interval '1 second','worker-old',now())`,
      [taskId, opId, JSON.stringify({ q: 'wi' })]
    );
    // Also create a WAITING_CHILDREN task.
    const wcOpId = randomUUID();
    const wcTaskId = randomUUID();
    await app.db.query(
      `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, state_version, correlation_id, input_ref)
       VALUES ($1,$2,'${MANIFEST.businessId}','1.0.0','extract','WAITING_CHILDREN',1,$3,'{}')`,
      [wcOpId, otherTenant, randomUUID()]
    );
    await app.db.query(
      `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts, lease_epoch, lease_expires_at, leased_by, due_at)
       VALUES ($1,$2,'root','root',$3,'WAITING_CHILDREN',0,3,1,now()-interval '1 second','worker-old',now())`,
      [wcTaskId, wcOpId, JSON.stringify({ q: 'wc' })]
    );
    const handled = await app.runtime.sweepExpiredLeases();
    expect(handled).toBe(0);
    // Verify both tasks unchanged.
    for (const id of [taskId, wcTaskId]) {
      const r = (await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [id])).rows[0]!;
      expect(['WAITING_INPUT', 'WAITING_CHILDREN']).toContain(r.state);
    }
    // Cleanup.
    await app.db.query('DELETE FROM tasks WHERE id IN ($1,$2)', [taskId, wcTaskId]);
    await app.db.query('DELETE FROM operations WHERE id IN ($1,$2)', [opId, wcOpId]);
  });

  test('terminal operation excludes a RUNNING task from sweep', async () => {
    const opId = randomUUID();
    const taskId = randomUUID();
    await app.db.query(
      `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, state_version, correlation_id, input_ref)
       VALUES ($1,$2,'${MANIFEST.businessId}','1.0.0','extract','SUCCEEDED',1,$3,'{}')`,
      [opId, TENANT_ID, randomUUID()]
    );
    await app.db.query(
      `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts, lease_epoch, lease_expires_at, leased_by, due_at)
       VALUES ($1,$2,'root','root',$3,'RUNNING',1,3,1,now()-interval '1 second','worker-old',now())`,
      [taskId, opId, JSON.stringify({ q: 'term-op' })]
    );
    const handled = await app.runtime.sweepExpiredLeases();
    expect(handled).toBe(0);
    await app.db.query('DELETE FROM tasks WHERE id=$1', [taskId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [opId]);
  });

  test('terminal task (FAILED) with stale lease is excluded', async () => {
    const opId = randomUUID();
    const taskId = randomUUID();
    await app.db.query(
      `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, state_version, correlation_id, input_ref)
       VALUES ($1,$2,'${MANIFEST.businessId}','1.0.0','extract','RUNNING',1,$3,'{}')`,
      [opId, TENANT_ID, randomUUID()]
    );
    await app.db.query(
      `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts, lease_epoch, lease_expires_at, leased_by, due_at, error_code)
       VALUES ($1,$2,'root','root',$3,'FAILED',3,3,5,now()-interval '1 second','worker-old',now(),'SOME_ERR')`,
      [taskId, opId, JSON.stringify({ q: 'term-task' })]
    );
    const handled = await app.runtime.sweepExpiredLeases();
    expect(handled).toBe(0);
    await app.db.query('DELETE FROM tasks WHERE id=$1', [taskId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [opId]);
  });

  test('budget exhaustion: expired lease with attempt >= max_attempts → terminal FAIL', async () => {
    const opId = randomUUID();
    const taskId = randomUUID();
    await app.db.query(
      `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, state_version, correlation_id, input_ref)
       VALUES ($1,$2,'${MANIFEST.businessId}','1.0.0','extract','RUNNING',1,$3,'{}')`,
      [opId, TENANT_ID, randomUUID()]
    );
    // attempt=3, max_attempts=3 → budget exhausted.
    await app.db.query(
      `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts, lease_epoch, lease_expires_at, leased_by, due_at)
       VALUES ($1,$2,'root','root',$3,'RUNNING',3,3,5,now()-interval '1 second','worker-old',now())`,
      [taskId, opId, JSON.stringify({ q: 'budget-exhaust' })]
    );
    const handled = await app.runtime.sweepExpiredLeases();
    expect(handled).toBe(1);
    const t = (
      await app.db.query<{ state: string; error_code: string }>(
        'SELECT state, error_code FROM tasks WHERE id=$1',
        [taskId]
      )
    ).rows[0]!;
    expect(t.state).toBe('FAILED');
    expect(t.error_code).toBe('LEASE_EXPIRED');
    const op = (
      await app.db.query<{ state: string; error_code: string }>(
        'SELECT state, error_code FROM operations WHERE id=$1',
        [opId]
      )
    ).rows[0]!;
    expect(op.state).toBe('FAILED');
    expect(op.error_code).toBe('LEASE_EXPIRED');
    // No outbox row — budget exhaustion is terminal, no re-dispatch.
    const ob = (await app.db.query<{ id: string }>('SELECT id FROM outbox WHERE aggregate_id=$1', [taskId])).rows;
    expect(ob.length).toBe(0);
    await app.db.query('DELETE FROM tasks WHERE id=$1', [taskId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [opId]);
  });

  test('repeated sweep is idempotent: second sweep touches nothing', async () => {
    const { operationId, taskId } = await claimedTask('repeated-sweep');
    await app.db.query(
      `UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE id=$1`,
      [taskId]
    );
    const h1 = await app.runtime.sweepExpiredLeases();
    expect(h1).toBeGreaterThanOrEqual(1);
    const ob1 = (
      await app.db.query<{ delivery_id: string }>(
        "SELECT delivery_id FROM outbox WHERE aggregate_id=$1 AND delivery_id LIKE '%recover%'",
        [taskId]
      )
    ).rows;
    expect(ob1.length).toBeGreaterThanOrEqual(1);
    // Second sweep: task is READY, not RUNNING → nothing to do.
    const h2 = await app.runtime.sweepExpiredLeases();
    expect(h2).toBe(0);
    const ob2 = (
      await app.db.query<{ delivery_id: string }>(
        "SELECT delivery_id FROM outbox WHERE aggregate_id=$1 AND delivery_id LIKE '%recover%'",
        [taskId]
      )
    ).rows;
    expect(ob2.length).toBe(ob1.length); // same count, no duplicates.
    await app.db.query('DELETE FROM outbox WHERE aggregate_id=$1', [taskId]);
    await app.db.query('DELETE FROM tasks WHERE operation_id=$1', [operationId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [operationId]);
  });

  test('production hook: listen() starts interval sweep that recovers without explicit call', async () => {
    // Boot a fresh app with a fast recovery interval to prove the production
    // scheduling hook (setInterval in listen()) invokes sweepExpiredLeases
    // periodically — a manual-only helper would not satisfy P2-09.
    const hookApp = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: 'hook-rt-' + randomUUID(),
      adminToken: 'hook-adm-' + randomUUID(),
      autoDispatch: false, // no dispatcher background
      leaseRecoveryIntervalMs: 50, // 50ms — fires quickly
    });
    const opId = randomUUID();
    const taskId = randomUUID();
    let operationInserted = false;
    let taskInserted = false;
    try {
      await hookApp.listen();
      // Seed a RUNNING task with an already-expired lease.
      await hookApp.db.query(
        `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, state_version, correlation_id, input_ref)
         VALUES ($1,$2,'${MANIFEST.businessId}','1.0.0','extract','RUNNING',1,$3,'{}')`,
        [opId, TENANT_ID, randomUUID()]
      );
      operationInserted = true;
      await hookApp.db.query(
        `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, max_attempts, lease_epoch, lease_expires_at, leased_by, due_at)
         VALUES ($1,$2,'root','root',$3,'RUNNING',0,3,1,now()-interval '1 second','worker-old',now())`,
        [taskId, opId, JSON.stringify({ q: 'hook-test' })]
      );
      taskInserted = true;
      // Wait for the 50ms interval to fire at least once (allow a generous margin).
      await new Promise((r) => setTimeout(r, 500));
      const t = (
        await hookApp.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [taskId])
      ).rows[0]!;
      expect(t.state).toBe('READY'); // recovered by the background timer, not a manual call.
    } finally {
      // Always release the dedicated pool, Redis client, server, and interval,
      // including when listen() or a DB query fails during a transient outage.
      if (taskInserted) {
        await hookApp.db.query('DELETE FROM outbox WHERE aggregate_id=$1', [taskId]).catch(() => undefined);
        await hookApp.db.query('DELETE FROM tasks WHERE id=$1', [taskId]).catch(() => undefined);
      }
      if (operationInserted) {
        await hookApp.db.query('DELETE FROM operations WHERE id=$1', [opId]).catch(() => undefined);
      }
      await hookApp.close({ timeoutMs: 100, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });
});

describe('W32-C: webhook delivery outbox & dispatch', () => {
  const CALLBACK_URL = 'https://client.example/hook';

  /** Submit with a callback and return ids + task claim context. */
  async function submitWithCallback(label: string, callbackUrl: string | null = CALLBACK_URL) {
    const body: Record<string, unknown> = { input: { q: label } };
    if (callbackUrl) body.callback = { url: callbackUrl };
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body,
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    const opRes = await app.db.query<{ root_task_id: string; callback_url: string | null }>(
      'SELECT root_task_id, callback_url FROM operations WHERE id=$1',
      [operationId]
    );
    return { operationId, taskId: opRes.rows[0]!.root_task_id, callbackUrl: opRes.rows[0]!.callback_url };
  }

  /** Drive an operation to SUCCEEDED via the runtime API. */
  async function succeedOperation(operationId: string, taskId: string) {
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId)!;
    const deliveryId = (job.data as { deliveryId: string }).deliveryId;
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-webhook-test' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    const resultRef = `result-${randomUUID()}`;
    const complete = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
    expect(complete.status).toBe(200);
    expect(complete.body.operationState).toBe('SUCCEEDED');
  }

  async function deliveriesFor(operationId: string) {
    const res = await app.db.query<{
      delivery_id: string;
      event_type: string;
      terminal_state: string;
      state_version: number;
      destination_url: string;
      status: string;
      attempts: number;
      payload: { deliveryId: string; eventType: string; operationId: string; state: string; stateVersion: number };
    }>(
      'SELECT delivery_id, event_type, terminal_state, state_version, destination_url, status, attempts, payload FROM webhook_deliveries WHERE operation_id=$1',
      [operationId]
    );
    return res.rows;
  }

  test('callback_url persisted at submit; terminal SUCCEEDED schedules a signed delivery row', async () => {
    const { operationId, taskId, callbackUrl } = await submitWithCallback('wh-succeed');
    expect(callbackUrl).toBe(CALLBACK_URL);
    await succeedOperation(operationId, taskId);
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(1);
    const d = rows[0]!;
    expect(d.event_type).toBe('operation.succeeded');
    expect(d.terminal_state).toBe('SUCCEEDED');
    expect(d.destination_url).toBe(CALLBACK_URL);
    expect(d.status).toBe('PENDING');
    expect(d.attempts).toBe(0);
    // Payload deliveryId matches the durable row id.
    expect(d.payload.deliveryId).toBe(d.delivery_id);
    expect(d.payload.operationId).toBe(operationId);
    expect(d.payload.eventType).toBe('operation.succeeded');
    expect(d.payload.stateVersion).toBe(d.state_version);
  });

  test('no callback_url → no webhook row on terminal transition', async () => {
    const { operationId, taskId, callbackUrl } = await submitWithCallback('wh-none', null);
    expect(callbackUrl).toBeNull();
    await succeedOperation(operationId, taskId);
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(0);
  });

  test('terminal FAILED via failTask schedules a webhook', async () => {
    const { operationId, taskId } = await submitWithCallback('wh-fail');
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId)!;
    const deliveryId = (job.data as { deliveryId: string }).deliveryId;
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-webhook-test' },
    });
    const leaseEpoch = claim.body.leaseEpoch as number;
    const fail = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/fail`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, errorCode: 'PERMANENT', retryable: false },
    });
    expect(fail.status).toBe(200);
    expect(fail.body.operationState).toBe('FAILED');
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event_type).toBe('operation.failed');
    expect(rows[0]!.terminal_state).toBe('FAILED');
  });

  test('terminal CANCELLED via cancel schedules a webhook; cancel replay does not duplicate', async () => {
    const { operationId } = await submitWithCallback('wh-cancel');
    const cancel = await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: {},
    });
    expect(cancel.status).toBe(202);
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event_type).toBe('operation.cancelled');
    // Replay: terminal op cancel is a 200 replay, no second delivery row.
    const replay = await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: {},
    });
    expect(replay.status).toBe(200);
    expect((await deliveriesFor(operationId)).length).toBe(1);
  });

  test('terminal TIMED_OUT via deadline sweep schedules a webhook', async () => {
    const { operationId } = await submitWithCallback('wh-timeout');
    await app.db.query(`UPDATE operations SET deadline_at = now() - interval '1 second' WHERE id=$1`, [operationId]);
    const sweep = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(sweep.status).toBe(200);
    expect(sweep.body.timedOut as number).toBeGreaterThanOrEqual(1);
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event_type).toBe('operation.timed-out');
    expect(rows[0]!.terminal_state).toBe('TIMED_OUT');
  });

  test('signature: signWebhookBody/verifyWebhookSignature round-trip and tamper rejection', () => {
    const secret = 'whsec-test';
    const ts = new Date().toISOString();
    const body = JSON.stringify({ a: 1 });
    const sig = signWebhookBody(secret, ts, body);
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifyWebhookSignature(secret, ts, body, sig)).toBe(true);
    expect(verifyWebhookSignature(secret, ts, body + 'x', sig)).toBe(false);
    expect(verifyWebhookSignature('other', ts, body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, ts, body, 'sha256=deadbeef')).toBe(false);
  });

  test('dispatcher: successful delivery marks DELIVERED with correct signed headers', async () => {
    const secret = 'whsec-' + randomUUID();
    const { operationId, taskId } = await submitWithCallback('wh-deliver-ok');
    await succeedOperation(operationId, taskId);
    const myDeliveryId = (await deliveriesFor(operationId))[0]!.delivery_id;
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    // NOTE: the sweep is global by design (shared DB) — earlier tests in this
    // suite left PENDING rows that this sweep legitimately delivers too. We
    // assert on THIS operation's delivery, not the global attempted count.
    const attempted = await deliverWebhooks(app.db, {
      secret,
      allowPrivateNetworks: true,
      fetchFn: async (url, init) => {
        sent.push({ url, headers: init.headers, body: init.body });
        return { status: 200 };
      },
    });
    expect(attempted).toBeGreaterThanOrEqual(1);
    const s = sent.find((x) => x.headers['x-du-delivery-id'] === myDeliveryId);
    expect(s).toBeDefined();
    expect(s!.url).toBe(CALLBACK_URL);
    // Signature verifies against the exact sent body + timestamp.
    expect(
      verifyWebhookSignature(secret, s!.headers['x-du-timestamp']!, s!.body, s!.headers['x-du-signature']!)
    ).toBe(true);
    const rows = await deliveriesFor(operationId);
    expect(rows[0]!.status).toBe('DELIVERED');
    expect(rows[0]!.attempts).toBe(1);
  });

  test('dispatcher: failure retries with backoff then exhausts to FAILED; operation unaffected', async () => {
    const secret = 'whsec-' + randomUUID();
    const { operationId, taskId } = await submitWithCallback('wh-deliver-fail');
    await succeedOperation(operationId, taskId);
    // Shrink the retry budget so the test exhausts quickly.
    await app.db.query('UPDATE webhook_deliveries SET max_attempts=2 WHERE operation_id=$1', [operationId]);
    let calls = 0;
    const failing = async () => {
      calls++;
      return { status: 500 };
    };
    // Attempt 1 → stays PENDING, attempts=1, next_at pushed out.
    await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: failing });
    let row = (await deliveriesFor(operationId))[0]!;
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    // Force next_at due, attempt 2 → budget exhausted → FAILED.
    await app.db.query('UPDATE webhook_deliveries SET next_at = now() - interval \'1 second\' WHERE operation_id=$1', [operationId]);
    await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: failing });
    row = (await deliveriesFor(operationId))[0]!;
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(2);
    expect(calls).toBe(2);
    // Delivery failure never changed the operation outcome.
    const op = await app.db.query<{ state: string }>('SELECT state FROM operations WHERE id=$1', [operationId]);
    expect(op.rows[0]!.state).toBe('SUCCEEDED');
    // A FAILED row is never re-attempted.
    const again = await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: failing });
    expect(again).toBe(0);
    expect(calls).toBe(2);
  });

  test('dispatcher: idempotent — no due rows means no attempts; delivered rows stay delivered', async () => {
    const secret = 'whsec-' + randomUUID();
    const { operationId, taskId } = await submitWithCallback('wh-idem');
    await succeedOperation(operationId, taskId);
    let calls = 0;
    const ok = async () => {
      calls++;
      return { status: 200 };
    };
    await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: ok });
    expect(calls).toBe(1);
    // Second sweep: the row is DELIVERED (not PENDING), so nothing is re-sent.
    const second = await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: ok });
    expect(second).toBe(0);
    expect(calls).toBe(1);
    expect((await deliveriesFor(operationId))[0]!.status).toBe('DELIVERED');
  });
});

// ---------------------------------------------------------------------------
// W36-C: P2-08 — Operations Status & Result Facade
// ---------------------------------------------------------------------------

describe('W36-C: operations status & result facade', () => {
  /** Submit a plain operation and return its operation + task IDs. */
  async function submitFacade(label: string) {
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: label } },
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    const opRes = await app.db.query<{ root_task_id: string }>(
      'SELECT root_task_id FROM operations WHERE id=$1',
      [operationId]
    );
    return { operationId, taskId: opRes.rows[0]!.root_task_id };
  }

  /** Drive an operation to SUCCEEDED via runtime API. */
  async function succeedFacade(operationId: string, taskId: string) {
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId)!;
    const deliveryId = (job.data as { deliveryId: string }).deliveryId;
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-facade-test' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    const resultRef = `result-facade-${randomUUID()}`;
    const complete = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
    expect(complete.status).toBe(200);
    expect(complete.body.operationState).toBe('SUCCEEDED');
  }

  // --- Unit tests for facade functions ---

  test('toOperationView: canonical shape includes name, links, progress', () => {
    const now = new Date().toISOString();
    const row = {
      id: 'test-op-1',
      tenant_id: TENANT_ID,
      business_id: 'doc-core',
      business_version: '1.0.0',
      action: 'extract',
      state: 'SUCCEEDED',
      state_version: 3,
      created_at: now,
      updated_at: now,
      deadline_at: null,
      result_ref: 's3://r.json',
    };
    const v = toOperationView(row);
    expect(v.id).toBe('test-op-1');
    expect(v.name).toBe('operations/test-op-1');
    expect(v.state).toBe('SUCCEEDED');
    expect(v.stateVersion).toBe(3);
    expect(v.links.self).toBe('/api/v1/operations/test-op-1');
    expect(v.links.result).toBe('/api/v1/operations/test-op-1/result');
    expect(v.progress).toEqual({ percent: 0, message: 'SUCCEEDED' });
    expect(v.businessId).toBe('doc-core');
    expect(v.businessVersion).toBe('1.0.0');
    expect(v.action).toBe('extract');
  });

  test('isTerminal: SUCCEEDED/FAILED/CANCELLED/TIMED_OUT are terminal', () => {
    expect(isTerminal('SUCCEEDED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('TIMED_OUT')).toBe(true);
    expect(isTerminal('PENDING')).toBe(false);
    expect(isTerminal('RUNNING')).toBe(false);
    expect(isTerminal('WAITING_INPUT')).toBe(false);
    expect(isTerminal('WAITING_CHILDREN')).toBe(false);
  });

  test('resultHttpStatus: 200 for SUCCEEDED, 410 for TIMED_OUT, 409 for others', () => {
    expect(resultHttpStatus('SUCCEEDED')).toBe(200);
    expect(resultHttpStatus('TIMED_OUT')).toBe(410);
    expect(resultHttpStatus('PENDING')).toBe(409);
    expect(resultHttpStatus('RUNNING')).toBe(409);
    expect(resultHttpStatus('FAILED')).toBe(409);
    expect(resultHttpStatus('CANCELLED')).toBe(409);
  });

  test('waitForTerminal: returns immediately for terminal op', async () => {
    const { operationId, taskId } = await submitFacade('facade-immediate');
    await succeedFacade(operationId, taskId);
    const op = await waitForTerminal(
      (id) => app.runtime.getOperation(id),
      operationId,
      5,
    );
    expect(op.state).toBe('SUCCEEDED');
  });

  // --- Integration tests via HTTP ---

  test('GET /operations/:id: returns canonical OperationView with name, links, progress', async () => {
    const { operationId } = await submitFacade('facade-view-shape');
    const res = await http(baseUrl, `/api/v1/operations/${operationId}`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(operationId);
    expect(res.body.name).toBe(`operations/${operationId}`);
    const links = res.body.links as { self: string; result: string };
    expect(links.self).toBe(`/api/v1/operations/${operationId}`);
    expect(links.result).toBe(`/api/v1/operations/${operationId}/result`);
    const progress = res.body.progress as { percent: number; message: string };
    expect(progress.percent).toBe(0);
    expect(res.body.stateVersion).toBeDefined();
    expect(res.body.businessId).toBe(MANIFEST.businessId);
  });

  test('GET /operations/:id: non-existent returns 404', async () => {
    const fakeId = randomUUID();
    const res = await http(baseUrl, `/api/v1/operations/${fakeId}`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('GET /operations/:id/result: SUCCEEDED returns ResultEnvelope', async () => {
    const { operationId, taskId } = await submitFacade('facade-result-succeed');
    await succeedFacade(operationId, taskId);
    const res = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe('1');
    expect((res.body.usage as { measurement?: string }).measurement).toBe('pending');
    expect(res.body.warnings).toEqual([]);
  });

  test('GET /operations/:id/result: PENDING returns 409 STATE_CONFLICT', async () => {
    const { operationId } = await submitFacade('facade-result-pending');
    const res = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe('STATE_CONFLICT');
  });

  test('GET /operations/:id/result: CANCELLED returns 409 STATE_CONFLICT', async () => {
    const { operationId } = await submitFacade('facade-result-cancel');
    const cancel = await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: {},
    });
    expect(cancel.status).toBe(202);
    const res = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe('STATE_CONFLICT');
  });

  test('GET /operations/:id/result: TIMED_OUT returns 410 GONE', async () => {
    const { operationId } = await submitFacade('facade-result-timeout');
    // Set deadline in the past and sweep to transition to TIMED_OUT
    await app.db.query(`UPDATE operations SET deadline_at = now() - interval '1 second' WHERE id=$1`, [operationId]);
    const sweep = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
      body: {},
    });
    expect(sweep.status).toBe(200);
    const res = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(410);
  });

  test('GET /operations/:id/result: non-existent returns 404', async () => {
    const res = await http(baseUrl, `/api/v1/operations/${randomUUID()}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('?wait=0 or absent: returns immediately (no blocking)', async () => {
    const { operationId } = await submitFacade('facade-nowait');
    const res = await http(baseUrl, `/api/v1/operations/${operationId}?wait=0`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(200);
    expect(['PENDING', 'ACCEPTED', 'QUEUED', 'RUNNING']).toContain(res.body.state);
  });

  test('?wait=5: long-poll holds until operation reaches SUCCEEDED', async () => {
    const { operationId, taskId } = await submitFacade('facade-wait-succeed');
    // Start the long-poll in the background (holds up to5s)
    const pollPromise = http(baseUrl, `/api/v1/operations/${operationId}?wait=5`, {
      headers: pubHeaders(),
    });
    // Give the poll a moment to connect and enter the first wait cycle
    await new Promise((r) => setTimeout(r, 200));
    // Complete the operation while the poll is waiting
    await succeedFacade(operationId, taskId);
    // The poll should resolve with the terminal state
    const polled = await pollPromise;
    expect(polled.status).toBe(200);
    expect(polled.body.state).toBe('SUCCEEDED');
    expect(polled.body.name).toBe(`operations/${operationId}`);
  });

  test('?wait=1: timeout returns current (non-terminal) state', async () => {
    const { operationId } = await submitFacade('facade-wait-timeout');
    const start = Date.now();
    const res = await http(baseUrl, `/api/v1/operations/${operationId}?wait=1`, {
      headers: pubHeaders(),
    });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    // State should still be non-terminal (no completion was triggered)
    expect(['PENDING', 'ACCEPTED', 'QUEUED', 'RUNNING']).toContain(res.body.state);
    // Should have waited approximately 1 second (allow some margin)
    expect(elapsed).toBeGreaterThanOrEqual(800);
  });
});

// ---------------------------------------------------------------------------
// W37-C: P2-06 composite acceptance — Children/join, human wait/resume,
// deadline/cancel (RUN-05/06/07)
// ---------------------------------------------------------------------------

describe('W37-C: P2-06 composite — children, human wait, deadline, cancel', () => {
  const CONT_SCHEMA = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  };

  /** Submit + dispatch + claim the root task; returns claimed RUNNING root. */
  async function claimRootComposite(label: string, worker: string) {
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: label } },
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(operationId);
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: worker },
    });
    expect(claim.status).toBe(200);
    return { operationId, taskId: job.taskId, leaseEpoch: claim.body.leaseEpoch as number };
  }

  function childSpecsComposite(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const payloadRef = { shard: i, q: 'composite' };
      return {
        taskKey: `shard-${i}`,
        kind: 'root',
        payloadRef,
        payloadHash: contentHash(payloadRef),
      };
    });
  }

  async function spawnComposite(taskId: string, leaseEpoch: number, children: unknown[], continuationRef = 'cont-c') {
    return http(baseUrl, `/api/runtime/v1/tasks/${taskId}/children`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, children, joinPolicy: 'all-success', continuationRef },
    });
  }

  async function completeComposite(taskId: string, leaseEpoch: number, resultRef = 'ref://child-out') {
    return http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
  }

  async function getOpComposite(operationId: string) {
    const got = await http(baseUrl, `/api/v1/operations/${operationId}`, { headers: pubHeaders() });
    expect(got.status).toBe(200);
    return { state: got.body.state as string, stateVersion: got.body.stateVersion as number };
  }

  async function openWaitComposite(taskId: string, leaseEpoch: number, waitKey = 'approval') {
    const wait = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, waitKey, inputSchema: CONT_SCHEMA },
    });
    expect(wait.status).toBe(200);
    return wait.body.waitId as string;
  }

  async function resumeOpComposite(operationId: string, waitId: string, answer: unknown, expectedStateVersion: number) {
    return http(baseUrl, `/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId, input: { answer }, expectedStateVersion },
    });
  }

  // --- RUN-05: fan-out children, exactly-once join, no deadlock ---

  test('RUN-05 composite: fan-out → children complete → join closes → parent resumes to terminal SUCCEEDED', async () => {
    const root = await claimRootComposite('w37c-join-full', 'w37c-join-w');
    const spawnRes = await spawnComposite(root.taskId, root.leaseEpoch, childSpecsComposite(2));
    expect(spawnRes.status).toBe(202);
    const childIds = spawnRes.body.childTaskIds as string[];
    expect(childIds).toHaveLength(2);
    expect((await getOpComposite(root.operationId)).state).toBe('WAITING_CHILDREN');

    // Drive children to SUCCEEDED via real claim + complete.
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const byTask = new Map(jobs.map((j) => [(j.data as { taskId: string }).taskId, j.data as { deliveryId: string }]));
    for (const [idx, childId] of childIds.entries()) {
      const delivery = byTask.get(childId);
      expect(delivery).toBeDefined();
      const claim = await http(baseUrl, `/api/runtime/v1/tasks/${childId}/claim`, {
        method: 'POST',
        headers: rtHeaders(),
        body: { deliveryId: (delivery as { deliveryId: string }).deliveryId, workerInstanceId: `w37c-c-${idx}` },
      });
      expect(claim.status).toBe(200);
      const done = await completeComposite(childId, claim.body.leaseEpoch as number, `ref://w37c-${idx}`);
      expect(done.status).toBe(200);
    }

    // Join closed: parent QUEUED with merged join summary, continuation emitted once.
    const parentRow = await app.db.query<{ state: string; payload_ref: { joinSummary: Record<string, string> } }>(
      'SELECT state, payload_ref FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(parentRow.rows[0]!.state).toBe('QUEUED');
    expect(parentRow.rows[0]!.payload_ref.joinSummary).toMatchObject({
      'shard-0': 'ref://w37c-0',
      'shard-1': 'ref://w37c-1',
    });
    const cont = await app.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox
       WHERE aggregate_id=$1 AND type='task.continuation' AND delivery_id=$2`,
      [root.taskId, `${root.taskId}:join:2`]
    );
    expect(cont.rows[0]!.n).toBe('1');

    // Continuation is re-dispatched to a worker: claim the parent and finish it.
    await app.dispatcher.dispatchOnce();
    const rejob = await findJobForOperation(root.operationId);
    expect(rejob.taskId).toBe(root.taskId);
    const reclaim = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: rejob.deliveryId, workerInstanceId: 'w37c-join-w' },
    });
    expect(reclaim.status).toBe(200);
    const fin = await completeComposite(root.taskId, reclaim.body.leaseEpoch as number, 'ref://w37c-final');
    expect(fin.status).toBe(200);
    expect(fin.body.operationState).toBe('SUCCEEDED');

    // Operation is terminally SUCCEEDED with a result.
    const opFinal = await getOpComposite(root.operationId);
    expect(opFinal.state).toBe('SUCCEEDED');
    const result = await http(baseUrl, `/api/v1/operations/${root.operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(result.status).toBe(200);
    expect((result.body.data as { resultRef?: string }).resultRef).toBe('ref://w37c-final');
  });

  test('RUN-05 composite (concurrency=1): concurrent child completions emit exactly one continuation, no deadlock', async () => {
    const root = await claimRootComposite('w37c-join-conc', 'w37c-conc-w');
    const spawnRes = await spawnComposite(root.taskId, root.leaseEpoch, childSpecsComposite(2));
    expect(spawnRes.status).toBe(202);
    const childIds = spawnRes.body.childTaskIds as string[];

    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const byTask = new Map(jobs.map((j) => [(j.data as { taskId: string }).taskId, j.data as { deliveryId: string }]));
    const epochs: number[] = [];
    for (const [idx, childId] of childIds.entries()) {
      const claim = await http(baseUrl, `/api/runtime/v1/tasks/${childId}/claim`, {
        method: 'POST',
        headers: rtHeaders(),
        body: {
          deliveryId: (byTask.get(childId) as { deliveryId: string }).deliveryId,
          workerInstanceId: `w37c-race-${idx}`,
        },
      });
      expect(claim.status).toBe(200);
      epochs.push(claim.body.leaseEpoch as number);
    }

    // Fire both completions concurrently with Promise.all: parent row FOR
    // UPDATE serializes the two join reconciliations — no deadlock, single
    // continuation. This is the concurrency=1-no-deadlock composite proof.
    const [doneA, doneB] = await Promise.all([
      completeComposite(childIds[0]!, epochs[0]!, 'ref://w37c-race-0'),
      completeComposite(childIds[1]!, epochs[1]!, 'ref://w37c-race-1'),
    ]);
    expect(doneA.status).toBe(200);
    expect(doneB.status).toBe(200);
    const states = [doneA.body.operationState, doneB.body.operationState].sort();
    expect(states).toContain('QUEUED');

    const cont = await app.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox
       WHERE aggregate_id=$1 AND type='task.continuation' AND delivery_id=$2`,
      [root.taskId, `${root.taskId}:join:2`]
    );
    expect(cont.rows[0]!.n).toBe('1');
  });

  test('RUN-05 composite: one child failure fails the parent join, cancels the sibling, operation FAILED', async () => {
    const root = await claimRootComposite('w37c-join-fail', 'w37c-ff-w');
    const spawnRes = await spawnComposite(root.taskId, root.leaseEpoch, childSpecsComposite(2));
    expect(spawnRes.status).toBe(202);
    const childIds = spawnRes.body.childTaskIds as string[];

    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const byTask = new Map(jobs.map((j) => [(j.data as { taskId: string }).taskId, j.data as { deliveryId: string }]));
    const claim0 = await http(baseUrl, `/api/runtime/v1/tasks/${childIds[0]}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: (byTask.get(childIds[0]!) as { deliveryId: string }).deliveryId, workerInstanceId: 'w37c-ff-w' },
    });
    expect(claim0.status).toBe(200);

    // Child 0 fails permanently → join fails all-success policy.
    const failed = await http(baseUrl, `/api/runtime/v1/tasks/${childIds[0]}/fail`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: claim0.body.leaseEpoch, errorCode: 'E_W37C_CHILD', retryable: false },
    });
    expect(failed.status).toBe(200);
    expect(failed.body.operationState).toBe('FAILED');

    const parentRow = await app.db.query<{ state: string; error_code: string }>(
      'SELECT state, error_code FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(parentRow.rows[0]).toMatchObject({ state: 'FAILED', error_code: 'JOIN_FAILED' });
    const siblingRow = await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [childIds[1]]);
    expect(siblingRow.rows[0]!.state).toBe('CANCELLED');

    const op = await getOpComposite(root.operationId);
    expect(op.state).toBe('FAILED');

    // Failed join offers no result: 409.
    const result = await http(baseUrl, `/api/v1/operations/${root.operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(result.status).toBe(409);
  });

  // --- RUN-06: human wait lifecycle ---

  test('RUN-06 composite: wait OPEN → resume ANSWERED → task QUEUED → completion SUCCEEDED', async () => {
    const root = await claimRootComposite('w37c-wait-full', 'w37c-wait-w');
    const waitId = await openWaitComposite(root.taskId, root.leaseEpoch);
    expect(waitId).toMatch(/^wait_/);
    const opWaiting = await getOpComposite(root.operationId);
    expect(opWaiting.state).toBe('WAITING_INPUT');

    // Stale CAS → 409.
    const stale = await resumeOpComposite(root.operationId, waitId, 'yes', opWaiting.stateVersion - 1);
    expect(stale.status).toBe(409);

    // Duplicate resume is a 200 replay (idempotent) — first complete the resume.
    const resume = await resumeOpComposite(root.operationId, waitId, 'yes', opWaiting.stateVersion);
    expect(resume.status).toBe(202);
    expect(resume.body.replayed).toBe(false);

    const opAfter = await getOpComposite(root.operationId);
    expect(opAfter.state).toBe('QUEUED');
    expect(opAfter.stateVersion).toBe(opWaiting.stateVersion + 1);

    // Wait row is now ANSWERED.
    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId]
    );
    expect(waitRow.rows[0]!.status).toBe('ANSWERED');

    // Duplicate resume of the same (answered) wait → 200 replayed.
    const dup = await resumeOpComposite(root.operationId, waitId, 'yes', opAfter.stateVersion);
    expect(dup.status).toBe(200);
    expect(dup.body.replayed).toBe(true);

    // Task was re-queued and is claimable; drive to terminal SUCCEEDED.
    await app.dispatcher.dispatchOnce();
    const rejob = await findJobForOperation(root.operationId);
    expect(rejob.taskId).toBe(root.taskId);
    const reclaim = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: rejob.deliveryId, workerInstanceId: 'w37c-wait-w' },
    });
    expect(reclaim.status).toBe(200);
    const fin = await completeComposite(root.taskId, reclaim.body.leaseEpoch as number, 'ref://w37c-resumed');
    expect(fin.status).toBe(200);
    expect(fin.body.operationState).toBe('SUCCEEDED');
  });

  test('RUN-06 composite: unknown wait → 404; terminal operation resume → 409', async () => {
    const root = await claimRootComposite('w37c-wait-edge', 'w37c-edge-w');
    const waitId = await openWaitComposite(root.taskId, root.leaseEpoch);
    const op = await getOpComposite(root.operationId);

    // Unknown waitId → 404.
    const unknown = await resumeOpComposite(root.operationId, `wait_${randomUUID()}`, 'x', op.stateVersion);
    expect(unknown.status).toBe(404);

    // Complete the wait, then a late resume on the terminal op fails closed.
    const resume = await resumeOpComposite(root.operationId, waitId, 'yes', op.stateVersion);
    expect(resume.status).toBe(202);
    await app.dispatcher.dispatchOnce();
    const rejob = await findJobForOperation(root.operationId);
    const reclaim = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: rejob.deliveryId, workerInstanceId: 'w37c-edge-w' },
    });
    expect(reclaim.status).toBe(200);
    const fin = await completeComposite(root.taskId, reclaim.body.leaseEpoch as number, 'ref://w37c-edge');
    expect(fin.status).toBe(200);
    expect(fin.body.operationState).toBe('SUCCEEDED');

    const opFinal = await getOpComposite(root.operationId);
    expect(opFinal.state).toBe('SUCCEEDED');
    // Resume on a terminal operation → 409 (fails closed, no state churn).
    const late = await resumeOpComposite(root.operationId, waitId, 'late', opFinal.stateVersion);
    expect(late.status).toBe(409);
  });

  // --- RUN-07: deadline sweep + cancel close waits, cancel-then-resume fails closed ---

  test('RUN-07 composite: deadline sweep closes OPEN waits to EXPIRED and terminals the operation', async () => {
    const root = await claimRootComposite('w37c-deadline-full', 'w37c-dl-w');
    const waitId = await openWaitComposite(root.taskId, root.leaseEpoch);
    expect((await getOpComposite(root.operationId)).state).toBe('WAITING_INPUT');

    // Force a past deadline and sweep via the admin endpoint.
    await app.db.query(
      "UPDATE operations SET deadline_at = now() - interval '1 minute' WHERE id=$1",
      [root.operationId]
    );
    const sweep = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(sweep.status).toBe(200);
    expect(sweep.body.timedOut).toBeGreaterThanOrEqual(1);

    // All three closings are proven in one case: wait EXPIRED, task CANCELLED, op TIMED_OUT.
    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId]
    );
    expect(waitRow.rows[0]!.status).toBe('EXPIRED');
    const taskRow = await app.db.query<{ state: string }>(
      'SELECT state FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(taskRow.rows[0]!.state).toBe('CANCELLED');
    const op = await getOpComposite(root.operationId);
    expect(op.state).toBe('TIMED_OUT');

    // Result after TIMED_OUT → 410 (docs 06 expired semantics).
    const result = await http(baseUrl, `/api/v1/operations/${root.operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(result.status).toBe(410);

    // Resume after deadline expiry fails closed 409 (wait is EXPIRED, op terminal).
    const late = await resumeOpComposite(root.operationId, waitId, 'late', op.stateVersion);
    expect(late.status).toBe(409);
  });

  test('RUN-07 composite: cancel closes OPEN waits to CANCELLED and blocks later resume (fail closed)', async () => {
    const root = await claimRootComposite('w37c-cancel-full', 'w37c-cc-w');
    const waitId = await openWaitComposite(root.taskId, root.leaseEpoch);
    expect((await getOpComposite(root.operationId)).state).toBe('WAITING_INPUT');

    const cancel = await http(baseUrl, `/api/v1/operations/${root.operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { reason: 'w37c composite' },
    });
    expect(cancel.status).toBe(202);
    expect(cancel.body.replayed).toBe(false);

    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId]
    );
    expect(waitRow.rows[0]!.status).toBe('CANCELLED');
    const op = await getOpComposite(root.operationId);
    expect(op.state).toBe('CANCELLED');

    // Task is terminally CANCELLED too.
    const taskRow = await app.db.query<{ state: string }>(
      'SELECT state FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(taskRow.rows[0]!.state).toBe('CANCELLED');

    // Cancel-then-resume fails closed: 409, no state churn.
    const late = await resumeOpComposite(root.operationId, waitId, 'late', op.stateVersion);
    expect(late.status).toBe(409);

    // Cancel replay stays idempotent (200 replay).
    const replay = await http(baseUrl, `/api/v1/operations/${root.operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: {},
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
  });
});

describe('W38-A6: P2-09 health and graceful shutdown', () => {
  beforeAll(async () => {
    // Clear any uncompleted RUNNING tasks from prior test cases so active lease baseline is 0
    await app.db.query("UPDATE tasks SET state='CANCELLED' WHERE state='RUNNING'");
  });

  test('health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases', async () => {
    const resHealth = await http(baseUrl, '/health');
    expect(resHealth.status).toBe(200);
    expect(resHealth.body).toEqual({
      status: 'ok',
      db: true,
      redis: true,
      activeLeases: expect.any(Number),
    });

    const resV1 = await http(baseUrl, '/api/v1/health');
    expect(resV1.status).toBe(200);
    expect(resV1.body).toEqual({
      status: 'ok',
      db: true,
      redis: true,
      activeLeases: expect.any(Number),
    });

    // Active lease count reflects RUNNING tasks
    const initialLeases = resV1.body.activeLeases as number;
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'w38-health-count' } },
    });
    expect(submit.status).toBe(202);
    const opId = submit.body.operationId as string;
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(opId);

    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: 'w38-health-worker' },
    });
    expect(claim.status).toBe(200);

    const duringRunning = await http(baseUrl, '/api/v1/health');
    expect(duringRunning.status).toBe(200);
    expect(duringRunning.body.activeLeases).toBe(initialLeases + 1);

    // Complete the task and verify active lease count decrements
    const done = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: {
        leaseEpoch: claim.body.leaseEpoch as number,
        resultRef: 'ref://w38-health',
        resultHash: contentHash('ref://w38-health'),
      },
    });
    expect(done.status).toBe(200);

    const afterComplete = await http(baseUrl, '/api/v1/health');
    expect(afterComplete.status).toBe(200);
    expect(afterComplete.body.activeLeases).toBe(initialLeases);
  });

  test('health endpoint returns 503 degraded when DB or Redis is unreachable', async () => {
    // Simulated DB failure
    const dbSpy = jest.spyOn(app.db, 'query').mockImplementationOnce(() => {
      throw new Error('simulated DB connection failure');
    });
    const resDegradedDb = await http(baseUrl, '/api/v1/health');
    expect(resDegradedDb.status).toBe(503);
    expect(resDegradedDb.body).toEqual({
      status: 'degraded',
      db: false,
      redis: true,
      activeLeases: 0,
    });
    dbSpy.mockRestore();

    // Simulated Redis failure
    const redisSpy = jest.spyOn(app.redis, 'ping').mockImplementationOnce(async () => {
      throw new Error('simulated Redis ping failure');
    });
    const resDegradedRedis = await http(baseUrl, '/api/v1/health');
    expect(resDegradedRedis.status).toBe(503);
    expect(resDegradedRedis.body).toEqual({
      status: 'degraded',
      db: true,
      redis: false,
      activeLeases: expect.any(Number),
    });
    redisSpy.mockRestore();
  });

  test('drain stops accepting new claims and close() waits for active leases to complete', async () => {
    // Spin up an isolated App instance to test graceful close() lifecycle
    const testApp = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      workerIdentityTokensByBusiness: { [MANIFEST.businessId]: WORKER_IDENTITY_TOKEN },
      adminToken: ADMIN_TOKEN,
      usageToken: USAGE_TOKEN,
      invocationGrantSecret: GRANT_SECRET,
      autoDispatch: false,
      autoMigrate: false,
    });
    const testServer = await testApp.listen();
    const testPort = (testServer.address() as { port: number }).port;
    const testBaseUrl = `http://127.0.0.1:${testPort}`;

    // Submit an operation and claim it
    const submit = await http(testBaseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'w38-drain-complete' } },
    });
    expect(submit.status).toBe(202);
    const opId = submit.body.operationId as string;
    await testApp.dispatcher.dispatchOnce();

    const q = testApp.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === opId);
    expect(job).toBeDefined();
    const payload = job!.data as { taskId: string; deliveryId: string };

    const claim = await http(testBaseUrl, `/api/runtime/v1/tasks/${payload.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: payload.deliveryId, workerInstanceId: 'w38-drain-worker' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;

    // Verify claimTask is rejected once draining is set
    testApp.runtime.setDraining(true);
    const rejectedClaim = await http(testBaseUrl, `/api/runtime/v1/tasks/${payload.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: payload.deliveryId, workerInstanceId: 'w38-drain-worker' },
    });
    expect(rejectedClaim.status).toBe(503);
    expect(rejectedClaim.body.code).toBe('SHUTTING_DOWN');

    // While draining, complete the task in-flight after 150ms
    setTimeout(async () => {
      await http(testBaseUrl, `/api/runtime/v1/tasks/${payload.taskId}/complete`, {
        method: 'POST',
        headers: rtHeaders(),
        body: {
          leaseEpoch,
          resultRef: 'ref://w38-drained',
          resultHash: contentHash('ref://w38-drained'),
        },
      });
    }, 150);

    const start = Date.now();
    await testApp.close({ timeoutMs: 5000, pollIntervalMs: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(4500);

    // Verify task completed in DB using app.db (still open)
    const taskRow = await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [payload.taskId]);
    expect(taskRow.rows[0]?.state).toBe('SUCCEEDED');
  });

  test('graceful shutdown force-closes when active lease exceeds timeout', async () => {
    const testApp = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      workerIdentityTokensByBusiness: { [MANIFEST.businessId]: WORKER_IDENTITY_TOKEN },
      adminToken: ADMIN_TOKEN,
      usageToken: USAGE_TOKEN,
      invocationGrantSecret: GRANT_SECRET,
      autoDispatch: false,
      autoMigrate: false,
    });
    const testServer = await testApp.listen();
    const testPort = (testServer.address() as { port: number }).port;
    const testBaseUrl = `http://127.0.0.1:${testPort}`;

    const submit = await http(testBaseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'w38-drain-timeout' } },
    });
    expect(submit.status).toBe(202);
    const opId = submit.body.operationId as string;
    await testApp.dispatcher.dispatchOnce();

    const q = testApp.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === opId);
    expect(job).toBeDefined();
    const payload = job!.data as { taskId: string; deliveryId: string };

    const claim = await http(testBaseUrl, `/api/runtime/v1/tasks/${payload.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: payload.deliveryId, workerInstanceId: 'w38-timeout-worker' },
    });
    expect(claim.status).toBe(200);

    // Active lease remains RUNNING — close() with short 200ms timeout must force-close
    const start = Date.now();
    await testApp.close({ timeoutMs: 200, pollIntervalMs: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);

    // Clean up leftover running task using app.db
    await app.db.query("UPDATE tasks SET state='CANCELLED' WHERE id=$1", [payload.taskId]);
  });
});
});
