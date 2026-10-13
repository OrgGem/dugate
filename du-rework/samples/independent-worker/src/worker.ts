import { randomUUID } from 'node:crypto';
import { DelayedError, Worker } from 'bullmq';
import type { Job } from 'bullmq';
import {
  businessQueueName,
  canonicalize,
  contentHash,
  createManifest,
  manifestDigest,
  type BusinessManifest,
} from './manifest.js';
import {
  isAckSafeClaimError,
  parseBusinessJob,
  parseClaimResult,
  RuntimeClient,
  RuntimeHttpError,
  TaskLeaseError,
  WorkerFailure,
  type BusinessJobV1,
  type ClaimResult,
  type HeartbeatAck,
  type JsonRecord,
} from './protocol.js';

const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;
const DEFAULT_LEASE_SAFETY_MARGIN_MS = 5_000;
const MAX_TIMER_DELAY_MS = 2_147_000_000;

export interface QueueDeliveryControl {
  defer(delayMs: number): Promise<never>;
}

class QueueDeliveryDeferred extends Error {
  constructor(readonly queueError: unknown) {
    super('queue delivery was deferred');
    this.name = 'QueueDeliveryDeferred';
  }
}

export interface QueueConsumer {
  start(handler: (payload: unknown, delivery?: QueueDeliveryControl) => Promise<void>): void;
  pause(): Promise<void> | void;
  resume(): Promise<void> | void;
  stop(graceMs: number): Promise<void>;
}

export interface TaskContext {
  readonly taskId: string;
  readonly operationId: string;
  readonly tenantId: string;
  readonly action: string;
  readonly kind: string;
  readonly attempt: number;
  readonly leaseEpoch: number;
  readonly deadlineAt: string | null;
  readonly input: Readonly<Record<string, unknown>>;
  readonly signal: AbortSignal;
  assertLeaseActive(): void;
  assertExternalEffectAllowed(): void;
}

export type TaskHandler = (context: TaskContext) => Promise<unknown>;

export interface WorkerConfig {
  runtimeUrl: string;
  runtimeToken: string;
  redisUrl?: string;
  concurrency?: number;
  deploymentRevision?: string;
  requestTimeoutMs?: number;
  heartbeatIntervalMs?: number;
  leaseSafetyMarginMs?: number;
  consumer?: QueueConsumer;
  fetchImpl?: typeof fetch;
  handler?: TaskHandler;
}

export interface WorkerHandle {
  readonly workerInstanceId: string;
  readonly queueName: string;
  readonly stopped: boolean;
  refresh(): Promise<void>;
  stop(graceMs?: number): Promise<void>;
}

interface ActiveTaskContext extends TaskContext {
  abort(reason: TaskLeaseError['reason']): void;
  renewLease(leaseExpiresAt: string): boolean;
  leaseExpiryDeadline(): number;
  leaseWatchdogDeadline(): number;
  startMonitoring(): void;
  stopMonitoring(): void;
}

export function createEchoResult(context: Pick<TaskContext, 'input' | 'action' | 'kind'>): string {
  if (context.action !== 'echo' || context.kind !== 'root') {
    throw new WorkerFailure('UNSUPPORTED_WORKER_PROTOCOL', false);
  }
  const keys = Object.keys(context.input);
  if (keys.length !== 1 || keys[0] !== 'text' || typeof context.input.text !== 'string') {
    throw new WorkerFailure('UNSUPPORTED_WORKER_PROTOCOL', false);
  }
  if (context.input.text.length < 1 || context.input.text.length > 32_768) {
    throw new WorkerFailure('INVALID_INPUT', false);
  }
  const result = { text: context.input.text };
  return canonicalize(result);
}

