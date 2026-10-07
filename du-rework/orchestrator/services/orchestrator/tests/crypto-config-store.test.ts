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

// CR28-08: persistence-layer negatives for the crypto config store.
//
// Two packet items have NO target in this module and are reported as such
// rather than faked: the store persists an allowlisted key REF and a version
// NUMBER, so (a) it never parses a public-key PEM, and (b) it has no registry
// access at all, so it cannot fence a revoked version. Both are pinned below as
// explicit layering facts so nobody later assumes the store enforces them.
describe('CR28-08 store: recipient key version boundaries', () => {
  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['two past MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER + 2],
  ])('refuses a %s pin before touching the database', async (_label, version) => {
    const { db, store } = configStore();

    await expect(store.set('tenant-alpha', {
      storageKeyRef: null,
      deliveryEncryption: false,
      pinnedRecipientKeyVersion: version as number,
    })).rejects.toThrow('recipient key version is invalid');
    expect(db.queries).toHaveLength(0);
  });

  it.each([
    ['the lowest positive version', 1],
    ['MAX_SAFE_INTEGER', Number.MAX_SAFE_INTEGER],
  ])('accepts %s as a pin', async (_label, version) => {
    const { db, store } = configStore();
    const saved = await store.set('tenant-alpha', {
      storageKeyRef: null,
      deliveryEncryption: false,
      pinnedRecipientKeyVersion: version,
    });

    expect(saved.pinnedRecipientKeyVersion).toBe(version);
    await expect(store.get('tenant-alpha')).resolves.toEqual(saved);
    expect(db.writes).toBe(1);
  });

  it('null clears the pin and is distinct from a rejected version', async () => {
    const { db, store } = configStore();
    await store.set('tenant-alpha', { storageKeyRef: null, deliveryEncryption: false, pinnedRecipientKeyVersion: 3 });
    const cleared = await store.set('tenant-alpha', { storageKeyRef: null, deliveryEncryption: false, pinnedRecipientKeyVersion: null });

    expect(cleared.pinnedRecipientKeyVersion).toBeNull();
    await expect(store.get('tenant-alpha')).resolves.toEqual(cleared);
  });

  it('LAYERING: a version this tenant never registered is still persisted', async () => {
    const { store } = configStore();
    // The store validates the SHAPE of a version, never its registration. The
    // fence that refuses an unregistered or revoked version lives one layer up
    // in applyCryptoConfig, which can see the registry. Documented here so nobody
    // assumes this class is a second line of defence.
    const saved = await store.set('tenant-alpha', {
      storageKeyRef: null,
      deliveryEncryption: true,
      pinnedRecipientKeyVersion: 999_999,
    });
    expect(saved.pinnedRecipientKeyVersion).toBe(999_999);
  });

  it.each([
    ['zero', 0],
    ['negative', -5],
    ['fractional', 2.5],
    ['a string', '3'],
    ['undefined', undefined],
  ])('fails closed reading a row whose stored pin is %s', async (_label, version) => {
    const { db, store } = configStore();
    db.rows.set('tenant-alpha', {
      tenant_id: 'tenant-alpha',
      storage_key_ref: null,
      delivery_encryption: false,
      pinned_recipient_key_version: version as number | null,
    });

    // The READ path re-checks what the WRITE path checked, so a row that predates
    // the guard or arrived through a migration cannot be served as a valid pin.
    await expect(store.get('tenant-alpha')).rejects.toThrow('stored crypto configuration is invalid');
  });

  it.each([
    ['a string', 'true'],
    ['a number', 1],
    ['null', null],
    ['undefined', undefined],
  ])('fails closed reading a row whose delivery flag is %s', async (_label, flag) => {
    const { db, store } = configStore();
    db.rows.set('tenant-alpha', {
      tenant_id: 'tenant-alpha',
      storage_key_ref: null,
      delivery_encryption: flag as unknown as boolean,
      pinned_recipient_key_version: null,
    });

    await expect(store.get('tenant-alpha')).rejects.toThrow('stored crypto configuration is invalid');
  });

  it.each([
    ['a number', 7],
    ['an object', { ref: 'transit-primary' }],
    ['an array', ['transit-primary']],
    ['an empty string', ''],
    ['undefined', undefined],
  ])('fails closed reading a row whose key ref is %s', async (_label, ref) => {
    const { db, store } = configStore();
    db.rows.set('tenant-alpha', {
      tenant_id: 'tenant-alpha',
      storage_key_ref: ref as unknown as string | null,
      delivery_encryption: false,
      pinned_recipient_key_version: null,
    });

    // A wrongly typed ref is caught by the ALLOWLIST membership test rather than
    // by a type test, so the message names the allowlist. Behaviour is right; the
    // message is what an operator will read at 3am.
    await expect(store.get('tenant-alpha')).rejects.toThrow('non-allowlisted key ref');
  });

  it('fails closed when the row belongs to a different tenant', async () => {
    const { db, store } = configStore();
    db.rows.set('tenant-alpha', {
      tenant_id: 'tenant-beta',
      storage_key_ref: 'transit-primary',
      delivery_encryption: true,
      pinned_recipient_key_version: 1,
    });

    // Belt and braces on the query itself: the WHERE clause already scopes the
    // row, and decodeRow refuses to serve a row whose tenant does not match.
    await expect(store.get('tenant-alpha')).rejects.toThrow('tenant mismatch');
  });
});

