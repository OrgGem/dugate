import { createHash } from 'node:crypto';
import { HttpError, zodIssuesToProblem } from '../errors';
import { resolveAdminActionAuthAsync, type AdminPrincipal, type AdminSessionView } from '../../modules/admin-actions/rbac';
import { createIncidentService } from '../../modules/incidents/service';
import { projectConnectorSignalSnapshot } from '../../modules/incidents/connector-signals';
import { projectRuntimeReplicaSignals } from '../../modules/incidents/runtime-signals';
import { parseCookieHeader } from '../../app/admin/shell-auth';
import { SESSION_COOKIE_NAME, verifySessionCsrf, type SessionRecord } from '../../modules/auth/session-store';
import {
  IncidentAcknowledgeRequestSchema,
  IncidentAssignRequestSchema,
  IncidentListPageSchema,
  IncidentListQuerySchema,
  IncidentResolveRequestSchema,
  MaintenanceSuppressionCreateSchema,
} from '@du/contracts';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/incidents';
const LIST_QUERY = new Set(['tenantId', 'status', 'severity', 'source', 'search', 'limit', 'cursor']);

function parseQuery(search: URLSearchParams): unknown {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of search.entries()) {
    if (!LIST_QUERY.has(key) || Object.prototype.hasOwnProperty.call(raw, key)) throw new HttpError(422, 'INVALID_SCHEMA', 'incident query contains an unsupported or repeated parameter');
    if (key === 'limit') {
      if (!/^\d+$/.test(value)) throw new HttpError(422, 'INVALID_SCHEMA', 'incident limit must be an integer');
      raw[key] = Number(value);
    } else raw[key] = value;
  }
  const parsed = IncidentListQuerySchema.safeParse(raw);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

interface IncidentAuthContext {
  principal: AdminPrincipal | null;
  scope: 'platform' | 'tenant' | 'unscoped';
  tenantScope: string | null;
  actor: string;
  actorRole: string;
  actorIssuer?: string;
  actorSub?: string;
  cookie: boolean;
  csrfOk: boolean;
}

function principalForAuth(auth: Awaited<ReturnType<typeof resolveAdminActionAuthAsync>>, session: AdminSessionView | null): IncidentAuthContext {
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  if (session) {
    if (session.role === 'admin') {
      if (auth.kind === 'bearer' && auth.principal.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'session principal does not match the admin credential');
      return {
        principal: { role: 'platform' }, scope: 'platform', tenantScope: null,
        actor: session.sub ?? (auth.kind === 'cookie' ? auth.principalId ?? 'admin-session' : 'platform-admin'), actorRole: session.role,
        ...(session.issuer ? { actorIssuer: session.issuer } : {}), ...(session.sub ? { actorSub: session.sub } : {}),
        cookie: auth.kind === 'cookie', csrfOk: auth.kind === 'cookie' ? auth.csrfOk : true,
      };
    }
    if (!session.tenantId || (auth.kind === 'bearer' && (auth.principal.role !== 'tenant_operator' || auth.principal.tenantId !== session.tenantId))) {
      throw new HttpError(403, 'PERMISSION_DENIED', 'session principal does not match the tenant credential');
    }
    return {
      // Local USER principals are not tenant-wide incident operators. They
      // have no incident-specific read grant in this service, so keep their
      // scope tenant-bound for truthful denial but never promote the role
      // string into incident access. OIDC tenant operators retain their
      // established explicit RBAC path.
      principal: session.role === 'operator' && session.issuer !== 'du-local' ? { role: 'tenant_operator', tenantId: session.tenantId } : null,
      scope: 'tenant', tenantScope: session.tenantId,
      actor: session.sub ?? (auth.kind === 'cookie' ? auth.principalId ?? 'tenant-admin-session' : session.role === 'viewer' ? 'tenant-viewer' : 'tenant-operator'),
      actorRole: session.role,
      ...(session.issuer ? { actorIssuer: session.issuer } : {}), ...(session.sub ? { actorSub: session.sub } : {}),
      cookie: auth.kind === 'cookie', csrfOk: auth.kind === 'cookie' ? auth.csrfOk : true,
    };
  }
  if (auth.kind === 'bearer') {
    return {
      principal: auth.principal,
      scope: auth.principal.role === 'platform' ? 'platform' : 'tenant',
      tenantScope: auth.principal.role === 'tenant_operator' ? auth.principal.tenantId : null,
      actor: auth.principal.role === 'platform' ? 'platform-token' : 'tenant-operator',
      actorRole: auth.principal.role,
      cookie: false,
      csrfOk: true,
    };
  }
  if (auth.role === 'admin') return {
    principal: { role: 'platform' }, scope: 'platform', tenantScope: null, actor: auth.principalId ?? 'admin-session', actorRole: auth.role,
    ...(auth.issuer ? { actorIssuer: auth.issuer } : {}), ...(auth.principalId ? { actorSub: auth.principalId } : {}),
    cookie: true, csrfOk: auth.csrfOk,
  };
  if ((auth.role === 'operator' || auth.role === 'viewer') && auth.tenantId) return {
    principal: auth.role === 'operator' ? { role: 'tenant_operator', tenantId: auth.tenantId } : null,
    scope: 'tenant', tenantScope: auth.tenantId, actor: auth.principalId ?? (auth.role === 'viewer' ? 'tenant-viewer' : 'tenant-operator'), actorRole: auth.role,
    ...(auth.issuer ? { actorIssuer: auth.issuer } : {}), ...(auth.principalId ? { actorSub: auth.principalId } : {}),
    cookie: true, csrfOk: auth.csrfOk,
  };
  throw new HttpError(403, 'PERMISSION_DENIED', 'this session has no tenant or platform scope');
}

