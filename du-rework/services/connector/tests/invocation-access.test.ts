import {
  ConnectorError,
  DurableConnectorRuntime,
  hashInvocationInput,
  type GrantClaims,
  type InvocationRecord,
  type LocalInvocationRequest,
} from '../src';

const request: LocalInvocationRequest = {
  contractVersion: '1',
  invocationId: 'invocation-access-1',
  tenantId: 'tenant-a',
  operationId: '11111111-1111-4111-8111-111111111111',
  taskId: '22222222-2222-4222-8222-222222222222',
  stepKey: 'extract',
  bindingSlot: 'reasoning',
  input: { text: 'private tenant result' },
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

const inputHash = hashInvocationInput(request);
const record: InvocationRecord = {
  request,
  inputHash,
  state: 'SUCCEEDED',
  result: { content: 'tenant A result' },
  updatedAt: new Date().toISOString(),
};

const tenantAGrant: GrantClaims = {
  audience: 'connector',
  tenantId: request.tenantId,
  operationId: request.operationId,
  taskId: request.taskId,
  stepKey: request.stepKey,
  invocationId: request.invocationId,
  inputHash,
  connectorRevision: 'connector-a:1',
  expiresAt: '2099-01-01T00:00:00.000Z',
};

function runtimeFor(grant: GrantClaims): DurableConnectorRuntime {
  const ledger = {
    get: async () => record,
    cancel: async () => ({ ...record, state: 'CANCELLED' as const, errorCode: 'CANCELLED' as const }),
  };
  const verifier = { verify: async () => grant };
  return new DurableConnectorRuntime(
    ledger as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    verifier,
  );
}

test('invocation result and cancel require a signed grant bound to the ledger tenant and invocation', async () => {
  const runtime = runtimeFor(tenantAGrant);

  await expect(runtime.get(request.invocationId)).rejects.toMatchObject({ code: 'BINDING_DENIED' });
  await expect(runtime.get(request.invocationId, 'grant-for-tenant-a')).resolves.toMatchObject({
    invocationId: request.invocationId,
    result: { content: 'tenant A result' },
  });
  await expect(runtime.cancel(request.invocationId, 'cancel', 'grant-for-tenant-a')).resolves.toMatchObject({
    state: 'cancelled',
  });

  const tenantBGrant = { ...tenantAGrant, tenantId: 'tenant-b' };
  const tenantBRuntime = runtimeFor(tenantBGrant);
  await expect(tenantBRuntime.get(request.invocationId, 'grant-for-tenant-b')).rejects.toMatchObject({
    code: 'BINDING_DENIED',
  });
  await expect(tenantBRuntime.cancel(request.invocationId, 'cancel', 'grant-for-tenant-b')).rejects.toMatchObject({
    code: 'BINDING_DENIED',
  });
});

test('invalid invocation grants do not expose record contents', async () => {
  const verifier = { verify: async () => { throw new ConnectorError('GRANT_INVALID', 'bad token'); } };
  const ledger = { get: async () => record };
  const runtime = new DurableConnectorRuntime(
    ledger as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    verifier,
  );

  await expect(runtime.get(request.invocationId, 'invalid')).rejects.toMatchObject({ code: 'GRANT_INVALID' });
});
