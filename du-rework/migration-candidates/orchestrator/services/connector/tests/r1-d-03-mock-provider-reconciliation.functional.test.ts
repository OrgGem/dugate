import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import {
  AesCredentialCipher,
  ContractSignedGrantVerifier,
  DurableConnectorRuntime,
  FetchProviderTransport,
  HmacSignedGrantSource,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  SecretResolver,
  createConnectorServer,
  hashInvocationInput,
  jsonHttpAdapter,
  type ConnectorHttpDependencies,
  type VaultKv2SecretReader,
} from '../src';
import {
  createVaultDevFixture,
  type VaultDevFixture,
  type VaultToken,
} from '../../../packages/contracts/tests/stubs/vault-dev-fixture';
import { listenLoopback } from '../../../tests/harness/listen-loopback';

/**
 * R1-D-03 (cycle 141): mock provider returning 202-pending / retryable
 * errors / outage, driving the RECONCILIATION path through the REAL
 * connector HTTP boundary — createConnectorServer + DurableConnectorRuntime
 * + FetchProviderTransport + idempotency-key-replay against an in-repo mock
 * provider, plus VaultDevFixture outage/deny simulation for the Vault-error
 * cases. Offline only: in-memory ledger/quota, loopback sockets in the
 * quiet bands (cycle-102 convention), NO PostgreSQL/Redis windows.
 *
 * Pins:
 *  - 202 accept -> replay-driven poll convergence under the SAME
 *    Idempotency-Key, provider generating its result exactly once;
 *  - a crash between accept and poll reconciles on a fresh process over the
 *    same durable store (the R1-D-03 replay-reconciliation path);
 *  - retryable provider failures (5xx -> 502, 429 -> 429) end in FAILED and
 *    a FAILED replay never re-dispatches (provider call-count pinned);
 *  - a transport throw mid-dispatch orphans IN_FLIGHT: replay is 409
 *    INVOCATION_UNKNOWN and GET is the 200 UNKNOWN envelope — the boundary
 *    has NO API that resolves UNKNOWN (documented reconciliation GAP);
 *  - connection-refused outage -> 502 PROVIDER_UNAVAILABLE;
 *  - vault outage/deny fail CLOSED with provider call-count 0, zero legacy
 *    reads (SEC-05), and the account-binding guard runs before any Vault
 *    read. The happy-path anchor proves the sentinel really reaches the
 *    provider Bearer slot, so the 0-count pins measure what they claim.
 */

jest.setTimeout(25_000);

// ---------------------------------------------------------------------------
// quiet-band port allocation (cycle-102 lesson: deterministic binds only)
// provider: 423xx..4267x, connector: 428xx..4317x, dead port: 433xx
// ---------------------------------------------------------------------------

const PID_OFFSET = (process.pid % 8) * 48;
let providerSeq = 0;
let connectorSeq = 0;

function providerPortSeed(): number {
  return 42300 + PID_OFFSET + providerSeq++ * 4;
}
function connectorPortSeed(): number {
  return 42800 + PID_OFFSET + connectorSeq++ * 3;
}

// ---------------------------------------------------------------------------
// mock provider: scriptable replies, full request capture, dedupe counters
// ---------------------------------------------------------------------------

interface ProviderReply {
  status: number;
  body?: unknown;
  /** ms before responding; a delayed 200 emulates a hung/slow provider. */
  delayMs?: number;
  /** true -> count a result generation (provider-side idempotent work). */
  generatesResult?: boolean;
}

interface MockProvider {
  base: string;
  calls(): number;
  resultGenerations(): number;
  idempotencyKeys(): string[];
  authorizations(): Array<string | undefined>;
  close(): Promise<void>;
}

