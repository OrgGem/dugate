import {
  UsageEventDrilldownCursorSchema,
  UsageEventExportPageSchema,
  UsageLedgerEventSchema,
  type UsageLedgerEvent,
} from '@du/contracts';
import type { Db } from '../src/db/db';
import { route, type RouteContext } from '../src/server';
import { createUsageService } from '../src/modules/usage/usage';

const TENANT_A = 'tenant-a';
const TENANT_B = 'tenant-b';

function event(eventId: string, occurredAt: string): UsageLedgerEvent {
  return UsageLedgerEventSchema.parse({
    eventId,
    idempotencyKey: `idem-${eventId}`,
    kind: 'initial',
    tenantId: TENANT_A,
    apiKeyId: 'key-1',
    operationId: '3f2a8c9e-1b4d-4a6c-8e2f-9d0c1b2a3f45',
    taskId: 'a1a2a3a4-a5a6-47a8-89aa-a1a2a3a4a5a6',
    invocationId: 'inv-1',
    attempt: 1,
    stepKey: 'convert',
    businessId: 'reports',
    businessVersion: 'v1',
    action: 'transform',
    profileRevision: 2,
    connectorId: 'connector-1',
    connectorRevision: 1,
    provider: 'openai',
    model: 'gpt-4o',
    unitType: 'tokens',
    units: { inputTokens: 10, outputTokens: 5 },
    costMicrousd: 25,
    currency: 'USD',
    costStatus: 'measured',
    durationMs: 10,
    occurredAt,
    receivedAt: '2026-03-01T10:00:05Z',
  });
}

interface DbCall { sql: string; params: unknown[] }

function fakeDb(pages: Array<Record<string, unknown>[]>): { db: Db; calls: DbCall[] } {
  const calls: DbCall[] = [];
  const db = {
    pool: {},
    query: async (sql: string, params: unknown[] = []): Promise<unknown> => {
      calls.push({ sql, params });
      const rows = pages.shift() ?? [];
      return { rows, rowCount: rows.length };
    },
    tx: async (): Promise<never> => { throw new Error('query-only fixture'); },
    close: async (): Promise<void> => undefined,
  } as unknown as Db;
  return { db, calls };
}

function row(ledger: UsageLedgerEvent, dbReceivedAt = ledger.receivedAt): Record<string, unknown> {
  return {
    event_id: ledger.eventId,
    operation_id: ledger.operationId,
    payload: ledger,
    received_at: new Date(dbReceivedAt),
    sort_value: new Date(ledger.occurredAt),
  };
}

function cursorFrom(value: string): ReturnType<typeof UsageEventDrilldownCursorSchema.parse> {
  const decoded = Buffer.from(value, 'base64url').toString('utf8');
  return UsageEventDrilldownCursorSchema.parse(JSON.parse(decoded) as unknown);
}

