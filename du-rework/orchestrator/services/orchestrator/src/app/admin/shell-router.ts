/**
 * Pure route matcher for the Admin shell (P6-01).
 *
 * The shell has a small route table: the admin root, the per-section
 * pages (`/admin/businesses`, `/admin/profiles`, ...), `/admin/login`
 * (GET form / POST credentials), `/admin/logout`, and 404. The matcher
 * is a pure function over `(method, pathname, role)` so it is
 * unit-testable without spinning a listener.
 *
 * Auth model: the orchestrator's `assertAdminAuth` remains
 * authoritative for any server-to-server fetch the shell makes. The
 * shell's role guard only decides what a *renderer with that role*
 * may show — it never grants authorization. The cookie itself is the
 * evidence the bearer is who they claim (HMAC).
 *
 * Strict TypeScript, zero `any`.
 */

import { ROLE_ORDER } from './types';
import type { AdminSection, NavItem } from './types';
import type { AdminCookieClaims, AdminShellResponse } from './shell-types';
import {
  buildAdminShellView,
  buildScreenState,
  getCanonicalNavItems,
} from './p6-01-shell-fixtures';
import type { AdminShellRequest } from './shell-types';
import type { OidcFlow, OidcFlowRequest, OidcFlowResponse, OidcFlowSessionStore } from './oidc-flow';
import { forwardedProtoProvesHttps } from './oidc-flow';
import { SESSION_COOKIE_NAME, verifySessionCsrf, type SessionRecord } from '../../modules/auth/session-store';
import { renderCryptoConfig } from './crypto-config-renderer';
import type { CryptoConfigPane } from './crypto-config-view-models';
import type {
  AdminSecurityAuditSink,
  AdminSecurityEventKind,
  AdminSessionDeadReason,
} from '../../modules/admin-actions/rbac';
import { deriveCsrfToken, validateCsrfToken } from '../../modules/admin-actions/rbac';
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
import {
  fetchBusinessVersions,
} from './business-section-data';
import { fetchAuditEvents, type AuditFetchResult } from './audit-section-data';
import { renderAuditSection } from './audit-section-renderer';
import { AUDIT_NAV_PATH } from './shell-render';
import type {
  BusinessFetchResult,
  BusinessFetcherInput,
} from './business-section-data';
import {
  fetchProfileForm,
} from './profile-section-data';
import type {
  ProfileFetchResult,
  ProfileFetcherInput,
} from './profile-section-data';
import {
  renderBusinessSection,
} from './business-section-renderer';
import type {
  BusinessSectionRenderInput,
} from './business-section-renderer';
import {
  renderProfileSection,
} from './profile-section-renderer';
import type {
  ProfileSectionRenderInput,
} from './profile-section-renderer';
import {
  fetchConnectorConfig,
} from './connector-section-data';
import type {
  ConnectorFetchResult,
  ConnectorFetcherInput,
} from './connector-section-data';
import {
  renderConnectorSection,
} from './connector-section-renderer';
import type {
  ConnectorSectionRenderInput,
} from './connector-section-renderer';
import {
  fetchApiKeys,
} from './api-key-section-data';
import type {
  ApiKeyFetchResult,
  ApiKeyFetcherInput,
} from './api-key-section-data';
import {
  renderApiKeySection,
} from './api-key-section-renderer';
import type {
  ApiKeySectionRenderInput,
} from './api-key-section-renderer';
import {
  fetchOperationDetail,
  sanitizeFilterToken,
  sanitizeSortFilter,
  sanitizeStateFilter,
  OPERATION_LIST_DEFAULT_LIMIT,
  OPERATION_LIST_MAX_LIMIT,
  OPERATION_LIST_CURSOR_MAX_LEN,
} from './operation-section-data';
import type { OperationListFilters } from './operation-section-data';
import type {
  OperationFetchResult,
  OperationFetcherInput,
} from './operation-section-data';
import {
  renderOperationSection,
} from './operation-section-renderer';
import type {
  OperationSectionRenderInput,
} from './operation-section-renderer';
import {
  fetchOverview,
  resolveOverviewPresetWindow,
} from './overview-section-data';
import type {
  OverviewFetchResult,
  OverviewFetcherInput,
  OverviewTimePreset,
} from './overview-section-data';
import {
  renderOverviewSection,
} from './overview-section-renderer';
import type {
  OverviewSectionRenderInput,
} from './overview-section-renderer';


