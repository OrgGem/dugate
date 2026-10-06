// VENDORED from @du/worker-sdk @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/worker-sdk/src/source-acquisition.ts (lines=391) sha256=BE7AC23AF99E63916BFBFD4D1314F0D7D9EB04FE00703F3AEC94CF9571563E1E
// why: worker surface required by src/worker.ts, src/main.ts, types/context.ts, step-checkpoint, fanout

import { createHash, timingSafeEqual } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { rm } from 'node:fs/promises';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createPinnedFetch, DestinationDeniedError } from '@du/egress';
import type { SdkFetcher } from './fan-out';
import type { TempWorkspace } from './artifact-streams';
import { createRequestScope } from './artifact-streams';

/**
 * DATA-03 (tasks/DEPLOY-STORAGE-LOGGING-2026-09-24.md): bounded URL source
 * acquisition — the fetch half of the ingestion path, SDK side. The URL a
 * caller submits is UNTRUSTED input; this helper is the only shape in which
 * the SDK may ever touch it. What it guarantees:
 *
 * - SSRF fencing: the DEFAULT fetcher is the shared pinned egress
 *   (`@du/egress`, PR-Q3-03/09): ONE DNS resolution feeds both policy
 *   adjudication and the socket, so a public-then-loopback rebinding answer
 *   cannot slip through a TOCTOU window; private/loopback/link-local/
 *   metadata/CGNAT/multicast destinations are denied BEFORE connect, and a
 *   3xx hop into blocked space is denied by egress itself (CYCLE-103).
 * - Scheme policy: HTTPS only unless the deployment opts a target into
 *   `allowHttp` (the plan's "approved allowlist schemes" seam). Userinfo is
 *   refused on EVERY hop — `user:pass@` forms measured 8/8 hostile passes
 *   against a bare url() check (FIX-CR-01).
 * - Redirect hop BOUND: egress never follows (manual semantics), so the
 *   follow loop lives here and is capped (`maxRedirects`, default 3). Every
 *   hop is re-validated (scheme, userinfo) and handed to the fetcher again,
 *   which re-adjudicates and re-resolves it — a redirect chain cannot walk
 *   from public DNS into an internal address.
 * - Budgets (plan: byte/time/decompression): `maxBytes` is checked against
 *   Content-Length BEFORE any write and enforced MID-STREAM on DECODED bytes
 *   (egress and undici both transparently decompress, so a compressed
 *   zip-bomb is measured at its expanded size); `timeoutMs` is the
 *   whole-acquisition deadline (FIX-CR-08: scope spans resolve→connect→
 *   headers→body→verification); `idleTimeoutMs` tears down a body that
 *   stalls between chunks, so a slow-drip stream cannot pin a worker slot.
 * - Integrity: SHA-256 is computed while streaming; when the caller supplies
 *   an expected digest/size (e.g. a policy-pinned review from a prior
 *   attempt), a mismatch rejects. Acquisition NEVER returns unverified or
 *   partial bytes: every failure path deletes the partial file, so a failed
 *   acquisition cannot leave bytes for a later parse step to discover
 *   ("failed acquisition does not create READY or parse half bytes").
 *
 * The bytes land in a task-isolated temp workspace (P4-05 ART-02/03): the
 * caller streams them onward (e.g. writeStream → S3 with finalize lease) and
 * disposes the workspace; nothing here buffers a whole document in memory.
 */

export type SourceAcquisitionErrorCode =
  | 'INVALID_URL'
  | 'SCHEME_NOT_ALLOWED'
  | 'DESTINATION_DENIED'
  | 'REDIRECT_LIMIT'
  | 'SOURCE_REJECTED'
  | 'TOO_LARGE'
  | 'HASH_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'EMPTY_BODY'
  | 'TIMEOUT'
  | 'IDLE_TIMEOUT'
  | 'TRANSPORT_FAILURE';

/** Typed failure for every acquisition path (discriminated by `code`). */
export class SourceAcquisitionError extends Error {
  constructor(
    readonly status: number,
    readonly code: SourceAcquisitionErrorCode,
    detail?: string
  ) {
    super(detail ?? `source acquisition failed: ${code} (status ${status})`);
    this.name = 'SourceAcquisitionError';
  }
}

