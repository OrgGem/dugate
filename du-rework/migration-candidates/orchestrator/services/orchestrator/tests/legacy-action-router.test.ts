import {
  createLegacyActionRouter,
  legacyErrorBody,
  parseLegacyActionPath,
  toLegacyDecodeError,
  toLegacyOperationEnvelope,
  DEFAULT_LEGACY_ACTION_BUSINESS_ID,
  LEGACY_OPERATION_LOCATION_HEADER,
  type LegacyActionDispatchInput,
  type LegacyActionDispatchPort,
  type LegacyActionDispatchResult,
  type LegacyActionRouteRequest,
  type LegacyActionRouter,
} from '../src/compat/legacy-action-router';
import { LegacyWireDecodeError } from '../src/compat/legacy-wire-decoders';

/** Minimal FormData stand-in: the decoder only needs get/getAll/entries. */
function fieldBag(entries: Array<readonly [string, unknown]>): object {
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
    entries(): IterableIterator<readonly [string, unknown]> {
      return entries[Symbol.iterator]() as IterableIterator<readonly [string, unknown]>;
    },
  };
}

function filePart(name: string, size = 3): Record<string, unknown> {
  return { name, size };
}

/**
 * The envelope is a Record<string, unknown> by design, so the tests narrow the
 * two nested objects once instead of casting at every assertion.
 */
function asRecord(value: unknown): Record<string, unknown> {
  expect(typeof value).toBe('object');
  expect(value).not.toBeNull();
  return value as Record<string, unknown>;
}

function metadataOf(body: Record<string, unknown>): Record<string, unknown> {
  return asRecord(body.metadata);
}

function resultOf(body: Record<string, unknown>): Record<string, unknown> {
  return asRecord(body.result);
}

/** Records every dispatch so a test can assert on exactly what was passed. */
class RecordingDispatch implements LegacyActionDispatchPort {
  readonly calls: LegacyActionDispatchInput[] = [];
  failure: Error | null = null;

  constructor(private readonly result: Partial<LegacyActionDispatchResult> = {}) {}

  async submit(input: LegacyActionDispatchInput): Promise<LegacyActionDispatchResult> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return {
      operationId: '11111111-1111-4111-8111-111111111111',
      state: 'ACCEPTED',
      createdAt: '2026-10-01T00:00:00.000Z',
      updatedAt: '2026-10-01T00:00:00.000Z',
      replayed: false,
      ...this.result,
    };
  }
}

function routerFor(
  dispatch: LegacyActionDispatchPort,
  overrides: {
    principal?: { tenantId: string; apiKeyId: string } | null;
    correlationId?: string;
  } = {},
): { router: LegacyActionRouter; dispatch: RecordingDispatch } {
  const principal =
    overrides.principal === undefined
      ? { tenantId: 'tenant-1', apiKeyId: 'key-1' }
      : overrides.principal;
  let issued = 0;
  const router = createLegacyActionRouter({
    dispatch,
    resolvePrincipal: () => principal,
    newCorrelationId: () => {
      issued += 1;
      return overrides.correlationId ?? `generated-${issued}`;
    },
  });
  return { router, dispatch: dispatch as RecordingDispatch };
}

function post(
  pathname: string,
  form: object,
  extra: Partial<LegacyActionRouteRequest> = {},
): LegacyActionRouteRequest {
  return { method: 'POST', pathname, form, ...extra };
}

