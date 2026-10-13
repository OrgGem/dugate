import { createHash, randomUUID } from 'node:crypto';
import type { Queue } from 'bullmq';
import { jobIdForDelivery } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createRuntimeService, type QueueIntegrityCandidate } from '../src/modules/runtime/runtime';

/**
 * MM-05 queue-integrity recovery — offline tests. The fake DB models the
 * read-time candidate predicate, transactional CAS guard and unique durable
 * replacement intent. BullMQ state, rather than getJob presence, determines
 * whether recovery is safe.
 */

interface FakeRow {
  id: string;
  aggregate_id: string;
  type: 'task.dispatch' | 'task.continuation';
  delivery_id: string;
  payload: Record<string, unknown>;
  dispatched_at: Date | null;
  attempts: number;
  created_at: Date;
  due_at: Date;
  task_state: string;
  lease_expires_at: Date | null;
  op_state: string;
}

const TERMINAL_OP_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'];
const LIVE_JOB_STATES = ['active', 'delayed', 'prioritized', 'waiting', 'waiting-children'];

function eligible(row: FakeRow): boolean {
  return ['READY', 'QUEUED', 'RETRY_PENDING'].includes(row.task_state)
    && (row.task_state !== 'RETRY_PENDING' || row.due_at.getTime() <= Date.now())
    && (row.lease_expires_at === null || row.lease_expires_at.getTime() < Date.now())
    && !TERMINAL_OP_STATES.includes(row.op_state);
}

interface QueueJob {
  getState?: () => Promise<string>;
}

interface QueueBehavior {
  jobs: Map<string, QueueJob>;
  throwOnGetJob?: boolean;
}

