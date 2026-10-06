/**
 * AWEB-08-prep — per-route rollout flag (`DU_ADMIN_WEB_ROUTES`) focused tests.
 *
 *  - absent/blank env → behaviour unchanged (whole SPA served, SPA fallback);
 *  - present allow-list → listed routes 200 (real index), anything else one
 *    consistent 404 document that points at the legacy renderer;
 *  - unknown names dropped; empty-after-parse list gates everything but root;
 *  - flag off (`DU_ADMIN_WEB` unset, no injection) → legacy 404 untouched.
 */
import http from 'node:http';
import { resolve } from 'node:path';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import { signCookie } from '../src/app/admin/shell-auth';

const SECRET = 'aweb08-cookie-secret';
const DIST = resolve(__dirname, '../../../apps/admin-web/dist');

const PORT_BASE = 47_900 + (process.pid % 7) * 29;
let portCursor = 0;
const nextPort = (): number => PORT_BASE + portCursor++;

interface Response {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function httpRequest(url: string, cookie?: string): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: cookie !== undefined ? { cookie } : {},
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
    req.end();
  });
}

function adminCookie(): string {
  const nowMs = Date.now();
  const value = signCookie(SECRET, { iss: 'du-admin-shell', role: 'admin', iat: nowMs, exp: nowMs + 3_600_000 });
  if (!value) throw new Error('signCookie returned undefined');
  return `du_admin=${value}`;
}

async function withMount(
  env: { DU_ADMIN_WEB_ROUTES?: string | undefined },
  options: { inject?: boolean },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const priorRoutes = process.env.DU_ADMIN_WEB_ROUTES;
  const priorFlag = process.env.DU_ADMIN_WEB;
  try {
    if (env.DU_ADMIN_WEB_ROUTES === undefined) delete process.env.DU_ADMIN_WEB_ROUTES;
    else process.env.DU_ADMIN_WEB_ROUTES = env.DU_ADMIN_WEB_ROUTES;
    delete process.env.DU_ADMIN_WEB;
    const mountOptions =
      options.inject === false
        ? { port: nextPort(), host: '127.0.0.1', cookieSecret: SECRET, adminToken: 'aweb08-admin-token' }
        : {
            port: nextPort(),
            host: '127.0.0.1',
            cookieSecret: SECRET,
            adminToken: 'aweb08-admin-token',
            adminWeb: { distDir: DIST },
          };
    const handle: AdminShellHandle = createAdminShellServer(mountOptions);
    const bound = await handle.listen();
    try {
      await run(bound.url);
    } finally {
      await handle.close();
    }
  } finally {
    if (priorRoutes === undefined) delete process.env.DU_ADMIN_WEB_ROUTES;
    else process.env.DU_ADMIN_WEB_ROUTES = priorRoutes;
    if (priorFlag === undefined) delete process.env.DU_ADMIN_WEB;
    else process.env.DU_ADMIN_WEB = priorFlag;
  }
}

