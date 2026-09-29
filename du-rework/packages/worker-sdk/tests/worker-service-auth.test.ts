import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  AesCredentialCipher,
  AdapterRegistry,
  ContractSignedGrantVerifier,
  createConnectorComposition,
  DurableConnectorRuntime,
  HmacServiceIdentityVerifier,
  HmacSignedGrantSource,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  jsonHttpAdapter,
  SecretResolver,
  hashInvocationInput,
  type ConnectorConfigRepository,
  type ConnectorRevision,
  type LocalInvocationRequest,
} from '@du/connector';
import type { InvocationGrant } from '@du/contracts';
import { ConnectorTransportError, createConnectorInvoker } from '../src';

const TENANT_A = 'tenant-auth-a';
const CONNECTOR_ID = 'auth-fixture';
const ACCOUNT_ID = 'auth-account';
const grantSecret = randomBytes(32);
let baseUrl = '';

function signToken(
  payload: Record<string, unknown>,
  secret: Uint8Array,
  header: Record<string, unknown> = { alg: 'HS256', typ: 'JWT' },
): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const encodedHeader = encode(header);
  const body = encode(payload);
  const signature = createHmac('sha256', secret).update(`${encodedHeader}.${body}`).digest('base64url');
  return `${encodedHeader}.${body}.${signature}`;
}

async function reserveQuietPort(): Promise<number> {
  const firstCandidate = 43_000 + (process.pid % 300);
  for (let attempt = 0; attempt < 24; attempt += 1) {
    const server = createServer();
    const port = firstCandidate + attempt;
    const listening = await new Promise<boolean>((resolve, reject) => {
      const onError = (error: NodeJS.ErrnoException): void => {
        server.removeListener('listening', onListening);
        if (error.code === 'EADDRINUSE') resolve(false);
        else reject(error);
      };
      const onListening = (): void => {
        server.removeListener('error', onError);
        resolve(true);
      };
      server.once('error', onError);
      server.once('listening', onListening);
      server.listen(port, '127.0.0.1');
    });
    if (!listening) continue;
    const address = server.address() as AddressInfo;
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
    return address.port;
  }
  throw new Error('Could not reserve a quiet loopback port for the Connector auth test.');
}

