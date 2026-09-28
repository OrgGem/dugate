import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { createOidcClient, type FetchLike } from '../src/modules/auth/oidc-client';
import { createMemorySessionRepository, createSessionStore, type SessionRecord } from '../src/modules/auth/session-store';
import { createMemoryChallengeStore, createOidcFlow } from '../src/app/admin/oidc-flow';
import { dispatchShellRequestAsync, type ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellRequest } from '../src/app/admin/shell-types';
import { ADMIN_ACTIONS, assertRoleActionTenant } from '../src/modules/admin-actions/dispatcher';
import { resolveAdminActionAuthAsync, type AdminActionAuth, type AdminSecurityAuditSink, type AdminSecurityEvent } from '../src/modules/admin-actions/rbac';

/**
 * CYCLE-101 offline protection of the du_session lifecycle ON the mounted
 * shell router: live session serves the console; expired / revoked / forged
 * / anonymous all take the SAME graceful 302 to /admin/login (stale cookie
 * swept), while legacy du_admin deployments keep their exact behavior.
 * Zero sockets, zero DB.
 */

const ISS = 'http://localhost:9999/realm/du';
const T0 = Date.UTC(2026, 8, 25, 9, 0, 0);
const COOKIE_SECRET = 'sec-abcdef-0123456789';
const ORIGIN_HTTP = 'http://localhost:2023';
const ORIGIN_HTTPS = 'https://admin.example.test';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function b64u(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return { kid, privateKey, jwk: { kty: 'RSA', use: 'sig' as const, alg: 'RS256', kid, n: jwk.n, e: jwk.e } };
}

function mkReq(method: 'GET' | 'POST' | 'HEAD', pathname: string, extra: Partial<AdminShellRequest> = {}): AdminShellRequest {
  return { method, pathname, cookies: {}, body: {}, ...extra };
}

function world(options: { publicOrigin?: string } = {}) {
  // SEC-04: the public origin is what decides the Secure flag, so a suite
  // that only ever uses http can never prove the https branch runs.
  const publicOrigin = options.publicOrigin ?? ORIGIN_HTTP;
  let nowMs = T0;
  const key = makeKey('kid-L');
  const pending = { nonce: 'n0' };
  const fetchImpl: FetchLike = async (url, init) => {
    const json = (obj: unknown, ok = true, status = 200) => ({ status, ok, json: async () => obj });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({ issuer: ISS, jwks_uri: ISS + '/jwks', authorization_endpoint: ISS + '/authorize', token_endpoint: ISS + '/token' });
    }
    if (url.endsWith('/jwks')) return json({ keys: [key.jwk] });
    if (url.endsWith('/token') && init.method === 'POST') {
      const nowSec = Math.floor(nowMs / 1000);
      const h = b64u(Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT' }), 'utf8'));
      const p = b64u(Buffer.from(JSON.stringify({
        iss: ISS, aud: 'du-admin', sub: 'lifesub', iat: nowSec, exp: nowSec + 300, nonce: pending.nonce, platformAdmin: true,
      }), 'utf8'));
      const sig = cryptoSign('RSA-SHA256', Buffer.from(h + '.' + p, 'ascii'), key.privateKey);
      return json({ id_token: h + '.' + p + '.' + b64u(sig), token_type: 'Bearer' });
    }
    return json({}, false, 404);
  };
  const client = createOidcClient(
    { issuer: ISS, clientId: 'du-admin', clientSecret: 'sec', redirectUri: publicOrigin + '/admin/oidc/callback', allowedIssuers: [ISS] },
    { fetchImpl, now: () => nowMs }
  );
  const sessions0 = createSessionStore({ repo: createMemorySessionRepository(), now: () => nowMs });
  const flow = createOidcFlow({
    client,
    sessions: sessions0,
    challenges: createMemoryChallengeStore(() => nowMs),
    publicOrigin,
    now: () => nowMs,
  });
  const config: ShellRuntimeConfig = {
    cookieSecret: COOKIE_SECRET,
    adminToken: 'at',
    oidcFlow: flow,
    oidcSessions: sessions0,
  };
  async function signInFull(): Promise<{ sid: string; setCookie: string; record: SessionRecord }> {
    const login = await dispatchShellRequestAsync(mkReq('GET', '/admin/login'), config);
    const url = new URL(login.response.headers['location'] ?? '');
    pending.nonce = url.searchParams.get('nonce') ?? 'n0';
    const cb = await dispatchShellRequestAsync(
      mkReq('GET', '/admin/oidc/callback', { query: { code: 'c', state: url.searchParams.get('state') ?? '' } }),
      config
    );
    const setCookie = cb.response.headers['set-cookie'] ?? '';
    const sid = setCookie.split('=')[1]?.split(';')[0] ?? '';
    if (!sid) throw new Error('no session cookie minted');
    const record = await sessions0.get(sid);
    if (!record) throw new Error('callback set a du_session with no server-side record');
    return { sid, setCookie, record };
  }
  async function signIn(): Promise<string> {
    return (await signInFull()).sid;
  }
  return { config, sessions0, signIn, signInFull, advance: (ms: number) => { nowMs += ms; } };
}

