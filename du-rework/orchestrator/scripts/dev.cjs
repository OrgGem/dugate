#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const { createRequire } = require('node:module');
const { createHmac } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const readline = require('node:readline');
const { pathToFileURL } = require('node:url');
const { parseEnv } = require('node:util');
const {
  serviceEnvironment,
  localConnectorManagementEnvironment,
  validateRuntimeEnvironment,
} = require('./runtime-env.cjs');
const { createAdminWebDevServerOptions } = require('./dev-admin-web.cjs');
const { assertExternalDependenciesReachable } = require('./runtime-dependencies.cjs');
const { resolveLocalPath } = require('./local-paths.cjs');
const sourceWatch = require('./dev-source-watch.cjs');

const ROOT = path.resolve(__dirname, '..');
const WORKSPACE_ROOT = ROOT;
const ADMIN_WEB_ROOT = path.join(ROOT, 'apps/admin-web');
const CHILD_SHIM = path.join(WORKSPACE_ROOT, 'scripts/dev-child.cjs');
const buildCoordinator = require('./dev-build-coordinator.cjs');
const children = new Set();
const activeServices = new Map();
const sourceWatchers = [];
let stopping = false;
let shutdownPromise;
let viteServer;
let buildChild;
let reloadTimer;
let sourceFingerprintTimer;
let sourceInputTracker;
let reloadPending = false;
let reloadPromise;
let reloadSequence = 0;
let watchEnabled = true;
let internalAdminShellPort;
let mockVaultService;

function forceTerminate(child) {
  if (!child?.pid || child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore', windowsHide: true });
    return;
  }
  try { process.kill(-child.pid, 'SIGKILL'); } catch {
    try { child.kill('SIGKILL'); } catch {}
  }
}

function stopChild(child, timeoutMs = 45_000) {
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
      console.warn(`[dev] ${child.devName || 'Child process'} did not stop cleanly; terminating its owned process tree.`);
      forceTerminate(child);
      setTimeout(finish, 1000).unref?.();
    }, timeoutMs);
    child.once('exit', finish);

    if (process.platform === 'win32') {
      if (!child.connected) forceTerminate(child);
      else child.send('dugate:shutdown', (error) => { if (error) forceTerminate(child); });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {
        try { child.kill('SIGTERM'); } catch {}
      }
    }
  });
}

async function shutdown(code = 0) {
  if (shutdownPromise) return shutdownPromise;
  stopping = true;
  process.exitCode = code;
  clearTimeout(reloadTimer);
  clearTimeout(sourceFingerprintTimer);
  for (const watcher of sourceWatchers) watcher.close();

  shutdownPromise = (async () => {
    if (buildChild) forceTerminate(buildChild);
    if (reloadPromise) {
      try { await reloadPromise; } catch {}
    }
    if (viteServer) {
      try { await viteServer.close(); } catch (error) {
        console.error('[dev] Admin Web shutdown failed:', error.message);
        process.exitCode = 1;
      }
      viteServer = undefined;
    }
    await Promise.all([...activeServices.values()].map((child) => stopChild(child)));
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) await stopChild(child);
    }
    if (mockVaultService) {
      const service = mockVaultService;
      mockVaultService = undefined;
      try { await service.stop(); } catch (error) {
        console.error('[dev] Mock Vault shutdown failed:', error.message);
        process.exitCode = 1;
      }
    }
  })();
  return shutdownPromise;
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`Prerequisite command failed: node ${args.join(' ')}`);
}

function runNodeAsync(args) {
  return new Promise((resolve, reject) => {
    if (stopping) return reject(new Error('Development session is shutting down.'));
    const child = spawn(process.execPath, args, {
      cwd: ROOT,
      stdio: 'inherit',
      env: process.env,
      detached: process.platform !== 'win32',
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
      else reject(new Error(`Build command failed (${code ?? signal ?? 'unknown exit'}): node ${args.join(' ')}`));
    });
  });
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

async function findInternalAdminShellPort(start, excluded) {
  for (let port = start; port <= 65535; port++) {
    if (excluded.has(port)) continue;
    if (await isPortAvailable(port)) return port;
  }
  throw new Error('No available loopback port for the Admin Shell behind the Vite dev server.');
}

async function waitForReady(url, name, maxWaitMs = 30000) {
  const end = Date.now() + maxWaitMs;
  while (!stopping && Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  throw new Error(`Service ${name} failed to become ready at ${url}`);
}

function startProcess(name, relativeEntry, envOverrides = {}) {
  const entryPath = path.join(ROOT, relativeEntry);
  const child = spawn(process.execPath, ['--require', CHILD_SHIM, entryPath], {
    cwd: ROOT,
    env: serviceEnvironment({ ...process.env, ...envOverrides }, name),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    windowsHide: true,
  });
  child.devName = name;
  children.add(child);
  activeServices.set(name, child);

  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => console.log(`[${name}] ${line}`));
  }
  child.once('error', (error) => {
    console.error(`[${name}] Failed to start:`, error.message);
    void shutdown(1);
  });
  child.once('exit', (code, signal) => {
    children.delete(child);
    if (activeServices.get(name) === child) activeServices.delete(name);
    if (!stopping && !child.expectedExit) {
      console.error(`[${name}] Exited (${code ?? signal}); stopping dev session`);
      void shutdown(code || 1);
    }
  });
  return child;
}

