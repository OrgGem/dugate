import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const node = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const root = process.cwd();
const here = path.dirname(fileURLToPath(import.meta.url));
const composeFile = path.join(here, 'compose-claim-race.yml');
const orchestrator = path.join(root, 'orchestrator/services/orchestrator');
const rawRoot = path.join(root, 'coordination/reports/raw/orv14-host-verification');
const project = `orv14-vfy-host-claim-${Date.now().toString(36)}-${randomBytes(4).toString('hex')}`;
const rawDir = path.join(rawRoot, project);
mkdirSync(rawDir, { recursive: true });

const imported = [
  'src/modules/maintenance/maintenance-service.ts',
  'src/modules/maintenance/rollouts.ts',
  'src/modules/maintenance/backup-fence.ts',
  'src/modules/maintenance/backup-effect-fence.ts',
  'src/modules/maintenance/replica-runtime-safety.ts',
  'src/modules/maintenance/connector-backup-effect-control.ts',
  'src/modules/maintenance/connector-backup-effect-coordinator.ts',
  'src/modules/audit/audit.ts',
  'src/db/db.ts',
  'src/db/migrations.ts',
];
const migrationsDir = path.join(orchestrator, 'migrations');
const migrationPaths = () => readdirSync(migrationsDir).filter((name) => /^\d{4}_.*\.sql$/.test(name)).sort()
  .map((name) => path.join('orchestrator/services/orchestrator/migrations', name));
const contractsDistDir = path.join(root, 'orchestrator/packages/contracts/dist');
const allFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
  const name = path.join(dir, entry.name);
  return entry.isDirectory() ? allFiles(name) : [name];
}).sort();
function sha(bytes) { return createHash('sha256').update(bytes).digest('hex'); }
function sourceManifest() {
  const paths = [
    ...imported.map((name) => path.join('orchestrator/services/orchestrator', name)),
    ...migrationPaths(),
    path.relative(root, composeFile),
    path.relative(root, path.join(here, 'host-claim-interleaving.test.ts')),
    path.relative(root, path.join(here, 'jest.claim-race.config.cjs')),
    path.relative(root, path.join(here, 'tsconfig.claim-race.json')),
  ].sort();
  const records = paths.map((relative) => ({ path: relative, sha256: sha(readFileSync(path.join(root, relative))) }));
  const contractFiles = allFiles(contractsDistDir).map((absolute) => ({
    path: path.relative(root, absolute), sha256: sha(readFileSync(absolute)),
  }));
  const combined = sha(Buffer.from(JSON.stringify({ records, contractFiles })));
  return { paths: records, contractsDist: contractFiles, combinedSha256: combined };
}

const startedAt = new Date().toISOString();
const before = sourceManifest();
const nodeVersion = spawnSync(node, ['--version'], { encoding: 'utf8' }).stdout.trim();
const image = 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const composeArgs = ['compose', '-p', project, '-f', composeFile];
const commands = [];
function run(label, args, extraEnv = {}) {
  const result = spawnSync(args[0], args.slice(1), {
    cwd: root, encoding: 'utf8', env: { ...process.env, ...extraEnv }, maxBuffer: 8 * 1024 * 1024,
  });
  commands.push({ label, command: args, exitCode: result.status, signal: result.signal ?? null });
  writeFileSync(path.join(rawDir, `${label}.stdout.log`), result.stdout ?? '');
  writeFileSync(path.join(rawDir, `${label}.stderr.log`), result.stderr ?? '');
  return result;
}

let testExitCode = 1;
let upExitCode = null;
let port = null;
let containerIds = [];
let networkIdsBefore = [];
let cleanupExitCode = null;
let cleanupVerification = null;
try {
  const up = run('compose-up', ['docker', ...composeArgs, 'up', '-d', '--wait', '--wait-timeout', '60']);
  upExitCode = up.status;
  if (up.status !== 0) throw new Error('SYNTHETIC_COMPOSE_UP_FAILED');
  const portResult = run('compose-port', ['docker', ...composeArgs, 'port', 'pg', '5432']);
  const match = /:(\d+)\s*$/.exec(portResult.stdout.trim());
  if (portResult.status !== 0 || !match) throw new Error('SYNTHETIC_COMPOSE_PORT_NOT_FOUND');
  port = Number(match[1]);
  const ps = run('compose-containers-before-test', ['docker', ...composeArgs, 'ps', '-q']);
  containerIds = ps.stdout.trim().split(/\s+/).filter(Boolean);
  const networks = run('compose-networks-before-test', ['docker', 'network', 'ls', '-q', '--filter', `label=com.docker.compose.project=${project}`]);
  networkIdsBefore = networks.stdout.trim().split(/\s+/).filter(Boolean);

  const jestCli = path.join(orchestrator, 'node_modules/jest/bin/jest.js');
  const jestConfig = path.join(here, 'jest.claim-race.config.cjs');
  const testFile = path.join(here, 'host-claim-interleaving.test.ts');
  const databaseUrl = `postgres://synthetic@127.0.0.1:${port}/orv14_host_claim_race`;
  const jest = run('jest', [node, jestCli, '--config', jestConfig, '--runInBand', '--runTestsByPath', testFile], {
    ORV14_VFY_HOST_TEST_DATABASE_URL: databaseUrl,
    NODE_ENV: 'test',
  });
  testExitCode = jest.status ?? 1;
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
  task: 'VFY-ORV14-HOST-CONTINUITY actual PostgreSQL claim-interleaving slice',
  project, cwd: root, startedAt, finishedAt, nodeVersion,
  composeImage: image,
  maintenanceOnly: process.env.ORV14_VFY_HOST_MAINTENANCE_ONLY === '1',
  commands: commands.map(({ label, command, exitCode, signal }) => ({ label, command, exitCode, signal })),
  sourceManifestBefore: before,
  sourceManifestAfter: after,
  sourceStable: before.combinedSha256 === after.combinedSha256,
  containerIds, networkIdsBefore, portUsed: port,
  testExitCode, composeUpExitCode: upExitCode, cleanupExitCode, cleanupVerification,
  scope: receiptMaintenanceScope(process.env.ORV14_VFY_HOST_MAINTENANCE_ONLY === '1'),
  rawFiles: readdirSync(rawDir).sort(),
};
writeFileSync(path.join(rawDir, 'receipt.json'), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ project, nodeVersion, testExitCode, cleanupExitCode, sourceStable: receipt.sourceStable, rawDir: path.relative(root, rawDir) })}\n`);
if (testExitCode !== 0 || cleanupExitCode !== 0 || !receipt.sourceStable
  || cleanupVerification.remainingContainerIds.length || cleanupVerification.remainingNetworkIds.length) process.exitCode = 1;

function receiptMaintenanceScope(maintenanceOnly) {
  return maintenanceOnly
    ? 'fresh synthetic PostgreSQL only; actual Orchestrator maintenance claims and PostgreSQL backup gate/fence; synthetic runtime/Connector observations using a deterministic shared clock; rollout path skipped; not full Host acceptance'
    : 'fresh synthetic PostgreSQL only; actual Orchestrator maintenance and rollout service claims plus PostgreSQL backup gate/fence; synthetic runtime/Connector/ingress callbacks; not full Host acceptance';
}
