/**
 * BFF Secret catalog routes (SC-03) — `/admin/api/secrets*`.
 *
 *   GET  /admin/api/secrets                 → tenant-fenced catalog list
 *   POST /admin/api/secrets                 → create/link (CSRF + admin)
 *   POST /admin/api/secrets/:id/rotate      → write-only rotation (CAS)
 *   POST /admin/api/secrets/:id/disable     → disable with reason (CAS)
 *   POST /admin/api/secrets/:id/test        → safe availability probe
 *
 * Security fence mirrors the other BFF slices: the tenant comes from the
 * session (a tenant operator can never widen), mutations require the session
 * CSRF proof and ride the platform credential only for platform sessions, and
 * every response is no-store via the shared writer.
 *
 * The wire bodies are validated against the frozen `@du/contracts`
 * secret-catalog schemas BEFORE any upstream call. No route here ever accepts
 * or returns a plaintext value: create/rotate carry a write-only literal to
 * the upstream writer, and reads project metadata only. Zod issues are
 * projected to `{pointer, message}` — never the offending value.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  SecretCatalogCreateSchema,
  SecretCatalogDisableSchema,
  SecretCatalogRotateSchema,
} from '@du/contracts';
import { isHttpError } from '../../../http/errors';
import { authorizeAuditTenantRead } from '../../../modules/admin-actions/rbac';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import { problemBody } from './envelope';
import {
  boundedMessage,
  callUpstream,
  credentialFor,
  decodePathSegment,
  firstHeaderValue,
  rbacPrincipal,
  relayUpstream,
  writeJson,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';

export type SecretsRoute =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'rotate'; secretId: string }
  | { kind: 'disable'; secretId: string }
  | { kind: 'test'; secretId: string };

const LIST_PARAM_ALLOWLIST = ['cursor', 'limit', 'state', 'purpose', 'sort'] as const;
const MAX_IDEMPOTENCY_KEY_LENGTH = 200;

export function matchSecretsRoute(relative: string): SecretsRoute | null {
  if (relative === '/secrets') return { kind: 'list' };
  const action = /^\/secrets\/([^/]+)\/(rotate|disable|test)$/.exec(relative);
  if (!action) return null;
  const secretId = decodePathSegment(action[1] ?? '');
  if (secretId === null) return null;
  if (action[2] === 'rotate') return { kind: 'rotate', secretId };
  if (action[2] === 'disable') return { kind: 'disable', secretId };
  return { kind: 'test', secretId };
}

/**
 * SC-04-M02 / WT-7 — pure (method, path-route) -> effective-route resolution.
 *
 * `/secrets` is shared by two operations and `matchSecretsRoute` is
 * method-agnostic, so the method has to be resolved here:
 *   list  + GET  -> list
 *   list  + POST -> create
 *   other       -> 405
 * Mutations (`rotate`/`disable`/`test`) stay POST-only.
 *
 * Exported so the OpenAPI generator/projection can assert the DISPATCH MATRIX
 * by calling this function instead of scanning this file's source text: a
 * reformatted (but behaviourally identical) file used to break the generator
 * with an error that did not name the real risk.
 */