function makeWorld(opts: { onCandidatesRead?: () => void } = {}) {
  const rows = new Map<string, FakeRow>();
  const guardSqls: string[] = [];
  const insertSqls: string[] = [];
  const candidateSqls: string[] = [];
  const queueLookups: { queueName: string; jobId: string }[] = [];
  const queues = new Map<string, QueueBehavior>();
  let cursor: { last_created_at: Date | null; last_task_id: string | null } = {
    last_created_at: null, last_task_id: null,
  };

  function behaviorFor(queueName: string): QueueBehavior {
    let behavior = queues.get(queueName);
    if (!behavior) {
      behavior = { jobs: new Map<string, QueueJob>() };
      queues.set(queueName, behavior);
    }
    return behavior;
  }

  function makeClient() {
    return {
      query: async (text: string, params: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        if (sql.includes('FROM queue_integrity_sweep_cursor')) {
          return { rows: [cursor], rowCount: 1 };
        }
        if (sql.startsWith('INSERT INTO queue_integrity_sweep_cursor')) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('UPDATE queue_integrity_sweep_cursor')) {
          cursor = params.length
            ? { last_created_at: new Date(String(params[0])), last_task_id: String(params[1]) }
            : { last_created_at: null, last_task_id: null };
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('DISTINCT ON (ob.aggregate_id)')) {
          candidateSqls.push(sql);
          const graceMs = Number(params[0]);
          const limit = Number(params[1] ?? 50);
          const afterCreatedAt = params[2] ? new Date(String(params[2])).getTime() : null;
          const afterTaskId = params[3] ? String(params[3]) : null;
          const candidates = [...rows.values()]
            .filter((row) => row.dispatched_at !== null
              && row.dispatched_at.getTime() < Date.now() - graceMs
              && eligible(row)
              && (afterCreatedAt === null || row.created_at.getTime() > afterCreatedAt
                || (row.created_at.getTime() === afterCreatedAt
                  && row.aggregate_id.localeCompare(afterTaskId ?? '') > 0))
              && ![...rows.values()].some((pending) => pending.aggregate_id === row.aggregate_id
                && ['task.dispatch', 'task.continuation'].includes(pending.type)
                && pending.dispatched_at === null))
            .sort((a, b) => a.created_at.getTime() - b.created_at.getTime()
              || a.aggregate_id.localeCompare(b.aggregate_id)
              || (b.dispatched_at?.getTime() ?? 0) - (a.dispatched_at?.getTime() ?? 0))
            .filter((row, index, all) => index === 0 || all[index - 1]?.aggregate_id !== row.aggregate_id)
            .slice(0, limit)
            .map((row): QueueIntegrityCandidate => ({
              outbox_id: row.id,
              delivery_id: row.delivery_id,
              delivery_type: row.type,
              dispatched_at: new Date(row.dispatched_at!),
              attempts: row.attempts,
              task_id: row.aggregate_id,
              task_state: row.task_state,
              task_created_at: new Date(row.created_at),
              business_id: 'biz-mm05',
              business_version: '1.0.0',
              queue_name: 'du-business-mm05-1.0.0',
            }));
          opts.onCandidatesRead?.();
          return { rows: candidates, rowCount: candidates.length };
        }
        if (sql.includes('FOR UPDATE OF ob, t')) {
          guardSqls.push(sql);
          const [id, expectedStamp, expectedAttempts, maxAttempts] = params as [string, Date, number, number];
          const row = rows.get(id);
          const stampMatches = row?.dispatched_at !== null
            && row?.dispatched_at !== undefined
            && Math.trunc(row.dispatched_at.getTime()) === Math.trunc(expectedStamp.getTime());
          const hasPending = row && [...rows.values()].some((pending) => pending.aggregate_id === row.aggregate_id
            && ['task.dispatch', 'task.continuation'].includes(pending.type)
            && pending.dispatched_at === null);
          const hasNewer = row && [...rows.values()].some((other) => other.aggregate_id === row.aggregate_id
            && ['task.dispatch', 'task.continuation'].includes(other.type)
            && other.dispatched_at !== null
            && other.dispatched_at.getTime() > (row.dispatched_at?.getTime() ?? 0));
          if (row && stampMatches && row.attempts === Number(expectedAttempts)
            && row.attempts < Number(maxAttempts) && eligible(row) && !hasPending && !hasNewer) {
            return {
              rows: [{ id: row.id, aggregate_id: row.aggregate_id, type: row.type,
                delivery_id: row.delivery_id, payload: row.payload, attempts: row.attempts }],
              rowCount: 1,
            };
          }
          return { rows: [], rowCount: 0 };
        }
        if (sql.includes('INSERT INTO outbox')) {
          insertSqls.push(sql);
          const [sourceId, deliveryId] = params as [string, string];
          const source = rows.get(sourceId);
          if (!source || [...rows.values()].some((row) => row.delivery_id === deliveryId)) {
            return { rows: [], rowCount: 0 };
          }
          const replacement: FakeRow = {
            ...source,
            id: randomUUID(),
            delivery_id: deliveryId,
            payload: { ...source.payload, deliveryId },
            dispatched_at: null,
          };
          rows.set(replacement.id, replacement);
          return { rows: [{ id: replacement.id }], rowCount: 1 };
        }
        throw new Error('FakeDb: unexpected SQL: ' + sql.slice(0, 100));
      },
    };
  }

  const db = {
    pool: undefined,
    query: async (text: string, params: unknown[] = []) => makeClient().query(text, params),
    tx: async <T>(fn: (client: ReturnType<typeof makeClient>) => Promise<T>) => fn(makeClient()),
    close: async () => undefined,
  } as unknown as Db;

  const fakeQueue = {
    getJob: async (jobId: string) => {
      queueLookups.push({ queueName: 'du-business-mm05-1.0.0', jobId });
      const behavior = behaviorFor('du-business-mm05-1.0.0');
      if (behavior.throwOnGetJob) throw new Error('simulated Redis failure');
      return behavior.jobs.get(jobId);
    },
  } as unknown as Queue;

  function seed(input: Partial<FakeRow> & { delivery_id: string }): FakeRow {
    const row: FakeRow = {
      id: input.id ?? randomUUID(),
      aggregate_id: input.aggregate_id ?? randomUUID(),
      type: input.type ?? 'task.dispatch',
      delivery_id: input.delivery_id,
      payload: input.payload ?? {
        contractVersion: '1', deliveryId: input.delivery_id, taskId: input.aggregate_id ?? 'task',
      },
      dispatched_at: input.dispatched_at === undefined ? new Date(Date.now() - 60_000) : input.dispatched_at,
      attempts: input.attempts ?? 1,
      created_at: input.created_at ?? new Date(Date.now() - 120_000 + rows.size * 1000),
      due_at: input.due_at ?? new Date(Date.now() - 60_000),
      task_state: input.task_state ?? 'READY',
      lease_expires_at: input.lease_expires_at ?? null,
      op_state: input.op_state ?? 'QUEUED',
    };
    rows.set(row.id, row);
    return row;
  }

  function jobState(deliveryId: string, state: string) {
    const behavior = behaviorFor('du-business-mm05-1.0.0');
    const jobId = jobIdForDelivery(deliveryId);
    behavior.jobs.set(jobId, { getState: async () => state });
  }

  function jobWithoutState(deliveryId: string) {
    behaviorFor('du-business-mm05-1.0.0').jobs.set(jobIdForDelivery(deliveryId), {});
  }

  function breakRedis() {
    behaviorFor('du-business-mm05-1.0.0').throwOnGetJob = true;
  }

  return { db, getQueue: () => fakeQueue, rows, guardSqls, insertSqls, candidateSqls, queueLookups,
    seed, jobState, jobWithoutState, breakRedis };
}

