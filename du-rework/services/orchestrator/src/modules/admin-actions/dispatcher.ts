import type { PoolClient } from 'pg';
import { auditedMutation, type AuditService } from '../audit/audit';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import { canonicalPayloadHash, executeIdempotent } from '../idempotency/idempotency';
import type { LifecycleService } from '../lifecycle/lifecycle';
import type { ProfileService } from '../profiles/profiles';
import type { RegistryService } from '../registry/registry';
import { type AdminActionAuth, type AdminPrincipal, type AdminSecurityAuditSink } from './rbac';
import type { CredentialWorkflow } from '../connector-credentials/workflow';

/**
 * ADM-BASE-02 action dispatcher (cycle 84): the admin mutations that
 * exist as bespoke routes today (enable/activate/drain/bind/sweep) get
 * ONE matcher + role table + tenant gate behind a single POST-only
 * resource — the row requires an action dispatcher whose actions run
 * with a trusted principal and whose denials have ZERO side effects.
 *
 * RBAC model:
 *  - bearer platform  -> every action.
 *  - bearer tenant_operator -> ONLY 'apikey.bind-profile', and only keys
 *    whose tenant equals the credential (authorizeBindingTenant, 403).
 *    Every other action: 403 'requires the platform admin role'.
 *  - cookie session (shell) -> mutations need csrfOk FIRST, then a role
 *    the action's cookieRoles allows: 'admin' acts as platform; 'operator'
 *    only on the operation-control pair AND only when the OIDC-02 session
 *    carried its tenant server-side (CYCLE-108/113). CSRF is checked
 *    BEFORE the role so a token-less cross-site POST cannot even probe
 *    the role table. viewer cookies and operator-without-tenant: 403.
 *  - unknown action -> 404 (never GET-as-success: the route-level
 *    adminActionsMethodGuard answers 405 for non-POST).
 *
 * W-OIDC03-RBAC-1: the whole (role, action, tenant) triple now lives in
 * ONE pure gate — assertRoleActionTenant — and authorizeAdminAction is
 * its two-dimensional form. When the caller is tenant-scoped and the
 * SERVER-side tenant of the target resource is known at the gate, a
 * mismatch denies with authorizeBindingTenant's exact wording (same for
 * foreign and unknown/absent: no existence leak). Decision objects,
 * statuses and messages for every pre-existing cell are unchanged.
 *
 * Execution DELEGATES to the same primitives the direct routes use
 * (auditedMutation single-transaction audit, profiles/registry/lifecycle
 * with the tx client, executeIdempotent for retries) — no logic is
 * re-implemented here, so both entry points cannot drift.
 */

export interface AdminActionDeps {
  db: Db;
  audit: AuditService;
  registry: RegistryService;
  profiles: ProfileService;
  lifecycle: LifecycleService;
  runtime: {
    resumeOperation(
      operationId: string,
      tenantId: string,
      body: unknown,
      client?: PoolClient
    ): Promise<{ replayed?: boolean; [k: string]: unknown }>;
  };
  hashApiKey: (raw: string) => string;
  correlationId: string;
  /** VAULT-04: absent → every connectors.* credential action fails closed (503). */
  credentialWorkflow?: CredentialWorkflow;
  /** VAULT-04: probe passthrough (ctx.connectors.testConnector). */
  connectorTest?: (connectorId: string) => Promise<Record<string, unknown>>;
}

export interface AdminActionCall {
  action: string;
  params: Record<string, unknown>;
  idempotencyKey?: string;
}

export interface ActionDef {
  bearerRoles: Array<AdminPrincipal['role']>;
  cookieRoles: Array<'admin' | 'operator' | 'viewer'>;
}

export const ADMIN_ACTIONS_ROUTE = 'POST /api/v1/admin/actions';

/**
 * v1 action table. Kept deliberately to the orchestrator's existing admin
 * mutation surface. connector.rotate / provider-key actions, admin cancel
 * / replay etc. land here when their services exist — until then they are
 * 404 'unsupported', never silent no-ops.
 */