function requireWrite(auth: IncidentAuthContext, role: 'incident' | 'platform', ctx: RouteContext, session: AdminSessionView | null): void {
  if (auth.cookie && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  if (session && !verifySessionCsrf(session as SessionRecord, ctx.headers['x-csrf-token'])) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  if (!auth.principal) throw new HttpError(403, 'PERMISSION_DENIED', 'viewer sessions are read-only');
  if (role === 'platform' && auth.scope !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'platform operations require platform Admin access');
}

function requireIncidentRead(auth: IncidentAuthContext, session: AdminSessionView | null): void {
  if (session?.issuer === 'du-local' && session.role === 'operator') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'local users need an explicit incident grant to read tenant incident data');
  }
  if (auth.scope === 'unscoped') throw new HttpError(403, 'PERMISSION_DENIED', 'this session has no incident read scope');
}

async function projectQueueIntegrity(ctx: RouteContext, incidents: ReturnType<typeof createIncidentService>): Promise<void> {
  const sample = ctx.queueIntegrity();
  if (!sample) return;
  const sampledAt = Date.parse(sample.lastSweepAt);
  if (!Number.isFinite(sampledAt) || sampledAt > Date.now() + 30_000 || sampledAt < Date.now() - 7 * 24 * 60 * 60 * 1000) return;
  // A reconstructing queue is still being repaired, so only an explicit OK
  // sweep is recovery evidence. An absent or stale sample never becomes an
  // incident recovery signal.
  const active = sample.state !== 'OK' || sample.stalled > 0;
  const evidenceHash = createHash('sha256').update(`queue-integrity\0${sample.lastSweepAt}\0${sample.state}\0${sample.stalled}\0${sample.orphansLast}`).digest('hex').slice(0, 24);
  await incidents.upsertIncidentSignal({
    source: 'queue', sourceRef: 'orchestrator.queue-integrity', signalCode: 'queue-integrity-suspect',
    scope: { kind: 'platform' }, severity: sample.state === 'SUSPECT' ? 'high' : 'medium',
    state: active ? 'active' : 'recovered',
    summary: active
      ? `Queue integrity sweep is ${sample.state}; ${sample.stalled} delivery candidates remain stalled.`
      : `Queue integrity sweep recovered; the latest measured stalled count is ${sample.stalled}.`,
    sampledAt: sample.lastSweepAt, thresholdRevision: 'queue-integrity-sweep-v1',
    affectedResources: [
      { kind: 'service', ref: 'orchestrator', label: 'Orchestrator' },
      { kind: 'queue', ref: 'orchestrator-dispatch', label: 'Dispatch delivery queue' },
    ],
    counters: { stalled: sample.stalled, recentOrphans: sample.orphansLast },
    ...(active ? {} : { evidenceRef: `queue-sweep-${evidenceHash}` }),
  });
}

