const path = require('node:path');

const duReworkRoot = path.resolve(__dirname, '../..');

/** @type {import('jest').Config} */
module.exports = {
  rootDir: duReworkRoot,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/workflow-api/**/*.test.ts'],
  testTimeout: 180000,
  maxWorkers: 1,
  transform: {
    '^.+\\.tsx?$': ['ts-jest', {
      tsconfig: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: true,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        types: ['node', 'jest'],
      },
    }],
  },
  moduleNameMapper: {
    '^@du/contracts$': '<rootDir>/orchestrator/packages/contracts/src/index.ts',
  },
};
