import { BusinessJobV1, businessQueueName, validateManifest } from '@du/contracts';
import { defineBusiness, QueueConsumer, startWorker } from '../src';

const MANIFEST = {
  contractVersion: '1',
  businessId: 'woc-registration-biz',
  displayName: 'WOC Registration Business',
  description: 'Worker SDK startup registration regression fixtures',
  version: '3.4.5',
  imageDigest: 'sha256:woc-registration',
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [{
    name: 'run',
    displayName: 'Run',
    description: 'Registration startup action',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    profileSchema: { type: 'object' },
    connectorSlots: [],
    artifactPolicy: { minFiles: 0, maxFiles: 1 },
    capabilities: { cancel: true, resume: true },
    defaultLimits: { maxParallelTasks: 1 },
  }],
};
const validatedManifest = validateManifest(MANIFEST);
if (!validatedManifest.ok) throw new Error('WOC registration manifest fixture is invalid');
const MANIFEST_DIGEST = validatedManifest.digest;
const MANIFEST_QUEUE = businessQueueName(MANIFEST.businessId, MANIFEST.version);

interface CapturedCall {
  path: string;
  method: string;
  body?: unknown;
  authorization?: string | null;
  signal?: AbortSignal | null;
}

type StubResponse = { status: number; json: unknown };
type Route = (call: CapturedCall) => StubResponse | Promise<StubResponse> | undefined;