export async function handleInternalIncidentRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const suffix = ctx.pathname.slice(PREFIX.length) || '/';
  const session = await resolveSuppliedSession(ctx);
  const auth = principalForAuth(await resolveAdminActionAuthAsync(ctx.config, ctx.headers, ctx.config.adminSessionStore), session);
  const tenantScope = auth.tenantScope;
  // The identity service derives owner labels and enabled status from current
  // server rows; no owner id or label supplied by the browser is trusted.
  const incidents = createIncidentService(ctx.db, ctx.audit, undefined, async ({ tenantId, ownerId }) => {
    const identity = ctx.identity;
    if (!identity) throw new HttpError(503, 'IDENTITY_LOOKUP_UNAVAILABLE', 'incident assignment requires the authorized Identity directory');
    const owner = tenantId === null
      ? await identity.resolveAssignablePlatformIdentityOwner({ userId: ownerId })
      : await identity.resolveAssignableIdentityOwner({ tenantId, userId: ownerId });
    return owner ? { id: owner.id, tenantId: owner.tenantId, role: owner.role } : null;
  });

  if (suffix === '/' || suffix === '') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'incident list requires GET');
    requireIncidentRead(auth, session);
    const query = parseQuery(ctx.searchParams) as ReturnType<typeof IncidentListQuerySchema.parse>;
    if (auth.scope === 'platform') await projectQueueIntegrity(ctx, incidents);
    const sourceTenant = auth.scope === 'tenant' ? tenantScope : query.tenantId ?? null;
    await projectRuntimeReplicaSignals({ store: ctx.maintenanceService, incidents, tenantId: sourceTenant });
    const connectorSignals = await projectConnectorSignalSnapshot({ store: ctx.connectorManagement, incidents, tenantId: sourceTenant });
    const page = await incidents.listIncidents(query, tenantScope);
    return { status: 200, body: IncidentListPageSchema.parse({ ...page, connectorSignals }) };
  }
  if (suffix === '/maintenance-suppressions') {
    if (ctx.method === 'GET') {
      requireIncidentRead(auth, session);
      if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'maintenance suppressions do not accept query parameters');
      return { status: 200, body: await incidents.listSuppressions(tenantScope) };
    }
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'maintenance suppressions accept GET or POST');
    requireWrite(auth, 'incident', ctx, session);
    const body = parseBody(MaintenanceSuppressionCreateSchema, ctx.body);
    return { status: 201, body: await incidents.createSuppression({
      tenantScope, actor: auth.actor, actorRole: auth.actorRole, actorIssuer: auth.actorIssuer, actorSub: auth.actorSub,
      correlationId: ctx.correlationId, body,
    }) };
  }

  const detailMatch = /^\/([^/]+)$/.exec(suffix);
  if (detailMatch) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'incident detail requires GET');
    requireIncidentRead(auth, session);
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'incident detail does not accept query parameters');
    const id = decodeId(detailMatch[1] ?? '');
    const detail = await incidents.getIncident(id, tenantScope);
    if (!detail) throw new HttpError(404, 'NOT_FOUND', 'incident was not found');
    return { status: 200, body: detail };
  }

  const actionMatch = /^\/([^/]+)\/(assign|acknowledge|resolve)$/.exec(suffix);
  if (actionMatch) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'incident actions require POST');
    requireWrite(auth, 'incident', ctx, session);
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'incident actions do not accept query parameters');
    const incidentId = decodeId(actionMatch[1] ?? '');
    const kind = actionMatch[2] as 'assign' | 'acknowledge' | 'resolve';
    const schema = kind === 'assign' ? IncidentAssignRequestSchema : kind === 'acknowledge' ? IncidentAcknowledgeRequestSchema : IncidentResolveRequestSchema;
    const body = parseBody(schema, ctx.body);
    const detail = await incidents.transition({ incidentId, tenantScope, expectedVersion: body.expectedVersion,
      actor: auth.actor, actorRole: auth.actorRole, actorIssuer: auth.actorIssuer, actorSub: auth.actorSub,
      correlationId: ctx.correlationId, kind, body });
    return { status: 200, body: detail };
  }
  throw new HttpError(404, 'NOT_FOUND', 'incident route was not found');
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

function decodeId(segment: string): string {
  let id: string;
  try { id = decodeURIComponent(segment); } catch { throw new HttpError(404, 'NOT_FOUND', 'incident was not found'); }
  if (!/^[0-9a-f-]{36}$/i.test(id)) throw new HttpError(404, 'NOT_FOUND', 'incident was not found');
  return id;
}
