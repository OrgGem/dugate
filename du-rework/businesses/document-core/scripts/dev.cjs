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

function usage() {
  console.log('Usage: pnpm run dev [--env-file=PATH|--inherited-env] [--skip-build] [--check] [--no-watch]\n\nOptions:\n  --env-file=PATH   Read an explicit profile (relative paths use this package directory)\n  --inherited-env   Use only worker settings supplied by a parent launcher\n  --skip-build      Reuse the existing Document Core build\n  --check           Validate local configuration without building or starting services\n  --no-watch        Build once and start the worker without source reload\n  --watch           Alias for the default watch mode\n  --help            Show this help message');
}

function resolveProfile(args) {
  if (args.includes('--inherited-env') && args.some((arg) => arg.startsWith('--env-file='))) {
    throw new Error('Choose either --inherited-env or --env-file=PATH.');
  }
  if (args.includes('--inherited-env')) return undefined;
  const envArg = args.find((arg) => arg.startsWith('--env-file='));
  if (envArg) {
    const requested = envArg.slice('--env-file='.length);
    const resolved = path.resolve(PROJECT_ROOT, requested);
    if (!fs.existsSync(resolved)) throw new Error(`Environment profile not found: ${resolved}`);
    return resolved;
  }

  if (fs.existsSync(DEFAULT_ENV_FILE)) return DEFAULT_ENV_FILE;
  if (process.env.RUNTIME_TOKEN && process.env.RUNTIME_URL && process.env.REDIS_URL) return undefined;
  throw new Error(`Document Core local profile is missing at ${DEFAULT_ENV_FILE}. Copy .env.example to .env.local and set the existing worker token and service identity secret, or pass --env-file=PATH. Inherited Runtime/Redis environment values are also accepted.`);
}

function loadEnvironment(profilePath) {
  return loadWorkerEnvironment(profilePath);
}

function validateLocalWorkspaceInstall() {
  const compiler = path.join(PROJECT_ROOT, 'node_modules', 'typescript', 'bin', 'tsc');
  if (!fs.existsSync(compiler)) {
    throw new Error(`TypeScript is missing from ${path.join(PROJECT_ROOT, 'node_modules')}. Run pnpm install --frozen-lockfile in businesses/document-core.`);
  }
  const dependencies = [
    { name: 'contracts', packageRoot: PROJECT_ROOT },
    { name: 'egress', packageRoot: PROJECT_ROOT },
    { name: 'document-kit', packageRoot: PROJECT_ROOT },
    { name: 'worker-sdk', packageRoot: PROJECT_ROOT },
    { name: 'observability', packageRoot: path.join(PROJECT_ROOT, 'vendor', 'worker-sdk') },
  ];
  for (const { name, packageRoot } of dependencies) {
    const link = path.join(packageRoot, 'node_modules', '@du', name);
    if (!fs.existsSync(link)) {
      throw new Error(`Local workspace link @du/${name} is missing for ${path.relative(PROJECT_ROOT, packageRoot)}. Run pnpm install --frozen-lockfile in businesses/document-core.`);
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
      else reject(new Error(`Document Core local build failed (${code ?? signal ?? 'unknown exit'}).`));
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
    console.error(`[document-core] Failed to start: ${error.message}`);
    void shutdown(1);
  });
  child.once('exit', (code, signal) => {
    if (workerChild === child) workerChild = undefined;
    if (!stopping && !child.expectedExit) {
      console.error(`[document-core] Worker exited (${code ?? signal}); stopping dev session.`);
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
      console.warn('[document-core] Worker did not stop cleanly; terminating its owned process tree.');
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
    console.log(`[document-core] Source changed (${reason}); rebuilding worker before restart...`);
    await stopWorker();
    if (stopping) return;
    try {
      validateLocalWorkspaceInstall();
      const result = await buildWorkerPackageAsync();
      if (!result || stopping || reloadPending) continue;
      console.log('[document-core] Build succeeded; restarting worker.');
      start(workerEnvironment);
    } catch (error) {
      if (!stopping) console.error(`[document-core] Local build failed. Worker remains stopped until a successful Document Core source build: ${error.message}`);
    }
  }
}

function startWatchers() {
  for (const directory of ['src', 'vendor']) {
    const watchedPath = path.join(PROJECT_ROOT, directory);
    const watcher = fs.watch(watchedPath, { recursive: true }, (_eventType, filename) => {
      if (filename === null || filename === undefined) return;
      const relativeFile = String(filename).replace(/\\/g, '/');
      const pathSegments = relativeFile.split('/');
      if (pathSegments.some((segment) => ['dist', 'node_modules', 'coverage'].includes(segment))) return;
      if (/\.(?:ts|tsx|js|json|yaml|tgz)$/.test(relativeFile)) {
        scheduleWorkerReload(directory === 'vendor' ? 'vendored package source' : 'Document Core source');
      }
    });
    watcher.on('error', (error) => {
      console.error(`[document-core] Watcher failed for ${directory}: ${error.message}`);
      void shutdown(1);
    });
    sourceWatchers.push(watcher);
  }
  const configFiles = ['package.json', 'tsconfig.json', 'pnpm-workspace.yaml'];
  const configWatcher = fs.watch(PROJECT_ROOT, (_eventType, filename) => {
    if (filename && configFiles.includes(String(filename))) scheduleWorkerReload(String(filename));
  });
  configWatcher.on('error', (error) => {
    console.error(`[document-core] Config watcher failed: ${error.message}`);
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

  const profilePath = resolveProfile(args);
  const loadedEnvironment = loadEnvironment(profilePath);
  workerEnvironment = loadedEnvironment.workerEnvironment;
  const { runtimeUrl, connectorUrl, redisUrl } = loadedEnvironment;
  console.log(`[document-core] Using ${profilePath ? path.relative(PROJECT_ROOT, profilePath) : 'inherited local worker environment'}.`);
  console.log(`[document-core] Runtime: ${displayEndpoint(runtimeUrl)} (internal listener)`);
  console.log(`[document-core] Redis: ${displayEndpoint(redisUrl)}`);
  console.log(`[document-core] Connector: ${displayEndpoint(connectorUrl)}`);

  if (args.includes('--check')) {
    console.log('[document-core] Local configuration is valid; no build or services were started.');
    return;
  }
  validateLocalWorkspaceInstall();
  if (!args.includes('--skip-build')) await buildWorkerPackageAsync();
  if (stopping) return;
  if (!fs.existsSync(path.join(PROJECT_ROOT, 'dist/main.js'))) {
    throw new Error('Document Core build output is missing. Run pnpm run dev without --skip-build.');
  }
  console.log('[document-core] Starting worker (no HTTP listener; PORT=0). Press Ctrl+C to stop.');
  start(workerEnvironment);
  if (!args.includes('--no-watch')) {
    startWatchers();
    console.log('[document-core] Watching Document Core and vendored package source.');
  } else {
    console.log('[document-core] Watch mode disabled; restart this command after source edits.');
  }
}

process.on('SIGINT', () => { void shutdown(0); });
process.on('SIGTERM', () => { void shutdown(0); });
process.on('message', (message) => { if (message === 'dugate:shutdown') void shutdown(0); });

main().catch((error) => {
  console.error('[document-core] Dev command failed:', error instanceof Error ? error.message : 'unknown error');
  void shutdown(1);
});
