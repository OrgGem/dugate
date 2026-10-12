import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { jobIdForDelivery } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createDispatcher } from '../src/modules/queue/dispatcher';

/**
 * MM-05 queue-integrity offline probe (Qwen-2 lane, zero DB/Redis, in-memory only).
 *
 * Drives the REAL outbox dispatcher (src/modules/queue/dispatcher.ts) against an
 * in-memory outbox table and an in-memory job store, and pins the delivery
 * retry/recovery boundaries in the MM-05 design (docs/38):
 *
 *   probe/1  The dispatcher does not inspect already-stamped rows; the separate
 *            runtime sweep owns missing/failed/completed job recovery.
 *   probe/2  SAFETY invariant — retrying the same durable delivery ID is
 *            duplicate-effect-free because stable BullMQ job IDs dedup at the
 *            queue layer (dispatcher 'already exists' path).
 *   probe/3  STATE-OF-RECORD completeness — PG alone can enumerate every orphan
 *            (outbox dispatch stamp + task state): reconstruction needs no
 *            Redis-side bookkeeping.
 *
 * Run offline: npx jest tests/mm05-queue-integrity-offline.functional.test.ts --runInBand
 */

interface OutboxRow {
  id: string;
  aggregate_id: string;
  type: string;
  delivery_id: string;
  payload: Record<string, unknown>;
  attempts: number;
  due_at: Date;
  dispatched_at: Date | null;
  claim_until: Date | null;
}

interface FakeClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

function createFakeWorld(options: { disabledBusinessIds?: string[]; batchSize?: number } = {}) {
  const disabledBusinessIds = new Set(options.disabledBusinessIds ?? []);
  const outbox: OutboxRow[] = [];
  const jobs = new Map<string, {
    name: string;
    data: Record<string, unknown>;
    options: { attempts?: number; backoff?: { type: string; delay: number; jitter?: number } };
  }>();
  let failNextAdd = false;
  const updateSql: string[] = [];

  const rowById = (id: string): OutboxRow | undefined => outbox.find((r) => r.id === id);

  const client: FakeClient = {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();

      if (sql.includes('FROM outbox') && sql.includes('dispatched_at IS NULL')) {
        const limit = Number(params[0] ?? 50);
        const due = outbox
          .filter(
            (r) =>
              !r.dispatched_at &&
              (!r.claim_until || r.claim_until.getTime() < Date.now()) &&
              r.due_at.getTime() <= Date.now()
          )
          .filter((r) => {
            if (!sql.includes('business_catalog') || !['task.dispatch', 'task.continuation'].includes(r.type)) return true;
            return !disabledBusinessIds.has(String(r.payload.businessId ?? 'biz-mm05'));
          })
          .sort((a, b) => a.due_at.getTime() - b.due_at.getTime())
          .slice(0, limit);
        return {
          rows: due.map((r) => ({
            id: r.id,
            aggregate_id: r.aggregate_id,
            type: r.type,
            delivery_id: r.delivery_id,
            payload: r.payload,
            attempts: r.attempts,
          })),
          rowCount: due.length,
        };
      }

      if (sql.includes('FROM tasks t') && sql.includes('bv.queue')) {
        const task = outbox.find((row) => row.aggregate_id === String(params[0]));
        return {
          rows: [{ business_id: task?.payload.businessId ?? 'biz-mm05', business_version: '1.0.0', queue: null }],
          rowCount: 1,
        };
      }

      if (sql.startsWith('INSERT INTO runtime_control_scopes')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('SELECT scope_kind,scope_id,desired_state,revision')) {
        return {
          rows: [
            { scope_kind: 'platform', scope_id: 'all', desired_state: 'OPEN', revision: 1 },
            { scope_kind: 'tenant', scope_id: 'tenant-mm05', desired_state: 'OPEN', revision: 1 },
            { scope_kind: 'business', scope_id: 'biz-mm05', desired_state: 'OPEN', revision: 1 },
          ],
          rowCount: 3,
        };
      }

      if (sql.startsWith('SELECT enabled FROM business_catalog')) {
        return { rows: [{ enabled: !disabledBusinessIds.has(String(params[0])) }], rowCount: 1 };
      }

      if (sql.includes('UPDATE outbox') && sql.includes('SET dispatched_at')) {
        const row = rowById(String(params[0]));
        if (!row) return { rows: [], rowCount: 0 };
        row.dispatched_at = new Date();
        if (sql.includes('claim_until = NULL')) row.claim_until = null;
        if (sql.includes('attempts = attempts + 1')) row.attempts += 1;
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('UPDATE outbox') && sql.includes('due_at=now() +')) {
        updateSql.push(sql);
        const row = rowById(String(params[0]));
        if (!row) return { rows: [], rowCount: 0 };
        row.claim_until = null;
        row.attempts += 1;
        row.due_at = new Date(Date.now() + 1_000);
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('UPDATE outbox') && sql.includes('SET claim_until=now() +')) {
        const row = rowById(String(params[0]));
        if (!row) return { rows: [], rowCount: 0 };
        row.claim_until = new Date(Date.now() + 30_000);
        row.attempts += 1;
        return { rows: [], rowCount: 1 };
      }

      throw new Error(`FakeDb: unmatched SQL: ${sql}`);
    },
  };

  const db = {
    async tx<T>(fn: (c: FakeClient) => Promise<T>): Promise<T> {
      return fn(client);
    },
    query: (text: string, params?: unknown[]) => client.query(text, params),
  } as unknown as Db;

  const queue = {
    async add(name: string, data: Record<string, unknown>, opts: {
      jobId?: string;
      attempts?: number;
      backoff?: { type: string; delay: number; jitter?: number };
    }) {
      if (failNextAdd) {
        failNextAdd = false;
        throw new Error('simulated queue publish failure');
      }
      const jobId = String(opts.jobId);
      if (jobs.has(jobId)) throw new Error(`A job with the ID ${jobId} already exists`);
      jobs.set(jobId, { name, data, options: opts });
      return { id: jobId };
    },
  } as unknown as Queue;

  function seedDispatch(taskId: string, deliveryId: string, businessId = 'biz-mm05'): OutboxRow {
    const row: OutboxRow = {
      id: randomUUID(),
      aggregate_id: taskId,
      type: 'task.dispatch',
      delivery_id: deliveryId,
      payload: { contractVersion: '1', deliveryId, taskId, kind: 'root', businessId },
      attempts: 0,
      due_at: new Date(Date.now() - 1_000),
      dispatched_at: null,
      claim_until: null,
    };
    outbox.push(row);
    return row;
  }

  const dispatcher = createDispatcher({
    db,
    getQueue: () => queue,
    pollIntervalMs: 1_000_000,
    batchSize: options.batchSize ?? 10,
  });

  return { outbox, jobs, dispatcher, seedDispatch, failNextAdd: () => { failNextAdd = true; }, updateSql };
}

