import { randomUUID } from 'node:crypto';
import {
  createCredentialWorkflow,
  type ConnectorRevisionStore,
  type CredentialAuditSink,
  type IdempotencyPort,
  type PinnedSource,
  type CredentialWorkflowResult,
  type RevisionRow,
  type VaultCredentialWriter,
} from '../src/modules/connector-credentials/workflow';
import { HttpError } from '../src/http/errors';
import { createVaultDevFixture, VaultError, type VaultDevFixture } from '../../../packages/contracts/tests/stubs/vault-dev-fixture';

/**
 * VAULT-03 offline workflow tests (Qwen-2, cycle 97) — zero DB/Redis.
 * The Vault side is the VAULT-02 fixture (orchestrator-writer identity, so
 * CAS + policy are REAL enforcement, not stubs); the revision side is an
 * in-memory store with the same CAS-activation semantics the connector API
 * adapter will implement. Provider keys never leave the write-only channel:
 * every failure message, audit detail and GET body is sentinel-scanned.
 */

const VALUE = 'sk-live-Vault03Sentinel-' + randomUUID();
const REASON = { mount: 'secret', path: 'du/tenants/tenant-a/connectors/openai/accounts/du-conn-openai-main', key: 'api-key', account: 'du-conn-openai-main' };
const TEST_SCOPES = [{ mount: 'secret', pathPrefix: 'du/tenants/tenant-a/connectors/openai/accounts' }];

function createScopedVaultFixture(): VaultDevFixture {
  return createVaultDevFixture({ scopes: TEST_SCOPES });
}

