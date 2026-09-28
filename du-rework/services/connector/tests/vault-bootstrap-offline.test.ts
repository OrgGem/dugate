import { randomBytes } from 'node:crypto';
import {
  AesCredentialCipher,
  DurableConnectorManagement,
  PostgresConnectorConfigRepository,
  type AdapterConfig,
  type AdapterRegistry,
} from '../src';

/**
 * W-VAULT-LEGACY-TRANSITION-1 offline suite (connector side).
 *
 * Pins the storage-legal transition from the legacy UNBOUND revision to
 * the tenant-bound Vault chain. The transition obeys migration 008 rather
 * than fighting it: the shared legacy credential_ref can never join a
 * bound chain (chain guard), so bootstrap opens a FRESH chain key and
 * clones adapter/config from the validated legacy row, in ONE
 * transaction - a bound chain never exists without its ACTIVE row, and
 * a replayed bootstrap converges on the existing row instead of
 * colliding with the DB guard.
 *
 * The fake enforces the 008 CHECKs + chain-guard trigger analogously to
 * revision-binding.db.test.ts; SQL semantics are modeled, not real
 * PostgreSQL (live-PG leg stays open, same gate as cycle 9 Δ16).
 */

const baseConfig: AdapterConfig = { baseUrl: 'https://provider.example', path: '/v1/infer', timeoutMs: 1_000 };
const VAULT_SOURCE = {
  kind: 'vault-kv2' as const,
  account: 'acct-main',
  mount: 'secret',
  path: 'du/tenants/tenant-a/connectors/openai/accounts/acct-main',
  key: 'api-key',
  version: 3,
};
const LEGACY_SOURCE = { kind: 'legacy-db' as const, credentialRef: 'cred-shared' };

interface FakeRow {
  connector_id: string;
  revision: number;
  adapter: string;
  config: unknown;
  credential_ref: string;
  state: string;
  credential_source: unknown;
  tenant_id: string;
  account_id: string | null;
}

function normalize(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim();
}

class FakePg {
  readonly rows: FakeRow[] = [];
  readonly calls: string[] = [];
  inserts = 0;
  seed(row: FakeRow): void {
    this.rows.push(row);
  }
  private shape(row: FakeRow): Record<string, unknown> {
    return { ...row };
  }
  private kindOf(source: unknown): string {
    if (source === null || source === undefined) return 'legacy-db';
    return String((source as { kind?: unknown }).kind ?? 'legacy-db');
  }
  private enforce(row: FakeRow): void {
    const kind = this.kindOf(row.credential_source);
    if (row.tenant_id !== '' && kind !== 'vault-kv2') {
      throw new Error('check violation: bound rows must be vault-kv2');
    }
    if (kind === 'vault-kv2') {
      const source = row.credential_source as { path?: string; account?: string };
      const seg = String(source.path ?? '').split('/');
      if (seg.length !== 7 || seg[2] !== row.tenant_id || seg[4] !== row.connector_id
        || seg[6] !== String(row.account_id) || String(source.account ?? '') !== String(row.account_id)) {
        throw new Error('check violation: vault path must equal the row binding');
      }
    }
    for (const other of this.rows) {
      if (other.credential_ref !== row.credential_ref) continue;
      if (other.tenant_id !== row.tenant_id) throw new Error('guard: chain bound to another tenant');
      if (row.tenant_id !== '') {
        if (other.connector_id !== row.connector_id) throw new Error('guard: ref shared across connectors');
        if (this.kindOf(other.credential_source) === 'legacy-db' || kind === 'legacy-db') {
          throw new Error('guard: bound chains must not use legacy-db credentials');
        }
        if (other.account_id !== row.account_id) throw new Error('guard: account binding changed');
      }
    }
    if (row.state === 'ACTIVE') {
      const clash = this.rows.some((other) => other.connector_id === row.connector_id
        && other.credential_ref === row.credential_ref && other.state === 'ACTIVE');
      if (clash) throw new Error('guard: chain already has an ACTIVE row');
    }
  }
  async query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    const n = normalize(sql);
    this.calls.push(n);
    const p = params as (string | number | null)[];
    if (n.startsWith('SELECT revision FROM connector_revisions')) {
      const hit = this.rows
        .filter((r) => r.connector_id === p[0] && r.tenant_id === String(p[1]))
        .sort((a, b) => b.revision - a.revision)[0];
      const out = hit ? [{ revision: hit.revision }] : [];
      return { rows: out, rowCount: out.length };
    }
    if (n.includes('state = ' + Q + 'ACTIVE' + Q + ' ORDER BY revision DESC LIMIT 1 FOR UPDATE')) {
      const hit = this.rows
        .filter((r) => r.connector_id === p[0] && r.tenant_id === String(p[1]) && r.state === 'ACTIVE')
        .sort((a, b) => b.revision - a.revision)[0];
      const out = hit ? [this.shape(hit)] : [];
      return { rows: out, rowCount: out.length };
    }
    if (n.includes('tenant_id = ' + Q + Q + ' ORDER BY revision DESC LIMIT 1 FOR UPDATE')) {
      const hit = this.rows
        .filter((r) => r.connector_id === p[0] && r.tenant_id === '')
        .sort((a, b) => b.revision - a.revision)[0];
      const out = hit ? [this.shape(hit)] : [];
      return { rows: out, rowCount: out.length };
    }
    if (n.includes('FROM connector_revisions') && n.includes('ORDER BY revision DESC LIMIT 1') && !n.includes('FOR UPDATE')) {
      const hit = this.rows
        .filter((r) => r.connector_id === p[0] && r.tenant_id === String(p[1]))
        .sort((a, b) => b.revision - a.revision)[0];
      const out = hit ? [this.shape(hit)] : [];
      return { rows: out, rowCount: out.length };
    }
    if (n.startsWith('INSERT INTO connector_revisions')) {
      const row: FakeRow = {
        connector_id: String(p[0]),
        revision: Number(p[1]),
        adapter: String(p[2]),
        config: JSON.parse(String(p[3])),
        credential_ref: String(p[4]),
        state: String(p[5]),
        credential_source: JSON.parse(String(p[6])),
        tenant_id: String(p[7]),
        account_id: p[8] === null || p[8] === undefined ? null : String(p[8]),
      };
      this.enforce(row);
      this.rows.push(row);
      this.inserts += 1;
      return { rows: [this.shape(row)], rowCount: 1 };
    }
    throw new Error('FakePg: unsupported SQL shape: ' + n.slice(0, 160));
  }
  async transaction<T>(callback: (client: unknown) => Promise<T>): Promise<T> {
    return callback(this);
  }
}

