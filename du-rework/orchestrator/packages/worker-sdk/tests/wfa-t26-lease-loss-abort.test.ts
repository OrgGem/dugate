import { randomUUID } from 'node:crypto';
import { ConnectorTransportError, createConnectorInvoker, DefaultTaskContext, RuntimeClient } from '../src';

/**
 * WFA-T26 (lease recovery) — the abort→cancel seam, offline and focused.
 *
 * Live evidence (coordination/reports/raw/wfa-t26-lease-recovery-2026-10-08/step2-ledger-timeline.log):
 * the lease sweep aborts the fenced delivery's context, and the worker SDK's connector invoker
 * answered that abort with a TERMINAL `POST /invocations/:id/cancel`. The Connector ledger row went
 * `IN_FLIGHT -> CANCELLED` (observed at 00:32:10.543 for invocation 06087b9c-fe2). The redelivered
 * task then replayed a terminally CANCELLED invocation, which is non-retryable, so the workflow
 * failed with LEGACY_WORKFLOW_CONNECTOR_FAILED after 3 attempts even though the provider had been
 * called exactly once.
 *
 * Lease loss is NOT a cancellation: the delivery is fenced and redelivered under a new epoch, and it
 * must be able to replay the SAME stable invocationId. A real cancel (operation cancel, T27) must
 * still reach the Connector as a terminal cancel. These tests pin both halves of that distinction:
 *
 *   1. `DefaultTaskContext.abort(reason)` carries the reason on `ctx.signal.reason`, which is the
 *      contract the business code and docs/16 already assume (`ctx.signal.reason === 'cancel'`).
 *   2. A lease-lost abort stops the local wait but sends NO cancel to the Connector.
 *   3. A cancel abort still sends the terminal cancel (regression guard for WFA-T27 semantics).
 *
 * Offline only: no PG, no Redis, no provider, no HTTP server — the fetch seam is a double.
 */

const grant = {
  grant: 'signed-grant',
  invocationId: 'invocation-1',
  connectorId: 'connector-1',
  connectorRevision: 1,
  expiresAt: '2026-10-08T12:00:00.000Z',
  allowedOptions: {},
};

const payload = {
  contractVersion: '1' as const,
  invocationId: 'invocation-1',
  grant: 'signed-grant',
  operationId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
  stepKey: 'generate_disbursement_report',
  bindingSlot: 'text-generation',
  input: { prompt: 'Summarize this fixture.' },
  deadlineAt: '2026-10-08T12:00:00.000Z',
};

interface RecordedCall {
  url: string;
  method: string;
  grantHeader: string | null;
}

/** Flush the microtask/macrotask queue so the fire-and-forget cancel POST is observable. */
async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * A fetch double whose invocation POST stays in flight until its signal aborts — the provider call
 * is still running, exactly like the live lease-recovery race.
 */
function recordingFetch(record: RecordedCall[]): typeof fetch {
  return (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    record.push({
      url,
      method,
      grantHeader: new Headers(init?.headers).get('x-invocation-grant'),
    });
    if (url.endsWith('/cancel')) {
      return new Response(JSON.stringify({ invocationId: payload.invocationId, state: 'CANCELLED' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }
    return await new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        reject(new Error('aborted'));
        return;
      }
      signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
    });
  }) as unknown as typeof fetch;
}

function invocationCalls(record: RecordedCall[]): RecordedCall[] {
  return record.filter((call) => call.url.endsWith('/invocations'));
}

function cancelCalls(record: RecordedCall[]): RecordedCall[] {
  return record.filter((call) => call.url.includes('/cancel'));
}

function makeContext(cancelRequested = false): DefaultTaskContext {
  return new DefaultTaskContext(
    {
      taskId: randomUUID(),
      operationId: randomUUID(),
      tenantId: '26000000-0000-4000-8000-000000000001',
      businessId: 'document-core',
      businessVersion: '1.1.0',
      action: 'schema-workflow',
      kind: 'root',
      taskKey: 'root',
      attempt: 2,
      leaseEpoch: 3,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      deadlineAt: null,
      input: {},
      connectorBindings: {},
      profilePolicy: undefined,
      checkpointRefs: [],
      cancelRequested,
    } as never,
    {
      runtime: new RuntimeClient({
        baseUrl: 'http://runtime',
        token: 'tok',
        fetchImpl: (async () => new Response('{}')) as never,
      }),
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
      invokeConnector: async () => {
        throw new Error('unused in this suite');
      },
    },
  );
}

