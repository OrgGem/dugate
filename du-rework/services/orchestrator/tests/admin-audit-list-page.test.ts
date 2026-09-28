/**
 * W-ADM-UX-02-AUDIT-PAGE: the audit list gains the filter set ADM-UX-02 names
 * (time, actor, action, resource, severity) and a sort allowlist, and every one
 * of them is a BOUND parameter inside a tenant-scoped keyset page.
 *
 * Everything here is offline. The real route() is driven against a recording
 * fake db, so the assertions are about the SQL the route actually emits and
 * the body it actually returns - not about a re-implementation of either.
 */
import {
  ADMIN_AUDIT_LIST_SORT_VALUES,
  ADMIN_AUDIT_LIST_QUERY_PARAMS,
  AUDIT_SEVERITY_VALUES,
  ListPageBaseSchema,
  decodeAdminResourceListSortCursor,
  encodeAdminResourceListSortCursor,
} from '@du/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import { route, type RouteContext } from '../src/server';

const ADMIN_TOKEN = 'admin-audit-page-token';
const OPERATOR_TOKEN = 'operator-audit-page-token';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const AUDIT_PATH = '/api/v1/admin/audit';

interface CtxForInput {
  search: string;
  token?: string;
  rows?: Record<string, unknown>[];
  total?: number;
  pathname?: string;
}

interface Call {
  sql: string;
  params: unknown[];
}

// A pasted raw API key is solid 32+ hex, the one value class every admin list
// refuses as a search term.
const SECRET = `deadbeef`.repeat(5);

function result(rows: Record<string, unknown>[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows: rows as QueryResultRow[],
    fields: [],
  };
}

function auditRow(n: number, tenantId: string, over: Partial<Record<string, unknown>> = {}) {
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
    created_at_cursor: at.replace('Z', '000Z'),
    ...over,
  };
}

function ctxFor(input: CtxForInput): { ctx: RouteContext; calls: Call[] } {
  const calls: Call[] = [];
  const rows = input.rows ?? [];
  const total = input.total ?? rows.length;
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params });
    const flat = sql.replace(/\s+/g, ' ');
    if (!/FROM admin_audit_events/i.test(flat)) {
      throw new Error('unexpected SQL in test: ' + flat.slice(0, 120));
    }
    if (/count\(\*\)/i.test(flat)) return result([{ total }]);
    return result(rows);
  };
  return {
    calls,
    ctx: {
      method: 'GET',
      pathname: input.pathname ?? AUDIT_PATH,
      searchParams: new URLSearchParams(input.search),
      headers: { authorization: 'Bearer ' + (input.token ?? ADMIN_TOKEN) },
      config: {
        adminToken: ADMIN_TOKEN,
        tenantAdminTokens: { [OPERATOR_TOKEN]: TENANT_A },
      },
      db: { query },
    } as unknown as RouteContext,
  };
}

async function page(search: string, extra: Omit<CtxForInput, 'search'> = {}) {
  const h = ctxFor({ ...extra, search });
  const res = await route(h.ctx);
  return { body: res.body as Record<string, unknown>, calls: h.calls };
}

const pageCall = (calls: Call[]): Call => {
  const found = calls.find((c) => !/count\(\*\)/i.test(c.sql));
  if (!found) throw new Error('no page query was issued');
  return found;
};

const countCall = (calls: Call[]): Call => {
  const found = calls.find((c) => /count\(\*\)/i.test(c.sql));
  if (!found) throw new Error('no count query was issued');
  return found;
};

const rejects = (search: string, token?: string) =>
  expect(route(ctxFor({ search, token }).ctx)).rejects.toMatchObject({
    status: 422,
    code: 'INVALID_SCHEMA',
  });