describe('CYCLE-101 session gate on the shell router', () => {
  it('live session serves the console (claims injected into the sync dispatcher)', async () => {
    const w = world();
    const sid = await w.signIn();
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: sid } }), w.config);
    expect(res.routeId).toBe('section:businesses');
    expect(res.response.status).toBe(200);
  });

  it('EXPIRED session -> graceful 302 /admin/login + stale cookie swept', async () => {
    const w = world();
    const sid = await w.signIn();
    w.advance(9 * 3_600_000); // past the 8h absolute TTL -> store.get evicts
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: sid } }), w.config);
    expect(res.routeId).toBe('oidc-session-gate');
    expect(res.response.status).toBe(302);
    expect(res.response.headers['location']).toBe('/admin/login');
    expect(res.response.headers['set-cookie']).toContain('du_session=;');
    expect(res.response.headers['set-cookie']).toContain('Max-Age=0');
    // and the store really dropped it (lazy eviction on the failed read):
    expect(await w.sessions0.get(sid)).toBeNull();
  });

  it('revoked session -> 302 gate', async () => {
    const w = world();
    const sid = await w.signIn();
    expect(await w.sessions0.destroy(sid)).toBe(true);
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: sid } }), w.config);
    expect(res.routeId).toBe('oidc-session-gate');
    expect(res.response.status).toBe(302);
    expect(res.response.headers['location']).toBe('/admin/login');
    expect(res.response.headers['set-cookie']).toContain('du_session=;');
    expect(res.response.headers['set-cookie']).toContain('Max-Age=0');
  });

  it('forged (well-formed, unknown) session id -> 302 gate', async () => {
    const w = world();
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: 'F'.repeat(43) } }), w.config);
    expect(res.routeId).toBe('oidc-session-gate');
  });

  it('anonymous under OIDC -> 302 gate (no raw unauthorized pane)', async () => {
    const w = world();
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses'), w.config);
    expect(res.routeId).toBe('oidc-session-gate');
    expect(res.response.status).toBe(302);
  });

  it('legacy du_admin-only request passes through untouched (coexistence)', async () => {
    const w = world();
    const { signCookie } = await import('../src/app/admin/shell-auth');
    const legacy = signCookie(COOKIE_SECRET, {
      iss: 'du-admin-shell', role: 'admin', iat: T0, exp: T0 + 3_600_000,
    })!;
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_admin: legacy } }), w.config);
    expect(res.routeId).toBe('section:businesses');
  });

  it('already signed in: GET /admin/login -> 302 /admin (no IdP round-trip)', async () => {
    const w = world();
    const sid = await w.signIn();
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/login', { cookies: { du_session: sid } }), w.config);
    expect(res.response.status).toBe(302);
    expect(res.response.headers['location']).toBe('/admin');
  });

  it('anonymous GET /admin/login still starts the PKCE flow', async () => {
    const w = world();
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/login'), w.config);
    expect(res.response.status).toBe(302);
    expect(res.response.headers['location']).toContain(ISS + '/authorize');
  });

  it('favicon bypasses the gate (no auth surface on static assets)', async () => {
    const w = world();
    const res = await dispatchShellRequestAsync(mkReq('GET', '/favicon.ico'), w.config);
    expect(res.routeId).toBe('favicon');
  });

  it('gate OFF without oidcSessions: garbage du_session is simply ignored (flow-only deployment)', async () => {
    const w = world();
    const cfg: ShellRuntimeConfig = { ...w.config, oidcSessions: undefined };
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: 'G'.repeat(43) } }), cfg);
    // gate OFF => identical to the pre-OIDC contract: sync dispatcher's
    // no-claims UNAUTHORIZED pane (401), NOT the graceful-redirect gate.
    expect(res.routeId).toBe('section:businesses');
    expect(res.response.status).toBe(401);
  });
});

/** Split a possibly joined Set-Cookie header and return the named cookie. */
function cookieSegment(header: string, name: string): string {
  const hit = header
    .split(',')
    .map((s) => s.trim())
    .find((s) => s.startsWith(name + '='));
  if (!hit) throw new Error('no ' + name + ' cookie in Set-Cookie: ' + header);
  return hit;
}

