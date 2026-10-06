import { createConnectorManagementStore } from '../src/modules/connectors/connector-management-store';
import { handleAdminRoutes } from '../src/http/routes/admin';
import type { RouteContext } from '../src/http/route-context';

function context(overrides: Record<string, unknown> = {}): RouteContext {
  return {
    method: 'GET',
    pathname: '/api/v1/admin/businesses',
    searchParams: new URLSearchParams(),
    headers: { authorization: 'Bearer admin-test-token' },
    body: undefined,
    rawBody: Buffer.alloc(0),
    correlationId: 'business-contract-fix-820',
    config: { adminToken: 'admin-test-token' },
    ...overrides,
  } as unknown as RouteContext;
}

describe('BUSINESS-CONTRACT-FIX-820', () => {
  it('returns an empty business page using the migrated physical relation', async () => {
    const queries: string[] = [];
    const db = {
      query: async (sql: string) => {
        queries.push(sql);
        if (/^SELECT count\(DISTINCT business_id\)/i.test(sql.trim())) {
          return { rows: [{ total: 0 }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      },
    };

    const result = await handleAdminRoutes(context({ db }));

    expect(result?.status).toBe(200);
    expect(result?.body).toMatchObject({ items: [], total: 0 });
    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain('FROM business_versions');
    expect(queries[0]).toContain(') business_page');
    expect(queries[0]).not.toMatch(/\bFROM\s+businesses\b/i);
    expect(queries[1]).toContain('FROM business_versions');
  });

  it('returns a clear fail-closed error when connector management is not composed', async () => {
    await expect(
      handleAdminRoutes(context({ pathname: '/api/v1/admin/connectors' })),
    ).rejects.toMatchObject({
      status: 503,
      code: 'TEMPORARY_UNAVAILABLE',
      message: 'connector management store not configured',
    });
  });

  it('normalizes an unavailable connector service at the route boundary', async () => {
    let calls = 0;
    const connectorManagement = createConnectorManagementStore({
      baseUrlFor: () => 'http://127.0.0.1:8099',
      authorizationForRequest: () => 'Bearer test-management-token',
      fetchImpl: (async () => {
        calls += 1;
        throw new TypeError('connect ECONNREFUSED 127.0.0.1:8099');
      }) as unknown as typeof fetch,
    });

    await expect(
      handleAdminRoutes(context({ pathname: '/api/v1/admin/connectors', connectorManagement })),
    ).rejects.toMatchObject({
      status: 503,
      code: 'TEMPORARY_UNAVAILABLE',
      message: 'connector management service is unavailable',
    });
    expect(calls).toBe(1);
  });
});
