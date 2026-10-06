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
import {
  ArtifactPurpose,
  TaskDisposition,
  InvocationResponse,
  CONNECTOR_ARTIFACT_MAX_BYTES,
  InvocationArtifactContent,
  type PinnedProfilePolicy,
  type PinnedPromptOverride,
} from '@du/contracts';
import { DocumentFormatDetector } from '@du/document-kit';
import { documentCoreManifest } from './manifest/document-core.manifest';
import { STEP_KEYS } from './recipes/step-keys';
import {
  ArtifactReadResult,
  ArtifactRef,
  ArtifactStat,
  ArtifactReadStreamOptions,
  ConnectorInvocationResult,
  TaskContext,
  StepCheckpointRecord,
} from './types/context';
import { IngestAction } from './actions/ingest';
import { ExtractAction } from './actions/extract';
import { AnalyzeAction } from './actions/analyze';
import { TransformAction } from './actions/transform';
import { GenerateAction } from './actions/generate';
import { CompareAction } from './actions/compare';
import { applyPinnedStepPrompt, type PinnedPromptView } from './actions/prompt-application';
import {
  advanceDisbursement,
  buildApprovalEvidence,
  DISBURSEMENT_STEP_IDS,
  normalizeDisbursementInput,
  DISBURSEMENT_INPUT_VERSION,
  DISBURSEMENT_RESUME_VERSION,
  type CrosscheckResult,
  type DisbursementInput,
  type DisbursementState,
  type ExtractedRecord,
  type LogicalDocument,
} from './pipelines/workflows/disbursement';
import {
  advanceDocCompare,
  createDocCompareRuntime,
  DEFAULT_DOC_COMPARE_BINDING,
  DOC_COMPARE_BUSINESS_ID,
  DOC_COMPARE_EVIDENCE_VERSION,
  DOC_COMPARE_INPUT_VERSION,
  DOC_COMPARE_RESUME_VERSION,
  DOC_COMPARE_RESULT_VERSION,
  DOC_COMPARE_STATE_VERSION,
  DocCompareError,
  MAX_CHUNK_FANOUT_CONCURRENCY,
  mergeChunkEvidence,
  normalizeDocCompareInput,
  type ChunkJoinSubmission,
  type ChunkOutcome,
  type ChunkTaskSpec,
  type DocCompareConnectorPort,
  type DocCompareInput,
  type DocCompareRuntime,
  type DocCompareStage,
  type DocCompareState,
} from './pipelines/workflows/doc-compare';

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
    readWithMetadata?: (artifactId: string, options?: { signal?: AbortSignal }) => Promise<
      | ArtifactReadResult
      | {
          buffer: Buffer;
          filename?: string;
          mimeType?: string;
          sizeBytes: number;
          sha256: string;
          storageVersionId?: string;
          grantExpiresAt?: string;
        }
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
    stat?(artifactId: string, options?: { signal?: AbortSignal }): Promise<ArtifactStat>;
    readStream?(artifactId: string, options?: ArtifactReadStreamOptions): Promise<Readable>;
  };

  const crypto = taskCrypto(ctx);
  // P730-SDK-CONSUME (W1b): forward the pinned admission snapshot the SDK
  // claim carried. Spread-guard (like crypto above) so internal/test contexts
  // that never had a pin keep their existing shape; a null profilePolicy is
  // FORWARDED as null (admitted-without-policy), only undefined is omitted.
  const pin: {
    profileRevision?: number;
    promptRevisions?: Readonly<Record<string, string>>;
    profilePolicy?: PinnedProfilePolicy | null;
    promptOverrides?: readonly PinnedPromptOverride[] | null;
    connectorBindings?: Readonly<Record<string, string>>;
  } = {};
  const sdkCtx = ctx as SdkTaskContext;
  if (sdkCtx.profileRevision !== undefined) pin.profileRevision = sdkCtx.profileRevision;
  if (sdkCtx.promptRevisions !== undefined) pin.promptRevisions = sdkCtx.promptRevisions;
  if (sdkCtx.profilePolicy !== undefined) pin.profilePolicy = sdkCtx.profilePolicy;
  // P745-CARRIER-IMPL-B2 (T6): forward the pinned prompt CONTENT rows with the
  // same !== undefined guard as the fields above, so a context that never
  // carried the field (pre-B1 wire shape) keeps its old shape. null is
  // FORWARDED as null (no carrier), never coalesced.
  if (sdkCtx.promptOverrides !== undefined) pin.promptOverrides = sdkCtx.promptOverrides;
  if (sdkCtx.connectorBindings !== undefined) pin.connectorBindings = sdkCtx.connectorBindings;
  // P745-CARRIER-IMPL-B2 (T7): view of the pinned prompt carrier for the
  // adapter's final-text substitution (Δ-B2-2). Built from the SAME `pin` the
  // context exposes, so adapter and action consumers cannot disagree.
  const promptView: PinnedPromptView = {
    promptOverrides: pin.promptOverrides,
    profilePolicy: pin.profilePolicy,
    connectorBindings: pin.connectorBindings,
  };
  return {
    taskId: ctx.taskId,
    operationId: ctx.operationId,
    businessId: ctx.businessId,
    businessVersion: ctx.businessVersion,
    tenantId: ctx.tenantId,
    // Undefined when the worker runs without a seam: encryption is opt-in, and
    // every consumer below falls back to the plaintext behaviour in that case.
    ...(crypto ? { crypto } : {}),
    ...pin,
    signal: ctx.signal,
    deadlineAt: 'deadlineAt' in ctx ? ctx.deadlineAt : undefined,
    cancelRequested: 'cancelRequested' in ctx ? ctx.cancelRequested : undefined,
    artifacts: {
      read: (id) => {
        assertActive(ctx);
        return artifactFacade.read(id);
      },
      readWithMetadata: async (id, options) => {
        assertActive(ctx);
        if (artifactFacade.readWithMetadata) {
          const readResult = await artifactFacade.readWithMetadata(id, options);
          assertActive(ctx);
          if (isInternal) return readResult as ArtifactReadResult;

          const sdkRead = readResult as {
            buffer: Buffer;
            filename?: string;
            mimeType?: string;
            sizeBytes: number;
            sha256: string;
            storageVersionId?: string;
            grantExpiresAt?: string;
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
            ...(sdkRead.storageVersionId && sdkRead.grantExpiresAt
              ? {
                identity: {
                  storageVersionId: sdkRead.storageVersionId,
                  grantExpiresAt: sdkRead.grantExpiresAt,
                  sizeBytes: sdkRead.sizeBytes,
                  sha256: sdkRead.sha256,
                },
              }
              : {}),
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
        ? async (artifactId, options) => {
            assertActive(ctx);
            const descriptor = await artifactFacade.stat!(artifactId, options);
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
        let input: {
          prompt?: string;
          text?: string;
          task?: string;
          language?: string;
          artifacts?: import('@du/contracts').InvocationArtifactContent[];
          outputSchema?: Record<string, unknown>;
        };
        if (typeof promptOrPayload === 'string') {
          input = { prompt: promptOrPayload };
        } else {
          const obj = promptOrPayload as Record<string, unknown>;
          const payloadObj = (obj['payload'] && typeof obj['payload'] === 'object') ? (obj['payload'] as Record<string, unknown>) : undefined;
          const extractedText = typeof obj['text'] === 'string'
            ? obj['text']
            : (payloadObj && typeof payloadObj['documentSnippet'] === 'string' ? (payloadObj['documentSnippet'] as string) : undefined);
          const assembledPromptText = typeof obj['prompt'] === 'string'
            ? (obj['prompt'] as string)
            : (typeof obj['task'] === 'string'
                ? `${obj['task']}: ${payloadObj && typeof payloadObj['promptText'] === 'string' ? payloadObj['promptText'] : JSON.stringify(obj['payload'] ?? '')}`
                : JSON.stringify(obj));
          // P745-CARRIER-IMPL-B2 (T7, Δ-B2-2): substitute the pinned step prompt
          // for the assembled text (PC-2(a)). The caller must declare the stepId;
          // without it the adapter SKIPs and the assembled text is used as-is.
          const promptText =
            options && typeof options.promptStepId === 'string' && options.promptStepId.trim().length > 0
              ? applyPinnedStepPrompt(promptView, {
                  slot,
                  stepId: options.promptStepId,
                  defaultText: assembledPromptText,
                })
              : assembledPromptText;

          const rawSchema = obj['outputSchema'] || obj['jsonSchema'] || payloadObj?.['schema'];
          input = {
            prompt: promptText,
            text: extractedText,
            task: typeof obj['task'] === 'string' ? obj['task'] : undefined,
            language: typeof obj['language'] === 'string' ? obj['language'] : undefined,
            outputSchema: rawSchema && typeof rawSchema === 'object'
              ? (rawSchema as Record<string, unknown>)
              : undefined,
            artifacts: Array.isArray(obj['artifacts'])
              ? (obj['artifacts'] as import('@du/contracts').InvocationArtifactContent[])
              : undefined,
          };
        }

        let res: InvocationResponse;
        try {
          // P745-SESSION-CONSUME: the caller's continuation session is passed
          // through as the SDK's 4th arg (invokeOpts), so sessionRef lands on
          // the wire AND inside the canonical inputHash. Omitted when the
          // caller passes none -> the pre-P745 single-shot call is unchanged.
          const invokeOpts =
            options && options.sessionRef !== undefined
              ? { sessionRef: options.sessionRef }
              : undefined;
          // Adapter metadata is consumed locally; strict provider options must
          // not receive promptStepId or the top-level continuation session.
          const providerOptions = options ? { ...options } : undefined;
          if (providerOptions) {
            delete providerOptions.promptStepId;
            delete providerOptions.sessionRef;
          }
          res = await (ctx as SdkTaskContext).connector.invoke(
            slot,
            input,
            providerOptions && Object.keys(providerOptions).length > 0 ? providerOptions : undefined,
            invokeOpts
          );
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
          // P745-SESSION-CONSUME: surface the provider-offered session so a
          // step declaring `captureSession` can persist it for a later step.
          sessionRef: res.result?.sessionRef ?? null,
        };
      },
    },
    step: async <T>(
      stepKey: string,
      inputHash: string,
      fn: () => Promise<T>,
      options?: { sessionRef?: string | null }
    ): Promise<T> => {
      assertActive(ctx);
      if (isInternal) {
        return (ctx as TaskContext).step(stepKey, inputHash, fn, options);
      }
      return (ctx as SdkTaskContext).step.run(stepKey, inputHash, fn, options);
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
        // P745-SESSION-CONSUME (CR06-03): surface the checkpoint row's stored
        // sessionRef so the slot/inject resolver can read it without executing
        // the step. Additive field; null when the row carried none.
        sessionRef: peeked.sessionRef ?? null,
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

type DisbursementChildStage = 'classify' | 'extract';
type DisbursementCheckpointStage = DisbursementChildStage | 'approval';
type DisbursementSnapshot = { input: DisbursementInput; state: DisbursementState };

const DISBURSEMENT_REQUIRED_SLOTS = ['classify', 'extract', 'crosscheck', 'report'] as const;
const DISBURSEMENT_CHILD_MARKER = '__disbursementChild';
const DISBURSEMENT_CHILD_RESULT_VERSION = 'disbursement-child-result-v1';
const DISBURSEMENT_STATE_STEP_PREFIX = 'disbursement:workflow-state:';
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function disbursementFailure(code: string, message: string): BusinessExecutionError {
  return new BusinessExecutionError(message, code, false);
}

function validateDisbursementInput(raw: unknown): DisbursementInput {
  if (!isRecord(raw)) {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'Disbursement input must be an object.');
  }

  // Run the workflow's identity/version guard before checking allowed fields so a
  // caller-provided identity is rejected explicitly and never used for routing.
  const normalized = normalizeDisbursementInput(raw);
  const allowed = new Set([
    'inputVersion',
    'artifactIds',
    'fileNames',
    'referenceData',
    'maxConcurrency',
    'failurePolicy',
    'requireEncryptedEvidence',
  ]);
  if (Object.keys(raw).some((key) => !allowed.has(key))) {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'Disbursement input contains an unsupported field.');
  }
  if (raw.inputVersion !== DISBURSEMENT_INPUT_VERSION) {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'Disbursement input version is unsupported.');
  }
  if (
    !Array.isArray(raw.artifactIds) ||
    raw.artifactIds.length < 1 ||
    raw.artifactIds.length > 20 ||
    !raw.artifactIds.every((value) => typeof value === 'string' && ARTIFACT_ID_PATTERN.test(value))
  ) {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'Disbursement requires 1 to 20 valid artifact IDs.');
  }
  if (
    !Array.isArray(raw.fileNames) ||
    raw.fileNames.length !== raw.artifactIds.length ||
    !raw.fileNames.every((value) => typeof value === 'string' && value.trim().length > 0 && value.length <= 255)
  ) {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'Disbursement file names must match the artifact list.');
  }
  if (new Set(raw.fileNames).size !== raw.fileNames.length || new Set(raw.artifactIds).size !== raw.artifactIds.length) {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'Disbursement artifacts and file names must be unique.');
  }
  if (
    raw.maxConcurrency !== undefined &&
    (!Number.isInteger(raw.maxConcurrency) || (raw.maxConcurrency as number) < 1 || (raw.maxConcurrency as number) > 8)
  ) {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'maxConcurrency must be an integer from 1 to 8.');
  }
  if (raw.requireEncryptedEvidence !== undefined && typeof raw.requireEncryptedEvidence !== 'boolean') {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'requireEncryptedEvidence must be a boolean.');
  }
  if (
    raw.referenceData !== undefined &&
    (!Array.isArray(raw.referenceData) ||
      !raw.referenceData.every(
        (datum) =>
          isRecord(datum) &&
          Object.keys(datum).length === 2 &&
          typeof datum.key === 'string' &&
          datum.key.trim().length > 0 &&
          Object.prototype.hasOwnProperty.call(datum, 'expected')
      ))
  ) {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'referenceData entries require key and expected values.');
  }
  return normalized;
}

