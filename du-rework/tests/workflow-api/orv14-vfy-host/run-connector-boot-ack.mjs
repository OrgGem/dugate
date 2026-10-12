import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const node = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const root = process.cwd();
const here = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(here, 'compose-connector-boot-ack.yml');
const connectorRoot = path.join(root, 'orchestrator/services/connector');
const rawRoot = path.join(root, 'coordination/reports/raw/orv14-host-verification');
const project = `orv14-vfy-host-boot-ack-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
const rawDir = path.join(rawRoot, project);
mkdirSync(rawDir, { recursive: true });

const image = 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const selected = [
  'src/db/pg-client.ts',
  'src/db/replica-runtime-controls.ts',
  'src/errors.ts',
  ...readdirSync(path.join(connectorRoot, 'src/db/migrations')).filter((name) => /^\d{3}_.*\.sql$/.test(name)).sort().map((name) => `src/db/migrations/${name}`),
];
const contractsDist = path.join(root, 'orchestrator/packages/contracts/dist');
const walk = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const absolute = path.join(dir, entry.name);
  return entry.isDirectory() ? walk(absolute) : [absolute];
}).sort();
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
function sourceManifest() {
  const source = selected.map((relative) => ({ path: `orchestrator/services/connector/${relative}`, sha256: sha(readFileSync(path.join(connectorRoot, relative))) }));
  const dist = walk(contractsDist).map((absolute) => ({ path: path.relative(root, absolute), sha256: sha(readFileSync(absolute)) }));
  return { source, contractsDist: dist, combinedSha256: sha(Buffer.from(JSON.stringify({ source, dist }))) };
}
const before = sourceManifest();
const startedAt = new Date().toISOString();
const nodeVersion = spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim();
const composeArgs = ['compose', '-p', project, '-f', composeFile];
const commands = [];
function run(label, args, env = {}) {
  const result = spawnSync(args[0], args.slice(1), { cwd: root, encoding: 'utf8', env: { ...process.env, ...env }, maxBuffer: 8 * 1024 * 1024 });
  commands.push({ label, command: args, exitCode: result.status, signal: result.signal ?? null });
  writeFileSync(path.join(rawDir, `${label}.stdout.log`), result.stdout ?? '');
  writeFileSync(path.join(rawDir, `${label}.stderr.log`), result.stderr ?? '');
  return result;
}

const bootA = randomUUID();
const bootB = randomUUID();
let composeUpExitCode = null;
let cleanupExitCode = null;
let portUsed = null;
let containerIds = [];
let networkIdsBefore = [];
let phaseResults = [];
let cleanupVerification = null;
try {
  const up = run('compose-up', ['docker', ...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '60']);
  composeUpExitCode = up.status;
  if (up.status !== 0) throw new Error('SYNTHETIC_COMPOSE_UP_FAILED');
  const port = run('compose-port', ['docker', ...composeArgs, 'port', 'pg', '5432']);
  const match = /:(\d+)\s*$/.exec(port.stdout.trim());
  if (port.status !== 0 || !match) throw new Error('SYNTHETIC_COMPOSE_PORT_NOT_FOUND');
  portUsed = Number(match[1]);
  const containers = run('compose-containers-before-test', ['docker', ...composeArgs, 'ps', '-q']);
  containerIds = containers.stdout.trim().split(/\s+/).filter(Boolean);
  const networks = run('compose-networks-before-test', ['docker', 'network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
  networkIdsBefore = networks.stdout.trim().split(/\s+/).filter(Boolean);

  const jestCli = path.join(connectorRoot, 'node_modules/jest/bin/jest.js');
  const jestConfig = path.join(here, 'jest.connector-boot-ack.config.cjs');
  const testFile = path.join(here, 'connector-boot-ack.integration.test.ts');
  const databaseUrl = `postgres://synthetic:synthetic@127.0.0.1:${portUsed}/orv14_connector_boot_ack`;
  const phases = [
    { name: 'migration', bootId: '' },
    { name: 'boot-a', phase: 'boot', bootId: bootA },
    { name: 'boot-b', phase: 'boot', bootId: bootB },
    { name: 'stale-boot-a', phase: 'stale', bootId: bootA },
  ];
  for (const item of phases) {
    const phase = item.phase ?? 'migration';
    const result = run(item.name, [node, jestCli, '--config', jestConfig, '--runInBand', '--runTestsByPath', testFile], {
      ORV14_CONNECTOR_BOOT_ACK_DATABASE_URL: databaseUrl,
      ORV14_CONNECTOR_BOOT_ACK_PHASE: phase,
      ...(item.bootId ? { ORV14_CONNECTOR_BOOT_ACK_BOOT_ID: item.bootId } : {}),
      NODE_ENV: 'test',
    });
    phaseResults.push({ phase: item.name, exitCode: result.status });
    if (result.status !== 0) break;
  }
} catch (error) {
  writeFileSync(path.join(rawDir, 'runner-error.txt'), String(error?.message ?? 'RUNNER_FAILED'));
} finally {
  const down = run('compose-down', ['docker', ...composeArgs, 'down', '--volumes', '--remove-orphans']);
  cleanupExitCode = down.status;
  const remainingContainers = run('compose-containers-after-cleanup', ['docker', ...composeArgs, 'ps', '-aq']);
  const remainingNetworks = run('compose-networks-after-cleanup', ['docker', 'network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
  cleanupVerification = {
    remainingContainerIds: remainingContainers.stdout.trim().split(/\s+/).filter(Boolean),
    remainingNetworkIds: remainingNetworks.stdout.trim().split(/\s+/).filter(Boolean),
    cleanupSucceeded: down.status === 0,
  };
}
const after = sourceManifest();
const finishedAt = new Date().toISOString();
const receipt = {
  task: 'VFY-ORV14-HOST-CONTINUITY Connector actual PostgreSQL boot-ack migration/restart slice',
  project, cwd: root, startedAt, finishedAt, nodeVersion, composeImage: image,
  commands, phaseResults, sourceManifestBefore: before, sourceManifestAfter: after,
  sourceStable: before.combinedSha256 === after.combinedSha256,
  containerIds, networkIdsBefore, portUsed, bootIds: { firstProcess: bootA, restartedProcess: bootB },
  cleanupExitCode, cleanupVerification,
  scope: 'synthetic PostgreSQL only; checked-in Connector SQL 001-015 applied in baseline fixture through PgSqlClient transactions and standard ledger rows; production PgSqlClient.migrate() applied 016 and replayed; separate Node/Jest process boots for pre-seeded DRAINING registration/ACK; stale prior process observe/drain/resume denied; no real Connector listener or Host acceptance',
  migrationMethodNote: 'The current production migrator always enumerates 016, so fixture setup applied the checked-in 001-015 SQL files in order through PgSqlClient.query/transaction, then used production PgSqlClient.migrate() for 016 and replay.',
  rawFiles: readdirSync(rawDir).sort(),
};
writeFileSync(path.join(rawDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ project, nodeVersion, phaseResults, cleanupExitCode, sourceStable: receipt.sourceStable, rawDir: path.relative(root, rawDir) })}\n`);
if (composeUpExitCode !== 0 || phaseResults.length !== 4 || phaseResults.some((result) => result.exitCode !== 0)
  || cleanupExitCode !== 0 || !receipt.sourceStable
  || cleanupVerification.remainingContainerIds.length || cleanupVerification.remainingNetworkIds.length) process.exitCode = 1;
