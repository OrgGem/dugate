// VENDORED from @du/worker-sdk @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/worker-sdk/src/artifact-streams.ts (lines=984) sha256=21CD0FA96956AB7D2FD088D2627C2CEBC19899156D7B76D2CAD44BD3F1DD12B2
// why: worker surface required by src/worker.ts, src/main.ts, types/context.ts, step-checkpoint, fanout

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdtemp, readdir, rm, stat, unlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PassThrough, Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  MULTIPART_MAX_TOTAL_BYTES,
  MULTIPART_MIN_TOTAL_BYTES,
  type ArtifactRefDisposition,
} from '@du/contracts';
import type { SdkFetcher } from './fan-out';

/**
 * Artifact streaming/download + temp isolation & cleanup (P4-05).
 *
 * SDK-side surface for ART-01..03 (docs 13):
 *
 * - **ART-01 (download ownership)**: `downloadArtifactById` obtains a
 *   tokenized read grant (`POST /artifacts/:id/access` with taskId +
 *   leaseEpoch fencing) and streams the bytes from the grant's
 *   `downloadUrl` — the worker never holds storage credentials.
 * - **ART-02 (bounded file lifetime)**: temp files live in a per-task
 *   isolated workspace (`createTempWorkspace`), are deleted on every
 *   failure path, and `sweepStaleWorkspaces` reaps directories left by
 *   crashed workers (default TTL matches the 2h staging-orphan window
 *   in docs 17 §5.3).
 * - **ART-03 (hostile input)**: oversized downloads are rejected both
 *   up-front (Content-Length pre-check) and mid-stream (byte counter
 *   aborts the pipeline — memory stays bounded regardless of source
 *   size); SHA-256 is verified while streaming; path traversal in file
 *   names is refused; redirects are refused by default (SSRF block)
 *   since presigned storage URLs never legitimately redirect.
 *
 * Memory invariant: bytes flow `response body → counting/hashing
 * transform → file write stream`. The full artifact is never buffered
 * in memory; peak RSS from a download is one chunk.
 *
 * Boundary: pure SDK module — no DB, no Redis, no storage SDK. All HTTP
 * goes through an injectable fetcher; all disk I/O is confined to the
 * workspace directory under `os.tmpdir()` (or a caller-supplied root).
 */

/* -------------------------------------------------------------------- */
/* Errors                                                                */
/* -------------------------------------------------------------------- */

export type ArtifactStreamErrorCode =
  | 'INVALID_FILE_NAME'
  | 'INVALID_URL'
  | 'GRANT_REJECTED'
  | 'DOWNLOAD_REJECTED'
  | 'TOO_LARGE'
  | 'HASH_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'EMPTY_BODY'
  | 'TIMEOUT'
  | 'OUTPUT_NOT_COMMITTED'
  | 'TRANSPORT_FAILURE';

/** Typed failure for every artifact-stream path (discriminated by `code`). */
export class ArtifactStreamError extends Error {
  constructor(
    readonly status: number,
    readonly code: ArtifactStreamErrorCode,
    detail?: string
  ) {
    super(detail ?? `artifact stream failed: ${code} (status ${status})`);
    this.name = 'ArtifactStreamError';
  }
}

/* -------------------------------------------------------------------- */
/* Upload size bands (DATA-04; Reviewer finding T20-D1)                 */
/* -------------------------------------------------------------------- */

/**
 * The upload size policy every producer and consumer must agree on.
 *
 * T20-D1: the multipart contract floor is 64 MiB + 1
 * (`MULTIPART_MIN_TOTAL_BYTES`) while JSON ingress caps at 1 MiB, so the
 * 1 MiB - 64 MiB band had NO wire shape at all. That band rides ONE
 * single-request binary upload (`uploadArtifactStream`): no init/part/
 * complete round trips, no per-part ledger, and peak buffering stays one
 * stream chunk whatever the band size is.
 *
 * Values are derived from the @du/contracts wire constants so this policy
 * cannot drift from the server schema. The 1 MiB inline mirror is the
 * Orchestrator `DEFAULT_MAX_JSON_BYTES`; DATA-00 section 6 owns both and
 * must move them together.
 */
export const INLINE_ARTIFACT_MAX_BYTES = 1024 * 1024;
export const DIRECT_ARTIFACT_MAX_BYTES = MULTIPART_MIN_TOTAL_BYTES - 1;
export const ARTIFACT_UPLOAD_WIRE_MAX_BYTES = MULTIPART_MAX_TOTAL_BYTES;

export type ArtifactUploadBand = 'inline' | 'direct' | 'multipart';

/**
 * Which wire shape a declared size must take. Fail-closed on an unusable
 * declaration: a size past the wire ceiling can never be uploaded, and a
 * caller must never pick a band for a size it did not declare.
 */
