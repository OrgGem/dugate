import {
  decodeLegacyInput,
  LegacyInputDecodeError,
  LEGACY_VARIANT_PARAMS,
  type LegacyCoreAction,
} from '../src/compat/legacy-input-decoders';
import {
  decodeLegacyPageToken,
  encodeLegacyPageToken,
  serializeLegacyOperation,
  serializeLegacyOperationsPage,
  toLegacyOperationState,
  type CanonicalOperationState,
  type LegacyOperationProjection,
} from '../src/compat/legacy-operation-serializers';

/** Minimal FormData stand-in: only `entries()` / `getAll()` are consulted. */
function fieldBag(entries: Array<readonly [string, unknown]>): object {
  const values = new Map<string, unknown[]>();
  for (const [key, value] of entries) {
    const existing = values.get(key) ?? [];
    existing.push(value);
    values.set(key, existing);
  }
  return {
    entries(): IterableIterator<readonly [string, unknown]> {
      return entries[Symbol.iterator]() as IterableIterator<readonly [string, unknown]>;
    },
    getAll(name: string): unknown[] {
      return values.get(name) ?? [];
    },
  };
}

function expectCode(run: () => unknown, code: string): LegacyInputDecodeError {
  let caught: unknown;
  try {
    run();
  } catch (error: unknown) {
    caught = error;
  }
  expect(caught).toBeInstanceOf(LegacyInputDecodeError);
  const err = caught as LegacyInputDecodeError;
  expect(err.code).toBe(code);
  return err;
}

const UUID_ISO = '2026-10-01T00:00:00.000Z';

