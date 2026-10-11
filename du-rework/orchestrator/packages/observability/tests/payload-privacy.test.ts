import { createLogger, type LogLevel } from '../src/logger';
import { metadataLogRecord } from '../src/log-metadata';
import { REDACTED, redact, safeErrorForLog } from '../src/redaction';
import { SAFE_LOG_MESSAGES } from '../src/log-events';

describe('metadata-only logging', () => {
  test.each<LogLevel>(['trace', 'debug', 'info', 'warn', 'error'])('%s never emits input/output, arbitrary fields or dynamic messages', level => {
    const lines: string[] = [];
    const logger = createLogger({ service: 'orchestrator', level: 'trace', sink: { write: line => lines.push(line) },
      baseFields: { input: 'BASE_INPUT_PRIVATE', privateCustomerData: 'BASE_PRIVATE' } });
    const child = logger.child({ output: { text: 'CHILD_OUTPUT_PRIVATE' }, businessId: 'document-core' });
    child[level]('dynamic message contains REQUEST_PRIVATE', {
      input: { text: 'INPUT_PRIVATE' }, output: ['OUTPUT_PRIVATE'], requestBody: { customer: 'REQUEST_BODY_PRIVATE' },
      responseBody: 'RESPONSE_BODY_PRIVATE', result: 'RESULT_PRIVATE', prompt: 'PROMPT_PRIVATE',
      freeText: 'OTHER_PRIVATE', error: new Error('ERROR_PRIVATE'),
      ['alice@example.com']: 'KEY_PRIVATE', operationId: 'op-1', durationMs: 42, inputBytes: 123, outputBytes: 456,
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('PRIVATE');
    expect(lines[0]).not.toContain('alice@example.com');
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record).toMatchObject({ message: REDACTED, businessId: 'document-core', operationId: 'op-1', durationMs: 42,
      inputBytes: 123, outputBytes: 456 });
    for (const key of ['input', 'output', 'requestBody', 'responseBody', 'result', 'prompt', 'freeText']) {
      expect(record).not.toHaveProperty(key);
    }
  });

  test('static event descriptions and bounded identifiers/counters survive', () => {
    const safe = metadataLogRecord({ message: 'handler failed', service: 'worker-sdk', taskId: 'task-1',
      errorCode: 'DOCUMENT_PARSE_FAILED', retryInMs: 2000, retryable: true,
      details: { input: 'PRIVATE' }, taskName: 'PRIVATE', errorClass: { raw: 'PRIVATE' } });
    expect(safe).toEqual({ message: 'handler failed', service: 'worker-sdk', taskId: 'task-1',
      errorCode: 'DOCUMENT_PARSE_FAILED', retryInMs: 2000, retryable: true });
  });

  test('collector projection removes disguised nested/free-form payloads before spooling or delivering', () => {
    const safe = metadataLogRecord({ timestamp: '2026-10-05T00:00:00.000Z', level: 'info', service: 'connector',
      version: '1', environment: 'prod', correlationId: 'corr-1', message: 'raw customer CONTENT_SENTINEL',
      unrelated: { nested: ['INPUT_SENTINEL', 'OUTPUT_SENTINEL'] }, response: 'RESPONSE_SENTINEL',
      payloadInCounterBytes: 'DISGUISED_SENTINEL', apiKey: 'SECRET_SENTINEL' });
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');
    expect(safe).toMatchObject({ service: 'connector', correlationId: 'corr-1', message: REDACTED, apiKey: REDACTED });
  });

  test('generic redaction hides input/output refs and content as whole values', () => {
    const safe = redact({ input: 'INPUT_SENTINEL', output: { text: 'OUTPUT_SENTINEL' },
      inputRef: 'REF_SENTINEL', outputText: 'TEXT_SENTINEL', promptContent: 'PROMPT_SENTINEL' });
    expect(JSON.stringify(safe)).not.toContain('SENTINEL');
  });

  test('CR10-02-D1: the usage dispatch cycle failure label is allowlisted verbatim', () => {
    expect(SAFE_LOG_MESSAGES).toBeInstanceOf(Set);
    expect(SAFE_LOG_MESSAGES.has('usage dispatch cycle failed')).toBe(true);
    const safe = metadataLogRecord({ message: 'usage dispatch cycle failed', service: 'connector',
      subsystem: 'usage-dispatcher', level: 'error', error: safeErrorForLog(new Error('database unavailable')) });
    expect(safe).toMatchObject({ message: 'usage dispatch cycle failed', subsystem: 'usage-dispatcher',
      error: { kind: 'UNEXPECTED_ERROR', message: 'Unexpected error; details redacted.' } });
  });

  test('CR10-02-D1: the connector log line keeps its label end to end', () => {
    const lines: string[] = [];
    const logger = createLogger({ service: 'connector', level: 'error',
      sink: { write: line => lines.push(line) }, baseFields: { subsystem: 'usage-dispatcher' } });
    logger.error('usage dispatch cycle failed', { error: safeErrorForLog(new Error('database unavailable')) });
    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as Record<string, unknown>;
    expect(record.message).toBe('usage dispatch cycle failed');
    expect(record.message).not.toBe(REDACTED);
    expect(record).toMatchObject({ subsystem: 'usage-dispatcher', level: 'error', service: 'connector' });
  });

  test('CR10-02-D1: allowlisting is exact - near-miss and prefix messages stay redacted', () => {
    for (const message of ['usage dispatch cycle failed: database unavailable', 'usage dispatch cycle failure',
      'Usage dispatch cycle failed', 'usage dispatch cycle failed ', 'usage dispatch cycle']) {
      const safe = metadataLogRecord({ message, subsystem: 'usage-dispatcher' }) as Record<string, unknown>;
      expect(safe.message).toBe(REDACTED);
    }
  });

  test('OR10-01: origin policy warning keeps the canonical origin and bounded event without credentials', () => {
    const lines: string[] = [];
    const logger = createLogger({ service: 'orchestrator', level: 'warn', sink: { write: line => lines.push(line) } });
    logger.warn('credential origin policy warning', {
      operationId: 'op-1',
      tenantId: 'tenant-1',
      origin: 'https://files.example:8443',
      code: 'ORIGIN_NOT_ALLOWLISTED',
      state: 'warn',
      token: 'SECRET_CREDENTIAL_SENTINEL',
      event: { kind: 'credential.origin_denied', reason: 'ORIGIN_NOT_ALLOWLISTED', action: 'warn' },
    });
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('SECRET_CREDENTIAL_SENTINEL');
    expect(JSON.parse(lines[0]!) as Record<string, unknown>).toMatchObject({
      message: 'credential origin policy warning',
      operationId: 'op-1',
      tenantId: 'tenant-1',
      origin: 'https://files.example:8443',
      code: 'ORIGIN_NOT_ALLOWLISTED',
      state: 'warn',
      event: { kind: 'credential.origin_denied', reason: 'ORIGIN_NOT_ALLOWLISTED', action: 'warn' },
      token: REDACTED,
    });
  });
});
