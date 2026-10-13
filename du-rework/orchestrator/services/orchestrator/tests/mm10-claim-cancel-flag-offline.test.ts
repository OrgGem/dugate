/**
 * W-PLAT-CLAIM-CANCEL-FLAG-1 — the claim snapshot must report an operation-level
 * cancel instead of hard-coding cancelRequested:false (Δ4 of W-PLAT-MM10-CANCEL-1).
 *
 * Production contract under test (runtime.ts claimTask / buildClaimResult):
 *  - the claim SELECT projects o.cancel_requested AS op_cancel_requested and
 *    o.state AS op_state, and buildClaimResult feeds them through the SAME
 *    hasCancelSignal definition heartbeatTask uses, so the claim channel and the
 *    heartbeat channel cannot disagree about what "cancel requested" means;
 *  - a cancel-visible claim still SUCCEEDS (refusing work is the terminal
 *    guards' job) — the worker is told to bail out via the snapshot;
 *  - the pre-existing guard order is intact: BR-12 business mismatch 403,
 *    terminal task 410, terminal operation 410. None of them may degrade into a
 *    "claim succeeded, cancelRequested:true" answer.
 *
 * The fake mirrors real projection semantics: it serves op_cancel_requested /
 * op_state ONLY when the production SQL text actually projects them, so dropping
 * the two aliases in runtime.ts turns the behavioral tests red instead of
 * silently passing. tasks has no cancel_requested column (0001_platform_v1.sql),
 * so the fake never serves a task-level cancel_requested key.
 */
import type { QueryResult, QueryResultRow } from 'pg';
import { ClaimResultSchema } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createRuntimeService } from '../src/modules/runtime/runtime';

const OPERATION_ID = '8d000000-0000-4000-8000-000000000001';
const TASK_ID = '8d000000-0000-4000-8000-000000000002';
const TENANT_ID = '8d000000-0000-4000-8000-000000000003';
const BUSINESS_A = 'business-a';
const BUSINESS_B = 'business-b';

interface FakeTask {
  id: string;
  operation_id: string;
  task_key: string;
  kind: string;
  state: string;
  attempt: number;
  max_attempts: number;
  lease_epoch: number;
  lease_expires_at: Date | null;
  leased_by: string | null;
  last_delivery_id: string | null;
  payload_ref: Record<string, unknown>;
}

interface FakeOp {
  tenant_id: string;
  business_id: string;
  business_version: string;
  action: string;
  state: string;
  cancel_requested: boolean;
  input_ref: Record<string, unknown>;
  deadline_at: Date | null;
}

function projectsCancelSignal(sql: string): boolean {
  return (
    sql.includes('o.cancel_requested AS op_cancel_requested') && sql.includes('o.state AS op_state')
  );
}

function queryResult<T extends QueryResultRow>(rows: QueryResultRow[], command = 'SELECT'): QueryResult<T> {
  return { command, rowCount: rows.length, oid: 0, rows: rows as T[], fields: [] };
}

interface WorldOptions {
  task?: Partial<FakeTask>;
  op?: Partial<FakeOp>;
  businessEnabled?: boolean;
  activeVersion?: string | null;
  targetStatus?: string;
  workerCapacity?: number;
  activeLeaseCount?: number;
}

