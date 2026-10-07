#!/usr/bin/env node
// Deterministic offline smoke for the promoted Orchestrator boundary.
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const [major, minor] = process.versions.node.split('.').map(Number);
if (major !== 24 || minor < 21) {
  console.error('Use Node >=24.21.0 <25.');
  process.exit(1);
}
const suites = [
  ['orchestrator/packages/contracts', []],
  ['orchestrator/services/connector', ['--config', 'jest.unit.config.cjs', '--forceExit']],
  ['orchestrator/services/orchestrator', [
    'tests/tapi01-closure-offline.test.ts',
    'tests/wt04-profile-invalid-callback-read.test.ts',
    'tests/cb02b-profile-publish-callback.test.ts',
    'tests/cb02c-retry-callback-pin.test.ts',
    'tests/cb02-admission-writer.test.ts',
    'tests/pm-m02-ingress-fence.test.ts',
    'tests/plat-mig-01-boot.test.ts',
    'tests/plat-mig-02-probe-authorization.test.ts',
    'tests/connector-revision-http-offline.functional.test.ts',
    'tests/mock-vault-harness-offline.functional.test.ts',
  ]],
];
for (const [directory, options] of suites) {
  console.log(`Offline smoke: ${directory}`);
  const result = spawnSync(process.execPath,
    ['node_modules/jest/bin/jest.js', '--runInBand', ...options],
    { cwd: path.join(root, directory), stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
const portal = spawnSync(process.execPath,
  ['node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'],
  { cwd: path.join(root, 'orchestrator/apps/admin-web'), stdio: 'inherit' });
if (portal.error || portal.status !== 0) process.exit(portal.status || 1);
console.log('Offline smoke passed; live/browser and full-suite gates remain separate.');
