/**
 * Business-Owned Document Parser Budget & Execution Helper (Wave 17, W17-A)
 *
 * Provides deterministic budget resolution, cancellation fencing, and deadline enforcement
 * across all six document-core business actions (ingest, extract, analyze, transform, generate, compare).
 *
 * CRITICAL ARCHITECTURAL BOUNDARIES & LIMITATIONS:
 * 1. Download Memory Limitation:
 *    `artifacts.read(id)` downloads the entire artifact buffer into Node.js heap memory before
 *    in-memory size validation occurs. Post-read byte length checks prevent passing oversized
 *    buffers into parser engines (preventing secondary heap blowups and DOM allocations), but
 *    do NOT bound heap memory during the initial artifact retrieval. True download memory bounding
 *    requires streaming chunk limits at the storage/connector layer.
 *
 * 2. Synchronous CPU Boundary:
 *    This helper's `Promise.race` enforces caller wait, cancellation, and deadline fencing.
 *    The built-in @du/document-kit factory also runs built-in parsers on a terminable worker
 *    thread with the same `timeoutMs`, so synchronous decompression/parser work cannot block
 *    the document-core worker event loop. A caller-supplied parserFactory/custom parser stays
 *    under the wait-only behavior and must provide its own CPU isolation.
 *
 * 3. Profile Wire Field Dependency:
 *    Published worker-sdk TaskContext does not currently expose profile-specific parser budgets.
 *    This helper employs conservative business defaults + existing SDK deadlineAt support
 *    without fabricating speculative platform wire fields.
 */

import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { open } from 'node:fs/promises';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { MULTIPART_MIN_TOTAL_BYTES } from '@du/contracts';
import {
  defaultParserFactory,
  DocumentParserFactory,
  DocumentFormatDetector,
  ParseResult,
  ParserOptions,
} from '@du/document-kit';
import { ArtifactStreamError, createTempWorkspace } from '@du/worker-sdk';
import { ArtifactReadResult, TaskContext } from '../types/context';
import { BusinessExecutionError } from '../types/results';

export interface ResolvedParserBudget {
  maxBufferSizeBytes: number;
  timeoutMs: number;
}

export interface ParserBudgetOptions {
  maxBufferSizeBytes?: number;
  timeoutMs?: number;
  mimeHint?: string;
  parserFactory?: DocumentParserFactory;
}

export class ParserBudgetHelper {
  /**
   * Conservative default limits applied when no profile or caller override is present.
   */
  public static readonly DEFAULT_MAX_BUFFER_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB
  public static readonly DEFAULT_PARSER_TIMEOUT_MS = 30_000; // 30 seconds caller wait

  /**
   * Hard ceiling on the heap ceiling, derived from the DATA-00-M contract
   * floor: the largest artifact the single-request binary band accepts is
   * `MULTIPART_MIN_TOTAL_BYTES - 1` (64 MiB). A parse budget above it would
   * ask this layer to materialize a whole multipart-band artifact in memory,
   * which no signed budget authorizes (DATA-04; T20-D1). Parsing the
   * multipart band needs a path-based parser seam (`parseFile`), not a
   * bigger buffer.
   */
  public static readonly MAX_BUFFER_SIZE_CEILING_BYTES = MULTIPART_MIN_TOTAL_BYTES - 1;

  /**
   * Quantified in-memory read exception (plan: small inline reads stay buffered).
   * PROPOSED value — DATA-00 §6 owns the signed budgets.
   */
  public static readonly INLINE_READ_BYTES = 1024 * 1024; // 1 MiB

