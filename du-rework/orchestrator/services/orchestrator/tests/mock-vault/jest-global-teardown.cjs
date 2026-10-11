'use strict';

// Pairs with globalSetup: stop the mock Vault the suite started, if any.

module.exports = async function globalTeardown() {
  const service = globalThis.__DU_MOCK_VAULT_SERVICE__;
  delete globalThis.__DU_MOCK_VAULT_SERVICE__;
  if (service !== undefined) await service.stop();
};
