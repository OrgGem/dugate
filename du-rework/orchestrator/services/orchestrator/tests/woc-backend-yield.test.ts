import type { QueryResult, QueryResultRow } from 'pg';
import { contentHash } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createRuntimeService } from '../src/modules/runtime/runtime';

const TASK_ID = '7a000000-0000-4000-8000-000000000001';
const OPERATION_ID = '7b000000-0000-4000-8000-000000000001';
const BUSINESS_ID = 'business-a';
const WORKER_ID = 'worker-a';

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return { command, rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

function makeYieldDb() {
  const task: Record<string, unknown> = {
    id: TASK_ID,
    task_key: 'root',
    kind: 'root',
    state: 'RUNNING',
    lease_epoch: 9,
    lease_expires_at: new Date(Date.now() + 60_000),
    leased_by: WORKER_ID,
    attempt: 3,
    operation_id: OPERATION_ID,
    tenant_id: 'tenant-a',
    business_id: BUSINESS_ID,
    business_version: '1.0.0',
    action: 'extract',
    correlation_id: 'woc-yield-test',
    payload_ref: {},
  };
  const children = new Map<string, { id: string; task_key: string; payload_ref: unknown }>();
  const waits = new Map<string, {
    id: string; wait_key: string; wait_id: string; input_schema: unknown; expires_at: Date; status: string;
  }>();
  const updates: string[] = [];
  const inserts: string[] = [];

  const client = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<T>> => {
      if (/^\s*SELECT/i.test(sql) && /FROM tasks t\s+JOIN operations o/i.test(sql)) {
        return queryResult<T>([{
          ...task,
          lease_active: task.state === 'RUNNING'
            && (task.lease_expires_at as Date).getTime() > Date.now(),
        }]);
      }
      if (/^\s*SELECT id, task_key, payload_ref FROM tasks WHERE operation_id/i.test(sql)) {
        const keys = params[1] as string[];
        return queryResult<T>([...children.values()].filter((row) => keys.includes(row.task_key)));
      }
      if (/^\s*SELECT state FROM tasks WHERE id=\$1/i.test(sql)) {
        return queryResult<T>([{ state: task.state }]);
      }
      if (/^\s*SELECT manifest FROM business_versions/i.test(sql)) {
        return queryResult<T>([{
          manifest: {
            runtime: { handlerKinds: ['root', 'child'] },
            actions: [{ name: 'extract', defaultLimits: { maxParallelTasks: 4 } }],
          },
        }]);
      }
      if (/^\s*SELECT count\(\*\)::int AS n FROM task_dependencies/i.test(sql)) {
        return queryResult<T>([{ n: 0 }]);
      }
      if (/^\s*SELECT wait_id, input_schema, expires_at, status FROM human_waits WHERE task_id=\$1 AND wait_key=\$2/i.test(sql)) {
        const found = [...waits.values()].find((row) => row.wait_key === params[1]);
        return queryResult<T>(found ? [{ ...found }] : []);
      }
      if (/^\s*INSERT INTO tasks/i.test(sql)) {
        inserts.push(sql);
        const [id, , , taskKey, , payloadRef] = params as [string, string, string, string, string, string];
        children.set(taskKey, { id, task_key: taskKey, payload_ref: JSON.parse(payloadRef) as unknown });
        return queryResult<T>([{ id }], 'INSERT');
      }
      if (/^\s*INSERT INTO task_dependencies/i.test(sql) || /^\s*INSERT INTO outbox/i.test(sql)) {
        inserts.push(sql);
        return queryResult<T>([], 'INSERT');
      }
      if (/^\s*INSERT INTO human_waits/i.test(sql)) {
        inserts.push(sql);
        const [operationId, taskId, waitKey, waitId, inputSchema, , , expiresAt] = params as
          [string, string, string, string, string, unknown, unknown, string];
        const wait: { id: string; wait_key: string; wait_id: string; input_schema: unknown; expires_at: Date; status: string } = {
          id: `${operationId}:${taskId}:${waitKey}`,
          wait_key: waitKey,
          wait_id: waitId,
          input_schema: JSON.parse(inputSchema) as unknown,
          expires_at: new Date(expiresAt),
          status: 'OPEN',
        };
        waits.set(waitKey, wait);
        return queryResult<T>([], 'INSERT');
      }
      if (/^\s*UPDATE tasks t\s+SET state='WAITING_CHILDREN'/i.test(sql)) {
        updates.push(sql);
        task.state = 'WAITING_CHILDREN';
        task.lease_epoch = Number(task.lease_epoch) + 1;
        task.lease_expires_at = null;
        task.leased_by = null;
        task.payload_ref = JSON.parse(String(params[1])) as unknown;
        return queryResult<T>([{ id: TASK_ID }], 'UPDATE');
      }
      if (/^\s*UPDATE tasks t\s+SET state='WAITING_INPUT'/i.test(sql)) {
        updates.push(sql);
        task.state = 'WAITING_INPUT';
        task.lease_epoch = Number(task.lease_epoch) + 1;
        task.lease_expires_at = null;
        task.leased_by = null;
        return queryResult<T>([{ id: TASK_ID }], 'UPDATE');
      }
      if (/^\s*UPDATE operations SET state='WAITING_/i.test(sql)) {
        updates.push(sql);
        return queryResult<T>([{ id: OPERATION_ID }], 'UPDATE');
      }
      throw new Error(`unexpected offline yield SQL: ${sql}`);
    },
  };
  const db = {
    query: async () => { throw new Error('unexpected pool query'); },
    tx: async <T>(fn: (db: never) => Promise<T>) => fn(client as never),
  } as unknown as Db;
  return { db, task, children, waits, updates, inserts };
}

