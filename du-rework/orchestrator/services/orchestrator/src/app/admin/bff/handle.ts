import { handleMigrationReadinessRoute, matchMigrationReadinessRoute } from './legacy-migration';
/**
 * Admin Web BFF — `/admin/api/*` (AWEB-02/04/05).
 *
 * Same-origin JSON surface for the React Admin Web. Every route resolves the
 * shell session server-side (context.ts) and acts with the SESSION's
 * principal:
 *
 *   GET  /admin/api/session            → principal/role/scope/CSRF (no-store)
 *   GET  /admin/api/audit              → tenant-fenced audit read (ACUI-M07)
 *   GET  /admin/api/api-keys[/:id]     → principal-aware key reads
 *   GET  /admin/api/tenants            → platform roster or tenant-operator own row
 *   GET  /admin/api/connectors         → connector list (CONNECTOR-WIRE-B)
 *   GET  /admin/api/connectors/capabilities → composition-derived capabilities
 *   GET  /admin/api/connectors/:id/revisions/:rev → connector revision read
 *   GET  /admin/api/profiles/:b/:v/:n  → profile read (viewer gate T-UI-05)
 *   POST /admin/api/profiles/...       → profile mutations via dispatcher
 *   POST /admin/api/actions            → CSRF-gated admin mutation
 *   GET  /admin/api/settings           → settings read; writer is disabled
 *   GET/POST/PATCH /admin/api/identity → identity read + CAS-guarded writes
 *
 * Profile-specific logic lives in ./profiles; upstream plumbing in ./upstream.
 * Responses are problem+json on every failure; upstream bodies are never
 * echoed raw; no token, cookie or CSRF value is ever logged.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@du/observability';
import { withMintedRawKey } from './key-minting';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { isHttpError } from '../../../http/errors';
import { authorizeAuditTenantRead } from '../../../modules/admin-actions/rbac';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import { BffError, boundedMessage } from './envelope';
import {
  callUpstream,
  credentialFor,
  decodePathSegment,
  firstHeaderValue,
  rbacPrincipal,
  relayUpstream,
  writeJson,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';
import { handleProfilesRoute, matchProfilesRoute } from './profiles';
import { handleOperationsRoute, matchOperationsRoute } from './operations';
import { handleSecurityRoute, matchSecurityRoute } from './security';
import { handleSettingsRoute, matchSettingsRoute } from './settings';
import { handleIdentityRoute, matchIdentityRoute } from './identity';
import { handleSecretsRoute, matchSecretsRoute } from './secrets';
import { handleHealthRoute } from './health';
import { handleComposeRoute, matchComposeRoute } from './compose';
import { handleGlobalSettingsRoute, matchGlobalSettingsRoute } from './global-settings';
import { handleIncidentsRoute, matchIncidentsRoute } from './incidents';
import { handleWorkflowImportRoute, matchWorkflowImportRoute } from './workflow-import';
import { handleAdminWorkbenchRoute, matchAdminWorkbenchRoute } from './admin-workbench';
import { handleParityRoute, matchParityRoute } from './parity';
import { handleMaintenanceRoute, matchMaintenanceRoute } from './maintenance';
import { handleCostControlRoute, matchCostControlRoute } from './cost-control';
import { handleCostAdjustmentRoute, matchCostAdjustmentRoute } from './cost-adjustments';
import { handleCostAlertsRoute, matchCostAlertsRoute } from './cost-alerts';
import { handleProfileGroupsRoute, matchProfileGroupsRoute } from './profile-groups';
import { handleProfileGroupsV2Route, matchProfileGroupsV2Route } from './profile-groups-v2';

const logger = createLogger({ service: 'orchestrator', baseFields: { subsystem: 'admin-bff' } });

export const BFF_BASE_PATH = '/admin/api';
export type { BffRuntimeConfig } from './upstream';

export function isBffPath(pathname: string): boolean {
  return pathname === BFF_BASE_PATH || pathname.startsWith(BFF_BASE_PATH + '/');
}

const AUDIT_PARAM_ALLOWLIST = [
  'limit',
  'cursor',
  'severity',
  'action',
  'actor',
  'resource',
  'from',
  'to',
  'sort',
] as const;
const API_KEY_PARAM_ALLOWLIST = ['limit', 'cursor', 'status', 'prefix', 'sort'] as const;
const TENANT_PARAM_ALLOWLIST = ['limit', 'cursor'] as const;
const MAX_ACTION_LENGTH = 128;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export async function handleBffRequest(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  try {
    const method = (req.method ?? 'GET').toUpperCase();
    const relative = normalizeRelative(request.pathname);
    if (relative === '/session') {
      assertMethod(method, ['GET']);
      return await handleSession(res, request, config, correlationId);
    }
    if (relative === '/health') {
      assertMethod(method, ['GET']);
      return await handleHealthRoute(res, request, config, runtime, correlationId);
    }
    const globalSettingsRoute = matchGlobalSettingsRoute(relative);
    if (globalSettingsRoute !== null) {
      return await handleGlobalSettingsRoute(req, res, request, globalSettingsRoute, query, config, runtime, correlationId);
    }
    const incidentsRoute = matchIncidentsRoute(relative);
    if (incidentsRoute !== null) {
      return await handleIncidentsRoute(req, res, request, incidentsRoute, query, config, runtime, correlationId);
    }
    const workflowImportRoute = matchWorkflowImportRoute(relative);
    if (workflowImportRoute !== null) {
      return await handleWorkflowImportRoute(req, res, request, workflowImportRoute, query, config, runtime, correlationId);
    }
    const adminWorkbenchRoute = matchAdminWorkbenchRoute(relative);
    if (adminWorkbenchRoute !== null) {
      return await handleAdminWorkbenchRoute(req, res, request, adminWorkbenchRoute, query, config, runtime, correlationId);
    }
    const parityRoute = matchParityRoute(relative);
    if (parityRoute !== null) {
      return await handleParityRoute(req, res, request, parityRoute, query, config, runtime, correlationId);
    }
    const maintenanceRoute = matchMaintenanceRoute(relative);
    if (maintenanceRoute !== null) {
      return await handleMaintenanceRoute(req, res, request, maintenanceRoute, query, config, runtime, correlationId);
    }
    const costControlRoute = matchCostControlRoute(relative);
    if (costControlRoute !== null) {
      return await handleCostControlRoute(req, res, request, costControlRoute, query, config, runtime, correlationId);
    }
    const costAdjustmentRoute = matchCostAdjustmentRoute(relative);
    if (costAdjustmentRoute !== null) {
      return await handleCostAdjustmentRoute(req, res, request, costAdjustmentRoute, query, config, runtime, correlationId);
    }
    const costAlertsRoute = matchCostAlertsRoute(relative);
    if (costAlertsRoute !== null) {
      return await handleCostAlertsRoute(req, res, request, costAlertsRoute, query, config, runtime, correlationId);
    }
    // PC-08: the V2 family MUST be matched before the v1 family — the v1
    // matcher answers `{kind:'invalid'}` (404) for `/profile-groups/v2`, so a
    // later position would make every V2 route unreachable.
    const profileGroupsV2Route = matchProfileGroupsV2Route(relative);
    if (profileGroupsV2Route !== null) {
      return await handleProfileGroupsV2Route(req, res, request, profileGroupsV2Route, query, config, runtime, correlationId);
    }
    const profileGroupsRoute = matchProfileGroupsRoute(relative);
    if (profileGroupsRoute !== null) {
      return await handleProfileGroupsRoute(req, res, request, profileGroupsRoute, query, config, runtime, correlationId);
    }
    if (relative === '/audit') {
      assertMethod(method, ['GET']);
      return await handleAudit(res, request, query, config, runtime, correlationId);
    }
    if (relative === '/tenants') {
      assertMethod(method, ['GET']);
      return await handleTenantRead(res, request, query, config, runtime, correlationId);
    }
    if (relative === '/api-keys' || relative.startsWith('/api-keys/')) {
      assertMethod(method, ['GET']);
      return await handleApiKeys(res, request, relative, query, config, runtime, correlationId);
    }
    if (relative === '/workflows' || relative.startsWith('/workflows/')) {
      assertMethod(method, ['GET']);
      return await handleWorkflowsRead(res, request, relative, query, config, runtime, correlationId);
    }
    // Worker inventory is matched by operations.ts below, which enforces
    // platform-admin scope before forwarding credentials.
    // CONNECTOR-WIRE-B: connector management reads. Matched BEFORE the
    // revision pattern so `/connectors/capabilities` can never be read as a
    // connector id.
    if (relative === '/connectors' || relative === '/connectors/capabilities') {
      assertMethod(method, ['GET']);
      return await handleConnectorRead(
        res,
        request,
        relative === '/connectors' ? 'list' : 'capabilities',
        config,
        runtime,
        correlationId,
      );
    }
    const connectorMatch = /^\/connectors\/([^/]+)\/revisions\/([^/]+)$/.exec(relative);
    if (connectorMatch) {
      assertMethod(method, ['GET']);
      return await handleConnectorRevision(
        res,
        request,
        connectorMatch[1] ?? '',
        connectorMatch[2] ?? '',
        config,
        runtime,
        correlationId,
      );
    }
    const profilesRoute = matchProfilesRoute(relative);
    if (profilesRoute !== null) {
      return await handleProfilesRoute(
        req,
        res,
        request,
        profilesRoute,
        query,
        config,
        runtime,
        correlationId,
      );
    }
    const composeRoute = matchComposeRoute(relative);
    if (composeRoute !== null) {
      return await handleComposeRoute(req, res, request, composeRoute, query, config, runtime, correlationId);
    }
    const operationsRoute = matchOperationsRoute(relative);
    if (operationsRoute !== null) {
      return await handleOperationsRoute(
        req,
        res,
        request,
        operationsRoute,
        query,
        config,
        runtime,
        correlationId,
      );
    }
    const securityRoute = matchSecurityRoute(relative);
    if (securityRoute !== null) {
      return await handleSecurityRoute(
        req,
        res,
        request,
        securityRoute,
        query,
        config,
        runtime,
        correlationId,
      );
    }
    const migrationRoute = matchMigrationReadinessRoute(relative);
    if(migrationRoute !== null) return await handleMigrationReadinessRoute(req,res,request,migrationRoute,query,config,runtime,correlationId);
    const settingsRoute = matchSettingsRoute(relative);
    if (settingsRoute !== null) {
      return await handleSettingsRoute(
        req,
        res,
        request,
        settingsRoute,
        query,
        config,
        runtime,
        correlationId,
      );
    }
    const identityRoute = matchIdentityRoute(relative);
    if (identityRoute !== null) {
      return await handleIdentityRoute(
        req,
        res,
        request,
        identityRoute,
        query,
        config,
        runtime,
        correlationId,
      );
    }
    const secretsRoute = matchSecretsRoute(relative);
    if (secretsRoute !== null) {
      return await handleSecretsRoute(
        req,
        res,
        request,
        secretsRoute,
        query,
        config,
        runtime,
        correlationId,
      );
    }
    if (relative === '/actions') {
      assertMethod(method, ['POST']);
      return await handleActions(req, res, request, config, runtime, correlationId);
    }
    writeProblem(res, 404, 'NOT_FOUND', 'no Admin BFF route matches this request', correlationId);
  } catch (err) {
    if (err instanceof BffError) {
      writeProblem(res, err.status, err.code, err.message, correlationId);
      return;
    }
    if (err instanceof Error && err.name === 'UpstreamUnavailableError') {
      writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is unavailable', correlationId);
      return;
    }
    logger.error('[admin-bff] unhandled request error', {
      correlationId,
      errorClass: err instanceof Error ? err.name : typeof err,
    });
    writeProblem(res, 500, 'INTERNAL_ERROR', 'the Admin BFF failed to complete the request', correlationId);
  }
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

async function handleSession(
  res: ServerResponse,
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  writeJson(
    res,
    200,
    {
      schemaVersion: '1',
      plane: ctx.plane,
      role: ctx.role,
      principal: { kind: ctx.principal.kind, tenantId: principalTenant(ctx) },
      scope: scopeOf(ctx),
      displayName: ctx.displayName,
      localUser: ctx.plane === 'oidc' && ctx.issuer === 'du-local' && ctx.role === 'operator',
      csrfToken: ctx.csrfToken,
    },
    correlationId,
  );
}

async function handleAudit(
  res: ServerResponse,
  request: AdminShellRequest,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  const principal = ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no admin principal', correlationId);
    return;
  }

  // Tenant fence (ACUI-M07): the tenant comes from the SESSION; a foreign
  // ?tenantId= is denied by the shared RBAC helper.
  let scope: string;
  try {
    scope = authorizeAuditTenantRead(rbacPrincipal(principal), query.get('tenantId') ?? '');
  } catch (err) {
    if (isHttpError(err)) {
      writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
      return;
    }
    throw err;
  }

  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const upstream = new URL('/api/v1/admin/audit', runtime.jsonBaseUrl);
  for (const name of AUDIT_PARAM_ALLOWLIST) {
    const value = query.get(name);
    if (value !== null) upstream.searchParams.set(name, value);
  }
  if (scope !== '') upstream.searchParams.set('tenantId', scope);
  else upstream.searchParams.delete('tenantId');

  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

async function handleApiKeys(
  res: ServerResponse,
  request: AdminShellRequest,
  relative: string,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  const principal = ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no admin principal', correlationId);
    return;
  }
  const keyId = relative === '/api-keys' ? null : decodePathSegment(relative.slice('/api-keys/'.length));
  if (relative !== '/api-keys' && keyId === null) {
    writeProblem(res, 404, 'NOT_FOUND', 'no API key matches this request', correlationId);
    return;
  }

  let scope: string;
  try {
    scope = authorizeAuditTenantRead(rbacPrincipal(principal), query.get('tenantId') ?? '');
  } catch (err) {
    if (isHttpError(err)) {
      writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
      return;
    }
    throw err;
  }

  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const upstream = new URL(
    '/api/v1/admin/api-keys' + (keyId === null ? '' : '/' + encodeURIComponent(keyId)),
    runtime.jsonBaseUrl,
  );
  for (const name of API_KEY_PARAM_ALLOWLIST) {
    const value = query.get(name);
    if (value !== null) upstream.searchParams.set(name, value);
  }
  if (scope !== '') upstream.searchParams.set('tenantId', scope);
  else upstream.searchParams.delete('tenantId');

  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

async function handleWorkflowsRead(
  res: ServerResponse,
  request: AdminShellRequest,
  relative: string,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  const principal = ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no admin principal', correlationId);
    return;
  }
  const slug = relative === '/workflows' ? null : decodePathSegment(relative.slice('/workflows/'.length));
  if (relative !== '/workflows' && slug === null) {
    writeProblem(res, 404, 'NOT_FOUND', 'no workflow matches this request', correlationId);
    return;
  }

  let scope: string;
  try {
    scope = authorizeAuditTenantRead(rbacPrincipal(principal), query.get('tenantId') ?? '');
  } catch (err) {
    if (isHttpError(err)) {
      writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
      return;
    }
    throw err;
  }

  const businessIds = query.getAll('businessId');
  const businessVersions = query.getAll('businessVersion');
  if (businessIds.length > 1 || businessVersions.length > 1) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'businessId and businessVersion must not be repeated', correlationId);
    return;
  }
  const businessId = businessIds[0]?.trim();
  const businessVersion = businessVersions[0]?.trim();
  if ((businessId !== undefined && businessId.length === 0)
      || (businessVersion !== undefined && businessVersion.length === 0)
      || (businessVersion !== undefined && businessId === undefined)
      || (businessId !== undefined && businessId.length > 256)
      || (businessVersion !== undefined && businessVersion.length > 128)) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'business filter is invalid', correlationId);
    return;
  }

  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const upstream = new URL(
    '/api/v1/admin/workflows' + (slug === null ? '' : '/' + encodeURIComponent(slug)),
    runtime.jsonBaseUrl,
  );
  if (scope !== '') {
    upstream.searchParams.set('tenantId', scope);
  } else if (query.get('tenantId')) {
    upstream.searchParams.set('tenantId', query.get('tenantId')!);
  }
  if (businessId !== undefined) upstream.searchParams.set('businessId', businessId);
  if (businessVersion !== undefined) upstream.searchParams.set('businessVersion', businessVersion);

  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

/**
 * The platform credential reads the full tenant directory; a tenant-operator
 * credential scopes upstream to that operator's own tenant. The browser's
 * tenantId/sort query values are intentionally not copied; only the contract's
 * pagination parameters (`limit` and `cursor`) pass through.
 */
