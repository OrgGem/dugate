import { z } from 'zod';
import {
  ApiKeyIssueSchema,
  ApiKeyNoteSchema,
  ApiKeyRotateSchema,
  ConnectorDraftUpsertSchema,
  ConnectorParityRetirementRequestSchema,
  IdentityAssignmentReplaceSchema,
  IdentityPasswordResetSchema,
  ProviderTestRequestSchema,
  TenantActiveConnectorCatalogQuerySchema,
  TenantConnectorRecipeCatalogPageSchema,
  TenantConnectorRecipeCatalogQuerySchema,
  isTenantUuid,
} from '@du/contracts';
import { HttpError, zodIssuesToProblem } from '../errors';
import { resolveAdminActionAuthAsync, type AdminActionAuth, type AdminPrincipal } from '../../modules/admin-actions/rbac';
import { createAdminIdentityService, type IdentityActor } from '../../modules/identity/service';
import { createApiKeyLifecycleService } from '../../modules/identity/api-keys';
import { runConnectorProviderTest } from '../../modules/connectors/provider-test';
import type { ApiKeyActor } from '../../modules/identity/api-keys';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/parity';
const UUID = z.string().uuid();
const TENANT_UUID = z.string().refine(isTenantUuid, 'tenantId must use canonical UUID syntax');
const PAGE_QUERY = new Set(['tenantId', 'query', 'cursor', 'limit', 'status']);

type ParityAuth = {
  kind: 'platform' | 'tenant' | 'local-user' | 'viewer';
  tenantId: string | null;
  actor: string;
  actorRole: string;
  issuer?: string;
  sub?: string;
  cookie: boolean;
  csrfOk: boolean;
  raw: AdminActionAuth;
};

async function resolveAuth(ctx: RouteContext): Promise<ParityAuth> {
  const hasShellCookie = /(?:^|;\s*)(?:du_session|du_admin)=/.test(ctx.headers.cookie ?? '');
  const headers = hasShellCookie ? { ...ctx.headers, authorization: undefined } : ctx.headers;
  const auth = await resolveAdminActionAuthAsync(ctx.config, headers, ctx.config.adminSessionStore);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  if (auth.kind === 'bearer') {
    const principal: AdminPrincipal = auth.principal;
    return {
      kind: principal.role === 'platform' ? 'platform' : 'tenant',
      tenantId: principal.role === 'tenant_operator' ? principal.tenantId : null,
      actor: principal.role === 'platform' ? 'platform-token' : 'tenant-operator',
      actorRole: principal.role,
      cookie: false,
      csrfOk: true,
      raw: auth,
    };
  }
  if (auth.issuer === 'du-local' && auth.role === 'operator') return {
    kind: 'local-user', tenantId: auth.tenantId ?? null, actor: auth.principalId ?? 'local-user', actorRole: auth.role,
    issuer: auth.issuer, ...(auth.principalId ? { sub: auth.principalId } : {}), cookie: true, csrfOk: auth.csrfOk, raw: auth,
  };
  if (auth.role === 'admin') return {
    kind: 'platform', tenantId: null, actor: auth.principalId ?? 'admin-session', actorRole: auth.role,
    ...(auth.issuer ? { issuer: auth.issuer } : {}), ...(auth.principalId ? { sub: auth.principalId } : {}),
    cookie: true, csrfOk: auth.csrfOk, raw: auth,
  };
  if (auth.role === 'operator' && auth.tenantId) return {
    kind: 'tenant', tenantId: auth.tenantId, actor: auth.principalId ?? 'tenant-operator', actorRole: auth.role,
    ...(auth.issuer ? { issuer: auth.issuer } : {}), ...(auth.principalId ? { sub: auth.principalId } : {}),
    cookie: true, csrfOk: auth.csrfOk, raw: auth,
  };
  return {
    kind: 'viewer', tenantId: auth.tenantId ?? null, actor: auth.principalId ?? 'tenant-viewer', actorRole: auth.role,
    ...(auth.issuer ? { issuer: auth.issuer } : {}), ...(auth.principalId ? { sub: auth.principalId } : {}),
    cookie: true, csrfOk: auth.csrfOk, raw: auth,
  };
}

function requireRead(auth: ParityAuth): void {
  if (auth.kind === 'viewer' || auth.kind === 'local-user') throw new HttpError(403, 'PERMISSION_DENIED', 'this session is read-only outside assigned Provider Tests and operations');
}

