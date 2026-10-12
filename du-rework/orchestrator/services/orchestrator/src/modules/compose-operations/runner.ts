import { createHash, randomUUID } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { statSync, writeSync, fsyncSync } from 'node:fs';
import path from 'node:path';
import type {
  ComposeJob,
  ComposeObservedService,
  ComposeRunnerClaim,
  ComposeRunnerCompleteRequest,
  ComposeRunnerReconcileRequest,
  ComposeRunnerSnapshotAck,
  ComposeRunnerSnapshotRequest,
  ComposeRunnerStartAck,
  ComposeSafeErrorCode,
} from './contracts';
import {
  ComposeJobSchema,
  ComposeRunnerClaimResponseSchema,
  ComposeRunnerCompleteAckSchema,
  ComposeRunnerCompleteRequestSchema,
  ComposeRunnerReconcileAckSchema,
  ComposeRunnerReconcileRequestSchema,
  ComposeRunnerSnapshotAckSchema,
  ComposeRunnerSnapshotRequestSchema,
  ComposeRunnerStartAckSchema,
  ComposeRunnerStartRequestSchema,
} from './contracts';
import {
  loadComposeManifest,
  reloadAndCheckManifest,
  toCatalogReleases,
  toCatalogServices,
  type LoadedComposeManifest,
} from './manifest';
import {
  ComposeHostExecutor,
  ComposeHostExecutorError,
  validateJobAgainstManifest,
  type ComposeHostActionResult,
  type DockerObservation,
} from './host-executor';

const MAX_API_BODY_BYTES = 256 * 1024;
const MAX_JOURNAL_BYTES = 10 * 1024 * 1024;
const MAX_JOURNAL_RECORD_BYTES = 128 * 1024;
const JOURNAL_MODE = 0o600;
const LOCK_MODE = 0o700;
const DEFAULT_POLL_INTERVAL_MS = 5_000;
const DEFAULT_RECONCILE_STABILITY_MS = 3_000;

export interface ComposeRunnerConfig {
  readonly baseUrl: string;
  readonly hostId: string;
  readonly runnerToken: string;
  readonly manifestPath: string;
  readonly manifestDigest: string;
  readonly journalPath: string;
  readonly lockPath: string;
  readonly pollIntervalMs?: number;
}

export class ComposeRunnerConfigError extends Error {
  constructor(readonly code: 'runner_config_invalid' | 'runner_lock_held' | 'runner_journal_invalid' | 'runner_journal_full' | 'runner_journal_uncertain') {
    super(code);
    this.name = 'ComposeRunnerConfigError';
  }
}

export class ComposeRunnerApiError extends Error {
  constructor(readonly kind: 'network' | 'http' | 'redirect' | 'invalid_response', readonly status: number | null = null) {
    super(kind);
    this.name = 'ComposeRunnerApiError';
  }
}

export interface RunnerFetchResponse {
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: AsyncIterable<Uint8Array> | null;
  readonly redirected?: boolean;
}

export type RunnerFetch = (input: string | URL, init?: RequestInit) => Promise<Response>;

function normalizeDigest(value: string): string {
  return value.startsWith('sha256:') ? value.slice(7).toLowerCase() : value.toLowerCase();
}

function assertBaseUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ComposeRunnerConfigError('runner_config_invalid');
  }
  const loopback = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === '::1';
  if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && loopback))
    || url.username !== '' || url.password !== '' || url.search !== '' || url.hash !== ''
    || (url.pathname !== '/' && url.pathname !== '')) {
    throw new ComposeRunnerConfigError('runner_config_invalid');
  }
  return new URL(url.origin);
}

async function readResponseBody(response: Response): Promise<Buffer> {
  const contentLength = response.headers.get('content-length');
  if (contentLength && Number(contentLength) > MAX_API_BODY_BYTES) throw new ComposeRunnerApiError('invalid_response');
  if (!response.body) throw new ComposeRunnerApiError('invalid_response');
  const chunks: Buffer[] = [];
  let bytes = 0;
  try {
    for await (const chunkValue of response.body) {
      const chunk = Buffer.from(chunkValue);
      bytes += chunk.length;
      if (bytes > MAX_API_BODY_BYTES) throw new ComposeRunnerApiError('invalid_response');
      chunks.push(chunk);
    }
  } catch (error) {
    if (error instanceof ComposeRunnerApiError) throw error;
    throw new ComposeRunnerApiError('network');
  }
  return Buffer.concat(chunks, bytes);
}

class ComposeRunnerApi {
  private readonly baseUrl: URL;
  private readonly fetcher: RunnerFetch;

  constructor(private readonly config: ComposeRunnerConfig, fetcher?: RunnerFetch) {
    this.baseUrl = assertBaseUrl(config.baseUrl);
    this.fetcher = fetcher ?? globalThis.fetch.bind(globalThis);
  }

