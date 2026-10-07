/**
 * AWEB-02 — Admin Web BFF foundation (focused, offline).
 *
 * Drives the real `createAdminShellServer` over loopback HTTP against a
 * scripted upstream stub:
 *   - GET  /admin/api/session  → principal/role/scope/CSRF, no-store
 *   - GET  /admin/api/audit    → ACUI-M07 tenant fence (operator A never
 *                                reads B; viewer/legacy-operator denied;
 *                                tenant without credential fails closed;
 *                                platform bearer only for platform sessions)
 *   - POST /admin/api/actions  → CSRF gate (legacy HMAC + OIDC session token),
 *                                admin-only, idempotency-key forwarded
 *   - problem+json envelope mapping (401/403/409/413/422/502/503)
 *   - token hygiene: no admin/tenant token in bundle, HTML or any BFF body
 *
 * The "direct API" leg of the tenant-fence matrix (tenant_operator bearer
 * with a foreign ?tenantId=) is the platform's own gate —
 * `authorizeAuditTenantRead` (asserted here) and the `admin-audit-scope`
 * suite — the BFF leg is asserted end-to-end below.
 */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import { authorizeAuditTenantRead, deriveCsrfToken } from '../src/modules/admin-actions/rbac';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'aweb02-cookie-secret';
const ADMIN_TOKEN = 'aweb02-platform-admin-token';
const TENANT_A_TOKEN = 'aweb02-tenant-a-token';
const TENANT_B_TOKEN = 'aweb02-tenant-b-token';
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};
const OIDC_SESSION_ID = 'S'.repeat(43);
const CSRF_OPERATOR_A = 'C'.repeat(43);
const CSRF_VIEWER = 'V'.repeat(43);
const CSRF_ADMIN = 'D'.repeat(43);
const CSRF_OPERATOR_C = 'E'.repeat(43);
const DIST_DIR = path.resolve(__dirname, '../../../apps/admin-web/dist');

// Windows loopback tests use an explicit quiet port block (same trick as
// admin-shell-server.test.ts) instead of OS-assigned ephemeral ports.
const PORT_BASE = 44_500 + (process.pid % 19) * 11;
let portCursor = 0;
const nextPort = (): number => PORT_BASE + portCursor++;

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
  rawHeaders: string[];
}

function httpRequest(
  url: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: opts.method ?? 'GET',
        headers: opts.headers ?? {},
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
            rawHeaders: res.rawHeaders,
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function headerValue(res: Response, name: string): string {
  const value = res.headers[name];
  if (Array.isArray(value)) return value[0] ?? '';
  return value ?? '';
}

interface CapturedUpstream {
  method: string;
  path: string;
  headers: http.IncomingHttpHeaders;
  body: string;
}

interface StubUpstream {
  url: string;
  requests: CapturedUpstream[];
  queue(status: number, body: unknown): void;
  close(): Promise<void>;
}

function startStubUpstream(port: number): Promise<StubUpstream> {
  const requests: CapturedUpstream[] = [];
  const scripted: { status: number; body: unknown }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      requests.push({
        method: req.method ?? 'GET',
        path: req.url ?? '/',
        headers: req.headers,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      const next = scripted.shift() ?? { status: 200, body: { items: [], nextCursor: null } };
      res.statusCode = next.status;
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(next.body));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      const addr = server.address();
      const actual = typeof addr === 'object' && addr !== null ? addr.port : port;
      resolve({
        url: `http://127.0.0.1:${actual}`,
        requests,
        queue: (status, body) => scripted.push({ status, body }),
        close: () =>
          new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
      });
    });
  });
}

/** Minimal typed OIDC session store fixture (only what the BFF consumes). */
class FakeSessionStore implements AdminSessionStore {
  private readonly records = new Map<string, AdminSessionView>();
  add(sessionId: string, view: AdminSessionView): void {
    this.records.set(sessionId, view);
  }
  async get(sessionId: string): Promise<AdminSessionView | null> {
    return this.records.get(sessionId) ?? null;
  }
}

function legacyCookie(role: 'admin' | 'operator' | 'viewer'): string {
  // Claims use ms epoch (shell-types AdminCookieClaims).
  const nowMs = Date.now();
  const value = signCookie(SECRET, { iss: 'du-admin-shell', role, iat: nowMs, exp: nowMs + 3_600_000 });
  if (!value) throw new Error('signCookie returned undefined');
  return `du_admin=${value}`;
}

