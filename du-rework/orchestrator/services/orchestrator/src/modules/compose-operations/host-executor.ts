import { spawn, type ChildProcess } from 'node:child_process';
import type {
  ComposeObservedService,
  ComposePerServiceOutcome,
  ComposeSafeErrorCode,
  ComposeJob,
} from './contracts';
import {
  composeReleaseDigest,
  getComposeRelease,
  type ComposeManifest,
  type ComposeRelease,
} from './manifest';

const MAX_CAPTURED_OUTPUT_BYTES = 256 * 1024;
const MAX_CONTAINERS = 64;
const INVENTORY_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 120_000;
const RESTART_TIMEOUT_MS = 60_000;
const APPLY_READINESS_TIMEOUT_MS = 60_000;
const RESTART_READINESS_TIMEOUT_MS = 30_000;
const READINESS_POLL_MS = 1_500;
const PROCESS_TERMINATION_GRACE_MS = 500;
const CONTAINER_INSPECT_FORMAT = '{{.Id}}\t{{.Image}}\t{{.State.Status}}\t{{.State.StartedAt}}\t{{.State.FinishedAt}}\t{{with index .State "Health"}}{{.Status}}{{end}}';
const IMAGE_INSPECT_FORMAT = '{{.Id}}\t{{json .RepoDigests}}';

export interface DockerInvocation {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<NodeJS.ProcessEnv>;
}

export type ComposeHostCommand =
  | { readonly kind: 'inventory' }
  | { readonly kind: 'apply'; readonly releaseId: string }
  | { readonly kind: 'restart'; readonly serviceId: string };

export interface DockerObservation {
  readonly sampledAt: string;
  readonly services: ComposeObservedService[];
}

export interface ComposeHostActionResult {
  readonly outcome: 'SUCCEEDED' | 'FAILED' | 'PARTIAL' | 'UNKNOWN';
  readonly errorCode: ComposeSafeErrorCode | null;
  readonly uncertainReason: 'EXECUTOR_TIMEOUT' | 'EXECUTION_UNCERTAIN' | null;
  readonly sampledAt: string;
  readonly observedServices: ComposeObservedService[] | null;
  readonly perServiceOutcomes: ComposePerServiceOutcome[];
}

export class ComposeHostExecutorError extends Error {
  constructor(readonly code: ComposeSafeErrorCode) {
    super(code);
    this.name = 'ComposeHostExecutorError';
  }
}

interface ProcessResult {
  readonly stdout: Buffer;
  readonly exitCode: number | null;
  readonly errorKind: 'spawn' | 'timeout' | 'output_limit' | 'journal' | null;
}

interface ProcessRunnerOptions {
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
  readonly onSpawn?: (pid: number) => void;
  readonly onExit?: (pid: number, exitCode: number | null) => void;
}

export interface HostExecutorLifecycle {
  readonly onSpawn: (pid: number) => void;
  readonly onExit: (pid: number, exitCode: number | null) => void;
}

type SpawnImplementation = typeof spawn;

function safeHostEnvironment(manifest: ComposeManifest): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin',
    HOME: manifest.homeDirectory,
    DOCKER_CONFIG: manifest.dockerConfigDirectory,
    LANG: 'C.UTF-8',
    LC_ALL: 'C.UTF-8',
    TZ: 'UTC',
    NO_COLOR: '1',
    DOCKER_CLI_HINTS: 'false',
    COMPOSE_DISABLE_ENV_FILE: '1',
  };
}

function composePrefix(manifest: ComposeManifest, composeFiles: readonly { path: string }[]): string[] {
  const args = [
    '--context', manifest.dockerContext,
    'compose',
    '--project-name', manifest.projectId,
    '--project-directory', manifest.workingDirectory,
  ];
  for (const file of composeFiles) args.push('--file', file.path);
  if (manifest.envFile) args.push('--env-file', manifest.envFile.path);
  return args;
}

