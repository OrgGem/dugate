import type { ConnectorBackupEffectFenceObservation } from '@du/contracts';
import type { BackupArtifactEffectObservation } from '../src/modules/maintenance/backup-effect-fence';
import { backupExternalEffectsQuiescent } from '../src/modules/maintenance/backup-fence';

const connectorObservation = (overrides: Partial<ConnectorBackupEffectFenceObservation['work']> = {}): ConnectorBackupEffectFenceObservation => ({
  slot: 'blue', runtimeIdentity: 'connector-blue', replicaId: 'connector-blue', revision: 'r1',
  imageDigest: 'repo@sha256:' + 'a'.repeat(64),
  fence: { state: 'HELD', fenceId: '11111111-1111-4111-8111-111111111111', fenceRevision: 1,
    acknowledgedAt: '2026-10-12T00:00:00.000Z', bootId: '22222222-2222-4222-8222-222222222222' },
  work: {
    processActiveInvocations: 0, processActivePolls: 0, processActiveUsageSends: 0,
    effectPermits: { prepared: 0, active: 0, settling: 0, unknown: 0 },
    unclosedEffectPermits: 0, unresolvedInvocationHolds: 3, unknownUsageDeliveries: 0,
    ...overrides,
  },
  observedAt: '2026-10-12T00:00:00.000Z', workObservedAt: '2026-10-12T00:00:00.000Z',
});

const artifactObservation = (overrides: Partial<BackupArtifactEffectObservation> = {}): BackupArtifactEffectObservation => ({
  observedAt: '2026-10-12T00:00:00.000Z', workObservedAt: '2026-10-12T00:00:00.000Z',
  owner: { runtimeIdentity: 'orchestrator-blue', bootId: '33333333-3333-4333-8333-333333333333' },
  processActiveEffects: 0, preparedEffects: 0, activeEffects: 0, settlingEffects: 0,
  unclosedEffects: 0, unresolvedCapabilities: 1, unknownEffects: 0,
  ...overrides,
});

describe('ORV14 backup fence keeps uncertain external effects distinct from historical holds', () => {
  it('rejects an old-boot UNKNOWN Connector effect even when the live process has zero active work', () => {
    const first = connectorObservation({
      effectPermits: { prepared: 0, active: 0, settling: 0, unknown: 1 },
      unclosedEffectPermits: 1,
    });
    const second = connectorObservation();
    expect(backupExternalEffectsQuiescent([first, second], artifactObservation())).toBe(false);
  });

  it('rejects an UNKNOWN artifact effect even when current-process counters are zero', () => {
    expect(backupExternalEffectsQuiescent(
      [connectorObservation(), connectorObservation()],
      artifactObservation({ unknownEffects: 1, unclosedEffects: 1 }),
    )).toBe(false);
  });

  it('allows preserved unresolved invocation history when no effect permit remains open', () => {
    expect(backupExternalEffectsQuiescent(
      [connectorObservation(), connectorObservation()], artifactObservation(),
    )).toBe(true);
  });
});
