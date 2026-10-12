import { listAdminDeliveries } from '../../modules/webhooks/admin-delivery';
/** Administrative operations surface. Never accepts public API keys. */
import { HttpError, isHttpError } from '../errors';
import type { RouteContext, RouteResult } from '../route-context';
import { resolveAdminActionAuthAsync, authorizeAuditTenantRead, requireResourceTenant, type AdminActionAuth, type AdminPrincipal, type AdminSessionView } from '../../modules/admin-actions/rbac';
import { dispatchAdminAction } from '../../modules/admin-actions/dispatcher';
import { listOperationsPage, parseOperationsListQuery } from '../../modules/operations/list-query';
import { getOperationsMetrics, parseOperationsMetricsQuery } from '../../modules/admin-read/operations-metrics';
import { buildAdminOperationDetail, toOperationDetailWire } from '../../modules/operations/mappers';
import { readIdempotencyKey } from '../../modules/idempotency/idempotency';
import { buildOperationResult, buildOperationDownload } from './public';
import { uploadAdminOperationArtifact } from './admin-operation-upload';
import { hashKey } from './api-key-auth';
import { parseCookieHeader } from '../../app/admin/shell-auth';
import { SESSION_COOKIE_NAME, verifySessionCsrf, type SessionRecord } from '../../modules/auth/session-store';
import type { OperationsListUserScope } from '../../modules/operations/list-query';