const Q = String.fromCharCode(39);

function legacySeed(ref = 'cred-shared'): FakeRow {
  return {
    connector_id: 'openai',
    revision: 1,
    adapter: 'json-http',
    config: baseConfig,
    credential_ref: ref,
    state: 'ACTIVE',
    // toRevision enforces source.credentialRef === row.credential_ref; a
    // seed that disagrees is itself a corrupt row (proved by this suite).
    credential_source: { kind: 'legacy-db', credentialRef: ref },
    tenant_id: '',
    account_id: null,
  };
}

const registry = { get: (name: string): unknown => ({ id: name }) } as unknown as AdapterRegistry;

function repo(db: FakePg): PostgresConnectorConfigRepository {
  return new PostgresConnectorConfigRepository(db as never);
}

const BOOT_INPUT = {
  connectorId: 'openai',
  adapter: 'json-http',
  config: baseConfig,
  credentialRef: 'cred-openai-acct-main',
  credentialSource: VAULT_SOURCE,
  tenantId: 'tenant-a',
  accountId: 'acct-main',
};

describe('W-VAULT-LEGACY-TRANSITION-1 repository.bootstrapVaultRevision', () => {
  it('opens the bound chain as ACTIVE rev1 with a fresh ref, leaving the legacy row untouched', async () => {
    const db = new FakePg();
    db.seed(legacySeed());
    const out = await repo(db).bootstrapVaultRevision(BOOT_INPUT);
    expect(out.replayed).toBe(false);
    expect(out.revision.revision).toBe(1);
    expect(out.revision.state).toBe('ACTIVE');
    expect(out.revision.tenantId).toBe('tenant-a');
    expect(out.revision.accountId).toBe('acct-main');
    expect(out.revision.credentialRef).toBe('cred-openai-acct-main');
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0]?.state).toBe('ACTIVE');
    expect(db.rows[0]?.tenant_id).toBe('');
  });

  it('replayed bootstrap with the SAME pin answers the existing row (no second chain entry)', async () => {
    const db = new FakePg();
    db.seed(legacySeed());
    const r = repo(db);
    const first = await r.bootstrapVaultRevision(BOOT_INPUT);
    const second = await r.bootstrapVaultRevision(BOOT_INPUT);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(second.revision.revision).toBe(first.revision.revision);
    expect(db.inserts).toBe(1);
  });

  it('replayed bootstrap with a DIFFERENT pin is refused (chain already open elsewhere)', async () => {
    const db = new FakePg();
    db.seed(legacySeed());
    const r = repo(db);
    await r.bootstrapVaultRevision(BOOT_INPUT);
    await expect(r.bootstrapVaultRevision({ ...BOOT_INPUT, credentialSource: { ...VAULT_SOURCE, version: 9 } }))
      .rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(db.inserts).toBe(1);
  });

  it('no legacy chain to transition from: INVALID_INPUT, zero inserts', async () => {
    const db = new FakePg();
    await expect(repo(db).bootstrapVaultRevision({ ...BOOT_INPUT, connectorId: 'ghost', credentialRef: 'cred-ghost-acct-main',
      credentialSource: { ...VAULT_SOURCE, path: 'du/tenants/tenant-a/connectors/ghost/accounts/acct-main' } }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(db.inserts).toBe(0);
  });

  it('foreign vault path vs claimed binding is refused BEFORE any SQL (zero statements)', async () => {
    const db = new FakePg();
    db.seed(legacySeed());
    await expect(repo(db).bootstrapVaultRevision({ ...BOOT_INPUT,
      credentialSource: { ...VAULT_SOURCE, path: 'du/tenants/tenant-BX/connectors/openai/accounts/acct-main' } }))
      .rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(db.calls).toHaveLength(0);
    expect(db.inserts).toBe(0);
  });
});

