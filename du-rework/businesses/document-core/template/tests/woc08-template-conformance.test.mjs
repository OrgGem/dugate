import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const templateRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const distRoot = resolve(process.env.WOC08_TEMPLATE_DIST ?? join(templateRoot, 'dist'));
const require = createRequire(import.meta.url);

// The template's emitted CommonJS keeps @du/* specifiers. Point isolated test
// builds at the isolated output tree without touching the checked-in shims or
// the shared template dist directory.
for (const [name, entry] of [
  ['contracts', 'vendor/contracts/src/index.js'],
  ['document-kit', 'vendor/document-kit/src/index.js'],
  ['egress', 'vendor/egress/src/index.js'],
  ['observability', 'vendor/observability/src/index.js'],
  ['worker-sdk', 'vendor/worker-sdk/src/index.js'],
]) {
  const packageDir = join(distRoot, 'node_modules', '@du', name);
  mkdirSync(packageDir, { recursive: true });
  writeFileSync(join(packageDir, 'package.json'), JSON.stringify({
    name: `@du/${name}`,
    version: '0.1.0',
    main: `../../../${entry}`,
  }, null, 2));
}
process.env.NODE_PATH = [
  join(distRoot, 'node_modules'),
  join(templateRoot, 'node_modules'),
  process.env.NODE_PATH,
].filter(Boolean).join(delimiter);
require('node:module').Module._initPaths();
const isolatedRequire = createRequire(join(distRoot, '__woc08_resolver.cjs'));
for (const name of ['contracts', 'worker-sdk']) {
  const resolved = isolatedRequire.resolve(`@du/${name}`);
  assert.ok(
    resolved.toLowerCase().startsWith(distRoot.toLowerCase()),
    `@du/${name} must resolve from the isolated template build, got ${resolved}`
  );
}

const contracts = require(join(distRoot, 'vendor/contracts/src/index.js'));
const { defineBusiness, startWorker, classifyFailure } = require(join(distRoot, 'vendor/worker-sdk/src/worker.js'));
const { RuntimeClient, RuntimeError, AmbiguousReportError } = require(join(distRoot, 'vendor/worker-sdk/src/runtime-client.js'));
const { createConnectorInvoker } = require(join(distRoot, 'vendor/worker-sdk/src/connector-invoker.js'));

