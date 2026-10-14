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
import { isTenantUuid } from '@du/contracts';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import { isHttpError } from '../../../http/errors';
import { authorizeAuditTenantRead } from '../../../modules/admin-actions/rbac';
import { resolveBffContext } from './context';
import { readBoundedBody } from './body';
import { boundedMessage } from './envelope';
import { callUpstream, credentialFor, credentialForTenant, decodePathSegment, firstHeaderValue, rbacPrincipal, relayUpstream, writeJson, writeProblem, type BffRuntimeConfig } from './upstream';
import { withMintedRawKey } from './key-minting';

export type ProfileKeyOp = 'attach' | 'rotate';

interface LocalProfileActor {
  tenantId: string;
  issuer: string;
  userId: string;
  roleVersion: number;
}

interface ProfileSelfServiceBff {
  listAssignedProfileEndpoints(rawQuery: unknown, actor: LocalProfileActor): Promise<unknown>;
  listAssignedProfileApiKeys(profileId: string, rawQuery: unknown, actor: LocalProfileActor): Promise<unknown>;
  editAssignedProfile(rawInput: unknown, actor: LocalProfileActor, idempotencyKey: string, correlationId: string): Promise<unknown>;
}

function localProfileActor(ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): LocalProfileActor | null {
  const roleVersion = ctx.roleVersion;
  if (ctx.plane !== 'oidc' || ctx.role !== 'operator' || ctx.principal.kind !== 'tenant_operator'
      || !ctx.tenantId || ctx.principal.tenantId !== ctx.tenantId
      || !/^[0-9a-f-]{36}$/i.test(ctx.tenantId)
      || !ctx.issuer || ctx.issuer.trim().length === 0
      || !ctx.sub || !/^[0-9a-f-]{36}$/i.test(ctx.sub)
      || typeof roleVersion !== 'number' || !Number.isSafeInteger(roleVersion) || roleVersion < 1) return null;
  return { tenantId: ctx.tenantId, issuer: ctx.issuer, userId: ctx.sub, roleVersion };
}

function profileSelfService(runtime: BffRuntimeConfig): ProfileSelfServiceBff | null {
  const service = (runtime as BffRuntimeConfig & { profileSelfService?: ProfileSelfServiceBff }).profileSelfService;
  if (!service || typeof service.listAssignedProfileEndpoints !== 'function'
      || typeof service.listAssignedProfileApiKeys !== 'function'
      || typeof service.editAssignedProfile !== 'function') return null;
  return service;
}

export type ProfilesRoute =
  | { kind: 'list' }
  | { kind: 'assigned' }
  | { kind: 'assigned-api-keys'; profileId: string }
  | { kind: 'detail'; businessId: string; businessVersion: string; profileName: string }
  | { kind: 'upsert' | 'publish' | 'rollback' | 'self-service'; businessId: string; businessVersion: string; profileName: string }
  /** 0039: the key set the profile owns (GET). */
  | { kind: 'api-keys'; businessId: string; businessVersion: string; profileName: string }
  /** 0039: membership write for one key of this profile (POST). */
  | { kind: 'api-key-op'; op: ProfileKeyOp; businessId: string; businessVersion: string; profileName: string }
  /** AWEB-14: workflows owned by the profile's exact business/version. */
  | { kind: 'workflows'; businessId: string; businessVersion: string; profileName: string }
  | { kind: 'test-endpoint' }
  | { kind: 'invalid' };

