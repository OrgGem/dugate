/** Dedicated benchmark project only; never builds, prints env, or migrates in check mode. */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const root = path.resolve(__dirname, '../..');
const workers = ['document-core', 'lc-checker', 'example-review'];
const budget = {
  orchestrator: [0.35, 768], connector: [0.20, 384], postgres: [0.30, 640],
  valkey: [0.10, 188], migrate: [0.05, 64],
};
const [action = 'check', worker = 'document-core', envFile = '.env.docker', project = 'du-benchmark', overlay] = process.argv.slice(2);
function run(args, capture = true) {
  const result = spawnSync('docker', args, { cwd: root, encoding: 'utf8',
    stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit',
    env: { ...process.env, COMPOSE_PROFILES: '', DU_IMAGE_TAG: 'candidate-portal-swagger-20261006-r4.1' } });
  if (result.error || result.status !== 0) throw new Error(`Docker command failed (exit ${result.status}); check Docker/env prerequisites. Secret-bearing output suppressed.`);
  return result.stdout;
}
function verify(rows) {
  const expected = { ...budget, [worker]: [1, 2048] };
  const names = new Set();
  let cpu = 0; let memory = 0;
  for (const row of rows) {
    const allocation = expected[row.service];
    if (!allocation || names.has(row.service)) throw new Error(`Unexpected service or replica: ${row.service}`);
    names.add(row.service);
    if (row.cpu !== Math.round(allocation[0] * 1e9) || row.memory !== allocation[1] * 1024 ** 2 || row.swap !== row.memory) {
      throw new Error(`Resource limit mismatch: ${row.service}`);
    }
    cpu += row.cpu; memory += row.memory;
  }
  if (names.size !== Object.keys(expected).length || cpu > 2e9 || memory > 4092 * 1024 ** 2) throw new Error('Missing services or aggregate budget exceeded');
  return { rows, aggregate: { cpus: cpu / 1e9, memoryMiB: memory / 1024 ** 2 }, scope: 'All containers in dedicated project, including stopped migrate; no swap allowance.' };
}
try {
  if (!['config', 'create', 'start', 'check'].includes(action) || !workers.includes(worker)) throw new Error('Usage: node benchmark.cjs config|create|start|check document-core|lc-checker|example-review [env-file] [du-benchmark-project]');
  if (!/^du-benchmark(?:-[a-z0-9-]+)?$/.test(project)) throw new Error('Project must be a dedicated du-benchmark namespace');
  if (!fs.existsSync(path.resolve(root, envFile))) throw new Error('Env file missing; provision it before starting');
  const compose = ['compose', '--project-name', project, '--env-file', path.resolve(root, envFile), '-f', 'docker-compose.yml', '-f', 'docker-compose.benchmark.yml', '--profile', `benchmark-${worker}`];
  if (overlay) compose.push('-f', path.resolve(root, overlay));
  const config = JSON.parse(run([...compose, 'config', '--format', 'json']));
  const plan = verify(Object.entries(config.services).map(([service, value]) => ({ service,
    cpu: Math.round(Number(value.deploy?.resources?.limits?.cpus) * 1e9),
    memory: Number(value.deploy?.resources?.limits?.memory), swap: Number(value.memswap_limit) })));
  if (action === 'config') { console.log(JSON.stringify(plan, null, 2)); process.exit(0); }
  const ids = run(['ps', '-aq', '--filter', `label=com.docker.compose.project=${project}`]).trim().split(/\s+/).filter(Boolean);
  if (action === 'check' || ids.length) {
    if (!ids.length) throw new Error('No benchmark containers found');
    const containers = JSON.parse(run(['inspect', ...ids]));
    const actual = verify(containers.map(container => ({ service: container.Config.Labels['com.docker.compose.service'],
      cpu: container.HostConfig.NanoCpus, memory: container.HostConfig.Memory, swap: container.HostConfig.MemorySwap })));
    if (action === 'check') { console.log(JSON.stringify(actual, null, 2)); process.exit(0); }
  }
  if (action === 'create') run([...compose, 'create', '--no-build'], false);
  if (action === 'start') run([...compose, 'up', '-d', '--no-build', '--scale', `${worker}=1`], false);
  const checked = spawnSync(process.execPath, [__filename, 'check', worker, envFile, project, ...(overlay ? [overlay] : [])], { stdio: 'inherit' });
  process.exitCode = checked.status ?? 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
