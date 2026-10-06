'use strict';

/**
 * PLAT-MIG-05 — scaffold the @du/* shim packages so the template boots on a
 * FRESH container / scratch directory after `npm install` (or `pnpm install`).
 *
 * Why this exists: tsconfig `compilerOptions.paths` only affects TYPE
 * resolution. `tsc` does NOT rewrite `require('@du/worker-sdk')` in the
 * emitted JS, so Node's CJS resolver looks for a real
 * `node_modules/@du/worker-sdk` and fails with MODULE_NOT_FOUND.
 *
 * These shims are tiny `package.json` files whose `main`/`types` point at
 * the COMPILED output under `dist/vendor/...`, so Node resolves them
 * without any source rewrite.
 *
 * Idempotent: safe to run any number of times. Also supports
 * `--check` (exit 1 if any shim is missing or stale) for CI.
 */

import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = resolve(here, '..');
const nodeModules = join(templateRoot, 'node_modules');

/** The five vendored packages and their compiled entry points. */
const SHIMS = [
  { name: '@du/contracts',    entry: 'vendor/contracts/src/index.js' },
  { name: '@du/document-kit', entry: 'vendor/document-kit/src/index.js' },
  { name: '@du/worker-sdk',   entry: 'vendor/worker-sdk/src/index.js' },
  { name: '@du/observability',entry: 'vendor/observability/src/index.js' },
  { name: '@du/egress',       entry: 'vendor/egress/src/index.js' },
];

/**
 * Depth from `node_modules/@du/<pkg>/` up to the template root.
 * `node_modules/@du/<pkg>` is 3 segments below the root, so `../../../`.
 */
const UP = '../../../dist/';

function shimBody(entry) {
  return JSON.stringify(
    {
      name: entry.name,
      version: '0.1.0',
      private: true,
      description: 'Vendored shim — points at the compiled template vendor output.',
      main: UP + entry.entry,
      types: UP + entry.entry,
    },
    null,
    2
  );
}

function ensureShim({ name, entry }) {
  const dir = join(nodeModules, ...name.split('/'));
  const file = join(dir, 'package.json');
  const body = shimBody({ name, entry });
  mkdirSync(dir, { recursive: true });
  const existed = existsSync(file);
  const changed = !existed || readFileSync(file, 'utf8') !== body;
  if (changed) writeFileSync(file, body);
  return { name, existed, changed };
}

const checkOnly = process.argv.includes('--check');
const results = SHIMS.map(ensureShim);

if (checkOnly) {
  const stale = results.filter((r) => !r.existed || r.changed);
  if (stale.length > 0) {
    console.error('scaffold-shims: ' + stale.length + ' shim(s) missing or stale:');
    for (const s of stale) console.error('  - ' + s.name);
    process.exit(1);
  }
  console.log('scaffold-shims: all ' + results.length + ' shims present and up to date');
  process.exit(0);
}

for (const r of results) {
  console.log('scaffold-shims: ' + (r.existed ? (r.changed ? 'updated' : 'ok') : 'created') + ' ' + r.name);
}

// Self-run when invoked directly (postinstall).
if (process.env.npm_lifecycle_event === 'postinstall' || process.argv[1] && process.argv[1].endsWith('scaffold-shims.mjs')) {
  // already ran above
}
