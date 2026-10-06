// VENDORED from @du/worker-sdk @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/worker-sdk/src/source-ingestion.ts (lines=493) sha256=8E13F361FF50A7CA068570AC9F97E74D2DB93140FD73F2FEEB4009FD6B54FDE8
// why: worker surface required by src/worker.ts, src/main.ts, types/context.ts, step-checkpoint, fanout

import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { Readable } from 'node:stream';
import { IngestionReceiptSchema, type IngestionReceipt } from '@du/contracts';
import {
  acquireSourceUrl,
  SourceAcquisitionError,
  type AcquireSourceUrlOptions,
} from './source-acquisition';
import { createTempWorkspace, type TempWorkspace } from './artifact-streams';

/**
 * DATA-03 bounded URL ingestion (packet W-DATA03-ACQ-1, producer leg).
 *
 * `acquireSourceUrl` stops at verified bytes on local disk. The Orchestrator's
 * ingestion gate (services/orchestrator/src/modules/operations/submission.ts:
 * `IngestionReceipt` / `SourceAcquirer` / `processIngestionTask`) needs one more
 * thing: those bytes turned into an IMMUTABLE pinned private-S3 version whose
 * SHA-256 and byte count are recorded, so a business task is only marked
 * runnable once its source is READY. This module is that producer side:
 *
 *   resolvePinned -> hit : answer the pinned receipt (no network, no new version)
 *                 -> miss: bounded + SSRF-fenced acquire -> stream to storage
 *                          -> cross-check digests -> return the receipt
 *
 * Invariants owned here (DATA-03 acceptance):
 * - Transfer policy (scheme, byte cap, deadline, idle, hops, IP fence) stays in
 *   `acquireSourceUrl` and is never weakened: the default fetcher is the pinned
 *   egress, so private / loopback / link-local / metadata answers and DNS
 *   rebinding are refused before connect.
 * - Bytes travel to storage as a STREAM read back from the verified temp file
 *   under a bounded chunk size; the object is never materialized in the heap.
 *   The digest is recomputed over exactly what this call handed to storage, so a
 *   workspace file rewritten after acquisition can never be pinned silently.
 * - A receipt exists only when three independent measurements agree: the
 *   acquired digest, the bytes actually streamed, and what storage committed.
 *   Every other path throws, so the caller cannot open a READY gate and no
 *   partially acquired bytes become visible to a parser.
 * - Retry idempotence: once a key is pinned, `acquire` answers the pinned
 *   receipt without touching the network. That is what makes a source URL that
 *   changed its content or went offline after the first download still resolve
 *   to the same SHA-256, which is the point of pinning an immutable version.
 *
 * Boundary: pure SDK module. No DB, no Redis, no AWS SDK - storage sits behind
 * the two-method `PinnedSourceStorage` port, so the offline suite can drive a
 * versioned in-memory fixture and a deployment can wire the real S3 facade.
 * Error text never carries the URL, a signed query, or a raw upstream string
 * (ADM-BASE-03 shape: typed code + error class name only).
 */

/**
 * The receipt IS the contract shape now (`@du/contracts` `IngestionReceipt`,
 * W-DATA01-S3-FACADE-1 / Δ14): one schema validated by the producer here, by
 * the Orchestrator gate that persists it, and by the business consumer that
 * resolves it. `artifactId` stays unset at this leg — filling it is the
 * ingestion consumer's act of materializing a READY artifact row.
 */
export type SourceIngestionReceipt = IngestionReceipt;

/** What a storage implementation reports for one committed version. */
export interface PinnedSourceWrite {
  storageKey: string;
  versionId: string;
  sha256: string;
  sizeBytes: number;
}

/**
 * The only two storage operations this flow needs. `putVerified` MUST create a
 * NEW immutable version (never overwrite bytes an earlier receipt points at) and
 * MUST report the digest and length it stored. `resolvePinned` is read-only.
 */
export interface PinnedSourceStorage {
  putVerified(input: {
    storageKey: string;
    contentType?: string;
    body: AsyncIterable<Uint8Array> | Readable;
    maxBytes: number;
    signal?: AbortSignal;
  }): Promise<PinnedSourceWrite>;
  resolvePinned(storageKey: string): Promise<SourceIngestionReceipt | null>;
}

