import type { QueryResult, QueryResultRow } from 'pg';
import { contentHash } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createRuntimeService } from '../src/modules/runtime/runtime';

const TASK_ID = '7a000000-0000-4000-8000-000000000001';
const BUSINESS_A = 'business-a';
const BUSINESS_B = 'business-b';
const RESULT_REF = 'memory://result';

interface TaskFixture {
  lease_epoch: number;
  lease_expires_at: Date;
  lease_active: boolean;
  state: string;
  business_id: string;
  operation_id: string;
  attempt: number;
  max_attempts: number;
  kind: string;
  business_version: string;
  action: string;
  correlation_id: string;
}

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return {
    command,
    rowCount: rows.length,
    oid: 0,
    rows: rows as T[],
    fields: [],
  };
}

function makeOfflineDb(overrides: Partial<TaskFixture> = {}, loseFenceAtWrite = false) {
  const task: TaskFixture = {
    lease_epoch: 12,
    lease_expires_at: new Date(Date.now() + 60_000),
    lease_active: true,
    state: 'RUNNING',
    business_id: BUSINESS_A,
    operation_id: '7b000000-0000-4000-8000-000000000001',
    attempt: 1,
    max_attempts: 3,
    kind: 'root',
    business_version: '1.0.0',
    action: 'extract',
    correlation_id: 'lease-fencing-offline',
    ...overrides,
  };
  const attemptedWrites: string[] = [];
  const committedWrites: string[] = [];
  let rollbacks = 0;

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in offline lease test: ${sql}`);
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      const transactionWrites: string[] = [];
      const client = {
        query: async <R extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<R>> => {
          if (/^\s*SELECT/i.test(sql) && /FROM tasks t\s+JOIN operations o/i.test(sql)) {
            return queryResult<R>([task]);
          }
          if (/^\s*SELECT/i.test(sql) && /FROM operations WHERE id=\$1/i.test(sql)) {
            return queryResult<R>([{ state: 'RUNNING' }]);
          }
          if (/^\s*SELECT/i.test(sql) && /FROM step_checkpoints/i.test(sql)) {
            return queryResult<R>([]);
          }
          if (/^\s*(UPDATE|INSERT|DELETE)/i.test(sql)) {
            attemptedWrites.push(sql);
            transactionWrites.push(sql);
            if (loseFenceAtWrite) {
              return queryResult<R>([], sql.trim().split(/\s+/, 1)[0]!.toUpperCase());
            }
            if (/UPDATE tasks t SET lease_expires_at/i.test(sql)) {
              return queryResult<R>([{ lease_expires_at: new Date(Date.now() + 60_000) }], 'UPDATE');
            }
            return queryResult<R>([{ id: TASK_ID }], sql.trim().split(/\s+/, 1)[0]!.toUpperCase());
          }
          throw new Error(`unexpected transaction query in offline lease test: ${sql}`);
        },
      };
      try {
        const value = await fn(client as never);
        committedWrites.push(...transactionWrites);
        return value;
      } catch (error) {
        rollbacks += 1;
        throw error;
      }
    },
    close: async () => undefined,
  } as unknown as Db;

  return {
    db,
    task,
    attemptedWrites,
    committedWrites,
    get rollbacks() { return rollbacks; },
  };
}

function makeLeaseTakeoverRaceDb() {
  const task = {
    id: TASK_ID,
    lease_epoch: 12,
    lease_expires_at: new Date(Date.now() - 60_000),
    lease_active: false,
    state: 'RUNNING',
    business_id: BUSINESS_A,
    operation_id: '7b000000-0000-4000-8000-000000000001',
    attempt: 1,
    max_attempts: 3,
    kind: 'root',
    business_version: '1.0.0',
    action: 'extract',
    correlation_id: 'lease-takeover-race-offline',
    tenant_id: 'tenant-a',
    input_ref: {},
    deadline_at: null,
    manifest_digest: 'sha256:offline',
    profile_revision: 1,
    connector_bindings: {},
    task_key: 'root',
    payload_ref: {},
    last_delivery_id: 'delivery-a',
    leased_by: 'worker-a',
  };
  const operation = {
    id: task.operation_id,
    state: 'RUNNING',
    state_version: 1,
    tenant_id: 'tenant-a',
    callback_url: null as string | null,
    updated_at: new Date().toISOString(),
  };
  const claimUpdates: string[] = [];
  const terminalUpdateSql: string[] = [];
  const committedWrites: string[] = [];
  const committedTerminalMutations: { state: string; leaseEpoch: number }[] = [];
  let rollbacks = 0;
  let transactionTail: Promise<void> = Promise.resolve();

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in lease takeover race test: ${sql}`);
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      const previous = transactionTail;
      let unlock: () => void = () => undefined;
      transactionTail = new Promise<void>((resolve) => { unlock = resolve; });
      await previous;

      const stagedTask = { ...task };
      const stagedOperation = { ...operation };
      const stagedWriteSql: string[] = [];
      let stagedTerminalMutation: { state: string; leaseEpoch: number } | undefined;
      const client = {
        query: async <R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> => {
          if (/^\s*SELECT/i.test(sql) && /FROM tasks t\s+JOIN operations o/i.test(sql)) {
            const row = {
              ...stagedTask,
              lease_active: stagedTask.lease_expires_at.getTime() > Date.now(),
            };
            return queryResult<R>([row as unknown as QueryResultRow]);
          }
          if (/^\s*SELECT/i.test(sql) && /FROM step_checkpoints/i.test(sql)) {
            return queryResult<R>([]);
          }
          if (/^\s*SELECT/i.test(sql) && /FROM task_dependencies WHERE child_id=\$1/i.test(sql)) {
            return queryResult<R>([]);
          }
          if (/^\s*SELECT state FROM operations WHERE id=\$1/i.test(sql)) {
            return queryResult<R>([{ state: stagedOperation.state }]);
          }
          if (/^\s*SELECT id, tenant_id, state, state_version, callback_url, updated_at FROM operations WHERE id=\$1/i.test(sql)) {
            return queryResult<R>([stagedOperation]);
          }
          if (/^\s*UPDATE tasks SET lease_epoch=\$2/i.test(sql)) {
            claimUpdates.push(sql);
            stagedWriteSql.push(sql);
            const [taskId, epoch, expiry, workerId, deliveryId] = params as [string, number, Date | string, string, string];
            if (taskId !== TASK_ID) return queryResult<R>([], 'UPDATE');
            stagedTask.lease_epoch = epoch;
            stagedTask.lease_expires_at = new Date(expiry);
            stagedTask.leased_by = workerId;
            stagedTask.last_delivery_id = deliveryId;
            stagedTask.state = 'RUNNING';
            stagedTask.attempt += 1;
            return queryResult<R>([{ id: TASK_ID }], 'UPDATE');
          }
          if (/^\s*UPDATE tasks t SET state='SUCCEEDED'/i.test(sql) || /^\s*UPDATE tasks t SET state='FAILED'/i.test(sql)) {
            terminalUpdateSql.push(sql);
            const state = /SET state='SUCCEEDED'/i.test(sql) ? 'SUCCEEDED' : 'FAILED';
            const [taskId, , epoch, workerBusinessId] = params as [string, unknown, number, string];
            const eligible = taskId === TASK_ID
              && stagedTask.lease_epoch === epoch
              && stagedTask.state === 'RUNNING'
              && stagedTask.lease_expires_at.getTime() > Date.now()
              && stagedTask.business_id === workerBusinessId;
            if (!eligible) return queryResult<R>([], 'UPDATE');
            stagedTask.state = state;
            stagedTerminalMutation = { state, leaseEpoch: epoch };
            stagedWriteSql.push(sql);
            return queryResult<R>([{ id: TASK_ID }], 'UPDATE');
          }
          if (/^\s*UPDATE operations SET state=/i.test(sql)) {
            stagedWriteSql.push(sql);
            const match = sql.match(/SET state='([^']+)'/i);
            if (match?.[1]) stagedOperation.state = match[1];
            stagedOperation.state_version += 1;
            stagedOperation.updated_at = new Date().toISOString();
            return queryResult<R>([{ id: stagedOperation.id }], 'UPDATE');
          }
          throw new Error(`unexpected transaction query in lease takeover race test: ${sql}`);
        },
      };

      try {
        const result = await fn(client as never);
        Object.assign(task, stagedTask);
        Object.assign(operation, stagedOperation);
        committedWrites.push(...stagedWriteSql);
        if (stagedTerminalMutation) committedTerminalMutations.push(stagedTerminalMutation);
        return result;
      } catch (error) {
        rollbacks += 1;
        throw error;
      } finally {
        unlock();
      }
    },
    close: async () => undefined,
  } as unknown as Db;

  return {
    db,
    task,
    claimUpdates,
    terminalUpdateSql,
    committedWrites,
    committedTerminalMutations,
    get rollbacks() { return rollbacks; },
  };
}

