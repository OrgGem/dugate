import {
  authorizeAdminAction,
  dispatchAdminAction,
  type AdminActionDeps,
} from '../src/modules/admin-actions/dispatcher';
import type { AdminActionAuth } from '../src/modules/admin-actions/rbac';
import type { AuditRecordInput, AuditService } from '../src/modules/audit/audit';
import type { Db } from '../src/db/db';
import {
  createCredentialWorkflow,
  type ConnectorRevisionStore,
  type PinnedSource,
  type RevisionRow,
  type VaultCredentialWriter,
} from '../src/modules/connector-credentials/workflow';
import { HttpError } from '../src/http/errors';
import { createVaultDevFixture, VaultError, type VaultDevFixture } from '../../../packages/contracts/tests/stubs/vault-dev-fixture';

/**
 * VAULT-04 offline Admin-Actions tests (Qwen-2, cycle 99) — zero DB/Redis.
 * REAL dispatcher + REAL credential workflow; the Vault is the VAULT-02
 * fixture (writer identity), the revision store is an in-memory port with
 * revokeAll, and the idempotency marker is a scripted fake of
 * admin_idempotency. Response masking and zero-side-effect denials are
 * asserted per action.
 */

const VALUE = 'sk-live-Vault04Action-' + 'z'.repeat(18);
const VALUE2 = 'sk-live-Vault04Strand-' + 'w'.repeat(18);
const REASON = { account: 'du-conn-openai-main', mount: 'secret', path: 'du/tenants/tenant-a/connectors/openai/accounts/du-conn-openai-main', key: 'api-key' };
const TEST_SCOPES = [{ mount: 'secret', pathPrefix: 'du/tenants/tenant-a/connectors/openai/accounts' }];

function createScopedVaultFixture(): VaultDevFixture {
  return createVaultDevFixture({ scopes: TEST_SCOPES });
}
const BEARER_PLATFORM: AdminActionAuth = { kind: 'bearer', principal: { role: 'platform' } } as AdminActionAuth;
const BEARER_OPERATOR: AdminActionAuth = { kind: 'bearer', principal: { role: 'tenant_operator', tenantId: 'ten-A' } } as unknown as AdminActionAuth;
const COOKIE_ADMIN: AdminActionAuth = { kind: 'cookie', role: 'admin', csrfOk: true } as AdminActionAuth;
const COOKIE_OPERATOR: AdminActionAuth = { kind: 'cookie', role: 'operator', csrfOk: true } as AdminActionAuth;
const COOKIE_ADMIN_NO_CSRF: AdminActionAuth = { kind: 'cookie', role: 'admin', csrfOk: false } as AdminActionAuth;

class MemStore implements ConnectorRevisionStore {
  readonly rows: RevisionRow[] = [];
  revokedAllCalls = 0;
  failNextActivate = false;
  constructor(connectorId: string) {
    this.rows.push({
      revision: 1,
      adapter: 'openai-http',
      state: 'ACTIVE',
      credentialSource: { kind: 'legacy-db', credentialRef: 'legacy-openai' },
      tenantId: 'tenant-a',
      accountId: 'du-conn-openai-main',
    });
    void connectorId;
  }
  async get() {
    return [...this.rows].reverse().find((r) => r.state === 'ACTIVE');
  }
  async createPending(_id: string, source: PinnedSource): Promise<RevisionRow> {
    const head = this.rows[this.rows.length - 1]!;
    const row: RevisionRow = {
      revision: head.revision + 1,
      adapter: head.adapter,
      state: 'PENDING',
      credentialSource: source,
      tenantId: head.tenantId,
      accountId: head.accountId,
    };
    this.rows.push(row);
    return row;
  }
  async activate(_id: string, revision: number, expectedCurrent: number): Promise<boolean> {
    if (this.failNextActivate) {
      this.failNextActivate = false;
      throw new Error('simulated connection loss at activate');
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
    this.revokedAllCalls += 1;
    for (const r of this.rows) r.state = 'RETIRED';
  }
}

function fixtureVault(fx: VaultDevFixture, writes: number[]) {
  const token = fx.login('orchestrator-writer');
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

function makeWorld() {
  const markers = new Map<string, { route: string; payloadHash: string; body: Record<string, unknown> }>();
  const client = {
    query: async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.startsWith('INSERT INTO admin_idempotency')) {
        markers.set(String(params[0]), {
          route: String(params[1]),
          payloadHash: String(params[2]),
          body: JSON.parse(String(params[4])) as Record<string, unknown>,
        });
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 1 };
    },
  };
  const db = {
    query: async (sql: string, params: unknown[] = []) => {
      const s = sql.replace(/\s+/g, ' ').trim();
      if (s.includes('FROM admin_idempotency')) {
        const hit = markers.get(String(params[0]));
        return hit
          ? { rows: [{ key: String(params[0]), route: hit.route, payload_hash: hit.payloadHash, response_code: 201, response_body: hit.body }], rowCount: 1 }
          : { rows: [], rowCount: 0 };
      }
      return { rows: [], rowCount: 0 };
    },
    tx: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    close: async () => undefined,
  } as unknown as Db;
  const auditRows: AuditRecordInput[] = [];
  const audit = {
    record: async (input: AuditRecordInput) => {
      auditRows.push(input);
      return { id: 'a-' + auditRows.length };
    },
  } as unknown as AuditService;
  const fx = createScopedVaultFixture();
  const writes: number[] = [];
  const store = new MemStore('openai');
  const workflow = createCredentialWorkflow({ vault: fixtureVault(fx, writes), revisions: store });
  const deps: AdminActionDeps = {
    db,
    audit,
    registry: {} as never,
    profiles: {} as never,
    lifecycle: {} as never,
    runtime: {} as never,
    hashApiKey: (r: string) => 'h-' + r,
    correlationId: 'corr-v04',
    credentialWorkflow: workflow,
    connectorTest: async () => ({ ok: true, status: 200, detail: 'provider said ' + VALUE }),
  } as unknown as AdminActionDeps;
  return { deps, store, writes, markers, auditRows, fx };
}

