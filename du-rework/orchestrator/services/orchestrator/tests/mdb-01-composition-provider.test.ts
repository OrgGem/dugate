const composition = require('../src/app/bootstrap/create-app') as {
  registerLdb03ContextProvider: (
    env: Record<string, string | undefined>,
  ) => { modulePath: string; provider: Record<string, unknown> };
};

process.env.LDBA03_ADAPTER_LIBRARY = '1';
const adapterModule = require('../scripts/ldba-03-production-adapter.cjs') as {
  createAdapter: (options: Record<string, unknown>) => {
    context: { prepareConnector: (row: unknown, request: unknown) => Promise<unknown> };
  };
  loadContextProvider: (env: Record<string, string | undefined>) => Record<string, unknown>;
};

function fakePool() {
  return {
    async query() {
      return { rows: [] };
    },
    async end() {},
  };
}

describe('MDB-01 LDBA03 context provider composition', () => {
  test('composition registers the provider module that the adapter loads', async () => {
    const env: Record<string, string | undefined> = {};
    const registration = composition.registerLdb03ContextProvider(env);

    expect(env.LDBA03_CONTEXT_MODULE).toBe(registration.modulePath);
    expect(registration.provider.prepareConnector).toEqual(expect.any(Function));
    expect(adapterModule.loadContextProvider(env)).toBe(registration.provider);
    expect(adapterModule.loadContextProvider({})).toBe(registration.provider);

    const adapter = adapterModule.createAdapter({
      sourcePool: fakePool(),
      targetPool: fakePool(),
      env,
    });
    // MDB-POLICY-05: prepareConnector is no longer a fail-closed stub. An empty
    // row carries no connector identity, so the landed policy refuses the ROW
    // through the documented skip channel instead of refusing to be configured.
    await expect(adapter.context.prepareConnector({}, {})).resolves.toMatchObject({
      skipped: true,
      code: 'INVALID_SOURCE',
    });
  });

  test('an explicitly configured missing provider fails closed with a stable adapter error', () => {
    expect(() => adapterModule.createAdapter({
      sourcePool: fakePool(),
      targetPool: fakePool(),
      env: { LDBA03_CONTEXT_MODULE: 'scripts/mdb-01-provider-that-does-not-exist.cjs' },
    })).toThrow(expect.objectContaining({
      name: 'AdapterConfigurationError',
      code: 'CONTEXT_MODULE_LOAD_FAILED',
    }));
  });
});
