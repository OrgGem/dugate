import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { signCookie } from '../src/app/admin/shell-auth';
import { deriveCsrfToken } from '../src/modules/admin-actions/rbac';
import { createApp, type App } from '../src/server';

/**
 * ADM-BASE-02 / OIDC-03 LIVE HTTP matrix — 10 cells (WRITTEN, AWAITING A
 * DISPATCHED DB WINDOW; excluded from `test:unit` by jest.unit.config.cjs).
 * Run ONLY inside the exclusive PG :5433 + Redis :6380 window, alone:
 *   npx jest --runInBand tests/admin-action-rbac-live.test.ts
 *
 * Cells (per SEC task line 19: "Test direct HTTP từng ô allow/deny của
 * matrix", CSRF guard for cookie-auth mutations, public api-key/runtime
 * identity unchanged):
 *  D1 bearer operator -> dispatcher business.enable        => 403, zero side effects
 *  D2 cookie session   -> dispatcher business.enable        => no CSRF 403; with CSRF 200 + audit actor shell:admin
 *  D3 GET   /api/v1/admin/actions                           => 405 (never GET-as-success)
 *  D4 bind-profile is ADMIN-ONLY (OIDC-03): operator 403 for ANY key, zero
 *     bindings; platform unknown key => 404; platform own key => 201 + 1 audit row
 *  X1 operator cancels OWN-tenant operation via dispatcher => 200 + tenant audit
 *  X2 operator cancels a tenant-B operation              => 404, state + ledger untouched
 *  M1 bearer operator -> GET /api/v1/usage                  => B 403 / A 200 / missing-param 200-of-A
 *  M2 bearer operator -> GET /api/v1/operations             => envelope items are ONLY tenant A (B submitted as control)
 *  M3 bearer operator -> GET /api/v1/operations/:idB        => 404, byte-shape identical to a never-existing id
 *  M4 bearer operator -> GET /api/v1/admin/api-keys         => list own-only; ?tenantId=B => 403
 *  M5 bearer platform -> GET /api/v1/operations             => ADM-UX-02 envelope regression {items,nextCursor,prevCursor,total,limit}
 *  M6 platform Idempotency-Key replay on profile-bindings   => same body, idempotent-replay header, exactly 1 audit row
 *
 * Fixture policy mirrors admin-audit.test.ts: suite-owned tenant/key/
 * business ids, afterAll deletes only rows this suite owns. No global
 * TRUNCATE.
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const PLATFORM_TOKEN = 'rbac-live-platform-' + randomUUID();
const RUNTIME_TOKEN = 'rbac-live-runtime-' + randomUUID();
const OP_A_TOKEN = 'rbac-live-op-a-' + randomUUID();
const COOKIE_SECRET = 'rbac-live-cookie-' + randomUUID();
const TENANT_A = 'a1a1a1a1-0000-4000-8000-000000000001';
const TENANT_B = 'b2b2b2b2-0000-4000-8000-000000000002';
const LIVE_BIZ = 'biz-rbac-' + randomUUID().slice(0, 8);
// Control business for the M-group: submission resolves the ACTIVE version
// (submission.ts:238 requires is_active=true) — LIVE_BIZ stays
// REGISTERED_DISABLED until the D-group enable cells flip it.
const CONTROL_BIZ = 'biz-rbac-ctl-' + randomUUID().slice(0, 8);
const RAW_KEY_A = 'du_rbaclive_a_' + randomUUID().replace(/-/g, '');
const RAW_KEY_B = 'du_rbaclive_b_' + randomUUID().replace(/-/g, '');
let KEY_ID_A = '';
let KEY_ID_B = '';

let app: App;
let baseUrl: string;
// Reviewer W48-QW1-LIVE-003 pre-audit, point 2: the suite deletes ONLY the
// idempotency keys it minted (registered here) — never a route-prefix
// sweep that could eat another suite's markers.
const IDEM_KEYS_ISSUED: string[] = [];

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}
function platformHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${PLATFORM_TOKEN}`, 'content-type': 'application/json', ...extra };
}
function opAHeaders(): Record<string, string> {
  return { authorization: `Bearer ${OP_A_TOKEN}`, 'content-type': 'application/json' };
}
async function call(
  path: string,
  init: { method: string; headers?: Record<string, string>; body?: unknown }
): Promise<{ status: number; body: Record<string, unknown>; headers: Headers }> {
  const res = await fetch(`${baseUrl}${path}`, {
    method: init.method,
    headers: init.headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const textBody = await res.text();
  let parsed: Record<string, unknown> = {};
  try {
    parsed = textBody ? (JSON.parse(textBody) as Record<string, unknown>) : {};
  } catch {
    parsed = { raw: textBody };
  }
  return { status: res.status, body: parsed, headers: res.headers };
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('admin-action-rbac-live.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    adminToken: PLATFORM_TOKEN,
    runtimeToken: RUNTIME_TOKEN,
    tenantAdminTokens: { [OP_A_TOKEN]: TENANT_A },
    adminShellCookieSecret: COOKIE_SECRET,
    connectorBaseUrls: {},
    autoDispatch: false,
    autoMigrate: true,
  });
  const srv = await app.listen();
  baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  await app.db.query(
    `INSERT INTO tenants (id, name) VALUES ($1, 'RBACLIVE A'), ($2, 'RBACLIVE B')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_A, TENANT_B]
  );
  await app.db.query(
    `INSERT INTO business_versions (business_id, version, status, is_active, digest, queue, manifest)
     VALUES ($1, '1.0.0', 'REGISTERED_DISABLED', false, 'sha256-rbaclive', 'queue-rbaclive', $2)`,
    // LIVE-003 root cause (tester diagnosis): submission.ts:222/248 reads
    // manifest.runtime.handlerKinds — a manifest without `runtime` is a
    // TypeError -> 500. The seed must mirror the registration contract.
    [LIVE_BIZ, JSON.stringify({
      businessId: LIVE_BIZ,
      version: '1.0.0',
      runtime: { wireVersion: '1', handlerKinds: ['root'] },
      // LIVE-004 root cause (Ajv): submission.ts:113 compiles
      // actionDef.inputSchema — the manifest field is inputSchema, not
      // schema; {} under the wrong key is an undefined schema -> 500.
      actions: [{ name: 'extract', inputSchema: { type: 'object', additionalProperties: true } }],
    })]
  );
  await app.db.query(
    `INSERT INTO business_versions (business_id, version, status, is_active, digest, queue, manifest)
     VALUES ($1, '1.0.0', 'ENABLED', true, 'sha256-rbactlive-ctl', 'queue-rbaclive-ctl', $2)`,
    [CONTROL_BIZ, JSON.stringify({
      businessId: CONTROL_BIZ,
      version: '1.0.0',
      runtime: { wireVersion: '1', handlerKinds: ['root'] },
      actions: [{ name: 'extract', inputSchema: { type: 'object', additionalProperties: true } }],
    })]
  );
  KEY_ID_A = randomUUID();
  KEY_ID_B = randomUUID();
  await app.db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ($1, $2, $3, 'du_rba', 'ACTIVE'), ($4, $5, $6, 'du_rba', 'ACTIVE')`
      ,
    [KEY_ID_A, TENANT_A, hashKey(RAW_KEY_A), KEY_ID_B, TENANT_B, hashKey(RAW_KEY_B)]
  );
  // W48-QW1-LIVE-002 root cause: any binding row flips a key into PROFILE
  // mode (PRF-01: unmatched (business, version, action) -> 403, nothing
  // enqueued). D4 binds KEY_A to LIVE_BIZ, so BOTH keys must already carry
  // a CONTROL_BIZ binding or the M-group submits 403. Seed per the real
  // 0004 schema; cleanup already deletes profile_bindings by api_key_id.
  await app.db.query(
    `INSERT INTO profile_bindings
       (profile_id, revision, tenant_id, api_key_id, business_id, business_version, action, connector_bindings)
     VALUES ($1::uuid, 1, $2, $3, $4, '1.0.0', 'extract', '{}'::jsonb),
            ($5::uuid, 1, $6, $7, $4, '1.0.0', 'extract', '{}'::jsonb)`,
    [randomUUID(), TENANT_A, KEY_ID_A, CONTROL_BIZ, randomUUID(), TENANT_B, KEY_ID_B]
  );
});

afterAll(async () => {
  if (app) {
    // Scoped cleanup, owned rows only (FK order).
    const ownOps = `SELECT id FROM operations WHERE tenant_id IN ('${TENANT_A}', '${TENANT_B}')`;
    const idemPlaceholders = IDEM_KEYS_ISSUED.map((_, i) => `$${i + 1}`).join(', ');
    for (const stmt of [
      { sql: `DELETE FROM admin_audit_events WHERE resource LIKE '%${LIVE_BIZ}%' OR resource LIKE '%${CONTROL_BIZ}%' OR resource IN ('apikey:${KEY_ID_A}','apikey:${KEY_ID_B}')`, params: [] as unknown[] },
      // Reviewer point 2: whitelist-scoped, not route-prefix.
      { sql: idemPlaceholders
        ? `DELETE FROM admin_idempotency WHERE key IN (${idemPlaceholders})`
        : `DELETE FROM admin_idempotency WHERE key IN ('__none__')`,
        params: [...IDEM_KEYS_ISSUED] },
      // FK order for the submitted control operations:
      { sql: `DELETE FROM human_waits WHERE operation_id IN (${ownOps})`, params: [] },
      { sql: `DELETE FROM artifact_blobs WHERE storage_key IN (SELECT storage_key FROM artifacts WHERE operation_id IN (${ownOps}))`, params: [] },
      { sql: `DELETE FROM artifacts WHERE operation_id IN (${ownOps})`, params: [] },
      { sql: `DELETE FROM outbox WHERE aggregate_id IN (SELECT id FROM tasks WHERE operation_id IN (${ownOps}))`, params: [] },
      { sql: `DELETE FROM tasks WHERE operation_id IN (${ownOps})`, params: [] },
      { sql: `DELETE FROM profile_bindings WHERE api_key_id IN ($1, $2)`, params: [KEY_ID_A, KEY_ID_B] },
      // Reviewer point 1: operations delete is TENANT-keyed — it must receive
      // the tenant ids (previously routed into the key-id branch, so it
      // deleted nothing and the FK fallout vanished into the catch).
      { sql: `DELETE FROM operations WHERE tenant_id IN ($1, $2)`, params: [TENANT_A, TENANT_B] },
      { sql: `DELETE FROM api_keys WHERE id IN ($1, $2)`, params: [KEY_ID_A, KEY_ID_B] },
      { sql: `DELETE FROM business_versions WHERE business_id IN ($1, $2)`, params: [LIVE_BIZ, CONTROL_BIZ] },
      { sql: `DELETE FROM tenants WHERE id IN ($1, $2)`, params: [TENANT_A, TENANT_B] },
    ]) {
      try {
        await app.db.query(stmt.sql, stmt.params);
      } catch {
        /* best effort — scoped */
      }
    }
    await app.close();
  }
});

