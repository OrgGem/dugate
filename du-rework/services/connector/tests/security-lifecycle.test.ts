import {
  createConnectorComposition,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  invokeAdapter,
  jsonHttpAdapter,
  requireServiceIdentity,
  validateGrant,
  type GrantClaims,
  type LocalInvocationRequest,
  type ServiceIdentityVerifier,
  type HttpInvocationResult,
} from '../src';
import { createServer } from 'node:http';
// Cycle-102 convention: reserve quiet-band ports instead of letting the
// lifecycle bind OS-ephemeral ports (Windows filters connects to freshly
// chosen ephemeral ports; see tests/harness/listen-loopback.ts).
import { listenLoopback } from '../../../tests/harness/listen-loopback';

async function reserveQuietPort(base: number): Promise<number> {
  const probe = createServer();
  const port = await listenLoopback(probe, base, 12);
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

const request: LocalInvocationRequest = {
  contractVersion: '1',
  invocationId: 'security-1',
  tenantId: 'tenant-1',
  operationId: 'op-1',
  taskId: 'task-1',
  stepKey: 'step',
  bindingSlot: 'reasoning',
  input: { prompt: 'safe' },
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

test.each([
  ['missing scope', { audience: 'connector', subject: 'worker', scopes: [] }],
  ['wrong audience', { audience: 'other', subject: 'worker', scopes: ['connector:invoke'] }],
  ['missing subject', { audience: 'connector', subject: '', scopes: ['connector:invoke'] }],
])('rejects service identity: %s', async (_name, identity) => {
  const verifier: ServiceIdentityVerifier = { verify: async () => identity };
  await expect(requireServiceIdentity({}, verifier, 'connector:invoke')).rejects.toMatchObject({
    code: 'BINDING_DENIED',
  });
});

test('rejects tampered, expired, and input-mismatched grants without exposing token', async () => {
  const claims: GrantClaims = {
    audience: 'connector',
    tenantId: request.tenantId,
    operationId: request.operationId,
    taskId: request.taskId,
    stepKey: request.stepKey,
    invocationId: request.invocationId,
    inputHash: 'expected-hash',
    connectorRevision: 'rev-1',
    expiresAt: '2000-01-01T00:00:00.000Z',
  };
  const verifier = { verify: async (token: string) => {
    if (token === 'tampered') throw new Error('signature mismatch');
    return claims;
  } };
  await expect(validateGrant('tampered', request, claims.inputHash, verifier)).rejects.toMatchObject({ code: 'GRANT_INVALID' });
  await expect(validateGrant('expired', request, claims.inputHash, verifier)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
  await expect(validateGrant('mismatch', request, 'different', verifier)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
  await expect(validateGrant('tampered', request, claims.inputHash, verifier)).rejects.not.toThrow('signature mismatch');
});

test('provider timeout records UNKNOWN and credential revoke blocks the next replay', async () => {
  const ledger = new InMemoryInvocationLedger();
  let active = true;
  const options = {
    ledger,
    quota: new InMemoryQuotaStore(),
    adapter: jsonHttpAdapter,
    config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 5 },
    quotaKey: 'account:model',
    providerTimeoutMs: 5,
    credential: { isActive: async () => active },
    transport: {
      send: async (_request: unknown, signal?: AbortSignal) => await new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
      }),
    },
  };
  await expect(invokeAdapter(request, options)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
  expect((await ledger.get(request.invocationId))?.state).toBe('UNKNOWN');
  active = false;
  await expect(invokeAdapter(request, options)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
});

test('shutdown drains an in-flight HTTP invocation before closing dependencies', async () => {
  let releaseInvocation!: () => void;
  let announceInvocation!: () => void;
  const invocationStarted = new Promise<void>((resolve) => { announceInvocation = resolve; });
  const heldInvocation = new Promise<void>((resolve) => { releaseInvocation = resolve; });
  let closed = false;
  const composition = makeLifecycleComposition(async () => {
    announceInvocation();
    await heldInvocation;
    return { invocationId: 'shutdown-drain', state: 'completed', result: { content: 'finished' } };
  }, async () => { closed = true; }, 500, await reserveQuietPort(43600 + ((process.pid % 8) * 12)));
  const baseUrl = await startOnLoopback(composition);

  const responsePromise = fetchRetryingConnect(`${baseUrl}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(shutdownInvocationRequest),
  });
  await invocationStarted;
  expect(composition.dependencies.acceptingInvocations?.()).toBe(true);

  const shutdownPromise = composition.shutdown();
  expect(composition.dependencies.acceptingInvocations?.()).toBe(false);
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(closed).toBe(false);

  releaseInvocation();
  const response = await responsePromise;
  expect(response.status).toBe(200);
  await expect(response.json()).resolves.toMatchObject({
    invocationId: 'shutdown-drain',
    state: 'SUCCEEDED',
    result: { content: 'finished' },
  });
  await shutdownPromise;
  expect(closed).toBe(true);
});

test('shutdown enforces its configured deadline and closes active HTTP connections', async () => {
  let releaseInvocation!: () => void;
  let announceInvocation!: () => void;
  let announceFinished!: () => void;
  const invocationStarted = new Promise<void>((resolve) => { announceInvocation = resolve; });
  const invocationFinished = new Promise<void>((resolve) => { announceFinished = resolve; });
  const heldInvocation = new Promise<void>((resolve) => { releaseInvocation = resolve; });
  let closed = false;
  const composition = makeLifecycleComposition(async () => {
    announceInvocation();
    try {
      await heldInvocation;
    } finally {
      announceFinished();
    }
    return { invocationId: 'shutdown-deadline', state: 'completed' };
  }, async () => { closed = true; }, 25, await reserveQuietPort(43700 + ((process.pid % 8) * 12)));
  const baseUrl = await startOnLoopback(composition);
  const responsePromise = fetchRetryingConnect(`${baseUrl}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...shutdownInvocationRequest, invocationId: 'shutdown-deadline' }),
  });
  await invocationStarted;

  const shutdownStartedAt = Date.now();
  await composition.shutdown();
  expect(Date.now() - shutdownStartedAt).toBeLessThan(500);
  expect(closed).toBe(true);
  await expect(responsePromise).rejects.toThrow();

  releaseInvocation();
  await invocationFinished;
});

