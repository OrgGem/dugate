/**
 * T140-A1 (Reviewer Turn 140): a keyset cursor is a position IN AN ORDERING,
 * and the operations list route used to accept it against whatever ordering the
 * caller asked for. A `created_at` cursor replayed with `?sort=deadline_at`
 * became a deadline-order boundary built from a created_at instant, so the page
 * it selected was neither the continuation the caller meant nor a boundary the
 * deadline ordering ever passes through: rows lost behind a 200 that looks
 * plausible. The offline paging suites of W-ADMUX02-SORT-ALLOWLIST-1 paged
 * correctly WITHIN each sort and could not see a cross-sort replay at all.
 *
 * W-ADMUX02-SORT-CURSOR-BIND-1 binds the ordering into the token
 * (`<ISO>|<uuid>|<field>:<direction>[|p]`) and rejects a mismatch. These tests
 * drive the real route with a recording fake db — offline: no PG, no Redis, no
 * sockets — and pin what the finding demands: every minted token names its
 * ordering; a mismatch is a 422 raised before any query runs; tokens written
 * before the sort parameter existed keep paging the only order they could have
 * meant; and the longer token still fits the single 128-character cursor bound
 * that the contract, the route and the admin shell share.
 *
 * Token payloads are built and split by this file's own copy of the grammar, so
 * a bug in the production codec cannot make a binding assertion vacuous.
 */
import {
  LIST_CURSOR_MAX_LEN,
  OPERATIONS_LIST_SORT_DEFAULT,
  OPERATIONS_LIST_SORT_VALUES,
  OperationsListPageSchema,
} from '@du/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import { parseOperationsListQuery, route, type RouteContext } from '../src/server';

const ADMIN_TOKEN = 'cursor-bind-admin-token';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

/** Independently restated grammar: the production codec is never imported. */
function buildToken(key: string, id: string, sortSpec?: string, backward?: boolean): string {
  const payload = [key, id, ...(sortSpec ? [sortSpec] : []), ...(backward ? ['p'] : [])].join('|');
  return Buffer.from(payload, 'utf8').toString('base64url');
}

function tokenParts(token: string): string[] {
  return Buffer.from(token, 'base64url').toString('utf8').split('|');
}

/**
 * Three rows whose sortable columns are deliberately far apart: created today,
 * updated days earlier, deadline months later (and one with no deadline). The
 * separation is what makes a mis-bound cursor provably lose rows, and it means
 * the key a cursor carries can only be right for one of the three columns.
 */
interface Row {
  id: string;
  created: string;
  updated: string;
  deadline: string | null;
}

const POPULATION: Row[] = [
  { id: '11111111-1111-4111-8111-111111111111', created: '2026-09-25T12:00:01.000Z', updated: '2026-09-20T08:00:00.000Z', deadline: '2026-12-01T00:00:00.000Z' },
  { id: '22222222-2222-4222-8222-222222222222', created: '2026-09-25T12:00:02.000Z', updated: '2026-09-21T08:00:00.000Z', deadline: '2026-11-01T00:00:00.000Z' },
  { id: '33333333-3333-4333-8333-333333333333', created: '2026-09-25T12:00:03.000Z', updated: '2026-09-22T08:00:00.000Z', deadline: null },
];

function asDbRows(): Record<string, unknown>[] {
  return POPULATION.map((row) => ({
    id: row.id,
    tenant_id: TENANT_A,
    business_id: 'example-review',
    business_version: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    state_version: 1,
    created_at: row.created,
    updated_at: row.updated,
    deadline_at: row.deadline,
    result_ref: null,
  }));
}

interface Call {
  sql: string;
  params: unknown[];
}