describe('CR28-08 store: non-existent tenant lookup', () => {
  it('returns an EMPTY config for a well-formed tenant that has no row', async () => {
    const { db, store } = configStore();
    const view = await store.get('tenant-never-configured');

    expect(view).toEqual(EMPTY_CRYPTO_CONFIG);
    // A miss must not write: this is a read path, and a config row appearing for
    // a tenant nobody configured would be a surprise the pane could not explain.
    expect(db.rows.size).toBe(0);
    expect(db.writes).toBe(0);
    expect(db.queries).toHaveLength(1);
  });

  it('returns a FRESH empty object each miss, so a caller cannot poison the constant', async () => {
    const { store } = configStore();
    const first = await store.get('tenant-alpha');
    (first as { storageKeyRef: string | null }).storageKeyRef = 'tampered-by-caller';
    (first as { pinnedRecipientKeyVersion: number | null }).pinnedRecipientKeyVersion = 42;

    const second = await store.get('tenant-alpha');
    // EMPTY_CRYPTO_CONFIG is a module-level const. `get` spreads it, so a caller
    // mutating what it received cannot change what the next caller reads. If a
    // future refactor returned the const directly, this test is what fails.
    expect(second).toEqual(EMPTY_CRYPTO_CONFIG);
    expect(EMPTY_CRYPTO_CONFIG.storageKeyRef).toBeNull();
    expect(EMPTY_CRYPTO_CONFIG.pinnedRecipientKeyVersion).toBeNull();
  });

  it.each([
    ['a single quote', "tenant-alpha'"],
    ['a comment marker', 'tenant-alpha -- x'],
    ['a semicolon', 'tenant-alpha; DROP TABLE admin_crypto_config'],
    ['a dollar placeholder', 'tenant-$1'],
    ['a NUL byte', 'tenant' + String.fromCharCode(0)],
    ['a newline', 'tenant' + String.fromCharCode(10)],
    ['a space', 'tenant alpha'],
    ['a leading dash', '-tenant-alpha'],
  ])('refuses %s before issuing a query', async (_label, tenantId) => {
    const { db, store } = configStore();

    // The tenant id is a bound parameter in the SQL, and the shape guard refuses
    // the injection-shaped values before the query is even built.
    await expect(store.get(tenantId)).rejects.toThrow('tenantId is invalid');
    await expect(store.set(tenantId, EMPTY_CRYPTO_CONFIG)).rejects.toThrow('tenantId is invalid');
    expect(db.queries).toHaveLength(0);
  });

  it('the SELECT is parameterised, never string-interpolated', async () => {
    const { db, store } = configStore();
    await store.get('tenant-alpha');
    expect(db.queries[0]).toContain('WHERE tenant_id = $1');
    expect(db.queries[0]).not.toContain('tenant-alpha');
  });

  it.each([
    ['tenant-alpha-2'],
    ['tenant-alph'],
    ['tenant-alphax'],
    ['tenant2-alpha'],
  ])('a near-miss tenant %s gets its OWN empty config, never a neighbour row', async (tenantId) => {
    const { db, store } = configStore();
    db.rows.set('tenant-alpha', {
      tenant_id: 'tenant-alpha',
      storage_key_ref: 'transit-primary',
      delivery_encryption: true,
      pinned_recipient_key_version: 1,
    });

    await expect(store.get(tenantId)).resolves.toEqual(EMPTY_CRYPTO_CONFIG);
  });
});

