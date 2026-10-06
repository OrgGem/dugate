import {
  ConnectorError,
  FetchProviderTransport,
  HttpUsageSink,
  InMemoryUsageOutbox,
  UsageOutboxDispatcher,
  appendUsageEvent,
  validateProviderUrl,
  createConnectorServer,
  type UsageSink,
  type ConnectorErrorCode,
} from '../src';
// Cycle-102 convention: quiet-band bind instead of the ephemeral lottery.
import { listenLoopback } from '../../../tests/harness/listen-loopback';

test('usage dispatcher retries failed delivery, acknowledges once, and survives poison events', async () => {
  const outbox = new InMemoryUsageOutbox();
  const event = appendUsageEvent('usage-1', 1, {
    inputTokens: 1,
    outputTokens: 2,
    measurement: 'measured',
  }, {
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
  });

  expect(event).toBeDefined();
  await outbox.append(event!);
  let attempts = 0;
  const sink: UsageSink = {
    send: async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('sink down');
    },
  };
  const dispatcher = new UsageOutboxDispatcher(outbox, sink, {
    baseRetryMs: 0,
    maxRetryMs: 0,
    random: () => 0,
  });
  await dispatcher.dispatchOnce();
  expect(attempts).toBe(1);
  await dispatcher.dispatchOnce();
  expect(attempts).toBe(2);
  expect(outbox.size()).toBe(0);
  await dispatcher.drain();
});

test('usage dispatcher parks a poison event after retry exhaustion without dropping it', async () => {
  const outbox = new InMemoryUsageOutbox();
  const event = appendUsageEvent('poison-1', 1, {
    inputTokens: 1,
    measurement: 'estimated',
  }, {
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
  });
  await outbox.append(event!);
  const dispatcher = new UsageOutboxDispatcher(outbox, {
    send: async () => { throw new Error('poison'); },
  }, { maxAttempts: 1, poisonRetryMs: 60_000 });
  await dispatcher.dispatchOnce();
  expect(outbox.size()).toBe(1);
  expect(await outbox.claimBatch(1, new Date().toISOString())).toHaveLength(0);
});

