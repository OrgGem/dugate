import { randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { jobIdForDelivery } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createRuntimeService, type QueueIntegrityCandidate } from '../src/modules/runtime/runtime';

/**
 * MM-05 queue-integrity sweep — OFFLINE functional tests (docs/38 §7).
 * Zero DB/Redis: the sweep runs against a scripted fake Db whose UPDATE
 * applies real CAS semantics (stamp equality + attempts cap + the write-time
 * §2 eligibility re-check of W-PLAT-MM05-REARM-1) to in-memory outbox rows,
 * and a fake BullMQ whose getJob is the sole loss proof.
 *
 * These pin the re-arm half of docs/38 §3, which the Qwen-2 dispatcher-seam
 * probe explicitly defers to ("FLIP this expectation when sweepQueueIntegrity
 * (docs/38) re-arms the row") — probe/1 keeps its GAP characterization of
 * the UNCHANGED dispatcher; the flip lives here, not in their file.
 */

interface FakeRow {
  id: string;
  delivery_id: string;
  dispatched_at: Date | null;
  attempts: number;
  task_state: string;
  lease_expires_at: Date | null;
  op_state: string;
}

const TERMINAL_OP_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];

function hasEligibilityGuard(sql: string): boolean {
  return sql.includes('EXISTS') && sql.includes('FROM tasks t') && sql.includes('JOIN operations o');
}

function isEligible(row: FakeRow): boolean {
  return (
    (row.task_state === 'READY' || row.task_state === 'QUEUED') &&
    (row.lease_expires_at === null || row.lease_expires_at.getTime() < Date.now()) &&
    !TERMINAL_OP_STATES.includes(row.op_state)
  );
}

interface UpdateCall {
  id: string;
  expectedStamp: Date | null;
  maxAttempts: number;
}

interface QueueBehavior {
  jobs: Map<string, unknown>;
  throwOnGetJob?: boolean;
}

