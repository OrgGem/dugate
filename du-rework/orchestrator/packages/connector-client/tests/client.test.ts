import { ConnectorClient, ConnectorClientError, type ConnectorTransport } from '../src';

function transport(results: Array<{ state: 'pending' | 'completed'; invocationId: string }>): ConnectorTransport {
  return {
    invoke: async () => results[0],
    get: async () => results.shift() ?? { state: 'completed', invocationId: 'inv-1' },
    cancel: async () => ({ state: 'pending', invocationId: 'inv-1' }),
  };
}

test('client preserves invocation ID for replay and polls pending results', async () => {
  const client = new ConnectorClient(transport([
    { state: 'pending', invocationId: 'inv-1' },
    { state: 'completed', invocationId: 'inv-1' },
  ]));
  const request = {
    contractVersion: '1' as const,
    invocationId: 'inv-1',
    grant: 'grant',
    operationId: 'op-1',
    taskId: 'task-1',
    stepKey: 'step',
    bindingSlot: 'reasoning',
    input: {},
    deadlineAt: '2099-01-01T00:00:00.000Z',
  };
  expect((await client.replay(request)).invocationId).toBe('inv-1');
  expect((await client.wait('inv-1', { deadlineAt: request.deadlineAt, poll: async () => {} })).state).toBe('completed');
});

test('wait reuses a fresh invocation grant on every poll after client recreation', async () => {
  const grants: Array<string | undefined> = [];
  const results = [
    { state: 'pending' as const, invocationId: 'inv-1' },
    { state: 'completed' as const, invocationId: 'inv-1' },
  ];
  const restarted = new ConnectorClient({
    invoke: async () => results[0]!,
    get: async (_invocationId, _signal, invocationGrant) => {
      grants.push(invocationGrant);
      return results.shift() ?? { state: 'completed', invocationId: 'inv-1' };
    },
    cancel: async () => ({ state: 'cancelled', invocationId: 'inv-1' }),
  });

  await expect(restarted.wait('inv-1', {
    deadlineAt: '2099-01-01T00:00:00.000Z',
    invocationGrant: 'fresh-signed-grant',
    poll: async () => undefined,
  })).resolves.toMatchObject({ state: 'completed' });
  expect(grants).toEqual(['fresh-signed-grant', 'fresh-signed-grant']);
});

test('client surfaces unknown outcomes instead of retrying them', async () => {
  const failing: ConnectorTransport = {
    invoke: async () => ({ state: 'unknown', invocationId: 'inv-1', error: { code: 'INVOCATION_UNKNOWN', message: 'reconcile required' } }),
    get: async () => ({ state: 'unknown', invocationId: 'inv-1' }),
    cancel: async () => ({ state: 'cancelled', invocationId: 'inv-1' }),
  };
  await expect(new ConnectorClient(failing).invoke({
    contractVersion: '1',
    invocationId: 'inv-1',
    grant: 'grant',
    operationId: 'op',
    taskId: 'task',
    stepKey: 'step',
    bindingSlot: 'reasoning',
    input: {},
    deadlineAt: '2099-01-01T00:00:00.000Z',
  })).rejects.toBeInstanceOf(ConnectorClientError);
});
