import {
  ConnectorError,
  ConnectorLifecycle,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  invokeAdapter,
  jsonHttpAdapter,
  requireServiceIdentity,
  validateGrant,
  type GrantClaims,
  type LocalInvocationRequest,
  type ServiceIdentityVerifier,
} from '../src';
import { createServer } from 'node:http';

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

test('lifecycle drains before closing dependencies and rejects new work through state', async () => {
  const server = createServer();
  let closed = false;
  const lifecycle = new ConnectorLifecycle({
    server,
    closeDependencies: async () => { closed = true; },
    drainTimeoutMs: 100,
  });
  await lifecycle.start(0, '127.0.0.1');
  expect(lifecycle.isAccepting()).toBe(true);
  await lifecycle.shutdown();
  expect(lifecycle.isAccepting()).toBe(false);
  expect(closed).toBe(true);
});

void ConnectorError;
