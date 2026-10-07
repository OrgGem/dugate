/**
 * BFF Settings routes (SETTINGS-WIRE-BASE / BFF-SETTINGS-IDENTITY).
 *
 *   GET  /admin/api/settings   → relay the platform's read view verbatim
 *   POST /admin/api/settings   → REFUSED at the capability gate (fail-closed)
 *
 * Fence mirrors bff/security.ts exactly:
 *  - the session is resolved first; anonymous → 401, unscoped → 403;
 *  - the tenant comes from the SESSION (operator rides its own tenant
 *    credential and can never widen by editing the query string);
 *  - mutations require the session CSRF proof BEFORE the role check, so an
 *    unauthenticated cross-site caller learns nothing about the role policy;
 *  - every response is no-store.
 *
 * SECRETS: the read view carries `storage.secretPresent` (a boolean) and never a
 * credential value. This route adds no field to that view and never widens it,
 * so a secret cannot reach the browser through this path.
 *
 * WRITER: disabled/fail-closed BY CONSTRUCTION. No deployment adapter ships in
 * the tree (the ACUI-M06 `connectorBaseUrls` shape — boot-time config with no
 * Admin mutation path), so a "Save" would either persist nothing or write to a
 * store no boot path reads. Rather than invent storage, the writer refuses with
 * `SETTINGS_WRITER_DISABLED` and an explicit reason, and makes NO upstream call.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@du/observability';
import { isHttpError } from '../../../http/errors';
import { authorizeAuditTenantRead } from '../../../modules/admin-actions/rbac';
import {
  SettingsReadSchema,
  SETTINGS_WRITER_DISABLED_CODE,
  SETTINGS_WRITER_DISABLED_REASON,
} from '@du/contracts';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import {
  boundedMessage,
  callUpstream,
  credentialFor,
  firstHeaderValue,
  rbacPrincipal,
  relayUpstream,
  writeJson,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';

const logger = createLogger({ service: 'orchestrator', baseFields: { subsystem: 'admin-bff' } });

export type SettingsRoute = { kind: 'settings' } | { kind: 'invalid' };

export function matchSettingsRoute(relative: string): SettingsRoute | null {
  if (relative === '/settings') return { kind: 'settings' };
  return null;
}

export async function handleSettingsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: SettingsRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no Settings route matches this request', correlationId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST' && method !== 'PUT') {
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

  // Tenant scope: the operator is pinned to its stored tenant; platform may
  // pass (or omit) any tenantId. A caller cannot widen its own scope here.
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

  if (method !== 'GET') {
    // ---- disabled writer -------------------------------------------------
    // CSRF BEFORE role, so a cross-site caller cannot probe the role policy.
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
        'settings changes require a platform admin session',
        correlationId,
      );
      return;
    }
    // The capability gate. There is no deployment adapter in this build, so
    // the writer is off no matter who asks — and we do NOT reach upstream,
    // because doing so would make this a write attempt against a store that
    // does not exist.
    writeProblem(res, 503, SETTINGS_WRITER_DISABLED_CODE, SETTINGS_WRITER_DISABLED_REASON, correlationId);
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

  const upstream = new URL('/api/v1/admin/settings', runtime.jsonBaseUrl);
  if (scope !== '') upstream.searchParams.set('tenantId', scope);

  // 4xx keeps status+code; 5xx collapses to 502 UPSTREAM_ERROR via
  // relayUpstream → upstreamProblem.
  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  if (!response.ok) {
    await relayUpstream(res, response, correlationId);
    return;
  }

  // The read is NARROWED through the strict DTO, not relayed raw. "Verbatim"
  // means the platform's own view is republished unchanged — it does NOT mean
  // an upstream field we did not model is passed to the browser. `SettingsReadSchema`
  // is `.strict()` at every level, so a field such as `storage.secretValue`
  // is DROPPED here instead of leaking: redaction is enforced at the boundary,
  // not merely documented. If upstream sent an unparseable body the honest
  // answer is 502 UPSTREAM_ERROR, never a half-trusted echo.
  const raw = await response.text().catch(() => '');
  let parsed: unknown = null;
  try {
    parsed = raw.length === 0 ? null : JSON.parse(raw);
  } catch {
    parsed = null;
  }
  const narrowed = parsed === null ? null : SettingsReadSchema.safeParse(parsed);
  if (narrowed === null || !narrowed.success) {
    logger.warn('[admin-bff] settings read did not match the settings DTO', {
      correlationId,
      status: response.status,
    });
    writeProblem(res, 502, 'UPSTREAM_ERROR', 'the admin API returned an unreadable settings view', correlationId);
    return;
  }
  writeJson(res, response.status, narrowed.data, correlationId);
}