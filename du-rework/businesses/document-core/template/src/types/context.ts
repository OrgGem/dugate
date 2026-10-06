import { ArtifactRef, type PinnedProfilePolicy, type PinnedPromptOverride } from '@du/contracts';
import type { SupportedFormat } from '@du/document-kit';
import type { TaskArtifactCrypto } from '@du/worker-sdk';
import type { Readable } from 'node:stream';

export type { ArtifactRef };

export interface ConnectorInvocationOptions {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  systemPrompt?: string;
  responseFormat?: 'json' | 'text';
  jsonSchema?: Record<string, unknown>;
  /**
   * P745-SESSION-CONSUME: provider session to CONTINUE on this invocation.
   * Forwarded as the SDK `ConnectorInvokeOptions.sessionRef`, so it travels
   * on the wire AND inside the canonical inputHash (grant replay stays
   * stable). Omitted = no session, which is the pre-P745 single-shot path
   * byte-for-byte.
   */
  sessionRef?: string | null;
  /**
   * P745-CARRIER-IMPL-B2 (T7, Δ-B2-2): the key-4 stepId for THIS invocation.
   * The adapter assembles the final wire prompt, so it needs a step identity to
   * resolve a pinned prompt; the caller declares it here. Absent => the adapter
   * SKIPs the substitution and the assembled text is used as-is (no guessed
   * binding).
   */
  promptStepId?: string;
}

export interface ConnectorInvocationResult {
  invocationId: string;
  status: 'SUCCESS' | 'ERROR';
  data?: unknown;
  rawText?: string;
  usage?: { promptTokens: number; completionTokens: number; totalTokens: number };
  error?: { code: string; message: string; retryable: boolean };
  /**
   * P745-SESSION-CONSUME: the session the provider OFFERED on this response
   * (`InvocationResult.sessionRef`). Surfaces so a step that declares
   * `captureSession` can persist it; `null` when the provider offered none.
   */
  sessionRef?: string | null;
}

export interface StepCheckpointRecord {
  stepKey: string;
  inputHash: string;
  output: unknown;
  savedAt: string;
  /**
   * P745-SESSION-CONSUME (CR06-03): the provider session persisted on this
   * checkpoint row (SDK `StepRunOptions.sessionRef`). Optional so pre-P745
   * records keep their shape; absent/null = no session on this step.
   */
  sessionRef?: string | null;
}

/** Format identity for an artifact, canonicalized by document-kit from its bytes. */
export interface ArtifactFormatMetadata {
  canonicalFormat: SupportedFormat;
  canonicalMimeType: string;
  declaredFileName?: string;
  declaredMimeType?: string;
}

/** Grant-scoped read descriptor without bytes (mirrors @du/worker-sdk ArtifactStat). */
export interface ArtifactStat {
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  storageVersionId?: string;
  grantExpiresAt?: string;
}

/** Integrity/limits options accepted by a streaming read facade. */
export interface ArtifactReadStreamOptions {
  expectedSha256?: string;
  expectedSizeBytes?: number;
  expectedVersionId?: string;
  signal?: AbortSignal;
}

/** An artifact buffer and its byte-derived format identity. */
export interface ArtifactReadResult {
  buffer: Buffer;
  formatMetadata: ArtifactFormatMetadata;
  identity?: {
    storageVersionId: string;
    grantExpiresAt: string;
    sizeBytes: number;
    sha256: string;
  };
}

export interface TaskContext {
  readonly taskId: string;
  readonly operationId: string;
  readonly businessId: string;
  readonly businessVersion: string;
  readonly tenantId: string;
  readonly signal?: AbortSignal;
  readonly deadlineAt?: string | null;
  readonly cancelRequested?: boolean;

  /**
   * P730-SDK-CONSUME (W1b): pinned admission snapshot passed through from the
   * claim by the SDK DefaultTaskContext. Optional so MockTaskContext and
   * embedded facades keep compiling; when present these are the ONLY
   * policy/prompt source a handler may read (no live-profile query, no second
   * merge). profilePolicy null = admitted without a policy (distinct from
   * empty). Never carries raw credentials (boolean + credentialRef only).
   */
  readonly profileRevision?: number;
  readonly promptRevisions?: Readonly<Record<string, string>>;
  readonly profilePolicy?: PinnedProfilePolicy | null;
  /**
   * P745-CARRIER-IMPL-B2 (T6): the pinned prompt CONTENT rows the claim
   * carried (`pinned.promptOverrides`). `null` = no content carrier (legacy
   * operation / no metadata encryption / empty bucket); `undefined` = pre-field
   * wire shape. Both mean "no profile prompt" — never a fabricated default.
   */
  readonly promptOverrides?: readonly PinnedPromptOverride[] | null;
  /**
   * P745-CARRIER-IMPL-B2: the pinned connector bindings the claim carried
   * (`slot -> "connectorId@revision"`). Needed to resolve which pinned
   * prompt-override row applies to a step. Optional so pre-pin contexts keep
   * their shape; absent means no binding is resolvable (profile level skips).
   */
  readonly connectorBindings?: Readonly<Record<string, string>>;

  // Artifact operations
  artifacts: {
    read(artifactId: string): Promise<Buffer>;
    /** Optional enriched read for facades that retain source filename/MIME metadata. */
    readWithMetadata?(artifactId: string, options?: { signal?: AbortSignal }): Promise<ArtifactReadResult>;
    write(content: Buffer | string, fileName: string, mimeType: string): Promise<ArtifactRef>;
    /**
     * Authorized read descriptor WITHOUT bytes (DATA-04 Step B pre-flight).
     * SDK facades expose it; buffer-only facades keep the legacy in-memory path.
     */
    stat?(artifactId: string, options?: { signal?: AbortSignal }): Promise<ArtifactStat>;
    /**
     * Bounded streaming read; the SDK facade enforces grant digest/size and the
     * worker byte cap DURING transfer (Step B disk-backed acquisition).
     */
    readStream?(artifactId: string, options?: ArtifactReadStreamOptions): Promise<Readable>;
  };

  // Connector facade
  connector: {
    invoke(
      slot: 'ocr' | 'reasoning' | 'vision',
      promptOrPayload: string | Record<string, unknown>,
      options?: ConnectorInvocationOptions
    ): Promise<ConnectorInvocationResult>;
  };

  /**
   * W-ENC-04-SEAM: application encryption for this task, already bound to the
   * CLAIM tenant. Present only when the worker was started with a crypto seam;
   * absent means the deployment has encryption OFF, and every caller keeps the
   * plaintext behaviour. It is optional on purpose: a test or embedded context
   * that does not care about encryption must not be forced to fake one.
   */
  readonly crypto?: TaskArtifactCrypto;

  // Durable step checkpoints (Guarantee: full output >500 chars, no truncation)
  step<T>(
    stepKey: string,
    inputHash: string,
    fn: () => Promise<T>,
    /**
     * P745-SESSION-CONSUME (CR06-03): optional step-run options. `sessionRef`
     * is persisted with the checkpoint row (SDK StepRunOptions) so the session
     * slot is recoverable without executing the step. Additive: callers that
     * pass no options keep the pre-P745 wire and store behavior.
     */
    options?: { sessionRef?: string | null }
  ): Promise<T>;

  // Checkpoints inquiry
  getCheckpoint(stepKey: string): Promise<StepCheckpointRecord | null>;
}
