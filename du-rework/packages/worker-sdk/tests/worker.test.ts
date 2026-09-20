import { randomUUID } from 'node:crypto';
const TASK_ID = randomUUID();
const OP_ID = randomUUID();
import {
  BusinessJobV1,
  ClaimResult,
  contentHash,
  TaskHeartbeatAck,
} from '@du/contracts';
import {
  defineBusiness,
  startWorker,
  QueueConsumer,
  classifyFailure,
  RuntimeError,
  LeaseLostError,
  DefaultTaskContext,
  RuntimeClient,
  InputHashMismatchError,
} from '../src';

/**
 * worker-sdk unit tests (P4). Everything runs against an injected in-memory
 * queue consumer and a stubbed fetch — no Redis, no orchestrator. Covers:
 * defineBusiness validation (REG-04), claim fencing, checkpoint replay
 * (RUN-04), spawn/wait yield dispositions, lease-loss abort, failure
 * classification, and graceful shutdown.
 */

const MANIFEST = {
  contractVersion: '1',
  businessId: 'test-biz',
  displayName: 'Test Business',
  description: 'Test business for SDK tests',
  version: '1.0.0',
  imageDigest: 'sha256:aa',
  runtime: { wireVersion: '1', handlerKinds: ['root', 'child'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [
    {
      name: 'extract',
      displayName: 'Extract',
      description: 'Test action',
      inputSchema: { type: 'object', properties: { q: { type: 'string' } } },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [{ name: 'ocr', acceptedCapabilities: ['ocr'], required: false }],
      artifactPolicy: { minFiles: 0, maxFiles: 5 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 2 },
    },
  ],
};

interface Route {
  method: string;
  pattern: RegExp;
  handler: (m: RegExpMatchArray, body: unknown) => { status: number; json: unknown };
}

function stubFetch(routes: Route[], calls: { path: string; method: string; body?: unknown }[]) {
  return (async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace(/^http:\/\/runtime/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    for (const r of routes) {
      if (r.method === method) {
        const m = r.pattern.exec(path);
        if (m) {
          const { status, json } = r.handler(m, body);
          return new Response(JSON.stringify(json), {
            status,
            headers: { 'content-type': 'application/json' },
          }) as unknown as globalThis.Response;
        }
      }
    }
    return new Response(JSON.stringify({ type: 'urn:du:error:not_found', status: 404, code: 'NOT_FOUND', title: `no route for ${method} ${path}` }), {
      status: 404,
      headers: { 'content-type': 'application/json' },
    }) as unknown as globalThis.Response;
  }) as unknown as typeof fetch;
}

function makeClaim(overrides: Partial<ClaimResult> = {}): ClaimResult {
  return {
    taskId: TASK_ID,
    operationId: OP_ID,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    attempt: 1,
    deadlineAt: new Date(Date.now() + 300_000).toISOString(),
    executionSnapshot: {
      operationId: OP_ID,
      tenantId: 'tenant-1',
      businessId: 'test-biz',
      businessVersion: '1.0.0',
      action: 'extract',
      schemaDigest: 'sha256:bb',
      manifestDigest: 'sha256:aa',
      resolvedInputRef: { q: 'hello' },
      pinned: { profileRevision: 1, promptRevisions: {}, connectorBindings: { ocr: 'mock-ocr@1' } },
      taskKey: 'root',
      kind: 'root',
      payloadRef: {},
      deadlineAt: null,
      cancelRequested: false,
    },
    checkpointRefs: [],
    ...overrides,
  } as ClaimResult;
}

function makeJob(overrides: Partial<BusinessJobV1> = {}): BusinessJobV1 {
  return {
    contractVersion: '1',
    deliveryId: `d-${randomUUID()}`,
    taskId: TASK_ID,
    operationId: OP_ID,
    businessId: 'test-biz',
    businessVersion: '1.0.0',
    kind: 'root',
    correlationId: 'corr-12345',
    attempt: 1,
    ...overrides,
  } as BusinessJobV1;
}

/** In-memory consumer that delivers jobs the test pushes. */
function testConsumer() {
  let handler: ((job: BusinessJobV1) => Promise<void>) | undefined;
  const deliveries: Promise<void>[] = [];
  const consumer: QueueConsumer = {
    start(h) {
      handler = h;
    },
    async stop() {
      await Promise.allSettled(deliveries);
    },
  };
  const push = (job: BusinessJobV1) => {
    if (!handler) throw new Error('consumer not started');
    const p = handler(job);
    deliveries.push(p);
    return p;
  };
  return { consumer, push, deliveries };
}

function heartbeatRoutes() {
  return [
    {
      method: 'PUT',
      pattern: /^\/workers\/[^/]+\/heartbeat$/,
      handler: () => ({ status: 200, json: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), capacity: 1 } }),
    },
    {
      method: 'POST',
      pattern: /^\/tasks\/[^/]+\/heartbeat$/,
      handler: () => ({ status: 200, json: { leaseEpoch: 1, cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() } as TaskHeartbeatAck }),
    },
  ] satisfies Route[];
}

