import { createHash } from 'node:crypto';
import { createOidcClient, type FetchLike } from '../src/modules/auth/oidc-client';
import { createMemorySessionRepository, createSessionStore } from '../src/modules/auth/session-store';
import {
  createMemoryChallengeStore,
  createOidcFlow,
  type FlowChallenge,
  type OidcChallengeStore,
} from '../src/app/admin/oidc-flow';
import { dispatchShellRequestAsync, type ShellRuntimeConfig } from '../src/app/admin/shell-router';
import type { AdminShellRequest } from '../src/app/admin/shell-types';
import { startMockOidcIdp, type MockOidcIdp } from './stubs/mock-oidc-idp';

/**
 * CYCLE-103 — OIDC-04 end-to-end integration harness: the REAL shell
 * router (dispatchShellRequestAsync) driving the REAL OidcClient against
 * the CYCLE-102 mock OIDC IdP over genuine loopback HTTP. This is the
 * whole browser round-trip the dispatch names, in ONE test file:
 *   1) GET /admin/login redirects to the IdP /authorize with a valid
 *      S256 PKCE challenge (proof: challenge == b64u(sha256(verifier))
 *      for the SERVER-SIDE verifier the flow stored against the state).
 *   2) The browser visits /authorize, gets a code, and the code is
 *      exchanged at /token for an id_token that the real verification
 *      path accepts (signature over the served JWKS, nonce/aud/iss).
 *   3) GET /admin/oidc/callback mints the opaque du_session cookie.
 *   4) GET /admin with that cookie answers HTTP 200 with the admin page
 *      (session claims injected — no IdP round-trip, no du_admin).
 * Zero DB, zero Redis, zero app services — only the IdP fake the row
 * needs, exactly as the OIDC-01 acceptance asked for.
 */

const SHELL_ORIGIN = 'http://localhost:2023';
const REDIRECT_URI = SHELL_ORIGIN + '/admin/oidc/callback';

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

function b64u(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function decodeJwtSegment(token: string, index: 0 | 1): Record<string, unknown> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('expected a three-segment jwt');
  return JSON.parse(Buffer.from(parts[index] ?? '', 'base64url').toString('utf8')) as Record<string, unknown>;
}

function sessionSid(setCookie: string | undefined): string {
  const m = /du_session=([A-Za-z0-9_-]{43})/.exec(setCookie ?? '');
  return m?.[1] ?? '';
}

/** Wraps the real one-shot memory store but remembers every put() so a
 *  test can prove the S256 binding from the ACTUAL server-side verifier. */
function recorderChallenges(): { store: OidcChallengeStore; captured: Map<string, FlowChallenge> } {
  const inner = createMemoryChallengeStore();
  const captured = new Map<string, FlowChallenge>();
  return {
    captured,
    store: {
      async put(state: string, challenge: FlowChallenge): Promise<void> {
        captured.set(state, challenge);
        await inner.put(state, challenge);
      },
      async consume(state: string): Promise<FlowChallenge | null> {
        return inner.consume(state);
      },
    },
  };
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
  const rec = recorderChallenges();
  const flow = createOidcFlow({
    client,
    sessions,
    challenges: rec.store,
    publicOrigin: SHELL_ORIGIN,
  });
  const config: ShellRuntimeConfig = {
    cookieSecret: 'e2e-secret-0123456789ab',
    adminToken: 'at-e2e',
    oidcFlow: flow,
    oidcSessions: sessions,
  };
  /** Step 1: ask the mounted router for the IdP redirect. */
  async function loginUrl(): Promise<URL> {
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/login'), config);
    expect(res.routeId).toBe('oidc-login');
    expect(res.response.status).toBe(302);
    return new URL(res.response.headers['location'] ?? '');
  }
  /** Browser leg: actually visit the mock IdP /authorize over HTTP. */
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
  /** Full sign-in through every seam; returns the minted session id. */
  async function signIn(): Promise<{ sid: string; login: URL }> {
    const login = await loginUrl();
    const { code, state } = await authorizeAtIdp(login);
    const cb = await callback(code, state);
    const sid = sessionSid(cb.response.headers['set-cookie']);
    if (!sid) throw new Error('callback did not mint du_session: ' + cb.response.status);
    return { sid, login };
  }
  return { config, client, sessions, loginUrl, authorizeAtIdp, callback, signIn, captured: rec.captured };
}

beforeAll(async () => {
  process.env.NO_PROXY = '127.0.0.1,localhost';
  idp = await startMockOidcIdp();
});
afterAll(async () => {
  await idp?.close();
});
beforeEach(() => idp.reset());

