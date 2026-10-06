/**
 * AWEB-04 — BFF Profile routes (focused, offline).
 *
 * Fence matrix (T-UI-05, Profile routes ONLY) + dispatcher forwarding:
 *  - anonymous → 401; viewer → 403 PROFILE_SCOPE_GATE (no platform bypass);
 *  - operator reads ride their OWN tenant credential; operator writes → 403
 *    PROFILE_SCOPED_GATE (T-AUTH-03/VFY-LOCAL);
 *  - admin mutations require CSRF and forward to the dispatcher with the
 *    platform bearer + idempotency-key; validation fails closed at 422.
 */
import http from 'node:http';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'aweb04-cookie-secret';
const ADMIN_TOKEN = 'aweb04-platform-admin-token';
const TENANT_A_TOKEN = 'aweb04-tenant-a-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const OPERATOR_SESSION = 'O'.repeat(43);
const VIEWER_SESSION = 'W'.repeat(43);
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

const PORT_BASE = 46_200 + (process.pid % 13) * 17;
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
  idempotency: string | null;
  body: string;
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
        idempotency: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null,
        body: Buffer.concat(chunks).toString('utf8'),
      });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/v1/admin/actions') {
        const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') as { action?: string };
        res.statusCode = 200;
        res.end(JSON.stringify({ action: parsed.action ?? '?', revision: 8 }));
        return;
      }
      if (url.pathname === '/api/v1/admin/profile-test-endpoint') {
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      if (url.pathname.startsWith('/api/v1/admin/profiles/')) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            businessId: 'doc-core',
            businessVersion: 'latest',
            profileName: 'new',
            revision: 0,
            currentValues: {},
            policy: {
              enabled: true,
              parameters: {},
              jobPriority: 'MEDIUM',
              allowedFileExtensions: '',
              fileUrlAuthConfigured: false,
              connectionsOverride: [],
            },
            manifest: { actions: [{ name: 'extract' }] },
            capabilities: [{ connectorId: 'c1', capability: 'policy' }],
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

describe('AWEB-04 BFF profile routes (T-UI-05 fence + dispatcher forwarding)', () => {
  let stub: Stub;
  let store: MapSessionStore;
  let handle: AdminShellHandle;
  let baseUrl: string;
  let csrfToken: string;
  /** ONE admin cookie: the CSRF proof is derived over this exact value. */
  let adminCookie: string;

  const PROFILE = '/admin/api/profiles/doc-core/latest/new';

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
    const session = await httpRequest(`${baseUrl}/admin/api/session`, {
      headers: { cookie: adminCookie },
    });
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
  const adminHeaders = (): Record<string, string> => ({
    cookie: adminCookie,
    'content-type': 'application/json',
    'x-csrf-token': csrfToken,
  });

  it('anonymous → 401 on read and mutation, upstream untouched', async () => {
    const read = await httpRequest(`${baseUrl}${PROFILE}`);
    const write = await httpRequest(`${baseUrl}${PROFILE}/upsert`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ policy: {} }),
    });
    for (const res of [read, write]) {
      expect(res.status).toBe(401);
      expect(JSON.parse(res.body).code).toBe('UNAUTHENTICATED');
    }
    expect(stub.requests).toHaveLength(0);
  });

  it('viewer read → 403 PROFILE_SCOPE_GATE (no platform-token bypass)', async () => {
    const res = await httpRequest(`${baseUrl}${PROFILE}`, {
      headers: { cookie: `du_session=${VIEWER_SESSION}` },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PROFILE_SCOPE_GATE');
    expect(stub.requests).toHaveLength(0);
  });

  it('operator read → forwarded with the tenant credential (never the platform token)', async () => {
    const res = await httpRequest(`${baseUrl}${PROFILE}`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    expect(res.status).toBe(200);
    const upstream = last();
    expect(upstream?.path).toBe('/api/v1/admin/profiles/doc-core/latest/new');
    expect(upstream?.auth).toBe(`Bearer ${TENANT_A_TOKEN}`);
    expect(upstream?.auth).not.toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it('operator mutation → 403 PROFILE_SCOPED_GATE, untouched', async () => {
    const res = await httpRequest(`${baseUrl}${PROFILE}/upsert`, {
      method: 'POST',
      headers: { cookie: `du_session=${OPERATOR_SESSION}`, 'content-type': 'application/json' },
      body: JSON.stringify({ policy: {} }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PROFILE_SCOPED_GATE');
    expect(stub.requests).toHaveLength(0);
  });

  it('admin mutation without CSRF → 403 CSRF_REJECTED, untouched', async () => {
    const res = await httpRequest(`${baseUrl}${PROFILE}/upsert`, {
      method: 'POST',
      headers: { cookie: legacyCookie('admin'), 'content-type': 'application/json' },
      body: JSON.stringify({ policy: {} }),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('CSRF_REJECTED');
    expect(stub.requests).toHaveLength(0);
  });

  it('admin upsert → dispatcher action with platform bearer + idempotency', async () => {
    const res = await httpRequest(`${baseUrl}${PROFILE}/upsert`, {
      method: 'POST',
      headers: { ...adminHeaders(), 'idempotency-key': 'aweb04-1' },
      body: JSON.stringify({
        expectedRevision: 7,
        policy: { endpointSlug: 'extract', enabled: true, parameters: { ai_model: { value: 'gpt-4o-mini' } } },
      }),
    });
    expect(res.status).toBe(200);
    expect(res.headers['cache-control']).toBe('no-store');
    const upstream = last();
    expect(upstream?.path).toBe('/api/v1/admin/actions');
    expect(upstream?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(upstream?.idempotency).toBe('aweb04-1');
    const sent = JSON.parse(upstream?.body ?? '{}') as { action: string; params: Record<string, unknown> };
    expect(sent.action).toBe('profile.upsert');
    expect(sent.params.businessId).toBe('doc-core');
    expect(sent.params.businessVersion).toBe('latest');
    expect(sent.params.profileName).toBe('new');
    expect(sent.params.expectedRevision).toBe(7);
    expect(sent.params.policy).toMatchObject({ endpointSlug: 'extract' });
    const body = JSON.parse(res.body) as { data: { revision: number } };
    expect(body.data.revision).toBe(8);
  });

  it('publish without expectedRevision → 422; rollback requires targetRevision', async () => {
    const publish = await httpRequest(`${baseUrl}${PROFILE}/publish`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({}),
    });
    expect(publish.status).toBe(422);
    const rollback = await httpRequest(`${baseUrl}${PROFILE}/rollback`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ expectedRevision: 7 }),
    });
    expect(rollback.status).toBe(422);
    expect(stub.requests).toHaveLength(0);

    const ok = await httpRequest(`${baseUrl}${PROFILE}/rollback`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ targetRevision: 3, expectedRevision: 7 }),
    });
    expect(ok.status).toBe(200);
    const sent = JSON.parse(last()?.body ?? '{}') as { action: string; params: Record<string, unknown> };
    expect(sent.action).toBe('profile.rollback');
    expect(sent.params.targetRevision).toBe(3);
  });

  it('malformed path segment → 404 without upstream', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/profiles/doc-core/latest/${'x'.repeat(200)}`);
    expect(res.status).toBe(404);
    expect(stub.requests).toHaveLength(0);
  });

  it('test-endpoint: admin passthrough; operator denied', async () => {
    const denied = await httpRequest(`${baseUrl}/admin/api/profiles/test-endpoint`, {
      method: 'POST',
      headers: { cookie: `du_session=${OPERATOR_SESSION}`, 'content-type': 'application/json' },
      body: '{}',
    });
    expect(denied.status).toBe(403);

    const ok = await httpRequest(`${baseUrl}/admin/api/profiles/test-endpoint`, {
      method: 'POST',
      headers: adminHeaders(),
      body: JSON.stringify({ businessId: 'doc-core', endpointSlug: 'extract' }),
    });
    expect(ok.status).toBe(200);
    expect(last()?.path).toBe('/api/v1/admin/profile-test-endpoint');
    expect(last()?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
  });

  it('no token reaches any response body', async () => {
    const read = await httpRequest(`${baseUrl}${PROFILE}`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    const denied = await httpRequest(`${baseUrl}${PROFILE}/upsert`, {
      method: 'POST',
      headers: { cookie: `du_session=${OPERATOR_SESSION}`, 'content-type': 'application/json' },
      body: '{}',
    });
    for (const res of [read, denied]) {
      expect(res.body).not.toContain(ADMIN_TOKEN);
      expect(res.body).not.toContain(TENANT_A_TOKEN);
    }
  });
});
