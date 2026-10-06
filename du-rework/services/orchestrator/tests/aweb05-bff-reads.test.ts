/**
 * AWEB-05 — BFF read routes for api-keys + connector revisions (focused, offline).
 *
 * Real shell server over loopback HTTP against a scripted upstream stub:
 *  - GET /admin/api/api-keys[/:id]  (principal-aware, tenant-fenced)
 *  - GET /admin/api/connectors/:id/revisions/:rev (upstream truth, incl. 404)
 *  - POST /admin/api/actions apikey.issue passthrough: rawKey rides ONCE,
 *    no-store, and never appears on a later read.
 */
import http from 'node:http';
import { connect } from 'node:net';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'aweb05-cookie-secret';
const ADMIN_TOKEN = 'aweb05-platform-admin-token';
const TENANT_A_TOKEN = 'aweb05-tenant-a-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OPERATOR_SESSION = 'O'.repeat(43);
const VIEWER_SESSION = 'W'.repeat(43);
const RAW_KEY = 'du_test_copy_once_raw_key_9f2c';
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

const PORT_BASE = 45_600 + (process.pid % 17) * 13;
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

interface Captured {
  method: string;
  path: string;
  auth: string | null;
}

/**
 * Raw-socket request: the URL constructor resolves dot segments client-side,
 * so the only way to exercise `decodePathSegment` with a literal `..` is to
 * write the request line ourselves (the F-AW05-1 regression seam).
 */
function rawRequest(
  port: number,
  target: string,
  cookie: string,
): Promise<{ status: number; body: string }> {
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

interface Stub {
  url: string;
  requests: Captured[];
  close(): Promise<void>;
}

function startStub(port: number): Promise<Stub> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        auth: typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
      });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/v1/admin/actions') {
        res.statusCode = 201;
        res.end(
          JSON.stringify({
            action: 'apikey.issue',
            id: 'bbbbbbbb-2222-4222-8222-222222222222',
            prefix: 'du_live_new',
            status: 'ACTIVE',
            rawKey: RAW_KEY,
          }),
        );
        return;
      }
      if (url.pathname.startsWith('/api/v1/admin/connectors/')) {
        if (url.pathname.includes('not-configured')) {
          res.statusCode = 404;
          res.end(JSON.stringify({ code: 'NOT_FOUND' }));
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            connectorId: 'openai',
            revision: 1,
            adapter: 'unknown',
            endpoint: { kind: 'configured', maskedHost: 'o***:443' },
            capabilities: [],
            state: 'disabled',
            createdAt: '2026-10-01T00:00:00.000Z',
            updatedAt: '2026-10-01T00:00:00.000Z',
            secretSlots: [],
            testResult: null,
          }),
        );
        return;
      }
      if (url.pathname.startsWith('/api/v1/admin/api-keys')) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            items: [
              {
                id: 'aaaaaaaa-1111-4111-8111-111111111111',
                tenantId: TENANT_A,
                prefix: 'du_live_ab12',
                maskedHint: 'du_live_ab12',
                status: 'ACTIVE',
                createdAt: '2026-10-01T08:00:00.000Z',
                updatedAt: '2026-10-01T08:00:00.000Z',
              },
            ],
            nextCursor: null,
            prevCursor: null,
            total: 1,
            limit: 25,
            grants: [],
            createCopyOnce: null,
          }),
        );
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