describe('defineBusiness', () => {
  it('accepts matching manifest + handlers', () => {
    const def = defineBusiness(MANIFEST, { root: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }), child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }) });
    expect(def.manifest.businessId).toBe('test-biz');
  });

  it('rejects invalid manifest', () => {
    expect(() => defineBusiness({ ...MANIFEST, contractVersion: '2' }, { root: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }), child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }) })).toThrow(/invalid business manifest/);
  });

  it('rejects missing handlers (REG-04)', () => {
    expect(() => defineBusiness(MANIFEST, { root: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }) })).toThrow(/missing handlers/);
  });

  it('rejects handlers for undeclared kinds (REG-04)', () => {
    expect(() =>
      defineBusiness(MANIFEST, {
        root: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
        child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
        ghost: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
      })
    ).toThrow(/undeclared/);
  });
});

describe('startWorker delivery lifecycle', () => {
  it('claims, runs handler, reports completion with resultHash', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const resultRef = 'artifact://r-1';
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim() }) },
      {
        method: 'POST',
        pattern: /^\/tasks\/[^/]+\/complete$/,
        handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false } }),
      },
    ];
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        expect(ctx.taskId).toBe(TASK_ID);
        expect(ctx.input).toEqual({ q: 'hello' });
        expect(ctx.connectorBindings.ocr).toBe('mock-ocr@1');
        expect(ctx.signal.aborted).toBe(false);
        return { kind: 'completed', resultRef };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, {
      runtimeUrl: 'http://runtime',
      runtimeToken: 'tok',
      consumer,
      fetchImpl: stubFetch(routes, calls),
    });
    await push(makeJob());
    await handle.stop(1000);

    const complete = calls.find((c) => c.path.endsWith('/complete'));
    expect(complete).toBeDefined();
    expect(complete!.body).toMatchObject({ leaseEpoch: 1, resultRef, resultHash: contentHash(resultRef) });
  });

  it('ends delivery safely when claim is fenced (409)', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      {
        method: 'POST',
        pattern: /^\/tasks\/[^/]+\/claim$/,
        handler: () => ({ status: 409, json: { type: 'urn:du:error:state_conflict', status: 409, code: 'STATE_CONFLICT', title: 'leased' } }),
      },
    ];
    let handlerRan = false;
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async () => { handlerRan = true; return { kind: 'completed', resultRef: 'artifact://r-1' }; },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: stubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    expect(handlerRan).toBe(false);
    expect(calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });

  it('ends delivery safely when task is terminal (410)', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      {
        method: 'POST',
        pattern: /^\/tasks\/[^/]+\/claim$/,
        handler: () => ({ status: 410, json: { type: 'urn:du:error:task_terminal', status: 410, code: 'TASK_TERMINAL', title: 'done' } }),
      },
    ];
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: stubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    expect(calls.some((c) => c.path.endsWith('/complete') || c.path.endsWith('/fail'))).toBe(false);
  });

  it('reports unregistered kind as permanent failure with claimed leaseEpoch', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const claim = makeClaim();
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: claim }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/fail$/, handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'FAILED', operationState: 'FAILED', replayed: false } }) },
    ];
    const { consumer, push } = testConsumer();
    // validate:false simulates a definition where handlerKinds drifted
    const def = defineBusiness(MANIFEST, { root: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }), child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }) }, { validate: false });
    delete (def.handlers as Record<string, unknown>).root;
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: stubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    const fail = calls.find((c) => c.path.endsWith('/fail'));
    expect(fail).toBeDefined();
    expect(fail!.body).toMatchObject({ leaseEpoch: 1, errorCode: 'UNREGISTERED_HANDLER', retryable: false });
  });

  it('classifies handler failure and reports fail with business error fields', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim() }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/fail$/, handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'RETRY_PENDING', operationState: 'RETRY_PENDING', replayed: false } }) },
    ];
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async () => {
        const e = new Error('provider busy') as Error & { code: string; retryable: boolean; retryAfterMs: number };
        e.code = 'PROVIDER_RATE_LIMITED';
        e.retryable = true;
        e.retryAfterMs = 2500;
        throw e;
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: stubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    const fail = calls.find((c) => c.path.endsWith('/fail'));
    expect(fail!.body).toMatchObject({
      leaseEpoch: 1,
      errorCode: 'PROVIDER_RATE_LIMITED',
      retryable: true,
      retryAfterMs: 2500,
      detail: 'provider busy',
    });
  });

  it('waiting-children disposition releases slot without terminal report', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim() }) },
      {
        method: 'POST',
        pattern: /^\/tasks\/[^/]+\/children$/,
        handler: () => ({ status: 200, json: { childTaskIds: [randomUUID()], parentState: 'WAITING_CHILDREN' } }),
      },
    ];
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async (ctx) =>
        ctx.spawn.spawnAndWait([{ taskKey: 'c1', kind: 'child', payload: { x: 1 } }], 'all-success', 'cont-1'),
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: stubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    const spawn = calls.find((c) => c.path.endsWith('/children'));
    expect(spawn).toBeDefined();
    expect(spawn!.body).toMatchObject({
      leaseEpoch: 1,
      joinPolicy: 'all-success',
      continuationRef: 'cont-1',
    });
    const spec = (spawn!.body as { children: { taskKey: string; payloadHash: string }[] }).children[0]!;
    expect(spec.taskKey).toBe('c1');
    expect(spec.payloadHash).toBe(contentHash({ x: 1 }));
    expect(calls.some((c) => c.path.endsWith('/complete') || c.path.endsWith('/fail'))).toBe(false);
  });

  it('waiting-input disposition persists schema then yields', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim() }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/wait-input$/, handler: () => ({ status: 200, json: { waitId: 'w-1', expiresAt: new Date(Date.now() + 3600000).toISOString() } }) },
    ];
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async (ctx) => ctx.wait.waitForInput('approve', { type: 'object' }, { uiSchema: { kind: 'form' } }),
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: stubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    const wait = calls.find((c) => c.path.endsWith('/wait-input'));
    expect(wait!.body).toMatchObject({ leaseEpoch: 1, waitKey: 'approve', inputSchema: { type: 'object' } });
    expect(calls.some((c) => c.path.endsWith('/complete'))).toBe(false);
  });

  it('transport failure on claim rethrows for queue redelivery', async () => {
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 503, json: { type: 'urn:du:error:temporary_unavailable', status: 503, code: 'TEMPORARY_UNAVAILABLE', title: 'x' } }) },
    ];
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: stubFetch(routes, []) });
    await expect(push(makeJob())).rejects.toThrow();
    await handle.stop(1000);
  });
});