export type SourceIngestionErrorCode =
  | 'TASK_INVALID'
  | 'MATERIALIZATION_FAILED'
  | 'RECEIPT_INVALID'
  | 'PIN_MISMATCH'
  | 'STORAGE_FAILURE'
  | 'TOO_LARGE';

/** Typed failure for the ingestion leg (acquisition keeps its own error type). */
export class SourceIngestionError extends Error {
  constructor(
    readonly status: number,
    readonly code: SourceIngestionErrorCode,
    detail?: string
  ) {
    super(detail ?? `source ingestion failed: ${code} (status ${status})`);
    this.name = 'SourceIngestionError';
  }
}

const DEFAULT_STREAM_CHUNK_BYTES = 64 * 1024;
const PRINTABLE = /^[\x20-\x7e]+$/;

/** ADM-BASE-03 C2-4 shape: error CLASS name only, never a raw upstream string. */
function errorClassName(err: unknown): string {
  if (err instanceof Error && /^[A-Za-z][A-Za-z0-9]{0,40}$/.test(err.name)) return err.name;
  return 'Error';
}
/**
 * The receipt is the durable proof the READY gate relies on, so it is validated
 * at the PRODUCER: hex-64 digest, real byte count, printable non-empty key and
 * version handle. Rejecting here means a buggy storage adapter can never open a
 * gate over bytes nobody measured.
 */
export function assertIngestionReceipt(value: unknown): SourceIngestionReceipt {
  if (!value || typeof value !== 'object') {
    throw new SourceIngestionError(502, 'RECEIPT_INVALID', 'ingestion receipt is missing');
  }
  const candidate: Record<string, unknown> = { ...(value as Record<string, unknown>) };
  // An uppercase digest from a storage adapter is normalized, not rejected:
  // the same bytes are the same bytes whichever case the reporter printed.
  // Everything else is the contract schema's call — including refusing
  // unknown fields, so a lookalike receipt cannot open a READY gate either.
  if (typeof candidate.sha256 === 'string') candidate.sha256 = candidate.sha256.toLowerCase();
  const parsed = IngestionReceiptSchema.safeParse(candidate);
  if (!parsed.success) {
    throw new SourceIngestionError(
      502,
      'RECEIPT_INVALID',
      `ingestion receipt failed contract validation: ${parsed.error.issues[0]?.message ?? 'invalid'}`
    );
  }
  return parsed.data;
}

export interface SourceIngestorOptions {
  storage: PinnedSourceStorage;
  /**
   * The deterministic object key the receipt is pinned under. Owned by the
   * caller (tenant/operation scoped namespace) - this module invents no storage
   * namespace of its own.
   */
  storageKey: string;
  /** Transfer policy handed to `acquireSourceUrl` (`maxBytes` required). */
  transfer: AcquireSourceUrlOptions;
  /** File name inside the SDK temp workspace; never a caller-controlled path. */
  fileName?: string;
  /** Content type offered to storage for the new object version. */
  contentType?: string;
  /** Workspace owner (task/lease id) used only for temp directory naming. */
  taskId?: string;
  /** Chunk bound for the read-back-to-storage leg; 1 byte..1 MiB. */
  highWaterMarkBytes?: number;
  /**
   * Answer the already-pinned receipt instead of re-fetching (default true).
   * False forces a fresh acquisition for re-ingest flows that deliberately want
   * a NEW version.
   */
  reusePinned?: boolean;
  /** Injected workspace when the caller owns the temp lifetime. */
  workspace?: TempWorkspace;
}

export interface SourceIngestor {
  /** Structurally the Orchestrator's `SourceAcquirer.acquire`. */
  acquire(sourceUrl: string): Promise<SourceIngestionReceipt>;
}

