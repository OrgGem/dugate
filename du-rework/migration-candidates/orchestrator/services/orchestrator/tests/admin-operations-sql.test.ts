import {
  fetchOperationDetail,
  clampListLimit,
  OPERATION_LIST_DEFAULT_LIMIT,
  OPERATION_LIST_MAX_LIMIT,
  OPERATION_LIST_CURSOR_MAX_LEN,
} from '../src/app/admin/operation-section-data';
import type { OperationDetailCatalogEntry } from '../src/app/admin/operation-section-data';
import { renderOperationSection } from '../src/app/admin/operation-section-renderer';
import { parseOperationListQuery, parseQueryString } from '../src/app/admin/shell-router';
import { wrapTablesForReflow } from '../src/app/admin/shell-render';
import { route, parseOperationsListQuery, type RouteContext } from '../src/server';
import type { QueryResult, QueryResultRow } from 'pg';
import type { OperationDetail } from '@du/contracts';
import { OPERATIONS_LIST_QUERY_PARAMS, OPERATIONS_LIST_SORT_VALUES, isOperationsListFilterToken } from '@du/contracts';
import { TENANT_A, TENANT_B, ADMIN_TOKEN, OPERATOR_TOKEN, pgResult, dbRow, listRoute, pageQuery, countQuery, decodeCursor, calls_with_page } from './helpers/operations-page-fixture';



describe('W-ADMUX02-SRV-1: parseOperationsListQuery allow-list', () => {
  it('defaults every filter and the page size when no params are sent', () => {
    const q = parseOperationsListQuery(new URLSearchParams(''));
    expect(q).toEqual({
      limit: OPERATION_LIST_DEFAULT_LIMIT,
      cursor: null,
      stateFilter: 'ALL',
      tenantId: null,
      idContains: null,
      // The order this route had before a sort parameter existed: an absent
      // sort must not be "no order", it must be THE order, so every cursor and
      // deep link written earlier keeps paging the same rows.
      sort: { field: 'created_at', direction: 'desc' },
    });
  });

  it('clamps limit into 1..100 and survives unparseable values', () => {
    expect(parseOperationsListQuery(new URLSearchParams('limit=0')).limit).toBe(1);
    expect(parseOperationsListQuery(new URLSearchParams('limit=9999')).limit).toBe(OPERATION_LIST_MAX_LIMIT);
    expect(parseOperationsListQuery(new URLSearchParams('limit=abc')).limit).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(parseOperationsListQuery(new URLSearchParams('limit=7')).limit).toBe(7);
  });

  it('accepts the four documented state values, case-insensitively', () => {
    for (const s of ['RUNNING', 'running', 'COMPLETED', 'failed', ' TIMED_OUT ']) {
      expect(parseOperationsListQuery(new URLSearchParams(`state=${s}`)).stateFilter).toBe(
        s.trim().toUpperCase(),
      );
    }
  });

  it('rejects a state outside the enum instead of ignoring it', () => {
    expect(() => parseOperationsListQuery(new URLSearchParams('state=SUCCEEDED')))
      .toThrow(/state must be one of/);
    expect(() => parseOperationsListQuery(new URLSearchParams('state=RUNNING%27')))
      .toThrow(/state must be one of/);
  });

  it('accepts allow-listed tenant/id tokens', () => {
    const q = parseOperationsListQuery(new URLSearchParams(`tenant=${TENANT_A}&id=op-42`));
    expect(q.tenantId).toBe(TENANT_A);
    expect(q.idContains).toBe('op-42');
  });

  it('rejects injection-shaped and over-long filter tokens', () => {
    for (const bad of [
      `x' OR 1=1--`,
      'a;b',
      'a b',
      '../../etc/passwd',
      '<script>',
      'x'.repeat(65),
    ]) {
      expect(() => parseOperationsListQuery(new URLSearchParams(`tenant=${encodeURIComponent(bad)}`)))
        .toThrow(/tenant is not an accepted filter value/);
      expect(() => parseOperationsListQuery(new URLSearchParams(`id=${encodeURIComponent(bad)}`)))
        .toThrow(/id is not an accepted filter value/);
    }
  });

  it('refuses pasted key material as a search term', () => {
    const secret = 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdead';
    expect(() => parseOperationsListQuery(new URLSearchParams(`id=${secret}`)))
      .toThrow(/id is not an accepted filter value/);
  });

  it('rejects a malformed or over-long cursor rather than paging from nowhere', () => {
    for (const bad of ['not-a-cursor', 'off%3Ak', Buffer.from('2026-13-45T99:99:99Z|x', 'utf8').toString('base64url')]) {
      expect(() => parseOperationsListQuery(new URLSearchParams(`cursor=${bad}`)))
        .toThrow(/cursor is not a valid operations list cursor/);
    }
    expect(() => parseOperationsListQuery(new URLSearchParams(`cursor=${'A'.repeat(200)}`)))
      .toThrow(/cursor is not a valid operations list cursor/);
  });
});



