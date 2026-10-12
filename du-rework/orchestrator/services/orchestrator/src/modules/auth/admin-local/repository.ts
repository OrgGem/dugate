import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../../db/db';
import type { AuditService } from '../../audit/audit';
import { isLocalPasswordHash, type LocalPasswordHash } from './password';

export interface AdminLocalUser {
  id: string;
  tenantId: string;
  username: string;
  role: string;
  enabled: boolean;
  locked: boolean;
  /** Imported local principals requiring an administrator-provisioned password before first login. */
  legacyPasswordResetRequired: boolean;
  createdAt: string;
  updatedAt: string;
  version: number;
}

interface AdminLocalUserRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  username_normalized: string;
  role: string;
  is_enabled: boolean;
  is_locked: boolean;
  legacy_password_reset_required: boolean;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
}

export interface CreateAdminLocalUserInput {
  tenantId: string;
  username: string;
  passwordHash: LocalPasswordHash;
  actor: string;
}

export type AdminLocalUserIdentityRole = 'ADMIN' | 'USER' | 'VIEWER';

export type AdminLocalUserRolePolicyErrorCode =
  | 'INVALID_ROLE'
  | 'INVALID_CALLER_ROLE'
  | 'ROLE_ESCALATION_DENIED';

export class AdminLocalUserRolePolicyError extends Error {
  constructor(readonly code: AdminLocalUserRolePolicyErrorCode, message: string) {
    super(message);
    this.name = 'AdminLocalUserRolePolicyError';
  }
}

export interface CreateAdminLocalUserWithRoleInput extends CreateAdminLocalUserInput {
  /** Requested wire role; validated at runtime against ADMIN/USER/VIEWER. */
  role: unknown;
}

export interface AdminLocalUserCreationContext {
  /** Must be mapped from the server-authenticated caller, never request JSON. */
  callerRole: AdminLocalUserIdentityRole;
}

export interface SetAdminLocalUserStatusInput {
  tenantId: string;
  userId: string;
  enabled: boolean;
  locked: boolean;
  actor: string;
}

export interface AdminLocalUserTarget {
  tenantId: string;
  userId: string;
  actor: string;
}

export interface AdminLocalUserPasswordUpdate extends AdminLocalUserTarget {
  passwordHash: LocalPasswordHash;
}

export interface UpdateAdminLocalIdentityInput extends AdminLocalUserTarget {
  actorUserId: string;
  actorIssuer?: string;
  actorRole?: string;
  role: unknown;
  enabled: boolean;
  expectedVersion: number;
}

export interface ReplaceAdminLocalUserAssignmentsInput extends AdminLocalUserTarget {
  actorUserId: string;
  actorIssuer?: string;
  actorRole?: string;
  expectedVersion: number;
  profileIds: string[];
  apiKeyIds: string[];
}

export interface ResetAdminLocalUserPasswordInput extends AdminLocalUserTarget {
  actorUserId: string;
  actorIssuer?: string;
  actorRole?: string;
  expectedVersion: number;
  passwordHash: LocalPasswordHash;
}

