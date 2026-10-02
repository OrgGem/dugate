import { createHttpTransport } from '../src';
import type { ClientInvocationRequest } from '../src';

/**
 * CONN-2C-FIX — client half. The wire states retryability; the status alone cannot,
 * because a refusal and a real outage are both 502.
 */
describe('The client honours the wire retry signal, and falls back safely', () => {
  const BASE = 'http://connector.test/internal/v1';
  const TOKEN = 'svc-token-1';
  const OP_ID = '11111111-1111-4111-8111-111111111111';
  const TASK_ID = '22222222-2222-4222-8222-222222222222';

  const request: ClientInvocationRequest = {
    contractVersion: '1',
    invocationId: 'inv-retry-signal',
    grant: 'signed-grant-token',
    operationId: OP_ID,
    taskId: TASK_ID,
    stepKey: 'summarize',
    bindingSlot: 'reasoning',
    input: { text: 'hello' },
    deadlineAt: '2099-01-01T00:00:00.000Z',
  };

  const wire = (status: number, body: unknown) => new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;

  const transportReturning = (status: number, body: unknown) =>
    createHttpTransport({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl: (async () => wire(status, body)) as unknown as typeof fetch,
    });

  describe('when the wire carries the signal', () => {
    test('a refusal is reported non-retryable even though the status is 502', async () => {
      const transport = transportReturning(502, {
        error: { code: 'PROVIDER_REQUEST_REJECTED', message: 'refused', retryable: false },
      });
      await expect(transport.invoke(request)).rejects.toMatchObject({
        code: 'PROVIDER_REQUEST_REJECTED',
        status: 502,
        retryable: false,
      });
    });

    test('the wire WINS over the status in the non-obvious direction too', async () => {
      // 400 would have meant false under the old heuristic; proving true here shows the
      // client reads the field rather than merely special-casing 502.
      const transport = transportReturning(400, {
        error: { code: 'PROVIDER_RATE_LIMITED', message: 'slow down', retryable: true },
      });
      await expect(transport.invoke(request)).rejects.toMatchObject({
        code: 'PROVIDER_RATE_LIMITED',
        status: 400,
        retryable: true,
      });
    });

    test('retryAfterMs still passes through', async () => {
      const transport = transportReturning(429, {
        error: { code: 'PROVIDER_RATE_LIMITED', message: 'slow down', retryable: true, retryAfterMs: 1000 },
      });
      await expect(transport.invoke(request)).rejects.toMatchObject({
        retryable: true,
        retryAfterMs: 1000,
      });
    });
  });

  describe('when the wire omits the signal (a peer running the older service)', () => {
    test('a refusal code still resolves to non-retryable', async () => {
      const transport = transportReturning(502, {
        error: { code: 'PROVIDER_REQUEST_REJECTED', message: 'refused' },
      });
      await expect(transport.invoke(request)).rejects.toMatchObject({ retryable: false });
    });

    test('a genuine outage still resolves to retryable', async () => {
      const transport = transportReturning(502, {
        error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' },
      });
      await expect(transport.invoke(request)).rejects.toMatchObject({ retryable: true });
    });

    test('a 429 without the field stays retryable', async () => {
      const transport = transportReturning(429, { error: { code: 'PROVIDER_RATE_LIMITED', message: 'x' } });
      await expect(transport.invoke(request)).rejects.toMatchObject({ retryable: true });
    });

    test('an unrelated 4xx keeps the old status heuristic', async () => {
      const transport = transportReturning(400, { error: { code: 'INVALID_INPUT', message: 'x' } });
      await expect(transport.invoke(request)).rejects.toMatchObject({ retryable: false });
    });
  });

  describe('a terminal FAILED response still satisfies the frozen contract', () => {
    test('the client accepts a failed invocation carrying retryable', async () => {
      const transport = transportReturning(200, {
        invocationId: 'inv-retry-signal',
        state: 'FAILED',
        error: { code: 'PROVIDER_REQUEST_REJECTED', message: 'refused', retryable: false },
      });
      const result = await transport.get('inv-retry-signal', undefined, 'grant');
      expect(result.state).toBe('failed');
      expect(result.error?.retryable).toBe(false);
    });
  });
});