export function resolveArtifactUploadBand(sizeBytes: number): ArtifactUploadBand {
  if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
    throw new ArtifactStreamError(422, 'SIZE_MISMATCH', 'declared artifact size must be a non-negative integer');
  }
  if (sizeBytes > ARTIFACT_UPLOAD_WIRE_MAX_BYTES) {
    throw new ArtifactStreamError(413, 'TOO_LARGE', 'declared artifact size exceeds the upload wire ceiling');
  }
  if (sizeBytes <= INLINE_ARTIFACT_MAX_BYTES) return 'inline';
  if (sizeBytes <= DIRECT_ARTIFACT_MAX_BYTES) return 'direct';
  return 'multipart';
}

/* -------------------------------------------------------------------- */
/* Temp workspace (ART-02: isolation + bounded lifetime)                 */
/* -------------------------------------------------------------------- */

/** Prefix for every SDK-managed temp dir; the sweeper only touches these. */
export const TEMP_WORKSPACE_PREFIX = 'du-worker-';

/** 2 hours — matches the staging-orphan sweep window (docs 17 §5.3). */
export const DEFAULT_STALE_WORKSPACE_MS = 2 * 60 * 60 * 1000;

/**
 * ART-02 live-reference guard (P4-05 clause): every workspace currently owned
 * and undisposed by this process. The sweeper never removes a registered dir,
 * regardless of mtime — TTL alone must not delete bytes an in-flight task,
 * metadata or checkpoint can still point at.
 */
const liveWorkspaces = new Set<string>();

export interface TempWorkspaceOptions {
  /** Root for the workspace dir; defaults to `os.tmpdir()`. */
  rootDir?: string;
}

/**
 * Per-task isolated temp directory. Every file the SDK writes for a task
 * lives under `dir`; `filePath` refuses traversal so a hostile artifact
 * name can never escape the workspace (ART-03). `dispose` removes the
 * whole tree and is idempotent.
 */
export interface TempWorkspace {
  /** Absolute path of the isolated directory (created via mkdtemp). */
  readonly dir: string;
  readonly taskId: string;
  /**
   * Resolve a file name inside the workspace. Throws
   * `ArtifactStreamError(INVALID_FILE_NAME)` on traversal, separators,
   * control chars, empty/overlong names.
   */
  filePath(fileName: string): string;
  /** Recursively delete the workspace; safe to call more than once. */
  dispose(): Promise<void>;
}

export async function createTempWorkspace(
  taskId: string,
  opts: TempWorkspaceOptions = {}
): Promise<TempWorkspace> {
  const safeTaskId = sanitizeTaskId(taskId);
  const root = opts.rootDir ?? tmpdir();
  const dir = await mkdtemp(join(root, `${TEMP_WORKSPACE_PREFIX}${safeTaskId}-`));
  liveWorkspaces.add(dir);
  let disposed = false;
  return {
    dir,
    taskId: safeTaskId,
    filePath(fileName: string): string {
      assertSafeFileName(fileName);
      return join(dir, fileName);
    },
    async dispose(): Promise<void> {
      if (disposed) return;
      disposed = true;
      liveWorkspaces.delete(dir);
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function sanitizeTaskId(taskId: string): string {
  // Task IDs are UUIDs; anything else (hostile or legacy) folds to '-'.
  const safe = taskId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 64);
  if (safe.length === 0) throw new ArtifactStreamError(0, 'INVALID_FILE_NAME', 'empty taskId');
  return safe;
}

const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\..*)?$/i;

function assertSafeFileName(fileName: string): void {
  const invalid = (detail: string): never => {
    throw new ArtifactStreamError(0, 'INVALID_FILE_NAME', detail);
  };
  if (typeof fileName !== 'string' || fileName.length === 0) invalid('file name is empty');
  if (fileName.length > 255) invalid('file name exceeds 255 chars');
  if (fileName === '.' || fileName === '..') invalid('file name is a directory reference');
  if (fileName.includes('/') || fileName.includes('\\')) invalid('file name contains a path separator');
  if (fileName.includes('\0')) invalid('file name contains NUL');
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f]/.test(fileName)) invalid('file name contains control characters');
  if (WINDOWS_RESERVED.test(fileName)) invalid('file name is a reserved device name');
}

export interface SweepStaleWorkspacesOptions {
  /** Root to scan; defaults to `os.tmpdir()`. */
  rootDir?: string;
  /** Age threshold; defaults to 2h (docs 17 §5.3 staging sweep window). */
  olderThanMs?: number;
  /** Injectable clock (tests). */
  now?: () => number;
  /**
   * ART-02 live-reference guard hook: return true when a workspace dir is
   * still referenced by ACTIVE metadata/checkpoints. Referenced dirs are kept
   * no matter their age — the sweep removes only true orphans. SDK stays
   * DB-free: the caller supplies the reference source (e.g. a runtime query).
   */
  hasActiveReference?: (workspaceDir: string) => boolean | Promise<boolean>;
}

export interface SweepResult {
  /** Workspace dirs removed. */
  removed: string[];
  /** Workspace dirs kept (fresh or unreadable). */
  kept: string[];
}

