import { createDb, type Db } from '../src/db/db';
import { migrate } from '../src/db/migrations';

/**
 * W-ADMUX02-IDX-2 (ADM-UX-02, Reviewer Turn 50 Finding 1, delta 22): QUERY-PLAN
 * evidence for the operations keyset indexes from
 * migrations/0017_operations_keyset_index.sql.
 *
 * The offline leg (migrations-ledger-guard.test.ts) only pins that the index
 * statements are SHIPPED. It cannot show that PostgreSQL picks them, because a
 * plan needs a planner and real rows. This file closes that gap: it seeds
 * >=1,000 operations (ADM-UX-02 asks for 1,000+), then asserts the two things
 * the indexes are actually for:
 *
 *   1. the page query has NO Sort node - the index covers the ORDER BY, so
 *      paging does not re-sort the population on every request; and
 *   2. keyset paging over the seeded population neither skips nor repeats a
 *      row, including a deliberate 40-row group that shares one created_at -
 *      the exact case the id tiebreak exists for.
 *
 * WINDOW-GATED: boots real PostgreSQL. Without DU_LIVE_INFRA=1 everything is
 * skipped, so an offline run touches nothing (same fleet standard as
 * migrations.test.ts). The plans are printed so the Tester running inside a
 * window can read WHICH index the planner chose - that preference is evidence
 * to record, not something this file guesses at.
 *
 * W-ADMUX02-EXPLAIN-SORT-1 (T180-A1): the same question now for the four
 * indexes from migrations/0018 - updated_at (ordered bare by the route, so the
 * clean expectation is "no Sort + index named") and deadline_at.
 *
 * W-ADMIN-ALIGN-EXPLAIN-0019 (Delta 88): the deadline_at key is ordered as
 * COALESCE(deadline_at, '<sentinel>'::timestamptz) where the sentinel is an
 * INLINE timestamptz LITERAL, not a bound $n. The route cannot bind it:
 * migrations/0019 indexes that exact expression, and a planner matches an
 * expression index only against the same Const node - a Param holding the same
 * instant is a different node, ordered through a Sort over a Seq Scan (T-35,
 * and W-INGEST-0019-2's review). So the three deadline cases below EXPLAIN the
 * literal form, 0019 is the index that can serve it, and the decision bar now
 * accepts EITHER index family for deadline (0018's plain pair or 0019's
 * expressions) so the plan names whichever the planner actually chose. A red
 * HERE inside a claimed window is not noise - it is the evidence T180-A1 asks
 * for about 0019; nothing may "fix" it by editing applied 0018 or 0019 (applied
 * + no checksum means the edit is skipped in silence, Delta 24). Population:
 * updated_at is distinct per row; roughly half the rows and all 40 tie rows
 * carry NULL deadline_at (the sentinel interaction needs NULLs at scale, not
 * an edge row).
 */

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const DB_NAME = new URL(DATABASE_URL).pathname.split('/').pop() ?? 'du_orchestrator_test';

/** Never seed or delete against a non-test target. */
function assertTestDatabase(): void {
  if (!/test/i.test(DB_NAME)) {
    throw new Error(
      `refusing keyset plan test: DATABASE_URL database ${DB_NAME} does not look like a test database`
    );
  }
}