/** Redirects beyond this count are refused; 0 refuses any redirect at all. */
export const DEFAULT_MAX_SOURCE_REDIRECTS = 3;
/** Whole-acquisition deadline (headers AND body), FIX-CR-08 semantics. */
export const DEFAULT_SOURCE_TIMEOUT_MS = 60_000;
/** A body that sends no chunk for this long is torn down (slow-stream cap). */
export const DEFAULT_SOURCE_IDLE_MS = 10_000;

export interface AcquireSourceUrlOptions {
  /** Hard cap on DECODED bytes — up-front (Content-Length) and mid-stream. */
  maxBytes: number;
  /** When set, verified against the sha256 computed while streaming. */
  expectedSha256?: string;
  /** When set, verified against the streamed byte count. */
  expectedSizeBytes?: number;
  /** Opt-in for plain http (plan: approved-allowlist schemes). Default false. */
  allowHttp?: boolean;
  /** Follow-redirect bound for THIS caller (egress itself never follows). */
  maxRedirects?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  /** Caller cancellation (lease loss / shutdown). Aborts every hop + body. */
  signal?: AbortSignal;
  /**
   * Injectable fetcher (tests / deployments with a narrower egress policy).
   * Omitting it is the safe default: a fresh pinned-egress fetcher with NO
   * private-network opt-in. A caller that hands in a raw global fetch opts
   * out of socket-level SSRF fencing and owns that choice at the seam.
   */
  fetcher?: SdkFetcher;
  /** Per-stream Node buffer bound; 1 byte..1 MiB (same rule as artifact streams). */
  highWaterMarkBytes?: number;
}

export interface AcquiredSource {
  /** Absolute path of the verified file inside the workspace. */
  path: string;
  /** Bytes actually written (verified <= maxBytes). */
  sizeBytes: number;
  /** SHA-256 of the written bytes, computed while streaming. */
  sha256: string;
  /** Redirects followed (0 = the initial URL answered the bytes). */
  hops: number;
}

interface ValidatedTarget {
  url: URL;
}

/**
 * Per-attempt URL policy: parseable, scheme-allowed, no userinfo. The
 * destination IP policy is NOT duplicated here — adjudication belongs to the
 * pinned egress layer that shares its answer with the socket; duplicating a
 * second textual check here would recreate the two-resolutions gap this
 * module exists to close.
 */
function validateTarget(raw: string, allowHttp: boolean): ValidatedTarget {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new SourceAcquisitionError(422, 'INVALID_URL', 'source URL is not parseable');
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp)) {
    throw new SourceAcquisitionError(
      422,
      'SCHEME_NOT_ALLOWED',
      `source URL protocol ${url.protocol} is not allowed (https only unless explicitly opted in)`
    );
  }
  if (url.username.length > 0 || url.password.length > 0) {
    throw new SourceAcquisitionError(422, 'INVALID_URL', 'source URL carries userinfo');
  }
  return { url };
}

function assertLimits(maxBytes: number, highWaterMarkBytes?: number): void {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    throw new SourceAcquisitionError(422, 'TOO_LARGE', 'maxBytes must be a non-negative safe integer');
  }
  if (
    highWaterMarkBytes !== undefined &&
    (!Number.isSafeInteger(highWaterMarkBytes) || highWaterMarkBytes < 1 || highWaterMarkBytes > 1024 * 1024)
  ) {
    throw new SourceAcquisitionError(422, 'TOO_LARGE', 'stream buffer must be between 1 byte and 1 MiB');
  }
}

/** ADM-BASE-03 C2-4 shape: error CLASS name only, never a raw upstream string. */
function errorClassName(err: unknown): string {
  if (err instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(err.name)) return err.name;
  return 'Error';
}

async function removeFile(path: string): Promise<void> {
  await rm(path, { force: true }).catch(() => undefined);
}

/**
 * Fetch a caller-supplied URL into `workspace/fileName` under the guards
 * documented at the top of this module. Resolves only with complete,
 * verified bytes; every rejection leaves no file behind.
 */
