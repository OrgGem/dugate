import type { MaintenanceScope } from '@du/contracts';
import type { ReplicaObservation, ReplicaRolloutCapabilities, ReplicaRolloutObservationAdapter } from './maintenance-service';
import { isFreshObservation, sumAuthoritativeWork, type ReplicaRuntimeSafetyPort, type ReplicaRuntimeObservation } from './replica-runtime-safety';
import {
  readTrustedRolloutManifest,
  rolloutImageMatches,
  rolloutReleaseFor,
  rolloutSafeSlot,
  rolloutTargetFor,
  type TrustedRolloutManifest,
  type TrustedRolloutTarget,
  type TrustedRolloutSlot,
} from './trusted-rollout-manifest';

export interface TrustedManifestRolloutPreviewAdapterOptions {
  manifestPath: string;
  expectedManifestSha256: string;
  runtimeSafety: ReplicaRuntimeSafetyPort;
  now?: () => Date;
}

function manifestCapabilities(manifest: TrustedRolloutManifest): ReplicaRolloutCapabilities {
  const services = manifest.targets.map((target) => target.service);
  return {
    services,
    fixedIngressServices: manifest.targets
      .filter((target) => target.service !== 'worker')
      .map((target) => target.service as 'orchestrator' | 'connector'),
    workerReplacement: services.includes('worker'),
  };
}

/** Least-privileged manifest-backed view for web preview/status. This leaf
 * imports no child-process, Docker, reload, or command-runner implementation. */
export async function createTrustedManifestRolloutPreviewAdapter(
  options: TrustedManifestRolloutPreviewAdapterOptions,
): Promise<ReplicaRolloutObservationAdapter> {
  const manifest = await readTrustedRolloutManifest(options);
  const now = options.now ?? (() => new Date());

  async function observeReplica(target: TrustedRolloutTarget, slot: TrustedRolloutSlot, scope: MaintenanceScope): Promise<ReplicaObservation> {
    const config = target.slots[slot];
    let signal: ReplicaRuntimeObservation | null;
    try {
      signal = await options.runtimeSafety.observe({
        service: target.service,
        slot,
        runtimeIdentity: config.runtimeIdentity,
        replicaId: config.runtimeIdentity,
        revision: config.revision,
        imageDigest: config.imageDigest,
        scope,
      });
    } catch {
      signal = null;
    }
    const nowMs = now().getTime();
    const exactSignal = signal !== null
      && signal.service === target.service && signal.slot === slot
      && signal.runtimeIdentity === config.runtimeIdentity && signal.replicaId === config.runtimeIdentity
      && signal.revision === config.revision && rolloutImageMatches(signal.imageDigest, config.imageDigest)
      && isFreshObservation(signal.observedAt, nowMs, 30_000)
      && isFreshObservation(signal.workObservedAt, nowMs, 30_000)
      && isFreshObservation(signal.controlAcknowledgedAt, nowMs, 30_000);
    const activeWork = exactSignal ? sumAuthoritativeWork(target.service, signal!.work) : null;
    const ready = exactSignal && signal!.readiness === 'READY' && signal!.controlState === 'OPEN'
      && signal!.controlRevision >= 0 && activeWork !== null;
    const draining = exactSignal && signal!.controlState === 'DRAINING';
    return {
      replicaId: config.runtimeIdentity,
      slot,
      desiredRevision: config.revision,
      observedRevision: exactSignal ? signal!.revision : null,
      state: ready ? 'READY' : draining ? 'DRAINING' : 'UNKNOWN',
      activeWork,
      acknowledgedAt: exactSignal ? signal!.controlAcknowledgedAt : null,
      controlRevision: exactSignal ? signal!.controlRevision : null,
      controlState: exactSignal ? signal!.controlState : null,
      code: ready ? null : draining ? 'RUNTIME_DRAINING' : 'RUNTIME_EVIDENCE_STALE_OR_MISMATCHED',
    };
  }

  async function probeIngress(target: TrustedRolloutTarget, scope: MaintenanceScope): Promise<string | null> {
    if (target.service === 'worker' || !target.fixedIngressProbeUrl) return null;
    const matches: TrustedRolloutSlot[] = [];
    for (const slot of ['blue', 'green'] as const) {
      const config = target.slots[slot];
      try {
        const result = await options.runtimeSafety.probeFixedIngress({
          service: target.service,
          scope,
          expectedSlot: slot,
          expectedRuntimeIdentity: config.runtimeIdentity,
          expectedReplicaId: config.runtimeIdentity,
          expectedRevision: config.revision,
          expectedImageDigest: config.imageDigest,
        });
        const observedAt = Date.parse(result.observedAt);
        const nowMs = now().getTime();
        if (result.statusCode >= 200 && result.statusCode < 300
          && result.servedService === target.service && result.servedSlot === slot
          && result.servedRuntimeIdentity === config.runtimeIdentity && result.servedReplicaId === config.runtimeIdentity
          && result.servedRevision === config.revision && rolloutImageMatches(result.servedImageDigest ?? '', config.imageDigest)
          && Number.isFinite(observedAt) && observedAt <= nowMs && nowMs - observedAt <= 5_000) {
          matches.push(slot);
        }
      } catch {
        // Missing/ambiguous ingress evidence is represented as unknown.
      }
    }
    return matches.length === 1 ? matches[0]! : null;
  }

  return {
    trusted: true,
    async capabilities() { return manifestCapabilities(manifest); },
    async executorIdentityForSlot(input) {
      const target = rolloutTargetFor(manifest, input.service, { kind: 'platform' });
      const slot = rolloutSafeSlot(input.slot);
      rolloutReleaseFor(target, input.revision);
      return target.slots[slot].runtimeIdentity;
    },
    async observe(input) {
      const target = rolloutTargetFor(manifest, input.service, input.scope);
      const [replicas, ingressTarget] = await Promise.all([
        Promise.all((['blue', 'green'] as const).map((slot) => observeReplica(target, slot, input.scope))),
        probeIngress(target, input.scope),
      ]);
      return { replicas, ingressTarget, fixedIngress: target.service !== 'worker' && !!target.fixedIngressProbeUrl };
    },
  };
}
