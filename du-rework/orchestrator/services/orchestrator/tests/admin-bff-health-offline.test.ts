import http from 'node:http';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';

const SECRET = 'admin-health-cookie-secret';
const ADMIN_TOKEN = 'admin-health-platform-token';
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};
interface CapturedRequest {
  method: string;
  path: string;
  authorization: string | null;
}

interface HealthStub {
  url: string;
  requests: CapturedRequest[];
  close(): Promise<void>;
}

function startHealthStub(): Promise<HealthStub> {
  const requests: CapturedRequest[] = [];
  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    requests.push({
      method: req.method ?? 'GET',
      path: url.pathname + url.search,
      authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
    });
    res.setHeader('content-type', 'application/json');
    if (url.pathname === '/api/v1/health') {
      res.statusCode = 503;
      res.end(JSON.stringify({
        status: 'degraded',
        db: false,
        redis: true,
        activeLeases: 0,
        queueIntegrity: {
          state: 'SUSPECT',
          orphansLast: 2,
          stalled: 1,
          lastSweepAt: '2026-10-08T05:00:00.000Z',
        },
        encryption: { keyRef: 'must-not-leak' },
      }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ code: 'NOT_FOUND' }));
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('health stub has no TCP address after listen'));
        return;
      }
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        requests,
        close: () => new Promise<void>((done, fail) => server.close((err) => (err ? fail(err) : done()))),
      });
    });
  });
}

function legacyAdminCookie(): string {
  const nowMs = Date.now();
  const value = signCookie(SECRET, {
    iss: 'du-admin-shell',
    role: 'admin',
    iat: nowMs,
    exp: nowMs + 3_600_000,
  });
  if (!value) throw new Error('signCookie returned undefined');
  return `du_admin=${value}`;
}

describe('GET /admin/api/health BFF route', () => {
  let stub: HealthStub;
  let handle: AdminShellHandle;
  let baseUrl: string;
  let adminCookie: string;

  beforeAll(async () => {
    stub = await startHealthStub();
    handle = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: ADMIN_TOKEN,
      jsonBaseUrl: stub.url,
      adminWeb: { distDir: 'Z:/does-not-exist' },
      cookiePolicy: COOKIE_POLICY,
    });
    baseUrl = (await handle.listen()).url;
    adminCookie = legacyAdminCookie();
  });

  afterAll(async () => {
    await handle.close();
    await stub.close();
  });

  it('surfaces degraded dependency detail while keeping unknown metrics unavailable', async () => {
    const response = await fetch(`${baseUrl}/admin/api/health`, {
      headers: { cookie: adminCookie },
    });
    const body = await response.json() as {
      status: string;
      db: boolean | null;
      redis: boolean | null;
      activeLeases: number | null;
      queueIntegrity: { state: string; orphansLast: number | null; stalled: number | null } | null;
      outboxBacklog: number | null;
      sampledAt: string;
    };

    expect(response.status).toBe(200);
    expect(body).toMatchObject({
      status: 'degraded',
      db: false,
      redis: true,
      activeLeases: null,
      queueIntegrity: { state: 'SUSPECT', orphansLast: 2, stalled: 1 },
      outboxBacklog: null,
    });
    expect(Number.isNaN(Date.parse(body.sampledAt))).toBe(false);
    expect(JSON.stringify(body)).not.toContain('must-not-leak');
    expect(stub.requests).toEqual([{
      method: 'GET',
      path: '/api/v1/health',
      authorization: `Bearer ${ADMIN_TOKEN}`,
    }]);
  });
});