export async function acquireSourceUrl(
  workspace: TempWorkspace,
  fileName: string,
  url: string,
  options: AcquireSourceUrlOptions
): Promise<AcquiredSource> {
  // File name is validated before anything touches the network (ART-03).
  const target = workspace.filePath(fileName);
  const validated = validateTarget(url, options.allowHttp === true);
  const maxRedirects = options.maxRedirects ?? DEFAULT_MAX_SOURCE_REDIRECTS;
  if (!Number.isSafeInteger(maxRedirects) || maxRedirects < 0) {
    throw new SourceAcquisitionError(422, 'REDIRECT_LIMIT', 'maxRedirects must be a non-negative safe integer');
  }
  assertLimits(options.maxBytes, options.highWaterMarkBytes);

  // The DEFAULT is socket-pinned egress with the strict policy: no private
  // networks, no host opt-ins. No body shape ever routes around it, because
  // this helper only ever issues GETs.
  const idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_SOURCE_IDLE_MS;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) {
    throw new SourceAcquisitionError(422, 'TRANSPORT_FAILURE', 'idleTimeoutMs must be a positive safe integer');
  }
  const fetcher = options.fetcher ?? createPinnedFetch();
  const scope = createRequestScope(options.signal, options.timeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS);

  try {
    let current = validated.url;
    let hops = 0;
    let res: Response;
    /* ------------------- hop loop (bounded, re-adjudicated) ------------ */
    for (;;) {
      try {
        res = await fetcher(current.href, { method: 'GET', redirect: 'manual', signal: scope.signal });
      } catch (err) {
        throw mapFetchError(err, scope);
      }
      const status = res.status;
      if (status >= 300 && status < 400) {
        await res.body?.cancel().catch(() => undefined);
        const location = res.headers.get('location');
        if (location === null || location.length === 0) {
          throw new SourceAcquisitionError(status, 'SOURCE_REJECTED', 'redirect carried no usable Location');
        }
        if (hops >= maxRedirects) {
          throw new SourceAcquisitionError(
            status,
            'REDIRECT_LIMIT',
            `source redirected ${hops + 1} times; maxRedirects is ${maxRedirects}`
          );
        }
        let next: URL;
        try {
          next = new URL(location, current);
        } catch {
          throw new SourceAcquisitionError(status, 'SOURCE_REJECTED', 'redirect Location is unparseable');
        }
        // Every hop re-passes the URL policy; the fetcher re-adjudicates the
        // destination (and its pinned resolver re-resolves it) on the next
        // iteration — the chain never inherits the previous hop's answer.
        current = validateTarget(next.href, options.allowHttp === true).url;
        hops += 1;
        continue;
      }
      if (!res.ok) {
        // Upstream error bodies are THIRD-PARTY text (ADM-BASE-03 C2-4): the
        // status alone travels; the body is dropped without being read.
        await res.body?.cancel().catch(() => undefined);
        throw new SourceAcquisitionError(status, 'SOURCE_REJECTED', `source answered HTTP ${status}`);
      }
      break;
    }

    /* ------------------- byte budget before any write ------------------ */
    const contentLength = res.headers.get('content-length');
    if (contentLength !== null) {
      const declared = Number(contentLength);
      if (Number.isFinite(declared) && declared > options.maxBytes) {
        await res.body?.cancel().catch(() => undefined);
        throw new SourceAcquisitionError(
          413,
          'TOO_LARGE',
          `declared content-length ${declared} exceeds maxBytes ${options.maxBytes}`
        );
      }
    }
    if (!res.body) {
      throw new SourceAcquisitionError(502, 'EMPTY_BODY', 'source response carried no body');
    }

    /* ------------------- bounded, hashing body read -------------------- */
    const highWaterMark = options.highWaterMarkBytes ?? 64 * 1024;
    const hash = createHash('sha256');
    let bytes = 0;
    let limitError: SourceAcquisitionError | null = null;
    const counter = new Transform({
      readableHighWaterMark: highWaterMark,
      writableHighWaterMark: highWaterMark,
      transform(chunk: Buffer, _encoding, callback) {
        bytes += chunk.length;
        if (bytes > options.maxBytes) {
          limitError = new SourceAcquisitionError(
            413,
            'TOO_LARGE',
            `source stream exceeded maxBytes ${options.maxBytes} (streamed ${bytes})`
          );
          // Destroy the SOURCE with the same error: pipeline then rejects
          // deterministically with the cap breach instead of racing it
          // against the socket-teardown error its own cancel produces.
          source?.destroy(limitError);
          callback(limitError);
          return;
        }
        // Measured on DECODED bytes: both pinned egress and undici
        // transparently decompress, so this cap also bounds a zip bomb.
        hash.update(chunk);
        armIdle();
        callback(null, chunk);
      },
    });

    let source: Readable | undefined;

    // Stall watchdog: rearmed on every chunk that reaches the counter; a
    // stream that stops feeding inside idleTimeoutMs is destroyed (a slow
    // drip must not pin a worker slot until the whole-deadline fires).
    let idleError: SourceAcquisitionError | null = null;
    let idleTimer: NodeJS.Timeout | undefined;
    const armIdle = (): void => {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        idleError = new SourceAcquisitionError(
          408,
          'IDLE_TIMEOUT',
          `source body sent no bytes for ${idleTimeoutMs}ms`
        );
        counter.destroy(idleError);
        source?.destroy(idleError);
      }, idleTimeoutMs);
      idleTimer.unref?.();
    };

    source = Readable.fromWeb(
      res.body as import('node:stream/web').ReadableStream<Uint8Array>,
      { signal: scope.signal }
    );
    try {
      armIdle();
      await pipeline(source, counter, createWriteStream(target));
    } catch (err) {
      if (limitError) throw limitError;
      if (idleError) throw idleError;
      if (scope.timedOut || scope.signal.aborted) throw mapFetchError(err, scope);
      if (err instanceof SourceAcquisitionError) throw err;
      throw new SourceAcquisitionError(
        0,
        'TRANSPORT_FAILURE',
        `source stream failure (${errorClassName(err)})`
      );
    } finally {
      if (idleTimer !== undefined) clearTimeout(idleTimer);
    }

    /* ------------------------- verification ---------------------------- */
    const sha256 = hash.digest('hex');
    if (options.expectedSha256 !== undefined && !timingSafeHexEqual(options.expectedSha256, sha256)) {
      await removeFile(target);
      throw new SourceAcquisitionError(422, 'HASH_MISMATCH', 'streamed sha256 does not match the expected digest');
    }
    if (options.expectedSizeBytes !== undefined && options.expectedSizeBytes !== bytes) {
      await removeFile(target);
      throw new SourceAcquisitionError(
        422,
        'SIZE_MISMATCH',
        `streamed ${bytes} bytes != expected ${options.expectedSizeBytes}`
      );
    }
    return { path: target, sizeBytes: bytes, sha256, hops };
  } catch (err) {
    // Fail closed: no partial or unverified file ever survives an acquisition
    // failure — the parse step downstream cannot discover half bytes.
    await removeFile(target);
    throw err;
  } finally {
    scope.dispose();
  }
}

