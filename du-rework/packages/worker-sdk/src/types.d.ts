import type { ArtifactRef, BusinessManifest, InvocationGrant, InvocationResponse, TaskDisposition, CheckpointRef } from '@du/contracts';
/**
 * SDK public interfaces (docs 09, P4-01).
 * Business code depends only on these types + @du/contracts DTOs —
 * never on orchestrator/connector source.
 */
export type { TaskDisposition };
export type TaskHandler = (ctx: TaskContext) => Promise<TaskDisposition>;
export interface BusinessDefinition {
    manifest: BusinessManifest;
    /** Handlers keyed by manifest runtime.handlerKinds. */
    handlers: Record<string, TaskHandler>;
}
/** Opaque reference to a stored artifact readable via authorized stream. */
export interface ArtifactStreamRef {
    artifactId: string;
    storageKey?: string;
    mimeType?: string;
    sizeBytes?: number;
    sha256?: string;
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
    /**
     * Write a new artifact: obtains an upload grant, streams content, finalizes
     * with size+sha256 verification. Returns the durable ref.
     */
    write(content: Buffer | string, fileName: string, mimeType: string, purpose?: ArtifactPurpose): Promise<ArtifactRef>;
    /** Obtain a short-lived read grant (e.g. to hand document-kit a stream). */
    accessGrant(artifactId: string, mode: 'read' | 'write'): Promise<{
        downloadUrl?: string;
        uploadUrl?: string;
        expiresAt: string;
    }>;
}
export type ArtifactPurpose = 'input' | 'output' | 'intermediate' | 'session';
/** Connector facade — grant acquisition + invocation via connector-client. */
export interface ConnectorFacade {
    /**
     * Invoke the provider bound to `slot` for the current step. The SDK:
     * 1. computes a stable inputHash for (slot, input, options)
     * 2. obtains an invocation grant from the runtime (stable invocationId)
     * 3. posts the invocation through the connector client
     * Same logical step replayed → same invocationId (no duplicate provider calls).
     */
    invoke(slot: string, input: ConnectorInvokeInput, options?: Record<string, unknown>): Promise<InvocationResponse>;
}
export interface ConnectorInvokeInput {
    prompt?: string;
    text?: string;
    artifacts?: {
        artifactId: string;
    }[];
    outputSchema?: Record<string, unknown>;
}
/** Step checkpoint facade (RUN-04: full output preserved, idempotent replay). */
export interface StepFacade {
    /**
     * Execute `fn` under a durable checkpoint:
     * - if a SUCCEEDED checkpoint exists for (stepKey, inputHash) → return its
     *   stored output WITHOUT re-executing fn (no re-inference)
     * - else execute fn, persist full output (no truncation), return it
     * - inputHash mismatch on an existing checkpoint → InputHashMismatchError
     */
    run<T>(stepKey: string, inputHash: string, fn: () => Promise<T>): Promise<T>;
    /** Inspect a checkpoint without executing. */
    peek(stepKey: string): Promise<CheckpointRef | null>;
}
/** Child-spawn facade (RUN-05: parent yields slot, no in-memory wait). */
export interface SpawnFacade {
    /**
     * Persist child tasks + dependency + parent wait in one runtime
     * transaction, then return the waiting-children disposition. The parent
     * handler MUST return this disposition immediately (releasing the queue
     * slot); the continuation runs as a fresh delivery after join.
     */
    spawnAndWait(children: ChildTaskSpecInput[], joinPolicy: 'all-success', continuationRef: string): Promise<TaskDisposition>;
}
export interface ChildTaskSpecInput {
    taskKey: string;
    kind: string;
    payload: Record<string, unknown>;
}
/** Human-wait facade (RUN-06: schema persisted before slot release). */
export interface HumanWaitFacade {
    /**
     * Persist the wait schema via runtime API and return the waiting-input
     * disposition. Handler MUST return it immediately. Resume arrives as a
     * fresh delivery with the response in ctx.input.
     */
    waitForInput(waitKey: string, inputSchema: Record<string, unknown>, opts?: {
        uiSchema?: Record<string, unknown>;
        contextRef?: string;
        expiresAt?: string;
    }): Promise<TaskDisposition>;
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
    readonly step: StepFacade;
    readonly spawn: SpawnFacade;
    readonly wait: HumanWaitFacade;
    readonly progress: ProgressFacade;
    readonly artifacts: ArtifactFacade;
    readonly connector: ConnectorFacade;
    /** Existing checkpoints for this task (delivered with the claim). */
    checkpoints(): readonly CheckpointRef[];
    /** Stored invocation grant for a step, if one was already issued. */
    grantFor(stepKey: string, bindingSlot: string, inputHash: string): Promise<InvocationGrant>;
}
/** Worker configuration (P4-02). */
export interface WorkerConfig {
    /** Runtime API base URL, e.g. http://orchestrator:3000/api/runtime/v1 */
    runtimeUrl: string;
    /** Bearer service identity token scoped to business/version. */
    runtimeToken: string;
    /** Connector base URL, e.g. http://connector:3100/internal/v1 */
    connectorUrl?: string;
    /** Redis connection for BullMQ consumption. */
    redis?: {
        url: string;
    };
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
    /** Logger component name. */
    component?: string;
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
//# sourceMappingURL=types.d.ts.map