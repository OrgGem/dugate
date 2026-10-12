import {
  GlobalSettingsPublishRequestSchema,
  GlobalSettingsRollbackRequestSchema,
  PlatformRetentionDraftRequestSchema,
  TenantAiDraftRequestSchema,
  TenantAiTestRequestSchema,
  TenantPromptDraftRequestSchema,
} from '@du/contracts';
import { HttpError, zodIssuesToProblem } from '../errors';
import { resolveAdminActionAuthAsync, type AdminActionAuth, type AdminPrincipal } from '../../modules/admin-actions/rbac';
import type { GlobalSettingsActor } from '../../modules/global-settings/service';
import { runConnectorProviderTest } from '../../modules/connectors/provider-test';
import type { RouteContext, RouteResult } from '../route-context';

const PREFIX = '/api/internal/global-settings';
const TENANT_QUERY = new Set(['tenantId']);

interface SettingsAuth {
  role: 'platform' | 'tenant_operator' | 'viewer' | 'none';
  tenantId: string | null;
  actor: GlobalSettingsActor;
  csrfRequired: boolean;
  csrfOk: boolean;
  raw: AdminActionAuth;
}

async function resolveSettingsAuth(ctx: RouteContext): Promise<SettingsAuth> {
  // A BFF request includes a server-validated shell cookie and CSRF proof.
  // Resolve that session as the principal so audit records retain the real
  // session actor; direct service callers with no shell cookie still use the
  // platform/tenant bearer policy.
  const hasShellCookie = /(?:^|;\s*)(?:du_session|du_admin)=/.test(ctx.headers.cookie ?? '');
  const headers = hasShellCookie ? { ...ctx.headers, authorization: undefined } : ctx.headers;
  const auth = await resolveAdminActionAuthAsync(ctx.config, headers, ctx.config.adminSessionStore);
  if (!auth) throw new HttpError(401, 'UNAUTHENTICATED', 'admin authentication is required');
  if (auth.kind === 'bearer') {
    const principal: AdminPrincipal = auth.principal;
    return {
      role: principal.role,
      tenantId: principal.role === 'tenant_operator' ? principal.tenantId : null,
      actor: { label: principal.role === 'platform' ? 'platform-token' : 'tenant-operator', role: principal.role },
      csrfRequired: false,
      csrfOk: true,
      raw: auth,
    };
  }
  const role = auth.role === 'admin' ? 'platform' : auth.role === 'operator' ? 'tenant_operator' : 'viewer';
  return {
    role,
      tenantId: auth.tenantId ?? null,
    actor: {
      label: auth.principalId ? `session:${auth.principalId}` : `shell:${auth.role}`,
      ...(auth.issuer ? { issuer: auth.issuer } : {}),
      ...(auth.principalId ? { sub: auth.principalId } : {}),
      role: auth.role,
    },
    csrfRequired: true,
    csrfOk: auth.csrfOk,
    raw: auth,
  };
}

