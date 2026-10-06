import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  AesCredentialCipher,
  ContractSignedGrantVerifier,
  DurableConnectorRuntime,
  FetchProviderTransport,
  HmacSignedGrantSource,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  createConnectorServer,
  hashInvocationInput,
  invokeAdapter,
  jsonHttpAdapter,
  type ConnectorHttpDependencies,
  type ProviderRequest,
  type ProviderResponse,
} from '../src';
import { listenLoopback } from '../../../tests/harness/listen-loopback';

/**
 * CR06-04 (acceptance: "test async-202 mang sessionRef end-to-end (mock
 * provider) + resume giữ session; không blind retry") — offline only:
 * in-memory ledger/quota, loopback provider in a dedicated quiet band, NO
 * PostgreSQL/Redis/live provider.
 *
 * Contract decision exercised here (recorded in docs/08):
 *  - a provider MAY return `sessionRef` in the async 202 accept body;
 *  - the connector persists it on the pending record (never inferred),
 *    returns it on every PENDING response, replays it to the provider on the
 *    due poll, and keeps it as the invocation's session when the final
 *    provider response omits one;
 *  - the canonical hash / stable invocationId / Idempotency-Key are unchanged
 *    by the session: the resume is a replay, never a blind second execution.
 */

jest.setTimeout(25_000);

const PID_OFFSET = (process.pid % 8) * 8;
let providerSeq = 0;
let connectorSeq = 0;
const providerPortSeed = (): number => 44100 + PID_OFFSET + providerSeq++ * 4;
const connectorPortSeed = (): number => 44400 + PID_OFFSET + connectorSeq++ * 3;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* ---------------------------------------------------------------------- */
/* invokeAdapter-level: pending record -> pending reply -> due poll        */
/* ---------------------------------------------------------------------- */

function scriptedTransport(
  script: Array<(request: ProviderRequest, body: Record<string, unknown> | undefined) => ProviderResponse>,
): { calls: ProviderRequest[]; send: (request: ProviderRequest) => Promise<ProviderResponse> } {
  const calls: ProviderRequest[] = [];
  return {
    calls,
    send: async (request: ProviderRequest) => {
      calls.push(request);
      const body = typeof request.body === 'string'
        ? (JSON.parse(request.body) as Record<string, unknown>)
        : undefined;
      const reply = script[Math.min(calls.length - 1, script.length - 1)]!;
      return reply(request, body);
    },
  };
}

function localRequest(invocationId: string, deadlineAt: string) {
  return {
    contractVersion: '1' as const,
    invocationId,
    tenantId: 'tenant-a',
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt: 'continue the async session' },
    options: {},
    sessionRef: null,
    deadlineAt,
  };
}