import { handleCryptoConfigGet, handleCryptoConfigPost } from './crypto-config-dispatch';
import { handleSectionGet, handleAuditGet } from './section-dispatch';
import { handleAdminMutationPost } from './mutation-dispatch';
import { handleLoginGet, handleLoginPost, handleLogout, toFlowRequest, joinSetCookie, resolveOpaqueSession, liveSessionClaims, sessionAuditEventFor } from './auth-dispatch';
import type { ShellRuntimeConfig } from './shell-router-shared';


// ---------------------------------------------------------------------------
// Renderers used by the route handlers
// ---------------------------------------------------------------------------

/**
 * Match `(method, pathname)` against the canonical nav items plus the
 * shell's login / logout routes. Returns the matched `AdminShellRoute`
 * (a logical id, the section it resolves to, the required role) or
 * `null` when no route applies.
 *
 * Pure: the function does not consult cookies — that is the caller's
 * job.
 */
export function matchShellRoute(
  method: string,
  pathname: string,
  navItems: readonly NavItem[] = getCanonicalNavItems(),
): { id: string; section: AdminSection | null; requiredRole: 'admin' | 'operator' | 'viewer' } | null {
  const m = method.toUpperCase();
  const p = pathname.length > 0 && pathname[0] === '/' ? pathname : '/' + pathname;

  // Root → admin home
  if (m === 'GET' && (p === '/' || p === '/admin' || p === '/admin/' || p === '/admin/legacy' || p === '/admin/legacy/')) {
    return { id: 'admin-root', section: null, requiredRole: 'viewer' };
  }

  // Login form (GET) and submit (POST)
  if (p === '/admin/login') {
    return { id: 'admin-login', section: null, requiredRole: 'viewer' };
  }

  // Logout (POST)
  if (m === 'POST' && p === '/admin/logout') {
    return { id: 'admin-logout', section: null, requiredRole: 'viewer' };
  }

  // Crypto configuration (ENC-08-WIRING Delta 97, W-ADM-UX-08-SHELL Delta 106).
  // Audit ledger (W-ADM-UX-03-AUDIT-ROUTE Delta 130): path-routed like crypto-config
  // because AdminSection is a closed union in types.ts (outside packet scope).
  if (m === 'GET' && p === AUDIT_NAV_PATH) {
    return { id: 'admin-audit', section: null, requiredRole: 'operator' };
  }
  // section route: `AdminSection` is a closed union in types.ts, and the
  // packet's file scope does not include it, so the pane is reached by its
  // own path rather than by pretending to be a data section. Role 'admin'
  // because choosing the Vault storage key ref is a platform action.
  if ((m === 'GET' || m === 'POST') && p === '/admin/crypto-config') {
    return { id: 'admin-crypto-config', section: null, requiredRole: 'admin' };
  }

  // Section routes — `/admin/<section>` or `/admin/<section>/...`
  if (p.startsWith('/admin/')) {
    const checkPath = p.startsWith('/admin/legacy/') ? p.replace('/admin/legacy', '/admin') : p;
    for (const item of navItems) {
      if (checkPath === item.path || checkPath.startsWith(item.path + '/')) {
        return { id: 'section:' + item.section, section: item.section, requiredRole: item.requiredRole };
      }
    }
  }

  return null;
}
/**
 * Dispatch a parsed request to a handler. Returns a `AdminShellResponse`
 * the caller can write to the socket. The dispatcher also returns the
 * matched route id (or `'unknown'`) so the shell server can log it.
 */
