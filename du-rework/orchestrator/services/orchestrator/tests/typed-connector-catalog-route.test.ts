import type { RouteContext } from '../src/http/route-context';
import { handleInternalParityRoutes } from '../src/http/routes/internal-parity';
import { resolveAdminActionAuthAsync } from '../src/modules/admin-actions/rbac';

jest.mock('../src/modules/admin-actions/rbac', () => {
  const actual = jest.requireActual('../src/modules/admin-actions/rbac') as typeof import('../src/modules/admin-actions/rbac');
  return { ...actual, resolveAdminActionAuthAsync: jest.fn() };
});

const TENANT = '00000000-0000-0000-0000-000000000001';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const CASED_TENANT = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const resolvedAuth = jest.mocked(resolveAdminActionAuthAsync);

function context(input: { tenantId?: string; store?: Record<string, jest.Mock>; pathname?: string; search?: string }): RouteContext {
  return {
    ingressAudience: 'internal',
    method: 'GET',
    pathname: input.pathname ?? '/api/internal/parity/typed-connector-recipes',
    searchParams: new URLSearchParams(input.search ?? [
      ...(input.tenantId === undefined ? [] : [['tenantId', input.tenantId] as [string, string]]),
      ['q', 'codex'],
      ['limit', '25'],
      ['cursor', 'typed-cursor'],
    ]),
    headers: {},
    body: undefined,
    rawBody: Buffer.from(''),
    correlationId: 'typed-connector-catalog-route-test',
    host: 'admin.internal.test',
    db: { query: jest.fn(), tx: jest.fn() },
    audit: { record: jest.fn() },
    connectorManagement: input.store,
    config: { adminSessionStore: {} },
  } as unknown as RouteContext;
}

const safePage = {
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
};

