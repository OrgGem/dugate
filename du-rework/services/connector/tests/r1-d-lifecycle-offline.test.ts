import {
  InMemoryInvocationLedger,
  InMemoryQuotaStore,
  InMemoryUsageOutbox,
  UsageOutboxDispatcher,
  appendUsageEvent,
  hashInvocationInput,
  invokeAdapter,
  jsonHttpAdapter,
  type InvocationLedger,
  type LocalInvocationRequest,
  type QuotaLease,
  type QuotaStore,
} from '../src';

const START = Date.parse('2098-12-31T23:00:00.000Z');

function makeRequest(invocationId: string, deadlineMs = 86_400_000): LocalInvocationRequest {
  return {
    contractVersion: '1',
    invocationId,
    tenantId: 'tenant-a',
    operationId: 'operation-a',
    taskId: 'task-a',
    stepKey: 'extract',
    bindingSlot: 'reasoning',
    input: { prompt: 'Extract', text: 'fixture' },
    options: {},
    sessionRef: null,
    deadlineAt: new Date(START + deadlineMs).toISOString(),
  };
}

function openProcessLedger(backing: InvocationLedger): InvocationLedger {
  // Each simulated process gets a new adapter object over one durable backing store.
  return {
    get: (invocationId) => backing.get(invocationId),
    claim: (request, inputHash) => backing.claim(request, inputHash),
    claimPendingPoll: (invocationId, inputHash, now, leaseMs) =>
      backing.claimPendingPoll(invocationId, inputHash, now, leaseMs),
    complete: (invocationId, result, pollLeaseToken) =>
      backing.complete(invocationId, result, pollLeaseToken),
    failPending: (invocationId, inputHash, errorCode) =>
      backing.failPending(invocationId, inputHash, errorCode),
    fail: (invocationId, errorCode, pollLeaseToken) =>
      backing.fail(invocationId, errorCode, pollLeaseToken),
    cancel: (invocationId) => backing.cancel(invocationId),
    markUnknown: (invocationId, pollLeaseToken) => backing.markUnknown(invocationId, pollLeaseToken),
    markPending: (invocationId, nextPollAt, providerRequestId, pollLeaseToken, quotaLease, providerPollAttempt) =>
      backing.markPending(invocationId, nextPollAt, providerRequestId, pollLeaseToken, quotaLease, providerPollAttempt),
  };
}

function openProcessQuota(backing: QuotaStore): QuotaStore {
  // Each simulated replica has its own client facade over one shared quota backend.
  return {
    acquire: (...args) => backing.acquire(...args),
    renew: (...args) => backing.renew(...args),
    release: (lease) => backing.release(lease),
  };
}

function optionsFor(
  backing: InvocationLedger,
  quota: QuotaStore,
  now: () => number,
  send: (request: { headers: Readonly<Record<string, string>> }, signal?: AbortSignal) => Promise<{ status: number; body: unknown }>,
  overrides: { timeoutMs?: number; quotaLeaseMs?: number; maxInFlight?: number } = {},
) {
  return {
    ledger: openProcessLedger(backing),
    quota,
    adapter: jsonHttpAdapter,
    config: {
      baseUrl: 'https://provider.example',
      path: '/infer',
      timeoutMs: overrides.timeoutMs ?? 5000,
      asyncPollingMode: 'idempotency-key-replay' as const,
    },
    quotaKey: 'credential-shared-by-account',
    quotaLeaseMs: overrides.quotaLeaseMs,
    maxInFlight: overrides.maxInFlight ?? 1,
    providerTimeoutMs: overrides.timeoutMs ?? 5000,
    now,
    random: () => 0,
    transport: { send },
  };
}

