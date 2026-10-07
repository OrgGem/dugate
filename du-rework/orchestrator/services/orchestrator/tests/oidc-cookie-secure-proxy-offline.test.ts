import { generateKeyPairSync, sign as cryptoSign } from 'node:crypto';
import { createOidcClient, type FetchLike } from '../src/modules/auth/oidc-client';
import { createMemorySessionRepository, createSessionStore } from '../src/modules/auth/session-store';
import {
  createMemoryChallengeStore,
  createOidcFlow,
  forwardedProtoProvesHttps,
} from '../src/app/admin/oidc-flow';
import { dispatchShellRequestAsync, type ShellRuntimeConfig } from '../src/app/admin/shell-router';
import type { AdminShellRequest } from '../src/app/admin/shell-types';

/**
 * W-SEC-OIDC04-PROXY-1 (delta-26/delta-27) offline suite: the Secure flag
 * behind a TLS-terminating reverse proxy. Drives the MOUNTED router
 * (shell-server transports x-forwarded-proto -> AdminShellRequest ->
 * toFlowRequest -> oidc-flow posture check), so the proof covers the
 * WHOLE chain the packet targets, not just the pure function.
 *
 * Contract pinned here:
 *  - x-forwarded-proto is consulted ONLY when the operator opted in
 *    (trustProxyProtocol). An opt-out deployment ignores the header
 *    entirely: a forged 'https' can neither upgrade nor downgrade.
 *  - requireSecure (production / enforce) + TLS unproven = DENY BEFORE
 *    the exchange: no session, no Set-Cookie, challenge unconsumed,
 *    denial indistinguishable from a hostile callback.
 *  - the flag can only be RAISED by a trusted proxy (config http + XFP
 *    https mints Secure), NEVER lowered: config https keeps Secure even
 *    when a downgrade-attempting XFP says http.
 * Zero sockets, zero DB, real stores, real RSA signing through an
 * injected fetch — matching the lane's real-seam convention.
 */

const ISS = 'http://localhost:9999/realm/du';
const T0 = Date.UTC(2026, 8, 26, 3, 0, 0);
const COOKIE_SECRET = 'sec-abcdef-0123456789';
const ORIGIN_HTTP = 'http://localhost:2023';
const ORIGIN_HTTPS = 'https://admin.example.test';

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

/** Split a joined Set-Cookie header (router logout merges two). */
function cookieSegment(header: string, name: string): string {
  return header.split(', ').find((p) => p.startsWith(name + '=')) ?? '';
}

interface WorldOptions {
  publicOrigin?: string;
  trustProxyProtocol?: boolean;
  requireSecure?: boolean;
}

function world(options: WorldOptions = {}) {
  const publicOrigin = options.publicOrigin ?? ORIGIN_HTTP;
  let nowMs = T0;
  const key = makeKey('kid-P');
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
        iss: ISS, aud: 'du-admin', sub: 'proxysub', iat: nowSec, exp: nowSec + 300, nonce: pending.nonce, platformAdmin: true,
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
  const sessions = createSessionStore({ repo: createMemorySessionRepository(), now: () => nowMs });
  const challenges = createMemoryChallengeStore(() => nowMs);
  const flow = createOidcFlow({
    client,
    sessions,
    challenges,
    publicOrigin,
    now: () => nowMs,
    cookie: {
      trustProxyProtocol: options.trustProxyProtocol === true,
      requireSecure: options.requireSecure === true,
    },
  });
  const config: ShellRuntimeConfig = {
    cookieSecret: COOKIE_SECRET,
    adminToken: 'at',
    oidcFlow: flow,
    oidcSessions: sessions,
  };
  /** Start the flow through the router; returns the live state + challenge count. */
  async function startLogin(): Promise<string> {
    const login = await dispatchShellRequestAsync(mkReq('GET', '/admin/login'), config);
    const url = new URL(login.response.headers['location'] ?? '');
    pending.nonce = url.searchParams.get('nonce') ?? 'n0';
    return url.searchParams.get('state') ?? '';
  }
  /** Full login then callback with a given (or absent) forwarded proto. */
  async function callbackWith(forwardedProto?: string) {
    const state = await startLogin();
    const extra: Partial<AdminShellRequest> = { query: { code: 'c', state } };
    if (forwardedProto !== undefined) extra.forwardedProto = forwardedProto;
    const res = await dispatchShellRequestAsync(mkReq('GET', '/admin/oidc/callback', extra), config);
    return { res, state };
  }
  return { config, sessions, challenges, flow, startLogin, callbackWith, advance: (ms: number) => { nowMs += ms; } };
}