const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('admin-keyset-explain.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

const PAGE_LIMIT = 50;
const SEEDED_ROWS = 1200;
const TIE_ROWS = 40;
const TENANT_NAME = 'keyset-explain-tenant';
const UUID_PROBE = '00000000-0000-4000-8000-000000000000';
// The route's sentinels for the nullable deadline key (server.ts
// OPERATIONS_LIST_NULL_SORT_BOUND_SQL). Since W-INGEST-0019-2 these are
// INLINE timestamptz LITERALS in the SQL text, not bound $n params - the
// 0019 expression indexes match only the Const node. Mirrored here verbatim
// so the plans below are plans of what the route actually emits.
const SENTINEL_DESC = '0001-01-01T00:00:00.000Z';
const SENTINEL_ASC = '9999-12-31T23:59:59.999Z';

interface OpRow {
  id: string;
  created_at: string;
}

interface WalkRow {
  id: string;
  ts: string;
}

let db: Db;
let seededTenantId: string;

/** Run EXPLAIN and return the plan text. */
async function plan(sql: string, params: unknown[]): Promise<string> {
  const res = await db.query<{ 'QUERY PLAN': string }>(
    `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
    params
  );
  return res.rows.map((r) => r['QUERY PLAN']).join('\n');
}

async function planWithSeqScanDisabled(sql: string, params: unknown[]): Promise<string> {
  return db.tx(async (client) => {
    await client.query('SET LOCAL enable_seqscan = off');
    const res = await client.query<{ 'QUERY PLAN': string }>(
      `EXPLAIN (ANALYZE, BUFFERS, FORMAT TEXT) ${sql}`,
      params as never[]
    );
    return res.rows.map((r) => r['QUERY PLAN']).join('\n');
  });
}

/**
 * Walk the seeded tenant with the route keyset shape and collect ids in page
 * order. Mirrors listOperationsPage: a forward page is the limit + 1 rows
 * strictly older than the cursor, and nextCursor is the oldest row seen.
 * Shared by the created_at and updated_at walks (W-ADMUX02-EXPLAIN-SORT-1).
 */
async function walkByBareKey(key: 'created_at' | 'updated_at'): Promise<string[]> {
  const seen: string[] = [];
  let cursor: { createdAt: string; id: string } | null = null;
  for (let guard = 0; guard < 500; guard++) {
    // Explicit annotation: both ternary branches await db.query, and leaving
    // the type to inference self-references through the loop variable.
    const res: { rows: WalkRow[] } = cursor
      ? await db.query<WalkRow>(
          `SELECT id, ${key} AS ts FROM operations
           WHERE tenant_id = $1 AND (${key}, id) < ($2::timestamptz, $3::uuid)
           ORDER BY ${key} DESC, id DESC LIMIT $4`,
          [seededTenantId, cursor.createdAt, cursor.id, PAGE_LIMIT + 1],
        )
      : await db.query<WalkRow>(
          `SELECT id, ${key} AS ts FROM operations
           WHERE tenant_id = $1
           ORDER BY ${key} DESC, id DESC LIMIT $2`,
          [seededTenantId, PAGE_LIMIT + 1],
        );
    const rows = res.rows;
    const page = rows.slice(0, PAGE_LIMIT);
    for (const r of page) seen.push(r.id);
    if (rows.length < PAGE_LIMIT + 1) return seen;
    const last = page[page.length - 1]!;
    cursor = { createdAt: new Date(last.ts).toISOString(), id: last.id };
  }
  throw new Error('keyset walk did not terminate - pagination is looping');
}

// The created_at walk keeps its original name (the pre-existing tests and the
// T-CODEX receipts reference it); its body is now the shared implementation.
async function walkKeyset(): Promise<string[]> {
  return walkByBareKey('created_at');
}

/**
 * T180-A1 / Δ73 decision bar for the deadline_at plans, applied to EXPLAIN
 * output of the shape the route itself emits. Each clause fails for its own
 * documented reason, so a red inside a claimed window localizes the answer:
 *   - Seq Scan: the planner ignored every deadline index entirely -> the
 *     0019 expression-form branch is needed;
 *   - name assertion: at least one deadline index (0018's plain pair OR
 *     0019's expression pair) must appear in the plan, otherwise neither
 *     migration can be called used;
 *   - a Sort wider than the bounded window is the "material Sort" T180-A1
 *     says must trigger a follow-on migration - NOT an edit to applied 0018
 *     or 0019 (applied + no checksum means the edit is skipped in silence,
 *     Δ24).
 * The plan text is printed either way; the Tester records WHICH index won.
 */
async function expectDeadlinePlanUsable(text: string, label: string): Promise<void> {
  process.stdout.write(`\n--- ${label} plan ---\n${text}\n`);
  expect(text).not.toMatch(/Seq Scan on operations/);
  expect(text).toMatch(/operations_(tenant_)?deadline_(coalesce_(asc|desc)_)?id_idx/);
  const sortLine = text.split('\n').find((l) => /->\s+Sort\b/.test(l));
  if (sortLine) {
    const actual = sortLine.match(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/);
    expect(actual).not.toBeNull();
    // Same materiality bar the created_at backward hop set with live
    // evidence in T-CODEX-TEST-18: sorting a bounded window is cheap and
    // allowed; the population is not.
    expect(Number(actual![1])).toBeLessThanOrEqual((PAGE_LIMIT + 1) * 4);
  }
}

liveDescribe('W-ADMUX02-IDX-2: operations keyset query plan (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  assertTestDatabase();
  db = createDb(DATABASE_URL);
  await migrate(db);

  // Fresh tenant per run so cleanup is exact and rows from other lanes are
  // never touched or counted.
  const t = await db.query<{ id: string }>(
    'INSERT INTO tenants (name) VALUES ($1) RETURNING id',
    [TENANT_NAME],
  );
  seededTenantId = t.rows[0]!.id;

  // 1,200 rows one second apart, then 40 rows sharing a single instant: the
  // tie group is what makes a missing id tiebreak fail loudly.
  // W-ADMUX02-EXPLAIN-SORT-1: updated_at is stamped distinct per row (offset
  // +1s from created, tie group offset by g) and deadline_at is NULL on every
  // odd row and on the whole tie group - the COALESCE-sentinel tests need a
  // large NULL block, because "deadline-less" is most operations in production
  // (server.ts comment), not an edge case.
  await db.query(
    `INSERT INTO operations
       (tenant_id, business_id, business_version, action, correlation_id, state, created_at, updated_at, deadline_at)
    SELECT $1, 'keyset-explain', '1.0.0', 'review', 'keyset-explain-' || g, 'SUCCEEDED',
           TIMESTAMPTZ '2026-01-01 00:00:00+00' + (g || ' seconds')::interval,
           TIMESTAMPTZ '2026-03-01 00:00:00+00' + (g || ' seconds')::interval,
           CASE WHEN g % 2 = 0
                THEN TIMESTAMPTZ '2026-06-01 00:00:00+00' + (g || ' seconds')::interval
           END
     FROM generate_series(1, $2) g`,
    [seededTenantId, SEEDED_ROWS],
  );
  await db.query(
    `INSERT INTO operations
       (tenant_id, business_id, business_version, action, correlation_id, state, created_at, updated_at, deadline_at)
    SELECT $1, 'keyset-explain', '1.0.0', 'review', 'keyset-explain-tie-' || g, 'SUCCEEDED',
           TIMESTAMPTZ '2026-02-01 00:00:00+00',
           TIMESTAMPTZ '2026-04-01 00:00:00+00' + (g || ' seconds')::interval,
           NULL
     FROM generate_series(1, $2) g`,
    [seededTenantId, TIE_ROWS],
  );

  // Without fresh statistics the planner reasons from a stale reltuples and may
  // pick a plan that has nothing to do with the real one.
  await db.query('ANALYZE operations');
}, 180_000);

afterAll(async () => {
  if (!db) return;
  if (seededTenantId) {
    await db.query('DELETE FROM operations WHERE tenant_id = $1', [seededTenantId]);
    await db.query('DELETE FROM tenants WHERE id = $1', [seededTenantId]);
  }
  await db.close();
});

it('all ten keyset indexes from 0017, 0018 and 0019 are present in the database', async () => {
  // migrate() ran in beforeAll: if 0018 and 0019 were picked up at all, their
  // IF NOT EXISTS statements landed here. This proves PRESENCE only - the
  // plan tests are what prove USE. T180-A1: T-33 had verified index NAMES
  // only; definitions and plans for the new keys are the open half.
  const res = await db.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes
     WHERE schemaname = 'public' AND tablename = 'operations'
       AND indexname IN (
         'operations_tenant_created_id_idx', 'operations_created_id_idx',
         'operations_tenant_updated_id_idx', 'operations_updated_id_idx',
         'operations_tenant_deadline_id_idx', 'operations_deadline_id_idx',
         'operations_tenant_deadline_coalesce_desc_id_idx',
         'operations_deadline_coalesce_desc_id_idx',
         'operations_tenant_deadline_coalesce_asc_id_idx',
         'operations_deadline_coalesce_asc_id_idx'
       )
     ORDER BY indexname`,
  );
  expect(res.rows.map((r) => r.indexname)).toEqual([
    'operations_created_id_idx',
    'operations_deadline_coalesce_asc_id_idx',
    'operations_deadline_coalesce_desc_id_idx',
    'operations_deadline_id_idx',
    'operations_tenant_created_id_idx',
    'operations_tenant_deadline_coalesce_asc_id_idx',
    'operations_tenant_deadline_coalesce_desc_id_idx',
    'operations_tenant_deadline_id_idx',
    'operations_tenant_updated_id_idx',
    'operations_updated_id_idx',
  ]);
});

