import type { RouteContext } from '../src/http/route-context';
import { handlePublicRoutes } from '../src/http/routes/public';

describe('WFA workflow result ownership fence', () => {
  it('hides a same-tenant workflow result from a different API key before reading artifacts or resultRef', async () => {
    const query = jest.fn(async (sql: string, params: unknown[] = []) => {
      if (sql.includes('FROM api_keys') && sql.includes('hash=')) {
        return { rowCount: 1, rows: [{ id: 'other-key', tenant_id: 'tenant-a', key_mode: 'LEGACY_STANDALONE' }] };
      }
      if (/FROM operations/i.test(sql)) {
        expect(sql).toContain('tenant_id = $2 AND deleted_at IS NULL');
        expect(sql).toContain('api_key_id = $3');
        expect(params).toEqual(['operation-a', 'tenant-a', 'other-key']);
        return { rowCount: 0, rows: [] };
      }
      throw new Error(`unexpected database query before ownership fence: ${sql}`);
    });
    const getOperation = jest.fn(async () => ({
      id: 'operation-a',
      tenant_id: 'tenant-a',
      api_key_id: 'owner-key',
      endpoint_slug: 'workflows:schema:invoice-flow',
      state: 'SUCCEEDED',
      result_ref: 'encrypted-result-ref',
    }));
    const ctx = {
      method: 'GET',
      pathname: '/api/v1/operations/operation-a',
      headers: { 'x-api-key': 'other-key-secret' },
      searchParams: new URLSearchParams(),
      db: { query },
      runtime: { getOperation },
    } as unknown as RouteContext;

    const response = await handlePublicRoutes(ctx);
    expect(response).toMatchObject({ status: 404 });

    expect(getOperation).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledTimes(2);
  });
});
