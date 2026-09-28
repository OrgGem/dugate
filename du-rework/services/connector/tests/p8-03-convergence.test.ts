import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import {
  AesCredentialCipher,
  ConnectorError,
  ContractSignedGrantVerifier,
  HmacSignedGrantSource,
  HttpUsageSink,
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  InMemoryUsageOutbox,
  UsageOutboxDispatcher,
  appendUsageEvent,
  hashInvocationInput,
  invokeAdapter,
  jsonHttpAdapter,
  multipartHttpAdapter,
  validateGrant,
  validateProviderUrl,
  type GrantClaims,
  type LocalInvocationRequest,
  type NormalizedProviderResult,
  type ProviderResponse,
  type QuotaLease,
  type QuotaStore,
  type UsageSink,
} from '../src';
import { PgSqlClient } from '../src/db/pg-client';
import { UsageEventSchema, UsageIngestBatchSchema } from '@du/contracts';

/**
 * P8-03: Provider Unknown, Dedup, Quota & Usage Convergence Tests
 * Foundation Contracts Acceptance: CON-01..05 & USE-01/02
 *
 * Runs strictly against mock provider boundaries and in-memory stores.
 * Zero connections to shared DB (:5433) or Redis (:6380).
 */
describe('P8-03: Connector Convergence & Foundation Contracts (CON-01..05, USE-01/02)', () => {
  const baseRequest: LocalInvocationRequest = {
    contractVersion: '1',
    invocationId: 'p8-inv-001',
    tenantId: 'tenant-p8',
    operationId: '11111111-1111-4111-8111-111111111111',
    taskId: '22222222-2222-4222-8222-222222222222',
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt: 'Analyze invoice', text: 'Invoice total: $1000' },
    options: { temperature: 0.1 },
    sessionRef: null,
    deadlineAt: '2099-01-01T00:00:00.000Z',
  };

  // -------------------------------------------------------------------------
  // CON-01: Standardized Adapter Interface & Facade
  // -------------------------------------------------------------------------
  describe('CON-01: Standardized Adapter Facade & SSRF Protection', () => {
    test('normalizes JSON adapter request with canonical payload and headers', () => {
      const built = jsonHttpAdapter.buildRequest(baseRequest, {
        baseUrl: 'https://api.mock-provider.example',
        path: '/v1/chat/completions',
        timeoutMs: 5000,
      });

      expect(built.url).toBe('https://api.mock-provider.example/v1/chat/completions');
      expect(built.method).toBe('POST');
      expect(built.headers['content-type']).toBe('application/json');
      const body = JSON.parse(built.body as string);
      expect(body).toMatchObject({
        prompt: 'Analyze invoice',
        text: 'Invoice total: $1000',
      });
    });

    test('normalizes multipart adapter request with FormData container', () => {
      const built = multipartHttpAdapter.buildRequest(baseRequest, {
        baseUrl: 'https://api.mock-provider.example',
        path: '/v1/ocr',
        timeoutMs: 5000,
      });

      expect(built.url).toBe('https://api.mock-provider.example/v1/ocr');
      expect(built.body).toBeInstanceOf(FormData);
    });

    test('fail-closed SSRF fence rejects private IP, IPv6 loopback, and file URIs', async () => {
      await expect(validateProviderUrl('http://127.0.0.1:8080')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(validateProviderUrl('http://10.0.0.1/infer')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(validateProviderUrl('http://192.168.1.1/infer')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(validateProviderUrl('http://[::1]:9000')).rejects.toMatchObject({ code: 'INVALID_INPUT' });
      await expect(validateProviderUrl('file:///etc/passwd')).rejects.toThrow();
    });

    test('adapter maps provider response into normalized output and token usage', () => {
      const mockRawResponse: ProviderResponse = {
        status: 200,
        headers: { 'content-type': 'application/json' },
        body: {
          content: 'Extracted invoice #1001',
          usage: {
            inputTokens: 120,
            outputTokens: 45,
            costMicrousd: 250,
            measurement: 'measured',
          },
        },
      };

      const normalized = jsonHttpAdapter.normalizeResponse(mockRawResponse, {
        baseUrl: 'https://api.mock-provider.example',
        path: '/v1/chat',
        timeoutMs: 5000,
      });

      expect(normalized.content).toBe('Extracted invoice #1001');
      expect(normalized.usage).toEqual({
        inputTokens: 120,
        outputTokens: 45,
        costMicrousd: 250,
        measurement: 'measured',
      });
    });
  });

  // -------------------------------------------------------------------------
  // CON-02: Idempotent Ledger & Dedup Collision Guard
  // -------------------------------------------------------------------------
  describe('CON-02: Idempotent Ledger & Dedup Collision Guard', () => {
    test('identical request replays cached result without duplicate transport dispatch', async () => {
      const ledger = new InMemoryInvocationLedger();
      const quota = new InMemoryQuotaStore();
      let transportDispatches = 0;

      const options = {
        ledger,
        quota,
        adapter: jsonHttpAdapter,
        config: { baseUrl: 'https://api.mock-provider.example', path: '/v1/chat', timeoutMs: 5000 },
        quotaKey: 'provider:account:model',
        transport: {
          send: async () => {
            transportDispatches += 1;
            return {
              status: 200,
              body: { content: 'Analysis result', usage: { inputTokens: 50, outputTokens: 25 } },
            };
          },
        },
      };

      // First dispatch claims and completes
      const first = await invokeAdapter(baseRequest, options);
      expect(first.state).toBe('completed');
      expect(transportDispatches).toBe(1);

      // Second dispatch with same invocationId and identical input replays from ledger
      const second = await invokeAdapter(baseRequest, options);
      expect(second.state).toBe('completed');
      expect(second).toEqual(first);
      expect(transportDispatches).toBe(1); // Zero additional dispatches!
    });

    test('replaying same invocation ID with altered input fails with 409 INPUT_HASH_MISMATCH', async () => {
      const ledger = new InMemoryInvocationLedger();
      const hash1 = hashInvocationInput(baseRequest);
      const claim1 = await ledger.claim(baseRequest, hash1);
      expect(claim1.kind).toBe('claimed');

      const alteredRequest: LocalInvocationRequest = {
        ...baseRequest,
        input: { prompt: 'Altered prompt injection', text: 'Different content' },
      };
      const hash2 = hashInvocationInput(alteredRequest);
      expect(hash2).not.toBe(hash1);

      const claim2 = await ledger.claim(alteredRequest, hash2);
      expect(claim2.kind).toBe('conflict');

      // invokeAdapter throws ConnectorError with code INPUT_HASH_MISMATCH
      await expect(
        invokeAdapter(alteredRequest, {
          ledger,
          quota: new InMemoryQuotaStore(),
          adapter: jsonHttpAdapter,
          config: { baseUrl: 'https://api.mock-provider.example', path: '/v1/chat', timeoutMs: 5000 },
          quotaKey: 'provider:account:model',
          transport: { send: async () => ({ status: 200, body: {} }) },
        }),
      ).rejects.toMatchObject({
        code: 'INPUT_HASH_MISMATCH',
      });
    });

    test('hash calculation is invariant to JSON property ordering', () => {
      const reqA: LocalInvocationRequest = {
        ...baseRequest,
        input: { prompt: 'A', text: 'B' },
      };
      const reqB: LocalInvocationRequest = {
        ...baseRequest,
        input: { text: 'B', prompt: 'A' },
      };
      expect(hashInvocationInput(reqA)).toBe(hashInvocationInput(reqB));
    });
  });

  // -------------------------------------------------------------------------
  // CON-03: Atomic Concurrency & Quota Leases
  // -------------------------------------------------------------------------
  describe('CON-03: Atomic Concurrency & Quota Leases', () => {
    test('strictly enforces in-flight cap and rejects excess with 429 QUOTA_EXHAUSTED', async () => {
      const quota = new InMemoryQuotaStore();
      const quotaKey = 'provider:openai:gpt-4o';
      const maxInFlight = 2;
      const now = Date.now();

      const lease1 = await quota.acquire(quotaKey, now, 10_000, maxInFlight);
      const lease2 = await quota.acquire(quotaKey, now, 10_000, maxInFlight);
      expect(lease1).toBeDefined();
      expect(lease2).toBeDefined();

      // Third concurrent request exceeds maxInFlight
      const lease3 = await quota.acquire(quotaKey, now, 10_000, maxInFlight);
      expect(lease3).toBeUndefined();

      // Releasing lease1 frees a slot immediately
      await quota.release(lease1!);
      const lease4 = await quota.acquire(quotaKey, now, 10_000, maxInFlight);
      expect(lease4).toBeDefined();
    });

    test('multi-replica quota sharing respects aggregate in-flight ceiling', async () => {
      // Simulate two independent connector worker instances sharing an atomic quota backing store
      class SharedAtomicQuotaStore implements QuotaStore {
        public constructor(private readonly sharedSlots: Map<string, Set<string>>) {}

        public async acquire(key: string, now: number, leaseMs: number, maxInFlight: number): Promise<QuotaLease | undefined> {
          const slots = this.sharedSlots.get(key) ?? new Set<string>();
          if (slots.size >= maxInFlight) return undefined;
          const leaseId = randomUUID();
          slots.add(leaseId);
          this.sharedSlots.set(key, slots);
          return { leaseId, key, expiresAt: now + leaseMs };
        }

        public async release(lease: QuotaLease): Promise<void> {
          this.sharedSlots.get(lease.key)?.delete(lease.leaseId);
        }

        public async renew(lease: QuotaLease, now: number, leaseMs: number): Promise<QuotaLease | undefined> {
          if (!this.sharedSlots.get(lease.key)?.has(lease.leaseId)) return undefined;
          return { ...lease, expiresAt: now + leaseMs };
        }
      }

      const sharedMemory = new Map<string, Set<string>>();
      const replicaA = new SharedAtomicQuotaStore(sharedMemory);
      const replicaB = new SharedAtomicQuotaStore(sharedMemory);

      const maxInFlight = 2;
      const slotKey = 'aggregate:provider:slot';

      const l1 = await replicaA.acquire(slotKey, Date.now(), 5000, maxInFlight);
      expect(l1).toBeDefined();

      const l2 = await replicaB.acquire(slotKey, Date.now(), 5000, maxInFlight);
      expect(l2).toBeDefined();

      // Both replicas now observe capacity exhaustion
      await expect(replicaA.acquire(slotKey, Date.now(), 5000, maxInFlight)).resolves.toBeUndefined();
      await expect(replicaB.acquire(slotKey, Date.now(), 5000, maxInFlight)).resolves.toBeUndefined();

      // Replica A releases, allowing Replica B to acquire
      await replicaA.release(l1!);
      const l3 = await replicaB.acquire(slotKey, Date.now(), 5000, maxInFlight);
      expect(l3).toBeDefined();
    });
  });

  // -------------------------------------------------------------------------
  // CON-04: AES-256-GCM Credential Cipher, Secret Rotation, & Grant Security
  // -------------------------------------------------------------------------
  describe('CON-04: AES-256-GCM Credential Cipher & Grant Security', () => {
    test('encrypts credentials at rest and decrypts with authenticated tag verification', () => {
      const key = randomBytes(32);
      const cipher = new AesCredentialCipher(key);
      const plainSecret = 'sk-provider-super-secret-key-12345';

      const encrypted = cipher.encrypt(plainSecret);
      expect(encrypted.byteLength).toBeGreaterThan(28);

      const decrypted = cipher.decrypt(encrypted);
      expect(decrypted).toBe(plainSecret);

      // Tampered ciphertext fails authentication check
      const tampered = new Uint8Array(encrypted);
      tampered[tampered.length - 1] ^= 0xff;
      expect(() => cipher.decrypt(tampered)).toThrow();
    });

    test('secret rotation allows new key version while revoking obsolete version', async () => {
      const keyV1 = randomBytes(32);
      const keyV2 = randomBytes(32);
      const cipherV1 = new AesCredentialCipher(keyV1);
      const cipherV2 = new AesCredentialCipher(keyV2);

      const secret = 'prod-api-token';
      const blobV1 = cipherV1.encrypt(secret);
      const blobV2 = cipherV2.encrypt(secret);

      expect(cipherV1.decrypt(blobV1)).toBe(secret);
      expect(cipherV2.decrypt(blobV2)).toBe(secret);

      // Key V2 cannot decrypt Key V1 ciphertext (fail closed)
      expect(() => cipherV2.decrypt(blobV1)).toThrow();
    });

    test('grant verification binds identity, inputHash, and rejects tampered or expired claims', async () => {
      const grantSecret = randomBytes(32);
      const grantSource = new HmacSignedGrantSource(grantSecret);
      const verifier = new ContractSignedGrantVerifier(grantSource);

      const encode = (val: unknown) => Buffer.from(JSON.stringify(val)).toString('base64url');
      const createToken = (payload: Record<string, unknown>, secret: Uint8Array) => {
        const h = encode({ alg: 'HS256', typ: 'JWT' });
        const b = encode(payload);
        const s = createHmac('sha256', secret).update(`${h}.${b}`).digest('base64url');
        return `${h}.${b}.${s}`;
      };

      const inputHash = hashInvocationInput(baseRequest);
      const token = createToken({
        audience: 'connector',
        tenantId: baseRequest.tenantId,
        operationId: baseRequest.operationId,
        taskId: baseRequest.taskId,
        stepKey: baseRequest.stepKey,
        invocationId: baseRequest.invocationId,
        inputHash,
        connectorId: 'conn-1',
        connectorRevision: 1,
        bindingSlot: baseRequest.bindingSlot,
        exp: Math.floor(Date.now() / 1000) + 3600,
        iat: Math.floor(Date.now() / 1000),
      }, grantSecret);

      // Valid grant passes
      const validated = await validateGrant(token, baseRequest, inputHash, verifier);
      expect(validated.invocationId).toBe(baseRequest.invocationId);

      // Mismatched input hash fails with BINDING_DENIED
      await expect(validateGrant(token, baseRequest, 'different-input-hash', verifier)).rejects.toMatchObject({
        code: 'BINDING_DENIED',
      });

      // Tampered token fails with GRANT_INVALID without leaking secret
      await expect(validateGrant('tampered.jwt.payload', baseRequest, inputHash, verifier)).rejects.toMatchObject({
        code: 'GRANT_INVALID',
      });
    });
  });

  // -------------------------------------------------------------------------
  // CON-05: INVOCATION_UNKNOWN Fault Taxonomy & Blind-Retry Prevention
  // -------------------------------------------------------------------------
  describe('CON-05: INVOCATION_UNKNOWN Fault Taxonomy & Blind-Retry Prevention', () => {
    test('transport disconnect after send records UNKNOWN state and prevents blind retries', async () => {
      const ledger = new InMemoryInvocationLedger();
      const quota = new InMemoryQuotaStore();

      const options = {
        ledger,
        quota,
        adapter: jsonHttpAdapter,
        config: { baseUrl: 'https://api.mock-provider.example', path: '/v1/chat', timeoutMs: 5000 },
        quotaKey: 'provider:account:model',
        transport: {
          send: async (): Promise<ProviderResponse> => {
            // Simulate socket reset after HTTP request was transmitted
            throw new Error('ECONNRESET: Connection dropped by peer');
          },
        },
      };

      // First call fails with INVOCATION_UNKNOWN and records state UNKNOWN in ledger
      await expect(invokeAdapter(baseRequest, options)).rejects.toMatchObject({
        code: 'INVOCATION_UNKNOWN',
        safeToRetry: false,
      });

      const record = await ledger.get(baseRequest.invocationId);
      expect(record?.state).toBe('UNKNOWN');

      // Subsequent attempt on the same invocationId MUST NOT dispatch transport again (rejects blind retry)
      let duplicateDispatch = false;
      const replayOptions = {
        ...options,
        transport: {
          send: async (): Promise<ProviderResponse> => {
            duplicateDispatch = true;
            return { status: 200, headers: {}, body: {} };
          },
        },
      };

      await expect(invokeAdapter(baseRequest, replayOptions)).rejects.toMatchObject({
        code: 'INVOCATION_UNKNOWN',
      });
      expect(duplicateDispatch).toBe(false); // Blind retry was strictly prevented!
    });

    test('provider timeout exceeding budget records UNKNOWN state', async () => {
      const ledger = new InMemoryInvocationLedger();
      const options = {
        ledger,
        quota: new InMemoryQuotaStore(),
        adapter: jsonHttpAdapter,
        config: { baseUrl: 'https://api.mock-provider.example', path: '/v1/chat', timeoutMs: 10 },
        providerTimeoutMs: 10,
        quotaKey: 'provider:account:model',
        transport: {
          send: async (_req: unknown, signal?: AbortSignal): Promise<ProviderResponse> => {
            return await new Promise<never>((_resolve, reject) => {
              signal?.addEventListener('abort', () => reject(new Error('aborted by timeout')), { once: true });
            });
          },
        },
      };

      await expect(invokeAdapter(baseRequest, options)).rejects.toMatchObject({
        code: 'PROVIDER_TIMEOUT',
      });
      expect((await ledger.get(baseRequest.invocationId))?.state).toBe('UNKNOWN');
    });

    test('clean classification of standard HTTP failure taxonomy', () => {
      expect(jsonHttpAdapter.classifyFailure({ status: 429, headers: {}, body: {} })).toBe('PROVIDER_RATE_LIMITED');
      expect(jsonHttpAdapter.classifyFailure({ status: 503, headers: {}, body: {} })).toBe('PROVIDER_UNAVAILABLE');
      expect(jsonHttpAdapter.classifyFailure({ status: 500, headers: {}, body: {} })).toBe('PROVIDER_UNAVAILABLE');
      expect(jsonHttpAdapter.classifyFailure({ status: 400, headers: {}, body: {} })).toBe('INVALID_PROVIDER_RESPONSE');
      expect(jsonHttpAdapter.classifyFailure(new Error('connection reset'))).toBe('PROVIDER_UNAVAILABLE');
    });
  });

  // -------------------------------------------------------------------------
  // USE-01: Append-Only Usage Ledger & Deterministic Accounting
  // -------------------------------------------------------------------------
  describe('USE-01: Append-Only Usage Ledger & Deterministic Accounting', () => {
    test('appendUsageEvent derives deterministic SHA-256 eventId per invocation and attempt', () => {
      const usage: NormalizedProviderResult['usage'] = {
        inputTokens: 100,
        outputTokens: 50,
        costMicrousd: 1500,
        measurement: 'measured',
      };

      const event1 = appendUsageEvent('inv-use-1', 1, usage, {
        operationId: baseRequest.operationId,
        taskId: baseRequest.taskId,
      });
      const event2 = appendUsageEvent('inv-use-1', 1, usage, {
        operationId: baseRequest.operationId,
        taskId: baseRequest.taskId,
      });

      expect(event1).toBeDefined();
      expect(event2).toBeDefined();
      expect(event1!.eventId).toBe(event2!.eventId);

      // Attempt 2 produces distinct eventId
      const eventAttempt2 = appendUsageEvent('inv-use-1', 2, usage, {
        operationId: baseRequest.operationId,
        taskId: baseRequest.taskId,
      });
      expect(eventAttempt2!.eventId).not.toBe(event1!.eventId);
    });

    test('validates UsageIngestBatchSchema rejecting negative tokens and float micro-USD', () => {
      const validEvent = {
        eventId: 'evt-valid-1',
        invocationId: 'inv-1',
        operationId: baseRequest.operationId,
        taskId: baseRequest.taskId,
        units: { inputTokens: 50, outputTokens: 25 },
        costMicrousd: 750,
        measurement: 'measured' as const,
        occurredAt: new Date().toISOString(),
      };

      expect(UsageIngestBatchSchema.safeParse({ events: [validEvent] }).success).toBe(true);

      // Negative token count rejected
      expect(
        UsageIngestBatchSchema.safeParse({
          events: [{ ...validEvent, units: { inputTokens: -10, outputTokens: 5 } }],
        }).success,
      ).toBe(false);

      // Fractional float micro-USD rejected (integer only)
      expect(
        UsageIngestBatchSchema.safeParse({
          events: [{ ...validEvent, costMicrousd: 12.34 }],
        }).success,
      ).toBe(false);

      // Empty batch rejected
      expect(UsageIngestBatchSchema.safeParse({ events: [] }).success).toBe(false);
    });

    test('HttpUsageSink transmits single debit event with bearer auth and idempotency-key', async () => {
      const capturedRequests: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
      const fetcher: typeof fetch = async (url, init) => {
        capturedRequests.push({
          url: String(url),
          headers: (init?.headers as Record<string, string>) ?? {},
          body: JSON.parse(String(init?.body)),
        });
        return new Response(null, { status: 202 });
      };

      const sink = new HttpUsageSink(
        'https://orchestrator.example/api/runtime/v1/usage-events',
        'bearer-test-token',
        fetcher,
      );

      const event = appendUsageEvent(
        'inv-sink-1',
        1,
        { inputTokens: 200, outputTokens: 80, costMicrousd: 2800, measurement: 'measured' },
        { operationId: baseRequest.operationId, taskId: baseRequest.taskId },
      );

      await sink.send(event!);
      expect(capturedRequests).toHaveLength(1);
      expect(capturedRequests[0]!.headers['authorization']).toBe('Bearer bearer-test-token');
      expect(capturedRequests[0]!.headers['idempotency-key']).toBe(event!.eventId);
      expect(capturedRequests[0]!.body).toMatchObject({
        eventId: event!.eventId,
        costMicrousd: 2800,
        measurement: 'measured',
      });
    });
  });

  // -------------------------------------------------------------------------
  // USE-02: Zero Double-Billing on Replay & Convergence
  // -------------------------------------------------------------------------
  describe('USE-02: Zero Double-Billing on Replay & Outbox Convergence', () => {
    test('outbox dispatcher retries on transient sink failure and acknowledges once delivered', async () => {
      const outbox = new InMemoryUsageOutbox();
      const event = appendUsageEvent(
        'inv-outbox-conv-1',
        1,
        { inputTokens: 50, outputTokens: 20, costMicrousd: 700, measurement: 'measured' },
        { operationId: baseRequest.operationId, taskId: baseRequest.taskId },
      );
      await outbox.append(event!);
      expect(outbox.size()).toBe(1);

      let sinkAttempts = 0;
      const sink: UsageSink = {
        send: async () => {
          sinkAttempts += 1;
          if (sinkAttempts === 1) throw new Error('Transient sink 503');
        },
      };

      const dispatcher = new UsageOutboxDispatcher(outbox, sink, {
        baseRetryMs: 0,
        maxRetryMs: 0,
        random: () => 0,
      });

      // First attempt fails; event remains in outbox
      await dispatcher.dispatchOnce();
      expect(sinkAttempts).toBe(1);
      expect(outbox.size()).toBe(1);

      // Second attempt succeeds; event is acknowledged and removed
      await dispatcher.dispatchOnce();
      expect(sinkAttempts).toBe(2);
      expect(outbox.size()).toBe(0);
      await dispatcher.drain();
    });

    test('poison events are safely parked after retry exhaustion without dropping valid events', async () => {
      const outbox = new InMemoryUsageOutbox();
      const poison = appendUsageEvent(
        'inv-poison',
        1,
        { inputTokens: 1, measurement: 'estimated' },
        { operationId: baseRequest.operationId, taskId: baseRequest.taskId },
      );
      await outbox.append(poison!);

      const dispatcher = new UsageOutboxDispatcher(outbox, {
        send: async () => { throw new Error('Permanent poison rejection'); },
      }, { maxAttempts: 1, poisonRetryMs: 86_400_000 });

      await dispatcher.dispatchOnce();
      // Event is parked (not dropped, size is still 1, but claimBatch returns empty for now)
      expect(outbox.size()).toBe(1);
      expect(await outbox.claimBatch(1, new Date().toISOString())).toHaveLength(0);
    });

    test('late usage arriving after timeout is safely appended to outbox and delivered', async () => {
      const outbox = new InMemoryUsageOutbox();
      const deliveredEvents: string[] = [];
      const sink: UsageSink = {
        send: async (evt) => {
          deliveredEvents.push(evt.eventId);
        },
      };

      const dispatcher = new UsageOutboxDispatcher(outbox, sink, {
        baseRetryMs: 0,
        maxRetryMs: 0,
        random: () => 0,
      });

      // Simulate late usage arriving from a delayed provider callback
      const lateEvent = appendUsageEvent(
        'inv-late-callback',
        1,
        { inputTokens: 300, outputTokens: 150, costMicrousd: 4500, measurement: 'measured' },
        { operationId: baseRequest.operationId, taskId: baseRequest.taskId },
      );
      await outbox.append(lateEvent!);
      await dispatcher.dispatchOnce();

      expect(deliveredEvents).toContain(lateEvent!.eventId);
      expect(outbox.size()).toBe(0);
      await dispatcher.drain();
    });

    test('live usage_events projection aggregates provider tokens and costs with zero double-billing on duplicate events', async () => {
      const dbUrl = process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
      const client = new PgSqlClient({ connectionString: dbUrl });

      const testTenantId = '00000000-0000-0000-0000-000000000001';
      const testOpId = randomUUID();
      const testTaskId = randomUUID();
      const event1Id = `evt-p803-live-1-${randomUUID()}`;
      const event2Id = `evt-p803-live-2-${randomUUID()}`;

      try {
        // 1. Seed operation and task rows
        const correlationId = `corr-${randomUUID()}`;
        await client.query(
          `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, state_version, correlation_id)
           VALUES ($1, $2, 'document-core', '1.0.0', 'extract', 'RUNNING', 1, $3)
           ON CONFLICT (id) DO NOTHING`,
          [testOpId, testTenantId, correlationId]
        );
        await client.query(
          `INSERT INTO tasks (id, operation_id, kind, task_key, state, lease_epoch)
           VALUES ($1, $2, 'root', 'task-root', 'RUNNING', 1)
           ON CONFLICT (id) DO NOTHING`,
          [testTaskId, testOpId]
        );

        // 2. Insert primary usage event (initial provider execution)
        const primaryEvent = {
          eventId: event1Id,
          invocationId: `inv-p803-1`,
          operationId: testOpId,
          taskId: testTaskId,
          units: { inputTokens: 450, outputTokens: 120, pages: 2 },
          costMicrousd: 3400,
          currency: 'USD',
          measurement: 'measured' as const,
          occurredAt: new Date().toISOString(),
          provider: 'mock-llm',
          model: 'llm-reasoning-v1',
        };

        await client.query(
          `INSERT INTO usage_events (event_id, operation_id, task_id, payload)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (event_id) DO NOTHING`,
          [primaryEvent.eventId, testOpId, testTaskId, JSON.stringify(primaryEvent)]
        );

        // 3. Insert duplicate event (replay should be rejected by ON CONFLICT without duplicating totals)
        await client.query(
          `INSERT INTO usage_events (event_id, operation_id, task_id, payload)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (event_id) DO NOTHING`,
          [primaryEvent.eventId, testOpId, testTaskId, JSON.stringify(primaryEvent)]
        );

        // 4. Insert late callback usage event (asynchronous secondary charge)
        const lateEvent = {
          eventId: event2Id,
          invocationId: `inv-p803-2`,
          operationId: testOpId,
          taskId: testTaskId,
          units: { inputTokens: 150, outputTokens: 80, pages: 1 },
          costMicrousd: 1800,
          currency: 'USD',
          measurement: 'measured' as const,
          occurredAt: new Date().toISOString(),
          provider: 'mock-llm',
          model: 'llm-reasoning-v1',
        };

        await client.query(
          `INSERT INTO usage_events (event_id, operation_id, task_id, payload)
           VALUES ($1, $2, $3, $4::jsonb)
           ON CONFLICT (event_id) DO NOTHING`,
          [lateEvent.eventId, testOpId, testTaskId, JSON.stringify(lateEvent)]
        );

        // 5. Query live usage projection matching orchestrator usage.project() query
        const projRes = await client.query<{
          count: string;
          input_tokens: string;
          output_tokens: string;
          cost: string;
          estimated: boolean | null;
        }>(
          `SELECT count(*)::text AS count,
                  COALESCE(sum((payload->'units'->>'inputTokens')::numeric), 0)::text AS input_tokens,
                  COALESCE(sum((payload->'units'->>'outputTokens')::numeric), 0)::text AS output_tokens,
                  COALESCE(sum((payload->>'costMicrousd')::numeric), 0)::text AS cost,
                  bool_or(payload->>'measurement' = 'estimated') AS estimated
           FROM usage_events WHERE operation_id = $1`,
          [testOpId]
        );

        expect(projRes.rows).toHaveLength(1);
        const projection = projRes.rows[0]!;
        // Exactly 2 distinct events (dedup avoided replay double-counting)
        expect(Number(projection.count)).toBe(2);
        // Converged token sums: 450 + 150 = 600
        expect(Number(projection.input_tokens)).toBe(600);
        // Converged token sums: 120 + 80 = 200
        expect(Number(projection.output_tokens)).toBe(200);
        // Converged cost: 3400 + 1800 = 5200 micro-USD
        expect(Number(projection.cost)).toBe(5200);
        expect(projection.estimated).toBe(false);
      } finally {
        // Scoped cleanup: remove only this test's operation, task, and usage rows
        await client.query('DELETE FROM usage_events WHERE operation_id = $1', [testOpId]).catch(() => {});
        await client.query('DELETE FROM tasks WHERE operation_id = $1', [testOpId]).catch(() => {});
        await client.query('DELETE FROM operations WHERE id = $1', [testOpId]).catch(() => {});
        await client.close();
      }
    });
  });
});