async function countOwned(sql: string, params: unknown[]): Promise<number> {
  const res = await app.db.query<{ n: string }>(sql, params);
  return Number(res.rows[0]?.n ?? '0');
}

describe('ADM-BASE-02 dispatcher — live cells', () => {
  it('D1: bearer operator dispatching business.enable -> 403 and ZERO side effects', async () => {
    const res = await call('/api/v1/admin/actions', {
      method: 'POST',
      headers: opAHeaders(),
      body: { action: 'business.enable', params: { businessId: LIVE_BIZ, version: '1.0.0' } },
    });
    expect(res.status).toBe(403);
    expect(res.body.code).toBe('PERMISSION_DENIED');
    const st = await app.db.query<{ status: string }>(
      'SELECT status FROM business_versions WHERE business_id=$1 AND version=$2',
      [LIVE_BIZ, '1.0.0']
    );
    expect(st.rows[0]!.status).toBe('REGISTERED_DISABLED');
    expect(await countOwned('SELECT count(*)::text AS n FROM admin_audit_events WHERE resource LIKE $1', [`%${LIVE_BIZ}%`])).toBe(0);
  });

  it('D2: cookie session WITHOUT CSRF -> 403; WITH derived CSRF -> 200 + audit actor shell:admin', async () => {
    const session = signCookie(COOKIE_SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 3_600_000,
    })!;
    const base = { cookie: `du_admin=${session}`, 'content-type': 'application/json' };
    const denied = await call('/api/v1/admin/actions', {
      method: 'POST',
      headers: base,
      body: { action: 'business.enable', params: { businessId: LIVE_BIZ, version: '1.0.0' } },
    });
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('PERMISSION_DENIED');
    // HttpError.message rides problem().title (contracts/errors.ts);
    // detail stays unset. Tester round-1 caught the wrong-field assert.
    expect(String(denied.body.title ?? '')).toMatch(/csrf/i);

    const allowed = await call('/api/v1/admin/actions', {
      method: 'POST',
      headers: { ...base, 'x-csrf-token': deriveCsrfToken(COOKIE_SECRET, session) },
      body: { action: 'business.enable', params: { businessId: LIVE_BIZ, version: '1.0.0' } },
    });
    expect(allowed.status).toBe(200);
    const actors = await app.db.query<{ actor: string }>(
      'SELECT actor FROM admin_audit_events WHERE resource LIKE $1 ORDER BY created_at DESC LIMIT 1',
      [`%${LIVE_BIZ}%`]
    );
    expect(actors.rows[0]!.actor).toBe('shell:admin');
    // leave the version ENABLED for M6-independent cleanup; enable is idempotent
  });

  it('D3: GET /api/v1/admin/actions -> 405, never GET-as-success', async () => {
    const res = await call('/api/v1/admin/actions', { method: 'GET', headers: platformHeaders() });
    expect(res.status).toBe(405);
    expect(res.body.code).toBe('METHOD_NOT_ALLOWED');
  });

  it('D4 (OIDC-03): bind-profile is ADMIN-ONLY — operator 403 for ANY key, zero bindings; platform unknown 404, own 201 + exactly 1 audit row', async () => {
    const body = (raw: string): Record<string, unknown> => ({
      action: 'apikey.bind-profile',
      params: { apiKey: raw, businessId: LIVE_BIZ, businessVersion: '1.0.0', action: 'extract', connectorBindings: {} },
    });
    const bindingsBefore = await countOwned('SELECT count(*)::text AS n FROM profile_bindings WHERE api_key_id IN ($1, $2)', [KEY_ID_A, KEY_ID_B]);
    for (const raw of [RAW_KEY_B, RAW_KEY_A, 'du_rbaclive_ghost_' + randomUUID()]) {
      const denied = await call('/api/v1/admin/actions', { method: 'POST', headers: opAHeaders(), body: body(raw) });
      expect(denied.status).toBe(403);
      expect(denied.body.code).toBe('PERMISSION_DENIED');
      expect(String(denied.body.title ?? denied.body.detail ?? '')).toMatch(/platform/i);
      expect(JSON.stringify(denied.body)).not.toContain(TENANT_B);
    }
    expect(
      await countOwned('SELECT count(*)::text AS n FROM profile_bindings WHERE api_key_id IN ($1, $2)', [KEY_ID_A, KEY_ID_B])
    ).toBe(bindingsBefore); // denial precedes every lookup/mutation

    const unknown = await call('/api/v1/admin/actions', {
      method: 'POST',
      headers: platformHeaders(),
      body: body('du_rbaclive_nosuchkey_' + randomUUID()),
    });
    expect(unknown.status).toBe(404);

    const before = await countOwned('SELECT count(*)::text AS n FROM admin_audit_events WHERE resource=$1', [`apikey:${KEY_ID_A}`]);
    const own = await call('/api/v1/admin/actions', { method: 'POST', headers: platformHeaders(), body: body(RAW_KEY_A) });
    expect(own.status).toBe(201);
    const after = await countOwned('SELECT count(*)::text AS n FROM admin_audit_events WHERE resource=$1', [`apikey:${KEY_ID_A}`]);
    expect(after - before).toBe(1);
  });
});

