/**
 * SC-01 / SC-03: Durable Secret Catalog Store with At-Rest Encryption.
 *
 * Managed values are encrypted using AES-256-GCM before writing to PostgreSQL.
 * Ciphertext is stored as an authenticated envelope { v: 1, alg: 'aes-256-gcm', iv, tag, ct }.
 * Plaintext values are WRITE-ONLY and are NEVER returned in read projections or audit rows.
 */
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type {
  SecretCatalogCreate,
  SecretCatalogDisable,
  SecretCatalogEntryRead,
  SecretCatalogListPage,
  SecretCatalogRotate,
} from '@du/contracts';
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';
import type { AuditService } from '../audit/audit';
import type { BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';
import type { SecretCatalogKeyring } from './secret-revision-resolver';

export interface SecretProbeResult {
  ok: boolean;
  status: 'AVAILABLE' | 'DISABLED' | 'ERROR';
  errorCode?: string;
  latencyMs: number;
}

export interface SecretCatalogRow {
  secret_id: string;
  tenant_id: string;
  name: string;
  purpose: string;
  services: string[];
  provider_kind: 'managed_value' | 'vault_reference';
  provider_config: Record<string, unknown>;
  state: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  revision: number;
  encryption_key_version?: string | null;
  encrypted_value: { v: number; alg: string; iv: string; tag: string; ct: string } | null;
  rotated_at: Date | null;
  rotation_interval_days: number | null;
  disabled_reason: string | null;
  created_at: Date;
  updated_at: Date;
  created_at_cursor?: string;
}

const SECRET_LIST_CURSOR_VERSION = 2;
const SECRET_LIST_CURSOR_CONTEXT = 'secret-catalog-list-v2';
const SECRET_LIST_CURSOR_MAX_LENGTH = 2048;
const SECRET_LIST_QUERY_CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const SECRET_LIST_CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const SECRET_LIST_CURSOR_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function assertSecretCatalogWriteAllowed(
  client: Pick<import('pg').PoolClient, 'query'>,
  gate: BackupSnapshotWriteGate | undefined,
  tenantId: string,
  requestKey: string,
): Promise<void> {
  if (!gate) throw new HttpError(503, 'BACKUP_WRITE_GATE_UNAVAILABLE', 'Secret Catalog writes require the backup snapshot gate');
  await gate.assertWriteAllowed(client, {
    tenantId,
    domain: 'secret-catalog-write',
    requestKey: createHash('sha256').update(requestKey, 'utf8').digest('hex'),
  });
}

export interface SecretCatalogListQuery {
  tenantId: string | null;
  limit: number;
  cursor: string | null;
  state: string | null;
  purpose: string | null;
  service: 'orchestrator' | 'connector' | null;
  q: string | null;
}

interface SecretCatalogListCursor {
  createdAt: string;
  secretId: string;
}

function invalidSecretListQuery(message: string): HttpError {
  return new HttpError(400, 'INVALID_ARGUMENT', message);
}

function normalizedSecretSearch(value: string | null | undefined): string | null {
  const normalized = value?.normalize('NFKC').trim().toLowerCase() ?? '';
  if (SECRET_LIST_QUERY_CONTROL_CHARS.test(normalized) || normalized.length > 128) {
    throw invalidSecretListQuery('q must be at most 128 safe characters');
  }
  return normalized || null;
}

/** Strict allowlist/parser for the Secret Catalog's bounded metadata list. */
export function parseSecretCatalogListQuery(params: URLSearchParams): SecretCatalogListQuery {
  const allowed = new Set(['tenantId', 'limit', 'cursor', 'state', 'purpose', 'service', 'sort', 'q']);
  const values: Record<string, string> = {};
  params.forEach((value, name) => {
    if (!allowed.has(name)) throw invalidSecretListQuery('unsupported secret catalog query parameter');
    if (Object.hasOwn(values, name)) throw invalidSecretListQuery(`${name} must not be repeated`);
    values[name] = value;
  });

  let limit = 50;
  if (values['limit'] !== undefined) {
    if (!/^[1-9][0-9]{0,2}$/.test(values['limit']!)) throw invalidSecretListQuery('limit must be an integer from 1 to 200');
    limit = Number(values['limit']);
    if (limit > 200) throw invalidSecretListQuery('limit must be an integer from 1 to 200');
  }
  const state = values['state']?.trim() || null;
  const purpose = values['purpose']?.trim() || null;
  const service = values['service']?.trim() || null;
  if (state !== null && !['ACTIVE', 'DISABLED', 'REVOKED'].includes(state)) {
    throw invalidSecretListQuery('state is not a supported Secret Catalog state');
  }
  if (purpose !== null && purpose.length > 64) throw invalidSecretListQuery('purpose is invalid');
  if (service !== null && service !== 'orchestrator' && service !== 'connector') {
    throw invalidSecretListQuery('service is not a supported Secret Catalog service');
  }
  for (const filter of [state, purpose, service]) {
    if (filter !== null && SECRET_LIST_QUERY_CONTROL_CHARS.test(filter)) throw invalidSecretListQuery('Secret Catalog filter is invalid');
  }
  // `sort` was historically forwarded by the BFF and ignored by this list.
  // Keep accepting it for compatibility; ordering remains newest-first.
  return {
    tenantId: values['tenantId']?.trim().toLowerCase() || null,
    limit,
    cursor: values['cursor'] ?? null,
    state,
    purpose,
    service,
    q: normalizedSecretSearch(values['q']),
  };
}

function secretListCursorContext(input: {
  tenantId: string | null;
  query: Pick<SecretCatalogListQuery, 'limit' | 'state' | 'purpose' | 'service' | 'q'>;
}): string {
  return JSON.stringify([
    SECRET_LIST_CURSOR_CONTEXT,
    input.tenantId,
    input.query.limit,
    input.query.state,
    input.query.purpose,
    input.query.service,
    input.query.q,
  ]);
}

function secretListCursorMac(secret: string, context: string, payload: string): Buffer {
  return createHmac('sha256', secret).update(context, 'utf8').update('\0').update(payload, 'utf8').digest();
}

function encodeSecretListCursor(cursor: SecretCatalogListCursor, secret: string, context: string): string {
  const payload = Buffer.from(JSON.stringify({
    v: SECRET_LIST_CURSOR_VERSION,
    createdAt: cursor.createdAt,
    secretId: cursor.secretId,
  }), 'utf8').toString('base64url');
  const signature = secretListCursorMac(secret, context, payload).toString('base64url');
  return `${payload}.${signature}`;
}

function decodeSecretListCursor(raw: string | null, secret: string, context: string): SecretCatalogListCursor | null {
  if (raw === null) return null;
  if (raw.length === 0 || raw.length > SECRET_LIST_CURSOR_MAX_LENGTH) throw invalidSecretListQuery('cursor is invalid for this tenant and filter');
  const pieces = raw.split('.');
  if (pieces.length !== 2 || !/^[A-Za-z0-9_-]+$/.test(pieces[0]!) || !/^[A-Za-z0-9_-]+$/.test(pieces[1]!)) {
    throw invalidSecretListQuery('cursor is invalid for this tenant and filter');
  }
  try {
    const payloadBytes = Buffer.from(pieces[0]!, 'base64url');
    const signatureBytes = Buffer.from(pieces[1]!, 'base64url');
    if (payloadBytes.toString('base64url') !== pieces[0] || signatureBytes.toString('base64url') !== pieces[1]) {
      throw invalidSecretListQuery('cursor is invalid for this tenant and filter');
    }
    const expected = secretListCursorMac(secret, context, pieces[0]!);
    if (signatureBytes.length !== expected.length || !timingSafeEqual(signatureBytes, expected)) {
      throw invalidSecretListQuery('cursor is invalid for this tenant and filter');
    }
    const value = JSON.parse(payloadBytes.toString('utf8')) as Record<string, unknown>;
    if (Object.keys(value).length !== 3
        || value['v'] !== SECRET_LIST_CURSOR_VERSION
        || typeof value['createdAt'] !== 'string'
        || !SECRET_LIST_CURSOR_TIMESTAMP.test(value['createdAt'])
        || typeof value['secretId'] !== 'string'
        || !SECRET_LIST_CURSOR_UUID.test(value['secretId'])) {
      throw invalidSecretListQuery('cursor is invalid for this tenant and filter');
    }
    return { createdAt: value['createdAt'], secretId: value['secretId'].toLowerCase() };
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw invalidSecretListQuery('cursor is invalid for this tenant and filter');
  }
}

export function resolveSecretStoreKey(customKey?: string): Buffer {
  const rawKey = customKey || process.env.ENCRYPTION_KEY;
  if (!rawKey) {
    throw new HttpError(503, 'SECRET_KEY_VERSION_UNAVAILABLE', 'a retained Secret Catalog encryption key is not configured');
  }
  if (customKey === undefined && Buffer.byteLength(rawKey, 'utf8') < 32) {
    throw new HttpError(503, 'SECRET_KEY_VERSION_UNAVAILABLE', 'ENCRYPTION_KEY must contain at least 32 bytes for managed Secret Catalog values');
  }
  // Preserve the original unversioned derivation for explicitly selected
  // legacy callers. New boot-configured writes use the versioned keyring.
  return createHash('sha256').update(rawKey).digest();
}

function versionedKey(keyring: SecretCatalogKeyring, version: string): Buffer {
  const key = keyring.keys[version];
  if (!key || !Buffer.isBuffer(key) || key.byteLength !== 32) {
    throw new HttpError(503, 'SECRET_KEY_VERSION_UNAVAILABLE', 'an explicitly configured secret catalog key version is unavailable');
  }
  return key;
}

async function archiveSecretRevision(
  executor: import('pg').PoolClient,
  row: SecretCatalogRow,
  keyVersion: string | null,
): Promise<void> {
  await executor.query(
    `INSERT INTO secret_catalog_revisions(
       secret_id,tenant_id,revision,name,purpose,services,provider_kind,provider_config,state,
       encrypted_value,encryption_key_version,created_at
     ) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,COALESCE($12,now()))
     ON CONFLICT(secret_id,revision) DO NOTHING`,
    [row.secret_id,row.tenant_id,row.revision,row.name,row.purpose,row.services,row.provider_kind,
      JSON.stringify(row.provider_config ?? {}),row.state,
      row.encrypted_value ? JSON.stringify(row.encrypted_value) : null,
      keyVersion, row.created_at ?? null],
  );
}

export function secretVersionRef(secretId: string, revision: number): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(secretId)
      || !Number.isSafeInteger(revision) || revision < 1) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'secret version identity is invalid');
  }
  return `${secretId}@${revision}`;
}

