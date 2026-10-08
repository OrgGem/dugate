import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createRuntimeService } from '../src/modules/runtime/runtime';

const TASK_ID = '7c000000-0000-4000-8000-000000000001';
const OPERATION_ID = '7d000000-0000-4000-8000-000000000001';
const LEASE_EPOCH = 12;
const WORKER_BUSINESS = 'document-core';

/**
 * Offline fixture for failTask when the legacy cancel already recorded a
 * CANCEL_REQUESTED signal (cancel-with-active-worker path,
 * compat/legacy-host-adapter.ts) while the root task is still RUNNING.
 */
function makeCancelRequestedDb(cancelRequested: boolean) {
  const task = {
    lease_epoch: LEASE_EPOCH,
    lease_expires_at: new Date(Date.now() + 60_000),
    lease_active: true,
    state: 'RUNNING',
    business_id: WORKER_BUSINESS,
    operation_id: OPERATION_ID,
    attempt: 1,
    max_attempts: 3,
    kind: 'root',
    business_version: '1.1.0',
    action: 'schema-workflow',
    correlation_id: 'wfa-t27-offline',
    // Carried by the operation row (SELECT ... o.* in failTask).
    cancel_requested: cancelRequested,
    op_state: cancelRequested ? 'CANCEL_REQUESTED' : 'RUNNING',
  };
  const operation = { state: cancelRequested ? 'CANCEL_REQUESTED' : 'RUNNING', callback_url: null };
  const writes: string[] = [];

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in wfa-t27 offline test: ${sql}`);
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      const client = {
        query: async <R extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<R>> => {
          if (/^\s*SELECT/i.test(sql) && /FROM tasks t\s+JOIN operations o/i.test(sql)) {
            return { command: 'SELECT', rowCount: 1, oid: 0, rows: [task] as unknown as R[], fields: [] };
          }
          if (/^\s*SELECT/i.test(sql) && /FROM operations WHERE id=\$1/i.test(sql)) {
            return { command: 'SELECT', rowCount: 1, oid: 0, rows: [operation] as unknown as R[], fields: [] };
          }
          if (/^\s*SELECT/i.test(sql)) {
            return { command: 'SELECT', rowCount: 0, oid: 0, rows: [] as unknown as R[], fields: [] };
          }
          if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) {
            writes.push(sql);
            return { command: 'UPDATE', rowCount: 1, oid: 0, rows: [{ id: TASK_ID }] as unknown as R[], fields: [] };
          }
          throw new Error(`unexpected transaction query in wfa-t27 offline test: ${sql}`);
        },
      };
      return fn(client as never);
    },
    close: async () => undefined,
  } as unknown as Db;

  return { db, writes };
}

test('a worker failure report after a requested cancel resolves as CANCELLED, not FAILED', async () => {
  const { db, writes } = makeCancelRequestedDb(true);
  const runtime = createRuntimeService(db);
  const result = await runtime.failTask(TASK_ID, {
    leaseEpoch: LEASE_EPOCH,
    errorCode: 'LEGACY_WORKFLOW_CONNECTOR_FAILED',
    retryable: false,
  }, WORKER_BUSINESS);
  // The cancel was accepted by the legacy route before the worker aborted;
  // the acknowledged cancel must stay the terminal state of BOTH rows.
  expect(result).toMatchObject({ state: 'CANCELLED', operationState: 'CANCELLED' });
  expect(writes.some((sql) => /UPDATE operations SET state='FAILED'/.test(sql))).toBe(false);
  expect(writes.some((sql) => /UPDATE tasks t SET state='CANCELLED'/.test(sql))).toBe(true);
});

test('a requested cancel also wins over a retryable worker failure (no RETRY_PENDING)', async () => {
  const { db, writes } = makeCancelRequestedDb(true);
  const runtime = createRuntimeService(db);
  const result = await runtime.failTask(TASK_ID, {
    leaseEpoch: LEASE_EPOCH,
    errorCode: 'PROVIDER_TIMEOUT',
    retryable: true,
    retryAfterMs: 5_000,
  }, WORKER_BUSINESS);
  expect(result).toMatchObject({ state: 'CANCELLED', operationState: 'CANCELLED' });
  expect(writes.some((sql) => /state='RETRY_PENDING'/.test(sql))).toBe(false);
  expect(writes.some((sql) => /INSERT INTO outbox/.test(sql))).toBe(false);
});

test('without a cancel signal failTask still records FAILED (guard against over-correction)', async () => {
  const { db } = makeCancelRequestedDb(false);
  const runtime = createRuntimeService(db);
  const result = await runtime.failTask(TASK_ID, {
    leaseEpoch: LEASE_EPOCH,
    errorCode: 'SYNTHETIC_FAILURE',
    retryable: false,
  }, WORKER_BUSINESS);
  expect(result).toMatchObject({ state: 'FAILED', operationState: 'FAILED' });
});