describe('COMP-03b strict legacy input decoder', () => {
  describe('happy path', () => {
    it('decodes each of the six actions to its canonical variant and slug', () => {
      const cases: Array<[LegacyCoreAction, string, string]> = [
        ['ingest', 'mode', 'parse'],
        ['extract', 'type', 'custom'],
        ['analyze', 'task', 'compliance'],
        ['transform', 'action', 'rewrite'],
        ['generate', 'task', 'qa'],
        ['compare', 'mode', 'semantic'],
      ];
      for (const [action, field, variant] of cases) {
        const decoded = decodeLegacyInput(action, {
          form: fieldBag([[field, variant]]),
        });
        expect(decoded.action).toBe(action);
        expect(decoded.variant).toBe(variant);
        expect(decoded.endpointSlug).toBe(`${action}:${variant}`);
        expect(decoded.submission.input).toMatchObject({ variant });
      }
    });

    it('camel-cases a declared snake_case parameter into canonical input', () => {
      const decoded = decodeLegacyInput('transform', {
        form: fieldBag([['action', 'rewrite'], ['style', 'academic']]),
      });
      expect(decoded.submission.input).toMatchObject({ variant: 'rewrite', style: 'academic' });
    });

    it('forwards idempotency key, correlation id and the sync query flag', () => {
      const decoded = decodeLegacyInput('ingest', {
        form: fieldBag([['mode', 'parse']]),
        headers: { 'idempotency-key': 'idem-1', 'x-correlation-id': 'corr-1' },
        query: { sync: 'true' },
      });
      expect(decoded.idempotencyKey).toBe('idem-1');
      expect(decoded.correlationId).toBe('corr-1');
      expect(decoded.executeSync).toBe(true);
    });

    it('reads sync from the query only, never from the body', () => {
      const decoded = decodeLegacyInput('ingest', {
        form: fieldBag([['mode', 'parse'], ['sync', 'true']]),
        query: { sync: 'false' },
      });
      expect(decoded.executeSync).toBe(false);
    });

    it('defaults output.format to json when output_format is absent', () => {
      const decoded = decodeLegacyInput('ingest', { form: fieldBag([['mode', 'parse']]) });
      expect(decoded.submission.output).toEqual({ format: 'json' });
    });

    it('keeps a declared output_format', () => {
      const decoded = decodeLegacyInput('ingest', {
        form: fieldBag([['mode', 'parse'], ['output_format', 'md']]),
      });
      expect(decoded.submission.output).toEqual({ format: 'md' });
    });

    it('surfaces multipart files with their field role', () => {
      const decoded = decodeLegacyInput('compare', {
        form: fieldBag([
          ['mode', 'diff'],
          ['source_file', { name: 'a.pdf', size: 12 }],
          ['target_file', { name: 'b.pdf', size: 34 }],
        ]),
      });
      expect(decoded.files.map((f) => f.field)).toEqual(['source_file', 'target_file']);
      expect(decoded.files.map((f) => f.fileName)).toEqual(['a.pdf', 'b.pdf']);
    });

    it('parses file_urls into canonical input', () => {
      const decoded = decodeLegacyInput('compare', {
        form: fieldBag([
          ['mode', 'diff'],
          ['file_urls', JSON.stringify([{ url: 'https://example.com/c.pdf' }])],
        ]),
      });
      expect(decoded.fileUrls).toEqual([{ url: 'https://example.com/c.pdf' }]);
      expect(decoded.submission.input).toMatchObject({
        fileUrls: [{ url: 'https://example.com/c.pdf' }],
      });
    });

    it('maps webhook_url onto the canonical callback', () => {
      const decoded = decodeLegacyInput('generate', {
        form: fieldBag([['task', 'summary'], ['webhook_url', 'https://example.com/hook']]),
      });
      expect(decoded.submission.callback).toEqual({ url: 'https://example.com/hook' });
    });

    it('accepts every per-variant parameter the legacy registry attaches', () => {
      // Every declared variant must decode with each of its own parameters.
      const probe: Record<string, string> = {
        output_format: 'md',
        language: 'vi',
        pages: '1-5',
        fields: 'a,b',
        schema: '{"type":"object"}',
        categories: 'HĐ',
        criteria: 'signed',
        reference_data: '[]',
        extract_fields: 'total',
        focus: 'price',
        style: 'academic',
        tone: 'formal',
        template: 'form-a',
        format: 'bullets',
        questions: 'q1',
      };
      const actions: LegacyCoreAction[] = ['ingest', 'extract', 'analyze', 'transform', 'generate', 'compare'];
      let checked = 0;
      for (const action of actions) {
        for (const [variant, params] of Object.entries(LEGACY_VARIANT_PARAMS[action])) {
          const entries: Array<readonly [string, unknown]> = [[legacyDiscriminator(action), variant]];
          for (const param of params) entries.push([param, probe[param]!]);
          const decoded = decodeLegacyInput(action, { form: fieldBag(entries) });
          expect(decoded.variant).toBe(variant);
          checked += params.length;
        }
      }
      expect(checked).toBeGreaterThan(0);
    });
  });

  describe('fail-closed: discriminator', () => {
    it('rejects a missing discriminator', () => {
      const err = expectCode(() => decodeLegacyInput('extract', { form: fieldBag([]) }), 'MISSING_DISCRIMINATOR');
      expect(err.field).toBe('type');
    });

    it('rejects an empty / whitespace discriminator', () => {
      expectCode(() => decodeLegacyInput('extract', { form: fieldBag([['type', '   ']]) }), 'MISSING_DISCRIMINATOR');
    });

    it('rejects a variant the action does not define', () => {
      const err = expectCode(
        () => decodeLegacyInput('ingest', { form: fieldBag([['mode', 'not-a-mode']]) }),
        'INVALID_DISCRIMINATOR',
      );
      expect(err.field).toBe('mode');
    });

    it('rejects a variant that belongs to a different action', () => {
      expectCode(() => decodeLegacyInput('ingest', { form: fieldBag([['mode', 'invoice']]) }), 'INVALID_DISCRIMINATOR');
    });

    it('rejects an unknown action outright', () => {
      expectCode(() => decodeLegacyInput('workflows', { form: fieldBag([['process', 'lc-checker']]) }), 'UNSUPPORTED_ACTION');
    });

    it('rejects conflicting discriminator aliases', () => {
      expectCode(
        () => decodeLegacyInput('extract', { form: fieldBag([['type', 'invoice'], ['variant', 'contract']]) }),
        'CONFLICTING_DISCRIMINATOR',
      );
    });

    it('accepts agreeing aliases', () => {
      const decoded = decodeLegacyInput('extract', {
        form: fieldBag([['type', 'invoice'], ['variant', 'invoice']]),
      });
      expect(decoded.variant).toBe('invoice');
    });
  });

  describe('fail-closed: unknown fields', () => {
    it('rejects an unknown form field', () => {
      const err = expectCode(
        () => decodeLegacyInput('extract', { form: fieldBag([['type', 'invoice'], ['bogus_field', 'x']]) }),
        'UNKNOWN_FIELD',
      );
      expect(err.field).toBe('bogus_field');
    });

    it('rejects a parameter declared but attached to no variant (the legacy silent-drop set)', () => {
      // max_words, audience, glossary, redact_patterns, focus_areas and
      // target_language are declared in the registry but attached nowhere, so
      // legacy dropped them silently. Strict decoding refuses them instead.
      const orphans = ['max_words', 'audience', 'glossary', 'redact_patterns', 'focus_areas', 'target_language'];
      for (const orphan of orphans) {
        expectCode(
          () => decodeLegacyInput('generate', { form: fieldBag([['task', 'summary'], [orphan, 'x']]) }),
          'UNKNOWN_FIELD',
        );
      }
    });

    it('rejects type as an extra field on a non-extract action', () => {
      expectCode(
        () => decodeLegacyInput('generate', {
          form: fieldBag([['task', 'summary'], ['type', 'invoice']]),
        }),
        'UNKNOWN_FIELD',
      );
    });

    it('rejects unknown query keys instead of silently dropping them', () => {
      const err = expectCode(
        () => decodeLegacyInput('ingest', {
          form: fieldBag([['mode', 'parse']]),
          query: { sync: 'true', verbose: '1' },
        }),
        'UNKNOWN_FIELD',
      );
      expect(err.field).toBe('verbose');
      expectCode(
        () => decodeLegacyInput('ingest', {
          form: fieldBag([['mode', 'parse']]),
          query: new URLSearchParams([['sync', 'true'], ['verbose', '1']]),
        }),
        'UNKNOWN_FIELD',
      );
    });

    it('accepts only sync as a query parameter', () => {
      expect(() => decodeLegacyInput('ingest', {
        form: fieldBag([['mode', 'parse']]),
        query: { sync: 'false' },
      })).not.toThrow();
      expect(decodeLegacyInput('ingest', {
        form: fieldBag([['mode', 'parse']]),
        query: new URLSearchParams([['sync', 'true']]),
      }).executeSync).toBe(true);
      expectCode(
        () => decodeLegacyInput('ingest', {
          form: fieldBag([['mode', 'parse']]),
          query: { Sync: 'true' },
        }),
        'UNKNOWN_FIELD',
      );
    });

    it('rejects a parameter that belongs to another variant', () => {
      expectCode(
        () => decodeLegacyInput('ingest', { form: fieldBag([['mode', 'parse'], ['questions', 'q']]) }),
        'UNKNOWN_FIELD',
      );
    });

    it('rejects a non-string value for a declared parameter', () => {
      expectCode(
        () => decodeLegacyInput('transform', { form: fieldBag([['action', 'rewrite'], ['style', 42]]) }),
        'INVALID_FIELD_TYPE',
      );
    });

    it('rejects malformed file_urls', () => {
      expectCode(
        () => decodeLegacyInput('compare', { form: fieldBag([['mode', 'diff'], ['file_urls', '{not json']]) }),
        'INVALID_FILE_URLS',
      );
    });

    it('rejects a non-object callback', () => {
      expectCode(
        () => decodeLegacyInput('generate', { form: fieldBag([['task', 'summary'], ['callback', 'nope']]) }),
        'INVALID_CALLBACK',
      );
    });

    it('rejects an over-long source_url', () => {
      expectCode(
        () => decodeLegacyInput('ingest', { form: fieldBag([['mode', 'parse'], ['source_url', `https://e.com/${'x'.repeat(2100)}`]]) }),
        'INVALID_SOURCE_URL',
      );
    });
  });

  describe('fail-closed: identity fields (the legacy vulnerability)', () => {
    it('rejects a body apiKeyId and never copies it into the submission', () => {
      const err = expectCode(
        () => decodeLegacyInput('extract', {
          form: fieldBag([['type', 'invoice'], ['apiKeyId', 'attacker-key']]),
        }),
        'IDENTITY_FIELD_FORBIDDEN',
      );
      expect(err.field).toBe('apiKeyId');
    });

    it('rejects every snake_case / camel identity spelling in the body', () => {
      const identities = [
        'apiKeyId', 'api_key_id', 'xApiKeyId', 'x_api_key_id',
        'apiKey', 'api_key', 'xApiKey', 'x_api_key',
        'tenantId', 'tenant_id', 'userId', 'user_id', 'createdByUserId', 'authorization', 'role',
      ];
      for (const identity of identities) {
        expectCode(
          () => decodeLegacyInput('extract', {
            form: fieldBag([['type', 'invoice'], [identity, 'attacker']]),
          }),
          'IDENTITY_FIELD_FORBIDDEN',
        );
      }
    });

    it('rejects an x-api-key-id HEADER', () => {
      const err = expectCode(
        () => decodeLegacyInput('extract', {
          form: fieldBag([['type', 'invoice']]),
          headers: { 'x-api-key-id': 'internal-id' },
        }),
        'IDENTITY_FIELD_FORBIDDEN',
      );
      expect(err.field).toBe('x-api-key-id');
    });

    it('rejects identity headers regardless of case', () => {
      for (const header of [
        'X-Api-Key-Id', 'X-API-KEY-ID', 'x-tenant-id', 'X-User-Id',
        'Authorization', 'ApiKeyId', 'api_key_id', 'xApiKeyId', 'tenantId', 'userId', 'role',
      ]) {
        const err = expectCode(
          () => decodeLegacyInput('extract', {
            form: fieldBag([['type', 'invoice']]),
            headers: { [header]: 'spoofed' },
          }),
          'IDENTITY_FIELD_FORBIDDEN',
        );
        expect(err.message).toMatch(/identity is resolved from x-api-key/i);
      }
      const headersError = expectCode(
        () => decodeLegacyInput('extract', {
          form: fieldBag([['type', 'invoice']]),
          headers: new Headers([['Authorization', 'Bearer spoofed']]),
        }),
        'IDENTITY_FIELD_FORBIDDEN',
      );
      expect(headersError.message).toMatch(/identity is resolved from x-api-key/i);
    });

    it('allows the legitimate x-api-key header and never copies it into output', () => {
      // x-api-key is the real credential and must NOT be refused; it is simply
      // never read by the decoder. Positive control: a control field from the
      // SAME request does survive, so the assertions below are not vacuous.
      const decoded = decodeLegacyInput('extract', {
        form: fieldBag([['type', 'custom'], ['fields', 'a,b']]),
        headers: { 'x-api-key': 'real-credential' },
      });
      const serialized = JSON.stringify(decoded);
      expect(serialized).not.toContain('real-credential');
      expect(decoded.submission.input).toMatchObject({ variant: 'custom', fields: 'a,b' });
    });
  });
});