async function startServices() {
  if (stopping) return;
  console.log('\n[dev] Starting Orchestrator Backend...');
  startProcess('orchestrator', 'services/orchestrator/dist/main.js', watchEnabled
    ? { ADMIN_SHELL_PORT: String(internalAdminShellPort), ADMIN_SHELL_HOST: '127.0.0.1' }
    : {});
  console.log('[dev] Starting Connector Service...');
  startProcess('connector', 'services/connector/dist/entrypoint.js');

  console.log('[dev] Waiting for services to be ready...');
  try {
    await Promise.all([
      waitForReady(`http://127.0.0.1:${Number(process.env.ORCHESTRATOR_INTERNAL_PORT)}/health`, 'orchestrator'),
      waitForReady(`http://127.0.0.1:${Number(process.env.CONNECTOR_PORT)}/health/ready`, 'connector'),
    ]);
  } catch (error) {
    if (!stopping) throw error;
  }
}

async function startAdminWebDevServer(portalPort) {
  const proxyTarget = `http://127.0.0.1:${internalAdminShellPort}`;
  const requireFromAdminWeb = createRequire(path.join(ADMIN_WEB_ROOT, 'package.json'));
  const vitePath = requireFromAdminWeb.resolve('vite');
  const { createServer } = await import(pathToFileURL(vitePath).href);
  const server = await createServer({
    root: ADMIN_WEB_ROOT,
    configFile: path.join(ADMIN_WEB_ROOT, 'vite.config.ts'),
    ...createAdminWebDevServerOptions({ host: process.env.ADMIN_SHELL_HOST, port: portalPort, internalAdminShellPort }),
  });
  await server.listen();
  server.printUrls();
  console.log(`[dev] Admin BFF/auth proxy target: ${proxyTarget}`);
  return server;
}

function watchConfigDirectory(directory) {
  const watcher = fs.watch(directory, (_eventType, changed) => {
    if (sourceWatch.isRootConfigWatchEvent(changed)) scheduleBuildInputFingerprintCheck();
  });
  watcher.on('error', (error) => {
    console.error(`[dev] Root config watcher failed: ${error.message}`);
    void shutdown(1);
  });
  sourceWatchers.push(watcher);
}

function scheduleBuildInputFingerprintCheck() {
  clearTimeout(sourceFingerprintTimer);
  sourceFingerprintTimer = setTimeout(() => {
    sourceFingerprintTimer = undefined;
    if (!sourceInputTracker || stopping) return;
    try {
      if (sourceInputTracker.hasChanged()) scheduleRuntimeReload();
    } catch (error) {
      console.error(`[dev] Could not compare runtime build inputs: ${error.message}`);
    }
  }, 250);
}

function scheduleRuntimeReload() {
  reloadPending = true;
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => {
    if (!reloadPromise) {
      reloadPromise = reloadRuntimeServices().finally(() => {
        reloadPromise = undefined;
        if (reloadPending && !stopping) scheduleRuntimeReload();
      });
    }
  }, 450);
}