export function createBullMQConsumer(options: {
  queueName: string;
  redisUrl: string;
  concurrency: number;
}): QueueConsumer {
  let worker: Worker<unknown> | undefined;
  let handler: ((payload: unknown, delivery?: QueueDeliveryControl) => Promise<void>) | undefined;
  let paused = true;
  let running = false;

  const run = (): void => {
    if (!worker || running || paused) return;
    running = true;
    void worker.run().catch(() => {
      // Do not expose queue payloads, credentials, or Redis URLs in logs.
      process.stderr.write('independent-worker: queue consumer stopped unexpectedly\n');
    });
  };

  return {
    start(nextHandler): void {
      if (worker) throw new Error('queue consumer can only be started once');
      handler = nextHandler;
      worker = new Worker<unknown>(
        options.queueName,
        async (job: Job<unknown>, token: string | undefined) => {
          if (!handler) throw new Error('queue consumer handler is unavailable');
          await handler(job.data, {
            defer: async (delayMs) => {
              if (!token) throw new Error('BullMQ did not provide a delivery lock token');
              await job.moveToDelayed(Date.now() + Math.max(0, Math.ceil(delayMs)), token);
              throw new DelayedError();
            },
          });
        },
        {
          connection: { url: options.redisUrl },
          concurrency: options.concurrency,
          removeOnComplete: { age: 86_400 },
          removeOnFail: { age: 7 * 86_400 },
          autorun: false,
        },
      );
      run();
    },
    async pause(): Promise<void> {
      paused = true;
      if (worker && running) await worker.pause(true);
    },
    resume(): void {
      paused = false;
      if (!worker) return;
      if (running) worker.resume();
      else run();
    },
    async stop(_graceMs: number): Promise<void> {
      paused = true;
      const current = worker;
      worker = undefined;
      running = false;
      handler = undefined;
      if (current) await current.close(true);
    },
  };
}

