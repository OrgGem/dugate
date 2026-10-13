#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const BUILD_ORDER = [
  ['contracts', path.join(PROJECT_ROOT, 'vendor', 'contracts')],
  ['observability', path.join(PROJECT_ROOT, 'vendor', 'observability')],
  ['egress', path.join(PROJECT_ROOT, 'vendor', 'egress')],
  ['document-kit', path.join(PROJECT_ROOT, 'vendor', 'document-kit')],
  ['worker-sdk', path.join(PROJECT_ROOT, 'vendor', 'worker-sdk')],
  ['document-core', PROJECT_ROOT],
];

function buildPackage(name, packageRoot) {
  const compiler = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(compiler)) {
    throw new Error(`TypeScript is missing from ${path.join(PROJECT_ROOT, 'node_modules')}. Run pnpm install --frozen-lockfile in this directory.`);
  }
  const config = path.join(packageRoot, 'tsconfig.json');
  if (!fs.existsSync(config)) throw new Error(`Local TypeScript config is missing for ${name}: ${config}`);
  console.log(`[document-core] Building local ${name} source...`);
  const result = spawnSync(process.execPath, [compiler, '--project', config], {
    cwd: packageRoot,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${name} build failed with exit code ${result.status ?? 'unknown'}.`);
}

function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((arg) => arg !== '--dependencies-only');
  if (unknown.length) throw new Error(`Unknown build option: ${unknown[0]}`);
  const steps = args.includes('--dependencies-only') ? BUILD_ORDER.slice(0, -1) : BUILD_ORDER;
  for (const [name, packageRoot] of steps) buildPackage(name, packageRoot);
}

try {
  main();
} catch (error) {
  console.error(`[document-core] Build failed: ${error instanceof Error ? error.message : 'unknown error'}`);
  process.exitCode = 1;
}
