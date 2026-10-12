import type { QueryResult, QueryResultRow } from 'pg';
import { contentHash } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createRuntimeService } from '../src/modules/runtime/runtime';

const TASK_ID = '7a000000-0000-4000-8000-000000000001';
const PARENT_ID = '7a000000-0000-4000-8000-000000000002';
const OPERATION_ID = '7b000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'business-a';

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return { command, rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

function makeResumeDb() {
  const operation: Record<string, unknown> = {
    id: OPERATION_ID,
    tenant_id: 'tenant-a',
    state: 'WAITING_INPUT',
    state_version: 7,
    endpoint_slug: null,
  };
  const task: Record<string, unknown> = {
    id: TASK_ID,
    state: 'WAITING_INPUT',
    lease_epoch: 3,
    lease_expires_at: new Date(Date.now() + 60_000),
    leased_by: 'old-worker',
    payload_ref: {},
    business_id: BUSINESS_ID,
    business_version: '1.0.0',
    action: 'extract',
    correlation_id: 'woc-resume-test',
  };
  const wait: Record<string, unknown> = {
    id: 'wait-row-1',
    task_id: TASK_ID,
    wait_id: 'wait_woc_resume',
    input_schema: { type: 'object', properties: { answer: { type: 'string' } }, required: ['answer'] },
    status: 'OPEN',
  };
  const outbox = new Set<string>();
  const taskUpdateSql: string[] = [];

  const client = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
      if (/^\s*SELECT id, tenant_id, state, state_version, endpoint_slug FROM operations/i.test(sql)) {
        return queryResult<T>([{ ...operation }]);
      }
      if (/^\s*SELECT id, task_id, wait_id, input_schema, status FROM human_waits/i.test(sql)) {
        return queryResult<T>([{ ...wait }]);
      }
      if (/^\s*UPDATE human_waits SET status='ANSWERED'/i.test(sql)) {
        wait.status = 'ANSWERED';
        return queryResult<T>([{ id: wait.id }], 'UPDATE');
      }
      if (/^\s*SELECT t.id, t.state, t.payload_ref, o.business_id/i.test(sql)) {
        return queryResult<T>([{ ...task }]);
      }
      if (/^\s*UPDATE tasks SET state='QUEUED'/i.test(sql)) {
        taskUpdateSql.push(sql);
        task.state = 'QUEUED';
        task.lease_epoch = Number(task.lease_epoch) + 1;
        task.lease_expires_at = null;
        task.leased_by = null;
        task.payload_ref = JSON.parse(String(params[1])) as unknown;
        return queryResult<T>([{ id: TASK_ID }], 'UPDATE');
      }
      if (/^\s*INSERT INTO outbox/i.test(sql)) {
        outbox.add(String(params[1]));
        return queryResult<T>([{ id: 'outbox-resume' }], 'INSERT');
      }
      if (/^\s*UPDATE operations SET state='QUEUED'/i.test(sql)) {
        operation.state = 'QUEUED';
        operation.state_version = Number(operation.state_version) + 1;
        return queryResult<T>([{ state: operation.state, state_version: operation.state_version }], 'UPDATE');
      }
      throw new Error(`unexpected resume SQL: ${sql}`);
    },
  };
  const db = {
    query: async () => { throw new Error('unexpected pool query'); },
    tx: async <T>(fn: (db: never) => Promise<T>) => fn(client as never),
  } as unknown as Db;
  return { db, operation, task, wait, outbox, taskUpdateSql };
}

