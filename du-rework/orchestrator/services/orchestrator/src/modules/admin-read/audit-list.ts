/**
 * CONV-01: the audit list query parser + paged ledger read.
 *
 * Moved verbatim out of server.ts; rows are projected with the audit module's
 * own `toAuditWire` (CONV-13) so the service list and this page cannot drift.
 */
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';
import {
  ADMIN_AUDIT_LIST_SORT_DEFAULT,
  ADMIN_AUDIT_LIST_SORT_VALUES,
  ADMIN_LIST_LIMIT_DEFAULT,
  ADMIN_LIST_LIMIT_MAX,
  AUDIT_SEVERITY_VALUES,
  LIST_CURSOR_MAX_LEN,
  decodeAdminResourceListSortCursor,
  listPage,
  type AdminAuditListQueryParam,
  type AdminAuditListSort,
  type AdminResourceListSortCursor,
} from '@du/contracts';
import { toAuditWire, type AuditRow } from '../audit/audit';
import {
  parseAdminListTimeBound,
  sanitizeAdminListToken,
  sortableAdminKeysetPage,
  UUID_PARAM_PATTERN,
} from './keyset';

/** Narrow context: this module only reads the ledger through ctx.db. */
export interface AuditReadDbContext {
  db: Db;
}

export interface AdminAuditListQuery {
  limit: number;
  cursor: AdminResourceListSortCursor | null;
  tenantId: string | null;
  severity: string | null;
  action: string | null;
  actor: string | null;
  resource: string | null;
  from: string | null;
  to: string | null;
  sort: AdminAuditListSort;
}

/**
 * Allow-list parser for GET /api/v1/admin/audit. Same discipline as the
 * operations list: the parameter NAMES come from the contract array, an
 * unrecognised value is a 422 rather than a silently dropped filter, and a
 * tenant id must be a uuid so it can never be a raw credential or a path.
 */
export function parseAdminAuditListQuery(params: URLSearchParams): AdminAuditListQuery {
  const read = (name: AdminAuditListQueryParam): string | null => params.get(name);

  const rawLimit = read('limit');
  const parsedLimit = rawLimit === null ? NaN : Number.parseInt(rawLimit, 10);
  const limit = Number.isFinite(parsedLimit)
    ? Math.min(ADMIN_LIST_LIMIT_MAX, Math.max(1, parsedLimit))
    : ADMIN_LIST_LIMIT_DEFAULT;

  const tenantRaw = read('tenantId');
  const tenantId = tenantRaw === null || tenantRaw.trim().length === 0 ? null : tenantRaw.trim();
  if (tenantId !== null && !UUID_PARAM_PATTERN.test(tenantId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must be a uuid');
  }

  const severityRaw = read('severity');
  let severity: string | null = null;
  if (severityRaw !== null && severityRaw.trim().length > 0) {
    const candidate = severityRaw.trim().toLowerCase();
    if (!(AUDIT_SEVERITY_VALUES as readonly string[]).includes(candidate)) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        `severity must be one of ${AUDIT_SEVERITY_VALUES.join(', ')}`
      );
    }
    severity = candidate;
  }

  const action = sanitizeAdminListToken(read('action'), 'action');
  const actor = sanitizeAdminListToken(read('actor'), 'actor');
  const resource = sanitizeAdminListToken(read('resource'), 'resource');

  const from = parseAdminListTimeBound(read('from'), 'from');
  const to = parseAdminListTimeBound(read('to'), 'to');
  // An inverted window is a client mistake, not an empty ledger: silently
  // answering a zero-page would read as "nothing happened in that range".
  if (from !== null && to !== null && from > to) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'from must not be after to');
  }

  const rawSort = read('sort');
  const sortValue = rawSort === null || rawSort.trim() === ''
    ? ADMIN_AUDIT_LIST_SORT_DEFAULT
    : rawSort.trim();
  if (!(ADMIN_AUDIT_LIST_SORT_VALUES as readonly string[]).includes(sortValue)) {
    throw new HttpError(
      422,
      'INVALID_SCHEMA',
      `sort must be one of ${ADMIN_AUDIT_LIST_SORT_VALUES.join(', ')}`
    );
  }
  const sort = sortValue as AdminAuditListSort;

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

  return { limit, cursor, tenantId, severity, action, actor, resource, from, to, sort };
}

/**
 * Paged, tenant-scoped ledger read. Same sort-bound keyset executor as the
 * business, version and api-key pages, so all four surfaces inherit one
 * cursor dialect and one count rule. CONV-13: rows are projected with the
 * audit module's own `toAuditWire` — the previous local mirror is gone, so
 * the service list and this page can never disagree about the wire shape.
 */
export async function listAuditEventPage(
  ctx: AuditReadDbContext,
  tenantId: string,
  query: AdminAuditListQuery
): Promise<Record<string, unknown>> {
  const clauses: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (query.severity !== null) clauses.push(`severity = ${bind(query.severity)}`);
  if (query.action !== null) {
    clauses.push(`strpos(lower(action), lower(${bind(query.action)})) > 0`);
  }
  if (query.actor !== null) {
    clauses.push(`strpos(lower(actor), lower(${bind(query.actor)})) > 0`);
  }
  if (query.resource !== null) {
    clauses.push(`strpos(lower(resource), lower(${bind(query.resource)})) > 0`);
  }
  if (query.from !== null) clauses.push(`created_at >= ${bind(query.from)}::timestamptz`);
  if (query.to !== null) clauses.push(`created_at <= ${bind(query.to)}::timestamptz`);
  const page = await sortableAdminKeysetPage<AuditRow>({
    db: ctx.db,
    fromSql: 'admin_audit_events',
    columns: `id, tenant_id, actor, action, resource, severity, correlation_id, created_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor`,
    clauses,
    params,
    cursor: query.cursor,
    limit: query.limit,
    sort: query.sort,
    sortColumns: { createdAt: 'created_at' },
    timestampRowKey: 'created_at_cursor',
    timestampFallbackRowKey: 'created_at',
    tieColumn: 'id',
    tieType: 'uuid',
    countSql: `SELECT count(*)::int AS total FROM admin_audit_events WHERE ${clauses.join(' AND ')}`,
  });
  return listPage({
    items: page.rows.map(toAuditWire),
    nextCursor: page.nextCursor,
    prevCursor: page.prevCursor,
    total: page.total,
    limit: query.limit,
  });
}