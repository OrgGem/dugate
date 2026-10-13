import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canonicalize, contentHash, createManifest, manifestDigest } from '../dist/manifest.js';
import { WorkerFailure } from '../dist/protocol.js';
import { createEchoResult, startWorker } from '../dist/worker.js';

const IMAGE_DIGEST = `sha256:${'a'.repeat(64)}`;
const TOKEN = 'test-only-business-token';
const BASE_URL = 'http://runtime.test/api/runtime/v1';

class DelayedDelivery extends Error {
  constructor(delayMs) {
    super('queue delivery deferred');
    this.name = 'DelayedError';
    this.delayMs = delayMs;
  }
}

class FakeQueueConsumer {
  handler;
  paused = true;
  closed = false;
  resumeCount = 0;
  deferrals = [];

  start(handler) {
    assert.equal(this.handler, undefined, 'consumer starts once');
    this.handler = handler;
  }

  pause() {
    this.paused = true;
  }

  resume() {
    this.paused = false;
    this.resumeCount += 1;
  }

  async stop() {
    this.closed = true;
  }

  dispatch(payload) {
    assert.equal(typeof this.handler, 'function', 'consumer is started');
    return this.handler(payload, {
      defer: async (delayMs) => {
        this.deferrals.push(delayMs);
        throw new DelayedDelivery(delayMs);
      },
    });
  }
}

class FakeRuntime {
  registrations = new Map();
  workerHeartbeats = new Map();
  retirements = [];
  tasks = new Map();
  requests = [];
  controlState = 'OPEN';
  controlRevision = 1;
  backupState = 'OPEN';
  backupRevision = 1;
  activeVersion;
  activationRevision = 1;
  heartbeatAdmissionSequence = [];
  nextHeartbeatGate;
  heartbeatCalls = 0;

