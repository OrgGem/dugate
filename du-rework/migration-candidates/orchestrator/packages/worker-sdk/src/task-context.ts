import { createHash } from 'node:crypto';
import { AsyncLocalStorage } from 'node:async_hooks';
import { Readable } from 'node:stream';
import {
  ArtifactRef,
  CheckpointRef,
  InvocationGrant,
  InvocationResponse,
  InvocationResponseSchema,
  TaskDisposition,
  contentHash,
  hashInvocationInput,
  type PinnedProfilePolicy,
  type PinnedPromptOverride,
} from '@du/contracts';
import { Logger } from '@du/observability';
import { MULTIPART_MAX_TOTAL_BYTES, MULTIPART_MIN_TOTAL_BYTES } from '@du/contracts';
import { RuntimeClient, RuntimeError, AmbiguousReportError } from './runtime-client';
import { OPEN_DEADLINE_SENTINEL } from './types';
import { openArtifactStream, toNodeReadable, uploadArtifactStream } from './artifact-streams';
import { uploadArtifactMultipart, type MultipartUploadTransport } from './artifact-multipart';
import { bindTaskCrypto, CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES, type SealedArtifact, type TaskArtifactBinding, type TaskArtifactCrypto, type WorkerCryptoSeam } from './crypto-seam';
import type {
  ArtifactFacade,
  ArtifactPurpose,
  ConnectorFacade,
  ConnectorInvokeInput,
  ConnectorInvokeOptions,
  HumanWaitFacade,
  ProgressFacade,
  SpawnFacade,
  ChildTaskSpecInput,
  StepFacade,
  StepRunOptions,
  TaskContext,
} from './types';

/**
 * TaskContext implementation (P4-03/04/05/07).
 *
 * Invariants:
 * - every runtime write carries the claim's leaseEpoch (fencing)
 * - step.run never re-executes a SUCCEEDED checkpoint with matching inputHash
 *   (RUN-04: full output restored, no re-inference)
 * - spawnAndWait/waitForInput persist state BEFORE returning the disposition;
 *   the parent handler releases its slot (no in-memory join wait)
 * - connector.invoke derives a stable invocationId per (stepKey, slot,
 *   inputHash) via the runtime grant endpoint — replays reuse it
 * - after lease loss the abort signal fires; no new provider calls
 */

export class LeaseLostError extends Error {
  constructor(readonly taskId: string) {
    super(`lease lost for task ${taskId}; aborting delivery`);
    this.name = 'LeaseLostError';
  }
}

export class InputHashMismatchError extends Error {
  constructor(readonly stepKey: string) {
    super(`checkpoint for step "${stepKey}" exists with a different inputHash`);
    this.name = 'InputHashMismatchError';
  }
}

export type ArtifactEncryptionErrorCode =
  | 'ENCRYPTION_REQUIRED_UNAVAILABLE'
  | 'SEAL_FAILED'
  | 'SIZE_LIMIT'
  | 'DIGEST_MISMATCH';

/**
 * RV01-03: every refusal on the artifact write path is one of these, so a
 * caller can tell "encryption is on and I could not do it" apart from a
 * transport failure. A missing seam is an ERROR, never a plaintext upload.
 */
export class ArtifactEncryptionError extends Error {
  constructor(
    readonly code: ArtifactEncryptionErrorCode,
    message: string
  ) {
    super(message);
    this.name = 'ArtifactEncryptionError';
  }
}

export interface TaskContextDeps {
  runtime: RuntimeClient;
  logger: Logger;
  fetchImpl?: typeof fetch;
  maxArtifactBytes?: number;
  /** DATA-04 Step C auto-branch threshold; default = maxArtifactBytes. */
  multipartThresholdBytes?: number;
  /** Performs the actual HTTP invocation against the connector service. */
  invokeConnector: (grant: InvocationGrant, req: ConnectorInvocationPayload) => Promise<InvocationResponse>;
  /**
   * W-ENC-04-SEAM: optional application-encryption seam for artifact bytes.
   *
   * When present, the single-PUT artifact path seals bytes under the tenant the
   * SERVER asserted at claim time before they are streamed to storage, and
   * finalizeArtifact reports the CIPHERTEXT size/digest (what storage actually
   * holds). When absent the upload path is byte-identical to the pre-ENC-04
   * behaviour, so every existing worker keeps working unchanged.
   *
   * Absent is a deployment decision, not a silent fallback: a handler that
   * asks for the seam when it is not configured gets an error rather than
   * plaintext bytes (see `cryptoFor`). No caller wires this yet (delta 45).
   */
  crypto?: WorkerCryptoSeam;
  /**
   * RV01-03: when true, artifact writes MUST be sealed. A missing `crypto`
   * seam is then an error, never a silent plaintext upload. Default false
   * keeps the pre-RV01-03 behaviour for deployments that wire no seam, and
   * that difference is asserted in the tests rather than left to chance.
   */
  encryptionEnabled?: boolean;
  /**
   * ADR-18 §5: stream artifacts past 5 MiB as authenticated 4 MiB chunks with
   * a manifest. Default OFF - the wire profile is not frozen (ADR-18 open
   * decisions), so this is opt-in and changes no default behaviour.
   */
  chunkedEncryptionEnabled?: boolean;
}

