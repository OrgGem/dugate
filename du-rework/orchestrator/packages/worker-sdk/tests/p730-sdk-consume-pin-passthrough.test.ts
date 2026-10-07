import { randomUUID } from 'node:crypto';
import { BusinessJobV1, ClaimResult, TaskHeartbeatAck } from '@du/contracts';
import { defineBusiness, startWorker, QueueConsumer, DefaultTaskContext, RuntimeClient } from '../src';

/*
 * P730-SDK-CONSUME (W1b) focused tests (qwen_2). Offline only.
 * Proves the admission-time pin travels claim -> DefaultTaskContext and that
 * every delivery re-reads it from the claim (retry/restart stability). Does
 * not touch live profile/policy resolution (W2 owns that); only the seam.
 */

const TASK_ID = randomUUID();
const OP_ID = randomUUID();

const POLICY = {
  enabled: true,
  parameters: {},
  jobPriority: 'MEDIUM',
  allowedFileExtensions: 'pdf',
  connectionsOverride: [],
  fileUrlAuthConfigured: false,
  // MEDIUM-2: credentialRef.tenantId is uuid-checked (tenant_id is uuid in
  // every migration), so the fixture must use a real uuid — the claim is parsed
  // by ClaimResultSchema on the SDK delivery path.
  credentialRef: { tenantId: '73000000-0000-4000-8000-000000000001', profileId: 'prof-1', profileRevision: 3 },
};

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

describe('P730-SDK-CONSUME pin passthrough (W1b)', () => {
  it('DefaultTaskContext exposes the pinned revision/prompt/policy from the claim', () => {
    const runtime = new RuntimeClient({ baseUrl: 'http://runtime', token: 'tok', fetchImpl: stubFetch([], []) });
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
        attempt: 1,
        leaseEpoch: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        deadlineAt: null,
        input: {},
        connectorBindings: {},
        profileRevision: 3,
        promptRevisions: { extract_invoice: 'v7' },
        profilePolicy: POLICY as never,
        checkpointRefs: [],
        cancelRequested: false,
      },
      { runtime, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never, invokeConnector: async () => { throw new Error('unused'); } }
    );
    expect(ctx.profileRevision).toBe(3);
    expect(ctx.promptRevisions).toEqual({ extract_invoice: 'v7' });
    expect(ctx.profilePolicy?.fileUrlAuthConfigured).toBe(false);
    expect(ctx.profilePolicy?.credentialRef.profileId).toBe('prof-1');
  });

  it('a null profilePolicy stays null (admitted-without-policy), never coalesced to empty', () => {
    const runtime = new RuntimeClient({ baseUrl: 'http://runtime', token: 'tok', fetchImpl: stubFetch([], []) });
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
        attempt: 1,
        leaseEpoch: 1,
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        deadlineAt: null,
        input: {},
        connectorBindings: {},
        profileRevision: 0,
        promptRevisions: {},
        profilePolicy: null,
        checkpointRefs: [],
        cancelRequested: false,
      },
      { runtime, logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never, invokeConnector: async () => { throw new Error('unused'); } }
    );
    expect(ctx.profilePolicy).toBeNull();
  });

  it('startWorker wires claim.pinned into the handler context', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim({ profileRevision: 3, promptRevisions: { extract_invoice: 'v7' }, profilePolicy: POLICY }) }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/complete$/, handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false } }) },
    ];
    let seen: { rev?: number; prompts?: Record<string, string>; credId?: string } = {};
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async (ctx) => {
        seen = { rev: ctx.profileRevision, prompts: ctx.promptRevisions as Record<string, string>, credId: ctx.profilePolicy?.credentialRef.profileId };
        return { kind: 'completed', resultRef: 'artifact://r-1' };
      },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: claimStubFetch(routes, calls) });
    await push(makeJob());
    await handle.stop(1000);
    expect(seen.rev).toBe(3);
    expect(seen.prompts).toEqual({ extract_invoice: 'v7' });
    expect(seen.credId).toBe('prof-1');
  });

  it('two deliveries of the same claim each re-read the same pin (retry/restart stability)', async () => {
    const calls: { path: string; method: string; body?: unknown }[] = [];
    const routes: Route[] = [
      ...heartbeatRoutes(),
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/claim$/, handler: () => ({ status: 200, json: makeClaim({ profileRevision: 3 }) }) },
      { method: 'POST', pattern: /^\/tasks\/[^/]+\/complete$/, handler: () => ({ status: 200, json: { taskId: TASK_ID, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false } }) },
    ];
    const revs: (number | undefined)[] = [];
    const { consumer, push } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async (ctx) => { revs.push(ctx.profileRevision); return { kind: 'completed', resultRef: 'artifact://r-1' }; },
      child: async () => ({ kind: 'completed', resultRef: 'artifact://r-1' }),
    });
    const handle = await startWorker(def, { runtimeUrl: 'http://runtime', runtimeToken: 'tok', consumer, fetchImpl: claimStubFetch(routes, calls) });
    await push(makeJob());
    await push(makeJob());
    await handle.stop(1000);
    expect(revs).toEqual([3, 3]);
  });
});
