import {
  ADMIN_BUSINESS_LIST_QUERY_PARAMS,
  ADMIN_RESOURCE_LIST_SORT_DEFAULT,
  ADMIN_RESOURCE_LIST_SORT_VALUES,
  TENANT_BUSINESS_CATALOG_QUERY_PARAMS,
  AdminBusinessListQuerySchema,
  ListPageBaseSchema,
  TenantBusinessCatalogPageSchema,
  TenantBusinessCatalogQuerySchema,
  decodeAdminResourceListSortCursor,
} from '@du/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import type { RouteContext } from '../src/http/route-context';
import { handleAdminRoutes } from '../src/http/routes/admin';

const ADMIN_TOKEN = 'business-catalog-platform-token';
const TENANT_OPERATOR_TOKEN = 'business-catalog-tenant-token';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const BUSINESS_PATH = '/api/v1/admin/businesses';
const tenantBusinessPath = (tenantId = TENANT_A) => `/api/v1/admin/tenants/${tenantId}/businesses`;

interface QueryCall {
  sql: string;
  params: unknown[];
}

interface BusinessRow extends QueryResultRow {
  business_id: string;
  version: string;
  status: string;
  is_active: boolean;
  digest: string;
  queue: string;
  created_at: Date;
  updated_at: Date;
  active_version: string | null;
  created_at_cursor: string;
  updated_at_cursor: string;
}

function row(businessId: string, createdAt: string): BusinessRow {
  const timestamp = new Date(createdAt);
  return {
    business_id: businessId,
    version: '2.0.0',
    status: 'ENABLED',
    is_active: true,
    digest: 'sha256:' + businessId.padEnd(64, '0').slice(0, 64),
    queue: 'business-' + businessId,
    created_at: timestamp,
    updated_at: timestamp,
    active_version: '2.0.0',
    created_at_cursor: timestamp.toISOString(),
    updated_at_cursor: timestamp.toISOString(),
  };
}

const ROW_A = row('business-a', '2026-10-11T12:00:00.000Z');
const ROW_B = row('business-b', '2026-10-11T11:00:00.000Z');
const ROW_C = row('business-c', '2026-10-11T10:00:00.000Z');
const ROW_D = row('business-d', '2026-10-11T09:00:00.000Z');

function queryResult<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows, fields: [] };
}

function harness(input: { search?: string; token?: string } = {}) {
  const calls: QueryCall[] = [];
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT count\(DISTINCT business_id\)/i.test(sql.trim())) {
        return queryResult([{ total: 4 } as unknown as T]);
      }
      if (/ORDER BY business_page\.created_at ASC, business_page\.business_id ASC/i.test(sql)) {
        return queryResult([ROW_B, ROW_A] as unknown as T[]);
      }
      if (/\(business_page\.created_at, business_page\.business_id\) </i.test(sql)) {
        return queryResult([ROW_C, ROW_D] as unknown as T[]);
      }
      return queryResult([ROW_A, ROW_B, ROW_C] as unknown as T[]);
    },
  };
  const ctx = {
    method: 'GET',
    pathname: BUSINESS_PATH,
    searchParams: new URLSearchParams(input.search ?? ''),
    headers: { authorization: 'Bearer ' + (input.token ?? ADMIN_TOKEN) },
    config: {
      adminToken: ADMIN_TOKEN,
      tenantAdminTokens: { [TENANT_OPERATOR_TOKEN]: TENANT_A },
    },
    db,
  } as unknown as RouteContext;
  return { ctx, calls };
}

interface TenantBusinessRow extends QueryResultRow {
  business_id: string;
  latest_version: string | null;
  latest_status: string | null;
  active_version: string | null;
  version_count: number;
  created_at: Date;
  updated_at: Date;
  created_at_cursor: string;
  updated_at_cursor: string;
}

function catalogRow(businessId: string, createdAt: string, updatedAt = createdAt): TenantBusinessRow {
  const created = new Date(createdAt);
  const updated = new Date(updatedAt);
  const cursorTimestamp = (date: Date) => date.toISOString().replace(/\.\d{3}Z$/, '.000000Z');
  return {
    business_id: businessId,
    latest_version: '2.0.0',
    latest_status: 'ENABLED',
    active_version: '2.0.0',
    version_count: 2,
    created_at: created,
    updated_at: updated,
    created_at_cursor: cursorTimestamp(created),
    updated_at_cursor: cursorTimestamp(updated),
  };
}

