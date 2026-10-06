#!/usr/bin/env node
/**
 * RPK-INVENTORY-FREEZE-889: freeze the product-source inventory of the CURRENT
 * WORKING TREE (tracked AND untracked) with SHA-256, classified for the
 * Phase-B redistribution.
 *
 * NOT a git export: A20 proved HEAD only proves one literal `true`
 * (runtime.ts:221) and that public.ts/mappers.ts are absent from HEAD, so a
 * HEAD-derived inventory would be wrong on exactly the files that matter.
 * git_state is recorded per row instead, and untracked product source is
 * INCLUDED (classified, never dropped).
 *
 * Usage: node tools/repo-migration/freeze-inventory.cjs [out.tsv]
 * Emits TSV with the fields tools/repo-migration/verify-inventory.cjs expects:
 * record_type, path, git_state, sha256 (+ bytes, class).
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname, '..', '..');

const SKIP_DIRS = new Set(['node_modules', 'dist', 'coverage', 'test-results', '.git', '.next', '.turbo', '.cache']);
const SKIP_FILE = /(^\.env(\..*)?$|\.(log|tsbuildinfo|pem|key|map|d\.ts)$)/;

function isProduct(relative) {
  const first = relative.split(path.sep)[0];
  if (first === 'packages' || first === 'services' || first === 'businesses' || first === 'apps') return true;
  if (first === 'infra' || first === 'compose' || first === '.github') return true;
  const base = path.basename(relative);
  return ['Dockerfile', 'docker-compose.yml', 'docker-compose.yaml', '.dockerignore', 'package.json',
    'pnpm-lock.yaml', 'pnpm-workspace.yaml', 'tsconfig.base.json', '.npmrc', '.env.example',
    'drizzle.config.ts', 'jest.config.cjs', 'jest.config.js'].includes(base);
}

/** (a) canonical contract/shared lib + server source -> Orchestrator repo,
 * (b) worker-template versioned source, (c) business customization kept at the
 * worker, (d) infra/CI/Docker/Compose. Anything the rules cannot justify is
 * UNCLASSIFIED and listed file by file for a USER owner decision. */
function classify(relative) {
  const normalized = relative.split(path.sep).join('/');
  if (/^(Dockerfile|docker-compose|\.dockerignore|\.github\/|infra\/|compose\/)/.test(normalized)) return 'd-infra-ci-docker-compose';
  if (/(^|\/)(package\.json|pnpm-lock\.yaml|pnpm-workspace\.yaml|tsconfig\.base\.json|\.npmrc)$/.test(normalized)) return 'd-infra-ci-docker-compose';
  if (normalized.startsWith('packages/') || normalized.startsWith('services/')) return 'a-canonical-contract-shared-lib';
  if (normalized.startsWith('businesses/')) {
    const rest = normalized.slice('businesses/'.length).split('/');
    if (rest.length >= 3 && rest[1] === 'src' && /^(main|worker|index|config|manifest|registry-tool)\.ts$/.test(rest[2])) return 'b-worker-template';
    return 'c-business-customization';
  }
  return 'UNCLASSIFIED';
}

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { walk(full, out); continue; }
    if (!entry.isFile()) continue;
    if (SKIP_FILE.test(entry.name)) continue;
    const relative = path.relative(root, full);
    if (!isProduct(relative)) continue;
    out.push(relative);
  }
}

function gitSet(args) {
  try {
    const raw = execFileSync('git', ['ls-files', '-z', ...args], { cwd: root, encoding: 'utf8' });
    return new Set(raw.split('\0').filter(Boolean));
  } catch { return null; }
}

const found = [];
walk(root, found);
const tracked = gitSet([]);
const untracked = gitSet(['-o', '--exclude-standard']);
const rows = found.map((relative) => {
  const full = path.join(root, relative);
  const body = fs.readFileSync(full);
  const sha256 = crypto.createHash('sha256').update(body).digest('hex');
  const normalized = relative.split(path.sep).join('/');
  const gitKey = normalized;
  const gitKeyPrefixed = 'du-rework/' + normalized;
  const state = tracked && (tracked.has(gitKey) || tracked.has(gitKeyPrefixed)) ? 'tracked'
    : untracked && (untracked.has(gitKey) || untracked.has(gitKeyPrefixed)) ? 'untracked'
    : 'unknown';
  return { record_type: 'file', path: gitKey, git_state: state, sha256, bytes: body.length, class: classify(relative) };
});
rows.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

const byState = {};
const byClass = {};
const byClassState = {};
for (const row of rows) {
  byState[row.git_state] = (byState[row.git_state] || 0) + 1;
  byClass[row.class] = (byClass[row.class] || 0) + 1;
  const key = row.class + '/' + row.git_state;
  byClassState[key] = (byClassState[key] || 0) + 1;
}

// Per-candidate snapshot digest: SHA-256 over the sorted 'path sha256' stream.
const candidates = {};
for (const row of rows) {
  const parts = row.path.split('/');
  const candidate = parts.length > 3 ? parts.slice(0, 3).join('/') : parts.slice(0, -1).join('/');
  (candidates[candidate] = candidates[candidate] || []).push(row.path + ' ' + row.sha256);
}
const digests = {};
for (const [name, lines] of Object.entries(candidates)) {
  lines.sort();
  digests[name] = crypto.createHash('sha256').update(lines.join('\n')).digest('hex');
}

const header = ['record_type', 'path', 'git_state', 'sha256', 'bytes', 'class'].join('\t');
const body = rows.map((r) => [r.record_type, r.path, r.git_state, r.sha256, r.bytes, r.class].join('\t')).join('\n') + '\n';
const outFile = path.resolve(process.argv[2] || path.join('coordination', 'reports', 'raw', 'rpk-inventory-freeze-889-2026-10-05.tsv'));
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, header + '\n' + body);
const treeDigest = crypto.createHash('sha256').update(body).digest('hex');
process.stdout.write(JSON.stringify({
  inventory: outFile,
  files: rows.length,
  gitState: byState,
  classes: byClass,
  classAndState: byClassState,
  unclassified: rows.filter((r) => r.class === 'UNCLASSIFIED').map((r) => r.path),
  candidateDigests: digests,
  treeSha256: treeDigest,
}, null, 2) + '\n');
