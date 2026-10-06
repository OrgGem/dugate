// VENDORED from @du/worker-sdk @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-06)
// source: packages/worker-sdk/src/worker.ts (lines=555) sha256=7A62A47A04C2C41CBB7ADD488AE05A400E7927131C27F44BAB5058522F173C2F
// why: worker surface required by src/worker.ts, src/main.ts, types/context.ts, step-checkpoint, fanout

import { randomUUID } from 'node:crypto';
import {
  BusinessJobV1,
  BusinessJobV1Schema,
  LEASE_DEFAULTS,
  TaskDisposition,
  businessQueueName,
  contentHash,
  validateManifest,
} from '@du/contracts';
import { createLogger, Logger, runWithContext } from '@du/observability';
import { RuntimeClient, RuntimeError, AmbiguousReportError } from './runtime-client';
import { DefaultTaskContext, LeaseLostError } from './task-context';
import { createConnectorInvoker } from './connector-invoker';
import {
  committedOutputArtifactIds,
  createWorkspaceReferenceCheck,
  sweepStaleWorkspaces,
} from './artifact-streams';
import type { BusinessDefinition, TaskHandler, WorkerConfig, WorkerHandle } from './types';

/**
 * Worker lifecycle (P4-02): validate definition → register manifest →
 * heartbeat loop → consume queue → claim task → run handler → report
 * disposition → graceful shutdown.
 *
 * Delivery semantics: at-least-once. The claim is the authority: if the
 * task is already terminal or leased elsewhere the runtime answers 409/410
 * and the delivery ends safely. Business retry budget is runtime-owned; the
 * SDK only classifies failures (retryable + errorCode + retryAfterMs).
 */

export interface DefineBusinessOptions {
  /** Fail fast on an invalid manifest at startup (REG-04). */
  validate?: boolean;
}

/**
 * Validate a business definition: manifest must pass contract validation and
 * every declared handler kind must have a handler; handlers must not exist
 * for undeclared kinds.
 */
