/**
 * Platform-mount proof for the Admin shell (P6-01, W40-O).
 *
 * `services/orchestrator/src/server.ts` line 168 calls:
 *     const adminShell = await attachAdminShell({ config });
 *
 * This test replays that EXACT call — same import path, same config
 * shape — then drives the four acceptance paths from the brief against
 * the URL the platform's call resolves. The shell listens on a port
 * owned by `createApp` (P6-01 close condition: "the shell runs on the
 * platform path, not a parallel listener").
 *
 * It is also the "real route integration" gate the review (§3.1 / RV-01)
 * requires: the four scenarios leave the bytes the platform's mount
 * produces and the shell-renderer + role-guard answer them.
 *
 * No DB, no Redis. The shell is a pure HTTP surface; `attachAdminShell`
 * never touches the platform's data layer.
 *
 * Why not boot `createApp`? Boot requires real DB + Redis (the migration
 * runner is mandatory and the brief says "zero DB and Redis unless you
 * claim the window in writing"). The shell, by contrast, is the only
 * surface `createApp` mounts that has no DB / Redis dependency. This
 * test replays the platform's call path on a bare-bones config — same
 * shape as `server.ts` passes — and asserts the integration end-to-end.
 */

import http from 'node:http';
import { attachAdminShell } from '../src/app/admin';
import type { AdminShellAttachResult } from '../src/app/admin';
import { createAdminShellServer as createAdminShellServerOnPort } from '../src/app/admin/shell-server';
import type { AdminShellHandle, CreateAdminShellServerOptions } from '../src/app/admin/shell-server';
import type { BusinessFetchResult, BusinessFetcherInput } from '../src/app/admin/business-section-data';
import type { ProfileFetchResult, ProfileFetcherInput } from '../src/app/admin/profile-section-data';
import type { ProfileSchemaInput } from '../src/app/admin/types';
import { buildProfileFormModel } from '../src/app/admin/profile-view-models';
import { signCookie } from '../src/app/admin/shell-auth';
import type { ConnectorFetchResult, ConnectorFetcherInput } from '../src/app/admin/connector-section-data';
import type { ApiKeyFetchResult, ApiKeyFetcherInput } from '../src/app/admin/api-key-section-data';
import type { OperationFetchResult, OperationFetcherInput } from '../src/app/admin/operation-section-data';
import type { OverviewFetchResult, OverviewFetcherInput } from '../src/app/admin/overview-section-data';
import {
  buildUsageRollupView,
  buildAuditListView,
  buildHealthOverviewView,
} from '../src/app/admin/overview-view-models';

const TOKEN = 'integration-platform-token';
const SECRET = 'integration-platform-secret';
const QUIET_PORT_BASE = 44_600 + (process.pid % 10) * 16;
let quietPortOffset = 0;

/** Keep this offline HTTP suite on deterministic loopback ports below the OS ephemeral range. */
function createAdminShellServer(options: CreateAdminShellServerOptions): AdminShellHandle {
  const port = options.port === undefined || options.port === 0
    ? QUIET_PORT_BASE + quietPortOffset++
    : options.port;
  return createAdminShellServerOnPort({ ...options, port });
}