function tenantHarness(input: {
  search?: string;
  token?: string;
  pathTenantId?: string;
  rows?: TenantBusinessRow[];
  total?: number;
} = {}) {
  const calls: QueryCall[] = [];
  const pathTenantId = input.pathTenantId ?? TENANT_A;
  const db = {
    query: async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
      calls.push({ sql: sql.replace(/\s+/g, ' ').trim(), params });
      if (/^SELECT id FROM tenants/i.test(sql.trim())) {
        return queryResult([{ id: pathTenantId } as unknown as T]);
      }
      if (/^SELECT count\(\*\)::int AS total FROM business_catalog c/i.test(sql.trim())) {
        return queryResult([{ total: input.total ?? 4 } as unknown as T]);
      }
      if (/FROM business_catalog c/i.test(sql)) {
        return queryResult((input.rows ?? []) as unknown as T[]);
      }
      return queryResult([] as T[]);
    },
  };
  const ctx = {
    method: 'GET',
    pathname: tenantBusinessPath(pathTenantId),
    searchParams: new URLSearchParams(input.search ?? ''),
    headers: { authorization: 'Bearer ' + (input.token ?? ADMIN_TOKEN) },
    config: {
      adminToken: ADMIN_TOKEN,
      tenantAdminTokens: { [TENANT_OPERATOR_TOKEN]: TENANT_A },
    },
    db,
  } as unknown as RouteContext;
  return { ctx, calls };
}

