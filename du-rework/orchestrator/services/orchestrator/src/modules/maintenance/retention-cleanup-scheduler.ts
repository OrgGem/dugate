import type { RetentionPolicySnapshot } from '@du/contracts';
import type { Db } from '../../db/db';

const MAX_NODE_TIMEOUT_MS = 2_147_000_000;
const DEFAULT_POLICY_REFRESH_MS = 30_000;
const POLICY_READ_RETRY_MS = 5_000;
const RETENTION_LOCK_NAME = 'du-platform-retention-cleanup-v1';

export interface RetentionCleanupMaintenancePort {
  createMaintenancePreview(actor: { actor: string; actorRole: string }, request: unknown): Promise<{
    previewId: string;
    expectedVersion: string;
    eligibleCount: number;
  }>;
  startMaintenanceJob(actor: { actor: string; actorRole: string }, request: unknown): Promise<unknown>;
}

export interface RetentionCleanupSchedulerOptions {
  db: Db;
  maintenance: RetentionCleanupMaintenancePort;
  getEffectiveRetentionPolicy(): Promise<RetentionPolicySnapshot>;
  now?: () => number;
  onError?: (error: unknown) => void;
  batchSize?: number;
  /** Testable bounded policy polling cadence; production uses 30 seconds. */
  policyRefreshIntervalMs?: number;
}

/**
 * Applies the published platform cleanup cadence by enqueueing the ordinary,
 * durable maintenance retention job. The scheduler owns no cleanup logic and
 * never deletes objects itself. It periodically re-reads the durable policy on
 * every replica (including when cleanup is disabled), then relies on the
 * cross-replica advisory lock and durable job idempotency for a single enqueue.
 */