export function dispatchShellRequest(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  /** OIDC-04/CYCLE-101: pre-resolved claims from the async session gate;
   *  omitted/null keeps the legacy du_admin derivation byte-for-byte. */
  claimsOverride?: AdminCookieClaims | null,
  /** W-ENC-08-CSRF-OIDC (Delta 113): the live session's server-side CSRF
   *  token from the same async gate. Present => the session plane owns the
   *  crypto-config CSRF verdict. Omitted = legacy-only deployment. */
  oidcCsrfToken?: string,
): { response: AdminShellResponse; routeId: string } {
  const matched = matchShellRoute(request.method, request.pathname);

  // Cookie claims — only consult on routes that need them. Login form
  // does not need a valid cookie (it issues one).
  const cookie = request.cookies['du_admin'];
  const claims =
    claimsOverride !== undefined
      ? claimsOverride
      : cookie
        ? verifyCookie(config.cookieSecret, cookie, config.nowMs ? config.nowMs() : undefined)
        : null;

  if (!matched) {
    if (request.pathname === '/favicon.ico') {
      return {
        routeId: 'favicon',
        response: { status: 204, headers: {}, body: '' },
      };
    }
    return {
      routeId: 'unknown',
      response: {
        status: 404,
        headers: { 'content-type': 'text/html; charset=utf-8' },
        body: renderErrorPage({
          status: 404,
          title: 'Not found',
          message: `No Admin route matches ${request.method} ${request.pathname}.`,
        }),
      },
    };
  }

  switch (matched.id) {
    case 'admin-root':
      return { routeId: matched.id, response: handleSectionGet(null, matched.requiredRole, request, claims, config) };
    case 'admin-login': {
      if (request.method === 'POST') {
        return { routeId: matched.id, response: handleLoginPost(request, config) };
      }
      return { routeId: matched.id, response: handleLoginGet(request) };
    }
    case 'admin-logout':
      return { routeId: matched.id, response: handleLogout(request, config) };
    case 'admin-audit':
      return { routeId: matched.id, response: handleAuditGet(matched.requiredRole, request, claims, config) };
    case 'admin-crypto-config':
      if (request.method === 'POST') {
        return { routeId: matched.id, response: handleCryptoConfigPost(matched.requiredRole, request, claims, config, oidcCsrfToken) };
      }
      return { routeId: matched.id, response: handleCryptoConfigGet(matched.requiredRole, request, claims, config) };
    default: {
      if (matched.id.startsWith('section:') && matched.section !== null) {
        if (request.method === 'POST') {
          return {
            routeId: matched.id,
            response: {
              status: 405,
              headers: { 'content-type': 'text/html; charset=utf-8', allow: 'GET' },
              body: renderErrorPage({
                status: 405,
                title: 'Action unavailable',
                message: 'This Admin action has no server handler yet.',
              }),
            },
          };
        }
        return { routeId: matched.id, response: handleSectionGet(matched.section, matched.requiredRole, request, claims, config) };
      }
      return {
        routeId: 'unknown',
        response: {
          status: 404,
          headers: { 'content-type': 'text/html; charset=utf-8' },
          body: renderErrorPage({
            status: 404,
            title: 'Not found',
            message: `No Admin route matches ${request.method} ${request.pathname}.`,
          }),
        },
      };
    }
  }
}

