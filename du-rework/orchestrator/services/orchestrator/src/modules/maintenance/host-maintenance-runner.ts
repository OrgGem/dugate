import type { MaintenanceJob } from '@du/contracts';
import type { MaintenanceRunnerPort } from './job-runner';
import { stopActiveMaintenanceCommands } from './active-command-shutdown';

export interface HostMaintenanceRunnerOptions {
  maintenance: MaintenanceRunnerPort;
  /** Root-pinned identity for this dedicated executor deployment. */
  runtimeIdentity: string;
  pollIntervalMs?: number;
  batchSize?: number;
  onError?: (code: string) => void;
}

export interface HostMaintenanceRunner {
  runOnce(): Promise<{ maintenanceJobs: MaintenanceJob[]; rolloutJobs: unknown[] }>;
  start(): void;
  stop(): Promise<void>;
  status(): { running: boolean; stopping: boolean };
}

/** Dedicated host-side loop over the existing DB-fenced maintenance service.
 * It adds no job storage or retry semantics: uncertain item effects remain
 * owned by the existing job item and are never reclaimed by this poller. */
export function createHostMaintenanceRunner(options: HostMaintenanceRunnerOptions): HostMaintenanceRunner {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,95}$/.test(options.runtimeIdentity)) {
    throw new Error('MAINTENANCE_HOST_IDENTITY_INVALID');
  }
  const pollIntervalMs = Math.max(500, Math.min(60_000, Math.trunc(options.pollIntervalMs ?? 2_000)));
  const batchSize = Math.max(1, Math.min(4, Math.trunc(options.batchSize ?? 1)));
  let timer: NodeJS.Timeout | undefined;
  let active: Promise<{ maintenanceJobs: MaintenanceJob[]; rolloutJobs: unknown[] }> | null = null;
  let stopping = false;

  const runOnce = (): Promise<{ maintenanceJobs: MaintenanceJob[]; rolloutJobs: unknown[] }> => {
    if (stopping) return Promise.resolve({ maintenanceJobs: [], rolloutJobs: [] });
    if (active) return active;
    active = (async () => {
      const maintenance = options.maintenance.runQueuedMaintenanceJobs(options.runtimeIdentity, batchSize);
      const rollouts = options.maintenance.runQueuedRollouts?.(options.runtimeIdentity, batchSize) ?? Promise.resolve([]);
      const [maintenanceResult, rolloutResult] = await Promise.allSettled([maintenance, rollouts]);
      if (maintenanceResult.status === 'rejected') options.onError?.('maintenance_claim_cycle_failed');
      if (rolloutResult.status === 'rejected') options.onError?.('rollout_claim_cycle_failed');
      return {
        maintenanceJobs: maintenanceResult.status === 'fulfilled' ? maintenanceResult.value : [],
        rolloutJobs: rolloutResult.status === 'fulfilled' ? rolloutResult.value : [],
      };
    })().finally(() => { active = null; });
    return active;
  };

  return {
    runOnce,
    start() {
      if (timer || stopping) return;
      void runOnce();
      timer = setInterval(() => { void runOnce(); }, pollIntervalMs);
      timer.unref?.();
    },
    async stop() {
      stopping = true;
      if (timer) clearInterval(timer);
      timer = undefined;
      // Stop exact child groups owned by the trusted adapters. They wait for
      // close and record ambiguous outcomes as UNKNOWN, so no item is replayed.
      stopActiveMaintenanceCommands();
      if (active) await active;
    },
    status() { return { running: active !== null, stopping }; },
  };
}
