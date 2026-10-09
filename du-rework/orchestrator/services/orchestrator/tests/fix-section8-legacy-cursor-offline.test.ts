/**
 * FIX — WFA §8 finding LOW: the legacy page-token cursor subquery must carry the
 * caller's scope.
 *
 * Finding (coordination/reports/wfa-section8-security-review-2026-10-08.md):
 * the outer list query is tenant/API-key scoped, but its page-token scalar
 * subquery loaded `created_at`/`id` by operation id ALONE —
 * `src/compat/legacy-host-adapter.ts:420-426` — and `runtime.listOperations`
 * (`src/modules/runtime/runtime.ts:1848`) had the same shape. A token naming a
 * row outside the caller's scope therefore resolved a boundary from that row:
 * the caller learned an ordering bit about a foreign row and got a page computed
 * from it instead of failing closed.
 *
 * HOW THIS SUITE CAN FAIL BEFORE THE FIX
 * The fake DB below is a FAITHFUL interpreter, not a stub that answers a fixed
 * page: it resolves the boundary by applying exactly the predicates the emitted
 * subquery carries — and nothing else — the way PostgreSQL would. So when the
 * subquery omits the scope, the interpreter really does read the foreign row and
 * the assertions below go red for the right reason. No assertion here is
 * weakened to accommodate the bug, and none is deleted when the fix lands.
 *
 * Offline: no DB, no listener, no env. Every statement is captured and executed
 * in-process against a fixed population.
 */

import { legacyCompatHost } from '../src/compat/legacy-host-adapter';
import { createRuntimeService } from '../src/modules/runtime/runtime';
import type { RouteContext } from '../src/server';
import type { QueryResult, QueryResultRow } from 'pg';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const KEY_A = 'key-aaaa';
const KEY_B = 'key-bbbb';

interface Row extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  api_key_id: string;
  created_at: string;
  deleted_at: string | null;
  state: string;
  pipeline_json: string | null;
}

/** `pipeline_json->0->>'workflow'` in SQL terms: the workflow marker, or null. */
function workflowOf(row: Row): string | null {
  if (row.pipeline_json === null) return null;
  try {
    const parsed: unknown = JSON.parse(row.pipeline_json);
    if (!Array.isArray(parsed) || typeof parsed[0] !== 'object' || parsed[0] === null) return null;
    const marker = (parsed[0] as Record<string, unknown>)['workflow'];
    return typeof marker === 'string' ? marker : null;
  } catch {
    return null;
  }
}

/** The outer fence, verbatim: a workflow row is visible only to its own key. */
function visibleToKey(row: Row, apiKeyId: string): boolean {
  return workflowOf(row) === null || row.api_key_id === apiKeyId;
}

function pgResult(rows: Row[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows: rows as unknown as QueryResultRow[],
    fields: [],
  };
}

interface Capture {
  sql: string;
  params: unknown[];
  /** The row the boundary subquery resolved, or null. */
  boundary: Row | null;
  /** The subquery text the statement carried, or null when it had none. */
  subquery: string | null;
}

/**
 * Balanced-paren slice of the page-token subquery. A lazy regex would stop at
 * the first `)` inside the API-key fence, so the end is found by depth. The
 * marker is only `(SELECT created_at` because the two sites select different
 * column lists: the legacy list reads `created_at, id`, runtime reads
 * `created_at` alone.
 */
function extractBoundarySubquery(sql: string): string | null {
  const marker = '(SELECT created_at';
  const start = sql.indexOf(marker);
  if (start === -1) return null;
  let depth = 0;
  for (let i = start; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === '(') depth += 1;
    else if (ch === ')') {
      depth -= 1;
      if (depth === 0) {
        const inner = sql.slice(start + 1, i);
        return inner.includes('FROM operations WHERE') ? inner : null;
      }
    }
  }
  return null;
}

function paramAt(params: unknown[], index: string | undefined): string | null {
  if (index === undefined) return null;
  return String(params[Number(index) - 1]);
}

/**
 * Placeholder index of `name = $n` inside a WHERE fragment, or undefined.
 * Spacing-tolerant: the legacy statement writes `id = $4`, runtime writes `id=$2`.
 * `\b` keeps `id` from matching the tail of `tenant_id` / `api_key_id`.
 */
function indexOf(fragment: string, name: string): string | undefined {
  return new RegExp(`\\b${name}\\s*=\\s*\\$(\\d+)`).exec(fragment)?.[1];
}

/**
 * Resolve the boundary the way PostgreSQL resolves the emitted statement: only
 * the predicates the subquery actually carries are applied.
 */
