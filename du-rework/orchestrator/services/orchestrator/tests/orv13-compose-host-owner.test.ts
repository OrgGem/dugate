import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import * as manifestModule from '../src/modules/compose-operations/manifest';
import {
  ComposeHostExecutor,
  buildDockerInvocation,
  inferProjectRelease,
  type ComposeHostActionResult,
  type DockerObservation,
  type HostExecutorLifecycle,
} from '../src/modules/compose-operations/host-executor';
import {
  ComposeOperationsHostRunner,
  ComposeProjectLock,
  FsyncedRunnerJournal,
  loadRunnerConfigFromEnvironment,
  type ComposeRunnerConfig,
  type RunnerFetch,
} from '../src/modules/compose-operations/runner';
import {
  composeManifestSchema,
  composeReleaseDigest,
  type ComposeManifest,
  type LoadedComposeManifest,
} from '../src/modules/compose-operations/manifest';
import type {
  ComposeJob,
  ComposeObservedService,
  ComposePerServiceOutcome,
} from '../src/modules/compose-operations/contracts';

const NOW = '2026-10-11T16:00:00.000Z';
const IMAGE_HASH = 'b'.repeat(64);
const OBSERVED_DIGEST = 'c'.repeat(64);
const MANIFEST_DIGEST = 'a'.repeat(64);
const CONTAINER_ID = 'd'.repeat(64);
const IMAGE_ID = `sha256:${IMAGE_HASH}`;
const REPO_DIGEST = `registry.example.test/app@sha256:${IMAGE_HASH}`;

let tempDirectory = '';

function createManifest(): ComposeManifest {
  return composeManifestSchema.parse({
    schemaVersion: 1,
    hostId: 'host-test',
    projectId: 'project-test',
    displayName: 'Disposable app',
    dockerBinary: '/srv/compose-test/bin/docker',
    dockerContext: 'fixture-context',
    workingDirectory: '/srv/compose-test/app',
    homeDirectory: '/srv/compose-test/home',
    dockerConfigDirectory: '/srv/compose-test/docker-config',
    inventoryComposeFiles: [{ path: '/srv/compose-test/app/compose.yaml', sha256: '1'.repeat(64) }],
    applicationServices: [{ serviceId: 'app', label: 'Application' }],
    releases: [{
      releaseId: 'release-one',
      label: 'Release one',
      composeFiles: [{ path: '/srv/compose-test/app/compose.yaml', sha256: '1'.repeat(64) }],
      serviceIds: ['app'],
      imageDigests: { app: REPO_DIGEST },
      migrationCompatibility: 'acknowledged',
      rollbackAllowedFrom: [],
    }],
  });
}

function observedService(overrides: Partial<ComposeObservedService> = {}): ComposeObservedService {
  return {
    serviceId: 'app',
    containerId: CONTAINER_ID,
    imageId: IMAGE_ID,
    imageDigest: REPO_DIGEST,
    state: 'RUNNING',
    health: 'HEALTHY',
    startedAt: NOW,
    finishedAt: null,
    observedReleaseId: 'release-one',
    ...overrides,
  };
}

function makeJob(overrides: Partial<ComposeJob> = {}): ComposeJob {
  return {
    jobId: '4d2866b8-8de0-40dc-a1b9-e0935ad59b77',
    previewId: 'e522c63b-a71e-48ab-bac8-2d9d524ab207',
    hostId: 'host-test',
    projectId: 'project-test',
    action: 'restart_service',
    releaseId: null,
    serviceId: 'app',
    targetReleaseDigest: null,
    targetServices: ['app'],
    reason: 'Recover the application process',
    actorLabel: 'admin@example.test',
    state: 'CLAIMED',
    stateVersion: 1,
    expectedTargetRevision: 1,
    targetRevision: 2,
    createdAt: NOW,
    startedAt: null,
    completedAt: null,
    claimExpiresAt: '2026-10-11T16:01:00.000Z',
    observedBeforeDigest: OBSERVED_DIGEST,
    startExpectedObservedDigest: OBSERVED_DIGEST,
    observedBefore: [observedService()],
    observedAfter: null,
    observedAfterDigest: null,
    perServiceOutcomes: [],
    uncertainReason: null,
    ...overrides,
  };
}