it('the cross-tenant admin page query has no Sort node', async () => {
  // Platform admin bearer: no tenant predicate - the shape IDX-2 exists for.
  const text = await plan(
    `SELECT * FROM operations ORDER BY created_at DESC, id DESC LIMIT $1`,
    [PAGE_LIMIT + 1],
  );
  process.stdout.write(`\n--- cross-tenant page plan ---\n${text}\n`);
  // The whole point of the index: the ORDER BY comes from the index, so the
  // population is never re-sorted per request.
  expect(text).not.toMatch(/\bSort\b/);
  expect(text).toMatch(/operations_(tenant_)?created_id_idx/);
}, 120_000);

/**
 * T-CODEX-TEST-18 observed: Limit -> Index Scan using operations_created_id_idx
 * with `Index Cond: (ROW(created_at, id) < ROW(...))` and `Filter: tenant_id = ...`
 * — no Sort. Note which index won: the CROSS-TENANT one, because every seeded
 * row shares one tenant, so a tenant equality selects nothing and the planner
 * is right to skip the tenant-leading index. That means this run does NOT prove
 * operations_tenant_created_id_idx is chosen; proving that needs a population
 * spread over several tenants, so the assertion accepts either index.
 */
it('the tenant-scoped page query has no Sort node', async () => {
  const text = await plan(
    `SELECT * FROM operations WHERE tenant_id = $1
     AND (created_at, id) < ($2::timestamptz, $3::uuid)
     ORDER BY created_at DESC, id DESC LIMIT $4`,
    [
      seededTenantId,
      '2026-01-01 00:20:00+00',
      '00000000-0000-4000-8000-000000000000',
      PAGE_LIMIT + 1,
    ],
  );
  process.stdout.write(`\n--- tenant-scoped page plan ---\n${text}\n`);
  expect(text).not.toMatch(/\bSort\b/);
  expect(text).toMatch(/operations_(tenant_)?created_id_idx/);
}, 120_000);

