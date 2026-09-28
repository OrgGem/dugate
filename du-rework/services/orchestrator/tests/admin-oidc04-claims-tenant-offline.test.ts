import { assertRoleActionTenant } from '../src/modules/admin-actions/dispatcher';
import { resolveAdminActionAuthAsync } from '../src/modules/admin-actions/rbac';
import { createOidcClient, type FetchLike } from '../src/modules/auth/oidc-client';
import { createMemorySessionRepository, createSessionStore } from '../src/modules/auth/session-store';
import { createMemoryChallengeStore, createOidcFlow } from '../src/app/admin/oidc-flow';
import { dispatchShellRequestAsync, type ShellRuntimeConfig } from '../src/app/admin/shell-router';
import type { AdminShellRequest } from '../src/app/admin/shell-types';
import { startMockOidcIdp, type MockOidcIdp, type MockPrincipal } from './stubs/mock-oidc-idp';

/**
 * W-OIDC04-FLOW-1 / OIDC-04 — the seam the packet names as
 * 'role claims injection', proven over the REAL chain:
 *
 *   mock IdP (loopback, RS256) -> real OidcClient (signature, nonce,
 *   aud, iss) -> real createOidcFlow -> real SessionStore ->
 *   real resolveAdminActionAuthAsync -> real assertRoleActionTenant.
 *
 * The gap this file closes (measured, not assumed):
 *  - admin-oidc-flow.test.ts covers the operator/multi-tenant claim
 *    branches of roleFor ONLY through a STUB client (st.overrides), so
 *    the verified-token path to those branches was untested;
 *  - admin-action-dispatcher.test.ts covers mapOidcClaimsToPrincipal,
 *    a DIFFERENT function on the API bearer plane;
 *  - admin-shell-oidc-flow-integration.test.ts drives the real path but
 *    only the platformAdmin branch, because the mock IdP default
 *    principal is platformAdmin:true;
 *  - oidc03-role-action-tenant-offline.test.ts proves the gate matrix
 *    from SYNTHETIC auth objects.
 * So nothing in the repo proved that a signature-verified tenantIds
 * claim actually lands in the session record as role=operator with
 * that tenant, and that the gate then reads that very tenant. A
 * regression in that mapping would fail every operator write at the
 * fence (or, worse, mint an admin) with no test turning red.
 *
 * Zero DB, zero Redis, zero S3: memory session repo, in-process
 * challenge store, and the loopback mock IdP only. The 3 DU_LIVE_INFRA
 * legs of OIDC-02 stay skipped in their own file.
 */

const SHELL_ORIGIN = 'http://localhost:2023';
const REDIRECT_URI = SHELL_ORIGIN + '/admin/oidc/callback';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const COOKIE_SECRET = 'e2e-secret-0123456789ab';

let idp: MockOidcIdp;

const fetchImpl: FetchLike = async (url, init) => {
  const r = await fetch(url, {
    method: init.method as 'GET' | 'POST',
    headers: init.headers,
    body: init.body,
    redirect: 'manual',
  });
  return { status: r.status, ok: r.ok, json: async () => (await r.json()) as unknown };
};

function mkReq(method: 'GET' | 'POST' | 'HEAD', pathname: string, extra: Partial<AdminShellRequest> = {}): AdminShellRequest {
  return { method, pathname, cookies: {}, body: {}, ...extra };
}

function sessionSid(setCookie: string | undefined): string {
  const m = /du_session=([A-Za-z0-9_-]{43})/.exec(setCookie ?? '');
  return m?.[1] ?? '';
}

