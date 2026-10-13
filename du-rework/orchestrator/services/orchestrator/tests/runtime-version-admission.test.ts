import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import { createRegistryService } from '../src/modules/registry/registry';
import { readBusinessAdmission } from '../src/modules/registry/version-admission';

interface VersionRow {
  version: string;
  status: string;
  is_active: boolean;
}

function makeWorld(input: {
  revision?: number;
  activeVersion?: string | null;
  businessEnabled?: boolean;
  lifecycleRevision?: number;
  versionStatuses?: Record<string, string>;
  submissionsPaused?: boolean;
  preDrainVersion?: string | null;
  replayEvent?: boolean;
} = {}) {
  let revision = input.revision ?? 1;
  let enabled = input.businessEnabled ?? true;
  let lifecycleRevision = input.lifecycleRevision ?? 1;
  let activeVersion: string | null = input.activeVersion ?? 'v1';
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const versions: VersionRow[] = [
    { version: 'v1', status: input.versionStatuses?.v1 ?? 'ENABLED', is_active: activeVersion === 'v1' },
    { version: 'v2', status: input.versionStatuses?.v2 ?? 'ENABLED', is_active: activeVersion === 'v2' },
  ];

  const query = async (text: string, params: unknown[] = []) => {
    const sql = text.replace(/\s+/g, ' ').trim();
    calls.push({ sql, params });
    if (sql.startsWith('SELECT enabled,lifecycle_revision,activation_revision')) {
      return { rows: [{ enabled, lifecycle_revision: lifecycleRevision, activation_revision: revision,
        submissions_paused: input.submissionsPaused ?? false,
        pre_drain_version: input.preDrainVersion ?? null }], rowCount: 1 };
    }
    if (sql.startsWith('SELECT enabled,activation_revision,submissions_paused,pre_drain_version')) {
      return {
        rows: [{ enabled, activation_revision: revision,
          submissions_paused: input.submissionsPaused ?? false,
          pre_drain_version: input.preDrainVersion ?? null }], rowCount: 1,
      };
    }
    if (sql.startsWith('SELECT version,status,is_active')) {
      if (sql.includes('ORDER BY version FOR UPDATE')) {
        return { rows: versions.map((row) => ({ ...row })), rowCount: versions.length };
      }
      const targetVersion = params[1];
      return {
        rows: versions.filter((row) => row.is_active || row.version === targetVersion).map((row) => ({ ...row })),
        rowCount: versions.filter((row) => row.is_active || row.version === targetVersion).length,
      };
    }
    if (sql.startsWith('SELECT EXISTS')) return { rows: [{ found: input.replayEvent === true }], rowCount: 1 };
    if (sql.startsWith('SELECT version FROM business_versions')) {
      return { rows: activeVersion ? [{ version: activeVersion }] : [], rowCount: activeVersion ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE business_catalog') && sql.includes('SET enabled=$2')) {
      enabled = Boolean(params[1]);
      lifecycleRevision += 1;
      return { rows: [{ enabled, lifecycle_revision: lifecycleRevision }], rowCount: 1 };
    }
    if (sql.startsWith("UPDATE business_versions SET status='ENABLED'")) {
      const target = versions.find((row) => row.version === params[1]);
      if (target) target.status = 'ENABLED';
      return { rows: [], rowCount: target ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE business_versions SET is_active=false')) {
      for (const row of versions) row.is_active = false;
      activeVersion = null;
      return { rows: [], rowCount: 1 };
    }
    if (sql.startsWith('UPDATE business_versions SET is_active=true')) {
      const target = versions.find((row) => row.version === params[1]);
      if (target) {
        target.is_active = true;
        activeVersion = target.version;
      }
      return { rows: [], rowCount: target ? 1 : 0 };
    }
    if (sql.startsWith('UPDATE business_catalog') && sql.includes('RETURNING activation_revision')) {
      revision += 1;
      return { rows: [{ activation_revision: revision }], rowCount: 1 };
    }
    return { rows: [], rowCount: 1 };
  };
  const client = { query };
  const db = {
    query,
    tx: async <T>(fn: (c: typeof client) => Promise<T>) => fn(client),
  } as unknown as Db;
  return { db, client, calls, versions, get revision() { return revision; }, get activeVersion() { return activeVersion; }, get enabled() { return enabled; } };
}

describe('business version admission fencing', () => {
  it('locks the catalog root before reading active and target versions in a fresh statement', async () => {
    const world = makeWorld({ activeVersion: 'v2', revision: 4 });
    const admission = await world.db.tx((client) => readBusinessAdmission(client, 'biz', 'v1', 'SHARE'));

    expect(admission).toMatchObject({ activationRevision: 4, activeVersion: 'v2', targetStatus: 'ENABLED' });
    expect(world.calls[0]!.sql).toContain('FOR SHARE');
    expect(world.calls[1]!.sql).toContain('SELECT version,status,is_active');
    expect(world.calls[1]!.sql).not.toContain('JOIN business_catalog');
  });

  it('rejects a stale activation revision before mutating either active pointer', async () => {
    const world = makeWorld({ activeVersion: 'v2', revision: 2 });
    const registry = createRegistryService(world.db);

    await expect(registry.activateVersion('biz', 'v1', 1)).rejects.toMatchObject({
      status: 409,
      code: 'STATE_CONFLICT',
    } satisfies Partial<HttpError>);
    expect(world.calls.some(({ sql }) => sql.startsWith('UPDATE business_versions SET is_active='))).toBe(false);
  });

  it('replays the committed command after a lost response without switching back', async () => {
    const world = makeWorld({ activeVersion: 'v1', revision: 2, replayEvent: true });
    const registry = createRegistryService(world.db);

    const result = await registry.activateVersion('biz', 'v1', 1);

    expect(result).toMatchObject({ active: true, activationRevision: 2, replayed: true });
    expect(world.activeVersion).toBe('v1');
    expect(world.calls.some(({ sql }) => sql.startsWith('UPDATE business_versions SET is_active='))).toBe(false);
  });

  it('switches versions under one root lock and advances the CAS revision', async () => {
    const world = makeWorld({ activeVersion: 'v1', revision: 1 });
    const registry = createRegistryService(world.db);

    const result = await registry.activateVersion('biz', 'v2', 1);

    expect(result).toMatchObject({ previousVersion: 'v1', active: true, activationRevision: 2, replayed: false });
    expect(world.activeVersion).toBe('v2');
    expect(world.calls[0]!.sql).toContain('FOR UPDATE');
    expect(world.calls.some(({ sql }) => sql.includes('INSERT INTO business_version_activation_events'))).toBe(true);
  });

  it('advances the admission generation when a version becomes enabled', async () => {
    const world = makeWorld({ activeVersion: 'v1', revision: 7, versionStatuses: { v2: 'REGISTERED_DISABLED' } });
    const registry = createRegistryService(world.db);

    const result = await registry.enableVersion('biz', 'v2', 7);

    expect(result).toMatchObject({ status: 'ENABLED', activationRevision: 8, replayed: false });
    expect(world.versions.find((row) => row.version === 'v2')?.status).toBe('ENABLED');
    expect(world.activeVersion).toBe('v1');
    expect(world.calls.find(({ sql }) => sql.includes('INSERT INTO business_version_activation_events')))
      .toMatchObject({ params: expect.arrayContaining(['VERSION_ENABLED', 'v2']) });
  });

  it('advances the admission generation when business eligibility changes', async () => {
    const world = makeWorld({ businessEnabled: false, lifecycleRevision: 3, revision: 6, activeVersion: 'v1' });
    const registry = createRegistryService(world.db);

    const result = await registry.setBusinessEnabled('biz', true, 3);

    expect(result).toMatchObject({ enabled: true, lifecycleRevision: 4, replayed: false });
    expect(world.enabled).toBe(true);
    expect(world.revision).toBe(7);
    expect(world.activeVersion).toBe('v1');
    expect(world.calls.find(({ sql }) => sql.includes('INSERT INTO business_version_activation_events')))
      .toMatchObject({ params: expect.arrayContaining(['BUSINESS_ENABLED']) });
  });
});