function requireWrite(ctx: RouteContext, auth: ParityAuth, tenantId: string): void {
  if (auth.cookie && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  if (auth.kind !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'platform Admin access is required for identity, API-key and Connector changes');
  if (auth.tenantId !== null && auth.tenantId !== tenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');
  void ctx;
}

function scopedTenant(auth: ParityAuth, requested: string | null, canonicalUuid = false): string {
  if (auth.kind === 'viewer') throw new HttpError(403, 'PERMISSION_DENIED', 'this session has no administrative scope');
  if (auth.kind === 'tenant' || auth.kind === 'local-user') {
    if (!auth.tenantId) throw new HttpError(403, 'PERMISSION_DENIED', 'tenant scope is unavailable');
    if (!isTenantUuid(auth.tenantId)) throw new HttpError(403, 'PERMISSION_DENIED', 'tenant scope is unavailable');
    const scopedTenantId = canonicalUuid ? auth.tenantId.toLowerCase() : auth.tenantId;
    const requestedTenantId = canonicalUuid && isTenantUuid(requested) ? requested.toLowerCase() : requested;
    if (requestedTenantId && requestedTenantId !== scopedTenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');
    return scopedTenantId;
  }
  const tenantId = requested;
  if (!isTenantUuid(tenantId)) throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required and must be a UUID');
  return canonicalUuid ? tenantId.toLowerCase() : tenantId;
}

function actorForIdentity(auth: ParityAuth): IdentityActor {
  if (auth.kind !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'Identity administration requires platform Admin access');
  return { actor: auth.actor, role: 'ADMIN', ...(auth.issuer ? { issuer: auth.issuer } : {}), ...(auth.sub ? { sub: auth.sub } : {}) };
}

function actorForKey(auth: ParityAuth, correlationId: string): ApiKeyActor {
  if (auth.kind !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'API-key administration requires platform Admin access');
  return { actor: auth.actor, role: 'ADMIN', ...(auth.issuer ? { issuer: auth.issuer } : {}), ...(auth.sub ? { sub: auth.sub } : {}), correlationId };
}

function queryValues(ctx: RouteContext, allow: Set<string>): Record<string, string> {
  const result: Record<string, string> = {};
  for (const [key, value] of ctx.searchParams.entries()) {
    if (!allow.has(key) || Object.hasOwn(result, key)) throw new HttpError(422, 'INVALID_SCHEMA', 'request contains an unsupported or repeated query parameter');
    result[key] = value;
  }
  return result;
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

function parseLimit(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  if (!/^\d{1,3}$/.test(value)) throw new HttpError(422, 'INVALID_SCHEMA', 'limit must be an integer');
  const limit = Number(value);
  if (limit < 1 || limit > 250) throw new HttpError(422, 'INVALID_SCHEMA', 'limit must be 1..250');
  return limit;
}

export async function handleInternalParityRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const auth = await resolveAuth(ctx);
  const suffix = ctx.pathname.slice(PREFIX.length) || '/';
  const identity = ctx.identity ?? createAdminIdentityService({ db: ctx.db, audit: ctx.audit,
    auth: { mode: 'unmanaged', localEnabled: false, oidc: null } });

  if (suffix === '/provider-tests') {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'provider tests require POST');
    if (auth.cookie && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
    if (auth.kind !== 'platform' && auth.kind !== 'local-user') throw new HttpError(403, 'PERMISSION_DENIED', 'provider tests require platform Admin or an assigned local USER');
    const input = parseBody(ProviderTestRequestSchema, ctx.body);
    const tenantId = scopedTenant(auth, input.tenantId);
    if (tenantId !== input.tenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');
    return { status: 200, body: await runConnectorProviderTest(ctx, auth.raw, input) };
  }

  if (suffix === '/tenant-connectors') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'tenant Connector catalog requires GET');
    requireRead(auth);
    const values = queryValues(ctx, new Set(['tenantId', 'q', 'cursor', 'limit']));
    const tenantId = scopedTenant(auth, values.tenantId ?? null);
    const parsed = TenantActiveConnectorCatalogQuerySchema.safeParse({
      tenantId,
      ...(values.q === undefined ? {} : { q: values.q }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      ...(values.limit === undefined ? {} : { limit: values.limit }),
    });
    if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
    if (!ctx.connectorManagement) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Connector management is not configured');
    const page = await ctx.connectorManagement.listActiveRecipeRevisions(parsed.data);
    if (page.tenantId !== tenantId || page.items.some((item) => item.tenantId !== tenantId)) {
      throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Connector catalog returned data outside the current tenant scope');
    }
    return { status: 200, body: page };
  }

  if (suffix === '/typed-connector-recipes') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'typed Connector catalog requires GET');
    requireRead(auth);
    const values = queryValues(ctx, new Set(['tenantId', 'q', 'cursor', 'limit']));
    const tenantId = scopedTenant(auth, values.tenantId ?? null, true);
    const parsed = TenantConnectorRecipeCatalogQuerySchema.safeParse({
      tenantId,
      ...(values.q === undefined ? {} : { q: values.q }),
      ...(values.cursor === undefined ? {} : { cursor: values.cursor }),
      ...(values.limit === undefined ? {} : { limit: values.limit }),
    });
    if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
    if (!ctx.connectorManagement) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Connector management is not configured');
    const result = await ctx.connectorManagement.listConnectorRecipeCatalog(parsed.data);
    const page = TenantConnectorRecipeCatalogPageSchema.safeParse(result);
    if (!page.success || page.data.tenantId !== parsed.data.tenantId || page.data.limit !== parsed.data.limit
      || page.data.items.some((item) => item.tenantId !== parsed.data.tenantId)) {
      throw new HttpError(502, 'CONNECTOR_API_ERROR', 'Typed Connector catalog returned data outside the current tenant scope');
    }
    return { status: 200, body: page.data };
  }

  const chain = /^\/connectors\/([^/]+)\/chain$/.exec(suffix);
  if (chain) {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'tenant Connector chain lookup requires GET');
    requireRead(auth);
    const values = queryValues(ctx, new Set(['tenantId']));
    const tenantId = scopedTenant(auth, values.tenantId ?? null);
    let connectorId: string;
    try { connectorId = decodeURIComponent(chain[1] ?? ''); }
    catch { throw new HttpError(422, 'INVALID_SCHEMA', 'tenant Connector chain scope is invalid'); }
    if (!tenantId || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(connectorId)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'tenant Connector chain scope is invalid');
    }
    if (!ctx.connectorManagement) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'Connector management is not configured');
    return { status: 200, body: { hasTypedChain: await ctx.connectorManagement.hasRecipeChain({ tenantId, connectorId }) } };
  }

  if (suffix === '/identity/platform-assignable-users') {
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'platform identity lookup requires GET');
    if (auth.kind !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'platform owner lookup requires platform Admin access');
    const values = queryValues(ctx, new Set(['query', 'cursor', 'limit']));
    return { status: 200, body: await identity.searchAssignablePlatformIdentityUsers({ query: values.query, cursor: values.cursor, limit: parseLimit(values.limit) }) };
  }

  if (suffix === '/identity' || suffix === '/identity/users' || suffix === '/identity/assignable-users') {
    requireRead(auth);
    const values = queryValues(ctx, PAGE_QUERY);
    const tenantId = scopedTenant(auth, values.tenantId ?? null);
    if (suffix === '/identity' && ctx.method === 'GET') return { status: 200, body: await identity.snapshot(tenantId) };
    if (suffix === '/identity/users' && ctx.method === 'GET') {
      return { status: 200, body: await identity.listUsers({ tenantId, query: values.query, cursor: values.cursor, limit: parseLimit(values.limit) }) };
    }
    if (suffix === '/identity/assignable-users' && ctx.method === 'GET') {
      return { status: 200, body: await identity.searchAssignableIdentityUsers({ tenantId, query: values.query, cursor: values.cursor, limit: parseLimit(values.limit) }) };
    }
    if (suffix === '/identity/users' && ctx.method === 'POST') {
      if (Object.keys(values).some((key) => key !== 'tenantId')) throw new HttpError(422, 'INVALID_SCHEMA', 'identity creation query is invalid');
      requireWrite(ctx, auth, tenantId);
      const body = ctx.body as Record<string, unknown>;
      const parsed = z.object({ username: z.string().min(1).max(128), password: z.string().min(12).max(1024), role: z.enum(['ADMIN', 'USER', 'VIEWER']) }).strict().safeParse(body);
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      return { status: 201, body: { user: await identity.createUser({ tenantId, ...parsed.data }, actorForIdentity(auth)) } };
    }
    if (ctx.method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Identity read route requires GET');
    throw new HttpError(404, 'NOT_FOUND', 'Identity route was not found');
  }

  const identityUser = /^\/identity\/users\/([^/]+)(?:\/(password|assignments))?$/.exec(suffix);
  if (identityUser) {
    const userId = decodeUuid(identityUser[1] ?? '');
    const child = identityUser[2] ?? null;
    const values = queryValues(ctx, new Set(['tenantId']));
    const tenantId = scopedTenant(auth, values.tenantId ?? null);
    if (ctx.method === 'GET' && child === null) {
      requireRead(auth);
      const user = await identity.getUser({ tenantId, userId });
      if (!user) throw new HttpError(404, 'NOT_FOUND', 'identity was not found in this tenant');
      return { status: 200, body: { user } };
    }
    if (ctx.method === 'GET' && child === 'assignments') {
      requireRead(auth);
      const assignments = await identity.getAssignments(tenantId, userId);
      if (!assignments) throw new HttpError(404, 'NOT_FOUND', 'identity was not found in this tenant');
      return { status: 200, body: assignments };
    }
    requireWrite(ctx, auth, tenantId);
    const actor = actorForIdentity(auth);
    if (ctx.method === 'PATCH' && child === null) {
      const body = ctx.body as Record<string, unknown>;
      const parsed = z.object({ role: z.enum(['ADMIN', 'USER', 'VIEWER']), enabled: z.boolean(), expectedVersion: z.number().int().min(1) }).strict();
      const input = parseBody(parsed, body);
      const user = await identity.updateUser({ tenantId, userId, ...input }, actor);
      return { status: 200, body: { user } };
    }
    if (ctx.method === 'POST' && child === 'password') {
      const input = parseBody(IdentityPasswordResetSchema, ctx.body);
      const user = await identity.resetPassword({ tenantId, userId, ...input }, actor);
      return { status: 200, body: { user } };
    }
    if (ctx.method === 'PUT' && child === 'assignments') {
      const input = parseBody(IdentityAssignmentReplaceSchema, ctx.body);
      return { status: 200, body: await identity.replaceAssignments({ tenantId, userId, ...input }, actor) };
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Identity mutation route does not accept this method');
  }

  const keys = createApiKeyLifecycleService({ db: ctx.db, audit: ctx.audit });
  if (suffix === '/api-keys') {
    const values = queryValues(ctx, PAGE_QUERY);
    const tenantId = scopedTenant(auth, values.tenantId ?? null);
    if (ctx.method === 'GET') {
      requireRead(auth);
      return { status: 200, body: await keys.list({ tenantId, query: values.query, cursor: values.cursor, limit: parseLimit(values.limit),
        ...(values.status === 'ACTIVE' || values.status === 'REVOKED' ? { status: values.status } : {}) }) };
    }
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'API-key collection accepts GET or POST');
    if (values.status || values.cursor || values.limit || values.query) throw new HttpError(422, 'INVALID_SCHEMA', 'API-key mutation query is invalid');
    requireWrite(ctx, auth, tenantId);
    const input = parseBody(ApiKeyIssueSchema, ctx.body);
    return { status: 201, body: await keys.issue({ tenantId, ...input }, actorForKey(auth, ctx.correlationId)) };
  }

  const keyMatch = /^\/api-keys\/([^/]+)(?:\/(rotate|revoke))?$/.exec(suffix);
  if (keyMatch) {
    const keyId = decodeUuid(keyMatch[1] ?? '');
    const action = keyMatch[2] ?? null;
    const values = queryValues(ctx, new Set(['tenantId']));
    const tenantId = scopedTenant(auth, values.tenantId ?? null);
    if (ctx.method !== 'PATCH' && ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'API-key mutation route requires PATCH or POST');
    requireWrite(ctx, auth, tenantId);
    const actor = actorForKey(auth, ctx.correlationId);
    if (ctx.method === 'PATCH' && action === null) {
      const input = parseBody(ApiKeyNoteSchema, ctx.body);
      return { status: 200, body: await keys.updateNote({ tenantId, keyId, ...input }, actor) };
    }
    if (ctx.method === 'POST' && action === 'rotate') {
      const input = parseBody(ApiKeyRotateSchema, ctx.body);
      return { status: 200, body: await keys.rotate({ tenantId, keyId, ...input }, actor) };
    }
    if (ctx.method === 'POST' && action === 'revoke') {
      const input = parseBody(z.object({ expectedVersion: z.number().int().min(1) }).strict(), ctx.body);
      return { status: 200, body: await keys.revoke({ tenantId, keyId, ...input }, actor) };
    }
    throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'API-key route does not accept this method');
  }

  if (suffix.startsWith('/connectors/')) return handleConnectorParity(ctx, suffix, auth);
  throw new HttpError(404, 'NOT_FOUND', 'parity route was not found');
}

