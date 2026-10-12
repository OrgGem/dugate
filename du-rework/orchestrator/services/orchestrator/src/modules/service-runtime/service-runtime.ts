import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import type IORedis from 'ioredis';
import {
  OrchestratorServiceRuntimeIdentitySchema,
  type OrchestratorExternalEffects,
  type OrchestratorServiceRuntimeIdentity,
} from '@du/contracts';
import type { Db } from '../../db/db';
import type { MaintenanceScope } from '@du/contracts';
import type {
  ReplicaRuntimeObservation,
  ReplicaRuntimeSafetySource,
} from '../maintenance/replica-runtime-safety';
import { HttpError } from '../../http/errors';

export interface ServiceRuntimeConfig extends OrchestratorServiceRuntimeIdentity {
  /** Dedicated host-control credential; never reused as Admin/runtime/worker auth. */
  controlToken: string;
}

export interface ServiceRuntimeControlInput {
  service: 'orchestrator';
  slot: 'blue' | 'green';
  runtimeIdentity: string;
  replicaId: string;
  expectedRevision: string;
  expectedImageDigest: string;
  expectedControlRevision: number;
  reason: 'maintenance-rollout' | 'maintenance-rollback';
}

export interface ServiceRuntimeControlAck {
  controlRevision: number;
  requestedAt: string;
}

export interface ServiceRuntime {
  readonly identity: OrchestratorServiceRuntimeIdentity;
  readonly controlToken: string;
  start(): Promise<void>;
  close(): Promise<void>;
  trackHttpRequest(method: string, pathname: string, response: ServerResponse): Promise<void>;
  observeReplica(input: {
    service: 'orchestrator'; slot: 'blue' | 'green'; runtimeIdentity: string; replicaId: string;
    revision: string; imageDigest: string; scope: MaintenanceScope;
  }): Promise<ReplicaRuntimeObservation | null>;
  requestDrain(input: ServiceRuntimeControlInput): Promise<ServiceRuntimeControlAck>;
  requestResume(input: ServiceRuntimeControlInput): Promise<ServiceRuntimeControlAck>;
  readControl(): Promise<{ controlRevision: number; state: 'OPEN' | 'PAUSED' | 'DRAINING' }>;
  acquireDispatchPermit(input: { serviceRuntimeId: string; expectedControlRevision: number }): Promise<{ permitId: string; controlRevision: number } | null>;
  releaseDispatchPermit(permitId: string): Promise<void>;
}

interface RuntimeRow {
  service_runtime_id: string;
  runtime_identity: string;
  replica_id: string;
  slot: 'blue' | 'green';
  revision: string;
  image_digest: string;
  boot_id: string;
  desired_control_revision: number | string;
  desired_control_state: 'OPEN' | 'PAUSED' | 'DRAINING';
  control_revision: number | string;
  control_state: 'OPEN' | 'PAUSED' | 'DRAINING';
  control_ack_boot_id: string | null;
  control_acknowledged_at: Date | string | null;
  desired_requested_at: Date | string | null;
  readiness_state: 'READY' | 'DEGRADED' | 'DRAINING' | 'OFFLINE' | 'UNKNOWN';
  database_state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN';
  redis_state: 'HEALTHY' | 'UNAVAILABLE' | 'UNKNOWN';
  cluster_name?: string | null;
  observed_at: Date | string | null;
  last_seen_at: Date | string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null) return null;
  const parsed = value instanceof Date ? value : new Date(value);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function isControlProbe(method: string, pathname: string): boolean {
  return (method === 'GET' && (pathname === '/health' || pathname === '/api/v1/health'))
    || pathname === '/api/internal/service-runtime'
    || pathname.startsWith('/api/internal/service-runtime/');
}

/** Only these writes are local to the isolated restored database. The
 * allowlist exists so authenticated legacy account activation and login can
 * be rehearsed without admitting operations or enabling another subsystem. */
export function isRestoreRehearsalRequestAllowed(method: string, pathname: string): boolean {
  if (method === 'GET' || method === 'HEAD' || method === 'OPTIONS') return true;
  if (method === 'POST' && (pathname === '/admin/login' || pathname === '/admin/logout')) return true;
  if (method === 'POST' && /^\/admin\/api\/identity\/users\/[0-9a-f-]{36}\/password$/i.test(pathname)) return true;
  if (method === 'POST' && /^\/api\/internal\/parity\/identity\/users\/[0-9a-f-]{36}\/password$/i.test(pathname)) return true;
  return false;
}