function requireReadScope(auth: SettingsAuth, tenantId: string): void {
  if (auth.role === 'viewer' || auth.role === 'none') throw new HttpError(403, 'PERMISSION_DENIED', 'global settings require an Admin or tenant operator');
  if (auth.role === 'tenant_operator' && auth.tenantId !== tenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');
}

function requireMutation(auth: SettingsAuth, tenantId: string | null): void {
  if (auth.csrfRequired && !auth.csrfOk) throw new HttpError(403, 'CSRF_REJECTED', 'missing or invalid CSRF proof');
  if (auth.role === 'viewer' || auth.role === 'none') throw new HttpError(403, 'PERMISSION_DENIED', 'global settings are read-only for this session');
  if (tenantId === null && auth.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'platform settings require platform Admin access');
  if (tenantId !== null && auth.role === 'tenant_operator' && auth.tenantId !== tenantId) throw new HttpError(404, 'NOT_FOUND', 'not found');
}

function parseQuery(ctx: RouteContext): string {
  const values: Record<string, string> = {};
  for (const [key, value] of ctx.searchParams.entries()) {
    if (!TENANT_QUERY.has(key) || Object.hasOwn(values, key)) throw new HttpError(422, 'INVALID_SCHEMA', 'global settings query contains an unsupported or repeated parameter');
    values[key] = value;
  }
  const tenantId = values.tenantId;
  if (!tenantId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(tenantId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must be a UUID');
  }
  return tenantId;
}

function parseBody<T>(schema: { safeParse(value: unknown): { success: true; data: T } | { success: false; error: { issues: Array<{ path: (string | number)[]; message: string }> } } }, value: unknown): T {
  const parsed = schema.safeParse(value);
  if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
  return parsed.data;
}

export async function handleInternalGlobalSettingsRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  if (ctx.pathname !== PREFIX && !ctx.pathname.startsWith(`${PREFIX}/`)) return null;
  if (ctx.ingressAudience !== 'internal') throw new HttpError(404, 'NOT_FOUND', 'Not Found');
  const service = ctx.globalSettings;
  if (!service) throw new HttpError(503, 'SERVICE_UNAVAILABLE', 'global settings service is not configured');
  const auth = await resolveSettingsAuth(ctx);
  const suffix = ctx.pathname.slice(PREFIX.length) || '/';

  if (suffix === '/' && ctx.method === 'GET') {
    const tenantId = parseQuery(ctx);
    requireReadScope(auth, tenantId);
    return { status: 200, body: await service.readTenant(tenantId) };
  }
  if (suffix === '/retention' && ctx.method === 'GET') {
    if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'retention read does not accept query parameters');
    if (auth.role !== 'platform') throw new HttpError(403, 'PERMISSION_DENIED', 'platform settings require platform Admin access');
    return { status: 200, body: await service.readRetention() };
  }

  if (ctx.searchParams.size > 0) throw new HttpError(422, 'INVALID_SCHEMA', 'global settings mutations do not accept query parameters');
  const tenantMatch = /^\/tenants\/([^/]+)\/(ai|prompts)\/(draft|test|publish|rollback)$/.exec(suffix);
  if (tenantMatch) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'global settings mutations require POST');
    const tenantId = decodeTenant(tenantMatch[1] ?? '');
    requireMutation(auth, tenantId);
    const stream = tenantMatch[2] as 'ai' | 'prompts';
    const action = tenantMatch[3] as 'draft' | 'test' | 'publish' | 'rollback';
    if (action === 'draft') {
      if (stream === 'ai') {
        const input = parseBody(TenantAiDraftRequestSchema, ctx.body);
        return { status: 201, body: await service.createTenantAiDraft(tenantId, input, auth.actor) };
      }
      const input = parseBody(TenantPromptDraftRequestSchema, ctx.body);
      return { status: 201, body: await service.createTenantPromptDraft(tenantId, input, auth.actor) };
    }
    if (action === 'test') {
      if (stream !== 'ai') throw new HttpError(404, 'NOT_FOUND', 'prompt test is not a supported operation');
      const input = parseBody(TenantAiTestRequestSchema, ctx.body);
      return { status: 200, body: await service.testTenantAiRevision(
        tenantId,
        input,
        auth.actor,
        (providerRequest) => runConnectorProviderTest(ctx, auth.raw, providerRequest),
      ) };
    }
    if (action === 'publish') {
      const input = parseBody(GlobalSettingsPublishRequestSchema, ctx.body);
      return { status: 200, body: stream === 'ai'
        ? await service.publishTenantAiRevision(tenantId, input, auth.actor)
        : await service.publishTenantPromptRevision(tenantId, input, auth.actor) };
    }
    const input = parseBody(GlobalSettingsRollbackRequestSchema, ctx.body);
    return { status: 200, body: stream === 'ai'
      ? await service.rollbackTenantAiRevision(tenantId, input, auth.actor)
      : await service.rollbackTenantPromptRevision(tenantId, input, auth.actor) };
  }

  const retentionMatch = /^\/retention\/(draft|publish|rollback)$/.exec(suffix);
  if (retentionMatch) {
    if (ctx.method !== 'POST') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'retention mutations require POST');
    requireMutation(auth, null);
    const action = retentionMatch[1];
    if (action === 'draft') {
      const input = parseBody(PlatformRetentionDraftRequestSchema, ctx.body);
      return { status: 201, body: await service.createRetentionDraft(input, auth.actor) };
    }
    if (action === 'publish') {
      const input = parseBody(GlobalSettingsPublishRequestSchema, ctx.body);
      return { status: 200, body: await service.publishRetentionRevision(input, auth.actor) };
    }
    const input = parseBody(GlobalSettingsRollbackRequestSchema, ctx.body);
    return { status: 200, body: await service.rollbackRetentionRevision(input, auth.actor) };
  }
  throw new HttpError(404, 'NOT_FOUND', 'global settings route was not found');
}

function decodeTenant(segment: string): string {
  let value: string;
  try { value = decodeURIComponent(segment); } catch { throw new HttpError(404, 'NOT_FOUND', 'not found'); }
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value)) throw new HttpError(404, 'NOT_FOUND', 'not found');
  return value;
}