// OIDC-03 (SEC task line 19, cycle 96): credential/key mutations are
// ADMIN-ONLY — an operator, however tenant-scoped, may not bind api keys.
// The operator's approved admin surface is the operation-control set
// (cancel / resume), tenant-fenced by the services themselves (the public
// tenant fences return an indistinguishable 404 for foreign operations).
// Supersedes the cycle-82 experiment that let operators bind their own
// tenant's keys; the route below now 403s that too, in one place.
export const ADMIN_ACTIONS: Record<string, ActionDef> = {
  'business.enable': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  'business.activate': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  'business.drain': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  'operations.sweep-deadlines': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  'apikey.bind-profile': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  // ORCH-PAR-01: real API-key issuance and revocation. Admin-only for the
  // same reason as bind-profile (OIDC-03 line 19): a key write is a
  // credential write. The raw value reaches the store ONLY as the injected
  // hashApiKey digest — the raw never touches a column.
  'apikey.issue': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  'apikey.revoke': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  // CYCLE-108/113 REVIEW: 'operator' joins the cookie side of the
  // operation-control pair — the OIDC-02 session carries its tenant
  // server-side (AdminActionCookieAuth.tenantId), so an operator session
  // can act tenant-scoped. The gate below still 403s any operator auth
  // WITHOUT a server-side tenant (legacy du_admin can never be one).
  'operations.cancel': { bearerRoles: ['platform', 'tenant_operator'], cookieRoles: ['admin', 'operator'] },
  'operations.resume': { bearerRoles: ['platform', 'tenant_operator'], cookieRoles: ['admin', 'operator'] },
  // VAULT-04: provider-key credential actions are ADMIN-ONLY by SEC-00
  // (rotate writes Vault+revision; revoke kills routability; test probes the
  // real read). Operator/bearer-tenant never see this surface — 403 with
  // ZERO side effects (authorizeAdminAction runs before any workflow call).
  'connectors.rotate_credential': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  'connectors.revoke_credential': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
  'connectors.test_credential': { bearerRoles: ['platform'], cookieRoles: ['admin'] },
};

export type AdminActionDecision =
  | { ok: true }
  | { ok: false; status: number; code: string; message: string };

/**
 * The server-side tenant a SUCCESSFUL auth may act within: undefined =
 * unscoped (platform-equivalent: bearer platform or cookie 'admin'),
 * string = bound to exactly one tenant (bearer tenant_operator, or a
 * cookie 'operator' whose OIDC-02 session carried its tenant server-side
 * — the no-tenant operator was already denied by the role/presence
 * guards BEFORE this runs; viewer never passes the role table).
 */
function callerTenantOf(auth: AdminActionAuth): string | undefined {
  if (auth.kind === 'bearer') {
    return auth.principal.role === 'platform' ? undefined : auth.principal.tenantId;
  }
  if (auth.role === 'operator' && typeof auth.tenantId === 'string' && auth.tenantId.length > 0) {
    return auth.tenantId;
  }
  return undefined;
}

/**
 * OIDC-03 / W-OIDC03-RBAC-1 — the SEC-00 (role × action × tenant) matrix
 * in ONE pure gate, offline-testable, ZERO side effects by construction
 * (it reads the table + the auth context, nothing else). Default deny.
 * Order is load-bearing and unchanged from cycle-84/96/108 math:
 *  1. auth present (401), 2. action in table (404 — unknown actions never
 *  leak tenant info either), 3. CSRF before role (a token-less cross-site
 *  POST cannot probe the table), 4. role admits action, 5. an operator
 *  needs its SERVER-side tenant, 6. TENANT BINDING: when the caller is
 *  tenant-scoped and `resourceTenantId` (the stored tenant of the target
 *  row — never a caller claim or header) is supplied, it must equal the
 *  caller's tenant. A mismatch — foreign, empty, or tenantless row —
 *  answers authorizeBindingTenant's exact wording for EVERY value, so
 *  denied cells leak no existence. Passes return the ORIGINAL
 *  `{ ok: true }` shape (callers toEqual it).
 * `resourceTenantId === undefined` (omitted) keeps this exactly the
 * historical role × action decision.
 */
