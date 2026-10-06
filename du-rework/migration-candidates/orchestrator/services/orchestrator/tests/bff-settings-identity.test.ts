/**
 * BFF-SETTINGS-IDENTITY — settings + identity routes (focused, OFFLINE).
 *
 * Covers the five areas the packet requires:
 *   1. DTO validation      — settings/identity schemas accept a real view and
 *                            reject a leaked secret field
 *   2. secrets never leak  — no credential value crosses the wire
 *   3. cap gate 401/403    — anonymous + unscoped refused, upstream untouched
 *   4. disabled writer     — POST /settings refuses at the capability gate and
 *                            makes NO upstream call (no invented storage)
 *   5. CAS 409             — a stale expectedVersion is relayed as 409
 *
 * No DB / Redis / S3 is used: the upstream is an in-process stub and the BFF
 * boots a real `createAdminShellServer` on a loopback port.
 */
import http from 'node:http';
import {
  IdentitySnapshotSchema,
  IdentityUserSchema,
  SettingsReadSchema,
  SettingsUpdateParamsSchema,
  SettingsStorageSchema,
  SETTINGS_WRITER_DISABLED_CODE,
} from '@du/contracts';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import { matchIdentityRoute } from '../src/app/admin/bff/identity';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'bff-settings-identity-cookie-secret';
const ADMIN_TOKEN = 'bff-settings-identity-platform-admin-token';
const TENANT_A_TOKEN = 'bff-settings-identity-tenant-a-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OPERATOR_SESSION = 'O'.repeat(43);
const VIEWER_SESSION = 'V'.repeat(43);
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

/** A credential value that must NEVER appear on the wire in any test. */
const SECRET_VALUE = 'sk-live-must-never-cross-the-boundary';

const PORT_BASE = 48_500 + (process.pid % 9) * 31;
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
  /** Upstream mode: honest 503 / hard 5xx / stale-CAS 409 / normal. */
  mode: 'ok' | 'unavailable' | 'server-error' | 'version-conflict' | 'garbage';
  close(): Promise<void>;
}

const SETTINGS_VIEW = {
  ai: { provider: 'openai', model: 'gpt-4o-mini', baseUrl: 'https://api.openai.com/v1' },
  promptDefaults: { image: 'image-default', pdf: 'pdf-default', docx: 'docx-default', compare: 'c', generate: 'g' },
  storage: {
    backend: 's3' as const,
    endpoint: 'https://s3.example',
    bucket: 'du-artifacts',
    region: 'ap-southeast-1',
    secretPresent: true,
    ttlSeconds: 900,
  },
  cacheRetention: { dedupEnabled: true, retentionDays: 7, cleanupIntervalSeconds: 3600 },
  capabilities: { readerEnabled: true, writerEnabled: false },
};

const IDENTITY_SNAPSHOT = {
  users: [
    {
      id: 'u-1',
      username: 'operator-one',
      role: 'ADMIN' as const,
      enabled: true,
      locked: false,
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      version: 7,
    },
  ],
  capabilities: { userWriter: true },
  auth: { mode: 'both' as const, localEnabled: true, oidc: null },
};