function requireDisbursementSdkContext(ctx: SdkTaskContext | TaskContext): SdkTaskContext {
  const sdk = ctx as SdkTaskContext;
  if (
    !sdk.spawn || typeof sdk.spawn.spawnAndWait !== 'function' ||
    !sdk.wait || typeof sdk.wait.waitForInput !== 'function' ||
    !sdk.step || typeof sdk.step.run !== 'function' ||
    !sdk.connector || typeof sdk.connector.invoke !== 'function' ||
    !sdk.artifacts || typeof sdk.artifacts.write !== 'function' ||
    typeof sdk.checkpoints !== 'function'
  ) {
    throw disbursementFailure(
      'DISBURSEMENT_RUNTIME_UNAVAILABLE',
      'The disbursement handler requires the workflow continuation runtime.'
    );
  }
  return sdk;
}

function assertRequiredDisbursementSlots(ctx: SdkTaskContext): void {
  for (const slot of DISBURSEMENT_REQUIRED_SLOTS) {
    if (typeof ctx.connectorBindings?.[slot] !== 'string' || ctx.connectorBindings[slot]!.trim().length === 0) {
      throw disbursementFailure('DISBURSEMENT_CONNECTOR_SLOT_MISSING', `Required connector slot "${slot}" is not bound.`);
    }
  }
}

function disbursementStateStepKey(stage: DisbursementCheckpointStage): string {
  return `${DISBURSEMENT_STATE_STEP_PREFIX}${stage}`;
}

function stableJsonHash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

async function saveDisbursementState(
  internal: StreamingTaskContext,
  stage: DisbursementCheckpointStage,
  input: DisbursementInput,
  state: DisbursementState
): Promise<void> {
  const snapshot: DisbursementSnapshot = { input, state };
  const key = disbursementStateStepKey(stage);
  await internal.step(key, stableJsonHash(snapshot), async () => snapshot);
}

async function loadDisbursementState(
  ctx: SdkTaskContext,
  stage: DisbursementCheckpointStage
): Promise<DisbursementSnapshot> {
  const stepKey = disbursementStateStepKey(stage);
  const checkpoint = ctx.checkpoints().find((entry) => entry.stepKey === stepKey && entry.status === 'SUCCEEDED');
  if (!checkpoint) {
    throw disbursementFailure('DISBURSEMENT_STATE_MISSING', `Saved workflow state for "${stage}" is unavailable.`);
  }
  const snapshot = await ctx.step.run<unknown>(stepKey, checkpoint.inputHash, async () => {
    throw disbursementFailure('DISBURSEMENT_STATE_MISSING', `Saved workflow state for "${stage}" could not be replayed.`);
  });
  if (
    !isRecord(snapshot) ||
    !isRecord(snapshot.input) ||
    !isRecord(snapshot.state) ||
    snapshot.input.inputVersion !== DISBURSEMENT_INPUT_VERSION ||
    snapshot.state.inputVersion !== DISBURSEMENT_INPUT_VERSION ||
    !Array.isArray(snapshot.state.completedStages) ||
    !Array.isArray(snapshot.state.classifications) ||
    !Array.isArray(snapshot.state.records) ||
    !Array.isArray(snapshot.state.childResults)
  ) {
    throw disbursementFailure('DISBURSEMENT_STATE_INVALID', 'Saved disbursement workflow state is malformed.');
  }
  return snapshot as unknown as DisbursementSnapshot;
}

