/**
 * PC-08 â€” Admin workbench V2 bridge (offline loopback).
 *
 * The browser must not reach `/api/internal/admin-workbench/v2/*` directly, and
 * the bridge must not weaken any v1 gate:
 *  - preview resolves configuration only, so it is the one action WITHOUT an
 *    Idempotency-Key requirement;
 *  - submit requires the header and is the only mutation;
 *  - a local USER operator forwards the opaque session proof (cookie + CSRF)
 *    and NO bearer, exactly like the v1 suffixes;
 *  - a tenant principal can never reach another tenant (404, no upstream call);
 *  - a stale fingerprint (`409 PROFILE_CHANGED`) is relayed by code.
 */
import http from 'node:http';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import { matchAdminWorkbenchRoute } from '../src/app/admin/bff/admin-workbench';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';

const SECRET = 'aweb10-workbench-cookie-secret';
const ADMIN_TOKEN = 'aweb10-workbench-admin-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_A_TOKEN = 'aweb10-workbench-tenant-a-token';
const KEY = '55555555-5555-4555-8555-555555555555';
const LOCAL_USER = '66666666-6666-4666-8666-666666666666';
const VIEWER_SESSION = 'V'.repeat(43);
const TENANT_SESSION = 'T'.repeat(43);
const LOCAL_SESSION = 'L'.repeat(43);
const FINGERPRINT = `sha256:${'a'.repeat(64)}`;
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

const PORT_BASE = 49_000 + (process.pid % 19) * 11;
let portCursor = 0;
const nextPort = (): number => PORT_BASE + portCursor++;

interface Response { status: number; headers: http.IncomingHttpHeaders; body: string }

function httpRequest(url: string, opts: { method?: string; headers?: Record<string, string>; body?: string } = {}): Promise<Response> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request({
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: opts.method ?? 'GET',
      headers: opts.headers ?? {},
      agent: false,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    if (opts.body !== undefined) req.write(opts.body);
    req.end();
  });
}

interface Captured {
  path: string;
  auth: string | null;
  cookie: string | null;
  csrf: string | null;
  idempotencyKey: string | null;
  body: string;
}

interface Stub { url: string; requests: Captured[]; close(): Promise<void> }

function startStub(port: number): Promise<Stub> {
  const requests: Captured[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({
        path: url.pathname,
        auth: typeof req.headers['authorization'] === 'string' ? req.headers['authorization'] : null,
        cookie: typeof req.headers['cookie'] === 'string' ? req.headers['cookie'] : null,
        csrf: typeof req.headers['x-csrf-token'] === 'string' ? req.headers['x-csrf-token'] : null,
        idempotencyKey: typeof req.headers['idempotency-key'] === 'string' ? req.headers['idempotency-key'] : null,
        body,
      });
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/api/internal/admin-workbench/v2/preview') {
        res.statusCode = 200;
        res.end(JSON.stringify({
          refs: {
            groupId: '33333333-3333-4333-8333-333333333333',
            groupRevision: 4,
            accessVersion: 7,
            businessId: 'document-core',
            businessVersion: '1.0.0',
            manifestDigest: `sha256:${'b'.repeat(64)}`,
            kind: 'endpoint',
            functionId: 'extract.invoice',
            action: 'extract',
            endpointSlug: 'extract.invoice',
            childProfileId: '44444444-4444-4444-8444-444444444444',
            childRevision: 2,
            tenantDefaultsRevision: null,
            connectorBindings: [],
          },
          resolutionFingerprint: FINGERPRINT,
          effective: { parameters: { documentType: 'invoice' }, appliedRequestDefaults: [], appliedSchemaDefaults: [], lockedParameters: [] },
          apiKeyId: KEY,
        }));
        return;
      }
      if (url.pathname === '/api/internal/admin-workbench/v2/submit') {
        if (body.includes('"b'.padEnd(0))) { /* noop */ }
        const payload = JSON.parse(body || '{}') as { resolutionFingerprint?: string };
        if (payload.resolutionFingerprint !== FINGERPRINT) {
          res.statusCode = 409;
          res.end(JSON.stringify({ code: 'PROFILE_CHANGED' }));
          return;
        }
        res.statusCode = 202;
        res.end(JSON.stringify({
          operationId: '77777777-7777-4777-8777-777777777777',
          operation: { id: '77777777-7777-4777-8777-777777777777', state: 'ACCEPTED' },
          replayed: false,
        }));
        return;
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ code: 'NOT_FOUND' }));
    });
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      resolve({ url: `http://127.0.0.1:${port}`, requests, close: () => new Promise<void>((res2, rej2) => server.close((err) => (err ? rej2(err) : res2()))) });
    });
  });
}

