-- W-ADMUX02-IDX-SORT-0018 (ADM-UX-02, Reviewer Turn 150 follow-up; closes the
-- index item opened as Delta 53 in W-ADMUX02-SORT-ALLOWLIST-1): keyset indexes
-- for the two sort keys the operations list route added but left unindexed.
--
-- Why 0018 and not an edit to 0017: 0017 was already applied to the live test
-- database (T-CODEX-TEST-20/23) and the runner keys on schema_migrations
-- sequence only -- it has no checksum -- so a modified 0017 would be skipped
-- in silence and the database would drift from the file (lane rule Delta 24).
--
-- 0017 covers (created_at, id). The route's ORDER BY now accepts six
-- (field, direction) pairs, default created_at:desc. updated_at is NOT NULL
-- (0001_platform_v1.sql:52), so a bare (updated_at DESC, id DESC) index
-- matches both directions of that sort exactly: forward scan for DESC,
-- backward scan for ASC, with the id tiebreak included so rows sharing an
-- instant neither skip nor repeat across pages.
--
-- deadline_at is the one NULLABLE sort key (0001_platform_v1.sql:46). The
-- route orders COALESCE(deadline_at, <bound sentinel>) so deadline-less rows
-- cannot silently vanish from page 2 onward (server.ts,
-- bindOperationsListSortKey). A plain-column index does not match that
-- expression pathkey, so whether the two deadline statements below remove the
-- Sort node is an OPEN question reserved for a live EXPLAIN in a claimed DB
-- window. If they do not, the fix is NOT editing this file once applied --
-- it would then be skipped -- but a follow-on migration carrying the matching
-- expression form, made after the plan evidence exists. They are shipped in
-- the plain form because that is what the packet specifies, they cost only
-- write time, and they are the right shape for any future bare deadline_at
-- predicate.
--
-- Two access paths per key, same discipline as 0017: the tenant-scoped list
-- (tenant bearer and the x-api-key path) always carries tenant_id = $n and
-- uses the tenant-leading pair; the platform admin bearer sends no tenant
-- predicate, so only a key-led index serves it without a Sort. This file
-- removes nothing -- index removal is irreversible from a migration and the
-- prefix-retention rule of 0017 applies equally here. Every statement is
-- IF NOT EXISTS, so migrate() stays idempotent.

-- 1. tenant-scoped paging on updated_at: tenant_id equality + the (updated_at, id) keyset.
CREATE INDEX IF NOT EXISTS operations_tenant_updated_id_idx
  ON operations (tenant_id, updated_at DESC, id DESC);

-- 2. cross-tenant paging on updated_at (platform admin): sort key only, no tenant column.
CREATE INDEX IF NOT EXISTS operations_updated_id_idx
  ON operations (updated_at DESC, id DESC);

-- 3. tenant-scoped paging on deadline_at. See the expression caveat above.
CREATE INDEX IF NOT EXISTS operations_tenant_deadline_id_idx
  ON operations (tenant_id, deadline_at DESC, id DESC);

-- 4. cross-tenant paging on deadline_at. Same caveat.
CREATE INDEX IF NOT EXISTS operations_deadline_id_idx
  ON operations (deadline_at DESC, id DESC);