function releaseForCommand(manifest: ComposeManifest, command: ComposeHostCommand): ComposeRelease | undefined {
  return command.kind === 'apply' ? getComposeRelease(manifest, command.releaseId) : undefined;
}

/** Returns only manifest-derived arguments. No caller-provided string becomes an option or path. */
export function buildDockerInvocation(manifest: ComposeManifest, command: ComposeHostCommand): DockerInvocation {
  let args: string[];
  if (command.kind === 'inventory') {
    args = [...composePrefix(manifest, manifest.inventoryComposeFiles), 'ps', '--all', '--format', 'json'];
  } else if (command.kind === 'apply') {
    const release = releaseForCommand(manifest, command);
    if (!release) throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
    args = [
      ...composePrefix(manifest, release.composeFiles),
      'up', '-d', '--no-build', '--pull', 'never', '--no-deps', ...release.serviceIds,
    ];
  } else {
    if (!manifest.applicationServices.some((service) => service.serviceId === command.serviceId)) {
      throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
    }
    args = [...composePrefix(manifest, manifest.inventoryComposeFiles), 'restart', '--timeout', '20', command.serviceId];
  }
  return {
    executable: manifest.dockerBinary,
    args,
    cwd: manifest.workingDirectory,
    env: safeHostEnvironment(manifest),
  };
}

function buildInspectInvocation(manifest: ComposeManifest, containerIds: readonly string[]): DockerInvocation {
  if (containerIds.length === 0 || containerIds.length > MAX_CONTAINERS
    || containerIds.some((id) => !/^[a-f0-9]{12,64}$/i.test(id))) {
    throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
  }
  return {
    executable: manifest.dockerBinary,
    args: ['--context', manifest.dockerContext, 'container', 'inspect', '--format', CONTAINER_INSPECT_FORMAT, ...containerIds],
    cwd: manifest.workingDirectory,
    env: safeHostEnvironment(manifest),
  };
}

function buildImageInspectInvocation(manifest: ComposeManifest, imageIds: readonly string[]): DockerInvocation {
  if (imageIds.length === 0 || imageIds.length > MAX_CONTAINERS
    || imageIds.some((id) => !/^sha256:[a-f0-9]{64}$/i.test(id))) {
    throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
  }
  return {
    executable: manifest.dockerBinary,
    args: ['--context', manifest.dockerContext, 'image', 'inspect', '--format', IMAGE_INSPECT_FORMAT, ...imageIds],
    cwd: manifest.workingDirectory,
    env: safeHostEnvironment(manifest),
  };
}

function killChild(child: ChildProcess, signal: NodeJS.Signals): void {
  if (child.pid === undefined) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, signal);
    else child.kill(signal);
  } catch {
    try { child.kill(signal); } catch { /* process already exited */ }
  }
}

