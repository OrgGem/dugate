import {
  DurableConnectorRuntime,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  PostgresConnectorConfigRepository,
  deriveRevisionBinding,
  hashInvocationInput,
  jsonHttpAdapter,
  LEGACY_UNBOUND_TENANT_ID,
  redactConnectorRevision,
  isBoundRevisionTenant,
} from '../src';
import type { ConnectorConfigRepository, ConnectorRevision, NewConnectorRevision, SqlResult } from '../src';
import type { SqlClient } from '../src/db/sql';
import type { AdapterRegistry } from '../src/adapters/registry';
import type { ProviderTransport } from '../src/invoke';
import { SecretResolver } from '../src/vault/resolver';
import type { CredentialSource } from '../src/vault/resolver';
import type { GrantClaims, LocalInvocationRequest } from '../src';

/**
 * W-VAULT01-BIND-1R — offline (fake-DB) evidence that the (tenant_id,
 * connector_id, account_id) revision binding is enforced at the STORAGE
 * layer, not only in service logic.
 *
 * FakePgRevisions deliberately mirrors migration
 * 008_connector_revision_binding.sql: it fails the same statement with a
 * 23514-class violation for the same rule set (tenant shape, vault path ==
 * binding, bound-source-must-be-vault, one tenant/connector/account per bound
 * credential_ref, at most one ACTIVE per connector chain, no legacy rows in
 * bound chains). Unknown SQL shapes
 * THROW — so if the repository ever drops a tenant predicate from a
 * statement, these tests break instead of silently passing.
 *
 * Postgres itself enforcing the same SQL is the separate live-PG gate
 * (Tester-owned DU_LIVE_INFRA window); this suite does not claim that.
 */

interface FakeRow {
  connector_id: string;
  revision: number;
  adapter: string;
  config: Record<string, unknown>;
  credential_ref: string;
  state: string;
  credential_source: Record<string, unknown> | null;
  tenant_id: string;
  account_id: string | null;
}

const TENANT_SHAPE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

class CheckViolation extends Error {
  public constructor(message: string) {
    super('SQLSTATE 23514: ' + message);
  }
}

class FakePgRevisions implements SqlClient {
  public readonly rows: FakeRow[] = [];
  public readonly calls: Array<{ sql: string, params: readonly unknown[] }> = [];

