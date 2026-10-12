import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadComposeManifest, type ComposeManifest } from '../../../orchestrator/services/orchestrator/src/modules/compose-operations/manifest';

const DOCKER = '/usr/local/bin/docker';
const REDIS_IMAGE = 'redis@sha256:858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499';
const POSTGRES_IMAGE = 'postgres@sha256:721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea';
const INVALID_IMAGE_HASH = 'a'.repeat(64);

export interface DisposableComposeFixture {
  readonly hostId: string;
  readonly projectId: string;
  readonly manifestDigest: string;
  readonly manifest: ComposeManifest;
  readonly manifestWithoutEnvFile: ComposeManifest;
  readonly manifestPath: string;
  readonly workingDirectory: string;
  readonly homeDirectory: string;
  readonly dockerConfigDirectory: string;
  readonly runnerStateDirectory: string;
  readonly runnerJournalPath: string;
  readonly runnerLockPath: string;
  readonly redisDigest: string;
  readonly postgresDigest: string;
  readonly missingDigest: string;
  readonly fixtureRoot: string;
  readonly inputRoot: string;
  readonly helperImage: string;
  readonly engineVersion: string;
  readonly composeVersion: string;
  readonly dockerContextEndpoint: string;
  readonly cleanup: () => Promise<void>;
}

