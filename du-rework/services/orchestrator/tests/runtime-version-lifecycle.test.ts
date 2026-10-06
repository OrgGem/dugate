/**
 * CONV-07: W28-C version activation / drain / rollback — split out of runtime.test.ts.
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

const F = createRuntimeFixture({ suite: 'version' });
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

warnIfSkipped('runtime-version-lifecycle.test.ts');

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
  beforeAll(async () => {
    ({ app, baseUrl, queueName } = await F.setup());
  }, 120_000);

  afterAll(async () => {
    await F.teardown();
  }, 30_000);

/* ---------------- W28-C: version activation / drain / rollback ---------------- */

describe('W28-C: version activation / drain / rollback', () => {
  const BIZ = MANIFEST.businessId;
  const V1 = MANIFEST.version;
  const V2 = '2.0.0';
  const V2_QUEUE = `du-business-${BIZ}-${V2}`;

  // A manifest for v2 — same actions, different version.
  const MANIFEST_V2 = { ...MANIFEST, version: V2 };

  let v2Created = false;

  async function registerV2() {
    if (v2Created) return;
    // Register v2 via direct DB insert (avoids going through the public register
    // endpoint, which requires a full manifest shape).
    await app.db.query(
      `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue, is_active)
       VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5, false)
       ON CONFLICT (business_id, version) DO NOTHING`,
      [BIZ, V2, JSON.stringify(MANIFEST_V2), 'sha256:bb', V2_QUEUE]
    );
    v2Created = true;
  }

  beforeAll(async () => {
    await registerV2();
    // Drain the v2 BullMQ queue so leftover jobs don't leak across tests.
    const { Queue: Q } = await import('bullmq');
    const q = new Q(V2_QUEUE, { connection: { url: REDIS_URL } });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  });

  afterAll(async () => {
    // Restore v1 as the only active+enabled version.
    await app.enableVersionForTest(BIZ, V1);
    // Remove v2 row so it doesn't leak into other test suites.
    await app.db.query('DELETE FROM business_versions WHERE business_id=$1 AND version=$2', [BIZ, V2]);
    const { Queue: Q } = await import('bullmq');
    const q = new Q(V2_QUEUE, { connection: { url: REDIS_URL } });
    await q.obliterate({ force: true }).catch(() => undefined);
    await q.close();
  });

  test('activate v2: new submissions select v2, in-flight v1 stays pinned', async () => {
    // 1. Submit against v1 (which is still active from beforeAll).
    const subV1 = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'v1-inflight' } },
    });
    expect(subV1.status).toBe(202);
    const opV1 = subV1.body.operationId as string;
    const opV1Row = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1', [opV1]
    );
    expect(opV1Row.rows[0]!.business_version).toBe(V1);

    // 2. Enable + activate v2.
    const en = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/enable`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(en.status).toBe(200);
    const act = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(act.status).toBe(202);
    expect(act.body.active).toBe(true);

    // 3. New submission now goes to v2.
    const subV2 = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'v2-new' } },
    });
    expect(subV2.status).toBe(202);
    const opV2 = subV2.body.operationId as string;
    const opV2Row = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1', [opV2]
    );
    expect(opV2Row.rows[0]!.business_version).toBe(V2);

    // 4. The old v1 operation is still pinned to v1.
    const v1Check = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1', [opV1]
    );
    expect(v1Check.rows[0]!.business_version).toBe(V1);
  });

  test('activate v1 rollback: re-activating v1 redirects new submissions back to v1', async () => {
    // v2 is currently active; activate v1 to roll back.
    const act = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(act.status).toBe(202);
    expect(act.body.active).toBe(true);

    const sub = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'rollback-v1' } },
    });
    expect(sub.status).toBe(202);
    const row = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1',
      [sub.body.operationId as string]
    );
    expect(row.rows[0]!.business_version).toBe(V1);
  });

  test('drain v2: fail-closed when sole active version is drained; explicit re-activate restores', async () => {
    // 1. Make v2 the sole active version (v1 gets implicitly deactivated).
    await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });

    // 2. Deactivate v2 (drain). v2 stays ENABLED but is no longer active.
    const deact = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/deactivate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(deact.status).toBe(202);
    expect(deact.body.active).toBe(false);

    // v2 is still ENABLED in the registry.
    const v2Row = await app.db.query<{ status: string }>(
      'SELECT status FROM business_versions WHERE business_id=$1 AND version=$2',
      [BIZ, V2]
    );
    expect(v2Row.rows[0]!.status).toBe('ENABLED');

    // 3. No active version — new submissions fail closed (W28-C review fix).
    // The drained version is NOT silently re-selected by a "newest ENABLED"
    // heuristic; this is the exact W27-A Case 10 gap.
    const blocked = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'should-fail' } },
    });
    expect(blocked.status).toBe(404);
    expect(blocked.body.code).toBe('NOT_FOUND');

    // 4. Activating v1 restores submissions.
    const act = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(act.status).toBe(202);
    expect(act.body.active).toBe(true);

    const sub = await http(baseUrl, `/api/v1/businesses/${BIZ}/actions/extract`, {
      method: 'POST',
      headers: pubHeaders(),
      body: { input: { q: 'drained-then-restored' } },
    });
    expect(sub.status).toBe(202);
    const row = await app.db.query<{ business_version: string }>(
      'SELECT business_version FROM operations WHERE id=$1',
      [sub.body.operationId as string]
    );
    expect(row.rows[0]!.business_version).toBe(V1);
  });

  test('activate invalid version → 404', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/99.99.99/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });

  test('activate rejects missing admin auth (401)', async () => {
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: {},
    });
    expect(res.status).toBe(401);
  });

  test('concurrent activate(v2) and activate(v1) resolve without deadlock (W28-C review item 3)', async () => {
    // Pre-condition: v1 active (from previous drain-test restore step).
    // Fire two concurrent activates for different versions — each must lock ALL
    // business_versions rows in deterministic (version ASC) order first, so
    // one wins and the other waits (no deadlock → no 500).
    const [resA, resB] = await Promise.all([
      http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V2}/activate`, {
        method: 'PUT',
        headers: adminHeaders(),
      }),
      http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
        method: 'PUT',
        headers: adminHeaders(),
      }),
    ]);
    // Neither is a 500 (deadlock would show up as 500 or a PG abort).
    expect(resA.status).not.toBe(500);
    expect(resB.status).not.toBe(500);
    // Both are valid results (200 replay or 202).
    expect([200, 202]).toContain(resA.status);
    expect([200, 202]).toContain(resB.status);

    // Exactly one version is active — the partial unique index held.
    const activeCount = await app.db.query<{ n: string }>(
      "SELECT count(*)::text AS n FROM business_versions WHERE business_id=$1 AND is_active = true",
      [BIZ],
    );
    expect(Number(activeCount.rows[0]!.n)).toBe(1);

    // Whichever won the race, the final active version is a valid choice.
    const activeRow = await app.db.query<{ version: string }>(
      'SELECT version FROM business_versions WHERE business_id=$1 AND is_active = true',
      [BIZ],
    );
    expect([V1, V2]).toContain(activeRow.rows[0]!.version);
  });

  test('activate is idempotent: re-activating the active version returns 200 replayed', async () => {
    // Ensure v1 is active, then re-activate it — should be 200 replayed.
    await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    const res = await http(baseUrl, `/api/v1/admin/businesses/${BIZ}/versions/${V1}/activate`, {
      method: 'PUT',
      headers: adminHeaders(),
    });
    expect(res.status).toBe(200);
    expect(res.body.replayed).toBe(true);
    expect(res.body.active).toBe(true);
  });
});
});
