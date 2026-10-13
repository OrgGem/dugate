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
    api_key_id: 'key-a',
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
  const waits: Record<string, unknown>[] = [wait];
  const outbox = new Set<string>();
  const taskUpdateSql: string[] = [];
  const operationQueries: { sql: string; params: unknown[] }[] = [];
  const events: string[] = [];

  const client = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
      events.push(`sql:${sql}`);
      if (/^\s*SELECT id, tenant_id, state, state_version, endpoint_slug FROM operations/i.test(sql)) {
        operationQueries.push({ sql, params });
        if (sql.includes('api_key_id=$3 AND deleted_at IS NULL')
            && (params[1] !== operation.tenant_id || params[2] !== operation.api_key_id)) {
          return queryResult<T>([]);
        }
        return queryResult<T>([{ ...operation }]);
      }
      if (/^\s*SELECT id, task_id, wait_id, input_schema, status, response_ref FROM human_waits/i.test(sql)) {
        const matching = waits.find((candidate) => candidate.wait_id === params[1]);
        return queryResult<T>(matching === undefined ? [] : [{ ...matching }]);
      }
      if (/^\s*UPDATE human_waits SET status='ANSWERED'/i.test(sql)) {
        wait.status = 'ANSWERED';
        wait.response_ref = JSON.parse(String(params[1])) as unknown;
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
  return { db, operation, task, wait, waits, outbox, taskUpdateSql, operationQueries, client, events };
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
  it('resume advances and clears a legacy wait lease, then replays the identical CAS body', async () => {
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

    const replay = await runtime.resumeOperation(OPERATION_ID, 'tenant-a', body);
    expect(replay).toMatchObject({ state: 'QUEUED', stateVersion: 8, replayed: true });
    expect(fixture.outbox.size).toBe(1);
    expect(fixture.task.lease_epoch).toBe(4);

    await expect(runtime.resumeOperation(OPERATION_ID, 'tenant-a', {
      ...body,
      input: { answer: 'changed' },
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    await expect(runtime.resumeOperation(OPERATION_ID, 'tenant-a', {
      ...body,
      expectedStateVersion: 8,
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });

    fixture.waits.push({
      id: 'wait-row-2',
      task_id: TASK_ID,
      wait_id: 'wait_woc_resume_other',
      input_schema: { type: 'object' },
      status: 'OPEN',
    });
    await expect(runtime.resumeOperation(OPERATION_ID, 'tenant-a', {
      waitId: 'wait_woc_resume_other',
      input: {},
      expectedStateVersion: 7,
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(fixture.outbox.size).toBe(1);
    expect(fixture.waits[1]?.status).toBe('OPEN');
  });

  it('scopes a CAS resume to the exact API key before reading the operation', async () => {
    const fixture = makeResumeDb();
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.resumeOperation(OPERATION_ID, 'tenant-a', {
      waitId: 'wait_woc_resume',
      input: { answer: 'approved' },
      expectedStateVersion: 7,
    }, undefined, 'key-b')).rejects.toMatchObject({ status: 404 });

    expect(fixture.operationQueries).toHaveLength(1);
    expect(fixture.operationQueries[0]).toMatchObject({
      params: [OPERATION_ID, 'tenant-a', 'key-b'],
    });
    expect(fixture.operationQueries[0]?.sql).toContain('api_key_id=$3 AND deleted_at IS NULL');
    expect(fixture.wait.status).toBe('OPEN');
    expect(fixture.outbox.size).toBe(0);
  });

  it('replays the identical answer after terminal completion but rejects new terminal resumes', async () => {
    const fixture = makeResumeDb();
    const runtime = createRuntimeService(fixture.db);
    const body = { waitId: 'wait_woc_resume', input: { answer: 'approved' }, expectedStateVersion: 7 };

    await runtime.resumeOperation(OPERATION_ID, 'tenant-a', body);
    fixture.operation.state = 'SUCCEEDED';
    fixture.operation.state_version = 9;

    const replay = await runtime.resumeOperation(OPERATION_ID, 'tenant-a', body);
    expect(replay).toMatchObject({ state: 'SUCCEEDED', stateVersion: 9, replayed: true });
    await expect(runtime.resumeOperation(OPERATION_ID, 'tenant-a', {
      ...body,
      input: { answer: 'changed' },
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    await expect(runtime.resumeOperation(OPERATION_ID, 'tenant-a', {
      ...body,
      expectedStateVersion: 8,
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });

    fixture.waits.push({
      id: 'wait-row-terminal',
      task_id: TASK_ID,
      wait_id: 'wait_woc_resume_terminal',
      input_schema: { type: 'object' },
      status: 'OPEN',
    });
    await expect(runtime.resumeOperation(OPERATION_ID, 'tenant-a', {
      waitId: 'wait_woc_resume_terminal',
      input: {},
      expectedStateVersion: 9,
    })).rejects.toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
    expect(fixture.waits[1]?.status).toBe('OPEN');
    expect(fixture.outbox).toEqual(new Set([`${TASK_ID}:resume:8`]));
  });

  it('active-client resume checks the backup gate before taking the operation lock', async () => {
    const fixture = makeResumeDb();
    const gate = {
      assertWriteAllowed: async (_client: unknown, input: { tenantId: string | null; domain: string }) => {
        fixture.events.push(`gate:${input.domain}:${input.tenantId}`);
      },
    };
    const runtime = createRuntimeService(fixture.db, undefined, undefined, undefined, gate as never);

    await runtime.resumeOperation(OPERATION_ID, 'tenant-a', {
      waitId: 'wait_woc_resume',
      input: { answer: 'approved' },
      expectedStateVersion: 7,
    }, fixture.client as never);

    expect(fixture.events[0]).toBe('gate:work-admission:tenant-a');
    expect(fixture.events[1]).toMatch(/^sql:SELECT id, tenant_id, state, state_version, endpoint_slug FROM operations/i);
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
