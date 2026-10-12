import { PostgresBackupSnapshotFence } from '../src/modules/maintenance/backup-effect-fence';
import type { Db } from '../src/db/db';

const execution = {
  jobId: '11111111-1111-4111-8111-111111111111',
  itemId: 'platform-primary',
  ownerRuntimeIdentity: 'maintenance-host-a',
  ownerBootId: '22222222-2222-4222-8222-222222222222',
  executionFence: 1,
  executionToken: 'x'.repeat(48),
};

describe('PostgresBackupSnapshotFence', () => {
  it('cancels only prepared artifact permits with one typed timestamp bind', async () => {
    const calls: Array<{ sql: string; params?: unknown[] }> = [];
    const query = jest.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params });
      if (sql.includes('FROM maintenance_backup_effect_gate')) {
        return { rows: [{
          state: 'OPEN', fence_id: null, fence_revision: 0, backup_id: null,
          maintenance_job_id: null, owner_item_id: null, owner_runtime_identity: null,
          owner_boot_id: null, owner_execution_fence: null, execution_token_sha256: null,
          last_fence_id: null, last_execution_token_sha256: null, last_owner_runtime_identity: null,
          last_owner_boot_id: null, last_maintenance_job_id: null, last_owner_item_id: null,
          last_owner_execution_fence: null,
        }], rowCount: 1 };
      }
      if (sql.includes('FROM maintenance_job_items')) return { rows: [{ ok: 1 }], rowCount: 1 };
      if (sql.includes('UPDATE maintenance_backup_effect_gate')) return { rows: [], rowCount: 1 };
      if (sql.includes('UPDATE maintenance_backup_artifact_effects')) return { rows: [], rowCount: 2 };
      throw new Error('unexpected test query');
    });
    const db = {
      query,
      tx: async <T>(callback: (client: never) => Promise<T>) => callback({ query } as never),
      close: async () => undefined,
      pool: {} as never,
    } as unknown as Db;
    const fence = new PostgresBackupSnapshotFence(db, () => new Date('2026-10-12T02:40:00.000Z'));

    const held = await fence.hold({
      fenceId: '33333333-3333-4333-8333-333333333333',
      backupId: '44444444-4444-4444-8444-444444444444',
      execution,
      expectedFenceRevision: 0,
      priorControlStates: {},
    });

    expect(held).toMatchObject({ fenceRevision: 1, state: 'HELD' });
    const cancel = calls.find((call) => call.sql.includes('UPDATE maintenance_backup_artifact_effects'));
    expect(cancel?.sql).toContain("settled_at=$1::timestamptz,updated_at=$1::timestamptz");
    expect(cancel?.params).toEqual(['2026-10-12T02:40:00.000Z']);
  });
});