function runBoundedProcess(
  invocation: DockerInvocation,
  options: ProcessRunnerOptions,
  spawnImplementation: SpawnImplementation,
): Promise<ProcessResult> {
  return new Promise((resolve) => {
    let settled = false;
    let stopping = false;
    let errorKind: ProcessResult['errorKind'] = null;
    let totalBytes = 0;
    const stdout: Buffer[] = [];
    let capturedStdoutBytes = 0;
    let terminationTimer: NodeJS.Timeout | undefined;
    let timeoutTimer: NodeJS.Timeout | undefined;
    let child: ChildProcess;

    const finish = (exitCode: number | null): void => {
      if (settled) return;
      settled = true;
      if (timeoutTimer) clearTimeout(timeoutTimer);
      if (terminationTimer) clearTimeout(terminationTimer);
      resolve({ stdout: Buffer.concat(stdout, capturedStdoutBytes), exitCode, errorKind });
    };

    const terminate = (kind: Exclude<ProcessResult['errorKind'], null>): void => {
      if (stopping || settled) return;
      stopping = true;
      errorKind = kind;
      if (child && child.pid !== undefined) {
        killChild(child, 'SIGTERM');
        terminationTimer = setTimeout(() => killChild(child, 'SIGKILL'), PROCESS_TERMINATION_GRACE_MS);
        terminationTimer.unref?.();
      }
    };

    try {
      child = spawnImplementation(invocation.executable, [...invocation.args], {
        cwd: invocation.cwd,
        env: { ...invocation.env },
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch {
      errorKind = 'spawn';
      finish(null);
      return;
    }
    if (child.pid !== undefined && options.onSpawn) {
      try { options.onSpawn(child.pid); } catch {
        terminate('journal');
      }
    }
    const output = child.stdout;
    const errors = child.stderr;
    if (!output || !errors) {
      errorKind = 'journal';
      if (child.pid !== undefined) killChild(child, 'SIGTERM');
      finish(null);
      return;
    }
    timeoutTimer = setTimeout(() => terminate('timeout'), options.timeoutMs);
    timeoutTimer.unref?.();

    const countChunk = (chunkValue: Buffer | string, keep: boolean): void => {
      const chunk = Buffer.isBuffer(chunkValue) ? chunkValue : Buffer.from(chunkValue);
      totalBytes += chunk.length;
      if (keep && totalBytes <= options.maxOutputBytes) {
        capturedStdoutBytes += chunk.length;
        stdout.push(chunk);
      }
      if (totalBytes > options.maxOutputBytes) terminate('output_limit');
    };
    output.on('data', (chunk: Buffer | string) => countChunk(chunk, true));
    errors.on('data', (chunk: Buffer | string) => countChunk(chunk, false));
    child.on('error', () => {
      if (!stopping) errorKind = 'spawn';
    });
    child.on('close', (exitCode) => {
      if (child.pid !== undefined && options.onExit) {
        try { options.onExit(child.pid, exitCode); } catch {
          if (!errorKind) errorKind = 'journal';
        }
      }
      finish(exitCode);
    });
  });
}

function errorCodeFor(result: ProcessResult, operation: 'inventory' | 'action'): ComposeSafeErrorCode {
  if (result.errorKind === 'timeout') return 'COMMAND_TIMEOUT';
  if (result.errorKind === 'output_limit') return 'OUTPUT_LIMIT';
  if (result.errorKind === 'journal') return 'EXECUTION_UNCERTAIN';
  if (result.errorKind === 'spawn') return 'DOCKER_UNAVAILABLE';
  return operation === 'inventory' ? 'INVENTORY_UNAVAILABLE' : 'COMMAND_FAILED';
}

function safeJsonObject(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function parseComposePsOutput(output: Buffer): Array<{ containerId: string; serviceId: string; state: string }> {
  const text = output.toString('utf8').trim();
  if (text.length === 0) return [];
  let rows: unknown[];
  try {
    const parsed: unknown = JSON.parse(text);
    rows = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      rows = text.split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line) as unknown);
    } catch {
      throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    }
  }
  if (rows.length > MAX_CONTAINERS) throw new ComposeHostExecutorError('OUTPUT_LIMIT');
  return rows.flatMap((value) => {
    const row = safeJsonObject(value);
    if (!row) throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    const serviceId = typeof row.Service === 'string' ? row.Service : typeof row.service === 'string' ? row.service : '';
    const containerId = typeof row.ID === 'string' ? row.ID : typeof row.Id === 'string' ? row.Id : typeof row.id === 'string' ? row.id : '';
    const state = typeof row.State === 'string' ? row.State : typeof row.state === 'string' ? row.state : '';
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/.test(serviceId)) throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    if (containerId !== '' && !/^[a-f0-9]{12,64}$/i.test(containerId)) throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    return [{ containerId, serviceId, state }];
  });
}

