import type {
  ArtifactRef,
  ArtifactPurpose as ContractArtifactPurpose,
  BusinessManifest,
  ExecutionSnapshot,
  PinnedProfilePolicy,
  PinnedPromptOverride,
  InvocationGrant,
  InvocationInput,
  InvocationResponse,
  TaskDisposition,
  CheckpointRef,
} from '@du/contracts';
import type { WorkerCryptoSeam } from './crypto-seam';

/**
 * SDK public interfaces (docs 09, P4-01).
 * Business code depends only on these types + @du/contracts DTOs —
 * never on orchestrator/connector source.
 */

export type { TaskDisposition };
export type ArtifactPurpose = ContractArtifactPurpose;

export type TaskHandler = (ctx: TaskContext) => Promise<TaskDisposition>;

export interface BusinessDefinition {
  manifest: BusinessManifest;
  /** Handlers keyed by manifest runtime.handlerKinds. */
  handlers: Record<string, TaskHandler>;
}

/** Durable ref carries artifact identity/metadata only; reads must use the
 * runtime grant and never expose a backend storage key. */
export interface ArtifactStreamRef {
  artifactId: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
}

/** Bytes plus the declared source metadata supplied by an authorized read grant. */
export interface ArtifactReadWithMetadata {
  buffer: Buffer;
  filename?: string;
  mimeType?: string;
  sizeBytes: number;
  sha256: string;
  storageVersionId?: string;
  grantExpiresAt?: string;
}

/** Artifact facade — worker-sdk owns runtime artifact access/grants (P4-04/05
 * boundary with document-kit: document-kit receives an authorized stream,
 * never platform credentials). */
export interface ArtifactFacade {
  /**
   * Read an artifact the task is authorized for. Returns the full buffer for
   * bounded reads; implementations must enforce size limits.
   */
  read(artifactId: string): Promise<Buffer>;
  /** Read bounded bytes and retain the original declared name/MIME and integrity values. */
  readWithMetadata(artifactId: string, options?: { signal?: AbortSignal }): Promise<ArtifactReadWithMetadata>;
  /** Open a bounded, integrity-checkable stream for large artifacts. */
  readStream(
    artifactId: string,
    options?: { expectedSha256?: string; expectedSizeBytes?: number; expectedVersionId?: string; signal?: AbortSignal }
  ): Promise<import('node:stream').Readable>;
  /**
   * Write a new artifact: obtains an upload grant, streams content, finalizes
   * with size+sha256 verification. Returns the durable ref.
   */
  write(content: Buffer | string, fileName: string, mimeType: string, purpose?: ArtifactPurpose): Promise<ArtifactRef>;
  /** Stream an artifact upload with a declared size and optional digest check. */
  writeStream(
    content: AsyncIterable<Uint8Array> | ReadableStream<Uint8Array> | import('node:stream').Readable,
    fileName: string,
    mimeType: string,
    sizeBytes: number,
    purpose?: ArtifactPurpose,
    expectedSha256?: string
  ): Promise<ArtifactRef>;
  /** Obtain a short-lived read grant (e.g. to hand document-kit a stream). */
  accessGrant(artifactId: string, mode: 'read' | 'write'): Promise<{ downloadUrl?: string; uploadUrl?: string; expiresAt: string }>;
  /**
   * Authorized read descriptor WITHOUT bytes (optional, additive — DATA-04 Step B):
   * lets a business pre-flight size/integrity and choose disk-backed streaming
   * acquisition. Lease-fenced like every other artifact facade call.
   */
  stat?(artifactId: string, options?: { signal?: AbortSignal }): Promise<ArtifactStat>;
}

/** Grant-scoped artifact descriptor used for read-acquisition pre-flight. */
export interface ArtifactStat {
  fileName?: string;
  mimeType?: string;
  sizeBytes?: number;
  sha256?: string;
  storageVersionId?: string;
  grantExpiresAt?: string;
}

/** Connector facade — grant acquisition + invocation via connector-client. */
export interface ConnectorFacade {
  /**
   * Invoke the provider bound to `slot` for the current step. The SDK:
   * 1. computes a stable inputHash for (slot, input, options)
   * 2. obtains an invocation grant from the runtime (stable invocationId)
   * 3. posts the invocation through the connector client
   * Same logical step replayed → same invocationId (no duplicate provider calls).
   *
   * `invokeOpts` (P4-07, additive): `sessionRef` continues a provider
   * session (carried in the canonical hash + wire payload); `deadlineAt`
   * overrides the HTTP deadline used in the hash. When the task has no
   * operation deadline the SDK uses the fixed OPEN_DEADLINE_SENTINEL so
   * the canonical hash — and thus the grant replay — is stable across
   * redeliveries.
   */
  invoke(
    slot: string,
    input: ConnectorInvokeInput,
    options?: Record<string, unknown>,
    invokeOpts?: ConnectorInvokeOptions
  ): Promise<InvocationResponse>;
}

