/**
 * AWEB-06 — BFF operations/usage/business routes (focused, offline).
 * Fence + forwarding: session principal, tenant param forced from the session,
 * platform-scoped business registry, CSRF on business actions, allow-lists.
 */
import http from 'node:http';
import { connect } from 'node:net';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'aweb06-cookie-secret';
const ADMIN_TOKEN = 'aweb06-platform-admin-token';
const TENANT_A_TOKEN = 'aweb06-tenant-a-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OPERATOR_SESSION = 'O'.repeat(43);
const VIEWER_SESSION = 'W'.repeat(43);
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

const PORT_BASE = 46_900 + (process.pid % 11) * 19;
let portCursor = 0;
const nextPort = (): number => PORT_BASE + portCursor++;

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
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
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }),
        );
      },
    );
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

function rawGet(port: number, target: string, cookie: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => {
      socket.write(`GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`);
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => resolve(Number.parseInt(data.substring(9, 12), 10)));
    socket.on('error', reject);
  });
}

interface Captured {
  method: string;
  path: string;
  auth: string | null;
  body?: string;
  idempotencyKey?: string;
}

interface Stub {
  url: string;
  requests: Captured[];
  close(): Promise<void>;
}

function startStub(port: number): Promise<Stub> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', chunk => { body += String(chunk); });
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        body, idempotencyKey: String(req.headers['idempotency-key'] ?? ''),
        auth: typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
      });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/v1/admin/actions') { res.statusCode = 200; res.end(JSON.stringify({ operationId: 'retry-new', state: 'ACCEPTED' })); return; }
      if (url.pathname === '/api/v1/operations') {
        res.statusCode = 200;
        res.end(JSON.stringify({ items: [{ id: 'op-1', state: 'RUNNING' }], nextCursor: null, prevCursor: null, total: 1, limit: 20 }));
        return;
      }
      if (url.pathname.startsWith('/api/v1/operations/')) {
        res.statusCode = 200;
        res.end(JSON.stringify({ operation: { id: 'op-1', state: 'RUNNING' }, artifacts: [] }));
        return;
      }
      if (url.pathname === '/api/v1/usage') {
        res.statusCode = 200;
        res.end(JSON.stringify({ requests: 1 }));
        return;
      }
      if (url.pathname === '/api/v1/admin/businesses') {
        res.statusCode = 200;
        res.end(JSON.stringify({ items: [], nextCursor: null, prevCursor: null, total: 0, limit: 50 }));
        return;
      }
      if (/^\/api\/v1\/admin\/businesses\/[^/]+\/versions/.test(url.pathname)) {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'NOT_FOUND' }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
        close: () => new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
      });
    });
  });
}

class MapSessionStore implements AdminSessionStore {
  private readonly records = new Map<string, AdminSessionView>();
  add(sessionId: string, view: AdminSessionView): void {
    this.records.set(sessionId, view);
  }
  async get(sessionId: string): Promise<AdminSessionView | null> {
    return this.records.get(sessionId) ?? null;
  }
}

function legacyCookie(role: 'admin' | 'operator' | 'viewer'): string {
  const nowMs = Date.now();
  const value = signCookie(SECRET, { iss: 'du-admin-shell', role, iat: nowMs, exp: nowMs + 3_600_000 });
  if (!value) throw new Error('signCookie returned undefined');
  return `du_admin=${value}`;
}