describe('checkpoint replay (RUN-04)', () => {
  function ctxWith(checkpoints: unknown[], deps?: { saveStep?: Route }) {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const routes: Route[] = deps?.saveStep ? [deps.saveStep] : [];
    const runtime = new RuntimeClient({ baseUrl: 'http://runtime', token: 'tok', fetchImpl: stubFetch(routes, calls) });
    const ctx = new DefaultTaskContext(
      {
        taskId: TASK_ID,
        operationId: OP_ID,
        tenantId: 'tenant-1',
        businessId: 'test-biz',
        businessVersion: '1.0.0',
        action: 'extract',
        kind: 'root',
        taskKey: 'root',
        attempt: 2,
        leaseEpoch: 2,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        deadlineAt: null,
        input: {},
        connectorBindings: {},
        checkpointRefs: checkpoints as never,
        cancelRequested: false,
      },
      { runtime, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never, invokeConnector: async () => { throw new Error('unused'); } }
    );
    return { ctx, calls };
  }

  it('replays SUCCEEDED checkpoint with matching inputHash without executing fn', async () => {
    const stored = { stepKey: 's1', output: { deep: 'value' } };
    const serialized = JSON.stringify(stored);
    const artifactId = randomUUID();
    const ref = `artifact://${artifactId}?meta=x`;
    const { ctx, calls } = ctxWith([
      { stepKey: 's1', generation: 1, inputHash: 'h1', status: 'SUCCEEDED', outputRef: ref },
    ], {
      saveStep: { method: 'POST', pattern: new RegExp('^/artifacts/' + artifactId + '/access$'), handler: () => ({ status: 200, json: { artifactId, downloadUrl: `http://dl/${artifactId}`, expiresAt: new Date().toISOString() } }) },
    });
    let executed = false;
    // stub the download fetch
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(serialized, { status: 200 })) as unknown as typeof fetch;
    try {
      const out = await ctx.step.run('s1', 'h1', async () => { executed = true; return { wrong: true }; });
      expect(executed).toBe(false);
      expect(out).toEqual({ deep: 'value' });
    } finally {
      globalThis.fetch = realFetch;
    }
    void calls;
  });

  it('throws InputHashMismatchError on hash mismatch (RUN-04)', async () => {
    const { ctx } = ctxWith([
      { stepKey: 's1', generation: 1, inputHash: 'h1', status: 'SUCCEEDED', outputRef: `artifact://${randomUUID()}` },
    ]);
    await expect(ctx.step.run('s1', 'different-hash', async () => 1)).rejects.toBeInstanceOf(InputHashMismatchError);
  });

  it('peek returns checkpoint without executing', async () => {
    const { ctx } = ctxWith([
      { stepKey: 's1', generation: 1, inputHash: 'h1', status: 'SUCCEEDED', outputRef: `artifact://${randomUUID()}` },
    ]);
    expect((await ctx.step.peek('s1'))!.generation).toBe(1);
    expect(await ctx.step.peek('missing')).toBeNull();
  });

  it('aborts with LeaseLostError after abort() (no provider calls after lease loss)', async () => {
    const { ctx } = ctxWith([]);
    ctx.abort('lease-lost');
    expect(ctx.signal.aborted).toBe(true);
    await expect(ctx.step.run('s1', 'h', async () => 1)).rejects.toBeInstanceOf(LeaseLostError);
  });
});

