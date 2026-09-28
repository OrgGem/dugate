import { createHash, randomUUID } from 'node:crypto';
import { createApp, type App } from '../src/server';

/**
 * R24-01 regression: tenant-scoped P2 public operation lookup + `?wait=`
 * long-poll, over real HTTP against createApp (real PG/Redis).
 *
 * The fault: `GET /api/v1/operations/:id` ran `waitForTerminal` with a
 * tenant-blind read and compared `tenant_id` only AFTER the poll, so a
 * foreign RUNNING id returned a DELAYED 404 (timing oracle + wasted DB
 * polling) while a foreign terminal id 404'd promptly.
 *
 * The fix: `getTenantOperation` scopes every read (`WHERE id=$1 AND
 * tenant_id=$2`) — pre-poll and each 500 ms in-poll re-read.
 *
 * Acceptance:
 *  1. foreign TERMINAL id + ?wait=30 → prompt 404 (no 30 s wait);
 *  2. foreign ACTIVE id + ?wait=10 → prompt 404 (no 10 s wait);
 *  3. ownership flip mid-poll (tenant changes while ?wait= pending) → 404,
 *     proving the fence is re-checked per iteration, not once at the end;
 *  4. authorized long-poll still reaches completion (owner flips to
 *     SUCCEEDED mid-poll → 200 with terminal view).
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const RUNTIME_TOKEN = 'r24-runtime-' + randomUUID();
const ADMIN_TOKEN = 'r24-admin-' + randomUUID();
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const RAW_KEY_A = 'du_r24_' + randomUUID().replace(/-/g, '');
const BIZ = 'r24-biz';

function hashKey(raw: string): string {
  return createHash('sha256').update(raw).digest('hex');
}

function assertTestDatabase(): void {
  const dbName = new URL(DATABASE_URL).pathname.split('/').pop() ?? '.';
  if (!/test/i.test(dbName)) {
    throw new Error(`refusing test cleanup: DATABASE_URL database "${dbName}" is not a test database`);
  }
}

async function http(
  base: string,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: unknown } = {}
): Promise<{ status: number; body: Record<string, unknown>; ms: number }> {
  const t0 = Date.now();
  const res = await fetch(`${base}${path}`, {
    method: opts.method ?? 'GET',
    headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? (JSON.parse(text) as Record<string, unknown>) : {}, ms: Date.now() - t0 };
}

let app: App;
let baseUrl: string;

async function seedOperation(tenantId: string, state: string): Promise<string> {
  const op = await app.db.query<{ id: string }>(
    `INSERT INTO operations (tenant_id, business_id, business_version, action, correlation_id, input_ref, state)
     VALUES ($1,$2,'1.0.0','extract',$3,'{}'::jsonb,$4) RETURNING id`,
    [tenantId, BIZ, `r24-${randomUUID()}`, state]
  );
  return op.rows[0]!.id;
}

async function scopedCleanup(): Promise<void> {
  assertTestDatabase();
  const ops = await app.db.query<{ id: string }>(
    'SELECT id FROM operations WHERE business_id=$1',
    [BIZ]
  );
  const opIds = ops.rows.map((r) => r.id);
  if (opIds.length > 0) {
    await app.db.query('DELETE FROM usage_events WHERE operation_id = ANY($1)', [opIds]).catch(() => undefined);
    const tasks = await app.db.query<{ id: string }>('SELECT id FROM tasks WHERE operation_id = ANY($1)', [opIds]);
    const taskIds = tasks.rows.map((r) => r.id);
    if (taskIds.length > 0) {
      await app.db.query('DELETE FROM invocation_grants WHERE task_id = ANY($1)', [taskIds]).catch(() => undefined);
      await app.db.query('DELETE FROM step_checkpoints WHERE task_id = ANY($1)', [taskIds]).catch(() => undefined);
      await app.db.query('DELETE FROM outbox WHERE aggregate_id = ANY($1)', [taskIds]).catch(() => undefined);
      await app.db.query('DELETE FROM tasks WHERE id = ANY($1)', [taskIds]);
    }
    await app.db.query('DELETE FROM submission_keys WHERE operation_id = ANY($1)', [opIds]).catch(() => undefined);
    await app.db.query('DELETE FROM webhook_deliveries WHERE operation_id = ANY($1)', [opIds]).catch(() => undefined);
    await app.db.query('DELETE FROM operations WHERE id = ANY($1)', [opIds]);
  }
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('operation-tenant-fence.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    runtimeToken: RUNTIME_TOKEN,
    adminToken: ADMIN_TOKEN,
    autoDispatch: false,
    autoMigrate: true,
  });
  await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1,'r24-a'),($2,'r24-b') ON CONFLICT (id) DO NOTHING`, [
    TENANT_A,
    TENANT_B,
  ]);
  await app.db.query(
    `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
     VALUES ($1,$2,$3,'r24','ACTIVE') ON CONFLICT (hash) DO UPDATE SET status='ACTIVE'`,
    [randomUUID(), TENANT_A, hashKey(RAW_KEY_A)]
  );
  const server = await app.listen();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  await scopedCleanup();
}, 120_000);

afterEach(async () => {
  await scopedCleanup();
}, 30_000);

afterAll(async () => {
  await scopedCleanup().catch(() => undefined);
  // W42-C5-D(2): opt out of the 30s production grace drain — drain() counts
  // RUNNING rows server-wide, so another lane's in-flight row would hold
  // close() past the hook timeout.
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
}, 30_000);

function keyHeaders(): Record<string, string> {
  return { 'x-api-key': RAW_KEY_A };
}

describe('R24-01: tenant-scoped operation lookup + long-poll (real HTTP)', () => {
  test('foreign TERMINAL id with ?wait=30 returns prompt 404 (no full wait)', async () => {
    const foreignId = await seedOperation(TENANT_B, 'SUCCEEDED');
    const res = await http(baseUrl, `/api/v1/operations/${foreignId}?wait=30`, { headers: keyHeaders() });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.ms).toBeLessThan(5000); // proves no 30 s poll happened
  });

  test('foreign ACTIVE id with ?wait=10 returns prompt 404 (no timing leak, no polling)', async () => {
    const foreignId = await seedOperation(TENANT_B, 'RUNNING');
    const res = await http(baseUrl, `/api/v1/operations/${foreignId}?wait=10`, { headers: keyHeaders() });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.ms).toBeLessThan(5000); // pre-fix this took the full 10 s
  });

  test('ownership flip mid-poll: operation changing hands during ?wait= returns 404', async () => {
    const ownId = await seedOperation(TENANT_A, 'RUNNING');
    const pending = http(baseUrl, `/api/v1/operations/${ownId}?wait=10`, { headers: keyHeaders() });
    // Let the poll start, then move the operation to the foreign tenant
    // (cancel/reassign race). The next 500 ms re-read must re-fence.
    await new Promise((r) => setTimeout(r, 1000));
    await app.db.query('UPDATE operations SET tenant_id=$1 WHERE id=$2', [TENANT_B, ownId]);
    const res = await pending;
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
    expect(res.ms).toBeLessThan(8000); // flip at ~1s + one poll iteration, not the full 10 s
  });

  test('authorized long-poll still reaches completion (owner sees terminal view)', async () => {
    const ownId = await seedOperation(TENANT_A, 'RUNNING');
    const pending = http(baseUrl, `/api/v1/operations/${ownId}?wait=10`, { headers: keyHeaders() });
    await new Promise((r) => setTimeout(r, 1000));
    await app.db.query(`UPDATE operations SET state='SUCCEEDED', state_version = state_version + 1 WHERE id=$1`, [
      ownId,
    ]);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('SUCCEEDED');
    expect(res.body.id).toBe(ownId);
  });
});
});