function world() {
  const client = createOidcClient(
    {
      issuer: idp.issuer,
      clientId: 'du-admin',
      clientSecret: 'shhh',
      redirectUri: REDIRECT_URI,
      allowedIssuers: [idp.issuer],
    },
    { fetchImpl }
  );
  const sessions = createSessionStore({ repo: createMemorySessionRepository() });
  const flow = createOidcFlow({
    client,
    sessions,
    challenges: createMemoryChallengeStore(),
    publicOrigin: SHELL_ORIGIN,
  });
  const config: ShellRuntimeConfig = {
    cookieSecret: COOKIE_SECRET,
    adminToken: 'at-e2e',
    oidcFlow: flow,
    oidcSessions: sessions,
  };
  async function loginUrl(): Promise<URL> {
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/login'), config);
    expect(res.routeId).toBe('oidc-login');
    expect(res.response.status).toBe(302);
    return new URL(res.response.headers['location'] ?? '');
  }
  async function authorizeAtIdp(authUrl: URL): Promise<{ code: string; state: string }> {
    const r = await fetch(authUrl.toString(), { redirect: 'manual' });
    expect(r.status).toBe(302);
    const back = new URL(r.headers.get('location') ?? '');
    expect(back.origin + back.pathname).toBe(REDIRECT_URI);
    return { code: back.searchParams.get('code') ?? '', state: back.searchParams.get('state') ?? '' };
  }
  async function callback(code: string, state: string) {
    return dispatchShellRequestAsync(
      mkReq('GET', '/admin/oidc/callback', { query: { code, state } }),
      config
    );
  }
  return { config, sessions, loginUrl, authorizeAtIdp, callback };
}

/** Full browser round-trip for one IdP principal shape. */
async function signInAs(principal: MockPrincipal) {
  idp.setPrincipal(principal);
  const w = world();
  const login = await w.loginUrl();
  const { code, state } = await w.authorizeAtIdp(login);
  const cb = await w.callback(code, state);
  expect(cb.response.status).toBe(302);
  expect(cb.response.headers['location']).toBe('/admin');
  const sid = sessionSid(cb.response.headers['set-cookie']);
  expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
  const record = await w.sessions.get(sid);
  if (!record) throw new Error('callback set a du_session with no server-side record');
  return { sid, record, sessions: w.sessions, config: w.config };
}

beforeAll(async () => {
  process.env.NO_PROXY = '127.0.0.1,localhost';
  idp = await startMockOidcIdp();
});
afterAll(async () => {
  await idp?.close();
});
beforeEach(() => idp.reset());

describe('W-OIDC04-FLOW-1: verified IdP claims become the session role/tenant', () => {
  it('platformAdmin claim mints an admin session carrying NO tenant', async () => {
    const { record } = await signInAs({ sub: 'u-admin', platformAdmin: true });
    expect(record.role).toBe('admin');
    expect(record.tenantId).toBeNull();
    expect(record.sub).toBe('u-admin');
    expect(record.issuer).toBe(idp.issuer);
  });

  it('a single tenantId claim mints an OPERATOR session bound to that tenant', async () => {
    const { record } = await signInAs({ sub: 'u-op', tenantIds: [TENANT_A] });
    expect(record.role).toBe('operator');
    expect(record.tenantId).toBe(TENANT_A);
  });

  it('a MULTI-tenant claim falls back to viewer with no tenant (default deny)', async () => {
    const { record } = await signInAs({ sub: 'u-multi', tenantIds: [TENANT_A, TENANT_B] });
    expect(record.role).toBe('viewer');
    expect(record.tenantId).toBeNull();
  });

  it('an EMPTY tenant claim falls back to viewer (default deny)', async () => {
    const { record } = await signInAs({ sub: 'u-empty', tenantIds: [] });
    expect(record.role).toBe('viewer');
    expect(record.tenantId).toBeNull();
  });

  it('a string platformAdmin claim is NOT admin (default deny)', async () => {
    const { record } = await signInAs({ sub: 'u-hostile-admin', platformAdminClaim: 'true' });
    expect(record.role).toBe('viewer');
    expect(record.tenantId).toBeNull();
  });

  it('a NON-ARRAY tenant claim is NOT a tenant (default deny)', async () => {
    const { record } = await signInAs({
      sub: 'u-hostile-tenant',
      tenantIds: TENANT_A,
    } as unknown as MockPrincipal);
    expect(record.role).toBe('viewer');
    expect(record.tenantId).toBeNull();
  });
});