function mapState(value: string): ComposeObservedService['state'] {
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case 'created': return 'CREATED';
    case 'running': return 'RUNNING';
    case 'paused': return 'PAUSED';
    case 'restarting': return 'RESTARTING';
    case 'exited': return 'EXITED';
    case 'dead': return 'DEAD';
    case 'removing': return 'REMOVING';
    default: return 'UNKNOWN';
  }
}

function mapHealth(value: string): NonNullable<ComposeObservedService['health']> {
  switch (value.trim().toLowerCase()) {
    case 'healthy': return 'HEALTHY';
    case 'unhealthy': return 'UNHEALTHY';
    case 'starting': return 'STARTING';
    case '':
    case 'none': return 'NONE';
    default: return 'UNKNOWN';
  }
}

function safeTimestamp(value: string): string | null {
  const trimmed = value.trim();
  if (trimmed === '' || trimmed.startsWith('0001-01-01T')) return null;
  const time = Date.parse(trimmed);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

function repoDigestOnly(value: string): string | null {
  const trimmed = value.trim();
  const match = trimmed.match(/^([a-z0-9][a-z0-9.-]*(?::[0-9]{1,5})?(?:\/[a-z0-9]+(?:[._-][a-z0-9]+)*)*)@(sha256:[a-f0-9]{64})$/i);
  return match ? `${match[1]?.toLowerCase()}@${match[2]?.toLowerCase()}` : null;
}

function parseInspectOutput(output: Buffer, expectedIds: readonly string[]): Array<{
  containerId: string;
  imageId: string | null;
  state: string;
  startedAt: string;
  finishedAt: string;
  health: string;
}> {
  const lines = output.toString('utf8').split(/\r?\n/);
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== expectedIds.length) throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
  if (lines.some((line) => line === '' || Buffer.byteLength(line, 'utf8') > MAX_CAPTURED_OUTPUT_BYTES)) {
    throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
  }
  return lines.map((line) => {
    const fields = line.split('\t');
    if (fields.length !== 6) throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    const containerId = fields[0] ?? '';
    const imageIdRaw = fields[1] ?? '';
    const state = fields[2] ?? '';
    const startedAt = fields[3] ?? '';
    const finishedAt = fields[4] ?? '';
    const health = fields[5] ?? '';
    if (!/^[a-f0-9]{12,64}$/i.test(containerId ?? '') || (imageIdRaw !== '' && !/^sha256:[a-f0-9]{64}$/i.test(imageIdRaw))) {
      throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    }
    return {
      containerId,
      imageId: imageIdRaw === '' ? null : imageIdRaw.toLowerCase(),
      state: state ?? '',
      startedAt: startedAt ?? '',
      finishedAt: finishedAt ?? '',
      health: health ?? '',
    };
  }).map((entry) => {
    if (!expectedIds.some((id) => entry.containerId.toLowerCase().startsWith(id.toLowerCase()) || id.toLowerCase().startsWith(entry.containerId.toLowerCase()))) {
      throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    }
    return entry;
  });
}

function parseImageInspectOutput(output: Buffer, expectedImageIds: readonly string[]): Map<string, string[]> {
  const lines = output.toString('utf8').trim().split(/\r?\n/).filter(Boolean);
  if (lines.length !== expectedImageIds.length) throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
  const expected = new Set(expectedImageIds.map((id) => id.toLowerCase()));
  const result = new Map<string, string[]>();
  for (const line of lines) {
    const separator = line.indexOf('\t');
    if (separator < 0) throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    const imageId = line.slice(0, separator).toLowerCase();
    if (!/^sha256:[a-f0-9]{64}$/.test(imageId) || !expected.has(imageId) || result.has(imageId)) {
      throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    }
    let repoDigests: unknown;
    try { repoDigests = JSON.parse(line.slice(separator + 1)) as unknown; } catch {
      throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    }
    if (repoDigests !== null && (!Array.isArray(repoDigests) || repoDigests.some((value) => typeof value !== 'string'))) {
      throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    }
    const digests = [...new Set((Array.isArray(repoDigests) ? repoDigests : [])
      .map((value) => repoDigestOnly(value as string))
      .filter((value): value is string => value !== null))].sort();
    result.set(imageId, digests);
  }
  if (result.size !== expected.size) throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
  return result;
}

