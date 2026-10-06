/**
 * CONV-01: shared admin keyset pagination + resource-list query parsing.
 *
 * Moved verbatim out of server.ts. The two executors keep their distinct bind
 * shapes (sortableAdminKeysetPage: filters -> cursor -> limit; keysetPage:
 * created_at/id cursor) so audit, api-key, business and version pages stay
 * byte-compatible.
 */
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';
import {
  ADMIN_LIST_LIMIT_DEFAULT,
  ADMIN_LIST_LIMIT_MAX,
  ADMIN_RESOURCE_LIST_SORT_DEFAULT,
  ADMIN_RESOURCE_LIST_SORT_VALUES,
  LIST_CURSOR_MAX_LEN,
  decodeAdminResourceListSortCursor,
  encodeAdminResourceListSortCursor,
  encodeListCursor,
  isAdminListTimeBound,
  isOperationsListFilterToken,
  type AdminResourceListSort,
  type AdminResourceListSortCursor,
  type ListCursor,
} from '@du/contracts';

/**
 * A time bound is a UTC instant or it is a 422. `isAdminListTimeBound` also
 * rejects a well-shaped but non-existent date, which the pattern alone lets
 * through because Date.parse rolls 2026-02-30 over into March.
 */
export function parseAdminListTimeBound(raw: string | null, name: string): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  if (!isAdminListTimeBound(value)) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${name} must be a UTC instant such as 2026-09-28T00:00:00Z`);
  }
  return value;
}

export function sanitizeAdminListToken(raw: string | null, name: string): string | null {
  if (raw === null) return null;
  const value = raw.trim();
  if (value.length === 0) return null;
  // The shared token class already refuses solid 32+ hex, so a pasted API
  // secret cannot become a search term on any admin list.
  if (!isOperationsListFilterToken(value)) {
    throw new HttpError(422, 'INVALID_SCHEMA', `${name} is not an accepted filter value`);
  }
  return value;
}

export const UUID_PARAM_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface AdminResourceListQuery {
  limit: number;
  cursor: AdminResourceListSortCursor | null;
  sort: AdminResourceListSort;
}

/**
 * Parse the shared page parameters for businesses, versions, and API keys.
 * Sort is closed over contract literals, and its cursor carries the same sort
 * so changing order requires starting from the first page.
 */
export function parseAdminResourceListQuery(
  params: URLSearchParams,
  allowedParams: readonly string[],
): AdminResourceListQuery {
  const read = (name: 'limit' | 'cursor' | 'sort'): string | null =>
    allowedParams.includes(name) ? params.get(name) : null;
  const rawLimit = read('limit');
  const parsedLimit = rawLimit === null ? NaN : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(ADMIN_LIST_LIMIT_MAX, Math.max(1, parsedLimit))
    : ADMIN_LIST_LIMIT_DEFAULT;

  const rawSort = read('sort');
  const sortValue = rawSort === null || rawSort.trim() === ''
    ? ADMIN_RESOURCE_LIST_SORT_DEFAULT
    : rawSort.trim();
  if (!(ADMIN_RESOURCE_LIST_SORT_VALUES as readonly string[]).includes(sortValue)) {
    throw new HttpError(
      422,
      'INVALID_SCHEMA',
      `sort must be one of ${ADMIN_RESOURCE_LIST_SORT_VALUES.join(', ')}`
    );
  }
  const sort = sortValue as AdminResourceListSort;

  const cursorRaw = read('cursor');
  let cursor: AdminResourceListSortCursor | null = null;
  if (cursorRaw !== null && cursorRaw.length > 0) {
    cursor = decodeAdminResourceListSortCursor(cursorRaw, LIST_CURSOR_MAX_LEN);
    if (!cursor) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cursor is not a valid sortable list cursor');
    }
    if (cursor.sort !== sort) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cursor was issued for a different sort; drop cursor to restart the list');
    }
  }
  return { limit, cursor, sort };
}

export interface AdminPageResult<T> {
  rows: T[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  activeVersion?: string | null;
}

export interface AdminSortablePageInput<T> {
  db: Db;
  fromSql: string;
  columns: string;
  clauses: string[];
  params: unknown[];
  cursor: AdminResourceListSortCursor | null;
  limit: number;
  sort: AdminResourceListSort;
  sortColumns: Partial<Record<'createdAt' | 'updatedAt', string>>;
  timestampRowKey: 'created_at_cursor' | 'updated_at_cursor';
  timestampFallbackRowKey: 'created_at' | 'updated_at';
  tieColumn: string;
  tieType: 'text' | 'uuid';
  countSql: string;
}

/**
 * Shared sort-bound keyset executor for business, version, and API-key pages.
 * SQL identifiers are supplied only by the closed route-side maps above; all
 * cursor/filter values remain bound parameters. Backward probes reverse both
 * ordering keys and then reverse the result window back into display order.
 */
export async function sortableAdminKeysetPage<T extends Record<string, unknown>>(
  input: AdminSortablePageInput<T>,
): Promise<AdminPageResult<T>> {
  const [sortField, sortDirection] = input.sort.split(':') as ['createdAt' | 'updatedAt', 'asc' | 'desc'];
/**
 * Only the sort field the caller actually mapped may be requested. The audit
 * ledger has no updated_at, so a table that maps created_at alone turns any
 * other field into a 422 rather than an ORDER BY over a missing column.
 */
  const sortKey = input.sortColumns[sortField];
  if (!sortKey) {
    throw new HttpError(422, 'INVALID_SCHEMA', `sort is not available on this list: ${sortField}`);
  }
  const descending = sortDirection === 'desc';
  const backwards = input.cursor?.direction === 'prev';
  const scanDescending = backwards ? !descending : descending;
  const scanOrder = scanDescending ? 'DESC' : 'ASC';
  const forwardOp = descending ? '<' : '>';
  const boundaryOp = backwards ? (forwardOp === '<' ? '>' : '<') : forwardOp;
  const where = input.clauses.length ? ` WHERE ${input.clauses.join(' AND ')}` : '';
  const pageParams = [...input.params];
  let cursorClause = '';
  if (input.cursor) {
    pageParams.push(input.cursor.timestamp, input.cursor.id);
    cursorClause = `${where ? ' AND' : ' WHERE'} (${sortKey}, ${input.tieColumn}) ${boundaryOp} ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::${input.tieType})`;
  }
  pageParams.push(input.limit + 1);
  const page = await input.db.query<T & Record<string, unknown>>(
    `SELECT ${input.columns} FROM ${input.fromSql}${where}${cursorClause} ORDER BY ${sortKey} ${scanOrder}, ${input.tieColumn} ${scanOrder} LIMIT $${pageParams.length}`,
    pageParams,
  );
  const rawRows = page.rows as unknown as T[];
  const hasMore = rawRows.length > input.limit;
  const window = hasMore ? rawRows.slice(0, input.limit) : rawRows;
  const pageRows = (backwards ? window.slice().reverse() : window) as T[];
  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];
  const cursorFor = (row: T, direction: 'next' | 'prev'): string =>
    encodeAdminResourceListSortCursor({
      timestamp: typeof row[input.timestampRowKey] === 'string'
        ? String(row[input.timestampRowKey])
        : dateToIso(row[input.timestampFallbackRowKey]),
      id: String(row[input.tieColumn.split('.').pop()!] ?? ''),
      direction,
      sort: input.sort,
    });
  const nextExists = backwards ? input.cursor !== null : hasMore;
  const prevExists = backwards ? hasMore : input.cursor !== null;
  const nextCursor = nextExists && last ? cursorFor(last, 'next') : null;
  const prevCursor = prevExists && first ? cursorFor(first, 'prev') : null;

  const counted = await input.db.query<{ total: number | string; active_version?: string | null }>(
    input.countSql,
    input.params,
  );
  return {
    rows: pageRows,
    nextCursor,
    prevCursor,
    total: Number(counted.rows[0]?.total ?? 0),
    activeVersion: counted.rows[0]?.active_version ?? null,
  };
}

export function dateToIso(value: unknown): string {
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) throw new Error('admin list row contains an invalid timestamp');
  return date.toISOString();
}

/**
 * The one keyset-page executor shared by the audit and api-key lists (the
 * operations list keeps its own, older routine for now — see the receipt's
 * delta note). Every value is bound; only predicate TEMPLATES and a direction
 * chosen from two literals reach the SQL text.
 */
export async function keysetPage<T>(input: {
  db: Db;
  table: string;
  columns: string;
  clauses: string[];
  params: unknown[];
  cursor: ListCursor | null;
  limit: number;
  countLabel: string;
}): Promise<AdminPageResult<T>> {
  const where = input.clauses.length ? ` WHERE ${input.clauses.join(' AND ')}` : '';
  const backwards = input.cursor?.direction === 'prev';

  const pageParams = [...input.params];
  let cursorClause = '';
  if (input.cursor) {
    pageParams.push(input.cursor.createdAt, input.cursor.id);
    const op = backwards ? '>' : '<';
    cursorClause = ` AND (created_at, id) ${op} ($${pageParams.length - 1}::timestamptz, $${pageParams.length}::uuid)`;
  }
  pageParams.push(input.limit + 1);
  const order = backwards ? 'created_at ASC, id ASC' : 'created_at DESC, id DESC';
  const page = await input.db.query<T & Record<string, unknown>>(
    `SELECT ${input.columns} FROM ${input.table}${where}${cursorClause} ORDER BY ${order} LIMIT $${pageParams.length}`,
    pageParams
  );
  const rows = page.rows as unknown as Record<string, unknown>[];
  const hasMore = rows.length > input.limit;
  const window = hasMore ? rows.slice(0, input.limit) : rows;
  const pageRows = (backwards ? window.slice().reverse() : window) as unknown as T[];

  const first = pageRows[0] as Record<string, unknown> | undefined;
  const last = pageRows[pageRows.length - 1] as Record<string, unknown> | undefined;
  const nextCursor =
    hasMore && last
      ? encodeListCursor(last['created_at'] as string, last['id'] as string, 'next')
      : null;
  // Same rule as the operations list above: a forward arrival always has a page
  // above it, a backward arrival only when the ASC probe saw a further row.
  // Without the cursor check, page 1 advertises a Previous link to itself.
  const hasPageAbove = backwards ? hasMore : input.cursor !== null;
  const prevCursor =
    first && hasPageAbove
      ? encodeListCursor(first['created_at'] as string, first['id'] as string, 'prev')
      : null;

  const counted = await input.db.query<{ total: number | string }>(
    `SELECT count(*)::int AS total FROM ${input.table}${where}`,
    input.params
  );
  const total = Number(counted.rows[0]?.total ?? 0);
  return { rows: pageRows, nextCursor, prevCursor, total };
}