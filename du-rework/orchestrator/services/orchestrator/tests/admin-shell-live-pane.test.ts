/**
 * W46-C2 (1): mounted-shell live-pane proof (closes the CX3 W43-R13
 * shell-mount HIGH). Boots the REAL `createApp` with an admin token + shell
 * cookie secret, seeds one business version in real PG, then drives the
 * mounted shell's `/admin/businesses?businessId=<seed>` pane over real HTTP
 * and asserts the pane renders the seeded row — proving the shell's default
 * fetchers reach the live Admin JSON routes (via the listen()-resolved
 * `jsonBaseUrl` plumb), not the offline catalog.
 *
 * Needs real PG :5433 + Redis :6380 — same window discipline as the other
 * live suites (RUN REQUEST to the testing lane; this lane never self-runs).
 */
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp, type App } from '../src/server';
import { signCookie } from '../src/app/admin/shell-auth';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const ADMIN_TOKEN = 'live-pane-token-' + randomUUID();
const RUNTIME_TOKEN = 'live-pane-rt-' + randomUUID();
const COOKIE_SECRET = 'live-pane-secret-' + randomUUID();
const TEST_BIZ = 'live-pane-biz-' + randomUUID().slice(0, 8);

let app: App;
let platformUrl: string;

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    req.end();
  });
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('admin-shell-live-pane.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    adminToken: ADMIN_TOKEN,
    runtimeToken: RUNTIME_TOKEN,
    adminShellCookieSecret: COOKIE_SECRET,
    adminShellHost: '127.0.0.1',
    adminShellPort: 0,
    autoDispatch: false,
    autoMigrate: true,
  });
  const srv = await app.listen();
  const addr = srv.address();
  const port = typeof addr === 'object' && addr ? addr.port : 0;
  platformUrl = `http://127.0.0.1:${port}`;

  await app.db.query(
    `INSERT INTO business_versions (business_id, version, status, is_active, digest, queue, manifest)
     VALUES ($1, '1.0.0', 'ENABLED', true, 'sha256-live-pane', 'queue-live-pane', $2)`,
    [TEST_BIZ, JSON.stringify({ businessId: TEST_BIZ, version: '1.0.0', actions: [{ name: 'extract' }] })]
  );
}, 60000);

afterAll(async () => {
  if (app) {
    await app.db.query(`DELETE FROM business_versions WHERE business_id = $1`, [TEST_BIZ]).catch(() => {});
    await app.close({ timeoutMs: 0, pollIntervalMs: 10 });
  }
}, 60000);

describe('W46-C2: mounted shell live pane over real PG', () => {
  it('shell mounted with resolved jsonBaseUrl serves the seeded DB row', async () => {
    expect(app.adminShell).not.toBeNull();
    const shellUrl = app.adminShell!.url;
    expect(shellUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    expect(shellUrl).not.toBe(platformUrl); // standalone listener, live-wired to the platform JSON

    const cookie = signCookie(COOKIE_SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpGet(`${shellUrl}/admin/businesses?businessId=${encodeURIComponent(TEST_BIZ)}`, {
      cookie: `du_admin=${cookie}`,
    });
    expect(res.status).toBe(200);
    // The pane renders the REAL seeded row (DB-backed), not the offline
    // catalog: business id + the queue value stored in business_versions.
    expect(res.body).toContain(`data-business-id="${TEST_BIZ}"`);
    expect(res.body).toContain('queue-live-pane');
    expect(res.body).toContain('data-version="1.0.0"');
  });
});
});
