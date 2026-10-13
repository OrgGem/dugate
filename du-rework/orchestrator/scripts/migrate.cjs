#!/usr/bin/env node
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const { resolveLocalPath } = require('./local-paths.cjs');

const ROOT = path.resolve(__dirname, '..');

const rawArgs = process.argv.slice(2);
const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
for (const arg of args) {
  if (!arg.startsWith('--env-file=')) throw new Error(`Unknown migrate option: ${arg}`);
}
const customEnvArg = args.find((arg) => arg.startsWith('--env-file='));
const envFile = customEnvArg?.slice('--env-file='.length)
  ?? (fs.existsSync(path.join(ROOT, '.env.local')) ? '.env.local' : '.env');
const resolvedEnvPath = resolveLocalPath(ROOT, envFile, '--env-file');

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

console.log(`\x1b[34m[migrate] Running database migrations using ${path.relative(ROOT, resolvedEnvPath)}...\x1b[0m`);

const result = spawnSync(process.execPath, [`--env-file=${resolvedEnvPath}`, cliPath, 'migrate'], {
  cwd: ROOT,
  stdio: 'inherit',
});

if (result.status === 0) {
  console.log('\x1b[32m[migrate] Migrations completed successfully!\x1b[0m\n');
} else {
  console.error('\x1b[31m[migrate] Migration failed. Verify the externally managed PostgreSQL service and DATABASE_URL. This command does not start or manage databases.\x1b[0m\n');
  process.exit(result.status || 1);
}
