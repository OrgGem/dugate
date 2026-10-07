import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import {
  HmacServiceIdentityVerifier,
  createConnectorComposition,
  createConnectorServer,
  resolveIdentityVerifier,
  type ConnectorHttpStore,
  type ConnectorRuntime,
  type ConnectorHttpDependencies,
} from '../src';
import { listenLoopback } from '../../../../tests/harness/listen-loopback';

/**
 * CR06-05: every composition path enforces service identity.
 *
 * The only accepted exception is the explicit test-only carve-out
 * (`allowUnauthenticatedTestTraffic`), which is (a) opted into per harness,
 * (b) rejected outside a recognized test runner and (c) logged on activation.
 * This suite drives the real HMAC verifier over real HTTP on both the direct
 * `createConnectorServer` path and the `createConnectorComposition` override
 * path, and proves construction fails closed when no verifier is wired.
 */

const serviceSecret = Buffer.alloc(32, 11); // Offline fixture key only.

function token(claims: Record<string, unknown>, secret: Uint8Array = serviceSecret): string {
  const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
  const payload = Buffer.from(JSON.stringify({
    exp: Math.floor(Date.now() / 1000) + 300,
    ...claims,
  })).toString('base64url');
  const signature = createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url');
  return `${header}.${payload}.${signature}`;
}

const manageToken = (): string => token({
  sub: 'orchestrator-management',
  aud: 'connector',
  scopes: ['connector:manage'],
});
const invokeToken = (): string => token({
  sub: 'document-core-worker',
  aud: 'connector',
  scopes: ['connector:invoke'],
});

function managementDouble(): ConnectorHttpStore {
  return {
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
    createPendingRevision: async () => { throw new Error('unused'); },
    activateRevision: async () => false,
    retireRevision: async () => {},
    rotateCredential: async () => {},
    disable: async () => {},
    test: async () => ({ ok: true }),
  };
}

function runtimeDouble(): ConnectorRuntime {
  return {
    invoke: async () => ({ invocationId: 'cr06-05', state: 'completed' }),
    get: async () => undefined,
    cancel: async (invocationId) => ({ invocationId, state: 'cancelled' }),
  };
}

function overrideHttp(extra: Partial<ConnectorHttpDependencies> = {}): ConnectorHttpDependencies {
  return {
    management: managementDouble(),
    runtime: runtimeDouble(),
    capabilities: () => ({}),
    ready: async () => true,
    ...extra,
  };
}

const invocationBody = {
  contractVersion: '1',
  invocationId: 'cr06-05-invoke',
  grant: 'signed-grant',
  operationId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  stepKey: 'step',
  bindingSlot: 'slot',
  input: { prompt: 'offline fixture' },
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

async function fetchJson(
  base: string,
  path: string,
  bearer?: string,
  init: RequestInit = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(base + path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(bearer ? { authorization: `Bearer ${bearer}` } : {}),
      ...(init.headers as Record<string, string> | undefined),
    },
  });
  const text = await response.text();
  return { status: response.status, body: text ? JSON.parse(text) as Record<string, unknown> : {} };
}