async function handleConnectorParity(ctx: RouteContext, suffix: string, auth: ParityAuth): Promise<RouteResult> {
  const store = ctx.connectorManagement;
  if (!store) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'Connector management is unavailable');
  const revisionMatch = /^\/connectors\/([^/]+)\/revisions\/(\d+)$/.exec(suffix);
  const draftMatch = /^\/connectors\/([^/]+)\/draft$/.exec(suffix);
  const activateMatch = /^\/connectors\/([^/]+)\/revisions\/(\d+)\/activate$/.exec(suffix);
  const rollbackMatch = /^\/connectors\/([^/]+)\/rollback\/draft$/.exec(suffix);
  const retireMatch = /^\/connectors\/([^/]+)\/revisions\/(\d+)\/retire$/.exec(suffix);
  if (revisionMatch && ctx.method === 'GET') {
    requireRead(auth);
    const query = queryValues(ctx, new Set(['tenantId']));
    const tenantId = scopedTenant(auth, query.tenantId ?? null, true);
    const connectorId = decodeConnectorId(revisionMatch[1] ?? '');
    const revision = parseRevision(revisionMatch[2] ?? '');
    const result = await store.getRecipeRevision({ tenantId, connectorId, revision });
    if (!result) throw new HttpError(404, 'NOT_FOUND', 'Connector revision was not found in this tenant');
    return { status: 200, body: result };
  }
  if (draftMatch && ctx.method === 'PUT') {
    const body = parseBody(ConnectorDraftUpsertSchema, ctx.body);
    requireWrite(ctx, auth, body.tenantId);
    const connectorId = decodeConnectorId(draftMatch[1] ?? '');
    if (body.credentialChange.action === 'vault-ref') {
      if (!ctx.connectorSecretImports) {
        throw new HttpError(503, 'SECRET_IMPORT_UNAVAILABLE', 'Managed Secret Catalog import is unavailable for this Connector');
      }
      if (await store.secretCatalogImportAvailable?.(connectorId) !== true) {
        throw new HttpError(503, 'SECRET_IMPORT_UNAVAILABLE', 'Managed Secret Catalog import is unavailable for this Connector');
      }
      return {
        status: 200,
        body: await ctx.connectorSecretImports.importCredential(connectorId, body, {
          actor: auth.actor,
          role: 'platform',
          ...(auth.issuer ? { issuer: auth.issuer } : {}),
          ...(auth.sub ? { sub: auth.sub } : {}),
          correlationId: ctx.correlationId,
        }),
      };
    }
    return { status: 200, body: await store.upsertRecipeDraft({ ...body, connectorId }) };
  }
  if (activateMatch && ctx.method === 'POST') {
    const body = parseBody(z.object({ tenantId: TENANT_UUID, expectedCurrentRevision: z.number().int().min(0) }).strict(), ctx.body);
    requireWrite(ctx, auth, body.tenantId);
    return { status: 200, body: await store.activateRecipeRevision({ tenantId: body.tenantId,
      connectorId: decodeConnectorId(activateMatch[1] ?? ''), revision: parseRevision(activateMatch[2] ?? ''),
      expectedCurrentRevision: body.expectedCurrentRevision }) };
  }
  if (rollbackMatch && ctx.method === 'POST') {
    const body = parseBody(z.object({ tenantId: TENANT_UUID, sourceRevision: z.number().int().min(1), expectedHeadRevision: z.number().int().min(0), idempotencyKey: z.string().min(8).max(200) }).strict(), ctx.body);
    requireWrite(ctx, auth, body.tenantId);
    return { status: 201, body: await store.createRollbackRecipeDraft({ ...body, connectorId: decodeConnectorId(rollbackMatch[1] ?? '') }) };
  }
  if (retireMatch && ctx.method === 'POST') {
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'Connector retirement does not accept query parameters');
    const body = parseBody(ConnectorParityRetirementRequestSchema, ctx.body);
    requireWrite(ctx, auth, body.tenantId);
    const connectorId = decodeConnectorId(retireMatch[1] ?? '');
    const revision = parseRevision(retireMatch[2] ?? '');
    const target = await store.getRecipeRevision({ tenantId: body.tenantId, connectorId, revision });
    if (!target) throw new HttpError(404, 'NOT_FOUND', 'Connector revision was not found in this tenant');
    await assertConnectorRevisionUnreferenced(ctx, body.tenantId, connectorId, revision);
    return { status: 200, body: await store.retireRecipeRevision({ ...body, connectorId, revision }) };
  }
  throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'Connector parity route does not accept this method');
}

