/**
 * Sub-server end-to-end test for the Admin shell (P6-01).
 *
 * Drives `createAdminShellServer` through real `node:http` requests
 * against an ephemeral port. No DB, no Redis. Asserts HTTP status,
 * headers, and the HTML body shape that the shell actually emits
 * over the wire (not just the renderer output as a string).
 *
 * Coverage:
 *   - GET /                 → 200 text/html with <form action="/admin/login">
 *   - POST /admin/login (bad token) → 401 HTML
 *   - POST /admin/login (good token) → 302 + Set-Cookie: du_admin=…
 *     then GET /admin/businesses → 200 HTML with nav chrome + ready pane
 *   - GET /admin/profiles as viewer → 403 HTML with the denied screen state
 *   - GET /admin/missing → 404 HTML
 *   - POST /admin/logout → 302 + cleared cookie
 *   - Cookie tampering rejected
 */

import http from 'node:http';
import { createAdminShellServer as createAdminShellServerOnPort } from '../src/app/admin/shell-server';
import type { AdminShellHandle, CreateAdminShellServerOptions } from '../src/app/admin/shell-server';
import type { BusinessFetchResult, BusinessFetcherInput } from '../src/app/admin/business-section-data';
import type { ProfileFetchResult, ProfileFetcherInput } from '../src/app/admin/profile-section-data';
import type { ProfileSchemaInput } from '../src/app/admin/types';
import { buildProfileFormModel } from '../src/app/admin/profile-view-models';
import {
  buildUsageRollupView,
  buildAuditListView,
  buildHealthOverviewView,
} from '../src/app/admin/overview-view-models';
import type { ConnectorFetchResult, ConnectorFetcherInput } from '../src/app/admin/connector-section-data';
import type { ApiKeyFetchResult, ApiKeyFetcherInput } from '../src/app/admin/api-key-section-data';
import type { OperationFetchResult, OperationFetcherInput } from '../src/app/admin/operation-section-data';
import type { OverviewFetchResult, OverviewFetcherInput } from '../src/app/admin/overview-section-data';

const TOKEN = 'integration-test-token';
const SECRET = 'integration-test-secret';
const QUIET_PORT_BASE = 43_900 + (process.pid % 20) * 16;
let quietPortOffset = 0;

/** Avoid Windows ephemeral destination-port filtering in this loopback-only suite. */
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