/**
 * GET relay for platform admin reads that only needed a BFF hop.
 *
 * Same fence order as the api-keys and workflows reads: session, principal,
 * credential, configured upstream, then an ALLOWLISTED query copy. The
 * browser's own tenantId is deliberately NOT forwarded - a tenant-operator
 * session is already pinned upstream by its credential, and a platform
 * session must not have a browser-supplied value narrow or widen its view.
 */
async function handleAdminGetRelay(
  res: ServerResponse,
  request: AdminShellRequest,
  relative: string,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
  allowlist: string[],
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  const principal = ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no admin principal', correlationId);
    return;
  }
  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }
  const upstream = new URL('/api/v1/admin' + relative, runtime.jsonBaseUrl);
  for (const name of allowlist) {
    const value = query.get(name);
    if (value !== null && value.length > 0) upstream.searchParams.set(name, value);
  }
  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

async function handleTenantRead(
  res: ServerResponse,
  request: AdminShellRequest,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  const principal = ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'administrator role is required', correlationId);
    return;
  }
  const platformAdmin = ctx.role === 'admin' && principal.kind === 'platform';
  const tenantOperator = ctx.role === 'operator' && principal.kind === 'tenant_operator';
  if (!platformAdmin && !tenantOperator) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'administrator role is required', correlationId);
    return;
  }
  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const upstream = new URL('/api/v1/admin/tenants', runtime.jsonBaseUrl);
  for (const name of TENANT_PARAM_ALLOWLIST) {
    const value = query.get(name);
    if (value !== null) upstream.searchParams.set(name, value);
  }
  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

