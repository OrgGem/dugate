'use strict';

import { createHash } from 'node:crypto';
import { readdirSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const templateRoot = resolve(here, '..');
const vendorRoot = join(templateRoot, 'vendor');

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
  files[rel] = { sha256: createHash('sha256').update(readFileSync(f)).digest('hex') };
}

const lock = {
  baseCommit: process.env.VENDOR_BASE_COMMIT || 'b088eececcb5f3df0b4edbe073a29401dafda624',
  generated: process.env.VENDOR_LOCK_DATE || '2026-10-06',
  note: 'Vendored provenance lock. Regenerate with: node scripts/gen-vendor-lock.mjs',
  files,
}

writeFileSync(join(templateRoot, 'VENDOR-LOCK.json'), JSON.stringify(lock, null, 2) + '\n');
console.log('gen-vendor-lock: ' + Object.keys(files).length + ' files, baseCommit=' + lock.baseCommit);