function resolveBoundary(subquery: string, params: unknown[], population: Row[]): Row | null {
  const inner = /WHERE ([\s\S]+)$/.exec(subquery)?.[1] ?? subquery;
  const idIndex = indexOf(inner, 'id');
  if (idIndex === undefined) throw new Error('boundary subquery carries no id predicate: ' + subquery);
  const wantedId = paramAt(params, idIndex);

  let candidates = population.filter((row) => row.id === wantedId);
  const tenantIndex = indexOf(inner, 'tenant_id');
  if (tenantIndex !== undefined) {
    const tenant = paramAt(params, tenantIndex);
    candidates = candidates.filter((row) => row.tenant_id === tenant);
  }
  const keyIndex = indexOf(inner, 'api_key_id');
  if (keyIndex !== undefined) {
    const key = paramAt(params, keyIndex) ?? '';
    candidates = candidates.filter((row) => visibleToKey(row, key));
  }
  return candidates[0] ?? null;
}

/** Execute the legacy list statement against the population, faithfully. */
function executeLegacyList(sql: string, params: unknown[], population: Row[], capture: Capture): Row[] {
  const where = /WHERE ([\s\S]+?) ORDER BY /.exec(sql)?.[1] ?? '';
  const limit = Number(params[Number(/LIMIT \$(\d+)/.exec(sql)?.[1] ?? '2') - 1]);

  const tenant = paramAt(params, indexOf(where, 'tenant_id')) ?? '';
  const key = paramAt(params, indexOf(where, 'api_key_id')) ?? '';
  let rows = population.filter(
    (row) => row.tenant_id === tenant && row.deleted_at === null && visibleToKey(row, key),
  );

  const subquery = extractBoundarySubquery(sql);
  capture.subquery = subquery;
  if (subquery !== null) {
    const boundary = resolveBoundary(subquery, params, population);
    capture.boundary = boundary;
    // A NULL boundary makes the row-value comparison NULL for every row, so the
    // statement returns nothing. That is the fail-closed branch.
    rows = boundary === null
      ? []
      : rows.filter(
          (row) =>
            row.created_at < boundary.created_at ||
            (row.created_at === boundary.created_at && row.id < boundary.id),
        );
  }

  rows = [...rows].sort((a, b) => {
    if (a.created_at !== b.created_at) return a.created_at < b.created_at ? 1 : -1;
    return a.id < b.id ? 1 : -1;
  });
  return rows.slice(0, limit);
}

function legacyHarness(population: Row[]) {
  const capture: Capture = { sql: '', params: [], boundary: null, subquery: null };
  const ctx = {
    db: {
      query: async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
        capture.sql = sql.replace(/\s+/g, ' ').trim();
        capture.params = params;
        return pgResult(executeLegacyList(capture.sql, params, population, capture));
      },
    },
  } as unknown as RouteContext;
  const host = legacyCompatHost(ctx);
  if (host.listLegacyOperations === undefined) throw new Error('host did not wire listLegacyOperations');
  return {
    capture,
    list: (input: { tenantId: string; apiKeyId: string; pageSize: number; pageToken: string | null }) =>
      host.listLegacyOperations!({ states: [], processors: [], ...input }),
  };
}

// ---------------------------------------------------------------------------
// Population. created_at DESC is the walk order, so "below the boundary" means
// an older instant. TENANT_B's row is deliberately NEWER than every TENANT_A
// row: a boundary read from it lets a foreign token produce a non-empty page.
// ---------------------------------------------------------------------------
function population(): Row[] {
  const base = (id: string, tenant: string, key: string, createdAt: string): Row => ({
    id,
    tenant_id: tenant,
    api_key_id: key,
    created_at: createdAt,
    deleted_at: null,
    state: 'SUCCEEDED',
    pipeline_json: null,
  });
  return [
    base('op-a-newest', TENANT_A, KEY_A, '2026-10-01T00:00:00.000Z'),
    base('op-a-mid', TENANT_A, KEY_A, '2026-09-20T00:00:00.000Z'),
    base('op-a-oldest', TENANT_A, KEY_A, '2026-09-10T00:00:00.000Z'),
    // A workflow row of ANOTHER api key in the SAME tenant: hidden by the fence.
    {
      ...base('op-a-other-key', TENANT_A, KEY_B, '2026-10-05T00:00:00.000Z'),
      pipeline_json: JSON.stringify([{ workflow: 'wf-b' }]),
    },
    // Another tenant entirely, newer than everything TENANT_A owns.
    base('op-b-newest', TENANT_B, KEY_B, '2026-10-09T00:00:00.000Z'),
  ];
}

