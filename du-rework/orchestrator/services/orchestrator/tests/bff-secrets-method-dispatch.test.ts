/**
 * F-VFYSC1-02 — permanent regression test for SC-04-M02 (BFF secrets method
 * dispatch), per Claude audit r4 §10.6/§10.7.
 *
 * Defect that must never return: `matchSecretsRoute('/secrets')` is a pure path
 * matcher (always `{kind:'list'}`), so `handleSecretsRoute` must dispatch by
 * method itself. Before the fix, `list` demanded GET and `POST /secrets` was
 * rejected 405 before the create branch could run.
 *
 * This suite pins the dispatch matrix against a captured upstream:
 *   1. GET    /secrets                -> list, upstream GET with allowlisted query
 *   2. POST   /secrets                -> create, upstream POST with tenant-scope body
 *   3. PUT/DELETE/PATCH /secrets      -> 405 METHOD_NOT_ALLOWED, no upstream call
 *   4. POST   /secrets/:id/{rotate|disable|test} -> mutation validation + upstream
 *      GET    /secrets/:id/{rotate|disable|test} -> 405 (mutations stay POST-only)
 *
 * Offline by construction: no network, no DB, no Redis. The BFF session is a
 * mocked platform-admin context; the upstream is an injected `fetchImpl` that
 * records exactly what the BFF would have sent.
 */
import { Readable } from 'node:stream';
import { handleSecretsRoute, matchSecretsRoute } from '../src/app/admin/bff/secrets';
import { resolveBffContext } from '../src/app/admin/bff/context';

jest.mock('../src/app/admin/bff/context', () => ({
  resolveBffContext: jest.fn(async () => ({
    principal: { kind: 'platform' },
    role: 'admin',
    verifyCsrf: () => true,
  })),
}));

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const SECRET_ID = '33333333-3333-4333-8333-333333333333';

interface CapturedCall {
  url: string;
  init: { method: string; headers: Record<string, string>; body?: string };
}

const calls: CapturedCall[] = [];

