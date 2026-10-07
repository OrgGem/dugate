import { createConnectorInvoker } from '../src';

/**
 * P745-CONNECTOR-PASSTHROUGH (T5): the worker SDK outbound parse (connector-invoker.ts)
 * shares the contracts allowlist, so the two living keys cross the wire
 * verbatim while an unknown third key fails closed before any HTTP dispatch.
 */
const grant = {
  grant: 'signed-grant',
  invocationId: 'inv-p745-options',
  connectorId: 'connector-1',
  connectorRevision: 1,
  expiresAt: '2026-10-05T12:00:00.000Z',
  allowedOptions: {},
};

const basePayload = {
  contractVersion: '1' as const,
  invocationId: 'inv-p745-options',
  grant: 'signed-grant',
  operationId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
  stepKey: 'extract-document',
  bindingSlot: 'reasoning',
  input: { prompt: 'extract' },
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

function response(status: number, body: string): Response {
  return new Response(body, { status, headers: { 'content-type': 'application/json' } });
}

describe('P745 connector options reach the wire unchanged (SDK outbound)', () => {
  test('responseFormat/jsonSchema are sent on the outgoing InvocationRequest', async () => {
    let requestInit: RequestInit | undefined;
    const fetchImpl = jest.fn(async (_input: unknown, init?: RequestInit) => {
      requestInit = init;
      return response(200, JSON.stringify({ invocationId: basePayload.invocationId, state: 'SUCCEEDED' }));
    }) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });

    await invoke(grant, {
      ...basePayload,
      options: { responseFormat: 'json', jsonSchema: { type: 'object', required: ['total'] }, temperature: 0.25 },
    });

    const sent = JSON.parse(String(requestInit?.body)) as { options?: unknown };
    expect(sent.options).toStrictEqual({
      responseFormat: 'json',
      jsonSchema: { type: 'object', required: ['total'] },
      temperature: 0.25,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  test('an unknown third option key is rejected before HTTP dispatch', async () => {
    const fetchImpl = jest.fn(async () => response(200, JSON.stringify({
      invocationId: basePayload.invocationId,
      state: 'SUCCEEDED',
    }))) as unknown as typeof fetch;
    const invoke = createConnectorInvoker({ baseUrl: 'http://connector', fetchImpl });

    await expect(invoke(grant, {
      ...basePayload,
      options: { responseFormat: 'json', unexpectedOption: true },
    })).rejects.toThrow();
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
