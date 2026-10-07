import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server';

/**
 * W48-C1 (ADM-BASE-01 + ADM-UX-04): the admin audit ledger is REAL.
 *
 *  1. An admin mutation (profile-binding grant) produces a REAL audit row —
 *     readable back via GET /api/v1/admin/audit (no placeholder rows).
 *  2. Tenant A cannot read tenant B's events (tenant predicate enforced).
 *  3. The `limit` parameter is respected (previously parsed then `void`ed).
 *
 * Fixture policy mirrors admin-base-routes.test.ts: seeds use this suite's
 * own tenant/business ids, and afterAll deletes only rows this suite owns.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const ADMIN_TOKEN = 'w48c1-adm-token-' + randomUUID();
const RUNTIME_TOKEN = 'w48c1-rt-token-' + randomUUID();
const TENANT_A = 'c1aec1ae-1111-4111-8111-c1aec1aec1ae';
const TENANT_B = 'd2bed2be-2222-4222-8222-d2bed2bed2be';
const TEST_BIZ = 'biz-' + randomUUID().slice(0, 8);

// R3-02: tenant-scoped admin bearers (config tenantAdminTokens). These
// authorize ONLY the audit read for their bound tenant — never mutations,
// never another tenant.
const OP_TOKEN_A = 'w48c1-op-a-' + randomUUID();
const OP_TOKEN_B = 'w48c1-op-b-' + randomUUID();

const RAW_KEY_A = 'du_w48c1_a_' + randomUUID().replace(/-/g, '');
const RAW_KEY_B = 'du_w48c1_b_' + randomUUID().replace(/-/g, '');
const KEY_ID_A = randomUUID();
const KEY_ID_B = randomUUID();

let app: App;
let baseUrl: string;

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function adminHeaders(): Record<string, string> {
  return { authorization: `Bearer ${ADMIN_TOKEN}`, 'content-type': 'application/json' };
}

function opHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('admin-audit.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    adminToken: ADMIN_TOKEN,
    runtimeToken: RUNTIME_TOKEN,
    tenantAdminTokens: { [OP_TOKEN_A]: TENANT_A, [OP_TOKEN_B]: TENANT_B },
    connectorBaseUrls: {},
    autoDispatch: false,
    autoMigrate: true,
  });

  const srv = await app.listen();
  const addr = srv.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${addr.port}`;

  // Seed two tenants.
  await app.db.query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'W48C1 Tenant A'), ($2, 'W48C1 Tenant B')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B]
  );

  // Seed one business version (mutation write-paths reference it).
  await app.db.query(
    `INSERT INTO business_versions (business_id, version, status, is_active, digest, queue, manifest)
     VALUES ($1, '1.0.0', 'ENABLED', true, 'sha256-w48c1', 'queue-w48c1', $2)`,
    [
      TEST_BIZ,
      JSON.stringify({
        businessId: TEST_BIZ,
        version: '1.0.0',
        actions: [{ name: 'extract', schema: {} }],
      }),
    ]
  );

  // Seed one ACTIVE api key per tenant. The stored hash MUST equal
  // hashKey(raw) — POST /api/v1/admin/profile-bindings hashes the presented
  // raw key with the same function, then looks up hash+ACTIVE.
  await app.db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ($1, $2, $3, 'du_w48', 'ACTIVE'), ($4, $5, $6, 'du_w48', 'ACTIVE')
     ON CONFLICT (id) DO NOTHING`,
    [KEY_ID_A, TENANT_A, hashKey(RAW_KEY_A), KEY_ID_B, TENANT_B, hashKey(RAW_KEY_B)]
  );
});

afterAll(async () => {
  if (app) {
    await app.db.query(`DELETE FROM admin_audit_events WHERE resource LIKE $1`, [`%${TEST_BIZ}%`]).catch(() => {});
    await app.db.query(`DELETE FROM admin_audit_events WHERE resource IN ($1, $2)`, [
      `apikey:${KEY_ID_A}`,
      `apikey:${KEY_ID_B}`,
    ]).catch(() => {});
    await app.db.query(`DELETE FROM profile_bindings WHERE api_key_id IN ($1, $2)`, [KEY_ID_A, KEY_ID_B]).catch(() => {});
    await app.db.query(`DELETE FROM api_keys WHERE id IN ($1, $2)`, [KEY_ID_A, KEY_ID_B]).catch(() => {});
    await app.db.query(`DELETE FROM business_versions WHERE business_id = $1`, [TEST_BIZ]).catch(() => {});
    await app.db.query(`DELETE FROM tenants WHERE id IN ($1, $2)`, [TENANT_A, TENANT_B]).catch(() => {});
    await app.close();
  }
});

interface AuditWireEvent {
  id: string;
  kind: string;
  severity: string;
  occurredAt: string;
  tenantId: string | null;
  resourceId: string;
  actor: string;
  message: string;
}

interface AuditEnvelope {
  items: AuditWireEvent[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  limit: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function postBinding(rawKey: string): Promise<unknown> {
  const payload = JSON.stringify({
    apiKey: rawKey,
    businessId: TEST_BIZ,
    businessVersion: '1.0.0',
    action: 'extract',
    connectorBindings: {},
  });
  // Windows stability: back-to-back runs can hit TIME_WAIT / listen-backlog
  // socket errors (ETIMEDOUT/ECONNREFUSED) against the freshly-bound test
  // server. Retry the fetch itself a few times with a 500ms settle delay.
  // Network-level throws only — the 201 status assertion below stays strict
  // so real failures are never masked.
  let res: Awaited<ReturnType<typeof fetch>> | undefined;
  let lastErr: unknown;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      res = await fetch(`${baseUrl}/api/v1/admin/profile-bindings`, {
        method: 'POST',
        headers: adminHeaders(),
        body: payload,
      });
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < 3) await sleep(500);
    }
  }
  if (!res) throw lastErr;
  expect(res.status).toBe(201);
  return res.json();
}

async function getAudit(tenantId: string, limit?: number): Promise<AuditEnvelope> {
  const qs = limit === undefined ? `tenantId=${tenantId}` : `tenantId=${tenantId}&limit=${limit}`;
  const res = await fetch(`${baseUrl}/api/v1/admin/audit?${qs}`, { headers: adminHeaders() });
  expect(res.status).toBe(200);
  return (await res.json()) as AuditEnvelope;
}

describe('W48-C1: real admin audit ledger', () => {
  it('1. an admin mutation produces a REAL audit row (no placeholder, no empty list)', async () => {
    await postBinding(RAW_KEY_A);

    const body = await getAudit(TENANT_A);
    // T130-A1: the route answers the standard five-field page envelope
    // (W-ADMUX02-EXT-1). The old { tenantId, events } echo is gone, so the
    // tenant fence is now proven per item instead of via an envelope field.
    expect(Array.isArray(body.items)).toBe(true);
    expect(body.items.length).toBeGreaterThan(0);
    for (const e of body.items) expect(e.tenantId).toBe(TENANT_A);

    const row = body.items.find((e) => e.resourceId === `apikey:${KEY_ID_A}`);
    expect(row).toBeDefined();
    // Real ledger fields — never placeholders.
    expect(row!.id).toBeTruthy();
    // REVIEWER 6/6 item 1 (event taxonomy): the grant is a profile BIND, not a
    // key issuance — `apikey.create` rendered the false UI label "API key created".
    expect(row!.kind).toBe('profile_binding.bind');
    expect(row!.severity).toBe('info');
    expect(row!.occurredAt).toBeTruthy();
    expect(row!.tenantId).toBe(TENANT_A);
    expect(row!.actor).toBe('admin');
    // The raw credential NEVER touches the ledger.
    expect(JSON.stringify(row)).not.toContain(RAW_KEY_A);

    // Cross-check straight against the ledger table.
    const direct = await app.db.query<{ id: string; action: string; resource: string }>(
      `SELECT id, action, resource FROM admin_audit_events WHERE resource = $1`,
      [`apikey:${KEY_ID_A}`]
    );
    expect(direct.rowCount).toBeGreaterThanOrEqual(1);
    expect(direct.rows[0]!.action).toBe('profile_binding.bind');
  });

  it('2. tenant A cannot read tenant B events (tenant predicate, not just client filter)', async () => {
    await postBinding(RAW_KEY_B);

    const aBody = await getAudit(TENANT_A);
    const bBody = await getAudit(TENANT_B);

    // B's grant event is visible to B.
    expect(bBody.items.some((e) => e.resourceId === `apikey:${KEY_ID_B}`)).toBe(true);
    // B's grant event is NOT visible to A, and vice versa.
    expect(aBody.items.some((e) => e.resourceId === `apikey:${KEY_ID_B}`)).toBe(false);
    expect(bBody.items.some((e) => e.resourceId === `apikey:${KEY_ID_A}`)).toBe(false);
    // Every row A sees is attributed to A (server-side predicate, so the
    // overview renderer cross-tenant filter is a second fence, not the only one).
    for (const e of aBody.items) expect(e.tenantId).toBe(TENANT_A);
  });

  it('3. limit is respected (previously parsed then discarded via `void limit`)', async () => {
    // Create several more tenant-A events so the cap has something to cut.
    await postBinding(RAW_KEY_A);
    await postBinding(RAW_KEY_A);
    await postBinding(RAW_KEY_A);

    const full = await getAudit(TENANT_A);
    expect(full.items.length).toBeGreaterThanOrEqual(3);

    const capped = await getAudit(TENANT_A, 2);
    expect(capped.items.length).toBeLessThanOrEqual(2);
    expect(capped.items.length).toBeGreaterThan(0);
    // total counts the whole filtered population, not the capped window
    // (keysetPage runs a separate count) - the cap trims items, never truth.
    expect(capped.total).toBeGreaterThanOrEqual(full.items.length);

    const one = await getAudit(TENANT_A, 1);
    expect(one.items).toHaveLength(1);
    // Newest-first ordering preserved under the cap.
    expect(one.items[0]!.id).toBe(full.items[0]!.id);
  });
});

/**
 * R3-01 (route level, REAL Postgres): the mutation and the audit INSERT
 * commit as ONE transaction. A plpgsql BEFORE INSERT trigger on
 * admin_audit_events raises for exactly this suite's marker resource —
 * the closest honest analog of an audit-store outage. Pre-fix, the
 * business.enable UPDATE had already committed independently, so the
 * request failed AND the mutation leaked with no ledger row. Now the
 * pg exception must roll the UPDATE back too.
 */