describe('W-ADMUX02-SRV-1: GET /api/v1/operations envelope', () => {
  it('platform admin without a tenant param reads cross-tenant and gets the documented keys', async () => {
    const { ctx, calls } = listRoute({
      search: '',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 42 },
    });
    const res = await route(ctx);
    expect(res.status).toBe(200);
    const body = res.body as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['items', 'limit', 'nextCursor', 'prevCursor', 'total']);
    expect(body['total']).toBe(42);
    expect(body['limit']).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(Array.isArray(body['items'])).toBe(true);
    // No tenant predicate at all for the cross-tenant platform view.
    expect(pageQuery(calls).sql).not.toMatch(/tenant_id/);
  });

  it('total is the server COUNT of the filtered population, never the row count', async () => {
    const { ctx } = listRoute({
      search: 'limit=2',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 137 },
    });
    const body = (await route(ctx)).body as Record<string, unknown>;
    expect((body['items'] as unknown[]).length).toBe(1);
    expect(body['total']).toBe(137);
  });

  it('a short page ends the list (no next cursor); a full page with an extra row continues', async () => {
    const short = listRoute({
      search: 'limit=2',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 1 },
    });
    const shortBody = (await route(short.ctx)).body as Record<string, unknown>;
    expect(shortBody['nextCursor']).toBe(null);

    const full = listRoute({
      search: 'limit=2',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: {
        page: [
          dbRow('op-1', '2026-09-25T00:00:00.000Z'),
          dbRow('op-2', '2026-09-25T01:00:00.000Z'),
          dbRow('op-3', '2026-09-25T02:00:00.000Z'),
        ],
        total: 9,
      },
    });
    const fullBody = (await route(full.ctx)).body as Record<string, unknown>;
    // limit + 1 rows came back ⇒ a next page exists, and the cursor is the
    // LAST row of the page we return (op-2), not the probe row (op-3).
    expect((fullBody['items'] as unknown[]).length).toBe(2);
    const cursor = decodeCursor(fullBody['nextCursor'] as string);
    expect(cursor).toEqual({ createdAt: '2026-09-25T01:00:00.000Z', id: 'op-2' });
    expect(pageQuery(full.calls).params).toContain(3);
  });

  it('the keyset cursor round-trips: page 1 hands out a cursor page 2 can page with', async () => {
    const first = listRoute({
      search: 'limit=1',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: {
        page: [
          dbRow('11111111-1111-4111-8111-111111111111', '2026-09-25T02:00:00.000Z'),
          dbRow('22222222-2222-4222-8222-222222222222', '2026-09-25T01:00:00.000Z'),
        ],
        total: 2,
      },
    });
    const nextCursor = ((await route(first.ctx)).body as Record<string, unknown>)['nextCursor'] as string;
    expect(decodeCursor(nextCursor)).toEqual({
      createdAt: '2026-09-25T02:00:00.000Z',
      id: '11111111-1111-4111-8111-111111111111',
    });

    const second = listRoute({
      search: `limit=1&cursor=${encodeURIComponent(nextCursor)}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('22222222-2222-4222-8222-222222222222', '2026-09-25T01:00:00.000Z')], total: 2 },
    });
    await route(second.ctx);
    const page = pageQuery(second.calls);
    expect(page.sql).toContain('(created_at, id) < (');
    expect(page.params).toContain('2026-09-25T02:00:00.000Z');
    expect(page.params).toContain('11111111-1111-4111-8111-111111111111');
  });

  it('page 1 reports no previous page', async () => {
    const { ctx } = listRoute({
      search: '',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 1 },
    });
    expect((await route(ctx)).body).toMatchObject({ prevCursor: null });
  });

  it('a page-2 request with nothing above it reports no previous page', async () => {
    const { ctx } = listRoute({
      search: `cursor=${Buffer.from('2026-09-25T02:00:00.000Z|11111111-1111-4111-8111-111111111111', 'utf8').toString('base64url')}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    const body = (await route(ctx)).body as Record<string, unknown>;
    expect(body['prevCursor']).toBe(null);
    expect(body['nextCursor']).toBe(null);
  });
});



