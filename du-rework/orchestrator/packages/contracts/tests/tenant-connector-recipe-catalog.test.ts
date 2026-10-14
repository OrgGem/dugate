import {
  TenantConnectorRecipeCatalogItemSchema,
  TenantConnectorRecipeCatalogPageSchema,
  TenantConnectorRecipeCatalogQuerySchema,
} from '../src/tenant-connectors';

const TENANT = '00000000-0000-0000-0000-000000000001';
const CASED_TENANT = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
const BASE_ITEM = {
  tenantId: TENANT,
  connectorId: 'codex-ui-check-20261014',
  revision: 1,
  state: 'PENDING',
  adapter: 'json-http',
  authKind: 'none',
  credentialConfigured: false,
};

describe('tenant typed Connector recipe catalog contract', () => {
  it('accepts the default tenant sentinel and exact persisted lifecycle states', () => {
    expect(TenantConnectorRecipeCatalogQuerySchema.parse({ tenantId: TENANT, limit: '25' })).toEqual({
      tenantId: TENANT,
      limit: 25,
    });
    expect(TenantConnectorRecipeCatalogQuerySchema.parse({ tenantId: CASED_TENANT.toUpperCase() }).tenantId).toBe(CASED_TENANT);
    for (const state of ['PENDING', 'ACTIVE', 'RETIRED']) {
      expect(TenantConnectorRecipeCatalogItemSchema.safeParse({ ...BASE_ITEM, state }).success).toBe(true);
    }
    expect(TenantConnectorRecipeCatalogPageSchema.safeParse({
      tenantId: TENANT,
      items: [BASE_ITEM],
      limit: 50,
      nextCursor: null,
    }).success).toBe(true);
    expect(TenantConnectorRecipeCatalogPageSchema.safeParse({
      tenantId: TENANT,
      items: [BASE_ITEM, { ...BASE_ITEM, connectorId: 'another-recipe' }],
      limit: 1,
      nextCursor: null,
    }).success).toBe(false);
    const caseNormalizedPage = TenantConnectorRecipeCatalogPageSchema.parse({
      tenantId: CASED_TENANT.toUpperCase(),
      items: [{ ...BASE_ITEM, tenantId: CASED_TENANT.toUpperCase() }],
      limit: 1,
      nextCursor: null,
    });
    expect(caseNormalizedPage.tenantId).toBe(CASED_TENANT);
    expect(caseNormalizedPage.items[0]?.tenantId).toBe(CASED_TENANT);
  });

  it('rejects malformed bounds, cross-tenant rows, unknown states, and recipe or credential fields', () => {
    expect(TenantConnectorRecipeCatalogQuerySchema.safeParse({ tenantId: `${TENANT}\n` }).success).toBe(false);
    expect(TenantConnectorRecipeCatalogQuerySchema.safeParse({ tenantId: TENANT, limit: 101 }).success).toBe(false);
    expect(TenantConnectorRecipeCatalogQuerySchema.safeParse({ tenantId: TENANT, cursor: '' }).success).toBe(false);
    expect(TenantConnectorRecipeCatalogItemSchema.safeParse({ ...BASE_ITEM, state: 'DISABLED' }).success).toBe(false);
    expect(TenantConnectorRecipeCatalogPageSchema.safeParse({
      tenantId: TENANT,
      items: [{ ...BASE_ITEM, tenantId: '22222222-2222-4222-8222-222222222222' }],
      limit: 50,
      nextCursor: null,
    }).success).toBe(false);
    expect(TenantConnectorRecipeCatalogItemSchema.safeParse({ ...BASE_ITEM, recipe: { endpointUrl: 'https://secret.invalid' } }).success).toBe(false);
    expect(TenantConnectorRecipeCatalogItemSchema.safeParse({ ...BASE_ITEM, credentialRef: 'secret-ref' }).success).toBe(false);
  });
});
