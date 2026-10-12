import { randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, realpath, rename, stat, unlink } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import path from 'node:path';
import type { MaintenanceScope } from '@du/contracts';
import type {
  ReplicaObservation,
  ReplicaRolloutAdapter,
  ReplicaRolloutCapabilities,
} from './maintenance-service';
import { isFreshObservation, sumAuthoritativeWork, type ReplicaRuntimeObservation, type ReplicaRuntimeSafetyPort } from './replica-runtime-safety';
import { registerActiveMaintenanceCommand } from './active-command-shutdown';
import {
  ROLLOUT_SHA256 as SHA256,
  TrustedRolloutManifestSchema as ManifestSchema,
  readTrustedRolloutFile as readTrustedFile,
  rolloutImageMatches as imageMatches,
  rolloutReleaseFor as releaseFor,
  rolloutSafeSlot as safeSlot,
  rolloutTargetFor as targetFor,
  type TrustedRolloutManifest as Manifest,
  type TrustedRolloutService as RolloutService,
  type TrustedRolloutTarget as Target,
  type TrustedRolloutSlot as Slot,
} from './trusted-rollout-manifest';
export {
  readFixedIngressProbeUrlMap,
  readReplicaRuntimeControlTargets,
  readWorkerReplicaBusinessMap,
} from './trusted-rollout-manifest';

function manifestCapabilities(manifest: Manifest): ReplicaRolloutCapabilities {
  const services = manifest.targets.map((target) => target.service);
  return {
    services,
    fixedIngressServices: manifest.targets
      .filter((target) => target.service !== 'worker')
      .map((target) => target.service as 'orchestrator' | 'connector'),
    workerReplacement: services.includes('worker'),
  };
}

export interface TrustedManifestRolloutAdapterOptions {
  /** Canonical path to a root-owned, non-writable deployment manifest. */
  manifestPath: string;
  /** Deployment manifest digest pinned by the service configuration. */
  expectedManifestSha256: string;
  /** Required authenticated evidence/control source. There is no Docker-only fallback. */
  runtimeSafety: ReplicaRuntimeSafetyPort;
  now?: () => Date;
  sleep?: (milliseconds: number) => Promise<void>;
  /** Test seam. Production defaults to a bounded shell-free child process. */
  spawn?: typeof spawn;
}

interface RunResult { stdout: Buffer; exitCode: number | null; uncertain: boolean; }
interface ContainerRow { id: string; name: string; state: string; }
interface InspectRow { id: string; image: string; state: string; health: string; startedAt: string; serviceId: string; }

function noGroupOrWorldWrite(mode: number): boolean { return (mode & (fsConstants.S_IWGRP | fsConstants.S_IWOTH)) === 0; }

async function validateExecutable(executable: string, expectedSha256: string): Promise<void> {
  const bytes = await readTrustedFile(executable, expectedSha256, 256 * 1024 * 1024);
  void bytes;
  const details = await stat(executable);
  if ((details.mode & (fsConstants.S_IXUSR | fsConstants.S_IXGRP | fsConstants.S_IXOTH)) === 0) throw new Error('ROLLOUT_EXECUTOR_UNTRUSTED');
}

function safeEnv(manifest: Manifest): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: manifest.homeDirectory,
    DOCKER_CONFIG: manifest.dockerConfigDirectory,
    LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8', TZ: 'UTC', NO_COLOR: '1',
    DOCKER_CLI_HINTS: 'false', COMPOSE_DISABLE_ENV_FILE: '1',
  };
}

