import type { Db } from '../src/db/db';
import { PostgresBackupArtifactEffects } from '../src/modules/maintenance/backup-effect-fence';

const tenantId = '11111111-1111-4111-8111-111111111111';
const generationId = '22222222-2222-4222-8222-222222222222';
const bootId = '33333333-3333-4333-8333-333333333333';

function effectDb() {
  let row: Record<string, unknown> | undefined;
  const queries: Array<{ sql: string; params: unknown[] }> = [];
  const query = jest.fn(async (sql: string, params: unknown[] = []) => {
    queries.push({ sql, params });
    if (sql.includes('FROM maintenance_backup_effect_gate')) {
      return { rows: [{ state: 'OPEN', fence_id: null, fence_revision: 0, backup_id: null,
        maintenance_job_id: null, owner_item_id: null, owner_runtime_identity: null, owner_boot_id: null,
        owner_execution_fence: null, execution_token_sha256: null }], rowCount: 1 };
    }
    if (sql.includes('SELECT * FROM maintenance_backup_artifact_effects WHERE effect_key_sha256')) {
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (sql.includes('SELECT * FROM maintenance_backup_artifact_effects WHERE effect_id')) {
      return { rows: row?.effect_id === params[0] ? [row] : [], rowCount: row?.effect_id === params[0] ? 1 : 0 };
    }
    if (sql.includes('INSERT INTO maintenance_backup_artifact_effects')) {
      const [effectId, effectKeySha, requestSha, category, ownerTenantId, artifactId, storageGenerationId,
        objectKeySha, capabilityKind, capabilityIdSha, capabilityExpiresAt, ownerIdentity, ownerBoot, revision] = params;
      row = {
        effect_id: effectId, effect_key_sha256: effectKeySha, request_sha256: requestSha, category,
        tenant_id: ownerTenantId, artifact_id: artifactId, storage_generation_id: storageGenerationId,
        object_key_sha256: objectKeySha, capability_kind: capabilityKind, capability_state: 'NOT_ISSUED',
        capability_id_sha256: capabilityIdSha, capability_expires_at: capabilityExpiresAt,
        owner_runtime_identity: ownerIdentity, owner_boot_id: ownerBoot, fence_revision: revision,
        state: 'PREPARED', object_version_id: null, object_sha256: null, object_byte_size: null,
        sidecar_version_id: null, sidecar_sha256: null, sidecar_byte_size: null, metadata_row_sha256: null,
        prepared_at: new Date('2026-10-12T06:00:00Z'), activated_at: null, settled_at: null,
      };
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("SET state='ACTIVE'")) {
      const canActivate = row !== undefined && row.effect_id === params[0] && row.state === 'PREPARED'
        && row.owner_runtime_identity === params[2] && row.owner_boot_id === params[3]
        && Number(row.fence_revision) === Number(params[4]);
      if (canActivate) row = { ...row!, state: 'ACTIVE', activated_at: params[1] };
      return { rows: [], rowCount: canActivate ? 1 : 0 };
    }
    if (sql.includes("SET state='UNKNOWN'")) {
      const canMarkUnknown = row !== undefined && row.effect_id === params[0] && row.owner_runtime_identity === params[3]
        && row.owner_boot_id === params[4] && ['PREPARED', 'ACTIVE', 'SETTLING'].includes(String(row.state));
      if (canMarkUnknown) row = { ...row!, state: 'UNKNOWN', reason_code: params[1] };
      return { rows: [], rowCount: canMarkUnknown ? 1 : 0 };
    }
    if (sql.includes("SET state='COMPLETED'")) {
      const canSettle = row !== undefined && row.effect_id === params[0] && ['ACTIVE', 'SETTLING'].includes(String(row.state));
      if (canSettle) row = { ...row!, state: 'COMPLETED' };
      return { rows: [], rowCount: canSettle ? 1 : 0 };
    }
    if (sql.includes('FROM maintenance_backup_artifact_effects')) {
      return { rows: [{ process_active: '0', prepared: row?.state === 'PREPARED' ? '1' : '0',
        active: row?.state === 'ACTIVE' ? '1' : '0', settling: row?.state === 'SETTLING' ? '1' : '0',
        unclosed: ['PREPARED', 'ACTIVE', 'SETTLING', 'UNKNOWN'].includes(String(row?.state)) ? '1' : '0',
        capabilities: row?.capability_state === 'OPEN' ? '1' : '0', unknown: row?.state === 'UNKNOWN' ? '1' : '0' }], rowCount: 1 };
    }
    throw new Error(`unexpected effect journal query: ${sql.slice(0, 100)}`);
  });
  const db = {
    query,
    tx: async <T>(callback: (client: { query: typeof query }) => Promise<T>) => callback({ query }),
    close: async () => undefined,
    pool: {} as never,
  } as unknown as Db;
  return { db, query, queries, getRow: () => row };
}

describe('ORV15 independent artifact effect uncertainty replay', () => {
  it('keeps an ambiguous encrypted write UNKNOWN and refuses to activate it again on exact replay', async () => {
    const state = effectDb();
    const journal = new PostgresBackupArtifactEffects(state.db,
      { runtimeIdentity: 'host-restore-a', bootId }, () => new Date('2026-10-12T06:00:00.000Z'));
    const externalWrite = jest.fn(async () => undefined);
    const input = {
      effectKey: 'orv15-vfy-host-effect-exact-key', category: 'encrypted-upload' as const,
      tenantId, artifactId: '44444444-4444-4444-8444-444444444444', storageGenerationId: generationId,
      objectKeySha256: 'a'.repeat(64),
    };

    const first = await journal.begin(input);
    if (await journal.activate(first.effectId)) await externalWrite();
    await journal.markUnknown(first.effectId, 'RESPONSE_LOST_AFTER_SEND');

    const retry = await journal.begin(input);
    if (await journal.activate(retry.effectId)) await externalWrite();
    const observation = await journal.observe();

    expect(first).toMatchObject({ state: 'PREPARED', replayed: false });
    expect(retry).toMatchObject({ effectId: first.effectId, state: 'UNKNOWN', replayed: true });
    expect(await journal.activate(retry.effectId)).toBe(false);
    expect(await journal.settle(retry.effectId, {
      objectVersionId: 'object-v1', objectSha256: 'b'.repeat(64), objectByteSize: 100,
      sidecarVersionId: 'sidecar-v1', sidecarSha256: 'c'.repeat(64), sidecarByteSize: 80,
      metadataRowSha256: 'd'.repeat(64),
    })).toBe(false);
    expect(externalWrite).toHaveBeenCalledTimes(1);
    expect(state.queries.filter(({ sql }) => sql.includes('INSERT INTO maintenance_backup_artifact_effects'))).toHaveLength(1);
    expect(state.getRow()?.state).toBe('UNKNOWN');
    expect(observation).toMatchObject({ processActiveEffects: 0, activeEffects: 0, unknownEffects: 1, unclosedEffects: 1 });
  });
});
