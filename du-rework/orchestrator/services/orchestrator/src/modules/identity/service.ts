import type { IdentityAssignableUser, IdentityAssignableUserPage, IdentityRole, IdentitySnapshot, IdentityUser, IdentityUserPage } from '@du/contracts';
import type { QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import type { AuditService } from '../audit/audit';
import {
  AdminLocalIdentityMutationError,
  AdminLocalUserRolePolicyError,
  createAdminLocalUserRepository,
  type AdminLocalUser,
  type AdminLocalUserIdentityRole,
} from '../auth/admin-local';
import { hashLocalPassword } from '../auth/admin-local/password';
import { HttpError } from '../../http/errors';

interface UserRow extends QueryResultRow {
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
  assignment_version?: number;
}

interface CursorValue { createdAt: string; id: string }

/**
 * Local USER operation visibility is the intersection of a current live
 * local session, an explicitly assigned active non-Global API key, and an
 * assigned Profile when the historical operation has one. Profile access
 * does not widen access to every key used by other operations in that
 * Profile; key-only access remains valid for legacy operations without a
 * profile pin.
 */
export function hasLocalUserOperationAssignment(input: {
  hasApiKey: boolean;
  currentUser: boolean;
  activeNonGlobalApiKey: boolean;
  assignedApiKey: boolean;
  profileId: string | null;
  assignedProfile: boolean;
}): boolean {
  return input.hasApiKey
    && input.currentUser
    && input.activeNonGlobalApiKey
    && input.assignedApiKey
    && (input.profileId === null || input.assignedProfile);
}

function parseCursor(cursor: string | null | undefined): CursorValue | null {
  if (!cursor) return null;
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as Partial<CursorValue>;
    if (typeof parsed.createdAt !== 'string' || Number.isNaN(Date.parse(parsed.createdAt)) || typeof parsed.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(parsed.id)) {
      throw new Error('invalid cursor');
    }
    return { createdAt: parsed.createdAt, id: parsed.id };
  } catch {
    throw new HttpError(422, 'INVALID_SCHEMA', 'identity cursor is invalid');
  }
}

function encodeCursor(value: CursorValue): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function wireRole(role: string): IdentityRole {
  if (role === 'admin') return 'ADMIN';
  if (role === 'operator') return 'USER';
  if (role === 'viewer') return 'VIEWER';
  throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'stored identity role is invalid');
}

function wireUser(user: AdminLocalUser): IdentityUser {
  return {
    id: user.id,
    username: user.username,
    role: wireRole(user.role),
    enabled: user.enabled,
    locked: user.locked,
    legacyPasswordResetRequired: user.legacyPasswordResetRequired,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
    version: user.version,
  };
}

function assignable(row: UserRow): IdentityAssignableUser | null {
  if (!row.is_enabled || row.is_locked || !['admin', 'operator'].includes(row.role)) return null;
  return {
    id: row.id,
    username: row.username_normalized,
    role: row.role === 'admin' ? 'ADMIN' : 'USER',
    tenantId: row.tenant_id,
    enabled: true,
  };
}

export interface IdentityScope { tenantId: string }
export interface IdentityActor {
  /** Stable actor string from the trusted BFF context; never request JSON. */
  actor: string;
  /** Role derived from the authenticated server session. */
  role: AdminLocalUserIdentityRole;
  issuer?: string;
  sub?: string;
  roleVersion?: number;
}

export interface IdentityUserListQuery {
  tenantId: string;
  query?: string;
  cursor?: string | null;
  limit?: number;
}

export interface IdentityAssignableQuery extends IdentityUserListQuery {}

function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 250) throw new HttpError(422, 'INVALID_SCHEMA', 'identity page limit must be 1..250');
  return value;
}

