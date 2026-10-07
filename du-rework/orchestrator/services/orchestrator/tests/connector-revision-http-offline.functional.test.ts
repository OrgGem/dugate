import { randomBytes } from 'node:crypto';
import type { ConnectorCredentialSource } from '../../../packages/contracts/src/vault';
import type { Server } from 'node:http';
import type { ConnectorRevision } from '../../connector/src/db/repository';

/**
 * The Connector server is loaded from its BUILT dist (typed boundary below)
 * instead of a cross-package src import: orchestrator's tsconfig must not
 * compile connector-internal modules that were authored against the
 * connector's own project config (contract-grants et al.). The dist is built
 * by the same repo's build step this cycle.
 */
interface StoreWire {
  list(): Promise<ConnectorRevision[]>;
  get(connectorId: string): Promise<ConnectorRevision | undefined>;
  getRevision(connectorId: string, revision: number): Promise<ConnectorRevision | undefined>;
  getCurrentRevision(connectorId: string): Promise<ConnectorRevision | undefined>;
  createRevision(input: Omit<ConnectorRevision, 'revision'>): Promise<ConnectorRevision>;
  createPendingRevision(connectorId: string, credentialSource: unknown): Promise<ConnectorRevision>;
  activateRevision(connectorId: string, revision: number, expectedCurrentRevision: number): Promise<boolean>;
  retireRevision(connectorId: string, revision: number): Promise<void>;
  rotateCredential(connectorId: string, secret: string): Promise<void>;
  disable(connectorId: string): Promise<void>;
  test(connectorId: string): Promise<{ ok: boolean; errorCode?: string }>;
}
interface RuntimeWire {
  invoke(body: unknown): Promise<never>;
  get(invocationId: string, grant?: string): Promise<undefined>;
  cancel(invocationId: string, reason: string, grant?: string): Promise<never>;
}
interface ServiceIdentityVerifierWire {
  verify(headers: Readonly<Record<string, string | undefined>>): Promise<{
    subject: string;
    audience: string;
    scopes: string[];
  }>;
}
const connectorHttp: {
  createConnectorServer(dependencies: {
    management: StoreWire;
    runtime: RuntimeWire;
    identityVerifier: ServiceIdentityVerifierWire;
    capabilities: () => unknown;
    ready: () => Promise<boolean>;
  }): Server & { drainRequests(timeoutMs: number): Promise<boolean> };
} = require('../../connector/dist/http/server.js');
const connectorIdentity: {
  HmacServiceIdentityVerifier: new (secret: Uint8Array) => ServiceIdentityVerifierWire;
} = require('../../connector/dist/identity.js');
import { createCredentialWorkflow, type PinnedSource, type VaultCredentialWriter } from '../src/modules/connector-credentials/workflow';
import { createConnectorRevisionHttpAdapter } from '../src/modules/connector-credentials/connector-http-store';
import { createConnectorManagementAuthorizationProvider } from '../src/modules/connectors/management-service-identity';
import { fetchNoPool, noPoolFetchImpl } from '../../../../tests/harness/mock-vault/client';
import { listenLoopback } from '../../../../tests/harness/listen-loopback';

/** Non-pooled JSON fetch: harness servers are short-lived and ephemeral
 *  ports get reused between tests — undici pooling bleeds through. */
async function jfetch(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; text: string; json: () => Promise<unknown> }> {
  const r = await fetchNoPool(url, {
    ...opts,
    headers: { authorization: authorizationForRequest(), ...opts.headers },
  });
  return { status: r.status, text: r.text, json: async () => JSON.parse(r.text) as unknown };
}
import { createVaultDevFixture, VaultError, type VaultDevFixture } from '../../../packages/contracts/tests/stubs/vault-dev-fixture';
import { HttpError } from '../src/http/errors';

/**
 * VAULT-06 offline lifecycle tests (Qwen-2, cycle 98) — zero DB/Redis.
 * REAL orchestrator→connector HTTP wire: the actual Connector management
 * server (createConnectorServer) backed by an in-memory repository with the
 * production CAS semantics, driven through the actual credential workflow via
 * the actual HTTP adapter. Covers: CAS rotation chain, in-flight/new pin
 * separation, emergency revoke, restart/reconcile of stranded PENDING, and
 * transport fail-closed behavior.
 */

