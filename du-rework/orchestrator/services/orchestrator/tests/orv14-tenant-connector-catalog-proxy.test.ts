import { createConnectorManagementStore } from '../src/modules/connectors/connector-management-store';

const TENANT_ID = '123e4567-e89b-42d3-a456-426614174000';

describe('tenant ACTIVE Connector catalog proxy', () => {
  test('sends a bounded tenant query with connector:management identity and validates the exact tenant page', async () => {
    const calls: Array<{ url: string; authorization: string }> = [];
    const store = createConnectorManagementStore({
      baseUrlFor: () => 'https://connector.internal',
      authorizationForRequest: (scope) => {
        expect(scope).toBe('connector:management');
        return 'Bearer signed-service-identity';
      },
      fetchImpl: async (input, init) => {
        calls.push({ url: String(input), authorization: String((init?.headers as Record<string, string>)?.authorization) });
        return new Response(JSON.stringify({
          tenantId: TENANT_ID,
          items: [{
            tenantId: TENANT_ID,
            connectorId: 'tenant-gemini',
            revision: 4,
            adapter: 'google-generative-language',
            provider: 'google',
            model: 'gemini-2.5-pro',
            credentialConfigured: true,
            updatedAt: '2026-10-12T00:00:00.000Z',
          }],
          limit: 25,
          nextCursor: null,
        }), { status: 200, headers: { 'content-type': 'application/json' } });
      },
    });

    const page = await store.listActiveRecipeRevisions({ tenantId: TENANT_ID, q: 'gemini', limit: 25 });
    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.revision).toBe(4);
    expect(calls).toEqual([{
      url: 'https://connector.internal/internal/admin/connector-revisions/active?tenantId=123e4567-e89b-42d3-a456-426614174000&limit=25&q=gemini',
      authorization: 'Bearer signed-service-identity',
    }]);
  });

  test('rejects a producer response that escapes tenant scope or includes secret locators', async () => {
    const store = createConnectorManagementStore({
      baseUrlFor: () => 'https://connector.internal',
      authorizationForRequest: () => 'Bearer signed-service-identity',
      fetchImpl: async () => new Response(JSON.stringify({
        tenantId: TENANT_ID,
        items: [{
          tenantId: TENANT_ID,
          connectorId: 'tenant-openai',
          revision: 2,
          adapter: 'openai-compatible',
          provider: 'openai',
          model: null,
          credentialConfigured: true,
          updatedAt: '2026-10-12T00:00:00.000Z',
          vaultPath: 'secret/path',
        }],
        limit: 100,
        nextCursor: null,
      }), { status: 200 }),
    });
    await expect(store.listActiveRecipeRevisions({ tenantId: TENANT_ID, limit: 100 })).rejects.toMatchObject({ status: 502, code: 'CONNECTOR_API_ERROR' });
  });
});
