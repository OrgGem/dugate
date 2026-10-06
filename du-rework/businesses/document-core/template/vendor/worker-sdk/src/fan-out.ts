// VENDORED from @du/worker-sdk @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/worker-sdk/src/fan-out.ts (lines=717) sha256=410EA97532106511F5A968A5A25B2CEC1DA637F85FB98C5F2AC9F371F66763FA
// why: worker surface required by src/worker.ts, src/main.ts, types/context.ts, step-checkpoint, fanout

import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  SpawnChildrenAckSchema,
  SpawnChildrenRequestSchema,
  contentHash,
} from '@du/contracts';
import { Logger } from '@du/observability';

/**
 * Fan-out / HITL / streaming / artifact-upload SDK helpers (P4-04).
 *
 * These are pure, framework-agnostic helpers that business handlers can
 * call from a TaskContext. They share the same wire contract as the
 * runtime client used by `DefaultTaskContext` but never duplicate runtime
 * state — every helper routes through an injected fetcher so the contract
 * is testable without DB / Redis / network.
 *
 * Invariants:
 *
 * 1. `spawnChild` persists the parent + child tasks in one runtime tx and
 *    returns a `ChildHandle` whose `childTaskId` is durable across
 *    handler replays. It does NOT wait for completion (RUN-05: parent
 *    yields its slot).
 * 2. `waitForChildren` polls the parent `/children` endpoint until every
 *    child is in a terminal state. Concurrency is fixed at 1: each poll
 *    observes the join state as a snapshot; concurrent polls would race
 *    the runtime's join reconciliation. Honoring `AbortSignal` releases
 *    the loop cleanly on lease loss / cancel.
 * 3. `uploadArtifact` is a staged upload: obtain a grant, PUT bytes to
 *    the presigned URL, finalize with sha256+size. On any failure
 *    (transport, hash mismatch, finalize rejection) the caller's buffer
 *    is zeroed. The helper never leaves a half-finalized artifact row
 *    behind: the runtime's orphan-reaper (out of this lane) reaps rows
 *    whose grant was issued but never finalized.
 * 4. `streamResult` writes a result in chunks to a runtime write endpoint
 *    using `fetch(..., { body: ReadableStream })`. It NEVER concatenates
 *    the full result in memory; the caller may stream an arbitrarily
 *    large result.
 *
 * Boundary: these helpers never call `globalThis.fetch` directly in
 * tests; the injected fetcher captures the wire shape and the runtime
 * is mocked. They also never touch the DB or storage directly — bytes
 * go through the presigned URL the runtime returns.
 */

/**
 * Type alias for the fetcher the helpers accept. Aligned with the
 * global `fetch` (so `globalThis.fetch` and any compatible mock fit
 * without casting). The streaming helper passes a `ReadableStream` body
 * via undici / Node's WHATWG fetch; at the type boundary we widen via
 * a single cast so this signature stays faithful to the standard type.
 */
export type SdkFetcher = typeof fetch;

export interface SdkHelperOptions {
  /** Override the global `fetch` (tests / proxies). */
  fetcher?: SdkFetcher;
  /** Structured logger; defaults to a no-op logger when omitted. */
  logger?: Logger;
  /** Per-request timeout in ms (default 30s). */
  timeoutMs?: number;
}

/* -------------------------------------------------------------------- */
/* Fan-out (RUN-05): spawnChild + waitForChildren                       */
/* -------------------------------------------------------------------- */

export interface SpawnChildInput {
  taskKey: string; // deterministic per business definition (not array index)
  kind: string; // registered handler kind
  payload: Record<string, unknown>;
}

export interface ChildHandle {
  childTaskId: string;
  taskKey: string;
  kind: string;
  /** sha256 of the JSON-canonicalized payload. */
  payloadHash: string;
}

export interface SpawnChildOptions {
  /** Lease epoch from the current claim; sent on the wire for fencing. */
  leaseEpoch: number;
  /** Currently only 'all-success' is supported (RUN-05 v1). */
  joinPolicy?: 'all-success';
  /** Opaque continuation handle persisted with the children. */
  continuationRef: string;
}

