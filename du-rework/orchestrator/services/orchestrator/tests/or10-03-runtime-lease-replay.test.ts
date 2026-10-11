import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createRuntimeService } from '../src/modules/runtime/runtime';

const TASK_ID = '7a000000-0000-4000-8000-000000000001';
const OPERATION_ID = '7b000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'business-a';
const DELIVERY_ID = 'delivery-a';

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return {
    command,
    rowCount: rows.length,
    oid: 0,
    rows: rows as T[],
    fields: [],
  };
}

function makeOfflineDb(overrides: Record<string, unknown> = {}) {
  const task: Record<string, unknown> = {
    id: TASK_ID,
    task_key: 'root',
    kind: 'root',
    state: 'RUNNING',
    lease_epoch: 7,
    lease_expires_at: new Date(Date.now() + 60_000),
    leased_by: 'worker-a',
    last_delivery_id: DELIVERY_ID,
    attempt: 2,
    tenant_id: 'tenant-a',
    business_id: BUSINESS_ID,
    business_version: '1.0.0',
    operation_id: OPERATION_ID,
    action: 'extract',
    input_ref: {},
    payload_ref: {},
    deadline_at: null,
    manifest_digest: 'sha256:offline',
    profile_id: null,
    profile_revision: 1,
    connector_bindings: {},
    profile_policy_snapshot: null,
    prompt_revisions_pin: null,
    prompt_overrides_ref: null,
    op_cancel_requested: false,
    op_state: 'RUNNING',
    ...overrides,
  };
  const taskUpdates: { epoch: number; expiresAt: Date; workerId: string; deliveryId: string }[] = [];
  const operationUpdates: string[] = [];

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in offline lease replay test: ${sql}`);
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      const client = {
        query: async <R extends QueryResultRow = QueryResultRow>(
          sql: string,
          params: unknown[] = [],
        ): Promise<QueryResult<R>> => {
          if (/^\s*SELECT/i.test(sql) && /FROM tasks t\s+JOIN operations o/i.test(sql)) {
            return queryResult<R>([{ ...task }]);
          }
          if (/^\s*SELECT state FROM operations WHERE id=\$1/i.test(sql)) {
            return queryResult<R>([{ state: 'RUNNING' }]);
          }
          if (/^\s*SELECT/i.test(sql) && /FROM step_checkpoints/i.test(sql)) {
            return queryResult<R>([]);
          }
          if (/^\s*UPDATE tasks SET lease_epoch=\$2/i.test(sql)) {
            const [, epoch, expiresAt, workerId, deliveryId] = params as [string, number, Date | string, string, string];
            const expiry = new Date(expiresAt);
            taskUpdates.push({ epoch, expiresAt: expiry, workerId, deliveryId });
            task.lease_epoch = epoch;
            task.lease_expires_at = expiry;
            task.leased_by = workerId;
            task.last_delivery_id = deliveryId;
            task.state = 'RUNNING';
            task.attempt = Number(task.attempt) + 1;
            return queryResult<R>([{ id: TASK_ID }], 'UPDATE');
          }
          if (/^\s*UPDATE operations SET state='RUNNING'/i.test(sql)) {
            operationUpdates.push(sql);
            return queryResult<R>([{ id: OPERATION_ID }], 'UPDATE');
          }
          throw new Error(`unexpected transaction query in offline lease replay test: ${sql}`);
        },
      };
      return fn(client as never);
    },
    close: async () => undefined,
  } as unknown as Db;

  return { db, task, taskUpdates, operationUpdates };
}

describe('OR10-03 runtime delivery replay lease ownership', () => {
  it('replays the same delivery only for its owner while the RUNNING lease is active', async () => {
    const fixture = makeOfflineDb();
    const runtime = createRuntimeService(fixture.db);

    const claim = await runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-a', BUSINESS_ID);

    expect(claim).toMatchObject({ leaseEpoch: 7, attempt: 2 });
    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.operationUpdates).toEqual([]);
  });

  it('does not let a different worker replay the current worker lease', async () => {
    const fixture = makeOfflineDb();
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-b', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });

    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.operationUpdates).toEqual([]);
    expect(fixture.task.lease_epoch).toBe(7);
    expect(fixture.task.leased_by).toBe('worker-a');
  });

  it.each(['worker-a', 'worker-b'])('takes over an expired replay for %s and advances the epoch', async (workerId) => {
    const fixture = makeOfflineDb({ lease_expires_at: new Date(Date.now() - 1_000) });
    const runtime = createRuntimeService(fixture.db);

    const claim = await runtime.claimTask(TASK_ID, DELIVERY_ID, workerId, BUSINESS_ID);

    expect(claim.leaseEpoch).toBe(8);
    expect(claim.attempt).toBe(3);
    expect(fixture.task.lease_epoch).toBe(8);
    expect(fixture.task.leased_by).toBe(workerId);
    expect(fixture.taskUpdates).toHaveLength(1);
    expect(fixture.taskUpdates[0]).toMatchObject({ epoch: 8, workerId, deliveryId: DELIVERY_ID });
    expect(fixture.taskUpdates[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(fixture.operationUpdates).toHaveLength(1);
  });

  it.each(['WAITING_INPUT', 'WAITING_CHILDREN'])('does not replay a delivery while the task is %s', async (state) => {
    const fixture = makeOfflineDb({ state, op_state: state });
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-a', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });

    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.operationUpdates).toEqual([]);
    expect(fixture.task.lease_epoch).toBe(7);
  });
});
