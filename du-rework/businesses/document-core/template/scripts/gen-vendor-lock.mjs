'use strict';

import { createHash } from 'node:crypto';
import { readdirSync, statSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = resolve(here, '..');
const vendorRoot = join(templateRoot, 'vendor');
const lockPath = join(templateRoot, 'VENDOR-LOCK.json');
const previous = existsSync(lockPath) ? JSON.parse(readFileSync(lockPath, 'utf8')) : {};

function walk(dir) {
  const out = [];
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else out.push(p);
  }
  return out;
}

const files = {};
for (const f of walk(vendorRoot)) {
  if (!f.endsWith('.ts')) continue;
  const rel = relative(vendorRoot, f).split('\\').join('/');
  files[rel] = {
    sha256: createHash('sha256').update(readFileSync(f)).digest('hex'),
    // File-specific provenance survives regeneration. The global baseCommit
    // remains the historical source for unchanged legacy vendor files.
    ...(previous.files?.[rel]?.source ? { source: previous.files[rel].source } : {}),
  };
}

const lock = {
  baseCommit: process.env.VENDOR_BASE_COMMIT || previous.baseCommit || 'b088eececcb5f3df0b4edbe073a29401dafda624',
  generated: process.env.VENDOR_LOCK_DATE || new Date().toISOString().slice(0, 10),
  note: 'Vendored hashes are authoritative. baseCommit is the legacy source pin; entries with source metadata identify independently synchronized canonical files and dirty-worktree captures.',
  files,
}

writeFileSync(lockPath, JSON.stringify(lock, null, 2) + '\n');
console.log('gen-vendor-lock: ' + Object.keys(files).length + ' files, ' + Object.values(files).filter((entry) => entry.source).length + ' file-specific source fingerprints, legacy baseCommit=' + lock.baseCommit);