function finalJob(state: 'SUCCEEDED' | 'FAILED', overrides: Partial<ComposeJob> = {}): ComposeJob {
  return makeJob({
    state,
    stateVersion: 3,
    startedAt: NOW,
    completedAt: NOW,
    claimExpiresAt: null,
    observedAfter: [observedService()],
    observedAfterDigest: 'e'.repeat(64),
    perServiceOutcomes: [{ serviceId: 'app', status: state === 'SUCCEEDED' ? 'SUCCEEDED' : 'FAILED', errorCode: null }],
    ...overrides,
  });
}

function responseJson(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function mockChild(stdoutText: string, exitCode = 0, pid = 4242): ChildProcess {
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(new EventEmitter(), {
    pid,
    stdout,
    stderr,
    stdin: null,
    kill: jest.fn(() => true),
  }) as unknown as ChildProcess;
  setImmediate(() => {
    stdout.once('end', () => child.emit('close', exitCode, null));
    stdout.end(stdoutText);
    stderr.end();
  });
  return child;
}

function dockerInventorySpawn(callNumber: { value: number }, calls: Array<{ args: string[]; options: SpawnOptions }>): typeof spawn {
  return ((_: string, args: string[], options: SpawnOptions) => {
    callNumber.value += 1;
    calls.push({ args: [...args], options });
    const appShortId = CONTAINER_ID.slice(0, 12);
    const dbId = 'f'.repeat(64);
    let output = '';
    if (args.includes('compose')) {
      output = JSON.stringify([
        { Service: 'app', ID: appShortId, State: 'running' },
        { Service: 'db', ID: dbId.slice(0, 12), State: 'running' },
      ]);
    } else if (args.includes('container') && args.includes('inspect')) {
      output = `${CONTAINER_ID}\t${IMAGE_ID}\trunning\t${NOW}\t\thealthy\n`;
    } else if (args.includes('image') && args.includes('inspect')) {
      output = `${IMAGE_ID}\t${JSON.stringify([REPO_DIGEST])}\n`;
    }
    return mockChild(output, 0, 5000 + callNumber.value);
  }) as unknown as typeof spawn;
}

function runnerConfig(directory: string): ComposeRunnerConfig {
  return {
    baseUrl: 'http://127.0.0.1:9183',
    hostId: 'host-test',
    runnerToken: 'QwErTy_1234567890abcdefghijklmno',
    manifestPath: path.join(directory, 'manifest.json'),
    manifestDigest: MANIFEST_DIGEST,
    journalPath: path.join(directory, 'runner', 'journal.jsonl'),
    lockPath: path.join(directory, 'runner', 'lock'),
    pollIntervalMs: 1_000,
  };
}

async function createRunnerDirectory(): Promise<string> {
  tempDirectory = await mkdtemp(path.join(os.tmpdir(), 'orv13-compose-owner-'));
  await chmod(tempDirectory, 0o700);
  await mkdir(path.join(tempDirectory, 'runner'), { mode: 0o700 });
  return tempDirectory;
}

const loadedManifest: LoadedComposeManifest = {
  manifest: createManifest(),
  sha256: MANIFEST_DIGEST,
  path: '/srv/compose-test/manifest.json',
};

afterEach(async () => {
  jest.restoreAllMocks();
  if (tempDirectory) await rm(tempDirectory, { recursive: true, force: true });
  tempDirectory = '';
});

describe('UI13 Compose host runner', () => {
  it('rejects project identifiers outside Docker Compose project-name syntax', () => {
    const validManifest = createManifest();
    expect(composeManifestSchema.safeParse({ ...validManifest, projectId: 'App.Stack' }).success).toBe(false);
    expect(composeManifestSchema.safeParse({ ...validManifest, projectId: 'App-stack' }).success).toBe(false);
  });

  it('disables implicit Compose .env and excludes inherited Compose/Docker overrides', () => {
    const manifest = createManifest();
    const priorValues = new Map(['COMPOSE_FILE', 'COMPOSE_ENV_FILES', 'COMPOSE_PROFILES', 'DOCKER_HOST', 'DOCKER_CONTEXT']
      .map((name) => [name, process.env[name]] as const));
    try {
      process.env.COMPOSE_FILE = '/untrusted/compose.yaml';
      process.env.COMPOSE_ENV_FILES = '/untrusted/.env';
      process.env.COMPOSE_PROFILES = 'untrusted';
      process.env.DOCKER_HOST = 'tcp://untrusted.invalid:2375';
      process.env.DOCKER_CONTEXT = 'untrusted';

      const apply = buildDockerInvocation(manifest, { kind: 'apply', releaseId: 'release-one' });
      expect(apply.executable).toBe(manifest.dockerBinary);
      expect(apply.cwd).toBe(manifest.workingDirectory);
      expect(apply.args).toEqual([
        '--context', 'fixture-context', 'compose', '--project-name', 'project-test',
        '--project-directory', '/srv/compose-test/app', '--file', '/srv/compose-test/app/compose.yaml',
        'up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'app',
      ]);
      expect(apply.env).toMatchObject({ COMPOSE_DISABLE_ENV_FILE: '1' });
      for (const key of priorValues.keys()) expect(apply.env).not.toHaveProperty(key);

      const explicitlyPinnedEnv = {
        ...manifest,
        envFile: { path: '/etc/compose-runner/pinned.env', sha256: '2'.repeat(64) },
      };
      const explicitApply = buildDockerInvocation(explicitlyPinnedEnv, { kind: 'apply', releaseId: 'release-one' });
      expect(explicitApply.args).toContain('--env-file');
      expect(explicitApply.args).toContain('/etc/compose-runner/pinned.env');
    } finally {
      for (const [name, previous] of priorValues) {
        if (previous === undefined) delete process.env[name];
        else process.env[name] = previous;
      }
    }
    expect(buildDockerInvocation(manifest, { kind: 'restart', serviceId: 'app' }).args.slice(-4))
      .toEqual(['restart', '--timeout', '20', 'app']);
    expect(() => buildDockerInvocation(manifest, { kind: 'restart', serviceId: 'app; touch /tmp/pwned' }))
      .toThrow('MANIFEST_DIGEST_MISMATCH');
  });

  it('uses container inspect for container fields and image inspect for real RepoDigests', async () => {
    const calls: Array<{ args: string[]; options: SpawnOptions }> = [];
    const executor = new ComposeHostExecutor({ spawn: dockerInventorySpawn({ value: 0 }, calls), now: () => new Date(NOW) });
    const observation = await executor.observe(createManifest());

    expect(observation.services).toEqual([observedService()]);
    expect(calls).toHaveLength(3);
    expect(calls[1]?.args).toContain('container');
    expect(calls[1]?.args).toContain('inspect');
    expect(calls[2]?.args).toContain('image');
    expect(calls[2]?.args).toContain(IMAGE_ID);
    expect(calls.every(({ options }) => options.shell === false)).toBe(true);
    expect(calls.every(({ options }) => options.env?.DOCKER_HOST === undefined && options.env?.DOCKER_CONTEXT === undefined)).toBe(true);
    expect(calls.flatMap(({ args }) => args).join(' ')).not.toMatch(/\.Env|\.Mounts|logs/);
  });

  it('parses multiple real-format rows when Health is absent and preserves the final empty health field', async () => {
    const firstContainerId = 'd'.repeat(64);
    const secondContainerId = 'e'.repeat(64);
    const calls: Array<{ args: string[]; options: SpawnOptions }> = [];
    const spawnMock = ((_: string, args: string[], options: SpawnOptions) => {
      calls.push({ args: [...args], options });
      let output = '';
      if (args.includes('compose')) {
        output = JSON.stringify([
          { Service: 'app', ID: firstContainerId.slice(0, 12), State: 'running' },
          { Service: 'app', ID: secondContainerId.slice(0, 12), State: 'running' },
        ]);
      } else if (args.includes('container') && args.includes('inspect')) {
        output = [firstContainerId, secondContainerId]
          .map((containerId) => `${containerId}\t${IMAGE_ID}\trunning\t${NOW}\t\t`)
          .join('\n') + '\n';
      } else if (args.includes('image') && args.includes('inspect')) {
        output = `${IMAGE_ID}\t${JSON.stringify([REPO_DIGEST])}\n`;
      }
      return mockChild(output, 0, 6000 + calls.length);
    }) as unknown as typeof spawn;
    const executor = new ComposeHostExecutor({ spawn: spawnMock, now: () => new Date(NOW) });

    const observation = await executor.observe(createManifest());

    expect(observation.services).toHaveLength(2);
    expect(observation.services.map(({ containerId, health }) => ({ containerId, health }))).toEqual([
      { containerId: firstContainerId, health: 'NONE' },
      { containerId: secondContainerId, health: 'NONE' },
    ]);
    expect(calls[1]?.args).toContain(
      '{{.Id}}\t{{.Image}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}\t{{with index .State "Health"}}{{.Status}}{{end}}',
    );
  });

  it('infers a release only from a unique complete project image vector', () => {
    const base = createManifest();
    const workerImageOne = `registry.example.test/worker@sha256:${'7'.repeat(64)}`;
    const workerImageTwo = `registry.example.test/worker@sha256:${'8'.repeat(64)}`;
    const manifest = composeManifestSchema.parse({
      ...base,
      applicationServices: [...base.applicationServices, { serviceId: 'worker', label: 'Worker' }],
      releases: [
        { ...base.releases[0], serviceIds: ['app', 'worker'], imageDigests: { app: REPO_DIGEST, worker: workerImageOne } },
        {
          ...base.releases[0], releaseId: 'release-two', label: 'Release two', serviceIds: ['app', 'worker'],
          imageDigests: { app: REPO_DIGEST, worker: workerImageTwo }, rollbackAllowedFrom: ['release-one'],
        },
      ],
    });
    const services = [
      observedService(),
      observedService({ serviceId: 'worker', containerId: '9'.repeat(64), imageId: `sha256:${'7'.repeat(64)}`, imageDigest: workerImageOne, observedReleaseId: null }),
    ];
    expect(inferProjectRelease(manifest, services)).toBe('release-one');

    const ambiguousManifest = composeManifestSchema.parse({
      ...manifest,
      releases: [
        manifest.releases[0],
        { ...manifest.releases[0], releaseId: 'release-identical-images', label: 'Config-only release', rollbackAllowedFrom: ['release-one'] },
      ],
    });
    expect(inferProjectRelease(ambiguousManifest, services)).toBeNull();
  });

  it('bounds and journals a mutating command while reporting only safe selected outcomes', async () => {
    const calls: Array<{ args: string[]; options: SpawnOptions }> = [];
    let pid = 7000;
    const spawnMock = ((_: string, args: string[], options: SpawnOptions) => {
      pid += 1;
      calls.push({ args: [...args], options });
      const output = args.includes('compose')
        ? JSON.stringify([{ Service: 'app', ID: CONTAINER_ID.slice(0, 12), State: 'running' }])
        : args.includes('container')
          ? `${CONTAINER_ID}\t${IMAGE_ID}\trunning\t${NOW}\t\thealthy\n`
          : args.includes('image')
            ? `${IMAGE_ID}\t${JSON.stringify([REPO_DIGEST])}\n`
            : 'private warning that is never returned to the caller\n';
      return mockChild(output, 0, pid);
    }) as unknown as typeof spawn;
    const executor = new ComposeHostExecutor({ spawn: spawnMock, now: () => new Date(NOW), sleep: async () => undefined });
    const lifecycleRecords: string[] = [];
    const lifecycle: HostExecutorLifecycle = {
      onSpawn: (childPid) => lifecycleRecords.push(`start:${childPid}`),
      onExit: (childPid, exitCode) => lifecycleRecords.push(`exit:${childPid}:${exitCode}`),
    };
    const job = makeJob({
      action: 'apply_release',
      releaseId: 'release-one',
      serviceId: null,
      targetReleaseDigest: composeReleaseDigest(createManifest().releases[0]!),
      targetServices: ['app'],
    });

    const result = await executor.execute(job, createManifest(), [observedService()], lifecycle);

    expect(result.outcome).toBe('SUCCEEDED');
    expect(result.observedServices).toEqual([observedService()]);
    expect(JSON.stringify(result)).not.toContain('private warning');
    expect(calls[0]?.args.slice(-7)).toEqual(['up', '-d', '--no-build', '--pull', 'never', '--no-deps', 'app']);
    expect(calls.every(({ options }) => options.shell === false)).toBe(true);
    expect(lifecycleRecords).toEqual(['start:7001', 'exit:7001:0']);
  });

  it('marks oversized Docker output unknown and never returns raw output', async () => {
    const secretMarker = 'PRIVATE_DOCKER_OUTPUT_MARKER';
    const oversizedOutput = secretMarker.repeat(12_000);
    const spawnMock = ((_: string, __: string[], ___: SpawnOptions) => mockChild(oversizedOutput, 0, 2_000_000_000)) as unknown as typeof spawn;
    const executor = new ComposeHostExecutor({ spawn: spawnMock, now: () => new Date(NOW) });
    const result = await executor.execute(makeJob(), createManifest(), [observedService()]);
    expect(result.outcome).toBe('UNKNOWN');
    expect(result.errorCode).toBe('OUTPUT_LIMIT');
    expect(result.uncertainReason).toBe('EXECUTION_UNCERTAIN');
    expect(JSON.stringify(result)).not.toContain(secretMarker);
  });

  it('fsyncs a private journal and protects the project lock from a second runner', async () => {
    const directory = await createRunnerDirectory();
    const journalPath = path.join(directory, 'runner', 'journal.jsonl');
    const journal = new FsyncedRunnerJournal(journalPath);
    await journal.open();
    journal.appendSync({ kind: 'START_INTENT', at: NOW, jobId: 'job-test' });
    await journal.close();
    expect((await stat(journalPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(journalPath, 'utf8')).toContain('START_INTENT');
    const reopened = new FsyncedRunnerJournal(journalPath);
    await reopened.open();
    expect(reopened.all()).toHaveLength(1);
    await reopened.close();

    const lockPath = path.join(directory, 'runner', 'lock');
    const first = new ComposeProjectLock(lockPath, 'host-test', 'project-test');
    const second = new ComposeProjectLock(lockPath, 'host-test', 'project-test');
    await first.acquire();
    await expect(second.acquire()).rejects.toMatchObject({ code: 'runner_lock_held' });
    await first.release();
    await second.acquire();
    await second.release();
  });

  it('does not spawn a host command when start acknowledgement is lost', async () => {
    const directory = await createRunnerDirectory();
    const loadSpy = jest.spyOn(manifestModule, 'loadComposeManifest').mockResolvedValue(loadedManifest);
    const reloadSpy = jest.spyOn(manifestModule, 'reloadAndCheckManifest').mockResolvedValue(loadedManifest);
    const executor = {
      observe: jest.fn(async (): Promise<DockerObservation> => ({ sampledAt: NOW, services: [observedService()] })),
      execute: jest.fn(async (): Promise<ComposeHostActionResult> => ({
        outcome: 'SUCCEEDED', errorCode: null, uncertainReason: null, sampledAt: NOW,
        observedServices: [observedService()], perServiceOutcomes: [{ serviceId: 'app', status: 'SUCCEEDED', errorCode: null }],
      })),
    } as unknown as ComposeHostExecutor;
    const claimed = makeJob();
    let claimedOnce = false;
    const requestPaths: string[] = [];
    const fetcher: RunnerFetch = async (input, init) => {
      const url = new URL(String(input));
      requestPaths.push(url.pathname);
      if (url.pathname.endsWith('/snapshot')) {
        return responseJson({
          hostId: 'host-test', manifestDigest: MANIFEST_DIGEST, receivedAt: NOW,
          projects: [{ projectId: 'project-test', catalogRevision: 'f'.repeat(64), observedDigest: OBSERVED_DIGEST, targetRevision: 2 }],
        });
      }
      if (url.pathname.endsWith('/claim')) {
        if (claimedOnce) return responseJson({ claim: null });
        claimedOnce = true;
        return responseJson({ claim: { job: claimed, executionToken: 'z'.repeat(32) } });
      }
      if (url.pathname.endsWith('/start')) {
        expect(init?.redirect).toBe('manual');
        throw new Error('start acknowledgement connection lost');
      }
      throw new Error('unexpected host API request');
    };
    const runner = new ComposeOperationsHostRunner({
      ...runnerConfig(directory),
      manifestDigest: loadedManifest.sha256,
    }, { fetch: fetcher, executor, now: () => new Date(NOW), sleep: async () => undefined });
    try {
      await runner.initialize();
      await expect(runner.runCycle()).resolves.toBe('job');
      expect(executor.execute).not.toHaveBeenCalled();
      expect(requestPaths.filter((value) => value.endsWith('/start'))).toHaveLength(1);
      expect(runner.journal.all().some((record) => record.kind === 'START_ACK_UNCERTAIN')).toBe(true);
      expect(runner.journal.all().some((record) => record.kind === 'ACTION_OUTCOME')).toBe(false);
    } finally {
      await runner.close();
      loadSpy.mockRestore();
      reloadSpy.mockRestore();
    }
  });

  it('retries only a pending completion report after transport loss, never the host action', async () => {
    const directory = await createRunnerDirectory();
    const loadSpy = jest.spyOn(manifestModule, 'loadComposeManifest').mockResolvedValue(loadedManifest);
    const reloadSpy = jest.spyOn(manifestModule, 'reloadAndCheckManifest').mockResolvedValue(loadedManifest);
    const outcomes: ComposePerServiceOutcome[] = [{ serviceId: 'app', status: 'SUCCEEDED', errorCode: null }];
    const executor = {
      observe: jest.fn(async (): Promise<DockerObservation> => ({ sampledAt: NOW, services: [observedService()] })),
      execute: jest.fn(async (): Promise<ComposeHostActionResult> => ({
        outcome: 'SUCCEEDED', errorCode: null, uncertainReason: null, sampledAt: NOW,
        observedServices: [observedService()], perServiceOutcomes: outcomes,
      })),
    } as unknown as ComposeHostExecutor;
    const claimed = makeJob();
    let claimedOnce = false;
    let completionAttempts = 0;
    const completionBodies: string[] = [];
    const fetcher: RunnerFetch = async (input, init) => {
      const url = new URL(String(input));
      if (url.pathname.endsWith('/snapshot')) {
        return responseJson({
          hostId: 'host-test', manifestDigest: MANIFEST_DIGEST, receivedAt: NOW,
          projects: [{ projectId: 'project-test', catalogRevision: 'f'.repeat(64), observedDigest: OBSERVED_DIGEST, targetRevision: 2 }],
        });
      }
      if (url.pathname.endsWith('/claim')) {
        if (claimedOnce) return responseJson({ claim: null });
        claimedOnce = true;
        return responseJson({ claim: { job: claimed, executionToken: 'z'.repeat(32) } });
      }
      if (url.pathname.endsWith('/start')) {
        return responseJson({ jobId: claimed.jobId, state: 'RUNNING', stateVersion: 2, startedAt: NOW });
      }
      if (url.pathname.endsWith('/complete')) {
        completionAttempts += 1;
        completionBodies.push(String(init?.body));
        if (completionAttempts === 1) throw new Error('completion acknowledgement connection lost');
        return responseJson({ job: finalJob('SUCCEEDED') });
      }
      throw new Error('unexpected host API request');
    };
    const runner = new ComposeOperationsHostRunner({
      ...runnerConfig(directory),
      manifestDigest: loadedManifest.sha256,
    }, { fetch: fetcher, executor, now: () => new Date(NOW), sleep: async () => undefined });
    try {
      await runner.initialize();
      await expect(runner.runCycle()).resolves.toBe('job');
      expect(executor.execute).toHaveBeenCalledTimes(1);
      await expect(runner.runCycle()).resolves.toBe('idle');
      expect(completionAttempts).toBe(2);
      expect(completionBodies[1]).toBe(completionBodies[0]);
      expect(executor.execute).toHaveBeenCalledTimes(1);
      expect(runner.journal.all().some((record) => record.kind === 'COMPLETE_ACK')).toBe(true);
    } finally {
      await runner.close();
      loadSpy.mockRestore();
      reloadSpy.mockRestore();
    }
  });

  it('requires server UNKNOWN and quiescent stable state, then retries the exact reconcile ACK before superseding a stale report', async () => {
    const directory = await createRunnerDirectory();
    const loadSpy = jest.spyOn(manifestModule, 'loadComposeManifest').mockResolvedValue(loadedManifest);
    const reloadSpy = jest.spyOn(manifestModule, 'reloadAndCheckManifest').mockResolvedValue(loadedManifest);
    const claimed = makeJob();
    const unknown = makeJob({ state: 'UNKNOWN', stateVersion: 3, claimExpiresAt: null, uncertainReason: 'RUNNER_LOST' });
    const reconciled = makeJob({ state: 'RECONCILED', stateVersion: 4, claimExpiresAt: null, completedAt: NOW, uncertainReason: null });
    const completionRequest = {
      jobId: claimed.jobId,
      executionToken: 'z'.repeat(32),
      expectedStateVersion: 2,
      manifestDigest: MANIFEST_DIGEST,
      sampledAt: NOW,
      outcome: 'SUCCEEDED' as const,
      errorCode: null,
      uncertainReason: null,
      observedServices: [observedService()],
      perServiceOutcomes: [{ serviceId: 'app', status: 'SUCCEEDED' as const, errorCode: null }],
    };
    let getCount = 0;
    let reconcileCount = 0;
    let claimCount = 0;
    const reconcileBodies: string[] = [];
    const paths: string[] = [];
    const fetcher: RunnerFetch = async (input, init) => {
      const url = new URL(String(input));
      paths.push(`${init?.method ?? 'GET'} ${url.pathname}`);
      if (url.pathname.endsWith(`/jobs/${claimed.jobId}`)) {
        getCount += 1;
        return responseJson(getCount === 1 ? unknown : reconciled);
      }
      if (url.pathname.endsWith('/snapshot')) {
        return responseJson({
          hostId: 'host-test', manifestDigest: MANIFEST_DIGEST, receivedAt: NOW,
          projects: [{ projectId: 'project-test', catalogRevision: 'f'.repeat(64), observedDigest: OBSERVED_DIGEST, targetRevision: 2 }],
        });
      }
      if (url.pathname.endsWith('/reconcile')) {
        reconcileCount += 1;
        reconcileBodies.push(String(init?.body));
        if (reconcileCount === 1) throw new Error('reconcile acknowledgement connection lost');
        return responseJson({ job: reconciled });
      }
      if (url.pathname.endsWith('/claim')) {
        claimCount += 1;
        return responseJson({ claim: null });
      }
      throw new Error('unexpected host API request');
    };
    const executor = {
      observe: jest.fn(async (): Promise<DockerObservation> => ({ sampledAt: NOW, services: [observedService()] })),
      execute: jest.fn(),
    } as unknown as ComposeHostExecutor;
    const runner = new ComposeOperationsHostRunner({ ...runnerConfig(directory), manifestDigest: loadedManifest.sha256 }, {
      fetch: fetcher,
      executor,
      now: () => new Date(NOW),
      sleep: async () => undefined,
    });
    try {
      await runner.initialize();
      await runner.journal.append({ kind: 'CLAIM', at: NOW, jobId: claimed.jobId, claim: { job: claimed, executionToken: 'z'.repeat(32) } });
      await runner.journal.append({ kind: 'COMPLETE_PENDING', at: NOW, jobId: claimed.jobId, request: completionRequest });
      await runner.journal.append({ kind: 'EXECUTOR_PID', at: NOW, jobId: claimed.jobId, pid: 2_000_000_000 });
      await expect(runner.reconcileLocally({ jobId: claimed.jobId, stateVersion: 3, confirmQuiescent: true }))
        .rejects.toMatchObject({ kind: 'network' });
      expect(runner.journal.all().some((record) => record.kind === 'REPORT_SUPERSEDED')).toBe(false);

      await expect(runner.reconcileLocally({ jobId: claimed.jobId, stateVersion: 3, confirmQuiescent: true }))
        .resolves.toMatchObject({ state: 'RECONCILED' });
      expect(reconcileCount).toBe(2);
      expect(reconcileBodies[1]).toBe(reconcileBodies[0]);
      const kinds = runner.journal.all().filter((record) => record.jobId === claimed.jobId).map((record) => record.kind);
      expect(kinds.indexOf('REPORT_SUPERSEDED')).toBeGreaterThan(kinds.lastIndexOf('RECONCILE_ACK'));
      expect(await runner.runCycle()).toBe('idle');
      expect(paths.some((value) => value.includes('/complete'))).toBe(false);
      expect(claimCount).toBe(1);
    } finally {
      await runner.close();
      loadSpy.mockRestore();
      reloadSpy.mockRestore();
    }
  });

  it('accepts base64url host tokens but requires TLS for non-loopback runner URLs', async () => {
    await expect(loadRunnerConfigFromEnvironment({
      COMPOSE_OPERATIONS_RUNNER_BASE_URL: 'https://runner.example.test',
      COMPOSE_OPERATIONS_HOST_ID: 'host-test',
      COMPOSE_OPERATIONS_RUNNER_TOKEN: 'QwErTy_1234567890abcdefghijklmno',
      COMPOSE_OPERATIONS_MANIFEST_PATH: '/srv/compose-test/manifest.json',
      COMPOSE_OPERATIONS_MANIFEST_DIGEST: MANIFEST_DIGEST,
      COMPOSE_OPERATIONS_JOURNAL_PATH: '/var/lib/compose-runner/journal.jsonl',
      COMPOSE_OPERATIONS_LOCK_PATH: '/var/lib/compose-runner/lock',
    })).resolves.toMatchObject({ runnerToken: 'QwErTy_1234567890abcdefghijklmno' });
    await expect(loadRunnerConfigFromEnvironment({
      COMPOSE_OPERATIONS_RUNNER_BASE_URL: 'http://runner.example.test',
      COMPOSE_OPERATIONS_HOST_ID: 'host-test',
      COMPOSE_OPERATIONS_RUNNER_TOKEN: 'QwErTy_1234567890abcdefghijklmno',
      COMPOSE_OPERATIONS_MANIFEST_PATH: '/srv/compose-test/manifest.json',
      COMPOSE_OPERATIONS_MANIFEST_DIGEST: MANIFEST_DIGEST,
      COMPOSE_OPERATIONS_JOURNAL_PATH: '/var/lib/compose-runner/journal.jsonl',
      COMPOSE_OPERATIONS_LOCK_PATH: '/var/lib/compose-runner/lock',
    })).rejects.toMatchObject({ code: 'runner_config_invalid' });
  });
});
