import { createHmac, randomBytes } from 'node:crypto';
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
} from '../src';

const enabled = process.env.CONNECTOR_INTEGRATION === '1';
const databaseUrl = process.env.CONNECTOR_DATABASE_URL ?? 'postgres://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const redisUrl = process.env.CONNECTOR_REDIS_URL ?? 'redis://127.0.0.1:6380';

function token(payload: Record<string, unknown>, secret: Uint8Array): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function listen(server: Server): Promise<number> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Provider did not bind.');
    resolve(address.port);
  }));
}

(enabled ? describe : describe.skip)('Connector black-box durable runtime', () => {
  let provider: Server;
  let providerCalls = 0;
  let providerPort: number;
  let database: PgSqlClient;
  let composition: ReturnType<typeof createConnectorComposition>;
  const identitySecret = randomBytes(32);
  const grantSecret = randomBytes(32);
  const encryptionKey = randomBytes(32);
  const connectorId = `black-box-${Date.now()}`;
  const credentialRef = `${connectorId}:credential`;

  const request = {
    contractVersion: '1' as const,
    invocationId: `invocation-${Date.now()}`,
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt: 'hello' },
    options: {},
    deadlineAt: '2099-01-01T00:00:00.000Z',
  };

  const startComposition = async (): Promise<void> => {
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
  };

  const auth = token({ sub: 'black-box-worker', aud: 'connector', scopes: ['connector:invoke', 'connector:manage'] }, identitySecret);

  beforeAll(async () => {
    provider = createServer((_request, response) => {
      providerCalls += 1;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ content: 'durable result', providerRequestId: `provider-${providerCalls}` }));
    });
    providerPort = await listen(provider);
    database = new PgSqlClient({ connectionString: databaseUrl });
    await database.migrate();
    const repository = new PostgresConnectorConfigRepository(database);
    await repository.put(credentialRef, new AesCredentialCipher(encryptionKey).encrypt('provider-secret'));
    await repository.createRevision({
      connectorId,
      adapter: 'json-http',
      config: { baseUrl: `http://127.0.0.1:${providerPort}`, path: '/', timeoutMs: 5000 },
      credentialRef,
      state: 'ACTIVE',
    });
    await database.close();
    await startComposition();
  });

  afterAll(async () => {
    await composition?.shutdown();
    await new Promise<void>((resolve, reject) => provider.close((error) => error ? reject(error) : resolve()));
  });

  test('invokes over HTTP, redacts management output, and replays after restart', async () => {
    const address = composition.address();
    if (!address || typeof address === 'string') throw new Error('Connector did not bind.');
    const base = `http://127.0.0.1:${address.port}`;
    const tenantId = 'tenant-black-box';
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
    const body = JSON.stringify({ ...request, grant });
    const first = await fetch(`${base}/invocations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body,
    });
    expect(first.status).toBe(200);
    expect((await first.json() as { state: string }).state).toBe('SUCCEEDED');
    expect(providerCalls).toBe(1);

    const management = await fetch(`${base}/connectors`, { headers: { authorization: `Bearer ${auth}` } });
    const managementBody = await management.text();
    expect(management.status).toBe(200);
    expect(managementBody).not.toContain('provider-secret');

    await composition.shutdown();
    await startComposition();
    const restartedAddress = composition.address();
    if (!restartedAddress || typeof restartedAddress === 'string') throw new Error('Connector did not rebind.');
    const replay = await fetch(`http://127.0.0.1:${restartedAddress.port}/invocations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body,
    });
    expect(replay.status).toBe(200);
    expect((await replay.json() as { state: string }).state).toBe('SUCCEEDED');
    expect(providerCalls).toBe(1);

    const persisted = await fetch(`http://127.0.0.1:${restartedAddress.port}/invocations/${request.invocationId}`, {
      headers: { authorization: `Bearer ${auth}` },
    });
    expect((await persisted.json() as { state: string }).state).toBe('SUCCEEDED');
  });
});
