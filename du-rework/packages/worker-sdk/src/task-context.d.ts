import { CheckpointRef, InvocationGrant, InvocationResponse } from '@du/contracts';
import { Logger } from '@du/observability';
import { RuntimeClient, RuntimeError, AmbiguousReportError } from './runtime-client';
import type { ArtifactFacade, ConnectorFacade, ConnectorInvokeInput, HumanWaitFacade, ProgressFacade, SpawnFacade, StepFacade, TaskContext } from './types';
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
export declare class LeaseLostError extends Error {
    readonly taskId: string;
    constructor(taskId: string);
}
export declare class InputHashMismatchError extends Error {
    readonly stepKey: string;
    constructor(stepKey: string);
}
export interface TaskContextDeps {
    runtime: RuntimeClient;
    logger: Logger;
    /** Performs the actual HTTP invocation against the connector service. */
    invokeConnector: (grant: InvocationGrant, req: ConnectorInvocationPayload) => Promise<InvocationResponse>;
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
    checkpointRefs: CheckpointRef[];
    cancelRequested: boolean;
}
export declare class DefaultTaskContext implements TaskContext {
    private readonly task;
    private readonly deps;
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
    readonly signal: AbortSignal;
    private readonly abortController;
    private checkpointList;
    private cancelFlag;
    private terminalReported;
    readonly step: StepFacade;
    readonly spawn: SpawnFacade;
    readonly wait: HumanWaitFacade;
    readonly progress: ProgressFacade;
    readonly artifacts: ArtifactFacade;
    readonly connector: ConnectorFacade;
    constructor(task: ClaimedTask, deps: TaskContextDeps);
    get cancelRequested(): boolean;
    checkpoints(): readonly CheckpointRef[];
    /** Called by the worker loop when heartbeat detects lease loss/cancel. */
    abort(reason: 'lease-lost' | 'cancel' | 'shutdown'): void;
    markTerminalReported(): void;
    get hasReportedTerminal(): boolean;
    private assertLease;
    private wrapLeaseErrors;
    private createStepFacade;
    /**
     * Step outputs are stored via the artifact mechanism (full output, no
     * preview truncation). Small outputs are inlined as data: refs to keep the
     * common case cheap; the runtime treats both uniformly.
     */
    private persistStepOutput;
    private readCheckpointOutput;
    private createSpawnFacade;
    private createWaitFacade;
    private createProgressFacade;
    private createArtifactFacade;
    private createConnectorFacade;
    grantFor(stepKey: string, bindingSlot: string, inputHash: string): Promise<InvocationGrant>;
}
export declare function parseArtifactRef(ref: string): string;
export declare function runWithStepKey<T>(stepKey: string, fn: () => Promise<T>): Promise<T>;
export { AmbiguousReportError, RuntimeError };
//# sourceMappingURL=task-context.d.ts.map