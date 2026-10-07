/**
 * W-PLAT-MM10-CANCEL-1 — refuse heartbeat lease renewal for cancel-requested
 * tasks (Reviewer finding FR24-06 / MM-10).
 *
 * Production contract under test (runtime.ts heartbeatTask):
 *  - an operation-level cancel signal (cancel_requested=true, op state
 *    CANCEL_REQUESTED, or a committed op CANCELLED) while the task row is
 *    still RUNNING must NOT extend lease_expires_at; the ack is
 *    200 { cancelRequested: true } so the SDK aborts gracefully;
 *  - the extension UPDATE re-verifies the cancel fence AT WRITE TIME (the
 *    cancel tx commits its operations row while its tasks-row UPDATE queues
 *    behind our FOR UPDATE OF t);
 *  - the MM-10b contracts stay intact: task-level terminal states still 410,
 *    stale epoch still 409 before any cancel info is exposed, foreign
 *    business still 403 first.
 *
 * The fake applies the cancel fence only when the production SQL text
 * carries it (conditional mirror), so dropping the guard in runtime.ts turns
 * the behavioral tests red instead of silently passing.
 */
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createRuntimeService } from '../src/modules/runtime/runtime';

const TASK_ID = '7c000000-0000-4000-8000-000000000001';
const BUSINESS_A = 'business-a';
const BUSINESS_B = 'business-b';

interface FakeTask {
  lease_epoch: number;
  state: string;
  lease_expires_at: Date;
  business_id: string;
}

interface FakeOp {
  cancel_requested: boolean;
  state: string;
  business_id: string;
}

