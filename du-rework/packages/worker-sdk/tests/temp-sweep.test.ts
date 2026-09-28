import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_STALE_WORKSPACE_MS,
  TEMP_WORKSPACE_PREFIX,
  defineBusiness,
  startWorker,
} from '../src';
import type { QueueConsumer } from '../src';

/**
 * W39-CC2b — sweepStaleWorkspaces wired into startWorker (startup + periodic).
 * Proves bounded temp-file lifetime for crashed workers (ART-02) without
 * touching the P4-02/P4-03 baseline behavior: the sweep is best-effort,
 * failures never affect deliveries, and `enabled: false` opts out cleanly.
 */

const MANIFEST = {
  contractVersion: '1',
  businessId: 'sweep-biz',
  displayName: 'Sweep Business',
  description: 'W39-CC2b temp sweep wiring test',
  version: '1.0.0',
  imageDigest: 'sha256:aa',
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [
    {
      name: 'noop',
      displayName: 'Noop',
      description: 'noop action',
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 1 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 1 },
    },
  ],
};

interface Route {
  method: string;
  pattern: RegExp;
  handler: (m: RegExpMatchArray, body: unknown) => { status: number; json: unknown };
}

function heartbeatRoutes(): Route[] {
  return [
    {
      method: 'PUT',
      pattern: /^\/workers\/[^/]+\/heartbeat$/,
      handler: () => ({
        status: 200,
        json: { health: 'HEALTHY', leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(), capacity: 1 },
      }),
    },
  ];
}

function stubFetch(routes: Route[]) {
  return (async (url: string, init?: { method?: string; body?: string }) => {
    const path = url.replace(/^http:\/\/runtime/, '');
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(init.body) : undefined;
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
    return new Response(
      JSON.stringify({ type: 'urn:du:error:not_found', status: 404, code: 'NOT_FOUND', title: `no route ${method} ${path}` }),
      { status: 404, headers: { 'content-type': 'application/json' } }
    ) as unknown as globalThis.Response;
  }) as unknown as typeof fetch;
}

function testConsumer(): { consumer: QueueConsumer; push: (job: unknown) => Promise<void> } {
  let handler: ((job: unknown) => Promise<void>) | undefined;
  const deliveries: Promise<void>[] = [];
  const consumer: QueueConsumer = {
    start(h) { handler = h as (job: unknown) => Promise<void>; },
    async stop() { await Promise.allSettled(deliveries); },
  };
  return {
    consumer,
    push: (job: unknown) => {
      if (!handler) throw new Error('consumer not started');
      const p = handler(job);
      deliveries.push(p);
      return p;
    },
  };
}