describe('COST-03 usage event query pages', () => {
  test('uses bounded tenant SQL and returns a validated first page plus keyset cursor', async () => {
    const e1 = event('evt-1', '2026-03-01T10:00:00Z');
    const e2 = event('evt-2', '2026-03-01T10:00:00Z');
    const e3 = event('evt-3', '2026-03-01T10:01:00Z');
    const { db, calls } = fakeDb([[row(e1), row(e2), row(e3)]]);

    const page = await createUsageService(db).getUsageEventExportPage(TENANT_A, {
      apiKeyId: 'key-1',
      businessId: 'reports',
      action: 'transform',
      profileRevision: 2,
      limit: 2,
      from: '2026-03-01T00:00:00Z',
      to: '2026-03-02T00:00:00Z',
    });

    expect(UsageEventExportPageSchema.parse(page)).toStrictEqual(page);
    expect(page.events.map((item) => item.eventId)).toEqual(['evt-1', 'evt-2']);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeDefined();
    expect(page.timeSemantics).toStrictEqual({ field: 'occurredAt', order: 'asc', timezone: 'UTC' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.sql).toMatch(/JOIN operations o ON o\.id = ue\.operation_id/i);
    expect(calls[0]!.sql).toMatch(/o\.tenant_id = \$1/);
    expect(calls[0]!.sql).toMatch(/ue\.payload->>'tenantId' = \$1/);
    expect(calls[0]!.sql).toMatch(/ORDER BY .*ASC, ue\.event_id ASC/i);
    expect(calls[0]!.sql).toMatch(/LIMIT \$\d+/i);
    expect(calls[0]!.sql).not.toMatch(/count\s*\(/i);
    expect(calls[0]!.params).toContain(TENANT_A);
    expect(calls[0]!.params).toContain('key-1');
    expect(calls[0]!.params).toContain('reports');
    expect(calls[0]!.params).toContain('transform');
    expect(calls[0]!.params).toContain(3); // bounded fetch of page size + one
    const decoded = cursorFrom(page.nextCursor!);
    expect(decoded).toMatchObject({ tenantId: TENANT_A, eventId: 'evt-2' });
  });

  test('continues by stable timestamp + event-id keyset and never reuses another tenant cursor', async () => {
    const e1 = event('evt-1', '2026-03-01T10:00:00Z');
    const e2 = event('evt-2', '2026-03-01T10:00:00Z');
    const firstFixture = fakeDb([[row(e1), row(e2)]]);
    const first = await createUsageService(firstFixture.db).getUsageEventExportPage(TENANT_A, { limit: 1 });
    const cursor = first.nextCursor!;
    const secondFixture = fakeDb([[row(e2)]]);
    const second = await createUsageService(secondFixture.db).getUsageEventExportPage(TENANT_A, { limit: 1, cursor });

    expect(second.events.map((item) => item.eventId)).toEqual(['evt-2']);
    expect(second.hasMore).toBe(false);
    expect(secondFixture.calls[0]!.sql).toMatch(/\(\(ue\.payload->>'occurredAt'\)::timestamptz, ue\.event_id\) > \(\$\d+::timestamptz, \$\d+::text\)/);
    expect(secondFixture.calls[0]!.params).toContain('2026-03-01T10:00:00.000Z');
    expect(secondFixture.calls[0]!.params).toContain('evt-1');

    await expect(createUsageService(secondFixture.db).getUsageEventExportPage(TENANT_B, { limit: 1, cursor }))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_ARGUMENT' });
    await expect(createUsageService(secondFixture.db).getUsageEventExportPage(TENANT_A, {
      limit: 1,
      apiKeyId: 'other-key',
      cursor,
    })).rejects.toMatchObject({ status: 422, code: 'INVALID_ARGUMENT' });
    expect(secondFixture.calls).toHaveLength(1);
  });

  test('checks the requested tenant fence and uses received_at when selected', async () => {
    const e1 = event('evt-1', '2026-03-01T10:00:00Z');
    const { db, calls } = fakeDb([[row(e1, '2026-03-01T10:00:06Z')]]);
    await expect(createUsageService(db).getUsageEventExportPage(TENANT_A, { tenantId: TENANT_B }))
      .rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    const page = await createUsageService(db).getUsageEventExportPage(TENANT_A, { timeField: 'receivedAt' });
    expect(page.timeSemantics.field).toBe('receivedAt');
    expect(page.events[0]!.receivedAt).toBe('2026-03-01T10:00:06.000Z');
    expect(calls[0]!.sql).toContain('ue.received_at AS sort_value');
  });

  test('skips non-ledger JSON without returning it and advances the cursor over inspected rows', async () => {
    const invalid = { ...event('evt-invalid', '2026-03-01T10:00:00Z'), prompt: 'private document content' };
    const valid = event('evt-next', '2026-03-01T10:01:00Z');
    const { db } = fakeDb([[row(invalid as UsageLedgerEvent), row(valid)]]);
    const page = await createUsageService(db).getUsageEventExportPage(TENANT_A, { limit: 1 });
    expect(page.events).toEqual([]);
    expect(page.skippedInvalidEvents).toBe(1);
    expect(page.hasMore).toBe(true);
    expect(page.nextCursor).toBeDefined();
    expect(JSON.stringify(page)).not.toContain('private document content');
    expect(cursorFrom(page.nextCursor!).eventId).toBe('evt-invalid');
  });

  test('fails closed if the JSON event identity disagrees with the primary key', async () => {
    const payload = event('payload-id', '2026-03-01T10:00:00Z');
    const { db } = fakeDb([[{ ...row(payload), event_id: 'different-row-id' }]]);
    await expect(createUsageService(db).getUsageEventExportPage(TENANT_A))
      .rejects.toMatchObject({ status: 500, code: 'USAGE_LEDGER_CONFLICT' });
  });

  test('fails closed if JSON attribution points at a different operation than its tenant-fenced row', async () => {
    const payload = event('evt-operation-mismatch', '2026-03-01T10:00:00Z');
    const { db } = fakeDb([[{ ...row(payload), operation_id: '7c1d2e3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f' }]]);
    await expect(createUsageService(db).getUsageEventExportPage(TENANT_A))
      .rejects.toMatchObject({ status: 500, code: 'USAGE_LEDGER_CONFLICT' });
  });
});

function routeContext(input: {
  search: string;
  token?: string;
  tenantTokens?: Record<string, string>;
  apiKey?: string;
  apiKeyTenantId?: string;
  usage: RouteContext['usage'];
  record?: jest.Mock;
}): RouteContext {
  return {
    method: 'GET',
    pathname: '/api/v1/usage/events',
    searchParams: new URLSearchParams(input.search),
    headers: {
      authorization: `Bearer ${input.token ?? 'usage-admin'}`,
      ...(input.apiKey !== undefined ? { 'x-api-key': input.apiKey } : {}),
    },
    config: { adminToken: 'usage-admin', tenantAdminTokens: input.tenantTokens },
    db: {
      query: async () => ({
        rowCount: input.apiKey === undefined ? 0 : 1,
        rows: input.apiKey === undefined ? [] : [{ id: 'key-1', tenant_id: input.apiKeyTenantId ?? TENANT_A }],
      }),
    },
    usage: input.usage,
    audit: { record: input.record ?? jest.fn(async () => ({ id: 'audit-1' })) },
  } as unknown as RouteContext;
}

describe('COST-03 usage event export route scope', () => {
  const emptyPage = UsageEventExportPageSchema.parse({
    tenantId: TENANT_A,
    events: [],
    limit: 50,
    hasMore: false,
    skippedInvalidEvents: 0,
    timeSemantics: { field: 'occurredAt', order: 'asc', timezone: 'UTC' },
  });

  test('admin route scopes before service call and audits every successful export page', async () => {
    const getPage = jest.fn(async () => emptyPage);
    const record = jest.fn(async () => ({ id: 'audit-1' }));
    const ctx = routeContext({
      search: 'tenantId=tenant-a&apiKeyId=key-1&businessId=reports&action=transform&limit=5',
      usage: { getUsageEventExportPage: getPage } as unknown as RouteContext['usage'],
      record,
    });
    const response = await route(ctx);
    expect(response.status).toBe(200);
    expect(getPage).toHaveBeenCalledWith(TENANT_A, expect.objectContaining({
      tenantId: TENANT_A, apiKeyId: 'key-1', businessId: 'reports', action: 'transform', limit: 5,
    }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: TENANT_A,
      actor: 'admin',
      action: 'usage.export',
      resource: 'usage-events:page',
    }));
  });

  test('tenant operator cannot drill into a foreign tenant and malformed query is rejected', async () => {
    const getPage = jest.fn(async () => emptyPage);
    const operator = routeContext({
      search: `tenantId=${TENANT_B}`,
      token: 'tenant-a-operator',
      tenantTokens: { 'tenant-a-operator': TENANT_A },
      usage: { getUsageEventExportPage: getPage } as unknown as RouteContext['usage'],
    });
    await expect(route(operator)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(getPage).not.toHaveBeenCalled();

    const extra = routeContext({ search: `tenantId=${TENANT_A}&prompt=private`, usage: { getUsageEventExportPage: getPage } as unknown as RouteContext['usage'] });
    await expect(route(extra)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    const duplicate = routeContext({ search: `tenantId=${TENANT_A}&limit=1&limit=2`, usage: { getUsageEventExportPage: getPage } as unknown as RouteContext['usage'] });
    await expect(route(duplicate)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(getPage).not.toHaveBeenCalled();
  });

  test('API-key identity selects its tenant and cannot request a foreign tenant page', async () => {
    const getPage = jest.fn(async () => emptyPage);
    const record = jest.fn(async () => ({ id: 'audit-1' }));
    const own = routeContext({
      search: '',
      token: 'not-an-admin-token',
      apiKey: 'du_test_api_key',
      apiKeyTenantId: TENANT_A,
      usage: { getUsageEventExportPage: getPage } as unknown as RouteContext['usage'],
      record,
    });
    expect((await route(own)).status).toBe(200);
    expect(getPage).toHaveBeenCalledWith(TENANT_A, expect.objectContaining({ timeField: 'occurredAt', limit: 50 }));
    expect(record).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_A, actor: 'api-key' }));

    const foreign = routeContext({
      search: `tenantId=${TENANT_B}`,
      token: 'not-an-admin-token',
      apiKey: 'du_test_api_key',
      apiKeyTenantId: TENANT_A,
      usage: { getUsageEventExportPage: getPage } as unknown as RouteContext['usage'],
    });
    await expect(route(foreign)).rejects.toMatchObject({ status: 403, code: 'PERMISSION_DENIED' });
    expect(getPage).toHaveBeenCalledTimes(1);
  });

  test('platform admin must choose a tenant explicitly', async () => {
    const getPage = jest.fn(async () => emptyPage);
    const ctx = routeContext({ search: '', usage: { getUsageEventExportPage: getPage } as unknown as RouteContext['usage'] });
    await expect(route(ctx)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(getPage).not.toHaveBeenCalled();
  });
});