function ctxFor(search: string, calls: Call[]): RouteContext {
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params });
    if (/SELECT count\(\*\)::int AS total FROM operations/i.test(sql)) {
      return pgResult([{ total: POPULATION.length }]);
    }
    if (/^SELECT \* FROM operations/i.test(sql)) {
      return pgResult(asDbRows());
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

function pgResult(rows: Record<string, unknown>[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows: rows as QueryResultRow[],
    fields: [],
  };
}

interface Outcome {
  ok: boolean;
  status: number;
  code: string;
  detail: string;
  body: Record<string, unknown>;
}

/**
 * route() throws the HttpError and the HTTP boundary turns it into
 * problem+json, so a rejected request is observed as a rejection here — the
 * same way the conformance suite reads it.
 */
async function run(search: string, calls: Call[] = []): Promise<Outcome> {
  try {
    const res = await route(ctxFor(search, calls));
    return {
      ok: true,
      status: res.status,
      code: 'ACCEPTED',
      detail: '',
      body: (res.body ?? {}) as Record<string, unknown>,
    };
  } catch (err) {
    const e = err as { status?: number; code?: string; message?: string };
    return {
      ok: false,
      status: e.status ?? 500,
      code: e.code ?? 'THREW',
      detail: e.message ?? '',
      body: {},
    };
  }
}

async function mint(sortSpec: string | null, extra = ''): Promise<string> {
  const search = 'limit=1' + (sortSpec === null ? '' : '&sort=' + sortSpec) + extra;
  const out = await run(search);
  if (!out.ok) throw new Error('minting request was rejected: ' + out.status + ' ' + out.code);
  const cursor = out.body['nextCursor'];
  if (typeof cursor !== 'string' || cursor.length === 0) {
    throw new Error('route issued no next cursor for ' + search);
  }
  return cursor;
}

describe('T140-A1: a minted cursor names the ordering it is a position in', () => {
  it.each([...OPERATIONS_LIST_SORT_VALUES])('%s carries its own spec in the token', async (sort) => {
    const parts = tokenParts(await mint(sort));
    // [key, uuid, ordering]: the third slot is the whole point of the packet.
    expect(parts).toHaveLength(3);
    expect(parts[2]).toBe(sort);
  });

  it('the boundary key moves with the sort instead of always being created_at', async () => {
    expect(tokenParts(await mint('created_at:desc'))[0]).toBe('2026-09-25T12:00:01.000Z');
    expect(tokenParts(await mint('updated_at:desc'))[0]).toBe('2026-09-20T08:00:00.000Z');
    expect(tokenParts(await mint('deadline_at:desc'))[0]).toBe('2026-12-01T00:00:00.000Z');
  });

  it('both cursors of a page carry the same ordering', async () => {
    const next = await mint('deadline_at:asc');
    const out = await run('limit=1&sort=deadline_at:asc&cursor=' + encodeURIComponent(next));
    expect(out.ok).toBe(true);
    const nextParts = tokenParts(out.body['nextCursor'] as string);
    const prevParts = tokenParts(out.body['prevCursor'] as string);
    expect(nextParts[2]).toBe('deadline_at:asc');
    expect(prevParts[2]).toBe('deadline_at:asc');
    // The backward marker is a fourth slot, after the ordering: one ?cursor=
    // parameter still serves both hops.
    expect(prevParts).toHaveLength(4);
    expect(prevParts[3]).toBe('p');
  });

  it('the walk direction and the sort direction are separate axes', async () => {
    const backward = buildToken('2026-12-01T00:00:00.000Z', POPULATION[0]!.id, 'deadline_at:asc', true);
    const same: Call[] = [];
    expect((await run('limit=1&sort=deadline_at:asc&cursor=' + backward, same)).ok).toBe(true);
    expect(same.length).toBeGreaterThan(0);
    // Same token, the OTHER direction of the same field: |p still parses, but
    // the ordering no longer matches, so this is a mismatch and no query runs.
    const wrong: Call[] = [];
    const bad = await run('limit=1&sort=deadline_at:desc&cursor=' + backward, wrong);
    expect(bad.status).toBe(422);
    expect(wrong).toHaveLength(0);
  });

  it('every token stays inside the one cursor bound the contract, route and shell share', async () => {
    const lengths: number[] = [];
    for (const sort of OPERATIONS_LIST_SORT_VALUES) {
      const next = await mint(sort);
      lengths.push(next.length);
      const out = await run('limit=1&sort=' + sort + '&cursor=' + encodeURIComponent(next));
      expect(out.status).toBe(200);
      lengths.push((out.body['nextCursor'] as string).length);
      lengths.push((out.body['prevCursor'] as string).length);
      // The admin shell truncates a cursor at this same bound rather than
      // rejecting it, and OperationsListPageSchema caps both cursor fields at
      // it, so a token over the line would be cut into a corrupt 422 trip and
      // the response would stop satisfying its own contract.
      expect(OperationsListPageSchema.safeParse(out.body).success).toBe(true);
    }
    expect(Math.max(...lengths)).toBeLessThanOrEqual(LIST_CURSOR_MAX_LEN);
  });
});

/**
 * The finding as one sentence: a cursor from created_at could be replayed with
 * deadline_at sort. The fix is an equivalence check, so it has to hold for the
 * whole cross product rather than for the one pair the audit happened to name.
 */
describe('T140-A1: a cursor cannot page an ordering it was not minted for', () => {
  it.each([...OPERATIONS_LIST_SORT_VALUES])('a %s cursor is accepted by that sort and by no other', async (minted) => {
    const token = await mint(minted);
    for (const replayed of OPERATIONS_LIST_SORT_VALUES) {
      const calls: Call[] = [];
      const out = await run('limit=1&sort=' + replayed + '&cursor=' + encodeURIComponent(token), calls);
      if (replayed === minted) {
        expect(out.ok).toBe(true);
        expect(calls.length).toBeGreaterThan(0);
      } else {
        expect(out.status).toBe(422);
        expect(out.code).toBe('INVALID_SCHEMA');
        // Nothing may reach the database: a page built from a position in
        // another order IS the defect, so answering 422 after querying would
        // still have served the wrong slice to anything downstream.
        expect(calls).toHaveLength(0);
      }
    }
  });

  it('the named case: a created_at cursor replayed against deadline_at is refused', async () => {
    const token = await mint('created_at:desc');
    const calls: Call[] = [];
    const out = await run('limit=1&sort=deadline_at:desc&cursor=' + encodeURIComponent(token), calls);
    expect(out.status).toBe(422);
    expect(out.code).toBe('INVALID_SCHEMA');
    expect(calls).toHaveLength(0);
  });

  it('omitting ?sort is not an escape hatch: the default order is a real order', async () => {
    const token = await mint('deadline_at:asc');
    const explicit: Call[] = [];
    expect((await run('limit=1&sort=created_at:desc&cursor=' + encodeURIComponent(token), explicit)).status).toBe(422);
    expect(explicit).toHaveLength(0);
    // An absent sort resolves to that same default order, so it must be
    // refused identically — otherwise the guard is bypassed by deleting one
    // parameter from the URL.
    const absent: Call[] = [];
    expect((await run('limit=1&cursor=' + encodeURIComponent(token), absent)).status).toBe(422);
    expect(absent).toHaveLength(0);
  });

  it('the rejection names both orderings and the way out', async () => {
    const token = await mint('created_at:desc');
    const out = await run('limit=1&sort=deadline_at:desc&cursor=' + encodeURIComponent(token));
    expect(out.detail).toContain('created_at:desc');
    expect(out.detail).toContain('deadline_at:desc');
    // An operator-facing remedy: the correct client behaviour (drop the cursor
    // when the ordering changes) is not guessable from a bare invalid-cursor.
    expect(out.detail.toLowerCase()).toContain('drop the cursor');
    // The token is not echoed back: it is caller data and adds nothing.
    expect(out.detail).not.toContain(token);
  });

  it('quantifies the hazard the guard closes: the mis-bound page would have been empty', async () => {
    const token = await mint('created_at:desc');
    const createdBoundary = tokenParts(token)[0]!;
    // A page under deadline_at:desc continues with every row whose deadline is
    // strictly below the boundary. All three deadlines are 2026-10-01 or later
    // while the created_at boundary is 2026-09-25, so a mis-bound predicate
    // matches nothing: two rows that are still unlisted become unreachable
    // behind a 200 with an empty page. ISO-8601 UTC instants of this exact
    // shape order correctly as strings.
    const stillListed = POPULATION.filter((row) => row.deadline !== null && row.deadline < createdBoundary);
    expect(stillListed).toHaveLength(0);
    expect(POPULATION.length - 1).toBe(2);
    // And the route never builds that statement at all.
    const calls: Call[] = [];
    const out = await run('limit=1&sort=deadline_at:desc&cursor=' + encodeURIComponent(token), calls);
    expect(out.status).toBe(422);
    expect(calls.some((call) => /deadline_at/i.test(call.sql))).toBe(false);
  });
});

function pageCall(calls: Call[]): Call {
  const found = calls.filter((call) => /^SELECT \* FROM operations/i.test(call.sql));
  const last = found[found.length - 1];
  if (!last) throw new Error('no page statement was issued');
  return last;
}

/** A token in the pre-T140-A1 grammar: position only, no ordering slot. */
const LEGACY = buildToken('2026-09-25T12:00:02.000Z', POPULATION[1]!.id);
const LEGACY_BACK = buildToken('2026-09-25T12:00:02.000Z', POPULATION[1]!.id, undefined, true);

describe('T140-A1 compatibility: tokens written before the sort parameter existed still page', () => {
  it('a position-only token pages the default order, and nothing renumbers its binds', async () => {
    const calls: Call[] = [];
    const out = await run('limit=1&cursor=' + LEGACY, calls);
    expect(out.ok).toBe(true);
    const page = pageCall(calls);
    expect(page.sql).toContain('WHERE (created_at, id) < ($1::timestamptz, $2::uuid)');
    // The whole bind list rather than a contains-check: the token's key and id
    // land first and the LIMIT probe last, exactly as they did before the sort
    // parameter existed and before the ordering slot was added.
    expect(page.params).toEqual(['2026-09-25T12:00:02.000Z', POPULATION[1]!.id, 2]);
  });

  it('a position-only backward token is still read as backward under the default order', async () => {
    const calls: Call[] = [];
    expect((await run('limit=1&sort=created_at:desc&cursor=' + LEGACY_BACK, calls)).ok).toBe(true);
    const page = pageCall(calls);
    // Both halves of the old trailing marker: the walk takes the other side of
    // the boundary and the scan reverses so LIMIT picks the adjacent block. If
    // the new slot parsing mistook |p for an ordering (or an ordering for the
    // marker), this is where a previous-page link silently becomes a forward
    // page — the failure W-ADMUX02-SRV-1-FIX was written for.
    expect(page.sql).toContain('WHERE (created_at, id) > ($1::timestamptz, $2::uuid)');
    expect(page.sql).toContain('ORDER BY created_at ASC, id ASC');
  });

  it('the default order with a legacy cursor emits the statement it emitted before, plus the WHERE it was missing', async () => {
    const calls: Call[] = [];
    await run('limit=1&cursor=' + LEGACY, calls);
    expect(pageCall(calls).sql).toBe(
      'SELECT * FROM operations WHERE (created_at, id) < ($1::timestamptz, $2::uuid) ORDER BY created_at DESC, id DESC LIMIT $3'
    );
  });

  it.each([...OPERATIONS_LIST_SORT_VALUES].filter((value) => value !== OPERATIONS_LIST_SORT_DEFAULT))(
    'a position-only token is refused by %s rather than reinterpreted',
    async (sort) => {
      const calls: Call[] = [];
      const out = await run('limit=1&sort=' + sort + '&cursor=' + LEGACY, calls);
      expect(out.status).toBe(422);
      expect(out.code).toBe('INVALID_SCHEMA');
      expect(calls).toHaveLength(0);
    }
  );
});

/**
 * Companion finding, surfaced by the compatibility test above. The filters and
 * the cursor predicate were concatenated as `SELECT * FROM operations` +
 * ` WHERE ...` + ` AND (...)`, which is valid SQL only when a filter exists.
 * A cursor with NO filter — pressing Next on the unfiltered cross-tenant admin
 * list, which is the commonest page-2 request in that pane — produced
 * `FROM operations AND (created_at, id) < (...)`: a syntax error at the
 * database. Nothing offline could see it, because a fake db accepts any string.
 * These cases pin the composition of the statement, not a fragment of it.
 */
describe('companion finding: every emitted page statement is one a database can parse', () => {
  // Every cursor here names the ordering its own request asks for, so the
  // binding guard is not what these cases exercise: the only question is
  // whether the assembled statement is one a database can parse.
  const combos: { label: string; search: string; cursor: string }[] = [
    { label: 'no filter, forward cursor', search: '', cursor: LEGACY },
    { label: 'no filter, backward cursor', search: '', cursor: LEGACY_BACK },
    { label: 'no filter, no cursor', search: '', cursor: '' },
    { label: 'state filter with a cursor', search: 'state=RUNNING&', cursor: LEGACY },
    { label: 'tenant and id filters with a cursor', search: 'tenant=' + TENANT_A + '&id=2222&', cursor: LEGACY },
    { label: 'nullable sort key with a cursor', search: 'sort=deadline_at:desc&', cursor: buildToken('2026-12-01T00:00:00.000Z', POPULATION[0]!.id, 'deadline_at:desc') },
    { label: 'ascending nullable key backward', search: 'sort=deadline_at:asc&', cursor: buildToken('2026-11-01T00:00:00.000Z', POPULATION[1]!.id, 'deadline_at:asc', true) },
  ];

  it.each(combos)('$label', async ({ search, cursor }) => {
    const calls: Call[] = [];
    const request = 'limit=2&' + search + (cursor.length === 0 ? '' : 'cursor=' + cursor);
    expect((await run(request, calls)).ok).toBe(true);
    const page = pageCall(calls);
    // Whatever sits between the table name and the ORDER BY is the predicate
    // list, and a predicate list must open with WHERE.
    const from = page.sql.indexOf('operations') + 'operations'.length;
    const middle = page.sql.slice(from, page.sql.indexOf(' ORDER BY '));
    expect(middle).not.toMatch(/^\s*AND\b/);
    if (middle.length > 0) expect(middle.startsWith(' WHERE ')).toBe(true);
    expect(page.sql).not.toMatch(/operations\s+AND\b/i);
    // Placeholder numbering stays dense and ends at the bind list: filters,
    // then the NULL sentinel, then the boundary key and id, then LIMIT. A gap
    // or a repeat means two builders disagree about who pushed what, and pg
    // would silently bind the wrong value into the boundary.
    const numbers = [...page.sql.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]));
    const unique = [...new Set(numbers)].sort((a, b) => a - b);
    expect(unique).toEqual(Array.from({ length: unique.length }, (_, i) => i + 1));
    expect(unique[unique.length - 1]).toBe(page.params.length);
    expect(page.params[page.params.length - 1]).toBe(3);
  });
});