describe('Business catalog legacy route contract conformance', () => {
  it('keeps the global route query vocabulary closed to pagination and sort only', () => {
    expect([...ADMIN_BUSINESS_LIST_QUERY_PARAMS]).toEqual(['limit', 'cursor', 'sort']);
    expect(AdminBusinessListQuerySchema.safeParse({}).success).toBe(true);
    expect(AdminBusinessListQuerySchema.safeParse({ limit: 200, sort: ADMIN_RESOURCE_LIST_SORT_DEFAULT }).success).toBe(true);
    expect(AdminBusinessListQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(AdminBusinessListQuerySchema.safeParse({ tenantId: TENANT_A }).success).toBe(false);
    expect(AdminBusinessListQuerySchema.safeParse({ q: 'document' }).success).toBe(false);
  });

  it('returns a bounded legacy global page with a population total and shared page envelope', async () => {
    const h = harness({ search: 'limit=2&sort=createdAt:desc&tenantId=' + TENANT_A });
    const result = await handleAdminRoutes(h.ctx);
    const body = result?.body as Record<string, unknown>;

    expect(result?.status).toBe(200);
    expect(Object.keys(body).sort()).toEqual(['items', 'limit', 'nextCursor', 'prevCursor', 'total']);
    expect(ListPageBaseSchema.safeParse(body).success).toBe(true);
    expect((body['items'] as unknown[])).toHaveLength(2);
    expect(body['total']).toBe(4);
    expect(body['limit']).toBe(2);

    const page = h.calls.find((call) => /FROM \(/i.test(call.sql));
    const count = h.calls.find((call) => /count\(DISTINCT business_id\)/i.test(call.sql));
    expect(page).toBeDefined();
    expect(count).toBeDefined();
    expect(page?.sql).toContain('FROM business_versions');
    expect(page?.sql).toContain('DISTINCT ON (business_id)');
    expect(page?.sql).toContain('ORDER BY business_page.created_at DESC, business_page.business_id DESC');
    expect(page?.sql).toMatch(/LIMIT \$\d+$/);
    expect(page?.params.at(-1)).toBe(3);
    expect(count?.params).toEqual([]);
    expect(page?.sql).not.toMatch(/owner_tenant_id|tenant_id/i);
    expect(count?.sql).not.toMatch(/owner_tenant_id|tenant_id/i);
  });

  it('walks forward and backward with sort-bound cursors and the business ID tie-breaker', async () => {
    const firstHarness = harness({ search: 'limit=2&sort=createdAt:desc' });
    const first = await handleAdminRoutes(firstHarness.ctx);
    const firstBody = first?.body as Record<string, unknown>;
    const nextCursor = firstBody['nextCursor'];
    expect(typeof nextCursor).toBe('string');
    expect(firstBody['prevCursor']).toBeNull();
    expect(decodeAdminResourceListSortCursor(nextCursor as string)).toMatchObject({
      id: 'business-b',
      direction: 'next',
      sort: 'createdAt:desc',
    });

    const secondHarness = harness({
      search: 'limit=2&sort=createdAt:desc&cursor=' + encodeURIComponent(nextCursor as string),
    });
    const second = await handleAdminRoutes(secondHarness.ctx);
    const secondBody = second?.body as Record<string, unknown>;
    const forwardPage = secondHarness.calls.find((call) => /FROM \(/i.test(call.sql));
    expect(forwardPage?.sql).toMatch(/\(business_page\.created_at, business_page\.business_id\) </i);
    expect(forwardPage?.params.slice(0, 2)).toEqual(['2026-10-11T11:00:00.000000Z', 'business-b']);
    expect((secondBody['items'] as Record<string, unknown>[]).map((item) => item['businessId']))
      .toEqual(['business-c', 'business-d']);

    const prevCursor = secondBody['prevCursor'];
    expect(typeof prevCursor).toBe('string');
    expect(decodeAdminResourceListSortCursor(prevCursor as string)).toMatchObject({
      id: 'business-c',
      direction: 'prev',
      sort: 'createdAt:desc',
    });
    const backHarness = harness({
      search: 'limit=2&sort=createdAt:desc&cursor=' + encodeURIComponent(prevCursor as string),
    });
    const back = await handleAdminRoutes(backHarness.ctx);
    const backBody = back?.body as Record<string, unknown>;
    const backwardPage = backHarness.calls.find((call) => /FROM \(/i.test(call.sql));
    expect(backwardPage?.sql).toMatch(/\(business_page\.created_at, business_page\.business_id\) >/i);
    expect(backwardPage?.sql).toMatch(/ORDER BY business_page\.created_at ASC, business_page\.business_id ASC/i);
    expect((backBody['items'] as Record<string, unknown>[]).map((item) => item['businessId']))
      .toEqual(['business-a', 'business-b']);
  });

  it('emits the same unique tie-break ordering for every shared sort value', async () => {
    for (const sort of ADMIN_RESOURCE_LIST_SORT_VALUES) {
      const h = harness({ search: 'limit=1&sort=' + encodeURIComponent(sort) });
      await handleAdminRoutes(h.ctx);
      const page = h.calls.find((call) => /FROM \(/i.test(call.sql));
      expect(page).toBeDefined();
      const [field, direction] = sort.split(':');
      const sqlDirection = direction?.toUpperCase();
      expect(page?.sql).toContain(`ORDER BY business_page.${field === 'createdAt' ? 'created_at' : 'updated_at'} ${sqlDirection}, business_page.business_id ${sqlDirection}`);
    }
  });

  it('rejects a cursor paired with another sort before querying', async () => {
    const h = harness({ search: 'sort=updatedAt:asc&cursor=not-a-valid-cursor' });
    await expect(handleAdminRoutes(h.ctx)).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_SCHEMA',
    });
    expect(h.calls).toHaveLength(0);
  });

  it('does not let a tenant operator use the legacy global route as a catalog scope', async () => {
    const h = harness({ search: 'tenantId=' + TENANT_A, token: TENANT_OPERATOR_TOKEN });
    await expect(handleAdminRoutes(h.ctx)).rejects.toMatchObject({
      status: 401,
      code: 'UNAUTHENTICATED',
    });
    expect(h.calls).toHaveLength(0);
  });

  it('does not turn a platform request tenantId query into a tenant ownership predicate', async () => {
    const unscoped = harness({ search: 'limit=2&tenantId=' + TENANT_A });
    const scoped = harness({ search: 'limit=2&tenantId=bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb' });
    const first = await handleAdminRoutes(unscoped.ctx);
    const second = await handleAdminRoutes(scoped.ctx);

    expect(first?.body).toEqual(second?.body);
    expect(unscoped.calls.map((call) => call.sql)).toEqual(scoped.calls.map((call) => call.sql));
    expect(unscoped.calls.map((call) => call.params)).toEqual(scoped.calls.map((call) => call.params));
    expect(unscoped.calls.every((call) => !/owner_tenant_id|tenant_id/i.test(call.sql))).toBe(true);
  });
});

describe('Tenant business catalog route contract conformance', () => {
  it('publishes a closed tenant catalog query and bounded item/page contracts', () => {
    expect([...TENANT_BUSINESS_CATALOG_QUERY_PARAMS]).toEqual(['limit', 'cursor', 'sort', 'q']);
    expect(TenantBusinessCatalogQuerySchema.safeParse({}).success).toBe(true);
    expect(TenantBusinessCatalogQuerySchema.safeParse({ limit: 200, q: 'documents' }).success).toBe(true);
    expect(TenantBusinessCatalogQuerySchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(TenantBusinessCatalogQuerySchema.safeParse({ tenantId: TENANT_A }).success).toBe(false);
    expect(TenantBusinessCatalogQuerySchema.safeParse({ q: 'x'.repeat(129) }).success).toBe(false);
  });

  it('returns the shared page envelope from catalog ownership rows with safe projections', async () => {
    const h = tenantHarness({
      search: 'limit=2&sort=updatedAt:asc&q=%20DOC%20',
      token: TENANT_OPERATOR_TOKEN,
      rows: [
        catalogRow('business-a', '2026-10-11T12:00:00.000Z', '2026-10-11T12:01:00.000Z'),
        catalogRow('business-b', '2026-10-11T11:00:00.000Z', '2026-10-11T12:02:00.000Z'),
      ],
      total: 7,
    });
    const result = await handleAdminRoutes(h.ctx);
    const body = result?.body as Record<string, unknown>;
    const page = h.calls.find((call) => /ORDER BY c\.(created_at|updated_at)/i.test(call.sql));
    const count = h.calls.find((call) => /count\(\*\)::int AS total FROM business_catalog c/i.test(call.sql));

    expect(result?.status).toBe(200);
    expect(TenantBusinessCatalogPageSchema.safeParse(body).success).toBe(true);
    expect(body['total']).toBe(7);
    expect(body['limit']).toBe(2);
    expect(typeof body['generatedAt']).toBe('string');
    expect((body['items'] as Record<string, unknown>[])[0]).toEqual({
      businessId: 'business-a',
      displayName: 'business-a',
      latestVersion: '2.0.0',
      latestStatus: 'ENABLED',
      activeVersion: '2.0.0',
      versionCount: 2,
      createdAt: '2026-10-11T12:00:00.000Z',
      updatedAt: '2026-10-11T12:01:00.000Z',
    });
    expect(h.calls[0]?.sql).toBe('SELECT id FROM tenants WHERE id = $1::uuid LIMIT 1');
    expect(h.calls[0]?.params).toEqual([TENANT_A]);
    expect(page?.sql).toContain('FROM business_catalog c');
    expect(page?.sql).toContain('c.owner_tenant_id = $1::uuid');
    expect(page?.sql).toContain('left(lower(c.business_id), char_length($2::text)) = $2::text');
    expect(page?.sql).toContain('ORDER BY c.updated_at ASC, c.business_id ASC');
    expect(page?.params).toEqual([TENANT_A, 'doc', 3]);
    expect(count?.sql).toContain('c.owner_tenant_id = $1::uuid');
    expect(count?.sql).toContain('left(lower(c.business_id), char_length($2::text)) = $2::text');
    expect(count?.params).toEqual([TENANT_A, 'doc']);
  });

  it('pages by timestamp and business ID with a cursor bound to tenant, q, and sort', async () => {
    const firstHarness = tenantHarness({
      search: 'limit=2&q=doc',
      rows: [
        catalogRow('business-a', '2026-10-11T12:00:00.000Z'),
        catalogRow('business-b', '2026-10-11T11:00:00.000Z'),
        catalogRow('business-c', '2026-10-11T10:00:00.000Z'),
      ],
      total: 3,
    });
    const first = await handleAdminRoutes(firstHarness.ctx);
    const firstBody = first?.body as Record<string, unknown>;
    const nextCursor = firstBody['nextCursor'];
    expect(typeof nextCursor).toBe('string');
    expect(firstBody['prevCursor']).toBeNull();

    const secondHarness = tenantHarness({
      search: `limit=2&q=doc&cursor=${encodeURIComponent(nextCursor as string)}`,
      rows: [catalogRow('business-c', '2026-10-11T10:00:00.000Z')],
      total: 3,
    });
    const second = await handleAdminRoutes(secondHarness.ctx);
    const secondBody = second?.body as Record<string, unknown>;
    const secondPage = secondHarness.calls.find((call) => /ORDER BY c\.(created_at|updated_at)/i.test(call.sql));
    expect(secondPage?.sql).toMatch(/\(c\.created_at, c\.business_id\) </i);
    expect(secondPage?.sql).toContain('ORDER BY c.created_at DESC, c.business_id DESC');
    expect(secondPage?.params).toEqual([TENANT_A, 'doc', '2026-10-11T11:00:00.000000Z', 'business-b', 3]);
    expect((secondBody['items'] as Record<string, unknown>[]).map((item) => item['businessId'])).toEqual(['business-c']);
    expect(typeof secondBody['prevCursor']).toBe('string');

    const previousHarness = tenantHarness({
      search: `limit=2&q=doc&cursor=${encodeURIComponent(secondBody['prevCursor'] as string)}`,
      rows: [
        catalogRow('business-b', '2026-10-11T11:00:00.000Z'),
        catalogRow('business-a', '2026-10-11T12:00:00.000Z'),
      ],
      total: 3,
    });
    const previous = await handleAdminRoutes(previousHarness.ctx);
    const previousBody = previous?.body as Record<string, unknown>;
    const previousPage = previousHarness.calls.find((call) => /ORDER BY c\.(created_at|updated_at)/i.test(call.sql));
    expect(previousPage?.sql).toMatch(/\(c\.created_at, c\.business_id\) >/i);
    expect(previousPage?.sql).toContain('ORDER BY c.created_at ASC, c.business_id ASC');
    expect(previousPage?.params).toEqual([TENANT_A, 'doc', '2026-10-11T10:00:00.000000Z', 'business-c', 3]);
    expect((previousBody['items'] as Record<string, unknown>[]).map((item) => item['businessId']))
      .toEqual(['business-a', 'business-b']);

    const changedFilter = tenantHarness({
      search: `q=other&cursor=${encodeURIComponent(nextCursor as string)}`,
    });
    await expect(handleAdminRoutes(changedFilter.ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' });
    expect(changedFilter.calls).toHaveLength(0);

    const changedTenant = tenantHarness({
      pathTenantId: TENANT_B,
      search: `q=doc&cursor=${encodeURIComponent(nextCursor as string)}`,
    });
    await expect(handleAdminRoutes(changedTenant.ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' });
    expect(changedTenant.calls).toHaveLength(0);

    const changedSort = tenantHarness({
      search: `sort=updatedAt:desc&q=doc&cursor=${encodeURIComponent(nextCursor as string)}`,
    });
    await expect(handleAdminRoutes(changedSort.ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' });
    expect(changedSort.calls).toHaveLength(0);

    const [cursorPayload, cursorSignature] = (nextCursor as string).split('.');
    const changedSignature = `${cursorSignature?.[0] === 'A' ? 'B' : 'A'}${cursorSignature?.slice(1) ?? ''}`;
    const alteredCursor = tenantHarness({
      search: `q=doc&cursor=${encodeURIComponent(`${cursorPayload}.${changedSignature}`)}`,
    });
    await expect(handleAdminRoutes(alteredCursor.ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' });
    expect(alteredCursor.calls).toHaveLength(0);
  });

  it('rejects foreign tenant operators and invalid query input before catalog reads', async () => {
    const unauthenticated = tenantHarness({ token: 'unknown-admin-token' });
    await expect(handleAdminRoutes(unauthenticated.ctx)).rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(unauthenticated.calls).toHaveLength(0);

    const foreign = tenantHarness({ token: TENANT_OPERATOR_TOKEN, pathTenantId: TENANT_B });
    await expect(handleAdminRoutes(foreign.ctx)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(foreign.calls).toHaveLength(0);

    const repeated = tenantHarness({ search: 'q=one&q=two' });
    await expect(handleAdminRoutes(repeated.ctx)).rejects.toMatchObject({ status: 400, code: 'INVALID_ARGUMENT' });
    expect(repeated.calls).toHaveLength(0);

    const uppercaseOwnTenant = tenantHarness({
      token: TENANT_OPERATOR_TOKEN,
      pathTenantId: TENANT_A.toUpperCase(),
      rows: [],
      total: 0,
    });
    const accepted = await handleAdminRoutes(uppercaseOwnTenant.ctx);
    expect(accepted?.status).toBe(200);
    expect(uppercaseOwnTenant.calls[0]?.params).toEqual([TENANT_A]);
  });

  it('returns a valid empty page for a tenant with no owned businesses', async () => {
    const h = tenantHarness({ rows: [], total: 0 });
    const result = await handleAdminRoutes(h.ctx);
    const body = result?.body as Record<string, unknown>;
    expect(result?.status).toBe(200);
    expect(TenantBusinessCatalogPageSchema.safeParse(body).success).toBe(true);
    expect(body).toMatchObject({ items: [], nextCursor: null, prevCursor: null, total: 0, limit: 50 });
  });
});
