const base = require('./jest.config.cjs');

module.exports = {
  ...base,
  testPathIgnorePatterns: [
    '/node_modules/',
    'black-box-durable.test.ts',
    'durable-integration.test.ts',
  ],
  // This DB projection case is nested in an otherwise offline convergence suite.
  testNamePattern: '^(?!.*live usage_events projection).*',
};
