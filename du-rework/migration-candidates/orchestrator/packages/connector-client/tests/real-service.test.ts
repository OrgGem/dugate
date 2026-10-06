import { createHmac, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  AesCredentialCipher,
  ContractSignedGrantVerifier,
  HmacServiceIdentityVerifier,
  HmacSignedGrantSource,
  PgSqlClient,
  PostgresConnectorConfigRepository,
  createConnectorComposition,
  hashInvocationInput,
  type LocalInvocationRequest,
} from '@du/connector';
import { ConnectorClient } from '../src/client';
import { createHttpTransport } from '../src/transport';

const enabled = process.env.CONNECTOR_INTEGRATION === '1';
const databaseUrl = process.env.CONNECTOR_DATABASE_URL ?? 'postgres://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const redisUrl = process.env.CONNECTOR_REDIS_URL ?? 'redis://127.0.0.1:6380';

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Server did not bind.');
    resolve(address.port);
  }));
}

(enabled ? describe : describe.skip)('Connector client against real service (P3-07)', () => {
  let provider: Server;
  let providerPort: number;
  let providerCalls = 0;
  let composition: ReturnType<typeof createConnectorComposition>;
  let database: PgSqlClient;
  const identitySecret = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');
  const grantSecret = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');
  const encryptionKey = Buffer.from(randomUUID().replaceAll('-', ''), 'utf8');
  const connectorId = `client-proof-${Date.now()}`;
  const credentialRef = `${connectorId}:credential`;

  const invocationId = `invocation-${Date.now()}`;
  const request = {
    contractVersion: '1' as const,
    invocationId,
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'summarize',
    bindingSlot: 'reasoning',
    input: { text: 'client against real service' },
    options: {},
    deadlineAt: '2099-01-01T00:00:00.000Z',
  };

  const token = (payload: Record<string, unknown>, secret: Uint8Array): string => {
    const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
    const header = encode({ alg: 'HS256', typ: 'JWT' });
    const body = encode(payload);
    const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
    return `${header}.${body}.${signature}`;
  };

  beforeAll(async () => {
    provider = createServer((request, response) => {
      let data = '';
      request.on('data', (chunk) => { data += chunk; });
      request.on('end', () => {
        providerCalls += 1;
        response.setHeader('content-type', 'application/json');
        let hold = false;
        try {
          hold = typeof (JSON.parse(data) as { text?: unknown }).text === 'string'
            && ((JSON.parse(data) as { text: string }).text.includes('hold-for-cancel'));
        } catch {
          hold = false;
        }
        if (hold) {
          response.statusCode = 202;
          response.end(JSON.stringify({ state: 'pending', nextPollAt: new Date(Date.now() + 60_000).toISOString() }));
          return;
        }
        response.end(JSON.stringify({
          content: 'client proof result',
          providerRequestId: `provider-${providerCalls}`,
          usage: { inputTokens: 5, outputTokens: 6, costMicrousd: 3, measurement: 'measured' },
        }));
      });
    });
    providerPort = await listen(provider);

    database = new PgSqlClient({ connectionString: databaseUrl });
    await database.migrate();
    const repository = new PostgresConnectorConfigRepository(database);
    await repository.put(credentialRef, new AesCredentialCipher(encryptionKey).encrypt('provider-secret'));
    await repository.createRevision({
      connectorId,
      adapter: 'json-http',
      config: {
        baseUrl: `http://127.0.0.1:${providerPort}`,
        path: '/',
        timeoutMs: 5000,
        asyncPollingMode: 'idempotency-key-replay',
      },
      credentialRef,
      state: 'ACTIVE',
    });
    await database.close();

    composition = createConnectorComposition({
      port: 0,
      databaseUrl,
      redisUrl,
      serviceIdentityVerifier: new HmacServiceIdentityVerifier(identitySecret),
      grantVerifier: new ContractSignedGrantVerifier(new HmacSignedGrantSource(grantSecret)),
      credentialCipher: new AesCredentialCipher(encryptionKey),
      providerAllowHosts: ['127.0.0.1'],
    });
    await composition.start();
  });

  afterAll(async () => {
    await composition?.shutdown().catch(() => undefined);
    await new Promise<void>((resolve, reject) => provider.close((error) => (error ? reject(error) : resolve())));
  });

  test('invoke/poll/wait/cancel behave end-to-end over real HTTP', async () => {
    const address = composition.address();
    if (!address || typeof address === 'string') throw new Error('Connector did not bind.');
    const base = `http://127.0.0.1:${address.port}`;
    const auth = token({
      sub: 'client-proof',
      aud: 'connector',
      scopes: ['connector:invoke', 'connector:manage'],
      exp: Math.floor(Date.now() / 1000) + 3_600,
    }, identitySecret);
    const client = new ConnectorClient(createHttpTransport({ baseUrl: base, token: auth }));

    const tenantId = 'tenant-client-proof';
    const local: LocalInvocationRequest = { ...request, tenantId };
    const grant = token({
      audience: 'connector',
      tenantId,
      operationId: request.operationId,
      taskId: request.taskId,
      stepKey: request.stepKey,
      invocationId: request.invocationId,
      inputHash: hashInvocationInput(local),
      connectorId,
      connectorRevision: 1,
      bindingSlot: request.bindingSlot,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
    }, grantSecret);

    const invoked = await client.invoke({ ...request, grant });
    expect(invoked.invocationId).toBe(invocationId);
    expect(invoked.state).toBe('completed');
    expect(invoked.result).toBeDefined();
    expect(providerCalls).toBe(1);

    // Recreate the public client as a separate process would, and explicitly
    // supply the fresh tenant-bound grant for status/cancel operations.
    const resumedClient = new ConnectorClient(createHttpTransport({ baseUrl: base, token: auth }));
    const polled = await resumedClient.poll(invocationId, { invocationGrant: grant });
    expect(polled.invocationId).toBe(invocationId);
    expect(polled.state).toBe('completed');

    const waited = await resumedClient.wait(invocationId, {
      deadlineAt: request.deadlineAt,
      poll: async () => {},
      invocationGrant: grant,
    });
    expect(waited.state).toBe('completed');

    // A completed invocation is terminal: cancelling it is rejected as INVOCATION_UNKNOWN.
    await expect(resumedClient.cancel(invocationId, 'no longer needed', { invocationGrant: grant }))
      .rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });

    // Cancel a genuinely pending invocation and assert it reaches the cancelled terminal state.
    const pendingInvocationId = `invocation-hold-${Date.now()}`;
    const held: LocalInvocationRequest = { ...local, invocationId: pendingInvocationId, input: { text: 'hold-for-cancel' } };
    const heldGrant = token({
      audience: 'connector',
      tenantId,
      operationId: request.operationId,
      taskId: request.taskId,
      stepKey: request.stepKey,
      invocationId: pendingInvocationId,
      inputHash: hashInvocationInput(held),
      connectorId,
      connectorRevision: 1,
      bindingSlot: request.bindingSlot,
      exp: Math.floor(Date.now() / 1000) + 300,
      iat: Math.floor(Date.now() / 1000),
    }, grantSecret);
    const pending = await client.invoke({ ...request, invocationId: pendingInvocationId, input: { text: 'hold-for-cancel' }, grant: heldGrant });
    expect(pending.state).toBe('pending');
    const cancelled = await resumedClient.cancel(pendingInvocationId, 'no longer needed', {
      invocationGrant: heldGrant,
    });
    expect(cancelled.invocationId).toBe(pendingInvocationId);
    expect(cancelled.state).toBe('cancelled');
  });
});
