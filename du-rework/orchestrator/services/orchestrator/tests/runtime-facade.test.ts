/**
 * CONV-07: W36-C operations status & result facade — split out of runtime.test.ts.
 *
 * Cases verbatim; own explicit fixture (per-suite namespace: schema, Redis
 * DB, businessId, queue, port 0) via tests/helpers/runtime-harness. Without
 * DU_LIVE_INFRA=1 nothing boots — no createApp, no listen, no connection.
 */
import { randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { createApp, type App } from '../src/server';
import { contentHash } from '@du/contracts';
import {
  isTerminal,
  resultHttpStatus,
  toOperationView,
  waitForTerminal,
} from '../src/modules/operations/facade';
import { createRuntimeFixture, liveDescribe, warnIfSkipped } from './helpers/runtime-harness';

const F = createRuntimeFixture({ suite: 'facade' });
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

warnIfSkipped('runtime-facade.test.ts');

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
  beforeAll(async () => {
    ({ app, baseUrl, queueName } = await F.setup());
  }, 120_000);

  afterAll(async () => {
    await F.teardown();
  }, 30_000);

// ---------------------------------------------------------------------------
// W36-C: P2-08 — Operations Status & Result Facade
// ---------------------------------------------------------------------------

describe('W36-C: operations status & result facade', () => {
  /** Submit a plain operation and return its operation + task IDs. */
  async function submitFacade(label: string) {
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: label } },
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    const opRes = await app.db.query<{ root_task_id: string }>(
      'SELECT root_task_id FROM operations WHERE id=$1',
      [operationId]
    );
    return { operationId, taskId: opRes.rows[0]!.root_task_id };
  }

  /** Drive an operation to SUCCEEDED via runtime API. */
  async function succeedFacade(operationId: string, taskId: string) {
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId)!;
    const deliveryId = (job.data as { deliveryId: string }).deliveryId;
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-facade-test' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    const resultRef = `result-facade-${randomUUID()}`;
    const complete = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
    expect(complete.status).toBe(200);
    expect(complete.body.operationState).toBe('SUCCEEDED');
  }

  // --- Unit tests for facade functions ---

  test('toOperationView: canonical shape includes name, links, progress', () => {
    const now = new Date().toISOString();
    const row = {
      id: 'test-op-1',
      tenant_id: TENANT_ID,
      business_id: 'doc-core',
      business_version: '1.0.0',
      action: 'extract',
      state: 'SUCCEEDED',
      state_version: 3,
      created_at: now,
      updated_at: now,
      deadline_at: null,
      result_ref: 's3://r.json',
    };
    const v = toOperationView(row);
    expect(v.id).toBe('test-op-1');
    expect(v.name).toBe('operations/test-op-1');
    expect(v.state).toBe('SUCCEEDED');
    expect(v.stateVersion).toBe(3);
    expect(v.links.self).toBe('/api/v1/operations/test-op-1');
    expect(v.links.result).toBe('/api/v1/operations/test-op-1/result');
    expect(v.progress).toEqual({ percent: 0, message: 'SUCCEEDED' });
    expect(v.businessId).toBe('doc-core');
    expect(v.businessVersion).toBe('1.0.0');
    expect(v.action).toBe('extract');
  });

  test('isTerminal: SUCCEEDED/FAILED/CANCELLED/TIMED_OUT are terminal', () => {
    expect(isTerminal('SUCCEEDED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('CANCELLED')).toBe(true);
    expect(isTerminal('TIMED_OUT')).toBe(true);
    expect(isTerminal('PENDING')).toBe(false);
    expect(isTerminal('RUNNING')).toBe(false);
    expect(isTerminal('WAITING_INPUT')).toBe(false);
    expect(isTerminal('WAITING_CHILDREN')).toBe(false);
  });

  test('resultHttpStatus: 200 for SUCCEEDED, 410 for TIMED_OUT, 409 for others', () => {
    expect(resultHttpStatus('SUCCEEDED')).toBe(200);
    expect(resultHttpStatus('TIMED_OUT')).toBe(410);
    expect(resultHttpStatus('PENDING')).toBe(409);
    expect(resultHttpStatus('RUNNING')).toBe(409);
    expect(resultHttpStatus('FAILED')).toBe(409);
    expect(resultHttpStatus('CANCELLED')).toBe(409);
  });

  test('waitForTerminal: returns immediately for terminal op', async () => {
    const { operationId, taskId } = await submitFacade('facade-immediate');
    await succeedFacade(operationId, taskId);
    const op = await waitForTerminal(
      (id) => app.runtime.getOperation(id),
      operationId,
      5,
    );
    expect(op.state).toBe('SUCCEEDED');
  });

  // --- Integration tests via HTTP ---

  test('GET /operations/:id: returns canonical OperationView with name, links, progress', async () => {
    const { operationId } = await submitFacade('facade-view-shape');
    const res = await http(baseUrl, `/api/v1/operations/${operationId}`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(operationId);
    expect(res.body.name).toBe(`operations/${operationId}`);
    const links = res.body.links as { self: string; result: string };
    expect(links.self).toBe(`/api/v1/operations/${operationId}`);
    expect(links.result).toBe(`/api/v1/operations/${operationId}/result`);
    const progress = res.body.progress as { percent: number; message: string };
    expect(progress.percent).toBe(0);
    expect(res.body.stateVersion).toBeDefined();
    expect(res.body.businessId).toBe(MANIFEST.businessId);
  });

  test('GET /operations/:id: non-existent returns 404', async () => {
    const fakeId = randomUUID();
    const res = await http(baseUrl, `/api/v1/operations/${fakeId}`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('GET /operations/:id/result: SUCCEEDED returns ResultEnvelope', async () => {
    const { operationId, taskId } = await submitFacade('facade-result-succeed');
    await succeedFacade(operationId, taskId);
    const res = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.body.schemaVersion).toBe('1');
    expect((res.body.usage as { measurement?: string }).measurement).toBe('pending');
    expect(res.body.warnings).toEqual([]);
  });

  test('GET /operations/:id/result: PENDING returns 409 STATE_CONFLICT', async () => {
    const { operationId } = await submitFacade('facade-result-pending');
    const res = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe('STATE_CONFLICT');
  });

  test('GET /operations/:id/result: CANCELLED returns 409 STATE_CONFLICT', async () => {
    const { operationId } = await submitFacade('facade-result-cancel');
    const cancel = await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: {},
    });
    expect(cancel.status).toBe(202);
    const res = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(409);
    expect((res.body as { code?: string }).code).toBe('STATE_CONFLICT');
  });

  test('GET /operations/:id/result: TIMED_OUT returns 410 GONE', async () => {
    const { operationId } = await submitFacade('facade-result-timeout');
    // Set deadline in the past and sweep to transition to TIMED_OUT
    await app.db.query(`UPDATE operations SET deadline_at = now() - interval '1 second' WHERE id=$1`, [operationId]);
    const sweep = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
      body: {},
    });
    expect(sweep.status).toBe(200);
    const res = await http(baseUrl, `/api/v1/operations/${operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(410);
  });

  test('GET /operations/:id/result: non-existent returns 404', async () => {
    const res = await http(baseUrl, `/api/v1/operations/${randomUUID()}/result`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(404);
  });

  test('?wait=0 or absent: returns immediately (no blocking)', async () => {
    const { operationId } = await submitFacade('facade-nowait');
    const res = await http(baseUrl, `/api/v1/operations/${operationId}?wait=0`, {
      headers: pubHeaders(),
    });
    expect(res.status).toBe(200);
    expect(['PENDING', 'ACCEPTED', 'QUEUED', 'RUNNING']).toContain(res.body.state);
  });

  test('?wait=5: long-poll holds until operation reaches SUCCEEDED', async () => {
    const { operationId, taskId } = await submitFacade('facade-wait-succeed');
    // Start the long-poll in the background (holds up to5s)
    const pollPromise = http(baseUrl, `/api/v1/operations/${operationId}?wait=5`, {
      headers: pubHeaders(),
    });
    // Give the poll a moment to connect and enter the first wait cycle
    await new Promise((r) => setTimeout(r, 200));
    // Complete the operation while the poll is waiting
    await succeedFacade(operationId, taskId);
    // The poll should resolve with the terminal state
    const polled = await pollPromise;
    expect(polled.status).toBe(200);
    expect(polled.body.state).toBe('SUCCEEDED');
    expect(polled.body.name).toBe(`operations/${operationId}`);
  });

  test('?wait=1: timeout returns current (non-terminal) state', async () => {
    const { operationId } = await submitFacade('facade-wait-timeout');
    const start = Date.now();
    const res = await http(baseUrl, `/api/v1/operations/${operationId}?wait=1`, {
      headers: pubHeaders(),
    });
    const elapsed = Date.now() - start;
    expect(res.status).toBe(200);
    // State should still be non-terminal (no completion was triggered)
    expect(['PENDING', 'ACCEPTED', 'QUEUED', 'RUNNING']).toContain(res.body.state);
    // Should have waited approximately 1 second (allow some margin)
    expect(elapsed).toBeGreaterThanOrEqual(800);
  });
});
});
