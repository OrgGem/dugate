// tests/workflow-builder/run-schema-client.test.ts
// Fix 5 browser-to-route contract tests for the Workflow Builder Run modal.
// Covers the pure typed helpers extracted from app/workflow-builder/page.tsx
// into app/workflow-builder/run-schema-client.ts.
//
// Why helpers, not jsdom page render: the page is a "use client" component
// wired to next/navigation, next-auth, and sonner. Rendering it under jest's
// node testEnvironment requires Next.js router/session mocks that are out of
// this lane's scope. Per the W30-CC packet: "If existing Jest setup cannot
// render the page safely, extract a pure typed request/result helper inside
// the owned UI area and test that boundary; state clearly if browser
// interaction remains unproven."
//
// The route contract itself is independently covered by
// tests/workflow-builder/schema-route.test.ts (W26-CC, 6/6 PASS).

import {
  RUN_SCHEMA_ENDPOINT,
  findMissingRequiredField,
  buildRunSchemaFormData,
  extractOperationId,
  extractErrorDetail,
  extractErrorTitle,
  extractErrorStatus,
  submitRunSchema,
  type RunSchemaFetcher,
} from '../../app/workflow-builder/run-schema-client';

describe('Fix 5 — Workflow Builder browser-to-route contract', () => {
  it('exposes the documented slug route as the run endpoint', () => {
    expect(RUN_SCHEMA_ENDPOINT).toBe('/api/v1/docs/workflows/schema');
  });

  describe('findMissingRequiredField (required-field validation)', () => {
    it('returns null when no properties are declared', () => {
      expect(findMissingRequiredField({}, undefined)).toBeNull();
      expect(findMissingRequiredField({}, {})).toBeNull();
    });

    it('returns null when all required fields are filled', () => {
      const result = findMissingRequiredField(
        { resolution_data: '01', limit: 5 },
        { resolution_data: { required: true }, limit: { required: true } },
      );
      expect(result).toBeNull();
    });

    it('flags missing string value', () => {
      const result = findMissingRequiredField(
        { limit: '' },
        { resolution_data: { required: true, label: 'Resolution Data' } },
      );
      expect(result).toEqual({ field: 'resolution_data', label: 'Resolution Data' });
    });

    it('flags null value', () => {
      const result = findMissingRequiredField(
        { resolution_data: null },
        { resolution_data: { required: true } },
      );
      expect(result).not.toBeNull();
      expect(result?.field).toBe('resolution_data');
    });

    it('flags undefined value', () => {
      const result = findMissingRequiredField(
        {},
        { resolution_data: { required: true } },
      );
      expect(result).not.toBeNull();
      expect(result?.field).toBe('resolution_data');
    });

    it('falls back to field key when no label is provided', () => {
      const result = findMissingRequiredField(
        {},
        { resolution_data: { required: true } },
      );
      expect(result?.label).toBe('resolution_data');
    });

    it('skips non-required fields', () => {
      const result = findMissingRequiredField(
        { optional_field: '' },
        { optional_field: { required: false } },
      );
      expect(result).toBeNull();
    });

    it('returns the FIRST missing required field (stable order)', () => {
      const result = findMissingRequiredField(
        {},
        {
          first: { required: true },
          second: { required: true, label: 'Second' },
        },
      );
      expect(result?.field).toBe('first');
    });
  });

  describe('buildRunSchemaFormData (multipart body)', () => {
    it('always emits schemaSlug', () => {
      const form = buildRunSchemaFormData({ schemaSlug: 'disbursement', inputs: {} });
      expect(form.get('schemaSlug')).toBe('disbursement');
    });

    it('omits the input field when inputs map is empty', () => {
      const form = buildRunSchemaFormData({ schemaSlug: 'foo', inputs: {} });
      expect(form.get('input')).toBeNull();
    });

    it('serializes inputs as a JSON string when non-empty', () => {
      const form = buildRunSchemaFormData({
        schemaSlug: 'foo',
        inputs: { limit: 5000, flag: true },
      });
      const raw = form.get('input');
      expect(typeof raw).toBe('string');
      const parsed = JSON.parse(raw as string);
      expect(parsed).toEqual({ limit: 5000, flag: true });
    });

    it('attaches files under files[] (multi-file)', () => {
      const f1 = new File(['a'], 'a.pdf', { type: 'application/pdf' });
      const f2 = new File(['b'], 'b.pdf', { type: 'application/pdf' });
      const form = buildRunSchemaFormData({
        schemaSlug: 'foo',
        inputs: {},
        files: [f1, f2],
      });
      const files = form.getAll('files[]');
      expect(files).toHaveLength(2);
      expect(files[0]).toBe(f1);
      expect(files[1]).toBe(f2);
    });

    it('handles absent files array', () => {
      const form = buildRunSchemaFormData({ schemaSlug: 'foo', inputs: { x: 1 } });
      expect(form.getAll('files[]')).toHaveLength(0);
    });
  });

  describe('extractOperationId (202 success navigation)', () => {
    it('parses operations/<id> name into id', () => {
      expect(extractOperationId({ name: 'operations/op-uuid-123' })).toBe('op-uuid-123');
    });

    it('returns null when body has no recognizable name', () => {
      expect(extractOperationId({ name: 'something-else/op-uuid-123' })).toBeNull();
      expect(extractOperationId({})).toBeNull();
      expect(extractOperationId(null)).toBeNull();
      expect(extractOperationId('not-an-object')).toBeNull();
    });
  });

  describe('extractErrorDetail / extractErrorTitle / extractErrorStatus (ProblemDetails display)', () => {
    it('extracts detail from a 400 ProblemDetails body', () => {
      expect(extractErrorDetail({
        type: 'https://dugate.vn/errors/invalid-parameter',
        title: 'Invalid Parameter',
        status: 400,
        detail: 'Field "schemaSlug" is required.',
      })).toBe('Field "schemaSlug" is required.');
    });

    it('extracts detail from a 404 ProblemDetails body', () => {
      expect(extractErrorDetail({
        title: 'Schema Not Found',
        status: 404,
        detail: "Workflow schema 'nope' is not imported.",
      })).toBe("Workflow schema 'nope' is not imported.");
    });

    it('falls back to a generic message when detail is absent', () => {
      expect(extractErrorDetail({})).toBe('Chạy thất bại');
      expect(extractErrorDetail(null, 'Tùy chỉnh')).toBe('Tùy chỉnh');
    });

    it('extracts title and status when present', () => {
      expect(extractErrorTitle({ title: 'Schema Not Found' })).toBe('Schema Not Found');
      expect(extractErrorTitle({})).toBeUndefined();
      expect(extractErrorStatus({ status: 404 })).toBe(404);
      expect(extractErrorStatus({})).toBeUndefined();
    });

    it('honors the legacy `error` field as a secondary fallback', () => {
      expect(extractErrorDetail({ error: 'Import failed' })).toBe('Import failed');
    });
  });

  describe('submitRunSchema (request outcome boundary — W31-CC)', () => {
    function mockResponse(status: number, body: unknown): Response {
      return {
        ok: status >= 200 && status < 300,
        status,
        json: async () => body,
      } as unknown as Response;
    }

    function fetcherFor(responses: Response[]): RunSchemaFetcher {
      let i = 0;
      return (async () => {
        const r = responses[i++];
        if (!r) throw new Error('mock fetch called too many times');
        return r;
      }) as unknown as RunSchemaFetcher;
    }

    it('returns RunSchemaAccepted for 202 with a parseable operation id', async () => {
      const fetcher = fetcherFor([mockResponse(202, {
        name: 'operations/op-uuid-1',
        done: false,
        metadata: { state: 'RUNNING', workflow: 'disbursement' },
      })]);
      const outcome = await submitRunSchema(
        { schemaSlug: 'disbursement', inputs: { x: 1 } },
        fetcher,
      );
      expect(outcome.ok).toBe(true);
      if (outcome.ok) {
        expect(outcome.status).toBe(202);
        expect(outcome.operationId).toBe('op-uuid-1');
        expect(outcome.operationUrl).toBe('/operations/op-uuid-1');
      }
    });

    it('returns RunSchemaUnrecognized when 202 lacks a parseable operation id (recoverable)', async () => {
      const fetcher = fetcherFor([mockResponse(202, { name: 'unexpected-shape', done: false })]);
      const outcome = await submitRunSchema(
        { schemaSlug: 'disbursement', inputs: {} },
        fetcher,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe(202);
        expect(outcome.detail).toMatch(/operation id/i);
      }
    });

    it('returns RunSchemaRejected for 400 ProblemDetails', async () => {
      const fetcher = fetcherFor([mockResponse(400, {
        type: 'https://dugate.vn/errors/missing-parameter',
        title: 'Missing Parameter',
        status: 400,
        detail: "Field 'schemaSlug' is required.",
      })]);
      const outcome = await submitRunSchema(
        { schemaSlug: '', inputs: {} },
        fetcher,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe(400);
        expect(outcome.detail).toBe("Field 'schemaSlug' is required.");
        if ('title' in outcome) expect(outcome.title).toBe('Missing Parameter');
      }
    });

    it('returns RunSchemaRejected for 404 ProblemDetails', async () => {
      const fetcher = fetcherFor([mockResponse(404, {
        title: 'Schema Not Found',
        status: 404,
        detail: "Workflow schema 'nope' is not imported.",
      })]);
      const outcome = await submitRunSchema(
        { schemaSlug: 'nope', inputs: {} },
        fetcher,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe(404);
        expect(outcome.detail).toBe("Workflow schema 'nope' is not imported.");
        if ('title' in outcome) expect(outcome.title).toBe('Schema Not Found');
      }
    });

    it('returns RunSchemaRejected with HTTP <status> fallback when the body is malformed (non-JSON)', async () => {
      const fetcher = fetcherFor([{
        ok: false,
        status: 500,
        json: async () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
      } as unknown as Response]);
      const outcome = await submitRunSchema(
        { schemaSlug: 'disbursement', inputs: {} },
        fetcher,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe(500);
        expect(outcome.detail).toBe('HTTP 500');
      }
    });

    it('returns RunSchemaNetworkError when the fetcher rejects (rejected-fetch)', async () => {
      const fetcher: RunSchemaFetcher = (async () => {
        throw new TypeError('Failed to fetch');
      }) as unknown as RunSchemaFetcher;
      const outcome = await submitRunSchema(
        { schemaSlug: 'disbursement', inputs: {} },
        fetcher,
      );
      expect(outcome.ok).toBe(false);
      if (!outcome.ok) {
        expect(outcome.status).toBe(0);
        expect(outcome.detail).toBe('Lỗi kết nối');
      }
    });

    it('supports a recoverable retry path: rejected fetch then accepted 202', async () => {
      // First call rejects, second call returns the accepted envelope.
      let attempts = 0;
      const fetcher: RunSchemaFetcher = (async () => {
        attempts++;
        if (attempts === 1) throw new TypeError('Network down');
        return mockResponse(202, { name: 'operations/op-uuid-2' });
      }) as unknown as RunSchemaFetcher;

      const first = await submitRunSchema({ schemaSlug: 'd', inputs: {} }, fetcher);
      expect(first.ok).toBe(false);
      if (!first.ok) expect(first.detail).toBe('Lỗi kết nối');

      const second = await submitRunSchema({ schemaSlug: 'd', inputs: {} }, fetcher);
      expect(second.ok).toBe(true);
      if (second.ok) expect(second.operationId).toBe('op-uuid-2');
    });

    it('preserves the multipart contract: the fetcher receives the slug route with POST + form body', async () => {
      let capturedUrl: string | null = null;
      let capturedInit: any = null;
      const fetcher: RunSchemaFetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
        capturedUrl = typeof url === 'string' ? url : url.toString();
        capturedInit = init ?? null;
        return mockResponse(202, { name: 'operations/op-uuid-3' });
      }) as unknown as RunSchemaFetcher;

      await submitRunSchema(
        { schemaSlug: 'disbursement', inputs: { x: 1 }, files: [new File(['a'], 'a.pdf', { type: 'application/pdf' })] },
        fetcher,
      );
      expect(capturedUrl).toBe(RUN_SCHEMA_ENDPOINT);
      expect(capturedInit?.method).toBe('POST');
      expect(capturedInit?.body).toBeInstanceOf(FormData);
      const form = capturedInit?.body as FormData;
      expect(form.get('schemaSlug')).toBe('disbursement');
      expect(form.getAll('files[]')).toHaveLength(1);
    });
  });
});
