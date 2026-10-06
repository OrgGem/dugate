/**
 * W-CONTRACT-ALIGN-1 (Reviewer T70-C1): the operations-list contract in
 * @du/contracts and the real route in src/server.ts must not drift apart.
 *
 * Drift already happened once: the schema advertised three query parameters,
 * a machine-typed state, a 512-char cursor and a two-field {items,nextCursor}
 * page, while the route accepted five parameters, an operator state group, a
 * 128-char cursor and a five-field envelope. Nothing failed, because no test
 * connected the two. These tests connect them: they drive the actual route()
 * with a recording fake db (offline: no PG, no Redis, no sockets) and
 * validate every response against the published schema. They are built from
 * OPERATIONS_LIST_QUERY_PARAMS and OPERATIONS_STATE_FILTER_VALUES, so a new
 * route parameter or state value cannot be added on one side only.
 */
import {
  LIST_CURSOR_MAX_LEN,
  OPERATIONS_LIST_LIMIT_MAX,
  OPERATIONS_LIST_QUERY_PARAMS,
  OPERATIONS_LIST_SORT_DEFAULT,
  OPERATIONS_LIST_SORT_VALUES,
  OPERATIONS_STATE_FILTER_VALUES,
  OPERATIONS_STATE_FILTER_WIRE_STATES,
  OperationsListPageSchema,
  ListOperationsQuerySchema,
} from '@du/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import { parseOperationsListQuery, route, type RouteContext } from '../src/server';

const ADMIN_TOKEN = 'contract-admin-token';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

function pgResult(rows: Record<string, unknown>[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows: rows as QueryResultRow[],
    fields: [],
  };
}

function opRow(n: number): Record<string, unknown> {
  const at = new Date(Date.UTC(2026, 8, 25, 12, 0, n)).toISOString();
  return {
    id: String(n).padStart(8, '0') + '-0000-4000-8000-000000000000',
    tenant_id: TENANT_A,
    business_id: 'example-review',
    business_version: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    state_version: 1,
    created_at: at,
    updated_at: at,
    deadline_at: null,
    result_ref: null,
  };
}

interface Call {
  sql: string;
  params: unknown[];
}

function ctxFor(search: string, calls: Call[]): RouteContext {
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params });
    if (/SELECT count\(\*\)::int AS total FROM operations/i.test(sql)) {
      return pgResult([{ total: 3 }]);
    }
    if (/^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i.test(sql)) {
      return pgResult([opRow(1), opRow(2)]);
    }
    throw new Error('unexpected operations-list SQL: ' + sql);
  };
  return {
    method: 'GET',
    pathname: '/api/v1/operations',
    searchParams: new URLSearchParams(search),
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN },
    config: { adminToken: ADMIN_TOKEN },
    db: { query },
  } as unknown as RouteContext;
}

async function bodyFor(search: string, calls: Call[] = []): Promise<Record<string, unknown>> {
  const res = await route(ctxFor(search, calls));
  return res.body as Record<string, unknown>;
}

describe('W-CONTRACT-ALIGN-1: route responses satisfy the published page schema', () => {
  it('a default page passes OperationsListPageSchema strict validation', async () => {
    const body = await bodyFor('');
    const parsed = OperationsListPageSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('route response violates the contract: ' + JSON.stringify(parsed.error.issues));
    }
    expect(parsed.success).toBe(true);
  });

  it('the envelope keys the route emits are exactly the contract keys', async () => {
    const body = await bodyFor('');
    expect(Object.keys(body).sort()).toEqual(Object.keys(OperationsListPageSchema.shape).sort());
  });

  it('a two-field page cannot be served, and neither can an extra field', async () => {
    const body = await bodyFor('');
    // The strict schema is the lock: it rejects BOTH the superseded
    // {items,nextCursor} shape and any field the route adds without the
    // contract knowing, which is how the last drift went unnoticed.
    expect(OperationsListPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(false);
    expect(OperationsListPageSchema.safeParse({ ...body, rows: [] }).success).toBe(false);
    expect(OperationsListPageSchema.safeParse(body).success).toBe(true);
  });

  it('total is the population count, never the page length', async () => {
    const body = await bodyFor('limit=2');
    expect((body['items'] as unknown[]).length).toBe(2);
    expect(body['total']).toBe(3);
  });
});

