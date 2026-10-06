#!/usr/bin/env node
/** ORCH-CANONICAL-LIBS-891: scaffold the Orchestrator candidate from the 889
 * pinned inventory. Copies ONLY files present in the freeze TSV (never a
 * blanket dirty-tree copy), preserving package layout. No businesses/ =
 * worker siblings absent by construction. */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const SRC = 'D:/Git/dugate/du-rework';
const OUT = path.join(SRC, 'migration-candidates', 'orchestrator');
const tsv = path.join(SRC, 'coordination', 'reports', 'raw', 'rpk-inventory-freeze-889-2026-10-05.tsv');
const INCLUDE = /^(packages|services\/orchestrator|services\/connector)\//;
const ROOT_FILES = new Set(['package.json', 'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', '.npmrc', 'Dockerfile', '.dockerignore']);
const rows = fs.readFileSync(tsv, 'utf8').split(/\r?\n/).slice(1).filter(Boolean);
let copied = 0; const mismatches = [];
for (const line of rows) {
  const parts = line.split('\t');
  if (parts.length < 4) continue;
  const repoPath = parts[1];                 const expectedSha = parts[3];
  const rel = repoPath.replace(/^du-rework\//, '').split('/').join(path.sep);
  const inScope = INCLUDE.test(rel.replace(/\\/g, '/')) || (/^[^\\/]+$/.test(rel) && ROOT_FILES.has(path.basename(rel)));
  if (!inScope) continue;
  const from = path.join(SRC, rel);
  if (!fs.existsSync(from)) continue;
  const to = path.join(OUT, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
  copied += 1;
  const actual = crypto.createHash('sha256').update(fs.readFileSync(to)).digest('hex');
  if (actual !== expectedSha) mismatches.push({ rel, expectedSha, actual });
}
console.log(JSON.stringify({ out: OUT, copied, mismatches: mismatches.length, mismatchRows: mismatches.slice(0, 10) }, null, 2));
