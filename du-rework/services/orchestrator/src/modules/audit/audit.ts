import { PoolClient, QueryResult, QueryResultRow } from 'pg';
import { Db } from '../../db/db';
import { authorizeAuditTenantRead, type AdminPrincipal } from '../admin-actions/rbac';

/** Anything that can run SQL — the pool wrapper (standalone) or a tx client. */
export interface Queryable {
  query<T extends QueryResultRow = QueryResultRow>(
    text: string,
    params?: unknown[]
  ): Promise<QueryResult<T>>;
}

/**
 * Admin audit ledger (W48-C1; ADM-BASE-01 + ADM-UX-04 unblock).
 *
 * Until migration 0010 there was NO ledger table, so
 * GET /api/v1/admin/audit returned a hardcoded empty list. This module is
 * the write/read path for the real ledger table `admin_audit_events`.
 *
 * Tenant scoping:
 *   * Tenant-scoped events (api-key profile bindings) carry the key's
 *     tenant_id — a tenant-scoped read (WHERE tenant_id = $1) never sees
 *     another tenant's events.
 *   * Platform-global events (business enable/activate/deactivate, deadline
 *     sweep) carry tenant_id NULL — business_versions is not tenant-scoped
 *     (migration 0001: PK is (business_id, version), no tenant column), so
 *     there is no honest tenant to attribute them to. They are readable only
 *     via listPlatformEvents (diagnostics / a future global admin view), never
 *     via the tenant-scoped list.
 *
 * Wire mapping uses the overview renderer's typed event kinds. A profile-binding
 * grant is `profile_binding.bind`; it is neither API-key creation nor
 * revocation. `occurredAt` is the ISO form of `created_at`, and `resource`
 * maps to the wire `resourceId`.
 */

export type AuditSeverity = 'info' | 'success' | 'warning' | 'error';

export interface AuditRecordInput {
  /** NULL for platform-global events (see module doc). */
  tenantId: string | null;
  /** Stable actor id. NEVER a raw credential — admin routes pass 'admin'. */
  actor: string;
  /** Renderer AuditEventKind where one describes the event honestly; otherwise
   *  a namespaced ledger kind (e.g. `profile_binding.bind`) — see module doc. */
  action: string;
  /** 'business:<id>@<version>' | 'apikey:<id>' | 'operations:deadline-sweep'. */
  resource: string;
  severity?: AuditSeverity;
  correlationId?: string;
}

export interface AuditWireEvent {
  id: string;
  kind: string;
  severity: string;
  occurredAt: string;
  tenantId: string | null;
  resourceId: string;
  actor: string;
  message: string;
}

interface AuditRow {
  id: string;
  tenant_id: string | null;
  actor: string;
  action: string;
  resource: string;
  severity: string;
  correlation_id: string | null;
  created_at: Date;
}

function toWire(row: AuditRow): AuditWireEvent {
  return {
    id: row.id,
    kind: row.action,
    severity: row.severity,
    occurredAt:
      row.created_at instanceof Date ? row.created_at.toISOString() : String(row.created_at),
    tenantId: row.tenant_id,
    resourceId: row.resource,
    actor: row.actor,
    message: `${row.action} ${row.resource}`,
  };
}

export function createAuditService(db: Db) {
  return {
    /**
     * Append one immutable ledger row. R3-01: pass the caller's open
     * transaction client as `executor` to bind the row to the mutation it
     * records — if this INSERT fails, the mutation rolls back with it.
     * Without an executor the row is written standalone (pool), which is
     * only correct for events that record no mutation.
     */
    async record(input: AuditRecordInput, executor?: Queryable): Promise<{ id: string }> {
      const res = await (executor ?? db).query<{ id: string }>(
        `INSERT INTO admin_audit_events
           (tenant_id, actor, action, resource, severity, correlation_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id`,
        [
          input.tenantId,
          input.actor,
          input.action,
          input.resource,
          input.severity ?? 'info',
          input.correlationId ?? null,
        ]
      );
      return { id: res.rows[0]!.id };
    },

    /**
     * Tenant-scoped read, newest first. Kept as the plain list seam (the
     * offline scope tests and any caller that just wants N rows use it); the
     * page route below adds the cursor and the count.
     */
    async listForTenant(tenantId: string, limit: number): Promise<AuditWireEvent[]> {
      const res = await db.query<AuditRow>(
        `SELECT id, tenant_id, actor, action, resource, severity, correlation_id, created_at
         FROM admin_audit_events
         WHERE tenant_id = $1
         ORDER BY created_at DESC, id DESC
         LIMIT $2`,
        [tenantId, limit]
      );
      return res.rows.map(toWire);
    },
  };
}

export type AuditService = ReturnType<typeof createAuditService>;

/** Authorize the tenant before querying the ledger; routes and offline tests share this seam. */
export async function listAuthorizedAuditEvents(
  audit: Pick<AuditService, 'listForTenant'>,
  principal: AdminPrincipal | null,
  requestedTenantId: string,
  limit: number
): Promise<{ tenantId: string; events: AuditWireEvent[] }> {
  const tenantId = authorizeAuditTenantRead(principal, requestedTenantId);
  const events = tenantId ? await audit.listForTenant(tenantId, limit) : [];
  return { tenantId, events };
}

/**
 * R3-01: run a mutation and its audit row in ONE database transaction.
 *
 * The audit INSERT executes on the same client as the mutation, inside
 * `db.tx`: any failure (audit table unavailable, constraint violation,
 * connection loss) rolls BOTH back, so the platform can never carry a
 * committed state mutation without its ledger entry (the previous
 * record-after-commit shape leaked exactly that). `auditOf` sees the
 * mutation result so routes can attribute tenant/resource from it
 * (e.g. profile-binding's tenantId). If the mutation throws, no audit
 * row is attempted — rejections propagate unchanged to the HTTP layer.
 */
export async function auditedMutation<T>(
  db: Db,
  audit: AuditService,
  mutate: (client: PoolClient) => Promise<T>,
  auditOf: (result: T) => AuditRecordInput,
  after?: (client: PoolClient, result: T) => Promise<void>
): Promise<T> {
  return db.tx(async (client) => {
    const result = await mutate(client);
    await audit.record(auditOf(result), client);
    // R2-A priority-5: same-tx side effects that must share the
    // mutation+audit fate (the idempotency marker). A failure here rolls
    // ALL of it back — mutation, audit row and marker commit together or
    // none of them exist.
    if (after) await after(client, result);
    return result;
  });
}