export class AdminLocalIdentityMutationError extends Error {
  constructor(readonly code: 'IDENTITY_VERSION_CONFLICT' | 'SELF_LOCKOUT' | 'LAST_ADMIN_REQUIRED' | 'FOREIGN_GRANT' | 'GLOBAL_KEY_PROTECTED' | 'LEGACY_USER_LOCKED' | 'LEGACY_RESET_REQUIRED', message: string) {
    super(message);
    this.name = 'AdminLocalIdentityMutationError';
  }
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const IDENTITY_ROLE_TO_STORED_ROLE: Record<AdminLocalUserIdentityRole, string> = {
  ADMIN: 'admin',
  USER: 'operator',
  VIEWER: 'viewer',
};
const ROLE_RANK: Record<AdminLocalUserIdentityRole, number> = {
  ADMIN: 3,
  USER: 2,
  VIEWER: 1,
};

function isAdminLocalUserIdentityRole(value: unknown): value is AdminLocalUserIdentityRole {
  return value === 'ADMIN' || value === 'USER' || value === 'VIEWER';
}

function requireRequestedRole(value: unknown): AdminLocalUserIdentityRole {
  if (!isAdminLocalUserIdentityRole(value)) {
    throw new AdminLocalUserRolePolicyError('INVALID_ROLE', 'role must be ADMIN, USER, or VIEWER');
  }
  return value;
}

function requireCallerRole(value: unknown): AdminLocalUserIdentityRole {
  if (!isAdminLocalUserIdentityRole(value)) {
    throw new AdminLocalUserRolePolicyError('INVALID_CALLER_ROLE', 'server caller role is invalid');
  }
  return value;
}

function authorizeRoleAssignment(requestedRole: unknown, callerRoleInput: unknown): string {
  const requested = requireRequestedRole(requestedRole);
  const callerRole = requireCallerRole(callerRoleInput);
  if (ROLE_RANK[requested] > ROLE_RANK[callerRole]) {
    throw new AdminLocalUserRolePolicyError(
      'ROLE_ESCALATION_DENIED',
      'caller may not assign a role with greater privileges'
    );
  }
  return IDENTITY_ROLE_TO_STORED_ROLE[requested];
}

function requireTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || !UUID.test(tenantId)) {
    throw new Error('tenant scope is required');
  }
  return tenantId.toLowerCase();
}

function requireUserId(userId: string): string {
  if (typeof userId !== 'string' || !UUID.test(userId)) {
    throw new Error('user id is invalid');
  }
  return userId.toLowerCase();
}

function requireActor(actor: string): string {
  if (typeof actor !== 'string' || actor.trim().length === 0 || actor.length > 200) {
    throw new Error('audit actor is required');
  }
  return actor;
}

export function normalizeLocalUsername(username: string): string {
  if (typeof username !== 'string') throw new Error('username is invalid');
  const normalized = username.normalize('NFC').trim().toLowerCase();
  if (!USERNAME.test(normalized)) throw new Error('username is invalid');
  return normalized;
}

function toUser(row: AdminLocalUserRow): AdminLocalUser {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    username: row.username_normalized,
    role: row.role,
    enabled: row.is_enabled,
    locked: row.is_locked,
    legacyPasswordResetRequired: row.legacy_password_reset_required,
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    version: row.version,
  };
}

const SAFE_COLUMNS = `id, tenant_id, username_normalized, role, is_enabled, is_locked, legacy_password_reset_required,
                      created_at, updated_at, version`;