function manifestImageHash(imageDigest: string): string | null {
  const match = imageDigest.match(/@sha256:([a-f0-9]{64})$/i);
  return match?.[1]?.toLowerCase() ?? null;
}

function imageDigestMatches(observed: string | null, expected: string): boolean {
  const observedHash = observed?.match(/(?:@|^)sha256:([a-f0-9]{64})$/i)?.[1]?.toLowerCase() ?? null;
  return observedHash !== null && observedHash === manifestImageHash(expected);
}

export function inferProjectRelease(manifest: ComposeManifest, services: readonly ComposeObservedService[]): string | null {
  const allApplicationServiceIds = manifest.applicationServices.map((service) => service.serviceId).sort();
  const candidates = manifest.releases.filter((release) => {
    if ([...release.serviceIds].sort().join('\0') !== allApplicationServiceIds.join('\0')) return false;
    return release.serviceIds.every((serviceId) => {
    const observations = services.filter((service) => service.serviceId === serviceId);
    return observations.length > 0 && observations.every((service) => imageDigestMatches(service.imageDigest, release.imageDigests[serviceId] ?? ''));
    });
  });
  return candidates.length === 1 ? candidates[0]?.releaseId ?? null : null;
}

function observationRows(
  manifest: ComposeManifest,
  psRows: ReturnType<typeof parseComposePsOutput>,
  inspectRows: ReturnType<typeof parseInspectOutput>,
  imageRepoDigests: ReadonlyMap<string, readonly string[]>,
): ComposeObservedService[] {
  const appIds = new Set(manifest.applicationServices.map((service) => service.serviceId));
  const rows: ComposeObservedService[] = [];
  for (const psRow of psRows) {
    if (!appIds.has(psRow.serviceId)) continue;
    const inspected = inspectRows.find((row) => row.containerId.toLowerCase().startsWith(psRow.containerId.toLowerCase())
      || psRow.containerId.toLowerCase().startsWith(row.containerId.toLowerCase()));
    if (!inspected) throw new ComposeHostExecutorError('INVENTORY_UNAVAILABLE');
    const repoDigests = inspected.imageId ? imageRepoDigests.get(inspected.imageId) ?? [] : [];
    const expectedRepoDigests = manifest.releases
      .map((release) => release.imageDigests[psRow.serviceId])
      .filter((digest): digest is string => digest !== undefined)
      .map((digest) => digest.toLowerCase());
    const imageDigest = repoDigests.find((digest) => expectedRepoDigests.includes(digest)) ?? repoDigests[0] ?? null;
    rows.push({
      serviceId: psRow.serviceId,
      containerId: inspected.containerId.toLowerCase(),
      imageId: inspected.imageId,
      imageDigest,
      state: mapState(inspected.state),
      health: mapHealth(inspected.health),
      startedAt: safeTimestamp(inspected.startedAt),
      finishedAt: safeTimestamp(inspected.finishedAt),
      observedReleaseId: null,
    });
  }
  const sorted = rows.sort((left, right) => left.serviceId.localeCompare(right.serviceId)
    || (left.containerId ?? '').localeCompare(right.containerId ?? ''));
  const observedReleaseId = inferProjectRelease(manifest, sorted);
  return observedReleaseId ? sorted.map((row) => ({ ...row, observedReleaseId })) : sorted;
}

