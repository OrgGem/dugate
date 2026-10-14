'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  collectBuildInputFiles,
  createBuildInputTracker,
  isBuildInputPath,
  isRelevantWatchEvent,
  isRootConfigWatchEvent,
} = require('../scripts/dev-source-watch.cjs');

function createWorkspace(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-dev-source-watch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.mkdirSync(path.join(root, 'packages/shared/src'), { recursive: true });
  fs.mkdirSync(path.join(root, 'services/api/src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), '{"name":"workspace"}\n');
  fs.writeFileSync(path.join(root, 'tsconfig.base.json'), '{"compilerOptions":{}}\n');
  fs.writeFileSync(path.join(root, 'packages/shared/package.json'), '{"name":"shared"}\n');
  fs.writeFileSync(path.join(root, 'packages/shared/src/index.ts'), 'export const value = 1;\n');
  fs.writeFileSync(path.join(root, 'services/api/tsconfig.json'), '{"extends":"../../tsconfig.base.json"}\n');
  fs.writeFileSync(path.join(root, 'services/api/src/index.ts'), 'export const api = true;\n');
  return root;
}

test('unknown and spurious watcher events require a fingerprint check and do not trigger rebuilds by themselves', (t) => {
  const root = createWorkspace(t);
  const tracker = createBuildInputTracker(root);

  assert.equal(isRelevantWatchEvent(null), true);
  assert.equal(isRelevantWatchEvent(undefined), true);
  assert.equal(isRelevantWatchEvent('services/api/src/index.ts'), true);
  assert.equal(isRelevantWatchEvent('services/api/dist/index.js'), false);
  assert.equal(isRootConfigWatchEvent(null), true);
  assert.equal(isRootConfigWatchEvent('tsconfig.base.json'), true);
  assert.equal(isRootConfigWatchEvent('package.json'), true);
  assert.equal(isRootConfigWatchEvent('README.md'), false);
  assert.equal(tracker.hasChanged(), false);

  fs.mkdirSync(path.join(root, 'services/api/dist'), { recursive: true });
  fs.mkdirSync(path.join(root, 'services/api/tests'), { recursive: true });
  fs.writeFileSync(path.join(root, 'services/api/dist/index.js'), 'generated output');
  fs.writeFileSync(path.join(root, 'services/api/tests/fixture.ts'), 'test fixture');
  fs.mkdirSync(path.join(root, 'services/api/.cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'services/api/.cache/dev-build-state.json'), '{"status":"ready"}');
  fs.mkdirSync(path.join(root, 'node_modules/.cache'), { recursive: true });
  fs.writeFileSync(path.join(root, 'node_modules/.cache/dev-build-state.json'), '{"status":"building"}');
  assert.equal(tracker.hasChanged(), false);
});

test('source edits, new and deleted source files, source paths named build or temp, and package or TypeScript config changes alter the fingerprint', (t) => {
  const root = createWorkspace(t);
  const tracker = createBuildInputTracker(root);
  const indexPath = path.join(root, 'services/api/src/index.ts');

  fs.writeFileSync(indexPath, 'export const api = false;\n');
  assert.equal(tracker.hasChanged(), true, 'an existing source edit must be detected');
  assert.equal(tracker.hasChanged(), false, 'the same edit must not be reported twice');

  const addedPath = path.join(root, 'services/api/src/new-handler.ts');
  fs.writeFileSync(addedPath, 'export const handler = true;\n');
  assert.equal(tracker.hasChanged(), true, 'a new source file must be detected');

  fs.rmSync(addedPath);
  assert.equal(tracker.hasChanged(), true, 'a deleted source file must be detected');

  fs.writeFileSync(path.join(root, 'packages/shared/package.json'), '{"name":"shared","version":"2"}\n');
  assert.equal(tracker.hasChanged(), true, 'a package manifest edit must be detected');

  fs.writeFileSync(path.join(root, 'tsconfig.base.json'), '{"compilerOptions":{"strict":true}}\n');
  assert.equal(tracker.hasChanged(), true, 'a TypeScript config edit must be detected');

  const legalSourcePaths = [
    'services/api/src/modules/build-state.ts',
    'services/api/src/build/helper.ts',
    'services/api/src/temp/helper.ts',
  ];
  for (const relativePath of legalSourcePaths) {
    const filePath = path.join(root, relativePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, 'export const tracked = true;\n');
    assert.equal(tracker.hasChanged(), true, `${relativePath} must be fingerprinted`);
  }

  assert.ok(collectBuildInputFiles(root).includes('services/api/src/index.ts'));
  assert.equal(isBuildInputPath('services/api/src/new-handler.ts'), true);
  assert.equal(isBuildInputPath('services/api/src/modules/build-state.ts'), true);
  assert.equal(isBuildInputPath('services/api/src/build/helper.ts'), true);
  assert.equal(isBuildInputPath('services/api/src/temp/helper.ts'), true);
  assert.equal(isBuildInputPath('services/api/dist/new-handler.js'), false);
  assert.equal(isBuildInputPath('services/api/tests/new-handler.test.ts'), false);
  assert.equal(isBuildInputPath('services/api/.cache/build-state.json'), false);
  assert.equal(isBuildInputPath('services/api/build/tsconfig.json'), false);
  assert.equal(isBuildInputPath('services/api/temp/package.json'), false);
});
