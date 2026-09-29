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

// ---------------------------------------------------------------------------
// Query-string parsing
// ---------------------------------------------------------------------------

/**
 * Parse a `application/x-www-form-urlencoded`-style query string into
 * a `{name: value}` map. Last value wins. `+` decodes as space,
 * `%XX` as the byte. Mirrors the body parser for consistency. Pure.
 */
export function parseQueryString(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!raw) return out;
  const parts = raw.split('&');
  for (const part of parts) {
    if (part.length === 0) continue;
    const eq = part.indexOf('=');
    const name = eq < 0 ? part : part.slice(0, eq);
    const value = eq < 0 ? '' : part.slice(eq + 1);
    try {
      out[decodeURIComponent(name.replace(/\+/g, ' '))] = decodeURIComponent(
        value.replace(/\+/g, ' '),
      );
    } catch {
      // Malformed percent-encoding: skip rather than throw.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Configuration surface
// ---------------------------------------------------------------------------

/**
 * What the matcher + renderer needs from the surrounding shell. Kept
 * narrow so the in-process test can pass a stub and the platform
 * adapter can pass the live orchestrator state. No DB, no Redis.
 */
export interface ShellRuntimeConfig {
  /** HMAC secret for the `du_admin` cookie. Empty string disables signing. */
  cookieSecret: string;
  /** Bearer token that grants admin access to the orchestrator API. */
  adminToken: string;
  /**
   * Lifetime of the `du_admin` cookie in seconds. Default 8 hours.
   * Set to 0 to disable persistent cookies (cookie becomes a
   * session-only one — clients must re-authenticate on each
   * browser restart).
   */
  cookieMaxAgeSeconds?: number;
  /**
   * Issued-at clock for the cookie. Production: `() => Date.now()`.
   * Tests inject deterministic clocks.
   */
  nowMs?: () => number;
  /**
   * OIDC-04: when wired, GET /admin/login redirects to the IdP (PKCE),
   * GET /admin/oidc/callback runs the exchange, and POST /admin/logout
   * also destroys the opaque du_session — the self-contained du_admin
   * password login stays for non-OIDC deployments only (POST /admin/login
   * is intercepted while a flow is mounted, so the two auth paths can
   * never coexist and bypass the IdP).
   */
  oidcFlow?: OidcFlow;
  /**
   * OIDC-04/CYCLE-101: the opaque-session store behind the flow. When
   * mounted WITH the flow, every protected /admin route resolves
   * du_session first: LIVE session -> claims injected into the sync
   * dispatcher; DEAD/revoked/forged/expired -> graceful 302 to
   * /admin/login with the stale cookie cleared (never a raw 401/403
   * pane while OIDC is the identity plane). Without this field the
   * flow still serves login/callback/logout but pages keep the legacy
   * du_admin gating (deployment without a session store).
   */
  oidcSessions?: import('../../modules/admin-actions/rbac').AdminSessionStore;
  /**
   * W-SEC-COOKIE-CONFIG-1 (delta-27/33): the DU_ADMIN_* Secure-cookie
   * policy parsed once at mount by the shell server via oidc-boot's
   * parseCookieSecurePolicy — the same env surface the OIDC plane reads.
   * Absent == { trustProxyProtocol: false, requireSecure: false }: the
   * legacy du_admin cookie mints exactly as before (no Secure, never
   * denied). See legacyCookiePosture for the read rules.
   */
  cookiePolicy?: { trustProxyProtocol: boolean; requireSecure: boolean };
  /**
   * W-SEC-AUDIT-TAXONOMY-1: closed-shape security-event sink
   * (auth.login_failed / auth.tls_required / auth.session_expired /
   * auth.session_revoked). Absent = every response byte-for-byte as
   * before, no events. The shell server wires a structured console sink
   * by default at mount; tests and a future ledger wiring inject here.
   * Emitters MUST pass fixed vocabulary only — never a submitted token,
   * cookie value, session id or CSRF secret (AdminSecurityEvent has no
   * field where such a value could land).
   */
  securityAudit?: AdminSecurityAuditSink;
  /**
   * ENC-08-WIRING: supplies the crypto-configuration pane for
   * `GET /admin/crypto-config`. The composition root wires it (typically a
   * fetch of `GET /api/v1/admin/crypto-config` with the admin bearer).
   * Absent = the pane renders its error state: the shell never invents
   * configuration data, and it never shows "nothing to configure" as if
   * that were an answer.
   */
  cryptoConfigPane?: CryptoConfigPaneResolver;
  /**
   * Applies a crypto-configuration change submitted by the pane's form. Same
   * composition-root wiring as the resolver: absent means the form cannot
   * save, and the pane says so instead of pretending the save worked.
   */
  cryptoConfigApply?: CryptoConfigApply;
  /**
   * Per-section data fetchers. Each fetcher turns a (section, request)
   * pair into rendered HTML the shell splices into the page body.
   * Absent fetchers render the screen state without section data
   * (the existing P6-01 contract). P6-02 ships the businesses
   * fetcher; future rows (operations, connectors, profiles, ...)
   * extend this map.
   */
  sectionFetchers?: SectionFetchers;
}

/**
 * Supplies the crypto-configuration pane for `GET /admin/crypto-config`.
 * Injected by the composition root (createApp) from the SAME service the
 * JSON API uses, so the pane can never show a value the API would refuse.
 */
export type CryptoConfigPaneResolver = (request: AdminShellRequest) => Promise<CryptoConfigPane>;

/**
 * Applies a change the operator submitted from the pane form. Returns a fresh
 * pane for the redirect target, so the operator sees applied state rather
 * than a stale form.
 */
export type CryptoConfigApply = (input: {
  request: AdminShellRequest;
  tenantId: string;
  storageKeyRef: string | null | undefined;
  deliveryEncryption: boolean | undefined;
  recipientKeyVersion: number | null | undefined;
}) => Promise<CryptoConfigPane>;

/**
 * W-ADM-UX-08-SHELL: process-level holder for the composition root's wiring.
 *
 * `attachAdminShell` builds its `ShellRuntimeConfig` from a fixed field list
 * inside shell-server.ts, and that file is outside this packet's scope, so the
 * resolver cannot be passed through `ServerConfig`. The composition root
 * therefore REGISTERS it here once at boot, and the route reads it when the
 * per-request config does not carry one. A stale registration from a previous
 * app in the same process is why `createApp` always calls this - including with
 * `undefined` to clear, so a test that boots two apps cannot inherit the
 * first one's resolver.
 */
let registeredCryptoConfigPane: CryptoConfigPaneResolver | undefined;
let registeredCryptoConfigApply: CryptoConfigApply | undefined;

export function registerCryptoConfigWiring(input: {
  pane?: CryptoConfigPaneResolver;
  apply?: CryptoConfigApply;
}): void {
  registeredCryptoConfigPane = input.pane;
  registeredCryptoConfigApply = input.apply;
}

/** The pane resolver in effect: per-request config first, then the boot registration. */
function cryptoConfigPaneResolver(config: ShellRuntimeConfig): CryptoConfigPaneResolver | undefined {
  return config.cryptoConfigPane ?? registeredCryptoConfigPane;
}

function cryptoConfigApplier(config: ShellRuntimeConfig): CryptoConfigApply | undefined {
  return config.cryptoConfigApply ?? registeredCryptoConfigApply;
}
/**
 * Per-section fetchers. The shell invokes the matching fetcher
 * when handling a `GET /admin/<section>` request; the rendered HTML
 * is spliced inside the shell chrome. A fetcher must never throw —
 * it returns a discriminated result the renderer maps onto the
 * screen states.
 *
 * P6-02 ships the businesses fetcher. P6-03 adds the profiles
 * fetcher. Future rows (operations, connectors, grants, ...)
 * extend this map.
 */
export interface SectionFetchers {
  businesses?: BusinessSectionFetcher;
  profiles?: ProfileSectionFetcher;
  connectors?: ConnectorSectionFetcher;
  apiKeys?: ApiKeySectionFetcher;
  operations?: OperationSectionFetcher;
  overview?: OverviewSectionFetcher;
  /**
   * W-ADM-UX-03-AUDIT-ROUTE (Delta 130): the audit ledger pane fetcher.
   *
   * The default fetcher (fetchAuditEvents from ./audit-section-data)
   * targets {jsonBaseUrl}/api/v1/admin/audit with the admin bearer.
   * When absent the pane renders its error state: the shell never
   * presents a wiring gap as an empty ledger.
   */
  audit?: (input: import('./audit-section-data').AuditFetcherInput) => Promise<AuditFetchResult>;
}

/**
 * Business section fetcher. The shell calls this for
 * `GET /admin/businesses[?businessId=…]`. The fetcher calls out to
 * the platform's JSON API and returns either a successful fetch
 * (rows + active version) or a discriminated failure result.
 *
 * The default fetcher (`fetchBusinessVersions` from
 * `./business-section-data`) uses the orchestrator's JSON API at
 * `{jsonBaseUrl}/api/v1/admin/businesses/{businessId}/versions`.
 * The platform currently exposes only the per-version PUT routes;
 * the GET endpoint is requested from Claude Code in
 * `coordination/reports/openclaude.md`. Until that lands, the
 * fetcher returns a `not-found` discriminated result and the
 * renderer shows the "Business list unavailable" pane — no
 * fabricated rows.
 */
export interface BusinessSectionFetcher {
  (input: BusinessFetcherInput): Promise<BusinessFetchResult>;
}

/**
 * Profile section fetcher. The shell calls this for
 * `GET /admin/profiles[?businessId=…&businessVersion=…&profile=…]`.
 * The fetcher resolves the manifest from the platform (or the
 * in-process catalog when `jsonBaseUrl` is unset) and returns a
 * discriminated `ProfileFetchResult`.
 *
 * The default fetcher (`fetchProfileForm` from
 * `./profile-section-data`) targets
 * `{jsonBaseUrl}/api/v1/admin/profiles/{businessId}/{businessVersion|latest}/{profile|new}`.
 * The platform exposes only `POST /api/v1/admin/profile-bindings`
 * today; the GET endpoint is requested in
 * `coordination/reports/openclaude.md`. Until that lands, the
 * fetcher falls back to the in-process `manifestCatalog` so the
 * renderer can be exercised end-to-end, or returns a `not-found`
 * discriminated result.
 */
export interface ProfileSectionFetcher {
  (input: ProfileFetcherInput): Promise<ProfileFetchResult>;
}

/**
 * Connector section fetcher. The shell calls this for
 * `GET /admin/connectors[?connectorId=…&revision=…]`. The fetcher
 * resolves the connector's revision row (masked endpoint + secret
 * slots + test result + rotate-secret state) from the platform's
 * JSON API and returns a discriminated `ConnectorFetchResult`.
 *
 * The default fetcher (`fetchConnectorConfig` from
 * `./connector-section-data`) targets
 * `{jsonBaseUrl}/api/v1/admin/connectors/{connectorId}/revisions/{revision}`.
 * The platform exposes only `POST /api/v1/admin/connector-bindings`
 * today; the GET endpoint is requested in
 * `coordination/reports/openclaude.md`. Until that lands, the
 * fetcher falls back to the in-process `manifestCatalog` so the
 * renderer can be exercised end-to-end.
 */
export interface ConnectorSectionFetcher {
  (input: ConnectorFetcherInput): Promise<ConnectorFetchResult>;
}

/**
 * API key section fetcher. The shell calls this for
 * `GET /admin/api-keys[?keyId=…]`. The fetcher resolves the key
 * list (and optional selected key + grants) from the platform's
 * JSON API and returns a discriminated `ApiKeyFetchResult`.
 *
 * The default fetcher (`fetchApiKeys` from `./api-key-section-data`)
 * targets `{jsonBaseUrl}/api/v1/admin/api-keys[/<keyId>]`. The
 * platform currently exposes only the create POST route; the GET
 * endpoints are requested in `coordination/reports/openclaude.md`.
 * Until they land, the fetcher falls back to the in-process
 * `manifestCatalog` so the renderer can be exercised end-to-end,
 * or returns the matching discriminated failure result.
 */
export interface ApiKeySectionFetcher {
  (input: ApiKeyFetcherInput): Promise<ApiKeyFetchResult>;
}

/**
 * Operation detail section fetcher. The shell calls this for
 * `GET /admin/operations[?operationId=…]`. The fetcher resolves the
 * operation detail (status + result + artifacts + wait form) from the
 * platform's JSON API and returns a discriminated `OperationFetchResult`.
 *
 * The default fetcher (`fetchOperationDetail` from
 * `./operation-section-data`) targets
 * `{jsonBaseUrl}/api/v1/operations[/<operationId>]`. The platform exposes
 * `GET /api/v1/operations/:id` today; the request is recorded in
 * `coordination/reports/openclaude.md`. Until the route is wired the
 * fetcher falls back to the in-process `manifestCatalog` so the renderer
 * can be exercised end-to-end, or returns the matching discriminated
 * failure result.
 */
export interface OperationSectionFetcher {
  (input: OperationFetcherInput): Promise<OperationFetchResult>;
}

/**
 * Optional pluggable fetcher for the P6-07 overview section
 * (usage + audit + health). The shell calls this with a typed
 * `OverviewFetcherInput` and renders the resulting
 * `OverviewFetchResult`. When the fetcher is omitted, the
 * section renders as ready with no fetcher-driven content.
 */
export interface OverviewSectionFetcher {
  (input: OverviewFetcherInput): Promise<OverviewFetchResult>;
}

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
  if (m === 'GET' && (p === '/' || p === '/admin' || p === '/admin/')) {
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
    for (const item of navItems) {
      if (p === item.path || p.startsWith(item.path + '/')) {
        return { id: 'section:' + item.section, section: item.section, requiredRole: item.requiredRole };
      }
    }
  }

  return null;
}

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

/**
 * GET /, GET /admin, GET /admin/<section> — section page or admin home.
 * Routes through the role guard and the four screen states.
 */
function handleSectionGet(
  section: AdminSection | null,
  requiredRole: 'admin' | 'operator' | 'viewer',
  request: AdminShellRequest,
  claims: AdminCookieClaims | null,
  config: ShellRuntimeConfig,
): AdminShellResponse {
  if (!claims) {
    // 401 page inside the shell chrome — the login form is rendered
    // by `handleLoginGet`, but a deep-link to /admin/X with no cookie
    // also gets a 401 page so users see the error immediately.
    return {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 401,
        title: 'Sign-in required',
        message: 'Sign in to view the Admin shell.',
      }),
    };
  }
  if (ROLE_ORDER[claims.role] < ROLE_ORDER[requiredRole]) {
    return {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 403,
        title: 'Access denied',
        message: `Role '${claims.role}' is not authorized for this section (requires '${requiredRole}').`,
      }),
    };
  }

  const view = buildAdminShellView({
    role: claims.role,
    path: request.pathname,
    navItems: getCanonicalNavItems(),
    dataAvailable: section === null
      ? { kind: 'ready' }
      : { kind: 'ready' },
  });

  const screen = buildScreenState({
    role: claims.role,
    section: section,
    dataAvailable: { kind: 'ready' },
  });

  const body = renderShell(view, screen);

  // P6-02: when the section is 'businesses' and a fetcher is
  // configured, attach a deferred extras hook. The shell server
  // awaits it before writing the response, so the dispatch path
  // stays synchronous here.
  if (section === 'businesses' && config.sectionFetchers?.businesses) {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body,
      deferredSectionExtras: () => resolveBusinessExtras(request, config, claims.role),
    };
  }

  // P6-03: profile editor dispatches via the deferred hook the same
  // way. The fetcher reads `?businessId=`, `?businessVersion=`, and
  // `?profile=` and renders a schema-driven form (or the appropriate
  // fallback pane) into the section slot.
  if (section === 'profiles' && config.sectionFetchers?.profiles) {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body,
      deferredSectionExtras: () => resolveProfileExtras(request, config, claims.role),
    };
  }

  // P6-04: connector config / secret rotation / test result pane
  // dispatches via the same deferred hook. The fetcher reads
  // `?connectorId=…&revision=…` and renders the masked-endpoint,
  // write-only secret slot forms, and the explicit test-result
  // block (or the matching fallback pane).
  if (section === 'connectors' && config.sectionFetchers?.connectors) {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body,
      deferredSectionExtras: () => resolveConnectorExtras(request, config, claims.role),
    };
  }

  // P6-05: API key create / copy-once / revoke / assignment pane
  // dispatches via the same deferred hook. The fetcher reads
  // `?keyId=…` and renders the list, the copy-once banner (when
  // present), the revoke confirmation panel, and the grant rows
  // for the selected key (or the matching fallback pane).
  if (section === 'api-keys' && config.sectionFetchers?.apiKeys) {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body,
      deferredSectionExtras: () => resolveApiKeyExtras(request, config, claims.role),
    };
  }

  // P6-06: operation detail / result / artifacts / cancel / resume /
  // replay pane dispatches via the same deferred hook. The fetcher
  // reads `?operationId=…` and renders the detail + result + artifacts
  // panels and the explicit cancel / resume / replay action
  // discriminators (or the matching fallback pane).
  if (section === 'operations' && config.sectionFetchers?.operations) {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body,
      deferredSectionExtras: () => resolveOperationExtras(request, config, claims.role),
    };
  }

  // P6-07: usage rollup + audit events + operational health overview
  // dispatches via the same deferred hook. The fetcher reads
  // `?tenantId=…&from=…&to=…` and renders the three sub-panes with
  // their explicit `data-usage-*`, `data-audit-*`, `data-health-*`
  // discriminators (or the matching fallback pane).
  if (section === 'overview' && config.sectionFetchers?.overview) {
    return {
      status: 200,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body,
      deferredSectionExtras: () => resolveOverviewExtras(request, config, claims.role),
    };
  }

  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body,
  };
}