async function startProvider(replies: ProviderReply[]): Promise<MockProvider> {
  let calls = 0;
  let results = 0;
  const keys: string[] = [];
  const auths: Array<string | undefined> = [];
  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      calls += 1;
      void chunks;
      const key = request.headers['idempotency-key'];
      keys.push(Array.isArray(key) ? key[0] ?? '' : key ?? '');
      const auth = request.headers['authorization'];
      auths.push(Array.isArray(auth) ? auth[0] : auth);
      const reply = replies[Math.min(calls - 1, replies.length - 1)]!;
      if (reply.generatesResult) results += 1;
      const send = (): void => {
        if (response.writableEnded || response.destroyed) return;
        response.setHeader('content-type', 'application/json');
        response.statusCode = reply.status;
        response.end(reply.body === undefined ? '' : JSON.stringify(reply.body));
      };
      if (reply.delayMs) setTimeout(send, reply.delayMs);
      else send();
    });
  });
  const port = await listenLoopback(server, providerPortSeed(), 6);
  return {
    base: 'http://127.0.0.1:' + port,
    calls: () => calls,
    resultGenerations: () => results,
    idempotencyKeys: () => keys.slice(),
    authorizations: () => auths.slice(),
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

// ---------------------------------------------------------------------------
// grant + request construction (real HMAC contract-grant path)
// ---------------------------------------------------------------------------

const TENANT_ID = 'tenant-a';
const CONNECTOR_ID = 'openai';
const OPERATION_ID = randomUUID();
const TASK_ID = randomUUID();
const DEADLINE = '2099-01-01T00:00:00.000Z';

const grantSecret = randomBytes(32);
const grantVerifier = new ContractSignedGrantVerifier(new HmacSignedGrantSource(grantSecret));

function requestFields(invocationId: string): Record<string, unknown> {
  return {
    contractVersion: '1',
    invocationId,
    operationId: OPERATION_ID,
    taskId: TASK_ID,
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt: 'Extract', text: 'reconciliation fixture' },
    options: {},
    sessionRef: null,
    deadlineAt: DEADLINE,
  };
}

function signToken(payload: Record<string, unknown>, secret: Uint8Array): string {
  const encode = (value: unknown): string => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const body = encode(payload);
  const signature = createHmac('sha256', secret).update(header + '.' + body).digest('base64url');
  return header + '.' + body + '.' + signature;
}

interface GrantBundle {
  body: Record<string, unknown>;
  grant: string;
  invocationId: string;
}

function makeGrant(invocationId: string): GrantBundle {
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
  return { body: { ...fields, grant }, grant, invocationId };
}

// ---------------------------------------------------------------------------
// boundary harness: real runtime + real HTTP server over in-memory durable
// ---------------------------------------------------------------------------

const encryptionKey = new Uint8Array(32).fill(11);

interface BoundaryOptions {
  ledger: InMemoryInvocationLedger;
  providerBase: string;
  revisionConfig?: Record<string, unknown>;
  credentialSource?: Record<string, unknown>;
  cipherBytes?: Uint8Array;
  resolver?: SecretResolver;
}

interface Boundary {
  server: Server;
  base: string;
  activeCredentialCalls: () => number;
}