  public async query<Row extends object = Record<string, unknown>>(
    text: string,
    parameters: readonly unknown[] = [],
  ): Promise<SqlResult<Row>> {
    const sql = text.replace(/\s+/g, ' ').trim();
    this.calls.push({ sql, params: parameters });
    const p = parameters as unknown[];
    const result = (rows: unknown[]): SqlResult<Row> => ({ rows: rows as Row[], rowCount: rows.length });
    const proj = (r: FakeRow): Record<string, unknown> => ({
      connector_id: r.connector_id,
      revision: r.revision,
      adapter: r.adapter,
      config: r.config,
      credential_ref: r.credential_ref,
      state: r.state,
      credential_source: r.credential_source,
      tenant_id: r.tenant_id,
      account_id: r.account_id,
    });

    if (/^INSERT INTO connector_revisions /i.test(sql)) {
      if (!/^INSERT INTO connector_revisions \(connector_id, revision, adapter, config, credential_ref, state, credential_source, tenant_id, account_id\) VALUES \(\$1, \$2, \$3, \$4::jsonb, \$5, \$6, \$7::jsonb, \$8, \$9\) RETURNING \*$/i.test(sql)) {
        throw new Error('FakePg: unsupported INSERT connector_revisions shape: ' + sql);
      }
      const row: FakeRow = {
        connector_id: String(p[0]),
        revision: Number(p[1]),
        adapter: String(p[2]),
        config: JSON.parse(String(p[3])) as Record<string, unknown>,
        credential_ref: String(p[4]),
        state: String(p[5]),
        credential_source: p[6] === null ? null : JSON.parse(String(p[6])) as Record<string, unknown>,
        tenant_id: String(p[7]),
        account_id: p[8] === null || p[8] === undefined ? null : String(p[8]),
      };
      if (this.rows.some((existing) => existing.connector_id === row.connector_id
        && existing.tenant_id === row.tenant_id && existing.revision === row.revision)) {
        throw new CheckViolation('connector revision primary key (connector_id, tenant_id, revision)');
      }
      this.enforceInsert(row);
      this.rows.push(row);
      return result([proj(row)]);
    }
    if (/^UPDATE secret_versions s SET revoked_at = now\(\) WHERE s\.credential_ref = \$1 AND s\.revoked_at IS NULL AND EXISTS \(SELECT 1 FROM connector_revisions r WHERE r\.credential_ref = s\.credential_ref AND \(r\.tenant_id = \$2 OR r\.tenant_id = ''\)\)$/i.test(sql)) {
      return result([]);
    }
    if (/^SELECT connector_id, revision, adapter, config, credential_ref, state, credential_source, tenant_id, account_id FROM connector_revisions ORDER BY connector_id, revision$/i.test(sql)) {
      const sorted = [...this.rows].sort((a, b) => a.connector_id === b.connector_id ? a.revision - b.revision : (a.connector_id < b.connector_id ? -1 : 1));
      return result(sorted.map(proj));
    }
    if (/^SELECT .* FROM connector_revisions WHERE connector_id = \$1 AND tenant_id = \$2 ORDER BY revision DESC LIMIT 1$/i.test(sql)) {
      const hits = this.rows.filter((r) => r.connector_id === String(p[0]) && r.tenant_id === String(p[1]));
      hits.sort((a, b) => b.revision - a.revision);
      return result(hits.slice(0, 1).map(proj));
    }
    if (/^SELECT .* FROM connector_revisions WHERE connector_id = \$1 AND revision = \$2 AND \(tenant_id = \$3 OR tenant_id = ''\) ORDER BY CASE WHEN tenant_id = \$3 THEN 0 ELSE 1 END LIMIT 1$/i.test(sql)) {
      const hits = this.rows.filter((r) => r.connector_id === String(p[0]) && r.revision === Number(p[1])
        && (r.tenant_id === String(p[2]) || r.tenant_id === ''));
      hits.sort((a, b) => (a.tenant_id === String(p[2]) ? 0 : 1) - (b.tenant_id === String(p[2]) ? 0 : 1));
      return result(hits.slice(0, 1).map(proj));
    }
    if (/^SELECT .* FROM connector_revisions WHERE connector_id = \$1 AND tenant_id = \$2 AND state = 'ACTIVE' ORDER BY revision DESC LIMIT 1$/i.test(sql)) {
      const hits = this.rows.filter((r) => r.connector_id === String(p[0]) && r.tenant_id === String(p[1]) && r.state === 'ACTIVE');
      hits.sort((a, b) => b.revision - a.revision);
      return result(hits.slice(0, 1).map(proj));
    }
    if (/^SELECT revision FROM connector_revisions WHERE connector_id = \$1 AND tenant_id = \$2 ORDER BY revision DESC LIMIT 1 FOR UPDATE$/i.test(sql)) {
      const hits = this.rows.filter((r) => r.connector_id === String(p[0]) && r.tenant_id === String(p[1]));
      hits.sort((a, b) => b.revision - a.revision);
      return result(hits.slice(0, 1).map((r) => ({ revision: r.revision })));
    }
    if (/^SELECT revision FROM connector_revisions WHERE connector_id = \$1 AND tenant_id = \$2 AND state = 'ACTIVE' FOR UPDATE$/i.test(sql)) {
      const hits = this.rows.filter((r) => r.connector_id === String(p[0]) && r.tenant_id === String(p[1]) && r.state === 'ACTIVE');
      return result(hits.map((r) => ({ revision: r.revision })));
    }
    if (/^SELECT state FROM connector_revisions WHERE connector_id = \$1 AND revision = \$2 AND tenant_id = \$3 FOR UPDATE$/i.test(sql)) {
      const hits = this.rows.filter((r) => r.connector_id === String(p[0]) && r.revision === Number(p[1]) && r.tenant_id === String(p[2]));
      return result(hits.map((r) => ({ state: r.state })));
    }
    if (/^UPDATE connector_revisions SET state = \$4 WHERE connector_id = \$1 AND revision = \$2 AND tenant_id = \$3 AND state = 'PENDING'$/i.test(sql)) {
      const row = this.rows.find((r) => r.connector_id === String(p[0]) && r.revision === Number(p[1]) && r.tenant_id === String(p[2]) && r.state === 'PENDING');
      if (!row) return result([]);
      const next = String(p[3]);
      if (next === 'ACTIVE') {
        const clash = this.rows.some((o) => o !== row && o.connector_id === row.connector_id && o.credential_ref === row.credential_ref && o.state === 'ACTIVE'
          && !(o.tenant_id === row.tenant_id && o.revision === row.revision));
        if (clash) throw new CheckViolation('connector revision chain already has an ACTIVE row');
      }
      row.state = next;
      return result([{ state: next }]);
    }
    if (/^UPDATE connector_revisions SET state = \$3 WHERE connector_id = \$1 AND revision = \$2 AND tenant_id = \$4 AND state = 'PENDING'$/i.test(sql)) {
      const hits = this.rows.filter((r) => r.connector_id === String(p[0]) && r.revision === Number(p[1]) && r.tenant_id === String(p[3]) && r.state === 'PENDING');
      hits.forEach((r) => { r.state = String(p[2]); });
      return result(hits.map((r) => ({ state: r.state })));
    }
    if (/^UPDATE connector_revisions SET state = \$3 WHERE connector_id = \$1 AND revision = \$2 AND tenant_id = \$4$/i.test(sql)) {
      const hits = this.rows.filter((r) => r.connector_id === String(p[0]) && r.revision === Number(p[1]) && r.tenant_id === String(p[3]));
      hits.forEach((r) => { r.state = String(p[2]); });
      return result(hits.map((r) => ({ state: r.state })));
    }
    if (/^UPDATE connector_revisions SET state = \$2 WHERE connector_id = \$1 AND tenant_id = \$3$/i.test(sql)) {
      const hits = this.rows.filter((r) => r.connector_id === String(p[0]) && r.tenant_id === String(p[2]));
      hits.forEach((r) => { r.state = String(p[1]); });
      return result(hits.map((r) => ({ state: r.state })));
    }
    throw new Error('FakePg: unsupported SQL shape: ' + sql);
  }