export function matchProfilesRoute(relative: string): ProfilesRoute | null {
  if (relative === '/profiles') return { kind: 'list' };
  if (relative === '/profiles/assigned') return { kind: 'assigned' };
  const assignedApiKeys = /^\/profiles\/assigned\/([^/]+)\/api-keys$/.exec(relative);
  if (assignedApiKeys) {
    const profileId = decodePathSegment(assignedApiKeys[1] ?? '');
    if (profileId === null || !/^[0-9a-f-]{36}$/i.test(profileId)) return { kind: 'invalid' };
    return { kind: 'assigned-api-keys', profileId };
  }
  if (relative === '/profiles/test-endpoint') return { kind: 'test-endpoint' };
  // The op alternation must capture the BARE segment: with
  // `api-keys(?:/(attach|rotate))?` INSIDE the group, group 4 receives the
  // whole `api-keys/attach` and every comparison against a bare op fails.
  const m = /^\/profiles\/([^/]+)\/([^/]+)\/([^/]+)(?:\/(upsert|publish|rollback|self-service|api-keys|workflows)(?:\/(attach|rotate))?)?$/.exec(
    relative,
  );
  if (!m) return null;
  const businessId = decodePathSegment(m[1] ?? '');
  const businessVersion = decodePathSegment(m[2] ?? '');
  const profileName = decodePathSegment(m[3] ?? '');
  if (businessId === null || businessVersion === null || profileName === null) return { kind: 'invalid' };
  const op = m[4];
  const sub = m[5];
  // Only the key set has sub-resources; `/upsert/attach` is not a profile route.
  if (op !== 'api-keys' && sub !== undefined) return null;
  if (op === 'upsert' || op === 'publish' || op === 'rollback' || op === 'self-service') {
    return { kind: op, businessId, businessVersion, profileName };
  }
  if (op === 'api-keys') {
    // Group 5 carries the membership write; absent means the read.
    if (sub === 'attach' || sub === 'rotate') {
      return { kind: 'api-key-op', op: sub, businessId, businessVersion, profileName };
    }
    return { kind: 'api-keys', businessId, businessVersion, profileName };
  }
  if (op === 'workflows') return { kind: 'workflows', businessId, businessVersion, profileName };
  return { kind: 'detail', businessId, businessVersion, profileName };
}

const MAX_IDEMPOTENCY_KEY_LENGTH = 200;
const MAX_REVISION = 1_000_000_000;

