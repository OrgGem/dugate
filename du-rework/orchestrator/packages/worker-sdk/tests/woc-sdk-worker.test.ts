import { randomUUID } from 'node:crypto';
import {
  BusinessJobV1,
  ClaimResult,
  businessQueueName,
  validateManifest,
} from '@du/contracts';
import { defineBusiness, QueueConsumer, startWorker } from '../src';

const TASK_ID = randomUUID();
const OPERATION_ID = randomUUID();

const MANIFEST = {
  contractVersion: '1',
  businessId: 'woc-sdk-biz',
  displayName: 'WOC SDK Test Business',
  description: 'WOC SDK worker regression fixtures',
  version: '1.0.0',
  imageDigest: 'sha256:woc-sdk',
  runtime: { wireVersion: '1', handlerKinds: ['root', 'child'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [{
    name: 'run',
    displayName: 'Run',
    description: 'WOC regression action',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    profileSchema: { type: 'object' },
    connectorSlots: [],
    artifactPolicy: { minFiles: 0, maxFiles: 1 },
    capabilities: { cancel: true, resume: true },
    defaultLimits: { maxParallelTasks: 1 },
  }],
};
const manifestValidation = validateManifest(MANIFEST);
if (!manifestValidation.ok) throw new Error('WOC SDK manifest fixture is invalid');
const MANIFEST_DIGEST = manifestValidation.digest;

type DeliveryHandler = Parameters<QueueConsumer['start']>[0];
type DeliveryControl = NonNullable<Parameters<DeliveryHandler>[1]>;

interface Route {
  method: string;
  pattern: RegExp;
  handler: (match: RegExpMatchArray, body: unknown) =>
    { status: number; json: unknown } | Promise<{ status: number; json: unknown }>;
}

interface CapturedCall {
  path: string;
  method: string;
  body?: unknown;
  at: number;
}

function stubFetch(routes: Route[], calls: CapturedCall[] = []): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const path = url.replace(/^http:\/\/runtime/, '');
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body, at: Date.now() });
    for (const route of routes) {
      if (route.method !== method) continue;
      const match = route.pattern.exec(path);
      if (!match) continue;
      const result = await route.handler(match, body);
      return new Response(JSON.stringify(result.json), {
        status: result.status,
        headers: { 'content-type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({
      type: 'urn:du:error:not_found',
      status: 404,
      code: 'NOT_FOUND',
      title: `no route for ${method} ${path}`,
    }), { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function workerHeartbeatRoute(backupEffectFence?: unknown): Route {
  const ack = {
    health: 'HEALTHY',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    capacity: 1,
    controlRevision: 0,
    controlState: 'OPEN',
    activeVersion: MANIFEST.version,
    activationRevision: 1,
    admissionEligible: true,
    admissionReason: 'ELIGIBLE',
    ...(backupEffectFence === undefined ? {} : { backupEffectFence }),
  };
  return {
    method: 'PUT',
    pattern: /^\/workers\/[^/]+\/heartbeat$/,
    handler: () => ({ status: 200, json: ack }),
  };
}

function workerRetirementRoute(): Route {
  return {
    method: 'POST',
    pattern: /^\/workers\/[^/]+\/retire$/,
    handler: () => ({ status: 200, json: { retired: true } }),
  };
}

function replaceWorkerHeartbeatRoute(routes: Route[], replacement: Route): void {
  const index = routes.findIndex((route) => route.method === 'PUT' && route.pattern.test('/workers/fixture/heartbeat'));
  if (index < 0) throw new Error('worker heartbeat fixture route is missing');
  routes[index] = replacement;
}

function businessRegistrationRoute(result: Record<string, unknown> = {}): Route {
  return {
    method: 'PUT',
    pattern: /^\/businesses\/[^/]+\/versions\/[^/]+$/,
    handler: () => ({ status: 201, json: {
      businessId: MANIFEST.businessId,
      version: MANIFEST.version,
      digest: MANIFEST_DIGEST,
      queue: businessQueueName(MANIFEST.businessId, MANIFEST.version),
      created: true,
      replayed: false,
      ...result,
    } }),
  };
}

function taskHeartbeatRoute(
  handler: () => { status: number; json: unknown } | Promise<{ status: number; json: unknown }> = () => ({
    status: 200,
    json: { leaseEpoch: 1, cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() },
  })
): Route {
  return { method: 'POST', pattern: /^\/tasks\/[^/]+\/heartbeat$/, handler };
}

function replaceTaskHeartbeatRoute(routes: Route[], replacement: Route): void {
  const index = routes.findIndex((route) => route.method === 'POST' && route.pattern.test('/tasks/fixture/heartbeat'));
  if (index < 0) throw new Error('task heartbeat fixture route is missing');
  routes[index] = replacement;
}

function makeClaim(options: {
  taskId?: string;
  operationId?: string;
  leaseMs?: number;
  leaseExpiresAt?: string;
  snapshot?: Partial<ClaimResult['executionSnapshot']>;
} = {}): ClaimResult {
  const taskId = options.taskId ?? TASK_ID;
  const operationId = options.operationId ?? OPERATION_ID;
  return {
    taskId,
    operationId,
    leaseEpoch: 1,
    leaseExpiresAt: options.leaseExpiresAt ?? new Date(Date.now() + (options.leaseMs ?? 60_000)).toISOString(),
    attempt: 1,
    deadlineAt: null,
    executionSnapshot: {
      operationId,
      tenantId: 'woc-tenant',
      businessId: 'woc-sdk-biz',
      businessVersion: '1.0.0',
      action: 'run',
      schemaDigest: 'sha256:schema',
      manifestDigest: MANIFEST_DIGEST,
      resolvedInputRef: { source: 'fixture' },
      pinned: { profileRevision: 1, promptRevisions: {}, connectorBindings: {} },
      taskKey: 'root',
      kind: 'root',
      payloadRef: {},
      deadlineAt: null,
      cancelRequested: false,
      ...options.snapshot,
    },
    checkpointRefs: [],
  } as ClaimResult;
}

function makeJob(overrides: Partial<BusinessJobV1> = {}): BusinessJobV1 {
  return {
    contractVersion: '1',
    deliveryId: `delivery-${randomUUID()}`,
    taskId: TASK_ID,
    operationId: OPERATION_ID,
    businessId: 'woc-sdk-biz',
    businessVersion: '1.0.0',
    action: 'run',
    kind: 'root',
    correlationId: 'corr-woc-sdk',
    attempt: 1,
    ...overrides,
  } as BusinessJobV1;
}

function testConsumer(options: { waitForDeliveries?: boolean } = {}): {
  consumer: QueueConsumer;
  push: (job: BusinessJobV1, delivery?: DeliveryControl) => Promise<void>;
  started: jest.Mock;
  stopped: jest.Mock;
  paused: jest.Mock;
  resumed: jest.Mock;
} {
  let handler: DeliveryHandler | undefined;
  const deliveries: Promise<void>[] = [];
  const started = jest.fn();
  const paused = jest.fn();
  const resumed = jest.fn();
  const stopped = jest.fn(async () => {
    if (options.waitForDeliveries !== false) await Promise.allSettled(deliveries);
  });
  const consumer: QueueConsumer = {
    start(next) {
      started();
      handler = next;
    },
    pause: paused,
    resume: resumed,
    stop: stopped,
  };
  const push = (job: BusinessJobV1, delivery?: DeliveryControl): Promise<void> => {
    if (!handler) throw new Error('consumer not started');
    const result = handler(job, delivery);
    deliveries.push(result);
    return result;
  };
  return { consumer, push, started, stopped, paused, resumed };
}

function successRoutes(claim: (match: RegExpMatchArray, body: unknown) => { status: number; json: unknown } | Promise<{ status: number; json: unknown }>): Route[] {
  return [
    businessRegistrationRoute(),
    workerHeartbeatRoute({ state: 'OPEN', revision: 0, acknowledged: true }),
    workerRetirementRoute(),
    taskHeartbeatRoute(),
    {
      method: 'POST',
      pattern: /^\/tasks\/([^/]+)\/claim$/,
      handler: (match, body) => claim(match, body),
    },
    {
      method: 'POST',
      pattern: /^\/tasks\/[^/]+\/complete$/,
      handler: () => ({ status: 200, json: {
        taskId: TASK_ID,
        state: 'SUCCEEDED',
        operationState: 'SUCCEEDED',
        replayed: false,
      } }),
    },
    {
      method: 'POST',
      pattern: /^\/tasks\/[^/]+\/fail$/,
      handler: () => ({ status: 200, json: {
        taskId: TASK_ID,
        state: 'FAILED',
        operationState: 'FAILED',
        replayed: false,
      } }),
    },
  ];
}

const commonConfig = {
  runtimeUrl: 'http://runtime',
  runtimeToken: 'test-token',
  tempSweep: { enabled: false },
};

describe('WOC SDK claim outcomes and pinned execution snapshot', () => {
  it('defers attempt exhaustion unless the Runtime returns its durable terminal response', async () => {
    const calls: CapturedCall[] = [];
    let status = 409;
    let handlerCalls = 0;
    const routes = successRoutes(() => ({
      status,
      json: {
        type: 'urn:du:error:task_attempts_exhausted',
        status,
        code: 'TASK_ATTEMPTS_EXHAUSTED',
        title: 'task attempts are exhausted',
      },
    }));
    const { consumer, push } = testConsumer();
    const definition = defineBusiness(MANIFEST, {
      root: async () => {
        handlerCalls += 1;
        return { kind: 'completed', resultRef: 'artifact://must-not-run' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch(routes, calls),
    });
    const deferred = new Error('attempt-exhaustion-not-terminal-deferred');
    await expect(push(makeJob(), { defer: async () => { throw deferred; } })).rejects.toBe(deferred);
    status = 410;
    await push(makeJob({ deliveryId: 'durably-terminal-attempt-cap' }));
    await handle.stop(1000);

    expect(handlerCalls).toBe(0);
    expect(calls.filter((call) => call.path.endsWith('/claim'))).toHaveLength(2);
  });

  it('retries a deferred admission outcome after bounded delay without requiring a custom consumer hook', async () => {
    jest.useFakeTimers();
    try {
      const calls: CapturedCall[] = [];
      let claimCount = 0;
      const routes = successRoutes(() => {
        claimCount += 1;
        if (claimCount === 1) {
          return { status: 409, json: {
            type: 'urn:du:error:admission_paused',
            status: 409,
            code: 'ADMISSION_PAUSED',
            title: 'admission is paused',
          } };
        }
        return { status: 200, json: makeClaim() };
      });
      const { consumer, push } = testConsumer();
      let handled = 0;
      const definition = defineBusiness(MANIFEST, {
        root: async () => { handled += 1; return { kind: 'completed', resultRef: 'artifact://woc-result' }; },
        child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
      });
      const handle = await startWorker(definition, { ...commonConfig, consumer, fetchImpl: stubFetch(routes, calls) });
      const delivery = push(makeJob());
      for (let turn = 0; turn < 12 && claimCount === 0; turn += 1) await Promise.resolve();
      expect(claimCount).toBe(1);
      expect(handled).toBe(0);

      await jest.advanceTimersByTimeAsync(124);
      expect(claimCount).toBe(1);
      await jest.advanceTimersByTimeAsync(200);
      await delivery;
      await handle.stop(1000);

      const claimTimes = calls.filter((call) => call.path.endsWith('/claim')).map((call) => call.at);
      expect(claimTimes).toHaveLength(2);
      expect(claimTimes[1]! - claimTimes[0]!).toBeGreaterThanOrEqual(125);
      expect(claimTimes[1]! - claimTimes[0]!).toBeLessThanOrEqual(250);
      expect(handled).toBe(1);
      expect(calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps an unknown legacy 409 recoverable instead of treating status alone as ACK-safe', async () => {
    const calls: CapturedCall[] = [];
    const routes = successRoutes(() => ({
      status: 409,
      json: { type: 'urn:du:error:state_conflict', status: 409, code: 'STATE_CONFLICT', title: 'legacy outcome' },
    }));
    const { consumer, push } = testConsumer();
    const definition = defineBusiness(MANIFEST, {
      root: async () => ({ kind: 'completed', resultRef: 'artifact://must-not-run' }),
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, { ...commonConfig, consumer, fetchImpl: stubFetch(routes, calls) });
    const defer = jest.fn(async (_delayMs: number): Promise<never> => { throw new Error('deferred-for-recovery'); });

    await expect(push(makeJob(), { defer })).rejects.toThrow('deferred-for-recovery');
    await handle.stop(1000);

    expect(defer).toHaveBeenCalledTimes(1);
    expect(defer.mock.calls[0]![0]).toBeGreaterThanOrEqual(125);
    expect(calls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail'))).toBe(false);
  });

  it('selects the handler from the claimed snapshot kind, not the queue kind', async () => {
    const calls: CapturedCall[] = [];
    const routes = successRoutes(() => ({ status: 200, json: makeClaim() }));
    const { consumer, push } = testConsumer();
    const handlers: string[] = [];
    const definition = defineBusiness(MANIFEST, {
      root: async () => { handlers.push('root'); return { kind: 'completed', resultRef: 'artifact://root-result' }; },
      child: async () => { handlers.push('child'); return { kind: 'completed', resultRef: 'artifact://child-result' }; },
    });
    const handle = await startWorker(definition, { ...commonConfig, consumer, fetchImpl: stubFetch(routes, calls) });

    await push(makeJob({ kind: 'child' }));
    await handle.stop(1000);

    expect(handlers).toEqual(['root']);
    expect(calls.find((call) => call.path.endsWith('/complete'))?.body).toMatchObject({ resultRef: 'artifact://root-result' });
  });

  it.each([
    ['businessId', { businessId: 'other-business' }],
    ['businessVersion', { businessVersion: '2.0.0' }],
    ['manifestDigest', { manifestDigest: 'sha256:wrong-pin' }],
  ] as const)('defers a claim whose pinned %s differs from this worker', async (_field, snapshotPatch) => {
    const calls: CapturedCall[] = [];
    const base = makeClaim();
    const mismatch = makeClaim({ snapshot: { ...base.executionSnapshot, ...snapshotPatch } });
    const routes = successRoutes(() => ({ status: 200, json: mismatch }));
    const { consumer, push } = testConsumer();
    let handled = 0;
    const definition = defineBusiness(MANIFEST, {
      root: async () => { handled += 1; return { kind: 'completed', resultRef: 'artifact://must-not-run' }; },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, { ...commonConfig, consumer, fetchImpl: stubFetch(routes, calls) });
    const defer = jest.fn(async (_delayMs: number): Promise<never> => { throw new Error('incompatible-pin-deferred'); });

    await expect(push(makeJob(), { defer })).rejects.toThrow('incompatible-pin-deferred');
    await handle.stop(1000);

    expect(handled).toBe(0);
    expect(defer).toHaveBeenCalledTimes(1);
    expect(defer.mock.calls[0]![0]).toBeGreaterThan(55_000);
    expect(calls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail'))).toBe(false);
  });
});

describe('WOC SDK same-instance task single-flight', () => {
  afterEach(() => jest.useRealTimers());

  it('defers concurrent duplicates while allowing another task to run', async () => {
    const taskId = randomUUID();
    const otherTaskId = randomUUID();
    const operationId = randomUUID();
    const otherOperationId = randomUUID();
    const calls: CapturedCall[] = [];
    const claimCount = new Map<string, number>();
    const routes = successRoutes((match) => {
      const claimedTaskId = match[1]!;
      claimCount.set(claimedTaskId, (claimCount.get(claimedTaskId) ?? 0) + 1);
      return {
        status: 200,
        json: makeClaim({
          taskId: claimedTaskId,
          operationId: claimedTaskId === taskId ? operationId : otherOperationId,
        }),
      };
    });
    const { consumer, push } = testConsumer({ waitForDeliveries: false });
    let firstHandlerCount = 0;
    let otherHandlerCount = 0;
    let resolveFirst!: (value: { kind: 'completed'; resultRef: string }) => void;
    const definition = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        if (ctx.taskId === taskId) {
          firstHandlerCount += 1;
          return await new Promise((resolve) => { resolveFirst = resolve; });
        }
        otherHandlerCount += 1;
        return { kind: 'completed', resultRef: 'artifact://other-task' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, { ...commonConfig, consumer, fetchImpl: stubFetch(routes, calls) });
    const firstJob = makeJob({ taskId, operationId });
    const firstDelivery = push(firstJob, { defer: async () => { throw new Error('first-delivery-should-stay-active'); } });
    for (let turn = 0; turn < 15 && firstHandlerCount === 0; turn += 1) await Promise.resolve();
    expect(firstHandlerCount).toBe(1);

    const duplicateDeferred = new Error('duplicate-delivery-delayed');
    await expect(push(firstJob, { defer: async () => { throw duplicateDeferred; } })).rejects.toBe(duplicateDeferred);
    expect(claimCount.get(taskId)).toBe(1);
    expect(firstHandlerCount).toBe(1);

    await push(makeJob({ taskId: otherTaskId, operationId: otherOperationId }));
    expect(claimCount.get(otherTaskId)).toBe(1);
    expect(otherHandlerCount).toBe(1);
    expect(firstHandlerCount).toBe(1);

    resolveFirst({ kind: 'completed', resultRef: 'artifact://first-task' });
    await firstDelivery;
    await handle.stop(100);

    expect(calls.filter((call) => call.path === `/tasks/${taskId}/claim`)).toHaveLength(1);
    expect(calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(2);
    expect(calls.some((call) => call.path.endsWith('/fail'))).toBe(false);
  });

  it('reconciles a lost claim ACK once with the same delivery before releasing its reservation', async () => {
    const taskId = randomUUID();
    const operationId = randomUUID();
    const calls: CapturedCall[] = [];
    let claimAttempts = 0;
    const routes = successRoutes((match) => {
      claimAttempts += 1;
      if (claimAttempts === 1) {
        return {
          status: 503,
          json: { type: 'urn:du:error:temporary_unavailable', status: 503, code: 'TEMPORARY_UNAVAILABLE', title: 'lost claim ACK' },
        };
      }
      return { status: 200, json: makeClaim({ taskId: match[1]!, operationId }) };
    });
    const { consumer, push } = testConsumer();
    let handlerCount = 0;
    const definition = defineBusiness(MANIFEST, {
      root: async () => {
        handlerCount += 1;
        return { kind: 'completed', resultRef: 'artifact://claim-retry' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, { ...commonConfig, consumer, fetchImpl: stubFetch(routes, calls) });
    const job = makeJob({ taskId, operationId });
    const defer = jest.fn(async (_delayMs: number): Promise<never> => { throw new Error('ambiguous claim was unnecessarily deferred'); });
    await push(job, { defer });
    await handle.stop(100);

    expect(claimAttempts).toBe(2);
    expect(defer).not.toHaveBeenCalled();
    expect(handlerCount).toBe(1);
    expect(calls.filter((call) => call.path === `/tasks/${taskId}/claim`)).toHaveLength(2);
    expect(calls.filter((call) => call.path.endsWith('/fail'))).toHaveLength(0);
    expect(calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(1);
  });

  it('keeps the guard through lease expiry until an uncooperative handler settles', async () => {
    jest.useFakeTimers();
    const taskId = randomUUID();
    const operationId = randomUUID();
    const calls: CapturedCall[] = [];
    let claimAttempts = 0;
    const routes = successRoutes((match) => {
      claimAttempts += 1;
      return { status: 200, json: makeClaim({ taskId: match[1]!, operationId, leaseMs: 160 }) };
    });
    replaceTaskHeartbeatRoute(routes, taskHeartbeatRoute(() => ({
      status: 503,
      json: { type: 'urn:du:error:temporary_unavailable', status: 503, code: 'TEMPORARY_UNAVAILABLE', title: 'offline' },
    })));
    const { consumer, push } = testConsumer({ waitForDeliveries: false });
    let handlerCount = 0;
    let signal: AbortSignal | undefined;
    let resolveOldHandler!: (value: { kind: 'completed'; resultRef: string }) => void;
    const definition = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        handlerCount += 1;
        if (handlerCount === 1) {
          signal = ctx.signal;
          return await new Promise((resolve) => { resolveOldHandler = resolve; });
        }
        return { kind: 'completed', resultRef: 'artifact://after-settlement' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch(routes, calls),
      heartbeatIntervalMs: 20,
      leaseSafetyMarginMs: 20,
    });
    const job = makeJob({ taskId, operationId });
    const firstDeferred = new Error('expired-handler-recoverable');
    const firstDelivery = push(job, { defer: async () => { throw firstDeferred; } });
    for (let turn = 0; turn < 15 && !signal; turn += 1) await Promise.resolve();
    expect(signal).toBeDefined();

    await jest.advanceTimersByTimeAsync(150);
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBe('lease-lost');

    const duplicateDeferred = new Error('expired-task-duplicate-delayed');
    await expect(push(job, { defer: async () => { throw duplicateDeferred; } })).rejects.toBe(duplicateDeferred);
    expect(claimAttempts).toBe(1);
    expect(handlerCount).toBe(1);

    resolveOldHandler({ kind: 'completed', resultRef: 'artifact://late-handler-result' });
    await expect(firstDelivery).rejects.toBe(firstDeferred);
    await push(job, { defer: async () => { throw new Error('released retry should complete'); } });
    await handle.stop(0);

    expect(claimAttempts).toBe(2);
    expect(handlerCount).toBe(2);
    expect(calls.filter((call) => call.path === `/tasks/${taskId}/claim`)).toHaveLength(2);
    expect(calls.filter((call) => call.path.endsWith('/fail'))).toHaveLength(0);
    expect(calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(1);
  });
});

describe('WOC SDK lease watchdog', () => {
  afterEach(() => jest.useRealTimers());

  it('bounds watchdog timers for far-future lease fixtures instead of overflowing into an immediate abort', async () => {
    jest.useFakeTimers();
    const calls: CapturedCall[] = [];
    const routes = successRoutes(() => ({
      status: 200,
      json: makeClaim({ leaseExpiresAt: '9999-12-31T23:59:59.999Z' }),
    }));
    const { consumer, push } = testConsumer({ waitForDeliveries: false });
    let resolveHandler!: (value: { kind: 'completed'; resultRef: string }) => void;
    let signal: AbortSignal | undefined;
    const definition = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        signal = ctx.signal;
        return await new Promise((resolve) => { resolveHandler = resolve; });
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch(routes, calls),
    });
    const delivery = push(makeJob(), { defer: async (): Promise<never> => { throw new Error('far-future-recovery-deferred'); } });
    for (let turn = 0; turn < 15 && !signal; turn += 1) await Promise.resolve();
    expect(signal).toBeDefined();
    await jest.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(false);

    await handle.stop(0);
    resolveHandler({ kind: 'completed', resultRef: 'artifact://too-late-after-stop' });
    await expect(delivery).rejects.toThrow('far-future-recovery-deferred');
    expect(calls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail'))).toBe(false);
  });

  it('aborts at the confirmed lease safety deadline when heartbeat transport fails', async () => {
    jest.useFakeTimers();
    const calls: CapturedCall[] = [];
    const routes = successRoutes(() => ({ status: 200, json: makeClaim({ leaseMs: 160 }) }));
    replaceTaskHeartbeatRoute(routes, taskHeartbeatRoute(() => ({
      status: 503,
      json: { type: 'urn:du:error:temporary_unavailable', status: 503, code: 'TEMPORARY_UNAVAILABLE', title: 'offline' },
    })));
    const { consumer, push } = testConsumer({ waitForDeliveries: false });
    let resolveHandler!: (value: { kind: 'completed'; resultRef: string }) => void;
    let seenSignal: AbortSignal | undefined;
    const definition = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        seenSignal = ctx.signal;
        return await new Promise((resolve) => { resolveHandler = resolve; });
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch(routes, calls),
      heartbeatIntervalMs: 20,
      leaseSafetyMarginMs: 20,
    });
    const defer = async (): Promise<never> => { throw new Error('lease-recovery-deferred'); };
    const delivery = push(makeJob(), { defer });
    for (let turn = 0; turn < 15 && !seenSignal; turn += 1) await Promise.resolve();
    expect(seenSignal).toBeDefined();

    await jest.advanceTimersByTimeAsync(150);
    expect(seenSignal!.aborted).toBe(true);
    expect(seenSignal!.reason).toBe('lease-lost');
    resolveHandler({ kind: 'completed', resultRef: 'artifact://late-result' });
    await expect(delivery).rejects.toThrow('lease-recovery-deferred');
    await handle.stop(0);

    expect(calls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail'))).toBe(false);
  });

  it('a valid heartbeat renewal extends the deadline and a late ACK cannot revive an expired lease', async () => {
    jest.useFakeTimers();
    const calls: CapturedCall[] = [];
    let lateHeartbeatResolve: (() => void) | undefined;
    const routes = successRoutes(() => ({ status: 200, json: makeClaim({ leaseMs: 160 }) }));
    replaceTaskHeartbeatRoute(routes, taskHeartbeatRoute(() => ({
      status: 200,
      json: { leaseEpoch: 1, cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 500).toISOString() },
    })));
    const { consumer, push } = testConsumer({ waitForDeliveries: false });
    let resolveHandler!: (value: { kind: 'completed'; resultRef: string }) => void;
    let signal: AbortSignal | undefined;
    const definition = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        signal = ctx.signal;
        return await new Promise((resolve) => { resolveHandler = resolve; });
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch(routes, calls),
      heartbeatIntervalMs: 20,
      leaseSafetyMarginMs: 20,
    });
    const pending = push(makeJob());
    for (let turn = 0; turn < 15 && !signal; turn += 1) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(200);
    expect(signal!.aborted).toBe(false);
    resolveHandler({ kind: 'completed', resultRef: 'artifact://renewed-result' });
    await pending;
    await handle.stop(0);
    expect(calls.some((call) => call.path.endsWith('/complete'))).toBe(true);

    // A separate task below holds its heartbeat response past the old lease
    // deadline. The late extension response must not revive the aborted task.
    jest.useRealTimers();
    jest.useFakeTimers();
    const lateCalls: CapturedCall[] = [];
    const lateRoutes = successRoutes(() => ({ status: 200, json: makeClaim({ leaseMs: 160 }) }));
    replaceTaskHeartbeatRoute(lateRoutes, taskHeartbeatRoute(() => new Promise((resolve) => {
      lateHeartbeatResolve = () => resolve({
        status: 200,
        json: {
          leaseEpoch: 1,
          cancelRequested: false,
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        },
      });
    })));
    const lateConsumer = testConsumer({ waitForDeliveries: false });
    let resolveLateHandler!: (value: { kind: 'completed'; resultRef: string }) => void;
    let lateSignal: AbortSignal | undefined;
    const lateDefinition = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        lateSignal = ctx.signal;
        return await new Promise((resolve) => { resolveLateHandler = resolve; });
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const lateHandle = await startWorker(lateDefinition, {
      ...commonConfig,
      consumer: lateConsumer.consumer,
      fetchImpl: stubFetch(lateRoutes, lateCalls),
      heartbeatIntervalMs: 20,
      leaseSafetyMarginMs: 20,
    });
    const delayed = lateConsumer.push(makeJob(), { defer: async (): Promise<never> => { throw new Error('late-recovery-deferred'); } });
    for (let turn = 0; turn < 15 && !lateSignal; turn += 1) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(20);
    expect(lateHeartbeatResolve).toBeDefined();
    await jest.advanceTimersByTimeAsync(130);
    expect(lateSignal!.aborted).toBe(true);
    expect(lateSignal!.reason).toBe('lease-lost');
    lateHeartbeatResolve!();
    await Promise.resolve();
    resolveLateHandler({ kind: 'completed', resultRef: 'artifact://too-late' });
    await expect(delayed).rejects.toThrow('late-recovery-deferred');
    await lateHandle.stop(0);
    expect(lateCalls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail'))).toBe(false);
  });

  it('accepts a valid shorter lease renewal and bounds its safety margin to that grant', async () => {
    jest.useFakeTimers();
    const calls: CapturedCall[] = [];
    let heartbeatCount = 0;
    const routes = successRoutes(() => ({ status: 200, json: makeClaim({ leaseMs: 160 }) }));
    replaceTaskHeartbeatRoute(routes, taskHeartbeatRoute(() => {
      heartbeatCount += 1;
      return heartbeatCount === 1
        ? {
          status: 200,
          json: { leaseEpoch: 1, cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 15).toISOString() },
        }
        : {
          status: 503,
          json: { type: 'urn:du:error:temporary_unavailable', status: 503, code: 'TEMPORARY_UNAVAILABLE', title: 'offline' },
        };
    }));
    const { consumer, push } = testConsumer({ waitForDeliveries: false });
    let resolveHandler!: (value: { kind: 'completed'; resultRef: string }) => void;
    let signal: AbortSignal | undefined;
    const definition = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        signal = ctx.signal;
        return await new Promise((resolve) => { resolveHandler = resolve; });
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch(routes, calls),
      heartbeatIntervalMs: 1,
      leaseSafetyMarginMs: 20,
    });
    const delivery = push(makeJob(), { defer: async (): Promise<never> => { throw new Error('short-lease-recovery'); } });
    for (let turn = 0; turn < 15 && !signal; turn += 1) await Promise.resolve();
    await jest.advanceTimersByTimeAsync(1);
    expect(signal).toBeDefined();
    expect(signal!.aborted).toBe(false);

    await jest.advanceTimersByTimeAsync(1);
    expect(signal!.aborted).toBe(false);
    await jest.advanceTimersByTimeAsync(20);
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBe('lease-lost');
    resolveHandler({ kind: 'completed', resultRef: 'artifact://too-late-short-renewal' });
    await expect(delivery).rejects.toThrow('short-lease-recovery');
    await handle.stop(0);
    expect(calls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail'))).toBe(false);
  });

  it('aborts an uncooperative handler at shutdown and keeps a late completion from being reported', async () => {
    jest.useFakeTimers();
    const calls: CapturedCall[] = [];
    const routes = successRoutes(() => ({ status: 200, json: makeClaim() }));
    const { consumer, push } = testConsumer({ waitForDeliveries: false });
    let resolveHandler!: (value: { kind: 'completed'; resultRef: string }) => void;
    let signal: AbortSignal | undefined;
    const definition = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        signal = ctx.signal;
        return await new Promise((resolve) => { resolveHandler = resolve; });
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch(routes, calls),
    });
    const delivery = push(makeJob(), { defer: async (): Promise<never> => { throw new Error('shutdown-recovery-deferred'); } });
    for (let turn = 0; turn < 15 && !signal; turn += 1) await Promise.resolve();
    expect(signal).toBeDefined();

    await handle.stop(0);
    expect(signal!.aborted).toBe(true);
    expect(signal!.reason).toBe('shutdown');
    const duplicateShutdown = new Error('shutdown-duplicate-delayed');
    await expect(push(makeJob(), { defer: async () => { throw duplicateShutdown; } })).rejects.toBe(duplicateShutdown);
    resolveHandler({ kind: 'completed', resultRef: 'artifact://too-late-after-shutdown' });
    await expect(delivery).rejects.toThrow('shutdown-recovery-deferred');

    expect(calls.filter((call) => call.path.endsWith('/claim'))).toHaveLength(1);
    expect(calls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail'))).toBe(false);
  });

  it('does not start a claim that resolves after shutdown begins', async () => {
    let resolveClaim!: (value: { status: number; json: unknown }) => void;
    const calls: CapturedCall[] = [];
    const routes = successRoutes(() => new Promise<{ status: number; json: unknown }>((resolve) => { resolveClaim = resolve; }));
    const { consumer, push } = testConsumer({ waitForDeliveries: false });
    let handled = 0;
    const definition = defineBusiness(MANIFEST, {
      root: async () => { handled += 1; return { kind: 'completed', resultRef: 'artifact://must-not-run' }; },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch(routes, calls),
    });
    const delivery = push(makeJob(), { defer: async (): Promise<never> => { throw new Error('post-shutdown-claim-recovery'); } });
    for (let turn = 0; turn < 15 && !resolveClaim; turn += 1) await Promise.resolve();
    expect(resolveClaim).toBeDefined();
    expect(calls.some((call) => call.path.endsWith('/claim'))).toBe(true);

    await handle.stop(0);
    resolveClaim({ status: 200, json: makeClaim() });
    await expect(delivery).rejects.toThrow('post-shutdown-claim-recovery');

    expect(handled).toBe(0);
    expect(calls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail'))).toBe(false);
  });
});

describe('WOC SDK heartbeat compatibility', () => {
  it('refuses a legacy heartbeat ACK without backupEffectFence before consuming claims', async () => {
    const calls: CapturedCall[] = [];
    const { consumer, started, stopped } = testConsumer();
    const definition = defineBusiness(MANIFEST, {
      root: async () => ({ kind: 'completed', resultRef: 'artifact://must-not-run' }),
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });

    await expect(startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch([businessRegistrationRoute(), workerHeartbeatRoute()], calls),
    })).rejects.toMatchObject({ code: 'WORKER_COMPATIBILITY_REQUIRED' });

    expect(started).not.toHaveBeenCalled();
    expect(stopped).toHaveBeenCalledTimes(1);
    expect(calls.some((call) => call.path.endsWith('/claim'))).toBe(false);
  });

  it('waits for an ordinary in-flight heartbeat before idempotent consumer retirement', async () => {
    jest.useFakeTimers();
    try {
      const calls: CapturedCall[] = [];
      let heartbeatCount = 0;
      let resolveHeartbeat!: (result: { status: number; json: unknown }) => void;
      const routes = successRoutes(() => ({ status: 200, json: makeClaim() }));
      replaceWorkerHeartbeatRoute(routes, {
        method: 'PUT',
        pattern: /^\/workers\/[^/]+\/heartbeat$/,
        handler: () => {
          heartbeatCount += 1;
          if (heartbeatCount === 1) {
            return {
              status: 200,
              json: {
                health: 'HEALTHY',
                leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
                capacity: 1,
                controlRevision: 0,
                controlState: 'OPEN',
                backupEffectFence: { state: 'OPEN', revision: 0, acknowledged: true },
              },
            };
          }
          return new Promise((resolve) => { resolveHeartbeat = resolve; });
        },
      });
      const { consumer, stopped } = testConsumer();
      const definition = defineBusiness(MANIFEST, {
        root: async () => ({ kind: 'completed', resultRef: 'artifact://must-not-run' }),
        child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
      });
      const handle = await startWorker(definition, {
        ...commonConfig,
        consumer,
        fetchImpl: stubFetch(routes, calls),
        heartbeatIntervalMs: 25,
      });

      await jest.advanceTimersByTimeAsync(25);
      expect(resolveHeartbeat).toBeDefined();
      const firstStop = handle.stop(0);
      const secondStop = handle.stop(10_000);
      expect(secondStop).toBe(firstStop);
      await Promise.resolve();
      expect(calls.some((call) => call.path.endsWith('/retire'))).toBe(false);

      resolveHeartbeat({
        status: 200,
        json: {
          health: 'HEALTHY',
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          capacity: 1,
          controlRevision: 0,
          controlState: 'OPEN',
          backupEffectFence: { state: 'OPEN', revision: 0, acknowledged: true },
        },
      });
      await firstStop;
      expect(stopped).toHaveBeenCalledTimes(1);
      const retirement = calls.find((call) => call.path.endsWith('/retire'));
      expect(retirement?.method).toBe('POST');
      expect(retirement?.body).toEqual({
        businessId: MANIFEST.businessId,
        businessVersion: MANIFEST.version,
        manifestDigest: MANIFEST_DIGEST,
      });
      expect(calls.findIndex((call) => call.path.endsWith('/retire')))
        .toBeGreaterThan(calls.findIndex((call) => call.path.endsWith('/heartbeat') && call.at > 0));
    } finally {
      jest.useRealTimers();
    }
  });

  it('bounds an unconfirmed consumer close and skips immediate retirement', async () => {
    jest.useFakeTimers();
    try {
      const calls: CapturedCall[] = [];
      const { consumer } = testConsumer();
      consumer.stop = jest.fn(() => new Promise<void>(() => undefined));
      const definition = defineBusiness(MANIFEST, {
        root: async () => ({ kind: 'completed', resultRef: 'artifact://must-not-run' }),
        child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
      });
      const handle = await startWorker(definition, {
        ...commonConfig,
        consumer,
        fetchImpl: stubFetch(successRoutes(() => ({ status: 200, json: makeClaim() })), calls),
        heartbeatIntervalMs: 25,
      });

      const stopping = handle.stop(0);
      await jest.advanceTimersByTimeAsync(1_000);
      await stopping;
      await jest.advanceTimersByTimeAsync(1_000);
      expect(calls.filter((call) => call.path.endsWith('/heartbeat'))).toHaveLength(1);
      expect(calls.some((call) => call.path.endsWith('/retire'))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe('WOC SDK version admission and in-flight lease drain', () => {
  it.each(['missing tuple', 'unknown reason'])('fails closed for new claims when heartbeat admission is %s', async (missingMode) => {
    const calls: CapturedCall[] = [];
    const ack: Record<string, unknown> = {
      health: 'HEALTHY',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      capacity: 1,
      controlRevision: 0,
      controlState: 'OPEN',
      backupEffectFence: { state: 'OPEN', revision: 0, acknowledged: true },
      activeVersion: MANIFEST.version,
      activationRevision: 1,
      admissionEligible: true,
      admissionReason: 'ELIGIBLE',
    };
    if (missingMode === 'missing tuple') {
      delete ack.activeVersion;
      delete ack.activationRevision;
      delete ack.admissionEligible;
      delete ack.admissionReason;
    } else {
      ack.admissionReason = 'FUTURE_ADMISSION_STATE';
    }
    const routes: Route[] = [
      businessRegistrationRoute(),
      {
        method: 'PUT',
        pattern: /^\/workers\/[^/]+\/heartbeat$/,
        handler: () => ({ status: 200, json: ack }),
      },
      workerRetirementRoute(),
    ];
    const { consumer, push, paused } = testConsumer();
    const definition = defineBusiness(MANIFEST, {
      root: async () => ({ kind: 'completed', resultRef: 'artifact://must-not-run' }),
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, { ...commonConfig, consumer, fetchImpl: stubFetch(routes, calls) });
    const deferred = new Error('admission-denied-delivery-deferred');
    await expect(push(makeJob(), { defer: async () => { throw deferred; } })).rejects.toBe(deferred);
    await handle.stop(1000);

    expect(paused).toHaveBeenCalled();
    expect(calls.some((call) => call.path.endsWith('/claim'))).toBe(false);
  });

  it('keeps new claims closed when eligibility conflicts at the same activation revision', async () => {
    jest.useFakeTimers();
    try {
      const calls: CapturedCall[] = [];
      let heartbeatIndex = 0;
      let claimCount = 0;
      const heartbeatStates = [
        { activeVersion: '1.0.0', activationRevision: 3, admissionEligible: true, admissionReason: 'ELIGIBLE' },
        { activeVersion: '2.0.0', activationRevision: 3, admissionEligible: false, admissionReason: 'VERSION_NOT_ACTIVE' },
        { activeVersion: '1.0.0', activationRevision: 3, admissionEligible: true, admissionReason: 'ELIGIBLE' },
      ];
      const routes = successRoutes(() => {
        claimCount += 1;
        return { status: 200, json: makeClaim() };
      });
      replaceWorkerHeartbeatRoute(routes, {
        method: 'PUT',
        pattern: /^\/workers\/[^/]+\/heartbeat$/,
        handler: () => {
          const versionState = heartbeatStates[Math.min(heartbeatIndex, heartbeatStates.length - 1)]!;
          heartbeatIndex += 1;
          return { status: 200, json: {
            health: 'HEALTHY',
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            capacity: 1,
            controlRevision: 0,
            controlState: 'OPEN',
            backupEffectFence: { state: 'OPEN', revision: 0, acknowledged: true },
            ...versionState,
          } };
        },
      });
      const { consumer, push, paused } = testConsumer();
      const definition = defineBusiness(MANIFEST, {
        root: async () => ({ kind: 'completed', resultRef: 'artifact://must-not-run' }),
        child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
      });
      const handle = await startWorker(definition, {
        ...commonConfig,
        consumer,
        fetchImpl: stubFetch(routes, calls),
        heartbeatIntervalMs: 20,
      });

      await jest.advanceTimersByTimeAsync(20);
      await jest.advanceTimersByTimeAsync(20);
      const deferred = new Error('conflicting-revision-delivery-deferred');
      await expect(push(makeJob(), { defer: async () => { throw deferred; } })).rejects.toBe(deferred);
      await handle.stop(1000);

      expect(paused).toHaveBeenCalled();
      expect(claimCount).toBe(0);
      expect(calls.some((call) => call.path.endsWith('/claim'))).toBe(false);
    } finally {
      jest.useRealTimers();
    }
  });

  it('reconciles a lost claim ACK after cutover with the exact in-flight identity', async () => {
    jest.useFakeTimers();
    try {
    const calls: CapturedCall[] = [];
    let heartbeatIndex = 0;
    const heartbeatStates = [
      { activeVersion: '1.0.0', activationRevision: 1, admissionEligible: true, admissionReason: 'ELIGIBLE' },
      { activeVersion: '2.0.0', activationRevision: 2, admissionEligible: false, admissionReason: 'VERSION_NOT_ACTIVE' },
    ];
    let resolveClaimStarted!: () => void;
    const claimStarted = new Promise<void>((resolve) => { resolveClaimStarted = resolve; });
    let releaseLostAck!: () => void;
    const lostAckGate = new Promise<void>((resolve) => { releaseLostAck = resolve; });
    let committed = false;
    const claimBodies: unknown[] = [];
    const routes = successRoutes(async (match, body) => {
      claimBodies.push(body);
      if (claimBodies.length === 1) {
        committed = true;
        resolveClaimStarted();
        await lostAckGate;
        throw new Error('claim committed but response was lost');
      }
      if (!committed) {
        return { status: 409, json: {
          type: 'urn:du:error:version_not_active',
          status: 409,
          code: 'VERSION_NOT_ACTIVE',
          title: 'version is no longer active',
        } };
      }
      return { status: 200, json: makeClaim({ taskId: match[1] }) };
    });
    replaceWorkerHeartbeatRoute(routes, {
      method: 'PUT',
      pattern: /^\/workers\/[^/]+\/heartbeat$/,
      handler: () => {
        const versionState = heartbeatStates[Math.min(heartbeatIndex, heartbeatStates.length - 1)]!;
        heartbeatIndex += 1;
        return { status: 200, json: {
          health: 'HEALTHY',
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          capacity: 1,
          controlRevision: 0,
          controlState: 'OPEN',
          backupEffectFence: { state: 'OPEN', revision: 0, acknowledged: true },
          ...versionState,
        } };
      },
    });

    const { consumer, push, paused } = testConsumer();
    let handlerCalls = 0;
    const definition = defineBusiness(MANIFEST, {
      root: async () => {
        handlerCalls += 1;
        return { kind: 'completed', resultRef: 'artifact://reconciled-claim' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
    });
    const handle = await startWorker(definition, {
      ...commonConfig,
      consumer,
      fetchImpl: stubFetch(routes, calls),
      heartbeatIntervalMs: 20,
    });

    const job = makeJob();
    const delivery = push(job, { defer: async () => { throw new Error('claim delivery was unnecessarily deferred'); } });
    await claimStarted;
    await jest.advanceTimersByTimeAsync(20);
    expect(paused).toHaveBeenCalled();
    releaseLostAck();
    await delivery;
    await handle.stop(1000);

    expect(claimBodies).toHaveLength(2);
    expect(claimBodies[1]).toEqual(claimBodies[0]);
    expect(handlerCalls).toBe(1);
    expect(calls.filter((call) => call.path.endsWith('/complete'))).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  it('drains a claimed v1 task across v1 to v2 to v1 heartbeats and ignores a stale admission ACK', async () => {
    jest.useFakeTimers();
    try {
      const calls: CapturedCall[] = [];
      let heartbeatIndex = 0;
      let claimCount = 0;
      const heartbeatStates = [
        { activeVersion: '1.0.0', activationRevision: 5, admissionEligible: true, admissionReason: 'ELIGIBLE' },
        { activeVersion: '2.0.0', activationRevision: 6, admissionEligible: false, admissionReason: 'VERSION_NOT_ACTIVE' },
        { activeVersion: '1.0.0', activationRevision: 5, admissionEligible: true, admissionReason: 'ELIGIBLE' },
        { activeVersion: '1.0.0', activationRevision: 7, admissionEligible: true, admissionReason: 'ELIGIBLE' },
      ];
      const routes = successRoutes((match) => {
        claimCount += 1;
        return { status: 200, json: makeClaim({ taskId: match[1] }) };
      });
      replaceWorkerHeartbeatRoute(routes, {
        method: 'PUT',
        pattern: /^\/workers\/[^/]+\/heartbeat$/,
        handler: () => {
          const versionState = heartbeatStates[Math.min(heartbeatIndex, heartbeatStates.length - 1)]!;
          heartbeatIndex += 1;
          return { status: 200, json: {
            health: 'HEALTHY',
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            capacity: 1,
            controlRevision: 0,
            controlState: 'OPEN',
            backupEffectFence: { state: 'OPEN', revision: 0, acknowledged: true },
            ...versionState,
          } };
        },
      });
      const artifactId = randomUUID();
      const invocationId = randomUUID();
      routes.push(
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/artifacts$/,
          handler: () => ({ status: 200, json: {
            artifactId,
            uploadUrl: 'http://runtime/artifact-upload',
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
          } }),
        },
        {
          method: 'PUT',
          pattern: /^\/artifact-upload$/,
          handler: () => ({ status: 200, json: { uploaded: true } }),
        },
        {
          method: 'POST',
          pattern: /^\/artifacts\/[^/]+\/finalize$/,
          handler: () => ({ status: 200, json: { finalized: true } }),
        },
        {
          method: 'PUT',
          pattern: /^\/tasks\/[^/]+\/steps\/after-cutover$/,
          handler: () => ({ status: 200, json: { stepKey: 'after-cutover', generation: 1, replayed: false } }),
        },
        {
          method: 'POST',
          pattern: /^\/tasks\/[^/]+\/invocation-grants$/,
          handler: () => ({ status: 200, json: {
            grant: 'signed-after-cutover',
            invocationId,
            connectorId: 'test-connector',
            connectorRevision: 1,
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            allowedOptions: {},
          } }),
        },
      );

      const { consumer, push, paused, resumed } = testConsumer();
      let releaseHandler!: () => void;
      let handlerStarted!: () => void;
      const started = new Promise<void>((resolve) => { handlerStarted = resolve; });
      let activeSignal: AbortSignal | undefined;
      let connectorCalls = 0;
      let handlerCalls = 0;
      const definition = defineBusiness(MANIFEST, {
        root: async (ctx) => {
          handlerCalls += 1;
          if (handlerCalls > 1) return { kind: 'completed', resultRef: 'artifact://reactivated' };
          activeSignal = ctx.signal;
          const waiting = new Promise<void>((resolve) => { releaseHandler = resolve; });
          handlerStarted();
          await waiting;
          await ctx.step.run('after-cutover', 'sha256:after-cutover', async () => {
            await ctx.connector.invoke('model', { prompt: 'continue the claimed task' }, {});
            return { completedAfterSwitch: true };
          });
          return { kind: 'completed', resultRef: 'artifact://finished-after-cutover' };
        },
        child: async () => ({ kind: 'completed', resultRef: 'artifact://child-result' }),
      });
      const handle = await startWorker(definition, {
        ...commonConfig,
        consumer,
        fetchImpl: stubFetch(routes, calls),
        heartbeatIntervalMs: 20,
        leaseSafetyMarginMs: 20,
        invokeConnector: async (grant) => {
          connectorCalls += 1;
          return { invocationId: grant.invocationId, state: 'SUCCEEDED' };
        },
      });

      const firstDelivery = push(makeJob());
      await started;
      await jest.advanceTimersByTimeAsync(20);
      const cutoverAt = Date.now();
      expect(paused).toHaveBeenCalled();
      expect(activeSignal?.aborted).toBe(false);
      await jest.advanceTimersByTimeAsync(20);
      expect(resumed).toHaveBeenCalledTimes(1);

      const newTaskId = randomUUID();
      const deferred = new Error('inactive-v1-delivery-deferred');
      await expect(push(makeJob({ taskId: newTaskId }), { defer: async () => { throw deferred; } })).rejects.toBe(deferred);
      expect(claimCount).toBe(1);

      releaseHandler();
      await firstDelivery;
      expect(activeSignal?.aborted).toBe(false);
      expect(calls.some((call) => call.path.endsWith('/steps/after-cutover'))).toBe(true);
      expect(calls.some((call) => call.path.endsWith('/invocation-grants'))).toBe(true);
      expect(connectorCalls).toBe(1);
      expect(calls.some((call) => call.path.endsWith('/complete') && call.at >= cutoverAt)).toBe(true);
      expect(calls.some((call) => call.path.startsWith('/tasks/') && call.path.endsWith('/heartbeat') && call.at >= cutoverAt)).toBe(true);

      await jest.advanceTimersByTimeAsync(20);
      expect(resumed).toHaveBeenCalledTimes(2);
      await push(makeJob({ taskId: newTaskId, deliveryId: `reactivated-${newTaskId}` }));
      expect(claimCount).toBe(2);
      await handle.stop(1000);
    } finally {
      jest.useRealTimers();
    }
  });
});
