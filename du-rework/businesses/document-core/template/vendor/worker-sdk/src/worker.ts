import { randomUUID } from 'node:crypto';
import {
  BusinessJobV1,
  BusinessJobV1Schema,
  LEASE_DEFAULTS,
  RUNTIME_CLAIM_ERROR_DISPOSITION,
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
  start(handler: (job: BusinessJobV1, delivery?: QueueDeliveryControl) => Promise<void>): void;
  /** Stop requesting new queue jobs while allowing active handlers to finish. */
  pause?(): Promise<void> | void;
  /** Resume requesting new jobs after a durable admission acknowledgement. */
  resume?(): Promise<void> | void;
  /** Graceful stop: no new deliveries, in-flight finished within graceMs. */
  stop(graceMs: number): Promise<void>;
}

/** Control for durably delaying the current queue delivery without failing it. */
export interface QueueDeliveryControl {
  /** Move this active delivery to a delayed state and never resolve. */
  defer(delayMs: number): Promise<never>;
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
  const { Worker, DelayedError } = require('bullmq') as typeof import('bullmq');
  let worker: import('bullmq').Worker | undefined;
  let paused = false;
  let running = false;
  return {
    start(handler: (job: BusinessJobV1, delivery?: QueueDeliveryControl) => Promise<void>): void {
      worker = new Worker(
        opts.queueName,
        async (job, token) => {
          const parsed = BusinessJobV1Schema.safeParse(job.data);
          if (!parsed.success) {
            // Malformed payload: transport-level rejection, no business effect.
            throw new Error(`invalid BusinessJobV1 payload: ${parsed.error.message}`);
          }
          await handler(parsed.data, {
            defer: async (delayMs) => {
              if (typeof token !== 'string' || token.length === 0) {
                throw new Error('BullMQ did not provide a lock token for deferred delivery');
              }
              await job.moveToDelayed(Date.now() + Math.max(0, Math.ceil(delayMs)), token);
              throw new DelayedError();
            },
          });
        },
        {
          connection: { url: opts.redisUrl },
          concurrency: opts.concurrency,
          // Business retry is runtime-owned; queue retries only cover
          // transport failures (docs 09).
          removeOnComplete: { age: 86400 },
          removeOnFail: { age: 7 * 86400 },
          autorun: false,
        }
      );
      if (!paused) {
        running = true;
        void worker.run().catch(() => undefined);
      }
    },
    async pause(): Promise<void> {
      paused = true;
      if (worker && running) await worker.pause(true);
    },
    async resume(): Promise<void> {
      paused = false;
      if (!worker) return;
      if (running) {
        worker.resume();
      } else {
        running = true;
        void worker.run().catch(() => undefined);
      }
    },
    async stop(graceMs: number): Promise<void> {
      // startWorker owns the grace period and aborts active task contexts at
      // its deadline. Force close here so an uncooperative user handler cannot
      // leave shutdown waiting forever; BullMQ will recover its active lock.
      if (worker) await worker.close(true);
      running = false;
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
const CLAIM_DEFER_INITIAL_MS = 250;
const CLAIM_DEFER_MAX_MS = 30_000;
const CLAIM_DEFER_MAP_MAX_ENTRIES = 10_000;
const MAX_TIMEOUT_MS = 2_147_483_647;
const REGISTRATION_MAX_ATTEMPTS = 3;
const REGISTRATION_RETRY_BASE_MS = 125;
const REGISTRATION_RETRY_MAX_MS = 1_000;

class DeliveryRescheduleUnavailableError extends Error {
  readonly code = 'DELIVERY_RESCHEDULE_UNAVAILABLE';

  constructor(reason: string) {
    super(`delivery could not be durably rescheduled: ${reason}`);
    this.name = 'DeliveryRescheduleUnavailableError';
  }
}

export class WorkerCompatibilityError extends Error {
  readonly code = 'WORKER_COMPATIBILITY_REQUIRED';

  constructor(message: string) {
    super(message);
    this.name = 'WorkerCompatibilityError';
  }
}

export class WorkerStartupAbortedError extends Error {
  readonly code = 'WORKER_STARTUP_ABORTED';

  constructor() {
    super('worker startup was cancelled before queue consumption');
    this.name = 'WorkerStartupAbortedError';
  }
}

function assertStartupActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new WorkerStartupAbortedError();
}

function waitForStartupRetry(delayMs: number, signal?: AbortSignal): Promise<void> {
  assertStartupActive(signal);
  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (err) reject(err);
      else resolve();
    };
    const onAbort = (): void => finish(new WorkerStartupAbortedError());
    const timer = setTimeout(() => finish(), Math.min(MAX_TIMEOUT_MS, Math.max(0, delayMs)));
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

async function registerManifestForStartup(
  runtime: RuntimeClient,
  manifest: BusinessDefinition['manifest'],
  signal: AbortSignal | undefined,
  logger: Logger
): Promise<Awaited<ReturnType<RuntimeClient['registerBusinessVersion']>>> {
  for (let attempt = 1; attempt <= REGISTRATION_MAX_ATTEMPTS; attempt += 1) {
    assertStartupActive(signal);
    try {
      return await runtime.registerBusinessVersion(manifest, signal);
    } catch (err) {
      if (signal?.aborted) throw new WorkerStartupAbortedError();
      if (!(err instanceof RuntimeError) || !err.isRetryable || attempt === REGISTRATION_MAX_ATTEMPTS) {
        throw err;
      }
      const ceiling = Math.min(REGISTRATION_RETRY_MAX_MS, REGISTRATION_RETRY_BASE_MS * (2 ** (attempt - 1)));
      const delayMs = Math.floor(ceiling / 2) + Math.floor(Math.random() * (ceiling - Math.floor(ceiling / 2) + 1));
      logger.warn('business registration failed transiently; retrying startup registration', {
        attempt,
        maxAttempts: REGISTRATION_MAX_ATTEMPTS,
        retryAfterMs: delayMs,
        code: err.code,
      });
      await waitForStartupRetry(delayMs, signal);
    }
  }
  throw new Error('business manifest registration exhausted startup retries');
}

function isAckSafeClaimError(err: RuntimeError): boolean {
  return RUNTIME_CLAIM_ERROR_DISPOSITION[err.code as keyof typeof RUNTIME_CLAIM_ERROR_DISPOSITION] === 'ACK_SAFE';
}

function claimDeferralDelayMs(deliveryId: string, counts: Map<string, number>, retryAfterMs?: number): number {
  const attempt = counts.get(deliveryId) ?? 0;
  const ceiling = Math.min(CLAIM_DEFER_MAX_MS, CLAIM_DEFER_INITIAL_MS * (2 ** Math.min(attempt, 7)));
  const floor = Math.max(1, Math.floor(ceiling / 2));
  const jittered = floor + Math.floor(Math.random() * (ceiling - floor + 1));
  const hinted = Number.isFinite(retryAfterMs) ? Math.max(0, Math.ceil(retryAfterMs ?? 0)) : 0;
  if (counts.size >= CLAIM_DEFER_MAP_MAX_ENTRIES && !counts.has(deliveryId)) {
    const oldest = counts.keys().next().value as string | undefined;
    if (oldest !== undefined) counts.delete(oldest);
  }
  counts.set(deliveryId, Math.min(attempt + 1, 8));
  return Math.min(CLAIM_DEFER_MAX_MS, Math.max(jittered, hinted));
}

function boundedTimeout(callback: () => void, delayMs: number): ReturnType<typeof setTimeout> {
  return setTimeout(callback, Math.min(MAX_TIMEOUT_MS, Math.max(0, delayMs)));
}

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
  const manifestValidation = validateManifest(definition.manifest);
  if (!manifestValidation.ok) {
    throw new Error(
      `invalid business manifest at worker startup: ${manifestValidation.problems.map((p) => `${p.pointer}: ${p.message}`).join('; ')}`
    );
  }
  const localManifestDigest = manifestValidation.digest;
  const logger =
    config.logger ??
    createLogger({ component: config.component ?? `worker:${definition.manifest.businessId}` });
  const fetchImpl = config.fetchImpl ?? globalThis.fetch;
  const runtime = new RuntimeClient({
    baseUrl: config.runtimeUrl,
    token: config.runtimeToken,
    fetchImpl,
  });
  assertStartupActive(config.startupSignal);
  const registration = await registerManifestForStartup(
    runtime,
    manifestValidation.manifest,
    config.startupSignal,
    logger
  );
  assertStartupActive(config.startupSignal);
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
  const leaseSafetyMarginMs = Math.max(
    0,
    config.leaseSafetyMarginMs ?? Math.min(5_000, Math.ceil(heartbeatIntervalMs / 3))
  );
  const component = config.component ?? `worker:${definition.manifest.businessId}`;

  // Register/refresh worker identity (registration is replay-safe: same
  // version + same digest → 200; mismatch → 409 surfaced as startup failure).
  const hbBody = {
    businessId: definition.manifest.businessId,
    businessVersion: definition.manifest.version,
    manifestDigest: registration.digest,
    imageDigest: config.imageDigest ?? definition.manifest.imageDigest,
    ...(config.deploymentRevision ? { deploymentRevision: config.deploymentRevision } : {}),
    capacity: config.concurrency ?? 1,
  };

  let stopped = false;
  const inflight = new Set<Promise<void>>();
  const taskReservations = new Map<string, object>();
  const activeContexts = new Set<DefaultTaskContext>();
  const shutdownWaiters = new Set<() => void>();
  const claimDeferrals = new Map<string, number>();
  let activeTaskCount = 0;
  let observedBackupFenceRevision: number | undefined;
  const heartbeatBody = () => ({
    ...hbBody,
    activeTasks: activeTaskCount,
    ...(observedBackupFenceRevision === undefined ? {} : { observedBackupFenceRevision }),
  });
  let admissionOpen = false;
  let controlRevision = -1;
  let controlState: 'OPEN' | 'PAUSED' | 'DRAINING' = 'DRAINING';
  let backupFenceRevision = -1;
  let backupFenceState: 'OPEN' | 'HELD' | 'UNKNOWN' = 'UNKNOWN';
  let backupFenceAcknowledged = false;
  let consumer: QueueConsumer | undefined;
  const admissionWaiters = new Set<() => void>();
  const waitForAdmission = async (): Promise<boolean> => {
    if (admissionOpen) return true;
    if (stopped) return false;
    await new Promise<void>((resolve) => admissionWaiters.add(resolve));
    return admissionOpen && !stopped;
  };
  const applyAdmissionAck = async (
    ack: Awaited<ReturnType<RuntimeClient['heartbeatWorker']>>
  ): Promise<boolean> => {
    if (ack.controlRevision >= controlRevision) {
      controlRevision = ack.controlRevision;
      controlState = ack.controlState;
    }
    const backupAck = ack.backupEffectFence;
    if (!backupAck) {
      // V1 heartbeat compatibility: absence is UNKNOWN, never implicit OPEN
      // or proof that the previous fence revision was observed.
      backupFenceRevision = -1;
      backupFenceState = 'UNKNOWN';
      backupFenceAcknowledged = false;
      observedBackupFenceRevision = undefined;
      admissionOpen = false;
      for (const resolve of admissionWaiters) resolve();
      admissionWaiters.clear();
      for (const ctx of activeContexts) ctx.abort('compatibility');
      await consumer?.pause?.();
      logger.error('runtime heartbeat omitted backupEffectFence; worker admission fails closed', {
        code: 'WORKER_COMPATIBILITY_REQUIRED',
      });
      return false;
    }
    if (backupAck.revision > backupFenceRevision) {
      backupFenceRevision = backupAck.revision;
      backupFenceState = backupAck.state;
      backupFenceAcknowledged = backupAck.acknowledged;
      observedBackupFenceRevision = backupAck.revision;
    } else if (backupAck.revision === backupFenceRevision) {
      // Heartbeats may overlap. The same immutable revision can move from
      // unacknowledged to acknowledged, but never back due to response order.
      backupFenceState = backupAck.state;
      backupFenceAcknowledged ||= backupAck.acknowledged;
      observedBackupFenceRevision = backupAck.revision;
    }
    const nextOpen = controlState === 'OPEN'
      && backupFenceState === 'OPEN'
      && backupFenceAcknowledged;
    if (admissionOpen === nextOpen) return true;
    admissionOpen = nextOpen;
    if (nextOpen) {
      for (const resolve of admissionWaiters) resolve();
      admissionWaiters.clear();
      await consumer?.resume?.();
    } else {
      await consumer?.pause?.();
    }
    return true;
  };
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;

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

  consumer =
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

  async function waitForRetryDelay(delayMs: number): Promise<boolean> {
    if (stopped) return false;
    return new Promise<boolean>((resolve) => {
      let settled = false;
      const finish = (ready: boolean): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        shutdownWaiters.delete(onShutdown);
        resolve(ready);
      };
      const onShutdown = (): void => finish(false);
      const timer = boundedTimeout(() => finish(!stopped), delayMs);
      shutdownWaiters.add(onShutdown);
    });
  }

