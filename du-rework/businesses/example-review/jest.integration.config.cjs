/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.integration.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', {
      tsconfig: '<rootDir>/tsconfig.test.json',
      diagnostics: false,
    }],
  },
  moduleNameMapper: {
    '^@du/contracts$': '<rootDir>/vendor/contracts/src/index.ts',
    '^@du/document-kit$': '<rootDir>/vendor/document-kit/src/index.ts',
    '^@du/egress$': '<rootDir>/vendor/egress/src/index.ts',
    '^@du/observability$': '<rootDir>/vendor/observability/src/index.ts',
    '^@du/worker-sdk$': '<rootDir>/vendor/worker-sdk/src/index.ts',
    '^@du/orchestrator$': '<rootDir>/../../orchestrator/services/orchestrator/dist/index.js',
  },
};
