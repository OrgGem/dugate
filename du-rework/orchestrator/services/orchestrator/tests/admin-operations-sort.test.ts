import {
  fetchOperationDetail,
  clampListLimit,
  OPERATION_LIST_DEFAULT_LIMIT,
  OPERATION_LIST_MAX_LIMIT,
  OPERATION_LIST_CURSOR_MAX_LEN,
} from '../src/app/admin/operation-section-data';
import type { OperationDetailCatalogEntry } from '../src/app/admin/operation-section-data';
import { renderOperationSection } from '../src/app/admin/operation-section-renderer';
import { parseOperationListQuery, parseQueryString } from '../src/app/admin/shell-router';
import { wrapTablesForReflow } from '../src/app/admin/shell-render';
import { route, parseOperationsListQuery, type RouteContext } from '../src/server';
import type { QueryResult, QueryResultRow } from 'pg';
import type { OperationDetail } from '@du/contracts';
import { OPERATIONS_LIST_QUERY_PARAMS, OPERATIONS_LIST_SORT_VALUES, isOperationsListFilterToken } from '@du/contracts';
import { ADMIN_TOKEN, pgResult, dbRow, OPERATIONS_LIST_PAGE_SQL_RE } from './helpers/operations-page-fixture';



/**
 * W-ADMUX02-SORT-ALLOWLIST-1 — keyset paging under every allowed sort.
 *
 * operations-list-contract-conformance proves WHICH SQL the route emits; this
 * block proves that SQL is CORRECT. The fake db parses the key expression, both
 * directions, the boundary operator and the LIMIT placeholder out of the
 * statement the route actually sent and applies them to a real row set — the
 * standing lesson from an earlier cycle, where a fake returning hardcoded rows
 * stayed green while the product paged in the wrong direction.
 *
 * The population attacks the two ways a sort can break a keyset page:
 *   1. Duplicate key values. created_at is not unique, so a page that leans on
 *      the key alone skips or repeats rows; only the id tiebreak orders them.
 *      The shared instants are deliberately DIFFERENT groupings per column, so
 *      a route paging by the wrong column cannot agree with the oracle.
 *   2. A NULL key. deadline_at is the nullable column, and a row-value
 *      comparison is never TRUE against NULL — so ORDER BY deadline_at without a
 *      coalesced key answers page 1 correctly and then silently drops every
 *      deadline-less operation. Four of these twelve rows have no deadline on
 *      purpose, and a full walk must still bring all twelve back.
 */
