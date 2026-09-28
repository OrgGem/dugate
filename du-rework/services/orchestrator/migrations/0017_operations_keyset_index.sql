-- W-ADMUX02-IDX-1 (ADM-UX-02, Reviewer Turn 40 Finding 1) + W-ADMUX02-IDX-2
-- (Reviewer Turn 50 Finding 1, delta 22): composite indexes for the operations
-- list KEYSET cursor added in W-ADMUX02-SRV-1.
--
-- The list route pages with ORDER BY created_at DESC, id DESC and the boundary
-- predicate (created_at, id) < (ts, id). 0001_platform_v1.sql only indexed
-- (tenant_id, created_at DESC), so the sort key was only half-covered: Postgres
-- could satisfy the ORDER BY from that index but not the id tiebreak, and had to
-- add a Sort node for every page. `id` is the mandatory tiebreak -- created_at is
-- not unique, so without it rows sharing an instant can be skipped or repeated
-- across pages.
--
-- TWO access paths need covering, so TWO indexes:
--   1. Tenant-scoped list (tenant operator bearer, and the x-api-key public
--      path) always carries tenant_id = $n, so the tenant-leading index serves
--      both the ordering and the range predicate with no Sort.
--   2. The platform admin bearer sees ALL tenants and sends NO tenant predicate.
--      A tenant-leading index cannot seek on its leading column there, so that
--      query is only served cleanly by an index led straight off the sort key.
--      Without this one the admin console (the primary view) still sorts.
--
-- The existing operations_tenant_created is a strict PREFIX of index 1 and is
-- therefore redundant for reads. It is deliberately NOT dropped here: removing an
-- index is irreversible from a migration, and the plan evidence that would
-- justify it needs a live EXPLAIN (see the delta note in the lane receipt).
-- Dropping it later is a one-line follow-on once EXPLAIN is captured in a DB
-- window. Both indexes below are IF NOT EXISTS, so migrate() stays idempotent.

-- 1. tenant-scoped paging: tenant_id equality + the (created_at, id) keyset.
CREATE INDEX IF NOT EXISTS operations_tenant_created_id_idx
  ON operations (tenant_id, created_at DESC, id DESC);

-- 2. cross-tenant paging (platform admin): sort key only, no tenant column.
CREATE INDEX IF NOT EXISTS operations_created_id_idx
  ON operations (created_at DESC, id DESC);