/**
 * Read the `?businessId=…` query string from the request and ask the
 * configured businesses fetcher to load + render the section. The
 * fetcher never throws; the renderer maps its discriminated result
 * to the screen state.
 */
async function resolveBusinessExtras(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  role: 'admin' | 'operator' | 'viewer',
): Promise<string | undefined> {
  const fetcher = config.sectionFetchers?.businesses;
  if (!fetcher) return undefined;

  const businessId = readBusinessIdFromRequest(request);
  const query = request.query ?? {};
  // The orchestrator's JSON API runs on the same port as the
  // shell today. The fetcher is allowed to fall back to any base
  // URL the platform provides; we pass the conventional default
  // when the config has no explicit override.
  const jsonBaseUrl = readJsonBaseUrlFromRequest(request) ?? 'http://127.0.0.1:0';
  const result = await fetcher({
    businessId,
    jsonBaseUrl,
    adminToken: config.adminToken,
    nowMs: config.nowMs,
  });
  const rendered = renderBusinessSection({
    fetch: result,
    knownBusinessIds: [businessId].filter((id) => id.length > 0),
    selectedBusinessId: businessId,
    selectedVersion: typeof query['version'] === 'string' ? query['version'] : undefined,
    compareVersion: typeof query['compareVersion'] === 'string' ? query['compareVersion'] : undefined,
  });
  return rendered.html;
}

