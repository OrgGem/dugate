import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { access, chmod, lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const DOCKER = '/usr/local/bin/docker';
const SOCKET = 'unix:///var/run/docker.sock';
const POSTGRES_IMAGE = 'postgres:16-alpine@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const ROOT_FIXTURE_IMAGE = POSTGRES_IMAGE;
const COMPOSE_FILE = path.resolve('tests/workflow-api/orv14-vfy-host/compose.yml');
const IMAGE_REFS = {
  postgres: POSTGRES_IMAGE,
  redis: 'redis:7-alpine@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499',
  vault: 'hashicorp/vault:1.18.5@sha256:750bb37c1638fa194ab37053a81618c61bb0491ddec6fccac87c07a8e6cd8166',
  minio: 'orv14-vfy/minio:RELEASE-2025-09-07',
};
const SERVICES = [
  'orchestrator-source',
  'connector-source',
  'orchestrator-restore',
  'connector-restore',
  'pg-tools',
  'redis',
  'vault',
  'vault-restore',
  'minio',
  'minio-restore',
];

function digest(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

function safeProjectName() {
  return `orv14-vfy-host-${Date.now().toString(36)}-${randomUUID().replaceAll('-', '').slice(0, 10)}`.toLowerCase();
}

function runDocker(args, options = {}) {
  const result = spawnSync(DOCKER, ['--host', SOCKET, ...args], {
    encoding: 'utf8',
    timeout: options.timeout ?? 60_000,
    maxBuffer: options.maxBuffer ?? 4 * 1024 * 1024,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.error) throw new Error(`Docker ${args[0] ?? 'command'} failed to start (${result.error.message})`);
  if (result.status !== 0) {
    const reason = (result.stderr || result.stdout || '').trim().slice(0, 1200);
    throw new Error(`Docker ${args[0] ?? 'command'} exited ${result.status}: ${reason || 'no diagnostic output'}`);
  }
  return (result.stdout ?? '').trim();
}

export function rootFixtureImageIdentity() {
  return { reference: ROOT_FIXTURE_IMAGE, imageId: runDocker(['image', 'inspect', ROOT_FIXTURE_IMAGE, '--format', '{{.Id}}']) };
}

function composeArgs(fixture, args) {
  return ['compose', '--project-name', fixture.projectId, '--env-file', fixture.envFile, '-f', COMPOSE_FILE, ...args];
}

function containerIds(fixture) {
  const output = runDocker(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${fixture.projectId}`]);
  return output.split(/\s+/).filter(Boolean);
}

function volumeNames(fixture) {
  const output = runDocker(['volume', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${fixture.projectId}`]);
  return output.split(/\s+/).filter(Boolean);
}

function networkNames(fixture) {
  const output = runDocker(['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${fixture.projectId}`]);
  return output.split(/\s+/).filter(Boolean);
}

function assertProjectLabels(fixture, resources) {
  for (const id of resources.containers) {
    const labels = JSON.parse(runDocker(['container', 'inspect', '--format', '{{json .Config.Labels}}', id]));
    if (labels?.['com.docker.compose.project'] !== fixture.projectId) {
      throw new Error(`refusing cleanup: container ${id} has a different Compose project label`);
    }
  }
  for (const name of resources.volumes) {
    const labels = JSON.parse(runDocker(['volume', 'inspect', '--format', '{{json .Labels}}', name]));
    if (labels?.['com.docker.compose.project'] !== fixture.projectId) {
      throw new Error(`refusing cleanup: volume ${name} has a different Compose project label`);
    }
  }
  for (const name of resources.networks) {
    const labels = JSON.parse(runDocker(['network', 'inspect', '--format', '{{json .Labels}}', name]));
    if (labels?.['com.docker.compose.project'] !== fixture.projectId) {
      throw new Error(`refusing cleanup: network ${name} has a different Compose project label`);
    }
  }
}

function hostPort(fixture, service, targetPort) {
  const id = runDocker(composeArgs(fixture, ['ps', '--quiet', service]));
  if (!id) throw new Error(`Compose service ${service} has no running container in the owned project`);
  const ports = JSON.parse(runDocker(['container', 'inspect', '--format', '{{json .NetworkSettings.Ports}}', id]));
  const binding = ports?.[`${targetPort}/tcp`]?.find((item) => item.HostIp === '127.0.0.1' && Number(item.HostPort) > 0);
  if (!binding) throw new Error(`Compose service ${service} has no loopback binding for ${targetPort}/tcp`);
  return Number(binding.HostPort);
}

async function removeRootOwnedFixture(fixture) {
  const marker = path.join(fixture.root, '.orv14-vfy-host-root-fixture');
  let hasRootOwnedData = false;
  for (const candidate of [marker, path.join(fixture.root, 'trusted')]) {
    try {
      await lstat(candidate);
      hasRootOwnedData = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  if (!hasRootOwnedData) return;
  const rootReal = await realpath(fixture.root);
  if (rootReal !== fixture.root || !rootReal.startsWith('/tmp/orv14-vfy-host-')) {
    throw new Error('refusing root-owned fixture cleanup outside its unique temporary path');
  }
  const script = 'set -eu; rm -rf -- /target/trusted /target/.orv14-vfy-host-root-fixture';
  runDocker([
    'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${fixture.root},dst=/target`, ROOT_FIXTURE_IMAGE,
    '-c', script,
  ]);
}

export async function createHostInfrastructureFixture() {
  if (process.getuid?.() !== 1000) throw new Error('the Host fixture expects the designated nonroot UID 1000 verifier');
  const suffix = safeProjectName().slice('orv14-vfy-host-'.length);
  const projectId = `orv14-vfy-host-${suffix}`;
  const root = await mkdtemp(path.join('/tmp', `${projectId}-`));
  await chmod(root, 0o700);
  const workDir = path.join(root, 'work');
  const bundleDir = path.join(root, 'bundles');
  const inputDir = path.join(root, 'inputs');
  await mkdir(workDir, { mode: 0o700 });
  await mkdir(bundleDir, { mode: 0o700 });
  await mkdir(inputDir, { mode: 0o700 });

  const credentials = {
    postgresPassword: randomBytes(30).toString('base64url'),
    vaultToken: randomBytes(30).toString('base64url'),
    s3AccessKey: `orv14host${randomBytes(12).toString('hex')}`,
    s3SecretKey: randomBytes(30).toString('base64url'),
  };
  const envFile = path.join(root, '.compose.env');
  const envLines = [
    `ORV14_VFY_HOST_ROOT=${root}`,
    `ORV14_VFY_HOST_UID=${process.getuid()}`,
    `ORV14_VFY_HOST_GID=${process.getgid()}`,
    `ORV14_VFY_HOST_PG_PASSWORD=${credentials.postgresPassword}`,
    `ORV14_VFY_HOST_VAULT_TOKEN=${credentials.vaultToken}`,
    `ORV14_VFY_HOST_S3_ACCESS_KEY=${credentials.s3AccessKey}`,
    `ORV14_VFY_HOST_S3_SECRET_KEY=${credentials.s3SecretKey}`,
  ].join('\n') + '\n';
  await writeFile(envFile, envLines, { mode: 0o600, flag: 'wx' });

  const fixture = {
    projectId,
    root,
    workDir,
    bundleDir,
    inputDir,
    envFile,
    composeFile: COMPOSE_FILE,
    composeSha256: digest(await readFile(COMPOSE_FILE)),
    credentials,
    verifierUid: process.getuid(),
    verifierGid: process.getgid(),
    services: {},
    postgres: {},
    urls: {},
    cleanupReceipt: null,
    imageIds: {},
    cleaned: false,
  };

  try {
    runDocker(composeArgs(fixture, ['config', '--quiet']));
    runDocker(composeArgs(fixture, ['up', '--detach', '--wait', '--wait-timeout', '90']), { timeout: 180_000 });
    for (const service of SERVICES) {
      const id = runDocker(composeArgs(fixture, ['ps', '--quiet', service]));
      if (!id) throw new Error(`Compose service ${service} did not start inside ${projectId}`);
      fixture.services[service] = id;
    }
    for (const [key, image] of Object.entries(IMAGE_REFS)) {
      fixture.imageIds[key] = runDocker(['image', 'inspect', image, '--format', '{{.Id}}']);
    }
    const pgPort = (service) => hostPort(fixture, service, 5432);
    fixture.postgres.orchestratorSource = {
      host: '127.0.0.1', port: pgPort('orchestrator-source'), user: 'orv14_host', password: credentials.postgresPassword,
      database: 'du_orchestrator', clusterName: 'orv14-host-orchestrator-source',
    };
    fixture.postgres.connectorSource = {
      host: '127.0.0.1', port: pgPort('connector-source'), user: 'orv14_host', password: credentials.postgresPassword,
      database: 'du_connector', clusterName: 'orv14-host-connector-source',
    };
    fixture.postgres.orchestratorRestore = {
      host: '127.0.0.1', port: pgPort('orchestrator-restore'), user: 'orv14_host', password: credentials.postgresPassword,
      database: 'du_orchestrator', clusterName: 'orv14-host-orchestrator-restore',
    };
    fixture.postgres.connectorRestore = {
      host: '127.0.0.1', port: pgPort('connector-restore'), user: 'orv14_host', password: credentials.postgresPassword,
      database: 'du_connector', clusterName: 'orv14-host-connector-restore',
    };
    fixture.urls.redis = `redis://127.0.0.1:${hostPort(fixture, 'redis', 6379)}`;
    fixture.urls.vaultSource = `http://127.0.0.1:${hostPort(fixture, 'vault', 8200)}`;
    fixture.urls.vaultRestore = `http://127.0.0.1:${hostPort(fixture, 'vault-restore', 8200)}`;
    fixture.urls.s3Source = `http://127.0.0.1:${hostPort(fixture, 'minio', 9000)}`;
    fixture.urls.s3Restore = `http://127.0.0.1:${hostPort(fixture, 'minio-restore', 9000)}`;
    return fixture;
  } catch (error) {
    await cleanupHostInfrastructureFixture(fixture).catch(() => undefined);
    throw error;
  }
}

export async function writeRootOwnedFiles(fixture, files) {
  if (fixture.cleaned) throw new Error('cannot create trusted files after fixture cleanup');
  if (!Array.isArray(files) || files.length === 0) throw new Error('root fixture needs at least one synthetic file');
  const entries = [];
  const directories = new Set(['trusted', 'trusted/config', 'trusted/tools']);
  for (const [index, file] of files.entries()) {
    if (!file || typeof file.relativePath !== 'string' || !/^trusted\/(config|tools|bundles|work)\/[A-Za-z0-9._-]+$/.test(file.relativePath)) {
      throw new Error('root fixture path is outside the permitted synthetic config, tools, bundle, or work directory');
    }
    const mode = file.mode ?? 0o444;
    if (!Number.isInteger(mode) || mode < 0 || (mode & 0o022) !== 0) throw new Error('root fixture mode is invalid or group/world writable');
    const groupId = file.groupId ?? fixture.verifierGid;
    if (!Number.isInteger(groupId) || groupId < 0 || groupId > 0x7fffffff) throw new Error('root fixture group id is invalid');
    const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(String(file.bytes), 'utf8');
    const inputName = `input-${String(index).padStart(3, '0')}`;
    await writeFile(path.join(fixture.inputDir, inputName), bytes, { mode: 0o600, flag: 'wx' });
    const parent = path.posix.dirname(file.relativePath);
    for (const dir of parent.split('/').reduce((all, segment) => {
      const current = all.length ? `${all[all.length - 1]}/${segment}` : segment;
      all.push(current);
      return all;
    }, [])) directories.add(dir);
    entries.push({ inputName, relativePath: file.relativePath, mode, groupId, expectedBytes: bytes.length });
  }
  const directoryCommands = [...directories].sort((left, right) => left.split('/').length - right.split('/').length)
    .map((dir) => `install -d -o 0 -g 0 -m 0755 /target/${dir}`);
  const fileCommands = entries.map((entry) => `install -o 0 -g ${entry.groupId} -m ${entry.mode.toString(8)} /inputs/${entry.inputName} /target/${entry.relativePath}`);
  const markerCommand = "printf 'orv14-vfy-host-root-owned-fixture\\n' > /target/.orv14-vfy-host-root-fixture; chmod 0444 /target/.orv14-vfy-host-root-fixture";
  const script = ['set -eu', ...directoryCommands, ...fileCommands, markerCommand].join('; ');
  runDocker([
    'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${fixture.inputDir},dst=/inputs,readonly`,
    '--mount', `type=bind,src=${fixture.root},dst=/target`,
    ROOT_FIXTURE_IMAGE, '-c', script,
  ]);

  const verified = [];
  for (const entry of entries) {
    const destination = path.join(fixture.root, entry.relativePath);
    const stat = await lstat(destination);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.uid !== 0 || stat.gid !== entry.groupId || (stat.mode & 0o022) !== 0 || stat.size !== entry.expectedBytes) {
      throw new Error(`root-owned fixture verification failed for ${entry.relativePath}`);
    }
    await access(destination, fsConstants.R_OK);
    const parent = await lstat(path.dirname(destination));
    if (!parent.isDirectory() || parent.isSymbolicLink() || parent.uid !== 0 || (parent.mode & 0o022) !== 0) {
      throw new Error(`root-owned fixture directory verification failed for ${entry.relativePath}`);
    }
    verified.push({ relativePath: entry.relativePath, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o777, byteSize: stat.size, sha256: digest(await readFile(destination)) });
  }
  return verified;
}

export async function createRootOwnedSymlink(fixture, relativePath, targetRelativePath) {
  const validPath = (value) => typeof value === 'string'
    && /^trusted\/(config|tools|bundles|work)\/[A-Za-z0-9._-]+$/.test(value);
  if (!validPath(relativePath) || !validPath(targetRelativePath) || relativePath === targetRelativePath) {
    throw new Error('root fixture symlink path is outside the permitted synthetic fixture');
  }
  const linkTarget = `/target/${targetRelativePath}`;
  const linkPath = `/target/${relativePath}`;
  runDocker([
    'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${fixture.root},dst=/target`,
    ROOT_FIXTURE_IMAGE, '-c', `set -eu; ln -s ${linkTarget} ${linkPath}`,
  ]);
  const localPath = path.join(fixture.root, relativePath);
  const stat = await lstat(localPath);
  const target = await readlink(localPath);
  if (!stat.isSymbolicLink() || stat.uid !== 0 || target !== linkTarget) {
    throw new Error('root-owned symlink fixture verification failed');
  }
  return { relativePath, targetRelativePath, uid: stat.uid, symlink: true };
}

export function createPgServiceFiles(fixture) {
  const definitions = [
    ['orchestrator-source', fixture.postgres.orchestratorSource],
    ['connector-source', fixture.postgres.connectorSource],
    ['orchestrator-restore', fixture.postgres.orchestratorRestore],
    ['connector-restore', fixture.postgres.connectorRestore],
  ];
  const serviceFile = definitions.map(([name, db]) => [
    `[${name}]`, `host=${name}`, 'port=5432', `user=${db.user}`, `dbname=${db.database}`,
    `password=${db.password}`, 'sslmode=disable', '',
  ].join('\n')).join('\n');
  const passfile = definitions.map(([name, db]) => `${name}:5432:*:${db.user}:${db.password}`).join('\n') + '\n';
  return { serviceFile, passfile };
}

export function runPgTool(fixture, command, args, options = {}) {
  const allowed = new Set(['pg_dump', 'pg_restore', 'createdb', 'psql', 'pg_isready']);
  if (!allowed.has(command)) throw new Error(`unapproved PostgreSQL helper command: ${command}`);
  return runDocker(['exec', '-e', 'PGSERVICEFILE=/orv14-vfy-host/trusted/config/pg_service.conf',
    '-e', 'PGPASSFILE=/orv14-vfy-host/trusted/config/pgpass', fixture.services['pg-tools'], command, ...args], options);
}

export function verifyPostgresPlaneIdentities(fixture) {
  const checks = [
    ['orchestrator-source', fixture.postgres.orchestratorSource.clusterName],
    ['connector-source', fixture.postgres.connectorSource.clusterName],
    ['orchestrator-restore', fixture.postgres.orchestratorRestore.clusterName],
    ['connector-restore', fixture.postgres.connectorRestore.clusterName],
  ];
  const results = [];
  for (const [service, expected] of checks) {
    const observed = runPgTool(fixture, 'psql', [
      `--dbname=service=${service}`, '--no-psqlrc', '--tuples-only', '--no-align',
      '--command=SELECT current_setting(\'cluster_name\')',
    ]).trim();
    if (observed !== expected) throw new Error(`PostgreSQL plane identity mismatch for ${service}`);
    results.push({ service, clusterName: observed });
  }
  return results;
}

export function stopOwnedService(fixture, service) {
  if (!SERVICES.includes(service)) throw new Error(`refusing to stop an unowned fixture service: ${service}`);
  const id = fixture.services[service];
  if (!id) throw new Error(`owned fixture service ${service} was not started`);
  const labels = JSON.parse(runDocker(['container', 'inspect', '--format', '{{json .Config.Labels}}', id]));
  if (labels?.['com.docker.compose.project'] !== fixture.projectId) throw new Error('refusing to stop a container outside the owned Compose project');
  runDocker(composeArgs(fixture, ['stop', '--timeout', '5', service]), { timeout: 15_000 });
  const running = runDocker(['container', 'inspect', '--format', '{{.State.Running}}', id]);
  if (running !== 'false') throw new Error(`owned fixture service ${service} remained running after stop`);
  return { service, containerId: id, running: false };
}

export async function assertInfrastructureHealthy(fixture) {
  const dbChecks = [
    ['orchestrator-source', 'du_orchestrator'],
    ['connector-source', 'du_connector'],
    ['orchestrator-restore', 'du_orchestrator'],
    ['connector-restore', 'du_connector'],
  ];
  for (const [service, database] of dbChecks) {
    runDocker(composeArgs(fixture, ['exec', '-T', service, 'pg_isready', '-U', 'orv14_host', '-d', database]));
  }
  const redisId = fixture.services.redis;
  const redisPing = runDocker(['exec', redisId, 'redis-cli', 'ping']);
  if (redisPing !== 'PONG') throw new Error('the isolated Redis service did not return PONG');

  const vaultStatuses = {};
  for (const name of ['vaultSource', 'vaultRestore']) {
    const response = await fetch(`${fixture.urls[name]}/v1/sys/health`, { signal: AbortSignal.timeout(5000) });
    if (![200, 429].includes(response.status)) throw new Error(`the isolated ${name} health endpoint returned ${response.status}`);
    vaultStatuses[name] = response.status;
  }
  const minioStatuses = {};
  for (const name of ['s3Source', 's3Restore']) {
    const response = await fetch(`${fixture.urls[name]}/minio/health/live`, { signal: AbortSignal.timeout(5000) });
    if (response.status !== 200) throw new Error(`the isolated ${name} live endpoint returned ${response.status}`);
    minioStatuses[name] = response.status;
  }
  return { postgresClusters: dbChecks.length, redis: redisPing, vaultStatuses, minioStatuses };
}

export async function cleanupHostInfrastructureFixture(fixture) {
  if (fixture.cleaned) return fixture.cleanupReceipt;
  const resources = { containers: containerIds(fixture), volumes: volumeNames(fixture), networks: networkNames(fixture) };
  assertProjectLabels(fixture, resources);
  if (resources.containers.length || resources.volumes.length || resources.networks.length) {
    runDocker(composeArgs(fixture, ['down', '--volumes', '--remove-orphans']), { timeout: 120_000 });
  }
  const after = { containers: containerIds(fixture), volumes: volumeNames(fixture), networks: networkNames(fixture) };
  if (after.containers.length || after.volumes.length || after.networks.length) {
    throw new Error(`owned Compose project ${fixture.projectId} still has resources after cleanup`);
  }
  await removeRootOwnedFixture(fixture);
  const rootReal = await realpath(fixture.root);
  if (rootReal !== fixture.root || !rootReal.startsWith('/tmp/orv14-vfy-host-')) {
    throw new Error('refusing temporary fixture removal outside its unique path');
  }
  await rm(fixture.root, { recursive: true, force: false });
  fixture.cleaned = true;
  fixture.cleanupReceipt = { projectId: fixture.projectId, removed: resources, remaining: after, temporaryFixtureRemoved: true };
  return fixture.cleanupReceipt;
}

export function fixtureConnectionUrl(db) {
  const user = encodeURIComponent(db.user);
  const password = encodeURIComponent(db.password);
  const database = encodeURIComponent(db.database);
  return `postgresql://${user}:${password}@${db.host}:${db.port}/${database}`;
}
