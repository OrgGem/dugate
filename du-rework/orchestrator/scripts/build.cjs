#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');

const BUILD_ORDER = [
  { name: '@du/contracts', dir: 'packages/contracts' },
  { name: '@du/observability', dir: 'packages/observability' },
  { name: '@du/egress', dir: 'packages/egress' },
  { name: '@du/document-kit', dir: 'packages/document-kit' },
  { name: '@du/worker-sdk', dir: 'packages/worker-sdk' },
  { name: '@du/connector-client', dir: 'packages/connector-client' },
  { name: '@du/connector', dir: 'services/connector' },
  { name: '@du/orchestrator', dir: 'services/orchestrator' },
  { name: '@du/admin-web', dir: 'apps/admin-web' },
];

function log(msg, color = '\x1b[0m') {
  console.log(`${color}${msg}\x1b[0m`);
}

function ensureProjectDirectory(root, segments) {
  let directory = path.resolve(root);
  const rootStat = fs.lstatSync(directory);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Refusing to copy Connector migrations from a non-directory project root.');
  }

  for (const segment of segments) {
    directory = path.join(directory, segment);
    let entry;
    try {
      entry = fs.lstatSync(directory);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      fs.mkdirSync(directory);
      entry = fs.lstatSync(directory);
    }
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      throw new Error(`Refusing to copy Connector migrations through a non-directory or symbolic link: ${directory}`);
    }
  }

  return directory;
}

function sqlFileNames(directory) {
  return fs.readdirSync(directory, { withFileTypes: true })
    .filter((entry) => entry.name.endsWith('.sql') && (entry.isFile() || entry.isSymbolicLink()))
    .map((entry) => entry.name)
    .sort();
}

function copyConnectorMigrations(workspaceRoot = WORKSPACE_ROOT, writeLog = log) {
  const srcDir = path.join(workspaceRoot, 'services/connector/src/db/migrations');
  if (!fs.existsSync(srcDir)) return;

  const destDir = ensureProjectDirectory(workspaceRoot, [
    'services', 'connector', 'dist', 'db', 'migrations',
  ]);
  const sqlFiles = sqlFileNames(srcDir);
  const sourceNames = new Set(sqlFiles);

  for (const entry of fs.readdirSync(destDir, { withFileTypes: true })) {
    if (!entry.name.endsWith('.sql') || sourceNames.has(entry.name)) continue;
    if (entry.isFile() || entry.isSymbolicLink()) {
      fs.unlinkSync(path.join(destDir, entry.name));
    }
  }

  for (const fileName of sqlFiles) {
    const destination = path.join(destDir, fileName);
    let existing;
    try {
      existing = fs.lstatSync(destination);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    if (existing?.isSymbolicLink()) fs.unlinkSync(destination);
    else if (existing && !existing.isFile()) {
      throw new Error(`Refusing to overwrite a non-file Connector migration artifact: ${destination}`);
    }
    fs.copyFileSync(path.join(srcDir, fileName), destination);
  }

  writeLog(`  [post-build] Mirrored ${sqlFiles.length} migration SQL files to ${path.relative(workspaceRoot, destDir)}`, '\x1b[36m');
}

async function main() {
  const backendOnly = process.argv.slice(2).includes('--backend-only');
  const buildOrder = backendOnly ? BUILD_ORDER.slice(0, -1) : BUILD_ORDER;
  const startTime = Date.now();
  log('\n======================================================', '\x1b[34m');
  log(backendOnly ? '   Orchestrator: Building runtime packages & services' : '   Orchestrator: Building all packages & services', '\x1b[1m\x1b[34m');
  log('======================================================\n', '\x1b[34m');

  for (let i = 0; i < buildOrder.length; i++) {
    const pkg = buildOrder[i];
    const step = `[${i + 1}/${buildOrder.length}]`;
    process.stdout.write(`\x1b[33m${step} Building ${pkg.name}...\x1b[0m `);

    const stepStart = Date.now();
    try {
      execSync('pnpm run build', {
        cwd: path.join(WORKSPACE_ROOT, pkg.dir),
        stdio: 'pipe',
        env: { ...process.env, FORCE_COLOR: '1' }
      });
      const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
      log(`OK (${elapsed}s)`, '\x1b[32m');
    } catch (err) {
      log(`FAILED!`, '\x1b[31m');
      if (err.stdout) console.error(err.stdout.toString());
      if (err.stderr) console.error(err.stderr.toString());
      process.exit(1);
    }
  }

  // Post-build assets copy
  copyConnectorMigrations();

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\nAll ${buildOrder.length} services & packages built successfully in ${totalElapsed}s!\n`, '\x1b[1m\x1b[32m');
}

module.exports = { copyConnectorMigrations };

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}
