import { createHash, generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { createOidcClient, type FetchLike } from '../src/modules/auth/oidc-client';
import { createMemorySessionRepository, createSessionStore, isValidSessionId } from '../src/modules/auth/session-store';
import { createMemoryChallengeStore, createOidcFlow, type OidcFlowRequest, type OidcFlowSessionStore } from '../src/app/admin/oidc-flow';

/**
 * OIDC-04 offline suite: FULL login -> callback -> logout against a real-RSA
 * fake IdP and the REAL session/challenge stores. Zero sockets, zero DB.
 */

const ISS = 'http://localhost:9999/realm/du';
const CLIENT_ID = 'du-admin';
const PUBLIC_ORIGIN = 'http://localhost:2023';
const T0 = Date.UTC(2026, 8, 25, 7, 0, 0);

function b64u(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function makeKey(kid: string) {
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };
  return { kid, privateKey, jwk: { kty: 'RSA', use: 'sig' as const, alg: 'RS256', kid, n: jwk.n, e: jwk.e } };
}
type Key = ReturnType<typeof makeKey>;

function signIdToken(key: Key, payload: Record<string, unknown>): string {
  const h = b64u(Buffer.from(JSON.stringify({ alg: 'RS256', kid: key.kid, typ: 'JWT' }), 'utf8'));
  const p = b64u(Buffer.from(JSON.stringify(payload), 'utf8'));
  const sig = cryptoSign('RSA-SHA256', Buffer.from(h + '.' + p, 'ascii'), key.privateKey);
  return h + '.' + p + '.' + b64u(sig);
}

function harness() {
  let nowMs = T0;
  const goodKey = makeKey('kid-a');
  const rogueKey = makeKey('kid-rogue');
  const st = {
    created: [] as Array<{ role: string; tenantId: string | null; sub: string }>,
    destroyed: [] as string[],
    lastTokenForm: null as URLSearchParams | null,
    pendingNonce: 'no-nonce',
    overrides: {} as Record<string, unknown>,
    key: goodKey,
    failToken: false,
    omitIdToken: false,
  };
  const sessions0 = createSessionStore({ repo: createMemorySessionRepository(), now: () => nowMs });
  const sessions: OidcFlowSessionStore = {
    async create(identity) {
      const rec = await sessions0.create(identity);
      st.created.push({ role: identity.role, tenantId: identity.tenantId ?? null, sub: identity.sub });
      return rec;
    },
    get: (id) => sessions0.get(id),
    async destroy(id) {
      st.destroyed.push(id);
      return sessions0.destroy(id);
    },
  };
  const fetchImpl: FetchLike = async (url, init) => {
    const json = (obj: unknown, ok = true, status = 200) => ({ status, ok, json: async () => obj });
    if (url.endsWith('/.well-known/openid-configuration')) {
      return json({ issuer: ISS, jwks_uri: ISS + '/jwks', authorization_endpoint: ISS + '/authorize', token_endpoint: ISS + '/token' });
    }
    if (url.endsWith('/jwks')) return json({ keys: [goodKey.jwk] });
    if (url.endsWith('/token') && init.method === 'POST') {
      if (st.failToken) return json({ error: 'server_error' }, false, 500);
      const form = new URLSearchParams(init.body ?? '');
      st.lastTokenForm = form;
      if (st.omitIdToken) return json({ access_token: 'x' });
      const nowSec = Math.floor(nowMs / 1000);
      const payload = { iss: ISS, aud: CLIENT_ID, sub: 'user-1', iat: nowSec, exp: nowSec + 300, nonce: st.pendingNonce, platformAdmin: true, ...st.overrides };
      return json({ id_token: signIdToken(st.key, payload), token_type: 'Bearer' });
    }
    return json({}, false, 404);
  };
  const client = createOidcClient(
    { issuer: ISS, clientId: CLIENT_ID, clientSecret: 'sec', redirectUri: PUBLIC_ORIGIN + '/admin/oidc/callback', allowedIssuers: [ISS] },
    { fetchImpl, now: () => nowMs }
  );
  const flow = createOidcFlow({ client, sessions, challenges: createMemoryChallengeStore(() => nowMs), publicOrigin: PUBLIC_ORIGIN, now: () => nowMs });
  return {
    flow,
    st,
    rogueKey,
    sessions0,
    advance: (ms: number) => {
      nowMs += ms;
    },
    async login(query: Record<string, string> = {}) {
      const res = await flow.handleLogin({ method: 'GET', path: '/admin/login', query, cookies: {} });
      expect(res.status).toBe(302);
      const url = new URL(res.headers['location'] ?? '');
      st.pendingNonce = url.searchParams.get('nonce') ?? 'no-nonce';
      return url;
    },
  };
}
type H = ReturnType<typeof harness>;

function req(query: Record<string, string | undefined> = {}, cookies: Record<string, string> = {}): OidcFlowRequest {
  return { method: 'GET', path: '/admin/oidc/callback', query, cookies };
}

async function startLogin(h: H): Promise<{ state: string; challenge: string }> {
  const url = await h.login();
  return { state: url.searchParams.get('state') ?? '', challenge: url.searchParams.get('code_challenge') ?? '' };
}

describe('OIDC-04 login', () => {
  it('302 to the IdP with PKCE S256; fresh state/nonce each time; verifier never on the URL', async () => {
    const h = harness();
    const url = await h.login();
    expect(url.origin + url.pathname).toBe(ISS + '/authorize');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    const state = url.searchParams.get('state') ?? '';
    const nonce = url.searchParams.get('nonce') ?? '';
    expect(state.length).toBeGreaterThanOrEqual(43);
    expect(nonce).not.toBe(state);
    expect(url.searchParams.get('code_verifier')).toBeNull();
    expect((await h.login()).searchParams.get('state')).not.toBe(state);
  });
});

describe('OIDC-04 callback happy path', () => {
  it('exchanges with the stored verifier (S256-bound), mints opaque session, sets cookie, -> /admin', async () => {
    const h = harness();
    const { state, challenge } = await startLogin(h);
    const res = await h.flow.handleCallback(req({ code: 'c-1', state }));
    expect(res.status).toBe(302);
    expect(res.headers['location']).toBe('/admin');
    const verifier = h.st.lastTokenForm?.get('code_verifier') ?? '';
    expect(verifier.length).toBeGreaterThan(0);
    expect(b64u(createHash('sha256').update(verifier, 'ascii').digest())).toBe(challenge);
    expect(h.st.lastTokenForm?.get('grant_type')).toBe('authorization_code');
    const cookie = res.headers['set-cookie'] ?? '';
    expect(cookie).toMatch(/^du_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).not.toContain('Secure');
    expect(h.st.created).toEqual([{ role: 'admin', tenantId: null, sub: 'user-1' }]);
  });
  it('tenant claims -> operator session; multi-tenant/absent -> viewer (default deny)', async () => {
    const h = harness();
    h.st.overrides = { platformAdmin: undefined, tenantIds: ['ten-a'] };
    await h.flow.handleCallback(req({ code: 'c', state: (await startLogin(h)).state }));
    expect(h.st.created[0]).toEqual({ role: 'operator', tenantId: 'ten-a', sub: 'user-1' });
    const h2 = harness();
    h2.st.overrides = { platformAdmin: undefined, tenantIds: ['a', 'b'] };
    expect((await h2.flow.handleCallback(req({ code: 'c', state: (await startLogin(h2)).state }))).status).toBe(302);
    expect(h2.st.created[0]!.role).toBe('viewer');
  });
  it('returnTo: safe path preserved, open-redirect shapes collapse to /admin', async () => {
    const h = harness();
    const state = (await h.login({ returnTo: '/admin/operations?operationId=op42' })).searchParams.get('state') ?? '';
    expect((await h.flow.handleCallback(req({ code: 'c', state }))).headers['location']).toBe('/admin/operations?operationId=op42');
    for (const evil of ['//evil.example', 'https://evil.example', '/admin\\evil', '/ad%2fmin', '']) {
      expect(h.flow.sanitizeReturnTo(evil)).toBe('/admin');
    }
    expect(h.flow.sanitizeReturnTo('/admin/businesses')).toBe('/admin/businesses');
  });
});

describe('OIDC-04 hostile callbacks fail closed', () => {
  it('unknown/missing/replayed/expired state + IdP error -> ONE 403 shape, no cookie', async () => {
    const h = harness();
    const { state } = await startLogin(h);
    const denied = async (query: Record<string, string | undefined>) => {
      const r = await h.flow.handleCallback(req(query));
      expect(r.status).toBe(403);
      expect(r.headers['set-cookie']).toBeUndefined();
    };
    await denied({ code: 'c', state: 'x'.repeat(43) });
    await denied({ code: 'c' });
    await denied({ state });
    await denied({ code: 'c', error: 'access_denied', state });
    expect((await h.flow.handleCallback(req({ code: 'c', state }))).status).toBe(302);
    await denied({ code: 'c', state });
    const s2 = (await startLogin(h)).state;
    h.advance(11 * 60_000);
    await denied({ code: 'c', state: s2 });
    expect(h.st.created).toHaveLength(1);
  });
  it('bad signature / wrong nonce / missing id_token / upstream 500 -> 403, zero sessions', async () => {
    const mk = async (mut: (h: H) => void) => {
      const h = harness();
      const s = (await startLogin(h)).state;
      mut(h);
      const r = await h.flow.handleCallback(req({ code: 'c', state: s }));
      expect(r.status).toBe(403);
      expect(r.headers['set-cookie']).toBeUndefined();
      expect(h.st.created).toHaveLength(0);
    };
    await mk((h) => {
      h.st.key = h.rogueKey;
    });
    await mk((h) => {
      h.st.pendingNonce = 'wrong-nonce';
    });
    await mk((h) => {
      h.st.omitIdToken = true;
    });
    await mk((h) => {
      h.st.failToken = true;
    });
  });
});

describe('OIDC-04 logout', () => {
  it('destroys the live session and clears the cookie; anonymous logout is harmless', async () => {
    const h = harness();
    const { state } = await startLogin(h);
    const res = await h.flow.handleCallback(req({ code: 'c', state }));
    const sessionId = (res.headers['set-cookie'] ?? '').split('=')[1]?.split(';')[0] ?? '';
    expect(isValidSessionId(sessionId)).toBe(true);
    expect(await h.sessions0.get(sessionId)).not.toBeNull();
    const out = await h.flow.handleLogout({ method: 'POST', path: '/admin/logout', query: {}, cookies: { du_session: sessionId } });
    expect(out.status).toBe(302);
    expect(out.headers['location']).toBe('/admin/login');
    expect(out.headers['set-cookie']).toContain('du_session=;');
    expect(out.headers['set-cookie']).toContain('Max-Age=0');
    expect(await h.sessions0.get(sessionId)).toBeNull();
    expect(h.st.destroyed).toEqual([sessionId]);
    const anon = await h.flow.handleLogout({ method: 'POST', path: '/admin/logout', query: {}, cookies: {} });
    expect(anon.status).toBe(302);
    expect(anon.headers['set-cookie']).toContain('Max-Age=0');
    expect(h.st.destroyed).toHaveLength(1);
  });
});
