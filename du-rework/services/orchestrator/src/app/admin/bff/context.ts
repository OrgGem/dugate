/**
 * BFF session context (AWEB-02).
 *
 * Resolves the browser session ONCE per request with the same precedence as
 * the rendered shell gate (auth-dispatch `resolveOpaqueSession` + the
 * cycle-101 legacy-coexistence rule):
 *   1. an opaque `du_session` (when a store is mounted) decides alone —
 *      missing/revoked → NO fallback;
 *   2. the legacy `du_admin` cookie is honored only when no `du_session`
 *      cookie is present at all;
 *   3. anything else → null (the caller answers 401).
 *
 * The principal is derived from the SERVER-side record (role/tenant), never
 * from a browser-asserted value, and the CSRF proof is computed here:
 *  - OIDC plane: the session's server-side `csrfToken`;
 *  - legacy plane: stateless HMAC over the signed cookie (deriveCsrfToken).
 */
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import {
  SESSION_COOKIE_NAME,
  verifySessionCsrf,
  type SessionRecord,
} from '../../../modules/auth/session-store';
import { deriveCsrfToken, validateCsrfToken } from '../../../modules/admin-actions/rbac';
import { verifyCookie } from '../shell-auth';

export type BffRole = 'admin' | 'operator' | 'viewer';

/** Mirror of the platform's AdminPrincipal, plus an explicit no-principal state. */
export type BffPrincipal =
  | { kind: 'platform' }
  | { kind: 'tenant_operator'; tenantId: string }
  | { kind: 'unscoped' };

export interface BffContext {
  /** Which auth plane resolved the session cookie. */
  plane: 'oidc' | 'legacy';
  role: BffRole;
  /** Stored tenant for opaque sessions; legacy token sessions carry none. */
  tenantId: string | null;
  /** Server-side CSRF proof the browser must echo in `x-csrf-token`. */
  csrfToken: string;
  principal: BffPrincipal;
  displayName: string;
  /** Constant-time verification of the browser's `x-csrf-token`. */
  verifyCsrf(provided: string | undefined): boolean;
}

export async function resolveBffContext(
  config: ShellRuntimeConfig,
  request: AdminShellRequest,
): Promise<BffContext | null> {
  const legacyCookie = request.cookies['du_admin'];
  if (config.oidcSessions) {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (typeof sessionId === 'string' && sessionId.length > 0) {
      // SEC-02: once a session id rides the request the session plane decides
      // — no silent downgrade to the legacy cookie.
      const record = await config.oidcSessions.get(sessionId);
      if (!record) return null;
      const tenantId = record.tenantId;
      const csrfToken = record.csrfToken;
      return {
        plane: 'oidc',
        role: record.role,
        tenantId,
        csrfToken,
        principal: principalFor(record.role, tenantId),
        displayName: record.issuer ? `oidc:${record.issuer}` : 'oidc session',
        // verifySessionCsrf reads csrfToken only; the cast mirrors the
        // crypto-config gate's precedent.
        verifyCsrf: (provided) => verifySessionCsrf({ csrfToken } as SessionRecord, provided),
      };
    }
    if (typeof legacyCookie === 'string' && legacyCookie.length > 0) {
      return legacyContext(config, legacyCookie);
    }
    return null;
  }
  return typeof legacyCookie === 'string' && legacyCookie.length > 0
    ? legacyContext(config, legacyCookie)
    : null;
}

function principalFor(role: BffRole, tenantId: string | null): BffPrincipal {
  if (role === 'admin') return { kind: 'platform' };
  if (role === 'operator' && typeof tenantId === 'string' && tenantId.length > 0) {
    return { kind: 'tenant_operator', tenantId };
  }
  // viewer, or an operator session without a stored tenant (default deny).
  return { kind: 'unscoped' };
}

function legacyContext(config: ShellRuntimeConfig, cookie: string): BffContext | null {
  const claims = verifyCookie(config.cookieSecret, cookie, config.nowMs ? config.nowMs() : undefined);
  if (!claims) return null;
  return {
    plane: 'legacy',
    role: claims.role,
    // The self-contained legacy cookie carries no identity/tenant binding.
    tenantId: null,
    csrfToken: deriveCsrfToken(config.cookieSecret, cookie),
    principal: claims.role === 'admin' ? { kind: 'platform' } : { kind: 'unscoped' },
    displayName: `legacy:${claims.role}`,
    verifyCsrf: (provided) =>
      validateCsrfToken({ secret: config.cookieSecret, sessionCookie: cookie, provided }),
  };
}
