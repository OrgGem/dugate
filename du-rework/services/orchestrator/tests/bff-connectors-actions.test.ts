/**
 * CONNECTOR-WIRE-B (BFF branch) — connector management wire (focused, offline).
 *
 * Real shell server over loopback HTTP against a scripted upstream stub:
 *  - GET  /admin/api/connectors              → list passthrough (`{items}`)
 *  - GET  /admin/api/connectors/capabilities → composition advertisement
 *  - POST /admin/api/actions connector.*     → dispatcher passthrough
 *    (upsert 201 / activate CAS-loss 409 / test 200 / unknown 404)
 *
 * Fences pinned here:
 *  - session gate (401) with ZERO upstream calls;
 *  - platform-admin fence: a tenant_operator whose bearer IS configured is
 *    still refused locally (the upstream connector routes are platform-only),
 *    so no tenant token ever rides to an endpoint that can only reject it;
 *  - CSRF proof required before the dispatcher is reached;
 *  - 405 on the wrong method for both route families;
 *  - upstream 5xx collapses to 502 UPSTREAM_ERROR with no upstream text;
 *  - 409 keeps the code and sanitises field errors (raw body never echoed);
 *  - the browser cookie / authorization header is never forwarded upstream.
 */
import http from 'node:http';
import { connect } from 'node:net';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'cwb-bff-cookie-secret';
const ADMIN_TOKEN = 'cwb-bff-platform-admin-token';
const TENANT_A_TOKEN = 'cwb-bff-tenant-a-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const OPERATOR_SESSION = 'O'.repeat(43);
const VIEWER_SESSION = 'W'.repeat(43);
/** Must never appear on a BFF wire, in any status class. */
const UPSTREAM_SECRET = 'cwb-upstream-internal-detail-9f2c';
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

const PORT_BASE = 46_100 + (process.pid % 19) * 11;
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

/**
 * Raw-socket request: the URL constructor resolves dot segments client-side,
 * so a literal `..` connector segment can only be exercised by writing the
 * request line directly (the F-AW05-1 seam the new routes must not reopen).
 */
function rawRequest(port: number, target: string, cookie: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const socket = connect(port, '127.0.0.1');
    let data = '';
    socket.on('connect', () => {
      socket.write(
        `GET ${target} HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nCookie: ${cookie}\r\nConnection: close\r\n\r\n`,
      );
    });
    socket.on('data', (chunk) => {
      data += chunk.toString('utf8');
    });
    socket.on('end', () => {
      const status = Number.parseInt(data.substring(9, 12), 10);
      const headerEnd = data.indexOf('\r\n\r\n');
      resolve({ status, body: headerEnd >= 0 ? data.slice(headerEnd + 4) : '' });
    });
    socket.on('error', reject);
  });
}

interface Captured {
  method: string;
  path: string;
  auth: string | null;
  cookie: string | null;
  idempotencyKey: string | null;
  body: string;
}

interface Stub {
  url: string;
  requests: Captured[];
  /** Mutated per test to steer the upstream list response. */
  state: { listStatus: number };
  close(): Promise<void>;
}

const REVISION = {
  connectorId: 'openai',
  revision: 2,
  adapter: 'openai-compatible',
  state: 'PENDING',
  config: { headers: { authorization: '[REDACTED]' }, basePath: '/v1' },
  credentialRef: 'vault:conn/openai',
  tenantId: TENANT_A,
  accountId: 'acct-1',
};