function parseDisbursementContinuationRef(value: unknown): { stage: DisbursementChildStage; joinToken: string } {
  if (typeof value !== 'string') {
    throw disbursementFailure('DISBURSEMENT_CONTINUATION_INVALID', 'Child join continuation reference is missing.');
  }
  const match = /^disbursement:v1:(classify|extract):([^:]+)$/.exec(value);
  if (!match || !match[1] || !match[2]) {
    throw disbursementFailure('DISBURSEMENT_CONTINUATION_INVALID', 'Child join continuation reference is malformed.');
  }
  return { stage: match[1] as DisbursementChildStage, joinToken: match[2] };
}

function expectedDisbursementChildren(
  stage: DisbursementChildStage,
  input: DisbursementInput
): { childId: string; fileName: string; artifactId: string }[] {
  return input.artifactIds.map((artifactId, index) => {
    const fileName = input.fileNames[index] ?? artifactId;
    return { childId: `${stage}:${fileName}`, fileName, artifactId };
  });
}

async function buildDisbursementJoin(
  internal: StreamingTaskContext,
  stage: DisbursementChildStage,
  token: string,
  summary: unknown,
  input: DisbursementInput
): Promise<{ joinToken: string; results: { childId: string; status: 'succeeded'; payload: unknown }[] }> {
  if (!isRecord(summary)) {
    throw disbursementFailure('DISBURSEMENT_CHILD_RESULT_MISSING', 'Joined child results are missing.');
  }
  const children = expectedDisbursementChildren(stage, input);
  if (Object.keys(summary).length !== children.length) {
    throw disbursementFailure('DISBURSEMENT_CHILD_RESULT_MISSING', 'Joined child result count does not match the input artifacts.');
  }
  const results: { childId: string; status: 'succeeded'; payload: unknown }[] = [];
  for (const child of children) {
    const resultRef = summary[child.childId];
    if (typeof resultRef !== 'string') {
      throw disbursementFailure('DISBURSEMENT_CHILD_RESULT_MISSING', `Child evidence for "${child.childId}" is missing.`);
    }
    const resultId = /^artifact:\/\/([0-9a-f-]{36})$/i.exec(resultRef)?.[1];
    if (!resultId) {
      throw disbursementFailure('DISBURSEMENT_CHILD_RESULT_INVALID', `Child evidence for "${child.childId}" has an invalid reference.`);
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse((await internal.artifacts.read(resultId)).toString('utf8'));
    } catch {
      throw disbursementFailure('DISBURSEMENT_CHILD_RESULT_INVALID', `Child evidence for "${child.childId}" could not be read.`);
    }
    if (
      !isRecord(envelope) ||
      envelope.schemaVersion !== DISBURSEMENT_CHILD_RESULT_VERSION ||
      envelope.childId !== child.childId ||
      envelope.stage !== stage ||
      !isRecord(envelope.payload)
    ) {
      throw disbursementFailure('DISBURSEMENT_CHILD_RESULT_INVALID', `Child evidence for "${child.childId}" is malformed or mismatched.`);
    }
    results.push({ childId: child.childId, status: 'succeeded', payload: envelope.payload });
  }
  return { joinToken: token, results };
}

function requireChildTask(raw: unknown, sdk: SdkTaskContext): {
  stage: DisbursementChildStage;
  childId: string;
  input: Record<string, unknown>;
} | undefined {
  if (!isRecord(raw) || !Object.prototype.hasOwnProperty.call(raw, DISBURSEMENT_CHILD_MARKER)) return undefined;
  const child = raw[DISBURSEMENT_CHILD_MARKER];
  if (
    !isRecord(child) ||
    (child.stage !== 'classify' && child.stage !== 'extract') ||
    typeof child.childId !== 'string' ||
    !child.childId.startsWith(`${child.stage}:`) ||
    child.childId !== sdk.taskKey ||
    !isRecord(child.input)
  ) {
    throw disbursementFailure('DISBURSEMENT_CHILD_INPUT_INVALID', 'Disbursement child task payload is malformed.');
  }
  return { stage: child.stage, childId: child.childId, input: child.input };
}

async function readDisbursementConnectorArtifact(
  internal: StreamingTaskContext,
  rawArtifactId: unknown,
  rawFileName: unknown
): Promise<InvocationArtifactContent> {
  if (
    typeof rawArtifactId !== 'string' ||
    !ARTIFACT_ID_PATTERN.test(rawArtifactId) ||
    typeof rawFileName !== 'string' ||
    rawFileName.trim().length === 0 ||
    rawFileName.length > 255
  ) {
    throw disbursementFailure('DISBURSEMENT_EVIDENCE_MISSING', 'Disbursement source artifact reference is invalid.');
  }
  let source: ArtifactReadResult;
  try {
    if (!internal.artifacts.readWithMetadata) {
      throw new Error('artifact metadata reads are unavailable');
    }
    source = await internal.artifacts.readWithMetadata(rawArtifactId);
  } catch {
    throw disbursementFailure('DISBURSEMENT_EVIDENCE_MISSING', 'Disbursement source artifact could not be read.');
  }
  const identity = source.identity;
  const sha256 = createHash('sha256').update(source.buffer).digest('hex');
  const mimeType = source.formatMetadata.canonicalMimeType;
  if (
    !identity ||
    identity.storageVersionId.trim().length === 0 ||
    !Number.isFinite(Date.parse(identity.grantExpiresAt)) ||
    Date.parse(identity.grantExpiresAt) <= Date.now() ||
    identity.sizeBytes !== source.buffer.byteLength ||
    source.buffer.byteLength < 1 ||
    source.buffer.byteLength > CONNECTOR_ARTIFACT_MAX_BYTES ||
    identity.sha256 !== sha256 ||
    !/^[a-f0-9]{64}$/.test(identity.sha256) ||
    !/^[A-Za-z0-9!#$&^_.+-]+\/[A-Za-z0-9!#$&^_.+-]+$/.test(mimeType)
  ) {
    throw disbursementFailure('DISBURSEMENT_EVIDENCE_INVALID', 'Disbursement source artifact integrity metadata is invalid.');
  }
  return {
    artifactId: rawArtifactId,
    fileName: rawFileName,
    mimeType,
    sizeBytes: source.buffer.byteLength,
    sha256,
    storageVersionId: identity.storageVersionId,
    contentBase64: source.buffer.toString('base64'),
  };
}

function connectorResponseData(result: ConnectorInvocationResult, stage: string): unknown {
  if (result.status !== 'SUCCESS' || result.error) {
    if (result.error?.code === 'INVOCATION_UNKNOWN') {
      throw disbursementFailure('INVOCATION_UNKNOWN', `Connector outcome for disbursement ${stage} is unknown; no result was accepted.`);
    }
    throw disbursementFailure('DISBURSEMENT_CONNECTOR_FAILED', `Connector invocation for disbursement ${stage} failed.`);
  }
  if (result.data !== undefined) return result.data;
  if (typeof result.rawText === 'string' && result.rawText.trim().length > 0) {
    try {
      return JSON.parse(result.rawText);
    } catch {
      if (stage === 'report') return result.rawText;
    }
  }
  throw disbursementFailure('DISBURSEMENT_CONNECTOR_OUTPUT_INVALID', `Connector output for disbursement ${stage} is missing.`);
}

function parseLogicalDocuments(value: unknown, fileName: string): readonly LogicalDocument[] {
  const rows = isRecord(value) ? value.logicalDocuments : undefined;
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (row) =>
        isRecord(row) &&
        typeof row.label === 'string' && row.label.trim().length > 0 &&
        row.sourceFile === fileName &&
        typeof row.category === 'string' && row.category.trim().length > 0 &&
        typeof row.confidence === 'number' && Number.isFinite(row.confidence) && row.confidence >= 0 && row.confidence <= 1
    )
  ) {
    throw disbursementFailure('DISBURSEMENT_CONNECTOR_OUTPUT_INVALID', 'Classification response does not contain valid document evidence.');
  }
  return rows as LogicalDocument[];
}

function parseExtractedRecords(value: unknown, fileName: string, logicalDocuments: readonly LogicalDocument[]): readonly ExtractedRecord[] {
  const rows = isRecord(value) ? value.records : undefined;
  const allowedLabels = new Set(logicalDocuments.map((document) => document.label));
  if (
    !Array.isArray(rows) ||
    !rows.every(
      (row) =>
        isRecord(row) &&
        row.fileName === fileName &&
        Array.isArray(row.logicalDocumentLabels) &&
        row.logicalDocumentLabels.length > 0 &&
        row.logicalDocumentLabels.every((label) => typeof label === 'string' && allowedLabels.has(label)) &&
        isRecord(row.fields)
    )
  ) {
    throw disbursementFailure('DISBURSEMENT_CONNECTOR_OUTPUT_INVALID', 'Extraction response does not contain valid document evidence.');
  }
  return rows as ExtractedRecord[];
}

