import { timingSafeEqual } from 'node:crypto';
import { createHash } from 'node:crypto';
import {
  BudgetDraftWriteSchema,
  CostPolicyRollbackRequestSchema,
  CostPolicyTransitionRequestSchema,
  CostPreflightRequestSchema,
  CostReservationGroupTransitionSchema,
  PriceDraftWriteSchema,
} from '@du/contracts';
import { HttpError, zodIssuesToProblem } from '../errors';
import { resolveAdminActionAuthAsync, authorizeAuditTenantRead, type AdminActionAuth, type AdminPrincipal } from '../../modules/admin-actions/rbac';
import type { CostControlActor } from '../../modules/cost-control/service';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/cost-control';
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUERY_ALLOWLIST = new Set(['tenantId']);

function constantTimeEquals(left: string, right: string): boolean {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');
  return a.length === b.length && timingSafeEqual(a, b);
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function queryTenant(ctx: RouteContext, required = true): string | undefined {
  const values: Record<string, string> = {};
  for (const [key, value] of ctx.searchParams.entries()) {
    if (!QUERY_ALLOWLIST.has(key) || Object.hasOwn(values, key)) throw new HttpError(422, 'INVALID_SCHEMA', 'cost-control query contains an unsupported or repeated parameter');
    values[key] = value;
  }
  const tenantId = values.tenantId;
  if (!tenantId && required) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required');
  if (tenantId && !UUID.test(tenantId)) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must be a UUID');
  return tenantId;
}

interface AdminAuth {
  role: 'platform' | 'tenant_operator' | 'local_user' | 'viewer' | 'none';
  tenantId: string | null;
  actor: CostControlActor;
  csrfRequired: boolean;
  csrfOk: boolean;
  raw: AdminActionAuth;
  principal: AdminPrincipal;
}

async function adminAuth(ctx: RouteContext): Promise<AdminAuth> {
  const hasShellCookie = /(?:^|;\s*)(?:du_session|du_admin)=/.test(ctx.headers.cookie ?? '');
  const headers = hasShellCookie ? { ...ctx.headers, authorization: undefined } : ctx.headers;
  const auth = await resolveAdminActionAuthAsync(ctx.config, headers, ctx.config.adminSessionStore);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  if (auth.kind === 'bearer') {
    const principal = auth.principal;
    return {
      role: principal.role,
      tenantId: principal.role === 'tenant_operator' ? principal.tenantId : null,
      actor: { label: principal.role === 'platform' ? 'platform-token' : 'tenant-operator', role: principal.role },
      csrfRequired: false, csrfOk: true, raw: auth, principal,
    };
  }
  const role = auth.role === 'admin' ? 'platform' : auth.role === 'operator' ? 'tenant_operator' : 'viewer';
  const principal: AdminPrincipal = role === 'tenant_operator' && auth.tenantId
    ? { role, tenantId: auth.tenantId }
    : { role: 'platform' };
  const localIdentity = auth.issuer === 'du-local' && auth.principalId && UUID.test(auth.principalId)
    ? auth.principalId : null;
  const oidcPrincipal = auth.issuer !== 'du-local' && auth.costAlertPrincipalId && UUID.test(auth.costAlertPrincipalId)
    ? auth.costAlertPrincipalId : null;
  const opaqueLabel = localIdentity ? `local-user:${localIdentity}`
    : oidcPrincipal ? `oidc-principal:${oidcPrincipal}`
      : auth.issuer === 'du-local' && auth.principalId ? 'legacy-local-admin' : `oidc-${auth.role}`;
  const identityKey = auth.issuer && auth.principalId
    ? createHash('sha256').update(`cost-policy-actor\0${auth.issuer}\0${auth.principalId}`).digest('hex')
    : undefined;
  return {
    role: auth.kind === 'cookie' && auth.issuer === 'du-local' && auth.role === 'operator' ? 'local_user' : role,
    tenantId: auth.tenantId ?? null,
    actor: {
      label: opaqueLabel,
      ...(identityKey ? { identityKey } : {}),
      ...(auth.issuer ? { issuer: auth.issuer } : {}),
      ...(auth.principalId ? { sub: auth.principalId } : {}),
      role: auth.role,
    },
    csrfRequired: true, csrfOk: auth.csrfOk, raw: auth, principal,
  };
}

function requirePlatform(auth: AdminAuth): void {
  if (auth.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'price book requires platform Admin access');
}

function requireBudgetRead(auth: AdminAuth, tenantId: string): void {
  if (auth.role === 'local_user') throw new HttpError(403, 'PERMISSION_DENIED', 'local USER sessions cannot read budget policy');
  if (auth.role === 'viewer' || auth.role === 'none') throw new HttpError(403, 'PERMISSION_DENIED', 'cost controls are not available to this session');
  authorizeAuditTenantRead(auth.principal, tenantId);
}

function requireMutation(ctx: RouteContext, auth: AdminAuth, tenantId: string | null): void {
  if (auth.csrfRequired && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  if (auth.role === 'local_user') throw new HttpError(403, 'PERMISSION_DENIED', 'local USER sessions cannot change budget or price policy');
  if (auth.role === 'viewer' || auth.role === 'none') throw new HttpError(403, 'PERMISSION_DENIED', 'cost controls are read-only for this session');
  if (tenantId === null && auth.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'platform cost settings require platform Admin access');
  if (tenantId && auth.role === 'tenant_operator' && auth.tenantId !== tenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');
  if (auth.csrfRequired && !ctx.headers.cookie) throw new HttpError(401, 'UNAUTHENTICATED', 'active Admin session cookie is required');
}

function requireIdempotencyKey(ctx: RouteContext): string {
  const key = ctx.headers['idempotency-key'];
  if (!key || key.length < 8 || key.length > 256 || !/^[A-Za-z0-9._:-]+$/.test(key)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'a bounded Idempotency-Key header is required');
  }
  return key;
}

export async function handleInternalCostControlRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const service = ctx.costControl;
  if (!service) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'cost-control service is not configured');
  const suffix = ctx.pathname.slice(PREFIX.length) || '/';

  if (suffix === '/reservations/preflight' || suffix === '/reservations/transitions') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'cost reservation commands require POST');
    const expected = ctx.config.costControlToken;
    const authorization = ctx.headers.authorization ?? '';
    if (!expected || !authorization.startsWith('Bearer ') || !constantTimeEquals(authorization.slice(7), expected)) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'dedicated Connector cost identity is required');
    }
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'cost reservation commands do not accept query parameters');
    if (suffix.endsWith('/preflight')) {
      const request = parseBody(CostPreflightRequestSchema, ctx.body);
      return { status: 200, body: await service.preflight(request) };
    }
    const command = parseBody(CostReservationGroupTransitionSchema, ctx.body);
    return { status: 200, body: await service.transitionGroup(command) };
  }

  const auth = await adminAuth(ctx);
  const budgetList = suffix === '/budgets';
  if (budgetList && ctx.method === 'GET') {
    const tenantId = queryTenant(ctx);
    requireBudgetRead(auth, tenantId!);
    return { status: 200, body: await service.listBudgets(tenantId!) };
  }
  const budgetDetail = /^\/budgets\/([^/]+)$/.exec(suffix);
  if (budgetDetail && ctx.method === 'GET') {
    const budgetId = decodeId(budgetDetail[1] ?? '');
    const tenantId = queryTenant(ctx);
    requireBudgetRead(auth, tenantId!);
    return { status: 200, body: await service.getBudget(tenantId!, budgetId) };
  }
  if (suffix === '/prices' && ctx.method === 'GET') {
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'price book does not accept query parameters');
    requirePlatform(auth);
    return { status: 200, body: await service.getPrices() };
  }

  const budgetDraft = suffix === '/budgets/draft';
  if (budgetDraft || suffix === '/prices/draft') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'cost policy mutation requires POST');
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'cost policy mutation does not accept query parameters');
    const key = requireIdempotencyKey(ctx);
    const auth = await adminAuth(ctx);
    if (budgetDraft) {
      const input = parseBody(BudgetDraftWriteSchema, ctx.body);
      const tenantId = input.config.tenantId;
      requireMutation(ctx, auth, tenantId);
      return { status: 201, body: await service.createBudgetDraft(input, auth.actor, key) };
    }
    requireMutation(ctx, auth, null);
    const input = parseBody(PriceDraftWriteSchema, ctx.body);
    return { status: 201, body: await service.createPriceDraft(input, auth.actor, key) };
  }

  const budgetAction = /^\/budgets\/([^/]+)\/(review|publish|retire|rollback)$/.exec(suffix);
  if (budgetAction) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'cost policy mutation requires POST');
    const budgetId = decodeId(budgetAction[1] ?? '');
    const action = budgetAction[2] as 'review' | 'publish' | 'retire' | 'rollback';
    const key = requireIdempotencyKey(ctx);
    const auth = await adminAuth(ctx);
    const tenantId = queryTenant(ctx, auth.role === 'tenant_operator');
    if (ctx.searchParams.size !== (tenantId ? 1 : 0)) throw new HttpError(422, 'INVALID_SCHEMA', 'budget mutation query is invalid');
    requireMutation(ctx, auth, tenantId ?? (auth.role === 'platform' ? null : auth.tenantId));
    const input = action === 'rollback'
      ? parseBody(CostPolicyRollbackRequestSchema, ctx.body)
      : parseBody(CostPolicyTransitionRequestSchema, ctx.body);
    return { status: 200, body: action === 'rollback'
      ? await service.rollbackBudget(budgetId, input, auth.actor, key, tenantId)
      : await service.transitionBudget(budgetId, action, input, auth.actor, key, tenantId) };
  }

  const priceRollback = suffix === '/prices/rollback';
  const priceAction = /^\/prices\/(review|publish|retire)$/.exec(suffix);
  if (priceRollback || priceAction) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'price book mutation requires POST');
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'price book mutation does not accept query parameters');
    const key = requireIdempotencyKey(ctx);
    const auth = await adminAuth(ctx);
    requirePlatform(auth);
    requireMutation(ctx, auth, null);
    const input = priceRollback
      ? parseBody(CostPolicyRollbackRequestSchema, ctx.body)
      : parseBody(CostPolicyTransitionRequestSchema, ctx.body);
    return { status: 200, body: priceRollback
      ? await service.rollbackPrice(input, auth.actor, key)
      : await service.transitionPrice(priceAction![1] as 'review' | 'publish' | 'retire', input, auth.actor, key) };
  }
  return null;
}

function decodeId(segment: string): string {
  let value: string;
  try { value = decodeURIComponent(segment); } catch { throw new HttpError(404, 'NOT_FOUND', 'not found'); }
  if (!UUID.test(value)) throw new HttpError(404, 'NOT_FOUND', 'not found');
  return value;
}