export function parseServiceRuntimeConfig(raw: unknown): ServiceRuntimeConfig {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('ORCHESTRATOR_SERVICE_RUNTIME_CONFIG_INVALID');
  const candidate = raw as Record<string, unknown>;
  const identity = OrchestratorServiceRuntimeIdentitySchema.safeParse({
    serviceRuntimeId: candidate['serviceRuntimeId'],
    runtimeIdentity: candidate['runtimeIdentity'],
    replicaId: candidate['replicaId'],
    slot: candidate['slot'],
    revision: candidate['revision'],
    imageDigest: candidate['imageDigest'],
  });
  const token = candidate['controlToken'];
  if (!identity.success || typeof token !== 'string' || token.length < 32 || token.length > 4096) {
    throw new Error('ORCHESTRATOR_SERVICE_RUNTIME_CONFIG_INVALID');
  }
  if (identity.data.serviceRuntimeId !== identity.data.runtimeIdentity
      || identity.data.replicaId !== identity.data.runtimeIdentity) {
    throw new Error('ORCHESTRATOR_SERVICE_RUNTIME_IDENTITY_MISMATCH');
  }
  return { ...identity.data, controlToken: token };
}

export function createServiceRuntime(input: {
  db: Db;
  redis: Pick<IORedis, 'ping'>;
  config: ServiceRuntimeConfig;
  now?: () => Date;
  heartbeatIntervalMs?: number;
  freshnessMs?: number;
  isolatedReadOnly?: boolean;
  /** Supplied by the assembled app from its live worker/timer controls. */
  restoreExternalEffects?: () => OrchestratorExternalEffects;
}): ServiceRuntime {
  const now = input.now ?? (() => new Date());
  const heartbeatIntervalMs = input.heartbeatIntervalMs ?? 5_000;
  const freshnessMs = input.freshnessMs ?? 15_000;
  const identity = parseServiceRuntimeConfig(input.config);
  const bootId = randomUUID();
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let started = false;

  async function heartbeat(): Promise<void> {
    const at = now();
    if (!Number.isFinite(at.getTime())) throw new Error('SERVICE_RUNTIME_CLOCK_INVALID');
    let databaseHealthy = false;
    let redisHealthy = false;
    try {
      const check = await input.db.query('SELECT 1');
      databaseHealthy = Boolean(check.rowCount && check.rowCount > 0);
    } catch { databaseHealthy = false; }
    try {
      redisHealthy = (await input.redis.ping()) === 'PONG';
    } catch { redisHealthy = false; }
    const dbState = databaseHealthy ? 'HEALTHY' : 'UNAVAILABLE';
    const redisState = redisHealthy ? 'HEALTHY' : 'UNAVAILABLE';
    await input.db.tx(async (client) => {
      const updated = await client.query<RuntimeRow>(
        `UPDATE orchestrator_service_runtimes
            SET control_revision=desired_control_revision,
                control_state=desired_control_state,
                control_ack_boot_id=boot_id,
                control_acknowledged_at=$2,
                readiness_state=CASE
                  WHEN desired_control_state='DRAINING' THEN 'DRAINING'
                  WHEN $3='HEALTHY' AND $4='HEALTHY' THEN 'READY'
                  ELSE 'DEGRADED'
                END,
                database_state=$3,redis_state=$4,observed_at=$2,last_seen_at=$2,updated_at=$2
          WHERE service_runtime_id=$1 AND boot_id=$5
          RETURNING service_runtime_id,runtime_identity,replica_id,slot,revision,image_digest,boot_id,
                    desired_control_revision,desired_control_state,control_revision,control_state,
                    control_ack_boot_id,control_acknowledged_at,readiness_state,database_state,redis_state,
                    observed_at,last_seen_at`,
        [identity.serviceRuntimeId, at, dbState, redisState, bootId],
      );
      if (!updated.rowCount) throw new Error('SERVICE_RUNTIME_NOT_REGISTERED');
    });
  }

  async function requireLocalRow(client: import('pg').PoolClient, lock: boolean): Promise<RuntimeRow> {
    const selected = await client.query<RuntimeRow>(
      `SELECT service_runtime_id,runtime_identity,replica_id,slot,revision,image_digest,boot_id,
              desired_control_revision,desired_control_state,control_revision,control_state,
              control_ack_boot_id,control_acknowledged_at,readiness_state,database_state,redis_state,
              observed_at,last_seen_at,desired_requested_at
         FROM orchestrator_service_runtimes WHERE service_runtime_id=$1${lock ? ' FOR UPDATE' : ''}`,
      [identity.serviceRuntimeId],
    );
    const row = selected.rows[0];
    if (!row || row.boot_id !== bootId) throw new HttpError(503, 'SERVICE_RUNTIME_UNAVAILABLE', 'service runtime is not registered for this process');
    return row;
  }

  async function beginRequest(allowDrainingRead: boolean): Promise<string> {
    return input.db.tx(async (client) => {
      const row = await requireLocalRow(client, true);
      const drainingReadReady = allowDrainingRead
        && row.desired_control_state === 'DRAINING'
        && Number(row.control_revision) === Number(row.desired_control_revision)
        && row.control_state === 'DRAINING' && row.control_ack_boot_id === bootId
        && row.database_state === 'HEALTHY' && row.redis_state === 'HEALTHY';
      if (!drainingReadReady && (row.desired_control_state !== 'OPEN'
          || Number(row.control_revision) !== Number(row.desired_control_revision)
          || row.control_state !== 'OPEN' || row.control_ack_boot_id !== bootId
          || row.readiness_state !== 'READY' || row.database_state !== 'HEALTHY' || row.redis_state !== 'HEALTHY')) {
        const code = row.desired_control_state === 'DRAINING' ? 'SERVICE_DRAINING' : 'SERVICE_PAUSED';
        throw new HttpError(503, code, 'service is not accepting new requests');
      }
      const requestId = randomUUID();
      await client.query(
        'INSERT INTO orchestrator_service_runtime_requests(request_id,service_runtime_id,boot_id,started_at) VALUES($1,$2,$3,$4)',
        [requestId, identity.serviceRuntimeId, bootId, now()],
      );
      return requestId;
    });
  }

  async function requestControl(inputControl: ServiceRuntimeControlInput, desiredState: 'OPEN' | 'DRAINING'): Promise<ServiceRuntimeControlAck> {
    if (inputControl.service !== 'orchestrator' || inputControl.runtimeIdentity !== inputControl.replicaId) {
      throw new HttpError(404, 'NOT_FOUND', 'service replica not found');
    }
    return input.db.tx(async (client) => {
      const selected = await client.query<RuntimeRow>(
        `SELECT service_runtime_id,runtime_identity,replica_id,slot,revision,image_digest,boot_id,
                desired_control_revision,desired_control_state,control_revision,control_state,
                control_ack_boot_id,control_acknowledged_at,readiness_state,database_state,redis_state,
                observed_at,last_seen_at,desired_requested_at
           FROM orchestrator_service_runtimes
          WHERE service_runtime_id=$1 AND runtime_identity=$2 AND replica_id=$3 AND slot=$4
          FOR UPDATE`,
        [inputControl.runtimeIdentity, inputControl.runtimeIdentity, inputControl.replicaId, inputControl.slot],
      );
      const row = selected.rows[0];
      if (!row) throw new HttpError(404, 'NOT_FOUND', 'service replica not found');
      if (row.revision !== inputControl.expectedRevision || row.image_digest !== inputControl.expectedImageDigest) {
        throw new HttpError(409, 'STATE_CONFLICT', 'service replica revision changed');
      }
      if (row.desired_control_state === desiredState) {
        return {
          controlRevision: Number(row.desired_control_revision),
          requestedAt: iso(row.desired_requested_at) ?? iso(row.control_acknowledged_at) ?? now().toISOString(),
        };
      }
      if (Number(row.desired_control_revision) !== inputControl.expectedControlRevision
          || Number(row.control_revision) !== Number(row.desired_control_revision)
          || row.control_ack_boot_id !== row.boot_id
          || !iso(row.last_seen_at)
          || now().getTime() - Date.parse(iso(row.last_seen_at)!) > freshnessMs) {
        throw new HttpError(409, 'STATE_CONFLICT', 'service control revision changed');
      }
      const at = now();
      const updated = await client.query<{ revision: number | string }>(
        `UPDATE orchestrator_service_runtimes
            SET desired_control_revision=nextval('runtime_control_revision_seq'),
                desired_control_state=$2,desired_reason=$3,desired_requested_at=$4,updated_at=$4
          WHERE service_runtime_id=$1 AND revision=$5 AND image_digest=$6
          RETURNING desired_control_revision AS revision`,
        [inputControl.runtimeIdentity, desiredState, inputControl.reason, at,
          inputControl.expectedRevision, inputControl.expectedImageDigest],
      );
      const result = updated.rows[0];
      if (!result) throw new HttpError(503, 'SERVICE_RUNTIME_UNAVAILABLE', 'service control update did not persist');
      return { controlRevision: Number(result.revision), requestedAt: at.toISOString() };
    });
  }

  return {
    identity,
    controlToken: identity.controlToken,
    async start() {
      if (started) return;
      await input.db.query(
        `INSERT INTO orchestrator_service_runtimes(
           service_runtime_id,runtime_identity,replica_id,slot,revision,image_digest,boot_id,
           desired_control_revision,desired_control_state,desired_reason,desired_requested_at,control_revision,control_state,
           control_ack_boot_id,control_acknowledged_at,readiness_state,database_state,redis_state,
           observed_at,last_seen_at
         ) VALUES($1,$2,$3,$4,$5,$6,$7,nextval('runtime_control_revision_seq'),
                  CASE WHEN $8 THEN 'DRAINING' ELSE 'OPEN' END,
                  CASE WHEN $8 THEN 'isolated restore rehearsal' ELSE 'initial service runtime state' END,now(),
                  0,CASE WHEN $8 THEN 'DRAINING' ELSE 'OPEN' END,NULL,NULL,'UNKNOWN','UNKNOWN','UNKNOWN',NULL,NULL)
         ON CONFLICT(service_runtime_id) DO UPDATE SET
           runtime_identity=EXCLUDED.runtime_identity,replica_id=EXCLUDED.replica_id,
           slot=EXCLUDED.slot,revision=EXCLUDED.revision,image_digest=EXCLUDED.image_digest,
           boot_id=EXCLUDED.boot_id,control_ack_boot_id=NULL,readiness_state='UNKNOWN',
           database_state='UNKNOWN',redis_state='UNKNOWN',observed_at=NULL,last_seen_at=NULL,updated_at=now(),
           desired_control_revision=CASE WHEN $8 THEN nextval('runtime_control_revision_seq') ELSE orchestrator_service_runtimes.desired_control_revision END,
           desired_control_state=CASE WHEN $8 THEN 'DRAINING' ELSE orchestrator_service_runtimes.desired_control_state END,
           desired_reason=CASE WHEN $8 THEN 'isolated restore rehearsal' ELSE orchestrator_service_runtimes.desired_reason END,
           desired_requested_at=CASE WHEN $8 THEN now() ELSE orchestrator_service_runtimes.desired_requested_at END
         RETURNING service_runtime_id`,
        [identity.serviceRuntimeId, identity.runtimeIdentity, identity.replicaId, identity.slot,
          identity.revision, identity.imageDigest, bootId, input.isolatedReadOnly === true],
      );
      started = true;
      await heartbeat();
      heartbeatTimer = setInterval(() => { void heartbeat().catch(() => undefined); }, heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    },
    async close() {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
      started = false;
    },
    async trackHttpRequest(method, pathname, response) {
      const allowDrainingRead = input.isolatedReadOnly === true
        && isRestoreRehearsalRequestAllowed(method, pathname);
      if (input.isolatedReadOnly === true && !allowDrainingRead) {
        throw new HttpError(503, 'RESTORE_REHEARSAL_READ_ONLY', 'this isolated restore process accepts reads and local account activation only');
      }
      if (isControlProbe(method, pathname)) return;
      const requestId = await beginRequest(allowDrainingRead);
      let completed = false;
      const finish = (completionReason: 'finish' | 'close') => {
        if (completed) return;
        completed = true;
        response.removeListener('finish', onFinish);
        response.removeListener('close', onClose);
        void input.db.query(
          `UPDATE orchestrator_service_runtime_requests SET completed_at=$3,completion_reason=$4
            WHERE request_id=$1 AND service_runtime_id=$2 AND completed_at IS NULL`,
          [requestId, identity.serviceRuntimeId, now(), completionReason],
        ).catch(() => undefined);
      };
      const onFinish = () => finish('finish');
      const onClose = () => finish('close');
      response.once('finish', onFinish);
      response.once('close', onClose);
      if (response.writableFinished || response.destroyed) finish(response.writableFinished ? 'finish' : 'close');
    },
    async observeReplica(observationInput) {
      if (observationInput.service !== 'orchestrator' || observationInput.scope.kind !== 'platform') {
        throw new HttpError(403, 'PERMISSION_DENIED', 'Orchestrator replica observations are platform scoped');
      }
      const selected = await input.db.query<RuntimeRow>(
        `SELECT service_runtime_id,runtime_identity,replica_id,slot,revision,image_digest,boot_id,
                desired_control_revision,desired_control_state,control_revision,control_state,
                control_ack_boot_id,control_acknowledged_at,readiness_state,database_state,redis_state,
                observed_at,last_seen_at,desired_requested_at,
                NULLIF(current_setting('cluster_name',true),'') AS cluster_name
          FROM orchestrator_service_runtimes
          WHERE service_runtime_id=$1 AND runtime_identity=$2 AND replica_id=$3 AND slot=$4 AND revision=$5 AND image_digest=$6`,
        [observationInput.runtimeIdentity, observationInput.runtimeIdentity, observationInput.replicaId,
          observationInput.slot, observationInput.revision, observationInput.imageDigest],
      );
      const row = selected.rows[0];
      if (!row) return null;
      if (input.isolatedReadOnly === true && !row.cluster_name) return null;
      const seenAt = iso(row.last_seen_at);
      const ackAt = row.boot_id === row.control_ack_boot_id ? iso(row.control_acknowledged_at) : null;
      const observedAt = iso(row.observed_at);
      if (!seenAt || !observedAt) return null;
      const age = now().getTime() - Date.parse(seenAt);
      const readiness = age < 0 || age > freshnessMs ? 'OFFLINE'
        : row.desired_control_state === 'DRAINING' ? 'DRAINING'
          : row.database_state !== 'HEALTHY' || row.redis_state !== 'HEALTHY' ? 'DEGRADED'
            : row.readiness_state;
      const workResult = await input.db.query<{
        requests: number | string; dispatches: number | string; maintenance_executions: number | string;
        work_observed_at: Date | string;
      }>(
        `SELECT
           (SELECT count(*)::int FROM orchestrator_service_runtime_requests WHERE service_runtime_id=$1 AND completed_at IS NULL) AS requests,
           (SELECT count(*)::int FROM orchestrator_service_runtime_dispatch_permits WHERE service_runtime_id=$1 AND released_at IS NULL) AS dispatches,
           ((SELECT count(*)::int FROM maintenance_job_items
               WHERE owner_runtime_identity=$2 AND status IN ('RUNNING','UNKNOWN'))
             + (SELECT count(*)::int FROM replica_rollout_jobs
               WHERE owner_runtime_identity=$2 AND state IN ('RUNNING','UNKNOWN'))) AS maintenance_executions,
           statement_timestamp() AS work_observed_at`,
        [row.service_runtime_id, row.runtime_identity],
      );
      const work = workResult.rows[0];
      const workObservedAt = work ? iso(work.work_observed_at) : null;
      if (!work || !workObservedAt) return null;
      const livenessObservedAt = now().toISOString();
      const restoreControlAcknowledged = row.boot_id === row.control_ack_boot_id
        && row.control_state === 'DRAINING'
        && row.desired_control_state === 'DRAINING'
        && row.database_state === 'HEALTHY' && row.redis_state === 'HEALTHY'
        && Number(row.control_revision) === Number(row.desired_control_revision);
      const externalEffects = input.isolatedReadOnly === true
        ? input.restoreExternalEffects?.()
        : undefined;
      if (input.isolatedReadOnly === true && !externalEffects) {
        throw new HttpError(503, 'SERVICE_RUNTIME_UNAVAILABLE', 'isolated restore effect observations are unavailable');
      }
      const result: ReplicaRuntimeObservation & { dependencies: Array<{ dependencyId: 'postgres' | 'redis'; state: RuntimeRow['database_state']; observedAt: string }> } = {
        service: 'orchestrator', serviceRuntimeId: row.service_runtime_id,
        slot: row.slot, runtimeIdentity: row.runtime_identity, replicaId: row.replica_id,
        revision: row.revision, imageDigest: row.image_digest, bootId: row.boot_id, readiness, observedAt: seenAt,
        ...(input.isolatedReadOnly === true ? {
          clusterName: row.cluster_name!,
          liveness: 'LIVE' as const,
          livenessObservedAt,
          controlAcknowledgedBootId: row.control_ack_boot_id,
          externalEffects: { ...externalEffects!, admission: restoreControlAcknowledged ? 'DISABLED' : 'UNKNOWN' },
        } : {}),
        workObservedAt, controlRevision: Number(row.control_revision), controlState: row.control_state,
        controlAcknowledgedAt: ackAt,
        dependencies: [
          { dependencyId: 'postgres', state: row.database_state, observedAt },
          { dependencyId: 'redis', state: row.redis_state, observedAt },
        ],
        work: {
          workerLeases: { applicable: false, count: null },
          sdkActiveTasks: { applicable: false, count: null },
          connectorInvocations: { applicable: false, count: null },
          orchestratorRequests: { applicable: true, count: Number(work.requests) },
          dispatches: { applicable: true, count: Number(work.dispatches) },
          maintenanceExecutions: { applicable: true, count: Number(work.maintenance_executions) },
        },
      };
      return result;
    },
    requestDrain: (controlInput) => requestControl(controlInput, 'DRAINING'),
    requestResume: (controlInput) => requestControl(controlInput, 'OPEN'),
    async readControl() {
      const selected = await input.db.query<RuntimeRow>(
        `SELECT service_runtime_id,runtime_identity,replica_id,slot,revision,image_digest,boot_id,
                desired_control_revision,desired_control_state,control_revision,control_state,
                control_ack_boot_id,control_acknowledged_at,readiness_state,database_state,redis_state,
                observed_at,last_seen_at
           FROM orchestrator_service_runtimes WHERE service_runtime_id=$1`,
        [identity.serviceRuntimeId],
      );
      const row = selected.rows[0];
      if (!row || row.boot_id !== bootId || row.control_ack_boot_id !== bootId
          || Number(row.control_revision) !== Number(row.desired_control_revision)
          || row.readiness_state !== 'READY' || row.database_state !== 'HEALTHY' || row.redis_state !== 'HEALTHY') {
        return { controlRevision: row ? Number(row.desired_control_revision) : 0, state: 'DRAINING' as const };
      }
      return { controlRevision: Number(row.desired_control_revision), state: row.desired_control_state };
    },
    async acquireDispatchPermit(permitInput) {
      if (permitInput.serviceRuntimeId !== identity.serviceRuntimeId) return null;
      return input.db.tx(async (client) => {
        const row = await requireLocalRow(client, true);
        if (row.desired_control_state !== 'OPEN'
            || row.control_state !== 'OPEN'
            || row.control_ack_boot_id !== bootId
            || Number(row.control_revision) !== Number(row.desired_control_revision)
            || Number(row.desired_control_revision) !== permitInput.expectedControlRevision
            || row.readiness_state !== 'READY' || row.database_state !== 'HEALTHY' || row.redis_state !== 'HEALTHY') return null;
        const permitId = randomUUID();
        await client.query(
          'INSERT INTO orchestrator_service_runtime_dispatch_permits(permit_id,service_runtime_id,boot_id,acquired_at) VALUES($1,$2,$3,$4)',
          [permitId, identity.serviceRuntimeId, bootId, now()],
        );
        return { permitId, controlRevision: Number(row.desired_control_revision) };
      });
    },
    async releaseDispatchPermit(permitId) {
      const result = await input.db.query(
        `UPDATE orchestrator_service_runtime_dispatch_permits SET released_at=$3
          WHERE permit_id=$1 AND service_runtime_id=$2 AND released_at IS NULL`,
        [permitId, identity.serviceRuntimeId, now()],
      );
      if (!result.rowCount) {
        const exists = await input.db.query(
          `SELECT 1 FROM orchestrator_service_runtime_dispatch_permits
            WHERE permit_id=$1 AND service_runtime_id=$2 AND released_at IS NOT NULL`,
          [permitId, identity.serviceRuntimeId],
        );
        if (!exists.rowCount) throw new HttpError(503, 'SERVICE_RUNTIME_PERMIT_UNKNOWN', 'dispatch permit release could not be confirmed');
      }
    },
  };
}

/** Host-owned manifest rollouts compose this adapter with Worker/Connector
 * safety sources. It reports only the configured replica, against its real
 * durable process identity, request rows, and dispatch permits. */
export function createOrchestratorReplicaSafetySource(runtime: ServiceRuntime): ReplicaRuntimeSafetySource {
  return {
    observe: (input) => input.service === 'orchestrator'
      ? runtime.observeReplica({ ...input, service: 'orchestrator' })
      : Promise.resolve(null),
    requestDrain: (input) => {
      if (input.service !== 'orchestrator') throw new HttpError(404, 'NOT_FOUND', 'service replica not found');
      return runtime.requestDrain({ ...input, service: 'orchestrator', reason: 'maintenance-rollout' });
    },
    requestResume: (input) => {
      if (input.service !== 'orchestrator') throw new HttpError(404, 'NOT_FOUND', 'service replica not found');
      return runtime.requestResume({ ...input, service: 'orchestrator', reason: 'maintenance-rollback' });
    },
  };
}

