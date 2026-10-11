import http from 'node:http';
import { createServer, type Server } from 'node:http';
import {
  ListOperationsQuerySchema,
  OPERATIONS_LIST_QUERY_PARAMS,
} from '@du/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import { route, type RouteContext } from '../src/server';
import { createAdminShellServer, type AdminShellHandle } from '../src/app/admin/shell-server';
import { signCookie } from '../src/app/admin/shell-auth';

const ADMIN_TOKEN = 'or10-time-filter-admin-token';
const COOKIE_SECRET = 'or10-time-filter-cookie-secret';
const FROM = '2026-09-01T00:00:00.000001Z';
const TO = '2026-09-30T23:59:59Z';

interface QueryCall {
  sql: string;
  params: unknown[];
}

function pgResult(rows: Record<string, unknown>[]): QueryResult<QueryResultRow> {
  return {
    command: 'SELECT',
    rowCount: rows.length,
    oid: 0,
    rows: rows as QueryResultRow[],
    fields: [],
  };
}

function operationRow(): Record<string, unknown> {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    tenant_id: 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
    business_id: 'example-review',
    business_version: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    state_version: 1,
    created_at: '2026-09-15T12:00:00.000Z',
    updated_at: '2026-09-15T12:00:00.000Z',
    deadline_at: null,
    result_ref: null,
  };
}

function routeContext(search: string, calls: QueryCall[]): RouteContext {
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params });
    if (/SELECT count\(\*\)::int AS total FROM operations/i.test(sql)) {
      return pgResult([{ total: 1 }]);
    }
    if (/^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i.test(sql)) {
      return pgResult([operationRow()]);
    }
    throw new Error('unexpected operations-list SQL: ' + sql);
  };
  return {
    method: 'GET',
    pathname: '/api/v1/operations',
    searchParams: new URLSearchParams(search),
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN },
    config: { adminToken: ADMIN_TOKEN },
    db: { query },
  } as unknown as RouteContext;
}

