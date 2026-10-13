import { isActiveConnectorPin } from '../src/modules/profiles/connector-pin-validation';
import type { ConnectorManagementStore } from '../src/modules/connectors/connector-management-store';

const TENANT = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OTHER_TENANT = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PIN = { connectorId: 'provider-text', revision: 4 };

function connectorStore(overrides: {
  typed?: unknown;
  legacy?: unknown;
  typedError?: Error;
  shadowedByTypedChain?: boolean;
}) {
  return {
    getRecipeRevision: jest.fn(async () => {
      if (overrides.typedError) throw overrides.typedError;
      return overrides.typed;
    }),
    hasRecipeChain: jest.fn(async () => overrides.shadowedByTypedChain ?? false),
    getRevision: jest.fn(async () => overrides.legacy),
  } as unknown as Pick<ConnectorManagementStore, 'getRecipeRevision' | 'hasRecipeChain' | 'getRevision'>;
}

describe('Profile Connector pin validation across typed and legacy ledgers', () => {
  it('accepts an exact active typed revision without consulting the legacy ledger', async () => {
    const store = connectorStore({ typed: { ...PIN, tenantId: TENANT, state: 'ACTIVE' } });
    await expect(isActiveConnectorPin(store, TENANT, PIN)).resolves.toBe(true);
    expect(store.getRecipeRevision).toHaveBeenCalledWith({ tenantId: TENANT, ...PIN });
    expect(store.getRevision).not.toHaveBeenCalled();
  });

  it('does not let an inactive or cross-tenant typed row fall through to a legacy row', async () => {
    for (const typed of [
      { ...PIN, tenantId: TENANT, state: 'DISABLED' },
      { ...PIN, tenantId: OTHER_TENANT, state: 'ACTIVE' },
      { connectorId: 'different', revision: PIN.revision, tenantId: TENANT, state: 'ACTIVE' },
    ]) {
      const store = connectorStore({
        typed,
        legacy: { ...PIN, tenantId: TENANT, state: 'ACTIVE' },
      });
      await expect(isActiveConnectorPin(store, TENANT, PIN)).resolves.toBe(false);
      expect(store.getRevision).not.toHaveBeenCalled();
    }
  });

  it('uses legacy pins only after a typed NOT_FOUND and preserves global/tenant ownership rules', async () => {
    const global = connectorStore({ typed: undefined, legacy: { ...PIN, state: 'ACTIVE' } });
    await expect(isActiveConnectorPin(global, TENANT, PIN)).resolves.toBe(true);
    expect(global.getRevision).toHaveBeenCalledWith(PIN.connectorId, PIN.revision);

    const tenantOwned = connectorStore({ typed: undefined, legacy: { ...PIN, tenantId: TENANT, state: 'ACTIVE' } });
    await expect(isActiveConnectorPin(tenantOwned, TENANT, PIN)).resolves.toBe(true);

    const foreign = connectorStore({ typed: undefined, legacy: { ...PIN, tenantId: OTHER_TENANT, state: 'ACTIVE' } });
    await expect(isActiveConnectorPin(foreign, TENANT, PIN)).resolves.toBe(false);
  });

  it('rejects an otherwise-active legacy revision when the typed chain shadows its connector ID', async () => {
    const shadowed = connectorStore({
      typed: undefined,
      shadowedByTypedChain: true,
      legacy: { ...PIN, tenantId: TENANT, state: 'ACTIVE' },
    });
    await expect(isActiveConnectorPin(shadowed, TENANT, PIN)).resolves.toBe(false);
    expect(shadowed.hasRecipeChain).toHaveBeenCalledWith({ tenantId: TENANT, connectorId: PIN.connectorId });
    expect(shadowed.getRevision).not.toHaveBeenCalled();
  });

  it('propagates typed authorization/transport failures instead of hiding them with a legacy row', async () => {
    const unavailable = new Error('typed Connector authorization failed');
    const store = connectorStore({
      typedError: unavailable,
      legacy: { ...PIN, tenantId: TENANT, state: 'ACTIVE' },
    });
    await expect(isActiveConnectorPin(store, TENANT, PIN)).rejects.toBe(unavailable);
    expect(store.getRevision).not.toHaveBeenCalled();
  });
});
