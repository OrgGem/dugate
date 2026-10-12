import { EventEmitter } from 'node:events';
import type { ServerResponse } from 'node:http';
import { OrchestratorIsolatedRestoreObservationSchema } from '@du/contracts';
import type { Db } from '../src/db/db';
import { createServiceRuntime, isRestoreRehearsalRequestAllowed } from '../src/modules/service-runtime/service-runtime';

const identity = {
  serviceRuntimeId: 'restore-orchestrator-a',
  runtimeIdentity: 'restore-orchestrator-a',
  replicaId: 'restore-orchestrator-a',
  slot: 'blue' as const,
  revision: 'restore-revision',
  imageDigest: `orchestrator@sha256:${'a'.repeat(64)}`,
  controlToken: 'dedicated-isolated-control-token-000000000000',
};

test('restore rehearsal request allowlist blocks external mutations and permits only local auth/reset writes', () => {
  expect(isRestoreRehearsalRequestAllowed('GET', '/api/v1/operations')).toBe(true);
  expect(isRestoreRehearsalRequestAllowed('POST', '/admin/login')).toBe(true);
  expect(isRestoreRehearsalRequestAllowed('POST', '/admin/logout')).toBe(true);
  expect(isRestoreRehearsalRequestAllowed('POST', '/admin/api/identity/users/72b8d7bf-16bf-41b8-9e1e-67b9d7b59c61/password')).toBe(true);
  expect(isRestoreRehearsalRequestAllowed('POST', '/api/internal/parity/identity/users/72b8d7bf-16bf-41b8-9e1e-67b9d7b59c61/password')).toBe(true);
  expect(isRestoreRehearsalRequestAllowed('POST', '/api/internal/operations')).toBe(false);
  expect(isRestoreRehearsalRequestAllowed('POST', '/api/internal/maintenance/rollouts')).toBe(false);
  expect(isRestoreRehearsalRequestAllowed('POST', '/api/internal/service-runtime/drain')).toBe(false);
});

test('isolated runtime boots DRAINING, counts reads, and rejects mutating requests before dispatch', async () => {
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  let dbRow: Record<string, unknown> | undefined;
  const query = async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('INSERT INTO orchestrator_service_runtimes')) {
      dbRow = {
        service_runtime_id: identity.serviceRuntimeId,
        runtime_identity: identity.runtimeIdentity,
        replica_id: identity.replicaId,
        slot: identity.slot,
        revision: identity.revision,
        image_digest: identity.imageDigest,
        boot_id: params[6],
        desired_control_revision: 7,
        desired_control_state: 'DRAINING',
        control_revision: 0,
        control_state: 'DRAINING',
        control_ack_boot_id: null,
        control_acknowledged_at: null,
        readiness_state: 'UNKNOWN',
        database_state: 'UNKNOWN',
        redis_state: 'UNKNOWN',
      };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('UPDATE orchestrator_service_runtimes')) {
      if (dbRow) {
        dbRow.control_revision = 7;
        dbRow.control_state = 'DRAINING';
        dbRow.control_ack_boot_id = dbRow.boot_id;
        dbRow.control_acknowledged_at = new Date();
        dbRow.readiness_state = 'DRAINING';
        dbRow.database_state = 'HEALTHY';
        dbRow.redis_state = 'HEALTHY';
      }
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('FROM orchestrator_service_runtimes WHERE service_runtime_id=$1')) {
      return { rows: dbRow ? [{ ...dbRow }] : [], rowCount: dbRow ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO orchestrator_service_runtime_requests')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 1 };
  };
  const db = {
    query,
    tx: async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  } as unknown as Db;
  const runtime = createServiceRuntime({
    db,
    redis: { ping: async () => 'PONG' } as never,
    config: identity,
    isolatedReadOnly: true,
  });
  await runtime.start();
  expect(queries.find((item) => item.sql.includes('INSERT INTO orchestrator_service_runtimes'))?.sql)
    .toContain("CASE WHEN $8 THEN 'DRAINING'");
  expect(dbRow?.desired_control_state).toBe('DRAINING');

  const response = Object.assign(new EventEmitter(), { writableFinished: false, destroyed: false }) as unknown as ServerResponse;
  await runtime.trackHttpRequest('GET', '/admin/api/session', response);
  expect(queries.some((item) => item.sql.includes('INSERT INTO orchestrator_service_runtime_requests'))).toBe(true);
  response.emit('finish');

  await expect(runtime.trackHttpRequest('POST', '/api/internal/operations', response)).rejects.toMatchObject({
    code: 'RESTORE_REHEARSAL_READ_ONLY', status: 503,
  });
  await runtime.close();
});

