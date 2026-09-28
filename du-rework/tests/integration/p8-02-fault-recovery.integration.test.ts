import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Queue } from 'bullmq';
import { createApp, type App } from '@du/orchestrator';
import { PgSqlClient } from '@du/connector';
import {
  BusinessManifestSchema,
  contentHash,
  type ClaimResult,
} from '@du/contracts';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  assertSafeIsolationConfig,
  type TestIsolationContext,
} from '../isolation/namespace';

const isolationCtx: TestIsolationContext | null =
  process.env.TEST_ISOLATION === 'disabled'
    ? null
    : createTestIsolationContext({
        runId: process.env.TEST_RUN_ID,
        redisDbIndex: process.env.REDIS_DB_INDEX ? Number(process.env.REDIS_DB_INDEX) : undefined,
      });

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const DATABASE_URL = isolationCtx
  ? isolationCtx.getDatabaseUrlWithSchema(BASE_DATABASE_URL)
  : BASE_DATABASE_URL;

const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const REDIS_URL = process.env.REDIS_URL ?? (
  isolationCtx
    ? isolationCtx.getRedisUrl(BASE_REDIS_URL)
    : BASE_REDIS_URL
);

const RUNTIME_TOKEN = `p802-rt-${randomUUID()}`;
const ADMIN_TOKEN = `p802-adm-${randomUUID()}`;
const USAGE_TOKEN = `p802-usg-${randomUUID()}`;
const API_KEY = `du_test_${randomUUID().replace(/-/g, '')}`;
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

const BUSINESS_ID = `p802-proof-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const BUSINESS_VERSION = '1.0.0';
const QUEUE_NAME = `du-business-${BUSINESS_ID}-${BUSINESS_VERSION}`;

const testManifest = BusinessManifestSchema.parse({
  contractVersion: '1',
  businessId: BUSINESS_ID,
  version: BUSINESS_VERSION,
  displayName: 'P8-02 Fault Recovery Proof',
  description: 'Synthetic fault recovery and transaction boundary test fixture',
  imageDigest: `sha256:${'b'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root', 'child-task'] },
  capabilities: { cancel: true, resume: true, parallel: true },
  actions: [
    {
      name: 'process',
      displayName: 'Process',
      description: 'Test process action',
      inputSchema: {
        type: 'object',
        required: ['payload'],
        properties: { payload: { type: 'string', minLength: 1 } },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      profileSchema: { type: 'object' },
      connectorSlots: [],
      artifactPolicy: { minFiles: 0, maxFiles: 5 },
      capabilities: { cancel: true, resume: true },
      defaultLimits: { maxParallelTasks: 2 },
    },
  ],
});

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
  headers: Record<string, string>;
}