/**
 * Read the `?businessId=…&businessVersion=…&profile=…` query
 * string and ask the configured profiles fetcher to load + render
 * the section. Mirrors `resolveBusinessExtras` exactly so the
 * dispatch path on the server side stays identical for both
 * sections.
 */
async function resolveProfileExtras(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  _role: 'admin' | 'operator' | 'viewer',
): Promise<string | undefined> {
  const fetcher = config.sectionFetchers?.profiles;
  if (!fetcher) return undefined;

  const query = request.query ?? {};
  const businessId = (query['businessId'] ?? '').toString();
  const businessVersion = (query['businessVersion'] ?? '').toString();
  const profileName = (query['profile'] ?? '').toString();
  const jsonBaseUrl = readJsonBaseUrlFromRequest(request) ?? 'http://127.0.0.1:0';

  const input: ProfileFetcherInput = {
    businessId,
    businessVersion: businessVersion.length > 0 ? businessVersion : 'latest',
    profileName,
    jsonBaseUrl,
    adminToken: config.adminToken,
  };

  const result: ProfileFetchResult = await fetcher(input);
  const compareVersion = typeof query['compareVersion'] === 'string' ? query['compareVersion'] : '';
  const compareFetch = compareVersion.length > 0 && compareVersion !== input.businessVersion
    ? await fetcher({ ...input, businessVersion: compareVersion })
    : undefined;
  const rendered = renderProfileSection({
    fetch: result,
    compareFetch,
    compareVersion,
    knownBusinessIds: businessId.length > 0 ? [businessId] : [],
    selectedBusinessId: businessId,
  });
  return rendered.html;
}