class MapSessionStore implements AdminSessionStore {
  private readonly records = new Map<string, AdminSessionView>();
  add(sessionId: string, view: AdminSessionView): void { this.records.set(sessionId, view); }
  async get(sessionId: string): Promise<AdminSessionView | null> { return this.records.get(sessionId) ?? null; }
}

function legacyAdminCookie(): string {
  const nowMs = Date.now();
  const value = signCookie(SECRET, { iss: 'du-admin-shell', role: 'admin', iat: nowMs, exp: nowMs + 3_600_000 });
  if (!value) throw new Error('signCookie returned undefined');
  return `du_admin=${value}`;
}

function previewBody(tenantId: string): Record<string, unknown> {
  return {
    tenantId,
    apiKeyId: KEY,
    businessId: 'document-core',
    businessVersion: '1.0.0',
    action: 'extract',
    functionId: 'extract.invoice',
    submission: { input: { documentType: 'invoice' } },
  };
}

describe('PC-08 workbench V2 matcher', () => {
  it('maps the two V2 suffixes without disturbing the v1 pair', () => {
    expect(matchAdminWorkbenchRoute('/admin-workbench/v2/preview')).toMatchObject({ kind: 'preview-v2' });
    expect(matchAdminWorkbenchRoute('/admin-workbench/v2/submit')).toMatchObject({ kind: 'submit-v2' });
    expect(matchAdminWorkbenchRoute('/admin-workbench/test-endpoint')).toMatchObject({ kind: 'test-endpoint' });
    expect(matchAdminWorkbenchRoute('/admin-workbench/v2/previews')).toBeNull();
  });
});

