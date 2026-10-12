/**
 * BFF Identity routes (IDENTITY-BFF-ROUTES / task_42bb7c8166a1).
 *
 *   GET    /admin/api/identity            → user list + capabilities + auth mode
 *   POST   /admin/api/identity/users      → create a user
 *   PATCH  /admin/api/identity/users/:id  → update role/enabled (CAS)
 *
 * Fence mirrors bff/security.ts:
 *  - session first (anonymous → 401, unscoped → 403);
 *  - mutations need the session CSRF proof BEFORE the role check;
 *  - every response is no-store.
 *
 * TENANT IS NOT A CALLER FIELD: no body or query parameter can widen the
 * scope. The BFF derives it from the resolved session/principal and forwards
 * only what the platform needs; a `tenantId` in the body is never forwarded.
 *
 * ROLE POLICY IS NOT INVENTED HERE: the requested role is forwarded and the
 * platform decides (IDENTITY-ROLE-POLICY is another lane's packet). This route
 * only validates that the value is in the closed enum, so a caller cannot smuggle
 * an arbitrary string through as a role.
 *
 * CAS: `expectedVersion` is mandatory on PATCH. A stale version is the
 * platform's call — this route forwards it and relays the 409 honestly rather
 * than re-implementing the comparison or overwriting blindly.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  IDENTITY_ROLE_VALUES,
  IdentityAssignmentReplaceSchema,
  IdentityPasswordResetSchema,
} from '@du/contracts';
import { SESSION_COOKIE_NAME } from '../../../modules/auth/session-store';
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

export type IdentityRoute =
  | { kind: 'snapshot' }
  | { kind: 'users' }
  | { kind: 'user'; userId: string }
  | { kind: 'password'; userId: string }
  | { kind: 'assignments'; userId: string }
  | { kind: 'assignable-users' }
  | { kind: 'platform-assignable-users' }
  | { kind: 'invalid' };

export function matchIdentityRoute(relative: string): IdentityRoute | null {
  if (relative === '/identity') return { kind: 'snapshot' };
  if (relative === '/identity/users') return { kind: 'users' };
  if (relative === '/identity/assignable-users') return { kind: 'assignable-users' };
  if (relative === '/identity/platform-assignable-users') return { kind: 'platform-assignable-users' };
  const child = /^\/identity\/users\/([^/]+)\/(password|assignments)$/.exec(relative);
  if (child) {
    const userId = decodePathSegment(child[1] ?? '');
    if (userId === null || !/^[0-9a-f-]{36}$/i.test(userId)) return { kind: 'invalid' };
    return child[2] === 'password' ? { kind: 'password', userId } : { kind: 'assignments', userId };
  }
  const m = /^\/identity\/users\/([^/]+)$/.exec(relative);
  if (!m) return null;
  const userId = decodePathSegment(m[1] ?? '');
  if (userId === null) return { kind: 'invalid' };
  return { kind: 'user', userId };
}

const ROLE_SET = new Set<string>(IDENTITY_ROLE_VALUES);
const MAX_USERNAME = 128;
const MAX_PASSWORD = 1024;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export async function handleIdentityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: IdentityRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no Identity route matches this request', correlationId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();

  // Method is bound per route so a wrong verb is a clean 405, not a silent
  // fallthrough into another route's handler.
  const allowed = route.kind === 'snapshot' || route.kind === 'assignable-users' || route.kind === 'platform-assignable-users' ? ['GET']
    : route.kind === 'users' ? ['GET', 'POST']
      : route.kind === 'password' ? ['POST']
        : route.kind === 'assignments' ? ['GET', 'PUT'] : ['GET', 'PATCH'];
  if (!allowed.includes(method)) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', `method ${method} is not allowed here`, correlationId);
    return;
  }

  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  const principal = ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'this session has no admin principal', correlationId);
    return;
  }

  if (route.kind === 'platform-assignable-users' && (principal.kind !== 'platform' || ctx.role !== 'admin')) {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'platform owner lookup requires platform Admin access', correlationId);
    return;
  }

  for (const key of query.keys()) {
    if (!['tenantId', 'query', 'cursor', 'limit'].includes(key)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'Identity query contains an unsupported parameter', correlationId);
      return;
    }
  }
  const platformOwnerLookup = route.kind === 'platform-assignable-users';
  if (platformOwnerLookup && query.has('tenantId')) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'platform owner lookup does not accept a tenant override', correlationId);
    return;
  }
  const requestedTenantId = query.get('tenantId');
  const tenantId = principal.kind === 'tenant_operator'
    ? (requestedTenantId && requestedTenantId !== principal.tenantId ? null : principal.tenantId)
    : requestedTenantId;
  if (!platformOwnerLookup && (!tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId))) {
    const foreignTenant = requestedTenantId !== null && principal.kind === 'tenant_operator';
    writeProblem(res, foreignTenant ? 404 : 422, foreignTenant ? 'NOT_FOUND' : 'INVALID_SCHEMA',
      foreignTenant ? 'not found' : 'tenantId is required and must be a UUID', correlationId);
    return;
  }

  const credential = credentialFor(principal, runtime);
  const sessionProof = activeSessionProof(request, ctx);
  if (credential === null && !sessionProof) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
    return;
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  // ---- read ---------------------------------------------------------------
  if (method === 'GET') {
    const path = route.kind === 'platform-assignable-users' ? '/api/internal/parity/identity/platform-assignable-users'
      : route.kind === 'snapshot' ? '/api/internal/parity/identity'
      : route.kind === 'user' ? `/api/internal/parity/identity/users/${encodeURIComponent(route.userId)}`
        : route.kind === 'assignments' ? `/api/internal/parity/identity/users/${encodeURIComponent(route.userId)}/assignments`
          : route.kind === 'assignable-users' ? '/api/internal/parity/identity/assignable-users'
            : '/api/internal/parity/identity/users';
    const url = new URL(path, runtime.jsonBaseUrl);
    if (tenantId) url.searchParams.set('tenantId', tenantId);
    for (const key of ['query', 'cursor', 'limit']) {
      const value = query.get(key);
      if (value !== null) url.searchParams.set(key, value);
    }
    const response = await callUpstream(runtime, url, { method: 'GET', credential: credential ?? '', correlationId, ...(sessionProof ? { sessionProof } : {}) });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (!tenantId) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'tenantId is required for Identity mutation', correlationId);
    return;
  }

  // ---- mutations ----------------------------------------------------------
  // CSRF BEFORE role: an unauthenticated cross-site caller learns nothing.
  const provided = firstHeaderValue(req.headers['x-csrf-token']);
  if (!ctx.verifyCsrf(provided)) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
    return;
  }
  if (ctx.role !== 'admin' || principal.kind !== 'platform') {
    writeProblem(
      res,
      403,
      'ADMIN_CREDENTIAL_REQUIRED',
      'identity changes require a platform admin session',
      correlationId,
    );
    return;
  }

  const raw = await readBoundedBody(req);
  if (raw === null) {
    writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId);
    return;
  }
  let parsed: unknown = null;
  try {
    parsed = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be a JSON object', correlationId);
    return;
  }
  const body = parsed as Record<string, unknown>;
  const idempotencyKey = clampKey(firstHeaderValue(req.headers['idempotency-key']));

  if (route.kind === 'password') {
    if (ctx.role !== 'admin' || principal.kind !== 'platform') {
      writeProblem(res, 403, 'ADMIN_CREDENTIAL_REQUIRED', 'password reset requires platform Admin access', correlationId);
      return;
    }
    const reset = IdentityPasswordResetSchema.safeParse(body);
    if (!reset.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'password reset request is invalid', correlationId); return; }
    const url = new URL(`/api/internal/parity/identity/users/${encodeURIComponent(route.userId)}/password?tenantId=${encodeURIComponent(tenantId)}`, runtime.jsonBaseUrl);
    const response = await callUpstream(runtime, url, { method: 'POST', credential: credential ?? '', correlationId,
      jsonBody: JSON.stringify(reset.data), idempotencyKey, ...(sessionProof ? { sessionProof } : {}) });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (route.kind === 'assignments' && method === 'PUT') {
    if (ctx.role !== 'admin' || principal.kind !== 'platform') {
      writeProblem(res, 403, 'ADMIN_CREDENTIAL_REQUIRED', 'Identity assignment changes require platform Admin access', correlationId);
      return;
    }
    const replacement = IdentityAssignmentReplaceSchema.safeParse(body);
    if (!replacement.success) { writeProblem(res, 422, 'INVALID_SCHEMA', 'Identity assignment request is invalid', correlationId); return; }
    const url = new URL(`/api/internal/parity/identity/users/${encodeURIComponent(route.userId)}/assignments?tenantId=${encodeURIComponent(tenantId)}`, runtime.jsonBaseUrl);
    const response = await callUpstream(runtime, url, { method: 'PUT', credential: credential ?? '', correlationId,
      jsonBody: JSON.stringify(replacement.data), idempotencyKey, ...(sessionProof ? { sessionProof } : {}) });
    await relayUpstream(res, response, correlationId);
    return;
  }

  if (method === 'POST') {
    const username = typeof body.username === 'string' ? body.username : '';
    const password = typeof body.password === 'string' ? body.password : '';
    const role = typeof body.role === 'string' ? body.role : '';
    if (username.length === 0 || username.length > MAX_USERNAME) {
      writeProblem(res, 422, 'INVALID_SCHEMA', `username is required (1..${MAX_USERNAME} characters)`, correlationId);
      return;
    }
    if (password.length === 0 || password.length > MAX_PASSWORD) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'password is required', correlationId);
      return;
    }
    if (!ROLE_SET.has(role)) {
      writeProblem(
        res,
        422,
        'INVALID_SCHEMA',
        `role must be one of ${IDENTITY_ROLE_VALUES.join(', ')}`,
        correlationId,
      );
      return;
    }
    const url = new URL(`/api/internal/parity/identity/users?tenantId=${encodeURIComponent(tenantId)}`, runtime.jsonBaseUrl);
    const response = await callUpstream(runtime, url, {
      method: 'POST',
      credential: credential ?? '',
      correlationId,
      jsonBody: JSON.stringify({ username, password, role }),
      idempotencyKey,
      ...(sessionProof ? { sessionProof } : {}),
    });
    await relayUpstream(res, response, correlationId);
    return;
  }

  // PATCH — CAS is mandatory; a missing or malformed version is a validation
  // error, not a permission to write blind.
  const role = typeof body.role === 'string' ? body.role : '';
  const enabled = body.enabled;
  const expectedVersion = body.expectedVersion;
  if (!ROLE_SET.has(role)) {
    writeProblem(
      res,
      422,
      'INVALID_SCHEMA',
      `role must be one of ${IDENTITY_ROLE_VALUES.join(', ')}`,
      correlationId,
    );
    return;
  }
  if (typeof enabled !== 'boolean') {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'enabled must be a boolean', correlationId);
    return;
  }
  if (typeof expectedVersion !== 'number' || !Number.isInteger(expectedVersion) || expectedVersion < 0) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'expectedVersion must be a non-negative integer', correlationId);
    return;
  }
  if (route.kind !== 'user') {
    // Defensive: only the `user` route can be a PATCH (method gate above).
    writeProblem(res, 404, 'NOT_FOUND', 'no Identity route matches this request', correlationId);
    return;
  }
  const url = new URL(`/api/internal/parity/identity/users/${encodeURIComponent(route.userId)}?tenantId=${encodeURIComponent(tenantId)}`, runtime.jsonBaseUrl);
  const response = await callUpstream(runtime, url, {
    method: 'PUT',
    credential: credential ?? '',
    correlationId,
    jsonBody: JSON.stringify({ role, enabled, expectedVersion }),
    idempotencyKey,
    ...(sessionProof ? { sessionProof } : {}),
  });
  await relayUpstream(res, response, correlationId);
}

function clampKey(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH) : undefined;
}

function activeSessionProof(
  request: AdminShellRequest,
  ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>,
): { cookie: string; csrfToken: string } | undefined {
  const sessionId = request.cookies[SESSION_COOKIE_NAME];
  if (typeof sessionId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(sessionId)) {
    return { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`, csrfToken: ctx.csrfToken };
  }
  const legacy = request.cookies['du_admin'];
  if (typeof legacy === 'string' && legacy.length > 0 && legacy.length <= 4096) {
    return { cookie: `du_admin=${encodeURIComponent(legacy)}`, csrfToken: ctx.csrfToken };
  }
  return undefined;
}
