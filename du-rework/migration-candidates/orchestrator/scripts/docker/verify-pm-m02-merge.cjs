#!/usr/bin/env node
'use strict';

// Read-only integration verifier for the merged PM-M02 route + Compose packet.
// It never starts/stops containers and never prints container environment values.
const { execFileSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { Script } = require('node:vm');

const REPO_ROOT = path.resolve(__dirname, '../..');
const INTERNAL_RUNTIME_URL = 'http://orchestrator:3002/api/runtime/v1';
const INTERNAL_PORTS = [3002, 8080];
const WORKERS = [
  ['document-core', 'document-core'],
  ['lc-checker', 'lc-checker'],
  ['example-review', 'example-review'],
];

function parseArgs(argv) {
  const options = { envFile: '.env.docker', projectName: undefined, configOnly: false, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') options.help = true;
    else if (arg === '--config-only') options.configOnly = true;
    else if (arg === '--env-file' && argv[i + 1]) options.envFile = argv[++i];
    else if (arg === '--project-name' && argv[i + 1]) options.projectName = argv[++i];
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  return options;
}

function usage() {
  return [
    'Usage: node scripts/docker/verify-pm-m02-merge.cjs --project-name pm-m02-verify-<unique> [--env-file .env.docker] [--config-only]',
    'Precondition: use a unique isolated project name; full mode expects its default Compose stack already started.',
    '--config-only validates the default Compose contract and port widening without inspecting running containers.',
    'It checks Compose config, running container env/listeners, authenticated worker-to-Runtime calls,',
    'public-listener fencing, Docker host bindings, and host-side TCP reachability.',
  ].join('\n');
}

function fail(message) {
  throw new Error(message);
}

function runDocker(args, label, env = process.env) {
  try {
    return execFileSync('docker', args, {
      cwd: REPO_ROOT,
      env,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    }).trim();
  } catch (error) {
    const status = Number.isInteger(error.status) ? error.status : 'spawn-failed';
    const code = typeof error.code === 'string' ? ` (${error.code})` : '';
    fail(`${label} failed${code}; Docker exit=${status}. Check Docker/Compose availability and the selected project.`);
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text);
  } catch {
    fail(`${label} did not return valid JSON.`);
  }
}

function portsFor(service) {
  return Array.isArray(service?.ports) ? service.ports : [];
}

function targetPorts(service) {
  return new Set(portsFor(service).map((port) => Number(port.target)));
}

function assertNoPublishedInternalPorts(config, label) {
  for (const serviceName of ['orchestrator', 'connector']) {
    for (const port of portsFor(config.services?.[serviceName])) {
      if (INTERNAL_PORTS.includes(Number(port.target))) {
        fail(`${label}: ${serviceName} publishes internal target port ${port.target}.`);
      }
    }
  }
}

function assertComposeContract(config, label) {
  const orchestrator = config.services?.orchestrator;
  const connector = config.services?.connector;
  if (!orchestrator || !connector) fail(`${label}: Orchestrator or Connector service is missing.`);

  const orchestratorEnv = orchestrator.environment ?? {};
  for (const [key, expected] of Object.entries({
    PORT: '3000',
    ORCHESTRATOR_HOST: '0.0.0.0',
    ORCHESTRATOR_PORT: '3000',
    ORCHESTRATOR_INTERNAL_HOST: '0.0.0.0',
    ORCHESTRATOR_INTERNAL_PORT: '3002',
  })) {
    if (String(orchestratorEnv[key] ?? '') !== expected) {
      fail(`${label}: Orchestrator ${key} must resolve to ${expected}.`);
    }
  }

  const orchestratorTargets = targetPorts(orchestrator);
  for (const port of [3000, 3001]) {
    if (!orchestratorTargets.has(port)) fail(`${label}: Orchestrator public/Portal host mapping ${port} is missing.`);
  }
  if (orchestratorTargets.size !== 2) fail(`${label}: Orchestrator may publish only targets 3000 and 3001.`);
  if (portsFor(connector).length !== 0) fail(`${label}: Connector has a host port mapping.`);
  assertNoPublishedInternalPorts(config, label);

  for (const [serviceName] of WORKERS) {
    const worker = config.services?.[serviceName];
    if (!worker) fail(`${label}: worker service ${serviceName} is missing.`);
    if (worker.environment?.RUNTIME_URL !== INTERNAL_RUNTIME_URL) {
      fail(`${label}: ${serviceName} RUNTIME_URL must be ${INTERNAL_RUNTIME_URL}.`);
    }
  }

  for (const serviceName of ['migrate', 'orchestrator', 'connector']) {
    assertServiceUrlHost(config, serviceName, 'DATABASE_URL', 'postgres', label);
  }
  for (const [serviceName] of [['orchestrator'], ['connector'], ...WORKERS]) {
    assertServiceUrlHost(config, serviceName, 'REDIS_URL', 'valkey', label);
  }

  const connectorEnv = connector.environment ?? {};
  const usageUrl = String(connectorEnv.USAGE_SINK_URL ?? '');
  const usageToken = String(connectorEnv.USAGE_SINK_TOKEN ?? '');
  const expectedUsageUrl = `${INTERNAL_RUNTIME_URL}/usage-events`;
  if ((usageUrl || usageToken) && (!usageUrl || !usageToken || usageUrl !== expectedUsageUrl)) {
    fail(`${label}: enabled usage sink must have a token and target ${expectedUsageUrl}.`);
  }
}

function assertServiceUrlHost(config, serviceName, key, expectedHost, label) {
  const raw = config.services?.[serviceName]?.environment?.[key];
  let parsed;
  try {
    parsed = new URL(String(raw ?? ''));
  } catch {
    fail(`${label}: ${serviceName} ${key} must resolve to the isolated Compose service ${expectedHost}.`);
  }
  if (parsed.hostname !== expectedHost) {
    fail(`${label}: ${serviceName} ${key} must resolve to the isolated Compose service ${expectedHost}.`);
  }
}

function parseInspectJson(containerId, template, label) {
  const output = runDocker(['inspect', '--format', template, containerId], label);
  return parseJson(output, label);
}

function containerId(composeArgs, serviceName) {
  const output = runDocker([...composeArgs, 'ps', '-q', serviceName], `locate ${serviceName}`);
  const ids = output.split(/\s+/).filter(Boolean);
  if (ids.length !== 1) fail(`${serviceName} must have exactly one container; found ${ids.length}.`);
  return ids[0];
}

function inspectRunning(id, label) {
  const running = runDocker(['inspect', '--format', '{{.State.Running}}', id], `${label} state`);
  if (running !== 'true') fail(`${label} container is not running.`);
}

function inspectEnv(id, label) {
  const values = parseInspectJson(id, '{{json .Config.Env}}', `${label} environment`);
  return Object.fromEntries(values.map((entry) => {
    const separator = entry.indexOf('=');
    return [entry.slice(0, separator), entry.slice(separator + 1)];
  }));
}

function assertNoContainerHostBindings(id, ports, label) {
  const mappings = parseInspectJson(id, '{{json .NetworkSettings.Ports}}', `${label} port bindings`) ?? {};
  for (const port of ports) {
    const bindings = mappings[`${port}/tcp`];
    if (Array.isArray(bindings) && bindings.length > 0) {
      fail(`${label} has a Docker host binding for ${port}/tcp.`);
    }
  }
}

function execInService(composeArgs, serviceName, command, label) {
  runDocker([...composeArgs, 'exec', '-T', serviceName, 'node', '-e', command], label);
}

function orchestratorListenerProbe() {
  return `
    (async () => {
      const expected = { PORT: '3000', ORCHESTRATOR_PORT: '3000', ORCHESTRATOR_INTERNAL_PORT: '3002' };
      for (const [key, value] of Object.entries(expected)) {
        if (process.env[key] !== value) throw new Error(key + ' env mismatch');
      }
      for (const port of [3000, 3002]) {
        const response = await fetch('http://127.0.0.1:' + port + '/health');
        if (response.status !== 200) throw new Error('health ' + port + '=' + response.status);
      }
      console.log('public=200 internal=200');
    })().catch(() => process.exit(1));
  `;
}

function workerRuntimeProbe(businessId) {
  return `
    (async () => {
      let runtimeUrl = String(process.env.RUNTIME_URL || '');
      while (runtimeUrl.endsWith('/')) runtimeUrl = runtimeUrl.slice(0, -1);
      const token = process.env.RUNTIME_TOKEN || '';
      if (runtimeUrl !== ${JSON.stringify(INTERNAL_RUNTIME_URL)} || !token) {
        throw new Error('worker Runtime config mismatch');
      }
      const headers = { authorization: 'Bearer ' + token, 'content-type': 'application/json' };
      const request = {
        method: 'PUT', headers,
        body: JSON.stringify({ businessId: ${JSON.stringify(businessId)} }),
      };
      // RFX-12's compatibility heartbeat is intentionally read/write-free.
      const path = '/workers/pm-m02-merge-probe/heartbeat';
      const internal = await fetch(runtimeUrl + path, request);
      if (internal.status !== 200) throw new Error('internal Runtime status=' + internal.status);
      const publicListener = await fetch('http://orchestrator:3000/api/runtime/v1' + path, request);
      if (publicListener.status !== 404) throw new Error('public Runtime fence status=' + publicListener.status);
      console.log('internal-runtime=200 public-runtime=404');
    })().catch(() => process.exit(1));
  `;
}

function assertTcpUnavailable(host, port, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (!error) return reject(new Error(`host ${host}:${port} accepted a TCP connection`));
      if (['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH'].includes(error.code)) {
        return resolve(error.code);
      }
      reject(new Error(`host probe ${host}:${port} was inconclusive (${error.code ?? 'unknown error'})`));
    };
    socket.setTimeout(timeoutMs, () => finish(Object.assign(new Error('timed out'), { code: 'ETIMEDOUT' })));
    socket.once('connect', () => finish(undefined));
    socket.once('error', finish);
  });
}

