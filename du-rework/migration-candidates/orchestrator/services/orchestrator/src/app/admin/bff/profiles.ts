/**
 * BFF Profile routes (AWEB-04, T-UI-01/05/06) — wire frozen against the
 * Profile plan (T-API-01..03, Phase 3 of C:/Users/Gem/.claude/plans/
 * typed-discovering-wall.md).
 *
 *   GET  /admin/api/profiles/:b/:v/:n            → read (viewer gate below)
 *   POST /admin/api/profiles/:b/:v/:n/upsert     → profile.upsert  (dispatcher)
 *   POST /admin/api/profiles/:b/:v/:n/publish    → profile.publish (dispatcher)
 *   POST /admin/api/profiles/:b/:v/:n/rollback   → profile.rollback (dispatcher)
 *   POST /admin/api/profiles/test-endpoint       → T-UI-06 passthrough (gated)
 *
 * T-UI-05 fence (Profile routes ONLY):
 *  - admin (platform) reads and mutates; CSRF proof required for mutations;
 *  - tenant_operator reads with its OWN tenant credential (no platform
 *    bypass); mutations wait for the assignment model;
 *  - viewer/scoped reads wait for T-AUTH-03 (VFY-LOCAL) — today they are
 *    refused with an explicit reason rather than riding the platform token.
 * Mutations are forwarded to the dispatcher (`/api/v1/admin/actions`) so the
 * profile policy has exactly one write path; until T-API-02 lands the
 * dispatcher answers 404 ACTION_NOT_FOUND and the UI shows `requires backend`.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import { credentialForTenant, decodePathSegment, firstHeaderValue, callUpstream, relayUpstream, writeProblem, type BffRuntimeConfig } from './upstream';

export type ProfilesRoute =
  | { kind: 'detail'; businessId: string; businessVersion: string; profileName: string }
  | { kind: 'upsert' | 'publish' | 'rollback'; businessId: string; businessVersion: string; profileName: string }
  | { kind: 'test-endpoint' }
  | { kind: 'invalid' };

export function matchProfilesRoute(relative: string): ProfilesRoute | null {
  if (relative === '/profiles/test-endpoint') return { kind: 'test-endpoint' };
  const m = /^\/profiles\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(upsert|publish|rollback))?$/.exec(relative);
  if (!m) return null;
  const businessId = decodePathSegment(m[1] ?? '');
  const businessVersion = decodePathSegment(m[2] ?? '');
  const profileName = decodePathSegment(m[3] ?? '');
  if (businessId === null || businessVersion === null || profileName === null) return { kind: 'invalid' };
  const op = m[4];
  if (op === 'upsert' || op === 'publish' || op === 'rollback') {
    return { kind: op, businessId, businessVersion, profileName };
  }
  return { kind: 'detail', businessId, businessVersion, profileName };
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_REVISION = 1_000_000_000;

export async function handleProfilesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: ProfilesRoute,
  _query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no Profile route matches this request', correlationId);
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

  if (route.kind === 'detail') {
    if (method !== 'GET') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile reads are GET', correlationId);
      return;
    }
    if (ctx.principal.kind === 'unscoped') {
      // T-UI-05: no platform-token bypass for viewer/scoped sessions — the
      // assignment model that would scope this read is T-AUTH-03 (VFY-LOCAL).
      writeProblem(
        res,
        403,
        'PROFILE_SCOPE_GATE',
        'viewer/scoped profile reads wait for the assignment model (T-AUTH-03, VFY-LOCAL)',
        correlationId,
      );
      return;
    }
    if (!hasJsonBase(runtime)) {
      writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
      return;
    }
    const credential =
      ctx.principal.kind === 'platform'
        ? runtime.adminToken
        : credentialForTenant(runtime.tenantAdminTokens, ctx.principal.tenantId);
    if (typeof credential !== 'string' || credential.length === 0) {
      writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this tenant', correlationId);
      return;
    }
    const upstream = new URL(
      `/api/v1/admin/profiles/${encodeURIComponent(route.businessId)}/${encodeURIComponent(route.businessVersion)}/${encodeURIComponent(route.profileName)}`,
      runtime.jsonBaseUrl,
    );
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    await relayUpstream(res, response, correlationId);
    return;
  }

  // Mutations (upsert/publish/rollback/test-endpoint): admin + CSRF.
  if (method !== 'POST') {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile mutations are POST', correlationId);
    return;
  }
  if (ctx.role !== 'admin' || ctx.principal.kind !== 'platform') {
    writeProblem(
      res,
      403,
      'PROFILE_SCOPED_GATE',
      'scoped-user profile mutations wait for the assignment model (T-AUTH-03, VFY-LOCAL)',
      correlationId,
    );
    return;
  }
  const provided = firstHeaderValue(req.headers['x-csrf-token']);
  if (!ctx.verifyCsrf(provided)) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
    return;
  }
  if (!hasJsonBase(runtime) || typeof runtime.adminToken !== 'string' || runtime.adminToken.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
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
  const idempotencyKey = firstHeaderValue(req.headers['idempotency-key']);

  if (route.kind === 'test-endpoint') {
    const upstream = new URL('/api/v1/admin/profile-test-endpoint', runtime.jsonBaseUrl);
    const response = await callUpstream(runtime, upstream, {
      method: 'POST',
      credential: runtime.adminToken,
      correlationId,
      jsonBody: JSON.stringify(body),
      idempotencyKey: clampKey(idempotencyKey),
    });
    await relayUpstream(res, response, correlationId);
    return;
  }

  const params: Record<string, unknown> = {
    businessId: route.businessId,
    businessVersion: route.businessVersion,
    profileName: route.profileName,
  };
  // Δ7-A: the write commands name the api key — the frozen ProfileKey alone
  // cannot select a row. Forward the client's `apiKey` object as-is; the
  // dispatcher's strict command schema is the real validator (exactly one of
  // apiKeyId / apiKeyHash). Absent → dispatcher 422, fail closed.
  if (body.apiKey !== undefined) {
    if (typeof body.apiKey !== 'object' || body.apiKey === null || Array.isArray(body.apiKey)) {
      writeProblem(
        res,
        422,
        'INVALID_SCHEMA',
        'apiKey must be an object naming exactly one of apiKeyId or apiKeyHash',
        correlationId,
      );
      return;
    }
    params.apiKey = body.apiKey;
  }
  const expectedRevision = body.expectedRevision;
  if (expectedRevision !== undefined && !isRevision(expectedRevision)) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'expectedRevision must be a non-negative integer', correlationId);
    return;
  }
  if (expectedRevision !== undefined) params.expectedRevision = expectedRevision;

  let action: string;
  if (route.kind === 'upsert') {
    const policy = body.policy;
    if (typeof policy !== 'object' || policy === null || Array.isArray(policy)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'policy must be a JSON object', correlationId);
      return;
    }
    params.policy = policy;
    action = 'profile.upsert';
  } else if (route.kind === 'publish') {
    // Publish is a CAS move: the caller must state the revision it saw.
    if (!isRevision(expectedRevision)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'expectedRevision is required for publish', correlationId);
      return;
    }
    action = 'profile.publish';
  } else {
    const targetRevision = body.targetRevision;
    if (!isRevision(targetRevision)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'targetRevision must be a non-negative integer', correlationId);
      return;
    }
    params.targetRevision = targetRevision;
    action = 'profile.rollback';
  }

  const upstream = new URL('/api/v1/admin/actions', runtime.jsonBaseUrl);
  const response = await callUpstream(runtime, upstream, {
    method: 'POST',
    credential: runtime.adminToken,
    correlationId,
    jsonBody: JSON.stringify({ action, params }),
    idempotencyKey: clampKey(idempotencyKey),
  });
  await relayUpstream(res, response, correlationId, { wrapInData: true });
}

function hasJsonBase(runtime: BffRuntimeConfig): runtime is BffRuntimeConfig & { jsonBaseUrl: string } {
  return typeof runtime.jsonBaseUrl === 'string' && runtime.jsonBaseUrl.length > 0;
}

function isRevision(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= MAX_REVISION;
}

function clampKey(value: string | undefined): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value.slice(0, MAX_IDEMPOTENCY_KEY_LENGTH) : undefined;
}
