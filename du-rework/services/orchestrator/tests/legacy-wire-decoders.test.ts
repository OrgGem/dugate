import {
  decodeLegacyWire,
  LegacyWireDecodeError,
  type LegacyCoreAction,
} from '../src/compat/legacy-wire-decoders';

type TestFieldEntry = readonly [string, unknown];

function fieldBag(entries: TestFieldEntry[]): object {
  const values = new Map<string, unknown[]>();
  for (const [key, value] of entries) {
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }
  return {
    get(name: string): unknown {
      return values.get(name)?.[0] ?? null;
    },
    getAll(name: string): unknown[] {
      return values.get(name) ?? [];
    },
    has(name: string): boolean {
      return values.has(name);
    },
    entries(): IterableIterator<TestFieldEntry> {
      return entries[Symbol.iterator]();
    },
  };
}

function file(name: string, size = 3): Record<string, unknown> {
  return { name, size };
}

function expectDecodeCode(run: () => unknown, code: string): void {
  let caught: unknown;
  try {
    run();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LegacyWireDecodeError);
  expect((caught as LegacyWireDecodeError).code).toBe(code);
}

describe('COMP-02 legacy wire decoders', () => {
  it('normalizes each legacy core action discriminator into canonical variant', () => {
    const cases: Array<{ action: LegacyCoreAction; field: string; variant: string }> = [
      { action: 'ingest', field: 'mode', variant: 'ocr' },
      { action: 'extract', field: 'type', variant: 'id-card' },
      { action: 'analyze', field: 'task', variant: 'fact-check' },
      { action: 'transform', field: 'action', variant: 'translate' },
      { action: 'generate', field: 'task', variant: 'qa' },
      { action: 'compare', field: 'mode', variant: 'semantic' },
    ];

    for (const testCase of cases) {
      const decoded = decodeLegacyWire(testCase.action, {
        form: { [testCase.field]: ` ${testCase.variant} `, target_language: 'vi' },
      });
      expect(decoded.action).toBe(testCase.action);
      expect(decoded.variant).toBe(testCase.variant);
      expect(decoded.submission.input).toMatchObject({ variant: testCase.variant, targetLanguage: 'vi' });
      expect(decoded.presence.inputFields).toContain('targetLanguage');
    }
  });

  it('merges legacy params and flat body fields while preserving JSON parameter values', () => {
    const decoded = decodeLegacyWire('analyze', {
      body: {
        task: 'fact-check',
        reference_data: '[{"claim":"x"}]',
        parameters: '{"extract_fields":"claim,source"}',
      },
      params: { criteria: 'confirm dates' },
      form: { extract_fields: 'summary' },
    });

    expect(decoded.submission.input).toEqual({
      referenceData: '[{"claim":"x"}]',
      extractFields: 'summary',
      criteria: 'confirm dates',
      variant: 'fact-check',
    });
  });

  it('decodes multipart file aliases and file_urls without putting bytes in JSON input', () => {
    const fileA = file('multi-a.pdf');
    const fileB = file('multi-b.pdf');
    const source = file('source.pdf');
    const target = file('target.pdf');
    const single = file('single.pdf');
    const form = fieldBag([
      ['files[]', fileA],
      ['files[]', fileB],
      ['source_file', source],
      ['target_file', target],
      ['file', single],
      ['mode', 'parse'],
      ['file_urls', JSON.stringify([{ url: 'https://example.test/doc.pdf', file_name: 'remote.pdf' }])],
    ]);

    const decoded = decodeLegacyWire('ingest', { form });

    expect(decoded.files).toEqual([
      { field: 'files[]', value: fileA },
      { field: 'files[]', value: fileB },
      { field: 'source_file', value: source },
      { field: 'target_file', value: target },
      { field: 'file', value: single },
    ]);
    expect(decoded.fileUrls).toEqual([{ url: 'https://example.test/doc.pdf', fileName: 'remote.pdf' }]);
    expect(decoded.submission.input.fileUrls).toEqual(decoded.fileUrls);
    expect(decoded.submission.input).not.toHaveProperty('file');
    expect(decoded.submission.input).not.toHaveProperty('sourceFile');
    expect(decoded.presence.fileUrls).toBe(true);
    expect(decoded.presence.fileFields).toEqual(['files[]', 'source_file', 'target_file', 'file']);
  });

  it('maps legacy headers and control fields while preserving present-empty values', () => {
    const decoded = decodeLegacyWire('transform', {
      form: fieldBag([
        ['action', 'rewrite'],
        ['style', ''],
        ['output_format', ''],
        ['webhook_url', ''],
      ]),
      headers: { 'Idempotency-Key': '', 'X-Correlation-Id': 'legacy-corr-0001' },
      query: { sync: 'true' },
    });

    expect(decoded.submission.input).toEqual({ variant: 'rewrite', style: '' });
    expect(decoded.submission.output).toEqual({ format: '' });
    expect(decoded.submission.callback).toEqual({ url: '' });
    expect(decoded.idempotencyKey).toBe('');
    expect(decoded.correlationId).toBe('legacy-corr-0001');
    expect(decoded.executeSync).toBe(true);
    expect(decoded.presence).toMatchObject({
      outputFormat: true,
      callback: true,
      idempotencyKey: true,
      correlationId: true,
      executeSync: true,
    });
    expect(decoded.presence.inputFields).toContain('style');
  });

  it('uses legacy defaults but distinguishes an absent output format from an explicit one', () => {
    const decoded = decodeLegacyWire('compare', { form: { mode: 'diff' } });
    expect(decoded.submission.output).toEqual({ format: 'json' });
    expect(decoded.presence.outputFormat).toBe(false);
    expect(decoded.presence.sourceUrl).toBe(false);
    expect(decoded.presence.callback).toBe(false);
  });

  it('does not trust identity or submission-control values supplied in body or auth headers', () => {
    const decoded = decodeLegacyWire('ingest', {
      body: {
        mode: 'parse',
        tenant_id: 'spoofed-tenant',
        api_key_id: 'spoofed-key',
        userId: 'spoofed-user',
        idempotencyKey: 'body-key',
        correlationId: 'body-correlation',
      },
      headers: {
        authorization: 'Bearer untrusted',
        'x-api-key-id': 'spoofed-key',
        'x-user-id': 'spoofed-user',
      },
    });

    expect(decoded.submission.input).toEqual({ variant: 'parse' });
    expect(decoded).not.toHaveProperty('idempotencyKey');
    expect(decoded).not.toHaveProperty('correlationId');
  });

  it('accepts canonical callback and source URL fields and legacy header casing', () => {
    const decoded = decodeLegacyWire('extract', {
      body: {
        type: 'custom',
        source_url: 'https://example.test/source.pdf',
        callback: { url: 'https://example.test/callback' },
        output: { media_type: 'application/json' },
      },
      headers: { 'x-correlation-id': 'compat-correlation-01', 'idempotency-key': 'job.1' },
    });

    expect(decoded.submission.sourceUrl).toBe('https://example.test/source.pdf');
    expect(decoded.submission.callback).toEqual({ url: 'https://example.test/callback' });
    expect(decoded.submission.output).toEqual({ mediaType: 'application/json', format: 'json' });
    expect(decoded.correlationId).toBe('compat-correlation-01');
    expect(decoded.idempotencyKey).toBe('job.1');
  });

  it('fails closed for unsupported actions and missing, invalid, or conflicting discriminators', () => {
    expectDecodeCode(() => decodeLegacyWire('workflows', {}), 'UNSUPPORTED_ACTION');
    expectDecodeCode(() => decodeLegacyWire('ingest', {}), 'MISSING_DISCRIMINATOR');
    expectDecodeCode(() => decodeLegacyWire('extract', { form: { type: 'not-a-variant' } }), 'INVALID_DISCRIMINATOR');
    expectDecodeCode(() => decodeLegacyWire('ingest', { body: { mode: 'ocr', variant: 'parse' } }), 'CONFLICTING_DISCRIMINATOR');
  });

  it('rejects malformed parameter objects, alias collisions, file URL JSON, callback, and headers', () => {
    expectDecodeCode(() => decodeLegacyWire('ingest', { body: { mode: 'parse', params: '{bad' } }), 'INVALID_PARAMETERS');
    expectDecodeCode(() => decodeLegacyWire('ingest', { body: { mode: 'parse', source_language: 'en', sourceLanguage: 'fr' } }), 'CONFLICTING_PARAMETER');
    expectDecodeCode(() => decodeLegacyWire('ingest', { form: { mode: 'parse', file_urls: '{bad' } }), 'INVALID_FILE_URLS');
    expectDecodeCode(() => decodeLegacyWire('ingest', { form: { mode: 'parse', file_urls: '[{"url":"not a url"}]' } }), 'INVALID_FILE_URLS');
    expectDecodeCode(() => decodeLegacyWire('ingest', { body: { mode: 'parse', callback: 'https://example.test/hook' } }), 'INVALID_CALLBACK');
    expectDecodeCode(() => decodeLegacyWire('ingest', { body: { mode: 'parse' }, headers: { 'idempotency-key': 10 } }), 'INVALID_HEADER');
  });

  it('rejects conflicting header aliases instead of choosing one silently', () => {
    expectDecodeCode(() => decodeLegacyWire('generate', {
      body: { task: 'summary' },
      headers: { 'x-correlation-id': 'request-a', 'correlation-id': 'request-b' },
    }), 'INVALID_HEADER');
  });
});
