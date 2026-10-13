#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CHILD_SHIM = path.join(PROJECT_ROOT, 'scripts/dev-child.cjs');
const DEFAULT_ENV_FILE = path.join(PROJECT_ROOT, '.env.local');
const { displayEndpoint, loadWorkerEnvironment } = require('./local-env.cjs');

let workerChild;
let buildChild;
let stopping = false;
let shutdownPromise;
const sourceWatchers = [];
let reloadTimer;
let reloadPending = false;
let reloadPromise;
let workerEnvironment;

function systemEnvironment() {
  const environment = {};
  for (const name of ['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'HOME']) {
    if (process.env[name]) environment[name] = process.env[name];
  }
  return environment;
}

function usage() {
  console.log('Usage: pnpm run dev [--env-file=PATH] [--skip-build] [--check] [--no-watch] [--inherited-env]\n\nOptions:\n  --env-file=PATH   Read an explicit profile (relative paths use this package directory)\n  --skip-build      Reuse the existing local build\n  --check           Validate local configuration without building or starting services\n  --no-watch        Build once and start the worker without source reload\n  --watch           Alias for the default watch mode\n  --inherited-env   Use an explicitly supplied worker environment (for root delegation)\n  --help            Show this help message');
}

function resolveProfile(args) {
  const inherited = args.includes('--inherited-env');
  const envArg = args.find((arg) => arg.startsWith('--env-file='));
  if (envArg && inherited) throw new Error('Choose either --env-file or --inherited-env.');
  if (envArg) {
    const requested = envArg.slice('--env-file='.length);
    const resolved = path.resolve(PROJECT_ROOT, requested);
    if (!fs.existsSync(resolved)) throw new Error(`Environment profile not found: ${resolved}`);
    return { profilePath: resolved, overrides: {} };
  }
  if (inherited) return { profilePath: undefined, overrides: process.env };
  if (fs.existsSync(DEFAULT_ENV_FILE)) return { profilePath: DEFAULT_ENV_FILE, overrides: {} };
  throw new Error(`Example Review local profile is missing at ${DEFAULT_ENV_FILE}. Copy .env.local.example to .env.local and set the existing business runtime token.`);
}

function validateLocalWorkspaceInstall() {
  const compiler = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(compiler)) {
    throw new Error(`TypeScript is missing from ${path.join(PROJECT_ROOT, 'node_modules')}. Run pnpm install --frozen-lockfile in businesses/example-review.`);
  }
  const packageRoots = [PROJECT_ROOT];
  for (const entry of fs.readdirSync(path.join(PROJECT_ROOT, 'vendor'), { withFileTypes: true })) {
    if (entry.isDirectory() && fs.existsSync(path.join(PROJECT_ROOT, 'vendor', entry.name, 'package.json'))) {
      packageRoots.push(path.join(PROJECT_ROOT, 'vendor', entry.name));
    }
  }
  for (const packageRoot of packageRoots) {
    const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'package.json'), 'utf8'));
    const dependencies = { ...manifest.dependencies, ...manifest.devDependencies };
    for (const name of Object.keys(dependencies).filter((dependency) => dependency.startsWith('@du/'))) {
      const dependency = name.slice('@du/'.length);
      const link = path.join(packageRoot, 'node_modules', '@du', dependency);
      const expected = path.resolve(PROJECT_ROOT, 'vendor', dependency);
      let resolved;
      try { resolved = fs.realpathSync(link); } catch {
        throw new Error(`Local workspace link ${name} is missing under ${path.relative(PROJECT_ROOT, packageRoot) || '.'}. Run pnpm install --frozen-lockfile in businesses/example-review.`);
      }
      if (resolved.toLowerCase() !== fs.realpathSync(expected).toLowerCase()) {
        throw new Error(`Workspace link ${name} does not resolve to this worker's vendor directory.`);
      }
    }
  }
}

function buildWorkerPackageAsync() {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(PROJECT_ROOT, 'scripts', 'build.cjs')], {
      cwd: PROJECT_ROOT,
      detached: process.platform !== 'win32',
      stdio: 'inherit',
      windowsHide: true,
    });
    buildChild = child;
    child.once('error', (error) => {
      if (buildChild === child) buildChild = undefined;
      reject(error);
    });
    child.once('exit', (code, signal) => {
      if (buildChild === child) buildChild = undefined;
      if (stopping) return resolve(false);
      if (code === 0) resolve(true);
      else reject(new Error(`Example Review local build failed (${code ?? signal ?? 'unknown exit'}).`));
    });
  });
}

function start(environment) {
  const child = spawn(process.execPath, ['--require', CHILD_SHIM, path.join(PROJECT_ROOT, 'dist/main.js')], {
    cwd: PROJECT_ROOT,
    env: environment,
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    windowsHide: true,
  });
  workerChild = child;
  child.once('error', (error) => {
    console.error(`[example-review] Failed to start: ${error.message}`);
    void shutdown(1);
  });
  child.once('exit', (code, signal) => {
    if (workerChild === child) workerChild = undefined;
    if (!stopping && !child.expectedExit) {
      console.error(`[example-review] Worker exited (${code ?? signal}); stopping dev session.`);
      void shutdown(code || 1);
    }
  });
  return child;
}

function forceTerminate(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} }
}