export async function handleProfilesRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: ProfilesRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no Profile route matches this request', correlationId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  if (method !== 'GET' && method !== 'POST' && method !== 'PATCH') {
    writeProblem(res, 405, 'METHOD_NOT_ALLOWED', `method ${method} is not allowed here`, correlationId);
    return;
  }

  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }

  if (route.kind === 'assigned') {
    if (method !== 'GET') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'assigned Profile discovery is GET', correlationId);
      return;
    }
    const actor = localProfileActor(ctx);
    if (!actor) {
      writeProblem(res, 403, 'PROFILE_ASSIGNMENT_REQUIRED', 'only the assigned local USER can discover assigned Profile endpoints', correlationId);
      return;
    }
    const service = profileSelfService(runtime);
    if (!service) {
      writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'assigned Profile service is unavailable', correlationId);
      return;
    }
    const allowed = new Set(['query', 'cursor', 'limit']);
    if ([...query.keys()].some((key) => !allowed.has(key))
        || ['query', 'cursor', 'limit'].some((key) => query.getAll(key).length > 1)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'assigned Profile query accepts one query, cursor, and limit value', correlationId);
      return;
    }
    const page = await service.listAssignedProfileEndpoints({
      ...(query.has('query') ? { query: query.get('query') } : {}),
      ...(query.has('cursor') ? { cursor: query.get('cursor') } : {}),
      ...(query.has('limit') ? { limit: query.get('limit') } : {}),
    }, actor);
    writeJson(res, 200, page, correlationId);
    return;
  }

  if (route.kind === 'assigned-api-keys') {
    if (method !== 'GET') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'assigned Profile API key discovery is GET', correlationId);
      return;
    }
    const actor = localProfileActor(ctx);
    if (!actor) {
      writeProblem(res, 403, 'PROFILE_ASSIGNMENT_REQUIRED', 'only the assigned local USER can select an API key for this Profile endpoint', correlationId);
      return;
    }
    const service = profileSelfService(runtime);
    if (!service) {
      writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'assigned Profile service is unavailable', correlationId);
      return;
    }
    const allowed = new Set(['query', 'cursor', 'limit']);
    if ([...query.keys()].some((key) => !allowed.has(key))
        || ['query', 'cursor', 'limit'].some((key) => query.getAll(key).length > 1)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'assigned API key query accepts one query, cursor, and limit value', correlationId);
      return;
    }
    const page = await service.listAssignedProfileApiKeys(route.profileId, {
      ...(query.has('query') ? { query: query.get('query') } : {}),
      ...(query.has('cursor') ? { cursor: query.get('cursor') } : {}),
      ...(query.has('limit') ? { limit: query.get('limit') } : {}),
    }, actor);
    writeJson(res, 200, page, correlationId);
    return;
  }

  if (route.kind === 'self-service') {
    if (method !== 'PATCH') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'assigned Profile edits require PATCH', correlationId);
      return;
    }
    const actor = localProfileActor(ctx);
    if (!actor) {
      writeProblem(res, 403, 'PROFILE_ASSIGNMENT_REQUIRED', 'only the assigned local USER can edit this Profile endpoint', correlationId);
      return;
    }
    const provided = firstHeaderValue(req.headers['x-csrf-token']);
    if (!ctx.verifyCsrf(provided)) {
      writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
      return;
    }
    const service = profileSelfService(runtime);
    if (!service) {
      writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'assigned Profile service is unavailable', correlationId);
      return;
    }
    const raw = await readBoundedBody(req);
    if (raw === null) {
      writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId);
      return;
    }
    let body: unknown;
    try { body = raw.length === 0 ? null : JSON.parse(raw); }
    catch {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId);
      return;
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be a JSON object', correlationId);
      return;
    }
    const patch = body as Record<string, unknown>;
    const allowed = new Set(['profileId', 'expectedRevision', 'parameterValues', 'connectionsOverride']);
    if (Object.keys(patch).some((key) => !allowed.has(key))
        || typeof patch.profileId !== 'string' || !/^[0-9a-f-]{36}$/i.test(patch.profileId)
        || !isRevision(patch.expectedRevision)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'profileId and expectedRevision are required with allowed parameter or connection edits', correlationId);
      return;
    }
    const idempotencyKey = firstHeaderValue(req.headers['idempotency-key']);
    if (!idempotencyKey || !/^[!-~]{8,200}$/.test(idempotencyKey)) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'Idempotency-Key is required for assigned Profile edits', correlationId);
      return;
    }
    const result = await service.editAssignedProfile({
      tenantId: actor.tenantId,
      profileId: patch.profileId,
      businessId: route.businessId,
      businessVersion: route.businessVersion,
      profileName: route.profileName,
      expectedRevision: patch.expectedRevision,
      ...(patch.parameterValues !== undefined ? { parameterValues: patch.parameterValues } : {}),
      ...(patch.connectionsOverride !== undefined ? { connectionsOverride: patch.connectionsOverride } : {}),
    }, actor, idempotencyKey, correlationId);
    writeJson(res, 200, result, correlationId);
    return;
  }

  if (route.kind === 'list') {
    if (method !== 'GET') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile lists are GET', correlationId);
      return;
    }
    await forwardProfileList(res, ctx, runtime, query, correlationId);
    return;
  }

  if (route.kind === 'workflows') {
    if (method === 'GET') {
      await forwardProfileRead(res, ctx, runtime, route, '/workflows', correlationId, query);
      return;
    }
  } else if (route.kind === 'detail' || route.kind === 'api-keys') {
    if (method !== 'GET') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile reads are GET', correlationId);
      return;
    }
    await forwardProfileRead(res, ctx, runtime, route, route.kind === 'api-keys' ? '/api-keys' : '', correlationId, query);
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

  if (route.kind === 'workflows') {
    const tenantIds = query.getAll('tenantId');
    const workflowSlug = body.workflowSlug;
    const workflowRevision = body.workflowRevision;
    const enabled = body.enabled;
    const allowedFields = new Set(['workflowSlug', 'workflowRevision', 'enabled']);
    if (tenantIds.length !== 1 || !tenantIds[0]) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'tenantId is required exactly once for profile workflows', correlationId);
      return;
    }
    if (Object.keys(body).some((key) => !allowedFields.has(key))
        || typeof workflowSlug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workflowSlug)
        || typeof workflowRevision !== 'number' || !Number.isSafeInteger(workflowRevision) || workflowRevision < 1
        || typeof enabled !== 'boolean') {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'workflowSlug, positive workflowRevision, and enabled are required', correlationId);
      return;
    }
    const upstream = new URL(profileUpstreamPath(route, '/workflows'), runtime.jsonBaseUrl);
    upstream.searchParams.set('tenantId', tenantIds[0]!);
    const response = await callUpstream(runtime, upstream, {
      method: 'POST',
      credential: runtime.adminToken,
      correlationId,
      jsonBody: JSON.stringify({ workflowSlug, workflowRevision, enabled }),
      idempotencyKey: clampKey(idempotencyKey),
    });
    await relayUpstream(res, response, correlationId);
    return;
  }

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

  // 0039 membership write for ONE key of this profile. The URL is the only
  // address the client picks; `profileId` is resolved server-side from that
  // same tuple, so the body can never aim the write at a different profile.
  if (route.kind === 'api-key-op') {
    const apiKeyId = body.apiKeyId;
    // Blank is refused here rather than forwarded: an id of spaces would reach
    // the platform as a lookup that can never match, turning a caller bug into
    // a confusing 404.
    if (typeof apiKeyId !== 'string' || apiKeyId.trim().length === 0 || apiKeyId.length > 64) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'apiKeyId must be a non-empty string', correlationId);
      return;
    }
    const keyParams: Record<string, unknown> = { apiKeyId };
    if (body.name !== undefined) {
      if (typeof body.name !== 'string' || body.name.trim().length === 0 || body.name.length > 120) {
        writeProblem(res, 422, 'INVALID_SCHEMA', 'name must be 1..120 characters', correlationId);
        return;
      }
      keyParams.name = body.name.trim();
    }
    const profileId = await resolveProfileId(runtime, runtime.adminToken, route, correlationId);
    if (profileId === null) {
      writeProblem(res, 404, 'NOT_FOUND', 'profile is not stored yet, so it owns no keys', correlationId);
      return;
    }
    keyParams.profileId = profileId;
    const action = route.op === 'attach' ? 'apikey.attach' : 'apikey.rotate';
    const upstream = new URL('/api/v1/admin/actions', runtime.jsonBaseUrl);
    const response = await callUpstream(runtime, upstream, {
      method: 'POST',
      credential: runtime.adminToken,
      correlationId,
      // rotate needs a raw value: minted HERE (server-side), never in the
      // browser. attach has none to mint.
      jsonBody: JSON.stringify({ action, params: withMintedRawKey(action, keyParams) }),
      idempotencyKey: clampKey(idempotencyKey),
    });
    await relayUpstream(res, response, correlationId, { wrapInData: true });
    return;
  }

  const params: Record<string, unknown> = {
    businessId: route.businessId,
    businessVersion: route.businessVersion,
    profileName: route.profileName,
  };
  if (body.action !== undefined) {
    if (typeof body.action !== 'string' || body.action.length < 1) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'action must be a non-empty string', correlationId);
      return;
    }
    params.action = body.action;
  }
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
    if(body.endpointSlug !== undefined) params.endpointSlug=body.endpointSlug;
    if(body.connectorBindings !== undefined) params.connectorBindings=body.connectorBindings;
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