function docker(args: string[], timeout = 30_000): string {
  const result = spawnSync(DOCKER, ['--context', 'default', ...args], {
    encoding: 'utf8',
    timeout,
    maxBuffer: 4 * 1024 * 1024,
    env: process.env,
  });
  if (result.error) throw new Error(`docker ${args[0] ?? 'command'} failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`docker ${args[0] ?? 'command'} exited ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 1000)}`);
  }
  return result.stdout.trim();
}

function imageRepoDigest(image: string, expectedHash: string): string {
  const output = docker(['image', 'inspect', image, '--format', '{{json .RepoDigests}}']);
  const digests = JSON.parse(output) as unknown;
  if (!Array.isArray(digests)) throw new Error(`cached test image ${image} has no RepoDigests array`);
  const selected = digests.find((item): item is string => typeof item === 'string' && item.endsWith(`@sha256:${expectedHash}`));
  if (!selected) throw new Error(`cached test image ${image} does not expose its expected repository digest`);
  return selected;
}

function fileHash(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function appServices(webImage: string, workerImage: string): string {
  return `services:\n  web:\n    image: "${'${WEB_IMAGE:-' + webImage + '}'}"\n    entrypoint: ["/bin/sh", "-c"]\n    command: ["sleep 1800"]\n    labels:\n      orv13.sentinel: "${'${ORV13_SENTINEL:-default-sentinel}'}"\n    deploy:\n      replicas: 2\n  worker:\n    image: "${'${WORKER_IMAGE:-' + workerImage + '}'}"\n    entrypoint: ["/bin/sh", "-c"]\n    command: ["sleep 1800"]\n    labels:\n      orv13.sentinel: "${'${ORV13_SENTINEL:-default-sentinel}'}"\n    deploy:\n      replicas: 2\n`;
}

function releaseCompose(webVariable: string, workerVariable: string, webImage: string, workerImage: string): string {
  return `services:\n  web:\n    image: "${'${' + webVariable + ':-' + webImage + '}'}"\n    entrypoint: ["/bin/sh", "-c"]\n    command: ["sleep 1800"]\n    labels:\n      orv13.sentinel: "${'${ORV13_SENTINEL:-default-sentinel}'}"\n    deploy:\n      replicas: 2\n  worker:\n    image: "${'${' + workerVariable + ':-' + workerImage + '}'}"\n    entrypoint: ["/bin/sh", "-c"]\n    command: ["sleep 1800"]\n    labels:\n      orv13.sentinel: "${'${ORV13_SENTINEL:-default-sentinel}'}"\n    deploy:\n      replicas: 2\n`;
}

async function writeInput(inputRoot: string, name: string, content: string): Promise<void> {
  await writeFile(path.join(inputRoot, name), content, { mode: 0o600 });
}

async function provisionRootFixture(fixtureRoot: string, inputRoot: string, helperImage: string): Promise<void> {
  const rootScript = [
    'set -eu',
    'mkdir -p /fixture/trusted/config /fixture/trusted/project /fixture/trusted/home /fixture/trusted/docker-config',
    'chmod 0755 /fixture/trusted /fixture/trusted/config /fixture/trusted/project /fixture/trusted/home /fixture/trusted/docker-config',
    'install -o 0 -g 0 -m 0644 /inputs/manifest.json /fixture/trusted/config/manifest.json',
    'install -o 0 -g 0 -m 0644 /inputs/pinned.env /fixture/trusted/config/pinned.env',
    'install -o 0 -g 0 -m 0644 /inputs/compose-inventory.yaml /fixture/trusted/project/compose-inventory.yaml',
    'install -o 0 -g 0 -m 0644 /inputs/release-a.yaml /fixture/trusted/project/release-a.yaml',
    'install -o 0 -g 0 -m 0644 /inputs/release-b.yaml /fixture/trusted/project/release-b.yaml',
    'install -o 0 -g 0 -m 0644 /inputs/release-partial.yaml /fixture/trusted/project/release-partial.yaml',
    'install -o 0 -g 0 -m 0644 /inputs/.env /fixture/trusted/project/.env',
    "printf 'orv13-compose-root-owned-marker\\n' > /fixture/.orv13-root-owned-marker",
    'chmod 0644 /fixture/.orv13-root-owned-marker',
  ].join('; ');
  const result = spawnSync(DOCKER, [
    '--context', 'default', 'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh',
    '--mount', `type=bind,src=${inputRoot},dst=/inputs,readonly`,
    '--mount', `type=bind,src=${fixtureRoot},dst=/fixture`,
    helperImage, '-c', rootScript,
  ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, env: process.env });
  if (result.error) throw new Error(`root-owned fixture helper failed: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`root-owned fixture helper exited ${result.status}: ${(result.stderr || result.stdout).trim().slice(0, 1000)}`);

  const markerPath = path.join(fixtureRoot, '.orv13-root-owned-marker');
  const marker = await readFile(markerPath, 'utf8');
  const markerStat = await lstat(markerPath);
  const trustedProjectStat = await lstat(path.join(fixtureRoot, 'trusted', 'project'));
  const trustedManifestStat = await lstat(path.join(fixtureRoot, 'trusted', 'config', 'manifest.json'));
  if (marker !== 'orv13-compose-root-owned-marker\n' || markerStat.uid !== 0 || trustedProjectStat.uid !== 0
    || trustedManifestStat.uid !== 0 || (trustedProjectStat.mode & 0o022) !== 0 || (trustedManifestStat.mode & 0o022) !== 0) {
    throw new Error('bind-mounted helper did not produce the expected root-owned, non-writable fixture files');
  }
}

