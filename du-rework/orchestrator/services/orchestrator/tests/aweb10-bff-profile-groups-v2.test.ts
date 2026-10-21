/**
 * PC-08 — V2 profile-group BFF routes (offline loopback, scripted upstream).
 *
 * What this pins, and why each one is a decision rather than a detail:
 *  1. `matchProfileGroupsV2Route` MUST win over the v1 matcher: the v1 matcher
 *     answers `{kind:'invalid'}` (404) for `/profile-groups/v2`, so a later
 *     position would make the whole V2 family unreachable.
 *  2. Local USER sessions are refused on the V2 group plane (D-01) before any
 *     upstream call — there is no group-level assignment projection.
 *  3. `<CHILD_PROJECTION>` is not a BFF concern, but converted-group writes are
 *     platform-Admin only and CSRF-gated.
 *  4. Grant mutations forward `If-Match` verbatim and require their own
 *     `Idempotency-Key`; `ETag` / `idempotent-replay` are the only relayed
 *     upstream headers.
 *  5. Problem codes pass through; upstream titles never do.
 */
import http from 'node:http';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import { matchProfileGroupsV2Route } from '../src/app/admin/bff/profile-groups-v2';
import { matchProfileGroupsRoute } from '../src/app/admin/bff/profile-groups';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'aweb10-cookie-secret';
const ADMIN_TOKEN = 'aweb10-platform-admin-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_A_TOKEN = 'aweb10-tenant-a-token';
const GROUP = '33333333-3333-4333-8333-333333333333';
const CONFLICT_GROUP = '44444444-4444-4444-8444-444444444444';
const KEY = '55555555-5555-4555-8555-555555555555';
const LOCAL_USER = '66666666-6666-4666-8666-666666666666';
const VIEWER_SESSION = 'V'.repeat(43);
const TENANT_SESSION = 'T'.repeat(43);
const LOCAL_SESSION = 'L'.repeat(43);
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};
const EPOCH = '2026-10-05T00:00:00.000Z';

const PORT_BASE = 48_000 + (process.pid % 17) * 13;
let portCursor = 0;
const nextPort = (): number => PORT_BASE + portCursor++;

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpRequest(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

interface Captured {
  method: string;
  path: string;
  auth: string | null;
  ifMatch: string | null;
  idempotencyKey: string | null;
  body: string;
}

interface Stub {
  url: string;
  requests: Captured[];
  close(): Promise<void>;
}

function groupJson(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    groupId: GROUP,
    tenantId: TENANT_A,
    name: 'Invoice operations',
    authMode: 'API_KEY',
    authAuthority: 'GROUP_GRANT',
    revision: 4,
    accessVersion: 7,
    businesses: [],
    apiKeyGrants: [{ apiKeyId: KEY, prefix: 'du_live_abc123', status: 'ACTIVE', grantedAt: EPOCH }],
    createdAt: EPOCH,
    updatedAt: EPOCH,
    ...overrides,
  };
}