describe('W-OIDC04-FLOW-1: the minted session is exactly what the SEC-00 gate reads', () => {
  it('the browser cookie resolves to a cookie auth with the IdP tenant and its own CSRF', async () => {
    const { sid, record, sessions } = await signInAs({ sub: 'u-op', tenantIds: [TENANT_A] });
    const auth = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { cookie: 'du_session=' + sid, 'x-csrf-token': record.csrfToken },
      sessions
    );
    expect(auth).toEqual({
      kind: 'cookie',
      role: 'operator',
      tenantId: TENANT_A,
      csrfOk: true,
    });
  });

  it('that operator session cancels in its OWN tenant and is fenced out of a foreign one', async () => {
    const { sid, record, sessions } = await signInAs({ sub: 'u-op', tenantIds: [TENANT_A] });
    const auth = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { cookie: 'du_session=' + sid, 'x-csrf-token': record.csrfToken },
      sessions
    );
    expect(assertRoleActionTenant(auth, 'operations.cancel', TENANT_A)).toEqual({ ok: true });
    expect(assertRoleActionTenant(auth, 'operations.resume', TENANT_A)).toEqual({ ok: true });
    expect(assertRoleActionTenant(auth, 'operations.cancel', TENANT_B)).toEqual({
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'mutations are scoped to the caller tenant',
    });
    expect(assertRoleActionTenant(auth, 'operations.cancel', null)).toEqual({
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'mutations are scoped to the caller tenant',
    });
  });

  it('the same session is refused at the CSRF leg without its own csrf token', async () => {
    const { sid, sessions } = await signInAs({ sub: 'u-op', tenantIds: [TENANT_A] });
    const bare = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { cookie: 'du_session=' + sid },
      sessions
    );
    expect(bare?.kind === 'cookie' ? bare.csrfOk : null).toBe(false);
    expect(assertRoleActionTenant(bare, 'operations.cancel', TENANT_A)).toEqual({
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'cookie-authenticated admin actions require a valid CSRF token',
    });
    const forged = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { cookie: 'du_session=' + sid, 'x-csrf-token': 'attacker-chosen' },
      sessions
    );
    expect(forged?.kind === 'cookie' ? forged.csrfOk : null).toBe(false);
    expect(assertRoleActionTenant(forged, 'operations.cancel', TENANT_A)).toEqual({
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'cookie-authenticated admin actions require a valid CSRF token',
    });
  });

  it('the operator session is refused an admin-only action even on its own tenant', async () => {
    const { sid, record, sessions } = await signInAs({ sub: 'u-op', tenantIds: [TENANT_A] });
    const auth = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { cookie: 'du_session=' + sid, 'x-csrf-token': record.csrfToken },
      sessions
    );
    expect(assertRoleActionTenant(auth, 'apikey.bind-profile', TENANT_A)).toEqual({
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'session role is not permitted for this action',
    });
  });

  it('a multi-tenant viewer session reaches no operator action and is a valid console session', async () => {
    const { sid, record, sessions, config } = await signInAs({
      sub: 'u-multi',
      tenantIds: [TENANT_A, TENANT_B],
    });
    const auth = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { cookie: 'du_session=' + sid, 'x-csrf-token': record.csrfToken },
      sessions
    );
    expect(auth).toEqual({ kind: 'cookie', role: 'viewer', tenantId: null, csrfOk: true });
    const refused = {
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'session role is not permitted for this action',
    };
    expect(assertRoleActionTenant(auth, 'operations.cancel', TENANT_A)).toEqual(refused);
    expect(assertRoleActionTenant(auth, 'operations.resume', TENANT_B)).toEqual(refused);
    const page = await dispatchShellRequestAsync(
      mkReq('GET', '/admin', { cookies: { du_session: sid } }),
      config
    );
    expect(page.routeId).toBe('admin-root');
    expect(page.response.status).toBe(200);
  });
});