describe('CR28-08 store: key ref handling (PEM is NOT parsed here)', () => {
  it.each([
    ['a number', 7],
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['an object', { ref: 'x' }],
  ])('refuses an allowlist entry that is %s at construction', (_label, ref) => {
    const db = new MemoryCryptoConfigDb();

    // The allowlist is copied into a Set at construction, so one bad entry makes
    // the whole store unbuildable rather than a silently ignored entry.
    expect(() => new PostgresCryptoConfigStore(db, [ref as unknown as string])).toThrow(
      'allowed Vault key refs must be non-empty strings',
    );
  });

  it('an empty allowlist builds, and every ref is then refused', async () => {
    const db = new MemoryCryptoConfigDb();
    const store = new PostgresCryptoConfigStore(db, []);

    await expect(store.set('tenant-alpha', {
      storageKeyRef: 'transit-primary', deliveryEncryption: false, pinnedRecipientKeyVersion: null,
    })).rejects.toThrow('not allowlisted');
    await expect(store.get('tenant-alpha')).resolves.toEqual(EMPTY_CRYPTO_CONFIG);
  });

  it('LAYERING: a PEM-shaped ref is governed ONLY by the allowlist, never parsed', async () => {
    const db = new MemoryCryptoConfigDb();
    const pem = '-----BEGIN PUBLIC KEY-----AAAA-----END PUBLIC KEY-----';

    // The packet asked for corrupt PEM negatives. This module never parses a
    // public key: it persists an allowlisted REF. So a ref that LOOKS like a PEM
    // is stored happily, and a real PEM that is not allowlisted is refused - the
    // membership test is the whole gate. PINNED so nobody mistakes this class for
    // a key-material validator; that one is the recipient-key registry.
    const allowlisted = new PostgresCryptoConfigStore(db, [pem]);
    const saved = await allowlisted.set('tenant-alpha', {
      storageKeyRef: pem, deliveryEncryption: false, pinnedRecipientKeyVersion: null,
    });
    expect(saved.storageKeyRef).toBe(pem);

    const notAllowlisted = new PostgresCryptoConfigStore(new MemoryCryptoConfigDb(), ['transit-primary']);
    await expect(notAllowlisted.set('tenant-alpha', {
      storageKeyRef: pem, deliveryEncryption: false, pinnedRecipientKeyVersion: null,
    })).rejects.toThrow('not allowlisted');
  });

  it('duplicate allowlist entries collapse, and the copy is not the caller array', async () => {
    const db = new MemoryCryptoConfigDb();
    const refs = ['transit-primary', 'transit-primary', 'transit-secondary'];
    const store = new PostgresCryptoConfigStore(db, refs);

    await store.set('tenant-alpha', { storageKeyRef: 'transit-primary', deliveryEncryption: false, pinnedRecipientKeyVersion: null });

    // Mutating the caller's array afterwards must not change what the store
    // accepts - the Set is a defensive copy for the same reason the empty config
    // is spread on read.
    refs.push('smuggled-ref');
    refs.length = 0;
    await expect(store.get('tenant-alpha')).resolves.toMatchObject({ storageKeyRef: 'transit-primary' });
    await expect(store.set('tenant-alpha', { storageKeyRef: 'smuggled-ref', deliveryEncryption: false, pinnedRecipientKeyVersion: null }))
      .rejects.toThrow('not allowlisted');
  });

  it('shrinking the allowlist makes a STORED ref fail closed on the next read', async () => {
    const db = new MemoryCryptoConfigDb();
    const generous = new PostgresCryptoConfigStore(db, ['transit-primary', 'transit-secondary']);
    await generous.set('tenant-alpha', { storageKeyRef: 'transit-secondary', deliveryEncryption: false, pinnedRecipientKeyVersion: null });

    // The stored row is untouched; only the PLATFORM policy moved. A deployment
    // that withdraws a ref must stop serving it, not keep answering from the row.
    const tightened = new PostgresCryptoConfigStore(db, ['transit-primary']);
    await expect(tightened.get('tenant-alpha')).rejects.toThrow('non-allowlisted key ref');
  });
});

