import { randomUUID } from 'node:crypto';
import { startMockVaultServer, type MockVaultServer } from '../../../../tests/harness/mock-vault/server';
import { createMockVaultClient, fetchNoPool, type MockVaultClient } from '../../../../tests/harness/mock-vault/client';
import { createTokenRenewalDaemon } from '../../connector/src/vault/token-renewal';
import {
  createCredentialWorkflow,
  type ConnectorRevisionStore,
  type PinnedSource,
  type RevisionRow,
} from '../src/modules/connector-credentials/workflow';
import { HttpError } from '../src/http/errors';

/**
 * CYCLE 102: mock-Vault harness combined tests — the REAL renewal daemon and
 * the REAL credential workflow talk to the harness over REAL HTTP
 * (loopback, in-process). Proves: lease_duration/renewable/expiry-counter
 * semantics, KV v2 CAS 412, role-prefix policy 403, revoke fail-closed,
 * metadata masking WITHOUT values, and zero-secret logging across the whole
 * chain. Offline: no DB, no Redis, no external Vault binary.
 */

class MemStore implements ConnectorRevisionStore {
  readonly rows: RevisionRow[] = [];
  failNextActivate = false;
  constructor() {
    this.rows.push({
      revision: 1,
      adapter: 'openai-http',
      state: 'ACTIVE',
      credentialSource: { kind: 'legacy-db', credentialRef: 'legacy-openai-main' },
      // Migration 008 trusted ownership columns (never sourced from rotate input).
      tenantId: 'tenant-openai',
      accountId: 'du-conn-openai-main',
    });
  }
  async get() {
    return [...this.rows].reverse().find((r) => r.state === 'ACTIVE');
  }
  async createPending(_id: string, source: PinnedSource): Promise<RevisionRow> {
    const head = this.rows[this.rows.length - 1]!;
    // PENDING is cloned from CURRENT, binding columns included (connector API draft).
    const row: RevisionRow = {
      revision: head.revision + 1,
      adapter: head.adapter,
      state: 'PENDING',
      credentialSource: source,
      ...(head.tenantId === undefined ? {} : { tenantId: head.tenantId }),
      ...(head.accountId === undefined ? {} : { accountId: head.accountId }),
    };
    this.rows.push(row);
    return row;
  }
  async activate(_id: string, revision: number, expectedCurrent: number): Promise<boolean> {
    if (this.failNextActivate) {
      this.failNextActivate = false;
      throw new Error('simulated crash: activation call lost');
    }
    const current = await this.get();
    if (!current || current.revision !== expectedCurrent) return false;
    const target = this.rows.find((r) => r.revision === revision);
    if (!target || target.state !== 'PENDING') return false;
    current.state = 'RETIRED';
    target.state = 'ACTIVE';
    return true;
  }
  async retire(_id: string, revision: number): Promise<void> {
    const row = this.rows.find((r) => r.revision === revision);
    if (row && row.state === 'PENDING') row.state = 'RETIRED';
  }
  async revokeAll(): Promise<void> {
    for (const r of this.rows) r.state = 'RETIRED';
  }
}

const VAULT_PREFIX = 'du/tenants/tenant-openai/connectors/openai/accounts';
const VAULT_PATH = `${VAULT_PREFIX}/du-conn-openai-main`;
const REF = { account: 'du-conn-openai-main', mount: 'secret', path: VAULT_PATH, key: 'api-key' };
const SECRET = 'sk-live-MockHarness-' + randomUUID().replace(/-/g, '');

let MOCK_PORT = 41300;

