import { UsageEventDrilldownQuerySchema } from '@du/contracts';
import { AdminUsageEventQuerySchema } from '../../modules/usage/usage';
import type { LocalUserUsageReadScope } from '../../modules/usage/read-scope';
import { HttpError, zodIssuesToProblem } from '../errors';
import { authorizeAuditTenantRead, resolveAdminActionAuthAsync, type AdminPrincipal, type AdminSessionView } from '../../modules/admin-actions/rbac';
import { parseCookieHeader } from '../../app/admin/shell-auth';
import { SESSION_COOKIE_NAME } from '../../modules/auth/session-store';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/usage';
const SUMMARY_QUERY_ALLOWLIST = new Set(['tenantId', 'from', 'to']);
const EVENT_QUERY_ALLOWLIST = new Set(['tenantId', 'from', 'to', 'timeField', 'limit', 'cursor', 'operationId', 'provider', 'model']);
const EXPORT_QUERY_ALLOWLIST = new Set(['tenantId', 'apiKeyId', 'businessId', 'action', 'profileRevision', 'provider', 'model', 'operationId', 'from', 'to', 'timeField', 'limit', 'cursor']);
const MAX_WINDOW_MS = 366 * 24 * 60 * 60 * 1000;

function parseQuery(searchParams: URLSearchParams, allowlist: Set<string>, kind: string): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of searchParams.entries()) {
    if (!allowlist.has(key) || Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new HttpError(422, 'INVALID_SCHEMA', `${kind} query contains an unsupported or repeated parameter`);
    }
    if (key === 'limit' || key === 'profileRevision') {
      if (!/^\d+$/.test(value)) throw new HttpError(422, 'INVALID_SCHEMA', `${key} must be an integer`);
      raw[key] = Number(value);
    } else {
      raw[key] = value;
    }
  }
  return raw;
}

function validateWindow(from: string, to: string, label: string): void {
  const start = Date.parse(from);
  const end = Date.parse(to);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > MAX_WINDOW_MS) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${label} requires a non-empty window of at most 366 days`);
  }
}

export async function handleInternalUsageRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'usage read requires GET');

  // A valid supplied cookie is stronger evidence of the browser principal than
  // the tenant credential attached by the BFF. In particular, a revoked or
  // expired local USER session must not fall back to tenant-wide bearer access.
  const session = await resolveSuppliedSession(ctx);
  const auth = await resolveAdminActionAuthAsync(ctx.config, ctx.headers, ctx.config.adminSessionStore);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  const principal: AdminPrincipal = auth.kind === 'bearer'
    ? auth.principal
    : auth.tenantId ? { role: 'tenant_operator', tenantId: auth.tenantId }
    : (() => { throw new HttpError(403, 'PERMISSION_DENIED', 'session has no tenant scope'); })();
  assertSessionMatchesPrincipal(session, principal);

  const suffix = ctx.pathname.slice(PREFIX.length) || '/';
  let tenantId: string;
  let localUserScope: LocalUserUsageReadScope | undefined;

  if (suffix === '/summary') {
    const raw = parseQuery(ctx.searchParams, SUMMARY_QUERY_ALLOWLIST, 'usage summary');
    if (typeof raw['from'] !== 'string' || typeof raw['to'] !== 'string') {
      throw new HttpError(422, 'INVALID_SCHEMA', 'usage summary requires from and to');
    }
    validateWindow(raw['from'], raw['to'], 'usage summary');
    tenantId = resolveTenant(principal, raw['tenantId']);
    localUserScope = await resolveLocalUserUsageScope(ctx, session, tenantId);
    const body = localUserScope
      ? await ctx.usage.getUsageSummary(tenantId, new Date(raw['from']), new Date(raw['to']), undefined, localUserScope)
      : await ctx.usage.getUsageSummary(tenantId, new Date(raw['from']), new Date(raw['to']));
    return { status: 200, body };
  }

  if (suffix === '/events') {
    const raw = parseQuery(ctx.searchParams, EVENT_QUERY_ALLOWLIST, 'usage event');
    const parsed = AdminUsageEventQuerySchema.safeParse(raw);
    if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
    tenantId = resolveTenant(principal, parsed.data.tenantId);
    localUserScope = await resolveLocalUserUsageScope(ctx, session, tenantId);
    const body = localUserScope
      ? await ctx.usage.getAdminUsageEventPage(tenantId, parsed.data, localUserScope)
      : await ctx.usage.getAdminUsageEventPage(tenantId, parsed.data);
    return { status: 200, body };
  }

  if (suffix === '/export') {
    const raw = parseQuery(ctx.searchParams, EXPORT_QUERY_ALLOWLIST, 'usage export');
    const parsed = UsageEventDrilldownQuerySchema.safeParse(raw);
    if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
    if (!parsed.data.from || !parsed.data.to) throw new HttpError(422, 'INVALID_SCHEMA', 'usage export requires from and to');
    validateWindow(parsed.data.from, parsed.data.to, 'usage export');
    tenantId = resolveTenant(principal, parsed.data.tenantId);
    localUserScope = await resolveLocalUserUsageScope(ctx, session, tenantId);
    const body = localUserScope
      ? await ctx.usage.getUsageEventExportPage(tenantId, parsed.data, localUserScope)
      : await ctx.usage.getUsageEventExportPage(tenantId, parsed.data);
    return { status: 200, body };
  }

  throw new HttpError(404, 'NOT_FOUND', 'Not Found');
}

function resolveTenant(principal: AdminPrincipal, requested: unknown): string {
  const requestedTenant = typeof requested === 'string' && requested.length > 0
    ? requested
    : principal.role === 'tenant_operator' ? principal.tenantId : '';
  if (!requestedTenant) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'usage read requires tenantId');
  }
  const tenantId = authorizeAuditTenantRead(principal, requestedTenant);
  if (!tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'usage read requires tenantId');
  return tenantId;
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
    if (session.tenantId !== null) {
      if (principal.role !== 'tenant_operator' || principal.tenantId !== session.tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'session principal does not match the tenant credential');
      }
      return;
    }
    if (principal.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'session principal does not match the admin credential');
    return;
  }
  if (!session.tenantId || principal.role !== 'tenant_operator' || principal.tenantId !== session.tenantId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'session principal does not match the tenant credential');
  }
}

async function resolveLocalUserUsageScope(
  ctx: RouteContext,
  session: AdminSessionView | null,
  tenantId: string,
): Promise<LocalUserUsageReadScope | undefined> {
  if (session?.issuer !== 'du-local' || session.role !== 'operator') return undefined;
  if (!session.tenantId || !session.sub || !Number.isSafeInteger(session.roleVersion) || (session.roleVersion ?? 0) < 1) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'local operator session is missing current identity scope');
  }
  if (session.tenantId !== tenantId) throw new HttpError(403, 'PERMISSION_DENIED', 'local operator cannot widen tenant usage scope');
  const identity = ctx.identity;
  if (!identity) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'local-user usage scope service is unavailable');
  const scope = await identity.getLocalUserOperationScope({ tenantId: session.tenantId, userId: session.sub, roleVersion: session.roleVersion! });
  if (!scope) throw new HttpError(401, 'UNAUTHENTICATED', 'local operator session is expired or its access changed');
  return scope;
}
