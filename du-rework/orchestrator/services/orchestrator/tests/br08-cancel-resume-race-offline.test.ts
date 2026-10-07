import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import { createLifecycleService } from '../src/modules/lifecycle/lifecycle';
import { createRuntimeService } from '../src/modules/runtime/runtime';

const OPERATION_ID = '81000000-0000-4000-8000-000000000001';
const TENANT_ID = '82000000-0000-4000-8000-000000000001';
const TASK_ID = '83000000-0000-4000-8000-000000000001';

type OperationState = 'WAITING_INPUT' | 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'TIMED_OUT';

interface QueryEvent {
  transactionId: number;
  sql: string;
}

function pgResult<T extends QueryResultRow>(rows: Array<Record<string, unknown>>, command = 'SELECT'): QueryResult<T> {
  return {
    command,
    rowCount: rows.length,
    oid: 0,
    rows: rows as T[],
    fields: [],
  };
}

function createRaceHarness(initialState: OperationState) {
  const operation = { state: initialState, stateVersion: 4 };
  const task = {
    state: initialState === 'WAITING_INPUT' ? 'WAITING_INPUT' : initialState === 'TIMED_OUT' ? 'CANCELLED' : initialState,
  };
  const wait = { status: initialState === 'WAITING_INPUT' ? 'OPEN' : 'CANCELLED' };
  const events: QueryEvent[] = [];
  const counters = {
    cancellationOperationUpdates: 0,
    cancellationTaskUpdates: 0,
    waitUpdates: 0,
    resumeQueueWrites: 0,
    childTaskInserts: 0,
  };

  // Serialize transactions like the operations row's FOR UPDATE lock. This
  // keeps the interleaving deterministic without opening a DB or Redis client.
  let transactionTail: Promise<void> = Promise.resolve();
  let nextTransactionId = 0;
  const db = {
    query: async () => {
      throw new Error('race harness must use only transaction-scoped SQL');
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      const previous = transactionTail;
      let release: () => void = () => undefined;
      transactionTail = new Promise<void>((resolve) => {
        release = resolve;
      });
      await previous;
      const transactionId = ++nextTransactionId;
      const client = {
        query: async <Row extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<Row>> => {
          const normalized = sql.replace(/\s+/g, ' ').trim();
          events.push({ transactionId, sql: normalized });

          if (/^SELECT .* FROM operations WHERE id=\$1 FOR UPDATE$/i.test(normalized)) {
            return pgResult<Row>([{
              id: OPERATION_ID,
              tenant_id: TENANT_ID,
              state: operation.state,
              state_version: operation.stateVersion,
            }]);
          }
          if (/^UPDATE operations SET state='CANCELLED'/i.test(normalized)) {
            counters.cancellationOperationUpdates += 1;
            operation.state = 'CANCELLED';
            operation.stateVersion += 1;
            return pgResult<Row>([], 'UPDATE');
          }
          if (/^UPDATE tasks SET state='CANCELLED'/i.test(normalized)) {
            counters.cancellationTaskUpdates += 1;
            task.state = 'CANCELLED';
            return pgResult<Row>([], 'UPDATE');
          }
          if (/^UPDATE human_waits SET status='CANCELLED'/i.test(normalized)) {
            counters.waitUpdates += 1;
            wait.status = 'CANCELLED';
            return pgResult<Row>([], 'UPDATE');
          }
          if (/^SELECT id, tenant_id, state, state_version, callback_url,/i.test(normalized)) {
            return pgResult<Row>([{
              id: OPERATION_ID,
              tenant_id: TENANT_ID,
              state: operation.state,
              state_version: operation.stateVersion,
              callback_url: null,
              updated_at: '2026-09-25T00:00:00.000Z',
            }]);
          }
          if (/^INSERT INTO outbox/i.test(normalized) || /^UPDATE tasks SET state='QUEUED'/i.test(normalized) || /^UPDATE operations SET state='QUEUED'/i.test(normalized)) {
            counters.resumeQueueWrites += 1;
            return pgResult<Row>([], 'UPDATE');
          }
          if (/^INSERT INTO tasks/i.test(normalized)) {
            counters.childTaskInserts += 1;
            return pgResult<Row>([], 'INSERT');
          }

          throw new Error(`unexpected race-harness SQL: ${normalized}`);
        },
      };
      try {
        return await fn(client as never);
      } finally {
        release();
      }
    },
    close: async () => undefined,
  } as unknown as Db;

  return { db, operation, task, wait, events, counters };
}