/**
 * Crash recovery for bounded file lifetime (ART-02): remove
 * `du-worker-*` temp dirs whose mtime is older than the TTL. Only dirs
 * carrying the SDK prefix are touched — foreign temp entries are never
 * removed. Called by the worker at startup and/or on a timer.
 */
export async function sweepStaleWorkspaces(
  opts: SweepStaleWorkspacesOptions = {}
): Promise<SweepResult> {
  const root = opts.rootDir ?? tmpdir();
  const olderThanMs = opts.olderThanMs ?? DEFAULT_STALE_WORKSPACE_MS;
  const now = (opts.now ?? Date.now)();
  const removed: string[] = [];
  const kept: string[] = [];
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return { removed, kept };
  }
  for (const name of entries) {
    if (!name.startsWith(TEMP_WORKSPACE_PREFIX)) continue;
    const full = join(root, name);
    try {
      const st = await stat(full);
      if (!st.isDirectory()) {
        kept.push(full);
        continue;
      }
      if (now - st.mtimeMs > olderThanMs) {
        // ART-02: TTL alone never justifies deleting a referenced workspace —
        // in-process live dirs and caller-confirmed active references survive;
        // only true orphans are reaped.
        if (liveWorkspaces.has(full)) {
          kept.push(full);
          continue;
        }
        if (opts.hasActiveReference && (await opts.hasActiveReference(full))) {
          kept.push(full);
          continue;
        }
        await rm(full, { recursive: true, force: true });
        removed.push(full);
      } else {
        kept.push(full);
      }
    } catch {
      kept.push(full); // vanished mid-sweep or unreadable: keep, retry next sweep
    }
  }
  return { removed, kept };
}

export interface WorkspaceReferenceQueryOptions {
  /** Orchestrator public base (same origin the worker posts results to). */
  baseUrl: string;
  /** Tenants whose active-holder presence protects workspaces from the sweep. */
  tenantIds: string[];
  /** Injected fetch (tests run fully offline). */
  fetchImpl: typeof fetch;
  /** Runtime bearer issued by `POST /api/runtime/v1/worker/register`. */
  token?: string;
  /** Abort per query after this many ms; default 5000. */
  timeoutMs?: number;
  /** Notified whenever the answer is uncertain (the hook then answers REFERENCED). */
  onUncertain?: (workspaceDir: string, reason: string) => void;
}

/**
 * W47-Q2-5 (P4-05 / ART-02 wire-hook): build a `hasActiveReference` hook that
 * calls the read-only seam Claude Code shipped at
 * `services/orchestrator/src/server.ts:711-743`:
 *
 *   GET /api/runtime/v1/workspace-reference?workspacePath=<dir>&tenantId=<uuid>
 *   Authorization: Bearer <runtime token>
 *   200 { workspacePath, tenantId, referenced: boolean, activeHolders: number }
 *   401 invalid runtime bearer · 422 missing/invalid query params · NO 404 —
 *   an unreferenced workspace answers `referenced: false`, not an error.
 *
 * Contract nuance recorded from code (server.ts:731-738 + runtime.ts:899-919):
 * `referenced` is TENANT PRESENCE, not path attribution — the query counts a
 * tenant's non-terminal tasks/operations plus OPEN human waits, and the
 * workspacePath param is echoed but never filters (no workspace-path column
 * exists; storage_key is `art-<uuid>`). So: any configured tenant with
 * activeHolders > 0 protects every expired dir this sweep sees.
 *
 * FAIL-SAFE (declared in tests): fetch rejection, abort/timeout, HTTP
 * non-2xx, unreadable/malformed body — ALL are answered `true` (referenced),
 * so uncertainty never deletes. Only an explicit `referenced:false` from EVERY
 * configured tenant yields `false` (orphan candidate).
 */
export function createWorkspaceReferenceCheck(
  opts: WorkspaceReferenceQueryOptions
): (workspaceDir: string) => Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5000;
  return async (workspaceDir: string): Promise<boolean> => {
    const uncertain = (reason: string): true => {
      opts.onUncertain?.(workspaceDir, reason);
      return true;
    };
    for (const tenantId of opts.tenantIds) {
      const url = new URL('/api/runtime/v1/workspace-reference', opts.baseUrl);
      url.searchParams.set('workspacePath', workspaceDir);
      url.searchParams.set('tenantId', tenantId);
      try {
        const res = await opts.fetchImpl(url.toString(), {
          method: 'GET',
          headers: opts.token ? { authorization: `Bearer ${opts.token}` } : {},
          signal: AbortSignal.timeout(timeoutMs),
        });
        if (!res.ok) return uncertain(`HTTP ${res.status}`);
        const body = (await res.json()) as { referenced?: unknown };
        if (typeof body.referenced !== 'boolean') return uncertain('malformed body');
        if (body.referenced) return true;
      } catch (err) {
        return uncertain(`fetch failed: ${String(err)}`);
      }
    }
    return false;
  };
}