function expectStatus(promise: Promise<unknown>, status: number, code: string) {
  return promise.then(
    () => {
      throw new Error(`expected ${status} ${code}, got resolve`);
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(status);
      expect((err as HttpError).code).toBe(code);
    }
  );
}

const ROTATE_PARAMS = { connectorId: 'openai', ...REASON, value: VALUE };

describe('VAULT-04 RBAC matrix (pure authorizeAdminAction)', () => {
  const actions = ['connectors.rotate_credential', 'connectors.revoke_credential', 'connectors.test_credential'];
  it.each(actions)('%s: platform bearer allowed', (action) => {
    expect(authorizeAdminAction(BEARER_PLATFORM, action)).toEqual({ ok: true });
  });
  it.each(actions)('%s: tenant-operator bearer 403', (action) => {
    expect(authorizeAdminAction(BEARER_OPERATOR, action)).toMatchObject({ ok: false, status: 403 });
  });
  it.each(actions)('%s: cookie admin allowed; operator/viewer/CSRF-less denied', (action) => {
    expect(authorizeAdminAction(COOKIE_ADMIN, action)).toEqual({ ok: true });
    expect(authorizeAdminAction(COOKIE_OPERATOR, action)).toMatchObject({ ok: false, status: 403 });
    expect(authorizeAdminAction(COOKIE_ADMIN_NO_CSRF, action)).toMatchObject({ ok: false, status: 403, message: /CSRF/ });
  });
  it('unknown connector action 404s before anything runs', () => {
    expect(authorizeAdminAction(BEARER_PLATFORM, 'connectors.drop_vault')).toMatchObject({ ok: false, status: 404 });
  });
});

