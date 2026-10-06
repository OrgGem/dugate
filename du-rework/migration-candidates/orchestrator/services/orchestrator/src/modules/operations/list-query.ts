/**
 * CONV-01: the `GET /api/v1/operations` query contract and keyset page.
 *
 * Moved verbatim out of server.ts — the SQL text, the positional bind order,
 * the cursor codec and the page envelope are exactly the code the route ran,
 * so wire/SQL behaviour is unchanged. server.ts re-exports the public names
 * for existing consumers.
 */
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';
import {
  LIST_CURSOR_MAX_LEN,
  OPERATIONS_LIST_LIMIT_DEFAULT,
  OPERATIONS_LIST_LIMIT_MAX,
  OPERATIONS_LIST_SORT_DEFAULT_DIRECTION,
  OPERATIONS_LIST_SORT_DEFAULT_FIELD,
  OPERATIONS_LIST_SORT_VALUES,
  OPERATIONS_STATE_FILTER_VALUES,
  OPERATIONS_STATE_FILTER_WIRE_STATES,
  formatOperationsListSort,
  isOperationsListFilterToken,
  operationsListPage,
  parseOperationsListSort,
  type OperationsListPage,
  type OperationsListQueryParam,
  type OperationsListSort,
  type OperationsListSortDirection,
  type OperationsListSortField,
  type OperationsStateFilter,
} from '@du/contracts';

/** Narrow context: this module never sees the full RouteContext. */
export interface ListQueryDbContext {
  db: Db;
}

// ---------------------------------------------------------------------------
// ADM-UX-02: GET /api/v1/operations query + cursor contract
// ---------------------------------------------------------------------------

/**
 * The operations list is an ALLOWLIST, not a free-form query: the six names
 * in `OPERATIONS_LIST_QUERY_PARAMS`, each with its own validator, every value
 * bound to a `$n` placeholder. No caller-supplied text is ever concatenated
 * into SQL — the only interpolated fragments are the predicate TEMPLATES
 * below, which contain no user data. The sort key is one of the SIX literal
 * fragments the route assembles from the validated field and direction, so
 * offering a sort adds no `ORDER BY`-injection surface either.
 *
 * Bounds, the state enum and its wire expansion all come from @du/contracts
 * (W-CONTRACT-ALIGN-1). The names below are re-exported for the existing
 * call sites and tests; they are aliases, not a second definition.
 */
export const OPERATIONS_LIST_DEFAULT_LIMIT = OPERATIONS_LIST_LIMIT_DEFAULT;
export const OPERATIONS_LIST_MAX_LIMIT = OPERATIONS_LIST_LIMIT_MAX;
/** Opaque cursors stay short enough to ride in a URL and a log line. */
export const OPERATIONS_LIST_CURSOR_MAX_LEN = LIST_CURSOR_MAX_LEN;

export type { OperationsStateFilter } from '@du/contracts';

/** The cursor's id part is compared against the `operations.id uuid` column. */
const OPERATIONS_LIST_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * UI enum → concrete wire states comes from @du/contracts
 * (`OPERATIONS_STATE_FILTER_WIRE_STATES`), the same map the admin shell reads
 * for its client-side defence-in-depth filter, so the predicate and the
 * filter can no longer accept different row sets.
 */

