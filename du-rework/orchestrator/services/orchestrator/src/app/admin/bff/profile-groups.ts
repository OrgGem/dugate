/** Same-origin profile-group and registered-function catalog BFF routes. */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { ProfileGroupListSchema, ProfileGroupSchema, type ProfileGroup } from '@du/contracts';
import type { AdminShellRequest } from '../shell-types';
import type { ShellRuntimeConfig } from '../shell-router';
import type { ProfileSelfServiceActor } from '../../../modules/profiles/self-service';
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
  writeJson,
  writeProblem,
  type BffRuntimeConfig,
} from './upstream';
import { isHttpError } from '../../../http/errors';

export type ProfileGroupsRoute =
  | { kind: 'list' }
  | { kind: 'group'; groupId: string }
  | { kind: 'rollback'; groupId: string }
  | { kind: 'functions'; businessId: string; version: string }
  | { kind: 'invalid' };

export function matchProfileGroupsRoute(relative: string): ProfileGroupsRoute | null {
  if (relative === '/profile-groups') return { kind: 'list' };
  const functions = /^\/businesses\/([^/]+)\/versions\/([^/]+)\/functions$/.exec(relative);
  if (functions) {
    const businessId = decodePathSegment(functions[1] ?? '');
    const version = decodePathSegment(functions[2] ?? '');
    return businessId === null || version === null
      ? { kind: 'invalid' }
      : { kind: 'functions', businessId, version };
  }
  const rollback = /^\/profile-groups\/([^/]+)\/rollback$/.exec(relative);
  if (rollback) {
    const groupId = decodePathSegment(rollback[1] ?? '');
    return groupId === null || !/^[0-9a-f-]{36}$/i.test(groupId)
      ? { kind: 'invalid' }
      : { kind: 'rollback', groupId };
  }
  const group = /^\/profile-groups\/([^/]+)$/.exec(relative);
  if (group) {
    const groupId = decodePathSegment(group[1] ?? '');
    return groupId === null || !/^[0-9a-f-]{36}$/i.test(groupId)
      ? { kind: 'invalid' }
      : { kind: 'group', groupId };
  }
  return null;
}

function isSingleQuery(query: URLSearchParams, allowed: readonly string[]): boolean {
  const seen = new Set<string>();
  for (const key of query.keys()) {
    if (!allowed.includes(key) || seen.has(key)) return false;
    seen.add(key);
  }
  return true;
}

function hasJsonBase(runtime: BffRuntimeConfig): runtime is BffRuntimeConfig & { jsonBaseUrl: string } {
  return typeof runtime.jsonBaseUrl === 'string' && runtime.jsonBaseUrl.length > 0;
}

function localUserSession(ctx: Awaited<ReturnType<typeof resolveBffContext>>): boolean {
  return ctx?.plane === 'oidc' && ctx.issuer === 'du-local' && ctx.role === 'operator';
}

function localProfileActor(ctx: NonNullable<Awaited<ReturnType<typeof resolveBffContext>>>): ProfileSelfServiceActor | null {
  if (ctx.plane !== 'oidc' || ctx.role !== 'operator' || ctx.issuer !== 'du-local'
      || ctx.principal.kind !== 'tenant_operator' || !ctx.tenantId
      || ctx.principal.tenantId !== ctx.tenantId || !/^[0-9a-f-]{36}$/i.test(ctx.tenantId)
      || !ctx.sub || !/^[0-9a-f-]{36}$/i.test(ctx.sub)
      || typeof ctx.roleVersion !== 'number' || !Number.isSafeInteger(ctx.roleVersion) || ctx.roleVersion < 1) return null;
  return { tenantId: ctx.tenantId, issuer: ctx.issuer, userId: ctx.sub, roleVersion: ctx.roleVersion };
}