describe('ADM-BASE-02 read surfaces — live cells', () => {
  beforeAll(async () => {
    // control operations: one per tenant, via the PUBLIC submit path with
    // each tenant's own api key (never schema-guess the operations table)
    for (const raw of [RAW_KEY_A, RAW_KEY_B]) {
      const sub = await call(`/api/v1/businesses/${CONTROL_BIZ}/actions/extract`, {
        method: 'POST',
        headers: { 'x-api-key': raw, 'content-type': 'application/json' },
        body: { input: { q: 'rbac-live-control' } },
      });
      expect(sub.status).toBe(202);
    }
  });

  it('M1: operator GET /api/v1/usage — tenantId=B 403, tenantId=A 200, missing param 200-of-A', async () => {
    const window = '?from=2020-01-01T00:00:00Z&to=2099-01-01T00:00:00Z';
    const foreign = await call(`/api/v1/usage${window}&tenantId=${TENANT_B}`, { method: 'GET', headers: opAHeaders() });
    expect(foreign.status).toBe(403);
    expect(foreign.body.code).toBe('PERMISSION_DENIED');
    const own = await call(`/api/v1/usage${window}&tenantId=${TENANT_A}`, { method: 'GET', headers: opAHeaders() });
    expect(own.status).toBe(200);
    const missing = await call(`/api/v1/usage${window}`, { method: 'GET', headers: opAHeaders() });
    expect(missing.status).toBe(200); // forced own scope, NOT the platform 422
  });

  it('M2: operator GET /api/v1/operations returns ONLY tenant-A rows', async () => {
    const res = await call('/api/v1/operations?limit=100', { method: 'GET', headers: opAHeaders() });
    expect(res.status).toBe(200);
    // ADM-UX-02 envelope: the list key is items, not the old rows.
    const rows = res.body.items as { tenantId: string }[];
    expect(Array.isArray(rows)).toBe(true);
    for (const r of rows) expect(r.tenantId).toBe(TENANT_A);
  });

  it('M3: operator by-id read of a tenant-B operation is indistinguishable 404', async () => {
    const listB = await call('/api/v1/operations?limit=100', { method: 'GET', headers: platformHeaders() });
    // ADM-UX-02 envelope: items, not the old rows.
    const rowsB = (listB.body.items as { id: string; tenantId: string }[]).filter((r) => r.tenantId === TENANT_B);
    expect(rowsB.length).toBeGreaterThan(0);
    const foreign = await call(`/api/v1/operations/${rowsB[0]!.id}`, { method: 'GET', headers: opAHeaders() });
    const ghost = await call(`/api/v1/operations/${randomUUID()}`, { method: 'GET', headers: opAHeaders() });
    expect(foreign.status).toBe(404);
    expect(ghost.status).toBe(404);
    expect(foreign.body.code).toBe(ghost.body.code);
  });

  it('M4: operator api-keys list is own-tenant only; explicit foreign scope 403', async () => {
    const list = await call('/api/v1/admin/api-keys', { method: 'GET', headers: opAHeaders() });
    expect(list.status).toBe(200);
    // W-ADMIN-APIKEY-ALIGN-1: buildApiKeyPage spreads listPage — wire key is
    // `items` now; `?? rows` keeps the cell honest against an older build.
    const rows = (list.body.items ?? list.body.rows) as { tenantId: string }[];
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.tenantId).toBe(TENANT_A);
    const foreign = await call(`/api/v1/admin/api-keys?tenantId=${TENANT_B}`, { method: 'GET', headers: opAHeaders() });
    expect(foreign.status).toBe(403);
  });

  it('M5: platform operations-list envelope regression {items,nextCursor,prevCursor,total,limit}', async () => {
    const res = await call('/api/v1/operations?limit=20', { method: 'GET', headers: platformHeaders() });
    expect(res.status).toBe(200);
    // ADM-UX-02 replaced the old {rows,total,limit} envelope. Both cursors
    // are ALWAYS present (null on the first page / at the last page), so the
    // key SET is exact rather than a subset check — that is the point of a
    // wire-contract regression: a renamed or dropped key must fail here.
    expect(Object.keys(res.body).sort()).toEqual(['items', 'limit', 'nextCursor', 'prevCursor', 'total']);
    expect(Array.isArray(res.body.items)).toBe(true);
    expect(res.body.limit).toBe(20);
  });

  it('M6: live Idempotency-Key replay on direct profile-bindings POST', async () => {
    const key = 'rbac-live-idem-' + randomUUID();
    const payload = {
      apiKey: RAW_KEY_A,
      businessId: LIVE_BIZ,
      businessVersion: '1.0.0',
      action: 'extract',
      connectorBindings: {},
    };
    IDEM_KEYS_ISSUED.push(key); // cleanup deletes only keys minted by THIS suite
    const before = await countOwned('SELECT count(*)::text AS n FROM admin_audit_events WHERE resource=$1', [`apikey:${KEY_ID_A}`]);
    const first = await call('/api/v1/admin/profile-bindings', {
      method: 'POST',
      headers: platformHeaders({ 'idempotency-key': key }),
      body: payload,
    });
    expect(first.status).toBe(201);
    const retry = await call('/api/v1/admin/profile-bindings', {
      method: 'POST',
      headers: platformHeaders({ 'idempotency-key': key }),
      body: payload,
    });
    expect(retry.status).toBe(201);
    expect(retry.headers.get('idempotent-replay')).toBe('true');
    expect(retry.body).toEqual(first.body);
    const after = await countOwned('SELECT count(*)::text AS n FROM admin_audit_events WHERE resource=$1', [`apikey:${KEY_ID_A}`]);
    expect(after - before).toBe(1);
  });
});
describe('OIDC-03 operation-control live cells (operator-approved actions)', () => {
  async function submitControlOp(rawKey: string): Promise<string> {
    const sub = await call('/api/v1/businesses/' + CONTROL_BIZ + '/actions/extract', {
      method: 'POST',
      headers: { 'x-api-key': rawKey, 'content-type': 'application/json' },
      body: { input: { q: 'rbac-live-opctl' } },
    });
    expect(sub.status).toBe(202);
    return String((sub.body as { operationId?: string }).operationId ?? '');
  }

  it('X1: operator cancels an OWN-tenant operation via the dispatcher (200 + tenant-scoped audit)', async () => {
    const opId = await submitControlOp(RAW_KEY_A);
    const res = await call('/api/v1/admin/actions', {
      method: 'POST',
      headers: opAHeaders(),
      body: { action: 'operations.cancel', params: { operationId: opId } },
    });
    expect(res.status).toBe(200);
    expect((res.body as { state?: string }).state).toBe('CANCELLED');
    const aud = await app.db.query<{ tenant_id: string | null }>(
      'SELECT tenant_id FROM admin_audit_events WHERE resource = $1',
      ['operation:' + opId]
    );
    expect(aud.rowCount).toBe(1);
    expect(aud.rows[0]!.tenant_id).toBe(TENANT_A);
  });

  it('X2: operator cancelling a tenant-B operation is 404-indistinguishable and touches NOTHING', async () => {
    const opB = await submitControlOp(RAW_KEY_B);
    const before = await countOwned('SELECT count(*)::text AS n FROM admin_audit_events', []);
    const res = await call('/api/v1/admin/actions', {
      method: 'POST',
      headers: opAHeaders(),
      body: { action: 'operations.cancel', params: { operationId: opB } },
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(JSON.stringify(res.body)).not.toContain(opB);
    expect(await countOwned('SELECT count(*)::text AS n FROM admin_audit_events', [])).toBe(before);
    const stillRunning = await app.db.query<{ state: string }>('SELECT state FROM operations WHERE id=$1', [opB]);
    expect(stillRunning.rows[0]!.state).not.toBe('CANCELLED');
  });
});
});