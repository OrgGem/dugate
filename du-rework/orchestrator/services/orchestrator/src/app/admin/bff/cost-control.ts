import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  BudgetDraftWriteSchema,
  CostPolicyRollbackRequestSchema,
  CostPolicyTransitionRequestSchema,
  PriceDraftWriteSchema,
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TENANT_QUERY = new Set(['tenantId']);
export type CostControlRoute =
  | { kind: 'budget-list' }
  | { kind: 'budget-draft' }
  | { kind: 'price-list' }
  | { kind: 'price-draft' }
  | { kind: 'price-rollback' }
  | { kind: 'budget-detail'; budgetId: string }
  | { kind: 'budget-action'; budgetId: string; action: 'review' | 'publish' | 'retire' | 'rollback' }
  | { kind: 'price-action'; action: 'review' | 'publish' | 'retire' }
  | { kind: 'invalid' };

export function matchCostControlRoute(relative: string): CostControlRoute | null {
  if (relative === '/cost-control/budgets') return { kind: 'budget-list' };
  if (relative === '/cost-control/budgets/draft') return { kind: 'budget-draft' };
  const budgetAction = /^\/cost-control\/budgets\/([^/]+)\/(review|publish|retire|rollback)$/.exec(relative);
  if (budgetAction) {
    const budgetId = decodePathSegment(budgetAction[1] ?? '');
    return budgetId && UUID.test(budgetId)
      ? { kind: 'budget-action', budgetId, action: budgetAction[2] as 'review' | 'publish' | 'retire' | 'rollback' }
      : { kind: 'invalid' };
  }
  const budgetDetail = /^\/cost-control\/budgets\/([^/]+)$/.exec(relative);
  if (budgetDetail) {
    const budgetId = decodePathSegment(budgetDetail[1] ?? '');
    return budgetId && UUID.test(budgetId) ? { kind: 'budget-detail', budgetId } : { kind: 'invalid' };
  }
  if (relative === '/cost-control/prices') return { kind: 'price-list' };
  if (relative === '/cost-control/prices/draft') return { kind: 'price-draft' };
  if (relative === '/cost-control/prices/rollback') return { kind: 'price-rollback' };
  const priceAction = /^\/cost-control\/prices\/(review|publish|retire)$/.exec(relative);
  if (priceAction) return { kind: 'price-action', action: priceAction[1] as 'review' | 'publish' | 'retire' };
  return null;
}

function activeSessionProof(request: AdminShellRequest, ctx: Awaited<ReturnType<typeof resolveBffContext>>): { cookie: string; csrfToken: string } | undefined {
  if (!ctx) return undefined;
  if (ctx.plane === 'oidc') {
    const id = request.cookies['du_session'];
    return typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id)
      ? { cookie: `du_session=${encodeURIComponent(id)}`, csrfToken: ctx.csrfToken }
      : undefined;
  }
  const cookie = request.cookies['du_admin'];
  return typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 4096
    ? { cookie: `du_admin=${encodeURIComponent(cookie)}`, csrfToken: ctx.csrfToken }
    : undefined;
}

function tenantFromQuery(query: URLSearchParams, sessionTenant: string | null): { tenantId: string | null; invalid: boolean } {
  const values: Record<string, string> = {};
  for (const [key, value] of query.entries()) {
    if (!TENANT_QUERY.has(key) || Object.hasOwn(values, key)) return { tenantId: null, invalid: true };
    values[key] = value;
  }
  const tenantId = values.tenantId ?? sessionTenant;
  if (!tenantId || !UUID.test(tenantId)) return { tenantId: null, invalid: true };
  if (sessionTenant && sessionTenant !== tenantId) return { tenantId: null, invalid: true };
  return { tenantId, invalid: false };
}