async function reserveQuietPort(base: number): Promise<number> {
  const probe = createServer();
  const port = await listenLoopback(probe, base, 12);
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

describe('CR06-05 fail-closed construction', () => {
  test('resolveIdentityVerifier returns the configured verifier', () => {
    const verifier = { verify: async () => ({ subject: 's', audience: 'a', scopes: [] }) };
    expect(resolveIdentityVerifier({ identityVerifier: verifier })).toBe(verifier);
  });

  test('resolveIdentityVerifier throws when neither verifier nor carve-out is configured', () => {
    expect(() => resolveIdentityVerifier({})).toThrow(/service identity verification is required/i);
  });

  test('carve-out is rejected outside a recognized test runner even when the flag is set', () => {
    const saved = {
      NODE_ENV: process.env.NODE_ENV,
      JEST_WORKER_ID: process.env.JEST_WORKER_ID,
      VITEST: process.env.VITEST,
    };
    try {
      delete process.env.JEST_WORKER_ID;
      delete process.env.VITEST;
      process.env.NODE_ENV = 'production';
      expect(() => resolveIdentityVerifier({ allowUnauthenticatedTestTraffic: true }))
        .toThrow(/only allowed under a test runner/i);
    } finally {
      restoreEnv('NODE_ENV', saved.NODE_ENV);
      restoreEnv('JEST_WORKER_ID', saved.JEST_WORKER_ID);
      restoreEnv('VITEST', saved.VITEST);
    }
  });

  test('carve-out resolves to no verifier and logs under the test runner', () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(resolveIdentityVerifier({ allowUnauthenticatedTestTraffic: true })).toBeNull();
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('CR06-05 test-only carve-out active'));
    } finally {
      warn.mockRestore();
    }
  });

  test('createConnectorServer without verifier or carve-out refuses to construct', () => {
    expect(() => createConnectorServer(overrideHttp())).toThrow(/service identity verification is required/i);
  });

  test('composition override path without verifier or carve-out refuses to construct', () => {
    expect(() => createConnectorComposition({
      port: 0,
      host: '127.0.0.1',
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
    }, { http: overrideHttp() })).toThrow(/service identity verification is required/i);
  });
});

describe('CR06-05 direct createConnectorServer path enforces identity', () => {
  let server: ReturnType<typeof createConnectorServer>;
  let base = '';
  const management = managementDouble();
  const runtime = runtimeDouble();
  const invokeCalls = jest.spyOn(runtime, 'invoke');
  const listCalls = jest.spyOn(management, 'list');

  beforeAll(async () => {
    server = createConnectorServer({
      management,
      runtime,
      capabilities: () => ({ adapters: ['json-http'] }),
      ready: async () => true,
      identityVerifier: new HmacServiceIdentityVerifier(serviceSecret),
    });
    const port = await listenLoopback(server, 43920 + ((process.pid % 8) * 8), 12);
    base = `http://127.0.0.1:${port}`;
  });

  beforeEach(() => {
    invokeCalls.mockClear();
    listCalls.mockClear();
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  });

  test.each([
    ['missing', undefined],
    ['wrong signature', token({
      sub: 'orchestrator-management', aud: 'connector', scopes: ['connector:manage'],
    }, Buffer.alloc(32, 12))],
    ['expired', token({
      sub: 'orchestrator-management', aud: 'connector', scopes: ['connector:manage'],
      exp: Math.floor(Date.now() / 1000) - 1,
    })],
  ] as const)('rejects a %s management identity before store access', async (_label, bearer) => {
    const response = await fetchJson(base, '/connectors', bearer);
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'GRANT_INVALID' });
    expect(listCalls).not.toHaveBeenCalled();
    expect(invokeCalls).not.toHaveBeenCalled();
  });

  test.each([
    ['missing', undefined],
    ['wrong signature', token({
      sub: 'document-core-worker', aud: 'connector', scopes: ['connector:invoke'],
    }, Buffer.alloc(32, 12))],
    ['expired', token({
      sub: 'document-core-worker', aud: 'connector', scopes: ['connector:invoke'],
      exp: Math.floor(Date.now() / 1000) - 1,
    })],
  ] as const)('rejects a %s invocation identity before runtime dispatch', async (_label, bearer) => {
    const response = await fetchJson(base, '/invocations', bearer, {
      method: 'POST',
      body: JSON.stringify(invocationBody),
    });
    expect(response.status).toBe(401);
    expect(response.body.error).toMatchObject({ code: 'GRANT_INVALID' });
    expect(invokeCalls).not.toHaveBeenCalled();
  });

  test('a valid management identity still reaches the store (not a blanket deny)', async () => {
    const response = await fetchJson(base, '/connectors', manageToken());
    expect(response.status).toBe(200);
    expect(listCalls).toHaveBeenCalledTimes(1);
  });

  test('a valid invocation identity still reaches the runtime (not a blanket deny)', async () => {
    const response = await fetchJson(base, '/invocations', invokeToken(), {
      method: 'POST',
      body: JSON.stringify(invocationBody),
    });
    expect(response.status).toBe(200);
    expect(invokeCalls).toHaveBeenCalledTimes(1);
  });

  test('a valid identity with the wrong scope is denied with 403', async () => {
    const response = await fetchJson(base, '/connectors', invokeToken());
    expect(response.status).toBe(403);
    expect(response.body.error).toMatchObject({ code: 'BINDING_DENIED' });
    expect(listCalls).not.toHaveBeenCalled();
  });

  test('health probes stay reachable without identity', async () => {
    expect((await fetchJson(base, '/health/live')).status).toBe(200);
    expect((await fetchJson(base, '/health/ready')).status).toBe(200);
  });
});

