import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { ComposeJobListQuerySchema, ComposePreviewRequestSchema, ComposeSubmitJobRequestSchema } from '../../../modules/compose-operations/contracts';
import { readBoundedBody } from './body';
import { resolveBffContext, type BffContext } from './context';
import {
  callUpstream,
  credentialFor,
  decodePathSegment,
  firstHeaderValue,
  relayUpstream,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';

export type ComposeRoute = { kind: 'catalog' | 'preview' | 'jobs' } | { kind: 'job'; jobId: string } | { kind: 'invalid' };

function activeSessionProof(request: AdminShellRequest, ctx: BffContext): { cookie: string; csrfToken: string } | undefined {
  if (ctx.plane === 'oidc') {
    const id = request.cookies['du_session'];
    if (typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id)) return { cookie: `du_session=${encodeURIComponent(id)}`, csrfToken: ctx.csrfToken };
    return undefined;
  }
  const cookie = request.cookies['du_admin'];
  if (typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 4096) {
    return { cookie: `du_admin=${encodeURIComponent(cookie)}`, csrfToken: ctx.csrfToken };
  }
  return undefined;
}

export function matchComposeRoute(relative: string): ComposeRoute | null {
  if (relative === '/compose/catalog') return { kind: 'catalog' };
  if (relative === '/compose/previews') return { kind: 'preview' };
  if (relative === '/compose/jobs') return { kind: 'jobs' };
  const match = /^\/compose\/jobs\/([^/]+)$/.exec(relative);
  if (match) {
    const jobId = decodePathSegment(match[1] ?? '');
    return jobId === null ? { kind: 'invalid' } : { kind: 'job', jobId };
  }
  return null;
}

const JOB_QUERY = new Set(['hostId', 'projectId', 'state', 'limit', 'cursor']);

export async function handleComposeRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: ComposeRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'Compose job path is invalid', correlationId);
    return;
  }
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  if (ctx.role !== 'admin' || ctx.principal.kind !== 'platform') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'Compose administration requires platform Admin access', correlationId);
    return;
  }
  const sessionProof = activeSessionProof(request, ctx);
  if (!sessionProof) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'the active Admin session proof is unavailable', correlationId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const write = route.kind === 'preview' || (route.kind === 'jobs' && method === 'POST');
  if ((route.kind === 'catalog' || route.kind === 'job' || route.kind === 'jobs') && method !== 'GET' && !(route.kind === 'jobs' && method === 'POST')) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'Compose read routes require GET and submission requires POST', correlationId);
    return;
  }
  if (route.kind === 'preview' && method !== 'POST') {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'Compose preview requires POST', correlationId);
    return;
  }
  if (write && !ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
    return;
  }
  const credential = credentialFor(ctx.principal, runtime);
  if (!credential || typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'Compose administration is not configured', correlationId);
    return;
  }

  let upstreamUrl: URL;
  let jsonBody: string | undefined;
  let idempotencyKey: string | undefined;
  if (route.kind === 'catalog') {
    if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'Compose catalog does not accept query parameters', correlationId); return; }
    upstreamUrl = new URL('/api/internal/compose/catalog', runtime.jsonBaseUrl);
  } else if (route.kind === 'preview') {
    if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'Compose preview does not accept query parameters', correlationId); return; }
    const body = await readComposeBody(req, res, correlationId, ComposePreviewRequestSchema);
    if (body === null) return;
    jsonBody = JSON.stringify(body);
    upstreamUrl = new URL('/api/internal/compose/previews', runtime.jsonBaseUrl);
  } else if (route.kind === 'job') {
    if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'Compose job detail does not accept query parameters', correlationId); return; }
    upstreamUrl = new URL(`/api/internal/compose/jobs/${encodeURIComponent(route.jobId)}`, runtime.jsonBaseUrl);
  } else if (method === 'GET') {
    const raw: Record<string, unknown> = {};
    for (const [key, value] of query.entries()) {
      if (!JOB_QUERY.has(key) || Object.prototype.hasOwnProperty.call(raw, key)) {
        writeProblem(res, 422, 'INVALID_SCHEMA', 'Compose job query contains an unsupported or repeated parameter', correlationId);
        return;
      }
      raw[key] = key === 'limit' && /^\d+$/.test(value) ? Number(value) : value;
      if (key === 'limit' && !/^\d+$/.test(value)) { writeProblem(res, 422, 'INVALID_SCHEMA', 'Compose limit must be an integer', correlationId); return; }
    }
    const parsed = ComposeJobListQuerySchema.safeParse(raw);
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'Compose job query is invalid', correlationId); return; }
    upstreamUrl = new URL('/api/internal/compose/jobs', runtime.jsonBaseUrl);
    for (const [key, value] of Object.entries(parsed.data)) upstreamUrl.searchParams.set(key, String(value));
  } else {
    const body = await readComposeBody(req, res, correlationId, ComposeSubmitJobRequestSchema);
    if (body === null) return;
    idempotencyKey = firstHeaderValue(req.headers['idempotency-key']);
    if (!idempotencyKey || !/^[!-~]{8,200}$/.test(idempotencyKey)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'a valid Idempotency-Key is required for Compose submission', correlationId);
      return;
    }
    jsonBody = JSON.stringify(body);
    upstreamUrl = new URL('/api/internal/compose/jobs', runtime.jsonBaseUrl);
  }

  const response = await callUpstream(runtime, upstreamUrl, {
    method: method as 'GET' | 'POST', credential, correlationId,
    ...(jsonBody !== undefined ? { jsonBody } : {}),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    sessionProof,
  });
  await relayUpstream(res, response, correlationId);
}

async function readComposeBody<T>(
  req: IncomingMessage,
  res: ServerResponse,
  correlationId: string,
  schema: { safeParse(input: unknown): { success: true; data: T } | { success: false } },
): Promise<T | null> {
  const raw = await readBoundedBody(req);
  if (raw === null) {
    writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId);
    return null;
  }
  let input: unknown;
  try { input = raw.length === 0 ? null : JSON.parse(raw); } catch {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId);
    return null;
  }
  const parsed = schema.safeParse(input);
  if (!parsed.success) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'Compose request body is invalid', correlationId);
    return null;
  }
  return parsed.data;
}