describe('W-CONTRACT-ALIGN-1: the route reads exactly the contract parameter set', () => {
  it('the contract declares six parameters', () => {
    expect([...OPERATIONS_LIST_QUERY_PARAMS]).toEqual([
      'limit',
      'cursor',
      'state',
      'tenant',
      'id',
      'sort',
    ]);
  });

  // W-ADMUX02-SORT-ALLOWLIST-1 moved "sort" from the unknown side of this
  // contract to the declared side, so the exemplar below is a name the contract
  // still does not carry. The property is unchanged and still worth pinning:
  // an undeclared parameter is IGNORED by the route (never 422, never echoed),
  // which is what stops a caller from believing "?offset=10" did something.
  it('an unknown parameter is ignored, so a future page/offset cannot half-exist', () => {
    const parsed = parseOperationsListQuery(
      new URLSearchParams('limit=5&page=3&offset=10&order_by=id&sortBy=created_at')
    );
    expect(parsed.limit).toBe(5);
    expect(parsed.sort.field).toBe('created_at');
    expect(parsed.sort.direction).toBe('desc');
    // order_by / sortBy are the near-miss spellings an operator might guess.
    // Ignoring them silently is deliberate, and the sort stays at its default.
    expect(() => parseOperationsListQuery(new URLSearchParams('order_by=deadbeef'))).not.toThrow();
  });

  it('every contract parameter is actually wired into the parser', () => {
    expect(parseOperationsListQuery(new URLSearchParams('limit=7')).limit).toBe(7);
    const rejecting: Record<string, string> = {
      cursor: 'cursor=not-a-cursor',
      state: 'state=NOPE',
      tenant: 'tenant=bad%20token',
      id: 'id=bad%3Btoken',
      sort: 'sort=created_at:sideways',
    };
    // Derived from the contract instead of a literal list of names, so the
    // parameter added next cycle cannot quietly arrive without a wiring test:
    // a declared name with no rejecting fixture fails on the next line.
    const declared = OPERATIONS_LIST_QUERY_PARAMS.filter((name) => name !== 'limit');
    expect(Object.keys(rejecting).sort()).toEqual([...declared].sort());
    for (const name of declared) {
      expect(() => parseOperationsListQuery(new URLSearchParams(rejecting[name]!))).toThrow();
      // Control: without the parameter the same request is accepted, so the
      expect(() => parseOperationsListQuery(new URLSearchParams('limit=7'))).not.toThrow();
    }
  });

  it('limit is clamped by the route and bounded by the schema', () => {
    expect(parseOperationsListQuery(new URLSearchParams('limit=99999')).limit).toBe(OPERATIONS_LIST_LIMIT_MAX);
    expect(parseOperationsListQuery(new URLSearchParams('limit=0')).limit).toBe(1);
    expect(ListOperationsQuerySchema.safeParse({ limit: OPERATIONS_LIST_LIMIT_MAX }).success).toBe(true);
    expect(ListOperationsQuerySchema.safeParse({ limit: OPERATIONS_LIST_LIMIT_MAX + 1 }).success).toBe(false);
  });

  it('the cursor bound is one number shared by route and schema', () => {
    const tooLong = 'A'.repeat(LIST_CURSOR_MAX_LEN + 8);
    expect(() => parseOperationsListQuery(new URLSearchParams('cursor=' + tooLong))).toThrow();
    expect(ListOperationsQuerySchema.safeParse({ cursor: tooLong }).success).toBe(false);
    expect(ListOperationsQuerySchema.safeParse({ cursor: 'A'.repeat(LIST_CURSOR_MAX_LEN) }).success).toBe(true);
  });
});

