import type { QueryResultRow } from 'pg';
import { createHmac } from 'node:crypto';
import { isTenantUuid } from '@du/contracts';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import { decryptSecretValue } from './secret-catalog-store';

const KEY_VERSION = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const SECRET_VERSION_REF = /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})@([1-9][0-9]{0,8})$/i;

export interface SecretCatalogKeyring {
  activeVersion: string;
  /** Each value is an exact 32-byte AES key. Versions are never inferred. */
  keys: Readonly<Record<string, Buffer>>;
}

interface SecretVersionRow extends QueryResultRow {
  secret_id: string;
  tenant_id: string;
  revision: number | string;
  purpose: string;
  services: string[];
  provider_kind: 'managed_value' | 'vault_reference';
  state: 'ACTIVE' | 'DISABLED' | 'REVOKED';
  encrypted_value: unknown;
  encryption_key_version: string | null;
  current_state: 'ACTIVE' | 'DISABLED' | 'REVOKED';
}

export interface SecretVersionResolveScope {
  tenantId: string;
  purpose:
    | 'connector.credential'
    | 'connector.provider_header'
    | 'profile.callback_header'
    | 'profile.callback_oauth2_client_secret'
    | 'oidc.client_secret'
    | 'source.auth'
    | 'storage.credential'
    | 'maintenance.backup_encryption'
    | 'generic';
  service: 'orchestrator' | 'connector';
}

export function parseSecretCatalogKeyring(
  env: NodeJS.ProcessEnv = process.env,
): SecretCatalogKeyring | undefined {
  const activeVersion = env['DU_SECRET_CATALOG_ACTIVE_KEY_VERSION']?.trim();
  const rawKeys = env['DU_SECRET_CATALOG_KEYRING_JSON']?.trim();
  if (!activeVersion && !rawKeys) {
    const master = env['ENCRYPTION_KEY'];
    if (master === undefined || master.length === 0) return undefined;
    // Transit-only deployments can still boot with their historical profile
    // cipher key. Managed Catalog operations then fail closed until a strong
    // ENCRYPTION_KEY or explicit Catalog keyring is supplied.
    if (Buffer.byteLength(master, 'utf8') < 32) return undefined;
    const version = 'encryption-key-v1';
    const key = createHmac('sha256', Buffer.from(master, 'utf8'))
      .update('du-secret-catalog/encryption-key/v1', 'utf8')
      .digest();
    return { activeVersion: version, keys: { [version]: key } };
  }
  if (!activeVersion || !rawKeys || !KEY_VERSION.test(activeVersion)) {
    throw new Error('DU_SECRET_CATALOG_ACTIVE_KEY_VERSION and DU_SECRET_CATALOG_KEYRING_JSON must be configured together');
  }
  let decoded: unknown;
  try { decoded = JSON.parse(rawKeys); } catch { throw new Error('DU_SECRET_CATALOG_KEYRING_JSON is invalid'); }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('DU_SECRET_CATALOG_KEYRING_JSON must be a version-to-base64-key object');
  }
  const keys: Record<string, Buffer> = Object.create(null) as Record<string, Buffer>;
  for (const [version, encoded] of Object.entries(decoded)) {
    if (!KEY_VERSION.test(version) || typeof encoded !== 'string') throw new Error('secret catalog keyring entry is invalid');
    const key = Buffer.from(encoded, 'base64');
    if (key.length !== 32 || key.toString('base64') !== encoded) throw new Error('secret catalog keys must be canonical base64 32-byte values');
    keys[version] = key;
  }
  if (!Object.hasOwn(keys, activeVersion)) throw new Error('active secret catalog key version is not present in the keyring');
  return { activeVersion, keys };
}

export function parseSecretVersionRef(reference: string): { secretId: string; revision: number } {
  const match = SECRET_VERSION_REF.exec(reference);
  if (!match) throw new HttpError(422, 'INVALID_SCHEMA', 'secret reference must pin an exact UUID revision');
  const revision = Number(match[2]);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new HttpError(422, 'INVALID_SCHEMA', 'secret reference revision is invalid');
  return { secretId: match[1]!, revision };
}

function requireKey(keyring: SecretCatalogKeyring | undefined, version: string | null): Buffer {
  if (!keyring || !version || !KEY_VERSION.test(version)) {
    throw new HttpError(503, 'SECRET_KEY_VERSION_UNAVAILABLE', 'the exact secret catalog encryption key version is not configured');
  }
  const key = keyring.keys[version];
  if (!key || !Buffer.isBuffer(key) || key.length !== 32) {
    throw new HttpError(503, 'SECRET_KEY_VERSION_UNAVAILABLE', 'the exact secret catalog encryption key version is not retained');
  }
  return key;
}