describe('Worker Connector service identity over real Connector HTTP', () => {
  const identitySecret = randomBytes(32);
  const serviceToken = signToken({
    sub: 'document-core-worker',
    aud: 'connector',
    scopes: ['connector:invoke'],
    exp: Math.floor(Date.now() / 1000) + 300,
  }, identitySecret);
  let providerCalls = 0;
  let composition: ReturnType<typeof createConnectorComposition> | undefined;

  beforeAll(async () => {
    const revision: ConnectorRevision = {
      connectorId: CONNECTOR_ID,
      revision: 1,
      adapter: 'json-http',
      config: { baseUrl: 'https://provider.test', path: '/invoke', timeoutMs: 1_000 },
      credentialRef: 'credential-auth-fixture',
      state: 'ACTIVE',
      credentialSource: {
        kind: 'vault-kv2',
        account: ACCOUNT_ID,
        mount: 'secret',
        path: `du/tenants/${TENANT_A}/connectors/${CONNECTOR_ID}/accounts/${ACCOUNT_ID}`,
        key: 'api-key',
        version: 1,
      },
      tenantId: TENANT_A,
      accountId: ACCOUNT_ID,
    };
    const repository = {
      getRevision: async (connectorId: string, revisionNumber: number, scope?: { tenantId?: string }) =>
        connectorId === revision.connectorId
        && revisionNumber === revision.revision
        && scope?.tenantId === revision.tenantId
          ? revision
          : undefined,
    } as unknown as ConnectorConfigRepository;
    const runtime = new DurableConnectorRuntime(
      new InMemoryInvocationLedger() as never,
      repository,
      new InMemoryQuotaStore(),
      { append: async () => undefined } as never,
      new AdapterRegistry([jsonHttpAdapter]),
      {
        send: async () => {
          providerCalls += 1;
          return { status: 200, body: { content: 'authorized worker invocation' } };
        },
      },
      new AesCredentialCipher(randomBytes(32)),
      new ContractSignedGrantVerifier(new HmacSignedGrantSource(grantSecret)),
      new SecretResolver({ kv2: { readSecret: async () => 'provider-key-for-test' } }),
    );
    const port = await reserveQuietPort();
    composition = createConnectorComposition({
      port,
      host: '127.0.0.1',
      databaseUrl: 'postgres://offline-test-only',
      redisUrl: 'redis://offline-test-only',
      serviceIdentityVerifier: new HmacServiceIdentityVerifier(identitySecret),
    }, {
      http: {
        management: {} as never,
        runtime,
        capabilities: () => ({}),
        ready: async () => true,
        identityVerifier: new HmacServiceIdentityVerifier(identitySecret),
      },
    });
    await composition.start();
    const address = composition.address();
    if (!address || typeof address === 'string') throw new Error('Connector test server did not bind.');
    baseUrl = `http://127.0.0.1:${address.port}`;
  });

  beforeEach(() => {
    providerCalls = 0;
  });

  afterAll(async () => {
    await composition?.shutdown({ timeoutMs: 0 });
  });

  it('sends the signed worker Bearer identity and invokes with a separately signed tenant grant', async () => {
    const result = await invokeWithGrant({ serviceToken });
    expect(result).toMatchObject({ state: 'SUCCEEDED', result: { content: 'authorized worker invocation' } });
    expect(providerCalls).toBe(1);
  });

  it.each([
    ['missing', undefined, 401, 'GRANT_INVALID'],
    ['empty token', '', 401, 'GRANT_INVALID'],
    ['wrong-signature', signToken({
      sub: 'document-core-worker', aud: 'connector', scopes: ['connector:invoke'],
      exp: Math.floor(Date.now() / 1000) + 300,
    }, randomBytes(32)), 401, 'GRANT_INVALID'],
    ['expired', signToken({
      sub: 'document-core-worker', aud: 'connector', scopes: ['connector:invoke'],
      exp: Math.floor(Date.now() / 1000) - 1,
    }, identitySecret), 401, 'GRANT_INVALID'],
    ['expiry boundary', signToken({
      sub: 'document-core-worker', aud: 'connector', scopes: ['connector:invoke'],
      exp: Math.floor(Date.now() / 1000),
    }, identitySecret), 401, 'GRANT_INVALID'],
    ['expired beyond clock drift', signToken({
      sub: 'document-core-worker', aud: 'connector', scopes: ['connector:invoke'],
      exp: Math.floor(Date.now() / 1000) - 300,
    }, identitySecret), 401, 'GRANT_INVALID'],
    ['missing sub claim', signToken({
      aud: 'connector', scopes: ['connector:invoke'], exp: Math.floor(Date.now() / 1000) + 300,
    }, identitySecret), 401, 'GRANT_INVALID'],
    ['missing aud claim', signToken({
      sub: 'document-core-worker', scopes: ['connector:invoke'], exp: Math.floor(Date.now() / 1000) + 300,
    }, identitySecret), 401, 'GRANT_INVALID'],
    ['wrong-audience', signToken({
      sub: 'document-core-worker', aud: 'runtime', scopes: ['connector:invoke'],
      exp: Math.floor(Date.now() / 1000) + 300,
    }, identitySecret), 403, 'BINDING_DENIED'],
    ['missing-scope', signToken({
      sub: 'document-core-worker', aud: 'connector', scopes: [],
      exp: Math.floor(Date.now() / 1000) + 300,
    }, identitySecret), 403, 'BINDING_DENIED'],
  ] as const)('rejects %s service identity before any provider dispatch', async (_label, token, status, code) => {
    const error = await rejection(invokeWithGrant({ serviceToken: token }));
    expect(error).toBeInstanceOf(ConnectorTransportError);
    expect(error).toMatchObject({ status, code });
    expect(providerCalls).toBe(0);
  });

  it('rejects a modified JWT header whose signature no longer matches', async () => {
    const [, payload, signature] = serviceToken.split('.');
    const modifiedHeader = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'tampered' })).toString('base64url');
    const error = await rejection(invokeWithGrant({ serviceToken: `${modifiedHeader}.${payload}.${signature}` }));

    expect(error).toBeInstanceOf(ConnectorTransportError);
    expect(error).toMatchObject({ status: 401, code: 'GRANT_INVALID' });
    expect(providerCalls).toBe(0);
  });

  it('rejects a correctly signed service token with no algorithm header', async () => {
    const token = signToken({
      sub: 'document-core-worker',
      aud: 'connector',
      scopes: ['connector:invoke'],
      exp: Math.floor(Date.now() / 1000) + 300,
    }, identitySecret, { typ: 'JWT' });
    const error = await rejection(invokeWithGrant({ serviceToken: token }));

    expect(error).toBeInstanceOf(ConnectorTransportError);
    expect(error).toMatchObject({ status: 401, code: 'GRANT_INVALID' });
    expect(providerCalls).toBe(0);
  });

  it.each([
    ['missing Bearer prefix', serviceToken],
    ['empty Bearer token', 'Bearer '],
  ])('rejects %s directly at the HMAC service identity verifier', async (_caseName, authorization) => {
    await expect(new HmacServiceIdentityVerifier(identitySecret).verify({ authorization })).rejects.toThrow();
  });

  it('rejects a correctly signed token whose payload is not valid base64 JSON', async () => {
    const header = Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url');
    const payload = '%%%not-base64url%%%';
    const signature = createHmac('sha256', identitySecret).update(`${header}.${payload}`).digest('base64url');
    const token = `${header}.${payload}.${signature}`;

    await expect(
      new HmacServiceIdentityVerifier(identitySecret).verify({ authorization: `Bearer ${token}` })
    ).rejects.toThrow();
  });

  it('checks the invocation grant after service authentication and rejects an invalid signature', async () => {
    const error = await rejection(invokeWithGrant({ serviceToken, grantToken: 'bad.signature.token' }));
    expect(error).toMatchObject({ status: 401, code: 'GRANT_INVALID' });
    expect(providerCalls).toBe(0);
  });

  it('checks the signed grant tenant independently and denies a foreign tenant revision', async () => {
    const error = await rejection(invokeWithGrant({ serviceToken, tenantId: 'tenant-auth-b' }));
    expect(error).toMatchObject({ status: 403, code: 'BINDING_DENIED' });
    expect(providerCalls).toBe(0);
  });

  it('fails closed when a requestId/invocationId is replayed with a different body payload', async () => {
    const invocationId = randomUUID();
    const first = await invokeWithGrant({ serviceToken, invocationId, prompt: 'original request' });
    expect(first).toMatchObject({ state: 'SUCCEEDED' });
    expect(providerCalls).toBe(1);

    const replay = await rejection(invokeWithGrant({ serviceToken, invocationId, prompt: 'changed replay payload' }));
    expect(replay).toBeInstanceOf(ConnectorTransportError);
    expect(replay).toMatchObject({ status: 409, code: 'INPUT_HASH_MISMATCH' });
    expect(providerCalls).toBe(1);
  });
});

