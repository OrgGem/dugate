/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@du/contracts$': '<rootDir>/../../orchestrator/packages/contracts/dist/index.js',
    '^@du/document-kit$': '<rootDir>/../../orchestrator/packages/document-kit/src/index.ts',
    '^@du/worker-sdk$': '<rootDir>/../../orchestrator/packages/worker-sdk/dist/index.js',
    '^@du/orchestrator$': '<rootDir>/../../orchestrator/services/orchestrator/dist/index.js',
  },
};
