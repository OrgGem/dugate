"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.defineBusiness = defineBusiness;
exports.createBullMQConsumer = createBullMQConsumer;
exports.startWorker = startWorker;
exports.classifyFailure = classifyFailure;
const node_crypto_1 = require("node:crypto");
const contracts_1 = require("@du/contracts");
const observability_1 = require("@du/observability");
const runtime_client_1 = require("./runtime-client");
const task_context_1 = require("./task-context");
const connector_invoker_1 = require("./connector-invoker");
/**
 * Validate a business definition: manifest must pass contract validation and
 * every declared handler kind must have a handler; handlers must not exist
 * for undeclared kinds.
 */
function defineBusiness(manifest, handlers, opts = {}) {
    const validation = (0, contracts_1.validateManifest)(manifest);
    if (!validation.ok) {
        throw new Error(`invalid business manifest: ${validation.problems.map((p) => `${p.pointer}: ${p.message}`).join('; ')}`);
    }
    const declared = new Set(validation.manifest.runtime.handlerKinds);
    const provided = new Set(Object.keys(handlers));
    const missing = [...declared].filter((k) => !provided.has(k));
    const extra = [...provided].filter((k) => !declared.has(k));
    if (opts.validate !== false) {
        if (missing.length > 0) {
            throw new Error(`missing handlers for declared kinds: ${missing.join(', ')}`);
        }
        if (extra.length > 0) {
            throw new Error(`handlers for undeclared kinds: ${extra.join(', ')} (REG-04)`);
        }
    }
    return { manifest: validation.manifest, handlers };
}
/** BullMQ-backed consumer (production path). Pinned bullmq ^5.x (ADR-05). */
function createBullMQConsumer(opts) {
    // Lazy require so unit tests never need Redis present.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const { Worker } = require('bullmq');
    let worker;
    return {
        start(handler) {
            worker = new Worker(opts.queueName, async (job) => {
                const parsed = contracts_1.BusinessJobV1Schema.safeParse(job.data);
                if (!parsed.success) {
                    // Malformed payload: transport-level rejection, no business effect.
                    throw new Error(`invalid BusinessJobV1 payload: ${parsed.error.message}`);
                }
                await handler(parsed.data);
            }, {
                connection: { url: opts.redisUrl },
                concurrency: opts.concurrency,
                // Business retry is runtime-owned; queue retries only cover
                // transport failures (docs 09).
                removeOnComplete: { age: 86400 },
                removeOnFail: { age: 7 * 86400 },
            });
        },
        async stop(graceMs) {
            if (worker)
                await worker.close();
            void graceMs;
        },
    };
}
async function startWorker(definition, config) {
    const logger = config.logger ??
        (0, observability_1.createLogger)({ component: config.component ?? `worker:${definition.manifest.businessId}` });
    const fetchImpl = config.fetchImpl ?? globalThis.fetch;
    const runtime = new runtime_client_1.RuntimeClient({
        baseUrl: config.runtimeUrl,
        token: config.runtimeToken,
        fetchImpl,
    });
    const invokeConnector = config.connectorUrl !== undefined
        ? (0, connector_invoker_1.createConnectorInvoker)({ baseUrl: config.connectorUrl, fetchImpl })
        : async () => {
            throw new Error('connectorUrl not configured; connector facade unavailable');
        };
    const workerInstanceId = config.workerInstanceId ?? `worker-${(0, node_crypto_1.randomUUID)()}`;
    const queueName = (0, contracts_1.businessQueueName)(definition.manifest.businessId, definition.manifest.version);
    const heartbeatIntervalMs = config.heartbeatIntervalMs ?? contracts_1.LEASE_DEFAULTS.heartbeatIntervalMs;
    const component = config.component ?? `worker:${definition.manifest.businessId}`;
    // Register/refresh worker identity (registration is replay-safe: same
    // version + same digest → 200; mismatch → 409 surfaced as startup failure).
    const hbBody = {
        businessId: definition.manifest.businessId,
        businessVersion: definition.manifest.version,
        imageDigest: config.imageDigest ?? definition.manifest.imageDigest,
        capacity: config.concurrency ?? 1,
    };
    let stopped = false;
    const inflight = new Set();
    const heartbeatTimer = setInterval(() => {
        runtime.heartbeatWorker(workerInstanceId, hbBody).catch((err) => {
            logger.warn('worker heartbeat failed', { error: String(err) });
        });
    }, heartbeatIntervalMs);
    heartbeatTimer.unref?.();
    const consumer = config.consumer ??
        (config.redis
            ? createBullMQConsumer({
                queueName,
                redisUrl: config.redis.url,
                concurrency: config.concurrency ?? 1,
                workerInstanceId,
            })
            : (() => {
                throw new Error('startWorker requires config.redis or an injected consumer');
            })());
    async function processDelivery(job) {
        await (0, observability_1.runWithContext)({
            component,
            correlationId: job.correlationId,
            operationId: job.operationId,
            taskId: job.taskId,
            businessId: job.businessId,
            businessVersion: job.businessVersion,
        }, async () => {
            // 1. Claim: atomic CAS; 409 busy / 410 terminal end the delivery safely.
            let claim;
            try {
                claim = await runtime.claimTask(job.taskId, {
                    deliveryId: job.deliveryId,
                    workerInstanceId,
                });
            }
            catch (err) {
                if (err instanceof runtime_client_1.RuntimeError && (err.status === 409 || err.status === 410)) {
                    logger.info('delivery fenced at claim (busy/terminal)', {
                        status: err.status,
                        code: err.code,
                    });
                    return;
                }
                throw err; // transport: let queue redeliver
            }
            const handler = definition.handlers[job.kind];
            if (!handler) {
                // Unregistered handler kind: permanent failure with the claimed
                // lease epoch (fencing), no retry.
                logger.error('delivery for unregistered handler kind', { kind: job.kind });
                await runtime
                    .failTask(job.taskId, {
                    leaseEpoch: claim.leaseEpoch,
                    errorCode: 'UNREGISTERED_HANDLER',
                    retryable: false,
                })
                    .catch((err) => {
                    if (!(err instanceof runtime_client_1.RuntimeError) || (!err.isLeaseLost && !err.isTaskTerminal)) {
                        throw err;
                    }
                });
                return;
            }
            const snapshot = claim.executionSnapshot;
            const hasChildPayload = Object.keys(snapshot.payloadRef).length > 0;
            const ctx = new task_context_1.DefaultTaskContext({
                taskId: claim.taskId,
                operationId: claim.operationId,
                tenantId: snapshot.tenantId,
                businessId: snapshot.businessId,
                businessVersion: snapshot.businessVersion,
                action: snapshot.action,
                kind: snapshot.kind,
                taskKey: snapshot.taskKey,
                attempt: claim.attempt,
                leaseEpoch: claim.leaseEpoch,
                leaseExpiresAt: claim.leaseExpiresAt,
                deadlineAt: claim.deadlineAt,
                input: hasChildPayload ? snapshot.payloadRef : snapshot.resolvedInputRef,
                connectorBindings: snapshot.pinned.connectorBindings,
                checkpointRefs: claim.checkpointRefs,
                cancelRequested: snapshot.cancelRequested,
            }, { runtime, logger, invokeConnector });
            // 2. Lease heartbeat for this delivery; lease loss aborts the context.
            const hb = setInterval(() => {
                runtime
                    .heartbeatTask(claim.taskId, claim.leaseEpoch)
                    .then((ack) => {
                    if (ack.cancelRequested)
                        ctx.abort('cancel');
                })
                    .catch((err) => {
                    if (err instanceof runtime_client_1.RuntimeError && err.isLeaseLost) {
                        logger.warn('lease lost during heartbeat; aborting context', { taskId: claim.taskId });
                        ctx.abort('lease-lost');
                    }
                });
            }, heartbeatIntervalMs);
            hb.unref?.();
            // 3. Run the handler; map the disposition onto runtime reports.
            try {
                const disposition = await handler(ctx);
                await reportDisposition(runtime, ctx, disposition, logger);
            }
            catch (err) {
                if (err instanceof task_context_1.LeaseLostError) {
                    logger.warn('handler aborted after lease loss; no report sent', { taskId: ctx.taskId });
                    return; // a newer attempt owns the task now
                }
                if (err instanceof runtime_client_1.AmbiguousReportError) {
                    // A write may have landed; do not duplicate side effects. Let the
                    // queue redeliver — claim/complete are idempotent.
                    logger.warn('ambiguous runtime report; ending delivery for redelivery', {
                        taskId: ctx.taskId,
                    });
                    return;
                }
                const classified = classifyFailure(err);
                logger.error('handler failed', { taskId: ctx.taskId, errorCode: classified.errorCode });
                try {
                    await runtime.failTask(ctx.taskId, {
                        leaseEpoch: ctx.leaseEpoch,
                        errorCode: classified.errorCode,
                        retryable: classified.retryable,
                        retryAfterMs: classified.retryAfterMs,
                        detail: classified.detail,
                    });
                }
                catch (reportErr) {
                    if (reportErr instanceof runtime_client_1.RuntimeError && (reportErr.isLeaseLost || reportErr.isTaskTerminal)) {
                        logger.warn('fail report fenced', { taskId: ctx.taskId, code: reportErr.code });
                    }
                    else {
                        throw reportErr;
                    }
                }
            }
            finally {
                clearInterval(hb);
            }
        });
    }
    consumer.start((job) => {
        const p = processDelivery(job).finally(() => inflight.delete(p));
        inflight.add(p);
        return p;
    });
    // Initial registration heartbeat (fail fast on identity mismatch).
    await runtime.heartbeatWorker(workerInstanceId, hbBody);
    const handle = {
        workerInstanceId,
        queueName,
        get stopped() {
            return stopped;
        },
        async stop(graceMs = 15_000) {
            if (stopped)
                return;
            stopped = true;
            clearInterval(heartbeatTimer);
            await consumer.stop(graceMs);
            const deadline = Date.now() + graceMs;
            while (inflight.size > 0 && Date.now() < deadline) {
                await Promise.race([
                    Promise.allSettled([...inflight]),
                    new Promise((r) => setTimeout(r, 100)),
                ]);
            }
            if (inflight.size > 0) {
                logger.warn('grace period expired with in-flight deliveries; lease recovery will handle them', {
                    count: inflight.size,
                });
            }
        },
    };
    return handle;
}
async function reportDisposition(runtime, ctx, disposition, logger) {
    switch (disposition.kind) {
        case 'completed': {
            const ack = await runtime.completeTask(ctx.taskId, {
                leaseEpoch: ctx.leaseEpoch,
                resultRef: disposition.resultRef,
                resultHash: (0, contracts_1.contentHash)(disposition.resultRef),
            });
            ctx.markTerminalReported();
            if (ack.replayed) {
                logger.info('completion replayed (already terminal)', { taskId: ctx.taskId });
            }
            return;
        }
        case 'waiting-children':
        case 'waiting-input':
            // State was persisted inside the facade call before the disposition was
            // returned; nothing further to report. The queue slot is released now.
            logger.info('task yielded', { taskId: ctx.taskId, kind: disposition.kind });
            return;
        case 'retry-scheduled':
            // The handler already scheduled its retry via failTask(retryable) or a
            // spawn; releasing the slot is the SDK's only job here.
            logger.info('retry scheduled by handler', { taskId: ctx.taskId });
            return;
    }
}
/**
 * Classify a handler failure for the runtime (docs 04: runtime owns budget).
 * Business errors may carry `code`/`retryable`/`retryAfterMs` properties.
 */