describe('strict x-forwarded-proto single-token check (pure)', () => {
  it('accepts exactly one https token, case/trim tolerant', () => {
    expect(forwardedProtoProvesHttps('https')).toBe(true);
    expect(forwardedProtoProvesHttps('HTTPS')).toBe(true);
    expect(forwardedProtoProvesHttps('  https  ')).toBe(true);
  });
  it('everything else proves nothing: http, chains, empties, junk, absent', () => {
    for (const raw of ['http', 'HTTPS, http', 'https,https', '', '   ', 'https:', 'javascript:https', 'http://x/']) {
      expect(forwardedProtoProvesHttps(raw)).toBe(false);
    }
    expect(forwardedProtoProvesHttps(undefined)).toBe(false);
  });
});

describe('TLS-terminating proxy: enforcement through the mounted router', () => {
  it('requireSecure + trust + XFP https mints a fully-guarded Secure cookie on an http origin', async () => {
    const w = world({ trustProxyProtocol: true, requireSecure: true });
    const { res } = await w.callbackWith('https');
    expect(res.routeId).toBe('oidc-callback');
    expect(res.response.status).toBe(302);
    const cookie = res.response.headers['set-cookie'] ?? '';
    expect(cookie).toContain('du_session=');
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Path=/');
    expect(cookie).not.toMatch(/Max-Age=0(;|$)/);
    const sid = /du_session=([A-Za-z0-9_-]{43})/.exec(cookie)?.[1] ?? '';
    expect(sid.length).toBe(43);
    const rec = await w.sessions.get(sid);
    expect(rec).not.toBeNull();
    expect(rec!.role).toBe('admin');
  });

  it('the normalization (HTTPS with padding) satisfies the enforcement leg', async () => {
    const w = world({ trustProxyProtocol: true, requireSecure: true });
    const { res } = await w.callbackWith(' HTTPS ');
    expect(res.response.status).toBe(302);
    expect(res.response.headers['set-cookie']).toContain('Secure');
  });

  it('dev behind a proxy (no requireSecure) still UPGRADES to Secure on trusted XFP https', async () => {
    const w = world({ trustProxyProtocol: true });
    const { res } = await w.callbackWith('https');
    expect(res.response.status).toBe(302);
    expect(res.response.headers['set-cookie']).toContain('Secure');
  });

  it('trust OFF: a forged XFP https changes NOTHING (legacy dev behavior byte-for-byte)', async () => {
    const w = world();
    const { res } = await w.callbackWith('https');
    expect(res.response.status).toBe(302);
    expect(res.response.headers['set-cookie']).toContain('du_session=');
    expect(res.response.headers['set-cookie']).not.toContain('Secure');
  });

  it('https config alone proves TLS: an XFP http downgrade attempt keeps the Secure flag', async () => {
    const w = world({ publicOrigin: ORIGIN_HTTPS, trustProxyProtocol: true, requireSecure: true });
    const { res } = await w.callbackWith('http');
    expect(res.response.status).toBe(302);
    expect(res.response.headers['set-cookie']).toContain('Secure');
  });
});