export async function startWorker(manifest: BusinessManifest, config: WorkerConfig): Promise<WorkerHandle> {
  assertSupportedManifest(manifest);
  const digest = manifestDigest(manifest);
  const queueName = businessQueueName(manifest.businessId, manifest.version);
  const concurrency = config.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 1000) {
    throw new Error('WORKER_CONCURRENCY must be an integer from 1 through 1000');
  }
  const heartbeatIntervalMs = config.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;
  const configuredSafetyMarginMs = Math.max(0, config.leaseSafetyMarginMs ?? DEFAULT_LEASE_SAFETY_MARGIN_MS);
  if (!Number.isSafeInteger(heartbeatIntervalMs) || heartbeatIntervalMs < 1_000 || heartbeatIntervalMs > 30_000) {
    throw new Error('WORKER_HEARTBEAT_INTERVAL_MS must be from 1000 through 30000');
  }
  if (!Number.isSafeInteger(configuredSafetyMarginMs) || configuredSafetyMarginMs > 15_000) {
    throw new Error('WORKER_LEASE_SAFETY_MARGIN_MS must be from 0 through 15000');
  }
  const requestTimeoutMs = config.requestTimeoutMs ?? 10_000;
  if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1_000 || requestTimeoutMs > 30_000) {
    throw new Error('RUNTIME_REQUEST_TIMEOUT_MS must be from 1000 through 30000');
  }
  const consumer = config.consumer ?? (() => {
    if (!config.redisUrl) throw new Error('REDIS_URL or an injected queue consumer is required');
    return createBullMQConsumer({ queueName, redisUrl: config.redisUrl, concurrency });
  })();
  const runtime = new RuntimeClient({
    baseUrl: config.runtimeUrl,
    token: config.runtimeToken,
    timeoutMs: requestTimeoutMs,
    fetchImpl: config.fetchImpl,
  });
  const registration = await runtime.registerBusinessVersion(manifest);
  if (registration.digest !== digest || registration.queue !== queueName) {
    throw new Error('Runtime registration identity does not match this worker build');
  }

  // A Runtime inventory row represents one process boot. Never reuse a static
  // replica name: retirement is fenced to this exact identity.
  const workerInstanceId = randomUUID();
  const handler = config.handler ?? createEchoResult;

  let stopped = false;
  let retired = false;
  let admissionOpen = false;
  let workerHeartbeatInFlight: Promise<HeartbeatAck> | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let workerControlRevision = -1;
  let workerControlState: HeartbeatAck['controlState'] = 'DRAINING';
  let backupFenceRevision = -1;
  let backupFenceState: 'OPEN' | 'HELD' | 'UNKNOWN' = 'UNKNOWN';
  let backupFenceAcknowledged = false;
  let observedBackupFenceRevision: number | undefined;
  let activeTaskCount = 0;
  let stopPromise: Promise<void> | undefined;
  const activeTasks = new Set<ActiveTaskContext>();
  const taskReservations = new Set<string>();
  const inFlight = new Set<Promise<void>>();

  const heartbeatBody = (): JsonRecord => ({
    businessId: manifest.businessId,
    businessVersion: manifest.version,
    manifestDigest: digest,
    imageDigest: manifest.imageDigest,
    ...(config.deploymentRevision ? { deploymentRevision: config.deploymentRevision } : {}),
    capacity: admissionOpen ? concurrency : 0,
    activeTasks: activeTaskCount,
    ...(observedBackupFenceRevision === undefined ? {} : { observedBackupFenceRevision }),
  });

  async function updateAdmission(nextOpen: boolean): Promise<void> {
    if (stopped) nextOpen = false;
    if (admissionOpen === nextOpen) return;
    admissionOpen = nextOpen;
    if (nextOpen) await consumer.resume();
    else await consumer.pause();
  }

  async function applyHeartbeatAck(ack: HeartbeatAck): Promise<void> {
    if (retired) return;
    if (!ack.backupEffectFence) {
      backupFenceState = 'UNKNOWN';
      backupFenceRevision = -1;
      backupFenceAcknowledged = false;
      observedBackupFenceRevision = undefined;
      workerControlState = 'DRAINING';
      await updateAdmission(false);
      for (const context of activeTasks) context.abort('compatibility');
      throw new WorkerFailure('WORKER_COMPATIBILITY_REQUIRED', false);
    }

    if (ack.controlRevision >= workerControlRevision) {
      workerControlRevision = ack.controlRevision;
      workerControlState = ack.controlState;
    }
    const backup = ack.backupEffectFence;
    if (backup.revision > backupFenceRevision) {
      backupFenceRevision = backup.revision;
      backupFenceState = backup.state;
      backupFenceAcknowledged = backup.acknowledged;
      observedBackupFenceRevision = backup.revision;
    } else if (backup.revision === backupFenceRevision) {
      backupFenceState = backup.state;
      backupFenceAcknowledged ||= backup.acknowledged;
      observedBackupFenceRevision = backup.revision;
    }

    await updateAdmission(
      workerControlState === 'OPEN'
      && backupFenceState === 'OPEN'
      && backupFenceAcknowledged,
    );
  }

  function heartbeatRequest(): Promise<HeartbeatAck> {
    if (workerHeartbeatInFlight) return workerHeartbeatInFlight;
    if (retired) return Promise.reject(new Error('worker is retired'));
    let current!: Promise<HeartbeatAck>;
    current = runtime.heartbeatWorker(workerInstanceId, heartbeatBody()).finally(() => {
      if (workerHeartbeatInFlight === current) workerHeartbeatInFlight = undefined;
    });
    workerHeartbeatInFlight = current;
    return current;
  }

  async function heartbeat(strict: boolean): Promise<void> {
    if (retired) return;
    try {
      await applyHeartbeatAck(await heartbeatRequest());
    } catch (error) {
      await updateAdmission(false).catch(() => undefined);
      if (strict) throw error;
      process.stderr.write('independent-worker: Runtime heartbeat failed; task admission is closed\n');
    }
  }

  await heartbeat(true);
  if (backupFenceRevision < 0) throw new WorkerFailure('WORKER_COMPATIBILITY_REQUIRED', false);
  if (!backupFenceAcknowledged) {
    // The server acknowledges only the exact revision reported by the worker.
    // Repeat once during startup so an open fence need not wait a full interval.
    await heartbeat(true);
  }

  const taskHandler = async (payload: unknown, delivery?: QueueDeliveryControl): Promise<void> => {
    try {
      const job = parseBusinessJob(payload);
      if (job.businessId !== manifest.businessId || job.businessVersion !== manifest.version) {
        throw new Error('queue delivery does not match this exact business version');
      }
      if (stopped || !admissionOpen) await deferDelivery(delivery, 'worker admission is closed', 1_000);
      if (taskReservations.has(job.taskId)) await deferDelivery(delivery, 'task already active in this process', 1_000);
      taskReservations.add(job.taskId);
      try {
        await processDelivery(job, delivery);
      } finally {
        taskReservations.delete(job.taskId);
      }
    } catch (error) {
      if (error instanceof QueueDeliveryDeferred) throw error.queueError;
      throw error;
    }
  };

  async function processDelivery(job: BusinessJobV1, delivery?: QueueDeliveryControl): Promise<void> {
    if (stopped) await deferDelivery(delivery, 'worker is stopping', 1_000);
    if (!admissionOpen) await deferDelivery(delivery, 'worker admission is closed', 1_000);

    let claim: ClaimResult;
    try {
      claim = await runtime.claimTask(job.taskId, {
        deliveryId: job.deliveryId,
        workerInstanceId,
        businessId: manifest.businessId,
      });
    } catch (error) {
      if (error instanceof RuntimeHttpError && isAckSafeClaimError(error)) return;
      const delay = error instanceof RuntimeHttpError && error.status === 429 ? 5_000 : 1_000;
      return await deferDelivery(delivery, 'claim was not confirmed', delay);
    }

    if (
      claim.taskId !== job.taskId
      || claim.operationId !== job.operationId
      || claim.executionSnapshot.operationId !== job.operationId
    ) {
      await deferUntilLeaseExpiry(delivery, claim.leaseExpiresAt, configuredSafetyMarginMs, 'claim identity did not match delivery');
    }
    if (stopped) await deferUntilLeaseExpiry(delivery, claim.leaseExpiresAt, configuredSafetyMarginMs, 'worker is draining');

    const compatibility = checkClaimCompatibility(claim, job, manifest, digest);
    if (compatibility === 'manifest-mismatch') {
      await deferUntilLeaseExpiry(delivery, claim.leaseExpiresAt, configuredSafetyMarginMs, 'claim manifest identity did not match');
    }
    const taskContext = createTaskContext({
      claim,
      input: claim.executionSnapshot.resolvedInputRef,
      safetyMarginMs: configuredSafetyMarginMs,
      heartbeatIntervalMs,
      runtime,
      isEffectAdmissionOpen: () => admissionOpen
        && workerControlState === 'OPEN'
        && backupFenceState === 'OPEN'
        && backupFenceAcknowledged,
    });
    activeTasks.add(taskContext);
    activeTaskCount += 1;
    taskContext.startMonitoring();

    if (claim.executionSnapshot.cancelRequested) taskContext.abort('cancel');
    try {
      if (taskContext.signal.aborted) throw new TaskLeaseError(taskContext.signal.reason as TaskLeaseError['reason']);
      if (compatibility === 'unsupported') throw new WorkerFailure('UNSUPPORTED_WORKER_PROTOCOL', false);
      const resultRef = await handler(taskContext);
      taskContext.assertLeaseActive();
      const serializedRef = typeof resultRef === 'string' ? resultRef : JSON.stringify(resultRef);
      if (serializedRef === undefined) throw new WorkerFailure('INVALID_RESULT', false);
      await reportTaskSettlement('complete', () => runtime.completeTask(claim.taskId, {
          leaseEpoch: claim.leaseEpoch,
          resultRef: serializedRef,
          resultHash: contentHash(serializedRef),
          outputArtifactIds: [],
        }), taskContext, delivery, configuredSafetyMarginMs);
    } catch (error) {
      if (error instanceof QueueDeliveryDeferred) throw error;
      if (taskContext.signal.aborted || error instanceof TaskLeaseError) {
        await settleAbortedDelivery(taskContext, delivery, configuredSafetyMarginMs);
        return;
      }
      const failure = classifyFailure(error);
      try {
        taskContext.assertLeaseActive();
        await reportTaskSettlement('fail', () => runtime.failTask(claim.taskId, {
          leaseEpoch: claim.leaseEpoch,
          errorCode: failure.code,
          retryable: failure.retryable,
          ...(failure.retryAfterMs === undefined ? {} : { retryAfterMs: failure.retryAfterMs }),
          ...(failure.detail ? { detail: failure.detail } : {}),
        }), taskContext, delivery, configuredSafetyMarginMs);
      } catch (reportError) {
        if (reportError instanceof QueueDeliveryDeferred) throw reportError;
        if (isTerminalOrFenced(reportError, taskContext)) {
          await settleAbortedDelivery(taskContext, delivery, configuredSafetyMarginMs);
          return;
        }
        if (reportError instanceof TaskLeaseError || taskContext.signal.aborted) {
          await settleAbortedDelivery(taskContext, delivery, configuredSafetyMarginMs);
          return;
        }
        throw reportError;
      }
    } finally {
      taskContext.stopMonitoring();
      activeTasks.delete(taskContext);
      activeTaskCount = Math.max(0, activeTaskCount - 1);
    }
  }

  consumer.start((payload, delivery) => {
    const operation = taskHandler(payload, delivery);
    inFlight.add(operation);
    void operation.then(
      () => inFlight.delete(operation),
      () => inFlight.delete(operation),
    );
    return operation;
  });
  if (admissionOpen) await consumer.resume();
  heartbeatTimer = setInterval(() => { void heartbeat(false); }, heartbeatIntervalMs);
  heartbeatTimer.unref?.();

  return {
    workerInstanceId,
    queueName,
    get stopped() { return stopped; },
    refresh: () => heartbeat(false),
    stop(graceMs = 15_000): Promise<void> {
      if (stopPromise) return stopPromise;
      stopped = true;
      const deadline = Date.now() + Math.max(0, graceMs);
      stopPromise = (async () => {
        admissionOpen = false;
        await withTimeout(Promise.resolve().then(() => consumer.pause()), 1_000);
        while (inFlight.size > 0 && Date.now() < deadline) {
          await Promise.race([
            Promise.allSettled([...inFlight]),
            wait(Math.min(100, Math.max(0, deadline - Date.now()))),
          ]);
        }
        if (inFlight.size > 0) {
          for (const context of activeTasks) context.abort('shutdown');
        }
        const closed = await withTimeout(Promise.resolve().then(() => consumer.stop(0)), 1_000);
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        heartbeatTimer = undefined;
        const heartbeatFinished = workerHeartbeatInFlight
          ? await withTimeout(workerHeartbeatInFlight.then(() => undefined, () => undefined), 1_000)
          : true;
        if (!closed || !heartbeatFinished || inFlight.size > 0 || activeTasks.size > 0) {
          process.stderr.write('independent-worker: consumer or heartbeat did not settle; retirement skipped\n');
          retired = true;
          return;
        }
        retired = true;
        try {
          await runtime.retireWorker(workerInstanceId, {
            businessId: manifest.businessId,
            businessVersion: manifest.version,
            manifestDigest: digest,
          });
        } catch {
          process.stderr.write('independent-worker: Runtime worker retirement failed\n');
        }
      })();
      return stopPromise;
    },
  };

}