async function startBoundary(options: BoundaryOptions): Promise<Boundary> {
  let activeCredentialCalls = 0;
  const revision = {
    connectorId: CONNECTOR_ID,
    revision: 1,
    adapter: 'json-http',
    state: 'ACTIVE',
    credentialRef: CONNECTOR_ID + ':credential',
    config: {
      baseUrl: options.providerBase,
      path: '/infer',
      timeoutMs: 2000,
      asyncPollingMode: 'idempotency-key-replay',
      ...(options.revisionConfig ?? {}),
    },
    ...(options.credentialSource ? { credentialSource: options.credentialSource } : {}),
    ...(options.credentialSource?.kind === 'vault-kv2'
      ? { tenantId: 'tenant-a', accountId: 'acct-main' }
      : { tenantId: '' }),
  };
  const repository = {
    getRevision: async () => revision,
    getActiveCredential: async (): Promise<Uint8Array | undefined> => {
      activeCredentialCalls += 1;
      return options.cipherBytes;
    },
  } as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[1];
  const runtime = new DurableConnectorRuntime(
    options.ledger as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[0],
    repository,
    new InMemoryQuotaStore() as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[2],
    { append: async () => undefined } as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[3],
    {
      get: (name: string) => {
        if (name !== 'json-http') throw new Error('unexpected adapter ' + name);
        return jsonHttpAdapter;
      },
    } as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[4],
    new FetchProviderTransport({ allowHosts: ['127.0.0.1'] }),
    new AesCredentialCipher(encryptionKey),
    grantVerifier,
    options.resolver,
  );
  const management: ConnectorHttpDependencies['management'] = {
    list: async () => [],
    get: async () => undefined,
    getRevision: async () => undefined,
    getCurrentRevision: async () => undefined,
    createRevision: async () => {
      throw new Error('management unused in this suite');
    },
    bootstrapRevision: async () => { throw new Error('unused'); },
    createPendingRevision: async () => {
      throw new Error('management unused in this suite');
    },
    activateRevision: async () => false,
    retireRevision: async () => undefined,
    rotateCredential: async () => undefined,
    disable: async () => undefined,
    test: async () => ({ ok: true }),
  };
  const server = createConnectorServer({
    management,
    runtime,
    capabilities: () => ({}),
    ready: async () => true,
  });
  const port = await listenLoopback(server, connectorPortSeed(), 6);
  return { server, base: 'http://127.0.0.1:' + port, activeCredentialCalls: () => activeCredentialCalls };
}

function legacyCredentialSource(): Record<string, unknown> {
  return { kind: 'legacy-db', credentialRef: CONNECTOR_ID + ':credential' };
}

// ---------------------------------------------------------------------------
// HTTP client helpers (real global fetch — this file tests the wire)
// ---------------------------------------------------------------------------

interface Wire {
  status: number;
  body: Record<string, unknown>;
}

async function postJson(url: string, body: unknown): Promise<Wire> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<Wire> {
  const res = await fetch(url, { headers });
  return { status: res.status, body: (await res.json().catch(() => ({}))) as Record<string, unknown> };
}

function legacyCipherBytes(secret: string): Uint8Array {
  return new AesCredentialCipher(encryptionKey).encrypt(secret);
}

// ---------------------------------------------------------------------------
// vault fixture wiring (connector-reader reads, orchestrator-writer seeds)
// ---------------------------------------------------------------------------

const ACC_PATH = 'du/tenants/tenant-a/connectors/openai/accounts/acct-main';
const VAULT_REF: Record<string, unknown> = {
  kind: 'vault-kv2',
  account: 'acct-main',
  mount: 'secret',
  path: ACC_PATH,
  key: 'api-key',
  version: 1,
};

