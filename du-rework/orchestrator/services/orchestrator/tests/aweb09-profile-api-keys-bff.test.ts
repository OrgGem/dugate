/**
 * 0039 — profile key routes at the BFF seam.
 *
 * Real shell server over loopback against a scripted upstream stub (no PG,
 * no Redis). Three things are proven here, and each one is a decision that
 * would otherwise be invisible:
 *  1. the matcher separates `api-keys` (read) from `api-keys/attach|rotate`
 *     (write) — a wrong branch here would turn a write into a silent read;
 *  2. the read relays the profile's key list under the session's own
 *     credential, and a viewer/scoped session never reaches the upstream;
 *  3. a membership write takes `profileId` from the SERVER's resolution of
 *     the URL tuple, and rotate's raw value is minted here — the browser
 *     never sends or receives key material.
 */
import http from 'node:http';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import { matchProfilesRoute } from '../src/app/admin/bff/profiles';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'aweb09-cookie-secret';
const ADMIN_TOKEN = 'aweb09-platform-admin-token';
const TENANT_A_TOKEN = 'aweb09-tenant-a-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const VIEWER_SESSION = 'W'.repeat(43);
const STORED_PROFILE_ID = 'eeeeeeee-5555-4555-8555-555555555555';
const KEY_ID = 'aaaaaaaa-1111-4111-8111-111111111111';
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

const PORT_BASE = 47_000 + (process.pid % 13) * 17;
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
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body: Buffer.concat(chunks).toString('utf8'),
          }),
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
  /** null = the profile is not stored yet (detail answers the blank editor). */
  storedProfileId: string | null;
  close(): Promise<void>;
}

function startStub(port: number): Promise<Stub> {
  const requests: Captured[] = [];
  const state = { storedProfileId: STORED_PROFILE_ID as string | null };
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
        body,
      });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/v1/admin/actions') {
        const parsed = JSON.parse(body || '{}') as { action?: string };
        res.statusCode = 200;
        res.end(JSON.stringify({ action: parsed.action ?? '?', apiKeyId: KEY_ID }));
        return;
      }
      if (url.pathname.endsWith('/api-keys')) {
        // Mirrors the platform: a profile that is not stored answers 404, not
        // an empty list (an empty list would read as "owns no keys").
        if (state.storedProfileId === null) {
          res.statusCode = 404;
          res.end(JSON.stringify({ code: 'NOT_FOUND' }));
          return;
        }
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            items: [{ id: KEY_ID, tenantId: TENANT_A, prefix: 'du_live_ab12', name: 'ci-runner', maskedHint: 'du_live_ab12', status: 'ACTIVE', createdAt: '2026-10-01T08:00:00.000Z', updatedAt: '2026-10-01T08:00:00.000Z', membershipState: 'ACTIVE' }],
            nextCursor: null,
            prevCursor: null,
            total: 1,
            limit: 100,
            profileId: state.storedProfileId,
          }),
        );
        return;
      }
      if (url.pathname.startsWith('/api/v1/admin/profiles/')) {
        res.statusCode = 200;
        res.end(
          JSON.stringify({
            businessId: 'doc-core',
            businessVersion: '1.1.0',
            profileName: 'default',
            revision: state.storedProfileId === null ? 0 : 3,
            profileId: state.storedProfileId,
            policy: { enabled: true, parameters: {}, jobPriority: 'MEDIUM', allowedFileExtensions: '', fileUrlAuthConfigured: false, connectionsOverride: [] },
            manifest: { actions: [{ name: 'extract' }] },
            capabilities: [],
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
        get storedProfileId() {
          return state.storedProfileId;
        },
        set storedProfileId(value: string | null) {
          state.storedProfileId = value;
        },
        close: () => new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))),
      } as Stub);
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

function legacyCookie(role: 'admin'): string {
  const nowMs = Date.now();
  const value = signCookie(SECRET, { iss: 'du-admin-shell', role, iat: nowMs, exp: nowMs + 3_600_000 });
  if (!value) throw new Error('signCookie returned undefined');
  return `du_admin=${value}`;
}

describe('0039 profile key routes: matcher', () => {
  const base = '/profiles/doc-core/1.1.0/default';

  it('the detail read is not confused with the key list', () => {
    expect(matchProfilesRoute(base)).toMatchObject({ kind: 'detail' });
    expect(matchProfilesRoute(`${base}/api-keys`)).toMatchObject({ kind: 'api-keys' });
  });

  it('attach and rotate are distinct from the list', () => {
    expect(matchProfilesRoute(`${base}/api-keys/attach`)).toMatchObject({ kind: 'api-key-op', op: 'attach' });
    expect(matchProfilesRoute(`${base}/api-keys/rotate`)).toMatchObject({ kind: 'api-key-op', op: 'rotate' });
  });

  it('a sub-resource on a non-key op is not a route', () => {
    expect(matchProfilesRoute(`${base}/upsert/attach`)).toBeNull();
    expect(matchProfilesRoute(`${base}/api-keys/attach/extra`)).toBeNull();
  });

  it('an unknown sub-resource does not match any profile route', () => {
    expect(matchProfilesRoute(`${base}/api-keys/retire`)).toBeNull();
    expect(matchProfilesRoute(`${base}/api-keys/attach/extra`)).toBeNull();
  });

  it('the existing routes still parse', () => {
    for (const op of ['upsert', 'publish', 'rollback'] as const) {
      expect(matchProfilesRoute(`${base}/${op}`)).toMatchObject({ kind: op });
    }
    expect(matchProfilesRoute('/profiles/test-endpoint')).toMatchObject({ kind: 'test-endpoint' });
  });
});

