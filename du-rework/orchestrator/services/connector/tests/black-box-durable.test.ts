import { createHmac, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  AesCredentialCipher,
  ContractSignedGrantVerifier,
  HmacServiceIdentityVerifier,
  HmacSignedGrantSource,
  PgSqlClient,
  PostgresInvocationLedger,
  PostgresConnectorConfigRepository,
  createConnectorComposition,
  hashInvocationInput,
  type LocalInvocationRequest,
} from '../src';
import {
  createInvocationFieldCrypto,
  createLocalInvocationKekProvider,
  parseLocalInvocationKekConfig,
} from '../src/db/invocation-crypto';

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
  const providerCallsByInvocation = new Map<string, number>();
  let providerBlock: { invocationId: string; arrived: () => void; wait: Promise<void> } | undefined;
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

  // SEC-ENC-02: the durable ledger seals request/result/session before SQL.
  // One deterministic key config is shared by the composition and the direct
  // ledger probes so a row written by the service opens in the test process.
  const invocationStorageCrypto = (() => {
    const parsed = parseLocalInvocationKekConfig(JSON.stringify({
      keyRef: 'black-box-invocation-v1',
      activeVersion: 1,
      keys: { '1': randomBytes(32).toString('base64') },
    }))!;
    return {
      fieldCrypto: createInvocationFieldCrypto(createLocalInvocationKekProvider(parsed), parsed.keyRef),
    };
  })();

  const startComposition = async (): Promise<void> => {
    composition = createConnectorComposition({
      port: 0,
      databaseUrl,
      redisUrl,
      serviceIdentityVerifier: new HmacServiceIdentityVerifier(identitySecret),
      grantVerifier: new ContractSignedGrantVerifier(new HmacSignedGrantSource(grantSecret)),
      credentialCipher: new AesCredentialCipher(encryptionKey),
      providerAllowHosts: ['127.0.0.1'],
      invocationStorageCrypto,
    });
    await composition.start();
  };

  const auth = token({
    sub: 'black-box-worker',
    aud: 'connector',
    scopes: ['connector:invoke', 'connector:manage'],
    exp: Math.floor(Date.now() / 1000) + 3_600,
  }, identitySecret);

  const grantFor = (local: LocalInvocationRequest, revision = 1): string => {
    const nowSeconds = Math.floor(Date.now() / 1000);
    return token({
      audience: 'connector',
      tenantId: local.tenantId,
      operationId: local.operationId,
      taskId: local.taskId,
      stepKey: local.stepKey,
      invocationId: local.invocationId,
      inputHash: hashInvocationInput(local),
      connectorId,
      connectorRevision: revision,
      bindingSlot: local.bindingSlot,
      exp: nowSeconds + 300,
      iat: nowSeconds,
    }, grantSecret);
  };

  const serviceBase = (): string => {
    const address = composition.address();
    if (!address || typeof address === 'string') throw new Error('Connector did not bind.');
    return `http://127.0.0.1:${address.port}`;
  };

  const sendInvocation = (local: LocalInvocationRequest, revision = 1): Promise<Response> => {
    const { tenantId: _tenantId, ...wireRequest } = local;
    return fetch(`${serviceBase()}/invocations`, {
      method: 'POST',
      headers: { authorization: `Bearer ${auth}`, 'content-type': 'application/json' },
      body: JSON.stringify({ ...wireRequest, grant: grantFor(local, revision) }),
    });
  };

  beforeAll(async () => {
    provider = createServer((incoming, response) => {
      const chunks: Buffer[] = [];
      incoming.on('data', (chunk: Buffer | string) => {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      });
      incoming.on('end', async () => {
        providerCalls += 1;
        const keyHeader = incoming.headers['idempotency-key'];
        const invocationId = Array.isArray(keyHeader) ? keyHeader[0] ?? 'missing' : keyHeader ?? 'missing';
        const invocationCall = (providerCallsByInvocation.get(invocationId) ?? 0) + 1;
        providerCallsByInvocation.set(invocationId, invocationCall);
        let text = '';
        try {
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { text?: unknown };
          if (typeof body.text === 'string') text = body.text;
        } catch {
          text = '';
        }

        const block = providerBlock;
        if (block?.invocationId === invocationId && invocationCall === 2) {
          block.arrived();
          await block.wait;
        }

        response.setHeader('content-type', 'application/json');
        if ((text === 'crash-window' || text === 'tenant-a-async' || text === 'lease-expiry') && invocationCall === 1) {
          const pollDelayMs = text === 'crash-window' ? 1000 : 60_000;
          response.statusCode = 202;
          response.end(JSON.stringify({
            state: 'pending',
            providerRequestId: `job-${invocationId}`,
            nextPollAt: new Date(Date.now() + pollDelayMs).toISOString(),
          }));
          return;
        }
        response.end(JSON.stringify({
          content: `durable result ${text}`,
          providerRequestId: `provider-${invocationId}-${invocationCall}`,
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
      headers: {
        authorization: `Bearer ${auth}`,
        'x-invocation-grant': grant,
      },
    });
    expect((await persisted.json() as { state: string }).state).toBe('SUCCEEDED');
  });

  test('concurrent durable first claims become replay and never redispatch after restart', async () => {
    const local: LocalInvocationRequest = {
      ...request,
      invocationId: `invocation-first-claim-race-${Date.now()}`,
      tenantId: 'tenant-first-claim-race',
      input: { text: 'first-claim-race' },
    };
    const ledgerDatabase = new PgSqlClient({ connectionString: databaseUrl });
    const ledger = new PostgresInvocationLedger(ledgerDatabase, invocationStorageCrypto);
    try {
      const inputHash = hashInvocationInput(local);
      const claims = await Promise.all([
        ledger.claim(local, inputHash),
        ledger.claim(local, inputHash),
      ]);
      expect(claims.map((claim) => claim.kind).sort()).toEqual(['claimed', 'replay']);

      await composition.shutdown();
      await startComposition();
      const replay = await sendInvocation(local);
      expect(replay.status).toBe(409);
      expect((await replay.json() as { error?: { code?: string } }).error?.code).toBe('INVOCATION_UNKNOWN');
      expect(providerCallsByInvocation.get(local.invocationId) ?? 0).toBe(0);
      expect((await ledger.get(local.invocationId))?.state).toBe('IN_FLIGHT');
    } finally {
      await ledgerDatabase.close();
    }
  }, 15_000);

  test('a durable CANCELLED invocation replay after restart never reaches the provider', async () => {
    const local: LocalInvocationRequest = {
      ...request,
      invocationId: `invocation-cancelled-${Date.now()}`,
      tenantId: 'tenant-cancelled',
      input: { text: 'cancelled-replay' },
    };
    const ledgerDatabase = new PgSqlClient({ connectionString: databaseUrl });
    const ledger = new PostgresInvocationLedger(ledgerDatabase, invocationStorageCrypto);
    try {
      await ledger.claim(local, hashInvocationInput(local));
      await ledger.cancel(local.invocationId);

      await composition.shutdown();
      await startComposition();
      const replay = await sendInvocation(local);
      expect(replay.status).toBe(409);
      expect((await replay.json() as { error?: { code?: string } }).error?.code).toBe('CANCELLED');
      expect(providerCallsByInvocation.get(local.invocationId) ?? 0).toBe(0);
      expect((await ledger.get(local.invocationId))?.state).toBe('CANCELLED');
    } finally {
      await ledgerDatabase.close();
    }
  }, 15_000);

  test('durable quota lease expiry after restart frees the shared cap without redispatch', async () => {
    const deadlineAt = new Date(Date.now() + 6000).toISOString();
    const tenantA: LocalInvocationRequest = {
      ...request,
      invocationId: `invocation-expiring-lease-a-${Date.now()}`,
      tenantId: 'tenant-expiring-lease-a',
      input: { text: 'lease-expiry' },
      deadlineAt,
    };
    const tenantB: LocalInvocationRequest = {
      ...request,
      invocationId: `invocation-expiring-lease-b-${Date.now()}`,
      tenantId: 'tenant-expiring-lease-b',
      input: { text: 'lease-expiry-b' },
    };
    const ledgerDatabase = new PgSqlClient({ connectionString: databaseUrl });
    const ledger = new PostgresInvocationLedger(ledgerDatabase, invocationStorageCrypto);
    try {
      const accepted = await sendInvocation(tenantA);
      expect(accepted.status).toBe(202);
      const pending = await ledger.get(tenantA.invocationId);
      expect(pending?.state).toBe('PENDING');
      expect(pending?.quotaLease?.expiresAt).toBeGreaterThan(Date.now());
      expect(pending?.quotaLease?.key).toBe(credentialRef);
      expect(providerCallsByInvocation.get(tenantA.invocationId)).toBe(1);

      await composition.shutdown();
      await startComposition();
      const blocked = await sendInvocation(tenantB);
      expect(blocked.status).toBe(429);
      expect(providerCallsByInvocation.get(tenantB.invocationId) ?? 0).toBe(0);

      const untilExpiryMs = Math.max(
        0,
        Math.max(Date.parse(deadlineAt), pending!.quotaLease!.expiresAt) - Date.now() + 100,
      );
      await new Promise((resolve) => setTimeout(resolve, untilExpiryMs));

      const tenantBReplay = await sendInvocation(tenantB);
      expect(tenantBReplay.status).toBe(200);
      expect((await tenantBReplay.json() as { state: string }).state).toBe('SUCCEEDED');
      expect(providerCallsByInvocation.get(tenantB.invocationId)).toBe(1);

      const expiredReplay = await sendInvocation(tenantA);
      expect(expiredReplay.status).toBe(504);
      expect((await expiredReplay.json() as { error?: { code?: string } }).error?.code).toBe('PROVIDER_TIMEOUT');
      expect(providerCallsByInvocation.get(tenantA.invocationId)).toBe(1);
      expect((await ledger.get(tenantA.invocationId))?.state).toBe('FAILED');
    } finally {
      await ledgerDatabase.close();
    }
  }, 20_000);

  test('reclaims a claimed due poll after connector restart and fences the stale poller', async () => {
    const local: LocalInvocationRequest = {
      ...request,
      invocationId: `invocation-crash-window-${Date.now()}`,
      tenantId: 'tenant-crash-window',
      input: { text: 'crash-window' },
    };
    const ledgerDatabase = new PgSqlClient({ connectionString: databaseUrl });
    const ledger = new PostgresInvocationLedger(ledgerDatabase, invocationStorageCrypto);
    let releaseProviderPoll = () => {};
    try {
      const accepted = await sendInvocation(local);
      expect(accepted.status).toBe(202);
      expect((await accepted.json() as { state: string }).state).toBe('PENDING');
      expect(providerCallsByInvocation.get(local.invocationId)).toBe(1);

      const pending = await ledger.get(local.invocationId);
      expect(pending?.state).toBe('PENDING');
      expect(pending?.nextPollAt).toBeDefined();
      const untilDueMs = Math.max(0, Date.parse(pending!.nextPollAt!) - Date.now() + 50);
      await new Promise((resolve) => setTimeout(resolve, untilDueMs));

      // Claim through the same PostgreSQL CAS used by Connector, then stop the
      // live service before any poll request reaches the provider.
      const stalePollLease = await ledger.claimPendingPoll(
        local.invocationId,
        pending!.inputHash,
        Date.now(),
        150,
      );
      expect(stalePollLease).toBeDefined();
      await composition.shutdown();
      expect(providerCallsByInvocation.get(local.invocationId)).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 200));
      await startComposition();

      let signalProviderPoll = () => {};
      const providerPollArrived = new Promise<void>((resolve) => { signalProviderPoll = resolve; });
      const providerPollGate = new Promise<void>((resolve) => { releaseProviderPoll = resolve; });
      providerBlock = {
        invocationId: local.invocationId,
        arrived: signalProviderPoll,
        wait: providerPollGate,
      };
      const recoveredResponsePromise = sendInvocation(local);
      await providerPollArrived;
      expect(providerCallsByInvocation.get(local.invocationId)).toBe(2);

      await expect(ledger.complete(
        local.invocationId,
        { content: 'stale poll must not overwrite recovery' },
        stalePollLease!,
      )).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
      expect((await ledger.get(local.invocationId))?.state).toBe('POLLING');

      releaseProviderPoll();
      const recoveredResponse = await recoveredResponsePromise;
      expect(recoveredResponse.status).toBe(200);
      expect((await recoveredResponse.json() as { state: string }).state).toBe('SUCCEEDED');
      const terminal = await ledger.get(local.invocationId);
      expect(terminal?.state).toBe('SUCCEEDED');
      expect(terminal?.result?.content).toBe('durable result crash-window');
      expect(providerCallsByInvocation.get(local.invocationId)).toBe(2);
    } finally {
      releaseProviderPoll();
      providerBlock = undefined;
      await ledgerDatabase.close();
    }
  }, 15_000);

  test('holds a shared credential quota lease across tenant revisions and connector restart', async () => {
    const tenantA: LocalInvocationRequest = {
      ...request,
      invocationId: `invocation-tenant-a-${Date.now()}`,
      tenantId: 'tenant-quota-a',
      input: { text: 'tenant-a-async' },
    };
    const tenantB: LocalInvocationRequest = {
      ...request,
      invocationId: `invocation-tenant-b-${Date.now()}`,
      tenantId: 'tenant-quota-b',
      input: { text: 'tenant-b-sync' },
    };
    const ledgerDatabase = new PgSqlClient({ connectionString: databaseUrl });
    const ledger = new PostgresInvocationLedger(ledgerDatabase, invocationStorageCrypto);
    try {
      const revisions = new PostgresConnectorConfigRepository(ledgerDatabase);
      await revisions.createRevision({
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

      const aAccepted = await sendInvocation(tenantA);
      expect(aAccepted.status).toBe(202);
      expect((await aAccepted.json() as { state: string }).state).toBe('PENDING');
      const aPending = await ledger.get(tenantA.invocationId);
      expect(aPending?.quotaLease).toBeDefined();

      await composition.shutdown();
      await startComposition();
      const bBlocked = await sendInvocation(tenantB, 2);
      expect(bBlocked.status).toBe(429);
      expect((await bBlocked.json() as { error?: { code?: string } }).error?.code).toBe('QUOTA_EXHAUSTED');
      expect(providerCallsByInvocation.get(tenantB.invocationId) ?? 0).toBe(0);
      const bPending = await ledger.get(tenantB.invocationId);
      expect(bPending?.state).toBe('PENDING');
      expect(bPending?.quotaLease).toBeUndefined();

      await ledgerDatabase.query(
        "UPDATE connector_invocations SET next_poll_at = now() - interval '1 second' WHERE invocation_id = $1 AND state = 'PENDING'",
        [tenantA.invocationId],
      );
      const aCompleted = await sendInvocation(tenantA);
      expect(aCompleted.status).toBe(200);
      expect((await aCompleted.json() as { state: string }).state).toBe('SUCCEEDED');
      expect((await ledger.get(tenantA.invocationId))?.quotaLease).toBeUndefined();
      expect(providerCallsByInvocation.get(tenantA.invocationId)).toBe(2);

      await ledgerDatabase.query(
        "UPDATE connector_invocations SET next_poll_at = now() - interval '1 second' WHERE invocation_id = $1 AND state = 'PENDING'",
        [tenantB.invocationId],
      );
      const bCompleted = await sendInvocation(tenantB, 2);
      expect(bCompleted.status).toBe(200);
      expect((await bCompleted.json() as { state: string }).state).toBe('SUCCEEDED');
      expect(providerCallsByInvocation.get(tenantB.invocationId)).toBe(1);
      expect((await ledger.get(tenantB.invocationId))?.state).toBe('SUCCEEDED');
    } finally {
      await ledgerDatabase.close();
    }
  }, 15_000);
});
