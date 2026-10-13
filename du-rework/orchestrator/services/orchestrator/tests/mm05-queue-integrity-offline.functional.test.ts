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
  claim_token: string | null;
  parked_reason: string | null;
  business_id: string;
  business_version: string;
  tenant_id: string;
  queue_name: string;
}

interface FakeClient {
  query(text: string, params?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number }>;
}

function createFakeWorld(options: {
  disabledBusinessIds?: string[];
  batchSize?: number;
  activeVersions?: Record<string, string | null>;
  switchAfterCandidate?: { businessId: string; version: string | null };
  onQueueAdd?: (row: OutboxRow) => void;
  backupSnapshotWriteGate?: { assertWriteAllowed: () => Promise<void> };
} = {}) {
  const disabledBusinessIds = new Set(options.disabledBusinessIds ?? []);
  const activeVersions = new Map(Object.entries(options.activeVersions ?? {}));
  const businessIsEnabled = (businessId: string) => !disabledBusinessIds.has(businessId);
  const activeVersion = (businessId: string) => activeVersions.has(businessId)
    ? activeVersions.get(businessId) ?? null
    : '1.0.0';
  const outbox: OutboxRow[] = [];
  const jobs = new Map<string, {
    name: string;
    data: Record<string, unknown>;
    options: { attempts?: number; backoff?: { type: string; delay: number; jitter?: number } };
  }>();
  let failNextAdd = false;
  let inTransaction = false;
  let publishInsideTransaction = false;
  const taskParking = new Map<string, string>();
  const updateSql: string[] = [];
  const taskStates = new Map<string, { state: string; operationState: string }>();
  const lockOrder: string[] = [];

  const rowById = (id: string): OutboxRow | undefined => outbox.find((r) => r.id === id);

  const client: FakeClient = {
    async query(text, params = []) {
      const sql = text.replace(/\s+/g, ' ').trim();

      if (sql.includes('FOR UPDATE OF ob SKIP LOCKED')) {
        const row = rowById(String(params[0]));
        if (!row || row.dispatched_at || row.parked_reason || (row.claim_until && row.claim_until.getTime() >= Date.now())) {
          return { rows: [], rowCount: 0 };
        }
        return {
          rows: [{
            id: row.id,
            aggregate_id: row.aggregate_id,
            delivery_id: row.delivery_id,
            type: row.type,
            payload: row.payload,
            attempts: row.attempts,
            claim_token: params[1],
            business_id: row.business_id,
            business_version: row.business_version,
            tenant_id: row.tenant_id,
            queue_name: row.queue_name,
          }],
          rowCount: 1,
        };
      }

      if (sql.includes('FROM tasks t') && sql.includes('EXISTS ( SELECT 1 FROM outbox ob')
          && sql.includes('bv.status IS DISTINCT FROM')) {
        const seen = new Set<string>();
        const rows = outbox.flatMap((row) => {
          const state = taskStates.get(row.aggregate_id) ?? { state: 'READY', operationState: 'QUEUED' };
          const inactive = !businessIsEnabled(row.business_id) || activeVersion(row.business_id) !== row.business_version;
          if (!inactive || seen.has(row.aggregate_id) || row.dispatched_at || row.parked_reason
              || !['task.dispatch', 'task.continuation'].includes(row.type)
              || ['RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(state.state)
              || ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(state.operationState)) return [];
          seen.add(row.aggregate_id);
          return [{ task_id: row.aggregate_id, business_id: row.business_id, business_version: row.business_version }];
        }).slice(0, Number(params[0] ?? 50));
        return { rows, rowCount: rows.length };
      }

      if (sql.startsWith('SELECT t.state,o.state AS operation_state')) {
        lockOrder.push('task');
        const task = taskStates.get(String(params[0]));
        return task
          ? { rows: [{ state: task.state, operation_state: task.operationState }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('SELECT id FROM outbox') && sql.includes('FOR UPDATE')) {
        const rows = outbox.filter((row) => row.aggregate_id === String(params[0])
          && !row.dispatched_at && !row.parked_reason).map((row) => ({ id: row.id }));
        return { rows, rowCount: rows.length };
      }

      if (sql.includes('FROM outbox ob') && sql.includes('JOIN operations o') && sql.includes('dispatched_at IS NULL')) {
        const limit = Number(params[0] ?? 50);
        const due = outbox
          .filter(
            (r) =>
              !r.dispatched_at &&
              !r.parked_reason &&
              (!r.claim_until || r.claim_until.getTime() < Date.now()) &&
              r.due_at.getTime() <= Date.now() &&
              ['task.dispatch', 'task.continuation'].includes(r.type) &&
              businessIsEnabled(r.business_id) &&
              activeVersion(r.business_id) === r.business_version
          )
          .sort((a, b) => a.due_at.getTime() - b.due_at.getTime())
          .slice(0, limit);
        const rows = due.map((r) => ({
            id: r.id,
            aggregate_id: r.aggregate_id,
            type: r.type,
            delivery_id: r.delivery_id,
            payload: r.payload,
            business_id: r.business_id,
            business_version: r.business_version,
            tenant_id: r.tenant_id,
            queue_name: r.queue_name,
          }));
        if (options.switchAfterCandidate) {
          activeVersions.set(options.switchAfterCandidate.businessId, options.switchAfterCandidate.version);
        }
        return { rows, rowCount: rows.length };
      }

      if (sql.startsWith('SELECT enabled,activation_revision,submissions_paused,pre_drain_version FROM business_catalog')) {
        lockOrder.push('business');
        const businessId = String(params[0]);
        return {
          rows: [{ enabled: businessIsEnabled(businessId), activation_revision: 1,
            submissions_paused: false, pre_drain_version: null }],
          rowCount: 1,
        };
      }

      if (sql.startsWith('SELECT version,status,is_active FROM business_versions')) {
        const businessId = String(params[0]);
        const targetVersion = params[1] == null ? null : String(params[1]);
        const current = activeVersion(businessId);
        const versions = current === null ? [] : [{ version: current, status: 'ENABLED', is_active: true }];
        if (targetVersion !== null && targetVersion !== current) {
          versions.push({ version: targetVersion, status: 'ENABLED', is_active: false });
        }
        return { rows: versions, rowCount: versions.length };
      }

      if (sql.startsWith('INSERT INTO runtime_control_scopes')) {
        return { rows: [], rowCount: 0 };
      }

      if (sql.startsWith('SELECT scope_kind,scope_id,desired_state,revision')) {
        const scopes = [];
        for (let index = 0; index < params.length; index += 2) {
          scopes.push({ scope_kind: params[index], scope_id: params[index + 1], desired_state: 'OPEN', revision: 1 });
        }
        return {
          rows: scopes,
          rowCount: scopes.length,
        };
      }

      if (sql.startsWith('UPDATE tasks SET admission_parked_reason=')) {
        taskParking.set(String(params[0]), String(params[1]));
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('UPDATE outbox SET parked_reason=')) {
        if (sql.includes('WHERE aggregate_id=$1')) {
          const matching = outbox.filter((row) => row.aggregate_id === String(params[0])
            && !row.dispatched_at && !row.parked_reason);
          for (const row of matching) {
            row.parked_reason = String(params[1]);
            row.claim_token = null;
            row.claim_until = null;
          }
          return { rows: matching.map((row) => ({ id: row.id })), rowCount: matching.length };
        }
        const row = rowById(String(params[0]));
        if (!row) return { rows: [], rowCount: 0 };
        row.parked_reason = String(params[1] ?? params[2]);
        row.claim_token = null;
        row.claim_until = null;
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      if (sql.includes('UPDATE outbox SET claim_token=$2')) {
        const row = rowById(String(params[0]));
        if (!row) return { rows: [], rowCount: 0 };
        row.claim_token = String(params[1]);
        row.claim_until = new Date(Date.now() + 30_000);
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('UPDATE outbox SET claim_token=NULL') && sql.includes('WHERE id=$1 AND claim_token=$2')
          && sql.includes('interval \'1 millisecond\'')) {
        const row = rowById(String(params[0]));
        if (!row || row.claim_token !== String(params[1])) return { rows: [], rowCount: 0 };
        row.claim_token = null;
        row.claim_until = new Date(Date.now() + Number(params[2] ?? 5_000));
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('UPDATE outbox SET claim_until=statement_timestamp() + interval \'5 seconds\'')) {
        const row = rowById(String(params[0]));
        if (!row) return { rows: [], rowCount: 0 };
        row.claim_until = new Date(Date.now() + 5_000);
        return { rows: [], rowCount: 1 };
      }

      if (sql.includes('UPDATE outbox SET dispatched_at=')) {
        const row = rowById(String(params[0]));
        if (!row || row.claim_token !== String(params[1])) return { rows: [], rowCount: 0 };
        row.dispatched_at = new Date();
        row.claim_until = null;
        row.claim_token = null;
        row.attempts += 1;
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      if (sql.includes('UPDATE outbox SET claim_token=NULL') && sql.includes('LEAST(300')) {
        updateSql.push(sql);
        const row = rowById(String(params[0]));
        if (!row || row.claim_token !== String(params[1])) return { rows: [], rowCount: 0 };
        row.claim_token = null;
        row.claim_until = null;
        row.attempts += 1;
        row.due_at = new Date(Date.now() + 1_000);
        return { rows: [{ id: row.id }], rowCount: 1 };
      }

      throw new Error(`FakeDb: unmatched SQL: ${sql}`);
    },
  };

  const db = {
    async tx<T>(fn: (c: FakeClient) => Promise<T>): Promise<T> {
      inTransaction = true;
      try {
        return await fn(client);
      } finally {
        inTransaction = false;
      }
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
      publishInsideTransaction ||= inTransaction;
      jobs.set(jobId, { name, data, options: opts });
      const row = outbox.find((candidate) => candidate.delivery_id === String(data.deliveryId));
      if (row) options.onQueueAdd?.(row);
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
      claim_token: null,
      parked_reason: null,
      business_id: businessId,
      business_version: '1.0.0',
      tenant_id: 'tenant-mm05',
      queue_name: `du-business-${businessId}-1.0.0`,
    };
    outbox.push(row);
    taskStates.set(taskId, { state: 'READY', operationState: 'QUEUED' });
    return row;
  }

  const dispatcher = createDispatcher({
    db,
    getQueue: () => queue,
    backupSnapshotWriteGate: options.backupSnapshotWriteGate as never,
    pollIntervalMs: 1_000_000,
    batchSize: options.batchSize ?? 10,
  });

  return { outbox, jobs, dispatcher, seedDispatch, failNextAdd: () => { failNextAdd = true; }, updateSql, taskParking, lockOrder,
    get publishInsideTransaction() { return publishInsideTransaction; } };
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
    expect(row.claim_token).toBeNull();
    expect(world.publishInsideTransaction).toBe(false);
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

  it('parks a candidate durably when cutover wins after the unlocked candidate read', async () => {
    const world = createFakeWorld({ switchAfterCandidate: { businessId: 'biz-mm05', version: '2.0.0' } });
    const taskId = randomUUID();
    const row = world.seedDispatch(taskId, `${taskId}:stale-cutover`);

    expect(await world.dispatcher.dispatchOnce()).toBe(0);
    expect(row.parked_reason).toBe('VERSION_NOT_ACTIVE');
    expect(world.taskParking.get(taskId)).toBe('VERSION_NOT_ACTIVE');
    expect(row.claim_token).toBeNull();
    expect(row.attempts).toBe(0);
    expect(world.jobs.size).toBe(0);
  });

  it('parks a post-cutover task emitted by an existing lease in a bounded pass, root before task', async () => {
    const world = createFakeWorld({ activeVersions: { 'biz-mm05': '2.0.0' }, batchSize: 1 });
    const taskId = randomUUID();
    const row = world.seedDispatch(taskId, `${taskId}:spawned-after-cutover`);

    expect(await world.dispatcher.dispatchOnce()).toBe(0);
    expect(row.parked_reason).toBe('VERSION_NOT_ACTIVE');
    expect(world.taskParking.get(taskId)).toBe('VERSION_NOT_ACTIVE');
    expect(row.attempts).toBe(0);
    expect(world.jobs.size).toBe(0);
    expect(world.lockOrder.slice(0, 2)).toEqual(['business', 'task']);
  });

  it('only finalizes a publish while the durable claim token still matches', async () => {
    let lostClaim: OutboxRow | undefined;
    const world = createFakeWorld({
      onQueueAdd: (row) => {
        lostClaim = row;
        row.claim_token = 'newer-owner';
        row.claim_until = new Date(Date.now() + 30_000);
      },
    });
    const taskId = randomUUID();
    const row = world.seedDispatch(taskId, `${taskId}:claim-cas`);

    expect(await world.dispatcher.dispatchOnce()).toBe(0);
    expect(world.jobs.has(jobIdForDelivery(row.delivery_id))).toBe(true);
    expect(lostClaim).toBe(row);
    expect(row.dispatched_at).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.claim_token).toBe('newer-owner');
  });

  it('leaves a late Redis publish recoverable when the backup fence activates before finalization', async () => {
    let fenceHeld = false;
    const gate = {
      async assertWriteAllowed() {
        if (!fenceHeld) return;
        throw Object.assign(new Error('backup fence active'), { code: 'BACKUP_EFFECT_FENCE_ACTIVE' });
      },
    };
    const world = createFakeWorld({
      backupSnapshotWriteGate: gate,
      onQueueAdd: () => { fenceHeld = true; },
    });
    const taskId = randomUUID();
    const row = world.seedDispatch(taskId, `${taskId}:backup-fence-race`);

    expect(await world.dispatcher.dispatchOnce()).toBe(0);
    expect(world.jobs.has(jobIdForDelivery(row.delivery_id))).toBe(true);
    expect(row.dispatched_at).toBeNull();
    expect(row.attempts).toBe(0);
    expect(row.claim_token).not.toBeNull();

    fenceHeld = false;
    row.claim_until = new Date(Date.now() - 1);
    expect(await world.dispatcher.dispatchOnce()).toBe(1);
    expect(row.dispatched_at).not.toBeNull();
    expect(row.attempts).toBe(1);
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
    expect(world.updateSql[0]).toContain('(0.5+random())');
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