export function createSourceAcquisitionIngestor(options: SourceIngestorOptions): SourceIngestor {
  const storageKey = options.storageKey;
  if (typeof storageKey !== 'string' || storageKey.length === 0 || !PRINTABLE.test(storageKey)) {
    throw new SourceIngestionError(422, 'RECEIPT_INVALID', 'storageKey must be a non-empty printable string');
  }
  if (!Number.isSafeInteger(options.transfer.maxBytes) || options.transfer.maxBytes < 1) {
    throw new SourceIngestionError(422, 'TOO_LARGE', 'a positive maxBytes transfer budget is required');
  }
  const highWaterMark = options.highWaterMarkBytes ?? DEFAULT_STREAM_CHUNK_BYTES;
  if (!Number.isSafeInteger(highWaterMark) || highWaterMark < 1 || highWaterMark > 1024 * 1024) {
    throw new SourceIngestionError(422, 'TOO_LARGE', 'stream buffer must be between 1 byte and 1 MiB');
  }
  const reusePinned = options.reusePinned !== false;
  const fileName = options.fileName ?? 'source.bin';

  return {
    async acquire(sourceUrl: string): Promise<SourceIngestionReceipt> {
      if (reusePinned) {
        const pinned = await readPinned(storageKey, options.storage);
        if (pinned !== null) return pinned;
      }

      const ownsWorkspace = options.workspace === undefined;
      const workspace = options.workspace ?? (await createTempWorkspace(options.taskId ?? 'source-ingest'));
      const measured = { sha256: '', sizeBytes: -1 };
      try {
        // 1. Bounded, SSRF-fenced acquisition down to verified local bytes.
        const acquired = await acquireSourceUrl(workspace, fileName, sourceUrl, options.transfer);

        // 2. Stream that file into a NEW immutable version, measuring the bytes
        //    as they leave this process (never a whole-object heap buffer).
        const stored = await writeVersion(options.storage, {
          storageKey,
          contentType: options.contentType,
          body: measuring(
            createReadStream(acquired.path, { highWaterMark }),
            {
              expectedSizeBytes: acquired.sizeBytes,
              maxBytes: options.transfer.maxBytes,
              signal: options.transfer.signal,
            },
            measured
          ),
          maxBytes: options.transfer.maxBytes,
          signal: options.transfer.signal,
        });

        // 3. Pin only when the three measurements agree.
        if (measured.sha256 !== acquired.sha256 || measured.sizeBytes !== acquired.sizeBytes) {
          throw new SourceIngestionError(
            502,
            'PIN_MISMATCH',
            'the bytes streamed to storage no longer match the acquired source'
          );
        }
        if (stored.sha256.toLowerCase() !== acquired.sha256 || stored.sizeBytes !== acquired.sizeBytes) {
          throw new SourceIngestionError(
            502,
            'PIN_MISMATCH',
            'storage committed bytes disagree with the acquired source'
          );
        }
        return assertIngestionReceipt({
          storageKey: stored.storageKey,
          versionId: stored.versionId,
          sha256: acquired.sha256,
          sizeBytes: acquired.sizeBytes,
        });
      } catch (err) {
        if (err instanceof SourceAcquisitionError || err instanceof SourceIngestionError) throw err;
        throw new SourceIngestionError(502, 'PIN_MISMATCH', `source ingestion failed (${errorClassName(err)})`);
      } finally {
        if (ownsWorkspace) await workspace.dispose();
      }
    },
  };
}

/**
 * DATA-03 (Δ17, packet W-DATA03-INGESTION-WIRING-1) — the ingestion-task
 * handler: the worker-side executor behind "a claimed URL-source task".
 *
 * The producer leg (`createSourceAcquisitionIngestor`) stops at a pinned
 * receipt; the Orchestrator gate (`markIngestionReady`) must not open until
 * that receipt is complete. What Δ17 recorded as missing is the middle act:
 * registering the pinned copy as a READY artifact row and putting its
 * `artifactId` on the receipt. Without it, every business task that reaches
 * the pin fails visibly downstream (`INGESTION_SOURCE_UNRESOLVED` in
 * businesses/document-core/src/actions/ingest). This handler owns that act as
 * pure ports, so the whole claim -> acquire -> materialize -> gate-ready flow
 * is testable offline; the DB adapter is the composition root's line to draw.
 *
 * Guarantees (each pinned by tests in tests/source-ingestion.test.ts):
 * - Nothing runs before the task descriptor is proven shape-safe; a URL with
 *   control characters is refused pre-network (WHATWG parsing silently strips
 *   tab/CR/LF — a stripped URL is a smuggled URL, so this fails closed).
 * - The acquirer's receipt is re-validated against the contract before the
 *   materializer ever sees it: a foreign acquirer cannot inject a pin the
 *   READY gate would trust.
 * - Acquisition failures propagate typed and untransformed, and the
 *   materializer is NEVER called — no artifact row can reference bytes that
 *   failed the egress fence, the byte budget, the hop bound, or the digest.
 * - A pin that already carries an `artifactId` replays without network and
 *   without a second materialization: row and pin already agree.
 * - The materializer answers either the new artifact id (string) or the full
 *   echoed receipt. An echo whose digest/size/key/version disagrees with the
 *   pinned bytes is PIN_MISMATCH — the row must describe THESE bytes. A null
 *   answer is MATERIALIZATION_FAILED: a pin without a READY row is exactly
 *   the state that hurts downstream, so the gate stays shut at the producer.
 * - The emitted receipt is contract-validated AFTER the artifact id merges,
 *   so what the READY gate persists is exactly what the consumer resolves.
 * - Error text never carries the URL, upstream bodies, or raw adapter strings
 *   (ADM-BASE-03 shape: typed code + error class name only).
 *
 * Composition contract: the worker/Orchestrator root builds one handler per
 * claimed ingestion task (the ingestor carries the per-task transfer budget
 * and expectations), implements `materializeArtifact` over the artifacts
 * table, and hands the returned receipt to `markIngestionReady` /
 * `processIngestionTask` in services/orchestrator.
 */
