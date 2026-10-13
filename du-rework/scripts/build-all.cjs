#!/usr/bin/env node
/**
 * build-all.cjs — Topological Dependency-Ordered Build Script for du-rework
 *
 * Builds canonical platform packages/services/Portal, then builds each
 * standalone worker from its own nested workspace and lockfile.
 *
 * Post-build: Copies SQL migration files for connector into dist.
 */

const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');

const BUILD_ORDER = [
  { name: '@du/contracts', dir: 'orchestrator/packages/contracts' },
  { name: '@du/observability', dir: 'orchestrator/packages/observability' },
  { name: '@du/egress', dir: 'orchestrator/packages/egress' },
  { name: '@du/document-kit', dir: 'orchestrator/packages/document-kit' },
  { name: '@du/worker-sdk', dir: 'orchestrator/packages/worker-sdk' },
  { name: '@du/connector-client', dir: 'orchestrator/packages/connector-client' },
  { name: '@du/connector', dir: 'orchestrator/services/connector' },
  { name: '@du/orchestrator', dir: 'orchestrator/services/orchestrator' },
  { name: '@du/admin-web', dir: 'orchestrator/apps/admin-web' },
];
const STANDALONE_WORKERS = ['document-core', 'lc-checker', 'example-review'];

function log(msg, color = '\x1b[0m') {
  console.log(`${color}${msg}\x1b[0m`);
}

function copyConnectorMigrations() {
  const srcDir = path.join(WORKSPACE_ROOT, 'orchestrator/services/connector/src/db/migrations');
  const destDir = path.join(WORKSPACE_ROOT, 'orchestrator/services/connector/dist/db/migrations');

  if (fs.existsSync(srcDir)) {
    fs.mkdirSync(destDir, { recursive: true });
    const sqlFiles = fs.readdirSync(srcDir).filter(f => f.endsWith('.sql'));
    for (const f of sqlFiles) {
      fs.copyFileSync(path.join(srcDir, f), path.join(destDir, f));
    }
    log(`  [post-build] Copied ${sqlFiles.length} migration SQL files to ${path.relative(WORKSPACE_ROOT, destDir)}`, '\x1b[36m');
  }
}

async function main() {
  const startTime = Date.now();
  log('\n======================================================', '\x1b[34m');
  log('   du-rework: Building all packages & services', '\x1b[1m\x1b[34m');
  log('======================================================\n', '\x1b[34m');

  for (let i = 0; i < BUILD_ORDER.length; i++) {
    const pkg = BUILD_ORDER[i];
    const step = `[${i + 1}/${BUILD_ORDER.length}]`;
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

  for (let i = 0; i < STANDALONE_WORKERS.length; i++) {
    const worker = STANDALONE_WORKERS[i];
    const workerRoot = path.join(WORKSPACE_ROOT, 'businesses', worker);
    for (const [actionIndex, [action, args]] of [['install', ['install', '--frozen-lockfile']], ['build', ['run', 'build']]].entries()) {
      const step = `[${BUILD_ORDER.length + i * 2 + actionIndex + 1}/${BUILD_ORDER.length + STANDALONE_WORKERS.length * 2}]`;
      process.stdout.write(`\x1b[33m${step} ${action === 'install' ? 'Installing' : 'Building'} standalone @du/${worker}...\x1b[0m `);
      const stepStart = Date.now();
      try {
        execSync(`pnpm ${args.join(' ')}`, {
          cwd: workerRoot,
          stdio: 'pipe',
          env: { ...process.env, FORCE_COLOR: '1' }
        });
        const elapsed = ((Date.now() - stepStart) / 1000).toFixed(1);
        log(`OK (${elapsed}s)`, '\x1b[32m');
      } catch (err) {
        log('FAILED!', '\x1b[31m');
        if (err.stdout) console.error(err.stdout.toString());
        if (err.stderr) console.error(err.stderr.toString());
        process.exit(1);
      }
    }
  }

  // Post-build assets copy
  copyConnectorMigrations();

  const totalElapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  log(`\nPlatform and standalone worker builds completed in ${totalElapsed}s.\n`, '\x1b[1m\x1b[32m');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
