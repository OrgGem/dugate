import { createConnectorReplicaRuntimeSafetySource, createFixedIngressReplicaProbe } from '../src/modules/maintenance/connector-runtime-safety';
import { createOrchestratorHttpReplicaSafetySource } from '../src/modules/maintenance/orchestrator-runtime-safety';

const imageDigest = `registry.example/app@sha256:${'a'.repeat(64)}`;
const observedAt = '2026-10-11T23:30:00.000Z';

function connectorObservation(overrides: Record<string, unknown> = {}) {
  return {
    service: 'connector', slot: 'green', runtimeIdentity: 'connector-green', replicaId: 'connector-green',
    revision: 'release-2', imageDigest, readiness: 'DRAINING', observedAt, workObservedAt: observedAt,
    controlRevision: 7, controlState: 'DRAINING', controlAcknowledgedAt: null,
    work: {
      workerLeases: { applicable: false, count: null }, sdkActiveTasks: { applicable: false, count: null },
      connectorInvocations: { applicable: true, count: 0 }, orchestratorRequests: { applicable: false, count: null },
      dispatches: { applicable: false, count: null },
    },
    ...overrides,
  };
}

function response(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
}

type FetchCall = { url: Parameters<typeof fetch>[0]; init?: Parameters<typeof fetch>[1] };

describe('ORV14 manifest-bound replica runtime safety adapters', () => {
  test('Connector direct control uses scoped signed identity and preserves a missing acknowledgement', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (url, init) => { calls.push({ url, init }); return response(connectorObservation()); };
    const authorizationForRequest = jest.fn((scope?: string) => `Bearer token-for-${scope}`);
    const source = createConnectorReplicaRuntimeSafetySource({
      targets: { green: { serviceId: 'connector-service', runtimeIdentity: 'connector-green', controlBaseUrl: 'http://connector-green:8080' } },
      authorizationForRequest,
      fetchImpl,
    });
    const observation = await source.observe({
      service: 'connector', slot: 'green', runtimeIdentity: 'connector-green', replicaId: 'connector-green',
      revision: 'release-2', imageDigest, scope: { kind: 'platform' },
    });
    expect(observation?.controlAcknowledgedAt).toBeNull();
    expect(observation?.work.connectorInvocations.count).toBe(0);
    expect(authorizationForRequest).toHaveBeenCalledWith('connector:runtime-control');
    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toBe('http://connector-green:8080/internal/admin/runtime-control/observe');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe('Bearer token-for-connector:runtime-control');
  });

  test('Connector observations from a different process identity are discarded', async () => {
    const fetchImpl: typeof fetch = async () => response(connectorObservation({ runtimeIdentity: 'connector-blue', replicaId: 'connector-blue' }));
    const source = createConnectorReplicaRuntimeSafetySource({
      targets: { green: { serviceId: 'connector-service', runtimeIdentity: 'connector-green', controlBaseUrl: 'http://connector-green:8080' } },
      authorizationForRequest: () => 'Bearer signed-test-token', fetchImpl,
    });
    const observation = await source.observe({
      service: 'connector', slot: 'green', runtimeIdentity: 'connector-green', replicaId: 'connector-green',
      revision: 'release-2', imageDigest, scope: { kind: 'platform' },
    });
    expect(observation).toBeNull();
  });

  test('Orchestrator direct-slot source accepts the real observation while an ACK is absent', async () => {
    const wire = {
      serviceRuntimeId: 'orch-green', runtimeIdentity: 'orch-green', replicaId: 'orch-green', slot: 'green',
      revision: 'release-2', imageDigest, service: 'orchestrator', bootId: '6bb5fd2a-b36a-4d1a-9b32-8a8c3561ec4f', readiness: 'DRAINING', observedAt,
      workObservedAt: observedAt, controlRevision: 8, controlState: 'DRAINING', controlAcknowledgedAt: null,
      dependencies: [
        { dependencyId: 'postgres', state: 'HEALTHY', observedAt },
        { dependencyId: 'redis', state: 'HEALTHY', observedAt },
      ],
      work: {
        workerLeases: { applicable: false, count: null }, sdkActiveTasks: { applicable: false, count: null },
        connectorInvocations: { applicable: false, count: null }, orchestratorRequests: { applicable: true, count: 0 },
        dispatches: { applicable: true, count: 0 }, maintenanceExecutions: { applicable: true, count: 0 },
      },
    };
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (url, init) => { calls.push({ url, init }); return response(wire); };
    const source = createOrchestratorHttpReplicaSafetySource({
      targets: { green: { serviceId: 'orchestrator-service', runtimeIdentity: 'orch-green', controlBaseUrl: 'http://orch-green:3002' } },
      controlToken: 'x'.repeat(32), fetchImpl,
    });
    const observation = await source.observe({
      service: 'orchestrator', slot: 'green', runtimeIdentity: 'orch-green', replicaId: 'orch-green',
      revision: 'release-2', imageDigest, scope: { kind: 'platform' },
    });
    expect(observation?.controlAcknowledgedAt).toBeNull();
    expect(observation?.bootId).toBe('6bb5fd2a-b36a-4d1a-9b32-8a8c3561ec4f');
    expect(observation?.work.maintenanceExecutions.count).toBe(0);
    expect(calls[0]?.url).toBe('http://orch-green:3002/api/internal/service-runtime/observation');
    expect(new Headers(calls[0]?.init?.headers).get('authorization')).toBe(`Bearer ${'x'.repeat(32)}`);
  });

  test('fixed-ingress probe reports process identity from the responder, never request fields', async () => {
    const calls: FetchCall[] = [];
    const fetchImpl: typeof fetch = async (url, init) => { calls.push({ url, init }); return response(connectorObservation()); };
    const probe = createFixedIngressReplicaProbe({
      controlTargets: { connector: { green: { serviceId: 'connector-service', runtimeIdentity: 'connector-green', controlBaseUrl: 'http://connector-green:8080' } } },
      ingressTargets: { connector: 'http://connector-ingress/internal/admin/runtime-control/observe' },
      connectorAuthorizationForRequest: () => 'Bearer signed-test-token', fetchImpl,
      now: () => new Date(observedAt),
    });
    const result = await probe({
      service: 'connector', scope: { kind: 'platform' }, expectedSlot: 'green', expectedRuntimeIdentity: 'connector-green',
      expectedReplicaId: 'connector-green', expectedRevision: 'release-2', expectedImageDigest: imageDigest,
    });
    expect(result).toMatchObject({
      statusCode: 200, servedService: 'connector', servedSlot: 'green', servedRuntimeIdentity: 'connector-green',
      servedReplicaId: 'connector-green', servedRevision: 'release-2', servedImageDigest: imageDigest, observedAt,
    });
    const sent = JSON.parse(String(calls[0]?.init?.body));
    expect(sent.runtimeIdentity).toBe('connector-green');
    expect(calls[0]?.url).toBe('http://connector-ingress/internal/admin/runtime-control/observe');
  });
});