describe('CR06-04 invokeAdapter — async 202 sessionRef custody', () => {
  test('202 sessionRef -> pending record -> pending replay -> due poll -> completed result', async () => {
    let now = Date.parse('2026-10-06T00:00:00.000Z');
    const ledger = new InMemoryInvocationLedger();
    const quota = new InMemoryQuotaStore();
    const request = localRequest('cr06-04-inv-a', new Date(now + 3_600_000).toISOString());
    const transport = scriptedTransport([
      () => ({
        status: 202,
        body: {
          state: 'pending',
          nextPollAt: new Date(now + 60_000).toISOString(),
          providerRequestId: 'pr-a',
          sessionRef: 'sess-async-a',
        },
      }),
      // The provider's final body deliberately omits sessionRef: the stored
      // pending session must survive the completion.
      () => ({ status: 200, body: { content: 'a-done', providerRequestId: 'pr-a' } }),
    ]);
    const options = {
      ledger,
      quota,
      adapter: jsonHttpAdapter,
      config: {
        baseUrl: 'https://provider.example',
        path: '/infer',
        timeoutMs: 5000,
        asyncPollingMode: 'idempotency-key-replay' as const,
      },
      transport,
      quotaKey: 'cred-1',
      now: () => now,
      random: () => 0,
    };

    const first = await invokeAdapter(request, options);
    expect(first).toMatchObject({ state: 'pending', sessionRef: 'sess-async-a', providerRequestId: 'pr-a' });
    const accepted = await ledger.get(request.invocationId);
    expect(accepted?.sessionRef).toBe('sess-async-a');
    // First dispatch sends the request's own (null) session, never the future token.
    expect(JSON.parse(String(transport.calls[0]!.body)).sessionRef).toBeNull();
    expect(transport.calls).toHaveLength(1);

    // Resume before due: no provider dispatch, stored session returned.
    now += 1_000;
    const early = await invokeAdapter(request, options);
    expect(early).toMatchObject({ state: 'pending', sessionRef: 'sess-async-a' });
    expect(transport.calls).toHaveLength(1);

    // Due poll: the connector re-attaches the stored session to the provider
    // under the SAME Idempotency-Key, and the result keeps it.
    now = Date.parse(accepted!.nextPollAt!);
    const completed = await invokeAdapter(request, options);
    expect(completed.state).toBe('completed');
    if (completed.state !== 'completed') return;
    expect(completed.result.content).toBe('a-done');
    expect(completed.result.sessionRef).toBe('sess-async-a');
    expect(transport.calls).toHaveLength(2);
    expect(JSON.parse(String(transport.calls[1]!.body)).sessionRef).toBe('sess-async-a');
    expect(transport.calls[0]!.headers['Idempotency-Key']).toBe(request.invocationId);
    expect(transport.calls[1]!.headers['Idempotency-Key']).toBe(request.invocationId);
  });

  test('a missing/null 202 sessionRef keeps the wire session-less (pre-CR06-04 shape)', async () => {
    const now = Date.parse('2026-10-06T00:00:00.000Z');
    const ledger = new InMemoryInvocationLedger();
    const request = localRequest('cr06-04-inv-b', new Date(now + 3_600_000).toISOString());
    const transport = scriptedTransport([
      () => ({ status: 202, body: { nextPollAt: new Date(now + 60_000).toISOString(), sessionRef: null } }),
    ]);
    const outcome = await invokeAdapter(request, {
      ledger,
      quota: new InMemoryQuotaStore(),
      adapter: jsonHttpAdapter,
      config: {
        baseUrl: 'https://provider.example',
        path: '/infer',
        timeoutMs: 5000,
        asyncPollingMode: 'idempotency-key-replay' as const,
      },
      transport,
      quotaKey: 'cred-1',
      now: () => now,
      random: () => 0,
    });
    expect(outcome).toMatchObject({ state: 'pending' });
    if (outcome.state !== 'pending') return;
    expect(outcome.sessionRef).toBeUndefined();
    expect((await ledger.get(request.invocationId))?.sessionRef).toBeUndefined();
  });

  test.each([42, '', ['sess'], {}])('a malformed 202 sessionRef fails closed (%p)', async (bad) => {
    const now = Date.parse('2026-10-06T00:00:00.000Z');
    const ledger = new InMemoryInvocationLedger();
    const request = localRequest('cr06-04-inv-bad', new Date(now + 3_600_000).toISOString());
    const transport = scriptedTransport([
      () => ({ status: 202, body: { nextPollAt: new Date(now + 60_000).toISOString(), sessionRef: bad } }),
    ]);
    await expect(
      invokeAdapter(request, {
        ledger,
        quota: new InMemoryQuotaStore(),
        adapter: jsonHttpAdapter,
        config: {
          baseUrl: 'https://provider.example',
          path: '/infer',
          timeoutMs: 5000,
          asyncPollingMode: 'idempotency-key-replay' as const,
        },
        transport,
        quotaKey: 'cred-1',
        now: () => now,
        random: () => 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_PROVIDER_RESPONSE' });
    const record = await ledger.get(request.invocationId);
    expect(record?.state).toBe('FAILED');
    expect(record?.errorCode).toBe('INVALID_PROVIDER_RESPONSE');
  });
});

/* ---------------------------------------------------------------------- */
/* HTTP boundary e2e: real connector server + loopback mock provider       */
/* ---------------------------------------------------------------------- */

interface ProviderReply {
  status: number;
  body?: unknown;
}

interface ScriptedProvider {
  base: string;
  calls: () => number;
  bodies: () => Array<Record<string, unknown>>;
  idempotencyKeys: () => string[];
  close: () => Promise<void>;
}

async function startProvider(replies: ProviderReply[]): Promise<ScriptedProvider> {
  let calls = 0;
  const bodies: Array<Record<string, unknown>> = [];
  const keys: string[] = [];
  const server: Server = createServer((request: IncomingMessage, response: ServerResponse) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      calls += 1;
      const raw = Buffer.concat(chunks).toString('utf8');
      bodies.push(raw.length > 0 ? (JSON.parse(raw) as Record<string, unknown>) : {});
      const key = request.headers['idempotency-key'];
      keys.push(Array.isArray(key) ? (key[0] ?? '') : (key ?? ''));
      const reply = replies[Math.min(calls - 1, replies.length - 1)]!;
      if (response.writableEnded || response.destroyed) return;
      response.setHeader('content-type', 'application/json');
      response.statusCode = reply.status;
      response.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
    });
  });
  const port = await listenLoopback(server, providerPortSeed(), 8);
  return {
    base: `http://127.0.0.1:${port}`,
    calls: () => calls,
    bodies: () => bodies.slice(),
    idempotencyKeys: () => keys.slice(),
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    },
  };
}

