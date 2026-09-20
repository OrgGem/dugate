import { createHash, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { createApp, type App } from '../src/server';
import { contentHash } from '@du/contracts';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const RUNTIME_TOKEN = 'test-runtime-token-' + randomUUID();
const RAW_API_KEY = 'du_test_' + randomUUID().replace(/-/g, '');
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

const MANIFEST = {
  contractVersion: '1' as const,
  businessId: 'test-biz',
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
      connectorSlots: [],
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
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, body, headers };
}

let app: App;
let baseUrl: string;
let queueName: string;

beforeAll(async () => {
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    runtimeToken: RUNTIME_TOKEN,
    autoDispatch: false, // tests drive dispatchOnce() explicitly
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
  await app.redis.flushdb();

  // Isolate: clear business state left by any prior run so dispatchOnce only
  // ever sees this suite's rows (deterministic batch assertions below).
  await app.db.query(
    `TRUNCATE step_checkpoints, outbox, task_dependencies, tasks, submission_keys, operations RESTART IDENTITY CASCADE`
  );

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
}, 30_000);

function rtHeaders(): Record<string, string> {
  return { authorization: `Bearer ${RUNTIME_TOKEN}` };
}
function pubHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { 'x-api-key': RAW_API_KEY, ...extra };
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

    // Idempotent dispatch: second sweep does not re-enqueue same delivery
    const again = await app.dispatcher.dispatchOnce();
    expect(again).toBe(0);

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
});
