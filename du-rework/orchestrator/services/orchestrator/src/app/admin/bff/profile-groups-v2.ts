/**
 * PC-08 — same-origin V2 profile-group control-plane routes.
 *
 *   GET  /admin/api/profile-groups/v2?tenantId=
 *   POST /admin/api/profile-groups/v2                       (create)
 *   GET  /admin/api/profile-groups/v2/:groupId[?tenantId=]
 *   PUT  /admin/api/profile-groups/v2/:groupId              (full replacement)
 *   POST /admin/api/profile-groups/v2/:groupId/rollback
 *   POST /admin/api/profile-groups/v2/:groupId/keys         (issue root grant)
 *   POST /admin/api/profile-groups/v2/:groupId/keys/:keyId/revoke
 *
 * The browser never talks to `/api/v2/admin/profile-groups*` directly: this
 * module resolves the shell session, applies the same RFC7807 problem envelope
 * as the rest of the BFF, and relays only what the Admin API answered. Two
 * transport rules are deliberate and are the reason this file exists:
 *
 *  - `If-Match` is forwarded verbatim. Access-version CAS is the service's
 *    contract (`428` when missing, `412` when stale); the BFF never invents or
 *    rewrites a validator.
 *  - `ETag` (group reads/writes) and `idempotent-replay` (grant mutations) are
 *    the only upstream response headers relayed.
 *
 * Local USER sessions (OIDC `du-local` operator) are refused here by decision
 * D-01: there is no group-level assignment projection, so the V2 group plane
 * stays platform-Admin only. Their workbench path is the v1 panel.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { isHttpError } from '../../../http/errors';
import { authorizeAuditTenantRead } from '../../../modules/admin-actions/rbac';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import { boundedMessage } from './envelope';
import {
  callUpstream,
  credentialFor,
  decodePathSegment,
  firstHeaderValue,
  rbacPrincipal,
  relayUpstream,
  writeProblem,
  type BffRuntimeConfig,
  type RelayableUpstreamHeader,
} from './upstream';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';

export type ProfileGroupsV2Route =
  | { kind: 'list' }
  | { kind: 'catalog' }
  | { kind: 'group'; groupId: string }
  | { kind: 'rollback'; groupId: string }
  | { kind: 'keys'; groupId: string }
  | { kind: 'keyRevoke'; groupId: string; keyId: string }
  | { kind: 'invalid' };

const PREFIX = '/profile-groups/v2';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_RE = /^[!-~]{8,200}$/;
const MAX_IF_MATCH = 64;

/**
 * MUST be matched before `matchProfileGroupsRoute`: the v1 matcher answers
 * `{kind:'invalid'}` (404) for `/profile-groups/v2`, so a later position would
 * make these routes unreachable.
 */
export function matchProfileGroupsV2Route(relative: string): ProfileGroupsV2Route | null {
  if (relative !== PREFIX && !relative.startsWith(`${PREFIX}/`)) return null;
  if (relative === PREFIX) return { kind: 'list' };

  const suffix = relative.slice(PREFIX.length);
  // PC-R07: the catalog MUST be matched before the `/:groupId` shape, exactly
  // like the upstream route — `decodeGroupId` would otherwise mark `catalog`
  // as a malformed id and answer 404.
  if (suffix === '/catalog') return { kind: 'catalog' };
  const rollback = /^\/([^/]+)\/rollback$/.exec(suffix);
  if (rollback) return { kind: 'rollback', groupId: decodeGroupId(rollback[1] ?? '') };

  const revoke = /^\/([^/]+)\/keys\/([^/]+)\/revoke$/.exec(suffix);
  if (revoke) {
    return {
      kind: 'keyRevoke',
      groupId: decodeGroupId(revoke[1] ?? ''),
      keyId: decodeGroupId(revoke[2] ?? ''),
    };
  }

  const keys = /^\/([^/]+)\/keys$/.exec(suffix);
  if (keys) return { kind: 'keys', groupId: decodeGroupId(keys[1] ?? '') };

  const group = /^\/([^/]+)$/.exec(suffix);
  if (group) return { kind: 'group', groupId: decodeGroupId(group[1] ?? '') };
  return { kind: 'invalid' };
}

/** A malformed id is a 404 on the whole family (no partial match leaks). */
function decodeGroupId(raw: string): string {
  const decoded = decodePathSegment(raw);
  return decoded !== null && UUID_RE.test(decoded) ? decoded : '\u0000invalid';
}