describe('classifyFailure', () => {
  it('RuntimeError 429 is retryable with backoff', () => {
    const c = classifyFailure(new RuntimeError(429, 'CAPACITY', null, 'busy'));
    expect(c).toMatchObject({ errorCode: 'CAPACITY', retryable: true, retryAfterMs: 5000 });
  });

  it('RuntimeError 409 LEASE_LOST is not retryable', () => {
    const c = classifyFailure(new RuntimeError(409, 'LEASE_LOST', null));
    expect(c.retryable).toBe(false);
  });

  it('RuntimeError 503 is retryable', () => {
    expect(classifyFailure(new RuntimeError(503, 'TEMPORARY_UNAVAILABLE', null)).retryable).toBe(true);
  });

  it('ConnectorTransportError-shaped error keeps code, retryable per status', () => {
    const e = Object.assign(new Error('rate limited'), { name: 'ConnectorTransportError', status: 429, code: 'PROVIDER_RATE_LIMITED' });
    expect(classifyFailure(e)).toMatchObject({ errorCode: 'PROVIDER_RATE_LIMITED', retryable: true });
    const unknown = Object.assign(new Error('transport failure'), { name: 'ConnectorTransportError', status: 0, code: 'INVOCATION_UNKNOWN' });
    expect(classifyFailure(unknown)).toMatchObject({ errorCode: 'INVOCATION_UNKNOWN', retryable: true });
  });

  it('plain error is permanent HANDLER_ERROR', () => {
    expect(classifyFailure(new Error('boom'))).toMatchObject({ errorCode: 'HANDLER_ERROR', retryable: false, detail: 'boom' });
  });

  it('truncates detail to 2048 chars', () => {
    const c = classifyFailure(new Error('x'.repeat(5000)));
    expect(c.detail!.length).toBe(2048);
  });
});

describe('graceful shutdown', () => {
  it('stop is idempotent and drains in-flight deliveries', async () => {
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim() }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/complete$/, handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false } }) },
    ];
    const { consumer, push } = testConsumer();
    let finished = false;
    const def = defineBusiness(MANIFEST, {
      root: async () => {
        await new Promise((r) => setTimeout(r, 50));
        finished = true;
        return { kind: 'completed', resultRef: 'artifact://r-1' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: stubFetch(routes, []) });
    const p = push(makeJob());
    await handle.stop(5000);
    await p;
    expect(finished).toBe(true);
    expect(handle.stopped).toBe(true);
    await handle.stop(1000); // second stop is a no-op
  });
});
