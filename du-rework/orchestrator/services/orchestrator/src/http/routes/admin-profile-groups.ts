import {
  ProfileGroupFunctionCatalogSchema,
  ProfileGroupRollbackSchema,
  ProfileGroupSaveSchema,
} from '@du/contracts';
import { auditedMutation } from '../../modules/audit/audit';
import { authorizeAuditTenantRead, resolveAdminPrincipal } from '../../modules/admin-actions/rbac';
import { getBusinessFunctionCatalog } from '../../modules/admin-read/business-functions';
import {
  assertLegacyGroupWriteAllowed,
  getProfileGroup,
  listProfileGroups,
  rollbackProfileGroup,
  saveProfileGroup,
} from '../../modules/profiles/profile-groups';
import { HttpError, zodIssuesToProblem } from '../errors';
import type { RouteContext, RouteResult } from '../route-context';

type ProfileGroupRoute =
  | { kind: 'list' }
  | { kind: 'create' }
  | { kind: 'group'; groupId: string }
  | { kind: 'rollback'; groupId: string }
  | { kind: 'functions'; businessId: string; version: string };

function decodeSegment(value: string, field: string): string {
  let decoded: string;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    throw new HttpError(422, 'INVALID_SCHEMA', `${field} is not valid URL encoding`);
  }
  if (!decoded || decoded.includes('/') || /[\u0000-\u001f\u007f]/.test(decoded)) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${field} is invalid`);
  }
  return decoded;
}

function match(pathname: string): ProfileGroupRoute | null {
  if (pathname === '/api/v1/admin/profile-groups') return { kind: 'list' };
  const functions = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/functions$/.exec(pathname);
  if (functions) {
    return {
      kind: 'functions',
      businessId: decodeSegment(functions[1]!, 'businessId'),
      version: decodeSegment(functions[2]!, 'version'),
    };
  }
  const rollback = /^\/api\/v1\/admin\/profile-groups\/([^/]+)\/rollback$/.exec(pathname);
  if (rollback) return { kind: 'rollback', groupId: decodeSegment(rollback[1]!, 'groupId') };
  const group = /^\/api\/v1\/admin\/profile-groups\/([^/]+)$/.exec(pathname);
  if (!group) return null;
  const groupId = decodeSegment(group[1]!, 'groupId');
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(groupId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'groupId must be a UUID');
  }
  return { kind: 'group', groupId };
}

function assertNoQuery(ctx: RouteContext): void {
  if ([...ctx.searchParams.keys()].length > 0) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'this profile-group route does not accept query parameters');
  }
}

function requirePlatform(ctx: RouteContext) {
  const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
  if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'admin credential required');
  if (principal.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'profile-group mutations require platform Admin access');
  return principal;
}

function requirePrincipal(ctx: RouteContext) {
  const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
  if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'admin credential required');
  return principal;
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

/** Dedicated admin route leaf; `admin.ts` owns the shared dispatch table. */
export async function handleAdminProfileGroupsRoute(ctx: RouteContext): Promise<RouteResult | null> {
  const route = match(ctx.pathname);
  if (!route) return null;
  const method = ctx.method.toUpperCase();

  if (route.kind === 'functions') {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'business function catalog accepts GET only');
    assertNoQuery(ctx);
    requirePlatform(ctx);
    const catalog = await getBusinessFunctionCatalog(ctx.db, route.businessId, route.version);
    return { status: 200, body: ProfileGroupFunctionCatalogSchema.parse(catalog) };
  }

  if (route.kind === 'list') {
    if (method !== 'GET' && method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'profile groups accept GET or POST');
    if (method === 'GET') {
      for (const key of ctx.searchParams.keys()) if (key !== 'tenantId') throw new HttpError(422, 'INVALID_SCHEMA', `unsupported profile-group query parameter: ${key}`);
      if (ctx.searchParams.getAll('tenantId').length > 1) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must not be repeated');
      const requestedTenant = ctx.searchParams.get('tenantId') ?? '';
      const tenantId = authorizeAuditTenantRead(requirePrincipal(ctx), requestedTenant);
      if (!tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required for platform profile-group listing');
      return { status: 200, body: await listProfileGroups(ctx.db, tenantId) };
    }

    const principal = requirePlatform(ctx);
    const input = parseBody(ProfileGroupSaveSchema, ctx.body);
    if (!input.tenantId) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required when creating a profile group');
    const saved = await auditedMutation(
      ctx.db,
      ctx.audit,
      (client) => saveProfileGroup(client, ctx.profiles, ctx.connectorManagement, input, null),
      (group) => ({
        tenantId: group.tenantId,
        actor: 'admin',
        actorRole: principal.role,
        action: 'profile_group.create',
        resource: `profile-group:${group.groupId}@rev${group.revision}`,
        severity: 'success',
        correlationId: ctx.correlationId,
      }),
    );
    return { status: 201, body: saved };
  }

  if (route.kind === 'group') {
    if (method === 'GET') {
      for (const key of ctx.searchParams.keys()) if (key !== 'tenantId') throw new HttpError(422, 'INVALID_SCHEMA', `unsupported profile-group query parameter: ${key}`);
      if (ctx.searchParams.getAll('tenantId').length > 1) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must not be repeated');
      const principal = requirePrincipal(ctx);
      const requestedTenant = ctx.searchParams.get('tenantId') ?? '';
      const tenantId = authorizeAuditTenantRead(principal, requestedTenant);
      return { status: 200, body: await getProfileGroup(ctx.db, route.groupId, tenantId || undefined) };
    }
    if (method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'profile-group reads use GET and full replacement uses PUT');
    assertNoQuery(ctx);
    const principal = requirePlatform(ctx);
    // PC-03 firewall: refuse a converted group BEFORE the strict v1 body parse,
    // so a GROUP_GRANT cohort gets `409 PROFILE_GROUP_V2_REQUIRED` instead of a
    // 422 about the mandatory singular `apiKey` the v2 client never sends.
    await assertLegacyGroupWriteAllowed(ctx.db, { groupId: route.groupId });
    const input = parseBody(ProfileGroupSaveSchema, ctx.body);
    const saved = await auditedMutation(
      ctx.db,
      ctx.audit,
      (client) => saveProfileGroup(client, ctx.profiles, ctx.connectorManagement, input, route.groupId),
      (group) => ({
        tenantId: group.tenantId,
        actor: 'admin',
        actorRole: principal.role,
        action: 'profile_group.replace',
        resource: `profile-group:${group.groupId}@rev${group.revision}`,
        severity: 'success',
        correlationId: ctx.correlationId,
      }),
    );
    return { status: 200, body: saved };
  }

  if (route.kind === 'rollback') {
    if (method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'profile-group rollback accepts POST only');
    assertNoQuery(ctx);
    const principal = requirePlatform(ctx);
    await assertLegacyGroupWriteAllowed(ctx.db, { groupId: route.groupId });
    const input = parseBody(ProfileGroupRollbackSchema, ctx.body);
    const rolledBack = await auditedMutation(
      ctx.db,
      ctx.audit,
      (client) => rollbackProfileGroup(client, ctx.profiles, ctx.connectorManagement, route.groupId, input),
      (group) => ({
        tenantId: group.tenantId,
        actor: 'admin',
        actorRole: principal.role,
        action: 'profile_group.rollback',
        resource: `profile-group:${group.groupId}@rev${group.revision}`,
        severity: 'warning',
        correlationId: ctx.correlationId,
      }),
    );
    return { status: 200, body: rolledBack };
  }

  return null;
}
