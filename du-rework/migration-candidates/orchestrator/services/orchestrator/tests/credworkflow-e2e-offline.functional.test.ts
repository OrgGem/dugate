import { join } from 'node:path';
import type { Db } from '../src/db/db';
import { dispatchAdminAction } from '../src/modules/admin-actions/dispatcher';
import { createConnectorManagementStore } from '../src/modules/connectors/connector-management-store';
import { createCredentialWorkflow, type ConnectorRevisionStore, type RevisionRow } from '../src/modules/connector-credentials/workflow';
import type { AuditService } from '../src/modules/audit/audit';
import { createApp, type App } from '../src/server';
import { loadMigrationFiles } from '../src/db/migrations';
import { createConnectorManagementAuthorizationProvider } from '../src/modules/connectors/management-service-identity';

/**
 * CREDWORKFLOW-IMPL — the G7 chain, offline end-to-end, plus the boot
 * composition flip.
 *
 * Part A drives the REAL dispatcher + REAL management store (scripted
 * connector fetch) + REAL credential workflow (fake Vault writer + fake
 * revision store) through: create -> bootstrap -> rotate -> activate -> test
 * -> disable. The secret exists ONLY in the vault write (positive control);
 * every response, audit row, connector-service request body and SQL statement
 * is scanned for it.
 *
 * Part B boots the REAL createApp (scripted pg twin) with/without the
 * DU_VAULT_KV_* env: complete env -> credentialWorkflow composed;
 * absent -> undefined (capabilities report false).
 */

const SENTINEL = 'CREDWORKFLOW-E2E-SENTINEL-77aa';
const CANONICAL_PATH = 'du/tenants/t1/connectors/c1/accounts/a1';

const VIEW = {
  connectorId: 'c1',
  revision: 3,
  adapter: 'mock-openai',
  state: 'PENDING',
  config: { headers: { authorization: '[REDACTED]' } },
  credentialRef: 'connectors/c1/credentials',
  tenantId: 't1',
  accountId: 'a1',
};

function json(status: number, body?: unknown): Response {
  return body === undefined
    ? (new Response(null, { status }) as unknown as Response)
    : (new Response(JSON.stringify(body), { status }) as unknown as Response);
}

