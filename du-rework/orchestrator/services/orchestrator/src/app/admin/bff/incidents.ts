import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  IncidentAcknowledgeRequestSchema,
  IncidentAssignRequestSchema,
  IncidentListQuerySchema,
  IncidentResolveRequestSchema,
  MaintenanceSuppressionCreateSchema,
} from '@du/contracts';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import {
  callUpstream,
  credentialFor,
  decodePathSegment,
  firstHeaderValue,
  relayUpstream,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';

export type IncidentsRoute = { kind: 'list' | 'suppressions' } | { kind: 'detail'; incidentId: string } |
  { kind: 'action'; incidentId: string; action: 'assign' | 'acknowledge' | 'resolve' } | { kind: 'invalid' };

export function matchIncidentsRoute(relative: string): IncidentsRoute | null {
  if (relative === '/incidents') return { kind: 'list' };
  if (relative === '/incidents/maintenance-suppressions') return { kind: 'suppressions' };
  const actionMatch = /^\/incidents\/([^/]+)\/(assign|acknowledge|resolve)$/.exec(relative);
  if (actionMatch) {
    const incidentId = decodePathSegment(actionMatch[1] ?? '');
    return incidentId && /^[0-9a-f-]{36}$/i.test(incidentId)
      ? { kind: 'action', incidentId, action: actionMatch[2] as 'assign' | 'acknowledge' | 'resolve' }
      : { kind: 'invalid' };
  }
  const detailMatch = /^\/incidents\/([^/]+)$/.exec(relative);
  if (detailMatch) {
    const incidentId = decodePathSegment(detailMatch[1] ?? '');
    return incidentId && /^[0-9a-f-]{36}$/i.test(incidentId) ? { kind: 'detail', incidentId } : { kind: 'invalid' };
  }
  return null;
}

const QUERY_ALLOWLIST = new Set(['tenantId', 'status', 'severity', 'source', 'search', 'limit', 'cursor']);
const BODY_SCHEMAS = {
  assign: IncidentAssignRequestSchema,
  acknowledge: IncidentAcknowledgeRequestSchema,
  resolve: IncidentResolveRequestSchema,
  suppression: MaintenanceSuppressionCreateSchema,
} as const;

function sessionProof(request: AdminShellRequest, csrfToken: string): { cookie: string; csrfToken: string } | undefined {
  if (typeof request.cookies['du_session'] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(request.cookies['du_session'])) {
    return { cookie: `du_session=${encodeURIComponent(request.cookies['du_session'])}`, csrfToken };
  }
  if (typeof request.cookies['du_admin'] === 'string' && request.cookies['du_admin'].length > 0 && request.cookies['du_admin'].length <= 4096) {
    return { cookie: `du_admin=${encodeURIComponent(request.cookies['du_admin'])}`, csrfToken };
  }
  return undefined;
}

export async function handleIncidentsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: IncidentsRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') { writeProblem(res, 404, 'NOT_FOUND', 'incident path is invalid', correlationId); return; }
  const method = (req.method ?? 'GET').toUpperCase();
  const read = route.kind === 'list' || route.kind === 'detail' || (route.kind === 'suppressions' && method === 'GET');
  if ((read && method !== 'GET') || (!read && method !== 'POST')) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'incident reads require GET and lifecycle changes require POST', correlationId); return;
  }
  const ctx = await resolveBffContext(config, request);
  if (!ctx) { writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId); return; }

  // Viewer sessions may read only the tenant recorded in their session. The
  // internal route receives a tenant-bound service credential, never a browser
  // supplied tenant or role. BFF mutations remain role and CSRF gated below.
  let scopedPrincipal = ctx.principal;
  if (scopedPrincipal.kind === 'unscoped' && ctx.role === 'viewer' && ctx.tenantId) {
    scopedPrincipal = { kind: 'tenant_operator', tenantId: ctx.tenantId };
  }
  if (scopedPrincipal.kind === 'unscoped') { writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no tenant or platform incident scope', correlationId); return; }

  const mutation = !read;
  if (mutation) {
    const csrf = firstHeaderValue(req.headers['x-csrf-token']);
    if (!ctx.verifyCsrf(csrf)) { writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId); return; }
    if (ctx.role === 'viewer') { writeProblem(res, 403, 'PERMISSION_DENIED', 'viewer sessions are read-only', correlationId); return; }
    if (route.kind === 'suppressions' && ctx.role === 'operator' && scopedPrincipal.kind !== 'tenant_operator') {
      writeProblem(res, 403, 'PERMISSION_DENIED', 'tenant maintenance suppression requires the session tenant scope', correlationId); return;
    }
  }

  let upstream: URL;
  let jsonBody: string | undefined;
  if (route.kind === 'list') {
    const raw: Record<string, unknown> = {};
    for (const [key, value] of query.entries()) {
      if (!QUERY_ALLOWLIST.has(key) || Object.prototype.hasOwnProperty.call(raw, key)) { writeProblem(res, 422, 'INVALID_SCHEMA', 'incident query contains an unsupported or repeated parameter', correlationId); return; }
      raw[key] = key === 'limit' && /^\d+$/.test(value) ? Number(value) : value;
      if (key === 'limit' && !/^\d+$/.test(value)) { writeProblem(res, 422, 'INVALID_SCHEMA', 'incident limit must be an integer', correlationId); return; }
    }
    const parsed = IncidentListQuerySchema.safeParse(raw);
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'incident query is invalid', correlationId); return; }
    upstream = new URL('/api/internal/incidents', runtime.jsonBaseUrl ?? 'http://invalid.local');
    for (const [key, value] of Object.entries(parsed.data)) if (value !== undefined) upstream.searchParams.set(key, String(value));
  } else if (route.kind === 'detail') {
    if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'incident detail does not accept query parameters', correlationId); return; }
    upstream = new URL(`/api/internal/incidents/${encodeURIComponent(route.incidentId)}`, runtime.jsonBaseUrl ?? 'http://invalid.local');
  } else if (route.kind === 'action') {
    if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'incident action does not accept query parameters', correlationId); return; }
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
    let value: unknown;
    try { value = raw.length === 0 ? null : JSON.parse(raw); } catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
    const parsed = BODY_SCHEMAS[route.action].safeParse(value);
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'incident action body is invalid', correlationId); return; }
    jsonBody = JSON.stringify(parsed.data);
    upstream = new URL(`/api/internal/incidents/${encodeURIComponent(route.incidentId)}/${route.action}`, runtime.jsonBaseUrl ?? 'http://invalid.local');
  } else {
    if (method === 'GET' && query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'maintenance suppressions do not accept query parameters', correlationId); return; }
    upstream = new URL('/api/internal/incidents/maintenance-suppressions', runtime.jsonBaseUrl ?? 'http://invalid.local');
    if (method === 'POST') {
      const raw = await readBoundedBody(req);
      if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
      let value: unknown;
      try { value = raw.length === 0 ? null : JSON.parse(raw); } catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
      const parsed = BODY_SCHEMAS.suppression.safeParse(value);
      if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'maintenance suppression body is invalid', correlationId); return; }
      jsonBody = JSON.stringify(parsed.data);
    }
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) { writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the Admin API is not configured', correlationId); return; }
  const credential = credentialFor(scopedPrincipal, runtime);
  if (!credential) { writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no Admin credential is configured for this session scope', correlationId); return; }
  // Preserve the authenticated opaque session for the internal authorization
  // boundary on reads as well as writes. In particular, a local USER is an
  // operator-shaped shell principal but has no incident-wide read grant;
  // bearer-only forwarding would erase the authoritative du-local issuer.
  const proof = sessionProof(request, ctx.csrfToken);
  const response = await callUpstream(runtime, upstream, {
    method: method as 'GET' | 'POST', credential, correlationId,
    ...(jsonBody !== undefined ? { jsonBody } : {}),
    ...(proof ? { sessionProof: proof } : {}),
  });
  await relayUpstream(res, response, correlationId);
}