function parseCrosscheck(value: unknown): CrosscheckResult {
  if (
    !isRecord(value) ||
    !Array.isArray(value.findings) ||
    typeof value.matchedCount !== 'number' ||
    !Number.isInteger(value.matchedCount) ||
    typeof value.mismatchedCount !== 'number' ||
    !Number.isInteger(value.mismatchedCount) ||
    value.matchedCount < 0 ||
    value.mismatchedCount < 0 ||
    !value.findings.every(
      (finding) =>
        isRecord(finding) &&
        typeof finding.key === 'string' && finding.key.trim().length > 0 &&
        (finding.status === 'match' || finding.status === 'mismatch' || finding.status === 'unresolved') &&
        typeof finding.detail === 'string'
    )
  ) {
    throw disbursementFailure('DISBURSEMENT_CONNECTOR_OUTPUT_INVALID', 'Cross-check response is malformed.');
  }
  const matchedCount = value.matchedCount as number;
  const mismatchedCount = value.mismatchedCount as number;
  const matched = value.findings.filter((finding) => isRecord(finding) && finding.status === 'match').length;
  const mismatched = value.findings.filter((finding) => isRecord(finding) && finding.status === 'mismatch').length;
  if (matched !== matchedCount || mismatched !== mismatchedCount) {
    throw disbursementFailure('DISBURSEMENT_CONNECTOR_OUTPUT_INVALID', 'Cross-check counts do not match the returned findings.');
  }
  return value as unknown as CrosscheckResult;
}

function createDisbursementRuntime(
  ctx: SdkTaskContext | TaskContext,
  internal: StreamingTaskContext
) {
  const invokeJson = async (
    slot: string,
    stepName: string,
    task: string,
    prompt: string,
    payload: Record<string, unknown>,
    outputSchema: Record<string, unknown>,
    promptStepId: string
  ): Promise<unknown> => {
    const hash = stableJsonHash({ slot, task, payload });
    const result = await internal.step(`disbursement:connector:${stepName}`, hash, async () =>
      internal.connector.invoke(slot as 'reasoning', {
        task,
        prompt,
        ...payload,
        outputSchema,
      }, { responseFormat: 'json', jsonSchema: outputSchema, promptStepId })
    );
    return connectorResponseData(result, stepName);
  };

  return {
    encryptionAvailable: taskCrypto(ctx) !== undefined,
    step: internal.step,
    ports: {
      classifyFile: async (request: { artifactId: string; fileName: string }) => {
        const artifact = await readDisbursementConnectorArtifact(internal, request.artifactId, request.fileName);
        const response = await invokeJson(
          'classify',
          `classify:${stableJsonHash(request).slice(0, 20)}`,
          'disbursement_classify',
          `Classify the supplied source file. Return logicalDocuments with label, sourceFile (exactly ${request.fileName}), category, and confidence from 0 to 1.`,
          { artifacts: [artifact] },
          {
            type: 'object',
            properties: {
              logicalDocuments: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    label: { type: 'string', minLength: 1 },
                    sourceFile: { type: 'string', const: request.fileName },
                    category: { type: 'string', minLength: 1 },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                  },
                  required: ['label', 'sourceFile', 'category', 'confidence'],
                  additionalProperties: false,
                },
              },
            },
            required: ['logicalDocuments'],
            additionalProperties: false,
          },
          STEP_KEYS.DISBURSEMENT.CLASSIFY
        );
        return parseLogicalDocuments(response, request.fileName);
      },
      extractFile: async (request: {
        artifactId: string;
        fileName: string;
        logicalDocuments: readonly LogicalDocument[];
      }) => {
        const artifact = await readDisbursementConnectorArtifact(internal, request.artifactId, request.fileName);
        const response = await invokeJson(
          'extract',
          `extract:${stableJsonHash({ fileName: request.fileName, labels: request.logicalDocuments.map((doc) => doc.label) }).slice(0, 20)}`,
          'disbursement_extract',
          `Extract records only for the classified logical documents. Every record must use fileName ${request.fileName} and labels from ${JSON.stringify(request.logicalDocuments.map((doc) => doc.label))}.`,
          { artifacts: [artifact], logicalDocuments: request.logicalDocuments },
          {
            type: 'object',
            properties: {
              records: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    fileName: { type: 'string', const: request.fileName },
                    logicalDocumentLabels: { type: 'array', items: { type: 'string' }, minItems: 1 },
                    fields: { type: 'object' },
                  },
                  required: ['fileName', 'logicalDocumentLabels', 'fields'],
                  additionalProperties: false,
                },
              },
            },
            required: ['records'],
            additionalProperties: false,
          },
          STEP_KEYS.DISBURSEMENT.EXTRACT
        );
        return parseExtractedRecords(response, request.fileName, request.logicalDocuments);
      },
      crosscheck: async (request: { records: readonly ExtractedRecord[]; referenceData: DisbursementInput['referenceData'] }) => {
        const response = await invokeJson(
          'crosscheck',
          `crosscheck:${stableJsonHash(request).slice(0, 20)}`,
          'disbursement_crosscheck',
          `Cross-check these extracted records against the supplied reference data: ${JSON.stringify(request)}`,
          {},
          {
            type: 'object',
            properties: {
              findings: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    key: { type: 'string', minLength: 1 },
                    status: { type: 'string', enum: ['match', 'mismatch', 'unresolved'] },
                    detail: { type: 'string' },
                  },
                  required: ['key', 'status', 'detail'],
                  additionalProperties: false,
                },
              },
              matchedCount: { type: 'integer', minimum: 0 },
              mismatchedCount: { type: 'integer', minimum: 0 },
            },
            required: ['findings', 'matchedCount', 'mismatchedCount'],
            additionalProperties: false,
          },
          STEP_KEYS.DISBURSEMENT.CROSSCHECK
        );
        return parseCrosscheck(response);
      },
      report: async (request: {
        classifications: readonly { fileName: string; logicalDocuments: readonly LogicalDocument[] }[];
        records: readonly ExtractedRecord[];
        crosscheck: CrosscheckResult;
      }) => {
        const hash = stableJsonHash(request);
        const result = await internal.step(`disbursement:connector:report:${hash.slice(0, 20)}`, hash, async () =>
          internal.connector.invoke('report' as 'reasoning', {
            task: 'disbursement_report',
            prompt: `Prepare a report only from this approved evidence: ${JSON.stringify(request)}`,
          }, { responseFormat: 'text', promptStepId: STEP_KEYS.DISBURSEMENT.REPORT })
        );
        const response = connectorResponseData(result, 'report');
        const report = typeof response === 'string' ? response : isRecord(response) ? response.report : undefined;
        if (typeof report !== 'string' || report.trim().length === 0) {
          throw disbursementFailure('DISBURSEMENT_CONNECTOR_OUTPUT_INVALID', 'Report connector returned no report evidence.');
        }
        return report;
      },
    },
  };
}

async function writeDisbursementChildResult(
  sdk: SdkTaskContext,
  stage: DisbursementChildStage,
  childId: string,
  payload: Record<string, unknown>
): Promise<TaskDisposition> {
  let artifact: ArtifactRef;
  try {
    artifact = await sdk.artifacts.write(
      JSON.stringify({ schemaVersion: DISBURSEMENT_CHILD_RESULT_VERSION, stage, childId, payload }),
      'disbursement-child-result.json',
      'application/json',
      'intermediate'
    );
  } catch {
    throw disbursementFailure('DISBURSEMENT_EVIDENCE_WRITE_FAILED', 'Disbursement child evidence could not be persisted.');
  }
  if (!ARTIFACT_ID_PATTERN.test(artifact.artifactId)) {
    throw disbursementFailure('DISBURSEMENT_EVIDENCE_WRITE_FAILED', 'Disbursement child evidence reference is invalid.');
  }
  return { kind: 'completed', resultRef: `artifact://${artifact.artifactId}` };
}

