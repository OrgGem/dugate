/**
 * PR-Q3-11 (P8-04 lifecycle): the packaged graceful-shutdown core for the
 * orchestrator PROCESS. Injectable by design — production passes real
 * process.exit/setTimeout semantics; offline tests pass fakes and emit real
 * process signals through the same code path (this module is where the
 * signal-handling contract lives, so the contract is unit-testable without a DB).
 *
 * Contract (cycle-99 packet):
 *  1. SIGTERM/SIGINT trigger ONE call to close() (which runs the PR-Q3-10 chain:
 *     webhook drain → lease drain → pools).
 *  2. Idempotent: a SECOND signal while the first shutdown is still running exits(1)
 *     immediately — operators force what the process refused to finish.
 *  3. Bounded: a hard timeout budget exits(1) if close() hangs — the process can
 *     never wedge a container kill / deploy rollout.
 *  4. Clean success exits(0); close() rejection exits(1).
 */

export type ShutdownPhase = 'idle' | 'closing' | 'settled';

export interface GracefulShutdownOptions {
  /** The real shutdown chain (e.g. app.close). Called AT MOST once. */
  close: () => Promise<unknown>;
  /** Injectable for tests; production passes (code) => process.exit(code). */
  exit: (code: number) => void;
  /** Hard budget for the whole close chain. Default 45_000ms — must exceed the
   * webhook drain (webhookDrainTimeoutMs, default 5s) + lease drain
   * (shutdownTimeoutMs, default 30s) plus queue-close slack. */
  timeoutMs?: number;
  signals?: readonly NodeJS.Signals[];
  /** Structured-log seam; default no-op so tests stay quiet. */
  note?: (event: string, detail?: string) => void;
}

export interface GracefulShutdownHandle {
  /** Remove listeners and clear the budget timer (test teardown / ownership change). */
  dispose: () => void;
  phase: () => ShutdownPhase;
}

export function installGracefulShutdown(options: GracefulShutdownOptions): GracefulShutdownHandle {
  const signals: readonly NodeJS.Signals[] = options.signals ?? ['SIGTERM', 'SIGINT'];
  const timeoutMs = options.timeoutMs ?? 45_000;
  const note = options.note ?? ((): void => undefined);
  let current: ShutdownPhase = 'idle';
  let budget: ReturnType<typeof setTimeout> | undefined;

  const finish = (code: number, why: string): void => {
    if (current !== 'closing') return; // settle ONCE
    current = 'settled';
    if (budget) clearTimeout(budget);
    budget = undefined;
    note(why, 'exit=' + code);
    options.exit(code);
  };

  const onSignal = (signal: NodeJS.Signals): void => {
    if (current === 'idle') {
      current = 'closing';
      note('shutdown-begin', String(signal));
      budget = setTimeout(() => finish(1, 'shutdown-budget-exceeded'), timeoutMs);
      budget.unref?.();
      void Promise.resolve()
        .then(() => options.close())
        .then(
          () => finish(0, 'shutdown-complete'),
          (err: unknown) => {
            note('shutdown-error', err instanceof Error ? err.name : 'Error');
            finish(1, 'shutdown-failed');
          }
        );
      return;
    }
    if (current === 'closing') {
      // Requirement 2: the operator is insisting — stop waiting, leave nonzero.
      note('shutdown-forced', String(signal));
      if (budget) clearTimeout(budget);
      budget = undefined;
      current = 'settled';
      options.exit(1);
      return;
    }
    note('shutdown-signal-after-settle', String(signal));
  };

  for (const s of signals) process.on(s, onSignal);

  return {
    dispose(): void {
      for (const s of signals) process.removeListener(s, onSignal);
      if (budget) clearTimeout(budget);
      budget = undefined;
    },
    phase: () => current,
  };
}
