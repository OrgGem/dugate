import {
  ConnectorError,
  DurableConnectorRuntime,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  hashInvocationInput,
  invokeAdapter,
  jsonHttpAdapter,
  type GrantClaims,
  type LocalInvocationRequest,
} from '../src';

const request: LocalInvocationRequest = {
  contractVersion: '1',
  invocationId: 'wfa-t7-abort-1',
  tenantId: 'tenant-t7',
  operationId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  stepKey: 'extract',
  bindingSlot: 'reasoning',
  input: { text: 'long provider call' },
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

const claims: GrantClaims = {
  audience: 'connector',
  tenantId: request.tenantId,
  operationId: request.operationId,
  taskId: request.taskId,
  stepKey: request.stepKey,
  invocationId: request.invocationId,
  inputHash: hashInvocationInput(request),
  connectorRevision: 'wfa-t7:1',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

test('cancel aborts the in-flight provider dispatch instead of only flipping the ledger row', async () => {
  const ledger = new InMemoryInvocationLedger();
  let releaseHang: (() => void) | undefined;
  let sendStarted = false;
  let providerAborted = false;
  const transport = {
    send: async (_providerRequest: unknown, signal?: AbortSignal) => {
      sendStarted = true;
      await new Promise<void>((resolveSend) => {
        if (signal?.aborted) {
          resolveSend();
          return;
        }
        signal?.addEventListener('abort', () => {
          providerAborted = true;
          resolveSend();
        }, { once: true });
        releaseHang = resolveSend;
      });
      if (signal?.aborted) {
        throw new ConnectorError('CANCELLED', 'provider dispatch aborted');
      }
      return { status: 200, body: { content: 'provider finished' } };
    },
  };
  const invocation = invokeAdapter(request, {
    ledger,
    quota: new InMemoryQuotaStore(),
    adapter: jsonHttpAdapter,
    config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 60_000 },
    quotaKey: 'wfa-t7:account:model',
    transport,
  });
  // Consume the invocation rejection on every path (including the red path,
  // where the test fails before awaiting it) so the async failure cannot
  // surface as an unhandled rejection that kills the jest worker.
  invocation.catch(() => undefined);
  const startedBy = Date.now() + 5_000;
  while (!sendStarted && Date.now() < startedBy) {
    await new Promise((resolveTick) => setTimeout(resolveTick, 10));
  }
  if (!sendStarted) {
    releaseHang?.();
    throw new Error('provider dispatch never started');
  }

  const runtime = new DurableConnectorRuntime(
    ledger as never, {} as never, {} as never, {} as never, {} as never, {} as never, {} as never,
    { verify: async () => claims },
  );
  try {
    const cancelled = await runtime.cancel(request.invocationId, 'user cancelled', 'grant-token');
    expect(cancelled).toMatchObject({ invocationId: request.invocationId, state: 'cancelled' });
    // Acceptance: cancel must reach the outbound provider request. Flipping the
    // ledger row alone leaves the provider call running until its deadline.
    expect(providerAborted).toBe(true);
    await expect(invocation).rejects.toMatchObject({ code: 'CANCELLED' });
    expect((await ledger.get(request.invocationId))?.state).toBe('CANCELLED');
  } finally {
    releaseHang?.();
  }
});