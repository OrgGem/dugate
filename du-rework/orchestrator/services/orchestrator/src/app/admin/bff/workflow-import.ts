/** Same-origin bridge for the bounded JSON/XML workflow preview. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { WorkflowImportPreviewRequestSchema } from '@du/contracts';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import { callUpstream, credentialFor, firstHeaderValue, relayUpstream, writeProblem, type BffRuntimeConfig } from './upstream';

export type WorkflowImportRoute = { kind: 'preview' } | { kind: 'invalid' };

export function matchWorkflowImportRoute(relative: string): WorkflowImportRoute | null {
  if (relative === '/workflow-import/preview') return { kind: 'preview' };
  return null;
}

export async function handleWorkflowImportRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: WorkflowImportRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no workflow import route matches this request', correlationId);
    return;
  }
  if ((req.method ?? 'GET').toUpperCase() !== 'POST') {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'workflow import preview requires POST', correlationId);
    return;
  }
  if ([...query].length > 0) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'workflow import preview does not accept query parameters', correlationId);
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
  if (ctx.role !== 'admin' || ctx.principal.kind !== 'platform') {
    writeProblem(res, 403, 'ADMIN_CREDENTIAL_REQUIRED', 'workflow import is available to platform administrators', correlationId);
    return;
  }
  const credential = credentialFor(ctx.principal, runtime);
  if (!credential) {
    writeProblem(res, 403, 'ADMIN_CREDENTIAL_REQUIRED', 'platform Admin credential is unavailable', correlationId);
    return;
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }
  const raw = await readBoundedBody(req, 600 * 1024);
  if (raw === null) {
    writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'workflow import preview accepts at most 512 KiB of source', correlationId);
    return;
  }
  let body: unknown;
  try { body = raw.trim() === '' ? null : JSON.parse(raw) as unknown; }
  catch {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'workflow import preview body must be JSON', correlationId);
    return;
  }
  const parsed = WorkflowImportPreviewRequestSchema.safeParse(body);
  if (!parsed.success) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'workflow import source is invalid or exceeds the 512 KiB bound', correlationId);
    return;
  }
  const response = await callUpstream(runtime, new URL('/api/internal/workflow-import/preview', runtime.jsonBaseUrl), {
    method: 'POST', credential, correlationId, jsonBody: JSON.stringify(parsed.data),
  });
  await relayUpstream(res, response, correlationId);
}