export async function handleInternalOperationsRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  const prefix = '/api/internal/operations';
  if (ctx.pathname !== prefix && !ctx.pathname.startsWith(`${prefix}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  // A BFF request may carry a validated opaque browser session next to its
  // tenant/platform service bearer. Resolve it before the bearer-first auth
  // helper so an expired or revoked du_session can never fall back to a wider
  // service-principal read.
  const session = await resolveSuppliedSession(ctx);
  const auth = await resolveAdminActionAuthAsync(ctx.config, ctx.headers, ctx.config.adminSessionStore);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  let principal: AdminPrincipal = auth.kind === 'bearer' ? auth.principal
    : auth.role === 'admin' ? { role: 'platform' }
    : auth.tenantId ? { role: 'tenant_operator', tenantId: auth.tenantId }
    : (() => { throw new HttpError(403, 'PERMISSION_DENIED', 'session has no tenant scope'); })();
  assertSessionMatchesPrincipal(session, principal);
  const localUserScope = session?.issuer === 'du-local' && session.role === 'operator'
    ? await resolveLocalUserScope(ctx, session)
    : null;
  const suffix = ctx.pathname.slice(prefix.length);
  if (suffix === '/uploads') {
    assertWriteAccess(ctx, auth, session);
    if (localUserScope) {
      const apiKeyId = ctx.searchParams.get('apiKeyId') ?? '';
      const identity = ctx.identity;
      if (!identity) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'local-user operation scope service is unavailable');
      const allowed = await identity.isLocalUserAssignedApiKey({
        tenantId: localUserScope.tenantId,
        userId: localUserScope.userId,
        roleVersion: localUserScope.roleVersion,
        apiKeyId,
      });
      if (!allowed) throw new HttpError(404, 'NOT_FOUND', 'not found');
    }
    return uploadAdminOperationArtifact(ctx, auth, principal);
  }
  if (suffix === '' || suffix === '/metrics') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'read endpoint requires GET');
    if (suffix === '/metrics') {
      const query = parseOperationsMetricsQuery(ctx.searchParams);
      const scope = authorizeAuditTenantRead(principal, query.tenantId ?? '');
      const scopedUser = scopeLocalUserToTenant(localUserScope, scope);
      return { status: 200, body: await getOperationsMetrics(ctx, query, scope || null, scopedUser) };
    }
    const query = parseOperationsListQuery(ctx.searchParams);
    const scope = authorizeAuditTenantRead(principal, query.tenantId ?? '');
    const scopedUser = scopeLocalUserToTenant(localUserScope, scope);
    return { status: 200, body: await listOperationsPage(ctx, query, scope || null, toOperationDetailWire, scopedUser) };
  }
  const match = /^\/([^/]+)(?:\/(cancel|resume|retry|result|download|deliveries))?$/.exec(suffix);
  if (!match) throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  let id: string;
  try { id = decodeURIComponent(match[1]!); } catch { throw new HttpError(404, 'NOT_FOUND', 'Not Found'); }
  if (!id || id.includes('/') || id.includes('\\')) throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const action = match[2];
  if (action && action !== 'result' && action !== 'download' && action !== 'deliveries') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'operation controls require POST');
    assertWriteAccess(ctx, auth, session);
    await requireLocalOperationAccess(ctx, localUserScope, id);
    if (action === 'retry' && principal.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'retry requires platform admin');
    if (action !== 'resume' && ctx.body != null && (typeof ctx.body !== 'object' || Array.isArray(ctx.body) || Object.keys(ctx.body).length)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'operation control does not accept request overrides');
    }
    const result = await dispatchAdminAction({
      db: ctx.db, audit: ctx.audit, registry: ctx.registry, profiles: ctx.profiles,
      lifecycle: ctx.lifecycle, runtime: ctx.runtime, hashApiKey: hashKey,
      correlationId: ctx.correlationId, metadataCrypto: ctx.metadataCrypto,
    }, auth, { action: `operations.${action}`, params: { operationId: id, ...(action === 'resume' ? { body: ctx.body } : {}) }, idempotencyKey: readIdempotencyKey(ctx.headers) });
    return { status: result.status, body: { action: `operations.${action}`, ...result.body } };
  }
  if ((action === 'result' || action === 'download' || action === 'deliveries') && ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'result requires GET');
  if (ctx.method !== 'GET' && ctx.method !== 'DELETE') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'operation accepts GET or DELETE');
  if (ctx.method === 'DELETE') {
    assertWriteAccess(ctx, auth, session);
    await requireLocalOperationAccess(ctx, localUserScope, id);
    return ctx.db.tx(async (client) => {
      const rows = await client.query('SELECT tenant_id, state FROM operations WHERE id=$1 AND deleted_at IS NULL FOR UPDATE', [id]);
      const op = rows.rows[0] as { tenant_id: string; state: string } | undefined;
      if (!op) throw new HttpError(404, 'NOT_FOUND', 'not found');
      requireResourceTenant(principal, op.tenant_id);
      if (!['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(op.state)) throw new HttpError(409, 'STATE_CONFLICT', 'only terminal operations can be deleted');
      await client.query('UPDATE operations SET deleted_at=now() WHERE id=$1 AND tenant_id=$2', [id, op.tenant_id]);
      await ctx.audit.record({ tenantId: op.tenant_id, actor: auth.kind === 'cookie' ? `shell:${auth.role}` : 'admin',
        ...(auth.kind === 'cookie' ? { actorIssuer: auth.issuer, actorSub: auth.principalId, actorRole: auth.role } : {}),
        action: 'operation.delete', resource: `operation:${id}`, severity: 'warning', correlationId: ctx.correlationId }, client);
      return { status: 200, body: { success: true } };
    });
  }
  try {
    await requireLocalOperationAccess(ctx, localUserScope, id);
    const op = await ctx.runtime.getOperation(id);
    requireResourceTenant(principal, String(op.tenant_id));
    if (action === 'deliveries') return {status:200,body:await ctx.db.tx(client=>listAdminDeliveries(client,id,String(op.tenant_id),{dispatcherConfigured:!!ctx.config.webhookSecret && (ctx.config.webhookDispatchIntervalMs ?? (ctx.config.autoDispatch !== false ? 5000 : 0)) > 0,authResolverConfigured:!!ctx.config.resolveCallbackSecret}))};
    if (action === 'download') return buildOperationDownload(ctx, op);
    if (action === 'result') return buildOperationResult(ctx, op);
    return { status: 200, body: await buildAdminOperationDetail(ctx, id) };
  } catch (err) {
    if (isHttpError(err) && err.status === 404) throw new HttpError(404, 'NOT_FOUND', 'not found');
    throw err;
  }
}

async function resolveSuppliedSession(ctx: RouteContext): Promise<AdminSessionView | null> {
  const cookies = parseCookieHeader(ctx.headers['cookie']);
  if (!Object.prototype.hasOwnProperty.call(cookies, SESSION_COOKIE_NAME)) return null;
  const sessionId = cookies[SESSION_COOKIE_NAME];
  if (!sessionId || !/^[A-Za-z0-9_-]{43}$/.test(sessionId) || !ctx.config.adminSessionStore) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'admin session is invalid or unavailable');
  }
  const session = await ctx.config.adminSessionStore.get(sessionId);
  if (!session) throw new HttpError(401, 'UNAUTHENTICATED', 'admin session is expired or revoked');
  return session;
}

function assertSessionMatchesPrincipal(session: AdminSessionView | null, principal: AdminPrincipal): void {
  if (!session) return;
  if (session.role === 'admin') {
    if (principal.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'session principal does not match the admin credential');
    return;
  }
  if (!session.tenantId || principal.role !== 'tenant_operator' || principal.tenantId !== session.tenantId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'session principal does not match the tenant credential');
  }
}

function assertWriteAccess(
  ctx: RouteContext,
  auth: AdminActionAuth,
  session: AdminSessionView | null,
): void {
  if (auth.kind === 'cookie' && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  if (session && !verifySessionCsrf(session as SessionRecord, ctx.headers['x-csrf-token'])) {
    throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  }
  if ((auth.kind === 'cookie' && auth.role === 'viewer') || session?.role === 'viewer') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'viewer cannot perform operation controls');
  }
}

async function resolveLocalUserScope(ctx: RouteContext, session: AdminSessionView): Promise<OperationsListUserScope> {
  if (!session.tenantId || !session.sub || !Number.isSafeInteger(session.roleVersion) || (session.roleVersion ?? 0) < 1) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'local operator session is missing current identity scope');
  }
  const identity = ctx.identity;
  if (!identity) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'local-user operation scope service is unavailable');
  const scope = await identity.getLocalUserOperationScope({ tenantId: session.tenantId, userId: session.sub, roleVersion: session.roleVersion! });
  if (!scope) throw new HttpError(401, 'UNAUTHENTICATED', 'local operator session is expired or its access changed');
  return scope;
}

function scopeLocalUserToTenant(
  scope: OperationsListUserScope | null,
  tenantId: string,
): OperationsListUserScope | null {
  if (scope && scope.tenantId !== tenantId) throw new HttpError(403, 'PERMISSION_DENIED', 'local operator cannot widen tenant scope');
  return scope;
}

async function requireLocalOperationAccess(
  ctx: RouteContext,
  scope: OperationsListUserScope | null,
  operationId: string,
): Promise<void> {
  if (!scope) return;
  const identity = ctx.identity;
  if (!identity) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'local-user operation scope service is unavailable');
  const allowed = await identity.isLocalUserAssignedOperation({
    tenantId: scope.tenantId,
    userId: scope.userId,
    roleVersion: scope.roleVersion,
    operationId,
  });
  if (!allowed) throw new HttpError(404, 'NOT_FOUND', 'not found');
}