export interface OperationsListCursor {
  /**
   * Canonical ISO-8601 instant (`Date#toISOString` round-trip checked).
   *
   * The token slot is named for the column it was born with, and it carries
   * that column's value for every request that does not ask for a sort — which
   * is all traffic predating W-ADMUX02-SORT-ALLOWLIST-1, so old links page
   * exactly as before. Under an explicit sort it holds the BOUNDARY ROW'S
   * VALUE OF THAT SORT KEY instead (see operationsListBoundaryKey): the token
   * stays a position in the ordering the next request walks, which is what a
   * keyset cursor means. Since T140-A1 the token also NAMES that key in its
   * own ordering slot, so the field name no longer has to carry the
   * disambiguation — and renaming the slot would churn a wire token the
   * reviewer already accepted live for no behavioural gain.
   */
  createdAt: string;
  /** Lowercase uuid. */
  id: string;
  /** Walk direction; encoded in the token so one `?cursor=` serves both hops. */
  direction: OperationsListDirection;
  /**
   * The ORDERING this position belongs to, carried in the token since
   * T140-A1. A keyset boundary is only meaningful inside one order: the same
   * `(key, id)` pair sits at a different place in every sort, so replaying a
   * `created_at` cursor against `deadline_at` would page from a position the
   * deadline ordering never passes through — silently dropping or repeating
   * rows with a 200 and a plausible-looking page. The route therefore refuses
   * a cursor whose ordering is not the requested one, instead of reading the
   * wrong slice of the keyset.
   *
   * A token minted before the sort parameter existed carries no ordering and
   * decodes as the default one, which is the only order it could ever have
   * named: see decodeOperationsListCursor.
   */
  sort: OperationsListSort;
}

export interface OperationsListQuery {
  limit: number;
  cursor: OperationsListCursor | null;
  stateFilter: OperationsStateFilter;
  /** Exact tenant id, or null for "every tenant this principal may read". */
  tenantId: string | null;
  /** Case-insensitive operation-id substring, or null. */
  idContains: string | null;
  /**
   * The ORDER BY key, already resolved against the contract's allow-list. Never
   * absent: a missing `?sort=` is `created_at:desc`, the order this route had
   * before the parameter existed.
   */
  sort: OperationsListSort;
}

/**
 * Which way a keyset cursor walks the `(<sort key>, id)` sort. Carried
 * INSIDE the token (see decodeOperationsListCursor) because the route exposes
 * a single `?cursor=` parameter.
 */
export type OperationsListDirection = 'next' | 'prev';

/**
 * Opaque, URL-safe keyset cursor over `(<sort key>, id)`.
 *
 * The payload is `<canonical ISO>|<uuid>|<field>:<direction>[|p]`: a position
 * PLUS the ordering it is a position in. Both halves are needed — the same
 * `(key, id)` pair is a different page boundary in every sort, so a bare
 * position replayed under another ordering reads the wrong slice of the
 * keyset (Reviewer T140-A1). `keyValue` is therefore the boundary row's value
 * OF THE SORT KEY, not its created_at, and `sort` names which key that was.
 *
 * Built by concatenation rather than one template so the separator literals
 * stay visible next to the decoder's `split('|')`.
 */
function encodeOperationsListCursor(
  keyValue: string | Date,
  id: string,
  sort: OperationsListSort,
  direction: OperationsListDirection = 'next'
): string {
  const ts = typeof keyValue === 'string' && /\.\d{6}Z$/.test(keyValue)
    ? keyValue : new Date(keyValue).toISOString();
  const dir = direction === 'prev' ? '|p' : '';
  return Buffer.from(`${ts}|${id}|${formatOperationsListSort(sort)}${dir}`, 'utf8').toString('base64url');
}

/**
 * Strict cursor decode: base64url →
 * `<canonical ISO>|<uuid>|<field>:<direction>[|p]`.
 *
 * The third slot is the ordering the position belongs to (Reviewer T140-A1);
 * see the encoder for why a position without one cannot be trusted.
 *
 * Legacy tokens are still decoded, which is what keeps every link written
 * before the sort parameter existed working: `<ISO>|<uuid>` and `<ISO>|<uuid>
 * |p` carry no ordering slot and read as the default `created_at:desc` — the
 * only order they could ever have named, because no other order existed. That
 * is also why the walk marker is read as its own part rather than as a suffix
 * of another slot: `p` is not a legal `field:direction`, so the two shapes
 * cannot be confused.
 *
 * The millisecond portion must round-trip through `toISOString()` unchanged;
 * an exact six-digit fractional second from PostgreSQL is retained, so whatever
 * is bound to `::timestamptz` is always a real ISO instant and never a partial
 * date that Postgres would reinterpret in the server's local zone.
 *
 * The trailing `|p` marks a BACKWARD cursor. The route is one endpoint, and
 * the UI can only send `?cursor=<token>` — it has no second parameter to say
 * which way to walk — so the direction has to travel inside the token. Without
 * it a previous-page link is silently a forward page: the row above the
 * boundary is unreachable by a forward-only keyset query, so the operator
 * would get the same page again instead of the previous one.
 */
