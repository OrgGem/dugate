import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  GlobalSettingsPublishRequestSchema,
  GlobalSettingsRollbackRequestSchema,
  PlatformRetentionDraftRequestSchema,
  TenantAiDraftRequestSchema,
  TenantAiTestRequestSchema,
  TenantPromptDraftRequestSchema,
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

export type GlobalSettingsRoute = { kind: 'tenant-read' } | { kind: 'retention-read' } |
  { kind: 'tenant-mutation'; tenantId: string; stream: 'ai' | 'prompts'; action: 'draft' | 'test' | 'publish' | 'rollback' } |
  { kind: 'retention-mutation'; action: 'draft' | 'publish' | 'rollback' } | { kind: 'invalid' };

export function matchGlobalSettingsRoute(relative: string): GlobalSettingsRoute | null {
  if (relative === '/global-settings') return { kind: 'tenant-read' };
  if (relative === '/global-settings/retention') return { kind: 'retention-read' };
  const tenant = /^\/global-settings\/tenants\/([^/]+)\/(ai|prompts)\/(draft|test|publish|rollback)$/.exec(relative);
  if (tenant) {
    const tenantId = decodePathSegment(tenant[1] ?? '');
    if (!tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) return { kind: 'invalid' };
    return { kind: 'tenant-mutation', tenantId, stream: tenant[2] as 'ai' | 'prompts', action: tenant[3] as 'draft' | 'test' | 'publish' | 'rollback' };
  }
  const retention = /^\/global-settings\/retention\/(draft|publish|rollback)$/.exec(relative);
  if (retention) return { kind: 'retention-mutation', action: retention[1] as 'draft' | 'publish' | 'rollback' };
  return null;
}

function activeSessionProof(request: AdminShellRequest, ctx: Awaited<ReturnType<typeof resolveBffContext>>): { cookie: string; csrfToken: string } | undefined {
  if (!ctx) return undefined;
  if (ctx.plane === 'oidc') {
    const id = request.cookies['du_session'];
    return typeof id === 'string' && /^[A-Za-z0-9_-]{43}$/.test(id)
      ? { cookie: `du_session=${encodeURIComponent(id)}`, csrfToken: ctx.csrfToken }
      : undefined;
  }
  const cookie = request.cookies['du_admin'];
  return typeof cookie === 'string' && cookie.length > 0 && cookie.length <= 4096
    ? { cookie: `du_admin=${encodeURIComponent(cookie)}`, csrfToken: ctx.csrfToken }
    : undefined;
}

const TENANT_QUERY = new Set(['tenantId']);

export async function handleGlobalSettingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: GlobalSettingsRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  if (route.kind === 'invalid') { writeProblem(res, 404, 'NOT_FOUND', 'global settings route is invalid', correlationId); return; }
  const read = route.kind === 'tenant-read' || route.kind === 'retention-read';
  if ((read && method !== 'GET') || (!read && method !== 'POST')) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'global settings reads require GET and mutations require POST', correlationId); return;
  }
  const ctx = await resolveBffContext(config, request);
  if (!ctx) { writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId); return; }
  if (ctx.role === 'viewer' || ctx.principal.kind === 'unscoped'
      || (ctx.plane === 'oidc' && ctx.issuer === 'du-local' && ctx.role === 'operator')) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'global settings require an Admin or tenant operator session', correlationId); return;
  }
  if (route.kind === 'tenant-mutation' && ctx.principal.kind === 'tenant_operator' && ctx.principal.tenantId !== route.tenantId) {
    writeProblem(res, 404, 'NOT_FOUND', 'not found', correlationId); return;
  }
  if ((route.kind === 'retention-read' || route.kind === 'retention-mutation') && ctx.principal.kind !== 'platform') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'platform retention settings require platform Admin access', correlationId); return;
  }

  let upstream: URL;
  let body: string | undefined;
  let idempotencyKey: string | undefined;
  if (route.kind === 'tenant-read') {
    const raw: Record<string, string> = {};
    for (const [key, value] of query.entries()) {
      if (!TENANT_QUERY.has(key) || Object.hasOwn(raw, key)) { writeProblem(res, 422, 'INVALID_SCHEMA', 'global settings query contains an unsupported or repeated parameter', correlationId); return; }
      raw[key] = value;
    }
    const sessionTenant = ctx.principal.kind === 'tenant_operator' ? ctx.principal.tenantId : null;
    const tenantId = raw.tenantId ?? sessionTenant;
    if (!tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'a tenant scope is required', correlationId); return;
    }
    if (ctx.principal.kind === 'tenant_operator' && ctx.principal.tenantId !== tenantId) { writeProblem(res, 404, 'NOT_FOUND', 'not found', correlationId); return; }
    upstream = new URL('/api/internal/global-settings', runtime.jsonBaseUrl ?? 'http://invalid.local');
    upstream.searchParams.set('tenantId', tenantId);
  } else if (route.kind === 'retention-read') {
    if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'retention read does not accept query parameters', correlationId); return; }
    upstream = new URL('/api/internal/global-settings/retention', runtime.jsonBaseUrl ?? 'http://invalid.local');
  } else {
    if (query.size > 0) { writeProblem(res, 422, 'INVALID_SCHEMA', 'global settings mutations do not accept query parameters', correlationId); return; }
    if (!ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) { writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId); return; }
    const raw = await readBoundedBody(req);
    if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return; }
    let value: unknown;
    try { value = raw.length === 0 ? null : JSON.parse(raw); } catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return; }
    const schema = route.kind === 'tenant-mutation'
      ? route.action === 'draft' ? route.stream === 'ai' ? TenantAiDraftRequestSchema : TenantPromptDraftRequestSchema
        : route.action === 'test' ? TenantAiTestRequestSchema
          : route.action === 'publish' ? GlobalSettingsPublishRequestSchema : GlobalSettingsRollbackRequestSchema
      : route.action === 'draft' ? PlatformRetentionDraftRequestSchema
        : route.action === 'publish' ? GlobalSettingsPublishRequestSchema : GlobalSettingsRollbackRequestSchema;
    const parsed = schema.safeParse(value);
    if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'global settings request body is invalid', correlationId); return; }
    if ('idempotencyKey' in parsed.data) idempotencyKey = parsed.data.idempotencyKey;
    body = JSON.stringify(parsed.data);
    upstream = route.kind === 'tenant-mutation'
      ? new URL(`/api/internal/global-settings/tenants/${encodeURIComponent(route.tenantId)}/${route.stream}/${route.action}`, runtime.jsonBaseUrl ?? 'http://invalid.local')
      : new URL(`/api/internal/global-settings/retention/${route.action}`, runtime.jsonBaseUrl ?? 'http://invalid.local');
  }

  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) { writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the Admin API is not configured', correlationId); return; }
  const credential = credentialFor(ctx.principal, runtime);
  if (!credential) { writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no Admin credential is configured for this session scope', correlationId); return; }
  const proof = activeSessionProof(request, ctx);
  if (!read && !proof) { writeProblem(res, 401, 'UNAUTHENTICATED', 'the active Admin session proof is unavailable', correlationId); return; }
  await relayUpstream(res, await callUpstream(runtime, upstream, {
    method: method as 'GET' | 'POST', credential, correlationId,
    ...(body !== undefined ? { jsonBody: body } : {}),
    ...(idempotencyKey ? { idempotencyKey } : {}),
    ...(proof ? { sessionProof: proof } : {}),
  }), correlationId);
}