test('isolated runtime observation reports live process, exact cluster and boot ACK, plus composed effect controls', async () => {
  const sampledAt = new Date('2026-10-12T04:00:00.000Z');
  const bootRow: Record<string, unknown> = {
    service_runtime_id: identity.serviceRuntimeId,
    runtime_identity: identity.runtimeIdentity,
    replica_id: identity.replicaId,
    slot: identity.slot,
    revision: identity.revision,
    image_digest: identity.imageDigest,
    boot_id: 'a170f4a6-3d9c-4ba6-bfc3-287c5664f1c2',
    desired_control_revision: 7,
    desired_control_state: 'DRAINING',
    control_revision: 7,
    control_state: 'DRAINING',
    control_ack_boot_id: 'a170f4a6-3d9c-4ba6-bfc3-287c5664f1c2',
    control_acknowledged_at: sampledAt,
    readiness_state: 'DRAINING',
    database_state: 'HEALTHY',
    redis_state: 'HEALTHY',
    observed_at: sampledAt,
    last_seen_at: sampledAt,
    desired_requested_at: sampledAt,
  };
  const query = async (sql: string, params: unknown[] = []) => {
    if (sql.includes('INSERT INTO orchestrator_service_runtimes')) {
      bootRow.boot_id = params[6];
      bootRow.control_ack_boot_id = null;
      bootRow.control_acknowledged_at = null;
      bootRow.control_revision = 0;
      bootRow.control_state = 'DRAINING';
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('SELECT 1')) return { rows: [{ '?column?': 1 }], rowCount: 1 };
    if (sql.includes('UPDATE orchestrator_service_runtimes')) {
      bootRow.control_revision = 7;
      bootRow.control_ack_boot_id = bootRow.boot_id;
      bootRow.control_acknowledged_at = sampledAt;
      bootRow.readiness_state = 'DRAINING';
      bootRow.database_state = 'HEALTHY';
      bootRow.redis_state = 'HEALTHY';
      bootRow.observed_at = sampledAt;
      bootRow.last_seen_at = sampledAt;
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes('AS requests')) {
      return { rows: [{ requests: 0, dispatches: 0, maintenance_executions: 0, work_observed_at: sampledAt }], rowCount: 1 };
    }
    if (sql.includes('FROM orchestrator_service_runtimes')) {
      return { rows: [{ ...bootRow, cluster_name: 'restore-orchestrator-cluster' }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const db = {
    query,
    tx: async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }),
  } as unknown as Db;
  const disabledEffects = {
    admission: 'DISABLED', dispatch: 'DISABLED', providerInvocation: 'DISABLED', connectorPoll: 'DISABLED',
    usageDelivery: 'DISABLED', webhookDelivery: 'DISABLED', alertEmission: 'DISABLED', cleanup: 'DISABLED',
    historicalMaintenance: 'DISABLED', migrations: 'DISABLED',
  } as const;
  const runtime = createServiceRuntime({
    db,
    redis: { ping: async () => 'PONG' } as never,
    config: identity,
    now: () => sampledAt,
    isolatedReadOnly: true,
    restoreExternalEffects: () => disabledEffects,
  });
  await runtime.start();
  const observation = await runtime.observeReplica({
    service: 'orchestrator', slot: identity.slot, runtimeIdentity: identity.runtimeIdentity,
    replicaId: identity.replicaId, revision: identity.revision, imageDigest: identity.imageDigest,
    scope: { kind: 'platform' },
  });
  expect(observation).toMatchObject({
    clusterName: 'restore-orchestrator-cluster',
    bootId: bootRow.boot_id,
    liveness: 'LIVE',
    livenessObservedAt: sampledAt.toISOString(),
    controlState: 'DRAINING',
    controlAcknowledgedBootId: bootRow.boot_id,
    externalEffects: disabledEffects,
    work: {
      orchestratorRequests: { applicable: true, count: 0 },
      dispatches: { applicable: true, count: 0 },
      maintenanceExecutions: { applicable: true, count: 0 },
    },
  });
  expect(OrchestratorIsolatedRestoreObservationSchema.safeParse(observation).success).toBe(true);
  await runtime.close();
});