export function encryptSecretValue(plaintext: string, key: Buffer): { v: number; alg: string; iv: string; tag: string; ct: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: 1,
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: tag.toString('base64'),
    ct: ct.toString('base64'),
  };
}

export function decryptSecretValue(
  envelope: unknown,
  key: Buffer,
): string {
  if (typeof envelope !== 'object' || envelope === null) {
    throw new Error('Invalid secret envelope');
  }
  const env = envelope as { v?: number; alg?: string; iv?: string; tag?: string; ct?: string };
  if (env.v !== 1 || env.alg !== 'aes-256-gcm' || !env.iv || !env.tag || !env.ct) {
    throw new Error('Unsupported secret envelope format');
  }
  const iv = Buffer.from(env.iv, 'base64');
  const tag = Buffer.from(env.tag, 'base64');
  const ct = Buffer.from(env.ct, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
}

export function toSecretRead(row: SecretCatalogRow): SecretCatalogEntryRead {
  const provider = row.provider_kind === 'managed_value'
    ? { kind: 'managed_value' as const }
    : (row.provider_config as unknown as SecretCatalogEntryRead['provider']);

  return {
    catalogVersion: 1,
    secretId: row.secret_id,
    tenantId: row.tenant_id,
    name: row.name,
    purpose: row.purpose as SecretCatalogEntryRead['purpose'],
    services: row.services as SecretCatalogEntryRead['services'],
    provider,
    state: row.state,
    revision: row.revision,
    valueConfigured: row.provider_kind === 'managed_value' ? row.encrypted_value !== null : true,
    usageReferences: [],
    rotation: {
      rotatedAt: row.rotated_at ? row.rotated_at.toISOString() : null,
      intervalDays: row.rotation_interval_days,
    },
  };
}

export async function createSecretInDb(
  db: Db,
  input: SecretCatalogCreate,
  encryptionKey?: string,
  keyring?: SecretCatalogKeyring,
  backupSnapshotWriteGate?: BackupSnapshotWriteGate,
): Promise<SecretCatalogEntryRead> {
  const keyVersion = keyring?.activeVersion ?? null;
  const secretId = randomUUID();

  let encryptedValue: unknown = null;
  let providerConfig: Record<string, unknown> = {};

  if (input.provider.kind === 'managed_value') {
    if (!input.value || typeof input.value.value !== 'string') {
      throw new HttpError(422, 'INVALID_SCHEMA', 'managed_value requires a literal value');
    }
    const key = keyring
      ? versionedKey(keyring, keyVersion!)
      : resolveSecretStoreKey(encryptionKey);
    encryptedValue = encryptSecretValue(input.value.value, key);
  } else {
    providerConfig = { ...input.provider };
  }

  const insert = async (executor: Pick<Db, 'query'>) => executor.query<SecretCatalogRow>(
    `INSERT INTO secret_catalog (
      secret_id, tenant_id, name, purpose, services, provider_kind, provider_config, state, revision, encrypted_value,
      encryption_key_version, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', 1, $8, $9, now(), now())
    RETURNING *`,
    [secretId,input.tenantId,input.name,input.purpose,input.services,input.provider.kind,JSON.stringify(providerConfig),
      encryptedValue ? JSON.stringify(encryptedValue) : null,keyVersion],
  );
  const result = await db.tx(async (client) => {
    await assertSecretCatalogWriteAllowed(client, backupSnapshotWriteGate, input.tenantId, `create:${secretId}`);
    const inserted = keyring
      ? await insert(client as Pick<Db, 'query'>)
      : await client.query<SecretCatalogRow>(
        `INSERT INTO secret_catalog (
          secret_id, tenant_id, name, purpose, services, provider_kind, provider_config, state, revision, encrypted_value, created_at, updated_at
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', 1, $8, now(), now())
        RETURNING *`,
        [secretId,input.tenantId,input.name,input.purpose,input.services,input.provider.kind,JSON.stringify(providerConfig),
          encryptedValue ? JSON.stringify(encryptedValue) : null],
      );
    if (keyring && inserted.rows[0]) await archiveSecretRevision(client, inserted.rows[0], keyVersion);
    return inserted;
  });

  if (!result.rowCount || !result.rows[0]) {
    throw new HttpError(500, 'STORAGE_ERROR', 'failed to persist secret');
  }

  return toSecretRead(result.rows[0]);
}

export async function listSecretsFromDb(
  db: Db,
  params: SecretCatalogListQuery,
  cursorSecret: string,
): Promise<SecretCatalogListPage> {
  if (typeof cursorSecret !== 'string' || cursorSecret.length === 0) {
    throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'secret catalog cursor signing is unavailable');
  }
  const context = secretListCursorContext({ tenantId: params.tenantId, query: params });
  const cursor = decodeSecretListCursor(params.cursor, cursorSecret, context);

  const conditions: string[] = [];
  const args: unknown[] = [];

  if (params.tenantId !== null) {
    args.push(params.tenantId);
    conditions.push(`tenant_id = $${args.length}`);
  }
  if (params.state !== null) {
    args.push(params.state);
    conditions.push(`state = $${args.length}`);
  }
  if (params.purpose !== null) {
    args.push(params.purpose);
    conditions.push(`purpose = $${args.length}`);
  }
  if (params.service !== null) {
    args.push(params.service);
    conditions.push(`services @> ARRAY[$${args.length}]::text[]`);
  }
  if (params.q !== null) {
    args.push(params.q);
    const search = `$${args.length}::text`;
    conditions.push(`(
      strpos(lower(name), ${search}) > 0
      OR strpos(lower(secret_id::text), ${search}) > 0
      OR strpos(lower(purpose), ${search}) > 0
      OR EXISTS (SELECT 1 FROM unnest(services) AS service_name(value) WHERE strpos(lower(service_name.value), ${search}) > 0)
    )`);
  }

  if (cursor) {
    args.push(cursor.createdAt, cursor.secretId);
    conditions.push(`(created_at, secret_id) < ($${args.length - 1}::timestamptz, $${args.length}::uuid)`);
  }
  const finalWhereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

  args.push(params.limit + 1);
  const limitIndex = args.length;
  const result = await db.query<SecretCatalogRow>(
    `SELECT secret_id, tenant_id, name, purpose, services, provider_kind, provider_config, state, revision,
            encrypted_value, rotated_at, rotation_interval_days, disabled_reason, created_at, updated_at,
            to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor
     FROM secret_catalog
     ${finalWhereClause}
     ORDER BY created_at DESC, secret_id DESC
     LIMIT $${limitIndex}`,
    args,
  );

  const hasMore = result.rows.length > params.limit;
  const rows = hasMore ? result.rows.slice(0, params.limit) : result.rows;
  const items = rows.map(toSecretRead);
  const last = rows[rows.length - 1];
  if (hasMore && (!last?.created_at_cursor || !SECRET_LIST_CURSOR_TIMESTAMP.test(last.created_at_cursor))) {
    throw new HttpError(500, 'STORAGE_ERROR', 'secret catalog page is missing its stable cursor boundary');
  }
  return {
    items,
    nextCursor: hasMore && last
      ? encodeSecretListCursor({ createdAt: last.created_at_cursor!, secretId: last.secret_id }, cursorSecret, context)
      : null,
  };
}