const RUNTIME_URL = 'http://runtime.test/api/runtime/v1';
const TASK_ID = randomUUID();
const OPERATION_ID = randomUUID();
const MANIFEST = {
  contractVersion: '1',
  businessId: 'woc08-template',
  displayName: 'WOC-08 template conformance fixture',
  description: 'Isolated template vectors for runtime and delivery compatibility.',
  version: '1.0.0',
  imageDigest: `sha256:${'a'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [{
    name: 'run',
    displayName: 'Run',
    description: 'Conformance fixture action',
    inputSchema: { type: 'object' },
    outputSchema: { type: 'object' },
    profileSchema: { type: 'object' },
    connectorSlots: [],
    artifactPolicy: { minFiles: 0, maxFiles: 1 },
    capabilities: { cancel: true, resume: true },
    defaultLimits: { maxParallelTasks: 1 },
  }],
};
const validation = contracts.validateManifest(MANIFEST);
assert.equal(validation.ok, true, 'the conformance manifest must validate');
const MANIFEST_DIGEST = validation.digest;

function jsonResponse(status, value) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problem(status, code) {
  return {
    type: `urn:du:error:${code.toLowerCase().replaceAll('_', '-')}`,
    title: code,
    status,
    code,
    detail: 'runtime deferred this delivery',
  };
}

function healthyHeartbeat({ fence = true } = {}) {
  return {
    health: 'HEALTHY',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    capacity: 1,
    controlRevision: 0,
    controlState: 'OPEN',
    ...(fence ? { backupEffectFence: { state: 'OPEN', revision: 0, acknowledged: true } } : {}),
  };
}

function makeClaim(taskId, operationId, leaseMs = 60_000) {
  return {
    taskId,
    operationId,
    leaseEpoch: 1,
    leaseExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
    attempt: 1,
    deadlineAt: null,
    executionSnapshot: {
      operationId,
      tenantId: 'woc08-tenant',
      businessId: MANIFEST.businessId,
      businessVersion: MANIFEST.version,
      action: 'run',
      schemaDigest: `sha256:${'b'.repeat(64)}`,
      manifestDigest: MANIFEST_DIGEST,
      resolvedInputRef: { fixture: true },
      pinned: {
        profileRevision: 1,
        promptRevisions: {},
        promptOverrides: null,
        connectorBindings: {},
        profilePolicy: null,
      },
      taskKey: 'root',
      kind: 'root',
      payloadRef: {},
      deadlineAt: null,
      cancelRequested: false,
    },
    checkpointRefs: [],
  };
}

function makeJob(taskId = TASK_ID, operationId = OPERATION_ID, deliveryId = `delivery-${randomUUID()}`) {
  return {
    contractVersion: '1',
    deliveryId,
    taskId,
    operationId,
    businessId: MANIFEST.businessId,
    businessVersion: MANIFEST.version,
    action: 'run',
    kind: 'root',
    correlationId: `corr-${taskId}`,
  };
}

function makeConsumer() {
  let handler;
  let starts = 0;
  let stops = 0;
  return {
    consumer: {
      start(next) {
        starts += 1;
        handler = next;
      },
      async stop() {
        stops += 1;
      },
    },
    get starts() { return starts; },
    get stops() { return stops; },
    push(job, delivery) {
      assert.equal(typeof handler, 'function', 'consumer must be started before a delivery');
      return handler(job, delivery);
    },
  };
}

function makeRuntimeHarness({ onClaim, heartbeat = healthyHeartbeat() } = {}) {
  const calls = [];
  const fetchImpl = async (input, init = {}) => {
    const url = new URL(String(input));
    const path = url.pathname.replace('/api/runtime/v1', '');
    const method = init.method ?? 'GET';
    const body = typeof init.body === 'string' ? JSON.parse(init.body) : undefined;
    const call = { method, path, body, signal: init.signal };
    calls.push(call);

    if (method === 'PUT' && path === `/businesses/${MANIFEST.businessId}/versions/${MANIFEST.version}`) {
      return jsonResponse(201, {
        businessId: MANIFEST.businessId,
        version: MANIFEST.version,
        digest: MANIFEST_DIGEST,
        queue: contracts.businessQueueName(MANIFEST.businessId, MANIFEST.version),
        created: true,
        replayed: false,
      });
    }
    if (method === 'PUT' && /^\/workers\/[^/]+\/heartbeat$/.test(path)) {
      return jsonResponse(200, typeof heartbeat === 'function' ? heartbeat(call) : heartbeat);
    }
    const claimMatch = path.match(/^\/tasks\/([^/]+)\/claim$/);
    if (method === 'POST' && claimMatch) {
      const result = onClaim
        ? await onClaim(decodeURIComponent(claimMatch[1]), call)
        : { status: 200, json: makeClaim(decodeURIComponent(claimMatch[1]), OPERATION_ID) };
      return jsonResponse(result.status, result.json);
    }
    const heartbeatMatch = path.match(/^\/tasks\/([^/]+)\/heartbeat$/);
    if (method === 'POST' && heartbeatMatch) {
      return jsonResponse(200, {
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        cancelRequested: false,
      });
    }
    const completeMatch = path.match(/^\/tasks\/([^/]+)\/complete$/);
    if (method === 'POST' && completeMatch) {
      return jsonResponse(200, {
        taskId: decodeURIComponent(completeMatch[1]),
        state: 'SUCCEEDED',
        operationState: 'SUCCEEDED',
        replayed: false,
      });
    }
    const failMatch = path.match(/^\/tasks\/([^/]+)\/fail$/);
    if (method === 'POST' && failMatch) {
      return jsonResponse(200, {
        taskId: decodeURIComponent(failMatch[1]),
        state: 'FAILED',
        operationState: 'FAILED',
        replayed: false,
      });
    }
    return jsonResponse(404, problem(404, 'NOT_FOUND'));
  };
  return { calls, fetchImpl };
}

function definition(handler = async () => ({ kind: 'completed', resultRef: 'artifact://woc08-result' })) {
  return defineBusiness(MANIFEST, { root: handler });
}

async function startHarness({ onClaim, heartbeat, handler, heartbeatIntervalMs = 60_000, leaseSafetyMarginMs = 20 } = {}) {
  const runtime = makeRuntimeHarness({ onClaim, heartbeat });
  const consumer = makeConsumer();
  const worker = await startWorker(definition(handler), {
    runtimeUrl: RUNTIME_URL,
    runtimeToken: 'woc08-test-token',
    workerInstanceId: `worker-${randomUUID()}`,
    fetchImpl: runtime.fetchImpl,
    consumer: consumer.consumer,
    heartbeatIntervalMs,
    leaseSafetyMarginMs,
    tempSweep: { enabled: false },
  });
  return { worker, consumer, calls: runtime.calls };
}

test('deferred admission remains recoverable and the next delivery can run after admission opens', async () => {
  let claimCount = 0;
  let handlerCount = 0;
  const taskId = randomUUID();
  const operationId = randomUUID();
  const { worker, consumer, calls } = await startHarness({
    onClaim: async (claimedTaskId) => {
      claimCount += 1;
      if (claimCount === 1) return { status: 409, json: problem(409, 'BUSINESS_DISABLED') };
      return { status: 200, json: makeClaim(claimedTaskId, operationId) };
    },
    handler: async () => {
      handlerCount += 1;
      return { kind: 'completed', resultRef: 'artifact://admitted' };
    },
  });
  const delayError = new Error('delivery moved to delayed recovery');
  const delays = [];
  try {
    await assert.rejects(
      consumer.push(makeJob(taskId, operationId), {
        defer: async (delayMs) => {
          delays.push(delayMs);
          throw delayError;
        },
      }),
      (error) => error === delayError
    );
    assert.equal(claimCount, 1);
    assert.equal(handlerCount, 0);
    assert.equal(calls.some((call) => call.path.endsWith('/complete') || call.path.endsWith('/fail')), false);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] > 0, 'deferred claim uses a bounded non-zero delay');

    await consumer.push(makeJob(taskId, operationId), {
      defer: async () => { throw new Error('admitted delivery should not defer'); },
    });
    assert.equal(claimCount, 2);
    assert.equal(handlerCount, 1);
    assert.equal(calls.filter((call) => call.path.endsWith('/complete')).length, 1);
  } finally {
    await worker.stop(250);
  }
});

test('missing v1 backupEffectFence is UNKNOWN and prevents queue consumption', async () => {
  const runtime = makeRuntimeHarness({ heartbeat: healthyHeartbeat({ fence: false }) });
  const consumer = makeConsumer();
  await assert.rejects(
    startWorker(definition(), {
      runtimeUrl: RUNTIME_URL,
      runtimeToken: 'woc08-test-token',
      workerInstanceId: `worker-${randomUUID()}`,
      fetchImpl: runtime.fetchImpl,
      consumer: consumer.consumer,
      tempSweep: { enabled: false },
    }),
    (error) => error?.name === 'WorkerCompatibilityError' && /backupEffectFence/.test(error.message)
  );
  assert.equal(consumer.starts, 0);
  assert.equal(consumer.stops, 1);
  assert.equal(runtime.calls.some((call) => call.path.endsWith('/claim')), false);
});

test('body deadlines cover successful write ACKs; claim ACK parse failures remain retryable', async () => {
  let writeCount = 0;
  let writeSignal;
  const pendingBodyFetch = async (_input, init) => {
    writeCount += 1;
    writeSignal = init.signal;
    return {
      ok: true,
      status: 200,
      text: () => new Promise(() => undefined),
    };
  };
  const runtime = new RuntimeClient({
    baseUrl: RUNTIME_URL,
    token: 'woc08-test-token',
    fetchImpl: pendingBodyFetch,
    timeoutMs: 25,
  });
  await assert.rejects(
    runtime.completeTask(TASK_ID, {
      leaseEpoch: 1,
      resultRef: 'artifact://completed',
      resultHash: createHash('sha256').update('artifact://completed').digest('hex'),
      outputArtifactIds: [],
    }),
    (error) => error instanceof AmbiguousReportError && error.isRetryable
  );
  assert.equal(writeCount, 1, 'ambiguous writes are never blindly repeated');
  assert.equal(writeSignal.aborted, true, 'the request signal is aborted at the body deadline');

  let claimCount = 0;
  const malformedClaimRuntime = new RuntimeClient({
    baseUrl: RUNTIME_URL,
    token: 'woc08-test-token',
    fetchImpl: async () => {
      claimCount += 1;
      return new Response('{', { status: 200 });
    },
  });
  const claimError = await malformedClaimRuntime.claimTask(TASK_ID, {
    deliveryId: `delivery-${randomUUID()}`,
    workerInstanceId: 'worker-woc08',
    businessId: MANIFEST.businessId,
  }).catch((error) => error);
  assert.ok(claimError instanceof RuntimeError);
  assert.equal(claimError.status, 200);
  assert.equal(claimError.code, 'TEMPORARY_UNAVAILABLE');
  assert.equal(claimError.isRetryable, true);
  assert.equal(claimCount, 1);
});

test('lease expiry aborts an uncooperative handler while single-flight protects the task and other tasks progress', async () => {
  const expiredTaskId = randomUUID();
  const expiredOperationId = randomUUID();
  const otherTaskId = randomUUID();
  const otherOperationId = randomUUID();
  let releaseExpiredHandler;
  let expiredHandlerEntered;
  const entered = new Promise((resolveEntered) => { expiredHandlerEntered = resolveEntered; });
  let expiredSignal;
  let expiredHandlerCount = 0;
  let otherHandlerCount = 0;
  const claimCounts = new Map();
  const { worker, consumer, calls } = await startHarness({
    onClaim: async (taskId) => {
      const count = (claimCounts.get(taskId) ?? 0) + 1;
      claimCounts.set(taskId, count);
      if (taskId === expiredTaskId && count > 1) {
        return { status: 410, json: problem(410, 'TASK_TERMINAL') };
      }
      const operationId = taskId === expiredTaskId ? expiredOperationId : otherOperationId;
      const leaseMs = taskId === expiredTaskId ? 160 : 60_000;
      return { status: 200, json: makeClaim(taskId, operationId, leaseMs) };
    },
    handler: async (ctx) => {
      if (ctx.taskId === expiredTaskId) {
        expiredHandlerCount += 1;
        expiredSignal = ctx.signal;
        expiredHandlerEntered();
        await new Promise((resolveRelease) => { releaseExpiredHandler = resolveRelease; });
        return { kind: 'completed', resultRef: 'artifact://late-expired-result' };
      }
      otherHandlerCount += 1;
      return { kind: 'completed', resultRef: 'artifact://other-task-result' };
    },
    heartbeatIntervalMs: 60_000,
    leaseSafetyMarginMs: 20,
  });
  const firstDeferred = new Error('expired original delivery deferred');
  const first = consumer.push(makeJob(expiredTaskId, expiredOperationId), {
    defer: async () => { throw firstDeferred; },
  });
  const firstSettled = assert.rejects(first, (error) => error === firstDeferred);

  try {
    await entered;
    await new Promise((resolveAbort, rejectAbort) => {
      const timer = setTimeout(() => rejectAbort(new Error('lease watchdog did not fire')), 1_000);
      expiredSignal.addEventListener('abort', () => {
        clearTimeout(timer);
        resolveAbort();
      }, { once: true });
    });
    assert.equal(expiredSignal.reason, 'lease-lost');

    const duplicateDeferred = new Error('duplicate expired delivery deferred');
    await assert.rejects(
      consumer.push(makeJob(expiredTaskId, expiredOperationId), {
        defer: async () => { throw duplicateDeferred; },
      }),
      (error) => error === duplicateDeferred
    );
    assert.equal(claimCounts.get(expiredTaskId), 1, 'a local duplicate cannot issue a second claim');
    assert.equal(expiredHandlerCount, 1, 'a duplicate cannot start a second handler');

    await consumer.push(makeJob(otherTaskId, otherOperationId));
    assert.equal(claimCounts.get(otherTaskId), 1);
    assert.equal(otherHandlerCount, 1, 'single-flight is keyed by task, so unrelated work progresses');

    releaseExpiredHandler();
    await firstSettled;
    assert.equal(calls.some((call) => call.path === `/tasks/${expiredTaskId}/complete`), false);
    assert.equal(calls.some((call) => call.path === `/tasks/${expiredTaskId}/fail`), false);
    assert.equal(calls.some((call) => call.path.includes('/invocations/')), false);

    // The settled handler releases its local reservation. Backend terminality
    // safely acknowledges the subsequent recovery delivery without another run.
    await consumer.push(makeJob(expiredTaskId, expiredOperationId));
    assert.equal(claimCounts.get(expiredTaskId), 2);
    assert.equal(expiredHandlerCount, 1);
  } finally {
    if (releaseExpiredHandler) releaseExpiredHandler();
    await worker.stop(500);
  }
});

test('INVOCATION_UNKNOWN retries the same invocation ID and the mock connector dispatches once', async () => {
  const invocationId = '00000000-0000-4000-8000-000000000101';
  const grant = {
    grant: 'signed-grant',
    invocationId,
    connectorId: 'connector-1',
    connectorRevision: 1,
    expiresAt: '2099-01-01T00:00:00.000Z',
    allowedOptions: {},
  };
  const payload = {
    contractVersion: '1',
    invocationId,
    grant: 'signed-grant',
    operationId: '00000000-0000-4000-8000-000000000201',
    taskId: '00000000-0000-4000-8000-000000000301',
    stepKey: 'summarize',
    bindingSlot: 'text-generation',
    input: { prompt: 'Summarize this fixture.' },
    deadlineAt: '2099-01-01T00:00:00.000Z',
  };
  const idsSeen = [];
  let providerDispatches = 0;
  let settled = false;
  const invoke = createConnectorInvoker({
    baseUrl: 'http://connector.test/internal/v1',
    fetchImpl: async (_input, init) => {
      const request = JSON.parse(String(init.body));
      idsSeen.push(request.invocationId);
      if (providerDispatches === 0) {
        providerDispatches += 1;
        // The mock connector accepted provider work but the response was lost.
        throw new Error('connection reset after dispatch');
      }
      if (!settled) {
        return jsonResponse(409, {
          error: { code: 'INVOCATION_UNKNOWN', message: 'the same invocation is still in flight' },
        });
      }
      return jsonResponse(200, { invocationId, state: 'SUCCEEDED' });
    },
  });

  const first = await invoke(grant, payload).catch((error) => error);
  assert.equal(classifyFailure(first).errorCode, 'INVOCATION_UNKNOWN');
  assert.equal(classifyFailure(first).retryable, true);
  const inFlightReplay = await invoke(grant, payload).catch((error) => error);
  assert.equal(classifyFailure(inFlightReplay).retryable, true);
  settled = true;
  const replayed = await invoke(grant, payload);

  assert.equal(replayed.invocationId, invocationId);
  assert.deepEqual(idsSeen, [invocationId, invocationId, invocationId]);
  assert.equal(providerDispatches, 1, 'the mock connector ledger never dispatches provider work twice');
});
