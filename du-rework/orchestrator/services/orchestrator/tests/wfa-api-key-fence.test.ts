import type { RouteContext } from '../src/http/route-context';
import { handlePublicRoutes } from '../src/http/routes/public';

describe('WFA workflow result ownership fence', () => {
  it('hides a same-tenant workflow result from a different API key before reading artifacts or resultRef', async () => {
    const query = jest.fn(async (sql: string) => {
      if (sql.startsWith('SELECT id, tenant_id FROM api_keys')) {
        return { rowCount: 1, rows: [{ id: 'other-key', tenant_id: 'tenant-a' }] };
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
      pathname: '/api/v1/operations/operation-a/result',
      headers: { 'x-api-key': 'other-key-secret' },
      searchParams: new URLSearchParams(),
      db: { query },
      runtime: { getOperation },
    } as unknown as RouteContext;

    await expect(handlePublicRoutes(ctx)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });

    expect(getOperation).toHaveBeenCalledWith('operation-a');
    expect(query).toHaveBeenCalledTimes(1);
  });
});
