import { HttpError, zodIssuesToProblem } from '../errors';
import type { RouteContext, RouteResult } from '../route-context';
import { resolveAdminActionAuthAsync } from '../../modules/admin-actions/rbac';
import { parseCookieHeader } from '../../app/admin/shell-auth';
import {
  QueueActionPreviewRequestSchema, ConfirmQueueActionSchema, MaintenancePreviewRequestSchema,
  StartMaintenanceJobSchema, ReplicaRolloutPreviewRequestSchema, ExecuteReplicaRolloutSchema,
  PreviewReplicaRollbackSchema, ExecuteReplicaRollbackSchema, StorageGenerationStageRequestSchema,
  StorageGenerationTestRequestSchema, StorageGenerationActionRequestSchema,
} from '@du/contracts';
import type { createMaintenanceService } from '../../modules/maintenance/maintenance-service';

const PREFIX = '/api/internal/maintenance';
type MaintenanceService = ReturnType<typeof createMaintenanceService>;
type Actor = { actor: string; actorRole: string; actorIssuer?: string; actorSub?: string };

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, body: unknown): T {
  const parsed = schema.safeParse(body);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function parseTenant(search: URLSearchParams): string | undefined {
  let tenantId: string | undefined;
  for (const [key, value] of search.entries()) {
    if (key !== 'tenantId' || tenantId !== undefined || !/^[A-Za-z0-9._:@/-]{1,256}$/.test(value)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'maintenance inventory query is invalid');
    }
    tenantId = value;
  }
  return tenantId;
}

async function platformActor(ctx: RouteContext, mutation: boolean): Promise<Actor> {
  const auth = await resolveAdminActionAuthAsync(ctx.config, { authorization: ctx.headers.authorization }, undefined);
  if (!auth || auth.kind !== 'bearer' || auth.principal.role !== 'platform') {
    throw new HttpError(auth ? 403 : 401, auth ? 'PERMISSION_DENIED' : 'UNAUTHENTICATED', 'platform Admin authentication is required');
  }
  const rawCookie = ctx.headers.cookie;
  if (!rawCookie) return { actor: 'platform-token', actorRole: 'platform' };
  const parts = rawCookie.split(';').map((part) => part.trim()).filter(Boolean);
  const cookies = parseCookieHeader(rawCookie);
  const entries = Object.entries(cookies);
  if (parts.length !== 1 || entries.length !== 1 || !['du_session', 'du_admin'].includes(entries[0]?.[0] ?? '')) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'Admin session proof is invalid');
  }
  const sessionAuth = await resolveAdminActionAuthAsync(ctx.config, {
    cookie: rawCookie,
    'x-csrf-token': ctx.headers['x-csrf-token'],
  }, ctx.config.adminSessionStore);
  if (!sessionAuth || sessionAuth.kind !== 'cookie' || sessionAuth.role !== 'admin') {
    throw new HttpError(401, 'UNAUTHENTICATED', 'platform Admin session is not active');
  }
  if (mutation && !sessionAuth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  const name = entries[0]![0];
  return {
    actor: name === 'du_session' ? 'admin-session' : 'legacy:admin', actorRole: 'platform',
    ...(name === 'du_session' && sessionAuth.issuer ? { actorIssuer: sessionAuth.issuer } : {}),
    ...(name === 'du_session' && sessionAuth.principalId ? { actorSub: sessionAuth.principalId } : {}),
  };
}

function decodeId(value: string): string {
  let decoded: string;
  try { decoded = decodeURIComponent(value); } catch { throw new HttpError(404, 'NOT_FOUND', 'maintenance resource was not found'); }
  if (decoded.includes('/') || decoded.includes('\\') || !/^[A-Za-z0-9._:@/-]{1,256}$/.test(decoded)) {
    throw new HttpError(404, 'NOT_FOUND', 'maintenance resource was not found');
  }
  return decoded;
}