function scriptedConnector() {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const href = String(url);
    calls.push({ url: href, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined });
    if (href.endsWith('/connectors') && (init?.method ?? 'GET') === 'GET') return json(200, [VIEW]);
    if (href.endsWith('/connectors') && init?.method === 'POST') return json(201, VIEW);
    if (href.endsWith('/revisions/bootstrap')) return json(201, { ...VIEW, revision: 2, replayed: false });
    if (/\/revisions\/\d+\/activate$/.test(href)) return json(200, { activated: true });
    if (href.endsWith('/c1/test')) return json(200, { ok: true });
    if (href.endsWith('/c1/disable')) return json(204);
    return json(404, { error: { code: 'NOT_FOUND' } });
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function fakeRevisions(): ConnectorRevisionStore {
  const row: RevisionRow = {
    revision: 2,
    adapter: VIEW.adapter,
    state: 'ACTIVE',
    credentialSource: { kind: 'vault-kv2', account: 'a1', mount: 'secret', path: CANONICAL_PATH, key: 'api_key', version: 1 },
    tenantId: 't1',
    accountId: 'a1',
  };
  return {
    async get() {
      return row;
    },
    async createPending() {
      return { ...row, revision: 3, state: 'PENDING' };
    },
    async activate() {
      return true;
    },
    async retire() {
      return undefined;
    },
  };
}

function makeDb() {
  const sql: string[] = [];
  const binds: unknown[][] = [];
  const client = {
    query: async (s: string, params?: unknown[]) => {
      sql.push(s.replace(/\s+/g, ' ').trim());
      if (params !== undefined) binds.push(params);
      return { rows: [], rowCount: 1 };
    },
  };
  const db = {
    query: async () => {
      throw new Error('unexpected pool query');
    },
    tx: async <T>(fn: (c: unknown) => Promise<T>) => fn(client),
  } as unknown as Db;
  return { db, sql, binds };
}

/**
 * SECRET-in-anything detector, shared by every leak check in this file. It is
 * deliberately a module-level function so the positive-control test below can
 * prove it actually detects: a detector that is only ever fed the SENTINEL as a
 * secret it never sees would pass vacuously.
 */
function leaks(value: unknown, depth = 0): boolean {
  if (typeof value === 'string') {
    if (value.includes(SENTINEL)) return true;
    if (/^[A-Za-z0-9+/=_-]{16,}$/.test(value)) {
      try {
        if (Buffer.from(value, 'base64').toString('utf8').includes(SENTINEL)) return true;
      } catch {
        /* not base64 */
      }
    }
    return false;
  }
  if (depth > 12 || value === null || typeof value !== 'object') return false;
  if (Array.isArray(value)) return value.some((v) => leaks(v, depth + 1));
  return Object.values(value as Record<string, unknown>).some((v) => leaks(v, depth + 1));
}

const PLATFORM = { kind: 'bearer' as const, principal: { role: 'platform' as const } };

describe('CREDWORKFLOW-IMPL — G7 chain offline (create→bootstrap→rotate→activate→test→disable)', () => {
  it('runs the whole chain; the secret exists only in the Vault write', async () => {
    const connector = scriptedConnector();
    const store = createConnectorManagementStore({
      baseUrlFor: () => 'http://connector.test',
      authorizationForRequest: () => 'Bearer test-management-token',
      fetchImpl: connector.fetchImpl,
    });
    const vaultWrites: { ref: { path: string; key: string }; value: string; cas?: number }[] = [];
    const workflow = createCredentialWorkflow({
      vault: {
        async writeCas(ref, value, cas) {
          vaultWrites.push({ ref: { path: ref.path, key: ref.key }, value, ...(cas === undefined ? {} : { cas }) });
          return 3;
        },
        async readVersions() {
          return { current_version: 3, versions: [1, 3] };
        },
      },
      revisions: fakeRevisions(),
      initialBindings: { c1: { tenantId: 't1', accountId: 'a1' } },
    });
    const audit = { record: jest.fn(async (_input: { action: string }, _client?: unknown) => undefined) };
    const { db, sql, binds } = makeDb();
    const deps = {
      db,
      audit: audit as unknown as AuditService,
      registry: {} as never,
      profiles: {} as never,
      lifecycle: {} as never,
      runtime: {} as never,
      hashApiKey: (raw: string) => 'hash:' + raw,
      correlationId: 'cw-e2e-1',
      connectorManagement: store,
      credentialWorkflow: workflow,
    } as never;

    const responses: unknown[] = [];
    const run = async (action: string, params: Record<string, unknown>) => {
      const res = await dispatchAdminAction(deps, PLATFORM, { action, params });
      responses.push(res.body);
      return res;
    };

    const created = await run('connector.upsert', {
      mode: 'create',
      connectorId: 'c1',
      adapter: 'mock-openai',
      config: { model: 'm' },
      credentialRef: 'connectors/c1/credentials',
    });
    expect(created.status).toBe(201);

    const boot = await run('connector.bootstrap', {
      connectorId: 'c1',
      credentialSource: { kind: 'vault-kv2', mount: 'secret', path: CANONICAL_PATH, key: 'api_key' },
      tenantId: 't1',
      accountId: 'a1',
    });
    expect(boot.status).toBe(201);
    expect(boot.body).toMatchObject({ connectorId: 'c1', revision: 2, replayed: false });

    const rotated = await run('connectors.rotate_credential', {
      connectorId: 'c1',
      mount: 'secret',
      path: CANONICAL_PATH,
      key: 'api_key',
      value: SENTINEL,
    });
    expect(rotated.status).toBe(201);
    expect(rotated.body).toMatchObject({ connectorId: 'c1', revision: 3, state: 'ACTIVE' });

    const activated = await run('connector.activate', { connectorId: 'c1', revision: 5, expectedCurrentRevision: 3 });
    expect(activated.status).toBe(200);
    const tested = await run('connector.test', { connectorId: 'c1' });
    expect(tested.body).toEqual({ connectorId: 'c1', ok: true });
    const disabled = await run('connector.disable', { connectorId: 'c1' });
    expect(disabled.status).toBe(200);

    // Positive control: the secret reached Vault exactly once, nowhere else.
    expect(vaultWrites).toHaveLength(1);
    expect(vaultWrites[0]).toMatchObject({ value: SENTINEL, ref: { path: CANONICAL_PATH, key: 'api_key' } });
    expect(leaks(responses)).toBe(false);
    expect(leaks(audit.record.mock.calls)).toBe(false);
    expect(leaks(connector.calls.map((c) => c.body))).toBe(false);

    // SQL capture is REAL (makeDb keeps text + binds) but the G7 chain issues
    // none: every collaborator here is a fake (Connector service + Vault + revision
    // store), so no credential action touches Postgres. Pinning `sql` to [] turns
    // the reviewer's vacuous `leaks(sql)` into a guard that FAILS if any credential
    // action ever starts writing to the DB - and if it does, the leak and
    // forbidden-table checks below run over real text + binds, not an empty list.
    expect(sql).toEqual([]);
    expect(binds).toEqual([]);
    expect(leaks(sql)).toBe(false);
    expect(leaks(binds)).toBe(false);
    expect(sql.some((s) => /operations|connector_bindings|profile_policy_snapshot/i.test(s))).toBe(false);

    const auditActions = audit.record.mock.calls.map((c) => (c[0] as { action: string }).action);
    expect(auditActions).toEqual([
      'connector.upsert',
      'connector.bootstrap',
      'connector.credential_rotate',
      'connector.activate',
      'connector.disable',
    ]);
    expect(sql.some((s) => /operations|connector_bindings|profile_policy_snapshot/i.test(s))).toBe(false);
  });

  it('Vault down: rotate rejects 503 and NO revision is created anywhere', async () => {
    const connector = scriptedConnector();
    const store = createConnectorManagementStore({
      baseUrlFor: () => 'http://connector.test',
      authorizationForRequest: () => 'Bearer test-management-token',
      fetchImpl: connector.fetchImpl,
    });
    const createPending = jest.fn();
    const workflow = createCredentialWorkflow({
      vault: {
        async writeCas() {
          throw { code: 'VAULT_SERVER_ERROR', retryable: true };
        },
        async readVersions() {
          return { current_version: 1, versions: [1] };
        },
      },
      revisions: {
        async get() {
          return {
            revision: 2,
            adapter: VIEW.adapter,
            state: 'ACTIVE' as const,
            credentialSource: { kind: 'vault-kv2', account: 'a1', mount: 'secret', path: CANONICAL_PATH, key: 'api_key', version: 1 },
            tenantId: 't1',
            accountId: 'a1',
          };
        },
        createPending,
        async activate() {
          return true;
        },
        async retire() {
          return undefined;
        },
      } as unknown as ConnectorRevisionStore,
      initialBindings: { c1: { tenantId: 't1', accountId: 'a1' } },
    });
    const audit = { record: jest.fn(async (_input: { action: string }, _client?: unknown) => undefined) };
    const { db } = makeDb();
    const deps = {
      db,
      audit: audit as unknown as AuditService,
      registry: {} as never,
      profiles: {} as never,
      lifecycle: {} as never,
      runtime: {} as never,
      hashApiKey: (raw: string) => 'hash:' + raw,
      correlationId: 'cw-e2e-2',
      connectorManagement: store,
      credentialWorkflow: workflow,
    } as never;

    await expect(
      dispatchAdminAction(deps, PLATFORM, {
        action: 'connectors.rotate_credential',
        params: { connectorId: 'c1', mount: 'secret', path: CANONICAL_PATH, key: 'api_key', value: SENTINEL },
      }),
    ).rejects.toMatchObject({ status: 503 });
    expect(createPending).not.toHaveBeenCalled();
    expect(connector.calls.some((c) => /revisions$/.test(c.url))).toBe(false);
    expect(audit.record).not.toHaveBeenCalled();
  });

  it('SQL capture is real: makeDb records text AND binds, and the forbidden-table check is load-bearing', async () => {
    type Queryable = {
      query: (sql: string, params?: unknown[]) => Promise<{ rows: unknown[]; rowCount: number }>;
    };
    const { db, sql, binds } = makeDb();
    await db.tx(async (client) => {
      const q = client as Queryable;
      await q.query('INSERT INTO connector_bindings (connector_id, credential) VALUES ($1, $2)', [
        'c1',
        SENTINEL,
      ]);
      await q.query('UPDATE operations SET input_ref = $1 WHERE id = $2', ['enc:1', 'op-1']);
      await q.query('INSERT INTO api_keys (id, key_hash) VALUES ($1, $2)', ['k1', 'hash:x']);
    });

    // Text AND binds are both captured - the previous capture dropped binds.
    expect(sql).toHaveLength(3);
    expect(binds).toEqual([
      ['c1', SENTINEL],
      ['enc:1', 'op-1'],
      ['k1', 'hash:x'],
    ]);

    // Positive control: the detector fires when the sentinel IS present, so the
    // `leaks(...) === false` checks elsewhere in this file are not green for free.
    expect(leaks(binds)).toBe(true);

    // The forbidden-table check now runs over REAL captured SQL and is
    // load-bearing: it matches two of the three statements and spares the third.
    const forbidden = (statement: string) =>
      /operations|connector_bindings|profile_policy_snapshot/i.test(statement);
    expect(sql.filter(forbidden)).toEqual([
      'INSERT INTO connector_bindings (connector_id, credential) VALUES ($1, $2)',
      'UPDATE operations SET input_ref = $1 WHERE id = $2',
    ]);
    expect(forbidden('INSERT INTO api_keys (id, key_hash) VALUES ($1, $2)')).toBe(false);
  });
});

/* ---------------- Part B: boot composition flip ---------------- */

jest.mock('pg', () => {
  const state = { schemaLedger: [] as unknown[] };
  function answer(sql: string): { rows: unknown[]; rowCount: number } {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    // CRED-LIMITS-801: verifyMigrations cross-checks the ledger with an
    // independent COUNT (migrations.ts:151). The mock below used to answer that
    // query with the {sequence,filename} rows, so rows[0].count was undefined,
    // ledgerRows read 0 against 32 files, and EVERY boot test in this file threw.
    if (/SELECT count\(\*\)::int/i.test(text)) return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 };
    if (/FROM schema_migrations/i.test(text)) {
      return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    }
    return { rows: [], rowCount: 0 };
  }
  class ScriptedPool {
    async query(sql: string) {
      return answer(sql);
    }
    async connect() {
      return { query: (sql: string) => Promise.resolve(answer(sql)), release: () => undefined };
    }
    async end() {
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

describe('CREDWORKFLOW-IMPL — boot composition flip', () => {
  const apps: App[] = [];
  const saved: Record<string, string | undefined> = {};

  beforeAll(() => {
    (jest.requireMock('pg') as { __duState: { schemaLedger: unknown[] } }).__duState.schemaLedger = loadMigrationFiles(
      join(__dirname, '..', 'migrations'),
    ).map((file) => ({ sequence: file.sequence, filename: file.filename }));
    for (const name of ['DU_VAULT_KV_OPTIONS', 'DU_VAULT_KV_TOKEN', 'DU_CONNECTOR_INITIAL_BINDINGS']) {
      saved[name] = process.env[name];
    }
  });

  afterAll(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });

  it('complete env → credentialWorkflow composed; absent env → undefined', async () => {
    delete process.env.DU_VAULT_KV_OPTIONS;
    delete process.env.DU_VAULT_KV_TOKEN;
    delete process.env.DU_CONNECTOR_INITIAL_BINDINGS;

    const off = await createApp({
      port: 0,
      databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_cw2',
      redisUrl: 'redis://127.0.0.1:1',
      adminToken: 'cw2-admin',
      autoDispatch: false,
      autoMigrate: false,
      connectorBaseUrls: { c1: 'http://connector.test' },
    });
    apps.push(off);
    expect(off.credentialWorkflow).toBeUndefined();

    process.env.DU_VAULT_KV_OPTIONS = JSON.stringify({ vaultAddress: 'http://vault.test:8200' });
    process.env.DU_VAULT_KV_TOKEN = 'writer-token';
    process.env.DU_CONNECTOR_INITIAL_BINDINGS = JSON.stringify({ c1: { tenantId: 't1', accountId: 'a1' } });

    const on = await createApp({
      port: 0,
      databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_cw3',
      redisUrl: 'redis://127.0.0.1:1',
      adminToken: 'cw2-admin',
      autoDispatch: false,
      autoMigrate: false,
      connectorBaseUrls: { c1: 'http://connector.test' },
      connectorManagementAuthorizationForRequest: createConnectorManagementAuthorizationProvider(Buffer.alloc(32, 0x41)),
    });
    apps.push(on);
    expect(on.credentialWorkflow).toBeDefined();
  });

  it('precedence: an injected config.credentialWorkflow wins over a COMPLETE env', async () => {
    process.env.DU_VAULT_KV_OPTIONS = JSON.stringify({ vaultAddress: 'http://vault.test:8200' });
    process.env.DU_VAULT_KV_TOKEN = 'writer-token';
    process.env.DU_CONNECTOR_INITIAL_BINDINGS = JSON.stringify({ c1: { tenantId: 't1', accountId: 'a1' } });

    // The env is complete AND connectorBaseUrls is present, so env composition
    // WOULD succeed on its own - the injected config must still win
    // (create-app.ts:438: `let credentialWorkflow = config.credentialWorkflow`).
    const injected = { marker: 'injected-config-wins' };
    const app = await createApp({
      port: 0,
      databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_cw4',
      redisUrl: 'redis://127.0.0.1:1',
      adminToken: 'cw4-admin',
      autoDispatch: false,
      autoMigrate: false,
      connectorBaseUrls: { c1: 'http://connector.test' },
      credentialWorkflow: injected as never,
    });
    apps.push(app);
    expect(app.credentialWorkflow).toBe(injected);
  });
});