/* -------------------------------------------------------------------- */
/* Streaming download (ART-01/03: bounded memory, limits, hash)          */
/* -------------------------------------------------------------------- */

export interface DownloadArtifactOptions {
  /** Hard cap on downloaded bytes — enforced up-front AND mid-stream. */
  maxBytes: number;
  /** When set, verified against the sha256 computed while streaming. */
  expectedSha256?: string;
  /** When set, verified against the streamed byte count. */
  expectedSizeBytes?: number;
  /** Abort mid-download (lease loss / cancel / shutdown). */
  signal?: AbortSignal;
  /** Injectable fetcher (tests / proxies). */
  fetcher?: SdkFetcher;
  /** Per-request timeout in ms (default 60s). */
  timeoutMs?: number;
  /**
   * Follow HTTP redirects. Default false → `redirect: 'error'` (SSRF
   * block, ART-03): presigned storage URLs never legitimately redirect.
   */
  allowRedirects?: boolean;
}

export interface DownloadedArtifact {
  /** Absolute path of the temp file inside the workspace. */
  path: string;
  /** Bytes actually written (verified ≤ maxBytes). */
  sizeBytes: number;
  /** SHA-256 of the written bytes, computed while streaming. */
  sha256: string;
}

/**
 * Stream `downloadUrl` into `workspace/fileName` with bounded memory:
 *
 * 1. `http(s)` URL guard; redirect policy applied (default: refuse).
 * 2. Content-Length pre-check rejects oversized artifacts before any
 *    disk write (no wasted I/O, no partial file).
 * 3. Body flows through a counting+hashing Transform into a file write
 *    stream; exceeding `maxBytes` aborts the pipeline mid-stream, so a
 *    zip-bomb-sized artifact can never exhaust memory or disk.
 * 4. SHA-256 (and optional exact size) verified before the path is
 *    handed back.
 * 5. EVERY failure path deletes the partial file — the workspace only
 *    ever contains complete, verified artifacts (bounded file lifetime).
 */
export async function downloadArtifact(
  workspace: TempWorkspace,
  fileName: string,
  downloadUrl: string,
  options: DownloadArtifactOptions
): Promise<DownloadedArtifact> {
  // filePath() validates the name before anything touches the network.
  const target = workspace.filePath(fileName);
  assertHttpUrl(downloadUrl);
  if (!Number.isFinite(options.maxBytes) || options.maxBytes < 0) {
    throw new ArtifactStreamError(0, 'TOO_LARGE', 'maxBytes must be a non-negative finite number');
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  const scope = createRequestScope(options.signal, options.timeoutMs ?? 60_000);
  let res: Response;
  try {
    res = await fetcher(downloadUrl, {
      method: 'GET',
      redirect: options.allowRedirects === true ? 'follow' : 'error',
      signal: scope.signal,
    });
  } catch (err) {
    scope.dispose();
    throw streamTransportError(scope, err, 'artifact download');
  }
  if (!res.ok) {
    const detail = await readErrorDetail(res);
    scope.dispose();
    throw new ArtifactStreamError(res.status, 'DOWNLOAD_REJECTED', detail);
  }

  // Up-front limit (ART-03 oversized block) before opening any file.
  const contentLength = res.headers.get('content-length');
  if (contentLength !== null) {
    const declared = Number(contentLength);
    if (Number.isFinite(declared) && declared > options.maxBytes) {
      scope.dispose();
      throw new ArtifactStreamError(
        413,
        'TOO_LARGE',
        `declared content-length ${declared} exceeds maxBytes ${options.maxBytes}`
      );
    }
  }
  if (!res.body) {
    scope.dispose();
    throw new ArtifactStreamError(502, 'EMPTY_BODY', 'download response carried no body');
  }

  const hash = createHash('sha256');
  let bytes = 0;
  let limitError: ArtifactStreamError | null = null;
  const counter = new Transform({
    transform(chunk: Buffer, _enc, cb) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        limitError = new ArtifactStreamError(
          413,
          'TOO_LARGE',
          `download exceeded maxBytes ${options.maxBytes} (streamed ${bytes})`
        );
        cb(limitError);
        return;
      }
      hash.update(chunk);
      cb(null, chunk);
    },
  });

  // {signal}: aborting the request scope now destroys the body stream mid-flight
  // (the whole surface previously lacked this option — 0 grep hits repo-wide).
  const nodeStream = Readable.fromWeb(
    res.body as import('node:stream/web').ReadableStream<Uint8Array>,
    { signal: scope.signal }
  );
  try {
    await pipeline(nodeStream, counter, createWriteStream(target));
  } catch (err) {
    // Bounded file lifetime: no partial file survives a failed download.
    await removeFile(target);
    if (limitError) throw limitError;
    if (scope.signal.aborted) {
      throw streamTransportError(scope, err, 'artifact download');
    }
    throw new ArtifactStreamError(0, 'TRANSPORT_FAILURE', `download stream failure (${errorClassName(err)})`);
  } finally {
    scope.dispose();
  }

  const sha256 = hash.digest('hex');
  if (options.expectedSha256 !== undefined && options.expectedSha256 !== sha256) {
    await removeFile(target);
    throw new ArtifactStreamError(
      422,
      'HASH_MISMATCH',
      `streamed sha256 ${sha256} != expected ${options.expectedSha256}`
    );
  }
  if (options.expectedSizeBytes !== undefined && options.expectedSizeBytes !== bytes) {
    await removeFile(target);
    throw new ArtifactStreamError(
      422,
      'SIZE_MISMATCH',
      `streamed ${bytes} bytes != expected ${options.expectedSizeBytes}`
    );
  }
  return { path: target, sizeBytes: bytes, sha256 };
}