async function runDisbursementChild(
  ctx: SdkTaskContext | TaskContext,
  sdk: SdkTaskContext,
  internal: StreamingTaskContext,
  raw: unknown
): Promise<TaskDisposition> {
  const child = requireChildTask(raw, sdk);
  if (!child) throw disbursementFailure('DISBURSEMENT_CHILD_INPUT_INVALID', 'Disbursement child task payload is missing.');
  assertActive(ctx);
  const runtime = createDisbursementRuntime(ctx, internal);
  if (child.stage === 'classify') {
    const logicalDocuments = await runtime.ports.classifyFile({
      artifactId: String(child.input.artifactId ?? ''),
      fileName: String(child.input.fileName ?? ''),
    });
    assertActive(ctx);
    return writeDisbursementChildResult(sdk, child.stage, child.childId, {
      kind: 'classification',
      fileName: child.input.fileName,
      logicalDocuments,
    });
  }
  const rawDocuments = child.input.logicalDocuments;
  if (
    typeof child.input.artifactId !== 'string' ||
    typeof child.input.fileName !== 'string' ||
    !Array.isArray(rawDocuments) ||
    !rawDocuments.every((item) => isRecord(item))
  ) {
    throw disbursementFailure('DISBURSEMENT_CHILD_INPUT_INVALID', 'Extraction child input is incomplete.');
  }
  const records = await runtime.ports.extractFile({
    artifactId: child.input.artifactId,
    fileName: child.input.fileName,
    logicalDocuments: rawDocuments as unknown as LogicalDocument[],
  });
  assertActive(ctx);
  return writeDisbursementChildResult(sdk, child.stage, child.childId, {
    kind: 'extraction',
    fileName: child.input.fileName,
    records,
  });
}

function validateApprovalEvidence(input: DisbursementInput, state: DisbursementState): ReturnType<typeof buildApprovalEvidence> {
  const evidence = buildApprovalEvidence(state);
  if (
    state.completedStages.indexOf(DISBURSEMENT_STEP_IDS.classify) < 0 ||
    state.completedStages.indexOf(DISBURSEMENT_STEP_IDS.extract) < 0 ||
    evidence.filesAnalyzed !== input.artifactIds.length ||
    evidence.logicalDocumentCount < 1 ||
    evidence.extractedRecordCount < 1
  ) {
    throw disbursementFailure('DISBURSEMENT_EVIDENCE_MISSING', 'Approval cannot be requested without complete classified and extracted evidence.');
  }
  return evidence;
}

async function mapDisbursementContinuation(
  ctx: SdkTaskContext | TaskContext,
  sdk: SdkTaskContext,
  internal: StreamingTaskContext,
  input: DisbursementInput,
  step: Awaited<ReturnType<typeof advanceDisbursement>>
): Promise<TaskDisposition> {
  const continuation = step.continuation;
  if (continuation.kind === 'spawn-children') {
    if (continuation.stage !== 'classify' && continuation.stage !== 'extract') {
      throw disbursementFailure('DISBURSEMENT_CONTINUATION_INVALID', 'Unsupported child fan-out stage.');
    }
    await saveDisbursementState(internal, continuation.stage, input, step.state);
    const children = continuation.children.map((child) => ({
      taskKey: child.childId,
      kind: 'disbursement',
      payload: {
        [DISBURSEMENT_CHILD_MARKER]: {
          stage: child.stage,
          childId: child.childId,
          input: child.input,
        },
      },
    }));
    return sdk.spawn.spawnAndWait(
      children,
      'all-success',
      `disbursement:v1:${continuation.stage}:${continuation.joinToken}`
    );
  }
  if (continuation.kind === 'wait-for-input') {
    const evidence = validateApprovalEvidence(input, step.state);
    if (input.requireEncryptedEvidence && taskCrypto(ctx) === undefined) {
      throw disbursementFailure('ENCRYPTION_REQUIRED_UNAVAILABLE', 'Encrypted approval evidence is required but no crypto seam is configured.');
    }
    await saveDisbursementState(internal, 'approval', input, step.state);
    let evidenceArtifact: ArtifactRef;
    try {
      evidenceArtifact = await sdk.artifacts.write(
        JSON.stringify({ schemaVersion: 'disbursement-approval-evidence-v1', evidence, classifications: step.state.classifications, records: step.state.records }),
        'disbursement-approval-evidence.json',
        'application/json',
        'intermediate'
      );
    } catch {
      throw disbursementFailure('DISBURSEMENT_EVIDENCE_WRITE_FAILED', 'Approval evidence could not be persisted.');
    }
    if (!ARTIFACT_ID_PATTERN.test(evidenceArtifact.artifactId)) {
      throw disbursementFailure('DISBURSEMENT_EVIDENCE_WRITE_FAILED', 'Approval evidence reference is invalid.');
    }
    return sdk.wait.waitForInput(
      'disbursement-approval-v1',
      {
        type: 'object',
        properties: {
          resumeSchemaVersion: { type: 'string', const: DISBURSEMENT_RESUME_VERSION },
          approved: { type: 'boolean' },
          approvedBy: { type: 'string', maxLength: 256 },
          note: { type: 'string', maxLength: 4000 },
          corrections: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                fileName: { type: 'string', minLength: 1 },
                logicalDocumentLabel: { type: 'string', minLength: 1 },
                field: { type: 'string', minLength: 1 },
                value: {},
              },
              required: ['fileName', 'logicalDocumentLabel', 'field', 'value'],
              additionalProperties: false,
            },
          },
        },
        required: ['resumeSchemaVersion', 'approved'],
        additionalProperties: false,
      },
      { contextRef: `artifact://${evidenceArtifact.artifactId}` }
    );
  }

  if (continuation.terminal === 'FAILED') {
    throw disbursementFailure(
      continuation.failure?.code ?? 'DISBURSEMENT_FAILED',
      continuation.failure?.message ?? 'Disbursement workflow failed.'
    );
  }
  if (
    continuation.terminal !== 'SUCCEEDED' ||
    !continuation.data ||
    continuation.data.report.trim().length === 0 ||
    continuation.data.evidence.extractedRecordCount < 1
  ) {
    throw disbursementFailure('DISBURSEMENT_RESULT_INVALID', 'Disbursement workflow ended without complete report evidence.');
  }
  assertActive(ctx);
  let resultArtifact: ArtifactRef;
  try {
    resultArtifact = await sdk.artifacts.write(
      JSON.stringify(continuation.data),
      'disbursement-result.json',
      'application/json',
      'output'
    );
  } catch {
    throw disbursementFailure('DISBURSEMENT_RESULT_WRITE_FAILED', 'Disbursement result could not be persisted.');
  }
  if (!ARTIFACT_ID_PATTERN.test(resultArtifact.artifactId)) {
    throw disbursementFailure('DISBURSEMENT_RESULT_WRITE_FAILED', 'Disbursement result reference is invalid.');
  }
  assertActive(ctx);
  return { kind: 'completed', resultRef: `artifact://${resultArtifact.artifactId}` };
}

async function handleDisbursement(
  ctx: SdkTaskContext | TaskContext,
  payload?: Record<string, unknown>
): Promise<TaskDisposition> {
  assertActive(ctx);
  const sdk = requireDisbursementSdkContext(ctx);
  assertRequiredDisbursementSlots(sdk);
  const internal = toInternalContext(ctx);
  const raw = payload ?? sdk.input;

  if (requireChildTask(raw, sdk)) {
    return runDisbursementChild(ctx, sdk, internal, raw);
  }
  if (!isRecord(raw)) {
    throw disbursementFailure('DISBURSEMENT_INPUT_INVALID', 'Disbursement task input is missing.');
  }

  let input: DisbursementInput;
  let state: DisbursementState | undefined;
  let join: { joinToken: string; results: { childId: string; status: 'succeeded'; payload: unknown }[] } | undefined;
  let resume: unknown;

  if (Object.prototype.hasOwnProperty.call(raw, 'resumeInput')) {
    const snapshot = await loadDisbursementState(sdk, 'approval');
    input = snapshot.input;
    state = snapshot.state;
    resume = raw.resumeInput;
  } else if (Object.prototype.hasOwnProperty.call(raw, 'joinSummary') || raw.continuationRef !== undefined) {
    const reference = parseDisbursementContinuationRef(raw.continuationRef);
    const snapshot = await loadDisbursementState(sdk, reference.stage);
    if (snapshot.state.pendingJoinToken !== reference.joinToken) {
      throw disbursementFailure('DISBURSEMENT_CONTINUATION_INVALID', 'Join token does not match the saved workflow state.');
    }
    input = snapshot.input;
    state = snapshot.state;
    join = await buildDisbursementJoin(internal, reference.stage, reference.joinToken, raw.joinSummary, input);
  } else {
    input = validateDisbursementInput(raw);
  }

  const result = await advanceDisbursement({
    input,
    state,
    runtime: createDisbursementRuntime(ctx, internal),
    ...(join ? { join } : {}),
    ...(resume !== undefined ? { resume } : {}),
  });
  assertActive(ctx);
  return mapDisbursementContinuation(ctx, sdk, internal, input, result);
}

