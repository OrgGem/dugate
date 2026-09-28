import { randomUUID } from 'node:crypto';
import {
  ConnectorClient,
  ConnectorClientError,
  createHttpTransport,
  createSdkConnectorInvoker,
} from '../src';
import type { ClientInvocationRequest } from '../src';

/**
 * P4-07 — production HTTP transport + SDK invoker adapter.
 * Mocked-fetch boundary only: no connector service, no DB, no Redis.
 */

const BASE = 'http://connector.test/internal/v1';
const TOKEN = 'svc-token-1';
const OP_ID = randomUUID();
const TASK_ID = randomUUID();
const INVOCATION_ID = `inv-${randomUUID()}`;

function makeRequest(overrides: Partial<ClientInvocationRequest> = {}): ClientInvocationRequest {
  return {
    contractVersion: '1',
    invocationId: INVOCATION_ID,
    grant: 'signed-grant-token',
    operationId: OP_ID,
    taskId: TASK_ID,
    stepKey: 'summarize',
    bindingSlot: 'reasoning',
    input: { text: 'hello' },
    deadlineAt: '2099-01-01T00:00:00.000Z',
    ...overrides,
  };
}

interface Captured {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  signal: AbortSignal | undefined;
}

function wireResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

function succeededWire(overrides: Record<string, unknown> = {}): unknown {
  return {
    invocationId: INVOCATION_ID,
    state: 'SUCCEEDED',
    result: { content: 'ok', sessionRef: 'sess-9' },
    usage: { inputTokens: 1, outputTokens: 2, costMicrousd: 3, measurement: 'measured' },
    providerRequestId: 'prov-1',
    ...overrides,
  };
}

function mockFetch(
  handler: (captured: Captured) => Response | Promise<Response>
): { fetchImpl: typeof fetch; captured: Captured[] } {
  const captured: Captured[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    captured.push({
      url: String(input),
      method: init?.method ?? 'GET',
      headers: (init?.headers as Record<string, string>) ?? {},
      body: init?.body,
      signal: init?.signal ?? undefined,
    });
    return handler(captured[captured.length - 1]!);
  }) as unknown as typeof fetch;
  return { fetchImpl, captured };
}

