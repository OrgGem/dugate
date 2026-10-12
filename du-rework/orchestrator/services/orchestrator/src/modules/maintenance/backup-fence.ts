import { createHash, randomUUID } from 'node:crypto';
import type { Db } from '../../db/db';
import type { MaintenanceExecutionFence } from './maintenance-service';
import type { MaintenanceBackupFence, MaintenanceBackupFenceProof } from './trusted-backup-adapter';
import type { BackupArtifactEffectObservation, BackupArtifactEffectPort } from './backup-effect-fence';
import { PostgresBackupSnapshotFence } from './backup-effect-fence';
import type { ReplicaRuntimeObservation, ReplicaRuntimeSafetyPort, RolloutService } from './replica-runtime-safety';
import { isFreshObservation } from './replica-runtime-safety';
import type { BackupReplicaRuntimePin } from './trusted-manifest-rollout-adapter';
import type { ConnectorBackupEffectControl } from './connector-backup-effect-control';
import { createConnectorBackupEffectCoordinator } from './connector-backup-effect-coordinator';
import type { ConnectorBackupEffectFenceObservation } from '@du/contracts';

interface BackupGateRow {
  state: 'OPEN' | 'HELD' | 'UNKNOWN';
  fence_id: string | null;
  fence_revision: string | number;
  backup_id: string | null;
  maintenance_job_id: string | null;
  owner_item_id: string | null;
  owner_runtime_identity: string | null;
  owner_boot_id: string | null;
  owner_execution_fence: string | number | null;
  execution_token_sha256: string | null;
  prior_control_states: Record<string, unknown> | string | null;
}

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }
function digest(value: unknown): string { return sha(JSON.stringify(canonical(value))); }
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort()
    .map((key) => [key, canonical((value as Record<string, unknown>)[key])]));
  return value;
}
function fail(): Error { return new Error('BACKUP_EFFECT_FENCE_UNAVAILABLE'); }
function count(value: number | null | undefined): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) throw fail();
  return value as number;
}
function iso(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw fail();
  return value.toISOString();
}

/** Collect one source sample and only then establish the freshness reference.
 * Returned timestamps must never be in the future or older than the bound. */
export async function collectFreshBackupObservationBatch<T>(input: {
  collect: () => Promise<T>;
  observedAt: (value: T) => readonly (string | null | undefined)[];
  now: () => Date;
  freshnessMs: number;
}): Promise<{ value: T; sampledAt: Date }> {
  const value = await input.collect();
  const sampledAt = input.now();
  if (!Number.isFinite(sampledAt.getTime())
    || input.observedAt(value).some((timestamp) => !isFreshObservation(timestamp, sampledAt.getTime(), input.freshnessMs))) {
    throw fail();
  }
  return { value, sampledAt };
}
function parseJsonRecord(value: Record<string, unknown> | string | null): Record<string, unknown> {
  if (!value) return {};
  if (typeof value !== 'string') return value;
  try {
    const parsed: unknown = JSON.parse(value);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* fail closed below */ }
  throw fail();
}
function sameExecution(gate: BackupGateRow, backupId: string, execution: MaintenanceExecutionFence): boolean {
  return gate.backup_id === backupId && gate.maintenance_job_id === execution.jobId
    && gate.owner_item_id === execution.itemId && gate.owner_runtime_identity === execution.ownerRuntimeIdentity
    && gate.owner_boot_id === execution.ownerBootId && Number(gate.owner_execution_fence) === execution.executionFence
    && gate.execution_token_sha256 === sha(execution.executionToken);
}

const PLATFORM_SCOPE = { kind: 'platform' } as const;
const REQUIRED_SERVICES: readonly RolloutService[] = ['orchestrator', 'connector', 'worker'];

/** Unknown external-effect permits are not made safe by process restart or a
 * fresh zero active-process sample. Historical invocation/usage holds are
 * reported separately; only unresolved effect ownership blocks source capture. */
