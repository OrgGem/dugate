/**
 * CONV-07: W38-A6 P2-09 health and graceful shutdown — split out of runtime.test.ts.
 *
 * Cases verbatim; own explicit fixture (per-suite namespace: schema, Redis
 * DB, businessId, queue, port 0) via tests/helpers/runtime-harness. Without
 * DU_LIVE_INFRA=1 nothing boots — no createApp, no listen, no connection.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { createApp, type App } from '../src/server';
import { contentHash } from '@du/contracts';
import { createRuntimeFixture, liveDescribe, warnIfSkipped } from './helpers/runtime-harness';

const F = createRuntimeFixture({ suite: 'health' });
const MANIFEST = F.MANIFEST;
const TENANT_ID = F.TENANT_ID;
const DATABASE_URL = F.DATABASE_URL;
const REDIS_URL = F.REDIS_URL;
const RAW_API_KEY = F.RAW_API_KEY;
const RUNTIME_TOKEN = F.RUNTIME_TOKEN;
const WORKER_IDENTITY_TOKEN = F.WORKER_IDENTITY_TOKEN;
const ADMIN_TOKEN = F.ADMIN_TOKEN;
const USAGE_TOKEN = F.USAGE_TOKEN;
const GRANT_SECRET = F.GRANT_SECRET;
const http = F.http;
const hashKey = F.hashKey;
const rtHeaders = F.rtHeaders;
const adminHeaders = F.adminHeaders;
const pubHeaders = F.pubHeaders;
const usageHeaders = F.usageHeaders;
const findJobForOperation = F.findJobForOperation;
const createUsageTarget = F.createUsageTarget;
const usageEvent = F.usageEvent;

let app: App;
let baseUrl: string;
let queueName: string;

warnIfSkipped('runtime-health.test.ts');

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
  beforeAll(async () => {
    ({ app, baseUrl, queueName } = await F.setup());
  }, 120_000);

  afterAll(async () => {
    await F.teardown();
  }, 30_000);

describe('W38-A6: P2-09 health and graceful shutdown', () => {
  beforeAll(async () => {
    // Clear any uncompleted RUNNING tasks from prior test cases so active lease baseline is 0
    await app.db.query("UPDATE tasks SET state='CANCELLED' WHERE state='RUNNING'");
  });

  test('health endpoint returns 200 ok on /health and /api/v1/health with db, redis, and activeLeases', async () => {
    const resHealth = await http(baseUrl, '/health');
    expect(resHealth.status).toBe(200);
    expect(resHealth.body).toEqual({
      status: 'ok',
      db: true,
      redis: true,
      activeLeases: expect.any(Number),
    });

    const resV1 = await http(baseUrl, '/api/v1/health');
    expect(resV1.status).toBe(200);
    expect(resV1.body).toEqual({
      status: 'ok',
      db: true,
      redis: true,
      activeLeases: expect.any(Number),
    });

    // Active lease count reflects RUNNING tasks
    const initialLeases = resV1.body.activeLeases as number;
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'w38-health-count' } },
    });
    expect(submit.status).toBe(202);
    const opId = submit.body.operationId as string;
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(opId);

    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: 'w38-health-worker' },
    });
    expect(claim.status).toBe(200);

    const duringRunning = await http(baseUrl, '/api/v1/health');
    expect(duringRunning.status).toBe(200);
    expect(duringRunning.body.activeLeases).toBe(initialLeases + 1);

    // Complete the task and verify active lease count decrements
    const done = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: {
        leaseEpoch: claim.body.leaseEpoch as number,
        resultRef: 'ref://w38-health',
        resultHash: contentHash('ref://w38-health'),
      },
    });
    expect(done.status).toBe(200);

    const afterComplete = await http(baseUrl, '/api/v1/health');
    expect(afterComplete.status).toBe(200);
    expect(afterComplete.body.activeLeases).toBe(initialLeases);
  });

  test('health endpoint returns 503 degraded when DB or Redis is unreachable', async () => {
    // Simulated DB failure
    const dbSpy = jest.spyOn(app.db, 'query').mockImplementationOnce(() => {
      throw new Error('simulated DB connection failure');
    });
    const resDegradedDb = await http(baseUrl, '/api/v1/health');
    expect(resDegradedDb.status).toBe(503);
    expect(resDegradedDb.body).toEqual({
      status: 'degraded',
      db: false,
      redis: true,
      activeLeases: 0,
    });
    dbSpy.mockRestore();

    // Simulated Redis failure
    const redisSpy = jest.spyOn(app.redis, 'ping').mockImplementationOnce(async () => {
      throw new Error('simulated Redis ping failure');
    });
    const resDegradedRedis = await http(baseUrl, '/api/v1/health');
    expect(resDegradedRedis.status).toBe(503);
    expect(resDegradedRedis.body).toEqual({
      status: 'degraded',
      db: true,
      redis: false,
      activeLeases: expect.any(Number),
    });
    redisSpy.mockRestore();
  });

  test('drain stops accepting new claims and close() waits for active leases to complete', async () => {
    // Spin up an isolated App instance to test graceful close() lifecycle
    const testApp = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      workerIdentityTokensByBusiness: { [MANIFEST.businessId]: WORKER_IDENTITY_TOKEN },
      adminToken: ADMIN_TOKEN,
      usageToken: USAGE_TOKEN,
      invocationGrantSecret: GRANT_SECRET,
      autoDispatch: false,
      autoMigrate: false,
    });
    const testServer = await testApp.listen();
    const testPort = (testServer.address() as { port: number }).port;
    const testBaseUrl = `http://127.0.0.1:${testPort}`;

    // Submit an operation and claim it
    const submit = await http(testBaseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'w38-drain-complete' } },
    });
    expect(submit.status).toBe(202);
    const opId = submit.body.operationId as string;
    await testApp.dispatcher.dispatchOnce();

    const q = testApp.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === opId);
    expect(job).toBeDefined();
    const payload = job!.data as { taskId: string; deliveryId: string };

    const claim = await http(testBaseUrl, `/api/runtime/v1/tasks/${payload.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: payload.deliveryId, workerInstanceId: 'w38-drain-worker' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;

    // Verify claimTask is rejected once draining is set
    testApp.runtime.setDraining(true);
    const rejectedClaim = await http(testBaseUrl, `/api/runtime/v1/tasks/${payload.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: payload.deliveryId, workerInstanceId: 'w38-drain-worker' },
    });
    expect(rejectedClaim.status).toBe(503);
    expect(rejectedClaim.body.code).toBe('SHUTTING_DOWN');

    // While draining, complete the task in-flight after 150ms
    setTimeout(async () => {
      await http(testBaseUrl, `/api/runtime/v1/tasks/${payload.taskId}/complete`, {
        method: 'POST',
        headers: rtHeaders(),
        body: {
          leaseEpoch,
          resultRef: 'ref://w38-drained',
          resultHash: contentHash('ref://w38-drained'),
        },
      });
    }, 150);

    const start = Date.now();
    await testApp.close({ timeoutMs: 5000, pollIntervalMs: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(100);
    expect(elapsed).toBeLessThan(4500);

    // Verify task completed in DB using app.db (still open)
    const taskRow = await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [payload.taskId]);
    expect(taskRow.rows[0]?.state).toBe('SUCCEEDED');
  });

  test('graceful shutdown force-closes when active lease exceeds timeout', async () => {
    const testApp = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      workerIdentityTokensByBusiness: { [MANIFEST.businessId]: WORKER_IDENTITY_TOKEN },
      adminToken: ADMIN_TOKEN,
      usageToken: USAGE_TOKEN,
      invocationGrantSecret: GRANT_SECRET,
      autoDispatch: false,
      autoMigrate: false,
    });
    const testServer = await testApp.listen();
    const testPort = (testServer.address() as { port: number }).port;
    const testBaseUrl = `http://127.0.0.1:${testPort}`;

    const submit = await http(testBaseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'w38-drain-timeout' } },
    });
    expect(submit.status).toBe(202);
    const opId = submit.body.operationId as string;
    await testApp.dispatcher.dispatchOnce();

    const q = testApp.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === opId);
    expect(job).toBeDefined();
    const payload = job!.data as { taskId: string; deliveryId: string };

    const claim = await http(testBaseUrl, `/api/runtime/v1/tasks/${payload.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: payload.deliveryId, workerInstanceId: 'w38-timeout-worker' },
    });
    expect(claim.status).toBe(200);

    // Active lease remains RUNNING — close() with short 200ms timeout must force-close
    const start = Date.now();
    await testApp.close({ timeoutMs: 200, pollIntervalMs: 50 });
    const elapsed = Date.now() - start;
    expect(elapsed).toBeGreaterThanOrEqual(180);

    // Clean up leftover running task using app.db
    await app.db.query("UPDATE tasks SET state='CANCELLED' WHERE id=$1", [payload.taskId]);
  });
});
});