describe('createHttpTransport — wire shape', () => {
  it('POSTs the contract-validated request to /invocations with bearer auth', async () => {
    const { fetchImpl, captured } = mockFetch(() => wireResponse(200, succeededWire()));
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });

    const out = await transport.invoke(makeRequest());

    expect(captured).toHaveLength(1);
    const call = captured[0]!;
    expect(call.method).toBe('POST');
    expect(call.url).toBe(`${BASE}/invocations`);
    expect(call.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(call.headers['content-type']).toBe('application/json');
    const body = JSON.parse(String(call.body));
    expect(body).toMatchObject({
      contractVersion: '1',
      invocationId: INVOCATION_ID,
      grant: 'signed-grant-token',
      operationId: OP_ID,
      taskId: TASK_ID,
      stepKey: 'summarize',
      bindingSlot: 'reasoning',
      input: { text: 'hello' },
      deadlineAt: '2099-01-01T00:00:00.000Z',
    });
    // SUCCEEDED → completed with result/usage passthrough.
    expect(out.state).toBe('completed');
    expect(out.invocationId).toBe(INVOCATION_ID);
    expect(out.result).toMatchObject({ content: 'ok', sessionRef: 'sess-9' });
    expect(out.usage).toMatchObject({ inputTokens: 1 });
    expect(out.providerRequestId).toBe('prov-1');
  });

  it('maps PENDING to pending and preserves nextPollAt', async () => {
    const nextPollAt = new Date(Date.now() + 30_000).toISOString();
    const { fetchImpl } = mockFetch(() =>
      wireResponse(200, { invocationId: INVOCATION_ID, state: 'PENDING', nextPollAt })
    );
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const out = await transport.invoke(makeRequest());
    expect(out.state).toBe('pending');
    expect(out.nextPollAt).toBe(nextPollAt);
  });

  it('GETs /invocations/:id for poll and POSTs /invocations/:id/cancel with reason', async () => {
    const { fetchImpl, captured } = mockFetch(() => wireResponse(200, succeededWire()));
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });

    await transport.get(INVOCATION_ID);
    await transport.cancel(INVOCATION_ID, 'user cancel');

    expect(captured).toHaveLength(2);
    expect(captured[0]!.method).toBe('GET');
    expect(captured[0]!.url).toBe(`${BASE}/invocations/${INVOCATION_ID}`);
    expect(captured[1]!.method).toBe('POST');
    expect(captured[1]!.url).toBe(`${BASE}/invocations/${INVOCATION_ID}/cancel`);
    expect(JSON.parse(String(captured[1]!.body))).toEqual({ reason: 'user cancel' });
  });

  it('carries the signed invocation grant to status and cancel requests', async () => {
    const { fetchImpl, captured } = mockFetch(() => wireResponse(200, succeededWire()));
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const request = makeRequest();

    await transport.invoke(request);
    await transport.get(request.invocationId);
    await transport.cancel(request.invocationId, 'user cancel');

    expect(captured[0]!.headers['x-invocation-grant']).toBe(request.grant);
    expect(captured[1]!.headers['x-invocation-grant']).toBe(request.grant);
    expect(captured[2]!.headers['x-invocation-grant']).toBe(request.grant);
  });

  it('accepts an explicit invocation grant on poll and cancel after transport recreation', async () => {
    const request = makeRequest();
    const { fetchImpl, captured } = mockFetch(() => wireResponse(200, succeededWire()));
    const original = new ConnectorClient(createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl }));
    await original.invoke(request);

    const restarted = new ConnectorClient(createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl }));
    await restarted.poll(request.invocationId, { invocationGrant: 'fresh-signed-grant' });
    await restarted.cancel(request.invocationId, 'restart continuity check', {
      invocationGrant: 'fresh-signed-grant',
    });

    expect(captured[1]!.headers['x-invocation-grant']).toBe('fresh-signed-grant');
    expect(captured[2]!.headers['x-invocation-grant']).toBe('fresh-signed-grant');
  });

  it('resolves the invocation grant after a client transport is recreated', async () => {
    const request = makeRequest();
    const { fetchImpl, captured } = mockFetch(() => wireResponse(200, succeededWire()));
    const original = new ConnectorClient(createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl }));
    await original.invoke(request);

    const restarted = new ConnectorClient(createHttpTransport({
      baseUrl: BASE,
      token: TOKEN,
      fetchImpl,
      resolveInvocationGrant: async (invocationId) => {
        expect(invocationId).toBe(request.invocationId);
        return 'fresh-signed-grant';
      },
    }));
    await restarted.poll(request.invocationId);
    await restarted.cancel(request.invocationId, 'restart continuity check');

    expect(captured[1]!.headers['x-invocation-grant']).toBe('fresh-signed-grant');
    expect(captured[2]!.headers['x-invocation-grant']).toBe('fresh-signed-grant');
  });

  it('supports a rotating token supplier', async () => {
    let n = 0;
    const { fetchImpl, captured } = mockFetch(() => wireResponse(200, succeededWire()));
    const transport = createHttpTransport({ baseUrl: BASE, token: () => `tok-${++n}`, fetchImpl });
    await transport.invoke(makeRequest());
    await transport.invoke(makeRequest());
    expect(captured[0]!.headers.authorization).toBe('Bearer tok-1');
    expect(captured[1]!.headers.authorization).toBe('Bearer tok-2');
  });
});

describe('createHttpTransport — error mapping', () => {
  it('maps 429 to PROVIDER_RATE_LIMITED retryable with status metadata', async () => {
    const { fetchImpl } = mockFetch(() => wireResponse(429, { error: { message: 'slow down' } }));
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await expect(transport.invoke(makeRequest())).rejects.toMatchObject({
      name: 'ConnectorClientError',
      code: 'PROVIDER_RATE_LIMITED',
      status: 429,
      retryable: true,
    });
  });

  it('passes through a body error.code and retryAfterMs on 5xx', async () => {
    const { fetchImpl } = mockFetch(() =>
      wireResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE', message: 'upstream down', retryAfterMs: 4000 } })
    );
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await expect(transport.invoke(makeRequest())).rejects.toMatchObject({
      code: 'PROVIDER_UNAVAILABLE',
      retryAfterMs: 4000,
      status: 503,
      retryable: true,
    });
  });

  it('maps 400 to INVALID_INPUT non-retryable', async () => {
    const { fetchImpl } = mockFetch(() => wireResponse(400, { detail: 'bad request' }));
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await expect(transport.invoke(makeRequest())).rejects.toMatchObject({
      code: 'INVALID_INPUT',
      status: 400,
      retryable: false,
    });
  });

  it('maps a rejected fetch to INVOCATION_UNKNOWN status 0 retryable (reconcile, never blind-retry)', async () => {
    const fetchImpl = (async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await expect(transport.invoke(makeRequest())).rejects.toMatchObject({
      code: 'INVOCATION_UNKNOWN',
      status: 0,
      retryable: true,
    });
  });

  it('rejects a malformed 200 body as INVALID_PROVIDER_RESPONSE non-retryable', async () => {
    const { fetchImpl } = mockFetch(() => wireResponse(200, { nonsense: true }));
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await expect(transport.invoke(makeRequest())).rejects.toMatchObject({
      code: 'INVALID_PROVIDER_RESPONSE',
      retryable: false,
    });
  });

  it('honors a pre-aborted signal as a transport failure', async () => {
    const fetchImpl = (async (_url: string, init?: RequestInit) => {
      if (init?.signal?.aborted) throw new Error('aborted');
      return wireResponse(200, succeededWire());
    }) as unknown as typeof fetch;
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });
    const controller = new AbortController();
    controller.abort();
    await expect(transport.invoke(makeRequest(), controller.signal)).rejects.toBeInstanceOf(
      ConnectorClientError
    );
  });

  it('validates the outgoing request against the frozen contract', async () => {
    const { fetchImpl } = mockFetch(() => wireResponse(200, succeededWire()));
    const transport = createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl });
    await expect(
      transport.invoke(makeRequest({ operationId: 'not-a-uuid' }))
    ).rejects.toBeTruthy(); // zod parse error before any HTTP call
  });
});