async function reloadRuntimeServices() {
  if (stopping) return;
  while (reloadPending && !stopping) {
    reloadPending = false;
    reloadSequence += 1;
    console.log(`\n[dev] Runtime source change detected; rebuilding and restarting services (change ${reloadSequence})...`);
    await Promise.all([...activeServices.values()].map((child) => stopChild(child)));
    if (stopping) return;

    try {
      const result = await buildCoordinator.withBuildLock(WORKSPACE_ROOT, async () => {
        buildCoordinator.publishBuildState(WORKSPACE_ROOT, 'building', { source: 'orchestrator', reason: 'watch-rebuild' });
        try {
          const built = await runNodeAsync(['scripts/build.cjs', '--backend-only']);
          if (!built || stopping || reloadPending) return false;
          buildCoordinator.publishBuildState(WORKSPACE_ROOT, 'ready', { source: 'orchestrator', reason: 'watch-rebuild' });
          return true;
        } catch (error) {
          if (!stopping) buildCoordinator.publishBuildState(WORKSPACE_ROOT, 'failed', { source: 'orchestrator', reason: 'watch-rebuild' });
          throw error;
        }
      }, { shouldStop: () => stopping });
      if (!result || reloadPending || stopping) continue;
      if (viteServer) {
        console.log('[dev] Refreshing Admin Web dependency prebundle after the shared package build.');
        await viteServer.restart(true);
      }
      if (stopping || reloadPending) continue;
      await startServices();
    } catch (error) {
      console.error(`[dev] Runtime rebuild failed. Services remain stopped until a successful source rebuild: ${error.message}`);
      if (reloadPending) continue;
    }
  }
}

function startRuntimeWatchers() {
  sourceInputTracker = sourceWatch.createBuildInputTracker(ROOT);
  for (const directory of ['packages', 'services']) {
    const target = path.join(ROOT, directory);
    const watcher = fs.watch(target, { recursive: true }, (_eventType, filename) => {
      if (sourceWatch.isRelevantWatchEvent(filename)) scheduleBuildInputFingerprintCheck();
    });
    watcher.on('error', (error) => {
      console.error(`[dev] Source watcher failed for ${directory}: ${error.message}`);
      void shutdown(1);
    });
    sourceWatchers.push(watcher);
  }
  watchConfigDirectory(ROOT);
}

function printReadyBanner(publicPort, internalPort, portalPort, connectorPort) {
  console.log('\n===============================================================');
  console.log('   \x1b[32m✔ Orchestrator Platform is RUNNING (Standalone Dev)\x1b[0m');
  console.log('===============================================================');
  console.log(` • \x1b[1mPublic API:\x1b[0m           http://127.0.0.1:${publicPort}`);
  console.log(` • \x1b[1mInternal API:\x1b[0m         http://127.0.0.1:${internalPort}`);
  console.log(` • \x1b[1mOrchestrator Portal:\x1b[0m  http://127.0.0.1:${portalPort}/admin/`);
  if (watchEnabled) console.log(` • \x1b[1mAdmin Shell BFF:\x1b[0m      http://127.0.0.1:${internalAdminShellPort} (proxied by Vite)`);
  console.log(` • \x1b[1mConnector Service:\x1b[0m    http://127.0.0.1:${connectorPort}`);
  if (watchEnabled) console.log(' • \x1b[1mReload:\x1b[0m                 Admin Web HMR; backend and Connector rebuild/restart');
  console.log('===============================================================\n');
}

