#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

// Find active env file: --env-file, .env.local, .env, or parent .env.orchestrator.local
let envFile = '.env.local';
const customEnvArg = process.argv.find((a) => a.startsWith('--env-file='));
if (customEnvArg) {
  envFile = customEnvArg.slice('--env-file='.length);
} else if (!fs.existsSync(path.join(ROOT, envFile))) {
  if (fs.existsSync(path.join(ROOT, '.env'))) {
    envFile = '.env';
  } else if (fs.existsSync(path.join(ROOT, '../.env.orchestrator.local'))) {
    envFile = '../.env.orchestrator.local';
  } else {
    // Generate .env.local if not present
    const { initLocalEnv } = require('./init-local.cjs');
    envFile = path.relative(ROOT, initLocalEnv());
  }
}

const resolvedEnvPath = path.resolve(ROOT, envFile);

const cliPath = path.join(ROOT, 'services/orchestrator/dist/migrate-cli.js');
if (!fs.existsSync(cliPath)) {
  console.log('\x1b[33m[migrate] services/orchestrator/dist/migrate-cli.js not found. Running build first...\x1b[0m');
  const buildResult = spawnSync(process.execPath, ['scripts/build.cjs'], {
    cwd: ROOT,
    stdio: 'inherit',
  });
  if (buildResult.status !== 0) {
    process.exit(buildResult.status || 1);
  }
}

console.log(`\x1b[34m[migrate] Running database migrations using ${envFile}...\x1b[0m`);

const result = spawnSync(process.execPath, [`--env-file=${resolvedEnvPath}`, cliPath, 'migrate'], {
  cwd: ROOT,
  stdio: 'inherit',
});

if (result.status === 0) {
  console.log('\x1b[32m[migrate] Migrations completed successfully!\x1b[0m\n');
} else {
  console.error('\x1b[31m[migrate] Migration failed. Check if PostgreSQL server is running and DATABASE_URL is correct.\x1b[0m');
  console.error('\x1b[33m[migrate] To start local PostgreSQL and Redis, run: pnpm run docker:up\x1b[0m\n');
  process.exit(result.status || 1);
}
