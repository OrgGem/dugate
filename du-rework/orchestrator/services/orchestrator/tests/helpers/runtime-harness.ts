/**
 * CONV-07: the explicit runtime live-suite fixture, extracted from the single
 * beforeAll/afterAll that used to serve every describe in runtime.test.ts.
 *
 * Every suite file gets its OWN fixture: a per-suite business id (so scoped
 * cleanup only ever deletes that suite's rows), its own isolation namespace
 * (schema / Redis DB / artifact dir via tests/isolation/namespace), its own
 * app instance on port 0, and no shared mutable singleton across files.
 * scopedCleanup has exactly ONE implementation — here.
 *
 * Window guard: every consuming suite wraps its describe in liveDescribe
 * (DU_LIVE_INFRA=1); without it nothing boots — no createApp, no listen.
 */
import { createHash, randomUUID } from 'node:crypto';
import { Queue } from 'bullmq';
import { createApp, type App } from '../../src/server';
import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  assertSafeIsolationConfig,
  type TestIsolationContext,
} from '../../../../../tests/isolation/namespace';

export const LIVE = process.env.DU_LIVE_INFRA === '1';
export const liveDescribe: typeof describe = LIVE ? describe : describe.skip;

export function warnIfSkipped(fileName: string): void {
  if (!LIVE) {
    console.warn(fileName + ': SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
  }
}

function buildManifest(businessId: string) {
  return {
    contractVersion: '1' as const,
    businessId,
    version: '1.0.0',
    displayName: 'Test Business',
    description: 'runtime slice fixture',
    imageDigest: 'sha256:aa',
    runtime: { wireVersion: '1' as const, handlerKinds: ['root'] },
    capabilities: { cancel: true, resume: true, parallel: true },
    actions: [
      {
        name: 'extract',
        displayName: 'Extract',
        description: 'Test action',
        inputSchema: {
          type: 'object',
          required: ['q'],
          properties: { q: { type: 'string', minLength: 1 } },
          additionalProperties: false,
        },
        outputSchema: { type: 'object' },
        profileSchema: { type: 'object' },
        connectorSlots: [{ name: 'reasoning', required: true, acceptedCapabilities: ['test-capability'] }],
        artifactPolicy: { minFiles: 0, maxFiles: 0 },
        capabilities: { cancel: true, resume: true },
        defaultLimits: { maxParallelTasks: 2 },
      },
    ],
  };
}

export type RuntimeManifest = ReturnType<typeof buildManifest>;
type HttpOptions = { method?: string; headers?: Record<string, string>; body?: unknown };
type HttpResponse = { status: number; body: Record<string, unknown>; headers: Record<string, string> };

export interface UsageEventInput {
  eventId: string;
  invocationId: string;
  operationId: string;
  taskId: string;
  units: { inputTokens: number; outputTokens: number; pages?: number };
  costMicrousd: number;
  currency: 'USD';
  measurement: 'measured' | 'estimated';
  occurredAt: string;
}

export interface RuntimeFixture {
  readonly MANIFEST: RuntimeManifest;
  readonly TENANT_ID: string;
  readonly DATABASE_URL: string;
  readonly REDIS_URL: string;
  readonly RAW_API_KEY: string;
  readonly RUNTIME_TOKEN: string;
  readonly WORKER_IDENTITY_TOKEN: string;
  readonly ADMIN_TOKEN: string;
  readonly USAGE_TOKEN: string;
  readonly GRANT_SECRET: string;
  setup(): Promise<{ app: App; baseUrl: string; queueName: string }>;
  teardown(): Promise<void>;
  http(base: string, path: string, opts?: HttpOptions): Promise<HttpResponse>;
  hashKey(raw: string): string;
  rtHeaders(): Record<string, string>;
  adminHeaders(): Record<string, string>;
  pubHeaders(extra?: Record<string, string>): Record<string, string>;
  usageHeaders(): Record<string, string>;
  findJobForOperation(operationId: string): Promise<{ taskId: string; deliveryId: string }>;
  createUsageTarget(label: string): Promise<{ operationId: string; taskId: string }>;
  usageEvent(
    target: { operationId: string; taskId: string },
    overrides?: Partial<{
      eventId: string;
      invocationId: string;
      units: { inputTokens: number; outputTokens: number; pages?: number };
      costMicrousd: number;
      measurement: 'measured' | 'estimated';
      occurredAt: string;
    }>,
  ): UsageEventInput;
}

export function createRuntimeFixture(options: { suite: string }): RuntimeFixture {
  const suite = options.suite.replace(/[^a-zA-Z0-9-]/g, '-').toLowerCase();

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
  // Per-suite namespace: a suite never shares a Redis DB with its siblings when
  // the isolation framework is active (REDIS_DB_INDEX stays operator-controlled).
  const REDIS_URL = process.env.REDIS_URL ?? (
    isolationCtx
      ? isolationCtx.getRedisUrl(BASE_REDIS_URL)
      : BASE_REDIS_URL
  );

  const RUNTIME_TOKEN = 'test-runtime-token-' + randomUUID();
  const WORKER_IDENTITY_TOKEN = 'test-worker-identity-token-' + randomUUID();
  const ADMIN_TOKEN = 'test-admin-token-' + randomUUID();
  const USAGE_TOKEN = 'test-usage-token-' + randomUUID();
  const GRANT_SECRET = 'test-grant-secret-' + randomUUID();
  const RAW_API_KEY = 'du_test_' + randomUUID().replace(/-/g, '');
  const TENANT_ID = '00000000-0000-0000-0000-000000000001';

  // Per-suite business id: scopedCleanup deletes ONLY rows of this business, so
  // two split files (even under a shared TEST_RUN_ID schema) cannot delete each
  // other's rows, versions or queues.
  const MANIFEST = buildManifest(
    (isolationCtx ? `test-biz-${isolationCtx.runId}` : 'test-biz') + '-' + suite,
  );
  MANIFEST.businessId = MANIFEST.businessId.toLowerCase().replace(/[^a-z0-9-]/g, '-');

  const state: { app?: App; baseUrl?: string; queueName?: string } = {};

  function hashKey(raw: string): string {
    return createHash('sha256').update(raw).digest('hex');
  }

  async function http(
    base: string,
    requestPath: string,
    opts: HttpOptions = {},
  ): Promise<HttpResponse> {
    const requestBody = requestPath.endsWith('/claim') && typeof opts.body === 'object' && opts.body !== null && !Array.isArray(opts.body)
      ? { businessId: MANIFEST.businessId, ...(opts.body as Record<string, unknown>) }
      : opts.body;
    const requestHeaders: Record<string, string> = { 'content-type': 'application/json', ...(opts.headers ?? {}) };
    if (requestPath.endsWith('/claim') && requestHeaders.authorization === `Bearer ${RUNTIME_TOKEN}`) {
      requestHeaders.authorization = `Bearer ${WORKER_IDENTITY_TOKEN}`;
    }
    const res = await fetch(`${base}${requestPath}`, {
      method: opts.method ?? 'GET',
      headers: requestHeaders,
      body: requestBody === undefined ? undefined : JSON.stringify(requestBody),
    });
    const responseText = await res.text();
    const responseBody: Record<string, unknown> = responseText ? (JSON.parse(responseText) as Record<string, unknown>) : {};
    const responseHeaders: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      responseHeaders[k] = v;
    });
    return { status: res.status, body: responseBody, headers: responseHeaders };
  }

  /**
   * W13-C test-DB isolation. Suites share PG :5433 / Redis :6380, so this
   * suite must never wipe another suite's rows: cleanup is scoped to this
   * suite's business_id/tenant, the Redis drain is scoped to this suite's
   * queue, and any cleanup refuses to run against a non-test database.
   * Interim policy: shared-DB suites still run serially (documented in the
   * Claude lane report); parallel compatibility is NOT certified.
   */
  function assertTestDatabase(): void {
    const dbName = new URL(DATABASE_URL).pathname.split('/').pop() ?? '.';
    if (!/test/i.test(dbName)) {
      throw new Error(
        `refusing test cleanup: DATABASE_URL database "${dbName}" does not look like a test database`,
      );
    }
    assertSafeIsolationConfig({
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      isolationCtx,
      allowUnsafeShared: process.env.ALLOW_UNSAFE_SHARED_DB === 'true',
    });
  }

  /** Delete only this suite's rows (E2E/other suites' business_versions survive). */
  async function scopedCleanup(): Promise<void> {
    assertTestDatabase();
    const app = state.app!;
    const biz = MANIFEST.businessId;
    const ops = await app.db.query<{ id: string }>('SELECT id FROM operations WHERE business_id=$1', [biz]);
    const opIds = ops.rows.map((r) => r.id);
    if (opIds.length > 0) {
      await app.db.query('DELETE FROM usage_events WHERE operation_id = ANY($1)', [opIds]);
      const tasks = await app.db.query<{ id: string }>('SELECT id FROM tasks WHERE operation_id = ANY($1)', [opIds]);
      const taskIds = tasks.rows.map((r) => r.id);
      if (taskIds.length > 0) {
        await app.db.query('DELETE FROM invocation_grants WHERE task_id = ANY($1)', [taskIds]);
        await app.db.query('DELETE FROM step_checkpoints WHERE task_id = ANY($1)', [taskIds]);
        await app.db.query('DELETE FROM artifacts WHERE task_id = ANY($1)', [taskIds]);
        await app.db.query('DELETE FROM human_waits WHERE task_id = ANY($1)', [taskIds]);
        await app.db.query(
          'DELETE FROM task_dependencies WHERE parent_id = ANY($1) OR child_id = ANY($1)',
          [taskIds],
        );
        await app.db.query('DELETE FROM outbox WHERE aggregate_id = ANY($1)', [taskIds]);
        await app.db.query('DELETE FROM tasks WHERE id = ANY($1)', [taskIds]);
      }
      // Submission keys point at operations (FK): delete this suite's keys by
      // operation before deleting the operations themselves.
      await app.db.query('DELETE FROM submission_keys WHERE operation_id = ANY($1)', [opIds]);
      // P2-08: webhook deliveries reference operations (FK).
      await app.db.query('DELETE FROM webhook_deliveries WHERE operation_id = ANY($1)', [opIds]);
      await app.db.query('DELETE FROM operations WHERE id = ANY($1)', [opIds]);
    }
    await app.db.query('DELETE FROM business_versions WHERE business_id=$1', [biz]);
  }

  async function setup(): Promise<{ app: App; baseUrl: string; queueName: string }> {
    if (isolationCtx) {
      const { Pool: AdminPool } = await import('pg');
      const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
      await adminPool.query(generateSchemaSetupDdl(isolationCtx.dbSchema));
      await adminPool.end();
    }

    const app = await createApp({
      port: 0,
      databaseUrl: DATABASE_URL,
      redisUrl: REDIS_URL,
      runtimeToken: RUNTIME_TOKEN,
      workerIdentityTokensByBusiness: { [MANIFEST.businessId]: WORKER_IDENTITY_TOKEN },
      adminToken: ADMIN_TOKEN,
      usageToken: USAGE_TOKEN,
      invocationGrantSecret: GRANT_SECRET,
      connectorId: 'test-connector',
      connectorRevision: 3,
      autoDispatch: false, // tests drive dispatchOnce() explicitly
      autoMigrate: true, // zero-config boot: apply pending migrations so the fixture schema is ready
    });
    // Seed an API key for RAW_API_KEY.
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'test', 'ACTIVE')
       ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
      [randomUUID(), TENANT_ID, hashKey(RAW_API_KEY)],
    );
    const server = await app.listen();
    const addr = server.address() as { port: number };
    const baseUrl = `http://127.0.0.1:${addr.port}`;
    state.app = app;
    state.baseUrl = baseUrl;
    // Scoped cleanup only (never global TRUNCATE / flushdb): other suites'
    // rows and queues on the shared infra survive this suite's setup.
    await scopedCleanup();
    // Drain only this suite's BullMQ queue (deterministic name for this
    // suite's business id); never flushdb() — E2E and integration suites own
    // their own queues.
    {
      const { Queue: Q } = await import('bullmq');
      const q = new Q(`du-business-${MANIFEST.businessId}-${MANIFEST.version}`, {
        connection: { url: REDIS_URL },
      });
      await q.obliterate({ force: true }).catch(() => undefined);
      await q.close().catch(() => undefined);
    }

    const reg = await http(baseUrl, `/api/runtime/v1/businesses/${MANIFEST.businessId}/versions/${MANIFEST.version}`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      body: MANIFEST,
    });
    expect([200, 201]).toContain(reg.status);
    await app.enableVersionForTest(MANIFEST.businessId, MANIFEST.version);
    const queueName = (reg.body.queue as string) ?? `du-business-${MANIFEST.businessId}-${MANIFEST.version}`;
    state.queueName = queueName;
    return { app, baseUrl, queueName };
  }

  async function teardown(): Promise<void> {
    await state.app?.close();
    if (isolationCtx && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const { Pool: AdminPool } = await import('pg');
      const adminPool = new AdminPool({ connectionString: BASE_DATABASE_URL });
      try {
        await adminPool.query(generateSchemaTeardownDdl(isolationCtx.dbSchema));
      } catch {
        // Ignore if already dropped
      } finally {
        await adminPool.end().catch(() => undefined);
      }
    }
    isolationCtx?.cleanupArtifactDir();
  }

  function rtHeaders(): Record<string, string> {
    return { authorization: `Bearer ${RUNTIME_TOKEN}` };
  }
  function adminHeaders(): Record<string, string> {
    return { authorization: `Bearer ${ADMIN_TOKEN}` };
  }
  function pubHeaders(extra: Record<string, string> = {}): Record<string, string> {
    return { 'x-api-key': RAW_API_KEY, ...extra };
  }
  function usageHeaders(): Record<string, string> {
    return { authorization: `Bearer ${USAGE_TOKEN}` };
  }

  async function findJobForOperation(
    operationId: string,
  ): Promise<{ taskId: string; deliveryId: string }> {
    const app = state.app!;
    const q = app.getQueue(state.queueName!) as Queue;
    const jobs = await q.getJobs(['waiting', 'delayed', 'active']);
    const job = jobs.find((j) => (j.data as { operationId?: string }).operationId === operationId);
    expect(job).toBeDefined();
    const payload = job!.data as { taskId: string; deliveryId: string };
    return { taskId: payload.taskId, deliveryId: payload.deliveryId };
  }

  async function createUsageTarget(label: string): Promise<{ operationId: string; taskId: string }> {
    const submit = await http(state.baseUrl!, `/api/v1/businesses/${MANIFEST.businessId}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: label } },
    });
    expect(submit.status).toBe(202);
    const operationId = submit.body.operationId as string;
    const operation = await state.app!.db.query<{ root_task_id: string }>(
      'SELECT root_task_id FROM operations WHERE id=$1',
      [operationId],
    );
    return { operationId, taskId: operation.rows[0]!.root_task_id };
  }

  function usageEvent(
    target: { operationId: string; taskId: string },
    overrides: Partial<{
      eventId: string;
      invocationId: string;
      units: { inputTokens: number; outputTokens: number; pages?: number };
      costMicrousd: number;
      measurement: 'measured' | 'estimated';
      occurredAt: string;
    }> = {},
  ): UsageEventInput {
    return {
      eventId: overrides.eventId ?? `usage-${randomUUID()}`,
      invocationId: overrides.invocationId ?? `invocation-${randomUUID()}`,
      operationId: target.operationId,
      taskId: target.taskId,
      units: overrides.units ?? { inputTokens: 3, outputTokens: 2 },
      costMicrousd: overrides.costMicrousd ?? 11,
      currency: 'USD' as const,
      measurement: overrides.measurement ?? ('measured' as const),
      occurredAt: overrides.occurredAt ?? new Date().toISOString(),
    };
  }

  return {
    MANIFEST,
    TENANT_ID,
    DATABASE_URL,
    REDIS_URL,
    RAW_API_KEY,
    RUNTIME_TOKEN,
    WORKER_IDENTITY_TOKEN,
    ADMIN_TOKEN,
    USAGE_TOKEN,
    GRANT_SECRET,
    setup,
    teardown,
    http,
    hashKey,
    rtHeaders,
    adminHeaders,
    pubHeaders,
    usageHeaders,
    findJobForOperation,
    createUsageTarget,
    usageEvent,
  };
}