export async function handleCostControlRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: CostControlRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (route.kind === 'invalid') { writeProblem(res, 404, 'NOT_FOUND', 'cost-control path is invalid', correlationId); return; }
  const reads = route.kind === 'budget-list' || route.kind === 'budget-detail' || route.kind === 'price-list';
  if ((reads && method !== 'GET') || (!reads && method !== 'POST')) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'cost-control reads require GET and policy changes require POST', correlationId); return;
  }
  const ctx = await resolveBffContext(config, request);
  if (!ctx) { writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId); return; }
  if (ctx.role === 'viewer' || ctx.principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'cost controls require a platform or tenant operator session', correlationId); return;
  }
  if (route.kind.startsWith('price-') && ctx.principal.kind !== 'platform') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'price book changes require platform Admin access', correlationId); return;
  }
  if (route.kind === 'budget-list' || route.kind === 'budget-detail') {
    const tenant = tenantFromQuery(query, ctx.principal.kind === 'tenant_operator' ? ctx.principal.tenantId : null);
    if (tenant.invalid || tenant.tenantId === null) { writeProblem(res, 422, 'INVALID_SCHEMA', 'a tenant scope is required and must match the session', correlationId); return; }
    const upstream = new URL(route.kind === 'budget-list'
      ? '/api/internal/cost-control/budgets'
      : `/api/internal/cost-control/budgets/${encodeURIComponent(route.budgetId)}`,
    runtime.jsonBaseUrl ?? 'http://invalid.local');
    upstream.searchParams.set('tenantId', tenant.tenantId);
    if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) { writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the Admin API is not configured', correlationId); return; }
    const credential = credentialFor(ctx.principal, runtime);
    if (!credential) { writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no Admin credential is configured for this session scope', correlationId); return; }
    const proof = activeSessionProof(request, ctx);
    await relayUpstream(res, await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId, ...(proof ? { sessionProof: proof } : {}) }), correlationId);
    return;
  }
  if (route.kind === 'price-list') {
    if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'price book read does not accept query parameters', correlationId); return; }
    const upstream = new URL('/api/internal/cost-control/prices', runtime.jsonBaseUrl ?? 'http://invalid.local');
    if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) { writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the Admin API is not configured', correlationId); return; }
    const credential = credentialFor(ctx.principal, runtime);
    if (!credential) { writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no Admin credential is configured for this session scope', correlationId); return; }
    const proof = activeSessionProof(request, ctx);
    await relayUpstream(res, await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId, ...(proof ? { sessionProof: proof } : {}) }), correlationId);
    return;
  }

  if (!ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) { writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId); return; }
  if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'cost-control mutations do not accept query parameters', correlationId); return; }
  const idempotencyKey = firstHeaderValue(req.headers['idempotency-key']);
  if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'mutations require a bounded Idempotency-Key header', correlationId); return;
  }
  const raw = await readBoundedBody(req);
  if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
  let value: unknown;
  try { value = raw.length === 0 ? null : JSON.parse(raw); } catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
  let schema: typeof BudgetDraftWriteSchema | typeof CostPolicyTransitionRequestSchema | typeof CostPolicyRollbackRequestSchema | typeof PriceDraftWriteSchema;
  if (route.kind === 'budget-draft') schema = BudgetDraftWriteSchema;
  else if (route.kind === 'price-draft') schema = PriceDraftWriteSchema;
  else if (route.kind === 'price-rollback' || (route.kind === 'budget-action' && route.action === 'rollback')) schema = CostPolicyRollbackRequestSchema;
  else schema = CostPolicyTransitionRequestSchema;
  const parsed = schema.safeParse(value);
  if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'cost-control mutation body is invalid', correlationId); return; }

  let upstreamPath: string;
  if (route.kind === 'budget-draft') {
    const configTenant = 'config' in parsed.data && typeof parsed.data.config === 'object' && parsed.data.config !== null
      ? (parsed.data.config as { tenantId?: unknown }).tenantId : null;
    if (typeof configTenant !== 'string' || !UUID.test(configTenant)
      || (ctx.principal.kind === 'tenant_operator' && configTenant !== ctx.principal.tenantId)) {
      writeProblem(res, 404, 'NOT_FOUND', 'not found', correlationId); return;
    }
    upstreamPath = '/api/internal/cost-control/budgets/draft';
  } else if (route.kind === 'budget-action') {
    upstreamPath = `/api/internal/cost-control/budgets/${encodeURIComponent(route.budgetId)}/${route.action}`;
    if (ctx.principal.kind === 'tenant_operator') {
      const scope = await tenantFromQuery(new URLSearchParams(`tenantId=${encodeURIComponent(ctx.principal.tenantId)}`), ctx.principal.tenantId);
      if (scope.invalid) { writeProblem(res, 404, 'NOT_FOUND', 'not found', correlationId); return; }
    }
  } else if (route.kind === 'price-draft') upstreamPath = '/api/internal/cost-control/prices/draft';
  else if (route.kind === 'price-rollback') upstreamPath = '/api/internal/cost-control/prices/rollback';
  else upstreamPath = `/api/internal/cost-control/prices/${route.action}`;
  const body = JSON.stringify(parsed.data);
  const tenantQuery = route.kind === 'budget-action' && ctx.principal.kind === 'tenant_operator'
    ? `?tenantId=${encodeURIComponent(ctx.principal.tenantId)}` : '';
  const upstream = new URL(`${upstreamPath}${tenantQuery}`, runtime.jsonBaseUrl ?? 'http://invalid.local');
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) { writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the Admin API is not configured', correlationId); return; }
  const credential = credentialFor(ctx.principal, runtime);
  if (!credential) { writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no Admin credential is configured for this session scope', correlationId); return; }
  const proof = activeSessionProof(request, ctx);
  if (!proof) { writeProblem(res, 401, 'UNAUTHENTICATED', 'the active Admin session proof is unavailable', correlationId); return; }
  await relayUpstream(res, await callUpstream(runtime, upstream, {
    method: 'POST', credential, correlationId, jsonBody: body, idempotencyKey, sessionProof: proof,
  }), correlationId);
}
