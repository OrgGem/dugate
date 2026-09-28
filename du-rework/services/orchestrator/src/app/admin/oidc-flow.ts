import { randomBytes } from 'node:crypto';
import { buildSessionClearCookie, buildSessionCookie, SESSION_COOKIE_NAME, isValidSessionId, type SessionRecord } from '../../modules/auth/session-store';
import { createPkcePair, type OidcClient, type VerifiedToken } from '../../modules/auth/oidc-client';

/**
 * OIDC-04 — the Authorization-Code + PKCE login flow for the Admin
 * shell, as PURE handlers over injected seams (OidcClient SEC-01,
 * session store OIDC-02, a one-shot challenge store). The shell lane
 * mounts handleLogin/handleCallback/handleLogout into its router; this
 * module never touches HTTP objects, the repository, or shell-router,
 * so the WHOLE flow (happy + hostile) is testable offline — matching
 * the SEC-04 acceptance that role/CSRF/expiry are SERVER checks, not
 * DOM behavior.
 *
 * Threat decisions encoded here:
 *  - state/nonce/code_verifier live SERVER-SIDE in the challenge store,
 *    bound to the state (the only value the browser round-trips).
 *    consume() is one-shot: mismatch, unknown, re-use, or a dead clock
 *    are ONE indistinguishable denial (no replay oracle).
 *  - the post-login target is sanitized to same-origin, non-root,
 *    non-'//' paths; anything else (absolute URL, protocol-relative,
 *    backslash/control char, encoded dot-segments) collapses to the
 *    fixed '/admin' default — open redirect is impossible by
 *    construction, not by blocklist.
 *  - session identity comes from VERIFIED id_token claims only; role
 *  mapping is default-deny (viewer) — an unexpected claims shape
 *  mints a session that can mutate NOTHING, and multi-tenant claims
 *  refuse mint outright (the store's operator-needs-one-tenant rule).
 *  - logout destroys the server-side session and clears the cookie;
 *    a forged/absent cookie id still returns the cleared-cookie page
 *    (idempotent, no info leak).
 *  - W-SEC-OIDC04-PROXY-1 (delta-26): behind a TLS-terminating proxy the
 *    Secure flag no longer depends on the configured origin ALONE.
 *    x-forwarded-proto is consulted only when the operator opts in;
 *    requireSecure (production or explicit enforce) denies a callback
 *    whose TLS is unproven instead of silently minting an insecure cookie.
 *    See the cookie policy on OidcFlowOptions.
 */

export interface OidcFlowRequest {
  method: string;
  path: string;
  /** parsed query params (adapter's job) */
  query: Record<string, string | undefined>;
  cookies: Record<string, string>;
  /**
   * W-SEC-OIDC04-PROXY-1: the raw x-forwarded-proto value captured at the
   * HTTP boundary by the adapter. NEVER consulted unless the operator
   * opted in via the cookie policy below — a directly-exposed server
   * treats it as absent. Multi-hop chains ride through verbatim so the
   * strict single-token check can fail them closed.
   */
  forwardedProto?: string;
}

export interface OidcFlowResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export interface FlowChallenge {
  verifier: string;
  nonce: string;
  returnTo: string;
  expiresAt: number;
}

/** One-shot, TTL-bound. getAndDelete must be atomic in distributed
 *  implementations (Redis GETDEL / DB delete-returning-row). */
export interface OidcChallengeStore {
  put(state: string, challenge: FlowChallenge): Promise<void>;
  consume(state: string): Promise<FlowChallenge | null>;
}

export interface OidcFlowSessionStore {
  create(identity: { issuer: string; sub: string; tenantId?: string | null; role: 'admin' | 'operator' | 'viewer' }): Promise<SessionRecord>;
  get(sessionId: string): Promise<SessionRecord | null>;
  destroy(sessionId: string): Promise<boolean>;
}