function makeWorld(opts: { onCandidatesRead?: () => void } = {}) {
  const rows = new Map<string, FakeRow>();
  const updateCalls: UpdateCall[] = [];
  const candidateSqls: string[] = [];
  const rearmSqls: string[] = [];
  const queueLookups: { queueName: string; jobId: string }[] = [];

  const queues = new Map<string, QueueBehavior>();
  function behaviorFor(queueName: string): QueueBehavior {
    let b = queues.get(queueName);
    if (!b) {
      b = { jobs: new Map<string, unknown>() };
      queues.set(queueName, b);
    }
    return b;
  }

  const db = {
    pool: undefined,
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('UPDATE outbox') && sql.includes('SET dispatched_at = NULL')) {
        rearmSqls.push(sql);
        const id = String(params[0]);
        const expected = params[1] as Date;
        const maxAttempts = Number(params[2]);
        updateCalls.push({ id, expectedStamp: expected, maxAttempts });
        const row = rows.get(id);
        if (
          row &&
          row.dispatched_at &&
          row.dispatched_at.getTime() === expected.getTime() &&
          row.attempts < maxAttempts &&
          // Mirror QUEUE_INTEGRITY_REARM_SQL: the §2 eligibility re-check is
          // applied ONLY when the SQL actually carries it, so the behavioral
          // cancel/terminal tests go red if production ever drops the guard.
          !(hasEligibilityGuard(sql) && row && !isEligible(row))
        ) {
          row.dispatched_at = null;
          row.attempts += 1;
          return { rows: [{ id: row.id }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      if (sql.includes('FROM outbox') && sql.includes('dispatched_at IS NOT NULL') && sql.includes('DISTINCT ON')) {
        candidateSqls.push(sql);
        const cands: QueueIntegrityCandidate[] = [...rows.values()]
          .filter((r) => r.dispatched_at !== null)
          .map((r) => ({
            outbox_id: r.id,
            delivery_id: r.delivery_id,
            dispatched_at: new Date(r.dispatched_at!.getTime()),
            attempts: r.attempts,
            task_id: randomUUID(),
            task_state: 'READY',
            business_id: 'biz-mm05',
            business_version: '1.0.0',
            queue_name: 'du-business-mm05',
          }));
        opts.onCandidatesRead?.();
        const limit = Number(params[1] ?? 50);
        return { rows: cands.slice(0, limit), rowCount: Math.min(cands.length, limit) };
      }
      throw new Error('FakeDb: unexpected SQL: ' + sql.slice(0, 90));
    },
    tx: async () => {
      throw new Error('sweep must not use tx (single-statement CAS)');
    },
    close: async () => undefined,
  } as unknown as Db;

  const fakeQueue = {
    getJob: async (jobId: string) => {
      const name = 'du-business-mm05';
      queueLookups.push({ queueName: name, jobId });
      const b = behaviorFor(name);
      if (b.throwOnGetJob) throw new Error('simulated Redis failure');
      return b.jobs.get(jobId);
    },
  } as unknown as Queue;

  const getQueue = (_name: string) => fakeQueue;

  function seed(row: Partial<FakeRow> & { delivery_id: string }): FakeRow {
    const full: FakeRow = {
      id: row.id ?? randomUUID(),
      delivery_id: row.delivery_id,
      dispatched_at: row.dispatched_at ?? new Date(Date.now() - 60_000),
      attempts: row.attempts ?? 1,
      task_state: row.task_state ?? 'READY',
      lease_expires_at: row.lease_expires_at ?? null,
      op_state: row.op_state ?? 'RUNNING',
    };
    rows.set(full.id, full);
    return full;
  }

  function jobAlive(deliveryId: string) {
    behaviorFor('du-business-mm05').jobs.set(jobIdForDelivery(deliveryId), { id: jobIdForDelivery(deliveryId) });
  }

  function breakRedis() {
    behaviorFor('du-business-mm05').throwOnGetJob = true;
  }

  return { db, getQueue, rows, updateCalls, candidateSqls, rearmSqls, queueLookups, seed, jobAlive, breakRedis };
}

const sweepOf = (world: ReturnType<typeof makeWorld>) =>
  createRuntimeService(world.db, { getQueue: world.getQueue });

describe('MM-05 sweepQueueIntegrity (offline, docs/38 §3/§5)', () => {
  it('lost-job candidate is re-armed: dispatched_at cleared, attempts+1 (the probe/1 flip)', async () => {
    const world = makeWorld();
    const row = world.seed({ delivery_id: 'task-1:1' });

    const r = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1, limit: 10, maxAttempts: 10 });

    expect(r).toMatchObject({ candidates: 1, rearmed: 1, aliveSkipped: 0, casSkipped: 0, stalled: 0, unconfirmed: 0 });
    expect(row.dispatched_at).toBeNull();
    expect(row.attempts).toBe(2);
    expect(world.queueLookups).toEqual([{ queueName: 'du-business-mm05', jobId: jobIdForDelivery('task-1:1') }]);
  });

  it('live job (waiting/delayed/active/completed) is left untouched', async () => {
    const world = makeWorld();
    const row = world.seed({ delivery_id: 'task-2:1' });
    world.jobAlive('task-2:1');

    const r = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(r.aliveSkipped).toBe(1);
    expect(r.rearmed).toBe(0);
    expect(world.updateCalls).toHaveLength(0);
    expect(row.dispatched_at).not.toBeNull();
  });

  it('CAS guard: a dispatcher stamp that landed after the read is NEVER overwritten', async () => {
    const newer = new Date();
    const world = makeWorld({
      onCandidatesRead: () => {
        for (const row of world.rows.values()) row.dispatched_at = newer;
      },
    });
    const row = world.seed({ delivery_id: 'task-3:1' });

    const r = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(r.casSkipped).toBe(1);
    expect(r.rearmed).toBe(0);
    expect(row.dispatched_at).toBe(newer);
  });

  it('write-time re-check: task cancelled after the candidate read is NEVER re-armed (W-PLAT-MM05-REARM-1)', async () => {
    const world = makeWorld({
      onCandidatesRead: () => {
        for (const row of world.rows.values()) row.task_state = 'CANCELLED';
      },
    });
    const row = world.seed({ delivery_id: 'task-10:1' });

    const r = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(r.casSkipped).toBe(1);
    expect(r.rearmed).toBe(0);
    expect(row.dispatched_at).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('write-time re-check: operation reaching terminal after the candidate read is NEVER re-armed', async () => {
    const world = makeWorld({
      onCandidatesRead: () => {
        for (const row of world.rows.values()) row.op_state = 'SUCCEEDED';
      },
    });
    const row = world.seed({ delivery_id: 'task-11:1' });

    const r = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(r.casSkipped).toBe(1);
    expect(r.rearmed).toBe(0);
    expect(row.dispatched_at).not.toBeNull();
    expect(row.attempts).toBe(1);
  });

  it('escalation cap (D1): attempts >= max -> stalled, no re-arm, ids reported', async () => {
    const world = makeWorld();
    const row = world.seed({ delivery_id: 'task-4:1', attempts: 10 });

    const r = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1, maxAttempts: 10 });

    expect(r.stalled).toBe(1);
    expect(r.stalledDeliveryIds).toEqual(['task-4:1']);
    expect(world.updateCalls).toHaveLength(0);
    expect(row.dispatched_at).not.toBeNull();
  });

  it('Redis error is NOT loss proof: unconfirmed, nothing re-armed', async () => {
    const world = makeWorld();
    const row = world.seed({ delivery_id: 'task-5:1' });
    world.breakRedis();

    const r = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(r.unconfirmed).toBe(1);
    expect(r.rearmed).toBe(0);
    expect(world.updateCalls).toHaveLength(0);
    expect(row.dispatched_at).not.toBeNull();
  });

  it('fail closed without queue access', async () => {
    const world = makeWorld();
    await expect(createRuntimeService(world.db).sweepQueueIntegrity()).rejects.toThrow(/queue access/);
  });

  it('candidate predicate keeps every docs/38 §2 clause (structural pin)', async () => {
    const world = makeWorld();
    world.seed({ delivery_id: 'task-6:1' });
    await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });
    const sql = world.candidateSqls[0]!;
    expect(sql).toContain("ob.type = 'task.dispatch'");
    expect(sql).toContain('ob.dispatched_at IS NOT NULL');
    expect(sql).toContain("ob.dispatched_at < now() - ($1 * interval '1 ms')");
    expect(sql).toContain("t.state IN ('READY','QUEUED')");
    expect(sql).toContain('(t.lease_expires_at IS NULL OR t.lease_expires_at < now())');
    expect(sql).toContain("o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')");
    expect(sql).toContain('DISTINCT ON (ob.aggregate_id)');
    expect(sql).toContain('ORDER BY ob.aggregate_id, ob.dispatched_at DESC');
    expect(sql).not.toContain('INSERT');
  });

  it('re-arm CAS carries the §2 eligibility re-check at write time (structural pin)', async () => {
    const world = makeWorld();
    world.seed({ delivery_id: 'task-7:1' });
    await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });
    const sql = world.rearmSqls[0]!;
    expect(sql).toContain('UPDATE outbox');
    expect(sql).toContain('FROM tasks t');
    expect(sql).toContain('JOIN operations o ON o.id = t.operation_id');
    expect(sql).toContain('t.id = outbox.aggregate_id');
    expect(sql).toContain("t.state IN ('READY','QUEUED')");
    expect(sql).toContain('(t.lease_expires_at IS NULL OR t.lease_expires_at < now())');
    expect(sql).toContain("o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')");
    // the re-check must not disturb the pre-existing fence...
    expect(sql).toContain("date_trunc('millisecond', dispatched_at) = date_trunc('millisecond', $2::timestamptz)");
    expect(sql).toContain('attempts < $3');
    // ...and must ride the same [id, stamp, cap] bind triple (no $4).
    expect(sql).not.toMatch(/\$4/);
  });

  it('two orphans in one sweep both re-arm (batch behavior)', async () => {
    const world = makeWorld();
    const a = world.seed({ delivery_id: 'task-8a:1' });
    const b = world.seed({ delivery_id: 'task-8b:2' });

    const r = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1, limit: 10 });

    expect(r.candidates).toBe(2);
    expect(r.rearmed).toBe(2);
    expect(a.dispatched_at).toBeNull();
    expect(b.dispatched_at).toBeNull();
  });
});
