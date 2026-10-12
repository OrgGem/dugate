import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { ApiKeyLifecyclePage, ApiKeyLifecycleRow } from '@du/contracts';
import type { Db } from '../../db/db';
import type { AuditService } from '../audit/audit';
import { HttpError } from '../../http/errors';

interface KeyRow extends QueryResultRow {
  id: string;
  tenant_id: string;
  prefix: string;
  name: string | null;
  status: string;
  created_at: Date | string;
  updated_at: Date | string;
  version: number;
  protected: boolean;
}

interface Cursor { createdAt: string; id: string }
export interface ApiKeyActor {
  actor: string;
  role: 'ADMIN';
  issuer?: string;
  sub?: string;
  correlationId?: string;
}

function normalizeLimit(limit: number | undefined): number {
  const value = limit ?? 50;
  if (!Number.isSafeInteger(value) || value < 1 || value > 250) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'API-key page limit must be 1..250');
  }
  return value;
}

function parseCursor(value: string | null | undefined): Cursor | null {
  if (!value) return null;
  try {
    const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Partial<Cursor>;
    if (typeof decoded.createdAt !== 'string' || Number.isNaN(Date.parse(decoded.createdAt))
        || typeof decoded.id !== 'string' || !/^[0-9a-f-]{36}$/i.test(decoded.id)) throw new Error();
    return { createdAt: decoded.createdAt, id: decoded.id };
  } catch {
    throw new HttpError(422, 'INVALID_SCHEMA', 'API-key cursor is invalid');
  }
}

function encodeCursor(cursor: Cursor): string {
  return Buffer.from(JSON.stringify(cursor)).toString('base64url');
}

function date(value: Date | string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(parsed.getTime())) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Stored API-key timestamp is invalid');
  return parsed.toISOString();
}

function hashKey(raw: string): string {
  return createHash('sha256').update(raw, 'utf8').digest('hex');
}

function requestHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex');
}

function idempotencyHash(value: string): string {
  if (typeof value !== 'string' || value.length < 8 || value.length > 200 || /[\r\n\u0000]/.test(value)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'idempotency key must be 8..200 safe characters');
  }
  return hashKey(value);
}

function normalizeIds(values: string[]): string[] {
  if (!Array.isArray(values) || values.length > 500) throw new HttpError(422, 'INVALID_SCHEMA', 'profile assignment list is invalid');
  const ids = values.map((id) => {
    if (typeof id !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'profile assignment id is invalid');
    }
    return id.toLowerCase();
  });
  if (new Set(ids).size !== ids.length) throw new HttpError(422, 'INVALID_SCHEMA', 'profile assignment ids must be unique');
  return ids.sort();
}

function normalizeNote(note: string | null | undefined): string | null {
  if (note == null) return null;
  if (typeof note !== 'string' || note.length > 200 || /[\r\n\u0000]/.test(note)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'API-key note is invalid');
  }
  const value = note.trim();
  if (!value) return null;
  if (value.toLowerCase() === 'global') throw new HttpError(409, 'GLOBAL_KEY_PROTECTED', 'Global is a protected API key name');
  return value;
}

function protectGlobal(row: { name: string | null }): void {
  if (row.name?.trim().toLowerCase() === 'global') {
    throw new HttpError(409, 'GLOBAL_KEY_PROTECTED', 'the Global API key is protected');
  }
}

async function profilesExistForClient(client: Pick<PoolClient, 'query'>, tenantId: string, profileIds: string[]): Promise<void> {
  if (!profileIds.length) return;
  const result = await client.query<{ profile_id: string }>(
    'SELECT profile_id FROM profile_names WHERE tenant_id=$1 AND profile_id=ANY($2::uuid[]) FOR SHARE', [tenantId, profileIds],
  );
  if (result.rows.length !== profileIds.length) throw new HttpError(422, 'FOREIGN_GRANT', 'profile list contains a foreign or missing profile');
}

async function safeRow(db: Db, row: KeyRow, profileIds?: string[]): Promise<ApiKeyLifecycleRow> {
  let profiles = profileIds;
  if (!profiles) {
    const result = await db.query<{ profile_id: string }>(
      `SELECT profile_id FROM profile_api_keys WHERE tenant_id=$1 AND api_key_id=$2 AND state='ACTIVE' ORDER BY profile_id LIMIT 501`,
      [row.tenant_id, row.id],
    );
    if (result.rows.length > 500) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'API key has too many profile memberships for this view');
    profiles = result.rows.map((item) => item.profile_id);
  }
  if (row.status !== 'ACTIVE' && row.status !== 'REVOKED') throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Stored API-key status is invalid');
  return {
    id: row.id,
    tenantId: row.tenant_id,
    prefix: row.prefix,
    note: row.name,
    status: row.status,
    version: row.version,
    createdAt: date(row.created_at),
    updatedAt: date(row.updated_at),
    profileIds: profiles,
    protected: row.protected || row.name?.trim().toLowerCase() === 'global',
  };
}