/**
 * Timing-safe compare for digests the caller may supply (a review hash from a
 * previous attempt): the compare must not leak how many hex chars matched.
 */
function timingSafeHexEqual(expected: string, actual: string): boolean {
  const a = expected.toLowerCase();
  if (!/^[a-f0-9]{64}$/.test(a) || !/^[a-f0-9]{64}$/.test(actual)) return false;
  return timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(actual, 'hex'));
}

function mapFetchError(err: unknown, scope: { timedOut: boolean; signal: AbortSignal }): SourceAcquisitionError {
  if (err instanceof DestinationDeniedError) {
    // egress messages are static + reason enum only (no URL, no resolver
    // text); keep that shape rather than echoing anything upstream.
    return new SourceAcquisitionError(403, 'DESTINATION_DENIED', 'pinned egress denied the destination');
  }
  if (scope.timedOut) {
    return new SourceAcquisitionError(408, 'TIMEOUT', 'acquisition exceeded its whole-request deadline');
  }
  if (scope.signal.aborted || errorClassName(err) === 'AbortError') {
    return new SourceAcquisitionError(0, 'TRANSPORT_FAILURE', 'acquisition was aborted');
  }
  if (err instanceof SourceAcquisitionError) return err;
  const rawCode = /^[A-Z]+$/.test(String((err as NodeJS.ErrnoException).code ?? '')) ? '/' + String((err as NodeJS.ErrnoException).code) : '';
  return new SourceAcquisitionError(0, 'TRANSPORT_FAILURE', `source fetch failed (${errorClassName(err)}${rawCode})`);
}
