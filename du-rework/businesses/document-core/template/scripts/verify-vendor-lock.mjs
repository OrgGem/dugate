'use strict';

/**
 * PLAT-MIG-05 — verify the vendored tree against VENDOR-LOCK.json.
 *
 * Exits 1 (and prints every mismatch) when any vendored file's sha256 no
 * longer matches the lock, or when a file is present that the lock does
 * not know about. This is what makes the vendor pin enforceable rather
 * than decorative.
 */

import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs';
import { join, dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = resolve(here, '..');
const vendorRoot = join(templateRoot, 'vendor');
const lockPath = join(templateRoot, 'VENDOR-LOCK.json');

if (!existsSync(lockPath)) {
  console.error('verify-vendor-lock: VENDOR-LOCK.json is missing');
  process.exit(1);
}

const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
const problems = [];

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const actual = new Map();
for (const file of walk(vendorRoot)) {
  const rel = relative(vendorRoot, file).split('\\').join('/');
  actual.set(rel, createHash('sha256').update(readFileSync(file)).digest('hex'));
}

for (const [rel, entry] of Object.entries(lock.files)) {
  const got = actual.get(rel);
  if (got === undefined) {
    problems.push('MISSING  ' + rel);
  } else if (got !== entry.sha256) {
    problems.push('CHANGED  ' + rel + ' (lock ' + entry.sha256.slice(0, 12) + ' != actual ' + got.slice(0, 12) + ')');
  }
}

for (const rel of actual.keys()) {
  if (!lock.files[rel]) problems.push('UNLOCKED ' + rel);
}

if (process.env.VENDOR_BASE_COMMIT && lock.baseCommit !== process.env.VENDOR_BASE_COMMIT) {
  problems.push('BASE_COMMIT mismatch: lock=' + lock.baseCommit + ' env=' + process.env.VENDOR_BASE_COMMIT);
}

if (problems.length > 0) {
  console.error('verify-vendor-lock: ' + problems.length + ' problem(s):');
  for (const p of problems) console.error('  ' + p);
  process.exit(1);
}

console.log('verify-vendor-lock: ' + Object.keys(lock.files).length + ' vendored files match ' + lock.baseCommit);