export interface IngestionTask {
  /** Durable operation id; printable, non-empty, never echoed raw. */
  operationId: string;
  /** UNTRUSTED source URL — every transfer guard lives in acquireSourceUrl. */
  sourceUrl: string;
  /** Action input the READY envelope will carry; never mutated here. */
  input?: Record<string, unknown>;
}

/** The artifact row port's answer: an id, a full echoed receipt, or nothing. */
export type MaterializedArtifact = string | SourceIngestionReceipt | null | undefined;

export interface IngestionTaskHandlerDeps {
  /** Structurally the Orchestrator's `SourceAcquirer` slot. */
  acquirer: Pick<SourceIngestor, 'acquire'>;
  /**
   * Registers the pinned copy as a READY artifact row and returns its id (or
   * echoes the receipt with `artifactId` set). Must be idempotent per receipt:
   * a retried task reuses the same pinned version and must land the same row.
   */
  materializeArtifact(
    task: IngestionTask,
    receipt: SourceIngestionReceipt
  ): Promise<MaterializedArtifact>;
}

export interface IngestionTaskHandler {
  run(task: IngestionTask): Promise<SourceIngestionReceipt>;
}

export function createIngestionTaskHandler(deps: IngestionTaskHandlerDeps): IngestionTaskHandler {
  return {
    async run(task: IngestionTask): Promise<SourceIngestionReceipt> {
      const claimed = assertIngestionTask(task);
      const receipt = assertIngestionReceipt(await deps.acquirer.acquire(claimed.sourceUrl));
      // A pin that already carries a materialization handle is a complete
      // prior run — replay it without touching storage or the row port.
      if (receipt.artifactId !== undefined) return receipt;

      let materialized: MaterializedArtifact;
      try {
        materialized = await deps.materializeArtifact(claimed, receipt);
      } catch (err) {
        if (err instanceof SourceIngestionError || err instanceof SourceAcquisitionError) throw err;
        throw new SourceIngestionError(
          502,
          'MATERIALIZATION_FAILED',
          `artifact materialization failed (${errorClassName(err)})`
        );
      }
      return mergeMaterializedPin(receipt, materialized);
    },
  };
}

function assertIngestionTask(task: IngestionTask): IngestionTask {
  if (!task || typeof task !== 'object') {
    throw new SourceIngestionError(422, 'TASK_INVALID', 'ingestion task descriptor is missing');
  }
  if (typeof task.operationId !== 'string' || !PRINTABLE.test(task.operationId)) {
    throw new SourceIngestionError(422, 'TASK_INVALID', 'operationId must be a non-empty printable string');
  }
  if (
    typeof task.sourceUrl !== 'string' ||
    task.sourceUrl.length === 0 ||
    /[\x00-\x1f\x7f]/.test(task.sourceUrl)
  ) {
    throw new SourceIngestionError(
      422,
      'TASK_INVALID',
      'sourceUrl must be a non-empty string without control characters'
    );
  }
  if (
    task.input !== undefined &&
    (typeof task.input !== 'object' || task.input === null || Array.isArray(task.input))
  ) {
    throw new SourceIngestionError(422, 'TASK_INVALID', 'task input must be an object when present');
  }
  return task.input === undefined
    ? { operationId: task.operationId, sourceUrl: task.sourceUrl }
    : { operationId: task.operationId, sourceUrl: task.sourceUrl, input: task.input };
}