function request(url: string, cookie: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const req = http.request(
      {
        hostname: parsed.hostname,
        port: parsed.port,
        path: parsed.pathname + parsed.search,
        method: 'GET',
        headers: { cookie },
        agent: false,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => resolve({
          status: res.statusCode ?? 0,
          body: Buffer.concat(chunks).toString('utf8'),
        }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

describe('AWEB-20a Operations UTC time filter', () => {
  it('adds from/to to the contract and validates real UTC instants', () => {
    expect([...OPERATIONS_LIST_QUERY_PARAMS]).toContain('from');
    expect([...OPERATIONS_LIST_QUERY_PARAMS]).toContain('to');
    expect(ListOperationsQuerySchema.safeParse({ from: FROM, to: TO }).success).toBe(true);
    expect(ListOperationsQuerySchema.safeParse({ from: '2026-09-01T00:00:00+07:00' }).success).toBe(false);
    expect(ListOperationsQuerySchema.safeParse({ from: '2026-02-30T00:00:00Z' }).success).toBe(false);
  });

  it('binds inclusive created_at predicates in both page and count queries', async () => {
    const calls: QueryCall[] = [];
    const response = await route(routeContext(`from=${FROM}&to=${TO}`, calls));
    expect(response.status).toBe(200);

    const page = calls.find((call) => /^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i.test(call.sql));
    const count = calls.find((call) => /SELECT count\(\*\)::int AS total FROM operations/i.test(call.sql));
    expect(page).toBeDefined();
    expect(count).toBeDefined();
    expect(page!.sql).toMatch(/created_at >= \$1::timestamptz/i);
    expect(page!.sql).toMatch(/created_at <= \$2::timestamptz/i);
    expect(page!.sql).not.toContain('2026-09-01');
    expect(page!.params.slice(0, 2)).toEqual([FROM, TO]);
    expect(count!.sql).toMatch(/created_at >= \$1::timestamptz/i);
    expect(count!.sql).toMatch(/created_at <= \$2::timestamptz/i);
    expect(count!.params).toEqual([FROM, TO]);
  });

  it('rejects malformed, non-UTC, impossible and inverted bounds with 422 before querying', async () => {
    const invalidSearches = [
      'from=yesterday',
      'from=2026-09-01T00:00:00%2B07:00',
      'from=2026-02-30T00:00:00Z',
      'from=2026-09-01T00:00:00.000002Z&to=2026-09-01T00:00:00.000001Z',
    ];
    for (const search of invalidSearches) {
      const calls: QueryCall[] = [];
      await expect(route(routeContext(search, calls))).rejects.toMatchObject({
        status: 422,
        code: 'INVALID_SCHEMA',
      });
      expect(calls).toHaveLength(0);
    }
  });

  it('keeps either side independently optional', async () => {
    const lowerCalls: QueryCall[] = [];
    await route(routeContext(`from=${FROM}`, lowerCalls));
    const lowerPage = lowerCalls.find((call) => /^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i.test(call.sql));
    expect(lowerPage?.sql).toMatch(/created_at >= \$1::timestamptz/i);
    expect(lowerPage?.sql).not.toMatch(/created_at <=/i);

    const upperCalls: QueryCall[] = [];
    await route(routeContext(`to=${TO}`, upperCalls));
    const upperPage = upperCalls.find((call) => /^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i.test(call.sql));
    expect(upperPage?.sql).toMatch(/created_at <= \$1::timestamptz/i);
    expect(upperPage?.sql).not.toMatch(/created_at >=/i);
  });
});

describe('AWEB-20a Operations BFF time-filter forwarding', () => {
  let upstream: Server;
  let app: AdminShellHandle;
  let baseUrl: string;
  let cookie: string;
  const requests: string[] = [];

  beforeAll(async () => {
    upstream = createServer((req, res) => {
      requests.push(req.url ?? '/');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ items: [], nextCursor: null, prevCursor: null, total: 0, limit: 20 }));
    });
    await new Promise<void>((resolve) => upstream.listen(0, '127.0.0.1', resolve));
    const upstreamAddress = upstream.address();
    if (!upstreamAddress || typeof upstreamAddress === 'string') throw new Error('upstream did not bind a TCP port');

    app = createAdminShellServer({
      port: 0,
      host: '127.0.0.1',
      cookieSecret: COOKIE_SECRET,
      adminToken: ADMIN_TOKEN,
      jsonBaseUrl: `http://127.0.0.1:${upstreamAddress.port}`,
      adminWeb: { distDir: 'Z:/does-not-exist' },
      cookiePolicy: { trustProxyProtocol: false, requireSecure: false },
    });
    const bound = await app.listen();
    baseUrl = bound.url;
    const now = Date.now();
    const signed = signCookie(COOKIE_SECRET, {
      iss: 'du-admin-shell',
      role: 'admin',
      iat: now,
      exp: now + 3_600_000,
    });
    if (!signed) throw new Error('could not sign test admin cookie');
    cookie = `du_admin=${signed}`;
  });

  afterAll(async () => {
    await app?.close();
    if (upstream?.listening) {
      await new Promise<void>((resolve, reject) => upstream.close((error) => error ? reject(error) : resolve()));
    }
  });

  it('forwards from/to through the allowlist and drops unknown query keys', async () => {
    const response = await request(
      `${baseUrl}/admin/api/operations?from=${FROM}&to=${TO}&ignored=drop-me`,
      cookie,
    );
    expect(response.status).toBe(200);
    const forwarded = new URL(requests[0] ?? '/', 'http://upstream.test');
    expect(forwarded.pathname).toBe('/api/v1/operations');
    expect(forwarded.searchParams.get('from')).toBe(FROM);
    expect(forwarded.searchParams.get('to')).toBe(TO);
    expect(forwarded.searchParams.has('ignored')).toBe(false);
  });
});
