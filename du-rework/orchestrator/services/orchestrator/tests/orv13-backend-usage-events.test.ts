import { createHash } from 'node:crypto';
import { UsageEventSchema, type UsageEvent } from '@du/contracts';
import type { Db } from '../src/db/db';
import type { RouteContext } from '../src/http/route-context';
import { route } from '../src/server';
import { createUsageService } from '../src/modules/usage/usage';

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const OPERATION_A = '33333333-3333-4333-8333-333333333333';
const OPERATION_B = '44444444-4444-4444-8444-444444444444';
const TASK_A = '55555555-5555-4555-8555-555555555555';
const TASK_B = '66666666-6666-4666-8666-666666666666';

function event(input: Partial<UsageEvent> & Pick<UsageEvent, 'eventId' | 'operationId' | 'taskId'>): UsageEvent {
  return UsageEventSchema.parse({
    eventId: input.eventId,
    invocationId: input.invocationId ?? `inv-${input.eventId}`,
    operationId: input.operationId,
    taskId: input.taskId,
    units: input.units ?? { inputTokens: 12, outputTokens: 3, pages: 2 },
    costMicrousd: input.costMicrousd,
    costStatus: input.costStatus,
    providerReportedCost: input.providerReportedCost,
    measurement: input.measurement ?? 'measured',
    provider: input.provider ?? 'loopback',
    model: input.model ?? 'fixture-v1',
    occurredAt: input.occurredAt ?? '2026-10-10T11:59:00Z',
  });
}

interface DbCall { sql: string; params: unknown[] }

function fakeDb(pages: Array<Record<string, unknown>[]>): { db: Db; calls: DbCall[] } {
  const calls: DbCall[] = [];
  const db = {
    pool: {},
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      const rows = pages.shift() ?? [];
      return { rows, rowCount: rows.length };
    },
    tx: async (): Promise<never> => { throw new Error('read-only fixture'); },
    close: async (): Promise<void> => undefined,
  } as unknown as Db;
  return { db, calls };
}

function row(
  payload: unknown,
  input: { eventId: string; operationId: string; taskId: string; receivedAt?: string; cursorReceivedAt?: string; matchedTaskId?: string | null },
): Record<string, unknown> {
  const receivedAt = input.receivedAt ?? '2026-10-10T12:00:00Z';
  return {
    event_id: input.eventId,
    operation_id: input.operationId,
    task_id: input.taskId,
    matched_task_id: input.matchedTaskId === undefined ? input.taskId : input.matchedTaskId,
    payload,
    received_at: new Date(receivedAt),
    cursor_received_at: input.cursorReceivedAt ?? receivedAt,
  };
}

function routeContext(input: {
  pathname?: string;
  search?: string;
  token?: string | null;
  session?: { role: 'admin' | 'operator' | 'viewer'; tenantId: string | null };
  usage: RouteContext['usage'];
}): RouteContext {
  return {
    method: 'GET',
    pathname: input.pathname ?? '/api/internal/usage/events',
    searchParams: new URLSearchParams(input.search ?? ''),
    headers: input.token === null
      ? { cookie: `du_session=${'a'.repeat(43)}` }
      : { authorization: `Bearer ${input.token ?? 'platform-token'}` },
    config: {
      adminToken: 'platform-token',
      tenantAdminTokens: { 'tenant-a-token': TENANT_A },
      ...(input.session ? { adminSessionStore: { get: async () => ({ ...input.session, csrfToken: 'csrf' }) } } : {}),
    },
    ingressAudience: 'internal',
    usage: input.usage,
  } as unknown as RouteContext;
}