async function localUserCanReadGroup(
  group: ProfileGroup,
  actor: ProfileSelfServiceActor,
  runtime: BffRuntimeConfig,
): Promise<boolean> {
  const canRead = runtime.profileSelfService?.canReadAssignedProfileGroup;
  if (typeof canRead !== 'function') return false;
  const profileIds = group.businesses.flatMap((business) => business.functions.map((fn) => fn.childProfileId));
  return canRead.call(runtime.profileSelfService, { profileIds, apiKeyId: group.apiKey.apiKeyId }, actor);
}

export async function handleProfileGroupsRoute(
  req: IncomingMessage,
  res: ServerResponse,
  request: AdminShellRequest,
  route: ProfileGroupsRoute,
  query: URLSearchParams,
  config: ShellRuntimeConfig,
  runtime: BffRuntimeConfig,
  correlationId: string,
): Promise<void> {
  if (route.kind === 'invalid') {
    writeProblem(res, 404, 'NOT_FOUND', 'no Profile Group route matches this request', correlationId);
    return;
  }
  const method = (req.method ?? 'GET').toUpperCase();
  const ctx = await resolveBffContext(config, request);
  if (!ctx) {
    writeProblem(res, 401, 'UNAUTHENTICATED', 'sign in to use the Admin API', correlationId);
    return;
  }
  if (ctx.principal.kind === 'unscoped') {
    writeProblem(res, 403, 'PROFILE_SCOPE_GATE', 'profile-group routes require a platform or tenant principal', correlationId);
    return;
  }

  const read = method === 'GET';
  const isLocalUser = localUserSession(ctx);
  const localActor = isLocalUser ? localProfileActor(ctx) : null;
  if (isLocalUser && !localActor) {
    writeProblem(res, 403, 'PROFILE_ASSIGNMENT_REQUIRED', 'the current local USER assignment is unavailable', correlationId);
    return;
  }
  if (isLocalUser && read && (route.kind === 'list' || route.kind === 'group')
      && typeof runtime.profileSelfService?.canReadAssignedProfileGroup !== 'function') {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'assignment-aware Profile Group reads are unavailable', correlationId);
    return;
  }

  if (route.kind === 'functions') {
    if (!read) {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'registered function catalog accepts GET only', correlationId);
      return;
    }
    if (query.size !== 0) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'registered function catalog does not accept query parameters', correlationId);
      return;
    }
    if (ctx.role !== 'admin' || ctx.principal.kind !== 'platform') {
      writeProblem(res, 403, 'ADMIN_CREDENTIAL_REQUIRED', 'registered business functions are platform-scoped', correlationId);
      return;
    }
  } else if (route.kind === 'list') {
    if (!read && method !== 'POST') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile groups accept GET or POST', correlationId);
      return;
    }
    if (read) {
      if (!isSingleQuery(query, ['tenantId'])) {
        writeProblem(res, 422, 'INVALID_SCHEMA', 'profile-group listing accepts one tenantId parameter', correlationId);
        return;
      }
    } else if (query.size !== 0) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'profile-group creation does not accept query parameters', correlationId);
      return;
    }
  } else if (route.kind === 'group') {
    if (!read && method !== 'PUT') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile group reads use GET and full replacement uses PUT', correlationId);
      return;
    }
    if (query.size !== 0) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'profile group detail does not accept query parameters', correlationId);
      return;
    }
  } else {
    if (method !== 'POST') {
      writeProblem(res, 405, 'METHOD_NOT_ALLOWED', 'profile-group rollback accepts POST only', correlationId);
      return;
    }
    if (query.size !== 0) {
      writeProblem(res, 422, 'INVALID_SCHEMA', 'profile-group rollback does not accept query parameters', correlationId);
      return;
    }
  }

  const mutation = method !== 'GET';
  if (mutation && isLocalUser) {
    writeProblem(res, 403, 'PROFILE_GROUP_ASSIGNMENT_REQUIRED', 'local USERs cannot create or edit Profile Groups; group-level assignment is not supported', correlationId);
    return;
  }
  if (mutation && (ctx.role !== 'admin' || ctx.principal.kind !== 'platform')) {
    writeProblem(res, 403, 'PROFILE_SCOPED_GATE', 'profile-group mutations require platform Admin access', correlationId);
    return;
  }
  if (mutation && !ctx.verifyCsrf(firstHeaderValue(req.headers['x-csrf-token']))) {
    writeProblem(res, 403, 'CSRF_REJECTED', 'missing or invalid CSRF proof', correlationId);
    return;
  }
  if (!hasJsonBase(runtime)) {
    writeProblem(res, 503, 'UPSTREAM_UNAVAILABLE', 'the admin API is not configured', correlationId);
    return;
  }
  const principal = ctx.principal;
  let tenantScope = '';
  if (read && route.kind !== 'functions') {
    try {
      tenantScope = authorizeAuditTenantRead(rbacPrincipal(principal), query.get('tenantId') ?? '');
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

  const credential = credentialFor(principal, runtime);
  if (credential === null) {
    writeProblem(res, 403, 'TENANT_SCOPE_UNAVAILABLE', 'no admin credential is configured for this principal', correlationId);
    return;
  }
  let upstream: URL;
  if (route.kind === 'functions') {
    upstream = new URL(`/api/v1/admin/businesses/${encodeURIComponent(route.businessId)}/versions/${encodeURIComponent(route.version)}/functions`, runtime.jsonBaseUrl);
  } else if (route.kind === 'list') {
    upstream = new URL('/api/v1/admin/profile-groups', runtime.jsonBaseUrl);
    if (read) upstream.searchParams.set('tenantId', tenantScope);
  } else if (route.kind === 'group') {
    upstream = new URL(`/api/v1/admin/profile-groups/${encodeURIComponent(route.groupId)}`, runtime.jsonBaseUrl);
    if (read && principal.kind === 'tenant_operator') upstream.searchParams.set('tenantId', tenantScope);
  } else {
    upstream = new URL(`/api/v1/admin/profile-groups/${encodeURIComponent(route.groupId)}/rollback`, runtime.jsonBaseUrl);
  }

  if (!mutation) {
    const response = await callUpstream(runtime, upstream, { method: 'GET', credential, correlationId });
    if (response.status === 200 && localActor && route.kind === 'list') {
      let body: unknown;
      try { body = await response.json(); } catch { body = null; }
      const parsed = ProfileGroupListSchema.safeParse(body);
      if (!parsed.success) {
        writeProblem(res, 502, 'INVALID_SCHEMA', 'admin API returned an invalid Profile Group list', correlationId);
        return;
      }
      const groups: ProfileGroup[] = [];
      for (const group of parsed.data.groups) {
        if (await localUserCanReadGroup(group, localActor, runtime)) groups.push(group);
      }
      writeJson(res, 200, { groups }, correlationId);
      return;
    }
    if (response.status === 200 && localActor && route.kind === 'group') {
      let body: unknown;
      try { body = await response.json(); } catch { body = null; }
      const parsed = ProfileGroupSchema.safeParse(body);
      if (!parsed.success) {
        writeProblem(res, 502, 'INVALID_SCHEMA', 'admin API returned an invalid Profile Group', correlationId);
        return;
      }
      if (!await localUserCanReadGroup(parsed.data, localActor, runtime)) {
        writeProblem(res, 404, 'NOT_FOUND', 'Profile Group was not found', correlationId);
        return;
      }
      writeJson(res, 200, parsed.data, correlationId);
      return;
    }
    await relayUpstream(res, response, correlationId);
    return;
  }

  const raw = await readBoundedBody(req);
  if (raw === null) {
    writeProblem(res, 413, 'PAYLOAD_TOO_LARGE', 'request body exceeds the Admin BFF limit', correlationId);
    return;
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be JSON', correlationId);
    return;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    writeProblem(res, 422, 'INVALID_SCHEMA', 'request body must be a JSON object', correlationId);
    return;
  }
  const response = await callUpstream(runtime, upstream, {
    method: method as 'POST' | 'PUT',
    credential,
    correlationId,
    jsonBody: JSON.stringify(body),
  });
  await relayUpstream(res, response, correlationId);
}