  public async transaction<T>(callback: (client: SqlClient) => Promise<T>): Promise<T> {
    return callback(this);
  }

  /** Mirrors 008's CHECKs + connector_revisions_chain_guard trigger. */
  public enforceInsert(row: FakeRow): void {
    if (!(row.tenant_id === '' || TENANT_SHAPE.test(row.tenant_id))) {
      throw new CheckViolation('tenant_id shape');
    }
    const kind = row.credential_source === null ? 'legacy-db' : String(row.credential_source.kind ?? 'legacy-db');
    if (row.tenant_id !== '' && kind !== 'vault-kv2') {
      throw new CheckViolation('bound_source_is_vault');
    }
    if (kind === 'vault-kv2' && row.credential_source !== null) {
      const seg = String(row.credential_source.path ?? '').split('/');
      const refAccount = String(row.credential_source.account ?? '');
      if (
        seg.length !== 7
        || seg[0] !== 'du' || seg[1] !== 'tenants' || seg[2] !== row.tenant_id
        || seg[3] !== 'connectors' || seg[4] !== row.connector_id
        || seg[5] !== 'accounts' || seg[6] !== String(row.account_id)
        || row.account_id === null || refAccount !== row.account_id
      ) {
        throw new CheckViolation('vault_path_matches_binding');
      }
    }
    const credentialRefs = this.rows.filter((o) => o.credential_ref === row.credential_ref
      && !(o.connector_id === row.connector_id && o.tenant_id === row.tenant_id && o.revision === row.revision));
    const chain = credentialRefs.filter((o) => o.connector_id === row.connector_id);
    for (const other of credentialRefs) {
      if (other.tenant_id !== row.tenant_id) {
        throw new CheckViolation('connector revision chain is already bound to another tenant');
      }
      if (row.tenant_id !== '' && other.connector_id !== row.connector_id) {
        throw new CheckViolation('credential_ref cannot be shared between tenant-bound connectors');
      }
      const otherKind = other.credential_source === null ? 'legacy-db' : String(other.credential_source.kind ?? 'legacy-db');
      if (row.tenant_id !== '' && (otherKind === 'legacy-db' || kind === 'legacy-db')) {
        throw new CheckViolation('tenant-bound connector revision chains must not use legacy-db credentials');
      }
      if (row.tenant_id !== '' && other.account_id !== row.account_id) {
        throw new CheckViolation('connector revision chain account binding cannot change');
      }
    }
    if (row.state === 'ACTIVE' && chain.some((o) => o.state === 'ACTIVE')) {
      throw new CheckViolation('connector revision chain already has an ACTIVE row');
    }
  }
}

