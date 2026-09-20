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
    '^@du/worker-sdk$': '<rootDir>/../../packages/worker-sdk/src/index.ts',
    '^@du/document-kit$': '<rootDir>/../../packages/document-kit/src/index.ts',
  },
};
