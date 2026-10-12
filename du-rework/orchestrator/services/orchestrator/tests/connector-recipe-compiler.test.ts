import { compileConnectorRecipeOverrides, compileConnectorRecipePins } from '../src/modules/connectors/recipe-compiler';
import type { ConnectorRecipe } from '@du/contracts';

const recipe: ConnectorRecipe = {
  adapter: 'json-http',
  method: 'POST',
  endpointUrl: 'https://provider.example.test/v1/generate',
  auth: { kind: 'bearer', secretSlot: 'provider-token' },
  headers: [{ name: 'x-request-source', value: 'workflow' }],
  request: {
    promptField: 'prompt',
    fields: [
      { name: 'account_mode', source: 'static', value: 'standard' },
      { name: 'x-request-source', source: 'input' },
    ],
  },
  response: { contentPath: 'result.text' },
  session: { capture: [], inject: [] },
  timeoutMs: 20_000,
  responseBytes: 262_144,
};

describe('immutable Connector workflow recipe compiler', () => {
  it('pins declared bounded static fields and headers to the exact tenant-owned revision', () => {
    const pins = compileConnectorRecipePins({ tenantId: 'tenant-a', nodes: [{
      nodeId: 'provider_step', tenantId: 'tenant-a', revisionTenantId: 'tenant-a', connectorId: 'provider-a', connectorRevision: 7,
      recipe, staticFormFields: [{ name: 'account_mode', value: 'standard' }], extraHeaders: [{ name: 'x-request-source', value: 'workflow' }],
    }] });
    expect(pins['provider_step']).toMatchObject({
      connectorId: 'provider-a', connectorRevision: 7,
      staticFormFields: [{ name: 'account_mode', value: 'standard' }],
      extraHeaders: [{ name: 'x-request-source', value: 'workflow' }],
    });
    expect(pins['provider_step']?.recipeDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(JSON.stringify(pins)).not.toContain('provider-token');
  });

  it('rejects foreign tenant revisions and unpinned static fields', () => {
    expect(() => compileConnectorRecipeOverrides({ tenantId: 'tenant-a', revisionTenantId: 'tenant-b', connectorId: 'provider-a', connectorRevision: 7, recipe }))
      .toThrow(/tenant-authorized Connector recipe revision/);
    expect(() => compileConnectorRecipeOverrides({ tenantId: 'tenant-a', revisionTenantId: 'tenant-a', connectorId: 'provider-a', connectorRevision: 7, recipe,
      staticFormFields: [{ name: 'unlisted', value: 'value' }] }))
      .toThrow(/static workflow field is not declared/);
  });

  it('rejects credential-bearing or undeclared override headers', () => {
    expect(() => compileConnectorRecipeOverrides({ tenantId: 'tenant-a', revisionTenantId: 'tenant-a', connectorId: 'provider-a', connectorRevision: 7, recipe,
      extraHeaders: [{ name: 'authorization', value: 'Bearer secret-value' }] }))
      .toThrow(/workflow header is not declared|credential or protected header/);
    expect(() => compileConnectorRecipeOverrides({ tenantId: 'tenant-a', revisionTenantId: 'tenant-a', connectorId: 'provider-a', connectorRevision: 7, recipe,
      extraHeaders: [{ name: 'x-other', value: 'safe' }] }))
      .toThrow(/workflow header is not declared/);
    expect(() => compileConnectorRecipeOverrides({ tenantId: 'tenant-a', revisionTenantId: 'tenant-a', connectorId: 'provider-a', connectorRevision: 7, recipe,
      staticFormFields: [{ name: 'account_mode', value: 'Bearer secret-value' }] }))
      .toThrow(/outside the safe recipe value bounds/);
  });

  it('emits both required arrays even when a recipe has no overrides', () => {
    const pin = compileConnectorRecipeOverrides({ tenantId: 'tenant-a', revisionTenantId: 'tenant-a', connectorId: 'provider-a', connectorRevision: 7, recipe });
    expect(pin.staticFormFields).toEqual([]);
    expect(pin.extraHeaders).toEqual([]);
  });
});
