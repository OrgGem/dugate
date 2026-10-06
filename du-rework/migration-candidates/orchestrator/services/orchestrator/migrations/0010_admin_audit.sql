-- W48-C1 (ADM-BASE-01 HIGH admin RBAC + ADM-UX-04 empty-events row): real
-- admin audit ledger. Until now GET /api/v1/admin/audit returned a hardcoded
-- empty list because no ledger table existed; the overview pane could never
-- surface a true event. This table is that ledger: every admin mutation
-- writes exactly one immutable row here (see src/modules/audit/audit.ts and
-- the admin write paths in server.ts).
--
-- Tenant scoping (docs 06 / overview-view-models AuditEventRow):
--   * Tenant-scoped events (api-key profile bindings) carry the key's
--     tenant_id, so a tenant-scoped read (WHERE tenant_id = $1) cannot see
--     another tenant's events.
--   * Platform-global events (business enable/activate/drain, deadline sweep)
--     carry a NULL tenant_id — business_versions is not tenant-scoped in this
--     schema (migration 0001 PK is (business_id, version), no tenant column),
--     so there is no honest tenant to attribute them to. They never appear in
--     a tenant-scoped read; a future platform-wide admin view can read the
--     NULL bucket explicitly.
--
-- Columns match the packet minimum: id, tenant_id, actor, action, resource,
-- severity, correlation_id, created_at. `action` values are the same union the
-- overview renderer already knows (overview-view-models AuditEventKind), so the
-- wire stays renderable without touching the UI view models.
-- Additive, forward-compatible CREATE IF NOT EXISTS (0007/0009 precedent).

CREATE TABLE IF NOT EXISTS admin_audit_events (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      uuid,                          -- NULL for platform-global events
  actor          text NOT NULL,                 -- stable actor id, NEVER a raw credential
  action         text NOT NULL,                 -- business.enable|business.activate|business.drain|apikey.create|...
  resource       text NOT NULL,                 -- business:<id>@<version> | apikey:<id> | operations:deadline-sweep
  severity       text NOT NULL DEFAULT 'info',  -- info|success|warning|error
  correlation_id text,
  created_at     timestamptz NOT NULL DEFAULT now()
);

-- Tenant-scoped, newest-first read path (the GET /api/v1/admin/audit predicate).
CREATE INDEX IF NOT EXISTS admin_audit_events_tenant_time
  ON admin_audit_events (tenant_id, created_at DESC);
-- Platform-wide newest-first scan (diagnostics / future global admin view).
CREATE INDEX IF NOT EXISTS admin_audit_events_time
  ON admin_audit_events (created_at DESC);
