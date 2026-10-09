/**
 * SC-01 / SC-03: Durable Secret Catalog Store with At-Rest Encryption.
 *
 * Managed values are encrypted using AES-256-GCM before writing to PostgreSQL.
 * Ciphertext is stored as an authenticated envelope { v: 1, alg: 'aes-256-gcm', iv, tag, ct }.
 * Plaintext values are WRITE-ONLY and are NEVER returned in read projections or audit rows.
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes, randomUUID } from 'node:crypto';
import type {
  SecretCatalogCreate,
  SecretCatalogDisable,
  SecretCatalogEntryRead,
  SecretCatalogListPage,
  SecretCatalogRotate,
} from '@du/contracts';
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';

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
  encrypted_value: { v: number; alg: string; iv: string; tag: string; ct: string } | null;
  rotated_at: Date | null;
  rotation_interval_days: number | null;
  disabled_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

export function resolveSecretStoreKey(customKey?: string): Buffer {
  const rawKey = customKey || process.env.ENCRYPTION_KEY || process.env.NEXTAUTH_SECRET || 'du-secret-catalog-default-fallback-key';
  return createHash('sha256').update(rawKey).digest();
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
): Promise<SecretCatalogEntryRead> {
  const key = resolveSecretStoreKey(encryptionKey);
  const secretId = randomUUID();

  let encryptedValue: unknown = null;
  let providerConfig: Record<string, unknown> = {};

  if (input.provider.kind === 'managed_value') {
    if (!input.value || typeof input.value.value !== 'string') {
      throw new HttpError(422, 'INVALID_SCHEMA', 'managed_value requires a literal value');
    }
    encryptedValue = encryptSecretValue(input.value.value, key);
  } else {
    providerConfig = { ...input.provider };
  }

  const result = await db.query<SecretCatalogRow>(
    `INSERT INTO secret_catalog (
      secret_id, tenant_id, name, purpose, services, provider_kind, provider_config, state, revision, encrypted_value, created_at, updated_at
    ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'ACTIVE', 1, $8, now(), now())
    RETURNING *`,
    [
      secretId,
      input.tenantId,
      input.name,
      input.purpose,
      input.services,
      input.provider.kind,
      JSON.stringify(providerConfig),
      encryptedValue ? JSON.stringify(encryptedValue) : null,
    ],
  );

  if (!result.rowCount || !result.rows[0]) {
    throw new HttpError(500, 'STORAGE_ERROR', 'failed to persist secret');
  }

  return toSecretRead(result.rows[0]);
}

export async function listSecretsFromDb(
  db: Db,
  params: {
    tenantId?: string;
    limit?: number;
    cursor?: string;
    state?: string;
    purpose?: string;
  },
): Promise<SecretCatalogListPage> {
  const limit = Math.min(Math.max(params.limit ?? 50, 1), 200);

  const conditions: string[] = [];
  const args: unknown[] = [];

  if (params.tenantId && params.tenantId.trim() !== '') {
    args.push(params.tenantId.trim());
    conditions.push(`tenant_id = $${args.length}`);
  }
  if (params.state && params.state.trim() !== '') {
    args.push(params.state.trim());
    conditions.push(`state = $${args.length}`);
  }
  if (params.purpose && params.purpose.trim() !== '') {
    args.push(params.purpose.trim());
    conditions.push(`purpose = $${args.length}`);
  }

  args.push(limit);
  const limitIndex = args.length;

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const result = await db.query<SecretCatalogRow>(
    `SELECT secret_id, tenant_id, name, purpose, services, provider_kind, provider_config, state, revision,
            encrypted_value, rotated_at, rotation_interval_days, disabled_reason, created_at, updated_at
     FROM secret_catalog
     ${whereClause}
     ORDER BY created_at DESC
     LIMIT $${limitIndex}`,
    args,
  );

  const items = result.rows.map(toSecretRead);
  return {
    items,
    nextCursor: null,
  };
}

export async function rotateSecretInDb(
  db: Db,
  secretId: string,
  input: SecretCatalogRotate,
  encryptionKey?: string,
): Promise<SecretCatalogEntryRead> {
  const key = resolveSecretStoreKey(encryptionKey);
  const current = await db.query<SecretCatalogRow>(
    `SELECT * FROM secret_catalog WHERE secret_id = $1`,
    [secretId],
  );

  if (!current.rowCount || !current.rows[0]) {
    throw new HttpError(404, 'NOT_FOUND', `secret ${secretId} not found`);
  }

  const row = current.rows[0];
  if (row.revision !== input.expectedRevision) {
    throw new HttpError(409, 'CONFLICT', `revision conflict: expected ${input.expectedRevision}, current is ${row.revision}`);
  }
  if (row.provider_kind !== 'managed_value') {
    throw new HttpError(400, 'INVALID_PROVIDER', 'vault references cannot be rotated via managed value');
  }

  const newEncrypted = encryptSecretValue(input.value.value, key);
  const updated = await db.query<SecretCatalogRow>(
    `UPDATE secret_catalog
     SET revision = revision + 1,
         encrypted_value = $2,
         rotated_at = now(),
         updated_at = now()
     WHERE secret_id = $1 AND revision = $3
     RETURNING *`,
    [secretId, JSON.stringify(newEncrypted), input.expectedRevision],
  );

  if (!updated.rowCount || !updated.rows[0]) {
    throw new HttpError(409, 'CONFLICT', 'concurrent update detected during rotation');
  }

  return toSecretRead(updated.rows[0]);
}

export async function disableSecretInDb(
  db: Db,
  secretId: string,
  input: SecretCatalogDisable,
): Promise<SecretCatalogEntryRead> {
  const current = await db.query<SecretCatalogRow>(
    `SELECT * FROM secret_catalog WHERE secret_id = $1`,
    [secretId],
  );

  if (!current.rowCount || !current.rows[0]) {
    throw new HttpError(404, 'NOT_FOUND', `secret ${secretId} not found`);
  }

  const row = current.rows[0];
  if (row.revision !== input.expectedRevision) {
    throw new HttpError(409, 'CONFLICT', `revision conflict: expected ${input.expectedRevision}, current is ${row.revision}`);
  }

  const updated = await db.query<SecretCatalogRow>(
    `UPDATE secret_catalog
     SET state = 'DISABLED',
         disabled_reason = $2,
         updated_at = now()
     WHERE secret_id = $1 AND revision = $3
     RETURNING *`,
    [secretId, input.reason, input.expectedRevision],
  );

  if (!updated.rowCount || !updated.rows[0]) {
    throw new HttpError(409, 'CONFLICT', 'concurrent update detected during disable');
  }

  return toSecretRead(updated.rows[0]);
}

export async function testSecretInDb(
  db: Db,
  secretId: string,
  encryptionKey?: string,
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
      const key = resolveSecretStoreKey(encryptionKey);
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