describe('CR28-08 store: upsert races and the read-back fallback', () => {
  /**
   * A double whose conditional-update can be made to no-op, and whose follow-up
   * SELECT can be told to return something OTHER than what was just written - the
   * shape of a second writer landing between the INSERT and the read-back.
   */
  function racingDb(opts: { conflictNoop?: boolean; selectOverride?: StoredRow | null } = {}) {
    const state: { selectOverride: StoredRow | null | undefined } = { selectOverride: opts.selectOverride };
    const log: string[] = [];
    const db = {
      async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
        const sql = text.replace(/\s+/g, ' ').trim();
        log.push(sql.startsWith('SELECT') ? 'SELECT' : 'UPSERT');
        if (sql.startsWith('SELECT')) {
          const row = state.selectOverride === undefined ? null : state.selectOverride;
          return { command: 'SELECT', rowCount: row ? 1 : 0, oid: 0, fields: [], rows: (row ? [row] : []) as unknown as T[] };
        }
        if (opts.conflictNoop) {
          return { command: 'INSERT', rowCount: 0, oid: 0, fields: [], rows: [] as unknown as T[] };
        }
        const row: StoredRow = {
          tenant_id: String(params[0]),
          storage_key_ref: params[1] as string | null,
          delivery_encryption: params[2] as boolean,
          pinned_recipient_key_version: params[3] as number | null,
        };
        return { command: 'INSERT', rowCount: 1, oid: 0, fields: [], rows: [row] as unknown as T[] };
      },
    } as unknown as MemoryCryptoConfigDb;
    return { db: db as never as MemoryCryptoConfigDb, log, state, setOverride: (row: StoredRow | null) => { state.selectOverride = row; } };
  }

  it('an identical retry takes the read-back path and issues a second query', async () => {
    const r = racingDb({ conflictNoop: true });
    r.setOverride({
      tenant_id: 'tenant-alpha',
      storage_key_ref: 'transit-primary',
      delivery_encryption: true,
      pinned_recipient_key_version: 4,
    });
    const store = new PostgresCryptoConfigStore(r.db, ['transit-primary']);

    // The conditional DO UPDATE ... WHERE IS DISTINCT FROM returns no row for an
    // identical retry, so the store reads the persisted value back rather than
    // inventing one. The second query is the observable proof of that path.
    const result = await store.set('tenant-alpha', {
      storageKeyRef: 'transit-primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 4,
    });
    expect(r.log).toEqual(['UPSERT', 'SELECT']);
    expect(result).toEqual({ storageKeyRef: 'transit-primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 4 });
  });

  it('a changed write is served straight from the RETURNING row, with no second query', async () => {
    const r = racingDb();
    const store = new PostgresCryptoConfigStore(r.db, ['transit-primary']);

    const result = await store.set('tenant-alpha', {
      storageKeyRef: 'transit-primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 2,
    });
    expect(r.log).toEqual(['UPSERT']);
    expect(result).toEqual({ storageKeyRef: 'transit-primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 2 });
  });

  it('FINDING: a concurrent writer can make set() return a value it never persisted', async () => {
    const r = racingDb({ conflictNoop: true });
    // Another writer lands between the conditional update and the read-back.
    r.setOverride({
      tenant_id: 'tenant-alpha',
      storage_key_ref: 'transit-secondary',
      delivery_encryption: false,
      pinned_recipient_key_version: 9,
    });
    const store = new PostgresCryptoConfigStore(r.db, ['transit-primary', 'transit-secondary']);

    const result = await store.set('tenant-alpha', {
      storageKeyRef: 'transit-primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 4,
    });

    // The read-back fallback reports whatever the row holds at THAT moment, so the
    // caller receives a state it did not ask for. It is the persisted truth, which
    // is the right thing to return, but it means the return value is not proof
    // that THIS call wrote it.
    expect(result).toEqual({ storageKeyRef: 'transit-secondary', deliveryEncryption: false, pinnedRecipientKeyVersion: 9 });
  });

  it('FINDING: a concurrent delete between the write and the read-back yields an EMPTY config', async () => {
    const r = racingDb({ conflictNoop: true });
    r.setOverride(null);
    const store = new PostgresCryptoConfigStore(r.db, ['transit-primary']);

    const result = await store.set('tenant-alpha', {
      storageKeyRef: 'transit-primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 4,
    });

    // The row is gone by the time the fallback SELECT runs, so set() reports the
    // empty config for a tenant it was just asked to configure. The write is
    // conditional and the read-back is not part of the same statement, so there is
    // no way for the store to tell the caller its own write did not survive.
    expect(result).toEqual(EMPTY_CRYPTO_CONFIG);
  });
});

describe('CR28-08 store: revoked key fence is NOT this layer', () => {
  it('LAYERING: a revoked version number is persisted, because the store cannot know', async () => {
    const { db, store } = configStore();

    // The store has NO registry access: its constructor takes a db and an
    // allowlist, nothing else. So "is this version revoked" is unanswerable here
    // and the honest behaviour is to persist the number and let the API layer
    // refuse the pin. Pinned so a future reader does not assume a second fence
    // exists below the API.
    const saved = await store.set('tenant-alpha', {
      storageKeyRef: 'transit-primary', deliveryEncryption: true, pinnedRecipientKeyVersion: 1,
    });
    expect(saved.pinnedRecipientKeyVersion).toBe(1);

    // Nothing in the persisted row records revocation either, so a later read
    // cannot tell a valid pin from a revoked one.
    const row = db.rows.get('tenant-alpha')!;
    expect(Object.keys(row).sort()).toEqual([
      'delivery_encryption', 'pinned_recipient_key_version', 'storage_key_ref', 'tenant_id',
    ]);
  });

  it('a revoked-looking ref is refused only because the allowlist says so', async () => {
    const db = new MemoryCryptoConfigDb();
    const store = new PostgresCryptoConfigStore(db, ['transit-primary']);

    // Refs carry no state, so a withdrawn ref and a revoked key VERSION are two
    // different mechanisms. The store implements the first only.
    await expect(store.set('tenant-alpha', {
      storageKeyRef: 'transit-withdrawn', deliveryEncryption: false, pinnedRecipientKeyVersion: null,
    })).rejects.toThrow('not allowlisted');
    expect(db.queries).toHaveLength(0);
  });
});
