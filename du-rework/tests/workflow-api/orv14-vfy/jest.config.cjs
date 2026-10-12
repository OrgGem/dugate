const path = require('node:path');

const rootDir = path.resolve(__dirname, '../../..');
const orchestratorModules = path.join(rootDir, 'orchestrator/services/orchestrator/node_modules');

/** Independent ORV14 config pins the already-installed Orchestrator Jest and ts-jest packages. */
module.exports = {
  rootDir,
  testEnvironment: 'node',
  testMatch: ['<rootDir>/tests/workflow-api/orv14-vfy/**/*.test.ts'],
  testTimeout: 180000,
  maxWorkers: 1,
  transform: {
    '^.+\\.tsx?$': [path.join(orchestratorModules, 'ts-jest'), {
      tsconfig: {
        target: 'ES2022',
        module: 'commonjs',
        moduleResolution: 'node',
        strict: true,
        noUncheckedIndexedAccess: true,
        noImplicitOverride: true,
        noFallthroughCasesInSwitch: true,
        esModuleInterop: true,
        skipLibCheck: true,
        resolveJsonModule: true,
        baseUrl: path.join(rootDir, 'orchestrator'),
        paths: {
          '@du/contracts': ['packages/contracts/src/index.ts'],
          '@aws-sdk/client-s3': ['services/orchestrator/node_modules/@aws-sdk/client-s3'],
          'pg': ['services/orchestrator/node_modules/pg'],
        },
        types: ['node', 'jest'],
        typeRoots: [path.join(orchestratorModules, '@types')],
      },
    }],
  },
  moduleNameMapper: {
    '^@du/contracts$': '<rootDir>/orchestrator/packages/contracts/src/index.ts',
    '^@aws-sdk/client-s3$': '<rootDir>/orchestrator/services/orchestrator/node_modules/@aws-sdk/client-s3',
    '^pg$': '<rootDir>/orchestrator/services/orchestrator/node_modules/pg',
  },
};
