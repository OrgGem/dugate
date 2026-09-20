import { redact, redactString, REDACTED } from '../src/redaction';
import { createLogger, LogRecord } from '../src/logger';
import { runWithContext, withContext, currentContext, normalizeCorrelationId } from '../src/context';
import { InMemoryMetricsRegistry, METRIC_NAMES } from '../src/metrics';

describe('redaction (docs 12)', () => {
  it('redacts sensitive keys at any depth', () => {
    const out = redact({
      operationId: 'op-1',
      config: { authorization: 'Bearer abc', nested: { apiKey: 'sk-secret', safe: 1 } },
    }) as Record<string, unknown>;
    const config = out.config as Record<string, unknown>;
    expect(config.authorization).toBe(REDACTED);
    expect((config.nested as Record<string, unknown>).apiKey).toBe(REDACTED);
    expect((config.nested as Record<string, unknown>).safe).toBe(1);
    expect(out.operationId).toBe('op-1');
  });

  it('redacts signed URLs and bearer tokens in strings', () => {
    expect(redactString('download at https://s3.example/x?X-Amz-Signature=abc123 now')).toContain(REDACTED);
    expect(redactString('Authorization: Bearer eyJhbGciOi')).not.toContain('eyJhbGciOi');
    expect(redactString('key AKIAIOSFODNN7EXAMPLE')).toContain(REDACTED);
  });

  it('redacts Error stacks but keeps name/message', () => {
    const err = new Error('boom with Bearer secret-token-value');
    const out = redact(err) as Record<string, unknown>;
    expect(out.name).toBe('Error');
    expect(out.stack).toBe(REDACTED);
    expect(String(out.message)).not.toContain('secret-token-value');
  });

  it('bounds array logging', () => {
    const big = Array.from({ length: 500 }, (_, i) => i);
    const out = redact(big) as unknown[];
    expect(out.length).toBeLessThanOrEqual(100);
  });
});

describe('correlation context', () => {
  it('propagates through async boundaries', async () => {
    await runWithContext({ component: 'test', correlationId: 'corr-12345678', operationId: 'op-9' }, async () => {
      await new Promise((r) => setTimeout(r, 1));
      const ctx = currentContext();
      expect(ctx?.correlationId).toBe('corr-12345678');
      expect(ctx?.operationId).toBe('op-9');
    });
  });

  it('withContext merges nested scopes without leaking', async () => {
    await runWithContext({ component: 'test', correlationId: 'corr-12345678' }, async () => {
      await withContext({ taskId: 'task-1', stepKey: 'parse' }, async () => {
        expect(currentContext()?.taskId).toBe('task-1');
      });
      expect(currentContext()?.taskId).toBeUndefined();
    });
  });

  it('generates correlation id when absent', () => {
    expect(currentContext()).toBeUndefined();
    runWithContext({ component: 'test' }, () => {
      expect(currentContext()?.correlationId).toMatch(/^[0-9a-f-]{36}$/);
    });
  });

  it('normalizeCorrelationId validates charset/length and falls back to server id', () => {
    expect(normalizeCorrelationId('valid.id_12345')).toBe('valid.id_12345');
    expect(normalizeCorrelationId('short')).not.toBe('short'); // too short → replaced
    expect(normalizeCorrelationId('has spaces in it')).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalizeCorrelationId(12345)).toMatch(/^[0-9a-f-]{36}$/);
    expect(normalizeCorrelationId(undefined)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('structured logger', () => {
  function captureLogger(component = 'test') {
    const lines: LogRecord[] = [];
    const logger = createLogger({
      component,
      level: 'debug',
      sink: { write: (l) => lines.push(JSON.parse(l) as LogRecord) },
      now: () => new Date('2026-09-20T12:00:00Z'),
    });
    return { logger, lines };
  }

  it('emits JSON records with ts/level/component/msg', () => {
    const { logger, lines } = captureLogger('orchestrator');
    logger.info('hello', { foo: 'bar' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      ts: '2026-09-20T12:00:00.000Z',
      level: 'info',
      component: 'orchestrator',
      msg: 'hello',
      foo: 'bar',
    });
  });

  it('attaches correlation fields from context', () => {
    const { logger, lines } = captureLogger();
    runWithContext(
      { component: 'worker', correlationId: 'corr-12345678', operationId: 'op-1', taskId: 't-1', leaseEpoch: 3 },
      () => logger.info('claimed')
    );
    expect(lines[0]).toMatchObject({
      correlationId: 'corr-12345678',
      operationId: 'op-1',
      taskId: 't-1',
      leaseEpoch: 3,
    });
  });

  it('redacts sensitive fields passed to log calls', () => {
    const { logger, lines } = captureLogger();
    logger.info('auth attempt', { apiKey: 'sk-live-secret', user: 'ok' });
    expect(lines[0]!.apiKey).toBe(REDACTED);
    expect(lines[0]!.user).toBe('ok');
  });

  it('respects log level', () => {
    const lines: LogRecord[] = [];
    const logger = createLogger({ component: 'x', level: 'warn', sink: { write: (l) => lines.push(JSON.parse(l)) } });
    logger.debug('nope');
    logger.info('nope');
    logger.warn('yes');
    logger.error('yes');
    expect(lines).toHaveLength(2);
  });

  it('child loggers inherit and extend base fields', () => {
    const { logger, lines } = captureLogger();
    const child = logger.child({ businessId: 'document-core' });
    child.info('step done', { stepKey: 'parse' });
    expect(lines[0]).toMatchObject({ businessId: 'document-core', stepKey: 'parse' });
  });
});

describe('bounded metrics (docs 12)', () => {
  it('counters/gauges/histograms record values', () => {
    const reg = new InMemoryMetricsRegistry();
    reg.counter(METRIC_NAMES.retries).inc({ business: 'document-core' });
    reg.counter(METRIC_NAMES.retries).inc({ business: 'document-core' }, 2);
    reg.gauge(METRIC_NAMES.activeLeases).set(5, { business: 'document-core' });
    reg.histogram(METRIC_NAMES.providerLatency).observe(120, { slot: 'reasoning' });

    const snap = reg.snapshot();
    const retries = snap.find((s) => s.name === METRIC_NAMES.retries);
    expect(retries?.value).toBe(3);
    const leases = snap.find((s) => s.name === METRIC_NAMES.activeLeases);
    expect(leases?.value).toBe(5);
    const latency = snap.find((s) => s.name === METRIC_NAMES.providerLatency);
    expect(latency?.count).toBe(1);
    expect(latency?.sum).toBe(120);
  });

  it('rejects unbounded-cardinality labels (operationId etc.)', () => {
    const reg = new InMemoryMetricsRegistry();
    expect(() => reg.counter('du_test_total').inc({ operationId: 'op-1' })).toThrow(/forbidden/);
    expect(() => reg.gauge('du_test_g').set(1, { taskId: 't' })).toThrow(/forbidden/);
  });

  it('rejects invalid metric names and negative counter increments', () => {
    const reg = new InMemoryMetricsRegistry();
    expect(() => reg.counter('Bad-Name')).toThrow(/snake_case/);
    expect(() => reg.counter('du_x_total').inc({}, -1)).toThrow(/>= 0/);
  });
});