/**
 * Read the `?connectorId=…&revision=…` query string and ask the
 * configured connectors fetcher to load + render the section. The
 * fetcher returns a discriminated `ConnectorFetchResult`; the
 * renderer maps that onto the section's screen state (ok pane with
 * masked endpoint + write-only secret slot forms + explicit test
 * result, or the matching fallback pane).
 */
async function resolveConnectorExtras(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  _role: 'admin' | 'operator' | 'viewer',
): Promise<string | undefined> {
  const fetcher = config.sectionFetchers?.connectors;
  if (!fetcher) return undefined;

  const query = request.query ?? {};
  const connectorId = (query['connectorId'] ?? '').toString();
  const revisionRaw = (query['revision'] ?? '').toString();
  const revision = Number.parseInt(revisionRaw, 10);
  const compareRevisionRaw = (query['compareRevision'] ?? '').toString();
  const compareRevision = Number.parseInt(compareRevisionRaw, 10);
  const jsonBaseUrl = readJsonBaseUrlFromRequest(request) ?? 'http://127.0.0.1:0';

  const input: ConnectorFetcherInput = {
    connectorId,
    revision: Number.isFinite(revision) && revision > 0 ? revision : 0,
    jsonBaseUrl,
    adminToken: config.adminToken,
  };

  const result: ConnectorFetchResult = await fetcher(input);
  const compareFetch = Number.isSafeInteger(compareRevision) && compareRevision > 0 && compareRevision !== input.revision
    ? await fetcher({ ...input, revision: compareRevision })
    : undefined;
  const rendered = renderConnectorSection({
    fetch: result,
    compareFetch,
    compareRevision: Number.isSafeInteger(compareRevision) && compareRevision > 0 ? compareRevision : undefined,
    knownConnectorIds: connectorId.length > 0 ? [connectorId] : [],
    selectedConnectorId: connectorId,
    selectedRevision: input.revision,
  });
  return rendered.html;
}