function localCostControlEnvironment(env, { internalPort } = {}) {
  const result = { ...env };
  const hasUrl = typeof env.COST_CONTROL_CONNECTOR_URL === 'string' && env.COST_CONTROL_CONNECTOR_URL.length > 0;
  const hasToken = typeof env.COST_CONTROL_CONNECTOR_TOKEN === 'string' && env.COST_CONTROL_CONNECTOR_TOKEN.length > 0;
  if (hasUrl || hasToken || env.NODE_ENV !== 'development') return result;

  const encryptionKey = env.ENCRYPTION_KEY;
  if (typeof encryptionKey !== 'string' || Buffer.byteLength(encryptionKey, 'utf8') < 32) {
    throw new Error('Local cost-control defaults require ENCRYPTION_KEY with at least 32 bytes.');
  }
  if (!Number.isInteger(internalPort) || internalPort < 1 || internalPort > 65_535) {
    throw new Error('Local cost-control defaults require a valid ORCHESTRATOR_INTERNAL_PORT.');
  }

  const token = createHmac('sha256', Buffer.from(encryptionKey, 'utf8'))
    .update('dugate/native-dev/cost-control-connector/v1', 'utf8')
    .digest('base64url');
  const otherCredentials = [
    env.ADMIN_TOKEN,
    env.RUNTIME_TOKEN,
    env.USAGE_TOKEN,
    env.SERVICE_IDENTITY_SECRET,
    env.INVOCATION_GRANT_SECRET,
    env.CONNECTOR_INVOCATION_GRANT_SECRET,
    env.USAGE_SINK_TOKEN,
  ].filter((value) => typeof value === 'string' && value.length > 0);
  if (token === encryptionKey || otherCredentials.includes(token)) {
    throw new Error('Derived local cost-control token must be distinct from configured service credentials.');
  }

  result.COST_CONTROL_CONNECTOR_URL = `http://127.0.0.1:${internalPort}`;
  result.COST_CONTROL_CONNECTOR_TOKEN = token;
  return result;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  const args = rawArgs[0] === '--' ? rawArgs.slice(1) : rawArgs;
  if (args.includes('--help')) {
    console.log([
      'Usage: pnpm run dev [options]',
      '',
      'Options:',
      '  --env-file=PATH     Explicit path to environment file',
      '  --skip-build        Skip initial build of packages & services',
      '  --skip-migrate      Skip database migrations',
      '  --mock-vault        Explicitly use the local dev-only Vault mock',
      '  --no-watch          Build once and serve the built Admin Web bundle',
      '  --watch             Alias for the default watch mode',
      '  --help              Show this help message',
      '',
    ].join('\n'));
    return;
  }
  if (args.includes('--no-watch') && args.includes('--watch')) throw new Error('Choose either --watch or --no-watch.');
  watchEnabled = !args.includes('--no-watch');
  for (const arg of args) {
    if (!['--skip-build', '--skip-migrate', '--mock-vault', '--no-watch', '--watch'].includes(arg) && !arg.startsWith('--env-file=')) {
      throw new Error(`Unknown option: ${arg}. Use --help for usage.`);
    }
  }

  // 1. Locate environment file.
  let envFile;
  const customEnvArg = args.find((arg) => arg.startsWith('--env-file='));
  if (customEnvArg) {
    envFile = customEnvArg.slice('--env-file='.length);
  } else if (fs.existsSync(path.join(ROOT, '.env.local'))) {
    envFile = '.env.local';
  } else if (fs.existsSync(path.join(ROOT, '.env'))) {
    envFile = '.env';
  } else {
    throw new Error('No local environment file found. Create orchestrator/.env.local from .env.example and set DATABASE_URL and REDIS_URL for your external services.');
  }
  const resolvedEnvFile = resolveLocalPath(ROOT, envFile, '--env-file');
  console.log(`[dev] Using environment file: ${path.relative(ROOT, resolvedEnvFile)}`);
  const configured = { ...parseEnv(fs.readFileSync(resolvedEnvFile, 'utf8')), ...process.env };
  Object.assign(process.env, configured);
  if (args.includes('--mock-vault')) {
    if (process.env.DU_VAULT_MOCK === 'false') throw new Error('--mock-vault conflicts with DU_VAULT_MOCK=false; remove one of the settings.');
    process.env.DU_VAULT_MOCK = 'true';
  }

  // DU_VAULT_MOCK is opt-in. An existing real Vault profile is left intact
  // unless the operator explicitly selects the mock in the profile or CLI.
  try {
    if (process.env.DU_VAULT_MOCK === 'true' && process.env.DU_VAULT_MOCK_FIXTURE) {
      process.env.DU_VAULT_MOCK_FIXTURE = resolveLocalPath(ROOT, process.env.DU_VAULT_MOCK_FIXTURE, 'DU_VAULT_MOCK_FIXTURE');
    }
    const { applyMockVaultEnv } = require('../services/orchestrator/tests/mock-vault/bootstrap.cjs');
    const startedMock = await applyMockVaultEnv(process.env);
    if (stopping) {
      if (startedMock) await startedMock.stop();
      return;
    }
    mockVaultService = startedMock;
    if (startedMock) console.log('[dev] Local dev-only Vault mock enabled for Orchestrator KV and Transit.');
  } catch (error) {
    throw new Error(`Mock Vault setup failed: ${error.message}`);
  }

  // 2. Normalize local defaults.
  const defaults = {
    ORCHESTRATOR_PORT: '3000',
    ORCHESTRATOR_INTERNAL_PORT: '3002',
    ADMIN_SHELL_PORT: '3001',
    CONNECTOR_PORT: '8088',
    ORCHESTRATOR_HOST: '127.0.0.1',
    ORCHESTRATOR_INTERNAL_HOST: '127.0.0.1',
    ADMIN_SHELL_HOST: '127.0.0.1',
    HOST: '127.0.0.1',
    DU_ADMIN_WEB: '1',
    DU_ADMIN_WEB_DIST: path.join(ROOT, 'apps/admin-web/dist'),
    CONNECTOR_MIGRATION_DIRECTORY: path.join(ROOT, 'services/connector/src/db/migrations'),
    CONNECTOR_REDIS_PREFIX: 'du:connector:',
  };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
  if (process.env.CONNECTOR_MIGRATION_DIRECTORY.includes('orchestrator/services/connector')) {
    process.env.CONNECTOR_MIGRATION_DIRECTORY = path.join(ROOT, 'services/connector/src/db/migrations');
  }

  const publicPort = Number(process.env.ORCHESTRATOR_PORT);
  const internalPort = Number(process.env.ORCHESTRATOR_INTERNAL_PORT);
  const portalPort = Number(process.env.ADMIN_SHELL_PORT);
  const connectorPort = Number(process.env.CONNECTOR_PORT);
  process.env.ORCHESTRATOR_INTERNAL_BASE_URL ??= `http://127.0.0.1:${internalPort}`;
  process.env.RUNTIME_URL ??= `${process.env.ORCHESTRATOR_INTERNAL_BASE_URL}/api/runtime/v1`;
  process.env.CONNECTOR_URL ??= `http://127.0.0.1:${connectorPort}`;
  Object.assign(process.env, localCostControlEnvironment(process.env, { internalPort }));
  Object.assign(process.env, localConnectorManagementEnvironment(process.env, {
    services: 'all',
    connectorUrl: process.env.CONNECTOR_URL,
  }));
  validateRuntimeEnvironment(process.env, { services: 'all' });
  await assertExternalDependenciesReachable(process.env);

  const configuredPorts = [publicPort, internalPort, portalPort, connectorPort];
  if (new Set(configuredPorts).size !== configuredPorts.length) throw new Error('Orchestrator, Runtime, Admin, and Connector ports must be distinct.');
  for (const port of configuredPorts) {
    if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`Invalid local service port: ${port}`);
    if (!await isPortAvailable(port)) throw new Error(`Port ${port} is currently in use. Identify and stop its owner, or configure a different local port.`);
  }
  internalAdminShellPort = watchEnabled
    ? await findInternalAdminShellPort(portalPort + 1, new Set(configuredPorts))
    : portalPort;
  if (watchEnabled && !await isPortAvailable(internalAdminShellPort)) {
    throw new Error(`Admin Shell proxy port ${internalAdminShellPort} is currently in use.`);
  }

  // 3. Build prerequisites.
  const requiredArtifacts = [
    'services/orchestrator/dist/main.js',
    'services/connector/dist/entrypoint.js',
    'apps/admin-web/dist/index.html',
  ];
  const missingArtifacts = requiredArtifacts.some((file) => !fs.existsSync(path.join(ROOT, file)));
  if (!args.includes('--skip-build')) {
    await buildCoordinator.withBuildLock(ROOT, async () => {
      if (watchEnabled) buildCoordinator.publishBuildState(WORKSPACE_ROOT, 'building', { source: 'orchestrator', reason: 'initial-build' });
      try {
        runNode(['scripts/build.cjs']);
        if (watchEnabled) buildCoordinator.publishBuildState(WORKSPACE_ROOT, 'ready', { source: 'orchestrator', reason: 'initial-build' });
      } catch (error) {
        if (watchEnabled) buildCoordinator.publishBuildState(WORKSPACE_ROOT, 'failed', { source: 'orchestrator', reason: 'initial-build' });
        throw error;
      }
    }, { shouldStop: () => stopping });
  } else if (missingArtifacts) {
    throw new Error('Build artifacts are missing; remove --skip-build or run `pnpm run build` first.');
  } else if (watchEnabled) {
    buildCoordinator.publishBuildState(WORKSPACE_ROOT, 'ready', { source: 'orchestrator', reason: 'reused-build' });
  }

  // 4. Database migrations.
  if (stopping) return;
  if (!args.includes('--skip-migrate')) {
    try {
      runNode(['scripts/migrate.cjs', `--env-file=${resolvedEnvFile}`]);
    } catch {
      throw new Error('Database migration failed. Check the external PostgreSQL endpoint configured by DATABASE_URL; this command does not start or manage databases.');
    }
  }

  // 5. Start services, then put Vite in front of the Admin Shell in watch mode.
  if (stopping) return;
  await startServices();
  if (stopping) return;
  if (watchEnabled) {
    const server = await startAdminWebDevServer(portalPort);
    if (stopping) {
      await server.close();
      return;
    }
    viteServer = server;
    startRuntimeWatchers();
  }
  if (stopping) return;
  printReadyBanner(publicPort, internalPort, portalPort, connectorPort);
}

if (require.main === module) {
  process.on('SIGINT', () => { void shutdown(0); });
  process.on('SIGTERM', () => { void shutdown(0); });
  process.on('message', (message) => { if (message === 'dugate:shutdown') void shutdown(0); });

  main().catch((error) => {
    console.error('\x1b[31m[dev] Failed to start:\x1b[0m', error.message);
    void shutdown(1);
  });
}

module.exports = { localCostControlEnvironment };
