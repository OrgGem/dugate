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
  testTimeout: 120000,
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }]
  }
};
