/**
 * auth-dispatch - extracted from shell-router.ts by CONV-12.
 *
 * Declarations moved VERBATIM: no behaviour change, no signature change.
 * Shared types and pure query helpers live in ./shell-router-shared, which imports
 * nothing from this directory, so no module here imports shell-router.ts back - the
 * split adds no cycle. shell-router.ts re-exports every moved public name, so
 * server.ts, shell-server.ts, index.ts and the tests are untouched.
 */
import type { AdminCookieClaims, AdminShellResponse } from './shell-types';
import type { AdminShellRequest } from './shell-types';
import type { OidcFlow, OidcFlowRequest, OidcFlowResponse, OidcFlowSessionStore } from './oidc-flow';
import { forwardedProtoProvesHttps } from './oidc-flow';
import { SESSION_COOKIE_NAME, verifySessionCsrf, type SessionRecord } from '../../modules/auth/session-store';
import type {
  AdminSecurityAuditSink,
  AdminSecurityEventKind,
  AdminSessionDeadReason,
} from '../../modules/admin-actions/rbac';
import {
  buildSetCookieHeader,
  parseCookieHeader,
  parseFormBody,
  signCookie,
  verifyCookie,
} from './shell-auth';
import {
  renderErrorPage,
  renderLoginPage,
  renderShell,
} from './shell-render';
import type { ShellRuntimeConfig } from './shell-router-shared';


// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Build the role from a bearer token. The shell accepts a token of
 * the form `role:<role>:<value>` to allow tests to exercise role
 * differentiation; otherwise the role is `admin`. A token that does
 * not equal the configured `adminToken` is rejected (401 HTML).
 *
 * Pure: no DB, no Redis.
 */
export function deriveRoleFromToken(
  adminToken: string,
  presented: string,
): { role: 'admin' | 'operator' | 'viewer' } | null {
  if (!adminToken) return null;
  if (presented === adminToken) return { role: 'admin' };
  const prefix = presented.slice(0, presented.indexOf(':'));
  const rest = presented.slice(prefix.length + 1);
  const innerColon = rest.indexOf(':');
  if (innerColon < 0) return null;
  const roleStr = rest.slice(0, innerColon);
  const value = rest.slice(innerColon + 1);
  if (value !== adminToken) return null;
  if (roleStr !== 'admin' && roleStr !== 'operator' && roleStr !== 'viewer') return null;
  return { role: roleStr };
}

/** GET /admin/login — render the login form. */
export function handleLoginGet(request: AdminShellRequest): AdminShellResponse {
  const redirect = request.body['redirect'] ?? request.cookies['redirect'] ?? '/admin';
  const csrfMarker = (request.cookies['csrf'] ?? '').slice(0, 32) || 'static';
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: renderLoginPage({ redirect, csrfMarker }),
  };
}