/**
 * Spawn a single child task under the current parent's join. POSTs to
 * `/api/runtime/v1/tasks/:taskId/children` and returns the first
 * `childTaskId` from the runtime's ack. The runtime persists parent +
 * children + dependency + parent wait in one transaction.
 *
 * Note: for fan-out of N>1 children use `DefaultTaskContext.spawn.spawnAndWait`,
 * which persists the whole batch atomically. `spawnChild` is the single-child
 * convenience exported for HITL-restart / dynamic-fanout use cases where
 * the handler wants a typed `ChildHandle` it can later poll or hand off.
 */
export async function spawnChild(
  ctx: { taskId: string },
  input: SpawnChildInput,
  options: SpawnChildOptions,
  runtimeBaseUrl: string,
  runtimeToken: string,
  opts: SdkHelperOptions = {}
): Promise<ChildHandle> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const url = `${runtimeBaseUrl.replace(/\/$/, '')}/tasks/${encodeURIComponent(ctx.taskId)}/children`;
  const payloadHash = contentHash(input.payload);
  const body = SpawnChildrenRequestSchema.parse({
    leaseEpoch: options.leaseEpoch,
    children: [
      {
        taskKey: input.taskKey,
        kind: input.kind,
        payloadRef: input.payload,
        payloadHash,
      },
    ],
    joinPolicy: options.joinPolicy ?? 'all-success',
    continuationRef: options.continuationRef,
  });
  const res = await timedFetch(
    fetcher,
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${runtimeToken}`,
      },
      body: JSON.stringify(body),
    },
    opts.timeoutMs
  );
  await throwIfNotOk(res, `spawnChild POST ${url}`);
  const raw = (await res.json()) as unknown;
  const ack = SpawnChildrenAckSchema.parse(raw);
  if (ack.childTaskIds.length === 0) {
    throw new Error('spawnChild: runtime returned no childTaskIds');
  }
  const childTaskId = ack.childTaskIds[0]!;
  return { childTaskId, taskKey: input.taskKey, kind: input.kind, payloadHash };
}

export interface ChildState {
  taskId: string;
  taskKey: string;
  kind: string;
  state: string;
  resultRef: string | null;
  errorCode: string | null;
}

export interface WaitForChildrenOptions {
  /** Maximum poll iterations; default 120 (~4 minutes at 2s default). */
  maxAttempts?: number;
  /** Delay between polls in ms; default 2000. */
  intervalMs?: number;
  /** Abort the loop early on lease loss / cancel / shutdown. */
  signal?: AbortSignal;
}

export type WaitForChildrenOutcome =
  | { ok: true; status: 200; children: ChildState[]; allSucceeded: boolean }
  | { ok: false; status: number; detail: string; failed: ChildState[] };

/**
 * Poll `/api/runtime/v1/tasks/:taskId/children` until every child is in a
 * terminal state (SUCCEEDED / FAILED / CANCELLED). Concurrency is fixed
 * at 1: each poll observes the join state as a snapshot, racing the
 * runtime's reconciliation would yield duplicated continuation rows.
 *
 * Returns an outcome with `allSucceeded: boolean` so the handler can
 * branch on join results without re-fetching. If any child is FAILED /
 * CANCELLED the loop short-circuits with `ok: false`.
 */
export async function waitForChildren(
  ctx: { taskId: string },
  handles: readonly ChildHandle[],
  runtimeBaseUrl: string,
  runtimeToken: string,
  opts: SdkHelperOptions & WaitForChildrenOptions = {}
): Promise<WaitForChildrenOutcome> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const maxAttempts = opts.maxAttempts ?? 120;
  const intervalMs = opts.intervalMs ?? 2000;
  const expected = new Set(handles.map((h) => h.childTaskId));
  const url = `${runtimeBaseUrl.replace(/\/$/, '')}/tasks/${encodeURIComponent(ctx.taskId)}/children`;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.signal?.aborted) {
      return {
        ok: false,
        status: 0,
        detail: 'waitForChildren aborted',
        failed: [],
      };
    }
    const res = await timedFetch(
      fetcher,
      url,
      {
        method: 'GET',
        headers: { authorization: `Bearer ${runtimeToken}` },
      },
      opts.timeoutMs
    );
    if (!res.ok) {
      const detail = await readDetail(res);
      return { ok: false, status: res.status, detail, failed: [] };
    }
    const raw = (await res.json()) as { children?: unknown };
    const children = parseChildren(raw.children);
    const ours = children.filter((c) => expected.has(c.taskId));
    const terminal = ours.filter((c) => isTerminalTaskState(c.state));
    if (terminal.length === ours.length && ours.length === expected.size) {
      const allSucceeded = ours.every((c) => c.state === 'SUCCEEDED');
      return { ok: true, status: 200, children: ours, allSucceeded };
    }
    if (terminal.some((c) => c.state === 'FAILED' || c.state === 'CANCELLED')) {
      // Only terminal-failed children are reported; still-running siblings
      // are cancelled by the runtime's join reconciliation.
      const failed = ours.filter((c) => c.state === 'FAILED' || c.state === 'CANCELLED');
      return {
        ok: false,
        status: 409,
        detail: `child join failed: ${failed.map((f) => `${f.taskKey}=${f.state}`).join(',')}`,
        failed,
      };
    }
    await delay(intervalMs, opts.signal);
  }
  return {
    ok: false,
    status: 504,
    detail: `waitForChildren timed out after ${maxAttempts} attempts`,
    failed: [],
  };
}

/* -------------------------------------------------------------------- */
/* Artifact upload (ART-01..03): staged upload + hash + temp cleanup    */
/* -------------------------------------------------------------------- */

export interface UploadArtifactOptions {
  /** File name persisted in the artifact ref. */
  fileName: string;
  /** MIME type for the upload grant and `Content-Type` on PUT. */
  mimeType: string;
  /** Purpose bucket for the artifact policy. */
  purpose?: 'input' | 'output' | 'intermediate' | 'session';
  /** Optional pre-computed sha256; computed from buffer when omitted. */
  expectedSha256?: string;
}

export interface UploadedArtifact {
  artifactId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
}

/**
 * Staged artifact upload (ART-02):
 *
 *   1. POST `/tasks/:id/artifacts` → upload grant (artifactId, uploadUrl).
 *   2. PUT bytes to the presigned URL (Content-Type from grant).
 *   3. POST `/artifacts/:id/finalize` with producer identity, size, and hash.
 *
 * The buffer is zeroed on any failure (transport / PUT / finalize / hash
 * mismatch) so the caller can confidently reuse the memory. No half
 * state is left behind: if finalize rejects, the helper surfaces the
 * error and the runtime's orphan-reaper (out of this lane) reaps the
 * row.
 */
export async function uploadArtifact(
  ctx: { taskId: string; leaseEpoch: number },
  buffer: Buffer,
  options: UploadArtifactOptions,
  runtimeBaseUrl: string,
  runtimeToken: string,
  opts: SdkHelperOptions = {}
): Promise<UploadedArtifact> {
  const fetcher = opts.fetcher ?? globalThis.fetch;
  const purpose = options.purpose ?? 'output';
  const expectedSha = options.expectedSha256 ?? null;

  const grantUrl = `${runtimeBaseUrl.replace(/\/$/, '')}/tasks/${encodeURIComponent(ctx.taskId)}/artifacts`;
  let grantRes: Response;
  try {
    grantRes = await timedFetch(
      fetcher,
      grantUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${runtimeToken}`,
        },
        body: JSON.stringify({
          leaseEpoch: ctx.leaseEpoch,
          purpose,
          fileName: options.fileName,
          mimeType: options.mimeType,
          sizeBytes: buffer.byteLength,
        }),
      },
      opts.timeoutMs
    );
  } catch (err) {
    zeroBuffer(buffer);
    throw new ArtifactUploadError(0, 'TRANSPORT_FAILURE', `upload grant: ${String(err)}`);
  }
  if (!grantRes.ok) {
    const detail = await readDetail(grantRes);
    zeroBuffer(buffer);
    throw new ArtifactUploadError(grantRes.status, 'GRANT_REJECTED', detail);
  }
  const grantRaw = (await grantRes.json()) as {
    artifactId?: unknown;
    uploadUrl?: unknown;
  };
  const artifactId = typeof grantRaw.artifactId === 'string' ? grantRaw.artifactId : null;
  const uploadUrl = typeof grantRaw.uploadUrl === 'string' ? grantRaw.uploadUrl : null;
  if (!artifactId || !uploadUrl) {
    zeroBuffer(buffer);
    throw new ArtifactUploadError(502, 'GRANT_INVALID', 'malformed upload grant');
  }

  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (expectedSha && expectedSha !== sha256) {
    zeroBuffer(buffer);
    throw new ArtifactUploadError(
      422,
      'HASH_MISMATCH',
      `local sha256 ${sha256} != expected ${expectedSha}`
    );
  }

  let putRes: Response;
  try {
    putRes = await timedFetch(
      fetcher,
      uploadUrl,
      {
        method: 'PUT',
        headers: { 'content-type': options.mimeType },
        // VENDOR PATCH (approved option a): @types/node undici-types and
        // lib.dom disagree on BodyInit vs Buffer. Upstream compiles because
        // its own lib set differs; behaviour is unchanged, types only.
        body: buffer as unknown as BodyInit,
      },
      opts.timeoutMs
    );
  } catch (err) {
    zeroBuffer(buffer);
    throw new ArtifactUploadError(0, 'TRANSPORT_FAILURE', `PUT ${uploadUrl}: ${String(err)}`);
  }
  if (!putRes.ok) {
    const detail = await readDetail(putRes);
    zeroBuffer(buffer);
    throw new ArtifactUploadError(putRes.status, 'UPLOAD_REJECTED', detail);
  }

  const finalizeUrl = `${runtimeBaseUrl.replace(/\/$/, '')}/artifacts/${encodeURIComponent(artifactId)}/finalize`;
  let finRes: Response;
  try {
    finRes = await timedFetch(
      fetcher,
      finalizeUrl,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${runtimeToken}`,
        },
        body: JSON.stringify({
          taskId: ctx.taskId,
          leaseEpoch: ctx.leaseEpoch,
          sizeBytes: buffer.byteLength,
          sha256,
        }),
      },
      opts.timeoutMs
    );
  } catch (err) {
    zeroBuffer(buffer);
    throw new ArtifactUploadError(0, 'TRANSPORT_FAILURE', `finalize ${artifactId}: ${String(err)}`);
  }
  zeroBuffer(buffer);
  if (!finRes.ok) {
    const detail = await readDetail(finRes);
    throw new ArtifactUploadError(finRes.status, 'FINALIZE_REJECTED', detail);
  }

  return {
    artifactId,
    fileName: options.fileName,
    mimeType: options.mimeType,
    sizeBytes: buffer.byteLength,
    sha256,
  };
}

/** Surfaces a typed failure for the staged upload pipeline. */
export class ArtifactUploadError extends Error {
  constructor(
    readonly status: number,
    readonly code:
      | 'GRANT_REJECTED'
      | 'GRANT_INVALID'
      | 'HASH_MISMATCH'
      | 'UPLOAD_REJECTED'
      | 'FINALIZE_REJECTED'
      | 'TRANSPORT_FAILURE',
    detail?: string
  ) {
    super(detail ?? `artifact upload failed: ${code} (status ${status})`);
    this.name = 'ArtifactUploadError';
  }
}

/* -------------------------------------------------------------------- */
/* Streaming result write (ART-03 boundary: no full buffer in memory)    */
/* -------------------------------------------------------------------- */

export interface StreamResultInput {
  /** `Content-Type` for the streamed write. */
  mimeType: string;
  /** Optional lease epoch (carried on the wire for fencing). */
  leaseEpoch?: number;
  /** Abort the stream on lease loss / cancel / shutdown. */
  signal?: AbortSignal;
}

export interface StreamResultOptions {
  /** Override the global `fetch` (tests / proxies). */
  fetcher?: SdkFetcher;
  /** Per-request timeout in ms (default 60s; covers slow links). */
  timeoutMs?: number;
  /**
   * Sink URL. When omitted the helper defaults to the runtime's
   * `/tasks/:id/result` endpoint (requires `runtimeBaseUrl` + bearer
   * auth). Supply an absolute presigned URL to bypass the runtime.
   */
  url?: string;
  /** Bearer token used when writing to the runtime endpoint. */
  token?: string;
  /** Runtime base URL when writing to the runtime `/result` endpoint. */
  runtimeBaseUrl?: string;
}

export interface StreamResultOutcome {
  ok: true;
  status: number;
  bytesWritten: number;
}

/**
 * Stream a result body in chunks to a runtime write endpoint without
 * buffering the full result in memory.
 *
 * The helper converts the caller's `AsyncIterable<Uint8Array>` /
 * `ReadableStream<Uint8Array>` / `Readable` into a `ReadableStream` and
 * passes it as the `fetch` body. Modern `fetch` implementations (Node
 * 18+, undici, browser native) pipe the stream as it is consumed, so
 * memory usage stays bounded regardless of result size.
 *
 * Backpressure: when the consumer aborts (e.g. lease loss), the source
 * iterable's `return()` is invoked via the `cancel` callback so
 * producers can release upstream resources (open files, sockets).
 */
export async function streamResult(
  ctx: { taskId: string },
  stream: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable,
  input: StreamResultInput,
  opts: StreamResultOptions = {}
): Promise<StreamResultOutcome> {
  const fetcher = opts.fetcher ?? globalThis.fetch;

  // Default: runtime write endpoint. A caller-supplied absolute `url`
  // (e.g. a presigned URL) bypasses the bearer-auth header below.
  const isAbsolutePresigned = typeof opts.url === 'string' && /^https?:\/\//.test(opts.url);
  const targetUrl = isAbsolutePresigned
    ? opts.url!
    : `${(opts.runtimeBaseUrl ?? '').replace(/\/$/, '')}/tasks/${encodeURIComponent(ctx.taskId)}/result`;

  const headers: Record<string, string> = { 'content-type': input.mimeType };
  if (!isAbsolutePresigned && opts.token) {
    headers['authorization'] = `Bearer ${opts.token}`;
  }
  if (typeof input.leaseEpoch === 'number') {
    headers['x-lease-epoch'] = String(input.leaseEpoch);
  }

  const source = toReadableStream(stream);
  let bytesWritten = 0;
  // Single reader for the lifetime of the stream: one chunk per pull so
  // backpressure propagates to the source (bounded memory), and cancel
  // propagates through reader.cancel → source.cancel → iterator.return.
  let sourceReader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  const passthrough = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (input.signal?.aborted) {
        controller.error(new Error('streamResult aborted'));
        return;
      }
      sourceReader ??= source.getReader();
      const { done, value } = await sourceReader.read();
      if (done) {
        controller.close();
        return;
      }
      if (value) {
        bytesWritten += value.byteLength;
        controller.enqueue(value);
      }
    },
    async cancel(reason) {
      if (sourceReader) {
        await sourceReader.cancel(reason).catch(() => undefined);
      } else {
        await source.cancel(reason).catch(() => undefined);
      }
    },
  });

  const init: RequestInit = {
    method: 'POST',
    headers,
    // Pass-through the ReadableStream body. The DOM `BodyInit` type does
    // not list `ReadableStream` but undici / Node 18+ global fetch accept
    // one at runtime. The cast is at the single boundary that needs it
    // (the SDK tsconfig only includes ES2022 lib; no DOM `BodyInit`).
    body: passthrough as unknown as RequestInit['body'],
  };

  const res = await timedFetch(fetcher, targetUrl, init, opts.timeoutMs ?? 60_000);
  if (!res.ok) {
    const detail = await readDetail(res);
    throw new StreamResultError(res.status, detail);
  }
  return { ok: true, status: res.status, bytesWritten };
}

/** Surfaces a typed failure for the streaming write. */
export class StreamResultError extends Error {
  constructor(readonly status: number, detail?: string) {
    super(detail ?? `streamResult failed: status ${status}`);
    this.name = 'StreamResultError';
  }
}

/* -------------------------------------------------------------------- */
/* Shared helpers                                                       */
/* -------------------------------------------------------------------- */

const TERMINAL_TASK_STATES: ReadonlySet<string> = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED']);

function isTerminalTaskState(s: string): boolean {
  return TERMINAL_TASK_STATES.has(s);
}

function zeroBuffer(buf: Buffer): void {
  // Best-effort: Buffer.fill leaves the underlying ArrayBuffer cleared on
  // supported Node versions. The caller controls the buffer's lifecycle;
  // this is defense-in-depth for callers that hand off sensitive bytes
  // (PDF, API keys, PII).
  try {
    buf.fill(0);
  } catch {
    /* noop — readonly buffers are rare in practice */
  }
}

/**
 * The runtime GET /tasks/:id/children contract is camelCase. Keep the older
 * database-style aliases as a tolerant compatibility path for existing SDK
 * callers/fixtures; canonical camelCase values take precedence.
 */
interface RuntimeChildRow {
  taskId?: unknown;
  id?: unknown;
  task_id?: unknown;
  taskKey?: unknown;
  task_key?: unknown;
  kind?: unknown;
  state?: unknown;
  resultRef?: unknown;
  result_ref?: unknown;
  errorCode?: unknown;
  error_code?: unknown;
}

function parseChildren(raw: unknown): ChildState[] {
  if (!Array.isArray(raw)) return [];
  const out: ChildState[] = [];
  for (const row of raw as RuntimeChildRow[]) {
    if (!row || typeof row !== 'object') continue;
    const taskId = pickString(row.taskId) ?? pickString(row.id) ?? pickString(row.task_id);
    const taskKey = pickString(row.taskKey) ?? pickString(row.task_key);
    const kind = pickString(row.kind);
    const state = pickString(row.state);
    if (!taskId || !state) continue;
    out.push({
      taskId,
      taskKey: taskKey ?? '',
      kind: kind ?? '',
      state,
      resultRef: pickString(row.resultRef) ?? pickString(row.result_ref),
      errorCode: pickString(row.errorCode) ?? pickString(row.error_code),
    });
  }
  return out;
}

function pickString(v: unknown): string | null {
  return typeof v === 'string' ? v : null;
}

async function timedFetch(
  fetcher: SdkFetcher,
  url: string,
  init: RequestInit,
  timeoutMs = 30_000
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetcher(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function throwIfNotOk(res: Response, ctx: string): Promise<void> {
  if (res.ok) return;
  const detail = await readDetail(res);
  throw new Error(`${ctx} failed: status ${res.status} detail=${detail}`);
}

async function readDetail(res: Response): Promise<string> {
  try {
    const text = await res.text();
    if (!text) return `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(text) as { detail?: unknown; title?: unknown; message?: unknown };
      if (typeof parsed.detail === 'string') return parsed.detail;
      if (typeof parsed.title === 'string') return parsed.title;
      if (typeof parsed.message === 'string') return parsed.message;
    } catch {
      /* not JSON — fall through */
    }
    return text.slice(0, 512);
  } catch {
    return `HTTP ${res.status}`;
  }
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(timer);
        resolve();
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

