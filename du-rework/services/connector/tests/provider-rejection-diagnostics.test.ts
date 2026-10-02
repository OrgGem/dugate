import {
  ConnectorError,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  createConnectorServer,
  invokeAdapter,
  jsonHttpAdapter,
  multipartHttpAdapter,
  type ConnectorHttpStore,
  type LocalInvocationRequest,
  type ProviderResponse,
} from '../src';
// Bind outside the Windows ephemeral band: see tests/harness/listen-loopback.ts.
import { listenLoopback } from '../../../tests/harness/listen-loopback';

/**
 * Connector rejection diagnostics (options memo 2c, coordinator-approved 2026-10-02).
 *
 * Before this change every non-2xx that was not 429/5xx collapsed into
 * INVALID_PROVIDER_RESPONSE — the same code used for a 200 whose body does not
 * match the contract. Those are opposites: one means the provider refused the
 * request, the other means the provider answered with something unusable. The
 * shared code, plus a fixed 'Provider request failed.' message that carried no
 * status and no task name, sent an operator to investigate the provider when the
 * real fault was a task discriminator the provider never recognised.
 */
describe('Provider rejection is distinct from a malformed provider response', () => {
  const baseRequest: LocalInvocationRequest = {
    contractVersion: '1',
    invocationId: '2c-inv-400',
    tenantId: 'tenant-2c',
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt: 'Classify the file', task: 'disbursement_classfy' },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };

  const respond = (status: number, body: unknown): { send: () => Promise<ProviderResponse> } => ({
    send: async () => ({ status, headers: {}, body }),
  });

  describe('classifyFailure taxonomy', () => {
    test.each([400, 401, 403, 404, 409, 422])(
      'HTTP %i is a provider rejection, not an invalid provider response',
      (status) => {
        expect(jsonHttpAdapter.classifyFailure({ status, headers: {}, body: {} }))
          .toBe('PROVIDER_REQUEST_REJECTED');
      },
    );

    test('the pre-existing branches are unchanged', () => {
      expect(jsonHttpAdapter.classifyFailure({ status: 429, headers: {}, body: {} })).toBe('PROVIDER_RATE_LIMITED');
      expect(jsonHttpAdapter.classifyFailure({ status: 500, headers: {}, body: {} })).toBe('PROVIDER_UNAVAILABLE');
      expect(jsonHttpAdapter.classifyFailure({ status: 503, headers: {}, body: {} })).toBe('PROVIDER_UNAVAILABLE');
      expect(jsonHttpAdapter.classifyFailure(new Error('connection reset'))).toBe('PROVIDER_UNAVAILABLE');
    });

    test('a status that is neither 4xx nor 5xx keeps the conservative fallback', () => {
      expect(jsonHttpAdapter.classifyFailure({ status: 302, headers: {}, body: {} })).toBe('INVALID_PROVIDER_RESPONSE');
    });

    test('the multipart adapter inherits the same classification', () => {
      expect(multipartHttpAdapter.classifyFailure({ status: 400, headers: {}, body: {} }))
        .toBe('PROVIDER_REQUEST_REJECTED');
    });
  });

  describe('end-to-end through invokeAdapter', () => {
    test('a rejected request surfaces the rejection code, the status and the task', async () => {
      const ledger = new InMemoryInvocationLedger();
      await expect(invokeAdapter(baseRequest, {
        ledger,
        quota: new InMemoryQuotaStore(),
        adapter: jsonHttpAdapter,
        config: { baseUrl: 'https://provider.example', path: '/v1/invoke', timeoutMs: 5000 },
        quotaKey: 'provider:account',
        transport: respond(400, { error: 'unknown task' }),
      })).rejects.toMatchObject({
        code: 'PROVIDER_REQUEST_REJECTED',
        safeToRetry: false,
        message: "Provider returned HTTP 400 for task 'disbursement_classfy'.",
      });
      expect((await ledger.get(baseRequest.invocationId))?.state).toBe('FAILED');
    });

    test('the same provider returning a contract-violating 200 keeps INVALID_PROVIDER_RESPONSE', async () => {
      const ledger = new InMemoryInvocationLedger();
      // content must be a string; the default responseMapping reads body.content.
      await expect(invokeAdapter(baseRequest, {
        ledger,
        quota: new InMemoryQuotaStore(),
        adapter: jsonHttpAdapter,
        config: { baseUrl: 'https://provider.example', path: '/v1/invoke', timeoutMs: 5000 },
        quotaKey: 'provider:account',
        transport: respond(200, { content: { not: 'a string' } }),
      })).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
      expect((await ledger.get(baseRequest.invocationId))?.state).toBe('FAILED');
    });

    test('a 503 still names the status and stays retryable', async () => {
      await expect(invokeAdapter(baseRequest, {
        ledger: new InMemoryInvocationLedger(),
        quota: new InMemoryQuotaStore(),
        adapter: jsonHttpAdapter,
        config: { baseUrl: 'https://provider.example', path: '/v1/invoke', timeoutMs: 5000 },
        quotaKey: 'provider:account',
        transport: respond(503, null),
      })).rejects.toMatchObject({
        code: 'PROVIDER_UNAVAILABLE',
        safeToRetry: true,
        message: "Provider returned HTTP 503 for task 'disbursement_classfy'.",
      });
    });

    test('a 429 keeps its retry hint', async () => {
      await expect(invokeAdapter(baseRequest, {
        ledger: new InMemoryInvocationLedger(),
        quota: new InMemoryQuotaStore(),
        adapter: jsonHttpAdapter,
        config: { baseUrl: 'https://provider.example', path: '/v1/invoke', timeoutMs: 5000 },
        quotaKey: 'provider:account',
        transport: respond(429, null),
      })).rejects.toMatchObject({ code: 'PROVIDER_RATE_LIMITED', retryAfterMs: 1000 });
    });
  });

  describe('the diagnostic message does not become an echo channel', () => {
    const captureMessage = async (task: unknown): Promise<string> => {
      const request: LocalInvocationRequest = {
        ...baseRequest,
        invocationId: `2c-echo-${String(task).length}`,
        input: { prompt: 'p', task: task as string },
      };
      try {
        await invokeAdapter(request, {
          ledger: new InMemoryInvocationLedger(),
          quota: new InMemoryQuotaStore(),
          adapter: jsonHttpAdapter,
          config: { baseUrl: 'https://provider.example', path: '/v1/invoke', timeoutMs: 5000 },
          quotaKey: 'provider:account',
          transport: respond(422, null),
        });
        throw new Error('expected the provider rejection to throw');
      } catch (error) {
        return (error as ConnectorError).message;
      }
    };

    test('a task outside the literal shape is withheld, not reflected', async () => {
      const message = await captureMessage('sk-live-abc123 secret=leaked');
      expect(message).toBe('Provider returned HTTP 422.');
      expect(message).not.toContain('sk-live');
      expect(message).not.toContain('secret');
    });

    test('a task with a newline or quote cannot break out of the message', async () => {
      const message = await captureMessage("ok\nInjected: whatever");
      expect(message).toBe('Provider returned HTTP 422.');
      expect(message.split('\n').length).toBe(1);
    });

    test('an absent task still reports the status', async () => {
      const message = await captureMessage(undefined);
      expect(message).toBe('Provider returned HTTP 422.');
    });

    test('an over-long task is withheld', async () => {
      const message = await captureMessage('a'.repeat(65));
      expect(message).toBe('Provider returned HTTP 422.');
    });
  });

  describe('HTTP surface', () => {
    test('a rejection answers 502, not 400 and not 500', async () => {
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
      const server = createConnectorServer({
        management,
        runtime: {
          invoke: async () => { throw new ConnectorError('PROVIDER_REQUEST_REJECTED', 'Provider returned HTTP 400.'); },
          get: async () => { throw new ConnectorError('PROVIDER_REQUEST_REJECTED', 'Provider returned HTTP 400.'); },
          cancel: async () => { throw new Error('unused'); },
        },
        capabilities: () => ({ adapters: ['json-http', 'multipart-http'] }),
        ready: async () => true,
      });
      const port = await listenLoopback(server, 43520 + ((process.pid % 8) * 8), 6);
      try {
        const response = await fetch(`http://127.0.0.1:${port}/invocations/2c-http`);
        expect(response.status).toBe(502);
        // retryable is present because CONN-2C-FIX made the envelope state it;
        // a refusal is never safe to replay. See tests/retry-signal-passthrough.test.ts.
        expect(await response.json()).toEqual({
          error: { code: 'PROVIDER_REQUEST_REJECTED', message: 'Provider returned HTTP 400.', retryable: false },
        });
      } finally {
        await new Promise<void>((resolve, reject) => server.close((e) => e ? reject(e) : resolve()));
      }
    });
  });
});
