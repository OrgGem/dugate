import { CORE_ENDPOINTS } from '../src/modules/settings/endpoints';
import { CORE_ENDPOINT_OPTIONS, isCoreEndpointSlug } from '../../../apps/admin-web/src/features/settings/endpoints';
import { isLegacyConnectionId, settingsResponseMatchesScope, settingsScopeKey, type SettingsScope } from '../../../apps/admin-web/src/features/settings/scope';
import { EFFECTIVE_STORAGE_FIELDS, safeStorageValue } from '../../../apps/admin-web/src/features/settings/safe-display';

describe('UI13 settings scope and endpoint contract', () => {
  it('offers exactly the backend-supported core endpoint set', () => {
    expect(CORE_ENDPOINT_OPTIONS).toHaveLength(31);
    expect(new Set(CORE_ENDPOINT_OPTIONS).size).toBe(31);
    expect(new Set(CORE_ENDPOINT_OPTIONS)).toEqual(CORE_ENDPOINTS);
    for (const endpoint of CORE_ENDPOINTS) expect(isCoreEndpointSlug(endpoint)).toBe(true);
    expect(isCoreEndpointSlug('workflows:schema:invoice')).toBe(false);
    expect(isCoreEndpointSlug('extract:operator-input')).toBe(false);
  });

  it('keeps endpoint scope keys distinct across tenant, API key and endpoint changes', () => {
    const base: SettingsScope = { tenantId: 'tenant-a', apiKeyId: 'key-a', endpointSlug: 'extract:invoice' };
    expect(settingsScopeKey(base)).not.toBe(settingsScopeKey({ ...base, tenantId: 'tenant-b' }));
    expect(settingsScopeKey(base)).not.toBe(settingsScopeKey({ ...base, apiKeyId: 'key-b' }));
    expect(settingsScopeKey(base)).not.toBe(settingsScopeKey({ ...base, endpointSlug: 'extract:contract' }));
  });

  it('refuses settings responses echoed for a different tenant, key or endpoint', () => {
    const target: SettingsScope = { tenantId: 'tenant-a', apiKeyId: 'key-a', endpointSlug: 'extract:invoice' };
    const response = { scope: { tenantId: 'tenant-a', apiKeyId: 'key-a', endpointSlug: 'extract:invoice' } };
    expect(settingsResponseMatchesScope(response, target)).toBe(true);
    expect(settingsResponseMatchesScope({ scope: { ...response.scope, tenantId: 'tenant-b' } }, target)).toBe(false);
    expect(settingsResponseMatchesScope({ scope: { ...response.scope, apiKeyId: 'key-b' } }, target)).toBe(false);
    expect(settingsResponseMatchesScope({ scope: { ...response.scope, endpointSlug: 'extract:contract' } }, target)).toBe(false);
    expect(settingsResponseMatchesScope({}, target)).toBe(false);
    expect(settingsResponseMatchesScope(
      { scope: { tenantId: 'tenant-a', apiKeyId: null, endpointSlug: null } },
      { tenantId: 'tenant-a', apiKeyId: '', endpointSlug: '' },
    )).toBe(true);
  });

  it('accepts only UUID-shaped legacy prompt connection ids', () => {
    expect(isLegacyConnectionId('10000000-0000-4000-8000-000000000001')).toBe(true);
    expect(isLegacyConnectionId('--------------------0000000000000000')).toBe(false);
    expect(isLegacyConnectionId('connector-primary')).toBe(false);
  });

  it('limits effective storage diagnostics to public fields and strips URL credentials/query data', () => {
    expect(EFFECTIVE_STORAGE_FIELDS).toEqual(['backend', 'bucket', 'region', 'endpoint']);
    expect(safeStorageValue('endpoint', 'https://user:password@example.test/artifacts?token=private#section')).toBe('https://example.test/artifacts');
    expect(safeStorageValue('endpoint', 'not a url with credentials')).toBe('Endpoint unavailable');
  });
});