export async function dispatchShellRequestAsync(
  request: AdminShellRequest,
  config: ShellRuntimeConfig
): Promise<{ response: AdminShellResponse; routeId: string }> {
  const flow = config.oidcFlow;
  if (flow) {
    const m = request.method.toUpperCase();
    const p = request.pathname;
    if (m === 'GET' && p === '/admin/login') {
      // CYCLE-101 UX: already-signed-in users skip a pointless IdP round-trip.
      if (await liveSessionClaims(config, request)) {
        return {
          routeId: 'oidc-login',
          response: {
            status: 302,
            headers: { location: '/admin', 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' },
            body: '',
          },
        };
      }
      return { routeId: 'oidc-login', response: await flow.handleLogin(toFlowRequest(request)) };
    }
    if (m === 'POST' && p === '/admin/login') {
      return { routeId: 'oidc-login', response: await flow.handleLogin(toFlowRequest(request)) };
    }
    if (m === 'GET' && p === '/admin/oidc/callback') {
      return { routeId: 'oidc-callback', response: await flow.handleCallback(toFlowRequest(request)) };
    }
    if (m === 'POST' && p === '/admin/logout') {
      const flowRes = await flow.handleLogout(toFlowRequest(request));
      const local = dispatchShellRequest(request, config);
      return {
        routeId: 'admin-logout',
        response: {
          status: local.response.status,
          headers: {
            ...local.response.headers,
            'set-cookie': joinSetCookie(local.response.headers['set-cookie'], flowRes.headers['set-cookie']) ?? '',
          },
          body: local.response.body,
        },
      };
    }
    // CYCLE-101 session lifecycle: with a session store mounted, every
    // PROTECTED route resolves the opaque du_session FIRST. Static assets
    // (favicon) stay on the legacy path — no auth surface there.
    if (config.oidcSessions && p !== '/favicon.ico') {
      const outcome = await resolveOpaqueSession(config, request);
      if (outcome.state === 'live') {
        // W-ENC-08-CSRF-OIDC (Delta 113): hand the session's own CSRF token to
        // the sync handler so the crypto-config gate verifies the SAME proof the
        // session plane minted. Without it, an OIDC session would be forced to
        // present a legacy du_admin-derived token and always be refused.
        const keyMutation = await handleAdminMutationPost(request, config, outcome.claims, outcome.csrfToken);
        if (keyMutation) return keyMutation;
        return dispatchShellRequest(request, config, outcome.claims, outcome.csrfToken);
      }
      const sc = request.cookies[SESSION_COOKIE_NAME];
      const legacy = request.cookies['du_admin'];
      const hasSessionCookie = typeof sc === 'string' && sc.length > 0;
      const hasLegacyAdmin = typeof legacy === 'string' && legacy.length > 0;
      if (!hasSessionCookie && hasLegacyAdmin) {
        // legacy du_admin deployment coexistence: behavior unchanged
        const legacyClaims = verifyCookie(config.cookieSecret, legacy, config.nowMs ? config.nowMs() : undefined);
        const keyMutation = await handleAdminMutationPost(request, config, legacyClaims);
        if (keyMutation) return keyMutation;
        return dispatchShellRequest(request, config);
      }
      // W-SEC-AUDIT-TAXONOMY-1: a DEAD du_session on a protected route is
      // audited (expired vs revoked, from the store's honest classifier)
      // before the polite sweep. Anonymous requests and invalid-shape ids
      // log nothing. The wire stays ONE indistinguishable 302.
      if (outcome.state === 'dead') {
        const auditEvent = sessionAuditEventFor(outcome.reason);
        if (auditEvent) {
          config.securityAudit?.({
            kind: auditEvent.kind,
            reason: auditEvent.reason,
            method: request.method,
            pathname: p,
          });
        }
      }
      // Expired / revoked / forged / anonymous: restart the flow politely
      // and sweep the stale cookie — never a raw 401/403 pane under OIDC.
      const toLogin = await flow.handleLogout(toFlowRequest(request));
      return {
        routeId: 'oidc-session-gate',
        response: {
          status: 302,
          headers: {
            location: '/admin/login',
            'set-cookie': toLogin.headers['set-cookie'] ?? '',
            'cache-control': 'no-store',
            'content-type': 'text/html; charset=utf-8',
          },
          body: '',
        },
      };
    }
  }
  const cookie = request.cookies['du_admin'];
  const claims = cookie ? verifyCookie(config.cookieSecret, cookie, config.nowMs ? config.nowMs() : undefined) : null;
  const keyMutation = await handleAdminMutationPost(request, config, claims);
  if (keyMutation) return keyMutation;
  return dispatchShellRequest(request, config);
}

// ---------------------------------------------------------------------------
// Re-exports used by tests
// ---------------------------------------------------------------------------

export { parseCookieHeader, parseFormBody };

// OIDC-04 type re-export for consumers building a ShellRuntimeConfig with a
// mounted flow (the flow itself lives in ./oidc-flow).
export type { OidcFlow, OidcFlowResponse };

// Re-exports: every name the pre-split file exported still resolves from
// here, so server.ts, shell-server.ts, index.ts and the tests are untouched.
export { registerCryptoConfigWiring } from './crypto-config-dispatch';
export { deriveRoleFromToken } from './auth-dispatch';
export { parseQueryString, parseOperationListQuery } from './shell-router-shared';
export type {
  ShellRuntimeConfig,
  CryptoConfigPaneResolver,
  CryptoConfigApply,
  SectionFetchers,
  BusinessSectionFetcher,
  ProfileSectionFetcher,
  ConnectorSectionFetcher,
  ApiKeySectionFetcher,
  OperationSectionFetcher,
  OverviewSectionFetcher,
  OperationListQuery,
} from './shell-router-shared';
