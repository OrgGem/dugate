/**
 * W47-C1: read-only workspace-reference lookup (ART-02 sweeper guard).
 * Boots the REAL `createApp` against live PG :5433 / Redis :6380 —
 * same window discipline as the other live suites (RUN REQUEST to the
 * testing lane; this lane never self-runs live suites).
 *
 * - checkpoint-referenced workspace (a RUNNING task under the tenant)
 *   → `referenced: true`, `activeHolders >= 1`
 * - unreferenced tenant (no rows at all) → `referenced: false`, `activeHolders: 0`
 * - terminal task (SUCCEEDED) → `referenced: false`
 * - missing/invalid params → 422 INVALID_SCHEMA; bad bearer → 401
 */
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const RUNTIME_TOKEN = 'wsref-rt-' + randomUUID();
const ADMIN_TOKEN = 'wsref-adm-' + randomUUID();
const ACTIVE_TENANT = randomUUID();
const EMPTY_TENANT = randomUUID();
const DONE_TENANT = randomUUID();

let app: App;
let baseUrl: string;

function rtHeaders(): Record<string, string> {
  return { authorization: `Bearer ${RUNTIME_TOKEN}` };
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('workspace-reference.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    adminToken: ADMIN_TOKEN,
    runtimeToken: RUNTIME_TOKEN,
    autoDispatch: false,
    autoMigrate: true,
  });
  const srv = await app.listen();
  baseUrl = `http://127.0.0.1:${(srv.address() as AddressInfo).port}`;

  // ACTIVE tenant: one RUNNING operation + RUNNING task.
  await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1, 'wsref-active')`, [ACTIVE_TENANT]);
  const op = await app.db.query<{ id: string }>(
    `INSERT INTO operations (tenant_id, business_id, business_version, action, state, correlation_id)
     VALUES ($1, 'wsref-biz', '1.0.0', 'extract', 'RUNNING', $2) RETURNING id`,
    [ACTIVE_TENANT, 'wsref-' + randomUUID()]
  );
  const opId = op.rows[0]!.id;
  await app.db.query(
    `INSERT INTO tasks (operation_id, task_key, kind, payload_ref, state)
     VALUES ($1, 'root', 'root', '{}', 'RUNNING')`,
    [opId]
  );

  // DONE tenant: SUCCEEDED operation + SUCCEEDED task (terminal, no reference).
  await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1, 'wsref-done')`, [DONE_TENANT]);
  const doneOp = await app.db.query<{ id: string }>(
    `INSERT INTO operations (tenant_id, business_id, business_version, action, state, correlation_id)
     VALUES ($1, 'wsref-biz', '1.0.0', 'extract', 'SUCCEEDED', $2) RETURNING id`,
    [DONE_TENANT, 'wsref-' + randomUUID()]
  );
  await app.db.query(
    `INSERT INTO tasks (operation_id, task_key, kind, payload_ref, state)
     VALUES ($1, 'root', 'root', '{}', 'SUCCEEDED')`,
    [doneOp.rows[0]!.id]
  );

  // EMPTY tenant: no operations/tasks at all.
  await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1, 'wsref-empty')`, [EMPTY_TENANT]);
}, 120_000);

afterAll(async () => {
  if (app) {
    // Scoped cleanup: this suite's three tenants only.
    for (const t of [ACTIVE_TENANT, DONE_TENANT, EMPTY_TENANT]) {
      const ops = await app.db
        .query<{ id: string }>('SELECT id FROM operations WHERE tenant_id=$1', [t])
        .catch(() => ({ rows: [] as { id: string }[] }));
      const opIds = ops.rows.map((r) => r.id);
      if (opIds.length > 0) {
        const tasks = await app.db.query<{ id: string }>(
          'SELECT id FROM tasks WHERE operation_id = ANY($1)',
          [opIds]
        );
        const taskIds = tasks.rows.map((r) => r.id);
        if (taskIds.length > 0) {
          await app.db.query('DELETE FROM step_checkpoints WHERE task_id = ANY($1)', [taskIds]).catch(() => {});
          await app.db.query('DELETE FROM tasks WHERE id = ANY($1)', [taskIds]).catch(() => {});
        }
        await app.db.query('DELETE FROM operations WHERE id = ANY($1)', [opIds]).catch(() => {});
      }
      await app.db.query('DELETE FROM tenants WHERE id=$1', [t]).catch(() => {});
    }
    await app.close();
  }
}, 60_000);

describe('W47-C1: GET /api/runtime/v1/workspace-reference', () => {
  it('referenced workspace (RUNNING task) returns referenced true', async () => {
    const res = await fetch(
      `${baseUrl}/api/runtime/v1/workspace-reference?workspacePath=${encodeURIComponent('/tmp/du-worker-abc-123')}&tenantId=${ACTIVE_TENANT}`,
      { headers: rtHeaders() }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      workspacePath: string;
      tenantId: string;
      referenced: boolean;
      activeHolders: number;
    };
    expect(body.workspacePath).toBe('/tmp/du-worker-abc-123');
    expect(body.tenantId).toBe(ACTIVE_TENANT);
    expect(body.referenced).toBe(true);
    expect(body.activeHolders).toBeGreaterThanOrEqual(1);
  });

  it('unreferenced tenant returns referenced false', async () => {
    const res = await fetch(
      `${baseUrl}/api/runtime/v1/workspace-reference?workspacePath=${encodeURIComponent('/tmp/du-worker-orphan-9')}&tenantId=${EMPTY_TENANT}`,
      { headers: rtHeaders() }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { referenced: boolean; activeHolders: number };
    expect(body.referenced).toBe(false);
    expect(body.activeHolders).toBe(0);
  });

  it('terminal-only tenant returns referenced false', async () => {
    const res = await fetch(
      `${baseUrl}/api/runtime/v1/workspace-reference?workspacePath=${encodeURIComponent('/tmp/du-worker-done-1')}&tenantId=${DONE_TENANT}`,
      { headers: rtHeaders() }
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { referenced: boolean; activeHolders: number };
    expect(body.referenced).toBe(false);
    expect(body.activeHolders).toBe(0);
  });

  it('missing params 422, bad bearer 401', async () => {
    const noParam = await fetch(
      `${baseUrl}/api/runtime/v1/workspace-reference?tenantId=${ACTIVE_TENANT}`,
      { headers: rtHeaders() }
    );
    expect(noParam.status).toBe(422);

    const badTenant = await fetch(
      `${baseUrl}/api/runtime/v1/workspace-reference?workspacePath=x&tenantId=not-a-uuid`,
      { headers: rtHeaders() }
    );
    expect(badTenant.status).toBe(422);

    const noAuth = await fetch(
      `${baseUrl}/api/runtime/v1/workspace-reference?workspacePath=x&tenantId=${ACTIVE_TENANT}`
    );
    expect(noAuth.status).toBe(401);
  });
});
});
