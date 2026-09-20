import {
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  appendUsageEvent,
  hashInvocationInput,
  invokeAdapter,
  jsonHttpAdapter,
  multipartHttpAdapter,
  validateGrant,
  type GrantClaims,
  type LocalInvocationRequest,
} from '../src';

const request: LocalInvocationRequest = {
  contractVersion: '1',
  invocationId: 'inv-1',
  tenantId: 'tenant-1',
  operationId: 'op-1',
  taskId: 'task-1',
  stepKey: 'extract',
  bindingSlot: 'reasoning',
  input: { prompt: 'Extract', text: 'invoice' },
  options: { temperature: 0 },
  sessionRef: null,
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

describe('connector local protocol functions', () => {
  test('canonical input hash is stable despite object key order', () => {
    const reordered = { ...request, options: { temperature: 0 } };
    expect(hashInvocationInput(request)).toBe(hashInvocationInput(reordered));
  });

  test('ledger replays same request and rejects a different hash', async () => {
    const ledger = new InMemoryInvocationLedger();
    const first = await ledger.claim(request, hashInvocationInput(request));
    expect(first.kind).toBe('claimed');
    expect((await ledger.claim(request, hashInvocationInput(request))).kind).toBe('replay');
    expect((await ledger.claim({ ...request, input: { prompt: 'changed' } }, 'different')).kind).toBe('conflict');
  });

  test('quota enforces the aggregate in-flight cap', async () => {
    const quota = new InMemoryQuotaStore();
    const first = await quota.acquire('provider:account:model', 0, 1000, 1);
    expect(first).toBeDefined();
    expect(await quota.acquire('provider:account:model', 0, 1000, 1)).toBeUndefined();
    await quota.release(first!);
    expect(await quota.acquire('provider:account:model', 0, 1000, 1)).toBeDefined();
  });

  test('grant binds identity, hash, audience, and expiry', async () => {
    const claims: GrantClaims = {
      audience: 'connector',
      tenantId: request.tenantId,
      operationId: request.operationId,
      taskId: request.taskId,
      stepKey: request.stepKey,
      invocationId: request.invocationId,
      inputHash: hashInvocationInput(request),
      connectorRevision: 'rev-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    await expect(validateGrant('token', request, claims.inputHash, { verify: async () => claims })).resolves.toEqual(claims);
    await expect(validateGrant('token', request, 'bad', { verify: async () => claims })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
  });

  test('json and multipart adapters map without arbitrary endpoint overrides', () => {
    const json = jsonHttpAdapter.buildRequest(request, {
      baseUrl: 'https://provider.example/',
      path: '/v1/infer',
      timeoutMs: 1000,
    });
    expect(json.url).toBe('https://provider.example/v1/infer');
    expect(JSON.parse(json.body as string)).toMatchObject({ prompt: 'Extract', text: 'invoice' });
    const multipart = multipartHttpAdapter.buildRequest(request, {
      baseUrl: 'https://provider.example/',
      path: '/v1/infer',
      timeoutMs: 1000,
    });
    expect(multipart.body).toBeInstanceOf(FormData);
  });

  test('usage event IDs are deterministic for duplicate delivery', () => {
    const usage = { inputTokens: 1, outputTokens: 2, measurement: 'measured' as const };
    expect(appendUsageEvent('inv-1', 1, usage)?.eventId).toBe(appendUsageEvent('inv-1', 1, usage)?.eventId);
  });

  test('request mappings never allow arbitrary provider endpoint or header overrides', () => {
    expect(() => jsonHttpAdapter.buildRequest(request, {
      baseUrl: 'file:///secret',
      path: '/etc/passwd',
      timeoutMs: 1000,
    })).toThrow();
  });

  test('invoke seam returns pending for async providers and does not redispatch replay', async () => {
    const ledger = new InMemoryInvocationLedger();
    const quota = new InMemoryQuotaStore();
    let calls = 0;
    const adapter = {
      ...jsonHttpAdapter,
      normalizeResponse: jsonHttpAdapter.normalizeResponse,
    };
    const options = {
      ledger,
      quota,
      adapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000 },
      quotaKey: 'provider:account:model',
      transport: {
        send: async () => {
          calls += 1;
          return { status: 202, body: { nextPollAt: '2099-01-01T00:00:01.000Z' } };
        },
      },
    };
    await expect(invokeAdapter(request, options)).resolves.toMatchObject({ state: 'pending' });
    await expect(invokeAdapter(request, options)).resolves.toMatchObject({ state: 'pending' });
    expect(calls).toBe(1);
  });

  test('provider response loss is recorded as UNKNOWN and never silently retried', async () => {
    const ledger = new InMemoryInvocationLedger();
    await expect(invokeAdapter(request, {
      ledger,
      quota: new InMemoryQuotaStore(),
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000 },
      quotaKey: 'provider:account:model',
      transport: { send: async () => { throw new Error('response lost'); } },
    })).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect((await ledger.get(request.invocationId))?.state).toBe('UNKNOWN');
  });
});
