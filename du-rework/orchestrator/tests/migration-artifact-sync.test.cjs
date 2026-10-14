'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { copyConnectorMigrations } = require('../scripts/build.cjs');
const { migrationCliNeedsBuild, migrationSqlIsStale } = require('../scripts/migrate.cjs');

function createRoot(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestrator-migration-artifacts-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function writeFile(root, relativePath, content, mtime = Date.now()) {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
  fs.utimesSync(filePath, mtime / 1000, mtime / 1000);
  return filePath;
}

function createFreshCliPairs(root) {
  const pairs = [
    ['services/orchestrator/src/db/migrations.ts', 'services/orchestrator/dist/db/migrations.js'],
    ['services/orchestrator/src/db/db.ts', 'services/orchestrator/dist/db/db.js'],
    ['services/orchestrator/src/migrate-cli.ts', 'services/orchestrator/dist/migrate-cli.js'],
    ['services/connector/src/db/migration-runner.ts', 'services/connector/dist/db/migration-runner.js'],
    ['services/connector/src/db/pg-client.ts', 'services/connector/dist/db/pg-client.js'],
    ['services/connector/src/migrate-cli.ts', 'services/connector/dist/migrate-cli.js'],
  ];
  const sourceTime = Date.now() - 20_000;
  const artifactTime = Date.now() - 10_000;
  for (const [source, artifact] of pairs) {
    writeFile(root, source, 'source', sourceTime);
    writeFile(root, artifact, 'artifact', artifactTime);
  }
}

test('Connector build mirrors SQL files and preserves other destination entries', (t) => {
  const root = createRoot(t);
  writeFile(root, 'services/connector/src/db/migrations/001_current.sql', 'SELECT 1;\r\n');
  writeFile(root, 'services/connector/dist/db/migrations/001_current.sql', 'SELECT 0;\n');
  writeFile(root, 'services/connector/dist/db/migrations/000_removed.sql', 'SELECT 9;\n');
  writeFile(root, 'services/connector/dist/db/migrations/README.txt', 'keep this file');
  fs.mkdirSync(path.join(root, 'services/connector/dist/db/migrations/nested.sql'));

  copyConnectorMigrations(root, () => {});

  assert.equal(
    fs.readFileSync(path.join(root, 'services/connector/dist/db/migrations/001_current.sql'), 'utf8'),
    'SELECT 1;\r\n',
  );
  assert.equal(fs.existsSync(path.join(root, 'services/connector/dist/db/migrations/000_removed.sql')), false);
  assert.equal(fs.readFileSync(path.join(root, 'services/connector/dist/db/migrations/README.txt'), 'utf8'), 'keep this file');
  assert.equal(fs.statSync(path.join(root, 'services/connector/dist/db/migrations/nested.sql')).isDirectory(), true);
});

test('migration SQL freshness compares complete names and normalized file contents', (t) => {
  const root = createRoot(t);
  const sourceDir = path.join(root, 'source');
  const artifactDir = path.join(root, 'artifact');
  const sourceTime = Date.now() - 20_000;
  const artifactTime = Date.now() - 10_000;
  writeFile(root, 'source/001_current.sql', 'SELECT 1;\r\n', sourceTime);
  writeFile(root, 'artifact/001_current.sql', 'SELECT 1;\n', artifactTime);

  assert.equal(migrationSqlIsStale(sourceDir, artifactDir), false);

  writeFile(root, 'artifact/001_current.sql', 'SELECT 1;\r', artifactTime);
  assert.equal(migrationSqlIsStale(sourceDir, artifactDir), true);

  writeFile(root, 'artifact/001_current.sql', 'SELECT 0;\n', artifactTime);
  assert.equal(migrationSqlIsStale(sourceDir, artifactDir), true);

  fs.unlinkSync(path.join(artifactDir, '001_current.sql'));
  writeFile(root, 'artifact/000_old.sql', 'SELECT 1;\n', artifactTime);
  assert.equal(migrationSqlIsStale(sourceDir, artifactDir), true);
});

test('migration wrapper rebuild decision catches SQL content and name drift independent of mtimes', (t) => {
  const root = createRoot(t);
  createFreshCliPairs(root);
  writeFile(root, 'services/connector/src/db/migrations/001_current.sql', 'SELECT 2;\n', Date.now() - 20_000);
  writeFile(root, 'services/connector/dist/db/migrations/001_current.sql', 'SELECT 1;\n', Date.now() - 10_000);
  assert.equal(migrationCliNeedsBuild(root), true);

  fs.writeFileSync(path.join(root, 'services/connector/src/db/migrations/001_current.sql'), 'SELECT 1;\n');
  fs.writeFileSync(path.join(root, 'services/connector/dist/db/migrations/001_current.sql'), 'SELECT 1;\n');
  fs.utimesSync(path.join(root, 'services/connector/src/db/migrations/001_current.sql'), Date.now() / 1000, Date.now() / 1000);
  fs.utimesSync(path.join(root, 'services/connector/dist/db/migrations/001_current.sql'), (Date.now() - 10_000) / 1000, (Date.now() - 10_000) / 1000);
  fs.unlinkSync(path.join(root, 'services/connector/src/db/migrations/001_current.sql'));
  writeFile(root, 'services/connector/src/db/migrations/002_renamed.sql', 'SELECT 1;\n', Date.now() - 20_000);
  assert.equal(migrationCliNeedsBuild(root), true);
});

test('migration wrapper ignores pnpm separators before rejecting unsupported options', () => {
  const root = path.join(__dirname, '..');
  const cli = path.join(root, 'scripts', 'migrate.cjs');
  const result = spawnSync(process.execPath, [cli, 'status', '--', '--unsupported'], {
    cwd: root,
    encoding: 'utf8',
  });

  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown migrate option: --unsupported/);
  assert.doesNotMatch(result.stderr, /Unknown migrate option: --(?:\r?\n|$)/);
});