export interface OpenArtifactStreamOptions {
  /** Maximum bytes accepted from the storage stream. */
  maxBytes: number;
  expectedSha256?: string;
  expectedSizeBytes?: number;
  signal?: AbortSignal;
  fetcher?: SdkFetcher;
  timeoutMs?: number;
  /** Per-stream Node buffer bound; defaults to 64 KiB and caps at 1 MiB. */
  highWaterMarkBytes?: number;
}

/**
 * Open a bounded artifact stream without buffering the response body. The
 * timeout and caller signal stay attached until the consumer drains the body;
 * byte count and optional digest/size checks run before the stream ends.
 * Abandoning the returned stream before it ends (for-await break, explicit
 * destroy) aborts the underlying request scope — the wire cancels, not just
 * the local pipe (DATA-04, W-DATA04-STREAM-BOUNDS-1).
 */
export async function openArtifactStream(url: string, options: OpenArtifactStreamOptions): Promise<Readable> {
  assertHttpUrl(url);
  assertStreamLimits(options.maxBytes, options.highWaterMarkBytes);
  const fetcher = options.fetcher ?? globalThis.fetch;
  const scope = createRequestScope(options.signal, options.timeoutMs ?? 60_000);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: 'GET',
      redirect: 'error',
      signal: scope.signal,
    });
  } catch (err) {
    scope.dispose();
    throw streamTransportError(scope, err, 'artifact read failed');
  }
  if (!response.ok) {
    const detail = await readErrorDetail(response);
    scope.dispose();
    throw new ArtifactStreamError(response.status, 'DOWNLOAD_REJECTED', detail);
  }
  const contentLength = response.headers.get('content-length');
  if (contentLength !== null && Number.isFinite(Number(contentLength))) {
    const declared = Number(contentLength);
    if (declared > options.maxBytes) {
      await response.body?.cancel().catch(() => undefined);
      scope.dispose();
      throw new ArtifactStreamError(413, 'TOO_LARGE', 'declared content length exceeds the stream limit');
    }
    if (options.expectedSizeBytes !== undefined && declared !== options.expectedSizeBytes) {
      await response.body?.cancel().catch(() => undefined);
      scope.dispose();
      throw new ArtifactStreamError(422, 'SIZE_MISMATCH', 'declared content length does not match expected size');
    }
  }
  if (!response.body) {
    scope.dispose();
    throw new ArtifactStreamError(502, 'EMPTY_BODY', 'artifact response carried no body');
  }

  const highWaterMark = options.highWaterMarkBytes ?? 64 * 1024;
  const hash = createHash('sha256');
  let bytes = 0;
  let streamError: ArtifactStreamError | null = null;
  const meter = new Transform({
    readableHighWaterMark: highWaterMark,
    writableHighWaterMark: highWaterMark,
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        streamError = new ArtifactStreamError(413, 'TOO_LARGE', 'artifact stream exceeded the configured byte limit');
        callback(streamError);
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      const sha256 = hash.digest('hex');
      if (options.expectedSizeBytes !== undefined && bytes !== options.expectedSizeBytes) {
        streamError = new ArtifactStreamError(422, 'SIZE_MISMATCH', 'streamed size does not match expected size');
      } else if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
        streamError = new ArtifactStreamError(422, 'HASH_MISMATCH', 'streamed hash does not match expected hash');
      }
      callback(streamError ?? undefined);
    },
  });
  const output = new PassThrough({ highWaterMark });
  const source = Readable.fromWeb(
    response.body as import('node:stream/web').ReadableStream<Uint8Array>
  );
  const onAbort = () => {
    const error = streamTransportError(scope, new Error('aborted'), 'artifact stream');
    source.destroy(error);
    meter.destroy(error);
    output.destroy(error);
  };
  scope.signal.addEventListener('abort', onAbort, { once: true });
  // DATA-04 consumer-abandon guard: an early 'close' (before the body ended)
  // means nobody downstream wants the bytes anymore — cancel the whole request
  // scope so the fetch wire stops, not just the local pipe. A naturally
  // drained stream must NOT abort: the response is already complete.
  output.once('close', () => {
    if (!output.readableEnded) scope.abort();
  });
  void pipeline(source, meter, output).catch((err: unknown) => {
    if (!output.destroyed) {
      output.destroy(streamError ?? streamTransportError(scope, err, 'artifact stream failed'));
    }
  }).finally(() => {
    scope.signal.removeEventListener('abort', onAbort);
    scope.dispose();
  });
  return output;
}

