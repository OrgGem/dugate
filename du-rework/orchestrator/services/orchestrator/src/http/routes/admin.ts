import { z } from 'zod';
import { readMigrationReadiness } from '../../modules/legacy-migration/readiness';
/**
 * CONV-02: the admin audience (`/api/v1/admin/...`, bearer/CSRF/RBAC-gated),
 * moved verbatim out of server.ts route() — read pages, action dispatcher,
 * crypto-config and the audit ledger. assertAdminAuth keeps the fail-closed
 * "no admin token configured => 401" rule.
 */
import { HttpError, isHttpError } from '../errors';
import { readEffectiveSettings } from '../../modules/settings/settings';
import {
  ADMIN_BUSINESS_LIST_QUERY_PARAMS,
  ADMIN_BUSINESS_VERSION_LIST_QUERY_PARAMS,
  BusinessEnableRequestSchema,
  VersionActivationRequestSchema,
  SecretCatalogCreateSchema,
  SecretCatalogDisableSchema,
  SecretCatalogRotateSchema,
  listPage,
} from '@du/contracts';
import {
  createSecretInDb,
  disableSecretInDb,
  listSecretsFromDb,
  parseSecretCatalogListQuery,
  rotateSecretInDb,
  testSecretInDb,
} from '../../modules/secrets/secret-catalog-store';
import { canonicalPayloadHash, executeIdempotent, readIdempotencyKey } from '../../modules/idempotency/idempotency';
import { auditedMutation } from '../../modules/audit/audit';
import {
  adminActionsMethodGuard,
  authorizeAuditTenantRead,
  requireResourceTenant,
  resolveAdminActionAuthAsync,
  resolveAdminAuditPrincipal,
  resolveAdminPrincipal,
} from '../../modules/admin-actions/rbac';
import { dispatchAdminAction } from '../../modules/admin-actions/dispatcher';
import { applyCryptoConfig, readCryptoConfig } from '../../app/admin/crypto-config-api';
import { parseCookieHeader, verifyCookie } from '../../app/admin/shell-auth';
import { dateToIso, parseAdminResourceListQuery, UUID_PARAM_PATTERN } from '../../modules/admin-read/keyset';
import { listAdminBusinessesPage, listBusinessVersionPage } from '../../modules/admin-read/business-list';
import {
  listTenantBusinessCatalogPage,
  parseTenantBusinessCatalogQuery,
} from '../../modules/admin-read/tenant-business-catalog';
import {
  buildApiKeyPage,
  listApiKeyPage,
  parseApiKeyListQuery,
  type ApiKeyDbRow,
} from '../../modules/admin-read/api-key-list';
import { listAuditEventPage, parseAdminAuditListQuery } from '../../modules/admin-read/audit-list';
import {
  listTenantPage,
  parseTenantListQuery,
  toTenantWire,
} from '../../modules/admin-read/tenant-list';
import {
  EMPTY_PROFILE_POLICY_READ,
  loadProfileDetail,
  profileDetailCurrentValues,
  profileDetailConnectorBindingsRead,
  profileDetailPolicyRead,
} from '../../modules/admin-read/profile-detail';
import { loadTenantProfileDetail } from '../../modules/admin-read/tenant-profile-detail';
import { listAdminProfilePage, parseAdminProfileListQuery } from '../../modules/admin-read/profile-list';
import { listProfileApiKeys } from '../../modules/admin-read/profile-api-keys';
import { listProfileWorkflows, setProfileWorkflowBinding } from '../../modules/admin-read/profile-workflows';
import { listAdminWorkflows, getAdminWorkflowDetail } from '../../modules/admin-read/workflow-list';
import { listWorkerInstances, parseWorkerInstanceListQuery } from '../../modules/admin-read/worker-instances';
import { getBusinessVersionImpactPreview } from '../../modules/admin-read/business-impact-preview';
import { hashKey } from './api-key-auth';
import type { RouteContext, RouteResult } from '../route-context';
import { handleAdminProfileGroupsRoute } from './admin-profile-groups';
import { admissionReasonForVersion, readBusinessAdmission } from '../../modules/registry/version-admission';

function assertAdminAuth(ctx: RouteContext) {
  // Admin and runtime credentials are distinct (R08-01). The fail-closed
  // default denies every admin request when no admin token is configured;
  // the runtime token never substitutes.
  if (!ctx.config.adminToken) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
  }
  const auth = ctx.headers['authorization'] ?? '';
  if (auth !== `Bearer ${ctx.config.adminToken}`) {
    throw new HttpError(401, 'UNAUTHENTICATED', 'invalid admin bearer token');
  }
}

function assertPlatformSecretMutation(ctx: RouteContext): void {
  assertAdminAuth(ctx);
  const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
  if (!principal || principal.role !== 'platform') {
    throw new HttpError(403, 'PERMISSION_DENIED', 'secret catalog lifecycle mutations require platform Admin access');
  }
}

async function validateGlobalManagedSecretCreate(ctx: RouteContext, input: import('@du/contracts').SecretCatalogCreate): Promise<void> {
  if (input.purpose !== 'storage.credential' && input.purpose !== 'maintenance.backup_encryption') return;
  if (!ctx.config.secretCatalogKeyring) {
    throw new HttpError(503, 'SECRET_KEYRING_UNAVAILABLE', 'exact-version secret encryption is not configured');
  }
  if (input.provider.kind !== 'managed_value' || input.services.length !== 1 || input.services[0] !== 'orchestrator') {
    throw new HttpError(422, 'INVALID_SCHEMA', 'global storage and backup secrets require an encrypted Orchestrator-only managed value');
  }
  assertPlatformSecretMutation(ctx);
  const tenant = await ctx.db.query('SELECT id FROM tenants WHERE id=$1', [input.tenantId]);
  if (!tenant.rowCount) throw new HttpError(404, 'NOT_FOUND', 'secret owner tenant was not found');
}

async function assertGlobalSecretLifecycle(ctx: RouteContext, secretId: string, action: 'rotate' | 'disable' | 'test'): Promise<boolean> {
  const current = await ctx.db.query<{ purpose: string; tenant_id: string; services: string[] }>(
    'SELECT purpose,tenant_id,services FROM secret_catalog WHERE secret_id=$1', [secretId],
  );
  const row = current.rows[0];
  if (!row) return false;
  const globalPurpose = row.purpose === 'storage.credential' || row.purpose === 'maintenance.backup_encryption';
  if (!globalPurpose) return false;
  if (action === 'test' && !ctx.config.secretCatalogKeyring) {
    throw new HttpError(503, 'SECRET_KEYRING_UNAVAILABLE', 'exact-version secret decryption is not configured');
  }
  if (action !== 'test') assertPlatformSecretMutation(ctx);
  if (row.services.length !== 1 || row.services[0] !== 'orchestrator') {
    throw new HttpError(409, 'SECRET_SCOPE_INVALID', 'global secret does not have the required Orchestrator-only scope');
  }
  return globalPurpose;
}

/**
 * AUDIT-EXT-2: this route plane authenticates with the platform admin bearer
 * only (`assertAdminAuth`), so the server-derived role is 'platform' — a
 * bearer carries no subject/issuer, and nothing invents one. Rows get
 * `actorRole` only; the `actor` fallback is unchanged.
 */
const ADMIN_TOKEN_AUDIT_FIELDS = { actorRole: 'platform' } as const;

function readUniqueAdminQueryParam(ctx: RouteContext, name: string): string | null {
  const values = ctx.searchParams.getAll(name);
  if (values.length > 1) throw new HttpError(422, 'INVALID_SCHEMA', `${name} must not be repeated`);
  return values[0] ?? null;
}

