/**
 * W-ADMUX02-CROSS-SORT-422-1 (Reviewer Turn 150 finding 4 / Turn 180): cross-sort replay and
 * six-sort pagination were proven IN-PROCESS (Muc 15) and at the renderer (Muc 16), never over
 * an HTTP round trip. This suite closes the wire half OFFLINE, in two layers:
 *
 *  A) the REAL route handler (server.ts route()) mounted on a loopback node:http server with a
 *     fake db that interprets the pinned SQL shape - so 422s arrive as application/problem+json
 *     over a socket, and keyset walks move real nextCursor bytes page to page; the cross-sort
 *     cursors under test are MINTED BY THE ROUTE ITSELF, not hand-built;
 *  B) the REAL admin shell (createAdminShellServer, cookie login) driving its real fetcher
 *     against a SYNTHETIC platform that implements the W-ADMUX02-SORT-CURSOR-BIND-1 wire policy
 *     (token grammar, bind-and-reject, sentinel ordering, 128 bound). This proves the shell keeps
 *     cursor and sort paired over an actual URL, surfaces the 422 remedy as an honest error pane,
 *     and fences tenants through the query state - without claiming anything about PostgreSQL or
 *     the live deployment.
 *
 * OFFLINE ONLY: loopback sockets, no PG, no Redis, no S3, no DB window. Expectations come from
 * a JS oracle written here independently of both the route and the synthetic platform.
 */
import http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  LIST_CURSOR_MAX_LEN,
  OPERATIONS_LIST_SORT_DEFAULT,
  OPERATIONS_LIST_SORT_VALUES,
  OperationsListPageSchema,
} from '@du/contracts';
import { isHttpError } from '../src/http/errors';
import { route, type RouteContext } from '../src/server';
import { createAdminShellServer, type AdminShellHandle } from '../src/app/admin/shell-server';
import type { QueryResult, QueryResultRow } from 'pg';
import { OPERATIONS_LIST_PAGE_SQL_RE } from './helpers/operations-page-fixture';

const ADMIN_TOKEN = 'cross-sort-http-admin-token';
const COOKIE_SECRET = 'cross-sort-http-cookie-secret';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

interface Row {
  id: string;
  tenant: string;
  created: string;
  updated: string;
  deadline: string | null;
}

/**
 * Population with a THREE-WAY created_at tie spanning both tenants (a1, a2, b1 share
 * 12:00:02) and NULL deadlines mixed across tenants. The tie is what makes a missing
 * id tiebreak provably skip or repeat; the NULL mix is what makes a mis-bound deadline
 * cursor provably lose rows. Every value is chosen so the six sorts give six DIFFERENT
 * orders - a cursor bound to the wrong ordering cannot accidentally land right.
 */
const POP: readonly Row[] = [
  { id: '11111111-1111-4111-8111-111111111111', tenant: TENANT_A, created: '2026-09-25T12:00:02.000Z', updated: '2026-09-22T00:00:00.000Z', deadline: '2026-12-01T00:00:00.000Z' },
  { id: '22222222-2222-4222-8222-222222222222', tenant: TENANT_A, created: '2026-09-25T12:00:02.000Z', updated: '2026-09-21T00:00:00.000Z', deadline: null },
  { id: '33333333-3333-4333-8333-333333333333', tenant: TENANT_A, created: '2026-09-25T12:00:01.000Z', updated: '2026-09-20T00:00:00.000Z', deadline: '2026-10-01T00:00:00.000Z' },
  { id: '44444444-4444-4444-8444-444444444444', tenant: TENANT_B, created: '2026-09-25T12:00:02.000Z', updated: '2026-09-23T00:00:00.000Z', deadline: '2026-11-15T00:00:00.000Z' },
  { id: '55555555-5555-5555-8555-555555555555', tenant: TENANT_B, created: '2026-09-25T12:00:03.000Z', updated: '2026-09-19T00:00:00.000Z', deadline: null },
];

const SENTINEL_DESC = '0001-01-01T00:00:00.000Z';
const SENTINEL_ASC = '9999-12-31T23:59:59.999Z';

function keyOf(row: Row, field: string, sentinel: string): string {
  if (field === 'updated_at') return row.updated;
  if (field === 'deadline_at') return row.deadline ?? sentinel;
  return row.created;
}

/** The independent oracle: full ordering for a sort spec over an optional tenant scope. */
function oracleOrder(sortSpec: string, tenant?: string): string[] {
  const field = sortSpec.slice(0, sortSpec.indexOf(':'));
  const direction = sortSpec.slice(sortSpec.indexOf(':') + 1);
  const sentinel = direction === 'asc' ? SENTINEL_ASC : SENTINEL_DESC;
  const factor = direction === 'asc' ? 1 : -1;
  const rows = POP.filter((r) => tenant === undefined || r.tenant === tenant);
  return [...rows]
    .sort((x, y) => {
      const kx = keyOf(x, field, sentinel);
      const ky = keyOf(y, field, sentinel);
      if (kx !== ky) return kx < ky ? -factor : factor;
      return x.id < y.id ? -factor : factor;
    })
    .map((r) => r.id);
}

