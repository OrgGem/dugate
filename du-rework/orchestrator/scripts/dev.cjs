#!/usr/bin/env node
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const readline = require('node:readline');
const { parseEnv } = require('node:util');
const { serviceEnvironment, validateRuntimeEnvironment, signedConnectorToken } = require('./runtime-env.cjs');

const ROOT = path.resolve(__dirname, '..');
const children = [];
let stopping = false;

function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  console.log('\n[dev] Shutting down services...');
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') {
      spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    } else {
      try { process.kill(-child.pid, 'SIGTERM'); } catch {}
    }
  }
  process.exitCode = code;
}

function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error(`Prerequisite command failed: node ${args.join(' ')}`);
}

async function isPortAvailable(port) {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function waitForReady(url, name, maxWaitMs = 30000) {
  const end = Date.now() + maxWaitMs;
  while (!stopping && Date.now() < end) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1500) });
      if (res.status === 200) return true;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`Service ${name} failed to become ready at ${url}`);
}

function startProcess(name, relativeEntry, args = []) {
  const entryPath = path.join(ROOT, relativeEntry);
  const nodeArgs = process.argv.includes('--watch') ? ['--watch', entryPath, ...args] : [entryPath, ...args];
  const child = spawn(process.execPath, nodeArgs, {
    cwd: ROOT,
    env: serviceEnvironment(process.env, name),
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  children.push(child);

  for (const stream of [child.stdout, child.stderr]) {
    readline.createInterface({ input: stream }).on('line', (line) => {
      console.log(`[${name}] ${line}`);
    });
  }

  child.once('error', (err) => {
    console.error(`[${name}] Failed to start:`, err.message);
    shutdown(1);
  });

  child.once('exit', (code, signal) => {
    if (!stopping) {
      console.error(`[${name}] Exited (${code ?? signal}); stopping dev session`);
      shutdown(code || 1);
    }
  });
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log(`
Usage: pnpm run dev [options]

Options:
  --env-file=PATH     Explicit path to environment file
  --skip-build        Skip initial build of packages & services
  --skip-migrate      Skip database migrations
  --watch             Run node processes in watch mode
  --help              Show this help message
`);
    return;
  }

  // 1. Locate environment file
  let envFile = '.env.local';
  const customEnvArg = args.find(a => a.startsWith('--env-file='));
  if (customEnvArg) {
    envFile = customEnvArg.slice('--env-file='.length);
  } else if (!fs.existsSync(path.join(ROOT, envFile))) {
    if (fs.existsSync(path.join(ROOT, '.env'))) {
      envFile = '.env';
    } else if (fs.existsSync(path.join(ROOT, '../.env.orchestrator.local'))) {
      envFile = '../.env.orchestrator.local';
    } else {
      const { initLocalEnv } = require('./init-local.cjs');
      envFile = path.relative(ROOT, initLocalEnv());
    }
  }

  const resolvedEnvFile = path.resolve(ROOT, envFile);
  console.log(`[dev] Using environment file: ${envFile}`);
  const configured = { ...parseEnv(fs.readFileSync(resolvedEnvFile, 'utf8')), ...process.env };
  Object.assign(process.env, configured);

  // 2. Normalize and apply defaults
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

  for (const [key, value] of Object.entries(defaults)) {
    process.env[key] ??= value;
  }

  // Handle case where CONNECTOR_MIGRATION_DIRECTORY had ./orchestrator/services/... from du-rework parent
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

  validateRuntimeEnvironment(process.env, { services: 'all' });

  // 3. Port check
  const ports = [publicPort, internalPort, portalPort, connectorPort];
  for (const port of ports) {
    const free = await isPortAvailable(port);
    if (!free) {
      throw new Error(`Port ${port} is currently in use. Stop the existing process or run "pnpm run stop".`);
    }
  }

  // 4. Build prerequisites
  const requiredArtifacts = [
    'services/orchestrator/dist/main.js',
    'services/connector/dist/entrypoint.js',
    'apps/admin-web/dist/index.html',
  ];
  const missingArtifacts = requiredArtifacts.some(f => !fs.existsSync(path.join(ROOT, f)));

  if (!args.includes('--skip-build') && missingArtifacts) {
    console.log('[dev] Missing build artifacts. Building orchestrator packages & services...');
    runNode(['scripts/build.cjs']);
  } else if (!args.includes('--skip-build')) {
    console.log('[dev] Building all packages & services...');
    runNode(['scripts/build.cjs']);
  }

  // 5. Database migrations
  if (!args.includes('--skip-migrate')) {
    try {
      runNode(['scripts/migrate.cjs', `--env-file=${resolvedEnvFile}`]);
    } catch (e) {
      console.warn('\x1b[33m[dev] Migration warning: Postgres may not be running yet. Proceeding with service startup...\x1b[0m');
      console.warn('\x1b[33m[dev] Run "pnpm run docker:up" to start PostgreSQL and Redis.\x1b[0m');
    }
  }

  // 6. Launch services
  console.log('\n[dev] Starting Orchestrator Backend...');
  startProcess('orchestrator', 'services/orchestrator/dist/main.js');

  console.log('[dev] Starting Connector Service...');
  startProcess('connector', 'services/connector/dist/entrypoint.js');

  // 7. Readiness check
  console.log('[dev] Waiting for services to be ready...');
  try {
    await Promise.all([
      waitForReady(`http://127.0.0.1:${internalPort}/health`, 'orchestrator'),
      waitForReady(`http://127.0.0.1:${connectorPort}/health/ready`, 'connector'),
    ]);
  } catch (err) {
    console.warn(`[dev] Warning: ${err.message}. (Services may still be starting up)`);
  }

  // 8. Ready banner
  console.log('\n===============================================================');
  console.log('   \x1b[32m✔ Orchestrator Platform is RUNNING (Standalone Dev)\x1b[0m');
  console.log('===============================================================');
  console.log(` • \x1b[1mPublic API:\x1b[0m           http://127.0.0.1:${publicPort}`);
  console.log(` • \x1b[1mInternal API:\x1b[0m         http://127.0.0.1:${internalPort}`);
  console.log(` • \x1b[1mOrchestrator Portal:\x1b[0m  http://127.0.0.1:${portalPort}/admin/`);
  console.log(` • \x1b[1mConnector Service:\x1b[0m    http://127.0.0.1:${connectorPort}`);
  console.log('===============================================================\n');
}

process.on('SIGINT', () => shutdown(0));
process.on('SIGTERM', () => shutdown(0));

main().catch((err) => {
  console.error('\x1b[31m[dev] Failed to start:\x1b[0m', err.message);
  shutdown(1);
});