  async fetch(input, init) {
    const url = new URL(String(input));
    assert.equal(init.headers.authorization, `Bearer ${TOKEN}`);
    const prefix = '/api/runtime/v1';
    assert.ok(url.pathname.startsWith(prefix));
    const path = url.pathname.slice(prefix.length);
    const method = init.method;
    const body = init.body === undefined ? undefined : JSON.parse(init.body);
    this.requests.push({ method, path, body: body === undefined ? undefined : structuredClone(body), at: Date.now() });

    const registration = /^\/businesses\/([^/]+)\/versions\/([^/]+)$/.exec(path);
    if (registration && method === 'PUT') {
      const businessId = decodeURIComponent(registration[1]);
      const version = decodeURIComponent(registration[2]);
      const key = `${businessId}@${version}`;
      assert.equal(body.businessId, businessId);
      assert.equal(body.version, version);
      const digest = manifestDigest(body);
      const created = !this.registrations.has(key);
      const value = { businessId, version, digest, queue: `du-business-${businessId}-${version}`, created, replayed: !created };
      this.registrations.set(key, value);
      return json(value, created ? 201 : 200);
    }

    const heartbeat = /^\/workers\/([^/]+)\/heartbeat$/.exec(path);
    if (heartbeat && method === 'PUT') {
      this.heartbeatCalls += 1;
      if (this.nextHeartbeatGate) {
        const gate = this.nextHeartbeatGate;
        this.nextHeartbeatGate = undefined;
        await gate.promise;
      }
      const instanceId = decodeURIComponent(heartbeat[1]);
      const observed = body.observedBackupFenceRevision === this.backupRevision;
      const activeVersion = this.activeVersion === undefined ? body.businessVersion : this.activeVersion;
      const eligible = activeVersion === body.businessVersion;
      const versionState = {
        activeVersion,
        activationRevision: this.activationRevision,
        admissionEligible: eligible,
        admissionReason: eligible ? 'ELIGIBLE' : activeVersion === null ? 'NO_ACTIVE_VERSION' : 'VERSION_NOT_ACTIVE',
      };
      const scriptedState = this.heartbeatAdmissionSequence.shift();
      if (scriptedState) {
        const { clearAdmissionTuple, ...overrides } = scriptedState;
        Object.assign(versionState, overrides);
        if (clearAdmissionTuple) {
          delete versionState.activeVersion;
          delete versionState.activationRevision;
          delete versionState.admissionEligible;
          delete versionState.admissionReason;
        }
      }
      const ack = {
        health: 'HEALTHY',
        leaseExpiresAt: new Date(Date.now() + 90_000).toISOString(),
        capacity: body.capacity,
        controlRevision: this.controlRevision,
        controlState: this.controlState,
        backupEffectFence: {
          state: this.backupState,
          revision: this.backupRevision,
          acknowledged: observed,
        },
        ...versionState,
      };
      const list = this.workerHeartbeats.get(instanceId) ?? [];
      list.push({ body: structuredClone(body), ack });
      this.workerHeartbeats.set(instanceId, list);
      return json(ack);
    }

    const retire = /^\/workers\/([^/]+)\/retire$/.exec(path);
    if (retire && method === 'POST') {
      this.retirements.push({ instanceId: decodeURIComponent(retire[1]), body: structuredClone(body) });
      return json({ retired: true });
    }

    const claim = /^\/tasks\/([^/]+)\/claim$/.exec(path);
    if (claim && method === 'POST') {
      const taskId = decodeURIComponent(claim[1]);
      const task = this.tasks.get(taskId);
      if (!task) return json({ code: 'NOT_FOUND' }, 404);
      task.claims.push(structuredClone(body));
      if (task.claimAmbiguousGate && task.claims.length === 1) {
        task.claimCommitted = true;
        task.claimIdentity = structuredClone(body);
        task.claimStartedResolve?.();
        await task.claimAmbiguousGate.promise;
        throw new Error('claim committed but response was lost');
      }
      if (task.claimCommitted) assert.deepEqual(body, task.claimIdentity);
      if (task.claimError) return json({ code: task.claimError }, task.claimErrorStatus ?? 409);
      return json({
        taskId,
        operationId: task.operationId,
        leaseEpoch: task.leaseEpoch,
        leaseExpiresAt: task.leaseExpiresAt,
        attempt: task.attempt,
        deadlineAt: task.snapshot.deadlineAt,
        executionSnapshot: structuredClone(task.snapshot),
        checkpointRefs: structuredClone(task.checkpointRefs ?? []),
      });
    }

    const taskHeartbeat = /^\/tasks\/([^/]+)\/heartbeat$/.exec(path);
    if (taskHeartbeat && method === 'POST') {
      const task = this.tasks.get(decodeURIComponent(taskHeartbeat[1]));
      if (!task) return json({ code: 'NOT_FOUND' }, 404);
      task.heartbeatCalls += 1;
      if (task.heartbeatGate) await task.heartbeatGate.promise;
      if (body.leaseEpoch !== task.leaseEpoch || task.heartbeatLeaseLost) return json({ code: 'LEASE_LOST' }, 409);
      return json({
        leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        cancelRequested: task.heartbeatCancel === true,
      });
    }

    const complete = /^\/tasks\/([^/]+)\/complete$/.exec(path);
    if (complete && method === 'POST') {
      const taskId = decodeURIComponent(complete[1]);
      const task = this.tasks.get(taskId);
      if (!task) return json({ code: 'NOT_FOUND' }, 404);
      task.completions.push(structuredClone(body));
      const planned = task.completeResponses?.shift();
      if (planned) {
        if (planned.status < 300) task.completed = true;
        return json(planned.body, planned.status);
      }
      task.completed = true;
      return json({ taskId, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false });
    }

    const fail = /^\/tasks\/([^/]+)\/fail$/.exec(path);
    if (fail && method === 'POST') {
      const taskId = decodeURIComponent(fail[1]);
      const task = this.tasks.get(taskId);
      if (!task) return json({ code: 'NOT_FOUND' }, 404);
      task.failures.push(structuredClone(body));
      const state = body.retryable ? 'RETRY_PENDING' : 'FAILED';
      return json({ taskId, state, operationState: state, replayed: false });
    }

    return json({ code: 'NOT_FOUND' }, 404);
  }
}

