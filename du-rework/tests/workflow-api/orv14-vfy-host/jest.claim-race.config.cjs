const path = require('node:path');

const suiteRoot = __dirname;
const repoRoot = path.resolve(suiteRoot, '../../..');
const orchestratorRoot = path.join(repoRoot, 'orchestrator/services/orchestrator');
const tsJestPath = require.resolve('ts-jest', { paths: [orchestratorRoot] });

module.exports = {
  rootDir: repoRoot,
  roots: [path.join(suiteRoot)],
  testEnvironment: 'node',
  testMatch: ['**/host-claim-interleaving.test.ts'],
  transform: {
    '^.+\\.tsx?$': [tsJestPath, {
      tsconfig: path.join(suiteRoot, 'tsconfig.claim-race.json'),
      diagnostics: true,
    }],
  },
  testTimeout: 90000,
  maxWorkers: 1,
};
