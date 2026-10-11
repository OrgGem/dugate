/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // GROUP A: pin NODE_ENV=test for the whole service so an inherited shell
  // NODE_ENV=production cannot reach production-only guards. jest.unit.config.cjs
  // spreads this config, so it inherits setupFiles without its own edit.
  setupFiles: ['<rootDir>/tests/setup-node-env.cjs'],
  // DU_VAULT_MOCK=true boots the in-process mock Vault from tests/mock-vault and
  // points DU_VAULT_KV_OPTIONS / DU_VAULT_TRANSIT_OPTIONS at it instead of a live
  // Vault. Unset or false is a no-op: no suite sees any difference.
  globalSetup: '<rootDir>/tests/mock-vault/jest-global-setup.cjs',
  globalTeardown: '<rootDir>/tests/mock-vault/jest-global-teardown.cjs',
  testTimeout: 120000,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }]
  }
};