describe('WFA-T26 lease loss must not cancel the connector invocation', () => {
  it('DefaultTaskContext.abort carries the reason so lease loss and cancel are distinguishable', () => {
    const leaseLost = makeContext();
    leaseLost.abort('lease-lost');
    expect(leaseLost.signal.aborted).toBe(true);
    expect(leaseLost.signal.reason).toBe('lease-lost');
    expect(leaseLost.cancelRequested).toBe(false);

    const cancelled = makeContext();
    cancelled.abort('cancel');
    expect(cancelled.signal.reason).toBe('cancel');
    expect(cancelled.cancelRequested).toBe(true);

    const shutdown = makeContext();
    shutdown.abort('shutdown');
    expect(shutdown.signal.reason).toBe('shutdown');
    expect(shutdown.cancelRequested).toBe(false);
  });

  it('a lease-lost abort stops the local wait without terminalising the invocation', async () => {
    const record: RecordedCall[] = [];
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl: recordingFetch(record) });
    const controller = new AbortController();

    const pending = invoke(grant, payload, controller.signal);
    await flush();
    expect(invocationCalls(record)).toHaveLength(1);

    controller.abort('lease-lost');
    await expect(pending).rejects.toBeInstanceOf(ConnectorTransportError);
    await flush();

    expect(cancelCalls(record)).toHaveLength(0);
    expect(invocationCalls(record)).toHaveLength(1);
  });

  it('an already-aborted lease-lost signal never reaches the connector as a cancel', async () => {
    const record: RecordedCall[] = [];
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl: recordingFetch(record) });
    const controller = new AbortController();
    controller.abort('lease-lost');

    await expect(invoke(grant, payload, controller.signal)).rejects.toBeInstanceOf(ConnectorTransportError);
    await flush();

    expect(cancelCalls(record)).toHaveLength(0);
  });

  it('a shutdown abort is not a cancellation either', async () => {
    const record: RecordedCall[] = [];
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl: recordingFetch(record) });
    const controller = new AbortController();

    const pending = invoke(grant, payload, controller.signal);
    await flush();
    controller.abort('shutdown');
    await expect(pending).rejects.toBeInstanceOf(ConnectorTransportError);
    await flush();

    expect(cancelCalls(record)).toHaveLength(0);
  });

  it('a real cancel still reaches the connector as a terminal cancel (WFA-T27 semantics kept)', async () => {
    const record: RecordedCall[] = [];
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl: recordingFetch(record) });
    const controller = new AbortController();

    const pending = invoke(grant, payload, controller.signal);
    await flush();
    controller.abort('cancel');
    await expect(pending).rejects.toBeInstanceOf(ConnectorTransportError);
    await flush();

    const cancels = cancelCalls(record);
    expect(cancels).toHaveLength(1);
    expect(cancels[0]!.method).toBe('POST');
    expect(cancels[0]!.url).toContain(`/invocations/${payload.invocationId}/cancel`);
    expect(cancels[0]!.grantHeader).toBe('signed-grant');
  });

  it('a pre-aborted cancel signal still reaches the connector', async () => {
    const record: RecordedCall[] = [];
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl: recordingFetch(record) });
    const controller = new AbortController();
    controller.abort('cancel');

    await expect(invoke(grant, payload, controller.signal)).rejects.toBeInstanceOf(ConnectorTransportError);
    await flush();

    expect(cancelCalls(record)).toHaveLength(1);
  });

  it('an abort with no reason is treated as lease loss, never as a cancel', async () => {
    const record: RecordedCall[] = [];
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl: recordingFetch(record) });
    const controller = new AbortController();

    const pending = invoke(grant, payload, controller.signal);
    await flush();
    controller.abort();
    await expect(pending).rejects.toBeInstanceOf(ConnectorTransportError);
    await flush();

    expect(cancelCalls(record)).toHaveLength(0);
  });
});
