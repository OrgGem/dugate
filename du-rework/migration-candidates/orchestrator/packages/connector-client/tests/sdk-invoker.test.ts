import type { InvocationInput } from '@du/contracts';
import {
  createSdkConnectorInvoker,
  type ClientInvocationRequest,
  type ConnectorTransport,
} from '../src';
import { ConnectorClientError } from '../src/errors';

test('SDK invoker forwards canonical connector input unchanged', async () => {
  const received: ClientInvocationRequest[] = [];
  const transport: ConnectorTransport = {
    invoke: async (request) => {
      received.push(request);
      return {
        invocationId: request.invocationId,
        state: 'completed',
        result: { content: 'ok' },
      };
    },
    get: async (invocationId) => ({ invocationId, state: 'pending' }),
    cancel: async (invocationId) => ({ invocationId, state: 'cancelled' }),
  };
  const input: InvocationInput = {
    text: 'fixture text',
    outputSchema: { type: 'object' },
  };
  const invoke = createSdkConnectorInvoker(transport);

  await invoke(
    { grant: 'opaque-grant', invocationId: 'inv-1' },
    {
      contractVersion: '1',
      invocationId: 'inv-1',
      grant: 'opaque-grant',
      operationId: '00000000-0000-4000-8000-000000000002',
      taskId: '00000000-0000-4000-8000-000000000003',
      stepKey: 'summarize',
      bindingSlot: 'reasoning',
      input,
      deadlineAt: '2099-01-01T00:00:00.000Z',
    }
  );

  expect(received).toHaveLength(1);
  expect(received[0]?.input).toEqual(input);
});

test('HTTP 409 INVOCATION_UNKNOWN remains UNKNOWN for durable reconciliation', async () => {
  const transport: ConnectorTransport = {
    invoke: async () => {
      throw new ConnectorClientError('INVOCATION_UNKNOWN', 'Outcome needs reconciliation.', undefined, {
        status: 409,
        retryable: false,
      });
    },
    get: async (invocationId) => ({ invocationId, state: 'unknown', error: { code: 'INVOCATION_UNKNOWN', message: 'Stored outcome is unknown.' } }),
    cancel: async (invocationId) => ({ invocationId, state: 'cancelled' }),
  };
  const invoke = createSdkConnectorInvoker(transport);
  const response = await invoke(
    { grant: 'opaque-grant', invocationId: 'inv-unknown-409' },
    {
      contractVersion: '1',
      invocationId: 'inv-unknown-409',
      grant: 'opaque-grant',
      operationId: '00000000-0000-4000-8000-000000000002',
      taskId: '00000000-0000-4000-8000-000000000003',
      stepKey: 'summarize',
      bindingSlot: 'reasoning',
      input: { text: 'fixture text' },
      deadlineAt: '2099-01-01T00:00:00.000Z',
    },
  );

  expect(response.state).toBe('UNKNOWN');
  expect(response.invocationId).toBe('inv-unknown-409');
  expect(response.error).toMatchObject({ code: 'INVOCATION_UNKNOWN', retryable: false });
});
