import type { QueryResult, QueryResultRow, PoolClient } from 'pg';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import { createRuntimeService } from '../src/modules/runtime/runtime';

const TASK_ID = '73000000-0000-4000-8000-000000000001';
const OPERATION_ID = '73000000-0000-4000-8000-000000000002';
const TENANT_ID = '73000000-0000-4000-8000-000000000003';
const PROFILE_ID = '73000000-0000-4000-8000-000000000004';
const BUSINESS_ID = 'dd03-fixture-business';
const DELIVERY_ID = 'dd03-delivery-legacy';
const PLAINTEXT_SENTINEL = 'DD03-LEGACY-PLAINTEXT-CREDENTIAL-7a4f2c91';

type Row = Record<string, unknown>;

interface TaskState {
  state: string;
  attempt: number;
  leaseEpoch: number;
  leaseExpiresAt: string | null;
  leasedBy: string | null;
  lastDeliveryId: string | null;
}

function queryResult<T extends QueryResultRow>(
  rows: Row[],
  command = 'SELECT',
): QueryResult<T> {
  return {
    command,
    rowCount: rows.length,
    oid: 0,
    rows: rows as T[],
    fields: [],
  };
}

function claimHarness(profilePolicySnapshot: unknown) {
  const sqlCalls: string[] = [];
  let committedTask: TaskState = {
    state: 'READY',
    attempt: 0,
    leaseEpoch: 0,
    leaseExpiresAt: null,
    leasedBy: null,
    lastDeliveryId: null,
  };
  let committedOperationState = 'QUEUED';
  let transactionRollbacks = 0;

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(
      sql: string,
    ): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in offline DD03 test: ${sql}`);
    },
    tx: async <T>(fn: (client: PoolClient) => Promise<T>): Promise<T> => {
      // Model transaction-local writes. They become visible only if the claim
      // callback resolves; an INVALID_SCHEMA throw discards this staged copy.
      const stagedTask = { ...committedTask };
      let stagedOperationState = committedOperationState;
      const client = {
        query: async <R extends QueryResultRow = QueryResultRow>(
          sql: string,
          params: unknown[] = [],
        ): Promise<QueryResult<R>> => {
          sqlCalls.push(sql.replace(/\s+/g, ' ').trim());

          if (/^\s*SELECT/i.test(sql) && /FROM tasks t/i.test(sql) && /JOIN operations o/i.test(sql)) {
            return queryResult<R>([{
              id: TASK_ID,
              operation_id: OPERATION_ID,
              task_key: 'root',
              kind: 'root',
              state: stagedTask.state,
              attempt: stagedTask.attempt,
              lease_epoch: stagedTask.leaseEpoch,
              lease_expires_at: stagedTask.leaseExpiresAt,
              leased_by: stagedTask.leasedBy,
              last_delivery_id: stagedTask.lastDeliveryId,
              payload_ref: { source: 'synthetic-payload-ref' },
              tenant_id: TENANT_ID,
              business_id: BUSINESS_ID,
              business_version: '1.0.0',
              action: 'extract',
              input_ref: { source: 'synthetic-input-ref' },
              deadline_at: null,
              manifest_digest: 'sha256:dd03-fixture',
              profile_id: PROFILE_ID,
              profile_revision: 7,
              connector_bindings: { primary: 'fixture-connector@1' },
              profile_policy_snapshot: profilePolicySnapshot,
              cancel_requested: false,
              op_cancel_requested: false,
              op_state: stagedOperationState,
            }]);
          }

          if (/^\s*SELECT state FROM operations WHERE id=\$1/i.test(sql)) {
            return queryResult<R>([{ state: stagedOperationState }]);
          }

          if (/^\s*UPDATE tasks SET lease_epoch=\$2/i.test(sql)) {
            const [, epoch, expiry, workerId, deliveryId] = params as [
              string,
              number,
              string,
              string,
              string,
            ];
            stagedTask.leaseEpoch = epoch;
            stagedTask.leaseExpiresAt = expiry;
            stagedTask.leasedBy = workerId;
            stagedTask.lastDeliveryId = deliveryId;
            stagedTask.state = 'RUNNING';
            stagedTask.attempt += 1;
            return queryResult<R>([{ id: TASK_ID }], 'UPDATE');
          }

          if (/^\s*UPDATE operations SET state='RUNNING'/i.test(sql)) {
            stagedOperationState = 'RUNNING';
            return queryResult<R>([{ id: OPERATION_ID }], 'UPDATE');
          }

          if (/^\s*SELECT/i.test(sql) && /FROM step_checkpoints/i.test(sql)) {
            return queryResult<R>([]);
          }

          throw new Error(`unexpected transaction query in offline DD03 test: ${sql}`);
        },
      } as unknown as PoolClient;

      try {
        const value = await fn(client);
        committedTask = stagedTask;
        committedOperationState = stagedOperationState;
        return value;
      } catch (error) {
        transactionRollbacks += 1;
        throw error;
      }
    },
    close: async () => undefined,
  } as unknown as Db;

  return {
    runtime: createRuntimeService(db),
    sqlCalls,
    get committedTask() { return committedTask; },
    get committedOperationState() { return committedOperationState; },
    get transactionRollbacks() { return transactionRollbacks; },
  };
}

const validSnapshot = {
  enabled: true,
  parameters: {},
  jobPriority: 'HIGH',
  allowedFileExtensions: 'pdf,docx',
  connectionsOverride: [],
  fileUrlAuthConfigured: true,
  credentialRef: {
    tenantId: TENANT_ID,
    profileId: PROFILE_ID,
    profileRevision: 7,
  },
};

describe('W1-DD03 / P730 legacy profile snapshot claim boundary (offline)', () => {
  it('rejects a legacy plaintext credential snapshot with typed INVALID_SCHEMA and rolls back the claim', async () => {
    const legacySnapshot = {
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: 'pdf,docx',
      connectionsOverride: [],
      fileUrlAuthConfig: {
        type: 'bearer',
        token: PLAINTEXT_SENTINEL,
      },
      // Legacy snapshots have no immutable encrypted credential reference.
    };
    const world = claimHarness(legacySnapshot);

    let result: Awaited<ReturnType<typeof world.runtime.claimTask>> | undefined;
    let thrown: unknown;
    try {
      result = await world.runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-dd03', BUSINESS_ID);
    } catch (error) {
      thrown = error;
    }

    expect(result).toBeUndefined();
    expect(thrown).toBeInstanceOf(HttpError);
    expect(thrown).toMatchObject({
      name: 'HttpError',
      status: 422,
      code: 'INVALID_SCHEMA',
      message: 'operation profile_policy_snapshot does not match the pinned policy shape',
    });
    const safeProblem = (thrown as HttpError).toProblem();
    expect(JSON.stringify(safeProblem)).not.toContain(PLAINTEXT_SENTINEL);
    expect((thrown as HttpError).extra).toBeDefined();
    expect(world.sqlCalls.some((sql) => /UPDATE tasks SET lease_epoch=\$2/i.test(sql))).toBe(true);
    expect(world.sqlCalls.some((sql) => /UPDATE operations SET state='RUNNING'/i.test(sql))).toBe(true);
    expect(world.transactionRollbacks).toBe(1);
    expect(world.committedTask).toEqual({
      state: 'READY',
      attempt: 0,
      leaseEpoch: 0,
      leaseExpiresAt: null,
      leasedBy: null,
      lastDeliveryId: null,
    });
    expect(world.committedOperationState).toBe('QUEUED');
  });

  it('negative control: a valid non-secret snapshot with its pinned credential ref is claimed unchanged', async () => {
    const world = claimHarness(validSnapshot);

    const result = await world.runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-dd03', BUSINESS_ID);

    expect(result.executionSnapshot.pinned.profilePolicy).toEqual(validSnapshot);
    expect(result.executionSnapshot.pinned.profilePolicy).not.toBeNull();
    expect(result.executionSnapshot.pinned.profilePolicy?.fileUrlAuthConfigured).toBe(true);
    expect(result.executionSnapshot.pinned.profilePolicy?.credentialRef).toEqual({
      tenantId: TENANT_ID,
      profileId: PROFILE_ID,
      profileRevision: 7,
    });
    expect(result.executionSnapshot.pinned.profilePolicy?.parameters).toEqual({});
    expect(world.committedTask.state).toBe('RUNNING');
    expect(world.committedTask.leaseEpoch).toBe(1);
    expect(world.committedOperationState).toBe('RUNNING');
    expect(world.transactionRollbacks).toBe(0);
  });
});