export function createAdminIdentityService(deps: {
  db: Db;
  audit: AuditService;
  auth: IdentitySnapshot['auth'];
}) {
  const users = createAdminLocalUserRepository(deps.db, deps.audit);

  async function listIdentityUsers(input: IdentityUserListQuery): Promise<IdentityUserPage> {
    const limit = normalizeLimit(input.limit);
    const query = input.query?.trim().slice(0, 128) ?? '';
    const cursor = parseCursor(input.cursor);
    const args: unknown[] = [input.tenantId];
    const where = ['tenant_id=$1'];
    if (query) { args.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`); where.push(`username_normalized ILIKE $${args.length} ESCAPE '\\'`); }
    if (cursor) { args.push(cursor.createdAt, cursor.id); where.push(`(created_at,id)<($${args.length - 1}::timestamptz,$${args.length}::uuid)`); }
    const countArgs = args.slice(0, query ? 2 : 1);
    const [result, count] = await Promise.all([
      deps.db.query<UserRow>(
      `SELECT id,tenant_id,username_normalized,role,is_enabled,is_locked,legacy_password_reset_required,created_at,updated_at,version,assignment_version
           FROM admin_local_users WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`,
        args),
      deps.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM admin_local_users WHERE ${where.filter((part) => !part.startsWith('(created_at,id)')).join(' AND ')}`, countArgs),
    ]);
    const hasMore = result.rows.length > limit;
    const rows = result.rows.slice(0, limit);
    const items = rows.map((row) => wireUser({
      id: row.id, tenantId: row.tenant_id, username: row.username_normalized, role: row.role,
      enabled: row.is_enabled, locked: row.is_locked,
      legacyPasswordResetRequired: row.legacy_password_reset_required,
      createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
      updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
      version: row.version,
    }));
    const last = rows.at(-1);
    return {
      items,
      nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at instanceof Date ? last.created_at.toISOString() : String(last.created_at), id: last.id }) : null,
      prevCursor: null,
      total: Number(count.rows[0]?.total ?? 0),
      limit,
    };
  }

  return {
    async snapshot(tenantId: string): Promise<IdentitySnapshot> {
      const result = await listIdentityUsers({ tenantId, limit: 250 });
      return { users: result.items, capabilities: { userWriter: deps.auth.localEnabled }, auth: deps.auth };
    },

    async listUsers(input: IdentityUserListQuery): Promise<IdentityUserPage> {
      return listIdentityUsers(input);
    },

    async getUser(input: { tenantId: string; userId: string }): Promise<IdentityUser | null> {
      const result = await deps.db.query<UserRow>(
        `SELECT id,tenant_id,username_normalized,role,is_enabled,is_locked,legacy_password_reset_required,created_at,updated_at,version
           FROM admin_local_users WHERE tenant_id=$1 AND id=$2`,
        [input.tenantId, input.userId],
      );
      const row = result.rows[0];
      if (!row) return null;
      return {
        id: row.id,
        username: row.username_normalized,
        role: wireRole(row.role),
        enabled: row.is_enabled,
        locked: row.is_locked,
        legacyPasswordResetRequired: row.legacy_password_reset_required,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
        updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
        version: row.version,
      };
    },

    async createUser(input: { tenantId: string; username: string; password: string; role: IdentityRole }, actor: IdentityActor): Promise<IdentityUser> {
      if (actor.role !== 'ADMIN') throw new HttpError(403, 'PERMISSION_DENIED', 'only an administrator can create identities');
      if (!deps.auth.localEnabled) throw new HttpError(409, 'LOCAL_AUTH_DISABLED', 'local identity creation is disabled');
      const passwordHash = await hashLocalPassword(input.password);
      try {
        const user = await users.createUser({ tenantId: input.tenantId, username: input.username, passwordHash, actor: actor.actor, role: input.role }, { callerRole: actor.role });
        return wireUser(user);
      } catch (error) { throw mapIdentityError(error); }
    },

    async updateUser(input: { tenantId: string; userId: string; role: IdentityRole; enabled: boolean; expectedVersion: number }, actor: IdentityActor): Promise<IdentityUser> {
      if (actor.role !== 'ADMIN') throw new HttpError(403, 'PERMISSION_DENIED', 'only an administrator can update identities');
      try {
        const user = await users.updateIdentity({ ...input, actor: actor.actor, actorUserId: actor.sub ?? actor.actor,
          ...(actor.issuer ? { actorIssuer: actor.issuer } : {}), actorRole: actor.role });
        if (!user) throw new HttpError(404, 'NOT_FOUND', 'identity was not found in this tenant');
        return wireUser(user);
      } catch (error) { throw mapIdentityError(error); }
    },

    async resetPassword(input: { tenantId: string; userId: string; password: string; expectedVersion: number }, actor: IdentityActor): Promise<IdentityUser> {
      if (actor.role !== 'ADMIN') throw new HttpError(403, 'PERMISSION_DENIED', 'only an administrator can reset local passwords');
      if (!deps.auth.localEnabled) throw new HttpError(409, 'LOCAL_AUTH_DISABLED', 'local identity password reset is disabled');
      const passwordHash = await hashLocalPassword(input.password);
      try {
        const user = await users.resetIdentityPassword({ ...input, passwordHash, actor: actor.actor, actorUserId: actor.sub ?? actor.actor,
          ...(actor.issuer ? { actorIssuer: actor.issuer } : {}), actorRole: actor.role });
        if (!user) throw new HttpError(404, 'NOT_FOUND', 'local identity was not found in this tenant');
        return wireUser(user);
      } catch (error) { throw mapIdentityError(error); }
    },

    async getAssignments(tenantId: string, userId: string) {
      const result = await users.getAssignments(tenantId, userId);
      if (!result) throw new HttpError(404, 'NOT_FOUND', 'identity was not found in this tenant');
      return result;
    },

    async replaceAssignments(input: { tenantId: string; userId: string; expectedVersion: number; profileIds: string[]; apiKeyIds: string[] }, actor: IdentityActor) {
      if (actor.role !== 'ADMIN') throw new HttpError(403, 'PERMISSION_DENIED', 'only an administrator can assign identities');
      try {
        const result = await users.replaceAssignments({ ...input, actor: actor.actor, actorUserId: actor.sub ?? actor.actor,
          ...(actor.issuer ? { actorIssuer: actor.issuer } : {}), actorRole: actor.role });
        if (!result) throw new HttpError(404, 'NOT_FOUND', 'identity was not found in this tenant');
        return { user: wireUser(result.user), version: result.assignmentVersion,
          profileIds: input.profileIds, apiKeyIds: input.apiKeyIds };
      } catch (error) { throw mapIdentityError(error); }
    },

    async listAssignableUsers(input: IdentityAssignableQuery): Promise<IdentityAssignableUserPage> {
      return listAssignable(deps.db, { ...input, tenantId: input.tenantId, roleFilter: "role IN ('admin','operator')" });
    },

    /** Tenant-fenced read projection for trusted incident/owner selectors. */
    async searchAssignableIdentityUsers(input: IdentityAssignableQuery): Promise<IdentityAssignableUserPage> {
      return listAssignable(deps.db, { ...input, tenantId: input.tenantId, roleFilter: "role IN ('admin','operator')" });
    },

    async resolveAssignableIdentityOwner(input: { tenantId: string; userId: string }): Promise<IdentityAssignableUser | null> {
      const result = await deps.db.query<UserRow>(
        `SELECT id,tenant_id,username_normalized,role,is_enabled,is_locked,created_at,updated_at,version
           FROM admin_local_users WHERE tenant_id=$1 AND id=$2 AND is_enabled=true AND is_locked=false AND role IN ('admin','operator')`,
        [input.tenantId, input.userId]);
      return result.rows[0] ? assignable(result.rows[0]) : null;
    },

    async searchAssignablePlatformIdentityUsers(input: { query?: string; cursor?: string | null; limit?: number }): Promise<IdentityAssignableUserPage> {
      return listAssignable(deps.db, { ...input, tenantId: null, roleFilter: "role='admin'" });
    },

    async resolveAssignablePlatformIdentityOwner(input: { userId: string }): Promise<IdentityAssignableUser | null> {
      const result = await deps.db.query<UserRow>(
        `SELECT id,tenant_id,username_normalized,role,is_enabled,is_locked,created_at,updated_at,version
           FROM admin_local_users WHERE id=$1 AND is_enabled=true AND is_locked=false AND role='admin'`, [input.userId]);
      return result.rows[0] ? assignable(result.rows[0]) : null;
    },

    /** True only for an explicit active user→profile grant in the exact tenant. */
    async isLocalUserAssignedProfile(input: { tenantId: string; userId: string; profileId: string }): Promise<boolean> {
      const result = await deps.db.query<{ ok: boolean }>(
        `SELECT EXISTS(SELECT 1 FROM admin_local_users u JOIN admin_local_user_profile_grants g
            ON g.user_id=u.id AND g.tenant_id=u.tenant_id
          WHERE u.id=$1 AND u.tenant_id=$2 AND u.role='operator' AND u.is_enabled=true AND u.is_locked=false AND g.profile_id=$3) AS ok`,
        [input.userId, input.tenantId, input.profileId]);
      return result.rows[0]?.ok === true;
    },

    /**
     * Authoritative grants for a trusted local USER session. A current row
     * version is mandatory so a role/password/assignment mutation on another
     * Orchestrator replica immediately invalidates the old caller context.
     * Callers must first require trusted `issuer === 'du-local'`; this method
     * never accepts a browser-supplied subject or role version.
     */
    async getLocalUserOperationScope(input: { tenantId: string; userId: string; roleVersion: number }): Promise<{
      tenantId: string;
      userId: string;
      roleVersion: number;
      profileIds: string[];
      apiKeyIds: string[];
    } | null> {
      if (!Number.isSafeInteger(input.roleVersion) || input.roleVersion < 1) return null;
      const user = await deps.db.query<{ version: number; profile_ids: string[]; api_key_ids: string[] }>(
        `SELECT u.version,
                COALESCE((SELECT array_agg(g.profile_id ORDER BY g.profile_id)
                            FROM admin_local_user_profile_grants g
                            JOIN profile_names p ON p.tenant_id=g.tenant_id AND p.profile_id=g.profile_id
                           WHERE g.tenant_id=u.tenant_id AND g.user_id=u.id), ARRAY[]::uuid[]) AS profile_ids,
                COALESCE((SELECT array_agg(g.api_key_id ORDER BY g.api_key_id)
                            FROM admin_local_user_api_key_grants g
                            JOIN api_keys k ON k.id=g.api_key_id AND k.tenant_id=g.tenant_id
                           WHERE g.tenant_id=u.tenant_id AND g.user_id=u.id AND k.status='ACTIVE'
                             AND lower(trim(coalesce(k.name,''))) <> 'global'), ARRAY[]::uuid[]) AS api_key_ids
           FROM admin_local_users u
          WHERE u.tenant_id=$1 AND u.id=$2 AND u.role='operator' AND u.is_enabled=true AND u.is_locked=false AND u.version=$3`,
        [input.tenantId, input.userId, input.roleVersion]);
      const row = user.rows[0];
      if (!row) return null;
      return {
        tenantId: input.tenantId,
        userId: input.userId,
        roleVersion: input.roleVersion,
        profileIds: row.profile_ids,
        apiKeyIds: row.api_key_ids,
      };
    },

    /** Assignment check for per-operation detail and lifecycle fences. */
    async isLocalUserAssignedOperation(input: { tenantId: string; userId: string; roleVersion: number; operationId: string }): Promise<boolean> {
      if (!Number.isSafeInteger(input.roleVersion) || input.roleVersion < 1) return false;
      const result = await deps.db.query<{
        api_key_id: string | null;
        profile_id: string | null;
        current_user: boolean;
        active_non_global_api_key: boolean;
        assigned_api_key: boolean;
        assigned_profile: boolean;
      }>(
        `SELECT o.api_key_id,o.profile_id,
                EXISTS (SELECT 1 FROM admin_local_users u
                         WHERE u.tenant_id=o.tenant_id AND u.id=$2 AND u.role='operator'
                           AND u.is_enabled=true AND u.is_locked=false AND u.version=$4) AS current_user,
                EXISTS (SELECT 1 FROM api_keys k
                         WHERE k.tenant_id=o.tenant_id AND k.id=o.api_key_id AND k.status='ACTIVE'
                           AND lower(trim(coalesce(k.name,''))) <> 'global') AS active_non_global_api_key,
                EXISTS (SELECT 1 FROM admin_local_user_api_key_grants kg
                         WHERE kg.tenant_id=o.tenant_id AND kg.user_id=$2 AND kg.api_key_id=o.api_key_id) AS assigned_api_key,
                (o.profile_id IS NULL OR EXISTS (
                  SELECT 1 FROM admin_local_user_profile_grants pg
                   WHERE pg.tenant_id=o.tenant_id AND pg.user_id=$2 AND pg.profile_id=o.profile_id)) AS assigned_profile
           FROM operations o
          WHERE o.id=$1 AND o.tenant_id=$3 AND o.deleted_at IS NULL`,
        [input.operationId, input.userId, input.tenantId, input.roleVersion]);
      const row = result.rows[0];
      return row ? hasLocalUserOperationAssignment({
        hasApiKey: row.api_key_id !== null,
        currentUser: row.current_user,
        activeNonGlobalApiKey: row.active_non_global_api_key,
        assignedApiKey: row.assigned_api_key,
        profileId: row.profile_id,
        assignedProfile: row.assigned_profile,
      }) : false;
    },

    /** Explicit local USER assignment check for routes that address a key. */
    async isLocalUserAssignedApiKey(input: { tenantId: string; userId: string; roleVersion: number; apiKeyId: string }): Promise<boolean> {
      if (!Number.isSafeInteger(input.roleVersion) || input.roleVersion < 1) return false;
      const result = await deps.db.query<{ ok: boolean }>(
        `SELECT EXISTS(
           SELECT 1
             FROM admin_local_users u
             JOIN admin_local_user_api_key_grants g ON g.tenant_id=u.tenant_id AND g.user_id=u.id
             JOIN api_keys k ON k.tenant_id=g.tenant_id AND k.id=g.api_key_id
            WHERE u.tenant_id=$1 AND u.id=$2 AND u.role='operator'
              AND u.is_enabled=true AND u.is_locked=false AND u.version=$3
              AND g.api_key_id=$4 AND k.status='ACTIVE'
              AND lower(trim(coalesce(k.name,''))) <> 'global'
         ) AS ok`,
        [input.tenantId, input.userId, input.roleVersion, input.apiKeyId]);
      return result.rows[0]?.ok === true;
    },
  };
}