describe('0039 profile key routes: BFF', () => {
  let stub: Stub;
  let store: MapSessionStore;
  let handle: AdminShellHandle;
  let baseUrl: string;
  let adminCookie: string;
  let csrfToken: string;

  const KEYS_PATH = '/admin/api/profiles/doc-core/1.1.0/default/api-keys';

  beforeAll(async () => {
    stub = await startStub(nextPort());
    store = new MapSessionStore();
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
    baseUrl = (await handle.listen()).url;
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
    stub.storedProfileId = STORED_PROFILE_ID;
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    httpRequest(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken, ...headers },
      body: JSON.stringify(body),
    });

  it('GET relays the key list under the session credential, no-store', async () => {
    const res = await httpRequest(`${baseUrl}${KEYS_PATH}`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    expect(stub.requests[0]?.path).toBe('/api/v1/admin/profiles/doc-core/1.1.0/default/api-keys');
    expect(stub.requests[0]?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(res.headers['cache-control']).toBe('no-store');
    expect(JSON.parse(res.body).items[0]).toMatchObject({ prefix: 'du_live_ab12', membershipState: 'ACTIVE' });
  });

  it('a viewer session is refused before any upstream call', async () => {
    const res = await httpRequest(`${baseUrl}${KEYS_PATH}`, {
      headers: { cookie: `du_session=${VIEWER_SESSION}` },
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PROFILE_SCOPE_GATE');
    expect(stub.requests).toHaveLength(0);
  });

  it('POST on the read route is 405', async () => {
    const res = await post(KEYS_PATH, {});
    expect(res.status).toBe(405);
    expect(stub.requests).toHaveLength(0);
  });

  it('attach forwards apikey.attach with the SERVER-resolved profileId and no raw key', async () => {
    const res = await post(`${KEYS_PATH}/attach`, { apiKeyId: KEY_ID });
    expect(res.status).toBe(200);
    const action = stub.requests.find((r) => r.path === '/api/v1/admin/actions');
    expect(stub.requests[0]?.path).toBe('/api/v1/admin/profiles/doc-core/1.1.0/default/api-keys');
    const forwarded = JSON.parse(action?.body ?? '{}') as {
      action: string;
      params: Record<string, unknown>;
    };
    expect(forwarded.action).toBe('apikey.attach');
    expect(forwarded.params).toEqual({ apiKeyId: KEY_ID, profileId: STORED_PROFILE_ID });
    expect(forwarded.params.apiKey).toBeUndefined();
  });

  it('rotate mints the raw value server-side and keeps the client out of it', async () => {
    const res = await post(`${KEYS_PATH}/rotate`, { apiKeyId: KEY_ID, name: '  ci-runner-2  ' });
    expect(res.status).toBe(200);
    const action = stub.requests.find((r) => r.path === '/api/v1/admin/actions');
    const forwarded = JSON.parse(action?.body ?? '{}') as {
      action: string;
      params: Record<string, unknown>;
    };
    expect(forwarded.action).toBe('apikey.rotate');
    expect(forwarded.params.apiKeyId).toBe(KEY_ID);
    expect(forwarded.params.profileId).toBe(STORED_PROFILE_ID);
    expect(forwarded.params.name).toBe('ci-runner-2');
    expect(String(forwarded.params.apiKey)).toMatch(/^du_[A-Za-z0-9_-]{40,}$/);
  });

  it('a bad apiKeyId is 422 before any upstream call', async () => {
    const res = await post(`${KEYS_PATH}/attach`, { apiKeyId: '   ' });
    expect(res.status).toBe(422);
    expect(JSON.parse(res.body).code).toBe('INVALID_SCHEMA');
    expect(stub.requests).toHaveLength(0);
  });

  it('an unstored profile is 404 — it owns no keys yet', async () => {
    stub.storedProfileId = null;
    const res = await post(`${KEYS_PATH}/attach`, { apiKeyId: KEY_ID });
    expect(res.status).toBe(404);
    expect(stub.requests.some((r) => r.path === '/api/v1/admin/actions')).toBe(false);
  });

  it('a write without the CSRF proof never reaches the upstream', async () => {
    const res = await post(`${KEYS_PATH}/rotate`, { apiKeyId: KEY_ID }, { 'x-csrf-token': 'X'.repeat(43) });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('CSRF_REJECTED');
    expect(stub.requests).toHaveLength(0);
  });
});