it('the fixture gives every sort its own order (test-fixture sanity gate)', () => {
  const orders = OPERATIONS_LIST_SORT_VALUES.map((s) => oracleOrder(s).join(','));
  expect(new Set(orders).size).toBe(6);
});

/** minimal loopback client (GET only; no redirects are expected). */
interface WireResponse {
  status: number;
  contentType: string;
  body: string;
}
function httpGet(url: string, headers: Record<string, string> = {}): Promise<WireResponse> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', headers, agent: false },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => {
          const body = Buffer.concat(chunks).toString('utf8');
          resolve({
            status: res.statusCode ?? 0,
            contentType: String(res.headers['content-type'] ?? ''),
            body,
          });
        });
      },
    );
    req.on('error', reject);
    req.end();
  });
}

function norm(p: unknown): string {
  return new Date(String(p)).toISOString();
}

interface Call {
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

function dbRow(r: Row): Record<string, unknown> {
  return {
    id: r.id,
    tenant_id: r.tenant,
    business_id: 'example-review',
    business_version: '1.0.0',
    action: 'review',
    state: 'RUNNING',
    state_version: 1,
    created_at: r.created,
    updated_at: r.updated,
    deadline_at: r.deadline,
    result_ref: null,
  };
}

/**
 * Interpreter-lite over the fake db. The SQL SHAPES it parses are the ones
 * pinned by Muc 15 (WHERE-folded boundary) as amended by W-INGEST-0019-1/2:
 * the deadline sentinel is an INLINE '...'::timestamptz literal shared by the
 * ORDER BY and the boundary expression (the 0019 indexes match that Const, a
 * Param would not), so dense params order is filters->key->id->limit. The
 * literal carries the direction, so a sentinel/direction mismatch is caught
 * here rather than paging past rows. Assertions never trust this file's math:
 * expected orders come from oracleOrder above.
 */
const TENANT_RE = /tenant_id = \$(\d+)/;
const ORDER_RE = /ORDER BY (.+?) (ASC|DESC), id (ASC|DESC) LIMIT \$(\d+)/;
const BOUNDARY_RE = /\(((?:COALESCE\(deadline_at, '[^']*'::timestamptz\)|created_at|updated_at)), id\) ([<>]) \(\$(\d+)::timestamptz, \$(\d+)::uuid\)/;

function tenantPool(s: string, params: unknown[]): Row[] {
  const m = TENANT_RE.exec(s);
  if (!m) return [...POP];
  return POP.filter((row) => row.tenant === String(params[Number(m[1]) - 1]));
}

function opsQuery(sql: string, params: unknown[]): QueryResult<QueryResultRow> {
  const s = sql.replace(/\s+/g, ' ').trim();
  if (/^SELECT count\(\*\)::int AS total FROM operations/i.test(s)) {
    return pgResult([{ total: tenantPool(s, params).length }]);
  }
  if (OPERATIONS_LIST_PAGE_SQL_RE.test(s)) {
    const order = ORDER_RE.exec(s);
    if (!order) throw new Error('unparsed page SQL: ' + s);
    const keyExpr = order[1] ?? '';
    const dir = (order[2] ?? 'DESC').toUpperCase();
    // group 3 is the ID direction; the LIMIT placeholder index is group 4.
    const limitIdx = Number(order[4]);
    const limit = Number(params[limitIdx - 1]);
    const factor = dir === 'ASC' ? 1 : -1;
    let field = 'created_at';
    let sentinel = '';
    if (/^updated_at$/.test(keyExpr)) field = 'updated_at';
    else if (/^COALESCE\(deadline_at/.test(keyExpr)) {
      field = 'deadline_at';
      const sk = /'([^']*)'::timestamptz/.exec(keyExpr);
      if (!sk) {
        if (/\$\d+::timestamptz/.test(keyExpr)) {
          throw new Error(
            'sentinel regressed to the bound-parameter form, which no 0019 expression index matches: ' +
              keyExpr
          );
        }
        throw new Error('sentinel literal missing in ' + keyExpr);
      }
      sentinel = sk[1] ?? '';
      const want = dir === 'ASC' ? SENTINEL_ASC : SENTINEL_DESC;
      if (sentinel !== want) {
        throw new Error(
          'sentinel ' + sentinel + ' contradicts the ' + dir + ' walk, expected ' + want
        );
      }
    }
    let rows = tenantPool(s, params);
    const b = BOUNDARY_RE.exec(s);
    if (!b && /, id\) [<>] \(/.test(s)) {
      // A boundary the interpreter cannot read must not degrade into "no
      // boundary": the fake would return the whole population and the walk
      // would fail as an endless loop instead of naming what broke.
      throw new Error('a keyset boundary is in the SQL but the interpreter could not read it: ' + s);
    }
    if (b && b[1] !== keyExpr) {
      // The boundary must name the SAME expression the ORDER BY used; ordering
      // by one expression while comparing against another skips rows.
      throw new Error('boundary key ' + b[1] + ' differs from ORDER BY key ' + keyExpr);
    }
    if (b) {
      const op = b[2];
      const tRaw = norm(params[Number(b[3]) - 1]);
      const tId = String(params[Number(b[4]) - 1]).toLowerCase();
      rows = rows.filter((r) => {
        const k = keyOf(r, field, sentinel);
        if (k === tRaw) return op === '<' ? r.id.toLowerCase() < tId : r.id.toLowerCase() > tId;
        const before = k < tRaw;
        return op === '<' ? before : !before;
      });
    }
    const sorted = [...rows].sort((x, y) => {
      const kx = keyOf(x, field, sentinel);
      const ky = keyOf(y, field, sentinel);
      if (kx !== ky) return kx < ky ? -factor : factor;
      return x.id < y.id ? -factor : factor;
    });
    return pgResult(sorted.slice(0, limit).map(dbRow));
  }
  throw new Error('unexpected operations-list SQL: ' + s);
}

function ctxFor(search: string, calls: Call[]): RouteContext {
  return {
    method: 'GET',
    pathname: '/api/v1/operations',
    searchParams: new URLSearchParams(search),
    headers: { authorization: 'Bearer ' + ADMIN_TOKEN },
    config: { adminToken: ADMIN_TOKEN },
    db: {
      query: async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params });
        return opsQuery(sql, params);
      },
    },
  } as unknown as RouteContext;
}

