'use strict';

const fs = require('node:fs');
const path = require('node:path');
const Module = require('node:module');

const target = path.resolve(process.cwd(), 'src/db/migrations.ts');
const marker = path.join(__dirname, 'mutation-applied.marker');
const patchedObjects = new WeakSet();

function targetPath(file) {
  if (typeof file !== 'string' && !Buffer.isBuffer(file)) return false;
  return path.resolve(String(file)).toLowerCase() === target.toLowerCase();
}

function mutate(file, value) {
  if (!targetPath(file)) return value;
  const wasBuffer = Buffer.isBuffer(value);
  const source = wasBuffer ? value.toString('utf8') : value;
  if (typeof source !== 'string') throw new Error('migration source was not text');
  const migrateToken = 'export async function migrate(db: Db)';
  const startToken = '  // MED-1 (WFA section 8 security review):';
  const endToken = '  const applied: string[] = [];';
  const migrateStart = source.indexOf(migrateToken);
  const start = source.indexOf(startToken, migrateStart);
  const end = source.indexOf(endToken, start);
  if (start < 0) {
    // Jest may read the already-mutated transform input again in the same process.
    if (migrateStart >= 0 && endToken && !source.includes('const drifted = await recordedMigrationsMissingObjects')) return value;
    throw new Error('could not identify the MED-1 drift-check block inside migrate()');
  }
  if (migrateStart < 0 || start < migrateStart || end < 0) {
    throw new Error('could not identify the MED-1 drift-check block inside migrate()');
  }
  const mutant = source.slice(0, start) + endToken + source.slice(end + endToken.length);
  fs.writeFileSync(marker, JSON.stringify({ target, mutation: 'removed drift-check block inside migrate() in memory', start, end }));
  return wasBuffer ? Buffer.from(mutant, 'utf8') : mutant;
}

function patchFs(fsLike) {
  if (!fsLike || (typeof fsLike !== 'object' && typeof fsLike !== 'function') || patchedObjects.has(fsLike)) return;
  patchedObjects.add(fsLike);
  if (typeof fsLike.readFileSync === 'function') {
    const original = fsLike.readFileSync;
    fsLike.readFileSync = function (file, ...args) {
      return mutate(file, original.call(this, file, ...args));
    };
  }
  if (fsLike.promises && typeof fsLike.promises.readFile === 'function') {
    const originalAsync = fsLike.promises.readFile;
    fsLike.promises.readFile = async function (file, ...args) {
      return mutate(file, await originalAsync.call(this, file, ...args));
    };
  }
}

patchFs(fs);
const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  const loaded = originalLoad.apply(this, arguments);
  if (request === 'graceful-fs' || request === 'fs' || request === 'node:fs') patchFs(loaded);
  return loaded;
};

const jestCli = path.resolve(process.cwd(), 'node_modules/jest/bin/jest.js');
const args = process.argv.slice(2);
process.argv = [process.execPath, jestCli, ...args];
require(jestCli);
