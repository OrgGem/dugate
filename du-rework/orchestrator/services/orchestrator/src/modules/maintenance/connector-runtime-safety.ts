import {
  ConnectorReplicaControlAckSchema,
  ConnectorReplicaRuntimeObservationSchema,
  OrchestratorServiceRuntimeIdentitySchema,
  type ConnectorReplicaControlCommand,
} from '@du/contracts';
import type { ConnectorManagementAuthorizationProvider } from '../connectors/management-service-identity';
import type { ReplicaRuntimeObservation, ReplicaRuntimeSafetyPort, ReplicaRuntimeSafetySource } from './replica-runtime-safety';

type Slot = 'blue' | 'green';
type ConnectorTargets = Partial<Record<Slot, { serviceId: string; runtimeIdentity: string; controlBaseUrl: string }>>;
type ControlTargets = Partial<Record<'orchestrator' | 'connector' | 'worker', Partial<Record<Slot, { serviceId: string; runtimeIdentity: string; controlBaseUrl: string }>>>>;
type IngressTargets = Partial<Record<'orchestrator' | 'connector' | 'worker', string>>;

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 5_000;

function safeFailure(): Error {
  return new Error('REPLICA_RUNTIME_CONTROL_UNAVAILABLE');
}

async function jsonResponse(response: Response): Promise<unknown> {
  if (!response.ok || !response.body) throw safeFailure();
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) throw safeFailure();
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8')) as unknown;
  } catch {
    throw safeFailure();
  }
}

function endpoint(base: string, path: string): string {
  const url = new URL(base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw safeFailure();
  url.pathname = path;
  return url.toString();
}

function checkTarget(targets: ControlTargets, service: 'orchestrator' | 'connector', slot: Slot, input: {
  runtimeIdentity: string; replicaId: string; revision: string; imageDigest: string;
}): { serviceId: string; runtimeIdentity: string; controlBaseUrl: string } {
  const target = targets[service]?.[slot];
  if (!target || target.runtimeIdentity !== input.runtimeIdentity || input.replicaId !== input.runtimeIdentity) throw safeFailure();
  return target;
}

async function requestJson(input: {
  url: string;
  token: string;
  method: 'GET' | 'POST';
  body?: unknown;
  fetchImpl: typeof fetch;
}): Promise<unknown> {
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
    return await jsonResponse(response);
  } catch {
    throw safeFailure();
  } finally {
    clearTimeout(timer);
  }
}

function toReplicaObservation(value: ReturnType<typeof ConnectorReplicaRuntimeObservationSchema.parse>): ReplicaRuntimeObservation {
  return {
    service: 'connector', slot: value.slot, runtimeIdentity: value.runtimeIdentity, replicaId: value.replicaId,
    revision: value.revision, imageDigest: value.imageDigest, readiness: value.readiness,
    observedAt: value.observedAt, workObservedAt: value.workObservedAt,
    controlRevision: value.controlRevision, controlState: value.controlState,
    controlAcknowledgedAt: value.controlAcknowledgedAt,
    work: {
      ...value.work,
      maintenanceExecutions: { applicable: false, count: null },
    },
  };
}

function makeCommand(input: {
  slot: Slot; runtimeIdentity: string; replicaId: string; expectedRevision: string;
  expectedImageDigest: string; expectedControlRevision: number;
  reason: 'maintenance-rollout' | 'maintenance-rollback';
}): ConnectorReplicaControlCommand {
  return {
    slot: input.slot,
    runtimeIdentity: input.runtimeIdentity,
    replicaId: input.replicaId,
    revision: input.expectedRevision,
    imageDigest: input.expectedImageDigest,
    expectedRevision: input.expectedRevision,
    expectedImageDigest: input.expectedImageDigest,
    expectedControlRevision: input.expectedControlRevision,
    reason: input.reason,
  };
}

