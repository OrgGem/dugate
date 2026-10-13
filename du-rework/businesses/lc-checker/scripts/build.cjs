#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const compiler = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');

try {
  if (!fs.existsSync(compiler)) {
    throw new Error(`TypeScript is missing from ${path.join(PROJECT_ROOT, 'node_modules')}. Run pnpm install --frozen-lockfile in this directory.`);
  }
  const result = spawnSync(process.execPath, [compiler, '--build', path.join(PROJECT_ROOT, 'tsconfig.json')], {
    cwd: PROJECT_ROOT,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Local TypeScript build failed with exit code ${result.status ?? 'unknown'}.`);
} catch (error) {
  console.error(`[lc-checker] Build failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
