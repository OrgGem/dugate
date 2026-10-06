/**
 * CONV-07: the runtime vertical slice (registry, task lifecycle, usage, gates) — split out of runtime.test.ts.
 *
 * Cases verbatim; own explicit fixture (per-suite namespace: schema, Redis
 * DB, businessId, queue, port 0) via tests/helpers/runtime-harness. Without
 * DU_LIVE_INFRA=1 nothing boots — no createApp, no listen, no connection.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { createApp, type App } from '../src/server';
import { contentHash, hashInvocationInput } from '@du/contracts';
import { createRuntimeFixture, liveDescribe, warnIfSkipped } from './helpers/runtime-harness';

const F = createRuntimeFixture({ suite: 'vertical' });
const MANIFEST = F.MANIFEST;
const TENANT_ID = F.TENANT_ID;
const DATABASE_URL = F.DATABASE_URL;
const REDIS_URL = F.REDIS_URL;
const RAW_API_KEY = F.RAW_API_KEY;
const RUNTIME_TOKEN = F.RUNTIME_TOKEN;
const WORKER_IDENTITY_TOKEN = F.WORKER_IDENTITY_TOKEN;
const ADMIN_TOKEN = F.ADMIN_TOKEN;
const USAGE_TOKEN = F.USAGE_TOKEN;
const GRANT_SECRET = F.GRANT_SECRET;
const http = F.http;
const hashKey = F.hashKey;
const rtHeaders = F.rtHeaders;
const adminHeaders = F.adminHeaders;
const pubHeaders = F.pubHeaders;
const usageHeaders = F.usageHeaders;
const findJobForOperation = F.findJobForOperation;
const createUsageTarget = F.createUsageTarget;
const usageEvent = F.usageEvent;

let app: App;
let baseUrl: string;
let queueName: string;

warnIfSkipped('runtime.test.ts');

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
  beforeAll(async () => {
    ({ app, baseUrl, queueName } = await F.setup());
  }, 120_000);

  afterAll(async () => {
    await F.teardown();
  }, 30_000);

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
});
