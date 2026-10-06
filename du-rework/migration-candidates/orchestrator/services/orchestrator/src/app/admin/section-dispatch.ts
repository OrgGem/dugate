/**
 * section-dispatch - extracted from shell-router.ts by CONV-12.
 *
 * Declarations moved VERBATIM: no behaviour change, no signature change.
 * Shared types and pure query helpers live in ./shell-router-shared, which imports
 * nothing from this directory, so no module here imports shell-router.ts back - the
 * split adds no cycle. shell-router.ts re-exports every moved public name, so
 * server.ts, shell-server.ts, index.ts and the tests are untouched.
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
import {
  renderErrorPage,
  renderLoginPage,
  renderShell,
} from './shell-render';
import { renderAuditSection } from './audit-section-renderer';
import type {
  ProfileFetchResult,
  ProfileFetcherInput,
} from './profile-section-data';
import {
  renderBusinessSection,
} from './business-section-renderer';
import {
  renderProfileSection,
} from './profile-section-renderer';
import type {
  ConnectorFetchResult,
  ConnectorFetcherInput,
} from './connector-section-data';
import {
  renderConnectorSection,
} from './connector-section-renderer';
import type {
  ApiKeyFetchResult,
  ApiKeyFetcherInput,
} from './api-key-section-data';
import {
  renderApiKeySection,
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
import type {
  OperationFetchResult,
  OperationFetcherInput,
} from './operation-section-data';
import {
  renderOperationSection,
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
import { handleCryptoConfigGet } from './crypto-config-dispatch';
import { csrfTokenForRequest } from './mutation-dispatch';
import { handleLoginGet } from './auth-dispatch';
import { parseOperationListQuery } from './shell-router-shared';
import type { ShellRuntimeConfig } from './shell-router-shared';


/**
 * GET /, GET /admin, GET /admin/<section> — section page or admin home.
 * Routes through the role guard and the four screen states.
 */
export function handleSectionGet(
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
export async function resolveBusinessExtras(
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
export async function resolveProfileExtras(
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
export async function resolveConnectorExtras(
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
    csrfToken: await csrfTokenForRequest(request, config),
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
export async function resolveApiKeyExtras(
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  role: 'admin' | 'operator' | 'viewer',
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
    csrfToken: await csrfTokenForRequest(request, config),
    canManage: role === 'admin',
  });
  return rendered.html;
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
export async function resolveOperationExtras(
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
export async function resolveOverviewExtras(
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

export function readBusinessIdFromRequest(request: AdminShellRequest): string {
  // The shell's `AdminShellRequest.query` carries the parsed
  // `?businessId=…` value. Empty when the request is to the bare
  // `/admin/businesses` URL; the renderer falls back to the
  // not-found pane until the platform exposes a list endpoint.
  const fromQuery = request.query?.['businessId'] ?? '';
  return fromQuery;
}

export function readJsonBaseUrlFromRequest(request: AdminShellRequest): string | undefined {
  // Optional override via query string (useful for staging). When
  // unset, the platform `attachAdminShell` configures the actual
  // base URL — the fetcher's `jsonBaseUrl` is what the orchestrator
  // passes in. Tests that want a custom URL inject it via
  // `sectionFetchers` directly, not via this hint.
  const host = request.query?.['jsonBaseUrl'];
  return host && host.length > 0 ? host : undefined;
}
/**
 * W-ADM-UX-03-AUDIT-ROUTE (Delta 130): GET /admin/audit - the audit ledger pane.
 *
 * Follows the same shape as handleCryptoConfigGet: role guard first, then
 * the shell chrome, then a deferred extras hook that calls the audit
 * fetcher and renders the pane. When no fetcher is wired the pane renders
 * an honest error state rather than a fake empty ledger.
 */
export function handleAuditGet(
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
