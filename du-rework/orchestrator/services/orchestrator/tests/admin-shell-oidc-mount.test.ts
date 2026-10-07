import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { createOidcClient, type FetchLike } from '../src/modules/auth/oidc-client';
import { createMemorySessionRepository, createSessionStore } from '../src/modules/auth/session-store';
import { createMemoryChallengeStore, createOidcFlow } from '../src/app/admin/oidc-flow';
import { dispatchShellRequest, dispatchShellRequestAsync, type ShellRuntimeConfig } from '../src/app/admin/shell-router';
import type { AdminShellRequest } from '../src/app/admin/shell-types';

/**
 * OIDC-04 MOUNT integration (offline): the three oidc-flow handlers wired
 * through dispatchShellRequestAsync on the REAL admin shell router. Zero
 * sockets/DB — dispatch is pure; the fake IdP signs with a real RSA key.
 * Regression guard: without config.oidcFlow the sync dispatcher keeps the
 * pre-OIDC behavior byte-for-byte (the whole existing shell suite depends
 * on it).
 */

const ISS = 'http://localhost:9999/realm/du';
const T0 = Date.UTC(2026, 8, 25, 8, 0, 0);

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

function world() {
  let nowMs = T0;
  const key = makeKey('kid-m');
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
        iss: ISS, aud: 'du-admin', sub: 'shell-user', iat: nowSec, exp: nowSec + 300, nonce: pending.nonce, platformAdmin: true,
      }), 'utf8'));
      const sig = cryptoSign('RSA-SHA256', Buffer.from(h + '.' + p, 'ascii'), key.privateKey);
      return json({ id_token: h + '.' + p + '.' + b64u(sig), token_type: 'Bearer' });
    }
    return json({}, false, 404);
  };
  const client = createOidcClient(
    { issuer: ISS, clientId: 'du-admin', clientSecret: 'sec', redirectUri: 'http://localhost:2023/admin/oidc/callback', allowedIssuers: [ISS] },
    { fetchImpl, now: () => nowMs }
  );
  const sessions0 = createSessionStore({ repo: createMemorySessionRepository(), now: () => nowMs });
  const flow = createOidcFlow({
    client,
    sessions: sessions0,
    challenges: createMemoryChallengeStore(() => nowMs),
    publicOrigin: 'http://localhost:2023',
    now: () => nowMs,
  });
  const config: ShellRuntimeConfig = {
    cookieSecret: 'shell-cookie-secret-0123456789',
    adminToken: 'at-shell',
    oidcFlow: flow,
  };
  async function startLogin(): Promise<{ state: string }> {
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/login'), config);
    expect(res.response.status).toBe(302);
    const url = new URL(res.response.headers['location'] ?? '');
    pending.nonce = url.searchParams.get('nonce') ?? 'n0';
    return { state: url.searchParams.get('state') ?? '' };
  }
  return { config, flow, sessions0, startLogin };
}

describe('OIDC-04 mount on the shell router', () => {
  it('GET /admin/login -> 302 IdP with PKCE (routeId oidc-login)', async () => {
    const w = world();
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/login'), w.config);
    expect(res.routeId).toBe('oidc-login');
    const url = new URL(res.response.headers['location'] ?? '');
    expect(url.origin + url.pathname).toBe(ISS + '/authorize');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('state')).toBeTruthy();
  });

  it('GET /admin/oidc/callback -> session minted, du_session cookie set, redirect /admin', async () => {
    const w = world();
    const { state } = await w.startLogin();
    const cb = await dispatchShellRequestAsync(
      mkReq('GET', '/admin/oidc/callback', { query: { code: 'c-1', state } }),
      w.config
    );
    expect(cb.routeId).toBe('oidc-callback');
    expect(cb.response.status).toBe(302);
    expect(cb.response.headers['location']).toBe('/admin');
    const cookie = cb.response.headers['set-cookie'] ?? '';
    expect(cookie).toMatch(/^du_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
  });

  it('POST /admin/logout -> BOTH cookies cleared in one header, session destroyed', async () => {
    const w = world();
    const { state } = await w.startLogin();
    const cb = await dispatchShellRequestAsync(
      mkReq('GET', '/admin/oidc/callback', { query: { code: 'c', state } }),
      w.config
    );
    const sessionId = (cb.response.headers['set-cookie'] ?? '').split('=')[1]?.split(';')[0] ?? '';
    const out = await dispatchShellRequestAsync(
      mkReq('POST', '/admin/logout', { cookies: { du_session: sessionId } }),
      w.config
    );
    expect(out.routeId).toBe('admin-logout');
    expect(out.response.status).toBe(302);
    expect(out.response.headers['location']).toBe('/admin/login');
    const cookies = out.response.headers['set-cookie'] ?? '';
    expect(cookies).toContain('du_admin=;');
    expect(cookies).toContain('du_session=;');
    expect(cookies).toContain('Max-Age=0');
    expect(await w.sessions0.get(sessionId)).toBeNull();
  });

  it('mounted flow also intercepts the LOCAL password POST (no self-contained bypass)', async () => {
    const w = world();
    const res = await dispatchShellRequestAsync(
      mkReq('POST', '/admin/login', { body: { username: 'root', password: 'anything' } }),
      w.config
    );
    expect(res.routeId).toBe('oidc-login');
    expect(res.response.headers['location'] ?? '').toContain(ISS + '/authorize');
    expect(res.response.headers['set-cookie'] ?? '').not.toContain('du_admin=');
  });

  it('other routes still pass through to the sync dispatcher (section route intact)', async () => {
    const w = world();
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/businesses'), w.config);
    expect(res.routeId).toBe('section:businesses');
  });

  it('REGRESSION: without oidcFlow the sync /admin/login form is untouched', async () => {
    const cfg: ShellRuntimeConfig = { cookieSecret: 'x'.repeat(16), adminToken: 'at' };
    const sync = dispatchShellRequest(mkReq('GET', '/admin/login'), cfg);
    const async_ = await dispatchShellRequestAsync(mkReq('GET', '/admin/login'), cfg);
    expect(sync.routeId).toBe('admin-login');
    expect(async_.response).toEqual(sync.response);
    expect(sync.response.status).toBe(200);
  });
});
