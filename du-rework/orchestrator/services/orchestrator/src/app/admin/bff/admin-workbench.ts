/** Same-origin bridge for real admitted Profile tests and Prompt Wizard runs. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { SESSION_COOKIE_NAME } from '../../../modules/auth/session-store';
import {
  AdminWorkbenchEndpointTestRequestSchema,
  AdminWorkbenchPromptWizardRequestSchema,
} from '@du/contracts';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import { callUpstream, credentialFor, firstHeaderValue, relayUpstream, writeProblem, type BffRuntimeConfig, type UpstreamCallOptions } from './upstream';

export type AdminWorkbenchRoute = { kind: 'test-endpoint' | 'prompt-wizard' } | { kind: 'invalid' };

export function matchAdminWorkbenchRoute(relative: string): AdminWorkbenchRoute | null {
  if (relative === '/admin-workbench/test-endpoint') return { kind: 'test-endpoint' };
  if (relative === '/admin-workbench/prompt-wizard') return { kind: 'prompt-wizard' };
  return null;
}

export async function handleAdminWorkbenchRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: AdminWorkbenchRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no Admin workbench route matches this request', correlationId);
    return;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'Admin workbench actions require POST', correlationId);
    return;
  }
  if ([...query].length > 0) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'Admin workbench actions do not accept query parameters', correlationId);
    return;
  }
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  if (!ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
    return;
  }
  if (ctx.role === 'viewer' || ctx.principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PERMISSION_DENIED', 'viewer and unscoped sessions cannot run Admin workbench actions', correlationId);
    return;
  }
  const localOperator = ctx.plane === 'oidc' && ctx.issuer === 'du-local' && ctx.role === 'operator';
  let sessionProof: UpstreamCallOptions['sessionProof'];
  if (localOperator) {
    const sessionId = request.cookies[SESSION_COOKIE_NAME];
    if (ctx.principal.kind !== 'tenant_operator' || !ctx.tenantId || ctx.principal.tenantId !== ctx.tenantId
        || !ctx.sub || !/^[0-9a-f-]{36}$/i.test(ctx.sub)
        || typeof ctx.roleVersion !== 'number' || !Number.isSafeInteger(ctx.roleVersion) || ctx.roleVersion < 1
        || !sessionId) {
      writeProblem(res, 401, 'UNAUTHENTICATED', 'local operator session is missing its current verified identity', correlationId);
      return;
    }
    // Internal cookie auth carries the trusted local sub and validated live
    // version so the service can apply the assigned-key/profile fence. Never
    // accompany this with a tenant bearer that would win auth precedence.
    sessionProof = { cookie: `${SESSION_COOKIE_NAME}=${encodeURIComponent(sessionId)}`, csrfToken: ctx.csrfToken };
  }
  const credential = localOperator ? null : credentialFor(ctx.principal, runtime);
  if (!localOperator && !credential) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no Admin credential is configured for this session tenant', correlationId);
    return;
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }
  const idempotencyKey = firstHeaderValue(req.headers['idempotency-key']);
  if (!idempotencyKey || !/^[!-~]{8,200}$/.test(idempotencyKey)) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'Idempotency-Key is required for Admin workbench actions', correlationId);
    return;
  }
  const raw = await readBoundedBody(req);
  if (raw === null) {
    writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId);
    return;
  }
  let body: unknown;
  try { body = raw.trim() === '' ? null : JSON.parse(raw) as unknown; }
  catch {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'Admin workbench request body must be JSON', correlationId);
    return;
  }
  const schema = route.kind === 'test-endpoint'
    ? AdminWorkbenchEndpointTestRequestSchema
    : AdminWorkbenchPromptWizardRequestSchema;
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'Admin workbench request is invalid or exceeds its configured bounds', correlationId);
    return;
  }
  if (ctx.principal.kind === 'tenant_operator' && parsed.data.tenantId !== ctx.principal.tenantId) {
    writeProblem(res, 404, 'NOT_FOUND', 'not found', correlationId);
    return;
  }
  const path = route.kind === 'test-endpoint'
    ? '/api/internal/admin-workbench/test-endpoint'
    : '/api/internal/admin-workbench/prompt-wizard';
  const call: UpstreamCallOptions = {
    method: 'POST', ...(credential ? { credential } : {}), correlationId,
    jsonBody: JSON.stringify(parsed.data), idempotencyKey,
    ...(sessionProof ? { sessionProof } : {}),
  } as UpstreamCallOptions;
  const response = await callUpstream(runtime, new URL(path, runtime.jsonBaseUrl), call);
  await relayUpstream(res, response, correlationId);
}