/**
 * Read the `?keyId=…` query string and ask the configured api-keys
 * fetcher to load + render the section. The fetcher returns a
 * discriminated `ApiKeyFetchResult`; the renderer maps that onto
 * the section's screen state (list + optional detail + grants + a
 * copy-once banner when one is open, or the matching fallback pane).
 */
async function resolveApiKeyExtras(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  _role: 'admin' | 'operator' | 'viewer',
): Promise<string | undefined> {
  const fetcher = config.sectionFetchers?.apiKeys;
  if (!fetcher) return undefined;

  const query = request.query ?? {};
  const keyId = (query['keyId'] ?? '').toString();
  const jsonBaseUrl = readJsonBaseUrlFromRequest(request) ?? 'http://127.0.0.1:0';

  const input: ApiKeyFetcherInput = {
    keyId,
    jsonBaseUrl,
    adminToken: config.adminToken,
  };

  const result: ApiKeyFetchResult = await fetcher(input);
  const rendered = renderApiKeySection({
    fetch: result,
    knownKeyIds: keyId.length > 0 ? [keyId] : [],
    selectedKeyId: keyId,
  });
  return rendered.html;
}

/**
 * Parsed list-pane query context for `/admin/operations` (W-ADMUX-01 +
 * W-ADMUX-03-FILTER-1). `limit` is clamped to the server's 1..100 range
 * (default 20); `cursor` is an opaque, length-bounded continuation token
 * — never user text. `stateFilter`/`tenantFilter`/`idFilter` carry the
 * raw toolbar query values; validation happens in the fetcher so the
 * envelope can report rejected tokens (`ignoredFilters`). `listFilters`
 * is the sanitized echo for the detail-pane back link.
 */
export interface OperationListQuery {
  limit: number;
  cursor: string | null;
  stateFilter?: string;
  tenantFilter?: string;
  idFilter?: string;
  /** W-ADMUX03-SHELL-SORT-1: raw `?sort=` token; validated in the fetcher. */
  sortFilter?: string;
  listFilters: OperationListFilters;
}

/** Clamp the raw `?limit=&cursor=&state=&tenant=&id=&sort=` query into the list-pane contract. */
export function parseOperationListQuery(
  query: Record<string, string | undefined> | undefined,
): OperationListQuery {
  const rawLimit = (query?.['limit'] ?? '').trim();
  let limit = OPERATION_LIST_DEFAULT_LIMIT;
  if (rawLimit.length > 0) {
    const n = Number.parseInt(rawLimit, 10);
    if (Number.isFinite(n)) limit = Math.min(OPERATION_LIST_MAX_LIMIT, Math.max(1, n));
  }
  const rawCursor = query?.['cursor'];
  const cursor =
    typeof rawCursor === 'string' && rawCursor.length > 0
      ? rawCursor.slice(0, OPERATION_LIST_CURSOR_MAX_LEN)
      : null;
  const readRaw = (name: string): string | undefined => {
    const v = query?.[name];
    return typeof v === 'string' && v.trim().length > 0 ? v.slice(0, OPERATION_LIST_CURSOR_MAX_LEN) : undefined;
  };
  const stateFilter = readRaw('state');
  const tenantFilter = readRaw('tenant');
  const idFilter = readRaw('id');
  const sortFilter = readRaw('sort');
  const listFilters: OperationListFilters = {
    state: sanitizeStateFilter(stateFilter) ?? 'ALL',
    tenant: sanitizeFilterToken(tenantFilter),
    idContains: sanitizeFilterToken(idFilter),
  };
  return { limit, cursor, stateFilter, tenantFilter, idFilter, sortFilter, listFilters };
}

/**
 * Read the `?operationId=…` query string and ask the configured
 * operations fetcher to load + render the section. The fetcher returns
 * a discriminated `OperationFetchResult`; the renderer maps that onto
 * the section's screen state (ok pane with detail + result +
 * artifacts + explicit cancel / resume / replay actions, or the
 * matching fallback pane).
 *
 * W-ADMUX-01: with no `operationId` the pane is the paged list —
 * `?limit=` (1..100, default 20) and `?cursor=` are read here and
 * forwarded to the fetcher so page size is enforced server-side; the
 * renderer echoes them onto the row links / back link so refresh and
 * deep links keep the operator on the same page.
 */
async function resolveOperationExtras(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  _role: 'admin' | 'operator' | 'viewer',
): Promise<string | undefined> {
  const fetcher = config.sectionFetchers?.operations;
  if (!fetcher) return undefined;

  const query = request.query ?? {};
  const operationId = (query['operationId'] ?? '').toString();
  const jsonBaseUrl = readJsonBaseUrlFromRequest(request) ?? 'http://127.0.0.1:0';
  const list = parseOperationListQuery(query);

  const input: OperationFetcherInput = {
    operationId,
    jsonBaseUrl,
    adminToken: config.adminToken,
    listLimit: list.limit,
    cursor: list.cursor ?? undefined,
    stateFilter: list.stateFilter,
    tenantFilter: list.tenantFilter,
    idFilter: list.idFilter,
    sortFilter: list.sortFilter,
  };

  const result: OperationFetchResult = await fetcher(input);
  const rendered = renderOperationSection({
    fetch: result,
    selectedOperationId: operationId,
    listLimit: list.limit,
    listCursor: list.cursor,
    listFilters: list.listFilters,
    listSort: sanitizeSortFilter(list.sortFilter),
  });
  return rendered.html;
}