function stubFetch(routes: Route[], calls: CapturedCall[]): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const path = String(input).replace(/^http:\/\/runtime/, '');
    const method = init?.method ?? 'GET';
    const call: CapturedCall = {
      path,
      method,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
      authorization: new Headers(init?.headers).get('authorization'),
      signal: init?.signal,
    };
    calls.push(call);
    for (const route of routes) {
      const response = await route(call);
      if (response) {
        return new Response(JSON.stringify(response.json), {
          status: response.status,
          headers: { 'content-type': 'application/json' },
        });
      }
    }
    return new Response(JSON.stringify({
      type: 'urn:du:error:not_found',
      status: 404,
      code: 'NOT_FOUND',
      title: `no route for ${method} ${path}`,
    }), { status: 404, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function validRegistration(): StubResponse {
  return {
    status: 201,
    json: {
      businessId: MANIFEST.businessId,
      version: MANIFEST.version,
      digest: MANIFEST_DIGEST,
      queue: MANIFEST_QUEUE,
      created: true,
      replayed: false,
    },
  };
}

function registrationRoute(handler: (call: CapturedCall) => StubResponse | undefined = () => validRegistration()): Route {
  return (call) => call.method === 'PUT' && call.path === `/businesses/${MANIFEST.businessId}/versions/${MANIFEST.version}`
    ? handler(call)
    : undefined;
}

function heartbeatRoute(): Route {
  return (call) => call.method === 'PUT' && call.path.startsWith('/workers/') && call.path.endsWith('/heartbeat')
    ? {
        status: 200,
        json: {
          health: 'HEALTHY',
          leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
          capacity: 1,
          controlRevision: 0,
          controlState: 'OPEN',
          backupEffectFence: { state: 'OPEN', revision: 0, acknowledged: true },
        },
      }
    : undefined;
}

function setupConsumer(events: string[] = []): {
  consumer: QueueConsumer;
  startedCount: () => number;
  getHandler: () => Parameters<QueueConsumer['start']>[0] | undefined;
} {
  let started = 0;
  let handler: Parameters<QueueConsumer['start']>[0] | undefined;
  return {
    consumer: {
      start(next) {
        started += 1;
        events.push('consume');
        handler = next;
      },
      async stop() {},
    },
    startedCount: () => started,
    getHandler: () => handler,
  };
}

function definition(onRun: () => Promise<{ kind: 'completed'; resultRef: string }> = async () => ({
  kind: 'completed',
  resultRef: 'artifact://registration-test',
})) {
  return defineBusiness(MANIFEST, { root: onRun });
}

const baseConfig = {
  runtimeUrl: 'http://runtime',
  runtimeToken: 'runtime-service-token',
  workerInstanceId: 'worker-registration-test',
  tempSweep: { enabled: false },
};

describe('WOC SDK startup business registration', () => {
  it('registers the validated exact-version manifest before heartbeat and queue consumption', async () => {
    const events: string[] = [];
    const calls: CapturedCall[] = [];
    const consumer = setupConsumer(events);
    const fetchImpl = stubFetch([
      (call) => {
        if (call.method !== 'PUT' || !call.path.startsWith('/businesses/')) return undefined;
        events.push('register');
        return validRegistration();
      },
      (call) => {
        if (call.method !== 'PUT' || !call.path.endsWith('/heartbeat')) return undefined;
        events.push('heartbeat');
        return heartbeatRoute()(call);
      },
    ], calls);

    const handle = await startWorker(definition(), { ...baseConfig, consumer: consumer.consumer, fetchImpl });
    await handle.stop(100);

    expect(events).toEqual(['register', 'heartbeat', 'consume']);
    const registration = calls[0]!;
    expect(registration.path).toBe('/businesses/woc-registration-biz/versions/3.4.5');
    expect(registration.method).toBe('PUT');
    expect(registration.authorization).toBe('Bearer runtime-service-token');
    expect(registration.body).toEqual(validatedManifest.manifest);
    const heartbeat = calls.find((call) => call.path.endsWith('/heartbeat'))!;
    expect(heartbeat.body).toMatchObject({
      businessId: MANIFEST.businessId,
      businessVersion: MANIFEST.version,
      manifestDigest: MANIFEST_DIGEST,
    });
    expect(handle.queueName).toBe(MANIFEST_QUEUE);
  });

  it('refuses a registration response pinned to another digest before heartbeat or consume', async () => {
    const calls: CapturedCall[] = [];
    const consumer = setupConsumer();
    const fetchImpl = stubFetch([
      registrationRoute(() => ({
        ...validRegistration(),
        json: { ...validRegistration().json as Record<string, unknown>, digest: `sha256:${'0'.repeat(64)}` },
      })),
      heartbeatRoute(),
    ], calls);

    await expect(startWorker(definition(), { ...baseConfig, consumer: consumer.consumer, fetchImpl }))
      .rejects.toMatchObject({ code: 'REGISTRATION_RESPONSE_MISMATCH' });

    expect(calls.map((call) => call.path)).toEqual([
      `/businesses/${MANIFEST.businessId}/versions/${MANIFEST.version}`,
    ]);
    expect(consumer.startedCount()).toBe(0);
  });

  it('retries an ambiguous transient registration response, then proceeds only after idempotent success', async () => {
    const calls: CapturedCall[] = [];
    const consumer = setupConsumer();
    let registrations = 0;
    const fetchImpl = stubFetch([
      registrationRoute(() => {
        registrations += 1;
        return registrations === 1
          ? { status: 503, json: { code: 'TEMPORARY_UNAVAILABLE', status: 503 } }
          : validRegistration();
      }),
      heartbeatRoute(),
    ], calls);

    const handle = await startWorker(definition(), { ...baseConfig, consumer: consumer.consumer, fetchImpl });
    await handle.stop(100);

    expect(registrations).toBe(2);
    expect(calls.filter((call) => call.path.startsWith('/businesses/')).map((call) => call.method)).toEqual(['PUT', 'PUT']);
    expect(consumer.startedCount()).toBe(1);
  });

  it('aborts startup during registration without heartbeating or starting a consumer', async () => {
    const calls: CapturedCall[] = [];
    const consumer = setupConsumer();
    const controller = new AbortController();
    let reachedRegistration!: () => void;
    const registrationReached = new Promise<void>((resolve) => { reachedRegistration = resolve; });
    const fetchImpl = stubFetch([
      (call) => {
        if (call.method !== 'PUT' || !call.path.startsWith('/businesses/')) return undefined;
        reachedRegistration();
        return new Promise<StubResponse>((_resolve, reject) => {
          call.signal?.addEventListener('abort', () => reject(call.signal?.reason ?? new Error('request aborted')), { once: true });
        });
      },
      heartbeatRoute(),
    ], calls);

    const starting = startWorker(definition(), {
      ...baseConfig,
      startupSignal: controller.signal,
      consumer: consumer.consumer,
      fetchImpl,
    });
    await registrationReached;
    controller.abort();
    await expect(starting).rejects.toMatchObject({ code: 'WORKER_STARTUP_ABORTED' });

    expect(calls.some((call) => call.path.endsWith('/heartbeat'))).toBe(false);
    expect(consumer.startedCount()).toBe(0);
  });

  it('durably defers a disabled-business claim instead of ACKing or running user code', async () => {
    const calls: CapturedCall[] = [];
    const consumer = setupConsumer();
    let userCodeRuns = 0;
    const fetchImpl = stubFetch([
      registrationRoute(),
      heartbeatRoute(),
      (call) => call.method === 'POST' && call.path.endsWith('/claim')
        ? { status: 409, json: {
            type: 'urn:du:error:business_disabled',
            status: 409,
            code: 'BUSINESS_DISABLED',
            title: 'business intake is disabled',
          } }
        : undefined,
    ], calls);
    const handle = await startWorker(definition(async () => {
      userCodeRuns += 1;
      return { kind: 'completed', resultRef: 'artifact://must-not-run' };
    }), { ...baseConfig, consumer: consumer.consumer, fetchImpl });
    const handler = consumer.getHandler();
    expect(handler).toBeDefined();
    const reschedule = new Error('delivery moved to delayed state');
    const job = {
      contractVersion: '1',
      deliveryId: 'disabled-delivery',
      taskId: 'task-disabled',
      operationId: 'operation-disabled',
      businessId: MANIFEST.businessId,
      businessVersion: MANIFEST.version,
      action: 'run',
      kind: 'root',
      correlationId: 'corr-disabled',
      attempt: 1,
    } as BusinessJobV1;

    await expect(handler!(job, {
      defer: async () => { throw reschedule; },
    })).rejects.toBe(reschedule);
    await handle.stop(100);

    expect(calls.some((call) => call.path.endsWith('/claim'))).toBe(true);
    expect(userCodeRuns).toBe(0);
    expect(calls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail'))).toBe(false);
  });
});