describe('AWEB-08-prep per-route rollout flag', () => {
  const cookie = adminCookie();

  it('absent env → unchanged behaviour (all routes + SPA fallback)', async () => {
    await withMount({}, { inject: true }, async (base) => {
      for (const path of ['/admin/web', '/admin/web/overview', '/admin/web/profiles', '/admin/web/anything-else']) {
        const res = await httpRequest(`${base}${path}`, cookie);
        expect(res.status).toBe(200);
        expect(res.body).toContain('<div id="root">');
      }
    });
  });

  it('blank env → treated as absent (unrestricted)', async () => {
    await withMount({ DU_ADMIN_WEB_ROUTES: '   ' }, { inject: true }, async (base) => {
      const res = await httpRequest(`${base}/admin/web/profiles`, cookie);
      expect(res.status).toBe(200);
    });
  });

  it('partial allow-list → listed routes 200; others one consistent 404 with legacy link', async () => {
    await withMount({ DU_ADMIN_WEB_ROUTES: 'overview,security' }, { inject: true }, async (base) => {
      const overview = await httpRequest(`${base}/admin/web/overview`, cookie);
      expect(overview.status).toBe(200);
      expect(overview.body).toContain('<div id="root">');
      const security = await httpRequest(`${base}/admin/web/security`, cookie);
      expect(security.status).toBe(200);

      for (const path of ['/admin/web/profiles', '/admin/web/operations', '/admin/web/unknown-thing']) {
        const gated = await httpRequest(`${base}${path}`, cookie);
        expect(gated.status).toBe(404);
        expect(gated.body).toContain('Route not enabled on this deployment');
        expect(gated.body).toContain('href="/admin"');
        expect(gated.headers['cache-control']).toBe('no-store');
      }

      // Root shell stays reachable; assets bypass the gate.
      const root = await httpRequest(`${base}/admin/web`, cookie);
      expect(root.status).toBe(200);
      const assetMiss = await httpRequest(`${base}/admin/web/assets/not-real.js`, cookie);
      expect(assetMiss.status).toBe(404);
      expect(assetMiss.body).not.toContain('Route not enabled');
    });
  });

  it('unknown names are dropped; the rest of the list still applies', async () => {
    await withMount({ DU_ADMIN_WEB_ROUTES: 'overview,bogus' }, { inject: true }, async (base) => {
      const overview = await httpRequest(`${base}/admin/web/overview`, cookie);
      expect(overview.status).toBe(200);
      const dropped = await httpRequest(`${base}/admin/web/bogus`, cookie);
      expect(dropped.status).toBe(404);
      expect(dropped.body).toContain('Route not enabled');
      const profiles = await httpRequest(`${base}/admin/web/profiles`, cookie);
      expect(profiles.status).toBe(404);
    });
  });

  it('deliberately empty list (commas only) gates everything but the root', async () => {
    await withMount({ DU_ADMIN_WEB_ROUTES: ',' }, { inject: true }, async (base) => {
      const root = await httpRequest(`${base}/admin/web`, cookie);
      expect(root.status).toBe(200);
      const profiles = await httpRequest(`${base}/admin/web/profiles`, cookie);
      expect(profiles.status).toBe(404);
      expect(profiles.body).toContain('Route not enabled');
    });
  });

  it('mount flag off → route absent (legacy 404 untouched)', async () => {
    await withMount({}, { inject: false }, async (base) => {
      const res = await httpRequest(`${base}/admin/web/profiles`, cookie);
      expect(res.status).toBe(404);
      expect(res.body).toContain('No Admin route matches');
    });
  });

  it('DU_ADMIN_WEB_ROUTES present but DU_ADMIN_WEB off → still not mounted', async () => {
    // The allow-list is an ADDITIONAL restriction for a mounted app; it must
    // never mount anything by itself.
    const priorFlag = process.env.DU_ADMIN_WEB;
    const priorRoutes = process.env.DU_ADMIN_WEB_ROUTES;
    try {
      delete process.env.DU_ADMIN_WEB;
      process.env.DU_ADMIN_WEB_ROUTES = 'overview,security';
      const handle = createAdminShellServer({
        port: nextPort(),
        host: '127.0.0.1',
        cookieSecret: SECRET,
        adminToken: 'aweb08-admin-token',
      });
      const bound = await handle.listen();
      try {
        for (const path of ['/admin/web', '/admin/web/overview', '/admin/web/security']) {
          const res = await httpRequest(`${bound.url}${path}`, cookie);
          expect(res.status).toBe(404);
          expect(res.body).toContain('No Admin route matches');
        }
      } finally {
        await handle.close();
      }
    } finally {
      if (priorFlag === undefined) delete process.env.DU_ADMIN_WEB;
      else process.env.DU_ADMIN_WEB = priorFlag;
      if (priorRoutes === undefined) delete process.env.DU_ADMIN_WEB_ROUTES;
      else process.env.DU_ADMIN_WEB_ROUTES = priorRoutes;
    }
  });
});