export function resolveSecretsRoute(
  method: string,
  route: SecretsRoute,
): { allowed: true; route: SecretsRoute } | { allowed: false; reason: string } {
  if (route.kind === 'list') {
    if (method === 'GET') return { allowed: true, route };
    if (method === 'POST') return { allowed: true, route: { kind: 'create' } };
    return { allowed: false, reason: `method ${method} is not allowed here` };
  }
  if (method === 'POST') return { allowed: true, route };
  return { allowed: false, reason: `method ${method} is not allowed here` };
}
export async function handleSecretsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: SecretsRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase();
  // SC-04-M02: `/secrets` is shared by two operations and the route matcher is
  // method-agnostic. Dispatch the method here instead of rejecting POST before
  // the create branch can run:
  //   list + GET  -> catalog list
  //   list + POST -> create (the former dead `kind: 'create'` branch)
  //   every other (method, route) combination -> 405
  const resolvedRoute = resolveSecretsRoute(method, route);
  if (!resolvedRoute.allowed) {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', resolvedRoute.reason, correlationId);
    return;
  }
  const effectiveRoute: SecretsRoute = resolvedRoute.route;

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

  // Tenant scope: operator is pinned to its stored tenant, platform may pass
  // (or omit) any tenantId.
  let scope: string;
  try {
    scope = authorizeAuditTenantRead(rbacPrincipal(principal), query.get('tenantId') ?? '');
  } catch (err) {
    if (isHttpError(err)) {
      writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
      return;
    }
    throw err;
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

  if (effectiveRoute.kind === 'list') {
    const upstream = new URL('/api/v1/admin/secrets', runtime.jsonBaseUrl);
    for (const name of LIST_PARAM_ALLOWLIST) {
      const value = query.get(name);
      if (value !== null) upstream.searchParams.set(name, value);
    }
    if (scope !== '') upstream.searchParams.set('tenantId', scope);
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    await relayUpstream(res, response, correlationId);
    return;
  }

  // Mutations are platform-admin only; a tenant operator session is refused
  // HERE rather than being handed a token the upstream can only reject.
  if (ctx.role !== 'admin' || principal.kind !== 'platform') {
    writeProblem(res, 403, 'ADMIN_CREDENTIAL_REQUIRED', 'secret changes require a platform admin session', correlationId);
    return;
  }
  const provided = firstHeaderValue(req.headers['x-csrf-token']);
  if (!ctx.verifyCsrf(provided)) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
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

  const validation = validateMutation(effectiveRoute, body, scope);
  if (!validation.ok) {
    writeJson(
      res,
      422,
      problemBody(422, 'INVALID_SCHEMA', validation.message, correlationId, validation.errors),
      correlationId,
    );
    return;
  }

  const upstreamPath = effectiveRoute.kind === 'create'
    ? '/api/v1/admin/secrets'
    : `/api/v1/admin/secrets/${encodeURIComponent(effectiveRoute.secretId)}/${effectiveRoute.kind}`;
  const upstream = new URL(upstreamPath, runtime.jsonBaseUrl);
  const response = await callUpstream(runtime, upstream, {
    method: 'POST',
    credential,
    correlationId,
    jsonBody: JSON.stringify(validation.body),
    idempotencyKey: clampKey(firstHeaderValue(req.headers['idempotency-key'])),
  });
  await relayUpstream(res, response, correlationId);
}

type ValidationResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; message: string; errors: { pointer: string; message: string }[] };

/**
 * Runtime validation with the frozen contract schemas. The tenant scope is
 * enforced on the body too: a platform admin may name a tenant (defaulting to
 * the query scope), and the value must never contradict the resolved scope.
 */
function validateMutation(
  route: Exclude<SecretsRoute, { kind: 'list' }>,
  body: Record<string, unknown>,
  scope: string,
): ValidationResult {
  const projected = (issues: { path: (string | number)[]; message: string }[]) => ({
    message: 'secret request failed schema validation',
    errors: issues.slice(0, 20).map((issue) => ({
      pointer: '/' + issue.path.join('/'),
      message: issue.message,
    })),
  });

  if (route.kind === 'create') {
    const withTenant = {
      ...body,
      ...(scope !== '' ? { tenantId: scope } : {}),
    };
    if (scope !== '' && typeof body.tenantId === 'string' && body.tenantId !== scope) {
      return { ok: false, ...projected([{ path: ['tenantId'], message: 'tenantId does not match the session scope' }]) };
    }
    const parsed = SecretCatalogCreateSchema.safeParse(withTenant);
    if (!parsed.success) return { ok: false, ...projected(parsed.error.issues) };
    return { ok: true, body: parsed.data as unknown as Record<string, unknown> };
  }

  if (route.kind === 'rotate') {
    const parsed = SecretCatalogRotateSchema.safeParse({ ...body, secretId: route.secretId });
    if (!parsed.success) return { ok: false, ...projected(parsed.error.issues) };
    return { ok: true, body: parsed.data as unknown as Record<string, unknown> };
  }

  if (route.kind === 'disable') {
    const parsed = SecretCatalogDisableSchema.safeParse({ ...body, secretId: route.secretId });
    if (!parsed.success) return { ok: false, ...projected(parsed.error.issues) };
    return { ok: true, body: parsed.data as unknown as Record<string, unknown> };
  }

  // Test/probe: no body contract beyond the identifier in the path; forward an
  // empty object so the upstream can still bind the route to an action.
  return { ok: true, body: {} };
}

function clampKey(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH) : undefined;
}