  /**
   * DATA-04 Step B — disk-backed acquisition for streaming-capable facades:
   * size pre-flight from the authorized descriptor (zero bytes moved for
   * over-budget sources), transfer bounded mid-stream, digest re-verified from
   * the bytes actually landed, and the temp file destroyed on every failure
   * path (workspace always disposed). Returns null when the facade is
   * buffer-only or the artifact fits the inline exception — legacy path.
   */
  private static async readArtifactViaStream(
    ctx: TaskContext,
    artifactId: string
  ): Promise<ArtifactReadResult | null> {
    if (!ctx.artifacts.stat || !ctx.artifacts.readStream) return null;

    this.assertActiveDeadline(ctx);
    const budget = this.resolveParserBudget(ctx);
    const descriptor = await ctx.artifacts.stat(artifactId);
    this.assertActiveDeadline(ctx);

    if (descriptor.sizeBytes !== undefined) {
      if (descriptor.sizeBytes > budget.maxBufferSizeBytes) {
        throw new BusinessExecutionError(
          `Document size (${descriptor.sizeBytes} bytes) exceeds maximum allowed parser limit (${budget.maxBufferSizeBytes} bytes)`,
          'DOCUMENT_TOO_LARGE',
          false
        );
      }
      if (descriptor.sizeBytes <= this.INLINE_READ_BYTES) return null;
    }

    const workspace = await createTempWorkspace(ctx.taskId || 'unknown-task');
    const target = workspace.filePath(`${artifactId}.artifact`);
    try {
      const stream = await ctx.artifacts.readStream(artifactId, {
        expectedSha256: descriptor.sha256,
        expectedSizeBytes: descriptor.sizeBytes,
      });
      let transferredBytes = 0;
      const cap = new Transform({
        transform(chunk: Buffer, _encoding, callback) {
          transferredBytes += chunk.length;
          if (transferredBytes > budget.maxBufferSizeBytes) {
            callback(
              new BusinessExecutionError(
                `Document exceeded the parser limit during acquisition (${transferredBytes} bytes > ${budget.maxBufferSizeBytes} bytes)`,
                'DOCUMENT_TOO_LARGE',
                false
              )
            );
            return;
          }
          callback(null, chunk);
        },
      });
      await pipeline(stream, cap, createWriteStream(target), { signal: ctx.signal });

      const { buffer, sha256 } = await this.readBounded(target, budget.maxBufferSizeBytes);
      if (descriptor.sizeBytes !== undefined && buffer.length !== descriptor.sizeBytes) {
        throw new BusinessExecutionError(
          `Acquired ${buffer.length} bytes for an artifact declared as ${descriptor.sizeBytes} bytes`,
          'ARTIFACT_SIZE_MISMATCH',
          false
        );
      }
      if (descriptor.sha256 !== undefined && sha256 !== descriptor.sha256) {
        throw new BusinessExecutionError(
          'Acquired artifact bytes do not match the authorized grant digest',
          'ARTIFACT_INTEGRITY_MISMATCH',
          false
        );
      }
      this.assertActiveDeadline(ctx);
      const detection = DocumentFormatDetector.detect(buffer, descriptor.fileName, descriptor.mimeType);
      return {
        buffer,
        formatMetadata: {
          canonicalFormat: detection.format,
          canonicalMimeType: detection.mimeType,
          declaredFileName: descriptor.fileName,
          declaredMimeType: descriptor.mimeType,
        },
      };
    } catch (err) {
      if (ctx.signal?.aborted) {
        if (ctx.signal.reason === 'cancel' || ctx.cancelRequested) {
          throw new BusinessExecutionError('Task execution cancelled', 'OPERATION_CANCELLED', false);
        }
        throw new BusinessExecutionError('Task execution aborted', 'LEASE_LOST', false);
      }
      if (err instanceof BusinessExecutionError) throw err;
      if (err instanceof ArtifactStreamError) {
        if (err.code === 'TOO_LARGE') {
          throw new BusinessExecutionError(
            'Artifact exceeded the parser limit during acquisition',
            'DOCUMENT_TOO_LARGE',
            false
          );
        }
        if (err.code === 'HASH_MISMATCH' || err.code === 'SIZE_MISMATCH') {
          throw new BusinessExecutionError(
            'Artifact integrity verification failed during acquisition',
            'ARTIFACT_INTEGRITY_MISMATCH',
            false
          );
        }
        throw new BusinessExecutionError(
          `Artifact acquisition failed (${err.code})`,
          'DOCUMENT_ACQUISITION_FAILED',
          false
        );
      }
      throw err;
    } finally {
      await workspace.dispose();
    }
  }

