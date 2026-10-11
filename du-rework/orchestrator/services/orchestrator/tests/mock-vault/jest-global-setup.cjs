'use strict';

// Jest globalSetup: when DU_VAULT_MOCK=true, boot the in-process mock Vault
// before any suite runs and point the Orchestrator DU_VAULT_* seams at it.
// With the flag off or unset this is a no-op and no suite sees a difference.

const { applyMockVaultEnv } = require('./bootstrap.cjs');

module.exports = async function globalSetup() {
  const service = await applyMockVaultEnv(process.env);
  if (service === undefined) return;
  globalThis.__DU_MOCK_VAULT_SERVICE__ = service;
  process.stdout.write(
    '[mock-vault] DU_VAULT_MOCK=true - in-process mock Vault on ' + service.url + String.fromCharCode(10),
  );
};