  async function deferCurrentDelivery(
    job: BusinessJobV1,
    delivery: QueueDeliveryControl | undefined,
    reason: string,
    delayMs: number
  ): Promise<never> {
    logger.warn('delivery deferred before execution', {
      taskId: job.taskId,
      code: reason,
      retryAfterMs: delayMs,
    });
    if (!delivery) {
      throw new DeliveryRescheduleUnavailableError(reason);
    }
    await delivery.defer(Math.max(0, Math.ceil(delayMs)));
    // The control contract is Promise<never>; resolving would accidentally
    // complete the queue job and is therefore treated as an adapter failure.
    throw new DeliveryRescheduleUnavailableError('defer callback resolved');
  }

  async function waitOrDeferClaim(
    job: BusinessJobV1,
    delivery: QueueDeliveryControl | undefined,
    reason: string,
    delayMs: number
  ): Promise<void> {
    if (delivery) await deferCurrentDelivery(job, delivery, reason, delayMs);
    if (stopped) throw new DeliveryRescheduleUnavailableError(reason);
    if (!admissionOpen && !await waitForAdmission()) {
      throw new DeliveryRescheduleUnavailableError(reason);
    }
    if (!await waitForRetryDelay(delayMs)) {
      throw new DeliveryRescheduleUnavailableError(reason);
    }
  }