const baseConfig = { baseUrl: 'https://provider.example', path: '/v1/infer', timeoutMs: 1_000 };
type VaultSource = Extract<CredentialSource, { kind: 'vault-kv2' }>;

function vaultSource(overrides: Partial<VaultSource> = {}): VaultSource {
  return {
    kind: 'vault-kv2',
    account: 'acct-main',
    mount: 'secret',
    path: 'du/tenants/tenant-a/connectors/openai/accounts/acct-main',
    key: 'api-key',
    version: 3,
    ...overrides,
  };
}

function legacyInput(overrides: Partial<NewConnectorRevision> = {}): NewConnectorRevision {
  return {
    connectorId: 'openai',
    adapter: 'json-http',
    config: baseConfig,
    credentialRef: 'cred-shared',
    state: 'ACTIVE',
    ...overrides,
  };
}

function vaultInput(overrides: Partial<NewConnectorRevision> = {}): NewConnectorRevision {
  return legacyInput({
    tenantId: 'tenant-a',
    accountId: 'acct-main',
    credentialSource: vaultSource(),
    ...overrides,
  });
}

describe('W-VAULT01-BIND-1R — binding derivation (server-side, fail closed)', () => {
  it('legacy source without a claim derives the unbound binding', () => {
    expect(deriveRevisionBinding(legacyInput())).toEqual({ tenantId: LEGACY_UNBOUND_TENANT_ID });
  });

  it('legacy source + claimed tenant is rejected before any SQL', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await expect(repo.createRevision(legacyInput({ tenantId: 'tenant-a' })))
      .rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(db.calls).toHaveLength(0);
  });

  it('vault row requires an explicit tenant binding', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await expect(repo.createRevision(vaultInput({ tenantId: undefined })))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(db.calls).toHaveLength(0);
  });

  it('claimed tenant disagreeing with the vault path is rejected before any SQL', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await expect(repo.createRevision(vaultInput({ tenantId: 'tenant-z' })))
      .rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(db.calls).toHaveLength(0);
  });

  it('independent tenant/account claims must match the vault source', () => {
    expect(deriveRevisionBinding(vaultInput({ tenantId: 'tenant-a' })))
      .toEqual({ tenantId: 'tenant-a', accountId: 'acct-main' });
    expect(() => deriveRevisionBinding(vaultInput({ accountId: 'acct-other' })))
      .toThrow(/trusted revision binding/);
    expect(() => deriveRevisionBinding(vaultInput({ accountId: undefined })))
      .toThrow(/explicit tenantId and accountId/);
  });

  it('malformed tenant claim is INVALID_INPUT', () => {
    expect(() => deriveRevisionBinding(legacyInput({ tenantId: 'Bad Tenant' })))
      .toThrow(/valid tenant id/);
  });
});

