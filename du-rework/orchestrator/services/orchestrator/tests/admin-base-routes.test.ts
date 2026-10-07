import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const ADMIN_TOKEN = 'adm-test-token-' + randomUUID();
const RUNTIME_TOKEN = 'adm-rt-token-' + randomUUID();
const TEST_TENANT = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TEST_BIZ = 'biz-' + randomUUID().slice(0, 8);
const TEST_KEY_ID = randomUUID();

let app: App;
let baseUrl: string;

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('admin-base-routes.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    adminToken: ADMIN_TOKEN,
    runtimeToken: RUNTIME_TOKEN,
    connectorBaseUrls: {
      'test-connector': 'http://127.0.0.1:8099',
    },
    autoDispatch: false,
    autoMigrate: true,
  });

  const srv = await app.listen();
  const addr = srv.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Seed tenant
  await app.db.query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'Admin Test Tenant') ON CONFLICT (id) DO NOTHING`,
    [TEST_TENANT]
  );

  // Seed business version
  await app.db.query(
    `INSERT INTO business_versions (business_id, version, status, is_active, digest, queue, manifest)
     VALUES ($1, '1.0.0', 'ENABLED', true, 'sha256-test', 'queue-test', $2)`,
    [
      TEST_BIZ,
      JSON.stringify({
        businessId: TEST_BIZ,
        version: '1.0.0',
        actions: [{ name: 'extract', schema: {} }],
      }),
    ]
  );

  // Seed active API key
  await app.db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ($1, $2, $3, 'du_adm', 'ACTIVE')
     ON CONFLICT (hash) DO NOTHING`,
    [TEST_KEY_ID, TEST_TENANT, 'hash-' + TEST_KEY_ID]
  );

  // Seed profile binding
  await app.db.query(
    `INSERT INTO profile_bindings (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action)
     VALUES ($1, 1, $2, $3, $4, '1.0.0', 'extract')
     ON CONFLICT DO NOTHING`,
    [randomUUID(), TEST_TENANT, TEST_KEY_ID, TEST_BIZ]
  );
});

afterAll(async () => {
  if (app) {
    await app.db.query(`DELETE FROM profile_bindings WHERE api_key_id = $1`, [TEST_KEY_ID]).catch(() => {});
    await app.db.query(`DELETE FROM api_keys WHERE id = $1`, [TEST_KEY_ID]).catch(() => {});
    await app.db.query(`DELETE FROM business_versions WHERE business_id = $1`, [TEST_BIZ]).catch(() => {});
    await app.db.query(`DELETE FROM tenants WHERE id = $1`, [TEST_TENANT]).catch(() => {});
    await app.close();
  }
});

function adminHeaders(): Record<string, string> {
  return {
    authorization: `Bearer ${ADMIN_TOKEN}`,
    'content-type': 'application/json',
  };
}