function decodeOperationsListCursor(raw: string): OperationsListCursor | null {
  if (raw.length === 0 || raw.length > OPERATIONS_LIST_CURSOR_MAX_LEN) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  const parts = text.split('|');
  if (parts.length < 2 || parts.length > 4) return null;
  const createdAt = parts[0] ?? '';
  const id = parts[1] ?? '';
  const tail = parts.slice(2);
  let direction: OperationsListDirection = 'next';
  if (tail.length > 0 && tail[tail.length - 1] === 'p') {
    direction = 'prev';
    tail.pop();
  }
  // What is left after the walk marker is the ordering slot, and there is
  // exactly one legal shape for each case: one slot names a sort, no slot is
  // a token minted before the sort parameter existed (read as the default
  // ordering, the only one it could ever have named), anything else — two
  // slots, an empty slot, an unknown `field:direction` — is not a position
  // this route produced.
  let sort: OperationsListSort;
  if (tail.length === 0) {
    sort = {
      field: OPERATIONS_LIST_SORT_DEFAULT_FIELD,
      direction: OPERATIONS_LIST_SORT_DEFAULT_DIRECTION,
    };
  } else if (tail.length === 1) {
    const bound = parseOperationsListSort(tail[0] ?? '');
    if (!bound) return null;
    sort = bound;
  } else {
    return null;
  }
  if (!OPERATIONS_LIST_UUID.test(id)) return null;
  const parsed = new Date(createdAt);
  const millisecondForm = createdAt.replace(/(\.\d{3})\d{3}Z$/, '$1Z');
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== millisecondForm) return null;
  return { createdAt, id: id.toLowerCase(), direction, sort };
}

/**
 * A read view over the query string that CANNOT address a name outside the
 * contract's allow-list: the parameter type is the contract array's element
 * type, so `read('sort')` is a compile error. This seam exists because a
 * runtime test can prove a declared parameter is honoured, but it cannot
 * cheaply prove the route reads nothing else — mutation-testing the second
 * direction showed exactly that gap (an unbound `params.get('sort')` passed
 * every conformance assertion). Making the raw URLSearchParams unavailable to
 * the parser turns "the route grew a parameter the schema does not declare"
 * from an undetected behaviour change into something that will not build.
 */
export interface AllowListedQuery {
  read(name: OperationsListQueryParam): string | null;
}

export function parseOperationsListQuery(params: URLSearchParams): OperationsListQuery {
  // The one place the raw query string is touched; everything below sees only
  // the allow-listed view, so this function cannot gain a parameter quietly.
  return parseAllowListedOperationsListQuery({ read: (name) => params.get(name) });
}

/**
 * Parse + validate the allow-listed query. Throws 422 INVALID_SCHEMA on any
 * value the contract does not define, nor a cursor that belongs to another
 * sort — an unparseable filter is reported, never silently ignored, so a
 * caller can never believe a filter applied when it did not. `limit` is the one exception: it clamps like every other
 * list route in this file.
 */
