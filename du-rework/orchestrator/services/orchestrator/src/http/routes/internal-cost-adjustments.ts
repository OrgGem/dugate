import {
  CostAdjustmentCommandResultSchema,
  CostAdjustmentCommandSchema,
  CostAdjustmentEvidencePageSchema,
  CostAdjustmentEvidenceQuerySchema,
  CostAdjustmentHistoryPageSchema,
  CostAdjustmentQuerySchema,
} from '@du/contracts';
import { parseCookieHeader } from '../../app/admin/shell-auth';
import { HttpError, zodIssuesToProblem } from '../errors';
import {
  authorizeAuditTenantRead,
  resolveAdminActionAuthAsync,
  type AdminActionAuth,
  type AdminPrincipal,
  type AdminSessionView,
} from '../../modules/admin-actions/rbac';
import type { AdjustmentReader } from '../../modules/cost-control/adjustments';
import type { LocalUserUsageReadScope } from '../../modules/usage/read-scope';
import { SESSION_COOKIE_NAME } from '../../modules/auth/session-store';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/cost-control/adjustments';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HISTORY_QUERY = new Set(['tenantId', 'rootEventId', 'limit', 'cursor']);
const EVIDENCE_QUERY = new Set(['tenantId', 'q', 'limit', 'cursor']);

function parseQuery(ctx: RouteContext, allowlist: ReadonlySet<string>): Record<string, unknown> {
  const values: Record<string, unknown> = {};
  for (const [key, value] of ctx.searchParams.entries()) {
    if (!allowlist.has(key) || Object.hasOwn(values, key)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cost adjustment query contains an unsupported or repeated parameter');
    }
    values[key] = key === 'limit' ? parseInteger(value, key) : value;
  }
  return values;
}