class InMemoryRevisionRepo {
  readonly rows: ConnectorRevision[] = [];
  private readonly credentials = new Map<string, Uint8Array>();
  async list() {
    return [...this.rows];
  }
  async get(connectorId: string) {
    return [...this.rows].reverse().find((r) => r.connectorId === connectorId);
  }
  async getActiveRevision(connectorId: string) {
    return [...this.rows].reverse().find((r) => r.connectorId === connectorId && r.state === 'ACTIVE');
  }
  async getRevision(connectorId: string, revision: number) {
    return this.rows.find((r) => r.connectorId === connectorId && r.revision === revision);
  }
  async createRevision(input: Omit<ConnectorRevision, 'revision'>): Promise<ConnectorRevision> {
    const revision = ((await this.get(input.connectorId))?.revision ?? 0) + 1;
    const row: ConnectorRevision = { ...input, revision };
    this.rows.push(row);
    return row;
  }
  async activateRevision(connectorId: string, revision: number, expectedCurrent: number): Promise<boolean> {
    const current = await this.getActiveRevision(connectorId);
    if (!current || current.revision !== expectedCurrent) return false;
    const target = await this.getRevision(connectorId, revision);
    if (!target || target.state !== 'PENDING') return false;
    current.state = 'RETIRED';
    target.state = 'ACTIVE';
    return true;
  }
  async retireRevision(connectorId: string, revision: number): Promise<void> {
    const row = await this.getRevision(connectorId, revision);
    if (row && row.state === 'PENDING') row.state = 'RETIRED';
  }
  async disable(connectorId: string): Promise<void> {
    for (const r of this.rows) if (r.connectorId === connectorId) r.state = 'RETIRED';
  }
  async getActiveCredential(credentialRef: string) {
    return this.credentials.get(credentialRef);
  }
  async put(credentialRef: string, value: Uint8Array) {
    this.credentials.set(credentialRef, value);
    return credentialRef;
  }
  async revoke(credentialRef: string) {
    this.credentials.delete(credentialRef);
  }
  seed(connectorId: string, credentialRef: string): ConnectorRevision {
    const row: ConnectorRevision = {
      connectorId,
      revision: 1,
      adapter: 'openai-http',
      config: { baseUrl: 'https://api.example.com', path: '/v1', timeoutMs: 5000 },
      credentialRef,
      state: 'ACTIVE',
      credentialSource: { kind: 'legacy-db', credentialRef },
      // The workflow trusts the ROW's own binding (ConnectorRevisionBindingSchema);
      // an unbound '' tenant carries no account coordinate -> every rotate 403s
      // BINDING_DENIED. Coordinates mirror the canonical REASON path below.
      tenantId: 'tenant-a',
      accountId: 'du-conn-openai-main',
    };
    this.rows.push(row);
    return row;
  }
}

const cipherStub = {
  encrypt: (s: string) => new TextEncoder().encode(s),
  decrypt: (v: Uint8Array) => new TextDecoder().decode(v),
};
const registryStub = { get: (name: string): unknown => ({ id: name }) } as never;

interface Harness {
  baseUrl: string;
  repo: InMemoryRevisionRepo;
  management: StoreWire;
  stop: () => Promise<void>;
}

async function bootConnector(connectorId: string, credentialRef = 'cred-1'): Promise<Harness> {
  const repo = new InMemoryRevisionRepo();
  repo.seed(connectorId, credentialRef);
  // DurableConnectorManagement is exercised through the REAL server routes;
  // build it inline to avoid importing services internals not re-exported.
  const management = buildManagement(repo);
  const server = connectorHttp.createConnectorServer({
    management,
    identityVerifier: new connectorIdentity.HmacServiceIdentityVerifier(MANAGEMENT_KEY),
    runtime: {
      invoke: async () => {
        throw new Error('runtime not under test');
      },
      get: async () => undefined,
      cancel: async () => {
        throw new Error('runtime not under test');
      },
    },
    capabilities: () => ({ adapters: ['openai-http'] }),
    ready: async () => true,
  });
  const quietBand = 46_000 + (process.pid % 80) * 8 + (HARNESS_PORT_SLOTS++ % 12) * 24;
  await listenLoopback(server, quietBand);
  const addr = server.address();
  if (addr === null || typeof addr === 'string') throw new Error('no address');
  return {
    baseUrl: `http://127.0.0.1:${addr.port}`,
    repo,
    management,
    stop: () => new Promise<void>((resolve, reject) => server.close((e: unknown) => (e ? reject(e) : resolve()))),
  };
}

