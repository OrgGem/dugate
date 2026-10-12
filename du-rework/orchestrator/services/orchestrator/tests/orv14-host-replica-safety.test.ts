import { createWorkerReplicaSafetySource, sumAuthoritativeWork } from '../src/modules/maintenance/replica-runtime-safety';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { readReplicaRuntimeControlTargets } from '../src/modules/maintenance/trusted-manifest-rollout-adapter';

const identity = 'worker-blue';
const observedAt = new Date().toISOString();
const rootOnly = process.getuid?.() === 0 ? it : it.skip;

function row(overrides: Record<string, unknown> = {}) {
  return {
    business_id: 'documents', instance_id: identity, business_version: 'v3', image_digest: `worker@sha256:${'a'.repeat(64)}`,
    deployment_revision: 'r3', state: 'ONLINE', last_seen_at: observedAt, control_revision: 8, control_state: 'OPEN',
    desired_control_revision: 0, desired_control_state: 'OPEN', active_leases: 1, active_task_count: 1,
    active_task_observed_at: observedAt,
    backup_effect_fence_revision: null,
    backup_effect_fence_observed_at: null,
    control_scope_evidence: [
      { desiredState: 'OPEN', revision: 7, acknowledgedState: 'OPEN', acknowledgedRevision: 7, acknowledgedAt: observedAt },
      { desiredState: 'OPEN', revision: 8, acknowledgedState: 'OPEN', acknowledgedRevision: 8, acknowledgedAt: observedAt },
    ],
    ...overrides,
  };
}

function sourceWith(resultRow: ReturnType<typeof row>) {
  const query = jest.fn(async (_sql: string, _params?: unknown[]) => ({ rows: [resultRow] }));
  const source = createWorkerReplicaSafetySource({ query } as never, { [identity]: 'documents' });
  return { source, query };
}

describe('ORV14 Host worker replica safety evidence', () => {
  it('requires current scope ACKs and counts every unresolved RUNNING lease regardless of lease expiry', async () => {
    const { source, query } = sourceWith(row());
    const observation = await source.observe({
      service: 'worker', slot: 'blue', runtimeIdentity: identity, replicaId: identity,
      revision: 'r3', imageDigest: `worker@sha256:${'a'.repeat(64)}`, scope: { kind: 'platform' },
    });
    expect(observation?.controlAcknowledgedAt).toBe(observedAt);
    expect(observation?.backupEffectFence).toEqual({ revision: null, acknowledgedAt: null });
    expect(observation?.work.workerLeases).toEqual({ applicable: true, count: 1 });
    expect(sumAuthoritativeWork('worker', observation!.work)).toBe(2);
    expect(query.mock.calls[0]?.[0]).toContain("t.state='RUNNING'");
    expect(query.mock.calls[0]?.[0]).not.toContain('lease_expires_at >');
  });

  it('does not turn a stale or mismatched persisted control ACK into a fresh drain observation', async () => {
    const stale = row({ control_scope_evidence: [
      { desiredState: 'DRAINING', revision: 9, acknowledgedState: 'OPEN', acknowledgedRevision: 8, acknowledgedAt: observedAt },
      { desiredState: 'OPEN', revision: 8, acknowledgedState: 'OPEN', acknowledgedRevision: 8, acknowledgedAt: observedAt },
    ] });
    const { source } = sourceWith(stale);
    const observation = await source.observe({
      service: 'worker', slot: 'blue', runtimeIdentity: identity, replicaId: identity,
      revision: 'r3', imageDigest: `worker@sha256:${'a'.repeat(64)}`, scope: { kind: 'platform' },
    });
    expect(observation?.controlAcknowledgedAt).toBe('');
  });
});

describe('ORV14 Host trusted rollout manifest control targets', () => {
  rootOnly('loads exact direct blue/green endpoints only from the root-pinned manifest', async () => {
    const directory = await mkdtemp(path.join(os.tmpdir(),'orv14-control-targets-'));
    try {
      const imageDigest = `service@sha256:${'a'.repeat(64)}`;
      const manifest = {
        schemaVersion:1,hostId:'host-a',dockerBinary:'/usr/bin/docker',dockerSha256:'b'.repeat(64),dockerContext:'host',
        workingDirectory:'/srv/du',homeDirectory:'/root',dockerConfigDirectory:'/root/.docker',
        targets:[{service:'connector',slots:{
          blue:{projectName:'connector-blue',serviceId:'connector',runtimeIdentity:'connector-blue',revision:'r1',imageDigest,controlBaseUrl:'http://connector-blue.internal:3003/internal/admin/runtime-control'},
          green:{projectName:'connector-green',serviceId:'connector',runtimeIdentity:'connector-green',revision:'r1',imageDigest,controlBaseUrl:'http://connector-green.internal:3003/internal/admin/runtime-control'},
        },releases:[{revision:'r1',slots:{blue:{composeFiles:[{path:'/srv/du/blue.yml',sha256:'c'.repeat(64)}],imageDigest},
          green:{composeFiles:[{path:'/srv/du/green.yml',sha256:'d'.repeat(64)}],imageDigest}}}],
          selectorFile:'/etc/du/connector-selector',fixedIngressProbeUrl:'https://connector.internal/health/identity',
          reloadExecutable:'/usr/local/bin/reload-selector',reloadExecutableSha256:'e'.repeat(64),reloadArgs:[]}],
      };
      const manifestPath = path.join(directory,'manifest.json');
      const bytes = Buffer.from(JSON.stringify(manifest));
      await writeFile(manifestPath,bytes,{mode:0o400});
      const result = await readReplicaRuntimeControlTargets({manifestPath,expectedManifestSha256:createHash('sha256').update(bytes).digest('hex')});
      expect(result.connector).toEqual({
        blue:{serviceId:'connector',runtimeIdentity:'connector-blue',controlBaseUrl:'http://connector-blue.internal:3003/internal/admin/runtime-control',revision:'r1',imageDigest},
        green:{serviceId:'connector',runtimeIdentity:'connector-green',controlBaseUrl:'http://connector-green.internal:3003/internal/admin/runtime-control',revision:'r1',imageDigest},
      });
    } finally { await rm(directory,{recursive:true,force:true}); }
  });
});