describe('ADM-BASE-01: 6 Admin GET routes over real HTTP', () => {
  it('enforces admin auth fence (401 on missing or invalid bearer token)', async () => {
    const resNoAuth = await fetch(`${baseUrl}/api/v1/admin/businesses`);
    expect(resNoAuth.status).toBe(401);

    const resBadAuth = await fetch(`${baseUrl}/api/v1/admin/businesses`, {
      headers: { authorization: 'Bearer invalid-token' },
    });
    expect(resBadAuth.status).toBe(401);
  });

  it('1. GET /api/v1/admin/businesses returns real registered businesses array', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/businesses`, { headers: adminHeaders() });
    expect(res.status).toBe(200);
    const rawBody = (await res.json()) as
      | Array<{
          businessId: string;
          version: string;
          activeVersion: string | null;
          status: string;
          isActive: boolean;
          registeredAt: string;
        }>
      | {
          items?: Array<{
            businessId: string;
            version: string;
            activeVersion: string | null;
            status: string;
            isActive: boolean;
            registeredAt: string;
          }>;
        };
    const body = Array.isArray(rawBody) ? rawBody : (rawBody.items ?? []);
    expect(Array.isArray(body)).toBe(true);
    const found = body.find((b) => b.businessId === TEST_BIZ);
    expect(found).toBeDefined();
    expect(found!.version).toBe('1.0.0');
    expect(found!.activeVersion).toBe('1.0.0');
    expect(found!.status).toBe('ENABLED');
    expect(found!.isActive).toBe(true);
    expect(found!.registeredAt).toBeDefined();
  });

  it('2. GET /api/v1/admin/businesses/:id/versions returns real version history or 404', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/businesses/${TEST_BIZ}/versions`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      businessId: string;
      activeVersion: string | null;
      rows: Array<{ version: string; status: string; isActive: boolean }>;
    };
    expect(body.businessId).toBe(TEST_BIZ);
    expect(body.activeVersion).toBe('1.0.0');
    expect(body.rows.length).toBeGreaterThanOrEqual(1);
    expect(body.rows[0]!.version).toBe('1.0.0');
    expect(body.rows[0]!.status).toBe('ENABLED');

    const notFound = await fetch(`${baseUrl}/api/v1/admin/businesses/unknown-biz-999/versions`, {
      headers: adminHeaders(),
    });
    expect(notFound.status).toBe(404);
  });

  it('3. GET /api/v1/admin/profiles/:b/:v/:name returns real manifest-backed profile wire', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/profiles/${TEST_BIZ}/1.0.0/default`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      businessId: string;
      businessVersion: string;
      profileName: string;
      revision: number;
      manifest: { actions: Array<{ name: string }> };
      capabilities: unknown[];
    };
    expect(body.businessId).toBe(TEST_BIZ);
    expect(body.businessVersion).toBe('1.0.0');
    expect(body.profileName).toBe('default');
    expect(body.revision).toBe(0);
    expect(body.manifest.actions).toHaveLength(1);
    expect(body.manifest.actions[0]!.name).toBe('extract');
    expect(Array.isArray(body.capabilities)).toBe(true);

    // latest sentinel
    const resLatest = await fetch(`${baseUrl}/api/v1/admin/profiles/${TEST_BIZ}/latest/default`, {
      headers: adminHeaders(),
    });
    expect(resLatest.status).toBe(200);

    // 404 for unknown business
    const res404 = await fetch(`${baseUrl}/api/v1/admin/profiles/unknown-biz/latest/default`, {
      headers: adminHeaders(),
    });
    expect(res404.status).toBe(404);
  });

  it('4. GET /api/v1/admin/connectors/:id/revisions/:rev returns configured connector envelope', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/connectors/test-connector/revisions/1`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      connectorId: string;
      revision: number;
      adapter: string;
      endpoint: { kind: string; maskedHost: string };
      secretSlots: unknown[];
      state: string;
    };
    expect(body.connectorId).toBe('test-connector');
    expect(body.revision).toBe(1);
    expect(body.endpoint.kind).toBe('configured');
    expect(Array.isArray(body.secretSlots)).toBe(true);
    expect(body.secretSlots).toHaveLength(0); // Secret never exposed

    // Unknown connector 404
    const res404 = await fetch(`${baseUrl}/api/v1/admin/connectors/unknown-connector/revisions/1`, {
      headers: adminHeaders(),
    });
    expect(res404.status).toBe(404);
  });

  it('5. GET /api/v1/admin/api-keys (+ /:keyId) returns real keys and grants without secret leak', async () => {
    // W-ADMIN-APIKEY-TENANT-SCOPE-1 (T-CODEX-TEST-30 live red): the list route is
    // tenant-scoped SQL-side (W-ADMUX02-EXT-1). authorizeAuditTenantRead echoes the
    // platform bearer's requested tenant verbatim, so WITHOUT ?tenantId= the scope is
    // '' -> buildApiKeyPage(ctx, keysPrincipal, [], query) -> honest empty page, never
    // a cross-tenant dump. The seeded key only surfaces when its tenant is named.
    const resList = await fetch(`${baseUrl}/api/v1/admin/api-keys?tenantId=${TEST_TENANT}`, {
      headers: adminHeaders(),
    });
    expect(resList.status).toBe(200);
    // W-ADMIN-APIKEY-ALIGN-1 (T-CODEX-TEST-29 live red): buildApiKeyPage now spreads
    // listPage, so the wire key is `items` ({ rows } is gone). The `?? rows` fallback
    // keeps the read honest against an older build mid-rollout, mirroring the shell
    // fetcher's tolerance for the legacy shape.
    const bodyList = (await resList.json()) as {
      items?: Array<{ id: string; tenantId: string; prefix: string; maskedHint: string; status: string }>;
      rows?: Array<{ id: string; tenantId: string; prefix: string; maskedHint: string; status: string }>;
      grants: Array<{ apiKeyId?: string; businessId: string; businessVersion: string; action: string }>;
      createCopyOnce: unknown;
    };
    const keyItems = bodyList.items ?? bodyList.rows ?? [];
    expect(Array.isArray(keyItems)).toBe(true);
    const foundKey = keyItems.find((k) => k.id === TEST_KEY_ID);
    expect(foundKey).toBeDefined();
    expect(foundKey!.prefix).toBe('du_adm');
    expect(foundKey!.status).toBe('ACTIVE');
    expect((foundKey as Record<string, unknown>).hash).toBeUndefined(); // Raw secret NEVER leaked
    expect(bodyList.createCopyOnce).toBeNull();

    // Empty-scope probe (packet step 1, optional leg): a scoped list request must ALSO
    // be proven empty when the tenant is not named — pins the fail-closed default.
    const resNoScope = await fetch(`${baseUrl}/api/v1/admin/api-keys`, { headers: adminHeaders() });
    expect(resNoScope.status).toBe(200);
    const emptyBody = (await resNoScope.json()) as typeof bodyList;
    expect(emptyBody.items ?? []).toEqual([]);

    // Specific keyId
    const resItem = await fetch(`${baseUrl}/api/v1/admin/api-keys/${TEST_KEY_ID}`, {
      headers: adminHeaders(),
    });
    expect(resItem.status).toBe(200);
    const bodyItem = (await resItem.json()) as typeof bodyList;
    const itemRows = bodyItem.items ?? bodyItem.rows ?? [];
    expect(itemRows).toHaveLength(1);
    expect(itemRows[0]!.id).toBe(TEST_KEY_ID);
    expect(bodyItem.grants.length).toBeGreaterThanOrEqual(1);
    expect(bodyItem.grants[0]!.businessId).toBe(TEST_BIZ);
    expect(bodyItem.grants[0]!.action).toBe('extract');

    // Unknown keyId 404
    const res404 = await fetch(`${baseUrl}/api/v1/admin/api-keys/${randomUUID()}`, {
      headers: adminHeaders(),
    });
    expect(res404.status).toBe(404);
  });

  it('6. GET /api/v1/admin/audit returns valid tenant audit event envelope', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/audit?tenantId=${TEST_TENANT}&limit=50`, {
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    // W-ADMIN-BASE-AUDIT-ALIGN-1 (Δ12, same class as T130-A1): the route answers the
    // standard five-field page envelope { items, nextCursor, prevCursor, total, limit }
    // (W-ADMUX02-EXT-1); the { tenantId, events } echo is gone. The tenant fence stays
    // proven per-item: every returned item must belong to TEST_TENANT.
    const body = (await res.json()) as {
      items: Array<{ tenantId: string }>;
      nextCursor: string | null;
      prevCursor: string | null;
      total: number;
      limit: number;
    };
    expect(Array.isArray(body.items)).toBe(true);
    for (const e of body.items) expect(e.tenantId).toBe(TEST_TENANT);
    expect(body.limit).toBeGreaterThanOrEqual(1);
    expect(body.total).toBeGreaterThanOrEqual(0);
  });
});
});