function parseAllowListedOperationsListQuery(query: AllowListedQuery): OperationsListQuery {
  const want = (name: OperationsListQueryParam): string | null => query.read(name);
  const rawLimit = want('limit');
  const parsedLimit = rawLimit === null ? NaN : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(OPERATIONS_LIST_MAX_LIMIT, Math.max(1, parsedLimit))
    : OPERATIONS_LIST_DEFAULT_LIMIT;

  const rawState = want('state');
  let stateFilter: OperationsStateFilter = 'ALL';
  if (rawState !== null && rawState.trim().length > 0) {
    const candidate = rawState.trim().toUpperCase();
    if (!(OPERATIONS_STATE_FILTER_VALUES as readonly string[]).includes(candidate)) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        `state must be one of ${OPERATIONS_STATE_FILTER_VALUES.filter((v) => v !== 'ALL').join(', ')}`
      );
    }
    stateFilter = candidate as OperationsStateFilter;
  }

  const tenantId = sanitizeOperationsListToken(want('tenant'), 'tenant');
  const idContains = sanitizeOperationsListToken(want('id'), 'id');
  const sort = parseOperationsListSortParam(want('sort'));

  const rawCursor = want('cursor');
  let cursor: OperationsListCursor | null = null;
  if (rawCursor !== null && rawCursor.length > 0) {
    const decoded = decodeOperationsListCursor(rawCursor);
    if (!decoded) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cursor is not a valid operations list cursor');
    }
    // A keyset cursor is a position IN AN ORDERING, so it only means anything
    // against the ordering it was minted for (Reviewer T140-A1): the boundary
    // row sits somewhere else in every other sort, and walking from a position
    // that ordering never passes through skips or repeats rows behind a 200
    // with a plausible-looking page. Rejected, not reinterpreted.
    //
    // Rejected rather than ignored on purpose: a caller that sends a cursor
    // with a new sort asked to continue paging, and quietly answering with
    // page 1 of the new order reads as a loop to the caller and as a normal
    // page to the operator. The error names the remedy instead.
    if (decoded.sort.field !== sort.field || decoded.sort.direction !== sort.direction) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        `cursor was issued for sort=${formatOperationsListSort(decoded.sort)} and cannot page sort=${formatOperationsListSort(sort)}; drop the cursor parameter to start this ordering at its first page`
      );
    }
    cursor = decoded;
  }

  return { limit, cursor, stateFilter, tenantId, idContains, sort };
}

/**
 * Resolve `?sort=` against the contract allow-list.
 *
 * Absent or empty is the default (created_at:desc), so every URL written before
 * this parameter existed keeps its exact behaviour. Anything else that is not
 * one of the six advertised values is a 422 — never a silent fallback to the
 * default, because an operator who asked for oldest-first and got newest-first
 * would read the list as if it were oldest-first. That is the same
 * report-don't-ignore rule the state/tenant/id filters already follow, and it
 * reuses the contract's own parser so the published schema and the route
 * cannot disagree about what a legal sort is.
 */
function parseOperationsListSortParam(raw: string | null): OperationsListSort {
  if (raw === null || raw.trim().length === 0) {
    return {
      field: OPERATIONS_LIST_SORT_DEFAULT_FIELD,
      direction: OPERATIONS_LIST_SORT_DEFAULT_DIRECTION,
    };
  }
  const parsed = parseOperationsListSort(raw);
  if (!parsed) {
    throw new HttpError(
      422,
      'INVALID_SCHEMA',
      `sort must be one of ${OPERATIONS_LIST_SORT_VALUES.join(', ')}`
    );
  }
  return parsed;
}