function perServiceResult(targetServices: readonly string[], services: readonly ComposeObservedService[], expectedRelease: ComposeRelease | null, errorCode: ComposeSafeErrorCode | null): ComposePerServiceOutcome[] {
  const uniqueTargets = [...new Set(targetServices)].sort();
  return uniqueTargets.map((serviceId) => {
    if (errorCode === 'COMMAND_TIMEOUT' || errorCode === 'OUTPUT_LIMIT' || errorCode === 'EXECUTION_UNCERTAIN') {
      return { serviceId, status: 'UNKNOWN', errorCode };
    }
    const rows = services.filter((service) => service.serviceId === serviceId);
    const ready = rows.length > 0 && rows.every((service) => service.state === 'RUNNING'
      && (service.health === 'HEALTHY' || service.health === 'NONE')
      && (expectedRelease === null || imageDigestMatches(service.imageDigest, expectedRelease.imageDigests[serviceId] ?? '')));
    return { serviceId, status: ready ? 'SUCCEEDED' : 'FAILED', errorCode: ready ? null : errorCode ?? 'HEALTHCHECK_FAILED' };
  });
}

function isTargetReady(services: readonly ComposeObservedService[], targetServices: readonly string[], release: ComposeRelease | null): boolean {
  return targetServices.every((serviceId) => {
    const rows = services.filter((service) => service.serviceId === serviceId);
    return rows.length > 0 && rows.every((service) => service.state === 'RUNNING'
      && (service.health === 'HEALTHY' || service.health === 'NONE')
      && (release === null || imageDigestMatches(service.imageDigest, release.imageDigests[serviceId] ?? '')));
  });
}

export interface HostExecutorOptions {
  readonly spawn?: SpawnImplementation;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly readinessPollMs?: number;
  readonly applyReadinessTimeoutMs?: number;
  readonly restartReadinessTimeoutMs?: number;
}

export class ComposeHostExecutor {
  private readonly spawnImplementation: SpawnImplementation;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly readinessPollMs: number;
  private readonly applyReadinessTimeoutMs: number;
  private readonly restartReadinessTimeoutMs: number;

  constructor(options: HostExecutorOptions = {}) {
    this.spawnImplementation = options.spawn ?? spawn;
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.readinessPollMs = options.readinessPollMs ?? READINESS_POLL_MS;
    this.applyReadinessTimeoutMs = options.applyReadinessTimeoutMs ?? APPLY_READINESS_TIMEOUT_MS;
    this.restartReadinessTimeoutMs = options.restartReadinessTimeoutMs ?? RESTART_READINESS_TIMEOUT_MS;
  }

  async observe(manifest: ComposeManifest): Promise<DockerObservation> {
    const invocation = buildDockerInvocation(manifest, { kind: 'inventory' });
    const psResult = await runBoundedProcess(invocation, { timeoutMs: INVENTORY_TIMEOUT_MS, maxOutputBytes: MAX_CAPTURED_OUTPUT_BYTES }, this.spawnImplementation);
    if (psResult.errorKind || psResult.exitCode !== 0) throw new ComposeHostExecutorError(errorCodeFor(psResult, 'inventory'));
    const psRows = parseComposePsOutput(psResult.stdout);
    const allowedIds = new Set(manifest.applicationServices.map((service) => service.serviceId));
    const appRows = psRows.filter((row) => allowedIds.has(row.serviceId));
    const containerIds = appRows.map((row) => row.containerId).filter(Boolean);
    if (appRows.length > MAX_CONTAINERS) throw new ComposeHostExecutorError('OUTPUT_LIMIT');
    const inspectRows = containerIds.length > 0
      ? await this.inspect(manifest, containerIds)
      : [];
    const imageIds = [...new Set(inspectRows.flatMap((row) => row.imageId ? [row.imageId] : []))];
    const imageRepoDigests = imageIds.length > 0 ? await this.inspectImages(manifest, imageIds) : new Map<string, string[]>();
    const services = observationRows(manifest, appRows, inspectRows, imageRepoDigests);
    return { sampledAt: this.now().toISOString(), services };
  }