let HARNESS_PORT_SLOTS = 0;

function buildManagement(repo: InMemoryRevisionRepo): StoreWire {
  const store = {
    list: () => repo.list(),
    get: (id: string) => repo.get(id),
    getRevision: (id: string, rev: number) => repo.getRevision(id, rev),
    getCurrentRevision: (id: string) => repo.getActiveRevision(id),
    createRevision: (input: Omit<ConnectorRevision, 'revision'>) => repo.createRevision(input),
    async createPendingRevision(connectorId: string, credentialSource: unknown) {
      // SAME validator the shipped DurableConnectorManagement uses (dist wire).
      const { assertVaultAccountPrefix, parseCredentialSource } = require('../../connector/dist/vault/resolver.js') as {
        assertVaultAccountPrefix: (
          source: Extract<ConnectorCredentialSource, { kind: 'vault-kv2' }>,
          scope: { connectorId: string },
        ) => void;
        parseCredentialSource: (v: unknown) => ConnectorCredentialSource;
      };
      let source: ConnectorCredentialSource;
      try {
        source = parseCredentialSource(credentialSource);
      } catch {
        throw Object.assign(new Error('credential source invalid'), { code: 'INVALID_INPUT' });
      }
      if (source.kind !== 'vault-kv2') {
        throw Object.assign(new Error('only vault sources may create PENDING'), { code: 'INVALID_INPUT' });
      }
      assertVaultAccountPrefix(source, { connectorId });
      const current = await repo.getActiveRevision(connectorId);
      if (!current) throw Object.assign(new Error('no ACTIVE revision to extend'), { code: 'INVALID_INPUT' });
      return repo.createRevision({
        connectorId,
        adapter: current.adapter,
        config: current.config,
        credentialRef: current.credentialRef,
        state: 'PENDING',
        credentialSource: source,
        tenantId: source.path.split('/')[2]!,
        accountId: source.account,
      });
    },
    activateRevision: (id: string, rev: number, expected: number) => repo.activateRevision(id, rev, expected),
    retireRevision: (id: string, rev: number) => repo.retireRevision(id, rev),
    rotateCredential: async () => undefined,
    disable: (id: string) => repo.disable(id),
    test: async () => ({ ok: true }),
  };
  return store as unknown as StoreWire;
}