async function invokeWithGrant(options: {
  serviceToken?: string;
  tenantId?: string;
  grantToken?: string;
  invocationId?: string;
  prompt?: string;
}) {
  const prompt = options.prompt ?? 'validate worker identity';
  const local: LocalInvocationRequest = {
    contractVersion: '1',
    invocationId: options.invocationId ?? randomUUID(),
    tenantId: options.tenantId ?? TENANT_A,
    operationId: randomUUID(),
    taskId: randomUUID(),
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt },
    deadlineAt: new Date(Date.now() + 60_000).toISOString(),
  };
  const nowSeconds = Math.floor(Date.now() / 1000);
  const grantToken = options.grantToken ?? signToken({
    audience: 'connector',
    tenantId: local.tenantId,
    operationId: local.operationId,
    taskId: local.taskId,
    stepKey: local.stepKey,
    invocationId: local.invocationId,
    inputHash: hashInvocationInput(local),
    connectorId: CONNECTOR_ID,
    connectorRevision: 1,
    bindingSlot: local.bindingSlot,
    exp: nowSeconds + 120,
    iat: nowSeconds,
  }, grantSecret);
  const payload = {
    contractVersion: local.contractVersion,
    invocationId: local.invocationId,
    grant: grantToken,
    operationId: local.operationId,
    taskId: local.taskId,
    stepKey: local.stepKey,
    bindingSlot: local.bindingSlot,
    input: { prompt },
    deadlineAt: local.deadlineAt,
  };
  const expiresAt = new Date((nowSeconds + 120) * 1000).toISOString();
  const workerGrant: InvocationGrant = {
    grant: grantToken,
    invocationId: local.invocationId,
    connectorId: CONNECTOR_ID,
    connectorRevision: 1,
    expiresAt,
    allowedOptions: {},
  };
  return createConnectorInvoker({
    baseUrl,
    ...(options.serviceToken === undefined ? {} : { serviceToken: options.serviceToken }),
  })(workerGrant, payload);
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error('Expected Connector invocation to be rejected.');
}
