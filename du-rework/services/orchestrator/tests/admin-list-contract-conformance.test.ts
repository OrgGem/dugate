/**
 * W-ADMUX02-EXT-1 (ADM-UX-02 remaining surfaces): the audit and API-key admin
 * lists must answer the SAME page contract as the operations list, page in SQL
 * rather than in JavaScript, and keep the tenant fence in the database.
 *
 * Everything here is offline: the real route() is driven with a recording fake
 * db, so no PostgreSQL, Redis or socket is touched. The assertions are about
 * the emitted SQL and the response body validated against the published schema
 * - the same shape of check that closed T70-C1 for the operations list.
 */
import {
  ADMIN_AUDIT_LIST_QUERY_PARAMS,
  API_KEY_LIST_QUERY_PARAMS,
  AUDIT_SEVERITY_VALUES,
  API_KEY_STATUS_VALUES,
  ListPageBaseSchema,
  decodeListCursor,
} from '@du/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import { route, type RouteContext } from '../src/server';
import { __test as overviewTest } from '../src/app/admin/overview-section-data';
import { __test as apiKeyTest } from '../src/app/admin/api-key-section-data';

const ADMIN_TOKEN = 'admin-contract-token';
const OPERATOR_TOKEN = 'operator-contract-token';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const KEY_ID = 'cccccccc-3333-4333-8333-cccccccccccc';

interface Call { sql: string; params: unknown[] }

function result(rows: Record<string, unknown>[]): QueryResult<QueryResultRow> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as QueryResultRow[], fields: [] };
}

function auditRow(n: number, tenantId: string): Record<string, unknown> {
  const at = new Date(Date.UTC(2026, 8, 25, 9, 0, n)).toISOString();
  return {
    id: String(n).padStart(8, '0') + '-0000-4000-8000-000000000000',
    tenant_id: tenantId,
    actor: 'admin:ops',
    action: 'business.enable',
    resource: 'business:doc@1.0.0',
    severity: 'info',
    correlation_id: 'corr-' + n,
    created_at: at,
  };
}

function keyRow(n: number, tenantId: string): Record<string, unknown> {
  return {
    id: String(n).padStart(8, '0') + '-0000-4000-8000-000000000000',
    tenant_id: tenantId,
    prefix: 'du_live_ab' + n,
    status: 'ACTIVE',
    created_at: new Date(Date.UTC(2026, 8, 25, 8, 0, n)),
  };
}

interface Fixture {
  audit?: Record<string, unknown>[];
  auditTotal?: number;
  keys?: Record<string, unknown>[];
  keysTotal?: number;
  grants?: Record<string, unknown>[];
}

function ctxFor(input: {
  pathname: string;
  search: string;
  token?: string;
  fixture?: Fixture;
}): { ctx: RouteContext; calls: Call[] } {
  const calls: Call[] = [];
  const fx = input.fixture ?? {};
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params });
    const flat = sql.replace(/\s+/g, ' ');
    if (/FROM admin_audit_events/i.test(flat) && /count\(\*\)/i.test(flat)) {
      return result([{ total: fx.auditTotal ?? 0 }]);
    }
    if (/FROM admin_audit_events/i.test(flat)) return result(fx.audit ?? []);
    if (/FROM api_keys/i.test(flat) && /count\(\*\)/i.test(flat)) {
      return result([{ total: fx.keysTotal ?? 0 }]);
    }
    if (/FROM api_keys/i.test(flat)) return result(fx.keys ?? []);
    if (/FROM profile_bindings/i.test(flat)) return result(fx.grants ?? []);
    throw new Error('unexpected SQL in test: ' + flat.slice(0, 90));
  };
  return {
    calls,
    ctx: {
      method: 'GET',
      pathname: input.pathname,
      searchParams: new URLSearchParams(input.search),
      headers: { authorization: 'Bearer ' + (input.token ?? ADMIN_TOKEN) },
      config: { adminToken: ADMIN_TOKEN, tenantAdminTokens: { [OPERATOR_TOKEN]: TENANT_A } },
      db: { query },
    } as unknown as RouteContext,
  };
}

const AUDIT_PATH = '/api/v1/admin/audit';
const KEYS_PATH = '/api/v1/admin/api-keys';

async function audit(search: string, extra: { token?: string; fixture?: Fixture } = {}) {
  const h = ctxFor({ pathname: AUDIT_PATH, search, ...extra });
  const res = await route(h.ctx);
  return { body: res.body as Record<string, unknown>, calls: h.calls };
}

async function keys(search: string, extra: { token?: string; fixture?: Fixture } = {}) {
  const h = ctxFor({ pathname: KEYS_PATH, search, ...extra });
  const res = await route(h.ctx);
  return { body: res.body as Record<string, unknown>, calls: h.calls };
}

