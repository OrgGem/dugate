import { randomUUID } from 'node:crypto';
import { BusinessJobV1, ClaimResult, TaskHeartbeatAck, type PinnedPromptOverride } from '@du/contracts';
import { defineBusiness, startWorker, QueueConsumer, DefaultTaskContext, RuntimeClient } from '../src';

/*
 * P745-CARRIER-IMPL-B1 (Δ-PC-1, adjudications 1e/1g) focused tests.
 * Offline only, SDK leg.
 *
 * Proves the claim's opened content carrier (`pinned.promptOverrides`) travels
 * claim -> DefaultTaskContext -> handler context exactly as the runtime sent
 * it, mirroring the W1b promptRevisions passthrough:
 *   - rows arrive key-4 native (connectionId/stepId/promptOverride/revision);
 *   - `null` (no carrier: legacy / no-seam / empty bucket) STAYS null — never
 *     coalesced to [] or undefined;
 *   - ABSENT on the constructed shape (a context that never carried the pin)
 *     stays undefined — the old shape is untouched;
 *   - on the wire, a claim that omits the field parses to null (contract
 *     default) and reaches the handler as null.
 */

const TASK_ID = randomUUID();
const OP_ID = randomUUID();

const CONN = '7d000000-0000-4000-8000-00000000000a';
const ROWS: PinnedPromptOverride[] = [
  { connectionId: CONN, stepId: 'extract_invoice', promptOverride: 'EXACT-PROMPT', revision: 'sha256:' + '1'.repeat(64) },
  { connectionId: CONN, stepId: '_default', promptOverride: 'DEFAULT-PROMPT', revision: 'sha256:' + '2'.repeat(64) },
];

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
    return new Response(JSON.stringify({ status: 404, code: 'NOT_FOUND' }), { status: 404 }) as unknown as globalThis.Response;
  }) as unknown as typeof fetch;
}

function claimStubFetch(routes: Route[], calls: { path: string; method: string; body?: unknown }[]) {
  return (async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace(/^http:\/\/runtime/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
    calls.push({ path, method, body });
    for (const r of routes) {
      if (r.method === method && r.pattern.exec(path)) {
        const m = r.pattern.exec(path) as RegExpMatchArray;
        const { status, json } = r.handler(m, body);
        return new Response(JSON.stringify(json), { status, headers: { 'content-type': 'application/json' } }) as unknown as globalThis.Response;
      }
    }
    return new Response(JSON.stringify({ status: 404, code: 'NOT_FOUND' }), { status: 404 }) as unknown as globalThis.Response;
  }) as unknown as typeof fetch;
}

function heartbeatRoutes(): Route[] {
  return [
    { method: 'PUT', pattern: /^\/workers\/[^/]+\/heartbeat$/, handler: () => ({ status: 200, json: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60000).toISOString(), capacity: 1 } }) },
    { method: 'POST', pattern: /^\/tasks\/[^/]+\/heartbeat$/, handler: () => ({ status: 200, json: { leaseEpoch: 1, cancelRequested: false, leaseExpiresAt: new Date(Date.now() + 60000).toISOString() } as TaskHeartbeatAck }) },
  ];
}

function makeClaim(pinnedOverrides: Record<string, unknown> = {}): ClaimResult {
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
      pinned: { profileRevision: 1, promptRevisions: {}, connectorBindings: { ocr: 'mock-ocr@1' }, profilePolicy: null, ...pinnedOverrides },
      taskKey: 'root',
      kind: 'root',
      payloadRef: {},
      deadlineAt: null,
      cancelRequested: false,
    },
    checkpointRefs: [],
  } as ClaimResult;
}

function makeJob(): BusinessJobV1 {
  return {
    contractVersion: '1',
    deliveryId: 'd-' + randomUUID(),
    taskId: TASK_ID,
    operationId: OP_ID,
    businessId: 'test-biz',
    businessVersion: '1.0.0',
    kind: 'root',
    correlationId: 'corr-1',
    action: 'extract',
    attempt: 1,
  } as BusinessJobV1;
}

function testConsumer() {
  let handler: ((job: BusinessJobV1) => Promise<void>) | undefined;
  const deliveries: Promise<void>[] = [];
  const consumer: QueueConsumer = {
    start(h) { handler = h; },
    async stop() { await Promise.allSettled(deliveries); },
  };
  const push = (job: BusinessJobV1) => {
    if (!handler) throw new Error('consumer not started');
    const p = handler(job);
    deliveries.push(p);
    return p;
  };
  return { consumer, push };
}

function buildContext(task: Record<string, unknown>) {
  const runtime = new RuntimeClient({ baseUrl: 'http://runtime', token: 'tok', fetchImpl: stubFetch([], []) });
  return new DefaultTaskContext(
    {
      taskId: TASK_ID,
      operationId: OP_ID,
      tenantId: 'tenant-1',
      businessId: 'test-biz',
      businessVersion: '1.0.0',
      action: 'extract',
      kind: 'root',
      taskKey: 'root',
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
      deadlineAt: null,
      input: {},
      connectorBindings: {},
      profileRevision: 3,
      promptRevisions: {},
      profilePolicy: null,
      checkpointRefs: [],
      cancelRequested: false,
      ...task,
    },
    { runtime, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never, invokeConnector: async () => { throw new Error('unused'); } }
  );
}

describe('P745-CARRIER SDK leg — pinned.promptOverrides passthrough', () => {
  it('carries the rows key-4 native from claim into the context', () => {
    const ctx = buildContext({ promptOverrides: ROWS });
    expect(ctx.promptOverrides).toEqual(ROWS);
    expect(ctx.promptOverrides?.[0]).toEqual({
      connectionId: CONN,
      stepId: 'extract_invoice',
      promptOverride: 'EXACT-PROMPT',
      revision: 'sha256:' + '1'.repeat(64),
    });
  });

  it('a null carrier stays null (never coalesced to [] or undefined)', () => {
    const ctx = buildContext({ promptOverrides: null });
    expect(ctx.promptOverrides).toBeNull();
    expect(ctx.promptOverrides).not.toEqual([]);
  });

  it('an ABSENT carrier keeps the old shape (undefined), distinct from null', () => {
    const ctx = buildContext({});
    expect(ctx.promptOverrides).toBeUndefined();
  });

  it('startWorker: claim rows reach the handler context through the real wiring', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim({ promptOverrides: ROWS }) }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/complete$/, handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false } }) },
    ];
    let seen: readonly PinnedPromptOverride[] | null | undefined;
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        seen = ctx.promptOverrides;
        return { kind: 'completed', resultRef: 'artifact://r-1' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: claimStubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    expect(seen).toEqual(ROWS);
  });

  it('startWorker: claim null reaches the handler as null; a wire-omitted field stays absent', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const results: (readonly PinnedPromptOverride[] | null | undefined)[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim() }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/complete$/, handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false } }) },
    ];
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        results.push(ctx.promptOverrides);
        return { kind: 'completed', resultRef: 'artifact://r-1' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: claimStubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    // The field is `.optional()` in contracts: a wire shape that omits it
    // (pre-B1 runtime) stays ABSENT — undefined, never coerced to null/[].
    expect(results).toEqual([undefined]);
  });

  it('startWorker: an explicit claim null still reaches the handler as null', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const results: (readonly PinnedPromptOverride[] | null | undefined)[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim({ promptOverrides: null }) }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/complete$/, handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false } }) },
    ];
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        results.push(ctx.promptOverrides);
        return { kind: 'completed', resultRef: 'artifact://r-1' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: claimStubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    expect(results).toEqual([null]);
  });
});