/** Additive connector.invoke options (P4-07). Omitting keeps prior behavior. */
export interface ConnectorInvokeOptions {
  /** Continuation session from a prior checkpoint; sent on the wire + hashed. */
  sessionRef?: string | null;
  /**
   * Stable HTTP deadline for the canonical hash. Must be deterministic
   * across redeliveries of the same logical step (grant replay rejects a
   * drifted inputHash with 409 INPUT_HASH_MISMATCH).
   */
  deadlineAt?: string;
}

/**
 * Fixed sentinel used as the canonical-hash deadline when a task carries
 * no operation deadline. A wall-clock fallback (e.g. now+300s) would make
 * the inputHash drift on every redelivery, so a pending-yield resume could
 * never reuse its stored grant (runtime answers 409 INPUT_HASH_MISMATCH).
 * The sentinel means "no SDK-imposed HTTP deadline"; the connector's own
 * per-request timeout still applies, and the HTTP deadline never extends
 * the operation deadline (docs 08).
 */
export const OPEN_DEADLINE_SENTINEL = '9999-12-31T23:59:59.000Z';

/** Canonical strict wire input; keep the P4-07 SDK surface in lockstep with contracts. */
export type ConnectorInvokeInput = InvocationInput;

/** Step checkpoint facade (RUN-04: full output preserved, idempotent replay). */
export interface StepFacade {
  /**
   * Execute `fn` under a durable checkpoint:
   * - if a SUCCEEDED checkpoint exists for (stepKey, inputHash) → return its
   *   stored output WITHOUT re-executing fn (no re-inference)
   * - else execute fn, persist full output (no truncation), return it
   * - inputHash mismatch on an existing checkpoint → InputHashMismatchError
   *
   * `opts.sessionRef` (P4-07, additive): persisted with the checkpoint row
   * so a replayed/resumed delivery can recover the provider session without
   * downloading the stored output.
   */
  run<T>(stepKey: string, inputHash: string, fn: () => Promise<T>, opts?: StepRunOptions): Promise<T>;
  /** Inspect a checkpoint without executing. */
  peek(stepKey: string): Promise<CheckpointRef | null>;
}

/** Additive step.run options (P4-07). Omitting keeps the pre-W39 wire shape. */
export interface StepRunOptions {
  /** Provider session this step continues; stored on the checkpoint row. */
  sessionRef?: string | null;
}

/** Child-spawn facade (RUN-05: parent yields slot, no in-memory wait). */
export interface SpawnFacade {
  /**
   * Persist child tasks + dependency + parent wait in one runtime
   * transaction, then return the waiting-children disposition. The parent
   * handler MUST return this disposition immediately (releasing the queue
   * slot); the continuation runs as a fresh delivery after join.
   */
  spawnAndWait(
    children: ChildTaskSpecInput[],
    joinPolicy: 'all-success',
    continuationRef: string
  ): Promise<TaskDisposition>;
}

export interface ChildTaskSpecInput {
  taskKey: string; // deterministic per business definition (not array index)
  kind: string; // registered handler kind
  payload: Record<string, unknown>;
}

/** Human-wait facade (RUN-06: schema persisted before slot release). */
export interface HumanWaitFacade {
  /**
   * Persist the wait schema via runtime API and return the waiting-input
   * disposition. Handler MUST return it immediately. Resume arrives as a
   * fresh delivery with the response in ctx.input.
   */
  waitForInput(
    waitKey: string,
    inputSchema: Record<string, unknown>,
    opts?: { uiSchema?: Record<string, unknown>; contextRef?: string; expiresAt?: string }
  ): Promise<TaskDisposition>;
}

/** Progress reporting (throttled/coalesced by the runtime). */
export interface ProgressFacade {
  report(percent: number, message?: string): Promise<void>;
}

/**
 * TaskContext handed to every handler invocation. Identity fields are
 * readonly; facades perform all durable side effects through the runtime
 * API with the current leaseEpoch (fencing).
 */
export interface TaskContext {
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
  /** Aborted when the lease is lost, cancel is requested, or shutdown begins. */
  readonly signal: AbortSignal;
  /** True once cancel has been requested for the operation. */
  readonly cancelRequested: boolean;
  /** Resolved input for this task (snapshot payloadRef / child payload). */
  readonly input: Record<string, unknown>;
  /** Human-wait response when this delivery resumes a wait; else undefined. */
  readonly waitResponse?: unknown;
  /** Pinned connector bindings: slot → connectorId@revision. */
  readonly connectorBindings: Readonly<Record<string, string>>;

  /**
   * P730-SDK-CONSUME (W1b): the admission-time pin, passed through from
   * claim.executionSnapshot.pinned at claim time. Additive + optional so
   * existing implementers (document-core MockTaskContext) keep compiling;
   * DefaultTaskContext always populates all three from the claim. Handlers
   * read these instead of querying any live profile — they are the
   * operation's frozen snapshot for its whole life, and every redelivery
   * (retry, restart, child, HITL resume) re-reads the same claim columns.
   *
   * profilePolicy null means the operation was admitted WITHOUT a profile
   * policy (legacy / pre-0026 row) — distinct from an empty policy, and the
   * contract keeps it nullable for exactly that reason. It never carries a
   * raw credential: the snapshot schema holds fileUrlAuthConfigured (boolean)
   * plus an immutable credentialRef, resolved by the acquisition leg (W1c).
   */
  readonly profileRevision?: number;
  readonly promptRevisions?: Readonly<Record<string, string>>;
  readonly profilePolicy?: PinnedProfilePolicy | null;

