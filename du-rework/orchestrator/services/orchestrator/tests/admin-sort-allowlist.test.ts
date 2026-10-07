import type { QueryResult, QueryResultRow } from 'pg';
import {
  ADMIN_RESOURCE_LIST_SORT_VALUES,
  decodeAdminResourceListSortCursor,
  encodeAdminResourceListSortCursor,
} from '@du/contracts';
import { route, type RouteContext } from '../src/server';

const ADMIN_TOKEN = 'sort-admin-token';
const OPERATOR_TOKEN = 'sort-operator-token';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

type Row = Record<string, unknown>;
interface Call { sql: string; params: unknown[] }

function at(minute: number): Date {
  return new Date(Date.UTC(2026, 8, 26, 0, minute));
}

const businessRows: Row[] = [
  { business_id: 'alpha', version: '1.0.0', status: 'REGISTERED_DISABLED', is_active: false, digest: 'a1', queue: 'q', created_at: at(1), updated_at: at(5) },
  { business_id: 'alpha', version: '2.0.0', status: 'ENABLED', is_active: true, digest: 'a2', queue: 'q', created_at: at(2), updated_at: at(6) },
  { business_id: 'beta', version: '1.0.0', status: 'ENABLED', is_active: false, digest: 'b1', queue: 'q', created_at: at(3), updated_at: at(3) },
  { business_id: 'gamma', version: '1.0.0', status: 'ENABLED', is_active: true, digest: 'g1', queue: 'q', created_at: at(4), updated_at: at(1) },
];

const apiKeyRows: Row[] = [
  { id: '00000001-0000-4000-8000-000000000000', tenant_id: TENANT_A, prefix: 'du_live_a', status: 'ACTIVE', created_at: at(1), updated_at: at(4) },
  { id: '00000002-0000-4000-8000-000000000000', tenant_id: TENANT_B, prefix: 'du_live_b', status: 'ACTIVE', created_at: at(2), updated_at: at(2) },
  { id: '00000003-0000-4000-8000-000000000000', tenant_id: TENANT_A, prefix: 'du_live_c', status: 'REVOKED', created_at: at(3), updated_at: at(6) },
  { id: '00000004-0000-4000-8000-000000000000', tenant_id: TENANT_A, prefix: 'du_live_d', status: 'ACTIVE', created_at: at(4), updated_at: at(1) },
];

function pgResult(rows: Row[]): QueryResult<QueryResultRow> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as QueryResultRow[], fields: [] };
}

function latestBusinessRows(): Row[] {
  const latest = new Map<string, Row>();
  for (const row of businessRows) {
    const current = latest.get(String(row['business_id']));
    if (!current || Number(row['created_at']) > Number(current['created_at']) ||
      (Number(row['created_at']) === Number(current['created_at']) && String(row['version']) > String(current['version']))) {
      latest.set(String(row['business_id']), row);
    }
  }
  return [...latest.values()].map((row) => ({
    ...row,
    active_version: businessRows.find((candidate) => candidate['business_id'] === row['business_id'] && candidate['is_active'] === true)?.['version'] ?? null,
  }));
}

function sortSpec(sql: string): { key: 'created_at' | 'updated_at'; tie: string; direction: 'ASC' | 'DESC' } {
  const found = /ORDER BY (?:\w+\.)?(created_at|updated_at) (ASC|DESC), (?:\w+\.)?(business_id|version|id) (ASC|DESC)/i.exec(sql);
  if (!found) throw new Error('query is missing the allowlisted timestamp + stable tie-break order: ' + sql);
  if (found[2]!.toUpperCase() !== found[4]!.toUpperCase()) throw new Error('tie-break direction differs from sort direction');
  return { key: found[1]!.toLowerCase() as 'created_at' | 'updated_at', tie: found[3]!.toLowerCase(), direction: found[2]!.toUpperCase() as 'ASC' | 'DESC' };
}

function applySortAndCursor(rows: Row[], sql: string, params: unknown[]): Row[] {
  const spec = sortSpec(sql);
  let filtered = rows;
  const boundary = /\((?:\w+\.)?(created_at|updated_at), (?:\w+\.)?(business_id|version|id)\) ([<>]) \(\$(\d+)::timestamptz, \$(\d+)::(text|uuid)\)/i.exec(sql);
  if (boundary) {
    if (boundary[1]!.toLowerCase() !== spec.key || boundary[2]!.toLowerCase() !== spec.tie) {
      throw new Error('cursor boundary differs from the ORDER BY key/tie-break');
    }
    const timestamp = new Date(String(params[Number(boundary[4]) - 1])).getTime();
    const id = String(params[Number(boundary[5]) - 1]);
    const operator = boundary[3];
    filtered = filtered.filter((row) => {
      const timeDiff = new Date(String(row[spec.key])).getTime() - timestamp;
      const tieValue = String(row[spec.tie]);
      const pairDiff = timeDiff || tieValue.localeCompare(id);
      return operator === '<' ? pairDiff < 0 : pairDiff > 0;
    });
  }
  const direction = spec.direction === 'ASC' ? 1 : -1;
  filtered.sort((left, right) => {
    const timeDiff = new Date(String(left[spec.key])).getTime() - new Date(String(right[spec.key])).getTime();
    return (timeDiff || String(left[spec.tie]).localeCompare(String(right[spec.tie]))) * direction;
  });
  const limit = Number(params[params.length - 1]);
  return filtered.slice(0, limit);
}

