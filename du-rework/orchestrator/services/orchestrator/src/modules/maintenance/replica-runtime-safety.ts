import type { MaintenanceScope } from '@du/contracts';
import type { Db } from '../../db/db';

export type RolloutService = 'orchestrator' | 'connector' | 'worker';
export type RolloutSlot = 'blue' | 'green';
export type ReplicaControlState = 'OPEN' | 'PAUSED' | 'DRAINING';

/** Counts are independently sourced from the owning service. A null count is
 * not equivalent to zero and prevents replica retirement. Connector UNKNOWN
 * invocations remain in connectorInvocations until reconciliation. */
export interface ReplicaWorkCounts {
  workerLeases: { applicable: boolean; count: number | null };
  sdkActiveTasks: { applicable: boolean; count: number | null };
  connectorInvocations: { applicable: boolean; count: number | null };
  orchestratorRequests: { applicable: boolean; count: number | null };
  dispatches: { applicable: boolean; count: number | null };
  maintenanceExecutions: { applicable: boolean; count: number | null };
}

export interface ReplicaRuntimeObservation {
  service: RolloutService;
  serviceRuntimeId?: string;
  slot: RolloutSlot;
  runtimeIdentity: string;
  replicaId: string;
  revision: string;
  imageDigest: string;
  /** Current process boot, when the service publishes one. */
  bootId?: string;
  /** Restore-probe-only facts emitted by the serving Orchestrator process. */
  clusterName?: string;
  liveness?: 'LIVE' | 'NOT_LIVE' | 'UNKNOWN';
  livenessObservedAt?: string;
  readiness: 'READY' | 'DEGRADED' | 'DRAINING' | 'OFFLINE' | 'UNKNOWN';
  observedAt: string;
  workObservedAt: string;
  controlRevision: number;
  controlState: ReplicaControlState;
  /** Null means this exact process has not freshly acknowledged the pinned
   * control revision. It is distinct from work count and never counts as fresh. */
  controlAcknowledgedAt: string | null;
  controlAcknowledgedBootId?: string | null;
  externalEffects?: {
    admission: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
    dispatch: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
    providerInvocation: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
    connectorPoll: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
    usageDelivery: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
    webhookDelivery: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
    alertEmission: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
    cleanup: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
    historicalMaintenance: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
    migrations: 'DISABLED' | 'ENABLED' | 'UNKNOWN';
  };
  /** Worker acknowledgement of the separate backup-effect overlay. The
   * heartbeat producer persists both values from its actual local claim gate;
   * missing/stale acknowledgement is never interpreted as idle. */
  backupEffectFence?: { revision: number | null; acknowledgedAt: string | null };
  work: ReplicaWorkCounts;
}

/** Trusted, authenticated view of process readiness, durable service control,
 * and work counts. Implementations must read from the owner of each source:
 * worker SDK heartbeat + task lease rows, Connector invocation ledger, and
 * Orchestrator request/dispatch trackers. */
export interface ReplicaRuntimeSafetyPort {
  observe(input: {
    service: RolloutService;
    slot: RolloutSlot;
    runtimeIdentity: string;
    replicaId: string;
    revision: string;
    imageDigest: string;
    scope: MaintenanceScope;
  }): Promise<ReplicaRuntimeObservation | null>;
  requestDrain(input: {
    service: RolloutService;
    slot: RolloutSlot;
    runtimeIdentity: string;
    replicaId: string;
    expectedRevision: string;
    expectedImageDigest: string;
    expectedControlRevision: number;
    reason: 'maintenance-rollout';
  }): Promise<{ controlRevision: number; requestedAt: string }>;
  requestResume(input: {
    service: RolloutService;
    slot: RolloutSlot;
    runtimeIdentity: string;
    replicaId: string;
    expectedRevision: string;
    expectedImageDigest: string;
    expectedControlRevision: number;
    reason: 'maintenance-rollback';
  }): Promise<{ controlRevision: number; requestedAt: string }>;
  /** Must make a real request through the fixed serving ingress. The response
   * must identify the serving slot and immutable build revision. */
  probeFixedIngress(input: {
    service: RolloutService;
    scope: MaintenanceScope;
    expectedSlot: RolloutSlot;
    expectedRuntimeIdentity: string;
    expectedReplicaId: string;
    expectedRevision: string;
    expectedImageDigest: string;
  }): Promise<{
    statusCode: number;
    servedService: RolloutService | null;
    servedSlot: RolloutSlot | null;
    servedRuntimeIdentity: string | null;
    servedReplicaId: string | null;
    servedRevision: string | null;
    servedImageDigest: string | null;
    observedAt: string;
  }>;
}