describe('COMP-03b legacy operation serializer', () => {
  const base: LegacyOperationProjection = {
    id: '11111111-1111-4111-8111-111111111111',
    state: 'ACCEPTED',
    createdAt: UUID_ISO,
    updatedAt: UUID_ISO,
  };

  describe('happy path', () => {
    it('emits name / done / metadata for a non-terminal operation', () => {
      const body = serializeLegacyOperation({ ...base, state: 'RUNNING', progressPercent: 40 });
      expect(Object.keys(body).sort()).toEqual(['done', 'metadata', 'name']);
      expect(body.name).toBe('operations/11111111-1111-4111-8111-111111111111');
      expect(body.done).toBe(false);
      expect(body.metadata.state).toBe('RUNNING');
      expect(body.metadata.canonical_state).toBe('RUNNING');
      expect(body.metadata.progress_percent).toBe(40);
    });

    it('emits the legacy result block for a SUCCEEDED operation', () => {
      const body = serializeLegacyOperation({
        ...base,
        state: 'SUCCEEDED',
        outputFormat: 'md',
        outputContent: '# hi',
        extractedData: { total: 10 },
        usage: { inputTokens: 5, outputTokens: 7, pagesProcessed: 2, modelUsed: 'm', costUsd: 0.25 },
      });
      expect(body.done).toBe(true);
      expect(body.result).toMatchObject({
        output_format: 'md',
        content: '# hi',
        extracted_data: { total: 10 },
        download_url: '/api/v1/operations/11111111-1111-4111-8111-111111111111/download',
      });
      expect(body.error).toBeUndefined();
    });

    it('emits the error block for a FAILED operation that supplied one', () => {
      const body = serializeLegacyOperation({
        ...base,
        state: 'FAILED',
        error: { code: 'STEP_FAILED', message: 'boom', failedStep: 2 },
      });
      expect(body.done).toBe(true);
      expect(body.error).toEqual({ code: 'STEP_FAILED', message: 'boom', failed_step: 2 });
    });

    it('maps every canonical state onto the legacy vocabulary', () => {
      const expected: Array<[CanonicalOperationState, string]> = [
        ['PENDING_INGESTION', 'PENDING'],
        ['ACCEPTED', 'PENDING'],
        ['QUEUED', 'PENDING'],
        ['RUNNING', 'RUNNING'],
        ['WAITING_CHILDREN', 'RUNNING'],
        ['WAITING_INPUT', 'RUNNING'],
        ['RETRY_PENDING', 'RUNNING'],
        ['CANCEL_REQUESTED', 'RUNNING'],
        ['SUCCEEDED', 'SUCCEEDED'],
        ['FAILED', 'FAILED'],
        ['CANCELLED', 'FAILED'],
        ['TIMED_OUT', 'FAILED'],
      ];
      for (const [state, legacy] of expected) {
        expect(toLegacyOperationState(state)).toBe(legacy);
      }
    });
  });

  describe('no fabricated terminal state', () => {
    it('CANCEL_REQUESTED is NOT done and carries no CANCELLED anywhere', () => {
      const body = serializeLegacyOperation({ ...base, state: 'CANCEL_REQUESTED' });
      expect(body.done).toBe(false);
      expect(body.metadata.state).toBe('RUNNING');
      expect(body.metadata.canonical_state).toBe('CANCEL_REQUESTED');
      expect(body.error).toBeUndefined();
      const serialized = JSON.stringify(body);
      expect(serialized).not.toContain('"CANCELLED"');
      expect(serialized).not.toContain('was cancelled');
    });

    it('a cancel request with no error object still fabricates nothing', () => {
      // The failure this module exists to prevent: the sibling COMP-06 module
      // synthesizes {code:'CANCELLED'} whenever a terminal state arrives with
      // no error. Here a FAILED operation with no supplied error stays silent.
      const body = serializeLegacyOperation({ ...base, state: 'FAILED', error: null });
      expect(body.done).toBe(true);
      expect(body.error).toBeUndefined();
    });

    it('CANCELLED is done only when the caller really says the state is CANCELLED', () => {
      const body = serializeLegacyOperation({ ...base, state: 'CANCELLED' });
      expect(body.done).toBe(true);
      expect(body.metadata.canonical_state).toBe('CANCELLED');
      // No invented reason, and no invented result block either.
      expect(body.error).toBeUndefined();
      expect(body.result).toBeUndefined();
    });

    it('never marks a non-terminal operation done even with a high percent', () => {
      const nonTerminal: CanonicalOperationState[] = [
        'PENDING_INGESTION', 'ACCEPTED', 'QUEUED', 'RUNNING',
        'WAITING_CHILDREN', 'WAITING_INPUT', 'RETRY_PENDING', 'CANCEL_REQUESTED',
      ];
      for (const state of nonTerminal) {
        const body = serializeLegacyOperation({ ...base, state, progressPercent: 99 });
        expect(body.done).toBe(false);
      }
    });
  });

  describe('page + next_page_token (4-slot cursor dialect)', () => {
    const page: Array<LegacyOperationProjection> = [
      { ...base, id: 'aaaaaaaa-1111-4111-8111-111111111111' },
      { ...base, id: 'bbbbbbbb-2222-4222-8222-222222222222', updatedAt: '2026-10-01T00:00:01.000Z' },
    ];

    it('round-trips a token through encode and decode', () => {
      const token = encodeLegacyPageToken({
        timestamp: UUID_ISO,
        id: 'bbbbbbbb-2222-4222-8222-222222222222',
        sort: 'createdAt:desc',
        direction: 'next',
      });
      const decoded = decodeLegacyPageToken(token);
      expect(decoded).not.toBeNull();
      expect(decoded!.id).toBe('bbbbbbbb-2222-4222-8222-222222222222');
      // The 4-slot dialect stores MICROSECONDS and re-emits the canonical
      // six-digit form, so a round trip is value-equal but not byte-equal to
      // the input. Asserted explicitly rather than glossed over.
      expect(decoded!.timestamp).toBe('2026-10-01T00:00:00.000000Z');
      expect(Date.parse(decoded!.timestamp)).toBe(Date.parse(UUID_ISO));
      expect(decoded!.sort).toBe('createdAt:desc');
      expect(decoded!.direction).toBe('next');
    });

    it('normalises millisecond input to the cursor dialect six-digit form', () => {
      const token = encodeLegacyPageToken({
        timestamp: '2026-10-01T00:00:00.123Z',
        id: 'dddddddd-4444-4444-8444-444444444444',
        sort: 'createdAt:asc',
        direction: 'next',
      });
      const decoded = decodeLegacyPageToken(token);
      expect(decoded!.timestamp).toBe('2026-10-01T00:00:00.123000Z');
      expect(decoded!.sort).toBe('createdAt:asc');
    });

    it('mints a decodable token when a next page exists', () => {
      const result = serializeLegacyOperationsPage({ items: page, hasMore: true });
      expect(result.next_page_token).not.toBeNull();
      const decoded = decodeLegacyPageToken(result.next_page_token!);
      // The token must describe the LAST item on the page, not the first.
      expect(decoded!.id).toBe('bbbbbbbb-2222-4222-8222-222222222222');
      expect(decoded!.timestamp).toBe('2026-10-01T00:00:01.000000Z');
    });

    it('returns null on the final page so a client stops instead of looping', () => {
      const result = serializeLegacyOperationsPage({ items: page, hasMore: false });
      expect(result.next_page_token).toBeNull();
      expect(result.operations).toHaveLength(2);
    });

    it('refuses to mint a token with no boundary row or timestamp', () => {
      expect(() => serializeLegacyOperationsPage({ items: [], hasMore: true })).toThrow(/no last item/);
      expect(() =>
        serializeLegacyOperationsPage({
          items: [{ id: 'cccccccc-3333-4333-8333-333333333333', state: 'QUEUED' }],
          hasMore: true,
        }),
      ).toThrow(/no updatedAt or createdAt/);
    });

    it('decodes a tampered or non-cursor token as null (fails closed)', () => {
      expect(decodeLegacyPageToken('not-a-cursor')).toBeNull();
      expect(decodeLegacyPageToken('')).toBeNull();
      expect(decodeLegacyPageToken('x'.repeat(300))).toBeNull();
    });
  });
});

function legacyDiscriminator(action: LegacyCoreAction): string {
  switch (action) {
    case 'ingest':
    case 'compare':
      return 'mode';
    case 'extract':
      return 'type';
    case 'analyze':
    case 'generate':
      return 'task';
    case 'transform':
      return 'action';
  }
}
