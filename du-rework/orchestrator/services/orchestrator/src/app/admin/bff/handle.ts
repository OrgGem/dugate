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

  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

/**
 * The platform credential reads the full tenant directory; a tenant-operator
 * credential scopes upstream to that operator's own tenant. The browser's
 * tenantId/sort query values are intentionally not copied; only the contract's
 * pagination parameters (`limit` and `cursor`) pass through.
 */
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
  if (ctx.role !== 'admin' || ctx.principal.kind !== 'platform') {
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
  const rawParams = (parsed as { params?: unknown }).params;
  if (rawParams !== undefined && (typeof rawParams !== 'object' || rawParams === null || Array.isArray(rawParams))) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'params must be a JSON object when present', correlationId);
    return;
  }
  const params = (rawParams ?? {}) as Record<string, unknown>;

  const credential = runtime.adminToken;
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
    jsonBody: JSON.stringify({ action, params }),
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
