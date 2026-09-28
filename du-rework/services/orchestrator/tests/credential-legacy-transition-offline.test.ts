import { randomUUID } from 'node:crypto';
import {
  createCredentialWorkflow,
  type ConnectorRevisionStore,
  type CredentialAuditSink,
  type PinnedSource,
  type RevisionRow,
  type VaultCredentialWriter,
} from '../src/modules/connector-credentials/workflow';
import { createConnectorRevisionHttpAdapter } from '../src/modules/connector-credentials/connector-http-store';
import { createVaultDevFixture, VaultError, type VaultDevFixture } from '../../../packages/contracts/tests/stubs/vault-dev-fixture';

/**
 * W-VAULT-LEGACY-TRANSITION-1 offline suite (Reviewer T170-V1, HIGH).
 *
 * The transition pinned here: a connector whose stored revision is the
 * legacy UNBOUND row (empty tenant, legacy-db source) can be rotated into
 * a tenant-bound Vault chain ONLY when the platform itself declares that
 * connector's first binding (initialBindings = compose-side trusted
 * config, validated at construction). With no declaration, the historical
 * fail-closed 403 BINDING_DENIED stands unchanged (the cycle-8 f3
 * fixture behavior is a regression guard, not an accident). Vault writes
 * run through the REAL VAULT-02 dev fixture: CAS + path scope are
 * enforced there, not stubbed.
 */

const VALUE = 'sk-legacy-transition-' + randomUUID();
const CONNECTOR = 'openai';
const ACCOUNT = 'du-conn-openai-main';
const DECLARED = { tenantId: 'tenant-a', accountId: ACCOUNT };
const REASON = {
  mount: 'secret',
  path: 'du/tenants/tenant-a/connectors/openai/accounts/' + ACCOUNT,
  key: 'api-key',
  account: ACCOUNT,
};
const TEST_SCOPES = [{ mount: 'secret', pathPrefix: 'du/tenants/tenant-a/connectors/openai/accounts' }];

function fixtureWriter(fx: VaultDevFixture, writes: number[]): VaultCredentialWriter {
  const token = fx.login('orchestrator-writer');
  return {
    async writeCas(ref, value, cas) {
      try {
        const r = await fx.write({
          token,
          mount: ref.mount,
          path: ref.path,
          key: ref.key,
          value,
          ...(cas === undefined ? {} : { cas }),
        });
        writes.push(r.version);
        return r.version;
      } catch (err) {
        if (err instanceof VaultError) throw { code: err.code, retryable: err.retryable };
        throw err;
      }
    },
    async readVersions(ref) {
      const md = await fx.readMetadata({ token, mount: ref.mount, path: ref.path });
      return { current_version: md.current_version, versions: Object.keys(md.versions).map(Number) };
    },
  };
}

function legacyBase(): RevisionRow {
  return {
    revision: 1,
    adapter: 'json-http',
    state: 'ACTIVE',
    credentialSource: { kind: 'legacy-db', credentialRef: 'cred-shared' },
    tenantId: '',
  };
}

function boundBase(revision: number, version: number, accountId: string = ACCOUNT): RevisionRow {
  return {
    revision,
    adapter: 'json-http',
    state: 'ACTIVE',
    credentialSource: { kind: 'vault-kv2', ...REASON, version },
    tenantId: 'tenant-a',
    accountId,
  };
}

