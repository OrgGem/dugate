import { timingSafeEqual } from 'node:crypto';
import { HttpError, zodIssuesToProblem } from '../errors';
import { resolveAdminActionAuthAsync } from '../../modules/admin-actions/rbac';
import { parseCookieHeader } from '../../app/admin/shell-auth';
import { readIdempotencyKey } from '../../modules/idempotency/idempotency';
import {
  ComposeJobListQuerySchema,
  ComposePreviewRequestSchema,
  ComposeRunnerCompleteRequestSchema,
  ComposeRunnerReconcileRequestSchema,
  ComposeRunnerSnapshotRequestSchema,
  ComposeRunnerStartRequestSchema,
  ComposeSubmitJobRequestSchema,
} from '../../modules/compose-operations/contracts';
import type { RouteContext, RouteResult } from '../route-context';
import type { ComposeAdminActor } from '../../modules/compose-operations/service';

const PREFIX = '/api/internal/compose';
const JOB_QUERY = new Set(['hostId', 'projectId', 'state', 'limit', 'cursor']);

function parseQuery(search: URLSearchParams): Record<string, unknown> {
  const raw: Record<string, unknown> = {};
  for (const [key, value] of search.entries()) {
    if (!JOB_QUERY.has(key) || Object.prototype.hasOwnProperty.call(raw, key)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'Compose job query contains an unsupported or repeated parameter');
    }
    raw[key] = key === 'limit' && /^\d+$/.test(value) ? Number(value) : value;
    if (key === 'limit' && !/^\d+$/.test(value)) throw new HttpError(422, 'INVALID_SCHEMA', 'Compose limit must be an integer');
  }
  return raw;
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function validRunnerBearer(ctx: RouteContext): boolean {
  const configured = ctx.config.composeRunner?.runnerToken;
  const raw = ctx.headers['authorization'];
  if (!configured || typeof raw !== 'string' || !raw.startsWith('Bearer ')) return false;
  const offered = Buffer.from(raw.slice(7), 'utf8');
  const expected = Buffer.from(configured, 'utf8');
  return offered.length === expected.length && timingSafeEqual(offered, expected);
}

async function platformAdminActor(ctx: RouteContext, mutation: boolean): Promise<ComposeAdminActor> {
  const auth = await resolveAdminActionAuthAsync(ctx.config, { authorization: ctx.headers['authorization'] }, undefined);
  if (!auth || auth.kind !== 'bearer') throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  if (auth.principal.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'Compose administration requires the platform Admin credential');

  const rawCookie = ctx.headers['cookie'];
  if (typeof rawCookie !== 'string' || rawCookie.length === 0) return { actorLabel: 'platform-token' };
  const cookieParts = rawCookie.split(';').map((part) => part.trim()).filter((part) => part.length > 0);
  const parsedCookies = parseCookieHeader(rawCookie);
  const cookieEntries = Object.entries(parsedCookies);
  if (cookieParts.length !== 1 || cookieEntries.length !== 1 || !['du_session', 'du_admin'].includes(cookieEntries[0]?.[0] ?? '')) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Compose actor session proof is invalid');
  }
  const cookieAuth = await resolveAdminActionAuthAsync(ctx.config, {
    cookie: rawCookie,
    'x-csrf-token': ctx.headers['x-csrf-token'],
  }, ctx.config.adminSessionStore);
  if (!cookieAuth || cookieAuth.kind !== 'cookie') throw new HttpError(401, 'UNAUTHENTICATED', 'Compose actor session is no longer valid');
  // The existing BFF policy treats the Admin role as platform scoped. Local
  // Admin credentials still carry their configured tenant UUID, so tenantId
  // must not narrow this separately authenticated platform Admin session.
  if (cookieAuth.role !== 'admin') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'Compose administration requires a platform Admin session');
  }
  if (mutation && !cookieAuth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  const cookieName = cookieEntries[0]?.[0];
  return {
    actorLabel: cookieName === 'du_session'
      ? (cookieAuth.principalId ? 'admin-session' : 'shell:admin')
      : 'legacy:admin',
    ...(cookieName === 'du_session' && cookieAuth.issuer ? { actorIssuer: cookieAuth.issuer } : {}),
    ...(cookieName === 'du_session' && cookieAuth.principalId ? { actorSub: cookieAuth.principalId } : {}),
  };
}

