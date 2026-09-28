import type { Server } from 'node:http';
import type { UsageOutboxDispatcher } from './usage-dispatcher';

export interface DrainableConnectorServer extends Server {
  drainRequests(timeoutMs: number): Promise<boolean>;
}

export interface LifecycleDependencies {
  server: Server & { drainRequests?: (timeoutMs: number) => Promise<boolean> };
  closeDependencies: () => Promise<void>;
  drainTimeoutMs?: number;
  usageDispatcher?: UsageOutboxDispatcher;
}

export interface ShutdownOptions {
  /** Explicit zero is for test teardown and skips the grace period. */
  timeoutMs?: number;
}

const DEFAULT_DRAIN_TIMEOUT_MS = 30_000;

export class ConnectorLifecycle {
  private accepting = false;
  private draining = false;
  private shutdownPromise: Promise<void> | undefined;

  public constructor(private readonly dependencies: LifecycleDependencies) {}

  public async start(port: number, host = '0.0.0.0'): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error): void => {
        this.dependencies.server.off('listening', onListening);
        reject(error);
      };
      const onListening = (): void => {
        this.dependencies.server.off('error', onError);
        this.accepting = true;
        resolve();
      };
      this.dependencies.server.once('error', onError);
      this.dependencies.server.once('listening', onListening);
      this.dependencies.server.listen(port, host);
    });
    this.dependencies.usageDispatcher?.start();
  }

  public isAccepting(): boolean {
    return this.accepting && !this.draining;
  }

  public address(): ReturnType<Server['address']> {
    return this.dependencies.server.address();
  }

  public shutdown(options: ShutdownOptions = {}): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;
    const timeoutMs = options.timeoutMs ?? this.dependencies.drainTimeoutMs ?? DEFAULT_DRAIN_TIMEOUT_MS;
    if (!Number.isFinite(timeoutMs) || timeoutMs < 0) {
      return Promise.reject(new RangeError('Shutdown drain timeout must be a finite non-negative number.'));
    }

    this.draining = true;
    this.accepting = false;
    this.shutdownPromise = this.performShutdown(timeoutMs);
    return this.shutdownPromise;
  }

  private async performShutdown(timeoutMs: number): Promise<void> {
    const serverClosed = this.closeServer();
    const requestsDrained = this.dependencies.server.drainRequests?.(timeoutMs) ?? Promise.resolve(true);
    const usageDrained = this.dependencies.usageDispatcher?.drain(timeoutMs) ?? Promise.resolve();
    const drainWork = Promise.all([serverClosed, requestsDrained, usageDrained]).then(
      ([, requestsFinished]) => ({ drained: requestsFinished }),
      (error: unknown) => ({ drained: false, error }),
    );

    let outcome: { drained: boolean; error?: unknown } | undefined;
    if (timeoutMs === 0) {
      this.forceCloseConnections();
    } else {
      let deadlineTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        outcome = await Promise.race([
          drainWork,
          new Promise<undefined>((resolve) => {
            deadlineTimer = setTimeout(() => resolve(undefined), timeoutMs);
          }),
        ]);
      } finally {
        if (deadlineTimer) clearTimeout(deadlineTimer);
      }
      if (!outcome?.drained) this.forceCloseConnections();
    }

    let closeError: unknown;
    try {
      await this.dependencies.closeDependencies();
    } catch (error) {
      closeError = error;
    }
    if (closeError !== undefined) throw closeError;
    if (outcome && 'error' in outcome) throw outcome.error;
  }

  private closeServer(): Promise<void> {
    if (!this.dependencies.server.listening) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      this.dependencies.server.close((error) => error ? reject(error) : resolve());
    });
  }

  private forceCloseConnections(): void {
    this.dependencies.server.closeAllConnections();
  }
}