function mergeMaterializedPin(
  receipt: SourceIngestionReceipt,
  materialized: MaterializedArtifact
): SourceIngestionReceipt {
  if (materialized === null || materialized === undefined) {
    // A pin without a READY artifact row is exactly the state that surfaces
    // downstream as INGESTION_SOURCE_UNRESOLVED — keep the gate shut here.
    throw new SourceIngestionError(
      502,
      'MATERIALIZATION_FAILED',
      'the pinned source was not materialized as a READY artifact'
    );
  }
  let artifactId: string;
  if (typeof materialized === 'string') {
    artifactId = materialized;
  } else {
    // Police the echo through the same contract the gate will apply later;
    // a half-shaped object is adapter garbage, not a shortcut.
    const echoed = assertIngestionReceipt(materialized);
    const describesSameBytes =
      echoed.storageKey === receipt.storageKey &&
      echoed.versionId === receipt.versionId &&
      echoed.sha256 === receipt.sha256 &&
      echoed.sizeBytes === receipt.sizeBytes;
    if (!describesSameBytes) {
      throw new SourceIngestionError(
        502,
        'PIN_MISMATCH',
        'the materialized artifact row describes bytes other than the pinned source'
      );
    }
    if (echoed.artifactId === undefined) {
      throw new SourceIngestionError(
        502,
        'MATERIALIZATION_FAILED',
        'the echoed receipt carries no artifact id'
      );
    }
    artifactId = echoed.artifactId;
  }
  // Only the artifact id is trusted from the port; the rest stays the
  // validated pin. Re-validation refuses a non-UUID id outright.
  return assertIngestionReceipt({ ...receipt, artifactId });
}

async function readPinned(
  storageKey: string,
  storage: PinnedSourceStorage
): Promise<SourceIngestionReceipt | null> {
  let found: SourceIngestionReceipt | null;
  try {
    found = await storage.resolvePinned(storageKey);
  } catch (err) {
    throw new SourceIngestionError(502, 'STORAGE_FAILURE', `pinned lookup failed (${errorClassName(err)})`);
  }
  if (found === null || found === undefined) return null;
  // A corrupt pin is a fault, not a licence to re-download behind a live gate.
  return assertIngestionReceipt(found);
}

async function writeVersion(
  storage: PinnedSourceStorage,
  input: Parameters<PinnedSourceStorage['putVerified']>[0]
): Promise<PinnedSourceWrite> {
  let written: PinnedSourceWrite;
  try {
    written = await storage.putVerified(input);
  } catch (err) {
    if (err instanceof SourceIngestionError) throw err;
    throw new SourceIngestionError(502, 'STORAGE_FAILURE', `storage write failed (${errorClassName(err)})`);
  }
  if (!written || typeof written !== 'object') {
    throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'storage returned no write receipt');
  }
  if (written.storageKey !== input.storageKey) {
    throw new SourceIngestionError(502, 'PIN_MISMATCH', 'storage committed the bytes under a different key');
  }
  return written;
}

/**
 * Pass-through async iterator over the file stream that re-applies the byte cap,
 * refuses any length drift from the acquired size, and hashes exactly the chunks
 * handed onward (published into `sink` when the body ends cleanly). Exiting the
 * loop early destroys the underlying file stream per Node async-iteration
 * semantics, so a failed upload cannot keep a handle open.
 */
async function* measuring(
  source: Readable,
  limits: { expectedSizeBytes: number; maxBytes: number; signal?: AbortSignal },
  sink: { sha256: string; sizeBytes: number }
): AsyncGenerator<Buffer> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  for await (const raw of source) {
    if (limits.signal?.aborted) {
      throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'upload aborted before the version committed');
    }
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
    if (chunk.length === 0) continue;
    sizeBytes += chunk.length;
    if (sizeBytes > limits.maxBytes) {
      throw new SourceIngestionError(413, 'TOO_LARGE', 'source exceeded the transfer byte budget');
    }
    if (sizeBytes > limits.expectedSizeBytes) {
      throw new SourceIngestionError(502, 'PIN_MISMATCH', 'source grew past its acquired length');
    }
    hash.update(chunk);
    yield chunk;
  }
  if (sizeBytes !== limits.expectedSizeBytes) {
    throw new SourceIngestionError(502, 'PIN_MISMATCH', 'source ended short of its acquired length');
  }
  sink.sha256 = hash.digest('hex');
  sink.sizeBytes = sizeBytes;
}