export function assertRoleActionTenant(
  auth: AdminActionAuth | null,
  action: string,
  resourceTenantId?: string | null,
  audit?: AdminSecurityAuditSink
): AdminActionDecision {
  if (!auth) {
    return {
      ok: false,
      status: 401,
      code: 'UNAUTHENTICATED',
      message: 'admin endpoints require an admin token or a signed-in shell session',
    };
  }
  const def = ADMIN_ACTIONS[action];
  if (!def) {
    return { ok: false, status: 404, code: 'NOT_FOUND', message: `unsupported admin action '${action}'` };
  }
  if (auth.kind === 'cookie') {
    if (!auth.csrfOk) {
      // W-SEC-AUDIT-TAXONOMY-1: auth.csrf_denied rides the SAME denial the
      // table already answers — never a new response shape, never a value
      // field. The gate performs no I/O itself: only the injected sink sees
      // this call, so omitting it keeps the pure gate byte-for-byte.
      audit?.({ kind: 'auth.csrf_denied', reason: 'csrf_missing_or_invalid', action });
      return {
        ok: false,
        status: 403,
        code: 'PERMISSION_DENIED',
        message: 'cookie-authenticated admin actions require a valid CSRF token',
      };
    }
    if (!def.cookieRoles.includes(auth.role)) {
      return {
        ok: false,
        status: 403,
        code: 'PERMISSION_DENIED',
        message: 'session role is not permitted for this action',
      };
    }
    // CYCLE-108/113: an operator cookie may only act where cookieRoles
    // allows AND the store bound it to one tenant. No server-side tenant
    // = no fence = fail closed (a role string alone must never reach a
    // tenant-scoped service, and principal-of-null would read as the
    // platform row-lookup path — exactly the hole this closes).
    if (
      auth.role === 'operator' &&
      (typeof auth.tenantId !== 'string' || auth.tenantId.length === 0)
    ) {
      return {
        ok: false,
        status: 403,
        code: 'PERMISSION_DENIED',
        message: 'operator sessions must carry a server-side tenant',
      };
    }
  } else if (!def.bearerRoles.includes(auth.principal.role)) {
    return {
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'action requires the platform admin role',
    };
  }
  if (resourceTenantId !== undefined) {
    const callerTenant = callerTenantOf(auth);
    if (callerTenant !== undefined && callerTenant !== resourceTenantId) {
      return {
        ok: false,
        status: 403,
        code: 'PERMISSION_DENIED',
        message: 'mutations are scoped to the caller tenant',
      };
    }
  }
  return { ok: true };
}

/** Pure gate — the whole role × action matrix in one function (OIDC-03:
 *  now the tenant-less face of assertRoleActionTenant, byte-identical
 *  decisions, kept as the stable name every route/test already uses). */
export function authorizeAdminAction(
  auth: AdminActionAuth | null,
  action: string,
  audit?: AdminSecurityAuditSink
): AdminActionDecision {
  return assertRoleActionTenant(auth, action, undefined, audit);
}

function requireParams<K extends string>(call: AdminActionCall, names: K[]): Record<K, string> {
  const out = {} as Record<K, string>;
  for (const n of names) {
    const v = call.params[n];
    if (typeof v !== 'string' || v.length === 0) {
      throw new HttpError(422, 'INVALID_SCHEMA', `params.${n} is required`);
    }
    out[n] = v;
  }
  return out;
}

/**
 * Tenant resolution for operation-control actions. An operator acts with
 * ITS OWN credential tenant and the tenant-scoped service 404s foreign
 * ids (indistinguishable — no existence leak); the call never learns
 * whether the id exists elsewhere. The platform principal resolves the
 * row's own tenant, 404ing an unknown id the same way.
 */
async function resolveOpTenant(
  deps: AdminActionDeps,
  principal: AdminPrincipal | null,
  operationId: string,
  client: PoolClient
): Promise<string> {
  if (principal && principal.role === 'tenant_operator') return principal.tenantId;
  const res = await client.query<{ tenant_id: string }>(
    'SELECT tenant_id FROM operations WHERE id=$1',
    [operationId]
  );
  if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', 'not found');
  return res.rows[0]!.tenant_id;
}

/** Audit attribution: operator rows are tenant-scoped, platform rows are global. */
function auditTenantForOp(principal: AdminPrincipal | null): string | null {
  return principal && principal.role === 'tenant_operator' ? principal.tenantId : null;
}

function principalOf(auth: AdminActionAuth): AdminPrincipal | null {
  if (auth.kind === 'bearer') return auth.principal;
  // Cookie role 'admin' maps to platform for the tenant gates. An
  // 'operator' cookie resolves to a tenant_operator ONLY when the
  // SERVER-SIDE session record carried its tenant (CYCLE-108/113);
  // authorizeAdminAction already 403s operator-without-tenant, so the
  // guard here is belt-and-braces, never a silent platform fallback.
  if (auth.role === 'admin') return { role: 'platform' };
  if (auth.role === 'operator' && typeof auth.tenantId === 'string' && auth.tenantId.length > 0) {
    return { role: 'tenant_operator', tenantId: auth.tenantId };
  }
  return null;
}

