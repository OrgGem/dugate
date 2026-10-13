/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: [
    '**/all-variants-e2e.test.ts',
    '**/bounded-input.test.ts',
    '**/build-dependency-order.test.ts',
    '**/bullmq-smoke.test.ts',
    '**/corpus-regression.test.ts',
    '**/ingest-scan-fixtures.test.ts',
    '**/ingest-wire.test.ts',
    '**/ingest.test.ts',
    '**/multi-container-e2e.integration.test.ts',
    '**/orv14-worker-private-https-owner.test.ts',
    '**/p8-03-provider-convergence.test.ts',
    '**/r1-e-sdk-metadata-adapter.test.ts',
    '**/r1-e-trusted-format-propagation.test.ts',
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.monorepo.json' }],
  },
  moduleNameMapper: {
    '^@du/worker-sdk$': '<rootDir>/vendor/worker-sdk/dist/index.js',
    '^@du/document-kit$': '<rootDir>/vendor/document-kit/dist/index.js',
    '^@du/contracts$': '<rootDir>/vendor/contracts/dist/index.js',
    '^@du/egress$': '<rootDir>/vendor/egress/dist/index.js',
    '^@du/observability$': '<rootDir>/vendor/observability/dist/index.js',
    '^@du/orchestrator$': '<rootDir>/../../orchestrator/services/orchestrator/dist/index.js',
    '^@du/connector$': '<rootDir>/../../orchestrator/services/connector/dist/index.js',
  },
};