describe('fail closed: unproven TLS never yields a session cookie', () => {
  async function expectCleanDeny(w: ReturnType<typeof world>, forwardedProto: string | undefined) {
    const before = w.challenges.size();
    const { res } = await w.callbackWith(forwardedProto);
    expect(res.response.status).toBe(403);
    expect(res.response.headers['set-cookie']).toBeUndefined();
    expect(res.response.body).toContain('Login could not be completed');
    // posture denial fires BEFORE the challenge consume and the IdP
    // exchange: nothing was burned, nothing was minted.
    expect(w.challenges.size()).toBe(before + 1); // the login challenge, unconsumed
  }

  it('requireSecure + trust + XFP http -> 403, no cookie, no session (no silent downgrade)', async () => {
    await expectCleanDeny(world({ trustProxyProtocol: true, requireSecure: true }), 'http');
  });

  it('requireSecure + trust + absent header -> 403 (proxy that forgot XFP cannot sneak an insecure mint)', async () => {
    await expectCleanDeny(world({ trustProxyProtocol: true, requireSecure: true }), undefined);
  });

  it('requireSecure + trust + multi-hop chain https,http -> 403 (ambiguous chain proves nothing)', async () => {
    await expectCleanDeny(world({ trustProxyProtocol: true, requireSecure: true }), 'https, http');
  });

  it('requireSecure + trust OFF + FORGED XFP https -> 403 (header forgery can never produce a mint)', async () => {
    // Defense-in-depth combo: oidc-boot refuses to even construct this
    // pairing in an enforced env; the flow denial pins it independently.
    await expectCleanDeny(world({ requireSecure: true }), 'https');
  });

  it('the posture denial is INDISTINGUISHABLE from a hostile-callback denial', async () => {
    const w = world({ trustProxyProtocol: true, requireSecure: true });
    const posture = await w.callbackWith('http'); // XFP denial (challenge left unconsumed)
    const replay = await w.callbackWith('http');
    // TLS PROVEN on this leg so it reaches the consume path: an
    // unknown-state denial, the hostile shape we must be indistinguishable
    // from. (Without forwardedProto it would only re-test the posture leg.)
    const forgedState = await dispatchShellRequestAsync(
      mkReq('GET', '/admin/oidc/callback', { query: { code: 'c', state: 'x'.repeat(43) }, forwardedProto: 'https' }),
      w.config
    );
    expect(posture.res.response.status).toBe(forgedState.response.status);
    expect(posture.res.response.body).toBe(forgedState.response.body);
    expect(posture.res.response.headers['content-type']).toBe(forgedState.response.headers['content-type']);
    expect(replay.res.response.status).toBe(403);
  });
});

describe('logout posture: sweep always rides through, flag mirrors the proof', () => {
  it('insecure-attempted logout still clears and destroys; trusted logout clears WITH Secure', async () => {
    const w = world({ trustProxyProtocol: true, requireSecure: true });
    const { res } = await w.callbackWith('https');
    const sid = /du_session=([A-Za-z0-9_-]{43})/.exec(res.response.headers['set-cookie'] ?? '')?.[1] ?? '';
    expect(sid.length).toBe(43);
    // XFP says http (mixed protocol): logout must NOT deny-trap the user...
    const down = await dispatchShellRequestAsync(mkReq('POST', '/admin/logout', { cookies: { du_session: sid }, forwardedProto: 'http' }), w.config);
    expect(down.response.status).toBe(302);
    expect(down.routeId).toBe('admin-logout');
    const clear = cookieSegment(down.response.headers['set-cookie'] ?? '', 'du_session');
    expect(clear).toContain('du_session=;');
    expect(clear).toContain('Max-Age=0');
    expect(await w.sessions.get(sid)).toBeNull();
    // ...and the trusted leg clears WITH the Secure attribute.
    const { res: res2 } = await w.callbackWith('https');
    const sid2 = /du_session=([A-Za-z0-9_-]{43})/.exec(res2.response.headers['set-cookie'] ?? '')?.[1] ?? '';
    const up = await dispatchShellRequestAsync(mkReq('POST', '/admin/logout', { cookies: { du_session: sid2 }, forwardedProto: 'https' }), w.config);
    const clear2 = cookieSegment(up.response.headers['set-cookie'] ?? '', 'du_session');
    expect(clear2).toContain('Max-Age=0');
    expect(clear2).toContain('Secure');
  });
});