test('provider egress rejects private, IPv6 loopback, userinfo, and unsafe redirects', async () => {
  await expect(validateProviderUrl('http://127.0.0.1:8080')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(validateProviderUrl('http://[::1]:8080')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(validateProviderUrl('http://user:pass@example.com')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
  await expect(validateProviderUrl('http://127.0.0.1:8080', { allowPrivateNetworks: true })).resolves.toBeInstanceOf(URL);
  const transport = new FetchProviderTransport({
    fetcher: async () => new Response('', { status: 302, headers: { location: 'http://127.0.0.1' } }),
    allowPrivateNetworks: true,
  });
  await expect(transport.send({
    url: 'http://127.0.0.1:8080',
    method: 'POST',
    headers: {},
    body: '{}',
  })).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
});

test('usage sink sends the single contract event to the Orchestrator with bearer auth', async () => {
  const requests: Array<{ input: RequestInfo | URL; init?: RequestInit }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    requests.push({ input, init });
    return new Response(null, { status: 202 });
  };
  const sink = new HttpUsageSink(
    'https://orchestrator.example/api/runtime/v1/usage-events',
    'secret-token',
    fetcher,
  );
  const event = appendUsageEvent('usage-2', 1, {
    inputTokens: 1,
    outputTokens: 2,
    pages: 3,
    costMicrousd: 4,
    measurement: 'measured',
  }, {
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
  });

  await expect(sink.send(event!)).resolves.toBeUndefined();
  expect(requests).toHaveLength(1);
  expect(String(requests[0]?.input)).toBe('https://orchestrator.example/api/runtime/v1/usage-events');
  expect(requests[0]?.init).toMatchObject({
    method: 'POST',
    headers: {
      authorization: 'Bearer secret-token',
      'content-type': 'application/json',
      'idempotency-key': event!.eventId,
    },
  });
  expect(JSON.parse(String(requests[0]?.init?.body))).toEqual({
    eventId: event!.eventId,
    invocationId: 'usage-2',
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    units: { inputTokens: 1, outputTokens: 2, pages: 3 },
    costMicrousd: 4,
    currency: 'USD',
    measurement: 'measured',
    occurredAt: event!.createdAt,
  });
});

test.each([
  ['network failure', async () => { throw new Error('secret-token: network'); }, 'Usage sink is unavailable.'],
  ['HTTP rejection', async () => new Response(null, { status: 503 }), 'Usage sink rejected the event.'],
] as const)('usage sink safely handles %s', async (_name, fetcher, message) => {
  const sink = new HttpUsageSink(
    'https://orchestrator.example/api/runtime/v1/usage-events',
    'secret-token',
    fetcher,
  );
  const event = appendUsageEvent('usage-rejected', 1, {
    inputTokens: 1,
    measurement: 'estimated',
  }, {
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
  });

  await expect(sink.send(event!)).rejects.toMatchObject({
    code: 'PROVIDER_UNAVAILABLE',
    message,
  });
  await expect(sink.send(event!)).rejects.not.toThrow('secret-token');
});

test('idle usage dispatcher drain does not leave a timeout handle', async () => {
  jest.useFakeTimers();
  try {
    const outbox = new InMemoryUsageOutbox();
    const dispatcher = new UsageOutboxDispatcher(outbox, { send: async () => {} });

    await dispatcher.drain();

    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test('usage dispatcher drain remains bounded when delivery does not settle', async () => {
  jest.useFakeTimers();
  try {
    const outbox = new InMemoryUsageOutbox();
    const event = appendUsageEvent('usage-stuck', 1, {
      inputTokens: 1,
      measurement: 'estimated',
    }, {
      operationId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
    });
    await outbox.append(event!);
    let markDeliveryStarted!: () => void;
    const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
    const dispatcher = new UsageOutboxDispatcher(outbox, {
      send: async () => {
        markDeliveryStarted();
        await new Promise<void>(() => {});
      },
    });
    void dispatcher.dispatchOnce();
    await deliveryStarted;

    const drain = dispatcher.drain(100);
    expect(jest.getTimerCount()).toBe(2);
    await jest.advanceTimersByTimeAsync(100);

    await expect(drain).resolves.toBeUndefined();
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test('usage dispatcher timeout zero cancels active delivery without waiting', async () => {
  jest.useFakeTimers();
  try {
    const outbox = new InMemoryUsageOutbox();
    const event = appendUsageEvent('usage-no-wait', 1, {
      inputTokens: 1,
      measurement: 'estimated',
    }, {
      operationId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
    });
    await outbox.append(event!);
    let announceSend!: () => void;
    let sendSignal: AbortSignal | undefined;
    const sendStarted = new Promise<void>((resolve) => { announceSend = resolve; });
    const dispatcher = new UsageOutboxDispatcher(outbox, {
      send: async (_payload, signal) => {
        sendSignal = signal;
        announceSend();
        await new Promise<void>(() => {});
      },
    });
    const dispatch = dispatcher.dispatchOnce();
    await sendStarted;

    await expect(dispatcher.drain(0)).resolves.toBeUndefined();
    expect(sendSignal?.aborted).toBe(true);
    await dispatch;
    expect(outbox.size()).toBe(1);
    expect(jest.getTimerCount()).toBe(0);
  } finally {
    jest.useRealTimers();
  }
});

test('HTTP maps quota and provider failures to stable statuses', async () => {
  let errorCode: ConnectorErrorCode = 'QUOTA_EXHAUSTED';
  const server = createConnectorServer({
    management: {
      list: async () => [],
      get: async () => undefined,
      createRevision: async (input) => ({
        ...input,
        credentialSource: input.credentialSource ?? { kind: 'legacy-db', credentialRef: input.credentialRef },
        revision: 1,
        tenantId: input.tenantId ?? '',
      }),
      getRevision: async () => undefined,
      getCurrentRevision: async () => undefined,
      bootstrapRevision: async () => { throw new Error('unused'); },
    createPendingRevision: async () => {
        throw new Error('not implemented in test double');
      },
      activateRevision: async () => false,
      retireRevision: async () => {},
      rotateCredential: async () => {},
      disable: async () => {},
      test: async () => ({ ok: true }),
    },
    runtime: {
      invoke: async () => { throw new ConnectorError(errorCode, 'failure'); },
      get: async () => undefined,
      cancel: async () => { throw new ConnectorError('INVOCATION_UNKNOWN', 'unknown'); },
    },
    capabilities: () => ({}),
    ready: async () => true,
    allowUnauthenticatedTestTraffic: true,
  });
  await listenLoopback(server, 43560 + ((process.pid % 8) * 8));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const invoke = () => fetch(`http://127.0.0.1:${address.port}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      contractVersion: '1',
      invocationId: 'http-error-1',
      grant: 'grant',
      operationId: '11111111-1111-4111-8111-111111111111',
      taskId: '22222222-2222-4222-8222-222222222222',
      stepKey: 'step',
      bindingSlot: 'slot',
      input: { prompt: 'x' },
      deadlineAt: '2099-01-01T00:00:00.000Z',
    }),
  });
  expect((await invoke()).status).toBe(429);
  errorCode = 'CANCELLED';
  expect((await invoke()).status).toBe(409);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