describe('W-OIDC04 cookie posture through the REAL callback', () => {
  it('https public origin mints du_session with Secure + HttpOnly + SameSite=Lax + Path=/', async () => {
    const w = world({ publicOrigin: ORIGIN_HTTPS });
    const { sid, setCookie } = await w.signInFull();
    const c = cookieSegment(setCookie, 'du_session');
    expect(c).toContain('Secure');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
    expect(c).toContain('Max-Age=');
    expect(c.startsWith('du_session=' + sid + ';')).toBe(true);
  });

  it('https logout clears the session cookie with the SAME posture and destroys the record', async () => {
    const w = world({ publicOrigin: ORIGIN_HTTPS });
    const { sid } = await w.signInFull();
    const res = await dispatchShellRequestAsync(mkReq('POST', '/admin/logout', { cookies: { du_session: sid } }), w.config);
    const c = cookieSegment(res.response.headers['set-cookie'] ?? '', 'du_session');
    expect(c).toContain('Max-Age=0');
    expect(c).toContain('Secure');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(await w.sessions0.get(sid)).toBeNull();
  });

  it('http public origin omits Secure but keeps the rest - the flag is DERIVED, not hardcoded', async () => {
    const w = world();
    const { setCookie } = await w.signInFull();
    const c = cookieSegment(setCookie, 'du_session');
    expect(c).not.toContain('Secure');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Lax');
    expect(c).toContain('Path=/');
  });

  it('the wire value is the opaque id ONLY - no role, subject or csrf material rides the cookie', async () => {
    const w = world({ publicOrigin: ORIGIN_HTTPS });
    const { sid, setCookie, record } = await w.signInFull();
    expect(sid).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(record.sessionId).toBe(sid);
    expect(record.csrfToken.length).toBeGreaterThan(0);
    expect(setCookie).not.toContain(record.csrfToken);
    expect(setCookie).not.toContain('lifesub');
    expect(setCookie).not.toContain('platformAdmin');
  });
});

const CSRF_MESSAGE = 'cookie-authenticated admin actions require a valid CSRF token';
const ROLE_MESSAGE = 'session role is not permitted for this action';
const TENANT_MESSAGE = 'mutations are scoped to the caller tenant';

/** Every action the table exposes to cookie-authenticated callers. Derived
 *  from the real table, so a new mutation row is covered automatically. */
const COOKIE_ACTIONS = Object.entries(ADMIN_ACTIONS)
  .filter(([, def]) => (def.cookieRoles?.length ?? 0) > 0)
  .map(([name]) => name);