describe('R1-D offline lifecycle harness', () => {
  afterEach(() => jest.useRealTimers());

  test('an initial IN_FLIGHT replay after process reconstruction never dispatches again', async () => {
    const backing = new InMemoryInvocationLedger();
    const request = makeRequest('r1d-in-flight');
    await backing.claim(request, hashInvocationInput(request));
    const quotaBacking = new InMemoryQuotaStore();
    let acquisitions = 0;
    const quota: QuotaStore = {
      acquire: async (...args) => {
        acquisitions += 1;
        return quotaBacking.acquire(...args);
      },
      renew: (...args) => quotaBacking.renew(...args),
      release: (lease) => quotaBacking.release(lease),
    };
    let sends = 0;
    const send = async () => {
      sends += 1;
      return { status: 200, body: { content: 'unexpected' } };
    };

    await expect(invokeAdapter(request, optionsFor(backing, quota, () => START, send)))
      .rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    await expect(invokeAdapter(request, optionsFor(backing, quota, () => START, send)))
      .rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });

    expect(sends).toBe(0);
    expect(acquisitions).toBe(0);
    expect((await backing.get(request.invocationId))?.state).toBe('IN_FLIGHT');
  });

  test('a CANCELLED replay after process reconstruction never dispatches or reacquires quota', async () => {
    const backing = new InMemoryInvocationLedger();
    const request = makeRequest('r1d-cancelled');
    await backing.claim(request, hashInvocationInput(request));
    await backing.cancel(request.invocationId);
    const quotaBacking = new InMemoryQuotaStore();
    let acquisitions = 0;
    const quota: QuotaStore = {
      acquire: async (...args) => {
        acquisitions += 1;
        return quotaBacking.acquire(...args);
      },
      renew: (...args) => quotaBacking.renew(...args),
      release: (lease) => quotaBacking.release(lease),
    };
    let sends = 0;

    await expect(invokeAdapter(request, optionsFor(backing, quota, () => START, async () => {
      sends += 1;
      return { status: 200, body: { content: 'unexpected' } };
    }))).rejects.toMatchObject({ code: 'CANCELLED' });

    expect(sends).toBe(0);
    expect(acquisitions).toBe(0);
    expect((await backing.get(request.invocationId))?.state).toBe('CANCELLED');
  });

  test('durable UNKNOWN stays UNKNOWN on replay and does not trigger provider inference', async () => {
    const backing = new InMemoryInvocationLedger();
    const request = makeRequest('r1d-unknown');
    await backing.claim(request, hashInvocationInput(request));
    await backing.markUnknown(request.invocationId);
    let sends = 0;

    await expect(invokeAdapter(request, optionsFor(backing, new InMemoryQuotaStore(), () => START, async () => {
      sends += 1;
      return { status: 200, body: { content: 'unexpected' } };
    }))).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });

    expect(sends).toBe(0);
    expect((await openProcessLedger(backing).get(request.invocationId))?.state).toBe('UNKNOWN');
    await expect(backing.cancel(request.invocationId)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
  });

  test('PENDING resumes after process reconstruction using the same provider idempotency key', async () => {
    const backing = new InMemoryInvocationLedger();
    const request = makeRequest('r1d-poll-restart');
    const quota = new InMemoryQuotaStore();
    let nowMs = START;
    let sends = 0;
    const keys: string[] = [];
    const send = async (providerRequest: { headers: Readonly<Record<string, string>> }) => {
      sends += 1;
      keys.push(providerRequest.headers['Idempotency-Key']!);
      if (sends === 1) {
        return { status: 202, body: { nextPollAt: new Date(nowMs + 1000).toISOString() } };
      }
      return { status: 200, body: { content: 'recovered after restart' } };
    };

    await expect(invokeAdapter(request, optionsFor(backing, quota, () => nowMs, send)))
      .resolves.toMatchObject({ state: 'pending' });
    const pending = await backing.get(request.invocationId);
    expect(pending?.state).toBe('PENDING');
    nowMs = Date.parse(pending!.nextPollAt!);
    await expect(invokeAdapter(request, optionsFor(backing, quota, () => nowMs, send)))
      .resolves.toMatchObject({ state: 'completed' });
    expect(sends).toBe(2);
    expect(keys).toEqual([request.invocationId, request.invocationId]);
    expect((await backing.get(request.invocationId))?.state).toBe('SUCCEEDED');
  });

  test('async poll budget is durable and stops dispatch after the configured maximum', async () => {
    const backing = new InMemoryInvocationLedger();
    const request = makeRequest('r1d-poll-budget');
    const quota = new InMemoryQuotaStore();
    let nowMs = START;
    let sends = 0;
    const keys: string[] = [];
    const send = async (providerRequest: { headers: Readonly<Record<string, string>> }) => {
      sends += 1;
      keys.push(providerRequest.headers['Idempotency-Key']!);
      return { status: 202, body: { nextPollAt: new Date(nowMs).toISOString() } };
    };

    for (let poll = 1; poll <= 16; poll += 1) {
      if (poll > 1) nowMs = Date.parse((await backing.get(request.invocationId))!.nextPollAt!);
      await expect(invokeAdapter(request, optionsFor(backing, quota, () => nowMs, send)))
        .resolves.toMatchObject({ state: 'pending' });
      expect((await backing.get(request.invocationId))?.providerPollAttempts).toBe(poll);
    }

    nowMs = Date.parse((await backing.get(request.invocationId))!.nextPollAt!);
    await expect(invokeAdapter(request, optionsFor(backing, quota, () => nowMs, send)))
      .rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect(sends).toBe(16);
    expect(keys.every((key) => key === request.invocationId)).toBe(true);
    expect((await backing.get(request.invocationId))?.state).toBe('UNKNOWN');
  });

  test('poll restart recovery uses a fenced POLLING lease instead of reopening IN_FLIGHT', async () => {
    const backing = new InMemoryInvocationLedger();
    const request = makeRequest('r1d-poll-lease-restart');
    const quota = new InMemoryQuotaStore();
    let nowMs = START;
    let sends = 0;
    let releaseStale!: (response: { status: number; body: unknown }) => void;
    let announceStale!: () => void;
    const staleStarted = new Promise<void>((resolve) => { announceStale = resolve; });
    const send = async () => {
      sends += 1;
      if (sends === 1) return { status: 202, body: { nextPollAt: new Date(nowMs + 1000).toISOString() } };
      if (sends === 2) {
        announceStale();
        return new Promise<{ status: number; body: unknown }>((resolve) => { releaseStale = resolve; });
      }
      return { status: 200, body: { content: 'recovered result' } };
    };

    await invokeAdapter(request, optionsFor(backing, quota, () => nowMs, send, { timeoutMs: 60_000 }));
    nowMs = Date.parse((await backing.get(request.invocationId))!.nextPollAt!);
    const stalePoll = invokeAdapter(request, optionsFor(backing, quota, () => nowMs, send, { timeoutMs: 60_000 }));
    await staleStarted;
    const staleLease = await backing.get(request.invocationId);
    expect(staleLease?.state).toBe('POLLING');
    nowMs = Date.parse(staleLease!.pollLeaseExpiresAt!) + 1;

    await expect(invokeAdapter(request, optionsFor(backing, quota, () => nowMs, send, { timeoutMs: 60_000 })))
      .resolves.toMatchObject({ state: 'completed' });
    releaseStale({ status: 202, body: { nextPollAt: new Date(nowMs + 1000).toISOString() } });
    await expect(stalePoll).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect(sends).toBe(3);
    expect((await backing.get(request.invocationId))?.state).toBe('SUCCEEDED');
  });

  test('a second replica recovers an expired quota lease without replaying the first replica IN_FLIGHT request', async () => {
    const backingLedger = new InMemoryInvocationLedger();
    const backingQuota = new InMemoryQuotaStore();
    let nowMs = START;
    const firstReplicaQuota = openProcessQuota(backingQuota);
    const secondReplicaQuota = openProcessQuota(backingQuota);
    const firstRequest = makeRequest('r1d-replica-crash-in-flight');

    // Seed the shared quota lease and durable claim as if replica A lost its process
    // after making the invocation visible but before it could record a terminal result.
    const abandonedLease = await firstReplicaQuota.acquire(
      'credential-shared-by-account',
      nowMs,
      100,
      1,
    );
    expect(abandonedLease?.expiresAt).toBe(START + 100);
    await backingLedger.claim(firstRequest, hashInvocationInput(firstRequest));

    let sends = 0;
    const send = async () => {
      sends += 1;
      return { status: 200, body: { content: 'recovered independent invocation' } };
    };
    nowMs += 99;

    // Replica B must honor the durable IN_FLIGHT fence while A's lease is still live.
    await expect(invokeAdapter(firstRequest, optionsFor(
      backingLedger,
      secondReplicaQuota,
      () => nowMs,
      send,
      { quotaLeaseMs: 100, maxInFlight: 1 },
    ))).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect(sends).toBe(0);
    expect((await backingLedger.get(firstRequest.invocationId))?.state).toBe('IN_FLIGHT');

    // Once A's abandoned lease expires, B can use the same account quota for new work.
    nowMs = START + 101;
    const recoveredRequest = makeRequest('r1d-replica-recovery-new-work');
    await expect(invokeAdapter(recoveredRequest, optionsFor(
      backingLedger,
      secondReplicaQuota,
      () => nowMs,
      send,
      { quotaLeaseMs: 100, maxInFlight: 1 },
    ))).resolves.toMatchObject({ state: 'completed' });
    expect(sends).toBe(1);

    // Expiry restores capacity, never permission to redispatch the ambiguous request.
    await expect(invokeAdapter(firstRequest, optionsFor(
      backingLedger,
      secondReplicaQuota,
      () => nowMs,
      send,
      { quotaLeaseMs: 100, maxInFlight: 1 },
    ))).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect(sends).toBe(1);
    expect((await backingLedger.get(firstRequest.invocationId))?.state).toBe('IN_FLIGHT');
  });

  test('account-wide quota renewal keeps a shared slot occupied across replicas', async () => {
    jest.useFakeTimers();
    let nowMs = START;
    jest.setSystemTime(nowMs);
    const backingLedger = new InMemoryInvocationLedger();
    const backingQuota = new InMemoryQuotaStore();
    const renewedExpiries: number[] = [];
    const quotaClient = (recordRenewals = false): QuotaStore => ({
      acquire: (...args) => backingQuota.acquire(...args),
      renew: async (...args) => {
        const renewed = await backingQuota.renew(...args);
        if (recordRenewals && renewed) renewedExpiries.push(renewed.expiresAt);
        return renewed;
      },
      release: (lease) => backingQuota.release(lease),
    });
    const firstReplicaQuota = quotaClient(true);
    const secondReplicaQuota = quotaClient();
    const deadlineMs = START + 10_000;
    const firstRequest = { ...makeRequest('r1d-quota-a'), deadlineAt: new Date(deadlineMs).toISOString() };
    const secondRequest = { ...makeRequest('r1d-quota-b'), tenantId: 'tenant-b', deadlineAt: new Date(deadlineMs).toISOString() };
    let finishFirst!: (response: { status: number; body: unknown }) => void;
    let announceFirst!: () => void;
    const firstStarted = new Promise<void>((resolve) => { announceFirst = resolve; });
    let sends = 0;
    const firstRun = invokeAdapter(firstRequest, optionsFor(
      backingLedger,
      firstReplicaQuota,
      () => nowMs,
      async () => {
        sends += 1;
        announceFirst();
        return new Promise<{ status: number; body: unknown }>((resolve) => { finishFirst = resolve; });
      },
      { timeoutMs: 5000, quotaLeaseMs: 100, maxInFlight: 1 },
    ));
    await firstStarted;

    const advance = async (ms: number) => {
      let remaining = ms;
      while (remaining > 0) {
        const step = Math.min(10, remaining);
        nowMs += step;
        jest.setSystemTime(nowMs);
        await jest.advanceTimersByTimeAsync(step);
        remaining -= step;
      }
    };
    await advance(120);
    expect(renewedExpiries.length).toBeGreaterThanOrEqual(2);
    expect(renewedExpiries.every((expiresAt) => expiresAt > nowMs && expiresAt <= deadlineMs)).toBe(true);
    await expect(invokeAdapter(secondRequest, optionsFor(
      backingLedger,
      secondReplicaQuota,
      () => nowMs,
      async () => {
        sends += 1;
        return { status: 200, body: { content: 'should not reach provider' } };
      },
      { timeoutMs: 5000, quotaLeaseMs: 100, maxInFlight: 1 },
    ))).rejects.toMatchObject({ code: 'QUOTA_EXHAUSTED' });
    expect(sends).toBe(1);

    finishFirst({ status: 200, body: { content: 'done' } });
    await expect(firstRun).resolves.toMatchObject({ state: 'completed' });
    expect(await backingQuota.acquire('credential-shared-by-account', nowMs, 100, 1)).toBeDefined();

    const failureLedger = new InMemoryInvocationLedger();
    const failureRequest = { ...makeRequest('r1d-quota-renew-failure'), deadlineAt: new Date(nowMs + 1000).toISOString() };
    let failureSignal: AbortSignal | undefined;
    let announceFailureSend!: () => void;
    const failureSendStarted = new Promise<void>((resolve) => { announceFailureSend = resolve; });
    let failureSends = 0;
    const failingQuota: QuotaStore = {
      acquire: async (key, currentTime) => ({ leaseId: 'lease-renew-failure', key, expiresAt: currentTime + 20 }),
      renew: async () => new Promise<undefined>(() => undefined),
      release: async () => undefined,
    };
    const failedRun = invokeAdapter(failureRequest, optionsFor(
      failureLedger,
      failingQuota,
      () => nowMs,
      async (_providerRequest, signal) => {
        failureSends += 1;
        failureSignal = signal;
        announceFailureSend();
        return new Promise<{ status: number; body: unknown }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      { timeoutMs: 5000, quotaLeaseMs: 20 },
    ));
    const failedOutcome = expect(failedRun).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    await failureSendStarted;
    nowMs += 10;
    jest.setSystemTime(nowMs);
    await jest.advanceTimersByTimeAsync(10);
    nowMs += 8;
    jest.setSystemTime(nowMs);
    await jest.advanceTimersByTimeAsync(8);
    expect(failureSignal?.aborted).toBe(true);
    await failedOutcome;
    await expect(invokeAdapter(failureRequest, optionsFor(
      failureLedger,
      failingQuota,
      () => nowMs,
      async () => {
        failureSends += 1;
        return { status: 200, body: { content: 'must not redispatch' } };
      },
      { timeoutMs: 5000, quotaLeaseMs: 20 },
    ))).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect(failureSends).toBe(1);
    expect((await failureLedger.get(failureRequest.invocationId))?.state).toBe('UNKNOWN');
  });

  test('production invocations use a bounded default quota lease window', async () => {
    const backing = new InMemoryInvocationLedger();
    const quotaBacking = new InMemoryQuotaStore();
    let requestedLeaseMs = 0;
    const quota: QuotaStore = {
      acquire: async (key, now, leaseMs, maxInFlight) => {
        requestedLeaseMs = leaseMs;
        return quotaBacking.acquire(key, now, leaseMs, maxInFlight);
      },
      renew: (...args) => quotaBacking.renew(...args),
      release: (lease) => quotaBacking.release(lease),
    };
    const request = makeRequest('r1d-default-quota-window', 120_000);

    await expect(invokeAdapter(request, optionsFor(backing, quota, () => START, async () => ({
      status: 200,
      body: { content: 'complete' },
    }), { timeoutMs: 60_000 }))).resolves.toMatchObject({ state: 'completed' });

    expect(requestedLeaseMs).toBe(30_000);
  });

  test('timeout is clamped after quota acquisition and an abort-ignoring late success stays UNKNOWN', async () => {
    jest.useFakeTimers();
    let nowMs = START;
    jest.setSystemTime(nowMs);
    const backing = new InMemoryInvocationLedger();
    const quotaBacking = new InMemoryQuotaStore();
    const request = makeRequest('r1d-timeout-clamp', 200);
    let sendSignal: AbortSignal | undefined;
    let finishLate!: (response: { status: number; body: unknown }) => void;
    let announceSend!: () => void;
    const sendStarted = new Promise<void>((resolve) => { announceSend = resolve; });
    const quota: QuotaStore = {
      acquire: async (key, acquiredAt, leaseMs, maxInFlight) => {
        const lease = await quotaBacking.acquire(key, acquiredAt, leaseMs, maxInFlight);
        nowMs += 150;
        jest.setSystemTime(nowMs);
        return lease;
      },
      renew: (...args) => quotaBacking.renew(...args),
      release: (lease) => quotaBacking.release(lease),
    };
    const invocation = invokeAdapter(request, optionsFor(
      backing,
      quota,
      () => nowMs,
      async (_providerRequest, signal) => {
        sendSignal = signal;
        announceSend();
        return new Promise<{ status: number; body: unknown }>((resolve) => { finishLate = resolve; });
      },
      { timeoutMs: 5000, quotaLeaseMs: 5000 },
    ));
    await sendStarted;
    expect(sendSignal?.aborted).toBe(false);
    nowMs += 49;
    jest.setSystemTime(nowMs);
    await jest.advanceTimersByTimeAsync(49);
    expect(sendSignal?.aborted).toBe(false);
    nowMs += 1;
    jest.setSystemTime(nowMs);
    await jest.advanceTimersByTimeAsync(1);
    expect(sendSignal?.aborted).toBe(true);
    finishLate({ status: 200, body: { content: 'late success must not commit' } });

    await expect(invocation).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    expect((await backing.get(request.invocationId))?.state).toBe('UNKNOWN');

    const shortRequest = { ...makeRequest('r1d-timeout-configured'), deadlineAt: new Date(nowMs + 200).toISOString() };
    const shortLedger = new InMemoryInvocationLedger();
    let shortSignal: AbortSignal | undefined;
    let announceShortSend!: () => void;
    const shortSendStarted = new Promise<void>((resolve) => { announceShortSend = resolve; });
    const shortRun = invokeAdapter(shortRequest, optionsFor(
      shortLedger,
      new InMemoryQuotaStore(),
      () => nowMs,
      async (_providerRequest, signal) => {
        shortSignal = signal;
        announceShortSend();
        return new Promise<{ status: number; body: unknown }>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
      },
      { timeoutMs: 25 },
    ));
    const shortOutcome = expect(shortRun).rejects.toMatchObject({ code: 'PROVIDER_TIMEOUT' });
    await shortSendStarted;
    nowMs += 24;
    jest.setSystemTime(nowMs);
    await jest.advanceTimersByTimeAsync(24);
    expect(shortSignal?.aborted).toBe(false);
    nowMs += 1;
    jest.setSystemTime(nowMs);
    await jest.advanceTimersByTimeAsync(1);
    expect(shortSignal?.aborted).toBe(true);
    await shortOutcome;
    expect((await shortLedger.get(shortRequest.invocationId))?.state).toBe('UNKNOWN');
  });

  test('usage sink timeout bounds a batch and lets later events make progress', async () => {
    jest.useFakeTimers();
    const outbox = new InMemoryUsageOutbox();
    const stuck = appendUsageEvent('r1d-usage-stuck', 1, { inputTokens: 1, measurement: 'measured' })!;
    const next = appendUsageEvent('r1d-usage-next', 1, { inputTokens: 2, measurement: 'measured' })!;
    await outbox.append(stuck);
    await outbox.append(next);
    const delivered: string[] = [];
    let stuckSignal: AbortSignal | undefined;
    const dispatcher = new UsageOutboxDispatcher(outbox, {
      send: async (event, signal) => {
        if (event.eventId === stuck.eventId) {
          stuckSignal = signal;
          return new Promise<void>(() => undefined);
        }
        delivered.push(event.eventId);
      },
    }, { sendTimeoutMs: 25, baseRetryMs: 100, maxRetryMs: 100, random: () => 0 });

    const dispatch = dispatcher.dispatchOnce();
    await jest.advanceTimersByTimeAsync(25);
    await dispatch;
    expect(delivered).toContain(next.eventId);
    expect(stuckSignal?.aborted).toBe(true);
    expect(outbox.size()).toBe(1);

    const later = appendUsageEvent('r1d-usage-later', 1, { inputTokens: 3, measurement: 'measured' })!;
    await outbox.append(later);
    await dispatcher.dispatchOnce();
    expect(delivered).toContain(later.eventId);
    await dispatcher.drain();
  });

  test('usage sink timeout and batch fan-out are clamped for offline egress', async () => {
    jest.useFakeTimers();
    const timeoutOutbox = new InMemoryUsageOutbox();
    const stuck = appendUsageEvent('r1d-usage-clamped-timeout', 1, {
      inputTokens: 1,
      measurement: 'measured',
    })!;
    await timeoutOutbox.append(stuck);
    let signal: AbortSignal | undefined;
    const timeoutDispatcher = new UsageOutboxDispatcher(timeoutOutbox, {
      send: async (_event, requestSignal) => {
        signal = requestSignal;
        return new Promise<void>(() => undefined);
      },
    }, { sendTimeoutMs: Number.MAX_SAFE_INTEGER });

    const timedOutDispatch = timeoutDispatcher.dispatchOnce();
    await jest.advanceTimersByTimeAsync(29_999);
    expect(signal?.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(1);
    await timedOutDispatch;
    expect(signal?.aborted).toBe(true);
    expect(timeoutOutbox.size()).toBe(1);
    await timeoutDispatcher.drain();

    const batchOutbox = new InMemoryUsageOutbox();
    for (let index = 0; index < 26; index += 1) {
      const event = appendUsageEvent(`r1d-usage-batch-${index}`, 1, {
        inputTokens: index + 1,
        measurement: 'measured',
      });
      await batchOutbox.append(event!);
    }
    let sent = 0;
    const batchDispatcher = new UsageOutboxDispatcher(batchOutbox, {
      send: async () => { sent += 1; },
    }, { batchSize: Number.MAX_SAFE_INTEGER });

    await batchDispatcher.dispatchOnce();

    expect(sent).toBe(25);
    expect(batchOutbox.size()).toBe(1);
    await batchDispatcher.drain();
  });
});