function json(value, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function uuid(number) {
  return `00000000-0000-4000-8000-${String(number).padStart(12, '0')}`;
}

function taskFor(manifest, id, options = {}) {
  const taskId = uuid(id);
  const operationId = uuid(id + 1000);
  const leaseExpiresAt = new Date(Date.now() + (options.leaseMs ?? 30_000)).toISOString();
  return {
    taskId,
    operationId,
    leaseEpoch: options.leaseEpoch ?? 1,
    leaseExpiresAt,
    attempt: options.attempt ?? 1,
    claims: [],
    heartbeatCalls: 0,
    completions: [],
    failures: [],
    completed: false,
    completeResponses: options.completeResponses ?? [],
    claimError: options.claimError,
    claimErrorStatus: options.claimErrorStatus,
    heartbeatGate: options.heartbeatGate,
    heartbeatCancel: options.heartbeatCancel,
    heartbeatLeaseLost: options.heartbeatLeaseLost,
    snapshot: {
      operationId,
      tenantId: 'tenant-sample',
      businessId: manifest.businessId,
      businessVersion: manifest.version,
      action: 'echo',
      schemaDigest: 'sha256:slice',
      manifestDigest: manifestDigest(manifest),
      resolvedInputRef: { text: options.text ?? 'hello' },
      pinned: {
        profileRevision: 0,
        promptRevisions: {},
        promptOverrides: null,
        connectorBindings: {},
        profilePolicy: null,
        tenantDefaults: null,
      },
      taskKey: 'root',
      kind: 'root',
      payloadRef: options.payloadRef ?? {},
      deadlineAt: null,
      cancelRequested: options.cancelRequested ?? false,
    },
  };
}

function jobFor(manifest, task) {
  return {
    contractVersion: '1',
    deliveryId: `delivery-${task.taskId}`,
    taskId: task.taskId,
    operationId: task.operationId,
    businessId: manifest.businessId,
    businessVersion: manifest.version,
    action: 'echo',
    kind: 'root',
    correlationId: `corr-${task.taskId}`,
  };
}

async function start(runtime, options = {}) {
  const version = options.version ?? '1.0.0';
  const manifest = createManifest(version, IMAGE_DIGEST);
  const consumer = options.consumer ?? new FakeQueueConsumer();
  const worker = await startWorker(manifest, {
    runtimeUrl: BASE_URL,
    runtimeToken: TOKEN,
    consumer,
    fetchImpl: runtime.fetch.bind(runtime),
    concurrency: options.concurrency ?? 1,
    heartbeatIntervalMs: options.heartbeatIntervalMs ?? 30_000,
    leaseSafetyMarginMs: options.leaseSafetyMarginMs ?? 1_000,
    requestTimeoutMs: options.requestTimeoutMs ?? 5_000,
    handler: options.handler,
  });
  return { manifest, consumer, worker };
}

function gate() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function waitFor(predicate, timeoutMs = 2_000) {
  const startAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startAt > timeoutMs) throw new Error('timed out waiting for the fake worker state');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

test('uses a fresh UUID per replica and isolates queues by exact business version', async () => {
  const runtime = new FakeRuntime();
  const first = await start(runtime, { version: '1.0.0' });
  const replica = await start(runtime, { version: '1.0.0' });
  const nextVersion = await start(runtime, { version: '1.1.0' });

  assert.match(first.worker.workerInstanceId, /^[0-9a-f-]{36}$/i);
  assert.notEqual(first.worker.workerInstanceId, replica.worker.workerInstanceId);
  assert.equal(first.worker.queueName, 'du-business-independent-worker-1.0.0');
  assert.equal(first.worker.queueName, replica.worker.queueName);
  assert.equal(nextVersion.worker.queueName, 'du-business-independent-worker-1.1.0');
  assert.equal(runtime.registrations.size, 2);

  await Promise.all([first.worker.stop(100), replica.worker.stop(100), nextVersion.worker.stop(100)]);
  assert.equal(runtime.retirements.length, 3);
  for (const { instanceId, body } of runtime.retirements) {
    const registered = runtime.registrations.get(`${body.businessId}@${body.businessVersion}`);
    assert.ok(registered);
    assert.equal(body.manifestDigest, registered.digest);
    assert.ok(runtime.workerHeartbeats.has(instanceId));
  }
});

test('closes admission for paused control and backup fence until the exact new revision is acknowledged', async () => {
  const runtime = new FakeRuntime();
  runtime.controlState = 'PAUSED';
  runtime.controlRevision = 4;
  runtime.backupState = 'HELD';
  runtime.backupRevision = 7;
  const running = await start(runtime);
  const task = taskFor(running.manifest, 1);
  runtime.tasks.set(task.taskId, task);

  assert.equal(runtime.workerHeartbeats.get(running.worker.workerInstanceId).length, 2);
  assert.equal(running.consumer.paused, true);
  assert.equal(runtime.workerHeartbeats.get(running.worker.workerInstanceId)[0].body.observedBackupFenceRevision, undefined);
  assert.equal(runtime.workerHeartbeats.get(running.worker.workerInstanceId)[1].body.observedBackupFenceRevision, 7);
  await assert.rejects(running.consumer.dispatch(jobFor(running.manifest, task)), (error) => error.name === 'DelayedError');
  assert.equal(task.claims.length, 0);

  runtime.controlState = 'OPEN';
  runtime.controlRevision = 5;
  runtime.backupState = 'OPEN';
  runtime.backupRevision = 8;
  await running.worker.refresh();
  assert.equal(running.consumer.paused, true, 'first heartbeat observes but does not yet acknowledge revision 8');
  await running.worker.refresh();
  assert.equal(running.consumer.paused, false, 'second heartbeat carries the exact observed revision');
  await running.consumer.dispatch(jobFor(running.manifest, task));
  assert.equal(task.completed, true);
  await running.worker.stop(100);
});

test('fails closed for missing or unknown version admission without claiming new work', async () => {
  const invalidStates = [
    { clearAdmissionTuple: true },
    { admissionReason: 'FUTURE_ADMISSION_STATE' },
  ];
  for (const invalidState of invalidStates) {
    const runtime = new FakeRuntime();
    // The startup handshake sends a second heartbeat to acknowledge the
    // backup fence, so keep both replies invalid for version admission.
    runtime.heartbeatAdmissionSequence = [invalidState, invalidState];
    const running = await start(runtime);
    const task = taskFor(running.manifest, 20);
    runtime.tasks.set(task.taskId, task);

    assert.equal(running.consumer.paused, true);
    await assert.rejects(running.consumer.dispatch(jobFor(running.manifest, task)), (error) => error.name === 'DelayedError');
    assert.equal(task.claims.length, 0);
    assert.equal(task.attempt, 1);
    await running.worker.stop(100);
  }
});

test('drains an already-claimed v1 task through cutover while stale v1 admission stays closed', async () => {
  const runtime = new FakeRuntime();
  const handlerGate = gate();
  let taskContext;
  let handlerStarted;
  const started = new Promise((resolve) => { handlerStarted = resolve; });
  const running = await start(runtime, {
    heartbeatIntervalMs: 1_000,
    handler: async (context) => {
      taskContext = context;
      handlerStarted();
      await handlerGate.promise;
      context.assertExternalEffectAllowed();
      return createEchoResult(context);
    },
  });
  const task = taskFor(running.manifest, 21);
  runtime.tasks.set(task.taskId, task);
  const delivery = running.consumer.dispatch(jobFor(running.manifest, task));
  await started;

  runtime.activeVersion = '2.0.0';
  runtime.activationRevision = 2;
  const cutoverAt = Date.now();
  await running.worker.refresh();
  assert.equal(running.consumer.paused, true);
  assert.equal(taskContext.signal.aborted, false);

  runtime.heartbeatAdmissionSequence.push({
    activeVersion: '1.0.0',
    activationRevision: 1,
    admissionEligible: true,
    admissionReason: 'ELIGIBLE',
  });
  await running.worker.refresh();
  assert.equal(running.consumer.paused, true, 'a delayed lower-revision v1 ACK cannot reopen claims');
  assert.equal(taskContext.signal.aborted, false, 'version cutover does not abort the already-claimed lease');

  const waiting = taskFor(running.manifest, 22);
  runtime.tasks.set(waiting.taskId, waiting);
  await assert.rejects(running.consumer.dispatch(jobFor(running.manifest, waiting)), (error) => error.name === 'DelayedError');
  assert.equal(waiting.claims.length, 0);
  assert.equal(waiting.attempt, 1);

  await waitFor(() => task.heartbeatCalls > 0);
  runtime.heartbeatAdmissionSequence.push({
    activeVersion: '1.0.0',
    activationRevision: 3,
    admissionEligible: true,
    admissionReason: 'ELIGIBLE',
  });
  await running.worker.refresh();
  assert.equal(running.consumer.paused, false, 'a new activation revision permits new v1 claims');

  handlerGate.resolve();
  await delivery;
  assert.equal(taskContext.signal.aborted, false);
  assert.equal(task.completed, true);
  assert.equal(task.failures.length, 0);
  assert.equal(task.completions.length, 1);
  assert.equal(task.claims.length, 1);
  assert.ok(runtime.requests.some((request) => request.path === `/tasks/${task.taskId}/heartbeat` && request.at >= cutoverAt));
  await running.worker.stop(100);
});

test('reconciles a lost claim response after cutover before the paused queue can redeliver', async () => {
  const runtime = new FakeRuntime();
  const lostAckGate = gate();
  const claimStartedGate = gate();
  const running = await start(runtime, { heartbeatIntervalMs: 1_000 });
  const task = taskFor(running.manifest, 23);
  task.claimAmbiguousGate = lostAckGate;
  task.claimStartedResolve = claimStartedGate.resolve;
  runtime.tasks.set(task.taskId, task);

  const delivery = running.consumer.dispatch(jobFor(running.manifest, task));
  await claimStartedGate.promise;
  runtime.activeVersion = '2.0.0';
  runtime.activationRevision = 2;
  await running.worker.refresh();
  assert.equal(running.consumer.paused, true);

  const waiting = taskFor(running.manifest, 24);
  runtime.tasks.set(waiting.taskId, waiting);
  await assert.rejects(running.consumer.dispatch(jobFor(running.manifest, waiting)), (error) => error.name === 'DelayedError');
  assert.equal(waiting.claims.length, 0, 'cutover still denies a new v1 claim');

  lostAckGate.resolve();
  await delivery;
  assert.equal(task.claims.length, 2);
  assert.deepEqual(task.claims[1], task.claims[0], 'replay preserves task, delivery, and worker identity');
  assert.equal(task.completed, true);
  assert.equal(task.completions.length, 1);
  assert.equal(task.failures.length, 0);
  await running.worker.stop(100);
});

test('defers admission and capacity claim errors with backoff, and only ACKs durable attempt exhaustion', async () => {
  const runtime = new FakeRuntime();
  let handlerCalls = 0;
  const running = await start(runtime, {
    handler: async (context) => {
      handlerCalls += 1;
      return createEchoResult(context);
    },
  });
  const denialCodes = [
    'VERSION_NOT_ACTIVE',
    'NO_ACTIVE_VERSION',
    'VERSION_NOT_ENABLED',
    'BUSINESS_SUBMISSIONS_PAUSED',
    'WORKER_CAPACITY_EXHAUSTED',
  ];

  for (const [index, code] of denialCodes.entries()) {
    const task = taskFor(running.manifest, 30 + index, { claimError: code });
    runtime.tasks.set(task.taskId, task);
    await assert.rejects(running.consumer.dispatch(jobFor(running.manifest, task)), (error) => error.name === 'DelayedError');
    assert.equal(task.attempt, 1, `${code} does not consume a task attempt`);
    assert.equal(task.completions.length, 0);
    assert.equal(task.failures.length, 0);
    assert.ok(running.consumer.deferrals.at(-1) >= 125);
  }

  const exhausted = taskFor(running.manifest, 40, {
    claimError: 'TASK_ATTEMPTS_EXHAUSTED',
    claimErrorStatus: 409,
  });
  runtime.tasks.set(exhausted.taskId, exhausted);
  await assert.rejects(running.consumer.dispatch(jobFor(running.manifest, exhausted)), (error) => error.name === 'DelayedError');
  assert.equal(exhausted.attempt, 1);

  exhausted.claimErrorStatus = 410;
  await running.consumer.dispatch(jobFor(running.manifest, exhausted));
  assert.equal(handlerCalls, 0);
  assert.equal(exhausted.completions.length, 0);
  assert.equal(exhausted.failures.length, 0);
  await running.worker.stop(100);
});

test('claims the Runtime snapshot and retries an ambiguous completion with the same body, without rerunning the handler', async () => {
  const runtime = new FakeRuntime();
  let handlerCalls = 0;
  const running = await start(runtime, {
    handler: async (context) => {
      handlerCalls += 1;
      return createEchoResult(context);
    },
  });
  const task = taskFor(running.manifest, 2, { text: 'independent' });
  task.completeResponses.push({ status: 500, body: { code: 'TEMPORARY_UNAVAILABLE' } });
  runtime.tasks.set(task.taskId, task);
  const job = jobFor(running.manifest, task);

  assert.equal(Object.hasOwn(job, 'text'), false, 'queue messages carry no trusted input');
  await running.consumer.dispatch(job);

  assert.equal(handlerCalls, 1);
  assert.equal(task.claims.length, 1);
  assert.equal(task.claims[0].deliveryId, job.deliveryId);
  assert.equal(task.claims[0].workerInstanceId, running.worker.workerInstanceId);
  assert.equal(task.claims[0].businessId, 'independent-worker');
  assert.equal(task.completions.length, 2);
  assert.deepEqual(task.completions[0], task.completions[1]);
  assert.equal(task.completions[0].leaseEpoch, 1);
  assert.equal(task.completions[0].resultRef, canonicalize({ text: 'independent' }));
  assert.equal(task.completions[0].resultHash, contentHash(canonicalize({ text: 'independent' })));
  assert.deepEqual(task.completions[0].outputArtifactIds, []);
  await running.worker.stop(100);
});

test('fails a valid unsupported claim explicitly, maps retryable handler errors, and leaves cancellation terminal', async () => {
  const runtime = new FakeRuntime();
  let handlerCalls = 0;
  const running = await start(runtime, {
    handler: async () => {
      handlerCalls += 1;
      throw new WorkerFailure('SAMPLE_RETRY', true, 250);
    },
  });
  const unsupported = taskFor(running.manifest, 3, { payloadRef: { child: true } });
  const retryable = taskFor(running.manifest, 4);
  const cancelled = taskFor(running.manifest, 5, { cancelRequested: true });
  runtime.tasks.set(unsupported.taskId, unsupported);
  runtime.tasks.set(retryable.taskId, retryable);
  runtime.tasks.set(cancelled.taskId, cancelled);

  await running.consumer.dispatch(jobFor(running.manifest, unsupported));
  assert.equal(unsupported.failures[0].errorCode, 'UNSUPPORTED_WORKER_PROTOCOL');
  assert.equal(unsupported.failures[0].retryable, false);
  assert.equal(unsupported.completions.length, 0);

  await running.consumer.dispatch(jobFor(running.manifest, retryable));
  assert.equal(retryable.failures[0].errorCode, 'SAMPLE_RETRY');
  assert.equal(retryable.failures[0].retryable, true);
  assert.equal(retryable.failures[0].retryAfterMs, 250);
  assert.equal(handlerCalls, 1);

  await running.consumer.dispatch(jobFor(running.manifest, cancelled));
  assert.equal(cancelled.completions.length, 0);
  assert.equal(cancelled.failures.length, 0);
  await running.worker.stop(100);
});

test('a late task-heartbeat ACK cannot revive the prior lease generation', async () => {
  const runtime = new FakeRuntime();
  const heartbeatGate = gate();
  const handlerGate = gate();
  let taskContext;
  const running = await start(runtime, {
    heartbeatIntervalMs: 1_000,
    leaseSafetyMarginMs: 100,
    handler: async (context) => {
      taskContext = context;
      await handlerGate.promise;
      return createEchoResult(context);
    },
  });
  const task = taskFor(running.manifest, 6, { leaseMs: 1_350, heartbeatGate });
  runtime.tasks.set(task.taskId, task);
  const dispatch = running.consumer.dispatch(jobFor(running.manifest, task));
  await waitFor(() => taskContext !== undefined);
  await waitFor(() => task.heartbeatCalls > 0, 1_600);
  const watchdogDeadline = Date.parse(task.leaseExpiresAt) - 100;
  await waitFor(() => Date.now() >= watchdogDeadline + 20, 1_000);
  heartbeatGate.resolve();
  await waitFor(() => taskContext.signal.aborted);
  assert.equal(taskContext.signal.reason, 'lease-lost');
  handlerGate.resolve();
  await assert.rejects(dispatch, (error) => error.name === 'DelayedError');
  assert.equal(task.completions.length, 0);
  assert.equal(task.failures.length, 0);
  assert.ok(running.consumer.deferrals[0] >= 0);
  await running.worker.stop(100);
});

test('continues zero-capacity worker heartbeats during drain and retires the exact identity after settlement', async () => {
  const runtime = new FakeRuntime();
  const handlerGate = gate();
  let taskStarted;
  const started = new Promise((resolve) => { taskStarted = resolve; });
  const running = await start(runtime, {
    handler: async (context) => {
      taskStarted();
      await handlerGate.promise;
      return createEchoResult(context);
    },
  });
  const task = taskFor(running.manifest, 7);
  runtime.tasks.set(task.taskId, task);
  const delivery = running.consumer.dispatch(jobFor(running.manifest, task));
  await started;

  const stopping = running.worker.stop(1_000);
  await running.worker.refresh();
  const latestHeartbeat = runtime.workerHeartbeats.get(running.worker.workerInstanceId).at(-1);
  assert.equal(latestHeartbeat.body.capacity, 0);
  assert.equal(latestHeartbeat.body.activeTasks, 1);
  handlerGate.resolve();
  await delivery;
  await stopping;

  assert.equal(task.completed, true);
  assert.equal(running.consumer.closed, true);
  assert.deepEqual(runtime.retirements.at(-1), {
    instanceId: running.worker.workerInstanceId,
    body: {
      businessId: running.manifest.businessId,
      businessVersion: running.manifest.version,
      manifestDigest: manifestDigest(running.manifest),
    },
  });
});

test('bounds forced shutdown and skips retirement while an uncooperative handler is still in flight', async () => {
  const runtime = new FakeRuntime();
  const handlerGate = gate();
  let taskContext;
  const running = await start(runtime, {
    handler: async (context) => {
      taskContext = context;
      await handlerGate.promise;
      return createEchoResult(context);
    },
  });
  const task = taskFor(running.manifest, 8);
  runtime.tasks.set(task.taskId, task);
  const delivery = running.consumer.dispatch(jobFor(running.manifest, task));
  await waitFor(() => taskContext !== undefined);

  const before = Date.now();
  await running.worker.stop(25);
  assert.ok(Date.now() - before < 1_500);
  assert.equal(taskContext.signal.reason, 'shutdown');
  assert.equal(runtime.retirements.length, 0, 'a live handler prevents worker retirement');
  handlerGate.resolve();
  await assert.rejects(delivery, (error) => error.name === 'DelayedError');
  assert.equal(task.completions.length, 0);
});

test('a stalled queue pause is bounded and a confirmed close permits exact retirement', async () => {
  const runtime = new FakeRuntime();
  const consumer = new FakeQueueConsumer();
  consumer.pause = () => new Promise(() => {});
  const running = await start(runtime, { consumer });

  const before = Date.now();
  await running.worker.stop(0);

  assert.ok(Date.now() - before < 2_500);
  assert.equal(consumer.closed, true, 'the worker still attempts a bounded close after pause times out');
  assert.equal(runtime.retirements.length, 1, 'a confirmed close authorizes exact-identity retirement');
  assert.equal(runtime.retirements[0].instanceId, running.worker.workerInstanceId);
  assert.deepEqual(runtime.retirements[0].body, {
    businessId: running.manifest.businessId,
    businessVersion: running.manifest.version,
    manifestDigest: manifestDigest(running.manifest),
  });
});

test('Runtime request timeout also covers a stalled response body', async () => {
  const { RuntimeClient } = await import('../dist/protocol.js');
  const client = new RuntimeClient({
    baseUrl: BASE_URL,
    token: TOKEN,
    timeoutMs: 1_000,
    fetchImpl: async (_url, init) => new Response(new ReadableStream({
      start(controller) {
        init.signal.addEventListener('abort', () => controller.error(new Error('aborted')), { once: true });
      },
    }), { status: 200 }),
  });

  const before = Date.now();
  await assert.rejects(client.registerBusinessVersion(createManifest('9.9.9', IMAGE_DIGEST)), (error) => {
    assert.equal(error.code, 'TEMPORARY_UNAVAILABLE');
    assert.equal(error.ambiguous, true);
    return true;
  });
  assert.ok(Date.now() - before < 2_500);
});