function makeWorld(options: WorldOptions = {}) {
  const task: FakeTask = {
    id: TASK_ID,
    operation_id: OPERATION_ID,
    task_key: 'root',
    kind: 'root',
    state: 'READY',
    attempt: 0,
    max_attempts: 3,
    lease_epoch: 0,
    lease_expires_at: null,
    leased_by: null,
    last_delivery_id: null,
    payload_ref: {},
    ...options.task,
  };

  const businessEnabled = options.businessEnabled ?? true;
  const activeVersion = options.activeVersion ?? '1.0.0';
  const targetStatus = options.targetStatus ?? 'ENABLED';
  const workerCapacity = options.workerCapacity ?? 4;
  const activeLeaseCount = options.activeLeaseCount ?? 0;
  let admissionParkReason: string | null = null;
  let operationTerminalWrites = 0;
  const op: FakeOp = {
    tenant_id: TENANT_ID,
    business_id: BUSINESS_A,
    business_version: '1.0.0',
    action: 'extract',
    state: 'QUEUED',
    cancel_requested: false,
    input_ref: {},
    deadline_at: null,
    ...options.op,
  };

  const selectSqls: string[] = [];
  const claimUpdateSqls: string[] = [];
  const leaseWrites: string[] = [];
  let opStateReads = 0;

  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string): Promise<QueryResult<T>> => {
      throw new Error(`unexpected pool query in offline claim-cancel test: ${sql}`);
    },
    tx: async <T>(fn: (client: never) => Promise<T>): Promise<T> => fn(
      {
        query: async <R extends QueryResultRow = QueryResultRow>(
          sql: string,
          params: unknown[] = []
        ): Promise<QueryResult<R>> => {
          if (/^\s*SELECT/i.test(sql) && /FROM tasks t/i.test(sql) && /JOIN operations o/i.test(sql)) {
            if (sql.includes('SELECT o.business_id,o.business_version')) {
              return queryResult<R>([{ business_id: op.business_id, business_version: op.business_version }]);
            }
            selectSqls.push(sql);
            const row: Record<string, unknown> = {
              id: task.id,
              operation_id: task.operation_id,
              task_key: task.task_key,
              kind: task.kind,
              payload_ref: task.payload_ref,
              state: task.state,
              attempt: task.attempt,
              max_attempts: task.max_attempts,
              lease_epoch: task.lease_epoch,
              lease_expires_at: task.lease_expires_at,
              leased_by: task.leased_by,
              last_delivery_id: task.last_delivery_id,
              lease_active: task.lease_expires_at !== null && task.lease_expires_at.getTime() > Date.now(),
              tenant_id: op.tenant_id,
              // Same-name override as the real join: o.business_id wins over t.*.
              business_id: op.business_id,
              business_version: op.business_version,
              action: op.action,
              input_ref: op.input_ref,
              deadline_at: op.deadline_at,
              manifest_digest: 'sha256:offline',
              profile_revision: 1,
              connector_bindings: {},
            };
            if (projectsCancelSignal(sql)) {
              row.op_cancel_requested = op.cancel_requested;
              row.op_state = op.state;
            }
            return queryResult<R>([row]);
          }
          if (/^\s*SELECT enabled,activation_revision,submissions_paused,pre_drain_version/i.test(sql)) {
            return queryResult<R>([{
              enabled: businessEnabled,
              activation_revision: 1,
              submissions_paused: false,
              pre_drain_version: null,
            }]);
          }
          if (/^\s*SELECT version,status,is_active FROM business_versions/i.test(sql)) {
            const rows: Record<string, unknown>[] = [];
            if (activeVersion !== null) rows.push({ version: activeVersion,
              status: activeVersion === op.business_version ? targetStatus : 'ENABLED', is_active: true });
            if (activeVersion !== op.business_version) rows.push({ version: op.business_version,
              status: targetStatus, is_active: false });
            return queryResult<R>(rows);
          }
          if (/^\s*SELECT state FROM operations WHERE id=\$1/i.test(sql)) {
            opStateReads += 1;
            return queryResult<R>([{ state: op.state }]);
          }
          if (/^\s*SELECT/i.test(sql) && /FROM step_checkpoints/i.test(sql)) {
            return queryResult<R>([]);
          }
          if (/^\s*INSERT INTO runtime_control_scopes/i.test(sql)) return queryResult<R>([], 'INSERT');
          if (/^\s*SELECT scope_kind,scope_id,desired_state,revision/i.test(sql)) {
            return queryResult<R>([
              { scope_kind: 'platform', scope_id: 'all', desired_state: 'OPEN', revision: 1 },
              { scope_kind: 'tenant', scope_id: op.tenant_id, desired_state: 'OPEN', revision: 1 },
              { scope_kind: 'business', scope_id: op.business_id, desired_state: 'OPEN', revision: 1 },
            ]);
          }
          if (/^\s*SELECT wi\.business_version/i.test(sql)) {
            const worker = {
              business_version: op.business_version,
              heartbeat_manifest_digest: 'sha256:offline',
              registered_manifest_digest: 'sha256:offline',
              state: 'ONLINE',
              heartbeat_fresh: true,
              capacity: workerCapacity,
              control_revision: 1,
              control_state: 'OPEN',
              desired_control_revision: 1,
              desired_control_state: 'OPEN',
            };
            return queryResult<R>([worker]);
          }
          if (/^\s*SELECT count\(\*\)::int AS count FROM tasks/i.test(sql)) {
            return queryResult<R>([{ count: activeLeaseCount }]);
          }
          if (/^\s*UPDATE tasks SET admission_parked_reason=/i.test(sql)) {
            admissionParkReason = String(params[1]);
            return queryResult<R>([], 'UPDATE');
          }
          if (/^\s*UPDATE outbox SET parked_reason=/i.test(sql)) return queryResult<R>([], 'UPDATE');
          if (/^\s*UPDATE tasks SET state='FAILED',error_code='TASK_ATTEMPTS_EXHAUSTED'/i.test(sql)) {
            task.state = 'FAILED';
            return queryResult<R>([{ id: task.id }], 'UPDATE');
          }
          if (/^\s*SELECT parent_id, join_policy FROM task_dependencies/i.test(sql)) return queryResult<R>([]);
          if (/^\s*UPDATE tasks SET lease_epoch=\$2/i.test(sql)) {
            leaseWrites.push(sql);
            claimUpdateSqls.push(sql);
            const [, epoch, expiry, workerId, deliveryId] = params as [
              string,
              number,
              string,
              string,
              string,
            ];
            task.lease_epoch = epoch;
            task.lease_expires_at = new Date(expiry);
            task.leased_by = workerId;
            task.last_delivery_id = deliveryId;
            task.state = 'RUNNING';
            task.attempt += 1;
            return queryResult<R>([{ id: TASK_ID }], 'UPDATE');
          }
          if (/^\s*UPDATE operations SET state=/i.test(sql)) {
            if (sql.includes("SET state='FAILED'")) {
              op.state = 'FAILED';
              operationTerminalWrites += 1;
              return queryResult<R>([{ id: OPERATION_ID }], 'UPDATE');
            }
            const allowed = ['ACCEPTED', 'QUEUED', 'WAITING_CHILDREN', 'WAITING_INPUT', 'RETRY_PENDING'];
            if (allowed.includes(op.state)) {
              op.state = 'RUNNING';
              return queryResult<R>([{ id: OPERATION_ID }], 'UPDATE');
            }
            return queryResult<R>([], 'UPDATE');
          }
          if (/^\s*SELECT id, tenant_id, state, state_version, callback_url/i.test(sql)) {
            return queryResult<R>([{ id: OPERATION_ID, tenant_id: op.tenant_id, state: op.state,
              state_version: 2, callback_url: null, updated_at: new Date().toISOString(),
              completed_at: null, callback_policy: null, pipeline_json: [] }]);
          }
          if (/^\s*UPDATE worker_instances/i.test(sql)) return queryResult<R>([{ accepted_task_count: 1 }], 'UPDATE');
          if (/^\s*UPDATE outbox SET parked_reason=NULL/i.test(sql)) return queryResult<R>([], 'UPDATE');
          throw new Error(`unexpected transaction query in offline claim-cancel test: ${sql}`);
        },
      } as never
    ),
    close: async () => undefined,
  } as unknown as Db;

  return { db, task, op, selectSqls, claimUpdateSqls, leaseWrites,
    get admissionParkReason() { return admissionParkReason; },
    get operationTerminalWrites() { return operationTerminalWrites; },
    get opStateReads() { return opStateReads; } };
}