describe('VAULT-04 connectors.rotate_credential', () => {
  it('happy: 201, masked metadata ONLY, exactly one ACTIVE, marker + audit recorded', async () => {
    const w = makeWorld();
    const res = await dispatchAdminAction(w.deps, BEARER_PLATFORM, {
      action: 'connectors.rotate_credential',
      params: ROTATE_PARAMS,
      idempotencyKey: 'rotate-1',
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      connectorId: 'openai',
      revision: 2,
      version: 1,
      state: 'ACTIVE',
      metadata: { source: { mount: 'secret', path: REASON.path, key: 'api-key', pinnedVersion: 1, hasValue: true }, vaultVersions: [1] },
    });
    expect(JSON.stringify(res.body)).not.toContain(VALUE);
    expect(w.store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(1);
    expect(w.markers.size).toBe(1);
    expect(w.auditRows.map((a) => a.action)).toContain('connector.credential_rotate');
    expect(JSON.stringify(w.auditRows)).not.toContain(VALUE);
  });

  it('replay of the same key: marker wins, workflow NEVER re-executes', async () => {
    const w = makeWorld();
    const first = await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS, idempotencyKey: 'k' });
    const replay = await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS, idempotencyKey: 'k' });
    expect(replay.status).toBe(first.status);
    expect(replay.body.connectorId).toBe('openai');
    expect(w.writes).toEqual([1]); // exactly ONE vault version minted
    expect(w.store.rows).toHaveLength(2);
  });

  it('key reuse with a different payload → 409, zero new writes', async () => {
    const w = makeWorld();
    await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS, idempotencyKey: 'k' });
    await expectStatus(
      dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: { ...ROTATE_PARAMS, key: 'other' }, idempotencyKey: 'k' }),
      409,
      'IDEMPOTENCY_CONFLICT',
    );
    expect(w.writes).toEqual([1]);
  });

  it('stale CAS → 409 VAULT_CAS_CONFLICT and NO revision churn (no orphan ACTIVE)', async () => {
    const w = makeWorld();
    await expectStatus(
      dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: { ...ROTATE_PARAMS, cas: 42 } }),
      409,
      'VAULT_CAS_CONFLICT',
    );
    expect(w.store.rows).toHaveLength(1);
    expect(w.store.rows[0]!.state).toBe('ACTIVE');
    expect(w.markers.size).toBe(0);
  });

  it('vault policy deny → 403, nothing created', async () => {
    const w = makeWorld();
    await expectStatus(
      dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: { ...ROTATE_PARAMS, mount: 'kv-prod' } }),
      403,
      'VAULT_POLICY_DENIED',
    );
    expect(w.writes).toEqual([]);
    expect(w.store.rows).toHaveLength(1);
  });

  it('connector transport failure → 503 fail-closed, ZERO vault writes (no half-effect)', async () => {
    const w = makeWorld();
    const { createConnectorRevisionHttpAdapter } = await import('../src/modules/connector-credentials/connector-http-store');
    const dead = createConnectorRevisionHttpAdapter({ baseUrl: 'http://127.0.0.1:1', timeoutMs: 300 });
    const wf2 = createCredentialWorkflow({ vault: fixtureVault(createScopedVaultFixture(), w.writes), revisions: dead });
    (w.deps as { credentialWorkflow?: unknown }).credentialWorkflow = wf2;
    await expectStatus(dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS }), 503, 'TEMPORARY_UNAVAILABLE');
    expect(w.writes).toEqual([]);
  });

  it('workflow not wired → 503, and tenant-operator denial has ZERO side effects', async () => {
    const w = makeWorld();
    (w.deps as { credentialWorkflow?: unknown }).credentialWorkflow = undefined;
    await expectStatus(dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS }), 503, 'TEMPORARY_UNAVAILABLE');
    const w2 = makeWorld();
    await expectStatus(dispatchAdminAction(w2.deps, BEARER_OPERATOR, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS }), 403, 'PERMISSION_DENIED');
    expect(w2.writes).toEqual([]);
    expect(w2.store.rows).toHaveLength(1);
    expect(w2.markers.size).toBe(0);
  });
});

describe('VAULT-04 revoke + test actions', () => {
  it('revoke: every row non-ACTIVE, audit warning, subsequent rotate 404s', async () => {
    const w = makeWorld();
    await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS });
    const res = await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.revoke_credential', params: { connectorId: 'openai' } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ revoked: true, previousRevision: 2 });
    expect(w.store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(0);
    expect(w.auditRows.some((a) => a.action === 'connector.credential_revoke' && a.severity === 'warning')).toBe(true);
    await expectStatus(dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS }), 404, 'NOT_FOUND');
    // revoke on nothing-active is honest-idempotent
    const again = await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.revoke_credential', params: { connectorId: 'openai' } });
    expect(again.body).toMatchObject({ revoked: false });
  });

  it('test_credential: probe passthrough is MASKED to ok/errorCode only', async () => {
    const w = makeWorld();
    const res = await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.test_credential', params: { connectorId: 'openai' } });
    expect(res).toEqual({ status: 200, body: { connectorId: 'openai', ok: true } });
    expect(JSON.stringify(res)).not.toContain(VALUE);
    const w2 = makeWorld();
    (w2.deps as { connectorTest?: unknown }).connectorTest = async () => ({ ok: false, errorCode: 'CREDENTIAL_INVALID', detail: VALUE });
    const bad = await dispatchAdminAction(w2.deps, BEARER_PLATFORM, { action: 'connectors.test_credential', params: { connectorId: 'openai' } });
    expect(bad.body).toEqual({ connectorId: 'openai', ok: false, errorCode: 'CREDENTIAL_INVALID' });
    expect(JSON.stringify(bad)).not.toContain(VALUE);
  });

  it('test_credential without probe wiring → 503 (fail closed, no silent pass)', async () => {
    const w = makeWorld();
    (w.deps as { connectorTest?: unknown }).connectorTest = undefined;
    await expectStatus(dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.test_credential', params: { connectorId: 'openai' } }), 503, 'TEMPORARY_UNAVAILABLE');
  });
});

/**
 * VAULT-06 (W-VAULT06-ROTATION-LIFECYCLE-1): restart/reconcile of a PENDING
 * stranded by a lost activate call, and emergency revoke of the WHOLE chain.
 * Zero DB/Redis. REAL dispatcher + REAL workflow + REAL VAULT-02 fixture; the
 * MemStore models the connector-API port contract (activate = CAS on the true
 * ACTIVE head; retire touches PENDING rows only).
 */
