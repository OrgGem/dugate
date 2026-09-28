/** @type {import('jest').Config} */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // W-DOC-ISOLATE-1 (Reviewer Turn 50 Finding 4): the multi-container suite
  // needs live Orchestrator/Connector/Worker processes, so it is opt-in through
  // the test:integration scripts and never part of the offline default run.
  // Those scripts pass --testPathIgnorePatterns to re-select it explicitly.
  testPathIgnorePatterns: ['\\.integration\\.test\\.ts$'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleNameMapper: {
    '^@du/worker-sdk$': '<rootDir>/../../packages/worker-sdk/src/index.ts',
    '^@du/document-kit$': '<rootDir>/../../packages/document-kit/src/index.ts',
    '^@du/orchestrator$': '<rootDir>/../../services/orchestrator/dist/index.js',
    '^@du/connector$': '<rootDir>/../../services/connector/dist/index.js',
  },
};
