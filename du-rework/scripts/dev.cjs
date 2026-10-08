#!/usr/bin/env node
// Local host-process runner. Docker deployment uses compose/* instead.
const { spawn, spawnSync } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const net = require('node:net');
const readline = require('node:readline');
const { parseEnv } = require('node:util');
const { serviceEnvironment, validateRuntimeEnvironment, signedConnectorToken } = require('./runtime-env.cjs');
const ROOT = path.resolve(__dirname, '..');
const ALL_WORKERS = ['document-core', 'lc-checker', 'example-review'];
const children = [];
let stopping = false;
function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.pid || child.exitCode !== null) continue;
    if (process.platform === 'win32') spawnSync('taskkill', ['/F', '/T', '/PID', String(child.pid)], { stdio: 'ignore' });
    else { try { process.kill(-child.pid, 'SIGTERM'); } catch {} }
  }
  if (process.platform !== 'win32') {
    // Let graceful handlers drain; force only our process groups if they hang.
    setTimeout(() => {
      for (const child of children) if (child.pid) {
        try { process.kill(-child.pid, 'SIGKILL'); } catch {}
      }
    }, 5000).unref();
  }
  process.exitCode = code;
}
function runNode(args) {
  const result = spawnSync(process.execPath, args, { cwd: ROOT, stdio: 'inherit', env: process.env });
  if (result.error || result.status !== 0) throw new Error('Prerequisite command failed; startup aborted');
}
async function available(port) {
  await new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', () => reject(new Error(`Port ${port} is occupied; stop its owner or configure a different port`)));
    server.listen(port, '127.0.0.1', () => server.close(resolve));
  });
}
async function ready(url) {
  const end = Date.now() + 30000;
  while (!stopping && Date.now() < end) {
    try { if ((await fetch(url, { signal: AbortSignal.timeout(1500) })).status === 200) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  throw new Error('Service readiness failed; workers were not started');
}
function start(name, entry) {
  const args = process.argv.includes('--watch') ? ['--watch', path.join(ROOT, entry)] : [path.join(ROOT, entry)];
  const child = spawn(process.execPath, args, { cwd: ROOT, env: serviceEnvironment(process.env, name), detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
  children.push(child);
  for (const stream of [child.stdout, child.stderr]) readline.createInterface({ input: stream }).on('line', line => console.log(`[${name}] ${line}`));
  child.once('error', () => { console.error(`[${name}] Failed to start`); shutdown(1); });
  child.once('exit', (code, signal) => {
    if (!stopping) { console.error(`[${name}] Exited (${code ?? signal}); stopping this dev session`); shutdown(code || 1); }
  });
}
async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--help')) {
    console.log('node scripts/dev.cjs [--env-file=PATH] [--workers=all|none|document-core,lc-checker,example-review] [--services=all|orchestrator|connector|workers] [--workflow] [--local-identity] [--skip-build] [--skip-migrate] [--watch] [--check]');
    return;
  }
  const [major, minor] = process.versions.node.split('.').map(Number);
  if (major !== 24 || minor < 21) throw new Error('Use Node >=24.21.0 <25');
  for (const arg of args) if (!['--skip-build', '--skip-migrate', '--watch', '--check', '--workflow', '--local-identity'].includes(arg) && !arg.startsWith('--env-file=') && !arg.startsWith('--workers=') && !arg.startsWith('--services=')) throw new Error('Unknown dev option');
  const explicit = args.find(arg => arg.startsWith('--env-file='));
  const envFile = path.resolve(ROOT, explicit ? explicit.slice('--env-file='.length) : fs.existsSync(path.join(ROOT, '.env.local')) ? '.env.local' : '.env');
  if (!fs.existsSync(envFile)) throw new Error('Copy .env.local.sample to .env.local and configure local infrastructure first');
  // Match Node --env-file precedence: existing process environment wins.
  const configured = { ...parseEnv(fs.readFileSync(envFile, 'utf8')), ...process.env };
  Object.assign(process.env, configured);
  const defaults = { ORCHESTRATOR_PORT: '3000', ORCHESTRATOR_INTERNAL_PORT: '3002', ADMIN_SHELL_PORT: '3001', CONNECTOR_PORT: '8088', ORCHESTRATOR_HOST: '127.0.0.1', ORCHESTRATOR_INTERNAL_HOST: '127.0.0.1', ADMIN_SHELL_HOST: '127.0.0.1', HOST: '127.0.0.1', DU_ADMIN_WEB: '1', DU_ADMIN_WEB_DIST: path.join(ROOT, 'orchestrator/apps/admin-web/dist') };
  for (const [key, value] of Object.entries(defaults)) process.env[key] ??= value;
  const ports = ['ORCHESTRATOR_PORT', 'ORCHESTRATOR_INTERNAL_PORT', 'ADMIN_SHELL_PORT', 'CONNECTOR_PORT'].map(key => Number(process.env[key]));
  if (ports.some(port => !Number.isInteger(port) || port < 1 || port > 65535) || new Set(ports).size !== ports.length) throw new Error('Listener ports must be valid and distinct');
  const [publicPort, internalPort, portalPort, connectorPort] = ports;
  process.env.ORCHESTRATOR_INTERNAL_BASE_URL ??= `http://127.0.0.1:${internalPort}`;
  process.env.RUNTIME_URL ??= `${process.env.ORCHESTRATOR_INTERNAL_BASE_URL}/api/runtime/v1`;
  process.env.CONNECTOR_URL ??= `http://127.0.0.1:${connectorPort}`;
  if (new URL(process.env.RUNTIME_URL).port === String(publicPort)) throw new Error('RUNTIME_URL points to Public ingress; use the Internal listener');
  const services = args.find(arg => arg.startsWith('--services='))?.slice('--services='.length) ?? 'all';
  if (!['all', 'orchestrator', 'connector', 'workers'].includes(services)) throw new Error('Invalid service selection');
  const selection = args.find(arg => arg.startsWith('--workers='))?.slice('--workers='.length) ?? (['all', 'workers'].includes(services) ? 'all' : 'none');
  const workers = selection === 'all' ? ALL_WORKERS : selection === 'none' ? [] : selection.split(',');
  if (new Set(workers).size !== workers.length || workers.some(worker => !ALL_WORKERS.includes(worker))) throw new Error('Invalid worker selection');
  if (['orchestrator', 'connector'].includes(services) && workers.length) throw new Error('Invalid worker selection for single-service launch');
  if (args.includes('--local-identity')) process.env.CONNECTOR_SERVICE_TOKEN = signedConnectorToken(process.env.SERVICE_IDENTITY_SECRET);
  validateRuntimeEnvironment(process.env, { workers, services, workflow: args.includes('--workflow') });
  console.log(`Public API: http://127.0.0.1:${publicPort}\nInternal API: http://127.0.0.1:${internalPort}\nOrchestrator Portal: http://127.0.0.1:${portalPort}/admin/web/\nConnector: http://127.0.0.1:${connectorPort}\nWorkers: ${workers.join(', ') || 'none'}`);
  console.log('Runtime configuration: valid. Business/profile/schema provisioning and provider connectivity require separate setup.');
  if (args.includes('--check')) return; // No build, migrations, bind or process launch.
  const selectedPorts = services === 'all' ? ports : services === 'orchestrator' ? ports.slice(0, 3) : services === 'connector' ? [connectorPort] : [];
  for (const port of selectedPorts) await available(port);
  if (!args.includes('--skip-build')) runNode(['scripts/build-all.cjs']);
  for (const entry of ['orchestrator/services/orchestrator/dist/main.js', 'orchestrator/services/connector/dist/entrypoint.js', 'orchestrator/apps/admin-web/dist/index.html', ...workers.map(worker => `businesses/${worker}/dist/main.js`)]) {
    if (!fs.existsSync(path.join(ROOT, entry))) throw new Error(`Missing build artifact: ${entry}`);
  }
  if (['all', 'orchestrator'].includes(services)) {
    if (!args.includes('--skip-migrate')) runNode(['scripts/migrate-local.cjs', `--env-file=${envFile}`]);
    start('orchestrator', 'orchestrator/services/orchestrator/dist/main.js');
  }
  if (['all', 'connector'].includes(services)) start('connector', 'orchestrator/services/connector/dist/entrypoint.js');
  const readiness = [];
  if (services !== 'connector') readiness.push(ready(`http://127.0.0.1:${internalPort}/health`));
  if (services !== 'orchestrator') readiness.push(ready(`http://127.0.0.1:${connectorPort}/health/ready`));
  await Promise.all(readiness);
  if (!stopping) for (const worker of workers) start(worker, `businesses/${worker}/dist/main.js`);
}
process.on('SIGINT', () => shutdown());
process.on('SIGTERM', () => shutdown());
main().catch(error => {
  // Only runner-generated diagnostics are exposed; URL parsing errors may contain credentials.
  const safe = ['Use Node', 'Unknown dev', 'Copy .env', 'Listener ports', 'RUNTIME_URL points', 'Invalid worker', 'Invalid service', 'Port ', 'Missing build', 'Prerequisite command', 'Service readiness', 'Worker tokens', 'Missing worker identity', 'Vault encrypt', 'Metadata plaintext', 'Workflow runtime', 'DU_', 'CONNECTOR_', 'INVOCATION_GRANT_SECRET', 'SERVICE_IDENTITY_SECRET', 'WORKER_IDENTITY_TOKENS_BY_BUSINESS', 'DOCUMENT_CORE_RUNTIME_TOKEN', 'LC_RUNTIME_TOKEN', 'EXAMPLE_REVIEW_RUNTIME_TOKEN', 'DATABASE_URL is required', 'REDIS_URL is required', 'RUNTIME_TOKEN is required', 'ADMIN_TOKEN is required', 'ENCRYPTION_KEY is required', 'ADMIN_SHELL_COOKIE_SECRET is required'];
  console.error('[dev] ' + (safe.some(prefix => error.message.startsWith(prefix)) ? error.message : 'Invalid configuration; credentials are not printed'));
  shutdown(1);
});
