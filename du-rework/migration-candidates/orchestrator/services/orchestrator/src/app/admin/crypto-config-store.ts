/**
 * PostgreSQL persistence for the ENC-08 per-tenant crypto configuration.
 *
 * Only allowlisted Vault key refs are accepted or returned. The database stores the
 * ref and policy metadata; Transit key material and recipient public-key material stay
 * in their respective providers.
 */

import type { QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import type { CryptoConfigStore } from './crypto-config-api';
import {
  EMPTY_CRYPTO_CONFIG,
  type CryptoConfigState,
} from './crypto-config-view-models';

interface CryptoConfigRow extends QueryResultRow {
  tenant_id: string;
  storage_key_ref: string | null;
  delivery_encryption: boolean;
  pinned_recipient_key_version: number | null;
}

const SELECT_SQL = `
  SELECT tenant_id, storage_key_ref, delivery_encryption, pinned_recipient_key_version
    FROM admin_crypto_config
   WHERE tenant_id = $1
`;

const UPSERT_SQL = `
  INSERT INTO admin_crypto_config (
    tenant_id, storage_key_ref, delivery_encryption, pinned_recipient_key_version
  ) VALUES ($1, $2, $3, $4)
  ON CONFLICT (tenant_id) DO UPDATE SET
    storage_key_ref = EXCLUDED.storage_key_ref,
    delivery_encryption = EXCLUDED.delivery_encryption,
    pinned_recipient_key_version = EXCLUDED.pinned_recipient_key_version,
    updated_at = now()
  WHERE (admin_crypto_config.storage_key_ref,
         admin_crypto_config.delivery_encryption,
         admin_crypto_config.pinned_recipient_key_version)
        IS DISTINCT FROM
        (EXCLUDED.storage_key_ref,
         EXCLUDED.delivery_encryption,
         EXCLUDED.pinned_recipient_key_version)
  RETURNING tenant_id, storage_key_ref, delivery_encryption, pinned_recipient_key_version
`;

export interface PostgresCryptoConfigStoreOptions {
  readonly db: Pick<Db, 'query'>;
  /** The platform-owned Vault Transit refs that may be persisted. */
  readonly allowedKeyRefs: readonly string[];
}

function validateTenantId(tenantId: string): string {
  if (typeof tenantId !== 'string' || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(tenantId)) {
    throw new TypeError('tenantId is invalid');
  }
  return tenantId;
}

function validateState(
  next: CryptoConfigState,
  allowedKeyRefs: ReadonlySet<string>,
): CryptoConfigState {
  if (!next || typeof next !== 'object') throw new TypeError('crypto configuration is invalid');

  const { storageKeyRef, deliveryEncryption, pinnedRecipientKeyVersion } = next;
  if (storageKeyRef !== null && (typeof storageKeyRef !== 'string' || !allowedKeyRefs.has(storageKeyRef))) {
    throw new TypeError('storage key ref is not allowlisted');
  }
  if (typeof deliveryEncryption !== 'boolean') {
    throw new TypeError('delivery encryption setting is invalid');
  }
  if (
    pinnedRecipientKeyVersion !== null
    && (!Number.isSafeInteger(pinnedRecipientKeyVersion) || pinnedRecipientKeyVersion < 1)
  ) {
    throw new TypeError('recipient key version is invalid');
  }

  return { storageKeyRef, deliveryEncryption, pinnedRecipientKeyVersion };
}

function decodeRow(
  row: CryptoConfigRow,
  tenantId: string,
  allowedKeyRefs: ReadonlySet<string>,
): CryptoConfigState {
  if (row.tenant_id !== tenantId) throw new Error('crypto configuration tenant mismatch');
  if (typeof row.delivery_encryption !== 'boolean') {
    throw new Error('stored crypto configuration is invalid');
  }
  if (
    row.pinned_recipient_key_version !== null
    && (!Number.isSafeInteger(row.pinned_recipient_key_version) || row.pinned_recipient_key_version < 1)
  ) {
    throw new Error('stored crypto configuration is invalid');
  }
  if (row.storage_key_ref !== null && !allowedKeyRefs.has(row.storage_key_ref)) {
    throw new Error('stored crypto configuration contains a non-allowlisted key ref');
  }
  return {
    storageKeyRef: row.storage_key_ref,
    deliveryEncryption: row.delivery_encryption,
    pinnedRecipientKeyVersion: row.pinned_recipient_key_version,
  };
}

/**
 * Persistent implementation of the API store port. The tenant id is the sole key for
 * every read and upsert, so one tenant's settings cannot overwrite or reveal another's.
 */
export class PostgresCryptoConfigStore implements CryptoConfigStore {
  private readonly allowedKeyRefs: ReadonlySet<string>;

  constructor(private readonly db: Pick<Db, 'query'>, allowedKeyRefs: readonly string[]) {
    const copied = new Set<string>();
    for (const ref of allowedKeyRefs) {
      if (typeof ref !== 'string' || ref.length === 0) {
        throw new TypeError('allowed Vault key refs must be non-empty strings');
      }
      copied.add(ref);
    }
    this.allowedKeyRefs = copied;
  }

  async get(tenantId: string): Promise<CryptoConfigState> {
    const validTenantId = validateTenantId(tenantId);
    const result = await this.db.query<CryptoConfigRow>(SELECT_SQL, [validTenantId]);
    const row = result.rows[0];
    return row
      ? decodeRow(row, validTenantId, this.allowedKeyRefs)
      : { ...EMPTY_CRYPTO_CONFIG };
  }

  async set(tenantId: string, next: CryptoConfigState): Promise<CryptoConfigState> {
    const validTenantId = validateTenantId(tenantId);
    const state = validateState(next, this.allowedKeyRefs);
    const result = await this.db.query<CryptoConfigRow>(UPSERT_SQL, [
      validTenantId,
      state.storageKeyRef,
      state.deliveryEncryption,
      state.pinnedRecipientKeyVersion,
    ]);
    const row = result.rows[0];
    // The conditional conflict update returns no row for an identical retry. Read the
    // existing value so the store port always returns the persisted state.
    return row
      ? decodeRow(row, validTenantId, this.allowedKeyRefs)
      : this.get(validTenantId);
  }
}

export function createPostgresCryptoConfigStore(
  options: PostgresCryptoConfigStoreOptions,
): CryptoConfigStore {
  return new PostgresCryptoConfigStore(options.db, options.allowedKeyRefs);
}
