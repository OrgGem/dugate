import {
  RedisQuotaStore,
  createConnectorServer,
  redactConnectorRevision,
  type RedisEvalClient,
  type ConnectorHttpStore,
  InMemoryUsageOutbox,
  appendUsageEvent,
} from '../src';
// Cycle-102 convention: bind the two fetch-driving servers OUTSIDE the OS
// ephemeral band (Windows filters connects to freshly chosen ephemeral ports).
import { listenLoopback } from '../../../tests/harness/listen-loopback';

class FakeRedis implements RedisEvalClient {
  private readonly leases = new Map<string, Map<string, number>>();

  public async eval(script: string, _keyCount: number, ...args: string[]): Promise<unknown> {
    const key = args[0];
    const entries = this.leases.get(key) ?? new Map<string, number>();
    this.leases.set(key, entries);
    if (script.includes('ZREMRANGEBYSCORE')) {
      const now = Number(args[1]);
      const expiry = Number(args[2]);
      const max = Number(args[3]);
      const leaseId = args[4];
      for (const [id, value] of entries) if (value <= now) entries.delete(id);
      if (entries.size >= max) return false;
      entries.set(leaseId, expiry);
      return leaseId;
    }
    if (script.includes('ZSCORE')) {
      const leaseId = args[1];
      const now = Number(args[2]);
      const expiry = Number(args[3]);
      const current = entries.get(leaseId);
      if (current === undefined || current <= now || expiry <= now) return false;
      entries.set(leaseId, expiry);
      return expiry;
    }
    entries.delete(args[1]);
    return 1;
  }
}

test('Redis quota is shared by two store instances through atomic eval boundary', async () => {
  const redis = new FakeRedis();
  const first = new RedisQuotaStore(redis);
  const second = new RedisQuotaStore(redis);
  const lease = await first.acquire('account:model', 100, 1000, 1);
  expect(lease).toBeDefined();
  expect(await second.acquire('account:model', 100, 1000, 1)).toBeUndefined();
  const renewed = await second.renew(lease!, 500, 1000);
  expect(renewed?.expiresAt).toBe(1500);
  expect(await second.acquire('account:model', 500, 1000, 1)).toBeUndefined();
  await first.release(lease!);
  expect(await second.renew(lease!, 500, 1000)).toBeUndefined();
  expect(await second.acquire('account:model', 500, 1000, 1)).toBeDefined();
});

test('management revision redacts all configured provider headers', () => {
  const redacted = redactConnectorRevision({
    connectorId: 'c1',
    revision: 1,
    adapter: 'json-http',
    config: {
      baseUrl: 'https://provider.example',
      path: '/infer',
      headers: { authorization: 'secret', 'x-api-key': 'secret' },
      timeoutMs: 1000,
    },
    credentialRef: 'credential-1',
    state: 'ACTIVE',
    credentialSource: { kind: 'legacy-db', credentialRef: 'credential-1' },
    tenantId: '',
  });
  expect(redacted.config.headers).toEqual({
    authorization: '[REDACTED]',
    'x-api-key': '[REDACTED]',
  });
});

test('HTTP shell exposes health, redacted management, and write-only rotation', async () => {
  let rotated = '';
  const management: ConnectorHttpStore = {
    list: async () => [{
      connectorId: 'c1',
      revision: 1,
      adapter: 'json-http',
      config: { baseUrl: 'https://provider.example', path: '/infer', headers: { authorization: 'secret' }, timeoutMs: 1000 },
      credentialRef: 'credential-1',
      state: 'ACTIVE',
      credentialSource: { kind: 'legacy-db', credentialRef: 'credential-1' },
      tenantId: '',
    }],
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
    rotateCredential: async (_id, secret) => { rotated = secret; },
    disable: async () => {},
    test: async () => ({ ok: true }),
  };
  const server = createConnectorServer({
    management,
    runtime: {
      invoke: async () => ({ invocationId: 'i1', state: 'pending', nextPollAt: '2099-01-01T00:00:00.000Z' }),
      get: async () => undefined,
      cancel: async () => ({ invocationId: 'i1', state: 'cancelled' }),
    },
    capabilities: () => ({ adapters: ['json-http', 'multipart-http'] }),
    ready: async () => true,
    allowUnauthenticatedTestTraffic: true,
  });

  await listenLoopback(server, 43440 + ((process.pid % 8) * 8));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  const managementResponse = await fetch(`${base}/connectors`);
  const body = await managementResponse.json() as Array<{ config: { headers?: Record<string, string> } }>;
  expect(body[0].config.headers?.authorization).toBe('[REDACTED]');
  expect(JSON.stringify(body)).not.toContain('secret');
  const rotateResponse = await fetch(`${base}/connectors/c1/credentials/rotate`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ secret: 'new-secret' }),
  });
  expect(rotateResponse.status).toBe(204);
  expect(rotated).toBe('new-secret');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('HTTP invocation reads and cancellation forward the invocation grant header', async () => {
  let getGrant: string | undefined;
  let cancelGrant: string | undefined;
  const management: ConnectorHttpStore = {
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
  };
  const server = createConnectorServer({
    management,
    runtime: {
      invoke: async () => ({ invocationId: 'inv-1', state: 'completed' }),
      get: async (invocationId, invocationGrant) => {
        getGrant = invocationGrant;
        return { invocationId, state: 'completed' };
      },
      cancel: async (invocationId, _reason, invocationGrant) => {
        cancelGrant = invocationGrant;
        return { invocationId, state: 'cancelled' };
      },
    },
    capabilities: () => ({}),
    ready: async () => true,
    allowUnauthenticatedTestTraffic: true,
  });

  await listenLoopback(server, 43500 + ((process.pid % 8) * 8));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('server did not bind');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'content-type': 'application/json', 'x-invocation-grant': 'signed-grant' };

  const read = await fetch(`${base}/invocations/inv-1`, { headers });
  const cancel = await fetch(`${base}/invocations/inv-1/cancel`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ reason: 'test cancel' }),
  });

  expect(read.status).toBe(200);
  expect(cancel.status).toBe(202);
  expect(getGrant).toBe('signed-grant');
  expect(cancelGrant).toBe('signed-grant');
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
});

test('usage outbox replays after delivery fault without duplicating event IDs', async () => {
  const outbox = new InMemoryUsageOutbox();
  const event = appendUsageEvent('invocation-1', 1, {
    inputTokens: 1,
    outputTokens: 2,
    measurement: 'measured',
  });
  expect(event).toBeDefined();
  await outbox.append(event!);
  await outbox.append(event!);
  const first = await outbox.claimBatch(1);
  expect(first).toHaveLength(1);
  expect(first[0].attempts).toBe(1);
  const replay = await outbox.claimBatch(1);
  expect(replay).toHaveLength(1);
  expect(replay[0].eventId).toBe(first[0].eventId);
  expect(replay[0].attempts).toBe(2);
  await outbox.markDelivered(event!.eventId);
  expect(outbox.size()).toBe(0);
});
