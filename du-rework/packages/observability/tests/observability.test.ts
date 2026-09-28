import {
  redact,
  redactString,
  safeErrorForLog,
  REDACTED,
  SAFE_UNEXPECTED_ERROR_KIND,
  SAFE_UNEXPECTED_ERROR_MESSAGE,
} from '../src/redaction';
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
    expect(redactString('download at https://s3.example/x?X-Amz-Signature=abc123 now')).toContain('[REDACTED:url]');
    expect(redactString('Authorization: Bearer eyJhbGciOi')).not.toContain('eyJhbGciOi');
    expect(redactString('key AKIAIOSFODNN7EXAMPLE')).toContain('[REDACTED:provider_key]');
  });

  it('uses the ADM-BASE-03 safe error taxonomy without exception text or stack', () => {
    const err = new Error('boom with Bearer secret-token-value');
    const out = redact(err) as Record<string, unknown>;
    expect(out).toEqual({
      kind: SAFE_UNEXPECTED_ERROR_KIND,
      message: SAFE_UNEXPECTED_ERROR_MESSAGE,
    });
    expect(JSON.stringify(out)).not.toContain('secret-token-value');
    expect(JSON.stringify(out)).not.toContain('stack');
    expect(safeErrorForLog(err)).toEqual(out);
  });

  it('bounds array logging', () => {
    const big = Array.from({ length: 500 }, (_, i) => i);
    const out = redact(big) as unknown[];
    expect(out.length).toBeLessThanOrEqual(100);
  });

  it('redacts byte arrays and cycles without serializing their contents', () => {
    const cyclic: Record<string, unknown> = { blob: Buffer.from('RAW_ARTIFACT_SENTINEL') };
    cyclic.self = cyclic;
    const safe = JSON.stringify(redact(cyclic));
    expect(safe).not.toContain('RAW_ARTIFACT_SENTINEL');
    expect(safe).toContain('[REDACTED:bytes:21]');
    expect(safe).toContain('[REDACTED:circular]');
  });

  it('redacts provider keys, DB credentials, URL query tokens, webhook payloads, and artifact names at the JSON boundary', () => {
    const sentinels = [
      'BEARER_TOKEN_SENTINEL_9b8c7d6e',
      'sk_live_provider_key_SENTINEL_123456',
      'sk_test_provider_key_SENTINEL_654321',
      'sk-proj-provider_key_SENTINEL_abcdef123456',
      'xoxb-workspace-provider-token-SENTINEL',
      'ghp_0123456789abcdefghijklmnop',
      'AKIAIOSFODNN7EXAMPLE',
      'ASIAIOSFODNN7EXAMPLE',
      'AIza0123456789abcdefghijklmnopqrstuv',
      'hvs.vault-secret-SENTINEL-123',
      'hvb.vault-secret-SENTINEL-456',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZW50aW5lbCJ9.c2lnbmF0dXJl',
      'PRIVATE_KEY_BODY_SENTINEL',
      'DB_PASSWORD_SENTINEL',
      'SIGNED_QUERY_SENTINEL',
      'URL_TOKEN_SENTINEL',
      'WEBHOOK_CUSTOMER_SENTINEL',
      'Acquisition-Target-Alpha-2026.pdf',
      'customer-contract-sensitive.docx',
      'C:\\Users\\operator\\secrets\\vault.key',
      'NoExtensionSensitiveArtifactName',
    ];
    const lines: LogRecord[] = [];
    const logger = createLogger({
      service: 'orchestrator',
      environment: 'test',
      sink: { write: (line) => lines.push(JSON.parse(line) as LogRecord) },
    });
    logger.error('failed for Bearer BEARER_TOKEN_SENTINEL_9b8c7d6e; artifact Acquisition-Target-Alpha-2026.pdf', {
      authorization: 'Bearer BEARER_TOKEN_SENTINEL_9b8c7d6e',
      providerKey: sentinels[1],
      testProviderKey: sentinels[2],
      openAiKey: sentinels[3],
      slackCredential: sentinels[4],
      githubCredential: sentinels[5],
      awsAccessKey: sentinels[6],
      awsSessionKey: sentinels[7],
      googleApiKey: sentinels[8],
      vaultToken: sentinels[9],
      secondVaultToken: sentinels[10],
      jwt: sentinels[11],
      privateKey: `-----BEGIN RSA PRIVATE KEY-----\n${sentinels[12]}\n-----END RSA PRIVATE KEY-----`,
      databaseUrl: `postgres://operator:${sentinels[13]}@db.internal:5432/workflows`,
      signedUrl: `https://s3.example/object?X-Amz-Signature=${sentinels[14]}`,
      queryUrl: `https://files.example/object?access_token=${sentinels[15]}`,
      webhookPayload: { customer: sentinels[16] },
      artifactName: sentinels[17],
      fileName: sentinels[18],
      localPath: sentinels[19],
      artifact: { name: sentinels[20] },
      error: new Error(`driver failure ${sentinels.join(' ')}`),
    });

    const line = JSON.stringify(lines[0]);
    for (const sentinel of sentinels) expect(line).not.toContain(sentinel);
    expect(line).toContain(SAFE_UNEXPECTED_ERROR_KIND);
    expect(line).toContain(SAFE_UNEXPECTED_ERROR_MESSAGE);
    expect(line).not.toContain('driver failure');
    expect(line).not.toContain('stack');
  });

  it('redacts each inline provider, credential URL, payload, path, and filename pattern', () => {
    const riskyValues = [
      'Authorization: Bearer INLINE_BEARER_SENTINEL',
      'sk_live_inline-provider-secret-123456',
      'sk_test_inline-provider-secret-123456',
      'sk-proj-inline-provider-secret-1234567890',
      'xoxp-inline-provider-token-1234567890',
      'gho_0123456789abcdefghijklmnop',
      'AKIAIOSFODNN7EXAMPLE',
      'ASIAIOSFODNN7EXAMPLE',
      'AIza0123456789abcdefghijklmnopqrstuv',
      'hvs.inline-vault-token-secret',
      'hvb.inline-vault-token-secret',
      'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJzZW50aW5lbCJ9.c2lnbmF0dXJl',
      '-----BEGIN RSA PRIVATE KEY-----\nINLINE_PRIVATE_KEY_SENTINEL\n-----END RSA PRIVATE KEY-----',
      'postgres://dbuser:INLINE_DB_PASSWORD@database.internal:5432/app',
      'https://storage.example/a?token=INLINE_QUERY_TOKEN',
      'https://storage.example/a?X-Amz-Signature=INLINE_SIGNED_URL_SECRET',
      'webhook payload: {"customer":"INLINE_WEBHOOK_PAYLOAD"}',
      'sensitive-artifact-brief.pdf',
      'D:\\service\\files\\inline-secret.docx',
    ];
    for (const value of riskyValues) expect(redactString(value)).not.toContain(value);
    expect(redactString(riskyValues[12]!)).not.toContain('INLINE_PRIVATE_KEY_SENTINEL');
    expect(redactString(riskyValues[13]!)).not.toContain('INLINE_DB_PASSWORD');
    expect(redactString(riskyValues[14]!)).not.toContain('INLINE_QUERY_TOKEN');
    expect(redactString(riskyValues[15]!)).not.toContain('INLINE_SIGNED_URL_SECRET');
    expect(redactString(riskyValues[16]!)).not.toContain('INLINE_WEBHOOK_PAYLOAD');
  });

  it('redacts crypto key material and filenames even in free-form error text', () => {
    const sentinels = [
      'LOG01_CRYPTO_KEY_SENTINEL',
      'LOG01_ENCRYPTION_KEY_SENTINEL',
      'LOG01_WRAPPED_DEK_SENTINEL',
      'LOG01_RAW_DEK_SENTINEL',
      'LOG01_PRIVATE_KEY_SENTINEL',
      'LOG01_PUBLIC_KEY_SENTINEL',
      'LOG01_FILENAME_NO_EXT_SENTINEL',
      'LOG01_ARTIFACT_NAME_NO_EXT_SENTINEL',
    ];
    const output = JSON.stringify(redact({
      cryptoKey: sentinels[0],
      encryptionKey: sentinels[1],
      wrappedDek: sentinels[2],
      dek: sentinels[3],
      privateKeyPem: sentinels[4],
      publicKeyPem: sentinels[5],
      message: `dek=${sentinels[3]} filename=${sentinels[6]} artifactName=${sentinels[7]}`,
    }));
    for (const sentinel of sentinels) expect(output).not.toContain(sentinel);

    const publicPem = redactString(
      `-----BEGIN PUBLIC KEY-----\n${sentinels[5]}\n-----END PUBLIC KEY-----`,
    );
    expect(publicPem).not.toContain(sentinels[5]);
  });

  it('redacts long base64 payload strings before truncating log text', () => {
    const payload = 'Q'.repeat(300);
    const safe = redactString(`request body ${payload}`);
    expect(safe).not.toContain(payload);
    expect(safe).toContain('[REDACTED:base64]');
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
  function captureLogger(component = 'test', version = 'unknown') {
    const lines: LogRecord[] = [];
    const logger = createLogger({
      component,
      version,
      level: 'debug',
      sink: { write: (l) => lines.push(JSON.parse(l) as LogRecord) },
      now: () => new Date('2026-09-20T12:00:00Z'),
    });
    return { logger, lines };
  }

  it('emits the required structured JSON schema with stable environment and correlation fields', () => {
    const { logger, lines } = captureLogger('orchestrator', '2026.09.20+test');
    logger.info('hello', { foo: 'bar' });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({
      timestamp: '2026-09-20T12:00:00.000Z',
      level: 'info',
      service: 'orchestrator',
      version: '2026.09.20+test',
      environment: 'test',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      operationId: null,
      taskId: null,
      invocationId: null,
      message: 'hello',
      foo: 'bar',
    });
    expect(lines[0]).not.toHaveProperty('component');
    expect(lines[0]).not.toHaveProperty('ts');
    expect(lines[0]).not.toHaveProperty('msg');
  });

  it('uses service and environment options and keeps invocation identity in the schema', () => {
    const lines: LogRecord[] = [];
    const logger = createLogger({
      service: 'worker-sdk',
      version: '0.4.2',
      environment: 'staging',
      sink: { write: (line) => lines.push(JSON.parse(line) as LogRecord) },
    });
    logger.info('invocation started', { taskId: 'task-123', invocationId: 'invoke-456' });
    expect(lines[0]).toMatchObject({
      service: 'worker-sdk',
      version: '0.4.2',
      environment: 'staging',
      taskId: 'task-123',
      invocationId: 'invoke-456',
    });
  });

  it('writes a single redacted JSON line through the default stdout sink', () => {
    const write = jest.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      createLogger({ service: 'worker-sdk', environment: 'test' }).error(
        'provider rejected Bearer STDOUT_BEARER_SENTINEL',
        { apiKey: 'sk-live-STDOUT_PROVIDER_SENTINEL_123456' },
      );
      expect(write).toHaveBeenCalledTimes(1);
      const output = String(write.mock.calls[0]?.[0] ?? '');
      expect(output.endsWith('\n')).toBe(true);
      const record = JSON.parse(output) as LogRecord;
      expect(record.service).toBe('worker-sdk');
      expect(output).not.toContain('STDOUT_BEARER_SENTINEL');
      expect(output).not.toContain('STDOUT_PROVIDER_SENTINEL');
    } finally {
      write.mockRestore();
    }
  });

  it('attaches correlation fields from context', () => {
    const { logger, lines } = captureLogger();
    runWithContext(
      { component: 'worker', correlationId: 'corr-12345678', operationId: 'op-1', taskId: 't-1', invocationId: 'invoke-1', leaseEpoch: 3 },
      () => logger.info('claimed', { operationId: 'field-op-spoof', taskId: 'field-task-spoof' })
    );
    expect(lines[0]).toMatchObject({
      correlationId: 'corr-12345678',
      operationId: 'op-1',
      taskId: 't-1',
      invocationId: 'invoke-1',
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
