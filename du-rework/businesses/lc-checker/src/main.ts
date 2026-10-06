import { createLogger, safeErrorForLog } from '@du/worker-sdk';
import { parseWorkerConfig } from './config';
import { startLcCheckerWorker } from './worker';

async function main(): Promise<void> {
  const config = parseWorkerConfig();
  const handle = await startLcCheckerWorker({
    runtimeUrl: config.runtimeUrl,
    runtimeToken: config.runtimeToken,
    connectorUrl: config.connectorUrl,
    connectorServiceToken: config.connectorServiceToken,
    redis: { url: config.redisUrl },
    concurrency: config.concurrency,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    workerInstanceId: config.workerInstanceId,
    imageDigest: config.imageDigest,
    maxArtifactBytes: config.maxArtifactBytes,
  });

  const shutdown = (): void => {
    void handle.stop().finally(() => {
      process.exit(0);
    });
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

main().catch((error: unknown) => {
  createLogger({ service: 'lc-checker' }).error('lc-checker worker startup failed', { error: safeErrorForLog(error) });
  process.exit(1);
});
