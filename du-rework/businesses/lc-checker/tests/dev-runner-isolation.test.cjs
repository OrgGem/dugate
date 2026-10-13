'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');

const SOURCE_PROJECT = path.resolve(__dirname, '..');
const WORKER_SOURCE = `
console.log('fixture-worker-start', Boolean(process.env.SERVICE_IDENTITY_SECRET), Boolean(process.env.DEV_PARENT_SECRET));
process.once('SIGTERM', () => { console.log('fixture-worker-stop'); process.exit(0); });
setInterval(() => undefined, 60000);
`;

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

async function createWorkspaceLinks(projectRoot) {
  const workerManifest = JSON.parse(await fs.readFile(path.join(SOURCE_PROJECT, 'package.json'), 'utf8'));
  await writeFile(path.join(projectRoot, 'package.json'), JSON.stringify(workerManifest));
  const packages = [{ root: projectRoot, manifest: workerManifest }];
  for (const entry of await fs.readdir(path.join(SOURCE_PROJECT, 'vendor'), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const sourceRoot = path.join(SOURCE_PROJECT, 'vendor', entry.name);
    const manifestPath = path.join(sourceRoot, 'package.json');
    try {
      const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
      const targetRoot = path.join(projectRoot, 'vendor', entry.name);
      await writeFile(path.join(targetRoot, 'package.json'), JSON.stringify(manifest));
      packages.push({ root: targetRoot, manifest });
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  for (const { root, manifest } of packages) {
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const dependencyName of Object.keys(dependencies).filter((name) => name.startsWith('@du/'))) {
      const dependencyRoot = path.join(projectRoot, 'vendor', dependencyName.slice('@du/'.length));
      const linkPath = path.join(root, 'node_modules', ...dependencyName.split('/'));
      await fs.mkdir(path.dirname(linkPath), { recursive: true });
      await fs.symlink(dependencyRoot, linkPath, process.platform === 'win32' ? 'junction' : 'dir');
    }
  }
}

async function createFixture() {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'lc-checker-dev-isolation-'));
  const projectRoot = path.join(temporaryRoot, 'business');
  await fs.mkdir(path.join(projectRoot, 'scripts'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'vendor/contracts/src'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'node_modules/typescript/bin'), { recursive: true });
  await fs.mkdir(path.join(projectRoot, 'dist'), { recursive: true });
  for (const script of ['dev.cjs', 'dev-child.cjs', 'local-env.cjs', 'build.cjs']) {
    await fs.copyFile(path.join(SOURCE_PROJECT, 'scripts', script), path.join(projectRoot, 'scripts', script));
  }
  await createWorkspaceLinks(projectRoot);
  await writeFile(path.join(projectRoot, 'src/main.ts'), 'export {};\n');
  await writeFile(path.join(projectRoot, 'vendor/contracts/src/index.ts'), 'export const fixture = true;\n');
  await writeFile(path.join(projectRoot, 'dist/main.js'), WORKER_SOURCE);
  await writeFile(path.join(projectRoot, '.env.local'), [
    'RUNTIME_URL=http://127.0.0.1:3002/api/runtime/v1',
    'RUNTIME_TOKEN=fixture-runtime-token',
    'REDIS_URL=redis://127.0.0.1:6379',
    'CONNECTOR_URL=http://127.0.0.1:8080',
    'SERVICE_IDENTITY_SECRET=AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=',
  ].join('\n') + '\n');
  const buildLog = path.join(temporaryRoot, 'builds.log');
  await writeFile(path.join(projectRoot, 'node_modules/typescript/bin/tsc'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.appendFileSync(process.env.DEV_ISOLATION_BUILD_LOG, 'build\\n');",
    "const output = path.join(process.cwd(), 'vendor/contracts/dist/generated.js');",
    "fs.mkdirSync(path.dirname(output), { recursive: true });",
    "fs.writeFileSync(output, 'exports.generated = true;\\n');",
  ].join('\n'));
  return { temporaryRoot, projectRoot, buildLog };
}

function readBuildCount(buildLog) {
  return fs.readFile(buildLog, 'utf8').then((text) => text.trim().split('\n').filter(Boolean).length).catch(() => 0);
}

function runnerEnvironment(buildLog) {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.DEV_ISOLATION_BUILD_LOG = buildLog;
  env.DEV_PARENT_SECRET = 'must-not-reach-worker';
  return env;
}

function startRunner(fixture) {
  const child = spawn(process.execPath, [path.join(fixture.projectRoot, 'scripts/dev.cjs'), '--skip-build'], {
    cwd: fixture.projectRoot,
    env: runnerEnvironment(fixture.buildLog),
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  return { child, get output() { return output; } };
}

async function waitFor(predicate, description, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Dev runner did not exit after shutdown request')), timeoutMs);
    child.once('exit', (code) => { clearTimeout(timer); resolve(code); });
  });
}

async function stopRunner(child) {
  if (child.exitCode !== null) return;
  if (child.connected) child.send('dugate:shutdown');
  else child.kill('SIGTERM');
  await waitForExit(child);
}

function forceStopTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
  }
}

test('dev rebuilds local vendored source, ignores generated vendor dist, and keeps secrets out of worker child', { timeout: 45_000 }, async () => {
  const fixture = await createFixture();
  let runner;
  try {
    runner = startRunner(fixture);
    await waitFor(() => runner.output.includes('fixture-worker-start'), 'the fixture worker to start');
    assert.match(runner.output, /fixture-worker-start false false/);
    assert.match(runner.output, /Watching worker source and vendored package source/);

    await writeFile(path.join(fixture.projectRoot, 'vendor/contracts/src/index.ts'), 'export const fixture = false;\n');
    await waitFor(async () => (await readBuildCount(fixture.buildLog)) === 1, 'the vendored source build');
    await waitFor(() => (runner.output.match(/fixture-worker-start/g) || []).length === 2, 'the fixture worker restart');
    assert.match(runner.output, /fixture-worker-start false false/);

    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal(await readBuildCount(fixture.buildLog), 1, 'generated vendor dist output must not trigger another build');
    assert.equal((runner.output.match(/fixture-worker-start/g) || []).length, 2);

    await stopRunner(runner.child);
    assert.equal(runner.child.exitCode, 0);
  } finally {
    if (runner?.child.exitCode === null) {
      try { await stopRunner(runner.child); } catch { forceStopTree(runner.child); }
    }
    await fs.rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
