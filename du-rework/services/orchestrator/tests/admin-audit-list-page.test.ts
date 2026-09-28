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

interface Call {
  sql: string;
  params: unknown[];
}

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

function ctxFor(input: {
  search: string;
  token?: string;
  rows?: Record<string, unknown>[];
  total?: number;
  pathname?: string;
}): { ctx: RouteContext; calls: Call[] } {
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

async function page(search: string, extra: Parameters<typeof ctxFor>[0] = {}) {
  const h = ctxFor({ search, ...extra });
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
