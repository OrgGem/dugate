/**
 * CONV-01: api-key list query parsing, keyset page and the wire envelope.
 *
 * Moved verbatim out of server.ts; the raw key is never projected — only the
 * stored prefix.
 */
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';
import {
  ADMIN_LIST_LIMIT_DEFAULT,
  API_KEY_LIST_QUERY_PARAMS,
  API_KEY_STATUS_VALUES,
  listPage,
  type AdminResourceListSort,
  type AdminResourceListSortCursor,
  type ApiKeyListQueryParam,
} from '@du/contracts';
import type { AdminPrincipal } from '../admin-actions/rbac';
import {
  dateToIso,
  parseAdminResourceListQuery,
  sanitizeAdminListToken,
  sortableAdminKeysetPage,
  UUID_PARAM_PATTERN,
  type AdminPageResult,
} from './keyset';

/** Narrow context: this module only reads keys/grants through ctx.db. */
export interface ApiKeyReadDbContext {
  db: Db;
}

export interface ApiKeyDbRow extends Record<string, unknown> {
  id: string;
  tenant_id: string;
  prefix: string;
  status: string;
  created_at: Date;
  updated_at: Date;
}

export interface ApiKeyListQuery {
  limit: number;
  cursor: AdminResourceListSortCursor | null;
  tenantId: string | null;
  status: string | null;
  prefix: string | null;
  sort: AdminResourceListSort;
}

export function parseApiKeyListQuery(params: URLSearchParams): ApiKeyListQuery {
  const read = (name: ApiKeyListQueryParam): string | null => params.get(name);
  const page = parseAdminResourceListQuery(params, API_KEY_LIST_QUERY_PARAMS);

  const tenantRaw = read('tenantId');
  const tenantId = tenantRaw === null || tenantRaw.trim().length === 0 ? null : tenantRaw.trim();
  if (tenantId !== null && !UUID_PARAM_PATTERN.test(tenantId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must be a uuid');
  }

  const statusRaw = read('status');
  let status: string | null = null;
  if (statusRaw !== null && statusRaw.trim().length > 0) {
    const candidate = statusRaw.trim().toUpperCase();
    if (!(API_KEY_STATUS_VALUES as readonly string[]).includes(candidate)) {
      throw new HttpError(
        422,
        'INVALID_SCHEMA',
        `status must be one of ${API_KEY_STATUS_VALUES.join(', ')}`
      );
    }
    status = candidate;
  }

  // `prefix` is the display prefix that is already shown on screen, never the
  // secret; the raw key is only ever hashed at rest (api_keys.hash).
  const prefix = sanitizeAdminListToken(read('prefix'), 'prefix');

  return { ...page, tenantId, status, prefix };
}

/**
 * Keyset page over api_keys, mirroring the operations list: DESC for a
 * forward cursor, ASC-then-reverse for a backward one, `limit + 1` as the
 * only evidence of a further page, and a count over the FILTERED population.
 * The tenant predicate is SQL, not a JavaScript filter, so rows outside the
 * caller's scope never leave the database.
 */
export async function listApiKeyPage(
  db: Db,
  tenantId: string,
  query: ApiKeyListQuery
): Promise<AdminPageResult<ApiKeyDbRow>> {
  if (query.cursor && !UUID_PARAM_PATTERN.test(query.cursor.id)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'cursor id is not valid for API-key pagination');
  }
  const clauses: string[] = ['tenant_id = $1'];
  const params: unknown[] = [tenantId];
  const bind = (value: unknown): string => {
    params.push(value);
    return `$${params.length}`;
  };
  if (query.status !== null) clauses.push(`status = ${bind(query.status)}`);
  if (query.prefix !== null) {
    clauses.push(`strpos(lower(prefix), lower(${bind(query.prefix)})) > 0`);
  }
  return sortableAdminKeysetPage<ApiKeyDbRow>({
    db,
    fromSql: 'api_keys',
    columns: `id, tenant_id, prefix, status, created_at, updated_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor`,
    clauses,
    params,
    cursor: query.cursor,
    limit: query.limit,
    sort: query.sort,
    sortColumns: { createdAt: 'created_at', updatedAt: 'updated_at' },
    timestampRowKey: query.sort.startsWith('createdAt:') ? 'created_at_cursor' : 'updated_at_cursor',
    timestampFallbackRowKey: query.sort.startsWith('createdAt:') ? 'created_at' : 'updated_at',
    tieColumn: 'id',
    tieType: 'uuid',
    countSql: `SELECT count(*)::int AS total FROM api_keys WHERE ${clauses.join(' AND ')}`,
  });
}

/**
 * Assembles the api-keys answer: the shared five page fields plus the grants
 * and copy-once payload the key pane needs. The raw key is never projected —
 * only the stored prefix, which is display-safe and is why `prefix` is a legal
 * search term while a secret never is.
 */
export async function buildApiKeyPage(
  ctx: ApiKeyReadDbContext,
  principal: AdminPrincipal,
  rows: ApiKeyDbRow[],
  query: ApiKeyListQuery | null,
  page?: AdminPageResult<ApiKeyDbRow>
): Promise<Record<string, unknown>> {
  const ids = rows.map((r) => r.id);
  const grantRows = ids.length
    ? await ctx.db.query(
        `SELECT api_key_id, business_id, business_version, action, created_at
         FROM profile_bindings WHERE api_key_id = ANY($1) ORDER BY created_at DESC`,
        [ids]
      )
    : { rows: [] as unknown[] };
  const grantsByKey = new Map<string, unknown[]>();
  for (const g of grantRows.rows as {
    api_key_id: string; business_id: string; business_version: string;
    action: string; created_at: Date;
  }[]) {
    const list = grantsByKey.get(g.api_key_id) ?? [];
    list.push({
      businessId: g.business_id,
      businessVersion: g.business_version,
      action: g.action,
      grantedAt: (g.created_at as Date).toISOString(),
    });
    grantsByKey.set(g.api_key_id, list);
  }
  const items = rows.map((r) => ({
    id: r.id,
    tenantId: r.tenant_id,
    prefix: r.prefix,
    maskedHint: r.prefix,
    status: r.status,
    createdAt: dateToIso(r.created_at),
    updatedAt: dateToIso(r.updated_at ?? r.created_at),
  }));
  const base = listPage({
    items,
    nextCursor: page?.nextCursor ?? null,
    prevCursor: page?.prevCursor ?? null,
    total: page?.total ?? items.length,
    limit: query?.limit ?? ADMIN_LIST_LIMIT_DEFAULT,
  });
  return {
    ...base,
    grants: rows.flatMap((r) => grantsByKey.get(r.id) ?? []),
    createCopyOnce: null,
  };
}