function fixtureDb(calls: Call[]) {
  return {
    async query(sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> {
      calls.push({ sql, params });
      const flat = sql.replace(/\s+/g, ' ');
      if (/count\(DISTINCT business_id\)/i.test(flat)) {
        return pgResult([{ total: new Set(businessRows.map((row) => row['business_id'])).size }]);
      }
      if (/count\(\*\).*active_version/i.test(flat)) {
        const businessId = String(params[0]);
        const selected = businessRows.filter((row) => row['business_id'] === businessId);
        return pgResult([{
          total: selected.length,
          active_version: selected.find((row) => row['is_active'] === true)?.['version'] ?? null,
        }]);
      }
      if (/FROM business_versions/i.test(flat)) {
        const sourceRows = flat.includes('FROM (')
          ? latestBusinessRows()
          : businessRows.filter((row) => row['business_id'] === params[0]);
        return pgResult(applySortAndCursor(sourceRows, flat, params));
      }
      if (/FROM api_keys/i.test(flat) && /count\(\*\)/i.test(flat)) {
        return pgResult([{ total: apiRowsFor(sql, params).length }]);
      }
      if (/FROM api_keys/i.test(flat)) return pgResult(applySortAndCursor(apiRowsFor(sql, params), flat, params));
      if (/FROM profile_bindings/i.test(flat)) return pgResult([]);
      throw new Error('unexpected SQL in test: ' + flat.slice(0, 180));
    },
  };
}

function apiRowsFor(sql: string, params: unknown[]): Row[] {
  let rows = apiKeyRows;
  const tenant = /tenant_id = \$(\d+)/i.exec(sql);
  if (tenant) rows = rows.filter((row) => row['tenant_id'] === params[Number(tenant[1]) - 1]);
  const status = /status = \$(\d+)/i.exec(sql);
  if (status) rows = rows.filter((row) => row['status'] === params[Number(status[1]) - 1]);
  const prefix = /strpos\(lower\(prefix\), lower\(\$(\d+)\)\)/i.exec(sql);
  if (prefix) rows = rows.filter((row) => String(row['prefix']).toLowerCase().includes(String(params[Number(prefix[1]) - 1]).toLowerCase()));
  return rows;
}

function context(pathname: string, search: string, token = ADMIN_TOKEN): { ctx: RouteContext; calls: Call[] } {
  const calls: Call[] = [];
  const ctx = {
    method: 'GET',
    pathname,
    searchParams: new URLSearchParams(search),
    headers: { authorization: 'Bearer ' + token },
    config: { adminToken: ADMIN_TOKEN, tenantAdminTokens: { [OPERATOR_TOKEN]: TENANT_A } },
    db: fixtureDb(calls),
  } as unknown as RouteContext;
  return { ctx, calls };
}

async function fetchPage(pathname: string, search: string, token = ADMIN_TOKEN): Promise<{ body: Row; calls: Call[] }> {
  const input = context(pathname, search, token);
  const response = await route(input.ctx);
  return { body: response.body as Row, calls: input.calls };
}

function pageItems(body: Row): Row[] {
  return (body['items'] ?? body['rows']) as Row[];
}

function expectedSort<T extends Row>(rows: T[], sort: string, tieField: string): string[] {
  const [field, direction] = sort.split(':') as ['createdAt' | 'updatedAt', 'asc' | 'desc'];
  const sqlField = field === 'createdAt' ? 'created_at' : 'updated_at';
  const factor = direction === 'asc' ? 1 : -1;
  return rows.slice().sort((a, b) => {
    const difference = new Date(String(a[sqlField])).getTime() - new Date(String(b[sqlField])).getTime();
    return (difference || String(a[tieField]).localeCompare(String(b[tieField]))) * factor;
  }).map((row) => String(row[tieField]));
}

async function walk(path: string, sort: string, tieField: string, wireTieField = tieField, extraSearch = '', token = ADMIN_TOKEN): Promise<string[]> {
  const values: string[] = [];
  let cursor: string | null = null;
  for (let index = 0; index < 30; index += 1) {
    const query = new URLSearchParams(extraSearch);
    query.set('limit', '1');
    query.set('sort', sort);
    if (cursor) query.set('cursor', cursor);
    const { body } = await fetchPage(path, query.toString(), token);
    values.push(...pageItems(body).map((row) => String(row[wireTieField])));
    cursor = body['nextCursor'] as string | null;
    if (!cursor) return values;
  }
  throw new Error('pagination failed to terminate');
}

describe('ADM-UX-02 sortable admin resource lists', () => {
  it('sort cursor stays inside the shared cursor bound and retains sub-millisecond ordering', () => {
    const encoded = encodeAdminResourceListSortCursor({
      timestamp: '2026-09-28T06:00:00.123456Z',
      id: '00000001-0000-4000-8000-000000000000',
      direction: 'prev',
      sort: 'updatedAt:desc',
    });
    expect(encoded.length).toBeLessThanOrEqual(128);
    expect(decodeAdminResourceListSortCursor(encoded)).toEqual({
      timestamp: '2026-09-28T06:00:00.123456Z',
      id: '00000001-0000-4000-8000-000000000000',
      direction: 'prev',
      sort: 'updatedAt:desc',
    });
  });

  const sortFixtures = [
    { path: '/api/v1/admin/businesses', source: latestBusinessRows(), tie: 'business_id' },
    { path: '/api/v1/admin/businesses/alpha/versions', source: businessRows.filter((row) => row['business_id'] === 'alpha'), tie: 'version' },
    { path: '/api/v1/admin/api-keys?tenantId=' + TENANT_A, source: apiKeyRows.filter((row) => row['tenant_id'] === TENANT_A), tie: 'id' },
  ] as const;

  it.each(sortFixtures)('$path walks each supported ordering without gaps or duplicates', async ({ path, source, tie }) => {
    const [pathname, existingSearch] = path.split('?') as [string, string?];
    for (const sort of ADMIN_RESOURCE_LIST_SORT_VALUES) {
      const suffix = existingSearch ? existingSearch + '&' : '';
      const wireTie = tie === 'business_id' ? 'businessId' : tie;
      await expect(walk(pathname, sort, tie, wireTie, existingSearch ?? '')).resolves.toEqual(expectedSort(source as unknown as Row[], sort, tie));
      const first = await fetchPage(pathname, suffix + 'limit=1&sort=' + sort);
      expect(first.body['total']).toBe(source.length);
      expect(first.body['limit']).toBe(1);
      const cursor = first.body['nextCursor'];
      expect(decodeAdminResourceListSortCursor(String(cursor))?.sort).toBe(sort);
    }
  });

  it('rejects unknown sort values and a cursor replayed under another sort before querying', async () => {
    const invalid = context('/api/v1/admin/businesses', 'sort=created_at%3Adesc');
    await expect(route(invalid.ctx)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(invalid.calls).toHaveLength(0);

    const first = await fetchPage('/api/v1/admin/api-keys', 'tenantId=' + TENANT_A + '&limit=1&sort=createdAt%3Adesc');
    const cursor = String(first.body['nextCursor']);
    const changed = context('/api/v1/admin/api-keys', 'tenantId=' + TENANT_A + '&limit=1&sort=updatedAt%3Aasc&cursor=' + encodeURIComponent(cursor));
    await expect(route(changed.ctx)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(changed.calls).toHaveLength(0);
  });

  it('API-key sorting preserves the credential tenant fence in page and count SQL', async () => {
    const { body, calls } = await fetchPage('/api/v1/admin/api-keys', 'limit=1&sort=updatedAt%3Adesc', OPERATOR_TOKEN);
    expect(pageItems(body).every((row) => row['tenantId'] === TENANT_A)).toBe(true);
    const reads = calls.filter((call) => /FROM api_keys/i.test(call.sql));
    expect(reads.length).toBe(2);
    for (const read of reads) {
      expect(read.sql).toMatch(/tenant_id = \$1/i);
      expect(read.params[0]).toBe(TENANT_A);
    }
    expect(reads[0]!.sql).toMatch(/ORDER BY updated_at DESC, id DESC/);
  });

  it('backward page returns the exact previous page and carries a next cursor', async () => {
    const p1 = await fetchPage('/api/v1/admin/api-keys', 'tenantId=' + TENANT_A + '&limit=1&sort=createdAt%3Aasc');
    const p2 = await fetchPage('/api/v1/admin/api-keys', 'tenantId=' + TENANT_A + '&limit=1&sort=createdAt%3Aasc&cursor=' + encodeURIComponent(String(p1.body['nextCursor'])));
    const back = await fetchPage('/api/v1/admin/api-keys', 'tenantId=' + TENANT_A + '&limit=1&sort=createdAt%3Aasc&cursor=' + encodeURIComponent(String(p2.body['prevCursor'])));
    expect(pageItems(back.body).map((row) => row['id'])).toEqual(pageItems(p1.body).map((row) => row['id']));
    expect(back.body['nextCursor']).toBeTruthy();
    expect(back.body['prevCursor']).toBe(null);
  });
});
