import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  createElasticsearchLogCollector,
  type ElasticsearchLogCollectorOptions,
} from '../src/elasticsearch-collector';

const event = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
  timestamp: '2026-09-28T00:00:00.000Z',
  level: 'info',
  service: 'orchestrator',
  version: 'test',
  environment: 'test',
  correlationId: 'corr-collector-test',
  operationId: null,
  taskId: null,
  invocationId: null,
  message: 'collector fixture',
  ...overrides,
});

function bulkResponse(statuses: number[] = [201]): Response {
  return new Response(JSON.stringify({
    errors: statuses.some((status) => status >= 300),
    items: statuses.map((status) => ({ create: { status } })),
  }), { status: 200, headers: { 'content-type': 'application/json' } });
}

describe('Elasticsearch log collector', () => {
  let spool: string;

  beforeEach(async () => {
    spool = await mkdtemp(path.join(os.tmpdir(), 'du-log-spool-'));
  });

  afterEach(async () => {
    await rm(spool, { recursive: true, force: true });
  });

  function makeCollector(overrides: Partial<ElasticsearchLogCollectorOptions> = {}) {
    return createElasticsearchLogCollector({
      endpoint: 'https://es.private.test:9200',
      apiKey: 'collector-write-key-secret',
      spoolDirectory: spool,
      ...overrides,
    });
  }

  test('spools without contacting Elasticsearch and redacts again at the collector boundary', async () => {
    const fetcher = jest.fn(async () => bulkResponse());
    const collector = makeCollector({ fetch: fetcher as unknown as typeof fetch });

    await expect(collector.ingestLine(event({ apiKey: 'COLLECTOR_SENTINEL_SECRET', input: { text: 'RAW_INPUT_SENTINEL' }, output: 'RAW_OUTPUT_SENTINEL', freeText: 'RAW_OTHER_SENTINEL' }))).resolves.toBe(true);

    expect(fetcher).not.toHaveBeenCalled();
    expect(collector.stats()).toMatchObject({ acceptedRecords: 1, bufferedRecords: 1, retryAttempts: 0 });
    const [fileName] = await readdir(spool);
    expect(fileName).toMatch(/\.open$/);
    const spooled = await readFile(path.join(spool, fileName!), 'utf8');
    expect(spooled).not.toContain('COLLECTOR_SENTINEL_SECRET');
    for (const content of ['RAW_INPUT_SENTINEL', 'RAW_OUTPUT_SENTINEL', 'RAW_OTHER_SENTINEL']) expect(spooled).not.toContain(content);
    expect(spooled).toContain('[REDACTED]');
  });

  test('retains failed delivery, then replays the redacted event after Elasticsearch recovers', async () => {
    const fetcher = jest.fn()
      .mockRejectedValueOnce(new Error('transport detail must not be logged'))
      .mockResolvedValueOnce(bulkResponse());
    const failures: string[] = [];
    const collector = makeCollector({
      fetch: fetcher as unknown as typeof fetch,
      onDeliveryFailure: (code) => failures.push(code),
    });
    await collector.ingestLine(event({ message: 'Bearer LOG_COLLECTOR_BEARER_SENTINEL' }));

    const failed = await collector.flushOnce();
    expect(failed).toMatchObject({ delivered: 0, retrying: true, bufferedRecords: 1 });
    expect(collector.stats()).toMatchObject({ retryAttempts: 1, lastFailureCode: 'TRANSPORT_UNAVAILABLE' });
    expect(failures).toEqual(['TRANSPORT_UNAVAILABLE']);

    const recovered = await collector.flushOnce();
    expect(recovered).toMatchObject({ delivered: 1, retrying: false, bufferedRecords: 0 });
    expect(collector.stats()).toMatchObject({ deliveredRecords: 1, bufferedDiskBytes: 0 });
    const init = fetcher.mock.calls[1]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).authorization).toBe('ApiKey collector-write-key-secret');
    expect(String(init.body)).toContain('"_index":"du-logs-test"');
    expect(String(init.body)).not.toContain('LOG_COLLECTOR_BEARER_SENTINEL');
    expect(String(init.body)).toContain('[REDACTED]');
    expect(await readdir(spool)).toEqual([]);
  });

  test('background loop retries with backoff and drains after Elasticsearch recovery', async () => {
    const fetcher = jest.fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(bulkResponse());
    const collector = makeCollector({
      fetch: fetcher as unknown as typeof fetch,
      flushIntervalMs: 10,
      initialRetryMs: 5,
      maxRetryMs: 20,
    });
    await collector.ingestLine(event());
    collector.start();

    const deadline = Date.now() + 1000;
    while (collector.stats().deliveredRecords === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    await collector.stop();

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(collector.stats()).toMatchObject({ deliveredRecords: 1, retryAttempts: 1, bufferedRecords: 0 });
  });

  test('spooling remains responsive while a background Elasticsearch request is stalled', async () => {
    const fetcher = jest.fn((_input: string | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(new Error('timed out')), { once: true });
    }));
    const collector = makeCollector({
      fetch: fetcher as unknown as typeof fetch,
      requestTimeoutMs: 30,
      flushIntervalMs: 5,
      initialRetryMs: 5,
      maxRetryMs: 10,
    });
    await collector.ingestLine(event({ message: 'first' }));
    collector.start();

    const deadline = Date.now() + 500;
    while (fetcher.mock.calls.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
    await expect(collector.ingestLine(event({ message: 'second' }))).resolves.toBe(true);
    await collector.stop();

    expect(collector.stats().acceptedRecords).toBe(2);
    expect(collector.stats().bufferedRecords).toBeGreaterThan(0);
  });

  test('restart recovers an unsealed segment and replays it', async () => {
    const firstProcess = makeCollector();
    await firstProcess.ingestLine(event());
    expect((await readdir(spool))[0]).toMatch(/\.open$/);

    const fetcher = jest.fn(async () => bulkResponse());
    const restarted = makeCollector({ fetch: fetcher as unknown as typeof fetch });
    expect(restarted.stats().bufferedRecords).toBe(0);
    const replay = await restarted.flushOnce();

    expect(replay).toMatchObject({ delivered: 1, bufferedRecords: 0 });
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(await readdir(spool)).toEqual([]);
  });

  test('applies bounded drop policy and exposes counters when disk quota is exhausted', async () => {
    const drops: Array<{ reason: string; count: number }> = [];
    const collector = makeCollector({
      maxDiskBytes: 1024,
      maxSegmentBytes: 1024,
      maxRecordBytes: 900,
      onDrop: (reason, count) => drops.push({ reason, count }),
    });
    const largeEvent = event({ operationId: 'o'.repeat(140), taskId: 't'.repeat(140), invocationId: 'i'.repeat(140), businessId: 'b'.repeat(100) });

    await expect(collector.ingestLine(largeEvent)).resolves.toBe(true);
    await expect(collector.ingestLine(largeEvent)).resolves.toBe(false);

    const stats = collector.stats();
    expect(stats.bufferedDiskBytes).toBeLessThanOrEqual(1024);
    expect(stats).toMatchObject({ acceptedRecords: 1, droppedRecords: 1, bufferedRecords: 1 });
    expect(drops).toEqual([{ reason: 'buffer_full', count: 1 }]);
  });

  test('caps spool segment count even when the byte quota still has room', async () => {
    const fetcher = jest.fn(async () => { throw new Error('offline'); });
    const collector = makeCollector({
      fetch: fetcher as unknown as typeof fetch,
      maxDiskBytes: 4096,
      maxSegments: 1,
      maxSegmentBytes: 1024,
      maxRecordBytes: 900,
    });
    await collector.ingestLine(event({ message: 'first segment' }));
    await expect(collector.flushOnce()).resolves.toMatchObject({ retrying: true, bufferedRecords: 1 });

    await expect(collector.ingestLine(event({ message: 'second segment' }))).resolves.toBe(false);

    expect(collector.stats()).toMatchObject({
      bufferedRecords: 1,
      droppedRecords: 1,
      bufferedDiskBytes: expect.any(Number),
    });
    expect(collector.stats().bufferedDiskBytes).toBeLessThan(4096);
  });

  test('rejects limits whose bounded buffers exceed the declared memory budget', () => {
    expect(() => makeCollector({
      maxMemoryBytes: 2 * 1024 * 1024,
      maxSegmentBytes: 256 * 1024,
      maxResponseBytes: 1024 * 1024,
    })).toThrow(/maxMemoryBytes/);
  });

  test('stream parsing bounds oversized lines and awaits local writes for backpressure', async () => {
    const collector = makeCollector({ maxSegmentBytes: 1024, maxRecordBytes: 512 });
    const chunks = [Buffer.from(`${event()}\n`), Buffer.from(`${'X'.repeat(1024)}\n`), Buffer.from(event({ message: 'after oversize' }))];
    async function* source(): AsyncGenerator<Buffer> {
      for (const chunk of chunks) yield chunk;
    }

    await collector.consume(source());

    expect(collector.stats()).toMatchObject({ acceptedRecords: 2, droppedRecords: 1, bufferedRecords: 2 });
  });

  test('retries transient item errors and drops permanent mapping rejections with a counter', async () => {
    const fetcher = jest.fn(async () => bulkResponse([201, 429, 400]));
    const drops: string[] = [];
    const collector = makeCollector({
      fetch: fetcher as unknown as typeof fetch,
      onDrop: (reason) => drops.push(reason),
    });
    await collector.ingestLine(event({ message: 'sent' }));
    await collector.ingestLine(event({ message: 'retry', operationId: 'retry-op' }));
    await collector.ingestLine(event({ message: 'invalid mapping' }));

    const result = await collector.flushOnce();

    expect(result).toMatchObject({ delivered: 1, dropped: 1, retrying: true, bufferedRecords: 1 });
    expect(collector.stats()).toMatchObject({ deliveredRecords: 1, droppedRecords: 1, retryAttempts: 1 });
    expect(drops).toEqual(['elasticsearch_rejection']);
    const [remainingName] = await readdir(spool);
    expect((await readFile(path.join(spool, remainingName!), 'utf8'))).toContain('retry-op');
  });

  test.each([
    'http://es.private.test:9200',
    'https://user:password@es.private.test:9200',
    'https://es.private.test:9200?token=secret',
  ])('rejects endpoint that does not meet verified credential-free HTTPS requirements: %s', (endpoint) => {
    expect(() => makeCollector({ endpoint })).toThrow(/verified HTTPS/);
  });
});