function toReadableStream(
  src: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable
): ReadableStream<Uint8Array> {
  // Order matters: a ReadableStream also satisfies AsyncIterable in DOM
  // typings, so we must check the WHATWG shape first.
  if (typeof (src as ReadableStream<Uint8Array>).getReader === 'function') {
    return src as ReadableStream<Uint8Array>;
  }
  if (typeof Readable.isReadable === 'function' && Readable.isReadable(src as Readable)) {
    return Readable.toWeb(src as Readable) as unknown as ReadableStream<Uint8Array>;
  }
  if (typeof (src as AsyncIterable<Uint8Array>)[Symbol.asyncIterator] === 'function') {
    const iter = src as AsyncIterable<Uint8Array>;
    // Acquire the iterator ONCE: a fresh iterator per pull() would
    // restart the source and never terminate.
    const it = iter[Symbol.asyncIterator]();
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          const { done, value } = await it.next();
          if (done) {
            controller.close();
            return;
          }
          if (value) controller.enqueue(value);
        } catch (err) {
          controller.error(err);
        }
      },
      async cancel(reason) {
        const maybeReturn = (it as { return?: () => Promise<IteratorResult<Uint8Array>> }).return;
        if (typeof maybeReturn === 'function') {
          await maybeReturn.call(it);
        }
        void reason;
      },
    });
  }
  throw new Error('streamResult: source is not a ReadableStream, Readable, or AsyncIterable<Uint8Array>');
}
