import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  ConfirmQueueActionSchema,
  ExecuteReplicaRollbackSchema,
  ExecuteReplicaRolloutSchema,
  MaintenancePreviewRequestSchema,
  PreviewReplicaRollbackSchema,
  QueueActionPreviewRequestSchema,
  ReplicaRolloutPreviewRequestSchema,
  StartMaintenanceJobSchema,
  StorageGenerationActionRequestSchema,
  StorageGenerationStageRequestSchema,
  StorageGenerationTestRequestSchema,
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

export type MaintenanceRoute =
  | { kind: 'services' | 'queues' }
  | { kind: 'queue-preview' | 'queue-execute' | 'maintenance-preview' | 'maintenance-start' | 'rollout-preview' | 'rollout-execute' | 'storage-list' | 'storage-current' | 'storage-stage' }
  | { kind: 'queue-job' | 'maintenance-job' | 'rollout-job'; id: string }
  | { kind: 'queue-action-job'; id: string }
  | { kind: 'rollout-rollback-preview' | 'rollout-rollback-execute'; id: string }
  | { kind: 'storage-action'; id: string; action: 'test' | 'activate' | 'rollback' }
  | { kind: 'invalid' };

function safeId(raw: string): string | null {
  const id = decodePathSegment(raw);
  return id && /^[A-Za-z0-9._:@/-]{1,256}$/.test(id) ? id : null;
}

export function matchMaintenanceRoute(relative: string): MaintenanceRoute | null {
  if (relative === '/maintenance/services') return { kind: 'services' };
  if (relative === '/maintenance/queues') return { kind: 'queues' };
  if (relative === '/maintenance/queue-actions/preview') return { kind: 'queue-preview' };
  if (relative === '/maintenance/queue-actions') return { kind: 'queue-execute' };
  if (relative === '/maintenance/previews') return { kind: 'maintenance-preview' };
  if (relative === '/maintenance/jobs') return { kind: 'maintenance-start' };
  if (relative === '/maintenance/rollouts/preview') return { kind: 'rollout-preview' };
  if (relative === '/maintenance/rollouts') return { kind: 'rollout-execute' };
  if (relative === '/maintenance/storage-generations') return { kind: 'storage-list' };
  if (relative === '/maintenance/storage-generations/current') return { kind: 'storage-current' };
  if (relative === '/maintenance/storage-generations/stage') return { kind: 'storage-stage' };
  const storage = /^\/maintenance\/storage-generations\/([^/]+)\/(test|activate|rollback)$/.exec(relative);
  if (storage) {
    const id = safeId(storage[1] ?? '');
    return id ? { kind: 'storage-action', id, action: storage[2] as 'test' | 'activate' | 'rollback' } : { kind: 'invalid' };
  }
  const rollback = /^\/maintenance\/rollouts\/([^/]+)\/rollback\/(preview)?$/.exec(relative);
  if (rollback) {
    const id = safeId(rollback[1] ?? '');
    return id ? { kind: rollback[2] ? 'rollout-rollback-preview' : 'rollout-rollback-execute', id } : { kind: 'invalid' };
  }
  const job = /^\/maintenance\/(queue-actions|jobs|rollouts)\/([^/]+)$/.exec(relative);
  if (job) {
    const id = safeId(job[2] ?? '');
    if (!id) return { kind: 'invalid' };
    if (job[1] === 'queue-actions') return { kind: 'queue-action-job', id };
    return job[1] === 'jobs' ? { kind: 'maintenance-job', id } : { kind: 'rollout-job', id };
  }
  return null;
}

function sessionProof(request: AdminShellRequest, csrfToken: string): { cookie: string; csrfToken: string } | undefined {
  const session = request.cookies['du_session'];
  if (typeof session === 'string' && /^[A-Za-z0-9_-]{43}$/.test(session)) {
    return { cookie: `du_session=${encodeURIComponent(session)}`, csrfToken };
  }
  const legacy = request.cookies['du_admin'];
  if (typeof legacy === 'string' && legacy.length > 0 && legacy.length <= 4096) {
    return { cookie: `du_admin=${encodeURIComponent(legacy)}`, csrfToken };
  }
  return undefined;
}