function rawToken(payload: string): string {
  return Buffer.from(payload, 'utf8').toString('base64url');
}

const KEY = '2026-09-25T12:00:02.000Z';
const UUID = POPULATION[1]!.id;

describe('T140-A1: an ordering slot this route never minted is invalid, never a fallback', () => {
  const malformed: { label: string; payload: string }[] = [
    { label: 'unknown field', payload: [KEY, UUID, 'bogus:desc'].join('|') },
    { label: 'unknown direction', payload: [KEY, UUID, 'created_at:sideways'].join('|') },
    { label: 'field with no direction', payload: [KEY, UUID, 'created_at'].join('|') },
    { label: 'direction with no field', payload: [KEY, UUID, ':desc'].join('|') },
    { label: 'extra colon in the slot', payload: [KEY, UUID, 'created_at:desc:asc'].join('|') },
    { label: 'a real column that is not sortable', payload: [KEY, UUID, 'correlation_id:desc'].join('|') },
    { label: 'a trailing junk slot', payload: [KEY, UUID, 'created_at:desc', 'junk'].join('|') },
    { label: 'two walk markers', payload: [KEY, UUID, 'created_at:desc', 'p', 'p'].join('|') },
    { label: 'an empty ordering slot', payload: [KEY, UUID, '', 'created_at:desc'].join('|') },
    { label: 'the uuid slot empty', payload: [KEY, '', 'created_at:desc'].join('|') },
    { label: 'key and uuid swapped', payload: [UUID, KEY, 'created_at:desc'].join('|') },
    { label: 'a single slot with no separator', payload: 'not-a-cursor' },
    { label: 'only an ordering, no position', payload: ['created_at:desc'].join('|') },
    { label: 'SQL-shaped slot', payload: [KEY, UUID, 'created_at); DROP TABLE operations;--:desc'].join('|') },
  ];

  it.each(malformed)('$label is a 422 before any query', async ({ payload }) => {
    const calls: Call[] = [];
    const out = await run('limit=1&sort=created_at:desc&cursor=' + rawToken(payload), calls);
    expect(out.status).toBe(422);
    expect(out.code).toBe('INVALID_SCHEMA');
    expect(out.detail).toContain('cursor is not a valid');
    expect(calls).toHaveLength(0);
  });

  it('the shared length bound still applies to the longer token', async () => {
    const calls: Call[] = [];
    const out = await run('cursor=' + 'A'.repeat(LIST_CURSOR_MAX_LEN + 1), calls);
    expect(out.status).toBe(422);
    expect(calls).toHaveLength(0);
  });

  it('the parser exposes the bound ordering instead of making the route re-derive it', () => {
    const bound = parseOperationsListQuery(new URLSearchParams('sort=updated_at:asc&cursor=' + buildToken(KEY, UUID, 'updated_at:asc')));
    expect(bound.cursor?.sort).toEqual({ field: 'updated_at', direction: 'asc' });
    expect(bound.sort).toEqual(bound.cursor?.sort);
    const legacy = parseOperationsListQuery(new URLSearchParams('cursor=' + LEGACY));
    expect(legacy.cursor?.sort).toEqual({ field: 'created_at', direction: 'desc' });
  });
});

