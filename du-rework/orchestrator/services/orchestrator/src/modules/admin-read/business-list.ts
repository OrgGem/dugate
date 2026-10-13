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
  enabled: boolean;
  lifecycle_revision: number | string;
  activation_revision: number | string;
  submissions_paused: boolean;
  pre_drain_version: string | null;
  version: string;
  status: string;
  is_active: boolean;
  digest: string;
  queue: string;
  created_at: Date;
  updated_at: Date;
  active_version: string | null;
  admission_eligible: boolean;
  admission_reason: string;
}

export async function listAdminBusinessesPage(
  db: Db,
  query: AdminResourceListQuery,
): Promise<AdminPageResult<BusinessListDbRow>> {
  // business_versions is the physical relation (migrations 0001/0006). The
  // outer name is only a derived-table alias; keep it visibly distinct from
  // the nonexistent `businesses` table name.
  const fromSql = `(
    SELECT latest.business_id, c.enabled, c.lifecycle_revision, c.activation_revision,
           c.submissions_paused, c.pre_drain_version, latest.version, latest.status, latest.is_active,
           latest.digest, latest.queue, latest.created_at, latest.updated_at,
           active.active_version, active.active_status,
           (c.enabled AND active.active_version IS NOT NULL AND active.active_status='ENABLED') AS admission_eligible,
           CASE WHEN NOT c.enabled THEN 'BUSINESS_DISABLED'
                WHEN active.active_version IS NULL THEN 'NO_ACTIVE_VERSION'
                WHEN active.active_status <> 'ENABLED' THEN 'VERSION_NOT_ENABLED'
                ELSE 'ELIGIBLE' END AS admission_reason
    FROM (
      SELECT DISTINCT ON (business_id) business_id, version, status, is_active,
             digest, queue, created_at, updated_at
      FROM business_versions
      ORDER BY business_id, created_at DESC, version DESC
    ) latest
    JOIN business_catalog c ON c.business_id = latest.business_id
    LEFT JOIN (
      SELECT DISTINCT ON (business_id) business_id, version AS active_version, status AS active_status
      FROM business_versions WHERE is_active = true
      ORDER BY business_id, version DESC
    ) active ON active.business_id = latest.business_id
  ) business_page`;
  return sortableAdminKeysetPage<BusinessListDbRow>({
    db,
    fromSql,
    columns: `business_page.business_id, business_page.enabled, business_page.lifecycle_revision, business_page.activation_revision,
              business_page.submissions_paused, business_page.pre_drain_version,
              business_page.version, business_page.status, business_page.is_active, business_page.digest, business_page.queue, business_page.created_at, business_page.updated_at, business_page.active_version,
              business_page.admission_eligible, business_page.admission_reason,
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
  admission_eligible: boolean;
  admission_reason: string;
}

export async function listBusinessVersionPage(
  db: Db,
  businessId: string,
  query: AdminResourceListQuery,
): Promise<AdminPageResult<BusinessVersionDbRow>> {
  return sortableAdminKeysetPage<BusinessVersionDbRow>({
    db,
    fromSql: `(SELECT bv.business_id, bv.version, bv.status, bv.is_active, bv.digest, bv.queue, bv.created_at, bv.updated_at,
                     (c.enabled AND bv.status='ENABLED' AND bv.is_active) AS admission_eligible,
                     CASE WHEN NOT c.enabled THEN 'BUSINESS_DISABLED'
                          WHEN active.version IS NULL THEN 'NO_ACTIVE_VERSION'
                          WHEN NOT bv.is_active THEN 'VERSION_NOT_ACTIVE'
                          WHEN bv.status <> 'ENABLED' THEN 'VERSION_NOT_ENABLED'
                          ELSE 'ELIGIBLE' END AS admission_reason
                FROM business_versions bv
                JOIN business_catalog c ON c.business_id=bv.business_id
                LEFT JOIN business_versions active ON active.business_id=bv.business_id AND active.is_active=true) version_page`,
    columns: `business_id, version, status, is_active, digest, queue, created_at, updated_at,
              admission_eligible, admission_reason,
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