function runBounded(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  timeoutMs: number,
  spawnImplementation: typeof spawn,
): Promise<RunResult> {
  return new Promise((resolve) => {
    let settled = false;
    let timedOut = false;
    let interrupted = false;
    let total = 0;
    const output: Buffer[] = [];
    let child: ChildProcess;
    let timer: NodeJS.Timeout | undefined;
    let killTimer: NodeJS.Timeout | undefined;
    let unregisterStop: (() => void) | undefined;
    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      unregisterStop?.();
      resolve({ stdout: Buffer.concat(output), exitCode, uncertain: timedOut || interrupted || total > 256 * 1024 });
    };
    try {
      child = spawnImplementation(executable, [...args], {
        cwd, env: { ...env }, shell: false, detached: process.platform !== 'win32', windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch { finish(null); return; }
    const terminate = (shutdown: boolean): void => {
      if (timedOut || interrupted || settled) return;
      if (shutdown) interrupted = true;
      else timedOut = true;
      try {
        if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
        else child.kill('SIGTERM');
      } catch { /* process has exited */ }
      killTimer = setTimeout(() => {
        try {
          if (child.pid !== undefined && process.platform !== 'win32') process.kill(-child.pid, 'SIGKILL');
          else child.kill('SIGKILL');
        } catch { /* process has exited */ }
      }, 500);
      killTimer.unref?.();
    };
    unregisterStop = registerActiveMaintenanceCommand(() => terminate(true));
    timer = setTimeout(() => terminate(false), timeoutMs);
    timer.unref?.();
    const onChunk = (chunk: Buffer | string, keep: boolean): void => {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.length;
      if (keep && total <= 256 * 1024) output.push(bytes);
      if (total > 256 * 1024) terminate(false);
    };
    child.stdout?.on('data', (chunk: Buffer | string) => onChunk(chunk, true));
    child.stderr?.on('data', (chunk: Buffer | string) => onChunk(chunk, false));
    child.on('error', () => finish(null));
    child.on('close', (code) => finish(code));
  });
}

function parseRows(output: Buffer): ContainerRow[] {
  const rows: ContainerRow[] = [];
  for (const line of output.toString('utf8').split(/\r?\n/).filter(Boolean)) {
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { throw new Error('ROLLOUT_INVENTORY_INVALID'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('ROLLOUT_INVENTORY_INVALID');
    const row = value as Record<string, unknown>;
    const id = row.ID ?? row.Id ?? row.id;
    const name = row.Names ?? row.Name ?? row.name ?? '';
    const state = row.State ?? row.state ?? '';
    if (typeof id !== 'string' || !/^[a-f0-9]{12,64}$/i.test(id) || typeof name !== 'string' || typeof state !== 'string') throw new Error('ROLLOUT_INVENTORY_INVALID');
    rows.push({ id: id.toLowerCase(), name, state: state.toLowerCase() });
    if (rows.length > 16) throw new Error('ROLLOUT_INVENTORY_LIMIT');
  }
  return rows;
}

function parseInspect(output: Buffer, expectedIds: readonly string[]): InspectRow[] {
  const lines = output.toString('utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length !== expectedIds.length) throw new Error('ROLLOUT_INVENTORY_INVALID');
  return lines.map((line) => {
    const [id, image, state, health, startedAt, serviceId] = line.split('\t');
    if (!id || !/^[a-f0-9]{12,64}$/i.test(id) || !image || image.length > 256 || !state || !health || !startedAt || !serviceId
      || !expectedIds.some((expected) => id.toLowerCase().startsWith(expected) || expected.startsWith(id.toLowerCase()))) throw new Error('ROLLOUT_INVENTORY_INVALID');
    return { id: id.toLowerCase(), image, state: state.toLowerCase(), health: health.toLowerCase(), startedAt, serviceId };
  });
}

export interface BackupReplicaRuntimePin {
  service: RolloutService;
  slot: Slot;
  serviceId: string;
  runtimeIdentity: string;
  replicaId: string;
  revision: string;
  imageDigest: string;
  controlBaseUrl?: string;
  workerBusinessId?: string;
}

/** Exact two-slot process pins from the digest-checked deployment manifest.
 * The pin is paired with live service-owned observations; no caller-supplied
 * runtime identity or image revision can enter a backup fence. */
export async function readBackupReplicaRuntimePins(input: {
  manifestPath:string;
  expectedManifestSha256:string;
  expectedHostId:string;
}):Promise<BackupReplicaRuntimePin[]> {
  if (!SHA256.test(input.expectedManifestSha256) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(input.expectedHostId)) throw new Error('ROLLOUT_MANIFEST_DIGEST_INVALID');
  const bytes = await readTrustedFile(input.manifestPath,input.expectedManifestSha256);
  let raw:unknown;
  try { raw = JSON.parse(bytes.toString('utf8')) as unknown; } catch { throw new Error('ROLLOUT_MANIFEST_INVALID'); }
  const parsed = ManifestSchema.safeParse(raw);
  if (!parsed.success || parsed.data.hostId !== input.expectedHostId) throw new Error('ROLLOUT_MANIFEST_INVALID');
  return parsed.data.targets.flatMap((target) => (['blue','green'] as const).map((slot) => {
    const config = target.slots[slot];
    return {
      service:target.service,slot,serviceId:config.serviceId,runtimeIdentity:config.runtimeIdentity,
      replicaId:config.runtimeIdentity,revision:config.revision,imageDigest:config.imageDigest,
      ...(config.controlBaseUrl ? {controlBaseUrl:config.controlBaseUrl} : {}),
      ...(config.workerBusinessId ? {workerBusinessId:config.workerBusinessId} : {}),
    };
  }));
}

/**
 * Concrete host-side executor for a root-owned fixed two-slot manifest.
 * It accepts only manifest-pinned compose files, image digests, projects,
 * reload process, and selector path. No HTTP field becomes a Docker option,
 * file path, executable, environment variable, or shell fragment.
 */
export function createTrustedManifestRolloutAdapter(options: TrustedManifestRolloutAdapterOptions): ReplicaRolloutAdapter {
  if (!SHA256.test(options.expectedManifestSha256)) throw new Error('ROLLOUT_MANIFEST_DIGEST_INVALID');
  const spawnImplementation = options.spawn ?? spawn;
  const now = options.now ?? (() => new Date());
  const sleep = options.sleep ?? ((milliseconds: number) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
  let loaded: Manifest | null = null;

  async function manifest(): Promise<Manifest> {
    if (loaded) return loaded;
    const bytes = await readTrustedFile(options.manifestPath, options.expectedManifestSha256);
    const parsed = ManifestSchema.safeParse(JSON.parse(bytes.toString('utf8')) as unknown);
    if (!parsed.success) throw new Error('ROLLOUT_MANIFEST_INVALID');
    const candidate = parsed.data;
    await validateExecutable(candidate.dockerBinary, candidate.dockerSha256);
    for (const target of candidate.targets) {
      await validateTrustedDirectory(candidate.workingDirectory);
      await validateTrustedDirectory(candidate.homeDirectory);
      await validateTrustedDirectory(candidate.dockerConfigDirectory);
      if (target.service !== 'worker') {
        await validateExecutable(target.reloadExecutable!, target.reloadExecutableSha256!);
        await validateTrustedDirectory(path.dirname(target.selectorFile!));
      }
      for (const release of target.releases) for (const slot of ['blue','green'] as const) {
        for (const pin of release.slots[slot].composeFiles) await readTrustedFile(pin.path, pin.sha256, 256 * 1024);
      }
    }
    loaded = candidate;
    return candidate;
  }

  async function validateTrustedDirectory(directory: string): Promise<void> {
    if (path.resolve(directory) !== directory || await realpath(directory) !== directory) throw new Error('ROLLOUT_MANIFEST_UNTRUSTED');
    const details = await lstat(directory);
    if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== 0 || !noGroupOrWorldWrite(details.mode)) throw new Error('ROLLOUT_MANIFEST_UNTRUSTED');
  }

  async function command(man: Manifest, args: readonly string[], timeoutMs: number): Promise<Buffer> {
    const result = await runBounded(man.dockerBinary, ['--context',man.dockerContext,...args],man.workingDirectory,safeEnv(man),timeoutMs,spawnImplementation);
    if (result.uncertain) throw new Error('ROLLOUT_OPERATION_OUTCOME_UNKNOWN');
    if (result.exitCode !== 0) throw new Error('ROLLOUT_COMMAND_FAILED');
    return result.stdout;
  }

  function composePrefix(man: Manifest, target: Target, slot: Slot, revision: string): string[] {
    const release = releaseFor(target, revision);
    const config = target.slots[slot];
    const args = ['compose','--project-name',config.projectName,'--project-directory',man.workingDirectory];
    for (const file of release.slots[slot].composeFiles) args.push('--file',file.path);
    return args;
  }

  async function listSlot(man: Manifest, target: Target, slot: Slot): Promise<InspectRow[]> {
    const project = target.slots[slot].projectName;
    const output = await command(man,['container','ls','--all','--filter',`label=com.docker.compose.project=${project}`,
      '--filter',`label=com.docker.compose.service=${target.slots[slot].serviceId}`,'--format','{{json .}}'],20_000);
    const rows = parseRows(output);
    const ids = rows.map((row) => row.id);
    if (!ids.length) return [];
    const format = '{{.Id}}\t{{.Config.Image}}\t{{.State.Status}}\t{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}\t{{.State.StartedAt}}\t{{index .Config.Labels "com.docker.compose.service"}}';
    const inspect = await command(man,['container','inspect','--format',format,...ids],20_000);
    const rowsInspected = parseInspect(inspect,ids);
    const expectedService = target.slots[slot].serviceId;
    if (rowsInspected.some((row) => row.serviceId !== expectedService)) throw new Error('ROLLOUT_UNEXPECTED_CONTAINER');
    return rowsInspected;
  }

  async function selector(target: Target): Promise<Slot> {
    if (!target.selectorFile) throw new Error('ROLLOUT_FIXED_INGRESS_UNAVAILABLE');
    const bytes = await readTrustedFile(target.selectorFile, undefined, 64);
    const value = bytes.toString('utf8').trim();
    return safeSlot(value);
  }

  function revisionForImage(target: Target, slot: Slot, image: string): string | null {
    const matches = target.releases.filter((release) => imageMatches(image,release.slots[slot].imageDigest));
    return matches.length === 1 ? matches[0]!.revision : null;
  }

  async function observation(man: Manifest, target: Target, slot: Slot, scope: MaintenanceScope): Promise<ReplicaObservation> {
    const rows = await listSlot(man,target,slot);
    const config = target.slots[slot];
    if (rows.length === 0) return { replicaId: config.runtimeIdentity, slot, desiredRevision: 'unknown', observedRevision: null, state: 'STOPPED', activeWork: null, acknowledgedAt: null, code: 'NO_PROCESS_EVIDENCE' };
    if (rows.length !== 1) return { replicaId: config.runtimeIdentity, slot, desiredRevision: 'unknown', observedRevision: null, state: 'UNKNOWN', activeWork: null, acknowledgedAt: null, code: 'REPLICA_COUNT_INVALID' };
    const row = rows[0]!;
    const revision = revisionForImage(target,slot,row.image);
    const release = revision ? releaseFor(target, revision) : null;
    const running = row.state === 'running';
    const healthy = row.health === 'healthy';
    if (!running || !healthy || !revision || !release) {
      return {
        replicaId: config.runtimeIdentity, slot, desiredRevision: revision ?? 'unknown', observedRevision: revision,
        state: row.state === 'exited' ? 'STOPPED' : running ? 'FAILED' : 'UNKNOWN', activeWork: null,
        acknowledgedAt: null, code: !revision ? 'REVISION_DIGEST_UNRECOGNIZED' : !healthy ? 'CONTAINER_HEALTH_NOT_PROVEN' : null,
      };
    }
    const signal = await options.runtimeSafety.observe({
      service: target.service, slot, runtimeIdentity: config.runtimeIdentity, replicaId: config.runtimeIdentity,
      revision, imageDigest: release.slots[slot].imageDigest, scope,
    });
    const nowMs = now().getTime();
    const exactSignal = signal !== null
      && signal.service === target.service && signal.slot === slot
      && signal.runtimeIdentity === config.runtimeIdentity && signal.replicaId === config.runtimeIdentity
      && signal.revision === revision && imageMatches(signal.imageDigest, release.slots[slot].imageDigest)
      && isFreshObservation(signal.observedAt, nowMs, 30_000)
      && isFreshObservation(signal.workObservedAt, nowMs, 30_000)
      && isFreshObservation(signal.controlAcknowledgedAt, nowMs, 30_000);
    const activeWork = signal ? sumAuthoritativeWork(target.service, signal.work) : null;
    const appReady = exactSignal && signal!.readiness === 'READY' && signal!.controlState === 'OPEN'
      && signal!.controlRevision >= 0;
    return {
      replicaId: config.runtimeIdentity, slot, desiredRevision: revision, observedRevision: revision,
      state: appReady ? 'READY' : exactSignal && signal!.controlState === 'DRAINING' ? 'DRAINING' : 'UNKNOWN',
      activeWork, acknowledgedAt: exactSignal ? signal!.controlAcknowledgedAt : null,
      controlRevision: exactSignal ? signal!.controlRevision : null,
      controlState: exactSignal ? signal!.controlState : null,
      code: appReady ? null : exactSignal ? `RUNTIME_${signal!.readiness}` : 'RUNTIME_EVIDENCE_STALE_OR_MISMATCHED',
    };
  }

  async function switchSelector(
    target: Target,
    scope: MaintenanceScope,
    expected: Slot,
    next: Slot,
    revision: string,
  ): Promise<void> {
    if (!target.selectorFile || !target.reloadExecutable || !target.reloadArgs) throw new Error('ROLLOUT_FIXED_INGRESS_UNAVAILABLE');
    const directory = path.dirname(target.selectorFile);
    await validateTrustedDirectory(directory);
    const lockPath = `${target.selectorFile}.maintenance-lock`;
    let lock;
    try { lock = await open(lockPath, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600); }
    catch { throw new Error('ROLLOUT_INGRESS_BUSY_OR_UNCERTAIN'); }
    try {
      await lock.writeFile(`${process.pid}\n${now().toISOString()}\n`);
      await lock.sync();
      const current = await selector(target);
      if (current !== expected) throw new Error('ROLLOUT_INGRESS_CAS_CONFLICT');
      const tempPath = path.join(directory,`.${path.basename(target.selectorFile)}.${randomUUID()}.tmp`);
      const temp = await open(tempPath,fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,0o600);
      try { await temp.writeFile(`${next}\n`); await temp.sync(); } finally { await temp.close(); }
      await rename(tempPath,target.selectorFile);
      const dir = await open(directory,fsConstants.O_RDONLY);
      try { await dir.sync(); } finally { await dir.close(); }
      const reload = await runBounded(target.reloadExecutable,target.reloadArgs, directory,
        { PATH:'/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin', LANG:'C.UTF-8', LC_ALL:'C.UTF-8', TZ:'UTC', NO_COLOR:'1' },
        20_000,spawnImplementation);
      if (reload.uncertain || reload.exitCode !== 0) throw new Error('ROLLOUT_OPERATION_OUTCOME_UNKNOWN');
      if (await selector(target) !== next) throw new Error('ROLLOUT_OPERATION_OUTCOME_UNKNOWN');
      const release = releaseFor(target, revision);
      const deadline = now().getTime() + 30_000;
      let serving = false;
      while (now().getTime() < deadline) {
        try {
          const probe = await options.runtimeSafety.probeFixedIngress({
            service: target.service, scope, expectedSlot: next,
            expectedRuntimeIdentity: target.slots[next].runtimeIdentity,
            expectedReplicaId: target.slots[next].runtimeIdentity,
            expectedRevision: revision,
            expectedImageDigest: release.slots[next].imageDigest,
          });
          const probeAt = now().getTime();
          if (probe.statusCode >= 200 && probe.statusCode < 300 && probe.servedService === target.service
            && probe.servedSlot === next
            && probe.servedRuntimeIdentity === target.slots[next].runtimeIdentity
            && probe.servedReplicaId === target.slots[next].runtimeIdentity
            && probe.servedRevision === revision && imageMatches(probe.servedImageDigest ?? '', release.slots[next].imageDigest)
            && isFreshObservation(probe.observedAt, probeAt, 5_000)) {
            serving = true;
            break;
          }
        } catch {
          // Keep polling the pinned fixed ingress until the bounded deadline.
        }
        await sleep(Math.min(500, Math.max(10, deadline - now().getTime())));
      }
      if (!serving) throw new Error('ROLLOUT_INGRESS_OUTCOME_UNKNOWN');
    } finally {
      try { await lock.close(); } catch { /* already closed */ }
      try { await unlink(lockPath); } catch { /* keep failure closed if host lost lock */ }
    }
  }

  return {
    trusted: true,
    runtimeSafety: options.runtimeSafety,
    async capabilities() { return manifestCapabilities(await manifest()); },
    async executorIdentityForSlot(input) {
      const man = await manifest();
      const target = targetFor(man,input.service,{kind:'platform'});
      const slot = safeSlot(input.slot);
      releaseFor(target,input.revision);
      return target.slots[slot].runtimeIdentity;
    },
    async observe(input) {
      const man = await manifest();
      const target = targetFor(man,input.service,input.scope);
      const ingressTarget = target.service === 'worker' ? null : await selector(target);
      const replicas = await Promise.all((['blue','green'] as const).map((slot) => observation(man,target,slot,input.scope)));
      return { replicas, ingressTarget, fixedIngress: target.service !== 'worker' };
    },
    async prepareSlot(input) {
      const man = await manifest();
      const target = targetFor(man,input.service,input.scope);
      const slot = safeSlot(input.slot);
      const release = releaseFor(target,input.revision);
      const config = target.slots[slot];
      const prefix = composePrefix(man,target,slot,input.revision);
      const result = await command(man,[...prefix,'up','-d','--no-build','--pull','never','--no-deps',config.serviceId],120_000);
      void result;
      const deadline = now().getTime()+60_000;
      while (now().getTime() < deadline) {
        const observed = await observation(man,target,slot,input.scope);
        if (observed.state === 'READY' && observed.observedRevision === release.revision) return observed;
        await sleep(Math.min(1_000,Math.max(10,deadline-now().getTime())));
      }
      return { replicaId:config.runtimeIdentity,slot,desiredRevision:input.revision,observedRevision:null,state:'FAILED',activeWork:null,acknowledgedAt:null,code:'ROLLOUT_READINESS_TIMEOUT' };
    },
    async drainReplica(input) {
      const man = await manifest();
      const target = targetFor(man,input.service,input.scope);
      const exactSlot = (['blue','green'] as const).find((candidate) => target.slots[candidate].runtimeIdentity === input.replicaId);
      if (!exactSlot) throw new Error('ROLLOUT_REPLICA_NOT_ALLOWLISTED');
      const config = target.slots[exactSlot];
      const rows = await listSlot(man,target,exactSlot);
      if (rows.length !== 1 || rows[0]!.state !== 'running') throw new Error('ROLLOUT_REPLICA_STATE_UNCERTAIN');
      const observedRevision = revisionForImage(target,exactSlot,rows[0]!.image);
      if (!observedRevision) throw new Error('ROLLOUT_REVISION_DIGEST_UNRECOGNIZED');
      const release = releaseFor(target,observedRevision);
      const signal = await options.runtimeSafety.observe({
        service:target.service,scope:input.scope,slot:exactSlot,runtimeIdentity:config.runtimeIdentity,
        replicaId:config.runtimeIdentity,revision:observedRevision,imageDigest:release.slots[exactSlot].imageDigest,
      });
      const signalFresh = (value: ReplicaRuntimeObservation | null): value is ReplicaRuntimeObservation => !!value
        && value.service === target.service && value.slot === exactSlot && value.runtimeIdentity === config.runtimeIdentity
        && value.replicaId === config.runtimeIdentity && value.revision === observedRevision
        && imageMatches(value.imageDigest,release.slots[exactSlot].imageDigest)
        && isFreshObservation(value.observedAt,now().getTime(),30_000)
        && isFreshObservation(value.workObservedAt,now().getTime(),30_000)
        && isFreshObservation(value.controlAcknowledgedAt,now().getTime(),30_000);
      if (!signalFresh(signal) || signal.controlState === 'PAUSED' || signal.readiness === 'OFFLINE' || signal.readiness === 'UNKNOWN') {
        throw new Error('ROLLOUT_REPLICA_CONTROL_UNPROVEN');
      }
      let requestedRevision = signal.controlRevision;
      if (signal.controlState === 'OPEN') {
        const request = await options.runtimeSafety.requestDrain({
          service:target.service,slot:exactSlot,runtimeIdentity:config.runtimeIdentity,replicaId:config.runtimeIdentity,
          expectedRevision:observedRevision,expectedImageDigest:release.slots[exactSlot].imageDigest,
          expectedControlRevision:signal.controlRevision,reason:'maintenance-rollout',
        });
        requestedRevision = request.controlRevision;
      } else if (signal.controlState !== 'DRAINING') {
        throw new Error('ROLLOUT_REPLICA_CONTROL_UNPROVEN');
      }

      const deadline = now().getTime() + Math.max(0,Math.min(input.deadlineMs,120_000));
      let drained: ReplicaRuntimeObservation | null = null;
      let activeWork: number | null = null;
      while (now().getTime() <= deadline) {
        const current = await options.runtimeSafety.observe({
          service:target.service,scope:input.scope,slot:exactSlot,runtimeIdentity:config.runtimeIdentity,
          replicaId:config.runtimeIdentity,revision:observedRevision,imageDigest:release.slots[exactSlot].imageDigest,
        });
        if (signalFresh(current) && current.controlState === 'DRAINING' && current.controlRevision >= requestedRevision) {
          activeWork = sumAuthoritativeWork(target.service,current.work);
          if (activeWork === 0) { drained = current; break; }
        } else {
          activeWork = current && signalFresh(current) ? sumAuthoritativeWork(target.service,current.work) : null;
        }
        if (now().getTime() >= deadline) break;
        await sleep(Math.min(500,Math.max(10,deadline-now().getTime())));
      }
      if (!drained) {
        return {
          replicaId:config.runtimeIdentity,slot:exactSlot,desiredRevision:observedRevision,observedRevision,
          state:'DRAINING',activeWork,acknowledgedAt:signalFresh(signal) ? signal.controlAcknowledgedAt : null,
          controlRevision:requestedRevision,controlState:'DRAINING',code:'ROLLOUT_DRAIN_TIMEOUT',
        };
      }

      // A container is stopped only after the service-specific durable control
      // ACK is fresh and every authoritative work counter is exactly zero.
      // Docker state after the command is not used to manufacture zero-work.
      const seconds = Math.max(1,Math.min(120,Math.ceil(Math.max(1,input.deadlineMs)/1000)));
      await command(man,['container','stop','--time',String(seconds),rows[0]!.id],Math.max(5_000,input.deadlineMs+5_000));
      const after = await listSlot(man,target,exactSlot);
      if (after.length > 1 || (after.length === 1 && !['exited','dead'].includes(after[0]!.state))) {
        throw new Error('ROLLOUT_STOP_OUTCOME_UNKNOWN');
      }
      return {
        replicaId:config.runtimeIdentity,slot:exactSlot,desiredRevision:observedRevision,observedRevision,
        state:'STOPPED',activeWork:0,acknowledgedAt:drained.controlAcknowledgedAt,
        controlRevision:drained.controlRevision,controlState:'DRAINING',code:null,
      };
    },
    async switchIngress(input) {
      const man = await manifest();
      const target = targetFor(man,input.service,input.scope);
      if (target.service === 'worker') throw new Error('ROLLOUT_FIXED_INGRESS_UNAVAILABLE');
      const previous = safeSlot(input.expectedTarget ?? '');
      const next = safeSlot(input.target);
      const prepared = await observation(man,target,next,input.scope);
      if (prepared.state !== 'READY' || !prepared.observedRevision) throw new Error('ROLLOUT_INGRESS_TARGET_NOT_READY');
      await switchSelector(target,input.scope,previous,next,prepared.observedRevision);
      return { switched:true, observedTarget:await selector(target) };
    },
    async restoreIngress(input) {
      const man = await manifest();
      const target = targetFor(man,input.service,input.scope);
      if (target.service === 'worker') throw new Error('ROLLOUT_FIXED_INGRESS_UNAVAILABLE');
      const previous = safeSlot(input.expectedTarget);
      if (input.target === null) throw new Error('ROLLOUT_INGRESS_TARGET_INVALID');
      const next = safeSlot(input.target);
      const release = releaseFor(target,input.targetRevision);
      const config = target.slots[next];
      const prefix = composePrefix(man,target,next,input.targetRevision);
      await command(man,[...prefix,'up','-d','--no-build','--pull','never','--no-deps',config.serviceId],120_000);
      const current = await options.runtimeSafety.observe({
        service:target.service,scope:input.scope,slot:next,runtimeIdentity:config.runtimeIdentity,
        replicaId:config.runtimeIdentity,revision:input.targetRevision,imageDigest:release.slots[next].imageDigest,
      });
      if (!current || current.imageDigest !== release.slots[next].imageDigest || current.revision !== input.targetRevision
        || !isFreshObservation(current.observedAt,now().getTime(),30_000)) throw new Error('ROLLOUT_ROLLBACK_TARGET_UNPROVEN');
      if (current.controlState === 'DRAINING' || current.controlState === 'PAUSED') {
        const resumed = await options.runtimeSafety.requestResume({
          service:target.service,slot:next,runtimeIdentity:config.runtimeIdentity,replicaId:config.runtimeIdentity,
          expectedRevision:input.targetRevision,expectedImageDigest:release.slots[next].imageDigest,
          expectedControlRevision:current.controlRevision,reason:'maintenance-rollback',
        });
        const deadline = now().getTime()+60_000;
        let ready = false;
        while (now().getTime() < deadline) {
          const check = await observation(man,target,next,input.scope);
          if (check.state === 'READY' && check.observedRevision === input.targetRevision
            && (check.controlRevision ?? -1) >= resumed.controlRevision && check.controlState === 'OPEN') { ready = true; break; }
          await sleep(Math.min(500,Math.max(10,deadline-now().getTime())));
        }
        if (!ready) throw new Error('ROLLOUT_ROLLBACK_RESUME_UNACKNOWLEDGED');
      } else if (current.controlState !== 'OPEN' || current.readiness !== 'READY') {
        throw new Error('ROLLOUT_ROLLBACK_TARGET_NOT_READY');
      }
      await switchSelector(target,input.scope,previous,next,input.targetRevision);
      return { switched:true, observedTarget:await selector(target) };
    },
    async replaceReplica(input) {
      if (input.service !== 'worker') throw new Error('ROLLOUT_REPLICA_REPLACEMENT_UNSUPPORTED');
      const man = await manifest();
      const target = targetFor(man,input.service,input.scope);
      const slot = (['blue','green'] as const).find((candidate) => target.slots[candidate].runtimeIdentity === input.replicaId);
      if (!slot) throw new Error('ROLLOUT_REPLICA_NOT_ALLOWLISTED');
      const previous = await observation(man,target,slot,input.scope);
      if (previous.state !== 'READY' || !previous.observedRevision) throw new Error('ROLLOUT_REPLICA_CONTROL_UNPROVEN');
      const drained = await this.drainReplica({ service:'worker',scope:input.scope,replicaId:input.replicaId,deadlineMs:120_000 });
      if (drained.state !== 'STOPPED' || drained.activeWork !== 0) return drained;
      const release = releaseFor(target,input.revision);
      const config = target.slots[slot];
      const prefix = composePrefix(man,target,slot,input.revision);
      await command(man,[...prefix,'up','-d','--no-build','--pull','never','--no-deps',config.serviceId],120_000);
      const deadline = now().getTime()+60_000;
      while (now().getTime()<deadline) {
        const current = await observation(man,target,slot,input.scope);
        if (current.observedRevision === input.revision && current.state === 'DRAINING' && current.controlRevision !== null && current.controlRevision !== undefined) {
          const request = await options.runtimeSafety.requestResume({
            service:'worker',slot,runtimeIdentity:config.runtimeIdentity,replicaId:config.runtimeIdentity,
            expectedRevision:input.revision,expectedImageDigest:release.slots[slot].imageDigest,
            expectedControlRevision:current.controlRevision,reason:'maintenance-rollback',
          });
          void request;
          break;
        }
        if (current.observedRevision === input.revision && current.state === 'READY') return current;
        await sleep(Math.min(500,Math.max(10,deadline-now().getTime())));
      }
      while (now().getTime()<deadline) {
        const current = await observation(man,target,slot,input.scope);
        if (current.observedRevision === input.revision && current.state === 'READY' && current.activeWork === 0) return current;
        await sleep(Math.min(500,Math.max(10,deadline-now().getTime())));
      }
      return { replicaId:config.runtimeIdentity,slot,desiredRevision:input.revision,observedRevision:null,state:'FAILED',activeWork:null,acknowledgedAt:null,code:'ROLLOUT_READINESS_TIMEOUT' };
    },
  };
}
