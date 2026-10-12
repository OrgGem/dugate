import type { MaintenanceJob } from '@du/contracts';

export interface MaintenanceRunnerPort {
  runQueuedMaintenanceJobs(executorIdentity: string, limit?: number): Promise<MaintenanceJob[]>;
  runQueuedRollouts?(executorIdentity: string, limit?: number): Promise<unknown[]>;
}

export interface MaintenanceJobRunnerOptions {
  maintenance: MaintenanceRunnerPort;
  /** Immutable identity supplied by the trusted Orchestrator boot config. */
  runtimeIdentity: string;
  pollIntervalMs?: number;
  batchSize?: number;
}

/**
 * Starts the durable maintenance executor for one Orchestrator replica.
 * The process identity is fixed at construction and job rows are claimed by
 * DB fence before an external effect. The runner does not treat an expired
 * claim as permission to replay an uncertain effect.
 */
export function createMaintenanceJobRunner(options: MaintenanceJobRunnerOptions): {
  start(): void;
  stop(): Promise<void>;
} {
  if (!options.runtimeIdentity || options.runtimeIdentity.length > 96) throw new Error('MAINTENANCE_RUNNER_IDENTITY_REQUIRED');
  const pollIntervalMs = Math.max(250, Math.min(60_000, Math.trunc(options.pollIntervalMs ?? 2_000)));
  const batchSize = Math.max(1, Math.min(10, Math.trunc(options.batchSize ?? 2)));
  let timer: NodeJS.Timeout | undefined;
  let running: Promise<void> | null = null;
  let stopping = false;

  const poll = (): Promise<void> => {
    if (running) return running;
    running = Promise.allSettled([
      options.maintenance.runQueuedMaintenanceJobs(options.runtimeIdentity, batchSize),
      options.maintenance.runQueuedRollouts?.(options.runtimeIdentity, batchSize) ?? Promise.resolve([]),
    ])
      .then(() => undefined)
      .finally(() => { running = null; });
    return running;
  };

  return {
    start() {
      if (timer || stopping) return;
      void poll();
      timer = setInterval(() => { void poll(); }, pollIntervalMs);
      timer.unref?.();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      if (running) await running;
    },
  };
}
