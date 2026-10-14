import { createHash } from 'node:crypto';
import {
  createTrustedIsolatedRestoreProbe,
  type OwnedRestoreRuntimeHandle,
  type RestoreRuntimeHealthPort,
  type RestoreRuntimeLaunchPlan,
  type SourceIsolationObservation,
  type TrustedIsolatedRestoreProbeOptions,
} from '../src/modules/maintenance/trusted-isolated-restore-probe';
import type { IsolatedRestoreRuntimeProbe } from '../src/modules/maintenance/trusted-backup-adapter';

type ProbeInput = Parameters<IsolatedRestoreRuntimeProbe['run']>[0];

const observedAt = '2026-10-12T02:00:00.000Z';
const targetGenerationId = '33333333-3333-4333-8333-333333333333';
const artifactId = '44444444-4444-4444-8444-444444444444';
const tenantId = '55555555-5555-4555-8555-555555555555';
const uploadToken = '66666666-6666-4666-8666-666666666666';
const plaintext = Buffer.from('restored-artifact-body');
const h = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');

const expectedCounts: ProbeInput['expectedCounts'] = {
  operations: 1,
  artifacts: 1,
  readyArtifacts: 1,
  secretRevisions: 1,
  storageGenerations: 1,
  secretCatalogImports: 0,
  connectorSecretImports: 0,
  globalSettingsRevisions: 0,
  retentionRevisions: 0,
  budgetRevisions: 0,
  priceRevisions: 0,
  reservationGroups: 0,
  budgetHolds: 0,
  financialAdjustments: 0,
  financialAdjustmentHeads: 0,
  financialAdjustmentCommands: 0,
  connectorInvocations: 1,
  connectorUsageEvents: 1,
  connectorSecretVersions: 1,
  connectorRevisions: 1,
  connectorRuntimeControls: 1,
  connectorParityChains: 0,
  connectorParityRevisions: 0,
  connectorParityClaimIntents: 0,
  connectorParityDraftIntents: 0,
  artifactObjectBytes: plaintext.byteLength,
  artifactManifestBytes: 0,
};

const input: ProbeInput = {
  backupId: 'backup-fixture',
  orchestratorDatabase: 'du_restore_orch_fixture',
  connectorDatabase: 'du_restore_connector_fixture',
  orchestratorClusterName: 'orchestrator-isolated',
  connectorClusterName: 'connector-isolated',
  targetGenerationId,
  sourceRuntimeIdentities: ['orchestrator-source', 'connector-source'],
  expectedRuntime: {
    orchestratorRuntimeIdentity: 'orchestrator-isolated-runtime',
    orchestratorSlot: 'green',
    orchestratorRevision: 'build-2026-10-12',
    orchestratorImageDigest: `orchestrator@sha256:${'a'.repeat(64)}`,
    connectorRuntimeIdentity: 'connector-isolated-runtime',
    connectorReplicaId: 'connector-isolated-replica',
    connectorSlot: 'green',
    connectorRevision: 'build-2026-10-12',
    connectorImageDigest: `connector@sha256:${'b'.repeat(64)}`,
  },
  expectedCounts,
  expectedArtifactTransitKeyPins: [{ keyRef: 'artifact-transit/key-a', keyVersion: 2 }],
  expectedSecretCatalogRecoveryKeys: [{ keyVersion: 'catalog-v2', fingerprintSha256: 'c'.repeat(64) }],
  expectedSecretCatalogKeyCounts: [{ keyVersion: 'catalog-v2', revisionCount: 1, currentSecretCount: 1 }],
  expectedConnectorInvocationRecoveryKeys: [{ keyRef: 'connector-invocation/key-a', keyVersion: 4, fingerprintSha256: 'd'.repeat(64) }],
  expectedConnectorInvocationKeyCounts: [{ keyRef: 'connector-invocation/key-a', keyVersion: 4, envelopeCount: 1 }],
  expectedConnectorCredentialKey: { keyVersion: 'connector-legacy-v1', fingerprintSha256: 'e'.repeat(64) },
  expectedConnectorSecretVersionCount: 1,
  expectedConnectorTypedCredentialCount: 0,
  expectedMetadataTransitKeyCounts: [{ keyRef: 'metadata-transit/key-a', keyVersion: 3, envelopeCount: 1 }],
  expectedVaultCredentialPinDigests: ['f'.repeat(64)],
  services: {
    orchestrator: 'service=orchestrator-restore-admin dbname=du_restore_orch_fixture',
    connector: 'service=connector-restore-admin dbname=du_restore_connector_fixture',
  },
  dispatchDisabled: true,
  providerCallsDisabled: true,
  usageDeliveryDisabled: true,
};

