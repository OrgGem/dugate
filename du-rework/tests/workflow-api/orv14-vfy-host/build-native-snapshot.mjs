import { createHash, randomUUID } from 'node:crypto';
import { cp, lstat, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import process from 'node:process';

const repo = path.resolve('.');
const orchestrator = path.join(repo, 'orchestrator');
const scratchId = `orv14-vfy-host-native-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const scratchRoot = path.join('/tmp', scratchId);
const snapshotRoot = path.join(scratchRoot, 'orchestrator');
const outputRoot = path.join(scratchRoot, 'runtime-node-modules');
const rawRoot = path.join(repo, 'coordination/reports/raw/orv14-host-verification');
const rawPath = path.join(rawRoot, `native-scratch-build-${scratchId}.json`);
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

async function hashFiles(files, base = repo) {
  const output = {};
  for (const file of files) output[path.relative(base, file)] = sha(await readFile(file));
  return output;
}

function tscRun(config) {
  const result = spawnSync(nodeBin, [tsc, '--pretty', 'false', '--project', config], {
    cwd: repo,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 16 * 1024 * 1024,
    env: process.env,
  });
  return {
    exitCode: result.status,
    signal: result.signal || null,
    error: result.error ? String(result.error.message || result.error) : null,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };
}

async function writeJson(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
}

const startedAt = new Date().toISOString();
const nodeVersion = spawnSync(nodeBin, ['--version'], { encoding: 'utf8' }).stdout.trim();
const sourceFiles = [];
for (const project of projects) {
  const sourceRoot = path.join(orchestrator, project.relative, 'src');
  sourceFiles.push(...await filesUnder(sourceRoot, file => file.endsWith('.ts')));
  for (const extra of ['package.json']) sourceFiles.push(path.join(orchestrator, project.relative, extra));
}
sourceFiles.push(path.join(orchestrator, 'tsconfig.base.json'));
const continuityScripts = [
  'ldba-inventory.cjs', 'ldba-continuity-evidence.cjs', 'ldba-continuity-plan.cjs',
  'ldba-continuity-mappings.cjs', 'ldba-continuity-source.cjs', 'ldba-continuity-runner.cjs',
  'ldba-continuity-runtime.cjs', 'ldba-03-production-adapter.cjs', 'ldba-03-backfill.cjs',
  'ldba-context-provider.cjs', 'ldba-reconcile.cjs',
].map(file => path.join(orchestrator, 'services/orchestrator/scripts', file));
sourceFiles.push(...continuityScripts);
sourceFiles.push(path.resolve(repo, '..', 'lib/db/schema.ts'), path.resolve(repo, '..', 'lib/settings.ts'));
const migrationDirs = [
  path.join(orchestrator, 'services/orchestrator/migrations'),
  path.join(orchestrator, 'services/connector/src/db/migrations'),
];
for (const dir of migrationDirs) sourceFiles.push(...await filesUnder(dir, file => file.endsWith('.sql')));
const sourceHashesBefore = await hashFiles([...new Set(sourceFiles)].sort());

const receipt = {
  kind: 'native-import-private-scratch-build',
  runId: scratchId,
  startedAt,
  cwd: repo,
  node: nodeVersion,
  uid: process.getuid?.() ?? null,
  gid: process.getgid?.() ?? null,
  command: `${nodeBin} ${path.relative(repo, tsc)} --pretty false --project <private scratch tsconfig>`,
  scratchRoot,
  outputRoot,
  rawPath: path.relative(repo, rawPath),
  sourceHashesBefore,
  projects: [],
  result: 'RUNNING',
  sharedDistWritten: false,
  productSourceWritten: false,
  cleanup: 'SCRATCH_RETAINED_FOR_NEXT_INTEGRATION_STEP',
};

try {
  await mkdir(snapshotRoot, { recursive: true, mode: 0o700 });
  await cp(path.join(orchestrator, 'tsconfig.base.json'), path.join(snapshotRoot, 'tsconfig.base.json'));
  await symlink(path.join(orchestrator, 'node_modules'), path.join(snapshotRoot, 'node_modules'), 'dir');

  for (const project of projects) {
    const sourceDir = path.join(orchestrator, project.relative);
    const targetDir = path.join(snapshotRoot, project.relative);
    await mkdir(targetDir, { recursive: true, mode: 0o700 });
    await cp(path.join(sourceDir, 'src'), path.join(targetDir, 'src'), { recursive: true });
    await cp(path.join(sourceDir, 'package.json'), path.join(targetDir, 'package.json'));
    const packageNodeModules = path.join(sourceDir, 'node_modules');
    try {
      await lstat(packageNodeModules);
      await symlink(packageNodeModules, path.join(targetDir, 'node_modules'), 'dir');
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await symlink(path.join(orchestrator, 'node_modules'), path.join(targetDir, 'node_modules'), 'dir');
    }
  }

  const baseConfig = path.join(snapshotRoot, 'tsconfig.base.json');
  const configDir = path.join(scratchRoot, 'tsconfigs');
  await mkdir(configDir, { recursive: true, mode: 0o700 });
  const distFor = name => path.join(snapshotRoot, projects.find(project => project.name === name).relative, 'dist');
  const aliases = {
    '@du/contracts': [path.join(distFor('contracts'), 'index.d.ts')],
    '@du/contracts/*': [path.join(distFor('contracts'), '*')],
    '@du/egress': [path.join(distFor('egress'), 'index.d.ts')],
    '@du/egress/*': [path.join(distFor('egress'), '*')],
    '@du/observability': [path.join(distFor('observability'), 'index.d.ts')],
    '@du/observability/*': [path.join(distFor('observability'), '*')],
    '@du/worker-sdk': [path.join(distFor('worker-sdk'), 'index.d.ts')],
    '@du/worker-sdk/*': [path.join(distFor('worker-sdk'), '*')],
  };
  const buildOrder = ['contracts', 'egress', 'observability', 'worker-sdk', 'orchestrator', 'connector'];
  for (const name of buildOrder) {
    const project = projects.find(item => item.name === name);
    const targetDir = path.join(snapshotRoot, project.relative);
    const sourceDir = path.join(targetDir, 'src');
    const config = path.join(configDir, `${name}.json`);
    const compilerOptions = {
      rootDir: sourceDir,
      outDir: path.join(targetDir, 'dist'),
      baseUrl: snapshotRoot,
      paths: aliases,
      typeRoots: [
        path.join(orchestrator, project.relative, 'node_modules/@types'),
        path.join(orchestrator, 'node_modules/@types'),
      ],
      types: ['node'],
      sourceMap: false,
      declarationMap: false,
      incremental: false,
      composite: false,
      noEmit: false,
    };
    await writeJson(config, {
      extends: baseConfig,
      compilerOptions,
      include: [path.join(sourceDir, '**/*.ts')],
      exclude: [path.join(sourceDir, '**/node_modules/**')],
    });
    const output = tscRun(config);
    receipt.projects.push({ name, configPath: config, exitCode: output.exitCode, signal: output.signal, error: output.error, stdout: output.stdout, stderr: output.stderr });
    await writeJson(rawPath, receipt);
    if (output.exitCode !== 0) {
      receipt.result = 'BLOCKED';
      receipt.blockedAt = name;
      break;
    }
  }

  if (receipt.result === 'RUNNING') {
    const runtimeNodeModules = path.join(snapshotRoot, 'node_modules');
    await rm(runtimeNodeModules, { recursive: true, force: true });
    await mkdir(path.join(runtimeNodeModules, '@du'), { recursive: true, mode: 0o700 });
    for (const name of ['contracts', 'egress', 'observability', 'worker-sdk']) {
      const packageDir = path.join(snapshotRoot, projects.find(project => project.name === name).relative);
      await symlink(packageDir, path.join(runtimeNodeModules, '@du', name), 'dir');
    }
    const builtFiles = [];
    for (const project of projects) {
      const distDir = path.join(snapshotRoot, project.relative, 'dist');
      builtFiles.push(...await filesUnder(distDir));
    }
    receipt.builtBundleSha256 = await hashFiles(builtFiles, scratchRoot);
    receipt.result = 'PASSED';
  }
} catch (error) {
  receipt.result = 'HARNESS_ERROR';
  receipt.harnessError = String(error?.stack || error);
}

receipt.completedAt = new Date().toISOString();
receipt.sourceHashesAfter = await hashFiles([...new Set(sourceFiles)].sort());
receipt.sourceUnchanged = JSON.stringify(receipt.sourceHashesBefore) === JSON.stringify(receipt.sourceHashesAfter);
if (!receipt.sourceUnchanged && receipt.result === 'PASSED') receipt.result = 'SOURCE_CHANGED_DURING_SNAPSHOT_BUILD';
await writeJson(rawPath, receipt);
process.stdout.write(JSON.stringify({
  result: receipt.result,
  scratchRoot,
  rawPath: receipt.rawPath,
  projects: receipt.projects.map(({ name, exitCode }) => ({ name, exitCode })),
  sourceUnchanged: receipt.sourceUnchanged,
  sourceCount: Object.keys(receipt.sourceHashesBefore).length,
  builtCount: Object.keys(receipt.builtBundleSha256 || {}).length,
}, null, 2) + '\n');
if (receipt.result !== 'PASSED') process.exitCode = 1;