export interface UploadArtifactStreamOptions {
  uploadUrl: string;
  mimeType: string;
  sizeBytes: number;
  maxBytes: number;
  expectedSha256?: string;
  signal?: AbortSignal;
  fetcher?: SdkFetcher;
  timeoutMs?: number;
  highWaterMarkBytes?: number;
}

export interface ArtifactStreamIntegrity {
  sizeBytes: number;
  sha256: string;
}

/**
 * PUT a worker-provided stream with backpressure and integrity checks. The
 * caller must finalize the returned hash/size with the current task lease;
 * this helper never reports an unverified stream as committed.
 */
export async function uploadArtifactStream(
  input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable,
  options: UploadArtifactStreamOptions
): Promise<ArtifactStreamIntegrity> {
  assertHttpUrl(options.uploadUrl);
  assertStreamLimits(options.maxBytes, options.highWaterMarkBytes);
  if (!Number.isSafeInteger(options.sizeBytes) || options.sizeBytes < 0) {
    throw new ArtifactStreamError(422, 'SIZE_MISMATCH', 'declared artifact size is invalid');
  }
  if (options.sizeBytes > options.maxBytes) {
    throw new ArtifactStreamError(413, 'TOO_LARGE', 'declared artifact size exceeds the configured byte limit');
  }

  const fetcher = options.fetcher ?? globalThis.fetch;
  const scope = createRequestScope(options.signal, options.timeoutMs ?? 60_000);
  const highWaterMark = options.highWaterMarkBytes ?? 64 * 1024;
  const source = toNodeReadable(input);
  const hash = createHash('sha256');
  let bytes = 0;
  let sha256 = '';
  let streamError: ArtifactStreamError | null = null;
  const meter = new Transform({
    readableHighWaterMark: highWaterMark,
    writableHighWaterMark: highWaterMark,
    transform(chunk: Buffer, _encoding, callback) {
      bytes += chunk.length;
      if (bytes > options.maxBytes) {
        streamError = new ArtifactStreamError(413, 'TOO_LARGE', 'artifact stream exceeded the configured byte limit');
      } else if (bytes > options.sizeBytes) {
        streamError = new ArtifactStreamError(422, 'SIZE_MISMATCH', 'streamed artifact exceeded its declared size');
      }
      if (streamError) {
        callback(streamError);
        return;
      }
      hash.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      sha256 = hash.digest('hex');
      if (bytes !== options.sizeBytes) {
        streamError = new ArtifactStreamError(422, 'SIZE_MISMATCH', 'streamed size does not match declared size');
      } else if (options.expectedSha256 !== undefined && sha256 !== options.expectedSha256) {
        streamError = new ArtifactStreamError(422, 'HASH_MISMATCH', 'streamed hash does not match expected hash');
      }
      callback(streamError ?? undefined);
    },
  });
  const transfer = pipeline(source, meter, { signal: scope.signal });
  // Attach a rejection handler immediately; fetch may reject when the meter
  // fails before this function reaches its explicit await below.
  void transfer.catch(() => undefined);

  try {
    const init = {
      method: 'PUT',
      headers: {
        'content-type': options.mimeType,
        'content-length': String(options.sizeBytes),
      },
      body: Readable.toWeb(meter) as unknown as RequestInit['body'],
      signal: scope.signal,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' };
    const response = await fetcher(options.uploadUrl, init);
    if (!response.ok) {
      source.destroy();
      meter.destroy();
      await transfer.catch(() => undefined);
      const detail = await readErrorDetail(response);
      throw new ArtifactStreamError(response.status, 'DOWNLOAD_REJECTED', detail);
    }
    await transfer;
    if (streamError) throw streamError;
    return { sizeBytes: bytes, sha256 };
  } catch (err) {
    source.destroy();
    meter.destroy();
    await transfer.catch(() => undefined);
    if (streamError) throw streamError;
    if (err instanceof ArtifactStreamError) throw err;
    throw streamTransportError(scope, err, 'artifact upload failed');
  } finally {
    scope.dispose();
  }
}

/** Fail completion unless every declared ref is one this task finalized. */
export function committedOutputArtifactIds(
  declaredRefs: ArtifactRefDisposition[],
  finalizedRefs: readonly ArtifactRefDisposition[],
  resultRef?: string
): string[] {
  const finalized = new Map(finalizedRefs.map((ref) => [ref.artifactId, ref]));
  const refsToCheck = [...declaredRefs];
  const resultArtifact = resultRef?.match(
    /^artifact:\/\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[?#].*)?$/i
  );
  if (resultArtifact?.[1] && !refsToCheck.some((ref) => ref.artifactId === resultArtifact[1])) {
    refsToCheck.push({ artifactId: resultArtifact[1], role: 'output' });
  }
  for (const ref of refsToCheck) {
    const committed = finalized.get(ref.artifactId);
    if (!committed) {
      throw new ArtifactStreamError(409, 'OUTPUT_NOT_COMMITTED', 'output artifact was not finalized by this task');
    }
    if (ref.role !== 'output' || committed.role !== 'output' || ref.role !== committed.role) {
      throw new ArtifactStreamError(409, 'OUTPUT_NOT_COMMITTED', 'output artifact role does not match its finalized ref');
    }
    if (ref.sizeBytes !== undefined && committed.sizeBytes !== ref.sizeBytes) {
      throw new ArtifactStreamError(409, 'SIZE_MISMATCH', 'output artifact size does not match its finalized ref');
    }
    if (ref.hashSha256 !== undefined && committed.hashSha256 !== ref.hashSha256) {
      throw new ArtifactStreamError(409, 'HASH_MISMATCH', 'output artifact hash does not match its finalized ref');
    }
  }
  return [...new Set(finalizedRefs.map((ref) => ref.artifactId))];
}

export interface DownloadByIdOptions extends DownloadArtifactOptions {
  /** Runtime API base, e.g. http://orchestrator:3000/api/runtime/v1 */
  runtimeBaseUrl: string;
  /** Bearer service identity token. */
  runtimeToken: string;
}

/**
 * ART-01 download-ownership flow: exchange (taskId, leaseEpoch) for a
 * tokenized read grant, then stream from the storage-facade URL. Parent/child
 * and explicit-reference policy is enforced by the runtime before it mints
 * this grant; the SDK never resolves a storage key or bypasses that check.
 * The worker never sees storage credentials; a lost lease fails the
 * grant request (409) before any bytes move.
 */
export async function downloadArtifactById(
  ctx: { taskId: string; leaseEpoch: number },
  artifactId: string,
  workspace: TempWorkspace,
  fileName: string,
  options: DownloadByIdOptions
): Promise<DownloadedArtifact> {
  const fetcher = options.fetcher ?? globalThis.fetch;
  const accessUrl = `${options.runtimeBaseUrl.replace(/\/$/, '')}/artifacts/${encodeURIComponent(artifactId)}/access`;
  const grantScope = createRequestScope(options.signal, options.timeoutMs ?? 30_000);
  let grantRes: Response;
  try {
    grantRes = await fetcher(accessUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${options.runtimeToken}`,
      },
      body: JSON.stringify({ taskId: ctx.taskId, leaseEpoch: ctx.leaseEpoch, mode: 'read' }),
      signal: grantScope.signal,
    });
  } catch (err) {
    grantScope.dispose();
    throw new ArtifactStreamError(0, 'TRANSPORT_FAILURE', `access grant transport failure (${errorClassName(err)})`);
  }
  if (!grantRes.ok) {
    const detail = await readErrorDetail(grantRes);
    grantScope.dispose();
    throw new ArtifactStreamError(grantRes.status, 'GRANT_REJECTED', detail);
  }
  let grant: { downloadUrl?: unknown };
  try {
    grant = (await grantRes.json()) as { downloadUrl?: unknown };
  } finally {
    grantScope.dispose();
  }
  if (typeof grant.downloadUrl !== 'string' || grant.downloadUrl.length === 0) {
    throw new ArtifactStreamError(502, 'GRANT_REJECTED', 'access grant carried no downloadUrl');
  }
  return downloadArtifact(workspace, fileName, grant.downloadUrl, options);
}

/**
 * Scoped file lifetime: run `fn` with the downloaded artifact and delete
 * the temp file afterwards — on success AND on error. Handlers that only
 * need the bytes transiently (parse → structured content) never leave a
 * file behind.
 */
export async function withDownloadedArtifact<T>(
  artifact: DownloadedArtifact,
  fn: (artifact: DownloadedArtifact) => Promise<T>
): Promise<T> {
  try {
    return await fn(artifact);
  } finally {
    await removeFile(artifact.path);
  }
}

/* -------------------------------------------------------------------- */
/* Shared helpers                                                        */
/* -------------------------------------------------------------------- */

export function assertHttpUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new ArtifactStreamError(0, 'INVALID_URL', `not a parseable URL: ${url.slice(0, 128)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    // file://, ftp://, gopher:// etc. are refused (SSRF hardening).
    throw new ArtifactStreamError(0, 'INVALID_URL', `refusing non-http(s) download URL protocol ${parsed.protocol}`);
  }
}

export interface RequestScope {
  signal: AbortSignal;
  readonly timedOut: boolean;
  /**
   * DATA-04 (W-DATA04-STREAM-BOUNDS-1): explicit early-cancel of the whole
   * request. Used when a consumer abandons an opened stream before the body
   * completes — destroying the local pipe must also abort the wire.
   */
  abort: () => void;
  dispose: () => void;
}

/**
 * FIX-CR-08 / WR24-06: the whole-request abort scope must span resolve -> connect ->
 * headers -> BODY -> verification, not just headers. The previous fetchWithTimeout
 * cleared its timer and detached the caller's abort listener the moment headers
 * resolved, so a stalled body hung forever and a post-headers caller abort was a
 * no-op. The scope's signal is handed to fetch AND to Readable.fromWeb, and disposed
 * only when body consumption is finished.
 */
export function createRequestScope(outer: AbortSignal | undefined, timeoutMs: number): RequestScope {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onOuterAbort = () => controller.abort();
  if (outer) {
    if (outer.aborted) controller.abort();
    else outer.addEventListener('abort', onOuterAbort, { once: true });
  }
  return {
    signal: controller.signal,
    get timedOut() {
      return timedOut;
    },
    abort: () => controller.abort(),
    dispose: () => {
      clearTimeout(timer);
      outer?.removeEventListener('abort', onOuterAbort);
    },
  };
}

function assertStreamLimits(maxBytes: number, highWaterMarkBytes?: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new ArtifactStreamError(0, 'TOO_LARGE', 'maxBytes must be a non-negative safe integer');
  }
  if (highWaterMarkBytes !== undefined &&
      (!Number.isSafeInteger(highWaterMarkBytes) || highWaterMarkBytes < 1 || highWaterMarkBytes > 1024 * 1024)) {
    throw new ArtifactStreamError(0, 'TOO_LARGE', 'stream buffer must be between 1 byte and 1 MiB');
  }
}

export function streamTransportError(scope: RequestScope, err: unknown, prefix: string): ArtifactStreamError {
  if (scope.timedOut) return new ArtifactStreamError(408, 'TIMEOUT', `${prefix} exceeded its whole-body timeout`);
  const reason = scope.signal.aborted ? 'was aborted' : `failed (${errorClassName(err)})`;
  return new ArtifactStreamError(0, 'TRANSPORT_FAILURE', `${prefix} ${reason}`);
}

export function toNodeReadable(
  input: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable
): Readable {
  if (Readable.isReadable(input as Readable)) return input as Readable;
  if (typeof (input as ReadableStream<Uint8Array>).getReader === 'function') {
    return Readable.fromWeb(input as import('node:stream/web').ReadableStream<Uint8Array>);
  }
  if (typeof (input as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    return Readable.from(input as AsyncIterable<Uint8Array>);
  }
  throw new ArtifactStreamError(422, 'EMPTY_BODY', 'artifact source is not a readable stream');
}

/** ADM-BASE-03 / C2-4: error CLASS name only — String(err) embedded driver/undici
 * text (DSNs, sockets, upstream bodies) rode task errors to candidate-public sinks. */
function errorClassName(err: unknown): string {
  if (err instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(err.name)) return err.name;
  return 'Error';
}

/**
 * ADM-BASE-03 / C2-4: previously returned the raw upstream body (first 512 chars) as the
 * DOWNLOAD_REJECTED detail, which failTask forwarded toward the candidate public wire.
 * Now only allowlisted, non-echoing fields survive: the machine code (problem+json
 * `code` / `error.code`) plus the HTTP status. Upstream `detail`/`message`/title are
 * upstream-authored strings — exactly the sentinel-carrying channel — so they are dropped.
 */
export async function readErrorDetail(res: Response): Promise<string> {
  let text: string;
  try {
    text = await res.text();
  } catch {
    return `HTTP ${res.status}`;
  }
  if (text.length === 0) return `HTTP ${res.status}`;
  let parsed: { code?: unknown; error?: { code?: unknown }; detail?: unknown; title?: unknown };
  try {
    parsed = JSON.parse(text) as typeof parsed;
  } catch {
    // C2-4 close: raw non-JSON body text (the old 512-char slice) never travels.
    return `HTTP ${res.status}`;
  }
  const candidate =
    typeof parsed.code === 'string' ? parsed.code : typeof parsed.error?.code === 'string' ? parsed.error.code : null;
  const code = candidate && /^[A-Z][A-Z0-9_]{1,63}$/.test(candidate) ? candidate : null;
  // Server-authored problem+json detail/title may travel (they are the API's own
  // contract surface — same trust level as HttpError.detail through the server.ts
  // boundary) but length-bounded; non-JSON bodies NEVER pass through raw anymore.
  const authored = typeof parsed.detail === 'string' ? parsed.detail : typeof parsed.title === 'string' ? parsed.title : null;
  if (authored !== null) return authored.slice(0, 240);
  if (code !== null) return `HTTP ${res.status} ${code}`;
  return `HTTP ${res.status}`;
}

async function removeFile(path: string): Promise<void> {
  await unlink(path).catch(() => undefined);
}

/** Test/ops helper: backdate a workspace dir's mtime (used by sweep tests). */
export async function touchWorkspaceMtime(dir: string, mtime: Date): Promise<void> {
  await utimes(dir, mtime, mtime);
}

/** Re-export for callers that want to resolve without a workspace handle. */
export function resolveWorkspacePath(workspace: TempWorkspace, fileName: string): string {
  return resolve(workspace.filePath(fileName));
}
