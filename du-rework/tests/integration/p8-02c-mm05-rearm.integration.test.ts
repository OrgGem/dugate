/**
 * P8-02c — MM-05 READY-rearm LIVE acceptance suite (prepared PRE-implementation).
 *
 * Owner: Qwen-2 functional-testing lane (term_4d79e7d3) — packet ORCHESTRATOR
 * CYCLE 78. Pins the acceptance contract of docs/38 (queue-integrity probe +
 * re-arm reconstruction) so that the moment Qwen-1 lands §7, one DB-window run
 * closes MM-05. New file only; touches NO existing suite. p8-02b stays as the
 * historical drill; when this suite goes green, ALSO flip p8-02b MM-05c key-set
 * (server.ts health adds `queueIntegrity`) — pinned in docs/38 §6.
 *
 * GATES (fleet rule — docs/35 §1.4, Qwen-2 never opens the DB window):
 *   DU_LIVE_INFRA=1   → file-level: live infra required, else whole file skips.
 *   DU_MM05_REARM=1   → test-level: set ONLY after Qwen-1 declares docs/38 §7
 *                       landed. Without it every test is it.skip ⇒ receipt shows
 *                       "N skipped" = [SKIP-QUALIFIED], never a pass claim, and
 *                       never a false-red that would pollute the ledger.
 *
 * PRECONDITIONS for the green run (Tester/DB-window):
 *   0. infra up:  docker compose -f infra/docker-compose.yml up -d   (PG :5433, Redis :6380)
 *   1. implementation on disk: runtime.sweepQueueIntegrity + /health queueIntegrity
 *   2. REBUILD DIST — this suite imports '@du/orchestrator' which resolves to
 *      dist/server.js; a stale dist silently serves the OLD runtime:
 *      cd services/orchestrator && npm run build
 *   3. from du-rework root:
 *      $env:DU_LIVE_INFRA='1'; $env:DU_MM05_REARM='1'; npx jest tests/integration/p8-02c-mm05-rearm.integration.test.ts --config tests/integration/jest.config.cjs --runInBand
 *   Expected: 5 passed / 5 total, 0 skipped, ExitCode 0.
 */
import { createHash, randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Queue } from 'bullmq';
import { createApp, type App } from '@du/orchestrator';
import { PgSqlClient } from '@du/connector';
import { BusinessManifestSchema, contentHash, jobIdForDelivery, type ClaimResult } from '@du/contracts';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  assertSafeIsolationConfig,
  type TestIsolationContext,
} from '../isolation/namespace';

const LIVE = process.env.DU_LIVE_INFRA === '1';
const REARM = process.env.DU_MM05_REARM === '1';
const describeLive = LIVE ? describe : describe.skip;
const testRearm = REARM ? test : test.skip;

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

const RUNTIME_TOKEN = `p802c-rt-${randomUUID()}`;
const ADMIN_TOKEN = `p802c-adm-${randomUUID()}`;
const USAGE_TOKEN = `p802c-usg-${randomUUID()}`;
const API_KEY = `du_test_${randomUUID().replace(/-/g, '')}`;
const TENANT_ID = '00000000-0000-0000-0000-000000000001';

const hashKey = (raw: string): string => createHash('sha256').update(raw).digest('hex');

