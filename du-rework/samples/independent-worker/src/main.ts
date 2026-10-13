import { createManifest } from './manifest.js';
import { startWorker } from './worker.js';

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function integer(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^\d+$/.test(raw.trim())) throw new Error(`${name} must be a whole number`);
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) throw new Error(`${name} is outside the supported range`);
  return value;
}

async function main(): Promise<void> {
  const version = required('BUSINESS_VERSION');
  const shutdownGraceMs = integer('WORKER_SHUTDOWN_GRACE_MS', 15_000);
  if (shutdownGraceMs < 0 || shutdownGraceMs > 60_000) {
    throw new Error('WORKER_SHUTDOWN_GRACE_MS must be from 0 through 60000');
  }
  const manifest = createManifest(version, required('WORKER_IMAGE_DIGEST'));
  const worker = await startWorker(manifest, {
    runtimeUrl: required('RUNTIME_URL'),
    runtimeToken: required('RUNTIME_TOKEN'),
    redisUrl: required('REDIS_URL'),
    concurrency: integer('WORKER_CONCURRENCY', 1),
    deploymentRevision: process.env.DEPLOYMENT_REVISION,
    heartbeatIntervalMs: integer('WORKER_HEARTBEAT_INTERVAL_MS', 15_000),
    leaseSafetyMarginMs: integer('WORKER_LEASE_SAFETY_MARGIN_MS', 5_000),
    requestTimeoutMs: integer('RUNTIME_REQUEST_TIMEOUT_MS', 10_000),
  });

  process.stdout.write(`independent-worker: ready business=${manifest.businessId} version=${manifest.version} queue=${worker.queueName} instance=${worker.workerInstanceId}\n`);

  let stopping = false;
  const stop = (signal: 'SIGINT' | 'SIGTERM'): void => {
    if (stopping) return;
    stopping = true;
    process.stderr.write(`independent-worker: ${signal} received; draining\n`);
    const hardStop = setTimeout(() => {
      process.stderr.write('independent-worker: shutdown deadline reached\n');
      process.exit(1);
    }, shutdownGraceMs + 5_000);
    void worker.stop(shutdownGraceMs).then(() => {
      clearTimeout(hardStop);
      process.exit(0);
    }, () => {
      clearTimeout(hardStop);
      process.stderr.write('independent-worker: bounded shutdown did not complete cleanly\n');
      process.exit(1);
    });
  };
  process.once('SIGINT', () => stop('SIGINT'));
  process.once('SIGTERM', () => stop('SIGTERM'));
}

main().catch(() => {
  process.stderr.write('independent-worker: startup failed; check Runtime, Redis, and worker configuration\n');
  process.exitCode = 1;
});