const sweepOf = (world: ReturnType<typeof makeWorld>) =>
  createRuntimeService(world.db, { getQueue: world.getQueue });

describe('MM-05 sweepQueueIntegrity (offline, durable replacement protocol)', () => {
  it('missing delivery creates a new pending outbox intent without mutating the stamped source row', async () => {
    const world = makeWorld();
    const source = world.seed({ delivery_id: 'task-1:1' });

    const result = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1, limit: 10, maxAttempts: 10 });

    expect(result).toMatchObject({ candidates: 1, rearmed: 1, aliveSkipped: 0, casSkipped: 0, stalled: 0, unconfirmed: 0 });
    expect(source.dispatched_at).not.toBeNull();
    expect(source.attempts).toBe(1);
    const replacement = [...world.rows.values()].find((row) => row.id !== source.id)!;
    expect(replacement).toMatchObject({
      aggregate_id: source.aggregate_id,
      type: source.type,
      attempts: source.attempts,
      dispatched_at: null,
    });
    expect(replacement.delivery_id).not.toBe(source.delivery_id);
    expect(replacement.delivery_id).toContain(`${source.aggregate_id}:queue-recovery:`);
    expect(source.payload.deliveryId).toBe(source.delivery_id);
    expect(replacement.payload).toEqual({ ...source.payload, deliveryId: replacement.delivery_id });
    expect(world.queueLookups).toEqual([{ queueName: 'du-business-mm05-1.0.0', jobId: jobIdForDelivery('task-1:1') }]);
    expect(world.insertSqls[0]).toContain('ON CONFLICT (delivery_id) DO NOTHING');
    expect(world.insertSqls[0]).toContain("jsonb_set(payload,'{deliveryId}',to_jsonb($2::text),true)");
  });

  it.each(LIVE_JOB_STATES)('leaves live BullMQ state %s untouched', async (state) => {
    const world = makeWorld();
    const row = world.seed({ delivery_id: `task-live-${state}:1` });
    world.jobState(row.delivery_id, state);

    const result = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(result.aliveSkipped).toBe(1);
    expect(result.rearmed).toBe(0);
    expect(world.guardSqls).toHaveLength(0);
    expect(world.rows.size).toBe(1);
  });

  it.each(['completed', 'failed'])('replaces terminal BullMQ state %s when the task remains runnable', async (state) => {
    const world = makeWorld();
    const row = world.seed({ delivery_id: `task-${state}:1` });
    world.jobState(row.delivery_id, state);

    const result = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(result.rearmed).toBe(1);
    expect([...world.rows.values()].filter((entry) => entry.dispatched_at === null)).toHaveLength(1);
  });

  it('reports stalled only when a terminal/missing delivery is confirmed at the attempt cap', async () => {
    const world = makeWorld();
    const active = world.seed({ delivery_id: 'task-cap-active:1', attempts: 10 });
    const failed = world.seed({ delivery_id: 'task-cap-failed:1', attempts: 10 });
    world.jobState(active.delivery_id, 'active');
    world.jobState(failed.delivery_id, 'failed');

    const result = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1, maxAttempts: 10 });

    expect(result.aliveSkipped).toBe(1);
    expect(result.stalled).toBe(1);
    expect(result.stalledDeliveryIds).toEqual([failed.delivery_id]);
  });

  it('a concurrent recovery race yields at most one deterministic replacement intent', async () => {
    const world = makeWorld();
    world.seed({ delivery_id: 'task-race:1' });

    const [first, second] = await Promise.all([
      sweepOf(world).sweepQueueIntegrity({ graceMs: 1 }),
      sweepOf(world).sweepQueueIntegrity({ graceMs: 1 }),
    ]);

    expect(world.rows.size).toBe(2);
    const replacement = [...world.rows.values()].find((row) => row.dispatched_at === null)!;
    const expectedSuffix = createHash('sha256').update('task-race:1').digest('hex').slice(0, 16);
    expect(replacement.delivery_id).toContain(`:queue-recovery:${expectedSuffix}:2`);
    expect(first.rearmed + second.rearmed).toBe(1);
    expect(first.casSkipped + second.casSkipped).toBe(1);
  });

  it('write-time CAS rejects a changed delivery stamp, task state, or terminal operation', async () => {
    const changedStamp = new Date();
    const stampWorld = makeWorld({ onCandidatesRead: () => {
      for (const row of stampWorld.rows.values()) row.dispatched_at = changedStamp;
    } });
    const stamped = stampWorld.seed({ delivery_id: 'task-stamp:1' });
    const stampResult = await sweepOf(stampWorld).sweepQueueIntegrity({ graceMs: 1 });
    expect(stampResult.casSkipped).toBe(1);
    expect(stamped.dispatched_at).toBe(changedStamp);

    const stateWorld = makeWorld({ onCandidatesRead: () => {
      for (const row of stateWorld.rows.values()) row.task_state = 'RUNNING';
    } });
    const transitioned = stateWorld.seed({ delivery_id: 'task-state:1' });
    const stateResult = await sweepOf(stateWorld).sweepQueueIntegrity({ graceMs: 1 });
    expect(stateResult.casSkipped).toBe(1);
    expect(transitioned.dispatched_at).not.toBeNull();

    const terminalWorld = makeWorld({ onCandidatesRead: () => {
      for (const row of terminalWorld.rows.values()) row.op_state = 'SUCCEEDED';
    } });
    const terminal = terminalWorld.seed({ delivery_id: 'task-terminal:1' });
    const terminalResult = await sweepOf(terminalWorld).sweepQueueIntegrity({ graceMs: 1 });
    expect(terminalResult.casSkipped).toBe(1);
    expect(terminal.dispatched_at).not.toBeNull();
  });

  it('unknown job state, missing getState, or Redis errors are unconfirmed, never proof of loss', async () => {
    const world = makeWorld();
    const unknown = world.seed({ delivery_id: 'task-unknown:1' });
    const noState = world.seed({ delivery_id: 'task-no-state:1' });
    const redis = world.seed({ delivery_id: 'task-redis:1' });
    world.jobState(unknown.delivery_id, 'future-state');
    world.jobWithoutState(noState.delivery_id);
    world.breakRedis();

    const result = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(result.unconfirmed).toBe(3);
    expect(result.rearmed).toBe(0);
    expect([unknown, noState, redis].every((row) => row.dispatched_at !== null)).toBe(true);
  });

  it('candidate SQL covers dispatch and continuation and suppresses recovery while a replacement is pending', async () => {
    const world = makeWorld();
    world.seed({ delivery_id: 'task-dispatch:1' });
    world.seed({ delivery_id: 'task-continuation:1', type: 'task.continuation' });
    const pending = world.seed({ delivery_id: 'task-pending:2', dispatched_at: null });
    world.seed({ aggregate_id: pending.aggregate_id, delivery_id: 'task-pending:1' });

    const result = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(result.candidates).toBe(2);
    const sql = world.candidateSqls[0]!;
    expect(sql).toContain("ob.type IN ('task.dispatch','task.continuation')");
    expect(sql).toContain("pending.dispatched_at IS NULL");
    expect(sql).toContain("t.state IN ('READY','QUEUED','RETRY_PENDING')");
    expect(sql).toContain("t.state <> 'RETRY_PENDING' OR t.due_at <= now()");
    expect(sql).toContain('DISTINCT ON (ob.aggregate_id)');
  });

  it('includes due RETRY_PENDING work and skips retries whose due time has not arrived', async () => {
    const world = makeWorld();
    world.seed({ delivery_id: 'retry-due', task_state: 'RETRY_PENDING', due_at: new Date(Date.now() - 1000) });
    world.seed({ delivery_id: 'retry-future', task_state: 'RETRY_PENDING', due_at: new Date(Date.now() + 60_000) });

    const result = await sweepOf(world).sweepQueueIntegrity({ graceMs: 1 });

    expect(result.candidates).toBe(1);
    expect(world.queueLookups.map((entry) => entry.jobId)).toEqual([jobIdForDelivery('retry-due')]);
  });

  it('advances a durable cursor so bounded scans reach later tasks', async () => {
    const world = makeWorld();
    const created = new Date(Date.now() - 120_000);
    world.seed({ aggregate_id: '00000000-0000-4000-8000-000000000001', delivery_id: 'oldest', created_at: created });
    world.seed({ aggregate_id: '00000000-0000-4000-8000-000000000002', delivery_id: 'next', created_at: new Date(created.getTime() + 1000) });

    await sweepOf(world).sweepQueueIntegrity({ graceMs: 1, limit: 1 });
    await sweepOf(world).sweepQueueIntegrity({ graceMs: 1, limit: 1 });

    expect(world.queueLookups.map((entry) => entry.jobId)).toEqual([
      jobIdForDelivery('oldest'), jobIdForDelivery('next'),
    ]);
  });

  it('fail closes without queue access', async () => {
    const world = makeWorld();
    await expect(createRuntimeService(world.db).sweepQueueIntegrity()).rejects.toThrow(/queue access/);
  });
});