  /**
   * DATA-04 Step B bound: materializes the acquired temp file in ONE
   * allocation that can never exceed the parser budget, hashing the exact
   * bytes the parser will see. A file that grew after the mid-stream cap ran
   * (hostile workspace write) is refused on its on-disk size BEFORE a single
   * byte is allocated, so peak heap from acquisition is bounded by
   * `maxBufferSizeBytes` instead of by whatever the file turned out to be.
   */
  private static async readBounded(
    target: string,
    maxBytes: number
  ): Promise<{ buffer: Buffer; sha256: string }> {
    const handle = await open(target, 'r');
    try {
      const onDisk = (await handle.stat()).size;
      if (onDisk > maxBytes) {
        throw new BusinessExecutionError(
          `Document size (${onDisk} bytes) exceeds maximum allowed parser limit (${maxBytes} bytes)`,
          'DOCUMENT_TOO_LARGE',
          false
        );
      }
      // Zero-filled on purpose: a short read must never hand uninitialized
      // heap to a parser engine.
      const buffer = Buffer.alloc(onDisk);
      const hash = createHash('sha256');
      let filled = 0;
      while (filled < onDisk) {
        const { bytesRead } = await handle.read(buffer, filled, onDisk - filled, filled);
        if (bytesRead === 0) break;
        hash.update(buffer.subarray(filled, filled + bytesRead));
        filled += bytesRead;
      }
      if (filled !== onDisk) {
        throw new BusinessExecutionError(
          `Acquired file ended after ${filled} of ${onDisk} bytes`,
          'ARTIFACT_SIZE_MISMATCH',
          false
        );
      }
      return { buffer, sha256: hash.digest('hex') };
    } finally {
      await handle.close();
    }
  }

  /**
   * Reads an artifact with its trusted canonical identity when the context provides it.
   * Buffer-only facades retain compatibility by deriving identity from the bytes.
   * Streaming-capable facades take the disk-backed Step B path above.
   */
  public static async readArtifact(ctx: TaskContext, artifactId: string): Promise<ArtifactReadResult> {
    this.assertActiveDeadline(ctx);

    const streamed = await ParserBudgetHelper.readArtifactViaStream(ctx, artifactId);
    if (streamed) return streamed;

    let artifact: ArtifactReadResult;
    if (ctx.artifacts.readWithMetadata) {
      artifact = await ctx.artifacts.readWithMetadata(artifactId);
    } else {
      const buffer = await ctx.artifacts.read(artifactId);
      const detection = DocumentFormatDetector.detect(buffer);
      artifact = {
        buffer,
        formatMetadata: {
          canonicalFormat: detection.format,
          canonicalMimeType: detection.mimeType,
        },
      };
    }

    this.assertActiveDeadline(ctx);
    const detected = DocumentFormatDetector.detect(
      artifact.buffer,
      artifact.formatMetadata.declaredFileName,
      artifact.formatMetadata.declaredMimeType
    );
    if (
      detected.format !== artifact.formatMetadata.canonicalFormat ||
      detected.mimeType !== artifact.formatMetadata.canonicalMimeType
    ) {
      throw new BusinessExecutionError(
        `Artifact format metadata does not match its bytes: declared canonical identity was ${artifact.formatMetadata.canonicalFormat} (${artifact.formatMetadata.canonicalMimeType}), detected ${detected.format} (${detected.mimeType})`,
        'ARTIFACT_FORMAT_METADATA_MISMATCH',
        false
      );
    }

    return artifact;
  }

  /** Passes the declared filename and canonical MIME through the parser boundary. */
  public static async safeParseArtifact(
    ctx: TaskContext,
    artifact: ArtifactReadResult,
    fallbackFileName: string = 'document'
  ): Promise<ParseResult> {
    const fileName = artifact.formatMetadata.declaredFileName ?? fallbackFileName;
    const result = await this.safeParseBuffer(ctx, artifact.buffer, fileName, {
      mimeHint: artifact.formatMetadata.canonicalMimeType,
    });

    if (result.metadata.detectedFormat !== artifact.formatMetadata.canonicalFormat) {
      throw new BusinessExecutionError(
        `Parser format ${result.metadata.detectedFormat} does not match trusted artifact format ${artifact.formatMetadata.canonicalFormat}`,
        'ARTIFACT_FORMAT_METADATA_MISMATCH',
        false
      );
    }

    return result;
  }

