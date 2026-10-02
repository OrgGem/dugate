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
    '^@du/contracts$': '<rootDir>/../../packages/contracts/dist/index.js',
    '^@du/document-kit$': '<rootDir>/../../packages/document-kit/src/index.ts',
    '^@du/worker-sdk$': '<rootDir>/../../packages/worker-sdk/dist/index.js',
    '^@du/orchestrator$': '<rootDir>/../../services/orchestrator/dist/index.js',
  },
};
