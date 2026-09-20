"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuntimeError = exports.AmbiguousReportError = exports.DefaultTaskContext = exports.InputHashMismatchError = exports.LeaseLostError = void 0;
exports.parseArtifactRef = parseArtifactRef;
exports.runWithStepKey = runWithStepKey;
const node_crypto_1 = require("node:crypto");
const node_async_hooks_1 = require("node:async_hooks");
const contracts_1 = require("@du/contracts");
const runtime_client_1 = require("./runtime-client");
Object.defineProperty(exports, "RuntimeError", { enumerable: true, get: function () { return runtime_client_1.RuntimeError; } });
Object.defineProperty(exports, "AmbiguousReportError", { enumerable: true, get: function () { return runtime_client_1.AmbiguousReportError; } });
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
class LeaseLostError extends Error {
    taskId;
    constructor(taskId) {
        super(`lease lost for task ${taskId}; aborting delivery`);
        this.taskId = taskId;
        this.name = 'LeaseLostError';
    }
}
exports.LeaseLostError = LeaseLostError;
class InputHashMismatchError extends Error {
    stepKey;
    constructor(stepKey) {
        super(`checkpoint for step "${stepKey}" exists with a different inputHash`);
        this.stepKey = stepKey;
        this.name = 'InputHashMismatchError';
    }
}
exports.InputHashMismatchError = InputHashMismatchError;
class DefaultTaskContext {
    task;
    deps;
    taskId;
    operationId;
    tenantId;
    businessId;
    businessVersion;
    action;
    kind;
    taskKey;
    attempt;
    leaseEpoch;
    deadlineAt;
    input;
    waitResponse;
    connectorBindings;
    signal;
    abortController;
    checkpointList;
    cancelFlag;
    terminalReported = false;
    step;
    spawn;
    wait;
    progress;
    artifacts;
    connector;
    constructor(task, deps) {
        this.task = task;
        this.deps = deps;
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
    get cancelRequested() {
        return this.cancelFlag;
    }
    checkpoints() {
        return this.checkpointList;
    }
    /** Called by the worker loop when heartbeat detects lease loss/cancel. */
    abort(reason) {
        if (reason === 'cancel')
            this.cancelFlag = true;
        this.abortController.abort();
    }
    markTerminalReported() {
        this.terminalReported = true;
    }
    get hasReportedTerminal() {
        return this.terminalReported;
    }
    assertLease() {
        if (this.abortController.signal.aborted) {
            throw new LeaseLostError(this.taskId);
        }
    }
    wrapLeaseErrors(fn) {
        return fn().catch((err) => {
            if (err instanceof runtime_client_1.RuntimeError && err.isLeaseLost) {
                this.abortController.abort();
                throw new LeaseLostError(this.taskId);
            }
            throw err;
        });
    }
    /* ---------------------------------------------------------------- */
    /* Step checkpoints (RUN-04)                                         */
    /* ---------------------------------------------------------------- */
    createStepFacade() {
        const self = this;
        return {
            async run(stepKey, inputHash, fn) {
                self.assertLease();
                const existing = self.checkpointList.find((c) => c.stepKey === stepKey);
                if (existing) {
                    if (existing.status === 'SUCCEEDED') {
                        if (existing.inputHash !== inputHash) {
                            throw new InputHashMismatchError(stepKey);
                        }
                        // Replay: restore full stored output; never re-execute fn.
                        const stored = await self.readCheckpointOutput(existing);
                        self.deps.logger.debug('step checkpoint replay', { stepKey, generation: existing.generation });
                        return stored;
                    }
                    // FAILED/PENDING checkpoint: fall through and re-execute with a new generation.
                }
                const output = await runWithStepKey(stepKey, fn);
                self.assertLease();
                const outputRef = await self.persistStepOutput(stepKey, output);
                const ack = await self.wrapLeaseErrors(() => self.deps.runtime.saveStep(self.taskId, stepKey, {
                    leaseEpoch: self.leaseEpoch,
                    inputHash,
                    outputRef,
                    status: 'SUCCEEDED',
                }));
                self.checkpointList.push({
                    stepKey,
                    generation: ack.generation,
                    inputHash,
                    status: 'SUCCEEDED',
                    outputRef,
                });
                return output;
            },
            async peek(stepKey) {
                return self.checkpointList.find((c) => c.stepKey === stepKey) ?? null;
            },
        };
    }
    /**
     * Step outputs are stored via the artifact mechanism (full output, no
     * preview truncation). Small outputs are inlined as data: refs to keep the
     * common case cheap; the runtime treats both uniformly.
     */
    async persistStepOutput(stepKey, output) {
        const serialized = JSON.stringify({ stepKey, output });
        const inline = `inline:sha256:${(0, node_crypto_1.createHash)('sha256').update(serialized).digest('hex')}:${serialized.length}`;
        // Store the full payload as an intermediate artifact; ref points to it.
        const ref = await this.artifacts.write(serialized, `${stepKey}.checkpoint.json`, 'application/json', 'intermediate');
        return `artifact://${ref.artifactId}?meta=${encodeURIComponent(inline)}`;
    }
    async readCheckpointOutput(checkpoint) {
        if (!checkpoint.outputRef) {
            throw new Error(`checkpoint ${checkpoint.stepKey} has no outputRef`);
        }
        const artifactId = parseArtifactRef(checkpoint.outputRef);
        const raw = await this.artifacts.read(artifactId);
        const parsed = JSON.parse(raw.toString('utf8'));
        return parsed.output;
    }
    /* ---------------------------------------------------------------- */
    /* Spawn + join (RUN-05)                                             */
    /* ---------------------------------------------------------------- */
    createSpawnFacade() {
        const self = this;
        return {
            async spawnAndWait(children, joinPolicy, continuationRef) {
                self.assertLease();
                const specs = children.map((c) => ({
                    taskKey: c.taskKey,
                    kind: c.kind,
                    payloadRef: c.payload,
                    payloadHash: (0, contracts_1.contentHash)(c.payload),
                }));
                await self.wrapLeaseErrors(() => self.deps.runtime.spawnChildren(self.taskId, {
                    leaseEpoch: self.leaseEpoch,
                    children: specs,
                    joinPolicy,
                    continuationRef,
                }));
                // State persisted (children + dependency + parent wait + outbox in one
                // transaction). Parent MUST now yield its slot.
                return { kind: 'waiting-children' };
            },
        };
    }
    /* ---------------------------------------------------------------- */
    /* Human wait (RUN-06)                                               */
    /* ---------------------------------------------------------------- */
    createWaitFacade() {
        const self = this;
        return {
            async waitForInput(waitKey, inputSchema, opts) {
                self.assertLease();
                const ack = await self.wrapLeaseErrors(() => self.deps.runtime.waitInput(self.taskId, {
                    leaseEpoch: self.leaseEpoch,
                    waitKey,
                    inputSchema,
                    uiSchema: opts?.uiSchema,
                    contextRef: opts?.contextRef ?? null,
                    expiresAt: opts?.expiresAt,
                }));
                // Schema persisted before release; resume arrives as a new delivery.
                return { kind: 'waiting-input', waitId: ack.waitId };
            },
        };
    }
    /* ---------------------------------------------------------------- */
    /* Progress                                                          */
    /* ---------------------------------------------------------------- */
    createProgressFacade() {
        const self = this;
        return {
            async report(percent, message) {
                if (self.abortController.signal.aborted)
                    return; // best-effort only
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
    createArtifactFacade() {
        const self = this;
        return {
            async read(artifactId) {
                self.assertLease();
                const grant = await self.wrapLeaseErrors(() => self.deps.runtime.requestAccessGrant(artifactId, {
                    taskId: self.taskId,
                    leaseEpoch: self.leaseEpoch,
                    mode: 'read',
                }));
                if (!grant.downloadUrl)
                    throw new Error(`no download URL in access grant for ${artifactId}`);
                const res = await fetch(grant.downloadUrl);
                if (!res.ok)
                    throw new Error(`artifact download failed: ${res.status}`);
                return Buffer.from(await res.arrayBuffer());
            },
            async write(content, fileName, mimeType, purpose = 'output') {
                self.assertLease();
                const buf = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
                const sha256 = (0, node_crypto_1.createHash)('sha256').update(buf).digest('hex');
                const grant = await self.wrapLeaseErrors(() => self.deps.runtime.requestUploadGrant(self.taskId, {
                    leaseEpoch: self.leaseEpoch,
                    purpose,
                    mimeType,
                    sizeBytes: buf.byteLength,
                }));
                const upload = await fetch(grant.uploadUrl, {
                    method: 'PUT',
                    headers: { 'content-type': mimeType },
                    body: buf,
                });
                if (!upload.ok)
                    throw new Error(`artifact upload failed: ${upload.status}`);
                await self.wrapLeaseErrors(() => self.deps.runtime.finalizeArtifact(grant.artifactId, { sizeBytes: buf.byteLength, sha256 }));
                return {
                    artifactId: grant.artifactId,
                    role: purpose,
                    fileName,
                    mimeType,
                    sizeBytes: buf.byteLength,
                    hashSha256: sha256,
                };
            },
            async accessGrant(artifactId, mode) {
                self.assertLease();
                const grant = await self.wrapLeaseErrors(() => self.deps.runtime.requestAccessGrant(artifactId, {
                    taskId: self.taskId,
                    leaseEpoch: self.leaseEpoch,
                    mode,
                }));
                return { downloadUrl: grant.downloadUrl, uploadUrl: grant.uploadUrl, expiresAt: grant.expiresAt };
            },
        };
    }
    /* ---------------------------------------------------------------- */
    /* Connector invocation (CON-01..04: stable invocation per step)     */
    /* ---------------------------------------------------------------- */
    createConnectorFacade() {
        const self = this;
        return {
            async invoke(slot, input, options) {
                self.assertLease();
                const stepKey = currentStepKey();
                const inputHash = (0, contracts_1.contentHash)({ slot, input, options: options ?? null });
                // Runtime issues a stable invocationId for (task, stepKey, slot,
                // inputHash); replays reuse the same ID (no duplicate provider cost).
                const grant = await self.grantFor(stepKey, slot, inputHash);
                const payload = {
                    contractVersion: '1',
                    invocationId: grant.invocationId,
                    grant: grant.grant,
                    operationId: self.operationId,
                    taskId: self.taskId,
                    stepKey,
                    bindingSlot: slot,
                    input,
                    options,
                    sessionRef: null,
                    deadlineAt: self.deadlineAt ?? new Date(Date.now() + 300_000).toISOString(),
                };
                const response = await self.deps.invokeConnector(grant, payload);
                return contracts_1.InvocationResponseSchema.parse(response);
            },
        };
    }
    async grantFor(stepKey, bindingSlot, inputHash) {
        this.assertLease();
        return this.wrapLeaseErrors(() => this.deps.runtime.requestInvocationGrant(this.taskId, {
            leaseEpoch: this.leaseEpoch,
            stepKey,
            bindingSlot,
            inputHash,
        }));
    }
}
exports.DefaultTaskContext = DefaultTaskContext;
function parseArtifactRef(ref) {
    const m = /^artifact:\/\/([0-9a-f-]{36})/.exec(ref);
    if (!m || !m[1])
        throw new Error(`invalid artifact ref: ${ref}`);
    return m[1];
}
/* -------------------------------------------------------------------- */
/* Step-key scoping: connector.invoke needs the enclosing step key for   */
/* stable invocation IDs. step.run() scopes it via AsyncLocalStorage so  */
/* concurrent steps in the same process never cross-talk.                */
/* -------------------------------------------------------------------- */
const stepKeyStorage = new node_async_hooks_1.AsyncLocalStorage();
function runWithStepKey(stepKey, fn) {
    return stepKeyStorage.run(stepKey, fn);
}
function currentStepKey() {
    return stepKeyStorage.getStore() ?? 'default';
}
//# sourceMappingURL=task-context.js.map