export function defineBusiness(
  manifest: unknown,
  handlers: Record<string, TaskHandler>,
  opts: DefineBusinessOptions = {}
): BusinessDefinition {
  const validation = validateManifest(manifest);
  if (!validation.ok) {
    throw new Error(
      `invalid business manifest: ${validation.problems.map((p) => `${p.pointer}: ${p.message}`).join('; ')}`
    );
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

/** Queue consumer abstraction so tests can drive deliveries without Redis. */
export interface QueueConsumer {
  /** Begin consuming; handler receives the parsed job + delivery metadata. */
  start(handler: (job: BusinessJobV1) => Promise<void>): void;
  /** Graceful stop: no new deliveries, in-flight finished within graceMs. */
  stop(graceMs: number): Promise<void>;
}

export interface BullMQConsumerOptions {
  queueName: string;
  redisUrl: string;
  concurrency: number;
  workerInstanceId: string;
}

/** BullMQ-backed consumer (production path). Pinned bullmq ^5.x (ADR-05). */
export function createBullMQConsumer(opts: BullMQConsumerOptions): QueueConsumer {
  // Lazy require so unit tests never need Redis present.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { Worker } = require('bullmq') as typeof import('bullmq');
  let worker: import('bullmq').Worker | undefined;
  return {
    start(handler: (job: BusinessJobV1) => Promise<void>): void {
      worker = new Worker(
        opts.queueName,
        async (job) => {
          const parsed = BusinessJobV1Schema.safeParse(job.data);
          if (!parsed.success) {
            // Malformed payload: transport-level rejection, no business effect.
            throw new Error(`invalid BusinessJobV1 payload: ${parsed.error.message}`);
          }
          await handler(parsed.data);
        },
        {
          connection: { url: opts.redisUrl },
          concurrency: opts.concurrency,
          // Business retry is runtime-owned; queue retries only cover
          // transport failures (docs 09).
          removeOnComplete: { age: 86400 },
          removeOnFail: { age: 7 * 86400 },
        }
      );
    },
    async stop(graceMs: number): Promise<void> {
      if (worker) await worker.close();
      void graceMs;
    },
  };
}

interface StartWorkerInternalOptions extends WorkerConfig {
  /** Injectable queue consumer (tests). Defaults to BullMQ when redis given. */
  consumer?: QueueConsumer;
  logger?: Logger;
  /**
   * Temp-workspace sweeper (P4-05 / W39-CC2b): removes `du-worker-*`
   * directories older than the TTL at startup and periodically, so files
   * left by crashed workers have a bounded lifetime (ART-02). Enabled by
   * default; failures are logged and never fatal.
   */
  tempSweep?: TempSweepConfig;
}

export interface TempSweepConfig {
  /** Default true. Set false to opt out (e.g. read-only filesystems). */
  enabled?: boolean;
  /** Root to scan; defaults to os.tmpdir(). */
  rootDir?: string;
  /** Age threshold; defaults to DEFAULT_STALE_WORKSPACE_MS (2h). */
  olderThanMs?: number;
  /** Periodic sweep interval; defaults to 30 minutes. */
  intervalMs?: number;
  /**
   * W47-Q2-5 (P4-05 ART-02 wire-hook): query the read-only runtime seam
   * `GET /api/runtime/v1/workspace-reference` (server.ts:711-743, base/token
   * from worker config) before deleting any expired dir. `referenced` there
   * is TENANT presence (see createWorkspaceReferenceCheck docs), so ANY of
   * these tenants with active holders protects every expired dir. Unset =
   * in-process live-workspace guard only (previous behavior). Network
   * failure/timeout/5xx resolve FAIL-SAFE: treated as referenced, never delete.
   */
  referenceQuery?: { tenantIds: string[]; timeoutMs?: number };
}

const DEFAULT_SWEEP_INTERVAL_MS = 30 * 60 * 1000;

export async function startWorker(
  definition: BusinessDefinition,
  config: StartWorkerInternalOptions
): Promise<WorkerHandle> {
  if (
    config.connectorUrl !== undefined
    && config.invokeConnector === undefined
    && (typeof config.connectorServiceToken !== 'string'
      ? config.connectorServiceToken === undefined
      : config.connectorServiceToken.trim().length === 0)
  ) {
    throw new Error('connectorServiceToken is required when connectorUrl is configured');
  }
  const logger =
    config.logger ??
    createLogger({ component: config.component ?? `worker:${definition.manifest.businessId}` });
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const runtime = new RuntimeClient({
    baseUrl: config.runtimeUrl,
    token: config.runtimeToken,
    fetchImpl,
  });
  const invokeConnector =
    config.invokeConnector ??
    (config.connectorUrl !== undefined
      ? createConnectorInvoker({
          baseUrl: config.connectorUrl,
          serviceToken: config.connectorServiceToken,
          fetchImpl,
        })
      : async () => {
          throw new Error('connectorUrl not configured; connector facade unavailable');
        });

  const workerInstanceId = config.workerInstanceId ?? `worker-${randomUUID()}`;
  const queueName = businessQueueName(definition.manifest.businessId, definition.manifest.version);
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? LEASE_DEFAULTS.heartbeatIntervalMs;
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
  const inflight = new Set<Promise<void>>();

  const heartbeatTimer = setInterval(() => {
    runtime.heartbeatWorker(workerInstanceId, hbBody).catch((err) => {
      logger.warn('worker heartbeat failed', { error: String(err) });
    });
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  // Temp-workspace sweep (W39-CC2b / ART-02 bounded file lifetime):
  // startup pass + periodic pass over du-worker-* dirs older than TTL.
  // Best-effort: a sweep failure is logged and never affects deliveries.
  const tempSweep = config.tempSweep ?? {};
  let sweepTimer: ReturnType<typeof setInterval> | undefined;
  if (tempSweep.enabled !== false) {
    const runSweep = (): void => {
      const referenceQuery = tempSweep.referenceQuery;
      sweepStaleWorkspaces({
        rootDir: tempSweep.rootDir,
        olderThanMs: tempSweep.olderThanMs,
        hasActiveReference:
          referenceQuery && referenceQuery.tenantIds.length > 0
            ? createWorkspaceReferenceCheck({
                baseUrl: config.runtimeUrl,
                token: config.runtimeToken,
                fetchImpl,
                tenantIds: referenceQuery.tenantIds,
                timeoutMs: referenceQuery.timeoutMs,
                onUncertain: (dir, reason) => {
                  logger.warn('workspace-reference query uncertain; treating dir as referenced', {
                    dir,
                    reason,
                  });
                },
              })
            : undefined,
      })
        .then((r) => {
          if (r.removed.length > 0) {
            logger.info('temp workspace sweep removed stale dirs', { removed: r.removed.length });
          }
        })
        .catch((err) => {
          logger.warn('temp workspace sweep failed', { error: String(err) });
        });
    };
    runSweep();
    sweepTimer = setInterval(runSweep, tempSweep.intervalMs ?? DEFAULT_SWEEP_INTERVAL_MS);
    sweepTimer.unref?.();
  }

  const consumer: QueueConsumer =
    config.consumer ??
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

  async function processDelivery(job: BusinessJobV1): Promise<void> {
    await runWithContext(
      {
        component,
        correlationId: job.correlationId,
        operationId: job.operationId,
        taskId: job.taskId,
        businessId: job.businessId,
        businessVersion: job.businessVersion,
      },
      async () => {
        // 1. Claim: atomic CAS; 409 busy / 410 terminal end the delivery safely.
        let claim;
        try {
          claim = await runtime.claimTask(job.taskId, {
            deliveryId: job.deliveryId,
            workerInstanceId,
            businessId: definition.manifest.businessId,
          });
        } catch (err) {
          if (err instanceof RuntimeError && (err.status === 409 || err.status === 410)) {
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
              if (!(err instanceof RuntimeError) || (!err.isLeaseLost && !err.isTaskTerminal)) {
                throw err;
              }
            });
          return;
        }

        const snapshot = claim.executionSnapshot;
        const hasChildPayload = Object.keys(snapshot.payloadRef).length > 0;
        const ctx = new DefaultTaskContext(
          {
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
            // P730-SDK-CONSUME (W1b): the admission-time pin travels with every
            // delivery of this operation. These three fields are read back from
            // the operation's pinned columns at claim time (runtime.ts), so a
            // retry/restart/child/HITL redelivery re-reads the SAME revision A —
            // never the live profile. profilePolicy stays null when the
            // operation was admitted without a policy; do not coalesce it.
            profileRevision: snapshot.pinned.profileRevision,
            promptRevisions: snapshot.pinned.promptRevisions,
            profilePolicy: snapshot.pinned.profilePolicy,
            // P745-CARRIER-IMPL-B1 (Δ-PC-1): the opened content carrier, a
            // straight pass-through — null (no carrier) and absent stay
            // distinct, and every redelivery re-reads the claim.
            promptOverrides: snapshot.pinned.promptOverrides,
            checkpointRefs: claim.checkpointRefs,
            cancelRequested: snapshot.cancelRequested,
          },
          {
            runtime,
            logger,
            invokeConnector,
            fetchImpl,
            maxArtifactBytes: config.maxArtifactBytes,
            multipartThresholdBytes: config.multipartThresholdBytes,
            // RV01-03: this is the wiring the packet found missing - the context
            // was constructed with no seam, so the write path could only ever
            // send plaintext. DefaultTaskContext now receives the same seam the
            // deployment configured.
            crypto: config.crypto,
            encryptionEnabled: config.encryptionEnabled === true,
            chunkedEncryptionEnabled: config.chunkedEncryptionEnabled === true,
          }
        );

        // 2. Lease heartbeat for this delivery; lease loss aborts the context.
        const hb = setInterval(() => {
          runtime
            .heartbeatTask(claim.taskId, claim.leaseEpoch)
            .then((ack) => {
              if (ack.cancelRequested) ctx.abort('cancel');
            })
            .catch((err) => {
              if (err instanceof RuntimeError && err.isLeaseLost) {
                logger.warn('lease lost during heartbeat; aborting context', { taskId: claim.taskId });
                ctx.abort('lease-lost');
              }
            });
        }, heartbeatIntervalMs);
        hb.unref?.();

        // 3. Run the handler; map the disposition onto runtime reports.
        try {
          const disposition: TaskDisposition = await handler(ctx);
          await reportDisposition(runtime, ctx, disposition, logger);
        } catch (err) {
          if (err instanceof LeaseLostError) {
            logger.warn('handler aborted after lease loss; no report sent', { taskId: ctx.taskId });
            return; // a newer attempt owns the task now
          }
          if (err instanceof AmbiguousReportError) {
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
          } catch (reportErr) {
            if (reportErr instanceof RuntimeError && (reportErr.isLeaseLost || reportErr.isTaskTerminal)) {
              logger.warn('fail report fenced', { taskId: ctx.taskId, code: reportErr.code });
            } else {
              throw reportErr;
            }
          }
        } finally {
          clearInterval(hb);
        }
      }
    );
  }

  consumer.start((job) => {
    const p = processDelivery(job).finally(() => inflight.delete(p));
    inflight.add(p);
    return p;
  });

  // Initial registration heartbeat (fail fast on identity mismatch).
  await runtime.heartbeatWorker(workerInstanceId, hbBody);

  const handle: WorkerHandle = {
    workerInstanceId,
    queueName,
    get stopped() {
      return stopped;
    },
    async stop(graceMs = 15_000): Promise<void> {
      if (stopped) return;
      stopped = true;
      clearInterval(heartbeatTimer);
      if (sweepTimer) clearInterval(sweepTimer);
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

async function reportDisposition(
  runtime: RuntimeClient,
  ctx: DefaultTaskContext,
  disposition: TaskDisposition,
  logger: Logger
): Promise<void> {
  switch (disposition.kind) {
    case 'completed': {
      const outputArtifactIds = committedOutputArtifactIds(
        disposition.artifacts ?? [],
        ctx.committedOutputArtifacts(),
        disposition.resultRef
      );
      const ack = await runtime.completeTask(ctx.taskId, {
        leaseEpoch: ctx.leaseEpoch,
        resultRef: disposition.resultRef,
        resultHash: contentHash(disposition.resultRef),
        outputArtifactIds,
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

export interface FailureClassification {
  errorCode: string;
  retryable: boolean;
  retryAfterMs?: number;
  detail?: string;
}

/**
 * Classify a handler failure for the runtime (docs 04: runtime owns budget).
 * Business errors may carry `code`/`retryable`/`retryAfterMs` properties.
 */
export function classifyFailure(err: unknown): FailureClassification {
  if (err instanceof RuntimeError) {
    return {
      errorCode: err.code,
      retryable: err.status === 429 || err.status >= 500,
      retryAfterMs: err.status === 429 ? 5_000 : undefined,
      detail: err.message.slice(0, 2048),
    };
  }
  if (ConnectorTransportErrorLike(err)) {
    const nonRetryableConnectorCode =
      err.code === 'INPUT_HASH_MISMATCH'
      || err.code === 'CANCELLED'
      || err.code === 'CONNECTOR_DISABLED'
      || err.code === 'INVOCATION_UNKNOWN';
    return {
      errorCode: err.code,
      // Ambiguous invocation outcomes must be reconciled against the Connector
      // ledger; replaying the task could execute provider work twice.
      retryable: !nonRetryableConnectorCode && (err.status === 429 || err.status === 503),
      detail: err.message.slice(0, 2048),
    };
  }
  const candidate = err as { code?: unknown; retryable?: unknown; retryAfterMs?: unknown; message?: unknown };
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

function ConnectorTransportErrorLike(err: unknown): err is { status: number; code: string; message: string } {
  const c = err as { name?: unknown; status?: unknown; code?: unknown };
  return c?.name === 'ConnectorTransportError' && typeof c.status === 'number' && typeof c.code === 'string';
}