export interface ConnectorInvocationPayload {
  contractVersion: '1';
  invocationId: string;
  grant: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  bindingSlot: string;
  input: ConnectorInvokeInput;
  options?: Record<string, unknown>;
  sessionRef?: string | null;
  deadlineAt: string;
}

interface ClaimedTask {
  taskId: string;
  operationId: string;
  tenantId: string;
  businessId: string;
  businessVersion: string;
  action: string;
  kind: string;
  taskKey: string;
  attempt: number;
  leaseEpoch: number;
  leaseExpiresAt: string;
  deadlineAt: string | null;
  input: Record<string, unknown>;
  waitResponse?: unknown;
  connectorBindings: Record<string, string>;
  // P730-SDK-CONSUME (W1b): the pinned admission snapshot the claim carried.
  // Optional on the internal shape so pre-W1b test constructions still type-
  // check; worker.ts always supplies them from claim.executionSnapshot.pinned.
  profileRevision?: number;
  promptRevisions?: Record<string, string>;
  profilePolicy?: PinnedProfilePolicy | null;
  promptOverrides?: PinnedPromptOverride[] | null;
  checkpointRefs: CheckpointRef[];
  cancelRequested: boolean;
}

export class DefaultTaskContext implements TaskContext {
  readonly taskId: string;
  readonly operationId: string;
  readonly tenantId: string;
  readonly businessId: string;
  readonly businessVersion: string;
  readonly action: string;
  readonly kind: string;
  readonly taskKey: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly deadlineAt: string | null;
  readonly input: Record<string, unknown>;
  readonly waitResponse?: unknown;
  readonly connectorBindings: Readonly<Record<string, string>>;
  readonly profileRevision: number | undefined;
  readonly promptRevisions: Readonly<Record<string, string>> | undefined;
  readonly profilePolicy: PinnedProfilePolicy | null | undefined;
  readonly promptOverrides: readonly PinnedPromptOverride[] | null | undefined;
  readonly signal: AbortSignal;

  private readonly abortController: AbortController;
  private checkpointList: CheckpointRef[];
  private readonly finalizedOutputArtifacts: ArtifactRef[] = [];
  private cancelFlag: boolean;
  private terminalReported = false;

  readonly step: StepFacade;
  readonly spawn: SpawnFacade;
  readonly wait: HumanWaitFacade;
  readonly progress: ProgressFacade;
  readonly artifacts: ArtifactFacade;
  readonly connector: ConnectorFacade;

  /**
   * W-ENC-04-SEAM: artifact encryption bound to this task's claim tenant.
   *
   * Deliberately NOT part of the public `TaskContext` interface: adding a
   * member there would break every other implementer (document-core ships
   * `MockTaskContext`, which this packet may not touch). A handler that wants
   * encryption calls this on the concrete context; a handler that does not is
   * unaffected.
   *
   * Throws when the deployment configured no seam, so a handler that asks for
   * encryption can never silently continue with plaintext.
   */
  public cryptoFor(binding: TaskArtifactBinding): TaskArtifactCrypto {
    return bindTaskCrypto(this.deps.crypto, this.task);
  }

  /**
   * The configured crypto seam, or UNDEFINED when encryption is off.
   *
   * This exists because `cryptoFor` is present on the class either way, so
   * probing for the METHOD is not the same as asking whether encryption is
   * actually configured - a caller that checked the method would receive a
   * handle that throws on first use. Consumers that need to BRANCH on whether
   * encryption is on (rather than demand it) must read this instead.
   */
  public cryptoSeam(): WorkerCryptoSeam | undefined {
    return this.deps.crypto;
  }