describe('internal tenant typed Connector catalog route', () => {
  beforeEach(() => resolvedAuth.mockResolvedValue({
    kind: 'bearer',
    principal: { role: 'platform' },
  }));

  it('forwards a canonical default-tenant query and returns the validated PENDING page', async () => {
    const store = { listConnectorRecipeCatalog: jest.fn().mockResolvedValue(safePage) };
    const ctx = context({ tenantId: TENANT, store });
    await expect(handleInternalParityRoutes(ctx)).resolves.toEqual({ status: 200, body: safePage });
    expect(store.listConnectorRecipeCatalog).toHaveBeenCalledWith({
      tenantId: TENANT,
      q: 'codex',
      limit: 25,
      cursor: 'typed-cursor',
    });
  });

  it('uses session tenant scope and denies a request for another tenant before the store call', async () => {
    resolvedAuth.mockResolvedValueOnce({
      kind: 'bearer',
      principal: { role: 'tenant_operator', tenantId: TENANT },
    });
    const store = { listConnectorRecipeCatalog: jest.fn().mockResolvedValue(safePage) };
    const ctx = context({ tenantId: OTHER_TENANT, store });
    await expect(handleInternalParityRoutes(ctx)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(store.listConnectorRecipeCatalog).not.toHaveBeenCalled();
  });

  it('uses a tenant operator session scope when no tenant query is provided', async () => {
    resolvedAuth.mockResolvedValueOnce({
      kind: 'bearer',
      principal: { role: 'tenant_operator', tenantId: TENANT },
    });
    const store = { listConnectorRecipeCatalog: jest.fn().mockResolvedValue(safePage) };
    await expect(handleInternalParityRoutes(context({ store }))).resolves.toMatchObject({ status: 200 });
    expect(store.listConnectorRecipeCatalog).toHaveBeenCalledWith({
      tenantId: TENANT,
      q: 'codex',
      limit: 25,
      cursor: 'typed-cursor',
    });
  });

  it('matches uppercase session tenant identity to the canonical typed catalog query', async () => {
    resolvedAuth.mockResolvedValueOnce({
      kind: 'bearer',
      principal: { role: 'tenant_operator', tenantId: CASED_TENANT.toUpperCase() },
    });
    const canonicalPage = {
      ...safePage,
      tenantId: CASED_TENANT,
      items: [{ ...safePage.items[0], tenantId: CASED_TENANT }],
    };
    const store = { listConnectorRecipeCatalog: jest.fn().mockResolvedValue(canonicalPage) };
    const ctx = context({ tenantId: CASED_TENANT, store });
    await expect(handleInternalParityRoutes(ctx)).resolves.toEqual({ status: 200, body: canonicalPage });
    expect(store.listConnectorRecipeCatalog).toHaveBeenCalledWith({
      tenantId: CASED_TENANT,
      q: 'codex',
      limit: 25,
      cursor: 'typed-cursor',
    });
  });

  it('allows an exact recipe read for equivalent uppercase UUIDs and rejects a genuinely different tenant', async () => {
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
    resolvedAuth.mockResolvedValueOnce({
      kind: 'bearer',
      principal: { role: 'tenant_operator', tenantId: CASED_TENANT.toUpperCase() },
    });
    const store = { getRecipeRevision: jest.fn().mockResolvedValue(revision) };
    const path = '/api/internal/parity/connectors/codex-ui-check-20261014/revisions/1';
    const positive = context({ pathname: path, search: `tenantId=${CASED_TENANT}`, store });
    await expect(handleInternalParityRoutes(positive)).resolves.toEqual({ status: 200, body: revision });
    expect(store.getRecipeRevision).toHaveBeenCalledWith({
      tenantId: CASED_TENANT,
      connectorId: 'codex-ui-check-20261014',
      revision: 1,
    });

    resolvedAuth.mockResolvedValueOnce({
      kind: 'bearer',
      principal: { role: 'tenant_operator', tenantId: CASED_TENANT.toUpperCase() },
    });
    const deniedStore = { getRecipeRevision: jest.fn().mockResolvedValue(revision) };
    const negative = context({ pathname: path, search: `tenantId=${OTHER_TENANT}`, store: deniedStore });
    await expect(handleInternalParityRoutes(negative)).rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
    expect(deniedStore.getRecipeRevision).not.toHaveBeenCalled();
  });

  it('normalizes equivalent uppercase tenant UUIDs on both query and response boundaries', async () => {
    const canonicalPage = {
      ...safePage,
      tenantId: CASED_TENANT,
      items: [{ ...safePage.items[0], tenantId: CASED_TENANT }],
    };
    const store = { listConnectorRecipeCatalog: jest.fn().mockResolvedValue(canonicalPage) };
    const ctx = context({ tenantId: CASED_TENANT.toUpperCase(), store });
    await expect(handleInternalParityRoutes(ctx)).resolves.toEqual({ status: 200, body: canonicalPage });
    expect(store.listConnectorRecipeCatalog).toHaveBeenCalledWith({
      tenantId: CASED_TENANT,
      q: 'codex',
      limit: 25,
      cursor: 'typed-cursor',
    });
  });

  it('fails closed on malformed cursors or an invalid management response', async () => {
    const malformed = context({ tenantId: TENANT, store: { listConnectorRecipeCatalog: jest.fn() } });
    malformed.searchParams.set('cursor', '');
    await expect(handleInternalParityRoutes(malformed)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(malformed.connectorManagement?.listConnectorRecipeCatalog).not.toHaveBeenCalled();

    const secretResponse = { ...safePage, items: [{ ...safePage.items[0], rawRecipe: { endpointUrl: 'https://secret.invalid' } }] };
    const store = { listConnectorRecipeCatalog: jest.fn().mockResolvedValue(secretResponse) };
    await expect(handleInternalParityRoutes(context({ tenantId: TENANT, store }))).rejects.toMatchObject({ status: 502, code: 'CONNECTOR_API_ERROR' });
  });
});
