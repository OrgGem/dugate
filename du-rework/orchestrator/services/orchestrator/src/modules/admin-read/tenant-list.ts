/**
 * Admin tenant roster — parse, name-ordered keyset page and scope for
 * GET /api/v1/admin/tenants.
 *
 * The page keeps the discipline of the shared admin lists (bound parameters
 * only, an opaque bounded cursor, `limit + 1` as the only evidence of a further
 * page, a count over the SCOPED population) but not their executor, because
 * this roster is ordered by `(lower(name), id)`: the shared
 * sortableAdminKeysetPage orders by a timestamp column and its cursor codec
 * encodes a micros instant, neither of which can express a name boundary.
 *
 * The scope predicate is SQL, not a JavaScript filter, so a tenant operator's
 * foreign rows never leave the database — the same rule the api-key list
 * follows.
 */
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';
import {
  ADMIN_LIST_LIMIT_DEFAULT,
  ADMIN_LIST_LIMIT_MAX,
  LIST_CURSOR_MAX_LEN,
  TENANT_LIST_QUERY_PARAMS,
  type TenantListQueryParam,
} from '@du/contracts';
import { UUID_PARAM_PATTERN, type AdminPageResult } from './keyset';

export interface TenantDbRow extends Record<string, unknown> {
  id: string;
  name: string;
  state: string;
}

export interface TenantListCursor {
  id: string;
  direction: 'next' | 'prev';
}

export interface TenantListQuery {
  limit: number;
  cursor: TenantListCursor | null;
}

/**
 * Opaque token: base64url(`<uuid>`), plus a trailing `|p` for a BACKWARD hop
 * (one `?cursor=` parameter serves both directions, as on every other admin
 * list). Only the boundary ID travels — the page resolves that tenant's name in
 * SQL, so a long tenant name can never overflow the opaque-token length bound
 * the way an embedded name would.
 */
export function encodeTenantListCursor(id: string, direction: 'next' | 'prev'): string {
  return Buffer.from(direction === 'prev' ? `${id}|p` : id, 'utf8').toString('base64url');
}

/** Strict decode; null for anything this format does not define. */
export function decodeTenantListCursor(
  raw: string,
  maxLen = LIST_CURSOR_MAX_LEN,
): TenantListCursor | null {
  if (raw.length === 0 || raw.length > maxLen || !/^[A-Za-z0-9_-]+$/.test(raw)) return null;
  const text = Buffer.from(raw, 'base64url').toString('utf8');
  // Canonical round-trip: a non-canonical base64url spelling must not decode.
  if (Buffer.from(text, 'utf8').toString('base64url') !== raw) return null;
  let id = text;
  let direction: 'next' | 'prev' = 'next';
  if (id.endsWith('|p')) {
    direction = 'prev';
    id = id.slice(0, -2);
  }
  if (!UUID_PARAM_PATTERN.test(id)) return null;
  return { id: id.toLowerCase(), direction };
}

/**
 * Allow-list parser for GET /api/v1/admin/tenants, same discipline as the audit
 * list: the parameter NAMES come from the contract array, an unrecognised
 * parameter is ignored, `limit` clamps and a malformed cursor is a 422 rather
 * than a silently restarted list.
 */
export function parseTenantListQuery(params: URLSearchParams): TenantListQuery {
  const read = (name: TenantListQueryParam): string | null =>
    (TENANT_LIST_QUERY_PARAMS as readonly string[]).includes(name) ? params.get(name) : null;

  const rawLimit = read('limit');
  const parsedLimit = rawLimit === null ? NaN : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(ADMIN_LIST_LIMIT_MAX, Math.max(1, parsedLimit))
    : ADMIN_LIST_LIMIT_DEFAULT;

  const cursorRaw = read('cursor');
  let cursor: TenantListCursor | null = null;
  if (cursorRaw !== null && cursorRaw.length > 0) {
    cursor = decodeTenantListCursor(cursorRaw, LIST_CURSOR_MAX_LEN);
    if (!cursor) {
      throw new HttpError(422, 'INVALID_SCHEMA', 'cursor is not a valid tenant-list cursor');
    }
  }
  return { limit, cursor };
}

/**
 * Name-ordered keyset page over `tenants`. A NULL scope lists the whole
 * roster (platform); a tenant id narrows it to that one row (tenant operator).
 *
 * The boundary is a row-value comparison on `(lower(name), id)` whose name half
 * is a scalar subquery on the boundary tenant rather than a transported value.
 * The subquery carries the same scope predicate as the page, so a cursor replayed
 * under a different tenant scope resolves to NULL instead of probing that
 * tenant's ordering. Forward hops walk ASC; a backward probe walks DESC and
 * reverses the window back into display order — the same rule the shared
 * sortable executor follows for its timestamp boundary.
 */
export async function listTenantPage(
  db: Db,
  scope: string | null,
  query: TenantListQuery,
): Promise<AdminPageResult<TenantDbRow>> {
  const clauses: string[] = [];
  const params: unknown[] = [];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  const scopeBind = scope === null ? null : bind(scope);
  if (scopeBind !== null) clauses.push(`id = ${scopeBind}`);

  const backwards = query.cursor?.direction === 'prev';
  const scanOrder = backwards ? 'DESC' : 'ASC';
  const boundaryOp = backwards ? '<' : '>';
  let cursorClause = '';
  if (query.cursor) {
    const cursorId = bind(query.cursor.id);
    const boundaryScope = scopeBind === null ? '' : ` AND id = ${scopeBind}`;
    cursorClause = `${clauses.length ? ' AND' : ' WHERE'} (lower(name), id) ${boundaryOp} ((SELECT lower(name) FROM tenants WHERE id = ${cursorId}${boundaryScope}), ${cursorId}::uuid)`;
  }
  const limitBind = bind(query.limit + 1);
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  const page = await db.query<TenantDbRow>(
    `SELECT id, name, state FROM tenants${where}${cursorClause} ORDER BY lower(name) ${scanOrder}, id ${scanOrder} LIMIT ${limitBind}`,
    params,
  );
  const rawRows = page.rows as unknown as TenantDbRow[];
  const hasMore = rawRows.length > query.limit;
  const window = hasMore ? rawRows.slice(0, query.limit) : rawRows;
  const pageRows = backwards ? window.slice().reverse() : window;
  const first = pageRows[0];
  const last = pageRows[pageRows.length - 1];
  // Same cursor-existence rule as the shared executor: a forward arrival has a
  // page above it, a backward arrival only when the reversed probe saw a
  // further row — otherwise page 1 advertises a Previous link to itself.
  const nextExists = backwards ? query.cursor !== null : hasMore;
  const prevExists = backwards ? hasMore : query.cursor !== null;
  const nextCursor = nextExists && last ? encodeTenantListCursor(last.id, 'next') : null;
  const prevCursor = prevExists && first ? encodeTenantListCursor(first.id, 'prev') : null;

  const counted = await db.query<{ total: number | string }>(
    `SELECT count(*)::int AS total FROM tenants${where}`,
    scope === null ? [] : [scope],
  );
  return {
    rows: pageRows,
    nextCursor,
    prevCursor,
    total: Number(counted.rows[0]?.total ?? 0),
  };
}

/** The wire item: exactly { id, name, state } — nothing else is projected. */
export function toTenantWire(row: TenantDbRow): { id: string; name: string; state: string } {
  return { id: row.id, name: row.name, state: row.state };
}