function startStub(port: number): Promise<Stub> {
  const requests: Captured[] = [];
  const stub: Stub = {
    url: `http://127.0.0.1:${port}`,
    requests,
    mode: 'ok',
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
      if (stub.mode === 'server-error') {
        // A hard 5xx must collapse to 502 UPSTREAM_ERROR — never leak the body.
        res.statusCode = 500;
        res.end(JSON.stringify({ code: 'INTERNAL', detail: `stack ${SECRET_VALUE}` }));
        return;
      }
      if (stub.mode === 'unavailable') {
        res.statusCode = 503;
        res.end(JSON.stringify({ code: 'TEMPORARY_UNAVAILABLE' }));
        return;
      }
      if (url.pathname === '/api/v1/admin/settings') {
        if (stub.mode === 'garbage') {
          // Well-formed JSON that does NOT match the settings DTO.
          res.statusCode = 200;
          res.end(JSON.stringify({ ...SETTINGS_VIEW, storage: 'not-an-object' }));
          return;
        }
        res.statusCode = 200;
        // Upstream is honest here: presence bit only, never a value.
        res.end(JSON.stringify({ ...SETTINGS_VIEW, storage: { ...SETTINGS_VIEW.storage, secretValue: SECRET_VALUE } }));
        return;
      }
      if (url.pathname === '/api/v1/admin/identity' || url.pathname === '/api/v1/admin/identity/users') {
        if (stub.mode === 'version-conflict') {
          res.statusCode = 409;
          res.end(JSON.stringify({ code: 'IDENTITY_VERSION_CONFLICT' }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify(IDENTITY_SNAPSHOT));
        return;
      }
      if (url.pathname.startsWith('/api/v1/admin/identity/users/')) {
        if (stub.mode === 'version-conflict') {
          res.statusCode = 409;
          res.end(JSON.stringify({ code: 'IDENTITY_VERSION_CONFLICT' }));
          return;
        }
        res.statusCode = 200;
        res.end(JSON.stringify(IDENTITY_SNAPSHOT.users[0]));
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

describe('BFF-SETTINGS-IDENTITY — DTO validation', () => {
  it('accepts a real settings read view', () => {
    const parsed = SettingsReadSchema.safeParse(SETTINGS_VIEW);
    expect(parsed.success).toBe(true);
  });

  it('drops a secret VALUE rather than surfacing it (presence bit is the wire contract)', () => {
    const withSecret = SettingsStorageSchema.safeParse({ ...SETTINGS_VIEW.storage, secretValue: SECRET_VALUE });
    expect(withSecret.success).toBe(true);
    expect(withSecret.success === true && 'secretValue' in withSecret.data).toBe(false);
    // The honest shape — a presence bit — is accepted unchanged.
    expect(SettingsStorageSchema.safeParse(SETTINGS_VIEW.storage).success).toBe(true);
  });

  it('strips an unmodelled field rather than republishing it', () => {
    const top = SettingsReadSchema.safeParse({ ...SETTINGS_VIEW, surprise: 'x' });
    expect(top.success).toBe(true);
    expect(top.success === true && 'surprise' in top.data).toBe(false);
    const nested = SettingsReadSchema.safeParse({
      ...SETTINGS_VIEW,
      storage: { ...SETTINGS_VIEW.storage, extra: 1 },
    });
    expect(nested.success).toBe(true);
    expect(nested.success === true && 'extra' in nested.data.storage).toBe(false);
    // A MISSING prompt slot is still a hard error — we drop unknown keys, we do
    // not invent required ones.
    const missingSlot = { ...SETTINGS_VIEW, promptDefaults: { ...SETTINGS_VIEW.promptDefaults, compare: undefined } };
    expect(SettingsReadSchema.safeParse(missingSlot).success).toBe(false);
  });

  it('rejects a malformed read view (wrong backend, non-positive ttl)', () => {
    expect(SettingsReadSchema.safeParse({ ...SETTINGS_VIEW, storage: { ...SETTINGS_VIEW.storage, backend: 'ftp' } }).success).toBe(false);
    expect(SettingsReadSchema.safeParse({ ...SETTINGS_VIEW, storage: { ...SETTINGS_VIEW.storage, ttlSeconds: 0 } }).success).toBe(false);
  });

  it('writer contract accepts a value-free update and a write-only secret', () => {
    expect(SettingsUpdateParamsSchema.safeParse({ ai: { model: 'gpt-4o' } }).success).toBe(true);
    expect(
      SettingsUpdateParamsSchema.safeParse({ storage: { bucket: 'new-bucket', secretValue: SECRET_VALUE } }).success,
    ).toBe(true);
    // `secretPresent` is read-only: a client may not assert it.
    expect(SettingsUpdateParamsSchema.safeParse({ storage: { secretPresent: true } }).success).toBe(false);
  });

  it('accepts a real identity snapshot and rejects a credential-bearing user', () => {
    expect(IdentitySnapshotSchema.safeParse(IDENTITY_SNAPSHOT).success).toBe(true);
    expect(IdentityUserSchema.safeParse({ ...IDENTITY_SNAPSHOT.users[0], passwordHash: 'x' }).success).toBe(false);
  });
});

describe('BFF-SETTINGS-IDENTITY — routes', () => {
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
    stub.mode = 'ok';
  });

  const last = (): Captured | undefined => stub.requests[stub.requests.length - 1];

  // ---- capability gate 401/403 -----------------------------------------
  it('settings: anonymous → 401, unscoped viewer → 403, upstream untouched', async () => {
    const anon = await httpRequest(`${baseUrl}/admin/api/settings`);
    expect(anon.status).toBe(401);
    const viewer = await httpRequest(`${baseUrl}/admin/api/settings`, {
      headers: { cookie: `du_session=${VIEWER_SESSION}` },
    });
    expect(viewer.status).toBe(403);
    expect(stub.requests).toHaveLength(0);
  });

  it('identity: anonymous → 401, unscoped viewer → 403, upstream untouched', async () => {
    const anon = await httpRequest(`${baseUrl}/admin/api/identity`);
    expect(anon.status).toBe(401);
    const viewer = await httpRequest(`${baseUrl}/admin/api/identity`, {
      headers: { cookie: `du_session=${VIEWER_SESSION}` },
    });
    expect(viewer.status).toBe(403);
    expect(stub.requests).toHaveLength(0);
  });

  it('settings: wrong method → 405, no upstream call', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/settings`, {
      method: 'DELETE',
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(405);
    expect(stub.requests).toHaveLength(0);
  });

  // ---- tenant fence -----------------------------------------------------
  it('settings: operator forced to its own tenant; foreign tenant → 403 untouched', async () => {
    const foreign = await httpRequest(`${baseUrl}/admin/api/settings?tenantId=${TENANT_B}`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    expect(foreign.status).toBe(403);
    expect(stub.requests).toHaveLength(0);

    const own = await httpRequest(`${baseUrl}/admin/api/settings`, {
      headers: { cookie: `du_session=${OPERATOR_SESSION}` },
    });
    expect(own.status).toBe(200);
    expect(last()?.auth).toBe(`Bearer ${TENANT_A_TOKEN}`);
    expect(last()?.path).toContain(`tenantId=${TENANT_A}`);
  });

  // ---- read + secret never leaks ----------------------------------------
  it('settings GET: narrows through the strict DTO — a secret VALUE upstream is dropped, never relayed', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/settings?tenantId=${TENANT_A}`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(200);
    expect(last()?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(res.headers['cache-control']).toBe('no-store');
    // The stub deliberately injects `secretValue` into storage. The BFF must
    // narrow it away — this is the load-bearing security assertion.
    expect(res.body).not.toContain(SECRET_VALUE);
    expect(res.body).not.toContain('secretValue');
    const view = SettingsReadSchema.safeParse(JSON.parse(res.body));
    expect(view.success).toBe(true);
    expect(view.success === true && view.data.storage.secretPresent).toBe(true);
  });

  it('settings GET: an upstream body that does not match the DTO → 502, never a half-trusted echo', async () => {
    stub.mode = 'garbage';
    const res = await httpRequest(`${baseUrl}/admin/api/settings`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(502);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('UPSTREAM_ERROR');
    expect(res.body).not.toContain(SECRET_VALUE);
  });

  it('settings GET: 5xx collapses to 502 UPSTREAM_ERROR and never echoes the upstream body', async () => {
    stub.mode = 'server-error';
    const res = await httpRequest(`${baseUrl}/admin/api/settings`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(502);
    const problem = JSON.parse(res.body) as { code: string; title: string };
    expect(problem.code).toBe('UPSTREAM_ERROR');
    expect(res.body).not.toContain(SECRET_VALUE);
    expect(res.body).not.toContain('stack');
  });

  // ---- disabled writer ---------------------------------------------------
  it('settings POST without CSRF → 403 CSRF_REJECTED, upstream untouched', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/settings`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ ai: { model: 'gpt-4o' } }),
    });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('CSRF_REJECTED');
    expect(stub.requests).toHaveLength(0);
  });

  it('settings POST with CSRF but operator role → 403 ADMIN_CREDENTIAL_REQUIRED, upstream untouched', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/settings`, {
      method: 'POST',
      headers: { cookie: `du_session=${OPERATOR_SESSION}`, 'content-type': 'application/json', 'x-csrf-token': 'C'.repeat(43) },
      body: JSON.stringify({ ai: { model: 'gpt-4o' } }),
    });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('ADMIN_CREDENTIAL_REQUIRED');
    expect(stub.requests).toHaveLength(0);
  });

  it('settings POST as admin+CSRF → 503 SETTINGS_WRITER_DISABLED and NO upstream call (no invented storage)', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/settings`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ ai: { model: 'gpt-4o' } }),
    });
    expect(res.status).toBe(503);
    const problem = JSON.parse(res.body) as { code: string; title: string };
    expect(problem.code).toBe(SETTINGS_WRITER_DISABLED_CODE);
    // The reason must be explicit so the UI can render a disabled-with-reason.
    expect(problem.title).toContain('deployment adapter');
    // The critical assertion: we never even attempt a write upstream.
    expect(stub.requests).toHaveLength(0);
  });

  // ---- identity read + CAS -----------------------------------------------
  it('identity GET: relays the snapshot, no-store, admin bearer', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/identity`, { headers: { cookie: adminCookie } });
    expect(res.status).toBe(200);
    expect(IdentitySnapshotSchema.safeParse(JSON.parse(res.body)).success).toBe(true);
    expect(last()?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('identity POST create: forwards username/password/role, rejects a bad role', async () => {
    const ok = await httpRequest(`${baseUrl}/admin/api/identity/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ username: 'new-user', password: SECRET_VALUE, role: 'VIEWER' }),
    });
    expect(ok.status).toBe(200);
    expect(last()?.method).toBe('POST');
    expect(last()?.path).toBe('/api/v1/admin/identity/users');
    const forwarded = JSON.parse(last()?.body ?? '{}') as Record<string, unknown>;
    expect(forwarded).toEqual({ username: 'new-user', password: SECRET_VALUE, role: 'VIEWER' });

    stub.requests.length = 0;
    const bad = await httpRequest(`${baseUrl}/admin/api/identity/users`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ username: 'new-user', password: 'x', role: 'SUPERUSER' }),
    });
    expect(bad.status).toBe(422);
    expect((JSON.parse(bad.body) as { code: string }).code).toBe('INVALID_SCHEMA');
    expect(stub.requests).toHaveLength(0);
  });

  it('identity PATCH without expectedVersion → 422, no blind write', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/identity/users/u-1`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ role: 'USER', enabled: true }),
    });
    expect(res.status).toBe(422);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('INVALID_SCHEMA');
    expect(stub.requests).toHaveLength(0);
  });

  it('identity PATCH with expectedVersion → forwarded; stale version relays 409', async () => {
    const ok = await httpRequest(`${baseUrl}/admin/api/identity/users/u-1`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ role: 'USER', enabled: false, expectedVersion: 7 }),
    });
    expect(ok.status).toBe(200);
    expect(last()?.path).toBe('/api/v1/admin/identity/users/u-1');
    expect(JSON.parse(last()?.body ?? '{}')).toEqual({ role: 'USER', enabled: false, expectedVersion: 7 });

    stub.mode = 'version-conflict';
    const stale = await httpRequest(`${baseUrl}/admin/api/identity/users/u-1`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken },
      body: JSON.stringify({ role: 'USER', enabled: false, expectedVersion: 1 }),
    });
    expect(stale.status).toBe(409);
    expect((JSON.parse(stale.body) as { code: string }).code).toBe('IDENTITY_VERSION_CONFLICT');
  });

  it('identity mutation without CSRF → 403, upstream untouched', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/identity/users/u-1`, {
      method: 'PATCH',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify({ role: 'USER', enabled: true, expectedVersion: 7 }),
    });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { code: string }).code).toBe('CSRF_REJECTED');
    expect(stub.requests).toHaveLength(0);
  });

  it('identity: an over-long user id is refused at the fence, never normalized onto another route', async () => {
    const res = await httpRequest(`${baseUrl}/admin/api/identity/users/${'x'.repeat(200)}`, {
      headers: { cookie: adminCookie },
    });
    expect(res.status).toBe(404);
    expect(stub.requests).toHaveLength(0);
  });
});

describe('BFF-SETTINGS-IDENTITY — route matching fence (unit)', () => {
  // These are asserted directly on the matcher because the WHATWG URL parser
  // normalizes dot segments in `pathname` BEFORE a request can be sent, so an
  // HTTP-level test could never reach this branch. The fence still matters: a
  // non-normalizing caller (or a future proxy) must not shift the request onto
  // a different route.
  it('rejects dot segments and embedded slashes in the user id', () => {
    expect(matchIdentityRoute('/identity/users/..')).toEqual({ kind: 'invalid' });
    expect(matchIdentityRoute('/identity/users/.')).toEqual({ kind: 'invalid' });
    expect(matchIdentityRoute(`/identity/users/${encodeURIComponent('a/b')}`)).toEqual({ kind: 'invalid' });
    expect(matchIdentityRoute(`/identity/users/${'x'.repeat(200)}`)).toEqual({ kind: 'invalid' });
  });

  it('accepts an ordinary user id and does not shift the route', () => {
    expect(matchIdentityRoute('/identity/users/u-1')).toEqual({ kind: 'user', userId: 'u-1' });
    expect(matchIdentityRoute('/identity')).toEqual({ kind: 'snapshot' });
    expect(matchIdentityRoute('/identity/users')).toEqual({ kind: 'users' });
    expect(matchIdentityRoute('/identity/users/u-1/extra')).toBeNull();
  });
});