/* ------------------------------------------------------------------ */
/* doc-compare (P9-03 advanced two-document comparison)                */
/* ------------------------------------------------------------------ */

type DocCompareChunkStage = 'compare-structure' | 'compare-references';
type DocCompareCheckpointStage = DocCompareChunkStage | 'merge-evidence';
type DocCompareSnapshot = { input: DocCompareInput; state: DocCompareState };

const DOC_COMPARE_REQUIRED_SLOTS = ['reasoning'] as const;
const DOC_COMPARE_CHUNK_MARKER = '__docCompareChunk';
const DOC_COMPARE_CHUNK_RESULT_VERSION = 'doc-compare-chunk-result-v1';
const DOC_COMPARE_REVIEW_EVIDENCE_VERSION = 'doc-compare-review-evidence-v1';
const DOC_COMPARE_STATE_STEP_PREFIX = 'doc-compare:workflow-state:';
const DOC_COMPARE_SIDE_FIELDS = ['artifactId', 'fileName', 'text'] as const;
const DOC_COMPARE_INPUT_FIELDS = [
  'inputVersion',
  'left',
  'right',
  'maxChunkChars',
  'maxConcurrency',
  'continueOnPartialFailure',
  'requireHumanReview',
] as const;

function docCompareFailure(code: string, message: string): BusinessExecutionError {
  return new BusinessExecutionError(message, code, false);
}

function docCompareStateStepKey(stage: DocCompareCheckpointStage): string {
  return `${DOC_COMPARE_STATE_STEP_PREFIX}${stage}`;
}

function validateDocCompareSide(raw: unknown, side: 'left' | 'right'): void {
  if (!isRecord(raw)) {
    throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', `Doc-compare "${side}" must be an object.`);
  }
  // Rejected, not ignored: normalizeDocCompareInput derives sections from
  // `text`, so a caller-supplied outline would be accepted and then dropped,
  // leaving the caller believing its structure drove the comparison.
  if (Object.keys(raw).some((key) => !(DOC_COMPARE_SIDE_FIELDS as readonly string[]).includes(key))) {
    throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', `Doc-compare "${side}" contains an unsupported field.`);
  }
  for (const field of ['artifactId', 'fileName'] as const) {
    const value = raw[field];
    if (typeof value !== 'string' || value.trim().length === 0 || value.length > 255) {
      throw docCompareFailure(
        'DOC_COMPARE_INPUT_INVALID',
        `Doc-compare "${side}.${field}" must be a non-empty string of at most 255 characters.`
      );
    }
  }
  if (typeof raw.text !== 'string') {
    throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', `Doc-compare "${side}.text" must be a string.`);
  }
}

function validateDocCompareInput(raw: unknown): DocCompareInput {
  if (!isRecord(raw)) {
    throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', 'Doc-compare input must be an object.');
  }

  // The workflow's identity/version guard runs before the field allowlist so a
  // caller-provided identity is rejected explicitly and never used for routing.
  let normalized: DocCompareInput;
  try {
    normalized = normalizeDocCompareInput(raw);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Doc-compare input could not be normalized.';
    throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', message);
  }

  if (Object.keys(raw).some((key) => !(DOC_COMPARE_INPUT_FIELDS as readonly string[]).includes(key))) {
    throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', 'Doc-compare input contains an unsupported field.');
  }
  if (raw.inputVersion !== DOC_COMPARE_INPUT_VERSION) {
    throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', 'Doc-compare input version is unsupported.');
  }
  validateDocCompareSide(raw.left, 'left');
  validateDocCompareSide(raw.right, 'right');
  if (raw.maxChunkChars !== undefined && typeof raw.maxChunkChars !== 'number') {
    throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', 'maxChunkChars must be a number.');
  }
  if (
    raw.maxConcurrency !== undefined &&
    (!Number.isInteger(raw.maxConcurrency) ||
      (raw.maxConcurrency as number) < 1 ||
      (raw.maxConcurrency as number) > MAX_CHUNK_FANOUT_CONCURRENCY)
  ) {
    throw docCompareFailure(
      'DOC_COMPARE_INPUT_INVALID',
      `maxConcurrency must be an integer from 1 to ${MAX_CHUNK_FANOUT_CONCURRENCY}.`
    );
  }
  for (const flag of ['continueOnPartialFailure', 'requireHumanReview'] as const) {
    if (raw[flag] !== undefined && typeof raw[flag] !== 'boolean') {
      throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', `${flag} must be a boolean.`);
    }
  }
  return normalized;
}

function requireDocCompareSdkContext(ctx: SdkTaskContext | TaskContext): SdkTaskContext {
  const sdk = ctx as SdkTaskContext;
  if (
    !sdk.spawn || typeof sdk.spawn.spawnAndWait !== 'function' ||
    !sdk.wait || typeof sdk.wait.waitForInput !== 'function' ||
    !sdk.step || typeof sdk.step.run !== 'function' ||
    !sdk.connector || typeof sdk.connector.invoke !== 'function' ||
    !sdk.artifacts || typeof sdk.artifacts.write !== 'function' ||
    typeof sdk.checkpoints !== 'function'
  ) {
    throw docCompareFailure(
      'DOC_COMPARE_RUNTIME_UNAVAILABLE',
      'The doc-compare handler requires the workflow continuation runtime.'
    );
  }
  return sdk;
}

function assertRequiredDocCompareSlots(ctx: SdkTaskContext): void {
  for (const slot of DOC_COMPARE_REQUIRED_SLOTS) {
    if (typeof ctx.connectorBindings?.[slot] !== 'string' || ctx.connectorBindings[slot]!.trim().length === 0) {
      throw docCompareFailure('DOC_COMPARE_CONNECTOR_SLOT_MISSING', `Required connector slot "${slot}" is not bound.`);
    }
  }
}

async function saveDocCompareState(
  internal: StreamingTaskContext,
  stage: DocCompareCheckpointStage,
  input: DocCompareInput,
  state: DocCompareState
): Promise<void> {
  const snapshot: DocCompareSnapshot = { input, state };
  const key = docCompareStateStepKey(stage);
  await internal.step(key, stableJsonHash(snapshot), async () => snapshot);
}

async function loadDocCompareState(
  ctx: SdkTaskContext,
  stage: DocCompareCheckpointStage
): Promise<DocCompareSnapshot> {
  const stepKey = docCompareStateStepKey(stage);
  const checkpoint = ctx.checkpoints().find((entry) => entry.stepKey === stepKey && entry.status === 'SUCCEEDED');
  if (!checkpoint) {
    throw docCompareFailure('DOC_COMPARE_STATE_MISSING', `Saved workflow state for "${stage}" is unavailable.`);
  }
  const snapshot = await ctx.step.run<unknown>(stepKey, checkpoint.inputHash, async () => {
    throw docCompareFailure('DOC_COMPARE_STATE_MISSING', `Saved workflow state for "${stage}" could not be replayed.`);
  });
  if (
    !isRecord(snapshot) ||
    !isRecord(snapshot.input) ||
    !isRecord(snapshot.state) ||
    snapshot.state.stateVersion !== DOC_COMPARE_STATE_VERSION
  ) {
    throw docCompareFailure('DOC_COMPARE_STATE_INVALID', 'Saved doc-compare workflow state is malformed.');
  }
  return snapshot as unknown as DocCompareSnapshot;
}

function parseDocCompareContinuationRef(value: unknown): { stage: DocCompareChunkStage; joinToken: string } {
  if (typeof value !== 'string') {
    throw docCompareFailure('DOC_COMPARE_CONTINUATION_INVALID', 'Chunk join continuation reference is missing.');
  }
  const match = /^doc-compare:v1:(compare-structure|compare-references):(.+)$/.exec(value);
  if (!match || !match[1] || !match[2]) {
    throw docCompareFailure('DOC_COMPARE_CONTINUATION_INVALID', 'Chunk join continuation reference is malformed.');
  }
  return { stage: match[1] as DocCompareChunkStage, joinToken: match[2] };
}

function requireDocCompareChunkTask(raw: unknown, sdk: SdkTaskContext):
  { chunkId: string; stage: DocCompareChunkStage; input: Record<string, unknown> } | undefined
{
  if (!isRecord(raw) || !Object.prototype.hasOwnProperty.call(raw, DOC_COMPARE_CHUNK_MARKER)) return undefined;
  const chunk = raw[DOC_COMPARE_CHUNK_MARKER];
  if (
    !isRecord(chunk) ||
    (chunk.stage !== 'compare-structure' && chunk.stage !== 'compare-references') ||
    typeof chunk.chunkId !== 'string' ||
    chunk.chunkId.length === 0 ||
    // The chunk id is the child task key; accepting a payload whose id is not
    // the delivery's own key would let one child's evidence be filed under
    // another chunk.
    chunk.chunkId !== sdk.taskKey ||
    !isRecord(chunk.input)
  ) {
    throw docCompareFailure('DOC_COMPARE_CHUNK_INPUT_INVALID', 'Doc-compare chunk task payload is malformed.');
  }
  return { chunkId: chunk.chunkId, stage: chunk.stage, input: chunk.input };
}