/**
 * Read the `?tenantId=…&from=…&to=…` query string and ask the
 * configured overview fetcher to load + render the section. The
 * fetcher returns a discriminated `OverviewFetchResult`; the
 * renderer maps that onto the success pane (usage rollup + audit
 * events + operational health with their explicit discriminators)
 * or the matching fallback pane.
 */
async function resolveOverviewExtras(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  _role: 'admin' | 'operator' | 'viewer',
): Promise<string | undefined> {
  const fetcher = config.sectionFetchers?.overview;
  if (!fetcher) return undefined;

  const query = request.query ?? {};
  const tenantId = (query['tenantId'] ?? '').toString();
  const requestedFrom = (query['from'] ?? '').toString();
  const requestedTo = (query['to'] ?? '').toString();
  const requestedPreset = (query['timeRange'] ?? '').toString();
  const allowedPresets: readonly OverviewTimePreset[] = ['today', '24h', '7d', 'custom'];
  const timePreset: OverviewTimePreset = allowedPresets.includes(requestedPreset as OverviewTimePreset)
    ? requestedPreset as OverviewTimePreset
    : requestedFrom.length > 0 || requestedTo.length > 0
      ? 'custom'
      : 'today';
  const window = timePreset === 'custom'
    ? { from: requestedFrom, to: requestedTo }
    : resolveOverviewPresetWindow(timePreset, undefined, undefined);
  const jsonBaseUrl = readJsonBaseUrlFromRequest(request) ?? 'http://127.0.0.1:0';

  const input: OverviewFetcherInput = {
    tenantId,
    from: window.from.length > 0 ? window.from : undefined,
    to: window.to.length > 0 ? window.to : undefined,
    timePreset,
    jsonBaseUrl,
    adminToken: config.adminToken,
  };

  const result: OverviewFetchResult = await fetcher(input);
  const rendered = renderOverviewSection({
    fetch: result,
    selectedTenantId: tenantId,
    selectedTimePreset: timePreset,
  });
  return rendered.html;
}

function readBusinessIdFromRequest(request: AdminShellRequest): string {
  // The shell's `AdminShellRequest.query` carries the parsed
  // `?businessId=…` value. Empty when the request is to the bare
  // `/admin/businesses` URL; the renderer falls back to the
  // not-found pane until the platform exposes a list endpoint.
  const fromQuery = request.query?.['businessId'] ?? '';
  return fromQuery;
}

function readJsonBaseUrlFromRequest(request: AdminShellRequest): string | undefined {
  // Optional override via query string (useful for staging). When
  // unset, the platform `attachAdminShell` configures the actual
  // base URL — the fetcher's `jsonBaseUrl` is what the orchestrator
  // passes in. Tests that want a custom URL inject it via
  // `sectionFetchers` directly, not via this hint.
  const host = request.query?.['jsonBaseUrl'];
  return host && host.length > 0 ? host : undefined;
}

/** GET /admin/login — render the login form. */
function handleLoginGet(request: AdminShellRequest): AdminShellResponse {
  const redirect = request.body['redirect'] ?? request.cookies['redirect'] ?? '/admin';
  const csrfMarker = (request.cookies['csrf'] ?? '').slice(0, 32) || 'static';
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: renderLoginPage({ redirect, csrfMarker }),
  };
}

/** POST /admin/login — verify the bearer token, mint a cookie, redirect. */
function handleLoginPost(
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
function legacyCookiePosture(
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
function handleLogout(
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
// Public dispatch
// ---------------------------------------------------------------------------

/**
 * ENC-08-WIRING: GET /admin/crypto-config. Same shape as a section GET -
 * cookie claims, then the role guard - and the pane itself arrives through the
 * deferred extras hook, so the synchronous dispatcher stays synchronous.
 *
 * A resolver that throws renders the error pane rather than a stack trace: a
 * crypto pane that cannot load must say so, not look empty.
 */
function handleCryptoConfigGet(
  requiredRole: 'admin' | 'operator' | 'viewer',
  request: AdminShellRequest,
  claims: AdminCookieClaims | null,
  config: ShellRuntimeConfig,
): AdminShellResponse {
  if (!claims) {
    return {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 401,
        title: 'Sign-in required',
        message: 'Sign in to view the Admin shell.',
      }),
    };
  }
  if (ROLE_ORDER[claims.role] < ROLE_ORDER[requiredRole]) {
    return {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 403,
        title: 'Access denied',
        message: `Role '${claims.role}' is not authorized for crypto configuration (requires 'admin').`,
      }),
    };
  }
  const view = buildAdminShellView({
    role: claims.role,
    path: request.pathname,
    navItems: getCanonicalNavItems(),
    dataAvailable: { kind: 'ready' },
  });
  const screen = buildScreenState({
    role: claims.role,
    section: null,
    dataAvailable: { kind: 'ready' },
  });
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: renderShell(view, screen),
    deferredSectionExtras: async () => {
      const resolve = cryptoConfigPaneResolver(config);
      if (!resolve) {
        return renderCryptoConfig({ status: 'error', code: 'CRYPTO_CONFIG_NOT_WIRED' });
      }
      try {
        // W-ENC-08-RENDERER-CSRF (Delta 112): the pane's form must carry the
        // CSRF proof the POST gate will re-derive, or every browser save is a
        // guaranteed 403. It is a binding, not a page-specific nonce, and the
        // SECRET is never rendered anywhere.
        // W-ENC-08-CSRF-OIDC (Delta 113): under an OIDC session the gate
        // verifies the SESSION's server-side token, so the form must carry
        // that one. Falling back to the legacy du_admin derivation here would
        // render a proof the POST leg then refuses.
        const sessionId = request.cookies[SESSION_COOKIE_NAME];
        const sessionStore = config.oidcSessions;
        let csrfToken = '';
        if (sessionStore && typeof sessionId === 'string' && sessionId.length > 0) {
          const session = await sessionStore.get(sessionId);
          csrfToken = session?.csrfToken ?? '';
        } else {
          const sessionCookie = request.cookies['du_admin'] ?? '';
          csrfToken = config.cookieSecret && sessionCookie
            ? deriveCsrfToken(config.cookieSecret, sessionCookie)
            : '';
        }
        return renderCryptoConfig(await resolve(request), csrfToken);
      } catch {
        return renderCryptoConfig({ status: 'error', code: 'CRYPTO_CONFIG_UNAVAILABLE' });
      }
    },
  };
}
/**
 * W-ADM-UX-03-AUDIT-ROUTE (Delta 130): GET /admin/audit - the audit ledger pane.
 *
 * Follows the same shape as handleCryptoConfigGet: role guard first, then
 * the shell chrome, then a deferred extras hook that calls the audit
 * fetcher and renders the pane. When no fetcher is wired the pane renders
 * an honest error state rather than a fake empty ledger.
 */
