const path = require('node:path');

const suiteRoot = __dirname;
const repoRoot = path.resolve(suiteRoot, '../../..');
const connectorRoot = path.join(repoRoot, 'orchestrator/services/connector');
const tsJestPath = require.resolve('ts-jest', { paths: [connectorRoot] });

module.exports = {
  rootDir: repoRoot,
  roots: [suiteRoot],
  testEnvironment: 'node',
  testMatch: ['**/connector-boot-ack.integration.test.ts'],
  moduleNameMapper: {
    '^@du/contracts$': path.join(repoRoot, 'orchestrator/packages/contracts/dist/index.js'),
  },
  transform: {
    '^.+\\.tsx?$': [tsJestPath, {
      tsconfig: path.join(suiteRoot, 'tsconfig.connector-boot-ack.json'),
      diagnostics: true,
    }],
  },
  testTimeout: 90000,
  maxWorkers: 1,
};