/** POST /admin/login — verify the bearer token, mint a cookie, redirect. */
export function handleLoginPost(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
): AdminShellResponse {
  const token = request.body['token'] ?? '';
  const redirect = request.body['redirect'] ?? '/admin';

  const roleResult = deriveRoleFromToken(config.adminToken, token);
  if (!roleResult) {
    // W-SEC-AUDIT-TAXONOMY-1: auth.login_failed with NO value field — the
    // rejected token stays in the request, never in the event.
    config.securityAudit?.({
      kind: 'auth.login_failed',
      reason: 'invalid_token',
      method: request.method,
      pathname: request.pathname,
    });
    // Re-render the form with an inline error.
    const csrfMarker = (request.cookies['csrf'] ?? '').slice(0, 32) || 'static';
    return {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderLoginPage({
        redirect,
        error: 'Invalid token.',
        csrfMarker,
      }),
    };
  }

  // W-SEC-COOKIE-CONFIG-1 (delta-27/33): a validated credential must not
  // get a session cookie this plane cannot protect. Runs AFTER the token
  // check so the unauthenticated 401 shape stays byte-identical.
  const posture = legacyCookiePosture(request, config);
  if (posture.denied) {
    // W-SEC-AUDIT-TAXONOMY-1: auth.tls_required — a VALIDATED credential
    // was denied the mint. Emitted after the login_failed branch is gone,
    // so an invalid token can never produce this event (ordering pinned).
    config.securityAudit?.({
      kind: 'auth.tls_required',
      reason: 'tls_unproven_under_enforcement',
      method: request.method,
      pathname: request.pathname,
    });
    return {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 503,
        title: 'Secure connection required',
        message:
          'This deployment enforces Secure session cookies but the request TLS could not be proven. ' +
          'Terminate TLS at a proxy that overwrites x-forwarded-proto and set DU_ADMIN_TRUST_PROXY_PROTOCOL=true.',
      }),
    };
  }

  const now = config.nowMs ? config.nowMs() : Date.now();
  const maxAge = config.cookieMaxAgeSeconds ?? 60 * 60 * 8;
  const claims = {
    iss: 'du-admin-shell',
    role: roleResult.role,
    iat: now,
    exp: now + maxAge * 1000,
  };
  const cookie = signCookie(config.cookieSecret, claims);
  if (!cookie) {
    return {
      status: 500,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 500,
        title: 'Server misconfiguration',
        message: 'The Admin shell cookie secret is not configured.',
      }),
    };
  }

  const setCookie = buildSetCookieHeader('du_admin', cookie, {
    maxAgeSeconds: maxAge,
    sameSite: 'Strict',
    httpOnly: true,
    path: '/',
    secure: posture.secure,
  });

  return {
    status: 302,
    headers: {
      'location': redirect,
      'set-cookie': setCookie,
      'content-type': 'text/html; charset=utf-8',
    },
    body: '',
  };
}

/**
 * W-SEC-COOKIE-CONFIG-1 (delta-27/33): Secure posture for the LEGACY
 * du_admin plane. Unlike the OIDC plane there is no configured public
 * origin to trust: the shell listener is plain node:http, so the ONLY
 * observable proof of client TLS is a strict single-token
 * x-forwarded-proto of https — consulted solely when the operator set
 * DU_ADMIN_TRUST_PROXY_PROTOCOL=true (same read rule as oidc-flow, same
 * fail-closed treatment of chains/http/empty). requireSecure
 * (DU_ADMIN_COOKIE_SECURE=enforce or NODE_ENV=production) turns an
 * unproven MINT into a denial: under enforcement no cookie is ever
 * downgraded to insecure. No policy wired = byte-for-byte legacy.
 */
export function legacyCookiePosture(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
): { secure: boolean; denied: boolean } {
  const policy = config.cookiePolicy;
  if (!policy) return { secure: false, denied: false };
  const proven =
    policy.trustProxyProtocol === true && forwardedProtoProvesHttps(request.forwardedProto);
  if (!proven && policy.requireSecure === true) return { secure: false, denied: true };
  return { secure: proven, denied: false };
}

/** POST /admin/logout — clear the cookie, redirect to /admin/login. The
 *  clear mirrors the mint posture (Secure when TLS proven) but NEVER
 *  denies: sweeping a stale cookie must work even when the mint path is
 *  misconfigured (the delta-26 logout rule, inherited). */
export function handleLogout(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
): AdminShellResponse {
  const posture = legacyCookiePosture(request, config);
  const setCookie = buildSetCookieHeader('du_admin', '', {
    maxAgeSeconds: 0,
    sameSite: 'Strict',
    httpOnly: true,
    path: '/',
    secure: posture.secure,
  });
  return {
    status: 302,
    headers: {
      'location': '/admin/login',
      'set-cookie': setCookie,
      'content-type': 'text/html; charset=utf-8',
    },
    body: '',
  };
}

// ---------------------------------------------------------------------------
// OIDC-04 async mount: IdP-intercepted routes, layered OVER the pure
// sync dispatcher (which stays untouched and fully backward-compatible).
// ---------------------------------------------------------------------------