  private async inspect(manifest: ComposeManifest, containerIds: readonly string[]): Promise<ReturnType<typeof parseInspectOutput>> {
    const invocation = buildInspectInvocation(manifest, containerIds);
    const result = await runBoundedProcess(invocation, { timeoutMs: INVENTORY_TIMEOUT_MS, maxOutputBytes: MAX_CAPTURED_OUTPUT_BYTES }, this.spawnImplementation);
    if (result.errorKind || result.exitCode !== 0) throw new ComposeHostExecutorError(errorCodeFor(result, 'inventory'));
    return parseInspectOutput(result.stdout, containerIds);
  }

  private async inspectImages(manifest: ComposeManifest, imageIds: readonly string[]): Promise<Map<string, string[]>> {
    const invocation = buildImageInspectInvocation(manifest, imageIds);
    const result = await runBoundedProcess(invocation, { timeoutMs: INVENTORY_TIMEOUT_MS, maxOutputBytes: MAX_CAPTURED_OUTPUT_BYTES }, this.spawnImplementation);
    if (result.errorKind || result.exitCode !== 0) throw new ComposeHostExecutorError(errorCodeFor(result, 'inventory'));
    return parseImageInspectOutput(result.stdout, imageIds);
  }

  async execute(
    job: ComposeJob,
    manifest: ComposeManifest,
    observedBefore: readonly ComposeObservedService[],
    lifecycle?: HostExecutorLifecycle,
  ): Promise<ComposeHostActionResult> {
    validateJobAgainstManifest(job, manifest);
    let targetServices: string[];
    let release: ComposeRelease | null = null;
    let command: ComposeHostCommand;
    if (job.action === 'apply_release' || job.action === 'rollback_release') {
      if (!job.releaseId || !job.targetReleaseDigest) throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
      const chosen = getComposeRelease(manifest, job.releaseId);
      if (!chosen || composeReleaseDigest(chosen) !== job.targetReleaseDigest
        || [...job.targetServices].sort().join('\0') !== [...chosen.serviceIds].sort().join('\0')) {
        throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
      }
      if (job.action === 'rollback_release') {
        const sourceReleaseId = inferProjectRelease(manifest, observedBefore);
        if (!sourceReleaseId || !chosen.rollbackAllowedFrom.includes(sourceReleaseId)) {
          throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
        }
      }
      release = chosen;
      targetServices = [...chosen.serviceIds];
      command = { kind: 'apply', releaseId: chosen.releaseId };
    } else {
      if (!job.serviceId || job.releaseId !== null || job.targetReleaseDigest !== null || job.targetServices.length !== 1
        || job.targetServices[0] !== job.serviceId
        || !manifest.applicationServices.some((service) => service.serviceId === job.serviceId)) {
        throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
      }
      targetServices = [job.serviceId];
      command = { kind: 'restart', serviceId: job.serviceId };
    }

    const invocation = buildDockerInvocation(manifest, command);
    const timeoutMs = command.kind === 'restart' ? RESTART_TIMEOUT_MS : ACTION_TIMEOUT_MS;
    const commandResult = await runBoundedProcess(invocation, {
      timeoutMs,
      maxOutputBytes: MAX_CAPTURED_OUTPUT_BYTES,
      onSpawn: lifecycle?.onSpawn,
      onExit: lifecycle?.onExit,
    }, this.spawnImplementation);
    if (commandResult.errorKind === 'timeout' || commandResult.errorKind === 'output_limit' || commandResult.errorKind === 'journal') {
      const sampledAt = this.now().toISOString();
      const errorCode = errorCodeFor(commandResult, 'action');
      return {
        outcome: 'UNKNOWN',
        errorCode,
        uncertainReason: commandResult.errorKind === 'timeout' ? 'EXECUTOR_TIMEOUT' : 'EXECUTION_UNCERTAIN',
        sampledAt,
        observedServices: null,
        perServiceOutcomes: targetServices.map((serviceId) => ({ serviceId, status: 'UNKNOWN', errorCode })),
      };
    }
    if (commandResult.errorKind === 'spawn') {
      const sampledAt = this.now().toISOString();
      return {
        outcome: 'FAILED', errorCode: 'DOCKER_UNAVAILABLE', uncertainReason: null,
        sampledAt, observedServices: null,
        perServiceOutcomes: targetServices.map((serviceId) => ({ serviceId, status: 'FAILED', errorCode: 'DOCKER_UNAVAILABLE' })),
      };
    }

    let observation: DockerObservation;
    try {
      observation = await this.waitForReadiness(manifest, targetServices, release, commandResult.exitCode === 0);
    } catch (error) {
      const code = error instanceof ComposeHostExecutorError ? error.code : 'INVENTORY_UNAVAILABLE';
      const sampledAt = this.now().toISOString();
      return {
        outcome: 'UNKNOWN', errorCode: code, uncertainReason: 'EXECUTION_UNCERTAIN',
        sampledAt, observedServices: null,
        perServiceOutcomes: targetServices.map((serviceId) => ({ serviceId, status: 'UNKNOWN', errorCode: code })),
      };
    }

    const commandSucceeded = commandResult.exitCode === 0;
    const ready = isTargetReady(observation.services, targetServices, release);
    const errorCode = commandSucceeded ? (ready ? null : 'HEALTHCHECK_FAILED') : 'COMMAND_FAILED';
    const outcomes = perServiceResult(targetServices, observation.services, release, errorCode);
    const successCount = outcomes.filter((item) => item.status === 'SUCCEEDED').length;
    const outcome: ComposeHostActionResult['outcome'] = commandSucceeded && ready
      ? 'SUCCEEDED'
      : successCount > 0 ? 'PARTIAL' : 'FAILED';
    return {
      outcome,
      errorCode: outcome === 'SUCCEEDED' ? null : errorCode,
      uncertainReason: null,
      sampledAt: observation.sampledAt,
      observedServices: observation.services,
      perServiceOutcomes: outcomes,
    };
  }