function health(kind: 'orchestrator' | 'connector', activePolls = 0, at = observedAt): Awaited<ReturnType<RestoreRuntimeHealthPort['observeOrchestrator']>> {
  const isOrchestrator = kind === 'orchestrator';
  return {
    observedAt: at,
    workObservedAt: at,
    readiness: 'DRAINING',
    liveness: 'LIVE',
    livenessObservedAt: at,
    dependencies: {
      postgres: { state: 'HEALTHY', observedAt: at },
      redis: { state: 'HEALTHY', observedAt: at },
    },
    clusterName: isOrchestrator ? input.orchestratorClusterName : input.connectorClusterName,
    runtimeIdentity: isOrchestrator ? input.expectedRuntime.orchestratorRuntimeIdentity : input.expectedRuntime.connectorRuntimeIdentity,
    revision: isOrchestrator ? input.expectedRuntime.orchestratorRevision : input.expectedRuntime.connectorRevision,
    imageDigest: isOrchestrator ? input.expectedRuntime.orchestratorImageDigest : input.expectedRuntime.connectorImageDigest,
    bootId: `${kind}-boot-20261012`,
    control: { state: 'DRAINING', revision: 7, acknowledgedAt: at, bootId: `${kind}-boot-20261012` },
    externalEffects: {
      admission: 'DISABLED', dispatch: 'DISABLED', providerInvocation: 'DISABLED', connectorPoll: 'DISABLED',
      usageDelivery: 'DISABLED', webhookDelivery: 'DISABLED', alertEmission: 'DISABLED', cleanup: 'DISABLED',
      historicalMaintenance: 'DISABLED', migrations: 'DISABLED',
    },
    work: isOrchestrator
      ? { activeRequests: 0, activeDispatches: 0, maintenanceExecutions: 0,
        processActiveInvocations: 0, processActivePolls: 0, processActiveUsageSends: 0,
        unresolvedInvocationHolds: 0, unclosedEffectPermits: 0, unknownUsageDeliveries: 0 }
      : { activeRequests: 0, activeDispatches: 0, maintenanceExecutions: 0,
        processActiveInvocations: 0, processActivePolls: activePolls, processActiveUsageSends: 0,
        unresolvedInvocationHolds: 1, effectPermits: { prepared: 0, active: 0, settling: 0, unknown: 2 },
        unclosedEffectPermits: 2, unknownUsageDeliveries: 3 },
    ...(isOrchestrator
      ? { slot: input.expectedRuntime.orchestratorSlot }
      : { replicaId: input.expectedRuntime.connectorReplicaId, slot: 'green' as const }),
  };
}

function sourceDenied(handle: OwnedRestoreRuntimeHandle, destinationRef: SourceIsolationObservation['destinationRef'], at = observedAt) {
  return {
    observedAt: at,
    contextRuntimeIdentity: handle.kind === 'orchestrator'
      ? input.expectedRuntime.orchestratorRuntimeIdentity : input.expectedRuntime.connectorRuntimeIdentity,
    contextBootId: `${handle.kind}-boot-20261012`,
    destinationRef,
    outcome: 'BLOCKED_BY_POLICY' as const,
    responseStatus: null,
    networkPolicyState: 'ENFORCED' as const,
    networkPolicyRevision: 'a'.repeat(64),
  };
}

