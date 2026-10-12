import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createTrustedManifestRolloutPreviewAdapter } from '../src/modules/maintenance/trusted-manifest-rollout-observer';
import { createReplicaRolloutService } from '../src/modules/maintenance/rollouts';

const rootOnly = process.getuid?.() === 0 ? it : it.skip;

describe('ORV14 rollout observer authority boundary', () => {
  rootOnly('previews from exact runtime and ingress evidence without validating or exposing host executables', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'orv14-rollout-observer-'));
    try {
      const digest = 'a'.repeat(64);
      const imageDigest = `du-orchestrator@sha256:${digest}`;
      const manifest = {
        schemaVersion: 1,
        hostId: 'maintenance-host',
        // Valid schema pins, deliberately nonexistent: the read-only web
        // constructor must not stat or execute any host tool.
        dockerBinary: '/missing/privileged/docker',
        dockerSha256: 'b'.repeat(64),
        dockerContext: 'production-host',
        workingDirectory: '/srv/du',
        homeDirectory: '/root',
        dockerConfigDirectory: '/root/.docker',
        targets: [{
          service: 'orchestrator',
          slots: {
            blue: { projectName: 'orchestrator-blue', serviceId: 'orchestrator', runtimeIdentity: 'orch-blue', revision: 'r1', imageDigest, controlBaseUrl: 'http://orch-blue.internal:3002' },
            green: { projectName: 'orchestrator-green', serviceId: 'orchestrator', runtimeIdentity: 'orch-green', revision: 'r1', imageDigest, controlBaseUrl: 'http://orch-green.internal:3002' },
          },
          releases: [
            { revision: 'r1', slots: {
              blue: { composeFiles: [{ path: '/missing/blue.yml', sha256: 'c'.repeat(64) }], imageDigest },
              green: { composeFiles: [{ path: '/missing/green.yml', sha256: 'd'.repeat(64) }], imageDigest },
            } },
            { revision: 'r2', slots: {
              blue: { composeFiles: [{ path: '/missing/blue-r2.yml', sha256: 'e'.repeat(64) }], imageDigest: `du-orchestrator@sha256:${'e'.repeat(64)}` },
              green: { composeFiles: [{ path: '/missing/green-r2.yml', sha256: 'f'.repeat(64) }], imageDigest: `du-orchestrator@sha256:${'f'.repeat(64)}` },
            } },
          ],
          selectorFile: '/missing/selector',
          fixedIngressProbeUrl: 'https://du.internal/orchestrator-identity',
          reloadExecutable: '/missing/privileged/reload',
          reloadExecutableSha256: '9'.repeat(64),
          reloadArgs: ['--reload'],
        }],
      };
      const manifestPath = path.join(directory, 'manifest.json');
      const bytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(manifestPath, bytes, { mode: 0o400 });
      const expectedManifestSha256 = createHash('sha256').update(bytes).digest('hex');
      const observedAt = new Date().toISOString();
      const runtimeSafety = {
        observe: jest.fn(async (input: { slot: 'blue' | 'green'; runtimeIdentity: string; revision: string; imageDigest: string }) => ({
          service: 'orchestrator' as const,
          slot: input.slot,
          runtimeIdentity: input.runtimeIdentity,
          replicaId: input.runtimeIdentity,
          revision: input.revision,
          imageDigest: input.imageDigest,
          readiness: 'READY' as const,
          observedAt,
          workObservedAt: observedAt,
          controlRevision: 7,
          controlState: 'OPEN' as const,
          controlAcknowledgedAt: observedAt,
          work: {
            workerLeases: { applicable: false, count: null },
            sdkActiveTasks: { applicable: false, count: null },
            connectorInvocations: { applicable: false, count: null },
            orchestratorRequests: { applicable: true, count: 0 },
            dispatches: { applicable: true, count: 0 },
            maintenanceExecutions: { applicable: true, count: 0 },
          },
        })),
        probeFixedIngress: jest.fn(async (input: { expectedSlot: 'blue' | 'green'; expectedRuntimeIdentity: string; expectedRevision: string; expectedImageDigest: string }) => {
          if (input.expectedSlot === 'green') return {
            statusCode: 503, servedService: null, servedSlot: null, servedRuntimeIdentity: null,
            servedReplicaId: null, servedRevision: null, servedImageDigest: null, observedAt,
          };
          return {
            statusCode: 200, servedService: 'orchestrator' as const, servedSlot: input.expectedSlot,
            servedRuntimeIdentity: input.expectedRuntimeIdentity, servedReplicaId: input.expectedRuntimeIdentity,
            servedRevision: input.expectedRevision, servedImageDigest: input.expectedImageDigest, observedAt,
          };
        }),
        requestDrain: jest.fn(),
        requestResume: jest.fn(),
      };
      const observer = await createTrustedManifestRolloutPreviewAdapter({
        manifestPath, expectedManifestSha256, runtimeSafety: runtimeSafety as never,
      });

      expect(await observer.capabilities()).toEqual({
        services: ['orchestrator'], fixedIngressServices: ['orchestrator'], workerReplacement: false,
      });
      const result = await observer.observe({ service: 'orchestrator', scope: { kind: 'platform' } });
      expect(result.ingressTarget).toBe('blue');
      expect(result.replicas.map((replica) => replica.state)).toEqual(['READY', 'READY']);
      expect(runtimeSafety.observe).toHaveBeenCalledTimes(2);
      expect(runtimeSafety.probeFixedIngress).toHaveBeenCalledTimes(2);
      expect(Object.keys(observer).sort()).toEqual(['capabilities', 'executorIdentityForSlot', 'observe', 'trusted']);

      const service = createReplicaRolloutService({
        db: {} as never,
        audit: {} as never,
        observationAdapter: observer,
        backupSnapshotWriteGate: {} as never,
      });
      await expect(service.runQueuedRollouts('maintenance-host', 1)).resolves.toEqual([]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  rootOnly('rejects an unpinned or malformed manifest before returning a trusted observer', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(), 'orv14-rollout-observer-invalid-'));
    try {
      const manifestPath = path.join(directory, 'manifest.json');
      const bytes = Buffer.from('{"schemaVersion":1,"hostId":"host"}');
      await writeFile(manifestPath, bytes, { mode: 0o400 });
      await expect(createTrustedManifestRolloutPreviewAdapter({
        manifestPath,
        expectedManifestSha256: '0'.repeat(64),
        runtimeSafety: {} as never,
      })).rejects.toThrow(/DIGEST/);
      await expect(createTrustedManifestRolloutPreviewAdapter({
        manifestPath,
        expectedManifestSha256: createHash('sha256').update(bytes).digest('hex'),
        runtimeSafety: {} as never,
      })).rejects.toThrow('ROLLOUT_MANIFEST_INVALID');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('allows web preview and enqueue while keeping the execution adapter absent', async () => {
    const observedAt = new Date().toISOString();
    const observationAdapter = {
      trusted: true as const,
      capabilities: async () => ({
        services: ['orchestrator'] as const,
        fixedIngressServices: ['orchestrator'] as const,
        workerReplacement: false,
      }),
      executorIdentityForSlot: jest.fn(async () => 'orch-green'),
      observe: jest.fn(async () => ({
        replicas: [
          { replicaId: 'orch-blue', slot: 'blue', desiredRevision: 'r1', observedRevision: 'r1', state: 'READY' as const, activeWork: 0, acknowledgedAt: observedAt, code: null },
          { replicaId: 'orch-green', slot: 'green', desiredRevision: 'r1', observedRevision: 'r1', state: 'READY' as const, activeWork: 0, acknowledgedAt: observedAt, code: null },
        ],
        ingressTarget: 'blue',
        fixedIngress: true,
      })),
    };
    const query = jest.fn(async () => ({ rowCount: 1, rows: [] }));
    const db = {
      tx: async (fn: (client: { query: typeof query }) => Promise<unknown>) => fn({ query }),
    };
    const service = createReplicaRolloutService({
      db: db as never,
      audit: { record: jest.fn(async () => undefined) } as never,
      observationAdapter,
      backupSnapshotWriteGate: {} as never,
    });

    const preview = await service.createRolloutPreview({ actor: 'admin', actorRole: 'platform' }, {
      service: 'orchestrator', desiredRevision: 'r2', scope: { kind: 'platform' },
      strategy: 'two_slot', reason: 'upgrade host release',
    });
    expect(preview.requiresIngressSwitch).toBe(true);
    expect(observationAdapter.observe).toHaveBeenCalledTimes(1);
    expect(observationAdapter.executorIdentityForSlot).toHaveBeenCalledWith({
      service: 'orchestrator', revision: 'r2', slot: 'green',
    });
    expect(await service.runQueuedRollouts('web-replica', 1)).toEqual([]);
    expect(Object.keys(observationAdapter).sort()).toEqual(['capabilities', 'executorIdentityForSlot', 'observe', 'trusted']);
  });
});