function startStub(port: number): Promise<Stub> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        auth: typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
        ifMatch: typeof req.headers['if-match'] === 'string' ? req.headers['if-match'] : null,
        idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null,
        body,
      });
      const json = (status: number, payload: unknown, headers: Record<string, string> = {}): void => {
        res.statusCode = status;
        res.setHeader('content-type', 'application/json');
        for (const [name, value] of Object.entries(headers)) res.setHeader(name, value);
        res.end(JSON.stringify(payload));
      };
      if (url.pathname === `/api/v2/admin/profile-groups/${CONFLICT_GROUP}`) {
        json(409, { code: 'PROFILE_GROUP_V2_REQUIRED', detail: 'upstream-only wording that must not leak' });
        return;
      }
      if (url.pathname === '/api/v2/admin/profile-groups') {
        if (req.method === 'POST') { json(201, groupJson({ revision: 1, accessVersion: 1 })); return; }
        json(200, { groups: [groupJson()] });
        return;
      }
      if (url.pathname === `/api/v2/admin/profile-groups/${GROUP}`) {
        if (req.method === 'PUT') { json(200, groupJson({ revision: 5 }), { etag: '"7"' }); return; }
        json(200, groupJson(), { etag: '"7"' });
        return;
      }
      if (url.pathname === `/api/v2/admin/profile-groups/${GROUP}/rollback`) {
        json(200, groupJson({ revision: 2 }), { etag: '"7"' });
        return;
      }
      if (url.pathname === `/api/v2/admin/profile-groups/${GROUP}/keys`) {
        if (req.headers['if-match'] === undefined) {
          json(428, { code: 'PRECONDITION_REQUIRED' });
          return;
        }
        json(201, {
          grant: { apiKeyId: KEY, prefix: 'du_live_issued', status: 'ACTIVE', grantedAt: EPOCH },
          secret: `du_${'k'.repeat(40)}`,
          secretAvailable: true,
        });
        return;
      }
      if (url.pathname === `/api/v2/admin/profile-groups/${GROUP}/keys/${KEY}/revoke`) {
        json(200, {
          grant: { apiKeyId: KEY, prefix: 'du_live_abc123', status: 'REVOKED', grantedAt: EPOCH, revokedAt: EPOCH },
          accessVersion: 8,
        });
        return;
      }
      if (url.pathname === '/api/v2/admin/profile-groups/catalog') {
        // PC-R07: the source mapping the editor needs must survive the relay
        // verbatim — the BFF never reshapes a catalog body.
        json(200, {
          businessId: url.searchParams.get('businessId'),
          businessVersion: url.searchParams.get('businessVersion'),
          manifestDigest: `sha256:${'a'.repeat(64)}`,
          businessEnabled: true,
          functions: [{
            kind: 'workflow',
            functionId: 'extract',
            action: 'extract',
            manifestDigest: `sha256:${'a'.repeat(64)}`,
            inputSchema: { type: 'object' },
            outputSchema: { type: 'object' },
            profileSchema: { type: 'object' },
            parameterResolution: { mode: 'requestDefaults', maxParallel: 'profileSettings' },
            available: true,
            connectorSlots: [],
          }],
        });
        return;
      }
      json(404, { code: 'NOT_FOUND' });
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))) });
    });
  });
}

class MapSessionStore implements AdminSessionStore {
  private readonly records = new Map<string, AdminSessionView>();
  add(sessionId: string, view: AdminSessionView): void { this.records.set(sessionId, view); }
  async get(sessionId: string): Promise<AdminSessionView | null> { return this.records.get(sessionId) ?? null; }
}

function legacyAdminCookie(): string {
  const nowMs = Date.now();
  const value = signCookie(SECRET, { iss: 'du-admin-shell', role: 'admin', iat: nowMs, exp: nowMs + 3_600_000 });
  if (!value) throw new Error('signCookie returned undefined');
  return `du_admin=${value}`;
}

describe('PC-08 profile-group V2 matcher', () => {
  it('wins over the v1 matcher for every V2 path', () => {
    for (const path of ['/profile-groups/v2', `/profile-groups/v2/${GROUP}`, `/profile-groups/v2/${GROUP}/keys`]) {
      expect(matchProfileGroupsV2Route(path)).not.toBeNull();
    }
    // The v1 matcher would answer `invalid` (404) for the family root.
    expect(matchProfileGroupsRoute('/profile-groups/v2')).toMatchObject({ kind: 'invalid' });
  });

  it('parses list, group, rollback and grant routes distinctly', () => {
    expect(matchProfileGroupsV2Route('/profile-groups/v2')).toMatchObject({ kind: 'list' });
    // PC-R07: the catalog must not be read as a malformed group id.
    expect(matchProfileGroupsV2Route('/profile-groups/v2/catalog')).toMatchObject({ kind: 'catalog' });
    expect(matchProfileGroupsV2Route(`/profile-groups/v2/${GROUP}`)).toMatchObject({ kind: 'group', groupId: GROUP });
    expect(matchProfileGroupsV2Route(`/profile-groups/v2/${GROUP}/rollback`)).toMatchObject({ kind: 'rollback', groupId: GROUP });
    expect(matchProfileGroupsV2Route(`/profile-groups/v2/${GROUP}/keys`)).toMatchObject({ kind: 'keys', groupId: GROUP });
    expect(matchProfileGroupsV2Route(`/profile-groups/v2/${GROUP}/keys/${KEY}/revoke`)).toMatchObject({ kind: 'keyRevoke', groupId: GROUP, keyId: KEY });
  });

  it('leaves v1 paths to the v1 matcher', () => {
    expect(matchProfileGroupsV2Route('/profile-groups')).toBeNull();
    expect(matchProfileGroupsV2Route(`/profile-groups/${GROUP}`)).toBeNull();
    expect(matchProfileGroupsRoute(`/profile-groups/${GROUP}`)).toMatchObject({ kind: 'group' });
  });
});