describe('W-VAULT01-BIND-1R — storage layer blocks spoofed/foreign bindings', () => {
  it('vault revision persists independent tenant_id + account_id columns', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    const created = await repo.createRevision(vaultInput({ tenantId: 'tenant-a' }));
    expect(created.tenantId).toBe('tenant-a');
    expect(created.accountId).toBe('acct-main');
    expect(db.rows).toHaveLength(1);
    expect(db.rows[0].tenant_id).toBe('tenant-a');
    expect(db.rows[0].account_id).toBe('acct-main');
  });

  it('allows the same connector revision number in separate trusted tenant chains', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    const tenantA = await repo.createRevision(vaultInput({ tenantId: 'tenant-a', credentialRef: 'cred-a' }));
    const tenantB = await repo.createRevision(vaultInput({
      tenantId: 'tenant-b',
      credentialRef: 'cred-b',
      credentialSource: vaultSource({ path: 'du/tenants/tenant-b/connectors/openai/accounts/acct-main' }),
    }));
    expect(tenantA.revision).toBe(1);
    expect(tenantB.revision).toBe(1);
    expect(db.rows.map((row) => [row.tenant_id, row.revision])).toEqual([
      ['tenant-a', 1],
      ['tenant-b', 1],
    ]);
  });

  it('rejects plaintext credential headers before issuing any SQL', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await expect(repo.createRevision(legacyInput({
      config: { ...baseConfig, headers: { authorization: 'Bearer sk-secret-sentinel' } },
    }))).rejects.toMatchObject({ code: 'INVALID_INPUT' });
    expect(db.calls).toHaveLength(0);
  });

  it('legacy revision persists the unbound empty binding', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    const created = await repo.createRevision(legacyInput());
    expect(created.tenantId).toBe('');
    expect(db.rows[0].tenant_id).toBe('');
    expect(db.rows[0].account_id).toBeNull();
  });

  it('CHECK analogue: a rogue row whose path contradicts its binding is refused', () => {
    const db = new FakePgRevisions();
    const rogue: FakeRow = {
      connector_id: 'openai',
      revision: 99,
      adapter: 'json-http',
      config: baseConfig,
      credential_ref: 'cred-other',
      state: 'ACTIVE',
      credential_source: { kind: 'vault-kv2', account: 'acct-main', mount: 'secret', path: 'du/tenants/tenant-z/connectors/openai/accounts/acct-main', key: 'api-key', version: 1 },
      tenant_id: 'tenant-a',
      account_id: 'acct-main',
    };
    expect(() => db.enforceInsert(rogue)).toThrow(/vault_path_matches_binding/);
  });

  it('CHECK analogue: a bound row with legacy-db credentials is refused', () => {
    const db = new FakePgRevisions();
    const rogue: FakeRow = {
      connector_id: 'openai',
      revision: 99,
      adapter: 'json-http',
      config: baseConfig,
      credential_ref: 'cred-other',
      state: 'ACTIVE',
      credential_source: { kind: 'legacy-db', credentialRef: 'cred-other' },
      tenant_id: 'tenant-a',
      account_id: null,
    };
    expect(() => db.enforceInsert(rogue)).toThrow(/bound_source_is_vault/);
  });

  it('chain guard: one chain cannot be bound by two tenants', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await repo.createRevision(vaultInput({ tenantId: 'tenant-a', credentialRef: 'cred-acct-x' }));
    await expect(repo.createRevision(vaultInput({
      tenantId: 'tenant-b',
      credentialRef: 'cred-acct-x',
      credentialSource: vaultSource({ path: 'du/tenants/tenant-b/connectors/openai/accounts/acct-main' }),
    }))).rejects.toThrow(/already bound to another tenant/);
  });

  it('chain guard: a trusted credential ref cannot change its account or connector binding', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await repo.createRevision(vaultInput({ tenantId: 'tenant-a', credentialRef: 'cred-chain' }));
    await expect(repo.createRevision(vaultInput({
      tenantId: 'tenant-a',
      accountId: 'acct-other',
      credentialRef: 'cred-chain',
      credentialSource: vaultSource({ account: 'acct-other', path: 'du/tenants/tenant-a/connectors/openai/accounts/acct-other' }),
      state: 'PENDING',
    }))).rejects.toThrow(/account binding cannot change/);
    await expect(repo.createRevision(vaultInput({
      tenantId: 'tenant-a',
      connectorId: 'anthropic',
      credentialRef: 'cred-chain',
      credentialSource: vaultSource({ path: 'du/tenants/tenant-a/connectors/anthropic/accounts/acct-main' }),
    }))).rejects.toThrow(/cannot be shared between tenant-bound connectors/);
  });

  it('chain guard: an unbound legacy chain cannot be joined by a bound row', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await repo.createRevision(legacyInput({ credentialRef: 'cred-mix' }));
    await expect(repo.createRevision(vaultInput({
      tenantId: 'tenant-a',
      credentialRef: 'cred-mix',
    }))).rejects.toThrow(/already bound to another tenant/);
  });

  it('chain guard: at most one ACTIVE revision per chain', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await repo.createRevision(vaultInput({ tenantId: 'tenant-a', credentialRef: 'cred-one-active' }));
    await expect(repo.createRevision(vaultInput({
      tenantId: 'tenant-a',
      credentialRef: 'cred-one-active',
    }))).rejects.toThrow(/already has an ACTIVE row/);
  });
});