describe('CYCLE-103 step 1: login redirects to the mock IdP with valid PKCE', () => {
  it('GET /admin/login -> 302 IdP /authorize; challenge binds the server-side verifier (S256)', async () => {
    const w = world();
    const url = await w.loginUrl();
    expect(url.origin + url.pathname).toBe(idp.url + '/authorize');
    const q = url.searchParams;
    expect(q.get('response_type')).toBe('code');
    expect(q.get('client_id')).toBe('du-admin');
    expect(q.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(q.get('code_challenge_method')).toBe('S256');
    const challenge = q.get('code_challenge') ?? '';
    expect(challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const state = q.get('state') ?? '';
    expect(state.length).toBeGreaterThan(32);
    expect((q.get('nonce') ?? '').length).toBeGreaterThan(32);
    // Building the URL has not touched the IdP /authorize endpoint yet.
    expect(idp.lastAuthorizeParams).toBeNull();
    // PKCE proof: the redirect's challenge is exactly S256 of the verifier
    // the flow stored SERVER-SIDE against this one-shot state.
    const ch = w.captured.get(state);
    expect(ch).toBeDefined();
    expect(b64u(createHash('sha256').update(ch!.verifier, 'ascii').digest())).toBe(challenge);
    expect(ch!.nonce).toBe(q.get('nonce'));
  });
});

describe('CYCLE-103 steps 2+3: real /authorize visit, /token exchange, callback mints the session', () => {
  it('browser-through-IdP round-trip: verified id_token claims, du_session cookie, session record', async () => {
    const w = world();
    const login = await w.loginUrl();
    const { code, state } = await w.authorizeAtIdp(login);
    expect(state).toBe(login.searchParams.get('state'));
    expect(code).toMatch(/^code-/);
    expect(idp.lastAuthorizeParams?.code_challenge_method).toBe('S256');
    expect(idp.lastAuthorizeParams?.code_challenge).toBe(login.searchParams.get('code_challenge'));

    const cb = await w.callback(code, state);
    expect(cb.routeId).toBe('oidc-callback');
    expect(cb.response.status).toBe(302);
    expect(cb.response.headers['location']).toBe('/admin');

    const cookie = cb.response.headers['set-cookie'] ?? '';
    expect(cookie).toMatch(/^du_session=[A-Za-z0-9_-]{43};/);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=');

    // Step-2 proof at the provider boundary: the callback DID exchange at
    // the IdP /token endpoint and the issued id_token carries the claims
    // the REAL verification path accepted (sig over served JWKS, aud/iss/nonce).
    expect(idp.lastIssued).not.toBeNull();
    const header = decodeJwtSegment(idp.lastIssued!.idToken, 0);
    const payload = decodeJwtSegment(idp.lastIssued!.idToken, 1);
    expect(header.alg).toBe('RS256');
    expect(header.kid).toBe('mock-rs-1');
    expect(payload.iss).toBe(idp.issuer);
    expect(payload.aud).toBe('du-admin');
    expect(payload.sub).toBe('mock-user-1');
    expect(payload.nonce).toBe(login.searchParams.get('nonce'));
    expect(payload.platformAdmin).toBe(true);
    expect(typeof payload.at_hash).toBe('string');

    // Minted session = verified identity only (default-deny resolved admin
    // because of the platformAdmin claim; nothing self-declared by a header).
    const sid = sessionSid(cookie);
    const rec = await w.sessions.get(sid);
    expect(rec).not.toBeNull();
    expect(rec!.role).toBe('admin');
    expect(rec!.sub).toBe('mock-user-1');
    expect(rec!.issuer).toBe(idp.issuer);
  });

  it('ES256-signed id_token from the same IdP completes the identical round-trip', async () => {
    idp.setSigningAlg('ES256');
    const w = world();
    const { sid } = await w.signIn();
    expect(decodeJwtSegment(idp.lastIssued!.idToken, 0).alg).toBe('ES256');
    const page = await dispatchShellRequestAsync(mkReq('GET', '/admin', { cookies: { du_session: sid } }), w.config);
    expect(page.routeId).toBe('admin-root');
    expect(page.response.status).toBe(200);
  });
});

describe('CYCLE-103 step 4: the minted cookie serves the Admin console', () => {
  it('GET /admin with du_session -> HTTP 200 admin page (claims from the store, no IdP call)', async () => {
    const w = world();
    const { sid } = await w.signIn();
    const issuedAtSignIn = idp.lastIssued;
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin', { cookies: { du_session: sid } }), w.config);
    expect(res.routeId).toBe('admin-root');
    expect(res.response.status).toBe(200);
    expect(res.response.headers['content-type']).toContain('text/html');
    expect(res.response.body).toContain('<title>');
    expect(res.response.headers['location']).toBeUndefined();
    // Serving the page reads only the session store — the IdP saw no new issuance.
    expect(idp.lastIssued).toBe(issuedAtSignIn);
  });

  it('anonymous GET /admin is bounced to /admin/login (baseline before the cookie exists)', async () => {
    const w = world();
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin'), w.config);
    expect(res.routeId).toBe('oidc-session-gate');
    expect(res.response.status).toBe(302);
    expect(res.response.headers['location']).toBe('/admin/login');
    expect(res.response.headers['set-cookie'] ?? '').toContain('du_session=;');
  });
});

describe('CYCLE-103 flow hostility on the mounted path', () => {
  it('code consumed by a direct /token exchange: the later callback can only deny (403, one shape)', async () => {
    const w = world();
    const login = await w.loginUrl();
    const state = login.searchParams.get('state') ?? '';
    const ch = w.captured.get(state);
    expect(ch).toBeDefined();
    const { code } = await w.authorizeAtIdp(login);

    // Step 2 as its own component: the captured server-side verifier
    // exchanges the code at the IdP /token endpoint successfully.
    const set = await w.client.exchangeAuthorizationCode(code, ch!.verifier, ch!.nonce);
    expect(set.idToken.sub).toBe('mock-user-1');
    expect(set.idToken.nonce).toBe(ch!.nonce);
    expect(set.accessToken).not.toBeNull();

    // Same code now arrives over the browser channel: replay is dead.
    const replay = await w.callback(code, state);
    expect(replay.response.status).toBe(403);
    expect(replay.response.headers['set-cookie'] ?? '').not.toContain('du_session=');
  });

  it('callback with an unknown state -> 403 denial, no cookie minted', async () => {
    const w = world();
    const res = await w.callback('code-never-issued', 'state-never-minted');
    expect(res.response.status).toBe(403);
    expect(res.response.headers['set-cookie'] ?? '').not.toContain('du_session=');
  });
});