async function plantStaleWorkspace(root: string, name: string): Promise<string> {
  const dir = join(root, `${TEMP_WORKSPACE_PREFIX}${name}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'leftover.bin'), 'crashed worker bytes', 'utf8');
  const old = new Date(Date.now() - (DEFAULT_STALE_WORKSPACE_MS + 60_000));
  const { utimes } = await import('node:fs/promises');
  await utimes(dir, old, old);
  await utimes(join(dir, 'leftover.bin'), old, old);
  return dir;
}

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((r) => setTimeout(r, 20));
  }
  return predicate();
}

describe('startWorker temp sweep (W39-CC2b)', () => {
  let root: string;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'du-sweep-test-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  async function startSweepWorker(tempSweep?: Parameters<typeof startWorker>[1]['tempSweep']) {
    const { consumer } = testConsumer();
    const def = defineBusiness(MANIFEST, {
      root: async () => ({ kind: 'completed', resultRef: 'artifact://noop' }),
    });
    return startWorker(def, {
      runtimeUrl: 'http://runtime',
      runtimeToken: 'tok',
      consumer,
      fetchImpl: stubFetch(heartbeatRoutes()),
      tempSweep: tempSweep ?? { rootDir: root, intervalMs: 60 * 60 * 1000 },
    });
  }

  it('removes stale du-worker-* dirs at startup', async () => {
    const stale = await plantStaleWorkspace(root, 'crashed-1');
    const handle = await startSweepWorker();
    const removed = await waitUntil(() => !existsSync(stale));
    await handle.stop(500);
    expect(removed).toBe(true);
  });

  it('keeps fresh du-worker-* dirs at startup', async () => {
    const fresh = join(root, `${TEMP_WORKSPACE_PREFIX}active-task`);
    await mkdir(fresh, { recursive: true });
    const handle = await startSweepWorker();
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop(500);
    expect(existsSync(fresh)).toBe(true);
  });

  it('sweeps periodically (dir planted after startup is removed by the timer)', async () => {
    const handle = await startSweepWorker({ rootDir: root, intervalMs: 30 });
    const stale = await plantStaleWorkspace(root, 'crashed-2');
    const removed = await waitUntil(() => !existsSync(stale), 3000);
    await handle.stop(500);
    expect(removed).toBe(true);
  });

  it('enabled:false leaves stale dirs untouched', async () => {
    const stale = await plantStaleWorkspace(root, 'kept-1');
    const handle = await startSweepWorker({ enabled: false, rootDir: root });
    await new Promise((r) => setTimeout(r, 100));
    await handle.stop(500);
    expect(existsSync(stale)).toBe(true);
  });

  it('a failing sweep (unreadable root) never breaks startup or delivery', async () => {
    // rootDir points at a FILE → readdir throws inside the sweep.
    const notADir = join(root, 'plain-file');
    await writeFile(notADir, 'x', 'utf8');
    const { consumer, push } = testConsumer();
    const taskId = randomUUID();
    const opId = randomUUID();
    const routes: Route[] = [
      ...heartbeatRoutes(),
      {
        method: 'POST',
        pattern: /^\/tasks\/[^/]+\/claim$/,
        handler: () => ({
          status: 200,
          json: {
            taskId,
            operationId: opId,
            leaseEpoch: 1,
            leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
            attempt: 1,
            deadlineAt: null,
            executionSnapshot: {
              operationId: opId,
              tenantId: 'tenant-1',
              businessId: 'sweep-biz',
              businessVersion: '1.0.0',
              action: 'noop',
              schemaDigest: 'sha256:bb',
              manifestDigest: 'sha256:aa',
              resolvedInputRef: {},
              pinned: { profileRevision: 1, promptRevisions: {}, connectorBindings: {} },
              taskKey: 'root',
              kind: 'root',
              payloadRef: {},
              deadlineAt: null,
              cancelRequested: false,
            },
            checkpointRefs: [],
          },
        }),
      },
      {
        method: 'POST',
        pattern: /^\/tasks\/[^/]+\/complete$/,
        handler: () => ({ status: 200, json: { taskId, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false } }),
      },
    ];
    const def = defineBusiness(MANIFEST, {
      root: async () => ({ kind: 'completed', resultRef: 'artifact://noop' }),
    });
    const handle = await startWorker(def, {
      runtimeUrl: 'http://runtime',
      runtimeToken: 'tok',
      consumer,
      fetchImpl: stubFetch(routes),
      tempSweep: { rootDir: notADir, intervalMs: 60 * 60 * 1000 },
    });
    await push({
      contractVersion: '1',
      deliveryId: `d-${randomUUID()}`,
      taskId,
      operationId: opId,
      businessId: 'sweep-biz',
      businessVersion: '1.0.0',
      action: 'noop',
      kind: 'root',
      correlationId: 'corr-sweep',
    });
    await handle.stop(1000);
    expect(handle.stopped).toBe(true);
    expect(existsSync(notADir)).toBe(true); // sweep failure touched nothing
  });

  it('stop() clears the sweep timer (no leaked interval)', async () => {
    const handle = await startSweepWorker({ rootDir: root, intervalMs: 20 });
    await handle.stop(500);
    // Plant a stale dir AFTER stop: it must survive (timer cleared).
    const stale = await plantStaleWorkspace(root, 'after-stop');
    await new Promise((r) => setTimeout(r, 120));
    expect(existsSync(stale)).toBe(true);
  });
});
