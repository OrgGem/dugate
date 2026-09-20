import { ClaimResult, ClaimTaskRequest, SaveStepRequest, SaveStepAck, SpawnChildrenRequest, SpawnChildrenAck, WaitInputRequest, WaitInputAck, CompleteTaskRequest, FailTaskRequest, TaskReportAck, TaskHeartbeatAck, HeartbeatAck, WorkerHeartbeat, ProgressReport, ArtifactUploadGrantRequest, ArtifactUploadGrant, ArtifactFinalizeRequest, ArtifactAccessRequest, ArtifactAccessGrant, InvocationGrantRequest, InvocationGrant, ProblemDetails } from '@du/contracts';
/**
 * Runtime API HTTP client (docs 07). All reports carry the current
 * leaseEpoch; 409 LEASE_LOST aborts the delivery (no provider calls after
 * lease loss). Ambiguous responses (network error/5xx after a write) are
 * surfaced as AmbiguousReportError so the caller re-reads context instead of
 * inventing new IDs (docs 07 error rules).
 */
export declare class RuntimeError extends Error {
    readonly status: number;
    readonly code: string;
    readonly problem: ProblemDetails | null;
    constructor(status: number, code: string, problem: ProblemDetails | null, message?: string);
    /** Stale lease: worker must abort the delivery and stop provider calls. */
    get isLeaseLost(): boolean;
    get isStateConflict(): boolean;
    get isTaskTerminal(): boolean;
    get isInputHashMismatch(): boolean;
    /** Transport-level failure where the write MAY have been applied. */
    get isAmbiguous(): boolean;
}
/** A write whose outcome is unknown (lost ACK). Caller must re-read context. */
export declare class AmbiguousReportError extends RuntimeError {
    readonly operation: string;
    constructor(operation: string, cause?: unknown);
}
export interface RuntimeClientOptions {
    baseUrl: string;
    token: string;
    fetchImpl?: typeof fetch;
    /** Transport retry for idempotent GETs only. Writes are never blind-retried. */
    timeoutMs?: number;
}
export declare class RuntimeClient {
    private readonly opts;
    private readonly fetchImpl;
    private readonly timeoutMs;
    constructor(opts: RuntimeClientOptions);
    private url;
    private request;
    heartbeatWorker(instanceId: string, hb: WorkerHeartbeat): Promise<HeartbeatAck>;
    claimTask(taskId: string, req: ClaimTaskRequest): Promise<ClaimResult>;
    heartbeatTask(taskId: string, leaseEpoch: number): Promise<TaskHeartbeatAck>;
    saveStep(taskId: string, stepKey: string, req: SaveStepRequest): Promise<SaveStepAck>;
    reportProgress(taskId: string, req: ProgressReport): Promise<void>;
    spawnChildren(taskId: string, req: SpawnChildrenRequest): Promise<SpawnChildrenAck>;
    waitInput(taskId: string, req: WaitInputRequest): Promise<WaitInputAck>;
    completeTask(taskId: string, req: CompleteTaskRequest): Promise<TaskReportAck>;
    failTask(taskId: string, req: FailTaskRequest): Promise<TaskReportAck>;
    requestUploadGrant(taskId: string, req: ArtifactUploadGrantRequest): Promise<ArtifactUploadGrant>;
    finalizeArtifact(artifactId: string, req: ArtifactFinalizeRequest): Promise<void>;
    requestAccessGrant(artifactId: string, req: ArtifactAccessRequest): Promise<ArtifactAccessGrant>;
    requestInvocationGrant(taskId: string, req: InvocationGrantRequest): Promise<InvocationGrant>;
}
//# sourceMappingURL=runtime-client.d.ts.map