/** Existing immutable operations keep their accepted pins. Retirement only
 * proceeds when no active Profile, current tenant default, or nonterminal
 * operation still needs the revision. */
async function assertConnectorRevisionUnreferenced(
  ctx: RouteContext,
  tenantId: string,
  connectorId: string,
  revision: number,
): Promise<void> {
  const profileRefs = await ctx.db.query(
    `SELECT 1
       FROM profile_active_revisions a
       JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
      WHERE p.tenant_id=$1 AND p.enabled=true
        AND EXISTS (
          SELECT 1 FROM jsonb_each(COALESCE(p.connector_bindings,'{}'::jsonb)) binding
           WHERE binding.value->>'connectorId'=$2
             AND binding.value->>'revision'=$3
        )
      LIMIT 1`,
    [tenantId, connectorId, String(revision)],
  );
  if (profileRefs.rowCount) throw new HttpError(409, 'CONNECTOR_REVISION_REFERENCED', 'an active Profile still references this Connector revision');

  const operationRefs = await ctx.db.query(
    `SELECT 1
       FROM operations o
      WHERE o.tenant_id=$1 AND o.deleted_at IS NULL
        AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT','EXPIRED')
        AND EXISTS (
          SELECT 1 FROM jsonb_each(COALESCE(o.connector_bindings,'{}'::jsonb)) binding
           WHERE binding.value->>'connectorId'=$2
             AND binding.value->>'revision'=$3
        )
      LIMIT 1`,
    [tenantId, connectorId, String(revision)],
  );
  if (operationRefs.rowCount) throw new HttpError(409, 'CONNECTOR_REVISION_REFERENCED', 'an in-flight operation still references this Connector revision');

  // Tenant AI defaults are encrypted immutable snapshots. The public service
  // opens them with the real metadata crypto; inspecting raw payload_ref would
  // either miss references or create a second plaintext path.
  if (!ctx.globalSettings) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'tenant Connector reference checks are unavailable');
  const tenants = await ctx.db.query<{ id: string }>('SELECT id FROM tenants ORDER BY id LIMIT 1001');
  if (tenants.rows.length > 1000) throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'tenant Connector reference check exceeded its bounded scan');
  for (let offset = 0; offset < tenants.rows.length; offset += 32) {
    const batch = tenants.rows.slice(offset, offset + 32);
    const defaults = await Promise.all(batch.map((row) => ctx.globalSettings!.getTenantDefaultsSnapshot(row.id)));
    if (defaults.some((snapshot) => snapshot.ai.connectorId === connectorId && snapshot.ai.connectorRevision === revision)) {
      throw new HttpError(409, 'CONNECTOR_REVISION_REFERENCED', 'current tenant AI defaults still reference this Connector revision');
    }
  }
}

function decodeUuid(value: string): string {
  const parsed = UUID.safeParse(decodeSegment(value));
  if (!parsed.success) throw new HttpError(404, 'NOT_FOUND', 'resource was not found');
  return parsed.data;
}

function decodeConnectorId(value: string): string {
  const decoded = decodeSegment(value);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:@/-]{0,127}$/.test(decoded) || decoded.includes('..')) throw new HttpError(404, 'NOT_FOUND', 'Connector was not found');
  return decoded;
}

function decodeSegment(value: string): string {
  try {
    const decoded = decodeURIComponent(value);
    if (!decoded || decoded.length > 128 || decoded.includes('/') || decoded.includes('\\')) throw new Error();
    return decoded;
  } catch {
    throw new HttpError(404, 'NOT_FOUND', 'resource was not found');
  }
}

function parseRevision(value: string): number {
  if (!/^\d{1,9}$/.test(value)) throw new HttpError(404, 'NOT_FOUND', 'Connector revision was not found');
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new HttpError(404, 'NOT_FOUND', 'Connector revision was not found');
  return revision;
}