export function backupExternalEffectsQuiescent(
  connectors: readonly ConnectorBackupEffectFenceObservation[],
  artifacts: BackupArtifactEffectObservation,
): boolean {
  if (connectors.length !== 2 || artifacts.processActiveEffects !== 0
    || artifacts.preparedEffects !== 0 || artifacts.activeEffects !== 0 || artifacts.settlingEffects !== 0
    || artifacts.unknownEffects !== 0 || artifacts.unclosedEffects !== 0) return false;
  return connectors.every((entry) => entry.work.processActiveInvocations === 0
    && entry.work.processActivePolls === 0
    && entry.work.processActiveUsageSends === 0
    && entry.work.effectPermits.prepared === 0
    && entry.work.effectPermits.active === 0
    && entry.work.effectPermits.settling === 0
    && entry.work.effectPermits.unknown === 0
    && entry.work.unknownUsageDeliveries === 0
    && entry.work.unclosedEffectPermits === 0);
}

/**
 * Concrete backup-only quiescence barrier. It first commits the Orchestrator
 * singleton fence, then asks both pinned Connector replicas to acknowledge the
 * same shared Connector fence, and waits for actual worker heartbeats,
 * Orchestrator request/dispatch rows, Connector permits, and artifact permits
 * to quiesce. UNKNOWN/history remains in the evidence; it is never rewritten
 * to idle.
 */