class ChainStore implements ConnectorRevisionStore {
  readonly calls: string[] = [];
  bootstrapCalls = 0;
  private readonly chains: Record<string, RevisionRow[]>;
  constructor(chains: Record<string, RevisionRow[]>) {
    this.chains = chains;
  }
  rowsFor(tenantId: string): RevisionRow[] {
    return this.chains[tenantId] ?? [];
  }
  async get(connectorId: string, scope?: { tenantId?: string }): Promise<RevisionRow | undefined> {
    void connectorId;
    const tenantId = scope?.tenantId ?? '';
    this.calls.push('get:' + tenantId);
    const rows = this.chains[tenantId] ?? [];
    return [...rows].reverse().find((row) => row.state === 'ACTIVE');
  }
  async createPending(connectorId: string, source: PinnedSource): Promise<RevisionRow> {
    void connectorId;
    this.calls.push('createPending');
    const rows = (this.chains['tenant-a'] ??= []);
    const row: RevisionRow = {
      revision: (rows[rows.length - 1]?.revision ?? 0) + 1,
      adapter: 'json-http',
      state: 'PENDING',
      credentialSource: source,
      tenantId: 'tenant-a',
      accountId: ACCOUNT,
    };
    rows.push(row);
    return row;
  }
  async activate(connectorId: string, revision: number, expectedCurrent: number): Promise<boolean> {
    void connectorId;
    this.calls.push('activate');
    const rows = this.chains['tenant-a'] ?? [];
    const current = [...rows].reverse().find((row) => row.state === 'ACTIVE');
    if (!current || current.revision !== expectedCurrent) return false;
    const target = rows.find((row) => row.revision === revision);
    if (!target || target.state !== 'PENDING') return false;
    current.state = 'RETIRED';
    target.state = 'ACTIVE';
    return true;
  }
  async retire(): Promise<void> {
    void 0;
  }
  async bootstrap(connectorId: string, source: PinnedSource): Promise<RevisionRow> {
    void connectorId;
    this.calls.push('bootstrap');
    this.bootstrapCalls += 1;
    const rows = (this.chains['tenant-a'] ??= []);
    const row: RevisionRow = {
      revision: (rows[rows.length - 1]?.revision ?? 0) + 1,
      adapter: 'json-http',
      state: 'ACTIVE',
      credentialSource: source,
      tenantId: 'tenant-a',
      accountId: ACCOUNT,
    };
    rows.push(row);
    return row;
  }
}

function recordingAudit(): { sink: CredentialAuditSink; events: Array<Record<string, unknown>> } {
  const events: Array<Record<string, unknown>> = [];
  return {
    events,
    sink: {
      async record(event) {
        events.push({ action: event.action, resource: event.resource, detail: event.detail });
      },
    },
  };
}

