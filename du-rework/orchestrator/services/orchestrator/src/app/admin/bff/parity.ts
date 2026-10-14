/** BFF routes for tenant-fenced API-key and Connector parity controls. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SESSION_COOKIE_NAME } from '../../../modules/auth/session-store';
import {
  ApiKeyIssueSchema,
  ApiKeyNoteSchema,
  ApiKeyRotateSchema,
  ConnectorDraftUpsertSchema,
  ProviderTestRequestSchema,
  isTenantUuid,
} from '@du/contracts';
import { z } from 'zod';
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
  type UpstreamCallOptions,
} from './upstream';

export type ParityRoute =
  | { kind: 'api-key-list' | 'api-key-issue' }
  | { kind: 'api-key-note' | 'api-key-rotate' | 'api-key-revoke'; keyId: string }
  | { kind: 'connector-revision'; connectorId: string; revision: string }
  | { kind: 'connector-draft' | 'connector-rollback'; connectorId: string }
  | { kind: 'connector-activate'; connectorId: string; revision: string }
  | { kind: 'tenant-connector-list' }
  | { kind: 'typed-connector-catalog' }
  | { kind: 'tenant-connector-chain'; connectorId: string }
  | { kind: 'provider-test' }
  | { kind: 'invalid' };

const RevokeBodySchema = z.object({ expectedVersion: z.number().int().min(1) }).strict();
const TenantUuidSchema = z.string().refine(isTenantUuid, 'tenantId must use canonical UUID syntax');
const RollbackBodySchema = z.object({ tenantId: TenantUuidSchema, sourceRevision: z.number().int().min(1), expectedHeadRevision: z.number().int().min(0), idempotencyKey: z.string().min(8).max(200) }).strict();
const ActivateBodySchema = z.object({ tenantId: TenantUuidSchema, expectedCurrentRevision: z.number().int().min(0) }).strict();

export function matchParityRoute(relative: string): ParityRoute | null {
  if (relative === '/parity/api-keys') return { kind: 'api-key-list' };
  if (relative === '/parity/api-keys/issue') return { kind: 'api-key-issue' };
  const key = /^\/parity\/api-keys\/([^/]+)(?:\/(rotate|revoke))?$/.exec(relative);
  if (key) {
    const keyId = decodePathSegment(key[1] ?? '');
    if (!keyId || !/^[0-9a-f-]{36}$/i.test(keyId)) return { kind: 'invalid' };
    const action = key[2] ?? null;
    return { kind: action === 'rotate' ? 'api-key-rotate' : action === 'revoke' ? 'api-key-revoke' : 'api-key-note', keyId };
  }
  const revision = /^\/parity\/connectors\/([^/]+)\/revisions\/([^/]+)$/.exec(relative);
  if (revision) {
    const connectorId = connectorSegment(revision[1] ?? '');
    const number = revision[2] ?? '';
    return connectorId && /^\d{1,9}$/.test(number) && Number(number) >= 1
      ? { kind: 'connector-revision', connectorId, revision: number }
      : { kind: 'invalid' };
  }
  const activate = /^\/parity\/connectors\/([^/]+)\/revisions\/([^/]+)\/activate$/.exec(relative);
  if (activate) {
    const connectorId = connectorSegment(activate[1] ?? '');
    const revisionNumber = activate[2] ?? '';
    return connectorId && /^\d{1,9}$/.test(revisionNumber) && Number(revisionNumber) >= 1
      ? { kind: 'connector-activate', connectorId, revision: revisionNumber }
      : { kind: 'invalid' };
  }
  const connectorAction = /^\/parity\/connectors\/([^/]+)\/(draft|rollback\/draft)$/.exec(relative);
  if (connectorAction) {
    const connectorId = connectorSegment(connectorAction[1] ?? '');
    if (!connectorId) return { kind: 'invalid' };
    return connectorAction[2] === 'draft'
      ? { kind: 'connector-draft', connectorId }
      : { kind: 'connector-rollback', connectorId };
  }
  if (relative === '/parity/provider-tests') return { kind: 'provider-test' };
  if (relative === '/parity/tenant-connectors') return { kind: 'tenant-connector-list' };
  if (relative === '/parity/typed-connector-recipes') return { kind: 'typed-connector-catalog' };
  const chain = /^\/parity\/connectors\/([^/]+)\/chain$/.exec(relative);
  if (chain) {
    const connectorId = connectorSegment(chain[1] ?? '');
    return connectorId ? { kind: 'tenant-connector-chain', connectorId } : { kind: 'invalid' };
  }
  return null;
}

export async function handleParityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: ParityRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') { writeProblem(res, 404, 'NOT_FOUND', 'parity path is invalid', correlationId); return; }
  const ctx = await resolveBffContext(config, request);
  if (!ctx) { writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId); return; }
  if (ctx.principal.kind === 'unscoped' || ctx.role === 'viewer') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no administrative scope', correlationId); return;
  }
  const localUserProviderTest = route.kind === 'provider-test' && ctx.plane === 'oidc' && ctx.issuer === 'du-local' && ctx.role === 'operator';
  if (ctx.plane === 'oidc' && ctx.issuer === 'du-local' && ctx.role === 'operator' && !localUserProviderTest) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'assigned local users cannot administer API keys or Connectors', correlationId); return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const read = route.kind === 'api-key-list' || route.kind === 'connector-revision'
    || route.kind === 'tenant-connector-list' || route.kind === 'typed-connector-catalog'
    || route.kind === 'tenant-connector-chain';
  if ((read && method !== 'GET') || (!read && method !== 'POST' && method !== 'PUT' && method !== 'PATCH')) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'parity read routes require GET and mutations require POST, PUT or PATCH', correlationId); return;
  }
  if (!read && !ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId); return;
  }
  if (route.kind !== 'api-key-list' && route.kind !== 'connector-revision'
      && route.kind !== 'tenant-connector-list' && route.kind !== 'typed-connector-catalog'
      && route.kind !== 'tenant-connector-chain' && !localUserProviderTest && (ctx.role !== 'admin' || ctx.principal.kind !== 'platform')) {
    writeProblem(res, 403, 'ADMIN_CREDENTIAL_REQUIRED', 'API-key and Connector changes require platform Admin access', correlationId); return;
  }

  const sessionProof = activeSessionProof(request, ctx);
  if (!sessionProof) { writeProblem(res, 401, 'UNAUTHENTICATED', 'the active Admin session proof is unavailable', correlationId); return; }
  const credential = localUserProviderTest ? null : credentialFor(ctx.principal, runtime);
  if ((!credential && !sessionProof) || typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the parity API is not configured', correlationId); return;
  }

  for (const key of query.keys()) {
    const allowedForTenantCatalog = (route.kind === 'tenant-connector-list' || route.kind === 'typed-connector-catalog')
      && ['q', 'cursor', 'limit'].includes(key);
    if (key !== 'tenantId' && !(route.kind === 'api-key-list' && ['query', 'cursor', 'limit', 'status'].includes(key)) && !allowedForTenantCatalog) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'parity query contains an unsupported parameter', correlationId); return;
    }
  }
  if (route.kind === 'tenant-connector-list' || route.kind === 'typed-connector-catalog') {
    const allowed = new Set(['tenantId', 'q', 'cursor', 'limit']);
    const seen = new Set<string>();
    for (const [name, value] of query.entries()) {
      if (!allowed.has(name) || seen.has(name)) { writeProblem(res, 422, 'INVALID_SCHEMA', 'tenant Connector query contains an unsupported or repeated parameter', correlationId); return; }
      seen.add(name);
      if ((name === 'q' && (value.trim().length < 1 || value.length > 128 || /[\u0000-\u001f\u007f]/.test(value)))
        || (name === 'cursor' && (value.length < 1 || value.length > 2048))
        || (name === 'limit' && (!/^[1-9][0-9]{0,2}$/.test(value) || Number(value) > 100))) {
        writeProblem(res, 422, 'INVALID_SCHEMA', 'tenant Connector query exceeds its bounds', correlationId); return;
      }
    }
  }
  if (route.kind === 'tenant-connector-chain') {
    if (query.has('connectorId')) { writeProblem(res, 422, 'INVALID_SCHEMA', 'tenant Connector chain identifier must be in the path', correlationId); return; }
  }
  const body = read ? undefined : await parseBody(req, res, correlationId);
  if (!read && body === null) return;
  const bodyTenantId = typeof body === 'object' && body !== null && !Array.isArray(body)
    && typeof (body as Record<string, unknown>).tenantId === 'string'
    ? (body as Record<string, unknown>).tenantId as string
    : null;
  const tenantId = scopedTenant(ctx, query.get('tenantId') ?? bodyTenantId,
    route.kind === 'typed-connector-catalog' || route.kind === 'connector-revision');
  if (!tenantId) { writeProblem(res, 404, 'NOT_FOUND', 'not found', correlationId); return; }
  const normalized = body === undefined ? undefined : normalizeBody(route, body as unknown, tenantId, correlationId, res);
  if (!read && normalized === null) return;
  const path = routePath(route, tenantId);
  const upstreamCall: UpstreamCallOptions = {
    method: method as UpstreamCallOptions['method'],
    credential: credential ?? '',
    correlationId,
    ...(normalized === undefined ? {} : { jsonBody: JSON.stringify(normalized) }),
    ...(normalized && typeof normalized === 'object' && 'idempotencyKey' in normalized && typeof (normalized as { idempotencyKey?: unknown }).idempotencyKey === 'string'
      ? { idempotencyKey: (normalized as { idempotencyKey: string }).idempotencyKey }
      : firstHeaderValue(req.headers['idempotency-key']) ? { idempotencyKey: firstHeaderValue(req.headers['idempotency-key'])! } : {}),
    sessionProof,
  };
  const url = new URL(path, runtime.jsonBaseUrl);
  if (read && route.kind === 'api-key-list') {
    for (const [name, value] of query.entries()) {
      if (!['tenantId', 'query', 'cursor', 'limit', 'status'].includes(name)) { writeProblem(res, 422, 'INVALID_SCHEMA', 'API-key query contains an unsupported parameter', correlationId); return; }
      url.searchParams.set(name, value);
    }
  }
  if (read && (route.kind === 'tenant-connector-list' || route.kind === 'typed-connector-catalog')) {
    for (const name of ['q', 'cursor', 'limit']) {
      const value = query.get(name);
      if (value !== null) url.searchParams.set(name, value);
    }
  }
  const response = await callUpstream(runtime, url, upstreamCall);
  await relayUpstream(res, response, correlationId);
}

function scopedTenant(
  ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>,
  requested: string | null,
  canonicalUuid = false,
): string | null {
  if (ctx.principal.kind === 'tenant_operator') {
    if (!isTenantUuid(ctx.principal.tenantId)) return null;
    const principalTenant = canonicalUuid ? ctx.principal.tenantId.toLowerCase() : ctx.principal.tenantId;
    const requestedTenant = canonicalUuid && isTenantUuid(requested) ? requested.toLowerCase() : requested;
    if (requestedTenant && requestedTenant !== principalTenant) return null;
    return principalTenant;
  }
  if (!isTenantUuid(requested)) {
    return null;
  }
  return canonicalUuid ? requested.toLowerCase() : requested;
}

function activeSessionProof(request: AdminShellRequest, ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): UpstreamCallOptions['sessionProof'] {
  const sessionId = request.cookies[SESSION_COOKIE_NAME];
  if (typeof sessionId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(sessionId)) return { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`, csrfToken: ctx.csrfToken };
  const legacy = request.cookies['du_admin'];
  if (typeof legacy === 'string' && legacy.length > 0 && legacy.length <= 4096) return { cookie: `du_admin=${encodeURIComponent(legacy)}`, csrfToken: ctx.csrfToken };
  return undefined;
}

async function parseBody(req: IncomingMessage, res: ServerResponse, correlationId: string): Promise<unknown | null> {
  const raw = await readBoundedBody(req);
  if (raw === null) { writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId); return null; }
  try { return raw.trim() === '' ? null : JSON.parse(raw) as unknown; }
  catch { writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId); return null; }
}

function normalizeBody(route: ParityRoute, value: unknown, tenantId: string, correlationId: string, res: ServerResponse): unknown | null {
  const schema = route.kind === 'api-key-issue' ? ApiKeyIssueSchema
    : route.kind === 'api-key-note' ? ApiKeyNoteSchema
      : route.kind === 'api-key-rotate' ? ApiKeyRotateSchema
        : route.kind === 'connector-draft' ? ConnectorDraftUpsertSchema
          : route.kind === 'provider-test' ? ProviderTestRequestSchema
            : route.kind === 'api-key-revoke' ? RevokeBodySchema
              : route.kind === 'connector-rollback' ? RollbackBodySchema
                : route.kind === 'connector-activate' ? ActivateBodySchema
                  : null;
  if (!schema) { writeProblem(res, 422, 'INVALID_SCHEMA', 'parity mutation body is not supported', correlationId); return null; }
  const parsed = schema.safeParse(value);
  if (!parsed.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'parity mutation request is invalid or exceeds its bounds', correlationId); return null; }
  const data = parsed.data as Record<string, unknown>;
  if ('tenantId' in data && data.tenantId !== tenantId) { writeProblem(res, 404, 'NOT_FOUND', 'not found', correlationId); return null; }
  if (route.kind === 'connector-draft' || route.kind === 'connector-rollback' || route.kind === 'connector-activate' || route.kind === 'provider-test') return { ...data, tenantId };
  return data;
}

function routePath(route: ParityRoute, tenantId: string): string {
  switch (route.kind) {
    case 'api-key-list': return `/api/internal/parity/api-keys?tenantId=${encodeURIComponent(tenantId)}`;
    case 'api-key-issue': return `/api/internal/parity/api-keys?tenantId=${encodeURIComponent(tenantId)}`;
    case 'api-key-note': return `/api/internal/parity/api-keys/${encodeURIComponent(route.keyId)}?tenantId=${encodeURIComponent(tenantId)}`;
    case 'api-key-rotate': return `/api/internal/parity/api-keys/${encodeURIComponent(route.keyId)}/rotate?tenantId=${encodeURIComponent(tenantId)}`;
    case 'api-key-revoke': return `/api/internal/parity/api-keys/${encodeURIComponent(route.keyId)}/revoke?tenantId=${encodeURIComponent(tenantId)}`;
    case 'connector-revision': return `/api/internal/parity/connectors/${encodeURIComponent(route.connectorId)}/revisions/${route.revision}?tenantId=${encodeURIComponent(tenantId)}`;
    case 'connector-draft': return `/api/internal/parity/connectors/${encodeURIComponent(route.connectorId)}/draft`;
    case 'connector-activate': return `/api/internal/parity/connectors/${encodeURIComponent(route.connectorId)}/revisions/${route.revision}/activate`;
    case 'connector-rollback': return `/api/internal/parity/connectors/${encodeURIComponent(route.connectorId)}/rollback/draft`;
    case 'tenant-connector-list': return `/api/internal/parity/tenant-connectors?tenantId=${encodeURIComponent(tenantId)}`;
    case 'typed-connector-catalog': return `/api/internal/parity/typed-connector-recipes?tenantId=${encodeURIComponent(tenantId)}`;
    case 'tenant-connector-chain': return `/api/internal/parity/connectors/${encodeURIComponent(route.connectorId)}/chain?tenantId=${encodeURIComponent(tenantId)}`;
    case 'provider-test': return '/api/internal/parity/provider-tests';
    case 'invalid': throw new Error('invalid parity route');
  }
}

function connectorSegment(value: string): string | null {
  const decoded = decodePathSegment(value);
  return decoded && /^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(decoded) && !decoded.includes('..') ? decoded : null;
}

