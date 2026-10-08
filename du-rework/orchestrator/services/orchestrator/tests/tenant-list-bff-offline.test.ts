/**
 * AWEB tenant roster BFF route (offline): platform fence and query isolation.
 */
import http from 'node:http';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'tenant-list-cookie-secret';
const ADMIN_TOKEN = 'tenant-list-platform-token';
const TENANT_TOKEN = 'tenant-list-tenant-token';
const TENANT_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const OPERATOR_SESSION = 'O'.repeat(43);
const VIEWER_SESSION = 'V'.repeat(43);
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

const PORT_BASE = 49_300 + (process.pid % 11) * 19;
let portCursor = 0;
const nextPort = (): number => PORT_BASE + portCursor++;

interface Captured {
  method: string;
  path: string;
  auth: string | null;
}

interface Stub {
  url: string;
  requests: Captured[];
  close(): Promise<void>;
}

function startStub(port: number): Promise<Stub> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      auth: typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
    });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/v1/admin/tenants') {
      const isTenantCredential = req.headers['authorization'] === `Bearer ${TENANT_TOKEN}`;
      const items = isTenantCredential
        ? [{ id: TENANT_ID, name: 'Example Tenant', state: 'ACTIVE' }]
        : [
            { id: TENANT_ID, name: 'Example Tenant', state: 'ACTIVE' },
            { id: OTHER_TENANT_ID, name: 'Other Tenant', state: 'ACTIVE' },
          ];
      res.statusCode = 200;
      res.end(JSON.stringify({
        items,
        nextCursor: null,
        prevCursor: null,
        total: items.length,
        limit: 100,
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 'NOT_FOUND' }));
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

function legacyAdminCookie(): string {
  const nowMs = Date.now();
  const value = signCookie(SECRET, { iss: 'du-admin-shell', role: 'admin', iat: nowMs, exp: nowMs + 3_600_000 });
  if (!value) throw new Error('signCookie returned undefined');
  return `du_admin=${value}`;
}

describe('GET /admin/api/tenants BFF route', () => {
  let stub: Stub;
  let handle: AdminShellHandle;
  let baseUrl: string;
  let adminCookie: string;

  beforeAll(async () => {
    stub = await startStub(nextPort());
    const sessions = new MapSessionStore();
    sessions.add(OPERATOR_SESSION, { role: 'operator', tenantId: TENANT_ID, csrfToken: 'C'.repeat(43) });
    sessions.add(VIEWER_SESSION, { role: 'viewer', tenantId: null, csrfToken: 'V'.repeat(43) });
    handle = createAdminShellServer({
      port: nextPort(),
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: ADMIN_TOKEN,
      tenantAdminTokens: { [TENANT_TOKEN]: TENANT_ID },
      jsonBaseUrl: stub.url,
      adminWeb: { distDir: 'Z:/does-not-exist' },
      cookiePolicy: COOKIE_POLICY,
      oidcSessions: sessions,
    });
    baseUrl = (await handle.listen()).url;
    adminCookie = legacyAdminCookie();
  });

  afterAll(async () => {
    await handle.close();
    await stub.close();
  });

  beforeEach(() => {
    stub.requests.length = 0;
  });

  it('denies anonymous and non-admin viewer sessions before upstream', async () => {
    const anonymous = await fetch(`${baseUrl}/admin/api/tenants`);
    const viewer = await fetch(`${baseUrl}/admin/api/tenants`, {
      headers: { cookie: `du_session=${VIEWER_SESSION}` },
    });

    expect(anonymous.status).toBe(401);
    expect(viewer.status).toBe(403);
    expect(stub.requests).toHaveLength(0);
  });

  it('platform session uses platform bearer, sees all rows, forwards pagination, and drops tenantId/sort', async () => {
    const response = await fetch(
      `${baseUrl}/admin/api/tenants?tenantId=${TENANT_ID}&limit=10&cursor=opaque-page&sort=name`,
      {
        headers: { cookie: adminCookie },
      },
    );
    const page = await response.json() as {
      items: Array<{ id: string; name: string; state: string }>;
      total: number;
      limit: number;
    };

    expect(response.status).toBe(200);
    expect(page.items).toEqual([
      { id: TENANT_ID, name: 'Example Tenant', state: 'ACTIVE' },
      { id: OTHER_TENANT_ID, name: 'Other Tenant', state: 'ACTIVE' },
    ]);
    expect(page.total).toBe(2);
    expect(page.limit).toBe(100);
    expect(response.headers.get('cache-control')).toBe('no-store');
    expect(stub.requests).toEqual([{
      method: 'GET',
      path: '/api/v1/admin/tenants?limit=10&cursor=opaque-page',
      auth: `Bearer ${ADMIN_TOKEN}`,
    }]);
  });

  it('tenant operator uses its tenant bearer and receives only its tenant row', async () => {
    const response = await fetch(
      `${baseUrl}/admin/api/tenants?tenantId=${OTHER_TENANT_ID}&limit=10&sort=name`,
      { headers: { cookie: `du_session=${OPERATOR_SESSION}` } },
    );
    const page = await response.json() as {
      items: Array<{ id: string; name: string; state: string }>;
      total: number;
    };

    expect(response.status).toBe(200);
    expect(page.items).toEqual([{ id: TENANT_ID, name: 'Example Tenant', state: 'ACTIVE' }]);
    expect(page.total).toBe(1);
    expect(stub.requests).toEqual([{
      method: 'GET',
      path: '/api/v1/admin/tenants?limit=10',
      auth: `Bearer ${TENANT_TOKEN}`,
    }]);
  });
});