function handleAuditGet(
  requiredRole: 'admin' | 'operator' | 'viewer',
  request: AdminShellRequest,
  claims: AdminCookieClaims | null,
  config: ShellRuntimeConfig,
): AdminShellResponse {
  if (!claims) {
    return {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 401,
        title: 'Sign-in required',
        message: 'Sign in to view the Admin shell.',
      }),
    };
  }
  if (ROLE_ORDER[claims.role] < ROLE_ORDER[requiredRole]) {
    return {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 403,
        title: 'Access denied',
        message: 'Role ' + claims.role + ' is not authorized for the audit ledger (requires ' + requiredRole + ').',
      }),
    };
  }
  const view = buildAdminShellView({
    role: claims.role,
    path: request.pathname,
    navItems: getCanonicalNavItems(),
    dataAvailable: { kind: 'ready' },
  });
  const screen = buildScreenState({
    role: claims.role,
    section: null,
    dataAvailable: { kind: 'ready' },
  });
  return {
    status: 200,
    headers: { 'content-type': 'text/html; charset=utf-8' },
    body: renderShell(view, screen),
    deferredSectionExtras: async () => {
      const fetcher = config.sectionFetchers?.audit;
      if (!fetcher) {
        return renderAuditSection({
          fetch: {
            kind: 'error',
            message: 'Audit ledger is not wired. No section fetcher is configured.',
          },
        }).html;
      }
      try {
        const result = await fetcher({
          jsonBaseUrl: readJsonBaseUrlFromRequest(request) ?? 'http://127.0.0.1:0',
          adminToken: config.adminToken,
          listLimit: typeof request.query?.['limit'] === 'string'
            ? Number.parseInt(request.query['limit']!, 10)
            : undefined,
          cursor: typeof request.query?.['cursor'] === 'string' ? request.query['cursor'] : undefined,
          severityFilter: typeof request.query?.['severity'] === 'string' ? request.query['severity'] : undefined,
          actorFilter: typeof request.query?.['actor'] === 'string' ? request.query['actor'] : undefined,
          actionFilter: typeof request.query?.['action'] === 'string' ? request.query['action'] : undefined,
          resourceFilter: typeof request.query?.['resource'] === 'string' ? request.query['resource'] : undefined,
          fromFilter: typeof request.query?.['from'] === 'string' ? request.query['from'] : undefined,
          toFilter: typeof request.query?.['to'] === 'string' ? request.query['to'] : undefined,
          sortFilter: typeof request.query?.['sort'] === 'string' ? request.query['sort'] : undefined,
        });
        return renderAuditSection({ fetch: result }).html;
      } catch {
        return renderAuditSection({
          fetch: { kind: 'error', message: 'Audit ledger could not be loaded.' },
        }).html;
      }
    },
  };
}

/**
 * W-ADM-UX-08-SHELL (Delta 106): POST /admin/crypto-config - the pane form's
 * save. Three gates, in order, and the first one that fails decides the answer:
 *
 *   1. a valid signed cookie session, then role >= admin (same guard as the GET);
 *   2. the server-derived CSRF token, re-derived from the presented cookie and
 *      the shell secret with a constant-time compare. A cross-site form can SEND
 *      the cookie (SameSite=Strict is the first layer) but cannot compute the
 *      HMAC, so this is the gate that makes the mutation non-forgeable;
 *   3. only then the composition-root applier runs.
 *
 * A failed CSRF proof answers 403 and NEVER calls the applier, so a forged
 * request cannot even reach the validation that would have rejected it.
 */