  async function deferClaimAfterLeaseExpiry(
    job: BusinessJobV1,
    delivery: QueueDeliveryControl | undefined,
    reason: string,
    leaseExpiresAt: string
  ): Promise<never> {
    const expiry = Date.parse(leaseExpiresAt);
    const delay = Number.isFinite(expiry)
      ? Math.max(0, expiry + leaseSafetyMarginMs - Date.now())
      : claimDeferralDelayMs(job.deliveryId, claimDeferrals);
    return deferCurrentDelivery(job, delivery, reason, delay);
  }

  async function processDelivery(job: BusinessJobV1, delivery?: QueueDeliveryControl): Promise<void> {
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
        let claim: Awaited<ReturnType<RuntimeClient['claimTask']>>;
        for (;;) {
          if (stopped) throw new DeliveryRescheduleUnavailableError('worker shutdown');
          if (!admissionOpen) {
            const delayMs = claimDeferralDelayMs(job.deliveryId, claimDeferrals);
            await waitOrDeferClaim(job, delivery, 'WORKER_ADMISSION_CLOSED', delayMs);
            continue;
          }
          try {
            claim = await runtime.claimTask(job.taskId, {
              deliveryId: job.deliveryId,
              workerInstanceId,
              businessId: definition.manifest.businessId,
            });
            if (stopped) {
              // A claim request may outlive the configured shutdown grace.
              // Never start user code from its late response; leave the newly
              // acquired lease to backend recovery and keep the queue delivery
              // recoverable until that lease can be reclaimed.
              await deferClaimAfterLeaseExpiry(job, delivery, 'WORKER_SHUTDOWN', claim.leaseExpiresAt);
            }
            claimDeferrals.delete(job.deliveryId);
            break;
          } catch (err) {
            if (err instanceof RuntimeError && isAckSafeClaimError(err)) {
              claimDeferrals.delete(job.deliveryId);
              logger.info('delivery is already terminal or safely owned elsewhere', {
                status: err.status,
                code: err.code,
              });
              return;
            }
            const code = err instanceof RuntimeError ? err.code : 'TEMPORARY_UNAVAILABLE';
            const retryAfterMs = err instanceof RuntimeError && err.status === 429 ? 5_000 : undefined;
            const delayMs = claimDeferralDelayMs(job.deliveryId, claimDeferrals, retryAfterMs);
            await waitOrDeferClaim(job, delivery, code, delayMs);
          }
        }

        const snapshot = claim.executionSnapshot;
        const incompatibilities = [
          snapshot.businessId === definition.manifest.businessId ? undefined : 'businessId',
          snapshot.businessVersion === definition.manifest.version ? undefined : 'businessVersion',
          snapshot.manifestDigest === localManifestDigest ? undefined : 'manifestDigest',
        ].filter((field): field is string => field !== undefined);
        if (incompatibilities.length > 0) {
          const reason = 'CLAIM_SNAPSHOT_INCOMPATIBLE';
          logger.error('claimed execution snapshot does not match registered manifest', {
            taskId: claim.taskId,
            fields: incompatibilities,
            pinnedBusinessId: snapshot.businessId,
            pinnedBusinessVersion: snapshot.businessVersion,
            pinnedManifestDigest: snapshot.manifestDigest,
            workerBusinessId: definition.manifest.businessId,
            workerBusinessVersion: definition.manifest.version,
            workerManifestDigest: localManifestDigest,
          });
          await deferClaimAfterLeaseExpiry(job, delivery, reason, claim.leaseExpiresAt);
        }
        const handler = definition.handlers[snapshot.kind];
        if (!handler) {
          // A pinned kind absent from this image is a compatibility condition;
          // never terminally fail backlog that may have a compatible consumer.
          logger.error('claimed snapshot kind has no compatible handler', {
            taskId: claim.taskId,
            kind: snapshot.kind,
            manifestDigest: snapshot.manifestDigest,
          });
          await deferClaimAfterLeaseExpiry(job, delivery, 'HANDLER_KIND_UNAVAILABLE', claim.leaseExpiresAt);
          // Keep the absence explicit in the type flow as well: a broken
          // delivery adapter must not let an unsupported handler be invoked.
          throw new DeliveryRescheduleUnavailableError('handler kind unavailable');
        }
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
            tenantDefaults: snapshot.pinned.tenantDefaults,
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
          },
          leaseSafetyMarginMs
        );

        activeContexts.add(ctx);
        let heartbeatInFlight = false;
        let taskHeartbeatTimer: ReturnType<typeof setInterval> | undefined;
        let leaseWatchdogTimer: ReturnType<typeof setTimeout> | undefined;
        const stopLeaseMonitoring = (): void => {
          if (taskHeartbeatTimer) clearInterval(taskHeartbeatTimer);
          if (leaseWatchdogTimer) clearTimeout(leaseWatchdogTimer);
          taskHeartbeatTimer = undefined;
          leaseWatchdogTimer = undefined;
        };
        ctx.signal.addEventListener('abort', stopLeaseMonitoring, { once: true });
        const scheduleLeaseWatchdog = (): void => {
          if (ctx.signal.aborted) return;
          if (leaseWatchdogTimer) clearTimeout(leaseWatchdogTimer);
          const remaining = ctx.leaseWatchdogDeadline() - Date.now();
          if (remaining <= 0) {
            ctx.abort('lease-lost');
            logger.warn('lease watchdog reached safety deadline; aborting context', { taskId: claim.taskId });
            return;
          }
          leaseWatchdogTimer = boundedTimeout(() => {
            if (Date.now() >= ctx.leaseWatchdogDeadline()) {
              ctx.abort('lease-lost');
              logger.warn('lease watchdog reached safety deadline; aborting context', { taskId: claim.taskId });
            } else {
              scheduleLeaseWatchdog();
            }
          }, remaining);
          leaseWatchdogTimer.unref?.();
        };
        const heartbeatTask = (): void => {
          if (ctx.signal.aborted || heartbeatInFlight) return;
          heartbeatInFlight = true;
          void runtime
            .heartbeatTask(claim.taskId, claim.leaseEpoch)
            .then((ack) => {
              if (!ctx.renewLease(ack.leaseExpiresAt)) {
                logger.warn('late or invalid task heartbeat ACK ignored', { taskId: claim.taskId });
                return;
              }
              if (ack.cancelRequested) {
                ctx.abort('cancel');
                return;
              }
              scheduleLeaseWatchdog();
            })
            .catch((err) => {
              if (err instanceof RuntimeError && err.isLeaseLost) {
                logger.warn('runtime rejected task heartbeat lease; aborting context', { taskId: claim.taskId });
                ctx.abort('lease-lost');
              } else if (err instanceof RuntimeError && err.isTaskTerminal) {
                logger.info('task became terminal during heartbeat; stopping local handler', { taskId: claim.taskId });
                ctx.abort('task-terminal');
              } else {
                // A failed request is not evidence of lease renewal. The
                // watchdog remains anchored to the last confirmed expiry.
                logger.warn('task heartbeat failed; lease deadline was not extended', {
                  taskId: claim.taskId,
                  errorCode: err instanceof RuntimeError ? err.code : 'TEMPORARY_UNAVAILABLE',
                });
              }
            })
            .finally(() => {
              heartbeatInFlight = false;
            });
        };
        scheduleLeaseWatchdog();
        if (!ctx.signal.aborted) {
          taskHeartbeatTimer = setInterval(heartbeatTask, heartbeatIntervalMs);
          taskHeartbeatTimer.unref?.();
        }
        activeTaskCount += 1;

        // 3. Run the handler; map the disposition onto runtime reports.
        try {
          if (ctx.signal.aborted) throw new LeaseLostError(ctx.taskId);
          const disposition: TaskDisposition = await handler(ctx);
          if (ctx.signal.aborted || Date.now() >= ctx.leaseWatchdogDeadline()) {
            if (!ctx.signal.aborted) ctx.abort('lease-lost');
            throw new LeaseLostError(ctx.taskId);
          }
          await reportDisposition(runtime, ctx, disposition, logger);
        } catch (err) {
          if (!ctx.signal.aborted && err instanceof RuntimeError && err.isLeaseLost) {
            ctx.abort('lease-lost');
          } else if (!ctx.signal.aborted && err instanceof RuntimeError && err.isTaskTerminal) {
            ctx.abort('task-terminal');
          }
          if (!ctx.signal.aborted && Date.now() >= ctx.leaseWatchdogDeadline()) {
            ctx.abort('lease-lost');
          }
          if (ctx.signal.aborted || err instanceof LeaseLostError) {
            const reason = ctx.signal.reason;
            if (reason === 'cancel' || reason === 'task-terminal') {
              logger.info('terminal cancellation ended local delivery without another report', { taskId: ctx.taskId });
              return;
            }
            logger.warn('handler stopped after lease loss or shutdown; no report sent', {
              taskId: ctx.taskId,
              reason: typeof reason === 'string' ? reason : 'lease-lost',
            });
            const delayMs = Math.max(0, ctx.leaseExpiryDeadline() + leaseSafetyMarginMs - Date.now());
            await deferCurrentDelivery(job, delivery, 'LEASE_RECOVERY', delayMs);
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
          // WORKER-HANDLER-ERROR-STACK-FIX: errorCode alone hid the real
          // exception behind HANDLER_ERROR in live runs. Keep diagnostic
          // source metadata compatible with the content-free log policy.
          logger.error('handler failed', {
            taskId: ctx.taskId,
            errorCode: classified.errorCode,
            retryable: classified.retryable,
            retryAfterMs: classified.retryAfterMs,
            errorName: err instanceof Error ? err.name : typeof err,
            // Only a compiled source location survives the metadata logger.
            // Never expose exception messages, payloads, or arbitrary stack text.
            reason: err instanceof Error
              ? err.stack?.split('\n').slice(1).map((line) =>
                  line.match(/\/app\/(?:node_modules\/@du\/[a-z-]+\/)?dist\/([a-zA-Z0-9_./-]+\.js:\d+:\d+)/)?.[1]
                ).find((site) => site !== undefined)
              : undefined,
          });
          try {
            ctx.assertLeaseActive();
            await runtime.failTask(ctx.taskId, {
              leaseEpoch: ctx.leaseEpoch,
              errorCode: classified.errorCode,
              retryable: classified.retryable,
              retryAfterMs: classified.retryAfterMs,
              detail: classified.detail,
            });
          } catch (reportErr) {
            if (reportErr instanceof RuntimeError && reportErr.isLeaseLost && !ctx.signal.aborted) {
              ctx.abort('lease-lost');
            } else if (reportErr instanceof RuntimeError && reportErr.isTaskTerminal && !ctx.signal.aborted) {
              ctx.abort('task-terminal');
            }
            if (reportErr instanceof LeaseLostError || (reportErr instanceof RuntimeError && reportErr.isLeaseLost)) {
              if (ctx.signal.reason === 'cancel' || ctx.signal.reason === 'task-terminal') return;
              const delayMs = Math.max(0, ctx.leaseExpiryDeadline() + leaseSafetyMarginMs - Date.now());
              await deferCurrentDelivery(job, delivery, 'LEASE_RECOVERY', delayMs);
            }
            if (reportErr instanceof RuntimeError && (reportErr.isLeaseLost || reportErr.isTaskTerminal)) {
              logger.warn('fail report fenced', { taskId: ctx.taskId, code: reportErr.code });
            } else {
              throw reportErr;
            }
          }
        } finally {
          ctx.signal.removeEventListener('abort', stopLeaseMonitoring);
          stopLeaseMonitoring();
          activeContexts.delete(ctx);
          activeTaskCount = Math.max(0, activeTaskCount - 1);
        }
      }
    );
  }

  async function processDeliveryWithTaskReservation(
    job: BusinessJobV1,
    delivery?: QueueDeliveryControl
  ): Promise<void> {
    if (taskReservations.has(job.taskId)) {
      const delayMs = claimDeferralDelayMs(job.deliveryId, claimDeferrals);
      logger.warn('duplicate task delivery deferred while a local handler is active', {
        taskId: job.taskId,
        retryAfterMs: delayMs,
      });
      await deferCurrentDelivery(job, delivery, 'TASK_HANDLER_ACTIVE', delayMs);
      return;
    }

    // The reservation spans claim, user code, and disposition settlement.
    // In particular, aborting the context does not release it while an
    // uncooperative handler promise is still running.
    const reservation = {};
    taskReservations.set(job.taskId, reservation);
    try {
      await processDelivery(job, delivery);
    } finally {
      if (taskReservations.get(job.taskId) === reservation) {
        taskReservations.delete(job.taskId);
      }
    }
  }

  // Register first and consume only after this durable control read. A paused
  // worker continues the heartbeat loop and leaves accepted BullMQ jobs
  // waiting, while any already-running handler retains its task heartbeat.
  try {
    assertStartupActive(config.startupSignal);
    const initialAck = await runtime.heartbeatWorker(workerInstanceId, heartbeatBody(), config.startupSignal);
    await applyAdmissionAck(initialAck);
    if (!initialAck.backupEffectFence) {
      throw new WorkerCompatibilityError(
        'Runtime heartbeat is missing backupEffectFence; this SDK refuses new claims until the runtime supports it.'
      );
    }
    assertStartupActive(config.startupSignal);
    consumer.start((job, delivery) => {
      const p = processDeliveryWithTaskReservation(job, delivery).finally(() => inflight.delete(p));
      inflight.add(p);
      return p;
    });
  } catch (err) {
    if (sweepTimer) clearInterval(sweepTimer);
    await consumer.stop(0).catch((stopErr) => {
      logger.warn('worker consumer cleanup failed after startup refusal', { error: String(stopErr) });
    });
    throw err;
  }
  heartbeatTimer = setInterval(() => {
    runtime.heartbeatWorker(workerInstanceId, heartbeatBody())
      .then(applyAdmissionAck)
      .catch((err) => {
        logger.warn('worker heartbeat failed', { error: String(err) });
      });
  }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  const handle: WorkerHandle = {
    workerInstanceId,
    queueName,
    get stopped() {
      return stopped;
    },
    async stop(graceMs = 15_000): Promise<void> {
      if (stopped) return;
      stopped = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (sweepTimer) clearInterval(sweepTimer);
      for (const resolve of admissionWaiters) resolve();
      admissionWaiters.clear();
      for (const resolve of shutdownWaiters) resolve();
      shutdownWaiters.clear();
      await consumer?.pause?.();
      const deadline = Date.now() + graceMs;
      while (inflight.size > 0 && Date.now() < deadline) {
        let pollTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.allSettled([...inflight]),
            new Promise<void>((resolve) => { pollTimer = setTimeout(resolve, 100); }),
          ]);
        } finally {
          if (pollTimer) clearTimeout(pollTimer);
        }
      }
      if (inflight.size > 0) {
        for (const ctx of activeContexts) ctx.abort('shutdown');
        logger.warn('grace period expired with in-flight deliveries; lease recovery will handle them', {
          count: inflight.size,
        });
      }
      if (consumer) {
        const close = consumer.stop(0).catch((err) => {
          logger.warn('worker consumer shutdown failed', { error: String(err) });
        });
        let closeTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            close,
            new Promise<void>((resolve) => { closeTimer = setTimeout(resolve, 1_000); }),
          ]);
        } finally {
          if (closeTimer) clearTimeout(closeTimer);
        }
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
  ctx.assertLeaseActive();
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
      retryable: err.isRetryable,
      retryAfterMs: err.status === 429 ? 5_000 : undefined,
      detail: err.message.slice(0, 2048),
    };
  }
  if (ConnectorTransportErrorLike(err)) {
    if (err.code === 'INVOCATION_UNKNOWN') {
      // The Connector refused a replay while its ledger still holds this
      // logical invocation (IN_FLIGHT, deliberately without a recovery lease),
      // so the refusal itself never re-sends provider work. The task-level
      // reconciliation is to come back after the first dispatch has settled:
      // the STABLE invocationId then replays the stored result. This is a
      // settle-and-retry, never a blind retry - the ledger still refuses a
      // second send, so the retry cannot execute provider work twice.
      return {
        errorCode: err.code,
        retryable: true,
        retryAfterMs: 5_000,
        detail: err.message.slice(0, 2048),
      };
    }
    const nonRetryableConnectorCode =
      err.code === 'INPUT_HASH_MISMATCH'
      || err.code === 'CANCELLED'
      || err.code === 'CONNECTOR_DISABLED';
    return {
      errorCode: err.code,
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
