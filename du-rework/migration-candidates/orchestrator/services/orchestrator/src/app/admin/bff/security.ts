/**
 * BFF Security routes (AWEB-07) — crypto-config read + write.
 *
 *   GET  /admin/api/crypto-config?tenantId=…  → real view (key REFS only)
 *   POST /admin/api/crypto-config             → apply change (CSRF + admin)
 *
 * Fence mirrors the other slices: the tenant comes from the session (operator
 * rides its own tenant credential and can never widen), the platform bearer is
 * used only for platform sessions, mutations require the session CSRF proof,
 * and every response is no-store. Secrets are never on this wire — the
 * upstream view projects refs/previews only.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHttpError } from '../../../http/errors';
import { authorizeAuditTenantRead } from '../../../modules/admin-actions/rbac';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import {
  boundedMessage,
  callUpstream,
  credentialFor,
  firstHeaderValue,
  rbacPrincipal,
  relayUpstream,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';

export type SecurityRoute = { kind: 'crypto-config' } | { kind: 'invalid' };

export function matchSecurityRoute(relative: string): SecurityRoute | null {
  if (relative === '/crypto-config') return { kind: 'crypto-config' };
  return null;
}

export async function handleSecurityRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: SecurityRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no Security route matches this request', correlationId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST') {
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

  const upstream = new URL('/api/v1/admin/crypto-config', runtime.jsonBaseUrl);
  if (scope !== '') upstream.searchParams.set('tenantId', scope);

  if (method === 'GET') {
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    if (response.status === 503) {
      // A deliberate feature-flag answer from the platform ("crypto
      // configuration is not enabled"), not an internal failure — relay it
      // honestly instead of the generic 5xx→502 collapse.
      writeProblem(
        res,
        503,
        'CRYPTO_CONFIG_UNAVAILABLE',
        'crypto configuration is not enabled on this deployment',
        correlationId,
      );
      return;
    }
    await relayUpstream(res, response, correlationId);
    return;
  }

  // POST — apply change: admin/platform + session CSRF.
  if (ctx.role !== 'admin' || principal.kind !== 'platform') {
    writeProblem(
      res,
      403,
      'ADMIN_CREDENTIAL_REQUIRED',
      'crypto configuration changes require a platform admin session',
      correlationId,
    );
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

  const response = await callUpstream(runtime, upstream, {
    method: 'POST',
    credential,
    correlationId,
    jsonBody: JSON.stringify(parsed),
    idempotencyKey: clampKey(firstHeaderValue(req.headers['idempotency-key'])),
  });
  await relayUpstream(res, response, correlationId);
}

function clampKey(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, 200) : undefined;
}
