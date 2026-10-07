/**
 * RR-Q3-4 LIVE proof for the FIX-CR-02 ownership fence + graceful release on REAL
 * PostgreSQL/Redis — QWEN-3 BUGFIX lane. NEVER self-run by this lane; the Tester
 * executes it inside the MM-13 DB window (CLAIM/RELEASE in reports/antigravity-6.md).
 *
 * CYCLE-108-113 FIX (root cause of the 0/2 Tester failure, tester.md:3181-3228):
 * the original fixture pointed destination_url at 'http://fence.live.test/…'. A fake
 * hostname makes deliverWebhooks' REAL destination adjudication ENOTFOUND → the row
 * takes the DESTINATION_UNRESOLVED RETRY path (PENDING, attempt consumed) BEFORE any
 * fetchFn runs — product correct, fixture wrong. The rewrite dials REAL loopback
 * listeners via IP literals with the documented local-mesh opt-in
 * (allowPrivateNetworks: true): no DNS is ever consulted, A's in-flight is a HUNG
 * SOCKET (hangForever), B's success is a deterministic 200.
 *
 * What only real PG proves (the reason this RR exists):
 *  - next_at::text / $2::timestamptz microsecond round-trip (the cycle-100 class of bug);
 *  - the due-predicate re-claims an EXPIRED DISPATCHING row under a live FOR UPDATE race;
 *  - graceful release lands and the row is immediately sweep-able.
 *
 * WINDOW GUARD (orchestrator request 2026-09-25, reviewer Finding 4): the suite
 * SELF-SKIPS unless DU_LIVE_INFRA=1 — the fleet's existing live-gate convention
 * (p8-02b/p8-02c/sec-int-01). Only Tester-1 sets the variable, and only inside an
 * OPENED MM-13 DB window. A lane that runs `pnpm test`/jest directly therefore can
 * NEVER touch the shared PG through this file; skipped is visibly skipped (fleet
 * rule: SKIP is never counted as PASS).
 *
 * Run (Tester, inside window):
 *   set DU_LIVE_INFRA=1 && npx jest tests/webhook-reclaim-fence.live.test.ts --runInBand
 */
const LIVE = process.env.DU_LIVE_INFRA === '1';
import { randomUUID } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../src/server';
import { deliverWebhooks } from '../src/modules/webhooks/webhooks';
import { BoundaryListener } from '../../../../tests/harness/network-boundaries/mock-listener';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const ADMIN_TOKEN = 'fence-admin-' + randomUUID();
const RUNTIME_TOKEN = 'fence-rt-' + randomUUID();
const SECRET = 'whsec-fence-' + randomUUID();
const TENANT = '00000000-0000-0000-0000-000000000001'; // seeded by createApp

let app: App;
const listeners: BoundaryListener[] = [];
const createdDeliveries: string[] = [];
const createdOperations: string[] = [];

const liveDescribe = LIVE ? describe : describe.skip;

if (!LIVE) {
  console.warn('webhook-reclaim-fence.live: SKIPPED — set DU_LIVE_INFRA=1 inside an open DB window to run (Tester-1 only).');
}

async function startListener(): Promise<BoundaryListener> {
  const l = await BoundaryListener.start();
  listeners.push(l);
  return l;
}
const mesh = { secret: SECRET, allowPrivateNetworks: true } as const;


async function seedDelivery(destinationUrl: string, maxAttempts = 5): Promise<string> {
  const operationId = randomUUID();
  const deliveryId = randomUUID();
  createdOperations.push(operationId);
  createdDeliveries.push(deliveryId);
  await app.db.query(
    `INSERT INTO operations (id, tenant_id, business_id, business_version, action, state, state_version, correlation_id)
     VALUES ($1,$2,'rr-q3-4','1','ingest','SUCCEEDED',1,$3)`,
    [operationId, TENANT, 'corr-' + operationId]
  );
  await app.db.query(
    `INSERT INTO webhook_deliveries (delivery_id, operation_id, tenant_id, event_type, terminal_state,
        state_version, destination_url, payload, status, attempts, max_attempts, next_at)
     VALUES ($1,$2,$3,'operation.succeeded','SUCCEEDED',1,$4,$5::jsonb,'PENDING',0,$6,now())`,
    [
      deliveryId,
      operationId,
      TENANT,
      destinationUrl,
      JSON.stringify({ deliveryId, eventType: 'operation.succeeded', operationId, state: 'SUCCEEDED', stateVersion: 1, occurredAt: new Date().toISOString() }),
      maxAttempts,
    ]
  );
  return deliveryId;
}

async function readRow(deliveryId: string) {
  const res = await app.db.query<{ status: string; attempts: number; last_error: string | null }>(
    'SELECT status, attempts, last_error FROM webhook_deliveries WHERE delivery_id=$1',
    [deliveryId]
  );
  return res.rows[0] as { status: string; attempts: number; last_error: string | null };
}