describe('ADM-UX-02 audit page: time window', () => {
  it('from and to are bound timestamps on created_at, never inlined', async () => {
    const { calls } = await page(
      `tenantId=${TENANT_A}&from=2026-09-01T00:00:00Z&to=2026-09-30T23:59:59Z`,
    );
    const pg = pageCall(calls);
    expect(pg.sql).toMatch(/created_at >= \$2::timestamptz/i);
    expect(pg.sql).toMatch(/created_at <= \$3::timestamptz/i);
    expect(pg.sql).not.toContain('2026-09-01');
    expect(pg.params.slice(0, 3)).toEqual([TENANT_A, '2026-09-01T00:00:00Z', '2026-09-30T23:59:59Z']);
  });

  it('the count query carries the SAME window, or total lies', async () => {
    const { calls } = await page(`tenantId=${TENANT_A}&from=2026-09-10T00:00:00Z`, { total: 41 });
    const c = countCall(calls);
    expect(c.sql).toMatch(/created_at >= \$2::timestamptz/i);
    expect(c.params).toContain('2026-09-10T00:00:00Z');
  });

  it('an open-ended window keeps the other side unbounded', async () => {
    const lower = await page(`tenantId=${TENANT_A}&from=2026-09-10T00:00:00Z`);
    expect(pageCall(lower.calls).sql).toMatch(/created_at >= \$2::timestamptz/i);
    expect(pageCall(lower.calls).sql).not.toMatch(/created_at <=/i);
    const upper = await page(`tenantId=${TENANT_A}&to=2026-09-10T00:00:00Z`);
    expect(pageCall(upper.calls).sql).toMatch(/created_at <= \$2::timestamptz/i);
    expect(pageCall(upper.calls).sql).not.toMatch(/created_at >=/i);
  });

  it('an empty bound is no filter at all, not a filter on the empty string', async () => {
    const { calls } = await page(`tenantId=${TENANT_A}&from=&to=`);
    expect(pageCall(calls).sql).not.toMatch(/created_at [<>]=/i);
  });

  it('refuses a non-instant, a non-UTC stamp and an inverted window', async () => {
    await rejects(`tenantId=${TENANT_A}&from=yesterday`);
    await rejects(`tenantId=${TENANT_A}&to=2026-09-30`);
    // Date.parse rolls this over into March; the calendar check is what refuses it.
    await rejects(`tenantId=${TENANT_A}&from=2026-02-30T00:00:00Z`);
    // A local-time stamp is ambiguous against a UTC ledger and is not accepted.
    await rejects(`tenantId=${TENANT_A}&from=2026-09-01T00:00:00+07:00`);
    await rejects(`tenantId=${TENANT_A}&from=2026-09-30T00:00:00Z&to=2026-09-01T00:00:00Z`);
  });

  it('a rejected window is refused before any query runs', async () => {
    const h = ctxFor({ search: `tenantId=${TENANT_A}&from=nope` });
    await expect(route(h.ctx)).rejects.toMatchObject({ status: 422 });
    expect(h.calls).toHaveLength(0);
  });
});

describe('ADM-UX-02 audit page: actor and resource filters', () => {
  it('actor and resource are bound substring predicates, not LIKE', async () => {
    const { calls } = await page(`tenantId=${TENANT_A}&actor=ops&resource=business:doc`);
    const pg = pageCall(calls);
    expect(pg.sql).toMatch(/strpos\(lower\(actor\), lower\(\$2\)\) > 0/i);
    expect(pg.sql).toMatch(/strpos\(lower\(resource\), lower\(\$3\)\) > 0/i);
    expect(pg.sql).not.toMatch(/LIKE/i);
    expect(pg.params.slice(0, 3)).toEqual([TENANT_A, 'ops', 'business:doc']);
  });

  it('the count query carries the same actor and resource predicates', async () => {
    const { calls } = await page(`tenantId=${TENANT_A}&actor=ops&resource=doc`);
    const c = countCall(calls);
    expect(c.sql).toMatch(/strpos\(lower\(actor\), lower\(\$2\)\) > 0/i);
    expect(c.sql).toMatch(/strpos\(lower\(resource\), lower\(\$3\)\) > 0/i);
  });

  it('refuses a pasted secret as a search term, like every other admin list', async () => {
    await rejects(`tenantId=${TENANT_A}&actor=${SECRET}`);
    await rejects(`tenantId=${TENANT_A}&resource=${SECRET}`);
  });

  it('an injection-shaped value is a 422 and never reaches SQL', async () => {
    const h = ctxFor({ search: `tenantId=${TENANT_A}&actor=${"' OR 1=1--"}` });
    await expect(route(h.ctx)).rejects.toMatchObject({ status: 422 });
    expect(h.calls).toHaveLength(0);
  });

  it('all five filters combine into one page with sequential placeholders', async () => {
    const { calls } = await page(
      `tenantId=${TENANT_A}` +
        `&severity=warning&action=business&actor=ops&resource=doc` +
        `&from=2026-09-01T00:00:00Z&to=2026-09-30T00:00:00Z`,
    );
    const pg = pageCall(calls);
    expect(pg.sql).toMatch(/tenant_id = \$1/i);
    expect(pg.sql).toMatch(/severity = \$2/i);
    expect(pg.sql).toMatch(/strpos\(lower\(action\), lower\(\$3\)\) > 0/i);
    expect(pg.sql).toMatch(/strpos\(lower\(actor\), lower\(\$4\)\) > 0/i);
    expect(pg.sql).toMatch(/strpos\(lower\(resource\), lower\(\$5\)\) > 0/i);
    expect(pg.sql).toMatch(/created_at >= \$6::timestamptz/i);
    expect(pg.sql).toMatch(/created_at <= \$7::timestamptz/i);
    expect(pg.params.slice(0, 7)).toEqual([
      TENANT_A, 'warning', 'business', 'ops', 'doc',
      '2026-09-01T00:00:00Z', '2026-09-30T00:00:00Z',
    ]);
  });

  it('severity is still a closed enum, not a free substring', async () => {
    await rejects(`tenantId=${TENANT_A}&severity=NOPE`);
  });
});

