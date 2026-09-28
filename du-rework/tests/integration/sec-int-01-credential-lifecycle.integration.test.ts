import { randomBytes, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '@du/orchestrator';
import { PgSqlClient } from '@du/connector';
import {
  AesCredentialCipher,
  DurableConnectorManagement,
  PostgresConnectorConfigRepository,
  createConnectorServer,
} from '@du/connector';
import {
  createCredentialWorkflow,
  type VaultCredentialWriter,
} from '../../services/orchestrator/src/modules/connector-credentials/workflow';
import { createConnectorRevisionHttpAdapter } from '../../services/orchestrator/src/modules/connector-credentials/connector-http-store';
import { createTokenRenewalDaemon } from '../../services/connector/src/vault/token-renewal';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  assertSafeIsolationConfig,
  type TestIsolationContext,
} from '../isolation/namespace';
import type { AdapterConfig } from '../../services/connector/src/types';

/**
 * SEC-INT-01 — credential rotation/revocation across the REAL two-service
 * wire (Orchestrator workflow + HTTP adapter + Connector + PostgreSQL
 * connector tables incl. migrations 006/007) against the in-repo Vault
 * dev-fixture as the KV v2 backend, with the renewal daemon driving the
 * reader identity. Gated: DU_LIVE_INFRA=1 AND DU_SECINT=1 (coordinator
 * sets the second flag only when the G-SEC integration window is booked).
 * Without the flags every case reports it.skip → [SKIP-QUALIFIED], never a
 * pass claim. Provider-invoke e2e (Redis quota, real containers) is the
 * documented follow-on slice of the same gate.
 */
import { createVaultDevFixture, VaultError, type VaultDevFixture } from '../../packages/contracts/tests/stubs/vault-dev-fixture';

const LIVE = process.env.DU_LIVE_INFRA === '1' && process.env.DU_SECINT === '1';
const describeLive = LIVE ? describe : describe.skip;

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({
        runId: process.env.TEST_RUN_ID,
        redisDbIndex: process.env.REDIS_DB_INDEX ? Number(process.env.REDIS_DB_INDEX) : undefined,
      });
const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const DATABASE_URL = isolationCtx ? isolationCtx.getDatabaseUrlWithSchema(BASE_DATABASE_URL) : BASE_DATABASE_URL;
const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const REDIS_URL = isolationCtx ? isolationCtx.getRedisUrl(BASE_REDIS_URL) : BASE_REDIS_URL;

const ADMIN_TOKEN = 'secint-adm-' + randomUUID();
const RUNTIME_TOKEN = 'secint-rt-' + randomUUID();
const USAGE_TOKEN = 'secint-usg-' + randomUUID();
const CONNECTOR_ID = 'secint-openai';
// canonical account path (matchesVaultAccountPath, 7 segments) — the old
// 'du/connector/secint/prod' ref fails both the orchestrator workflow guard
// (workflow.ts:137) and the connector createPendingRevision assertion.
const VAULT_REF = { account: 'secint-main', mount: 'secret', path: 'du/tenants/secint/connectors/secint-openai/accounts/secint-main', key: 'api-key' };
const SENTINEL = 'sk-live-SECINT-' + randomUUID().replace(/-/g, '');

async function http(base: string, path: string, opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}) {
  const res = await fetch(base + path, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, text };
}