function invalidId(route: ProfileGroupsV2Route): boolean {
  return (route.kind !== 'list' && route.kind !== 'invalid' && route.kind !== 'catalog'
    && (route.groupId === '\u0000invalid'
      || (route.kind === 'keyRevoke' && route.keyId === '\u0000invalid')));
}

function isSingleQuery(query: URLSearchParams, allowed: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const key of query.keys()) {
    if (!allowed.includes(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function localUserSession(ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): boolean {
  return ctx.plane === 'oidc' && ctx.issuer === 'du-local' && ctx.role === 'operator';
}

function isPlatformAdmin(ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): boolean {
  return ctx.role === 'admin' && ctx.principal.kind === 'platform';
}

type JsonObjectResult =
  | { ok: true; body: Record<string, unknown> }
  | { ok: false; reason: 'too_large' | 'invalid' };

/** Bounded body + exactly one JSON object. */
async function readJsonObject(req: IncomingMessage): Promise<JsonObjectResult> {
  const raw = await readBoundedBody(req);
  if (raw === null) return { ok: false, reason: 'too_large' };
  let body: unknown;
  try {
    body = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: 'invalid' };
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return { ok: false, reason: 'invalid' };
  }
  return { ok: true, body: body as Record<string, unknown> };
}

export async function handleProfileGroupsV2Route(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: ProfileGroupsV2Route,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid' || invalidId(route)) {
    writeProblem(res, 404, 'NOT_FOUND', 'no Profile Group V2 route matches this request', correlationId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  if (localUserSession(ctx)) {
    // D-01: no group-level assignment projection exists, so the V2 group plane
    // is platform-Admin only; a local USER keeps the v1 workbench surface.
    writeProblem(
      res,
      403,
      'PROFILE_GROUP_ASSIGNMENT_REQUIRED',
      'local USER sessions cannot read or edit Profile Group V2 configuration',
      correlationId,
    );
    return;
  }
  if (ctx.principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PROFILE_SCOPE_GATE', 'profile-group routes require a platform or tenant principal', correlationId);
    return;
  }

  if (route.kind === 'catalog') {
    // PC-R07: the registered-function catalog the editor reads to discover each
    // parameter's declared source. It is an Admin-only read of immutable registry
    // data, so there is no CSRF proof, but the caller is still platform-Admin —
    // the upstream route enforces the same rule. `tenantId` is optional scope for
    // the tenant's ACTIVE workflow revisions, never an access grant.
    if ((req.method ?? 'GET').toUpperCase() !== 'GET') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'the registered function catalog accepts GET only', correlationId);
      return;
    }
    if (!isSingleQuery(query, ['businessId', 'businessVersion', 'tenantId'])) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'the catalog accepts one businessId, one businessVersion and an optional tenantId', correlationId);
      return;
    }
    const businessId = query.get('businessId');
    const businessVersion = query.get('businessVersion');
    if (businessId === null || businessId === '' || businessVersion === null || businessVersion === '') {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'businessId and businessVersion are required', correlationId);
      return;
    }
    // Wave3-F4 follow-up: an optional tenant scope is forwarded so the Admin API
    // can pin the tenant's ACTIVE workflow revisions. The catalog itself stays
    // platform-scoped; the relay never reshapes the tenant-scoped body.
    const tenantId = query.get('tenantId');
    if (tenantId !== null && tenantId.trim() === '') {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'tenantId must be a non-empty string', correlationId);
      return;
    }
    if (!isPlatformAdmin(ctx)) {
      writeProblem(res, 403, 'ADMIN_CREDENTIAL_REQUIRED', 'registered business functions are platform-scoped', correlationId);
      return;
    }
    if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
      writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
      return;
    }
    const catalogCredential = credentialFor(ctx.principal, runtime);
    if (catalogCredential === null) {
      writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this principal', correlationId);
      return;
    }
    const upstream = new URL('/api/v2/admin/profile-groups/catalog', runtime.jsonBaseUrl);
    upstream.searchParams.set('businessId', businessId);
    upstream.searchParams.set('businessVersion', businessVersion);
    if (tenantId !== null) upstream.searchParams.set('tenantId', tenantId);
    // The relay is byte-faithful on purpose: `parameterResolution` (PC-R07) and
    // any future catalog field reach the editor exactly as the Admin API
    // projected them, with no BFF-side reshaping to drift from the contract.
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential: catalogCredential, correlationId });
    await relayUpstream(res, response, correlationId);
    return;
  }

  const read = method === 'GET';
  if (route.kind === 'list') {
    if (!read && method !== 'POST') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile groups accept GET or POST', correlationId);
      return;
    }
    if (read ? !isSingleQuery(query, ['tenantId']) : query.size !== 0) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'profile-group V2 accepts one tenantId on reads and none on writes', correlationId);
      return;
    }
  } else if (route.kind === 'group') {
    if (!read && method !== 'PUT') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile-group reads use GET and full replacement uses PUT', correlationId);
      return;
    }
    const allowed = read ? ['tenantId'] : [];
    if (!isSingleQuery(query, allowed)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'profile-group V2 detail accepts one tenantId on reads and none on writes', correlationId);
      return;
    }
  } else {
    if (method !== 'POST') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile-group V2 grant actions require POST', correlationId);
      return;
    }
    if (query.size !== 0) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'profile-group V2 grant actions do not accept query parameters', correlationId);
      return;
    }
  }

  const mutation = !read;
  if (mutation && !isPlatformAdmin(ctx)) {
    writeProblem(res, 403, 'PROFILE_SCOPED_GATE', 'profile-group mutations require platform Admin access', correlationId);
    return;
  }
  if (mutation && !ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
    return;
  }
  if (typeof runtime.jsonBaseUrl !== 'string' || runtime.jsonBaseUrl.length === 0) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  let tenantScope = '';
  if (read) {
    try {
      tenantScope = authorizeAuditTenantRead(rbacPrincipal(ctx.principal), query.get('tenantId') ?? '');
    } catch (err) {
      if (isHttpError(err)) {
        writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
        return;
      }
      throw err;
    }
    if (route.kind === 'list' && tenantScope === '') {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'tenantId is required for platform profile-group listing', correlationId);
      return;
    }
  }

  const credential = credentialFor(ctx.principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this principal', correlationId);
    return;
  }

  const base = runtime.jsonBaseUrl;
  if (!mutation) {
    const upstream = new URL(
      route.kind === 'list'
        ? '/api/v2/admin/profile-groups'
        : `/api/v2/admin/profile-groups/${encodeURIComponent(route.groupId)}`,
      base,
    );
    if (route.kind === 'list') upstream.searchParams.set('tenantId', tenantScope);
    else if (tenantScope !== '') upstream.searchParams.set('tenantId', tenantScope);
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    await relayUpstream(res, response, correlationId, { relayHeaders: ['etag'] });
    return;
  }

  // Idempotency and access-version preconditions are grant-mutation transport.
  let idempotencyKey: string | undefined;
  if (route.kind === 'keys' || route.kind === 'keyRevoke') {
    const provided = firstHeaderValue(req.headers['idempotency-key']);
    if (provided === undefined || !IDEMPOTENCY_KEY_RE.test(provided)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'Idempotency-Key is required for profile-group grant mutations', correlationId);
      return;
    }
    idempotencyKey = provided;
  }
  const ifMatchRaw = firstHeaderValue(req.headers['if-match']);
  if (ifMatchRaw !== undefined && (ifMatchRaw.length > MAX_IF_MATCH || /[\u0000-\u001f\u007f]/.test(ifMatchRaw))) {
    writeProblem(res, 400, 'INVALID_SCHEMA', 'If-Match must be the current access version', correlationId);
    return;
  }

  const body = await readJsonObject(req);
  if (!body.ok) {
    if (body.reason === 'too_large') {
      writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId);
      return;
    }
    writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be a JSON object', correlationId);
    return;
  }

  let upstream: URL;
  if (route.kind === 'list') upstream = new URL('/api/v2/admin/profile-groups', base);
  else if (route.kind === 'group') upstream = new URL(`/api/v2/admin/profile-groups/${encodeURIComponent(route.groupId)}`, base);
  else if (route.kind === 'rollback') upstream = new URL(`/api/v2/admin/profile-groups/${encodeURIComponent(route.groupId)}/rollback`, base);
  else if (route.kind === 'keys') upstream = new URL(`/api/v2/admin/profile-groups/${encodeURIComponent(route.groupId)}/keys`, base);
  else upstream = new URL(`/api/v2/admin/profile-groups/${encodeURIComponent(route.groupId)}/keys/${encodeURIComponent(route.keyId)}/revoke`, base);

  const relayHeaders: RelayableUpstreamHeader[] = route.kind === 'keys' || route.kind === 'keyRevoke'
    ? ['idempotent-replay']
    : ['etag'];
  const response = await callUpstream(runtime, upstream, {
    method: method as 'POST' | 'PUT',
    credential,
    correlationId,
    jsonBody: JSON.stringify(body.body),
    ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
    ...(ifMatchRaw !== undefined ? { ifMatch: ifMatchRaw } : {}),
  });
  await relayUpstream(res, response, correlationId, { relayHeaders });
}
