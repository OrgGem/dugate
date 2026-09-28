/**
 * P8-02b — Redis-loss-before-claim drill + same-epoch production fault injection
 * (closes the two named P8-02 remains: MM-05 "Redis-loss drill", MM-10
 * "production fault injection / same-epoch cancel / recovery").
 *
 * Owner: Qwen-2 functional-testing lane (term_4d79e7d3) — W48-Q2-1. New file only;
 * touches NO existing suite. Boundaries honored: multi-container (Qwen-3),
 * services/connector + packages/connector-client (Codex-2), packages/worker-sdk,
 * orchestrator src / admin (Claude Code) are read-reused as shipped, never edited.
 *
 * Execution model (fleet rule): this is a LIVE_INFRA suite (PG :5433 / Redis :6380).
 * Qwen-2 does NOT open the DB window. It self-skips unless DU_LIVE_INFRA=1; the
 * authoritative evidence is the W48-Q2-1 RUN REQUEST (docs/29): Agent-6 runs
 * `DU_LIVE_INFRA=1 npx jest tests/integration/p8-02b-redisloss-sameepoch-fault.integration.test.ts --config tests/integration/jest.config.cjs --runInBand`
 * THREE consecutive times inside the claimed window, per-run literal + ExitCode.
 * An offline run yields only `[SKIP-QUALIFIED]` (docs/35 §1.4), never a pass claim.
 *
 * W48 Agent-6 feedback round (23:5x, fixed by Qwen-2 before resubmission):
 * - MM-05 helper: BullMQ v5 `getJob()` returns `undefined` (not null) for missing
 *   jobs — the `toBeNull()` at the obliterate check was a TEST bug (mine), fixed.
 * - MM-10b: heartbeat after cancel returned 200 — NOT a test bug but a PRODUCT
 *   defect (heartbeat route fenced by lease epoch only). DEFECT PROBE at W48
 *   rounds 1-3; FLIPPED to expect 410 TASK_TERMINAL on 2026-09-25 after the
 *   R1-B patch landed in runtime.ts:127-177 (REQUEST was filed via
 *   reports/qwen2.md §31; fix verified live by this suite's next 3-run cycle).
 * - 2026-09-25 cycle-88 FLIP (Qwen-2): MM-05c is NO LONGER a characterization.
 *   The queue-integrity seam landed (docs/38: runtime QUEUE_INTEGRITY_* SQL +
 *   app.runQueueIntegritySweep), the wipe->re-arm path proved live by p8-02c
 *   Round 7" (5/5 x3, Tester 05:53), and /health now serves queueIntegrity
 *   after the first sweep — the test drives a REAL dispatch + aged stamp +
 *   obliterate + wrapper sweep and asserts the durable signal (key-set 4->5,
 *   state RECONSTRUCTING). Round 8 (A6fb11) carries this suite's live verdict.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Queue } from 'bullmq';
import { createApp, type App } from '@du/orchestrator';
import { PgSqlClient } from '@du/connector';
import { BusinessManifestSchema, contentHash, type ClaimResult } from '@du/contracts';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  assertSafeIsolationConfig,
  type TestIsolationContext,
} from '../isolation/namespace';

const LIVE = process.env.DU_LIVE_INFRA === '1';
const describeLive = LIVE ? describe : describe.skip;

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
const REDIS_URL = isolationCtx ? isolationCtx.getRedisUrl(BASE_REDIS_URL) : BASE_REDIS_URL;

const RUNTIME_TOKEN = `p802b-rt-${randomUUID()}`;
const ADMIN_TOKEN = `p802b-adm-${randomUUID()}`;
const USAGE_TOKEN = `p802b-usg-${randomUUID()}`;
const API_KEY = `du_test_${randomUUID().replace(/-/g, '')}`;
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

const hashKey = (raw: string): string => createHash('sha256').update(raw).digest('hex');

const BUSINESS_ID = `p802b-proof-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const BUSINESS_VERSION = '1.0.0';
const QUEUE_NAME = `du-business-${BUSINESS_ID}-${BUSINESS_VERSION}`;

const testManifest = BusinessManifestSchema.parse({
  contractVersion: '1',
  businessId: BUSINESS_ID,
  version: BUSINESS_VERSION,
  displayName: 'P8-02b Redis-loss & same-epoch fault drill',
  description: 'Synthetic MM-05/MM-10 fault drill fixture (Qwen-2, W48-Q2-1)',
  imageDigest: `sha256:${'c'.repeat(64)}`,
  runtime: { wireVersion: '1', handlerKinds: ['root'] },
  capabilities: { cancel: true, resume: true, parallel: false },
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
      capabilities: { cancel: true, resume: false },
      defaultLimits: { maxParallelTasks: 1 },
    },
  ],
});

interface HttpResult {
  status: number;
  body: Record<string, unknown>;
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
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {} };
}

describeLive(
  'P8-02b: Redis-loss-before-claim drill (MM-05) + same-epoch fault injection (MM-10)',
  () => {
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
      baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
      queue = app.getQueue(QUEUE_NAME) as Queue;
      await app.db.query(
        `INSERT INTO tenants (id, name, state) VALUES ($1, 'tenant-p802b', 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
        [TENANT_ID]
      );
      await app.db.query(
        `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
         VALUES ($1, $2, $3, 'p802b', 'ACTIVE') ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
        [randomUUID(), TENANT_ID, hashKey(API_KEY)]
      );
      const reg = await http(baseUrl, `/api/runtime/v1/businesses/${BUSINESS_ID}/versions/${BUSINESS_VERSION}`, {
        method: 'PUT',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: testManifest,
      });
      expect([200, 201]).toContain(reg.status);
      await app.enableVersionForTest(BUSINESS_ID, BUSINESS_VERSION);
    }, 30_000);

    afterAll(async () => {
      await app?.close({ timeoutMs: 200, pollIntervalMs: 50 });
      if (isolationCtx) {
        const client = new PgSqlClient({ connectionString: BASE_DATABASE_URL });
        await client.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
        await client.close();
        isolationCtx.cleanupArtifactDir();
      }
    }, 30_000);

    async function submitOperation(
      payload: string,
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
      const operationId = res.body.operationId as string;
      const taskRow = await app!.db.query<{ id: string }>(
        'SELECT id FROM tasks WHERE operation_id = $1 LIMIT 1',
        [operationId]
      );
      return { operationId, taskId: taskRow.rows[0]!.id };
    }

    async function claimTask(taskId: string, workerInstanceId: string): Promise<ClaimResult> {
      const res = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { deliveryId: `del-${randomUUID()}`, workerInstanceId, businessId: BUSINESS_ID },
      });
      expect(res.status).toBe(200);
      return res.body as unknown as ClaimResult;
    }

    async function sweepDeadlines(): Promise<number> {
      const res = await http(baseUrl, '/api/v1/admin/operations/sweep-deadlines', {
        method: 'POST',
        headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      });
      expect(res.status).toBe(200);
      return Number(res.body.timedOut ?? 0);
    }

    /** Simulate total Redis queue-data loss for this task before any claim. */
    async function redisLossBeforeClaim(taskId: string): Promise<void> {
      await queue!.add('root', { taskId }, { jobId: `p802b-${taskId}` });
      expect(await queue!.getJob(`p802b-${taskId}`)).not.toBeNull();
      await queue!.obliterate({ force: true }); // Redis-side data gone before claim
      // BullMQ v5 resolves getJob() to `undefined` for a missing job, not null
      // (Agent-6 W48 feedback: the old toBeNull() assertion failed at :216).
      expect(await queue!.getJob(`p802b-${taskId}`)).toBeUndefined();
    }

    // ---------------------------------------------------------------------
    // MM-05 — Redis-loss-before-claim drill
    // ---------------------------------------------------------------------
    test('MM-05a: queue data lost before claim leaves READY intact (PG durable truth) and the deadline sweep is the bounded escape hatch (exactly-once)', async () => {
      const { operationId, taskId } = await submitOperation('mm05a');
      await redisLossBeforeClaim(taskId);

      const stuck = await app!.db.query<{ state: string; leased_by: string | null }>(
        'SELECT state, leased_by FROM tasks WHERE id = $1',
        [taskId]
      );
      expect(stuck.rows[0]!.state).toBe('READY'); // no half-claimed state
      expect(stuck.rows[0]!.leased_by).toBeNull();

      await app!.db.query(
        `UPDATE operations SET deadline_at = now() - interval '1 minute' WHERE id = $1`,
        [operationId]
      );
      expect(await sweepDeadlines()).toBeGreaterThanOrEqual(1);

      const op = await app!.db.query<{ state: string }>('SELECT state FROM operations WHERE id = $1', [operationId]);
      expect(op.rows[0]!.state).toBe('TIMED_OUT');
      const task = await app!.db.query<{ state: string }>('SELECT state FROM tasks WHERE id = $1', [taskId]);
      expect(['CANCELLED', 'TIMED_OUT', 'FAILED']).toContain(task.rows[0]!.state);

      // Idempotent: a second sweep cannot time the same operation out twice.
      const before = Number(
        (await app!.db.query<{ n: string }>('SELECT count(*)::int AS n FROM operations WHERE state=$1', ['TIMED_OUT']))
          .rows[0]!.n
      );
      await sweepDeadlines();
      const after = Number(
        (await app!.db.query<{ n: string }>('SELECT count(*)::int AS n FROM operations WHERE state=$1', ['TIMED_OUT']))
          .rows[0]!.n
      );
      expect(after).toBe(before);
    }, 25_000);

    test('MM-05b: submission_keys are Redis-durable — resubmit after queue wipe replays the SAME operation with zero duplicate rows', async () => {
      const key = `mm05b-${randomUUID()}`;
      const first = await submitOperation('mm05b', key);
      await redisLossBeforeClaim(first.taskId);

      const replay = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY, 'idempotency-key': key },
        body: { input: { payload: 'mm05b' } },
      });
      expect([200, 202]).toContain(replay.status);
      expect(replay.body.operationId).toBe(first.operationId);
      expect(replay.body.replayed).toBe(true);

      const ops = await app!.db.query<{ n: string }>('SELECT count(*)::int AS n FROM operations WHERE id = $1', [
        first.operationId,
      ]);
      expect(Number(ops.rows[0]!.n)).toBe(1); // survived Redis loss exactly once
    }, 25_000);

    test('MM-05c (FLIP cycle 88 — post-implementation): real dispatch + aged stamp + wipe + sweep => /health serves durable queueIntegrity RECONSTRUCTING; key-set 4->5', async () => {
      const { taskId } = await submitOperation('mm05c');
      // FLIPPED from the round-2 CONNECTIVITY characterization (this test used
      // to pin {status,db,redis,activeLeases} as the whole truth — the docs/31
      // "constant HEALTHY" stale phrase was corrected from that evidence). The
      // queue-integrity seam is LIVE now (docs/38 implemented; wipe->re-arm
      // proved end-to-end by p8-02c Round 7" — 5/5 x3, Tester 05:53).
      expect(await app!.dispatcher.dispatchOnce()).toBeGreaterThanOrEqual(1); // real dispatch stamps the row
      const row = (
        await app!.db.query<{ id: string }>(
          `SELECT id FROM outbox WHERE aggregate_id = $1 AND type = 'task.dispatch' ORDER BY dispatched_at DESC NULLS LAST LIMIT 1`,
          [taskId]
        )
      ).rows[0]!;
      // Past the 30s default grace without depending on the knob.
      await app!.db.query(`UPDATE outbox SET dispatched_at = now() - interval '5 minutes' WHERE id = $1`, [row.id]);
      await queue!.obliterate({ force: true }); // queue data lost before claim
      // The production wrapper is the ONLY writer of the health cache — drive it,
      // not the raw runtime seam (a raw call must not fake a durable signal).
      const swept = await app!.runQueueIntegritySweep();
      expect(swept.state).toBe('RECONSTRUCTING');
      const health = await http(baseUrl, '/health');
      expect(health.status).toBe(200); // D2: durable signal, no LB flap
      expect(health.body.status).toBe('ok');
      expect(Object.keys(health.body).sort()).toEqual(['activeLeases', 'db', 'queueIntegrity', 'redis', 'status']); // KEY-SET 4->5
      const qi = health.body.queueIntegrity as Record<string, unknown>;
      expect(qi.state).toBe('RECONSTRUCTING');
      expect(typeof qi.lastSweepAt).toBe('string');
      expect(qi.lastSweepAt).toBe(swept.lastSweepAt); // /health serves the cache
    }, 25_000);

    // ---------------------------------------------------------------------
    // MM-10 — production fault injection: same-epoch cancel race + recovery
    // ---------------------------------------------------------------------
    test('MM-10a: same-epoch complete AFTER cancel is rejected (terminal-state fence, not epoch bump); zero state flip', async () => {
      const { operationId, taskId } = await submitOperation('mm10a');
      const claim = await claimTask(taskId, 'w10a');
      const cancel = await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });
      expect([200, 202]).toContain(cancel.status);
      expect(cancel.body.state).toBe('CANCELLED');

      // In-flight race: SAME leaseEpoch as the last successful claim (no takeover
      // happened, so an epoch-only check would let this through — fencing must
      // honor the terminal state instead).
      const resultRef = 'artifact://mm10a-leak-attempt';
      const race = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { leaseEpoch: claim.leaseEpoch, resultRef, resultHash: contentHash(resultRef) },
      });
      expect([409, 410]).toContain(race.status);
      expect(['LEASE_LOST', 'TASK_TERMINAL']).toContain(String(race.body.code));

      const task = await app!.db.query<{ state: string; result_ref: string | null }>(
        'SELECT state, result_ref FROM tasks WHERE id = $1',
        [taskId]
      );
      expect(task.rows[0]!.state).toBe('CANCELLED');
      expect(task.rows[0]!.result_ref ?? null).toBeNull(); // no result leak post-cancel
    }, 25_000);

    test('MM-10b: same-epoch heartbeat AFTER cancel is rejected 410 TASK_TERMINAL (post R1-B patch; formerly the RUN-07 defect)', async () => {
      const { operationId, taskId } = await submitOperation('mm10b');
      const claim = await claimTask(taskId, 'w10b');
      await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });
      const before = await app!.db.query<{ e: Date | null }>(
        'SELECT lease_expires_at AS e FROM tasks WHERE id = $1',
        [taskId]
      );

      const hb = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/heartbeat`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: { leaseEpoch: claim.leaseEpoch },
      });
      // FLIPPED 2026-09-25 after the R1-B/MM-10b patch landed in
      // services/orchestrator/src/modules/runtime/runtime.ts:127-177
      // (epoch-stale -> 409 first, terminal-state -> 410 TASK_TERMINAL second,
      // belt-and-braces state guard on the UPDATE, real cancel_requested).
      // Pre-patch behavior this once pinned: 200 + lease extension on a
      // CANCELLED task (RUN-07 defect, W48 rounds 1-3).
      expect(hb.status).toBe(410);
      expect(hb.body.code).toBe('TASK_TERMINAL');

      const after = await app!.db.query<{ state: string; e: Date | null }>(
        'SELECT state, lease_expires_at AS e FROM tasks WHERE id = $1',
        [taskId]
      );
      expect(after.rows[0]!.state).toBe('CANCELLED'); // no resurrection
      expect(String(after.rows[0]!.e)).toBe(String(before.rows[0]!.e)); // lease NOT extended
      const leak = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: claim.leaseEpoch,
          resultRef: 'artifact://mm10b-after-hb',
          resultHash: contentHash('artifact://mm10b-after-hb'),
        },
      });
      expect([409, 410]).toContain(leak.status); // write fence still holds
    }, 25_000);

    test('MM-10c: system recovers after same-epoch rejections — a fresh submission claims and runs to completion', async () => {
      const poisoned = await submitOperation('mm10c-then-recover');
      const pClaim = await claimTask(poisoned.taskId, 'w10c-past');
      await http(baseUrl, `/api/v1/operations/${poisoned.operationId}/cancel`, {
        method: 'POST',
        headers: { 'x-api-key': API_KEY },
      });
      expect([409, 410]).toContain(
        (
          await http(baseUrl, `/api/runtime/v1/tasks/${poisoned.taskId}/complete`, {
            method: 'POST',
            headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
            body: {
              leaseEpoch: pClaim.leaseEpoch,
              resultRef: 'artifact://mm10c-stale',
              resultHash: contentHash('artifact://mm10c-stale'),
            },
          })
        ).status
      );

      const fresh = await submitOperation('mm10c-fresh');
      const freshClaim = await claimTask(fresh.taskId, 'w10c-fresh');
      expect(freshClaim.taskId).toBe(fresh.taskId);
      const done = await http(baseUrl, `/api/runtime/v1/tasks/${fresh.taskId}/complete`, {
        method: 'POST',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
        body: {
          leaseEpoch: freshClaim.leaseEpoch,
          resultRef: 'artifact://mm10c-ok',
          resultHash: contentHash('artifact://mm10c-ok'),
        },
      });
      expect(done.status).toBe(200);
      const task = await app!.db.query<{ state: string }>('SELECT state FROM tasks WHERE id = $1', [fresh.taskId]);
      expect(task.rows[0]!.state).toBe('SUCCEEDED');
    }, 25_000);
  }
);