test('shutdown timeout zero skips the drain for test teardown', async () => {
  let releaseInvocation!: () => void;
  let announceInvocation!: () => void;
  const invocationStarted = new Promise<void>((resolve) => { announceInvocation = resolve; });
  const heldInvocation = new Promise<void>((resolve) => { releaseInvocation = resolve; });
  let closed = false;
  const composition = makeLifecycleComposition(async () => {
    announceInvocation();
    await heldInvocation;
    return { invocationId: 'shutdown-no-wait', state: 'completed' };
  }, async () => { closed = true; }, 30_000, await reserveQuietPort(43800 + ((process.pid % 8) * 12)));
  const baseUrl = await startOnLoopback(composition);
  const responsePromise = fetchRetryingConnect(`${baseUrl}/invocations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ...shutdownInvocationRequest, invocationId: 'shutdown-no-wait' }),
  });
  await invocationStarted;

  const startedAt = Date.now();
  await composition.shutdown({ timeoutMs: 0 });
  expect(Date.now() - startedAt).toBeLessThan(500);
  expect(closed).toBe(true);
  await expect(responsePromise).rejects.toThrow();

  releaseInvocation();
});


/**
 * Windows loopback connect flake guard: on a busy machine the first connect
 * to a just-listened ephemeral port can fail at the OS layer (ETIMEDOUT /
 * ECONNREFUSED) before the request ever reaches the server. Retry ONLY that
 * connect-establishment shape; once the request arrives, every drain/close
 * assertion below still runs against the real single request.
 */
async function fetchRetryingConnect(url: string, init: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err) {
    const cause = (err as { cause?: { code?: unknown } } | null)?.cause;
    if (cause?.code === 'ETIMEDOUT' || cause?.code === 'ECONNREFUSED') {
      return fetch(url, init);
    }
    throw err;
  }
}
const shutdownInvocationRequest = {
  contractVersion: '1',
  invocationId: 'shutdown-drain',
  grant: 'test-grant',
  operationId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  stepKey: 'extract',
  bindingSlot: 'reasoning',
  input: { prompt: 'offline shutdown fixture' },
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

function makeLifecycleComposition(
  invoke: () => Promise<HttpInvocationResult>,
  close: () => Promise<void>,
  drainTimeoutMs: number,
  port: number,
) {
  return createConnectorComposition({
    port,
    host: '127.0.0.1',
    databaseUrl: 'postgres://unused',
    redisUrl: 'redis://unused',
    drainTimeoutMs,
  }, {
    http: {
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
        invoke,
        get: async () => undefined,
        cancel: async (invocationId) => ({ invocationId, state: 'cancelled' }),
      },
      capabilities: () => ({}),
      ready: async () => true,
      allowUnauthenticatedTestTraffic: true,
    },
    close,
  });
}

async function startOnLoopback(composition: ReturnType<typeof makeLifecycleComposition>): Promise<string> {
  await composition.start();
  const address = composition.address();
  if (!address || typeof address === 'string') throw new Error('Connector test server did not bind.');
  return `http://127.0.0.1:${address.port}`;
}
