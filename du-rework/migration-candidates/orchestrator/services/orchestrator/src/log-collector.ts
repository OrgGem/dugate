import {
  createElasticsearchLogCollector,
  type ElasticsearchLogCollectorOptions,
} from '@du/observability';

function required(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name];
  if (!value || !value.trim()) throw new TypeError(`${name} is required`);
  return value;
}

function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = env[name];
  if (raw === undefined || raw === '') return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`${name} must be a positive integer`);
  return value;
}

/** Read once at collector startup so credentials never enter command arguments or logs. */
export function collectorOptionsFromEnv(env: NodeJS.ProcessEnv = process.env): ElasticsearchLogCollectorOptions {
  const spoolDirectory = env.LOG_COLLECTOR_SPOOL_DIR?.trim() || './var/log-spool';
  return {
    endpoint: required(env, 'ELASTICSEARCH_URL'),
    apiKey: required(env, 'ELASTICSEARCH_API_KEY'),
    spoolDirectory,
    maxDiskBytes: positiveInteger(env, 'LOG_COLLECTOR_MAX_DISK_BYTES', 256 * 1024 * 1024),
    maxMemoryBytes: positiveInteger(env, 'LOG_COLLECTOR_MAX_MEMORY_BYTES', 8 * 1024 * 1024),
    maxSegments: positiveInteger(env, 'LOG_COLLECTOR_MAX_SEGMENTS', 4096),
    maxSegmentBytes: positiveInteger(env, 'LOG_COLLECTOR_MAX_SEGMENT_BYTES', 256 * 1024),
    maxRecordBytes: positiveInteger(env, 'LOG_COLLECTOR_MAX_RECORD_BYTES', 64 * 1024),
    maxResponseBytes: positiveInteger(env, 'LOG_COLLECTOR_MAX_RESPONSE_BYTES', 1024 * 1024),
    requestTimeoutMs: positiveInteger(env, 'LOG_COLLECTOR_REQUEST_TIMEOUT_MS', 5000),
    flushIntervalMs: positiveInteger(env, 'LOG_COLLECTOR_FLUSH_INTERVAL_MS', 250),
    initialRetryMs: positiveInteger(env, 'LOG_COLLECTOR_INITIAL_RETRY_MS', 500),
    maxRetryMs: positiveInteger(env, 'LOG_COLLECTOR_MAX_RETRY_MS', 30_000),
  };
}

function stderr(event: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify({ timestamp: new Date().toISOString(), service: 'log-collector', ...event })}\n`);
}

async function main(): Promise<void> {
  const options = collectorOptionsFromEnv();
  let collectorRef: ReturnType<typeof createElasticsearchLogCollector> | undefined;
  const collector = createElasticsearchLogCollector({
    ...options,
    onDrop: (reason, count) => {
      const stats = collectorRef?.stats();
      stderr({
        level: 'warn',
        event: 'buffer_drop',
        reason,
        count,
        droppedRecords: stats?.droppedRecords ?? count,
        bufferedRecords: stats?.bufferedRecords ?? 0,
        bufferedDiskBytes: stats?.bufferedDiskBytes ?? 0,
        ingestLagMs: stats?.ingestLagMs ?? 0,
      });
    },
    onDeliveryFailure: (code, retryCount) => {
      if (retryCount === 1 || retryCount % 100 === 0) {
        stderr({ level: 'warn', event: 'elasticsearch_retry', code, retryCount });
      }
    },
  });
  collectorRef = collector;

  let receivedSignal = false;
  const statsTimer = setInterval(() => {
    const stats = collector.stats();
    stderr({ level: 'info', event: 'collector_stats', ...stats });
  }, 30_000);
  statsTimer.unref();
  const stopInput = (): void => {
    receivedSignal = true;
    process.stdin.destroy();
  };
  process.once('SIGINT', stopInput);
  process.once('SIGTERM', stopInput);
  collector.start();
  try {
    await collector.consume(process.stdin);
  } catch {
    if (!receivedSignal) {
      stderr({ level: 'error', event: 'collector_input_failed', code: 'INPUT_STREAM_FAILED' });
      process.exitCode = 1;
    }
  } finally {
    clearInterval(statsTimer);
    process.removeListener('SIGINT', stopInput);
    process.removeListener('SIGTERM', stopInput);
    await collector.stop({ drainTimeoutMs: 3000 });
  }
}

if (require.main === module) {
  void main().catch(() => {
    stderr({ level: 'error', event: 'collector_startup_failed', code: 'COLLECTOR_STARTUP_FAILED' });
    process.exitCode = 1;
  });
}