  private async post<T>(pathSuffix: string, body: unknown, schema: { safeParse(value: unknown): { success: boolean; data?: T } }): Promise<T> {
    const bodyText = JSON.stringify(body);
    if (Buffer.byteLength(bodyText, 'utf8') > MAX_API_BODY_BYTES) throw new ComposeRunnerApiError('invalid_response');
    const target = new URL(`/api/internal/compose/runner/${pathSuffix}`, this.baseUrl);
    let response: Response;
    try {
      response = await this.fetcher(target, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.config.runnerToken}`,
          'content-type': 'application/json',
          accept: 'application/json',
        },
        body: bodyText,
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ComposeRunnerApiError('network');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new ComposeRunnerApiError('redirect', response.status);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ComposeRunnerApiError('http', response.status);
    }
    const bytes = await readResponseBody(response);
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString('utf8')) as unknown;
    } catch {
      throw new ComposeRunnerApiError('invalid_response', response.status);
    }
    const result = schema.safeParse(parsed);
    if (!result.success || result.data === undefined) throw new ComposeRunnerApiError('invalid_response', response.status);
    return result.data;
  }

  async getJob(jobId: string): Promise<ComposeJob> {
    if (!/^[0-9a-f-]{36}$/i.test(jobId)) throw new ComposeRunnerConfigError('runner_config_invalid');
    const target = new URL(`/api/internal/compose/runner/jobs/${encodeURIComponent(jobId)}`, this.baseUrl);
    let response: Response;
    try {
      response = await this.fetcher(target, {
        method: 'GET',
        headers: {
          authorization: `Bearer ${this.config.runnerToken}`,
          accept: 'application/json',
        },
        redirect: 'manual',
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new ComposeRunnerApiError('network');
    }
    if (response.redirected || (response.status >= 300 && response.status < 400)) {
      await response.body?.cancel();
      throw new ComposeRunnerApiError('redirect', response.status);
    }
    if (!response.ok) {
      await response.body?.cancel();
      throw new ComposeRunnerApiError('http', response.status);
    }
    const bytes = await readResponseBody(response);
    let parsed: unknown;
    try { parsed = JSON.parse(bytes.toString('utf8')) as unknown; } catch {
      throw new ComposeRunnerApiError('invalid_response', response.status);
    }
    const checked = ComposeJobSchema.safeParse(parsed);
    if (!checked.success || checked.data.hostId !== this.config.hostId || checked.data.jobId !== jobId) {
      throw new ComposeRunnerApiError('invalid_response', response.status);
    }
    return checked.data;
  }

  publishSnapshot(request: ComposeRunnerSnapshotRequest): Promise<ComposeRunnerSnapshotAck> {
    const checked = ComposeRunnerSnapshotRequestSchema.safeParse(request);
    if (!checked.success) throw new ComposeRunnerApiError('invalid_response');
    return this.post('snapshot', checked.data, ComposeRunnerSnapshotAckSchema);
  }

  async claimNextJob(): Promise<ComposeRunnerClaim | null> {
    const response = await this.post('claim', {}, ComposeRunnerClaimResponseSchema);
    return response.claim;
  }

  startJob(request: unknown): Promise<ComposeRunnerStartAck> {
    const checked = ComposeRunnerStartRequestSchema.safeParse(request);
    if (!checked.success) throw new ComposeRunnerApiError('invalid_response');
    return this.post('start', checked.data, ComposeRunnerStartAckSchema);
  }

  completeJob(request: ComposeRunnerCompleteRequest): Promise<{ job: ComposeJob }> {
    const checked = ComposeRunnerCompleteRequestSchema.safeParse(request);
    if (!checked.success) throw new ComposeRunnerApiError('invalid_response');
    return this.post('complete', checked.data, ComposeRunnerCompleteAckSchema);
  }

  reconcileJob(request: ComposeRunnerReconcileRequest): Promise<{ job: ComposeJob }> {
    const checked = ComposeRunnerReconcileRequestSchema.safeParse(request);
    if (!checked.success) throw new ComposeRunnerApiError('invalid_response');
    return this.post('reconcile', checked.data, ComposeRunnerReconcileAckSchema);
  }
}

interface JournalRecord {
  readonly kind: string;
  readonly at: string;
  readonly jobId?: string;
  readonly [key: string]: unknown;
}

function currentUid(): number {
  return typeof process.getuid === 'function' ? process.getuid() : -1;
}

async function ensureSecureDirectory(directoryPath: string): Promise<void> {
  try {
    if (!path.isAbsolute(directoryPath) || path.resolve(directoryPath) !== directoryPath || await realpath(directoryPath) !== directoryPath) {
      throw new ComposeRunnerConfigError('runner_journal_invalid');
    }
    const details = await lstat(directoryPath);
    if (!details.isDirectory() || details.isSymbolicLink() || details.uid !== currentUid() || (details.mode & 0o022) !== 0) {
      throw new ComposeRunnerConfigError('runner_journal_invalid');
    }
  } catch (error) {
    if (error instanceof ComposeRunnerConfigError) throw error;
    throw new ComposeRunnerConfigError('runner_journal_invalid');
  }
}

function parseJournalRecords(raw: Buffer): JournalRecord[] {
  const text = raw.toString('utf8');
  if (text === '') return [];
  const lines = text.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  const records: JournalRecord[] = [];
  for (const line of lines) {
    if (line.length === 0 || Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_RECORD_BYTES) throw new ComposeRunnerConfigError('runner_journal_invalid');
    let value: unknown;
    try { value = JSON.parse(line) as unknown; } catch { throw new ComposeRunnerConfigError('runner_journal_invalid'); }
    if (value === null || typeof value !== 'object' || Array.isArray(value)
      || typeof (value as { kind?: unknown }).kind !== 'string' || typeof (value as { at?: unknown }).at !== 'string') {
      throw new ComposeRunnerConfigError('runner_journal_invalid');
    }
    records.push(value as JournalRecord);
  }
  return records;
}

export class FsyncedRunnerJournal {
  private fileHandle: Awaited<ReturnType<typeof open>> | null = null;
  private records: JournalRecord[] = [];

  constructor(readonly journalPath: string) {}

  async open(): Promise<void> {
    if (this.fileHandle) return;
    const parentPath = path.dirname(this.journalPath);
    await ensureSecureDirectory(parentPath);
    try {
      if (path.resolve(this.journalPath) !== this.journalPath || await realpath(this.journalPath).catch(() => this.journalPath) !== this.journalPath) {
        throw new ComposeRunnerConfigError('runner_journal_invalid');
      }
      const file = await open(this.journalPath, fsConstants.O_CREAT | fsConstants.O_APPEND | fsConstants.O_RDWR | fsConstants.O_NOFOLLOW, JOURNAL_MODE);
      const details = await file.stat();
      if (!details.isFile() || details.uid !== currentUid() || (details.mode & 0o777) !== JOURNAL_MODE || details.size > MAX_JOURNAL_BYTES) {
        await file.close();
        throw new ComposeRunnerConfigError('runner_journal_invalid');
      }
      const parent = await open(parentPath, fsConstants.O_RDONLY);
      try { await parent.sync(); } finally { await parent.close(); }
      this.records = parseJournalRecords(await file.readFile());
      this.fileHandle = file;
    } catch (error) {
      if (error instanceof ComposeRunnerConfigError) throw error;
      throw new ComposeRunnerConfigError('runner_journal_invalid');
    }
  }

  async append(record: JournalRecord): Promise<void> {
    const handle = this.fileHandle;
    if (!handle) throw new ComposeRunnerConfigError('runner_journal_invalid');
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_RECORD_BYTES) throw new ComposeRunnerConfigError('runner_journal_invalid');
    const details = await handle.stat();
    if (details.size + Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_BYTES) throw new ComposeRunnerConfigError('runner_journal_full');
    await handle.write(line, null, 'utf8');
    await handle.sync();
    this.records.push(record);
  }

  appendSync(record: JournalRecord): void {
    const handle = this.fileHandle;
    if (!handle) throw new ComposeRunnerConfigError('runner_journal_invalid');
    const line = `${JSON.stringify(record)}\n`;
    if (Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_RECORD_BYTES) throw new ComposeRunnerConfigError('runner_journal_invalid');
    const details = statSync(this.journalPath);
    if (details.size + Buffer.byteLength(line, 'utf8') > MAX_JOURNAL_BYTES) throw new ComposeRunnerConfigError('runner_journal_full');
    const bytes = Buffer.from(line, 'utf8');
    let offset = 0;
    while (offset < bytes.length) offset += writeSync(handle.fd, bytes, offset, bytes.length - offset);
    fsyncSync(handle.fd);
    this.records.push(record);
  }

  all(): readonly JournalRecord[] {
    return this.records;
  }

  forJob(jobId: string): readonly JournalRecord[] {
    return this.records.filter((record) => record.jobId === jobId);
  }

  async close(): Promise<void> {
    const handle = this.fileHandle;
    this.fileHandle = null;
    if (handle) await handle.close();
  }
}

interface LockOwner {
  readonly pid: number;
  readonly bootId: string;
  readonly hostId: string;
  readonly projectId: string;
  readonly nonce: string;
  readonly startedAt: string;
}

async function bootId(): Promise<string> {
  try {
    return (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim().slice(0, 64);
  } catch {
    return `platform-${process.platform}-${process.arch}`;
  }
}

function pidAlive(pid: number): boolean {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function readLockOwner(lockPath: string): Promise<LockOwner | null> {
  try {
    const dir = await lstat(lockPath);
    if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== currentUid() || (dir.mode & 0o777) !== LOCK_MODE) {
      throw new ComposeRunnerConfigError('runner_lock_held');
    }
    const ownerPath = path.join(lockPath, 'owner.json');
    const file = await lstat(ownerPath);
    if (!file.isFile() || file.isSymbolicLink() || file.uid !== currentUid() || (file.mode & 0o777) !== JOURNAL_MODE || file.size > 4096) {
      throw new ComposeRunnerConfigError('runner_lock_held');
    }
    const owner = JSON.parse(await readFile(ownerPath, 'utf8')) as LockOwner;
    if (!Number.isSafeInteger(owner.pid) || typeof owner.hostId !== 'string' || typeof owner.projectId !== 'string' || typeof owner.bootId !== 'string') {
      throw new ComposeRunnerConfigError('runner_lock_held');
    }
    return owner;
  } catch (error) {
    if (error instanceof ComposeRunnerConfigError) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new ComposeRunnerConfigError('runner_lock_held');
  }
}

export class ComposeProjectLock {
  private owner: LockOwner | null = null;
  private recoveryBackupPath: string | null = null;

  constructor(readonly lockPath: string, private readonly hostId: string, private readonly projectId: string) {}

  private get gatePath(): string { return `${this.lockPath}.gate`; }

  private async enterGate(): Promise<void> {
    const parentPath = path.dirname(this.lockPath);
    await ensureSecureDirectory(parentPath);
    if (!path.isAbsolute(this.lockPath) || path.resolve(this.lockPath) !== this.lockPath) throw new ComposeRunnerConfigError('runner_config_invalid');
    try {
      await mkdir(this.gatePath, { mode: LOCK_MODE });
      const ownerFile = await open(path.join(this.gatePath, 'owner.json'), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, JOURNAL_MODE);
      const owner = { pid: process.pid, at: new Date().toISOString() };
      await ownerFile.writeFile(JSON.stringify(owner));
      await ownerFile.sync();
      await ownerFile.close();
    } catch {
      throw new ComposeRunnerConfigError('runner_lock_held');
    }
  }

  private async leaveGate(): Promise<void> {
    await rm(this.gatePath, { recursive: true, force: true });
  }

  private async writeNewOwner(): Promise<void> {
    await mkdir(this.lockPath, { mode: LOCK_MODE });
    const owner: LockOwner = {
      pid: process.pid,
      bootId: await bootId(),
      hostId: this.hostId,
      projectId: this.projectId,
      nonce: randomUUID(),
      startedAt: new Date().toISOString(),
    };
    const handle = await open(path.join(this.lockPath, 'owner.json'), fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW, JOURNAL_MODE);
    await handle.writeFile(JSON.stringify(owner));
    await handle.sync();
    await handle.close();
    const directory = await open(this.lockPath, fsConstants.O_RDONLY);
    try { await directory.sync(); } finally { await directory.close(); }
    this.owner = owner;
  }

  async acquire(): Promise<void> {
    await this.enterGate();
    try {
      const existing = await readLockOwner(this.lockPath);
      if (existing) throw new ComposeRunnerConfigError('runner_lock_held');
      await this.writeNewOwner();
    } catch (error) {
      if (error instanceof ComposeRunnerConfigError) throw error;
      throw new ComposeRunnerConfigError('runner_lock_held');
    } finally {
      await this.leaveGate();
    }
  }

  async recoverForLocalReconciliation(): Promise<void> {
    await this.enterGate();
    try {
      const existing = await readLockOwner(this.lockPath);
      if (existing) {
        if (existing.hostId !== this.hostId || existing.projectId !== this.projectId || pidAlive(existing.pid)) {
          throw new ComposeRunnerConfigError('runner_lock_held');
        }
        const suffix = randomUUID();
        this.recoveryBackupPath = `${this.lockPath}.stale-${suffix}`;
        await rename(this.lockPath, this.recoveryBackupPath);
      }
      await this.writeNewOwner();
    } catch (error) {
      if (this.recoveryBackupPath) {
        await rename(this.recoveryBackupPath, this.lockPath).catch(() => undefined);
        this.recoveryBackupPath = null;
      }
      if (error instanceof ComposeRunnerConfigError) throw error;
      throw new ComposeRunnerConfigError('runner_lock_held');
    } finally {
      await this.leaveGate();
    }
  }

  async finalizeRecovery(): Promise<void> {
    const backup = this.recoveryBackupPath;
    this.recoveryBackupPath = null;
    if (backup) await rm(backup, { recursive: true, force: true });
  }

  async restoreRecovery(): Promise<void> {
    const owner = this.owner;
    if (owner) await this.release();
    const backup = this.recoveryBackupPath;
    this.recoveryBackupPath = null;
    if (backup) await rename(backup, this.lockPath).catch(() => undefined);
  }

  async release(): Promise<void> {
    const owner = this.owner;
    this.owner = null;
    if (!owner) return;
    const current = await readLockOwner(this.lockPath).catch(() => null);
    if (current?.nonce === owner.nonce) await rm(this.lockPath, { recursive: true, force: true });
  }
}

function projectSnapshotRequest(manifest: LoadedComposeManifest, observation: DockerObservation): ComposeRunnerSnapshotRequest {
  return {
    hostId: manifest.manifest.hostId,
    manifestDigest: manifest.sha256,
    sampledAt: observation.sampledAt,
    projects: [{
      projectId: manifest.manifest.projectId,
      displayName: manifest.manifest.displayName,
      services: toCatalogServices(manifest.manifest),
      releases: toCatalogReleases(manifest.manifest),
      observedServices: observation.services,
    }],
  };
}

function timestamp(now: () => Date): string {
  return now().toISOString();
}

function latestKind(records: readonly JournalRecord[], kind: string): JournalRecord | undefined {
  return [...records].reverse().find((record) => record.kind === kind);
}

function completePendingRequest(records: readonly JournalRecord[], jobId: string): ComposeRunnerCompleteRequest | undefined {
  const jobRecords = records.filter((record) => record.jobId === jobId);
  const pendingIndex = jobRecords.map((record) => record.kind).lastIndexOf('COMPLETE_PENDING');
  if (pendingIndex < 0) return undefined;
  const ackIndex = jobRecords.map((record) => record.kind).lastIndexOf('COMPLETE_ACK');
  const supersededIndex = jobRecords.map((record) => record.kind).lastIndexOf('REPORT_SUPERSEDED');
  if (ackIndex > pendingIndex || supersededIndex > pendingIndex) return undefined;
  const request = jobRecords[pendingIndex]?.request;
  const parsed = ComposeRunnerCompleteRequestSchema.safeParse(request);
  return parsed.success ? parsed.data : undefined;
}

function retryableCompleteRequest(records: readonly JournalRecord[], jobId: string): ComposeRunnerCompleteRequest | undefined {
  const request = completePendingRequest(records, jobId);
  if (!request) return undefined;
  const jobRecords = records.filter((record) => record.jobId === jobId);
  const pendingIndex = jobRecords.map((record) => record.kind).lastIndexOf('COMPLETE_PENDING');
  const rejectedIndex = jobRecords.map((record) => record.kind).lastIndexOf('COMPLETE_REJECTED');
  return rejectedIndex > pendingIndex ? undefined : request;
}

function pendingReconcileRequest(records: readonly JournalRecord[], jobId: string): ComposeRunnerReconcileRequest | undefined {
  const jobRecords = records.filter((record) => record.jobId === jobId);
  const intentIndex = jobRecords.map((record) => record.kind).lastIndexOf('RECONCILE_INTENT');
  if (intentIndex < 0) return undefined;
  const ackIndex = jobRecords.map((record) => record.kind).lastIndexOf('RECONCILE_ACK');
  const rejectedIndex = jobRecords.map((record) => record.kind).lastIndexOf('RECONCILE_REJECTED');
  if (ackIndex > intentIndex || rejectedIndex > intentIndex) return undefined;
  const parsed = ComposeRunnerReconcileRequestSchema.safeParse(jobRecords[intentIndex]?.request);
  return parsed.success ? parsed.data : undefined;
}

function unresolvedJob(records: readonly JournalRecord[]): JournalRecord | undefined {
  const jobs = [...new Set(records.map((record) => record.jobId).filter((value): value is string => typeof value === 'string'))];
  for (const jobId of jobs) {
    const rows = records.filter((record) => record.jobId === jobId);
    const latest = rows[rows.length - 1];
    if (!latest) continue;
    if (latest.kind === 'RECONCILE_ACK' || latest.kind === 'REPORT_SUPERSEDED' || latest.kind === 'START_REJECTED_FINAL') continue;
    if (latest.kind === 'COMPLETE_ACK') {
      const job = latest.job as ComposeJob | undefined;
      if (!job || !['SUCCEEDED', 'FAILED', 'PARTIAL', 'UNKNOWN', 'RECONCILED'].includes(job.state)) return latest;
      if (job.state === 'UNKNOWN') return latest;
      continue;
    }
    if (latest.kind === 'COMPLETE_PENDING' || latest.kind === 'START_ACK_UNCERTAIN' || latest.kind === 'START_ACK'
      || latest.kind === 'START_INTENT' || latest.kind === 'CLAIM' || latest.kind === 'NEEDS_RECONCILIATION'
      || latest.kind === 'CLAIM_REJECTED' || latest.kind === 'CLAIM_PREFLIGHT_BLOCKED' || latest.kind === 'START_REJECTED'
      || latest.kind === 'ACTION_OUTCOME' || latest.kind === 'RECONCILE_INTENT' || latest.kind === 'RECONCILE_REJECTED'
      || latest.kind === 'COMPLETE_REJECTED' || latest.kind === 'PRE_SPAWN_REJECTED') return latest;
  }
  return undefined;
}

function composeSafeErrorForStartRejection(error: ComposeRunnerApiError): ComposeSafeErrorCode {
  if (error.status === 409) return 'STALE_SAMPLE';
  if (error.status === 412) return 'MANIFEST_DIGEST_MISMATCH';
  return 'RUNNER_REPORT_REJECTED';
}

function sameObservedState(left: readonly ComposeObservedService[], right: readonly ComposeObservedService[]): boolean {
  return stableObservationSignature(left) === stableObservationSignature(right);
}

export class ComposeOperationsHostRunner {
  private readonly api: ComposeRunnerApi;
  private readonly executor: ComposeHostExecutor;
  private readonly now: () => Date;
  private readonly sleep: (ms: number) => Promise<void>;
  private currentManifest: LoadedComposeManifest | null = null;

  constructor(
    private readonly config: ComposeRunnerConfig,
    options: { fetch?: RunnerFetch; executor?: ComposeHostExecutor; now?: () => Date; sleep?: (ms: number) => Promise<void> } = {},
    readonly journal = new FsyncedRunnerJournal(config.journalPath),
  ) {
    assertBaseUrl(config.baseUrl);
    if (!config.hostId || !/^[a-f0-9]{64}$/i.test(normalizeDigest(config.manifestDigest))
      || !/^[A-Za-z0-9_-]{32,512}$/.test(config.runnerToken)
      || !path.isAbsolute(config.manifestPath) || !path.isAbsolute(config.journalPath) || !path.isAbsolute(config.lockPath)) {
      throw new ComposeRunnerConfigError('runner_config_invalid');
    }
    this.api = new ComposeRunnerApi(config, options.fetch);
    this.executor = options.executor ?? new ComposeHostExecutor();
    this.now = options.now ?? (() => new Date());
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async initialize(): Promise<void> {
    await this.journal.open();
    this.currentManifest = await loadComposeManifest(this.config.manifestPath, this.config.manifestDigest);
    if (this.currentManifest.manifest.hostId !== this.config.hostId) throw new ComposeRunnerConfigError('runner_config_invalid');
  }

  get projectIdentity(): { readonly hostId: string; readonly projectId: string } {
    if (!this.currentManifest) throw new ComposeRunnerConfigError('runner_config_invalid');
    return { hostId: this.currentManifest.manifest.hostId, projectId: this.currentManifest.manifest.projectId };
  }

  private async getFreshObservation(): Promise<{ manifest: LoadedComposeManifest; observation: DockerObservation }> {
    const expected = this.currentManifest;
    if (!expected) throw new ComposeRunnerConfigError('runner_config_invalid');
    const manifest = await reloadAndCheckManifest(expected);
    if (manifest.manifest.hostId !== this.config.hostId) throw new ComposeRunnerConfigError('runner_config_invalid');
    const observation = await this.executor.observe(manifest.manifest);
    this.currentManifest = manifest;
    return { manifest, observation };
  }

  private async publishFreshObservation(): Promise<{ manifest: LoadedComposeManifest; observation: DockerObservation; ack: ComposeRunnerSnapshotAck }> {
    const { manifest, observation } = await this.getFreshObservation();
    const request = projectSnapshotRequest(manifest, observation);
    const ack = await this.api.publishSnapshot(request);
    if (ack.hostId !== manifest.manifest.hostId || ack.manifestDigest !== manifest.sha256 || ack.projects.length !== 1
      || ack.projects[0]?.projectId !== manifest.manifest.projectId) {
      throw new ComposeRunnerApiError('invalid_response');
    }
    return { manifest, observation, ack };
  }

  private async completeAndJournal(request: ComposeRunnerCompleteRequest): Promise<boolean> {
    await this.journal.append({ kind: 'COMPLETE_PENDING', at: timestamp(this.now), jobId: request.jobId, request });
    try {
      const result = await this.api.completeJob(request);
      if (result.job.jobId !== request.jobId) throw new ComposeRunnerApiError('invalid_response');
      await this.journal.append({ kind: 'COMPLETE_ACK', at: timestamp(this.now), jobId: request.jobId, job: result.job });
      return true;
    } catch (error) {
      if (error instanceof ComposeRunnerApiError && error.kind === 'http' && error.status !== null && error.status >= 400 && error.status < 500) {
        await this.journal.append({ kind: 'COMPLETE_REJECTED', at: timestamp(this.now), jobId: request.jobId, status: error.status });
      }
      return false;
    }
  }

  private async retryPendingReports(): Promise<void> {
    const jobIds = [...new Set(this.journal.all().map((record) => record.jobId).filter((id): id is string => typeof id === 'string'))];
    for (const jobId of jobIds) {
      const request = retryableCompleteRequest(this.journal.all(), jobId);
      if (!request) continue;
      try {
        const result = await this.api.completeJob(request);
        if (result.job.jobId !== jobId) throw new ComposeRunnerApiError('invalid_response');
        await this.journal.append({ kind: 'COMPLETE_ACK', at: timestamp(this.now), jobId, job: result.job });
      } catch (error) {
        if (error instanceof ComposeRunnerApiError && error.kind === 'http' && error.status !== null && error.status >= 400 && error.status < 500) {
          await this.journal.append({ kind: 'COMPLETE_REJECTED', at: timestamp(this.now), jobId, status: error.status });
        }
        return;
      }
    }
  }

  async recoverAfterRestart(): Promise<void> {
    await this.retryPendingReports();
    const unresolved = unresolvedJob(this.journal.all());
    if (!unresolved || unresolved.kind === 'COMPLETE_PENDING' || unresolved.kind === 'COMPLETE_ACK'
      || unresolved.kind === 'NEEDS_RECONCILIATION') return;
    const jobId = unresolved.jobId;
    if (!jobId) return;
    if (unresolved.kind === 'START_INTENT' || unresolved.kind === 'START_ACK' || unresolved.kind === 'START_ACK_UNCERTAIN') {
      const alreadyMarked = this.journal.forJob(jobId).some((record) => record.kind === 'START_ACK_UNCERTAIN');
      if (!alreadyMarked) await this.journal.append({ kind: 'START_ACK_UNCERTAIN', at: timestamp(this.now), jobId });
    }
    // Never replay a host command after a process restart. The server's claim expiry
    // records any uncertain start as UNKNOWN; explicit host-local reconciliation follows.
  }

  private async preSpawnFailure(claim: ComposeRunnerClaim, errorCode: ComposeSafeErrorCode, services: readonly ComposeObservedService[] | null, sampledAt: string): Promise<void> {
    const request: ComposeRunnerCompleteRequest = {
      jobId: claim.job.jobId,
      executionToken: claim.executionToken,
      expectedStateVersion: claim.job.stateVersion,
      manifestDigest: normalizeDigest(this.config.manifestDigest),
      sampledAt,
      outcome: 'FAILED',
      errorCode,
      uncertainReason: null,
      observedServices: services ? [...services] : null,
      perServiceOutcomes: claim.job.targetServices.map((serviceId) => ({ serviceId, status: 'FAILED', errorCode })),
    };
    await this.journal.append({ kind: 'PRE_SPAWN_REJECTED', at: timestamp(this.now), jobId: claim.job.jobId, errorCode });
    await this.completeAndJournal(request);
  }

  private async runClaim(claim: ComposeRunnerClaim): Promise<void> {
    const job = claim.job;
    if (job.state !== 'CLAIMED' || job.hostId !== this.config.hostId || !this.currentManifest
      || job.projectId !== this.currentManifest.manifest.projectId || job.claimExpiresAt === null
      || Date.parse(job.claimExpiresAt) <= this.now().getTime()) {
      await this.journal.append({ kind: 'CLAIM_REJECTED', at: timestamp(this.now), jobId: job.jobId, stateVersion: job.stateVersion });
      return;
    }
    await this.journal.append({ kind: 'CLAIM', at: timestamp(this.now), jobId: job.jobId, claim });
    let before: { manifest: LoadedComposeManifest; observation: DockerObservation; ack: ComposeRunnerSnapshotAck };
    try {
      const loaded = await reloadAndCheckManifest(this.currentManifest);
      validateJobAgainstManifest(job, loaded.manifest);
      before = await this.publishFreshObservation();
    } catch (error) {
      const code = error instanceof ComposeHostExecutorError ? error.code : 'MANIFEST_DIGEST_MISMATCH';
      await this.journal.append({ kind: 'CLAIM_PREFLIGHT_BLOCKED', at: timestamp(this.now), jobId: job.jobId, errorCode: code });
      return;
    }
    const projectAck = before.ack.projects[0];
    if (!projectAck || projectAck.observedDigest !== job.startExpectedObservedDigest) {
      await this.preSpawnFailure(claim, 'STALE_SAMPLE', before.observation.services, before.observation.sampledAt);
      return;
    }
    const beforeStartManifest = await reloadAndCheckManifest(before.manifest);
    const startRequest = {
      jobId: job.jobId,
      executionToken: claim.executionToken,
      expectedStateVersion: job.stateVersion,
      manifestDigest: beforeStartManifest.sha256,
      observedDigest: job.startExpectedObservedDigest,
    };
    await this.journal.append({ kind: 'START_INTENT', at: timestamp(this.now), jobId: job.jobId, request: startRequest });
    let startAck: ComposeRunnerStartAck;
    try {
      startAck = await this.api.startJob(startRequest);
      if (startAck.jobId !== job.jobId || startAck.stateVersion <= job.stateVersion) throw new ComposeRunnerApiError('invalid_response');
    } catch (error) {
      if (error instanceof ComposeRunnerApiError && error.kind === 'http' && error.status !== null && error.status >= 400 && error.status < 500) {
        await this.journal.append({
          kind: error.status === 409 ? 'START_REJECTED_FINAL' : 'START_REJECTED',
          at: timestamp(this.now),
          jobId: job.jobId,
          errorCode: composeSafeErrorForStartRejection(error),
        });
      } else {
        await this.journal.append({ kind: 'START_ACK_UNCERTAIN', at: timestamp(this.now), jobId: job.jobId });
      }
      return;
    }
    await this.journal.append({ kind: 'START_ACK', at: timestamp(this.now), jobId: job.jobId, ack: startAck });
    let actionResult: ComposeHostActionResult | null = null;
    try {
      const immediatelyVerified = await reloadAndCheckManifest(beforeStartManifest);
      if (immediatelyVerified.sha256 !== startRequest.manifestDigest) throw new ComposeRunnerConfigError('runner_config_invalid');
      actionResult = await this.executor.execute(job, immediatelyVerified.manifest, before.observation.services, {
        onSpawn: (pid) => this.journal.appendSync({ kind: 'EXECUTOR_PID', at: timestamp(this.now), jobId: job.jobId, pid }),
        onExit: (pid, exitCode) => this.journal.appendSync({ kind: 'EXECUTOR_EXIT', at: timestamp(this.now), jobId: job.jobId, pid, exitCode }),
      });
    } catch (error) {
      const errorCode: ComposeSafeErrorCode = error instanceof ComposeHostExecutorError ? error.code : 'MANIFEST_DIGEST_MISMATCH';
      actionResult = {
        outcome: 'UNKNOWN',
        errorCode: error instanceof ComposeHostExecutorError ? errorCode : 'EXECUTION_UNCERTAIN',
        uncertainReason: 'EXECUTION_UNCERTAIN',
        sampledAt: timestamp(this.now),
        observedServices: null,
        perServiceOutcomes: job.targetServices.map((serviceId) => ({ serviceId, status: 'UNKNOWN', errorCode: error instanceof ComposeHostExecutorError ? errorCode : 'EXECUTION_UNCERTAIN' })),
      };
    }
    await this.journal.append({ kind: 'ACTION_OUTCOME', at: timestamp(this.now), jobId: job.jobId, outcome: actionResult });
    if (actionResult.observedServices) {
      try {
        const currentManifest = await reloadAndCheckManifest(beforeStartManifest);
        await this.api.publishSnapshot(projectSnapshotRequest(currentManifest, {
          sampledAt: actionResult.sampledAt,
          services: actionResult.observedServices,
        }));
      } catch {
        // The completion request remains authoritative and is retried without replaying the host action.
      }
    }
    await this.completeAndJournal({
      jobId: job.jobId,
      executionToken: claim.executionToken,
      expectedStateVersion: startAck.stateVersion,
      manifestDigest: beforeStartManifest.sha256,
      sampledAt: actionResult.sampledAt,
      outcome: actionResult.outcome,
      errorCode: actionResult.errorCode,
      uncertainReason: actionResult.uncertainReason,
      observedServices: actionResult.observedServices,
      perServiceOutcomes: actionResult.perServiceOutcomes,
    });
  }

  async runCycle(): Promise<'idle' | 'job' | 'blocked'> {
    await this.retryPendingReports();
    const unresolved = unresolvedJob(this.journal.all());
    await this.publishFreshObservation();
    if (unresolved) return 'blocked';
    const claim = await this.api.claimNextJob();
    if (!claim) return 'idle';
    await this.runClaim(claim);
    return 'job';
  }

  async runForever(options: { shouldStop?: () => boolean; onError?: (code: string) => void } = {}): Promise<void> {
    await this.initialize();
    await this.recoverAfterRestart();
    const pollMs = Math.max(1_000, Math.min(this.config.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS, 60_000));
    while (!(options.shouldStop?.() ?? false)) {
      try {
        await this.runCycle();
      } catch (error) {
        options.onError?.(error instanceof ComposeRunnerConfigError ? error.code : error instanceof ComposeHostExecutorError ? error.code : 'runner_cycle_failed');
      }
      if (!(options.shouldStop?.() ?? false)) await this.sleep(pollMs);
    }
  }

  async reconcileLocally(input: { jobId: string; stateVersion: number; confirmQuiescent: boolean; stabilityMs?: number }): Promise<ComposeJob> {
    if (!input.confirmQuiescent || !/^[0-9a-f-]{36}$/i.test(input.jobId) || !Number.isSafeInteger(input.stateVersion) || input.stateVersion < 1) {
      throw new ComposeRunnerConfigError('runner_config_invalid');
    }
    const records = this.journal.forJob(input.jobId);
    if (records.length === 0) throw new ComposeRunnerConfigError('runner_journal_uncertain');
    const claimRecord = latestKind(records, 'CLAIM');
    const claim = claimRecord?.claim as ComposeRunnerClaim | undefined;
    if (!claim || claim.job.jobId !== input.jobId) throw new ComposeRunnerConfigError('runner_journal_uncertain');

    const serverJob = await this.api.getJob(input.jobId);
    if (serverJob.hostId !== this.config.hostId || serverJob.projectId !== claim.job.projectId) {
      throw new ComposeRunnerConfigError('runner_journal_uncertain');
    }
    const existingAck = latestKind(records, 'RECONCILE_ACK');
    if (serverJob.state === 'RECONCILED' && existingAck?.job && typeof existingAck.job === 'object') {
      const ackJob = existingAck.job as ComposeJob;
      if (ackJob.jobId === input.jobId && ackJob.state === 'RECONCILED') {
        if (completePendingRequest(this.journal.all(), input.jobId)) {
          await this.journal.append({ kind: 'REPORT_SUPERSEDED', at: timestamp(this.now), jobId: input.jobId, byStateVersion: ackJob.stateVersion });
        }
        return ackJob;
      }
    }

    const pendingReconcile = pendingReconcileRequest(this.journal.all(), input.jobId);
    if (pendingReconcile) {
      if (serverJob.state !== 'UNKNOWN' && serverJob.state !== 'RECONCILED') throw new ComposeRunnerConfigError('runner_journal_uncertain');
      try {
        const result = await this.api.reconcileJob(pendingReconcile);
        if (result.job.jobId !== input.jobId || result.job.state !== 'RECONCILED') throw new ComposeRunnerApiError('invalid_response');
        await this.journal.append({ kind: 'RECONCILE_ACK', at: timestamp(this.now), jobId: input.jobId, job: result.job });
        if (completePendingRequest(this.journal.all(), input.jobId)) {
          await this.journal.append({ kind: 'REPORT_SUPERSEDED', at: timestamp(this.now), jobId: input.jobId, byStateVersion: result.job.stateVersion });
        }
        return result.job;
      } catch (error) {
        if (error instanceof ComposeRunnerApiError && error.kind === 'http' && error.status !== null && error.status >= 400 && error.status < 500) {
          await this.journal.append({ kind: 'RECONCILE_REJECTED', at: timestamp(this.now), jobId: input.jobId, status: error.status });
        }
        throw error;
      }
    }

    const pendingCompletion = completePendingRequest(this.journal.all(), input.jobId);
    if (serverJob.state === 'SUCCEEDED' || serverJob.state === 'FAILED' || serverJob.state === 'PARTIAL') {
      if (!pendingCompletion) return serverJob;
      try {
        const result = await this.api.completeJob(pendingCompletion);
        if (result.job.jobId !== input.jobId) throw new ComposeRunnerApiError('invalid_response');
        await this.journal.append({ kind: 'COMPLETE_ACK', at: timestamp(this.now), jobId: input.jobId, job: result.job });
        return result.job;
      } catch (error) {
        if (error instanceof ComposeRunnerApiError && error.kind === 'http' && error.status !== null && error.status >= 400 && error.status < 500) {
          await this.journal.append({ kind: 'COMPLETE_REJECTED', at: timestamp(this.now), jobId: input.jobId, status: error.status });
        }
        throw error;
      }
    }
    if (serverJob.state === 'RECONCILED') {
      if (pendingCompletion) throw new ComposeRunnerConfigError('runner_journal_uncertain');
      return serverJob;
    }
    if (serverJob.state !== 'UNKNOWN' || serverJob.stateVersion !== input.stateVersion) {
      throw new ComposeRunnerConfigError('runner_journal_uncertain');
    }

    for (const record of records.filter((item) => item.kind === 'EXECUTOR_PID')) {
      const pid = record.pid;
      const endedAfter = records.some((item) => item.kind === 'EXECUTOR_EXIT' && item.pid === pid);
      if (!endedAfter && typeof pid === 'number' && pidAlive(pid)) throw new ComposeRunnerConfigError('runner_journal_uncertain');
    }
    const first = await this.publishFreshObservation();
    await this.sleep(Math.max(DEFAULT_RECONCILE_STABILITY_MS, input.stabilityMs ?? 0));
    const second = await this.publishFreshObservation();
    if (!sameObservedState(first.observation.services, second.observation.services)) throw new ComposeRunnerConfigError('runner_journal_uncertain');
    const request: ComposeRunnerReconcileRequest = {
      jobId: input.jobId,
      expectedStateVersion: input.stateVersion,
      manifestDigest: second.manifest.sha256,
      sampledAt: second.observation.sampledAt,
      executorQuiescent: true,
      evidenceCode: 'MANUAL_OPERATOR_CONFIRMED',
      observedServices: second.observation.services,
      perServiceOutcomes: claim.job.targetServices.map((serviceId) => ({ serviceId, status: 'UNKNOWN', errorCode: 'EXECUTION_UNCERTAIN' })),
    };
    await this.journal.append({ kind: 'RECONCILE_INTENT', at: timestamp(this.now), jobId: input.jobId, request });
    try {
      const result = await this.api.reconcileJob(request);
      if (result.job.jobId !== input.jobId || result.job.state !== 'RECONCILED') throw new ComposeRunnerApiError('invalid_response');
      await this.journal.append({ kind: 'RECONCILE_ACK', at: timestamp(this.now), jobId: input.jobId, job: result.job });
      if (pendingCompletion) {
        await this.journal.append({ kind: 'REPORT_SUPERSEDED', at: timestamp(this.now), jobId: input.jobId, byStateVersion: result.job.stateVersion });
      }
      return result.job;
    } catch (error) {
      if (error instanceof ComposeRunnerApiError && error.kind === 'http' && error.status !== null && error.status >= 400 && error.status < 500) {
        await this.journal.append({ kind: 'RECONCILE_REJECTED', at: timestamp(this.now), jobId: input.jobId, status: error.status });
      }
      throw error;
    }
  }

  async close(): Promise<void> {
    await this.journal.close();
  }
}

export async function loadRunnerConfigFromEnvironment(environment: NodeJS.ProcessEnv = process.env): Promise<ComposeRunnerConfig> {
  const config: ComposeRunnerConfig = {
    baseUrl: environment.COMPOSE_OPERATIONS_RUNNER_BASE_URL ?? '',
    hostId: environment.COMPOSE_OPERATIONS_HOST_ID ?? '',
    runnerToken: environment.COMPOSE_OPERATIONS_RUNNER_TOKEN ?? '',
    manifestPath: environment.COMPOSE_OPERATIONS_MANIFEST_PATH ?? '',
    manifestDigest: environment.COMPOSE_OPERATIONS_MANIFEST_DIGEST ?? '',
    journalPath: environment.COMPOSE_OPERATIONS_JOURNAL_PATH ?? '',
    lockPath: environment.COMPOSE_OPERATIONS_LOCK_PATH ?? '',
    pollIntervalMs: environment.COMPOSE_OPERATIONS_RUNNER_POLL_MS === undefined ? undefined : Number(environment.COMPOSE_OPERATIONS_RUNNER_POLL_MS),
  };
  try { assertBaseUrl(config.baseUrl); } catch { throw new ComposeRunnerConfigError('runner_config_invalid'); }
  if (!config.hostId || !/^[a-f0-9]{64}$/i.test(normalizeDigest(config.manifestDigest))
    || !/^[A-Za-z0-9_-]{32,512}$/.test(config.runnerToken)
    || ![config.manifestPath, config.journalPath, config.lockPath].every((value) => value !== '' && path.isAbsolute(value) && path.resolve(value) === value)
    || (config.pollIntervalMs !== undefined && (!Number.isInteger(config.pollIntervalMs) || config.pollIntervalMs < 1_000 || config.pollIntervalMs > 60_000))) {
    throw new ComposeRunnerConfigError('runner_config_invalid');
  }
  return config;
}

export function processIsAliveForReconciliation(pid: number): boolean {
  return pidAlive(pid);
}

export function stableObservationSignature(services: readonly ComposeObservedService[]): string {
  return createHash('sha256').update(JSON.stringify([...services]
    .sort((a, b) => a.serviceId.localeCompare(b.serviceId) || (a.containerId ?? '').localeCompare(b.containerId ?? '')))).digest('hex');
}

export function isSafeLocalRuntimePath(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value;
}