describe('W-CONTRACT-ALIGN-1: state is the operator group, not the machine state', () => {
  it('accepts each contract value and rejects a bare machine state', () => {
    for (const value of OPERATIONS_STATE_FILTER_VALUES) {
      expect(() => parseOperationsListQuery(new URLSearchParams('state=' + value))).not.toThrow();
      expect(ListOperationsQuerySchema.safeParse({ state: value }).success).toBe(true);
    }
    for (const machine of ['QUEUED', 'ACCEPTED', 'SUCCEEDED']) {
      expect(() => parseOperationsListQuery(new URLSearchParams('state=' + machine))).toThrow(/must be one of/);
      expect(ListOperationsQuerySchema.safeParse({ state: machine }).success).toBe(false);
    }
  });

  it('the SQL predicate is built from the same expansion the shell filters with', async () => {
    for (const value of OPERATIONS_STATE_FILTER_VALUES) {
      if (value === 'ALL') continue;
      const calls: Call[] = [];
      await bodyFor('state=' + value, calls);
      const page = calls.find((c) => /^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i.test(c.sql));
      expect(page).toBeDefined();
      const bound = page!.params.find((p) => Array.isArray(p));
      expect(bound).toEqual([...OPERATIONS_STATE_FILTER_WIRE_STATES[value as Exclude<typeof value, 'ALL'>]]);
    }
  });
});

/**
 * W-ADMUX02-SORT-ALLOWLIST-1. The sort parameter closes the gap the reviewer
 * recorded as ADM-UX-02(a): the list had a fixed order and no way to ask for
 * another. Two things have to be true at once and they are tested separately:
 * the SORTABLE SET is closed (a value outside it is a 422 on both sides of the
 * contract, never a silent default), and the ORDER BY the route emits is built
 * from literals only, with the id tiebreak intact for every one of them.
 */
const ORDER_BY_BY_SORT: Record<string, string> = {
  'created_at:asc': 'created_at ASC, id ASC',
  'created_at:desc': 'created_at DESC, id DESC',
  'updated_at:asc': 'updated_at ASC, id ASC',
  'updated_at:desc': 'updated_at DESC, id DESC',
  // deadline_at is the nullable column, so its key is coalesced over the sentinel
  // written INLINE as a timestamptz literal: migration 0019 indexes exactly that
  // expression and the planner matches a Const, never a Param bound to the same
  // instant (T-35 measured the parameterised form ordering through a Sort). The
  // literal consumes no placeholder, so filters keep $1.
  'deadline_at:asc': "COALESCE(deadline_at, '9999-12-31T23:59:59.999Z'::timestamptz) ASC, id ASC",
  'deadline_at:desc': "COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz) DESC, id DESC",
};