describe('W-VAULT-LEGACY-TRANSITION-1 management.bootstrapRevision', () => {
  function mgmt(db: FakePg): DurableConnectorManagement {
    return new DurableConnectorManagement(repo(db), new AesCredentialCipher(randomBytes(32)), registry);
  }
  it('derives the fresh chain key and clones adapter/config off the legacy row', async () => {
    const db = new FakePg();
    db.seed(legacySeed());
    const out = await mgmt(db).bootstrapRevision('openai', VAULT_SOURCE, {
      tenantId: 'tenant-a', connectorId: 'openai', accountId: 'acct-main',
    });
    expect(out.replayed).toBe(false);
    expect(out.revision.credentialRef).toBe('cred-openai-acct-main');
    expect(out.revision.adapter).toBe('json-http');
    expect(out.revision.state).toBe('ACTIVE');
    expect(db.rows[1]?.tenant_id).toBe('tenant-a');
    expect(db.rows[1]?.account_id).toBe('acct-main');
  });

  it('derived key colliding with the shared legacy ref is refused before any write', async () => {
    const db = new FakePg();
    db.seed(legacySeed('cred-openai-acct-main'));
    await expect(mgmt(db).bootstrapRevision('openai', VAULT_SOURCE, {
      tenantId: 'tenant-a', connectorId: 'openai', accountId: 'acct-main',
    })).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(db.inserts).toBe(0);
  });

  it('corrupt persisted legacy row (legacy-db source carrying an account column) fails closed at read', async () => {
    const db = new FakePg();
    db.seed({ ...legacySeed('cred-openai-acct-main'), account_id: 'acct-main' });
    await expect(mgmt(db).bootstrapRevision('openai', VAULT_SOURCE, {
      tenantId: 'tenant-a', connectorId: 'openai', accountId: 'acct-main',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    expect(db.inserts).toBe(0);
  });

  it('foreign vault path is refused before even reading storage (zero statements)', async () => {
    const db = new FakePg();
    db.seed(legacySeed());
    await expect(mgmt(db).bootstrapRevision('openai',
      { ...VAULT_SOURCE, path: 'du/tenants/tenant-BX/connectors/openai/accounts/acct-main' },
      { tenantId: 'tenant-a', connectorId: 'openai', accountId: 'acct-main' }))
      .rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(db.calls).toHaveLength(0);
  });

  it('unbound chain already migrated to vault kind is NOT transitionable (fail closed)', async () => {
    const db = new FakePg();
    db.seed({
      connector_id: 'openai',
      revision: 1,
      adapter: 'json-http',
      config: baseConfig,
      credential_ref: 'cred-x',
      state: 'ACTIVE',
      credential_source: VAULT_SOURCE,
      tenant_id: '',
      account_id: 'acct-main',
    });
    await expect(mgmt(db).bootstrapRevision('openai', VAULT_SOURCE, {
      tenantId: 'tenant-a', connectorId: 'openai', accountId: 'acct-main',
    })).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    expect(db.inserts).toBe(0);
  });

  it('second bootstrap of the same connector converges: replayed, one chain entry, legacy row intact', async () => {
    const db = new FakePg();
    db.seed(legacySeed());
    const m = mgmt(db);
    const coords = { tenantId: 'tenant-a', connectorId: 'openai', accountId: 'acct-main' };
    const first = await m.bootstrapRevision('openai', VAULT_SOURCE, coords);
    const second = await m.bootstrapRevision('openai', VAULT_SOURCE, coords);
    expect(first.replayed).toBe(false);
    expect(second.replayed).toBe(true);
    expect(db.inserts).toBe(1);
    expect(db.rows).toHaveLength(2);
    expect(db.rows[0]?.tenant_id).toBe('');
  });
});