describe('BASIC_ADMIN_USAGE_V1 usage page', () => {
  const query = {
    from: '2026-10-10T00:00:00Z',
    to: '2026-10-11T00:00:00Z',
    timeField: 'receivedAt' as const,
    limit: 1,
  };

  test('projects persisted UsageEvent facts into a bounded tenant keyset page', async () => {
    const first = event({ eventId: 'evt-a', operationId: OPERATION_A, taskId: TASK_A, costMicrousd: 0, costStatus: 'unpriced' });
    const second = event({ eventId: 'evt-b', operationId: OPERATION_A, taskId: TASK_A, occurredAt: '2026-10-10T11:59:01Z' });
    const fixture = fakeDb([[
      row(first, { eventId: first.eventId, operationId: first.operationId, taskId: first.taskId }),
      row(second, { eventId: second.eventId, operationId: second.operationId, taskId: second.taskId, receivedAt: '2026-10-10T12:00:01Z' }),
    ]]);

    const page = await createUsageService(fixture.db).getAdminUsageEventPage(TENANT_A, query);
    expect(page.events).toMatchObject([{
      eventId: 'evt-a', operationId: OPERATION_A, taskId: TASK_A,
      provider: 'loopback', model: 'fixture-v1',
      units: { inputTokens: 12, outputTokens: 3, pages: 2 },
      costMicrousd: null, costStatus: 'unpriced', measurement: 'measured',
      occurredAt: '2026-10-10T11:59:00Z', receivedAt: '2026-10-10T12:00:00.000Z',
    }]);
    expect(page).toMatchObject({ tenantId: TENANT_A, limit: 1, hasMore: true, skippedInvalidEvents: 0,
      timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' } });
    expect(page.nextCursor).toBeDefined();
    expect(fixture.calls[0]!.sql).toMatch(/JOIN operations o ON o\.id = ue\.operation_id/i);
    expect(fixture.calls[0]!.sql).toMatch(/o\.tenant_id = \$1/);
    expect(fixture.calls[0]!.sql).toMatch(/LEFT JOIN tasks t ON t\.id = ue\.task_id AND t\.operation_id = ue\.operation_id/i);
    expect(fixture.calls[0]!.sql).toMatch(/ORDER BY ue\.received_at ASC, encode\(sha256\(convert_to\(ue\.event_id, 'UTF8'\)\), 'hex'\) ASC/);
    expect(fixture.calls[0]!.sql).toMatch(/to_char\(ue\.received_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US"Z"'\) AS cursor_received_at/);
    expect(fixture.calls[0]!.params).toContain(TENANT_A);
    expect(fixture.calls[0]!.params).toContain(2); // bounded page size + one
    expect(JSON.stringify(page)).not.toContain('businessId');
  });

  test('stores and projects provider-reported cost separately from trusted cost', async () => {
    const diagnostic = { costMicrousd: 9_999, currency: 'USD' as const, source: 'provider-response' as const, status: 'unverified' as const };
    const source = event({
      eventId: 'evt-provider-cost', operationId: OPERATION_A, taskId: TASK_A,
      costMicrousd: 42, costStatus: 'measured', providerReportedCost: diagnostic,
    });
    let persisted: UsageEvent | undefined;
    const queryDb = async (sql: string, params: unknown[] = []) => {
      if (sql.includes('SELECT o.tenant_id::text AS tenant_id FROM operations o')) return { rows: [{ tenant_id: TENANT_A }], rowCount: 1 };
      if (sql.includes('SELECT id FROM tasks')) return { rows: [{ id: TASK_A }], rowCount: 1 };
      if (sql.includes('INSERT INTO usage_events')) {
        persisted = JSON.parse(String(params[3])) as UsageEvent;
        return { rows: [{ event_id: source.eventId }], rowCount: 1 };
      }
      throw new Error(`Unexpected SQL ${sql}`);
    };
    const db = {
      pool: {}, query: queryDb,
      tx: async (run: (client: { query: typeof queryDb }) => Promise<unknown>) => run({ query: queryDb }),
      close: async () => undefined,
    } as unknown as Db;
    await createUsageService(db, {
      backupSnapshotWriteGate: { assertWriteAllowed: jest.fn(async () => undefined) },
    }).ingest(source);
    expect(persisted).toMatchObject({ costMicrousd: 42, providerReportedCost: diagnostic });

    const page = await createUsageService(fakeDb([[
      row(persisted, { eventId: source.eventId, operationId: source.operationId, taskId: source.taskId }),
    ]]).db).getAdminUsageEventPage(TENANT_A, query);
    expect(page.events[0]).toMatchObject({ costMicrousd: 42, providerReportedCost: diagnostic });
  });

  test('binds cursors to tenant, filters, window, and page size before querying', async () => {
    const first = event({ eventId: 'evt-a', operationId: OPERATION_A, taskId: TASK_A });
    const second = event({ eventId: 'evt-b', operationId: OPERATION_A, taskId: TASK_A });
    const page1Db = fakeDb([[
      row(first, { eventId: first.eventId, operationId: first.operationId, taskId: first.taskId }),
      row(second, { eventId: second.eventId, operationId: second.operationId, taskId: second.taskId, receivedAt: '2026-10-10T12:00:01Z' }),
    ]]);
    const page1 = await createUsageService(page1Db.db).getAdminUsageEventPage(TENANT_A, query);
    const page2Db = fakeDb([[row(second, {
      eventId: second.eventId, operationId: second.operationId, taskId: second.taskId, receivedAt: '2026-10-10T12:00:01Z',
    })]]);
    const page2 = await createUsageService(page2Db.db).getAdminUsageEventPage(TENANT_A, { ...query, cursor: page1.nextCursor });
    expect(page2.events.map((item) => item.eventId)).toEqual(['evt-b']);
    expect(page2Db.calls[0]!.sql).toMatch(/\(ue\.received_at, encode\(sha256\(convert_to\(ue\.event_id, 'UTF8'\)\), 'hex'\)\) > \(\$\d+::timestamptz, \$\d+::text\)/);
    await expect(createUsageService(page2Db.db).getAdminUsageEventPage(TENANT_B, { ...query, cursor: page1.nextCursor }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_ARGUMENT' });
    await expect(createUsageService(page2Db.db).getAdminUsageEventPage(TENANT_A, {
      ...query, provider: 'other', model: 'other', cursor: page1.nextCursor,
    })).rejects.toMatchObject({ status: 422, code: 'INVALID_ARGUMENT' });
    await expect(createUsageService(page2Db.db).getAdminUsageEventPage(TENANT_A, {
      ...query, limit: 2, cursor: page1.nextCursor,
    })).rejects.toMatchObject({ status: 422, code: 'INVALID_ARGUMENT' });
    // The effective-charge projection follows the bounded event page with one
    // grouped adjustment lookup. Invalid cursors still fail before either query.
    expect(page2Db.calls).toHaveLength(2);
  });

  test('keeps absent cost/provider fields null and counts malformed identity rows without returning their payload', async () => {
    const missingCost = event({ eventId: 'evt-no-cost', operationId: OPERATION_A, taskId: TASK_A });
    const { costMicrousd: _costMicrousd, costStatus: _costStatus, provider: _provider, model: _model, ...withoutAttribution } = missingCost;
    const fixture = fakeDb([[
      row(withoutAttribution, { eventId: missingCost.eventId, operationId: missingCost.operationId, taskId: missingCost.taskId }),
      row({ ...missingCost, eventId: 'wrong-event-id', prompt: 'private body' }, {
        eventId: 'evt-row', operationId: OPERATION_A, taskId: TASK_A, receivedAt: '2026-10-10T12:00:01Z',
      }),
    ]]);
    const page = await createUsageService(fixture.db).getAdminUsageEventPage(TENANT_A, query);
    expect(page.events[0]).toMatchObject({ provider: null, model: null, costMicrousd: null, costStatus: null });
    expect(page.skippedInvalidEvents).toBe(0); // the malformed row is beyond the bounded first page
    expect(JSON.stringify(page)).not.toContain('private body');

    const malformedPage = await createUsageService(fakeDb([[
      row({ ...missingCost, eventId: 'wrong-event-id', prompt: 'private body' }, {
        eventId: 'evt-row', operationId: OPERATION_A, taskId: TASK_A,
      }),
    ]]).db).getAdminUsageEventPage(TENANT_A, query);
    expect(malformedPage).toMatchObject({ events: [], skippedInvalidEvents: 1 });
    expect(JSON.stringify(malformedPage)).not.toContain('private body');
  });

  test('counts malformed final DTO rows instead of failing the page', async () => {
    const overlengthId = event({
      eventId: `evt-${'x'.repeat(130)}`,
      invocationId: 'inv-overlength-id',
      operationId: OPERATION_A,
      taskId: TASK_A,
    });
    const invalidProvider = event({
      eventId: 'evt-invalid-provider',
      operationId: OPERATION_A,
      taskId: TASK_A,
      provider: 'bad provider/name',
    });
    const nonIsoOccurredAt = event({
      eventId: 'evt-non-iso-time',
      operationId: OPERATION_A,
      taskId: TASK_A,
      occurredAt: new Date('2026-10-10T11:59:00Z').toUTCString(),
    });
    const page = await createUsageService(fakeDb([[
      row(overlengthId, { eventId: overlengthId.eventId, operationId: OPERATION_A, taskId: TASK_A }),
      row(invalidProvider, { eventId: invalidProvider.eventId, operationId: OPERATION_A, taskId: TASK_A, receivedAt: '2026-10-10T12:00:01Z' }),
      row(nonIsoOccurredAt, { eventId: nonIsoOccurredAt.eventId, operationId: OPERATION_A, taskId: TASK_A, receivedAt: '2026-10-10T12:00:02Z' }),
    ]]).db).getAdminUsageEventPage(TENANT_A, { ...query, limit: 3 });

    expect(page).toMatchObject({ events: [], hasMore: false, skippedInvalidEvents: 3 });
  });

  test('advances the keyset cursor across malformed rows without returning them', async () => {
    const malformed = event({
      eventId: `evt-${'x'.repeat(130)}`,
      invocationId: 'inv-overlength-id',
      operationId: OPERATION_A,
      taskId: TASK_A,
    });
    const valid = event({ eventId: 'evt-after-malformed', operationId: OPERATION_A, taskId: TASK_A });
    const firstDb = fakeDb([[
      row(malformed, { eventId: malformed.eventId, operationId: OPERATION_A, taskId: TASK_A }),
      row(valid, { eventId: valid.eventId, operationId: OPERATION_A, taskId: TASK_A, receivedAt: '2026-10-10T12:00:01Z' }),
    ]]);
    const firstPage = await createUsageService(firstDb.db).getAdminUsageEventPage(TENANT_A, query);
    expect(firstPage).toMatchObject({ events: [], hasMore: true, skippedInvalidEvents: 1 });
    expect(firstPage.nextCursor).toBeDefined();

    const secondDb = fakeDb([[
      row(valid, { eventId: valid.eventId, operationId: OPERATION_A, taskId: TASK_A, receivedAt: '2026-10-10T12:00:01Z' }),
    ]]);
    const secondPage = await createUsageService(secondDb.db).getAdminUsageEventPage(TENANT_A, {
      ...query,
      cursor: firstPage.nextCursor,
    });
    expect(secondPage.events.map(({ eventId }) => eventId)).toEqual([valid.eventId]);
    expect(secondDb.calls[0]!.sql).toMatch(/\(ue\.received_at, encode\(sha256\(convert_to\(ue\.event_id, 'UTF8'\)\), 'hex'\)\) > \(\$\d+::timestamptz, \$\d+::text\)/);
    const cursor = JSON.parse(Buffer.from(firstPage.nextCursor!, 'base64url').toString('utf8')) as Record<string, unknown>;
    expect(cursor).toMatchObject({
      after: '2026-10-10T12:00:00Z',
      afterEventKey: createHash('sha256').update(malformed.eventId, 'utf8').digest('hex'),
    });
    expect(cursor).not.toHaveProperty('eventId');
  });

  test('validates window bounds and scopes the internal route before service access', async () => {
    const getPage = jest.fn(async () => ({ tenantId: TENANT_A } as never));
    const usage = { getAdminUsageEventPage: getPage } as unknown as RouteContext['usage'];
    const routeQuery = `tenantId=${TENANT_A}&from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}&limit=1`;
    const valid = await route(routeContext({ search: routeQuery, token: 'tenant-a-token', usage }));
    expect(valid.status).toBe(200);
    expect(getPage).toHaveBeenCalledWith(TENANT_A, expect.objectContaining({ tenantId: TENANT_A, limit: 1 }));

    await expect(route(routeContext({ search: `tenantId=${TENANT_B}&from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}`, token: 'tenant-a-token', usage })))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    await expect(route(routeContext({ search: `from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}&limit=1&limit=2`, usage })))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    await expect(route(routeContext({ search: `tenantId=${TENANT_A}&from=2024-01-01T00:00:00Z&to=2026-10-10T00:00:00Z`, token: 'tenant-a-token', usage })))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  test('scopes cookie reads to the session tenant regardless of admin or viewer role', async () => {
    const getPage = jest.fn(async () => ({ tenantId: TENANT_A } as never));
    const usage = { getAdminUsageEventPage: getPage } as unknown as RouteContext['usage'];
    const ownTenantQuery = `from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}&limit=1`;
    const adminCookie = routeContext({ token: null, session: { role: 'admin', tenantId: TENANT_A }, search: ownTenantQuery, usage });
    const own = await route(adminCookie);
    expect(own.status).toBe(200);
    expect(getPage).toHaveBeenCalledWith(TENANT_A, expect.objectContaining({ limit: 1 }));

    const foreignQuery = `tenantId=${TENANT_B}&from=${encodeURIComponent(query.from)}&to=${encodeURIComponent(query.to)}`;
    await expect(route(routeContext({ token: null, session: { role: 'admin', tenantId: TENANT_A }, search: foreignQuery, usage })))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });

    const viewer = await route(routeContext({ token: null, session: { role: 'viewer', tenantId: TENANT_A }, search: ownTenantQuery, usage }));
    expect(viewer.status).toBe(200);
    await expect(route(routeContext({ token: null, session: { role: 'admin', tenantId: null }, search: ownTenantQuery, usage })))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(getPage).toHaveBeenCalledTimes(2);
  });
});