const claim = (runtime: ReturnType<typeof createRuntimeService>) =>
  runtime.claimTask(TASK_ID, 'delivery-1', 'worker-a-1', BUSINESS_A);

describe('W-PLAT-CLAIM-CANCEL-FLAG-1: claim snapshot reflects the operation cancel signal', () => {
  it('cancel_requested=true before the claim: lease is taken AND snapshot says cancelRequested=true', async () => {
    const world = makeWorld({ op: { cancel_requested: true, state: 'RUNNING' } });
    const runtime = createRuntimeService(world.db);

    const result = await claim(runtime);

    // The old code hard-coded false here, so the handler ran blind until its
    // first heartbeat.
    expect(result.executionSnapshot.cancelRequested).toBe(true);
    // Claiming is still allowed — refusing work belongs to the terminal guards.
    expect(world.leaseWrites).toHaveLength(1);
    expect(result.leaseEpoch).toBe(1);
  });

  it('operation state CANCEL_REQUESTED (soft signal, flag not yet set): snapshot says true', async () => {
    const world = makeWorld({ op: { state: 'CANCEL_REQUESTED' } });
    const runtime = createRuntimeService(world.db);

    const result = await claim(runtime);

    expect(result.executionSnapshot.cancelRequested).toBe(true);
  });

  it('regression: no cancel signal — snapshot says false (the flag is not a constant)', async () => {
    const world = makeWorld();
    const runtime = createRuntimeService(world.db);

    const result = await claim(runtime);

    expect(result.executionSnapshot.cancelRequested).toBe(false);
    expect(world.leaseWrites).toHaveLength(1);
    expect(result.attempt).toBe(1);
  });

  it('idempotent replay path (same deliveryId) also reports the cancel without writing a lease', async () => {
    const world = makeWorld({
      task: {
        state: 'RUNNING',
        lease_epoch: 4,
        lease_expires_at: new Date(Date.now() + 60_000),
        leased_by: 'worker-a-1',
        last_delivery_id: 'delivery-1',
        attempt: 2,
      },
      op: { state: 'RUNNING', cancel_requested: true },
      // The v1 lease remains reportable after a v2 cutover.
      activeVersion: '2.0.0',
    });
    const runtime = createRuntimeService(world.db);

    const result = await claim(runtime);

    expect(result.executionSnapshot.cancelRequested).toBe(true);
    expect(result.leaseEpoch).toBe(4);
    expect(world.leaseWrites).toEqual([]);
  });

  it('parks an inactive version delivery without consuming an attempt', async () => {
    const world = makeWorld({ activeVersion: '2.0.0' });
    const runtime = createRuntimeService(world.db);

    await expect(claim(runtime)).rejects.toMatchObject({ status: 409, code: 'VERSION_NOT_ACTIVE' });

    expect(world.task.attempt).toBe(0);
    expect(world.task.state).toBe('READY');
    expect(world.admissionParkReason).toBe('VERSION_NOT_ACTIVE');
    expect(world.leaseWrites).toEqual([]);
  });

  it('refuses a new lease when worker capacity is zero without incrementing attempts', async () => {
    const world = makeWorld({ workerCapacity: 0 });
    const runtime = createRuntimeService(world.db);

    await expect(claim(runtime)).rejects.toMatchObject({ status: 409, code: 'WORKER_CAPACITY_EXHAUSTED' });

    expect(world.task.attempt).toBe(0);
    expect(world.leaseWrites).toEqual([]);
  });

  it('durably terminalizes exhausted tasks before returning the ACK-safe terminal response', async () => {
    const world = makeWorld({ task: { attempt: 3, max_attempts: 3 } });
    const runtime = createRuntimeService(world.db);

    await expect(claim(runtime)).rejects.toMatchObject({ status: 410, code: 'TASK_ATTEMPTS_EXHAUSTED' });

    expect(world.task.state).toBe('FAILED');
    expect(world.op.state).toBe('FAILED');
    expect(world.operationTerminalWrites).toBe(1);
    expect(world.leaseWrites).toEqual([]);
  });

  it('guard order intact: task state CANCELLED is still 410 TASK_TERMINAL, not a flagged claim', async () => {
    const world = makeWorld({ task: { state: 'CANCELLED' }, op: { state: 'CANCELLED', cancel_requested: true } });
    const runtime = createRuntimeService(world.db);

    await expect(claim(runtime)).rejects.toMatchObject({ status: 410, code: 'TASK_TERMINAL' });
    expect(world.leaseWrites).toEqual([]);
  });

  it('guard order intact: committed operation CANCELLED is still 410 before any snapshot is built', async () => {
    const world = makeWorld({ task: { state: 'RUNNING' }, op: { state: 'CANCELLED', cancel_requested: true } });
    const runtime = createRuntimeService(world.db);

    await expect(claim(runtime)).rejects.toMatchObject({ status: 410, code: 'TASK_TERMINAL' });
    expect(world.leaseWrites).toEqual([]);
  });

  it('BR-12 first: foreign business on a cancel-requested operation is 403, never a flagged claim', async () => {
    const world = makeWorld({ op: { state: 'RUNNING', cancel_requested: true } });
    const runtime = createRuntimeService(world.db);

    await expect(runtime.claimTask(TASK_ID, 'delivery-1', 'worker-b-1', BUSINESS_B))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(world.leaseWrites).toEqual([]);
  });

  it('wire contract: ClaimResultSchema carries cancelRequested=true to the SDK unchanged', async () => {
    const world = makeWorld({ op: { state: 'RUNNING', cancel_requested: true } });
    const runtime = createRuntimeService(world.db);

    const result = await claim(runtime);
    const parsed = ClaimResultSchema.parse(result);

    expect(parsed.executionSnapshot.cancelRequested).toBe(true);
  });

  it('structural pin: the claim SELECT projects the operation cancel signal; the lease UPDATE is unchanged', async () => {
    const world = makeWorld();
    const runtime = createRuntimeService(world.db);
    await claim(runtime);

    const select = world.selectSqls[0]!;
    expect(select).toContain('o.cancel_requested AS op_cancel_requested');
    expect(select).toContain('o.state AS op_state');
    // The row lock that serialises the claim against cancelOperation stays put,
    // and the lease epoch is part of the final lease-update CAS.
    expect(select).toContain('FOR UPDATE OF t');
    expect(select).not.toMatch(/\$12/);

    const update = world.claimUpdateSqls[0]!;
    expect(update).toMatch(/^\s*UPDATE tasks SET lease_epoch=\$2/);
    expect(update).toContain("state='RUNNING'");
    expect(update).toMatch(/attempt = attempt \+ 1/);
    expect(update).toContain('lease_epoch=$6');
  });

  it('mirror self-check: without the projection in the SQL text the fake withholds the cancel keys', () => {
    expect(projectsCancelSignal('SELECT t.*, o.cancel_requested AS op_cancel_requested, o.state AS op_state FROM tasks t JOIN operations o')).toBe(true);
    expect(projectsCancelSignal('SELECT t.* FROM tasks t JOIN operations o')).toBe(false);
    expect(
      projectsCancelSignal('SELECT t.*, o.state AS op_state FROM tasks t JOIN operations o')
    ).toBe(false);
  });
});