describe('R3-01: audit-INSERT fault injection rolls the mutation back', () => {
  const INJ_VERSION = '9.9.9';
  const INJ_RESOURCE = `business:${TEST_BIZ}@${INJ_VERSION}`;

  async function seedDisabledVersion(): Promise<void> {
    await app.db.query('DELETE FROM business_versions WHERE business_id = $1 AND version = $2', [TEST_BIZ, INJ_VERSION]);
    await app.db.query(
      `INSERT INTO business_versions (business_id, version, status, is_active, digest, queue, manifest)
       VALUES ($1, $2, 'REGISTERED_DISABLED', false, 'sha256-r3-01', 'queue-r3-01', $3)`,
      [TEST_BIZ, INJ_VERSION, JSON.stringify({ businessId: TEST_BIZ, version: INJ_VERSION, actions: [{ name: 'extract', schema: {} }] })]
    );
  }

  async function readStatus(): Promise<string> {
    const res = await app.db.query<{ status: string }>(
      'SELECT status FROM business_versions WHERE business_id=$1 AND version=$2',
      [TEST_BIZ, INJ_VERSION]
    );
    return res.rows[0]!.status;
  }

  async function ledgerCount(): Promise<number> {
    const res = await app.db.query('SELECT 1 FROM admin_audit_events WHERE resource = $1', [INJ_RESOURCE]);
    return res.rowCount ?? 0;
  }

  async function putEnable(): Promise<Response> {
    return fetch(`${baseUrl}/api/v1/admin/businesses/${TEST_BIZ}/versions/${INJ_VERSION}/enable`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
  }

  it('injected audit outage → 500 (sanitized), status unchanged, NO ledger row', async () => {
    await seedDisabledVersion();
    await app.db.query(`
      CREATE OR REPLACE FUNCTION du_r301_audit_boom() RETURNS trigger AS \$\$
        BEGIN
          IF NEW.action = 'business.enable' AND NEW.resource = '${INJ_RESOURCE}' THEN
            RAISE EXCEPTION 'injected audit outage';
          END IF;
          RETURN NEW;
        END
      \$\$ LANGUAGE plpgsql`);
    await app.db.query(
      'CREATE TRIGGER du_r301_audit_boom_tr BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION du_r301_audit_boom()'
    );
    try {
      const res = await putEnable();
      expect(res.status).toBe(500);
      const body = (await res.json()) as { code?: string };
      // ADM-BASE-03 error boundary: the pg exception never reaches the wire —
      // no SQL fragments, no table names, generic problem+json only.
      expect(body.code).toBe('TEMPORARY_UNAVAILABLE');
      expect(JSON.stringify(body)).not.toMatch(/admin_audit_events|business_versions|INSERT|plpgsql/i);
      // THE R3-01 ASSERTION: the mutation did not survive its audit failure.
      expect(await readStatus()).toBe('REGISTERED_DISABLED');
      expect(await ledgerCount()).toBe(0);
    } finally {
      await app.db.query('DROP TRIGGER IF EXISTS du_r301_audit_boom_tr ON admin_audit_events');
      await app.db.query('DROP FUNCTION IF EXISTS du_r301_audit_boom()');
    }
  });

  it('same enable succeeds once the ledger is healthy — mutation + row commit together', async () => {
    const res = await putEnable();
    expect(res.status).toBe(200);
    expect(await readStatus()).toBe('ENABLED');
    const rows = await app.db.query<{ tenant_id: string | null }>(
      'SELECT tenant_id FROM admin_audit_events WHERE resource = $1',
      [`business:${TEST_BIZ}@${INJ_VERSION}`]
    );
    expect(rows.rowCount).toBe(1);
    expect(rows.rows[0]!.tenant_id).toBeNull(); // platform-global, as documented
  });
});

/**
 * R3-02 (route level): the requested tenantId is AUTHORIZED against the
 * authenticated principal. The platform bearer keeps the operator-console
 * view; a tenant-scoped bearer reads exactly its own tenant and every
 * other admin route stays closed to it.
 */
describe('R3-02: tenant scope authorized from the principal, not the query', () => {
  it('platform bearer still reads any tenant (regression of the operator view)', async () => {
    const a = await getAudit(TENANT_A);
    const b = await getAudit(TENANT_B);
    expect(a.items.length).toBeGreaterThan(0);
    expect(b.items.length).toBeGreaterThan(0);
    for (const e of a.items) expect(e.tenantId).toBe(TENANT_A);
    for (const e of b.items) expect(e.tenantId).toBe(TENANT_B);
  });

  it('tenant-operator(A) bearer reads tenant A, only A rows', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/audit?tenantId=${TENANT_A}`, { headers: opHeaders(OP_TOKEN_A) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditEnvelope;
    expect(body.items.length).toBeGreaterThan(0);
    expect(body.limit).toBeGreaterThanOrEqual(1);
    for (const e of body.items) expect(e.tenantId).toBe(TENANT_A);
  });

  it('tenant-operator(A) asking for tenant B → 403 (the R3-02 hole, closed)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/audit?tenantId=${TENANT_B}`, { headers: opHeaders(OP_TOKEN_A) });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code?: string };
    expect(body.code).toBe('PERMISSION_DENIED');
    expect(JSON.stringify(body)).not.toContain(TENANT_B);
    expect(JSON.stringify(body)).not.toContain(TENANT_A);
  });

  it('tenant-operator(A) with no tenantId param → its own scope, never empty-by-accident', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/audit`, { headers: opHeaders(OP_TOKEN_A) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as AuditEnvelope;
    // The body.tenantId echo no longer exists; scope pinning is proven by a
    // non-empty page whose every item belongs to A (seeded by W48-C1 above).
    expect(body.items.length).toBeGreaterThan(0);
    for (const e of body.items) expect(e.tenantId).toBe(TENANT_A);
  });

  it('unknown bearer → 401 (no anonymous ledger read)', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/audit?tenantId=${TENANT_A}`, { headers: opHeaders('totally-unknown-token') });
    expect(res.status).toBe(401);
  });

  it('tenant-operator bearer is NOT platform admin: business.enable → 401', async () => {
    const res = await fetch(`${baseUrl}/api/v1/admin/businesses/${TEST_BIZ}/versions/1.0.0/enable`, {
      method: 'PUT',
      headers: opHeaders(OP_TOKEN_A),
    });
    expect(res.status).toBe(401);
  });
});
});
