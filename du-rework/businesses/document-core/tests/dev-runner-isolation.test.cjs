'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { test } = require('node:test');

const SOURCE_PROJECT = path.resolve(__dirname, '..');

async function writeFile(filePath, contents) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, contents, 'utf8');
}

async function createFixture({ profile = true } = {}) {
  const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'document-core-dev-isolation-'));
  const projectRoot = path.join(temporaryRoot, 'businesses/document-core');
  const externalSource = path.join(temporaryRoot, 'orchestrator/packages/contracts/src/index.ts');
  const buildLog = path.join(temporaryRoot, 'builds.jsonl');
  const profilePath = path.join(projectRoot, '.env.local');

  for (const directory of [
    'scripts', 'src', 'vendor/contracts/src', 'vendor/worker-sdk',
    'vendor/worker-sdk/node_modules/@du/observability',
    'node_modules/@du/contracts',
    'node_modules/@du/egress', 'node_modules/@du/document-kit',
    'node_modules/@du/worker-sdk',
  ]) await fs.mkdir(path.join(projectRoot, directory), { recursive: true });
  await writeFile(path.join(projectRoot, 'node_modules/typescript/bin/tsc'), '');

  await fs.copyFile(path.join(SOURCE_PROJECT, 'scripts/dev.cjs'), path.join(projectRoot, 'scripts/dev.cjs'));
  await fs.copyFile(path.join(SOURCE_PROJECT, 'scripts/dev-child.cjs'), path.join(projectRoot, 'scripts/dev-child.cjs'));
  await fs.copyFile(path.join(SOURCE_PROJECT, 'scripts/local-env.cjs'), path.join(projectRoot, 'scripts/local-env.cjs'));
  await writeFile(path.join(projectRoot, 'scripts/build.cjs'), [
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    "fs.appendFileSync(process.env.DC_DEV_BUILD_LOG, JSON.stringify({ cwd: process.cwd(), args: process.argv.slice(2) }) + '\\n');",
    "if (fs.existsSync(path.join('src', 'build-failure.ts'))) { process.exitCode = 2; return; }",
    "fs.mkdirSync('dist', { recursive: true });",
    "fs.mkdirSync(path.join('vendor', 'contracts', 'dist'), { recursive: true });",
    "fs.writeFileSync(path.join('vendor', 'contracts', 'dist', 'index.js'), 'exports.local = true;\\n');",
    'const worker = [',
    "  \"console.log('fixture-worker-start');\",",
    "  \"console.log('fixture-worker-secret:' + Boolean(process.env.SERVICE_IDENTITY_SECRET));\",",
    "  \"console.log('fixture-safe-path:' + Boolean(process.env.PATH || process.env.Path));\",",
    "  \"console.log('fixture-runtime-token-source:' + (process.env.RUNTIME_TOKEN === 'fixture-runtime-token' ? 'profile' : 'ambient'));\",",
    "  \"process.on('SIGTERM', () => { console.log('fixture-worker-stop'); process.exit(0); });\",",
    "  'setInterval(() => undefined, 60_000);',",
    "].join(String.fromCharCode(10));",
    "fs.writeFileSync(path.join('dist', 'main.js'), worker + String.fromCharCode(10));",
    '',
  ].join('\n'));
  await writeFile(path.join(projectRoot, 'src/main.ts'), 'export {}\n');
  await writeFile(path.join(projectRoot, 'vendor/contracts/src/index.ts'), 'export const local = true;\n');
  await writeFile(externalSource, 'export const external = true;\n');

  if (profile) {
    const profileValues = {
      RUNTIME_URL: 'http://127.0.0.1:3002/api/runtime/v1',
      RUNTIME_TOKEN: 'fixture-runtime-token',
      REDIS_URL: 'redis://127.0.0.1:16380',
      CONNECTOR_URL: 'http://127.0.0.1:8088',
      SERVICE_IDENTITY_SECRET: Buffer.alloc(32).toString('base64'),
    };
    await writeFile(profilePath, Object.entries(profileValues).map(([key, value]) => `${key}=${value}`).join('\n') + '\n');
  }

  return { temporaryRoot, projectRoot, externalSource, buildLog, profilePath };
}

function readBuilds(buildLog) {
  return fs.readFile(buildLog, 'utf8')
    .then((contents) => contents.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)))
    .catch(() => []);
}

function safeProcessEnvironment(buildLog, inherited = {}) {
  const env = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'ComSpec', 'COMSPEC', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) {
    if (process.env[name]) env[name] = process.env[name];
  }
  env.DC_DEV_BUILD_LOG = buildLog;
  return { ...env, ...inherited };
}

function startRunner(fixture, args = [], inherited = {}) {
  const child = spawn(process.execPath, [path.join(fixture.projectRoot, 'scripts/dev.cjs'), ...args], {
    cwd: fixture.projectRoot,
    env: safeProcessEnvironment(fixture.buildLog, inherited),
    stdio: args.includes('--check') ? ['ignore', 'pipe', 'pipe'] : ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  let output = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { output += chunk; });
  return { child, get output() { return output; } };
}

async function waitFor(predicate, description, timeoutMs = 20_000) {
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
    let settled = false;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve(code);
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.removeListener('exit', finish);
      reject(new Error('Runner did not exit after shutdown request'));
    }, timeoutMs);
    child.once('exit', finish);
    if (child.exitCode !== null) finish(child.exitCode);
  });
}