describe('W-OIDC04 CSRF guard covers EVERY cookie mutation action', () => {
  it('the table really exposes mutations to cookie auth (otherwise this group is vacuous)', () => {
    expect(COOKIE_ACTIONS.length).toBeGreaterThanOrEqual(8);
    expect(COOKIE_ACTIONS).toContain('operations.cancel');
    expect(COOKIE_ACTIONS).toContain('operations.resume');
    expect(COOKIE_ACTIONS).toContain('apikey.bind-profile');
  });

  it('a missing or bogus CSRF token is refused for every cookie-allowed action, any role', () => {
    const offenders: string[] = [];
    const cases: Array<{ label: string; auth: AdminActionAuth }> = [
      { label: 'admin', auth: { kind: 'cookie', role: 'admin', csrfOk: false } },
      { label: 'operator', auth: { kind: 'cookie', role: 'operator', tenantId: TENANT_A, csrfOk: false } },
      { label: 'viewer', auth: { kind: 'cookie', role: 'viewer', csrfOk: false } },
    ];
    for (const { label, auth } of cases) {
      for (const action of COOKIE_ACTIONS) {
        const d = assertRoleActionTenant(auth, action);
        if (d.ok || d.message !== CSRF_MESSAGE) {
          offenders.push(label + '/' + action + ' -> ' + (d.ok ? 'ALLOWED' : d.message));
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('CSRF is checked BEFORE the role table, so a token-less POST cannot probe permissions', () => {
    // viewer is allowed NOTHING; the refusal must still name CSRF, proving
    // the cross-site check runs first and leaks no role information.
    const d = assertRoleActionTenant({ kind: 'cookie', role: 'viewer', csrfOk: false }, 'business.enable');
    expect(d.ok).toBe(false);
    if (!d.ok) expect(d.message).toBe(CSRF_MESSAGE);
  });

  it('a matching CSRF token admits exactly what the role table allows', () => {
    const admin: AdminActionAuth = { kind: 'cookie', role: 'admin', csrfOk: true };
    for (const action of COOKIE_ACTIONS) {
      expect(assertRoleActionTenant(admin, action)).toEqual({ ok: true });
    }
    const op: AdminActionAuth = { kind: 'cookie', role: 'operator', tenantId: TENANT_A, csrfOk: true };
    expect(assertRoleActionTenant(op, 'operations.cancel')).toEqual({ ok: true });
    expect(assertRoleActionTenant(op, 'operations.resume')).toEqual({ ok: true });
    expect(assertRoleActionTenant(op, 'apikey.bind-profile')).toEqual({
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: ROLE_MESSAGE,
    });
  });

  it('bearer auth is NOT subject to the CSRF leg (server-to-server must keep working)', () => {
    const platform: AdminActionAuth = { kind: 'bearer', principal: { role: 'platform' } };
    for (const action of COOKIE_ACTIONS) {
      expect(assertRoleActionTenant(platform, action)).toEqual({ ok: true });
    }
    const tenantOp: AdminActionAuth = { kind: 'bearer', principal: { role: 'tenant_operator', tenantId: TENANT_A } };
    expect(assertRoleActionTenant(tenantOp, 'operations.cancel')).toEqual({ ok: true });
  });
});

/** Headers a caller might invent. None of them is a credential anywhere in
 *  this code path: identity comes from the bearer token or the STORE. */
const FORGED: Record<string, string> = {
  'x-tenant-id': TENANT_B,
  'x-tenant': TENANT_B,
  'x-admin-role': 'platform',
  'x-du-role': 'admin',
  'x-shell-tenant': TENANT_B,
};

describe('W-OIDC04 forged identity headers never authorize and never re-scope', () => {
  it('forged headers alone resolve no auth, and the gate answers 401', async () => {
    const w = world();
    const auth = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { ...FORGED, authorization: 'Bearer not-a-real-token' },
      w.sessions0
    );
    expect(auth).toBeNull();
    const d = assertRoleActionTenant(auth, 'operations.cancel');
    if (d.ok) throw new Error('forged headers must not authenticate');
    expect(d.status).toBe(401);
    expect(d.code).toBe('UNAUTHENTICATED');
  });

  it("an operator session keeps the STORE tenant even when a header claims another", async () => {
    const w = world();
    const rec = await w.sessions0.create({ issuer: ISS, sub: 'op-a', tenantId: TENANT_A, role: 'operator' });
    const auth = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { ...FORGED, cookie: 'du_session=' + rec.sessionId, 'x-csrf-token': rec.csrfToken },
      w.sessions0
    );
    expect(auth).toEqual({ kind: 'cookie', role: 'operator', tenantId: TENANT_A, csrfOk: true });
    expect(assertRoleActionTenant(auth, 'operations.cancel', TENANT_A)).toEqual({ ok: true });
    const foreign = assertRoleActionTenant(auth, 'operations.cancel', TENANT_B);
    if (foreign.ok) throw new Error('a caller header must never widen the session tenant');
    expect(foreign.message).toBe(TENANT_MESSAGE);
  });

  it('a viewer session with a forged platform/admin header still cannot mutate', async () => {
    const w = world();
    const rec = await w.sessions0.create({ issuer: ISS, sub: 'viewer-1', tenantId: null, role: 'viewer' });
    const auth = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { ...FORGED, cookie: 'du_session=' + rec.sessionId, 'x-csrf-token': rec.csrfToken },
      w.sessions0
    );
    expect(auth).toEqual({ kind: 'cookie', role: 'viewer', tenantId: null, csrfOk: true });
    const d = assertRoleActionTenant(auth, 'business.enable');
    if (d.ok) throw new Error('a viewer session must never mutate');
    expect(d.message).toBe(ROLE_MESSAGE);
  });

  it('an expired or revoked session is not revived by forged headers', async () => {
    const w = world();
    const { sid } = await w.signInFull();
    expect(await w.sessions0.destroy(sid)).toBe(true);
    const auth = await resolveAdminActionAuthAsync(
      { adminShellCookieSecret: COOKIE_SECRET },
      { ...FORGED, cookie: 'du_session=' + sid, 'x-csrf-token': 'x'.repeat(43) },
      w.sessions0
    );
    expect(auth).toBeNull();
  });

  it('the shell request tier carries NO header channel at all', () => {
    // Structural pin: AdminShellRequest is { method, pathname, cookies, body }
    // (+ optional query). If someone adds a headers field, forged browser
    // identity becomes reachable on the shell surface and this fails.
    expect(Object.keys(mkReq('GET', '/admin/businesses')).sort()).toEqual(['body', 'cookies', 'method', 'pathname']);
  });
});

// ---------------------------------------------------------------------------
// W-SEC-COOKIE-CONFIG-1 (delta-27/33 closure): the LEGACY du_admin plane
// now honors the DU_ADMIN_* Secure-cookie policy. The listener is plain
// node:http, so the only proof of client TLS is a strict single-token
// x-forwarded-proto of https, read ONLY under DU_ADMIN_TRUST_PROXY_PROTOCOL;
// requireSecure (enforce or NODE_ENV=production) turns an unproven MINT
// into a 503 denial — under enforcement no cookie is ever minted without
// Secure. Logout clears mirror the posture but never deny.
// ---------------------------------------------------------------------------

function legacyConfig(cookiePolicy?: ShellRuntimeConfig['cookiePolicy']): ShellRuntimeConfig {
  return { cookieSecret: COOKIE_SECRET, adminToken: 'at', nowMs: () => T0, cookiePolicy };
}

async function legacyLogin(cfg: ShellRuntimeConfig, forwardedProto?: string, token = 'at') {
  const extra: Partial<AdminShellRequest> = { body: { token } };
  if (forwardedProto !== undefined) extra.forwardedProto = forwardedProto;
  return (await dispatchShellRequestAsync(mkReq('POST', '/admin/login', extra), cfg)).response;
}

describe('W-SEC-COOKIE-CONFIG-1 legacy du_admin Secure posture', () => {
  it('no policy wired: du_admin mints WITHOUT Secure (byte-for-byte legacy default)', async () => {
    const res = await legacyLogin(legacyConfig());
    expect(res.status).toBe(302);
    const c = cookieSegment(res.headers['set-cookie'] ?? '', 'du_admin');
    expect(c).not.toContain('Secure');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
    expect(c).toContain('Path=/');
    expect(c).toMatch(/Max-Age=[1-9]/);
  });

  it('trust proxy ON + x-forwarded-proto https: du_admin carries Secure', async () => {
    const res = await legacyLogin(legacyConfig({ trustProxyProtocol: true, requireSecure: false }), 'https');
    expect(res.status).toBe(302);
    const c = cookieSegment(res.headers['set-cookie'] ?? '', 'du_admin');
    expect(c).toContain('Secure');
    expect(c).toContain('HttpOnly');
    expect(c).toContain('SameSite=Strict');
  });

  it('the proof normalizes case and padding: " HTTPS " upgrades like https', async () => {
    const res = await legacyLogin(legacyConfig({ trustProxyProtocol: true, requireSecure: false }), ' HTTPS ');
    expect(cookieSegment(res.headers['set-cookie'] ?? '', 'du_admin')).toContain('Secure');
  });

  it('auto mode: unproven variants mint a plain cookie — the upgrade is one-way, never a denial', async () => {
    const cfg = legacyConfig({ trustProxyProtocol: true, requireSecure: false });
    for (const fp of ['http', 'https, http', '', undefined]) {
      const res = await legacyLogin(cfg, fp);
      expect(res.status).toBe(302);
      expect(cookieSegment(res.headers['set-cookie'] ?? '', 'du_admin')).not.toContain('Secure');
    }
  });

  it('trust OFF: a perfectly valid-looking https header is UNREAD -> no Secure', async () => {
    const res = await legacyLogin(legacyConfig({ trustProxyProtocol: false, requireSecure: false }), 'https');
    expect(res.status).toBe(302);
    expect(cookieSegment(res.headers['set-cookie'] ?? '', 'du_admin')).not.toContain('Secure');
  });

  it('requireSecure: every unproven mint is DENIED with NO Set-Cookie', async () => {
    const cases: Array<{ policy: ShellRuntimeConfig['cookiePolicy']; fp: string | undefined }> = [
      { policy: { trustProxyProtocol: true, requireSecure: true }, fp: undefined },
      { policy: { trustProxyProtocol: true, requireSecure: true }, fp: 'http' },
      { policy: { trustProxyProtocol: true, requireSecure: true }, fp: 'https, http' },
      // trust off => the header cannot prove anything even when honest:
      { policy: { trustProxyProtocol: false, requireSecure: true }, fp: 'https' },
    ];
    for (const { policy, fp } of cases) {
      const res = await legacyLogin(legacyConfig(policy), fp);
      expect(res.status).toBe(503);
      expect(res.headers['set-cookie']).toBeUndefined();
      expect(res.body).toContain('Secure connection required');
    }
  });

  it('requireSecure + proven https: the SAME login completes WITH a Secure cookie', async () => {
    const res = await legacyLogin(legacyConfig({ trustProxyProtocol: true, requireSecure: true }), 'https');
    expect(res.status).toBe(302);
    expect(cookieSegment(res.headers['set-cookie'] ?? '', 'du_admin')).toContain('Secure');
  });

  it('the denial runs AFTER credential validation: a wrong token still gets the identical 401', async () => {
    const cfg = legacyConfig({ trustProxyProtocol: true, requireSecure: true });
    const unproven = await legacyLogin(cfg, 'http', 'wrong');
    expect(unproven.status).toBe(401);
    expect(unproven.body).toContain('Invalid token.');
    const proven = await legacyLogin(cfg, 'https', 'wrong');
    expect(proven.status).toBe(401);
  });

  it('logout never denies; the clear carries Secure exactly when TLS is proven', async () => {
    const cfg = legacyConfig({ trustProxyProtocol: true, requireSecure: true });
    const ok = await dispatchShellRequestAsync(
      mkReq('POST', '/admin/logout', { forwardedProto: 'https' }), cfg);
    expect(ok.response.status).toBe(302);
    const c = cookieSegment(ok.response.headers['set-cookie'] ?? '', 'du_admin');
    expect(c).toContain('du_admin=;');
    expect(c).toContain('Max-Age=0');
    expect(c).toContain('Secure');
    // unproven under enforcement: the sweep still rides out (never a 503 on logout)
    const sweep = await dispatchShellRequestAsync(
      mkReq('POST', '/admin/logout', { forwardedProto: 'http' }), cfg);
    expect(sweep.response.status).toBe(302);
    const c2 = cookieSegment(sweep.response.headers['set-cookie'] ?? '', 'du_admin');
    expect(c2).toContain('du_admin=;');
    expect(c2).not.toContain('Secure');
  });
});

// Loopback connect blackholes (SYN dropped on a fresh OS-chosen port) hit
// this host intermittently under fleet load: fetch failed with NOTHING
// delivered to the server, so a bounded retry cannot double-count events
// or mints. Assertions stay exactly as strong — only the transport is
// retried. (Observed twice in W-SEC-AUDIT-TAXONOMY-1 evidence runs.)
async function postLoginWithConnectRetry(
  url: string,
  headers: Record<string, string>,
  body: string
): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await fetch(url + '/admin/login', {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
        body,
        redirect: 'manual',
      });
    } catch (err) {
      lastErr = err;
      await new Promise((r) => { setTimeout(r, 250); });
    }
  }
  throw lastErr;
}