export async function rotateSecretInDb(
  db: Db,
  secretId: string,
  input: SecretCatalogRotate,
  encryptionKey?: string,
  keyring?: SecretCatalogKeyring,
  backupSnapshotWriteGate?: BackupSnapshotWriteGate,
): Promise<SecretCatalogEntryRead> {
  if (keyring) {
    const nextKey = versionedKey(keyring, keyring.activeVersion);
    return db.tx(async (client) => {
      const owner = await client.query<{ tenant_id: string }>('SELECT tenant_id::text AS tenant_id FROM secret_catalog WHERE secret_id=$1', [secretId]);
      if (!owner.rows[0]) throw new HttpError(404, 'NOT_FOUND', `secret ${secretId} not found`);
      await assertSecretCatalogWriteAllowed(client, backupSnapshotWriteGate, owner.rows[0].tenant_id, `rotate:${secretId}:${input.expectedRevision}`);
      const current = await client.query<SecretCatalogRow>(
        `SELECT * FROM secret_catalog WHERE secret_id=$1 FOR UPDATE`, [secretId],
      );
      const row = current.rows[0];
      if (!row) throw new HttpError(404, 'NOT_FOUND', `secret ${secretId} not found`);
      if (row.revision !== input.expectedRevision) {
        throw new HttpError(409, 'CONFLICT', `revision conflict: expected ${input.expectedRevision}, current is ${row.revision}`);
      }
      if (row.provider_kind !== 'managed_value') {
        throw new HttpError(400, 'INVALID_PROVIDER', 'vault references cannot be rotated via managed value');
      }
      if (row.state !== 'ACTIVE') throw new HttpError(409, 'SECRET_NOT_ACTIVE', 'only an active secret can be rotated');

      const existingKeyVersion = row.encryption_key_version ?? 'legacy-unversioned';
      await archiveSecretRevision(client, row, existingKeyVersion);
      const newRevision = row.revision + 1;
      const newEncrypted = encryptSecretValue(input.value.value, nextKey);
      const updated = await client.query<SecretCatalogRow>(
        `UPDATE secret_catalog SET revision=$2,encrypted_value=$3,encryption_key_version=$4,
           rotated_at=now(),updated_at=now()
          WHERE secret_id=$1 AND revision=$5 AND state='ACTIVE' RETURNING *`,
        [secretId,newRevision,JSON.stringify(newEncrypted),keyring.activeVersion,input.expectedRevision],
      );
      const next = updated.rows[0];
      if (!next) throw new HttpError(409, 'CONFLICT', 'concurrent update detected during rotation');
      await archiveSecretRevision(client, next, keyring.activeVersion);
      return toSecretRead(next);
    });
  }

  const key = resolveSecretStoreKey(encryptionKey);
  return db.tx(async (client) => {
    const owner = await client.query<{ tenant_id: string }>('SELECT tenant_id::text AS tenant_id FROM secret_catalog WHERE secret_id=$1', [secretId]);
    if (!owner.rows[0]) throw new HttpError(404, 'NOT_FOUND', `secret ${secretId} not found`);
    await assertSecretCatalogWriteAllowed(client, backupSnapshotWriteGate, owner.rows[0].tenant_id, `rotate:${secretId}:${input.expectedRevision}`);
    const current = await client.query<SecretCatalogRow>(`SELECT * FROM secret_catalog WHERE secret_id=$1 FOR UPDATE`, [secretId]);
    const row = current.rows[0];
    if (!row) throw new HttpError(404, 'NOT_FOUND', `secret ${secretId} not found`);
    if (row.revision !== input.expectedRevision) throw new HttpError(409, 'CONFLICT', `revision conflict: expected ${input.expectedRevision}, current is ${row.revision}`);
    if (row.provider_kind !== 'managed_value') throw new HttpError(400, 'INVALID_PROVIDER', 'vault references cannot be rotated via managed value');
    const newEncrypted = encryptSecretValue(input.value.value, key);
    const updated = await client.query<SecretCatalogRow>(
      `UPDATE secret_catalog SET revision=revision+1,encrypted_value=$2,rotated_at=now(),updated_at=now()
       WHERE secret_id=$1 AND revision=$3 RETURNING *`,
      [secretId, JSON.stringify(newEncrypted), input.expectedRevision],
    );
    if (!updated.rowCount || !updated.rows[0]) throw new HttpError(409, 'CONFLICT', 'concurrent update detected during rotation');
    return toSecretRead(updated.rows[0]);
  });
}

