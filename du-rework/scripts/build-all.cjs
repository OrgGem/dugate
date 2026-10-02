#!/usr/bin/env node
/**
 * build-all.cjs — Topological Dependency-Ordered Build Script for du-rework
 *
 * Builds all 9 packages/services in explicit dependency order:
 *   1. @du/contracts
 *   2. @du/observability
 *   3. @du/egress
 *   4. @du/document-kit
 *   5. @du/worker-sdk
 *   6. @du/connector-client
 *   7. @du/connector
 *   8. @du/orchestrator
 *   9. @du/document-core
 *
 * Post-build: Copies SQL migration files for connector into dist.
 */

const path = require('node:path');
const fs = require('node:fs');
const { execSync } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');

const BUILD_ORDER = [
  { name: '@du/contracts', dir: 'packages/contracts', cmd: 'pnpm --filter @du/contracts build' },
  { name: '@du/observability', dir: 'packages/observability', cmd: 'pnpm --filter @du/observability build' },
  { name: '@du/egress', dir: 'packages/egress', cmd: 'pnpm --filter @du/egress build' },
  { name: '@du/document-kit', dir: 'packages/document-kit', cmd: 'pnpm --filter @du/document-kit build' },
  { name: '@du/worker-sdk', dir: 'packages/worker-sdk', cmd: 'pnpm --filter @du/worker-sdk build' },
  { name: '@du/connector-client', dir: 'packages/connector-client', cmd: 'pnpm --filter @du/connector-client build' },
  { name: '@du/connector', dir: 'services/connector', cmd: 'pnpm --filter @du/connector build' },
  { name: '@du/orchestrator', dir: 'services/orchestrator', cmd: 'pnpm --filter @du/orchestrator build' },
  { name: '@du/document-core', dir: 'businesses/document-core', cmd: 'pnpm --filter @du/document-core build' },
];

function log(msg, color = '\x1b[0m') {
  console.log(`${color}${msg}\x1b[0m`);
}

function copyConnectorMigrations() {
  const srcDir = path.join(WORKSPACE_ROOT, 'services/connector/src/db/migrations');
  const destDir = path.join(WORKSPACE_ROOT, 'services/connector/dist/db/migrations');

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
      execSync(pkg.cmd, {
        cwd: WORKSPACE_ROOT,
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
  log(`\nAll ${BUILD_ORDER.length} services & packages built successfully in ${totalElapsed}s!\n`, '\x1b[1m\x1b[32m');
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