describe('W-VAULT01-BIND-1R — reads and mutations are tenant-predicated in SQL', () => {
  async function seeded(): Promise<{ db: FakePgRevisions, repo: PostgresConnectorConfigRepository }> {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    // Same connector, same revision NUMBER, two different bindings — exactly
    // the collision the review said was unrepresentable before 008.
    await repo.createRevision(legacyInput({ credentialRef: 'cred-legacy' }));
    await repo.createRevision(vaultInput({ tenantId: 'tenant-a', credentialRef: 'cred-a' }));
    return { db, repo };
  }

  it('revision-number collision routes by binding; bound row never leaks to a foreign tenant', async () => {
    const { repo } = await seeded();
    const asOwner = await repo.getRevision('openai', 1, { tenantId: 'tenant-a' });
    expect(asOwner?.credentialRef).toBe('cred-a');
    expect(asOwner?.tenantId).toBe('tenant-a');
    const asForeign = await repo.getRevision('openai', 1, { tenantId: 'tenant-b' });
    expect(asForeign?.tenantId).toBe('');
    expect(asForeign?.credentialRef).toBe('cred-legacy');
    const asUnbound = await repo.getRevision('openai', 1);
    expect(asUnbound?.credentialRef).toBe('cred-legacy');
  });

  it('getRevision returns undefined when no row matches selector OR unbound', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await repo.createRevision(vaultInput({ tenantId: 'tenant-a' }));
    expect(await repo.getRevision('openai', 1, { tenantId: 'tenant-b' })).toBeUndefined();
    expect(await repo.getRevision('openai', 1)).toBeUndefined();
  });

  it('every scoped revision statement carries a tenant_id predicate', async () => {
    const { db, repo } = await seeded();
    db.calls.length = 0;
    await repo.get('openai', { tenantId: 'tenant-a' });
    await repo.getRevision('openai', 1, { tenantId: 'tenant-a' });
    await repo.getActiveRevision('openai', { tenantId: 'tenant-a' });
    await repo.retireRevision('openai', 1, { tenantId: 'tenant-a' });
    await repo.disable('openai', { tenantId: 'tenant-a' });
    expect(db.calls).toHaveLength(5);
    for (const call of db.calls) {
      expect(call.sql).toMatch(/tenant_id = \$/);
    }
  });

  it('scoped legacy revoke qualifies the target row alias in its EXISTS predicate', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await repo.revoke('cred-a', { tenantId: 'tenant-a' });
    expect(db.calls).toHaveLength(1);
    expect(db.calls[0].sql).toContain('UPDATE secret_versions s SET revoked_at = now()');
    expect(db.calls[0].sql).toContain('r.credential_ref = s.credential_ref');
    expect(db.calls[0].params).toEqual(['cred-a', 'tenant-a']);
  });

  it('activate CAS with a foreign selector cannot flip anything', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await repo.createRevision(vaultInput({ tenantId: 'tenant-a', credentialRef: 'cred-a' }));
    await repo.createRevision(vaultInput({ tenantId: 'tenant-a', credentialRef: 'cred-a2', state: 'PENDING' }));
    expect(await repo.activateRevision('openai', 2, 1, { tenantId: 'tenant-b' })).toBe(false);
    const pending = db.rows.find((r) => r.revision === 2 && r.tenant_id === 'tenant-a');
    expect(pending?.state).toBe('PENDING');
    expect(db.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(1);
  });

  it('disable touches only the selector chain', async () => {
    const { repo } = await seeded();
    await repo.disable('openai', { tenantId: 'tenant-a' });
    const bound = await repo.getRevision('openai', 1, { tenantId: 'tenant-a' });
    const legacy = await repo.getRevision('openai', 1);
    expect(bound?.state).toBe('RETIRED');
    expect(legacy?.state).toBe('ACTIVE');
  });
});