/**
 * One read path for BOTH the detail and the api-keys list: same T-UI-05
 * scope gate, same credential selection, same no-store relay. `suffix` is the
 * only difference ('' vs '/api-keys').
 */
async function forwardProfileRead(
  res: ServerResponse,
  ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>,
  runtime: BffRuntimeConfig,
  route: { businessId: string; businessVersion: string; profileName: string },
  suffix: string,
  correlationId: string,
  query?: URLSearchParams,
): Promise<void> {
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
  const upstream = new URL(profileUpstreamPath(route, suffix), runtime.jsonBaseUrl);
  if (suffix === '/workflows') {
    const tenantIds = query?.getAll('tenantId') ?? [];
    if (tenantIds.length !== 1 || !tenantIds[0]) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'tenantId is required exactly once for profile workflows', correlationId);
      return;
    }
    upstream.searchParams.set('tenantId', tenantIds[0]);
  } else if (suffix === '') {
    const tenantIds = query?.getAll('tenantId') ?? [];
    const profileIds = query?.getAll('profileId') ?? [];
    if (tenantIds.length > 1 || (tenantIds.length === 1 && !isTenantUuid(tenantIds[0]))) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'tenantId must be a canonical UUID and must not be repeated', correlationId);
      return;
    }
    if (profileIds.length > 1 || (profileIds.length === 1 && !isTenantUuid(profileIds[0]))) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'profileId must be a canonical UUID and must not be repeated', correlationId);
      return;
    }
    let scope: string;
    try {
      scope = authorizeAuditTenantRead(rbacPrincipal(ctx.principal), tenantIds[0] ?? '');
    } catch (err) {
      if (isHttpError(err)) {
        writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
        return;
      }
      throw err;
    }
    if (profileIds.length === 1 && scope === '') {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'profileId requires a tenant-scoped detail read', correlationId);
      return;
    }
    if (scope !== '') upstream.searchParams.set('tenantId', scope);
    if (profileIds.length === 1) upstream.searchParams.set('profileId', profileIds[0]!);
  }
  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

