import { UsageEventSchema, type UsageEvent } from '@du/contracts';
import type { Db } from '../src/db/db';
import type { RouteContext } from '../src/http/route-context';
import { route } from '../src/server';
import { createUsageService } from '../src/modules/usage/usage';
import type { LocalUserUsageReadScope } from '../src/modules/usage/read-scope';

const TENANT = '11111111-1111-4111-8111-111111111111';
const KEY = '22222222-2222-4222-8222-222222222222';
const PROFILE = '33333333-3333-4333-8333-333333333333';
const OPERATION = '44444444-4444-4444-8444-444444444444';
const TASK = '55555555-5555-4555-8555-555555555555';
const FROM = '2026-10-10T00:00:00Z';
const TO = '2026-10-11T00:00:00Z';

const localScope: LocalUserUsageReadScope = {
  tenantId: TENANT,
  userId: 'local-user-1',
  roleVersion: 7,
  apiKeyIds: [KEY],
  profileIds: [PROFILE],
};

function event(): UsageEvent {
  return UsageEventSchema.parse({
    eventId: 'usage-event-1', invocationId: 'invocation-1', operationId: OPERATION, taskId: TASK,
    units: { inputTokens: 4, outputTokens: 2 }, costMicrousd: 0, costStatus: 'estimated', measurement: 'estimated',
    occurredAt: '2026-10-10T12:00:00Z', provider: 'openai', model: 'gpt-4o-2024-08-06',
  });
}

function fakeDb(rows: Array<Record<string, unknown>> = []) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    pool: {},
    query: async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return { rows, rowCount: rows.length };
    },
    tx: async (): Promise<never> => { throw new Error('read-only fixture'); },
    close: async () => undefined,
  } as unknown as Db;
  return { db, calls };
}

function ctx(input: {
  path: string;
  query: string;
  cookie?: string;
  session?: Record<string, unknown> | null;
  identity?: RouteContext['identity'];
  token?: string;
  usage: RouteContext['usage'];
}): RouteContext {
  return {
    method: 'GET', pathname: input.path, searchParams: new URLSearchParams(input.query),
    headers: {
      ...(input.cookie !== undefined ? { cookie: input.cookie } : {}),
      ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
    },
    ingressAudience: 'internal',
    config: {
      adminToken: 'platform-token',
      tenantAdminTokens: { 'tenant-token': TENANT },
      ...(input.session !== undefined ? { adminSessionStore: { get: async () => input.session ? { ...input.session, csrfToken: 'csrf' } : null } } : {}),
    },
    identity: input.identity,
    usage: input.usage,
  } as unknown as RouteContext;
}