describe('W-SEC-COOKIE-CONFIG-1 through the REAL shell listener (loopback socket, offline)', () => {
  const savedEnv = {
    t: process.env.DU_ADMIN_TRUST_PROXY_PROTOCOL,
    s: process.env.DU_ADMIN_COOKIE_SECURE,
    n: process.env.NODE_ENV,
  };
  beforeEach(() => {
    // the mount default reads process.env at creation time: pin it clean
    delete process.env.DU_ADMIN_TRUST_PROXY_PROTOCOL;
    delete process.env.DU_ADMIN_COOKIE_SECURE;
  });
  afterAll(() => {
    if (savedEnv.t === undefined) delete process.env.DU_ADMIN_TRUST_PROXY_PROTOCOL;
    else process.env.DU_ADMIN_TRUST_PROXY_PROTOCOL = savedEnv.t;
    if (savedEnv.s === undefined) delete process.env.DU_ADMIN_COOKIE_SECURE;
    else process.env.DU_ADMIN_COOKIE_SECURE = savedEnv.s;
    if (savedEnv.n === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = savedEnv.n;
  });

  async function loginOverSocket(
    headers: Record<string, string>,
    cookiePolicy?: ShellRuntimeConfig['cookiePolicy'],
  ): Promise<string> {
    const server = createAdminShellServer({ port: 0, cookieSecret: COOKIE_SECRET, adminToken: 'at', cookiePolicy });
    await server.listen();
    try {
      const res = await postLoginWithConnectRetry(server.url, headers, 'token=at');
      return res.headers.get('set-cookie') ?? '';
    } finally {
      await server.close();
    }
  }

  it('cookiePolicy override reaches the mint through the socket: x-forwarded-proto https -> Secure', async () => {
    const c = cookieSegment(await loginOverSocket({ 'x-forwarded-proto': 'https' }, { trustProxyProtocol: true, requireSecure: false }), 'du_admin');
    expect(c).toContain('Secure');
  });

  it('a comma chain over the wire proves nothing: no Secure in auto mode', async () => {
    const c = cookieSegment(await loginOverSocket({ 'x-forwarded-proto': 'https, http' }, { trustProxyProtocol: true, requireSecure: false }), 'du_admin');
    expect(c).not.toContain('Secure');
  });

  it('mount default with the knobs unset: env parses to {false,false} -> legacy mint, no Secure', async () => {
    const c = cookieSegment(await loginOverSocket({ 'x-forwarded-proto': 'https' }), 'du_admin');
    expect(c).not.toContain('Secure');
  });
});

// ---------------------------------------------------------------------------
// W-SEC-AUDIT-TAXONOMY-1: structured security events on the admin planes.
// The taxonomy is CLOSED (fixed kinds + enum reasons + server-side path
// context only) so NO submitted credential has a field to land in — every
// denial leg below plants a sentinel value and greps the serialized events
// for it. Wire shapes are byte-for-byte unchanged: the sink is an
// observer, never a decider (the denial/emit ordering is pinned).
// ---------------------------------------------------------------------------

function captureSink(): { events: AdminSecurityEvent[]; sink: AdminSecurityAuditSink } {
  const events: AdminSecurityEvent[] = [];
  return { events, sink: (e) => { events.push(e); } };
}

describe('W-SEC-AUDIT-TAXONOMY-1 login + TLS denials on the legacy plane', () => {
  it('auth.login_failed: exactly one closed event, NEVER the rejected token (sentinel)', async () => {
    const { events, sink } = captureSink();
    const cfg = legacyConfig();
    cfg.securityAudit = sink;
    const res = await legacyLogin(cfg, undefined, 'SENTINEL-TOKEN-LEAK-9999');
    expect(res.status).toBe(401);
    expect(events).toEqual([
      { kind: 'auth.login_failed', reason: 'invalid_token', method: 'POST', pathname: '/admin/login' },
    ]);
    const s = JSON.stringify(events);
    expect(s).not.toContain('SENTINEL-TOKEN-LEAK-9999');
  });

  it('no sink wired: the 401 answer stays byte-for-byte (emit is non-invasive)', async () => {
    const res = await legacyLogin(legacyConfig(), undefined, 'wrong');
    expect(res.status).toBe(401);
    expect(res.body).toContain('Invalid token.');
    expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
  });

  it('auth.tls_required: a validated credential denied mints audits once; secret + accepted token never ride it', async () => {
    const { events, sink } = captureSink();
    const cfg: ShellRuntimeConfig = {
      cookieSecret: 'SENTINEL-SECRET-LEAK-8888',
      adminToken: 'SENTINEL-ADMIN-LEAK-7777',
      nowMs: () => T0,
      cookiePolicy: { trustProxyProtocol: true, requireSecure: true },
      securityAudit: sink,
    };
    const res = await legacyLogin(cfg, 'http', 'SENTINEL-ADMIN-LEAK-7777');
    expect(res.status).toBe(503);
    expect(events).toEqual([
      { kind: 'auth.tls_required', reason: 'tls_unproven_under_enforcement', method: 'POST', pathname: '/admin/login' },
    ]);
    const s = JSON.stringify(events);
    expect(s).not.toContain('SENTINEL-ADMIN-LEAK-7777');
    expect(s).not.toContain('SENTINEL-SECRET-LEAK-8888');
  });

  it('denial ordering: an invalid token under requireSecure audits ONLY login_failed (tls_required unreached)', async () => {
    const { events, sink } = captureSink();
    const cfg = legacyConfig({ trustProxyProtocol: true, requireSecure: true });
    cfg.securityAudit = sink;
    const res = await legacyLogin(cfg, 'http', 'wrong');
    expect(res.status).toBe(401);
    expect(events.map((e) => e.kind)).toEqual(['auth.login_failed']);
  });

  it('a successful mint audits nothing: the taxonomy covers security EVENTS, not routine success', async () => {
    const { events, sink } = captureSink();
    const cfg = legacyConfig({ trustProxyProtocol: true, requireSecure: false });
    cfg.securityAudit = sink;
    const res = await legacyLogin(cfg, 'https');
    expect(res.status).toBe(302);
    expect(events).toEqual([]);
  });

  it('user-churned logout audits nothing: the clear is a choice, not a termination', async () => {
    const { events, sink } = captureSink();
    const cfg = legacyConfig({ trustProxyProtocol: false, requireSecure: true });
    cfg.securityAudit = sink;
    const res = (await dispatchShellRequestAsync(mkReq('POST', '/admin/logout'), cfg)).response;
    expect(res.status).toBe(302);
    expect(events).toEqual([]);
  });
});

describe('W-SEC-AUDIT-TAXONOMY-1 session termination on the OIDC gate', () => {
  it('absolute deadline -> auth.session_expired/expired_absolute, audited BEFORE the sweep; the sid never rides', async () => {
    const w = world();
    const { events, sink } = captureSink();
    w.config.securityAudit = sink;
    const sid = await w.signIn();
    w.advance(9 * 3_600_000);
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: sid } }), w.config);
    expect(res.routeId).toBe('oidc-session-gate');
    expect(res.response.status).toBe(302);
    expect(events).toEqual([
      { kind: 'auth.session_expired', reason: 'expired_absolute', method: 'GET', pathname: '/admin/businesses' },
    ]);
    expect(JSON.stringify(events)).not.toContain(sid);
  });

  it('idle window -> auth.session_expired/expired_idle (distinct reason, same wire)', async () => {
    const w = world();
    const { events, sink } = captureSink();
    w.config.securityAudit = sink;
    const sid = await w.signIn();
    w.advance(31 * 60_000);
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: sid } }), w.config);
    expect(res.response.status).toBe(302);
    expect(events).toEqual([
      { kind: 'auth.session_expired', reason: 'expired_idle', method: 'GET', pathname: '/admin/businesses' },
    ]);
  });

  it('destroyed session -> auth.session_revoked/absent_or_revoked with the identical 302 sweep', async () => {
    const w = world();
    const { events, sink } = captureSink();
    w.config.securityAudit = sink;
    const sid = await w.signIn();
    expect(await w.sessions0.destroy(sid)).toBe(true);
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: sid } }), w.config);
    expect(res.routeId).toBe('oidc-session-gate');
    expect(res.response.headers['set-cookie']).toContain('du_session=;');
    expect(events).toEqual([
      { kind: 'auth.session_revoked', reason: 'absent_or_revoked', method: 'GET', pathname: '/admin/businesses' },
    ]);
    expect(JSON.stringify(events)).not.toContain(sid);
  });

  it('forged well-formed id is audited as absent_or_revoked (one merged class, honestly)', async () => {
    const w = world();
    const { events, sink } = captureSink();
    w.config.securityAudit = sink;
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: 'F'.repeat(43) } }), w.config);
    expect(res.response.status).toBe(302);
    expect(events.map((e) => [e.kind, e.reason])).toEqual([['auth.session_revoked', 'absent_or_revoked']]);
  });

  it('an invalid-SHAPE du_session logs NOTHING: a never-lived id was not terminated (deliberate gap)', async () => {
    const w = world();
    const { events, sink } = captureSink();
    w.config.securityAudit = sink;
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: 'not-a-valid-id!' } }), w.config);
    expect(res.routeId).toBe('oidc-session-gate');
    expect(res.response.status).toBe(302);
    expect(events).toEqual([]);
  });

  it('a store WITHOUT the classify seam falls back honestly to session_revoked/absent_or_revoked', async () => {
    const w = world();
    const { events, sink } = captureSink();
    w.config.securityAudit = sink;
    w.config.oidcSessions = { get: async () => null };
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: 'x'.repeat(43) } }), w.config);
    expect(res.response.status).toBe(302);
    expect(events).toEqual([
      { kind: 'auth.session_revoked', reason: 'absent_or_revoked', method: 'GET', pathname: '/admin/businesses' },
    ]);
  });

  it('anonymous visits and dead cookies on GET /admin/login audit nothing (UX restart, not termination)', async () => {
    const w = world();
    const { events, sink } = captureSink();
    w.config.securityAudit = sink;
    const anon = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses'), w.config);
    expect(anon.response.status).toBe(302);
    const sid = await w.signIn();
    await w.sessions0.destroy(sid);
    const loginPage = await dispatchShellRequestAsync(mkReq('GET', '/admin/login', { cookies: { du_session: sid } }), w.config);
    expect(loginPage.response.status).toBe(302);
    expect((loginPage.response.headers['location'] ?? '').includes('/authorize')).toBe(true);
    expect(events).toEqual([]);
  });

  it('closed vocabulary: every event field is on the allow-list, every kind in the taxonomy', async () => {
    const { events, sink } = captureSink();
    const cfg = legacyConfig();
    cfg.securityAudit = sink;
    await legacyLogin(cfg, undefined, 'bad');
    await legacyLogin({ ...cfg, cookiePolicy: { trustProxyProtocol: true, requireSecure: true } }, 'http');
    const w = world();
    w.config.securityAudit = sink;
    const sid = await w.signIn();
    await w.sessions0.destroy(sid);
    await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses', { cookies: { du_session: sid } }), w.config);
    expect(events.length).toBe(3);
    const ALLOWED = ['kind', 'reason', 'method', 'pathname', 'action'];
    const KINDS = ['auth.login_failed', 'auth.tls_required', 'auth.session_expired', 'auth.session_revoked', 'auth.csrf_denied'];
    for (const e of events) {
      expect(Object.keys(e).filter((k) => !ALLOWED.includes(k))).toEqual([]);
      expect(KINDS).toContain(e.kind);
    }
    expect(JSON.stringify(events)).not.toContain(sid);
  });
});

describe('W-SEC-AUDIT-TAXONOMY-1 default console sink through the REAL shell listener', () => {
  it('mount default: a bad token over the socket logs exactly one parseable, sentinel-free security line', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const server = createAdminShellServer({ port: 0, cookieSecret: COOKIE_SECRET, adminToken: 'at' });
    await server.listen();
    try {
      await postLoginWithConnectRetry(server.url, {}, 'token=SENTINEL-SOCKET-LEAK-6666');
    } finally {
      await server.close();
    }
    const lines = warn.mock.calls.filter(
      (c) => typeof c[0] === 'string' && (c[0] as string).startsWith('[admin-shell] security event')
    );
    warn.mockRestore();
    expect(lines).toHaveLength(1);
    const first = lines[0];
    if (!first) throw new Error('unreachable: length was asserted 1');
    const payload = JSON.parse(String(first[1])) as AdminSecurityEvent;
    expect(payload).toEqual({ kind: 'auth.login_failed', reason: 'invalid_token', method: 'POST', pathname: '/admin/login' });
    expect(JSON.stringify(payload)).not.toContain('SENTINEL-SOCKET-LEAK-6666');
  });
});