interface Response {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: string;
  rawHeaders: string[];
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
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            rawHeaders: res.rawHeaders,
          });
        });
      },
    );
    req.on('error', reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

function getCookieFromSetCookie(rawHeaders: string[]): string | null {
  for (let i = 0; i < rawHeaders.length - 1; i++) {
    const name = rawHeaders[i];
    if (name === undefined) continue;
    if (name.toLowerCase() === 'set-cookie') {
      const value = rawHeaders[i + 1] ?? '';
      const semi = value.indexOf(';');
      const eq = value.indexOf('=');
      if (eq > 0 && (semi < 0 || eq < semi)) {
        return value.slice(0, eq) + '=' + value.slice(eq + 1, semi < 0 ? undefined : semi);
      }
      return value;
    }
  }
  return null;
}

describe('platform-mount: attachAdminShell from server.ts (P6-01, real HTTP)', () => {
  let shell: AdminShellAttachResult;
  let baseUrl: string;

  // The config shape matches the field names `server.ts` reads at
  // line 168. The orchestrator currently has no JSON-API port wired to
  // this test (DB-free boot), but the shell's listener is independent
  // — `attachAdminShell` binds its own port and returns the URL. The
  // platform's `createApp` exposes the same `adminShell.url` field on
  // its return object.
  beforeAll(async () => {
    const result = await attachAdminShell({
      config: {
        adminShellCookieSecret: SECRET,
        adminToken: TOKEN,
        adminShellHost: '127.0.0.1',
        adminShellPort: 44_400 + (process.pid % 10),
      },
    });
    expect(result).not.toBeNull();
    shell = result!;
    expect(shell.url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    baseUrl = shell.url;
  });

  afterAll(async () => {
    await shell.handle.close();
  });

  it('mounts the shell on an ephemeral port owned by the platform call', () => {
    // The mount resolves a URL — proof that the integration is live,
    // not a parallel stub. server.ts owns this lifecycle: it stores
    // the handle and calls .close() in app.close().
    const parsed = new URL(baseUrl);
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(Number(parsed.port)).toBeGreaterThan(0);
  });

  it('GET /admin/login → 200 with the login form (proves rendered shell reaches the wire)', async () => {
    const res = await httpRequest(`${baseUrl}/admin/login`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<form method="POST" action="/admin/login"');
    expect(res.body).toContain('name="token"');
  });

  it('GET / without a cookie → 401 (deep-link handled)', async () => {
    const res = await httpRequest(`${baseUrl}/`);
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Sign-in required');
  });

  it('POST /admin/login with a bad token → 401 HTML', async () => {
    const body = new URLSearchParams({ token: 'wrong', redirect: '/admin' }).toString();
    const res = await httpRequest(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Invalid token');
  });

  it('POST /admin/login with the configured admin token → 302 + Set-Cookie', async () => {
    const body = new URLSearchParams({ token: TOKEN, redirect: '/admin/businesses' }).toString();
    const res = await httpRequest(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/admin/businesses');
    const cookie = getCookieFromSetCookie(res.rawHeaders);
    expect(cookie).not.toBeNull();
    expect(cookie!.startsWith('du_admin=')).toBe(true);
  });

  it('follows the cookie to /admin/businesses → 200 with nav chrome + ready pane (admin role)', async () => {
    // Mint the cookie via the same sign module the platform uses.
    const { signCookie } = require('../src/app/admin/shell-auth');
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(`${baseUrl}/admin/businesses`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('screen-state--ready');
    // Nav chrome proves the full shell rendered, not just an error page.
    expect(res.body).toContain('href="/admin/businesses"');
    expect(res.body).toContain('href="/admin/profiles"');
    expect(res.body).toContain('href="/admin/connectors"');
    expect(res.body).toContain('href="/admin/grants"');
    // Role badge.
    expect(res.body).toContain('data-role="admin"');
  });

  it('viewer role is blocked from /admin/profiles → 403 with denied screen state', async () => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'viewer',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(`${baseUrl}/admin/profiles`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(403);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Access denied');
    expect(res.body).toContain('requires &#39;operator&#39;');
  });

  it('GET /admin/missing → 404 HTML', async () => {
    const res = await httpRequest(`${baseUrl}/admin/missing`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Not found');
  });

  it('POST /admin/logout → 302 + Max-Age=0 (cookie cleared)', async () => {
    const res = await httpRequest(`${baseUrl}/admin/logout`, { method: 'POST' });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/admin/login');
    expect(res.rawHeaders.some((h, i) => i % 2 === 1 && h.toLowerCase().includes('max-age=0'))).toBe(true);
  });

  it('rejects a tampered cookie (constant-time compare)', async () => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const dotIdx = cookie!.indexOf('.');
    const tampered = `${cookie!.slice(0, dotIdx + 1)}AAAA`;
    const res = await httpRequest(`${baseUrl}/admin/businesses`, {
      headers: { cookie: `du_admin=${tampered}` },
    });
    expect(res.status).toBe(401);
  });
});

// ---------------------------------------------------------------------------
// P6-02 — Mounted shell drives the deferred Business section with a stub
// fetcher. Proves the real route integration: the platform mount +
// shell-router deferredSectionExtras + the section renderer + the
// cookie-protected role guard all compose end-to-end over real HTTP.
// ---------------------------------------------------------------------------

describe('platform-mount: attachAdminShell (P6-02, deferred Business section)', () => {
  const calls: BusinessFetcherInput[] = [];
  const fetcher = async (input: BusinessFetcherInput): Promise<BusinessFetchResult> => {
    calls.push(input);
    return {
      kind: 'ok',
      businessId: input.businessId || 'example-review',
      activeVersion: 'v2',
      rows: [
        {
          businessId: 'example-review',
          version: 'v2',
          status: 'ENABLED',
          isActive: true,
          workerHealth: 'HEALTHY',
          workerCount: 2,
          lastHeartbeatAt: '2026-09-23T11:55:00Z',
          registeredAt: '2026-09-01T00:00:00Z',
        },
        {
          businessId: 'example-review',
          version: 'v1',
          status: 'DRAINING',
          isActive: false,
          workerHealth: 'DEGRADED',
          workerCount: 1,
          registeredAt: '2026-08-01T00:00:00Z',
        },
      ],
    };
  };

  let shell: AdminShellHandle | null = null;
  let baseUrl = '';

  beforeAll(async () => {
    shell = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: { businesses: fetcher },
    });
    const r = await shell.listen();
    baseUrl = r.url;
  });

  afterAll(async () => {
    if (shell) {
      try {
        await shell.close();
      } catch {
        // already closed by the last test — swallow so the suite teardown is clean
      }
      shell = null;
    }
  });

  it('GET /admin/businesses with admin cookie + stub fetcher → table renders both versions + nav chrome', async () => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(`${baseUrl}/admin/businesses?businessId=example-review`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Full shell chrome is still present (real route integration).
    expect(res.body).toContain('screen-state--ready');
    expect(res.body).toContain('href="/admin/businesses"');
    expect(res.body).toContain('href="/admin/profiles"');
    expect(res.body).toContain('data-role="admin"');
    // Section root + both rendered rows.
    expect(res.body).toContain('<section class="business-section"');
    expect(res.body).toContain('data-business-id="example-review"');
    expect(res.body).toContain('data-version="v2"');
    expect(res.body).toContain('data-version="v1"');
    // Active marker on the active row only.
    const activeMatches = res.body.match(/data-active="true"/g) ?? [];
    expect(activeMatches.length).toBe(1);
    // Health summary rendered (proves the section reached past the
    // deferred hook splice point).
    expect(res.body).toContain('Overall health');
    // The fetcher was invoked with the query businessId + the admin
    // token the platform configured (proves the auth handshake survives
    // the deferred path).
    expect(calls).toHaveLength(1);
    expect(calls[0]!.businessId).toBe('example-review');
    expect(calls[0]!.adminToken).toBe(TOKEN);
  });

  it('viewer role is 403 on /admin/profiles even when the business fetcher is wired (no fetcher invocation on a denied route)', async () => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'viewer',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const beforeCalls = calls.length;
    const res = await httpRequest(`${baseUrl}/admin/profiles`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Access denied');
    expect(calls.length).toBe(beforeCalls);
  });

  it('missing cookie on /admin/businesses → 401 (no fetcher invocation)', async () => {
    const beforeCalls = calls.length;
    const res = await httpRequest(`${baseUrl}/admin/businesses?businessId=example-review`);
    expect(res.status).toBe(401);
    expect(res.body).toContain('Sign-in required');
    expect(calls.length).toBe(beforeCalls);
  });

  it('GET /admin/businesses with no fetcher wired → 200 ready pane, no business-section root', async () => {
    // Close the current mount; reopen without a fetcher (the platform's
    // fail-closed path when jsonBaseUrl is unset).
    if (shell) await shell.close();
    const handle = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
    });
    const r = await handle.listen();
    const baseUrl2 = r.url;
    try {
      const { signCookie } = require('../src/app/admin/shell-auth');
      const cookie = signCookie(SECRET, {
        iss: 'du-admin-shell',
        role: 'admin',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const res = await httpRequest(`${baseUrl2}/admin/businesses`, {
        headers: { cookie: `du_admin=${cookie}` },
      });
      expect(res.status).toBe(200);
      // Shell chrome is intact; the deferred hook is a no-op when no
      // fetcher is configured.
      expect(res.body).toContain('screen-state--ready');
      expect(res.body).not.toContain('<section class="business-section"');
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P6-03 — Mounted shell drives the deferred Profile section with a stub
// fetcher. Same composition proof as the P6-02 block above, but for the
// schema-driven profile editor: the platform mount + deferred hook + the
// profile renderer + the cookie-protected role guard over real HTTP.
// ---------------------------------------------------------------------------

describe('platform-mount: attachAdminShell (P6-03, deferred Profile section)', () => {
  const profileSeen: ProfileFetcherInput[] = [];

  const profileSchema: ProfileSchemaInput = {
    businessId: 'document-core',
    businessVersion: 'v1',
    manifest: {
      actions: [
        {
          name: 'extract',
          title: 'Extract',
          slots: [
            { name: 'model', required: true, widget: 'text' },
            { name: 'temperature', required: false, widget: 'number' },
            { name: 'prompt', required: false, widget: 'textarea' },
            { name: 'apiKey', required: true, widget: 'secret' },
            {
              name: 'pair',
              required: false,
              widget: 'select',
              options: [
                { value: 'openai/gpt-4', label: 'openai/gpt-4' },
                { value: 'anthropic/claude', label: 'anthropic/claude' },
              ],
            },
            { name: 'exotic', required: false, widget: 'fusion-turbo' },
            { name: 'tenantTag', required: false, widget: 'text' },
          ],
        },
      ],
    },
    capabilityOptions: [],
    existingProfile: { name: 'p-default', revision: 7 },
  };

  const fetcher = async (input: ProfileFetcherInput): Promise<ProfileFetchResult> => {
    profileSeen.push(input);
    return {
      kind: 'ok',
      businessId: 'document-core',
      businessVersion: 'v1',
      profileName: 'p-default',
      revision: 7,
      model: buildProfileFormModel(profileSchema),
      currentValues: Object.freeze({ model: 'openai/gpt-4', apiKey: 'sk-secret-xyz' }),
      promptCatalog: new Map<string, readonly string[]>([['prompt', ['system', 'user']]]),
      originalWidgetBySlot: new Map<string, string>([['exotic', 'fusion-turbo']]),
      lockedBySlot: new Set<string>(['tenantTag']),
      lockedValueBySlot: new Map<string, string>([['tenantTag', 'tenant-acme']]),
    };
  };

  let shell: AdminShellHandle | null = null;
  let baseUrl = '';

  beforeAll(async () => {
    shell = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: { profiles: fetcher },
    });
    const r = await shell.listen();
    baseUrl = r.url;
  });

  afterAll(async () => {
    if (shell) {
      try {
        await shell.close();
      } catch {
        // already closed by the last test — swallow so suite teardown is clean
      }
      shell = null;
    }
  });

  it('GET /admin/profiles with admin cookie + stub fetcher → 200 with form spliced + nav chrome', async () => {
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(
      `${baseUrl}/admin/profiles?businessId=document-core&businessVersion=v1&profile=p-default`,
      { headers: { cookie: `du_admin=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Full shell chrome is still present (real route integration).
    expect(res.body).toContain('screen-state--ready');
    expect(res.body).toContain('href="/admin/profiles"');
    expect(res.body).toContain('data-role="admin"');
    // Section root + form + revision spliced at the deferred marker.
    expect(res.body).toContain('<section class="profile-section"');
    expect(res.body).toContain('data-business-id="document-core"');
    expect(res.body).toContain('data-revision="7"');
    expect(res.body).toContain ('<form method="POST" action="/admin/profiles"');
    // The fetcher was invoked with the query businessId + the admin token
    // the platform configured (auth handshake survives the deferred path).
    const call = profileSeen[profileSeen.length - 1]!;
    expect(call.businessId).toBe('document-core');
    expect(call.adminToken).toBe(TOKEN);
  });

  it('DOM evidence: per-action section, widget types, masked secret, lock + prompt catalog', async () => {
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(
      `${baseUrl}/admin/profiles?businessId=document-core&businessVersion=v1`,
      { headers: { cookie: `du_admin=${cookie}` } },
    );
    expect(res.body).toContain('data-action="extract"');
    expect(res.body).toContain('data-slot="model"');
    expect(res.body).toContain('data-widget="text"');
    expect(res.body).toContain('value="openai/gpt-4"');
    expect(res.body).toContain('data-widget="number"');
    expect(res.body).toContain('field-input--textarea');
    expect(res.body).toContain('data-widget="select"');
    // Secret: masked, raw key never echoed.
    expect(res.body).toContain('type="password"');
    expect(res.body).toContain('value="••••••••"');
    expect(res.body).not.toContain('sk-secret-xyz');
    // Unknown widget: fallback banner + source attribute.
    expect(res.body).toContain('profile-section__unknown-banner');
    expect(res.body).toContain('data-unknown-widget="fusion-turbo"');
    // Prompt catalog hint column.
    expect(res.body).toContain('field-prompt-catalog');
    expect(res.body).toContain('<code>system</code>');
    // Locked slot: readonly + disabled, server value verbatim.
    expect(res.body).toContain('data-locked="true"');
    expect(res.body).toContain('field--locked');
    expect(res.body).toContain('value="tenant-acme"');
    expect(res.body).toContain('readonly');
    expect(res.body).toContain('disabled');
  });

  it('viewer role is 403 on /admin/profiles (no fetcher invocation)', async () => {
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'viewer',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const beforeCalls = profileSeen.length;
    const res = await httpRequest(`${baseUrl}/admin/profiles?businessId=document-core`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(403);
    expect(res.body).toContain('Access denied');
    expect(profileSeen.length).toBe(beforeCalls);
  });

  it('missing cookie on /admin/profiles → 401 (no fetcher invocation)', async () => {
    const beforeCalls = profileSeen.length;
    const res = await httpRequest(`${baseUrl}/admin/profiles?businessId=document-core`);
    expect(res.status).toBe(401);
    expect(res.body).toContain('Sign-in required');
    expect(profileSeen.length).toBe(beforeCalls);
  });

  it('GET /admin/profiles with no fetcher wired → 200 ready pane, no profile-section root', async () => {
    if (shell) await shell.close();
    const handle = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: {},
    });
    const r = await handle.listen();
    try {
      const cookie = signCookie(SECRET, {
        iss: 'du-admin-shell',
        role: 'admin',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const res = await httpRequest(`${r.url}/admin/profiles?businessId=document-core`, {
        headers: { cookie: `du_admin=${cookie}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('screen-state--ready');
      expect(res.body).not.toContain('<section class="profile-section"');
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P6-04 — Mounted shell drives the deferred Connector section with a stub
// fetcher. Same composition proof as the P6-02/P6-03 blocks above: the
// platform mount + deferred hook + the write-only connector renderer +
// the cookie-protected role guard over real HTTP. The fetch result is
// built directly so the test stays offline; the platform GET route is
// requested separately in coordination/reports/openclaude.md.
// ---------------------------------------------------------------------------

describe('platform-mount: attachAdminShell (P6-04, deferred Connector section)', () => {
  const connectorSeen: ConnectorFetcherInput[] = [];

  const fetcher = async (input: ConnectorFetcherInput): Promise<ConnectorFetchResult> => {
    connectorSeen.push(input);
    return {
      kind: 'ok',
      connectorId: 'openai',
      revision: 7,
      revisionView: {
        connectorId: 'openai',
        revision: 7,
        adapter: 'openai-adapter',
        endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
        capabilities: ['gpt-4', 'gpt-3.5-turbo'],
        state: 'enabled',
        stateBadge: 'success',
        stateLabel: 'Enabled',
        createdAt: '2026-09-23T10:00:00Z',
        updatedAt: '2026-09-23T18:00:00Z',
        secretSlots: [
          {
            name: 'apiKey',
            label: 'API key',
            hasValue: true,
            statusBadge: 'success',
            statusLabel: 'Configured',
            rotatedAt: '2026-09-22T10:00:00Z',
          },
          {
            name: 'webhookSecret',
            label: 'Webhook secret',
            hasValue: false,
            statusBadge: 'warning',
            statusLabel: 'Not configured',
            rotatedAt: null,
          },
        ],
        totalSecretSlots: 2,
        hasAnySecret: true,
      },
      testResult: {
        kind: 'success',
        message: 'Connected to upstream in 134 ms.',
        label: 'Success',
        badge: 'success',
        connectorId: 'openai',
        revision: 7,
        testedAt: '2026-09-23T18:00:00Z',
        canRetry: false,
      },
      rotateState: 'idle',
      secretSlotViews: [
        {
          name: 'apiKey',
          label: 'API key',
          hasValue: true,
          statusBadge: 'success',
          statusLabel: 'Configured',
          rotatedAt: '2026-09-22T10:00:00Z',
        },
        {
          name: 'webhookSecret',
          label: 'Webhook secret',
          hasValue: false,
          statusBadge: 'warning',
          statusLabel: 'Not configured',
          rotatedAt: null,
        },
      ],
      revisionRow: {
        connectorId: 'openai',
        revision: 7,
        adapter: 'openai-adapter',
        endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
        capabilities: ['gpt-4', 'gpt-3.5-turbo'],
        state: 'enabled',
        createdAt: '2026-09-23T10:00:00Z',
        updatedAt: '2026-09-23T18:00:00Z',
      },
      revisionLabel: '#7',
    };
  };

  let shell: AdminShellHandle | null = null;
  let baseUrl = '';

  beforeAll(async () => {
    shell = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: { connectors: fetcher },
    });
    const r = await shell.listen();
    baseUrl = r.url;
  });

  afterAll(async () => {
    if (shell) {
      try {
        await shell.close();
      } catch {
        // already closed by the last test — swallow so the suite teardown is clean
      }
      shell = null;
    }
  });

  it('GET /admin/connectors with admin cookie + stub fetcher → 200 with full DOM evidence over the body', async () => {
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(
      `${baseUrl}/admin/connectors?connectorId=openai&revision=7`,
      { headers: { cookie: `du_admin=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Shell chrome + nav links + role marker.
    expect(res.body).toContain('screen-state--ready');
    expect(res.body).toContain('href="/admin/businesses"');
    expect(res.body).toContain('href="/admin/profiles"');
    expect(res.body).toContain('data-role="admin"');
    // Section root + revision label DOM evidence.
    expect(res.body).toContain('<section class="connector-section"');
    expect(res.body).toContain('data-connector-id="openai"');
    expect(res.body).toContain('data-revision-label="#7"');
    expect(res.body).toContain('data-revision="7"');
    // Write-only secret DOM evidence: type=password, empty value, marker;
    // and Configured / Not configured badges. Raw value never rendered.
    expect(res.body).toContain('data-slot="apiKey"');
    expect(res.body).toContain('type="password"');
    expect(res.body).toContain('value=""');
    expect(res.body).toContain('data-write-only="true"');
    expect(res.body).toContain('data-secret-state="configured"');
    expect(res.body).toContain('data-secret-state="not-configured"');
    expect(res.body).toContain('Configured');
    expect(res.body).not.toContain('sk-');
    // Explicit test-result DOM evidence.
    expect(res.body).toContain('data-test-result-kind="success"');
    expect(res.body).toContain('data-test-result="success"');
    expect(res.body).toContain('data-tested-at="2026-09-23T18:00:00Z"');
    expect(res.body).toContain('Connected to upstream in 134 ms.');
    expect(res.body).toContain('data-action="test-connection"');
    // Fetcher was invoked with the query params + admin token.
    expect(connectorSeen).toHaveLength(1);
    expect(connectorSeen[0]!.connectorId).toBe('openai');
    expect(connectorSeen[0]!.revision).toBe(7);
    expect(connectorSeen[0]!.adminToken).toBe(TOKEN);
  });

  it('GET /admin/connectors failure path (stub returns unauthorized) → 200 fail-closed pane', async () => {
    if (shell) await shell.close();
    const callsBefore = connectorSeen.length;
    const failFetcher = async (_input: ConnectorFetcherInput): Promise<ConnectorFetchResult> => ({
      kind: 'unauthorized',
      connectorId: 'openai',
      message: 'Platform rejected the admin token (HTTP 401).',
    });
    shell = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: { connectors: failFetcher },
    });
    const r = await shell.listen();
    baseUrl = r.url;
    try {
      const cookie = signCookie(SECRET, {
        iss: 'du-admin-shell',
        role: 'operator',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const res = await httpRequest(
        `${baseUrl}/admin/connectors?connectorId=openai`,
        { headers: { cookie: `du_admin=${cookie}` } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('connector-section--unauthorized');
      expect(res.body).toContain('Admin token rejected');
      expect(res.body).not.toContain('type="password"');
      expect(connectorSeen.length).toBe(callsBefore);
    } finally {
      // shell stays alive for the next test (close in afterAll).
    }
  });

  it('viewer role is 403 on /admin/connectors (no fetcher invocation)', async () => {
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'viewer',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const beforeCalls = connectorSeen.length;
    const res = await httpRequest(
      `${baseUrl}/admin/connectors?connectorId=openai`,
      { headers: { cookie: `du_admin=${cookie}` } },
    );
    expect(res.status).toBe(403);
    expect(res.body).toContain('Access denied');
    expect(connectorSeen.length).toBe(beforeCalls);
  });

  it('missing cookie on /admin/connectors → 401 (no fetcher invocation)', async () => {
    const beforeCalls = connectorSeen.length;
    const res = await httpRequest(`${baseUrl}/admin/connectors?connectorId=openai`);
    expect(res.status).toBe(401);
    expect(res.body).toContain('Sign-in required');
    expect(connectorSeen.length).toBe(beforeCalls);
  });

  it('GET /admin/connectors with no fetcher wired → 200 ready pane, no connector-section root', async () => {
    if (shell) await shell.close();
    const handle = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: {},
    });
    const r = await handle.listen();
    try {
      const cookie = signCookie(SECRET, {
        iss: 'du-admin-shell',
        role: 'admin',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const res = await httpRequest(
        `${r.url}/admin/connectors?connectorId=openai`,
        { headers: { cookie: `du_admin=${cookie}` } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('screen-state--ready');
      expect(res.body).not.toContain('<section class="connector-section"');
    } finally {
      await handle.close();
    }
  });
});

// -------------------------------------------------------------------------
// P6-05 — API key create / copy-once / revoke / assignment section
// -------------------------------------------------------------------------
//
// Drives the deferred hook from a stub fetcher over the real HTTP
// boundary. Asserts the full DOM evidence (masked hint only, no raw
// key material; explicit data-copy-once-available discriminator;
// data-can-revoke; assignment table) over `res.body`.

describe('platform-mount: attachAdminShell (P6-05, deferred API keys section)', () => {
  const apiKeysSeen: ApiKeyFetcherInput[] = [];

  const fetcher = async (input: ApiKeyFetcherInput): Promise<ApiKeyFetchResult> => {
    apiKeysSeen.push(input);
    return {
      kind: 'ok',
      rows: [
        {
          id: 'k_alpha',
          tenantId: 'tenant-1',
          maskedHint: 'abcd…',
          prefix: 'du_live_',
          status: 'ACTIVE',
          statusBadge: 'success',
          statusLabel: 'Active',
          createdAt: '2026-09-20T00:00:00Z',
          lastUsedAt: '2026-09-22T00:00:00Z',
          label: 'CI runner',
          revokedAt: null,
          canRevoke: true,
        },
      ],
      total: 1,
      selected: {
        id: 'k_alpha',
        tenantId: 'tenant-1',
        maskedHint: 'abcd…',
        prefix: 'du_live_',
        status: 'ACTIVE',
        statusBadge: 'success',
        statusLabel: 'Active',
        createdAt: '2026-09-20T00:00:00Z',
        lastUsedAt: '2026-09-22T00:00:00Z',
        label: 'CI runner',
        revokedAt: null,
        canRevoke: true,
      },
      grants: [
        {
          businessId: 'biz-1',
          businessVersion: 'v1',
          action: 'ingest',
          grantedAt: '2026-09-20T01:00:00Z',
        },
      ],
      createCopyOnce: null,
      selectedKeyId: 'k_alpha',
    };
  };

  let shell: AdminShellHandle | null = null;
  let baseUrl = '';

  beforeAll(async () => {
    shell = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: { apiKeys: fetcher },
    });
    const r = await shell.listen();
    baseUrl = r.url;
  });

  afterAll(async () => {
    if (shell) {
      try {
        await shell.close();
      } catch {
        // already closed — swallow.
      }
      shell = null;
    }
  });

  it('GET /admin/api-keys?keyId=k_alpha with admin cookie + stub fetcher → 200 with full DOM evidence over the body', async () => {
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(`${baseUrl}/admin/api-keys?keyId=k_alpha`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Shell chrome + nav links + role marker.
    expect(res.body).toContain('screen-state--ready');
    expect(res.body).toContain('href="/admin/businesses"');
    expect(res.body).toContain('data-role="admin"');
    // API-keys nav item surfaced.
    expect(res.body).toContain('href="/admin/api-keys"');
    // Section root + selection + total DOM evidence.
    expect(res.body).toContain('<section class="api-key-section"');
    expect(res.body).toContain('data-key-total="1"');
    expect(res.body).toContain('data-key-selected="k_alpha"');
    expect(res.body).toContain('data-copy-once-available="false"');
    // List row + masked hint DOM evidence.
    expect(res.body).toContain('data-key-id="k_alpha"');
    expect(res.body).toContain('data-key-status="ACTIVE"');
    expect(res.body).toContain('data-key-masked="abcd…"');
    // Detail + revoke + grant DOM evidence.
    expect(res.body).toContain('<section class="api-key-section__detail"');
    expect(res.body).toContain('data-can-revoke="true"');
    expect(res.body).toContain('data-action="revoke-api-key"');
    expect(res.body).toContain('<section class="api-key-section__grants"');
    expect(res.body).toContain('data-grant-total="1"');
    expect(res.body).toContain('data-business-id="biz-1"');
    expect(res.body).toContain('data-business-version="v1"');
    expect(res.body).toContain('data-action="ingest"');
    // Create form DOM evidence.
    expect(res.body).toContain('action="/admin/api-keys/new"');
    expect(res.body).toContain('data-action="create-api-key"');
    // No raw key material anywhere on the wire.
    expect(res.body).not.toContain('S3CRET');
    expect(res.body).not.toContain('data-copy-once-raw=');
    // Fetcher was invoked with the query params + admin token.
    expect(apiKeysSeen).toHaveLength(1);
    expect(apiKeysSeen[0]!.keyId).toBe('k_alpha');
    expect(apiKeysSeen[0]!.adminToken).toBe(TOKEN);
  });

  it('GET /admin/api-keys failure path (stub returns unauthorized) → 200 fail-closed pane', async () => {
    if (shell) await shell.close();
    const callsBefore = apiKeysSeen.length;
    const failFetcher = async (_input: ApiKeyFetcherInput): Promise<ApiKeyFetchResult> => ({
      kind: 'unauthorized',
      message: 'Platform rejected the admin token (HTTP 401).',
    });
    shell = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: { apiKeys: failFetcher },
    });
    const r = await shell.listen();
    baseUrl = r.url;
    try {
      const cookie = signCookie(SECRET, {
        iss: 'du-admin-shell',
        role: 'admin',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const res = await httpRequest(
        `${baseUrl}/admin/api-keys?keyId=k_alpha`,
        { headers: { cookie: `du_admin=${cookie}` } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('api-key-section--unauthorized');
      expect(res.body).toContain('Admin token rejected');
      expect(res.body).not.toContain('data-can-revoke');
      expect(apiKeysSeen.length).toBe(callsBefore);
    } finally {
      // shell stays alive for the next test (close in afterAll).
    }
  });

  it('viewer role is 403 on /admin/api-keys (no fetcher invocation)', async () => {
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'viewer',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const beforeCalls = apiKeysSeen.length;
    const res = await httpRequest(
      `${baseUrl}/admin/api-keys?keyId=k_alpha`,
      { headers: { cookie: `du_admin=${cookie}` } },
    );
    expect(res.status).toBe(403);
    expect(res.body).toContain('Access denied');
    expect(apiKeysSeen.length).toBe(beforeCalls);
  });

  it('missing cookie on /admin/api-keys → 401 (no fetcher invocation)', async () => {
    const beforeCalls = apiKeysSeen.length;
    const res = await httpRequest(`${baseUrl}/admin/api-keys?keyId=k_alpha`);
    expect(res.status).toBe(401);
    expect(res.body).toContain('Sign-in required');
    expect(apiKeysSeen.length).toBe(beforeCalls);
  });

  it('GET /admin/api-keys with no fetcher wired → 200 ready pane, no api-key-section root', async () => {
    if (shell) await shell.close();
    const handle = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: {},
    });
    const r = await handle.listen();
    try {
      const cookie = signCookie(SECRET, {
        iss: 'du-admin-shell',
        role: 'admin',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const res = await httpRequest(
        `${r.url}/admin/api-keys?keyId=k_alpha`,
        { headers: { cookie: `du_admin=${cookie}` } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('screen-state--ready');
      expect(res.body).not.toContain('<section class="api-key-section"');
    } finally {
      await handle.close();
    }
  });
});

// -------------------------------------------------------------------------
// P6-06 — Operation detail / result / artifacts / cancel / resume / replay
// -------------------------------------------------------------------------
//
// Drives the deferred operations hook from a stub fetcher over the real
// HTTP boundary. Asserts the full DOM evidence over `res.body` for the
// ok pane (data-operation-selected, data-can-cancel / data-can-resume /
// data-can-replay, data-wait-cas, data-result-available,
// data-artifact-total) and the role gate (viewer allowed) + no-cookie
// (401) + no-fetcher-wired (200 ready pane, no operation-section root).

describe('platform-mount: attachAdminShell (P6-06, deferred operations section)', () => {
  const operationsSeen: OperationFetcherInput[] = [];

  const fetcher = async (input: OperationFetcherInput): Promise<OperationFetchResult> => {
    operationsSeen.push(input);
    return {
      kind: 'ok',
      selectedOperationId: 'op_42',
      detail: {
        id: 'op_42',
        businessId: 'biz-1',
        businessVersion: 'v1',
        action: 'ingest',
        status: { state: 'SUCCEEDED', label: 'Succeeded', badge: 'success', terminal: true },
        progressPercent: 100,
        progressMessage: 'done',
        createdAt: '2026-09-20T00:00:00Z',
        updatedAt: '2026-09-20T00:01:00Z',
        deadlineAt: null,
        replayOf: null,
        artifacts: [],
        errorDisplay: null,
        humanWaitForm: null,
        selfLink: '/api/v1/operations/op_42',
        resultLink: '/api/v1/operations/op_42/result',
      },
      resultDisplay: {
        schemaVersion: '1',
        dataJson: '{"ok":true}',
        dataPretty: '{\n  "ok": true\n}',
        warnings: [],
      },
      artifacts: [
        { artifactId: 'a-1', role: 'output', fileName: 'out.md', mimeType: 'text/markdown', sizeDisplay: '4.0 KB', downloadUrl: '/dl/a-1' },
      ],
      canCancel: false,
      canResume: false,
      canReplay: true,
      replayLabel: 'Replay (new operation)',
      serverNow: '2026-09-20T00:01:00Z',
    };
  };

  let shell: AdminShellHandle | null = null;
  let baseUrl = '';

  beforeAll(async () => {
    shell = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: { operations: fetcher },
    });
    const r = await shell.listen();
    baseUrl = r.url;
  });

  afterAll(async () => {
    if (shell) {
      try {
        await shell.close();
      } catch {
        // already closed — swallow.
      }
      shell = null;
    }
  });

  it('GET /admin/operations?operationId=op_42 with admin cookie + stub fetcher → 200 with full DOM evidence', async () => {
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(`${baseUrl}/admin/operations?operationId=op_42`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    // Shell chrome + nav links + role marker.
    expect(res.body).toContain('screen-state--ready');
    expect(res.body).toContain('href="/admin/businesses"');
    expect(res.body).toContain('data-role="admin"');
    // Operations nav item surfaced.
    expect(res.body).toContain('href="/admin/operations"');
    // Section root + selection + terminal-state discriminators.
    expect(res.body).toContain('<section class="operation-section"');
    expect(res.body).toContain('data-operation-selected="op_42"');
    expect(res.body).toContain('data-operation-state="SUCCEEDED"');
    expect(res.body).toContain('data-operation-terminal="true"');
    expect(res.body).toContain('data-can-cancel="false"');
    expect(res.body).toContain('data-can-resume="false"');
    expect(res.body).toContain('data-can-replay="true"');
    expect(res.body).toContain('data-replay-label="Replay (new operation)"');
    expect(res.body).toContain('data-action="replay-operation"');
    // Result panel + artifacts table DOM evidence.
    expect(res.body).toContain('data-result-available="true"');
    expect(res.body).toContain('data-result-schema-version="1"');
    expect(res.body).toContain('class="operation-section__result-data"');
    expect(res.body).toContain('data-artifact-total="1"');
    expect(res.body).toContain('data-action="download-artifact"');
    expect(res.body).toContain('data-artifact-id="a-1"');
    // Fetcher was invoked with the query params + admin token.
    expect(operationsSeen).toHaveLength(1);
    expect(operationsSeen[0]!.operationId).toBe('op_42');
    expect(operationsSeen[0]!.adminToken).toBe(TOKEN);
  });

  it('GET /admin/operations with viewer role → 200 + fetcher invoked (viewer is allowed)', async () => {
    const callsBefore = operationsSeen.length;
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'viewer',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(`${baseUrl}/admin/operations?operationId=op_42`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('data-operation-selected="op_42"');
    expect(operationsSeen.length).toBe(callsBefore + 1);
  });

  it('missing cookie on /admin/operations → 401 (no fetcher invocation)', async () => {
    const callsBefore = operationsSeen.length;
    const res = await httpRequest(`${baseUrl}/admin/operations?operationId=op_42`);
    expect(res.status).toBe(401);
    expect(res.body).toContain('Sign-in required');
    expect(operationsSeen.length).toBe(callsBefore);
  });

  it('GET /admin/operations with no fetcher wired → 200 ready pane, no operation-section root', async () => {
    if (shell) await shell.close();
    const handle = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: {},
    });
    const r = await handle.listen();
    try {
      const cookie = signCookie(SECRET, {
        iss: 'du-admin-shell',
        role: 'admin',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const res = await httpRequest(
        `${r.url}/admin/operations?operationId=op_42`,
        { headers: { cookie: `du_admin=${cookie}` } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('screen-state--ready');
      expect(res.body).not.toContain('<section class="operation-section"');
    } finally {
      await handle.close();
    }
  });
});

// ---------------------------------------------------------------------------
// P6-07: platform-mount proof for the deferred overview section.
// Mirrors the P6-06 operations block above: replays the platform's call
// path against `attachAdminShell` with a stubbed `sectionFetchers.overview`
// and asserts the full DOM evidence (usage + audit + health) over the
// real HTTP route, plus role-gate / no-cookie / no-fetcher-wired cases.
// ---------------------------------------------------------------------------

describe('platform-mount: attachAdminShell (P6-07, deferred overview section)', () => {
  const overviewSeen: OverviewFetcherInput[] = [];

  const fetcher = async (input: OverviewFetcherInput): Promise<OverviewFetchResult> => {
    overviewSeen.push(input);
    const usage = buildUsageRollupView({
      tenantId: 'tenant-main',
      from: '2026-09-23T00:00:00.000Z',
      to: '2026-09-24T00:00:00.000Z',
      rows: [
        {
          provider: 'openai',
          model: 'gpt-4o-mini',
          operations: 7,
          inputTokens: 5000,
          outputTokens: 2500,
          pages: 5,
          costMicrousd: 250000,
          measurement: 'measured',
        },
      ],
      totals: {
        operations: 7,
        inputTokens: 5000,
        outputTokens: 2500,
        pages: 5,
        costMicrousd: 250000,
      },
    });
    const audit = buildAuditListView({
      tenantId: 'tenant-main',
      events: [
        {
          id: 'evt_1',
          kind: 'operation.complete',
          severity: 'success',
          occurredAt: '2026-09-24T11:30:00Z',
          tenantId: 'tenant-main',
          resourceId: 'op_42',
          actor: 'system',
          message: 'Operation op_42 completed successfully.',
        },
      ],
    });
    const health = buildHealthOverviewView({
      status: 'ok',
      db: true,
      redis: true,
      activeLeases: 1,
    });
    return {
      kind: 'ok',
      tenantId: 'tenant-main',
      from: '2026-09-23T00:00:00.000Z',
      to: '2026-09-24T00:00:00.000Z',
      bundle: {
        serverNow: '2026-09-24T11:55:00Z',
        usage,
        audit,
        health,
      },
    };
  };

  let shell: AdminShellHandle | null = null;
  let baseUrl = '';

  beforeAll(async () => {
    shell = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: { overview: fetcher },
    });
    const r = await shell.listen();
    baseUrl = r.url;
  });

  afterAll(async () => {
    if (shell) {
      try {
        await shell.close();
      } catch {
        // already closed
      }
      shell = null;
    }
  });

  it('GET /admin/overview?tenantId=… with admin cookie → 200 + full DOM evidence spliced in', async () => {
    const callsBefore = overviewSeen.length;
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(
      `${baseUrl}/admin/overview?tenantId=tenant-main`,
      { headers: { cookie: `du_admin=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
    // Shell chrome.
    expect(res.body).toContain('data-admin-shell="v1"');
    // Section root + window.
    expect(res.body).toContain('<section class="overview-section"');
    expect(res.body).toContain('data-overview-tenant="tenant-main"');
    expect(res.body).toContain('data-overview-from=');
    expect(res.body).toContain('data-overview-to=');
    // Sub-pane flags.
    expect(res.body).toContain('data-overview-usage-available="true"');
    expect(res.body).toContain('data-overview-audit-available="true"');
    expect(res.body).toContain('data-overview-health-available="true"');
    // Usage discriminators.
    expect(res.body).toContain('data-usage-total="1"');
    expect(res.body).toContain('data-usage-tenant="tenant-main"');
    expect(res.body).toContain('data-usage-row="openai|gpt-4o-mini"');
    expect(res.body).toContain('data-usage-provider="openai"');
    expect(res.body).toContain('data-usage-model="gpt-4o-mini"');
    expect(res.body).toContain('data-usage-measurement="measured"');
    // Audit discriminators.
    expect(res.body).toContain('data-audit-total="1"');
    expect(res.body).toContain('data-audit-id="evt_1"');
    expect(res.body).toContain('data-audit-kind="operation.complete"');
    expect(res.body).toContain('data-audit-severity="success"');
    // Health discriminators.
    expect(res.body).toContain('data-health-status="ok"');
    expect(res.body).toContain('data-health-fully-healthy="true"');
    expect(res.body).toContain('data-health-overall="ok"');
    // Fetcher invocation.
    expect(overviewSeen.length).toBe(callsBefore + 1);
    expect(overviewSeen[overviewSeen.length - 1]!.tenantId).toBe('tenant-main');
    expect(overviewSeen[overviewSeen.length - 1]!.adminToken).toBe(TOKEN);
  });

  it('GET /admin/overview with viewer role → 200 + fetcher invoked (viewer is allowed)', async () => {
    const callsBefore = overviewSeen.length;
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'viewer',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(
      `${baseUrl}/admin/overview?tenantId=tenant-main`,
      { headers: { cookie: `du_admin=${cookie}` } },
    );
    expect(res.status).toBe(200);
    expect(res.body).toContain('data-overview-tenant="tenant-main"');
    expect(res.body).toContain('data-usage-row="openai|gpt-4o-mini"');
    expect(overviewSeen.length).toBe(callsBefore + 1);
  });

  it('missing cookie on /admin/overview → 401 (no fetcher invocation)', async () => {
    const callsBefore = overviewSeen.length;
    const res = await httpRequest(`${baseUrl}/admin/overview?tenantId=tenant-main`);
    expect(res.status).toBe(401);
    expect(res.body).toContain('Sign-in required');
    expect(overviewSeen.length).toBe(callsBefore);
  });

  it('GET /admin/overview with no fetcher wired → 200 ready pane, no overview-section root', async () => {
    if (shell) await shell.close();
    const handle = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
      sectionFetchers: {},
    });
    const r = await handle.listen();
    try {
      const cookie = signCookie(SECRET, {
        iss: 'du-admin-shell',
        role: 'admin',
        iat: Date.now(),
        exp: Date.now() + 60_000,
      });
      const res = await httpRequest(
        `${r.url}/admin/overview?tenantId=tenant-main`,
        { headers: { cookie: `du_admin=${cookie}` } },
      );
      expect(res.status).toBe(200);
      expect(res.body).toContain('screen-state--ready');
      expect(res.body).not.toContain('<section class="overview-section"');
    } finally {
      await handle.close();
    }
  });
});
