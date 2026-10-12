import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repo = path.resolve('.');
const orchestrator = path.join(repo, 'orchestrator');
const nodeBin = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const tsc = path.join(orchestrator, 'node_modules/.pnpm/typescript@5.9.3/node_modules/typescript/bin/tsc');
const projects = [
  { name: 'contracts', relative: 'packages/contracts' },
  { name: 'egress', relative: 'packages/egress' },
  { name: 'observability', relative: 'packages/observability' },
  { name: 'worker-sdk', relative: 'packages/worker-sdk' },
  { name: 'orchestrator', relative: 'services/orchestrator' },
  { name: 'connector', relative: 'services/connector' },
];
const expectedMovedSource = 'orchestrator/services/orchestrator/src/modules/connectors/provider-test.ts';
const expectedMovedSha = 'e36911e29c3d27027156c54c6ed6f8d40a145ea71a9df0ff2a1209cfe5691818';
const inputReceiptPath = process.argv[2];
if (!inputReceiptPath) throw new Error('usage: node reemit-native-orchestrator.mjs <prior-build-receipt.json>');

function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
async function filesUnder(root, include = () => true) {
  const files = [];
  async function walk(current) {
    for (const entry of await readdir(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.isFile() && include(full)) files.push(full);
    }
  }
  await walk(root);
  return files.sort();
}
async function hashFiles(files, base) {
  const entries = [];
  for (const file of files) entries.push([path.relative(base, file), sha(await readFile(file))]);
  return Object.fromEntries(entries);
}
async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}
async function collectSources() {
  const sourceFiles = [];
  for (const project of projects) {
    const sourceRoot = path.join(orchestrator, project.relative, 'src');
    sourceFiles.push(...await filesUnder(sourceRoot, file => file.endsWith('.ts')));
    sourceFiles.push(path.join(orchestrator, project.relative, 'package.json'));
  }
  sourceFiles.push(path.join(orchestrator, 'tsconfig.base.json'));
  sourceFiles.push(...[
    'ldba-inventory.cjs', 'ldba-continuity-evidence.cjs', 'ldba-continuity-plan.cjs',
    'ldba-continuity-mappings.cjs', 'ldba-continuity-source.cjs', 'ldba-continuity-runner.cjs',
    'ldba-continuity-runtime.cjs', 'ldba-03-production-adapter.cjs', 'ldba-03-backfill.cjs',
    'ldba-context-provider.cjs', 'ldba-reconcile.cjs',
  ].map(file => path.join(orchestrator, 'services/orchestrator/scripts', file)));
  sourceFiles.push(path.resolve(repo, '..', 'lib/db/schema.ts'), path.resolve(repo, '..', 'lib/settings.ts'));
  for (const dir of [
    path.join(orchestrator, 'services/orchestrator/migrations'),
    path.join(orchestrator, 'services/connector/src/db/migrations'),
  ]) sourceFiles.push(...await filesUnder(dir, file => file.endsWith('.sql')));
  return [...new Set(sourceFiles)].sort();
}
async function outputHashes(scratchRoot) {
  const result = {};
  for (const project of projects) {
    const dist = path.join(scratchRoot, 'orchestrator', project.relative, 'dist');
    result[project.name] = await hashFiles(await filesUnder(dist), scratchRoot);
  }
  return result;
}

const prior = JSON.parse(await readFile(path.resolve(inputReceiptPath), 'utf8'));
const startedAt = new Date().toISOString();
const scratchRoot = prior.scratchRoot;
const snapshotRoot = path.join(scratchRoot, 'orchestrator');
const sourceFiles = await collectSources();
const sourceHashesBefore = await hashFiles(sourceFiles, repo);
const sourceDifferences = Object.entries(sourceHashesBefore)
  .filter(([file, hash]) => prior.sourceHashesBefore?.[file] !== hash)
  .map(([file, current]) => ({ file, previous: prior.sourceHashesBefore?.[file] ?? null, current }));
const rawRoot = path.join(repo, 'coordination/reports/raw/orv14-host-verification');
const runId = `native-orchestrator-reemit-${Date.now().toString(36)}`;
const rawPath = path.join(rawRoot, `${runId}.json`);
const config = path.join(scratchRoot, 'tsconfigs/orchestrator.json');
const snapshotProvider = path.join(snapshotRoot, 'services/orchestrator/src/modules/connectors/provider-test.ts');
const liveProvider = path.join(orchestrator, 'services/orchestrator/src/modules/connectors/provider-test.ts');
const receipt = {
  kind: 'native-import-private-orchestrator-scoped-reemit',
  runId,
  startedAt,
  cwd: repo,
  node: spawnSync(nodeBin, ['--version'], { encoding: 'utf8' }).stdout.trim(),
  uid: process.getuid?.() ?? null,
  gid: process.getgid?.() ?? null,
  priorBuildRawPath: path.relative(repo, path.resolve(inputReceiptPath)),
  priorBuildResult: prior.result,
  scope: 'reemit only Orchestrator project after the sole moved source input was frozen; reuse other five project outputs only when their hashes remain identical',
  sourceInputCount: sourceFiles.length,
  sourceHashesBefore,
  sourceDifferencesFromPriorBuildStart: sourceDifferences,
  expectedChangedSource: expectedMovedSource,
  expectedChangedSourceSha256: expectedMovedSha,
  scratchRoot,
  command: `${nodeBin} ${path.relative(repo, tsc)} --pretty false --project ${config}`,
  privateConfig: config,
  projectsReemitted: ['orchestrator'],
  result: 'RUNNING',
  sharedDistWritten: false,
  productSourceWritten: false,
  cleanup: 'SCRATCH_RETAINED_FOR_NATIVE19_INTEGRATION',
};