export async function handleInternalComposeRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const suffix = ctx.pathname.slice(PREFIX.length) || '/';

  if (suffix.startsWith('/runner/')) {
    if (!ctx.config.composeRunner) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Compose runner is not configured');
    if (!validRunnerBearer(ctx)) throw new HttpError(401, 'UNAUTHENTICATED', 'dedicated Compose runner authentication is required');
    if ([...ctx.searchParams].length > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'Compose runner requests do not accept query parameters');
    const runnerJobMatch = /^\/runner\/jobs\/([^/]+)$/.exec(suffix);
    if (runnerJobMatch) {
      if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'runner job status requires GET');
      let jobId: string;
      try { jobId = decodeURIComponent(runnerJobMatch[1]!); } catch { throw new HttpError(404, 'NOT_FOUND', 'Compose job was not found'); }
      if (jobId.includes('/') || jobId.includes('\\')) throw new HttpError(404, 'NOT_FOUND', 'Compose job was not found');
      return { status: 200, body: await ctx.composeOperations.getJob(jobId) };
    }
    switch (suffix) {
      case '/runner/snapshot':
        if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'snapshot requires POST');
        return { status: 200, body: await ctx.composeOperations.publishSnapshot(parseBody(ComposeRunnerSnapshotRequestSchema, ctx.body)) };
      case '/runner/claim':
        if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'claim requires POST');
        if (ctx.body !== undefined && ctx.body !== null && (typeof ctx.body !== 'object' || Array.isArray(ctx.body) || Object.keys(ctx.body).length > 0)) {
          throw new HttpError(422, 'INVALID_SCHEMA', 'claim accepts an empty body');
        }
        return { status: 200, body: await ctx.composeOperations.claimNextJob() };
      case '/runner/start':
        if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'start requires POST');
        return { status: 200, body: await ctx.composeOperations.startJob(parseBody(ComposeRunnerStartRequestSchema, ctx.body)) };
      case '/runner/complete':
        if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'complete requires POST');
        return { status: 200, body: await ctx.composeOperations.completeJob(parseBody(ComposeRunnerCompleteRequestSchema, ctx.body)) };
      case '/runner/reconcile':
        if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'reconcile requires POST');
        return { status: 200, body: await ctx.composeOperations.reconcileJob(parseBody(ComposeRunnerReconcileRequestSchema, ctx.body)) };
      default:
        throw new HttpError(404, 'NOT_FOUND', 'Compose runner route was not found');
    }
  }

  // This internal audience is not itself a grant of platform authority.
  // BFF mutations pair the trusted platform bearer with a separately checked
  // active browser session; direct bearer calls have platform-token attribution.
  const isMutation = ctx.method === 'POST';
  const actor = await platformAdminActor(ctx, isMutation);

  if (suffix === '/catalog') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Compose catalog requires GET');
    if ([...ctx.searchParams].length > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'Compose catalog does not accept query parameters');
    return { status: 200, body: await ctx.composeOperations.getCatalog() };
  }
  if (suffix === '/previews') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Compose preview requires POST');
    if ([...ctx.searchParams].length > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'Compose preview does not accept query parameters');
    return { status: 201, body: await ctx.composeOperations.createPreview(actor, parseBody(ComposePreviewRequestSchema, ctx.body)) };
  }
  if (suffix === '/jobs') {
    if (ctx.method === 'GET') {
      const query = parseBody(ComposeJobListQuerySchema, parseQuery(ctx.searchParams));
      return { status: 200, body: await ctx.composeOperations.listJobs(query) };
    }
    if (ctx.method === 'POST') {
      if ([...ctx.searchParams].length > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'Compose submission does not accept query parameters');
      const idempotencyKey = readIdempotencyKey(ctx.headers);
      if (!idempotencyKey) throw new HttpError(422, 'INVALID_SCHEMA', 'Compose submission requires an Idempotency-Key');
      return { status: 201, body: await ctx.composeOperations.submitJob(actor, parseBody(ComposeSubmitJobRequestSchema, ctx.body), idempotencyKey) };
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Compose jobs accepts GET or POST');
  }
  const jobMatch = /^\/jobs\/([^/]+)$/.exec(suffix);
  if (jobMatch) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Compose job detail requires GET');
    if ([...ctx.searchParams].length > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'Compose job detail does not accept query parameters');
    let jobId: string;
    try { jobId = decodeURIComponent(jobMatch[1]!); } catch { throw new HttpError(404, 'NOT_FOUND', 'Compose job was not found'); }
    if (jobId.includes('/') || jobId.includes('\\')) throw new HttpError(404, 'NOT_FOUND', 'Compose job was not found');
    return { status: 200, body: await ctx.composeOperations.getJob(jobId) };
  }
  throw new HttpError(404, 'NOT_FOUND', 'Compose route was not found');
}
