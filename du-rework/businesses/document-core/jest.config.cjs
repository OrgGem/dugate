/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // W-DOC-ISOLATE-1 (Reviewer Turn 50 Finding 4): the multi-container suite
  // needs live Orchestrator/Connector/Worker processes, so it is opt-in through
  // the test:integration scripts and never part of the offline default run.
  // These tests import Orchestrator/Connector source from the parent monorepo.
  // They remain available through the explicit integration/monorepo commands.
  testPathIgnorePatterns: [
    '\\.integration\\.test\\.ts$',
    '/tests/(all-variants-e2e|bounded-input|build-dependency-order|bullmq-smoke|corpus-regression|ingest-scan-fixtures|ingest-wire|ingest|multi-container-e2e.integration|orv14-worker-private-https-owner|p8-03-provider-convergence|r1-e-sdk-metadata-adapter|r1-e-trusted-format-propagation)\\.test\\.ts$',
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@du/worker-sdk$': '<rootDir>/vendor/worker-sdk/dist/index.js',
    '^@du/document-kit$': '<rootDir>/vendor/document-kit/dist/index.js',
    '^@du/contracts$': '<rootDir>/vendor/contracts/dist/index.js',
    '^@du/egress$': '<rootDir>/vendor/egress/dist/index.js',
    '^@du/observability$': '<rootDir>/vendor/observability/dist/index.js',
  },
};