function assertSupportedManifest(manifest: BusinessManifest): void {
  const expected = createManifest(manifest.version, manifest.imageDigest);
  if (canonicalize(manifest) !== canonicalize(expected)) {
    throw new Error('sample worker only supports its own inline echo manifest');
  }
}

function checkClaimCompatibility(
  claim: ClaimResult,
  job: BusinessJobV1,
  manifest: BusinessManifest,
  expectedDigest: string,
): 'manifest-mismatch' | 'unsupported' | null {
  const snapshot = claim.executionSnapshot;
  if (
    snapshot.businessId !== manifest.businessId
    || snapshot.businessVersion !== manifest.version
    || snapshot.manifestDigest !== expectedDigest
    || job.businessId !== snapshot.businessId
    || job.businessVersion !== snapshot.businessVersion
  ) return 'manifest-mismatch';

  if (
    snapshot.action !== 'echo'
    || snapshot.kind !== 'root'
    || snapshot.taskKey !== 'root'
    || Object.keys(snapshot.payloadRef).length > 0
    || claim.checkpointRefs.length > 0
  ) return 'unsupported';

  const inputKeys = Object.keys(snapshot.resolvedInputRef);
  if (
    inputKeys.length !== 1
    || inputKeys[0] !== 'text'
    || typeof snapshot.resolvedInputRef.text !== 'string'
    || snapshot.resolvedInputRef.text.length < 1
    || snapshot.resolvedInputRef.text.length > 32_768
  ) return 'unsupported';

  const pinned = snapshot.pinned;
  const bindings = pinned.connectorBindings;
  const promptRevisions = pinned.promptRevisions;
  const promptOverrides = pinned.promptOverrides;
  const tenantDefaults = pinned.tenantDefaults;
  if (
    pinned.profilePolicy !== null && pinned.profilePolicy !== undefined
    || isNonEmptyRecord(bindings)
    || isNonEmptyRecord(promptRevisions)
    || Array.isArray(promptOverrides) && promptOverrides.length > 0
    || tenantDefaults !== null && tenantDefaults !== undefined
  ) return 'unsupported';
  return null;
}

