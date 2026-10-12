import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const ORCH = path.join(ROOT, 'orchestrator');
const RAW = path.join(ROOT, 'coordination/reports/raw/orv14-host-verification');
const runId = `orv14-vfy-host-materialize-${Date.now().toString(36)}`;
const now = () => new Date().toISOString();
const sha = value => createHash('sha256').update(value).digest('hex');

assert.equal(process.execPath, NODE, 'use the pinned Node 24.21.0 runtime');
assert.equal(process.getuid?.(), 1000, 'use the dedicated non-root verifier identity');
const [scratchArg, buildReceiptArg] = process.argv.slice(2);
assert.ok(scratchArg && path.isAbsolute(scratchArg), 'pass the absolute private scratch root');
assert.ok(buildReceiptArg && path.isAbsolute(buildReceiptArg), 'pass the absolute private build receipt');
assert.match(path.basename(scratchArg), /^orv14-vfy-host-native-/);
assert.equal(path.dirname(scratchArg), '/tmp');

const scratch = path.resolve(scratchArg);
const buildReceiptPath = path.resolve(buildReceiptArg);
const buildReceipt = JSON.parse(await readFile(buildReceiptPath, 'utf8'));
assert.equal(buildReceipt.result, 'PASSED');
assert.equal(buildReceipt.sourceUnchanged, true);
assert.equal(path.resolve(buildReceipt.scratchRoot), scratch);
assert.ok(buildReceipt.builtBundleSha256 && Object.keys(buildReceipt.builtBundleSha256).length > 0);

const targetOrch = path.join(scratch, 'orchestrator/services/orchestrator');
const targetConnector = path.join(scratch, 'orchestrator/services/connector');
const privatePackages = Object.fromEntries(['contracts', 'egress', 'observability', 'worker-sdk'].map(name => [
  name, path.join(scratch, 'orchestrator/packages', name),
]));
const scriptNames = [
  'ldba-inventory.cjs', 'ldba-continuity-evidence.cjs', 'ldba-continuity-plan.cjs',
  'ldba-continuity-mappings.cjs', 'ldba-continuity-source.cjs', 'ldba-continuity-runner.cjs',
  'ldba-continuity-runtime.cjs', 'ldba-03-production-adapter.cjs', 'ldba-03-backfill.cjs',
  'ldba-context-provider.cjs', 'ldba-reconcile.cjs',
];
const migrationSource = path.join(ORCH, 'services/orchestrator/migrations');
const migrationTarget = path.join(targetOrch, 'migrations');
const scriptsTarget = path.join(targetOrch, 'scripts');
const expectedBuildHashes = buildReceipt.sourceHashesBefore;

async function assertSnapshotSourcesUnchanged() {
  for (const [relative, expected] of Object.entries(expectedBuildHashes)) {
    const current = sha(await readFile(path.join(ROOT, relative)));
    assert.equal(current, expected, `source changed after the exact private build: ${relative}`);
  }
}

async function replaceWithDependencyOverlay(packageRoot) {
  const destination = path.join(packageRoot, 'node_modules');
  const existing = await lstat(destination).catch(error => error?.code === 'ENOENT' ? null : Promise.reject(error));
  if (existing?.isSymbolicLink()) await rm(destination);
  else if (existing) throw new Error(`unexpected non-symlink private node_modules: ${packageRoot}`);
  await mkdir(destination, { recursive: true, mode: 0o700 });

  const shared = path.join(ORCH, 'node_modules');
  const sharedEntries = await readdir(shared);
  for (const name of sharedEntries) {
    if (name === '@du') continue;
    await symlink(path.join(shared, name), path.join(destination, name), 'dir');
  }
  const duDest = path.join(destination, '@du');
  await mkdir(duDest, { recursive: true, mode: 0o700 });
  const sharedDu = path.join(shared, '@du');
  const sharedDuEntries = await readdir(sharedDu).catch(error => error?.code === 'ENOENT' ? [] : Promise.reject(error));
  for (const name of sharedDuEntries) {
    if (Object.hasOwn(privatePackages, name)) continue;
    await symlink(path.join(sharedDu, name), path.join(duDest, name), 'dir');
  }
  for (const [name, packagePath] of Object.entries(privatePackages)) {
    await lstat(path.join(packagePath, 'dist'));
    await symlink(packagePath, path.join(duDest, name), 'dir');
  }
  return { packageRoot, sharedDependencyEntries: sharedEntries.length, sharedDuEntries: sharedDuEntries.length };
}

const receipt = {
  schema: 'orv14-native-private-runtime-materialization/v1',
  command: `${NODE} tests/workflow-api/orv14-vfy-host/materialize-native-private-runtime.mjs <private-scratch-root> <private-build-receipt>`,
  cwd: ROOT,
  node: 'v24.21.0',
  uid: process.getuid?.() ?? null,
  runId,
  startedAt: now(),
  scratchRoot: scratch,
  buildReceipt: path.relative(ROOT, buildReceiptPath),
  buildReceiptSha256: sha(await readFile(buildReceiptPath)),
  sourceHashCount: Object.keys(expectedBuildHashes).length,
  sourceTreeCheckedBefore: false,
  sourceTreeCheckedAfter: false,
  privateBundleAggregateSha256: sha(JSON.stringify(buildReceipt.builtBundleSha256)),
  materialized: [],
  scripts: [],
  result: 'RUNNING',
  sharedDistWritten: false,
  productSourceWritten: false,
};

try {
  await assertSnapshotSourcesUnchanged();
  receipt.sourceTreeCheckedBefore = true;

  await rm(migrationTarget, { recursive: true, force: true });
  await cp(migrationSource, migrationTarget, { recursive: true, errorOnExist: true, force: false });
  for (const name of scriptNames) {
    const source = path.join(ORCH, 'services/orchestrator/scripts', name);
    const relative = path.relative(ROOT, source);
    const expected = expectedBuildHashes[relative];
    assert.ok(expected, `script absent from private-build source manifest: ${name}`);
    const bytes = await readFile(source);
    assert.equal(sha(bytes), expected, `script changed after private build: ${name}`);
    await writeFile(path.join(scriptsTarget, name), bytes, { mode: 0o600 });
    receipt.scripts.push({ name, sha256: expected });
  }

  for (const packageRoot of [targetOrch, targetConnector]) {
    receipt.materialized.push(await replaceWithDependencyOverlay(packageRoot));
  }
  await assertSnapshotSourcesUnchanged();
  receipt.sourceTreeCheckedAfter = true;
  receipt.result = 'PASSED_PRIVATE_RUNTIME_READY';
} catch (error) {
  receipt.result = 'FAILED';
  receipt.error = String(error?.stack || error).slice(0, 5000);
}

receipt.completedAt = now();
const rawPath = path.join(RAW, `${runId}.json`);
await mkdir(RAW, { recursive: true });
await writeFile(rawPath, JSON.stringify(receipt, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
process.stdout.write(JSON.stringify({ result: receipt.result, scratchRoot: scratch,
  sourceHashCount: receipt.sourceHashCount, materializedPackages: receipt.materialized.length,
  copiedScriptCount: receipt.scripts.length, rawReceipt: path.relative(ROOT, rawPath) }, null, 2) + '\n');
if (receipt.result !== 'PASSED_PRIVATE_RUNTIME_READY') process.exitCode = 1;