describe('W-VAULT01-BIND-1R — projections', () => {
  it('redactConnectorRevision keeps binding as metadata and drops secrets', () => {
    const revision: ConnectorRevision = {
      connectorId: 'openai',
      revision: 1,
      adapter: 'json-http',
      config: { ...baseConfig, headers: { authorization: 'Bearer secret-sentinel' } },
      credentialRef: 'cred-a',
      state: 'ACTIVE',
      credentialSource: vaultSource(),
      tenantId: 'tenant-a',
      accountId: 'acct-main',
    };
    const redacted = redactConnectorRevision(revision);
    expect(redacted.tenantId).toBe('tenant-a');
    expect(redacted.accountId).toBe('acct-main');
    expect(JSON.stringify(redacted)).not.toContain('secret-sentinel');
  });

  it('isBoundRevisionTenant only accepts non-empty bindings', () => {
    expect(isBoundRevisionTenant('')).toBe(false);
    expect(isBoundRevisionTenant(undefined)).toBe(false);
    expect(isBoundRevisionTenant('tenant-a')).toBe(true);
  });
});

// ---- invocation boundary over the SAME fake-DB repository ----

const TENANT_A = 'tenant-a';
const CONNECTOR_ID = 'openai';
const INVOCATION_BODY = {
  contractVersion: '1',
  operationId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  stepKey: 'extract',
  bindingSlot: 'reasoning',
  input: { prompt: 'binding test' },
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

function buildRuntime(
  repository: ConnectorConfigRepository,
  grantTenantId: string,
  reads: unknown[],
): { runtime: DurableConnectorRuntime, providerCalls: () => number, invocationId: string } {
  const invocationId = 'bind-' + grantTenantId + '-' + String(Math.random().toString(36).slice(2));
  const local: LocalInvocationRequest = {
    ...INVOCATION_BODY,
    invocationId,
    tenantId: grantTenantId,
  } as LocalInvocationRequest;
  const grant: GrantClaims = {
    audience: 'connector',
    tenantId: grantTenantId,
    operationId: local.operationId,
    taskId: local.taskId,
    stepKey: local.stepKey,
    invocationId: local.invocationId,
    inputHash: hashInvocationInput(local),
    connectorRevision: CONNECTOR_ID + ':1',
    expiresAt: '2099-01-01T00:00:00.000Z',
  };
  let provider = 0;
  const transport: ProviderTransport = {
    send: async () => {
      provider += 1;
      return { status: 200, body: { content: 'ok' } };
    },
  };
  const resolver = new SecretResolver({
    kv2: { readSecret: async (input) => { reads.push(input); return 'unit-secret'; } },
  });
  const runtime = new DurableConnectorRuntime(
    new InMemoryInvocationLedger() as never,
    repository,
    new InMemoryQuotaStore(),
    { append: async () => undefined } as never,
    { get: () => jsonHttpAdapter } as unknown as AdapterRegistry,
    transport,
    { encrypt: () => new Uint8Array(), decrypt: () => 'unit-secret' } as never,
    { verify: async () => grant },
    resolver,
  );
  return {
    runtime,
    providerCalls: () => provider,
    invocationId,
  };
}

function invokeWith(fixture: { runtime: DurableConnectorRuntime, invocationId: string }): Promise<unknown> {
  return fixture.runtime.invoke({ ...INVOCATION_BODY, invocationId: fixture.invocationId, grant: 'signed-unit-grant' });
}

describe('W-VAULT01-BIND-1R — invocation boundary blocks foreign tenants at the DB predicate', () => {
  it('tenant-b grant cannot load tenant-a revision: zero vault reads, zero provider calls', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await repo.createRevision(vaultInput({ tenantId: TENANT_A, credentialRef: 'cred-a' }));
    const reads: unknown[] = [];
    const fixture = buildRuntime(repo, 'tenant-b', reads);
    await expect(invokeWith(fixture)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    expect(reads).toHaveLength(0);
    expect(fixture.providerCalls()).toBe(0);
  });

  it('tenant-a grant resolves through the bound row and dispatches once (happy anchor)', async () => {
    const db = new FakePgRevisions();
    const repo = new PostgresConnectorConfigRepository(db);
    await repo.createRevision(vaultInput({ tenantId: TENANT_A, credentialRef: 'cred-a' }));
    const reads: unknown[] = [];
    const fixture = buildRuntime(repo, TENANT_A, reads);
    await expect(invokeWith(fixture)).resolves.toMatchObject({ state: 'completed' });
    expect(reads).toHaveLength(1);
    expect(fixture.providerCalls()).toBe(1);
  });

  it('a bound revision cannot resolve through the legacy-db branch', async () => {
    const repository = {
      getRevision: async () => ({
        connectorId: CONNECTOR_ID,
        revision: 1,
        adapter: 'json-http',
        config: baseConfig,
        credentialRef: 'cred-x',
        state: 'ACTIVE' as const,
        credentialSource: { kind: 'legacy-db', credentialRef: 'cred-x' },
        tenantId: TENANT_A,
      }),
      getActiveCredential: async () => new Uint8Array([1]),
    } as unknown as ConnectorConfigRepository;
    const fixture = buildRuntime(repository, TENANT_A, []);
    await expect(invokeWith(fixture)).rejects.toMatchObject({ code: 'CREDENTIAL_INVALID' });
    expect(fixture.providerCalls()).toBe(0);
  });

  it('unbound legacy revision stays invokable via the shared selector (compat pin)', async () => {
    const repository = {
      getRevision: async () => ({
        connectorId: CONNECTOR_ID,
        revision: 1,
        adapter: 'json-http',
        config: baseConfig,
        credentialRef: 'cred-x',
        state: 'ACTIVE' as const,
        credentialSource: { kind: 'legacy-db', credentialRef: 'cred-x' },
        tenantId: '',
      }),
      getActiveCredential: async () => new Uint8Array([1]),
    } as unknown as ConnectorConfigRepository;
    const fixture = buildRuntime(repository, 'any-tenant', []);
    await expect(invokeWith(fixture)).resolves.toMatchObject({ state: 'completed' });
    expect(fixture.providerCalls()).toBe(1);
  });
});