describe('W-ADMUX02-SORT-ALLOWLIST-1: sort is a closed set, route and schema alike', () => {
  it('advertises exactly the sorts whose ORDER BY text these tests pin', () => {
    // If the contract grows a seventh sort, this fails until the ORDER BY table
    // above is extended too: the advertised list and the tested list are one.
    expect([...OPERATIONS_LIST_SORT_VALUES].sort()).toEqual(Object.keys(ORDER_BY_BY_SORT).sort());
  });

  it('accepts every advertised sort in the parser and the published schema', () => {
    for (const value of OPERATIONS_LIST_SORT_VALUES) {
      expect(() => parseOperationsListQuery(new URLSearchParams('sort=' + value))).not.toThrow();
      expect(ListOperationsQuerySchema.safeParse({ sort: value }).success).toBe(true);
    }
  });

  it('rejects everything else with 422 on BOTH sides — no silent fallback', () => {
    const rejected = [
      // A field without a direction: the shape an operator guesses first, and
      // the one that would be dangerous to guess at (assume desc? assume asc?).
      'created_at',
      'deadline_at',
      // Invented direction, invented field.
      'created_at:sideways',
      'sideways:desc',
      // Real columns the contract does NOT offer. Sorting by them would be a
      // sort nobody advertised, and by state/id it has no stable meaning.
      'state:desc',
      'id:asc',
      'tenant_id:asc',
      'correlation_id:desc',
      'result_ref:asc',
      'api_key_id:desc',
      // Malformed separators.
      ':desc',
      'created_at:',
      'created_at:desc:asc',
      // ORDER BY injection shapes, including the comment and paren forms. None
      // of them parse, so none of them can reach the SQL text as a name.
      'created_at DESC, id DESC',
      'created_at);DROP TABLE operations;--:desc',
      'created_at:desc;--',
      '(created_at):desc',
      'created_at:desc UNION SELECT 1',
    ];
    for (const value of rejected) {
      const schemaRejects = !ListOperationsQuerySchema.safeParse({ sort: value }).success;
      let routeCode = 'ACCEPTED';
      try {
        parseOperationsListQuery(new URLSearchParams('sort=' + encodeURIComponent(value)));
      } catch (err) {
        routeCode = (err as { code?: string }).code ?? 'THREW';
      }
      expect(routeCode).toBe('INVALID_SCHEMA');
      // The agreement is the assertion that matters: schema and route decide
      // the same way for the same value, which is the T70-C1 drift rule
      // applied one parameter wider.
      expect(schemaRejects).toBe(true);
    }
  });

  it('a rejected sort is a 422 before any query, so no page is served under the wrong order', async () => {
    const calls: Call[] = [];
    await expect(route(ctxFor('sort=created_at:sideways', calls))).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_SCHEMA',
    });
    expect(calls).toHaveLength(0);
  });

  it('emits one of the six literal ORDER BY fragments, never the caller text', async () => {
    for (const value of OPERATIONS_LIST_SORT_VALUES) {
      const calls: Call[] = [];
      await bodyFor('sort=' + encodeURIComponent(value), calls);
      const page = calls.find((c) => /^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i.test(c.sql));
      expect(page).toBeDefined();
      const emitted = /ORDER BY (.+) LIMIT \$\d+/.exec(page!.sql)?.[1];
      expect(emitted).toBe(ORDER_BY_BY_SORT[value]);
      // Every fragment ends in the id tiebreak: a sort without it has no
      // defined order between rows sharing a key, and the keyset would skip.
      expect(emitted).toMatch(/, id (ASC|DESC)$/);
      expect(page!.sql).not.toContain(value);
    }
  });

  it('the NULL sentinel for the nullable column is the 0019 inline literal, not a bound parameter', async () => {
    const desc = await sortCalls('sort=deadline_at:desc');
    expect(desc.sql).toContain("COALESCE(deadline_at, '0001-01-01T00:00:00.000Z'::timestamptz)");
    expect(desc.params).not.toContain('0001-01-01T00:00:00.000Z');

    const asc = await sortCalls('sort=deadline_at:asc');
    expect(asc.sql).toContain("COALESCE(deadline_at, '9999-12-31T23:59:59.999Z'::timestamptz)");
    expect(asc.params).not.toContain('9999-12-31T23:59:59.999Z');

    // Between ORDER BY and LIMIT no placeholder may survive: any $n there is the
    // pre-0019 bound-sentinel shape the planner cannot match against the
    // expression index, which would ship the four 0019 indexes as dead code.
    for (const call of [desc, asc]) {
      const key = /ORDER BY (.+?) LIMIT/.exec(call.sql)?.[1];
      expect(key).toBeDefined();
      expect(key).not.toMatch(/\$\d/);
    }

    // A non-nullable key needs no sentinel at all: it must not grow one.
    const plain = await sortCalls('sort=updated_at:asc');
    expect(plain.sql).not.toMatch(/COALESCE/i);
    expect(plain.params).not.toContain('0001-01-01T00:00:00.000Z');
  });

  it('sort never reaches the count, so total stays the population size', async () => {
    const counts: string[] = [];
    for (const value of OPERATIONS_LIST_SORT_VALUES) {
      const calls: Call[] = [];
      await bodyFor('sort=' + value, calls);
      counts.push(calls.find((c) => /SELECT count\(\*\)::int AS total FROM operations/i.test(c.sql))!.sql);
    }
    // Identical text for all six sorts, and no ORDER BY in it: reordering a
    // population does not change how big it is.
    expect(new Set(counts).size).toBe(1);
    expect(counts[0]).not.toMatch(/ORDER BY/i);
  });

  it('an absent sort is byte-identical to the pre-sort route, so old cursors hold', async () => {
    const before = await sortCalls('');
    const explicit = await sortCalls('sort=' + OPERATIONS_LIST_SORT_DEFAULT);
    expect(before.sql).toBe(explicit.sql);
    expect(before.params).toEqual(explicit.params);
    expect(before.sql).toContain('ORDER BY created_at DESC, id DESC');
    expect(before.sql).not.toMatch(/COALESCE/i);
  });
});

async function sortCalls(search: string): Promise<{ sql: string; params: unknown[] }> {
  const calls: Call[] = [];
  await bodyFor(search, calls);
  const found = calls.filter((c) => /^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i.test(c.sql));
  const last = found[found.length - 1];
  return last ? { sql: last.sql, params: last.params } : { sql: '', params: [] };
}