export function createRetentionCleanupScheduler(options: RetentionCleanupSchedulerOptions): {
  start(): void;
  refresh(): void;
  stop(): Promise<void>;
} {
  const now = options.now ?? Date.now;
  const batchSize = Math.max(1, Math.min(500, Math.trunc(options.batchSize ?? 100)));
  const refreshMs = Math.max(100, Math.min(DEFAULT_POLICY_REFRESH_MS, Math.trunc(options.policyRefreshIntervalMs ?? DEFAULT_POLICY_REFRESH_MS)));
  let timer: NodeJS.Timeout | undefined;
  let generation = 0;
  let stopped = false;
  let active: Promise<number> | undefined;
  let refreshQueued = false;
  let currentPolicy: RetentionPolicySnapshot | undefined;
  let nextCleanupAt: number | undefined;

  function report(error: unknown): void {
    try { options.onError?.(error); } catch { /* telemetry cannot alter the schedule */ }
  }

  function clearTimer(): void {
    if (timer) clearTimeout(timer);
    timer = undefined;
  }

  function validatePolicy(policy: RetentionPolicySnapshot): void {
    if (!Number.isSafeInteger(policy.revision) || policy.revision < 0
        || !Number.isSafeInteger(policy.cleanupIntervalSeconds) || policy.cleanupIntervalSeconds < 0
        || policy.cleanupIntervalSeconds > 31_536_000) {
      throw new Error('effective retention cleanup interval is invalid');
    }
  }

  function nextSlotAt(value: number, intervalSeconds: number): number {
    const intervalMs = intervalSeconds * 1000;
    if (!Number.isSafeInteger(intervalMs) || intervalMs <= 0) throw new Error('retention cleanup interval is invalid');
    return (Math.floor(value / intervalMs) + 1) * intervalMs;
  }

  function schedule(delayMs: number, scheduleGeneration: number): void {
    if (stopped || scheduleGeneration !== generation) return;
    clearTimer();
    const safeDelay = Math.min(MAX_NODE_TIMEOUT_MS, Math.max(0, Math.trunc(delayMs)));
    timer = setTimeout(() => {
      timer = undefined;
      trigger(scheduleGeneration);
    }, safeDelay);
    timer.unref?.();
  }

  async function enqueueScheduledCleanup(
    scheduleGeneration: number,
    policy: RetentionPolicySnapshot,
  ): Promise<boolean> {
    if (stopped || scheduleGeneration !== generation) return true;
    const intervalMs = policy.cleanupIntervalSeconds * 1000;
    const slot = Math.floor(now() / intervalMs);
    const idempotencyKey = `retention-cleanup:${policy.revision}:${slot}`;
    const client = await options.db.pool.connect();
    let locked = false;
    try {
      const lock = await client.query<{ locked: boolean }>(
        'SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS locked',
        [RETENTION_LOCK_NAME],
      );
      locked = lock.rows[0]?.locked === true;
      if (!locked) return false;

      // A prior call may have committed the durable job and lost its response.
      // Check the stable slot key before creating another preview; the job row
      // itself is the replay receipt and no new snapshot input is resolved.
      const prior = await options.db.query(
        'SELECT 1 FROM maintenance_jobs WHERE idempotency_key=$1 LIMIT 1',
        [idempotencyKey],
      );
      if (prior.rowCount) return true;

      const latest = await options.getEffectiveRetentionPolicy();
      validatePolicy(latest);
      if (latest.revision !== policy.revision
          || latest.cleanupIntervalSeconds !== policy.cleanupIntervalSeconds
          || latest.cleanupIntervalSeconds === 0
          || stopped || scheduleGeneration !== generation) return true;

      const actor = { actor: 'system:retention-cleanup-scheduler', actorRole: 'system' };
      const preview = await options.maintenance.createMaintenancePreview(actor, {
        kind: 'retention_cleanup',
        scope: { kind: 'platform' },
        filters: { maxItems: batchSize },
        reason: `scheduled platform retention cleanup revision ${latest.revision}`,
      });
      if (preview.eligibleCount < 1) return true;
      await options.maintenance.startMaintenanceJob(actor, {
        previewId: preview.previewId,
        expectedVersion: preview.expectedVersion,
        idempotencyKey,
        reason: `scheduled platform retention cleanup revision ${latest.revision}`,
      });
      return true;
    } finally {
      if (locked) {
        await client.query('SELECT pg_advisory_unlock(hashtextextended($1,0))', [RETENTION_LOCK_NAME]).catch(report);
      }
      client.release();
    }
  }

  async function performTick(scheduleGeneration: number): Promise<number> {
    if (stopped || scheduleGeneration !== generation) return refreshMs;
    let policy: RetentionPolicySnapshot;
    try {
      policy = await options.getEffectiveRetentionPolicy();
      validatePolicy(policy);
    } catch (error) {
      report(error);
      return POLICY_READ_RETRY_MS;
    }

    const changed = currentPolicy === undefined
      || currentPolicy.revision !== policy.revision
      || currentPolicy.cleanupIntervalSeconds !== policy.cleanupIntervalSeconds;
    if (changed) {
      currentPolicy = policy;
      nextCleanupAt = policy.cleanupIntervalSeconds === 0
        ? undefined
        : nextSlotAt(now(), policy.cleanupIntervalSeconds);
    }
    if (policy.cleanupIntervalSeconds === 0 || nextCleanupAt === undefined) return refreshMs;

    if (now() < nextCleanupAt) return Math.min(refreshMs, nextCleanupAt - now());
    if (stopped || scheduleGeneration !== generation) return refreshMs;

    try {
      const completed = await enqueueScheduledCleanup(scheduleGeneration, policy);
      if (!completed) return POLICY_READ_RETRY_MS;
      // If no candidate existed, the tick was still handled. Advance to the
      // next fixed cadence slot and continue checking for cross-replica edits.
      nextCleanupAt = nextSlotAt(now(), policy.cleanupIntervalSeconds);
      return Math.min(refreshMs, nextCleanupAt - now());
    } catch (error) {
      report(error);
      // Keep the due slot and retry. If a job committed before a transport or
      // process error, the next attempt finds its stable idempotency receipt.
      return POLICY_READ_RETRY_MS;
    }
  }

  function trigger(scheduleGeneration: number): void {
    if (stopped || scheduleGeneration !== generation) return;
    if (active) {
      refreshQueued = true;
      return;
    }
    const task = performTick(scheduleGeneration);
    active = task;
    void task.then((delay) => {
      if (active === task) active = undefined;
      if (stopped) return;
      if (refreshQueued) {
        refreshQueued = false;
        trigger(generation);
      } else if (scheduleGeneration === generation) {
        schedule(delay, scheduleGeneration);
      }
    }, (error: unknown) => {
      // `performTick` is defensive, but this final catch ensures no timer
      // callback can create an unhandled rejection if a future edit regresses.
      report(error);
      if (active === task) active = undefined;
      if (stopped) return;
      if (refreshQueued) {
        refreshQueued = false;
        trigger(generation);
      } else if (scheduleGeneration === generation) {
        schedule(POLICY_READ_RETRY_MS, scheduleGeneration);
      }
    });
  }

  return {
    start() {
      if (stopped) return;
      generation += 1;
      trigger(generation);
    },
    refresh() {
      if (stopped) return;
      generation += 1;
      clearTimer();
      if (active) refreshQueued = true;
      else trigger(generation);
    },
    async stop() {
      stopped = true;
      generation += 1;
      clearTimer();
      await active?.catch((error: unknown) => { report(error); });
    },
  };
}