export async function createDisposableComposeFixture(): Promise<DisposableComposeFixture> {
  const suffix = randomUUID().replaceAll('-', '').slice(0, 10);
  const hostId = `orv13-host-${suffix}`;
  const projectId = `orv13-compose-vfy-${suffix}`;
  const fixtureRoot = await mkdtemp(path.join(os.tmpdir(), `orv13-compose-vfy-${suffix}-`));
  const inputRoot = await mkdtemp(path.join(os.tmpdir(), `orv13-compose-vfy-input-${suffix}-`));
  await chmod(fixtureRoot, 0o700);
  await chmod(inputRoot, 0o700);

  const runnerStateDirectory = await mkdtemp(path.join(os.tmpdir(), `orv13-compose-vfy-state-${suffix}-`));
  await chmod(runnerStateDirectory, 0o700);
  const trusted = path.join(fixtureRoot, 'trusted');
  const configDirectory = path.join(trusted, 'config');
  const workingDirectory = path.join(trusted, 'project');
  const homeDirectory = path.join(trusted, 'home');
  const dockerConfigDirectory = path.join(trusted, 'docker-config');
  const manifestPath = path.join(configDirectory, 'manifest.json');
  const pinnedEnvPath = path.join(configDirectory, 'pinned.env');
  const redisDigest = imageRepoDigest(REDIS_IMAGE, '858f009f9709ce576febc734aa78b8f6d624b82571f9ddb6bda4377c833b3499');
  const postgresDigest = imageRepoDigest(POSTGRES_IMAGE, '721873c34ceb9f8d8fc265984940dc982404c105f19ad51be9fdc5970a6080ea');
  const missingDigest = `registry.example.invalid/orv13-missing@sha256:${INVALID_IMAGE_HASH}`;

  const inventory = appServices(redisDigest, postgresDigest);
  const releaseA = releaseCompose('WEB_IMAGE', 'RELEASE_A_WORKER_IMAGE', redisDigest, postgresDigest);
  const releaseB = releaseCompose('WEB_IMAGE', 'RELEASE_B_WORKER_IMAGE', redisDigest, redisDigest);
  const releasePartial = releaseCompose('WEB_IMAGE', 'RELEASE_PARTIAL_WORKER_IMAGE', redisDigest, missingDigest);
  const files = [
    ['compose-inventory.yaml', inventory],
    ['release-a.yaml', releaseA],
    ['release-b.yaml', releaseB],
    ['release-partial.yaml', releasePartial],
  ] as const;
  const pinnedEnv = [
    `WEB_IMAGE=${redisDigest}`,
    `RELEASE_A_WORKER_IMAGE=${postgresDigest}`,
    `RELEASE_B_WORKER_IMAGE=${redisDigest}`,
    `RELEASE_PARTIAL_WORKER_IMAGE=${missingDigest}`,
    'ORV13_SENTINEL=explicit-pinned-env',
  ].join('\n') + '\n';
  const unpinnedEnv = [
    `WEB_IMAGE=registry.example.invalid/untrusted@sha256:${'b'.repeat(64)}`,
    `RELEASE_A_WORKER_IMAGE=registry.example.invalid/untrusted@sha256:${'c'.repeat(64)}`,
    `RELEASE_B_WORKER_IMAGE=registry.example.invalid/untrusted@sha256:${'d'.repeat(64)}`,
    `RELEASE_PARTIAL_WORKER_IMAGE=registry.example.invalid/untrusted@sha256:${'e'.repeat(64)}`,
    'ORV13_SENTINEL=untrusted-dotenv-value',
  ].join('\n') + '\n';
  for (const [name, content] of files) await writeInput(inputRoot, name, content);
  await writeInput(inputRoot, 'pinned.env', pinnedEnv);
  await writeInput(inputRoot, '.env', unpinnedEnv);

  const releaseDefinitions = [
    {
      releaseId: 'release-a', label: 'Release A', file: 'release-a.yaml', worker: postgresDigest, rollbackAllowedFrom: ['release-b'],
    },
    {
      releaseId: 'release-b', label: 'Release B', file: 'release-b.yaml', worker: redisDigest, rollbackAllowedFrom: [],
    },
    {
      releaseId: 'release-partial', label: 'Partial fixture release', file: 'release-partial.yaml', worker: missingDigest, rollbackAllowedFrom: [],
    },
  ];
  const manifest: Record<string, unknown> = {
    schemaVersion: 1,
    hostId,
    projectId,
    displayName: 'ORV13 synthetic Compose fixture',
    dockerBinary: DOCKER,
    dockerContext: 'default',
    workingDirectory,
    homeDirectory,
    dockerConfigDirectory,
    inventoryComposeFiles: [{ path: path.join(workingDirectory, 'compose-inventory.yaml'), sha256: fileHash(inventory) }],
    envFile: { path: pinnedEnvPath, sha256: fileHash(pinnedEnv) },
    applicationServices: [{ serviceId: 'web', label: 'Synthetic web worker' }, { serviceId: 'worker', label: 'Synthetic background worker' }],
    releases: releaseDefinitions.map(({ releaseId, label, file, worker, rollbackAllowedFrom }) => ({
      releaseId,
      label,
      composeFiles: [{ path: path.join(workingDirectory, file), sha256: fileHash(files.find(([name]) => name === file)![1]) }],
      serviceIds: ['web', 'worker'],
      imageDigests: { web: redisDigest, worker },
      migrationCompatibility: 'acknowledged',
      rollbackAllowedFrom,
    })),
  };
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  await writeInput(inputRoot, 'manifest.json', manifestBytes);
  await provisionRootFixture(fixtureRoot, inputRoot, POSTGRES_IMAGE);

  const helperVersion = docker(['version', '--format', '{{.Server.Version}}']);
  const composeVersion = docker(['compose', 'version', '--short']);
  const dockerContextEndpoint = docker(['context', 'inspect', 'default', '--format', '{{.Endpoints.docker.Host}}']);
  const actualDigest = fileHash(await readFile(manifestPath, 'utf8'));
  const loaded = await loadComposeManifest(manifestPath, actualDigest);
  const { envFile: _envFile, ...manifestWithoutEnvFile } = loaded.manifest;

  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    try {
      const containerIdsText = docker(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${projectId}`]);
      const containerIds = containerIdsText.split(/\s+/).filter(Boolean);
      if (containerIds.length > 0) docker(['rm', '--force', ...containerIds]);
      const networkIdsText = docker(['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${projectId}`]);
      const networkIds = networkIdsText.split(/\s+/).filter(Boolean);
      if (networkIds.length > 0) docker(['network', 'rm', ...networkIds]);
    } finally {
      const removeTrusted = spawnSync(DOCKER, [
        '--context', 'default', 'run', '--rm', '--network', 'none', '--entrypoint', '/bin/sh',
        '--mount', `type=bind,src=${fixtureRoot},dst=/fixture`, POSTGRES_IMAGE,
        '-c', 'rm -rf /fixture/trusted /fixture/.orv13-root-owned-marker',
      ], { encoding: 'utf8', timeout: 60_000, maxBuffer: 1024 * 1024, env: process.env });
      if (removeTrusted.status !== 0) {
        throw new Error(`root-owned fixture cleanup failed: ${(removeTrusted.stderr || removeTrusted.stdout || '').trim().slice(0, 1000)}`);
      }
      await rm(fixtureRoot, { recursive: true, force: true });
      await rm(inputRoot, { recursive: true, force: true });
      await rm(runnerStateDirectory, { recursive: true, force: true });
    }
  };

  return {
    hostId, projectId, manifestDigest: actualDigest, manifest: loaded.manifest,
    manifestWithoutEnvFile, manifestPath, workingDirectory, homeDirectory,
    dockerConfigDirectory,
    runnerStateDirectory,
    runnerJournalPath: path.join(runnerStateDirectory, 'journal.jsonl'),
    runnerLockPath: path.join(runnerStateDirectory, 'project.lock'),
    redisDigest, postgresDigest, missingDigest, fixtureRoot, inputRoot, helperImage: POSTGRES_IMAGE,
    engineVersion: helperVersion, composeVersion, dockerContextEndpoint, cleanup,
  };
}

export async function removeSyntheticProjectResources(projectId: string): Promise<void> {
  const containerIds = docker(['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${projectId}`]).split(/\s+/).filter(Boolean);
  if (containerIds.length > 0) docker(['rm', '--force', ...containerIds]);
  const networkIds = docker(['network', 'ls', '--quiet', '--filter', `label=com.docker.compose.project=${projectId}`]).split(/\s+/).filter(Boolean);
  if (networkIds.length > 0) docker(['network', 'rm', ...networkIds]);
}