describe('WOC-02 runtime yield lease fencing', () => {
  it('spawn yield clears the lease, advances the epoch, and replays the same child set after yield', async () => {
    const fixture = makeYieldDb();
    const runtime = createRuntimeService(fixture.db);
    const payloadRef = { source: 'resume-me' };
    const request = {
      leaseEpoch: 9,
      children: [{ taskKey: 'child-1', kind: 'child', payloadRef, payloadHash: contentHash(payloadRef) }],
      joinPolicy: 'all-success' as const,
      continuationRef: 'continue-after-child',
    };

    const yielded = await runtime.spawnChildren(TASK_ID, request, BUSINESS_ID);
    expect(yielded).toMatchObject({ parentState: 'WAITING_CHILDREN' });
    expect(yielded.childTaskIds).toHaveLength(1);
    expect(fixture.task).toMatchObject({ state: 'WAITING_CHILDREN', lease_epoch: 10, leased_by: null, lease_expires_at: null });
    expect(fixture.inserts.filter((sql) => /^\s*INSERT INTO tasks/i.test(sql))).toHaveLength(1);

    const replay = await runtime.spawnChildren(TASK_ID, request, BUSINESS_ID);
    expect(replay).toEqual(yielded);
    expect(fixture.inserts.filter((sql) => /^\s*INSERT INTO tasks/i.test(sql))).toHaveLength(1);
    await expect(runtime.heartbeatTask(TASK_ID, 9, BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });
    const transition = fixture.updates.find((sql) => /SET state='WAITING_CHILDREN'/i.test(sql)) ?? '';
    expect(transition).toContain('lease_epoch=lease_epoch+1');
    expect(transition).toContain('lease_expires_at=NULL');
    expect(transition).toContain('leased_by=NULL');
  });

  it('human wait yield clears the lease, advances the epoch, and replays the same open wait', async () => {
    const fixture = makeYieldDb();
    const runtime = createRuntimeService(fixture.db);
    const request = {
      leaseEpoch: 9,
      waitKey: 'approval',
      inputSchema: { type: 'object', properties: { approved: { type: 'boolean' } }, required: ['approved'] },
    };

    const yielded = await runtime.waitInput(TASK_ID, request, BUSINESS_ID);
    expect(yielded.waitId).toMatch(/^wait_/);
    expect(fixture.task).toMatchObject({ state: 'WAITING_INPUT', lease_epoch: 10, leased_by: null, lease_expires_at: null });
    expect(fixture.inserts.filter((sql) => /^\s*INSERT INTO human_waits/i.test(sql))).toHaveLength(1);

    const replay = await runtime.waitInput(TASK_ID, request, BUSINESS_ID);
    expect(replay).toEqual(yielded);
    expect(fixture.inserts.filter((sql) => /^\s*INSERT INTO human_waits/i.test(sql))).toHaveLength(1);
    await expect(runtime.heartbeatTask(TASK_ID, 9, BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });
    const transition = fixture.updates.find((sql) => /SET state='WAITING_INPUT'/i.test(sql)) ?? '';
    expect(transition).toContain('lease_epoch=lease_epoch+1');
    expect(transition).toContain('lease_expires_at=NULL');
    expect(transition).toContain('leased_by=NULL');
  });
});
