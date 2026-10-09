import {
  hashLocalPassword,
  isLocalPasswordHash,
  type LocalPasswordHash,
} from '../auth/admin-local/password';
import { normalizeLocalUsername } from '../auth/admin-local/repository';

export type LegacyIdentityRole = 'ADMIN' | 'USER' | 'VIEWER';
export type ReworkIdentityRole = 'admin' | 'operator' | 'viewer';

export interface LegacyUserForIdentityMigration {
  id: string;
  username: string;
  password: string;
  role: unknown;
  provider?: string | null;
  providerSub?: string | null;
  email?: string | null;
  displayName?: string | null;
}

export interface LegacyLocalIdentity {
  id: string;
  tenantId: string;
  usernameNormalized: string;
  role: ReworkIdentityRole;
  isEnabled: true;
  isLocked: false;
}

export interface MigratedLocalIdentity extends LegacyLocalIdentity {
  passwordHash: LocalPasswordHash;
}

export interface LegacyUserProfileAssignment {
  userId: string;
  apiKeyId: string;
}

export interface ReworkUserProfileAssignment {
  userId: string;
  apiKeyId: string;
}

export interface LegacyIdentityMigrationPort {
  verifyBcrypt(password: string, verifier: string): Promise<boolean>;
  /**
   * Insert the mapped user only when its identity is absent. Implement this
   * through one transaction and the target uniqueness constraints. Return
   * conflict when a concurrent or prior login already created the target;
   * the caller must then restart authentication through the scrypt path.
   */
  insertMigratedUser(identity: MigratedLocalIdentity): Promise<'inserted' | 'conflict'>;
}

export type LegacyCredentialMigrationResult =
  | { status: 'migrated'; identity: LegacyLocalIdentity }
  | { status: 'rejected' }
  | { status: 'password-reset-required' }
  | { status: 'unsupported-provider' }
  | { status: 'verification-unavailable' }
  | { status: 'write-conflict' }
  | { status: 'write-failed' }
  | { status: 'scrypt-failed' };

export class LegacyIdentityMappingError extends Error {
  constructor(
    readonly code: 'INVALID_UUID' | 'INVALID_USERNAME' | 'INVALID_ROLE' | 'CROSS_TENANT_ASSIGNMENT',
    message: string,
  ) {
    super(message);
    this.name = 'LegacyIdentityMappingError';
  }
}

const LEGACY_ROLE_MAP: Record<LegacyIdentityRole, ReworkIdentityRole> = {
  ADMIN: 'admin',
  USER: 'operator',
  VIEWER: 'viewer',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BCRYPT_VERIFIER = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

function requireUuid(value: unknown): string {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new LegacyIdentityMappingError('INVALID_UUID', 'legacy identity contains an invalid UUID');
  }
  return value.toLowerCase();
}

export function mapLegacyRole(role: unknown): ReworkIdentityRole {
  if (role !== 'ADMIN' && role !== 'USER' && role !== 'VIEWER') {
    throw new LegacyIdentityMappingError('INVALID_ROLE', 'legacy role is outside the supported identity domain');
  }
  return LEGACY_ROLE_MAP[role];
}

function mapLegacyUser(
  user: LegacyUserForIdentityMigration,
  legacyDefaultTenantId: string,
): LegacyLocalIdentity {
  const id = requireUuid(user.id);
  const tenantId = requireUuid(legacyDefaultTenantId);
  let usernameNormalized: string;
  try {
    usernameNormalized = normalizeLocalUsername(user.username);
  } catch {
    throw new LegacyIdentityMappingError('INVALID_USERNAME', 'legacy username is outside the local identity domain');
  }

  return {
    id,
    tenantId,
    usernameNormalized,
    role: mapLegacyRole(user.role),
    isEnabled: true,
    isLocked: false,
  };
}

function hasExternalProvider(user: LegacyUserForIdentityMigration): boolean {
  return (user.provider !== null && user.provider !== undefined && user.provider.length > 0)
    || (user.providerSub !== null && user.providerSub !== undefined && user.providerSub.length > 0);
}

/**
 * Verify the retained legacy bcrypt value only during a successful first
 * rework login, then create a target identity whose password_hash satisfies
 * the fixed scrypt CHECK. The legacy verifier is never copied to the target.
 */
export async function migrateLegacyLocalCredentialOnLogin(
  user: LegacyUserForIdentityMigration,
  password: string,
  legacyDefaultTenantId: string,
  port: LegacyIdentityMigrationPort,
): Promise<LegacyCredentialMigrationResult> {
  if (hasExternalProvider(user)) return { status: 'unsupported-provider' };

  const identity = mapLegacyUser(user, legacyDefaultTenantId);
  if (typeof user.password !== 'string' || !BCRYPT_VERIFIER.test(user.password)) {
    return { status: 'password-reset-required' };
  }
  if (typeof password !== 'string' || password.length === 0) {
    return { status: 'rejected' };
  }

  let verified: boolean;
  try {
    verified = await port.verifyBcrypt(password, user.password);
  } catch {
    return { status: 'verification-unavailable' };
  }
  if (!verified) return { status: 'rejected' };

  let passwordHash: LocalPasswordHash;
  try {
    passwordHash = await hashLocalPassword(password);
  } catch {
    return { status: 'scrypt-failed' };
  }
  if (!isLocalPasswordHash(passwordHash)) return { status: 'scrypt-failed' };

  try {
    const inserted = await port.insertMigratedUser({ ...identity, passwordHash });
    if (inserted !== 'inserted') return { status: 'write-conflict' };
  } catch {
    return { status: 'write-failed' };
  }

  return { status: 'migrated', identity };
}

/**
 * The target assignment table has only the composite user/key primary key.
 * Its tenant is inherited, so both referenced rows must resolve to the same
 * seeded legacy-default tenant before this pair is written.
 */
export function mapLegacyUserProfileAssignment(
  assignment: LegacyUserProfileAssignment,
  userTenantId: string,
  apiKeyTenantId: string,
): ReworkUserProfileAssignment {
  const userId = requireUuid(assignment.userId);
  const apiKeyId = requireUuid(assignment.apiKeyId);
  const resolvedUserTenantId = requireUuid(userTenantId);
  const resolvedApiKeyTenantId = requireUuid(apiKeyTenantId);
  if (resolvedUserTenantId !== resolvedApiKeyTenantId) {
    throw new LegacyIdentityMappingError(
      'CROSS_TENANT_ASSIGNMENT',
      'legacy profile assignment references different target tenants',
    );
  }
  return { userId, apiKeyId };
}