describe('W-ADMUX02-SORT-ALLOWLIST-1: keyset paging stays exact under every sort', () => {
  /** [rank, createdAgoH, updatedAgoH, deadlineAgoH|null] — see the note above. */
  const FIXTURE: [number, number, number, number | null][] = [
    [1, 0, 0, 4],
    [2, 0, 1, 2],
    [3, 1, 1, 4],
    [4, 1, 2, null],
    [5, 2, 2, null],
    [6, 3, 3, null],
    [7, 3, 4, null],
    [8, 4, 4, 6],
    [9, 5, 5, 8],
    [10, 5, 6, 8],
    [11, 6, 7, 10],
    [12, 7, 8, 12],
  ];

  function idOfRank(rank: number): string {
    return String(rank).padStart(8, '0') + '-0000-4000-8000-000000000000';
  }
  function rankOf(id: string): number {
    return Number(id.slice(0, 8));
  }
  function instant(hoursAgo: number): string {
    return new Date(Date.UTC(2026, 8, 25, 12) - hoursAgo * 3600000).toISOString();
  }
  function population(): Record<string, unknown>[] {
    return FIXTURE.map(([rank, createdH, updatedH, deadlineH]) =>
      dbRow(idOfRank(rank), instant(createdH), {
        updated_at: instant(updatedH),
        deadline_at: deadlineH === null ? null : instant(deadlineH),
      })
    );
  }

  /**
   * Restated here on purpose instead of imported from the route: if the product
   * constant ever disagrees with the rule "the NULL block sits at the END of
   * the ordering", this oracle and the route must come apart.
   */
  const NULL_BOUND: Record<'asc' | 'desc', string> = {
    desc: '0001-01-01T00:00:00.000Z',
    asc: '9999-12-31T23:59:59.999Z',
  };

  type SortDir = 'asc' | 'desc';

  function keyOf(row: Record<string, unknown>, field: string, direction: SortDir): string {
    const value = row[field];
    if (value === null || value === undefined) {
      return direction === 'desc' ? NULL_BOUND.desc : NULL_BOUND.asc;
    }
    return String(value);
  }

  /** The order a correct implementation must return, computed independently. */
  function expectedOrder(field: string, direction: SortDir): number[] {
    const sign = direction === 'asc' ? 1 : -1;
    return [...population()]
      .sort((a, b) => {
        const ka = keyOf(a, field, direction);
        const kb = keyOf(b, field, direction);
        if (ka !== kb) return ka < kb ? -sign : sign;
        // The id tiebreak follows the key direction, so equal keys are ordered
        // too and a page boundary can never split a set two different ways.
        const ia = String(a['id']);
        const ib = String(b['id']);
        return ia < ib ? -sign : sign;
      })
      .map((row) => rankOf(String(row['id'])));
  }

  /**
   * Applies the emitted statement. Anything unrecognised throws, so a route
   * that changes shape fails loudly here rather than paging past rows quietly.
   */
  function execute(sql: string, params: unknown[]): Record<string, unknown>[] {
    const order = /ORDER BY (.+?) (ASC|DESC), id (ASC|DESC)/.exec(sql);
    if (!order) throw new Error('page SQL has no recognisable ORDER BY key + id tiebreak: ' + sql);
    const keyExpr = order[1] as string;
    const keyDir = order[2] as 'ASC' | 'DESC';
    const idDir = order[3] as 'ASC' | 'DESC';
    if (keyDir !== idDir) {
      throw new Error('the id tiebreak must follow the key direction, got ' + keyDir + '/' + idDir);
    }

    const limitParam = /LIMIT \$(\d+)$/.exec(sql);
    if (!limitParam) throw new Error('page SQL has no bound LIMIT: ' + sql);
    const limit = Number(params[Number(limitParam[1]) - 1]);

    let field: string;
    let nullBound: string | null = null;
    const coalesced = /^COALESCE\((\w+), '([^']*)'::timestamptz\)$/.exec(keyExpr);
    if (coalesced) {
      field = coalesced[1] as string;
      nullBound = coalesced[2] as string;
    } else if (/^COALESCE\((\w+), \$\d+::timestamptz\)$/.test(keyExpr)) {
      // 0019 indexes COALESCE(deadline_at, '<sentinel>'::timestamptz) as a Const
      // expression; a bound Param never matches it, so the parameterised form is
      // the dead-index regression T-35 measured, not a shape to page faithfully.
      throw new Error('ORDER BY sentinel regressed to the bound-parameter form: ' + keyExpr);
    } else if (/^\w+$/.test(keyExpr)) {
      field = keyExpr;
    } else {
      throw new Error('unrecognised ORDER BY key expression: ' + keyExpr);
    }
    const rowKey = (row: Record<string, unknown>): string => {
      const value = row[field];
      if (value === null || value === undefined) {
        if (nullBound === null) {
          throw new Error('a NULL ' + field + ' was ordered by a key with no NULL handling');
        }
        return nullBound;
      }
      return String(value);
    };

    let kept = population();
    // The boundary either opens the WHERE list or is joined onto a filter, and
    // which of the two it is depends on how many predicates the request
    // carries, so the interpreter accepts either introducer.
    const boundary = /(?: WHERE | AND )\((.+?), id\) ([<>]) \(\$(\d+)::timestamptz, \$(\d+)::uuid\)/.exec(sql);
    if (!boundary && /, id\) [<>] \(/.test(sql)) {
      // Without this guard, a shape the interpreter cannot read degrades into
      // no boundary at all: the fake returns the whole population and a
      // paging test fails as an endless walk instead of saying what broke.
      throw new Error('a keyset boundary is in the SQL but the interpreter could not read it: ' + sql);
    }
    if (boundary) {
      // The predicate must name the SAME expression the ORDER BY used. Ordering
      // by one expression while comparing against another is how a keyset page
      // skips rows, and this is the one place that can catch it.
      if (boundary[1] !== keyExpr) {
        throw new Error('boundary key ' + boundary[1] + ' differs from ORDER BY key ' + keyExpr);
      }
      const op = boundary[2] as '<' | '>';
      const boundKey = String(params[Number(boundary[3]) - 1]);
      const boundId = String(params[Number(boundary[4]) - 1]);
      // A row-value comparison is plain lexicographic order: which rows sit on
      // which side of the boundary does not depend on the ORDER BY direction,
      // only which side the walk happens to be travelling to. Every key here is
      // a canonical ISO instant of identical width, so string order IS
      // instant order, and the ids are equal-width uuid strings.
      kept = kept.filter((row) => {
        const k = rowKey(row);
        const id = String(row['id']);
        return op === '<'
          ? k < boundKey || (k === boundKey && id < boundId)
          : k > boundKey || (k === boundKey && id > boundId);
      });
    }

    kept.sort((a, b) => {
      const ka = rowKey(a);
      const kb = rowKey(b);
      if (ka !== kb) return ka < kb ? -sign2(keyDir) : sign2(keyDir);
      const ia = String(a['id']);
      const ib = String(b['id']);
      return ia < ib ? -sign2(keyDir) : sign2(keyDir);
    });
    return kept.slice(0, limit);
  }
  function sign2(dir: 'ASC' | 'DESC'): number {
    return dir === 'ASC' ? 1 : -1;
  }

  function sortRoute(): {
    calls: { sql: string; params: unknown[] }[];
    get: (search: string) => Promise<Record<string, unknown>>;
  } {
    const calls: { sql: string; params: unknown[] }[] = [];
    const ctx = {
      method: 'GET',
      pathname: '/api/v1/operations',
      searchParams: new URLSearchParams(''),
      headers: { authorization: 'Bearer ' + ADMIN_TOKEN },
      config: { adminToken: ADMIN_TOKEN },
      db: {
        query: async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
          calls.push({ sql, params });
          if (/SELECT count\(\*\)::int AS total FROM operations/i.test(sql)) {
            return pgResult([{ total: FIXTURE.length }]);
          }
          if (!OPERATIONS_LIST_PAGE_SQL_RE.test(sql)) {
            throw new Error('unexpected SQL: ' + sql);
          }
          return pgResult(execute(sql, params));
        },
      },
    } as unknown as RouteContext;
    return {
      calls,
      async get(search: string) {
        (ctx as unknown as { searchParams: URLSearchParams }).searchParams = new URLSearchParams(search);
        return (await route(ctx)).body as Record<string, unknown>;
      },
    };
  }

  function ranks(body: Record<string, unknown>): number[] {
    return (body['items'] as { id: string }[]).map((row) => rankOf(row.id));
  }

  /** Follow nextCursor to the end. Bounded, so a broken cursor fails instead of looping. */
  async function walkAll(search: string, limit: number): Promise<number[]> {
    const db = sortRoute();
    const seen: number[] = [];
    let body = await db.get('limit=' + limit + (search ? '&' + search : ''));
    for (let hop = 0; hop < FIXTURE.length + 2; hop += 1) {
      seen.push(...ranks(body));
      const next = body['nextCursor'] as string | null;
      if (next === null) return seen;
      body = await db.get('limit=' + limit + (search ? '&' + search : '') + '&cursor=' + encodeURIComponent(next));
    }
    throw new Error('the walk never ended after ' + (FIXTURE.length + 2) + ' hops');
  }

  it.each([...OPERATIONS_LIST_SORT_VALUES])('%s: a full walk returns the oracle order exactly', async (value) => {
    const parts = String(value).split(':');
    const field = parts[0] as string;
    const direction = parts[1] as SortDir;
    // limit 3 over 12 rows = 4 hops, enough for a boundary to fall inside every
    // duplicated-key group in the fixture.
    expect(await walkAll('sort=' + value, 3)).toEqual(expectedOrder(field, direction));
  });

  it('no deadline-less operation is ever lost, in either direction', async () => {
    // The named hazard: rows 4, 5, 6 and 7 have no deadline, and a bare
    // (deadline_at, id) < (...) comparison excludes every one of them, so the
    // walk would come back with 8 of 12 and never say so.
    for (const value of ['deadline_at:desc', 'deadline_at:asc']) {
      const seen = await walkAll('sort=' + value, 2);
      expect(new Set(seen).size).toBe(FIXTURE.length);
      expect(seen).toHaveLength(FIXTURE.length);
    }
  });

  it('a page boundary inside a duplicate-key group neither skips nor repeats a row', async () => {
    // limit 1 forces the boundary to cut through each group of rows sharing an
    // instant, which is precisely where a missing id tiebreak shows up.
    for (const value of [...OPERATIONS_LIST_SORT_VALUES]) {
      const seen = await walkAll('sort=' + value, 1);
      expect(seen).toHaveLength(FIXTURE.length);
      expect(new Set(seen).size).toBe(FIXTURE.length);
    }
  });

  it('the tiebreak orders equal keys by id in the SAME direction as the key', async () => {
    // Ranks 1 and 2 share the NEWEST created_at, ranks 9 and 10 share another.
    const down = ranks(await sortRoute().get('limit=5&sort=created_at:desc'));
    // DESC takes the larger id first inside a shared instant...
    expect(down.slice(0, 2)).toEqual([2, 1]);
    // ...and ASC reverses the key and the tiebreak together: the oldest instant
    // comes first (rank 12), and inside a shared instant the SMALLER id does.
    const up = ranks(await sortRoute().get('limit=5&sort=created_at:asc'));
    expect(up[0]).toBe(12);
    expect(up.indexOf(9)).toBeLessThan(up.indexOf(10));
  });

  it('a backward hop returns the identical page under a reversed primary order', async () => {
    // The direction flip is the part a sort changes: with sort=updated_at:asc a
    // forward hop walks UP the key, so the backward hop must walk DOWN it.
    const db = sortRoute();
    const p1 = await db.get('limit=3&sort=updated_at:asc');
    const p2 = await db.get('limit=3&sort=updated_at:asc&cursor=' + encodeURIComponent(p1['nextCursor'] as string));
    expect(p2['prevCursor']).not.toBe(null);
    const back = await db.get('limit=3&sort=updated_at:asc&cursor=' + encodeURIComponent(p2['prevCursor'] as string));
    expect(ranks(back)).toEqual(ranks(p1));
    expect(back['prevCursor']).toBe(null);
  });

  it('sort reorders the page but never the population count', async () => {
    for (const value of [...OPERATIONS_LIST_SORT_VALUES]) {
      const body = await sortRoute().get('limit=2&sort=' + value);
      expect(body['total']).toBe(FIXTURE.length);
    }
  });
});