function classifyFailure(err) {
    if (err instanceof runtime_client_1.RuntimeError) {
        return {
            errorCode: err.code,
            retryable: err.status === 429 || err.status >= 500,
            retryAfterMs: err.status === 429 ? 5_000 : undefined,
            detail: err.message.slice(0, 2048),
        };
    }
    if (ConnectorTransportErrorLike(err)) {
        return {
            errorCode: err.code,
            retryable: err.status === 429 || err.status === 503 || err.status === 0,
            detail: err.message.slice(0, 2048),
        };
    }
    const candidate = err;
    if (candidate && typeof candidate.code === 'string') {
        return {
            errorCode: candidate.code,
            retryable: candidate.retryable === true,
            retryAfterMs: typeof candidate.retryAfterMs === 'number' ? candidate.retryAfterMs : undefined,
            detail: typeof candidate.message === 'string' ? candidate.message.slice(0, 2048) : undefined,
        };
    }
    return {
        errorCode: 'HANDLER_ERROR',
        retryable: false,
        detail: err instanceof Error ? err.message.slice(0, 2048) : String(err).slice(0, 2048),
    };
}
function ConnectorTransportErrorLike(err) {
    const c = err;
    return c?.name === 'ConnectorTransportError' && typeof c.status === 'number' && typeof c.code === 'string';
}
//# sourceMappingURL=worker.js.map