async function listAssignable(db: Db, input: { tenantId: string | null; query?: string; cursor?: string | null; limit?: number; roleFilter: string }): Promise<IdentityAssignableUserPage> {
  const limit = normalizeLimit(input.limit);
  const query = input.query?.trim().slice(0, 128) ?? '';
  const cursor = parseCursor(input.cursor);
  const args: unknown[] = [];
  const where = [input.roleFilter, 'is_enabled=true', 'is_locked=false'];
  if (input.tenantId !== null) { args.push(input.tenantId); where.push(`tenant_id=$${args.length}`); }
  if (query) { args.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`); where.push(`username_normalized ILIKE $${args.length} ESCAPE '\\'`); }
  const countArgs = [...args];
  if (cursor) { args.push(cursor.createdAt, cursor.id); where.push(`(created_at,id)<($${args.length - 1}::timestamptz,$${args.length}::uuid)`); }
  const [result, count] = await Promise.all([
    db.query<UserRow>(`SELECT id,tenant_id,username_normalized,role,is_enabled,is_locked,created_at,updated_at,version FROM admin_local_users WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`, args),
    db.query<{ total: number }>(`SELECT count(*)::int AS total FROM admin_local_users WHERE ${where.filter((part) => !part.startsWith('(created_at,id)')).join(' AND ')}`, countArgs),
  ]);
  const hasMore = result.rows.length > limit;
  const rows = result.rows.slice(0, limit);
  const items = rows.map(assignable).filter((user): user is IdentityAssignableUser => user !== null);
  const last = rows.at(-1);
  return { items, nextCursor: hasMore && last ? encodeCursor({ createdAt: last.created_at instanceof Date ? last.created_at.toISOString() : String(last.created_at), id: last.id }) : null,
    prevCursor: null, total: Number(count.rows[0]?.total ?? 0), limit };
}

function mapIdentityError(error: unknown): never {
  if (error instanceof HttpError) throw error;
  if (error instanceof AdminLocalIdentityMutationError) {
    const status = error.code === 'IDENTITY_VERSION_CONFLICT' ? 409 : error.code === 'FOREIGN_GRANT' || error.code === 'GLOBAL_KEY_PROTECTED' ? 422 : 409;
    throw new HttpError(status, error.code, error.message);
  }
  if (error instanceof AdminLocalUserRolePolicyError) {
    const status = error.code === 'ROLE_ESCALATION_DENIED' ? 403 : 422;
    throw new HttpError(status, error.code, error.message);
  }
  throw error;
}