describe('PC-08 profile-group V2 BFF', () => {
  let stub: Stub;
  let store: MapSessionStore;
  let handle: AdminShellHandle;
  let baseUrl: string;
  let adminCookie: string;
  let csrfToken: string;

  const API = '/admin/api/profile-groups/v2';

  beforeAll(async () => {
    stub = await startStub(nextPort());
    store = new MapSessionStore();
    store.add(VIEWER_SESSION, { role: 'viewer', tenantId: null, csrfToken: 'v'.repeat(43) });
    store.add(TENANT_SESSION, { role: 'operator', tenantId: TENANT_A, csrfToken: 't'.repeat(43), issuer: 'corp-idp' });
    store.add(LOCAL_SESSION, {
      role: 'operator', tenantId: TENANT_A, csrfToken: 'l'.repeat(43), issuer: 'du-local', sub: LOCAL_USER, roleVersion: 1,
    });
    handle = createAdminShellServer({
      port: nextPort(),
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: ADMIN_TOKEN,
      tenantAdminTokens: { [TENANT_A_TOKEN]: TENANT_A },
      jsonBaseUrl: stub.url,
      adminWeb: { distDir: 'Z:/does-not-exist' },
      cookiePolicy: COOKIE_POLICY,
      oidcSessions: store,
    });
    baseUrl = (await handle.listen()).url;
    adminCookie = legacyAdminCookie();
    const session = await httpRequest(`${baseUrl}/admin/api/session`, { headers: { cookie: adminCookie } });
    csrfToken = (JSON.parse(session.body) as { csrfToken: string }).csrfToken;
  });

  afterAll(async () => {
    await handle.close();
    await stub.close();
  });

  beforeEach(() => { stub.requests.length = 0; });

  const get = (path: string, headers: Record<string, string> = {}) =>
    httpRequest(`${baseUrl}${path}`, { headers: { cookie: adminCookie, ...headers } });
  const mutate = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    httpRequest(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken, ...headers },
      body: JSON.stringify(body),
    });

  it('platform listing requires tenantId and forwards the scoped value', async () => {
    const missing = await get(API);
    expect(missing.status).toBe(422);
    expect(stub.requests).toHaveLength(0);

    const listed = await get(`${API}?tenantId=${TENANT_A}`);
    expect(listed.status).toBe(200);
    expect(stub.requests[0]?.path).toBe(`/api/v2/admin/profile-groups?tenantId=${TENANT_A}`);
    expect(stub.requests[0]?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect((JSON.parse(listed.body) as { groups: unknown[] }).groups).toHaveLength(1);
  });

  it('viewer and local USER sessions are refused before any upstream call', async () => {
    const viewer = await httpRequest(`${baseUrl}${API}?tenantId=${TENANT_A}`, { headers: { cookie: `du_session=${VIEWER_SESSION}` } });
    expect(viewer.status).toBe(403);
    expect(JSON.parse(viewer.body).code).toBe('PROFILE_SCOPE_GATE');

    const local = await httpRequest(`${baseUrl}${API}?tenantId=${TENANT_A}`, { headers: { cookie: `du_session=${LOCAL_SESSION}` } });
    expect(local.status).toBe(403);
    expect(JSON.parse(local.body).code).toBe('PROFILE_GROUP_ASSIGNMENT_REQUIRED');
    expect(stub.requests).toHaveLength(0);
  });

  it('PC-R07 catalog relays the registered function mapping verbatim', async () => {
    const res = await get(`${API}/catalog?businessId=pc09-core&businessVersion=2.0.0`);
    expect(res.status).toBe(200);
    expect(stub.requests[0]?.path)
      .toBe('/api/v2/admin/profile-groups/catalog?businessId=pc09-core&businessVersion=2.0.0');
    expect(stub.requests[0]?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    const body = JSON.parse(res.body) as {
      functions: Array<{ parameterResolution?: Record<string, string> }>;
    };
    // The field the editor saves against must survive untouched.
    expect(body.functions[0]?.parameterResolution).toEqual({
      mode: 'requestDefaults',
      maxParallel: 'profileSettings',
    });
  });

  it('Wave3-F4 catalog forwards an optional tenant scope without widening access', async () => {
    const scoped = await get(`${API}/catalog?businessId=pc09-core&businessVersion=2.0.0&tenantId=${TENANT_A}`);
    expect(scoped.status).toBe(200);
    expect(stub.requests[0]?.path)
      .toBe(`/api/v2/admin/profile-groups/catalog?businessId=pc09-core&businessVersion=2.0.0&tenantId=${TENANT_A}`);
    expect(stub.requests[0]?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);

    // A platform Admin may pin any tenant, and the BFF relays it untouched.
    stub.requests.length = 0;
    const foreign = await get(`${API}/catalog?businessId=pc09-core&businessVersion=2.0.0&tenantId=${TENANT_B}`);
    expect(foreign.status).toBe(200);
    expect(stub.requests[0]?.path).toContain(`tenantId=${TENANT_B}`);

    // Empty and repeated scopes are rejected before any upstream call.
    stub.requests.length = 0;
    const empty = await get(`${API}/catalog?businessId=pc09-core&businessVersion=2.0.0&tenantId=`);
    expect(empty.status).toBe(422);
    const duplicated = await get(
      `${API}/catalog?businessId=pc09-core&businessVersion=2.0.0&tenantId=${TENANT_A}&tenantId=${TENANT_B}`,
    );
    expect(duplicated.status).toBe(422);
    expect(stub.requests).toHaveLength(0);

    // The catalog stays platform-Admin: a tenant session cannot use the new scope.
    const tenant = await httpRequest(
      `${baseUrl}${API}/catalog?businessId=pc09-core&businessVersion=2.0.0&tenantId=${TENANT_A}`,
      { headers: { cookie: `du_session=${TENANT_SESSION}` } },
    );
    expect(tenant.status).toBe(403);
    expect(JSON.parse(tenant.body).code).toBe('ADMIN_CREDENTIAL_REQUIRED');
    expect(stub.requests).toHaveLength(0);
  });

  it('PC-R07 catalog is platform-scoped and validates its query', async () => {
    const missing = await get(`${API}/catalog`);
    expect(missing.status).toBe(422);
    expect(stub.requests).toHaveLength(0);

    const duplicated = await get(`${API}/catalog?businessId=a&businessId=b&businessVersion=1.0.0`);
    expect(duplicated.status).toBe(422);
    expect(stub.requests).toHaveLength(0);

    const wrongMethod = await mutate(`${API}/catalog?businessId=pc09-core&businessVersion=2.0.0`, {});
    expect(wrongMethod.status).toBe(405);
    expect(stub.requests).toHaveLength(0);

    // A tenant operator is not a platform Admin, and the catalog is global.
    const tenant = await httpRequest(
      `${baseUrl}${API}/catalog?businessId=pc09-core&businessVersion=2.0.0`,
      { headers: { cookie: `du_session=${TENANT_SESSION}` } },
    );
    expect(tenant.status).toBe(403);
    expect(JSON.parse(tenant.body).code).toBe('ADMIN_CREDENTIAL_REQUIRED');
    expect(stub.requests).toHaveLength(0);
  });

  it('detail relays the body and the ETag', async () => {    const res = await get(`${API}/${GROUP}`);
    expect(res.status).toBe(200);
    expect(res.headers.etag).toBe('"7"');
    expect((JSON.parse(res.body) as { accessVersion: number }).accessVersion).toBe(7);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('tenant operator reads are scoped to their own tenant and a foreign tenant is denied', async () => {
    const own = await httpRequest(`${baseUrl}${API}/${GROUP}`, { headers: { cookie: `du_session=${TENANT_SESSION}` } });
    expect(own.status).toBe(200);
    expect(stub.requests[0]?.path).toBe(`/api/v2/admin/profile-groups/${GROUP}?tenantId=${TENANT_A}`);

    stub.requests.length = 0;
    const foreign = await httpRequest(`${baseUrl}${API}/${GROUP}?tenantId=${TENANT_B}`, { headers: { cookie: `du_session=${TENANT_SESSION}` } });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).code).toBe('PERMISSION_DENIED');
    expect(stub.requests).toHaveLength(0);
  });

  it('create requires platform Admin plus CSRF and forwards a key-free body', async () => {
    const noCsrf = await httpRequest(`${baseUrl}${API}`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(noCsrf.status).toBe(403);
    expect(stub.requests).toHaveLength(0);

    const created = await mutate(API, { name: 'Invoice operations', tenantId: TENANT_A, authMode: 'API_KEY', expectedRevision: 0, businesses: [] });
    expect(created.status).toBe(201);
    expect(stub.requests[0]?.method).toBe('POST');
    expect(stub.requests[0]?.path).toBe('/api/v2/admin/profile-groups');
    expect(stub.requests[0]?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(JSON.parse(stub.requests[0]?.body ?? '{}')).toEqual({
      name: 'Invoice operations', tenantId: TENANT_A, authMode: 'API_KEY', expectedRevision: 0, businesses: [],
    });
  });

  it('a tenant operator cannot mutate a profile group', async () => {
    const res = await httpRequest(`${baseUrl}${API}`, {
      method: 'POST',
      headers: { cookie: `du_session=${TENANT_SESSION}`, 'content-type': 'application/json', 'x-csrf-token': 't'.repeat(43) },
      body: JSON.stringify({ name: 'x' }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PROFILE_SCOPED_GATE');
    expect(stub.requests).toHaveLength(0);
  });

  it('replace and rollback forward to the V2 paths and relay the ETag', async () => {
    const replaced = await httpRequest(`${baseUrl}${API}/${GROUP}`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ name: 'Invoice operations', authMode: 'API_KEY', expectedRevision: 4, businesses: [] }),
    });
    expect(replaced.status).toBe(200);
    expect(replaced.headers.etag).toBe('"7"');
    expect(stub.requests[0]?.method).toBe('PUT');
    expect(stub.requests[0]?.path).toBe(`/api/v2/admin/profile-groups/${GROUP}`);
    expect((JSON.parse(replaced.body) as { revision: number }).revision).toBe(5);

    stub.requests.length = 0;
    const rolledBack = await mutate(`${API}/${GROUP}/rollback`, { expectedRevision: 5, targetRevision: 2 });
    expect(rolledBack.status).toBe(200);
    expect(stub.requests[0]?.path).toBe(`/api/v2/admin/profile-groups/${GROUP}/rollback`);
  });

  it('grant issue requires Idempotency-Key and forwards If-Match verbatim', async () => {
    const noKey = await mutate(`${API}/${GROUP}/keys`, {});
    expect(noKey.status).toBe(422);
    expect(JSON.parse(noKey.body).code).toBe('INVALID_SCHEMA');
    expect(stub.requests).toHaveLength(0);

    const noMatch = await mutate(`${API}/${GROUP}/keys`, {}, { 'idempotency-key': 'pc08-issue-no-match' });
    expect(noMatch.status).toBe(428);
    expect(JSON.parse(noMatch.body).code).toBe('PRECONDITION_REQUIRED');

    stub.requests.length = 0;
    const issued = await mutate(`${API}/${GROUP}/keys`, { note: 'ci' }, {
      'idempotency-key': 'pc08-issue-0001',
      'if-match': '"7"',
    });
    expect(issued.status).toBe(201);
    expect(stub.requests[0]?.ifMatch).toBe('"7"');
    expect(stub.requests[0]?.idempotencyKey).toBe('pc08-issue-0001');
    expect(stub.requests[0]?.path).toBe(`/api/v2/admin/profile-groups/${GROUP}/keys`);
    const body = JSON.parse(issued.body) as { secret?: string; secretAvailable: boolean };
    expect(body.secretAvailable).toBe(true);
    expect(body.secret).toMatch(/^du_/);
    expect(issued.headers['cache-control']).toBe('no-store');
  });

  it('grant revoke forwards the expected access version and returns the new one', async () => {
    const revoked = await mutate(`${API}/${GROUP}/keys/${KEY}/revoke`, { expectedAccessVersion: 7 }, { 'idempotency-key': 'pc08-revoke-0001' });
    expect(revoked.status).toBe(200);
    expect(stub.requests[0]?.path).toBe(`/api/v2/admin/profile-groups/${GROUP}/keys/${KEY}/revoke`);
    expect(JSON.parse(stub.requests[0]?.body ?? '{}')).toEqual({ expectedAccessVersion: 7 });
    expect((JSON.parse(revoked.body) as { accessVersion: number }).accessVersion).toBe(8);
  });

  it('passes the upstream problem code through without leaking its message', async () => {
    const conflict = await get(`${API}/${CONFLICT_GROUP}`);
    expect(conflict.status).toBe(409);
    const body = JSON.parse(conflict.body) as { code: string; title: string };
    expect(body.code).toBe('PROFILE_GROUP_V2_REQUIRED');
    expect(body.title).not.toContain('upstream-only');
  });

  it('a malformed group id is a 404 with no upstream call', async () => {
    const res = await get(`${API}/not-a-uuid`);
    expect(res.status).toBe(404);
    expect(stub.requests).toHaveLength(0);
  });
});