describe('W-VAULT-LEGACY-TRANSITION-1 workflow (orchestrator side, offline)', () => {
  it('transition happy path: legacy base + declared binding -> vault write -> bootstrap ACTIVE chain, no createPending/activate', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const writes: number[] = [];
    const store = new ChainStore({ '': [legacyBase()], 'tenant-a': [] });
    const audit = recordingAudit();
    const workflow = createCredentialWorkflow({
      vault: fixtureWriter(fx, writes),
      revisions: store,
      audit: audit.sink,
      initialBindings: { [CONNECTOR]: DECLARED },
    });
    const result = await workflow.rotate({ connectorId: CONNECTOR, ref: REASON, value: VALUE });
    expect(result.state).toBe('ACTIVE');
    expect(result.revision).toBe(1);
    expect(result.reconcileRequired).toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(store.bootstrapCalls).toBe(1);
    expect(store.calls).toEqual(['get:tenant-a', 'get:', 'bootstrap']);
    const bound = store.rowsFor('tenant-a')[0];
    if (!bound || bound.credentialSource.kind !== 'vault-kv2') throw new Error('bootstrap row missing');
    expect(bound.state).toBe('ACTIVE');
    expect(bound.credentialSource.path).toBe(REASON.path);
    expect(bound.credentialSource.version).toBe(writes[0]);
    expect(store.rowsFor('')[0]?.state).toBe('ACTIVE');
    expect(audit.events).toHaveLength(1);
    const detail = (audit.events[0] as { detail: Record<string, unknown> }).detail;
    expect(detail.transition).toBe(true);
    expect(JSON.stringify(audit.events)).not.toContain(VALUE);
  });

  it('no declared binding: the historical 403 BINDING_DENIED stands with zero vault writes', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const writes: number[] = [];
    const store = new ChainStore({ '': [legacyBase()] });
    const workflow = createCredentialWorkflow({ vault: fixtureWriter(fx, writes), revisions: store });
    await expect(workflow.rotate({ connectorId: CONNECTOR, ref: REASON, value: VALUE }))
      .rejects.toMatchObject({ status: 403, code: 'BINDING_DENIED' });
    expect(writes).toHaveLength(0);
    expect(store.bootstrapCalls).toBe(0);
    expect(store.calls).toEqual(['get:']);
  });

  it('declared + already-bound chain: normal rotate path, bootstrap never called', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const writes: number[] = [];
    const store = new ChainStore({ '': [legacyBase()], 'tenant-a': [boundBase(1, 1)] });
    const workflow = createCredentialWorkflow({
      vault: fixtureWriter(fx, writes),
      revisions: store,
      initialBindings: { [CONNECTOR]: DECLARED },
    });
    const result = await workflow.rotate({ connectorId: CONNECTOR, ref: REASON, value: VALUE });
    expect(result.state).toBe('ACTIVE');
    expect(result.revision).toBe(2);
    expect(store.bootstrapCalls).toBe(0);
    expect(store.calls).toEqual(['get:tenant-a', 'createPending', 'activate']);
    expect(store.rowsFor('')[0]?.state).toBe('ACTIVE');
  });

  it('declared binding that DISAGREES with the stored row is refused before any vault write', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const writes: number[] = [];
    // A VALID-SHAPE but different account: both guards could parse this, so
    // the only thing that can stop the write is the explicit disagreement
    // check - the fixture must not fail a schema regex by accident.
    const store = new ChainStore({ '': [legacyBase()], 'tenant-a': [boundBase(1, 1, 'acct-second')] });
    const workflow = createCredentialWorkflow({
      vault: fixtureWriter(fx, writes),
      revisions: store,
      initialBindings: { [CONNECTOR]: DECLARED },
    });
    await expect(workflow.rotate({ connectorId: CONNECTOR, ref: REASON, value: VALUE }))
      .rejects.toMatchObject({ status: 403, code: 'BINDING_DENIED', message: 'stored connector binding disagrees with the platform binding' });
    expect(writes).toHaveLength(0);
    expect(store.bootstrapCalls).toBe(0);
    expect(store.calls).toEqual(['get:tenant-a']);
  });

  it('unbound chain whose current is NOT legacy-db is not transitionable (403, zero writes)', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const writes: number[] = [];
    const weirdUnbound: RevisionRow = {
      revision: 1,
      adapter: 'json-http',
      state: 'ACTIVE',
      credentialSource: { kind: 'vault-kv2', ...REASON, version: 4 },
      tenantId: '',
      accountId: ACCOUNT,
    };
    const store = new ChainStore({ '': [weirdUnbound] });
    const workflow = createCredentialWorkflow({
      vault: fixtureWriter(fx, writes),
      revisions: store,
      initialBindings: { [CONNECTOR]: DECLARED },
    });
    await expect(workflow.rotate({ connectorId: CONNECTOR, ref: REASON, value: VALUE }))
      .rejects.toMatchObject({ status: 403, code: 'BINDING_DENIED' });
    expect(writes).toHaveLength(0);
  });

  it('no revisions at all: 404 before any vault write, in either mode', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const writes: number[] = [];
    const store = new ChainStore({});
    const workflow = createCredentialWorkflow({
      vault: fixtureWriter(fx, writes),
      revisions: store,
      initialBindings: { [CONNECTOR]: DECLARED },
    });
    await expect(workflow.rotate({ connectorId: CONNECTOR, ref: REASON, value: VALUE }))
      .rejects.toMatchObject({ status: 404 });
    expect(writes).toHaveLength(0);
  });

  it('store without bootstrap capability: 501 after the vault write, chain untouched (orphan-only, fail-closed)', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const writes: number[] = [];
    const full = new ChainStore({ '': [legacyBase()] });
    const store: ConnectorRevisionStore = {
      get: (id, scope) => full.get(id, scope),
      createPending: (id, s) => full.createPending(id, s),
      activate: (id, r, e) => full.activate(id, r, e),
      retire: () => full.retire(),
    };
    const workflow = createCredentialWorkflow({
      vault: fixtureWriter(fx, writes),
      revisions: store,
      initialBindings: { [CONNECTOR]: DECLARED },
    });
    await expect(workflow.rotate({ connectorId: CONNECTOR, ref: REASON, value: VALUE }))
      .rejects.toMatchObject({ status: 501, code: 'BOOTSTRAP_UNSUPPORTED' });
    expect(writes).toHaveLength(1);
    expect(full.bootstrapCalls).toBe(0);
    expect(full.rowsFor('tenant-a')).toHaveLength(0);
    expect(full.rowsFor('')[0]?.state).toBe('ACTIVE');
  });

  it('candidate ref pointing at a FOREIGN tenant path is refused pre-write even when declared', async () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    const writes: number[] = [];
    const store = new ChainStore({ '': [legacyBase()] });
    const workflow = createCredentialWorkflow({
      vault: fixtureWriter(fx, writes),
      revisions: store,
      initialBindings: { [CONNECTOR]: DECLARED },
    });
    const foreign = {
      ...REASON,
      path: 'du/tenants/tenant-BX/connectors/openai/accounts/' + ACCOUNT,
    };
    await expect(workflow.rotate({ connectorId: CONNECTOR, ref: foreign, value: VALUE }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(writes).toHaveLength(0);
  });

  it('malformed platform binding is refused at construction, never at first rotate', () => {
    const fx = createVaultDevFixture({ scopes: TEST_SCOPES });
    expect(() => createCredentialWorkflow({
      vault: fixtureWriter(fx, []),
      revisions: new ChainStore({}),
      initialBindings: { [CONNECTOR]: { tenantId: 'BAD TENANT!', accountId: ACCOUNT } },
    })).toThrow(/initial binding/);
  });
});

