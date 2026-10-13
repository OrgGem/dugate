import type { Db } from '../src/db/db';
import { recordWorkerHeartbeat } from '../src/modules/runtime/worker-instances';

function result(rows: unknown[] = []) {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

test('tenant control lookup compares UUID tenant IDs as text and never casts arbitrary scope IDs', async () => {
  const observedAt = new Date('2026-10-11T12:00:00.000Z');
  const query = jest.fn(async (sql: string) => {
    if (sql.includes('FROM maintenance_backup_effect_gate')) {
      return result([{ state: 'OPEN', fence_revision: 3 }]);
    }
    if (sql.includes('FROM business_catalog')) {
      return result([{ enabled: true, activation_revision: 1, submissions_paused: false, pre_drain_version: null }]);
    }
    if (sql.includes('SELECT version,status,is_active FROM business_versions')) {
      return result([{ version: '1.2.3', status: 'ENABLED', is_active: true }]);
    }
    if (sql.includes('SELECT scope_kind,scope_id,desired_state,revision')) {
      return result([
        { scope_kind: 'platform', scope_id: 'all', desired_state: 'OPEN', revision: 1 },
        { scope_kind: 'business', scope_id: 'document-core', desired_state: 'OPEN', revision: 2 },
      ]);
    }
    if (sql.includes('SELECT r.scope_id,r.revision,r.desired_state')) return result([]);
    if (sql.includes('SELECT desired_control_revision,desired_control_state')) return result([]);
    if (sql.includes('WITH lease_count')) {
      return result([{ state: 'ONLINE', last_seen_at: observedAt, control_revision: 2, control_state: 'OPEN' }]);
    }
    return result();
  });
  const db = {
    tx: jest.fn(async (work: (client: never) => Promise<unknown>) => work({ query } as never)),
  } as unknown as Db;

  await expect(recordWorkerHeartbeat(db, 'worker-a', {
    businessId: 'document-core', businessVersion: '1.2.3', imageDigest: 'sha256:abc123', capacity: 4,
  })).resolves.toMatchObject({ state: 'ONLINE', controlRevision: 2, controlState: 'OPEN',
    activeVersion: '1.2.3', activationRevision: 1, admissionEligible: true, admissionReason: 'ELIGIBLE',
    backupEffectFence: { state: 'OPEN', revision: 3, acknowledged: false } });

  await expect(recordWorkerHeartbeat(db, 'worker-a', {
    businessId: 'document-core', businessVersion: '1.2.3', imageDigest: 'sha256:abc123', capacity: 4,
    observedBackupFenceRevision: 3,
  })).resolves.toMatchObject({ backupEffectFence: { state: 'OPEN', revision: 3, acknowledged: true } });

  const lookup = query.mock.calls.find(([sql]) => sql.includes('SELECT r.scope_id,r.revision,r.desired_state'))?.[0];
  expect(lookup).toContain('o.tenant_id::text=r.scope_id');
  expect(lookup).not.toContain('r.scope_id::uuid');
  expect(query.mock.calls[0]?.[0]).toContain('FROM maintenance_backup_effect_gate');
  expect(query).toHaveBeenCalledWith(expect.stringContaining('INSERT INTO worker_control_scope_acks'), expect.any(Array));
});