function actorOf(auth: AdminActionAuth): string {
  return auth.kind === 'bearer' ? 'admin' : `shell:${auth.role}`;
}

export async function dispatchAdminAction(
  deps: AdminActionDeps,
  auth: AdminActionAuth | null,
  call: AdminActionCall
): Promise<{ status: number; body: Record<string, unknown> }> {
  // OIDC-03 triple gate, entry face (role × action; the tenant dimension
  // re-asserts below once a SERVER-side resource tenant is known).
  const decision = assertRoleActionTenant(auth, call.action);
  if (!decision.ok) {
    throw new HttpError(decision.status, decision.code, decision.message);
  }
  const principal = auth ? principalOf(auth) : null;
  const actor = auth ? actorOf(auth) : 'admin';
  const idem = {
    key: call.idempotencyKey,
    route: ADMIN_ACTIONS_ROUTE,
    payloadHash: canonicalPayloadHash({ action: call.action, params: call.params }),
  };

  switch (call.action) {
    case 'business.enable': {
      const p = requireParams(call, ['businessId', 'version']);
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        await auditedMutation(
          deps.db,
          deps.audit,
          async (client) => {
            const result = await client.query(
              'UPDATE business_versions SET status=$3, updated_at=now() WHERE business_id=$1 AND version=$2',
              [p.businessId, p.version, 'ENABLED']
            );
            if (!result.rowCount) {
              throw new HttpError(404, 'NOT_FOUND', `business ${p.businessId}@${p.version} not registered`);
            }
          },
          () => ({
            tenantId: null,
            actor,
            action: 'business.enable',
            resource: `business:${p.businessId}@${p.version}`,
            severity: 'success',
            correlationId: deps.correlationId,
          }),
          call.idempotencyKey
            ? (client) => withMarker(client, { status: 200, body: { businessId: p.businessId, version: p.version, status: 'ENABLED' } })
            : undefined
        );
        return { status: 200, body: { businessId: p.businessId, version: p.version, status: 'ENABLED' } };
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'business.activate':
    case 'business.drain': {
      const p = requireParams(call, ['businessId', 'version']);
      const isActivate = call.action === 'business.activate';
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        const result = await auditedMutation(
          deps.db,
          deps.audit,
          (client) =>
            isActivate
              ? deps.registry.activateVersion(p.businessId, p.version, client)
              : deps.registry.deactivateVersion(p.businessId, p.version, client),
          (r) => ({
            tenantId: null,
            actor,
            action: isActivate ? 'business.activate' : 'business.drain',
            resource: `business:${r.businessId}@${r.version}`,
            severity: isActivate ? 'info' : 'warning',
            correlationId: deps.correlationId,
          }),
          call.idempotencyKey
            ? (client, r) => withMarker(client, { status: r.replayed ? 200 : 202, body: r as unknown as Record<string, unknown> })
            : undefined
        );
        return { status: result.replayed ? 200 : 202, body: result as unknown as Record<string, unknown> };
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'operations.sweep-deadlines': {
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        const count = await auditedMutation(
          deps.db,
          deps.audit,
          (client) => deps.lifecycle.sweepDeadlines(client),
          () => ({
            tenantId: null,
            actor,
            action: 'operation.deadline',
            resource: 'operations:deadline-sweep',
            severity: 'warning',
            correlationId: deps.correlationId,
          }),
          call.idempotencyKey
            ? (client, c) => withMarker(client, { status: 200, body: { timedOut: c } })
            : undefined
        );
        return { status: 200, body: { timedOut: count } };
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'operations.cancel': {
      const p = requireParams(call, ['operationId']);
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        const result = await auditedMutation(
          deps.db,
          deps.audit,
          async (client) => {
            // Tenant fence lives IN the service call: an operator's foreign
            // id gets the service's indistinguishable 404 (no audit, tx
            // rolled back). Platform resolves the row's own tenant.
            const tenantId = await resolveOpTenant(deps, principal, p.operationId, client);
            // OIDC-03 triple re-assert with the resolved SERVER-side tenant
            // (belt-and-braces: a tenant-scoped caller can only ever see its
            // own id flow further — drift here fails closed, in this tx).
            const fence = assertRoleActionTenant(auth, 'operations.cancel', tenantId);
            if (!fence.ok) {
              throw new HttpError(fence.status, fence.code, fence.message);
            }
            return deps.lifecycle.cancelOperation(p.operationId, tenantId, client);
          },
          () => ({
            tenantId: auditTenantForOp(principal),
            actor,
            action: 'operation.cancel',
            resource: `operation:${p.operationId}`,
            severity: 'warning',
            correlationId: deps.correlationId,
          }),
          call.idempotencyKey
            ? (client, r) => withMarker(client, { status: 200, body: r as unknown as Record<string, unknown> })
            : undefined
        );
        return { status: 200, body: result as unknown as Record<string, unknown> };
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'operations.resume': {
      const p = requireParams(call, ['operationId']);
      const body =
        typeof call.params.body === 'object' && call.params.body !== null
          ? call.params.body
          : {};
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        const result = await auditedMutation(
          deps.db,
          deps.audit,
          async (client) => {
            const tenantId = await resolveOpTenant(deps, principal, p.operationId, client);
            const fence = assertRoleActionTenant(auth, 'operations.resume', tenantId);
            if (!fence.ok) {
              throw new HttpError(fence.status, fence.code, fence.message);
            }
            // Cycle-99 reviewer fix: the caller's open tx client goes INTO
            // the service — resume mutation + audit row share ONE atomic
            // transaction (cancel already did; resume now matches).
            return deps.runtime.resumeOperation(p.operationId, tenantId, body, client);
          },
          () => ({
            tenantId: auditTenantForOp(principal),
            actor,
            action: 'operation.resume',
            resource: `operation:${p.operationId}`,
            severity: 'info',
            correlationId: deps.correlationId,
          }),
          call.idempotencyKey
            ? (client, r) => withMarker(client, { status: 200, body: r as unknown as Record<string, unknown> })
            : undefined
        );
        return { status: 200, body: result as unknown as Record<string, unknown> };
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'apikey.bind-profile': {
      const p = requireParams(call, ['apiKey', 'businessId', 'businessVersion', 'action']);
      const connectorBindings =
        typeof call.params.connectorBindings === 'object' && call.params.connectorBindings !== null
          ? call.params.connectorBindings
          : {};
      const keyHash = deps.hashApiKey(p.apiKey);
      if (principal && principal.role === 'tenant_operator') {
        // Tenant gate BEFORE any write: foreign or unknown target key ->
        // 403/404 with zero mutation calls (proven by the offline matrix).
        const keyTenant = await deps.db.query<{ tenant_id: string }>(
          'SELECT tenant_id FROM api_keys WHERE hash=$1 AND status=$2',
          [keyHash, 'ACTIVE']
        );
        if (!keyTenant.rowCount) {
          throw new HttpError(404, 'NOT_FOUND', 'api key not found or not ACTIVE');
        }
        // OIDC-03 triple: the key's STORED tenant rides the same gate —
        // same 403 wording authorizeBindingTenant used (foreign and
        // unknown indistinguishable).
        const bindFence = assertRoleActionTenant(auth, 'apikey.bind-profile', keyTenant.rows[0]!.tenant_id);
        if (!bindFence.ok) {
          throw new HttpError(bindFence.status, bindFence.code, bindFence.message);
        }
      }
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        const result = await auditedMutation(
          deps.db,
          deps.audit,
          (client) =>
            deps.profiles.createRevision(
              {
                profileId: typeof call.params.profileId === 'string' ? call.params.profileId : undefined,
                apiKeyHash: keyHash,
                businessId: p.businessId,
                businessVersion: p.businessVersion,
                action: p.action,
                connectorBindings,
              },
              client
            ),
          (r) => ({
            tenantId: r.tenantId,
            actor,
            action: 'profile_binding.bind',
            resource: `apikey:${r.apiKeyId}`,
            severity: 'info',
            correlationId: deps.correlationId,
          }),
          call.idempotencyKey
            ? (client, r) => withMarker(client, { status: 201, body: r as unknown as Record<string, unknown> })
            : undefined
        );
        return { status: 201, body: result as unknown as Record<string, unknown> };
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'apikey.issue': {
      // ORCH-PAR-01. The RAW value is accepted on the wire and reaches the
      // store ONLY as the injected digest (deps.hashApiKey) — mirroring
      // apikey.bind-profile, which hashes the caller's key the same way.
      // It comes back ONCE in the 201 body and is never persisted, which is
      // the copy-once contract the admin create view already renders.
      const p = requireParams(call, ['tenantId', 'apiKey']);
      if (p.tenantId.length === 0 || p.tenantId.length > 64) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'params.tenantId is invalid');
      }
      if (p.apiKey.length < 8) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'params.apiKey is too short to be a key');
      }
      // Tenant fence BEFORE the write, on the same gate the other key
      // actions use. A tenant-scoped caller naming another tenant is 403
      // with zero side effects.
      const issueFence = assertRoleActionTenant(auth, 'apikey.issue', p.tenantId);
      if (!issueFence.ok) {
        throw new HttpError(issueFence.status, issueFence.code, issueFence.message);
      }
      const keyHash = deps.hashApiKey(p.apiKey);
      // Display prefix only (the column is documented as such); defaults to
      // the same four-character window the admin view model masks to.
      const prefix =
        typeof call.params.prefix === 'string' && call.params.prefix.length > 0
          ? call.params.prefix
          : p.apiKey.slice(0, 4);
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        const result = await auditedMutation(
          deps.db,
          deps.audit,
          async (client) => {
            const inserted = await client.query<{ id: string; status: string; created_at: Date }>(
              'INSERT INTO api_keys (tenant_id, hash, prefix) VALUES ($1, $2, $3) RETURNING id, status, created_at',
              [p.tenantId, keyHash, prefix]
            );
            if (!inserted.rowCount) {
              throw new HttpError(500, 'INTERNAL', 'api key insert returned no row');
            }
            return inserted.rows[0]!;
          },
          (r) => ({
            tenantId: p.tenantId,
            actor,
            action: 'apikey.create',
            resource: `apikey:${r.id}`,
            severity: 'success',
            correlationId: deps.correlationId,
          }),
          call.idempotencyKey
            ? (client, r) =>
                withMarker(client, {
                  status: 201,
                  body: {
                    id: r.id,
                    tenantId: p.tenantId,
                    prefix,
                    status: r.status,
                    createdAt: r.created_at,
                    rawKey: p.apiKey,
                  },
                })
            : undefined
        );
        return {
          status: 201,
          body: {
            id: result.id,
            tenantId: p.tenantId,
            prefix,
            status: result.status,
            createdAt: result.created_at,
            // copy-once: the ONLY time the raw value leaves this handler
            rawKey: p.apiKey,
          },
        };
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'apikey.revoke': {
      // ORCH-PAR-01. Revocation flips the SAME status column the request
      // path filters on (server.ts resolveApiKey only resolves status=
      // 'ACTIVE'), so a revoked key stops authenticating immediately with
      // no second store to keep in step.
      const p = requireParams(call, ['apiKeyId']);
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        const result = await auditedMutation(
          deps.db,
          deps.audit,
          async (client) => {
            // Server-side tenant ONLY: the caller's claim never selects the
            // row, so an unknown and a foreign id are indistinguishable.
            const found = await client.query<{ id: string; tenant_id: string; status: string }>(
              'SELECT id, tenant_id, status FROM api_keys WHERE id=$1',
              [p.apiKeyId]
            );
            if (!found.rowCount) {
              throw new HttpError(404, 'NOT_FOUND', 'api key not found');
            }
            const row = found.rows[0]!;
            const revokeFence = assertRoleActionTenant(auth, 'apikey.revoke', row.tenant_id);
            if (!revokeFence.ok) {
              throw new HttpError(revokeFence.status, revokeFence.code, revokeFence.message);
            }
            if (row.status !== 'ACTIVE') {
              // Already revoked / mid-revocation: the state is fine, the
              // REQUEST is not — a conflict, not a schema error.
              throw new HttpError(409, 'STATE_CONFLICT', 'api key is not ACTIVE');
            }
            const updated = await client.query<{ id: string; tenant_id: string }>(
              "UPDATE api_keys SET status='REVOKED' WHERE id=$1 AND status='ACTIVE' RETURNING id, tenant_id",
              [row.id]
            );
            if (!updated.rowCount) {
              // The ACTIVE guard lost a race between the SELECT and here.
              throw new HttpError(409, 'STATE_CONFLICT', 'api key is not ACTIVE');
            }
            return updated.rows[0]!;
          },
          // Tenant comes from the UPDATED row, never from the caller's claim -
          // the same attribution bind-profile uses.
          (r) => ({
            tenantId: r.tenant_id,
            actor,
            action: 'apikey.revoke',
            resource: `apikey:${r.id}`,
            severity: 'warning',
            correlationId: deps.correlationId,
          }),
          call.idempotencyKey
            ? (client) => withMarker(client, { status: 200, body: { id: p.apiKeyId, status: 'REVOKED' } })
            : undefined
        );
        return { status: 200, body: { id: result.id, status: 'REVOKED' } };
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'connectors.rotate_credential': {
      const p = requireParams(call, ['connectorId', 'mount', 'path', 'key']);
      const value = call.params.value;
      if (typeof value !== 'string' || value.length === 0) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'params.value (write-only provider secret) is required');
      }
      const cas = call.params.cas;
      if (cas !== undefined && (typeof cas !== 'number' || !Number.isInteger(cas) || cas < 1)) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'params.cas must be a positive integer');
      }
      if (!deps.credentialWorkflow) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'credential workflow not wired');
      }
      const binding = await deps.credentialWorkflow.resolveBinding(p.connectorId);
      if (principal?.role === 'tenant_operator' && principal.tenantId !== binding.tenantId) {
        throw new HttpError(403, 'PERMISSION_DENIED', 'mutations are scoped to the caller tenant');
      }
      // VAULT-04 note: the Vault write + revision chain are EXTERNAL side
      // effects; a marker/audit failure rolls the DB row back while the
      // workflow result stands — reconcile/Idempotency-Key replay own that
      // window (same crash math as the workflow's CAS ordering).
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        return deps.db.tx(async (client) => {
          const res = await deps.credentialWorkflow!.rotate({
            connectorId: p.connectorId,
            // accountId is resolved from connector ownership above; it is not
            // accepted from the action payload as a trust anchor.
            ref: { account: binding.accountId, mount: p.mount, path: p.path, key: p.key },
            value,
            ...(typeof cas === 'number' ? { cas } : {}),
          });
          const metadata = await deps.credentialWorkflow!.describe(p.connectorId).catch(() => undefined);
          const resp = { status: 201, body: { ...res, ...(metadata ? { metadata } : {}) } };
          if (call.idempotencyKey) await withMarker(client, resp);
          await deps.audit.record(
            {
              tenantId: null,
              actor,
              action: 'connector.credential_rotate',
              resource: `connector:${p.connectorId}@rev${res.revision}`,
              severity: 'success',
              correlationId: deps.correlationId,
            },
            client
          );
          return resp;
        });
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'connectors.revoke_credential': {
      const p = requireParams(call, ['connectorId']);
      if (!deps.credentialWorkflow) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'credential workflow not wired');
      }
      const outcome = await executeIdempotent(deps.db, idem, async (withMarker) => {
        return deps.db.tx(async (client) => {
          const res = await deps.credentialWorkflow!.revoke(p.connectorId);
          const resp = { status: 200, body: { ...res } };
          if (call.idempotencyKey) await withMarker(client, resp);
          await deps.audit.record(
            {
              tenantId: null,
              actor,
              action: 'connector.credential_revoke',
              resource: `connector:${p.connectorId}${res.previousRevision ? '@rev' + res.previousRevision : ''}`,
              severity: 'warning',
              correlationId: deps.correlationId,
            },
            client
          );
          return resp;
        });
      });
      return { status: outcome.status, body: outcome.body as Record<string, unknown> };
    }
    case 'connectors.test_credential': {
      const p = requireParams(call, ['connectorId']);
      if (!deps.connectorTest) {
        throw new HttpError(503, 'TEMPORARY_UNAVAILABLE', 'connector test probe not wired');
      }
      const probe = await deps.connectorTest(p.connectorId);
      // MASKED passthrough: only ok/errorCode leave this handler — a probe
      // detail must never smuggle provider payloads or credential material.
      return {
        status: 200,
        body: {
          connectorId: p.connectorId,
          ok: probe.ok === true,
          ...(typeof probe.errorCode === 'string' ? { errorCode: probe.errorCode } : {}),
        },
      };
    }
    default:
      // unreachable: authorizeAdminAction 404s anything not in the table.
      throw new HttpError(404, 'NOT_FOUND', `unsupported admin action '${call.action}'`);
  }
}