async function expectResumeConflict(outcome: PromiseSettledResult<unknown>): Promise<void> {
  expect(outcome.status).toBe('rejected');
  if (outcome.status !== 'rejected') throw new Error('resume unexpectedly succeeded');
  expect(outcome.reason).toBeInstanceOf(HttpError);
  expect(outcome.reason).toMatchObject({ status: 409, code: 'STATE_CONFLICT' });
}

describe('BR-08 offline cancel/resume race', () => {
  it('rejects resume when concurrent cancellation wins the operation lock', async () => {
    const harness = createRaceHarness('WAITING_INPUT');
    const lifecycle = createLifecycleService(harness.db);
    const runtime = createRuntimeService(harness.db);

    const cancelPromise = lifecycle.cancelOperation(OPERATION_ID, TENANT_ID);
    const resumePromise = runtime.resumeOperation(OPERATION_ID, TENANT_ID, {
      waitId: 'br08-wait-1',
      input: { approved: true },
      expectedStateVersion: 4,
    });
    const [cancelOutcome, resumeOutcome] = await Promise.allSettled([cancelPromise, resumePromise]);

    expect(cancelOutcome).toMatchObject({ status: 'fulfilled', value: { state: 'CANCELLED', replayed: false } });
    await expectResumeConflict(resumeOutcome);
    expect(harness.operation).toMatchObject({ state: 'CANCELLED', stateVersion: 5 });
    expect(harness.task.state).toBe('CANCELLED');
    expect(harness.wait.status).toBe('CANCELLED');

    const resumeQueries = harness.events.filter((event) => event.transactionId === 2);
    expect(resumeQueries).toHaveLength(1);
    expect(resumeQueries[0]?.sql).toMatch(/^SELECT .* FROM operations .* FOR UPDATE$/i);
    expect(harness.counters.resumeQueueWrites).toBe(0);
    expect(harness.counters.childTaskInserts).toBe(0);
  });

  it.each(['CANCELLED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'] as const)(
    'rejects resume with STATE_CONFLICT when operation is already terminal (%s)',
    async (terminalState) => {
      const harness = createRaceHarness(terminalState);
      const lifecycle = createLifecycleService(harness.db);
      const runtime = createRuntimeService(harness.db);

      const cancelPromise = lifecycle.cancelOperation(OPERATION_ID, TENANT_ID);
      const resumePromise = runtime.resumeOperation(OPERATION_ID, TENANT_ID, {
        waitId: 'br08-wait-terminal',
        input: { approved: true },
        expectedStateVersion: 4,
      });
      const [cancelOutcome, resumeOutcome] = await Promise.allSettled([cancelPromise, resumePromise]);

      expect(cancelOutcome).toMatchObject({
        status: 'fulfilled',
        value: { state: terminalState, replayed: true },
      });
      await expectResumeConflict(resumeOutcome);
      expect(harness.operation.state).toBe(terminalState);

      const resumeQueries = harness.events.filter((event) => event.transactionId === 2);
      expect(resumeQueries).toHaveLength(1);
      expect(resumeQueries[0]?.sql).toMatch(/^SELECT .* FROM operations .* FOR UPDATE$/i);
      expect(harness.counters.cancellationOperationUpdates).toBe(0);
      expect(harness.counters.resumeQueueWrites).toBe(0);
      expect(harness.counters.childTaskInserts).toBe(0);
    }
  );
});