async function main() {
  validateEmbeddedProbes();
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(usage());
    return 0;
  }

  const envFile = path.resolve(REPO_ROOT, options.envFile);
  if (!existsSync(envFile)) fail(`Compose env file not found: ${envFile}. Copy and provision .env.docker.example first.`);

  const explicitProject = options.projectName ?? process.env.PM_M02_PROJECT_NAME;
  if (!explicitProject || !explicitProject.startsWith('pm-m02-verify-')) {
    fail('Pass a unique --project-name beginning with pm-m02-verify- for the isolated stack.');
  }
  const composePrefix = [
    'compose', '--env-file', envFile, '--project-name', explicitProject, '-f', 'docker-compose.yml',
  ];

  const version = runDocker(['compose', 'version'], 'Docker Compose version');
  const versionMatch = /v(\d+)\.(\d+)/.exec(version);
  if (!versionMatch || Number(versionMatch[1]) < 2 || (Number(versionMatch[1]) === 2 && Number(versionMatch[2]) < 20)) {
    fail(`Compose 2.20+ is required; found ${version}.`);
  }

  const defaultConfig = parseJson(runDocker([...composePrefix, 'config', '--format', 'json'], 'default Compose config'), 'default Compose config');
  const projectName = explicitProject;
  const composeArgs = ['compose', '--env-file', envFile, '--project-name', projectName, '-f', 'docker-compose.yml'];

  assertComposeContract(defaultConfig, 'default Compose config');
  console.log('PASS default Compose contract (no internal host publication; workers use Runtime 3002).');

  const widenedConfig = parseJson(
    runDocker([...composePrefix, 'config', '--format', 'json'], 'widened-bind Compose config', {
      ...process.env,
      BIND_ADDRESS: '0.0.0.0',
    }),
    'widened-bind Compose config',
  );
  assertNoPublishedInternalPorts(widenedConfig, 'BIND_ADDRESS=0.0.0.0 Compose config');
  console.log('PASS widened BIND_ADDRESS still does not publish 3002/8080.');
  if (options.configOnly) {
    console.log('PASS config-only mode; no containers inspected or started.');
    return 0;
  }

  const orchestratorId = containerId(composeArgs, 'orchestrator');
  const connectorId = containerId(composeArgs, 'connector');
  inspectRunning(orchestratorId, 'Orchestrator');
  inspectRunning(connectorId, 'Connector');
  const orchestratorEnv = inspectEnv(orchestratorId, 'Orchestrator');
  for (const [key, expected] of Object.entries({
    PORT: '3000',
    ORCHESTRATOR_HOST: '0.0.0.0',
    ORCHESTRATOR_PORT: '3000',
    ORCHESTRATOR_INTERNAL_HOST: '0.0.0.0',
    ORCHESTRATOR_INTERNAL_PORT: '3002',
  })) {
    if (orchestratorEnv[key] !== expected) fail(`Running Orchestrator ${key} is not ${expected}.`);
  }
  assertNoContainerHostBindings(orchestratorId, [3002], 'Orchestrator');
  assertNoContainerHostBindings(connectorId, [8080], 'Connector');
  execInService(composeArgs, 'orchestrator', orchestratorListenerProbe(), 'Orchestrator listener probe');
  console.log('PASS running Orchestrator has public 3000 and internal 3002 listeners, both healthy.');
  console.log('PASS running Docker containers have no host binding for 3002/8080.');

  for (const [serviceName, businessId] of WORKERS) {
    const id = containerId(composeArgs, serviceName);
    inspectRunning(id, serviceName);
    execInService(composeArgs, serviceName, workerRuntimeProbe(businessId), `${serviceName} Runtime probe`);
    console.log(`PASS ${serviceName} reaches authenticated internal Runtime; public Runtime fence returns 404.`);
  }

  const hostResults = [];
  for (const port of INTERNAL_PORTS) {
    const code = await assertTcpUnavailable('127.0.0.1', port);
    hostResults.push(`${port}:${code}`);
  }
  console.log(`PASS host-side loopback cannot connect to internal ports (${hostResults.join(', ')}).`);
  console.log('NOTE External routing/firewall reachability still requires a probe from a separate client network.');
  console.log(`PASS project=${projectName}; no containers were started/stopped by this verifier.`);
  return 0;
}

function validateEmbeddedProbes() {
  new Script(orchestratorListenerProbe(), { filename: 'pm-m02-orchestrator-probe.cjs' });
  for (const [, businessId] of WORKERS) {
    new Script(workerRuntimeProbe(businessId), { filename: 'pm-m02-worker-probe.cjs' });
  }
}

main().then((code) => {
  process.exitCode = code;
}).catch((error) => {
  console.error(`FAIL ${error.message}`);
  process.exitCode = 1;
});