export interface ReplicaRuntimeSafetySource extends Pick<ReplicaRuntimeSafetyPort, 'observe' | 'requestDrain' | 'requestResume'> {}

export interface ReplicaRuntimeSafetyCompositionOptions {
  worker: ReplicaRuntimeSafetySource;
  connector: ReplicaRuntimeSafetySource;
  orchestrator: ReplicaRuntimeSafetySource;
  probeFixedIngress: ReplicaRuntimeSafetyPort['probeFixedIngress'];
}

/** Combine the three service-owned control sources with the single trusted
 * fixed-ingress probe. Each source remains authoritative for its own durable
 * ACK and work counters; missing adapters are a composition error. */
export function createReplicaRuntimeSafetyPort(options: ReplicaRuntimeSafetyCompositionOptions): ReplicaRuntimeSafetyPort {
  const sources: Record<RolloutService, ReplicaRuntimeSafetySource> = {
    worker: options.worker,
    connector: options.connector,
    orchestrator: options.orchestrator,
  };
  const sourceFor = (service: RolloutService) => {
    const source = sources[service];
    if (!source) throw new Error('REPLICA_SAFETY_SOURCE_UNAVAILABLE');
    return source;
  };
  return {
    async observe(input) {
      return sourceFor(input.service).observe(input);
    },
    async requestDrain(input) {
      return sourceFor(input.service).requestDrain(input);
    },
    async requestResume(input) {
      return sourceFor(input.service).requestResume(input);
    },
    probeFixedIngress: options.probeFixedIngress,
  };
}

/** Worker safety source backed by fresh worker SDK heartbeat ACKs and live
 * PostgreSQL task leases. Every worker slot is explicitly bound to one
 * business and stable SDK instance ID in the trusted deployment manifest. */
