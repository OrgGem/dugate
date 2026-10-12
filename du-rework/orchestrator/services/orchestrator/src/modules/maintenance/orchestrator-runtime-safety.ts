import {
  OrchestratorServiceRuntimeControlAckSchema,
  OrchestratorServiceRuntimeObservationSchema,
} from '@du/contracts';
import type { ReplicaRuntimeObservation, ReplicaRuntimeSafetySource } from './replica-runtime-safety';

type Slot = 'blue' | 'green';
type Target = { serviceId: string; runtimeIdentity: string; controlBaseUrl: string };
type Targets = Partial<Record<Slot, Target>>;
const REQUEST_TIMEOUT_MS = 5_000;
const MAX_RESPONSE_BYTES = 64 * 1024;

function unavailable(): Error { return new Error('REPLICA_RUNTIME_CONTROL_UNAVAILABLE'); }

async function readJson(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw unavailable();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE_BYTES) throw unavailable();
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try { return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown; }
  catch { throw unavailable(); }
}

function endpoint(base: string, suffix: 'observation' | 'drain' | 'resume'): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw unavailable();
  url.pathname = `/api/internal/service-runtime/${suffix}`;
  return url.toString();
}

async function call(input: { url: string; token: string; method: 'GET' | 'POST'; body?: unknown; fetchImpl: typeof fetch }): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  timer.unref?.();
  try {
    const response = await input.fetchImpl(input.url, {
      method: input.method,
      redirect: 'error',
      signal: controller.signal,
      headers: {
        authorization: `Bearer ${input.token}`,
        ...(input.body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      ...(input.body === undefined ? {} : { body: JSON.stringify(input.body) }),
    });
    return await readJson(response);
  } catch { throw unavailable(); }
  finally { clearTimeout(timer); }
}

export function createOrchestratorHttpReplicaSafetySource(input: {
  targets: Targets;
  controlToken: string;
  fetchImpl?: typeof fetch;
}): ReplicaRuntimeSafetySource {
  if (input.controlToken.length < 32) throw unavailable();
  const fetchImpl = input.fetchImpl ?? fetch;
  const targetFor = (slot: Slot, runtimeIdentity: string, replicaId: string): Target => {
    const target = input.targets[slot];
    if (!target || target.runtimeIdentity !== runtimeIdentity || replicaId !== runtimeIdentity) throw unavailable();
    return target;
  };
  return {
    async observe(request) {
      if (request.service !== 'orchestrator') throw unavailable();
      const target = targetFor(request.slot, request.runtimeIdentity, request.replicaId);
      const parsed = OrchestratorServiceRuntimeObservationSchema.safeParse(await call({
        url: endpoint(target.controlBaseUrl, 'observation'), token: input.controlToken, method: 'GET', fetchImpl,
      }));
      if (!parsed.success || parsed.data.service !== 'orchestrator'
        || parsed.data.slot !== request.slot || parsed.data.runtimeIdentity !== request.runtimeIdentity
        || parsed.data.replicaId !== request.replicaId || parsed.data.revision !== request.revision
        || parsed.data.imageDigest !== request.imageDigest) return null;
      const value = parsed.data;
      return {
        service: 'orchestrator', slot: value.slot, runtimeIdentity: value.runtimeIdentity, replicaId: value.replicaId,
        revision: value.revision, imageDigest: value.imageDigest, bootId: value.bootId, readiness: value.readiness,
        observedAt: value.observedAt, workObservedAt: value.workObservedAt,
        controlRevision: value.controlRevision, controlState: value.controlState,
        controlAcknowledgedAt: value.controlAcknowledgedAt,
        work: value.work,
      } satisfies ReplicaRuntimeObservation;
    },
    async requestDrain(request) {
      if (request.service !== 'orchestrator') throw unavailable();
      const target = targetFor(request.slot, request.runtimeIdentity, request.replicaId);
      const parsed = OrchestratorServiceRuntimeControlAckSchema.safeParse(await call({
        url: endpoint(target.controlBaseUrl, 'drain'), token: input.controlToken, method: 'POST', fetchImpl,
        body: {
          serviceRuntimeId: request.runtimeIdentity, runtimeIdentity: request.runtimeIdentity,
          replicaId: request.replicaId, slot: request.slot, revision: request.expectedRevision,
          imageDigest: request.expectedImageDigest, expectedControlRevision: request.expectedControlRevision,
          action: 'drain', reason: 'maintenance-rollout',
        },
      }));
      if (!parsed.success) throw unavailable();
      return parsed.data;
    },
    async requestResume(request) {
      if (request.service !== 'orchestrator') throw unavailable();
      const target = targetFor(request.slot, request.runtimeIdentity, request.replicaId);
      const parsed = OrchestratorServiceRuntimeControlAckSchema.safeParse(await call({
        url: endpoint(target.controlBaseUrl, 'resume'), token: input.controlToken, method: 'POST', fetchImpl,
        body: {
          serviceRuntimeId: request.runtimeIdentity, runtimeIdentity: request.runtimeIdentity,
          replicaId: request.replicaId, slot: request.slot, revision: request.expectedRevision,
          imageDigest: request.expectedImageDigest, expectedControlRevision: request.expectedControlRevision,
          action: 'resume', reason: 'maintenance-rollback',
        },
      }));
      if (!parsed.success) throw unavailable();
      return parsed.data;
    },
  };
}
