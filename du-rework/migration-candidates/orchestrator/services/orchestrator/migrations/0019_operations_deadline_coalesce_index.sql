-- W-INGEST-0019-1 (T180-A1/T190-A1 answer, T-35 live falsification follow-on)
-- COALESCE expression indexes for deadline_at sort.
--
-- Why 0019 and not an edit to 0018: 0018 has already been applied to the live
-- test database (T-CODEX-TEST-2x) and the runner in src/db/migrations.ts keys
-- on schema_migrations.sequence only with no checksum. A modified 0018 would
-- be silently skipped and the file would drift from the database (lane rule
-- Delta 24). A follow-on migration is the only safe delivery vehicle.
--
-- Why expression indexes and why 0018 was falsified: server.ts
-- bindOperationsListSortKey (server.ts:2547) builds the ORDER BY as
--   COALESCE(deadline_at, $sentinel::timestamptz) [ASC|DESC], id [ASC|DESC]
-- where $sentinel is OPERATIONS_LIST_NULL_SORT_BOUND_SQL[direction]:
--   desc -> '0001-01-01T00:00:00.000Z'  (NULLS FIRST in the desc walk)
--   asc  -> '9999-12-31T23:59:59.999Z'  (NULLS LAST in the asc walk)
-- The bindOperationsCursor predicate also compares the SAME expression
-- (server.ts:2593, listOperationsPage:2659). A plain-column index
-- (tenant_id, deadline_at DESC, id DESC) does NOT match that expression
-- pathkey (T-35 EXPLAIN: all three deadline plans were Sort->Seq Scan;
-- neither operations_tenant_deadline_id_idx nor operations_deadline_id_idx
-- was chosen). 0018 shipped the plain form deliberately and documented this
-- as an open question (see 0018 header); T-35 closed the question as FAIL,
-- so this migration carries the matching expression form. The plain indexes
-- from 0018 are retained: they remain the right shape for any bare
-- deadline_at predicate and removal is irreversible from a migration.
--
-- Sentinel semantics: the two ISO instants are real timestamptz literals
-- that survive toISOString() round-trips (the strict cursor decoder demands
-- this). No platform operation can collide with year 1 or year 9999. The
-- same literals are baked into the index expressions below so the planner
-- can match the ORDER BY pathkey without needing to prove $param equality.
-- Using a parameterised COALESCE in the query (COALESCE(col, $n)) would
-- not reliably match a literal expression index; the fix keeps literals in
-- the index and the query will use the matching branch per sort direction
-- (the planner sees the literal after bind or via the literal-bearing
-- expression; live EXPLAIN in a Tester window must confirm Index Scan
-- without Sort for both directions).
--
-- Why CONCURRENTLY is NOT used (write-lock review, Turn 200 roadmap item 4):
-- CREATE INDEX CONCURRENTLY cannot run inside an explicit transaction, but
-- src/db/migrations.ts executes each migration file inside db.tx(). Using
-- CONCURRENTLY would require breaking the runner's transactional guarantee
-- (DDL + schema_migrations insert would no longer be atomic) and would need
-- a dedicated runner path and retry handling that does not exist. Plain
-- CREATE INDEX takes ShareLock on operations and blocks concurrent writes
-- for the duration of the build. For the current scale (operations is
-- small, this is a forward index build, IF NOT EXISTS is idempotent) that
-- blocking window is acceptable and far safer than a non-transactional
-- migration. If operations grows hot, a future online migration can rebuild
-- with CONCURRENTLY outside this runner. This decision was reviewed in
-- W-INGEST-0019-1 and is recorded here rather than silently assumed.
--
-- Index design: two access paths per sentinel, same discipline as 0017/0018.
--   * tenant-scoped list (tenant bearer / x-api-key) always carries
--     tenant_id = $n -> tenant-leading composite.
--   * platform admin (no tenant predicate) -> key-led composite.
-- Two sentinels x two paths = four indexes. Each is IF NOT EXISTS so
-- migrate() stays idempotent. Direction on the expression (DESC for the
-- 0001 sentinel, ASC for the 9999 sentinel) mirrors the sort that uses
-- that sentinel, so the ORDER BY + id tiebreak is satisfied without Sort
-- in either direction of either sort; the opposite-direction scan can
-- still be served by a backward index scan, but having the aligned
-- direction stored avoids relying on that.

-- Tenant-scoped deadline_at COALESCE(desc sentinel) paging.
CREATE INDEX IF NOT EXISTS operations_tenant_deadline_coalesce_desc_id_idx
  ON operations (tenant_id, COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz) DESC, id DESC);

-- Cross-tenant deadline_at COALESCE(desc sentinel) paging (platform admin).
CREATE INDEX IF NOT EXISTS operations_deadline_coalesce_desc_id_idx
  ON operations (COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz) DESC, id DESC);

-- Tenant-scoped deadline_at COALESCE(asc sentinel) paging.
CREATE INDEX IF NOT EXISTS operations_tenant_deadline_coalesce_asc_id_idx
  ON operations (tenant_id, COALESCE(deadline_at, '9999-12-31T23:59:59.999Z'::timestamptz) ASC, id ASC);

-- Cross-tenant deadline_at COALESCE(asc sentinel) paging (platform admin).
CREATE INDEX IF NOT EXISTS operations_deadline_coalesce_asc_id_idx
  ON operations (COALESCE(deadline_at, '9999-12-31T23:59:59.999Z'::timestamptz) ASC, id ASC);