function createTaskContext(options: {
  claim: ClaimResult;
  input: JsonRecord;
  safetyMarginMs: number;
  heartbeatIntervalMs: number;
  runtime: RuntimeClient;
  isEffectAdmissionOpen: () => boolean;
}): ActiveTaskContext {
  const { claim } = options;
  const controller = new AbortController();
  let leaseExpiresAtMs = Date.parse(claim.leaseExpiresAt);
  let safetyMarginMs = Math.min(
    options.safetyMarginMs,
    Math.max(0, Math.floor((leaseExpiresAtMs - Date.now()) / 4)),
  );
  let heartbeatInFlight = false;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let watchdogTimer: ReturnType<typeof setTimeout> | undefined;

  const context: ActiveTaskContext = {
    taskId: claim.taskId,
    operationId: claim.operationId,
    tenantId: claim.executionSnapshot.tenantId,
    action: claim.executionSnapshot.action,
    kind: claim.executionSnapshot.kind,
    attempt: claim.attempt,
    leaseEpoch: claim.leaseEpoch,
    deadlineAt: claim.deadlineAt,
    input: options.input,
    signal: controller.signal,
    abort(reason): void {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    leaseExpiryDeadline: () => leaseExpiresAtMs,
    leaseWatchdogDeadline: () => leaseExpiresAtMs - safetyMarginMs,
    assertLeaseActive(): void {
      if (controller.signal.aborted) throw new TaskLeaseError(controller.signal.reason as TaskLeaseError['reason']);
      if (!Number.isFinite(leaseExpiresAtMs) || Date.now() >= leaseExpiresAtMs - safetyMarginMs) {
        context.abort('lease-lost');
        throw new TaskLeaseError('lease-lost');
      }
      if (context.deadlineAt && Date.parse(context.deadlineAt) <= Date.now()) {
        throw new WorkerFailure('OPERATION_DEADLINE_EXCEEDED', false);
      }
    },
    assertExternalEffectAllowed(): void {
      context.assertLeaseActive();
      if (!options.isEffectAdmissionOpen()) throw new WorkerFailure('WORKER_ADMISSION_CLOSED', true, 1_000);
    },
    renewLease(expiresAt): boolean {
      if (controller.signal.aborted || !Number.isFinite(leaseExpiresAtMs) || Date.now() >= leaseExpiresAtMs - safetyMarginMs) {
        context.abort('lease-lost');
        return false;
      }
      const nextExpiry = Date.parse(expiresAt);
      if (!Number.isFinite(nextExpiry) || nextExpiry <= Date.now()) {
        context.abort('lease-lost');
        return false;
      }
      leaseExpiresAtMs = nextExpiry;
      safetyMarginMs = Math.min(options.safetyMarginMs, Math.floor((nextExpiry - Date.now()) / 4));
      scheduleWatchdog();
      return true;
    },
    startMonitoring(): void {
      scheduleWatchdog();
      heartbeatTimer = setInterval(() => {
        if (controller.signal.aborted || heartbeatInFlight) return;
        heartbeatInFlight = true;
        void options.runtime.heartbeatTask(claim.taskId, claim.leaseEpoch, controller.signal)
          .then((ack) => {
            if (!context.renewLease(ack.leaseExpiresAt)) return;
            if (ack.cancelRequested) context.abort('cancel');
          })
          .catch((error: unknown) => {
            if (error instanceof RuntimeHttpError && error.isLeaseLost) context.abort('lease-lost');
            else if (error instanceof RuntimeHttpError && error.isTaskTerminal) context.abort('task-terminal');
          })
          .finally(() => { heartbeatInFlight = false; });
      }, options.heartbeatIntervalMs);
      heartbeatTimer.unref?.();
    },
    stopMonitoring(): void {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (watchdogTimer) clearTimeout(watchdogTimer);
      heartbeatTimer = undefined;
      watchdogTimer = undefined;
    },
  };

  function scheduleWatchdog(): void {
    if (controller.signal.aborted) return;
    if (watchdogTimer) clearTimeout(watchdogTimer);
    const remaining = context.leaseWatchdogDeadline() - Date.now();
    if (remaining <= 0) {
      context.abort('lease-lost');
      return;
    }
    watchdogTimer = setTimeout(() => {
      if (Date.now() >= context.leaseWatchdogDeadline()) context.abort('lease-lost');
      else scheduleWatchdog();
    }, Math.min(MAX_TIMER_DELAY_MS, remaining));
    watchdogTimer.unref?.();
  }

  return context;
}

function classifyFailure(error: unknown): {
  code: string;
  retryable: boolean;
  retryAfterMs?: number;
  detail?: string;
} {
  if (error instanceof TaskLeaseError) {
    return { code: 'LEASE_LOST', retryable: true, detail: 'Task lease ended before settlement.' };
  }
  if (error instanceof WorkerFailure) {
    return {
      code: error.code,
      retryable: error.retryable,
      ...(error.retryAfterMs === undefined ? {} : { retryAfterMs: error.retryAfterMs }),
      detail: error.code,
    };
  }
  if (error instanceof RuntimeHttpError) {
    return { code: error.code, retryable: error.retryable, detail: error.code };
  }
  return { code: 'HANDLER_ERROR', retryable: false, detail: 'Sample handler failed.' };
}

async function reportTaskSettlement(
  kind: 'complete' | 'fail',
  report: () => Promise<{ taskId: string; state: string; operationState: string; replayed: boolean }>,
  context: ActiveTaskContext,
  delivery: QueueDeliveryControl | undefined,
  safetyMarginMs: number,
): Promise<void> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    context.assertLeaseActive();
    try {
      const ack = await report();
      const confirmed = kind === 'complete'
        ? ack.state === 'SUCCEEDED' && ack.operationState === 'SUCCEEDED'
        : ['RETRY_PENDING', 'FAILED', 'CANCELLED'].includes(ack.state)
          && ['RETRY_PENDING', 'FAILED', 'CANCELLED'].includes(ack.operationState);
      if (!confirmed) throw new RuntimeHttpError(200, 'INVALID_SETTLEMENT_ACK', true, true);
      return;
    } catch (error) {
      if (error instanceof TaskLeaseError) throw error;
      if (isTerminalOrFenced(error, context)) throw error;
      if (context.signal.aborted) throw new TaskLeaseError(context.signal.reason as TaskLeaseError['reason']);
      if (error instanceof RuntimeHttpError && error.ambiguous && attempt === 0) continue;
      await deferUntilLeaseExpiry(
        delivery,
        new Date(context.leaseExpiryDeadline()).toISOString(),
        safetyMarginMs,
        'Runtime settlement was not confirmed',
      );
    }
  }
}