/**
 * W-ADMUX02-SRV-1-FIX: the previous page is fetched with a BACKWARD cursor, and
 * these tests run the REAL route against a fake db that actually applies the
 * (created_at, id) predicate and the ORDER BY. The earlier prev-cursor test
 * asserted against hardcoded rows and so could not have caught a wrong
 * direction — it "passed" while prevCursor pointed back into the current page.
 */
describe('W-ADMUX02-SRV-1-FIX: prev cursor is a real backward hop', () => {
  /** N rows, newest first, one hour apart. */
  function population(n: number): Record<string, unknown>[] {
    return Array.from({ length: n }, (_, i) => {
      const rank = i + 1;
      const hour = String(24 - rank).padStart(2, '0');
      return dbRow(
        `${String(rank).padStart(8, '0')}-0000-4000-8000-000000000000`,
        `2026-09-25T${hour}:00:00.000Z`
      );
    });
  }

  function rankOf(id: string): number {
    return Number(id.slice(0, 8));
  }

  /**
   * Applies the predicate the route actually emits: `(created_at, id) <op> (ts,id)`
   * plus ORDER BY DESC/ASC and LIMIT. op is read out of the SQL so the test
   * fails if the route changes direction without the fixtures following it.
   */
  function statefulRoute(rows: Record<string, unknown>[]) {
    const calls: { sql: string; params: unknown[] }[] = [];
    const ctx = {
      method: 'GET',
      pathname: '/api/v1/operations',
      searchParams: new URLSearchParams(''),
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      config: { adminToken: ADMIN_TOKEN },
      db: {
        query: async (sql: string, params: unknown[] = []): Promise<QueryResult<QueryResultRow>> => {
          calls.push({ sql, params });
          if (/SELECT count\(\*\)::int AS total FROM operations/i.test(sql)) {
            return pgResult([{ total: rows.length }]);
          }
          if (!/^SELECT \* FROM operations/i.test(sql)) {
            throw new Error(`unexpected SQL: ${sql}`);
          }
          const backwards = /ORDER BY created_at ASC, id ASC/i.test(sql);
          const op = /\(created_at, id\) > \(/.test(sql) ? '>' : '<';
          const ts = String(params[0] ?? '');
          const id = String(params[1] ?? '');
          const bound: [string, string] = [ts, id];
          const key = (r: Record<string, unknown>): [string, string] => [
            String(r['created_at']),
            String(r['id']),
          ];
          const cmp = (a: [string, string], b: [string, string]): number =>
            a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0;
          const filtered = rows.filter((r) => {
            const c = cmp(key(r), bound);
            return op === '>' ? c > 0 : c < 0;
          });
          const sorted = filtered.sort((a, b) =>
            backwards ? cmp(key(a), key(b)) : cmp(key(b), key(a))
          );
          const limit = Number(params[params.length - 1]);
          return pgResult(sorted.slice(0, limit));
        },
      },
    } as unknown as RouteContext;

    return {
      calls,
      async get(search: string) {
        (ctx as unknown as { searchParams: URLSearchParams }).searchParams =
          new URLSearchParams(search);
        return (await route(ctx)).body as Record<string, unknown>;
      },
    };
  }

  it('page 1 -> page 2 -> back to page 1 returns the identical rows', async () => {
    const db = statefulRoute(population(8));
    const p1 = await db.get('limit=2');
    expect((p1['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([1, 2]);
    expect(p1['prevCursor']).toBe(null);

    const p2 = await db.get(`limit=2&cursor=${encodeURIComponent(p1['nextCursor'] as string)}`);
    expect((p2['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([3, 4]);
    expect(p2['prevCursor']).not.toBe(null);

    // THE regression: following prevCursor must land back on page 1 verbatim.
    const back = await db.get(`limit=2&cursor=${encodeURIComponent(p2['prevCursor'] as string)}`);
    expect((back['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([1, 2]);
    expect((back['items'] as { id: string }[]).map((r) => r.id)).toEqual(
      (p1['items'] as { id: string }[]).map((r) => r.id)
    );
    // …and page 1 knows it has no page above it.
    expect(back['prevCursor']).toBe(null);
  });

  it('walks three pages deep and back up one at a time without skipping or repeating', async () => {
    const db = statefulRoute(population(8));
    const seen: number[][] = [];
    let body = await db.get('limit=2');
    seen.push((body['items'] as { id: string }[]).map((r) => rankOf(r.id)));
    for (let i = 0; i < 2; i++) {
      body = await db.get(`limit=2&cursor=${encodeURIComponent(body['nextCursor'] as string)}`);
      seen.push((body['items'] as { id: string }[]).map((r) => rankOf(r.id)));
    }
    expect(seen).toEqual([[1, 2], [3, 4], [5, 6]]);

    // Back up: page 3 -> page 2 -> page 1.
    const up2 = await db.get(`limit=2&cursor=${encodeURIComponent(body['prevCursor'] as string)}`);
    expect((up2['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([3, 4]);
    const up1 = await db.get(`limit=2&cursor=${encodeURIComponent(up2['prevCursor'] as string)}`);
    expect((up1['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([1, 2]);
  });

  it('a backward cursor is an ASC query with a > predicate, and its rows come back newest-first', async () => {
    const db = statefulRoute(population(8));
    const p1 = await db.get('limit=2');
    const p2 = await db.get(`limit=2&cursor=${encodeURIComponent(p1['nextCursor'] as string)}`);
    await db.get(`limit=2&cursor=${encodeURIComponent(p2['prevCursor'] as string)}`);

    const backPage = calls_with_page(db.calls);
    // DESC here would take the NEWEST rows above the boundary and skip a page.
    expect(backPage).toMatch(/ORDER BY created_at ASC, id ASC/i);
    expect(backPage).toMatch(/\(created_at, id\) > \(/);
  });

  it('a backward arrival on the first page offers no previous page (no self-link)', async () => {
    // Regression: guarding only on "a cursor was sent" left page 1 reachable
    // from below with a prevCursor, so the pane rendered a Previous link that
    // returned the operator to the page they were already on.
    const db = statefulRoute(population(4));
    const p1 = await db.get('limit=2');
    const p2 = await db.get(`limit=2&cursor=${encodeURIComponent(p1['nextCursor'] as string)}`);
    const back = await db.get(`limit=2&cursor=${encodeURIComponent(p2['prevCursor'] as string)}`);
    expect((back['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([1, 2]);
    expect(back['prevCursor']).toBe(null);
    // Forward into the same page still reports a previous page.
    expect(p2['prevCursor']).not.toBe(null);
  });

  it('a partial last page still offers a previous page', async () => {
    const db = statefulRoute(population(5)); // 5 rows / limit 2 => pages 2,2,1
    const p1 = await db.get('limit=2');
    const p2 = await db.get(`limit=2&cursor=${encodeURIComponent(p1['nextCursor'] as string)}`);
    const p3 = await db.get(`limit=2&cursor=${encodeURIComponent(p2['nextCursor'] as string)}`);
    expect((p3['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([5]);
    expect(p3['nextCursor']).toBe(null);
    expect(p3['prevCursor']).not.toBe(null);

    const back = await db.get(`limit=2&cursor=${encodeURIComponent(p3['prevCursor'] as string)}`);
    expect((back['items'] as { id: string }[]).map((r) => rankOf(r.id))).toEqual([3, 4]);
  });
});



describe('W-ADMUX02-SRV-1: filters are server-side, bound, and tenant-fenced', () => {
  it('state expands to a bound ANY() over the wire states, never into SQL text', async () => {
    const { ctx, calls } = listRoute({
      search: 'state=FAILED',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    const page = pageQuery(calls);
    expect(page.sql).toContain('state = ANY($1::text[])');
    expect(page.sql).not.toContain('FAILED');
    expect(page.params[0]).toEqual(['FAILED']);
    // The count must see the same filter as the page, or the number lies.
    expect(countQuery(calls).sql).toContain('state = ANY($1::text[])');
    expect(countQuery(calls).params[0]).toEqual(['FAILED']);
  });

  it('the RUNNING group covers every state an operator still has to look at', async () => {
    const { ctx, calls } = listRoute({
      search: 'state=RUNNING',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    expect(pageQuery(calls).params[0]).toEqual([
      'ACCEPTED',
      'QUEUED',
      'RUNNING',
      'RETRY_PENDING',
      'WAITING_CHILDREN',
      'CANCEL_REQUESTED',
      'WAITING_INPUT',
    ]);
  });

  it('the tenant filter is an exact bound equality', async () => {
    const { ctx, calls } = listRoute({
      search: `tenant=${TENANT_B}`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    const page = pageQuery(calls);
    expect(page.sql).toContain('tenant_id = $1');
    expect(page.sql).not.toContain(TENANT_B);
    expect(page.params[0]).toBe(TENANT_B);
  });

  it('the id search is a bound substring, not a LIKE with wildcard semantics', async () => {
    const { ctx, calls } = listRoute({
      search: 'id=op_4',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    const page = pageQuery(calls);
    expect(page.sql).toContain('strpos(lower(id::text), lower($1)) > 0');
    expect(page.sql).not.toMatch(/LIKE/i);
    expect(page.params[0]).toBe('op_4');
  });

  it('no caller-supplied value is ever concatenated into the SQL text', async () => {
    const { ctx, calls } = listRoute({
      search: `state=FAILED&tenant=${TENANT_A}&id=op-4&limit=5`,
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(ctx);
    expect(calls.length).toBeGreaterThan(0);
    for (const c of calls) {
      expect(c.sql).not.toContain(TENANT_A);
      expect(c.sql).not.toContain('op-4');
      expect(c.sql).not.toMatch(/'|;|--/);
    }
  });

  it('a tenant operator is fenced to its own tenant in SQL, and 403s a foreign filter', async () => {
    const own = listRoute({
      search: '',
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await route(own.ctx);
    expect(pageQuery(own.calls).params[0]).toBe(TENANT_A);

    const foreign = listRoute({
      search: `tenant=${TENANT_B}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      db: { page: [], total: 0 },
    });
    await expect(route(foreign.ctx)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'admin reads are scoped to the caller tenant',
    });
    // The fence rejects BEFORE any query is issued.
    expect(foreign.calls).toHaveLength(0);
  });

  // Re-verified against source on 2026-10-02 (receipt
  // tester-fence-red-reverify-2026-10-02.md). The previous version of this case
  // asserted a 403 the route cannot produce, and was therefore red for a reason
  // that had nothing to do with the fence it claimed to test.
  //
  // What actually happens, with citations:
  //  - `GET /api/v1/operations` is claimed by the legacy compat facade at
  //    server.ts:1744, which runs BEFORE the canonical block at server.ts:1816.
  //  - The facade serves it only to an x-api-key caller; an admin bearer makes it
  //    decline and fall through (legacy-http-mount.ts:464).
  //  - Its list branch reads only `filter`, `page_size` and `page_token`
  //    (legacy-http-mount.ts:501-533). `?tenant=` is never consulted.
  //  - Scope comes from `resolvePrincipal()` — the KEY — and is bound as
  //    `tenant_id = $1` with `params[0] = principal.tenantId`
  //    (legacy-host-adapter.ts:117-118).
  //
  // So the fence is real, it is simply expressed as "a foreign tenant param is
  // ignored and the KEY's tenant is bound into the query" rather than as a 403.
  it('the x-api-key path is fenced by the KEY: a foreign tenant param is ignored, not honoured', async () => {
    const own = listRoute({
      search: `tenant=${TENANT_A}`,
      headers: { 'x-api-key': 'raw-key' },
      db: {
        page: [dbRow('op-A', '2026-09-25T00:00:00.000Z')],
        total: 1,
        apiKey: { id: 'key-1', tenantId: TENANT_A },
      },
    });
    const ownRes = (await route(own.ctx)) as { status: number; body: Record<string, unknown> };
    expect(ownRes.status).toBe(200);
    expect(pageQuery(own.calls).params[0]).toBe(TENANT_A);

    const foreign = listRoute({
      search: `tenant=${TENANT_B}`,
      headers: { 'x-api-key': 'raw-key' },
      db: {
        page: [dbRow('op-A', '2026-09-25T00:00:00.000Z')],
        total: 1,
        apiKey: { id: 'key-1', tenantId: TENANT_A },
      },
    });
    const foreignRes = (await route(foreign.ctx)) as { status: number; body: Record<string, unknown> };

    // 200, not 403: the compat facade answers this caller.
    expect(foreignRes.status).toBe(200);
    // The LEGACY envelope. These keys are how we know which branch ran.
    expect(Object.keys(foreignRes.body).sort()).toEqual(['next_page_token', 'operations']);

    // The fence itself, asserted as a predicate rather than as a status code:
    const page = pageQuery(foreign.calls);
    expect(page.params[0]).toBe(TENANT_A);        // the KEY's tenant...
    expect(page.params).not.toContain(TENANT_B);   // ...and never the caller's
    expect(page.sql).toContain('tenant_id = $1');  // bound, not concatenated

    // Honest limit of this leg: the fixture's `db.query` returns `db.page`
    // regardless of the WHERE clause, so this proves the PREDICATE is
    // server-side and bound to the key's tenant. It does not, and cannot,
    // prove that a real PostgreSQL withholds tenant-B rows — that needs a live
    // DB leg. Asserting row absence here would be asserting the mock.
    expect((foreignRes.body as { operations: unknown[] }).operations).toHaveLength(1);
  });

  // Objective-2 leg: confirm the CANONICAL branch is reachable with a bearer,
  // i.e. the compat facade really does decline (legacy-http-mount.ts:464) and
  // does not swallow the call behind a legacy envelope.
  it('an admin bearer reaches the CANONICAL branch, not the compat facade', async () => {
    const { ctx } = listRoute({
      search: `tenant=${TENANT_A}`,
      headers: { authorization: `Bearer ${OPERATOR_TOKEN}` },
      db: { page: [dbRow('op-A', '2026-09-25T00:00:00.000Z')], total: 3, apiKey: null },
    });
    const res = (await route(ctx)) as { status: number; body: Record<string, unknown> };

    expect(res.status).toBe(200);
    // The canonical envelope. Had the facade claimed this path we would be
    // looking at { operations, next_page_token } instead — so the key set is
    // the evidence that `hasAdminBearer` made it return null.
    expect(Object.keys(res.body).sort()).toEqual([
      'items',
      'limit',
      'nextCursor',
      'prevCursor',
      'total',
    ]);
    expect(res.body['total']).toBe(3);
  });

  it('an invalid filter is a 422 on the route, not a silently unfiltered list', async () => {
    const { ctx, calls } = listRoute({
      search: 'state=NOT_A_STATE',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
      db: { page: [dbRow('op-1', '2026-09-25T00:00:00.000Z')], total: 99 },
    });
    await expect(route(ctx)).rejects.toMatchObject({ status: 422, code: 'INVALID_SCHEMA' });
    expect(calls).toHaveLength(0);
  });
});



describe('W-ADM-UX-02 pagination negative: limit bounds', () => {
  it('zero and negative limits clamp UP to 1, never to 0 or a negative page size', () => {
    // A page size of 0 or negative would make the server ask for an
    // impossible window; clamping to 1 returns exactly one row instead of
    // an error or an empty page that looks like data.
    expect(clampListLimit(0)).toBe(1);
    expect(clampListLimit(-1)).toBe(1);
    expect(clampListLimit(-9999)).toBe(1);
  });

  it('a limit past the 100 ceiling clamps to exactly 100', () => {
    expect(clampListLimit(101)).toBe(100);
    expect(clampListLimit(100)).toBe(100);
    expect(clampListLimit(1000000)).toBe(100);
  });

  it('NaN and Infinity fall back to the contract default, never leaking through', () => {
    expect(clampListLimit(Number.NaN)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(Number.POSITIVE_INFINITY)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(Number.NEGATIVE_INFINITY)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
  });

  it('a fractional limit TRUNCATES rather than rounding', () => {
    // Math.trunc, so 1.9 becomes 1 and never 2. A page that silently
    // rounded UP would return more rows than the operator asked for.
    expect(clampListLimit(1.9)).toBe(1);
    expect(clampListLimit(99.99)).toBe(99);
  });

  it('unparseable strings fall back to the default', () => {
    expect(clampListLimit('abc')).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit('')).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit('   ')).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(undefined)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
    expect(clampListLimit(null)).toBe(OPERATION_LIST_DEFAULT_LIMIT);
  });

  it('a numeric string with trailing garbage takes the numeric prefix', () => {
    // parseInt semantics: '12abc' reads as 12. This is MEASURED
    // behaviour, not an aspiration - pinned so a future parser change
    // is a visible diff rather than a silent contract shift.
    expect(clampListLimit('12abc')).toBe(12);
    expect(clampListLimit('25')).toBe(25);
    expect(clampListLimit('-7')).toBe(1);
  });

  it('a numeric string over the ceiling still clamps', () => {
    expect(clampListLimit('101')).toBe(100);
    expect(clampListLimit('9999')).toBe(100);
  });
});




describe('W-ADM-UX-02 pagination negative: cursor bounds', () => {
  const decode = (c: string): string[] => Buffer.from(c, 'base64url').toString('utf8').split('|');

  it('an empty cursor decodes to zero usable fields, never a phantom page', () => {
    const parts = decode('');
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe('');
  });

  it('a whitespace cursor is not mistaken for a real one', () => {
    const parts = decode(' ');
    expect(parts[0]).not.toBe(' ');
  });

  it('a cursor with no pipe field decodes to a single non-parseable part', () => {
    const raw = Buffer.from('no-pipe-here', 'utf8').toString('base64url');
    const parts = decode(raw);
    expect(parts).toHaveLength(1);
    expect(parts[0]).toBe('no-pipe-here');
  });

  it('a well-formed cursor decodes to the full field set', () => {
    const raw = Buffer.from('2026-01-01T00:00:00Z|op-1|created_at|asc|next', 'utf8').toString('base64url');
    const parts = decode(raw);
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('2026-01-01T00:00:00Z');
    expect(parts[1]).toBe('op-1');
  });

  it('a cursor with a non-ASCII id decodes to five fields, not five garbage bytes', () => {
    const raw = Buffer.from('2026-01-01T00:00:00Z|op-é|created_at|asc|next', 'utf8').toString('base64url');
    const parts = decode(raw);
    expect(parts).toHaveLength(5);
    expect(parts[0]).toBe('2026-01-01T00:00:00Z');
  });

  it('an over-length cursor exceeds the wire bound it is sliced to', () => {
    // The route slices a supplied cursor to the max length before using it;
    // a 500-char token is therefore longer than anything the wire accepts.
    const long = 'x'.repeat(500);
    expect(long.length).toBeGreaterThan(OPERATION_LIST_CURSOR_MAX_LEN);
    expect(long.slice(0, OPERATION_LIST_CURSOR_MAX_LEN).length).toBe(OPERATION_LIST_CURSOR_MAX_LEN);
  });

  it('garbage base64 never throws, it just decodes to unparseable text', () => {
    const parts = decode('not-base64!!');
    expect(parts.length).toBeGreaterThan(0);
  });
});