function fixtureWriter(fx: VaultDevFixture, writes: number[] = []) {
  const token = fx.login('orchestrator-writer');
  const readerToken = () => fx.login('orchestrator-writer');
  void readerToken;
  const writer: VaultCredentialWriter = {
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
  return writer;
}

class MemoryRevisionStore implements ConnectorRevisionStore {
  readonly rows: RevisionRow[] = [];
  createPendingThrows = false;
  activateThrows = false;
  constructor(_connectorId: string, base: Omit<RevisionRow, 'revision'>) {
    void _connectorId;
    this.rows.push({ ...base, revision: 1 });
  }
  private byRevision(revision: number): RevisionRow {
    const row = this.rows.find((r) => r.revision === revision);
    if (!row) throw new Error('unknown revision ' + revision);
    return row;
  }
  async get(connectorId: string): Promise<RevisionRow | undefined> {
    void connectorId;
    return [...this.rows].reverse().find((r) => r.state === 'ACTIVE');
  }
  async createPending(connectorId: string, source: PinnedSource): Promise<RevisionRow> {
    void connectorId;
    if (this.createPendingThrows) {
      this.createPendingThrows = false;
      throw new Error('simulated crash: connector revision API unreachable');
    }
    const base = this.rows[this.rows.length - 1]!;
    const row: RevisionRow = {
      revision: base.revision + 1,
      adapter: base.adapter,
      state: 'PENDING',
      credentialSource: source,
      tenantId: base.tenantId,
      accountId: base.accountId,
    };
    this.rows.push(row);
    return row;
  }
  async activate(connectorId: string, revision: number, expectedCurrentRevision: number): Promise<boolean> {
    void connectorId;
    if (this.activateThrows) {
      this.activateThrows = false;
      throw new Error('simulated crash after PENDING: activation call lost');
    }
    // Real-time head, NOT this.get(): get() is a test seam for the caller's
    // base read only; activation must compare against the true chain.
    const current = [...this.rows].reverse().find((r) => r.state === 'ACTIVE');
    if (!current || current.revision !== expectedCurrentRevision) return false;
    const target = this.byRevision(revision);
    if (target.state !== 'PENDING') return false;
    current.state = 'RETIRED';
    target.state = 'ACTIVE';
    return true;
  }
  async retire(connectorId: string, revision: number): Promise<void> {
    void connectorId;
    const row = this.byRevision(revision);
    if (row.state === 'PENDING') row.state = 'RETIRED';
  }
  activeCount(): number {
    return this.rows.filter((r) => r.state === 'ACTIVE').length;
  }
}

function memoryIdempotency(): IdempotencyPort & { hits: number } {
  const map = new Map<string, { payloadHash: string; result: CredentialWorkflowResult }>();
  let hits = 0;
  return {
    get hits() {
      return hits;
    },
    async lookup(key) {
      hits += 1;
      return map.get(key);
    },
    async store(key, payloadHash, result) {
      map.set(key, { payloadHash, result });
    },
  };
}

function memoryAudit(): CredentialAuditSink & { events: { action: string; resource: string; detail: Record<string, unknown> }[] } {
  const events: { action: string; resource: string; detail: Record<string, unknown> }[] = [];
  return {
    events,
    async record(event) {
      events.push(event);
    },
  };
}

function make() {
  const fx = createScopedVaultFixture();
  const writes: number[] = [];
  const store = new MemoryRevisionStore('openai', {
    adapter: 'openai-http',
    state: 'ACTIVE',
    credentialSource: { kind: 'legacy-db', credentialRef: 'legacy-openai' },
    tenantId: 'tenant-a',
    accountId: 'du-conn-openai-main',
  });
  const audit = memoryAudit();
  const idem = memoryIdempotency();
  const wf = createCredentialWorkflow({ vault: fixtureWriter(fx, writes), revisions: store, audit, idempotency: idem });
  return { fx, writes, store, audit, idem, wf };
}

describe('VAULT-03 happy path + masking', () => {
  it('rotate writes CAS-versioned secret, creates PENDING, ACTIVATES once', async () => {
    const { wf, store, audit, fx } = make();
    const r = await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE });
    expect(r).toMatchObject({ revision: 2, version: 1, state: 'ACTIVE' });
    expect(store.activeCount()).toBe(1);
    const readBack = await fx.read({ token: fx.login('connector-reader'), ...REASON, key: 'api-key' });
    expect((readBack as { value: unknown }).value).toBe(VALUE);
    // audit detail is masked metadata ONLY
    expect(audit.events).toHaveLength(1);
    expect(JSON.stringify(audit.events[0])).not.toContain(VALUE);
    expect(audit.events[0]!.detail).toMatchObject({ mount: 'secret', path: REASON.path, key: 'api-key', vaultVersion: 1, hasValue: true });
  });

  it('describe() returns masked metadata and never a value', async () => {
    const { wf } = make();
    await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE });
    const md = await wf.describe('openai');
    expect(md.source).toMatchObject({ kind: 'vault-kv2', mount: 'secret', path: REASON.path, key: 'api-key', pinnedVersion: 1, hasValue: true });
    expect(md.state).toBe('ACTIVE');
    expect(md.vaultVersions).toEqual([1]);
    expect(JSON.stringify(md)).not.toContain(VALUE);
  });

  it('traversal ref is rejected BEFORE the vault is touched', async () => {
    const { wf, writes } = make();
    await expect(
      wf.rotate({ connectorId: 'openai', ref: { ...REASON, path: 'du/../../etc' }, value: VALUE }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(writes).toHaveLength(0);
  });

  it.each([
    ['foreign connector segment', 'du/tenants/tenant-a/connectors/anthropic/accounts/du-conn-openai-main'],
    ['foreign account segment', 'du/tenants/tenant-a/connectors/openai/accounts/acct-other'],
    ['sibling account prefix', 'du/tenants/tenant-a/connectors/openai/accounts/du-conn-openai-main-foreign'],
    ['nested path below account', `${REASON.path}/nested`],
  ])('%s is rejected before the Vault writer is called', async (_label, path) => {
    const { wf, writes, store } = make();
    await expect(
      wf.rotate({ connectorId: 'openai', ref: { ...REASON, path }, value: VALUE }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(writes).toHaveLength(0);
    expect(store.rows).toHaveLength(1);
  });

  it('empty value is rejected write-side', async () => {
    const { wf } = make();
    await expect(wf.rotate({ connectorId: 'openai', ref: REASON, value: '' })).rejects.toMatchObject({
      status: 422,
    });
  });
});

describe('VAULT-03 duplicate / CAS / concurrent', () => {
  it('idempotent replay: one revision, one vault write, replayed=true', async () => {
    const { wf, store, writes } = make();
    const a = await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE, idempotencyKey: 'k1', payloadHash: 'h1' });
    const b = await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE, idempotencyKey: 'k1', payloadHash: 'h1' });
    expect(b.replayed).toBe(true);
    expect(b).toMatchObject({ revision: a.revision, version: a.version });
    expect(store.rows).toHaveLength(2);
    expect(writes).toHaveLength(1);
  });

  it('reusing the key with a different payload → IDEMPOTENCY_CONFLICT', async () => {
    const { wf } = make();
    await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE, idempotencyKey: 'k1', payloadHash: 'h1' });
    await expect(
      wf.rotate({ connectorId: 'openai', ref: REASON, value: 'sk-other', idempotencyKey: 'k1', payloadHash: 'h2' }),
    ).rejects.toMatchObject({ status: 409, code: 'IDEMPOTENCY_CONFLICT' });
  });

  it('idempotency key without a store fails CLOSED', async () => {
    const fx = createScopedVaultFixture();
    const wf = createCredentialWorkflow({
      vault: fixtureWriter(fx),
      revisions: new MemoryRevisionStore('openai', {
        adapter: 'openai-http',
        state: 'ACTIVE',
        credentialSource: { kind: 'legacy-db', credentialRef: 'legacy-openai' },
        tenantId: 'tenant-a',
        accountId: 'du-conn-openai-main',
      }),
    });
    await expect(wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE, idempotencyKey: 'k1' })).rejects.toMatchObject({
      status: 503,
      code: 'IDEMPOTENCY_UNAVAILABLE',
    });
  });

  it('CAS conflict surfaces as 409 and creates NO revision', async () => {
    const { wf, store } = make();
    await expect(wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE, cas: 42 })).rejects.toMatchObject({
      status: 409,
      code: 'VAULT_CAS_CONFLICT',
    });
    expect(store.rows).toHaveLength(1); // only the seed row
  });

  it('interleaved rotations off one stale base: never two ACTIVE; loser stays PENDING until reconcile', async () => {
    const { wf, store } = make();
    // Deterministic model of the dangerous interleaving: BOTH workflows read
    // the same chain head (rev 1) before either activates — exactly what two
    // concurrent admin requests / replicas would observe.
    const staleHead = store.rows[0]!;
    store.get = async () => staleHead; // BOTH workflows observe head = rev 1

    const first = await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE });
    const second = await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE + '-2' });

    expect(first.state).toBe('ACTIVE'); // winner activated rev 2
    expect(second.state).toBe('PENDING'); // its expectedCurrent 1 no longer head
    expect(second.reconcileRequired).toBe(true);
    expect(store.activeCount()).toBe(1); // THE invariant: never 2 ACTIVE

    // Reconcile against the NEW current (2): the loser legitimately promotes.
    const final = await wf.reconcile('openai', second.revision, first.revision);
    expect(final).toBe('ACTIVE');
    expect(store.activeCount()).toBe(1);
    expect(store.rows.find((r) => r.revision === first.revision)!.state).toBe('RETIRED');
  });

  it('sequential rotations chain legitimately: each ACTIVE replaces the previous, count stays 1', async () => {
    const { wf, store } = make();
    const a = await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE });
    const b = await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE + '-2' });
    expect(a.state).toBe('ACTIVE');
    expect(b.state).toBe('ACTIVE'); // fresh base read → clean promotion
    expect(store.activeCount()).toBe(1);
    expect(store.rows.find((r) => r.revision === a.revision)!.state).toBe('RETIRED');
  });
});