export function createConnectorReplicaRuntimeSafetySource(input: {
  targets: ConnectorTargets;
  authorizationForRequest: ConnectorManagementAuthorizationProvider;
  fetchImpl?: typeof fetch;
}): ReplicaRuntimeSafetySource {
  const fetchImpl = input.fetchImpl ?? fetch;
  const token = () => {
    try {
      const value = input.authorizationForRequest('connector:runtime-control');
      if (!value.startsWith('Bearer ') || value.length <= 7) throw safeFailure();
      return value.slice(7);
    }
    catch { throw safeFailure(); }
  };
  async function post(path: string, baseUrl: string, body: unknown): Promise<unknown> {
    return requestJson({ url: endpoint(baseUrl, path), token: token(), method: 'POST', body, fetchImpl });
  }
  return {
    async observe(request) {
      if (request.service !== 'connector') throw safeFailure();
      const target = input.targets[request.slot];
      if (!target || target.runtimeIdentity !== request.runtimeIdentity || request.replicaId !== request.runtimeIdentity) throw safeFailure();
      const parsed = ConnectorReplicaRuntimeObservationSchema.safeParse(await post('/internal/admin/runtime-control/observe', target.controlBaseUrl, {
        slot: request.slot,
        runtimeIdentity: request.runtimeIdentity,
        replicaId: request.replicaId,
        revision: request.revision,
        imageDigest: request.imageDigest,
      }));
      if (!parsed.success || parsed.data.service !== 'connector'
        || parsed.data.slot !== request.slot || parsed.data.runtimeIdentity !== request.runtimeIdentity
        || parsed.data.replicaId !== request.replicaId || parsed.data.revision !== request.revision
        || parsed.data.imageDigest !== request.imageDigest) return null;
      return toReplicaObservation(parsed.data);
    },
    async requestDrain(request) {
      if (request.service !== 'connector') throw safeFailure();
      const target = input.targets[request.slot];
      if (!target || target.runtimeIdentity !== request.runtimeIdentity || request.replicaId !== request.runtimeIdentity) throw safeFailure();
      const parsed = ConnectorReplicaControlAckSchema.safeParse(await post('/internal/admin/runtime-control/drain', target.controlBaseUrl, makeCommand({
        slot: request.slot, runtimeIdentity: request.runtimeIdentity, replicaId: request.replicaId,
        expectedRevision: request.expectedRevision, expectedImageDigest: request.expectedImageDigest,
        expectedControlRevision: request.expectedControlRevision, reason: 'maintenance-rollout',
      })));
      if (!parsed.success) throw safeFailure();
      return parsed.data;
    },
    async requestResume(request) {
      if (request.service !== 'connector') throw safeFailure();
      const target = input.targets[request.slot];
      if (!target || target.runtimeIdentity !== request.runtimeIdentity || request.replicaId !== request.runtimeIdentity) throw safeFailure();
      const parsed = ConnectorReplicaControlAckSchema.safeParse(await post('/internal/admin/runtime-control/resume', target.controlBaseUrl, makeCommand({
        slot: request.slot, runtimeIdentity: request.runtimeIdentity, replicaId: request.replicaId,
        expectedRevision: request.expectedRevision, expectedImageDigest: request.expectedImageDigest,
        expectedControlRevision: request.expectedControlRevision, reason: 'maintenance-rollback',
      })));
      if (!parsed.success) throw safeFailure();
      return parsed.data;
    },
  };
}

/** Authenticated fixed-ingress probe. A request's expected identity is used
 * only to choose the manifest-pinned endpoint and verify the actual response;
 * the serving process supplies every returned identity/build field. */
export function createFixedIngressReplicaProbe(input: {
  controlTargets: ControlTargets;
  ingressTargets: IngressTargets;
  orchestratorControlToken?: string;
  connectorAuthorizationForRequest?: ConnectorManagementAuthorizationProvider;
  fetchImpl?: typeof fetch;
  now?: () => Date;
}): ReplicaRuntimeSafetyPort['probeFixedIngress'] {
  const fetchImpl = input.fetchImpl ?? fetch;
  const now = input.now ?? (() => new Date());
  return async (request) => {
    const url = input.ingressTargets[request.service];
    if (!url || request.service === 'worker') throw safeFailure();
    const target = checkTarget(input.controlTargets, request.service, request.expectedSlot, {
      runtimeIdentity: request.expectedRuntimeIdentity, replicaId: request.expectedReplicaId,
      revision: request.expectedRevision, imageDigest: request.expectedImageDigest,
    });
    let wire: unknown;
    if (request.service === 'orchestrator') {
      if (!input.orchestratorControlToken) throw safeFailure();
      wire = await requestJson({ url, token: input.orchestratorControlToken, method: 'GET', fetchImpl });
    } else {
      if (!input.connectorAuthorizationForRequest) throw safeFailure();
      const authorization = input.connectorAuthorizationForRequest('connector:runtime-control');
      if (!authorization.startsWith('Bearer ') || authorization.length <= 7) throw safeFailure();
      wire = await requestJson({ url, token: authorization.slice(7), method: 'POST', fetchImpl,
        body: {
          slot: request.expectedSlot, runtimeIdentity: target.runtimeIdentity, replicaId: request.expectedReplicaId,
          revision: request.expectedRevision, imageDigest: request.expectedImageDigest,
        },
      });
    }
    let served: { service: 'orchestrator' | 'connector'; slot: Slot; runtimeIdentity: string; replicaId: string; revision: string; imageDigest: string } | null = null;
    if (request.service === 'orchestrator') {
      const raw = wire as Record<string, unknown>;
      const identity = OrchestratorServiceRuntimeIdentitySchema.safeParse({
        serviceRuntimeId: raw?.['serviceRuntimeId'], runtimeIdentity: raw?.['runtimeIdentity'], replicaId: raw?.['replicaId'],
        slot: raw?.['slot'], revision: raw?.['revision'], imageDigest: raw?.['imageDigest'],
      });
      if (raw?.['service'] === 'orchestrator' && identity.success) {
        served = { service: 'orchestrator', ...identity.data };
      }
    } else {
      const observation = ConnectorReplicaRuntimeObservationSchema.safeParse(wire);
      if (observation.success) {
        served = {
          service: 'connector', slot: observation.data.slot, runtimeIdentity: observation.data.runtimeIdentity,
          replicaId: observation.data.replicaId, revision: observation.data.revision, imageDigest: observation.data.imageDigest,
        };
      }
    }
    const observedAt = now();
    if (!Number.isFinite(observedAt.getTime())) throw safeFailure();
    return {
      statusCode: served ? 200 : 503,
      servedService: served?.service ?? null,
      servedSlot: served?.slot ?? null,
      servedRuntimeIdentity: served?.runtimeIdentity ?? null,
      servedReplicaId: served?.replicaId ?? null,
      servedRevision: served?.revision ?? null,
      servedImageDigest: served?.imageDigest ?? null,
      observedAt: observedAt.toISOString(),
    };
  };
}