/**
 * Production runtime bound to the host's connector facade.
 *
 * The connector call is checkpointed per distinct payload, so a redelivered
 * chunk replays its recorded invocation instead of paying for a second one.
 */
function buildDocCompareRuntime(internal: StreamingTaskContext): DocCompareRuntime {
  const port: DocCompareConnectorPort = {
    invoke: async (slot, promptOrPayload, options) => {
      const hash = stableJsonHash({ slot, promptOrPayload });
      return internal.step(`doc-compare:connector:${hash.slice(0, 20)}`, hash, async () =>
        internal.connector.invoke(slot, promptOrPayload, options)
      );
    },
  };
  return createDocCompareRuntime({
    connector: port,
    binding: DEFAULT_DOC_COMPARE_BINDING,
    checkpointsEnabled: true,
    checkpointKeyFor: (stepId) => `doc-compare:step:${stepId}`,
  });
}

async function writeDocCompareChunkResult(
  sdk: SdkTaskContext,
  chunkId: string,
  stage: DocCompareChunkStage,
  outcome: ChunkOutcome
): Promise<TaskDisposition> {
  let artifact: ArtifactRef;
  try {
    artifact = await sdk.artifacts.write(
      JSON.stringify({
        schemaVersion: DOC_COMPARE_CHUNK_RESULT_VERSION,
        chunkId,
        stage,
        outcome,
      }),
      'doc-compare-chunk-result.json',
      'application/json',
      'intermediate'
    );
  } catch {
    throw docCompareFailure('DOC_COMPARE_EVIDENCE_WRITE_FAILED', 'Doc-compare chunk evidence could not be persisted.');
  }
  if (!ARTIFACT_ID_PATTERN.test(artifact.artifactId)) {
    throw docCompareFailure('DOC_COMPARE_EVIDENCE_WRITE_FAILED', 'Doc-compare chunk evidence reference is invalid.');
  }
  return { kind: 'completed', resultRef: `artifact://${artifact.artifactId}` };
}

async function runDocCompareChunk(
  ctx: SdkTaskContext | TaskContext,
  sdk: SdkTaskContext,
  internal: StreamingTaskContext,
  raw: unknown
): Promise<TaskDisposition> {
  const chunk = requireDocCompareChunkTask(raw, sdk);
  if (!chunk) {
    throw docCompareFailure('DOC_COMPARE_CHUNK_INPUT_INVALID', 'Doc-compare chunk task payload is missing.');
  }
  assertActive(ctx);
  const runtime = buildDocCompareRuntime(internal);
  const spec: ChunkTaskSpec = {
    chunkId: chunk.chunkId,
    stage: chunk.stage,
    input: chunk.input,
  };
  // runChunk converts every business failure into a recorded outcome, so this
  // cannot throw for a provider reason: a failed chunk is evidence, not a crash.
  const outcome = await runtime.runChunk(spec);
  assertActive(ctx);
  return writeDocCompareChunkResult(sdk, chunk.chunkId, chunk.stage, outcome);
}

/**
 * Re-derive the evidence a reviewer is being asked to approve.
 *
 * The wait-for-review continuation deliberately carries only a reference, so
 * the merge is recomputed here from the same state and the same exported
 * merge function the terminal path uses. The two cannot drift because there is
 * one merge implementation.
 */
function buildDocCompareReviewEvidence(state: DocCompareState): Record<string, unknown> {
  const forStage = (stage: DocCompareStage) =>
    Object.keys(state.chunkEvidence)
      .filter((key) => key.startsWith(`${stage}:`))
      .map((key) => state.chunkEvidence[key]!);
  const structure = forStage('compare-structure');
  const references = forStage('compare-references');
  const merged = [...structure, ...references].map((chunk, index) => ({
    chunkId: chunk.chunkId,
    side: chunk.side,
    ordinal: chunk.ordinal,
    charCount: chunk.charCount,
    sectionIds: chunk.sectionIds,
    structureClaims: index < structure.length ? chunk.structureClaims : [],
    referenceClaims: index >= structure.length ? chunk.referenceClaims : [],
  }));
  return {
    schemaVersion: DOC_COMPARE_REVIEW_EVIDENCE_VERSION,
    evidenceRef: `doc-compare-evidence:${state.left.artifactId}:${state.right.artifactId}`,
    evidence: mergeChunkEvidence({
      leftFileName: state.left.fileName,
      rightFileName: state.right.fileName,
      chunks: merged,
      failedChunkIds: state.failedChunks.map((failure) => failure.chunkId),
    }),
  };
}

function readDocCompareChunkOutcome(raw: unknown, chunkId: string): ChunkOutcome {
  if (
    !isRecord(raw) ||
    raw.chunkId !== chunkId ||
    (raw.status !== 'succeeded' && raw.status !== 'failed')
  ) {
    throw docCompareFailure('DOC_COMPARE_CHUNK_RESULT_INVALID', `Chunk outcome for "${chunkId}" is malformed.`);
  }
  if (raw.status === 'failed') {
    const error = isRecord(raw.error) ? raw.error : undefined;
    return {
      chunkId,
      status: 'failed',
      error: {
        code:
          typeof error?.code === 'string' && error.code.trim().length > 0 ? error.code : 'CHUNK_FAILED',
        message:
          typeof error?.message === 'string' && error.message.trim().length > 0
            ? error.message
            : 'chunk failed without a reason',
      },
    };
  }
  const evidence = raw.evidence;
  if (
    !isRecord(evidence) ||
    !Array.isArray(evidence.structureClaims) ||
    !Array.isArray(evidence.referenceClaims) ||
    evidence.side !== 'left' && evidence.side !== 'right'
  ) {
    // A 'succeeded' outcome with no evidence would merge into a total that
    // reads as a clean comparison of a chunk that was never actually read.
    throw docCompareFailure('DOC_COMPARE_CHUNK_RESULT_INVALID', `Chunk evidence for "${chunkId}" is missing.`);
  }
  return raw as unknown as ChunkOutcome;
}

async function buildDocCompareJoin(
  internal: StreamingTaskContext,
  stage: DocCompareChunkStage,
  token: string,
  summary: unknown,
  state: DocCompareState
): Promise<ChunkJoinSubmission> {
  if (!isRecord(summary)) {
    throw docCompareFailure('DOC_COMPARE_CHUNK_RESULT_MISSING', 'Joined chunk results are missing.');
  }
  // Only the chunks this stage actually issued may come back: an extra key is
  // an injected chunk, and a missing one is unproven evidence.
  const issued = state.issuedChunkIds;
  if (issued.length === 0 || Object.keys(summary).length !== issued.length) {
    throw docCompareFailure(
      'DOC_COMPARE_CHUNK_RESULT_MISSING',
      'Joined chunk result count does not match the chunks issued for this stage.'
    );
  }
  const results: ChunkOutcome[] = [];
  for (const chunkId of issued) {
    const resultRef = summary[chunkId];
    if (typeof resultRef !== 'string') {
      throw docCompareFailure('DOC_COMPARE_CHUNK_RESULT_MISSING', `Chunk evidence for "${chunkId}" is missing.`);
    }
    const resultId = /^artifact:\/\/([0-9a-f-]{36})$/i.exec(resultRef)?.[1];
    if (!resultId) {
      throw docCompareFailure(
        'DOC_COMPARE_CHUNK_RESULT_INVALID',
        `Chunk evidence for "${chunkId}" has an invalid reference.`
      );
    }
    let envelope: unknown;
    try {
      envelope = JSON.parse((await internal.artifacts.read(resultId)).toString('utf8'));
    } catch {
      throw docCompareFailure(
        'DOC_COMPARE_CHUNK_RESULT_INVALID',
        `Chunk evidence for "${chunkId}" could not be read.`
      );
    }
    if (
      !isRecord(envelope) ||
      envelope.schemaVersion !== DOC_COMPARE_CHUNK_RESULT_VERSION ||
      envelope.chunkId !== chunkId ||
      envelope.stage !== stage
    ) {
      throw docCompareFailure(
        'DOC_COMPARE_CHUNK_RESULT_INVALID',
        `Chunk evidence for "${chunkId}" is malformed or mismatched.`
      );
    }
    results.push(readDocCompareChunkOutcome(envelope.outcome, chunkId));
  }
  return { joinToken: token, results };
}

