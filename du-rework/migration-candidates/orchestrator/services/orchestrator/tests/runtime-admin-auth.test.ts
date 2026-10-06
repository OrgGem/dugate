/**
 * CONV-07: W29-C admin authorization negative tests — split out of runtime.test.ts.
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

const F = createRuntimeFixture({ suite: 'admin-auth' });
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

warnIfSkipped('runtime-admin-auth.test.ts');

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
  beforeAll(async () => {
    ({ app, baseUrl, queueName } = await F.setup());
  }, 120_000);

  afterAll(async () => {
    await F.teardown();
  }, 30_000);

/* ---------------- W29-C: Admin authorization negative tests ---------------- */

describe('W29-C: Admin authorization negative tests', () => {
  const BIZ = MANIFEST.businessId;
  const V1 = MANIFEST.version;

  // -- Unauthenticated: all admin routes reject 401 when no bearer token is sent --

  test('enable rejects missing admin auth (401)', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/enable`, {
      method: 'PUT',
      headers: {},
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('deactivate rejects missing admin auth (401)', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/deactivate`, {
      method: 'PUT',
      headers: {},
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  test('profile-bindings rejects missing admin auth (401)', async () => {
    const res = await http(baseUrl, '/api/v1/admin/profile-bindings', {
      method: 'POST',
      headers: {},
      body: { apiKey: `du_noauth_${randomUUID()}`, businessId: BIZ, businessVersion: V1, action: 'extract', connectorBindings: {} },
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  // -- Role substitution: runtime token does not grant admin access --

  test('enable rejects runtime token (401) — role substitution denied', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/enable`, {
      method: 'PUT',
      headers: rtHeaders(),
    });
    expect(res.status).toBe(401);
    expect(res.body.code).toBe('UNAUTHENTICATED');
  });

  // -- W29-C Fix 1: enable on non-existent version → 404 (not false 200) --

  test('enable on unregistered version → 404 NOT_FOUND (W29-C fix)', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/99.99.99/enable`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  // -- Cross-tenant operation isolation: cancel and resume fail-closed --

  test('cross-tenant cancel → 404 (no information leakage)', async () => {
    // Create an operation as the suite's API key (tenant 0000...01).
    const submit = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'w29-cancel-tenant' } },
    });
    expect(submit.status).toBe(202);
    const opId = submit.body.operationId as string;

    // Create an API key for a different tenant.
    const otherTenant = randomUUID();
    await app.db.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'w29-other') ON CONFLICT (id) DO NOTHING`,
      [otherTenant]
    );
    const otherRaw = `du_w29other_${randomUUID().replace(/-/g, '')}`;
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'w29o','ACTIVE') ON CONFLICT (hash) DO NOTHING`,
      [randomUUID(), otherTenant, hashKey(otherRaw)]
    );

    // Cross-tenant cancel must 404, not 403 or 200.
    const cancel = await http(baseUrl, `/api/v1/operations/${opId}/cancel`, {
      method: 'POST',
      headers: { 'x-api-key': otherRaw },
    });
    expect(cancel.status).toBe(404);
    expect(cancel.body.code).toBe('NOT_FOUND');

    // Cleanup the operation to avoid leaking into other suites.
    await app.db.query('DELETE FROM usage_events WHERE operation_id=$1', [opId]);
    const tasks = await app.db.query<{ id: string }>('SELECT id FROM tasks WHERE operation_id=$1', [opId]);
    const taskIds = tasks.rows.map((r) => r.id);
    if (taskIds.length) {
      await app.db.query('DELETE FROM outbox WHERE aggregate_id = ANY($1)', [taskIds]);
      await app.db.query('DELETE FROM tasks WHERE id = ANY($1)', [taskIds]);
    }
    await app.db.query('DELETE FROM submission_keys WHERE operation_id=$1', [opId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [opId]);
  });

  test('cross-tenant resume → 404 (no information leakage)', async () => {
    // Submit as suite's key; then create an operation for a second tenant
    // by direct insert (we need an operation that belongs to a different tenant).
    const otherTenant = randomUUID();
    await app.db.query(
      `INSERT INTO tenants (id, name) VALUES ($1, 'w29-resume-tenant') ON CONFLICT (id) DO NOTHING`,
      [otherTenant]
    );
    const otherRaw = `du_w29resume_${randomUUID().replace(/-/g, '')}`;
    const otherKeyId = randomUUID();
    await app.db.query(
      `INSERT INTO api_keys (id, tenant_id, hash, prefix, status)
       VALUES ($1,$2,$3,'w29r','ACTIVE') ON CONFLICT (hash) DO NOTHING`,
      [otherKeyId, otherTenant, hashKey(otherRaw)]
    );

    // Create an operation under the other tenant via direct DB insert.
    const opId = randomUUID();
    const rootTaskId = randomUUID();
    await app.db.query(
      `INSERT INTO operations
         (id, tenant_id, api_key_id, business_id, business_version, action, state, state_version, root_task_id, input_ref, correlation_id)
       VALUES ($1,$2,$3,$4,$5,'extract','RUNNING',1,$6,$7,$8)`,
      [opId, otherTenant, otherKeyId, BIZ, V1, rootTaskId, JSON.stringify({ q: 'w29-resume' }), randomUUID()]
    );
    await app.db.query(
      `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, due_at)
       VALUES ($1,$2,'root','root',$3,'WAITING_CHILDREN',0, now())`,
      [rootTaskId, opId, JSON.stringify({ q: 'w29-resume' })]
    );

    // The suite's own API key (tenant 0000...01) tries to resume — cross-tenant → 404.
    const resume = await http(baseUrl, `/api/v1/operations/${opId}/resume`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { waitId: randomUUID(), input: { ok: true }, expectedStateVersion: 1 },
    });
    expect(resume.status).toBe(404);
    expect(resume.body.code).toBe('NOT_FOUND');

    // Cleanup: the other tenant's operation + tasks.
    await app.db.query('DELETE FROM outbox WHERE aggregate_id=$1', [rootTaskId]);
    await app.db.query('DELETE FROM tasks WHERE id=$1', [rootTaskId]);
    await app.db.query('DELETE FROM operations WHERE id=$1', [opId]);
  });
});
});