async function stopServer(server: Server): Promise<void> {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
}

const TENANT_ID = 'tenant-a';
const CONNECTOR_ID = 'mock-async';
const OPERATION_ID = randomUUID();
const TASK_ID = randomUUID();
const DEADLINE = '2099-01-01T00:00:00.000Z';
const grantSecret = randomBytes(32);
const grantVerifier = new ContractSignedGrantVerifier(new HmacSignedGrantSource(grantSecret));
const encryptionKey = new Uint8Array(32).fill(23);

function signToken(payload: Record<string, unknown>, secret: Uint8Array): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const signature = createHmac('sha256', secret).update(`${header}.${body}`).digest('base64url');
  return `${header}.${body}.${signature}`;
}

function requestFields(invocationId: string): Record<string, unknown> {
  return {
    contractVersion: '1',
    invocationId,
    operationId: OPERATION_ID,
    taskId: TASK_ID,
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt: 'async session e2e' },
    options: {},
    sessionRef: null,
    deadlineAt: DEADLINE,
  };
}

function makeGrant(invocationId: string): { body: Record<string, unknown>; grant: string } {
  const fields = requestFields(invocationId);
  const local = { ...fields, tenantId: TENANT_ID } as unknown as Parameters<typeof hashInvocationInput>[0];
  const nowSec = Math.floor(Date.now() / 1000);
  const grant = signToken({
    audience: 'connector',
    tenantId: TENANT_ID,
    operationId: OPERATION_ID,
    taskId: TASK_ID,
    stepKey: 'extract',
    invocationId,
    inputHash: hashInvocationInput(local),
    connectorId: CONNECTOR_ID,
    connectorRevision: 1,
    bindingSlot: 'reasoning',
    exp: nowSec + 300,
    iat: nowSec,
  }, grantSecret);
  return { body: { ...fields, grant }, grant };
}