function sanitizeOperationsListToken(raw: string | null, name: string): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!isOperationsListFilterToken(value)) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${name} is not an accepted filter value`);
  }
  return value;
}

/** `WHERE …` for a predicate list, or '' when there is nothing to filter. */
function whereClause(clauses: readonly string[]): string {
  return clauses.length > 0 ? ` WHERE ${clauses.join(' AND ')}` : '';
}

interface OperationsListPredicates {
  clauses: string[];
  params: unknown[];
}

/**
 * Build the filter predicates. `tenantId` is the CALLER's effective scope
 * (null = cross-tenant for a platform principal) and wins over the query's
 * own `tenant`, so the credential — never a parameter — decides the fence.
 */
function buildOperationsListPredicates(
  query: OperationsListQuery,
  tenantId: string | null
): OperationsListPredicates {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (tenantId !== null) clauses.push(`tenant_id = ${bind(tenantId)}`);
  if (query.stateFilter !== 'ALL') {
    clauses.push(`state = ANY(${bind(OPERATIONS_STATE_FILTER_WIRE_STATES[query.stateFilter])}::text[])`);
  }
  if (query.idContains !== null) {
    // strpos(), not LIKE: the token's character class admits '_', which is a
    // LIKE single-character wildcard. A substring search must not acquire
    // wildcard semantics from an operator's typing.
    clauses.push(`strpos(lower(id::text), lower(${bind(query.idContains)})) > 0`);
  }
  return { clauses, params };
}

/* ------------------------------------------------------------------ */
/* ADM-UX-02 sort (W-ADMUX02-SORT-ALLOWLIST-1): the ORDER BY key        */
/* ------------------------------------------------------------------ */

/**
 * ORDER BY column per allow-listed field. A LOOKUP keyed by the already
 * validated field, so the column name in the SQL text is one of these three
 * literals and the caller's text is never SQL text — same discipline the
 * filters follow (templates interpolate, values bind).
 */
const OPERATIONS_LIST_SORT_COLUMN_SQL: Readonly<Record<OperationsListSortField, string>> = {
  created_at: 'created_at',
  updated_at: 'updated_at',
  deadline_at: 'deadline_at',
};

/**
 * The fields whose column 0001_platform_v1.sql declares NULLABLE. Their key is
 * COALESCEd over a sentinel literal before it is ordered or compared, because a
 * row-value predicate is never TRUE against NULL: without this, ORDER BY
 * deadline_at would answer page 1 correctly and then LOSE every deadline-less
 * operation from page 2 onward — silently, with a 200 and a page that looks
 * plausible. Most operations have no deadline, so that is not an edge case.
 */
const OPERATIONS_LIST_NULLABLE_SORT_FIELDS: ReadonlySet<OperationsListSortField> = new Set<
  OperationsListSortField
>(['deadline_at']);

/**
 * The sentinel a NULL key takes, chosen so the NULL block always lands at the
 * END of the ordering: the earliest representable instant when the key walks
 * down, the latest when it walks up. Both are real ISO instants that survive a
 * toISOString() round-trip, which the strict cursor decoder demands — Postgres'
 * own +/-infinity do not, and no operation of this platform can ever collide
 * with year 1 or year 9999. One map serves both halves of the contract: the
 * literal the ORDER BY embeds (bindOperationsListSortKey, which must match the
 * 0019 index expressions byte for byte) and the value a cursor carries for a
 * NULL key (operationsListBoundaryKey).
 */
const OPERATIONS_LIST_NULL_SORT_BOUND_SQL: Readonly<Record<OperationsListSortDirection, string>> = {
  desc: '0001-01-01T00:00:00.000Z',
  asc: '9999-12-31T23:59:59.999Z',
};

/** The two ORDER BY direction literals. */
const OPERATIONS_LIST_SORT_SQL_DIRECTION: Readonly<
  Record<OperationsListSortDirection, 'ASC' | 'DESC'>
> = {
  asc: 'ASC',
  desc: 'DESC',
};

/**
 * The ORDER BY key expression for a validated sort. A nullable column gets its
 * sentinel written into the SQL as a quoted `::timestamptz` literal rather than
 * bound as a `$n`, because migration 0019 indexes the expression
 * COALESCE(deadline_at, '<sentinel>'::timestamptz) and the planner matches an
 * expression index only against the same Const node: a Param bound to this very
 * instant is a different node, so the parameterised form ordered through a Sort
 * over a Seq Scan and left all four 0019 indexes as dead code (T-35, reconfirmed
 * by the W-INGEST-0019-2 review). This is not the interpolation surface caller
 * text would be — the value comes from a compile-time constant keyed by the
 * already-validated direction. The cursor predicate reuses this one string, so
 * ORDER BY and keyset boundary cannot diverge, and because no param is consumed
 * here the filter placeholders keep the positions the conformance tests pin.
 */
function bindOperationsListSortKey(sort: OperationsListSort): string {
  const column = OPERATIONS_LIST_SORT_COLUMN_SQL[sort.field];
  if (!OPERATIONS_LIST_NULLABLE_SORT_FIELDS.has(sort.field)) return column;
  const sentinel = OPERATIONS_LIST_NULL_SORT_BOUND_SQL[sort.direction];
  return `COALESCE(${column}, '${sentinel}'::timestamptz)`;
}

/**
 * The value the cursor carries for a row: its sort key, with a NULL in a
 * nullable column replaced by the SAME sentinel bindOperationsListSortKey
 * coalesces it to. The two must agree — a cursor holds a position in the
 * ordering the next request walks, and a position the SQL itself never
 * produces would page from nowhere.
 */
function operationsListBoundaryKey(
  row: Record<string, unknown>,
  sort: OperationsListSort
): string | Date {
  // pg Date truncates microseconds. SQL supplies the exact boundary separately.
  if (typeof row['__cursor_sort_key'] === 'string') return row['__cursor_sort_key'];
  const value = row[OPERATIONS_LIST_SORT_COLUMN_SQL[sort.field]];
  if (value === null || value === undefined) {
    return OPERATIONS_LIST_NULL_SORT_BOUND_SQL[sort.direction];
  }
  return value as string | Date;
}

/**
 * The keyset predicate for `cursor`, or null when there is no cursor. Returns a
 * bare predicate and NOT a joined clause on purpose: the caller folds it into
 * `whereClause` together with the filters, because that is the only place that
 * can know whether a `WHERE` keyword is still owed. Appending ` AND …` to a
 * `SELECT … FROM operations` that had no filters produced `FROM operations AND
 * (…)` — a syntax error against Postgres, invisible offline because a fake db
 * never parses SQL (see the T140-A1 receipt).
 *
 * `sortKeySql` is the expression the ORDER BY uses, so the boundary is compared
 * against the SAME expression the rows were ordered by — comparing one
 * expression while ordering by another is how a keyset page skips rows.
 */
function bindOperationsCursor(
  cursor: OperationsListCursor | null,
  params: unknown[],
  sortKeySql: string,
  descending: boolean
): string | null {
  if (!cursor) return null;
  params.push(cursor.createdAt, cursor.id);
  // Forward walks toward the tail of the chosen order: DOWN the key for a desc
  // sort, UP it for an asc one. A backward cursor takes the other side of the
  // boundary row, which is the opposite test in both directions.
  const op = descending === (cursor.direction === 'prev') ? '>' : '<';
  return `(${sortKeySql}, id) ${op} ($${params.length - 1}::timestamptz, $${params.length}::uuid)`;
}

/**
 * Keyset page over `(<sort key>, id)`, the sort key defaulting to
 * `created_at DESC`. OFFSET paging would skip or repeat
 * rows whenever a new operation is created between two page requests; the
 * cursor does not, because inserts land strictly above a forward boundary and
 * are simply outside this page's window.
 *
 * Two bounded statements per request: a `limit + 1` page probe (the extra row
 * is the only evidence of a next page) and a `count(*)` over the FILTERED
 * population. The sort never reaches the count: reordering a population does
 * not change how large it is, and `total` is advertised as its size.
 *
 * Both directions share the one `?cursor=` parameter. A forward cursor walks to
 * the far side of the boundary in the requested order; a backward cursor
 * (marked `|p`) scans the REVERSED order and the rows on the near side, so
 * LIMIT lands on the block adjacent to the boundary rather than the far end of
 * the population, and the slice is reversed to restore the requested order.
 * Both cursors of a page are therefore derived from the SAME two probe rows:
 * nextCursor from the page's last row, prevCursor from its first.
 */
export async function listOperationsPage(
  ctx: ListQueryDbContext,
  query: OperationsListQuery,
  tenantId: string | null,
  project: (row: Record<string, unknown>) => Record<string, unknown>
): Promise<Record<string, unknown>> {
  const filters = buildOperationsListPredicates(query, tenantId);
  const filtersWhere = whereClause(filters.clauses);
  const sort = query.sort;
  const descending = sort.direction === 'desc';
  const backwards = query.cursor?.direction === 'prev';

  const pageParams = [...filters.params];
  // Resolved BEFORE the predicate so both clauses name the same key expression
  // (and the same inline sentinel): ordering by one expression while comparing
  // against another is exactly how a keyset page skips rows.
  const sortKeySql = bindOperationsListSortKey(sort);
  const cursorPredicate = bindOperationsCursor(query.cursor, pageParams, sortKeySql, descending);
  // The filters and the keyset boundary are ONE where list: only here can the
  // statement tell whether the WHERE keyword is still owed. Concatenating
  // operations + filters + a predicate that opens with AND produced
  // FROM operations AND (...) — an unparseable statement — precisely when an
  // operator paged the cross-tenant admin list with no filter set, which is
  // the ordinary case of pressing Next on an unfiltered page.
  const pageWhere = whereClause(
    cursorPredicate ? [...filters.clauses, cursorPredicate] : filters.clauses
  );
  pageParams.push(query.limit + 1);
  // A backward page scans the REVERSED order so LIMIT selects the rows ADJACENT
  // to the boundary; keeping the primary order would grab the far end of the
  // population and silently skip a page. The slice is reversed afterwards, so
  // every page renders in the order the operator asked for. The id tiebreak
  // always follows the key — without it, rows sharing an instant (or sharing a
  // NULL deadline) have no defined order to page through.
  const scanDirection =
    descending !== backwards
      ? OPERATIONS_LIST_SORT_SQL_DIRECTION.desc
      : OPERATIONS_LIST_SORT_SQL_DIRECTION.asc;
  const page = await ctx.db.query(
    `SELECT *, to_char(${sortKeySql} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS __cursor_sort_key FROM operations${pageWhere} ORDER BY ${sortKeySql} ${scanDirection}, id ${scanDirection} LIMIT $${pageParams.length}`,
    pageParams
  );
  const rows = page.rows as Record<string, unknown>[];
  const hasMore = rows.length > query.limit;
  const pageRows = hasMore ? rows.slice(0, query.limit) : rows;
  if (backwards) pageRows.reverse();

  const lastRow = pageRows[pageRows.length - 1];
  const hasPageBelow = backwards ? query.cursor !== null : hasMore;
  const nextCursor =
    hasPageBelow && lastRow
      ? encodeOperationsListCursor(
          operationsListBoundaryKey(lastRow, sort),
          lastRow['id'] as string,
          sort
        )
      : null;

  // Previous page. A keyset cursor is a POSITION, not a page, so the
  // previous page cannot be fetched by looking up "the row above": it is the
  // `limit` rows strictly NEWER than this page's FIRST row, taken in ASC
  // order so LIMIT selects the block ADJACENT to the boundary (DESC here
  // would pick the newest rows above and silently skip a page). The probe row
  // is the anchor for that reverse hop, so its key is the prevCursor.
  let prevCursor: string | null = null;
  const firstRow = pageRows[0];
  // A page above exists iff a row strictly newer than this page's first row
  // exists. A forward arrival always has one (it came from there). A backward
  // arrival only has one when the ASC probe saw a `limit + 1`-th row — that
  // row is newer than everything this page returned, so it is the top of
  // another page. Without this, walking up from page 1 would render a
  // "Previous" link pointing at the page the operator is already on.
  const hasPageAbove = backwards ? hasMore : query.cursor !== null;
  if (firstRow && hasPageAbove) {
    // Marked 'prev' so the follow-up request walks back over the boundary.
    prevCursor = encodeOperationsListCursor(
      operationsListBoundaryKey(firstRow, sort),
      firstRow['id'] as string,
      sort,
      'prev'
    );
  }

  const counted = await ctx.db.query(
    `SELECT count(*)::int AS total FROM operations${filtersWhere}`,
    filters.params
  );
  const total = Number((counted.rows[0] as { total?: number | string } | undefined)?.total ?? 0);

  // Built through the contract helper, so a producer cannot drop a field from
  // the page envelope the way `pageOf` used to advertise a two-field page.
  return operationsListPage({
    items: pageRows.map((row) => project(row)),
    nextCursor,
    prevCursor,
    total,
    limit: query.limit,
  }) satisfies OperationsListPage;
}