describe('W-ADMUX02-CROSS-SORT-422-1 A: real route() over loopback HTTP', () => {
  let routeSrv: http.Server;
  let routeBase = '';
  let calls: Call[] = [];
  // Ephemeral ports are destination-filtered on this Windows box (the same
  // hazard the admin-shell-server suite documents and works around; connect()
  // to a port-0 listener just hangs or ETIMEDOUTs here). Pin a quiet base.
  const ROUTE_PORT = 46_800 + (process.pid % 20);

  beforeAll(async () => {
    routeSrv = http.createServer((req: IncomingMessage, res: ServerResponse) => {
      void (async () => {
        const u = new URL(req.url ?? '/', 'http://127.0.0.1');
        try {
          const out = await route(ctxFor(u.search.replace(/^\?/, ''), calls));
          res.statusCode = out.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify(out.body ?? {}));
        } catch (err) {
          // Mirrors server.ts:518-525 exactly: HttpError -> problem+json via toProblem().
          if (isHttpError(err)) {
            res.statusCode = err.status;
            res.setHeader('content-type', 'application/problem+json');
            res.end(JSON.stringify(err.toProblem('cross-sort-http')));
            return;
          }
          res.statusCode = 500;
          res.end('{"code":"INTERNAL"}');
        }
      })();
    });
    await new Promise<void>((r) => routeSrv.listen(ROUTE_PORT, '127.0.0.1', r));
    routeBase = 'http://127.0.0.1:' + String(ROUTE_PORT);
  });

  afterAll(async () => {
    await new Promise<void>((r, j) => routeSrv.close((e) => (e ? j(e) : r())));
  });

  beforeEach(() => {
    calls = [];
  });

  interface Page {
    items: { id: string }[];
    nextCursor: string | null;
    prevCursor: string | null;
    total: number;
    limit: number;
  }
  async function apiGet(search: string): Promise<WireResponse> {
    return httpGet(routeBase + '/api/v1/operations?' + search, {
      authorization: 'Bearer ' + ADMIN_TOKEN,
    });
  }
  function pageOf(res: WireResponse): Page {
    return JSON.parse(res.body) as Page;
  }
  function pageQueries(): number {
    return calls.filter((c) => OPERATIONS_LIST_PAGE_SQL_RE.test(c.sql.replace(/\s+/g, ' '))).length;
  }
  async function mintNext(sort: string, limit = 2, extra = ''): Promise<string> {
    const r = await apiGet('limit=' + String(limit) + '&sort=' + encodeURIComponent(sort) + extra);
    expect(r.status).toBe(200);
    const p = pageOf(r);
    expect(p.nextCursor).not.toBeNull();
    return p.nextCursor as string;
  }

  it('serves page 1 of the default order over the wire', async () => {
    const r = await apiGet('limit=2');
    expect(r.status).toBe(200);
    expect(r.contentType).toContain('application/json');
    const p = pageOf(r);
    expect(p.items.map((x) => x.id)).toEqual(oracleOrder(OPERATIONS_LIST_SORT_DEFAULT).slice(0, 2));
    expect(OperationsListPageSchema.safeParse(p).success).toBe(true);
  });

  it.each([
    ['created_at:desc', 'deadline_at:asc'],
    ['created_at:asc', 'updated_at:desc'],
    ['updated_at:desc', 'deadline_at:asc'],
    ['deadline_at:asc', 'created_at:desc'],
    ['updated_at:asc', 'deadline_at:desc'],
  ])('a route-minted %s cursor replayed on %s is a 422 problem+json ON THE WIRE', async (from, to) => {
    const cursor = await mintNext(from, 2);
    const before = pageQueries();
    const r = await apiGet('limit=2&sort=' + encodeURIComponent(to) + '&cursor=' + encodeURIComponent(cursor));
    expect(r.status).toBe(422);
    expect(r.contentType).toContain('application/problem+json');
    const body = JSON.parse(r.body) as { code?: string; status?: number; title?: string };
    expect(body.code).toBe('INVALID_SCHEMA');
    expect(body.status).toBe(422);
    // The problem+json wire carries the human text in title (no detail key).
    expect(body.title ?? '').toContain(from);
    expect(body.title ?? '').toContain(to);
    expect(body.title ?? '').toContain('drop the cursor parameter');
    // Rejection happened at parse time: no page query ran for the bad replay.
    expect(pageQueries()).toBe(before);
  });

  it('omitting sort is no escape: a created_at:asc cursor lands on the default and is refused', async () => {
    const cursor = await mintNext('created_at:asc', 2);
    const r = await apiGet('limit=2&cursor=' + encodeURIComponent(cursor));
    expect(r.status).toBe(422);
    const title = (JSON.parse(r.body) as { title?: string }).title ?? '';
    expect(title).toContain('created_at:asc');
    expect(title).toContain('created_at:desc');
  });

  it('a legacy 2-slot cursor still pages the default order over the wire', async () => {
    const legacy = buildToken('2026-09-25T12:00:02.000Z', '22222222-2222-4222-8222-222222222222');
    const r = await apiGet('limit=5&cursor=' + encodeURIComponent(legacy));
    expect(r.status).toBe(200);
    const ids = pageOf(r).items.map((x) => x.id);
    expect(ids).toContain('33333333-3333-4333-8333-333333333333');
    expect(ids).not.toContain('22222222-2222-4222-8222-222222222222');
  });

  it('that same legacy cursor is refused the moment a non-default sort is requested', async () => {
    const legacy = buildToken('2026-09-25T12:00:02.000Z', '22222222-2222-4222-8222-222222222222');
    const r = await apiGet('limit=5&sort=' + encodeURIComponent('deadline_at:asc') + '&cursor=' + encodeURIComponent(legacy));
    expect(r.status).toBe(422);
    expect((JSON.parse(r.body) as { title?: string }).title ?? '').toContain('created_at:desc');
  });

  it('a legacy BACKWARD token still walks back under the default sort', async () => {
    const legacy = buildToken('2026-09-25T12:00:02.000Z', '22222222-2222-4222-8222-222222222222', undefined, true);
    const r = await apiGet('limit=5&cursor=' + encodeURIComponent(legacy));
    expect(r.status).toBe(200);
    expect(pageOf(r).items.map((x) => x.id)).toEqual([
      '55555555-5555-5555-8555-555555555555',
      '44444444-4444-4444-8444-444444444444',
    ]);
  });

  it('an over-long cursor (the shell truncates instead of rejecting) is refused before any query', async () => {
    const huge = 'z'.repeat(LIST_CURSOR_MAX_LEN * 2);
    const r = await apiGet('limit=2&cursor=' + huge);
    expect(r.status).toBe(422);
    const body = JSON.parse(r.body) as { code?: string; detail?: string; title?: string };
    expect(body.code).toBe('INVALID_SCHEMA');
    expect((body.detail ?? '') + (body.title ?? '')).toContain('cursor is not a valid');
    expect(pageQueries()).toBe(0);
  });

  it('a malformed sort is answered before the cursor is ever considered', async () => {
    const cursor = await mintNext('deadline_at:asc', 2);
    const r = await apiGet('limit=2&sort=' + encodeURIComponent('bogus:asc') + '&cursor=' + encodeURIComponent(cursor));
    expect(r.status).toBe(422);
    const detail = (JSON.parse(r.body) as { title?: string }).title ?? '';
    expect(detail).toContain('sort must be one of');
    expect(detail).not.toContain('drop the cursor parameter');
  });

  it.each([...OPERATIONS_LIST_SORT_VALUES])('HTTP keyset walk under %s visits every row exactly once', async (sort) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let hops = 0;
    for (;;) {
      const search = 'limit=2&sort=' + encodeURIComponent(sort) + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const r = await apiGet(search);
      expect(r.status).toBe(200);
      const p = pageOf(r);
      expect(OperationsListPageSchema.safeParse(p).success).toBe(true);
      for (const item of p.items) seen.push(item.id);
      hops += 1;
      if (hops > 12) throw new Error('walk not terminating under ' + sort);
      if (!p.nextCursor) break;
      // every server-minted token names the ordering it walks
      expect(tokenParts(p.nextCursor)[2]).toBe(sort);
      cursor = p.nextCursor;
    }
    expect(seen).toEqual(oracleOrder(sort));
    expect(new Set(seen).size).toBe(POP.length);
  });

  it.each([...OPERATIONS_LIST_SORT_VALUES])('tenant-scoped walk under %s shows ONLY tenant A rows', async (sort) => {
    const seen: string[] = [];
    let cursor: string | null = null;
    let hops = 0;
    for (;;) {
      const search = 'limit=2&sort=' + encodeURIComponent(sort) + '&tenant=' + TENANT_A
        + (cursor ? '&cursor=' + encodeURIComponent(cursor) : '');
      const r = await apiGet(search);
      expect(r.status).toBe(200);
      const p = pageOf(r);
      expect(p.total).toBe(3);
      for (const item of p.items) seen.push(item.id);
      hops += 1;
      if (hops > 8) throw new Error('scoped walk not terminating under ' + sort);
      if (!p.nextCursor) break;
      cursor = p.nextCursor;
    }
    expect(seen).toEqual(oracleOrder(sort, TENANT_A));
    expect(seen.some((id) => ['44444444-4444-4444-8444-444444444444', '55555555-5555-5555-8555-555555555555'].includes(id))).toBe(false);
  });

  it('a cursor minted inside tenant A pages ONLY tenant B windows when replayed scoped to B - and never leaks A ids', async () => {
    const cursor = await mintNext('deadline_at:asc', 2, '&tenant=' + TENANT_A);
    const r = await apiGet('limit=5&sort=deadline_at:asc&tenant=' + TENANT_B + '&cursor=' + encodeURIComponent(cursor));
    expect(r.status).toBe(200);
    const ids = pageOf(r).items.map((x) => x.id);
    expect(ids.every((id) => id.startsWith('4') || id.startsWith('5'))).toBe(true);
  });
});