// ---------------------------------------------------------------------------
// R1-D-03 (Reviewer Finding 2, cycle 140): an UNKNOWN replay must surface
// through HTTP as the INVOCATION_UNKNOWN envelope — a bare 404 is reserved
// for genuinely-absent ids — and the UNKNOWN→FAILED reconciliation path is
// Pinned as a CONTRACT GAP: no existing ledger method may move an UNKNOWN
// row to a terminal state (a future reconcile API must lease-claim first).
// Offline only: in-memory ledger + real runtime + real connector HTTP
// server on an ephemeral loopback port. No production code changed here.
// ---------------------------------------------------------------------------

type ConnectorClaimLike = {
  audience: 'connector';
  tenantId: string;
  operationId: string;
  taskId: string;
  stepKey: string;
  invocationId: string;
  inputHash: string;
  connectorId: string;
  connectorRevision: string;
  bindingSlot: string;
  expiresAt: string;
};

function httpGetJson(url: string, headers: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> }> {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const http = require('node:http') as typeof import('node:http');
  return new Promise((resolve, reject) => {
    const req = http.get(url, { headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => {
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
        } catch {
          /* keep {} */
        }
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
  });
}

describe('R1-D-03 UNKNOWN surfacing + reconciliation-gap pins (offline)', () => {
  test('GET on an UNKNOWN invocation is the INVOCATION_UNKNOWN envelope, not a bare 404', async () => {
    const { createConnectorServer } = await import('../src/http/server');
    const { DurableConnectorRuntime, AesCredentialCipher } = await import('../src/services');

    const backing = new InMemoryInvocationLedger();
    const request = makeRequest('r1d-03-unknown-get');
    const inputHash = hashInvocationInput(request);
    await backing.claim(request, inputHash);
    await backing.markUnknown(request.invocationId); // from IN_FLIGHT, leaseless — legal
    expect((await backing.get(request.invocationId))?.state).toBe('UNKNOWN');

    const claim: ConnectorClaimLike = {
      audience: 'connector',
      tenantId: request.tenantId,
      operationId: request.operationId,
      taskId: request.taskId,
      stepKey: request.stepKey,
      invocationId: request.invocationId,
      inputHash,
      connectorId: 'openai',
      connectorRevision: 'openai:1',
      bindingSlot: request.bindingSlot,
      expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    };
    const grantVerifier = { verify: async (): Promise<unknown> => ({ ...claim }) };
    const runtime = new DurableConnectorRuntime(
      backing as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[0],
      {} as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[1],
      new InMemoryQuotaStore() as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[2],
      { append: async () => undefined } as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[3],
      { get: (name: string) => ({ id: name }) } as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[4],
      { send: async () => { throw new Error('transport must not be reached by GET'); } } as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[5],
      new AesCredentialCipher(new Uint8Array(32).fill(7)) as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[6],
      grantVerifier as unknown as ConstructorParameters<typeof DurableConnectorRuntime>[7],
    );

    // store-level: get() returns the unknown record, NOT undefined
    const viaRuntime = await runtime.get(request.invocationId, 'grant-opaque');
    expect(viaRuntime).toBeDefined();
    expect(viaRuntime?.state).toBe('unknown');
    expect(viaRuntime?.error?.code).toBe('INVOCATION_UNKNOWN');

    const server = createConnectorServer({
      management: {
        list: async () => [],
        get: async () => undefined,
        getRevision: async () => undefined,
        getCurrentRevision: async () => undefined,
        createRevision: async () => { throw new Error('unused'); },
        bootstrapRevision: async () => { throw new Error('unused'); },
    createPendingRevision: async () => { throw new Error('unused'); },
        activateRevision: async () => false,
        retireRevision: async () => undefined,
        rotateCredential: async () => undefined,
        disable: async () => undefined,
        test: async () => ({ ok: true }),
      },
      runtime,
      capabilities: () => ({}),
      ready: async () => true,
    });
    const { listenLoopback } = await import('../../../tests/harness/listen-loopback');
    // quiet band (see cycle 102): dynamic ports on this box intermittently
    // FILTER connections (ETIMEDOUT) — bind deterministic + EADDRINUSE-advance
    const port = await listenLoopback(server, 41420 + ((process.pid % 32) * 8), 32);
    try {
      const hit = await httpGetJson(`http://127.0.0.1:${port}/invocations/${request.invocationId}`, {
        'x-invocation-grant': 'grant-opaque',
      });
      expect(hit.status).toBe(200);
      // wire = CONTRACT shape (uppercase states, contracts InvocationResponse);
      // the lowercase 'unknown' is the internal HttpInvocationResult — both
      // layers are pinned here so a 404 can never masquerade as UNKNOWN.
      expect(hit.body).toMatchObject({ state: 'UNKNOWN', invocationId: request.invocationId });
      expect((hit.body.error as Record<string, unknown>).code).toBe('INVOCATION_UNKNOWN');

      // a genuinely-absent id IS the bare 404 — the two cases stay distinguishable
      const miss = await httpGetJson('http://127.0.0.1:' + port + '/invocations/never-existed', {
        'x-invocation-grant': 'grant-opaque',
      });
      expect(miss.status).toBe(404);
      expect((miss.body.error as Record<string, unknown>).code).toBe('NOT_FOUND');
    } finally {
      await new Promise<void>((resolve, reject) => server.close((e) => (e ? reject(e) : resolve())));
    }
  });

  test('FAILED is assignable from live states (IN_FLIGHT) — the reviewer premise that FAILED exists only at creation is pinned FALSE', async () => {
    const backing = new InMemoryInvocationLedger();
    const request = makeRequest('r1d-03-fail-inflight');
    await backing.claim(request, hashInvocationInput(request));
    const failed = await backing.fail(request.invocationId, 'PROVIDER_TIMEOUT');
    expect(failed.state).toBe('FAILED');
    expect(failed.errorCode).toBe('PROVIDER_TIMEOUT');
  });

  test('UNKNOWN is sticky: EVERY existing ledger mutation refuses to reconcile it (gap pin, no production change)', async () => {
    const backing = new InMemoryInvocationLedger();
    const request = makeRequest('r1d-03-sticky');
    const inputHash = hashInvocationInput(request);
    await backing.claim(request, inputHash);
    await backing.markUnknown(request.invocationId);

    await expect(backing.fail(request.invocationId, 'PROVIDER_TIMEOUT')).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    await expect(backing.fail(request.invocationId, 'PROVIDER_TIMEOUT', 'stale-lease')).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    await expect(backing.complete(request.invocationId, { content: 'late success' })).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    await expect(backing.cancel(request.invocationId)).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    await expect(backing.markPending(request.invocationId, new Date(START + 1000).toISOString())).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    await expect(backing.failPending(request.invocationId, inputHash, 'CANCELLED')).resolves.toBe(false);
    expect(await backing.claimPendingPoll(request.invocationId, inputHash, START + 10_000, 1000)).toBeUndefined();
    // and re-invoking the same id replays the fence, never re-dispatches:
    await expect(invokeAdapter(request, optionsFor(
      backing,
      new InMemoryQuotaStore(),
      () => START,
      async () => { throw new Error('provider must not be reached'); },
    ))).rejects.toMatchObject({ code: 'INVOCATION_UNKNOWN' });
    expect((await backing.get(request.invocationId))?.state).toBe('UNKNOWN');
    // R1-D-03 REMAINS OPEN: a reconcile API (UNKNOWN -> POLLING via a fresh
    // lease, then complete/fail with that token) is NOT implemented and is
    // deliberately not claimed here — this test pins WHY it is required.
  });
});
