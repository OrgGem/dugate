import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  defineBusiness,
  startWorker,
  TaskHandler,
  TaskContext as SdkTaskContext,
  BusinessDefinition,
  WorkerConfig,
  WorkerHandle,
  QueueConsumer,
} from '@du/worker-sdk';
import { ArtifactPurpose, TaskDisposition, InvocationResponse } from '@du/contracts';
import { DocumentFormatDetector } from '@du/document-kit';
import { documentCoreManifest } from './manifest/document-core.manifest';
import { ArtifactReadResult, ArtifactRef, ArtifactStat, ArtifactReadStreamOptions, TaskContext, StepCheckpointRecord } from './types/context';
import { IngestAction } from './actions/ingest';
import { ExtractAction } from './actions/extract';
import { AnalyzeAction } from './actions/analyze';
import { TransformAction } from './actions/transform';
import { GenerateAction } from './actions/generate';
import { CompareAction } from './actions/compare';

export type { TaskDisposition, TaskHandler, BusinessDefinition, WorkerConfig, WorkerHandle, QueueConsumer };
export type BusinessTaskHandler = TaskHandler;

import { LeaseLostError, type TaskArtifactBinding, type TaskArtifactCrypto, type WorkerCryptoSeam } from '@du/worker-sdk';
import { BusinessExecutionError } from './types/results';

/**
 * Adapter ensuring compatibility whether the handler is invoked by the SDK
 * runtime (DefaultTaskContext) or directly with a TaskContext in tests.
 * Enforces cancellation/lease-loss fencing at every side-effect boundary.
 */
function assertActive(ctx: SdkTaskContext | TaskContext): void {
  if (ctx.signal?.aborted) {
    const isCancel =
      ctx.signal.reason === 'cancel' ||
      ('cancelRequested' in ctx && Boolean((ctx as SdkTaskContext).cancelRequested));
    if (isCancel) {
      throw new BusinessExecutionError('Task execution cancelled', 'OPERATION_CANCELLED', false);
    }
    throw new LeaseLostError(ctx.taskId);
  }

  if (ctx.deadlineAt) {
    const deadlineMs = new Date(ctx.deadlineAt).getTime();
    if (Number.isFinite(deadlineMs) && deadlineMs - Date.now() <= 0) {
      throw new BusinessExecutionError(
        `Task deadline expired before execution step (${deadlineMs - Date.now()}ms remaining)`,
        'DEADLINE_EXCEEDED',
        false
      );
    }
  }
}

/**
 * Internal view of a task context whose artifact facade guarantees the streaming
 * write surface (the adapter below always provides it): on the SDK path it
 * delegates to the platform facade (grant -> stream -> lease-finalize), on
 * buffered-only facades (embedded/test contexts) it drains with size + digest
 * verification and falls through to write with byte-identical content.
 */
type StreamingTaskContext = TaskContext & {
  artifacts: TaskContext['artifacts'] & {
    writeStream(
      content: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable,
      fileName: string,
      mimeType: string,
      sizeBytes: number,
      purpose?: ArtifactPurpose,
      expectedSha256?: string
    ): Promise<ArtifactRef>;
  };
};

/**
 * Step A (DATA-04 §12): envelope results are serialized once, hashed once, and
 * committed through the streaming write path — same bytes, same finalize result,
 * same artifact:// resultRef as the buffered write() path it replaces.
 */
async function writeEnvelopeArtifact(
  internalCtx: StreamingTaskContext,
  envelope: unknown,
  fileName: string
): Promise<ArtifactRef> {
  const bytes = Buffer.from(JSON.stringify(envelope, null, 2), 'utf8');
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  return internalCtx.artifacts.writeStream(
    Readable.from([bytes]),
    fileName,
    'application/json',
    bytes.byteLength,
    'output',
    sha256
  );
}

/**
 * W-ENC-04-SEAM: the SDK context exposes `cryptoFor(binding)`, which returns a
 * handle already bound to the tenant the SERVER asserted at claim time. It is
 * feature-detected rather than assumed: an internal/test context has no such
 * method, and that context must keep working with encryption off (the whole
 * point of the seam being opt-in).
 */