try {
  if (prior.result !== 'SOURCE_CHANGED_DURING_SNAPSHOT_BUILD') throw new Error(`unexpected prior build result: ${prior.result}`);
  if (prior.projects?.length !== 6 || prior.projects.some(project => project.exitCode !== 0)) throw new Error('prior private build did not compile all six projects');
  if (sourceFiles.length !== Object.keys(prior.sourceHashesBefore || {}).length) throw new Error('source input inventory changed since prior build');
  if (sourceDifferences.length !== 1 || sourceDifferences[0].file !== expectedMovedSource || sourceDifferences[0].current !== expectedMovedSha) {
    throw new Error(`source drift is not the one frozen provider-test update: ${JSON.stringify(sourceDifferences)}`);
  }
  const liveProviderSha = sha(await readFile(liveProvider));
  if (liveProviderSha !== expectedMovedSha) throw new Error(`provider-test is not at expected frozen hash: ${liveProviderSha}`);
  const before = await outputHashes(scratchRoot);
  receipt.outputHashesBefore = before;
  await cp(liveProvider, snapshotProvider);
  receipt.privateProviderSha256 = sha(await readFile(snapshotProvider));
  if (receipt.privateProviderSha256 !== expectedMovedSha) throw new Error('private provider-test copy hash mismatch');

  const tscRun = spawnSync(nodeBin, [tsc, '--pretty', 'false', '--project', config], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  receipt.typecheck = {
    exitCode: tscRun.status,
    signal: tscRun.signal || null,
    error: tscRun.error ? String(tscRun.error.message || tscRun.error) : null,
    stdout: tscRun.stdout || '',
    stderr: tscRun.stderr || '',
  };
  if (tscRun.status !== 0) throw new Error(`Orchestrator scoped reemit failed with exit ${tscRun.status}`);

  receipt.outputHashesAfter = await outputHashes(scratchRoot);
  receipt.reusedProjectOutputEquality = Object.fromEntries(projects
    .filter(project => project.name !== 'orchestrator')
    .map(project => [project.name, JSON.stringify(before[project.name]) === JSON.stringify(receipt.outputHashesAfter[project.name])]));
  if (Object.values(receipt.reusedProjectOutputEquality).some(equal => !equal)) throw new Error('one or more reused project outputs changed');
  if (Object.keys(receipt.outputHashesAfter.orchestrator).length === 0) throw new Error('Orchestrator emitted no files');
  receipt.orchestratorOutputChanged = JSON.stringify(before.orchestrator) !== JSON.stringify(receipt.outputHashesAfter.orchestrator);
  if (!receipt.orchestratorOutputChanged) throw new Error('Orchestrator outputs did not change after provider-test source update');
  receipt.result = 'SCOPED_ORCHESTRATOR_REEMIT_PASSED';
} catch (error) {
  receipt.result = 'BLOCKED';
  receipt.failure = String(error?.stack || error);
}
receipt.completedAt = new Date().toISOString();
receipt.sourceHashesAfter = await hashFiles(await collectSources(), repo);
receipt.sourceStableDuringReemit = JSON.stringify(receipt.sourceHashesBefore) === JSON.stringify(receipt.sourceHashesAfter);
if (!receipt.sourceStableDuringReemit && receipt.result === 'SCOPED_ORCHESTRATOR_REEMIT_PASSED') {
  receipt.result = 'SOURCE_CHANGED_DURING_SCOPED_REEMIT';
}
await writeJson(rawPath, receipt);
process.stdout.write(JSON.stringify({
  result: receipt.result,
  rawPath: path.relative(repo, rawPath),
  scratchRoot,
  sourceInputCount: sourceFiles.length,
  sourceDifferencesFromPriorBuildStart: sourceDifferences,
  typecheckExitCode: receipt.typecheck?.exitCode ?? null,
  reusedProjectOutputEquality: receipt.reusedProjectOutputEquality ?? null,
  orchestratorOutputChanged: receipt.orchestratorOutputChanged ?? null,
  sourceStableDuringReemit: receipt.sourceStableDuringReemit,
}, null, 2) + '\n');
if (receipt.result !== 'SCOPED_ORCHESTRATOR_REEMIT_PASSED') process.exitCode = 1;