function fixtureWriter(fx: VaultDevFixture): VaultCredentialWriter {
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

const REASON = { account: 'du-conn-openai-main', mount: 'secret', path: 'du/tenants/tenant-a/connectors/openai-live/accounts/du-conn-openai-main', key: 'api-key' };
const TEST_SCOPES = [{ mount: 'secret', pathPrefix: 'du/tenants/tenant-a/connectors/openai-live/accounts' }];
const MANAGEMENT_KEY = Buffer.alloc(32, 0x37);
const authorizationForRequest = createConnectorManagementAuthorizationProvider(MANAGEMENT_KEY);

function createScopedVaultFixture(): VaultDevFixture {
  return createVaultDevFixture({ scopes: TEST_SCOPES });
}

function wfViaHttp(baseUrl: string, fx: VaultDevFixture) {
  return createCredentialWorkflow({
    vault: fixtureWriter(fx),
    revisions: createConnectorRevisionHttpAdapter({
      baseUrl,
      authorizationForRequest,
      fetchImpl: noPoolFetchImpl(),
    }),
  });
}

describe('VAULT-06 lifecycle over the real orchestrator↔connector HTTP wire', () => {
  let h: Harness;
  let fx: VaultDevFixture;
  const connectorId = 'openai-live';

  beforeEach(async () => {
    h = await bootConnector(connectorId);
    fx = createScopedVaultFixture();
  });
  afterEach(async () => {
    await h.stop();
  });

  it('rotate #1 over HTTP: PENDING cloned from CURRENT then CAS-activated', async () => {
    const r = await wfViaHttp(h.baseUrl, fx).rotate({ connectorId, ref: REASON, value: 'sk-v1' });
    expect(r).toMatchObject({ revision: 2, version: 1, state: 'ACTIVE' });
    const rev1 = await h.repo.getRevision(connectorId, 1);
    const rev2 = await h.repo.getRevision(connectorId, 2);
    expect(rev1!.state).toBe('RETIRED');
    expect(rev2!.state).toBe('ACTIVE');
    expect(rev2!.credentialSource).toMatchObject({ kind: 'vault-kv2', ...REASON, version: 1 });
  });

  it('pin separation: new work reads CURRENT (v2 pin); in-flight revision 2 keeps its OLD pin', async () => {
    const wf = wfViaHttp(h.baseUrl, fx);
    await wf.rotate({ connectorId, ref: REASON, value: 'sk-v1' }); // rev2 pins v1
    const r2 = await wf.rotate({ connectorId, ref: REASON, value: 'sk-v2' }); // rev3 pins v2
    expect(r2).toMatchObject({ revision: 3, version: 2, state: 'ACTIVE' });
    const inFlight = await (await jfetch(`${h.baseUrl}/connectors/${connectorId}/revisions/2`)).json() as {
      state: string; credentialSource: { version: number };
    };
    expect(inFlight.state).toBe('RETIRED'); // retired as CURRENT
    expect(inFlight.credentialSource.version).toBe(1); // but its PIN is untouched — SEC-05/06 in-flight determinism
    const current = await (await jfetch(`${h.baseUrl}/connectors/${connectorId}/revisions/current`)).json() as {
      revision: number; credentialSource: { version: number };
    };
    expect(current.revision).toBe(3);
    expect(current.credentialSource.version).toBe(2);
  });

  it('CAS discipline over HTTP: activate with a stale expectedCurrent is a no-op (409)', async () => {
    const wf = wfViaHttp(h.baseUrl, fx);
    await wf.rotate({ connectorId, ref: REASON, value: 'sk-v1' }); // rev2 ACTIVE
    const res = await jfetch(`${h.baseUrl}/connectors/${connectorId}/revisions/3/activate`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ expectedCurrentRevision: 1 }), // stale chain view
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ activated: false });
  });

  it('emergency revoke (disable): CURRENT gone → new rotations fail CLOSED, no phantom ACTIVE', async () => {
    const wf = wfViaHttp(h.baseUrl, fx);
    await wf.rotate({ connectorId, ref: REASON, value: 'sk-v1' });
    await jfetch(`${h.baseUrl}/connectors/${connectorId}/disable`, { method: 'POST' });
    // No ACTIVE to extend → CURRENT endpoint 404s, the adapter maps it to
    // undefined exactly like the port contract, and the workflow refuses with
    // a clean 404 BEFORE any vault write (fail-closed, no phantom PENDING).
    await expect(wf.rotate({ connectorId, ref: REASON, value: 'sk-v2' })).rejects.toBeInstanceOf(HttpError);
    await expect(wf.rotate({ connectorId, ref: REASON, value: 'sk-v2' })).rejects.toMatchObject({ status: 404 });
    expect(h.repo.rows).toHaveLength(2); // rev1 + rev2 only — no phantom revision
    const vaultWritesAfterRevoke = await jfetch(`${h.baseUrl}/connectors/${connectorId}/revisions/current`);
    expect(vaultWritesAfterRevoke.status).toBe(404);
    const states = h.repo.rows.map((r) => r.state);
    expect(states.every((s) => s === 'RETIRED')).toBe(true);
  });

  it('restart/reconcile: stranded PENDING from a crashed orchestrator is promoted (or retired) by the NEW instance', async () => {
    // Simulate crash window B manually: PENDING exists, activation call lost.
    const stranded = await (await jfetch(`${h.baseUrl}/connectors/${connectorId}/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialSource: { kind: 'vault-kv2', ...REASON, version: 1 }, tenantId: 'tenant-a', accountId: 'du-conn-openai-main' }),
    })).json() as { revision: number };
    expect(stranded.revision).toBe(2);

    // 'restart' = fresh workflow over a fresh adapter instance
    const wf2 = wfViaHttp(h.baseUrl, createScopedVaultFixture());
    const outcome = await wf2.reconcile(connectorId, stranded.revision, 1);
    expect(outcome).toBe('ACTIVE');
    expect((await h.repo.get(connectorId))!.revision).toBe(2);

    // A second stranded PENDING against a moved-on chain must be RETIRED.
    await (await jfetch(`${h.baseUrl}/connectors/${connectorId}/revisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ credentialSource: { kind: 'vault-kv2', ...REASON, version: 2 }, tenantId: 'tenant-a', accountId: 'du-conn-openai-main' }),
    }));
    const outcome2 = await wf2.reconcile(connectorId, 3, 1); // expectedCurrent stale
    expect(outcome2).toBe('RETIRED');
    expect((await h.repo.getActiveRevision(connectorId))!.revision).toBe(2); // ACTIVE unchanged
    expect((await h.repo.getRevision(connectorId, 3))!.state).toBe('RETIRED');
  });

  it('transport failure is fail-closed 503 on every port call (adapter never guesses)', async () => {
    const dead = createConnectorRevisionHttpAdapter({
      baseUrl: 'http://127.0.0.1:1',
      authorizationForRequest,
      timeoutMs: 500,
    });
    await expect(dead.get(connectorId)).rejects.toMatchObject({
      status: 503,
      code: 'TEMPORARY_UNAVAILABLE',
    });
    const src: PinnedSource = { kind: 'vault-kv2', ...REASON, version: 1 };
    await expect(dead.createPending(connectorId, src)).rejects.toMatchObject({ status: 503 });
    await expect(dead.activate(connectorId, 2, 1)).rejects.toMatchObject({ status: 503 });
    await expect(dead.retire(connectorId, 2)).rejects.toMatchObject({ status: 503 });
  });

  it('invalid credential source at the HTTP edge → rejected for the reason it claims, zero PENDING churn', async () => {
    const post = async (body: Record<string, unknown>) => {
      const res = await jfetch(`${h.baseUrl}/connectors/${connectorId}/revisions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      });
      return { status: res.status, payload: (await res.json()) as Record<string, unknown> };
    };
    const errOf = (payload: Record<string, unknown>) =>
      (payload.error ?? {}) as { code?: string; message?: string };
    const BINDING_GUARD = 'credentialSource and independent revision binding are required.';
    const BINDING = { tenantId: 'tenant-a', accountId: 'du-conn-openai-main' };
    // ONLY the `path` differs from an otherwise accepted source, so whatever
    // rejects it is answering the path rule and not an absent field. M1 measured
    // the earlier draft of this test: a source that merely omitted `account` was
    // also a 400, and the test stayed green while proving nothing about traversal.
    const traversal = { ...REASON, kind: 'vault-kv2', path: '../etc', version: 1 };
    // Without the independent binding the guard rejects BEFORE any source is
    // parsed, so this particular 400 says nothing about the path at all.
    const noBinding = await post({ credentialSource: traversal });
    expect(noBinding.status).toBe(400);
    expect(errOf(noBinding.payload).message).toBe(BINDING_GUARD);
    // With the binding supplied the path rule is the only reason left to reject,
    // and the response must not reflect the attempted path.
    const withBinding = await post({ credentialSource: traversal, ...BINDING });
    expect(withBinding.status).toBe(400);
    expect(errOf(withBinding.payload).code).toBe('INVALID_INPUT');
    expect(errOf(withBinding.payload).message).not.toBe(BINDING_GUARD);
    expect(JSON.stringify(withBinding.payload)).not.toContain('../etc');
    expect(h.repo.rows).toHaveLength(1);
    // Positive control: the same request carrying the canonical path is ACCEPTED,
    // which is what makes the 400 above a verdict about the path specifically.
    const accepted = await post({ credentialSource: { ...REASON, kind: 'vault-kv2', version: 1 }, ...BINDING });
    expect(accepted.status).toBe(201);
    expect(accepted.payload.revision).toBe(2);
    expect(h.repo.rows.map((r) => r.state)).toEqual(['ACTIVE', 'PENDING']);
  });
});

describe('VAULT-06 draft schema pin', () => {
  it('migration 007 exists, is additive JSONB and documents NULL=legacy-db', async () => {
    const { readFileSync } = await import('node:fs');
    const sql = readFileSync(
      require.resolve('../../connector/src/db/migrations/007_connector_credential_source.sql'),
      'utf8',
    );
    expect(sql).toContain('ADD COLUMN IF NOT EXISTS credential_source JSONB');
    expect(sql).toContain("jsonb_build_object('kind', 'legacy-db', 'credentialRef', credential_ref)");
    expect(sql).toContain('WHERE credential_source IS NULL');
  });
});