describe('COMP-03 legacy action router', () => {
  describe('path ownership', () => {
    it('claims exactly the six legacy core action paths', () => {
      const paths = [
        '/api/v1/docs/ingest',
        '/api/v1/docs/extract',
        '/api/v1/docs/analyze',
        '/api/v1/docs/transform',
        '/api/v1/docs/generate',
        '/api/v1/docs/compare',
      ];
      for (const pathname of paths) {
        expect(parseLegacyActionPath(pathname)).not.toBeNull();
      }
      const { router } = routerFor(new RecordingDispatch());
      for (const pathname of paths) {
        expect(router.handles(pathname)).toBe(true);
      }
    });

    it('does not claim workflows, unknown services, the canonical route or nested paths', () => {
      const foreign = [
        '/api/v1/docs/workflows',
        '/api/v1/docs/workflows/schema',
        '/api/v1/docs/unknown',
        '/api/v1/docs/ingest/extra',
        '/api/v1/docs/',
        '/api/v1/docs',
        '/api/v1/businesses/document-core/actions/ingest',
        '/api/v1/operations',
        '/api/v1/extract',
        '',
      ];
      for (const pathname of foreign) {
        expect(parseLegacyActionPath(pathname)).toBeNull();
      }
      const { router } = routerFor(new RecordingDispatch());
      for (const pathname of foreign) {
        expect(router.handles(pathname)).toBe(false);
      }
    });

    it('returns null from handle for a foreign path so the canonical route still serves it', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch());
      const response = await router.handle(
        post('/api/v1/docs/workflows', fieldBag([['process', 'lc-checker']])),
      );
      expect(response).toBeNull();
      expect(dispatch.calls).toHaveLength(0);
    });

    it('handleOwned rejects rather than silently nulling on a foreign path', async () => {
      const { router } = routerFor(new RecordingDispatch());
      await expect(
        router.handleOwned(post('/api/v1/docs/workflows', fieldBag([]))),
      ).rejects.toThrow(/does not own/);
    });
  });

  describe('method guard', () => {
    it('answers 405 for a non-POST method and never dispatches', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch());
      const response = await router.handle({
        method: 'GET',
        pathname: '/api/v1/docs/extract',
      });
      expect(response?.status).toBe(405);
      expect(response?.body.title).toBe('Method Not Allowed');
      expect(response?.body.type).toBe('https://dugate.vn/errors/method-not-allowed');
      expect(dispatch.calls).toHaveLength(0);
    });
  });

  describe('authentication', () => {
    it('answers legacy 401 when the principal resolver returns null', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch(), { principal: null });
      const response = await router.handle(
        post('/api/v1/docs/extract', fieldBag([['type', 'invoice']])),
      );
      expect(response?.status).toBe(401);
      expect(response?.body.title).toBe('Unauthorized');
      expect(dispatch.calls).toHaveLength(0);
    });

    it('authenticates BEFORE decoding, so an unauthenticated bad body is still 401', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch(), { principal: null });
      const response = await router.handle(post('/api/v1/docs/extract', fieldBag([])));
      expect(response?.status).toBe(401);
      expect(dispatch.calls).toHaveLength(0);
    });

    it('forwards the resolved principal, never a body-supplied identity', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch());
      await router.handle(
        post('/api/v1/docs/extract',
          fieldBag([
            ['type', 'invoice'],
            ['tenantId', 'attacker-tenant'],
            ['api_key_id', 'attacker-key-snake'],
            ['apiKeyId', 'attacker-key'],
            ['userId', 'attacker-user'],
            ['authorization', 'Bearer attacker-token'],
            ['output_format', 'md'],
          ]),
        ),
      );
      expect(dispatch.calls).toHaveLength(1);
      const call = dispatch.calls[0]!;
      expect(call.tenantId).toBe('tenant-1');
      expect(call.apiKeyId).toBe('key-1');
      // Positive control: output_format is a real legacy field from the SAME
      // form, and it does survive. Without this, the four assertions below
      // would also pass if the router dropped the whole body.
      expect(call.submission.output).toMatchObject({ format: 'md' });
      // Each sentinel is asserted separately so a failure names the field.
      const input = JSON.stringify(call.submission.input);
      expect(input).not.toContain('attacker-tenant');
      expect(input).not.toContain('attacker-key');
      // The snake_case spelling folds to apiKeyId before the allow-list is
      // applied, so it is dropped by the same rule.
      expect(input).not.toContain('attacker-key-snake');
      expect(input).not.toContain('attacker-user');
      expect(input).not.toContain('attacker-token');
    });

    it('never asks the resolver about a body, only about transport headers', async () => {
      const seen: unknown[] = [];
      const router = createLegacyActionRouter({
        dispatch: new RecordingDispatch(),
        resolvePrincipal: (headers) => {
          seen.push(headers);
          return { tenantId: 'tenant-1', apiKeyId: 'key-1' };
        },
        newCorrelationId: () => 'fixed-correlation',
      });
      const headers = { 'x-api-key': 'real-key' };
      await router.handle(
        post('/api/v1/docs/ingest', fieldBag([['mode', 'ocr']]), { headers }),
      );
      expect(seen).toEqual([headers]);
    });
  });

  describe('decoder rejections project onto the legacy error surface', () => {
    it('maps a missing discriminator to 400 Invalid Parameter', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch());
      const response = await router.handle(post('/api/v1/docs/extract', fieldBag([])));
      expect(response?.status).toBe(400);
      expect(response?.body).toMatchObject({
        type: 'https://dugate.vn/errors/invalid-parameter',
        title: 'Invalid Parameter',
        status: 400,
      });
      expect(String(response?.body.detail)).toContain('type');
      expect(dispatch.calls).toHaveLength(0);
    });

    it('maps an unknown variant to 400, matching the legacy runner', async () => {
      const { router } = routerFor(new RecordingDispatch());
      const response = await router.handle(
        post('/api/v1/docs/ingest', fieldBag([['mode', 'not-a-mode']])),
      );
      expect(response?.status).toBe(400);
      expect(response?.body.title).toBe('Invalid Parameter');
    });

    it('maps malformed file_urls to 400 and never reaches the dispatcher', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch());
      const response = await router.handle(
        post('/api/v1/docs/compare',
          fieldBag([['mode', 'diff'], ['file_urls', '{not json']]),
        ),
      );
      expect(response?.status).toBe(400);
      expect(String(response?.body.detail)).toContain('file_urls');
      expect(dispatch.calls).toHaveLength(0);
    });

    it('carries a correlation id on decode errors so an operator can join the log', async () => {
      const { router } = routerFor(new RecordingDispatch(), { correlationId: 'corr-decode' });
      const response = await router.handle(post('/api/v1/docs/extract', fieldBag([])));
      expect(response?.body.correlationId).toBe('corr-decode');
    });

    it('toLegacyDecodeError is a pure mapping over the decoder error codes', () => {
      const codes = [
        'MISSING_DISCRIMINATOR',
        'INVALID_DISCRIMINATOR',
        'CONFLICTING_DISCRIMINATOR',
        'INVALID_PARAMETERS',
        'CONFLICTING_PARAMETER',
        'INVALID_FILE_URLS',
        'INVALID_CALLBACK',
        'INVALID_SOURCE_URL',
        'INVALID_HEADER',
      ] as const;
      for (const code of codes) {
        const projected = toLegacyDecodeError(new LegacyWireDecodeError(code, 'boom', 'f'));
        expect(projected.status).toBe(400);
        expect(projected.title).toBe('Invalid Parameter');
        expect(projected.detail).toBe('boom');
      }
      const unsupported = toLegacyDecodeError(
        new LegacyWireDecodeError('UNSUPPORTED_ACTION', 'nope', 'action'),
      );
      expect(unsupported.status).toBe(404);
      expect(unsupported.title).toBe('Service Not Found');
    });

    it('legacyErrorBody slugifies the title exactly as the legacy apiError did', () => {
      expect(legacyErrorBody(404, 'Service Not Found', 'd')).toEqual({
        type: 'https://dugate.vn/errors/service-not-found',
        title: 'Service Not Found',
        status: 404,
        detail: 'd',
      });
      expect(legacyErrorBody(400, 'Forbidden Field', 'd').type).toBe(
        'https://dugate.vn/errors/forbidden-field',
      );
    });
  });

  describe('dispatch', () => {
    it('routes each of the six actions with its decoded variant and the default business', async () => {
      const cases: Array<[string, string, string]> = [
        ['ingest', 'mode', 'digitize'],
        ['extract', 'type', 'id-card'],
        ['analyze', 'task', 'summarize-eval'],
        ['transform', 'action', 'redact'],
        ['generate', 'task', 'minutes'],
        ['compare', 'mode', 'version'],
      ];
      for (const [action, field, variant] of cases) {
        const { router, dispatch } = routerFor(new RecordingDispatch());
        await router.handle(
          post('/api/v1/docs/' + action, fieldBag([[field, variant]])),
        );
        expect(dispatch.calls).toHaveLength(1);
        const call = dispatch.calls[0]!;
        expect(call.action).toBe(action);
        expect(call.variant).toBe(variant);
        expect(call.businessId).toBe(DEFAULT_LEGACY_ACTION_BUSINESS_ID);
      }
    });

    it('honours a configured business id', async () => {
      const dispatch = new RecordingDispatch();
      const router = createLegacyActionRouter({
        dispatch,
        businessId: 'other-business',
        resolvePrincipal: () => ({ tenantId: 't', apiKeyId: 'k' }),
        newCorrelationId: () => 'c',
      });
      await router.handle(post('/api/v1/docs/ingest', fieldBag([['mode', 'parse']])));
      expect(dispatch.calls[0]!.businessId).toBe('other-business');
    });

    it('forwards the idempotency key, the correlation header and snake_case input', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch());
      await router.handle(
        post('/api/v1/docs/analyze',
          fieldBag([
            ['task', 'compliance'],
            ['criteria', 'signed by both parties'],
            ['target_language', 'vi'],
          ]),
          { headers: { 'idempotency-key': 'idem-1', 'x-correlation-id': 'corr-1' } },
        ),
      );
      const call = dispatch.calls[0]!;
      expect(call.idempotencyKey).toBe('idem-1');
      expect(call.correlationId).toBe('corr-1');
      expect(call.submission.input).toMatchObject({
        variant: 'compliance',
        criteria: 'signed by both parties',
        targetLanguage: 'vi',
      });
    });

    it('mints a correlation id when the client sent none, and prefers the header', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch(), { correlationId: 'minted' });
      await router.handle(post('/api/v1/docs/ingest', fieldBag([['mode', 'parse']])));
      expect(dispatch.calls[0]!.correlationId).toBe('minted');

      const second = routerFor(new RecordingDispatch(), { correlationId: 'minted' });
      await second.router.handle(
        post('/api/v1/docs/ingest', fieldBag([['mode', 'parse']]),
          { headers: { 'x-correlation-id': 'from-header' } }),
      );
      expect(second.dispatch.calls[0]!.correlationId).toBe('from-header');
    });

    it('passes multipart files and file_urls through with their roles', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch());
      await router.handle(
        post('/api/v1/docs/compare',
          fieldBag([
            ['mode', 'diff'],
            ['source_file', filePart('a.pdf')],
            ['target_file', filePart('b.pdf')],
            ['file_urls', JSON.stringify([{ url: 'https://example.com/c.pdf' }])],
          ]),
        ),
      );
      const call = dispatch.calls[0]!;
      expect(call.files.map((f) => f.field)).toEqual(['source_file', 'target_file']);
      expect(call.fileUrls).toEqual([{ url: 'https://example.com/c.pdf' }]);
    });

    it('reads executeSync from the query string, not from the body', async () => {
      const { router, dispatch } = routerFor(new RecordingDispatch());
      await router.handle(
        post('/api/v1/docs/ingest', fieldBag([['mode', 'parse'], ['sync', 'true']]),
          { query: { sync: 'false' } }),
      );
      expect(dispatch.calls[0]!.executeSync).toBe(false);

      const second = routerFor(new RecordingDispatch());
      await second.router.handle(
        post('/api/v1/docs/ingest', fieldBag([['mode', 'parse']]),
          { query: { sync: 'true' } }),
      );
      expect(second.dispatch.calls[0]!.executeSync).toBe(true);
    });
  });

  describe('status and Operation-Location', () => {
    it('answers 202 with Operation-Location for an ordinary async submit', async () => {
      const { router } = routerFor(new RecordingDispatch());
      const response = await router.handle(
        post('/api/v1/docs/extract', fieldBag([['type', 'invoice']])),
      );
      expect(response?.status).toBe(202);
      expect(response?.headers[LEGACY_OPERATION_LOCATION_HEADER]).toBe(
        '/api/v1/operations/11111111-1111-4111-8111-111111111111',
      );
    });

    it('answers 200 without the header when the client asked for sync', async () => {
      const { router } = routerFor(new RecordingDispatch());
      const response = await router.handle(
        post('/api/v1/docs/extract', fieldBag([['type', 'invoice']]),
          { query: { sync: 'true' } }),
      );
      expect(response?.status).toBe(200);
      expect(response?.headers[LEGACY_OPERATION_LOCATION_HEADER]).toBeUndefined();
    });

    it('answers 200 without the header on an idempotent replay even when async', async () => {
      const { router } = routerFor(new RecordingDispatch({ replayed: true }));
      const response = await router.handle(
        post('/api/v1/docs/extract', fieldBag([['type', 'invoice']])),
      );
      expect(response?.status).toBe(200);
      expect(response?.headers[LEGACY_OPERATION_LOCATION_HEADER]).toBeUndefined();
    });
  });

  describe('legacy envelope projection', () => {
    it('emits name/done/metadata, never the packet-shaped operation_id/status', async () => {
      const { router } = routerFor(new RecordingDispatch());
      const response = await router.handle(
        post('/api/v1/docs/extract', fieldBag([['type', 'invoice']])),
      );
      const body = response!.body;
      expect(Object.keys(body).sort()).toEqual(['done', 'metadata', 'name']);
      expect(body.name).toBe('operations/11111111-1111-4111-8111-111111111111');
      expect(body.done).toBe(false);
      // MISMATCH record: the dispatch packet asked for { operation_id, status }.
      expect(body).not.toHaveProperty('operation_id');
      expect(body).not.toHaveProperty('status');
    });

    it('defaults every optional metadata field rather than dropping the key', () => {
      const body = toLegacyOperationEnvelope({
        operationId: 'op-1',
        state: 'QUEUED',
        createdAt: 'c0',
        updatedAt: 'u0',
        replayed: false,
      });
      expect(metadataOf(body)).toEqual({
        state: 'QUEUED',
        pipeline: [],
        current_step: 0,
        progress_percent: 0,
        progress_message: null,
        create_time: 'c0',
        update_time: 'u0',
        pipeline_steps: [],
      });
    });

    it('adds the full legacy result block only for a SUCCEEDED operation', () => {
      const body = toLegacyOperationEnvelope({
        operationId: 'op-2',
        state: 'SUCCEEDED',
        createdAt: 'c0',
        updatedAt: 'u0',
        replayed: true,
        outputFormat: 'md',
        outputContent: '# hi',
        extractedData: { total: 10 },
        pipelineSteps: [{ step: 'ocr' }],
        usage: {
          inputTokens: 5,
          outputTokens: 7,
          pagesProcessed: 2,
          modelUsed: 'gpt',
          costUsd: 0.25,
          breakdown: [{ model: 'gpt' }],
        },
      });
      expect(body.done).toBe(true);
      expect(resultOf(body)).toEqual({
        output_format: 'md',
        content: '# hi',
        extracted_data: { total: 10 },
        pipeline_steps: [{ step: 'ocr' }],
        usage: {
          input_tokens: 5,
          output_tokens: 7,
          pages_processed: 2,
          model_used: 'gpt',
          cost_usd: 0.25,
          breakdown: [{ model: 'gpt' }],
        },
        download_url: '/api/v1/operations/op-2/download',
      });
      expect(body).not.toHaveProperty('error');
    });

    it('adds the legacy error block and the SHORT usage shape on FAILED', () => {
      const body = toLegacyOperationEnvelope({
        operationId: 'op-3',
        state: 'FAILED',
        createdAt: 'c0',
        updatedAt: 'u0',
        replayed: false,
        usage: {
          inputTokens: 5,
          outputTokens: 7,
          pagesProcessed: 2,
          modelUsed: 'gpt',
          costUsd: 0.25,
        },
        failure: { code: 'STEP_FAILED', message: 'boom', failedStep: 2 },
      });
      expect(body.error).toEqual({
        code: 'STEP_FAILED',
        message: 'boom',
        failed_step: 2,
      });
      const failureResult = resultOf(body);
      expect(failureResult).toEqual({
        pipeline_steps: [],
        usage: { input_tokens: 5, output_tokens: 7, cost_usd: 0.25, breakdown: [] },
      });
      // The legacy failure block omits these two keys entirely.
      const usage = asRecord(failureResult.usage);
      expect(usage).not.toHaveProperty('pages_processed');
      expect(usage).not.toHaveProperty('model_used');
    });

    it('marks CANCELLED and TIMED_OUT done with neither result nor error', () => {
      for (const state of ['CANCELLED', 'TIMED_OUT'] as const) {
        const body = toLegacyOperationEnvelope({
          operationId: 'op-4',
          state,
          createdAt: 'c0',
          updatedAt: 'u0',
          replayed: false,
        });
        expect(body.done).toBe(true);
        expect(body).not.toHaveProperty('result');
        expect(body).not.toHaveProperty('error');
      }
    });

    it('keeps non-terminal states not-done even when a progress value exists', () => {
      for (const state of [
        'PENDING_INGESTION',
        'ACCEPTED',
        'QUEUED',
        'RUNNING',
        'WAITING_INPUT',
        'RETRY_PENDING',
        'CANCEL_REQUESTED',
      ] as const) {
        const body = toLegacyOperationEnvelope({
          operationId: 'op-5',
          state,
          createdAt: 'c0',
          updatedAt: 'u0',
          replayed: false,
          progressPercent: 42,
        });
        expect(body.done).toBe(false);
        expect(metadataOf(body).progress_percent).toBe(42);
      }
    });

    it('copies pipeline steps by value so a caller mutation cannot leak into the wire', () => {
      const steps = ['ext-doc-layout'];
      const body = toLegacyOperationEnvelope({
        operationId: 'op-6',
        state: 'QUEUED',
        createdAt: 'c0',
        updatedAt: 'u0',
        replayed: false,
        pipeline: steps,
      });
      steps.push('mutated');
      expect(metadataOf(body).pipeline).toEqual(['ext-doc-layout']);
    });
  });

  describe('failure containment', () => {
    it('turns a dispatcher throw into a 500 that leaks no internal message', async () => {
      const dispatch = new RecordingDispatch();
      const secret = 'postgres://user:hunter2@db.internal:5432/du';
      dispatch.failure = new Error(secret);
      const { router } = routerFor(dispatch, { correlationId: 'corr-500' });
      const response = await router.handle(
        post('/api/v1/docs/ingest', fieldBag([['mode', 'parse']])),
      );
      expect(response?.status).toBe(500);
      expect(response?.body.title).toBe('Internal Error');
      expect(response?.body.correlationId).toBe('corr-500');
      const serialized = JSON.stringify(response?.body);
      expect(serialized).not.toContain('hunter2');
      expect(serialized).not.toContain('db.internal');
      expect(serialized).not.toContain('postgres://');
    });

    it('turns a resolver throw into the same redacted 500', async () => {
      const router = createLegacyActionRouter({
        dispatch: new RecordingDispatch(),
        resolvePrincipal: () => {
          throw new Error('vault unreachable at 10.0.0.5:8200');
        },
        newCorrelationId: () => 'corr-resolver',
      });
      const response = await router.handle(
        post('/api/v1/docs/ingest', fieldBag([['mode', 'parse']])),
      );
      expect(response?.status).toBe(500);
      expect(JSON.stringify(response?.body)).not.toContain('10.0.0.5');
    });

    it('surfaces an async resolver result correctly', async () => {
      const dispatch = new RecordingDispatch();
      const router = createLegacyActionRouter({
        dispatch,
        resolvePrincipal: async () => {
          await Promise.resolve();
          return { tenantId: 'async-tenant', apiKeyId: 'async-key' };
        },
        newCorrelationId: () => 'c',
      });
      await router.handle(post('/api/v1/docs/ingest', fieldBag([['mode', 'parse']])));
      expect(dispatch.calls[0]!.tenantId).toBe('async-tenant');
      expect(dispatch.calls[0]!.apiKeyId).toBe('async-key');
    });
  });
});