describe('VAULT-03 crash windows (SEC-04 reconcile)', () => {
  it('crash AFTER vault write, BEFORE createPending: orphan version, zero revision churn, nothing routable', async () => {
    const { wf, store, fx } = make();
    store.createPendingThrows = true;
    await expect(wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE })).rejects.toThrow(
      /simulated crash/,
    );
    expect(store.rows).toHaveLength(1);
    expect(store.activeCount()).toBe(1);
    const row = store.rows[0]!;
    expect(row.state).toBe('ACTIVE');
    expect(row.credentialSource).toEqual({ kind: 'legacy-db', credentialRef: 'legacy-openai' }); // ACTIVE still points at the OLD credential
    // the vault holds the orphan version — but NOTHING references it
    const md = await fx.readMetadata({ token: fx.login('orchestrator-writer'), ...REASON });
    expect(md.current_version).toBe(1);
  });

  it('crash AFTER createPending, BEFORE activate: row stays PENDING; reconcile activates it', async () => {
    const { wf, store } = make();
    store.activateThrows = true;
    await expect(wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE })).rejects.toThrow(/simulated crash/);
    const stranded = store.rows[1]!;
    expect(stranded.state).toBe('PENDING'); // NOT routable — connector refuses state !== ACTIVE
    const outcome = await wf.reconcile('openai', stranded.revision, 1);
    expect(outcome).toBe('ACTIVE');
    expect(store.activeCount()).toBe(1);
    expect(store.rows.find((r) => r.revision === 1)!.state).toBe('RETIRED');
  });

  it('reconcile against a moved-on chain RETIREs the stranded PENDING instead of double-ACTIVE', async () => {
    const { wf, store } = make();
    await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE }); // rev2 ACTIVE
    store.createPendingThrows = false;
    const stranded = await store.createPending('openai', { kind: 'vault-kv2', ...REASON, version: 99 });
    const outcome = await wf.reconcile('openai', stranded.revision, 1); // expectedCurrent stale
    expect(outcome).toBe('RETIRED');
    expect(stranded.state).toBe('RETIRED');
    expect(store.activeCount()).toBe(1);
  });
});

