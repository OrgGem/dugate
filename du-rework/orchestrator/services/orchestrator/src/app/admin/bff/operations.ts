/**
 * BFF Operations / Usage / Business routes (AWEB-06).
 *
 *   GET  /admin/api/operations/metrics?tenant&from&to      → scoped Overview rollup
 *   GET  /admin/api/operations[/:id]                       → ops list/detail
 *   GET  /admin/api/usage?tenantId&from&to                 → usage summary
 *   GET  /admin/api/businesses[/:id/versions]              → registry reads
 *   GET  /admin/api/worker-instances?businessId&limit       → platform worker inventory
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
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { readBoundedBody } from './body';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHttpError } from '../../../http/errors';
import { AdminUsageEventQuerySchema } from '../../../modules/usage/usage';
import { BusinessEnableRequestSchema, UsageEventDrilldownQuerySchema, VersionActivationRequestSchema } from '@du/contracts';
import { authorizeAuditTenantRead } from '../../../modules/admin-actions/rbac';
import { SESSION_COOKIE_NAME } from '../../../modules/auth/session-store';
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
  | { kind: 'operation-upload' }
  | { kind: 'operations-metrics' }
  | { kind: 'operation-detail'; id: string }
  | { kind: 'operation-deliveries'; id: string }
  | { kind: 'operation-download'; id: string }
  | { kind: 'operation-action'; id: string; action: 'cancel' | 'retry' | 'resume' }
  | { kind: 'usage' }
  | { kind: 'usage-events' }
  | { kind: 'usage-export' }
  | { kind: 'businesses' }
  | { kind: 'worker-instances' }
  | { kind: 'business-versions'; businessId: string }
  | { kind: 'business-enable'; businessId: string }
  | { kind: 'business-action'; businessId: string; version: string; action: 'enable' | 'activate' | 'deactivate' | 'pre-drain' | 'pre-drain/cancel' }
  | { kind: 'invalid' };

const OPERATIONS_PARAM_ALLOWLIST = [
  'limit', 'cursor', 'state', 'tenant', 'id', 'sort', 'from', 'to',
  'business', 'action', 'apiKey', 'profile', 'correlation', 'provider', 'model',
  'usage', 'reservation', 'attention',
] as const;
const BUSINESS_PARAM_ALLOWLIST = ['limit', 'cursor', 'sort'] as const;

export function matchOperationsRoute(relative: string): OperationsRoute | null {
  if (relative === '/operations/uploads') return { kind: 'operation-upload' };
  if (relative === '/operations/metrics') return { kind: 'operations-metrics' };
  if (relative === '/operations') return { kind: 'operations-list' };
  const control = /^\/operations\/([^/]+)\/(cancel|retry|resume)$/.exec(relative);
  if (control) {
    const id = decodePathSegment(control[1] ?? '');
    return id === null ? { kind: 'invalid' } : { kind: 'operation-action', id, action: control[2] as 'cancel' | 'retry' | 'resume' };
  }
  const deliveries = /^\/operations\/([^/]+)\/deliveries$/.exec(relative);
  if(deliveries) {const id=decodePathSegment(deliveries[1] ?? '');return id===null?{kind:'invalid'}:{kind:'operation-deliveries',id};}
  const download = /^\/operations\/([^/]+)\/download$/.exec(relative);
  if (download) {
    const id = decodePathSegment(download[1] ?? '');
    return id === null ? { kind: 'invalid' } : { kind: 'operation-download', id };
  }
  const opMatch = /^\/operations\/([^/]+)$/.exec(relative);
  if (opMatch) {
    const id = decodePathSegment(opMatch[1] ?? '');
    return id === null ? { kind: 'invalid' } : { kind: 'operation-detail', id };
  }
  if (relative === '/usage/export') return { kind: 'usage-export' };
  if (relative === '/usage/events') return { kind: 'usage-events' };
  if (relative === '/usage') return { kind: 'usage' };
  if (relative === '/businesses') return { kind: 'businesses' };
  if (relative === '/worker-instances') return { kind: 'worker-instances' };
  const versionsMatch = /^\/businesses\/([^/]+)\/versions$/.exec(relative);
  if (versionsMatch) {
    const businessId = decodePathSegment(versionsMatch[1] ?? '');
    return businessId === null ? { kind: 'invalid' } : { kind: 'business-versions', businessId };
  }
  const businessEnableMatch = /^\/businesses\/([^/]+)\/enabled$/.exec(relative);
  if (businessEnableMatch) {
    const businessId = decodePathSegment(businessEnableMatch[1] ?? '');
    return businessId === null ? { kind: 'invalid' } : { kind: 'business-enable', businessId };
  }
  const actionMatch = /^\/businesses\/([^/]+)\/versions\/([^/]+)\/(enable|activate|deactivate|pre-drain(?:\/cancel)?)$/.exec(relative);
  if (actionMatch) {
    const businessId = decodePathSegment(actionMatch[1] ?? '');
    const version = decodePathSegment(actionMatch[2] ?? '');
    const action = actionMatch[3] as 'enable' | 'activate' | 'deactivate' | 'pre-drain' | 'pre-drain/cancel';
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
  // Viewer sessions are read-only but still need an explicit tenant credential
  // for read routes. Their role remains `viewer` below and is enforced again
  // by the internal route; this only supplies the already server-held tenant.
  const principal = ctx.role === 'viewer' && ctx.principal.kind === 'unscoped' && ctx.tenantId
    ? { kind: 'tenant_operator' as const, tenantId: ctx.tenantId }
    : ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no admin principal', correlationId);
    return;
  }

  // Business registry + actions are platform-scoped on the upstream side.
  if (
    route.kind === 'businesses' ||
    route.kind === 'business-versions' ||
    route.kind === 'business-enable' ||
    route.kind === 'business-action' ||
    route.kind === 'worker-instances'
  ) {
    if (ctx.role !== 'admin' || principal.kind !== 'platform') {
      writeProblem(
        res,
        403,
        'ADMIN_CREDENTIAL_REQUIRED',
        route.kind === 'worker-instances'
          ? 'worker inventory is platform-scoped (admin session required)'
          : 'the business registry is platform-scoped (admin session required)',
        correlationId,
      );
      return;
    }
  }

  if (route.kind === 'operation-upload' || route.kind === 'operation-action' || (route.kind === 'operation-detail' && method === 'DELETE')) {
    if ((route.kind === 'operation-upload' || route.kind === 'operation-action') && method !== 'POST') { writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'operation actions are POST', correlationId); return; }
    if (ctx.role === 'viewer' || (route.kind === 'operation-action' && route.action === 'retry' && ctx.role !== 'admin')) {
      writeProblem(res, 403, 'PERMISSION_DENIED', 'role cannot perform this operation action', correlationId); return;
    }
    if (!ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) {
      writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId); return;
    }
  } else if (route.kind === 'business-action' || route.kind === 'business-enable') {
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
  const sessionProof = forwardedSessionProof(ctx, request);

  if (route.kind === 'operation-upload') {
    const upstream = new URL('/api/internal/operations/uploads', base);
    for (const name of ['tenantId', 'apiKeyId', 'fileName']) {
      const value = query.get(name);
      if (value !== null) upstream.searchParams.set(name, value);
    }
    const response = await callUpstream(runtime, upstream, { method: 'POST', credential, correlationId,
      streamBody: req, contentType: firstHeaderValue(req.headers['content-type']) ?? 'application/octet-stream',
      contentLength: firstHeaderValue(req.headers['content-length']),
      ...(sessionProof ? { sessionProof } : {}) });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'operation-action') {
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds limit', correlationId); return; }
    if (route.action !== 'resume' && raw.trim() !== '' && raw.trim() !== '{}') { writeProblem(res, 422, 'INVALID_SCHEMA', 'operation control does not accept request overrides', correlationId); return; }
    const response = await callUpstream(runtime, new URL(`/api/internal/operations/${encodeURIComponent(route.id)}/${route.action}`, base), {
      method: 'POST', credential, correlationId,
      jsonBody: raw.trim() || '{}',
      idempotencyKey: firstHeaderValue(req.headers['idempotency-key']) ?? undefined,
      ...(sessionProof ? { sessionProof } : {}),
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
    const upstream = new URL('/api/internal/operations', base);
    for (const name of OPERATIONS_PARAM_ALLOWLIST) {
      const value = query.get(name);
      if (value !== null && name !== 'tenant') upstream.searchParams.set(name, value);
    }
    if (scope !== '') upstream.searchParams.set('tenant', scope);
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId, ...(sessionProof ? { sessionProof } : {}) });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'operations-metrics') {
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
    const upstream = new URL('/api/internal/operations/metrics', base);
    for (const name of ['from', 'to'] as const) {
      const value = query.get(name);
      if (value !== null) upstream.searchParams.set(name, value);
    }
    if (scope !== '') upstream.searchParams.set('tenant', scope);
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId, ...(sessionProof ? { sessionProof } : {}) });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'operation-download') {
    const response = await callUpstream(runtime, new URL(`/api/internal/operations/${encodeURIComponent(route.id)}/download`, base), { method: 'GET', credential, correlationId, ...(sessionProof ? { sessionProof } : {}) });
    if (!response.ok) { await relayUpstream(res, response, correlationId); return; }
    res.statusCode = response.status;
    res.setHeader('content-type', response.headers.get('content-type') ?? 'application/octet-stream');
    res.setHeader('content-disposition', 'attachment');
    res.setHeader('x-content-type-options', 'nosniff');
    res.setHeader('cache-control', 'no-store');
    if (response.body) await pipeline(Readable.from(response.body as unknown as AsyncIterable<Uint8Array>), res);
    else res.end();
    return;
  }

  if(route.kind === 'operation-deliveries') {
    const response=await callUpstream(runtime,new URL(`/api/internal/operations/${encodeURIComponent(route.id)}/deliveries`,base),{method:'GET',credential,correlationId,...(sessionProof?{sessionProof}:{})});
    await relayUpstream(res,response,correlationId);return;
  }
  if (route.kind === 'operation-detail') {
    const upstream = new URL(`/api/internal/operations/${encodeURIComponent(route.id)}`, base);
    const response = await callUpstream(runtime, upstream, {
      method: method === 'DELETE' ? 'DELETE' : 'GET',
      credential,
      correlationId,
      ...(method === 'DELETE' ? { idempotencyKey: firstHeaderValue(req.headers['idempotency-key']) ?? undefined } : {}),
      ...(sessionProof ? { sessionProof } : {}),
    });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'usage-export') {
    const allowed = new Set(['tenantId', 'apiKeyId', 'businessId', 'action', 'profileRevision', 'provider', 'model', 'operationId', 'from', 'to', 'timeField', 'limit', 'cursor']);
    const raw: Record<string, unknown> = {};
    for (const [name, value] of query.entries()) {
      if (!allowed.has(name) || Object.prototype.hasOwnProperty.call(raw, name)) {
        writeProblem(res, 422, 'INVALID_SCHEMA', 'usage export query contains an unsupported or repeated parameter', correlationId);
        return;
      }
      if (name === 'limit' || name === 'profileRevision') {
        if (!/^\d+$/.test(value)) {
          writeProblem(res, 422, 'INVALID_SCHEMA', `usage export ${name} must be an integer`, correlationId);
          return;
        }
        raw[name] = Number(value);
      } else raw[name] = value;
    }
    const parsed = UsageEventDrilldownQuerySchema.safeParse(raw);
    if (!parsed.success) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'usage export query is invalid or exceeds its supported window', correlationId);
      return;
    }
    let scope: string;
    try {
      scope = authorizeAuditTenantRead(rbacPrincipal(principal), parsed.data.tenantId ?? '');
    } catch (err) {
      if (isHttpError(err)) {
        writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
        return;
      }
      throw err;
    }
    if (scope === '') {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'usage export requires a tenantId for platform sessions', correlationId);
      return;
    }
    const upstream = new URL('/api/internal/usage/export', base);
    upstream.searchParams.set('tenantId', scope);
    for (const name of ['apiKeyId', 'businessId', 'action', 'profileRevision', 'provider', 'model', 'operationId', 'from', 'to', 'timeField', 'limit', 'cursor'] as const) {
      const value = parsed.data[name];
      if (value !== undefined) upstream.searchParams.set(name, String(value));
    }
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId, ...(sessionProof ? { sessionProof } : {}) });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'usage-events') {
    const allowed = new Set(['tenantId', 'from', 'to', 'timeField', 'limit', 'cursor', 'operationId', 'provider', 'model']);
    const raw: Record<string, unknown> = {};
    for (const [name, value] of query.entries()) {
      if (!allowed.has(name) || Object.prototype.hasOwnProperty.call(raw, name)) {
        writeProblem(res, 422, 'INVALID_SCHEMA', 'usage event query contains an unsupported or repeated parameter', correlationId);
        return;
      }
      if (name === 'limit') {
        if (!/^\d+$/.test(value)) {
          writeProblem(res, 422, 'INVALID_SCHEMA', 'usage event limit must be an integer', correlationId);
          return;
        }
        raw[name] = Number(value);
      } else {
        raw[name] = value;
      }
    }
    const parsed = AdminUsageEventQuerySchema.safeParse(raw);
    if (!parsed.success) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'usage event query is invalid or exceeds its supported window', correlationId);
      return;
    }
    let scope: string;
    try {
      scope = authorizeAuditTenantRead(rbacPrincipal(principal), parsed.data.tenantId ?? '');
    } catch (err) {
      if (isHttpError(err)) {
        writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
        return;
      }
      throw err;
    }
    if (scope === '') {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'usage event list requires a tenantId for platform sessions', correlationId);
      return;
    }
    const upstream = new URL('/api/internal/usage/events', base);
    upstream.searchParams.set('tenantId', scope);
    for (const name of ['from', 'to', 'timeField', 'limit', 'cursor', 'operationId', 'provider', 'model'] as const) {
      const value = parsed.data[name];
      if (value !== undefined) upstream.searchParams.set(name, String(value));
    }
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId, ...(sessionProof ? { sessionProof } : {}) });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'usage') {
    const usageValues = new Map<string, string>();
    for (const [name, value] of query.entries()) {
      if (!['tenantId', 'from', 'to'].includes(name) || usageValues.has(name)) {
        writeProblem(res, 422, 'INVALID_SCHEMA', 'usage summary query contains an unsupported or repeated parameter', correlationId);
        return;
      }
      usageValues.set(name, value);
    }
    const from = usageValues.get('from') ?? null;
    const to = usageValues.get('to') ?? null;
    if (from === null || to === null) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'usage requires from and to query parameters', correlationId);
      return;
    }
    let scope: string;
    try {
      scope = authorizeAuditTenantRead(rbacPrincipal(principal), usageValues.get('tenantId') ?? '');
    } catch (err) {
      if (isHttpError(err)) {
        writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
        return;
      }
      throw err;
    }
    if (scope === '') {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'usage requires a tenantId for platform sessions', correlationId);
      return;
    }
    // The internal endpoint preserves the validated opaque session and can
    // apply a live local USER assignment fence to the same summary rows used
    // by the Operations event list. Public/legacy usage routes stay unchanged.
    const upstream = new URL('/api/internal/usage/summary', base);
    upstream.searchParams.set('from', from);
    upstream.searchParams.set('to', to);
    if (scope !== '') upstream.searchParams.set('tenantId', scope);
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId, ...(sessionProof ? { sessionProof } : {}) });
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

  if (route.kind === 'worker-instances') {
    const upstream = new URL('/api/v1/admin/worker-instances', base);
    for (const name of ['businessId', 'limit'] as const) {
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

  if (route.kind === 'business-enable') {
    const raw = await readBoundedBody(req);
    if (raw === null) {
      writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds limit', correlationId);
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'business lifecycle body must be valid JSON', correlationId);
      return;
    }
    const parsed = BusinessEnableRequestSchema.safeParse(body);
    if (!parsed.success) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'business lifecycle request is invalid', correlationId);
      return;
    }
    const response = await callUpstream(runtime,
      new URL(`/api/v1/admin/businesses/${encodeURIComponent(route.businessId)}/enabled`, base),
      { method: 'PUT', credential, correlationId, jsonBody: JSON.stringify(parsed.data) },
    );
    await relayUpstream(res, response, correlationId);
    return;
  }

  // Version routing mutations carry the revision seen on the list response.
  // An omitted or stale revision is never converted into an unconditional
  // activation by this BFF.
  const actionBody = await readBoundedBody(req);
  if (actionBody === null) {
    writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds limit', correlationId);
    return;
  }
  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(actionBody || '{}');
  } catch {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'business version action payload is invalid', correlationId);
    return;
  }
  const parsed = VersionActivationRequestSchema.safeParse(parsedBody);
  if (!parsed.success) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'expectedActivationRevision is required', correlationId);
    return;
  }
  const jsonBody = JSON.stringify(parsed.data);
  // business-action (upstream verb is PUT)
  const upstream = new URL(
    `/api/v1/admin/businesses/${encodeURIComponent(route.businessId)}/versions/${encodeURIComponent(route.version)}/${route.action}`,
    base,
  );
  const response = await callUpstream(runtime, upstream, { method: 'PUT', credential, correlationId, jsonBody });
  await relayUpstream(res, response, correlationId);
}

function forwardedSessionProof(
  ctx: Awaited<ReturnType<typeof resolveBffContext>> & {},
  request: AdminShellRequest,
): { cookie: string; csrfToken: string } | undefined {
  if (!ctx || ctx.plane !== 'oidc') return undefined;
  const sessionId = request.cookies[SESSION_COOKIE_NAME];
  if (!sessionId) return undefined;
  return { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`, csrfToken: ctx.csrfToken };
}