function targetPath(route: Exclude<MaintenanceRoute, { kind: 'invalid' }>): string {
  switch (route.kind) {
    case 'services': return '/api/internal/maintenance/services';
    case 'queues': return '/api/internal/maintenance/queues';
    case 'queue-preview': return '/api/internal/maintenance/queue-actions/preview';
    case 'queue-execute': return '/api/internal/maintenance/queue-actions';
    case 'queue-action-job': return `/api/internal/maintenance/queue-actions/${encodeURIComponent(route.id)}`;
    case 'maintenance-preview': return '/api/internal/maintenance/previews';
    case 'maintenance-start': return '/api/internal/maintenance/jobs';
    case 'maintenance-job': return `/api/internal/maintenance/jobs/${encodeURIComponent(route.id)}`;
    case 'rollout-preview': return '/api/internal/maintenance/rollouts/preview';
    case 'rollout-execute': return '/api/internal/maintenance/rollouts';
    case 'rollout-job': return `/api/internal/maintenance/rollouts/${encodeURIComponent(route.id)}`;
    case 'rollout-rollback-preview': return `/api/internal/maintenance/rollouts/${encodeURIComponent(route.id)}/rollback/preview`;
    case 'rollout-rollback-execute': return `/api/internal/maintenance/rollouts/${encodeURIComponent(route.id)}/rollback`;
    case 'storage-list': return '/api/internal/maintenance/storage-generations';
    case 'storage-current': return '/api/internal/maintenance/storage-generations/current';
    case 'storage-stage': return '/api/internal/maintenance/storage-generations/stage';
    case 'storage-action': return `/api/internal/maintenance/storage-generations/${encodeURIComponent(route.id)}/${route.action}`;
  }
  throw new Error('unreachable maintenance route');
}

function bodySchema(route: Exclude<MaintenanceRoute, { kind: 'invalid' }>) {
  switch (route.kind) {
    case 'queue-preview': return QueueActionPreviewRequestSchema;
    case 'queue-execute': return ConfirmQueueActionSchema;
    case 'maintenance-preview': return MaintenancePreviewRequestSchema;
    case 'maintenance-start': return StartMaintenanceJobSchema;
    case 'rollout-preview': return ReplicaRolloutPreviewRequestSchema;
    case 'rollout-execute': return ExecuteReplicaRolloutSchema;
    case 'rollout-rollback-preview': return PreviewReplicaRollbackSchema;
    case 'rollout-rollback-execute': return ExecuteReplicaRollbackSchema;
    case 'storage-stage': return StorageGenerationStageRequestSchema;
    case 'storage-action': return route.action === 'test' ? StorageGenerationTestRequestSchema : StorageGenerationActionRequestSchema;
    default: return null;
  }
}

function allowedQuery(route: Exclude<MaintenanceRoute, { kind: 'invalid' }>): ReadonlySet<string> {
  return route.kind === 'services' || route.kind === 'queues' ? new Set(['tenantId']) : new Set();
}

export async function handleMaintenanceRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: MaintenanceRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') { writeProblem(res, 404, 'NOT_FOUND', 'maintenance path is invalid', correlationId); return; }
  const method = (req.method ?? 'GET').toUpperCase();
  const read = route.kind === 'services' || route.kind === 'queues' || route.kind.endsWith('-job') || route.kind === 'storage-current' || route.kind === 'storage-list';
  if ((read && method !== 'GET') || (!read && method !== 'POST')) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'maintenance reads require GET and commands require POST', correlationId); return;
  }
  const ctx = await resolveBffContext(config, request);
  if (!ctx) { writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId); return; }
  if (ctx.role !== 'admin' || ctx.principal.kind !== 'platform') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'maintenance controls require platform Admin access', correlationId); return;
  }
  const credential = credentialFor(ctx.principal, runtime);
  if (!credential) { writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'platform Admin credential is not configured', correlationId); return; }
  const mutation = !read;
  if (mutation) {
    const csrf = firstHeaderValue(req.headers['x-csrf-token']);
    if (!ctx.verifyCsrf(csrf)) { writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId); return; }
  }
  const allow = allowedQuery(route);
  const queryValues: Record<string, string> = {};
  for (const [key, value] of query.entries()) {
    if (!allow.has(key) || Object.hasOwn(queryValues, key)) { writeProblem(res, 422, 'INVALID_SCHEMA', 'maintenance query is invalid', correlationId); return; }
    queryValues[key] = value;
  }
  let jsonBody: string | undefined;
  let idempotencyKey: string | undefined;
  const schema = bodySchema(route);
  if (schema) {
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
    let value: unknown;
    try { value = raw.length === 0 ? null : JSON.parse(raw); }
    catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
    const parsed = schema.safeParse(value);
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'maintenance request body is invalid', correlationId); return; }
    jsonBody = JSON.stringify(parsed.data);
    const key = parsed.data && typeof parsed.data === 'object' ? (parsed.data as Record<string, unknown>).idempotencyKey : undefined;
    idempotencyKey = typeof key === 'string' ? key : undefined;
  } else if (query.size > 0 && (route.kind === 'storage-current' || route.kind === 'storage-list' || route.kind.endsWith('-job'))) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'maintenance status reads do not accept query parameters', correlationId); return;
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) { writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the Admin API is not configured', correlationId); return; }
  const upstream = new URL(targetPath(route), runtime.jsonBaseUrl);
  for (const [key, value] of Object.entries(queryValues)) upstream.searchParams.set(key, value);
  const response = await callUpstream(runtime, upstream, {
    method: method as 'GET' | 'POST', credential, correlationId,
    ...(jsonBody !== undefined ? { jsonBody } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(mutation ? { sessionProof: sessionProof(request, ctx.csrfToken) } : {}),
  });
  await relayUpstream(res, response, correlationId);
  return;
}