function makeVault(): { fx: VaultDevFixture; reader: VaultKv2SecretReader; readCalls: () => number } {
  const fx = createVaultDevFixture({ scopes: [{ mount: 'secret', pathPrefix: 'du/tenants' }] });
  const token: VaultToken = fx.login('connector-reader');
  let reads = 0;
  return {
    fx,
    readCalls: () => reads,
    reader: {
      readSecret: async (input) => {
        reads += 1;
        const res = await fx.read({
          token,
          mount: input.mount,
          path: input.path,
          key: input.key,
          version: input.version,
        });
        return (res as { value?: unknown }).value;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// suite
// ---------------------------------------------------------------------------

describe('R1-D-03 mock-provider reconciliation at the connector HTTP boundary', () => {
  test('A1: first dispatch 202 -> 202 PENDING wire carries nextPollAt/providerRequestId and the Idempotency-Key is the invocationId', async () => {
    const provider = await startProvider([
      { status: 202, body: { nextPollAt: new Date(Date.now() + 120).toISOString(), providerRequestId: 'pr-a1' } },
    ]);
    const boundary = await startBoundary({
      ledger: new InMemoryInvocationLedger(),
      providerBase: provider.base,
      credentialSource: legacyCredentialSource(),
      cipherBytes: legacyCipherBytes('sk-legacy-A1-sentinel'),
    });
    try {
      const grant = makeGrant('r1d-a1-invoke');
      const hit = await postJson(boundary.base + '/invocations', grant.body);
      expect(hit.status).toBe(202);
      expect(hit.body.state).toBe('PENDING');
      expect(hit.body.invocationId).toBe('r1d-a1-invoke');
      expect(typeof hit.body.nextPollAt).toBe('string');
      expect(hit.body.providerRequestId).toBe('pr-a1');
      expect(provider.calls()).toBe(1);
      expect(provider.idempotencyKeys()).toEqual(['r1d-a1-invoke']);
      // legacy-db decrypt -> applyCredentialSlot bearer -> REAL fetch delivered it
      expect(provider.authorizations()).toEqual(['Bearer sk-legacy-A1-sentinel']);
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });

  test('A2: replay before nextPollAt does not dispatch; due replay drives the poll under the same key to SUCCEEDED', async () => {
    const provider = await startProvider([
      { status: 202, body: { nextPollAt: new Date(Date.now() + 150).toISOString(), providerRequestId: 'pr-a2' } },
      { status: 200, body: { content: 'a2-final', providerRequestId: 'pr-a2' }, generatesResult: true },
    ]);
    const boundary = await startBoundary({
      ledger: new InMemoryInvocationLedger(),
      providerBase: provider.base,
      credentialSource: legacyCredentialSource(),
      cipherBytes: legacyCipherBytes('sk-legacy-A2'),
    });
    try {
      const grant = makeGrant('r1d-a2-invoke');
      const first = await postJson(boundary.base + '/invocations', grant.body);
      expect(first.status).toBe(202);
      const scheduledPollAt = Date.parse(first.body.nextPollAt as string);

      // not due yet -> same PENDING answer, provider stays untouched
      const early = await postJson(boundary.base + '/invocations', grant.body);
      expect(early.status).toBe(202);
      expect(early.body.state).toBe('PENDING');
      expect(early.body.providerRequestId).toBe('pr-a2');
      expect(provider.calls()).toBe(1);

      await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, scheduledPollAt - Date.now()) + 30));
      const due = await postJson(boundary.base + '/invocations', grant.body);
      expect(due.status).toBe(200);
      expect(due.body.state).toBe('SUCCEEDED');
      expect((due.body.result as Record<string, unknown>).content).toBe('a2-final');
      expect(provider.calls()).toBe(2);
      expect(provider.idempotencyKeys()).toEqual(['r1d-a2-invoke', 'r1d-a2-invoke']);
      expect(provider.resultGenerations()).toBe(1);

      // terminal replay is served from the ledger, provider is never touched again
      const replay = await postJson(boundary.base + '/invocations', grant.body);
      expect(replay.status).toBe(200);
      expect(replay.body.state).toBe('SUCCEEDED');
      expect(provider.calls()).toBe(2);

      const view = await getJson(boundary.base + '/invocations/r1d-a2-invoke', { 'x-invocation-grant': grant.grant });
      expect(view.status).toBe(200);
      expect(view.body.state).toBe('SUCCEEDED');
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });

  test('A3: crash between accept and poll — a fresh process over the same durable store reconciles via replay', async () => {
    const ledger = new InMemoryInvocationLedger();
    const provider = await startProvider([
      { status: 202, body: { nextPollAt: new Date(Date.now() + 130).toISOString(), providerRequestId: 'pr-a3' } },
      { status: 200, body: { content: 'a3-reconciled', providerRequestId: 'pr-a3' }, generatesResult: true },
    ]);
    const grant = makeGrant('r1d-a3-invoke');

    // process 1: accepts the invocation, then dies with the record PENDING
    const processOne = await startBoundary({
      ledger,
      providerBase: provider.base,
      credentialSource: legacyCredentialSource(),
      cipherBytes: legacyCipherBytes('sk-legacy-A3'),
    });
    const first = await postJson(processOne.base + '/invocations', grant.body);
    expect(first.status).toBe(202);
    const scheduledPollAt = Date.parse(first.body.nextPollAt as string);
    expect((await ledger.get('r1d-a3-invoke'))?.state).toBe('PENDING');
    await stopServer(processOne.server);

    await new Promise<void>((resolve) => setTimeout(resolve, Math.max(0, scheduledPollAt - Date.now()) + 30));

    // process 2: new server + new runtime over the SAME durable ledger — no memory of the crash
    const processTwo = await startBoundary({
      ledger,
      providerBase: provider.base,
      credentialSource: legacyCredentialSource(),
      cipherBytes: legacyCipherBytes('sk-legacy-A3'),
    });
    try {
      const reconciled = await postJson(processTwo.base + '/invocations', grant.body);
      expect(reconciled.status).toBe(200);
      expect(reconciled.body.state).toBe('SUCCEEDED');
      expect((reconciled.body.result as Record<string, unknown>).content).toBe('a3-reconciled');
      // provider saw the SAME Idempotency-Key twice and produced its result exactly once
      expect(provider.idempotencyKeys()).toEqual(['r1d-a3-invoke', 'r1d-a3-invoke']);
      expect(provider.resultGenerations()).toBe(1);
      expect((await ledger.get('r1d-a3-invoke'))?.state).toBe('SUCCEEDED');
    } finally {
      await stopServer(processTwo.server);
      await provider.close();
    }
  });

  test('B1: provider 503 -> 502 PROVIDER_UNAVAILABLE, ledger FAILED; replay never re-dispatches', async () => {
    const provider = await startProvider([{ status: 503, body: { error: 'overloaded' } }]);
    const ledger = new InMemoryInvocationLedger();
    const boundary = await startBoundary({
      ledger,
      providerBase: provider.base,
      credentialSource: legacyCredentialSource(),
      cipherBytes: legacyCipherBytes('sk-legacy-B1'),
    });
    try {
      const grant = makeGrant('r1d-b1-invoke');
      const first = await postJson(boundary.base + '/invocations', grant.body);
      expect(first.status).toBe(502);
      expect((first.body.error as Record<string, unknown>).code).toBe('PROVIDER_UNAVAILABLE');
      expect(provider.calls()).toBe(1);
      expect((await ledger.get('r1d-b1-invoke'))?.state).toBe('FAILED');

      const replay = await postJson(boundary.base + '/invocations', grant.body);
      expect(replay.status).toBe(502);
      expect((replay.body.error as Record<string, unknown>).code).toBe('PROVIDER_UNAVAILABLE');
      expect(provider.calls()).toBe(1);

      const view = await getJson(boundary.base + '/invocations/r1d-b1-invoke', { 'x-invocation-grant': grant.grant });
      expect(view.status).toBe(200);
      expect(view.body.state).toBe('FAILED');
      expect((view.body.error as Record<string, unknown>).code).toBe('PROVIDER_UNAVAILABLE');
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });

  test('B2: provider 429 -> 429 PROVIDER_RATE_LIMITED on the wire', async () => {
    const provider = await startProvider([{ status: 429, body: { error: 'slow down' } }]);
    const boundary = await startBoundary({
      ledger: new InMemoryInvocationLedger(),
      providerBase: provider.base,
      credentialSource: legacyCredentialSource(),
      cipherBytes: legacyCipherBytes('sk-legacy-B2'),
    });
    try {
      const grant = makeGrant('r1d-b2-invoke');
      const hit = await postJson(boundary.base + '/invocations', grant.body);
      expect(hit.status).toBe(429);
      expect((hit.body.error as Record<string, unknown>).code).toBe('PROVIDER_RATE_LIMITED');
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });

  test('B3: transport throw mid-dispatch orphans IN_FLIGHT — the boundary exposes the UNKNOWN gap and cannot close it', async () => {
    const provider = await startProvider([{ status: 200, body: { content: 'late' }, delayMs: 700 }]);
    const ledger = new InMemoryInvocationLedger();
    const boundary = await startBoundary({
      ledger,
      providerBase: provider.base,
      revisionConfig: { timeoutMs: 150 },
      credentialSource: legacyCredentialSource(),
      cipherBytes: legacyCipherBytes('sk-legacy-B3'),
    });
    try {
      const grant = makeGrant('r1d-b3-invoke');
      const hit = await postJson(boundary.base + '/invocations', grant.body);
      // the abort surfaces as a connector-side send failure and the record stays IN_FLIGHT
      expect(hit.status).toBe(502);
      expect((hit.body.error as Record<string, unknown>).code).toBe('PROVIDER_UNAVAILABLE');
      expect((await ledger.get('r1d-b3-invoke'))?.state).toBe('IN_FLIGHT');

      // GET shows the UNKNOWN envelope (IN_FLIGHT maps to unknown) — never a bare 404
      const view = await getJson(boundary.base + '/invocations/r1d-b3-invoke', { 'x-invocation-grant': grant.grant });
      expect(view.status).toBe(200);
      expect(view.body.state).toBe('UNKNOWN');
      expect((view.body.error as Record<string, unknown>).code).toBe('INVOCATION_UNKNOWN');

      // replay cannot resolve it at the HTTP boundary: IN_FLIGHT must stay ambiguous
      const replay = await postJson(boundary.base + '/invocations', grant.body);
      expect(replay.status).toBe(409);
      expect((replay.body.error as Record<string, unknown>).code).toBe('INVOCATION_UNKNOWN');
      expect(provider.calls()).toBe(1);
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });

  test('B4: connection-refused outage -> 502 PROVIDER_UNAVAILABLE with the record left IN_FLIGHT', async () => {
    const dead = createServer();
    const deadPort = await listenLoopback(dead, 43300 + (process.pid % 16), 4);
    await stopServer(dead);
    const ledger = new InMemoryInvocationLedger();
    const boundary = await startBoundary({
      ledger,
      providerBase: 'http://127.0.0.1:' + deadPort,
      credentialSource: legacyCredentialSource(),
      cipherBytes: legacyCipherBytes('sk-legacy-B4'),
    });
    try {
      const grant = makeGrant('r1d-b4-invoke');
      const hit = await postJson(boundary.base + '/invocations', grant.body);
      expect(hit.status).toBe(502);
      expect((hit.body.error as Record<string, unknown>).code).toBe('PROVIDER_UNAVAILABLE');
      expect((await ledger.get('r1d-b4-invoke'))?.state).toBe('IN_FLIGHT');
    } finally {
      await stopServer(boundary.server);
    }
  });

  test('C1: vault outage -> 502 PROVIDER_UNAVAILABLE after bounded retries, provider call-count 0', async () => {
    const provider = await startProvider([{ status: 200, body: { content: 'never' } }]);
    const { fx, reader, readCalls } = makeVault();
    fx.setOutage('unavailable');
    const resolver = new SecretResolver({ kv2: reader, retry: { maxAttempts: 2, baseDelayMs: 1 } });
    const boundary = await startBoundary({
      ledger: new InMemoryInvocationLedger(),
      providerBase: provider.base,
      credentialSource: VAULT_REF,
      resolver,
    });
    try {
      const grant = makeGrant('r1d-c1-invoke');
      const hit = await postJson(boundary.base + '/invocations', grant.body);
      expect(hit.status).toBe(502);
      expect((hit.body.error as Record<string, unknown>).code).toBe('PROVIDER_UNAVAILABLE');
      expect(readCalls()).toBe(2); // bounded retry — not infinite hammering
      expect(provider.calls()).toBe(0); // SEC-05: no provider dispatch on Vault failure
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });

  test('C2: vault deny (missing secret) -> 401 CREDENTIAL_INVALID with provider count 0 and ZERO legacy fallback reads', async () => {
    const provider = await startProvider([{ status: 200, body: { content: 'never' } }]);
    const { reader, readCalls } = makeVault();
    // nothing was ever written at the pinned path -> SECRET_NOT_FOUND (404, non-retryable)
    const resolver = new SecretResolver({ kv2: reader, retry: { maxAttempts: 2, baseDelayMs: 1 } });
    // an ACTIVE legacy credential exists in the store — falling back to it would be the SEC-05 bug
    const boundary = await startBoundary({
      ledger: new InMemoryInvocationLedger(),
      providerBase: provider.base,
      credentialSource: VAULT_REF,
      cipherBytes: legacyCipherBytes('sk-legacy-must-not-be-used'),
      resolver,
    });
    try {
      const grant = makeGrant('r1d-c2-invoke');
      const hit = await postJson(boundary.base + '/invocations', grant.body);
      expect(hit.status).toBe(401);
      expect((hit.body.error as Record<string, unknown>).code).toBe('CREDENTIAL_INVALID');
      expect(readCalls()).toBe(1); // non-retryable -> exactly one attempt
      expect(provider.calls()).toBe(0);
      expect(boundary.activeCredentialCalls()).toBe(0); // no silent legacy read
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });

  test('C3: vault account-path tenant mismatch -> 403 BINDING_DENIED before any Vault read or provider call', async () => {
    const provider = await startProvider([{ status: 200, body: { content: 'never' } }]);
    const { reader, readCalls } = makeVault();
    const resolver = new SecretResolver({ kv2: reader, retry: { maxAttempts: 2, baseDelayMs: 1 } });
    // ref is bound to tenant-b while the grant authenticates tenant-a
    const mismatched = { ...VAULT_REF, path: 'du/tenants/tenant-b/connectors/openai/accounts/acct-main' };
    const boundary = await startBoundary({
      ledger: new InMemoryInvocationLedger(),
      providerBase: provider.base,
      credentialSource: mismatched,
      resolver,
    });
    try {
      const grant = makeGrant('r1d-c3-invoke');
      const hit = await postJson(boundary.base + '/invocations', grant.body);
      expect(hit.status).toBe(403);
      expect((hit.body.error as Record<string, unknown>).code).toBe('BINDING_DENIED');
      expect(readCalls()).toBe(0);
      expect(provider.calls()).toBe(0);
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });

  test('C4: vault happy-path anchor — the resolved sentinel really reaches the provider Bearer slot', async () => {
    const SENTINEL = 'sk-vault-' + randomUUID().replace(/-/g, '');
    const provider = await startProvider([{ status: 200, body: { content: 'c4-ok' } }]);
    const { fx, reader, readCalls } = makeVault();
    const writer = fx.login('orchestrator-writer');
    await fx.write({ token: writer, mount: 'secret', path: ACC_PATH, key: 'api-key', value: SENTINEL });
    const resolver = new SecretResolver({ kv2: reader, retry: { maxAttempts: 2, baseDelayMs: 1 } });
    const boundary = await startBoundary({
      ledger: new InMemoryInvocationLedger(),
      providerBase: provider.base,
      credentialSource: VAULT_REF,
      resolver,
    });
    try {
      const grant = makeGrant('r1d-c4-invoke');
      const hit = await postJson(boundary.base + '/invocations', grant.body);
      expect(hit.status).toBe(200);
      expect(hit.body.state).toBe('SUCCEEDED');
      expect(readCalls()).toBe(1);
      expect(provider.calls()).toBe(1);
      expect(provider.authorizations()).toEqual(['Bearer ' + SENTINEL]);
    } finally {
      await stopServer(boundary.server);
      await provider.close();
    }
  });
});