function taskCrypto(ctx: SdkTaskContext | TaskContext): TaskArtifactCrypto | undefined {
  const withSeam = ctx as unknown as {
    // `cryptoSeam` reports whether encryption is actually CONFIGURED.
    // Probing `cryptoFor` instead would be wrong: that method exists on the SDK
    // context whether or not a seam was injected, so a worker with encryption
    // OFF would look enabled and every later call would throw.
    cryptoSeam?: () => WorkerCryptoSeam | undefined;
    cryptoFor?: (binding: TaskArtifactBinding) => TaskArtifactCrypto;
  };
  if (typeof withSeam.cryptoSeam === 'function') {
    const seam = withSeam.cryptoSeam();
    // Binding uses the CONTEXT tenant, never a value the handler supplies: a
    // handler-chosen tenant would produce an authenticated envelope that the
    // real owner cannot read.
    return seam && typeof withSeam.cryptoFor === 'function'
      ? withSeam.cryptoFor({ artifactId: 'step-checkpoint', purpose: 'intermediate' })
      : undefined;
  }
  if (typeof withSeam.cryptoFor !== 'function') return undefined;
  return withSeam.cryptoFor({ artifactId: 'step-checkpoint', purpose: 'intermediate' });
}

export function toInternalContext(ctx: SdkTaskContext | TaskContext): StreamingTaskContext {
  const isInternal = typeof (ctx as { step?: unknown }).step === 'function';
  const artifactFacade = ctx.artifacts as unknown as {
    read(artifactId: string): Promise<Buffer>;
    readWithMetadata?: (artifactId: string) => Promise<
      | ArtifactReadResult
      | { buffer: Buffer; filename?: string; mimeType?: string; sizeBytes: number; sha256: string }
    >;
    write(content: Buffer | string, fileName: string, mimeType: string): ReturnType<TaskContext['artifacts']['write']>;
    writeStream?(
      content: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable,
      fileName: string,
      mimeType: string,
      sizeBytes: number,
      purpose?: string,
      expectedSha256?: string
    ): Promise<ArtifactRef>;
    stat?(artifactId: string): Promise<ArtifactStat>;
    readStream?(artifactId: string, options?: ArtifactReadStreamOptions): Promise<Readable>;
  };

  const crypto = taskCrypto(ctx);
  return {
    taskId: ctx.taskId,
    operationId: ctx.operationId,
    businessId: ctx.businessId,
    businessVersion: ctx.businessVersion,
    tenantId: ctx.tenantId,
    // Undefined when the worker runs without a seam: encryption is opt-in, and
    // every consumer below falls back to the plaintext behaviour in that case.
    ...(crypto ? { crypto } : {}),
    signal: ctx.signal,
    deadlineAt: 'deadlineAt' in ctx ? ctx.deadlineAt : undefined,
    cancelRequested: 'cancelRequested' in ctx ? ctx.cancelRequested : undefined,
    artifacts: {
      read: (id) => {
        assertActive(ctx);
        return artifactFacade.read(id);
      },
      readWithMetadata: async (id) => {
        assertActive(ctx);
        if (artifactFacade.readWithMetadata) {
          const readResult = await artifactFacade.readWithMetadata(id);
          assertActive(ctx);
          if (isInternal) return readResult as ArtifactReadResult;

          const sdkRead = readResult as {
            buffer: Buffer;
            filename?: string;
            mimeType?: string;
            sizeBytes: number;
            sha256: string;
          };
          const detection = DocumentFormatDetector.detect(
            sdkRead.buffer,
            sdkRead.filename,
            sdkRead.mimeType
          );
          return {
            buffer: sdkRead.buffer,
            formatMetadata: {
              canonicalFormat: detection.format,
              canonicalMimeType: detection.mimeType,
              declaredFileName: sdkRead.filename,
              declaredMimeType: sdkRead.mimeType,
            },
          };
        }

        const buffer = await artifactFacade.read(id);
        assertActive(ctx);
        const detection = DocumentFormatDetector.detect(buffer);
        return {
          buffer,
          formatMetadata: {
            canonicalFormat: detection.format,
            canonicalMimeType: detection.mimeType,
          },
        };
      },
      write: (content, fileName, mimeType) => {
        assertActive(ctx);
        return artifactFacade.write(content, fileName, mimeType);
      },
      writeStream: async (content, fileName, mimeType, sizeBytes, purpose, expectedSha256) => {
        assertActive(ctx);
        if (artifactFacade.writeStream) {
          const ref = await artifactFacade.writeStream(
            content,
            fileName,
            mimeType,
            sizeBytes,
            purpose ?? 'output',
            expectedSha256
          );
          assertActive(ctx);
          return ref;
        }
        // Internal/test facades expose buffered write only; drain the stream
        // with the declared-size bound so behavior matches the SDK grant path.
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of content as AsyncIterable<Uint8Array>) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.length;
          if (totalBytes > sizeBytes) {
            throw new BusinessExecutionError(
              'Streamed artifact exceeded its declared size',
              'SIZE_MISMATCH',
              false
            );
          }
          chunks.push(bytes);
        }
        if (totalBytes !== sizeBytes) {
          throw new BusinessExecutionError(
            `Streamed ${totalBytes} bytes for a ${sizeBytes}-byte artifact`,
            'SIZE_MISMATCH',
            false
          );
        }
        const buffer = Buffer.concat(chunks, totalBytes);
        if (expectedSha256 !== undefined) {
          const sha256 = createHash('sha256').update(buffer).digest('hex');
          if (sha256 !== expectedSha256) {
            throw new BusinessExecutionError(
              'Streamed artifact digest does not match the declared digest',
              'ARTIFACT_HASH_MISMATCH',
              false
            );
          }
        }
        const ref = await artifactFacade.write(buffer, fileName, mimeType);
        assertActive(ctx);
        return ref;
      },
      // Step B read-acquisition seams pass through ONLY when the underlying
      // facade really implements them (buffer-only facades keep the legacy
      // in-memory path — no synthesized streams).
      stat: artifactFacade.stat
        ? async (artifactId) => {
            assertActive(ctx);
            const descriptor = await artifactFacade.stat!(artifactId);
            assertActive(ctx);
            return descriptor;
          }
        : undefined,
      readStream: artifactFacade.readStream
        ? async (artifactId, options) => {
            assertActive(ctx);
            const stream = await artifactFacade.readStream!(artifactId, options);
            assertActive(ctx);
            return stream;
          }
        : undefined,
    },
    connector: {
      invoke: async (slot, promptOrPayload, options) => {
        assertActive(ctx);
        if (isInternal) {
          return (ctx as TaskContext).connector.invoke(slot, promptOrPayload, options);
        }
        let input: { prompt?: string; text?: string; artifacts?: { artifactId: string }[]; outputSchema?: Record<string, unknown> };
        if (typeof promptOrPayload === 'string') {
          input = { prompt: promptOrPayload };
        } else {
          const obj = promptOrPayload as Record<string, unknown>;
          const payloadObj = (obj['payload'] && typeof obj['payload'] === 'object') ? (obj['payload'] as Record<string, unknown>) : undefined;
          const extractedText = typeof obj['text'] === 'string'
            ? obj['text']
            : (payloadObj && typeof payloadObj['documentSnippet'] === 'string' ? (payloadObj['documentSnippet'] as string) : undefined);
          const promptText = typeof obj['prompt'] === 'string'
            ? (obj['prompt'] as string)
            : (typeof obj['task'] === 'string'
                ? `${obj['task']}: ${payloadObj && typeof payloadObj['promptText'] === 'string' ? payloadObj['promptText'] : JSON.stringify(obj['payload'] ?? '')}`
                : JSON.stringify(obj));

          const rawSchema = obj['outputSchema'] || obj['jsonSchema'] || payloadObj?.['schema'];
          input = {
            prompt: promptText,
            text: extractedText,
            outputSchema: rawSchema && typeof rawSchema === 'object'
              ? (rawSchema as Record<string, unknown>)
              : undefined,
            artifacts: Array.isArray(obj['artifacts']) ? (obj['artifacts'] as { artifactId: string }[]) : undefined,
          };
        }

        let res: InvocationResponse;
        try {
          res = await (ctx as SdkTaskContext).connector.invoke(slot, input, options as Record<string, unknown> | undefined);
        } catch (err: unknown) {
          assertActive(ctx);
          if (err instanceof LeaseLostError || (err as { name?: string })?.name === 'LeaseLostError') {
            throw err;
          }
          const errCandidate = err as { code?: string; message?: string };
          if (errCandidate?.code === 'INVOCATION_UNKNOWN' || errCandidate?.message?.includes('INVOCATION_UNKNOWN')) {
            throw new BusinessExecutionError(
              errCandidate.message || 'Connector transport failed; outcome unknown (blind retry prohibited)',
              'INVOCATION_UNKNOWN',
              false // NEVER blind retry
            );
          }
          throw err;
        }

        assertActive(ctx);

        if (res.state === 'UNKNOWN' || res.error?.code === 'INVOCATION_UNKNOWN') {
          throw new BusinessExecutionError(
            res.error?.message || 'Connector invocation outcome unknown; reconciliation required (blind retry prohibited)',
            'INVOCATION_UNKNOWN',
            false // NEVER blind retry
          );
        }

        const status: 'SUCCESS' | 'ERROR' = res.state === 'SUCCEEDED' ? 'SUCCESS' : 'ERROR';
        const data = res.result?.data;
        const rawText = res.result?.content;
        const usage = res.usage
          ? {
              promptTokens: res.usage.inputTokens,
              completionTokens: res.usage.outputTokens,
              totalTokens: res.usage.inputTokens + res.usage.outputTokens,
            }
          : undefined;
        const error = res.error
          ? {
              code: res.error.code,
              message: res.error.message,
              retryable: res.error.retryable,
            }
          : undefined;
        return {
          invocationId: res.invocationId,
          status,
          data,
          rawText,
          usage,
          error,
        };
      },
    },
    step: async <T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T> => {
      assertActive(ctx);
      if (isInternal) {
        return (ctx as TaskContext).step(stepKey, inputHash, fn);
      }
      return (ctx as SdkTaskContext).step.run(stepKey, inputHash, fn);
    },
    getCheckpoint: async (stepKey: string): Promise<StepCheckpointRecord | null> => {
      assertActive(ctx);
      if (isInternal) {
        return (ctx as TaskContext).getCheckpoint(stepKey);
      }
      const peeked = await (ctx as SdkTaskContext).step.peek(stepKey);
      if (!peeked) return null;
      return {
        stepKey: peeked.stepKey,
        inputHash: peeked.inputHash,
        output: null,
        savedAt: new Date().toISOString(),
      };
    },
  };
}