export function createMaintenanceBackupFence(input: {
  db: Db;
  snapshotFence: PostgresBackupSnapshotFence;
  artifactEffects: BackupArtifactEffectPort;
  runtimeSafety: ReplicaRuntimeSafetyPort;
  replicaPins: readonly BackupReplicaRuntimePin[];
  connectorControl: ConnectorBackupEffectControl;
  maxWaitMs?: number;
  sampleIntervalMs?: number;
  freshnessMs?: number;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
}): MaintenanceBackupFence {
  const maxWaitMs = input.maxWaitMs ?? 30_000;
  const sampleIntervalMs = input.sampleIntervalMs ?? 250;
  const freshnessMs = input.freshnessMs ?? 10_000;
  const now = input.now ?? (() => new Date());
  const sleep = input.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  const pins = [...input.replicaPins];
  const byService = new Map<RolloutService, BackupReplicaRuntimePin[]>();
  for (const service of REQUIRED_SERVICES) {
    const selected = pins.filter((pin) => pin.service === service);
    if (selected.length !== 2 || new Set(selected.map((pin) => pin.slot)).size !== 2
      || selected.some((pin) => !pin.runtimeIdentity || pin.replicaId !== pin.runtimeIdentity)) throw fail();
    byService.set(service, selected);
  }
  if (pins.length !== 6 || new Set(pins.map((pin) => `${pin.service}:${pin.slot}`)).size !== 6) throw fail();
  const connectorTargets = byService.get('connector')!.map((pin) => {
    if (!pin.controlBaseUrl) throw fail();
    return { ...pin, serviceId: pin.serviceId, controlBaseUrl: pin.controlBaseUrl };
  });
  const connectorCoordinator = createConnectorBackupEffectCoordinator({
    db: input.db,
    control: input.connectorControl,
    targets: connectorTargets,
    now,
  });

  async function assertCurrentExecution(execution: MaintenanceExecutionFence): Promise<void> {
    const result = await input.db.query(
      `SELECT 1 FROM maintenance_job_items
        WHERE job_id=$1 AND item_id=$2 AND status='RUNNING' AND owner_runtime_identity=$3 AND owner_boot_id=$4
          AND execution_fence=$5 AND backup_execution_token_sha256=$6 AND claim_until>now()`,
      [execution.jobId,execution.itemId,execution.ownerRuntimeIdentity,execution.ownerBootId,
        execution.executionFence,sha(execution.executionToken)],
    );
    if (result.rowCount !== 1) throw fail();
  }

  async function observeReplicas(): Promise<Array<ReplicaRuntimeObservation & { bootId?: string }>> {
    const observations = await Promise.all(pins.map(async (pin) => {
      const observation = await input.runtimeSafety.observe({
        service: pin.service,
        slot: pin.slot,
        runtimeIdentity: pin.runtimeIdentity,
        replicaId: pin.replicaId,
        revision: pin.revision,
        imageDigest: pin.imageDigest,
        scope: PLATFORM_SCOPE,
      });
      if (!observation || observation.service !== pin.service || observation.slot !== pin.slot
        || observation.runtimeIdentity !== pin.runtimeIdentity || observation.replicaId !== pin.replicaId
        || observation.revision !== pin.revision || observation.imageDigest !== pin.imageDigest) throw fail();
      return observation as ReplicaRuntimeObservation & { bootId?: string };
    }));
    return observations;
  }

  function priorControls(observations: readonly ReplicaRuntimeObservation[]): Record<string, unknown> {
    return Object.fromEntries(observations.map((observation) => [`${observation.service}:${observation.slot}`, {
      runtimeIdentity: observation.runtimeIdentity,
      replicaId: observation.replicaId,
      revision: observation.revision,
      imageDigest: observation.imageDigest,
      controlRevision: observation.controlRevision,
      controlState: observation.controlState,
      controlAcknowledgedAt: observation.controlAcknowledgedAt,
    }]));
  }

  async function sourceMaintenanceCount(runtimeIdentity: string): Promise<number> {
    const result = await input.db.query<{ count: string | number }>(
      `SELECT ((SELECT count(*) FROM maintenance_job_items
                  WHERE owner_runtime_identity=$1 AND status IN ('RUNNING','UNKNOWN'))
            + (SELECT count(*) FROM replica_rollout_jobs
                  WHERE owner_runtime_identity=$1 AND state IN ('RUNNING','UNKNOWN')))::text AS count`,
      [runtimeIdentity],
    );
    return count(Number(result.rows[0]?.count));
  }

  async function allSourceMaintenanceCount(execution: MaintenanceExecutionFence): Promise<number> {
    // The source may also have a dedicated Host executor whose identity is
    // intentionally not one of the serving Orchestrator replicas. Count the
    // durable owners across every identity and both maintenance domains. Only
    // this exact currently claimed backup item is excluded; expired and
    // UNKNOWN owners remain blocking evidence.
    const result = await input.db.query<{ count: string | number; own_backup: string | number }>(
      `SELECT
         ((SELECT count(*) FROM maintenance_job_items
            WHERE status IN ('RUNNING','UNKNOWN'))
          + (SELECT count(*) FROM replica_rollout_jobs
            WHERE state IN ('RUNNING','UNKNOWN')))::text AS count,
         (SELECT count(*) FROM maintenance_job_items i
            WHERE i.job_id=$1 AND i.item_id=$2 AND i.item_type='backup'
              AND i.status='RUNNING' AND i.owner_runtime_identity=$3 AND i.owner_boot_id=$4
              AND i.execution_fence=$5 AND i.backup_execution_token_sha256=$6 AND i.claim_until>now())::text AS own_backup`,
      [execution.jobId, execution.itemId, execution.ownerRuntimeIdentity, execution.ownerBootId,
        execution.executionFence, sha(execution.executionToken)],
    );
    const total = count(Number(result.rows[0]?.count));
    const own = count(Number(result.rows[0]?.own_backup));
    if (own !== 1 || total < own) throw fail();
    return total - own;
  }

  async function ownExecutionCount(execution: MaintenanceExecutionFence): Promise<number> {
    const result = await input.db.query<{ count: string | number }>(
      `SELECT count(*)::text AS count FROM maintenance_job_items
        WHERE job_id=$1 AND item_id=$2 AND status='RUNNING' AND owner_runtime_identity=$3 AND owner_boot_id=$4
          AND execution_fence=$5 AND backup_execution_token_sha256=$6 AND claim_until>now()`,
      [execution.jobId,execution.itemId,execution.ownerRuntimeIdentity,execution.ownerBootId,
        execution.executionFence,sha(execution.executionToken)],
    );
    return count(Number(result.rows[0]?.count));
  }

  function fresh(value: string | null | undefined, sampledAt: Date): boolean {
    return isFreshObservation(value, sampledAt.getTime(), freshnessMs);
  }

  async function sample(inputSample: {
    backupId: string; fenceId: string; fenceRevision: number; execution: MaintenanceExecutionFence;
  }): Promise<{ proof: MaintenanceBackupFenceProof | null; retry: boolean }> {
    await assertCurrentExecution(inputSample.execution);
    const batch = await collectFreshBackupObservationBatch({
      collect: () => Promise.all([
        observeReplicas(),
        connectorCoordinator.observeAll(inputSample),
        input.artifactEffects.observe(),
      ] as const),
      observedAt: ([replicas, connectorFences, artifactEffects]) => [
        ...replicas.flatMap((observation) => [observation.observedAt, observation.workObservedAt, observation.controlAcknowledgedAt]),
        ...connectorFences.flatMap((fence) => [fence.fence.acknowledgedAt, fence.observedAt, fence.workObservedAt]),
        artifactEffects.observedAt,
        artifactEffects.workObservedAt,
      ],
      now,
      freshnessMs,
    });
    const [replicas, connectorFences, artifactEffects] = batch.value;
    const sampledAt = batch.sampledAt;
    const ownCount = await ownExecutionCount(inputSample.execution);
    if (ownCount !== 1) throw fail();

    let workerWork = 0;
    let dispatchWork = 0;
    let maintenanceWork = 0;
    let providerWork = 0;
    let pollWork = 0;
    let usageWork = 0;
    for (const observation of replicas) {
      if (!fresh(observation.observedAt, sampledAt) || !fresh(observation.workObservedAt, sampledAt)
        || !fresh(observation.controlAcknowledgedAt, sampledAt)) throw fail();
      const work = observation.work;
      if (observation.service === 'worker') {
        const leases = work.workerLeases.applicable ? count(work.workerLeases.count) : Number.NaN;
        const activeTasks = work.sdkActiveTasks.applicable ? count(work.sdkActiveTasks.count) : Number.NaN;
        if (leases !== 0 || activeTasks !== 0) workerWork += (Number.isFinite(leases) ? leases : 1) + (Number.isFinite(activeTasks) ? activeTasks : 1);
        const backupAck = observation.backupEffectFence;
        if (!backupAck || backupAck.revision !== inputSample.fenceRevision
          || !fresh(backupAck.acknowledgedAt, sampledAt)) workerWork += 1;
      } else if (observation.service === 'orchestrator') {
        const requests = work.orchestratorRequests.applicable ? count(work.orchestratorRequests.count) : Number.NaN;
        const dispatches = work.dispatches.applicable ? count(work.dispatches.count) : Number.NaN;
        const maintenanceExecutions = work.maintenanceExecutions.applicable ? count(work.maintenanceExecutions.count) : Number.NaN;
        dispatchWork += Number.isFinite(dispatches) ? dispatches : 1;
        const dbMaintenance = await sourceMaintenanceCount(observation.runtimeIdentity);
        if (!Number.isFinite(maintenanceExecutions) || maintenanceExecutions !== dbMaintenance) throw fail();
        const ownerMatches = observation.runtimeIdentity === inputSample.execution.ownerRuntimeIdentity;
        const excludedOwn = ownerMatches ? ownCount : 0;
        if (ownerMatches && excludedOwn !== 1) throw fail();
        // Per-replica observation is cross-checked above. The global durable
        // count below also includes the dedicated Host runner identity.
        void excludedOwn;
        dispatchWork += Number.isFinite(requests) ? requests : 1;
      } else {
        const invocationCount = work.connectorInvocations.applicable ? count(work.connectorInvocations.count) : Number.NaN;
        if (!Number.isFinite(invocationCount)) providerWork += 1;
      }
    }

    maintenanceWork = await allSourceMaintenanceCount(inputSample.execution);

    for (const fence of connectorFences) {
      if (fence.fence.state !== 'HELD' || fence.fence.fenceId !== inputSample.fenceId
        || fence.fence.fenceRevision !== inputSample.fenceRevision || !fresh(fence.fence.acknowledgedAt, sampledAt)
        || !fresh(fence.observedAt, sampledAt) || !fresh(fence.workObservedAt, sampledAt)) throw fail();
      providerWork += count(fence.work.processActiveInvocations);
      pollWork += count(fence.work.processActivePolls);
      usageWork += count(fence.work.processActiveUsageSends);
      const effects = fence.work.effectPermits;
      // UNKNOWN permits and unresolved histories remain recorded evidence. Only
      // work that can still be mutating the captured source blocks the snapshot.
      const openPermits = count(effects.prepared) + count(effects.active) + count(effects.settling);
      providerWork += openPermits;
      pollWork += openPermits;
      usageWork += openPermits;
      if (fence.work.unclosedEffectPermits !== openPermits + count(effects.unknown)) throw fail();
    }

    if (artifactEffects.owner.runtimeIdentity !== inputSample.execution.ownerRuntimeIdentity
      || artifactEffects.owner.bootId !== inputSample.execution.ownerBootId
      || !fresh(artifactEffects.observedAt, sampledAt) || !fresh(artifactEffects.workObservedAt, sampledAt)) throw fail();
    const artifactDurableWork = count(artifactEffects.preparedEffects) + count(artifactEffects.activeEffects)
      + count(artifactEffects.settlingEffects);
    const artifactWork = count(artifactEffects.processActiveEffects) + artifactDurableWork;
    if (artifactEffects.unclosedEffects !== artifactDurableWork + count(artifactEffects.unknownEffects)) throw fail();

    const priorGate = await input.db.query<BackupGateRow>(
      `SELECT state,fence_id,fence_revision,backup_id,maintenance_job_id,owner_item_id,owner_runtime_identity,
              owner_boot_id,owner_execution_fence,execution_token_sha256,prior_control_states
         FROM maintenance_backup_effect_gate WHERE singleton_id=1`,
    );
    const gate = priorGate.rows[0];
    if (!gate || gate.state !== 'HELD' || gate.fence_id !== inputSample.fenceId
      || Number(gate.fence_revision) !== inputSample.fenceRevision || !sameExecution(gate,inputSample.backupId,inputSample.execution)) throw fail();
    const controls = parseJsonRecord(gate.prior_control_states);
    const allowedActive = workerWork + dispatchWork + maintenanceWork + providerWork + pollWork + usageWork + artifactWork;
    if (allowedActive !== 0 || !backupExternalEffectsQuiescent(connectorFences,artifactEffects)) return { proof: null, retry: true };
    await assertCurrentExecution(inputSample.execution);
    if (await ownExecutionCount(inputSample.execution) !== 1) throw fail();
    const proofAt = now();
    const finalObservationTimes = [
      ...replicas.flatMap((observation) => [observation.observedAt, observation.workObservedAt, observation.controlAcknowledgedAt]),
      ...connectorFences.flatMap((fence) => [fence.fence.acknowledgedAt, fence.observedAt, fence.workObservedAt]),
      artifactEffects.observedAt,
      artifactEffects.workObservedAt,
    ];
    if (!Number.isFinite(proofAt.getTime()) || finalObservationTimes.some((timestamp) => !fresh(timestamp, proofAt))) {
      return { proof: null, retry: true };
    }

    const evidence = {
      fenceId: inputSample.fenceId,
      fenceRevision: inputSample.fenceRevision,
      priorControlStates: controls,
      replicaObservations: replicas,
      connectorFences,
      artifactEffects,
      execution: {
        jobId: inputSample.execution.jobId,
        itemId: inputSample.execution.itemId,
        ownerRuntimeIdentity: inputSample.execution.ownerRuntimeIdentity,
        ownerBootId: inputSample.execution.ownerBootId,
        executionFence: inputSample.execution.executionFence,
        executionTokenSha256: sha(inputSample.execution.executionToken),
      },
    };
    const proof: MaintenanceBackupFenceProof = {
      observedAt: iso(proofAt),
      admission: { fenced: true, inFlight: workerWork },
      orchestratorDispatch: { fenced: true, inFlight: dispatchWork + maintenanceWork },
      providerIssuance: { fenced: true, inFlight: providerWork },
      connectorInvocationPolling: { fenced: true, inFlight: pollWork },
      artifactMutation: { fenced: true, inFlight: artifactWork },
      connectorUsageDelivery: { fenced: true, inFlight: usageWork },
      evidence,
      evidenceSha256: digest(evidence),
    };
    return { proof, retry: false };
  }

  async function awaitQuiescence(args: {
    backupId: string; fenceId: string; fenceRevision: number; execution: MaintenanceExecutionFence;
  }): Promise<MaintenanceBackupFenceProof> {
    const deadline = now().getTime() + maxWaitMs;
    while (now().getTime() <= deadline) {
      const result = await sample(args);
      if (result.proof) return result.proof;
      await sleep(sampleIntervalMs);
    }
    throw fail();
  }

  return {
    async acquire(request) {
      if (request.reason !== 'durable-platform-backup') throw fail();
      await assertCurrentExecution(request.execution);
      const selected = await input.db.query<BackupGateRow>(
        `SELECT state,fence_id,fence_revision,backup_id,maintenance_job_id,owner_item_id,owner_runtime_identity,
                owner_boot_id,owner_execution_fence,execution_token_sha256,prior_control_states
           FROM maintenance_backup_effect_gate WHERE singleton_id=1`,
      );
      const gate = selected.rows[0];
      if (!gate) throw fail();
      let fenceId: string;
      let fenceRevision: number;
      if (gate.state === 'OPEN') {
        const observed = await observeReplicas();
        const before = now();
        if (observed.some((row) => !fresh(row.observedAt,before) || !fresh(row.workObservedAt,before)
          || !fresh(row.controlAcknowledgedAt,before))) throw fail();
        fenceId = randomUUID();
        const baseRevision = Number(gate.fence_revision);
        if (!Number.isSafeInteger(baseRevision) || baseRevision < 0) throw fail();
        const held = await input.snapshotFence.hold({
          fenceId,
          backupId: request.backupId,
          execution: request.execution,
          expectedFenceRevision: baseRevision,
          priorControlStates: priorControls(observed),
        });
        fenceRevision = held.fenceRevision;
      } else if (gate.state === 'HELD' && gate.fence_id && sameExecution(gate,request.backupId,request.execution)) {
        fenceId = gate.fence_id;
        fenceRevision = Number(gate.fence_revision);
        if (!Number.isSafeInteger(fenceRevision) || fenceRevision < 1) throw fail();
      } else throw fail();
      await connectorCoordinator.holdAll({ fenceId, backupId: request.backupId, execution: request.execution });
      const proof = await awaitQuiescence({ backupId: request.backupId, fenceId, fenceRevision, execution: request.execution });
      return { fenceId, fenceRevision, proof };
    },
    async release(request) {
      await assertCurrentExecution(request.execution);
      const proof = await awaitQuiescence({
        backupId: request.backupId,
        fenceId: request.fenceId,
        fenceRevision: request.fenceRevision,
        execution: request.execution,
      });
      if (proof.evidenceSha256 !== digest(proof.evidence)) throw fail();
      await connectorCoordinator.releaseAll({ fenceId: request.fenceId, backupId: request.backupId, execution: request.execution });
      await input.snapshotFence.release(request);
    },
  };
}