const BUSINESS_ID = `p802c-rearm-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const BUSINESS_VERSION = '1.0.0';
const QUEUE_NAME = `du-business-${BUSINESS_ID}-${BUSINESS_VERSION}`;

const testManifest = BusinessManifestSchema.parse({
  contractVersion: '1',
  businessId: BUSINESS_ID,
  version: BUSINESS_VERSION,
  displayName: 'P8-02c MM-05 rearm drill',
  description: 'Synthetic Redis-wipe re-arm acceptance fixture (Qwen-2, cycle 78)',
  imageDigest: `sha256:${'d'.repeat(64)}`,
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

type QueueIntegritySweepResult = {
  candidates: number;
  rearmed: number;
  aliveSkipped: number;
  casSkipped: number;
  stalled: number;
  unconfirmed: number;
  stalledDeliveryIds: string[];
};

type QueueIntegrityHealth = {
  state: string;
  orphansLast: number;
  stalled: number;
  lastSweepAt: string;
};

interface P802cApp {
  runtime: {
    sweepQueueIntegrity?: (opts?: {
      graceMs?: number;
      limit?: number;
      maxAttempts?: number;
    }) => Promise<QueueIntegritySweepResult>;
  };
  runQueueIntegritySweep?: () => Promise<QueueIntegrityHealth>;
  queueIntegrityHealth?: () => QueueIntegrityHealth | undefined;
}

describeLive('P8-02c: MM-05 queue-wipe detection + READY re-arm (docs/38 acceptance)', () => {
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
      autoDispatch: false, // tests drive dispatcher.dispatchOnce() explicitly
      leaseRecoveryIntervalMs: 0, // no background sweeps — every re-arm is a test action
      autoMigrate: true,
    });
    await app.listen();
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
    queue = app.getQueue(QUEUE_NAME) as Queue;
    await app.db.query(
      `INSERT INTO tenants (id, name, state) VALUES ($1, 'tenant-p802c', 'ACTIVE') ON CONFLICT (id) DO NOTHING`,
      [TENANT_ID]
    );
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1, $2, $3, 'p802c', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
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

  // API drift fix (cycle 78 t2): pinned against the LANDED implementation —
  // runtime.sweepQueueIntegrity(opts) -> result object (runtime.ts:1015-1061,
  // defaults grace 30s / limit 50 / maxAttempts 10) and app.runQueueIntegritySweep
  // as the health-cache seam (server.ts:214-247, :381-382 "test seam parity").
  function p802c(): P802cApp {
    return app as unknown as P802cApp;
  }

  async function sweep(): Promise<QueueIntegritySweepResult> {
    const rt = p802c().runtime;
    // Message doubles as the routing signal: a red here is docs/38 §7 NOT landed
    // (or dist not rebuilt — precondition 2), NOT a Tester failure to report as
    // guard-order/infra noise.
    if (typeof rt.sweepQueueIntegrity !== 'function') {
      throw new Error('P8-02c: runtime.sweepQueueIntegrity missing — docs/38 §7 not landed OR orchestrator dist not rebuilt (precondition 2)');
    }
    // grace 1s: our aged-by-5-min rows are eligible regardless of config default.
    return rt.sweepQueueIntegrity({ graceMs: 1000 });
  }

  async function sweepHealth(): Promise<QueueIntegrityHealth> {
    const w = p802c().runQueueIntegritySweep;
    if (typeof w !== 'function') {
      throw new Error('P8-02c: app.runQueueIntegritySweep missing — health-cache seam (server.ts:381) not landed or dist stale');
    }
    return w();
  }

  async function submitOperation(payload: string): Promise<{ operationId: string; taskId: string }> {
    const res = await http(baseUrl, `/api/v1/businesses/${BUSINESS_ID}/actions/process`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
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

  /** Real dispatch path, then age the stamp past any grace so the candidate is
   *  detection-eligible without depending on QUEUE_INTEGRITY_GRACE_MS defaults.
   *
   *  DEFECT-CLASS NOTE (Round 7, cycle 85 — DO NOT "fix" this toward ms): the
   *  aging keeps PostgreSQL-native MICROsecond now() on purpose. node-pg parses
   *  timestamptz into millisecond-only JS Dates, so the re-arm CAS must compare
   *  date_trunc('millisecond') on both sides (runtime.ts QUEUE_INTEGRITY_REARM_SQL,
   *  hotfix after this suite caught rearmed=0 live). Truncating the AGE itself
   *  would hide that whole class from the live lane. */
  async function dispatchAndAge(taskId: string): Promise<{ outboxId: string; jobId: string }> {
    expect(await app!.dispatcher.dispatchOnce()).toBeGreaterThanOrEqual(1);
    const row = (
      await app!.db.query<{ id: string; delivery_id: string; dispatched_at: Date | null }>(
        `SELECT id, delivery_id, dispatched_at FROM outbox
         WHERE aggregate_id = $1 AND type = 'task.dispatch'
         ORDER BY dispatched_at DESC NULLS LAST LIMIT 1`,
        [taskId]
      )
    ).rows[0]!;
    expect(row.dispatched_at).not.toBeNull();
    await app!.db.query(`UPDATE outbox SET dispatched_at = now() - interval '5 minutes' WHERE id = $1`, [row.id]);
    return { outboxId: row.id, jobId: jobIdForDelivery(row.delivery_id) };
  }

  async function claimComplete(taskId: string, worker: string): Promise<void> {
    const res = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/claim`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { deliveryId: `del-${randomUUID()}`, workerInstanceId: worker, businessId: BUSINESS_ID },
    });
    expect(res.status).toBe(200);
    const claim = res.body as unknown as ClaimResult;
    const ref = `artifact://p802c-${taskId}`;
    const done = await http(baseUrl, `/api/runtime/v1/tasks/${taskId}/complete`, {
      method: 'POST',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: { leaseEpoch: claim.leaseEpoch, resultRef: ref, resultHash: contentHash(ref) },
    });
    expect(done.status).toBe(200);
  }

  testRearm('rearm-0 (meta): docs/38 §7 surface landed — runtime sweep + health-cache seams are functions', async () => {
    expect(typeof p802c().runtime.sweepQueueIntegrity).toBe('function');
    expect(typeof p802c().runQueueIntegritySweep).toBe('function');
    expect(typeof p802c().queueIntegrityHealth).toBe('function');
  }, 25_000);

  testRearm('rearm-1 (E2E): Redis wipe before claim → sweep re-arms → dispatcher republishes SAME jobId → claim+complete → SUCCEEDED, zero TIMED_OUT, zero duplicate job', async () => {
    const { operationId, taskId } = await submitOperation('rearm1');
    const { outboxId, jobId } = await dispatchAndAge(taskId);
    expect(await queue!.getJob(jobId)).toBeDefined(); // alive pre-wipe

    await queue!.obliterate({ force: true }); // Redis-side queue data gone
    expect(await queue!.getJob(jobId)).toBeUndefined();

    const r1 = await sweep();
    expect(r1.rearmed).toBeGreaterThanOrEqual(1); // §2 detection + §3 re-arm (CAS)
    // The re-arm SQL sets due_at = now() + 2^attempts backoff — pin past the
    // scheduler wait deterministically instead of sleeping on it.
    await app!.db.query(`UPDATE outbox SET due_at = now() - interval '1 second' WHERE id = $1`, [outboxId]);
    expect(await app!.dispatcher.dispatchOnce()).toBeGreaterThanOrEqual(1); // existing dispatcher republishes

    const revived = await queue!.getJob(jobId);
    expect(revived).toBeDefined();
    expect(revived!.id).toBe(jobId); // stable jobId: re-armed the SAME delivery (§3)

    await claimComplete(taskId, 'w-rearm1');
    const op = await app!.db.query<{ state: string }>('SELECT state FROM operations WHERE id = $1', [operationId]);
    expect(op.rows[0]!.state).toBe('SUCCEEDED'); // never needed the deadline escape hatch
    const dup = await app!.db.query<{ n: string }>('SELECT count(*)::int AS n FROM tasks WHERE operation_id = $1', [
      operationId,
    ]);
    expect(Number(dup.rows[0]!.n)).toBe(1); // zero duplicate rows
  }, 25_000);

  testRearm('rearm-2 (false-positive safety): aged row with LIVE job → sweep re-arms NOTHING; queue untouched', async () => {
    const { taskId } = await submitOperation('rearm2');
    const { jobId } = await dispatchAndAge(taskId);

    const r2 = await sweep();
    expect(r2.rearmed).toBe(0); // getJob alive ⇒ no re-arm (§2 confirm-on-Redis)
    expect(r2.aliveSkipped).toBeGreaterThanOrEqual(1); // our aged row was seen AND spared
    const still = await queue!.getJob(jobId);
    expect(still).toBeDefined();
    const stamped = await app!.db.query<{ n: string }>(
      `SELECT count(*)::int AS n FROM outbox WHERE aggregate_id = $1 AND dispatched_at IS NULL AND type = 'task.dispatch'`,
      [taskId]
    );
    expect(Number(stamped.rows[0]!.n)).toBe(0); // row not de-armed

    // HERMETIC CLEANUP (Round 7′ lesson, cycle 87): consume this task so its
    // aged row leaves the candidate scope. rearm-3/rearm-4 obliterate the WHOLE
    // business queue — if this job were still the only copy of a live READY
    // row, that later wipe would legitimately orphan it and a global rearmed
    // count in rearm-3 would be contaminated (r3.rearmed=1, Tester 7′).
    await claimComplete(taskId, 'w-rearm2');
  }, 25_000);

  testRearm('rearm-3 (terminal fence): wiped job under a CANCELLED operation is NOT resurrected', async () => {
    const { operationId, taskId } = await submitOperation('rearm3');
    const { outboxId, jobId } = await dispatchAndAge(taskId);
    await queue!.obliterate({ force: true });

    const cancel = await http(baseUrl, `/api/v1/operations/${operationId}/cancel`, {
      method: 'POST',
      headers: { 'x-api-key': API_KEY },
    });
    expect([200, 202]).toContain(cancel.status);
    expect(cancel.body.state).toBe('CANCELLED');

    const r3 = await sweep();
    // Global canary — 0 ONLY because rearm-1 SUCCEEDED and rearm-2 self-cleaned;
    // the per-row assertions below are the fence evidence proper.
    expect(r3.rearmed).toBe(0); // predicate excludes terminal ops (§2) — RUN-07 fence parity
    expect(await queue!.getJob(jobId)).toBeUndefined(); // nothing revived
    const stamp = await app!.db.query<{ dispatched_at: Date | null }>(
      'SELECT dispatched_at FROM outbox WHERE id = $1',
      [outboxId]
    );
    expect(stamp.rows[0]!.dispatched_at).not.toBeNull(); // row NOT de-armed
  }, 25_000);

  testRearm('rearm-4 (MM-05c durable health): /health gains queueIntegrity {state,lastSweepAt} reflecting the sweep', async () => {
    const { taskId } = await submitOperation('rearm4');
    await dispatchAndAge(taskId);
    await queue!.obliterate({ force: true });

    // The health cache is written ONLY by the production wrapper seam (never
    // fabricated by a raw runtime.sweepQueueIntegrity call) — drive the seam.
    const swept = await sweepHealth();
    // Deterministic after hermetic cleanup: first wrapper call (raw sweep() never
    // touches the server-side streak counter), the only aged candidate is this
    // test's own wiped row => rearmed=1, stalled=0, streak=1 => RECONSTRUCTING.
    expect(swept.state).toBe('RECONSTRUCTING');

    const health = await http(baseUrl, '/health');
    expect(health.status).toBe(200); // D2: even SUSPECT stays HTTP 200 — LB never flaps
    const qi = health.body.queueIntegrity as Record<string, unknown> | undefined;
    expect(qi).toBeDefined();
    expect(qi!.state).toBe('RECONSTRUCTING'); // the positive transition, served live
    expect(typeof qi!.lastSweepAt).toBe('string');
    expect(typeof qi!.orphansLast).toBe('number');
    expect(qi!.lastSweepAt).toBe(swept.lastSweepAt); // /health serves the cache just refreshed
    expect(health.body.status).toBe('ok'); // D2 truth-without-flapping: 200/ok while RECONSTRUCTING
    // When this line goes green, ALSO flip p8-02b MM-05c key-set (docs/38 §6).
  }, 25_000);
});