function makeJoinDb() {
  const child: Record<string, unknown> = {
    id: TASK_ID,
    task_key: 'child-1',
    kind: 'child',
    state: 'RUNNING',
    lease_epoch: 4,
    lease_expires_at: new Date(Date.now() + 60_000),
    leased_by: 'child-worker',
    attempt: 1,
    operation_id: OPERATION_ID,
    tenant_id: 'tenant-a',
    business_id: BUSINESS_ID,
  };
  const parent: Record<string, unknown> = {
    id: PARENT_ID,
    state: 'WAITING_CHILDREN',
    lease_epoch: 11,
    lease_expires_at: new Date(Date.now() + 60_000),
    leased_by: 'parent-old-worker',
    payload_ref: { continuationRef: 'continue-after-child' },
    tenant_id: 'tenant-a',
    business_id: BUSINESS_ID,
    business_version: '1.0.0',
    action: 'extract',
    correlation_id: 'woc-join-test',
  };
  const operation: Record<string, unknown> = { id: OPERATION_ID, state: 'WAITING_CHILDREN' };
  const outbox = new Set<string>();
  const parentUpdateSql: string[] = [];

  const client = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
      if (/^\s*SELECT t\.lease_epoch, t\.state, t\.operation_id, o\.tenant_id/i.test(sql)) {
        const row = String(params[0]) === TASK_ID ? child : parent;
        return queryResult<T>([{
          ...row,
          lease_active: row.state === 'RUNNING' && (row.lease_expires_at as Date).getTime() > Date.now(),
        }]);
      }
      if (/^\s*UPDATE tasks t SET state='SUCCEEDED'/i.test(sql)) {
        child.state = 'SUCCEEDED';
        child.result_ref = params[1];
        return queryResult<T>([{ id: TASK_ID }], 'UPDATE');
      }
      if (/^\s*SELECT parent_id, join_policy FROM task_dependencies/i.test(sql)) {
        return queryResult<T>([{ parent_id: PARENT_ID, join_policy: 'all-success' }]);
      }
      if (/^\s*SELECT t.id, t.state, t.payload_ref, o\.tenant_id/i.test(sql)) {
        return queryResult<T>([{ ...parent }]);
      }
      if (/^\s*SELECT c.id, c.task_key, c.state, c.result_ref, c.error_code/i.test(sql)) {
        return queryResult<T>([{
          id: TASK_ID, task_key: 'child-1', state: child.state, result_ref: child.result_ref ?? null, error_code: null,
        }]);
      }
      if (/^\s*UPDATE tasks SET state='QUEUED'/i.test(sql)) {
        parentUpdateSql.push(sql);
        parent.state = 'QUEUED';
        parent.lease_epoch = Number(parent.lease_epoch) + 1;
        parent.lease_expires_at = null;
        parent.leased_by = null;
        parent.payload_ref = JSON.parse(String(params[1])) as unknown;
        return queryResult<T>([{ id: PARENT_ID }], 'UPDATE');
      }
      if (/^\s*INSERT INTO outbox/i.test(sql)) {
        outbox.add(String(params[1]));
        return queryResult<T>([{ id: 'outbox-join' }], 'INSERT');
      }
      if (/^\s*UPDATE operations SET state='QUEUED'/i.test(sql)) {
        operation.state = 'QUEUED';
        return queryResult<T>([{ id: OPERATION_ID }], 'UPDATE');
      }
      if (/^\s*SELECT state FROM operations WHERE id=\$1/i.test(sql)) {
        return queryResult<T>([{ state: operation.state }]);
      }
      throw new Error(`unexpected join SQL: ${sql}`);
    },
  };
  const db = {
    query: async () => { throw new Error('unexpected pool query'); },
    tx: async <T>(fn: (db: never) => Promise<T>) => fn(client as never),
  } as unknown as Db;
  return { db, child, parent, outbox, parentUpdateSql };
}

describe('WOC-02 resume and join continuation fencing', () => {
  it('resume advances and clears a legacy wait lease, then replays without another delivery', async () => {
    const fixture = makeResumeDb();
    const runtime = createRuntimeService(fixture.db);
    const body = { waitId: 'wait_woc_resume', input: { answer: 'approved' }, expectedStateVersion: 7 };

    const resumed = await runtime.resumeOperation(OPERATION_ID, 'tenant-a', body);

    expect(resumed).toMatchObject({ state: 'QUEUED', stateVersion: 8, replayed: false, taskId: TASK_ID });
    expect(fixture.task).toMatchObject({ state: 'QUEUED', lease_epoch: 4, leased_by: null, lease_expires_at: null });
    expect(fixture.taskUpdateSql[0]).toContain('lease_epoch=lease_epoch+1');
    expect(fixture.taskUpdateSql[0]).toContain('lease_expires_at=NULL');
    expect(fixture.taskUpdateSql[0]).toContain('leased_by=NULL');
    expect(fixture.outbox).toEqual(new Set([`${TASK_ID}:resume:8`]));

    const replay = await runtime.resumeOperation(OPERATION_ID, 'tenant-a', {
      ...body,
      expectedStateVersion: 8,
    });
    expect(replay).toMatchObject({ state: 'QUEUED', stateVersion: 8, replayed: true });
    expect(fixture.outbox.size).toBe(1);
    expect(fixture.task.lease_epoch).toBe(4);
  });

  it('child join advances and clears a legacy parent lease before one continuation intent', async () => {
    const fixture = makeJoinDb();
    const runtime = createRuntimeService(fixture.db);

    const completed = await runtime.completeTask(TASK_ID, {
      leaseEpoch: 4,
      resultRef: 'memory://child-result',
      resultHash: contentHash('memory://child-result'),
    }, BUSINESS_ID);

    expect(completed).toMatchObject({ taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'QUEUED', replayed: false });
    expect(fixture.parent).toMatchObject({
      state: 'QUEUED', lease_epoch: 12, leased_by: null, lease_expires_at: null,
    });
    expect(fixture.parentUpdateSql[0]).toContain('lease_epoch=lease_epoch+1');
    expect(fixture.parentUpdateSql[0]).toContain('lease_expires_at=NULL');
    expect(fixture.parentUpdateSql[0]).toContain('leased_by=NULL');
    expect(fixture.outbox).toEqual(new Set([`${PARENT_ID}:join:1`]));

    const replay = await runtime.completeTask(TASK_ID, {
      leaseEpoch: 4,
      resultRef: 'memory://child-result',
      resultHash: contentHash('memory://child-result'),
    }, BUSINESS_ID);
    expect(replay).toMatchObject({ state: 'SUCCEEDED', replayed: true });
    expect(fixture.outbox.size).toBe(1);
  });
});
