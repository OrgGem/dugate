/**
 * W-ADM-UX-03-AUDIT-MOUNT (Delta 130, mount layer): the audit pane must read
 * the REAL ledger through the real route, not render a wiring gap.
 *
 * This is the end-to-end proof the three earlier cycles could not give: a
 * stub JSON API stands in for the platform, the shell is mounted exactly
 * the way `createApp` mounts it (same options, same jsonBaseUrl), and the
 * assertions run over REAL HTTP - so a break anywhere in the chain
 * (nav tab -> route match -> role gate -> deferred extras -> default
 * fetcher -> route query -> envelope -> renderer) turns red here.
 *
 * Offline: loopback HTTP only, no DB, no Redis, no external network.
 */

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { attachAdminShell } from '../src/app/admin';
import type { AdminShellAttachResult } from '../src/app/admin';

const TOKEN = 'audit-mount-token';
const SECRET = 'audit-mount-secret';

interface Res {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  setCookie: string[];
}

async function req(
  url: string,
  opts: { method?: string; body?: string; cookie?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = {};
  if (opts.body) headers['content-type'] = 'application/x-www-form-urlencoded';
  if (opts.cookie) headers.cookie = opts.cookie;
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const r = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: opts.method ?? 'GET', headers },
      (res) => {
        let body = '';
        res.on('data', (c) => { body += String(c); });
        res.on('end', () => {
          const sc = res.headers['set-cookie'];
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            setCookie: Array.isArray(sc) ? sc : sc ? [sc] : [],
          });
        });
      },
    );
    r.on('error', reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

/** One ledger event, in the exact five-field envelope the route answers. */
const LEDGER_EVENT = {
  id: 'evt-1',
  kind: 'auth.login_failed',
  severity: 'warning',
  occurredAt: '2026-09-28T10:00:00.000Z',
  tenantId: 'tenant-a',
  resourceId: 'doc-1',
  actor: 'svc-deploy',
  message: 'auth.login_failed doc-1',
};

describe('W-ADM-UX-03 audit mount: live ledger through the real route', () => {
  let api: http.Server;
  let apiUrl: string;
  const apiHits: URL[] = [];
  let shell: AdminShellAttachResult;

  beforeAll(async () => {
    // Stand-in for the orchestrator JSON API. Records the query the shell
    // built, so a forwarding bug shows up as a wrong URL, not just a page.
    api = http.createServer((rq, rs) => {
      apiHits.push(new URL(rq.url ?? '/', 'http://127.0.0.1'));
      rs.writeHead(200, { 'content-type': 'application/json' });
      rs.end(
        JSON.stringify({
          items: [LEDGER_EVENT],
          nextCursor: null,
          prevCursor: null,
          total: 1,
          limit: 50,
        }),
      );
    });
    await new Promise<void>((r) => api.listen(0, '127.0.0.1', r));
    apiUrl = 'http://127.0.0.1:' + String((api.address() as AddressInfo).port);

    // Mounted exactly the way createApp mounts it: cookie secret + admin
    // token + a resolvable jsonBaseUrl. No custom sectionFetchers, so this
    // exercises the DEFAULT audit fetcher, not a stubbed one.
    // W-ADM-UX-05-MOUNT-PORT-ISOLATION: below-ephemeral band + bounded retry.
    // Same mechanism as admin-audit-query.test.ts (cycle 45). Two traps:
    //  1. port 0 lands inside 49152-65535, the range Windows draws outbound
    //     source ports from, so the listener fights the host own requests.
    //  2. A single PID-derived constant collides across concurrent jest runs.
    // The band 42000-42504 is disjoint from the query suite band by the same
    // stride, but disjointness is hygiene - the RETRY is the guarantee.
    const base = 42000 + (process.pid % 64) * 8 + 4;
    let mounted: AdminShellAttachResult | null = null;
    let lastErr: unknown;
    for (let attempt = 0; attempt < 16 && mounted === null; attempt += 1) {
      try {
        mounted = await attachAdminShell({
          config: {
            adminShellCookieSecret: SECRET,
            adminToken: TOKEN,
            adminShellHost: '127.0.0.1',
            adminShellPort: base + attempt * 8,
            jsonBaseUrl: apiUrl,
          },
        });
        if (mounted === null) break;
      } catch (err) {
        lastErr = err;
        if ((err as { code?: string }).code !== 'EADDRINUSE') throw err;
      }
    }
    if (mounted === null) {
      throw lastErr ?? new Error('admin shell could not bind any candidate port');
    }
    shell = mounted;
  });

  afterAll(async () => {
    // Guarded: if beforeAll died part way, an unguarded teardown throws a
    // SECOND error on top of the real one and hides the mount failure.
    if (shell) await shell.handle.close();
    if (api) await new Promise<void>((r) => api.close(() => r()));
  });

  async function adminCookie(): Promise<string> {
    const res = await req(shell.url + '/admin/login', {
      method: 'POST',
      body: new URLSearchParams({ token: TOKEN, redirect: '/admin/audit' }).toString(),
    });
    expect(res.status).toBe(302);
    const raw = res.setCookie[0] ?? '';
    return raw.split(';')[0] ?? '';
  }

  it('the shell mounts and GET /admin/audit answers 200 for a signed-in admin', async () => {
    const cookie = await adminCookie();
    const res = await req(shell.url + '/admin/audit', { cookie });
    expect(res.status).toBe(200);
  });

  it('the pane renders the REAL ledger event served by the route', async () => {
    const cookie = await adminCookie();
    const res = await req(shell.url + '/admin/audit', { cookie });
    expect(res.body).toContain('svc-deploy');
    expect(res.body).toContain('auth.login_failed');
    expect(res.body).toContain('doc-1');
  });

  it('the pane is NOT the not-wired error state', async () => {
    const cookie = await adminCookie();
    const res = await req(shell.url + '/admin/audit', { cookie });
    expect(res.body).not.toContain('not wired');
    expect(res.body).not.toContain('No events match');
  });

  it('the default fetcher called the audit route with the bearer token', async () => {
    const cookie = await adminCookie();
    await req(shell.url + '/admin/audit', { cookie });
    const hit = apiHits.find((u) => u.pathname === '/api/v1/admin/audit');
    expect(hit).toBeDefined();
  });

  it('the Audit Log tab is present in the shell nav', async () => {
    const cookie = await adminCookie();
    const res = await req(shell.url + '/admin/audit', { cookie });
    expect(res.body).toContain('Audit Log');
  });

  it('toolbar query params are forwarded to the route as real query values', async () => {
    const cookie = await adminCookie();
    apiHits.length = 0;
    const res = await req(
      shell.url + '/admin/audit?severity=warning&actor=ops&limit=25',
      { cookie },
    );
    expect(res.status).toBe(200);
    const hit = apiHits.find((u) => u.pathname === '/api/v1/admin/audit');
    expect(hit?.searchParams.get('severity')).toBe('warning');
    expect(hit?.searchParams.get('actor')).toBe('ops');
    expect(hit?.searchParams.get('limit')).toBe('25');
  });
});