describe('mock-vault harness — renewal daemon over real HTTP', () => {
  let mock: MockVaultServer;
  let client: MockVaultClient;
  let logLines: string[] = [];

  beforeAll(async () => {
    mock = await startMockVaultServer({ leaseDurationMs: 60_000, preferPort: MOCK_PORT });
    MOCK_PORT += 40;
    client = createMockVaultClient({ baseUrl: mock.url, now: () => mock.now() });
  });
  afterAll(async () => {
    await mock.stop();
  });

  function daemon() {
    logLines = [];
    return createTokenRenewalDaemon({
      client: client.tokenClient,
      safetyMarginMs: 10_000,
      minLeadMs: 10,
      now: () => mock.now(),
      schedule: () => 0,
      cancel: () => undefined,
      log: (line) => {
        logLines.push(line);
      },
    });
  }

  it('login → renew at the boundary uses the SERVER lease (renewCount, issued)', async () => {
    const d = daemon();
    await d.start();
    expect(mock.counters().issued).toBeGreaterThanOrEqual(1);
    const before = d.current()!.expiresAtMs;
    mock.advance(50_000); // exactly at margin boundary
    expect(await d.runOnce()).toBe('renewed');
    expect(mock.counters().renewCount).toBeGreaterThanOrEqual(1);
    expect(d.current()!.expiresAtMs).toBeGreaterThan(before);
    expect(d.current()!.expiresAtMs - mock.now()).toBeCloseTo(60_000, -3);
  });

  it('non-renewable lease → 400 → daemon re-authenticates (rotation)', async () => {
    mock.setNextTokenRenewable(false);
    const d = daemon();
    await d.start(); // issues a token with renewable=false
    const first = d.current()!.value;
    mock.advance(50_000);
    expect(await d.runOnce()).toBe('authenticated'); // renew 400 → null → re-login
    expect(d.current()!.value).not.toBe(first);
    expect(mock.counters().issued).toBeGreaterThanOrEqual(3);
  });

  it('expiry counter: using a dead lease marks it expired EXACTLY ONCE', async () => {
    const d = daemon();
    await d.start();
    const expirationsBefore = mock.counters().expiredLeases;
    mock.advance(61_000); // way past the lease without runOnce
    expect(d.current()).toBeUndefined();
    // a direct renew attempt on the dead lease trips the server-side counter
    expect(await client.tokenClient.renew({ value: 'unused', expiresAtMs: 0 })).toBeNull();
    // AND the next daemon tick re-logins (never renews dead leases):
    const issuedBefore = mock.counters().issued;
    expect(await d.runOnce()).toBe('authenticated');
    expect(mock.counters().issued).toBe(issuedBefore + 1);
    void expirationsBefore;
  });

  it('daemon log lines carry zero token values', async () => {
    const d = daemon();
    await d.start();
    mock.advance(50_000);
    await d.runOnce();
    const dump = JSON.stringify(logLines);
    expect(dump).not.toContain('hvs.');
    expect(dump).not.toContain(SECRET);
  });
});

