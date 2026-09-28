/**
 * Child Process Manager for Worker Crash / Recovery Testing (Wave 15 / Wave 16)
 *
 * Provides bounded ready/step/exit waits with prompt rejection on early exit/error,
 * reliable listener and timer cleanup, awaited process termination, and PID-scoped fallback.
 *
 * Wave 16 Hardening:
 * - Signal sent (child.killed === true) is NOT treated as exit; only confirmed exitCode/signalCode counts.
 * - Children that fail to confirm death or time out are retained in active tracking.
 * - Phased escalation to PID-scoped process.kill before bounded rejection with full diagnostics.
 * - terminateAll aggregates errors without clearing or forgetting unconfirmed survivors.
 * - Concurrent terminate calls are deduplicated safely via in-flight promise mapping.
 */
import { fork, type ChildProcess, type ForkOptions } from 'node:child_process';

export interface ChildMessagePayload {
  type: string;
  [key: string]: unknown;
}

export interface TerminationResult {
  code: number | null;
  signal: string | null;
}

export class ManagedChildProcessTracker {
  private activeChildren = new Set<ChildProcess>();
  private inFlightTerminations = new Map<ChildProcess, Promise<TerminationResult>>();

  /**
   * Tracks an existing child process until confirmed termination.
   */
  track(child: ChildProcess): ChildProcess {
    this.activeChildren.add(child);
    return child;
  }

  /**
   * Forks a child process and tracks it until confirmed termination.
   */
  spawn(modulePath: string, args: string[] = [], options: ForkOptions = {}): ChildProcess {
    const child = fork(modulePath, args, options);
    this.activeChildren.add(child);
    return child;
  }

  /**
   * Checks whether a child process has confirmed exit via exitCode or signalCode.
   * Note: child.killed only means a signal was sent; it does NOT mean the process exited.
   */
  isConfirmedExited(child: ChildProcess): boolean {
    return child.exitCode !== null || child.signalCode !== null;
  }

