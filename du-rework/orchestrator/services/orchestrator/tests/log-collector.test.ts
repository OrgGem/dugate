import { collectorOptionsFromEnv } from '../src/log-collector';

describe('Orchestrator Elasticsearch collector runner', () => {
  test('reads HTTPS endpoint and write credential from environment with bounded defaults', () => {
    const options = collectorOptionsFromEnv({
      ELASTICSEARCH_URL: 'https://es.private.test:9200',
      ELASTICSEARCH_API_KEY: 'write-only-secret',
      DU_ENVIRONMENT: 'staging',
    });

    expect(options).toMatchObject({
      endpoint: 'https://es.private.test:9200',
      apiKey: 'write-only-secret',
      spoolDirectory: './var/log-spool',
      maxDiskBytes: 256 * 1024 * 1024,
      maxMemoryBytes: 8 * 1024 * 1024,
      maxSegments: 4096,
      maxSegmentBytes: 256 * 1024,
      maxRecordBytes: 64 * 1024,
      maxResponseBytes: 1024 * 1024,
    });
  });

  test('supports operator limits for persistent spool, in-memory working set, and retry timing', () => {
    const options = collectorOptionsFromEnv({
      ELASTICSEARCH_URL: 'https://es.private.test:9200',
      ELASTICSEARCH_API_KEY: 'write-only-secret',
      LOG_COLLECTOR_SPOOL_DIR: 'D:\\collector-spool',
      LOG_COLLECTOR_MAX_DISK_BYTES: '10485760',
      LOG_COLLECTOR_MAX_MEMORY_BYTES: '4194304',
      LOG_COLLECTOR_MAX_SEGMENTS: '1024',
      LOG_COLLECTOR_MAX_SEGMENT_BYTES: '65536',
      LOG_COLLECTOR_MAX_RECORD_BYTES: '16384',
      LOG_COLLECTOR_MAX_RESPONSE_BYTES: '262144',
      LOG_COLLECTOR_INITIAL_RETRY_MS: '750',
      LOG_COLLECTOR_MAX_RETRY_MS: '12000',
    });

    expect(options).toMatchObject({
      spoolDirectory: 'D:\\collector-spool',
      maxDiskBytes: 10 * 1024 * 1024,
      maxMemoryBytes: 4 * 1024 * 1024,
      maxSegments: 1024,
      maxSegmentBytes: 64 * 1024,
      maxRecordBytes: 16 * 1024,
      maxResponseBytes: 256 * 1024,
      initialRetryMs: 750,
      maxRetryMs: 12_000,
    });
  });

  test('refuses missing credentials and malformed limits without exposing secret contents', () => {
    expect(() => collectorOptionsFromEnv({
      ELASTICSEARCH_API_KEY: 'DO_NOT_ECHO_THIS_SECRET',
    })).toThrow('ELASTICSEARCH_URL is required');
    expect(() => collectorOptionsFromEnv({
      ELASTICSEARCH_URL: 'https://es.private.test:9200',
    })).toThrow('ELASTICSEARCH_API_KEY is required');
    expect(() => collectorOptionsFromEnv({
      ELASTICSEARCH_URL: 'https://es.private.test:9200',
      ELASTICSEARCH_API_KEY: 'secret',
      LOG_COLLECTOR_MAX_DISK_BYTES: 'infinite',
    })).toThrow('LOG_COLLECTOR_MAX_DISK_BYTES must be a positive integer');
  });
});
