import { getOperationsMetrics } from '../src/modules/admin-read/operations-metrics';
import { listOperationsPage, parseOperationsListQuery } from '../src/modules/operations/list-query';
import { handleOperationsRoute, matchOperationsRoute } from '../src/app/admin/bff/operations';

const operationId = '11111111-1111-4111-8111-111111111111';
const tenantId = '22222222-2222-4222-8222-222222222222';
const profileId = '33333333-3333-4333-8333-333333333333';
const apiKeyId = '44444444-4444-4444-8444-444444444444';

function listDb(rows: Record<string, unknown>[] = []) {
  const statements: Array<{ sql: string; params: unknown[] }> = [];
  const db = {
    query: jest.fn(async (sql: string, params: unknown[] = []) => {
      statements.push({ sql, params });
      return sql.includes('SELECT *, to_char')
        ? { rows }
        : { rows: [{ total: rows.length }] };
    }),
  };
  return { db, statements };
}

describe('ORV14 Admin Operations query and scope', () => {
  test('parses human search labels, explicit recorded usage, reservation UNKNOWN and waiting-input filters', () => {
    const query = parseOperationsListQuery(new URLSearchParams({
      business: 'Document Core', action: 'extract invoice', apiKey: 'shared key', profile: 'invoice review',
      correlation: 'trace 7', provider: 'Azure OpenAI', model: 'gpt 4.1', usage: 'no-recorded-usage',
      reservation: 'unknown', attention: 'waiting-input',
    }));
    expect(query).toMatchObject({
      businessContains: 'Document Core', actionContains: 'extract invoice', apiKeyContains: 'shared key',
      profileContains: 'invoice review', correlationContains: 'trace 7', providerContains: 'Azure OpenAI',
      modelContains: 'gpt 4.1', usageFilter: 'no-recorded-usage', reservationFilter: 'unknown',
      attentionFilter: 'waiting-input',
    });
  });

  test('rejects unknown or repeated internal filter parameters instead of silently dropping them', () => {
    expect(() => parseOperationsListQuery(new URLSearchParams('state=FAILED&state=RUNNING'))).toThrow(/unsupported or repeated/);
    expect(() => parseOperationsListQuery(new URLSearchParams('provider=x&tenant=ignored'))).not.toThrow();
    expect(() => parseOperationsListQuery(new URLSearchParams('state=FAILED&tenantId=ignored'))).toThrow(/unsupported or repeated/);
  });

  test('applies filters in SQL and never calls missing usage or UNKNOWN a generic provider pending state', async () => {
    const query = parseOperationsListQuery(new URLSearchParams({
      business: 'Document Core', action: 'extract invoice', apiKey: 'shared key', profile: 'invoice review',
      correlation: 'trace 7', provider: 'Azure OpenAI', model: 'gpt 4.1', usage: 'no-recorded-usage',
      reservation: 'unknown', attention: 'waiting-input',
    }));
    const { db, statements } = listDb();
    await listOperationsPage({ db: db as never }, query, null, (row) => ({ id: row['id'] as string }));
    const page = statements.find(({ sql }) => sql.includes('SELECT *, to_char'))!;
    expect(page.sql).toContain('strpos(lower(business_id), lower($1)) > 0');
    expect(page.sql).toContain('strpos(lower(action), lower($2)) > 0');
    expect(page.sql).toContain('coalesce(ak.name');
    expect(page.sql).toContain('coalesce(ue.payload->>\'provider\'');
    expect(page.sql).toContain('NOT EXISTS (SELECT 1 FROM usage_events');
    expect(page.sql).toContain("br.status = 'UNKNOWN'");
    expect(page.sql).toContain("state = 'WAITING_INPUT'");
    expect(page.params).toEqual(['Document Core', 'extract invoice', 'shared key', 'invoice review', 'trace 7', 'Azure OpenAI', 'gpt 4.1', 21]);
  });

  test('binds list cursors to tenant, user assignment, every filter, sort, and limit', async () => {
    const row = { id: operationId, created_at: '2026-10-11T11:00:00.000Z', __cursor_sort_key: '2026-10-11T11:00:00.000000Z' };
    const { db, statements } = listDb([row, { ...row, id: '55555555-5555-4555-8555-555555555555' }]);
    const baseQuery = parseOperationsListQuery(new URLSearchParams('limit=1'));
    const owner = { tenantId, userId: '66666666-6666-4666-8666-666666666666', roleVersion: 8, profileIds: [profileId], apiKeyIds: [apiKeyId] };
    const first = await listOperationsPage({ db: db as never }, baseQuery, tenantId, (value) => ({ id: value['id'] as string }), owner);
    const cursor = first['nextCursor'];
    expect(typeof cursor).toBe('string');
    const changedQuery = parseOperationsListQuery(new URLSearchParams(`limit=1&business=invoice&cursor=${encodeURIComponent(String(cursor))}`));
    await expect(listOperationsPage({ db: db as never }, changedQuery, tenantId, (value) => ({ id: value['id'] as string }), owner)).rejects.toThrow(/another authorized scope or filter/);
    const changedOwner = { ...owner, roleVersion: 9 };
    const sameQuery = parseOperationsListQuery(new URLSearchParams(`limit=1&cursor=${encodeURIComponent(String(cursor))}`));
    await expect(listOperationsPage({ db: db as never }, sameQuery, tenantId, (value) => ({ id: value['id'] as string }), changedOwner)).rejects.toThrow(/another authorized scope or filter/);
    const page = statements[0]!;
    expect(page.sql).toContain('deleted_at IS NULL');
    expect(page.sql).toContain('api_key_id = ANY($3::uuid[]) AND (profile_id IS NULL OR profile_id = ANY($2::uuid[]))');
    expect(page.params).toContain(tenantId);
  });

  test('requires the exact assigned key and assigned profile, while retaining legacy null-profile rows', async () => {
    const owner = { tenantId, userId: '66666666-6666-4666-8666-666666666666', roleVersion: 8, profileIds: [profileId], apiKeyIds: [apiKeyId] };
    const { db, statements } = listDb();
    await listOperationsPage({ db: db as never }, parseOperationsListQuery(new URLSearchParams('limit=10')), tenantId, (row) => row, owner);
    const page = statements[0]!;
    expect(page.sql).toContain(`api_key_id = ANY($3::uuid[]) AND (profile_id IS NULL OR profile_id = ANY($2::uuid[]))`);
    expect(page.params).toContainEqual([profileId]);
    expect(page.params).toContainEqual([apiKeyId]);

    // A second key may share this profile, but is outside the exact key set;
    // the SQL requires both grants for profiled rows and therefore excludes it.
    expect(page.sql).not.toContain('profile_id = ANY($2::uuid[]) OR');
    expect(page.sql).not.toContain('api_key_id IS NULL');
  });

  test('a profile grant without any exact key grant returns no local USER operations', async () => {
    const { db, statements } = listDb();
    await listOperationsPage({ db: db as never }, parseOperationsListQuery(new URLSearchParams('limit=10')), tenantId, (row) => row, {
      tenantId, userId: '66666666-6666-4666-8666-666666666666', roleVersion: 8, profileIds: [profileId], apiKeyIds: [],
    });
    expect(statements[0]!.sql).toContain('FALSE');
    expect(statements[0]!.sql).not.toContain('profile_id = ANY');
  });

  test('uses the same authoritative assigned population for Operations totals', async () => {
    const sql: string[] = [];
    const db = { query: jest.fn(async (statement: string) => { sql.push(statement); return { rows: [{
      sampled_at: new Date('2026-10-11T12:00:00.000Z'), total: '3', success: '1', failure: '1', cancelled: '0',
      timed_out: '0', running: '1', duration_samples: '2', p50_ms: 25, p95_ms: 80,
    }] }; }) };
    const result = await getOperationsMetrics({ db: db as never }, {
      from: '2026-10-11T00:00:00Z', to: '2026-10-11T23:59:59Z', tenantId,
    }, tenantId, { tenantId, userId: '66666666-6666-4666-8666-666666666666', roleVersion: 8, profileIds: [profileId], apiKeyIds: [apiKeyId] });
    expect(result.total).toBe(3);
    expect(sql[0]).toContain('deleted_at IS NULL');
    expect(sql[0]).toContain('api_key_id = ANY($5::uuid[]) AND (profile_id IS NULL OR profile_id = ANY($4::uuid[]))');
    expect(sql[0]).toContain('tenant_id = $3::uuid');
  });

  test('metrics require an exact key even when a local USER has profile grants', async () => {
    const sql: string[] = [];
    const db = { query: jest.fn(async (statement: string) => { sql.push(statement); return { rows: [{
      sampled_at: new Date('2026-10-11T12:00:00.000Z'), total: '0', success: '0', failure: '0', cancelled: '0',
      timed_out: '0', running: '0', duration_samples: '0', p50_ms: null, p95_ms: null,
    }] }; }) };
    await getOperationsMetrics({ db: db as never }, {
      from: '2026-10-11T00:00:00Z', to: '2026-10-11T23:59:59Z', tenantId,
    }, tenantId, { tenantId, userId: '66666666-6666-4666-8666-666666666666', roleVersion: 8, profileIds: [profileId], apiKeyIds: [] });
    expect(sql[0]).toContain('AND FALSE');
    expect(sql[0]).not.toContain('profile_id = ANY');
  });

  test('Admin Usage BFF preserves the original opaque session on events and summary reads', async () => {
    const sessionId = 'D'.repeat(43);
    const captured: Array<{ url: string; headers: Record<string, string> }> = [];
    const fetchImpl = jest.fn(async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({ url: String(input), headers: init?.headers as Record<string, string> });
      return new Response(JSON.stringify({ items: [], total: 0 }), { status: 200 });
    });
    const config = {
      oidcSessions: { get: jest.fn(async () => ({ role: 'operator' as const, csrfToken: 'session-csrf', tenantId, issuer: 'du-local', sub: 'local-user', roleVersion: 8 })) },
    };
    const runtime = { jsonBaseUrl: 'http://admin.internal', tenantAdminTokens: { 'tenant-service-token': tenantId }, fetchImpl };
    const request = { cookies: { du_session: sessionId } } as never;
    const makeResponse = () => ({ setHeader: jest.fn(), statusCode: 0, end: jest.fn() });
    const req = { method: 'GET', headers: {} } as never;
    const eventsRoute = matchOperationsRoute('/usage/events');
    const summaryRoute = matchOperationsRoute('/usage');
    const exportRoute = matchOperationsRoute('/usage/export');
    expect(eventsRoute).toEqual({ kind: 'usage-events' });
    expect(summaryRoute).toEqual({ kind: 'usage' });
    expect(exportRoute).toEqual({ kind: 'usage-export' });

    await handleOperationsRoute(req, makeResponse() as never, request, eventsRoute!, new URLSearchParams(
      `tenantId=${tenantId}&from=2026-10-11T00%3A00%3A00Z&to=2026-10-11T01%3A00%3A00Z`,
    ), config as never, runtime as never, 'usage-events-cookie-proof');
    await handleOperationsRoute(req, makeResponse() as never, request, summaryRoute!, new URLSearchParams(
      `tenantId=${tenantId}&from=2026-10-11T00%3A00%3A00Z&to=2026-10-11T01%3A00%3A00Z`,
    ), config as never, runtime as never, 'usage-summary-cookie-proof');
    await handleOperationsRoute(req, makeResponse() as never, request, exportRoute!, new URLSearchParams(
      `tenantId=${tenantId}&from=2026-10-11T00%3A00%3A00Z&to=2026-10-11T01%3A00%3A00Z&timeField=occurredAt&limit=100`,
    ), config as never, runtime as never, 'usage-export-cookie-proof');

    expect(captured).toHaveLength(3);
    expect(new URL(captured[0]!.url).pathname).toBe('/api/internal/usage/events');
    expect(new URL(captured[1]!.url).pathname).toBe('/api/internal/usage/summary');
    expect(new URL(captured[2]!.url).pathname).toBe('/api/internal/usage/export');
    expect(new URL(captured[2]!.url).searchParams.get('limit')).toBe('100');
    expect(new URL(captured[2]!.url).searchParams.get('timeField')).toBe('occurredAt');
    for (const call of captured) {
      expect(call.headers.cookie).toBe(`du_session=${sessionId}`);
      expect(call.headers['x-csrf-token']).toBe('session-csrf');
      expect(call.headers.authorization).toBe('Bearer tenant-service-token');
    }
  });

  test('an invalid opaque Usage session cannot fall back to its tenant bearer', async () => {
    const fetchImpl = jest.fn(async () => new Response('{}', { status: 200 }));
    const response = { setHeader: jest.fn(), statusCode: 0, end: jest.fn() };
    await handleOperationsRoute(
      { method: 'GET', headers: {} } as never,
      response as never,
      { cookies: { du_session: 'R'.repeat(43) } } as never,
      { kind: 'usage' },
      new URLSearchParams(`tenantId=${tenantId}&from=2026-10-11T00%3A00%3A00Z&to=2026-10-11T01%3A00%3A00Z`),
      { oidcSessions: { get: jest.fn(async () => null) } } as never,
      { jsonBaseUrl: 'http://admin.internal', tenantAdminTokens: { 'tenant-service-token': tenantId }, fetchImpl } as never,
      'usage-invalid-cookie',
    );
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(response.statusCode).toBe(401);
  });
});