/**
 * Dual task handler type: can be invoked with just (ctx: SdkTaskContext) by the SDK runner,
 * or with (ctx, payload) by direct test callers.
 */
export type DualTaskHandler = (
  ctx: SdkTaskContext | TaskContext,
  payload?: Record<string, unknown>
) => Promise<TaskDisposition>;

/**
 * Handlers dictionary for all handler kinds declared in documentCoreManifest.
 * Manifest handlerKinds: ['root', 'ingest', 'extract', 'analyze', 'transform', 'generate', 'compare']
 */
export const documentCoreHandlers: Record<string, DualTaskHandler> = {
  // Root: entrypoint dispatcher delegating to the appropriate action handler based on ctx.action
  root: async (ctx, payload) => {
    const payloadAction = payload && typeof payload === 'object' && 'action' in payload && typeof payload.action === 'string'
      ? payload.action
      : undefined;
    const action = (ctx as SdkTaskContext).action || payloadAction;
    if (!action || action === 'root') {
      throw new Error(`Invalid or unspecified action for document-core root handler: "${action}"`);
    }
    const targetHandler = documentCoreHandlers[action];
    if (!targetHandler) {
      throw new Error(`No registered handler for action: "${action}"`);
    }
    return targetHandler(ctx, payload);
  },

  // 1. Ingest
  ingest: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = IngestAction.validateInput(inputPayload);
    const recipe = IngestAction.selectRecipe(input);
    const sources = await IngestAction.prepareSources(internalCtx, input);
    const result = await IngestAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = IngestAction.validateResult(result, input.mode);
    assertActive(ctx);
    const envelope = IngestAction.formatResult(internalCtx, validated, input.outputFormat);

    const artifact = await writeEnvelopeArtifact(internalCtx, envelope, 'ingest_result.json');

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 2. Extract
  extract: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = ExtractAction.validateInput(inputPayload);
    const recipe = ExtractAction.selectRecipe(input);
    const sources = await ExtractAction.prepareSources(internalCtx, input);
    const result = await ExtractAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = ExtractAction.validateResult(result, input.type, input.schema);
    assertActive(ctx);
    const envelope = ExtractAction.formatResult(internalCtx, validated, input.outputFormat);

    const artifact = await writeEnvelopeArtifact(internalCtx, envelope, 'extract_result.json');

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 3. Analyze
  analyze: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = AnalyzeAction.validateInput(inputPayload);
    const recipe = AnalyzeAction.selectRecipe(input);
    const sources = await AnalyzeAction.prepareSources(internalCtx, input);
    const result = await AnalyzeAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = AnalyzeAction.validateResult(result, input.task);
    assertActive(ctx);
    const envelope = AnalyzeAction.formatResult(internalCtx, validated);

    const artifact = await writeEnvelopeArtifact(internalCtx, envelope, 'analyze_result.json');

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 4. Transform
  transform: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = TransformAction.validateInput(inputPayload);
    const recipe = TransformAction.selectRecipe(input);
    const sources = await TransformAction.prepareSources(internalCtx, input);
    const result = await TransformAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = TransformAction.validateResult(result, input.variant);
    assertActive(ctx);
    const envelope = TransformAction.formatResult(internalCtx, validated, input.outputFormat);

    const artifact = await writeEnvelopeArtifact(internalCtx, envelope, 'transform_result.json');

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 5. Generate
  generate: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = GenerateAction.validateInput(inputPayload);
    const recipe = GenerateAction.selectRecipe(input);
    const sources = await GenerateAction.prepareSources(internalCtx, input);
    const result = await GenerateAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = GenerateAction.validateResult(result, input.task);
    assertActive(ctx);
    const envelope = GenerateAction.formatResult(internalCtx, validated);

    const artifact = await writeEnvelopeArtifact(internalCtx, envelope, 'generate_result.json');

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },

  // 6. Compare
  compare: async (ctx, payload) => {
    assertActive(ctx);
    const internalCtx = toInternalContext(ctx);
    const inputPayload = payload ?? (ctx as SdkTaskContext).input ?? {};
    const input = CompareAction.validateInput(inputPayload);
    const recipe = CompareAction.selectRecipe(input);
    const sources = await CompareAction.prepareSources(internalCtx, input);
    const result = await CompareAction.executeRecipe(internalCtx, recipe, input, sources);
    const validated = CompareAction.validateResult(result, input.mode);
    assertActive(ctx);
    const envelope = CompareAction.formatResult(internalCtx, validated, input.outputFormat);

    const artifact = await writeEnvelopeArtifact(internalCtx, envelope, 'compare_result.json');

    assertActive(ctx);
    return {
      kind: 'completed',
      resultRef: `artifact://${artifact.artifactId}`,
    };
  },
};

/**
 * Validated BusinessDefinition created via worker-sdk defineBusiness().
 * Validates manifest schema and strictly cross-checks declared handler kinds (REG-04).
 */
export const documentCoreBusinessDefinition: BusinessDefinition = defineBusiness(
  documentCoreManifest,
  documentCoreHandlers as Record<string, TaskHandler>
);

export interface DocumentCoreWorkerConfig extends WorkerConfig {
  consumer?: QueueConsumer;
}

/**
 * Owned worker entrypoint starting the document-core worker.
 */
export async function startDocumentCoreWorker(
  config: DocumentCoreWorkerConfig
): Promise<WorkerHandle> {
  return startWorker(documentCoreBusinessDefinition, config);
}