describe('AWEB-06 BFF operations/usage/business routes', () => {
  let stub: Stub;
  let handle: AdminShellHandle;
  let baseUrl: string;
  let csrfToken: string;
  let adminCookie: string;

  beforeAll(async () => {
    stub = await startStub(nextPort());
    const store = new MapSessionStore();
    store.add(OPERATOR_SESSION, { role: 'operator', tenantId: TENANT_A, csrfToken: 'C'.repeat(43) });
    store.add(VIEWER_SESSION, { role: 'viewer', tenantId: null, csrfToken: 'V'.repeat(43) });
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
    const bound = await handle.listen();
    baseUrl = bound.url;
    adminCookie = legacyCookie('admin');
    const session = await httpRequest(`${baseUrl}/admin/api/session`, { headers: { cookie: adminCookie } });
    csrfToken = (JSON.parse(session.body) as { csrfToken: string }).csrfToken;
  });

  afterAll(async () => {
    await handle.close();
    await stub.close();
  });

  beforeEach(() => {
    stub.requests.length = 0;
  });

  const last = (): Captured | undefined => stub.requests[stub.requests.length - 1];

  it('admin retry forwards POST with CSRF, idempotency and server-owned action', async () => {
    const response = await httpRequest(`${baseUrl}/admin/api/operations/op-1/retry`, {
      method: 'POST', headers: { cookie: adminCookie, 'x-csrf-token': csrfToken, 'idempotency-key': 'retry-once' }, body: '{}',
    });
    expect(response.status).toBe(200);
    expect(last()).toMatchObject({ method: 'POST', path: '/api/v1/admin/actions', auth: `Bearer ${ADMIN_TOKEN}`, idempotencyKey: 'retry-once' });
    expect(JSON.parse(last()!.body!)).toEqual({ action: 'operations.retry', params: { operationId: 'op-1' } });
  });
  it('operator stop uses own tenant credential; retry is denied', async () => {
    const headers = { cookie: `du_session=${OPERATOR_SESSION}`, 'x-csrf-token': 'C'.repeat(43) };
    expect((await httpRequest(`${baseUrl}/admin/api/operations/op-1/cancel`, { method: 'POST', headers, body: '{}' })).status).toBe(200);
    expect(last()!.auth).toBe(`Bearer ${TENANT_A_TOKEN}`);
    stub.requests.length = 0;
    expect((await httpRequest(`${baseUrl}/admin/api/operations/op-1/retry`, { method: 'POST', headers, body: '{}' })).status).toBe(403);
    expect(stub.requests).toHaveLength(0);
  });
  it('control denies missing CSRF, GET and request overrides before upstream', async () => {
    expect((await httpRequest(`${baseUrl}/admin/api/operations/op-1/cancel`, { method: 'POST', headers: { cookie: adminCookie } })).status).toBe(403);
    expect((await httpRequest(`${baseUrl}/admin/api/operations/op-1/retry`, { headers: { cookie: adminCookie } })).status).toBe(405);
    expect((await httpRequest(`${baseUrl}/admin/api/operations/op-1/retry`, { method: 'POST', headers: { cookie: adminCookie, 'x-csrf-token': csrfToken }, body: '{"tenantId":"foreign"}' })).status).toBe(422);
    expect(stub.requests).toHaveLength(0);
  });

  it('anonymous → 401; viewer → 403 on operations', async () => {
    const anon = await httpRequest(`${baseUrl}/admin/api/operations`);
    expect(anon.status).toBe(401);
    const viewer = await httpRequest(`${baseUrl}/admin/api/operations`, {
      headers: { cookie: `du_session=${VIEWER_SESSION}` },
    });
    expect(viewer.status).toBe(403);
    expect(stub.requests).toHaveLength(0);
  });

  it('operator list → own tenant credential, tenant forced, allow-list only', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/operations?state=RUNNING&evil=dropme&tenant=${TENANT_B}`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERMISSION_DENIED');
    expect(stub.requests).toHaveLength(0);

    const own = await httpRequest(`${baseUrl}/admin/api/operations?state=RUNNING&evil=dropme`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    expect(own.status).toBe(200);
    const upstream = last();
    expect(upstream?.auth).toBe(`Bearer ${TENANT_A_TOKEN}`);
    expect(upstream?.path).toContain('state=RUNNING');
    expect(upstream?.path).toContain(`tenant=${TENANT_A}`);
    expect(upstream?.path).not.toContain('evil');
    expect(upstream?.path).not.toContain(TENANT_B);
  });

  it('admin list → platform bearer; detail passthrough; dot-segment id → 404 before upstream', async () => {
    const cookie = adminCookie;
    const list = await httpRequest(`${baseUrl}/admin/api/operations?limit=5`, { headers: { cookie } });
    expect(list.status).toBe(200);
    expect(last()?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(last()?.path).toContain('limit=5');

    const detail = await httpRequest(`${baseUrl}/admin/api/operations/op-1`, { headers: { cookie } });
    expect(detail.status).toBe(200);
    expect(last()?.path).toBe('/api/v1/operations/op-1');

    stub.requests.length = 0;
    const port = Number(new URL(baseUrl).port);
    const traversal = await rawGet(port, '/admin/api/operations/..', cookie);
    expect(traversal).toBe(404);
    expect(stub.requests).toHaveLength(0);
  });

  it('platform usage without tenantId fails at BFF with actionable error and no upstream request', async () => {
    const response = await httpRequest(`${baseUrl}/admin/api/usage?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`, {
      headers: { cookie: adminCookie },
    });
    expect(response.status).toBe(422);
    expect(JSON.parse(response.body)).toMatchObject({ code: 'INVALID_SCHEMA', title: 'usage requires a tenantId for platform sessions' });
    expect(stub.requests).toHaveLength(0);
  });

  it('tenant usage defaults to session scope and rejects a foreign tenant', async () => {
    const url = `${baseUrl}/admin/api/usage?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z`;
    const headers = { cookie: `du_session=${OPERATOR_SESSION}` };
    expect((await httpRequest(url, { headers })).status).toBe(200);
    expect(last()?.path).toContain(`tenantId=${TENANT_A}`);
    expect(last()?.auth).toBe(`Bearer ${TENANT_A_TOKEN}`);
    stub.requests.length = 0;
    expect((await httpRequest(`${url}&tenantId=${TENANT_B}`, { headers })).status).toBe(403);
    expect(stub.requests).toHaveLength(0);
  });

  it('usage requires from/to (422 before upstream) and forwards the tenant scope', async () => {
    const cookie = adminCookie;
    const missing = await httpRequest(`${baseUrl}/admin/api/usage`, { headers: { cookie } });
    expect(missing.status).toBe(422);
    expect(stub.requests).toHaveLength(0);

    const ok = await httpRequest(
      `${baseUrl}/admin/api/usage?from=2026-10-01T00:00:00Z&to=2026-10-02T00:00:00Z&tenantId=${TENANT_A}`,
      { headers: { cookie } },
    );
    expect(ok.status).toBe(200);
    expect(last()?.path).toContain(`tenantId=${TENANT_A}`);
  });

  it('business registry is platform-scoped: operator 403 before upstream', async () => {
    const operator = await httpRequest(`${baseUrl}/admin/api/businesses`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    expect(operator.status).toBe(403);
    expect(JSON.parse(operator.body).code).toBe('ADMIN_CREDENTIAL_REQUIRED');
    const versions = await httpRequest(`${baseUrl}/admin/api/businesses/doc-core/versions`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    expect(versions.status).toBe(403);
    expect(stub.requests).toHaveLength(0);
  });

  it('business action: CSRF required, then PUT forwarded with the platform bearer', async () => {
    const noCsrf = await httpRequest(`${baseUrl}/admin/api/businesses/doc-core/versions/3/enable`, {
      method: 'PUT',
      headers: { cookie: adminCookie },
    });
    expect(noCsrf.status).toBe(403);
    expect(JSON.parse(noCsrf.body).code).toBe('CSRF_REJECTED');
    expect(stub.requests).toHaveLength(0);

    const ok = await httpRequest(`${baseUrl}/admin/api/businesses/doc-core/versions/3/enable`, {
      method: 'PUT',
      headers: { cookie: adminCookie, 'x-csrf-token': csrfToken },
    });
    expect(ok.status).toBe(200);
    const upstream = last();
    expect(upstream?.method).toBe('PUT');
    expect(upstream?.path).toBe('/api/v1/admin/businesses/doc-core/versions/3/enable');
    expect(upstream?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it('GET on a business action → 405; no token leaks into responses', async () => {
    const wrongMethod = await httpRequest(`${baseUrl}/admin/api/businesses/doc-core/versions/3/enable`, {
      headers: { cookie: adminCookie },
    });
    expect(wrongMethod.status).toBe(405);

    const list = await httpRequest(`${baseUrl}/admin/api/businesses`, { headers: { cookie: adminCookie } });
    expect(list.body).not.toContain(ADMIN_TOKEN);
    expect(list.body).not.toContain(TENANT_A_TOKEN);
  });
});
