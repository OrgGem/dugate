import type { Server } from 'node:http';
import type { UsageOutboxDispatcher } from './usage-dispatcher';

export interface LifecycleDependencies {
  server: Server;
  closeDependencies: () => Promise<void>;
  drainTimeoutMs?: number;
  usageDispatcher?: UsageOutboxDispatcher;
}

export class ConnectorLifecycle {
  private accepting = false;
  private draining = false;

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

  public async shutdown(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    this.accepting = false;
    await this.dependencies.usageDispatcher?.drain(this.dependencies.drainTimeoutMs);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, this.dependencies.drainTimeoutMs ?? 30_000);
      this.dependencies.server.close(() => {
        clearTimeout(timer);
        resolve();
      });
    });
    await this.dependencies.closeDependencies();
  }
}
