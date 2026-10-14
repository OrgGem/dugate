import { createConnectorManagementStore } from '../src/modules/connectors/connector-management-store';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CASED_TENANT = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

function page(overrides: Record<string, unknown> = {}) {
  return {
    tenantId: TENANT,
    items: [{
      tenantId: TENANT,
      connectorId: 'codex-ui-check-20261014',
      revision: 1,
      state: 'PENDING',
      adapter: 'json-http',
      authKind: 'none',
      credentialConfigured: false,
    }],
    limit: 25,
    nextCursor: null,
    ...overrides,
  };
}

describe('tenant typed Connector catalog proxy', () => {
  it('forwards bounded paging/search with management scope and validates a PENDING metadata page', async () => {
    const calls: Array<{ url: string; authorization: string }> = [];
    const store = createConnectorManagementStore({
      baseUrlFor: () => 'https://connector.internal',
      authorizationForRequest: (scope) => {
        expect(scope).toBe('connector:management');
        return 'Bearer signed-management-identity';
      },
      fetchImpl: async (input, init) => {
        calls.push({
          url: String(input),
          authorization: String((init?.headers as Record<string, string>)?.authorization),
        });
        return new Response(JSON.stringify(page({ nextCursor: 'next-page' })), { status: 200 });
      },
    });

    const result = await store.listConnectorRecipeCatalog({ tenantId: TENANT, q: 'codex', limit: 25, cursor: 'page-cursor' });
    expect(result.items[0]?.state).toBe('PENDING');
    expect(result.nextCursor).toBe('next-page');
    expect(calls).toEqual([{
      url: 'https://connector.internal/internal/admin/connector-revisions/catalog?tenantId=00000000-0000-0000-0000-000000000001&limit=25&q=codex&cursor=page-cursor',
      authorization: 'Bearer signed-management-identity',
    }]);
  });

  it('fails closed on cross-tenant, secret-bearing, over-limit pages, or an unsupported old endpoint', async () => {
    const responses = [
      page({ items: [{ ...page().items[0], tenantId: '22222222-2222-4222-8222-222222222222' }] }),
      page({ items: [{ ...page().items[0], endpointUrl: 'https://secret.example/token' }] }),
      page({ items: [...page().items, { ...page().items[0], connectorId: 'another-recipe' }], limit: 1 }),
    ];
    for (const invalid of responses) {
      const store = createConnectorManagementStore({
        baseUrlFor: () => 'https://connector.internal',
        authorizationForRequest: () => 'Bearer signed-management-identity',
        fetchImpl: async () => new Response(JSON.stringify(invalid), { status: 200 }),
      });
      await expect(store.listConnectorRecipeCatalog({ tenantId: TENANT, limit: invalid.limit as number })).rejects.toMatchObject({
        status: 502,
        code: 'CONNECTOR_API_ERROR',
      });
    }

    const oldEndpoint = createConnectorManagementStore({
      baseUrlFor: () => 'https://connector.internal',
      authorizationForRequest: () => 'Bearer signed-management-identity',
      fetchImpl: async () => new Response(JSON.stringify({ error: 'not found' }), { status: 404 }),
    });
    await expect(oldEndpoint.listConnectorRecipeCatalog({ tenantId: TENANT, limit: 25 })).rejects.toMatchObject({
      status: 502,
      code: 'CONNECTOR_API_ERROR',
    });
  });

  it('canonicalizes an uppercase exact-read tenant and rejects a response for a different tenant', async () => {
    const revision = {
      tenantId: CASED_TENANT,
      connectorId: 'codex-ui-check-20261014',
      revision: 1,
      state: 'PENDING',
      recipe: {
        adapter: 'json-http',
        method: 'POST',
        endpointUrl: 'https://provider.example.test/v1',
        auth: { kind: 'none' },
        headers: [],
        request: { promptField: 'prompt', fields: [] },
        response: { contentPath: 'content' },
        session: { capture: [], inject: [] },
        timeoutMs: 10_000,
        responseBytes: 65_536,
      },
      credentialRef: null,
      credentialVersion: null,
      expectedHeadRevision: 0,
    };
    let requestUrl = '';
    const store = createConnectorManagementStore({
      baseUrlFor: () => 'https://connector.internal',
      authorizationForRequest: () => 'Bearer signed-management-identity',
      fetchImpl: async (input) => {
        requestUrl = String(input);
        return new Response(JSON.stringify(revision), { status: 200 });
      },
    });
    const result = await store.getRecipeRevision({
      tenantId: CASED_TENANT.toUpperCase(),
      connectorId: revision.connectorId,
      revision: 1,
    });
    expect(requestUrl).toContain(`tenantId=${CASED_TENANT}`);
    expect(result?.tenantId).toBe(CASED_TENANT);

    const crossTenant = createConnectorManagementStore({
      baseUrlFor: () => 'https://connector.internal',
      authorizationForRequest: () => 'Bearer signed-management-identity',
      fetchImpl: async () => new Response(JSON.stringify({ ...revision, tenantId: '22222222-2222-4222-8222-222222222222' }), { status: 200 }),
    });
    await expect(crossTenant.getRecipeRevision({ tenantId: CASED_TENANT, connectorId: revision.connectorId, revision: 1 })).rejects.toMatchObject({
      status: 502,
      code: 'CONNECTOR_API_ERROR',
    });
  });
});
