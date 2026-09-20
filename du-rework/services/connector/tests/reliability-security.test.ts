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
} from '../src';

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

test('usage sink validates contract and never exposes its credential in errors', async () => {
  const sink = new HttpUsageSink('https://usage.example/events', 'secret-token', async () => {
    throw new Error('network');
  });
  const event = appendUsageEvent('usage-2', 1, {
    inputTokens: 1,
    outputTokens: 1,
    measurement: 'estimated',
  }, {
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
  });
  await expect(sink.send(event!)).rejects.toMatchObject({ code: 'PROVIDER_UNAVAILABLE' });
  await expect(sink.send(event!)).rejects.not.toThrow('secret-token');
});

test('HTTP maps quota and provider failures to stable statuses', async () => {
  const server = createConnectorServer({
    management: {
      list: async () => [],
      get: async () => undefined,
      createRevision: async (input) => ({ ...input, revision: 1 }),
      rotateCredential: async () => {},
      disable: async () => {},
      test: async () => ({ ok: true }),
    },
    runtime: {
      invoke: async () => { throw new ConnectorError('QUOTA_EXHAUSTED', 'busy'); },
      get: async () => undefined,
      cancel: async () => { throw new ConnectorError('INVOCATION_UNKNOWN', 'unknown'); },
    },
    capabilities: () => ({}),
    ready: async () => true,
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const response = await fetch(`http://127.0.0.1:${address.port}/invocations`, {
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
  expect(response.status).toBe(429);
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});
