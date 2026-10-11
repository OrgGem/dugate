import type { QueryResult, QueryResultRow } from 'pg';
import type { RouteContext } from '../src/http/route-context';
import { handleAdminRoutes } from '../src/http/routes/admin';

const PLATFORM_TOKEN = 'biz-07-platform-token';
const TENANT_A_TOKEN = 'biz-07-tenant-a-token';
const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';
const BUSINESS_A = 'document-core';
const BUSINESS_B = 'other-business';
const VERSION = '1.1.0';
const PROFILE_NAME = 'default';

interface QueryCall {
  sql: string;
  params: unknown[];
}

type Handler = (sql: string, params: unknown[]) => QueryResultRow[];

function result<T extends QueryResultRow>(rows: T[]): QueryResult<T> {
  return { rows, rowCount: rows.length, command: 'SELECT', oid: 0, fields: [] };
}

function context(input: {
  search?: string;
  token?: string;
  businessId?: string;
  businessVersion?: string;
  profileName?: string;
  handler: Handler;
  calls?: QueryCall[];
}): RouteContext {
  const calls = input.calls ?? [];
  const query = async <T extends QueryResultRow = QueryResultRow>(sql: string, params: unknown[] = []) => {
    calls.push({ sql: sql.replace(/\s+/g, ' ').trim().toLowerCase(), params });
    return result(input.handler(sql.replace(/\s+/g, ' ').trim().toLowerCase(), params) as T[]);
  };
  const businessId = input.businessId ?? BUSINESS_A;
  const businessVersion = input.businessVersion ?? VERSION;
  const profileName = input.profileName ?? PROFILE_NAME;
  return {
    method: 'GET',
    pathname: `/api/v1/admin/profiles/${businessId}/${businessVersion}/${profileName}/workflows`,
    searchParams: new URLSearchParams(input.search ?? `tenantId=${TENANT_A}`),
    headers: { authorization: 'Bearer ' + (input.token ?? PLATFORM_TOKEN) },
    config: {
      adminToken: PLATFORM_TOKEN,
      tenantAdminTokens: { [TENANT_A_TOKEN]: TENANT_A },
    },
    db: { query },
  } as unknown as RouteContext;
}