function decodeBusinessPathSegment(raw: string, name: string): string {
  let value: string;
  try {
    value = decodeURIComponent(raw);
  } catch {
    throw new HttpError(422, 'INVALID_SCHEMA', `${name} path segment is malformed`);
  }
  if (value.length === 0 || value.length > 256 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${name} path segment is invalid`);
  }
  return value;
}

function readBusinessLifecycleRevision(value: number | string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('business lifecycle revision is invalid');
  }
  return revision;
}

function readBusinessActivationRevision(value: number | string): number {
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) {
    throw new Error('business activation revision is invalid');
  }
  return revision;
}

export async function handleAdminRoutes(ctx: RouteContext): Promise<RouteResult | null> {
  const { method, pathname } = ctx;
  const profileGroupRoute = await handleAdminProfileGroupsRoute(ctx);
  if (profileGroupRoute) return profileGroupRoute;
  if (pathname === '/api/v1/admin/legacy-migration/readiness') {
    if(method !== 'GET') throw new HttpError(405,'METHOD_NOT_ALLOWED','readiness accepts GET only');
    const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if(!principal) throw new HttpError(401,'UNAUTHENTICATED','admin credential required');
    const tenantId = authorizeAuditTenantRead(principal,ctx.searchParams.get('tenantId') ?? '');
    if(!z.string().uuid().safeParse(tenantId).success) throw new HttpError(422,'INVALID_SCHEMA','tenantId must be a UUID');
    return {status:200,body:await readMigrationReadiness(ctx.db,tenantId)};
  }
  if (pathname === '/api/v1/admin/settings') {
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'settings read accepts GET only');
    const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (!principal) throw new HttpError(401, 'UNAUTHENTICATED', 'admin credential required');
    const scope = authorizeAuditTenantRead(principal, ctx.searchParams.get('tenantId') ?? '');
    return { status: 200, body: await readEffectiveSettings(ctx, scope || null) };
  }

  // BIZ-11: tenant-fenced, read-only dependency preview for one business version.
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/impact-preview$/.exec(pathname);
    if (m) {
      if (method !== 'GET') {
        throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'business version impact preview accepts GET only');
      }
      const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!principal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      for (const name of ctx.searchParams.keys()) {
        if (name !== 'tenantId' && name !== 'action') {
          throw new HttpError(422, 'INVALID_SCHEMA', `unsupported impact preview query parameter: ${name}`);
        }
      }
      const requestedTenantId = readUniqueAdminQueryParam(ctx, 'tenantId');
      const action = readUniqueAdminQueryParam(ctx, 'action');
      if (action !== 'activate' && action !== 'deactivate') {
        throw new HttpError(422, 'INVALID_SCHEMA', 'action must be activate or deactivate');
      }
      const tenantScope = authorizeAuditTenantRead(principal, requestedTenantId ?? '');
      const tenantId = tenantScope || requestedTenantId;
      if (!tenantId) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required for business impact preview');
      }
      const businessId = decodeBusinessPathSegment(m[1]!, 'businessId');
      const version = decodeBusinessPathSegment(m[2]!, 'version');
      return {
        status: 200,
        body: await getBusinessVersionImpactPreview(ctx.db, { tenantId, businessId, version, action }),
      };
    }
  }

  // Admin: PUT /api/v1/admin/businesses/:id/versions/:version/enable  (P2-07 real enable)
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/enable$/.exec(pathname);
    if (m && method === 'PUT') {
      assertAdminAuth(ctx);
      const businessId = decodeURIComponent(m[1]!);
      const version = decodeURIComponent(m[2]!);
      const parsed = VersionActivationRequestSchema.safeParse(ctx.body);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'version enable payload is invalid');
      const result = await auditedMutation(
        ctx.db,
        ctx.audit,
        (client) => ctx.registry.enableVersion(businessId, version, parsed.data.expectedActivationRevision, client, 'admin'),
        (r) => ({
          tenantId: null,
          actor: 'admin',
          ...ADMIN_TOKEN_AUDIT_FIELDS,
          action: 'business.enable',
          resource: `business:${businessId}@${version}:activation-revision:${r.activationRevision}`,
          severity: 'success',
          correlationId: ctx.correlationId,
        }),
      );
      return { status: 200, body: result };
    }
  }

  // WOC-10: logical business availability is a lifecycle CAS, separate from
  // per-version ENABLED/active state. Existing leases drain; admission and
  // claim gates read this same catalog row.
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/enabled$/.exec(pathname);
    if (m) {
      if (method !== 'PUT') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'business enabled state accepts PUT only');
      assertAdminAuth(ctx);
      const businessId = decodeBusinessPathSegment(m[1]!, 'businessId');
      const parsed = BusinessEnableRequestSchema.safeParse(ctx.body);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'business enabled-state payload is invalid');
      const result = await ctx.db.tx(async (client) => {
        const changed = await ctx.registry.setBusinessEnabled(
          businessId,
          parsed.data.enabled,
          parsed.data.expectedLifecycleRevision,
          client,
          'admin',
        );
        if (!changed.replayed) {
          await ctx.audit.record({
            tenantId: null,
            actor: 'admin',
            ...ADMIN_TOKEN_AUDIT_FIELDS,
            action: changed.enabled ? 'business.enable' : 'business.disable',
            resource: `business:${changed.businessId}`,
            severity: changed.enabled ? 'success' : 'warning',
            correlationId: ctx.correlationId,
          }, client);
        }
        return changed;
      });
      return { status: 200, body: result };
    }
  }

  // Admin: PUT /api/v1/admin/businesses/:id/versions/:version/activate  (W28-C)
  // Activate a version as the target for new submissions. Any other version's
  // active pointer is implicitly cleared. In-flight/pinned operations keep
  // routing via their operation.business_version pin, unchanged.
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/activate$/.exec(pathname);
    if (m && method === 'PUT') {
      assertAdminAuth(ctx);
      const parsed = VersionActivationRequestSchema.safeParse(ctx.body);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'version activation payload is invalid');
      // R3-01: activation + ledger INSERT share one transaction.
      const result = await auditedMutation(
        ctx.db,
        ctx.audit,
        (client) => ctx.registry.activateVersion(
          decodeBusinessPathSegment(m[1]!, 'businessId'),
          decodeBusinessPathSegment(m[2]!, 'version'),
          parsed.data.expectedActivationRevision,
          client,
          'admin',
        ),
        (r) => ({
          // W48-C1: platform-global audit row (no tenant on business_versions).
          tenantId: null,
          actor: 'admin',
          ...ADMIN_TOKEN_AUDIT_FIELDS,
          action: 'business.activate',
          resource: `business:${r.businessId}@${r.version}:activation-revision:${r.activationRevision}`,
          severity: 'info',
          correlationId: ctx.correlationId,
        })
      );
      return { status: result.replayed ? 200 : 202, body: result };
    }
  }

  // Admin: PUT /api/v1/admin/businesses/:id/versions/:version/deactivate  (W28-C)
  // Drain a version: new submissions no longer target it. In-flight work and
  // existing claims/queue routing stay routable via the operation pin.
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/deactivate$/.exec(pathname);
    if (m && method === 'PUT') {
      assertAdminAuth(ctx);
      const parsed = VersionActivationRequestSchema.safeParse(ctx.body);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'version deactivation payload is invalid');
      // R3-01: drain + ledger INSERT share one transaction.
      const result = await auditedMutation(
        ctx.db,
        ctx.audit,
        (client) => ctx.registry.deactivateVersion(
          decodeBusinessPathSegment(m[1]!, 'businessId'),
          decodeBusinessPathSegment(m[2]!, 'version'),
          parsed.data.expectedActivationRevision,
          client,
          'admin',
        ),
        (r) => ({
          // W48-C1: platform-global audit row. `business.drain` is the wire
          // kind the renderer knows (AUDIT_KIND_META); the route keeps the
          // `deactivate` name (W28-C) — no wire/route rename here.
          tenantId: null,
          actor: 'admin',
          ...ADMIN_TOKEN_AUDIT_FIELDS,
          action: 'business.drain',
          resource: `business:${r.businessId}@${r.version}:activation-revision:${r.activationRevision}`,
          severity: 'warning',
          correlationId: ctx.correlationId,
        })
      );
      return { status: result.replayed ? 200 : 202, body: result };
    }
  }

  // Pre-drain pauses new operations while the currently active version keeps
  // claiming required retries/children. Activation is a separate CAS after
  // the durable remaining-operation count reaches zero; cancellation resumes
  // operation admission without changing the active pointer.
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/pre-drain$/.exec(pathname);
    if (m && method === 'PUT') {
      assertAdminAuth(ctx);
      const parsed = VersionActivationRequestSchema.safeParse(ctx.body);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'pre-drain payload is invalid');
      const businessId = decodeBusinessPathSegment(m[1]!, 'businessId');
      const version = decodeBusinessPathSegment(m[2]!, 'version');
      const result = await auditedMutation(
        ctx.db,
        ctx.audit,
        (client) => ctx.registry.startVersionPreDrain(
          businessId, version, parsed.data.expectedActivationRevision, client, 'admin',
        ),
        (r) => ({
          tenantId: null,
          actor: 'admin',
          ...ADMIN_TOKEN_AUDIT_FIELDS,
          action: 'business.pre_drain',
          resource: `business:${r.businessId}@${r.version}:activation-revision:${r.activationRevision}`,
          severity: 'warning',
          correlationId: ctx.correlationId,
        }),
      );
      return { status: 200, body: result };
    }
  }

  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions\/([^/]+)\/pre-drain\/cancel$/.exec(pathname);
    if (m && method === 'PUT') {
      assertAdminAuth(ctx);
      const parsed = VersionActivationRequestSchema.safeParse(ctx.body);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'pre-drain cancellation payload is invalid');
      const businessId = decodeBusinessPathSegment(m[1]!, 'businessId');
      const version = decodeBusinessPathSegment(m[2]!, 'version');
      const result = await auditedMutation(
        ctx.db,
        ctx.audit,
        (client) => ctx.registry.cancelVersionPreDrain(
          businessId, version, parsed.data.expectedActivationRevision, client, 'admin',
        ),
        (r) => ({
          tenantId: null,
          actor: 'admin',
          ...ADMIN_TOKEN_AUDIT_FIELDS,
          action: 'business.pre_drain_cancel',
          resource: `business:${r.businessId}@${r.version}:activation-revision:${r.activationRevision}`,
          severity: 'success',
          correlationId: ctx.correlationId,
        }),
      );
      return { status: 200, body: result };
    }
  }

  // Admin: POST /api/v1/admin/profile-bindings  (P2-02/R08-02, W13-C)
  // Append an immutable profile revision for an API key. Body carries the
  // raw `apiKey` (hashed server-side, never stored raw) plus (business,
  // version, action) and the slot → { connectorId, revision } pin map.
  if (method === 'POST' && pathname === '/api/v1/admin/profile-bindings') {
    // ADM-BASE-02 mutation scope: a tenant operator may bind ONLY keys of
    // its own tenant — the target tenant is derived from the credential
    // + resolved key row, never from caller choice. Foreign target: 403
    // PERMISSION_DENIED (explicit mutation, identical message for every
    // foreign tenant). Unknown/inactive key keeps the pre-existing 404.
    const bindingsPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (!bindingsPrincipal) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
    }
    const body = ctx.body as Record<string, unknown>;
    if (typeof body?.apiKey !== 'string' || !body.apiKey) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'apiKey is required');
    }
    const rawApiKey = body.apiKey;
    if (bindingsPrincipal.role === 'tenant_operator') {
      // OIDC-03 (cycle 96): api-key credential grants are ADMIN-ONLY even
      // for a tenant-scoped bearer — an operator may not bind keys, not
      // even its own tenant's (supersedes the cycle-82 allowance; the
      // operator's approved admin actions live in the dispatcher table).
      throw new HttpError(403, 'PERMISSION_DENIED', 'apikey credential changes require the platform admin role');
    }
    // The profile-binding event has its own typed identity; this mutation
    // does not create or revoke an API key.
    // Actor is the fixed string 'admin' — the raw bearer / raw apiKey never
    // touches the ledger.
    // R3-01: binding INSERT + ledger INSERT commit in ONE transaction — a
    // failed audit row rolls the granted revision back with it.
    // R2-A priority-5 (review.md cycle 6/6 MEDIUM, retried mutating POST):
    // with an Idempotency-Key/Client-Token header the marker commits in the
    // SAME transaction as revision + audit, so a response-loss retry replays
    // the stored 201 and never writes a second revision or audit row.
    // No header => legacy behavior, byte-for-byte.
    const idemKey = readIdempotencyKey(ctx.headers);
    const outcome = await executeIdempotent(
      ctx.db,
      { key: idemKey, route: 'POST /api/v1/admin/profile-bindings', payloadHash: canonicalPayloadHash(body) },
      async (withMarker) => {
        const result = await auditedMutation(
          ctx.db,
          ctx.audit,
          (client) =>
            ctx.profiles.createRevision(
              {
                profileId: typeof body.profileId === 'string' ? body.profileId : undefined,
                apiKeyHash: hashKey(rawApiKey),
                businessId: body.businessId as string,
                businessVersion: body.businessVersion as string,
                action: body.action as string,
                connectorBindings: body.connectorBindings,
              },
              client
            ),
          (r) => ({
            tenantId: r.tenantId,
            actor: 'admin',
            actorRole: bindingsPrincipal.role,
            action: 'profile_binding.bind',
            resource: `apikey:${r.apiKeyId}`,
            severity: 'info',
            correlationId: ctx.correlationId,
          }),
          idemKey ? (client, r) => withMarker(client, { status: 201, body: r }) : undefined
        );
        return { status: 201, body: result };
      }
    );
    return {
      status: outcome.status,
      body: outcome.body,
      headers: outcome.replayed ? { 'idempotent-replay': 'true' } : undefined,
    };
  }

  // Admin: VAULT-03 provider-key credentials — write-only rotate + masked GET.
  // The plaintext value exists ONLY inside the POST body (write-only by
  // contract); responses/audit carry the masked projection. Without an
  // injected workflow (Vault writer + revision store) both routes fail closed.
  {
    const m = /^\/api\/v1\/admin\/connectors\/([^/]+)\/credentials$/.exec(pathname);
    if (m && (method === 'POST' || method === 'GET')) {
      assertAdminAuth(ctx);
      const connectorId = decodeURIComponent(m[1]!);
      if (!ctx.credentialWorkflow) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'connector credential workflow not configured');
      }
      if (method === 'GET') {
        return { status: 200, body: await ctx.credentialWorkflow.describe(connectorId) };
      }
      const body = (ctx.body ?? {}) as Record<string, unknown>;
      const idempotencyKey = readIdempotencyKey(ctx.headers);
      const result = await ctx.credentialWorkflow.rotate({
        connectorId,
        ref: {
          account: String(body.account ?? ''),
          mount: String(body.mount ?? ''),
          path: String(body.path ?? ''),
          key: String(body.key ?? ''),
        },
        value: typeof body.value === 'string' ? body.value : '',
        ...(typeof body.cas === 'number' ? { cas: body.cas } : {}),
        ...(idempotencyKey ? { idempotencyKey, payloadHash: canonicalPayloadHash(body) } : {}),
      });
      return {
        status: result.replayed ? 200 : 201,
        body: result,
        ...(result.replayed ? { headers: { 'idempotent-replay': 'true' } } : {}),
      };
    }
  }

  // Admin: POST /api/v1/admin/operations/sweep-deadlines  (P2-06; test/dev trigger)
  if (method === 'POST' && pathname === '/api/v1/admin/operations/sweep-deadlines') {
    assertAdminAuth(ctx);
    // R3-01: sweep + ledger INSERT share one transaction.
    // R2-A priority-5: same idempotency contract as profile-bindings — a
    // keyed retry replays the stored { timedOut } instead of sweeping twice.
    const idemKey = readIdempotencyKey(ctx.headers);
    const outcome = await executeIdempotent(
      ctx.db,
      { key: idemKey, route: 'POST /api/v1/admin/operations/sweep-deadlines', payloadHash: canonicalPayloadHash(ctx.body) },
      async (withMarker) => {
        const count = await auditedMutation(
          ctx.db,
          ctx.audit,
          (client) => ctx.lifecycle.sweepDeadlines(client),
          () => ({
            // W48-C1: platform-global audit row (sweep spans all tenants —
            // attributing it to one tenant would be dishonest).
            tenantId: null,
            actor: 'admin',
            ...ADMIN_TOKEN_AUDIT_FIELDS,
            action: 'operation.deadline',
            resource: 'operations:deadline-sweep',
            severity: 'warning',
            correlationId: ctx.correlationId,
          }),
          idemKey ? (client, c) => withMarker(client, { status: 200, body: { timedOut: c } }) : undefined
        );
        return { status: 200, body: { timedOut: count } };
      }
    );
    return {
      status: outcome.status,
      body: outcome.body,
      headers: outcome.replayed ? { 'idempotent-replay': 'true' } : undefined,
    };
  }

  // Admin: POST /api/v1/admin/actions  (ADM-BASE-02 action dispatcher)
  // Single POST-only entry over the admin mutation surface. Auth:
  // bearer (platform / tenant-operator) first; a shell cookie session
  // only counts when it passes the server CSRF gate. RBAC matrix and
  // zero-side-effect denials live in modules/admin-actions/dispatcher
  // (pure, offline-tested). Non-POST -> 405 (never GET-as-success);
  // unknown action -> 404.
  if (pathname === '/api/v1/admin/actions') {
    adminActionsMethodGuard(method);
    // OIDC-03 order: bearer -> opaque SESSION cookie (when a store is
    // wired) -> legacy self-contained cookie; CSRF state server-computed.
    const actionAuth = await resolveAdminActionAuthAsync(
      ctx.config,
      ctx.headers,
      ctx.config.adminSessionStore
    );
    const body = ctx.body as Record<string, unknown>;
    const action = typeof body?.action === 'string' ? body.action : '';
    if (!action) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'action is required');
    }
    const params =
      body.params && typeof body.params === 'object' && !Array.isArray(body.params)
        ? (body.params as Record<string, unknown>)
        : {};
    const result = await dispatchAdminAction(
      {
        db: ctx.db,
        submission: ctx.submission,
        audit: ctx.audit,
        registry: ctx.registry,
        profiles: ctx.profiles,
        lifecycle: ctx.lifecycle,
        runtime: ctx.runtime,
        credentialWorkflow: ctx.credentialWorkflow,
        connectorManagement: ctx.connectorManagement,
        connectorTest: (connectorId: string) => ctx.connectors.testConnector(connectorId) as unknown as Promise<Record<string, unknown>>,
        hashApiKey: hashKey,
        correlationId: ctx.correlationId,
        metadataCrypto: ctx.metadataCrypto,
        metadataReader: ctx.metadataReader,
        identity: ctx.identity,
        callbackDeliveryCapabilities:{dispatcherConfigured:!!ctx.config.webhookSecret && (ctx.config.webhookDispatchIntervalMs ?? (ctx.config.autoDispatch !== false ? 5000 : 0)) > 0,authResolverConfigured:!!ctx.config.resolveCallbackSecret},
      },
      actionAuth,
      { action, params, idempotencyKey: readIdempotencyKey(ctx.headers) }
    );
    return { status: result.status, body: { action, ...result.body } };
  }

  // Admin: GET /api/v1/admin/businesses  (ADM-BASE-01)
  // Shell wire-up for the empty-businessId list pane. Bare-array form the
  // business fetcher parses (each item carries its own businessId). One
  // row per business carrying its active version (null when none active).
  if (method === 'GET' && pathname === '/api/v1/admin/businesses') {
    assertAdminAuth(ctx);
    const query = parseAdminResourceListQuery(ctx.searchParams, ADMIN_BUSINESS_LIST_QUERY_PARAMS);
    const page = await listAdminBusinessesPage(ctx.db, query);
    return {
      status: 200,
      body: listPage({
        items: page.rows.map((r) => ({
          businessId: r.business_id,
          enabled: r.enabled,
          lifecycleRevision: readBusinessLifecycleRevision(r.lifecycle_revision),
          activationRevision: readBusinessActivationRevision(r.activation_revision),
          submissionsPaused: r.submissions_paused,
          preDrainVersion: r.pre_drain_version,
          version: r.active_version ?? r.version,
          activeVersion: r.active_version,
          admissionEligible: r.admission_eligible,
          admissionReason: r.admission_reason,
          status: r.status,
          isActive: r.is_active,
          registeredAt: dateToIso(r.created_at),
          createdAt: dateToIso(r.created_at),
          updatedAt: dateToIso(r.updated_at),
          digest: r.digest,
          queue: r.queue,
        })),
        nextCursor: page.nextCursor,
        prevCursor: page.prevCursor,
        total: page.total,
        limit: query.limit,
      }),
    };
  }

  // BIZ-10: tenant-owned logical business catalog. Scope is selected from the
  // path only after authenticating the principal; tenant operators are pinned
  // to their own tenant and the SQL module fences both page and total queries.
  {
    const m = /^\/api\/v1\/admin\/tenants\/([^/]+)\/businesses$/.exec(pathname);
    if (m && method === 'GET') {
      const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!principal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      let requestedTenantId: string;
      try {
        requestedTenantId = decodeURIComponent(m[1]!).toLowerCase();
      } catch {
        throw new HttpError(400, 'INVALID_ARGUMENT', 'tenantId path parameter is malformed');
      }
      if (!UUID_PARAM_PATTERN.test(requestedTenantId)) {
        throw new HttpError(400, 'INVALID_ARGUMENT', 'tenantId path parameter must be a UUID');
      }
      const tenantId = authorizeAuditTenantRead(principal, requestedTenantId);
      const query = parseTenantBusinessCatalogQuery(ctx.searchParams);
      const tenantTokenSeed = JSON.stringify(
        Object.entries(ctx.config.tenantAdminTokens ?? {}).sort(([left], [right]) => left.localeCompare(right)),
      );
      const cursorSecret = ctx.config.adminShellCookieSecret || ctx.config.adminToken || tenantTokenSeed;
      const page = await listTenantBusinessCatalogPage({
        db: ctx.db,
        tenantId,
        query,
        cursorSecret,
      });
      return {
        status: 200,
        body: {
          ...listPage({
            items: page.rows.map((row) => ({
              businessId: row.business_id,
              enabled: row.enabled,
              lifecycleRevision: readBusinessLifecycleRevision(row.lifecycle_revision),
              displayName: row.business_id,
              latestVersion: row.latest_version,
              latestStatus: row.latest_status,
              activeVersion: row.active_version,
              versionCount: Number(row.version_count),
              createdAt: dateToIso(row.created_at),
              updatedAt: dateToIso(row.updated_at),
            })),
            nextCursor: page.nextCursor,
            prevCursor: page.prevCursor,
            total: page.total,
            limit: query.limit,
          }),
          generatedAt: new Date().toISOString(),
        },
      };
    }
  }

  // AWEB-11C: platform-scoped worker inventory from persisted heartbeat rows.
  if (pathname === '/api/v1/admin/worker-instances') {
    assertAdminAuth(ctx);
    if (method !== 'GET') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'worker instances are read-only');
    const query = parseWorkerInstanceListQuery(ctx.searchParams);
    return { status: 200, body: await listWorkerInstances(ctx.db, query) };
  }

  // Admin: GET /api/v1/admin/tenants  (tenant roster / picker source)
  // The wire item is exactly { id, name, state }, ordered by (lower(name), id)
  // — see the contract note on TENANT_LIST_QUERY_PARAMS for why this list
  // carries no `sort` parameter while the other admin lists do.
  //
  // Scope comes from the CREDENTIAL, never from a query parameter (this route
  // accepts none): the platform bearer sees the whole roster, a tenant operator
  // sees exactly its own row and the predicate rides in SQL.
  //
  // NOTE on `authorizeAuditTenantRead(principal, '')` returning '': on the
  // audit/api-keys lists '' means "honest empty page", because those tables are
  // always tenant-scoped rows. Here '' is the platform principal's "no
  // narrowing" answer — the roster itself is the tenant directory, so an
  // unnarrowed platform read is every tenant, not none. Reading it as an empty
  // page would hide the roster from the only principal allowed to see it.
  if (method === 'GET' && pathname === '/api/v1/admin/tenants') {
    const tenantsPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (!tenantsPrincipal) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
    }
    const query = parseTenantListQuery(ctx.searchParams);
    const scope = authorizeAuditTenantRead(tenantsPrincipal, '');
    const page = await listTenantPage(ctx.db, scope === '' ? null : scope, query);
    return {
      status: 200,
      body: listPage({
        items: page.rows.map(toTenantWire),
        nextCursor: page.nextCursor,
        prevCursor: page.prevCursor,
        total: page.total,
        limit: query.limit,
      }),
    };
  }

  // Admin: GET /api/v1/admin/workflows  (WFA-03 catalog read)
  if (method === 'GET' && pathname === '/api/v1/admin/workflows') {
    const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (!principal) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
    }
    const requestedTenant = ctx.searchParams.get('tenantId') || null;
    const scope = authorizeAuditTenantRead(principal, requestedTenant ?? '');
    const effectiveTenant = scope === '' ? requestedTenant : scope;
    const businessIdValues = ctx.searchParams.getAll('businessId');
    const businessVersionValues = ctx.searchParams.getAll('businessVersion');
    if (businessIdValues.length > 1 || businessVersionValues.length > 1) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'businessId and businessVersion must not be repeated');
    }
    const businessId = businessIdValues[0]?.trim();
    const businessVersion = businessVersionValues[0]?.trim();
    if (businessVersion && !businessId) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'businessVersion requires businessId');
    }
    if ((businessId && businessId.length > 256) || (businessVersion && businessVersion.length > 128)) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'business filter is too long');
    }
    const items = await listAdminWorkflows(ctx.db, effectiveTenant, ctx.metadataCrypto, {
      ...(businessId ? { businessId } : {}),
      ...(businessVersion ? { businessVersion } : {}),
    });
    return {
      status: 200,
      body: { items, total: items.length },
    };
  }

  // Admin: GET /api/v1/admin/workflows/:slug  (WFA-03 detail read)
  {
    const m = /^\/api\/v1\/admin\/workflows\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') {
      const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!principal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      const slug = decodeURIComponent(m[1]!);
      const requestedTenant = ctx.searchParams.get('tenantId') || null;
      const scope = authorizeAuditTenantRead(principal, requestedTenant ?? '');
      const effectiveTenant = scope === '' ? requestedTenant : scope;
      if (!effectiveTenant) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required for workflow detail read');
      }
      const detail = await getAdminWorkflowDetail(ctx.db, effectiveTenant, slug, ctx.metadataCrypto);
      if (!detail.active && detail.revisions.length === 0) {
        throw new HttpError(404, 'NOT_FOUND', `workflow schema '${slug}' not found for tenant '${effectiveTenant}'`);
      }
      return {
        status: 200,
        body: detail,
      };
    }
  }

  // Admin: GET /api/v1/admin/businesses/:id/versions  (ADM-BASE-01)
  // Shell wire-up: `{ businessId, activeVersion, rows: [...] }`. Unknown
  // business → 404 (the fetcher maps it to `not-found`).
  {
    const m = /^\/api\/v1\/admin\/businesses\/([^/]+)\/versions$/.exec(pathname);
    if (m && method === 'GET') {
      assertAdminAuth(ctx);
      const businessId = decodeURIComponent(m[1]!);
      const query = parseAdminResourceListQuery(ctx.searchParams, ADMIN_BUSINESS_VERSION_LIST_QUERY_PARAMS);
      const page = await listBusinessVersionPage(ctx.db, businessId, query);
      if (page.total === 0) throw new HttpError(404, 'NOT_FOUND', `business '${businessId}' is not registered`);
      const admission = await ctx.db.tx((client) => readBusinessAdmission(client, businessId, undefined, 'SHARE'));
      if (!admission) throw new HttpError(404, 'NOT_FOUND', `business '${businessId}' is not registered`);
      const logicalBusiness = await ctx.db.query<{ lifecycle_revision: number | string }>(
        'SELECT lifecycle_revision FROM business_catalog WHERE business_id=$1', [businessId],
      );
      const lifecycleRevision = logicalBusiness.rows[0]?.lifecycle_revision;
      if (lifecycleRevision === undefined) throw new HttpError(404, 'NOT_FOUND', `business '${businessId}' is not registered`);
      const remaining = admission.preDrainVersion
        ? await ctx.db.query<{ count: number | string }>(
          `SELECT count(*)::int AS count FROM operations
            WHERE business_id=$1 AND business_version=$2
              AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`,
          [businessId, admission.preDrainVersion],
        )
        : null;
      const remainingOperations = Number(remaining?.rows[0]?.count ?? 0);
      const workCounts = await ctx.db.query<{
        business_version: string;
        parked_task_count: number | string;
        draining_task_count: number | string;
        parked_reasons: Record<string, number> | string | null;
      }>(
        `WITH task_counts AS (
           SELECT o.business_version,
                  count(*) FILTER (
                    WHERE t.admission_parked_reason IS NOT NULL
                      AND t.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
                  )::int AS parked_task_count,
                  count(*) FILTER (
                    WHERE t.state='RUNNING' AND t.lease_expires_at > clock_timestamp()
                      AND o.business_version IS DISTINCT FROM $2::text
                  )::int AS draining_task_count
             FROM tasks t JOIN operations o ON o.id=t.operation_id
            WHERE o.business_id=$1
            GROUP BY o.business_version
         ), reason_counts AS (
           SELECT o.business_version,t.admission_parked_reason AS reason,count(*)::int AS count
             FROM tasks t JOIN operations o ON o.id=t.operation_id
            WHERE o.business_id=$1 AND t.admission_parked_reason IS NOT NULL
              AND t.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
            GROUP BY o.business_version,t.admission_parked_reason
         ), reasons AS (
           SELECT business_version,jsonb_object_agg(reason,count) AS parked_reasons
             FROM reason_counts GROUP BY business_version
         )
         SELECT counts.business_version,counts.parked_task_count,counts.draining_task_count,
                COALESCE(reasons.parked_reasons,'{}'::jsonb) AS parked_reasons
           FROM task_counts counts LEFT JOIN reasons USING (business_version)`,
        [businessId, admission.activeVersion],
      );
      const countsByVersion = new Map(workCounts.rows.map((row) => {
        let parkedReasons: Record<string, number> = {};
        if (typeof row.parked_reasons === 'string') {
          try {
            const parsed: unknown = JSON.parse(row.parked_reasons);
            if (typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)) {
              parkedReasons = Object.fromEntries(Object.entries(parsed).map(([reason, count]) => [reason, Number(count)]));
            }
          } catch {
            parkedReasons = {};
          }
        } else if (row.parked_reasons && typeof row.parked_reasons === 'object') {
          parkedReasons = Object.fromEntries(Object.entries(row.parked_reasons).map(([reason, count]) => [reason, Number(count)]));
        }
        return [row.business_version, {
          parkedTaskCount: Number(row.parked_task_count),
          drainingTaskCount: Number(row.draining_task_count),
          parkedReasons,
        }] as const;
      }));
      const items = page.rows.map((r) => ({
        businessId: r.business_id,
        version: r.version,
        status: r.status,
        isActive: admission.activeVersion === r.version,
        admissionEligible: admission.enabled && admission.activeVersion === r.version && r.status === 'ENABLED',
        admissionReason: admissionReasonForVersion({ ...admission, targetStatus: r.status }, r.version),
        parkedTaskCount: countsByVersion.get(r.version)?.parkedTaskCount ?? 0,
        drainingTaskCount: countsByVersion.get(r.version)?.drainingTaskCount ?? 0,
        parkedReasons: countsByVersion.get(r.version)?.parkedReasons ?? {},
        registeredAt: dateToIso(r.created_at),
        createdAt: dateToIso(r.created_at),
        updatedAt: dateToIso(r.updated_at),
        digest: r.digest,
        queue: r.queue,
      }));
      return {
        status: 200,
        body: {
          businessId,
          enabled: admission.enabled,
          lifecycleRevision: readBusinessLifecycleRevision(lifecycleRevision),
          activeVersion: admission.activeVersion,
          activationRevision: admission.activationRevision,
          submissionsPaused: admission.submissionsPaused,
          preDrainVersion: admission.preDrainVersion,
          remainingOperations,
          ...listPage({
            items,
            nextCursor: page.nextCursor,
            prevCursor: page.prevCursor,
            total: page.total,
            limit: query.limit,
          }),
          rows: items,
        },
      };
    }
  }

  // Admin: GET /api/v1/admin/profiles/:businessId/:businessVersion/:profileName
  // (ADM-BASE-01) Shell wire-up: the fetcher sends `latest`/`new` sentinels.
  // Projected from the registered business manifest (actions + slots);
  // capabilities come from no platform table yet → `[]` (tolerated).
  // Unknown business/version → 404. `/new` returns the same manifest with
  // an empty profileName + revision 0 (blank editor, no stored profile).
  if (method === 'GET' && pathname === '/api/v1/admin/profiles') {
    const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
    if (!principal) {
      throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
    }
    const query = parseAdminProfileListQuery(ctx.searchParams);
    const scope = authorizeAuditTenantRead(principal, query.tenantId ?? '');
    if (scope === '') {
      return {
        status: 200,
        body: listPage({ items: [], nextCursor: null, prevCursor: null, total: 0, limit: query.limit }),
      };
    }
    const page = await listAdminProfilePage(ctx.db, scope, query);
    return {
      status: 200,
      body: listPage({
        items: page.rows.map((row) => ({
          tenantId: row.tenant_id,
          businessId: row.business_id,
          businessVersion: row.business_version,
          profileName: row.profile_name,
          revision: row.revision,
          status: row.enabled === true ? 'ACTIVE' : row.enabled === false ? 'DISABLED' : 'UNKNOWN',
          keyCount: row.key_count,
          boundActions: row.bound_actions,
          createdAt: dateToIso(row.created_at),
          updatedAt: dateToIso(row.updated_at),
        })),
        nextCursor: page.nextCursor,
        prevCursor: page.prevCursor,
        total: page.total,
        limit: query.limit,
      }),
    };
  }

  {
    const m = /^\/api\/v1\/admin\/profiles\/([^/]+)\/([^/]+)\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') {
      const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!principal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      const tenantScope = authorizeAuditTenantRead(principal, '');
      const businessId = decodeURIComponent(m[1]!);
      const versionSeg = decodeURIComponent(m[2]!);
      const nameSeg = decodeURIComponent(m[3]!);
      const manifestRes = versionSeg === 'latest'
        ? await ctx.db.query(
            `SELECT business_id, version, manifest FROM business_versions
             WHERE business_id=$1 AND is_active = true LIMIT 1`,
            [businessId]
          )
        : await ctx.db.query(
            `SELECT business_id, version, manifest FROM business_versions
             WHERE business_id=$1 AND version=$2`,
            [businessId, versionSeg]
          );
      if (!manifestRes.rowCount) {
        throw new HttpError(404, 'NOT_FOUND', `no manifest for '${businessId}@${versionSeg}'`);
      }
      const row = manifestRes.rows[0] as {
        business_id: string; version: string; manifest: { actions?: unknown[] };
      };
      const isNew = nameSeg === 'new';
      if (isNew) {
        // Blank editor for a not-yet-stored profile: still schema-valid
        // (ProfileDetailReadSchema) with an explicit empty read policy and no
        // write identity yet.
        return {
          status: 200,
          body: {
            businessId: row.business_id,
            businessVersion: row.version,
            profileName: '',
            revision: 0,
            currentValues: {},
            policy: EMPTY_PROFILE_POLICY_READ,
            manifest: { actions: row.manifest?.actions ?? [] },
            capabilities: [],
            connectorBindings: {},
          },
        };
      }
      // T-API-01 closure: real revision/policy from the Δ7-A registry + the
      // 0027 pointer; the write identity (apiKeyId, never the hash) is
      // revealed so the client can address the profile.* commands.
      const detail = tenantScope === ''
        ? await loadProfileDetail(ctx.db, row.business_id, row.version, nameSeg)
        : await loadTenantProfileDetail(ctx.db, row.business_id, row.version, nameSeg, tenantScope);
      if (detail.kind === 'pointer-missing') {
        // Invariant #3: registry has rows but no pointer — fail closed, never
        // guess a revision.
        throw new HttpError(404, 'NOT_FOUND', `profile '${nameSeg}' has no active revision pointer`);
      }
      if (detail.kind === 'not-found') {
        if (tenantScope !== '') {
          // A tenant token can read only a profile stored under its own tenant;
          // do not turn a foreign or missing identity into the blank editor.
          throw new HttpError(404, 'NOT_FOUND', `profile '${nameSeg}' is not stored in this tenant`);
        }
        // Backwards-compatible create flow (R-12 blind first save): a named
        // profile that is not stored yet opens the same blank, schema-valid
        // editor as `/new` — no revision, no write identity. A STORED profile
        // always returns its real revision below.
        return {
          status: 200,
          body: {
            businessId: row.business_id,
            businessVersion: row.version,
            profileName: nameSeg,
            revision: 0,
            currentValues: {},
            policy: EMPTY_PROFILE_POLICY_READ,
            manifest: { actions: row.manifest?.actions ?? [] },
            capabilities: [],
            connectorBindings: {},
          },
        };
      }
      return {
        status: 200,
        body: {
          businessId: row.business_id,
          businessVersion: row.version,
          profileName: nameSeg,
          revision: detail.row.revision,
          currentValues: profileDetailCurrentValues(detail.row),
          policy: profileDetailPolicyRead(detail.row),
          manifest: { actions: row.manifest?.actions ?? [] },
          capabilities: [],
          connectorBindings: profileDetailConnectorBindingsRead(detail.row),
          apiKeyId: detail.row.api_key_id,
          // NOT profileId: ProfileDetailReadSchema is strict and this read is
          // frozen to the write identity the client already needs. The 0039
          // membership writes address the profile by (business, version, name)
          // and resolve the internal id server-side.
        },
      };
    }
  }

  // 0039: GET /api/v1/admin/profiles/:businessId/:businessVersion/:profileName/api-keys
  // The key set a profile OWNS. Addressed by the same (business, version, name)
  // tuple as the detail read, so a caller never has to know a profile_id.
  // A name that is not stored yet is 404 rather than an empty list — an empty
  // list would read as "this profile has no keys", which is a different fact.
  {
    const m = /^\/api\/v1\/admin\/profiles\/([^/]+)\/([^/]+)\/([^/]+)\/api-keys$/.exec(pathname);
    if (m && method === 'GET') {
      const keysPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!keysPrincipal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      const scope = authorizeAuditTenantRead(keysPrincipal, '');
      const businessId = decodeURIComponent(m[1]!);
      const versionSeg = decodeURIComponent(m[2]!);
      const nameSeg = decodeURIComponent(m[3]!);
      const manifestRes =
        versionSeg === 'latest'
          ? await ctx.db.query(
              `SELECT business_id, version FROM business_versions
               WHERE business_id=$1 AND is_active = true LIMIT 1`,
              [businessId]
            )
          : await ctx.db.query(
              `SELECT business_id, version FROM business_versions
               WHERE business_id=$1 AND version=$2`,
              [businessId, versionSeg]
            );
      if (!manifestRes.rowCount) {
        throw new HttpError(404, 'NOT_FOUND', `no manifest for '${businessId}@${versionSeg}'`);
      }
      const resolved = manifestRes.rows[0] as { business_id: string; version: string };
      const detail = scope === ''
        ? await loadProfileDetail(ctx.db, resolved.business_id, resolved.version, nameSeg)
        : await loadTenantProfileDetail(ctx.db, resolved.business_id, resolved.version, nameSeg, scope);
      if (detail.kind === 'pointer-missing') {
        throw new HttpError(404, 'NOT_FOUND', `profile '${nameSeg}' has no active revision pointer`);
      }
      if (detail.kind === 'not-found') {
        throw new HttpError(404, 'NOT_FOUND', `profile '${nameSeg}' is not stored yet`);
      }
      return {
        status: 200,
        body: await listProfileApiKeys(ctx.db, detail.row.profile_id, scope),
      };
    }
  }

  // AWEB-14: profile workflow choices are business/version scoped and kept
  // separately from immutable endpoint policy revisions.
  {
    const m = /^\/api\/v1\/admin\/profiles\/([^/]+)\/([^/]+)\/([^/]+)\/workflows$/.exec(pathname);
    if (m && (method === 'GET' || method === 'POST')) {
      const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!principal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      if (method === 'POST' && principal.role === 'tenant_operator') {
        throw new HttpError(403, 'PERMISSION_DENIED', 'profile workflow changes require the platform admin role');
      }
      const businessId = decodeURIComponent(m[1]!);
      const businessVersion = decodeURIComponent(m[2]!);
      const profileName = decodeURIComponent(m[3]!);
      const requestedTenant = ctx.searchParams.get('tenantId') || null;
      const scope = authorizeAuditTenantRead(principal, requestedTenant ?? '');
      const tenantId = scope === '' ? requestedTenant : scope;
      if (!tenantId) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId is required for profile workflow selection');
      }
      const identity = { tenantId, businessId, businessVersion, profileName };
      if (method === 'GET') {
        return { status: 200, body: await listProfileWorkflows(ctx.db, identity) };
      }

      const body = ctx.body;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'workflow selection body must be an object');
      }
      const selection = body as Record<string, unknown>;
      if (Object.keys(selection).some((key) => !['workflowSlug', 'workflowRevision', 'enabled'].includes(key))) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'workflow selection contains unsupported fields');
      }
      const workflowSlug = selection.workflowSlug;
      const workflowRevision = selection.workflowRevision;
      const enabled = selection.enabled;
      if (typeof workflowSlug !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(workflowSlug)
          || typeof workflowRevision !== 'number' || !Number.isSafeInteger(workflowRevision) || workflowRevision < 1
          || typeof enabled !== 'boolean') {
        throw new HttpError(422, 'INVALID_SCHEMA', 'workflowSlug, positive workflowRevision, and enabled are required');
      }
      const result = await auditedMutation(
        ctx.db,
        ctx.audit,
        (client) => setProfileWorkflowBinding(client, identity, { workflowSlug, workflowRevision, enabled }),
        (saved) => ({
          tenantId: saved.tenantId,
          actor: 'admin',
          actorRole: principal.role,
          action: 'profile_workflow.set',
          resource: `profile:${saved.profileId}/workflow:${workflowSlug}:${workflowRevision}`,
          severity: 'info',
          correlationId: ctx.correlationId,
        }),
      );
      return {
        status: 200,
        body: { businessId, businessVersion, workflowSlug, workflowRevision, enabled },
      };
    }
  }

  // CONNECTOR-WIRE-A: platform connector management surface — thin reads over
  // the composed store (no business logic in a route); mutations ride
  // /api/v1/admin/actions (connector.*). Capabilities include composition
  // booleans and configured connector ID keys only; configuration values
  // never leave this route. Without the store, management calls fail closed
  // (503) while ID suggestions remain available.
  if (method === 'GET' && pathname === '/api/v1/admin/connectors/capabilities') {
    assertAdminAuth(ctx);
    return {
      status: 200,
      body: {
        management: !!ctx.connectorManagement,
        credentialWorkflow: !!ctx.credentialWorkflow,
        test: !!ctx.connectorManagement,
        knownConnectorIds: Object.keys(ctx.config.connectorBaseUrls ?? {}).filter((id) => id !== '*'),
      },
    };
  }
  if (method === 'GET' && pathname === '/api/v1/admin/connectors') {
    assertAdminAuth(ctx);
    if (!ctx.connectorManagement) {
      throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'connector management store not configured');
    }
    try {
      return { status: 200, body: { items: await ctx.connectorManagement.list() } };
    } catch (err) {
      // Normalize the proxy's transport failure at the route boundary. The
      // admin client gets a stable service-level error, never an upstream URL
      // or transport message; schema/API errors retain their existing codes.
      if (isHttpError(err) && err.status !== 503) throw err;
      throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'connector management service is unavailable');
    }
  }

  // Admin: GET /api/v1/admin/connectors/:id/revisions/:rev  (ADM-BASE-01)
  // Shell wire-up (`latest` sentinel supported). CONNECTOR-WIRE-A: with the
  // management store composed this reads the REAL connector ledger (redacted
  // by the connector, re-validated against the platform DTO). Without the
  // store the honest placeholder below stays the explicit degraded answer —
  // never fabricated revision data either way.
  {
    const m = /^\/api\/v1\/admin\/connectors\/([^/]+)\/revisions\/([^/]+)$/.exec(pathname);
    if (m && method === 'GET') {
      assertAdminAuth(ctx);
      const connectorId = decodeURIComponent(m[1]!);
      const revSeg = decodeURIComponent(m[2]!);
      // CONNECTOR-WIRE-A: real ledger when the proxy is composed.
      if (ctx.connectorManagement) {
        try {
          const revision =
            revSeg === 'latest' || revSeg === 'current'
              ? await ctx.connectorManagement.getCurrent(connectorId)
              : await ctx.connectorManagement.getRevision(connectorId, parseInt(revSeg, 10));
          if (!revision) {
            throw new HttpError(404, 'NOT_FOUND', `connector '${connectorId}' revision '${revSeg}' is not on the server`);
          }
          return { status: 200, body: revision };
        } catch (err) {
          if (isHttpError(err) && err.status === 503) {
            // Unreachable connector service falls through to honest configured placeholder
          } else {
            throw err;
          }
        }
      }
      const baseUrls = ctx.config.connectorBaseUrls ?? {};
      const base = baseUrls[connectorId];
      if (!base) throw new HttpError(404, 'NOT_FOUND', `connector '${connectorId}' is not configured`);
      const revision = revSeg === 'latest' ? 1 : parseInt(revSeg, 10);
      if (!Number.isSafeInteger(revision) || revision < 1) {
        throw new HttpError(404, 'NOT_FOUND', `connector '${connectorId}' revision '${revSeg}' is not on the server`);
      }
      let maskedHost = '';
      try {
        maskedHost = new URL(base).host.replace(/^(.)[^@]*(@)?/, '$1***$2');
      } catch {
        maskedHost = '';
      }
      return {
        status: 200,
        body: {
          connectorId,
          revision,
          adapter: 'unknown',
          endpoint: { kind: 'configured', maskedHost },
          capabilities: [],
          state: 'disabled',
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          secretSlots: [],
          testResult: null,
        },
      };
    }
  }

  // Admin: GET /api/v1/admin/api-keys + /:keyId  (ADM-BASE-01)
  // Shell wire-up: `{ rows, grants, createCopyOnce }`. The raw key is
  // NEVER on the wire — only the stored prefix + id/tenant/status.
  // Grants are projected per key from profile_bindings (display-only;
  // the server remains the authorization authority). createCopyOnce is
  // always null here (copy-once belongs to the POST-create response,
  // which does not exist yet — no create route, no window to report).
  {
    const m = /^\/api\/v1\/admin\/api-keys(?:\/([^/]+))?$/.exec(pathname);
    if (m && method === 'GET') {
      // ADM-BASE-02: accept the tenant-operator bearer as well, but its
      // list is FORCED to its own tenant (foreign ?tenantId= -> 403) and
      // foreign by-id keys are indistinguishable 404. Platform unchanged.
      const keysPrincipal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!keysPrincipal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      const keyId = m[1] ? decodeURIComponent(m[1]) : null;

      // W-ADMUX02-EXT-1: the list path now pages in SQL. It used to be
      // `SELECT ... ORDER BY created_at DESC` with NO limit — the whole table
      // read on every request, then filtered in JavaScript — which is exactly
      // what ADM-UX-02 forbids ("không triển khai search bằng cách fetch toàn bộ
      // dữ liệu rồi lọc trong browser"). The tenant scope is a SQL predicate
      // for BOTH principals now, so an operator's foreign ?tenantId= can never
      // reach the wire even as a row that is later dropped.
      if (keyId) {
        const one = await ctx.db.query<Record<string, unknown>>(
          `SELECT id, tenant_id, prefix, name, status, created_at, updated_at FROM api_keys WHERE id=$1`,
          [keyId]
        );
        if (!one.rowCount) throw new HttpError(404, 'NOT_FOUND', `api key '${keyId}' not found`);
        requireResourceTenant(keysPrincipal, (one.rows[0] as { tenant_id: string }).tenant_id);
        return {
          status: 200,
          body: await buildApiKeyPage(ctx, keysPrincipal, one.rows as unknown as ApiKeyDbRow[], null),
        };
      }

      const query = parseApiKeyListQuery(ctx.searchParams);
      const scope = authorizeAuditTenantRead(keysPrincipal, query.tenantId ?? '');
      if (scope === '') {
        return {
          status: 200,
          body: await buildApiKeyPage(ctx, keysPrincipal, [], query),
        };
      }
      const page = await listApiKeyPage(ctx.db, scope, query);
      return {
        status: 200,
        body: await buildApiKeyPage(ctx, keysPrincipal, page.rows, query, page),
      };
    }
  }

  // Admin: GET/POST /api/v1/admin/crypto-config  (ENC-08-WIRING, Delta 97).
  //
  // GET returns the tenant's crypto configuration as the ENC-08 view model (key REFS,
  // versions and fingerprint PREVIEWS - never key material). POST applies a change
  // through the same handler the unit tests drive, so the wire surface and the tested
  // surface cannot diverge.
  //
  // Authorization: the platform bearer and the tenant-scoped operator bearer both
  // resolve through the shared rbac.ts principal; a COOKIE-authenticated mutation
  // additionally has to present the server-derived CSRF token, because a cross-site
  // page can send the cookie but cannot forge the HMAC.
  //
  // Unconfigured (no `cryptoConfig` block) the route answers 503 rather than pretending
  // a platform has no crypto settings to manage.
  {
    if (pathname === '/api/v1/admin/crypto-config' && (method === 'GET' || method === 'POST')) {
      if (!ctx.cryptoConfig) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'crypto configuration is not enabled');
      }
      const principal = resolveAdminPrincipal(ctx.config, ctx.headers['authorization']);
      if (!principal) {
        throw new HttpError(401, 'UNAUTHENTICATED', 'admin endpoints require an admin token');
      }
      // A cookie session is identified by the SIGNED du_admin cookie, and its role is
      // READ OUT OF THE VERIFIED CLAIMS - never from a request header. A header would
      // be a caller-chosen field, and the whole admin model is that the role comes
      // from the credential (ADM-BASE-02). The handler needs the raw cookie value to
      // re-derive the CSRF token, and the secret to do that.
      const sessionCookie = parseCookieHeader(ctx.headers['cookie'] ?? '')['du_admin'];
      const cookieClaims =
        sessionCookie && ctx.config.adminShellCookieSecret
          ? verifyCookie(ctx.config.adminShellCookieSecret, sessionCookie)
          : null;
      const auth = {
        principal,
        cookieRole: cookieClaims?.role,
        cookieSecret: ctx.config.adminShellCookieSecret,
        sessionCookie,
        csrfToken: ctx.headers['x-csrf-token'],
      };
      if (method === 'GET') {
        const tenant = ctx.searchParams.get('tenantId') ?? '';
        const view = await readCryptoConfig(ctx.cryptoConfig, {
          auth,
          tenantId: tenant === '' ? undefined : tenant,
        });
        return {
          status: 200,
          body: { schemaVersion: '1', tenantId: view.tenantId, crypto: view },
        };
      }
      const body = (ctx.body ?? {}) as {
        tenantId?: unknown;
        storageKeyRef?: unknown;
        deliveryEncryption?: unknown;
        recipientKeyVersion?: unknown;
      };
      if (typeof body.deliveryEncryption !== 'boolean' && body.deliveryEncryption !== undefined) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'deliveryEncryption must be a boolean');
      }
      if (
        body.recipientKeyVersion !== undefined
        && body.recipientKeyVersion !== null
        && typeof body.recipientKeyVersion !== 'number'
      ) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'recipientKeyVersion must be a number or null');
      }
      if (body.storageKeyRef !== undefined && typeof body.storageKeyRef !== 'string' && body.storageKeyRef !== null) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'storageKeyRef must be a string or null');
      }
      // The tenant is the same fact on both verbs, so both read it the same
      // way: the query parameter, with the body as a fallback for form posts.
      const queryTenant = ctx.searchParams.get('tenantId') ?? '';
      const bodyTenant = typeof body.tenantId === 'string' ? body.tenantId : '';
      const targetTenant = bodyTenant !== '' ? bodyTenant : queryTenant;
      const result = await applyCryptoConfig(ctx.cryptoConfig, {
        auth,
        tenantId: targetTenant === '' ? undefined : targetTenant,
        mutation: {
          storageKeyRef: body.storageKeyRef as string | null | undefined,
          deliveryEncryption: body.deliveryEncryption as boolean | undefined,
          recipientKeyVersion: body.recipientKeyVersion as number | null | undefined,
        },
      });
      return {
        status: 200,
        body: {
          schemaVersion: '1',
          tenantId: result.change.tenantId,
          changedFields: result.change.fields,
          crypto: result.view,
        },
      };
    }
  }

  // Admin: GET /api/v1/admin/audit  (ADM-BASE-01, ADM-UX-02 extension
  // W-ADMUX02-EXT-1). Reads the REAL ledger (migration 0010 admin_audit_events)
  // with a tenant predicate, an allow-listed `severity`/`action` filter and a
  // keyset cursor, and answers the standard five-field page envelope
  // { items, nextCursor, prevCursor, total, limit } — the { tenantId, events }
  // shape it used to return is gone, so the overview fetcher reads `items`
  // (and still tolerates `events` from an older build mid-rollout). Events whose
  // tenant_id is NULL (platform-global: business enable/activate/drain,
  // deadline sweep) never match a tenant predicate — they belong to a future
  // platform-wide admin view, not to any single tenant's pane.
  if (method === 'GET' && pathname === '/api/v1/admin/audit') {
    // R3-02: the requested tenant is AUTHORIZED, not trusted. The scope
    // comes from the authenticated credential (platform bearer → any
    // tenant, the operator-console view; tenant bearer → exactly its own
    // tenant, 403 on foreign scope), never from the query param alone.
    const principal = resolveAdminAuditPrincipal(ctx.config, ctx.headers['authorization']);
    const query = parseAdminAuditListQuery(ctx.searchParams);
    // ADM-BASE-02 / R3-02 unchanged in force: the SCOPE comes from the
    // credential, never from the parameter. A platform principal may narrow to
    // any tenant; a tenant operator is pinned to its own tenant and 403s on a
    // foreign one, with identical wording for foreign and unknown ids.
    const scope = authorizeAuditTenantRead(principal, query.tenantId ?? '');
    // No tenant selected → no tenant-scoped events: an honest empty page, kept
    // from the pre-ledger behaviour. Platform-global rows carry a NULL tenant
    // and belong to a future platform-wide view, not to any tenant's pane.
    if (scope === '') {
      return {
        status: 200,
        body: listPage({ items: [], nextCursor: null, prevCursor: null, total: 0, limit: query.limit }),
      };
    }
    return {
      status: 200,
      body: await listAuditEventPage(ctx, scope, query),
    };
  }

  // Admin: Secret Catalog (SC-01 / SC-03)
  // GET /api/v1/admin/secrets
  if (method === 'GET' && pathname === '/api/v1/admin/secrets') {
    assertAdminAuth(ctx);
    const query = parseSecretCatalogListQuery(ctx.searchParams);
    const tenantTokenSeed = Object.entries(ctx.config.tenantAdminTokens ?? {})
      .filter(([, token]) => typeof token === 'string' && token.length > 0)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([tenantId, token]) => `${tenantId}:${token}`)
      .join('\n');
    const cursorSecret = ctx.config.adminShellCookieSecret || ctx.config.adminToken || tenantTokenSeed;
    if (!cursorSecret) {
      throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'secret catalog cursor signing is unavailable');
    }
    const page = await listSecretsFromDb(ctx.db, query, cursorSecret);
    return { status: 200, body: page };
  }

  // POST /api/v1/admin/secrets (create/link)
  if (method === 'POST' && pathname === '/api/v1/admin/secrets') {
    assertAdminAuth(ctx);
    const parsed = SecretCatalogCreateSchema.safeParse(ctx.body);
    if (!parsed.success) {
      throw new HttpError(422, 'INVALID_SCHEMA', parsed.error.issues[0]?.message ?? 'invalid secret create payload');
    }
    await validateGlobalManagedSecretCreate(ctx, parsed.data);
    const created = await createSecretInDb(ctx.db, parsed.data, undefined, ctx.config.secretCatalogKeyring, ctx.backupSnapshotWriteGate);
    return { status: 201, body: created };
  }

  // POST /api/v1/admin/secrets/:secretId/rotate
  {
    const m = /^\/api\/v1\/admin\/secrets\/([^/]+)\/rotate$/.exec(pathname);
    if (m && method === 'POST') {
      assertAdminAuth(ctx);
      const secretId = decodeURIComponent(m[1]!);
      await assertGlobalSecretLifecycle(ctx, secretId, 'rotate');
      const parsed = SecretCatalogRotateSchema.safeParse({ ...(ctx.body as object), secretId });
      if (!parsed.success) {
        throw new HttpError(422, 'INVALID_SCHEMA', parsed.error.issues[0]?.message ?? 'invalid secret rotate payload');
      }
      const rotated = await rotateSecretInDb(ctx.db, secretId, parsed.data, undefined, ctx.config.secretCatalogKeyring, ctx.backupSnapshotWriteGate);
      return { status: 200, body: rotated };
    }
  }

  // POST /api/v1/admin/secrets/:secretId/disable
  {
    const m = /^\/api\/v1\/admin\/secrets\/([^/]+)\/disable$/.exec(pathname);
    if (m && method === 'POST') {
      assertAdminAuth(ctx);
      const secretId = decodeURIComponent(m[1]!);
      await assertGlobalSecretLifecycle(ctx, secretId, 'disable');
      const parsed = SecretCatalogDisableSchema.safeParse({ ...(ctx.body as object), secretId });
      if (!parsed.success) {
        throw new HttpError(422, 'INVALID_SCHEMA', parsed.error.issues[0]?.message ?? 'invalid secret disable payload');
      }
      const disabled = await disableSecretInDb(ctx.db, secretId, parsed.data, ctx.backupSnapshotWriteGate);
      return { status: 200, body: disabled };
    }
  }

  // POST /api/v1/admin/secrets/:secretId/test (probe)
  {
    const m = /^\/api\/v1\/admin\/secrets\/([^/]+)\/test$/.exec(pathname);
    if (m && method === 'POST') {
      assertAdminAuth(ctx);
      const secretId = decodeURIComponent(m[1]!);
      await assertGlobalSecretLifecycle(ctx, secretId, 'test');
      const probe = await testSecretInDb(ctx.db, secretId, undefined, ctx.config.secretCatalogKeyring);
      return { status: 200, body: probe };
    }
  }

  return null;
}