export function createWorkerReplicaSafetySource(db: Db, workerBusinessByIdentity: Readonly<Record<string, string>>): ReplicaRuntimeSafetySource {
  const businessFor = (identity: string): string => {
    const businessId = workerBusinessByIdentity[identity];
    if (!businessId) throw new Error('WORKER_REPLICA_IDENTITY_NOT_ALLOWLISTED');
    return businessId;
  };
  return {
    async observe(input) {
      if (input.service !== 'worker') throw new Error('WORKER_REPLICA_SERVICE_INVALID');
      const businessId = businessFor(input.runtimeIdentity);
      const result = await db.query<{
        business_id: string; instance_id: string; business_version: string; image_digest: string | null; deployment_revision: string | null;
        state: string; last_seen_at: Date | string; control_revision: number | string; control_state: ReplicaControlState;
        desired_control_revision: number | string; desired_control_state: ReplicaControlState; active_leases: number | string;
        active_task_count: number | string | null; active_task_observed_at: Date | string | null;
        backup_effect_fence_revision: number | string | null; backup_effect_fence_observed_at: Date | string | null;
        control_scope_evidence: Array<{ desiredState: ReplicaControlState; revision: number | string; acknowledgedState: ReplicaControlState | null;
          acknowledgedRevision: number | string | null; acknowledgedAt: Date | string | null }> | string;
      }>(
        `SELECT w.business_id,w.instance_id,w.business_version,w.image_digest,w.deployment_revision,w.state,w.last_seen_at,
                w.control_revision,w.control_state,w.desired_control_revision,w.desired_control_state,
                w.active_task_count,w.active_task_observed_at,w.backup_effect_fence_revision,w.backup_effect_fence_observed_at,
                (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                    'desiredState',r.desired_state,'revision',r.revision,
                    'acknowledgedState',a.control_state,'acknowledgedRevision',a.control_revision,'acknowledgedAt',a.observed_at
                  )),'[]'::jsonb)
                   FROM runtime_control_scopes r
                   LEFT JOIN worker_control_scope_acks a
                     ON a.business_id=w.business_id AND a.instance_id=w.instance_id
                    AND a.scope_kind=r.scope_kind AND a.scope_id=r.scope_id
                  WHERE (r.scope_kind='platform' AND r.scope_id='all')
                     OR (r.scope_kind='business' AND r.scope_id=w.business_id)
                     OR ($3='tenant' AND r.scope_kind='tenant' AND r.scope_id=$4)
                     OR ($3='business' AND r.scope_kind='business' AND r.scope_id=$4)
                ) AS control_scope_evidence,
                (SELECT count(*)::int FROM tasks t JOIN operations o ON o.id=t.operation_id
                  WHERE t.leased_by=w.instance_id AND o.business_id=w.business_id AND t.state='RUNNING') AS active_leases
           FROM worker_instances w WHERE w.business_id=$1 AND w.instance_id=$2`,
        [businessId, input.runtimeIdentity, input.scope.kind, input.scope.kind === 'tenant' ? input.scope.tenantId : input.scope.kind === 'business' ? input.scope.businessId : 'all'],
      );
      const row = result.rows[0];
      if (!row || row.image_digest !== input.imageDigest || row.deployment_revision !== input.revision) return null;
      const observedAt = row.last_seen_at instanceof Date ? row.last_seen_at.toISOString() : new Date(row.last_seen_at).toISOString();
      const activeTaskObservedAt = row.active_task_observed_at instanceof Date
        ? row.active_task_observed_at.toISOString()
        : row.active_task_observed_at ? new Date(row.active_task_observed_at).toISOString() : null;
      let scopeEvidence = row.control_scope_evidence;
      if (typeof scopeEvidence === 'string') {
        try { scopeEvidence = JSON.parse(scopeEvidence) as typeof row.control_scope_evidence; }
        catch { scopeEvidence = []; }
      }
      const controlRows = Array.isArray(scopeEvidence) ? scopeEvidence : [];
      const controlEvidenceValid = controlRows.length >= 2 && controlRows.every((entry) =>
        entry.acknowledgedState === entry.desiredState
        && Number(entry.acknowledgedRevision) === Number(entry.revision)
        && entry.acknowledgedAt !== null);
      const workerControlPending = Number(row.control_revision) < Number(row.desired_control_revision);
      const controlAckTimes = controlRows.map((entry) => entry.acknowledgedAt)
        .filter((value): value is Date | string => value !== null)
        .map((value) => value instanceof Date ? value.getTime() : Date.parse(value));
      const controlAcknowledgedAt = controlEvidenceValid && !workerControlPending && controlAckTimes.length
        && controlAckTimes.every(Number.isFinite)
        ? new Date(Math.min(...controlAckTimes)).toISOString()
        : '';
      const stateRank: Record<ReplicaControlState, number> = { OPEN: 0, PAUSED: 1, DRAINING: 2 };
      const evidencedStates = [row.control_state, ...controlRows.map((entry) => entry.desiredState)];
      const controlState = evidencedStates.reduce((current, state) => stateRank[state] > stateRank[current] ? state : current, 'OPEN' as ReplicaControlState);
      const work: ReplicaWorkCounts = {
        workerLeases: { applicable: true, count: Number(row.active_leases) },
        sdkActiveTasks: { applicable: true, count: row.active_task_count === null ? null : Number(row.active_task_count) },
        connectorInvocations: { applicable: false, count: null },
        orchestratorRequests: { applicable: false, count: null },
        dispatches: { applicable: false, count: null },
        maintenanceExecutions: { applicable: false, count: null },
      };
      return {
        service: 'worker', slot: input.slot, runtimeIdentity: input.runtimeIdentity, replicaId: input.replicaId,
        revision: row.deployment_revision, imageDigest: row.image_digest,
        readiness: row.state === 'ONLINE' ? 'READY' : row.state === 'DRAINING' ? 'DRAINING' : 'OFFLINE',
        observedAt, workObservedAt: activeTaskObservedAt ?? '',
        controlRevision: Math.max(Number(row.control_revision), ...controlRows.map((entry) => Number(entry.acknowledgedRevision ?? 0))), controlState,
        controlAcknowledgedAt,
        backupEffectFence: {
          revision: row.backup_effect_fence_revision === null ? null : Number(row.backup_effect_fence_revision),
          acknowledgedAt: row.backup_effect_fence_observed_at === null ? null
            : row.backup_effect_fence_observed_at instanceof Date
              ? row.backup_effect_fence_observed_at.toISOString()
              : new Date(row.backup_effect_fence_observed_at).toISOString(),
        },
        work,
      };
    },
    async requestDrain(input) {
      if (input.service !== 'worker') throw new Error('WORKER_REPLICA_SERVICE_INVALID');
      return setWorkerControl(db, businessFor(input.runtimeIdentity), input.runtimeIdentity, input.expectedRevision, input.expectedImageDigest, input.expectedControlRevision, 'DRAINING');
    },
    async requestResume(input) {
      if (input.service !== 'worker') throw new Error('WORKER_REPLICA_SERVICE_INVALID');
      return setWorkerControl(db, businessFor(input.runtimeIdentity), input.runtimeIdentity, input.expectedRevision, input.expectedImageDigest, input.expectedControlRevision, 'OPEN');
    },
  };
}

