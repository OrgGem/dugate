import { parseWorkerConfig, getRedactedConfig, DocumentCoreServiceConfig } from './config';
import { startDocumentCoreWorker, WorkerHandle } from './worker';

export interface ProcessLifecycleDeps {
  env?: Record<string, string | undefined>;
  startWorkerFn?: (config: any) => Promise<WorkerHandle>;
  onExit?: (code: number) => void;
  onLog?: (level: 'info' | 'warn' | 'error', message: string, meta?: unknown) => void;
  registerSignalHandler?: (signal: 'SIGTERM' | 'SIGINT', handler: () => Promise<void>) => void;
}

export class DocumentCoreProcess {
  private workerHandle?: WorkerHandle;
  private shuttingDown = false;
  private stopped = false;

  constructor(private readonly deps: ProcessLifecycleDeps = {}) {}

  async start(): Promise<WorkerHandle> {
    const env = this.deps.env ?? process.env;
    const log = this.deps.onLog ?? ((level, msg, meta) => {
      const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, meta });
      if (level === 'error') console.error(line);
      else console.log(line);
    });

    let config: DocumentCoreServiceConfig;
    try {
      config = parseWorkerConfig(env);
    } catch (err: any) {
      log('error', 'Failed to parse worker environment configuration', { error: err.message });
      this.exit(1);
      throw err;
    }

    log('info', 'Starting Document Core Worker service', getRedactedConfig(config));

    const startFn = this.deps.startWorkerFn ?? startDocumentCoreWorker;
    try {
      this.workerHandle = await startFn({
        runtimeUrl: config.runtimeUrl,
        runtimeToken: config.runtimeToken,
        redis: { url: config.redisUrl },
        connectorUrl: config.connectorUrl,
        concurrency: config.concurrency,
        heartbeatIntervalMs: config.heartbeatIntervalMs,
        workerInstanceId: config.workerInstanceId,
        imageDigest: config.imageDigest,
      });
    } catch (err: any) {
      log('error', 'Worker failed to start', { error: err.message });
      this.exit(1);
      throw err;
    }

    log('info', 'Document Core Worker successfully registered and listening', {
      workerInstanceId: this.workerHandle.workerInstanceId,
      queueName: this.workerHandle.queueName,
    });

    const registerSignal = this.deps.registerSignalHandler ?? ((sig, handler) => {
      process.on(sig, () => {
        handler().catch((err) => {
          log('error', `Error during ${sig} shutdown`, { error: err.message });
          this.exit(1);
        });
      });
    });

    const shutdownHandler = async () => {
      await this.shutdown(config.shutdownGraceMs);
    };

    registerSignal('SIGTERM', shutdownHandler);
    registerSignal('SIGINT', shutdownHandler);

    return this.workerHandle;
  }

  async shutdown(graceMs: number = 15_000): Promise<void> {
    if (this.shuttingDown || this.stopped) {
      return;
    }
    this.shuttingDown = true;
    const log = this.deps.onLog ?? ((level, msg, meta) => {
      console.log(JSON.stringify({ ts: new Date().toISOString(), level, msg, meta }));
    });

    log('info', 'Shutting down worker gracefully...', { graceMs });

    try {
      if (this.workerHandle) {
        await this.workerHandle.stop(graceMs);
      }
      this.stopped = true;
      log('info', 'Worker shutdown completed cleanly');
      this.exit(0);
    } catch (err: any) {
      log('error', 'Worker failed during graceful shutdown', { error: err.message });
      this.exit(1);
      throw err;
    }
  }

  private exit(code: number): void {
    if (this.deps.onExit) {
      this.deps.onExit(code);
    } else {
      process.exit(code);
    }
  }
}

// Auto-start if executed directly (e.g. node dist/main.js)
if (require.main === module) {
  const service = new DocumentCoreProcess();
  service.start().catch(() => {
    // Process error logged and exited inside DocumentCoreProcess
  });
}