async function mapDocCompareContinuation(
  ctx: SdkTaskContext | TaskContext,
  sdk: SdkTaskContext,
  internal: StreamingTaskContext,
  input: DocCompareInput,
  step: Awaited<ReturnType<typeof advanceDocCompare>>
): Promise<TaskDisposition> {
  const continuation = step.continuation;
  if (continuation.kind === 'spawn-chunk-children') {
    if (continuation.stage !== 'compare-structure' && continuation.stage !== 'compare-references') {
      throw docCompareFailure('DOC_COMPARE_CONTINUATION_INVALID', 'Unsupported chunk fan-out stage.');
    }
    if (continuation.children.length === 0) {
      throw docCompareFailure('DOC_COMPARE_CONTINUATION_INVALID', 'Chunk fan-out was issued with no children.');
    }
    await saveDocCompareState(internal, continuation.stage, input, step.state);
    const children = continuation.children.map((chunk) => ({
      taskKey: chunk.chunkId,
      kind: 'doc-compare',
      payload: {
        [DOC_COMPARE_CHUNK_MARKER]: {
          chunkId: chunk.chunkId,
          stage: chunk.stage,
          input: chunk.input,
        },
      },
    }));
    return sdk.spawn.spawnAndWait(
      children,
      'all-success',
      `doc-compare:v1:${continuation.stage}:${continuation.joinToken}`
    );
  }

  if (continuation.kind === 'wait-for-review') {
    await saveDocCompareState(internal, 'merge-evidence', input, step.state);
    let evidenceArtifact: ArtifactRef;
    try {
      evidenceArtifact = await sdk.artifacts.write(
        JSON.stringify(buildDocCompareReviewEvidence(step.state)),
        'doc-compare-review-evidence.json',
        'application/json',
        'intermediate'
      );
    } catch {
      throw docCompareFailure('DOC_COMPARE_EVIDENCE_WRITE_FAILED', 'Review evidence could not be persisted.');
    }
    if (!ARTIFACT_ID_PATTERN.test(evidenceArtifact.artifactId)) {
      throw docCompareFailure('DOC_COMPARE_EVIDENCE_WRITE_FAILED', 'Review evidence reference is invalid.');
    }
    return sdk.wait.waitForInput(
      'doc-compare-review-v1',
      {
        type: 'object',
        properties: {
          resumeSchemaVersion: { type: 'string', const: DOC_COMPARE_RESUME_VERSION },
          // Explicit and required: an absent answer is never consent.
          accepted: { type: 'boolean' },
          acceptedBy: { type: 'string', maxLength: 256 },
          note: { type: 'string', maxLength: 4000 },
        },
        required: ['resumeSchemaVersion', 'accepted'],
        additionalProperties: false,
      },
      { contextRef: `artifact://${evidenceArtifact.artifactId}` }
    );
  }

  if (continuation.terminal === 'FAILED') {
    throw docCompareFailure(
      continuation.failure?.code ?? 'DOC_COMPARE_FAILED',
      continuation.failure?.message ?? 'Doc-compare workflow failed.'
    );
  }

  const result = continuation.data;
  if (continuation.terminal !== 'SUCCEEDED' || !result) {
    throw docCompareFailure('DOC_COMPARE_RESULT_INVALID', 'Doc-compare workflow ended without a result.');
  }
  // Fail closed on a terminal record that claims nothing was compared: an
  // empty evidence set reads as a clean comparison of two documents that were
  // never opened, which is exactly the fabricated success this must not emit.
  if (
    result.resultVersion !== DOC_COMPARE_RESULT_VERSION ||
    result.businessId !== DOC_COMPARE_BUSINESS_ID ||
    !isRecord(result.evidence) ||
    result.evidence.evidenceVersion !== DOC_COMPARE_EVIDENCE_VERSION ||
    !Number.isInteger(result.evidence.chunkCount) ||
    (result.evidence.chunkCount as number) < 1 ||
    !Array.isArray(result.evidence.structureClaims) ||
    !Array.isArray(result.evidence.referenceClaims) ||
    result.evidence.structureClaims.length + result.evidence.referenceClaims.length < 1
  ) {
    throw docCompareFailure('DOC_COMPARE_RESULT_INVALID', 'Doc-compare result is incomplete or malformed.');
  }
  assertActive(ctx);
  let resultArtifact: ArtifactRef;
  try {
    resultArtifact = await sdk.artifacts.write(
      JSON.stringify(result),
      'doc-compare-result.json',
      'application/json',
      'output'
    );
  } catch {
    throw docCompareFailure('DOC_COMPARE_RESULT_WRITE_FAILED', 'Doc-compare result could not be persisted.');
  }
  if (!ARTIFACT_ID_PATTERN.test(resultArtifact.artifactId)) {
    throw docCompareFailure('DOC_COMPARE_RESULT_WRITE_FAILED', 'Doc-compare result reference is invalid.');
  }
  assertActive(ctx);
  return { kind: 'completed', resultRef: `artifact://${resultArtifact.artifactId}` };
}

async function handleDocCompare(
  ctx: SdkTaskContext | TaskContext,
  payload?: Record<string, unknown>
): Promise<TaskDisposition> {
  assertActive(ctx);
  const sdk = requireDocCompareSdkContext(ctx);
  assertRequiredDocCompareSlots(sdk);
  const internal = toInternalContext(ctx);
  const raw = payload ?? sdk.input;

  if (requireDocCompareChunkTask(raw, sdk)) {
    return runDocCompareChunk(ctx, sdk, internal, raw);
  }
  if (!isRecord(raw)) {
    throw docCompareFailure('DOC_COMPARE_INPUT_INVALID', 'Doc-compare task input is missing.');
  }

  let input: DocCompareInput;
  let state: DocCompareState | undefined;
  let join: ChunkJoinSubmission | undefined;
  let resume: unknown;

  if (Object.prototype.hasOwnProperty.call(raw, 'resumeInput')) {
    const snapshot = await loadDocCompareState(sdk, 'merge-evidence');
    input = snapshot.input;
    state = snapshot.state;
    resume = raw.resumeInput;
  } else if (Object.prototype.hasOwnProperty.call(raw, 'joinSummary') || raw.continuationRef !== undefined) {
    const reference = parseDocCompareContinuationRef(raw.continuationRef);
    const snapshot = await loadDocCompareState(sdk, reference.stage);
    if (snapshot.state.pendingStage !== reference.stage || snapshot.state.joinToken !== reference.joinToken) {
      throw docCompareFailure('DOC_COMPARE_CONTINUATION_INVALID', 'Join token does not match the saved workflow state.');
    }
    input = snapshot.input;
    state = snapshot.state;
    join = await buildDocCompareJoin(internal, reference.stage, reference.joinToken, raw.joinSummary, snapshot.state);
  } else {
    input = validateDocCompareInput(raw);
  }

  let advanced: Awaited<ReturnType<typeof advanceDocCompare>>;
  try {
    advanced = await advanceDocCompare({
      input,
      state,
      // The parent never runs a chunk; the runtime is required by the advance
      // signature and the child builds the real one over the connector facade.
      runtime: buildDocCompareRuntime(internal),
      ...(join ? { join } : {}),
      ...(resume !== undefined ? { resume } : {}),
    });
  } catch (error) {
    if (error instanceof LeaseLostError || error instanceof BusinessExecutionError) throw error;
    // The workflow's own guards (join token, chunk provenance, resume shape)
    // surface as DocCompareError; they are codes, not messages, so they are
    // re-raised as the operation's error code rather than swallowed.
    const code = error instanceof DocCompareError ? error.code : 'DOC_COMPARE_ADVANCE_FAILED';
    const message = error instanceof Error ? error.message : 'Doc-compare could not advance.';
    throw docCompareFailure(code, message);
  }
  assertActive(ctx);
  return mapDocCompareContinuation(ctx, sdk, internal, input, advanced);
}

/**
 * Handlers dictionary for all handler kinds declared in documentCoreManifest.
 * Manifest handlerKinds: ['root', 'ingest', 'extract', 'analyze', 'transform', 'generate', 'compare', 'disbursement', 'doc-compare']
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

  // Disbursement is a real handler kind: typed fan-out and approval continuations
  // yield through the SDK facades; terminal failure is reported by throwing a
  // coded error so runtime records FAILED rather than a fabricated success/cancel.
  disbursement: async (ctx, payload) => handleDisbursement(ctx, payload),

  // doc-compare is likewise a real handler kind, not a mode of `compare`: it
  // yields chunk fan-out and an optional review wait, and its terminal failure
  // is a coded throw so the runtime records FAILED rather than a clean success.
  'doc-compare': async (ctx, payload) => handleDocCompare(ctx, payload),
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
