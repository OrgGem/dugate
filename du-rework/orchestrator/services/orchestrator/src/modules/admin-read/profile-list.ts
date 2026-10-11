/** Read-only, tenant-fenced profile catalog for the Admin Web table. */
import { HttpError } from '../../http/errors';
import type { Db } from '../../db/db';
import {
  parseAdminResourceListQuery,
  sortableAdminKeysetPage,
  UUID_PARAM_PATTERN,
  type AdminPageResult,
  type AdminResourceListQuery,
} from './keyset';

const PROFILE_LIST_PAGE_PARAMS = ['limit', 'cursor', 'sort'] as const;

export interface AdminProfileListQuery extends AdminResourceListQuery {
  tenantId: string | null;
  businessId: string | null;
}

export interface AdminProfileListDbRow extends Record<string, unknown> {
  profile_id: string;
  tenant_id: string;
  business_id: string;
  business_version: string;
  profile_name: string;
  revision: number;
  enabled: boolean | null;
  key_count: number;
  bound_actions: string[];
  created_at: Date;
  updated_at: Date;
  created_at_cursor: string;
  updated_at_cursor: string;
}

function singleQueryValue(params: URLSearchParams, name: string): string | null {
  const values = params.getAll(name);
  if (values.length > 1) throw new HttpError(422, 'INVALID_SCHEMA', `${name} must not be repeated`);
  return values[0] ?? null;
}

export function parseAdminProfileListQuery(params: URLSearchParams): AdminProfileListQuery {
  const page = parseAdminResourceListQuery(params, PROFILE_LIST_PAGE_PARAMS);
  const rawTenantId = singleQueryValue(params, 'tenantId');
  const tenantId = rawTenantId === null || rawTenantId.trim().length === 0 ? null : rawTenantId.trim();
  if (tenantId !== null && !UUID_PARAM_PATTERN.test(tenantId)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'tenantId must be a uuid');
  }

  const rawBusinessId = singleQueryValue(params, 'businessId');
  const businessId = rawBusinessId === null || rawBusinessId.trim().length === 0 ? null : rawBusinessId.trim();
  if (businessId !== null && (businessId.length > 256 || /[\u0000-\u001f\u007f]/.test(businessId))) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'businessId must be at most 256 printable characters');
  }
  if (page.cursor !== null && !UUID_PARAM_PATTERN.test(page.cursor.id)) {
    throw new HttpError(422, 'INVALID_SCHEMA', 'cursor id is not valid for profile pagination');
  }
  return { ...page, tenantId, businessId };
}

/**
 * Page only named profiles with a live revision pointer. The tenant predicate
 * is always the first SQL bind; neither an unscoped scan nor browser filtering
 * can expose another tenant's profile metadata.
 */
export async function listAdminProfilePage(
  db: Db,
  tenantId: string,
  query: AdminProfileListQuery,
): Promise<AdminPageResult<AdminProfileListDbRow>> {
  const clauses = ['n.tenant_id = $1'];
  const params: unknown[] = [tenantId];
  if (query.businessId !== null) {
    params.push(query.businessId);
    clauses.push(`n.business_id = $${params.length}`);
  }
  const where = ` WHERE ${clauses.join(' AND ')}`;
  const baseFromSql = `profile_names n
    JOIN profile_active_revisions a ON a.profile_id = n.profile_id
    JOIN profile_bindings active_binding
      ON active_binding.profile_id = a.profile_id AND active_binding.revision = a.revision`;
  const fromSql = `${baseFromSql}
    LEFT JOIN LATERAL (
      SELECT count(*) FILTER (WHERE m.state = 'ACTIVE' AND k.status = 'ACTIVE')::int AS key_count
        FROM profile_api_keys m
        JOIN api_keys k ON k.id = m.api_key_id
       WHERE m.profile_id = n.profile_id AND m.tenant_id = n.tenant_id
    ) key_summary ON true`;

  return sortableAdminKeysetPage<AdminProfileListDbRow>({
    db,
    fromSql,
    columns: `n.profile_id, n.tenant_id, n.business_id, n.business_version, n.profile_name,
              a.revision, active_binding.enabled,
              COALESCE(key_summary.key_count, 0)::int AS key_count,
              ARRAY[active_binding.action]::text[] AS bound_actions,
              n.created_at, a.moved_at AS updated_at,
              to_char(n.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
              to_char(a.moved_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS updated_at_cursor`,
    clauses,
    params,
    cursor: query.cursor,
    limit: query.limit,
    sort: query.sort,
    sortColumns: { createdAt: 'n.created_at', updatedAt: 'a.moved_at' },
    timestampRowKey: query.sort.startsWith('createdAt:') ? 'created_at_cursor' : 'updated_at_cursor',
    timestampFallbackRowKey: query.sort.startsWith('createdAt:') ? 'created_at' : 'updated_at',
    tieColumn: 'n.profile_id',
    tieType: 'uuid',
    countSql: `SELECT count(*)::int AS total FROM ${baseFromSql}${where}`,
  });
}