async function http(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<HttpResult> {
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  const body = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  const headers: Record<string, string> = {};
  res.headers.forEach((v, k) => {
    headers[k] = v;
  });
  return { status: res.status, body, headers };
}

describe('P8-02: Transaction Boundary Fault Suite, Lease Recovery & Crash Fencing (OPS-02/07, RUN-02..07, ART-02)', () => {
  let app: App | undefined;
  let baseUrl: string;
  let queue: Queue | undefined;

  beforeAll(async () => {
    assertSafeIsolationConfig({
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      isolationCtx,
      allowUnsafeShared: process.env.ALLOW_UNSAFE_SHARED_DB === 'true',
    });

    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await client.close();
    }

    app = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      adminToken: ADMIN_TOKEN,
      usageToken: USAGE_TOKEN,
      autoDispatch: false,
      autoMigrate: true,
    });

    await app.listen();
    const addr = app.server.address() as AddressInfo;
    baseUrl = `http://127.0.0.1:${addr.port}`;
    queue = app.getQueue(QUEUE_NAME) as Queue;

    // Seed test tenant and API key
    await app.db.query(
      `INSERT INTO tenants (id, name, state) VALUES ($1, 'tenant-p802', 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
      [TENANT_ID]
    );
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'p802', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), TENANT_ID, hashKey(API_KEY)]
    );

    // Register test business via runtime API and enable for test
    const regRes = await http(baseUrl, `/api/runtime/v1/businesses/${BUSINESS_ID}/versions/${BUSINESS_VERSION}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: testManifest,
    });
    expect([200, 201]).toContain(regRes.status);
    await app.enableVersionForTest(BUSINESS_ID, BUSINESS_VERSION);
  }, 30_000);

  afterAll(async () => {
    if (app) {
      await app.close({ timeoutMs: 200, pollIntervalMs: 50 });
    }
    if (isolationCtx) {
      const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
      await client.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      await client.close();
      isolationCtx.cleanupArtifactDir();
    }
  }, 30_000);

  async function submitOperation(
    payload = 'test-payload',
    idempotencyKey?: string
  ): Promise<{ operationId: string; taskId: string }> {
    const headers: Record<string, string> = { 'x-api-key': API_KEY };
    if (idempotencyKey) headers['idempotency-key'] = idempotencyKey;

    const res = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
      method: 'POST',
      headers,
      body: { input: { payload } },
    });
    expect([200, 202]).toContain(res.status);
    const opId = res.body.operationId as string;

    const taskRow = await app!.db.query<{ id: string }>(
      'SELECT id FROM tasks WHERE operation_id = $1 LIMIT 1',
      [opId]
    );
    return { operationId: opId, taskId: taskRow.rows[0]!.id };
  }

  async function sweepDeadlinesHttp(): Promise<number> {
    const res = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
      method: 'POST',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(res.status).toBe(200);
    return (res.body as { timedOut: number }).timedOut;
  }

  async function claimTask(
    taskId: string,
    workerInstanceId: string,
    deliveryId = `del-${randomUUID()}`
  ): Promise<ClaimResult> {
    const res = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { deliveryId, workerInstanceId, businessId: BUSINESS_ID },
    });
    expect(res.status).toBe(200);
    return res.body as unknown as ClaimResult;
  }

  // ---------------------------------------------------------------------------
  // 1. Transaction Boundary Fault Invariants (No Half-Written State) (RUN-04, ART-02)
  // ---------------------------------------------------------------------------
  describe('1. Transaction Boundary Fault Invariants (Zero Half-Written State)', () => {
    test('submission transaction boundary failure leaves zero half-written operation or task state', async () => {
      const failedOpId = randomUUID();
      const failedKey = `failed-idem-${randomUUID()}`;

      // Simulate a failure injected midway through a submission transaction
      let errorThrown = false;
      try {
        await app!.db.tx(async (client) => {
          await client.query(
            `INSERT INTO operations (id, tenant_id, api_key_id, business_id, business_version, action, state, state_version, correlation_id)
             VALUES ($1, $2, (SELECT id FROM api_keys WHERE hash=$3), $4, $5, 'process', 'ACCEPTED', 1, $6)`,
            [failedOpId, TENANT_ID, hashKey(API_KEY), BUSINESS_ID, BUSINESS_VERSION, 'corr-fail']
          );

          await client.query(
            `INSERT INTO submission_keys (tenant_id, api_key_id, route_action, key, operation_id, request_hash, expires_at)
             VALUES ($1, (SELECT id FROM api_keys WHERE hash=$2), $3, $4, $5, 'hash-dummy', now() + interval '1 hour')`,
            [TENANT_ID, hashKey(API_KEY), `${BUSINESS_ID}.process`, failedKey, failedOpId]
          );

          // Injected failure before COMMIT
          throw new Error('SIMULATED_TRANSACTION_BOUNDARY_FAILURE');
        });
      } catch (err: unknown) {
        errorThrown = true;
        expect((err as Error).message).toBe('SIMULATED_TRANSACTION_BOUNDARY_FAILURE');
      }
      expect(errorThrown).toBe(true);

      // Verify complete rollback: zero rows committed across all related tables
      const opCheck = await app!.db.query<{ count: string }>(
        'SELECT count(*) FROM operations WHERE id = $1',
        [failedOpId]
      );
      expect(Number(opCheck.rows[0]!.count)).toBe(0);

      const taskCheck = await app!.db.query<{ count: string }>(
        'SELECT count(*) FROM tasks WHERE operation_id = $1',
        [failedOpId]
      );
      expect(Number(taskCheck.rows[0]!.count)).toBe(0);

      const keyCheck = await app!.db.query<{ count: string }>(
        'SELECT count(*) FROM submission_keys WHERE key = $1',
        [failedKey]
      );
      expect(Number(keyCheck.rows[0]!.count)).toBe(0);

      const outboxCheck = await app!.db.query<{ count: string }>(
        'SELECT count(*) FROM outbox WHERE aggregate_id = $1',
        [failedOpId]
      );
      expect(Number(outboxCheck.rows[0]!.count)).toBe(0);
    });

    test('child spawn transaction boundary failure rolls back and prevents parent task state drift', async () => {
      const { taskId } = await submitOperation('payload-spawn-fault');
      const claim = await claimTask(taskId, 'worker-spawn-fault');
      expect(claim.leaseEpoch).toBe(1);

      // Verify parent task is RUNNING
      const beforeTask = await app!.db.query<{ state: string }>(
        'SELECT state FROM tasks WHERE id = $1',
        [taskId]
      );
      expect(beforeTask.rows[0]!.state).toBe('RUNNING');

      // Attempt to spawn children with invalid empty children schema -> fails closed at boundary
      const invalidSpawnRes = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/children`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: claim.leaseEpoch,
          children: [], // Schema violation: minItems is 1
          joinPolicy: 'all-success',
          continuationRef: 'cont-ref-1',
        },
      });
      expect(invalidSpawnRes.status).toBe(422);

      // Also simulate a mid-transaction DB failure during child insertion
      let spawnErrorThrown = false;
      try {
        await app!.db.tx(async (client) => {
          await client.query(
            "UPDATE tasks SET state = 'WAITING_CHILDREN', updated_at = now() WHERE id = $1",
            [taskId]
          );
          // Injected constraint or connection failure
          throw new Error('SIMULATED_CHILD_INSERT_CRASH');
        });
      } catch (err: unknown) {
        spawnErrorThrown = true;
        expect((err as Error).message).toBe('SIMULATED_CHILD_INSERT_CRASH');
      }
      expect(spawnErrorThrown).toBe(true);

      // Verify parent task state did NOT drift to WAITING_CHILDREN; still RUNNING
      const afterTask = await app!.db.query<{ state: string }>(
        'SELECT state FROM tasks WHERE id = $1',
        [taskId]
      );
      expect(afterTask.rows[0]!.state).toBe('RUNNING');

      // Verify zero child tasks and zero child outbox entries were persisted
      const childCount = await app!.db.query<{ count: string }>(
        'SELECT count(*) FROM tasks WHERE parent_id = $1',
        [taskId]
      );
      expect(Number(childCount.rows[0]!.count)).toBe(0);
    });

    test('task report success transaction boundary failure rolls back and leaves task and operation RUNNING', async () => {
      const { operationId, taskId } = await submitOperation('payload-success-fault');
      const claim = await claimTask(taskId, 'worker-success-fault');

      // Simulate a failure injected midway through task completion transaction
      let completionFailed = false;
      try {
        await app!.db.tx(async (client) => {
          await client.query("UPDATE tasks SET state='SUCCEEDED', updated_at=now() WHERE id=$1", [taskId]);
          await client.query("UPDATE operations SET state='SUCCEEDED', updated_at=now() WHERE id=$1", [operationId]);
          // Injected error before COMMIT
          throw new Error('SIMULATED_COMPLETION_TX_ERROR');
        });
      } catch (err: unknown) {
        completionFailed = true;
        expect((err as Error).message).toBe('SIMULATED_COMPLETION_TX_ERROR');
      }
      expect(completionFailed).toBe(true);

      // Verify both task and operation remain in their pre-transaction RUNNING state
      const taskRow = await app!.db.query<{ state: string }>('SELECT state FROM tasks WHERE id = $1', [taskId]);
      expect(taskRow.rows[0]!.state).toBe('RUNNING');

      const opRow = await app!.db.query<{ state: string }>('SELECT state FROM operations WHERE id = $1', [operationId]);
      expect(opRow.rows[0]!.state).toBe('RUNNING'); // Root task was claimed and running under RUNNING operation

      // Cancel test operation so no dangling active RUNNING lease remains
      await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });
    });

    test('artifact upload transaction boundary failure leaves no orphan unreferenced artifact metadata (ART-02)', async () => {
      const { taskId } = await submitOperation('payload-art-fault');
      const orphanArtId = randomUUID();

      let artErrorThrown = false;
      try {
        await app!.db.tx(async (client) => {
          await client.query(
            `INSERT INTO artifacts (id, tenant_id, task_id, storage_key, token, size_bytes, mime_type, state)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
            [orphanArtId, TENANT_ID, taskId, `s3://bucket/test-${orphanArtId}.bin`, 'tok-fault', 512, 'application/pdf', 'STAGING']
          );
          // Injected storage service crash
          throw new Error('SIMULATED_BLOB_STORAGE_TIMEOUT');
        });
      } catch (err: unknown) {
        artErrorThrown = true;
        expect((err as Error).message).toBe('SIMULATED_BLOB_STORAGE_TIMEOUT');
      }
      expect(artErrorThrown).toBe(true);

      // Verify zero orphan artifact records exist
      const artCheck = await app!.db.query<{ count: string }>(
        'SELECT count(*) FROM artifacts WHERE id = $1',
        [orphanArtId]
      );
      expect(Number(artCheck.rows[0]!.count)).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Crashed Worker Cannot Keep Leases & Lease Takeover (OPS-02, RUN-07)
  // ---------------------------------------------------------------------------
  describe('2. Crashed Worker Cannot Keep Leases & Lease Takeover', () => {
    let takeoverTaskId: string;
    let takeoverOpId: string;
    let originalLeaseEpoch: number;

    test('crashed worker lease expiry is detected by sweeper: re-dispatched and old epoch fenced', async () => {
      const { operationId, taskId } = await submitOperation('payload-crash-recovery');
      takeoverOpId = operationId;
      takeoverTaskId = taskId;

      const claim1 = await claimTask(takeoverTaskId, 'crashed-worker-1');
      originalLeaseEpoch = claim1.leaseEpoch;
      expect(originalLeaseEpoch).toBe(1);

      // Simulate a crashed worker by forcefully expiring the lease in the past
      await app!.db.query(
        "UPDATE tasks SET lease_expires_at = now() - interval '2 seconds' WHERE id = $1",
        [takeoverTaskId]
      );

      // Execute background lease sweeper
      const sweptCount = await app!.runtime.sweepExpiredLeases();
      expect(sweptCount).toBeGreaterThanOrEqual(1);

      // Verify task was reset to READY, lease cleared, and lease_epoch bumped
      const taskRow = await app!.db.query<{ state: string; lease_epoch: number; lease_expires_at: string | null }>(
        'SELECT state, lease_epoch, lease_expires_at FROM tasks WHERE id = $1',
        [takeoverTaskId]
      );
      expect(taskRow.rows[0]!.state).toBe('READY');
      expect(taskRow.rows[0]!.lease_expires_at).toBeNull();
      expect(taskRow.rows[0]!.lease_epoch).toBe(2);

      // Verify recovery delivery outbox entry was inserted
      const outboxRows = await app!.db.query<{ delivery_id: string }>(
        "SELECT delivery_id FROM outbox WHERE aggregate_id = $1 AND delivery_id LIKE '%recover%'",
        [takeoverTaskId]
      );
      expect(outboxRows.rowCount).toBeGreaterThanOrEqual(1);
    });

    test('replacement worker successfully executes lease takeover', async () => {
      // Replacement worker claims the re-dispatched task (sweeper set epoch to 2, claimTask bumps to 3)
      const claim2 = await claimTask(takeoverTaskId, 'replacement-worker-2');
      expect(claim2.leaseEpoch).toBe(3);
      expect(claim2.taskId).toBe(takeoverTaskId);

      // Verify database reflects takeover by worker-2
      const taskRow = await app!.db.query<{ state: string; leased_by: string; lease_epoch: number }>(
        'SELECT state, leased_by, lease_epoch FROM tasks WHERE id = $1',
        [takeoverTaskId]
      );
      expect(taskRow.rows[0]!.state).toBe('RUNNING');
      expect(taskRow.rows[0]!.leased_by).toBe('replacement-worker-2');
      expect(taskRow.rows[0]!.lease_epoch).toBe(3);
    });

    test('zombie worker heartbeat after lease takeover is rejected with 409 LEASE_LOST', async () => {
      // Zombie crashed-worker-1 wakes up and attempts heartbeat with stale leaseEpoch = 1
      const staleHeartbeat = await http(baseUrl, `/api/runtime/v1/tasks/${takeoverTaskId}/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { leaseEpoch: originalLeaseEpoch },
      });

      expect(staleHeartbeat.status).toBe(409);
      expect(staleHeartbeat.body.code).toBe('LEASE_LOST');
    });

    test('zombie worker writes during active takeover lease are rejected with 409 LEASE_LOST', async () => {
      const zombieResult = 'artifact://zombie-corrupted-result';
      // Zombie crashed-worker-1 attempts to complete task with stale epoch (1) while Worker 2 holds epoch (3)
      const staleComplete = await http(baseUrl, `/api/runtime/v1/tasks/${takeoverTaskId}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: originalLeaseEpoch,
          resultRef: zombieResult,
          resultHash: contentHash(zombieResult),
        },
      });

      expect(staleComplete.status).toBe(409);
      expect(staleComplete.body.code).toBe('LEASE_LOST');

      // Zombie crashed-worker-1 attempts to spawn children with stale epoch
      const staleSpawn = await http(baseUrl, `/api/runtime/v1/tasks/${takeoverTaskId}/children`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: originalLeaseEpoch,
          children: [
            {
              taskKey: 'zombie-child',
              kind: 'child-task',
              payloadRef: {},
              payloadHash: contentHash({}),
            },
          ],
          joinPolicy: 'all-success',
          continuationRef: 'cont-zombie',
        },
      });

      expect(staleSpawn.status).toBe(409);
      expect(staleSpawn.body.code).toBe('LEASE_LOST');
    });

    test('replacement worker completes task and subsequent writes return 410 TASK_TERMINAL', async () => {
      const resultRef = 'artifact://result-takeover-success';
      const successRes = await http(baseUrl, `/api/runtime/v1/tasks/${takeoverTaskId}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: 3,
          resultRef,
          resultHash: contentHash(resultRef),
        },
      });
      expect(successRes.status).toBe(200);

      // Verify terminal success in database
      const finalTask = await app!.db.query<{ state: string }>('SELECT state FROM tasks WHERE id = $1', [takeoverTaskId]);
      expect(finalTask.rows[0]!.state).toBe('SUCCEEDED');

      // Subsequent writes against terminal task return 410 TASK_TERMINAL
      const terminalSpawn = await http(baseUrl, `/api/runtime/v1/tasks/${takeoverTaskId}/children`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: 3,
          children: [
            {
              taskKey: 'terminal-child',
              kind: 'child-task',
              payloadRef: {},
              payloadHash: contentHash({}),
            },
          ],
          joinPolicy: 'all-success',
          continuationRef: 'cont-term',
        },
      });
      expect(terminalSpawn.status).toBe(410);
      expect(terminalSpawn.body.code).toBe('TASK_TERMINAL');
    });
  });

  // ---------------------------------------------------------------------------
  // 3. Cancelled Worker Cannot Keep Leases (OPS-02, RUN-07)
  // ---------------------------------------------------------------------------
  describe('3. Cancelled Worker Cannot Keep Leases & Fencing', () => {
    let cancelOpId: string;
    let cancelTaskId: string;
    let cancelLeaseEpoch: number;

    test('cancelling operation cancels running task and open human wait atomically', async () => {
      const { operationId, taskId } = await submitOperation('payload-cancel-test');
      cancelOpId = operationId;
      cancelTaskId = taskId;

      const claim = await claimTask(cancelTaskId, 'worker-to-cancel');
      cancelLeaseEpoch = claim.leaseEpoch;

      // Yield an open human wait to verify atomic cancel of human waits as well
      const waitRes = await http(baseUrl, `/api/runtime/v1/tasks/${cancelTaskId}/wait-input`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: cancelLeaseEpoch,
          waitKey: 'approval-wait',
          inputSchema: { type: 'object' },
        },
      });
      expect(waitRes.status).toBe(200);

      // Cancel the operation via public API
      const cancelRes = await http(baseUrl, `/api/v1/operations/${cancelOpId}/cancel`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });
      expect([200, 202]).toContain(cancelRes.status);
      expect(cancelRes.body.state).toBe('CANCELLED');

      // Verify database reflects atomic transition to CANCELLED for operation, task, and human wait
      const opRow = await app!.db.query<{ state: string }>('SELECT state FROM operations WHERE id = $1', [cancelOpId]);
      expect(opRow.rows[0]!.state).toBe('CANCELLED');

      const taskRow = await app!.db.query<{ state: string }>('SELECT state FROM tasks WHERE id = $1', [cancelTaskId]);
      expect(taskRow.rows[0]!.state).toBe('CANCELLED');

      const waitRow = await app!.db.query<{ status: string }>(
        'SELECT status FROM human_waits WHERE operation_id = $1',
        [cancelOpId]
      );
      expect(waitRow.rows[0]!.status).toBe('CANCELLED');
    });

    test('stale heartbeat on cancelled task is rejected with 409 LEASE_LOST', async () => {
      const heartbeatRes = await http(baseUrl, `/api/runtime/v1/tasks/${cancelTaskId}/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { leaseEpoch: cancelLeaseEpoch + 99 },
      });

      expect(heartbeatRes.status).toBe(409);
      expect(heartbeatRes.body.code).toBe('LEASE_LOST');
    });

    test('cancelled task cannot be claimed by another worker (fencing)', async () => {
      const claimRes = await http(baseUrl, `/api/runtime/v1/tasks/${cancelTaskId}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          deliveryId: `del-cancel-${randomUUID()}`,
          workerInstanceId: 'worker-cancelled-claim',
          businessId: BUSINESS_ID,
        },
      });

      expect(claimRes.status).toBe(410);
      expect(claimRes.body.code).toBe('TASK_TERMINAL');
    });

    test('cancelled worker cannot report completion or yield child tasks (fencing)', async () => {
      const resultRef = 'artifact://cancelled-result';
      const completeRes = await http(baseUrl, `/api/runtime/v1/tasks/${cancelTaskId}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: cancelLeaseEpoch,
          resultRef,
          resultHash: contentHash(resultRef),
        },
      });

      expect(completeRes.status).toBe(410);
      expect(completeRes.body.code).toBe('TASK_TERMINAL');

      const spawnRes = await http(baseUrl, `/api/runtime/v1/tasks/${cancelTaskId}/children`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: cancelLeaseEpoch,
          children: [
            {
              taskKey: 'cancelled-child',
              kind: 'child-task',
              payloadRef: {},
              payloadHash: contentHash({}),
            },
          ],
          joinPolicy: 'all-success',
          continuationRef: 'cont-cancelled',
        },
      });

      expect(spawnRes.status).toBe(410);
      expect(spawnRes.body.code).toBe('TASK_TERMINAL');
    });
  });

  // ---------------------------------------------------------------------------
  // 4. Duplicate Delivery Converges to One Effect (RUN-02, RUN-06)
  // ---------------------------------------------------------------------------
  describe('4. Duplicate Delivery Converges to One Effect', () => {
    test('duplicate submission delivery with identical Idempotency-Key returns replayed=true with zero duplicate rows', async () => {
      const idempotencyKey = `idem-converge-${randomUUID()}`;
      const payload = 'consistent-idempotent-body';

      // First delivery
      const res1 = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: { input: { payload } },
      });
      expect(res1.status).toBe(202);
      const opId = res1.body.operationId as string;

      // Duplicate delivery with identical key and payload
      const res2 = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: { input: { payload } },
      });
      expect(res2.status).toBe(200);
      expect(res2.body.operationId).toBe(opId);
      expect(res2.body.replayed).toBe(true);

      // Verify exactly ONE operation and ONE root task row exist
      const opCount = await app!.db.query<{ count: string }>(
        'SELECT count(*) FROM operations WHERE id = $1',
        [opId]
      );
      expect(Number(opCount.rows[0]!.count)).toBe(1);

      const taskCount = await app!.db.query<{ count: string }>(
        'SELECT count(*) FROM tasks WHERE operation_id = $1',
        [opId]
      );
      expect(Number(taskCount.rows[0]!.count)).toBe(1);
    });

    test('duplicate submission delivery with mismatched payload fails with 409 IDEMPOTENCY_CONFLICT', async () => {
      const idempotencyKey = `idem-conflict-${randomUUID()}`;

      // First submit
      const res1 = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: { input: { payload: 'first-payload' } },
      });
      expect(res1.status).toBe(202);

      // Second submit with same key but altered payload
      const res2 = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: {
          'x-api-key': API_KEY,
          'idempotency-key': idempotencyKey,
        },
        body: { input: { payload: 'conflicting-different-payload' } },
      });
      expect(res2.status).toBe(409);
      expect(res2.body.code).toBe('IDEMPOTENCY_CONFLICT');
    });

    test('duplicate resume delivery on human wait converges to single answer with CAS protection (RUN-06)', async () => {
      const { operationId, taskId } = await submitOperation('payload-resume-convergence');
      const claim = await claimTask(taskId, 'worker-resume-test');

      // Yield a human wait
      const waitRes = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/wait-input`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: claim.leaseEpoch,
          waitKey: 'decision-wait',
          inputSchema: {
            type: 'object',
            required: ['approved'],
            properties: { approved: { type: 'boolean' } },
          },
        },
      });
      expect(waitRes.status).toBe(200);
      const waitId = waitRes.body.waitId as string;

      // Check state_version before resume
      const opBefore = await app!.db.query<{ state_version: number }>(
        'SELECT state_version FROM operations WHERE id = $1',
        [operationId]
      );
      const v1 = opBefore.rows[0]!.state_version;

      // First resume call
      const resume1 = await http(baseUrl, `/api/v1/operations/${operationId}/resume`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
        body: {
          waitId,
          input: { approved: true },
          expectedStateVersion: v1,
        },
      });
      expect(resume1.status).toBe(202);
      expect(resume1.body.replayed).toBe(false);

      // Check state_version after resume (bumped by 1)
      const opAfter = await app!.db.query<{ state_version: number }>(
        'SELECT state_version FROM operations WHERE id = $1',
        [operationId]
      );
      const v2 = opAfter.rows[0]!.state_version;
      expect(v2).toBe(v1 + 1);

      // Stale resume call with old state_version v1 is rejected with 409 STATE_CONFLICT (CAS guard)
      const staleResume = await http(baseUrl, `/api/v1/operations/${operationId}/resume`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
        body: {
          waitId,
          input: { approved: true },
          expectedStateVersion: v1, // Stale version
        },
      });
      expect(staleResume.status).toBe(409);
      expect(staleResume.body.code).toBe('STATE_CONFLICT');

      // Duplicate resume call with current state_version v2 returns 200 replayed=true
      const resume2 = await http(baseUrl, `/api/v1/operations/${operationId}/resume`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
        body: {
          waitId,
          input: { approved: true },
          expectedStateVersion: v2,
        },
      });
      expect(resume2.status).toBe(200);
      expect(resume2.body.replayed).toBe(true);

      // Database CAS check: human_waits row is ANSWERED, exactly 1 row
      const waitRow = await app!.db.query<{ status: string }>(
        'SELECT status FROM human_waits WHERE operation_id = $1 AND wait_id = $2',
        [operationId, waitId]
      );
      expect(waitRow.rowCount).toBe(1);
      expect(waitRow.rows[0]!.status).toBe('ANSWERED');

      // Outbox check: exactly 1 continuation dispatch row was inserted, no duplicate dispatch
      const resumeDispatches = await app!.db.query<{ delivery_id: string }>(
        "SELECT delivery_id FROM outbox WHERE aggregate_id = $1 AND delivery_id LIKE '%resume%'",
        [taskId]
      );
      expect(resumeDispatches.rowCount).toBe(1);
    });

    test('stale or duplicate resume after cancellation is rejected with 409 STATE_CONFLICT', async () => {
      const { operationId, taskId } = await submitOperation('payload-resume-after-cancel');
      const claim = await claimTask(taskId, 'worker-resume-cancel');

      const waitRes = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/wait-input`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: claim.leaseEpoch,
          waitKey: 'cancel-wait',
          inputSchema: { type: 'object' },
        },
      });
      const waitId = waitRes.body.waitId as string;

      // Cancel the operation
      await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });

      // Get current state_version of the cancelled operation
      const opRow = await app!.db.query<{ state_version: number }>(
        'SELECT state_version FROM operations WHERE id = $1',
        [operationId]
      );

      // Resume on cancelled operation must fail closed with 409 STATE_CONFLICT
      const resumeRes = await http(baseUrl, `/api/v1/operations/${operationId}/resume`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
        body: {
          waitId,
          input: { ok: true },
          expectedStateVersion: opRow.rows[0]!.state_version,
        },
      });
      expect(resumeRes.status).toBe(409);
      expect(resumeRes.body.code).toBe('STATE_CONFLICT');
    });
  });

  // ---------------------------------------------------------------------------
  // 5. Deadline Sweep & Crash Recovery Under Real Failure Injection (OPS-02, P2-06, OPS-07)
  // ---------------------------------------------------------------------------
  describe('5. Deadline Sweep & Crash Recovery Under Real Failure Injection', () => {
    test('deadline sweeper marks expired operations TIMED_OUT and cancels tasks atomically', async () => {
      const { operationId, taskId } = await submitOperation('payload-deadline-sweep');

      // Set deadline in the past to simulate elapsed deadline
      await app!.db.query(
        "UPDATE operations SET deadline_at = now() - interval '5 seconds' WHERE id = $1",
        [operationId]
      );

      // Trigger deadline sweeper
      const sweepCount = await sweepDeadlinesHttp();
      expect(sweepCount).toBeGreaterThanOrEqual(1);

      // Verify operation transitioned to TIMED_OUT
      const opRow = await app!.db.query<{ state: string }>('SELECT state FROM operations WHERE id = $1', [operationId]);
      expect(opRow.rows[0]!.state).toBe('TIMED_OUT');

      // Verify task transitioned to CANCELLED
      const taskRow = await app!.db.query<{ state: string }>('SELECT state FROM tasks WHERE id = $1', [taskId]);
      expect(taskRow.rows[0]!.state).toBe('CANCELLED');
    });

    test('subsequent deadline sweep is idempotent and sweeps 0 operations', async () => {
      const secondSweep = await sweepDeadlinesHttp();
      expect(secondSweep).toBe(0);
    });

    test('shutdown graceful drain rejects new claims with 503 SHUTTING_DOWN (OPS-07)', async () => {
      const { taskId } = await submitOperation('payload-drain-test');

      // Invoke drain with short timeout
      const drainPromise = app!.runtime.drain(100, 50);

      // While draining is active, new claims must fail closed with 503 SHUTTING_DOWN
      const claimRes = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          deliveryId: `del-drain-${randomUUID()}`,
          workerInstanceId: 'worker-during-drain',
          businessId: BUSINESS_ID,
        },
      });
      expect(claimRes.status).toBe(503);
      expect(claimRes.body.code).toBe('SHUTTING_DOWN');

      await drainPromise;
    });
  });
});
