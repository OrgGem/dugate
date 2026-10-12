import { createHash } from 'node:crypto';
import type { Db } from '../src/db/db';
import type { ConnectorBackupEffectControl } from '../src/modules/maintenance/connector-backup-effect-control';
import type { BackupArtifactEffectObservation, BackupArtifactEffectPort } from '../src/modules/maintenance/backup-effect-fence';
import { createMaintenanceBackupFence } from '../src/modules/maintenance/backup-fence';
import type { ReplicaRuntimeObservation, RolloutService } from '../src/modules/maintenance/replica-runtime-safety';
import type { BackupReplicaRuntimePin } from '../src/modules/maintenance/trusted-manifest-rollout-adapter';
import type { MaintenanceExecutionFence } from '../src/modules/maintenance/maintenance-service';
import type { ConnectorBackupEffectTarget } from '../src/modules/maintenance/connector-backup-effect-control';

const timestamp = '2026-10-12T06:00:00.000Z';
const backupId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const bootId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const execution: MaintenanceExecutionFence = {
  jobId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', itemId: 'backup-primary',
  ownerRuntimeIdentity: 'maintenance-host-blue', ownerBootId: bootId,
  executionFence: 3, executionToken: 'vfy-host-backup-token-'.repeat(3),
};

function sha(value: string): string { return createHash('sha256').update(value).digest('hex'); }

const pins: BackupReplicaRuntimePin[] = (['orchestrator', 'connector', 'worker'] as const).flatMap((service) =>
  (['blue', 'green'] as const).map((slot) => {
    const identity = `${service}-${slot}`;
    return {
      service, slot, serviceId: `${service}-service`, runtimeIdentity: identity, replicaId: identity,
      revision: 'rev-15', imageDigest: `${service}@sha256:${service === 'worker' ? 'c' : service === 'connector' ? 'b' : 'a'}${'0'.repeat(63)}`,
      ...(service === 'connector' ? { controlBaseUrl: `http://127.0.0.1:${slot === 'blue' ? 19101 : 19102}` } : {}),
    };
  }));

function workFor(service: RolloutService) {
  return {
    workerLeases: { applicable: service === 'worker', count: service === 'worker' ? 0 : null },
    sdkActiveTasks: { applicable: service === 'worker', count: service === 'worker' ? 0 : null },
    connectorInvocations: { applicable: service === 'connector', count: service === 'connector' ? 0 : null },
    orchestratorRequests: { applicable: service === 'orchestrator', count: service === 'orchestrator' ? 0 : null },
    dispatches: { applicable: service === 'orchestrator', count: service === 'orchestrator' ? 0 : null },
    maintenanceExecutions: { applicable: service === 'orchestrator', count: service === 'orchestrator' ? 0 : null },
  };
}