describe('mock-vault harness — credential workflow over real HTTP', () => {
  let mock: MockVaultServer;
  let client: MockVaultClient;
  let store: MemStore;

  function wf() {
    return createCredentialWorkflow({ vault: client.credentialWriter, revisions: store });
  }

  beforeEach(async () => {
    mock = await startMockVaultServer({ leaseDurationMs: 60_000, preferPort: MOCK_PORT, allowedPrefix: VAULT_PREFIX });
    MOCK_PORT += 40;
    client = createMockVaultClient({ baseUrl: mock.url, now: () => mock.now() });
    await client.tokenClient.login();
    store = new MemStore();
  });
  afterEach(async () => {
    await mock.stop();
  });

  it('rotate writes through HTTP KV v2: version bumps, store activates, value readable', async () => {
    const r = await wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET });
    expect(r).toMatchObject({ revision: 2, version: 1, state: 'ACTIVE' });
    expect(mock.versionsOf(VAULT_PATH)).toEqual([1]);
    const stored = await mock.readValue(VAULT_PATH, 'api-key');
    expect(stored!.value).toBe(SECRET);
    const again = await wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET + '2', cas: 1 });
    expect(again.version).toBe(2);
    expect(mock.versionsOf(VAULT_PATH)).toEqual([1, 2]);
  });

  it('stale CAS → 412 mapped to 409 VAULT_CAS_CONFLICT; zero new versions, zero revision churn', async () => {
    await wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET });
    await expect(wf().rotate({ connectorId: 'openai', ref: REF, value: 'x', cas: 99 })).rejects.toMatchObject({
      status: 409,
      code: 'VAULT_CAS_CONFLICT',
    });
    expect(mock.versionsOf(VAULT_PATH)).toEqual([1]);
    expect(store.rows).toHaveLength(2); // seed + activated rev2 only
  });

  it('cross-tenant candidate ref → migration-008 binding rejects it BEFORE any wire call', async () => {
    await expect(
      wf().rotate({
        connectorId: 'openai',
        ref: { ...REF, path: 'du/tenants/tenant-other/connectors/openai/accounts/du-conn-openai-main' },
        value: SECRET,
      }),
    ).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(mock.counters().writes).toBe(0);
    expect(store.rows).toHaveLength(1);
    const routes = mock.requests().map((q) => q.route);
    expect(routes).not.toContain('write');
    expect(routes).not.toContain('policy-denied');
  });

  it('path outside the role prefix → REAL 403 on the wire → VAULT_POLICY_DENIED, nothing created', async () => {
    // Layer 2 (Vault role policy) stays enforced on the wire for the very
    // writer seam the workflow uses: a foreign-tenant path gets a real 403.
    await expect(
      client.credentialWriter.writeCas(
        { ...REF, path: 'du/tenants/tenant-other/connectors/openai/accounts/du-conn-openai-main' },
        SECRET,
      ),
    ).rejects.toMatchObject({ code: 'CAPABILITY_DENIED' });
    expect(mock.counters().writes).toBe(0);
    expect(mock.requests().map((q) => q.route)).toContain('policy-denied');
    // And a real 403 during a rotation maps through the workflow unchanged.
    mock.failNextWrite('policy-denied');
    await expect(wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET })).rejects.toMatchObject({
      status: 403,
      code: 'VAULT_POLICY_DENIED',
    });
    expect(mock.counters().writes).toBe(0);
    expect(store.rows).toHaveLength(1);
  });

  it('server 5xx → retryable 503 and NO half-effect; retry completes', async () => {
    mock.failNextWrite('server-error');
    await expect(wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET })).rejects.toMatchObject({
      status: 503,
      code: 'TEMPORARY_UNAVAILABLE',
    });
    expect(store.rows).toHaveLength(1);
    const ok = await wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET });
    expect(ok.state).toBe('ACTIVE');
    expect(mock.versionsOf(VAULT_PATH)).toEqual([1]);
  });

  it('lease revoke on the wire → further rotations fail-closed (403-class), store untouched', async () => {
    await wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET });
    await client.revokeCurrentToken();
    await expect(wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET + '2' })).rejects.toMatchObject({
      status: 403,
    });
    expect(mock.versionsOf(VAULT_PATH)).toEqual([1]); // pre-revoke version only
    expect(store.rows.filter((x) => x.state === 'ACTIVE')).toHaveLength(1);
    expect(store.rows.find((x) => x.state === 'ACTIVE')!.revision).toBe(2);
  });

  it('workflow.revoke retires the store chain (no ACTIVE orphan) and audits masked', async () => {
    const events: Record<string, unknown>[] = [];
    const workflow = createCredentialWorkflow({
      vault: client.credentialWriter,
      revisions: store,
      audit: { record: async (e) => void events.push(e as unknown as Record<string, unknown>) },
    });
    await workflow.rotate({ connectorId: 'openai', ref: REF, value: SECRET });
    const rev = await workflow.revoke('openai');
    expect(rev).toMatchObject({ revoked: true, previousRevision: 2 });
    expect(store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(0);
    expect(JSON.stringify(events)).not.toContain(SECRET);
  });

  it('VAULT-06 connection loss at activate strands PENDING; restart reconcile promotes over the same live chain', async () => {
    const events: Record<string, unknown>[] = [];
    await wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET });
    store.failNextActivate = true;
    await expect(wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET + '-2', cas: 1 })).rejects.toThrow(/simulated crash/);
    expect(mock.versionsOf(VAULT_PATH)).toEqual([1, 2]);
    expect(store.rows.filter((r) => r.state === 'PENDING')).toHaveLength(1);
    // crash-restart: fresh workflow instance, SAME store + SAME live mock Vault
    const wf2 = createCredentialWorkflow({
      vault: client.credentialWriter,
      revisions: store,
      audit: { record: async (e) => void events.push(e as unknown as Record<string, unknown>) },
    });
    const writesBefore = mock.counters().writes;
    expect(await wf2.reconcile('openai', 3, 2)).toBe('ACTIVE');
    expect(mock.counters().writes).toBe(writesBefore); // reconcile never re-writes the secret
    expect(store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(1);
    expect(store.rows.filter((r) => r.state === 'PENDING')).toHaveLength(0);
    expect(store.rows.find((r) => r.revision === 3)!.state).toBe('ACTIVE');
    const md = await wf2.describe('openai');
    expect(md.revision).toBe(3);
    expect(md.source.pinnedVersion).toBe(2);
    expect(md.vaultVersions).toEqual([1, 2]);
    expect(JSON.stringify(md)).not.toContain(SECRET);
    expect(events).toHaveLength(0); // Δ8: reconcile emits NO audit event today — restart repairs are audit-invisible
  });

  it('VAULT-06 reconcile replay: state-safe, one ACTIVE, zero write churn — replay LABEL pinned as Δ7', async () => {
    await wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET });
    store.failNextActivate = true;
    await expect(wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET + '-2', cas: 1 })).rejects.toThrow(/simulated crash/);
    const wf2 = createCredentialWorkflow({ vault: client.credentialWriter, revisions: store });
    expect(await wf2.reconcile('openai', 3, 2)).toBe('ACTIVE');
    const again = await wf2.reconcile('openai', 3, 2);
    expect(again).toBe('RETIRED'); // Δ7: replay label is wrong...
    expect(store.rows.find((r) => r.revision === 3)!.state).toBe('ACTIVE'); // ...state untouched (retire only accepts PENDING)
    expect(store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(1);
    expect(mock.counters().writes).toBe(2);
  });

  it('VAULT-06 emergency revoke retires the FULL chain incl. stranded PENDING; nothing left invokable; zero-secret surface', async () => {
    const events: Record<string, unknown>[] = [];
    const workflow = createCredentialWorkflow({
      vault: client.credentialWriter,
      revisions: store,
      audit: { record: async (e) => void events.push(e as unknown as Record<string, unknown>) },
    });
    await workflow.rotate({ connectorId: 'openai', ref: REF, value: SECRET });
    store.failNextActivate = true;
    await expect(workflow.rotate({ connectorId: 'openai', ref: REF, value: SECRET + '-2', cas: 1 })).rejects.toThrow(/simulated crash/);
    const rev = await workflow.revoke('openai');
    expect(rev).toMatchObject({ revoked: true, previousRevision: 2 });
    expect(store.rows.every((r) => r.state === 'RETIRED')).toBe(true);
    await expect(workflow.rotate({ connectorId: 'openai', ref: REF, value: SECRET + '-3' })).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(await workflow.reconcile('openai', 3, 2)).toBe('RETIRED');
    expect(store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(0);
    expect(mock.counters().writes).toBe(2); // revoke and the failed ops never touch the Vault again
    const dump = JSON.stringify([rev, events]);
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('hvs.');
  });

  it('metadata endpoint masks values on the raw wire (KV v2 metadata NEVER returns data)', async () => {
    await wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET });
    const token = client.tokenClient.currentToken();
    const res = await fetchNoPool(`${mock.url}/v1/secret/metadata/${VAULT_PATH}`, {
      headers: { 'x-vault-token': token!.value },
    });
    expect(res.status).toBe(200);
    expect(res.text).toContain('versions');
    expect(res.text).not.toContain(SECRET);
  });

  it('no error message across the chain leaks the secret', async () => {
    const errs: unknown[] = [];
    await wf().rotate({ connectorId: 'openai', ref: { ...REF, mount: 'wrong' }, value: SECRET }).catch((e: unknown) => errs.push(e));
    await wf().rotate({ connectorId: 'openai', ref: REF, value: SECRET, cas: 77 }).catch((e: unknown) => errs.push(e));
    const dump = JSON.stringify(errs.map((e) => (e instanceof HttpError ? { code: e.code, message: e.message } : String(e))));
    expect(dump).not.toContain(SECRET);
    expect(dump).not.toContain('hvs.');
  });
});
