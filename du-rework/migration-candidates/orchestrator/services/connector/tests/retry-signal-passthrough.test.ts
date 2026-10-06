import {
  ConnectorError,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  createConnectorServer,
  invokeAdapter,
  isRetryableErrorCode,
  jsonHttpAdapter,
  type ConnectorHttpStore,
  type ConnectorErrorCode,
  type LocalInvocationRequest,
  type ProviderResponse,
} from '../src';
// Bind outside the Windows ephemeral band: see tests/harness/listen-loopback.ts.
import { listenLoopback } from '../../../tests/harness/listen-loopback';

/**
 * Retry-signal passthrough (CONN-2C-FIX).
 *
 * The provider-refusal split introduced PROVIDER_REQUEST_REJECTED, which the service
 * reports as HTTP 502. A client that inferred retryability from the status alone could
 * no longer tell that 502 from a genuine upstream outage, and would have retried a
 * refusal that can never succeed. The service therefore states the answer on the wire
 * and the policy lives in exactly one place.
 */
describe('The retry signal is carried, and written down once', () => {
  describe('isRetryableErrorCode', () => {
    test.each(['PROVIDER_RATE_LIMITED', 'PROVIDER_UNAVAILABLE'] as const)(
      '%s is transient and may be retried unchanged',
      (code) => {
        expect(isRetryableErrorCode(code)).toBe(true);
      },
    );

    test.each([
      'PROVIDER_REQUEST_REJECTED',
      'INVALID_PROVIDER_RESPONSE',
      'INVOCATION_UNKNOWN',
      'INPUT_HASH_MISMATCH',
      'CREDENTIAL_INVALID',
      'BINDING_DENIED',
      'GRANT_INVALID',
      'CONNECTOR_DISABLED',
      'PROVIDER_TIMEOUT',
      'INVALID_INPUT',
      'CAPABILITY_UNSUPPORTED',
      'CANCELLED',
    ] as ConnectorErrorCode[])('a refusal or a permanent fault is not retried', (code) => {
      expect(isRetryableErrorCode(code)).toBe(false);
    });
  });

  describe('invokeAdapter agrees with the policy', () => {
    const request: LocalInvocationRequest = {
      contractVersion: '1',
      invocationId: 'retry-signal-1',
      tenantId: 'tenant-retry',
      operationId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      stepKey: 'extract',
      bindingSlot: 'reasoning',
      input: { prompt: 'p', task: 'disbursement_classify' },
      deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    };

    const run = async (status: number) => invokeAdapter(request, {
      ledger: new InMemoryInvocationLedger(),
      quota: new InMemoryQuotaStore(),
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/v1/invoke', timeoutMs: 5000 },
      quotaKey: 'provider:account',
      transport: { send: async (): Promise<ProviderResponse> => ({ status, headers: {}, body: null }) },
    });

    test('a refused request throws non-retryable', async () => {
      await expect(run(400)).rejects.toMatchObject({
        code: 'PROVIDER_REQUEST_REJECTED',
        safeToRetry: false,
      });
    });

    test('a rate limit throws retryable', async () => {
      await expect(run(429)).rejects.toMatchObject({
        code: 'PROVIDER_RATE_LIMITED',
        safeToRetry: true,
      });
    });

    test('an upstream outage throws retryable', async () => {
      await expect(run(503)).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        safeToRetry: true,
      });
    });
  });

  describe('the HTTP error envelope states the answer', () => {
    const management: ConnectorHttpStore = {
      list: async () => [],
      get: async () => undefined,
      createRevision: async () => { throw new Error('unused'); },
      getRevision: async () => undefined,
      getCurrentRevision: async () => undefined,
      bootstrapRevision: async () => { throw new Error('unused'); },
      createPendingRevision: async () => { throw new Error('unused'); },
      activateRevision: async () => false,
      retireRevision: async () => {},
      rotateCredential: async () => {},
      disable: async () => {},
      test: async () => ({ ok: true }),
    };

    const envelopeFor = async (connectorError: ConnectorError): Promise<{ status: number; body: unknown }> => {
      const server = createConnectorServer({
        management,
        runtime: {
          invoke: async () => { throw connectorError; },
          get: async () => { throw connectorError; },
          cancel: async () => { throw new Error('unused'); },
        },
        capabilities: () => ({ adapters: ['json-http', 'multipart-http'] }),
        ready: async () => true,
      });
      const port = await listenLoopback(server, 43620 + ((process.pid % 8) * 8), 6);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/invocations/retry-signal`);
        return { status: response.status, body: await response.json() };
      } finally {
        await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
      }
    };

    test('a refusal is 502 and says retryable false', async () => {
      const { status, body } = await envelopeFor(
        new ConnectorError('PROVIDER_REQUEST_REJECTED', "Provider returned HTTP 400 for task 'disbursement_classify'."),
      );
      expect(status).toBe(502);
      expect(body).toEqual({
        error: {
          code: 'PROVIDER_REQUEST_REJECTED',
          message: "Provider returned HTTP 400 for task 'disbursement_classify'.",
          retryable: false,
        },
      });
    });

    test('an outage says retryable true', async () => {
      const { status, body } = await envelopeFor(
        new ConnectorError('PROVIDER_UNAVAILABLE', 'Provider returned HTTP 503.', { safeToRetry: true }),
      );
      expect(status).toBe(502);
      expect(body).toEqual({
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'Provider returned HTTP 503.', retryable: true },
      });
    });

    test('a rate limit says retryable true and keeps its retry hint', async () => {
      const { body } = await envelopeFor(
        new ConnectorError('PROVIDER_RATE_LIMITED', 'Provider returned HTTP 429.', {
          retryAfterMs: 1000,
          safeToRetry: true,
        }),
      );
      expect(body).toEqual({
        error: {
          code: 'PROVIDER_RATE_LIMITED',
          message: 'Provider returned HTTP 429.',
          retryable: true,
          retryAfterMs: 1000,
        },
      });
    });
  });
});
