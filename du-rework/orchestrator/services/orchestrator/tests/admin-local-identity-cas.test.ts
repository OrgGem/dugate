import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createAdminLocalUserRepository } from '../src/modules/auth/admin-local/repository';
import { hashLocalPassword } from '../src/modules/auth/admin-local/password';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = '22222222-2222-4222-8222-222222222222';
const ACTOR = '33333333-3333-4333-8333-333333333333';
const PROFILE = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';

function fakeRepository(options: { adminCount?: number; profileFound?: boolean; keyName?: string | null; legacyResetRequired?: boolean; enabled?: boolean; locked?: boolean; role?: string } = {}) {
  const writes: string[] = [];
  const row = {
    id: ADMIN, tenant_id: TENANT, username_normalized: 'local-admin', role: options.role ?? 'admin',
    is_enabled: options.enabled ?? true, is_locked: options.locked ?? false, legacy_password_reset_required: options.legacyResetRequired ?? false,
    created_at: new Date('2026-10-10T00:00:00Z'),
    updated_at: new Date('2026-10-10T00:00:00Z'), version: 1, assignment_version: 1,
  };
  const audit = { record: jest.fn(async () => undefined) };
  const execute = async <T extends QueryResultRow>(sql: string, params: unknown[] = []) => {
    const normalizedSql = sql.replace(/\s+/g, ' ').trim();
    if (/INSERT INTO|UPDATE admin_local_users|DELETE FROM admin_local_user/.test(normalizedSql)) writes.push(normalizedSql);
    let rows: Record<string, unknown>[] = [];
    if (/SELECT count\(\*\)::text AS count FROM admin_local_users/.test(normalizedSql)) rows = [{ count: String(options.adminCount ?? 1) }];
    else if (/SELECT .*FROM admin_local_users WHERE tenant_id=\$1 AND id=\$2 FOR UPDATE/.test(normalizedSql)) {
      rows = params[0] === TENANT && params[1] === ADMIN ? [{ ...row }] : [];
    } else if (/SELECT profile_id FROM profile_names/.test(normalizedSql)) {
      rows = options.profileFound === false ? [] : [{ profile_id: PROFILE }];
    } else if (/SELECT id, name FROM api_keys/.test(normalizedSql)) {
      rows = [{ id: KEY, name: options.keyName ?? 'worker-key' }];
    } else if (/UPDATE admin_local_users SET role=/.test(normalizedSql)) {
      rows = [{ ...row, role: params[0], is_enabled: params[1], version: 2 }];
    } else if (/UPDATE admin_local_users SET password_hash=/.test(normalizedSql)) {
      rows = [{ ...row, is_enabled: params[4] === true ? true : row.is_enabled,
        legacy_password_reset_required: params[4] === true ? false : row.legacy_password_reset_required, version: 2 }];
    } else if (/UPDATE admin_local_users SET assignment_version=/.test(normalizedSql)) {
      rows = [{ ...row, version: 2, assignment_version: 2 }];
    }
    return { rows, rowCount: rows.length } as unknown as { rows: T[]; rowCount: number };
  };
  const db = {
    query: (sql: string, params?: unknown[]) => execute(sql, params),
    tx: <T>(work: (client: PoolClient) => Promise<T>) => work({ query: execute } as unknown as PoolClient),
  } as unknown as Db;
  return { repository: createAdminLocalUserRepository(db, audit as never), audit, writes };
}