/** Independent restatement of the token grammar (production codec never imported). */
function buildToken(key: string, id: string, sortSpec?: string, backward?: boolean): string {
  const payload = [key, id, ...(sortSpec ? [sortSpec] : []), ...(backward ? ['p'] : [])].join('|');
  return Buffer.from(payload, 'utf8').toString('base64url');
}
function tokenParts(token: string): string[] {
  return Buffer.from(token, 'base64url').toString('utf8').split('|');
}

// ---------------------------------------------------------------------------
// The synthetic platform: a wire-policy stand-in for the ADM-UX-02 route
// (token grammar, bind-and-reject, sentinel ordering, 128 bound) so the REAL
// shell + REAL fetcher can be walked over real sockets offline. It is not the
// route and claims nothing about PostgreSQL; describe A above covers the real
// handler's semantics.
// ---------------------------------------------------------------------------
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

interface SynthCursor {
  key: string;
  id: string;
  sort: string;
  dir: 'next' | 'prev';
}

function synthDecode(raw: string | null): SynthCursor | null {
  if (raw === null) return null;
  if (raw.length === 0 || raw.length > LIST_CURSOR_MAX_LEN) return null;
  const parts = Buffer.from(raw, 'base64url').toString('utf8').split('|');
  if (parts.length < 2 || parts.length > 4) return null;
  const key = parts[0] ?? '';
  const id = parts[1] ?? '';
  const tail = parts.slice(2);
  let dir: 'next' | 'prev' = 'next';
  if (tail.length > 0 && tail[tail.length - 1] === 'p') {
    dir = 'prev';
    tail.pop();
  }
  let sort = OPERATIONS_LIST_SORT_DEFAULT;
  if (tail.length === 1) {
    const slot = tail[0] ?? '';
    if (!OPERATIONS_LIST_SORT_VALUES.includes(slot as (typeof OPERATIONS_LIST_SORT_VALUES)[number])) return null;
    sort = slot;
  } else if (tail.length > 1) {
    return null;
  }
  if (!UUID_RE.test(id) || !/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/.test(key)) return null;
  return { key, id, sort, dir };
}