async function handleConnectorRevision(
  res: ServerResponse,
  request: AdminShellRequest,
  rawConnectorId: string,
  rawRevision: string,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  const principal = ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no admin principal', correlationId);
    return;
  }
  const connectorId = decodePathSegment(rawConnectorId);
  const revision = decodePathSegment(rawRevision);
  if (connectorId === null || revision === null) {
    writeProblem(res, 404, 'NOT_FOUND', 'no connector revision matches this request', correlationId);
    return;
  }

  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const upstream = new URL(
    `/api/v1/admin/connectors/${encodeURIComponent(connectorId)}/revisions/${encodeURIComponent(revision)}`,
    runtime.jsonBaseUrl,
  );
  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

/**
 * CONNECTOR-WIRE-B: connector management reads (`/connectors` list and the
 * composition-derived `/connectors/capabilities` advertisement).
 *
 * Both ride the PLATFORM bearer: the upstream admin routes are platform-only
 * (`assertAdminAuth` in http/routes/admin.ts), so a tenant/scoped session is
 * refused HERE rather than being handed a token the upstream can only reject.
 * Capabilities are booleans derived from boot composition — the UI gates
 * Save/Test/Activate on them instead of a static list, so a missing store
 * shows up as `management:false` (honest) rather than a fabricated button.
 * Query parameters are not forwarded: the upstream list takes none.
 */