describe('ADM-UX-02 audit page: sort allowlist', () => {
  it('the allowlist is the two createdAt directions, defaulting to desc', () => {
    expect([...ADMIN_AUDIT_LIST_SORT_VALUES]).toEqual(['createdAt:asc', 'createdAt:desc']);
  });

  it('an absent sort scans newest first', async () => {
    const { calls } = await page(`tenantId=${TENANT_A}`);
    expect(pageCall(calls).sql).toMatch(/ORDER BY created_at DESC, id DESC/i);
  });

  it('createdAt:asc reverses the scan direction', async () => {
    const { calls } = await page(`tenantId=${TENANT_A}&sort=createdAt:asc`);
    const pg = pageCall(calls);
    expect(pg.sql).toMatch(/ORDER BY created_at ASC, id ASC/i);
    // No cursor yet, so there is no boundary clause; the direction shows
    // up in the ORDER BY, and the next page carries the comparison.
    expect(pg.sql).not.toMatch(/\(created_at, id\)/i);
  });

  it('a backward probe reverses the scan and flips the comparison', async () => {
    const cursor = encodeAdminResourceListSortCursor({
      timestamp: '2026-09-25T09:00:02.000000Z',
      id: '00000002-0000-4000-8000-000000000000',
      direction: 'prev',
      sort: 'createdAt:desc',
    });
    const { calls } = await page(`tenantId=${TENANT_A}&cursor=${encodeURIComponent(cursor)}`);
    const pg = pageCall(calls);
    expect(pg.sql).toMatch(/ORDER BY created_at ASC, id ASC/i);
    expect(pg.sql).toMatch(/\(created_at, id\) > \(/i);
  });

  it('refuses a sort outside the allowlist instead of falling back silently', async () => {
    await rejects(`tenantId=${TENANT_A}&sort=severity:asc`);
    await rejects(`tenantId=${TENANT_A}&sort=created_at:desc`);
    await rejects(`tenantId=${TENANT_A}&sort=actor`);
    // admin_audit_events has no updated_at (migration 0010), so this is refused
    // by the allowlist rather than becoming an ORDER BY over a missing column.
    await rejects(`tenantId=${TENANT_A}&sort=updatedAt:desc`);
  });

  it('a cursor minted under another sort is a 422, not a wrong page', async () => {
    const cursor = encodeAdminResourceListSortCursor({
      timestamp: '2026-09-25T09:00:02.000000Z',
      id: '00000002-0000-4000-8000-000000000000',
      direction: 'next',
      sort: 'createdAt:asc',
    });
    await rejects(`tenantId=${TENANT_A}&sort=createdAt:desc&cursor=${encodeURIComponent(cursor)}`);
  });

  it('the same cursor replays cleanly under the sort it was minted for', async () => {
    const cursor = encodeAdminResourceListSortCursor({
      timestamp: '2026-09-25T09:00:02.000000Z',
      id: '00000002-0000-4000-8000-000000000000',
      direction: 'next',
      sort: 'createdAt:desc',
    });
    const { body, calls } = await page(
      `tenantId=${TENANT_A}&sort=createdAt:desc&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(pageCall(calls).sql).toMatch(/\(created_at, id\) < \(/i);
    expect(body['items']).toHaveLength(0);
  });

  it('a malformed cursor is a 422 before any query', async () => {
    const h = ctxFor({ search: `tenantId=${TENANT_A}&cursor=%24%24%24` });
    await expect(route(h.ctx)).rejects.toMatchObject({ status: 422 });
    expect(h.calls).toHaveLength(0);
  });

  it('the next cursor the route mints decodes with the shared codec and carries its sort', async () => {
    const { body } = await page(`tenantId=${TENANT_A}&limit=1`, {
      rows: [auditRow(2, TENANT_A), auditRow(3, TENANT_A)],
      total: 3,
    });
    const next = body['nextCursor'] as string;
    expect(typeof next).toBe('string');
    const decoded = decodeAdminResourceListSortCursor(next);
    expect(decoded?.direction).toBe('next');
    expect(decoded?.sort).toBe('createdAt:desc');
    expect(decoded?.id).toBe('00000002-0000-4000-8000-000000000000');
  });

  it('the first page advertises no previous page', async () => {
    const { body } = await page(`tenantId=${TENANT_A}&limit=1`, {
      rows: [auditRow(1, TENANT_A), auditRow(2, TENANT_A)],
      total: 2,
    });
    expect(body['prevCursor']).toBe(null);
  });
});

describe('ADM-UX-02 audit page: envelope, tenant fence and page bounds', () => {
  it('answers exactly the five contract fields under every filter', async () => {
    const { body } = await page(
      `tenantId=${TENANT_A}&severity=warning&actor=ops` +
        `&from=2026-09-01T00:00:00Z&sort=createdAt:asc`,
      { rows: [auditRow(1, TENANT_A, { severity: 'warning' })], total: 7 },
    );
    expect(Object.keys(body).sort()).toEqual(['items', 'limit', 'nextCursor', 'prevCursor', 'total']);
    const parsed = ListPageBaseSchema.safeParse(body);
    if (!parsed.success) {
      throw new Error('audit page violates the shared contract: ' + JSON.stringify(parsed.error.issues));
    }
    expect(body['total']).toBe(7);
  });

  it('the tenant predicate stays first and the tenant is never inlined', async () => {
    const { calls } = await page(`tenantId=${TENANT_A}&actor=ops`);
    const pg = pageCall(calls);
    expect(pg.sql).toMatch(/tenant_id = \$1/i);
    expect(pg.sql).not.toContain(TENANT_A);
    expect(pg.params[0]).toBe(TENANT_A);
  });

  it('a tenant operator is pinned to its own tenant, and a foreign id is a 403 before any query', async () => {
    const own = await page(`&actor=ops`, { token: OPERATOR_TOKEN, rows: [auditRow(1, TENANT_A)] });
    expect(pageCall(own.calls).params[0]).toBe(TENANT_A);

    const foreign = ctxFor({ search: `tenantId=${TENANT_B}`, token: OPERATOR_TOKEN });
    await expect(route(foreign.ctx)).rejects.toMatchObject({ status: 403 });
    expect(foreign.calls).toHaveLength(0);
  });

  it('limit clamps instead of 422-ing, and every page is SQL-bounded', async () => {
    for (const raw of ['0', '99999', 'abc']) {
      const { body, calls } = await page(`tenantId=${TENANT_A}&limit=${raw}`);
      expect(pageCall(calls).sql).toMatch(/LIMIT \$\d+$/i);
      expect(typeof body['limit']).toBe('number');
    }
  });

  it('the declared parameter set is the contract, and everything else is ignored', async () => {
    expect([...ADMIN_AUDIT_LIST_QUERY_PARAMS]).toEqual([
      'tenantId', 'limit', 'cursor', 'severity', 'action',
      'actor', 'resource', 'from', 'to', 'sort',
    ]);
    const h = ctxFor({ search: `tenantId=${TENANT_A}&note=whatever` });
    const res = await route(h.ctx);
    expect(res.status).toBe(200);
    for (const c of h.calls) expect(c.sql).not.toContain('whatever');
  });

  it('no tenant in scope is an honest empty page, not an unscoped read', async () => {
    const { body, calls } = await page(`&actor=ops`, { rows: [auditRow(1, TENANT_A)] });
    expect(body['items']).toEqual([]);
    expect(body['total']).toBe(0);
    expect(calls).toHaveLength(0);
  });

  it('a filter value never reaches the SQL text', async () => {
    const { calls } = await page(
      `tenantId=${TENANT_A}&actor=ops&resource=business:doc` +
        `&action=business&from=2026-09-01T00:00:00Z`,
    );
    for (const c of calls) {
      expect(c.sql).not.toContain('ops');
      expect(c.sql).not.toContain('business:doc');
      expect(c.sql).not.toContain('2026-09-01');
    }
  });

  it('every severity in the contract is still accepted and stays bound', async () => {
    for (const value of AUDIT_SEVERITY_VALUES) {
      const { calls } = await page(`tenantId=${TENANT_A}&severity=${value}`);
      const pg = pageCall(calls);
      expect(pg.sql).toMatch(/severity = \$2/i);
      expect(pg.sql).not.toContain(value);
      expect(pg.params).toContain(value);
    }
  });
});