async function readDistBundle(): Promise<{ files: { file: string; text: string }[]; indexHtml: string }> {
  const indexPath = path.join(DIST_DIR, 'index.html');
  const indexHtml = fs.readFileSync(indexPath, 'utf8');
  const assetsDir = path.join(DIST_DIR, 'assets');
  const files: { file: string; text: string }[] = [];
  if (fs.existsSync(assetsDir)) {
    for (const name of fs.readdirSync(assetsDir)) {
      files.push({ file: name, text: fs.readFileSync(path.join(assetsDir, name), 'utf8') });
    }
  }
  return { files, indexHtml };
}

describe('AWEB-02 admin BFF foundation', () => {
  let stub: StubUpstream;
  let store: FakeSessionStore;
  let handle: AdminShellHandle;
  let baseUrl: string;

  beforeAll(async () => {
    stub = await startStubUpstream(nextPort());
    store = new FakeSessionStore();
    store.add(OIDC_SESSION_ID, {
      role: 'operator',
      tenantId: 'tenant-a',
      csrfToken: CSRF_OPERATOR_A,
      issuer: 'https://idp.test',
    });
    handle = createAdminShellServer({
      port: nextPort(),
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: ADMIN_TOKEN,
      tenantAdminTokens: { [TENANT_A_TOKEN]: 'tenant-a', [TENANT_B_TOKEN]: 'tenant-b' },
      jsonBaseUrl: stub.url,
      adminWeb: { distDir: DIST_DIR },
      cookiePolicy: COOKIE_POLICY,
      oidcSessions: store,
    });
    const bound = await handle.listen();
    baseUrl = bound.url;
  });

  afterAll(async () => {
    await handle.close();
    await stub.close();
  });

  beforeEach(() => {
    stub.requests.length = 0;
  });

  function oidcCookie(sessionId = OIDC_SESSION_ID): string {
    return `du_session=${sessionId}`;
  }

  describe('BFF switch', () => {
    it('does not exist when the admin mount flag is off (legacy 404)', async () => {
      const off = createAdminShellServer({
        port: nextPort(),
        host: '127.0.0.1',
        cookieSecret: SECRET,
        adminToken: ADMIN_TOKEN,
        cookiePolicy: COOKIE_POLICY,
      });
      const bound = await off.listen();
      try {
        const res = await httpRequest(`${bound.url}/admin/api/session`);
        expect(res.status).toBe(404);
        expect(headerValue(res, 'content-type')).toContain('text/html');
      } finally {
        await off.close();
      }
    });

    it('unknown BFF route → 404 problem+json', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/nope`);
      expect(res.status).toBe(404);
      expect(headerValue(res, 'content-type')).toContain('application/problem+json');
      expect(JSON.parse(res.body).code).toBe('NOT_FOUND');
    });

    it('wrong method → 405 problem+json', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/actions`);
      expect(res.status).toBe(405);
      expect(JSON.parse(res.body).code).toBe('METHOD_NOT_ALLOWED');
    });
  });

  describe('GET /admin/api/session', () => {
    it('anonymous → 401 UNAUTHENTICATED, no-store', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/session`);
      expect(res.status).toBe(401);
      expect(headerValue(res, 'content-type')).toContain('application/problem+json');
      expect(headerValue(res, 'cache-control')).toBe('no-store');
      expect(JSON.parse(res.body).code).toBe('UNAUTHENTICATED');
    });

    it('legacy admin session → platform scope + derived CSRF, token never echoed', async () => {
      const cookie = legacyCookie('admin');
      const res = await httpRequest(`${baseUrl}/admin/api/session`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(headerValue(res, 'cache-control')).toBe('no-store');
      const body = JSON.parse(res.body) as {
        plane: string;
        role: string;
        principal: { kind: string; tenantId: string | null };
        scope: { kind: string };
        csrfToken: string;
      };
      expect(body.plane).toBe('legacy');
      expect(body.role).toBe('admin');
      expect(body.principal).toEqual({ kind: 'platform', tenantId: null });
      expect(body.scope).toEqual({ kind: 'platform' });
      const cookieValue = cookie.slice('du_admin='.length);
      expect(body.csrfToken).toBe(deriveCsrfToken(SECRET, cookieValue));
      expect(res.body).not.toContain(ADMIN_TOKEN);
      expect(res.body).not.toContain(TENANT_A_TOKEN);
    });

    it('legacy operator session → unscoped principal (no tenant binding)', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/session`, {
        headers: { cookie: legacyCookie('operator') },
      });
      const body = JSON.parse(res.body) as { principal: { kind: string }; scope: unknown };
      expect(res.status).toBe(200);
      expect(body.principal.kind).toBe('unscoped');
      expect(body.scope).toBeNull();
    });

    it('OIDC operator session → tenant scope + session CSRF token', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/session`, {
        headers: { cookie: oidcCookie() },
      });
      expect(res.status).toBe(200);
      const body = JSON.parse(res.body) as {
        plane: string;
        principal: { kind: string; tenantId: string | null };
        scope: { kind: string; tenantId: string };
        csrfToken: string;
      };
      expect(body.plane).toBe('oidc');
      expect(body.principal).toEqual({ kind: 'tenant_operator', tenantId: 'tenant-a' });
      expect(body.scope).toEqual({ kind: 'tenant', tenantId: 'tenant-a' });
      expect(body.csrfToken).toBe(CSRF_OPERATOR_A);
    });

    it('dead du_session is not downgraded to a live legacy cookie (SEC-02)', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/session`, {
        headers: { cookie: `du_session=${'Z'.repeat(43)}; du_admin=${legacyCookie('admin').slice('du_admin='.length)}` },
      });
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).code).toBe('UNAUTHENTICATED');
    });
  });

  describe('GET /admin/api/audit — ACUI-M07 tenant fence', () => {
    it('legacy admin → upstream gets the platform bearer, tenantId passthrough', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/audit?tenantId=tenant-b&limit=5`, {
        headers: { cookie: legacyCookie('admin') },
      });
      expect(res.status).toBe(200);
      expect(stub.requests).toHaveLength(1);
      const upstreamReq = stub.requests[0];
      expect(upstreamReq?.method).toBe('GET');
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
      expect(upstreamReq?.path).toContain('/api/v1/admin/audit');
      expect(upstreamReq?.path).toContain('tenantId=tenant-b');
      expect(upstreamReq?.path).toContain('limit=5');
      expect(headerValue(res, 'cache-control')).toBe('no-store');
    });

    it('OIDC operator tenant-a → tenant-a credential, tenant forced to its own', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/audit`, {
        headers: { cookie: oidcCookie() },
      });
      expect(res.status).toBe(200);
      const upstreamReq = stub.requests[0];
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${TENANT_A_TOKEN}`);
      expect(upstreamReq?.headers.authorization).not.toBe(`Bearer ${ADMIN_TOKEN}`);
      expect(upstreamReq?.path).toContain('tenantId=tenant-a');
    });

    it('OIDC operator tenant-a asking for tenant-b → 403, upstream untouched', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/audit?tenantId=tenant-b`, {
        headers: { cookie: oidcCookie() },
      });
      expect(res.status).toBe(403);
      const body = JSON.parse(res.body) as { code: string; status: number };
      expect(body.code).toBe('PERMISSION_DENIED');
      expect(body.status).toBe(403);
      expect(stub.requests).toHaveLength(0);
    });

    it('OIDC operator tenant-a asking for its own tenant → allowed (own credential)', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/audit?tenantId=tenant-a`, {
        headers: { cookie: oidcCookie() },
      });
      expect(res.status).toBe(200);
      expect(stub.requests[0]?.headers.authorization).toBe(`Bearer ${TENANT_A_TOKEN}`);
    });

    it('operator of an unconfigured tenant fails closed (never borrows the platform token)', async () => {
      store.add('T'.repeat(43), {
        role: 'operator',
        tenantId: 'tenant-c',
        csrfToken: CSRF_OPERATOR_C,
      });
      const res = await httpRequest(`${baseUrl}/admin/api/audit`, {
        headers: { cookie: `du_session=${'T'.repeat(43)}` },
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).code).toBe('TENANT_SCOPE_UNAVAILABLE');
      expect(stub.requests).toHaveLength(0);
    });

    it('viewer OIDC session → 403 (no admin principal), upstream untouched', async () => {
      store.add('W'.repeat(43), { role: 'viewer', tenantId: null, csrfToken: CSRF_VIEWER });
      const res = await httpRequest(`${baseUrl}/admin/api/audit`, {
        headers: { cookie: `du_session=${'W'.repeat(43)}` },
      });
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).code).toBe('PERMISSION_DENIED');
      expect(stub.requests).toHaveLength(0);
    });

    it('legacy operator cookie → 403 (legacy plane has no tenant binding)', async () => {
      const res = await httpRequest(`${baseUrl}/admin/api/audit`, {
        headers: { cookie: legacyCookie('operator') },
      });
      expect(res.status).toBe(403);
      expect(stub.requests).toHaveLength(0);
    });

    it('direct-API leg: the shared RBAC gate denies a foreign tenant for tenant_operator', () => {
      expect(() =>
        authorizeAuditTenantRead({ role: 'tenant_operator', tenantId: 'tenant-a' }, 'tenant-b'),
      ).toThrow(/scoped to the caller tenant/);
      expect(authorizeAuditTenantRead({ role: 'tenant_operator', tenantId: 'tenant-a' }, '')).toBe(
        'tenant-a',
      );
      expect(authorizeAuditTenantRead({ role: 'platform' }, 'tenant-b')).toBe('tenant-b');
    });

    it('upstream 5xx collapses to 502 with no upstream body echoed', async () => {
      stub.queue(500, { code: 'INTERNAL', message: `boom token=${ADMIN_TOKEN}` });
      const res = await httpRequest(`${baseUrl}/admin/api/audit`, {
        headers: { cookie: legacyCookie('admin') },
      });
      expect(res.status).toBe(502);
      const body = JSON.parse(res.body) as { code: string };
      expect(body.code).toBe('UPSTREAM_ERROR');
      expect(res.body).not.toContain(ADMIN_TOKEN);
      expect(res.body).not.toContain('boom');
    });
  });

  describe('POST /admin/api/actions — CSRF + admin-only', () => {
    function post(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
      return httpRequest(`${baseUrl}/admin/api/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      });
    }

    it('anonymous → 401', async () => {
      const res = await post({ action: 'apikey.issue', params: {} });
      expect(res.status).toBe(401);
    });

    it('operator session → 403 before any CSRF/upstream work', async () => {
      const res = await post(
        { action: 'apikey.issue', params: {} },
        { cookie: oidcCookie() },
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).code).toBe('PERMISSION_DENIED');
      expect(stub.requests).toHaveLength(0);
    });

    it('legacy admin without CSRF proof → 403 CSRF_REJECTED, upstream untouched', async () => {
      const res = await post(
        { action: 'apikey.issue', params: {} },
        { cookie: legacyCookie('admin') },
      );
      expect(res.status).toBe(403);
      expect(JSON.parse(res.body).code).toBe('CSRF_REJECTED');
      expect(stub.requests).toHaveLength(0);
    });

    it('legacy admin with derived CSRF → upstream call, idempotency-key forwarded', async () => {
      const cookie = legacyCookie('admin');
      const csrf = deriveCsrfToken(SECRET, cookie.slice('du_admin='.length));
      stub.queue(200, { action: 'apikey.issue', ok: true });
      const res = await post(
        { action: 'apikey.issue', params: { tenantId: 'tenant-b' } },
        { cookie, 'x-csrf-token': csrf, 'idempotency-key': 'idem-aweb02-1' },
      );
      expect(res.status).toBe(200);
      const upstreamReq = stub.requests[0];
      expect(upstreamReq?.method).toBe('POST');
      expect(upstreamReq?.path).toBe('/api/v1/admin/actions');
      expect(upstreamReq?.headers.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
      expect(upstreamReq?.headers['idempotency-key']).toBe('idem-aweb02-1');
      expect(JSON.parse(upstreamReq?.body ?? '{}')).toEqual({
        action: 'apikey.issue',
        params: { tenantId: 'tenant-b' },
      });
      const body = JSON.parse(res.body) as { data: { action: string } };
      expect(body.data.action).toBe('apikey.issue');
      expect(res.body).not.toContain(ADMIN_TOKEN);
    });

    it('OIDC admin uses the session CSRF token (wrong one rejected)', async () => {
      store.add('A'.repeat(43), { role: 'admin', tenantId: null, csrfToken: CSRF_ADMIN });
      const wrong = await post(
        { action: 'apikey.issue', params: {} },
        { cookie: `du_session=${'A'.repeat(43)}`, 'x-csrf-token': 'X'.repeat(43) },
      );
      expect(wrong.status).toBe(403);
      expect(stub.requests).toHaveLength(0);

      stub.queue(200, { action: 'apikey.issue', ok: true });
      const right = await post(
        { action: 'apikey.issue', params: {} },
        { cookie: `du_session=${'A'.repeat(43)}`, 'x-csrf-token': CSRF_ADMIN },
      );
      expect(right.status).toBe(200);
      expect(stub.requests[0]?.headers.authorization).toBe(`Bearer ${ADMIN_TOKEN}`);
    });

    it('invalid JSON / missing action / bad params → 422 INVALID_SCHEMA, no upstream', async () => {
      const cookie = legacyCookie('admin');
      const csrf = deriveCsrfToken(SECRET, cookie.slice('du_admin='.length));
      const headers = { cookie, 'x-csrf-token': csrf };
      const badJson = await httpRequest(`${baseUrl}/admin/api/actions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: '{not json',
      });
      expect(badJson.status).toBe(422);
      const noAction = await post({ params: {} }, headers);
      expect(noAction.status).toBe(422);
      const badParams = await post({ action: 'apikey.issue', params: [] }, headers);
      expect(badParams.status).toBe(422);
      expect(stub.requests).toHaveLength(0);
    });

    it('upstream 409/422 pass through with sanitized field errors', async () => {
      const cookie = legacyCookie('admin');
      const csrf = deriveCsrfToken(SECRET, cookie.slice('du_admin='.length));
      const headers = { cookie, 'x-csrf-token': csrf };
      stub.queue(409, { code: 'REVISION_CONFLICT' });
      const conflict = await post({ action: 'profile.publish', params: {} }, headers);
      expect(conflict.status).toBe(409);
      expect(JSON.parse(conflict.body).code).toBe('REVISION_CONFLICT');

      const longMessage = `\u0000${'x'.repeat(400)}`;
      stub.queue(422, { code: 'INVALID_SCHEMA', errors: [{ pointer: '/params/url', message: longMessage }] });
      const invalid = await post({ action: 'profile.publish', params: {} }, headers);
      expect(invalid.status).toBe(422);
      const body = JSON.parse(invalid.body) as {
        code: string;
        errors: { pointer: string; message: string }[];
      };
      expect(body.code).toBe('INVALID_SCHEMA');
      expect(body.errors[0]?.message.length).toBeLessThanOrEqual(200);
      expect(body.errors[0]?.message).not.toContain('\u0000');
    });
  });

  describe('token hygiene', () => {
    it('no admin/tenant token or cookie secret in the static bundle or shell HTML', async () => {
      if (!fs.existsSync(path.join(DIST_DIR, 'index.html'))) {
        console.warn('dist bundle missing — hygiene scan skipped (run the admin-web build)');
        return;
      }
      const { files, indexHtml } = await readDistBundle();
      expect(files.length).toBeGreaterThan(0);
      for (const token of [ADMIN_TOKEN, TENANT_A_TOKEN, TENANT_B_TOKEN, SECRET]) {
        expect(indexHtml).not.toContain(token);
        for (const asset of files) {
          expect(asset.text).not.toContain(token);
        }
      }
      expect(indexHtml).not.toContain('adminToken');
    });

    it('BFF responses never echo the platform or tenant tokens', async () => {
      const session = await httpRequest(`${baseUrl}/admin/api/session`, {
        headers: { cookie: legacyCookie('admin') },
      });
      const audit = await httpRequest(`${baseUrl}/admin/api/audit`, {
        headers: { cookie: oidcCookie() },
      });
      for (const res of [session, audit]) {
        expect(res.body).not.toContain(ADMIN_TOKEN);
        expect(res.body).not.toContain(TENANT_A_TOKEN);
        expect(res.body).not.toContain(TENANT_B_TOKEN);
      }
    });
  });
});