describe('local identity CAS and assignment replacement', () => {
  it('denies an administrator demoting or disabling their current local account', async () => {
    const { repository, writes, audit } = fakeRepository({ adminCount: 2 });
    await expect(repository.updateIdentity({ tenantId: TENANT, userId: ADMIN, actor: 'local-admin', actorUserId: ADMIN,
      actorIssuer: 'du-local', actorRole: 'ADMIN', role: 'USER', enabled: true, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'SELF_LOCKOUT' });
    expect(writes.filter((sql) => /UPDATE admin_local_users SET role=/.test(sql))).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('denies removal of the last enabled, unlocked local administrator', async () => {
    const { repository, writes, audit } = fakeRepository({ adminCount: 1 });
    await expect(repository.updateIdentity({ tenantId: TENANT, userId: ADMIN, actor: 'other-admin', actorUserId: ACTOR,
      actorIssuer: 'du-local', actorRole: 'ADMIN', role: 'USER', enabled: true, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'LAST_ADMIN_REQUIRED' });
    expect(writes.filter((sql) => /UPDATE admin_local_users SET role=/.test(sql))).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('replaces the complete same-tenant assignment set and bumps the cross-replica session version', async () => {
    const { repository, audit, writes } = fakeRepository();
    const result = await repository.replaceAssignments({ tenantId: TENANT, userId: ADMIN, actor: 'admin', actorUserId: ACTOR,
      actorIssuer: 'du-local', actorRole: 'ADMIN', expectedVersion: 1, profileIds: [PROFILE], apiKeyIds: [KEY] });
    expect(result).toMatchObject({ user: { version: 2 }, assignmentVersion: 2 });
    expect(writes.some((sql) => /DELETE FROM admin_local_user_profile_grants/.test(sql))).toBe(true);
    expect(writes.some((sql) => /DELETE FROM admin_local_user_api_key_grants/.test(sql))).toBe(true);
    expect(writes.some((sql) => /UPDATE admin_local_users SET assignment_version=assignment_version\+1, version=version\+1/.test(sql))).toBe(true);
    expect(audit.record).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ profileFound: false }, 'FOREIGN_GRANT'],
    [{ keyName: ' GLOBAL ' }, 'GLOBAL_KEY_PROTECTED'],
  ] as const)('rejects foreign or protected grants before replacing assignments', async (options, code) => {
    const { repository, audit, writes } = fakeRepository(options);
    await expect(repository.replaceAssignments({ tenantId: TENANT, userId: ADMIN, actor: 'admin', actorUserId: ACTOR,
      actorIssuer: 'du-local', actorRole: 'ADMIN', expectedVersion: 1, profileIds: [PROFILE], apiKeyIds: [KEY] }))
      .rejects.toMatchObject({ code });
    expect(writes.filter((sql) => /DELETE FROM admin_local_user_(profile|api_key)_grants/.test(sql))).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('uses the expected assignment version as a compare-and-swap guard', async () => {
    const { repository, writes, audit } = fakeRepository();
    await expect(repository.replaceAssignments({ tenantId: TENANT, userId: ADMIN, actor: 'admin', actorUserId: ACTOR,
      actorIssuer: 'du-local', actorRole: 'ADMIN', expectedVersion: 9, profileIds: [], apiKeyIds: [] }))
      .rejects.toMatchObject({ code: 'IDENTITY_VERSION_CONFLICT' });
    expect(writes.filter((sql) => /DELETE FROM admin_local_user_(profile|api_key)_grants/.test(sql))).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('activates an imported unlocked reset-required account atomically on its versioned password reset', async () => {
    const { repository, audit, writes } = fakeRepository({ legacyResetRequired: true, enabled: false });
    const passwordHash = await hashLocalPassword('fresh-imported-user-password');
    const user = await repository.resetIdentityPassword({ tenantId: TENANT, userId: ADMIN, actor: 'admin', actorUserId: ACTOR,
      actorIssuer: 'du-local', actorRole: 'ADMIN', expectedVersion: 1, passwordHash });
    expect(user).toMatchObject({ enabled: true, locked: false, legacyPasswordResetRequired: false, version: 2 });
    expect(writes.some((sql) => /is_enabled=CASE WHEN \$5 THEN true/.test(sql) && /legacy_password_reset_required=CASE WHEN \$5 THEN false/.test(sql))).toBe(true);
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_local_user.legacy_activated' }), expect.anything());
  });

  it('does not activate a locked imported account or consume its reset marker', async () => {
    const { repository, audit, writes } = fakeRepository({ legacyResetRequired: true, enabled: false, locked: true });
    const passwordHash = await hashLocalPassword('fresh-imported-user-password');
    await expect(repository.resetIdentityPassword({ tenantId: TENANT, userId: ADMIN, actor: 'admin', actorUserId: ACTOR,
      actorIssuer: 'du-local', actorRole: 'ADMIN', expectedVersion: 1, passwordHash })).rejects.toMatchObject({ code: 'LEGACY_USER_LOCKED' });
    expect(writes.filter((sql) => /UPDATE admin_local_users SET password_hash=/.test(sql))).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('keeps a normal disabled local account disabled when an administrator resets its password', async () => {
    const { repository, audit } = fakeRepository({ enabled: false, legacyResetRequired: false });
    const passwordHash = await hashLocalPassword('new-disabled-user-password');
    const user = await repository.resetIdentityPassword({ tenantId: TENANT, userId: ADMIN, actor: 'admin', actorUserId: ACTOR,
      actorIssuer: 'du-local', actorRole: 'ADMIN', expectedVersion: 1, passwordHash });
    expect(user).toMatchObject({ enabled: false, legacyPasswordResetRequired: false, version: 2 });
    expect(audit.record).toHaveBeenCalledWith(expect.objectContaining({ action: 'admin_local_user.password_reset' }), expect.anything());
  });

  it('requires the explicit password-reset activation path before enabling an imported account', async () => {
    const { repository, audit, writes } = fakeRepository({ legacyResetRequired: true, enabled: false, role: 'operator' });
    await expect(repository.updateIdentity({ tenantId: TENANT, userId: ADMIN, actor: 'other-admin', actorUserId: ACTOR,
      actorIssuer: 'du-local', actorRole: 'ADMIN', role: 'USER', enabled: true, expectedVersion: 1 }))
      .rejects.toMatchObject({ code: 'LEGACY_RESET_REQUIRED' });
    expect(writes.filter((sql) => /UPDATE admin_local_users SET role=/.test(sql))).toHaveLength(0);
    expect(audit.record).not.toHaveBeenCalled();
  });
});