function stopWorker() {
  const child = workerChild;
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  child.expectedExit = true;
  return new Promise((resolve) => {
    let finished = false;
    let timer;
    const finish = () => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.removeListener('exit', finish);
      resolve();
    };
    timer = setTimeout(() => {
      console.warn('[example-review] Worker did not stop cleanly; terminating its owned process tree.');
      forceTerminate(child);
      setTimeout(finish, 1000).unref?.();
    }, 20_000);
    child.once('exit', finish);
    if (process.platform === 'win32') {
      if (!child.connected) forceTerminate(child);
      else child.send('dugate:shutdown', (error) => { if (error) forceTerminate(child); });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch { try { child.kill('SIGTERM'); } catch {} }
    }
  });
}

async function shutdown(code = 0) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  process.exitCode = code;
  clearTimeout(reloadTimer);
  for (const watcher of sourceWatchers) watcher.close();
  shutdownPromise = (async () => {
    if (buildChild) forceTerminate(buildChild);
    if (reloadPromise) {
      try { await reloadPromise; } catch {}
    }
    await stopWorker();
    if (process.connected) process.disconnect();
  })();
  return shutdownPromise;
}

function scheduleWorkerReload(reason) {
  if (stopping) return;
  reloadPending = true;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (!reloadPromise) {
      reloadPromise = reloadWorker(reason).finally(() => {
        reloadPromise = undefined;
        if (reloadPending && !stopping) scheduleWorkerReload('additional source changes');
      });
    }
  }, 450);
}

async function reloadWorker(reason) {
  while (reloadPending && !stopping) {
    reloadPending = false;
    console.log(`[example-review] Source changed (${reason}); rebuilding worker before restart...`);
    await stopWorker();
    if (stopping) return;
    try {
      validateLocalWorkspaceInstall();
      const result = await buildWorkerPackageAsync();
      if (!result || stopping || reloadPending) continue;
      console.log('[example-review] Build succeeded; restarting worker.');
      start(workerEnvironment);
    } catch (error) {
      if (!stopping) console.error(`[example-review] Local build failed. Worker remains stopped until a successful source build: ${error.message}`);
    }
  }
}

function watchSourceDirectory(directory) {
  const watchedPath = path.join(PROJECT_ROOT, directory);
  const watcher = fs.watch(watchedPath, { recursive: true }, (_eventType, filename) => {
    if (filename === null || filename === undefined) return scheduleWorkerReload(directory === 'vendor' ? 'vendored package source' : 'worker source');
    const relative = String(filename).replace(/\\/g, '/');
    if (/(^|\/)(?:dist|node_modules|\.git)(\/|$)/.test(relative)) return;
    if (/\.(?:ts|tsx|js|json|yaml|tgz)$/.test(relative)) scheduleWorkerReload(directory === 'vendor' ? 'vendored package source' : 'worker source');
  });
  watcher.on('error', (error) => {
    console.error(`[example-review] Watcher failed for ${directory}: ${error.message}`);
    void shutdown(1);
  });
  sourceWatchers.push(watcher);
}

function startWatchers() {
  watchSourceDirectory('src');
  watchSourceDirectory('vendor');
  const configFiles = ['package.json', 'tsconfig.json', 'pnpm-workspace.yaml'];
  const configWatcher = fs.watch(PROJECT_ROOT, (_eventType, filename) => {
    if (filename && configFiles.includes(String(filename))) scheduleWorkerReload(String(filename));
  });
  configWatcher.on('error', (error) => {
    console.error(`[example-review] Config watcher failed: ${error.message}`);
    void shutdown(1);
  });
  sourceWatchers.push(configWatcher);
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) return usage();
  if (args.includes('--no-watch') && args.includes('--watch')) throw new Error('Choose either --watch or --no-watch.');
  for (const arg of args) {
    if (!['--check', '--skip-build', '--no-watch', '--watch', '--inherited-env'].includes(arg) && !arg.startsWith('--env-file=')) {
      throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
    }
  }

  const { profilePath, overrides } = resolveProfile(args);
  const loadedEnvironment = loadWorkerEnvironment(profilePath, overrides);
  workerEnvironment = { ...systemEnvironment(), ...loadedEnvironment.workerEnvironment };
  const { runtimeUrl, redisUrl } = loadedEnvironment;
  console.log(`[example-review] Using ${args.includes('--inherited-env') ? 'explicitly inherited worker environment' : path.relative(PROJECT_ROOT, profilePath)}.`);
  console.log(`[example-review] Runtime: ${displayEndpoint(runtimeUrl)} (internal listener)`);
  console.log(`[example-review] Redis: ${displayEndpoint(redisUrl)}`);

  if (args.includes('--check')) {
    console.log('[example-review] Local configuration is valid; no build or services were started.');
    return;
  }
  validateLocalWorkspaceInstall();
  if (!args.includes('--skip-build')) await buildWorkerPackageAsync();
  if (stopping) return;
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'dist/main.js'))) {
    throw new Error('Example Review build output is missing. Run pnpm run dev without --skip-build.');
  }
  console.log('[example-review] Starting worker (no HTTP listener; PORT=0). Press Ctrl+C to stop.');
  start(workerEnvironment);
  if (!args.includes('--no-watch')) {
    startWatchers();
    console.log('[example-review] Watching worker source and vendored package source.');
  } else {
    console.log('[example-review] Watch mode disabled; restart this command after source edits.');
  }
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
process.on('message', (message) => { if (message === 'dugate:shutdown') void shutdown(0); });

main().catch((error) => {
  console.error('[example-review] Dev command failed:', error instanceof Error ? error.message : 'unknown error');
  void shutdown(1);
});
