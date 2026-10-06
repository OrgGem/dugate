/**
 * CONV-07: W32-C webhook delivery outbox & dispatch — split out of runtime.test.ts.
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
  deliverWebhooks,
  signWebhookBody,
  verifyWebhookSignature,
} from '../src/modules/webhooks/webhooks';
import { createRuntimeFixture, liveDescribe, warnIfSkipped } from './helpers/runtime-harness';

const F = createRuntimeFixture({ suite: 'webhook' });
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

warnIfSkipped('runtime-webhook.test.ts');

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
  beforeAll(async () => {
    ({ app, baseUrl, queueName } = await F.setup());
  }, 120_000);

  afterAll(async () => {
    await F.teardown();
  }, 30_000);

describe('W32-C: webhook delivery outbox & dispatch', () => {
  const CALLBACK_URL = 'https://client.example/hook';

  /** Submit with a callback and return ids + task claim context. */
  async function submitWithCallback(label: string, callbackUrl: string | null = CALLBACK_URL) {
    const body: Record<string, unknown> = { input: { q: label } };
    if (callbackUrl) body.callback = { url: callbackUrl };
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body,
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    const opRes = await app.db.query<{ root_task_id: string; callback_url: string | null }>(
      'SELECT root_task_id, callback_url FROM operations WHERE id=$1',
      [operationId]
    );
    return { operationId, taskId: opRes.rows[0]!.root_task_id, callbackUrl: opRes.rows[0]!.callback_url };
  }

  /** Drive an operation to SUCCEEDED via the runtime API. */
  async function succeedOperation(operationId: string, taskId: string) {
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId)!;
    const deliveryId = (job.data as { deliveryId: string }).deliveryId;
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-webhook-test' },
    });
    expect(claim.status).toBe(200);
    const leaseEpoch = claim.body.leaseEpoch as number;
    const resultRef = `result-${randomUUID()}`;
    const complete = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
    expect(complete.status).toBe(200);
    expect(complete.body.operationState).toBe('SUCCEEDED');
  }

  async function deliveriesFor(operationId: string) {
    const res = await app.db.query<{
      delivery_id: string;
      event_type: string;
      terminal_state: string;
      state_version: number;
      destination_url: string;
      status: string;
      attempts: number;
      payload: { deliveryId: string; eventType: string; operationId: string; state: string; stateVersion: number };
    }>(
      'SELECT delivery_id, event_type, terminal_state, state_version, destination_url, status, attempts, payload FROM webhook_deliveries WHERE operation_id=$1',
      [operationId]
    );
    return res.rows;
  }

  test('callback_url persisted at submit; terminal SUCCEEDED schedules a signed delivery row', async () => {
    const { operationId, taskId, callbackUrl } = await submitWithCallback('wh-succeed');
    expect(callbackUrl).toBe(CALLBACK_URL);
    await succeedOperation(operationId, taskId);
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(1);
    const d = rows[0]!;
    expect(d.event_type).toBe('operation.succeeded');
    expect(d.terminal_state).toBe('SUCCEEDED');
    expect(d.destination_url).toBe(CALLBACK_URL);
    expect(d.status).toBe('PENDING');
    expect(d.attempts).toBe(0);
    // Payload deliveryId matches the durable row id.
    expect(d.payload.deliveryId).toBe(d.delivery_id);
    expect(d.payload.operationId).toBe(operationId);
    expect(d.payload.eventType).toBe('operation.succeeded');
    expect(d.payload.stateVersion).toBe(d.state_version);
  });

  test('no callback_url → no webhook row on terminal transition', async () => {
    const { operationId, taskId, callbackUrl } = await submitWithCallback('wh-none', null);
    expect(callbackUrl).toBeNull();
    await succeedOperation(operationId, taskId);
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(0);
  });

  test('terminal FAILED via failTask schedules a webhook', async () => {
    const { operationId, taskId } = await submitWithCallback('wh-fail');
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId)!;
    const deliveryId = (job.data as { deliveryId: string }).deliveryId;
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId, workerInstanceId: 'worker-webhook-test' },
    });
    const leaseEpoch = claim.body.leaseEpoch as number;
    const fail = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/fail`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, errorCode: 'PERMANENT', retryable: false },
    });
    expect(fail.status).toBe(200);
    expect(fail.body.operationState).toBe('FAILED');
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event_type).toBe('operation.failed');
    expect(rows[0]!.terminal_state).toBe('FAILED');
  });

  test('terminal CANCELLED via cancel schedules a webhook; cancel replay does not duplicate', async () => {
    const { operationId } = await submitWithCallback('wh-cancel');
    const cancel = await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: {},
    });
    expect(cancel.status).toBe(202);
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event_type).toBe('operation.cancelled');
    // Replay: terminal op cancel is a 200 replay, no second delivery row.
    const replay = await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: {},
    });
    expect(replay.status).toBe(200);
    expect((await deliveriesFor(operationId)).length).toBe(1);
  });

  test('terminal TIMED_OUT via deadline sweep schedules a webhook', async () => {
    const { operationId } = await submitWithCallback('wh-timeout');
    await app.db.query(`UPDATE operations SET deadline_at = now() - interval '1 second' WHERE id=$1`, [operationId]);
    const sweep = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(sweep.status).toBe(200);
    expect(sweep.body.timedOut as number).toBeGreaterThanOrEqual(1);
    const rows = await deliveriesFor(operationId);
    expect(rows.length).toBe(1);
    expect(rows[0]!.event_type).toBe('operation.timed-out');
    expect(rows[0]!.terminal_state).toBe('TIMED_OUT');
  });

  test('signature: signWebhookBody/verifyWebhookSignature round-trip and tamper rejection', () => {
    const secret = 'whsec-test';
    const ts = new Date().toISOString();
    const body = JSON.stringify({ a: 1 });
    const sig = signWebhookBody(secret, ts, body);
    expect(sig.startsWith('sha256=')).toBe(true);
    expect(verifyWebhookSignature(secret, ts, body, sig)).toBe(true);
    expect(verifyWebhookSignature(secret, ts, body + 'x', sig)).toBe(false);
    expect(verifyWebhookSignature('other', ts, body, sig)).toBe(false);
    expect(verifyWebhookSignature(secret, ts, body, 'sha256=deadbeef')).toBe(false);
  });

  test('dispatcher: successful delivery marks DELIVERED with correct signed headers', async () => {
    const secret = 'whsec-' + randomUUID();
    const { operationId, taskId } = await submitWithCallback('wh-deliver-ok');
    await succeedOperation(operationId, taskId);
    const myDeliveryId = (await deliveriesFor(operationId))[0]!.delivery_id;
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    // NOTE: the sweep is global by design (shared DB) — earlier tests in this
    // suite left PENDING rows that this sweep legitimately delivers too. We
    // assert on THIS operation's delivery, not the global attempted count.
    const attempted = await deliverWebhooks(app.db, {
      secret,
      allowPrivateNetworks: true,
      fetchFn: async (url, init) => {
        sent.push({ url, headers: init.headers, body: init.body });
        return { status: 200 };
      },
    });
    expect(attempted).toBeGreaterThanOrEqual(1);
    const s = sent.find((x) => x.headers['x-du-delivery-id'] === myDeliveryId);
    expect(s).toBeDefined();
    expect(s!.url).toBe(CALLBACK_URL);
    // Signature verifies against the exact sent body + timestamp.
    expect(
      verifyWebhookSignature(secret, s!.headers['x-du-timestamp']!, s!.body, s!.headers['x-du-signature']!)
    ).toBe(true);
    const rows = await deliveriesFor(operationId);
    expect(rows[0]!.status).toBe('DELIVERED');
    expect(rows[0]!.attempts).toBe(1);
  });

  test('dispatcher: failure retries with backoff then exhausts to FAILED; operation unaffected', async () => {
    const secret = 'whsec-' + randomUUID();
    const { operationId, taskId } = await submitWithCallback('wh-deliver-fail');
    await succeedOperation(operationId, taskId);
    // Shrink the retry budget so the test exhausts quickly.
    await app.db.query('UPDATE webhook_deliveries SET max_attempts=2 WHERE operation_id=$1', [operationId]);
    let calls = 0;
    const failing = async () => {
      calls++;
      return { status: 500 };
    };
    // Attempt 1 → stays PENDING, attempts=1, next_at pushed out.
    await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: failing });
    let row = (await deliveriesFor(operationId))[0]!;
    expect(row.status).toBe('PENDING');
    expect(row.attempts).toBe(1);
    // Force next_at due, attempt 2 → budget exhausted → FAILED.
    await app.db.query('UPDATE webhook_deliveries SET next_at = now() - interval \'1 second\' WHERE operation_id=$1', [operationId]);
    await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: failing });
    row = (await deliveriesFor(operationId))[0]!;
    expect(row.status).toBe('FAILED');
    expect(row.attempts).toBe(2);
    expect(calls).toBe(2);
    // Delivery failure never changed the operation outcome.
    const op = await app.db.query<{ state: string }>('SELECT state FROM operations WHERE id=$1', [operationId]);
    expect(op.rows[0]!.state).toBe('SUCCEEDED');
    // A FAILED row is never re-attempted.
    const again = await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: failing });
    expect(again).toBe(0);
    expect(calls).toBe(2);
  });

  test('dispatcher: idempotent — no due rows means no attempts; delivered rows stay delivered', async () => {
    const secret = 'whsec-' + randomUUID();
    const { operationId, taskId } = await submitWithCallback('wh-idem');
    await succeedOperation(operationId, taskId);
    let calls = 0;
    const ok = async () => {
      calls++;
      return { status: 200 };
    };
    await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: ok });
    expect(calls).toBe(1);
    // Second sweep: the row is DELIVERED (not PENDING), so nothing is re-sent.
    const second = await deliverWebhooks(app.db, { secret, allowPrivateNetworks: true, fetchFn: ok });
    expect(second).toBe(0);
    expect(calls).toBe(1);
    expect((await deliveriesFor(operationId))[0]!.status).toBe('DELIVERED');
  });
});
});
