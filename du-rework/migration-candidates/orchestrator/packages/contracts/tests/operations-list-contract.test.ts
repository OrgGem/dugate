/**
 * W-CONTRACT-ALIGN-1 (Reviewer T70-C1): the published operations-list contract
 * must describe the contract the route actually implements. The route side is
 * covered by services/orchestrator/tests/operations-list-contract-conformance
 * (which drives the real route and validates its response here); this file
 * pins the schema's own accept/reject rules so the shared definition cannot be
 * loosened from this end either.
 */
import {
  LIST_CURSOR_MAX_LEN,
  OPERATIONS_LIST_LIMIT_DEFAULT,
  OPERATIONS_LIST_LIMIT_MAX,
  OPERATIONS_LIST_QUERY_PARAMS,
  OPERATIONS_LIST_SORT_DEFAULT,
  OPERATIONS_LIST_SORT_DIRECTIONS,
  OPERATIONS_LIST_SORT_FIELDS,
  OPERATIONS_LIST_SORT_VALUES,
  OPERATIONS_STATE_FILTER_VALUES,
  OPERATIONS_STATE_FILTER_WIRE_STATES,
  OperationsListPageSchema,
  formatOperationsListSort,
  isOperationsListFilterToken,
  ListOperationsQuerySchema,
  parseOperationsListSort,
} from '../src/public-api';

describe('operations-list request contract', () => {
  it('declares the six parameters the route reads', () => {
    expect([...OPERATIONS_LIST_QUERY_PARAMS]).toEqual([
      'limit',
      'cursor',
      'state',
      'tenant',
      'id',
      'sort',
    ]);
    // The schema's key set and the route's allow-list are the same list, so
    // they cannot drift: one is derived from the other.
    expect(Object.keys(ListOperationsQuerySchema.shape).sort()).toEqual([...OPERATIONS_LIST_QUERY_PARAMS].sort());
  });

  it('accepts an empty query and applies the documented defaults', () => {
    const parsed = ListOperationsQuerySchema.parse({});
    expect(parsed.limit).toBe(OPERATIONS_LIST_LIMIT_DEFAULT);
    expect(parsed.cursor).toBeUndefined();
    expect(parsed.state).toBeUndefined();
    // The one default that is NOT "no filtering": absent sort is the order the
    // route had before the parameter existed, so every pre-existing cursor and
    // deep link keeps working unchanged.
    expect(parsed.sort).toBe(OPERATIONS_LIST_SORT_DEFAULT);
  });

  it('accepts every operator state value and rejects a machine state', () => {
    for (const value of OPERATIONS_STATE_FILTER_VALUES) {
      expect(ListOperationsQuerySchema.safeParse({ state: value }).success).toBe(true);
    }
    // The route 422s these; the schema must not imply they are legal.
    for (const machine of ['QUEUED', 'ACCEPTED', 'SUCCEEDED', 'CANCELLED', 'running']) {
      expect(ListOperationsQuerySchema.safeParse({ state: machine }).success).toBe(false);
    }
  });

  it('every non-ALL state group expands to wire states, ALL does not', () => {
    for (const value of OPERATIONS_STATE_FILTER_VALUES) {
      if (value === 'ALL') continue;
      const states = OPERATIONS_STATE_FILTER_WIRE_STATES[value as Exclude<typeof value, 'ALL'>];
      expect(states.length).toBeGreaterThan(0);
      // CANCELLED must stay out of RUNNING: it has no operator triage value.
      if (value === 'RUNNING') expect(states).not.toContain('CANCELLED');
    }
    expect(Object.keys(OPERATIONS_STATE_FILTER_WIRE_STATES)).not.toContain('ALL');
  });

  it('bounds the cursor at the shared list-cursor length', () => {
    expect(ListOperationsQuerySchema.safeParse({ cursor: 'A'.repeat(LIST_CURSOR_MAX_LEN) }).success).toBe(true);
    expect(ListOperationsQuerySchema.safeParse({ cursor: 'A'.repeat(LIST_CURSOR_MAX_LEN + 1) }).success).toBe(false);
    // The superseded schema allowed 512 characters; that bound must not return.
    expect(ListOperationsQuerySchema.safeParse({ cursor: 'A'.repeat(512) }).success).toBe(false);
  });

  it('rejects an out-of-range limit rather than silently widening', () => {
    expect(ListOperationsQuerySchema.safeParse({ limit: OPERATIONS_LIST_LIMIT_MAX }).success).toBe(true);
    expect(ListOperationsQuerySchema.safeParse({ limit: OPERATIONS_LIST_LIMIT_MAX + 1 }).success).toBe(false);
    expect(ListOperationsQuerySchema.safeParse({ limit: 0 }).success).toBe(false);
  });
});

