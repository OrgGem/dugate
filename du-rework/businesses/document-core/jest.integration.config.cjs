/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/multi-container-e2e.integration.test.ts'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.integration.json' }],
  },
  moduleNameMapper: {
    '^@du/orchestrator$': '<rootDir>/../../orchestrator/services/orchestrator/dist/index.js',
    '^@du/connector$': '<rootDir>/../../orchestrator/services/connector/dist/index.js',
  },
};
