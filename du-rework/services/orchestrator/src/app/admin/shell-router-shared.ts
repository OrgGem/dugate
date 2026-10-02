/**
 * shell-router-shared - extracted from shell-router.ts by CONV-12.
 *
 * Declarations moved VERBATIM: no behaviour change, no signature change.
 * Shared types and pure query helpers live in ./shell-router-shared, which imports
 * nothing from this directory, so no module here imports shell-router.ts back - the
 * split adds no cycle. shell-router.ts re-exports every moved public name, so
 * server.ts, shell-server.ts, index.ts and the tests are untouched.
 */
import type { AdminShellRequest } from './shell-types';
import type { OidcFlow, OidcFlowRequest, OidcFlowResponse, OidcFlowSessionStore } from './oidc-flow';
import type { CryptoConfigPane } from './crypto-config-view-models';
import type {
  AdminSecurityAuditSink,
  AdminSecurityEventKind,
  AdminSessionDeadReason,
} from '../../modules/admin-actions/rbac';
import {
  fetchBusinessVersions,
} from './business-section-data';
import { fetchAuditEvents, type AuditFetchResult } from './audit-section-data';
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
  fetchConnectorConfig,
} from './connector-section-data';
import type {
  ConnectorFetchResult,
  ConnectorFetcherInput,
} from './connector-section-data';
import {
  fetchApiKeys,
} from './api-key-section-data';
import type {
  ApiKeyFetchResult,
  ApiKeyFetcherInput,
} from './api-key-section-data';
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
import type {
  OverviewFetchResult,
  OverviewFetcherInput,
  OverviewTimePreset,
} from './overview-section-data';

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
  /** Server-side bridge for browser Admin actions. Never exposed to the browser. */
  adminAction?: (action: string, params: Record<string, unknown>) => Promise<{ status: number; body: Record<string, unknown> }>;
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