describe('WFA §8 LOW — legacy page token must be scoped (fail-closed)', () => {
  it('the boundary subquery carries the same tenant scope the outer query uses', async () => {
    const h = legacyHarness(population());
    await h.list({ tenantId: TENANT_A, apiKeyId: KEY_A, pageSize: 2, pageToken: 'op-a-mid' });

    const subquery = h.capture.subquery;
    expect(subquery).not.toBeNull();
    const outerTenant = indexOf(h.capture.sql, 'tenant_id');
    const subTenant = indexOf(subquery as string, 'tenant_id');
    expect(subTenant).toBeDefined();
    expect(subTenant).toBe(outerTenant);
  });

  it('a foreign-tenant page token resolves no boundary and returns an empty page', async () => {
    const h = legacyHarness(population());
    const page = await h.list({
      tenantId: TENANT_A,
      apiKeyId: KEY_A,
      pageSize: 2,
      pageToken: 'op-b-newest',
    });

    expect(h.capture.boundary).toBeNull();
    expect(page.rows).toEqual([]);
    expect(page.hasMore).toBe(false);
  });

  it('a same-tenant page token owned by another api key is not resolvable either', async () => {
    const h = legacyHarness(population());
    const page = await h.list({
      tenantId: TENANT_A,
      apiKeyId: KEY_A,
      pageSize: 2,
      pageToken: 'op-a-other-key',
    });

    expect(h.capture.boundary).toBeNull();
    expect(page.rows).toEqual([]);
  });

  it('scope indices survive the states and processors filters being appended', async () => {
    const capture: Capture = { sql: '', params: [], boundary: null, subquery: null };
    const ctx = {
      db: {
        query: async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
          capture.sql = sql.replace(/\s+/g, ' ').trim();
          capture.params = params;
          return pgResult(executeLegacyList(capture.sql, params, population(), capture));
        },
      },
    } as unknown as RouteContext;
    const host = legacyCompatHost(ctx);
    await host.listLegacyOperations!({
      tenantId: TENANT_A,
      apiKeyId: KEY_A,
      pageSize: 2,
      pageToken: 'op-a-mid',
      states: ['SUCCEEDED'],
      processors: ['review'],
    });

    const subquery = capture.subquery as string;
    expect(subquery).not.toBeNull();
    expect(indexOf(subquery, 'tenant_id')).toBe(indexOf(capture.sql, 'tenant_id'));
    expect(indexOf(subquery, 'api_key_id')).toBe(indexOf(capture.sql, 'api_key_id'));
    // The filters must still be bound AFTER the three fixed params.
    expect(capture.params[0]).toBe(TENANT_A);
    expect(capture.params[2]).toBe(KEY_A);
  });

  it('an own page token still walks the caller own rows (no over-fencing)', async () => {
    const h = legacyHarness(population());
    const page = await h.list({
      tenantId: TENANT_A,
      apiKeyId: KEY_A,
      pageSize: 5,
      pageToken: 'op-a-newest',
    });

    expect(h.capture.boundary).not.toBeNull();
    expect(page.rows.map((row) => row.id)).toEqual(['op-a-mid', 'op-a-oldest']);
  });
});

describe('WFA §8 LOW — runtime.listOperations cursor must be scoped too', () => {
  function runtimeHarness(population: Row[]) {
    const capture: Capture = { sql: '', params: [], boundary: null, subquery: null };
    const db = {
      query: async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
        capture.sql = sql.replace(/\s+/g, ' ').trim();
        capture.params = params;
        const subquery = extractBoundarySubquery(capture.sql);
        capture.subquery = subquery;
        if (subquery === null) {
          const rows = population
            .filter((row) => row.tenant_id === paramAt(params, indexOf(capture.sql, 'tenant_id')))
            .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
            .slice(0, Number(params[1]));
          return pgResult(rows);
        }
        const boundary = resolveBoundary(subquery, params, population);
        capture.boundary = boundary;
        const rows = boundary === null
          ? []
          : population
              .filter(
                (row) =>
                  row.tenant_id === paramAt(params, indexOf(capture.sql, 'tenant_id')) &&
                  row.created_at < boundary.created_at,
              )
              .sort((a, b) => (a.created_at < b.created_at ? 1 : -1))
              .slice(0, Number(params[2]));
        return pgResult(rows);
      },
    };
    return { capture, runtime: createRuntimeService(db as never) };
  }

  it('the cursor subquery carries the same tenant scope the outer query uses', async () => {
    const h = runtimeHarness(population());
    await h.runtime.listOperations(TENANT_A, 2, 'op-a-mid');

    const subquery = h.capture.subquery;
    expect(subquery).not.toBeNull();
    const outerTenant = indexOf(h.capture.sql, 'tenant_id');
    const subTenant = indexOf(subquery as string, 'tenant_id');
    expect(subTenant).toBeDefined();
    expect(subTenant).toBe(outerTenant);
  });

  it('a foreign-tenant cursor resolves no boundary and returns no rows', async () => {
    const h = runtimeHarness(population());
    const rows = await h.runtime.listOperations(TENANT_A, 2, 'op-b-newest');

    expect(h.capture.boundary).toBeNull();
    expect(rows).toEqual([]);
  });

  it('an own cursor still walks, and the no-cursor path is unchanged', async () => {
    const h = runtimeHarness(population());
    const walked = await h.runtime.listOperations(TENANT_A, 5, 'op-a-newest');
    expect(walked.map((row) => row.id)).toEqual(['op-a-mid', 'op-a-oldest']);

    // This helper's outer query is TENANT-scoped only — it carries no api_key
    // fence (unlike the legacy list), so the same-tenant row of another key is
    // in scope for it and stays in the first page. The fix must mirror the outer
    // scope exactly, not invent a narrower one.
    const first = await runtimeHarness(population()).runtime.listOperations(TENANT_A, 2);
    expect(first.map((row) => row.id)).toEqual(['op-a-other-key', 'op-a-newest']);
  });
});
