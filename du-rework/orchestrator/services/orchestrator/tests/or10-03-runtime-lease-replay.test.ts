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

function makeOfflineDb(
  overrides: Record<string, unknown> = {},
  registeredOverrides: Record<string, unknown> = {},
  businessEnabled = true,
  currentOutboxDeliveryId = DELIVERY_ID,
  currentOutboxDeliveryType: 'task.dispatch' | 'task.continuation' = 'task.dispatch',
  activeVersion = '1.0.0',
) {
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
    max_attempts: 3,
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
    lease_active: true,
    ...overrides,
  };
  task.lease_active = overrides.lease_active === undefined
    ? new Date(task.lease_expires_at as Date).getTime() > Date.now()
    : overrides.lease_active as boolean;
  const registered = {
    business_version: '1.0.0',
    heartbeat_manifest_digest: 'sha256:offline',
    registered_manifest_digest: 'sha256:offline',
    state: 'ONLINE',
    heartbeat_fresh: true,
    control_revision: 1,
    control_state: 'OPEN',
    desired_control_revision: 1,
    desired_control_state: 'OPEN',
    capacity: 4,
    ...registeredOverrides,
  };
  const workerInstances = new Map(['worker-a', 'worker-b'].map((instanceId) => [instanceId, { ...registered }]));
  const taskReadSqls: string[] = [];
  const taskUpdates: { epoch: number; expiresAt: Date; workerId: string; deliveryId: string }[] = [];
  const taskUpdateSqls: string[] = [];
  const operationUpdates: string[] = [];
  let acceptedTaskCount = 0;

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
          if (/^\s*SELECT o\.business_id,o\.business_version/i.test(sql)) {
            return queryResult<R>([{ business_id: BUSINESS_ID, business_version: task.business_version }]);
          }
          if (/^\s*SELECT enabled,activation_revision,submissions_paused,pre_drain_version\s+FROM business_catalog/i.test(sql)) {
            return queryResult<R>([{ enabled: businessEnabled, activation_revision: 1,
              submissions_paused: false, pre_drain_version: null }]);
          }
          if (/^\s*SELECT version,status,is_active FROM business_versions/i.test(sql)) {
            const targetVersion = String(params[1] ?? '1.0.0');
            const versions: Record<string, unknown>[] = [];
            if (activeVersion !== null) versions.push({ version: activeVersion, status: 'ENABLED', is_active: true });
            if (targetVersion !== activeVersion) versions.push({ version: targetVersion, status: 'ENABLED', is_active: false });
            return queryResult<R>(versions);
          }
          if (/^\s*SELECT/i.test(sql) && /FROM tasks t\s+JOIN operations o/i.test(sql)) {
            taskReadSqls.push(sql);
            return queryResult<R>([{ ...task }]);
          }
          if (/^\s*INSERT INTO runtime_control_scopes/i.test(sql)) {
            return queryResult<R>([], 'INSERT');
          }
          if (/^\s*SELECT scope_kind,scope_id,desired_state,revision/i.test(sql)) {
            return queryResult<R>([
              { scope_kind: 'platform', scope_id: 'all', desired_state: 'OPEN', revision: 1 },
              { scope_kind: 'tenant', scope_id: 'tenant-a', desired_state: 'OPEN', revision: 1 },
              { scope_kind: 'business', scope_id: BUSINESS_ID, desired_state: 'OPEN', revision: 1 },
            ]);
          }
          if (/^\s*SELECT/i.test(sql) && /FROM worker_instances wi/i.test(sql)) {
            const instanceId = String(params[1]);
            const worker = workerInstances.get(instanceId);
            if (!worker) return queryResult<R>([]);
            if (sql.includes('FOR UPDATE OF wi')) return queryResult<R>([worker]);
            return queryResult<R>([{
              business_version: worker.business_version,
              heartbeat_manifest_digest: worker.heartbeat_manifest_digest,
              registered_manifest_digest: worker.registered_manifest_digest,
              state: worker.state,
              heartbeat_fresh: worker.heartbeat_fresh,
            }]);
          }
          if (/^\s*SELECT state FROM operations WHERE id=\$1/i.test(sql)) {
            return queryResult<R>([{ state: 'RUNNING' }]);
          }
          if (/^\s*SELECT count\(\*\)::int AS count FROM tasks/i.test(sql)) {
            return queryResult<R>([{ count: 0 }]);
          }
          if (/^\s*UPDATE tasks SET admission_parked_reason=/i.test(sql)
              || /^\s*UPDATE outbox SET parked_reason=/i.test(sql)) {
            return queryResult<R>([], 'UPDATE');
          }
          if (/^\s*SELECT/i.test(sql) && /FROM step_checkpoints/i.test(sql)) {
            return queryResult<R>([]);
          }
          if (/^\s*UPDATE tasks SET lease_epoch=\$2/i.test(sql)) {
            const [, epoch, expiresAt, workerId, deliveryId] = params as [string, number, Date | string, string, string];
            taskUpdateSqls.push(sql);
            // Model the claim UPDATE's durable-latest-delivery predicate. A
            // recovered outbox intent fences a late claim carrying the
            // original BullMQ delivery even if that job starts after recovery.
            if (deliveryId !== currentOutboxDeliveryId
              || !['task.dispatch', 'task.continuation'].includes(currentOutboxDeliveryType)) {
              return queryResult<R>([], 'UPDATE');
            }
            const expiry = new Date(expiresAt);
            taskUpdates.push({ epoch, expiresAt: expiry, workerId, deliveryId });
            task.lease_epoch = epoch;
            task.lease_expires_at = expiry;
            task.lease_active = true;
            task.leased_by = workerId;
            task.last_delivery_id = deliveryId;
            task.state = 'RUNNING';
            task.attempt = Number(task.attempt) + 1;
            return queryResult<R>([{ id: TASK_ID }], 'UPDATE');
          }
          if (/^\s*UPDATE worker_instances\s+SET accepted_task_count=/i.test(sql)) {
            acceptedTaskCount++;
            return queryResult<R>([{ accepted_task_count: acceptedTaskCount }], 'UPDATE');
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

  return { db, task, taskReadSqls, taskUpdates, taskUpdateSqls, operationUpdates,
    get acceptedTaskCount() { return acceptedTaskCount; } };
}

