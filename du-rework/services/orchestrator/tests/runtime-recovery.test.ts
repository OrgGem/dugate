/**
 * CONV-07: W30-C expired-lease recovery — split out of runtime.test.ts.
 *
 * Cases verbatim; own explicit fixture (per-suite namespace: schema, Redis
 * DB, businessId, queue, port 0) via tests/helpers/runtime-harness. Without
 * DU_LIVE_INFRA=1 nothing boots — no createApp, no listen, no connection.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { createApp, type App } from '../src/server';
import { contentHash } from '@du/contracts';
import { createRuntimeFixture, liveDescribe, warnIfSkipped } from './helpers/runtime-harness';

const F = createRuntimeFixture({ suite: 'recovery' });
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

warnIfSkipped('runtime-recovery.test.ts');

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
  beforeAll(async () => {
    ({ app, baseUrl, queueName } = await F.setup());
  }, 120_000);

  afterAll(async () => {
    await F.teardown();
  }, 30_000);

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
});