async function waitStatus(deliveryId: string, want: string, ms = 8000): Promise<void> {
  for (let w = 0; w < ms; w += 50) {
    if ((await readRow(deliveryId)).status === want) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('row ' + deliveryId + ' never reached ' + want);
}

liveDescribe('RR-Q3-4 live - reclaim generation fence + graceful release (real PG, loopback mesh)', () => {
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
    await app.listen();
  }, 60_000);

  afterAll(async () => {
    while (listeners.length > 0) {
      const l = listeners.pop();
      if (l) await l.stop().catch(() => undefined);
    }
    if (app) {
      if (createdDeliveries.length > 0) {
        await app.db.query('DELETE FROM webhook_deliveries WHERE delivery_id = ANY($1)', [createdDeliveries]);
      }
      if (createdOperations.length > 0) {
        await app.db.query('DELETE FROM operations WHERE id = ANY($1)', [createdOperations]);
      }
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 });
    }
  }, 60_000);

  it('stale claimant A cannot clobber re-claimer B (RETURNING next_at fence over the wire)', async () => {
    const hungListener = await startListener();
    hungListener.setDefault({ kind: 'hangForever' }); // A's socket stays open = A genuinely in-flight
    const deliveryId = await seedDelivery(hungListener.url('/hook'));

    const sweepA = deliverWebhooks(app.db, { ...mesh, claimLeaseMs: 1500 });
    await waitStatus(deliveryId, 'DISPATCHING');
    expect(hungListener.requests).toBeGreaterThanOrEqual(1); // A really dialled — no adjudication shortcut
    const aLease = (await app.db.query<{ next_at: string }>(
      'SELECT next_at::text AS next_at FROM webhook_deliveries WHERE delivery_id=$1', [deliveryId]
    )).rows[0]!.next_at;

    // Lease lapses; B re-claims the expired DISPATCHING row (due-predicate on real PG) and delivers
    // deterministically via an injected success (B's fetchFn is a seam, not a socket).
    await new Promise((r) => setTimeout(r, 1800));
    const attemptedB = await deliverWebhooks(app.db, { ...mesh, claimLeaseMs: 60_000, fetchFn: async () => ({ status: 200 }) });
    expect(attemptedB).toBe(1);
    expect((await readRow(deliveryId)).status).toBe('DELIVERED');
    expect((await readRow(deliveryId)).attempts).toBe(1);

    // A's hung socket is released only now — its late FAILED release must lose on the fence.
    await hungListener.stop();
    expect(await sweepA).toBe(1);
    const final = await readRow(deliveryId);
    expect(final.status).toBe('DELIVERED'); // not FAILED (A never stomps B)
    expect(final.attempts).toBe(1); // not 2
    expect(final.last_error).toBeNull();
    // And A's stale lease value is provably NOT the row's current next_at (fence predicate sanity).
    const nowLease = (await app.db.query<{ next_at: string }>(
      'SELECT next_at::text AS next_at FROM webhook_deliveries WHERE delivery_id=$1', [deliveryId]
    )).rows[0]!.next_at;
    expect(nowLease).not.toBe(aLease);
  }, 90_000);

  it('graceful shutdown releases the live claim to PENDING with budget intact', async () => {
    const hungListener = await startListener();
    hungListener.setDefault({ kind: 'hangForever' });
    const deliveryId = await seedDelivery(hungListener.url('/hook2'));
    const controller = new AbortController();

    const sweepA = deliverWebhooks(app.db, { ...mesh, claimLeaseMs: 60_000, signal: controller.signal, shutdownGraceMs: 250 });
    await waitStatus(deliveryId, 'DISPATCHING');
    expect(hungListener.requests).toBeGreaterThanOrEqual(1); // the dispatch that gets drained is REAL

    controller.abort();
    const t0 = Date.now();
    expect(await sweepA).toBe(1);
    const waited = Date.now() - t0;
    expect(waited).toBeGreaterThanOrEqual(240); // bounded WAIT for the grace window, not instant abandon
    expect(waited).toBeLessThan(6000); // and BOUNDED by shutdownGraceMs

    const released = await readRow(deliveryId);
    expect(released.status).toBe('PENDING');
    expect(released.attempts).toBe(0); // shutdown release consumes NO retry budget
    expect(released.last_error).toBe('SHUTDOWN_RELEASED');

    await hungListener.stop(); // late socket teardown must not resurrect anything
    await new Promise((r) => setTimeout(r, 250));
    expect((await readRow(deliveryId)).status).toBe('PENDING');

    // Next sweep re-claims immediately — nothing hangs in DISPATCHING.
    expect(await deliverWebhooks(app.db, { ...mesh, fetchFn: async () => ({ status: 200 }) })).toBeGreaterThanOrEqual(1);
    expect((await readRow(deliveryId)).status).toBe('DELIVERED');
    expect((await readRow(deliveryId)).attempts).toBe(1);
  }, 90_000);
});