export async function handleInternalMaintenanceRoutes(ctx: RouteContext, service: MaintenanceService): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const suffix = ctx.pathname.slice(PREFIX.length) || '/';
  const mutation = ctx.method === 'POST';
  const actor = await platformActor(ctx, mutation);

  if (suffix === '/services' || suffix === '/queues') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'inventory requires GET');
    const requestedTenantId = parseTenant(ctx.searchParams);
    return { status: 200, body: suffix === '/services' ? await service.getServiceInventory(requestedTenantId) : await service.getQueueInventory(requestedTenantId) };
  }
  if ([...ctx.searchParams].length > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'maintenance action routes do not accept query parameters');

  if (suffix === '/storage-generations') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'storage generation history requires GET');
    return { status: 200, body: await service.listStorageGenerations() };
  }
  if (suffix === '/queue-actions/preview') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'queue action preview requires POST');
    return { status: 201, body: await service.createQueueActionPreview(actor, parseBody(QueueActionPreviewRequestSchema, ctx.body)) };
  }
  if (suffix === '/queue-actions') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'queue action requires POST');
    return { status: 201, body: await service.executeQueueAction(actor, parseBody(ConfirmQueueActionSchema, ctx.body)) };
  }
  const queueJobMatch = /^\/queue-actions\/([^/]+)$/.exec(suffix);
  if (queueJobMatch) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'queue action status requires GET');
    return { status: 200, body: await service.getQueueActionJob(decodeId(queueJobMatch[1]!)) };
  }
  if (suffix === '/previews') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'maintenance preview requires POST');
    return { status: 201, body: await service.createMaintenancePreview(actor, parseBody(MaintenancePreviewRequestSchema, ctx.body)) };
  }
  if (suffix === '/jobs') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'maintenance job start requires POST');
    return { status: 202, body: await service.startMaintenanceJob(actor, parseBody(StartMaintenanceJobSchema, ctx.body)) };
  }
  const maintenanceJobMatch = /^\/jobs\/([^/]+)$/.exec(suffix);
  if (maintenanceJobMatch) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'maintenance job status requires GET');
    return { status: 200, body: await service.getMaintenanceJob(decodeId(maintenanceJobMatch[1]!)) };
  }
  if (suffix === '/rollouts/preview') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'replica rollout preview requires POST');
    return { status: 201, body: await service.createRolloutPreview(actor, parseBody(ReplicaRolloutPreviewRequestSchema, ctx.body)) };
  }
  if (suffix === '/rollouts') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'replica rollout requires POST');
    return { status: 202, body: await service.executeRollout(actor, parseBody(ExecuteReplicaRolloutSchema, ctx.body)) };
  }
  const rollbackPreview = /^\/rollouts\/([^/]+)\/rollback\/preview$/.exec(suffix);
  if (rollbackPreview) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'rollout rollback preview requires POST');
    return { status: 201, body: await service.createRollbackPreview(actor, decodeId(rollbackPreview[1]!), parseBody(PreviewReplicaRollbackSchema, ctx.body)) };
  }
  const rollbackExecute = /^\/rollouts\/([^/]+)\/rollback$/.exec(suffix);
  if (rollbackExecute) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'rollout rollback requires POST');
    return { status: 200, body: await service.executeRollback(actor, decodeId(rollbackExecute[1]!), parseBody(ExecuteReplicaRollbackSchema, ctx.body)) };
  }
  const rolloutJob = /^\/rollouts\/([^/]+)$/.exec(suffix);
  if (rolloutJob) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'replica rollout status requires GET');
    return { status: 200, body: await service.getRolloutJob(decodeId(rolloutJob[1]!)) };
  }
  if (suffix === '/storage-generations/current') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'storage generation current requires GET');
    return { status: 200, body: await service.currentStorageGeneration() };
  }
  if (suffix === '/storage-generations/stage') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'storage generation stage requires POST');
    return { status: 201, body: await service.stageStorageGeneration(parseBody(StorageGenerationStageRequestSchema, ctx.body), actor) };
  }
  const storageGeneration = /^\/storage-generations\/([^/]+)\/(test|activate|rollback)$/.exec(suffix);
  if (storageGeneration) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'storage generation action requires POST');
    const id = decodeId(storageGeneration[1]!);
    const action = storageGeneration[2]!;
    if (action === 'test') return { status: 200, body: await service.testStorageGeneration(id, parseBody(StorageGenerationTestRequestSchema, ctx.body), actor) };
    if (action === 'activate') return { status: 200, body: await service.activateStorageGeneration(id, parseBody(StorageGenerationActionRequestSchema, ctx.body), actor) };
    return { status: 200, body: await service.rollbackStorageGeneration(id, parseBody(StorageGenerationActionRequestSchema, ctx.body), actor) };
  }
  throw new HttpError(404, 'NOT_FOUND', 'maintenance route was not found');
}