async function loadSecretVersion(
  db: Db,
  keyring: SecretCatalogKeyring | undefined,
  reference: string,
  scope: SecretVersionResolveScope,
): Promise<{ row: SecretVersionRow; value: string }> {
  if (!isTenantUuid(scope.tenantId) || !scope.purpose || !['orchestrator', 'connector'].includes(scope.service)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'secret resolution scope is invalid');
  }
  const { secretId, revision } = parseSecretVersionRef(reference);
  const result = await db.query<SecretVersionRow>(
    `SELECT v.secret_id,v.tenant_id,v.revision,v.purpose,v.services,v.provider_kind,v.state,
            v.encrypted_value,v.encryption_key_version,c.state AS current_state
       FROM secret_catalog_revisions v
       JOIN secret_catalog c ON c.secret_id=v.secret_id AND c.tenant_id=v.tenant_id
      WHERE v.secret_id=$1 AND v.revision=$2`,
    [secretId, revision],
  );
  const row = result.rows[0];
  if (!row) throw new HttpError(404, 'SECRET_VERSION_NOT_FOUND', 'the exact secret catalog revision is unavailable');
  if (row.tenant_id !== scope.tenantId) throw new HttpError(403, 'TENANT_MISMATCH', 'secret revision belongs to another tenant');
  if (row.purpose !== scope.purpose) throw new HttpError(403, 'PURPOSE_DENIED', 'secret revision is not authorized for this purpose');
  if (!row.services.includes(scope.service)) throw new HttpError(403, 'SERVICE_DENIED', 'secret revision is not authorized for this service');
  if (row.current_state === 'REVOKED' || row.state !== 'ACTIVE') {
    throw new HttpError(403, 'SECRET_REVOKED', 'secret revision is not resolvable');
  }
  if (row.provider_kind !== 'managed_value' || !row.encrypted_value) {
    throw new HttpError(422, 'SECRET_PROVIDER_UNSUPPORTED', 'exact secret revision is not a managed value');
  }
  const key = requireKey(keyring, row.encryption_key_version);
  let value: string;
  try { value = decryptSecretValue(row.encrypted_value, key); }
  catch { throw new HttpError(503, 'SECRET_DECRYPTION_FAILED', 'exact secret revision could not be decrypted'); }
  if (value.length < 1 || value.length > 64 * 1024 || value.includes('\0')) {
    throw new HttpError(503, 'SECRET_VALUE_INVALID', 'exact secret revision contains an unusable value');
  }
  return { row, value };
}

/** Resolve only an immutable archived version, with tenant/purpose/service fencing. */
export async function resolveManagedSecretVersion(
  db: Db,
  keyring: SecretCatalogKeyring | undefined,
  reference: string,
  scope: SecretVersionResolveScope,
): Promise<string> {
  return (await loadSecretVersion(db, keyring, reference, scope)).value;
}

export async function resolveManagedSecretVersionBytes(
  db: Db,
  keyring: SecretCatalogKeyring | undefined,
  reference: string,
  scope: SecretVersionResolveScope,
): Promise<Buffer> {
  return Buffer.from(await resolveManagedSecretVersion(db, keyring, reference, scope), 'utf8');
}

/** Verify exact row, purpose, service and key availability without returning plaintext. */
export async function verifyManagedSecretVersion(
  db: Db,
  keyring: SecretCatalogKeyring | undefined,
  reference: string,
  scope: SecretVersionResolveScope,
): Promise<void> {
  await loadSecretVersion(db, keyring, reference, scope);
}

/**
 * Validate an exact archived revision when the trusted host config contains
 * the reference but the canonical owner tenant is stored with the secret.
 * Only the non-secret owner UUID is returned. The supplied purpose/service
 * still fence the lookup, and the exact configured key must decrypt it.
 */
export async function resolveManagedSecretVersionMetadata(
  db: Db,
  keyring: SecretCatalogKeyring | undefined,
  reference: string,
  scope: Omit<SecretVersionResolveScope, 'tenantId'>,
): Promise<{ ownerTenantId: string }> {
  const { secretId, revision } = parseSecretVersionRef(reference);
  const result = await db.query<{ tenant_id: string }>(
    `SELECT v.tenant_id
       FROM secret_catalog_revisions v
       JOIN secret_catalog c ON c.secret_id=v.secret_id AND c.tenant_id=v.tenant_id
      WHERE v.secret_id=$1 AND v.revision=$2 AND v.purpose=$3 AND $4=ANY(v.services)
        AND v.state='ACTIVE' AND c.state<>'REVOKED'`,
    [secretId, revision, scope.purpose, scope.service],
  );
  const ownerTenantId = result.rows[0]?.tenant_id;
  if (!ownerTenantId) throw new HttpError(404, 'SECRET_VERSION_NOT_FOUND', 'the exact secret catalog revision is unavailable');
  await loadSecretVersion(db, keyring, reference, { ...scope, tenantId: ownerTenantId });
  return { ownerTenantId };
}

export function createSecretRevisionResolver(input: { db: Db; keyring?: SecretCatalogKeyring }) {
  return {
    resolve: (reference: string, scope: SecretVersionResolveScope) => resolveManagedSecretVersion(input.db, input.keyring, reference, scope),
    resolveBytes: (reference: string, scope: SecretVersionResolveScope) => resolveManagedSecretVersionBytes(input.db, input.keyring, reference, scope),
    verify: (reference: string, scope: SecretVersionResolveScope) => verifyManagedSecretVersion(input.db, input.keyring, reference, scope),
    metadata: (reference: string, scope: Omit<SecretVersionResolveScope, 'tenantId'>) => resolveManagedSecretVersionMetadata(input.db, input.keyring, reference, scope),
  };
}