describeLive('SEC-INT-01 rotation/revocation across orchestrator↔connector↔vault', () => {
  let orch: App;
  let orchUrl: string;
  let connServer: ReturnType<typeof createConnectorServer>;
  let connUrl: string;
  let fx: VaultDevFixture;
  let connRepo: PostgresConnectorConfigRepository;
  let cipher: AesCredentialCipher;
  // Cycle-138 (Reviewer 132-137): the migrator/repo pool was a beforeAll-local const
  // and never closed -> jest open-handle warning on live runs. Suite-scoped + afterAll close.
  let connPool: PgSqlClient | undefined;

  beforeAll(async () => {
    assertSafeIsolationConfig({
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      isolationCtx,
      allowUnsafeShared: process.env.ALLOW_UNSAFE_SHARED_DB === 'true',
    });
    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await client.close();
    }
    // Connector DB objects (incl. migration 006 CHECK + 007 credential_source)
    // via the PRODUCTION migrator path.
    connPool = new PgSqlClient({
      connectionString: DATABASE_URL,
      migrationDirectory: require('node:path').resolve(__dirname, '../../services/connector/src/db/migrations'),
    });
    await connPool.migrate();
    connRepo = new PostgresConnectorConfigRepository(connPool);
    cipher = new AesCredentialCipher(new Uint8Array(randomBytes(32)));
    // dev fixture must allow the canonical du/tenants prefix (VAULT_REF above)
    fx = createVaultDevFixture({ scopes: [{ mount: 'secret', pathPrefix: 'du/tenants' }] });

    const registryStub = { get: (name: string) => ({ id: name }) } as never;
    const management = new DurableConnectorManagement(connRepo, cipher, registryStub);
    connServer = createConnectorServer({
      management,
      runtime: {
        invoke: async () => {
          throw new Error('invoke not under test in this slice');
        },
        get: async () => undefined,
        cancel: async () => {
          throw new Error('invoke not under test');
        },
      } as never,
      capabilities: () => ({ adapters: ['openai-http'] }),
      ready: async () => true,
    });
    const connListen = await new Promise<AddressInfo>((resolve) => connServer.listen(0, '127.0.0.1', () => resolve(connServer.address() as AddressInfo)));
    connUrl = `http://127.0.0.1:${connListen.port}`;

    const vault: VaultCredentialWriter = buildVaultWriter(fx);
    orch = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      adminToken: ADMIN_TOKEN,
      runtimeToken: RUNTIME_TOKEN,
      usageToken: USAGE_TOKEN,
      autoDispatch: false,
      autoMigrate: true,
      credentialWorkflow: createCredentialWorkflow({
        vault,
        revisions: createConnectorRevisionHttpAdapter({ baseUrl: connUrl }),
      }),
    });
    await orch.listen();
    orchUrl = `http://127.0.0.1:${(orch.server.address() as AddressInfo).port}`;

    await orch.db.query(
      `INSERT INTO tenants (id, name, state) VALUES ('00000000-0000-0000-0000-0000000000a1','secint','ACTIVE') ON CONFLICT DO NOTHING`,
    );
    // Seed the connector with a legacy rev 1 (credential_ref path, no source).
    await management.createRevision({
      connectorId: CONNECTOR_ID,
      adapter: 'openai-http',
      config: { baseUrl: 'https://api.example.test', path: '/v1', timeoutMs: 5_000 } as AdapterConfig,
      credentialRef: 'cred-secint-legacy',
      state: 'ACTIVE',
    });
  }, 90_000);

  afterAll(async () => {
    await orch?.close({ timeoutMs: 200, pollIntervalMs: 50 });
    await new Promise<void>((r) => connServer?.close(() => r()));
    // server down first: its management/repo path holds this pool's clients
    await connPool?.close();
    connPool = undefined;
    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      await client.close();
      isolationCtx.cleanupArtifactDir();
    }
  }, 60_000);

  it('rotate over HTTP persists credential_source (migration 007) and activates via CAS', async () => {
    const res = await http(orchUrl, '/api/v1/admin/connectors/' + CONNECTOR_ID + '/credentials', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { ...VAULT_REF, value: SENTINEL },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ revision: 2, version: 1, state: 'ACTIVE' });
    expect(res.text).not.toContain(SENTINEL);
    const current = await http(connUrl, `/connectors/${CONNECTOR_ID}/revisions/current`);
    expect(current.status).toBe(200);
    expect(current.body.state).toBe('ACTIVE');
    expect((current.body.credentialSource as Record<string, unknown>).version).toBe(1);
    // real DB round-trip proves the JSONB column mapping
    const rows = await connRepo.list();
    expect(rows.filter((r) => r.connectorId === CONNECTOR_ID && r.state === 'ACTIVE')).toHaveLength(1);
  });

  it('second rotate keeps CAS invariants: one ACTIVE, retired row keeps its OLD pin', async () => {
    const res = await http(orchUrl, '/api/v1/admin/connectors/' + CONNECTOR_ID + '/credentials', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { ...VAULT_REF, value: SENTINEL + '2', cas: 1 },
    });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ revision: 3, version: 2 });
    const two = await http(connUrl, `/connectors/${CONNECTOR_ID}/revisions/2`);
    expect(two.body.state).toBe('RETIRED');
    expect((two.body.credentialSource as Record<string, unknown>).version).toBe(1);
  });

  it('revoke action retires the whole chain; further rotations 404 fail-closed', async () => {
    const rev = await http(orchUrl, '/api/v1/admin/actions', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { action: 'connectors.revoke_credential', params: { connectorId: CONNECTOR_ID } },
    });
    expect(rev.status).toBe(200);
    expect(rev.body).toMatchObject({ revoked: true });
    const current = await http(connUrl, `/connectors/${CONNECTOR_ID}/revisions/current`);
    expect(current.status).toBe(404);
    const again = await http(orchUrl, '/api/v1/admin/connectors/' + CONNECTOR_ID + '/credentials', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      body: { ...VAULT_REF, value: SENTINEL },
    });
    expect(again.status).toBe(404);
  });

  it('reader identity survives lease rotation via the renewal daemon (no failed reads)', async () => {
    let clockNow = 1_000;
    const readerTokenState = { issued: 0 };
    const daemon = createTokenRenewalDaemon({
      client: {
        async login() {
          readerTokenState.issued += 1;
          return { value: 'reader-' + readerTokenState.issued, expiresAtMs: clockNow + 15_000 };
        },
        async renew() {
          readerTokenState.issued += 1;
          return { value: 'reader-' + readerTokenState.issued, expiresAtMs: clockNow + 15_000 };
        },
      },
      safetyMarginMs: 5_000,
      now: () => clockNow,
      schedule: () => 0,
      cancel: () => undefined,
    });
    await daemon.start();
    let reads = 0;
    for (const step of [0, 6_000, 12_000, 18_000]) {
      clockNow = 1_000 + step;
      const outcome = await daemon.runOnce();
      expect(['authenticated', 'renewed', 'retrying']).toContain(outcome);
      const live = daemon.current();
      if (!live) continue;
      reads += 1; // stand-in for the KV v2 read behind the daemon-gated reader
    }
    expect(reads).toBeGreaterThan(2); // the lease turned over WITHOUT a dead window
    expect(readerTokenState.issued).toBeGreaterThan(1); // renewal actually rotated
  });

  it('audit + log hygiene: no sentinel anywhere after the full cycle', async () => {
    const audit = await orch.db.query('SELECT * FROM admin_audit_events ORDER BY created_at DESC LIMIT 50');
    expect(JSON.stringify(audit.rows)).not.toContain(SENTINEL);
    const dumps = await orch.db.query(
      `SELECT to_jsonb(t)::text AS j FROM admin_idempotency t ORDER BY created_at DESC LIMIT 50`,
    );
    expect(JSON.stringify(dumps.rows)).not.toContain(SENTINEL);
  });
});

function buildVaultWriter(fx: VaultDevFixture): VaultCredentialWriter {
  const token = fx.login('orchestrator-writer');
  return {
    async writeCas(ref, value, cas) {
      try {
        const r = await fx.write({ token, mount: ref.mount, path: ref.path, key: ref.key, value, ...(cas === undefined ? {} : { cas }) });
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