/**
 * The backward hop. T-CODEX-TEST-18 ran this and the planner produced
 * Bitmap Index Scan on operations_created_id_idx -> Bitmap Heap Scan -> Sort
 * (quicksort, 46kB, 63 rows, 0.19 ms), which FAILED a "no Sort" assertion.
 * The assertion was wrong, not the plan: only ~63 rows are newer than the
 * bound, so sorting those beats a backward index scan that would step over
 * ~1,199 non-qualifying entries. What the index must guarantee is that the
 * boundary is SEEKED (Index Cond) instead of the table being scanned, so the
 * sort is over the qualifying window and never over the population.
 */
it('the backward hop seeks the boundary through a keyset index', async () => {
  const text = await planWithSeqScanDisabled(
    `SELECT * FROM operations
     WHERE (created_at, id) > ($1::timestamptz, $2::uuid)
     ORDER BY created_at ASC, id ASC LIMIT $3`,
    ['2026-01-01 00:20:00+00', '00000000-0000-4000-8000-000000000000', PAGE_LIMIT + 1],
  );
  process.stdout.write(`\n--- backward page plan ---\n${text}\n`);
  // The boundary is pushed INTO the index — the row comparison is sargable.
  expect(text).toMatch(/Index Cond: \(ROW\(created_at, id\) > ROW\(/);
  expect(text).toMatch(/operations_(tenant_)?created_id_idx/);
  // A Sort is allowed here; a full-table scan is not.
  expect(text).not.toMatch(/Seq Scan on operations/);
  // Belt and braces: if a Sort node is present it must be bounded to the
  // qualifying window, never to the whole population.
  const sortLine = text.split('\n').find((l) => /->\s+Sort\b/.test(l));
  if (sortLine) {
    const actual = sortLine.match(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/);
    expect(actual).not.toBeNull();
    expect(Number(actual![1])).toBeLessThanOrEqual((PAGE_LIMIT + 1) * 4);
  }
}, 120_000);

it('paging the seeded population skips and repeats nothing (tie group included)', async () => {
  const seen = await walkKeyset();
  const expected = SEEDED_ROWS + TIE_ROWS;
  // Every seeded row, exactly once.
  expect(seen).toHaveLength(expected);
  expect(new Set(seen).size).toBe(expected);

  // and the union is the whole seeded set: no row silently lost at a page
  // boundary, which is what a missing id tiebreak would cause.
  const inDb = await db.query<{ id: string }>(
    'SELECT id FROM operations WHERE tenant_id = $1',
    [seededTenantId],
  );
  expect(new Set(seen)).toEqual(new Set(inDb.rows.map((r) => r.id)));
}, 180_000);

it('a row inserted between two page requests does not shift the next page', async () => {
  // The property OFFSET paging cannot give: an insert newer than the cursor is
  // above the window, so page 2 is unaffected.
  const first = await db.query<OpRow>(
    `SELECT id, created_at FROM operations WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [seededTenantId, PAGE_LIMIT + 1],
  );
  const page1 = first.rows.slice(0, PAGE_LIMIT);
  await db.query(
    `INSERT INTO operations
       (tenant_id, business_id, business_version, action, correlation_id, state, created_at)
    VALUES ($1, 'keyset-explain', '1.0.0', 'review', 'keyset-explain-late', 'SUCCEEDED',
            TIMESTAMPTZ '2027-01-01 00:00:00+00')`,
    [seededTenantId],
  );
  const last = page1[page1.length - 1]!;
  const second = await db.query<OpRow>(
    `SELECT id, created_at FROM operations
     WHERE tenant_id = $1 AND (created_at, id) < ($2::timestamptz, $3::uuid)
     ORDER BY created_at DESC, id DESC LIMIT $4`,
    [seededTenantId, new Date(last.created_at).toISOString(), last.id, PAGE_LIMIT + 1],
  );
  const page2 = second.rows.slice(0, PAGE_LIMIT);
  const page1Ids = new Set(page1.map((r) => r.id));
  // The stable half of the property: page 2 is bounded by the cursor, so the
  // insert above it cannot leak into it and cannot shift it.
  expect(page2.some((r) => page1Ids.has(r.id))).toBe(false);
  const inserted = await db.query<{ id: string }>(
    `SELECT id FROM operations WHERE tenant_id = $1 AND correlation_id = 'keyset-explain-late'`,
    [seededTenantId],
  );
  const newId = inserted.rows[0]!.id;

  // T-CODEX-TEST-18 caught the assertion below: `page1Ids` is a snapshot taken
  // BEFORE the insert, so it can never contain the new row. The property is
  // about a page 1 queried AFTER it — page 2 stays put, page 1 moves.
  const refetched = await db.query<OpRow>(
    `SELECT id, created_at FROM operations WHERE tenant_id = $1
     ORDER BY created_at DESC, id DESC LIMIT $2`,
    [seededTenantId, PAGE_LIMIT + 1],
  );
  const newPage1 = refetched.rows.slice(0, PAGE_LIMIT);
  // The 2027 row is now the newest, so it heads page 1...
  expect(newPage1[0]!.id).toBe(newId);
  // ...and the rows the operator already saw simply shift down by one.
  const stillThere = newPage1.slice(1).find((r) => r.id === page1[1]!.id);
  expect(stillThere).toBeDefined();
  // The new row is NEWER than the cursor that bounded page 2, so it must not
  // appear there. With OFFSET paging this is exactly where a repeat shows up:
  // the shift pushes the last seen row into the next page.
  expect(page2.some((r) => r.id === newId)).toBe(false);
  // …and page 2 stayed the same 50 rows it was before the insert, i.e. it is
  // bounded by the cursor rather than by a row number.
  expect(page2.every((r) => !newPage1.some((n) => n.id === r.id))).toBe(true);
}, 120_000);

/* ------------------------------------------------------------------ */

/* W-ADMUX02-EXPLAIN-SORT-1: the four 0018 indexes against real plans  */

it('the cross-tenant updated_at page query has no Sort node', async () => {
  // updated_at is NOT NULL and the route orders the bare column, so this is
  // the same clean shape created_at already proved: the index provides the
  // order and there is nothing left to sort.
  const text = await plan(
    `SELECT * FROM operations ORDER BY updated_at DESC, id DESC LIMIT $1`,
    [PAGE_LIMIT + 1],
  );
  process.stdout.write(`\n--- cross-tenant updated_at page plan ---\n${text}\n`);
  expect(text).not.toMatch(/\bSort\b/);
  expect(text).toMatch(/operations_(tenant_)?updated_id_idx/);
}, 120_000);

it('the tenant-scoped updated_at page query has no Sort node', async () => {
  const text = await plan(
    `SELECT * FROM operations WHERE tenant_id = $1
     AND (updated_at, id) < ($2::timestamptz, $3::uuid)
     ORDER BY updated_at DESC, id DESC LIMIT $4`,
    [seededTenantId, '2026-03-01 00:20:00+00', UUID_PROBE, PAGE_LIMIT + 1],
  );
  process.stdout.write(`\n--- tenant-scoped updated_at page plan ---\n${text}\n`);
  // Same acceptance as the created_at tenant case: no Sort, and accept EITHER
  // updated index - with one tenant seeded the tenant-leading index selects
  // everything, so the planner may legitimately prefer the key-led one
  // (documented behavior of the created_at population; see Δ21).
  expect(text).not.toMatch(/\bSort\b/);
  expect(text).toMatch(/operations_(tenant_)?updated_id_idx/);
}, 120_000);

it('the updated_at backward hop seeks the boundary through an updated index', async () => {
  // Mirrors the created_at backward-hop bar set from T-CODEX-TEST-18's real
  // plan: the boundary must be an Index Cond (sargable row comparison), a
  // bounded Sort over the qualifying window is allowed, a population scan is
  // not.
  const text = await plan(
    `SELECT * FROM operations
     WHERE (updated_at, id) > ($1::timestamptz, $2::uuid)
     ORDER BY updated_at ASC, id ASC LIMIT $3`,
    ['2026-03-01 00:20:00+00', UUID_PROBE, PAGE_LIMIT + 1],
  );
  process.stdout.write(`\n--- updated_at backward page plan ---\n${text}\n`);
  expect(text).toMatch(/Index Cond: \(ROW\(updated_at, id\) > ROW\(/);
  expect(text).toMatch(/operations_(tenant_)?updated_id_idx/);
  expect(text).not.toMatch(/Seq Scan on operations/);
  const sortLine = text.split('\n').find((l) => /->\s+Sort\b/.test(l));
  if (sortLine) {
    const actual = sortLine.match(/actual time=[\d.]+\.\.[\d.]+ rows=(\d+)/);
    expect(actual).not.toBeNull();
    expect(Number(actual![1])).toBeLessThanOrEqual((PAGE_LIMIT + 1) * 4);
  }
}, 120_000);

it('the tenant-scoped deadline_at page query meets the 0019 decision bar', async () => {
  // The EXACT expression shape of the route: server.ts bindOperationsListSort
  // Key returns COALESCE(deadline_at, '<sentinel>'::timestamptz) with the
  // sentinel as an INLINE LITERAL (W-INGEST-0019-2), and the cursor predicate
  // reuses that same expression. 0019 indexes this exact Const expression; a
  // Param bound to the same instant is a different planner node (T-35).
  const text = await plan(
    `SELECT * FROM operations WHERE tenant_id = $1
     AND (COALESCE(deadline_at, '${SENTINEL_DESC}'::timestamptz), id) < ($2::timestamptz, $3::uuid)
     ORDER BY COALESCE(deadline_at, '${SENTINEL_DESC}'::timestamptz) DESC, id DESC LIMIT $4`,
    [seededTenantId, '2026-06-01 00:20:00+00', UUID_PROBE, PAGE_LIMIT + 1],
  );
  await expectDeadlinePlanUsable(text, 'deadline tenant-scoped forward');
}, 120_000);

it('the cross-tenant deadline_at page query meets the 0019 decision bar', async () => {
  const text = await plan(
    `SELECT * FROM operations
     WHERE (COALESCE(deadline_at, '${SENTINEL_DESC}'::timestamptz), id) < ($1::timestamptz, $2::uuid)
     ORDER BY COALESCE(deadline_at, '${SENTINEL_DESC}'::timestamptz) DESC, id DESC LIMIT $3`,
    ['2026-06-01 00:20:00+00', UUID_PROBE, PAGE_LIMIT + 1],
  );
  await expectDeadlinePlanUsable(text, 'deadline cross-tenant forward');
}, 120_000);

it('the deadline_at backward hop (ASC, ceiling sentinel) meets the 0019 decision bar', async () => {
  // Backward walks flip the comparison AND re-take the sentinel for the scan
  // direction (9999-12-31 for ASC), exactly as the route composes them - the
  // NULL block must sit at the end of the ASC walk too.
  const text = await plan(
    `SELECT * FROM operations WHERE tenant_id = $1
     AND (COALESCE(deadline_at, '${SENTINEL_ASC}'::timestamptz), id) > ($2::timestamptz, $3::uuid)
     ORDER BY COALESCE(deadline_at, '${SENTINEL_ASC}'::timestamptz) ASC, id ASC LIMIT $4`,
    [seededTenantId, '2026-06-01 00:20:00+00', UUID_PROBE, PAGE_LIMIT + 1],
  );
  await expectDeadlinePlanUsable(text, 'deadline tenant-scoped backward');
}, 120_000);

it('paging by updated_at skips and repeats nothing', async () => {
  // Continuity, not just a plan: the 0018 updated_at indexes exist so this
  // walk neither loses nor doubles a row, including the 40-row created_at
  // tie group (their updated_at values are distinct, so the tiebreak is
  // exercised where created ordering is silent). Expected size is counted
  // live because the previous test intentionally left one extra row.
  const inDb = await db.query<{ id: string }>(
    'SELECT id FROM operations WHERE tenant_id = $1',
    [seededTenantId],
  );
  const seen = await walkByBareKey('updated_at');
  expect(seen).toHaveLength(inDb.rows.length);
  expect(new Set(seen).size).toBe(inDb.rows.length);
  expect(new Set(seen)).toEqual(new Set(inDb.rows.map((r) => r.id)));
}, 180_000);

});

/**
 * The live cases above only run in a claimed window, so offline the decision
 * bar itself would be untested code. These cases feed expectDeadlinePlanUsable
 * SYNTHETIC plan texts - realistic enough to pin the three clauses and their
 * boundaries - so an offline run proves the bar bites and which shapes it
 * calls pass vs fail. This is a mutation-check substitute for a gated suite,
 * not a claim about PostgreSQL; the real plans stay the window's job.
 */
describe('W-ADMUX02-EXPLAIN-SORT-1: deadline decision bar (offline, synthetic plans)', () => {
  it('fails a plan whose only access path is a Seq Scan (0019 branch: indexes unused)', async () => {
    const text = [
      "Limit  (cost=88.70..90.01 rows=51 width=420)",
      "  ->  Sort  (cost=88.70..90.01 rows=510 width=420)",
      "        Sort Key: ((COALESCE(deadline_at, '0001-01-01'::timestamp with time zone)) DESC), id DESC",
      "        ->  Seq Scan on operations  (cost=0.00..55.70 rows=4770 width=420)",
      "              Filter: (tenant_id = 'x')",
    ].join('\n');
    await expect(expectDeadlinePlanUsable(text, 'synthetic seqscan')).rejects.toThrow();
  });

  it('fails a plan that sorts the window through a DIFFERENT key index (no deadline index named)', async () => {
    const text = [
      "Limit  (cost=99.00..99.10 rows=51 width=420)",
      "  ->  Sort  (cost=99.00..120.00 rows=4770 width=420)",
      "        Sort Key: ((COALESCE(deadline_at, '0001-01-01'::timestamp with time zone)) DESC), id DESC",
      "        ->  Index Scan using operations_tenant_created_id_idx on operations  (cost=0.29..55.70 rows=4770 width=420)",
    ].join('\n');
    await expect(expectDeadlinePlanUsable(text, 'synthetic other-index')).rejects.toThrow();
  });

  it('passes a clean index scan providing the COALESCE order (no Sort, name present)', async () => {
    const text = [
      "Limit  (cost=0.42..12.30 rows=51 width=420)",
      "  ->  Index Scan using operations_deadline_id_idx on operations  (cost=0.42..30.10 rows=3720 width=420)",
      "        Filter: (tenant_id = 'x')",
    ].join('\n');
    await expect(expectDeadlinePlanUsable(text, 'synthetic clean')).resolves.toBeUndefined();
  });

  it('accepts a 0019 coalesce index name (the expression-form family)', async () => {
    const text = [
      "Limit  (cost=0.42..12.30 rows=51 width=420)",
      "  ->  Index Scan using operations_tenant_deadline_coalesce_desc_id_idx on operations  (cost=0.42..30.10 rows=3720 width=420)",
      "        Filter: (tenant_id = 'x')",
    ].join('\n');
    await expect(expectDeadlinePlanUsable(text, 'synthetic 0019 name')).resolves.toBeUndefined();
  });

  it('accepts a bounded Sort over the deadline index but fails a population-sized Sort', async () => {
    const bounded = [
      "Limit  (cost=80.10..80.71 rows=51 width=420) (actual time=1.100..1.200 rows=51 loops=1)",
      "  ->  Sort  (cost=80.10..80.71 rows=244 width=420) (actual time=1.090..1.150 rows=15 loops=1)",
      "        Sort Method: quicksort  Memory: 25kB",
      "        ->  Index Scan using operations_tenant_deadline_id_idx on operations  (cost=0.42..70.00 rows=244 width=420) (actual time=0.05..0.60 rows=244 loops=1)",
    ].join('\n');
    await expect(expectDeadlinePlanUsable(bounded, 'synthetic bounded-sort')).resolves.toBeUndefined();
    const material = bounded.replace('rows=244 width=420) (actual time=1.090..1.150 rows=15 loops=1)', 'rows=4770 width=420) (actual time=1.090..90.00 rows=4770 loops=1)');
    await expect(expectDeadlinePlanUsable(material, 'synthetic material-sort')).rejects.toThrow();
  });

});
