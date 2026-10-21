/**
 * PC-03 — `/api/v2/admin/profile-groups`.
 *
 * The v2 version scope is *profile-group configuration resolution and its
 * operations*, not every Orchestrator API. Every unrelated v1 route keeps its
 * existing contract.
 *
 * Authorization mirrors the v1 group plane exactly: a platform Admin bearer
 * for every mutation, `authorizeAuditTenantRead` for every read, and no
 * cookie/CSRF handling here — the Admin BFF (PC-08) owns the browser session,
 * and duplicating that in the service would create a second auth model.
 *
 * Grant ledgers: `POST /keys` and `.../revoke` REQUIRE `Idempotency-Key` (D-8)
 * and a current access version, and the issue response is the only place a raw
 * group key ever crosses the wire (`Cache-Control: no-store`).
 */
import {
  ProfileGroupFunctionCatalogSchema,
  ProfileGroupKeyIssueInputSchema,
  ProfileGroupKeyIssueResultSchema,
  ProfileGroupKeyRevokeInputSchema,
  ProfileGroupKeyRevokeResultSchema,
  ProfileGroupRollbackSchema,
  ProfileGroupV2SaveSchema,
  ProfileGroupV2ListSchema,
  ProfileGroupV2Schema,
} from '@du/contracts';
import { auditedMutation } from '../../modules/audit/audit';
import { authorizeAuditTenantRead, resolveAdminPrincipal, type AdminPrincipal } from '../../modules/admin-actions/rbac';
import { getBusinessFunctionCatalog } from '../../modules/admin-read/business-functions';
import {
  getProfileGroupV2,
  issueGroupKey,
  listProfileGroupsV2,
  revokeGroupGrant,
  rollbackProfileGroupV2,
  saveProfileGroupV2,
  type ProfileGroupActor,
} from '../../modules/profiles/profile-groups';
import { canonicalPayloadHash, executeIdempotent, readIdempotencyKey } from '../../modules/idempotency/idempotency';
import { hashKey } from './api-key-auth';
import { HttpError, zodIssuesToProblem } from '../errors';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/v2/admin/profile-groups';

/** Idempotency route ids — stable, because a marker is scoped by route. */
const ROUTE_ISSUE = 'POST /api/v2/admin/profile-groups/:groupId/keys';
const ROUTE_REVOKE = 'POST /api/v2/admin/profile-groups/:groupId/keys/:keyId/revoke';

type ProfileGroupV2Route =
  | { kind: 'list' }
  | { kind: 'catalog' }
  | { kind: 'group'; groupId: string }
  | { kind: 'rollback'; groupId: string }
  | { kind: 'keys'; groupId: string }
  | { kind: 'keyRevoke'; groupId: string; keyId: string };

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function matchProfileGroupV2Route(
  pathname: string,
  searchParams: URLSearchParams,
): ProfileGroupV2Route | null {
  if (pathname !== PREFIX && !pathname.startsWith(`${PREFIX}/`)) return null;
  if (pathname === PREFIX) return { kind: 'list' };

  const suffix = pathname.slice(PREFIX.length);
  // `catalog` MUST be matched before `/:groupId`, otherwise a group id pattern
  // would swallow the catalog path and answer 422 for a UUID-shaped segment.
  if (suffix === '/catalog') return { kind: 'catalog' };

  const rollback = /^\/([^/]+)\/rollback$/.exec(suffix);
  if (rollback) return { kind: 'rollback', groupId: decodeGroupId(rollback[1]!) };

  const revoke = /^\/([^/]+)\/keys\/([^/]+)\/revoke$/.exec(suffix);
  if (revoke) {
    return { kind: 'keyRevoke', groupId: decodeGroupId(revoke[1]!), keyId: decodeUuid(revoke[2]!, 'keyId') };
  }

  const keys = /^\/([^/]+)\/keys$/.exec(suffix);
  if (keys) return { kind: 'keys', groupId: decodeGroupId(keys[1]!) };

  const group = /^\/([^/]+)$/.exec(suffix);
  if (!group) {
    void searchParams;
    throw new HttpError(404, 'NOT_FOUND', 'profile group route was not found');
  }
  return { kind: 'group', groupId: decodeGroupId(group[1]!) };
}