describe('T140-A1 scope: the cursor is bound to the ordering, to nothing else', () => {
  it('filters may change under a cursor: a position is not a query', async () => {
    const token = await mint('created_at:desc', '&state=RUNNING');
    const calls: Call[] = [];
    const out = await run('limit=1&state=FAILED&cursor=' + encodeURIComponent(token), calls);
    expect(out.ok).toBe(true);
    expect(pageCall(calls).sql).toContain('state = ANY(');
    // Same keyset position, different population: legal by design. The
    // boundary is still a row the caller has seen, and binding filters into
    // the token would break every deep link that changes a filter while
    // staying on a page.
    expect(pageCall(calls).params[pageCall(calls).params.length - 3]).toBe('2026-09-25T12:00:01.000Z');
  });

  it('the page size may change under a cursor', async () => {
    const token = await mint('updated_at:desc');
    const calls: Call[] = [];
    expect((await run('limit=3&sort=updated_at:desc&cursor=' + encodeURIComponent(token), calls)).ok).toBe(true);
    expect(pageCall(calls).params).toContain(4);
  });

  it('the ordering slot is normalised the same way the query parameter is', async () => {
    // The slot is read by the contract parser, which trims and lowercases, so
    // an upper-case slot from a hand-built URL binds to the same ordering.
    const token = buildToken('2026-12-01T00:00:00.000Z', UUID, 'DEADLINE_AT:DESC');
    const calls: Call[] = [];
    expect((await run('limit=1&sort=deadline_at:desc&cursor=' + token, calls)).ok).toBe(true);
    expect(calls.length).toBeGreaterThan(0);
    const other: Call[] = [];
    expect((await run('limit=1&sort=deadline_at:asc&cursor=' + token, other)).status).toBe(422);
  });
});