function parseInteger(value: string, field: string): number {
  if (!/^\d{1,3}$/.test(value)) throw new HttpError(422, 'INVALID_SCHEMA', `${field} must be a bounded integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new HttpError(422, 'INVALID_SCHEMA', `${field} must be a safe integer`);
  return parsed;
}

function actorPrincipalId(auth: AdminActionAuth): string | null {
  if (auth.kind === 'bearer') return null;
  if (auth.issuer === 'du-local') return auth.principalId && UUID.test(auth.principalId) ? auth.principalId : null;
  if (auth.costAlertPrincipalId && UUID.test(auth.costAlertPrincipalId)) return auth.costAlertPrincipalId;
  // Do not synthesize an identity from an OIDC subject. Finance mutations
  // fail closed unless an already trusted opaque principal UUID is available.
  return null;
}

function principalFor(auth: AdminActionAuth): { principal: AdminPrincipal; kind: AdjustmentReader['kind']; tenantId: string | null; role: AdjustmentReader['role'] } {
  if (auth.kind === 'bearer') {
    const role = auth.principal.role === 'platform' ? 'admin' : 'operator';
    return {
      principal: auth.principal,
      kind: auth.principal.role === 'platform' ? 'platform' : 'tenant_operator',
      tenantId: auth.principal.role === 'tenant_operator' ? auth.principal.tenantId : null,
      role,
    };
  }
  if (auth.role === 'admin') {
    if (auth.tenantId) throw new HttpError(403, 'PERMISSION_DENIED', 'platform Admin session has an invalid tenant scope');
    return { principal: { role: 'platform' }, kind: 'platform', tenantId: null, role: 'admin' };
  }
  if (auth.role === 'operator') {
    if (!auth.tenantId || !UUID.test(auth.tenantId)) throw new HttpError(403, 'PERMISSION_DENIED', 'operator session has no valid tenant scope');
    if (auth.issuer === 'du-local') return { principal: { role: 'tenant_operator', tenantId: auth.tenantId }, kind: 'local_user', tenantId: auth.tenantId, role: 'operator' };
    return { principal: { role: 'tenant_operator', tenantId: auth.tenantId }, kind: 'tenant_operator', tenantId: auth.tenantId, role: 'operator' };
  }
  if (auth.role === 'viewer') {
    if (!auth.tenantId || !UUID.test(auth.tenantId)) throw new HttpError(403, 'PERMISSION_DENIED', 'viewer session has no valid tenant scope');
    return { principal: { role: 'tenant_operator', tenantId: auth.tenantId }, kind: 'viewer', tenantId: auth.tenantId, role: 'viewer' };
  }
  throw new HttpError(403, 'PERMISSION_DENIED', 'cost adjustment access is unavailable to this session');
}

async function currentLocalUserScope(
  ctx: RouteContext,
  auth: AdminActionAuth,
  tenantId: string,
): Promise<LocalUserUsageReadScope | undefined> {
  if (auth.kind !== 'cookie' || auth.issuer !== 'du-local' || auth.role !== 'operator') return undefined;
  if (!auth.principalId || !UUID.test(auth.principalId) || !Number.isSafeInteger(auth.roleVersion) || (auth.roleVersion ?? 0) < 1
      || auth.tenantId !== tenantId) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'local USER session is missing its current tenant identity');
  }
  if (!ctx.identity) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'local USER access scope is unavailable');
  const scope = await ctx.identity.getLocalUserOperationScope({
    tenantId,
    userId: auth.principalId,
    roleVersion: auth.roleVersion!,
  });
  if (!scope) throw new HttpError(401, 'UNAUTHENTICATED', 'local USER session is expired or its assignments changed');
  return scope;
}

async function resolveActor(ctx: RouteContext, mutation = false): Promise<AdjustmentReader & { sessionId?: string }> {
  const hasShellCookie = /(?:^|;\s*)(?:du_session|du_admin)=/.test(ctx.headers.cookie ?? '');
  const headers = hasShellCookie ? { ...ctx.headers, authorization: undefined } : ctx.headers;
  const auth = await resolveAdminActionAuthAsync(ctx.config, headers, ctx.config.adminSessionStore);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  const resolved = principalFor(auth);
  if (mutation) {
    if (auth.kind !== 'cookie' || resolved.kind !== 'platform' || auth.role !== 'admin') {
      throw new HttpError(403, 'PERMISSION_DENIED', 'financial adjustments require a platform Admin cookie session');
    }
    if (!auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  }
  const actorId = actorPrincipalId(auth);
  const roleVersion = auth.kind === 'cookie' && auth.issuer === 'du-local' ? auth.roleVersion ?? null : null;
  const cookies = auth.kind === 'cookie' ? parseCookieHeader(ctx.headers.cookie) : {};
  const sessionId = cookies[SESSION_COOKIE_NAME];
  return {
    kind: resolved.kind,
    authKind: auth.kind,
    tenantId: resolved.tenantId,
    principalId: actorId,
    role: resolved.role,
    roleVersion,
    csrfOk: auth.kind === 'cookie' && auth.csrfOk,
    ...(sessionId && /^[A-Za-z0-9_-]{43}$/.test(sessionId) ? { sessionId } : {}),
    ...(auth.kind === 'cookie' && auth.issuer && auth.issuer !== 'du-local' ? { issuer: auth.issuer, sub: auth.principalId } : {}),
  };
}

async function attachLocalScope(ctx: RouteContext, actor: AdjustmentReader, tenantId: string): Promise<AdjustmentReader> {
  if (actor.kind !== 'local_user') return actor;
  const hasShellCookie = /(?:^|;\s*)(?:du_session|du_admin)=/.test(ctx.headers.cookie ?? '');
  const headers = hasShellCookie ? { ...ctx.headers, authorization: undefined } : ctx.headers;
  const auth = await resolveAdminActionAuthAsync(ctx.config, headers, ctx.config.adminSessionStore);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  const localUserScope = await currentLocalUserScope(ctx, auth, tenantId);
  if (!localUserScope || localUserScope.roleVersion !== actor.roleVersion || localUserScope.userId !== actor.principalId) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'local USER session changed while resolving its financial read scope');
  }
  return { ...actor, localUserScope };
}

function requireTenant(actor: AdjustmentReader, requested: unknown): string {
  const tenantId = typeof requested === 'string' ? requested : actor.tenantId;
  if (!tenantId || !UUID.test(tenantId)) throw new HttpError(422, 'INVALID_SCHEMA', 'cost adjustment query requires a tenant UUID');
  const principal: AdminPrincipal = actor.kind === 'platform' ? { role: 'platform' }
    : actor.tenantId ? { role: 'tenant_operator', tenantId: actor.tenantId }
      : { role: 'platform' };
  authorizeAuditTenantRead(principal, tenantId);
  return tenantId;
}

function parseIdempotencyKey(ctx: RouteContext): string {
  const key = ctx.headers['idempotency-key'];
  if (!key || key.length < 8 || key.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'financial adjustment requires a bounded Idempotency-Key');
  }
  return key;
}

export async function handleInternalCostAdjustmentRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const service = ctx.costAdjustments;
  if (!service) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'financial adjustment service is not configured');
  const suffix = ctx.pathname.slice(PREFIX.length) || '/';

  if (suffix === '/evidence') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'evidence catalog requires GET');
    const raw = parseQuery(ctx, EVIDENCE_QUERY);
    const actor = await resolveActor(ctx);
    const tenantId = requireTenant(actor, raw['tenantId']);
    const localActor = await attachLocalScope(ctx, actor, tenantId);
    const parsed = CostAdjustmentEvidenceQuerySchema.safeParse({ ...raw, tenantId });
    if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
    const result = CostAdjustmentEvidencePageSchema.safeParse(await service.listEvidence(parsed.data, localActor));
    if (!result.success) throw new HttpError(502, 'INTERNAL_ERROR', 'financial evidence catalog violated its contract');
    return { status: 200, body: result.data };
  }

  if (suffix === '/' || suffix === '') {
    if (ctx.method === 'GET') {
      const raw = parseQuery(ctx, HISTORY_QUERY);
      const actor = await resolveActor(ctx);
      const tenantId = requireTenant(actor, raw['tenantId']);
      const localActor = await attachLocalScope(ctx, actor, tenantId);
      const parsed = CostAdjustmentQuerySchema.safeParse({ ...raw, tenantId });
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      const result = CostAdjustmentHistoryPageSchema.safeParse(await service.getHistory(parsed.data, localActor));
      if (!result.success) throw new HttpError(502, 'INTERNAL_ERROR', 'financial history violated its contract');
      return { status: 200, body: result.data };
    }
    if (ctx.method === 'POST') {
      if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'financial adjustment command does not accept query parameters');
      const actor = await resolveActor(ctx, true);
      const parsed = CostAdjustmentCommandSchema.safeParse(ctx.body);
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      const result = CostAdjustmentCommandResultSchema.safeParse(await service.adjust(parsed.data, actor, parseIdempotencyKey(ctx)));
      if (!result.success) throw new HttpError(502, 'INTERNAL_ERROR', 'financial adjustment result violated its contract');
      return { status: result.data.replayed ? 200 : 201, body: result.data };
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'financial adjustment route requires GET or POST');
  }
  return null;
}