  /**
   * P745-CARRIER-IMPL-B1 (Δ-PC-1): the pinned prompt-CONTENT rows the claim
   * opened from the sealed carrier (`pinned.promptOverrides`, adjudication 1g).
   * `null` = no content carrier — a legacy operation, a deployment without
   * metadata encryption, or an empty bucket — and is deliberately distinct
   * from ABSENT, which is a context that never carried the pin at all
   * (pre-B1 shapes). Consumers keep the historical connector default on both.
   * Rows are key-4 native: `{connectionId, stepId, promptOverride, revision}`.
   */
  readonly promptOverrides?: readonly PinnedPromptOverride[] | null;

  readonly step: StepFacade;
  readonly spawn: SpawnFacade;
  readonly wait: HumanWaitFacade;
  readonly progress: ProgressFacade;
  readonly artifacts: ArtifactFacade;
  readonly connector: ConnectorFacade;

  /** Existing checkpoints for this task (delivered with the claim). */
  checkpoints(): readonly CheckpointRef[];
  /** Stored invocation grant for a step, if one was already issued. */
  grantFor(stepKey: string, bindingSlot: string, inputHash: string, artifactIds?: readonly string[]): Promise<InvocationGrant>;
}

/** Worker configuration (P4-02). */
export interface WorkerConfig {
  /** Runtime API base URL, e.g. http://orchestrator:3000/api/runtime/v1 */
  runtimeUrl: string;
  /** Bearer service identity token scoped to business/version. */
  runtimeToken: string;
  /** Connector base URL, e.g. http://connector:3100/internal/v1 */
  connectorUrl?: string;
  /** Short-lived Connector Bearer identity token; distinct from runtimeToken. */
  connectorServiceToken?: string | (() => string);
  /** Redis connection for BullMQ consumption. */
  redis?: { url: string };
  /** Stable instance identity; generated when omitted. */
  workerInstanceId?: string;
  /** Max concurrent task deliveries (queue slot count). */
  concurrency?: number;
  /** Lease/heartbeat tuning; defaults from contracts LEASE_DEFAULTS. */
  heartbeatIntervalMs?: number;
  /** Image digest reported in registration/heartbeat. */
  imageDigest?: string;
  /** Custom fetch for tests/proxies. */
  fetchImpl?: typeof fetch;
  /** Per-artifact stream cap used for worker-side reads and writes (default 64 MiB). */
  maxArtifactBytes?: number;
  /**
   * DATA-04 Step C (auto-branch): writeStream switches to the multipart
   * lifecycle when the declared size exceeds this threshold AND is at or
   * above the contract multipart floor (64 MiB + 1). Default =
   * `maxArtifactBytes`, i.e. exactly where single-PUT stops being legal.
   */
  multipartThresholdBytes?: number;
  /**
   * RV01-03: the application-encryption seam for artifact bytes. The worker
   * holds ONLY this handle - a Vault-backed provider reached through it - and
   * never a master key or a raw DEK.
   */
  crypto?: WorkerCryptoSeam;
  /**
   * RV01-03: when true, artifact writes MUST be sealed. A deployment that sets
   * this without supplying `crypto` fails closed at the write instead of
   * publishing plaintext. Default false keeps the pre-RV01-03 behaviour.
   */
  encryptionEnabled?: boolean;
  /**
   * ADR-18 §5 chunked manifest path. Default OFF: the wire profile is not
   * frozen, so this changes no default behaviour yet.
   */
  chunkedEncryptionEnabled?: boolean;
  /**
   * Explicit connector invocation function (P4-07 wiring). Takes
   * precedence over `connectorUrl`; lets a business plug in a
   * `@du/connector-client` transport (`createSdkConnectorInvoker(
   * createHttpTransport(...))`) or a test double without the SDK taking
   * a package dependency on the client.
   */
  invokeConnector?: ConnectorInvokeFunction;
  /** Logger component name. */
  component?: string;
}

/**
 * The seam `DefaultTaskContext` calls after obtaining a grant. The
 * payload is the exact wire `InvocationRequest` the connector validates.
 */
export type ConnectorInvokeFunction = (
  grant: InvocationGrant,
  payload: ConnectorInvocationPayloadShape,
  /** Cancellation/lease-loss signal: aborts the in-flight connector request. */
  signal?: AbortSignal
) => Promise<InvocationResponse>;

/** Structural mirror of `ConnectorInvocationPayload` (task-context.ts). */
export interface ConnectorInvocationPayloadShape {
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

/** Lifecycle handle returned by startWorker. */
export interface WorkerHandle {
  readonly workerInstanceId: string;
  readonly queueName: string;
  /** Graceful shutdown: stop claiming, finish/checkpoint in-flight within graceMs. */
  stop(graceMs?: number): Promise<void>;
  /** True after stop completes or fatal error. */
  readonly stopped: boolean;
}
