import bcrypt from 'bcryptjs';
import { isLocalPasswordHash } from '../src/modules/auth/admin-local/password';
import {
  mapLegacyRole,
  mapLegacyUserProfileAssignment,
  migrateLegacyLocalCredentialOnLogin,
  type LegacyUserForIdentityMigration,
  type MigratedLocalIdentity,
} from '../src/modules/identity/legacy-user-adapter';

const TENANT_UUID = '11111111-1111-4111-8111-111111111111';
const USER_UUID = '22222222-2222-4222-8222-222222222222';
const SECOND_USER_UUID = '33333333-3333-4333-8333-333333333333';
const RESET_USER_UUID = '44444444-4444-4444-8444-444444444444';
const API_KEY_UUID = '55555555-5555-4555-8555-555555555555';

function legacyUser(
  id: string,
  password: string,
  overrides: Partial<LegacyUserForIdentityMigration> = {},
): LegacyUserForIdentityMigration {
  return {
    id,
    username: 'Legacy.Admin',
    password,
    role: 'ADMIN',
    provider: null,
    providerSub: null,
    email: 'legacy@example.test',
    displayName: 'Legacy Admin',
    ...overrides,
  };
}

describe('legacy identity adapter', () => {
  let bcryptVerifier: string;

  beforeAll(async () => {
    bcryptVerifier = await bcrypt.hash('first-login-secret', 4);
  });

  it('migrates a synthetic three-user cohort at first login and reports exact outcomes', async () => {
    const writes: MigratedLocalIdentity[] = [];
    const verifyBcrypt = jest.fn((password: string, verifier: string) => bcrypt.compare(password, verifier));
    const insertMigratedUser = jest.fn(async (identity: MigratedLocalIdentity) => {
      writes.push(identity);
      return 'inserted' as const;
    });
    const port = { verifyBcrypt, insertMigratedUser };
    const cohort: Array<{ user: LegacyUserForIdentityMigration; password: string }> = [
      { user: legacyUser(USER_UUID, bcryptVerifier), password: 'first-login-secret' },
      { user: legacyUser(SECOND_USER_UUID, bcryptVerifier), password: 'wrong-secret' },
      { user: legacyUser(RESET_USER_UUID, ''), password: 'first-login-secret' },
    ];

    const results = await Promise.all(cohort.map(({ user, password }) =>
      migrateLegacyLocalCredentialOnLogin(user, password, TENANT_UUID, port),
    ));
    const counts = {
      users: cohort.length,
      migrated: results.filter((result) => result.status === 'migrated').length,
      rejected: results.filter((result) => result.status === 'rejected').length,
      passwordResetRequired: results.filter((result) => result.status === 'password-reset-required').length,
      unconverted: results.filter((result) => result.status !== 'migrated').length,
    };

    expect(counts).toEqual({
      users: 3,
      migrated: 1,
      rejected: 1,
      passwordResetRequired: 1,
      unconverted: 2,
    });
    expect(verifyBcrypt).toHaveBeenCalledTimes(2);
    expect(insertMigratedUser).toHaveBeenCalledTimes(1);
    expect(writes).toHaveLength(1);
    expect(isLocalPasswordHash(writes[0]!.passwordHash)).toBe(true);
    expect(writes[0]!.passwordHash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(writes[0]!.passwordHash).not.toBe(bcryptVerifier);
    expect(Object.keys(writes[0]!).sort()).toEqual([
      'id',
      'isEnabled',
      'isLocked',
      'passwordHash',
      'role',
      'tenantId',
      'usernameNormalized',
    ]);
    expect(writes[0]).toMatchObject({
      id: USER_UUID,
      tenantId: TENANT_UUID,
      usernameNormalized: 'legacy.admin',
      role: 'admin',
      isEnabled: true,
      isLocked: false,
    });
    expect(results[1]).toEqual({ status: 'rejected' });
    expect(results[2]).toEqual({ status: 'password-reset-required' });
  });

  it('does not persist a local account for an external provider identity', async () => {
    const verifyBcrypt = jest.fn(async () => true);
    const insertMigratedUser = jest.fn(async () => 'inserted' as const);
    const result = await migrateLegacyLocalCredentialOnLogin(
      legacyUser(USER_UUID, bcryptVerifier, { provider: 'oidc', providerSub: 'provider-subject' }),
      'first-login-secret',
      TENANT_UUID,
      { verifyBcrypt, insertMigratedUser },
    );

    expect(result).toEqual({ status: 'unsupported-provider' });
    expect(verifyBcrypt).not.toHaveBeenCalled();
    expect(insertMigratedUser).not.toHaveBeenCalled();
  });

  it('maps only the supported legacy roles and validates the role domain', () => {
    expect(mapLegacyRole('ADMIN')).toBe('admin');
    expect(mapLegacyRole('USER')).toBe('operator');
    expect(mapLegacyRole('VIEWER')).toBe('viewer');
    expect(() => mapLegacyRole('OWNER')).toThrow();
  });

  it('rejects invalid identity UUIDs and the tenant label before verification or write', async () => {
    const verifyBcrypt = jest.fn(async () => true);
    const insertMigratedUser = jest.fn(async () => 'inserted' as const);
    const port = { verifyBcrypt, insertMigratedUser };

    await expect(migrateLegacyLocalCredentialOnLogin(
      legacyUser('legacy-user-id', bcryptVerifier),
      'first-login-secret',
      TENANT_UUID,
      port,
    )).rejects.toMatchObject({ code: 'INVALID_UUID' });
    await expect(migrateLegacyLocalCredentialOnLogin(
      legacyUser(USER_UUID, bcryptVerifier),
      'first-login-secret',
      'legacy-default',
      port,
    )).rejects.toMatchObject({ code: 'INVALID_UUID' });
    expect(verifyBcrypt).not.toHaveBeenCalled();
    expect(insertMigratedUser).not.toHaveBeenCalled();
  });

  it('maps assignment keys without inventing target id or tenant columns and enforces shared tenant', () => {
    const assignment = mapLegacyUserProfileAssignment(
      { userId: USER_UUID, apiKeyId: API_KEY_UUID },
      TENANT_UUID,
      TENANT_UUID,
    );

    expect(assignment).toEqual({ userId: USER_UUID, apiKeyId: API_KEY_UUID });
    expect(Object.keys(assignment).sort()).toEqual(['apiKeyId', 'userId']);
    expect(() => mapLegacyUserProfileAssignment(
      { userId: USER_UUID, apiKeyId: API_KEY_UUID },
      TENANT_UUID,
      '66666666-6666-4666-8666-666666666666',
    )).toThrow();
    expect(() => mapLegacyUserProfileAssignment(
      { userId: 'legacy-user-id', apiKeyId: API_KEY_UUID },
      TENANT_UUID,
      TENANT_UUID,
    )).toThrow();
  });
});