function makeExpiryDuringTransactionDb() {
  const startTime = Date.now();
  const leaseExpiresAt = new Date(startTime + 5);
  const task: TaskFixture = {
    lease_epoch: 12,
    lease_expires_at: leaseExpiresAt,
    lease_active: true,
    state: 'RUNNING',
    business_id: BUSINESS_A,
    operation_id: '7b000000-0000-4000-8000-000000000001',
    attempt: 1,
    max_attempts: 3,
    kind: 'root',
    business_version: '1.0.0',
    action: 'extract',
    correlation_id: 'lease-expiry-during-tx-offline',
  };
  const attemptedWrites: string[] = [];
  const committedWrites: string[] = [];
  let rollbacks = 0;
  let databaseClock = leaseExpiresAt.getTime() - 1;
  let selectsDone = 0;
  let clockAtSelect: number | undefined;
  let clockAtUpdate: number | undefined;
  let selectedLeaseActive = false;
  let conditionalExpiryPredicateSeen = false;

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in lease expiry test: ${sql}`);
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => {
      const transactionWrites: string[] = [];
      const client = {
        query: async <R extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []): Promise<QueryResult<R>> => {
          if (/^\s*SELECT/i.test(sql) && /FROM tasks t\s+JOIN operations o/i.test(sql)) {
            // Capture first-read telemetry only once: production issues a
            // second (diagnostic) read after a lost write-side CAS — the
            // test's SELECT-vs-UPDATE assertions are about the FOR UPDATE read.
            selectsDone += 1;
            const leaseActiveNow = task.lease_expires_at.getTime() > databaseClock;
            if (selectsDone === 1) {
              clockAtSelect = databaseClock;
              selectedLeaseActive = leaseActiveNow;
            }
            return queryResult<R>([{ ...task, lease_active: leaseActiveNow, cancel_requested: false, op_state: 'RUNNING' }]);
          }
          if (/^\s*UPDATE tasks t SET lease_expires_at/i.test(sql)) {
            attemptedWrites.push(sql);
            transactionWrites.push(sql);
            conditionalExpiryPredicateSeen = /t\.lease_expires_at\s*>\s*clock_timestamp\(\)/i.test(sql);

            // Simulate the database clock crossing a near deadline between
            // the SELECT's lease_active observation and the conditional UPDATE.
            databaseClock = leaseExpiresAt.getTime() + 1;
            clockAtUpdate = databaseClock;
            const [taskId, , leaseEpoch, workerBusinessId] = params as [string, unknown, number, string];
            const expiredAtWrite = task.lease_expires_at.getTime() <= databaseClock;
            const canUpdate = taskId === TASK_ID
              && task.lease_epoch === leaseEpoch
              && task.state === 'RUNNING'
              && task.business_id === workerBusinessId
              && (!conditionalExpiryPredicateSeen || !expiredAtWrite);
            if (!canUpdate) return queryResult<R>([], 'UPDATE');

            const renewedExpiry = new Date(databaseClock + Number(params[1]));
            task.lease_expires_at = renewedExpiry;
            return queryResult<R>([{ lease_expires_at: renewedExpiry }], 'UPDATE');
          }
          throw new Error(`unexpected transaction query in lease expiry test: ${sql}`);
        },
      };

      try {
        const value = await fn(client as never);
        committedWrites.push(...transactionWrites);
        return value;
      } catch (error) {
        rollbacks += 1;
        throw error;
      }
    },
    close: async () => undefined,
  } as unknown as Db;

  return {
    db,
    task,
    attemptedWrites,
    committedWrites,
    get rollbacks() { return rollbacks; },
    get clockAtSelect() { return clockAtSelect; },
    get clockAtUpdate() { return clockAtUpdate; },
    get selectedLeaseActive() { return selectedLeaseActive; },
    get conditionalExpiryPredicateSeen() { return conditionalExpiryPredicateSeen; },
  };
}

type Runtime = ReturnType<typeof createRuntimeService>;
interface MutationCase {
  name: string;
  invoke(runtime: Runtime, leaseEpoch: number, workerBusinessId: string): Promise<unknown>;
}

const MUTATIONS: MutationCase[] = [
  {
    name: 'heartbeatTask',
    invoke: (runtime, leaseEpoch, workerBusinessId) => runtime.heartbeatTask(TASK_ID, leaseEpoch, workerBusinessId),
  },
  {
    name: 'completeTask',
    invoke: (runtime, leaseEpoch, workerBusinessId) => runtime.completeTask(
      TASK_ID,
      { leaseEpoch, resultRef: RESULT_REF, resultHash: contentHash(RESULT_REF) },
      workerBusinessId
    ),
  },
  {
    name: 'failTask',
    invoke: (runtime, leaseEpoch, workerBusinessId) => runtime.failTask(
      TASK_ID,
      { leaseEpoch, errorCode: 'SYNTHETIC_FAILURE', retryable: true },
      workerBusinessId
    ),
  },
  {
    name: 'saveStep checkpoint',
    invoke: (runtime, leaseEpoch, workerBusinessId) => runtime.saveStep(
      TASK_ID,
      'checkpoint-1',
      { leaseEpoch, inputHash: 'input-hash', outputRef: 'memory://checkpoint', status: 'SUCCEEDED' },
      workerBusinessId
    ),
  },
];

const FENCING_CASES = [
  {
    name: 'stale epoch',
    task: { lease_epoch: 12, state: 'RUNNING', lease_active: true, business_id: BUSINESS_A },
    suppliedEpoch: 11,
    workerBusinessId: BUSINESS_A,
    status: 409,
    code: 'LEASE_LOST',
  },
  {
    name: 'expired lease with current epoch',
    task: { lease_epoch: 12, state: 'RUNNING', lease_active: false, business_id: BUSINESS_A },
    suppliedEpoch: 12,
    workerBusinessId: BUSINESS_A,
    status: 409,
    code: 'LEASE_LOST',
  },
  {
    name: 'cancelled task with current epoch',
    task: { lease_epoch: 12, state: 'CANCELLED', lease_active: false, business_id: BUSINESS_A },
    suppliedEpoch: 12,
    workerBusinessId: BUSINESS_A,
    status: 410,
    code: 'TASK_TERMINAL',
  },
  {
    name: 'foreign business identity',
    task: { lease_epoch: 12, state: 'RUNNING', lease_active: true, business_id: BUSINESS_B },
    suppliedEpoch: 12,
    workerBusinessId: BUSINESS_A,
    status: 403,
    code: 'PERMISSION_DENIED',
  },
] as const;

const TAKEOVER_TERMINAL_MUTATIONS: {
  name: string;
  terminalState: 'SUCCEEDED' | 'FAILED';
  invoke(runtime: Runtime, leaseEpoch: number): Promise<unknown>;
}[] = [
  {
    name: 'double-complete',
    terminalState: 'SUCCEEDED',
    invoke: (runtime, leaseEpoch) => runtime.completeTask(
      TASK_ID,
      { leaseEpoch, resultRef: RESULT_REF, resultHash: contentHash(RESULT_REF) },
      BUSINESS_A
    ),
  },
  {
    name: 'double-fail',
    terminalState: 'FAILED',
    invoke: (runtime, leaseEpoch) => runtime.failTask(
      TASK_ID,
      { leaseEpoch, errorCode: 'SYNTHETIC_FAILURE', retryable: false },
      BUSINESS_A
    ),
  },
];

const TAKEOVER_RACE_ORDERS = [
  { name: 'old worker reaches the task lock first', order: ['worker-a', 'worker-b'] },
  { name: 'new worker reaches the task lock first', order: ['worker-b', 'worker-a'] },
] as const;

describe('R1-B / FIX-CR-06 offline active-lease fencing', () => {
  for (const mutation of MUTATIONS) {
    for (const fencingCase of FENCING_CASES) {
      it(`${mutation.name} rejects ${fencingCase.name} without committing writes`, async () => {
        const fixture = makeOfflineDb(fencingCase.task);
        const runtime = createRuntimeService(fixture.db);

        await expect(mutation.invoke(runtime, fencingCase.suppliedEpoch, fencingCase.workerBusinessId))
          .rejects.toMatchObject({ status: fencingCase.status, code: fencingCase.code });

        expect(fixture.attemptedWrites).toEqual([]);
        expect(fixture.committedWrites).toEqual([]);
        expect(fixture.rollbacks).toBe(1);
      });
    }

    it(`${mutation.name} rolls back when the write-side lease CAS loses a race`, async () => {
      const fixture = makeOfflineDb({}, true);
      const runtime = createRuntimeService(fixture.db);

      await expect(mutation.invoke(runtime, 12, BUSINESS_A))
        .rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });

      expect(fixture.attemptedWrites).toHaveLength(1);
      expect(fixture.committedWrites).toEqual([]);
      expect(fixture.rollbacks).toBe(1);
    });
  }

  for (const mutationCase of TAKEOVER_TERMINAL_MUTATIONS) {
    for (const raceOrder of TAKEOVER_RACE_ORDERS) {
      it(`${mutationCase.name} cannot double-mutate after worker B claims a new lease when ${raceOrder.name}`, async () => {
        const fixture = makeLeaseTakeoverRaceDb();
        const runtime = createRuntimeService(fixture.db);

        // Worker A's epoch-12 lease has expired. Worker B reclaims through
        // the production claim service, which advances the persisted epoch.
        expect(fixture.task.leased_by).toBe('worker-a');
        expect(fixture.task.lease_expires_at.getTime()).toBeLessThan(Date.now());
        const workerBClaim = await runtime.claimTask(TASK_ID, 'delivery-b', 'worker-b', BUSINESS_A);
        expect(workerBClaim.leaseEpoch).toBe(13);
        expect(fixture.claimUpdates).toHaveLength(1);
        expect(fixture.task.lease_epoch).toBe(workerBClaim.leaseEpoch);
        expect(fixture.task.lease_expires_at.getTime()).toBeGreaterThan(Date.now());

        const workers = raceOrder.order.map((worker) => ({
          worker,
          leaseEpoch: worker === 'worker-a' ? 12 : workerBClaim.leaseEpoch,
        }));
        const results = await Promise.allSettled(
          workers.map(({ leaseEpoch }) => mutationCase.invoke(runtime, leaseEpoch))
        );
        const workerAResult = results[workers.findIndex(({ worker }) => worker === 'worker-a')]!;
        const workerBResult = results[workers.findIndex(({ worker }) => worker === 'worker-b')]!;

        expect(workerBResult.status).toBe('fulfilled');
        expect(workerAResult.status).toBe('rejected');
        if (workerAResult.status === 'rejected') {
          expect(workerAResult.reason).toMatchObject({ status: 409, code: 'LEASE_LOST' });
        }
        expect(fixture.task.state).toBe(mutationCase.terminalState);
        expect(fixture.terminalUpdateSql).toHaveLength(1);
        expect(fixture.terminalUpdateSql[0]).toMatch(/t\.lease_epoch=\$\d+/);
        expect(fixture.terminalUpdateSql[0]).toMatch(/t\.state='RUNNING'/);
        expect(fixture.terminalUpdateSql[0]).toMatch(/t\.lease_expires_at > clock_timestamp\(\)/);
        expect(fixture.terminalUpdateSql[0]).toMatch(/o\.business_id=\$\d+/);
        expect(fixture.committedTerminalMutations).toEqual([
          { state: mutationCase.terminalState, leaseEpoch: workerBClaim.leaseEpoch },
        ]);
        expect(fixture.rollbacks).toBe(1);
      });
    }
  }

  it('completeTask replays the same result idempotently without another state transition', async () => {
    const fixture = makeLeaseTakeoverRaceDb();
    const runtime = createRuntimeService(fixture.db);
    const workerBClaim = await runtime.claimTask(TASK_ID, 'delivery-b', 'worker-b', BUSINESS_A);
    const requestBody = {
      leaseEpoch: workerBClaim.leaseEpoch,
      resultRef: RESULT_REF,
      resultHash: contentHash(RESULT_REF),
    };

    const firstCompletion = await runtime.completeTask(TASK_ID, requestBody, BUSINESS_A);
    expect(firstCompletion).toMatchObject({
      taskId: TASK_ID,
      state: 'SUCCEEDED',
      operationState: 'SUCCEEDED',
      replayed: false,
    });
    const writesAfterFirstCompletion = fixture.committedWrites.length;

    const replayedCompletion = await runtime.completeTask(TASK_ID, requestBody, BUSINESS_A);

    expect(replayedCompletion).toMatchObject({
      taskId: TASK_ID,
      state: 'SUCCEEDED',
      operationState: 'SUCCEEDED',
      replayed: true,
    });
    expect(fixture.task.state).toBe('SUCCEEDED');
    expect(fixture.terminalUpdateSql).toHaveLength(1);
    expect(fixture.committedTerminalMutations).toEqual([
      { state: 'SUCCEEDED', leaseEpoch: workerBClaim.leaseEpoch },
    ]);
    expect(fixture.committedWrites).toHaveLength(writesAfterFirstCompletion);
    expect(fixture.rollbacks).toBe(0);
  });

  it('allows a live same-business heartbeat and checkpoint to commit behind epoch and expiry predicates', async () => {
    const fixture = makeOfflineDb();
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A)).resolves.toMatchObject({ cancelRequested: false });
    await expect(runtime.saveStep(
      TASK_ID,
      'checkpoint-1',
      { leaseEpoch: 12, inputHash: 'input-hash', outputRef: 'memory://checkpoint', status: 'SUCCEEDED' },
      BUSINESS_A
    )).resolves.toMatchObject({ stepKey: 'checkpoint-1', generation: 1, replayed: false });

    expect(fixture.committedWrites).toHaveLength(2);
    expect(fixture.committedWrites.join('\n')).toMatch(/lease_epoch=\$3/);
    expect(fixture.committedWrites.join('\n')).toMatch(/lease_expires_at > clock_timestamp\(\)/);
    expect(fixture.rollbacks).toBe(0);
  });

  it('rolls back heartbeat when a near-deadline lease expires between SELECT and conditional UPDATE', async () => {
    const fixture = makeExpiryDuringTransactionDb();
    const originalExpiry = fixture.task.lease_expires_at.toISOString();
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A))
      .rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });

    expect(fixture.selectedLeaseActive).toBe(true);
    expect(fixture.clockAtSelect).toBeDefined();
    expect(fixture.clockAtUpdate).toBeGreaterThan(fixture.task.lease_expires_at.getTime());
    expect(fixture.clockAtSelect).toBe(fixture.task.lease_expires_at.getTime() - 1);
    expect(fixture.conditionalExpiryPredicateSeen).toBe(true);
    expect(fixture.attemptedWrites).toHaveLength(1);
    expect(fixture.attemptedWrites[0]).toMatch(/t\.lease_expires_at\s*>\s*clock_timestamp\(\)/);
    expect(fixture.committedWrites).toEqual([]);
    expect(fixture.task.lease_expires_at.toISOString()).toBe(originalExpiry);
    expect(fixture.rollbacks).toBe(1);
  });

  it('MM-10b: same-epoch heartbeat after cancellation returns 410 without extending the lease', async () => {
    const fixture = makeOfflineDb({ state: 'CANCELLED', lease_active: false });
    const originalExpiry = fixture.task.lease_expires_at.toISOString();
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A))
      .rejects.toMatchObject({ status: 410, code: 'TASK_TERMINAL' });

    expect(fixture.task.lease_expires_at.toISOString()).toBe(originalExpiry);
    expect(fixture.attemptedWrites).toEqual([]);
    expect(fixture.committedWrites).toEqual([]);
    expect(fixture.rollbacks).toBe(1);
  });

  it('MM-10b guard order: stale epoch on a cancelled task remains 409 before terminal handling', async () => {
    const fixture = makeOfflineDb({ state: 'CANCELLED', lease_active: false });
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.heartbeatTask(TASK_ID, 11, BUSINESS_A))
      .rejects.toMatchObject({ status: 409, code: 'LEASE_LOST' });

    expect(fixture.attemptedWrites).toEqual([]);
    expect(fixture.committedWrites).toEqual([]);
    expect(fixture.rollbacks).toBe(1);
  });

  it.each(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'])
    ('heartbeat on terminal task state %s returns 410 TASK_TERMINAL', async (state) => {
      const fixture = makeOfflineDb({ state, lease_active: false });
      const runtime = createRuntimeService(fixture.db);

      await expect(runtime.heartbeatTask(TASK_ID, 12, BUSINESS_A))
        .rejects.toMatchObject({ status: 410, code: 'TASK_TERMINAL' });

      expect(fixture.attemptedWrites).toEqual([]);
      expect(fixture.committedWrites).toEqual([]);
      expect(fixture.rollbacks).toBe(1);
    });
});