function connectorObservation(target: ConnectorBackupEffectTarget, state: 'OPEN' | 'HELD', fenceId: string | null, revision: number) {
  const at = timestamp;
  return {
    slot: target.slot, runtimeIdentity: target.runtimeIdentity, replicaId: target.replicaId,
    revision: target.revision, imageDigest: target.imageDigest,
    fence: { state, fenceId, fenceRevision: revision, acknowledgedAt: state === 'HELD' ? at : null,
      bootId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd' },
    work: {
      processActiveInvocations: 0, processActivePolls: 0, processActiveUsageSends: 0,
      effectPermits: { prepared: 0, active: 0, settling: 0, unknown: 0 },
      unclosedEffectPermits: 0, unresolvedInvocationHolds: 2, unknownUsageDeliveries: 0,
    },
    observedAt: at, workObservedAt: at,
  } as const;
}

function artifactObservation(): BackupArtifactEffectObservation {
  return {
    observedAt: timestamp, workObservedAt: timestamp,
    owner: { runtimeIdentity: execution.ownerRuntimeIdentity, bootId },
    processActiveEffects: 0, preparedEffects: 0, activeEffects: 0, settlingEffects: 0,
    unclosedEffects: 0, unresolvedCapabilities: 0, unknownEffects: 0,
  };
}

function harness(options: { staleIdentity?: string; futureIdentity?: string; missingAckIdentity?: string; foreignOpenWork?: number } = {}) {
  let clock = Date.parse(timestamp);
  let gate: Record<string, unknown> = {
    state: 'OPEN', fence_id: null, fence_revision: 0, backup_id: null,
    maintenance_job_id: null, owner_item_id: null, owner_runtime_identity: null,
    owner_boot_id: null, owner_execution_fence: null, execution_token_sha256: null,
    prior_control_states: {},
  };
  const stages = new Map<string, Record<string, unknown>>();
  const held = new Map<string, string>();
  const ownerTokenHash = sha(execution.executionToken);
  const pendingByIdentity = new Map<string, number>();
  let foreign = options.foreignOpenWork ?? 0;

  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    if (sql.includes('SELECT 1 FROM maintenance_job_items')) return { rows: [{}], rowCount: 1 };
    if (sql.includes('FROM maintenance_backup_effect_gate')) return { rows: [gate], rowCount: 1 };
    if (sql.includes('FROM maintenance_backup_connector_fences WHERE fence_id=$1 AND replica_id=$2')) {
      const stage = stages.get(String(params[1]));
      return { rows: stage ? [stage] : [], rowCount: stage ? 1 : 0 };
    }
    if (sql.includes('AS own_backup')) return { rows: [{ count: String(1 + foreign), own_backup: '1' }], rowCount: 1 };
    if (sql.includes('SELECT ((SELECT count(*) FROM maintenance_job_items')) {
      return { rows: [{ count: String(pendingByIdentity.get(String(params[0])) ?? 0) }], rowCount: 1 };
    }
    if (sql.includes('SELECT count(*)::text AS count FROM maintenance_job_items')) {
      return { rows: [{ count: '1' }], rowCount: 1 };
    }
    if (sql.includes('INSERT INTO maintenance_backup_connector_fences')) {
      const [fenceId, storedBackupId, slot, serviceId, replicaId, runtimeIdentity, revision, imageDigest,
        expectedFenceRevision, fenceRevision, jobId, itemId, executionFence, ownerRuntimeIdentity, ownerBootId,
        executionTokenSha256] = params;
      const row = { fence_id: fenceId, backup_id: storedBackupId, slot, service_id: serviceId, replica_id: replicaId,
        runtime_identity: runtimeIdentity, runtime_revision: revision, image_digest: imageDigest,
        expected_fence_revision: expectedFenceRevision, fence_revision: fenceRevision, maintenance_job_id: jobId,
        maintenance_item_id: itemId, maintenance_execution_fence: executionFence,
        owner_runtime_identity: ownerRuntimeIdentity, owner_boot_id: ownerBootId, execution_token_sha256: executionTokenSha256,
        state: 'PREPARED', remote_boot_id: null, acknowledged_at: null, observed_at: null, work_observed_at: null, work_counts: null };
      stages.set(String(replicaId), row);
      return { rows: [row], rowCount: 1 };
    }
    if (sql.includes('UPDATE maintenance_backup_connector_fences')) {
      const row = stages.get(String(params[1]));
      if (row) {
        row.state = params[2] ?? row.state;
        row.remote_boot_id = params[3]; row.acknowledged_at = params[4]; row.observed_at = params[5];
        row.work_observed_at = params[6]; row.work_counts = params[7];
      }
      return { rows: [], rowCount: row ? 1 : 0 };
    }
    throw new Error(`unexpected backup fence query: ${sql.slice(0, 100)}`);
  });
  const db = {
    query,
    tx: async <T>(callback: (client: { query: typeof query }) => Promise<T>) => callback({ query }),
    close: async () => undefined,
    pool: {} as never,
  } as unknown as Db;
  const snapshotFence = {
    hold: jest.fn(async (input: { fenceId: string; backupId: string }) => {
      gate = { ...gate, state: 'HELD', fence_id: input.fenceId, fence_revision: 1, backup_id: input.backupId,
        maintenance_job_id: execution.jobId, owner_item_id: execution.itemId,
        owner_runtime_identity: execution.ownerRuntimeIdentity, owner_boot_id: execution.ownerBootId,
        owner_execution_fence: execution.executionFence, execution_token_sha256: ownerTokenHash };
      return { fenceId: input.fenceId, fenceRevision: 1, state: 'HELD' as const };
    }),
    release: jest.fn(async () => undefined),
  };
  const control: ConnectorBackupEffectControl = {
    observe: jest.fn(async (target, request) => {
      const activeFenceId = held.get(target.replicaId);
      return activeFenceId
        ? connectorObservation(target, 'HELD', activeFenceId, request.expectedFenceRevision)
        : connectorObservation(target, 'OPEN', null, 0);
    }),
    hold: jest.fn(async (target, command) => {
      held.set(target.replicaId, command.fenceId);
      return connectorObservation(target, 'HELD', command.fenceId, command.fenceRevision);
    }),
    release: jest.fn(async () => undefined),
  };
  const runtimeSafety = {
    observe: jest.fn(async (input) => {
      const pin = pins.find((candidate) => candidate.service === input.service && candidate.slot === input.slot)!;
      const observedAt = pin.runtimeIdentity === options.staleIdentity ? '2026-10-12T05:59:00.000Z'
        : pin.runtimeIdentity === options.futureIdentity ? '2026-10-12T06:00:20.000Z' : new Date(clock).toISOString();
      return {
        service: pin.service, slot: pin.slot, runtimeIdentity: pin.runtimeIdentity, replicaId: pin.replicaId,
        revision: pin.revision, imageDigest: pin.imageDigest, bootId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        readiness: 'DRAINING', observedAt, workObservedAt: observedAt, controlRevision: 4, controlState: 'DRAINING',
        controlAcknowledgedAt: pin.runtimeIdentity === options.missingAckIdentity ? null : observedAt,
        controlAcknowledgedBootId: 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee',
        backupEffectFence: pin.service === 'worker' ? { revision: 1, acknowledgedAt: observedAt } : undefined,
        work: workFor(pin.service),
      } as ReplicaRuntimeObservation;
    }),
  };
  const artifactEffects = { observe: jest.fn(async () => ({ ...artifactObservation(),
    observedAt: new Date(clock).toISOString(), workObservedAt: new Date(clock).toISOString() })) } as unknown as BackupArtifactEffectPort;
  const fence = createMaintenanceBackupFence({
    db, snapshotFence: snapshotFence as never, artifactEffects, runtimeSafety: runtimeSafety as never, replicaPins: pins,
    connectorControl: control, now: () => new Date(clock), sleep: async (milliseconds) => { clock += Math.max(1, milliseconds); },
    maxWaitMs: 1, sampleIntervalMs: 2, freshnessMs: 10_000,
  });
  return { fence, query, snapshotFence, runtimeSafety, control, setForeign(value: number) { foreign = value; } };
}