function decodeGroupId(raw: string): string {
  return decodeUuid(raw, 'groupId');
}

function decodeUuid(raw: string, field: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw new HttpError(422, 'INVALID_SCHEMA', `${field} is not valid URL encoding`);
  }
  if (!UUID_RE.test(decoded)) throw new HttpError(422, 'INVALID_SCHEMA', `${field} must be a UUID`);
  return decoded;
}

function requirePrincipal(ctx: RouteContext): AdminPrincipal {
  const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
  if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'admin credential required');
  return principal;
}

function requirePlatform(ctx: RouteContext): AdminPrincipal {
  const principal = requirePrincipal(ctx);
  if (principal.role !== 'platform') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'profile-group mutations require platform Admin access');
  }
  return principal;
}

/**
 * The actor recorded on config revisions and root grants.
 *
 * The bearer plane carries no subject/issuer, so the actor is the stable role
 * string the rest of the admin ledger uses ('admin'), and `actorRole` carries
 * the authority. Never a credential.
 */
function actorOf(principal: AdminPrincipal): ProfileGroupActor {
  return { actor: 'admin', role: principal.role };
}

function parseBody<T>(
  schema: {
    safeParse(value: unknown):
      | { success: true; data: T }
      | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } };
  },
  value: unknown,
): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function assertNoQuery(ctx: RouteContext): void {
  if ([...ctx.searchParams.keys()].length > 0) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'this profile-group route does not accept query parameters');
  }
}

/**
 * `If-Match` access-version transport (D9): accept `7` and `"7"`, reject a weak
 * validator and a wildcard. A missing header is 428; a stale one is 412.
 */
export function parseAccessVersion(
  raw: string | undefined,
): { ok: true; version: number } | { ok: false; reason: 'missing' | 'malformed' } {
  if (raw === undefined || raw.trim() === '') return { ok: false, reason: 'missing' };
  const trimmed = raw.trim();
  if (/^W\//i.test(trimmed)) return { ok: false, reason: 'malformed' };
  const unquoted = trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
  if (!/^[1-9]\d*$/.test(unquoted)) return { ok: false, reason: 'malformed' };
  const version = Number(unquoted);
  if (!Number.isSafeInteger(version)) return { ok: false, reason: 'malformed' };
  return { ok: true, version };
}

function requireAccessVersion(ctx: RouteContext): number {
  const parsed = parseAccessVersion(ctx.headers['if-match'] as string | undefined);
  if (!parsed.ok) {
    if (parsed.reason === 'missing') {
      throw new HttpError(428, 'PRECONDITION_REQUIRED', 'If-Match with the current access version is required');
    }
    throw new HttpError(400, 'INVALID_SCHEMA', 'If-Match must be the current access version');
  }
  return parsed.version;
}

function requireIdempotencyKey(ctx: RouteContext): string {
  const key = readIdempotencyKey(ctx.headers);
  if (key === undefined) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'Idempotency-Key is required for profile-group key grant mutations');
  }
  return key;
}