function fixturePorts(fixtureOptions: {
  sourceObservation?: SourceIsolationObservation;
  activePolls?: number;
  delayedRecoveryMs?: number;
  neverResolvingArtifactIterator?: boolean;
  neverStopping?: boolean;
} = {}) {
  let clockMs = Date.parse(observedAt);
  const timestamp = () => new Date(clockMs).toISOString();
  const plans: RestoreRuntimeLaunchPlan[] = [];
  const stopped: string[] = [];
  const sourceContexts: string[] = [];
  let iteratorReturns = 0;
  let stopAbortObserved = false;
  const handles: Record<'orchestrator' | 'connector', OwnedRestoreRuntimeHandle> = {
    orchestrator: { kind: 'orchestrator', handleId: 'orchestrator-handle' },
    connector: { kind: 'connector', handleId: 'connector-handle' },
  };
  const ports: TrustedIsolatedRestoreProbeOptions = {
    now: () => new Date(clockMs),
    launch: {
      async start(plan) { plans.push(plan); return handles[plan.kind]; },
      async stopAndWait(handle, { signal }) {
        stopped.push(handle.kind);
        if (fixtureOptions.neverStopping && handle.kind === 'connector') await new Promise<void>((_resolve, reject) => {
          signal.addEventListener('abort', () => { stopAbortObserved = true; reject(new Error('stop aborted')); }, { once: true });
        });
      },
    },
    health: {
      async observeOrchestrator() { return health('orchestrator', 0, timestamp()); },
      async observeConnector() { return health('connector', fixtureOptions.activePolls, timestamp()); },
    },
    control: {
      async readOrchestrator() {
        return { observedAt: timestamp(), clusterName: input.orchestratorClusterName, desiredState: 'DRAINING', revision: 7,
          acknowledgedState: 'DRAINING', acknowledgedRevision: 7, acknowledgedAt: timestamp(),
          acknowledgedBootId: 'orchestrator-boot-20261012' };
      },
      async readConnector() {
        return { observedAt: timestamp(), clusterName: input.connectorClusterName, desiredState: 'DRAINING', revision: 7,
          acknowledgedState: 'DRAINING', acknowledgedRevision: 7, acknowledgedAt: timestamp(),
          acknowledgedBootId: 'connector-boot-20261012' };
      },
    },
    sourceIsolation: {
      async probeFromRuntime(handle, destinationRef) {
        sourceContexts.push(`${handle.kind}:${destinationRef}`);
        return fixtureOptions.sourceObservation ?? sourceDenied(handle, destinationRef, timestamp());
      },
    },
    databaseReader: {
      async readCounts() { return { observedAt: timestamp(), counts: expectedCounts }; },
    },
    applicationReader: {
      async exerciseLoginAndHistory() {
        return { observedAt: timestamp(), login: { statusCode: 200, authenticatedPrincipalSha256: '1'.repeat(64) },
          history: { statusCode: 200, totalRecords: 1,
            returnedRecords: [{ operationIdSha256: '2'.repeat(64), state: 'SUCCEEDED', hasResult: true, resultSha256: '3'.repeat(64) }] } };
      },
      async selectArtifactForDownload(_handle, items) { return items[0]!; },
      async downloadArtifact() {
        return { statusCode: 200, storageGenerationId: targetGenerationId, storageVersionId: 'object-v3',
          manifestVersionId: null, contentType: 'application/pdf', body: [plaintext] };
      },
    },
    recoveryReader: {
      async recoverArtifactTransitKey({ pin }) {
        if (fixtureOptions.delayedRecoveryMs) clockMs += fixtureOptions.delayedRecoveryMs;
        const items = fixtureOptions.neverResolvingArtifactIterator
          ? { [Symbol.asyncIterator]() { return { next: () => new Promise<never>(() => {}),
            return: async () => { iteratorReturns += 1; return { done: true, value: undefined } as IteratorReturnResult<never>; } }; } }
          : [{ artifactId, tenantId, uploadToken, apiKeyIdSha256: h('verified-api-key-id'),
            storageGenerationId: targetGenerationId, storageVersionId: 'object-v3',
            manifestVersionId: null, keyRef: pin.keyRef, keyVersion: pin.keyVersion, contentType: 'application/pdf',
            ciphertextSha256: '4'.repeat(64), ciphertextByteSize: 64,
            plaintextSha256: h(plaintext), plaintextByteSize: plaintext.byteLength,
            sidecarCiphertextSha256: null, sidecarPlaintextSha256: null }];
        return { key: { keyRef: pin.keyRef, keyVersion: pin.keyVersion, fingerprintSha256: '3'.repeat(64),
          registryIdentity: 'independent-key-registry', observedAt: timestamp() }, items };
      },
      async recoverSecretCatalogKey({ pin }) {
        return { key: { keyVersion: pin.keyVersion, fingerprintSha256: pin.fingerprintSha256,
          registryIdentity: 'independent-catalog-registry', observedAt: timestamp() },
          items: [
            { recordIdSha256: '5'.repeat(64), keyVersion: pin.keyVersion, recordKind: 'revision',
              ciphertextSha256: '6'.repeat(64), plaintextSha256: '7'.repeat(64) },
            { recordIdSha256: '8'.repeat(64), keyVersion: pin.keyVersion, recordKind: 'currentSecret',
              ciphertextSha256: '9'.repeat(64), plaintextSha256: 'a'.repeat(64) },
          ] };
      },
      async recoverConnectorInvocationKey({ pin }) {
        return { key: { keyRef: pin.keyRef, keyVersion: pin.keyVersion, fingerprintSha256: pin.fingerprintSha256,
          registryIdentity: 'independent-connector-registry', observedAt: timestamp() },
          items: [{ envelopeIdSha256: 'b'.repeat(64), keyRef: pin.keyRef, keyVersion: pin.keyVersion,
            ciphertextSha256: 'c'.repeat(64), plaintextSha256: 'd'.repeat(64) }] };
      },
      async recoverConnectorCredentialKey({ pin }) {
        return { key: { keyVersion: pin.keyVersion, fingerprintSha256: pin.fingerprintSha256,
          registryIdentity: 'independent-connector-registry', observedAt: timestamp() },
          items: [{ recordKind: 'legacy-secret-version' as const, secretVersionIdSha256: 'e'.repeat(64), keyVersion: pin.keyVersion,
            ciphertextSha256: 'f'.repeat(64), plaintextSha256: '0'.repeat(64) }] };
      },
      async recoverMetadataTransitKey({ pin }) {
        return { key: { keyRef: pin.keyRef, keyVersion: pin.keyVersion, fingerprintSha256: '1'.repeat(64),
          registryIdentity: 'independent-metadata-registry', observedAt: timestamp() },
          items: [{ envelopeIdSha256: '2'.repeat(64), keyRef: pin.keyRef, keyVersion: pin.keyVersion,
            ciphertextSha256: '3'.repeat(64), plaintextSha256: '4'.repeat(64) }] };
      },
      async readVaultCredential({ pinSha256 }) {
        return { observedAt: timestamp(), pinSha256, requestedVersion: 3, observedVersion: 3, valueSha256: '5'.repeat(64) };
      },
    },
  };
  return { options: ports, plans, stopped, sourceContexts, timestamp: () => timestamp(),
    iteratorReturns: () => iteratorReturns, stopAbortObserved: () => stopAbortObserved };
}

