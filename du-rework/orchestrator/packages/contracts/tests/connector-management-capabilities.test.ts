import { ConnectorCapabilitiesSchema } from '../src/connector-management';

describe('ConnectorCapabilitiesSchema optional typed credential capabilities', () => {
  const legacyCapabilities = {
    management: true,
    credentialWorkflow: false,
    test: true,
    knownConnectorIds: ['provider-a'],
  };

  it('keeps older payloads valid while accepting the independently composed import capability', () => {
    expect(ConnectorCapabilitiesSchema.parse(legacyCapabilities)).toEqual(legacyCapabilities);
    expect(ConnectorCapabilitiesSchema.parse({ ...legacyCapabilities, secretCatalogImport: true })).toEqual({
      ...legacyCapabilities,
      secretCatalogImport: true,
    });
    expect(ConnectorCapabilitiesSchema.parse({ ...legacyCapabilities, typedCredentialStorage: true })).toEqual({
      ...legacyCapabilities,
      typedCredentialStorage: true,
    });
  });

  it('rejects non-boolean managed import capability values', () => {
    expect(ConnectorCapabilitiesSchema.safeParse({ ...legacyCapabilities, secretCatalogImport: 'enabled' }).success).toBe(false);
    expect(ConnectorCapabilitiesSchema.safeParse({ ...legacyCapabilities, typedCredentialStorage: 'enabled' }).success).toBe(false);
  });
});