export async function disableSecretInDb(
  db: Db,
  secretId: string,
  input: SecretCatalogDisable,
  backupSnapshotWriteGate?: BackupSnapshotWriteGate,
): Promise<SecretCatalogEntryRead> {
  return db.tx(async (client) => {
    const owner = await client.query<{ tenant_id: string }>('SELECT tenant_id::text AS tenant_id FROM secret_catalog WHERE secret_id=$1', [secretId]);
    if (!owner.rows[0]) throw new HttpError(404, 'NOT_FOUND', `secret ${secretId} not found`);
    await assertSecretCatalogWriteAllowed(client, backupSnapshotWriteGate, owner.rows[0].tenant_id, `disable:${secretId}:${input.expectedRevision}`);
    const current = await client.query<SecretCatalogRow>(`SELECT * FROM secret_catalog WHERE secret_id=$1 FOR UPDATE`, [secretId]);
    const row = current.rows[0];
    if (!row) throw new HttpError(404, 'NOT_FOUND', `secret ${secretId} not found`);
    if (row.revision !== input.expectedRevision) throw new HttpError(409, 'CONFLICT', `revision conflict: expected ${input.expectedRevision}, current is ${row.revision}`);
    const updated = await client.query<SecretCatalogRow>(
      `UPDATE secret_catalog SET state='DISABLED',disabled_reason=$2,updated_at=now()
       WHERE secret_id=$1 AND revision=$3 RETURNING *`,
      [secretId, input.reason, input.expectedRevision],
    );
    if (!updated.rowCount || !updated.rows[0]) throw new HttpError(409, 'CONFLICT', 'concurrent update detected during disable');
    return toSecretRead(updated.rows[0]);
  });
}

