import { createHash, randomUUID } from 'node:crypto';
import {
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  PostgresInvocationLedger,
  appendUsageEvent,
  hashInvocationInput,
  invokeAdapter,
  jsonHttpAdapter,
  multipartHttpAdapter,
  validateGrant,
  type GrantClaims,
  type LocalInvocationRequest,
  type QuotaLease,
  type QuotaStore,
  type SqlClient,
} from '../src';
import type { InvocationArtifactContent } from '@du/contracts';

const request: LocalInvocationRequest = {
  contractVersion: '1',
  invocationId: 'inv-1',
  tenantId: 'tenant-1',
  operationId: 'op-1',
  taskId: 'task-1',
  stepKey: 'extract',
  bindingSlot: 'reasoning',
  input: { prompt: 'Extract', text: 'invoice' },
  options: { temperature: 0 },
  sessionRef: null,
  deadlineAt: '2099-01-01T00:00:00.000Z',
};

describe('connector local protocol functions', () => {
  test('canonical input hash is stable despite object key order', () => {
    const reordered = { ...request, options: { temperature: 0 } };
    expect(hashInvocationInput(request)).toBe(hashInvocationInput(reordered));
  });

  test('ledger replays same request and rejects a different hash', async () => {
    const ledger = new InMemoryInvocationLedger();
    const first = await ledger.claim(request, hashInvocationInput(request));
    expect(first.kind).toBe('claimed');
    expect((await ledger.claim(request, hashInvocationInput(request))).kind).toBe('replay');
    expect((await ledger.claim({ ...request, input: { prompt: 'changed' } }, 'different')).kind).toBe('conflict');
  });

  test('Postgres ledger converts an initial insert conflict into replay or input conflict', async () => {
    const queryCalls: string[] = [];
    const persisted = {
      invocation_id: request.invocationId,
      tenant_id: request.tenantId,
      operation_id: request.operationId,
      task_id: request.taskId,
      step_key: request.stepKey,
      input_hash: 'persisted-hash',
      request,
      state: 'IN_FLIGHT',
      result: null,
      error_code: null,
      provider_request_id: null,
      next_poll_at: null,
      poll_lease_token: null,
      poll_lease_expires_at: null,
      quota_lease_key: null,
      quota_lease_id: null,
      quota_lease_expires_at: null,
      provider_poll_attempts: 0,
      updated_at: '2098-12-31T23:59:00.000Z',
    };
    const db: SqlClient = {
      query: async <Row extends object>(text: string) => {
        queryCalls.push(text);
        if (text.startsWith('INSERT INTO connector_invocations')) return { rows: [] as Row[] };
        if (text.startsWith('SELECT * FROM connector_invocations')) return { rows: [persisted as unknown as Row] };
        return { rows: [] as Row[] };
      },
      transaction: async <T>(callback: (client: SqlClient) => Promise<T>) => callback(db),
    };
    // SEC-ENC-02: this fixture models a historical plaintext row, so it opens
    // the bounded migration window explicitly. New writes are still sealed.
    const ledger = new PostgresInvocationLedger(db, { legacyPlaintextReads: true });

    await expect(ledger.claim(request, 'persisted-hash')).resolves.toMatchObject({ kind: 'replay' });
    await expect(ledger.claim(request, 'different-hash')).resolves.toMatchObject({ kind: 'conflict' });
    // The existence pre-check answers before the INSERT is even attempted.
    expect(queryCalls[0]).toContain('SELECT * FROM connector_invocations');
    expect(queryCalls.some((text) => text.includes('ON CONFLICT (invocation_id) DO NOTHING'))).toBe(false);
  });

  test('replaying a cancelled invocation never dispatches the provider', async () => {
    const ledger = new InMemoryInvocationLedger();
    const inputHash = hashInvocationInput(request);
    await ledger.claim(request, inputHash);
    await ledger.cancel(request.invocationId);
    let providerCalls = 0;

    await expect(invokeAdapter(request, {
      ledger,
      quota: new InMemoryQuotaStore(),
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000 },
      quotaKey: 'provider:account:model',
      transport: {
        send: async () => {
          providerCalls += 1;
          return { status: 200, body: { content: 'must not dispatch' } };
        },
      },
    })).rejects.toMatchObject({ code: 'CANCELLED' });
    expect(providerCalls).toBe(0);
  });

  test('quota enforces the aggregate in-flight cap', async () => {
    const quota = new InMemoryQuotaStore();
    const first = await quota.acquire('provider:account:model', 0, 1000, 1);
    expect(first).toBeDefined();
    expect(await quota.acquire('provider:account:model', 0, 1000, 1)).toBeUndefined();
    await quota.release(first!);
    expect(await quota.acquire('provider:account:model', 0, 1000, 1)).toBeDefined();
  });

  test('grant binds identity, hash, audience, and expiry', async () => {
    const claims: GrantClaims = {
      audience: 'connector',
      tenantId: request.tenantId,
      operationId: request.operationId,
      taskId: request.taskId,
      stepKey: request.stepKey,
      invocationId: request.invocationId,
      inputHash: hashInvocationInput(request),
      connectorRevision: 'rev-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
    };
    await expect(validateGrant('token', request, claims.inputHash, { verify: async () => claims })).resolves.toEqual(claims);
    await expect(validateGrant('token', request, 'bad', { verify: async () => claims })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
  });

  test('json and multipart adapters map without arbitrary endpoint overrides', () => {
    const json = jsonHttpAdapter.buildRequest(request, {
      baseUrl: 'https://provider.example/',
      path: '/v1/infer',
      timeoutMs: 1000,
    });
    expect(json.url).toBe('https://provider.example/v1/infer');
    expect(JSON.parse(json.body as string)).toMatchObject({ prompt: 'Extract', text: 'invoice' });
    const multipart = multipartHttpAdapter.buildRequest(request, {
      baseUrl: 'https://provider.example/',
      path: '/v1/infer',
      timeoutMs: 1000,
    });
    expect(multipart.body).toBeInstanceOf(FormData);
  });

  test('JSON and multipart OCR requests carry the authorized scan bytes, MIME and pinned identity', async () => {
    const scan = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
      'base64',
    );
    const artifact: InvocationArtifactContent = {
      artifactId: randomUUID(),
      fileName: 'handwritten-form.png',
      mimeType: 'image/png',
      sizeBytes: scan.length,
      sha256: createHash('sha256').update(scan).digest('hex'),
      storageVersionId: 's3-version-handwriting-1',
      contentBase64: scan.toString('base64'),
    };
    const ocrRequest: LocalInvocationRequest = {
      ...request,
      input: { task: 'digitize_handwriting', language: 'vie', artifacts: [artifact] },
    };

    const json = jsonHttpAdapter.buildRequest(ocrRequest, {
      baseUrl: 'https://provider.example/',
      path: '/v1/vision',
      timeoutMs: 1000,
    });
    const jsonBody = JSON.parse(json.body as string) as { task: string; language: string; artifacts: InvocationArtifactContent[] };
    expect(jsonBody.task).toBe('digitize_handwriting');
    expect(jsonBody.language).toBe('vie');
    expect(jsonBody.artifacts[0]).toEqual(artifact);
    expect(Buffer.from(jsonBody.artifacts[0]!.contentBase64, 'base64')).toEqual(scan);

    const multipart = multipartHttpAdapter.buildRequest(ocrRequest, {
      baseUrl: 'https://provider.example/',
      path: '/v1/vision',
      timeoutMs: 1000,
    });
    const form = multipart.body as FormData;
    const file = form.get('artifacts') as Blob & { name?: string };
    expect(form.get('task')).toBe('digitize_handwriting');
    expect(form.get('language')).toBe('vie');
    expect(file).toBeInstanceOf(Blob);
    expect(file.type).toBe('image/png');
    expect(file.name).toBe('handwritten-form.png');
    expect(Buffer.from(await file.arrayBuffer())).toEqual(scan);
    expect(JSON.parse(form.get('artifactMetadata') as string)).toEqual([{
      artifactId: artifact.artifactId,
      fileName: artifact.fileName,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      sha256: artifact.sha256,
      storageVersionId: artifact.storageVersionId,
    }]);
  });

  test('grant rejects expired invocations and foreign or unpinned artifact versions', async () => {
    const bytes = Buffer.from('scan bytes');
    const artifact: InvocationArtifactContent = {
      artifactId: randomUUID(),
      fileName: 'scan.png',
      mimeType: 'image/png',
      sizeBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      storageVersionId: 'pg-sha256-v1',
      contentBase64: bytes.toString('base64'),
    };
    const requestWithArtifact: LocalInvocationRequest = {
      ...request,
      input: { artifacts: [artifact] },
    };
    const inputHash = hashInvocationInput(requestWithArtifact);
    const claims: GrantClaims = {
      audience: 'connector',
      tenantId: request.tenantId,
      operationId: request.operationId,
      taskId: request.taskId,
      stepKey: request.stepKey,
      invocationId: request.invocationId,
      inputHash,
      connectorRevision: 'rev-1',
      expiresAt: '2099-01-01T00:00:00.000Z',
      artifactIds: [artifact.artifactId],
      artifactPins: [{
        artifactId: artifact.artifactId,
        fileName: artifact.fileName,
        mimeType: artifact.mimeType,
        sizeBytes: artifact.sizeBytes,
        sha256: artifact.sha256,
        storageVersionId: artifact.storageVersionId,
      }],
    };
    await expect(validateGrant('token', requestWithArtifact, inputHash, { verify: async () => claims })).resolves.toEqual(claims);
    await expect(validateGrant('token', requestWithArtifact, inputHash, {
      verify: async () => ({ ...claims, expiresAt: '2000-01-01T00:00:00.000Z' }),
    })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    await expect(validateGrant('token', requestWithArtifact, inputHash, {
      verify: async () => ({ ...claims, artifactIds: [randomUUID()] }),
    })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
    await expect(validateGrant('token', requestWithArtifact, inputHash, {
      verify: async () => ({ ...claims, artifactPins: [{ ...claims.artifactPins![0]!, storageVersionId: 'other-version' }] }),
    })).rejects.toMatchObject({ code: 'BINDING_DENIED' });
  });

  test('usage event IDs are deterministic for duplicate delivery', () => {
    const usage = { inputTokens: 1, outputTokens: 2, measurement: 'measured' as const };
    expect(appendUsageEvent('inv-1', 1, usage)?.eventId).toBe(appendUsageEvent('inv-1', 1, usage)?.eventId);
  });

  test('request mappings never allow arbitrary provider endpoint or header overrides', () => {
    expect(() => jsonHttpAdapter.buildRequest(request, {
      baseUrl: 'file:///secret',
      path: '/etc/passwd',
      timeoutMs: 1000,
    })).toThrow();
  });

  test('HTTP 202 requires explicit provider idempotency replay opt-in', async () => {
    const ledger = new InMemoryInvocationLedger();
    await expect(invokeAdapter(request, {
      ledger,
      quota: new InMemoryQuotaStore(),
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000 },
      quotaKey: 'provider:account:model',
      transport: {
        send: async () => ({
          status: 202,
          body: { nextPollAt: '2098-12-31T23:59:01.000Z' },
        }),
      },
    })).rejects.toMatchObject({ code: 'CAPABILITY_UNSUPPORTED' });
    expect((await ledger.get(request.invocationId))?.state).toBe('FAILED');
  });

  test('pending replay waits until nextPollAt, then polls with the same provider idempotency key', async () => {
    const ledger = new InMemoryInvocationLedger();
    const backingQuota = new InMemoryQuotaStore();
    let acquired = 0;
    let released = 0;
    let activeLeases = 0;
    const quota: QuotaStore = {
      acquire: async (key, nowMs, leaseMs, maxInFlight): Promise<QuotaLease | undefined> => {
        const lease = await backingQuota.acquire(key, nowMs, leaseMs, maxInFlight);
        if (lease) {
          acquired += 1;
          activeLeases += 1;
        }
        return lease;
      },
      renew: async (lease, nowMs, leaseMs) => backingQuota.renew(lease, nowMs, leaseMs),
      release: async (lease) => {
        released += 1;
        activeLeases -= 1;
        await backingQuota.release(lease);
      },
    };
    let nowMs = Date.parse('2098-12-31T23:59:00.000Z');
    let calls = 0;
    const requestWithDeadline = { ...request, deadlineAt: '2099-01-01T00:01:00.000Z' };
    const idempotencyKeys: string[] = [];
    const outcomes = [
      { status: 202, body: { nextPollAt: new Date(nowMs + 1000).toISOString() } },
      { status: 202, body: { nextPollAt: new Date(nowMs + 2000).toISOString() } },
      { status: 200, body: { content: 'finished', providerRequestId: 'provider-final' } },
    ];
    const options = {
      ledger,
      quota,
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000, asyncPollingMode: 'idempotency-key-replay' as const },
      quotaKey: 'provider:account:model',
      now: () => nowMs,
      random: () => 0,
      transport: {
        send: async (providerRequest: { headers: Readonly<Record<string, string>> }) => {
          calls += 1;
          idempotencyKeys.push(providerRequest.headers['Idempotency-Key']);
          return outcomes[calls - 1];
        },
      },
    };

    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'pending' });
    expect(activeLeases).toBe(1);
    expect(acquired).toBe(1);
    expect(released).toBe(0);
    expect((await ledger.get(requestWithDeadline.invocationId))?.providerPollAttempts).toBe(1);

    nowMs += 500;
    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'pending' });
    expect(calls).toBe(1);
    expect(acquired).toBe(1);
    expect(released).toBe(0);

    nowMs += 500;
    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'pending' });
    expect(calls).toBe(2);
    expect(activeLeases).toBe(1);
    expect(acquired).toBe(1);
    expect(released).toBe(0);
    expect((await ledger.get(requestWithDeadline.invocationId))?.providerPollAttempts).toBe(2);

    nowMs += 2000;
    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'completed' });
    expect(calls).toBe(3);
    expect(new Set(idempotencyKeys)).toEqual(new Set([requestWithDeadline.invocationId]));
    expect((await ledger.get(requestWithDeadline.invocationId))?.state).toBe('SUCCEEDED');
    expect(activeLeases).toBe(0);
    expect(acquired).toBe(1);
    expect(released).toBe(1);

    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'completed' });
    expect(calls).toBe(3);
  });

  test('pending replay at deadline fails without another provider dispatch', async () => {
    const ledger = new InMemoryInvocationLedger();
    let nowMs = Date.parse('2098-12-31T23:59:00.000Z');
    let calls = 0;
    const requestWithDeadline = { ...request, deadlineAt: new Date(nowMs + 5000).toISOString() };
    const options = {
      ledger,
      quota: new InMemoryQuotaStore(),
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000, asyncPollingMode: 'idempotency-key-replay' as const },
      quotaKey: 'provider:account:model',
      now: () => nowMs,
      random: () => 0.5,
      transport: {
        send: async () => {
          calls += 1;
          return { status: 202, body: { nextPollAt: new Date(nowMs + 10_000).toISOString() } };
        },
      },
    };

    const pending = await invokeAdapter(requestWithDeadline, options);
    expect(pending.state).toBe('pending');
    expect(pending.state === 'pending' && pending.nextPollAt).toBe(requestWithDeadline.deadlineAt);
    nowMs = Date.parse(requestWithDeadline.deadlineAt);
    await expect(invokeAdapter(requestWithDeadline, options)).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect(calls).toBe(1);
    expect((await ledger.get(requestWithDeadline.invocationId))?.state).toBe('FAILED');
  });

  test('concurrent due PENDING replay claims only one provider poll', async () => {
    const ledger = new InMemoryInvocationLedger();
    let nowMs = Date.parse('2098-12-31T23:59:00.000Z');
    let calls = 0;
    let resolvePoll!: (response: { status: number; body: unknown }) => void;
    let announcePollStarted!: () => void;
    const pollStarted = new Promise<void>((resolve) => { announcePollStarted = resolve; });
    const requestWithDeadline = { ...request, deadlineAt: '2099-01-01T00:01:00.000Z' };
    const options = {
      ledger,
      quota: new InMemoryQuotaStore(),
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000, asyncPollingMode: 'idempotency-key-replay' as const },
      quotaKey: 'provider:account:model',
      now: () => nowMs,
      random: () => 0,
      transport: {
        send: async () => {
          calls += 1;
          if (calls === 1) return { status: 202, body: { nextPollAt: new Date(nowMs + 1000).toISOString() } };
          announcePollStarted();
          return await new Promise<{ status: number; body: unknown }>((resolve) => { resolvePoll = resolve; });
        },
      },
    };

    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'pending' });
    nowMs += 1000;
    const poll = invokeAdapter(requestWithDeadline, options);
    await pollStarted;
    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'pending' });
    expect(calls).toBe(2);
    resolvePoll({ status: 200, body: { content: 'finished' } });
    await expect(poll).resolves.toMatchObject({ state: 'completed' });
    expect((await ledger.get(requestWithDeadline.invocationId))?.state).toBe('SUCCEEDED');
  });

  test('expired poll lease is recovered and a stale poller cannot replace its result', async () => {
    const ledger = new InMemoryInvocationLedger();
    const backingQuota = new InMemoryQuotaStore();
    let releaseCalls = 0;
    const quota: QuotaStore = {
      acquire: (...args) => backingQuota.acquire(...args),
      renew: (...args) => backingQuota.renew(...args),
      release: async (lease) => {
        releaseCalls += 1;
        await backingQuota.release(lease);
      },
    };
    let nowMs = Date.parse('2098-12-31T23:59:00.000Z');
    let calls = 0;
    let resolveStalePoll!: (response: { status: number; body: unknown }) => void;
    let announceStalePoll!: () => void;
    const stalePollStarted = new Promise<void>((resolve) => { announceStalePoll = resolve; });
    const requestWithDeadline = { ...request, deadlineAt: '2099-01-01T01:00:00.000Z' };
    const options = {
      ledger,
      quota,
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 60_000, asyncPollingMode: 'idempotency-key-replay' as const },
      quotaKey: 'provider:account:model',
      now: () => nowMs,
      random: () => 0,
      transport: {
        send: async () => {
          calls += 1;
          if (calls === 1) return { status: 202, body: { nextPollAt: new Date(nowMs + 1000).toISOString() } };
          if (calls === 2) {
            announceStalePoll();
            return await new Promise<{ status: number; body: unknown }>((resolve) => { resolveStalePoll = resolve; });
          }
          return { status: 200, body: { content: 'recovered result' } };
        },
      },
    };

    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'pending' });
    nowMs += 1000;
    const stalePoll = invokeAdapter(requestWithDeadline, options);
    await stalePollStarted;
    nowMs += 65_000;
    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'completed' });
    expect(calls).toBe(3);
    expect((await ledger.get(requestWithDeadline.invocationId))?.result?.content).toBe('recovered result');
    resolveStalePoll({ status: 202, body: { nextPollAt: new Date(nowMs + 1000).toISOString() } });
    await expect(stalePoll).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect((await ledger.get(requestWithDeadline.invocationId))?.state).toBe('SUCCEEDED');
    expect(releaseCalls).toBe(1);
  });

  test('quota lease store failure returns due invocation to retryable PENDING', async () => {
    const ledger = new InMemoryInvocationLedger();
    let nowMs = Date.parse('2098-12-31T23:59:00.000Z');
    let acquireCalls = 0;
    let providerCalls = 0;
    const requestWithDeadline = { ...request, deadlineAt: '2099-01-01T00:01:00.000Z' };
    const quota: QuotaStore = {
      acquire: async () => {
        acquireCalls += 1;
        if (acquireCalls === 1) throw new Error('redis unavailable');
        return { leaseId: 'lease-1', key: 'provider:account:model', expiresAt: nowMs + 30_000 };
      },
      renew: async () => undefined,
      release: async () => undefined,
    };
    const options = {
      ledger,
      quota,
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000 },
      quotaKey: 'provider:account:model',
      now: () => nowMs,
      transport: {
        send: async () => {
          providerCalls += 1;
          return { status: 200, body: { content: 'finished' } };
        },
      },
    };

    await expect(invokeAdapter(requestWithDeadline, options)).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
    const pending = await ledger.get(requestWithDeadline.invocationId);
    expect(pending?.state).toBe('PENDING');
    expect(pending?.nextPollAt).toBe(new Date(nowMs + 1000).toISOString());
    expect(providerCalls).toBe(0);
    nowMs += 1000;
    await expect(invokeAdapter(requestWithDeadline, options)).resolves.toMatchObject({ state: 'completed' });
    expect(providerCalls).toBe(1);
  });

  test('Postgres pending poll claim is a due-state compare-and-set scoped to the input hash', async () => {
    const queryCalls: Array<{ text: string; parameters?: readonly unknown[] }> = [];
    let shouldClaim = true;
    const db: SqlClient = {
      query: async <Row extends object>(text: string, parameters?: readonly unknown[]) => {
        queryCalls.push({ text, parameters });
        return { rows: (shouldClaim ? [{ poll_lease_token: 'poll-token' }] : []) as Row[] };
      },
      transaction: async <T>(callback: (client: SqlClient) => Promise<T>) => callback(db),
    };
    const ledger = new PostgresInvocationLedger(db);
    const nowMs = Date.parse('2098-12-31T23:59:00.000Z');

    await expect(ledger.claimPendingPoll('inv-1', 'hash-1', nowMs, 30_000)).resolves.toBe('poll-token');
    expect(queryCalls[0]?.text).toContain("SET state = 'POLLING'");
    expect(queryCalls[0]?.text).toContain("state = 'PENDING'");
    expect(queryCalls[0]?.text).toContain('next_poll_at <= $3');
    expect(queryCalls[0]?.text).toContain('poll_lease_expires_at <= $3');
    expect(queryCalls[0]?.text).toContain("state = 'POLLING'");
    expect(queryCalls[0]?.parameters?.slice(0, 3)).toEqual(['inv-1', 'hash-1', new Date(nowMs).toISOString()]);
    expect(queryCalls[0]?.parameters?.[3]).toBeTruthy();
    expect(queryCalls[0]?.parameters?.[4]).toBe(30_000);
    shouldClaim = false;
    await expect(ledger.claimPendingPoll('inv-1', 'hash-1', nowMs, 30_000)).resolves.toBeUndefined();
  });

  test('pending replay terminalization is fenced to the same hash and PENDING state', async () => {
    const queryCalls: Array<{ text: string; parameters?: readonly unknown[] }> = [];
    let updateSucceeds = true;
    const db: SqlClient = {
      query: async <Row extends object>(text: string, parameters?: readonly unknown[]) => {
        queryCalls.push({ text, parameters });
        return { rows: (updateSucceeds ? [{ invocation_id: 'inv-1' }] : []) as Row[] };
      },
      transaction: async <T>(callback: (client: SqlClient) => Promise<T>) => callback(db),
    };
    const ledger = new PostgresInvocationLedger(db);

    await expect(ledger.failPending('inv-1', 'hash-1', 'PROVIDER_TIMEOUT')).resolves.toBe(true);
    expect(queryCalls[0]?.text).toContain("input_hash = $2 AND state = 'PENDING'");
    expect(queryCalls[0]?.parameters).toEqual(['inv-1', 'hash-1', 'PROVIDER_TIMEOUT']);
    updateSucceeds = false;
    await expect(ledger.failPending('inv-1', 'hash-1', 'PROVIDER_TIMEOUT')).resolves.toBe(false);
  });

  test('concurrent IN_FLIGHT replay never dispatches the provider twice', async () => {
    const ledger = new InMemoryInvocationLedger();
    let resolveProvider!: (response: { status: number; body: unknown }) => void;
    let announceStarted!: () => void;
    const started = new Promise<void>((resolve) => { announceStarted = resolve; });
    let calls = 0;
    const options = {
      ledger,
      quota: new InMemoryQuotaStore(),
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000 },
      quotaKey: 'provider:account:model',
      transport: {
        send: async () => {
          calls += 1;
          announceStarted();
          return await new Promise<{ status: number; body: unknown }>((resolve) => { resolveProvider = resolve; });
        },
      },
    };
    const first = invokeAdapter(request, options);
    await started;
    await expect(invokeAdapter(request, options)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect(calls).toBe(1);
    resolveProvider({ status: 200, body: { content: 'finished' } });
    await expect(first).resolves.toMatchObject({ state: 'completed' });
    await expect(invokeAdapter(request, options)).resolves.toMatchObject({ state: 'completed' });
    expect(calls).toBe(1);
  });

  test('provider response loss is recorded as UNKNOWN and never silently retried', async () => {
    const ledger = new InMemoryInvocationLedger();
    await expect(invokeAdapter(request, {
      ledger,
      quota: new InMemoryQuotaStore(),
      adapter: jsonHttpAdapter,
      config: { baseUrl: 'https://provider.example', path: '/infer', timeoutMs: 1000 },
      quotaKey: 'provider:account:model',
      transport: { send: async () => { throw new Error('response lost'); } },
    })).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect((await ledger.get(request.invocationId))?.state).toBe('UNKNOWN');
  });
});