describe('VAULT-06 restart/reconcile + emergency revoke lifecycle', () => {
  async function strandedWorld() {
    const w = makeWorld();
    await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS });
    w.store.failNextActivate = true;
    await expect(
      dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: { ...ROTATE_PARAMS, value: VALUE2 } }),
    ).rejects.toThrow(/simulated connection loss/);
    return w;
  }
  const restarted = (w: ReturnType<typeof makeWorld>) =>
    createCredentialWorkflow({ vault: fixtureVault(w.fx, w.writes), revisions: w.store });

  it('connection loss at activate strands PENDING; restart reconcile promotes it — never a second ACTIVE', async () => {
    const w = await strandedWorld();
    expect(w.store.rows.find((r) => r.revision === 2)!.state).toBe('ACTIVE');
    expect(w.store.rows.find((r) => r.revision === 3)!.state).toBe('PENDING');
    // while stranded, the masked GET surface keeps serving the OLD pinned version
    const before = await w.deps.credentialWorkflow!.describe('openai');
    expect(before.revision).toBe(2);
    expect(before.source.pinnedVersion).toBe(1);
    expect(before.vaultVersions).toEqual([1, 2]);
    // "restart" = fresh workflow instance (no carried state) over the SAME store + Vault
    const wf2 = restarted(w);
    expect(await wf2.reconcile('openai', 3, 2)).toBe('ACTIVE');
    expect(w.store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(1);
    expect(w.store.rows.find((r) => r.revision === 3)!.state).toBe('ACTIVE');
    expect(w.store.rows.find((r) => r.revision === 2)!.state).toBe('RETIRED');
    expect(w.store.rows.filter((r) => r.state === 'PENDING')).toHaveLength(0);
    const after = await wf2.describe('openai');
    expect(after.revision).toBe(3);
    expect(after.source.pinnedVersion).toBe(2);
    expect(JSON.stringify(after)).not.toContain(VALUE2);
  });

  it('reconcile replay is state-safe: one ACTIVE, no orphaned PENDING, zero vault write churn', async () => {
    const w = await strandedWorld();
    const wf2 = restarted(w);
    expect(await wf2.reconcile('openai', 3, 2)).toBe('ACTIVE');
    const writesBefore = w.writes.length;
    const again = await wf2.reconcile('openai', 3, 2);
    void again; // replay LABEL is the Δ7 candidate; the STATE contract is what this pins
    expect(w.store.rows.find((r) => r.revision === 3)!.state).toBe('ACTIVE');
    expect(w.store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(1);
    expect(w.store.rows.filter((r) => r.state === 'PENDING')).toHaveLength(0);
    expect(w.writes).toHaveLength(writesBefore); // reconcile never re-writes the secret
  });

  it('emergency revoke retires the FULL chain incl. the stranded PENDING; nothing left invokable', async () => {
    const w = await strandedWorld();
    const res = await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.revoke_credential', params: { connectorId: 'openai' } });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ revoked: true, previousRevision: 2 });
    expect(w.store.revokedAllCalls).toBe(1);
    expect(w.store.rows.every((r) => r.state === 'RETIRED')).toBe(true);
    expect(w.store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(0);
    expect(w.store.rows.filter((r) => r.state === 'PENDING')).toHaveLength(0);
    // no ACTIVE anchor: rotate cannot extend, a late reconcile cannot promote
    await expectStatus(
      dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS }),
      404,
      'NOT_FOUND',
    );
    const wf2 = restarted(w);
    expect(await wf2.reconcile('openai', 3, 2)).toBe('RETIRED');
    expect(w.store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(0);
    const dump = JSON.stringify([res.body, w.auditRows]);
    expect(dump).not.toContain(VALUE);
    expect(dump).not.toContain(VALUE2);
  });

  it('store without revokeAll -> emergency revoke fails CLOSED with 501, zero rows touched', async () => {
    const w = makeWorld();
    await dispatchAdminAction(w.deps, BEARER_PLATFORM, { action: 'connectors.rotate_credential', params: ROTATE_PARAMS });
    const noRevoke: ConnectorRevisionStore = {
      get: async () => w.store.get(),
      createPending: (id, source) => w.store.createPending(id, source),
      activate: (id, revision, expected) => w.store.activate(id, revision, expected),
      retire: (id, revision) => w.store.retire(id, revision),
    };
    const wf = createCredentialWorkflow({ vault: fixtureVault(w.fx, w.writes), revisions: noRevoke });
    await expect(wf.revoke('openai')).rejects.toMatchObject({ status: 501, code: 'REVOKE_UNSUPPORTED' });
    expect(w.store.revokedAllCalls).toBe(0);
    expect(w.store.rows.filter((r) => r.state === 'ACTIVE')).toHaveLength(1);
  });
});