describe('BIZ-07 profile workflow read route', () => {
  it('returns workflow schema rows with saved binding state for the exact profile owner tuple', async () => {
    const calls: QueryCall[] = [];
    const routeContext = context({
      calls,
      handler: (sql) => {
        if (sql.startsWith('select n.profile_id, n.tenant_id')) {
          return [{ profile_id: 'profile-a', tenant_id: TENANT_A }];
        }
        if (sql.startsWith('select w.slug')) {
          return [{
            slug: 'review-flow',
            revision: 3,
            status: 'active',
            enabled: true,
            created_at: new Date('2026-10-11T08:30:00.000Z'),
          }];
        }
        throw new Error('unexpected SQL: ' + sql);
      },
    });

    const response = await handleAdminRoutes(routeContext);

    expect(response?.status).toBe(200);
    expect(response?.body).toEqual({
      businessId: BUSINESS_A,
      businessVersion: VERSION,
      items: [{
        slug: 'review-flow',
        revision: 3,
        status: 'active',
        enabled: true,
        createdAt: '2026-10-11T08:30:00.000Z',
      }],
      total: 1,
    });
    expect(Object.keys((response?.body as { items: Record<string, unknown>[] }).items[0] ?? {}).sort())
      .toEqual(['createdAt', 'enabled', 'revision', 'slug', 'status']);

    expect(calls).toHaveLength(2);
    expect(calls[0]!.sql).toContain('where n.tenant_id=$1 and n.business_id=$2 and n.business_version=$3 and n.profile_name=$4');
    expect(calls[0]!.params).toEqual([TENANT_A, BUSINESS_A, VERSION, PROFILE_NAME]);
    expect(calls[1]!.sql).toContain('left join profile_workflow_bindings b');
    expect(calls[1]!.sql).toContain('b.profile_id=$4 and b.workflow_slug=w.slug and b.workflow_revision=w.revision');
    expect(calls[1]!.sql).toContain('where w.tenant_id=$1 and w.business_id=$2 and w.business_version=$3');
    expect(calls[1]!.params).toEqual([TENANT_A, BUSINESS_A, VERSION, 'profile-a']);
  });

  it('derives tenant operator scope from the credential and denies a foreign tenant before SQL', async () => {
    const calls: QueryCall[] = [];
    const ownTenant = context({
      token: TENANT_A_TOKEN,
      search: 'tenantId=' + TENANT_A,
      calls,
      handler: (sql) => sql.startsWith('select n.profile_id, n.tenant_id')
        ? [{ profile_id: 'profile-a', tenant_id: TENANT_A }]
        : [],
    });
    const ownResponse = await handleAdminRoutes(ownTenant);
    expect(ownResponse?.status).toBe(200);
    expect(ownResponse?.body).toMatchObject({ businessId: BUSINESS_A, businessVersion: VERSION, items: [], total: 0 });
    expect(calls).toHaveLength(2);

    const foreignCalls: QueryCall[] = [];
    const foreignTenant = context({
      token: TENANT_A_TOKEN,
      search: 'tenantId=' + TENANT_B,
      calls: foreignCalls,
      handler: () => [],
    });
    await expect(handleAdminRoutes(foreignTenant)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(foreignCalls).toHaveLength(0);
  });

  it('returns not found for a profile outside the requested tenant/business/version and stops before schema lookup', async () => {
    const calls: QueryCall[] = [];
    const routeContext = context({
      businessId: BUSINESS_B,
      businessVersion: '9.9.9',
      profileName: 'foreign-profile',
      calls,
      handler: (sql) => {
        if (sql.startsWith('select n.profile_id, n.tenant_id')) return [];
        throw new Error('workflow schemas must not be read for a missing owner');
      },
    });

    await expect(handleAdminRoutes(routeContext)).rejects.toMatchObject({
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.params).toEqual([TENANT_A, BUSINESS_B, '9.9.9', 'foreign-profile']);
  });

  it('requires a tenant context for platform reads and only returns schemas owned by that exact tuple', async () => {
    const missingTenantCalls: QueryCall[] = [];
    const missingTenant = context({
      search: '',
      calls: missingTenantCalls,
      handler: () => [],
    });
    await expect(handleAdminRoutes(missingTenant)).rejects.toMatchObject({
      status: 422,
      code: 'INVALID_SCHEMA',
    });
    expect(missingTenantCalls).toHaveLength(0);

    const calls: QueryCall[] = [];
    const matchingRows = [
      { tenant_id: TENANT_A, business_id: BUSINESS_A, business_version: VERSION, slug: 'owned-flow', revision: 2, status: 'active', enabled: true, created_at: new Date('2026-10-11T08:00:00.000Z') },
      { tenant_id: TENANT_B, business_id: BUSINESS_A, business_version: VERSION, slug: 'foreign-tenant-flow', revision: 2, status: 'active', enabled: false, created_at: new Date('2026-10-11T08:01:00.000Z') },
      { tenant_id: TENANT_A, business_id: BUSINESS_B, business_version: VERSION, slug: 'foreign-business-flow', revision: 2, status: 'active', enabled: false, created_at: new Date('2026-10-11T08:02:00.000Z') },
    ];
    const scoped = context({
      calls,
      handler: (sql, params) => {
        if (sql.startsWith('select n.profile_id, n.tenant_id')) {
          return [{ profile_id: 'profile-a', tenant_id: TENANT_A }];
        }
        if (sql.startsWith('select w.slug')) {
          return matchingRows
            .filter((row) => row.tenant_id === params[0]
              && row.business_id === params[1]
              && row.business_version === params[2])
            .map(({ slug, revision, status, enabled, created_at }) => ({ slug, revision, status, enabled, created_at }));
        }
        return [];
      },
    });
    const response = await handleAdminRoutes(scoped);

    expect((response?.body as { items: Array<{ slug: string }> }).items.map((item) => item.slug)).toEqual(['owned-flow']);
    expect(calls[1]!.params).toEqual([TENANT_A, BUSINESS_A, VERSION, 'profile-a']);
    expect(calls[1]!.sql).toContain('where w.tenant_id=$1 and w.business_id=$2 and w.business_version=$3');
  });
});