  /**
   * Asserts that the task context is active and its deadline has not expired.
   * Fails fast before any resource-intensive preparation, artifact read, or parser invocation.
   */
  public static assertActiveDeadline(ctx: TaskContext): void {
    if (ctx.signal?.aborted) {
      const isCancel =
        ctx.signal.reason === 'cancel' ||
        Boolean(ctx.cancelRequested);
      if (isCancel) {
        throw new BusinessExecutionError('Task execution cancelled', 'OPERATION_CANCELLED', false);
      }
      throw new BusinessExecutionError('Task execution aborted', 'LEASE_LOST', false);
    }

    if (ctx.deadlineAt) {
      const deadlineMs = new Date(ctx.deadlineAt).getTime();
      if (!Number.isFinite(deadlineMs)) {
        throw new BusinessExecutionError(
          `Invalid task deadlineAt timestamp: "${ctx.deadlineAt}"`,
          'INVALID_DEADLINE',
          false
        );
      }

      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new BusinessExecutionError(
          `Task deadline expired before document parsing (${remainingMs}ms remaining)`,
          'DEADLINE_EXCEEDED',
          false
        );
      }
    }
  }

  /**
   * Resolves finite parser options (maxBufferSizeBytes, timeoutMs) based on task context,
   * deadlineAt, and optional business configuration or caller overrides.
   *
   * Enforces:
   * 1. Pre-execution active and deadline check (fails fast if already expired).
   * 2. Per-call timeout is capped by remaining task deadline (cumulative wait boundary).
   * 3. Bounds validation: limits must be finite positive numbers.
   */
  public static resolveParserBudget(
    ctx: TaskContext,
    overrides?: { maxBufferSizeBytes?: number; timeoutMs?: number }
  ): ResolvedParserBudget {
    this.assertActiveDeadline(ctx);

    // 1. Resolve and validate maxBufferSizeBytes
    const maxBufferSizeBytes = overrides?.maxBufferSizeBytes ?? this.DEFAULT_MAX_BUFFER_SIZE_BYTES;
    if (
      typeof maxBufferSizeBytes !== 'number' ||
      !Number.isFinite(maxBufferSizeBytes) ||
      !Number.isInteger(maxBufferSizeBytes) ||
      maxBufferSizeBytes <= 0
    ) {
      throw new BusinessExecutionError(
        `Invalid parser maxBufferSizeBytes: must be a positive finite integer, received ${maxBufferSizeBytes}`,
        'INVALID_PARSER_BUDGET',
        false
      );
    }
    if (maxBufferSizeBytes > this.MAX_BUFFER_SIZE_CEILING_BYTES) {
      throw new BusinessExecutionError(
        `Parser buffer budget ${maxBufferSizeBytes} exceeds the ${this.MAX_BUFFER_SIZE_CEILING_BYTES} byte ceiling for materialized artifacts`,
        'INVALID_PARSER_BUDGET',
        false
      );
    }

    // 2. Resolve and validate timeoutMs
    let timeoutMs = overrides?.timeoutMs ?? this.DEFAULT_PARSER_TIMEOUT_MS;
    if (
      typeof timeoutMs !== 'number' ||
      !Number.isFinite(timeoutMs) ||
      timeoutMs <= 0
    ) {
      throw new BusinessExecutionError(
        `Invalid parser timeoutMs: must be a positive finite number, received ${timeoutMs}`,
        'INVALID_PARSER_BUDGET',
        false
      );
    }

    // 3. Cap per-call wait budget by remaining task deadline
    if (ctx.deadlineAt) {
      const deadlineMs = new Date(ctx.deadlineAt).getTime();
      const remainingMs = deadlineMs - Date.now();
      if (remainingMs <= 0) {
        throw new BusinessExecutionError(
          `Task deadline expired before document parsing (${remainingMs}ms remaining)`,
          'DEADLINE_EXCEEDED',
          false
        );
      }
      timeoutMs = Math.min(timeoutMs, remainingMs);
    }

    return {
      maxBufferSizeBytes,
      timeoutMs,
    };
  }

  /**
   * Safely parses a document buffer with explicit size, timeout, and cancellation guards.
   * Maps document-kit exceptions consistently to the business error taxonomy.
   */
  public static async safeParseBuffer(
    ctx: TaskContext,
    buffer: Buffer,
    fileName: string = 'document',
    options?: ParserBudgetOptions
  ): Promise<ParseResult> {
    this.assertActiveDeadline(ctx);

    const budget = this.resolveParserBudget(ctx, options);

    // Strict byte boundary enforcement before passing to parser
    if (buffer.length > budget.maxBufferSizeBytes) {
      throw new BusinessExecutionError(
        `Document size (${buffer.length} bytes) exceeds maximum allowed parser limit (${budget.maxBufferSizeBytes} bytes)`,
        'DOCUMENT_TOO_LARGE',
        false
      );
    }

    const factory = options?.parserFactory || defaultParserFactory;
    const parserOptions: ParserOptions = {
      maxBufferSizeBytes: budget.maxBufferSizeBytes,
      timeoutMs: budget.timeoutMs,
    };

    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<never>((_, reject) => {
      if (ctx.signal?.aborted) {
        const isCancel =
          ctx.signal.reason === 'cancel' || Boolean(ctx.cancelRequested);
        reject(
          isCancel
            ? new BusinessExecutionError('Task execution cancelled', 'OPERATION_CANCELLED', false)
            : new BusinessExecutionError('Task execution aborted', 'LEASE_LOST', false)
        );
        return;
      }
      if (ctx.signal && typeof ctx.signal.addEventListener === 'function') {
        abortListener = () => {
          const isCancel =
            ctx.signal?.reason === 'cancel' || Boolean(ctx.cancelRequested);
          reject(
            isCancel
              ? new BusinessExecutionError('Task execution cancelled', 'OPERATION_CANCELLED', false)
              : new BusinessExecutionError('Task execution aborted', 'LEASE_LOST', false)
          );
        };
        ctx.signal.addEventListener('abort', abortListener, { once: true });
      }
    });

    const parsePromise = factory.parseBuffer(buffer, fileName, options?.mimeHint, parserOptions);
    // Attach no-op catch handler to avoid unhandled rejection if abortPromise rejects first
    parsePromise.catch(() => {});

    try {
      const result = await Promise.race([parsePromise, abortPromise]);

      // CRITICAL W18 COMPLETION FENCING:
      // A late successful parser resolution must NEVER be returned if the context was
      // cancelled or the task deadline elapsed while parser execution was in flight.
      this.assertActiveDeadline(ctx);

      return result;
    } catch (err: unknown) {
      if (ctx.signal?.aborted) {
        const isCancel =
          ctx.signal.reason === 'cancel' ||
          Boolean(ctx.cancelRequested);
        if (isCancel) {
          throw new BusinessExecutionError('Task execution cancelled', 'OPERATION_CANCELLED', false);
        }
        throw new BusinessExecutionError('Task execution aborted', 'LEASE_LOST', false);
      }

      if (err instanceof BusinessExecutionError) {
        throw err;
      }

      const errMsg = (err as Error)?.message || String(err);

      // Check if timeout occurred
      if (errMsg.includes('timed out') || errMsg.includes('budget')) {
        const deadlineExpired =
          ctx.deadlineAt !== undefined &&
          ctx.deadlineAt !== null &&
          new Date(ctx.deadlineAt).getTime() - Date.now() <= 0;

        throw new BusinessExecutionError(
          errMsg,
          deadlineExpired ? 'DEADLINE_EXCEEDED' : 'DOC_PARSING_FAILED',
          false
        );
      }

      // Check if oversized buffer error from document-kit limits
      if (errMsg.includes('exceeds maximum allowed parser limit')) {
        throw new BusinessExecutionError(errMsg, 'DOCUMENT_TOO_LARGE', false);
      }

      // Standard parsing failure
      throw new BusinessExecutionError(`Document parsing failed: ${errMsg}`, 'DOC_PARSING_FAILED', false);
    } finally {
      if (abortListener && ctx.signal && typeof ctx.signal.removeEventListener === 'function') {
        ctx.signal.removeEventListener('abort', abortListener);
      }
    }
  }
}
