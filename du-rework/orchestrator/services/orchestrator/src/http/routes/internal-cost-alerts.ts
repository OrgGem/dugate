import { z } from 'zod';
import {
  CostAlertInboxQuerySchema,
  CostAlertRecipientCatalogQuerySchema,
  CostAlertRecipientLifecycleWriteSchema,
  CostAlertListQuerySchema,
  CostPolicyScopeCatalogQuerySchema,
  CostBudgetAlertBindingWriteSchema,
} from '@du/contracts';
import { HttpError, zodIssuesToProblem } from '../errors';
import { resolveAdminActionAuthAsync, authorizeAuditTenantRead, type AdminActionAuth, type AdminPrincipal } from '../../modules/admin-actions/rbac';
import { costAlertBindingActorLabel, createCostAlertService, type CostAlertActor } from '../../modules/cost-alerts/service';
import {
  costAlertOidcRecipientDto,
  ensureSelfRecipient,
  listCostAlertOidcRecipients,
  resolveCurrentPrincipal,
  transitionCostAlertOidcRecipient,
  type TrustedCostAlertOidcSession,
} from '../../modules/cost-alerts/oidc-recipients';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/cost-alerts';
const UUID = z.string().uuid();

type CostAlertAuth = {
  role: 'platform' | 'tenant_operator' | 'local_user' | 'viewer' | 'none';
  tenantId: string | null;
  actor: CostAlertActor;
  principal: AdminPrincipal;
  csrfRequired: boolean;
  csrfOk: boolean;
  oidcSession?: TrustedCostAlertOidcSession;
};

async function resolveAuth(ctx: RouteContext): Promise<CostAlertAuth> {
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
      principal,
      csrfRequired: false,
      csrfOk: true,
    };
  }
  const role = auth.role === 'admin' ? 'platform' : auth.role === 'operator' ? 'tenant_operator' : 'viewer';
  const principal: AdminPrincipal = role === 'tenant_operator' && auth.tenantId
    ? { role, tenantId: auth.tenantId }
    : { role: 'platform' };
  const localUser = auth.kind === 'cookie' && auth.issuer === 'du-local' && auth.role === 'operator';
  const session = auth as typeof auth & {
    costAlertPrincipalId?: string;
    costAlertAuthorizationVersion?: number;
    sessionCreatedAt?: number;
  };
  const oidcSession = auth.kind === 'cookie' && auth.issuer && auth.issuer !== 'du-local' && auth.principalId
    && Number.isSafeInteger(session.sessionCreatedAt)
    ? {
      issuer: auth.issuer,
      sub: auth.principalId,
      role: auth.role,
      tenantId: auth.tenantId ?? null,
      ...(session.costAlertPrincipalId ? { costAlertPrincipalId: session.costAlertPrincipalId } : {}),
      ...(session.costAlertAuthorizationVersion ? { costAlertAuthorizationVersion: session.costAlertAuthorizationVersion } : {}),
      createdAt: session.sessionCreatedAt!,
    } as TrustedCostAlertOidcSession
    : undefined;
  const actorLabel = costAlertBindingActorLabel({
    issuer: auth.issuer,
    role: auth.role,
    localPrincipalId: auth.issuer === 'du-local' ? auth.principalId : undefined,
    alertPrincipalId: auth.issuer !== 'du-local' ? session.costAlertPrincipalId : undefined,
  });
  return {
    role: localUser ? 'local_user' : role,
    tenantId: auth.tenantId ?? null,
    actor: {
      label: actorLabel,
      role: auth.role,
      ...(auth.issuer ? { issuer: auth.issuer } : {}),
      ...(auth.principalId ? { sub: auth.principalId } : {}),
    },
    principal,
    csrfRequired: true,
    csrfOk: auth.csrfOk,
    ...(oidcSession ? { oidcSession } : {}),
  };
}

function queryValues(ctx: RouteContext, allowed: Set<string>): Record<string, string> {
  const values: Record<string, string> = {};
  for (const [key, value] of ctx.searchParams.entries()) {
    if (!allowed.has(key) || Object.hasOwn(values, key)) throw new HttpError(422, 'INVALID_SCHEMA', 'cost alert query contains an unsupported or repeated parameter');
    values[key] = value;
  }
  return values;
}

