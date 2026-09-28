import { parseWorkerConfig } from './config';
import { startExampleReviewWorker } from './worker';

export async function main(
  env: Record<string, string | undefined> = process.env
): Promise<void> {
  const config = parseWorkerConfig(env);
  const handle = await startExampleReviewWorker({
    runtimeUrl: config.runtimeUrl,
    runtimeToken: config.runtimeToken,
    redis: { url: config.redisUrl },
    concurrency: config.concurrency,
    heartbeatIntervalMs: config.heartbeatIntervalMs,
    workerInstanceId: config.workerInstanceId,
    imageDigest: config.imageDigest,
    component: 'worker:example-review',
  });

  const shutdown = async (): Promise<void> => {
    await handle.stop(config.shutdownGraceMs);
  };
  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

if (require.main === module) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`Example Review worker failed: ${message}`);
    process.exitCode = 1;
  });
}