function handleCryptoConfigPost(
  requiredRole: 'admin' | 'operator' | 'viewer',
  request: AdminShellRequest,
  claims: AdminCookieClaims | null,
  config: ShellRuntimeConfig,
  /**
   * W-ENC-08-CSRF-OIDC (Delta 113): the live session's server-side CSRF
   * token, supplied by the async session gate. Present => the SESSION plane
   * decides the proof, exactly as it decides identity: the token is checked
   * with the OIDC primitive and there is NO fallback to the legacy
   * du_admin derivation, because falling back would let a request that rides a
   * revoked-or-mismatched session plane authenticate against the other one.
   */
  oidcCsrfToken?: string,
): AdminShellResponse {
  if (!claims) {
    return {
      status: 401,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 401,
        title: 'Sign-in required',
        message: 'Sign in to view the Admin shell.',
      }),
    };
  }
  if (ROLE_ORDER[claims.role] < ROLE_ORDER[requiredRole]) {
    return {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 403,
        title: 'Access denied',
        message: `Role '${claims.role}' is not authorized to change crypto configuration (requires 'admin').`,
      }),
    };
  }
  const sessionCookie = request.cookies['du_admin'] ?? '';
  const provided = request.body['csrf'];
  // Delta 113: under an OIDC session the proof is the session's own token,
  // compared with the OIDC primitive (format check + constant time). The
  // narrowing is honest: verifySessionCsrf reads exactly one field, csrfToken,
  // and AdminSessionView is the projection that carries it. Reusing the real
  // primitive is the point — a hand-rolled second comparison is how the two
  // planes drift apart.
  const csrfOk = typeof oidcCsrfToken === 'string'
    ? verifySessionCsrf({ csrfToken: oidcCsrfToken } as SessionRecord, provided)
    : validateCsrfToken({
        secret: config.cookieSecret,
        sessionCookie,
        provided,
      });
  if (!csrfOk) {
    return {
      status: 403,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 403,
        title: 'Request rejected',
        message: 'Missing or invalid CSRF proof. Reload the page and try again.',
      }),
    };
  }

  const apply = cryptoConfigApplier(config);
  if (!apply) {
    return {
      status: 503,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 503,
        title: 'Not available',
        message: 'Crypto configuration changes are not available on this deployment.',
      }),
    };
  }
  const tenantId = (request.body['tenantId'] ?? '').trim();
  if (!tenantId) {
    return {
      status: 422,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 422,
        title: 'Invalid request',
        message: 'A tenant must be selected before changing crypto configuration.',
      }),
    };
  }
  // An unchecked checkbox sends nothing, so an absent field means OFF. That
  // asymmetry is the form's, not ours: a save that silently ignored the
  // toggle would be worse than one that turns it off.
  const deliveryRaw = request.body['deliveryEncryption'];
  const deliveryEncryption = deliveryRaw === 'on' || deliveryRaw === 'true';
  const versionRaw = (request.body['recipientKeyVersion'] ?? '').trim();
  const recipientKeyVersion = versionRaw === '' ? null : Number(versionRaw);
  if (recipientKeyVersion !== null && !Number.isSafeInteger(recipientKeyVersion)) {
    return {
      status: 422,
      headers: { 'content-type': 'text/html; charset=utf-8' },
      body: renderErrorPage({
        status: 422,
        title: 'Invalid request',
        message: 'The recipient key version is not a number.',
      }),
    };
  }
  // POST-redirect-GET: a reloaded save must not re-submit the mutation.
  return {
    status: 302,
    headers: {
      location: '/admin/crypto-config?tenantId=' + encodeURIComponent(tenantId),
      'content-type': 'text/html; charset=utf-8',
    },
    body: '',
    deferredSectionExtras: async () => {
      try {
        const pane = await apply({
          request,
          tenantId,
          storageKeyRef: request.body['storageKeyRef'],
          deliveryEncryption,
          recipientKeyVersion,
        });
        return renderCryptoConfig(pane);
      } catch {
        return renderCryptoConfig({ status: 'error', code: 'CRYPTO_CONFIG_SAVE_FAILED' });
      }
    },
  };
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

// ---------------------------------------------------------------------------
// OIDC-04 async mount: IdP-intercepted routes, layered OVER the pure
// sync dispatcher (which stays untouched and fully backward-compatible).
// ---------------------------------------------------------------------------

function toFlowRequest(request: AdminShellRequest): OidcFlowRequest {
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

function joinSetCookie(a: string | undefined, b: string | undefined): string | undefined {
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
type OpaqueSessionOutcome =
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
async function resolveOpaqueSession(
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

async function liveSessionClaims(
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
function sessionAuditEventFor(
  reason: AdminSessionDeadReason
): { kind: AdminSecurityEventKind; reason: 'expired_absolute' | 'expired_idle' | 'absent_or_revoked' } | undefined {
  if (reason === 'expired_absolute' || reason === 'expired_idle') return { kind: 'auth.session_expired', reason };
  if (reason === 'absent_or_revoked') return { kind: 'auth.session_revoked', reason };
  return undefined;
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
        return dispatchShellRequest(request, config, outcome.claims, outcome.csrfToken);
      }
      const sc = request.cookies[SESSION_COOKIE_NAME];
      const legacy = request.cookies['du_admin'];
      const hasSessionCookie = typeof sc === 'string' && sc.length > 0;
      const hasLegacyAdmin = typeof legacy === 'string' && legacy.length > 0;
      if (!hasSessionCookie && hasLegacyAdmin) {
        // legacy du_admin deployment coexistence: behavior unchanged
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
  return dispatchShellRequest(request, config);
}

// ---------------------------------------------------------------------------
// Re-exports used by tests
// ---------------------------------------------------------------------------

export { parseCookieHeader, parseFormBody };

// OIDC-04 type re-export for consumers building a ShellRuntimeConfig with a
// mounted flow (the flow itself lives in ./oidc-flow).
export type { OidcFlow, OidcFlowResponse };
