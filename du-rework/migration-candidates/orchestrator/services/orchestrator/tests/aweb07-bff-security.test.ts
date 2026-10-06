/**
 * AWEB-07 — BFF crypto-config route (focused, offline): fence + CSRF + passthrough.
 */
import http from 'node:http';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'aweb07-cookie-secret';
const ADMIN_TOKEN = 'aweb07-platform-admin-token';
const TENANT_A_TOKEN = 'aweb07-tenant-a-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OPERATOR_SESSION = 'O'.repeat(43);
const VIEWER_SESSION = 'W'.repeat(43);
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

const PORT_BASE = 47_500 + (process.pid % 9) * 23;
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
  body: string;
}

interface Stub {
  url: string;
  requests: Captured[];
  unconfigured: boolean;
  close(): Promise<void>;
}

function startStub(port: number): Promise<Stub> {
  const requests: Captured[] = [];
  const stub: Stub = {
    url: `http://127.0.0.1:${port}`,
    requests,
    unconfigured: false,
    close: () => new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
  };
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        auth: typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/v1/admin/crypto-config') {
        if (stub.unconfigured) {
          res.statusCode = 503;
          res.end(JSON.stringify({ code: 'TEMPORARY_UNAVAILABLE' }));
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            schemaVersion: '1',
            tenantId: url.searchParams.get('tenantId'),
            changedFields: ['deliveryEncryption'],
            crypto: { deliveryEncryption: true, fingerprintPreview: 'ab12…cd34' },
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
    server.listen(port, '127.0.0.1', () => resolve(stub));
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

describe('AWEB-07 BFF crypto-config route', () => {
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
    stub.unconfigured = false;
  });

  const last = (): Captured | undefined => stub.requests[stub.requests.length - 1];

  it('anonymous → 401; viewer → 403; untouched', async () => {
    const anon = await httpRequest(`${baseUrl}/admin/api/crypto-config`);
    expect(anon.status).toBe(401);
    const viewer = await httpRequest(`${baseUrl}/admin/api/crypto-config`, {
      headers: { cookie: `du_session=${VIEWER_SESSION}` },
    });
    expect(viewer.status).toBe(403);
    expect(stub.requests).toHaveLength(0);
  });

  it('operator GET → own tenant credential + forced tenantId; foreign tenant 403 untouched', async () => {
    const foreign = await httpRequest(`${baseUrl}/admin/api/crypto-config?tenantId=${TENANT_B}`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    expect(foreign.status).toBe(403);
    expect(stub.requests).toHaveLength(0);

    const own = await httpRequest(`${baseUrl}/admin/api/crypto-config`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    expect(own.status).toBe(200);
    const upstream = last();
    expect(upstream?.auth).toBe(`Bearer ${TENANT_A_TOKEN}`);
    expect(upstream?.path).toContain(`tenantId=${TENANT_A}`);
  });

  it('admin GET → platform bearer + tenantId passthrough', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/crypto-config?tenantId=${TENANT_A}`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    expect(last()?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(last()?.path).toContain(`tenantId=${TENANT_A}`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('POST without CSRF → 403 untouched; operator POST → 403 ADMIN_CREDENTIAL_REQUIRED untouched', async () => {
    const noCsrf = await httpRequest(`${baseUrl}/admin/api/crypto-config`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ deliveryEncryption: true }),
    });
    expect(noCsrf.status).toBe(403);
    expect(JSON.parse(noCsrf.body).code).toBe('CSRF_REJECTED');

    const operator = await httpRequest(`${baseUrl}/admin/api/crypto-config`, {
      method: 'POST',
      headers: { cookie: `du_session=${OPERATOR_SESSION}`, 'content-type': 'application/json', 'x-csrf-token': 'C'.repeat(43) },
      body: JSON.stringify({ deliveryEncryption: true }),
    });
    expect(operator.status).toBe(403);
    expect(JSON.parse(operator.body).code).toBe('ADMIN_CREDENTIAL_REQUIRED');
    expect(stub.requests).toHaveLength(0);
  });

  it('POST with CSRF → body forwarded verbatim, changedFields passthrough, no token echoed', async () => {
    const body = { deliveryEncryption: true, recipientKeyVersion: 2 };
    const res = await httpRequest(`${baseUrl}/admin/api/crypto-config`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify(body),
    });
    expect(res.status).toBe(200);
    const upstream = last();
    expect(upstream?.method).toBe('POST');
    expect(upstream?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(JSON.parse(upstream?.body ?? '{}')).toEqual(body);
    expect((JSON.parse(res.body) as { changedFields: string[] }).changedFields).toContain('deliveryEncryption');
    expect(res.body).not.toContain(ADMIN_TOKEN);
    expect(res.body).not.toContain(TENANT_A_TOKEN);
  });

  it('unconfigured deployment → 503 passthrough (honest unavailable)', async () => {
    stub.unconfigured = true;
    const res = await httpRequest(`${baseUrl}/admin/api/crypto-config`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(503);
    expect(JSON.parse(res.body).code).toBe('CRYPTO_CONFIG_UNAVAILABLE');
  });
});
