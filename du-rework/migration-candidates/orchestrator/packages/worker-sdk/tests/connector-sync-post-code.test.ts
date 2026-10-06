import { createConnectorInvoker } from '../src';
import { classifyFailure } from '../src/worker';

/**
 * WSD-SYNCPOST-CODE — the synchronous POST path reported every non-2xx as a code derived
 * from the HTTP status, so a provider that REFUSED the request (PROVIDER_REQUEST_REJECTED,
 * 502) was indistinguishable from a genuine outage (PROVIDER_UNAVAILABLE, 502). Retry was
 * already correct because classifyFailure keys off the status; only the diagnosis was lost.
 */
describe('The synchronous POST path keeps the connector code', () => {
  const grant = {
    grant: 'signed-grant',
    invocationId: 'invocation-1',
    connectorId: 'connector-1',
    connectorRevision: 1,
    expiresAt: '2026-09-28T12:00:00.000Z',
    allowedOptions: {},
  };

  const payload = {
    contractVersion: '1' as const,
    invocationId: 'invocation-1',
    grant: 'signed-grant',
    operationId: '00000000-0000-4000-8000-000000000001',
    taskId: '00000000-0000-4000-8000-000000000002',
    stepKey: 'summarize',
    bindingSlot: 'reasoning',
    input: { prompt: 'Summarize this fixture.' },
    deadlineAt: '2026-09-28T12:00:00.000Z',
  };

  const respond = (status: number, body: string) =>
    jest.fn(async () => new Response(body, {
      status,
      headers: { 'content-type': 'application/json' },
    })) as unknown as typeof fetch;

  const invokeWith = (fetchImpl: typeof fetch) =>
    createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });

  const rejected = async (fetchImpl: typeof fetch): Promise<{ status: number; code: string; message: string }> => {
    try {
      await invokeWith(fetchImpl)(grant, payload);
      throw new Error('expected the invocation to reject');
    } catch (error) {
      return error as { status: number; code: string; message: string };
    }
  };

  describe('the refusal and the outage stop looking identical', () => {
    test('a 502 refusal keeps PROVIDER_REQUEST_REJECTED', async () => {
      const error = await rejected(respond(502, JSON.stringify({
        error: {
          code: 'PROVIDER_REQUEST_REJECTED',
          message: "Provider returned HTTP 400 for task 'disbursement_classfy'.",
        },
      })));
      expect(error.status).toBe(502);
      expect(error.code).toBe('PROVIDER_REQUEST_REJECTED');
      expect(error.message).toContain('disbursement_classfy');
    });

    test('a 502 outage keeps PROVIDER_UNAVAILABLE', async () => {
      const error = await rejected(respond(502, JSON.stringify({
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'Provider returned HTTP 503.' },
      })));
      expect(error.status).toBe(502);
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
    });

    test('a 400 refusal keeps PROVIDER_REQUEST_REJECTED instead of becoming INVALID_INPUT', async () => {
      const error = await rejected(respond(400, JSON.stringify({
        error: { code: 'PROVIDER_REQUEST_REJECTED', message: 'refused' },
      })));
      expect(error.code).toBe('PROVIDER_REQUEST_REJECTED');
    });

    test('the two 502s now classify differently in the reported code', async () => {
      const refusal = await rejected(respond(502, JSON.stringify({
        error: { code: 'PROVIDER_REQUEST_REJECTED', message: 'refused' },
      })));
      const outage = await rejected(respond(502, JSON.stringify({
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' },
      })));
      expect(classifyFailure(refusal).errorCode).not.toBe(classifyFailure(outage).errorCode);
    });
  });

  describe('retry semantics are unchanged', () => {
    test('a refusal stays non-retryable', async () => {
      const error = await rejected(respond(502, JSON.stringify({
        error: { code: 'PROVIDER_REQUEST_REJECTED', message: 'refused' },
      })));
      expect(classifyFailure(error)).toMatchObject({ retryable: false });
    });

    test('a genuine 503 outage stays retryable', async () => {
      const error = await rejected(respond(503, JSON.stringify({
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' },
      })));
      expect(classifyFailure(error)).toMatchObject({ retryable: true });
    });

    test.each([
      'INPUT_HASH_MISMATCH',
      'CANCELLED',
      'CONNECTOR_DISABLED',
      'INVOCATION_UNKNOWN',
    ] as const)('a 503 carrying %s is NOT adopted, so retry does not flip', async (code) => {
      // classifyFailure treats these four as non-retryable regardless of status. Adopting
      // one at a 503 would turn a retryable outage into a non-retryable failure, which
      // would be a retry-semantics change disguised as a diagnostics fix.
      const error = await rejected(respond(503, JSON.stringify({
        error: { code, message: 'adopt me' },
      })));
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(classifyFailure(error)).toMatchObject({ retryable: true });
    });
  });

  describe('the pre-existing branches are untouched', () => {
    test('401 still yields GRANT_INVALID', async () => {
      const error = await rejected(respond(401, JSON.stringify({
        error: { code: 'GRANT_INVALID', message: 'bad token' },
      })));
      expect(error).toMatchObject({ status: 401, code: 'GRANT_INVALID' });
    });

    test('403 still yields BINDING_DENIED', async () => {
      const error = await rejected(respond(403, JSON.stringify({
        error: { code: 'BINDING_DENIED', message: 'not pinned' },
      })));
      expect(error).toMatchObject({ status: 403, code: 'BINDING_DENIED' });
    });

    test('409 still uses the conflict allowlist, not the new one', async () => {
      const error = await rejected(respond(409, JSON.stringify({
        error: { code: 'CONNECTOR_DISABLED', message: 'draining' },
      })));
      expect(error).toMatchObject({ status: 409, code: 'CONNECTOR_DISABLED' });
    });
  });

  describe('anything unrecognised falls back to the status', () => {
    test.each([
      ['not JSON', '{not json'],
      ['no error envelope', JSON.stringify({ code: 'PROVIDER_UNAVAILABLE' })],
      ['empty message', JSON.stringify({ error: { code: 'PROVIDER_UNAVAILABLE', message: '' } })],
      ['unknown code', JSON.stringify({ error: { code: 'MADE_UP', message: 'x' } })],
    ] as const)('%s falls back to the status-derived code', async (_case, body) => {
      const error = await rejected(respond(502, body));
      expect(error.code).toBe('PROVIDER_UNAVAILABLE');
      expect(error.message).toBe('connector error 502');
    });
  });

  describe('the reported message is bounded', () => {
    test('line breaks are flattened so remote text cannot forge log lines', async () => {
      const error = await rejected(respond(502, JSON.stringify({
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'line one\nline two' },
      })));
      expect(error.message).toBe('line one line two');
    });

    test('an over-long message is truncated', async () => {
      const error = await rejected(respond(502, JSON.stringify({
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'x'.repeat(5000) },
      })));
      expect(error.message).toHaveLength(1024);
    });
  });
});