function trustedSessionId(cookieHeader: string | undefined): string | null {
  if (!cookieHeader) return null;
  const values = cookieHeader.split(';').map((part) => part.trim()).filter((part) => part.startsWith('du_session='));
  if (values.length !== 1) return null;
  const value = values[0]!.slice('du_session='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : null;
}

function tenantScope(auth: CostAlertAuth, raw: string | undefined): string {
  const value = raw ?? (auth.role === 'tenant_operator' || auth.role === 'local_user' ? auth.tenantId ?? undefined : undefined);
  if (!value || !UUID.safeParse(value).success) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required and must be a UUID');
  if (auth.role === 'tenant_operator' || auth.role === 'local_user') {
    if (!auth.tenantId || auth.tenantId !== value) throw new HttpError(404, 'NOT_FOUND', 'not found');
  }
  if (auth.actor.issuer === 'du-local' && auth.tenantId && auth.tenantId !== value) {
    throw new HttpError(404, 'NOT_FOUND', 'not found');
  }
  return value;
}

function requireRead(auth: CostAlertAuth, tenantId: string): void {
  if (auth.role === 'local_user' || auth.role === 'viewer' || auth.role === 'none') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'cost alerts are unavailable to this session');
  }
  authorizeAuditTenantRead(auth.principal, tenantId);
}

function requireMutation(ctx: RouteContext, auth: CostAlertAuth, tenantId: string): void {
  if (auth.csrfRequired && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  if (auth.role === 'local_user' || auth.role === 'viewer' || auth.role === 'none') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'cost alert routing changes require platform or tenant operator access');
  }
  if (auth.role === 'tenant_operator' && auth.tenantId !== tenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');
  if (auth.csrfRequired && !ctx.headers.cookie) throw new HttpError(401, 'UNAUTHENTICATED', 'active Admin session cookie is required');
}

function requireOwnerInbox(auth: CostAlertAuth, requestedTenantId?: string): { tenantId: string; userId: string } {
  if (auth.role !== 'platform' || auth.actor.issuer !== 'du-local'
    || !auth.actor.sub || !UUID.safeParse(auth.actor.sub).success
    || !auth.tenantId || !UUID.safeParse(auth.tenantId).success) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'the owner inbox requires the active local tenant Admin identity');
  }
  if (requestedTenantId && requestedTenantId !== auth.tenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');
  return { tenantId: auth.tenantId, userId: auth.actor.sub };
}

async function requireCurrentOidcAdmin(ctx: RouteContext, auth: CostAlertAuth) {
  if (auth.role !== 'platform' || !auth.oidcSession || auth.actor.issuer === 'du-local') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'this action requires the current external OIDC platform Admin recipient');
  }
  const principal = await resolveCurrentPrincipal(ctx.db, auth.oidcSession);
  if (!principal) throw new HttpError(403, 'PERMISSION_DENIED', 'the external OIDC Admin recipient is stale, disabled, or unavailable');
  return principal;
}

function idempotencyKey(ctx: RouteContext): string {
  const key = ctx.headers['idempotency-key'];
  if (!key || !/^[A-Za-z0-9._:-]{8,256}$/.test(key)) throw new HttpError(422, 'INVALID_SCHEMA', 'a bounded Idempotency-Key header is required');
  return key;
}

function parseLimit(value: string | undefined): number {
  if (value === undefined) return 50;
  if (!/^\d{1,3}$/.test(value)) throw new HttpError(422, 'INVALID_SCHEMA', 'limit must be an integer from 1 to 100');
  const result = Number(value);
  if (result < 1 || result > 100) throw new HttpError(422, 'INVALID_SCHEMA', 'limit must be an integer from 1 to 100');
  return result;
}

