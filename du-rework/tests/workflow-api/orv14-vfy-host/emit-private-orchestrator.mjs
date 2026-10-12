import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { cp, mkdir, readdir, readFile, stat, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../../..');
const serviceRoot = join(repoRoot, 'orchestrator/services/orchestrator');
const rawRoot = join(repoRoot, 'coordination/reports/raw/orv14-host-verification');
const nodeBin = process.execPath;
const id = `orv14-vfy-host-private-orchestrator-${Date.now().toString(36)}-${process.pid}`;
const scratchRoot = join('/tmp', id);
const outputRoot = join(scratchRoot, 'dist');
const migrationsTarget = join(scratchRoot, 'migrations');
const startedAt = new Date().toISOString();
const t0 = process.hrtime.bigint();

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function filesUnder(root) {
  const rootStat = await stat(root);
  if (rootStat.isFile()) return [root];
  const rows = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile()) rows.push(path);
    }
  }
  await walk(root);
  return rows.sort();
}
async function manifest(roots) {
  const files = [];
  for (const root of roots) {
    for (const path of await filesUnder(root.path)) {
      const rel = relative(repoRoot, path).replaceAll('\\', '/');
      if (root.filter && !root.filter(rel)) continue;
      files.push({ path: rel, sha256: sha(await readFile(path)) });
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return {
    fileCount: files.length,
    aggregateSha256: sha(Buffer.from(files.map((row) => `${row.path}\0${row.sha256}\n`).join(''))),
    files,
  };
}
async function outputManifest(root) {
  const files = [];
  for (const path of await filesUnder(root)) {
    const rel = relative(root, path).replaceAll('\\', '/');
    files.push({ path: rel, sha256: sha(await readFile(path)) });
  }
  return {
    fileCount: files.length,
    aggregateSha256: sha(Buffer.from(files.map((row) => `${row.path}\0${row.sha256}\n`).join(''))),
  };
}
async function maybeManifest(root) {
  try { await stat(root); return await manifest([{ path: root }]); }
  catch { return { fileCount: 0, aggregateSha256: null, files: [] }; }
}

const require = createRequire(import.meta.url);
const tscEntrypoint = require.resolve('typescript/bin/tsc', { paths: [serviceRoot] });
const typescriptPackage = require.resolve('typescript/package.json', { paths: [serviceRoot] });
const contractDist = join(repoRoot, 'orchestrator/packages/contracts/dist');
const inputRoots = [
  { path: join(serviceRoot, 'src') },
  { path: join(serviceRoot, 'migrations') },
  { path: join(serviceRoot, 'package.json') },
  { path: join(serviceRoot, 'tsconfig.json') },
  { path: join(repoRoot, 'orchestrator/tsconfig.base.json') },
  { path: join(repoRoot, 'orchestrator/packages/contracts/package.json') },
  { path: contractDist },
];

let before;
let after;
let compiler;
let output;
let exitCode = 1;
let error = null;
try {
  before = await manifest(inputRoots);
  const tsPkg = JSON.parse(await readFile(typescriptPackage, 'utf8'));
  compiler = {
    path: relative(repoRoot, tscEntrypoint).replaceAll('\\', '/'),
    packagePath: relative(repoRoot, typescriptPackage).replaceAll('\\', '/'),
    version: tsPkg.version,
    entrypointSha256: sha(await readFile(tscEntrypoint)),
    packageJsonSha256: sha(await readFile(typescriptPackage)),
  };
  await mkdir(scratchRoot, { recursive: false });
  await symlink(join(serviceRoot, 'node_modules'), join(scratchRoot, 'node_modules'), 'dir');
  await cp(join(serviceRoot, 'migrations'), migrationsTarget, { recursive: true, errorOnExist: true });
  const args = [tscEntrypoint, '-p', 'tsconfig.json', '--pretty', 'false', '--outDir', outputRoot,
    '--tsBuildInfoFile', join(scratchRoot, 'orchestrator.tsbuildinfo')];
  const proc = spawnSync(nodeBin, args, { cwd: serviceRoot, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  exitCode = proc.status ?? 1;
  output = {
    command: [nodeBin, ...args],
    cwd: serviceRoot,
    status: proc.status,
    signal: proc.signal,
    stdout: proc.stdout ?? '',
    stderr: proc.stderr ?? '',
  };
  if (exitCode === 0) output.emitted = await outputManifest(outputRoot);
  after = await manifest(inputRoots);
} catch (cause) {
  error = String(cause?.stack ?? cause);
  try { after ??= await manifest(inputRoots); } catch { /* retain original failure */ }
}

const endedAt = new Date().toISOString();
const unchanged = !!before && !!after && before.aggregateSha256 === after.aggregateSha256
  && before.fileCount === after.fileCount;
const rawPath = join(rawRoot, `private-orchestrator-build-${id}.json`);
const receipt = {
  task: 'VFY-ORV14-HOST-CONTINUITY / actual PostgreSQL maintenance+rollout claim interleaving',
  status: exitCode === 0 && unchanged ? 'PRIVATE_ORCHESTRATOR_EMIT_PASSED' : 'PRIVATE_ORCHESTRATOR_EMIT_FAILED_OR_SOURCE_MOVED',
  startedAt,
  endedAt,
  elapsedMs: Number(process.hrtime.bigint() - t0) / 1e6,
  cwd: repoRoot,
  uid: process.getuid?.() ?? null,
  gid: process.getgid?.() ?? null,
  nodeVersion: process.version,
  nodeExecutable: nodeBin,
  compiler,
  sourceSnapshot: { before, after, unchanged },
  contractDist: await maybeManifest(contractDist),
  scratchRoot,
  outputRoot,
  copiedMigrationDirectory: migrationsTarget,
  output,
  exitCode,
  error,
  rawPath,
  limitations: [
    'Only the normal Orchestrator TypeScript source is privately emitted; no repository dist/build output is written.',
    'Runtime dependencies resolve through the existing workspace node_modules symlink; contracts dist and TypeScript are hash-pinned in this receipt.',
    'This compile receipt is not a full Host or application acceptance result.',
  ],
};
await mkdir(rawRoot, { recursive: true });
await writeFile(rawPath, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
process.stdout.write(`${JSON.stringify({ status: receipt.status, rawPath, scratchRoot, outputRoot, sourceAggregateSha256: before?.aggregateSha256 ?? null, sourceUnchanged: unchanged, exitCode })}\n`);
process.exitCode = exitCode === 0 && unchanged ? 0 : 1;
