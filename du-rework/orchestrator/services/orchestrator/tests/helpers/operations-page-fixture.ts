import type { OperationDetailCatalogEntry } from '../../src/app/admin/operation-section-data';
import type { OperationDetail } from '@du/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import type { RouteContext } from '../../src/server';

export function off(n: number): string {
  return `off:${n.toString(36)}`;
}

export function makeOp(id: string, overrides: Partial<OperationDetail> = {}): OperationDetail {
  return {
    id,
    tenantId: 'tenant-1',
    businessId: 'example-review',
    businessVersion: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    stateVersion: 1,
    createdAt: '2026-09-25T00:00:00Z',
    updatedAt: '2026-09-25T00:01:00Z',
    deadlineAt: null,
    replayOf: null,
    progress: { percent: 42, message: '' },
    links: { self: `/api/v1/operations/${id}`, result: `/api/v1/operations/${id}/result` },
    wait: null,
    error: null,
    ...overrides,
  };
}

export function catalogEntry(op: OperationDetail): OperationDetailCatalogEntry {
  return { operation: op, result: null, artifacts: [] };
}

export function catalogOf(n: number): { entries: OperationDetailCatalogEntry[] } {
  return {
    entries: Array.from({ length: n }, (_, i) => catalogEntry(makeOp(`op-${i.toString().padStart(3, '0')}`))),
  };
}

export function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

export function recordingFetch(body: unknown, capture?: { urls: string[] }): typeof fetch {
  return (async (input: string | URL) => {
    if (capture) capture.urls.push(String(input));
    return jsonResponse(body);
  }) as unknown as typeof fetch;
}

export const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';

export const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

export const ADMIN_TOKEN = 'platform-admin-token';

export const OPERATOR_TOKEN = 'tenant-operator-token';

export function pgResult(rows: Record<string, unknown>[]): QueryResult<QueryResultRow> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, rows: rows as QueryResultRow[], fields: [] };
}

export function dbRow(id: string, createdAt: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id,
    tenant_id: TENANT_A,
    business_id: 'example-review',
    business_version: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    state_version: 1,
    created_at: createdAt,
    updated_at: createdAt,
    deadline_at: null,
    result_ref: null,
    ...overrides,
  };
}

export interface ListDbFixture {
  page?: Record<string, unknown>[];
  total?: number;
  apiKey?: { id: string; tenantId: string } | null;
}

/**
 * The modern page statement `listOperationsPage` issues: the `SELECT *` list PLUS
 * the exact sort-key projection `to_char(<key> AT TIME ZONE 'UTC', …) AS
 * __cursor_sort_key` (list-query.ts:564).
 *
 * The projection is contract-pinned, not incidental:
 * operations-list-cursor-sort-binding.test.ts:341-343 asserts the whole
 * statement verbatim, operations-list-contract-conformance.test.ts:70 matches
 * this same shape, and it exists because `pg` truncates microseconds off a Date
 * — the boundary a cursor carries has to come from SQL (list-query.ts:468-469).
 *
 * A double that only accepted the pre-projection `SELECT * FROM operations`
 * rejected valid SQL and reported it as "unexpected … SQL", which is how three
 * suites (52 tests) went red while the route itself was correct.
 */
export const OPERATIONS_LIST_PAGE_SQL_RE =
  /^SELECT \*, to_char\(.+ AS __cursor_sort_key FROM operations/i;

/**
 * Any statement the operations LIST can issue on this route: the modern keyset
 * page above, or the LEGACY compat facade's own list statement
 * (`SELECT * FROM operations … ORDER BY created_at DESC LIMIT $n` — served to an
 * x-api-key caller before the canonical block, server.ts:1744 vs :1816).
 *
 * The shared helper routes BOTH, so its dispatcher and its call-finders must
 * accept both. Suites that drive only the modern page keep using the stricter
 * OPERATIONS_LIST_PAGE_SQL_RE above.
 */
export const OPERATIONS_LIST_ANY_SQL_RE =
  /^SELECT \*(?:, to_char\(.+ AS __cursor_sort_key)? FROM operations/i;

export function listRoute(options: {
  search: string;
  headers?: Record<string, string>;
  db?: ListDbFixture;
  config?: Record<string, unknown>;
}): { ctx: RouteContext; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const fixture = options.db ?? {};
  const query = async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
    calls.push({ sql, params });
    if (/FROM api_keys WHERE hash=\$1/i.test(sql)) {
      const key = fixture.apiKey;
      return pgResult(key ? [{ id: key.id, tenant_id: key.tenantId }] : []);
    }
    if (/SELECT count\(\*\)::int AS total FROM operations/i.test(sql)) {
      return pgResult([{ total: fixture.total ?? 0 }]);
    }
    if (OPERATIONS_LIST_ANY_SQL_RE.test(sql)) {
      return pgResult(fixture.page ?? []);
    }
    throw new Error(`unexpected operations-list SQL: ${sql}`);
  };
  // Only the fields this route reads are wired; the cast keeps the fixture
  // from having to fabricate 20 unrelated services.
  const ctx = {
    method: 'GET',
    pathname: '/api/v1/operations',
    searchParams: new URLSearchParams(options.search),
    headers: options.headers ?? {},
    config: {
      adminToken: ADMIN_TOKEN,
      tenantAdminTokens: { [OPERATOR_TOKEN]: TENANT_A },
      ...options.config,
    },
    db: { query },
  } as unknown as RouteContext;
  return { ctx, calls };
}

export function pageQuery(calls: { sql: string; params: unknown[] }[]): { sql: string; params: unknown[] } {
  const found = calls.find((c) => OPERATIONS_LIST_ANY_SQL_RE.test(c.sql));
  if (!found) throw new Error('no page query was issued');
  return found;
}

export function countQuery(calls: { sql: string; params: unknown[] }[]): { sql: string; params: unknown[] } {
  const found = calls.find((c) => /SELECT count\(\*\)::int AS total FROM operations/i.test(c.sql));
  if (!found) throw new Error('no count query was issued');
  return found;
}

export function decodeCursor(cursor: string): { createdAt: string; id: string } {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString('utf8').split('|');
  return { createdAt: createdAt ?? '', id: id ?? '' };
}

export function calls_with_page(calls: { sql: string; params: unknown[] }[]): string {
  const found = calls.filter((c) => OPERATIONS_LIST_ANY_SQL_RE.test(c.sql));
  return found.length > 0 ? found[found.length - 1]!.sql : '';
}