describe('ORV15 independent Host backup-fence behavior', () => {
  it('collects six fresh DRAINING observations, holds both Connector pins, and excludes only the exact live backup claim', async () => {
    const state = harness();
    const result = await state.fence.acquire({ backupId, execution, reason: 'durable-platform-backup' });

    expect(state.runtimeSafety.observe).toHaveBeenCalledTimes(12); // initial pins plus one quiescence sample
    expect(state.control.hold).toHaveBeenCalledTimes(2);
    expect(result.proof.evidence.replicaObservations).toHaveLength(6);
    expect(result.proof.evidence.replicaObservations.every((row) => row.readiness === 'DRAINING' && row.controlState === 'DRAINING')).toBe(true);
    expect(result.proof.orchestratorDispatch.inFlight).toBe(0);
    expect(result.proof.admission.inFlight).toBe(0);
    expect(result.proof.evidence.execution).toMatchObject({ jobId: execution.jobId, itemId: execution.itemId,
      ownerRuntimeIdentity: execution.ownerRuntimeIdentity, ownerBootId: execution.ownerBootId, executionFence: execution.executionFence });
    expect(state.snapshotFence.hold).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['stale', 'orchestrator-blue'],
    ['future', 'worker-green'],
  ] as const)('refuses a %s timestamp from one of the six pinned runtimes before holding the global fence', async (_kind, runtimeIdentity) => {
    const state = harness(_kind === 'stale' ? { staleIdentity: runtimeIdentity } : { futureIdentity: runtimeIdentity });
    await expect(state.fence.acquire({ backupId, execution, reason: 'durable-platform-backup' }))
      .rejects.toThrow('BACKUP_EFFECT_FENCE_UNAVAILABLE');
    expect(state.snapshotFence.hold).not.toHaveBeenCalled();
  });

  it('does not interpret a missing current-process control ACK as a fresh zero-work observation', async () => {
    const state = harness({ missingAckIdentity: 'connector-green' });
    await expect(state.fence.acquire({ backupId, execution, reason: 'durable-platform-backup' }))
      .rejects.toThrow('BACKUP_EFFECT_FENCE_UNAVAILABLE');
    expect(state.snapshotFence.hold).not.toHaveBeenCalled();
  });

  it('keeps another identity’s unresolved maintenance or rollout owner blocking after subtracting the exact own backup item', async () => {
    const state = harness({ foreignOpenWork: 1 });
    await expect(state.fence.acquire({ backupId, execution, reason: 'durable-platform-backup' }))
      .rejects.toThrow('BACKUP_EFFECT_FENCE_UNAVAILABLE');
    expect(state.snapshotFence.hold).toHaveBeenCalledTimes(1);
    expect(state.control.hold).toHaveBeenCalledTimes(2);
    // The own backup item is count 1 and is excluded; the independent unknown owner remains count 1.
    expect(state.query).toHaveBeenCalledWith(expect.stringContaining('AS own_backup'), expect.arrayContaining([
      execution.jobId, execution.itemId, execution.ownerRuntimeIdentity, execution.ownerBootId,
      execution.executionFence, sha(execution.executionToken),
    ]));
  });
});