describe('ADM-UX-02 audit list: standard page envelope', () => {
  it('answers exactly the five contract fields', async () => {
    const { body } = await audit('tenantId=' + TENANT_A, {
      fixture: { audit: [auditRow(1, TENANT_A)], auditTotal: 7 },
    });
    expect(Object.keys(body).sort()).toEqual(['items', 'limit', 'nextCursor', 'prevCursor', 'total']);
    const parsed = ListPageBaseSchema.safeParse(body);
    if (!parsed.success) throw new Error('audit page violates the shared contract: ' + JSON.stringify(parsed.error.issues));
    expect(parsed.success).toBe(true);
  });

  it('total is the filtered count, not the number of rows returned', async () => {
    const { body } = await audit('tenantId=' + TENANT_A + '&limit=2', {
      fixture: { audit: [auditRow(1, TENANT_A), auditRow(2, TENANT_A)], auditTotal: 41 },
    });
    expect((body['items'] as unknown[]).length).toBe(2);
    expect(body['total']).toBe(41);
  });

  it('always bounds the read with a SQL LIMIT (no unbounded ledger scan)', async () => {
    const { calls } = await audit('tenantId=' + TENANT_A, { fixture: { audit: [] } });
    const page = calls.find((c) => /FROM admin_audit_events/i.test(c.sql) && !/count/i.test(c.sql));
    expect(page).toBeDefined();
    expect(page!.sql).toMatch(/LIMIT \$\d+$/i);
  });

  it('supports a keyset cursor both ways and the token decodes with the shared codec', async () => {
    const forward = await audit('tenantId=' + TENANT_A + '&limit=1', {
      fixture: {
        audit: [auditRow(2, TENANT_A), auditRow(3, TENANT_A)],
        auditTotal: 3,
      },
    });
    const nextCursor = forward.body['nextCursor'] as string;
    expect(typeof nextCursor).toBe('string');
    expect(decodeListCursor(nextCursor)?.direction).toBe('next');

    const second = await audit('tenantId=' + TENANT_A + '&limit=1&cursor=' + encodeURIComponent(nextCursor), {
      fixture: { audit: [auditRow(3, TENANT_A)], auditTotal: 3 },
    });
    const backPage = second.calls.find((c) => /FROM admin_audit_events/i.test(c.sql) && !/count/i.test(c.sql));
    expect(backPage!.sql).toMatch(/\(created_at, id\) < \(/i);
    const prevCursor = second.body['prevCursor'] as string;
    expect(prevCursor).toBeTruthy();
    expect(decodeListCursor(prevCursor)?.direction).toBe('prev');

    const back = await audit('tenantId=' + TENANT_A + '&limit=1&cursor=' + encodeURIComponent(prevCursor), {
      fixture: { audit: [auditRow(2, TENANT_A)], auditTotal: 3 },
    });
    const backSql = back.calls.find((c) => /FROM admin_audit_events/i.test(c.sql) && !/count/i.test(c.sql));
    expect(backSql!.sql).toMatch(/\(created_at, id\) > \(/i);
    expect(backSql!.sql).toMatch(/ORDER BY created_at ASC, id ASC/i);
  });

  it('first page reports no previous page', async () => {
    const { body } = await audit('tenantId=' + TENANT_A + '&limit=1', {
      fixture: { audit: [auditRow(1, TENANT_A), auditRow(2, TENANT_A)], auditTotal: 2 },
    });
    expect(body['prevCursor']).toBe(null);
  });
});

describe('ADM-UX-02 audit list: tenant fence and safe filters', () => {
  it('reads the tenant from the credential, and a foreign tenantId is a 403 before any query', async () => {
    const h = ctxFor({ pathname: AUDIT_PATH, search: 'tenantId=' + TENANT_B, token: OPERATOR_TOKEN });
    await expect(route(h.ctx)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'admin reads are scoped to the caller tenant',
    });
    expect(h.calls).toHaveLength(0);
  });

  it('pins a tenant operator to its own tenant in SQL', async () => {
    const { calls } = await audit('', { token: OPERATOR_TOKEN, fixture: { audit: [] } });
    const page = calls.find((c) => /FROM admin_audit_events/i.test(c.sql) && !/count/i.test(c.sql));
    expect(page!.sql).toMatch(/tenant_id = \$1/i);
    expect(page!.params[0]).toBe(TENANT_A);
    expect(page!.sql).not.toContain(TENANT_A);
  });

  it('with no tenant in scope it answers an honest empty page, not an unscoped read', async () => {
    const { body, calls } = await audit('');
    expect(body).toMatchObject({ items: [], total: 0, nextCursor: null, prevCursor: null });
    expect(calls).toHaveLength(0);
  });

  it('severity is an allow-list and reaches SQL only as a bound parameter', async () => {
    for (const value of AUDIT_SEVERITY_VALUES) {
      const { calls } = await audit('tenantId=' + TENANT_A + '&severity=' + value, { fixture: { audit: [] } });
      const page = calls.find((c) => /FROM admin_audit_events/i.test(c.sql) && !/count/i.test(c.sql));
      expect(page!.sql).toMatch(/severity = \$2/i);
      expect(page!.sql).not.toContain(value);
      expect(page!.params).toContain(value);
    }
    // The count query must see the SAME filter, or the number lies.
    const { calls } = await audit('tenantId=' + TENANT_A + '&severity=error', { fixture: { audit: [] } });
    const counted = calls.find((c) => /count\(\*\)/i.test(c.sql));
    expect(counted!.sql).toMatch(/severity = \$2/i);
    expect(counted!.params).toContain('error');
  });

  it('rejects an out-of-allow-list severity, a non-uuid tenant and an invalid cursor', async () => {
    await expect(route(ctxFor({ pathname: AUDIT_PATH, search: 'tenantId=' + TENANT_A + '&severity=NOPE' }).ctx)).rejects.toMatchObject({ status: 422 });
    await expect(route(ctxFor({ pathname: AUDIT_PATH, search: 'tenantId=not-a-uuid' }).ctx)).rejects.toMatchObject({ status: 422 });
    await expect(route(ctxFor({ pathname: AUDIT_PATH, search: 'tenantId=' + TENANT_A + '&cursor=%24%24%24' }).ctx)).rejects.toMatchObject({ status: 422 });
  });

  it('reads exactly the declared audit parameters and ignores anything else', async () => {
    expect([...ADMIN_AUDIT_LIST_QUERY_PARAMS]).toEqual(['tenantId', 'limit', 'cursor', 'severity', 'action']);
    await expect(
      route(ctxFor({ pathname: AUDIT_PATH, search: 'tenantId=' + TENANT_A + "&actor=' OR 1=1--" }).ctx),
    ).resolves.toMatchObject({ status: 200 });
  });
});

describe('ADM-UX-02 api-keys list: pages in SQL instead of loading all', () => {
  it('adds a SQL LIMIT and a SQL tenant predicate (was: no LIMIT, filter in JS)', async () => {
    const { calls, body } = await keys('tenantId=' + TENANT_A, {
      fixture: { keys: [keyRow(1, TENANT_A)], keysTotal: 12 },
    });
    const page = calls.find((c) => /FROM api_keys/i.test(c.sql));
    expect(page!.sql).toMatch(/tenant_id = \$1/i);
    expect(page!.sql).toMatch(/LIMIT \$\d+$/i);
    expect(body['total']).toBe(12);
  });

  it('answers the five page fields plus the key pane payload', async () => {
    const { body } = await keys('tenantId=' + TENANT_A, {
      fixture: { keys: [keyRow(1, TENANT_A)], keysTotal: 1, grants: [] },
    });
    expect(Object.keys(body).sort()).toEqual(['createCopyOnce', 'grants', 'items', 'limit', 'nextCursor', 'prevCursor', 'total']);
    expect(ListPageBaseSchema.safeParse(body).success).toBe(true);
    const first = (body['items'] as Record<string, unknown>[])[0];
    expect(first?.['prefix']).toBe('du_live_ab1');
  });

  it('never puts a raw key on the wire', async () => {
    const { body, calls } = await keys('tenantId=' + TENANT_A, {
      fixture: { keys: [keyRow(1, TENANT_A)], keysTotal: 1 },
    });
    const json = JSON.stringify(body);
    expect(json).not.toMatch(/"hash"/);
    for (const c of calls) expect(c.sql).not.toMatch(/SELECT[\s\S]*hash/i);
  });

  it('status is an allow-list; prefix is a bound substring, not LIKE', async () => {
    for (const status of API_KEY_STATUS_VALUES) {
      const { calls } = await keys('tenantId=' + TENANT_A + '&status=' + status, { fixture: { keys: [] } });
      const page = calls.find((c) => /FROM api_keys/i.test(c.sql));
      expect(page!.sql).toMatch(/status = \$2/i);
      expect(page!.params).toContain(status);
    }
    const prefixed = await keys('tenantId=' + TENANT_A + '&prefix=AB2', { fixture: { keys: [] } });
    const p = prefixed.calls.find((c) => /FROM api_keys/i.test(c.sql));
    expect(p!.sql).toMatch(/strpos\(lower\(prefix\), lower\(\$2\)\) > 0/i);
    expect(p!.sql).not.toMatch(/LIKE/i);
    await expect(route(ctxFor({ pathname: KEYS_PATH, search: 'tenantId=' + TENANT_A + '&status=LOADED' }).ctx)).rejects.toMatchObject({ status: 422 });
  });

  it('refuses a pasted secret as a search term', async () => {
    const secret = 'deadbeef'.repeat(5);
    await expect(route(ctxFor({ pathname: KEYS_PATH, search: 'tenantId=' + TENANT_A + '&prefix=' + secret }).ctx)).rejects.toMatchObject({ status: 422 });
  });

  it('a foreign tenant for an operator is a 403 before any query', async () => {
    const h = ctxFor({ pathname: KEYS_PATH, search: 'tenantId=' + TENANT_B, token: OPERATOR_TOKEN });
    await expect(route(h.ctx)).rejects.toMatchObject({ status: 403 });
    expect(h.calls).toHaveLength(0);
  });

  it('by-id read is still tenant-fenced and answers a one-item page', async () => {
    const own = ctxFor({
      pathname: KEYS_PATH + '/' + KEY_ID,
      search: '',
      token: OPERATOR_TOKEN,
      fixture: { keys: [keyRow(1, TENANT_A)], keysTotal: 1 },
    });
    const res = await route(own.ctx);
    expect((res.body as Record<string, unknown>)['items']).toHaveLength(1);

    const foreign = ctxFor({
      pathname: KEYS_PATH + '/' + KEY_ID,
      search: '',
      token: OPERATOR_TOKEN,
      fixture: { keys: [keyRow(1, TENANT_B)] },
    });
    await expect(route(foreign.ctx)).rejects.toMatchObject({ status: 404 });
  });

  it('reads exactly the declared api-key parameters', async () => {
    expect([...API_KEY_LIST_QUERY_PARAMS]).toEqual(['tenantId', 'limit', 'cursor', 'status', 'prefix', 'sort']);
  });
});

/**
 * The link that actually breaks a pane: the route emits one key and the fetcher
 * reads another. Both sides typecheck and every pure view-model test stays green
 * while the operator sees an empty list, so it is tested explicitly: a real route
 * response fed straight into the real fetcher parser.
 */
describe('ADM-UX02-EXT-1: route response still feeds the shell pane', () => {
  it('the overview pane reads the audit page envelope emitted by the route', async () => {
    const { body } = await audit('tenantId=' + TENANT_A, {
      fixture: { audit: [auditRow(1, TENANT_A), auditRow(2, TENANT_A)], auditTotal: 2 },
    });
    const parsed = overviewTest.normaliseAuditEvents(body as never, TENANT_A);
    expect(parsed.events).toHaveLength(2);
    expect(parsed.events[0]?.id).toBe('00000001-0000-4000-8000-000000000000');
  });

  it('a legacy { tenantId, events } body still renders (degrades, not a blank pane)', async () => {
    const legacy = { tenantId: TENANT_A, events: [auditRow(1, TENANT_A)] };
    const parsed = overviewTest.normaliseAuditEvents(legacy as never, TENANT_A);
    expect(parsed.events).toHaveLength(1);
  });

  it('the key pane reads the api-keys page envelope emitted by the route', async () => {
    const { body } = await keys('tenantId=' + TENANT_A, {
      fixture: {
        keys: [keyRow(1, TENANT_A), keyRow(2, TENANT_A)],
        keysTotal: 2,
        grants: [
          {
            api_key_id: '00000001-0000-4000-8000-000000000000',
            business_id: 'document-core',
            business_version: '1.0.0',
            action: 'review',
            created_at: new Date(Date.UTC(2026, 8, 25, 10)),
          },
        ],
      },
    });
    const parsed = apiKeyTest.parseFetchPayload(body, '') as Record<string, unknown>;
    expect(parsed['kind']).toBe('ok');
    const rows = parsed['rows'] as Record<string, unknown>[];
    expect(rows).toHaveLength(2);
    expect(rows[0]?.prefix).toBe('du_live_ab1');
  });

  it('a legacy { rows, grants } body still renders', () => {
    const legacy = {
      rows: [
        { id: KEY_ID, tenantId: TENANT_A, prefix: 'du_live_zz', maskedHint: 'du_live_zz', status: 'ACTIVE', createdAt: '2026-09-25T08:00:00.000Z' },
      ],
      grants: [],
      createCopyOnce: null,
    };
    const parsed = apiKeyTest.parseFetchPayload(legacy, '') as Record<string, unknown>;
    const rows = parsed['rows'] as Record<string, unknown>[];
    expect(rows).toHaveLength(1);
  });
});