export function createAdminLocalUserRepository(db: Db, audit: AuditService) {
  async function replaceVerifier(
    input: AdminLocalUserPasswordUpdate,
    action: 'admin_local_user.password_reset' | 'admin_local_user.credentials_rotated' | 'admin_local_user.legacy_activated'
  ): Promise<AdminLocalUser | null> {
    const tenantId = requireTenantId(input.tenantId);
    const userId = requireUserId(input.userId);
    const actor = requireActor(input.actor);
    if (!isLocalPasswordHash(input.passwordHash)) {
      throw new Error('password hash format is invalid');
    }

    return db.tx(async (client: PoolClient) => {
      const result = await client.query<AdminLocalUserRow>(
        `UPDATE admin_local_users
         SET password_hash = $1, updated_at = now(), version = version + 1
             ${action === 'admin_local_user.legacy_activated' ? ', is_enabled = true, legacy_password_reset_required = false' : ''}
         WHERE tenant_id = $2 AND id = $3
           ${action === 'admin_local_user.legacy_activated' ? 'AND legacy_password_reset_required = true AND is_enabled = false AND is_locked = false' : ''}
         RETURNING ${SAFE_COLUMNS}`,
        [input.passwordHash, tenantId, userId]
      );
      const row = result.rows[0];
      if (!row) return null;
      await audit.record(
        {
          tenantId,
          actor,
          action,
          resource: `admin_local_user:${row.id}`,
          severity: 'warning',
        },
        client
      );
      return toUser(row);
    });
  }

  return {
    /**
     * Request-path creation. The caller role must come from the server's
     * authenticated session; validate it and the requested grant before any
     * database or audit side effect.
     */
    async createUser(
      input: CreateAdminLocalUserWithRoleInput,
      context: AdminLocalUserCreationContext
    ): Promise<AdminLocalUser> {
      const storedRole = authorizeRoleAssignment(input.role, context?.callerRole);
      const tenantId = requireTenantId(input.tenantId);
      const username = normalizeLocalUsername(input.username);
      const actor = requireActor(input.actor);
      if (!isLocalPasswordHash(input.passwordHash)) {
        throw new Error('password hash format is invalid');
      }

      return db.tx(async (client: PoolClient) => {
        const result = await client.query<AdminLocalUserRow>(
          `INSERT INTO admin_local_users
             (tenant_id, username_normalized, password_hash, role)
           VALUES ($1, $2, $3, $4)
           RETURNING ${SAFE_COLUMNS}`,
          [tenantId, username, input.passwordHash, storedRole]
        );
        const row = result.rows[0];
        if (!row) throw new Error('admin local user insert returned no row');
        await audit.record(
          {
            tenantId,
            actor,
            action: 'admin_local_user.create',
            resource: `admin_local_user:${row.id}`,
            severity: 'success',
          },
          client
        );
        return toUser(row);
      });
    },

    /** Bootstrap CLI only. Request-driven creation must use createUser(). */
    async createAdmin(input: CreateAdminLocalUserInput): Promise<AdminLocalUser> {
      const tenantId = requireTenantId(input.tenantId);
      const username = normalizeLocalUsername(input.username);
      const actor = requireActor(input.actor);
      if (!isLocalPasswordHash(input.passwordHash)) {
        throw new Error('password hash format is invalid');
      }

      return db.tx(async (client: PoolClient) => {
        const result = await client.query<AdminLocalUserRow>(
          `INSERT INTO admin_local_users
             (tenant_id, username_normalized, password_hash, role)
           VALUES ($1, $2, $3, 'admin')
           RETURNING ${SAFE_COLUMNS}`,
          [tenantId, username, input.passwordHash]
        );
        const row = result.rows[0];
        if (!row) throw new Error('admin local user insert returned no row');
        await audit.record(
          {
            tenantId,
            actor,
            action: 'admin_local_user.create',
            resource: `admin_local_user:${row.id}`,
            severity: 'success',
          },
          client
        );
        return toUser(row);
      });
    },

    async findById(tenantIdInput: string, userIdInput: string): Promise<AdminLocalUser | null> {
      const tenantId = requireTenantId(tenantIdInput);
      const userId = requireUserId(userIdInput);
      const result = await db.query<AdminLocalUserRow>(
        `SELECT ${SAFE_COLUMNS}
         FROM admin_local_users
         WHERE tenant_id = $1 AND id = $2`,
        [tenantId, userId]
      );
      return result.rows[0] ? toUser(result.rows[0]) : null;
    },

    async setStatus(input: SetAdminLocalUserStatusInput): Promise<AdminLocalUser | null> {
      const tenantId = requireTenantId(input.tenantId);
      const userId = requireUserId(input.userId);
      const actor = requireActor(input.actor);
      if (typeof input.enabled !== 'boolean' || typeof input.locked !== 'boolean') {
        throw new Error('user status is invalid');
      }

      return db.tx(async (client: PoolClient) => {
        if (input.enabled) {
          const current = await client.query<AdminLocalUserRow>(
            `SELECT ${SAFE_COLUMNS} FROM admin_local_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, userId]);
          if (current.rows[0]?.legacy_password_reset_required) {
            throw new AdminLocalIdentityMutationError('LEGACY_RESET_REQUIRED', 'set an administrator-provisioned password before enabling this imported identity');
          }
        }
        const result = await client.query<AdminLocalUserRow>(
          `UPDATE admin_local_users
           SET is_enabled = $1, is_locked = $2, updated_at = now(), version = version + 1
           WHERE tenant_id = $3 AND id = $4
           RETURNING ${SAFE_COLUMNS}`,
          [input.enabled, input.locked, tenantId, userId]
        );
        const row = result.rows[0];
        if (!row) return null;
        await audit.record(
          {
            tenantId,
            actor,
            action: 'admin_local_user.status',
            resource: `admin_local_user:${row.id}`,
            severity: input.enabled && !input.locked ? 'info' : 'warning',
          },
          client
        );
        return toUser(row);
      });
    },

    async disableAdmin(input: AdminLocalUserTarget): Promise<AdminLocalUser | null> {
      const tenantId = requireTenantId(input.tenantId);
      const userId = requireUserId(input.userId);
      const actor = requireActor(input.actor);

      return db.tx(async (client: PoolClient) => {
        const result = await client.query<AdminLocalUserRow>(
          `UPDATE admin_local_users
           SET is_enabled = false, updated_at = now(), version = version + 1
           WHERE tenant_id = $1 AND id = $2
           RETURNING ${SAFE_COLUMNS}`,
          [tenantId, userId]
        );
        const row = result.rows[0];
        if (!row) return null;
        await audit.record(
          {
            tenantId,
            actor,
            action: 'admin_local_user.disable',
            resource: `admin_local_user:${row.id}`,
            severity: 'warning',
          },
          client
        );
        return toUser(row);
      });
    },

    /** Operator CLI only: one-time activation after securely provisioning a new password. */
    async activateLegacyUser(input: AdminLocalUserPasswordUpdate): Promise<AdminLocalUser | null> {
      return replaceVerifier(input, 'admin_local_user.legacy_activated');
    },

    async resetPassword(input: AdminLocalUserPasswordUpdate): Promise<AdminLocalUser | null> {
      return replaceVerifier(input, 'admin_local_user.password_reset');
    },

    async rotateCredentials(input: AdminLocalUserPasswordUpdate): Promise<AdminLocalUser | null> {
      return replaceVerifier(input, 'admin_local_user.credentials_rotated');
    },

    /** Request-path role/status update with CAS, self-lockout and last-admin fences. */
    async updateIdentity(input: UpdateAdminLocalIdentityInput): Promise<AdminLocalUser | null> {
      const tenantId = requireTenantId(input.tenantId);
      const userId = requireUserId(input.userId);
      const actorUserId = requireActor(input.actorUserId);
      const actor = requireActor(input.actor);
      const role = requireRequestedRole(input.role);
      if (typeof input.enabled !== 'boolean' || !Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) {
        throw new Error('identity update is invalid');
      }
      const storedRole = IDENTITY_ROLE_TO_STORED_ROLE[role];
      return db.tx(async (client: PoolClient) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('admin-identity:' || $1, 0))`, [tenantId]);
        const currentResult = await client.query<AdminLocalUserRow>(
          `SELECT ${SAFE_COLUMNS} FROM admin_local_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, userId]);
        const current = currentResult.rows[0];
        if (!current) return null;
        if (current.version !== input.expectedVersion) {
          throw new AdminLocalIdentityMutationError('IDENTITY_VERSION_CONFLICT', 'identity version is stale');
        }
        if (input.enabled && current.legacy_password_reset_required) {
          throw new AdminLocalIdentityMutationError('LEGACY_RESET_REQUIRED', 'set an administrator-provisioned password before enabling this imported identity');
        }
        if (UUID.test(actorUserId) && actorUserId.toLowerCase() === userId && (!input.enabled || storedRole !== 'admin')) {
          throw new AdminLocalIdentityMutationError('SELF_LOCKOUT', 'an administrator cannot disable or demote the current account');
        }
        if (current.role === 'admin' && current.is_enabled && !current.is_locked && (!input.enabled || storedRole !== 'admin')) {
          const admins = await client.query<{ count: string }>(
            `SELECT count(*)::text AS count FROM admin_local_users
             WHERE tenant_id=$1 AND role='admin' AND is_enabled=true AND is_locked=false`, [tenantId]);
          if (Number(admins.rows[0]?.count ?? 0) <= 1) {
            throw new AdminLocalIdentityMutationError('LAST_ADMIN_REQUIRED', 'the last enabled administrator cannot be removed');
          }
        }
        const updated = await client.query<AdminLocalUserRow>(
          `UPDATE admin_local_users SET role=$1, is_enabled=$2, updated_at=now(), version=version+1
           WHERE tenant_id=$3 AND id=$4 AND version=$5 RETURNING ${SAFE_COLUMNS}`,
          [storedRole, input.enabled, tenantId, userId, input.expectedVersion]);
        const row = updated.rows[0];
        if (!row) throw new AdminLocalIdentityMutationError('IDENTITY_VERSION_CONFLICT', 'identity version is stale');
        await audit.record({ tenantId, actor, actorIssuer: input.actorIssuer, actorSub: actorUserId, actorRole: input.actorRole ?? 'ADMIN',
          action: 'admin_local_user.update', resource: `admin_local_user:${row.id}`,
          severity: !input.enabled || storedRole !== 'admin' ? 'warning' : 'info' }, client);
        return toUser(row);
      });
    },

    /** Replaces a local password and increments the DB version checked by all replicas. */
    async resetIdentityPassword(input: ResetAdminLocalUserPasswordInput): Promise<AdminLocalUser | null> {
      const tenantId = requireTenantId(input.tenantId);
      const userId = requireUserId(input.userId);
      const actor = requireActor(input.actor);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !isLocalPasswordHash(input.passwordHash)) {
        throw new Error('password reset is invalid');
      }
      return db.tx(async (client: PoolClient) => {
        const current = await client.query<AdminLocalUserRow>(
          `SELECT ${SAFE_COLUMNS} FROM admin_local_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, userId]);
        if (!current.rows[0]) return null;
        const existing = current.rows[0];
        if (existing.version !== input.expectedVersion) {
          throw new AdminLocalIdentityMutationError('IDENTITY_VERSION_CONFLICT', 'identity version is stale');
        }
        const isPendingLegacy = existing.legacy_password_reset_required && !existing.is_enabled;
        if (isPendingLegacy && existing.is_locked) {
          throw new AdminLocalIdentityMutationError('LEGACY_USER_LOCKED', 'a locked imported identity must be unlocked before its activation password can be set');
        }
        const legacyActivation = isPendingLegacy && !existing.is_locked;
        const updated = await client.query<AdminLocalUserRow>(
          `UPDATE admin_local_users SET password_hash=$1,
             is_enabled=CASE WHEN $5 THEN true ELSE is_enabled END,
             legacy_password_reset_required=CASE WHEN $5 THEN false ELSE legacy_password_reset_required END,
             updated_at=now(), version=version+1
           WHERE tenant_id=$2 AND id=$3 AND version=$4 RETURNING ${SAFE_COLUMNS}`,
          [input.passwordHash, tenantId, userId, input.expectedVersion, legacyActivation]);
        const row = updated.rows[0];
        if (!row) throw new AdminLocalIdentityMutationError('IDENTITY_VERSION_CONFLICT', 'identity version is stale');
        await audit.record({ tenantId, actor, actorIssuer: input.actorIssuer, actorSub: input.actorUserId, actorRole: input.actorRole ?? 'ADMIN', action: legacyActivation ? 'admin_local_user.legacy_activated' : 'admin_local_user.password_reset',
          resource: `admin_local_user:${row.id}`, severity: 'warning' }, client);
        return toUser(row);
      });
    },

    /** Replace key/profile grants all-or-nothing; the version bump revokes existing local sessions cluster-wide. */
    async replaceAssignments(input: ReplaceAdminLocalUserAssignmentsInput): Promise<{ user: AdminLocalUser; assignmentVersion: number } | null> {
      const tenantId = requireTenantId(input.tenantId);
      const userId = requireUserId(input.userId);
      const actorUserId = requireActor(input.actorUserId);
      const actor = requireActor(input.actor);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1 || !Array.isArray(input.profileIds) || !Array.isArray(input.apiKeyIds)) {
        throw new Error('assignment set is invalid');
      }
      const profileIds = [...new Set(input.profileIds.map(requireUserId))].sort();
      const apiKeyIds = [...new Set(input.apiKeyIds.map(requireUserId))].sort();
      if (profileIds.length !== input.profileIds.length || apiKeyIds.length !== input.apiKeyIds.length || profileIds.length > 500 || apiKeyIds.length > 500) {
        throw new Error('assignment set is invalid');
      }
      return db.tx(async (client: PoolClient) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('admin-identity:' || $1, 0))`, [tenantId]);
        const current = await client.query<AdminLocalUserRow & { assignment_version: number }>(
          `SELECT ${SAFE_COLUMNS}, assignment_version FROM admin_local_users WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [tenantId, userId]);
        const row = current.rows[0];
        if (!row) return null;
        if (row.assignment_version !== input.expectedVersion) {
          throw new AdminLocalIdentityMutationError('IDENTITY_VERSION_CONFLICT', 'assignment version is stale');
        }
        const profiles = profileIds.length
          ? await client.query<{ profile_id: string }>(
            `SELECT profile_id FROM profile_names WHERE tenant_id=$1 AND profile_id=ANY($2::uuid[])`, [tenantId, profileIds])
          : { rows: [] };
        const keys = apiKeyIds.length
          ? await client.query<{ id: string; name: string | null }>(
            `SELECT id, name FROM api_keys WHERE tenant_id=$1 AND id=ANY($2::uuid[]) AND status='ACTIVE' FOR SHARE`, [tenantId, apiKeyIds])
          : { rows: [] };
        if (profiles.rows.length !== profileIds.length || keys.rows.length !== apiKeyIds.length) {
          throw new AdminLocalIdentityMutationError('FOREIGN_GRANT', 'assignment set contains a foreign, disabled, or missing grant');
        }
        if (keys.rows.some((key) => key.name?.trim().toLowerCase() === 'global')) {
          throw new AdminLocalIdentityMutationError('GLOBAL_KEY_PROTECTED', 'the Global key cannot be assigned to a local user');
        }
        await client.query('DELETE FROM admin_local_user_profile_grants WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
        await client.query('DELETE FROM admin_local_user_api_key_grants WHERE tenant_id=$1 AND user_id=$2', [tenantId, userId]);
        if (profileIds.length) await client.query(
          `INSERT INTO admin_local_user_profile_grants (tenant_id,user_id,profile_id)
           SELECT $1,$2,unnest($3::uuid[])`, [tenantId, userId, profileIds]);
        if (apiKeyIds.length) await client.query(
          `INSERT INTO admin_local_user_api_key_grants (tenant_id,user_id,api_key_id)
           SELECT $1,$2,unnest($3::uuid[])`, [tenantId, userId, apiKeyIds]);
        const updated = await client.query<AdminLocalUserRow & { assignment_version: number }>(
          `UPDATE admin_local_users SET assignment_version=assignment_version+1, version=version+1, updated_at=now()
           WHERE tenant_id=$1 AND id=$2 AND assignment_version=$3 RETURNING ${SAFE_COLUMNS}, assignment_version`,
          [tenantId, userId, input.expectedVersion]);
        const next = updated.rows[0];
        if (!next) throw new AdminLocalIdentityMutationError('IDENTITY_VERSION_CONFLICT', 'assignment version is stale');
        await audit.record({ tenantId, actor, actorIssuer: input.actorIssuer, actorSub: actorUserId, actorRole: input.actorRole ?? 'ADMIN',
          action: 'admin_local_user.assignments.replace', resource: `admin_local_user:${userId}`, severity: 'warning' }, client);
        return { user: toUser(next), assignmentVersion: next.assignment_version };
      });
    },

    async getAssignments(tenantIdInput: string, userIdInput: string): Promise<{ userId: string; version: number; profileIds: string[]; apiKeyIds: string[] } | null> {
      const tenantId = requireTenantId(tenantIdInput);
      const userId = requireUserId(userIdInput);
      const user = await db.query<{ assignment_version: number }>(
        'SELECT assignment_version FROM admin_local_users WHERE tenant_id=$1 AND id=$2', [tenantId, userId]);
      if (!user.rows[0]) return null;
      const [profiles, keys] = await Promise.all([
        db.query<{ profile_id: string }>('SELECT profile_id FROM admin_local_user_profile_grants WHERE tenant_id=$1 AND user_id=$2 ORDER BY profile_id', [tenantId, userId]),
        db.query<{ api_key_id: string }>('SELECT api_key_id FROM admin_local_user_api_key_grants WHERE tenant_id=$1 AND user_id=$2 ORDER BY api_key_id', [tenantId, userId]),
      ]);
      return { userId, version: user.rows[0].assignment_version, profileIds: profiles.rows.map((item) => item.profile_id), apiKeyIds: keys.rows.map((item) => item.api_key_id) };
    },
  };
}

export type AdminLocalUserRepository = ReturnType<typeof createAdminLocalUserRepository>;