function synthWindow(sort: string, c: SynthCursor | null, tenant: string | null, limit: number) {
  const field = sort.slice(0, sort.indexOf(':'));
  const declaredDesc = sort.endsWith(':desc');
  const scanDesc = c === null ? declaredDesc : (c.dir === 'next') === declaredDesc;
  const all = POP.filter((r) => tenant === null || r.tenant === tenant);
  const sentinel = scanDesc ? SENTINEL_DESC : SENTINEL_ASC;
  const ordered = [...all].sort((x, y) => {
    const kx = keyOf(x, field, sentinel);
    const ky = keyOf(y, field, sentinel);
    if (kx !== ky) return (kx < ky ? -1 : 1) * (scanDesc ? -1 : 1);
    return (x.id < y.id ? -1 : 1) * (scanDesc ? -1 : 1);
  });
  let window = ordered;
  if (c) {
    const opBefore = scanDesc;
    window = ordered.filter((r) => {
      const k = keyOf(r, field, sentinel);
      if (k === c.key) return opBefore ? r.id < c.id : r.id > c.id;
      return opBefore ? k < c.key : k > c.key;
    });
  }
  const probe = window.slice(0, limit + 1);
  return { rows: probe.slice(0, limit), hasMore: probe.length > limit, ordered, field };
}