export async function testSecretInDb(
  db: Db,
  secretId: string,
  encryptionKey?: string,
  keyring?: SecretCatalogKeyring,
): Promise<SecretProbeResult> {
  const startTime = Date.now();
  const current = await db.query<SecretCatalogRow>(
    `SELECT * FROM secret_catalog WHERE secret_id = $1`,
    [secretId],
  );

  if (!current.rowCount || !current.rows[0]) {
    throw new HttpError(404, 'NOT_FOUND', `secret ${secretId} not found`);
  }

  const row = current.rows[0];
  if (row.state === 'DISABLED') {
    return {
      ok: false,
      status: 'DISABLED',
      errorCode: 'SECRET_DISABLED',
      latencyMs: Math.max(1, Date.now() - startTime),
    };
  }

  if (row.provider_kind === 'managed_value') {
    if (!row.encrypted_value) {
      return {
        ok: false,
        status: 'ERROR',
        errorCode: 'NO_VALUE_CONFIGURED',
        latencyMs: Math.max(1, Date.now() - startTime),
      };
    }
    try {
      const key = keyring
        ? versionedKey(keyring, row.encryption_key_version ?? 'legacy-unversioned')
        : resolveSecretStoreKey(encryptionKey);
      decryptSecretValue(row.encrypted_value, key);
      return {
        ok: true,
        status: 'AVAILABLE',
        latencyMs: Math.max(1, Date.now() - startTime),
      };
    } catch {
      return {
        ok: false,
        status: 'ERROR',
        errorCode: 'DECRYPTION_FAILED',
        latencyMs: Math.max(1, Date.now() - startTime),
      };
    }
  }

  return {
    ok: true,
    status: 'AVAILABLE',
    latencyMs: Math.max(1, Date.now() - startTime),
  };
}

