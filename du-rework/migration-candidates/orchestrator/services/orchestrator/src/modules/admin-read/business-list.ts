/**
 * CONV-01: admin business + version keyset pages (moved verbatim from server.ts).
 */
import type { Db } from '../../db/db';
import {
  sortableAdminKeysetPage,
  type AdminPageResult,
  type AdminResourceListQuery,
} from './keyset';

export interface BusinessListDbRow extends Record<string, unknown> {
  business_id: string;
  version: string;
  status: string;
  is_active: boolean;
  digest: string;
  queue: string;
  created_at: Date;
  updated_at: Date;
  active_version: string | null;
}

export async function listAdminBusinessesPage(
  db: Db,
  query: AdminResourceListQuery,
): Promise<AdminPageResult<BusinessListDbRow>> {
  // business_versions is the physical relation (migrations 0001/0006). The
  // outer name is only a derived-table alias; keep it visibly distinct from
  // the nonexistent `businesses` table name.
  const fromSql = `(
    SELECT latest.business_id, latest.version, latest.status, latest.is_active,
           latest.digest, latest.queue, latest.created_at, latest.updated_at,
           active.active_version
    FROM (
      SELECT DISTINCT ON (business_id) business_id, version, status, is_active,
             digest, queue, created_at, updated_at
      FROM business_versions
      ORDER BY business_id, created_at DESC, version DESC
    ) latest
    LEFT JOIN (
      SELECT DISTINCT ON (business_id) business_id, version AS active_version
      FROM business_versions WHERE is_active = true
      ORDER BY business_id, version DESC
    ) active ON active.business_id = latest.business_id
  ) business_page`;
  return sortableAdminKeysetPage<BusinessListDbRow>({
    db,
    fromSql,
    columns: `business_page.business_id, business_page.version, business_page.status, business_page.is_active, business_page.digest, business_page.queue, business_page.created_at, business_page.updated_at, business_page.active_version,
              to_char(business_page.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
              to_char(business_page.updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor`,
    clauses: [],
    params: [],
    cursor: query.cursor,
    limit: query.limit,
    sort: query.sort,
    sortColumns: { createdAt: 'business_page.created_at', updatedAt: 'business_page.updated_at' },
    timestampRowKey: query.sort.startsWith('createdAt:') ? 'created_at_cursor' : 'updated_at_cursor',
    timestampFallbackRowKey: query.sort.startsWith('createdAt:') ? 'created_at' : 'updated_at',
    tieColumn: 'business_page.business_id',
    tieType: 'text',
    countSql: 'SELECT count(DISTINCT business_id)::int AS total FROM business_versions',
  });
}

export interface BusinessVersionDbRow extends Record<string, unknown> {
  business_id: string;
  version: string;
  status: string;
  is_active: boolean;
  digest: string;
  queue: string;
  created_at: Date;
  updated_at: Date;
}

export async function listBusinessVersionPage(
  db: Db,
  businessId: string,
  query: AdminResourceListQuery,
): Promise<AdminPageResult<BusinessVersionDbRow>> {
  return sortableAdminKeysetPage<BusinessVersionDbRow>({
    db,
    fromSql: 'business_versions',
    columns: `business_id, version, status, is_active, digest, queue, created_at, updated_at,
              to_char(created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
              to_char(updated_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor`,
    clauses: ['business_id = $1'],
    params: [businessId],
    cursor: query.cursor,
    limit: query.limit,
    sort: query.sort,
    sortColumns: { createdAt: 'created_at', updatedAt: 'updated_at' },
    timestampRowKey: query.sort.startsWith('createdAt:') ? 'created_at_cursor' : 'updated_at_cursor',
    timestampFallbackRowKey: query.sort.startsWith('createdAt:') ? 'created_at' : 'updated_at',
    tieColumn: 'version',
    tieType: 'text',
    countSql: `SELECT count(*)::int AS total,
                      (SELECT version FROM business_versions WHERE business_id=$1 AND is_active=true LIMIT 1) AS active_version
               FROM business_versions WHERE business_id=$1`,
  });
}