  /**
   * W-ENC-04-SEAM: buffer a candidate artifact, verify the plaintext contract,
   * and seal it. Single-shot only: an object larger than the 5 MiB ceiling is
   * REFUSED rather than quietly written in the clear, because the chunked
   * manifest has no place to travel yet (the finalize body has no manifest
   * field — see delta 46). Bounding the refusal keeps the failure loud.
   */
  private async sealArtifactBytes(
    content: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable,
    artifactId: string,
    purpose: ArtifactPurpose,
    expectedSha256?: string
  ): Promise<SealedArtifact> {
    const crypto = this.cryptoFor({ artifactId, purpose });
    const chunks: Buffer[] = [];
    let total = 0;
    // RV01-03 defect 4: the ceiling is enforced WHILE reading, so an oversized
    // stream is refused after the first chunk that crosses it rather than after
    // the whole stream has been buffered and concatenated.
    for await (const chunk of toNodeReadable(content)) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      total += bytes.byteLength;
      if (total > CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES) {
        for (const held of chunks) held.fill(0);
        bytes.fill(0);
        throw new ArtifactEncryptionError(
          'SIZE_LIMIT',
          'artifact exceeds the single-shot encryption ceiling after ' +
            total +
            ' bytes; enable chunked encryption to stream artifacts past 5 MiB',
        );
      }
      chunks.push(bytes);
    }
    const plaintext = Buffer.concat(chunks, total);
    for (const chunk of chunks) chunk.fill(0);
    try {
      if (expectedSha256 !== undefined) {
        const digest = createHash('sha256').update(plaintext).digest('hex');
        if (digest !== expectedSha256) {
          throw new ArtifactEncryptionError(
            'DIGEST_MISMATCH',
            'artifact stream does not match the declared plaintext digest',
          );
        }
      }
      // RV01-03 defect 2: return the WHOLE envelope. The previous shape kept
      // only the ciphertext, so nonce, tag, aad and the wrapped DEK were dropped
      // and the object was unreadable even though it was correctly sealed.
      return await crypto.seal(plaintext, { artifactId, purpose });
    } finally {
      plaintext.fill(0);
    }
  }

  constructor(
    private readonly task: ClaimedTask,
    private readonly deps: TaskContextDeps
  ) {
    this.taskId = task.taskId;
    this.operationId = task.operationId;
    this.tenantId = task.tenantId;
    this.businessId = task.businessId;
    this.businessVersion = task.businessVersion;
    this.action = task.action;
    this.kind = task.kind;
    this.taskKey = task.taskKey;
    this.attempt = task.attempt;
    this.leaseEpoch = task.leaseEpoch;
    this.deadlineAt = task.deadlineAt;
    this.input = task.input;
    this.waitResponse = task.waitResponse;
    this.connectorBindings = task.connectorBindings;
    // P730-SDK-CONSUME (W1b): pass the pinned admission snapshot through
    // exactly as the claim carried it — no live-profile read, no second
    // policy merge. The claim is the sole authority for revisions.
    this.profileRevision = task.profileRevision;
    this.promptRevisions = task.promptRevisions;
    this.profilePolicy = task.profilePolicy ?? null;
    // P745-CARRIER-IMPL-B1 (Δ-PC-1): straight pass-through on purpose —
    // `null` (no carrier) stays null, `undefined` (a context that never
    // carried the pin) stays undefined. Neither is coalesced.
    this.promptOverrides = task.promptOverrides;
    this.checkpointList = [...task.checkpointRefs];
    this.cancelFlag = task.cancelRequested;

    this.abortController = new AbortController();
    this.signal = this.abortController.signal;

    this.step = this.createStepFacade();
    this.spawn = this.createSpawnFacade();
    this.wait = this.createWaitFacade();
    this.progress = this.createProgressFacade();
    this.artifacts = this.createArtifactFacade();
    this.connector = this.createConnectorFacade();
  }

  get cancelRequested(): boolean {
    return this.cancelFlag;
  }

  checkpoints(): readonly CheckpointRef[] {
    return this.checkpointList;
  }

  /** Output refs returned here have completed the mandatory finalize call. */
  committedOutputArtifacts(): readonly ArtifactRef[] {
    return [...this.finalizedOutputArtifacts];
  }

  /** Called by the worker loop when heartbeat detects lease loss/cancel. */
  abort(reason: 'lease-lost' | 'cancel' | 'shutdown'): void {
    if (reason === 'cancel') this.cancelFlag = true;
    this.abortController.abort();
  }

  markTerminalReported(): void {
    this.terminalReported = true;
  }

  get hasReportedTerminal(): boolean {
    return this.terminalReported;
  }

  private assertLease(): void {
    if (this.abortController.signal.aborted) {
      throw new LeaseLostError(this.taskId);
    }
  }

  private wrapLeaseErrors<T>(fn: () => Promise<T>): Promise<T> {
    return fn().catch((err) => {
      if (err instanceof RuntimeError && err.isLeaseLost) {
        this.abortController.abort();
        throw new LeaseLostError(this.taskId);
      }
      throw err;
    });
  }

  /* ---------------------------------------------------------------- */
  /* Step checkpoints (RUN-04)                                         */
  /* ---------------------------------------------------------------- */

  private createStepFacade(): StepFacade {
    const self = this;
    return {
      async run<T>(stepKey: string, inputHash: string, fn: () => Promise<T>, opts?: StepRunOptions): Promise<T> {
        self.assertLease();
        const existing = self.checkpointList.find((c) => c.stepKey === stepKey);
        if (existing) {
          if (existing.status === 'SUCCEEDED') {
            if (existing.inputHash !== inputHash) {
              throw new InputHashMismatchError(stepKey);
            }
            // Replay: restore full stored output; never re-execute fn.
            const stored = await self.readCheckpointOutput<T>(existing);
            self.deps.logger.debug('step checkpoint replay', { stepKey, generation: existing.generation });
            return stored;
          }
          // FAILED/PENDING checkpoint: fall through and re-execute with a new generation.
        }
        const output = await runWithStepKey(stepKey, fn);
        self.assertLease();
        const outputRef = await self.persistStepOutput(stepKey, output);
        // Normalize null → undefined so a session-less step serializes the
        // exact pre-W39 saveStep body (JSON.stringify drops undefined keys).
        const sessionRef = opts?.sessionRef ?? undefined;
        const ack = await self.wrapLeaseErrors(() =>
          self.deps.runtime.saveStep(self.taskId, stepKey, {
            leaseEpoch: self.leaseEpoch,
            inputHash,
            outputRef,
            status: 'SUCCEEDED',
            // Additive (P4-07): undefined is dropped by JSON serialization,
            // so the pre-W39 wire body is byte-identical when not supplied.
            sessionRef,
          })
        );
        self.checkpointList.push({
          stepKey,
          generation: ack.generation,
          inputHash,
          status: 'SUCCEEDED',
          outputRef,
          sessionRef,
        });
        return output;
      },

      async peek(stepKey: string): Promise<CheckpointRef | null> {
        return self.checkpointList.find((c) => c.stepKey === stepKey) ?? null;
      },
    };
  }

  /**
   * Step outputs are stored via the artifact mechanism (full output, no
   * preview truncation). Small outputs are inlined as data: refs to keep the
   * common case cheap; the runtime treats both uniformly.
   */
  private async persistStepOutput(stepKey: string, output: unknown): Promise<string> {
    const serialized = JSON.stringify({ stepKey, output });
    const inline = `inline:sha256:${createHash('sha256').update(serialized).digest('hex')}:${serialized.length}`;
    // Store the full payload as an intermediate artifact; ref points to it.
    const ref = await this.artifacts.write(serialized, `${stepKey}.checkpoint.json`, 'application/json', 'intermediate');
    return `artifact://${ref.artifactId}?meta=${encodeURIComponent(inline)}`;
  }

  private async readCheckpointOutput<T>(checkpoint: CheckpointRef): Promise<T> {
    if (!checkpoint.outputRef) {
      throw new Error(`checkpoint ${checkpoint.stepKey} has no outputRef`);
    }
    const artifactId = parseArtifactRef(checkpoint.outputRef);
    const raw = await this.artifacts.read(artifactId);
    const parsed = JSON.parse(raw.toString('utf8')) as { stepKey: string; output: T };
    return parsed.output;
  }

  /* ---------------------------------------------------------------- */
  /* Spawn + join (RUN-05)                                             */
  /* ---------------------------------------------------------------- */

  private createSpawnFacade(): SpawnFacade {
    const self = this;
    return {
      async spawnAndWait(children, joinPolicy, continuationRef): Promise<TaskDisposition> {
        self.assertLease();
        const specs = children.map((c: ChildTaskSpecInput) => ({
          taskKey: c.taskKey,
          kind: c.kind,
          payloadRef: c.payload,
          payloadHash: contentHash(c.payload),
        }));
        await self.wrapLeaseErrors(() =>
          self.deps.runtime.spawnChildren(self.taskId, {
            leaseEpoch: self.leaseEpoch,
            children: specs,
            joinPolicy,
            continuationRef,
          })
        );
        // State persisted (children + dependency + parent wait + outbox in one
        // transaction). Parent MUST now yield its slot.
        return { kind: 'waiting-children' };
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Human wait (RUN-06)                                               */
  /* ---------------------------------------------------------------- */

  private createWaitFacade(): HumanWaitFacade {
    const self = this;
    return {
      async waitForInput(waitKey, inputSchema, opts): Promise<TaskDisposition> {
        self.assertLease();
        const ack = await self.wrapLeaseErrors(() =>
          self.deps.runtime.waitInput(self.taskId, {
            leaseEpoch: self.leaseEpoch,
            waitKey,
            inputSchema,
            uiSchema: opts?.uiSchema,
            contextRef: opts?.contextRef ?? null,
            expiresAt: opts?.expiresAt,
          })
        );
        // Schema persisted before release; resume arrives as a new delivery.
        return { kind: 'waiting-input', waitId: ack.waitId };
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Progress                                                          */
  /* ---------------------------------------------------------------- */

  private createProgressFacade(): ProgressFacade {
    const self = this;
    return {
      async report(percent: number, message?: string): Promise<void> {
        if (self.abortController.signal.aborted) return; // best-effort only
        await self.deps.runtime.reportProgress(self.taskId, {
          leaseEpoch: self.leaseEpoch,
          percent,
          message,
        });
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Artifacts (ART-01..03 boundary: grants via runtime, bytes via      */
  /* storage URLs — worker holds no storage credentials)               */
  /* ---------------------------------------------------------------- */

  private createArtifactFacade(): ArtifactFacade {
    const self = this;
    const maxBytes = self.deps.maxArtifactBytes ?? 64 * 1024 * 1024;

    const readGrant = async (artifactId: string, signal?: AbortSignal) => {
      self.assertLease();
      if (signal?.aborted) throw signal.reason ?? new Error('artifact grant request aborted');
      return self.wrapLeaseErrors(() =>
        self.deps.runtime.requestAccessGrant(artifactId, {
          taskId: self.taskId,
          leaseEpoch: self.leaseEpoch,
          mode: 'read',
        }, { signal })
      );
    };

    const openGrantedRead = async (
      grant: Awaited<ReturnType<typeof readGrant>>,
      options: { expectedSha256?: string; expectedSizeBytes?: number; expectedVersionId?: string; signal?: AbortSignal } = {}
    ): Promise<Readable> => {
      if (!grant.downloadUrl) throw new Error('access grant did not include a download URL');
      const expiresAt = Date.parse(grant.expiresAt);
      if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()) {
        throw new Error('artifact access grant has expired');
      }
      if (options.expectedVersionId && grant.storageVersionId !== options.expectedVersionId) {
        throw new Error('artifact storage version does not match the authorized descriptor');
      }
      if (grant.sizeBytes !== undefined && grant.sizeBytes > maxBytes) {
        throw new Error('artifact size exceeds the configured worker byte limit');
      }
      if (options.expectedSha256 && grant.sha256 && options.expectedSha256 !== grant.sha256) {
        throw new Error('requested artifact digest does not match the authorized artifact descriptor');
      }
      if (
        options.expectedSizeBytes !== undefined &&
        grant.sizeBytes !== undefined &&
        options.expectedSizeBytes !== grant.sizeBytes
      ) {
        throw new Error('requested artifact size does not match the authorized artifact descriptor');
      }
      const grantExpiryController = new AbortController();
      const remainingGrantMs = expiresAt - Date.now();
      let grantExpiryTimer: ReturnType<typeof setTimeout>;
      const abortWhenGrantExpires = (): void => {
        const remainingMs = expiresAt - Date.now();
        if (remainingMs <= 0) {
          grantExpiryController.abort(new Error('artifact access grant expired during read'));
          return;
        }
        // Node clamps oversized timeouts to 1ms, so re-arm very distant
        // expirations in bounded chunks rather than aborting early.
        grantExpiryTimer = setTimeout(abortWhenGrantExpires, Math.min(remainingMs, 2_147_000_000));
      };
      grantExpiryTimer = setTimeout(abortWhenGrantExpires, Math.min(remainingGrantMs, 2_147_000_000));
      const signals: AbortSignal[] = [grantExpiryController.signal];
      if (self.signal) signals.push(self.signal);
      if (options.signal) signals.push(options.signal);
      const signal = AbortSignal.any(signals);
      try {
        const stream = await openArtifactStream(grant.downloadUrl, {
          maxBytes,
          expectedSha256: grant.sha256 ?? options.expectedSha256,
          expectedSizeBytes: grant.sizeBytes ?? options.expectedSizeBytes,
          signal,
          fetcher: self.deps.fetchImpl,
        });
        const clearExpiry = (): void => clearTimeout(grantExpiryTimer);
        stream.once('close', clearExpiry);
        stream.once('end', clearExpiry);
        stream.once('error', clearExpiry);
        return stream;
      } catch (error) {
        clearTimeout(grantExpiryTimer);
        throw error;
      }
    };

    const readStream = async (
      artifactId: string,
      options: { expectedSha256?: string; expectedSizeBytes?: number; expectedVersionId?: string; signal?: AbortSignal } = {}
    ): Promise<Readable> => {
      const grant = await readGrant(artifactId, options.signal);
      return openGrantedRead(grant, options);
    };

    /**
     * DATA-04 Step C (W49-Q4-2 §7.2): objects past the single-PUT cap ride
     * the DATA-00-M multipart lifecycle — same facade signature, same
     * finalize gate, same committed ref. The business caller never learns
     * which branch ran.
     */
    const writeStreamMultipart = async (
      content: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable,
      fileName: string,
      mimeType: string,
      sizeBytes: number,
      purpose: ArtifactPurpose,
      expectedSha256?: string
    ): Promise<ArtifactRef> => {
      const runtime = self.deps.runtime;
      // RV01-03 defect 1b: this branch used to stream PLAINTEXT parts even when
      // a seam was present. With encryption on there is no plaintext path here.
      if (self.deps.encryptionEnabled) {
        if (!self.deps.crypto) {
          throw new ArtifactEncryptionError(
            'ENCRYPTION_REQUIRED_UNAVAILABLE',
            'artifact encryption is enabled but no crypto seam is configured for this worker',
          );
        }
        // The chunked manifest path is NOT wired, and that is deliberate rather
        // than forgotten: sealStream binds the AAD to the artifactId, which in
        // multipart the SERVER assigns during multipartInit - after this point.
        // Sealing before init would bind the wrong AAD (authenticated, and
        // unreadable by the real owner). Refusing is the fail-closed answer
        // until ADR-18 freezes the wire profile. Recorded as an OPEN QUESTION in
        // the RV01-03 receipt, not silently skipped.
        throw new ArtifactEncryptionError(
          'SEAL_FAILED',
          'multipart artifacts cannot be encrypted yet: chunked sealing needs a server-assigned artifactId',
        );
      }
      const transport: MultipartUploadTransport = {
        init: (body) =>
          self.wrapLeaseErrors(() => runtime.multipartInit(self.taskId, { ...body, leaseEpoch: self.leaseEpoch })),
        partGrant: (artifactId, body) =>
          self.wrapLeaseErrors(() => runtime.multipartPartGrant(artifactId, { ...body, leaseEpoch: self.leaseEpoch })),
        complete: (artifactId, body) =>
          self.wrapLeaseErrors(() => runtime.multipartComplete(artifactId, { ...body, leaseEpoch: self.leaseEpoch })),
        abort: (artifactId, body) =>
          self.wrapLeaseErrors(() => runtime.multipartAbort(artifactId, { ...body, leaseEpoch: self.leaseEpoch })),
      };
      const upload = await uploadArtifactMultipart(content, {
        transport,
        fileName,
        mimeType,
        sizeBytes,
        purpose,
        expectedSha256,
        signal: self.signal,
        fetcher: self.deps.fetchImpl,
      });
      await self.wrapLeaseErrors(() =>
        runtime.finalizeArtifact(upload.artifactId, {
          taskId: self.taskId,
          leaseEpoch: self.leaseEpoch,
          sizeBytes: upload.sizeBytes,
          sha256: upload.sha256,
        })
      );
      const ref: ArtifactRef = {
        artifactId: upload.artifactId,
        role: purpose,
        fileName,
        mimeType,
        sizeBytes: upload.sizeBytes,
        hashSha256: upload.sha256,
      };
      if (purpose === 'output') self.finalizedOutputArtifacts.push(ref);
      return ref;
    };

    const writeStream = async (
      content: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | Readable,
      fileName: string,
      mimeType: string,
      sizeBytes: number,
      purpose: ArtifactPurpose = 'output',
      expectedSha256?: string
    ): Promise<ArtifactRef> => {
      self.assertLease();
      const multipartThreshold = self.deps.multipartThresholdBytes ?? maxBytes;
      if (sizeBytes > multipartThreshold && sizeBytes >= MULTIPART_MIN_TOTAL_BYTES) {
        if (sizeBytes > MULTIPART_MAX_TOTAL_BYTES) {
          throw new Error('artifact size exceeds the multipart wire ceiling');
        }
        return writeStreamMultipart(content, fileName, mimeType, sizeBytes, purpose, expectedSha256);
      }
      if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0 || sizeBytes > maxBytes) {
        throw new Error('artifact size exceeds the configured worker byte limit');
      }
      const grant = await self.wrapLeaseErrors(() =>
        self.deps.runtime.requestUploadGrant(self.taskId, {
          leaseEpoch: self.leaseEpoch,
          purpose,
          fileName,
          mimeType,
          sizeBytes,
        })
      );
      if (!grant.uploadUrl) throw new Error('upload grant did not include an upload URL');
      // W-ENC-04-SEAM: when a seam is configured, plaintext is sealed BEFORE
      // anything leaves the process, and the finalize call reports the
      // CIPHERTEXT size/digest because that is what storage committed. The
      // caller's expectedSha256 stays a PLAINTEXT contract value, so it is
      // verified here against the plaintext before sealing rather than being
      // forwarded to the upload helper.
      //
      // RV01-03 defect 1: this branch used to fall through to a PLAINTEXT
      // upload whenever the seam was absent. With encryptionEnabled that is
      // now a typed refusal: an encryption-enabled deployment must never
      // degrade into writing the clear.
      if (self.deps.encryptionEnabled && !self.deps.crypto) {
        throw new ArtifactEncryptionError(
          'ENCRYPTION_REQUIRED_UNAVAILABLE',
          'artifact encryption is enabled but no crypto seam is configured for this worker',
        );
      }
      const sealed = self.deps.crypto
        ? await self.sealArtifactBytes(content, grant.artifactId, purpose, expectedSha256)
        : null;
      const integrity = sealed
        ? await uploadArtifactStream(Readable.from([sealed.encrypted.ciphertext]), {
            uploadUrl: grant.uploadUrl,
            mimeType,
            sizeBytes: sealed.ciphertextSizeBytes,
            maxBytes,
            expectedSha256: sealed.ciphertextSha256,
            signal: self.signal,
            fetcher: self.deps.fetchImpl,
          })
        : await uploadArtifactStream(content, {
            uploadUrl: grant.uploadUrl,
            mimeType,
            sizeBytes,
            maxBytes,
            expectedSha256,
            signal: self.signal,
            fetcher: self.deps.fetchImpl,
          });
      await self.wrapLeaseErrors(() =>
        self.deps.runtime.finalizeArtifact(grant.artifactId, {
          taskId: self.taskId,
          leaseEpoch: self.leaseEpoch,
          sizeBytes: integrity.sizeBytes,
          sha256: integrity.sha256,
        })
      );
      const ref: ArtifactRef = {
        artifactId: grant.artifactId,
        role: purpose,
        fileName,
        mimeType,
        sizeBytes: integrity.sizeBytes,
        hashSha256: integrity.sha256,
      };
      if (purpose === 'output') self.finalizedOutputArtifacts.push(ref);
      return ref;
    };

    return {
      async read(artifactId: string): Promise<Buffer> {
        const stream = await readStream(artifactId);
        const chunks: Buffer[] = [];
        let totalBytes = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          totalBytes += bytes.length;
          chunks.push(bytes);
        }
        return Buffer.concat(chunks, totalBytes);
      },

      async readWithMetadata(artifactId: string, options: { signal?: AbortSignal } = {}) {
        const grant = await readGrant(artifactId, options.signal);
        const stream = await openGrantedRead(grant, options);
        const chunks: Buffer[] = [];
        let sizeBytes = 0;
        for await (const chunk of stream) {
          const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          sizeBytes += bytes.length;
          chunks.push(bytes);
        }
        const buffer = Buffer.concat(chunks, sizeBytes);
        const sha256 = createHash('sha256').update(buffer).digest('hex');
        self.assertLease();
        return {
          buffer,
          filename: grant.fileName,
          mimeType: grant.mimeType,
          sizeBytes,
          sha256,
          storageVersionId: grant.storageVersionId,
          grantExpiresAt: grant.expiresAt,
        };
      },

      readStream,

      async write(
        content: Buffer | string,
        fileName: string,
        mimeType: string,
        purpose: ArtifactPurpose = 'output'
      ): Promise<ArtifactRef> {
        const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
        const sha256 = createHash('sha256').update(buf).digest('hex');
        return writeStream(Readable.from([buf]), fileName, mimeType, buf.byteLength, purpose, sha256);
      },

      writeStream,

      async accessGrant(artifactId: string, mode: 'read' | 'write') {
        self.assertLease();
        const grant = await self.wrapLeaseErrors(() =>
          self.deps.runtime.requestAccessGrant(artifactId, {
            taskId: self.taskId,
            leaseEpoch: self.leaseEpoch,
            mode,
          })
        );
        return { downloadUrl: grant.downloadUrl, uploadUrl: grant.uploadUrl, expiresAt: grant.expiresAt };
      },

      async stat(artifactId: string, options: { signal?: AbortSignal } = {}) {
        const grant = await readGrant(artifactId, options.signal);
        return {
          fileName: grant.fileName,
          mimeType: grant.mimeType,
          sizeBytes: grant.sizeBytes,
          sha256: grant.sha256,
          storageVersionId: grant.storageVersionId,
          grantExpiresAt: grant.expiresAt,
        };
      },
    };
  }

  /* ---------------------------------------------------------------- */
  /* Connector invocation (CON-01..04: stable invocation per step)     */
  /* ---------------------------------------------------------------- */

  private createConnectorFacade(): ConnectorFacade {
    const self = this;
    return {
      async invoke(
        slot: string,
        input: ConnectorInvokeInput,
        options?: Record<string, unknown>,
        invokeOpts?: ConnectorInvokeOptions
      ): Promise<InvocationResponse> {
        self.assertLease();
        const stepKey = currentStepKey();
        // Canonical hash (W11-C1): computed over the exact wire fields the
        // Connector validates, so the signed grant verifies unchanged — no
        // shim. The deadline is computed first because it is part of the hash.
        //
        // P4-07 stable-invocation fix: when the task carries no operation
        // deadline, the previous wall-clock fallback (now+300s) made the
        // inputHash drift on every redelivery — the runtime keys grants by
        // (task, stepKey, slot) and answers a drifted hash with 409
        // INPUT_HASH_MISMATCH, so a pending-yield resume could never reuse
        // its stored grant. The fixed sentinel keeps the hash (and thus the
        // stable invocationId) identical across deliveries; the connector's
        // own request timeout still bounds the HTTP call.
        const deadlineAt =
          invokeOpts?.deadlineAt ?? self.deadlineAt ?? OPEN_DEADLINE_SENTINEL;
        const sessionRef = invokeOpts?.sessionRef ?? null;
        const inputHash = hashInvocationInput({
          contractVersion: '1',
          tenantId: self.tenantId,
          operationId: self.operationId,
          taskId: self.taskId,
          stepKey,
          bindingSlot: slot,
          input,
          options,
          sessionRef,
          deadlineAt,
        });
        // Runtime issues a stable invocationId for (task, stepKey, slot,
        // inputHash); replays reuse the same ID (no duplicate provider cost).
        const artifactIds = input.artifacts?.map((artifact) => artifact.artifactId) ?? [];
        const grant = await self.grantFor(stepKey, slot, inputHash, artifactIds);
        const payload: ConnectorInvocationPayload = {
          contractVersion: '1',
          invocationId: grant.invocationId,
          grant: grant.grant,
          operationId: self.operationId,
          taskId: self.taskId,
          stepKey,
          bindingSlot: slot,
          input,
          options,
          sessionRef,
          deadlineAt,
        };
        const response = await self.deps.invokeConnector(grant, payload);
        return InvocationResponseSchema.parse(response);
      },
    };
  }

  async grantFor(
    stepKey: string,
    bindingSlot: string,
    inputHash: string,
    artifactIds: readonly string[] = [],
  ): Promise<InvocationGrant> {
    this.assertLease();
    return this.wrapLeaseErrors(() =>
      this.deps.runtime.requestInvocationGrant(this.taskId, {
        leaseEpoch: this.leaseEpoch,
        stepKey,
        bindingSlot,
        inputHash,
        artifactIds: [...artifactIds],
      })
    );
  }
}

export function parseArtifactRef(ref: string): string {
  const m = /^artifact:\/\/([0-9a-f-]{36})/.exec(ref);
  if (!m || !m[1]) throw new Error(`invalid artifact ref: ${ref}`);
  return m[1];
}

/* -------------------------------------------------------------------- */
/* Step-key scoping: connector.invoke needs the enclosing step key for   */
/* stable invocation IDs. step.run() scopes it via AsyncLocalStorage so  */
/* concurrent steps in the same process never cross-talk.                */
/* -------------------------------------------------------------------- */

const stepKeyStorage = new AsyncLocalStorage<string>();

export function runWithStepKey<T>(stepKey: string, fn: () => Promise<T>): Promise<T> {
  return stepKeyStorage.run(stepKey, fn);
}

function currentStepKey(): string {
  return stepKeyStorage.getStore() ?? 'default';
}

export { AmbiguousReportError, RuntimeError };