describe('VAULT-03 hygiene + route pins', () => {
  it('no error path leaks the plaintext sentinel', async () => {
    const { wf, audit } = make();
    const errs: unknown[] = [];
    await wf.rotate({ connectorId: 'openai', ref: { ...REASON, path: 'other/x' }, value: VALUE }).catch((e: unknown) => errs.push(e));
    await wf.rotate({ connectorId: 'openai', ref: REASON, value: VALUE, cas: 7 }).catch((e: unknown) => errs.push(e));
    const dump = JSON.stringify(errs.map((e) => (e instanceof HttpError ? e.toProblem() : String(e)))) + JSON.stringify(audit.events);
    expect(dump).not.toContain(VALUE);
  });

  it('structural: server.ts wires the routes fail-closed behind admin auth', async () => {
    const { readFileSync } = await import('node:fs');
    const src = readFileSync(require.resolve('../src/server.ts'), 'utf8');
    const block = src.slice(
      src.indexOf('VAULT-03 provider-key credentials'),
      src.indexOf('sweep-deadlines  (P2-06'),
    );
    expect(block).toContain('assertAdminAuth(ctx)');
    expect(block).toContain('credential workflow not configured');
    expect(block.indexOf('assertAdminAuth'))
      .toBeLessThan(block.indexOf('ctx.credentialWorkflow'));
    // responses carry only the workflow result — the write-only value is input-side
    expect(block).toContain("value: typeof body.value === 'string' ? body.value : ''");
    expect(block).not.toMatch(/body:\s*\{[^}]*\bvalue\b[^}]*\}/);
  });
});
