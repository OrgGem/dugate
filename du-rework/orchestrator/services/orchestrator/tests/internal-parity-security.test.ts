import type { RouteContext } from '../src/http/route-context';
import { handleInternalParityRoutes } from '../src/http/routes/internal-parity';
import { resolveAdminActionAuthAsync } from '../src/modules/admin-actions/rbac';

jest.mock('../src/modules/admin-actions/rbac', () => {
  const actual = jest.requireActual('../src/modules/admin-actions/rbac') as typeof import('../src/modules/admin-actions/rbac');
  return { ...actual, resolveAdminActionAuthAsync: jest.fn() };
});

const TENANT = '11111111-1111-4111-8111-111111111111';
const resolvedAuth = jest.mocked(resolveAdminActionAuthAsync);

function context(input: { pathname: string; method: string; body: unknown; store?: Record<string, jest.Mock> }): RouteContext {
  const db = { query: jest.fn(), tx: jest.fn() };
  return {
    ingressAudience: 'internal',
    method: input.method,
    pathname: input.pathname,
    searchParams: new URLSearchParams(`tenantId=${TENANT}`),
    headers: {},
    body: input.body,
    rawBody: Buffer.from(''),
    correlationId: 'parity-route-security-test',
    host: 'admin.internal.test',
    db,
    audit: { record: jest.fn() },
    connectorManagement: input.store,
    config: { adminSessionStore: {} },
  } as unknown as RouteContext;
}

const recipe = {
  adapter: 'json-http', method: 'POST', endpointUrl: 'https://provider.example.test/v1/generate',
  auth: { kind: 'none' }, headers: [],
  request: { promptField: 'prompt', fields: [] }, response: { contentPath: 'content' },
  session: { capture: [], inject: [] }, timeoutMs: 10_000, responseBytes: 65_536,
};

describe('internal parity mutation authority', () => {
  beforeEach(() => resolvedAuth.mockResolvedValue({
    kind: 'bearer', principal: { role: 'tenant_operator', tenantId: TENANT },
  }));

  it('denies tenant_operator API-key issue before opening a mutation transaction', async () => {
    const ctx = context({ pathname: '/api/internal/parity/api-keys', method: 'POST', body: {
      note: 'tenant key', profileIds: [], idempotencyKey: 'parity-key-issue-0001',
    } });

    await expect(handleInternalParityRoutes(ctx)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(ctx.db.tx).not.toHaveBeenCalled();
  });

  it('denies tenant_operator Connector draft writes before the management store call', async () => {
    const store = { upsertRecipeDraft: jest.fn() };
    const ctx = context({ pathname: '/api/internal/parity/connectors/provider-a/draft', method: 'PUT', body: {
      tenantId: TENANT, expectedHeadRevision: 0, recipe, credentialChange: { action: 'keep' },
      idempotencyKey: 'parity-connector-draft-0001',
    }, store });

    await expect(handleInternalParityRoutes(ctx)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(store.upsertRecipeDraft).not.toHaveBeenCalled();
    expect(ctx.db.tx).not.toHaveBeenCalled();
  });
});