function decodeUuidSegment(value: string): string | null {
  try {
    const decoded = decodeURIComponent(value);
    return UUID.safeParse(decoded).success ? decoded : null;
  } catch {
    return null;
  }
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

export async function handleInternalCostAlertRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const auth = await resolveAuth(ctx);
  const values = queryValues(ctx, new Set([
    'tenantId', 'budgetRevision', 'budgetId', 'kind', 'limit', 'cursor', 'unreadOnly',
    'q', 'apiKeyId', 'profileId',
  ]));
  const service = createCostAlertService(ctx.db, ctx.audit);

  if (ctx.pathname === `${PREFIX}/recipients`) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'recipient catalog requires GET');
    if (Object.keys(values).some((key) => !['tenantId', 'q', 'limit', 'cursor'].includes(key))) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'recipient catalog query is invalid');
    }
    await requireCurrentOidcAdmin(ctx, auth);
    const tenantId = tenantScope(auth, values.tenantId);
    requireRead(auth, tenantId);
    const query = parseBody(CostAlertRecipientCatalogQuerySchema, {
      tenantId,
      ...(values.q !== undefined ? { q: values.q } : {}),
      ...(values.limit !== undefined ? { limit: parseLimit(values.limit) } : {}),
      ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
    });
    return { status: 200, body: await listCostAlertOidcRecipients(ctx.db, query) };
  }

  if (ctx.pathname === `${PREFIX}/recipients/self`) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'self recipient registration requires POST');
    const emptyObjectBody = typeof ctx.body === 'object' && ctx.body !== null && !Array.isArray(ctx.body)
      && Object.keys(ctx.body).length === 0;
    if (ctx.searchParams.size > 0 || (ctx.body !== undefined && ctx.body !== null && !emptyObjectBody)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'self recipient registration accepts no query or identity fields');
    }
    if (auth.actor.issuer === 'du-local' || !auth.oidcSession || auth.role !== 'platform') {
      throw new HttpError(403, 'PERMISSION_DENIED', 'self recipient registration requires a verified external platform Admin session');
    }
    if (!auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
    const sessionId = trustedSessionId(ctx.headers.cookie);
    if (!sessionId) throw new HttpError(401, 'UNAUTHENTICATED', 'active opaque Admin session cookie is required');
    const principal = await ensureSelfRecipient(ctx.db, auth.oidcSession);
    const pinRecipient = ctx.config.adminSessionStore?.pinCostAlertRecipient;
    if (!pinRecipient) throw new HttpError(503, 'UPSTREAM_UNAVAILABLE', 'the current Admin session store cannot pin alert recipient authorization');
    const pinned = await pinRecipient.call(ctx.config.adminSessionStore, sessionId, principal.principalId, principal.authorizationVersion);
    if (!pinned) throw new HttpError(401, 'UNAUTHENTICATED', 'the current Admin session changed before alert recipient registration completed');
    return { status: 200, body: costAlertOidcRecipientDto(principal) };
  }

  const lifecycle = new RegExp(`^${PREFIX}/recipients/([^/]+)/lifecycle$`).exec(ctx.pathname);
  if (lifecycle) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'recipient lifecycle requires POST');
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'recipient lifecycle does not accept query parameters');
    const principalId = decodeUuidSegment(lifecycle[1] ?? '');
    if (!principalId) throw new HttpError(404, 'NOT_FOUND', 'not found');
    if (!auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
    if (!ctx.headers.cookie) throw new HttpError(401, 'UNAUTHENTICATED', 'active Admin session cookie is required');
    await requireCurrentOidcAdmin(ctx, auth);
    if (!auth.oidcSession) throw new HttpError(403, 'PERMISSION_DENIED', 'current OIDC Admin session is required');
    const body = parseBody(CostAlertRecipientLifecycleWriteSchema, ctx.body);
    const key = idempotencyKey(ctx);
    return {
      status: 200,
      body: await transitionCostAlertOidcRecipient(ctx.db, { principalId, ...body, idempotencyKey: key, actor: auth.oidcSession }),
    };
  }

  if (ctx.pathname === `${PREFIX}/channels`) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'cost alert channel catalog requires GET');
    if (Object.keys(values).some((key) => key !== 'tenantId')) throw new HttpError(422, 'INVALID_SCHEMA', 'channel catalog query accepts only tenantId');
    const tenantId = tenantScope(auth, values.tenantId);
    requireRead(auth, tenantId);
    return { status: 200, body: await service.listChannels(tenantId) };
  }

  if (ctx.pathname === `${PREFIX}/scope-catalog`) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'cost policy scope catalog requires GET');
    if (Object.keys(values).some((key) => !['tenantId', 'kind', 'q', 'limit', 'cursor', 'apiKeyId', 'profileId'].includes(key))) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'scope catalog query is invalid');
    }
    const tenantId = tenantScope(auth, values.tenantId);
    requireRead(auth, tenantId);
    if (!values.kind) throw new HttpError(422, 'INVALID_SCHEMA', 'scope catalog kind is required');
    const query = parseBody(CostPolicyScopeCatalogQuerySchema, {
      tenantId,
      kind: values.kind,
      ...(values.q !== undefined ? { q: values.q } : {}),
      ...(values.limit !== undefined ? { limit: parseLimit(values.limit) } : {}),
      ...(values.cursor !== undefined ? { cursor: values.cursor } : {}),
      ...(values.apiKeyId !== undefined ? { apiKeyId: values.apiKeyId } : {}),
      ...(values.profileId !== undefined ? { profileId: values.profileId } : {}),
    });
    return { status: 200, body: await service.listScopeCatalog(query) };
  }

  if (ctx.pathname === `${PREFIX}/inbox`) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'owner inbox requires GET');
    if (Object.keys(values).some((key) => !['tenantId', 'limit', 'cursor', 'unreadOnly'].includes(key))) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'owner inbox query is invalid');
    }
    const owner = auth.actor.issuer === 'du-local'
      ? (() => {
        const identity = requireOwnerInbox(auth, values.tenantId);
        return { tenantId: identity.tenantId, owner: { kind: 'local' as const, userId: identity.userId } };
      })()
      : await (async () => {
        const principal = await requireCurrentOidcAdmin(ctx, auth);
        const tenantId = tenantScope(auth, values.tenantId);
        if (!values.tenantId || tenantId !== values.tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'external Admin inbox requires an explicit tenant scope');
        return { tenantId, owner: { kind: 'oidc' as const, principalId: principal.principalId, authorizationVersion: principal.authorizationVersion } };
      })();
    const unreadOnly = values.unreadOnly === undefined ? false : values.unreadOnly === 'true'
      ? true : values.unreadOnly === 'false' ? false : null;
    if (unreadOnly === null) throw new HttpError(422, 'INVALID_SCHEMA', 'unreadOnly must be true or false');
    const query = parseBody(CostAlertInboxQuerySchema, {
      tenantId: owner.tenantId,
      limit: parseLimit(values.limit),
      unreadOnly,
      ...(values.cursor ? { cursor: values.cursor } : {}),
    });
    return { status: 200, body: await service.listOwnerInbox(query, owner.owner) };
  }

  const inboxRead = new RegExp(`^${PREFIX}/inbox/([^/]+)/read$`).exec(ctx.pathname);
  if (inboxRead) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'notification read receipt requires POST');
    const emptyObjectBody = typeof ctx.body === 'object' && ctx.body !== null && !Array.isArray(ctx.body)
      && Object.keys(ctx.body).length === 0;
    if (Object.keys(values).some((key) => key !== 'tenantId') || (ctx.body !== undefined && ctx.body !== null && !emptyObjectBody)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'notification read receipt accepts only tenantId and an empty body');
    }
    const owner = auth.actor.issuer === 'du-local'
      ? (() => {
        const identity = requireOwnerInbox(auth, values.tenantId);
        return { tenantId: identity.tenantId, owner: { kind: 'local' as const, userId: identity.userId } };
      })()
      : await (async () => {
        const principal = await requireCurrentOidcAdmin(ctx, auth);
        const tenantId = tenantScope(auth, values.tenantId);
        if (!values.tenantId || tenantId !== values.tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'external Admin inbox acknowledgement requires an explicit tenant scope');
        return { tenantId, owner: { kind: 'oidc' as const, principalId: principal.principalId, authorizationVersion: principal.authorizationVersion } };
      })();
    if (!auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
    if (!ctx.headers.cookie) throw new HttpError(401, 'UNAUTHENTICATED', 'active Admin session cookie is required');
    const alertId = decodeUuidSegment(inboxRead[1] ?? '');
    if (!alertId) throw new HttpError(404, 'NOT_FOUND', 'not found');
    return { status: 200, body: await service.markOwnerInboxRead(owner.tenantId, owner.owner, alertId) };
  }

  if (ctx.pathname === `${PREFIX}/bindings`) {
    if (ctx.method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'cost alert bindings require PUT');
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'cost alert binding writes do not accept query parameters');
    const body = parseBody(CostBudgetAlertBindingWriteSchema, ctx.body);
    requireMutation(ctx, auth, body.tenantId);
    if (body.owner?.kind === 'oidc') await requireCurrentOidcAdmin(ctx, auth);
    return {
      status: 200,
      body: await service.saveBinding(body, auth.actor, idempotencyKey(ctx)),
    };
  }

  const binding = new RegExp(`^${PREFIX}/bindings/([^/]+)$`).exec(ctx.pathname);
  if (binding) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'cost alert binding read requires GET');
    if (Object.keys(values).some((key) => key !== 'tenantId' && key !== 'budgetRevision')) throw new HttpError(422, 'INVALID_SCHEMA', 'binding read query is invalid');
    const budgetId = decodeUuidSegment(binding[1] ?? '');
    if (!budgetId) throw new HttpError(404, 'NOT_FOUND', 'not found');
    const tenantId = tenantScope(auth, values.tenantId);
    requireRead(auth, tenantId);
    if (!values.budgetRevision || !/^\d{1,9}$/.test(values.budgetRevision)) throw new HttpError(422, 'INVALID_SCHEMA', 'budgetRevision is required');
    const budgetRevision = Number(values.budgetRevision);
    if (budgetRevision < 1) throw new HttpError(422, 'INVALID_SCHEMA', 'budgetRevision must be positive');
    const bindingResult = await service.getBinding(tenantId, budgetId, budgetRevision);
    if (!bindingResult) throw new HttpError(404, 'NOT_FOUND', 'alert owner mapping was not found');
    return { status: 200, body: bindingResult };
  }

  if (ctx.pathname === PREFIX) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'cost alert history requires GET');
    const tenantId = tenantScope(auth, values.tenantId);
    requireRead(auth, tenantId);
    const query = parseBody(CostAlertListQuerySchema, {
      tenantId,
      limit: parseLimit(values.limit),
      ...(values.cursor ? { cursor: values.cursor } : {}),
      ...(values.budgetId ? { budgetId: values.budgetId } : {}),
      ...(values.kind ? { kind: values.kind } : {}),
    });
    return { status: 200, body: await service.listAlerts(query) };
  }

  return null;
}