/** Tenant-fenced API-key lifecycle. Raw keys exist only in the immediate issue/rotate result. */
export function createApiKeyLifecycleService(deps: { db: Db; audit: AuditService }) {
  return {
    async list(input: { tenantId: string; query?: string; status?: 'ACTIVE' | 'REVOKED'; cursor?: string | null; limit?: number }): Promise<ApiKeyLifecyclePage> {
      const limit = normalizeLimit(input.limit);
      const cursor = parseCursor(input.cursor);
      const query = input.query?.trim().slice(0, 128) ?? '';
      const args: unknown[] = [input.tenantId];
      const where = ['tenant_id=$1'];
      if (input.status) { args.push(input.status); where.push(`status=$${args.length}`); }
      if (query) { args.push(`%${query.replace(/[\\%_]/g, '\\$&')}%`); where.push(`(prefix ILIKE $${args.length} ESCAPE '\\' OR coalesce(name,'') ILIKE $${args.length} ESCAPE '\\')`); }
      const countArgs = [...args];
      if (cursor) { args.push(cursor.createdAt, cursor.id); where.push(`(created_at,id)<($${args.length - 1}::timestamptz,$${args.length}::uuid)`); }
      const [result, count] = await Promise.all([
        deps.db.query<KeyRow>(
          `SELECT id,tenant_id,prefix,name,status,created_at,updated_at,version,(lower(trim(coalesce(name,'')))='global') AS protected
             FROM api_keys WHERE ${where.join(' AND ')} ORDER BY created_at DESC,id DESC LIMIT ${limit + 1}`,
          args,
        ),
        deps.db.query<{ total: number }>(`SELECT count(*)::int AS total FROM api_keys WHERE ${where.filter((part) => !part.startsWith('(created_at,id)')).join(' AND ')}`, countArgs),
      ]);
      const hasMore = result.rows.length > limit;
      const rows = result.rows.slice(0, limit);
      const profiles = rows.length ? await deps.db.query<{ api_key_id: string; profile_id: string }>(
        `SELECT api_key_id,profile_id FROM profile_api_keys WHERE tenant_id=$1 AND api_key_id=ANY($2::uuid[]) AND state='ACTIVE' ORDER BY profile_id LIMIT ${rows.length * 501}`,
        [input.tenantId, rows.map((row) => row.id)],
      ) : { rows: [] as { api_key_id: string; profile_id: string }[] };
      const grouped = new Map<string, string[]>();
      for (const item of profiles.rows) {
        const list = grouped.get(item.api_key_id) ?? [];
        list.push(item.profile_id);
        grouped.set(item.api_key_id, list);
      }
      const items = await Promise.all(rows.map((row) => {
        const memberIds = grouped.get(row.id) ?? [];
        if (memberIds.length > 500) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'API key has too many profile memberships for this view');
        return safeRow(deps.db, row, memberIds);
      }));
      const last = rows.at(-1);
      return { items, nextCursor: hasMore && last ? encodeCursor({ createdAt: date(last.created_at), id: last.id }) : null,
        prevCursor: null, total: Number(count.rows[0]?.total ?? 0), limit };
    },

    async issue(input: { tenantId: string; note?: string | null; profileIds?: string[]; idempotencyKey: string }, actor: ApiKeyActor) {
      requireAdmin(actor);
      const note = normalizeNote(input.note);
      const profileIds = normalizeIds(input.profileIds ?? []);
      const idem = idempotencyHash(input.idempotencyKey);
      const bodyHash = requestHash({ tenantId: input.tenantId, note, profileIds });
      const raw = `du_${randomBytes(32).toString('base64url')}`;
      const keyHash = hashKey(raw);
      const keyId = randomUUID();
      const result = await deps.db.tx(async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('api-key-mutation:' || $1 || ':' || $2,0))`, [input.tenantId, idem]);
        const existing = await client.query<{ operation: string; request_hash: string; api_key_id: string }>(
          'SELECT operation,request_hash,api_key_id FROM admin_api_key_mutations WHERE tenant_id=$1 AND idempotency_hash=$2 FOR UPDATE', [input.tenantId, idem]);
        if (existing.rows[0]) {
          if (existing.rows[0].operation !== 'issue' || existing.rows[0].request_hash !== bodyHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was used for a different API-key mutation');
          const found = await client.query<KeyRow>(
            `SELECT id,tenant_id,prefix,name,status,created_at,updated_at,version,(lower(trim(coalesce(name,'')))='global') AS protected FROM api_keys WHERE tenant_id=$1 AND id=$2`,
            [input.tenantId, existing.rows[0].api_key_id]);
          if (!found.rows[0]) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'idempotent API-key result is unavailable');
          return { row: found.rows[0], replayed: true };
        }
        await profilesExistForClient(client, input.tenantId, profileIds);
        const inserted = await client.query<KeyRow>(
          `INSERT INTO api_keys (id,tenant_id,hash,prefix,name,status,version,updated_at)
           VALUES ($1,$2,$3,$4,$5,'ACTIVE',1,now())
           RETURNING id,tenant_id,prefix,name,status,created_at,updated_at,version,false AS protected`,
          [keyId, input.tenantId, keyHash, raw.slice(0, 4), note]);
        const row = inserted.rows[0];
        if (!row) throw new HttpError(500, 'INTERNAL', 'API-key creation failed');
        if (profileIds.length) await client.query(
          `INSERT INTO profile_api_keys (profile_id,api_key_id,tenant_id,state)
           SELECT unnest($1::uuid[]),$2,$3,'ACTIVE'`, [profileIds, row.id, input.tenantId]);
        await client.query(
          `INSERT INTO admin_api_key_mutations (tenant_id,idempotency_hash,operation,request_hash,api_key_id)
           VALUES ($1,$2,'issue',$3,$4)`, [input.tenantId, idem, bodyHash, row.id]);
        await deps.audit.record({ tenantId: input.tenantId, actor: actor.actor, actorIssuer: actor.issuer, actorSub: actor.sub,
          actorRole: actor.role, action: 'admin_api_key.issue', resource: `apikey:${row.id}`, severity: 'success', correlationId: actor.correlationId }, client);
        return { row, replayed: false };
      });
      const safe = await safeRow(deps.db, result.row, result.replayed ? undefined : profileIds);
      return { key: safe, ...(result.replayed ? { secretAvailable: false } : { secret: raw, secretAvailable: true }) };
    },

    async updateNote(input: { tenantId: string; keyId: string; note: string | null; expectedVersion: number }, actor: ApiKeyActor) {
      requireAdmin(actor);
      const note = normalizeNote(input.note);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new HttpError(422, 'INVALID_SCHEMA', 'expected version is invalid');
      const row = await deps.db.tx(async (client) => {
        const found = await client.query<KeyRow>(
          `SELECT id,tenant_id,prefix,name,status,created_at,updated_at,version,(lower(trim(coalesce(name,'')))='global') AS protected FROM api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [input.tenantId, input.keyId]);
        if (!found.rows[0]) throw new HttpError(404, 'NOT_FOUND', 'API key was not found in this tenant');
        protectGlobal(found.rows[0]);
        if (found.rows[0].version !== input.expectedVersion) throw new HttpError(409, 'IDENTITY_VERSION_CONFLICT', 'API-key version is stale');
        const updated = await client.query<KeyRow>(
          `UPDATE api_keys SET name=$1,version=version+1,updated_at=now() WHERE tenant_id=$2 AND id=$3 AND version=$4
           RETURNING id,tenant_id,prefix,name,status,created_at,updated_at,version,false AS protected`,
          [note, input.tenantId, input.keyId, input.expectedVersion]);
        const next = updated.rows[0];
        if (!next) throw new HttpError(409, 'IDENTITY_VERSION_CONFLICT', 'API-key version is stale');
        await deps.audit.record({ tenantId: input.tenantId, actor: actor.actor, actorIssuer: actor.issuer, actorSub: actor.sub,
          actorRole: actor.role, action: 'admin_api_key.note', resource: `apikey:${next.id}`, severity: 'info', correlationId: actor.correlationId }, client);
        return next;
      });
      return { key: await safeRow(deps.db, row) , secretAvailable: false };
    },

    async rotate(input: { tenantId: string; keyId: string; expectedVersion: number; idempotencyKey: string }, actor: ApiKeyActor) {
      requireAdmin(actor);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new HttpError(422, 'INVALID_SCHEMA', 'expected version is invalid');
      const idem = idempotencyHash(input.idempotencyKey);
      const bodyHash = requestHash({ tenantId: input.tenantId, keyId: input.keyId, expectedVersion: input.expectedVersion });
      const raw = `du_${randomBytes(32).toString('base64url')}`;
      const newHash = hashKey(raw);
      const newId = randomUUID();
      const outcome = await deps.db.tx(async (client) => {
        await client.query(`SELECT pg_advisory_xact_lock(hashtextextended('api-key-mutation:' || $1 || ':' || $2,0))`, [input.tenantId, idem]);
        const replay = await client.query<{ operation: string; request_hash: string; api_key_id: string }>(
          'SELECT operation,request_hash,api_key_id FROM admin_api_key_mutations WHERE tenant_id=$1 AND idempotency_hash=$2 FOR UPDATE', [input.tenantId, idem]);
        if (replay.rows[0]) {
          if (replay.rows[0].operation !== 'rotate' || replay.rows[0].request_hash !== bodyHash) throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'idempotency key was used for a different API-key mutation');
          const found = await client.query<KeyRow>(
            `SELECT id,tenant_id,prefix,name,status,created_at,updated_at,version,(lower(trim(coalesce(name,'')))='global') AS protected FROM api_keys WHERE tenant_id=$1 AND id=$2`,
            [input.tenantId, replay.rows[0].api_key_id]);
          if (!found.rows[0]) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'idempotent rotation result is unavailable');
          return { row: found.rows[0], replayed: true, profileIds: [] as string[] };
        }
        const oldResult = await client.query<KeyRow>(
          `SELECT id,tenant_id,prefix,name,status,created_at,updated_at,version,(lower(trim(coalesce(name,'')))='global') AS protected
             FROM api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE`, [input.tenantId, input.keyId]);
        const old = oldResult.rows[0];
        if (!old) throw new HttpError(404, 'NOT_FOUND', 'API key was not found in this tenant');
        protectGlobal(old);
        if (old.status !== 'ACTIVE') throw new HttpError(409, 'STATE_CONFLICT', 'API key is not active');
        if (old.version !== input.expectedVersion) throw new HttpError(409, 'IDENTITY_VERSION_CONFLICT', 'API-key version is stale');
        const memberships = await client.query<{ profile_id: string }>(
          `SELECT profile_id FROM profile_api_keys WHERE tenant_id=$1 AND api_key_id=$2 AND state='ACTIVE' ORDER BY profile_id FOR SHARE`,
          [input.tenantId, input.keyId]);
        const profileIds = memberships.rows.map((item) => item.profile_id);
        const inserted = await client.query<KeyRow>(
          `INSERT INTO api_keys (id,tenant_id,hash,prefix,name,status,version,updated_at)
           VALUES ($1,$2,$3,$4,$5,'ACTIVE',1,now())
           RETURNING id,tenant_id,prefix,name,status,created_at,updated_at,version,false AS protected`,
          [newId, input.tenantId, newHash, raw.slice(0, 4), old.name?.trim() ? `${old.name.trim()} (rotated)`.slice(0, 200) : null]);
        const next = inserted.rows[0];
        if (!next) throw new HttpError(500, 'INTERNAL', 'API-key rotation failed');
        if (profileIds.length) await client.query(
          `INSERT INTO profile_api_keys (profile_id,api_key_id,tenant_id,state)
           SELECT unnest($1::uuid[]),$2,$3,'ACTIVE'`, [profileIds, next.id, input.tenantId]);
        await client.query("UPDATE profile_api_keys SET state='REVOKED',revoked_at=now() WHERE tenant_id=$1 AND api_key_id=$2 AND state='ACTIVE'", [input.tenantId, input.keyId]);
        const localUsers = await client.query<{ user_id: string }>(
          'SELECT user_id FROM admin_local_user_api_key_grants WHERE tenant_id=$1 AND api_key_id=$2 FOR UPDATE', [input.tenantId, input.keyId]);
        if (localUsers.rows.length) {
          await client.query(
            `INSERT INTO admin_local_user_api_key_grants (tenant_id,user_id,api_key_id)
             SELECT tenant_id,user_id,$3 FROM admin_local_user_api_key_grants WHERE tenant_id=$1 AND api_key_id=$2
             ON CONFLICT DO NOTHING`, [input.tenantId, input.keyId, next.id]);
          await client.query('DELETE FROM admin_local_user_api_key_grants WHERE tenant_id=$1 AND api_key_id=$2', [input.tenantId, input.keyId]);
          await client.query('UPDATE admin_local_users SET assignment_version=assignment_version+1,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=ANY($2::uuid[])', [input.tenantId, localUsers.rows.map((item) => item.user_id)]);
        }
        const revoked = await client.query<KeyRow>(
          `UPDATE api_keys SET status='REVOKED',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND status='ACTIVE' AND version=$3
           RETURNING id,tenant_id,prefix,name,status,created_at,updated_at,version,false AS protected`, [input.tenantId, input.keyId, input.expectedVersion]);
        if (!revoked.rows[0]) throw new HttpError(409, 'IDENTITY_VERSION_CONFLICT', 'API-key version is stale');
        await client.query(
          `INSERT INTO admin_api_key_mutations (tenant_id,idempotency_hash,operation,request_hash,api_key_id)
           VALUES ($1,$2,'rotate',$3,$4)`, [input.tenantId, idem, bodyHash, next.id]);
        await deps.audit.record({ tenantId: input.tenantId, actor: actor.actor, actorIssuer: actor.issuer, actorSub: actor.sub,
          actorRole: actor.role, action: 'admin_api_key.rotate', resource: `apikey:${input.keyId}->${next.id}`, severity: 'warning', correlationId: actor.correlationId }, client);
        return { row: next, replayed: false, profileIds };
      });
      const safe = await safeRow(deps.db, outcome.row, outcome.profileIds.length ? outcome.profileIds : undefined);
      return { key: safe, ...(outcome.replayed ? { secretAvailable: false } : { secret: raw, secretAvailable: true }) };
    },

    async revoke(input: { tenantId: string; keyId: string; expectedVersion: number }, actor: ApiKeyActor) {
      requireAdmin(actor);
      if (!Number.isSafeInteger(input.expectedVersion) || input.expectedVersion < 1) throw new HttpError(422, 'INVALID_SCHEMA', 'expected version is invalid');
      const row = await deps.db.tx(async (client) => {
        const found = await client.query<KeyRow>(
          `SELECT id,tenant_id,prefix,name,status,created_at,updated_at,version,(lower(trim(coalesce(name,'')))='global') AS protected FROM api_keys WHERE tenant_id=$1 AND id=$2 FOR UPDATE`,
          [input.tenantId, input.keyId]);
        const current = found.rows[0];
        if (!current) throw new HttpError(404, 'NOT_FOUND', 'API key was not found in this tenant');
        protectGlobal(current);
        if (current.version !== input.expectedVersion) throw new HttpError(409, 'IDENTITY_VERSION_CONFLICT', 'API-key version is stale');
        if (current.status === 'ACTIVE') {
          await client.query("UPDATE profile_api_keys SET state='REVOKED',revoked_at=now() WHERE tenant_id=$1 AND api_key_id=$2 AND state='ACTIVE'", [input.tenantId, input.keyId]);
          const users = await client.query<{ user_id: string }>('DELETE FROM admin_local_user_api_key_grants WHERE tenant_id=$1 AND api_key_id=$2 RETURNING user_id', [input.tenantId, input.keyId]);
          if (users.rows.length) await client.query(
            'UPDATE admin_local_users SET assignment_version=assignment_version+1,version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=ANY($2::uuid[])',
            [input.tenantId, users.rows.map((item) => item.user_id)]);
        }
        const updated = await client.query<KeyRow>(
          `UPDATE api_keys SET status='REVOKED',version=version+1,updated_at=now() WHERE tenant_id=$1 AND id=$2 AND version=$3
           RETURNING id,tenant_id,prefix,name,status,created_at,updated_at,version,(lower(trim(coalesce(name,'')))='global') AS protected`,
          [input.tenantId, input.keyId, input.expectedVersion]);
        const next = updated.rows[0];
        if (!next) throw new HttpError(409, 'IDENTITY_VERSION_CONFLICT', 'API-key version is stale');
        await deps.audit.record({ tenantId: input.tenantId, actor: actor.actor, actorIssuer: actor.issuer, actorSub: actor.sub,
          actorRole: actor.role, action: 'admin_api_key.revoke', resource: `apikey:${next.id}`, severity: 'warning', correlationId: actor.correlationId }, client);
        return next;
      });
      return { key: await safeRow(deps.db, row, []), secretAvailable: false };
    },
  };
}

function requireAdmin(actor: ApiKeyActor): void {
  if (!actor || actor.role !== 'ADMIN' || typeof actor.actor !== 'string' || actor.actor.trim().length === 0 || actor.actor.length > 200) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'administrator access is required');
  }
}