describe('CR06-05 composition override path enforces identity', () => {
  test('enforces the verifier inherited from composition config', async () => {
    const port = await reserveQuietPort(43960 + ((process.pid % 8) * 8));
    const management = managementDouble();
    const runtime = runtimeDouble();
    const listCalls = jest.spyOn(management, 'list');
    const composition = createConnectorComposition({
      port,
      host: '127.0.0.1',
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
      serviceIdentityVerifier: new HmacServiceIdentityVerifier(serviceSecret),
    }, {
      http: {
        management,
        runtime,
        capabilities: () => ({}),
        ready: async () => true,
      },
    });
    await composition.start();
    const address = composition.address();
    if (!address || typeof address === 'string') throw new Error('Connector test server did not bind.');
    const base = `http://127.0.0.1:${address.port}`;
    try {
      for (const [label, bearer] of [
        ['missing', undefined],
        ['wrong signature', token({
          sub: 'orchestrator-management', aud: 'connector', scopes: ['connector:manage'],
        }, Buffer.alloc(32, 12))],
        ['expired', token({
          sub: 'orchestrator-management', aud: 'connector', scopes: ['connector:manage'],
          exp: Math.floor(Date.now() / 1000) - 1,
        })],
      ] as const) {
        const response = await fetchJson(base, '/connectors', bearer);
        expect({ label, status: response.status }).toEqual({ label, status: 401 });
        expect(response.body.error).toMatchObject({ code: 'GRANT_INVALID' });
      }
      expect(listCalls).not.toHaveBeenCalled();
      const allowed = await fetchJson(base, '/connectors', manageToken());
      expect(allowed.status).toBe(200);
      expect(listCalls).toHaveBeenCalledTimes(1);
    } finally {
      await composition.shutdown({ timeoutMs: 0 });
    }
  });

  test('honors a verifier provided through the override HTTP dependencies', async () => {
    const port = await reserveQuietPort(43940 + ((process.pid % 8) * 8));
    const composition = createConnectorComposition({
      port,
      host: '127.0.0.1',
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
    }, {
      http: {
        management: managementDouble(),
        runtime: runtimeDouble(),
        capabilities: () => ({}),
        ready: async () => true,
        identityVerifier: new HmacServiceIdentityVerifier(serviceSecret),
      },
    });
    await composition.start();
    const address = composition.address();
    if (!address || typeof address === 'string') throw new Error('Connector test server did not bind.');
    try {
      const response = await fetchJson(`http://127.0.0.1:${address.port}`, '/connectors');
      expect(response.status).toBe(401);
      expect(response.body.error).toMatchObject({ code: 'GRANT_INVALID' });
    } finally {
      await composition.shutdown({ timeoutMs: 0 });
    }
  });

  test('explicit carve-out logs and serves without identity under the test runner', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const port = await reserveQuietPort(43980 + ((process.pid % 8) * 8));
    const composition = createConnectorComposition({
      port,
      host: '127.0.0.1',
      databaseUrl: 'postgres://unused',
      redisUrl: 'redis://unused',
    }, {
      http: overrideHttp({ allowUnauthenticatedTestTraffic: true }),
    });
    try {
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('CR06-05 test-only carve-out active'));
      await composition.start();
      const address = composition.address();
      if (!address || typeof address === 'string') throw new Error('Connector test server did not bind.');
      const response = await fetchJson(`http://127.0.0.1:${address.port}`, '/connectors');
      expect(response.status).toBe(200);
    } finally {
      await composition.shutdown({ timeoutMs: 0 });
      warn.mockRestore();
    }
  });
});