async function startBoundary(providerBase: string): Promise<{ server: Server; base: string }> {
  const revision = {
    connectorId: CONNECTOR_ID,
    revision: 1,
    adapter: 'json-http',
    state: 'ACTIVE',
    credentialRef: `${CONNECTOR_ID}:credential`,
    config: {
      baseUrl: providerBase,
      path: '/infer',
      timeoutMs: 2000,
      asyncPollingMode: 'idempotency-key-replay',
    },
    credentialSource: { kind: 'legacy-db', credentialRef: `${CONNECTOR_ID}:credential` },
    tenantId: '',
  };
  const repository = {
    getRevision: async () => revision,
    getActiveCredential: async () => new AesCredentialCipher(encryptionKey).encrypt('sk-offline-cr06-04'),
  } as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[1];
  const runtime = new DurableConnectorRuntime(
    new InMemoryInvocationLedger() as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[0],
    repository,
    new InMemoryQuotaStore() as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[2],
    { append: async () => undefined } as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[3],
    {
      get: (name: string) => {
        if (name !== 'json-http') throw new Error(`unexpected adapter ${name}`);
        return jsonHttpAdapter;
      },
    } as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[4],
    new FetchProviderTransport({ allowHosts: ['127.0.0.1'] }),
    new AesCredentialCipher(encryptionKey),
    grantVerifier,
  );
  const management: ConnectorHttpDependencies['management'] = {
    list: async () => [],
    get: async () => undefined,
    getRevision: async () => undefined,
    getCurrentRevision: async () => undefined,
    createRevision: async () => { throw new Error('management unused'); },
    createPendingRevision: async () => { throw new Error('management unused'); },
    bootstrapRevision: async () => { throw new Error('management unused'); },
    activateRevision: async () => false,
    retireRevision: async () => undefined,
    rotateCredential: async () => undefined,
    disable: async () => undefined,
    test: async () => ({ ok: true }),
  };
  const server = createConnectorServer({
    management,
    runtime,
    capabilities: () => ({ adapters: ['json-http'] }),
    ready: async () => true,
    allowUnauthenticatedTestTraffic: true,
  });
  const port = await listenLoopback(server, connectorPortSeed(), 8);
  return { server, base: `http://127.0.0.1:${port}` };
}

async function postJson(url: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

describe('CR06-04 connector HTTP boundary — async 202 sessionRef e2e', () => {
  test('the pending accept session survives the yield, the pre-due resume, and the polled completion', async () => {
    const provider = await startProvider([
      {
        status: 202,
        body: {
          nextPollAt: new Date(Date.now() + 1_500).toISOString(),
          providerRequestId: 'pr-e2e',
          sessionRef: 'sess-e2e-1',
        },
      },
      // Final body omits sessionRef on purpose: the stored pending session
      // must be kept by the connector.
      { status: 200, body: { content: 'e2e-done', providerRequestId: 'pr-e2e' } },
    ]);
    const boundary = await startBoundary(provider.base);
    const invocationId = `cr06-04-e2e-${randomUUID()}`;
    const sign = makeGrant(invocationId);
    try {
      // 1. First delivery: 202 accept carries the provider session.
      const accepted = await postJson(`${boundary.base}/invocations`, sign.body);
      expect(accepted.status).toBe(202);
      expect(accepted.body.state).toBe('PENDING');
      expect(accepted.body.sessionRef).toBe('sess-e2e-1');
      expect(provider.calls()).toBe(1);
      expect(provider.bodies()[0]!.sessionRef).toBeNull();
      expect(provider.idempotencyKeys()[0]).toBe(invocationId);

      // Pending GET exposes the same session.
      const read = await fetch(`${boundary.base}/invocations/${invocationId}`, {
        headers: { 'x-invocation-grant': sign.grant },
      });
      expect(read.status).toBe(200);
      expect((await read.json() as Record<string, unknown>).sessionRef).toBe('sess-e2e-1');

      // 2. Resume BEFORE due: no provider dispatch (never a blind retry), the
      //    connector returns the stored session.
      const early = await postJson(`${boundary.base}/invocations`, sign.body);
      expect(early.status).toBe(202);
      expect(early.body.sessionRef).toBe('sess-e2e-1');
      expect(provider.calls()).toBe(1);

      // 3. Resume AFTER due: same Idempotency-Key, stored session replayed,
      //    completion keeps it even though the provider body omitted it.
      const untilDue = Math.max(0, Date.parse(String(accepted.body.nextPollAt)) - Date.now() + 80);
      await sleep(untilDue);
      const completed = await postJson(`${boundary.base}/invocations`, sign.body);
      expect(completed.status).toBe(200);
      expect(completed.body.state).toBe('SUCCEEDED');
      expect(completed.body.sessionRef).toBe('sess-e2e-1');
      expect((completed.body.result as Record<string, unknown>).sessionRef).toBe('sess-e2e-1');
      expect((completed.body.result as Record<string, unknown>).content).toBe('e2e-done');
      expect(provider.calls()).toBe(2);
      expect(provider.idempotencyKeys()[0]).toBe(invocationId);
      expect(provider.idempotencyKeys()[1]).toBe(invocationId);
      expect(provider.bodies()[1]!.sessionRef).toBe('sess-e2e-1');
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });
});
