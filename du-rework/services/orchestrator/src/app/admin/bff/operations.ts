/**
 * BFF Operations / Usage / Business routes (AWEB-06).
 *
 *   GET  /admin/api/operations[/:id]                       → ops list/detail
 *   GET  /admin/api/usage?tenantId&from&to                 → usage summary
 *   GET  /admin/api/businesses[/:id/versions]              → registry reads
 *   PUT  /admin/api/businesses/:id/versions/:v/:action     → enable/activate/deactivate
 *
 * Fence (same rules as the platform's ADM-BASE-01/02 admin-bearer branches):
 *  - the tenant scope comes from the SESSION; a foreign `?tenant=` is 403 and
 *    operator sessions ride their own tenant credential — never platform;
 *  - the business registry is platform-scoped: operator/viewer get an explicit
 *    403 `ADMIN_CREDENTIAL_REQUIRED` instead of a silent upstream 401;
 *  - mutations (business actions) require admin + CSRF and are forwarded as-is
 *    (PUT) with the platform bearer. No fake capability is advertised.
 */
import { readBoundedBody } from './body';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHttpError } from '../../../http/errors';
import { authorizeAuditTenantRead } from '../../../modules/admin-actions/rbac';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import {
  boundedMessage,
  callUpstream,
  credentialFor,
  decodePathSegment,
  firstHeaderValue,
  rbacPrincipal,
  relayUpstream,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';

export type OperationsRoute =
  | { kind: 'operations-list' }
  | { kind: 'operation-detail'; id: string }
  | { kind: 'operation-action'; id: string; action: 'cancel' | 'retry' }
  | { kind: 'usage' }
  | { kind: 'businesses' }
  | { kind: 'business-versions'; businessId: string }
  | { kind: 'business-action'; businessId: string; version: string; action: 'enable' | 'activate' | 'deactivate' }
  | { kind: 'invalid' };

const OPERATIONS_PARAM_ALLOWLIST = ['limit', 'cursor', 'state', 'tenant', 'id', 'sort'] as const;
const BUSINESS_PARAM_ALLOWLIST = ['limit', 'cursor', 'sort'] as const;

export function matchOperationsRoute(relative: string): OperationsRoute | null {
  if (relative === '/operations') return { kind: 'operations-list' };
  const control = /^\/operations\/([^/]+)\/(cancel|retry)$/.exec(relative);
  if (control) {
    const id = decodePathSegment(control[1] ?? '');
    return id === null ? { kind: 'invalid' } : { kind: 'operation-action', id, action: control[2] as 'cancel' | 'retry' };
  }
  const opMatch = /^\/operations\/([^/]+)$/.exec(relative);
  if (opMatch) {
    const id = decodePathSegment(opMatch[1] ?? '');
    return id === null ? { kind: 'invalid' } : { kind: 'operation-detail', id };
  }
  if (relative === '/usage') return { kind: 'usage' };
  if (relative === '/businesses') return { kind: 'businesses' };
  const versionsMatch = /^\/businesses\/([^/]+)\/versions$/.exec(relative);
  if (versionsMatch) {
    const businessId = decodePathSegment(versionsMatch[1] ?? '');
    return businessId === null ? { kind: 'invalid' } : { kind: 'business-versions', businessId };
  }
  const actionMatch = /^\/businesses\/([^/]+)\/versions\/([^/]+)\/(enable|activate|deactivate)$/.exec(relative);
  if (actionMatch) {
    const businessId = decodePathSegment(actionMatch[1] ?? '');
    const version = decodePathSegment(actionMatch[2] ?? '');
    const action = actionMatch[3] as 'enable' | 'activate' | 'deactivate';
    if (businessId === null || version === null) return { kind: 'invalid' };
    return { kind: 'business-action', businessId, version, action };
  }
  return null;
}

export async function handleOperationsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: OperationsRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no Operations/Usage/Business route matches this request', correlationId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
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

  // Business registry + actions are platform-scoped on the upstream side.
  if (
    route.kind === 'businesses' ||
    route.kind === 'business-versions' ||
    route.kind === 'business-action'
  ) {
    if (ctx.role !== 'admin' || principal.kind !== 'platform') {
      writeProblem(
        res,
        403,
        'ADMIN_CREDENTIAL_REQUIRED',
        'the business registry is platform-scoped (admin session required)',
        correlationId,
      );
      return;
    }
  }

  if (route.kind === 'operation-action') {
    if (method !== 'POST') { writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'operation actions are POST', correlationId); return; }
    if (ctx.role === 'viewer' || (route.action === 'retry' && ctx.role !== 'admin')) {
      writeProblem(res, 403, 'PERMISSION_DENIED', 'role cannot perform this operation action', correlationId); return;
    }
    if (!ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) {
      writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId); return;
    }
  } else if (route.kind === 'business-action') {
    if (method !== 'PUT') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'business actions are PUT', correlationId);
      return;
    }
    const provided = firstHeaderValue(req.headers['x-csrf-token']);
    if (!ctx.verifyCsrf(provided)) {
      writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
      return;
    }
  } else if (method !== 'GET') {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', `method ${method} is not allowed here`, correlationId);
    return;
  }

  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
    return;
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }
  const base = runtime.jsonBaseUrl;

  if (route.kind === 'operation-action') {
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds limit', correlationId); return; }
    if (raw.trim() !== '' && raw.trim() !== '{}') { writeProblem(res, 422, 'INVALID_SCHEMA', 'operation control does not accept request overrides', correlationId); return; }
    const response = await callUpstream(runtime, new URL('/api/v1/admin/actions', base), {
      method: 'POST', credential, correlationId,
      jsonBody: JSON.stringify({ action: `operations.${route.action}`, params: { operationId: route.id } }),
      idempotencyKey: firstHeaderValue(req.headers['idempotency-key']) ?? undefined,
    });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'operations-list') {
    let scope: string;
    try {
      scope = authorizeAuditTenantRead(rbacPrincipal(principal), query.get('tenant') ?? '');
    } catch (err) {
      if (isHttpError(err)) {
        writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
        return;
      }
      throw err;
    }
    const upstream = new URL('/api/v1/operations', base);
    for (const name of OPERATIONS_PARAM_ALLOWLIST) {
      const value = query.get(name);
      if (value !== null && name !== 'tenant') upstream.searchParams.set(name, value);
    }
    if (scope !== '') upstream.searchParams.set('tenant', scope);
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'operation-detail') {
    const upstream = new URL(`/api/v1/operations/${encodeURIComponent(route.id)}`, base);
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'usage') {
    const from = query.get('from');
    const to = query.get('to');
    if (from === null || to === null) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'usage requires from and to query parameters', correlationId);
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
    const upstream = new URL('/api/v1/usage', base);
    upstream.searchParams.set('from', from);
    upstream.searchParams.set('to', to);
    if (scope !== '') upstream.searchParams.set('tenantId', scope);
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'businesses') {
    const upstream = new URL('/api/v1/admin/businesses', base);
    for (const name of BUSINESS_PARAM_ALLOWLIST) {
      const value = query.get(name);
      if (value !== null) upstream.searchParams.set(name, value);
    }
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'business-versions') {
    const upstream = new URL(`/api/v1/admin/businesses/${encodeURIComponent(route.businessId)}/versions`, base);
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    await relayUpstream(res, response, correlationId);
    return;
  }

  // business-action (upstream verb is PUT)
  const upstream = new URL(
    `/api/v1/admin/businesses/${encodeURIComponent(route.businessId)}/versions/${encodeURIComponent(route.version)}/${route.action}`,
    base,
  );
  const response = await callUpstream(runtime, upstream, { method: 'PUT', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}