  private async waitForReadiness(
    manifest: ComposeManifest,
    targetServices: readonly string[],
    release: ComposeRelease | null,
    commandSucceeded: boolean,
  ): Promise<DockerObservation> {
    const readinessTimeout = release ? this.applyReadinessTimeoutMs : this.restartReadinessTimeoutMs;
    const deadline = this.now().getTime() + readinessTimeout;
    let lastObservation: DockerObservation | null = null;
    while (true) {
      lastObservation = await this.observe(manifest);
      if (isTargetReady(lastObservation.services, targetServices, release)) return lastObservation;
      if (!commandSucceeded || this.now().getTime() >= deadline) return lastObservation;
      await this.sleep(Math.min(this.readinessPollMs, Math.max(0, deadline - this.now().getTime())));
    }
  }
}

export function validateJobAgainstManifest(job: ComposeJob, manifest: ComposeManifest): void {
  if (job.hostId !== manifest.hostId || job.projectId !== manifest.projectId) {
    throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
  }
  if (job.action === 'restart_service') {
    if (!job.serviceId || job.releaseId !== null || job.targetReleaseDigest !== null || job.targetServices.length !== 1
      || job.targetServices[0] !== job.serviceId || !manifest.applicationServices.some((service) => service.serviceId === job.serviceId)) {
      throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
    }
    return;
  }
  if (!job.releaseId || !job.targetReleaseDigest || job.serviceId !== null) throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
  const release = getComposeRelease(manifest, job.releaseId);
  if (!release || composeReleaseDigest(release) !== job.targetReleaseDigest
    || [...job.targetServices].sort().join('\0') !== [...release.serviceIds].sort().join('\0')) {
    throw new ComposeHostExecutorError('MANIFEST_DIGEST_MISMATCH');
  }
}