function isTerminalOrFenced(error: unknown, context: TaskContext): boolean {
  if (error instanceof RuntimeHttpError && (error.isLeaseLost || error.isTaskTerminal)) {
    const reason = error.isLeaseLost ? 'lease-lost' : 'task-terminal';
    (context as ActiveTaskContext).abort(reason);
    return true;
  }
  return context.signal.aborted;
}

async function settleAbortedDelivery(
  context: ActiveTaskContext,
  delivery: QueueDeliveryControl | undefined,
  safetyMarginMs: number,
): Promise<void> {
  const reason = context.signal.reason as TaskLeaseError['reason'] | undefined;
  if (reason === 'cancel' || reason === 'task-terminal') return;
  const delayMs = Math.max(0, context.leaseExpiryDeadline() + safetyMarginMs - Date.now());
  await deferDelivery(delivery, 'lease recovery owns this delivery', Math.min(24 * 60 * 60_000, delayMs));
}

async function deferUntilLeaseExpiry(
  delivery: QueueDeliveryControl | undefined,
  leaseExpiresAt: string,
  safetyMarginMs: number,
  reason: string,
): Promise<never> {
  const expiry = Date.parse(leaseExpiresAt);
  const delayMs = Number.isFinite(expiry)
    ? Math.max(1_000, expiry + safetyMarginMs - Date.now())
    : 5_000;
  return deferDelivery(delivery, reason, Math.min(24 * 60 * 60_000, delayMs));
}

async function deferDelivery(
  delivery: QueueDeliveryControl | undefined,
  _reason: string,
  delayMs: number,
): Promise<never> {
  if (!delivery) throw new QueueDeliveryDeferred(new Error('queue adapter cannot safely defer this delivery'));
  try {
    await delivery.defer(Math.max(0, Math.ceil(delayMs)));
  } catch (error) {
    throw new QueueDeliveryDeferred(error);
  }
  throw new QueueDeliveryDeferred(new Error('queue defer adapter returned unexpectedly'));
}

function isNonEmptyRecord(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length > 0;
}

function wait(durationMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, Math.max(0, durationMs)));
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise.then(() => true, () => false),
      new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
