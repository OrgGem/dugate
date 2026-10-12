import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  CostAlertInboxQuerySchema,
  CostAlertListQuerySchema,
  CostAlertRecipientCatalogQuerySchema,
  CostAlertRecipientLifecycleWriteSchema,
  CostPolicyScopeCatalogQuerySchema,
  CostBudgetAlertBindingWriteSchema,
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

export type CostAlertsRoute =
  | { kind: 'alerts-list' }
  | { kind: 'channels' }
  | { kind: 'scope-catalog' }
  | { kind: 'binding-write' }
  | { kind: 'inbox-list' }
  | { kind: 'recipient-list' }
  | { kind: 'recipient-self' }
  | { kind: 'binding-read'; budgetId: string }
  | { kind: 'inbox-read'; alertId: string }
  | { kind: 'recipient-lifecycle'; principalId: string }
  | { kind: 'invalid' };

export function matchCostAlertsRoute(relative: string): CostAlertsRoute | null {
  if (relative === '/cost-alerts') return { kind: 'alerts-list' };
  if (relative === '/cost-alerts/channels') return { kind: 'channels' };
  if (relative === '/cost-alerts/scope-catalog') return { kind: 'scope-catalog' };
  if (relative === '/cost-alerts/bindings') return { kind: 'binding-write' };
  if (relative === '/cost-alerts/inbox') return { kind: 'inbox-list' };
  if (relative === '/cost-alerts/recipients') return { kind: 'recipient-list' };
  if (relative === '/cost-alerts/recipients/self') return { kind: 'recipient-self' };
  const recipientLifecycle = /^\/cost-alerts\/recipients\/([^/]+)\/lifecycle$/.exec(relative);
  if (recipientLifecycle) {
    const principalId = decodePathSegment(recipientLifecycle[1] ?? '');
    return principalId && UUID.test(principalId) ? { kind: 'recipient-lifecycle', principalId } : { kind: 'invalid' };
  }
  const inboxRead = /^\/cost-alerts\/inbox\/([^/]+)\/read$/.exec(relative);
  if (inboxRead) {
    const alertId = decodePathSegment(inboxRead[1] ?? '');
    return alertId && UUID.test(alertId) ? { kind: 'inbox-read', alertId } : { kind: 'invalid' };
  }
  const binding = /^\/cost-alerts\/bindings\/([^/]+)$/.exec(relative);
  if (binding) {
    const budgetId = decodePathSegment(binding[1] ?? '');
    return budgetId && UUID.test(budgetId) ? { kind: 'binding-read', budgetId } : { kind: 'invalid' };
  }
  return relative === '/cost-alerts' || relative.startsWith('/cost-alerts/') ? { kind: 'invalid' } : null;
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

function collectQuery(query: URLSearchParams, allowlist: ReadonlySet<string>): { values: Record<string, string> | null; invalid: boolean } {
  const values: Record<string, string> = {};
  for (const [key, value] of query.entries()) {
    if (!allowlist.has(key) || Object.hasOwn(values, key)) return { values: null, invalid: true };
    values[key] = value;
  }
  return { values, invalid: false };
}

function tenantScope(raw: string | undefined, sessionTenantId: string | null): string | null {
  const tenantId = raw ?? sessionTenantId ?? undefined;
  if (!tenantId || !UUID.test(tenantId) || (sessionTenantId !== null && sessionTenantId !== tenantId)) return null;
  return tenantId;
}

function toUpstreamQuery(url: URL, value: Record<string, unknown>): void {
  for (const [key, item] of Object.entries(value)) {
    if (item !== undefined) url.searchParams.set(key, String(item));
  }
}

function jsonLimit(raw: string | undefined): number | undefined | null {
  if (raw === undefined) return undefined;
  if (!/^\d{1,3}$/.test(raw)) return null;
  return Number(raw);
}

function inboxBoolean(raw: string | undefined): boolean | undefined | null {
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return null;
}

function verifiedExternalAdmin(ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): boolean {
  return ctx.plane === 'oidc' && ctx.issuer !== null && ctx.issuer !== 'du-local'
    && ctx.role === 'admin' && ctx.principal.kind === 'platform';
}

function currentExternalAlertAdmin(ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): boolean {
  return verifiedExternalAdmin(ctx)
    && ctx.costAlertPrincipalId !== null && UUID.test(ctx.costAlertPrincipalId)
    && Number.isSafeInteger(ctx.costAlertAuthorizationVersion) && Number(ctx.costAlertAuthorizationVersion) >= 1;
}

function localOwnerAdmin(ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): boolean {
  return ctx.plane === 'oidc' && ctx.issuer === 'du-local' && ctx.role === 'admin'
    && ctx.sub !== null && UUID.test(ctx.sub) && ctx.tenantId !== null && UUID.test(ctx.tenantId)
    && Number.isSafeInteger(ctx.roleVersion) && Number(ctx.roleVersion) >= 1;
}

export async function handleCostAlertsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: CostAlertsRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') { writeProblem(res, 404, 'NOT_FOUND', 'cost-alert path is invalid', correlationId); return; }
  const method = (req.method ?? 'GET').toUpperCase();
  const read = route.kind === 'alerts-list' || route.kind === 'channels' || route.kind === 'scope-catalog'
    || route.kind === 'binding-read' || route.kind === 'inbox-list' || route.kind === 'recipient-list';
  if ((read && method !== 'GET') || (route.kind === 'binding-write' && method !== 'PUT') || (route.kind === 'inbox-read' && method !== 'POST')) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'cost alert route method is not allowed', correlationId); return;
  }
  if ((route.kind === 'recipient-self' || route.kind === 'recipient-lifecycle') && method !== 'POST') {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'recipient directory mutations require POST', correlationId); return;
  }
  const ctx = await resolveBffContext(config, request);
  if (!ctx) { writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId); return; }
  if (ctx.role === 'viewer' || ctx.principal.kind === 'unscoped'
    || (ctx.issuer === 'du-local' && ctx.role === 'operator')) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'cost alerts require an authorized tenant or platform Admin session', correlationId); return;
  }
  if ((route.kind === 'inbox-list' || route.kind === 'inbox-read') && !localOwnerAdmin(ctx) && !currentExternalAlertAdmin(ctx)) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'the owner inbox requires a current local or external OIDC Admin recipient', correlationId); return;
  }
  if ((route.kind === 'recipient-list' || route.kind === 'recipient-lifecycle') && !currentExternalAlertAdmin(ctx)) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'the recipient directory requires the current external OIDC Admin recipient', correlationId); return;
  }
  if (route.kind === 'recipient-self' && !verifiedExternalAdmin(ctx)) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'self registration requires a verified external OIDC platform Admin', correlationId); return;
  }

  const mutation = !read;
  if (mutation && !ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId); return;
  }
  const proof = activeSessionProof(request, ctx);
  if (!proof) { writeProblem(res, 401, 'UNAUTHENTICATED', 'the active Admin session proof is unavailable', correlationId); return; }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the Admin API is not configured', correlationId); return;
  }
  const credential = credentialFor(ctx.principal, runtime);
  if (!credential) { writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no Admin credential is configured for this session scope', correlationId); return; }

  const sessionTenantId = ctx.principal.kind === 'tenant_operator' ? ctx.principal.tenantId : null;
  let upstreamPath: string;
  let upstreamQuery: Record<string, unknown> = {};
  let jsonBody: string | undefined;
  let idempotencyKey: string | undefined;
  const noQuery = () => {
    if (query.size > 0) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'cost alert mutation does not accept query parameters', correlationId);
      return false;
    }
    return true;
  };

  if (route.kind === 'alerts-list') {
    const collected = collectQuery(query, new Set(['tenantId', 'limit', 'cursor', 'budgetId', 'kind']));
    if (collected.invalid || !collected.values) { writeProblem(res, 422, 'INVALID_SCHEMA', 'alert history query is invalid', correlationId); return; }
    const tenantId = tenantScope(collected.values['tenantId'], sessionTenantId);
    const limit = jsonLimit(collected.values['limit']);
    if (!tenantId || limit === null) { writeProblem(res, 422, 'INVALID_SCHEMA', 'alert history tenant or limit is invalid', correlationId); return; }
    const raw = { tenantId, ...(limit === undefined ? {} : { limit }), ...(collected.values['cursor'] ? { cursor: collected.values['cursor'] } : {}),
      ...(collected.values['budgetId'] ? { budgetId: collected.values['budgetId'] } : {}), ...(collected.values['kind'] ? { kind: collected.values['kind'] } : {}) };
    const parsed = CostAlertListQuerySchema.safeParse(raw);
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'alert history query is invalid', correlationId); return; }
    upstreamPath = '/api/internal/cost-alerts';
    upstreamQuery = parsed.data;
  } else if (route.kind === 'channels' || route.kind === 'scope-catalog') {
    const collected = collectQuery(query, route.kind === 'channels'
      ? new Set(['tenantId'])
      : new Set(['tenantId', 'kind', 'q', 'limit', 'cursor', 'apiKeyId', 'profileId']));
    if (collected.invalid || !collected.values) { writeProblem(res, 422, 'INVALID_SCHEMA', 'cost alert catalog query is invalid', correlationId); return; }
    const tenantId = tenantScope(collected.values['tenantId'], sessionTenantId);
    if (!tenantId) { writeProblem(res, 422, 'INVALID_SCHEMA', 'a tenant scope is required and must match the session', correlationId); return; }
    if (route.kind === 'channels') {
      upstreamPath = '/api/internal/cost-alerts/channels';
      upstreamQuery = { tenantId };
    } else {
      const limit = jsonLimit(collected.values['limit']);
      if (limit === null) { writeProblem(res, 422, 'INVALID_SCHEMA', 'scope catalog page size is invalid', correlationId); return; }
      const parsed = CostPolicyScopeCatalogQuerySchema.safeParse({
        tenantId,
        ...(collected.values['kind'] ? { kind: collected.values['kind'] } : {}),
        ...(collected.values['q'] !== undefined ? { q: collected.values['q'] } : {}),
        ...(limit !== undefined ? { limit } : {}),
        ...(collected.values['cursor'] ? { cursor: collected.values['cursor'] } : {}),
        ...(collected.values['apiKeyId'] ? { apiKeyId: collected.values['apiKeyId'] } : {}),
        ...(collected.values['profileId'] ? { profileId: collected.values['profileId'] } : {}),
      });
      if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'scope catalog query is invalid', correlationId); return; }
      upstreamPath = '/api/internal/cost-alerts/scope-catalog';
      upstreamQuery = parsed.data;
    }
  } else if (route.kind === 'binding-read') {
    const collected = collectQuery(query, new Set(['tenantId', 'budgetRevision']));
    if (collected.invalid || !collected.values) { writeProblem(res, 422, 'INVALID_SCHEMA', 'alert binding query is invalid', correlationId); return; }
    const tenantId = tenantScope(collected.values['tenantId'], sessionTenantId);
    const budgetRevisionRaw = collected.values['budgetRevision'];
    if (!tenantId || !budgetRevisionRaw || !/^\d{1,9}$/.test(budgetRevisionRaw) || Number(budgetRevisionRaw) < 1) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'alert binding tenant or revision is invalid', correlationId); return;
    }
    upstreamPath = `/api/internal/cost-alerts/bindings/${encodeURIComponent(route.budgetId)}`;
    upstreamQuery = { tenantId, budgetRevision: Number(budgetRevisionRaw) };
  } else if (route.kind === 'binding-write') {
    if (!noQuery()) return;
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
    let value: unknown;
    try { value = raw.length === 0 ? null : JSON.parse(raw); }
    catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
    const parsed = CostBudgetAlertBindingWriteSchema.safeParse(value);
    if (!parsed.success || (sessionTenantId !== null && parsed.data.tenantId !== sessionTenantId)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'alert binding body is invalid for this session scope', correlationId); return;
    }
    idempotencyKey = firstHeaderValue(req.headers['idempotency-key']);
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'alert binding changes require a bounded Idempotency-Key header', correlationId); return;
    }
    upstreamPath = '/api/internal/cost-alerts/bindings';
    jsonBody = JSON.stringify(parsed.data);
  } else if (route.kind === 'inbox-list') {
    const collected = collectQuery(query, new Set(['tenantId', 'limit', 'cursor', 'unreadOnly']));
    if (collected.invalid || !collected.values) { writeProblem(res, 422, 'INVALID_SCHEMA', 'owner inbox query is invalid', correlationId); return; }
    const localOwner = localOwnerAdmin(ctx);
    const tenantId = tenantScope(collected.values['tenantId'], localOwner ? ctx.tenantId : sessionTenantId);
    const limit = jsonLimit(collected.values['limit']);
    const unreadOnly = inboxBoolean(collected.values['unreadOnly']);
    if (!tenantId || (!localOwner && !collected.values['tenantId']) || (localOwner && tenantId !== ctx.tenantId) || limit === null || unreadOnly === null) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'owner inbox tenant or filters are invalid', correlationId); return;
    }
    const parsed = CostAlertInboxQuerySchema.safeParse({
      tenantId,
      ...(limit === undefined ? {} : { limit }),
      ...(collected.values['cursor'] ? { cursor: collected.values['cursor'] } : {}),
      ...(unreadOnly === undefined ? {} : { unreadOnly }),
    });
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'owner inbox query is invalid', correlationId); return; }
    upstreamPath = '/api/internal/cost-alerts/inbox';
    upstreamQuery = parsed.data;
  } else if (route.kind === 'recipient-list') {
    const collected = collectQuery(query, new Set(['tenantId', 'q', 'limit', 'cursor']));
    if (collected.invalid || !collected.values) { writeProblem(res, 422, 'INVALID_SCHEMA', 'recipient catalog query is invalid', correlationId); return; }
    const tenantId = tenantScope(collected.values['tenantId'], sessionTenantId);
    const limit = jsonLimit(collected.values['limit']);
    if (!tenantId || !collected.values['tenantId'] || limit === null) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'recipient catalog tenant or page size is invalid', correlationId); return;
    }
    const parsed = CostAlertRecipientCatalogQuerySchema.safeParse({
      tenantId,
      ...(collected.values['q'] !== undefined ? { q: collected.values['q'] } : {}),
      ...(limit === undefined ? {} : { limit }),
      ...(collected.values['cursor'] ? { cursor: collected.values['cursor'] } : {}),
    });
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'recipient catalog query is invalid', correlationId); return; }
    upstreamPath = '/api/internal/cost-alerts/recipients';
    upstreamQuery = parsed.data;
  } else if (route.kind === 'recipient-self') {
    if (!noQuery()) return;
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
    let value: unknown;
    try { value = raw.length === 0 ? null : JSON.parse(raw); }
    catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).length !== 0) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'self recipient registration accepts an empty object only', correlationId); return;
    }
    upstreamPath = '/api/internal/cost-alerts/recipients/self';
    jsonBody = '{}';
  } else if (route.kind === 'recipient-lifecycle') {
    if (!noQuery()) return;
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
    let value: unknown;
    try { value = raw.length === 0 ? null : JSON.parse(raw); }
    catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
    const parsed = CostAlertRecipientLifecycleWriteSchema.safeParse(value);
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'recipient lifecycle body is invalid', correlationId); return; }
    idempotencyKey = firstHeaderValue(req.headers['idempotency-key']);
    if (!idempotencyKey || idempotencyKey.length < 8 || idempotencyKey.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(idempotencyKey)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'recipient lifecycle requires a bounded Idempotency-Key header', correlationId); return;
    }
    upstreamPath = `/api/internal/cost-alerts/recipients/${encodeURIComponent(route.principalId)}/lifecycle`;
    jsonBody = JSON.stringify(parsed.data);
  } else {
    if (!noQuery()) return;
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
    let value: unknown;
    try { value = raw.length === 0 ? null : JSON.parse(raw); }
    catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
    if (typeof value !== 'object' || value === null || Array.isArray(value) || Object.keys(value).some((key) => key !== 'tenantId')
      || typeof (value as Record<string, unknown>)['tenantId'] !== 'string') {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'notification read receipt requires an explicit tenant id', correlationId); return;
    }
    const tenantId = tenantScope((value as Record<string, string>)['tenantId'], localOwnerAdmin(ctx) ? ctx.tenantId : sessionTenantId);
    if (!tenantId || (localOwnerAdmin(ctx) && tenantId !== ctx.tenantId)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'notification read tenant does not match the current Admin session', correlationId); return;
    }
    upstreamPath = `/api/internal/cost-alerts/inbox/${encodeURIComponent(route.alertId)}/read`;
    upstreamQuery = { tenantId };
    jsonBody = '{}';
  }

  const upstream = new URL(upstreamPath, runtime.jsonBaseUrl);
  toUpstreamQuery(upstream, upstreamQuery);
  await relayUpstream(res, await callUpstream(runtime, upstream, {
    method: method as 'GET' | 'PUT' | 'POST',
    credential,
    correlationId,
    ...(jsonBody !== undefined ? { jsonBody } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    sessionProof: proof,
  }), correlationId);
}
