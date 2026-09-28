import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import {
  PostgresCryptoConfigStore,
} from '../src/app/admin/crypto-config-store';
import {
  EMPTY_CRYPTO_CONFIG,
  type CryptoConfigState,
} from '../src/app/admin/crypto-config-view-models';

interface StoredRow extends QueryResultRow {
  tenant_id: string;
  storage_key_ref: string | null;
  delivery_encryption: boolean;
  pinned_recipient_key_version: number | null;
}

class MemoryCryptoConfigDb implements Pick<Db, 'query'> {
  readonly rows = new Map<string, StoredRow>();
  writes = 0;
  queries: string[] = [];

  async query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params: unknown[] = [],
  ): Promise<QueryResult<T>> {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.queries.push(sql);
    if (sql.startsWith('SELECT tenant_id, storage_key_ref')) {
      const row = this.rows.get(String(params[0]));
      return this.result(row ? [row] : []);
    }
    if (sql.startsWith('INSERT INTO admin_crypto_config')) {
      const tenantId = String(params[0]);
      const next: StoredRow = {
        tenant_id: tenantId,
        storage_key_ref: params[1] as string | null,
        delivery_encryption: params[2] as boolean,
        pinned_recipient_key_version: params[3] as number | null,
      };
      const previous = this.rows.get(tenantId);
      if (
        previous
        && previous.storage_key_ref === next.storage_key_ref
        && previous.delivery_encryption === next.delivery_encryption
        && previous.pinned_recipient_key_version === next.pinned_recipient_key_version
      ) {
        return this.result([]);
      }
      this.rows.set(tenantId, next);
      this.writes += 1;
      return this.result([next]);
    }
    throw new Error('unexpected crypto config query');
  }

  private result<T extends QueryResultRow>(rows: StoredRow[]): QueryResult<T> {
    return {
      command: 'SELECT',
      rowCount: rows.length,
      oid: 0,
      fields: [],
      rows: rows as unknown as T[],
    };
  }
}

const ALLOWED_REFS = ['transit-primary', 'transit-secondary'];

function configStore(db = new MemoryCryptoConfigDb()) {
  return { db, store: new PostgresCryptoConfigStore(db, ALLOWED_REFS) };
}

describe('ENC-08 persistent crypto config store', () => {
  it('saves and reloads the complete tenant config through an idempotent upsert', async () => {
    const { db, store } = configStore();
    const next: CryptoConfigState = {
      storageKeyRef: 'transit-primary',
      deliveryEncryption: true,
      pinnedRecipientKeyVersion: 4,
    };

    await expect(store.get('tenant-alpha')).resolves.toEqual(EMPTY_CRYPTO_CONFIG);
    await expect(store.set('tenant-alpha', next)).resolves.toEqual(next);
    await expect(store.get('tenant-alpha')).resolves.toEqual(next);
    await expect(store.set('tenant-alpha', next)).resolves.toEqual(next);

    expect(db.rows.size).toBe(1);
    expect(db.writes).toBe(1);
    expect(db.queries.filter((sql) => sql.startsWith('INSERT INTO admin_crypto_config'))).toHaveLength(2);
  });

  it('keeps values isolated by tenant id on both save and reload', async () => {
    const { db, store } = configStore();
    const alpha: CryptoConfigState = {
      storageKeyRef: 'transit-primary',
      deliveryEncryption: true,
      pinnedRecipientKeyVersion: 2,
    };
    const beta: CryptoConfigState = {
      storageKeyRef: 'transit-secondary',
      deliveryEncryption: false,
      pinnedRecipientKeyVersion: null,
    };

    await store.set('tenant-alpha', alpha);
    await store.set('tenant-beta', beta);

    await expect(store.get('tenant-alpha')).resolves.toEqual(alpha);
    await expect(store.get('tenant-beta')).resolves.toEqual(beta);
    expect(db.rows.size).toBe(2);
  });

  it('rejects a non-allowlisted ref before writing and fails closed on a stale stored ref', async () => {
    const { db, store } = configStore();
    await expect(store.set('tenant-alpha', {
      storageKeyRef: 'unapproved-ref',
      deliveryEncryption: false,
      pinnedRecipientKeyVersion: null,
    })).rejects.toThrow('not allowlisted');
    expect(db.queries).toHaveLength(0);

    db.rows.set('tenant-alpha', {
      tenant_id: 'tenant-alpha',
      storage_key_ref: 'removed-from-allowlist',
      delivery_encryption: false,
      pinned_recipient_key_version: null,
    });
    await expect(store.get('tenant-alpha')).rejects.toThrow('non-allowlisted key ref');
  });

  it('rejects invalid tenant ids and non-positive key versions', async () => {
    const { db, store } = configStore();
    await expect(store.get('Tenant Alpha')).rejects.toThrow('tenantId is invalid');
    await expect(store.set('tenant-alpha', {
      storageKeyRef: null,
      deliveryEncryption: false,
      pinnedRecipientKeyVersion: 0,
    })).rejects.toThrow('recipient key version is invalid');
    expect(db.queries).toHaveLength(0);
  });
});
