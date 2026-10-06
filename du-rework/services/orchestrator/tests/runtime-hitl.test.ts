/**
 * CONV-07: W37-C P2-06 composite — children, human wait, deadline, cancel — split out of runtime.test.ts.
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

const F = createRuntimeFixture({ suite: 'hitl' });
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

warnIfSkipped('runtime-hitl.test.ts');

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
  beforeAll(async () => {
    ({ app, baseUrl, queueName } = await F.setup());
  }, 120_000);

  afterAll(async () => {
    await F.teardown();
  }, 30_000);

// ---------------------------------------------------------------------------
// W37-C: P2-06 composite acceptance — Children/join, human wait/resume,
// deadline/cancel (RUN-05/06/07)
// ---------------------------------------------------------------------------

describe('W37-C: P2-06 composite — children, human wait, deadline, cancel', () => {
  const CONT_SCHEMA = {
    type: 'object',
    required: ['answer'],
    properties: { answer: { type: 'string', minLength: 1 } },
    additionalProperties: false,
  };

  /** Submit + dispatch + claim the root task; returns claimed RUNNING root. */
  async function claimRootComposite(label: string, worker: string) {
    const submit = await http(baseUrl, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: label } },
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    await app.dispatcher.dispatchOnce();
    const job = await findJobForOperation(operationId);
    const claim = await http(baseUrl, `/api/runtime/v1/tasks/${job.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: job.deliveryId, workerInstanceId: worker },
    });
    expect(claim.status).toBe(200);
    return { operationId, taskId: job.taskId, leaseEpoch: claim.body.leaseEpoch as number };
  }

  function childSpecsComposite(n: number) {
    return Array.from({ length: n }, (_, i) => {
      const payloadRef = { shard: i, q: 'composite' };
      return {
        taskKey: `shard-${i}`,
        kind: 'root',
        payloadRef,
        payloadHash: contentHash(payloadRef),
      };
    });
  }

  async function spawnComposite(taskId: string, leaseEpoch: number, children: unknown[], continuationRef = 'cont-c') {
    return http(baseUrl, `/api/runtime/v1/tasks/${taskId}/children`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, children, joinPolicy: 'all-success', continuationRef },
    });
  }

  async function completeComposite(taskId: string, leaseEpoch: number, resultRef = 'ref://child-out') {
    return http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
    });
  }

  async function getOpComposite(operationId: string) {
    const got = await http(baseUrl, `/api/v1/operations/${operationId}`, { headers: pubHeaders() });
    expect(got.status).toBe(200);
    return { state: got.body.state as string, stateVersion: got.body.stateVersion as number };
  }

  async function openWaitComposite(taskId: string, leaseEpoch: number, waitKey = 'approval') {
    const wait = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/wait-input`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch, waitKey, inputSchema: CONT_SCHEMA },
    });
    expect(wait.status).toBe(200);
    return wait.body.waitId as string;
  }

  async function resumeOpComposite(operationId: string, waitId: string, answer: unknown, expectedStateVersion: number) {
    return http(baseUrl, `/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId, input: { answer }, expectedStateVersion },
    });
  }

  // --- RUN-05: fan-out children, exactly-once join, no deadlock ---

  test('RUN-05 composite: fan-out → children complete → join closes → parent resumes to terminal SUCCEEDED', async () => {
    const root = await claimRootComposite('w37c-join-full', 'w37c-join-w');
    const spawnRes = await spawnComposite(root.taskId, root.leaseEpoch, childSpecsComposite(2));
    expect(spawnRes.status).toBe(202);
    const childIds = spawnRes.body.childTaskIds as string[];
    expect(childIds).toHaveLength(2);
    expect((await getOpComposite(root.operationId)).state).toBe('WAITING_CHILDREN');

    // Drive children to SUCCEEDED via real claim + complete.
    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const byTask = new Map(jobs.map((j) => [(j.data as { taskId: string }).taskId, j.data as { deliveryId: string }]));
    for (const [idx, childId] of childIds.entries()) {
      const delivery = byTask.get(childId);
      expect(delivery).toBeDefined();
      const claim = await http(baseUrl, `/api/runtime/v1/tasks/${childId}/claim`, {
        method: 'POST',
        headers: rtHeaders(),
        body: { deliveryId: (delivery as { deliveryId: string }).deliveryId, workerInstanceId: `w37c-c-${idx}` },
      });
      expect(claim.status).toBe(200);
      const done = await completeComposite(childId, claim.body.leaseEpoch as number, `ref://w37c-${idx}`);
      expect(done.status).toBe(200);
    }

    // Join closed: parent QUEUED with merged join summary, continuation emitted once.
    const parentRow = await app.db.query<{ state: string; payload_ref: { joinSummary: Record<string, string> } }>(
      'SELECT state, payload_ref FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(parentRow.rows[0]!.state).toBe('QUEUED');
    expect(parentRow.rows[0]!.payload_ref.joinSummary).toMatchObject({
      'shard-0': 'ref://w37c-0',
      'shard-1': 'ref://w37c-1',
    });
    const cont = await app.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox
       WHERE aggregate_id=$1 AND type='task.continuation' AND delivery_id=$2`,
      [root.taskId, `${root.taskId}:join:2`]
    );
    expect(cont.rows[0]!.n).toBe('1');

    // Continuation is re-dispatched to a worker: claim the parent and finish it.
    await app.dispatcher.dispatchOnce();
    const rejob = await findJobForOperation(root.operationId);
    expect(rejob.taskId).toBe(root.taskId);
    const reclaim = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: rejob.deliveryId, workerInstanceId: 'w37c-join-w' },
    });
    expect(reclaim.status).toBe(200);
    const fin = await completeComposite(root.taskId, reclaim.body.leaseEpoch as number, 'ref://w37c-final');
    expect(fin.status).toBe(200);
    expect(fin.body.operationState).toBe('SUCCEEDED');

    // Operation is terminally SUCCEEDED with a result.
    const opFinal = await getOpComposite(root.operationId);
    expect(opFinal.state).toBe('SUCCEEDED');
    const result = await http(baseUrl, `/api/v1/operations/${root.operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(result.status).toBe(200);
    expect((result.body.data as { resultRef?: string }).resultRef).toBe('ref://w37c-final');
  });

  test('RUN-05 composite (concurrency=1): concurrent child completions emit exactly one continuation, no deadlock', async () => {
    const root = await claimRootComposite('w37c-join-conc', 'w37c-conc-w');
    const spawnRes = await spawnComposite(root.taskId, root.leaseEpoch, childSpecsComposite(2));
    expect(spawnRes.status).toBe(202);
    const childIds = spawnRes.body.childTaskIds as string[];

    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const byTask = new Map(jobs.map((j) => [(j.data as { taskId: string }).taskId, j.data as { deliveryId: string }]));
    const epochs: number[] = [];
    for (const [idx, childId] of childIds.entries()) {
      const claim = await http(baseUrl, `/api/runtime/v1/tasks/${childId}/claim`, {
        method: 'POST',
        headers: rtHeaders(),
        body: {
          deliveryId: (byTask.get(childId) as { deliveryId: string }).deliveryId,
          workerInstanceId: `w37c-race-${idx}`,
        },
      });
      expect(claim.status).toBe(200);
      epochs.push(claim.body.leaseEpoch as number);
    }

    // Fire both completions concurrently with Promise.all: parent row FOR
    // UPDATE serializes the two join reconciliations — no deadlock, single
    // continuation. This is the concurrency=1-no-deadlock composite proof.
    const [doneA, doneB] = await Promise.all([
      completeComposite(childIds[0]!, epochs[0]!, 'ref://w37c-race-0'),
      completeComposite(childIds[1]!, epochs[1]!, 'ref://w37c-race-1'),
    ]);
    expect(doneA.status).toBe(200);
    expect(doneB.status).toBe(200);
    const states = [doneA.body.operationState, doneB.body.operationState].sort();
    expect(states).toContain('QUEUED');

    const cont = await app.db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM outbox
       WHERE aggregate_id=$1 AND type='task.continuation' AND delivery_id=$2`,
      [root.taskId, `${root.taskId}:join:2`]
    );
    expect(cont.rows[0]!.n).toBe('1');
  });

  test('RUN-05 composite: one child failure fails the parent join, cancels the sibling, operation FAILED', async () => {
    const root = await claimRootComposite('w37c-join-fail', 'w37c-ff-w');
    const spawnRes = await spawnComposite(root.taskId, root.leaseEpoch, childSpecsComposite(2));
    expect(spawnRes.status).toBe(202);
    const childIds = spawnRes.body.childTaskIds as string[];

    await app.dispatcher.dispatchOnce();
    const q = app.getQueue(queueName) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const byTask = new Map(jobs.map((j) => [(j.data as { taskId: string }).taskId, j.data as { deliveryId: string }]));
    const claim0 = await http(baseUrl, `/api/runtime/v1/tasks/${childIds[0]}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: (byTask.get(childIds[0]!) as { deliveryId: string }).deliveryId, workerInstanceId: 'w37c-ff-w' },
    });
    expect(claim0.status).toBe(200);

    // Child 0 fails permanently → join fails all-success policy.
    const failed = await http(baseUrl, `/api/runtime/v1/tasks/${childIds[0]}/fail`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { leaseEpoch: claim0.body.leaseEpoch, errorCode: 'E_W37C_CHILD', retryable: false },
    });
    expect(failed.status).toBe(200);
    expect(failed.body.operationState).toBe('FAILED');

    const parentRow = await app.db.query<{ state: string; error_code: string }>(
      'SELECT state, error_code FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(parentRow.rows[0]).toMatchObject({ state: 'FAILED', error_code: 'JOIN_FAILED' });
    const siblingRow = await app.db.query<{ state: string }>('SELECT state FROM tasks WHERE id=$1', [childIds[1]]);
    expect(siblingRow.rows[0]!.state).toBe('CANCELLED');

    const op = await getOpComposite(root.operationId);
    expect(op.state).toBe('FAILED');

    // Failed join offers no result: 409.
    const result = await http(baseUrl, `/api/v1/operations/${root.operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(result.status).toBe(409);
  });

  // --- RUN-06: human wait lifecycle ---

  test('RUN-06 composite: wait OPEN → resume ANSWERED → task QUEUED → completion SUCCEEDED', async () => {
    const root = await claimRootComposite('w37c-wait-full', 'w37c-wait-w');
    const waitId = await openWaitComposite(root.taskId, root.leaseEpoch);
    expect(waitId).toMatch(/^wait_/);
    const opWaiting = await getOpComposite(root.operationId);
    expect(opWaiting.state).toBe('WAITING_INPUT');

    // Stale CAS → 409.
    const stale = await resumeOpComposite(root.operationId, waitId, 'yes', opWaiting.stateVersion - 1);
    expect(stale.status).toBe(409);

    // Duplicate resume is a 200 replay (idempotent) — first complete the resume.
    const resume = await resumeOpComposite(root.operationId, waitId, 'yes', opWaiting.stateVersion);
    expect(resume.status).toBe(202);
    expect(resume.body.replayed).toBe(false);

    const opAfter = await getOpComposite(root.operationId);
    expect(opAfter.state).toBe('QUEUED');
    expect(opAfter.stateVersion).toBe(opWaiting.stateVersion + 1);

    // Wait row is now ANSWERED.
    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId]
    );
    expect(waitRow.rows[0]!.status).toBe('ANSWERED');

    // Duplicate resume of the same (answered) wait → 200 replayed.
    const dup = await resumeOpComposite(root.operationId, waitId, 'yes', opAfter.stateVersion);
    expect(dup.status).toBe(200);
    expect(dup.body.replayed).toBe(true);

    // Task was re-queued and is claimable; drive to terminal SUCCEEDED.
    await app.dispatcher.dispatchOnce();
    const rejob = await findJobForOperation(root.operationId);
    expect(rejob.taskId).toBe(root.taskId);
    const reclaim = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: rejob.deliveryId, workerInstanceId: 'w37c-wait-w' },
    });
    expect(reclaim.status).toBe(200);
    const fin = await completeComposite(root.taskId, reclaim.body.leaseEpoch as number, 'ref://w37c-resumed');
    expect(fin.status).toBe(200);
    expect(fin.body.operationState).toBe('SUCCEEDED');
  });

  test('RUN-06 composite: unknown wait → 404; terminal operation resume → 409', async () => {
    const root = await claimRootComposite('w37c-wait-edge', 'w37c-edge-w');
    const waitId = await openWaitComposite(root.taskId, root.leaseEpoch);
    const op = await getOpComposite(root.operationId);

    // Unknown waitId → 404.
    const unknown = await resumeOpComposite(root.operationId, `wait_${randomUUID()}`, 'x', op.stateVersion);
    expect(unknown.status).toBe(404);

    // Complete the wait, then a late resume on the terminal op fails closed.
    const resume = await resumeOpComposite(root.operationId, waitId, 'yes', op.stateVersion);
    expect(resume.status).toBe(202);
    await app.dispatcher.dispatchOnce();
    const rejob = await findJobForOperation(root.operationId);
    const reclaim = await http(baseUrl, `/api/runtime/v1/tasks/${root.taskId}/claim`, {
      method: 'POST',
      headers: rtHeaders(),
      body: { deliveryId: rejob.deliveryId, workerInstanceId: 'w37c-edge-w' },
    });
    expect(reclaim.status).toBe(200);
    const fin = await completeComposite(root.taskId, reclaim.body.leaseEpoch as number, 'ref://w37c-edge');
    expect(fin.status).toBe(200);
    expect(fin.body.operationState).toBe('SUCCEEDED');

    const opFinal = await getOpComposite(root.operationId);
    expect(opFinal.state).toBe('SUCCEEDED');
    // Resume on a terminal operation → 409 (fails closed, no state churn).
    const late = await resumeOpComposite(root.operationId, waitId, 'late', opFinal.stateVersion);
    expect(late.status).toBe(409);
  });

  // --- RUN-07: deadline sweep + cancel close waits, cancel-then-resume fails closed ---

  test('RUN-07 composite: deadline sweep closes OPEN waits to EXPIRED and terminals the operation', async () => {
    const root = await claimRootComposite('w37c-deadline-full', 'w37c-dl-w');
    const waitId = await openWaitComposite(root.taskId, root.leaseEpoch);
    expect((await getOpComposite(root.operationId)).state).toBe('WAITING_INPUT');

    // Force a past deadline and sweep via the admin endpoint.
    await app.db.query(
      "UPDATE operations SET deadline_at = now() - interval '1 minute' WHERE id=$1",
      [root.operationId]
    );
    const sweep = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: adminHeaders(),
    });
    expect(sweep.status).toBe(200);
    expect(sweep.body.timedOut).toBeGreaterThanOrEqual(1);

    // All three closings are proven in one case: wait EXPIRED, task CANCELLED, op TIMED_OUT.
    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId]
    );
    expect(waitRow.rows[0]!.status).toBe('EXPIRED');
    const taskRow = await app.db.query<{ state: string }>(
      'SELECT state FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(taskRow.rows[0]!.state).toBe('CANCELLED');
    const op = await getOpComposite(root.operationId);
    expect(op.state).toBe('TIMED_OUT');

    // Result after TIMED_OUT → 410 (docs 06 expired semantics).
    const result = await http(baseUrl, `/api/v1/operations/${root.operationId}/result`, {
      headers: pubHeaders(),
    });
    expect(result.status).toBe(410);

    // Resume after deadline expiry fails closed 409 (wait is EXPIRED, op terminal).
    const late = await resumeOpComposite(root.operationId, waitId, 'late', op.stateVersion);
    expect(late.status).toBe(409);
  });

  test('RUN-07 composite: cancel closes OPEN waits to CANCELLED and blocks later resume (fail closed)', async () => {
    const root = await claimRootComposite('w37c-cancel-full', 'w37c-cc-w');
    const waitId = await openWaitComposite(root.taskId, root.leaseEpoch);
    expect((await getOpComposite(root.operationId)).state).toBe('WAITING_INPUT');

    const cancel = await http(baseUrl, `/api/v1/operations/${root.operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { reason: 'w37c composite' },
    });
    expect(cancel.status).toBe(202);
    expect(cancel.body.replayed).toBe(false);

    const waitRow = await app.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id=$1',
      [waitId]
    );
    expect(waitRow.rows[0]!.status).toBe('CANCELLED');
    const op = await getOpComposite(root.operationId);
    expect(op.state).toBe('CANCELLED');

    // Task is terminally CANCELLED too.
    const taskRow = await app.db.query<{ state: string }>(
      'SELECT state FROM tasks WHERE id=$1',
      [root.taskId]
    );
    expect(taskRow.rows[0]!.state).toBe('CANCELLED');

    // Cancel-then-resume fails closed: 409, no state churn.
    const late = await resumeOpComposite(root.operationId, waitId, 'late', op.stateVersion);
    expect(late.status).toBe(409);

    // Cancel replay stays idempotent (200 replay).
    const replay = await http(baseUrl, `/api/v1/operations/${root.operationId}/cancel`, {
      method: 'POST',
      headers: pubHeaders(),
      body: {},
    });
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
  });
});
});