export async function handleAdminProfileGroupsV2Routes(ctx: RouteContext): Promise<RouteResult | null> {
  const route = matchProfileGroupV2Route(ctx.pathname, ctx.searchParams);
  if (!route) return null;
  const method = ctx.method.toUpperCase();

  if (route.kind === 'catalog') {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'business function catalog accepts GET only');
    const principal = requirePlatform(ctx);
    for (const key of ctx.searchParams.keys()) {
      if (key !== 'businessId' && key !== 'businessVersion' && key !== 'tenantId') {
        throw new HttpError(422, 'INVALID_SCHEMA', `unsupported catalog query parameter: ${key}`);
      }
    }
    for (const key of ['businessId', 'businessVersion', 'tenantId']) {
      if (ctx.searchParams.getAll(key).length > 1) {
        throw new HttpError(422, 'INVALID_SCHEMA', `catalog query parameter ${key} must not be repeated`);
      }
    }
    const businessId = ctx.searchParams.get('businessId');
    const businessVersion = ctx.searchParams.get('businessVersion');
    if (!businessId || !businessVersion) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'businessId and businessVersion are required');
    }
    // Wave3-F4 follow-up: an optional tenant pins each manifest WORKFLOW action
    // to that tenant's ACTIVE revision. It does not widen access — the catalog
    // stays platform-scoped, and the requested tenant goes through the same
    // read gate as every other tenant-scoped Admin read.
    const requestedTenant = ctx.searchParams.get('tenantId');
    if (requestedTenant !== null && requestedTenant.trim() === '') {
      throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must be a non-empty string');
    }
    const tenantId = requestedTenant === null ? undefined : authorizeAuditTenantRead(principal, requestedTenant);
    const catalog = await getBusinessFunctionCatalog(
      ctx.db,
      businessId,
      businessVersion,
      tenantId === undefined ? undefined : { tenantId },
    );
    return { status: 200, body: ProfileGroupFunctionCatalogSchema.parse(catalog) };
  }

  if (route.kind === 'list') {
    if (method !== 'GET' && method !== 'POST') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'profile groups accept GET or POST');
    }
    if (method === 'GET') {
      for (const key of ctx.searchParams.keys()) {
        if (key !== 'tenantId') throw new HttpError(422, 'INVALID_SCHEMA', `unsupported profile-group query parameter: ${key}`);
      }
      if (ctx.searchParams.getAll('tenantId').length > 1) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must not be repeated');
      }
      const tenantId = authorizeAuditTenantRead(requirePrincipal(ctx), ctx.searchParams.get('tenantId') ?? '');
      if (!tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required for platform profile-group listing');
      return { status: 200, body: ProfileGroupV2ListSchema.parse(await listProfileGroupsV2(ctx.db, tenantId)) };
    }

    const principal = requirePlatform(ctx);
    assertNoQuery(ctx);
    const input = parseBody(ProfileGroupV2SaveSchema, ctx.body);
    if (!input.tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required when creating a profile group');
    const actor = actorOf(principal);
    const saved = await auditedMutation(
      ctx.db,
      ctx.audit,
      (client) => saveProfileGroupV2(client, ctx.profiles, ctx.connectorManagement, input, null, actor),
      (group) => ({
        tenantId: group.tenantId,
        actor: actor.actor,
        actorRole: actor.role,
        action: 'profile_group.create',
        resource: `profile-group:${group.groupId}@rev${group.revision}`,
        severity: 'success',
        correlationId: ctx.correlationId,
      }),
    );
    return { status: 201, body: ProfileGroupV2Schema.parse(saved) };
  }

  if (route.kind === 'group') {
    if (method === 'GET') {
      for (const key of ctx.searchParams.keys()) {
        if (key !== 'tenantId') throw new HttpError(422, 'INVALID_SCHEMA', `unsupported profile-group query parameter: ${key}`);
      }
      if (ctx.searchParams.getAll('tenantId').length > 1) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must not be repeated');
      }
      const principal = requirePrincipal(ctx);
      const tenantId = authorizeAuditTenantRead(principal, ctx.searchParams.get('tenantId') ?? '');
      const group = ProfileGroupV2Schema.parse(
        await getProfileGroupV2(ctx.db, route.groupId, tenantId || undefined),
      );
      return {
        status: 200,
        body: group,
        headers: { etag: `"${group.accessVersion}"` },
      };
    }
    if (method !== 'PUT') {
      throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'profile-group reads use GET and full replacement uses PUT');
    }
    const principal = requirePlatform(ctx);
    assertNoQuery(ctx);
    const input = parseBody(ProfileGroupV2SaveSchema, ctx.body);
    const actor = actorOf(principal);
    const saved = await auditedMutation(
      ctx.db,
      ctx.audit,
      (client) => saveProfileGroupV2(client, ctx.profiles, ctx.connectorManagement, input, route.groupId, actor),
      (group) => ({
        tenantId: group.tenantId,
        actor: actor.actor,
        actorRole: actor.role,
        action: 'profile_group.replace',
        resource: `profile-group:${group.groupId}@rev${group.revision}`,
        severity: 'success',
        correlationId: ctx.correlationId,
      }),
    );
    return {
      status: 200,
      body: ProfileGroupV2Schema.parse(saved),
      headers: { etag: `"${saved.accessVersion}"` },
    };
  }

  if (route.kind === 'rollback') {
    if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'profile-group rollback accepts POST only');
    const principal = requirePlatform(ctx);
    assertNoQuery(ctx);
    const input = parseBody(ProfileGroupRollbackSchema, ctx.body);
    const actor = actorOf(principal);
    const rolledBack = await auditedMutation(
      ctx.db,
      ctx.audit,
      (client) => rollbackProfileGroupV2(client, ctx.profiles, ctx.connectorManagement, route.groupId, input, actor),
      (group) => ({
        tenantId: group.tenantId,
        actor: actor.actor,
        actorRole: actor.role,
        action: 'profile_group.rollback',
        resource: `profile-group:${group.groupId}@rev${group.revision}`,
        severity: 'warning',
        correlationId: ctx.correlationId,
      }),
    );
    return {
      status: 200,
      body: ProfileGroupV2Schema.parse(rolledBack),
      headers: { etag: `"${rolledBack.accessVersion}"` },
    };
  }

  if (route.kind === 'keys') {
    if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'group key issue requires POST');
    const principal = requirePlatform(ctx);
    assertNoQuery(ctx);
    const input = parseBody(ProfileGroupKeyIssueInputSchema, ctx.body);
    const idempotencyKey = requireIdempotencyKey(ctx);
    const accessVersion = requireAccessVersion(ctx);
    const actor = actorOf(principal);
    const outcome = await executeIdempotent(
      ctx.db,
      { key: idempotencyKey, route: ROUTE_ISSUE, payloadHash: canonicalPayloadHash({ groupId: route.groupId, input }) },
      async (withMarker) => {
        const issued = await auditedMutation(
          ctx.db,
          ctx.audit,
          (client) => issueGroupKey(
            client,
            { hashApiKey: hashKey },
            route.groupId,
            input,
            actor,
            accessVersion,
          ),
          (result) => ({
            tenantId: result.tenantId,
            actor: actor.actor,
            actorRole: actor.role,
            action: 'profile_group.grant.issue',
            resource: `profile-group:${route.groupId}/apikey:${result.grant.apiKeyId}`,
            severity: 'success',
            correlationId: ctx.correlationId,
          }),
          async (client, result) => {
            // D-5: the marker must never carry the raw secret. Store the
            // redacted shape, so a replayed issue response cannot re-emit a
            // credential that was designed to leave the platform exactly once.
            await withMarker(client, {
              status: 201,
              body: { grant: result.grant, secretAvailable: false },
            });
          },
        );
        return {
          status: 201,
          body: { grant: issued.grant, secret: issued.secret, secretAvailable: true },
        };
      },
    );
    return {
      status: outcome.status,
      body: ProfileGroupKeyIssueResultSchema.parse(outcome.body),
      headers: {
        'cache-control': 'no-store',
        ...(outcome.replayed ? { 'idempotent-replay': 'true' } : {}),
      },
    };
  }

  // route.kind === 'keyRevoke'
  if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'group key revoke requires POST');
  const principal = requirePlatform(ctx);
  assertNoQuery(ctx);
  const input = parseBody(ProfileGroupKeyRevokeInputSchema, ctx.body);
  const idempotencyKey = requireIdempotencyKey(ctx);
  const actor = actorOf(principal);
  const outcome = await executeIdempotent(
    ctx.db,
    {
      key: idempotencyKey,
      route: ROUTE_REVOKE,
      payloadHash: canonicalPayloadHash({ groupId: route.groupId, keyId: route.keyId, input }),
    },
    async (withMarker) => {
      const revoked = await auditedMutation(
        ctx.db,
        ctx.audit,
        (client) => revokeGroupGrant(client, route.groupId, route.keyId, input, actor),
        (result) => ({
          tenantId: result.tenantId,
          actor: actor.actor,
          actorRole: actor.role,
          action: 'profile_group.grant.revoke',
          resource: `profile-group:${route.groupId}/apikey:${route.keyId}`,
          severity: 'warning',
          correlationId: ctx.correlationId,
        }),
        async (client, result) => {
          await withMarker(client, {
            status: 200,
            body: { grant: result.grant, accessVersion: result.accessVersion },
          });
        },
      );
      return { status: 200, body: { grant: revoked.grant, accessVersion: revoked.accessVersion } };
    },
  );
  return {
    status: outcome.status,
    body: ProfileGroupKeyRevokeResultSchema.parse(outcome.body),
    ...(outcome.replayed ? { headers: { 'idempotent-replay': 'true' } } : {}),
  };
}