describe('operations-list sort allow-list', () => {
  it('the field and direction arrays are the cross-product the values spell out', () => {
    // OPERATIONS_LIST_SORT_VALUES is what the route's 422 message advertises, so
    // it must be exactly every combination of the two arrays — a field added to
    // one place and not the other fails here. The order is the FIELD array's
    // order (not alphabetical) so a newly sortable column shows up as an
    // appended pair and a reordered array is a visible diff.
    expect(OPERATIONS_LIST_SORT_VALUES).toEqual([
      'created_at:asc',
      'created_at:desc',
      'updated_at:asc',
      'updated_at:desc',
      'deadline_at:asc',
      'deadline_at:desc',
    ]);
    expect(OPERATIONS_LIST_SORT_VALUES.length).toBe(
      OPERATIONS_LIST_SORT_FIELDS.length * OPERATIONS_LIST_SORT_DIRECTIONS.length
    );
  });

  it('accepts every allow-listed sort, in schema and parser alike', () => {
    for (const value of OPERATIONS_LIST_SORT_VALUES) {
      expect(ListOperationsQuerySchema.safeParse({ sort: value }).success).toBe(true);
      const parsed = parseOperationsListSort(value);
      expect(parsed).not.toBeNull();
      expect(formatOperationsListSort(parsed!)).toBe(value);
    }
  });

  it('rejects a sort outside the allow-list rather than falling back to the default', () => {
    const rejected = [
      // Unknown column, including one that exists on the table but is not
      // offered: sorting by it would be a sort the contract never advertised.
      'state:desc',
      'id:desc',
      'tenant_id:asc',
      'correlation_id:desc',
      // Unknown or malformed direction.
      'created_at:sideways',
      'created_at:',
      'created',
      ':desc',
      ':',
      '',
      // Extra colons must fail rather than be truncated into something legal.
      'created_at:desc:asc',
      'a:b:created_at:desc',
      // ORDER BY injection shapes: none of these reach SQL text as a name, and
      // none of them parse.
      'created_at DESC, id DESC',
      "created_at);DROP TABLE operations;--:desc",
      'created_at:desc;DROP',
      '(created_at):desc',
      // A real sort with junk around it is still rejected on the parenthesised
      // form; trim-tolerance is only for surrounding whitespace.
      'created_at:desc)',
      // Over-long is not a sort token at all.
      `${'created_at'.repeat(20)}:desc`,
    ];
    for (const value of rejected) {
      expect(ListOperationsQuerySchema.safeParse({ sort: value }).success).toBe(false);
      expect(parseOperationsListSort(value)).toBeNull();
    }
  });

  it('normalises case and padding to the canonical lowercase form', () => {
    // The operator-facing tolerance the state parameter already has, so an
    // address-bar typo is not a 422; the emitted form stays canonical.
    expect(parseOperationsListSort('  Created_At:DESC  ')).toEqual({
      field: 'created_at',
      direction: 'desc',
    });
    expect(formatOperationsListSort(parseOperationsListSort('DEADLINE_AT:ASC')!)).toBe(
      'deadline_at:asc'
    );
  });

  it('sort is a separate parameter from the filters: combining them is legal', () => {
    const parsed = ListOperationsQuerySchema.parse({
      state: 'RUNNING',
      tenant: 'tenant-a',
      id: 'op_4',
      sort: 'updated_at:asc',
    });
    expect(parsed.sort).toBe('updated_at:asc');
    expect(parsed.state).toBe('RUNNING');
    expect(parsed.tenant).toBe('tenant-a');
    expect(parsed.id).toBe('op_4');
  });
});

describe('operations-list filter token rule', () => {
  it('accepts operator-usable ids and tenant references', () => {
    for (const ok of ['tenant-a', 'a1', 'op_4', 'a.b:c-d', '00000000-0000-4000-8000-000000000000']) {
      expect(isOperationsListFilterToken(ok)).toBe(true);
    }
  });

  it('rejects injection-shaped, over-long and credential-shaped values', () => {
    const bad = [
      "x' OR 1=1--",
      'a;b',
      'a b',
      '../../etc/passwd',
      '<script>',
      'x'.repeat(65),
      'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead',
      '00000000001111112222223333334444', 
    ];
    for (const value of bad) expect(isOperationsListFilterToken(value)).toBe(false);
  });
});

describe('operations-list page envelope', () => {
  const page = () => ({
    items: [{ id: 'x' }],
    nextCursor: null,
    prevCursor: null,
    total: 0,
    limit: OPERATIONS_LIST_LIMIT_DEFAULT,
  });

  it('requires all five fields', () => {
    expect(OperationsListPageSchema.safeParse(page()).success).toBe(true);
    for (const key of Object.keys(page())) {
      const partial = { ...page() };
      delete (partial as Record<string, unknown>)[key];
      expect(OperationsListPageSchema.safeParse(partial).success).toBe(false);
    }
    // The pre-ADM-UX-02 two-field page is the shape this replaces.
    expect(OperationsListPageSchema.safeParse({ items: [], nextCursor: null }).success).toBe(false);
  });

  it('total is a population count and cannot be a row echo of the wrong type', () => {
    expect(OperationsListPageSchema.safeParse({ ...page(), total: 1240 }).success).toBe(true);
    expect(OperationsListPageSchema.safeParse({ ...page(), total: -1 }).success).toBe(false);
    expect(OperationsListPageSchema.safeParse({ ...page(), total: '2' }).success).toBe(false);
  });

  it('rejects unknown fields, so a producer cannot add one silently', () => {
    expect(OperationsListPageSchema.safeParse({ ...page(), rows: [] }).success).toBe(false);
  });
});