describe('ConnectorClient over createHttpTransport (stable invocation + poll)', () => {
  it('replay preserves the same invocationId; pending polls to completed', async () => {
    let polls = 0;
    const { fetchImpl, captured } = mockFetch((c) => {
      if (c.method === 'POST' && c.url.endsWith('/invocations')) {
        return wireResponse(200, { invocationId: INVOCATION_ID, state: 'PENDING', nextPollAt: null });
      }
      polls++;
      return wireResponse(
        200,
        polls >= 2 ? succeededWire() : { invocationId: INVOCATION_ID, state: 'PENDING', nextPollAt: null }
      );
    });
    const client = new ConnectorClient(createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl }));

    const first = await client.replay(makeRequest());
    expect(first.state).toBe('pending');
    expect(first.invocationId).toBe(INVOCATION_ID);

    const waited = await client.wait(INVOCATION_ID, {
      deadlineAt: '2099-01-01T00:00:00.000Z',
      poll: async () => undefined,
    });
    expect(waited.state).toBe('completed');
    expect(waited.invocationId).toBe(INVOCATION_ID);
    // Every leg carried the same stable invocation identity.
    expect(captured.length).toBeGreaterThanOrEqual(3);
  });
});

describe('createSdkConnectorInvoker (worker-sdk seam adapter)', () => {
  const payload = {
    contractVersion: '1' as const,
    invocationId: INVOCATION_ID,
    grant: 'signed-grant-token',
    operationId: OP_ID,
    taskId: TASK_ID,
    stepKey: 'summarize',
    bindingSlot: 'reasoning',
    input: { text: 'hello' } as Record<string, unknown>,
    sessionRef: 'sess-1',
    deadlineAt: '2099-01-01T00:00:00.000Z',
  };
  const grant = { grant: 'signed-grant-token', invocationId: INVOCATION_ID };

  it('returns the wire InvocationResponse shape for a completed call', async () => {
    const { fetchImpl, captured } = mockFetch(() => wireResponse(200, succeededWire()));
    const invoker = createSdkConnectorInvoker(
      createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl })
    );
    const res = await invoker(grant, payload);
    expect(res.state).toBe('SUCCEEDED');
    expect(res.invocationId).toBe(INVOCATION_ID);
    expect(res.result).toMatchObject({ content: 'ok' });
    // sessionRef forwarded on the wire.
    const body = JSON.parse(String(captured[0]!.body));
    expect(body.sessionRef).toBe('sess-1');
  });

  it('converts an HTTP failure into a wire FAILED envelope with retryable', async () => {
    const { fetchImpl } = mockFetch(() =>
      wireResponse(503, { error: { code: 'PROVIDER_UNAVAILABLE', message: 'down' } })
    );
    const invoker = createSdkConnectorInvoker(
      createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl })
    );
    const res = await invoker(grant, payload);
    expect(res.state).toBe('FAILED');
    expect(res.error).toMatchObject({ code: 'PROVIDER_UNAVAILABLE', retryable: true });
  });

  it('converts a transport rejection into wire UNKNOWN (reconcile path)', async () => {
    const fetchImpl = (async () => {
      throw new Error('socket hang up');
    }) as unknown as typeof fetch;
    const invoker = createSdkConnectorInvoker(
      createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl })
    );
    const res = await invoker(grant, payload);
    expect(res.state).toBe('UNKNOWN');
    expect(res.error).toMatchObject({ code: 'INVOCATION_UNKNOWN', retryable: true });
  });

  it('maps a pending wire response through unchanged (yield, not spin)', async () => {
    const nextPollAt = new Date(Date.now() + 60_000).toISOString();
    const { fetchImpl } = mockFetch(() =>
      wireResponse(200, { invocationId: INVOCATION_ID, state: 'PENDING', nextPollAt })
    );
    const invoker = createSdkConnectorInvoker(
      createHttpTransport({ baseUrl: BASE, token: TOKEN, fetchImpl })
    );
    const res = await invoker(grant, payload);
    expect(res.state).toBe('PENDING');
    expect(res.nextPollAt).toBe(nextPollAt);
  });
});