const PROFILE_LIST_PARAM_ALLOWLIST = ['businessId', 'limit', 'cursor', 'sort'] as const;

/** Derive list scope from the authenticated session; never trust tenantId from the browser. */
async function forwardProfileList(
  res: ServerResponse,
  ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>,
  runtime: BffRuntimeConfig,
  query: URLSearchParams,
  correlationId: string,
): Promise<void> {
  const principal = ctx.principal;
  if (principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PROFILE_SCOPE_GATE', 'profile list reads require a platform or tenant principal', correlationId);
    return;
  }

  let scope: string;
  try {
    scope = authorizeAuditTenantRead(rbacPrincipal(principal), query.get('tenantId')?.trim() ?? '');
  } catch (err) {
    if (isHttpError(err)) {
      writeProblem(res, err.status, err.code, boundedMessage(err.message) ?? 'request denied', correlationId);
      return;
    }
    throw err;
  }

  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this principal', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }

  const upstream = new URL('/api/v1/admin/profiles', runtime.jsonBaseUrl);
  for (const name of PROFILE_LIST_PARAM_ALLOWLIST) {
    const value = query.get(name)?.trim();
    if (value) upstream.searchParams.set(name, value);
  }
  if (scope !== '') upstream.searchParams.set('tenantId', scope);
  else upstream.searchParams.delete('tenantId');

  const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
  await relayUpstream(res, response, correlationId);
}

function profileUpstreamPath(
  route: { businessId: string; businessVersion: string; profileName: string },
  suffix: string
): string {
  return (
    `/api/v1/admin/profiles/${encodeURIComponent(route.businessId)}` +
    `/${encodeURIComponent(route.businessVersion)}` +
    `/${encodeURIComponent(route.profileName)}` + suffix
  );
}

/**
 * `(business, version, name) -> profileId`, answered by the platform's OWN
 * resolution: the 0039 key-list route carries the profile id in its envelope
 * (the frozen ProfileDetailReadSchema does not — it is strict and publishes
 * only the write identity).
 *
 * null = the profile is not stored yet (the platform answers 404 rather than
 * an empty list), which is the one case the membership write must refuse.
 */
async function resolveProfileId(
  runtime: BffRuntimeConfig & { jsonBaseUrl: string },
  credential: string,
  route: { businessId: string; businessVersion: string; profileName: string },
  correlationId: string
): Promise<string | null> {
  const response = await callUpstream(runtime, new URL(profileUpstreamPath(route, '/api-keys'), runtime.jsonBaseUrl), {
    method: 'GET',
    credential,
    correlationId,
  });
  if (response.status !== 200) return null;
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null) return null;
  const profileId = (payload as { profileId?: unknown }).profileId;
  return typeof profileId === 'string' && profileId.length > 0 ? profileId : null;
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