describe('W-ADMUX02-CROSS-SORT-422-1 B: real shell over HTTP against a wire-faithful platform', () => {
  // Non-ephemeral base ports per the admin-shell-server precedent (Windows
  // filters ephemeral destination ports; see the Δ74 flake note in the receipt).
  const PORT_BASE = 47_100 + (process.pid % 25) * 24;
  let platformSrv: http.Server;
  let shell: AdminShellHandle;
  let platBase = '';
  let shellBase = '';
  let cookie = '';
  interface Hit {
    search: string;
    cursorLen: number;
    sort: string;
    status: number;
  }
  let hits: Hit[] = [];
  let lastNextCursor = '';

  function platformRow(r: Row): Record<string, unknown> {
    return {
      id: r.id, tenantId: r.tenant, businessId: 'example-review', businessVersion: '1.0.0',
      action: 'review', state: 'RUNNING', stateVersion: 1, createdAt: r.created,
      updatedAt: r.updated, deadlineAt: r.deadline, replayOf: null,
      progress: { percent: 10, message: '' },
      links: { self: '/api/v1/operations/' + r.id, result: '/api/v1/operations/' + r.id + '/result' },
      wait: null, error: null,
    };
  }
  function synth422(res: ServerResponse, code: string, detail: string): void {
    res.statusCode = 422;
    res.setHeader('content-type', 'application/problem+json');
    res.end(JSON.stringify({ status: 422, code, detail }));
  }
  function handlePlatform(req: IncomingMessage, res: ServerResponse): void {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (u.pathname !== '/api/v1/operations') {
      // Any other platform surface the shell might probe is out of scope here;
      // never record it as a sort-policy hit.
      res.statusCode = 404;
      res.end('{}');
      return;
    }
    const record = (status: number, sort: string, cursorLen: number): void => {
      hits.push({ search: u.search, cursorLen, sort, status });
    };
    if (req.headers.authorization !== 'Bearer ' + ADMIN_TOKEN) {
      res.statusCode = 401;
      res.end('{}');
      return;
    }
    const limitRaw = Number(u.searchParams.get('limit') ?? '20');
    const limit = Number.isFinite(limitRaw) && limitRaw >= 1 && limitRaw <= 100
      ? Math.trunc(limitRaw) : 20;
    const sortParam = u.searchParams.get('sort');
    let sort = OPERATIONS_LIST_SORT_DEFAULT;
    if (sortParam !== null && sortParam.length > 0) {
      if (!OPERATIONS_LIST_SORT_VALUES.includes(sortParam as (typeof OPERATIONS_LIST_SORT_VALUES)[number])) {
        record(422, sortParam, 0);
        synth422(res, 'INVALID_SCHEMA', 'sort must be <field>:<direction>');
        return;
      }
      sort = sortParam;
    }
    const cursorRaw = u.searchParams.get('cursor');
    const decoded = synthDecode(cursorRaw);
    if (cursorRaw !== null && decoded === null) {
      record(422, sort, cursorRaw.length);
      synth422(res, 'INVALID_SCHEMA', 'cursor is not a valid operations-list cursor');
      return;
    }
    if (decoded && decoded.sort !== sort) {
      record(422, sort, cursorRaw?.length ?? 0);
      synth422(res, 'INVALID_SCHEMA', 'cursor was issued for sort=' + decoded.sort
        + ' and cannot page sort=' + sort
        + '; drop the cursor parameter to start this ordering at its first page');
      return;
    }
    const tenantParam = u.searchParams.get('tenant');
    if (tenantParam !== null && !UUID_RE.test(tenantParam)) {
      record(422, sort, 0);
      synth422(res, 'INVALID_SCHEMA', 'tenant must be a tenant id');
      return;
    }
    const win = synthWindow(sort, decoded, tenantParam, limit);
    const sentinelFor = (s: string): string => (s.endsWith(':asc') ? SENTINEL_ASC : SENTINEL_DESC);
    const items = win.rows.map(platformRow);
    let nextCursor: string | null = null;
    let prevCursor: string | null = null;
    if (win.hasMore && win.rows.length > 0) {
      const last = win.rows[win.rows.length - 1] as Row;
      nextCursor = buildToken(keyOf(last, sort.slice(0, sort.indexOf(':')), sentinelFor(sort)), last.id, sort);
    }
    if (decoded && decoded.dir === 'next' && win.rows.length > 0) {
      const first = win.rows[0] as Row;
      prevCursor = buildToken(keyOf(first, sort.slice(0, sort.indexOf(':')), sentinelFor(sort)), first.id, sort, true);
    }
    record(200, sort, cursorRaw?.length ?? 0);
    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ items, nextCursor, prevCursor, total: win.ordered.length, limit }));
  }

  function httpForm(url: string, body: string): Promise<{ status: number; setCookie: string | null }> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = http.request(
        {
          hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'POST',
          headers: { 'content-type': 'application/x-www-form-urlencoded' }, agent: false,
        },
        (res) => {
          const chunks: Buffer[] = [];
          res.on('data', (c: Buffer) => chunks.push(c));
          res.on('end', () => {
            const sc = res.headers['set-cookie'];
            const first = Array.isArray(sc) ? sc[0] : sc;
            resolve({
              status: res.statusCode ?? 0,
              setCookie: first ? first.split(';')[0] ?? '' : null,
            });
          });
        },
      );
      req.on('error', reject);
      req.write(body);
      req.end();
    });
  }

  beforeAll(async () => {
    hits = [];
    platformSrv = http.createServer((req, res) => handlePlatform(req, res));
    await new Promise<void>((r) => platformSrv.listen(PORT_BASE, '127.0.0.1', r));
    platBase = 'http://127.0.0.1:' + String(PORT_BASE);
    shell = createAdminShellServer({
      port: PORT_BASE + 4,
      cookieSecret: COOKIE_SECRET,
      adminToken: ADMIN_TOKEN,
      jsonBaseUrl: platBase,
      // Offline suite over plain HTTP: pin the cookie posture instead of
      // inheriting it from the ambient NODE_ENV. Without this, NODE_ENV=production
      // makes parseCookieSecurePolicy set requireSecure (oidc-boot.ts), the shell
      // refuses to mint an unprotectable cookie and POST /admin/login answers 503
      // (auth-dispatch.ts:120-130) instead of the 302 this suite logs in with.
      // Same pin as admin-shell-server.test.ts:121, aweb0x/bff-* and f5/tenant-list.
      cookiePolicy: { requireSecure: false, trustProxyProtocol: false },
    });
    await shell.listen();
    shellBase = shell.url;
    const login = await httpForm(shellBase + '/admin/login',
      'token=' + encodeURIComponent(ADMIN_TOKEN) + '&redirect=' + encodeURIComponent('/admin/operations'));
    expect(login.status).toBe(302);
    expect(login.setCookie).not.toBeNull();
    cookie = login.setCookie as string;
  }, 30_000);

  afterAll(async () => {
    await shell.close();
    await new Promise<void>((r, j) => platformSrv.close((e) => (e ? j(e) : r())));
  });

  function shellGet(query: string): Promise<WireResponse> {
    return httpGet(shellBase + '/admin/operations?' + query, { cookie });
  }
  function qs(href: string): URLSearchParams {
    return new URLSearchParams((href.split('?')[1] ?? '').replace(/&amp;/g, '&'));
  }
  function paneIds(html: string): string[] {
    return [...html.matchAll(/data-operation-row="([^"]+)"/g)].map((m) => m[1] ?? '');
  }
  function nextHref(html: string): string | null {
    const m = /<a class="admin-pagination__next" href="([^"]*)"/.exec(html);
    return m ? m[1]!.replace(/&amp;/g, '&') : null;
  }

  it('B1: a wire pane honors the sort it was sent and marks it in the toolbar', async () => {
    hits = [];
    const r = await shellGet('limit=2&sort=' + encodeURIComponent('deadline_at:asc'));
    expect(r.status).toBe(200);
    expect(r.body).toContain('data-list-sort="deadline_at:asc"');
    expect(paneIds(r.body)).toEqual(oracleOrder('deadline_at:asc').slice(0, 2));
    expect(r.body).toContain('<option value="deadline_at:asc" data-sort-option="deadline_at:asc" selected>Deadline soonest first</option>');
    expect(hits.length).toBe(1);
    expect(hits[0]!.sort).toBe('deadline_at:asc');
  });

  it('B2: walking every sort through the real pane keeps cursor+sort paired and loses nothing', async () => {
    for (const sort of OPERATIONS_LIST_SORT_VALUES) {
      hits = [];
      const seen: string[] = [];
      let href: string | null = '/admin/operations?limit=2&sort=' + encodeURIComponent(sort);
      let hops = 0;
      while (href) {
        const r = await httpGet(shellBase + href, { cookie });
        expect(r.status).toBe(200);
        expect(r.body).not.toContain('HTTP 422');
        for (const id of paneIds(r.body)) seen.push(id);
        hops += 1;
        if (hops > 12) throw new Error('pane walk loops under ' + sort);
        href = nextHref(r.body);
        if (href) {
          const q = qs(href);
          // The emitted next link carries BOTH halves of the bound pair.
          expect(q.has('cursor')).toBe(true);
          if (sort !== OPERATIONS_LIST_SORT_DEFAULT) expect(q.get('sort')).toBe(sort);
        }
      }
      expect(seen).toEqual(oracleOrder(sort));
      // zero 422s reached the platform during a well-formed pane walk
      expect(hits.every((h) => h.status === 200)).toBe(true);
    }
  });

  it('B3: a hand-typed cross-sort replay reaches the pane as the 422 remedy, not as a wrong-ordered list', async () => {
    const r1 = await shellGet('limit=2&sort=' + encodeURIComponent('created_at:asc'));
    const href = nextHref(r1.body);
    expect(href).not.toBeNull();
    const cursor = qs(href as string).get('cursor');
    expect(cursor).not.toBeNull();
    hits = [];
    const r2 = await shellGet('limit=2&sort=' + encodeURIComponent('deadline_at:asc')
      + '&cursor=' + encodeURIComponent(cursor as string));
    // The shell itself answers 200 with an honest ERROR pane; the platform 422
    // (and only the platform's) is what the pane reports.
    expect(r2.status).toBe(200);
    expect(r2.body).toContain('drop the cursor parameter');
    expect(paneIds(r2.body)).toEqual([]);
    expect(hits.some((h) => h.status === 422)).toBe(true);
  });

  it('B4: the page-2 toolbar form still carries no cursor field over the wire', async () => {
    const r1 = await shellGet('limit=2&sort=' + encodeURIComponent('updated_at:asc'));
    const href = nextHref(r1.body);
    const r2 = await httpGet(shellBase + (href as string), { cookie });
    expect(paneIds(r2.body).length).toBe(2);
    const start = r2.body.indexOf('data-filter-bar="true"');
    const form = r2.body.slice(start, r2.body.indexOf('</form>', start));
    expect(start).toBeGreaterThan(0);
    expect(form).toContain('name="sort"');
    expect(form).not.toContain('name="cursor"');
  });

  it('B5: tenancy through the pane - scoped shows one tenant, default shows both, garbage never echoes', async () => {
    const all = await shellGet('limit=5');
    expect(paneIds(all.body).sort()).toEqual(POP.map((r) => r.id).sort());
    const scoped = await shellGet('limit=5&tenant=' + TENANT_A);
    const scopedIds = paneIds(scoped.body);
    expect(scopedIds.sort()).toEqual(POP.filter((r) => r.tenant === TENANT_A).map((r) => r.id).sort());
    expect(scopedIds.some((id) => id.startsWith('4') || id.startsWith('5'))).toBe(false);
    const junk = await shellGet('limit=5&tenant=' + encodeURIComponent('nope;bad'));
    expect(junk.status).toBe(200);
    expect(junk.body).toContain('ignored (invalid characters)');
    expect(junk.body).not.toContain('nope;bad');
    expect(paneIds(junk.body).sort()).toEqual(POP.map((r) => r.id).sort());
  });

  it('B6: a >128 cursor reaches the platform TRUNCATED by the shell and surfaces as an honest error (fragility pinned)', async () => {
    hits = [];
    const r = await shellGet('limit=2&cursor=' + 'z'.repeat(LIST_CURSOR_MAX_LEN * 2));
    expect(r.status).toBe(200);
    expect(r.body).toContain('cursor is not a valid');
    expect(paneIds(r.body)).toEqual([]);
    const hit = hits.find((h) => h.cursorLen > 0);
    expect(hit).toBeDefined();
    expect(hit!.cursorLen).toBe(LIST_CURSOR_MAX_LEN);
  });
});

