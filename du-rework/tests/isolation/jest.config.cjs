/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  rootDir: '..',
  testMatch: [
    '<rootDir>/isolation/**/*.test.ts',
    '<rootDir>/stubs/**/*.test.ts',
  ],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/isolation/tsconfig.json' }],
  },
  testTimeout: 30000,
};