const runtime = {
  adminToken: 'platform-admin-token',
  jsonBaseUrl: 'http://upstream.test',
  fetchImpl: async (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => {
    calls.push({ url, init });
    return new Response(JSON.stringify({ items: [], nextCursor: null }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  },
};

interface FakeResponse {
  statusCode: number;
  headers: Record<string, string>;
  body?: Record<string, unknown>;
}

function fakeRes(): FakeResponse {
  const res: FakeResponse = {
    statusCode: 0,
    headers: {},
    body: undefined,
  };
  (res as unknown as { setHeader: (name: string, value: string) => void }).setHeader = (name, value) => {
    res.headers[name] = value;
  };
  (res as unknown as { end: (chunk?: string) => void }).end = (chunk?: string) => {
    if (chunk !== undefined) res.body = JSON.parse(chunk) as Record<string, unknown>;
  };
  return res;
}

/** Minimal IncomingMessage: headers + method + an async body stream. */
function fakeReq(method: string, headers: Record<string, string> = {}, body?: string): never {
  const stream = Readable.from(body === undefined ? [] : [Buffer.from(body)]);
  return Object.assign(stream, { method, headers }) as never;
}

async function invoke(
  method: string,
  relative: string,
  options: { query?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; body?: Record<string, unknown>; calls: CapturedCall[] }> {
  calls.length = 0;
  const res = fakeRes();
  const route = matchSecretsRoute(relative);
  if (!route) throw new Error(`no secrets route matches ${relative}`);
  await handleSecretsRoute(
    fakeReq(method, { 'x-csrf-token': 'csrf-ok', ...(options.headers ?? {}) }, options.body),
    res as never,
    {} as never,
    route,
    new URLSearchParams(options.query ?? ''),
    {} as never,
    runtime as never,
    'test-correlation',
  );
  return { status: res.statusCode, body: res.body, calls: [...calls] };
}

const CREATE_BODY = JSON.stringify({
  tenantId: TENANT,
  name: 'invoice-api-key',
  purpose: 'generic',
  services: ['orchestrator'],
  provider: { kind: 'managed_value' },
  value: { kind: 'literal', value: 'write-only-literal' },
});

beforeEach(() => {
  calls.length = 0;
  (resolveBffContext as jest.Mock).mockClear();
});

describe('F-VFYSC1-02 secrets BFF method dispatch', () => {
  describe('1. GET /secrets stays the catalog list', () => {
    it('forwards the allowlisted query + tenant scope upstream as GET', async () => {
      const out = await invoke('GET', '/secrets', {
        query: `tenantId=${TENANT}&limit=2&cursor=abc&state=ACTIVE&evil=drop-me`,
      });
      expect(out.status).toBe(200);
      expect(out.calls).toHaveLength(1);
      expect(out.calls[0]!.init.method).toBe('GET');
      const upstream = new URL(out.calls[0]!.url);
      expect(upstream.origin + upstream.pathname).toBe('http://upstream.test/api/v1/admin/secrets');
      expect(upstream.searchParams.get('limit')).toBe('2');
      expect(upstream.searchParams.get('cursor')).toBe('abc');
      expect(upstream.searchParams.get('state')).toBe('ACTIVE');
      expect(upstream.searchParams.get('tenantId')).toBe(TENANT);
      // Non-allowlisted query parameters never reach the upstream.
      expect(upstream.searchParams.has('evil')).toBe(false);
      // List never carries a body.
      expect(out.calls[0]!.init.body).toBeUndefined();
    });
  });

  describe('2. POST /secrets reaches CREATE (the former dead branch)', () => {
    it('posts to the catalog endpoint with the session tenant bound into the body', async () => {
      const out = await invoke('POST', '/secrets', {
        query: `tenantId=${TENANT}`,
        headers: { 'idempotency-key': 'idem-create-1' },
        body: CREATE_BODY,
      });
      expect(out.status).toBe(200);
      expect(out.calls).toHaveLength(1);
      expect(out.calls[0]!.init.method).toBe('POST');
      expect(out.calls[0]!.url).toBe('http://upstream.test/api/v1/admin/secrets');
      const sent = JSON.parse(out.calls[0]!.init.body ?? '{}') as Record<string, unknown>;
      expect(sent.tenantId).toBe(TENANT);
      expect(sent.provider).toEqual({ kind: 'managed_value' });
      expect(sent.value).toEqual({ kind: 'literal', value: 'write-only-literal' });
      expect(out.calls[0]!.init.headers['idempotency-key']).toBe('idem-create-1');
    });

    it('refuses a body whose tenantId contradicts the session scope (422, no upstream)', async () => {
      const out = await invoke('POST', '/secrets', {
        query: `tenantId=${TENANT}`,
        body: JSON.stringify({ ...JSON.parse(CREATE_BODY), tenantId: OTHER_TENANT }),
      });
      expect(out.status).toBe(422);
      expect(out.body).toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(out.calls).toHaveLength(0);
    });
  });

  describe('3. Non-GET methods on /secrets are rejected before auth or upstream', () => {
    it.each(['PUT', 'DELETE', 'PATCH'])('%s /secrets -> 405 METHOD_NOT_ALLOWED, no upstream call', async (method) => {
      const out = await invoke(method, '/secrets', { query: `tenantId=${TENANT}` });
      expect(out.status).toBe(405);
      expect(out.body).toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
      expect(out.calls).toHaveLength(0);
      // The method gate runs before the session/context resolution.
      expect(resolveBffContext).not.toHaveBeenCalled();
    });
  });

  describe('4. Per-secret mutations stay POST-only and reach their own upstream route', () => {
    it('POST /secrets/:id/rotate validates and forwards the rotation body', async () => {
      const out = await invoke('POST', `/secrets/${SECRET_ID}/rotate`, {
        query: `tenantId=${TENANT}`,
        body: JSON.stringify({ expectedRevision: 3, value: { kind: 'literal', value: 'rotated' } }),
      });
      expect(out.status).toBe(200);
      expect(out.calls).toHaveLength(1);
      expect(out.calls[0]!.init.method).toBe('POST');
      expect(out.calls[0]!.url).toBe(`http://upstream.test/api/v1/admin/secrets/${SECRET_ID}/rotate`);
      const sent = JSON.parse(out.calls[0]!.init.body ?? '{}') as Record<string, unknown>;
      expect(sent.secretId).toBe(SECRET_ID);
      expect(sent.expectedRevision).toBe(3);
    });

    it('POST /secrets/:id/disable validates and forwards the disable body', async () => {
      const out = await invoke('POST', `/secrets/${SECRET_ID}/disable`, {
        query: `tenantId=${TENANT}`,
        body: JSON.stringify({ expectedRevision: 4, reason: 'rotation window' }),
      });
      expect(out.status).toBe(200);
      expect(out.calls).toHaveLength(1);
      expect(out.calls[0]!.url).toBe(`http://upstream.test/api/v1/admin/secrets/${SECRET_ID}/disable`);
      const sent = JSON.parse(out.calls[0]!.init.body ?? '{}') as Record<string, unknown>;
      expect(sent.secretId).toBe(SECRET_ID);
      expect(sent.reason).toBe('rotation window');
    });

    it('POST /secrets/:id/test forwards an empty probe body', async () => {
      const out = await invoke('POST', `/secrets/${SECRET_ID}/test`, {
        query: `tenantId=${TENANT}`,
        body: '{}',
      });
      expect(out.status).toBe(200);
      expect(out.calls).toHaveLength(1);
      expect(out.calls[0]!.url).toBe(`http://upstream.test/api/v1/admin/secrets/${SECRET_ID}/test`);
      expect(out.calls[0]!.init.body).toBe('{}');
    });

    it.each(['rotate', 'disable', 'test'])('GET /secrets/:id/%s -> 405, no upstream call', async (action) => {
      const out = await invoke('GET', `/secrets/${SECRET_ID}/${action}`, { query: `tenantId=${TENANT}` });
      expect(out.status).toBe(405);
      expect(out.body).toMatchObject({ code: 'METHOD_NOT_ALLOWED' });
      expect(out.calls).toHaveLength(0);
      expect(resolveBffContext).not.toHaveBeenCalled();
    });

    it('POST /secrets/:id/rotate with an invalid body -> 422 before any upstream call', async () => {
      const out = await invoke('POST', `/secrets/${SECRET_ID}/rotate`, {
        query: `tenantId=${TENANT}`,
        body: JSON.stringify({ expectedRevision: 0 }),
      });
      expect(out.status).toBe(422);
      expect(out.body).toMatchObject({ code: 'INVALID_SCHEMA' });
      expect(out.calls).toHaveLength(0);
    });
  });
});