interface WorldOptions {
  task?: Partial<FakeTask>;
  op?: Partial<FakeOp>;
  /** Runs after the FOR UPDATE SELECT has produced its row, before it is
   *  returned to production — models a cancel committing mid-heartbeat. */
  onLeaseRead?: (task: FakeTask, op: FakeOp) => void;
}

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return { command, rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

function hasProductionCancelGuard(sql: string): boolean {
  return sql.includes('NOT o.cancel_requested') && sql.includes("o.state <> 'CANCEL_REQUESTED'");
}

function isCancelSignalled(op: FakeOp): boolean {
  return op.cancel_requested || op.state === 'CANCEL_REQUESTED' || op.state === 'CANCELLED';
}

function makeWorld(options: WorldOptions = {}) {
  const task: FakeTask = {
    lease_epoch: 12,
    state: 'RUNNING',
    lease_expires_at: new Date(Date.now() + 60_000),
    business_id: BUSINESS_A,
    ...options.task,
  };
  const op: FakeOp = {
    cancel_requested: false,
    state: 'RUNNING',
    business_id: BUSINESS_A,
    ...options.op,
  };
  const selectSqls: string[] = [];
  const updateSqls: string[] = [];
  const attemptedWrites: string[] = [];
  let selectsDone = 0;

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in offline cancel-heartbeat test: ${sql}`);
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      const client = {
        query: async <R extends QueryResultRow = QueryResultRow>(
          sql: string,
          params: unknown[] = []
        ): Promise<QueryResult<R>> => {
          if (/^\s*SELECT/i.test(sql) && /FROM tasks t JOIN operations o/i.test(sql)) {
            selectSqls.push(sql);
            const row = {
              lease_epoch: task.lease_epoch,
              lease_expires_at: task.lease_expires_at,
              state: task.state,
              cancel_requested: op.cancel_requested,
              op_state: op.state,
              business_id: task.business_id,
              lease_active: task.lease_expires_at.getTime() > Date.now(),
            };
            selectsDone += 1;
            if (selectsDone === 1) options.onLeaseRead?.(task, op);
            return queryResult<R>([row]);
          }
          if (/^\s*UPDATE tasks t SET lease_expires_at/i.test(sql)) {
            updateSqls.push(sql);
            attemptedWrites.push(sql);
            // Conditional mirror: enforce the cancel fence only if production
            // SQL carries it; a dropped fence keeps this fake "dumb" and the
            // behavioral expectations below go red.
            const [taskId, , leaseEpoch, workerBusiness] = params as [string, number, number, string | null];
            const fenceMatches =
              taskId === TASK_ID &&
              task.lease_epoch === leaseEpoch &&
              task.state === 'RUNNING' &&
              task.lease_expires_at.getTime() > Date.now() &&
              (workerBusiness === null || task.business_id === workerBusiness) &&
              !(hasProductionCancelGuard(sql) && isCancelSignalled(op));
            if (!fenceMatches) return queryResult<R>([], 'UPDATE');
            task.lease_expires_at = new Date(
              Math.max(Date.now() + 60_000, task.lease_expires_at.getTime() + 1)
            );
            return queryResult<R>([{ lease_expires_at: task.lease_expires_at }], 'UPDATE');
          }
          throw new Error(`unexpected transaction query in offline cancel-heartbeat test: ${sql}`);
        },
      };
      return fn(client as never);
    },
    close: async () => undefined,
  } as unknown as Db;

  return { db, task, op, selectSqls, updateSqls, attemptedWrites };
}

describe('W-PLAT-MM10-CANCEL-1: heartbeat refuses lease renewal on operation cancel signals', () => {
  it('cancel_requested=true: ack cancelRequested=true, lease NOT extended, no UPDATE issued', async () => {
    const world = makeWorld({ op: { cancel_requested: true } });
    const runtime = createRuntimeService(world.db);
    const originalExpiry = world.task.lease_expires_at.toISOString();

    const ack = await runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A);

    expect(ack).toEqual({ leaseExpiresAt: originalExpiry, cancelRequested: true });
    expect(world.task.lease_expires_at.toISOString()).toBe(originalExpiry);
    expect(world.attemptedWrites).toEqual([]);
  });

  it('operation state CANCEL_REQUESTED (soft signal, flag not yet set): refuse + cancelRequested=true', async () => {
    const world = makeWorld({ op: { state: 'CANCEL_REQUESTED' } });
    const runtime = createRuntimeService(world.db);
    const originalExpiry = world.task.lease_expires_at.toISOString();

    const ack = await runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A);

    expect(ack).toEqual({ leaseExpiresAt: originalExpiry, cancelRequested: true });
    expect(world.attemptedWrites).toEqual([]);
  });

  it('committed operation CANCELLED with still-RUNNING task: refuse + cancelRequested=true (defensive fence)', async () => {
    const world = makeWorld({ op: { state: 'CANCELLED' } });
    const runtime = createRuntimeService(world.db);

    const ack = await runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A);

    expect(ack.cancelRequested).toBe(true);
    expect(world.attemptedWrites).toEqual([]);
  });

  it('FR24-06 race: cancel commits AFTER the FOR UPDATE read — write-time fence rejects, lease stays, ack true', async () => {
    const world = makeWorld({
      onLeaseRead: (_task, op) => {
        op.cancel_requested = true;
      },
    });
    const runtime = createRuntimeService(world.db);
    const originalExpiry = world.task.lease_expires_at.toISOString();

    const ack = await runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A);

    // The extension was attempted (SELECT saw pre-cancel state) but the
    // write-time cancel fence must have rejected it — old code renewed the
    // lease here and acked cancelRequested:false.
    expect(world.attemptedWrites).toHaveLength(1);
    expect(ack).toEqual({ leaseExpiresAt: originalExpiry, cancelRequested: true });
    expect(world.task.lease_expires_at.toISOString()).toBe(originalExpiry);
  });

  it('regression: no cancel signal — lease extends, ack cancelRequested=false', async () => {
    const world = makeWorld();
    const runtime = createRuntimeService(world.db);
    const originalExpiry = world.task.lease_expires_at.getTime();

    const ack = await runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A);

    expect(ack.cancelRequested).toBe(false);
    expect(world.attemptedWrites).toHaveLength(1);
    expect(new Date(ack.leaseExpiresAt).getTime()).toBeGreaterThan(originalExpiry);
    expect(world.task.lease_expires_at.getTime()).toBeGreaterThan(originalExpiry);
  });

  it('guard order preserved: stale epoch on a cancel-requested task is 409 LEASE_LOST, never a cancel leak', async () => {
    const world = makeWorld({ op: { cancel_requested: true } });
    const runtime = createRuntimeService(world.db);

    await expect(runtime.heartbeatTask(TASK_ID, 11, BUSINESS_A))
      .rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });

    expect(world.attemptedWrites).toEqual([]);
  });

  it('guard order preserved: foreign business on a cancel-requested task is 403 before any cancel state', async () => {
    const world = makeWorld({ op: { cancel_requested: true } });
    const runtime = createRuntimeService(world.db);

    await expect(runtime.heartbeatTask(TASK_ID, 12, BUSINESS_B))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });

    expect(world.attemptedWrites).toEqual([]);
  });

  it('MM-10b contract intact: task state CANCELLED still answers 410 TASK_TERMINAL (not the cancel-ack path)', async () => {
    const world = makeWorld({ task: { state: 'CANCELLED' }, op: { cancel_requested: true } });
    const runtime = createRuntimeService(world.db);

    await expect(runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A))
      .rejects.toMatchObject({ status: 410, code: 'TASK_TERMINAL' });

    expect(world.attemptedWrites).toEqual([]);
  });

  it('structural pin: SELECT carries op_state, extension UPDATE re-verifies the cancel fence at write time', async () => {
    const world = makeWorld({
      onLeaseRead: (_task, op) => {
        op.cancel_requested = true;
      },
    });
    const runtime = createRuntimeService(world.db);
    await runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A);

    const select = world.selectSqls[0]!;
    expect(select).toContain('o.cancel_requested');
    expect(select).toContain('o.state AS op_state');
    expect(select).toContain('FOR UPDATE OF t');

    const update = world.updateSqls[0]!;
    expect(update).toContain('NOT o.cancel_requested');
    expect(update).toContain("o.state <> 'CANCEL_REQUESTED'");
    // Every pre-existing fence remains (epoch, running state, live lease, business):
    expect(update).toMatch(/t\.lease_epoch=\$3/);
    expect(update).toMatch(/t\.state='RUNNING'/);
    expect(update).toMatch(/t\.lease_expires_at > clock_timestamp\(\)/);
    expect(update).toMatch(/\(\$4::text IS NULL OR o\.business_id=\$4\)/);
    // ...and the fix added no bind parameters (fake + server shape untouched):
    expect(update).not.toMatch(/\$5/);
  });
});
