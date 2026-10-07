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

export type IdentityRoute =
  | { kind: 'snapshot' }
  | { kind: 'users' }
  | { kind: 'user'; userId: string }
  | { kind: 'invalid' };

export function matchIdentityRoute(relative: string): IdentityRoute | null {
  if (relative === '/identity') return { kind: 'snapshot' };
  if (relative === '/identity/users') return { kind: 'users' };
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
  _query: URLSearchParams,
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
  const allowed =
    route.kind === 'snapshot' ? ['GET'] : route.kind === 'users' ? ['GET', 'POST'] : ['GET', 'PATCH'];
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

  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
    return;
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  // ---- read ---------------------------------------------------------------
  if (method === 'GET') {
    const url =
      route.kind === 'snapshot'
        ? new URL('/api/v1/admin/identity', runtime.jsonBaseUrl)
        : route.kind === 'user'
          ? new URL(`/api/v1/admin/identity/users/${encodeURIComponent(route.userId)}`, runtime.jsonBaseUrl)
          : new URL('/api/v1/admin/identity/users', runtime.jsonBaseUrl);
    const response = await callUpstream(runtime, url, { method: 'GET', credential, correlationId });
    await relayUpstream(res, response, correlationId);
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
    const url = new URL('/api/v1/admin/identity/users', runtime.jsonBaseUrl);
    const response = await callUpstream(runtime, url, {
      method: 'POST',
      credential,
      correlationId,
      jsonBody: JSON.stringify({ username, password, role }),
      idempotencyKey,
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
  const url = new URL(`/api/v1/admin/identity/users/${encodeURIComponent(route.userId)}`, runtime.jsonBaseUrl);
  const response = await callUpstream(runtime, url, {
    method: 'PUT',
    credential,
    correlationId,
    jsonBody: JSON.stringify({ role, enabled, expectedVersion }),
    idempotencyKey,
  });
  await relayUpstream(res, response, correlationId);
}

function clampKey(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH) : undefined;
}