async function stopRunner(child) {
  if (child.exitCode !== null) return;
  if (child.connected) child.send('dugate:shutdown');
  else child.kill('SIGTERM');
  await waitForExit(child);
}

function forceStopRunnerTree(child) {
  if (!child?.pid || child.exitCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

test('local runner watches only worker and vendored sources, recovers from build errors, and stops cleanly', { timeout: 60_000 }, async () => {
  const fixture = await createFixture();
  let runner;
  try {
    runner = startRunner(fixture, [], { RUNTIME_TOKEN: 'ambient-runtime-token' });
    await waitFor(async () => (await readBuilds(fixture.buildLog)).length === 1, 'initial local build');
    await waitFor(() => runner.output.includes('fixture-worker-start'), 'worker startup');
    assert.equal((runner.output.match(/fixture-worker-secret:true/g) || []).length, 0, 'signing secret must be stripped from the worker');
    assert.match(runner.output, /fixture-safe-path:true/, 'safe process PATH must reach the worker');
    assert.match(runner.output, /fixture-runtime-token-source:profile/, 'a local profile must take precedence over ambient worker settings');
    assert.match(runner.output, /Watching Document Core and vendored package source/);
    assert.equal((await readBuilds(fixture.buildLog))[0].cwd, fixture.projectRoot);

    await writeFile(path.join(fixture.projectRoot, 'vendor/contracts/src/index.ts'), 'export const local = false;\n');
    await waitFor(async () => (await readBuilds(fixture.buildLog)).length === 2, 'vendored source rebuild');
    await waitFor(() => (runner.output.match(/fixture-worker-start/g) || []).length === 2, 'worker restart after vendored edit');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal((await readBuilds(fixture.buildLog)).length, 2, 'generated vendor dist files must not trigger repeated builds');

    await writeFile(fixture.externalSource, 'export const external = false;\n');
    await new Promise((resolve) => setTimeout(resolve, 800));
    assert.equal((await readBuilds(fixture.buildLog)).length, 2, 'parent workspace edits must not trigger a local build');

    await writeFile(path.join(fixture.projectRoot, 'src/build-failure.ts'), 'deliberate fixture failure\n');
    await waitFor(async () => (await readBuilds(fixture.buildLog)).length === 3 && runner.output.includes('Local build failed.'), 'local build failure');
    await waitFor(() => (runner.output.match(/fixture-worker-stop/g) || []).length === 2, 'worker stop after failed build');
    assert.equal((runner.output.match(/fixture-worker-start/g) || []).length, 2, 'failed build leaves the worker stopped');

    await fs.rm(path.join(fixture.projectRoot, 'src/build-failure.ts'));
    await waitFor(async () => (await readBuilds(fixture.buildLog)).length === 4 && (runner.output.match(/fixture-worker-start/g) || []).length === 3, 'worker recovery');
    await stopRunner(runner.child);
    assert.equal(runner.child.exitCode, 0);
    assert.equal((runner.output.match(/fixture-worker-stop/g) || []).length, 3, 'worker stops cleanly with the runner');
  } finally {
    if (runner?.child.exitCode === null) {
      try { await stopRunner(runner.child); } catch { forceStopRunnerTree(runner.child); }
      if (runner.child.exitCode === null) {
        try { await waitForExit(runner.child, 2_000); } catch {}
      }
    }
    await fs.rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('runner accepts the parent launcher’s inherited local environment without reading a worker profile', { timeout: 30_000 }, async () => {
  const fixture = await createFixture({ profile: false });
  let runner;
  try {
    runner = startRunner(fixture, ['--inherited-env', '--check'], {
      RUNTIME_URL: 'http://127.0.0.1:3002/api/runtime/v1',
      RUNTIME_TOKEN: 'fixture-runtime-token',
      REDIS_URL: 'redis://127.0.0.1:16380',
      CONNECTOR_URL: 'http://127.0.0.1:8088',
      CONNECTOR_SERVICE_TOKEN: 'fixture-connector-token',
    });
    assert.equal(await waitForExit(runner.child), 0);
    assert.match(runner.output, /inherited local worker environment/);
    assert.match(runner.output, /Local configuration is valid/);
    assert.equal((await readBuilds(fixture.buildLog)).length, 0, '--check must not build');
  } finally {
    if (runner?.child.exitCode === null) await stopRunner(runner.child);
    await fs.rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});

test('runner reports a missing local workspace installation before building', { timeout: 30_000 }, async () => {
  const fixture = await createFixture();
  let runner;
  try {
    await fs.rm(path.join(fixture.projectRoot, 'node_modules/@du/contracts'), { recursive: true, force: true });
    runner = startRunner(fixture, ['--skip-build']);
    assert.equal(await waitForExit(runner.child), 1);
    assert.match(runner.output, /Local workspace link @du\/contracts is missing/);
    assert.match(runner.output, /pnpm install --frozen-lockfile/);
    assert.equal((await readBuilds(fixture.buildLog)).length, 0, 'a missing dependency must fail before invoking the build');
  } finally {
    if (runner?.child.exitCode === null) await stopRunner(runner.child);
    await fs.rm(fixture.temporaryRoot, { recursive: true, force: true });
  }
});