async function handleConnectorRead(
  res: ServerResponse,
  request: AdminShellRequest,
  kind: 'list' | 'capabilities',
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  if (ctx.role !== 'admin' || ctx.principal.kind !== 'platform') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'administrator role is required', correlationId);
    return;
  }
  const credential = runtime.adminToken;
  if (typeof credential !== 'string' || credential.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const upstream = new URL(
    kind === 'list' ? '/api/v1/admin/connectors' : '/api/v1/admin/connectors/capabilities',
    runtime.jsonBaseUrl,
  );
  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

async function handleActions(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  const platformAdmin=ctx.role === 'admin' && ctx.principal.kind === 'platform';
  const callbackOperator=ctx.role === 'operator' && ctx.principal.kind === 'tenant_operator';
  if (!platformAdmin && !callbackOperator) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'administrator role is required', correlationId);
    return;
  }
  const provided = firstHeaderValue(req.headers['x-csrf-token']);
  if (!ctx.verifyCsrf(provided)) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
    return;
  }

  const raw = await readBoundedBody(req);
  if (raw === null) {
    writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId);
    return;
  }
  let parsed: unknown;
  try {
    parsed = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be a JSON object', correlationId);
    return;
  }
  const action = (parsed as { action?: unknown }).action;
  if (
    typeof action !== 'string' ||
    action.length === 0 ||
    action.length > MAX_ACTION_LENGTH ||
    !/^[a-z][a-z0-9_.]*$/.test(action)
  ) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'action must be a dotted lowercase identifier', correlationId);
    return;
  }
  if(!platformAdmin && !['operations.cancel','operations.resume','operations.callback.retry'].includes(action)) {
    writeProblem(res,403,'PERMISSION_DENIED','administrator role is required for this action',correlationId);return;
  }
  const rawParams = (parsed as { params?: unknown }).params;
  if (rawParams !== undefined && (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'params must be a JSON object when present', correlationId);
    return;
  }
  const params = (rawParams ?? {}) as Record<string, unknown>;

  // Key material is minted SERVER-side (./key-minting) for the two actions
  // whose raw value rides this wire; everything else is forwarded untouched.
  const forwardedParams = withMintedRawKey(action, params);

  const credential = ctx.principal.kind === 'unscoped' ? null : credentialFor(ctx.principal,runtime);
  if (typeof credential !== 'string' || credential.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const idempotencyKey = firstHeaderValue(req.headers['idempotency-key']);
  const upstream = new URL('/api/v1/admin/actions', runtime.jsonBaseUrl);
  const response = await callUpstream(runtime, upstream, {
    method: 'POST',
    credential,
    correlationId,
    jsonBody: JSON.stringify({ action, params: forwardedParams }),
    idempotencyKey:
      typeof idempotencyKey === 'string' && idempotencyKey.length > 0
        ? idempotencyKey.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH)
        : undefined,
  });
  await relayUpstream(res, response, correlationId, { wrapInData: true });
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function normalizeRelative(pathname: string): string {
  const relative = pathname.slice(BFF_BASE_PATH.length).replace(/\/+$/, '');
  return relative === '' ? '/' : relative;
}

function assertMethod(method: string, allowed: string[]): void {
  if (!allowed.includes(method)) {
    throw new BffError(405, 'METHOD_NOT_ALLOWED', `method ${method} is not allowed here`);
  }
}

function principalTenant(ctx: Awaited<ReturnType<typeof resolveBffContext>> & object): string | null {
  return ctx.principal.kind === 'tenant_operator' ? ctx.principal.tenantId : null;
}

function scopeOf(
  ctx: Awaited<ReturnType<typeof resolveBffContext>> & object,
): { kind: 'platform' } | { kind: 'tenant'; tenantId: string } | null {
  if (ctx.principal.kind === 'platform') return { kind: 'platform' };
  if (ctx.principal.kind === 'tenant_operator') return { kind: 'tenant', tenantId: ctx.principal.tenantId };
  return null;
}

function hasJsonBase(runtime: BffRuntimeConfig): runtime is BffRuntimeConfig & { jsonBaseUrl: string } {
  return typeof runtime.jsonBaseUrl === 'string' && runtime.jsonBaseUrl.length > 0;
}