export function toFlowRequest(request: AdminShellRequest): OidcFlowRequest {
  return {
    method: request.method,
    path: request.pathname,
    query: request.query ?? {},
    cookies: request.cookies,
    // W-SEC-OIDC04-PROXY-1: transport only. The Strict check + trust opt-in
    // live in oidc-flow; omitting the key when absent keeps every existing
    // flow call byte-identical.
    ...(typeof request.forwardedProto === 'string' ? { forwardedProto: request.forwardedProto } : {}),
  };
}

export function joinSetCookie(a: string | undefined, b: string | undefined): string | undefined {
  if (a && b) return a + ', ' + b;
  return a ?? b;
}

/**
 * Async entry the shell server uses. With `config.oidcFlow` wired:
 *  - GET|POST /admin/login      -> 302 to the IdP (local password POST is
 *    intercepted too: a mounted flow means the self-contained path must
 *    not stay reachable).
 *  - GET /admin/oidc/callback   -> exchange, mint session, set du_session.
 *  - POST /admin/logout         -> destroy the session AND still clear the
 *    legacy du_admin cookie (both clears ride one Set-Cookie join).
 * Everything else falls through to the pure dispatchShellRequest.
 */
export type OpaqueSessionOutcome =
  | { state: 'live'; claims: AdminCookieClaims; csrfToken: string }
  | { state: 'dead'; reason: AdminSessionDeadReason }
  | { state: 'none' };

/**
 * W-SEC-AUDIT-TAXONOMY-1: resolve du_session ONCE while keeping the honest
 * dead-reason for the server-side audit. store.classify (when present) is
 * read-only — no eviction, no touch — so an absolute-deadline death is
 * reported EXPIRED before a destructive get() would erase the evidence.
 * Stores without the classifier collapse to the merged absent_or_revoked
 * reason (they genuinely cannot tell the two apart). The wire still never
 * branches on the reason: SEC-02 one-null-path stays intact.
 */
export async function resolveOpaqueSession(
  config: ShellRuntimeConfig,
  request: AdminShellRequest
): Promise<OpaqueSessionOutcome> {
  const store = config.oidcSessions;
  const sessionId = request.cookies[SESSION_COOKIE_NAME];
  if (!store || typeof sessionId !== 'string' || sessionId.length === 0) return { state: 'none' };
  if (store.classify) {
    const reason = await store.classify(sessionId);
    if (reason !== 'live') return { state: 'dead', reason };
  }
  const rec = await store.get(sessionId);
  if (!rec) return { state: 'dead', reason: 'absent_or_revoked' };
  // The sync handlers only ever read claims.role for the guard; TTL is
  // enforced by the store itself (dead/revoked => get() returns null).
  // W-ENC-08-CSRF-OIDC (Delta 113): the session's server-side csrfToken
  // rides along so the crypto-config gate verifies the SAME proof the session
  // plane minted, instead of a legacy du_admin-derived one.
  const nowSec = Math.floor(Date.now() / 1000);
  return {
    state: 'live',
    csrfToken: rec.csrfToken,
    claims: {
      iss: 'du-admin-shell',
      role: rec.role,
      iat: nowSec,
      exp: nowSec,
    },
  };
}

export async function liveSessionClaims(
  config: ShellRuntimeConfig,
  request: AdminShellRequest
): Promise<AdminCookieClaims | null> {
  const outcome = await resolveOpaqueSession(config, request);
  return outcome.state === 'live' ? outcome.claims : null;
}

/** expired_* reasons end a session the store HELD; absent_or_revoked means
 *  a shape-valid id has no record (destroy / admin revoke / backend TTL
 *  eviction). invalid_shape never lived — deliberately NOT a termination
 *  event, and the taxonomy does not pretend otherwise. Returning the
 *  narrowed pair (not just the kind) keeps the event's reason enum closed. */
export function sessionAuditEventFor(
  reason: AdminSessionDeadReason
): { kind: AdminSecurityEventKind; reason: 'expired_absolute' | 'expired_idle' | 'absent_or_revoked' } | undefined {
  if (reason === 'expired_absolute' || reason === 'expired_idle') return { kind: 'auth.session_expired', reason };
  if (reason === 'absent_or_revoked') return { kind: 'auth.session_revoked', reason };
  return undefined;
}