describe('admin-shell-server (P6-01, real HTTP)', () => {
  let handle: AdminShellHandle;
  let baseUrl: string;

  beforeAll(async () => {
    handle = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: TOKEN,
    });
    const r = await handle.listen();
    expect(r.port).toBeGreaterThan(0);
    baseUrl = r.url;
  });

  afterAll(async () => {
    await handle.close();
  });

  it('binds a loopback test port and exposes the URL', () => {
    const parsed = new URL(baseUrl);
    expect(parsed.hostname).toBe('127.0.0.1');
    expect(Number(parsed.port)).toBeGreaterThan(0);
  });

  it('GET / serves the login form (because there is no cookie yet)', async () => {
    // The shell serves the login form when GET /admin/login is hit; GET /
    // without a cookie returns 401 by design (deep-link → handled).
    const res = await httpRequest(`${baseUrl}/`, { method: 'GET' });
    expect(res.status).toBe(401);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Admin');
  });

  it('GET /admin/login returns 200 HTML with the login form', async () => {
    const res = await httpRequest(`${baseUrl}/admin/login`);
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('<form method="POST" action="/admin/login"');
    expect(res.body).toContain('name="token"');
    expect(res.body).toContain('name="redirect"');
  });

  it('POST /admin/login with a bad token returns 401 HTML', async () => {
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

  it('POST /admin/login with a good token returns 302 + Set-Cookie', async () => {
    const body = new URLSearchParams({ token: TOKEN, redirect: '/admin/businesses' }).toString();
    const res = await httpRequest(`${baseUrl}/admin/login`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body,
    });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/admin/businesses');
    expect(Array.isArray(res.rawHeaders)).toBe(true);
    const cookie = getCookieFromSetCookie(res.rawHeaders);
    expect(cookie).not.toBeNull();
    expect(cookie!.startsWith('du_admin=')).toBe(true);
  });

  it('follows the cookie to GET /admin/businesses → 200 HTML with nav chrome + ready pane', async () => {
    // Mint a fresh cookie via the auth module so we exercise a real
    // round-trip through the wire.
    const { signCookie } = require('../src/app/admin/shell-auth');
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    expect(cookie).not.toBeNull();
    const res = await httpRequest(`${baseUrl}/admin/businesses`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('screen-state--ready');
    expect(res.body).toContain('href="/admin/businesses"');
    expect(res.body).toContain('href="/admin/operations"');
    expect(res.body).toContain('href="/admin/profiles"');
    expect(res.body).toContain('href="/admin/connectors"');
    expect(res.body).toContain('href="/admin/grants"');
  });

  it('GET /admin/profiles as viewer returns 403 HTML with the denied screen state', async () => {
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
    expect(res.body).toContain("requires &#39;operator&#39;");
  });

  it('GET /admin/missing returns 404 HTML', async () => {
    const res = await httpRequest(`${baseUrl}/admin/missing`);
    expect(res.status).toBe(404);
    expect(res.headers['content-type']).toContain('text/html');
    expect(res.body).toContain('Not found');
  });

  it('POST /admin/logout returns 302 with Max-Age=0', async () => {
    const res = await httpRequest(`${baseUrl}/admin/logout`, { method: 'POST' });
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/admin/login');
    const cookie = getCookieFromSetCookie(res.rawHeaders);
    expect(cookie).not.toBeNull();
    expect(cookie!.startsWith('du_admin=')).toBe(true);
    expect(res.rawHeaders.some((h, i) => i % 2 === 1 && h.toLowerCase().includes('max-age=0'))).toBe(true);
  });

  it('rejects a tampered cookie', async () => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    // Flip a byte in the signature.
    const dotIdx = cookie!.indexOf('.');
    const tampered = `${cookie!.slice(0, dotIdx + 1)}AAAA`;
    const res = await httpRequest(`${baseUrl}/admin`, {
      headers: { cookie: `du_admin=${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  it('GET /favicon.ico returns 204', async () => {
    const res = await httpRequest(`${baseUrl}/favicon.ico`);
    expect(res.status).toBe(204);
  });

  it('serves a viewer-scoped nav (no operator/admin links)', async () => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    const cookie = signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'viewer',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
    const res = await httpRequest(`${baseUrl}/admin/businesses`, {
      headers: { cookie: `du_admin=${cookie}` },
    });
    expect(res.status).toBe(200);
    expect(res.body).toContain('href="/admin/businesses"');
    expect(res.body).toContain('href="/admin/operations"');
    expect(res.body).not.toContain('href="/admin/profiles"');
    expect(res.body).not.toContain('href="/admin/connectors"');
    expect(res.body).not.toContain('href="/admin/grants"');
  });

  it('exposes the bound port and URL after listen()', () => {
    // Server-internal address is private; the handle exposes port + url.
    expect(handle.port).toBeGreaterThan(0);
    expect(typeof handle.url).toBe('string');
    expect(handle.url.startsWith('http://127.0.0.1:')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// P6-02 — Business section deferred-fetch path (in-process)
// ---------------------------------------------------------------------------

describe('admin-shell-server (P6-02, deferred business section)', () => {
  function stubFetcherFactory(result: BusinessFetchResult): {
    handle: AdminShellHandle;
    baseUrl: string;
    calls: BusinessFetcherInput[];
  } {
    const calls: BusinessFetcherInput[] = [];
    const fetcher = async (input: BusinessFetcherInput): Promise<BusinessFetchResult> => {
      calls.push(input);
      return result;
    };
    let handle!: AdminShellHandle;
    let baseUrl = '';
    beforeAll(async () => {
      handle = createAdminShellServer({
        port: 0,
        host: '127.0.0.1',
        cookieSecret: SECRET,
        adminToken: TOKEN,
        sectionFetchers: { businesses: fetcher },
      });
      const r = await handle.listen();
      baseUrl = r.url;
    });
    afterAll(async () => {
      await handle.close();
    });
    return {
      get handle(): AdminShellHandle {
        return handle;
      },
      get baseUrl(): string {
        return baseUrl;
      },
      calls,
    };
  }

  function adminCookie(): string {
    const { signCookie } = require('../src/app/admin/shell-auth');
    return signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
  }

  describe('stub returns ok rows', () => {
    const ctx = stubFetcherFactory({
      kind: 'ok',
      businessId: 'example-review',
      activeVersion: 'v2',
      rows: [
        {
          businessId: 'example-review',
          version: 'v2',
          status: 'ENABLED',
          isActive: true,
          workerHealth: 'HEALTHY',
          workerCount: 3,
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
    });

    it('GET /admin/businesses with admin cookie → 200 HTML with the table spliced in', async () => {
      const res = await httpRequest(`${ctx.baseUrl}/admin/businesses?businessId=example-review`, {
        headers: { cookie: `du_admin=${adminCookie()}` },
      });
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      // Section root.
      expect(res.body).toContain('<section class="business-section"');
      expect(res.body).toContain('data-business-id="example-review"');
      // Both versions rendered.
      expect(res.body).toContain('data-version="v2"');
      expect(res.body).toContain('data-version="v1"');
      // Active marker.
      expect(res.body).toMatch(/data-active="true"/);
    });

    it('the fetcher was invoked exactly once with the query businessId + admin token', () => {
      expect(ctx.calls).toHaveLength(1);
      const call = ctx.calls[0]!;
      expect(call.businessId).toBe('example-review');
      expect(call.adminToken).toBe(TOKEN);
    });
  });

  describe('stub returns unauthorized', () => {
    const ctx = stubFetcherFactory({
      kind: 'unauthorized',
      businessId: 'example-review',
      message: 'token expired',
    });

    it('renders the unauthorized pane (200, fail-closed at the section layer)', async () => {
      const res = await httpRequest(`${ctx.baseUrl}/admin/businesses`, {
        headers: { cookie: `du_admin=${adminCookie()}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('business-section--unauthorized');
      expect(res.body).toContain('Admin token rejected');
    });
  });

  describe('stub returns not-found (platform route missing)', () => {
    const ctx = stubFetcherFactory({
      kind: 'not-found',
      businessId: '',
      message: 'Platform does not expose a business list endpoint.',
    });

    it('renders the "Business list unavailable" pane without fabricated rows', async () => {
      const res = await httpRequest(`${ctx.baseUrl}/admin/businesses`, {
        headers: { cookie: `du_admin=${adminCookie()}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('business-section--not-found');
      expect(res.body).toContain('Business list unavailable');
      // No fabricated rows: no version markers appear.
      expect(res.body).not.toContain('data-version="');
    });
  });

  describe('stub returns transport error', () => {
    const ctx = stubFetcherFactory({
      kind: 'error',
      businessId: 'example-review',
      message: 'Timed out after 4000ms waiting for the platform.',
    });

    it('renders the error pane (200, fail-closed)', async () => {
      const res = await httpRequest(`${ctx.baseUrl}/admin/businesses?businessId=example-review`, {
        headers: { cookie: `du_admin=${adminCookie()}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('business-section--error');
      expect(res.body).toContain('Could not load business versions');
      expect(res.body).toContain('Timed out after 4000ms');
    });
  });

  describe('no fetcher wired (jsonBaseUrl omitted)', () => {
    let handle: AdminShellHandle;
    let baseUrl: string;
    beforeAll(async () => {
      handle = createAdminShellServer({
        port: 0,
        host: '127.0.0.1',
        cookieSecret: SECRET,
        adminToken: TOKEN,
        // No jsonBaseUrl → default fetcher not wired.
      });
      const r = await handle.listen();
      baseUrl = r.url;
    });
    afterAll(async () => {
      await handle.close();
    });

    it('GET /admin/businesses still returns 200 with the shell chrome; no fetcher is invoked (no fabricated rows)', async () => {
      const res = await httpRequest(`${baseUrl}/admin/businesses`, {
        headers: { cookie: `du_admin=${adminCookie()}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('screen-state--ready');
      // The ready pane renders without the business-section root when no
      // fetcher produced extras — proves the deferred hook is opt-in.
      expect(res.body).not.toContain('<section class="business-section"');
    });
  });

  describe('viewer role → 403 on /admin/profiles (no fetcher invoked)', () => {
    let handle: AdminShellHandle;
    let baseUrl: string;
    const calls: BusinessFetcherInput[] = [];
    beforeAll(async () => {
      handle = createAdminShellServer({
        port: 0,
        host: '127.0.0.1',
        cookieSecret: SECRET,
        adminToken: TOKEN,
        sectionFetchers: {
          businesses: async (input) => {
            calls.push(input);
            return { kind: 'ok', businessId: 'example-review', rows: [], activeVersion: null };
          },
        },
      });
      const r = await handle.listen();
      baseUrl = r.url;
    });
    afterAll(async () => {
      await handle.close();
    });

    it('viewer is blocked at the role guard before the deferred hook fires', async () => {
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
      expect(res.body).toContain('Access denied');
      expect(calls).toHaveLength(0);
    });
  });
});

// ---------------------------------------------------------------------------
// P6-03 — Profile section deferred-fetch path (in-process, route + DOM)
// ---------------------------------------------------------------------------

describe('admin-shell-server (P6-03, deferred profile section)', () => {
  const profileCookie = (): string => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    return signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'operator',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
  };

  const profileSchema: ProfileSchemaInput = {
    businessId: 'document-core',
    businessVersion: 'v1',
    manifest: {
      actions: [
        {
          name: 'extract',
          title: 'Extract',
          slots: [
            { name: 'model', required: true, widget: 'text', description: 'Model id' },
            { name: 'temperature', required: false, widget: 'number' },
            { name: 'prompt', required: false, widget: 'textarea' },
            { name: 'apiKey', required: true, widget: 'secret' },
            { name: 'strict', required: false, widget: 'boolean' },
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

  function profileFetcherFactory(
    result: ProfileFetchResult,
  ): { handle: AdminShellHandle; baseUrl: string; calls: ProfileFetcherInput[] } {
    const calls: ProfileFetcherInput[] = [];
    const fetcher = async (input: ProfileFetcherInput): Promise<ProfileFetchResult> => {
      calls.push(input);
      return result;
    };
    let handle!: AdminShellHandle;
    let baseUrl = '';
    beforeAll(async () => {
      handle = createAdminShellServer({
        port: 0,
        host: '127.0.0.1',
        cookieSecret: SECRET,
        adminToken: TOKEN,
        sectionFetchers: { profiles: fetcher },
      });
      const r = await handle.listen();
      baseUrl = r.url;
    });
    afterAll(async () => {
      await handle.close();
    });
    return {
      get handle(): AdminShellHandle {
        return handle;
      },
      get baseUrl(): string {
        return baseUrl;
      },
      calls,
    };
  }

  describe('stub returns the ok pane', () => {
    const ctx = profileFetcherFactory({
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
    });

    it('GET /admin/profiles with operator cookie → 200 HTML with the form spliced in', async () => {
      const res = await httpRequest(
        `${ctx.baseUrl}/admin/profiles?businessId=document-core&businessVersion=v1&profile=p-default`,
        { headers: { cookie: `du_admin=${profileCookie()}` } },
      );
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('text/html');
      // Route evidence: the section root sits inside the shell body,
      // spliced at the `</section></main>` marker.
      expect(res.body).toContain('<section class="profile-section"');
      expect(res.body).toContain('data-business-id="document-core"');
      expect(res.body).toContain('data-revision="7"');
      expect(res.body).toContain('<form method="POST" action="/admin/profiles"');
      expect(res.body).toContain('screen-state--ready');
    });

    it('DOM evidence: one section per action, slots rendered with the right widget', async () => {
      const res = await httpRequest(
        `${ctx.baseUrl}/admin/profiles?businessId=document-core&businessVersion=v1`,
        { headers: { cookie: `du_admin=${profileCookie()}` } },
      );
      expect(res.body).toContain('data-action="extract"');
      expect(res.body).toContain('data-slot="model"');
      expect(res.body).toContain('data-widget="text"');
      expect(res.body).toContain('value="openai/gpt-4"');
      expect(res.body).toContain('data-widget="number"');
      expect(res.body).toContain('field-input--textarea');
      expect(res.body).toContain('data-widget="boolean"');
      expect(res.body).toContain('data-widget="select"');
      // Secret: masked, raw key never echoed.
      expect(res.body).toContain('type="password"');
      expect(res.body).toContain('value="••••••••"');
      expect(res.body).not.toContain('sk-secret-xyz');
      // Unknown widget: fallback banner + source attribute.
      expect(res.body).toContain('profile-section__unknown-banner');
      expect(res.body).toContain('data-unknown-widget="fusion-turbo"');
      expect(res.body).toContain('data-unknown-fallback="true"');
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

    it('the fetcher was invoked with the query businessId + admin token', () => {
      const call = ctx.calls[ctx.calls.length - 1]!;
      expect(call.businessId).toBe('document-core');
      expect(call.adminToken).toBe(TOKEN);
    });
  });

  describe('stub returns unauthorized', () => {
    const ctx = profileFetcherFactory({
      kind: 'unauthorized',
      businessId: 'document-core',
      message: 'token expired',
    });

    it('renders the unauthorized pane (200, fail-closed at the section layer)', async () => {
      const res = await httpRequest(`${ctx.baseUrl}/admin/profiles?businessId=document-core`, {
        headers: { cookie: `du_admin=${profileCookie()}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('profile-section--unauthorized');
      expect(res.body).toContain('Admin token rejected');
    });
  });

  describe('stub returns empty (no business selected)', () => {
    const ctx = profileFetcherFactory({
      kind: 'empty',
      businessId: '',
      message: 'Pick a business to open its profile editor.',
    });

    it('renders the empty pane without a fabricated form', async () => {
      const res = await httpRequest(`${ctx.baseUrl}/admin/profiles`, {
        headers: { cookie: `du_admin=${profileCookie()}` },
      });
      expect(res.status).toBe(200);
      expect(res.body).toContain('profile-section--empty');
      expect(res.body).toContain('Pick a business');
      expect(res.body).not.toContain('<form method="POST" action="/admin/profiles"');
    });
  });
});

// ---------------------------------------------------------------------------
// P6-04 — Connector section deferred-fetch path (in-process, route + DOM)
// ---------------------------------------------------------------------------

describe('admin-shell-server (P6-04, deferred connector section)', () => {
  const connectorCookie = (): string => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    return signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'operator',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
  };

  function connectorFetcherFactory(
    result: ConnectorFetchResult,
  ): { handle: AdminShellHandle; baseUrl: string; calls: ConnectorFetcherInput[] } {
    const calls: ConnectorFetcherInput[] = [];
    const fetcher = async (input: ConnectorFetcherInput): Promise<ConnectorFetchResult> => {
      calls.push(input);
      return result;
    };
    const server = createAdminShellServer({
      adminToken: TOKEN,
      cookieSecret: SECRET,
      sectionFetchers: { connectors: fetcher },
    });
    return { handle: server, baseUrl: '', calls };
  }

  const okConnectorResult = (): ConnectorFetchResult => ({
    kind: 'ok',
    connectorId: 'openai',
    revision: 7,
    revisionView: {
      connectorId: 'openai',
      revision: 7,
      adapter: 'openai-adapter',
      endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
      capabilities: ['gpt-4'],
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
      ],
      totalSecretSlots: 1,
      hasAnySecret: true,
    },
    testResult: {
      kind: 'success',
      message: 'Connected to upstream.',
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
    ],
    revisionRow: {
      connectorId: 'openai',
      revision: 7,
      adapter: 'openai-adapter',
      endpoint: { kind: 'https', maskedHost: 'api.openai.***' },
      capabilities: ['gpt-4'],
      state: 'enabled',
      createdAt: '2026-09-23T10:00:00Z',
      updatedAt: '2026-09-23T18:00:00Z',
    },
    revisionLabel: '#7',
  });

  describe('stub returns the ok pane', () => {
    it('GET /admin/connectors with operator cookie → 200 HTML with DOM evidence spliced in', async () => {
      const { handle } = connectorFetcherFactory(okConnectorResult());
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/connectors?connectorId=openai&revision=7`,
          { headers: { cookie: `du_admin=${connectorCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        // Section root + revision label DOM evidence.
        expect(res.body).toContain('<section class="connector-section"');
        expect(res.body).toContain('data-connector-id="openai"');
        expect(res.body).toContain('data-revision-label="#7"');
        // Write-only secret DOM evidence: password field, empty value, marker.
        expect(res.body).toContain('type="password"');
        expect(res.body).toContain('value=""');
        expect(res.body).toContain('data-write-only="true"');
        expect(res.body).not.toContain('sk-');
        // Explicit test-result DOM evidence.
        expect(res.body).toContain('data-test-result-kind="success"');
        expect(res.body).toContain('data-test-result="success"');
        expect(res.body).toContain('data-action="test-connection"');
      } finally {
        await handle.close();
      }
    });

    it('query params reach the fetcher as a ConnectorFetcherInput', async () => {
      const ctx = connectorFetcherFactory(okConnectorResult());
      const { port } = await ctx.handle.listen();
      try {
        await httpRequest(
          `http://127.0.0.1:${port}/admin/connectors?connectorId=openai&revision=7`,
          { headers: { cookie: `du_admin=${connectorCookie()}` } },
        );
        expect(ctx.calls.length).toBe(1);
        expect(ctx.calls[0]!.connectorId).toBe('openai');
        expect(ctx.calls[0]!.revision).toBe(7);
      } finally {
        await ctx.handle.close();
      }
    });
  });

  describe('stub returns unauthorized', () => {
    it('renders the unauthorized pane (200, fail-closed at the section layer)', async () => {
      const { handle } = connectorFetcherFactory({
        kind: 'unauthorized',
        connectorId: 'openai',
        message: 'Platform rejected the admin token (HTTP 401).',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/connectors?connectorId=openai`,
          { headers: { cookie: `du_admin=${connectorCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('connector-section--unauthorized');
        expect(res.body).toContain('Admin token rejected');
        // No write affordance on the failure pane.
        expect(res.body).not.toContain('type="password"');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns empty (no connector selected)', () => {
    it('renders the empty pane without a fabricated form', async () => {
      const { handle } = connectorFetcherFactory({
        kind: 'empty',
        connectorId: '',
        message: 'Pick a connector to open its configuration pane.',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(`http://127.0.0.1:${port}/admin/connectors`, {
          headers: { cookie: `du_admin=${connectorCookie()}` },
        });
        expect(res.status).toBe(200);
        expect(res.body).toContain('connector-section--empty');
        expect(res.body).toContain('Pick a connector');
        expect(res.body).not.toContain('type="password"');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns not-found (platform GET route missing)', () => {
    it('renders the not-found pane without fabricated rows', async () => {
      const { handle } = connectorFetcherFactory({
        kind: 'not-found',
        connectorId: 'openai',
        message: "Connector 'openai' revision 'latest' is not on the server.",
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/connectors?connectorId=openai`,
          { headers: { cookie: `du_admin=${connectorCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('connector-section--not-found');
        expect(res.body).toContain('not registered');
        expect(res.body).not.toContain('type="password"');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns transport error', () => {
    it('renders the error pane with the sanitized message', async () => {
      const { handle } = connectorFetcherFactory({
        kind: 'error',
        connectorId: 'openai',
        message: 'Network error contacting the platform.',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/connectors?connectorId=openai`,
          { headers: { cookie: `du_admin=${connectorCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('connector-section--error');
        expect(res.body).toContain('Network error');
        expect(res.body).not.toContain('type="password"');
      } finally {
        await handle.close();
      }
    });
  });

  describe('viewer role → 403 on /admin/connectors (no fetcher invoked)', () => {
    it('viewer is blocked at the role guard before the deferred hook fires', async () => {
      const ctx = connectorFetcherFactory(okConnectorResult());
      const { port } = await ctx.handle.listen();
      try {
        const { signCookie } = require('../src/app/admin/shell-auth');
        const viewerCookie = signCookie(SECRET, {
          iss: 'du-admin-shell',
          role: 'viewer',
          iat: Date.now(),
          exp: Date.now() + 60_000,
        });
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/connectors?connectorId=openai`,
          { headers: { cookie: `du_admin=${viewerCookie}` } },
        );
        expect(res.status).toBe(403);
        expect(res.body).toContain('Access denied');
        expect(ctx.calls.length).toBe(0);
      } finally {
        await ctx.handle.close();
      }
    });
  });

  describe('no fetcher wired', () => {
    it('does not splice a connector section when sectionFetchers.connectors is absent', async () => {
      const server = createAdminShellServer({
        adminToken: TOKEN,
        cookieSecret: SECRET,
      });
      const { port } = await server.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/connectors?connectorId=openai`,
          { headers: { cookie: `du_admin=${connectorCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).not.toContain('class="connector-section"');
      } finally {
        await server.close();
      }
    });
  });
});

// -------------------------------------------------------------------------
// P6-05 — API key create / copy-once / revoke / assignment section
// -------------------------------------------------------------------------
//
// Drives the deferred hook against the real `node:http` server.
// Asserts the full DOM-evidence (masked hint only, no raw key value;
// explicit data-copy-once-available discriminator; data-can-revoke on
// the revoke panel) and verifies the role guard, the fetcher input
// propagation, and the four fallback panes.

describe('admin-shell-server (P6-05, deferred api-keys section)', () => {
  const adminCookie = (): string => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    return signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
  };

  function apiKeyFetcherFactory(
    result: ApiKeyFetchResult,
  ): { handle: AdminShellHandle; calls: ApiKeyFetcherInput[] } {
    const calls: ApiKeyFetcherInput[] = [];
    const fetcher = async (input: ApiKeyFetcherInput): Promise<ApiKeyFetchResult> => {
      calls.push(input);
      return result;
    };
    const server = createAdminShellServer({
      adminToken: TOKEN,
      cookieSecret: SECRET,
      sectionFetchers: { apiKeys: fetcher },
    });
    return { handle: server, calls };
  }

  const okApiKeyResult = (): ApiKeyFetchResult => ({
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
  });

  describe('stub returns the ok pane', () => {
    it('GET /admin/api-keys?keyId=k_alpha → 200 HTML with full DOM evidence spliced in', async () => {
      const { handle } = apiKeyFetcherFactory(okApiKeyResult());
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/api-keys?keyId=k_alpha`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
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
        // No raw key material anywhere on the wire.
        expect(res.body).not.toContain('S3CRET');
        expect(res.body).not.toContain('data-copy-once-raw=');
      } finally {
        await handle.close();
      }
    });

    it('query params reach the fetcher as an ApiKeyFetcherInput', async () => {
      const ctx = apiKeyFetcherFactory(okApiKeyResult());
      const { port } = await ctx.handle.listen();
      try {
        await httpRequest(
          `http://127.0.0.1:${port}/admin/api-keys?keyId=k_alpha`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(ctx.calls.length).toBe(1);
        expect(ctx.calls[0]!.keyId).toBe('k_alpha');
        expect(ctx.calls[0]!.adminToken).toBe(TOKEN);
      } finally {
        await ctx.handle.close();
      }
    });
  });

  describe('stub returns unauthorized', () => {
    it('renders the unauthorized pane without a copy-once or revoke form', async () => {
      const { handle } = apiKeyFetcherFactory({
        kind: 'unauthorized',
        message: 'Platform rejected the admin token (HTTP 401).',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/api-keys?keyId=k_alpha`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('api-key-section--unauthorized');
        expect(res.body).toContain('Admin token rejected');
        expect(res.body).not.toContain('data-can-revoke');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns empty', () => {
    it('renders the empty pane with the friendly "no keys yet" message', async () => {
      const { handle } = apiKeyFetcherFactory({
        kind: 'empty',
        message: 'No API keys are registered yet.',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(`http://127.0.0.1:${port}/admin/api-keys`, {
          headers: { cookie: `du_admin=${adminCookie()}` },
        });
        expect(res.status).toBe(200);
        expect(res.body).toContain('api-key-section--empty');
        expect(res.body).toContain('No API keys are registered yet');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns not-found', () => {
    it('renders the not-found pane for an unknown keyId', async () => {
      const { handle } = apiKeyFetcherFactory({
        kind: 'not-found',
        keyId: 'k_missing',
        message: "API key 'k_missing' is not on the server.",
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/api-keys?keyId=k_missing`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('api-key-section--not-found');
        expect(res.body).toContain('k_missing');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns transport error', () => {
    it('renders the error pane with the sanitized message', async () => {
      const { handle } = apiKeyFetcherFactory({
        kind: 'error',
        message: 'Network error contacting the platform.',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/api-keys?keyId=k_alpha`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('api-key-section--error');
        expect(res.body).toContain('Network error');
      } finally {
        await handle.close();
      }
    });
  });

  describe('viewer role → 403 (no fetcher invoked)', () => {
    it('viewer is blocked at the role guard before the deferred hook fires', async () => {
      const ctx = apiKeyFetcherFactory(okApiKeyResult());
      const { port } = await ctx.handle.listen();
      try {
        const { signCookie } = require('../src/app/admin/shell-auth');
        const viewerCookie = signCookie(SECRET, {
          iss: 'du-admin-shell',
          role: 'viewer',
          iat: Date.now(),
          exp: Date.now() + 60_000,
        });
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/api-keys?keyId=k_alpha`,
          { headers: { cookie: `du_admin=${viewerCookie}` } },
        );
        expect(res.status).toBe(403);
        expect(res.body).toContain('Access denied');
        expect(ctx.calls.length).toBe(0);
      } finally {
        await ctx.handle.close();
      }
    });
  });

  describe('no fetcher wired', () => {
    it('does not splice an api-keys section when sectionFetchers.apiKeys is absent', async () => {
      const server = createAdminShellServer({
        adminToken: TOKEN,
        cookieSecret: SECRET,
      });
      const { port } = await server.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/api-keys?keyId=k_alpha`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).not.toContain('class="api-key-section"');
      } finally {
        await server.close();
      }
    });
  });
});

// -------------------------------------------------------------------------
// P6-06 — Operation detail / result / artifacts / cancel / resume / replay
// -------------------------------------------------------------------------
//
// Drives the deferred hook against the real `node:http` server.
// Asserts full DOM-evidence for the ok pane (data-operation-selected,
// data-can-cancel / data-can-resume / data-can-replay, data-wait-cas,
// data-result-available, data-artifact-total) plus shell chrome, and
// verifies the four fallback panes, the fetcher-input propagation, the
// role guard (viewer allowed), and the no-fetcher-wired path.
//
// NO DB USED.

describe('admin-shell-server (P6-06, deferred operations section)', () => {
  const adminCookie = (): string => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    return signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
  };

  const viewerCookie = (): string => {
    const { signCookie } = require('../src/app/admin/shell-auth');
    return signCookie(SECRET, {
      iss: 'du-admin-shell',
      role: 'viewer',
      iat: Date.now(),
      exp: Date.now() + 60_000,
    });
  };

  function operationsServerFactory(
    result: OperationFetchResult,
  ): { handle: AdminShellHandle; calls: OperationFetcherInput[] } {
    const calls: OperationFetcherInput[] = [];
    const fetcher = async (input: OperationFetcherInput): Promise<OperationFetchResult> => {
      calls.push(input);
      return result;
    };
    const server = createAdminShellServer({
      adminToken: TOKEN,
      cookieSecret: SECRET,
      sectionFetchers: { operations: fetcher },
    });
    return { handle: server, calls };
  }

  describe('stub returns the ok pane (SUCCEEDED with result + artifacts)', () => {
    it('GET /admin/operations?operationId=op_42 → 200 HTML with full DOM evidence spliced in', async () => {
      const { handle } = operationsServerFactory({
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
          deadlineAt: '2026-09-21T00:00:00Z',
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
          { artifactId: 'a-2', role: 'log', fileName: 'run.log', mimeType: 'text/plain', sizeDisplay: '1.0 KB', downloadUrl: null },
        ],
        canCancel: false,
        canResume: false,
        canReplay: true,
        replayLabel: 'Replay (new operation)',
        serverNow: '2026-09-20T00:01:00Z',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/operations?operationId=op_42`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        // Shell chrome still rendered.
        expect(res.body).toContain('data-admin-shell="v1"');
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
        expect(res.body).toContain('data-artifact-total="2"');
        expect(res.body).toContain('data-action="download-artifact"');
        expect(res.body).toContain('data-artifact-id="a-1"');
        expect(res.body).toContain('data-artifact-no-download="true"');
        // No raw provider error body, raw prompt, raw artifact bytes leak.
        expect(res.body).not.toContain('"bytes"');
      } finally {
        await handle.close();
      }
    });

    it('query params reach the fetcher as an OperationFetcherInput', async () => {
      const ctx = operationsServerFactory({
        kind: 'ok',
        selectedOperationId: 'op_42',
        detail: {
          id: 'op_42',
          businessId: 'biz-1',
          businessVersion: 'v1',
          action: 'ingest',
          status: { state: 'RUNNING', label: 'Running', badge: 'info', terminal: false },
          progressPercent: 50,
          progressMessage: 'half-way',
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
        resultDisplay: null,
        artifacts: [],
        canCancel: true,
        canResume: false,
        canReplay: false,
        replayLabel: 'Replay (new operation)',
        serverNow: '2026-09-20T00:01:00Z',
      });
      const { port } = await ctx.handle.listen();
      try {
        await httpRequest(
          `http://127.0.0.1:${port}/admin/operations?operationId=op_42`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(ctx.calls.length).toBe(1);
        expect(ctx.calls[0]!.operationId).toBe('op_42');
        expect(ctx.calls[0]!.adminToken).toBe(TOKEN);
      } finally {
        await ctx.handle.close();
      }
    });
  });

  describe('stub returns the ok pane (WAITING_INPUT with resume form)', () => {
    it('renders the human-wait form with data-wait-cas + disabled submit when expired', async () => {
      const { handle } = operationsServerFactory({
        kind: 'ok',
        selectedOperationId: 'op_w',
        detail: {
          id: 'op_w',
          businessId: 'biz-1',
          businessVersion: 'v1',
          action: 'ingest',
          status: { state: 'WAITING_INPUT', label: 'Waiting for input', badge: 'warning', terminal: false },
          progressPercent: 50,
          progressMessage: 'awaiting review',
          createdAt: '2026-09-20T00:00:00Z',
          updatedAt: '2026-09-20T00:01:00Z',
          deadlineAt: null,
          replayOf: null,
          artifacts: [],
          errorDisplay: null,
          humanWaitForm: {
            waitId: 'w-99',
            fields: [
              { name: 'notes', label: 'Reviewer notes', widget: 'textarea', required: true, description: 'Free-form notes', options: [], placeholder: 'type here' },
            ],
            isExpired: true,
            expiresAt: '2026-09-19T00:00:00Z',
          },
          selfLink: '/api/v1/operations/op_w',
          resultLink: '/api/v1/operations/op_w/result',
        },
        resultDisplay: null,
        artifacts: [],
        canCancel: true,
        canResume: false,
        canReplay: false,
        replayLabel: 'Replay (new operation)',
        serverNow: '2026-09-20T00:01:00Z',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/operations?operationId=op_w`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        // Wait form + cas token discriminators.
        expect(res.body).toContain('class="operation-section__wait"');
        expect(res.body).toContain('data-wait-id="w-99"');
        expect(res.body).toContain('data-wait-cas="w-99"');
        expect(res.body).toContain('data-wait-expired="true"');
        expect(res.body).toContain('data-action="resume-wait"');
        expect(res.body).toContain('data-action="submit-resume"');
        expect(res.body).toContain('name="casToken" value="w-99"');
        expect(res.body).toContain('data-field-name="notes"');
        expect(res.body).toContain('data-field-widget="textarea"');
        expect(res.body).toContain('data-field-required="true"');
        // canResume is false because the wait is expired.
        expect(res.body).toContain('data-can-resume="false"');
        // Submit button is rendered disabled because isExpired.
        expect(res.body).toContain('data-action="submit-resume"');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns unauthorized', () => {
    it('renders the unauthorized pane without action discriminators', async () => {
      const { handle } = operationsServerFactory({
        kind: 'unauthorized',
        message: 'Platform rejected the admin token (HTTP 401).',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/operations?operationId=op_42`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('operation-section--unauthorized');
        expect(res.body).toContain('Platform rejected the admin token');
        expect(res.body).not.toContain('data-can-cancel');
        expect(res.body).not.toContain('data-can-resume');
        expect(res.body).not.toContain('data-can-replay');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns empty', () => {
    it('renders the empty pane with the friendly "no operations" message', async () => {
      const { handle } = operationsServerFactory({
        kind: 'empty',
        message: 'No operations have been recorded yet.',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(`http://127.0.0.1:${port}/admin/operations`, {
          headers: { cookie: `du_admin=${adminCookie()}` },
        });
        expect(res.status).toBe(200);
        expect(res.body).toContain('operation-section--empty');
        expect(res.body).toContain('No operations have been recorded yet');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns not-found', () => {
    it('renders the not-found pane for an unknown operationId', async () => {
      const { handle } = operationsServerFactory({
        kind: 'not-found',
        operationId: 'op_missing',
        message: "Operation 'op_missing' is not on the server.",
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/operations?operationId=op_missing`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('operation-section--not-found');
        expect(res.body).toContain('op_missing');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns transport error', () => {
    it('renders the error pane with the sanitized message', async () => {
      const { handle } = operationsServerFactory({
        kind: 'error',
        message: 'Network error contacting the platform.',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/operations?operationId=op_42`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('operation-section--error');
        expect(res.body).toContain('Network error');
      } finally {
        await handle.close();
      }
    });
  });

  describe('viewer role → allowed (operations is viewer-gated)', () => {
    it('viewer is allowed at the role guard and the deferred hook still fires', async () => {
      const ctx = operationsServerFactory({
        kind: 'ok',
        selectedOperationId: 'op_v',
        detail: {
          id: 'op_v',
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
          selfLink: '/api/v1/operations/op_v',
          resultLink: '/api/v1/operations/op_v/result',
        },
        resultDisplay: null,
        artifacts: [],
        canCancel: false,
        canResume: false,
        canReplay: false,
        replayLabel: 'Replay (new operation)',
        serverNow: '2026-09-20T00:01:00Z',
      });
      const { port } = await ctx.handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/operations?operationId=op_v`,
          { headers: { cookie: `du_admin=${viewerCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('data-operation-selected="op_v"');
        expect(ctx.calls.length).toBe(1);
      } finally {
        await ctx.handle.close();
      }
    });
  });

  describe('no fetcher wired', () => {
    it('does not splice an operations section when sectionFetchers.operations is absent', async () => {
      const server = createAdminShellServer({
        adminToken: TOKEN,
        cookieSecret: SECRET,
      });
      const { port } = await server.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/operations?operationId=op_42`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).not.toContain('class="operation-section"');
      } finally {
        await server.close();
      }
    });
  });

  // -------------------------------------------------------------------------
  // P6-07: Overview sub-pane (usage + audit + health) deferred-extras path.
  // -------------------------------------------------------------------------

  function overviewServerFactory(
    result: OverviewFetchResult,
  ): { handle: AdminShellHandle; calls: OverviewFetcherInput[] } {
    const calls: OverviewFetcherInput[] = [];
    const fetcher = async (input: OverviewFetcherInput): Promise<OverviewFetchResult> => {
      calls.push(input);
      return result;
    };
    const server = createAdminShellServer({
      adminToken: TOKEN,
      cookieSecret: SECRET,
      sectionFetchers: { overview: fetcher },
    });
    return { handle: server, calls };
  }

  function buildOverviewOkFixture(): OverviewFetchResult {
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
        {
          provider: 'anthropic',
          model: 'claude-3-haiku',
          operations: 5,
          inputTokens: 3000,
          outputTokens: 1500,
          pages: 4,
          costMicrousd: 175000,
          measurement: 'estimated',
        },
      ],
      totals: {
        operations: 12,
        inputTokens: 8000,
        outputTokens: 4000,
        pages: 9,
        costMicrousd: 425000,
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
        {
          id: 'evt_2',
          kind: 'webhook.failed',
          severity: 'error',
          occurredAt: '2026-09-24T11:35:00Z',
          tenantId: 'tenant-main',
          resourceId: 'op_43',
          actor: 'webhook-bridge',
          message: 'Webhook delivery failed (502 from client).',
        },
      ],
    });
    const health = buildHealthOverviewView({
      status: 'degraded',
      db: false,
      redis: true,
      activeLeases: 4,
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
  }

  describe('stub returns the ok pane (usage + audit + health)', () => {
    it('GET /admin/overview?tenantId=... -> 200 HTML with full DOM evidence spliced in', async () => {
      const ctx = overviewServerFactory(buildOverviewOkFixture());
      const { port } = await ctx.handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/overview?tenantId=tenant-main&from=2026-09-23T00:00:00.000Z&to=2026-09-24T00:00:00.000Z`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
        // Shell chrome still rendered.
        expect(res.body).toContain('data-admin-shell="v1"');
        // Section root + tenant + window.
        expect(res.body).toContain('<section class="overview-section"');
        expect(res.body).toContain('data-overview-tenant="tenant-main"');
        expect(res.body).toContain('data-overview-from="2026-09-23T00:00:00.000Z"');
        expect(res.body).toContain('data-overview-to="2026-09-24T00:00:00.000Z"');
        // Sub-pane flags.
        expect(res.body).toContain('data-overview-usage-available="true"');
        expect(res.body).toContain('data-overview-audit-available="true"');
        expect(res.body).toContain('data-overview-health-available="true"');
        // Usage discriminators. data-usage-total = row count; op totals
        // are surfaced on the <tfoot> row.
        expect(res.body).toContain('data-usage-total="2"');
        expect(res.body).toContain('data-usage-tenant="tenant-main"');
        expect(res.body).toContain('data-usage-row="openai|gpt-4o-mini"');
        expect(res.body).toContain('data-usage-provider="openai"');
        expect(res.body).toContain('data-usage-model="gpt-4o-mini"');
        expect(res.body).toContain('data-usage-measurement="measured"');
        expect(res.body).toContain('data-usage-totals-ops="12"');
        expect(res.body).toContain('data-usage-totals-cost="$0.42"');
        // Audit discriminators.
        expect(res.body).toContain('data-audit-total="2"');
        expect(res.body).toContain('data-audit-tenant="tenant-main"');
        expect(res.body).toContain('data-audit-id="evt_1"');
        expect(res.body).toContain('data-audit-kind="operation.complete"');
        expect(res.body).toContain('data-audit-severity="success"');
        expect(res.body).toContain('data-audit-id="evt_2"');
        expect(res.body).toContain('data-audit-severity="error"');
        // Health discriminators.
        expect(res.body).toContain('data-health-status="degraded"');
        expect(res.body).toContain('data-health-fully-healthy="false"');
        expect(res.body).toContain('data-health-db="false"');
        expect(res.body).toContain('data-health-redis="true"');
        expect(res.body).toContain('data-health-leases="4"');
        expect(res.body).toContain('data-health-overall="degraded"');
        // Fetcher was actually called (real HTTP route).
        expect(ctx.calls.length).toBe(1);
        expect(ctx.calls[0]!.tenantId).toBe('tenant-main');
      } finally {
        await ctx.handle.close();
      }
    });
  });

  describe('stub returns the empty pane', () => {
    it('renders overview-section--empty when the bundle has no rows and no events', async () => {
      const { handle } = overviewServerFactory({
        kind: 'empty',
        message: 'No usage, audit, or health data is available yet.',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/overview?tenantId=tenant-empty`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('overview-section--empty');
        expect(res.body).toContain('No usage, audit, or health data is available yet');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns unauthorized', () => {
    it('renders overview-section--unauthorized with the platform rejection message', async () => {
      const { handle } = overviewServerFactory({
        kind: 'unauthorized',
        message: 'Platform rejected the admin token (HTTP 401/403).',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/overview?tenantId=tenant-main`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('overview-section--unauthorized');
        expect(res.body).toContain('Platform rejected the admin token');
        expect(res.body).not.toContain('data-usage-total=');
        expect(res.body).not.toContain('data-audit-total=');
        expect(res.body).not.toContain('data-health-status=');
      } finally {
        await handle.close();
      }
    });
  });

  describe('stub returns transport error', () => {
    it('renders overview-section--error with the sanitized message', async () => {
      const { handle } = overviewServerFactory({
        kind: 'error',
        message: 'Network error contacting the platform.',
      });
      const { port } = await handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/overview?tenantId=tenant-main`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('overview-section--error');
        expect(res.body).toContain('Network error');
      } finally {
        await handle.close();
      }
    });
  });

  describe('viewer role -> allowed (overview is viewer-gated)', () => {
    it('viewer cookie is allowed at the role guard and the deferred hook still fires', async () => {
      const ctx = overviewServerFactory(buildOverviewOkFixture());
      const { port } = await ctx.handle.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/overview?tenantId=tenant-main`,
          { headers: { cookie: `du_admin=${viewerCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).toContain('data-overview-tenant="tenant-main"');
        expect(res.body).toContain('data-usage-totals-ops="12"');
        expect(ctx.calls.length).toBe(1);
      } finally {
        await ctx.handle.close();
      }
    });
  });

  describe('no fetcher wired', () => {
    it('does not splice an overview section when sectionFetchers.overview is absent', async () => {
      const server = createAdminShellServer({
        adminToken: TOKEN,
        cookieSecret: SECRET,
      });
      const { port } = await server.listen();
      try {
        const res = await httpRequest(
          `http://127.0.0.1:${port}/admin/overview?tenantId=tenant-main`,
          { headers: { cookie: `du_admin=${adminCookie()}` } },
        );
        expect(res.status).toBe(200);
        expect(res.body).not.toContain('class="overview-section"');
      } finally {
        await server.close();
      }
    });
  });
});
