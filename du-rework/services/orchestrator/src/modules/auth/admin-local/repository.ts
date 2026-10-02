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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const USERNAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;

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
    createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    updatedAt: row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at),
    version: row.version,
  };
}

const SAFE_COLUMNS = `id, tenant_id, username_normalized, role, is_enabled, is_locked,
                      created_at, updated_at, version`;

export function createAdminLocalUserRepository(db: Db, audit: AuditService) {
  async function replaceVerifier(
    input: AdminLocalUserPasswordUpdate,
    action: 'admin_local_user.password_reset' | 'admin_local_user.credentials_rotated'
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
         WHERE tenant_id = $2 AND id = $3
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

    async resetPassword(input: AdminLocalUserPasswordUpdate): Promise<AdminLocalUser | null> {
      return replaceVerifier(input, 'admin_local_user.password_reset');
    },

    async rotateCredentials(input: AdminLocalUserPasswordUpdate): Promise<AdminLocalUser | null> {
      return replaceVerifier(input, 'admin_local_user.credentials_rotated');
    },
  };
}

export type AdminLocalUserRepository = ReturnType<typeof createAdminLocalUserRepository>;