export interface OidcFlowOptions {
  client: OidcClient;
  sessions: OidcFlowSessionStore;
  challenges: OidcChallengeStore;
  /** fixed public shell origin (SEC-04) — the BASELINE Secure posture */
  publicOrigin: string;
  /**
   * Delta-26 cookie policy, computed once by oidc-boot from DU_ADMIN_* env:
   *  - trustProxyProtocol: consult x-forwarded-proto. True only when the
   *    deployment sits behind a TLS-terminating proxy that OVERWRITES the
   *    header with its own scheme, so client-supplied values never reach
   *    this leg.
   *  - requireSecure: production/enforce mode. A callback whose TLS cannot
   *    be PROVEN is denied before the exchange: this plane cannot mint an
   *    insecure du_session, and header forgery cannot trick it into one.
   * Both default false — a deployment that sets nothing decides the flag
   * from the configured origin alone, byte-for-byte as before.
   */
  cookie?: { trustProxyProtocol?: boolean; requireSecure?: boolean };
  now?: () => number;
  challengeTtlMs?: number;
}

const DEFAULT_RETURN = '/admin';
const HOUR = 3_600_000;

function newToken(): string {
  return randomBytes(32).toString('base64').replace(/\+/g, '-').replace(/\//g, '_');
}

function safeReturnTo(raw: string | undefined): string {
  // Allowlist, not blocklist: same-origin path, no scheme, no authority,
  // no encoded anything, no dot segments. Anything else -> fixed default.
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 200) return DEFAULT_RETURN;
  if (!/^\/[A-Za-z0-9/_?=&#-]*$/.test(raw)) return DEFAULT_RETURN;
  if (raw.startsWith('//')) return DEFAULT_RETURN;
  if (raw.includes('..')) return DEFAULT_RETURN;
  return raw;
}

function roleFor(claims: VerifiedToken): { role: 'admin' | 'operator' | 'viewer'; tenantId: string | null } {
  if (claims.claims.platformAdmin === true) return { role: 'admin', tenantId: null };
  const t = claims.claims.tenantIds;
  if (Array.isArray(t) && t.length === 1 && typeof t[0] === 'string' && t[0].length > 0) {
    return { role: 'operator', tenantId: t[0] };
  }
  return { role: 'viewer', tenantId: null }; // DEFAULT DENY
}

/**
 * Strict single-token proof that the TLS-terminating proxy saw an https
 * client leg. Deliberately minimal: trim + casefold ONLY. A comma means a
 * proxy CHAIN (each hop appends) — ambiguous, so it proves nothing; any
 * other scheme, empty, or absent prove nothing. The trusted-proxy model
 * assumes the outermost proxy overwrites x-forwarded-proto with its own
 * scheme (ALB/nginx default), so a client cannot inject a lone https.
 */
export function forwardedProtoProvesHttps(raw: string | undefined): boolean {
  if (typeof raw !== 'string') return false;
  const v = raw.trim();
  if (v.length === 0 || v.includes(',')) return false;
  return v.toLowerCase() === 'https';
}

export function createOidcFlow(options: OidcFlowOptions) {
  const now = options.now ?? ((): number => Date.now());
  const challengeTtlMs = options.challengeTtlMs ?? 10 * 60_000;
  const origin = new URL(options.publicOrigin); // constructor throws on garbage config
  const configSecure = origin.protocol === 'https:';
  const trustProxyProtocol = options.cookie?.trustProxyProtocol === true;
  const requireSecure = options.cookie?.requireSecure === true;

  // TLS is PROVEN by the configured https origin, or — only when the
  // operator explicitly wired a TLS-terminating proxy — by a STRICT
  // single-token x-forwarded-proto of https. Absent, http, multi-hop
  // chains, and forged headers (trust off = header unread) prove nothing.
  // requireSecure turns unproven into a pre-exchange DENIAL rather than a
  // silent insecure downgrade; without it the flag simply tracks the
  // proven value (a dev behind a proxy upgrades its cookie on https).
  function sessionCookiePosture(req: OidcFlowRequest): { secure: boolean; denied: boolean } {
    const proven = configSecure || (trustProxyProtocol && forwardedProtoProvesHttps(req.forwardedProto));
    if (!proven && requireSecure) return { secure: false, denied: true };
    return { secure: proven, denied: false };
  }

  function html(status: number, title: string, extra: Record<string, string> = {}): OidcFlowResponse {
    return {
      status,
      headers: { 'content-type': 'text/html; charset=utf-8', ...extra },
      body: '<!doctype html><html><body><p>' + title + '</p></body></html>',
    };
  }

  async function handleLogin(req: OidcFlowRequest): Promise<OidcFlowResponse> {
    const verifierPair = createPkcePair();
    const state = newToken();
    const nonce = newToken();
    const returnTo = safeReturnTo(req.query.returnTo);
    await options.challenges.put(state, {
      verifier: verifierPair.verifier,
      nonce,
      returnTo,
      expiresAt: now() + challengeTtlMs,
    });
    const url = await options.client.authorizationUrl({ state, nonce, codeChallenge: verifierPair.challenge });
    return {
      status: 302,
      headers: { location: url, 'cache-control': 'no-store' },
      body: '<!doctype html><html><body>Redirecting</body></html>',
    };
  }

  async function handleCallback(req: OidcFlowRequest): Promise<OidcFlowResponse> {
    // ONE denial shape for every hostile callback (unknown/replayed/expired
    // state, missing params, IdP error, bad token): 403, no session, no leak.
    const deny = html(403, 'Login could not be completed. Please sign in again.');
    // Delta-26 fail-closed FIRST, before any IdP call or challenge consume:
    // requireSecure + unproven TLS mints NOTHING — the same indistinguishable
    // denial, no Set-Cookie, no oracle into why.
    const posture = sessionCookiePosture(req);
    if (posture.denied) return deny;
    const state = req.query.state;
    const code = req.query.code;
    const idpError = req.query.error;
    if (typeof idpError === 'string' && idpError.length > 0) return deny;
    if (typeof state !== 'string' || typeof code !== 'string' || state.length === 0 || code.length === 0) {
      return deny;
    }
    const challenge = await options.challenges.consume(state);
    if (!challenge) return deny;
    if (challenge.expiresAt <= now()) return deny;
    let tokens;
    try {
      tokens = await options.client.exchangeAuthorizationCode(code, challenge.verifier, challenge.nonce);
    } catch {
      return deny;
    }
    const { role, tenantId } = roleFor(tokens.idToken);
    let session;
    try {
      session = await options.sessions.create({ issuer: tokens.idToken.iss, sub: tokens.idToken.sub, tenantId, role });
    } catch {
      return deny; // e.g. claims shape the store refuses — fail closed
    }
    return {
      status: 302,
      headers: {
        location: challenge.returnTo,
        'set-cookie': buildSessionCookie(session, { secure: posture.secure, nowMs: now() }),
        'cache-control': 'no-store',
      },
      body: '<!doctype html><html><body>Signed in</body></html>',
    };
  }

  async function handleLogout(req: OidcFlowRequest): Promise<OidcFlowResponse> {
    const sessionId = req.cookies[SESSION_COOKIE_NAME];
    if (typeof sessionId === 'string' && isValidSessionId(sessionId)) {
      await options.sessions.destroy(sessionId).catch(() => false);
    }
    // Logout NEVER denies: getting the user out must always work, whatever
    // the TLS proof says. The store-side destroy above is the security
    // effect; the flag here only mirrors the current posture.
    const posture = sessionCookiePosture(req);
    return {
      status: 302,
      headers: {
        location: '/admin/login',
        'set-cookie': buildSessionClearCookie({ secure: posture.secure }),
        'cache-control': 'no-store',
      },
      body: '<!doctype html><html><body>Signed out</body></html>',
    };
  }

  return { handleLogin, handleCallback, handleLogout, sanitizeReturnTo: safeReturnTo };
}

export type OidcFlow = ReturnType<typeof createOidcFlow>;

/** In-memory challenge store (single replica/tests). The distributed
 *  implementation MUST provide atomic getAndDelete + TTL. */
export function createMemoryChallengeStore(now: () => number = () => Date.now()): OidcChallengeStore & { size(): number } {
  const map = new Map<string, FlowChallenge>();
  return {
    async put(state, challenge) {
      map.set(state, challenge);
    },
    async consume(state) {
      const hit = map.get(state);
      if (hit === undefined) return null;
      map.delete(state);
      if (hit.expiresAt <= now()) return null;
      return hit;
    },
    size: () => map.size,
  };
}