export type ImportedSecretPurpose = 'connector.credential' | 'storage.credential' | 'maintenance.backup_encryption';

export interface ImportedManagedSecretInput {
  tenantId: string;
  name: string;
  purpose: ImportedSecretPurpose;
  services: readonly ('orchestrator' | 'connector')[];
  value: string;
  sourceSystem: string;
  sourceRecordRef: string;
  idempotencyKey: string;
}

/**
 * Server-only continuity importer. Plaintext exists only in the caller and
 * this bounded write call; the returned value is an opaque exact-version ref.
 * The row, immutable revision, idempotency journal, and audit event commit in
 * one transaction. No route exposes this function as a plaintext read API.
 */
export async function writeImportedManagedSecret(
  db: Db,
  audit: AuditService,
  input: ImportedManagedSecretInput,
  options: {
    keyring: SecretCatalogKeyring;
    actor: { actor: string; actorRole?: string; actorIssuer?: string; actorSub?: string };
    backupSnapshotWriteGate?: BackupSnapshotWriteGate;
  },
): Promise<{ secretId: string; revision: number; versionRef: string }> {
  const { keyring } = options;
  const activeKey = versionedKey(keyring, keyring.activeVersion);
  const tenantPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (!tenantPattern.test(input.tenantId)
      || !/^[A-Za-z0-9][A-Za-z0-9 ._/-]{0,127}$/.test(input.name)
      || typeof input.value !== 'string' || input.value.length < 1 || input.value.length > 64 * 1024 || input.value.includes('\0')
      || input.services.length < 1 || input.services.length > 2 || new Set(input.services).size !== input.services.length
      || !/^[a-z][a-z0-9._-]{0,63}$/.test(input.sourceSystem)
      || input.sourceRecordRef.length < 1 || input.sourceRecordRef.length > 256
      || input.idempotencyKey.length < 8 || input.idempotencyKey.length > 256) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'managed secret import metadata is invalid');
  }
  if (input.purpose === 'storage.credential' && !input.services.includes('orchestrator')) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'storage credential imports require the Orchestrator service permission');
  }
  if (input.purpose === 'connector.credential' && !input.services.includes('connector')) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'Connector credentials require the Connector service permission');
  }
  if (input.purpose === 'maintenance.backup_encryption'
      && (input.services.length !== 1 || input.services[0] !== 'orchestrator')) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'backup encryption refs are Orchestrator-only');
  }
  if ((input.purpose === 'storage.credential' || input.purpose === 'maintenance.backup_encryption')
      && input.services.length !== 1) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'global storage and backup secrets are Orchestrator-only');
  }
  if (options.actor.actorRole !== 'platform') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'managed secret imports require a trusted platform Admin actor');
  }
  const requestMaterial = JSON.stringify({
    tenantId: input.tenantId,
    name: input.name,
    purpose: input.purpose,
    services: [...input.services].sort(),
    value: input.value,
    sourceSystem: input.sourceSystem,
    sourceRecordRef: input.sourceRecordRef,
  });
  const requestHmac = (key: Buffer) => createHmac('sha256', key).update(requestMaterial, 'utf8').digest('hex');

  return db.tx(async (client) => {
    await assertSecretCatalogWriteAllowed(
      client,
      options.backupSnapshotWriteGate,
      input.tenantId,
      `import:${input.tenantId}:${input.idempotencyKey}`,
    );
    const replay = await client.query<{
      request_hmac: string; key_version: string; source_system: string; source_record_ref: string; secret_id: string; revision: number | string;
    }>(
      `SELECT request_hmac,key_version,source_system,source_record_ref,secret_id,revision
         FROM secret_catalog_imports WHERE tenant_id=$1 AND idempotency_key=$2 FOR UPDATE`,
      [input.tenantId,input.idempotencyKey],
    );
    if (replay.rows[0]) {
      const row = replay.rows[0];
      const retainedKey = keyring.keys[row.key_version];
      if (!retainedKey || !Buffer.isBuffer(retainedKey) || retainedKey.byteLength !== 32) {
        throw new HttpError(503, 'SECRET_KEY_VERSION_UNAVAILABLE', 'the retained import idempotency key version is unavailable');
      }
      const expected = Buffer.from(row.request_hmac, 'hex');
      const actual = Buffer.from(requestHmac(retainedKey), 'hex');
      if (row.source_system !== input.sourceSystem || row.source_record_ref !== input.sourceRecordRef
          || expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
        throw new HttpError(409, 'IDEMPOTENCY_CONFLICT', 'secret import idempotency key was reused with different input');
      }
      const revision = Number(row.revision);
      return { secretId: row.secret_id, revision, versionRef: secretVersionRef(row.secret_id, revision) };
    }

    const secretId = randomUUID();
    const envelope = encryptSecretValue(input.value, activeKey);
    const inserted = await client.query<SecretCatalogRow>(
      `INSERT INTO secret_catalog(
         secret_id,tenant_id,name,purpose,services,provider_kind,provider_config,state,revision,
         encrypted_value,encryption_key_version,created_at,updated_at
       ) VALUES($1,$2,$3,$4,$5,'managed_value','{}'::jsonb,'ACTIVE',1,$6,$7,now(),now()) RETURNING *`,
      [secretId,input.tenantId,input.name,input.purpose,input.services,JSON.stringify(envelope),keyring.activeVersion],
    );
    const current = inserted.rows[0];
    if (!current) throw new HttpError(500, 'STORAGE_ERROR', 'failed to persist imported managed secret');
    await archiveSecretRevision(client, current, keyring.activeVersion);
    await client.query(
      `INSERT INTO secret_catalog_imports(tenant_id,idempotency_key,request_hmac,key_version,source_system,source_record_ref,secret_id,revision)
       VALUES($1,$2,$3,$4,$5,$6,$7,1)`,
      [input.tenantId,input.idempotencyKey,requestHmac(activeKey),keyring.activeVersion,input.sourceSystem,input.sourceRecordRef,secretId],
    );
    await audit.record({
      tenantId: input.tenantId,
      actor: options.actor.actor,
      actorRole: options.actor.actorRole,
      actorIssuer: options.actor.actorIssuer,
      actorSub: options.actor.actorSub,
      action: 'secret_catalog.import.managed',
      resource: `secret:${secretId}@1`,
      severity: 'success',
    }, client);
    return { secretId, revision: 1, versionRef: secretVersionRef(secretId, 1) };
  });
}