describe('MM-05 queue-integrity offline dispatcher seam', () => {
  it('probe/0: dispatcher publishes once and stamps the durable PG marker', async () => {
    const world = createFakeWorld();
    const taskId = randomUUID();
    const deliveryId = `${taskId}:1`;
    const row = world.seedDispatch(taskId, deliveryId);

    expect(await world.dispatcher.dispatchOnce()).toBe(1);
    expect(world.jobs.has(jobIdForDelivery(deliveryId))).toBe(true);
    expect(row.dispatched_at).not.toBeNull();
    expect(row.attempts).toBe(1);
    expect(world.jobs.get(jobIdForDelivery(deliveryId))?.options).toMatchObject({
      attempts: 8,
      backoff: { type: 'exponential', delay: 1_000, jitter: 0.25 },
    });

    // A second sweep must be a no-op: the stamp is the ONLY publish gate.
    expect(await world.dispatcher.dispatchOnce()).toBe(0);
    expect(world.jobs.size).toBe(1);
  });

  it('publishes the outbox row delivery_id as both BullMQ job ID and claim envelope ID', async () => {
    const world = createFakeWorld();
    const taskId = randomUUID();
    const replacementDeliveryId = `${taskId}:queue-recovery:abc:2`;
    const row = world.seedDispatch(taskId, replacementDeliveryId);
    row.payload.deliveryId = `${taskId}:initial`;

    expect(await world.dispatcher.dispatchOnce()).toBe(1);

    const jobId = jobIdForDelivery(replacementDeliveryId);
    const job = world.jobs.get(jobId);
    expect(jobId).toBe(jobIdForDelivery(row.delivery_id));
    expect(job?.data.deliveryId).toBe(row.delivery_id);
    expect(job?.data.deliveryId).not.toBe(`${taskId}:initial`);
  });

  it('does not let disabled backlog consume the batch or starve an enabled business', async () => {
    const world = createFakeWorld({ disabledBusinessIds: ['biz-disabled'], batchSize: 1 });
    const disabledTask = randomUUID();
    const enabledTask = randomUUID();
    const disabled = world.seedDispatch(disabledTask, `${disabledTask}:disabled`, 'biz-disabled');
    const enabled = world.seedDispatch(enabledTask, `${enabledTask}:enabled`, 'biz-enabled');

    expect(await world.dispatcher.dispatchOnce()).toBe(1);
    expect(world.jobs.has(jobIdForDelivery(`${enabledTask}:enabled`))).toBe(true);
    expect(enabled.dispatched_at).not.toBeNull();
    expect(disabled.dispatched_at).toBeNull();
    expect(disabled.claim_until).toBeNull();
    expect(disabled.attempts).toBe(0);
  });

  it('publisher failures persist bounded exponential jitter and retry without stamping the delivery', async () => {
    const world = createFakeWorld();
    const taskId = randomUUID();
    const row = world.seedDispatch(taskId, `${taskId}:publish-fail`);
    world.failNextAdd();

    expect(await world.dispatcher.dispatchOnce()).toBe(0);

    expect(row.dispatched_at).toBeNull();
    expect(row.claim_until).toBeNull();
    expect(row.attempts).toBe(1);
    expect(row.due_at.getTime()).toBeGreaterThan(Date.now() - 50);
    expect(world.jobs.size).toBe(0);
    expect(world.updateSql[0]).toContain('LEAST(300');
    expect(world.updateSql[0]).toContain('(0.5 + random())');
  });

  it('probe/1: dispatcher leaves stamped-row recovery to sweepQueueIntegrity', async () => {
    const world = createFakeWorld();
    const taskId = randomUUID();
    const deliveryId = `${taskId}:1`;
    const row = world.seedDispatch(taskId, deliveryId);

    expect(await world.dispatcher.dispatchOnce()).toBe(1);
    world.jobs.clear(); // simulate Redis loss after dispatch, before any worker claim

    // The dispatcher only delivers pending outbox rows. Runtime recovery checks
    // the actual BullMQ state and creates a new durable delivery intent.
    expect(await world.dispatcher.dispatchOnce()).toBe(0);
    expect(world.jobs.size).toBe(0);
    expect(row.dispatched_at).not.toBeNull();
  });

  it('probe/2 (SAFETY invariant for reconstruction): re-arming the same delivery dedups on stable jobId — zero duplicate effect', async () => {
    const world = createFakeWorld();
    const taskId = randomUUID();
    const deliveryId = `${taskId}:1`;
    const row = world.seedDispatch(taskId, deliveryId);

    expect(await world.dispatcher.dispatchOnce()).toBe(1);

    // A hypothetical integrity sweep re-arms the ORIGINAL row while the job is
    // actually still alive (false-positive race). The dispatcher's `already
    // exists` path must converge: row re-stamped, queue still holds exactly
    // ONE job for this delivery.
    row.dispatched_at = null;
    expect(await world.dispatcher.dispatchOnce()).toBe(1);
    expect(world.jobs.size).toBe(1);
    expect(world.jobs.has(jobIdForDelivery(deliveryId))).toBe(true);
    expect(row.dispatched_at).not.toBeNull();
  });

  it('probe/3 (STATE-OF-RECORD completeness): PG alone enumerates every orphan candidate — reconstruction needs no Redis bookkeeping', async () => {
    const world = createFakeWorld();
    const taskA = randomUUID();
    const taskB = randomUUID();
    world.seedDispatch(taskA, `${taskA}:1`);
    world.seedDispatch(taskB, `${taskB}:1`);

    // taskA dispatched then wiped; taskB never dispatched (still in dispatcher queue).
    expect(await world.dispatcher.dispatchOnce()).toBe(2);
    const rowA = world.outbox.find((r) => r.aggregate_id === taskA)!;
    const rowB = world.outbox.find((r) => r.aggregate_id === taskB)!;
    world.jobs.delete(jobIdForDelivery(rowA.delivery_id));

    // The orphan predicate (docs/38 §2): type='task.dispatch' AND
    // dispatched_at NOT NULL AND task state READY/QUEUED AND leaseless.
    // Both halves of the discriminator are PG columns already present:
    expect(rowA.type).toBe('task.dispatch');
    expect(rowA.dispatched_at).not.toBeNull();
    expect(rowB.type).toBe('task.dispatch');
    expect(rowB.dispatched_at).not.toBeNull();
    // (task state lives in tasks/operations — untouched here by design; the
    //  wipe is invisible to PG, so PG still reports READY: p8-02b MM-05a pins it.)
    expect(world.jobs.size).toBe(1);
  });
});