describe('OR10-03 runtime delivery replay lease ownership', () => {
  it('replays a valid v1 lease after v2 cutover only for its owner', async () => {
    const fixture = makeOfflineDb({}, {}, true, DELIVERY_ID, 'task.dispatch', '2.0.0');
    const runtime = createRuntimeService(fixture.db);

    const claim = await runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-a', BUSINESS_ID);

    expect(claim).toMatchObject({ leaseEpoch: 7, attempt: 2 });
    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.operationUpdates).toEqual([]);
  });

  it('does not replay the same delivery to its owner after that instance upgrades to another pinned version', async () => {
    const fixture = makeOfflineDb({}, { business_version: '2.0.0' });
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-a', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'WORKER_VERSION_MISMATCH' });

    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.operationUpdates).toEqual([]);
    expect(fixture.task.lease_epoch).toBe(7);
  });

  it('rejects a late original delivery after recovery and claims only the authoritative replacement ID', async () => {
    const replacementDeliveryId = `${TASK_ID}:queue-recovery:pin:2`;
    const fixture = makeOfflineDb({
      state: 'READY', lease_epoch: 8, lease_expires_at: null, lease_active: false,
      leased_by: null, last_delivery_id: null, attempt: 2,
    }, {}, true, replacementDeliveryId);
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-a', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'TASK_NOT_READY' });
    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.taskReadSqls[0]).toContain('FOR UPDATE OF t');
    expect(fixture.taskUpdateSqls[0]).toContain('current_delivery.delivery_id=$5');
    expect(fixture.taskUpdateSqls[0]).toContain('NOT EXISTS');
    expect(fixture.task.attempt).toBe(2);

    const claim = await runtime.claimTask(TASK_ID, replacementDeliveryId, 'worker-a', BUSINESS_ID);
    expect(claim.leaseEpoch).toBe(9);
    expect(fixture.taskUpdates).toEqual([
      expect.objectContaining({ epoch: 9, workerId: 'worker-a', deliveryId: replacementDeliveryId }),
    ]);
    expect(fixture.task.last_delivery_id).toBe(replacementDeliveryId);
  });

  it('allows a current task.continuation delivery through the same generation fence', async () => {
    const continuationDeliveryId = `${TASK_ID}:continuation:2`;
    const fixture = makeOfflineDb({
      state: 'READY', lease_epoch: 8, lease_expires_at: null, lease_active: false,
      leased_by: null, last_delivery_id: null, attempt: 2,
    }, {}, true, continuationDeliveryId, 'task.continuation');
    const runtime = createRuntimeService(fixture.db);

    const claim = await runtime.claimTask(TASK_ID, continuationDeliveryId, 'worker-a', BUSINESS_ID);

    expect(claim.leaseEpoch).toBe(9);
    expect(fixture.taskUpdates[0]?.deliveryId).toBe(continuationDeliveryId);
    expect(fixture.taskUpdateSqls[0]).toContain("current_delivery.type IN ('task.dispatch','task.continuation')");
    expect(fixture.taskUpdateSqls[0]).toContain('newer_delivery.created_at > current_delivery.created_at');
  });

  it('does not replay a replacement ID under the original owner while its prior delivery lease is active', async () => {
    const replacementDeliveryId = `${TASK_ID}:queue-recovery:pin:2`;
    const fixture = makeOfflineDb();
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, replacementDeliveryId, 'worker-a', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'TASK_LEASE_ACTIVE' });

    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.operationUpdates).toEqual([]);
    expect(fixture.task.last_delivery_id).toBe(DELIVERY_ID);
  });

  it('does not let a different worker replay the current worker lease', async () => {
    const fixture = makeOfflineDb();
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-b', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'TASK_LEASE_ACTIVE' });

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
    expect(fixture.acceptedTaskCount).toBe(1);
    expect(fixture.taskUpdates[0]).toMatchObject({ epoch: 8, workerId, deliveryId: DELIVERY_ID });
    expect(fixture.taskUpdates[0]!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    expect(fixture.operationUpdates).toHaveLength(1);
  });

  it('defers new claims while the logical business is disabled without taking a lease or counting intake', async () => {
    const fixture = makeOfflineDb({
      state: 'READY', lease_epoch: 1, lease_expires_at: new Date(Date.now() - 1_000),
      lease_active: false, leased_by: null, last_delivery_id: null, attempt: 0,
    }, {}, false);
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-a', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'BUSINESS_DISABLED' });
    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.acceptedTaskCount).toBe(0);
    expect(fixture.task.attempt).toBe(0);
  });

  it('defers a live foreign lease acknowledgement when the owner sent an explicit stale manifest digest', async () => {
    const fixture = makeOfflineDb({}, { heartbeat_manifest_digest: 'sha256:wrong' });
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-b', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'TASK_LEASE_HELD' });
    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.acceptedTaskCount).toBe(0);
  });

  it.each(['WAITING_INPUT', 'WAITING_CHILDREN'])('does not replay a delivery while the task is %s', async (state) => {
    const fixture = makeOfflineDb({ state, op_state: state });
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, DELIVERY_ID, 'worker-a', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'TASK_WAITING' });

    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.operationUpdates).toEqual([]);
    expect(fixture.task.lease_epoch).toBe(7);
  });

  it('keeps a runnable task recoverable when the registered worker version differs', async () => {
    const fixture = makeOfflineDb(
      { lease_expires_at: new Date(Date.now() - 1_000) },
      { business_version: '2.0.0' },
    );
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, 'fresh-delivery', 'worker-a', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'WORKER_VERSION_MISMATCH' });

    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.task.lease_epoch).toBe(7);
    expect(fixture.task.attempt).toBe(2);
  });

  it('keeps a runnable task recoverable when the registered manifest digest differs', async () => {
    const fixture = makeOfflineDb(
      { lease_expires_at: new Date(Date.now() - 1_000) },
      { registered_manifest_digest: 'sha256:different' },
    );
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, 'fresh-delivery', 'worker-a', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'MANIFEST_DIGEST_MISMATCH' });

    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.task.lease_epoch).toBe(7);
    expect(fixture.task.attempt).toBe(2);
  });

  it('defers a QUEUED task carrying a legacy live foreign lease', async () => {
    const fixture = makeOfflineDb({
      state: 'QUEUED',
      lease_active: true,
      leased_by: 'worker-a',
      last_delivery_id: 'old-delivery',
    });
    const runtime = createRuntimeService(fixture.db);

    await expect(runtime.claimTask(TASK_ID, 'new-delivery', 'worker-b', BUSINESS_ID))
      .rejects.toMatchObject({ status: 409, code: 'TASK_LEASE_HELD' });

    expect(fixture.taskUpdates).toEqual([]);
    expect(fixture.task.lease_epoch).toBe(7);
  });
});