async function setWorkerControl(
  db: Db,
  businessId: string,
  instanceId: string,
  expectedRevision: string,
  expectedImageDigest: string,
  expectedControlRevision: number,
  desiredState: ReplicaControlState,
): Promise<{ controlRevision: number; requestedAt: string }> {
  return db.tx(async (client) => {
    const current = await client.query<{
      image_digest: string | null; deployment_revision: string | null; control_revision: number | string; desired_control_revision: number | string;
      desired_control_state: ReplicaControlState;
    }>(
      `SELECT image_digest,deployment_revision,control_revision,desired_control_revision,desired_control_state
         FROM worker_instances WHERE business_id=$1 AND instance_id=$2 FOR UPDATE`,
      [businessId, instanceId],
    );
    const row = current.rows[0];
    if (!row || row.image_digest !== expectedImageDigest || row.deployment_revision !== expectedRevision) {
      throw new Error('WORKER_REPLICA_CONTROL_CONFLICT');
    }
    if (row.desired_control_state === desiredState) {
      return { controlRevision: Number(row.desired_control_revision), requestedAt: new Date().toISOString() };
    }
    if (Number(row.control_revision) !== expectedControlRevision
      || Number(row.desired_control_revision) > Number(row.control_revision)) {
      throw new Error('WORKER_REPLICA_CONTROL_CONFLICT');
    }
    const updated = await client.query<{ revision: number | string; requested_at: Date | string }>(
      `UPDATE worker_instances
          SET desired_control_state=$3,desired_control_revision=nextval('runtime_control_revision_seq')
        WHERE business_id=$1 AND instance_id=$2
        RETURNING desired_control_revision AS revision,statement_timestamp() AS requested_at`,
      [businessId, instanceId, desiredState],
    );
    const result = updated.rows[0];
    if (!result) throw new Error('WORKER_REPLICA_CONTROL_WRITE_FAILED');
    return {
      controlRevision: Number(result.revision),
      requestedAt: result.requested_at instanceof Date ? result.requested_at.toISOString() : new Date(result.requested_at).toISOString(),
    };
  });
}

export function sumAuthoritativeWork(service: RolloutService, work: ReplicaWorkCounts): number | null {
  const required: Record<RolloutService, readonly (keyof ReplicaWorkCounts)[]> = {
    worker: ['workerLeases', 'sdkActiveTasks'],
    connector: ['connectorInvocations'],
    orchestrator: ['orchestratorRequests', 'dispatches', 'maintenanceExecutions'],
  };
  const requiredFields = new Set(required[service]);
  const entries = Object.entries(work) as Array<[keyof ReplicaWorkCounts, ReplicaWorkCounts[keyof ReplicaWorkCounts]]>;
  let total = 0;
  for (const [field, observation] of entries) {
    if (observation.applicable !== requiredFields.has(field)) return null;
    if (!observation.applicable) {
      if (observation.count !== null) return null;
      continue;
    }
    if (!Number.isSafeInteger(observation.count) || observation.count! < 0) return null;
    total += observation.count!;
  }
  return Number.isSafeInteger(total) ? total : null;
}

export function isFreshObservation(value: string | null | undefined, nowMs: number, maxAgeMs: number): boolean {
  if (typeof value !== 'string') return false;
  const time = Date.parse(value);
  return Number.isFinite(time) && time <= nowMs && nowMs - time <= maxAgeMs;
}