  /**
   * Bounded wait for a specific message type from the child process.
   * Immediately rejects on premature child exit or error with no orphan timer leaks.
   */
  async waitForMessage<T extends ChildMessagePayload = ChildMessagePayload>(
    child: ChildProcess,
    expectedType: string,
    timeoutMs = 15_000
  ): Promise<T> {
    if (this.isConfirmedExited(child)) {
      throw new Error(
        `Child process ${child.pid} is already terminated (code: ${child.exitCode}, signal: ${child.signalCode}) while waiting for message "${expectedType}".`
      );
    }

    return new Promise<T>((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;

      const cleanup = () => {
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
        child.off('message', onMessage);
        child.off('exit', onExit);
        child.off('error', onError);
      };

      const onMessage = (msg: unknown) => {
        if (typeof msg === 'object' && msg !== null && (msg as { type: string }).type === expectedType) {
          cleanup();
          resolve(msg as T);
        }
      };

      const onExit = (code: number | null, signal: string | null) => {
        cleanup();
        reject(
          new Error(
            `Child process ${child.pid} exited early with code ${code} (signal ${signal}) before sending expected message "${expectedType}".`
          )
        );
      };

      const onError = (err: Error) => {
        cleanup();
        reject(
          new Error(
            `Child process ${child.pid} encountered an error before sending expected message "${expectedType}": ${err.message}`
          )
        );
      };

      timer = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `Timed out after ${timeoutMs}ms waiting for message "${expectedType}" from child process ${child.pid}.`
          )
        );
      }, timeoutMs);

      child.on('message', onMessage);
      child.once('exit', onExit);
      child.once('error', onError);
    });
  }

  /**
   * Bounded termination of this test-owned child process with observed, confirmed exit.
   * Retains child in active tracking if death cannot be confirmed.
   * Deduplicates concurrent terminate calls safely.
   */
  terminate(child: ChildProcess, timeoutMs = 5_000): Promise<TerminationResult> {
    // 1. If exit is already definitively confirmed, remove from tracking and return code/signal
    if (this.isConfirmedExited(child)) {
      this.activeChildren.delete(child);
      return Promise.resolve({ code: child.exitCode, signal: child.signalCode });
    }

    // 2. Deduplicate concurrent termination calls on the same child
    const inFlight = this.inFlightTerminations.get(child);
    if (inFlight) {
      return inFlight;
    }

    const terminationPromise = this.performTermination(child, timeoutMs).finally(() => {
      this.inFlightTerminations.delete(child);
    });
    this.inFlightTerminations.set(child, terminationPromise);

    return terminationPromise;
  }

  private performTermination(child: ChildProcess, timeoutMs: number): Promise<TerminationResult> {
    const pid = child.pid;
    if (!pid && !this.isConfirmedExited(child)) {
      return Promise.reject(
        new Error('Cannot terminate child process: PID is undefined and exit is unconfirmed')
      );
    }

    return new Promise<TerminationResult>((resolve, reject) => {
      let mainTimer: NodeJS.Timeout | null = null;
      let escalationTimer: NodeJS.Timeout | null = null;
      let settled = false;

      const cleanup = () => {
        settled = true;
        if (mainTimer) {
          clearTimeout(mainTimer);
          mainTimer = null;
        }
        if (escalationTimer) {
          clearTimeout(escalationTimer);
          escalationTimer = null;
        }
        child.off('exit', onExit);
        child.off('error', onError);
      };

      const onExit = (code: number | null, signal: string | null) => {
        if (settled) return;
        cleanup();
        this.activeChildren.delete(child);
        resolve({ code: code ?? child.exitCode, signal: signal ?? child.signalCode });
      };

      const onError = (_err: Error) => {
        // Error on process object: wait for exit event or escalation timeout
      };

      child.once('exit', onExit);
      child.on('error', onError);

      // Phase 1: Attempt SIGKILL via child.kill('SIGKILL')
      let killSent = false;
      let killError: Error | null = null;
      try {
        killSent = child.kill('SIGKILL');
      } catch (err) {
        killError = err as Error;
      }

      // If kill threw or returned false and child has not exited, try immediate escalation via PID
      if ((!killSent || killError) && pid && !this.isConfirmedExited(child)) {
        try {
          process.kill(pid, 'SIGKILL');
        } catch {
          // Process may not exist or permissions may fail; wait for exit or timeout
        }
      }

      // Phase 2: Bounded timeout with escalation deadline (70% initial, 30% escalation grace)
      const initialPhaseMs = Math.max(80, Math.floor(timeoutMs * 0.7));
      const escalationGraceMs = Math.max(80, timeoutMs - initialPhaseMs);

      mainTimer = setTimeout(() => {
        if (settled || this.isConfirmedExited(child)) return;

        // Escalate to PID-scoped process.kill
        if (pid) {
          try {
            process.kill(pid, 'SIGKILL');
          } catch {
            // Process may not exist
          }
        }

        escalationTimer = setTimeout(() => {
          if (settled) return;
          cleanup();
          // DO NOT delete from this.activeChildren: unconfirmed survivor is retained!
          const diagnostics = [
            `PID: ${pid}`,
            `child.killed: ${child.killed}`,
            `child.exitCode: ${child.exitCode}`,
            `child.signalCode: ${child.signalCode}`,
            `initialKillSent: ${killSent}`,
            killError ? `initialKillError: ${killError.message}` : null,
          ]
            .filter(Boolean)
            .join(', ');

          reject(
            new Error(
              `Child process ${pid} failed to confirm exit within ${timeoutMs}ms (${diagnostics}). Resource retained in active tracking.`
            )
          );
        }, escalationGraceMs);
      }, initialPhaseMs);
    });
  }

  /**
   * Terminates all actively tracked children and collects cleanup errors.
   * Only confirmed exited children are removed from active tracking; survivors are retained.
   */
  async terminateAll(timeoutMs = 5_000): Promise<Error[]> {
    const errors: Error[] = [];
    const childrenToKill = Array.from(this.activeChildren);

    for (const child of childrenToKill) {
      try {
        await this.terminate(child, timeoutMs);
      } catch (err) {
        errors.push(err as Error);
      }
    }

    return errors;
  }

  get trackedCount(): number {
    return this.activeChildren.size;
  }

  hasChild(child: ChildProcess): boolean {
    return this.activeChildren.has(child);
  }
}