describe('AWEB-05 BFF api-keys + connectors routes', () => {
  let stub: Stub;
  let store: MapSessionStore;
  let handle: AdminShellHandle;
  let baseUrl: string;

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
  });

  afterAll(async () => {
    await handle.close();
    await stub.close();
  });

  beforeEach(() => {
    stub.requests.length = 0;
  });

  const last = (): Captured | undefined => stub.requests[stub.requests.length - 1];

  it('anonymous → 401 problem on both read routes', async () => {
    const keys = await httpRequest(`${baseUrl}/admin/api/api-keys`);
    const connectors = await httpRequest(`${baseUrl}/admin/api/connectors/openai/revisions/latest`);
    for (const res of [keys, connectors]) {
      expect(res.status).toBe(401);
      expect(res.headers['content-type']).toContain('application/problem+json');
      expect(JSON.parse(res.body).code).toBe('UNAUTHENTICATED');
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('viewer → 403 with no upstream call', async () => {
    const cookie = `du_session=${VIEWER_SESSION}`;
    const keys = await httpRequest(`${baseUrl}/admin/api/api-keys`, { headers: { cookie } });
    expect(keys.status).toBe(403);
    expect(JSON.parse(keys.body).code).toBe('PERMISSION_DENIED');
    expect(stub.requests).toHaveLength(0);
  });

  it('legacy admin → platform bearer + allow-listed params only', async () => {
    const res = await httpRequest(
      `${baseUrl}/admin/api/api-keys?limit=10&status=ACTIVE&evil=dropme`,
      { headers: { cookie: legacyCookie('admin') } },
    );
    expect(res.status).toBe(200);
    const upstream = last();
    expect(upstream?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(upstream?.path).toContain('limit=10');
    expect(upstream?.path).toContain('status=ACTIVE');
    expect(upstream?.path).not.toContain('evil');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('operator tenant-a → own credential + forced tenant; foreign tenant 403, untouched', async () => {
    const cookie = `du_session=${OPERATOR_SESSION}`;
    const own = await httpRequest(`${baseUrl}/admin/api/api-keys`, { headers: { cookie } });
    expect(own.status).toBe(200);
    expect(last()?.auth).toBe(`Bearer ${TENANT_A_TOKEN}`);
    expect(last()?.path).toContain(`tenantId=${TENANT_A}`);

    stub.requests.length = 0;
    const foreign = await httpRequest(`${baseUrl}/admin/api/api-keys?tenantId=${TENANT_B}`, {
      headers: { cookie },
    });
    expect(foreign.status).toBe(403);
    expect(JSON.parse(foreign.body).code).toBe('PERMISSION_DENIED');
    expect(stub.requests).toHaveLength(0);
  });

  it('by-id read forwards the encoded id; malformed id → 404 without upstream', async () => {
    const cookie = legacyCookie('admin');
    const ok = await httpRequest(
      `${baseUrl}/admin/api/api-keys/${encodeURIComponent('aaaaaaaa-1111-4111-8111-111111111111')}`,
      { headers: { cookie } },
    );
    expect(ok.status).toBe(200);
    expect(last()?.path).toBe('/api/v1/admin/api-keys/aaaaaaaa-1111-4111-8111-111111111111');

    stub.requests.length = 0;
    const bad = await httpRequest(`${baseUrl}/admin/api/api-keys/${'x'.repeat(200)}`, { headers: { cookie } });
    expect(bad.status).toBe(404);
    expect(stub.requests).toHaveLength(0);
  });

  it('F-AW05-1 AC5: literal ".." api-key id → 404 before upstream (raw target)', async () => {
    const port = Number(new URL(baseUrl).port);
    const res = await rawRequest(port, '/admin/api/api-keys/..', legacyCookie('admin'));
    expect(res.status).toBe(404);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('NOT_FOUND');
    expect(stub.requests).toHaveLength(0);
  });

  it('F-AW05-1 AC9: literal ".." connector segment → 404 before upstream (raw target)', async () => {
    const port = Number(new URL(baseUrl).port);
    const res = await rawRequest(port, '/admin/api/connectors/../revisions/1', legacyCookie('admin'));
    expect(res.status).toBe(404);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('NOT_FOUND');
    expect(stub.requests).toHaveLength(0);
  });

  it('connector revision passthrough: 200 payload, 404 not-configured, POST 405', async () => {
    const cookie = legacyCookie('admin');
    const ok = await httpRequest(`${baseUrl}/admin/api/connectors/openai/revisions/latest`, { headers: { cookie } });
    expect(ok.status).toBe(200);
    const body = JSON.parse(ok.body) as { adapter: string; endpoint: { maskedHost: string } };
    expect(body.adapter).toBe('unknown');
    expect(body.endpoint.maskedHost).toBe('o***:443');
    expect(last()?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);

    const missing = await httpRequest(`${baseUrl}/admin/api/connectors/not-configured/revisions/1`, {
      headers: { cookie },
    });
    expect(missing.status).toBe(404);
    expect(JSON.parse(missing.body).code).toBe('NOT_FOUND');

    const wrongMethod = await httpRequest(`${baseUrl}/admin/api/connectors/openai/revisions/latest`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(wrongMethod.status).toBe(405);
  });

  it('issue passes rawKey exactly once (no-store); a later read never contains it', async () => {
    const cookie = legacyCookie('admin');
    const session = await httpRequest(`${baseUrl}/admin/api/session`, { headers: { cookie } });
    const csrf = (JSON.parse(session.body) as { csrfToken: string }).csrfToken;
    const issue = await httpRequest(`${baseUrl}/admin/api/actions`, {
      method: 'POST',
      headers: { cookie, 'content-type': 'application/json', 'x-csrf-token': csrf },
      body: JSON.stringify({ action: 'apikey.issue', params: { tenantId: TENANT_A } }),
    });
    expect(issue.status).toBe(201);
    expect(issue.headers['cache-control']).toBe('no-store');
    const issued = JSON.parse(issue.body) as { data: { rawKey: string } };
    expect(issued.data.rawKey).toBe(RAW_KEY);

    const read = await httpRequest(`${baseUrl}/admin/api/api-keys`, { headers: { cookie } });
    expect(read.status).toBe(200);
    expect(read.body).not.toContain(RAW_KEY);
    expect(read.body).not.toContain(ADMIN_TOKEN);
    expect(read.body).not.toContain(TENANT_A_TOKEN);
  });

  it('operator of an unconfigured tenant fails closed on api-keys', async () => {
    store.add('T'.repeat(43), { role: 'operator', tenantId: TENANT_B, csrfToken: 'E'.repeat(43) });
    const res = await httpRequest(`${baseUrl}/admin/api/api-keys`, {
      headers: { cookie: `du_session=${'T'.repeat(43)}` },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('TENANT_SCOPE_UNAVAILABLE');
    expect(stub.requests).toHaveLength(0);
  });
});
