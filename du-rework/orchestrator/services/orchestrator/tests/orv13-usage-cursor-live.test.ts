import { randomUUID } from 'node:crypto';
import { createDb, type Db } from '../src/db/db';
import { createUsageService } from '../src/modules/usage/usage';

const DATABASE_URL = process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;

if (!LIVE) {
  console.warn('orv13-usage-cursor-live.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

function assertTestDatabase(): void {
  const dbName = new URL(DATABASE_URL).pathname.split('/').pop() ?? '.';
  if (!/test/i.test(dbName)) {
    throw new Error(`refusing live cursor fixture: database "${dbName}" does not look like a test database`);
  }
}

function cursorPayload(value: string): { after: string; afterEventKey: string } {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { after: string; afterEventKey: string };
}

liveDescribe('BASIC_ADMIN_USAGE_V1 cursor precision on PostgreSQL', () => {
  let db: Db;
  let tenantId: string;
  let operationId: string;
  let taskId: string;
  let eventIds: string[];

  beforeAll(async () => {
    assertTestDatabase();
    db = createDb(DATABASE_URL);
    const schema = await db.query<{ usage_events: string | null; sha256_fn: string }>(
      `SELECT to_regclass('public.usage_events')::text AS usage_events,
              encode(sha256(convert_to('orv13', 'UTF8')), 'hex') AS sha256_fn`,
    );
    if (!schema.rows[0]?.usage_events || !/^[a-f0-9]{64}$/.test(schema.rows[0].sha256_fn)) {
      throw new Error('test database must already have usage_events and PostgreSQL core sha256(bytea)');
    }

    tenantId = randomUUID();
    const suffix = randomUUID();
    await db.query('INSERT INTO tenants (id, name) VALUES ($1, $2)', [tenantId, `orv13-cursor-${suffix}`]);
    const operation = await db.query<{ id: string }>(
      `INSERT INTO operations (tenant_id, business_id, business_version, action, correlation_id, input_ref)
       VALUES ($1, $2, '1.0.0', 'cursor-fixture', $3, '{}'::jsonb) RETURNING id`,
      [tenantId, `orv13-cursor-${suffix}`, `orv13-cursor-${suffix}`],
    );
    operationId = operation.rows[0]!.id;
    const task = await db.query<{ id: string }>(
      `INSERT INTO tasks (operation_id, task_key, kind) VALUES ($1, $2, 'root') RETURNING id`,
      [operationId, `orv13-cursor-${suffix}`],
    );
    taskId = task.rows[0]!.id;

    const instants = [
      '2026-10-10T12:00:00.000001Z',
      '2026-10-10T12:00:00.000002Z',
      '2026-10-10T12:00:00.000003Z',
    ];
    eventIds = instants.map((_, index) => `orv13-cursor-${suffix}-${index + 1}`);
    for (const [index, receivedAt] of instants.entries()) {
      const eventId = eventIds[index]!;
      const payload = {
        eventId,
        invocationId: `inv-${eventId}`,
        operationId,
        taskId,
        units: { inputTokens: 1, outputTokens: 0 },
        costMicrousd: 0,
        costStatus: 'unpriced',
        currency: 'USD',
        measurement: 'measured',
        provider: 'loopback',
        model: 'fixture-v1',
        occurredAt: '2026-10-10T12:00:00.000000Z',
      };
      await db.query(
        `INSERT INTO usage_events (event_id, operation_id, task_id, payload, received_at)
         VALUES ($1, $2, $3, $4::jsonb, $5::timestamptz)`,
        [eventId, operationId, taskId, JSON.stringify(payload), receivedAt],
      );
    }
  }, 30_000);

  afterAll(async () => {
    if (db) {
      if (operationId) {
        await db.query('DELETE FROM usage_events WHERE operation_id = $1', [operationId]);
        await db.query('DELETE FROM tasks WHERE operation_id = $1', [operationId]);
        await db.query('DELETE FROM operations WHERE id = $1', [operationId]);
      }
      if (tenantId) await db.query('DELETE FROM tenants WHERE id = $1', [tenantId]);
      await db.close();
    }
  }, 30_000);

  test('pages through distinct microsecond receive times without repeats or gaps', async () => {
    const service = createUsageService(db);
    const pages = [];
    let cursor: string | undefined;
    for (let index = 0; index < 3; index += 1) {
      const page = await service.getAdminUsageEventPage(tenantId, {
        from: '2026-10-10T00:00:00Z',
        to: '2026-10-11T00:00:00Z',
        timeField: 'receivedAt',
        limit: 1,
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page);
      cursor = page.nextCursor;
      if (!page.hasMore) break;
    }

    expect(pages).toHaveLength(3);
    expect(pages.map((page) => page.events.map((event) => event.eventId))).toEqual(eventIds.map((eventId) => [eventId]));
    expect(pages.map((page) => page.skippedInvalidEvents)).toEqual([0, 0, 0]);
    expect(cursor).toBeUndefined();
    expect(cursorPayload(pages[0]!.nextCursor!).after).toBe('2026-10-10T12:00:00.000001Z');
    expect(cursorPayload(pages[1]!.nextCursor!).after).toBe('2026-10-10T12:00:00.000002Z');
  }, 30_000);
});
