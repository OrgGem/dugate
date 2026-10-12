import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CostAdjustmentCommandSchema,
  CostAdjustmentEvidenceQuerySchema,
  CostAdjustmentQuerySchema,
} from '@du/contracts';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import {
  callUpstream,
  firstHeaderValue,
  relayUpstream,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_IDEMPOTENCY_KEY_LENGTH = 256;

export type CostAdjustmentRoute = 'history' | 'evidence' | 'invalid';

export function matchCostAdjustmentRoute(relative: string): CostAdjustmentRoute | null {
  if (relative === '/cost-control/adjustments') return 'history';
  if (relative === '/cost-control/adjustments/evidence') return 'evidence';
  return relative.startsWith('/cost-control/adjustments/') ? 'invalid' : null;
}

function collectQuery(query: URLSearchParams, allowed: ReadonlySet<string>): Record<string, string> | null {
  const values: Record<string, string> = {};
  for (const [key, value] of query.entries()) {
    if (!allowed.has(key) || Object.hasOwn(values, key)) return null;
    values[key] = value;
  }
  return values;
}

function sessionProof(request: AdminShellRequest, ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>) {
  if (ctx.plane === 'oidc') {
    const sessionId = request.cookies['du_session'];
    return typeof sessionId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(sessionId)
      ? { cookie: `du_session=${encodeURIComponent(sessionId)}`, csrfToken: ctx.csrfToken }
      : undefined;
  }
  const legacy = request.cookies['du_admin'];
  return typeof legacy === 'string' && legacy.length > 0 && legacy.length <= 4096
    ? { cookie: `du_admin=${encodeURIComponent(legacy)}`, csrfToken: ctx.csrfToken }
    : undefined;
}

function tenantForRead(rawTenant: string | undefined, ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): string | null {
  const scopedTenant = ctx.principal.kind === 'tenant_operator' ? ctx.principal.tenantId : null;
  const tenantId = rawTenant ?? scopedTenant;
  if (!tenantId || !UUID.test(tenantId) || (scopedTenant !== null && tenantId !== scopedTenant)) return null;
  return tenantId;
}

function isPlatformAdmin(ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): boolean {
  return ctx.role === 'admin' && ctx.principal.kind === 'platform' && ctx.tenantId === null;
}

function isOpaqueOidcPlatformAdmin(ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): boolean {
  return ctx.plane === 'oidc' && ctx.issuer !== null && ctx.issuer !== 'du-local'
    && isPlatformAdmin(ctx) && ctx.costAlertPrincipalId !== null && UUID.test(ctx.costAlertPrincipalId);
}

export async function handleCostAdjustmentRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: CostAdjustmentRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (route === 'invalid') { writeProblem(res, 404, 'NOT_FOUND', 'cost adjustment path is invalid', correlationId); return; }
  const read = route === 'evidence' || (route === 'history' && method === 'GET');
  const mutation = route === 'history' && method === 'POST';
  if ((!read && !mutation) || (route === 'evidence' && method !== 'GET')) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'financial history requires GET and adjustments require POST', correlationId); return;
  }
  const ctx = await resolveBffContext(config, request);
  if (!ctx) { writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId); return; }
  if (ctx.principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'financial access requires a scoped Admin session', correlationId); return;
  }
  if (mutation && !isOpaqueOidcPlatformAdmin(ctx)) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'financial adjustments require a verified platform Admin session', correlationId); return;
  }
  if (mutation && !ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId); return;
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the Admin API is not configured', correlationId); return;
  }
  const proof = sessionProof(request, ctx);
  if (!proof) { writeProblem(res, 401, 'UNAUTHENTICATED', 'the active Admin session proof is unavailable', correlationId); return; }

  let path: string;
  let upstreamQuery: Record<string, string> = {};
  let jsonBody: string | undefined;
  let idempotencyKey: string | undefined;
  if (read) {
    const allowed = route === 'history'
      ? new Set(['tenantId', 'rootEventId', 'limit', 'cursor'])
      : new Set(['tenantId', 'q', 'limit', 'cursor']);
    const values = collectQuery(query, allowed);
    if (!values) { writeProblem(res, 422, 'INVALID_SCHEMA', 'financial read query contains unsupported or repeated parameters', correlationId); return; }
    const tenantId = tenantForRead(values['tenantId'], ctx);
    if (!tenantId) { writeProblem(res, 404, 'NOT_FOUND', 'not found', correlationId); return; }
    if (route === 'history') {
      const parsed = CostAdjustmentQuerySchema.safeParse({ ...values, tenantId });
      if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'financial read query is invalid', correlationId); return; }
      path = '/api/internal/cost-control/adjustments';
      for (const [key, value] of Object.entries(parsed.data)) upstreamQuery[key] = String(value);
    } else {
      const parsed = CostAdjustmentEvidenceQuerySchema.safeParse({ ...values, tenantId });
      if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'financial read query is invalid', correlationId); return; }
      path = '/api/internal/cost-control/adjustments/evidence';
      for (const [key, value] of Object.entries(parsed.data)) upstreamQuery[key] = String(value);
    }
  } else {
    if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'financial adjustment does not accept query parameters', correlationId); return; }
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
    let value: unknown;
    try { value = raw.length === 0 ? null : JSON.parse(raw); }
    catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
    const parsed = CostAdjustmentCommandSchema.safeParse(value);
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'financial adjustment command is invalid', correlationId); return; }
    idempotencyKey = firstHeaderValue(req.headers['idempotency-key']);
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH
      || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'financial adjustment requires a bounded Idempotency-Key', correlationId); return;
    }
    jsonBody = JSON.stringify(parsed.data);
    path = '/api/internal/cost-control/adjustments';
  }

  const upstream = new URL(path, runtime.jsonBaseUrl);
  for (const [key, value] of Object.entries(upstreamQuery)) upstream.searchParams.set(key, value);
  await relayUpstream(res, await callUpstream(runtime, upstream, {
    method: read ? 'GET' : 'POST',
    correlationId,
    ...(jsonBody !== undefined ? { jsonBody } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    // Never attach a bearer alongside the cookie: the internal route must
    // revalidate the exact live Admin session and CSRF state.
    sessionProof: proof,
  }), correlationId);
}
