"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.RuntimeClient = exports.AmbiguousReportError = exports.RuntimeError = void 0;
const contracts_1 = require("@du/contracts");
/**
 * Runtime API HTTP client (docs 07). All reports carry the current
 * leaseEpoch; 409 LEASE_LOST aborts the delivery (no provider calls after
 * lease loss). Ambiguous responses (network error/5xx after a write) are
 * surfaced as AmbiguousReportError so the caller re-reads context instead of
 * inventing new IDs (docs 07 error rules).
 */
class RuntimeError extends Error {
    status;
    code;
    problem;
    constructor(status, code, problem, message) {
        super(message ?? `runtime error ${status} ${code}`);
        this.status = status;
        this.code = code;
        this.problem = problem;
        this.name = 'RuntimeError';
    }
    /** Stale lease: worker must abort the delivery and stop provider calls. */
    get isLeaseLost() {
        return this.status === 409 && this.code === 'LEASE_LOST';
    }
    get isStateConflict() {
        return this.status === 409 && this.code === 'STATE_CONFLICT';
    }
    get isTaskTerminal() {
        return this.status === 410;
    }
    get isInputHashMismatch() {
        return this.status === 409 && this.code === 'INPUT_HASH_MISMATCH';
    }
    /** Transport-level failure where the write MAY have been applied. */
    get isAmbiguous() {
        return this.status === 0 || this.status >= 500;
    }
}
exports.RuntimeError = RuntimeError;
/** A write whose outcome is unknown (lost ACK). Caller must re-read context. */
class AmbiguousReportError extends RuntimeError {
    operation;
    constructor(operation, cause) {
        super(0, 'TEMPORARY_UNAVAILABLE', null, `ambiguous runtime report: ${operation}`);
        this.operation = operation;
        this.name = 'AmbiguousReportError';
        this.cause = cause;
    }
}
exports.AmbiguousReportError = AmbiguousReportError;
class RuntimeClient {
    opts;
    fetchImpl;
    timeoutMs;
    constructor(opts) {
        this.opts = opts;
        this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
        this.timeoutMs = opts.timeoutMs ?? 10_000;
    }
    url(path) {
        return `${this.opts.baseUrl.replace(/\/$/, '')}${path}`;
    }
    async request(method, path, body, parser, opts = {}) {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        let response;
        try {
            response = await this.fetchImpl(this.url(path), {
                method,
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.opts.token}`,
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                signal: controller.signal,
            });
        }
        catch (err) {
            // Network failure: for writes this is ambiguous (server may have applied it).
            if (method !== 'GET' && opts.ambiguousSafe !== false) {
                throw new AmbiguousReportError(`${method} ${path}`, err);
            }
            throw new RuntimeError(0, 'TEMPORARY_UNAVAILABLE', null, `transport failure: ${String(err)}`);
        }
        finally {
            clearTimeout(timer);
        }
        const text = await response.text();
        const raw = text.length > 0 ? JSON.parse(text) : undefined;
        if (!response.ok) {
            const parsedProblem = contracts_1.ProblemSchema.safeParse(raw);
            const problem = parsedProblem.success ? parsedProblem.data : null;
            const code = problem?.code ?? (response.status === 409 ? 'STATE_CONFLICT' : 'TEMPORARY_UNAVAILABLE');
            if (response.status >= 500 && method !== 'GET' && opts.ambiguousSafe !== false) {
                throw new AmbiguousReportError(`${method} ${path} → ${response.status}`);
            }
            throw new RuntimeError(response.status, code, problem, problem?.detail);
        }
        return parser(raw);
    }
    /* ---------------- registration & health ---------------- */
    async heartbeatWorker(instanceId, hb) {
        return this.request('PUT', `/workers/${encodeURIComponent(instanceId)}/heartbeat`, hb, (raw) => contracts_1.HeartbeatAckSchema.parse(raw));
    }
    /* ---------------- task lifecycle ---------------- */
    async claimTask(taskId, req) {
        // Claim is idempotent per (taskId, deliveryId): a lost ACK replay returns
        // the same lease or 409 if fenced — safe to retry transport failures.
        return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/claim`, req, (raw) => contracts_1.ClaimResultSchema.parse(raw), { ambiguousSafe: false });
    }
    async heartbeatTask(taskId, leaseEpoch) {
        return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/heartbeat`, { leaseEpoch }, (raw) => contracts_1.TaskHeartbeatAckSchema.parse(raw), { ambiguousSafe: false });
    }
    async saveStep(taskId, stepKey, req) {
        // Idempotent: identical replay returns 200 with replayed=true.
        return this.request('PUT', `/tasks/${encodeURIComponent(taskId)}/steps/${encodeURIComponent(stepKey)}`, req, (raw) => contracts_1.SaveStepAckSchema.parse(raw));
    }
    async reportProgress(taskId, req) {
        // Progress is best-effort: ambiguity tolerated (coalesced anyway).
        await this.request('POST', `/tasks/${encodeURIComponent(taskId)}/progress`, req, () => undefined, {
            ambiguousSafe: false,
        }).catch((err) => {
            if (err instanceof RuntimeError && (err.isLeaseLost || err.isTaskTerminal))
                throw err;
            // swallow transient progress failures
        });
    }
    async spawnChildren(taskId, req) {
        return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/children`, req, (raw) => contracts_1.SpawnChildrenAckSchema.parse(raw));
    }
    async waitInput(taskId, req) {
        return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/wait-input`, req, (raw) => contracts_1.WaitInputAckSchema.parse(raw));
    }
    async completeTask(taskId, req) {
        return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/complete`, req, (raw) => contracts_1.TaskReportAckSchema.parse(raw));
    }
    async failTask(taskId, req) {
        return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/fail`, req, (raw) => contracts_1.TaskReportAckSchema.parse(raw));
    }
    /* ---------------- artifacts ---------------- */
    async requestUploadGrant(taskId, req) {
        return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/artifacts`, req, (raw) => contracts_1.ArtifactUploadGrantSchema.parse(raw));
    }
    async finalizeArtifact(artifactId, req) {
        await this.request('POST', `/artifacts/${encodeURIComponent(artifactId)}/finalize`, req, () => undefined);
    }
    async requestAccessGrant(artifactId, req) {
        return this.request('POST', `/artifacts/${encodeURIComponent(artifactId)}/access`, req, (raw) => contracts_1.ArtifactAccessGrantSchema.parse(raw));
    }
    /* ---------------- invocation grants ---------------- */
    async requestInvocationGrant(taskId, req) {
        return this.request('POST', `/tasks/${encodeURIComponent(taskId)}/invocation-grants`, req, (raw) => contracts_1.InvocationGrantSchema.parse(raw));
    }
}
exports.RuntimeClient = RuntimeClient;
//# sourceMappingURL=runtime-client.js.map