describe('W-VAULT-LEGACY-TRANSITION-1 http adapter (URL/body shape, offline)', () => {
  interface Sent { url: string; method: string; body: Record<string, unknown> | undefined }
  function capturingFetch(reply: { status: number; json: unknown }): { fetchImpl: typeof fetch; sent: Sent[] } {
    const sent: Sent[] = [];
    const fetchImpl = (async (input: unknown, init?: unknown) => {
      const i = (init ?? {}) as { method?: string; body?: string };
      sent.push({
        url: String(input),
        method: i.method ?? 'GET',
        body: i.body === undefined ? undefined : (JSON.parse(i.body) as Record<string, unknown>),
      });
      return {
        status: reply.status,
        json: async () => reply.json,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return { fetchImpl, sent };
  }
  const wireRow = {
    connectorId: CONNECTOR,
    revision: 1,
    adapter: 'json-http',
    state: 'ACTIVE',
    credentialSource: { kind: 'vault-kv2', ...REASON, version: 1 },
    tenantId: 'tenant-a',
    accountId: ACCOUNT,
  };

  it('get() without scope keeps the historical unbound URL byte-identical', async () => {
    const { fetchImpl, sent } = capturingFetch({ status: 200, json: wireRow });
    const store = createConnectorRevisionHttpAdapter({ baseUrl: 'http://connector.invalid', fetchImpl });
    await store.get(CONNECTOR);
    expect(sent[0]?.url).toBe('http://connector.invalid/connectors/openai/revisions/current');
  });

  it('get(scope.tenantId) selects the bound chain via the tenant query', async () => {
    const { fetchImpl, sent } = capturingFetch({ status: 200, json: wireRow });
    const store = createConnectorRevisionHttpAdapter({ baseUrl: 'http://connector.invalid', fetchImpl });
    await store.get(CONNECTOR, { tenantId: 'tenant-a' });
    expect(sent[0]?.url).toBe('http://connector.invalid/connectors/openai/revisions/current?tenant=tenant-a');
  });

  it('bootstrap POSTs the dedicated route with independent coordinates', async () => {
    const { fetchImpl, sent } = capturingFetch({ status: 201, json: wireRow });
    const store = createConnectorRevisionHttpAdapter({ baseUrl: 'http://connector.invalid', fetchImpl });
    const source = { kind: 'vault-kv2', ...REASON, version: 1 } as const;
    const row = await store.bootstrap!(CONNECTOR, source);
    expect(sent[0]?.method).toBe('POST');
    expect(sent[0]?.url).toBe('http://connector.invalid/connectors/openai/revisions/bootstrap');
    expect(sent[0]?.body).toEqual({ credentialSource: source, tenantId: 'tenant-a', accountId: ACCOUNT });
    expect(row.state).toBe('ACTIVE');
  });

  it('bootstrap refuses a legacy-db source before any call', async () => {
    const { fetchImpl, sent } = capturingFetch({ status: 201, json: wireRow });
    const store = createConnectorRevisionHttpAdapter({ baseUrl: 'http://connector.invalid', fetchImpl });
    await expect(store.bootstrap!(CONNECTOR, { kind: 'legacy-db', credentialRef: 'cred-shared' } as never))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(sent).toHaveLength(0);
  });
});