describe('PC-08 workbench V2 BFF', () => {
  let stub: Stub;
  let store: MapSessionStore;
  let handle: AdminShellHandle;
  let baseUrl: string;
  let adminCookie: string;
  let csrfToken: string;

  const PREVIEW = '/admin/api/admin-workbench/v2/preview';
  const SUBMIT = '/admin/api/admin-workbench/v2/submit';

  beforeAll(async () => {
    stub = await startStub(nextPort());
    store = new MapSessionStore();
    store.add(VIEWER_SESSION, { role: 'viewer', tenantId: null, csrfToken: 'v'.repeat(43) });
    store.add(TENANT_SESSION, { role: 'operator', tenantId: TENANT_A, csrfToken: 't'.repeat(43), issuer: 'corp-idp' });
    store.add(LOCAL_SESSION, {
      role: 'operator', tenantId: TENANT_A, csrfToken: 'l'.repeat(43), issuer: 'du-local', sub: LOCAL_USER, roleVersion: 2,
    });
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
    adminCookie = legacyAdminCookie();
    const session = await httpRequest(`${baseUrl}/admin/api/session`, { headers: { cookie: adminCookie } });
    csrfToken = (JSON.parse(session.body) as { csrfToken: string }).csrfToken;
  });

  afterAll(async () => {
    await handle.close();
    await stub.close();
  });

  beforeEach(() => { stub.requests.length = 0; });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    httpRequest(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json', 'x-csrf-token': csrfToken, ...headers },
      body: JSON.stringify(body),
    });

  it('preview needs no Idempotency-Key and forwards the platform bearer', async () => {
    const res = await post(PREVIEW, previewBody(TENANT_A));
    expect(res.status).toBe(200);
    expect(stub.requests[0]?.path).toBe('/api/internal/admin-workbench/v2/preview');
    expect(stub.requests[0]?.auth).toBe(`Bearer ${ADMIN_TOKEN}`);
    expect(stub.requests[0]?.idempotencyKey).toBeNull();
    expect((JSON.parse(res.body) as { resolutionFingerprint: string }).resolutionFingerprint).toBe(FINGERPRINT);
  });

  it('preview without CSRF is refused before the upstream', async () => {
    const res = await httpRequest(`${baseUrl}${PREVIEW}`, {
      method: 'POST',
      headers: { cookie: adminCookie, 'content-type': 'application/json' },
      body: JSON.stringify(previewBody(TENANT_A)),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('CSRF_REJECTED');
    expect(stub.requests).toHaveLength(0);
  });

  it('a viewer cannot reach the workbench', async () => {
    const res = await httpRequest(`${baseUrl}${PREVIEW}`, {
      method: 'POST',
      headers: { cookie: `du_session=${VIEWER_SESSION}`, 'content-type': 'application/json', 'x-csrf-token': 'v'.repeat(43) },
      body: JSON.stringify(previewBody(TENANT_A)),
    });
    expect(res.status).toBe(403);
    expect(JSON.parse(res.body).code).toBe('PERMISSION_DENIED');
    expect(stub.requests).toHaveLength(0);
  });

  it('submit requires an Idempotency-Key and forwards the fingerprint', async () => {
    const withoutKey = await post(SUBMIT, { ...previewBody(TENANT_A), resolutionFingerprint: FINGERPRINT });
    expect(withoutKey.status).toBe(422);
    expect(stub.requests).toHaveLength(0);

    const submitted = await post(
      SUBMIT,
      { ...previewBody(TENANT_A), resolutionFingerprint: FINGERPRINT },
      { 'idempotency-key': 'pc08-workbench-submit-1' },
    );
    expect(submitted.status).toBe(202);
    expect(stub.requests[0]?.path).toBe('/api/internal/admin-workbench/v2/submit');
    expect(stub.requests[0]?.idempotencyKey).toBe('pc08-workbench-submit-1');
    const forwarded = JSON.parse(stub.requests[0]?.body ?? '{}') as { resolutionFingerprint?: string };
    expect(forwarded.resolutionFingerprint).toBe(FINGERPRINT);
  });

  it('a matching local USER operator forwards the session proof and no bearer', async () => {
    const res = await httpRequest(`${baseUrl}${PREVIEW}`, {
      method: 'POST',
      headers: {
        cookie: `du_session=${LOCAL_SESSION}`,
        'content-type': 'application/json',
        'x-csrf-token': 'l'.repeat(43),
      },
      body: JSON.stringify(previewBody(TENANT_A)),
    });
    expect(res.status).toBe(200);
    expect(stub.requests[0]?.auth).toBeNull();
    expect(stub.requests[0]?.cookie).toBe(`du_session=${LOCAL_SESSION}`);
    expect(stub.requests[0]?.csrf).toBe('l'.repeat(43));
  });

  it('a tenant operator cannot address another tenant', async () => {
    const res = await httpRequest(`${baseUrl}${PREVIEW}`, {
      method: 'POST',
      headers: {
        cookie: `du_session=${TENANT_SESSION}`,
        'content-type': 'application/json',
        'x-csrf-token': 't'.repeat(43),
      },
      body: JSON.stringify(previewBody(TENANT_B)),
    });
    expect(res.status).toBe(404);
    expect(stub.requests).toHaveLength(0);
  });

  it('a tenant operator reaches the upstream with the tenant credential', async () => {
    const res = await httpRequest(`${baseUrl}${PREVIEW}`, {
      method: 'POST',
      headers: {
        cookie: `du_session=${TENANT_SESSION}`,
        'content-type': 'application/json',
        'x-csrf-token': 't'.repeat(43),
      },
      body: JSON.stringify(previewBody(TENANT_A)),
    });
    expect(res.status).toBe(200);
    expect(stub.requests[0]?.auth).toBe(`Bearer ${TENANT_A_TOKEN}`);
  });

  it('a stale fingerprint is relayed as 409 PROFILE_CHANGED', async () => {
    const res = await post(
      SUBMIT,
      { ...previewBody(TENANT_A), resolutionFingerprint: `sha256:${'c'.repeat(64)}` },
      { 'idempotency-key': 'pc08-workbench-stale-1' },
    );
    expect(res.status).toBe(409);
    expect(JSON.parse(res.body).code).toBe('PROFILE_CHANGED');
  });

  it('an invalid preview body never reaches the upstream', async () => {
    const res = await post(PREVIEW, { tenantId: TENANT_A });
    expect(res.status).toBe(422);
    expect(stub.requests).toHaveLength(0);
  });
});

