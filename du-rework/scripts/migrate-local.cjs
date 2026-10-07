#!/usr/bin/env node
/**
 * migrate-local.cjs — Database Migration Runner for Local Development
 *
 * Runs database migrations for the Orchestrator service.
 */

const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const WORKSPACE_ROOT = path.resolve(__dirname, '..');

// Find active env file (--env-file preferred, then .env.local, then .env)
let envFile = '.env.local';
const customEnvArg = process.argv.find((a) => a.startsWith('--env-file='));
if (customEnvArg) {
  envFile = customEnvArg.slice('--env-file='.length);
} else if (!fs.existsSync(path.join(WORKSPACE_ROOT, envFile))) {
  if (fs.existsSync(path.join(WORKSPACE_ROOT, '.env'))) {
    envFile = '.env';
  } else {
    console.error('\x1b[31mError: No .env.local or .env file found in du-rework directory!\x1b[0m');
    console.error('Please copy .env.local.sample to .env.local and configure your DATABASE_URL.');
    process.exit(1);
  }
}

const cliPath = path.join(WORKSPACE_ROOT, 'orchestrator/services/orchestrator/dist/migrate-cli.js');
if (!fs.existsSync(cliPath)) {
  console.error('\x1b[33mWarning: orchestrator/services/orchestrator/dist/migrate-cli.js not found. Running build first...\x1b[0m');
  const buildResult = spawnSync(process.execPath, ['scripts/build-all.cjs'], {
    cwd: WORKSPACE_ROOT,
    stdio: 'inherit',
  });
  if (buildResult.status !== 0) {
    process.exit(buildResult.status || 1);
  }
}

console.log(`\x1b[34m[Migration] Running Orchestrator database migrations using ${envFile}...\x1b[0m`);

const result = spawnSync(process.execPath, [`--env-file=${envFile}`, 'orchestrator/services/orchestrator/dist/migrate-cli.js', 'migrate'], {
  cwd: WORKSPACE_ROOT,
  stdio: 'inherit',
});

if (result.status === 0) {
  console.log('\x1b[32m[Migration] Orchestrator database migrations completed successfully!\x1b[0m\n');
} else {
  console.error('\x1b[31m[Migration] Migration failed. Check if PostgreSQL server is running and DATABASE_URL is correct.\x1b[0m\n');
  process.exit(result.status || 1);
}