describe('ORV14 trusted isolated restore probe owner port fixtures (not actual-runtime verification)', () => {
  test('launches both pinned targets with disabled effects, verifies live evidence, preserves historical holds, and cleans up', async () => {
    const fixture = fixturePorts();
    const result = await createTrustedIsolatedRestoreProbe(fixture.options).run(input);
    const evidence = result as unknown as {
      connector: {
        processActiveInvocations: number; processActivePolls: number; processActiveUsageSends: number;
        unresolvedInvocationHolds: number; effectPermits: { prepared: number; active: number; settling: number; unknown: number };
        unclosedEffectPermits: number; unknownUsageDeliveries: number;
      };
      checks: { externalEffects: Record<string, string> };
      applicationEvidence: { historyDigest: string; downloadedArtifactSha256: string };
    };

    expect(fixture.plans).toHaveLength(2);
    for (const plan of fixture.plans) {
      expect(plan.database.serviceName).toMatch(/restore-admin/);
      expect(plan.database.databaseName).toMatch(/^du_restore_/);
      expect(plan.externalEffects).toEqual({
        admission: 'DISABLED', dispatch: 'DISABLED', providerInvocation: 'DISABLED', connectorPoll: 'DISABLED',
        usageDelivery: 'DISABLED', webhookDelivery: 'DISABLED', alertEmission: 'DISABLED', cleanup: 'DISABLED',
        historicalMaintenance: 'DISABLED', migrations: 'DISABLED',
      });
      expect(plan.network.defaultEgress).toBe('DENY');
      expect(plan.network.blockedSourceRefs).toHaveLength(7);
    }
    expect(fixture.sourceContexts).toHaveLength(28);
    expect(evidence.connector.processActiveInvocations).toBe(0);
    expect(evidence.connector.processActivePolls).toBe(0);
    expect(evidence.connector.processActiveUsageSends).toBe(0);
    expect(evidence.connector.unresolvedInvocationHolds).toBe(1);
    expect(evidence.connector.effectPermits).toEqual({ prepared: 0, active: 0, settling: 0, unknown: 2 });
    expect(evidence.connector.unclosedEffectPermits).toBe(2);
    expect(evidence.connector.unknownUsageDeliveries).toBe(3);
    expect(evidence.checks.externalEffects).toEqual({
      admission: 'PASSED', dispatch: 'PASSED', providerInvocation: 'PASSED', connectorPoll: 'PASSED',
      usageDelivery: 'PASSED', webhookDelivery: 'PASSED', alertEmission: 'PASSED', cleanup: 'PASSED',
      historicalMaintenance: 'PASSED', migrations: 'PASSED',
    });
    expect(evidence.applicationEvidence.historyDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(evidence.applicationEvidence.downloadedArtifactSha256).toBe(h(plaintext));
    expect(fixture.stopped).toEqual(['connector', 'orchestrator']);
    expect(JSON.stringify(result)).not.toContain(plaintext.toString('utf8'));
    expect(JSON.stringify(result)).not.toContain(artifactId);
  });

  test('fails source isolation on an HTTP response and stops both exact owned processes', async () => {
    const fixture = fixturePorts({ sourceObservation: {
      ...sourceDenied({ kind: 'orchestrator', handleId: 'orchestrator-handle' }, 'orchestratorSourceDb'),
      outcome: 'HTTP_RESPONSE', responseStatus: 403,
    } });

    await expect(createTrustedIsolatedRestoreProbe(fixture.options).run(input)).rejects.toMatchObject({
      message: 'RESTORE_SOURCE_ISOLATION_UNVERIFIED',
    });
    expect(fixture.stopped).toEqual(['connector', 'orchestrator']);
  });

  test('fails when the live Connector process reports an active poll', async () => {
    const fixture = fixturePorts({ activePolls: 1 });

    await expect(createTrustedIsolatedRestoreProbe(fixture.options).run(input)).rejects.toMatchObject({
      message: 'RESTORE_RUNTIME_CONNECTOR_PROCESS_WORK_ACTIVE',
    });
    expect(fixture.stopped).toEqual(['connector', 'orchestrator']);
  });

  test('allows a slow authenticated recovery after 60 seconds when each observation was fresh at read time', async () => {
    const fixture = fixturePorts({ delayedRecoveryMs: 70_001 });
    const result = await createTrustedIsolatedRestoreProbe(fixture.options).run(input);
    const evidence = result as unknown as { probeElapsedMs: number; probeStartedAt: string; probeCompletedAt: string };

    expect(evidence.probeElapsedMs).toBeGreaterThan(60_000);
    expect(Date.parse(evidence.probeCompletedAt) - Date.parse(evidence.probeStartedAt)).toBeGreaterThan(60_000);
    expect(fixture.stopped).toEqual(['connector', 'orchestrator']);
  });

  test('aborts a stalled recovery iterator, closes it, and stops both owned processes', async () => {
    const fixture = fixturePorts({ neverResolvingArtifactIterator: true });
    const probe = createTrustedIsolatedRestoreProbe({ ...fixture.options, maxRuntimeMs: 1000 });

    await expect(probe.run(input)).rejects.toMatchObject({ message: 'RESTORE_RUNTIME_PROBE_TIMEOUT' });
    expect(fixture.iteratorReturns()).toBe(1);
    expect(fixture.stopped).toEqual(['connector', 'orchestrator']);
  });

  test('fails closed when an owned process stop does not finish before the bounded deadline', async () => {
    jest.useFakeTimers();
    try {
      const fixture = fixturePorts({ neverStopping: true });
      const running = createTrustedIsolatedRestoreProbe(fixture.options).run(input);
      const expectedCleanupFailure = expect(running).rejects.toMatchObject({ message: 'RESTORE_RUNTIME_PROBE_CLEANUP_FAILED' });
      for (let attempt = 0; attempt < 2000 && fixture.stopped.length === 0; attempt += 1) await Promise.resolve();
      expect(fixture.stopped).toEqual(['connector']);
      await jest.advanceTimersByTimeAsync(30_001);
      await expectedCleanupFailure;
      expect(fixture.stopAbortObserved()).toBe(true);
      expect(fixture.stopped).toEqual(['connector', 'orchestrator']);
    } finally {
      jest.useRealTimers();
    }
  });

  test('refuses to construct without every trusted launch and observation port', () => {
    expect(() => createTrustedIsolatedRestoreProbe(undefined as never)).toThrow('RESTORE_RUNTIME_PROBE_PORTS_REQUIRED');
  });
});