describe('ORV14 scoped internal Usage reads', () => {
  test('uses the exact assigned key AND null-or-assigned-profile population for BASIC events', async () => {
    const payload = event();
    const fixture = fakeDb([{
      event_id: payload.eventId, operation_id: OPERATION, task_id: TASK, matched_task_id: TASK,
      payload, received_at: new Date('2026-10-10T12:00:00Z'), cursor_received_at: '2026-10-10T12:00:00Z',
    }]);
    const page = await createUsageService(fixture.db).getAdminUsageEventPage(TENANT, {
      tenantId: TENANT, from: FROM, to: TO, timeField: 'receivedAt', limit: 25,
    }, localScope);

    expect(page.events).toHaveLength(1);
    const { sql, params } = fixture.calls[0]!;
    expect(sql).toContain('o.api_key_id = ANY($4::uuid[])');
    expect(sql).toContain('o.profile_id = ANY($5::uuid[])');
    expect(sql).toContain("usage_scope_user.version = $8");
    expect(params).toEqual([TENANT, FROM, TO, [KEY], [PROFILE], TENANT, localScope.userId, localScope.roleVersion, 26]);
  });

  test('summary and rich export use the same server-only fence', async () => {
    const summaryDb = fakeDb([]);
    await createUsageService(summaryDb.db).getUsageSummary(TENANT, new Date(FROM), new Date(TO), undefined, localScope);
    expect(summaryDb.calls[0]!.sql).toContain('o.api_key_id = ANY($4::uuid[])');
    expect(summaryDb.calls[0]!.sql).toContain('o.profile_id = ANY($5::uuid[])');
    expect(summaryDb.calls[0]!.params).toEqual([TENANT, new Date(FROM).toISOString(), new Date(TO).toISOString(), [KEY], [PROFILE], TENANT, localScope.userId, localScope.roleVersion]);

    const exportDb = fakeDb([]);
    await createUsageService(exportDb.db).getUsageEventExportPage(TENANT, { tenantId: TENANT, from: FROM, to: TO }, localScope);
    expect(exportDb.calls[0]!.sql).toContain('o.api_key_id = ANY($2::uuid[])');
    expect(exportDb.calls[0]!.sql).toContain('o.profile_id = ANY($3::uuid[])');
    expect(exportDb.calls[0]!.params).toEqual([TENANT, [KEY], [PROFILE], TENANT, localScope.userId, localScope.roleVersion, FROM, TO, 51]);
  });

  test('rejects an old event cursor when the live assignment population changes', async () => {
    const payload = event();
    const pageDb = fakeDb([{
      event_id: payload.eventId, operation_id: OPERATION, task_id: TASK, matched_task_id: TASK,
      payload, received_at: new Date('2026-10-10T12:00:00Z'), cursor_received_at: '2026-10-10T12:00:00Z',
    }, {
      event_id: 'usage-event-2', operation_id: OPERATION, task_id: TASK, matched_task_id: TASK,
      payload: { ...payload, eventId: 'usage-event-2' }, received_at: new Date('2026-10-10T12:01:00Z'), cursor_received_at: '2026-10-10T12:01:00Z',
    }]);
    const first = await createUsageService(pageDb.db).getAdminUsageEventPage(TENANT, {
      tenantId: TENANT, from: FROM, to: TO, timeField: 'receivedAt', limit: 1,
    }, localScope);
    const otherScope = { ...localScope, roleVersion: 8, apiKeyIds: ['66666666-6666-4666-8666-666666666666'] };
    const nextDb = fakeDb([]);
    await expect(createUsageService(nextDb.db).getAdminUsageEventPage(TENANT, {
      tenantId: TENANT, from: FROM, to: TO, timeField: 'receivedAt', limit: 1, cursor: first.nextCursor,
    }, otherScope)).rejects.toMatchObject({ status: 422, code: 'INVALID_ARGUMENT' });
    expect(nextDb.calls).toHaveLength(0);
  });

  test('local USER session controls scope and invalid supplied cookie never falls back to bearer', async () => {
    const getPage = jest.fn(async (_tenant: string, _query: unknown, _scope?: LocalUserUsageReadScope) => ({ tenantId: TENANT } as never));
    const usage = { getAdminUsageEventPage: getPage } as unknown as RouteContext['usage'];
    const identity = {
      getLocalUserOperationScope: jest.fn(async () => localScope),
    } as unknown as RouteContext['identity'];
    const query = `tenantId=${TENANT}&from=${encodeURIComponent(FROM)}&to=${encodeURIComponent(TO)}`;
    const session = { role: 'operator', issuer: 'du-local', tenantId: TENANT, sub: 'local-user-1', roleVersion: 7 };
    await route(ctx({ path: '/api/internal/usage/events', query, cookie: `du_session=${'a'.repeat(43)}`, session, identity, token: 'tenant-token', usage }));
    expect(identity!.getLocalUserOperationScope).toHaveBeenCalledWith({ tenantId: TENANT, userId: 'local-user-1', roleVersion: 7 });
    expect(getPage).toHaveBeenCalledWith(TENANT, expect.any(Object), localScope);

    await expect(route(ctx({ path: '/api/internal/usage/events', query, cookie: `du_session=${'b'.repeat(43)}`, session: null, token: 'tenant-token', usage })))
      .rejects.toMatchObject({ status: 401, code: 'UNAUTHENTICATED' });
    expect(getPage).toHaveBeenCalledTimes(1);
  });
});