function startStub(port: number): Promise<Stub> {
  const requests: Captured[] = [];
  const state = { listStatus: 200 };
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
        cookie: typeof req.headers.cookie === 'string' ? req.headers.cookie : null,
        idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null,
        body,
      });
      res.setHeader('content-type', 'application/json');

      if (url.pathname === '/api/v1/admin/connectors/capabilities') {
        res.statusCode = 200;
        res.end(JSON.stringify({ management: true, credentialWorkflow: false, test: true }));
        return;
      }
      if (url.pathname === '/api/v1/admin/connectors') {
        if (state.listStatus !== 200) {
          res.statusCode = state.listStatus;
          res.end(JSON.stringify({ code: 'TEMPORARY_UNAVAILABLE', detail: UPSTREAM_SECRET }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify({ items: [REVISION] }));
        return;
      }
      if (url.pathname === '/api/v1/admin/actions') {
        const parsed = JSON.parse(body) as { action: string; params?: Record<string, unknown> };
        if (parsed.action === 'connector.upsert') {
          res.statusCode = 201;
          res.end(JSON.stringify({ ...REVISION, state: 'PENDING' }));
          return;
        }
        if (parsed.action === 'connector.activate' && parsed.params?.revision === 99) {
          res.statusCode = 409;
          res.end(
            JSON.stringify({
              code: 'STATE_CONFLICT',
              detail: UPSTREAM_SECRET,
              errors: [
                { pointer: '/expectedCurrentRevision', message: 'chain moved' },
                { pointer: '', message: 'no pointer → dropped' },
                { pointer: '/junk', message: 'bad\u0000control\u0000', extra: 'not copied' },
              ],
            }),
          );
          return;
        }
        if (parsed.action === 'connector.activate') {
          res.statusCode = 200;
          res.end(JSON.stringify({ connectorId: 'openai', revision: 2, activated: true }));
          return;
        }
        if (parsed.action === 'connector.test') {
          res.statusCode = 200;
          res.end(JSON.stringify({ connectorId: 'openai', ok: true }));
          return;
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ code: 'ACTION_NOT_FOUND', detail: UPSTREAM_SECRET }));
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
        state,
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

describe('CONNECTOR-WIRE-B BFF connector reads + actions', () => {
  let stub: Stub;
  let store: MapSessionStore;
  let handle: AdminShellHandle;
  let baseUrl: string;
  let adminCookie: string;

  beforeAll(async () => {
    stub = await startStub(nextPort());
    store = new MapSessionStore();
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
  });

  afterAll(async () => {
    await handle.close();
    await stub.close();
  });

  beforeEach(() => {
    stub.requests.length = 0;
    stub.state.listStatus = 200;
  });

  const last = (): Captured | undefined => stub.requests[stub.requests.length - 1];

  async function csrfToken(): Promise<string> {
    const session = await httpRequest(`${baseUrl}/admin/api/session`, { headers: { cookie: adminCookie } });
    return (JSON.parse(session.body) as { csrfToken: string }).csrfToken;
  }

  async function postAction(
    action: string,
    params: Record<string, unknown>,
    opts: { csrf?: string; key?: string; cookie?: string | null } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    const cookie = opts.cookie === undefined ? adminCookie : opts.cookie;
    if (cookie !== null) headers.cookie = cookie;
    if (opts.csrf !== undefined) headers['x-csrf-token'] = opts.csrf;
    if (opts.key !== undefined) headers['idempotency-key'] = opts.key;
    return httpRequest(`${baseUrl}/admin/api/actions`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ action, params }),
    });
  }

  // --- session gate -------------------------------------------------------

  it('anonymous → 401 problem on both connector reads, zero upstream calls', async () => {
    const list = await httpRequest(`${baseUrl}/admin/api/connectors`);
    const capabilities = await httpRequest(`${baseUrl}/admin/api/connectors/capabilities`);
    for (const res of [list, capabilities]) {
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(res.headers['cache-control']).toBe('no-store');
      expect((JSON.parse(res.body) as { code: string }).code).toBe('UNAUTHENTICATED');
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('viewer → 403 PERMISSION_DENIED, zero upstream calls', async () => {
    const cookie = `du_session=${VIEWER_SESSION}`;
    for (const path of ['/admin/api/connectors', '/admin/api/connectors/capabilities']) {
      const res = await httpRequest(`${baseUrl}${path}`, { headers: { cookie } });
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as { code: string }).code).toBe('PERMISSION_DENIED');
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('tenant operator with a CONFIGURED bearer is still refused locally (platform-only fence)', async () => {
    const cookie = `du_session=${OPERATOR_SESSION}`;
    for (const path of ['/admin/api/connectors', '/admin/api/connectors/capabilities']) {
      const res = await httpRequest(`${baseUrl}${path}`, { headers: { cookie } });
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as { code: string }).code).toBe('PERMISSION_DENIED');
    }
    // No tenant token rode upstream: the upstream connector routes are
    // platform-only, so the fence is local and costs no upstream call.
    expect(stub.requests).toHaveLength(0);
  });

  // --- reads --------------------------------------------------------------

  it('platform admin list → upstream truth, platform bearer, no params, no cookie relayed', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/connectors?evil=dropme`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-type']).toContain('application/json');
    const body = JSON.parse(res.body) as { items: Array<{ connectorId: string; config: { headers: unknown } }> };
    expect(body.items).toHaveLength(1);
    expect(body.items[0]?.connectorId).toBe('openai');
    // Redaction is the connector's contract and survives the hop unchanged.
    expect(body.items[0]?.config.headers).toEqual({ authorization: '[REDACTED]' });

    const upstream = last();
    expect(upstream?.method).toBe('GET');
    expect(upstream?.path).toBe('/api/v1/admin/connectors');
    expect(upstream?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(upstream?.cookie).toBeNull();
  });

  it('platform admin capabilities → booleans relayed verbatim (false is not flattened)', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/connectors/capabilities`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ management: true, credentialWorkflow: false, test: true });
    expect(last()?.path).toBe('/api/v1/admin/connectors/capabilities');
    expect(last()?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it('upstream 5xx collapses to 502 UPSTREAM_ERROR with no upstream text', async () => {
    stub.state.listStatus = 503;
    const res = await httpRequest(`${baseUrl}/admin/api/connectors`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(502);
    const body = JSON.parse(res.body) as { code: string; status: number; title: string };
    expect(body.code).toBe('UPSTREAM_ERROR');
    expect(body.status).toBe(502);
    expect(res.body).not.toContain(UPSTREAM_SECRET);
    expect(res.body).not.toContain('TEMPORARY_UNAVAILABLE');
  });

  it('unreachable upstream → 503 UPSTREAM_UNAVAILABLE', async () => {
    const dead = createAdminShellServer({
      port: nextPort(),
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: ADMIN_TOKEN,
      jsonBaseUrl: `http://127.0.0.1:${nextPort()}`,
      adminWeb: { distDir: 'Z:/does-not-exist' },
      cookiePolicy: COOKIE_POLICY,
    });
    const bound = await dead.listen();
    try {
      const res = await httpRequest(`${bound.url}/admin/api/connectors`, { headers: { cookie: adminCookie } });
      expect(res.status).toBe(503);
      expect((JSON.parse(res.body) as { code: string }).code).toBe('UPSTREAM_UNAVAILABLE');
    } finally {
      await dead.close();
    }
  });

  it('wrong method → 405 on both connector reads, zero upstream calls', async () => {
    for (const path of ['/admin/api/connectors', '/admin/api/connectors/capabilities']) {
      const res = await httpRequest(`${baseUrl}${path}`, {
        method: 'POST',
        headers: { cookie: adminCookie, 'content-type': 'application/json' },
        body: '{}',
      });
      expect(res.status).toBe(405);
      expect((JSON.parse(res.body) as { code: string }).code).toBe('METHOD_NOT_ALLOWED');
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('literal ".." connector segment still 404 before upstream (new routes do not shadow the fence)', async () => {
    const port = Number(new URL(baseUrl).port);
    const res = await rawRequest(port, '/admin/api/connectors/../revisions/1', adminCookie);
    expect(res.status).toBe(404);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('NOT_FOUND');
    expect(stub.requests).toHaveLength(0);
  });

  // --- actions ------------------------------------------------------------

  it('GET /admin/api/actions → 405 (mutation surface only accepts POST)', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/actions`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(405);
    expect(stub.requests).toHaveLength(0);
  });

  it('anonymous / viewer / operator actions → 401 then 403, zero upstream calls', async () => {
    const anonymous = await postAction('connector.upsert', { mode: 'create' }, { cookie: null });
    expect(anonymous.status).toBe(401);
    expect((JSON.parse(anonymous.body) as { code: string }).code).toBe('UNAUTHENTICATED');
    for (const cookie of [`du_session=${VIEWER_SESSION}`, `du_session=${OPERATOR_SESSION}`]) {
      const res = await postAction('connector.upsert', { mode: 'create' }, { cookie });
      expect(res.status).toBe(403);
      expect((JSON.parse(res.body) as { code: string }).code).toBe('PERMISSION_DENIED');
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('admin without CSRF proof → 403 CSRF_REJECTED before the dispatcher', async () => {
    const res = await postAction('connector.upsert', { mode: 'create' });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('CSRF_REJECTED');
    expect(stub.requests).toHaveLength(0);
  });

  it('malformed action envelope → 422 without upstream', async () => {
    const csrf = await csrfToken();
    stub.requests.length = 0;
    const notJson = await httpRequest(`${baseUrl}/admin/api/actions`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '{not json',
    });
    expect(notJson.status).toBe(422);
    const badAction = await postAction('Connector.Upsert!', {}, { csrf });
    expect(badAction.status).toBe(422);
    const arrayBody = await httpRequest(`${baseUrl}/admin/api/actions`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: '[]',
    });
    expect(arrayBody.status).toBe(422);
    expect(stub.requests).toHaveLength(0);
  });

  it('connector.upsert → 201 wrapped in data, params verbatim, key clamped to 200', async () => {
    const csrf = await csrfToken();
    stub.requests.length = 0;
    const params = {
      mode: 'create',
      connectorId: 'openai',
      adapter: 'openai-compatible',
      config: { basePath: '/v1' },
      credentialRef: 'vault:conn/openai',
    };
    const res = await postAction('connector.upsert', params, { csrf, key: 'k'.repeat(260) });
    expect(res.status).toBe(201);
    const body = JSON.parse(res.body) as { data: { connectorId: string; revision: number } };
    expect(body.data.connectorId).toBe('openai');
    expect(body.data.revision).toBe(2);

    const upstream = last();
    expect(upstream?.method).toBe('POST');
    expect(upstream?.path).toBe('/api/v1/admin/actions');
    expect(upstream?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(upstream?.cookie).toBeNull();
    expect(upstream?.idempotencyKey).toHaveLength(200);
    expect(JSON.parse(upstream?.body ?? '{}')).toEqual({ action: 'connector.upsert', params });
  });

  it('connector.activate CAS loss → 409 STATE_CONFLICT, sanitised errors, raw body never echoed', async () => {
    const csrf = await csrfToken();
    stub.requests.length = 0;
    const res = await postAction(
      'connector.activate',
      { connectorId: 'openai', revision: 99, expectedCurrentRevision: 1 },
      { csrf },
    );
    expect(res.status).toBe(409);
    expect(res.headers['content-type']).toContain('application/problem+json');
    const body = JSON.parse(res.body) as {
      code: string;
      status: number;
      detail?: string;
      errors?: Array<{ pointer: string; message: string }>;
    };
    expect(body.code).toBe('STATE_CONFLICT');
    expect(body.status).toBe(409);
    expect(res.body).not.toContain(UPSTREAM_SECRET);
    expect(body.detail).toBeUndefined();
    // Sanitiser contract: the empty-pointer entry is dropped, control
    // characters are stripped, and unknown fields are not copied.
    expect(body.errors).toEqual([
      { pointer: '/expectedCurrentRevision', message: 'chain moved' },
      { pointer: '/junk', message: 'bad control' },
    ]);
  });

  it('connector.test / connector.activate happy path relay the dispatcher body', async () => {
    const csrf = await csrfToken();
    stub.requests.length = 0;
    const tested = await postAction('connector.test', { connectorId: 'openai' }, { csrf });
    expect(tested.status).toBe(200);
    expect(JSON.parse(tested.body)).toEqual({ data: { connectorId: 'openai', ok: true } });

    const activated = await postAction(
      'connector.activate',
      { connectorId: 'openai', revision: 2, expectedCurrentRevision: 1 },
      { csrf },
    );
    expect(activated.status).toBe(200);
    expect(JSON.parse(activated.body)).toEqual({ data: { connectorId: 'openai', revision: 2, activated: true } });
  });

  it('unknown connector action → upstream 404 ACTION_NOT_FOUND, detail dropped', async () => {
    const csrf = await csrfToken();
    stub.requests.length = 0;
    const res = await postAction('connector.ghost', { connectorId: 'openai' }, { csrf });
    expect(res.status).toBe(404);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('ACTION_NOT_FOUND');
    expect(res.body).not.toContain(UPSTREAM_SECRET);
  });
});
