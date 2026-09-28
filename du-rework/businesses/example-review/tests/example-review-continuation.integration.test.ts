import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '@du/orchestrator';
import { exampleReviewManifest, exampleReviewManifestV2 } from '../src/manifest';
import type { WorkerHandle } from '@du/worker-sdk';
import { startExampleReviewWorker } from '../src/worker';
import { assertTestDatabase, assertTestRedis } from './helpers/test-target-guard';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';

describe('P7 Business Extension Live Integration: Example-Review Continuation (RUN-05 / RUN-06)', () => {
  let orchestratorApp: App | undefined;
  let orchestratorUrl: string;
  let workerHandle: WorkerHandle | undefined;

  const adminToken = `adm-${randomUUID()}`;
  const runtimeToken = `rt-${randomUUID()}`;
  const usageToken = `usg-${randomUUID()}`;
  const invocationGrantSecret = 'test-grant-secret-p7-e2e-32bytes-fixed';

  const apiKey = `du_test_${randomUUID().replace(/-/g, '')}`;
  const apiKeyHash = createHash('sha256').update(apiKey).digest('hex');

  const originalFetch = globalThis.fetch;

  beforeAll(async () => {
    // Intercept /artifacts/blob to unquote orchestrator base64 transport in process
    globalThis.fetch = async (input, init) => {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      if (url.includes('/artifacts/blob') && (!init?.method || init.method.toUpperCase() === 'GET')) {
        const resp = await originalFetch(input, init);
        if (resp.ok) {
          const text = await resp.text();
          let unquoted = text;
          try {
            unquoted = JSON.parse(text);
          } catch {
            // keep raw
          }
          if (typeof unquoted === 'string') {
            const rawBase64 = unquoted.replace(/^"+|"+$/g, '').trim();
            const decodedBuffer = Buffer.from(rawBase64, 'base64');
            return new Response(decodedBuffer, {
              status: resp.status,
              headers: {
                ...Object.fromEntries(resp.headers.entries()),
                'content-type': 'application/octet-stream',
              },
            });
          }
        }
      }
      return originalFetch(input, init);
    };

    // 1. Fail-closed target guard verification before connecting
    assertTestDatabase(DATABASE_URL);
    assertTestRedis(REDIS_URL);

    // 2. Start live Orchestrator with continuation migration (0005) and routes
    orchestratorApp = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      adminToken,
      runtimeToken,
      usageToken,
      invocationGrantSecret,
      connectorId: 'mock-connector',
      connectorRevision: 1,
      autoDispatch: true,
    });

    const orchServer = await orchestratorApp.listen();
    const orchAddress = orchServer.address() as AddressInfo;
    orchestratorUrl = `http://127.0.0.1:${orchAddress.port}`;

    // 3. Seed active API key for tenant 00000000-0000-0000-0000-000000000001
    await orchestratorApp.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, '00000000-0000-0000-0000-000000000001', $2, 'test', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), apiKeyHash]
    );

    // Clean up any non-1.0.0 versions from prior runs to ensure test isolation
    await orchestratorApp.db.query(
      "DELETE FROM business_versions WHERE business_id = 'example-review' AND version != '1.0.0'"
    );

    // 4. Start live example-review worker connected to Redis and Orchestrator
    workerHandle = await startExampleReviewWorker({
      runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
      runtimeToken,
      redis: { url: REDIS_URL },
      workerInstanceId: `worker-p7-${randomUUID()}`,
      concurrency: 4,
      heartbeatIntervalMs: 2000,
    });
  }, 35_000);

  afterAll(async () => {
    globalThis.fetch = originalFetch;
    const cleanupErrors: Error[] = [];

    // 1. Stop worker
    if (workerHandle) {
      try {
        await workerHandle.stop(5000);
      } catch (err) {
        cleanupErrors.push(err as Error);
      }
    }

    // 2. Scoped SQL cleanup
    if (orchestratorApp) {
      try {
        await orchestratorApp.db.query(
          "DELETE FROM business_versions WHERE business_id = 'example-review' AND version != '1.0.0'"
        );
        await orchestratorApp.db.query(
          "UPDATE business_versions SET is_active = true WHERE business_id = 'example-review' AND version = '1.0.0'"
        );
      } catch (err) {
        cleanupErrors.push(err as Error);
      }

      try {
        await orchestratorApp.db.query("UPDATE api_keys SET status = 'REVOKED' WHERE hash = $1", [apiKeyHash]);
        await orchestratorApp.db.query(
          'DELETE FROM api_keys WHERE hash = $1 AND id NOT IN (SELECT api_key_id FROM operations WHERE api_key_id IS NOT NULL)',
          [apiKeyHash]
        );
      } catch (err) {
        cleanupErrors.push(err as Error);
      }

      try {
        await orchestratorApp.close();
      } catch (err) {
        cleanupErrors.push(err as Error);
      }
    }

    if (cleanupErrors.length > 0) {
      const summary = cleanupErrors.map((e) => `[Cleanup Error] ${e.message}`).join('\n');
      console.error(`P7 Cleanup completed with failures:\n${summary}`);
      throw new Error(`P7 Cleanup encountered ${cleanupErrors.length} failure(s).`);
    }
  }, 35_000);

  async function pollOperationState(
    operationId: string,
    targetTerminal = true,
    timeoutMs = 25_000
  ): Promise<{ state: string; stateVersion: number }> {
    const deadline = Date.now() + timeoutMs;
    let lastState = 'PENDING';
    let lastVersion = 0;

    while (Date.now() < deadline) {
      const resp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}`, {
        headers: { 'x-api-key': apiKey },
      });
      if (resp.ok) {
        const body = (await resp.json()) as { state: string; stateVersion?: number };
        lastState = body.state;
        lastVersion = body.stateVersion ?? 0;

        if (targetTerminal) {
          if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(lastState)) {
            break;
          }
        } else {
          // Break as soon as it reaches waiting states or terminal
          if (['WAITING_INPUT', 'WAITING_CHILDREN', 'SUCCEEDED', 'FAILED', 'CANCELLED'].includes(lastState)) {
            break;
          }
        }
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 200));
    }
    return { state: lastState, stateVersion: lastVersion };
  }

  async function readResultArtifactEnvelope(
    operationId: string,
    resultRef: string
  ): Promise<Record<string, unknown>> {
    const artifactId = resultRef.replace('artifact://', '');
    const artRow = await orchestratorApp!.db.query<{ task_id: string }>(
      'SELECT task_id FROM artifacts WHERE id = $1',
      [artifactId]
    );
    expect(artRow.rowCount).toBeGreaterThan(0);
    const taskId = artRow.rows[0]!.task_id;

    const taskRows = await orchestratorApp!.db.query<{ id: string; lease_epoch: number }>(
      'SELECT id, lease_epoch FROM tasks WHERE id = $1',
      [taskId]
    );
    expect(taskRows.rowCount).toBeGreaterThan(0);
    const task = taskRows.rows[0]!;

    const accessResp = await fetch(`${orchestratorUrl}/api/runtime/v1/artifacts/${artifactId}/access`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${runtimeToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        taskId: task.id,
        leaseEpoch: task.lease_epoch,
        mode: 'read',
      }),
    });
    expect(accessResp.status).toBe(200);
    const accessGrant = (await accessResp.json()) as { downloadUrl?: string };
    expect(accessGrant.downloadUrl).toBeDefined();

    const dlResp = await fetch(accessGrant.downloadUrl!);
    expect(dlResp.ok).toBe(true);
    const raw = await dlResp.text();

    let unquoted = raw;
    try {
      unquoted = JSON.parse(raw);
    } catch {
      // keep raw
    }
    if (typeof unquoted === 'string') {
      const decoded = Buffer.from(unquoted.replace(/^"+|"+$/g, '').trim(), 'base64').toString('utf8');
      return JSON.parse(decoded);
    }
    return typeof unquoted === 'object' ? (unquoted as Record<string, unknown>) : JSON.parse(raw);
  }

  // ---------------------------------------------------------------------------
  // P7-T1: Registration & Enablement
  // ---------------------------------------------------------------------------
  it('P7-T1. Registers example-review manifest v1.0.0 and enables version via Admin API', async () => {
    // 1. Register version
    const regResp = await fetch(
      `${orchestratorUrl}/api/runtime/v1/businesses/${exampleReviewManifest.businessId}/versions/${exampleReviewManifest.version}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(exampleReviewManifest),
      }
    );
    expect([200, 201]).toContain(regResp.status);

    // 2. Enable version
    const enableResp = await fetch(
      `${orchestratorUrl}/api/v1/admin/businesses/${exampleReviewManifest.businessId}/versions/${exampleReviewManifest.version}/enable`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
      }
    );
    expect(enableResp.status).toBe(200);

    // 3. Activate version (W28-C / W30-A)
    const activateResp = await fetch(
      `${orchestratorUrl}/api/v1/admin/businesses/${exampleReviewManifest.businessId}/versions/${exampleReviewManifest.version}/activate`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
      }
    );
    expect([200, 202]).toContain(activateResp.status);

    // 4. Invariant check in PostgreSQL
    const bvRes = await orchestratorApp!.db.query<{ status: string; is_active: boolean }>(
      'SELECT status, is_active FROM business_versions WHERE business_id = $1 AND version = $2',
      [exampleReviewManifest.businessId, exampleReviewManifest.version]
    );
    expect(bvRes.rows[0]?.status).toBe('ENABLED');
    expect(bvRes.rows[0]?.is_active).toBe(true);
  });

  // ---------------------------------------------------------------------------
  // P7-T2: Single Document Fast-Path Inline Execution
  // ---------------------------------------------------------------------------
  it('P7-T2. Processes single-document review inline with durable checkpoints and no child tasks (RUN-04)', async () => {
    const reviewId = `rev-fast-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          input: {
            reviewId,
            artifacts: [{ artifactId: randomUUID(), fileName: 'single.pdf' }],
            checks: { 'policy-check': true },
            requireApproval: false,
          },
        }),
      }
    );
    expect(submitResp.status).toBe(202);
    const { operationId } = (await submitResp.json()) as { operationId: string };

    // Wait for execution to complete
    const { state } = await pollOperationState(operationId);
    expect(state).toBe('SUCCEEDED');

    // Invariant: zero child tasks spawned
    const tasksRes = await orchestratorApp!.db.query<{ count: string }>(
      'SELECT count(*) as count FROM tasks WHERE operation_id = $1',
      [operationId]
    );
    expect(Number(tasksRes.rows[0]?.count)).toBe(1); // root task only

    // Invariant: step checkpoint evaluate-items recorded
    const cpRes = await orchestratorApp!.db.query<{ status: string }>(
      'SELECT status FROM step_checkpoints WHERE step_key = $1',
      [`evaluate-items:${reviewId}`]
    );
    expect(cpRes.rows[0]?.status).toBe('SUCCEEDED');

    // Read result artifact
    const resResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resResp.status).toBe(200);
    const resBody = (await resResp.json()) as { data: { resultRef?: string } };
    expect(resBody.data.resultRef).toMatch(/^artifact:\/\//);

    const envelope = await readResultArtifactEnvelope(operationId, resBody.data.resultRef!);
    expect(envelope.reviewId).toBe(reviewId);
    expect(envelope.itemCount).toBe(1);
    expect(envelope.approved).toBe(true);
    expect(envelope.reviewsRef).toMatch(/^artifact:\/\//);
  }, 25_000);

  // ---------------------------------------------------------------------------
  // P7-T3 / P7-T4 / P7-T5: Multi-Document Fanout, Join, and Parent Continuation
  // ---------------------------------------------------------------------------
  it('P7-T3..T5. Spawns child tasks, joins all-success, and continues parent to SUCCEEDED (RUN-05)', async () => {
    const reviewId = `rev-fanout-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          input: {
            reviewId,
            artifacts: [
              { artifactId: randomUUID(), fileName: 'file1.pdf' },
              { artifactId: randomUUID(), fileName: 'file2.pdf' },
            ],
            checks: { 'security-baseline': true },
            requireApproval: false,
          },
        }),
      }
    );
    expect(submitResp.status).toBe(202);
    const { operationId } = (await submitResp.json()) as { operationId: string };

    // Poll until final completion
    const { state } = await pollOperationState(operationId);
    expect(state).toBe('SUCCEEDED');

    // Invariant: 1 root task + 2 child tasks
    const tasksRes = await orchestratorApp!.db.query<{ id: string; kind: string; state: string; parent_id: string | null }>(
      'SELECT id, kind, state, parent_id FROM tasks WHERE operation_id = $1 ORDER BY created_at ASC',
      [operationId]
    );
    expect(tasksRes.rows.length).toBe(3);

    const rootTask = tasksRes.rows[0]!;
    expect(rootTask.kind).toBe('root');
    expect(rootTask.state).toBe('SUCCEEDED');
    expect(rootTask.parent_id).toBeNull();

    const childTasks = tasksRes.rows.slice(1);
    expect(childTasks).toHaveLength(2);
    for (const child of childTasks) {
      expect(child.kind).toBe('review-item');
      expect(child.state).toBe('SUCCEEDED');
      expect(child.parent_id).toBe(rootTask.id);
    }

    // Invariant: task_dependencies has 2 rows
    const depsRes = await orchestratorApp!.db.query<{ count: string }>(
      'SELECT count(*) as count FROM task_dependencies WHERE parent_id = $1',
      [rootTask.id]
    );
    expect(Number(depsRes.rows[0]?.count)).toBe(2);

    // Invariant: outbox recorded exactly one parent task.continuation row
    const contRes = await orchestratorApp!.db.query<{ count: string }>(
      "SELECT count(*) as count FROM outbox WHERE aggregate_id = $1 AND type = 'task.continuation'",
      [rootTask.id]
    );
    expect(Number(contRes.rows[0]?.count)).toBe(1);

    // Read result artifact
    const resResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resResp.status).toBe(200);
    const resBody = (await resResp.json()) as { data: { resultRef?: string } };
    expect(resBody.data.resultRef).toMatch(/^artifact:\/\//);

    const envelope = await readResultArtifactEnvelope(operationId, resBody.data.resultRef!);
    expect(envelope.reviewId).toBe(reviewId);
    expect(envelope.itemCount).toBe(2);
    expect(envelope.approved).toBe(true);
    expect((envelope.items as unknown[])).toHaveLength(2);
  }, 25_000);

  // ---------------------------------------------------------------------------
  // P7-T6 / P7-T7: Human Wait Yield & Resumption
  // ---------------------------------------------------------------------------
  it('P7-T6..T7. Enters WAITING_INPUT, yields slot, and resumes to SUCCEEDED on tenant input (RUN-06)', async () => {
    const reviewId = `rev-hitl-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          input: {
            reviewId,
            artifacts: [{ artifactId: randomUUID(), fileName: 'audit.pdf' }],
            checks: { 'compliance-check': true },
            requireApproval: true,
          },
        }),
      }
    );
    expect(submitResp.status).toBe(202);
    const { operationId } = (await submitResp.json()) as { operationId: string };

    // Wait until it enters WAITING_INPUT (yields slot)
    const midState = await pollOperationState(operationId, false, 15_000);
    expect(midState.state).toBe('WAITING_INPUT');

    // Invariant: human_waits has row with status 'OPEN'
    const waitRes = await orchestratorApp!.db.query<{ wait_id: string; status: string; task_id: string }>(
      'SELECT wait_id, status, task_id FROM human_waits WHERE operation_id = $1',
      [operationId]
    );
    expect(waitRes.rows.length).toBe(1);
    expect(waitRes.rows[0]?.status).toBe('OPEN');
    const waitId = waitRes.rows[0]!.wait_id;
    expect(waitId).toMatch(/^wait_/);

    // Call tenant resume with valid input and current stateVersion
    const resumeResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        waitId,
        input: {
          approved: true,
          note: 'Approved by Lead Compliance Officer',
          approver: 'lead-compliance',
        },
        expectedStateVersion: midState.stateVersion,
      }),
    });
    expect(resumeResp.status).toBe(202);
    const resumeBody = (await resumeResp.json()) as { replayed: boolean; stateVersion: number; taskId: string };
    expect(resumeBody.replayed).toBe(false);
    expect(resumeBody.stateVersion).toBe(midState.stateVersion + 1);

    // Duplicate resume call: same waitId and same input -> returns 200 with replayed: true (RUN-06 / P7-05)
    const dupResumeResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        waitId,
        input: {
          approved: true,
          note: 'Approved by Lead Compliance Officer',
          approver: 'lead-compliance',
        },
        expectedStateVersion: resumeBody.stateVersion,
      }),
    });
    expect(dupResumeResp.status).toBe(200);
    const dupBody = (await dupResumeResp.json()) as { replayed: boolean; stateVersion: number; taskId: string };
    expect(dupBody.replayed).toBe(true);
    expect(dupBody.taskId).toBe(resumeBody.taskId);
    expect(dupBody.stateVersion).toBe(resumeBody.stateVersion);

    // Invariant: human_waits transitioned to 'ANSWERED'
    const waitAfter = await orchestratorApp!.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id = $1',
      [waitId]
    );
    expect(waitAfter.rows[0]?.status).toBe('ANSWERED');

    // Invariant: exactly one task.dispatch outbox row exists for this resume delivery (zero duplicate dispatch)
    const outboxRes = await orchestratorApp!.db.query<{ count: string }>(
      `SELECT count(*) as count FROM outbox WHERE aggregate_id = $1 AND delivery_id = $2`,
      [resumeBody.taskId, `${resumeBody.taskId}:resume:${resumeBody.stateVersion}`]
    );
    expect(Number(outboxRes.rows[0]?.count)).toBe(1);

    // Wait for resumed task to complete to terminal SUCCEEDED
    const finalState = await pollOperationState(operationId, true, 20_000);
    expect(finalState.state).toBe('SUCCEEDED');

    // Read result artifact
    const resResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resResp.status).toBe(200);
    const resBody = (await resResp.json()) as { data: { resultRef?: string } };
    expect(resBody.data.resultRef).toMatch(/^artifact:\/\//);

    const envelope = await readResultArtifactEnvelope(operationId, resBody.data.resultRef!);
    expect(envelope.reviewId).toBe(reviewId);
    expect(envelope.approved).toBe(true);
    expect(envelope.approval).toMatchObject({
      approved: true,
      note: 'Approved by Lead Compliance Officer',
      approver: 'lead-compliance',
    });
  }, 25_000);

  // ---------------------------------------------------------------------------
  // P7-T8: CAS Conflict & Schema Validation Rejections on Resume
  // ---------------------------------------------------------------------------
  it('P7-T8. Rejects resume with 409 on stale CAS and 422 on invalid schema; wait remains OPEN (RUN-06)', async () => {
    const reviewId = `rev-cas-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          input: {
            reviewId,
            artifacts: [{ artifactId: randomUUID() }],
            requireApproval: true,
          },
        }),
      }
    );
    const { operationId } = (await submitResp.json()) as { operationId: string };

    // Wait until WAITING_INPUT
    const midState = await pollOperationState(operationId, false, 15_000);
    expect(midState.state).toBe('WAITING_INPUT');

    const waitRes = await orchestratorApp!.db.query<{ wait_id: string }>(
      'SELECT wait_id FROM human_waits WHERE operation_id = $1',
      [operationId]
    );
    const waitId = waitRes.rows[0]!.wait_id;

    // 1. Stale CAS version -> 409 STATE_CONFLICT
    const staleCasResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        waitId,
        input: { approved: true },
        expectedStateVersion: midState.stateVersion - 1, // Stale!
      }),
    });
    expect(staleCasResp.status).toBe(409);
    const staleProblem = (await staleCasResp.json()) as { code: string };
    expect(staleProblem.code).toBe('STATE_CONFLICT');

    // 2. Invalid schema (approved is not boolean) -> 422 INVALID_SCHEMA
    const badSchemaResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        waitId,
        input: { approved: 'not_a_boolean' },
        expectedStateVersion: midState.stateVersion,
      }),
    });
    expect(badSchemaResp.status).toBe(422);
    const badProblem = (await badSchemaResp.json()) as { code: string };
    expect(badProblem.code).toBe('INVALID_SCHEMA');

    // Invariant: human_waits row remains 'OPEN' and operation remains 'WAITING_INPUT'
    const waitStillOpen = await orchestratorApp!.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id = $1',
      [waitId]
    );
    expect(waitStillOpen.rows[0]?.status).toBe('OPEN');

    const opStillWaiting = await orchestratorApp!.db.query<{ state: string }>(
      'SELECT state FROM operations WHERE id = $1',
      [operationId]
    );
    expect(opStillWaiting.rows[0]?.state).toBe('WAITING_INPUT');
  }, 25_000);

  // ---------------------------------------------------------------------------
  // P7-T9: Operation Cancellation & Fail-Closed Semantics
  // ---------------------------------------------------------------------------
  it('P7-T9. Cancels operation in WAITING_INPUT; subsequent resume fails closed with 409 (P2-06)', async () => {
    const reviewId = `rev-cancel-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          input: {
            reviewId,
            artifacts: [{ artifactId: randomUUID() }],
            requireApproval: true,
          },
        }),
      }
    );
    const { operationId } = (await submitResp.json()) as { operationId: string };

    // Wait until WAITING_INPUT
    const midState = await pollOperationState(operationId, false, 15_000);
    expect(midState.state).toBe('WAITING_INPUT');

    const waitRes = await orchestratorApp!.db.query<{ wait_id: string }>(
      'SELECT wait_id FROM human_waits WHERE operation_id = $1',
      [operationId]
    );
    const waitId = waitRes.rows[0]!.wait_id;

    // Public cancel
    const cancelResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({}),
    });
    expect(cancelResp.status).toBe(202);

    // Invariants: operation and task marked CANCELLED
    const opRow = await orchestratorApp!.db.query<{ state: string; cancel_requested: boolean }>(
      'SELECT state, cancel_requested FROM operations WHERE id = $1',
      [operationId]
    );
    expect(opRow.rows[0]?.state).toBe('CANCELLED');
    expect(opRow.rows[0]?.cancel_requested).toBe(true);

    const taskRow = await orchestratorApp!.db.query<{ state: string }>(
      'SELECT state FROM tasks WHERE operation_id = $1',
      [operationId]
    );
    expect(taskRow.rows[0]?.state).toBe('CANCELLED');

    // Subsequent resume attempt fails closed with 409 STATE_CONFLICT
    const postCancelResume = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        waitId,
        input: { approved: true },
        expectedStateVersion: midState.stateVersion + 1,
      }),
    });
    expect(postCancelResume.status).toBe(409);
    const problem = (await postCancelResume.json()) as { code: string };
    expect(problem.code).toBe('STATE_CONFLICT');

    // W27-C authoritative contract: terminal operation transactionally closes OPEN human waits to CANCELLED.
    const waitRow = await orchestratorApp!.db.query<{ status: string }>(
      'SELECT status FROM human_waits WHERE wait_id = $1',
      [waitId]
    );
    expect(waitRow.rows[0]?.status).toBe('CANCELLED');
  }, 25_000);

  // ---------------------------------------------------------------------------
  // P7-05 Missing Proof 1: concurrency=1 fanout/join progress without deadlock
  // ---------------------------------------------------------------------------
  it('P7-05 (concurrency=1). Multi-document fanout and all-success join progresses to SUCCEEDED under concurrency=1 without worker deadlock (RUN-05)', async () => {
    // 1. Temporarily stop the 4-concurrency worker
    if (workerHandle) {
      await workerHandle.stop(5000);
      workerHandle = undefined;
    }

    // 2. Start a dedicated single-slot worker (concurrency = 1)
    const singleWorker = await startExampleReviewWorker({
      runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
      runtimeToken,
      redis: { url: REDIS_URL },
      workerInstanceId: `worker-p7-c1-${randomUUID()}`,
      concurrency: 1,
      heartbeatIntervalMs: 2000,
    });

    try {
      const reviewId = `rev-c1-${randomUUID()}`;
      const submitResp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            input: {
              reviewId,
              artifacts: [
                { artifactId: randomUUID(), fileName: 'c1-doc1.pdf' },
                { artifactId: randomUUID(), fileName: 'c1-doc2.pdf' },
              ],
              checks: { 'policy-check': true },
              requireApproval: false,
            },
          }),
        }
      );
      expect(submitResp.status).toBe(202);
      const { operationId } = (await submitResp.json()) as { operationId: string };

      // Poll until final completion.
      // Under concurrency=1, if parent did not yield slot on spawnAndWait, the single worker slot
      // would remain occupied and child tasks could never be claimed -> immediate deadlock!
      const { state } = await pollOperationState(operationId, true, 30_000);
      expect(state).toBe('SUCCEEDED');

      // Invariants: 1 root task + 2 child tasks, all SUCCEEDED
      const tasksRes = await orchestratorApp!.db.query<{ kind: string; state: string }>(
        'SELECT kind, state FROM tasks WHERE operation_id = $1 ORDER BY created_at ASC',
        [operationId]
      );
      expect(tasksRes.rows).toHaveLength(3);
      for (const t of tasksRes.rows) {
        expect(t.state).toBe('SUCCEEDED');
      }

      // Read result artifact
      const resResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
        headers: { 'x-api-key': apiKey },
      });
      expect(resResp.status).toBe(200);
      const resBody = (await resResp.json()) as { data: { resultRef?: string } };
      expect(resBody.data.resultRef).toMatch(/^artifact:\/\//);

      const envelope = await readResultArtifactEnvelope(operationId, resBody.data.resultRef!);
      expect(envelope.reviewId).toBe(reviewId);
      expect(envelope.itemCount).toBe(2);
      expect(envelope.approved).toBe(true);
    } finally {
      // 3. Stop single-slot worker and restart standard worker for subsequent tests
      await singleWorker.stop(5000);
      workerHandle = await startExampleReviewWorker({
        runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
        runtimeToken,
        redis: { url: REDIS_URL },
        workerInstanceId: `worker-p7-${randomUUID()}`,
        concurrency: 4,
        heartbeatIntervalMs: 2000,
      });
    }
  }, 40_000);

  // ---------------------------------------------------------------------------
  // P7-05 Missing Proof 2: Worker restart while parent is waiting and resumption
  // ---------------------------------------------------------------------------
  it('P7-05 (worker-restart). Recovers and completes continuation when worker is restarted while operation is in WAITING_INPUT (RUN-06)', async () => {
    const reviewId = `rev-restart-${randomUUID()}`;
    const submitResp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          input: {
            reviewId,
            artifacts: [{ artifactId: randomUUID(), fileName: 'restart-doc.pdf' }],
            checks: { 'compliance-check': true },
            requireApproval: true,
          },
        }),
      }
    );
    expect(submitResp.status).toBe(202);
    const { operationId } = (await submitResp.json()) as { operationId: string };

    // 1. Wait until operation enters WAITING_INPUT (slot is released)
    const midState = await pollOperationState(operationId, false, 15_000);
    expect(midState.state).toBe('WAITING_INPUT');

    const waitRes = await orchestratorApp!.db.query<{ wait_id: string; status: string }>(
      'SELECT wait_id, status FROM human_waits WHERE operation_id = $1',
      [operationId]
    );
    expect(waitRes.rows.length).toBe(1);
    expect(waitRes.rows[0]?.status).toBe('OPEN');
    const waitId = waitRes.rows[0]!.wait_id;

    // 2. STOP the worker while parent is waiting (simulates worker process termination / restart)
    if (workerHandle) {
      await workerHandle.stop(5000);
      workerHandle = undefined;
    }

    // 3. While worker is completely down, tenant submits resumption input
    const resumeResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/resume`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
      },
      body: JSON.stringify({
        waitId,
        input: {
          approved: true,
          note: 'Approved during worker offline window',
          approver: 'offline-compliance-auditor',
        },
        expectedStateVersion: midState.stateVersion,
      }),
    });
    expect(resumeResp.status).toBe(202);

    // Verify task state in database is QUEUED waiting for a worker to claim it
    const taskQueued = await orchestratorApp!.db.query<{ state: string }>(
      'SELECT state FROM tasks WHERE operation_id = $1',
      [operationId]
    );
    expect(taskQueued.rows[0]?.state).toBe('QUEUED');

    // Expire stale lease from the terminated worker so replacement worker can claim immediately
    await orchestratorApp!.db.query(
      "UPDATE tasks SET lease_expires_at = now() - interval '1 second' WHERE operation_id = $1",
      [operationId]
    );

    // 4. Start a brand new replacement worker instance
    workerHandle = await startExampleReviewWorker({
      runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
      runtimeToken,
      redis: { url: REDIS_URL },
      workerInstanceId: `worker-p7-replacement-${randomUUID()}`,
      concurrency: 4,
      heartbeatIntervalMs: 2000,
    });

    // 5. Replacement worker claims the queued resumed task and completes it to SUCCEEDED
    const finalState = await pollOperationState(operationId, true, 20_000);
    expect(finalState.state).toBe('SUCCEEDED');

    // 6. Verify result artifact contains approval note
    const resResp = await fetch(`${orchestratorUrl}/api/v1/operations/${operationId}/result`, {
      headers: { 'x-api-key': apiKey },
    });
    expect(resResp.status).toBe(200);
    const resBody = (await resResp.json()) as { data: { resultRef?: string } };
    expect(resBody.data.resultRef).toMatch(/^artifact:\/\//);

    const envelope = await readResultArtifactEnvelope(operationId, resBody.data.resultRef!);
    expect(envelope.reviewId).toBe(reviewId);
    expect(envelope.approved).toBe(true);
    expect(envelope.approval).toMatchObject({
      approved: true,
      note: 'Approved during worker offline window',
      approver: 'offline-compliance-auditor',
    });
  }, 40_000);

  // ---------------------------------------------------------------------------
  // P7-06 Proof 1: Version Coexistence and Pinned In-Flight Continuation (VER-01)
  // ---------------------------------------------------------------------------
  it('P7-06 (version-coexistence). Runs v1 and v2 concurrently, routes new submissions to v2, and resumes in-flight v1 on pinned worker (VER-01)', async () => {
    // 1. Submit an in-flight operation under v1 requiring approval
    const reviewIdV1 = `rev-v1-${randomUUID()}`;
    const submitV1Resp = await fetch(
      `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
      {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          input: {
            reviewId: reviewIdV1,
            artifacts: [{ artifactId: randomUUID(), fileName: 'v1-doc.pdf' }],
            checks: { 'compliance-check': true },
            requireApproval: true,
          },
        }),
      }
    );
    expect(submitV1Resp.status).toBe(202);
    const { operationId: op1Id } = (await submitV1Resp.json()) as { operationId: string };

    // Wait until Op1 enters WAITING_INPUT
    const midState1 = await pollOperationState(op1Id, false, 15_000);
    expect(midState1.state).toBe('WAITING_INPUT');

    // Invariant: Op1 is pinned to v1.0.0
    const op1Row = await orchestratorApp!.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id = $1',
      [op1Id]
    );
    expect(op1Row.rows[0]?.business_version).toBe('1.0.0');

    const waitRes1 = await orchestratorApp!.db.query<{ wait_id: string; status: string }>(
      'SELECT wait_id, status FROM human_waits WHERE operation_id = $1',
      [op1Id]
    );
    expect(waitRes1.rows.length).toBe(1);
    expect(waitRes1.rows[0]?.status).toBe('OPEN');
    const waitId1 = waitRes1.rows[0]!.wait_id;

    // 2. Register version 2.0.0 via Runtime API
    const regV2Resp = await fetch(
      `${orchestratorUrl}/api/runtime/v1/businesses/${exampleReviewManifestV2.businessId}/versions/${exampleReviewManifestV2.version}`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${runtimeToken}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(exampleReviewManifestV2),
      }
    );
    expect([200, 201]).toContain(regV2Resp.status);

    // 3. Enable version 2.0.0 via Admin API
    const enableV2Resp = await fetch(
      `${orchestratorUrl}/api/v1/admin/businesses/${exampleReviewManifestV2.businessId}/versions/${exampleReviewManifestV2.version}/enable`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
      }
    );
    expect(enableV2Resp.status).toBe(200);

    // 3b. Activate version 2.0.0 via Admin API (W28-C / W30-A)
    const activateV2Resp = await fetch(
      `${orchestratorUrl}/api/v1/admin/businesses/${exampleReviewManifestV2.businessId}/versions/${exampleReviewManifestV2.version}/activate`,
      {
        method: 'PUT',
        headers: {
          authorization: `Bearer ${adminToken}`,
          'content-type': 'application/json',
        },
      }
    );
    expect([200, 202]).toContain(activateV2Resp.status);

    const bvResV2 = await orchestratorApp!.db.query<{ status: string; is_active: boolean }>(
      'SELECT status, is_active FROM business_versions WHERE business_id = $1 AND version = $2',
      [exampleReviewManifestV2.businessId, exampleReviewManifestV2.version]
    );
    expect(bvResV2.rows[0]?.status).toBe('ENABLED');
    expect(bvResV2.rows[0]?.is_active).toBe(true);

    const bvResV1 = await orchestratorApp!.db.query<{ status: string; is_active: boolean }>(
      'SELECT status, is_active FROM business_versions WHERE business_id = $1 AND version = $2',
      [exampleReviewManifest.businessId, exampleReviewManifest.version]
    );
    expect(bvResV1.rows[0]?.is_active).toBe(false);

    // 4. Start concurrent Worker for v2.0.0
    // Worker 1 (v1.0.0) is already running and connected to queue `du-business-example-review-1.0.0`
    // Worker 2 (v2.0.0) connects to queue `du-business-example-review-2.0.0`
    const workerHandleV2 = await startExampleReviewWorker({
      runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
      runtimeToken,
      redis: { url: REDIS_URL },
      workerInstanceId: `worker-p7-v2-${randomUUID()}`,
      concurrency: 4,
      heartbeatIntervalMs: 2000,
      manifest: exampleReviewManifestV2,
    });

    try {
      // 5. Submit new operation Op2 — must route to the newly enabled v2.0.0!
      const reviewIdV2 = `rev-v2-${randomUUID()}`;
      const submitV2Resp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            input: {
              reviewId: reviewIdV2,
              artifacts: [{ artifactId: randomUUID(), fileName: 'v2-doc.pdf' }],
              checks: { 'compliance-check': true },
              requireApproval: false,
            },
          }),
        }
      );
      expect(submitV2Resp.status).toBe(202);
      const { operationId: op2Id } = (await submitV2Resp.json()) as { operationId: string };

      // Invariant: Op2 is submitted to business_version = '2.0.0'
      const op2Row = await orchestratorApp!.db.query<{ business_version: string }>(
        'SELECT business_version FROM operations WHERE id = $1',
        [op2Id]
      );
      expect(op2Row.rows[0]?.business_version).toBe('2.0.0');

      // Op2 completes on Worker 2
      const op2Final = await pollOperationState(op2Id, true, 20_000);
      expect(op2Final.state).toBe('SUCCEEDED');

      // Verify Op2 result artifact envelope carries observable version 2.0.0 markers
      const resV2Resp = await fetch(`${orchestratorUrl}/api/v1/operations/${op2Id}/result`, {
        headers: { 'x-api-key': apiKey },
      });
      expect(resV2Resp.status).toBe(200);
      const resV2Body = (await resV2Resp.json()) as { data: { resultRef?: string } };
      expect(resV2Body.data.resultRef).toMatch(/^artifact:\/\//);

      const envelopeV2 = await readResultArtifactEnvelope(op2Id, resV2Body.data.resultRef!);
      expect(envelopeV2.reviewId).toBe(reviewIdV2);
      expect(envelopeV2.approved).toBe(true);
      expect(envelopeV2.version).toBe('2.0.0');
      expect(typeof envelopeV2.summary).toBe('string');
      expect((envelopeV2.summary as string).startsWith('[2.0.0]')).toBe(true);

      // 6. Resume in-flight Op1 (which was submitted to v1.0.0 before v2 was enabled)
      const resumeV1Resp = await fetch(`${orchestratorUrl}/api/v1/operations/${op1Id}/resume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          waitId: waitId1,
          input: {
            approved: true,
            note: 'Approved under in-flight continuation',
            approver: 'v1-approver',
          },
          expectedStateVersion: midState1.stateVersion,
        }),
      });
      expect(resumeV1Resp.status).toBe(202);

      // Op1 must be claimed and processed by Worker 1 (queue `du-business-example-review-1.0.0`)
      const op1Final = await pollOperationState(op1Id, true, 20_000);
      expect(op1Final.state).toBe('SUCCEEDED');

      // Verify Op1 result artifact envelope carries observable version 1.0.0 markers
      const resV1Resp = await fetch(`${orchestratorUrl}/api/v1/operations/${op1Id}/result`, {
        headers: { 'x-api-key': apiKey },
      });
      expect(resV1Resp.status).toBe(200);
      const resV1Body = (await resV1Resp.json()) as { data: { resultRef?: string } };
      expect(resV1Body.data.resultRef).toMatch(/^artifact:\/\//);

      const envelopeV1 = await readResultArtifactEnvelope(op1Id, resV1Body.data.resultRef!);
      expect(envelopeV1.reviewId).toBe(reviewIdV1);
      expect(envelopeV1.approved).toBe(true);
      expect(envelopeV1.version).toBe('1.0.0');
      expect(typeof envelopeV1.summary).toBe('string');
      expect((envelopeV1.summary as string).startsWith('[1.0.0]')).toBe(true);
      expect(envelopeV1.approval).toMatchObject({
        approved: true,
        note: 'Approved under in-flight continuation',
        approver: 'v1-approver',
      });
    } finally {
      await workerHandleV2.stop(5000);
    }
  }, 45_000);

  // ---------------------------------------------------------------------------
  // P7-06 Proof 2: Active-Version Drain, Fail-Closed 404, Rollback, and Pinned Continuation (VER-01)
  // ---------------------------------------------------------------------------
  it('P7-06 (drain-rollback). Proves version drain fail-closed 404, explicit rollback activation to v1.0.0, and continued pinned execution for in-flight v2 work (VER-01)', async () => {
    // 1. Start Worker for v2.0.0 alongside existing Worker 1 (v1.0.0)
    const workerHandleV2 = await startExampleReviewWorker({
      runtimeUrl: `${orchestratorUrl}/api/runtime/v1`,
      runtimeToken,
      redis: { url: REDIS_URL },
      workerInstanceId: `worker-p7-v2-case10-${randomUUID()}`,
      concurrency: 4,
      heartbeatIntervalMs: 2000,
      manifest: exampleReviewManifestV2,
    });

    try {
      // 2. Ensure v2.0.0 is explicitly active for new submissions
      const activateV2Resp = await fetch(
        `${orchestratorUrl}/api/v1/admin/businesses/${exampleReviewManifestV2.businessId}/versions/${exampleReviewManifestV2.version}/activate`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${adminToken}`,
            'content-type': 'application/json',
          },
        }
      );
      expect([200, 202]).toContain(activateV2Resp.status);

      // 3. Submit an in-flight operation under v2 requiring approval (OpV2Inflight)
      const reviewIdV2Inflight = `rev-v2-inflight-${randomUUID()}`;
      const submitV2Resp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            input: {
              reviewId: reviewIdV2Inflight,
              artifacts: [{ artifactId: randomUUID(), fileName: 'v2-inflight.pdf' }],
              checks: { 'compliance-check': true },
              requireApproval: true,
            },
          }),
        }
      );
      expect(submitV2Resp.status).toBe(202);
      const { operationId: opV2InflightId } = (await submitV2Resp.json()) as { operationId: string };

      // Wait until OpV2Inflight enters WAITING_INPUT
      const midStateV2 = await pollOperationState(opV2InflightId, false, 15_000);
      expect(midStateV2.state).toBe('WAITING_INPUT');

      const opV2Row = await orchestratorApp!.db.query<{ business_version: string }>(
        'SELECT business_version FROM operations WHERE id = $1',
        [opV2InflightId]
      );
      expect(opV2Row.rows[0]?.business_version).toBe('2.0.0');

      const waitResV2 = await orchestratorApp!.db.query<{ wait_id: string; status: string }>(
        'SELECT wait_id, status FROM human_waits WHERE operation_id = $1',
        [opV2InflightId]
      );
      expect(waitResV2.rows.length).toBe(1);
      expect(waitResV2.rows[0]?.status).toBe('OPEN');
      const waitIdV2 = waitResV2.rows[0]!.wait_id;

      // 4. Drain v2.0.0 via the Admin deactivate API (W28-C)
      const deactivateV2Resp = await fetch(
        `${orchestratorUrl}/api/v1/admin/businesses/${exampleReviewManifestV2.businessId}/versions/${exampleReviewManifestV2.version}/deactivate`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${adminToken}`,
            'content-type': 'application/json',
          },
        }
      );
      expect([200, 202]).toContain(deactivateV2Resp.status);
      const deactBody = (await deactivateV2Resp.json()) as { businessId: string; version: string; active: boolean };
      expect(deactBody.businessId).toBe('example-review');
      expect(deactBody.version).toBe('2.0.0');
      expect(deactBody.active).toBe(false);

      // Invariant: Both v1.0.0 and v2.0.0 are now inactive (drained state)
      const drainedRows = await orchestratorApp!.db.query<{ version: string; is_active: boolean }>(
        "SELECT version, is_active FROM business_versions WHERE business_id = 'example-review'"
      );
      for (const row of drainedRows.rows) {
        expect(row.is_active).toBe(false);
      }

      // 5. Fail-closed verification: submissions to a drained business fail with HTTP 404 NOT_FOUND
      const reviewIdDrained = `rev-drained-${randomUUID()}`;
      const submitDrainedResp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            input: {
              reviewId: reviewIdDrained,
              artifacts: [{ artifactId: randomUUID(), fileName: 'drained.pdf' }],
              checks: { 'compliance-check': true },
              requireApproval: false,
            },
          }),
        }
      );
      expect(submitDrainedResp.status).toBe(404);
      const drainedErr = (await submitDrainedResp.json()) as { code?: string; title?: string; detail?: string };
      expect(drainedErr.code).toBe('NOT_FOUND');

      // Invariant: No task record created for the rejected submission
      const noTaskRes = await orchestratorApp!.db.query(
        "SELECT id FROM tasks WHERE payload_ref::text LIKE $1",
        [`%${reviewIdDrained}%`]
      );
      expect(noTaskRes.rowCount).toBe(0);

      // 6. Explicit rollback: Activate v1.0.0 via the Admin activate API (W28-C)
      const activateV1Resp = await fetch(
        `${orchestratorUrl}/api/v1/admin/businesses/${exampleReviewManifest.businessId}/versions/${exampleReviewManifest.version}/activate`,
        {
          method: 'PUT',
          headers: {
            authorization: `Bearer ${adminToken}`,
            'content-type': 'application/json',
          },
        }
      );
      expect([200, 202]).toContain(activateV1Resp.status);
      const actV1Body = (await activateV1Resp.json()) as { businessId: string; version: string; active: boolean };
      expect(actV1Body.businessId).toBe('example-review');
      expect(actV1Body.version).toBe('1.0.0');
      expect(actV1Body.active).toBe(true);

      // Invariant: v1.0.0 is active, v2.0.0 is inactive
      const v1Active = await orchestratorApp!.db.query<{ is_active: boolean }>(
        "SELECT is_active FROM business_versions WHERE business_id = 'example-review' AND version = '1.0.0'"
      );
      expect(v1Active.rows[0]?.is_active).toBe(true);

      const v2Active = await orchestratorApp!.db.query<{ is_active: boolean }>(
        "SELECT is_active FROM business_versions WHERE business_id = 'example-review' AND version = '2.0.0'"
      );
      expect(v2Active.rows[0]?.is_active).toBe(false);

      // 7. Post-rollback submission: New operations now route to v1.0.0!
      const reviewIdPostRollback = `rev-post-rollback-${randomUUID()}`;
      const submitPostRollbackResp = await fetch(
        `${orchestratorUrl}/api/v1/businesses/example-review/actions/review`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-api-key': apiKey,
          },
          body: JSON.stringify({
            input: {
              reviewId: reviewIdPostRollback,
              artifacts: [{ artifactId: randomUUID(), fileName: 'post-rollback.pdf' }],
              checks: { 'compliance-check': true },
              requireApproval: false,
            },
          }),
        }
      );
      expect(submitPostRollbackResp.status).toBe(202);
      const { operationId: opPostRollbackId } = (await submitPostRollbackResp.json()) as { operationId: string };

      // Invariant: OpPostRollback is pinned to business_version = '1.0.0'
      const opRollbackRow = await orchestratorApp!.db.query<{ business_version: string }>(
        'SELECT business_version FROM operations WHERE id = $1',
        [opPostRollbackId]
      );
      expect(opRollbackRow.rows[0]?.business_version).toBe('1.0.0');

      // Dispatched task outbox record targets version 1.0.0
      const rollbackOutbox = await orchestratorApp!.db.query<{ payload: { businessVersion?: string } }>(
        'SELECT payload FROM outbox WHERE aggregate_id IN (SELECT id FROM tasks WHERE operation_id = $1)',
        [opPostRollbackId]
      );
      expect(rollbackOutbox.rows[0]?.payload.businessVersion).toBe('1.0.0');

      // Completes on Worker 1
      const opRollbackFinal = await pollOperationState(opPostRollbackId, true, 20_000);
      expect(opRollbackFinal.state).toBe('SUCCEEDED');

      const resRollbackResp = await fetch(`${orchestratorUrl}/api/v1/operations/${opPostRollbackId}/result`, {
        headers: { 'x-api-key': apiKey },
      });
      expect(resRollbackResp.status).toBe(200);
      const resRollbackBody = (await resRollbackResp.json()) as { data: { resultRef?: string } };
      expect(resRollbackBody.data.resultRef).toMatch(/^artifact:\/\//);

      const envRollback = await readResultArtifactEnvelope(opPostRollbackId, resRollbackBody.data.resultRef!);
      expect(envRollback.reviewId).toBe(reviewIdPostRollback);
      expect(envRollback.version).toBe('1.0.0');
      expect(typeof envRollback.summary).toBe('string');
      expect((envRollback.summary as string).startsWith('[1.0.0]')).toBe(true);

      // 8. In-flight continuation pinning: Resume OpV2Inflight (which remains pinned to v2.0.0)
      const resumeV2Resp = await fetch(`${orchestratorUrl}/api/v1/operations/${opV2InflightId}/resume`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': apiKey,
        },
        body: JSON.stringify({
          waitId: waitIdV2,
          input: {
            approved: true,
            note: 'Approved under in-flight v2 after rollback',
            approver: 'v2-drain-approver',
          },
          expectedStateVersion: midStateV2.stateVersion,
        }),
      });
      expect(resumeV2Resp.status).toBe(202);

      // Invariant: Resumed task outbox record carries pinned businessVersion 2.0.0
      const v2ResumedOutbox = await orchestratorApp!.db.query<{ payload: { businessVersion?: string } }>(
        'SELECT payload FROM outbox WHERE aggregate_id IN (SELECT id FROM tasks WHERE operation_id = $1) ORDER BY created_at DESC',
        [opV2InflightId]
      );
      expect(v2ResumedOutbox.rows[0]?.payload.businessVersion).toBe('2.0.0');

      // OpV2Inflight must be claimed and processed by Worker 2 (queue du-business-example-review-2.0.0)
      const opV2Final = await pollOperationState(opV2InflightId, true, 20_000);
      expect(opV2Final.state).toBe('SUCCEEDED');

      // Verify OpV2Inflight result envelope carries observable version 2.0.0 markers
      const resV2InflightResp = await fetch(`${orchestratorUrl}/api/v1/operations/${opV2InflightId}/result`, {
        headers: { 'x-api-key': apiKey },
      });
      expect(resV2InflightResp.status).toBe(200);
      const resV2InflightBody = (await resV2InflightResp.json()) as { data: { resultRef?: string } };
      expect(resV2InflightBody.data.resultRef).toMatch(/^artifact:\/\//);

      const envV2Inflight = await readResultArtifactEnvelope(opV2InflightId, resV2InflightBody.data.resultRef!);
      expect(envV2Inflight.reviewId).toBe(reviewIdV2Inflight);
      expect(envV2Inflight.approved).toBe(true);
      expect(envV2Inflight.version).toBe('2.0.0');
      expect(typeof envV2Inflight.summary).toBe('string');
      expect((envV2Inflight.summary as string).startsWith('[2.0.0]')).toBe(true);
      expect(envV2Inflight.approval).toMatchObject({
        approved: true,
        note: 'Approved under in-flight v2 after rollback',
        approver: 'v2-drain-approver',
      });
    } finally {
      await workerHandleV2.stop(5000);
    }
  }, 45_000);
});
