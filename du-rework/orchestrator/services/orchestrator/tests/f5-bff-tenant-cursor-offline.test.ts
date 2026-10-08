/**
 * F-5: exercise tenant-list cursor scoping through the Admin BFF and the real
 * GET /api/v1/admin/tenants route, using a SQL-aware offline database fake.
 */
import http from 'node:http';
import type { QueryResult, QueryResultRow } from 'pg';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import type { AdminSessionStore, AdminSessionView } from '../src/modules/admin-actions/rbac';
import { isHttpError } from '../src/http/errors';
import { route } from '../src/server';
import type { RouteContext } from '../src/server';

const SECRET = 'f5-tenant-cursor-cookie-secret';
const PLATFORM_TOKEN = 'f5-platform-token';
const TENANT_B_TOKEN = 'f5-tenant-b-token';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_C = '22222222-2222-4222-8222-222222222222';
const TENANT_B = '33333333-3333-4333-8333-333333333333';
const TENANT_D = '44444444-4444-4444-8444-444444444444';
const OPERATOR_SESSION = 'O'.repeat(43);
const COOKIE_POLICY: NonNullable<ShellRuntimeConfig['cookiePolicy']> = {
  trustProxyProtocol: false,
  requireSecure: false,
};

const TENANTS: TenantRow[] = [
  { id: TENANT_A, name: 'Alpha tenant', state: 'ACTIVE' },
  { id: TENANT_C, name: 'Beta tenant with a foreign cursor', state: 'ACTIVE' },
  { id: TENANT_B, name: 'Gamma scoped tenant', state: 'ACTIVE' },
  { id: TENANT_D, name: 'Zulu tenant', state: 'ACTIVE' },
];

interface TenantRow extends QueryResultRow {
  id: string;
  name: string;
  state: string;
}

interface CapturedRequest {
  method: string;
  path: string;
  authorization: string | null;
}

interface TenantPage {
  items: Array<{ id: string; name: string; state: string }>;
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  limit: number;
}

const API_PORT = 47_400 + (process.pid % 19) * 2;
const BFF_PORT = API_PORT + 1;

function result<Row extends QueryResultRow>(rows: Row[]): QueryResult<Row> {
  return { command: 'SELECT', rowCount: rows.length, oid: 0, fields: [], rows };
}

function createOfflineDb() {
  return {
    async query<Row extends QueryResultRow>(sql: string, values: unknown[] = []): Promise<QueryResult<Row>> {
      const normalized = sql.replace(/\s+/g, ' ').trim();
      const countQuery = /^SELECT count\(\*\)::int AS total FROM tenants/i.test(normalized);
      if (countQuery) {
        const scope = /WHERE id = \$(\d+)/i.exec(normalized);
        const rows = scope
          ? TENANTS.filter((tenant) => tenant.id === String(values[Number(scope[1]) - 1]))
          : TENANTS;
        return result([{ total: rows.length } as unknown as Row]);
      }

      const scope = /FROM tenants WHERE id = \$(\d+)(?: AND|$)/i.exec(normalized);
      const scopedRows = scope
        ? TENANTS.filter((tenant) => tenant.id === String(values[Number(scope[1]) - 1]))
        : TENANTS.slice();
      const boundary = /\(lower\(name\), id\) ([<>]) \(\(SELECT lower\(name\) FROM tenants WHERE id = \$(\d+)(?: AND id = \$(\d+))?\), \$(\d+)::uuid\)/i.exec(normalized);
      let pageRows = scopedRows;
      if (boundary) {
        const cursorId = String(values[Number(boundary[2]) - 1]);
        const boundaryScope = boundary[3]
          ? String(values[Number(boundary[3]) - 1])
          : null;
        const cursorTenant = TENANTS.find((tenant) =>
          tenant.id === cursorId && (boundaryScope === null || tenant.id === boundaryScope));
        if (!cursorTenant) {
          pageRows = [];
        } else {
          const forward = boundary[1] === '>';
          pageRows = pageRows.filter((tenant) => {
            const compare = tenant.name.toLowerCase().localeCompare(cursorTenant.name.toLowerCase()) ||
              tenant.id.localeCompare(cursorTenant.id);
            return forward ? compare > 0 : compare < 0;
          });
        }
      }

      const order = /ORDER BY lower\(name\) (ASC|DESC), id (ASC|DESC) LIMIT \$(\d+)/i.exec(normalized);
      if (!order) throw new Error(`Unexpected tenant-list SQL: ${normalized}`);
      const orderFactor = order[1] === 'ASC' ? 1 : -1;
      pageRows = pageRows.slice().sort((left, right) =>
        (left.name.toLowerCase().localeCompare(right.name.toLowerCase()) || left.id.localeCompare(right.id)) * orderFactor);
      const limit = Number(values[Number(order[3]) - 1]);
      return result(pageRows.slice(0, limit) as unknown as Row[]);
    },
  };
}

class MapSessionStore implements AdminSessionStore {
  private readonly records = new Map<string, AdminSessionView>();

  add(sessionId: string, view: AdminSessionView): void {
    this.records.set(sessionId, view);
  }

  async get(sessionId: string): Promise<AdminSessionView | null> {
    return this.records.get(sessionId) ?? null;
  }
}

function legacyAdminCookie(): string {
  const nowMs = Date.now();
  const value = signCookie(SECRET, {
    iss: 'du-admin-shell',
    role: 'admin',
    iat: nowMs,
    exp: nowMs + 3_600_000,
  });
  if (!value) throw new Error('signCookie returned undefined');
  return `du_admin=${value}`;
}

function listen(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve());
  });
}

function opaqueCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}

function cursorId(token: string): string {
  return Buffer.from(token, 'base64url').toString('utf8').replace(/\|p$/, '');
}

describe('F-5 tenant cursor fence through the Admin BFF', () => {
  let apiServer: http.Server;
  let shell: AdminShellHandle;
  let shellUrl: string;
  let adminCookie: string;
  let requests: CapturedRequest[];

  beforeAll(async () => {
    requests = [];
    apiServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      requests.push({
        method: req.method ?? 'GET',
        path: url.pathname + url.search,
        authorization: typeof req.headers.authorization === 'string' ? req.headers.authorization : null,
      });
      const authorization = typeof req.headers.authorization === 'string' ? req.headers.authorization : '';
      const context = {
        ingressAudience: 'internal',
        method: req.method ?? 'GET',
        pathname: url.pathname,
        searchParams: url.searchParams,
        headers: { authorization },
        body: undefined,
        rawBody: Buffer.alloc(0),
        correlationId: 'f5-offline-test',
        host: '127.0.0.1',
        db: createOfflineDb(),
        config: {
          port: API_PORT,
          databaseUrl: 'postgres://offline.invalid/db',
          redisUrl: 'redis://offline.invalid',
          adminToken: PLATFORM_TOKEN,
          tenantAdminTokens: { [TENANT_B_TOKEN]: TENANT_B },
        },
      } as unknown as RouteContext;

      void route(context).then((routeResult) => {
        res.statusCode = routeResult.status;
        for (const [name, value] of Object.entries(routeResult.headers ?? {})) res.setHeader(name, value);
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify(routeResult.body ?? null));
      }).catch((error: unknown) => {
        if (isHttpError(error)) {
          res.statusCode = error.status;
          res.setHeader('content-type', 'application/problem+json');
          res.end(JSON.stringify(error.toProblem('f5-offline-test')));
          return;
        }
        res.statusCode = 500;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ code: 'INTERNAL_ERROR' }));
      });
    });
    await listen(apiServer, API_PORT);

    const sessions = new MapSessionStore();
    sessions.add(OPERATOR_SESSION, {
      role: 'operator',
      tenantId: TENANT_B,
      csrfToken: 'C'.repeat(43),
    });
    shell = createAdminShellServer({
      port: BFF_PORT,
      host: '127.0.0.1',
      cookieSecret: SECRET,
      adminToken: PLATFORM_TOKEN,
      tenantAdminTokens: { [TENANT_B_TOKEN]: TENANT_B },
      jsonBaseUrl: `http://127.0.0.1:${API_PORT}`,
      adminWeb: { distDir: 'Z:/does-not-exist' },
      cookiePolicy: COOKIE_POLICY,
      oidcSessions: sessions,
    });
    shellUrl = (await shell.listen()).url;
    adminCookie = legacyAdminCookie();
  });

  afterAll(async () => {
    await shell.close();
    await new Promise<void>((resolve, reject) => {
      apiServer.close((error) => error ? reject(error) : resolve());
    });
  });

  beforeEach(() => {
    requests.length = 0;
  });

  async function getPage(search: URLSearchParams, cookie: string): Promise<{ status: number; text: string; page: TenantPage }> {
    const response = await fetch(`${shellUrl}/admin/api/tenants?${search.toString()}`, {
      headers: { cookie },
    });
    const text = await response.text();
    return { status: response.status, text, page: JSON.parse(text) as TenantPage };
  }

  it('fences a foreign tenant cursor and its count at the BFF boundary', async () => {
    const foreignCursor = opaqueCursor(TENANT_C);
    const search = new URLSearchParams({ limit: '2', cursor: foreignCursor });
    const response = await getPage(search, `du_session=${OPERATOR_SESSION}`);

    expect(response.status).toBe(200);
    expect(response.page.items).toEqual([]);
    expect(response.page.total).toBe(1);
    expect(response.page.total).not.toBe(TENANTS.length);
    expect(response.page.nextCursor).toBeNull();
    expect(response.page.prevCursor).toBeNull();
    expect(response.text).not.toContain(TENANT_C);
    expect(response.text).not.toContain('Beta tenant with a foreign cursor');
    expect(requests).toEqual([{
      method: 'GET',
      path: `/api/v1/admin/tenants?limit=2&cursor=${foreignCursor}`,
      authorization: `Bearer ${TENANT_B_TOKEN}`,
    }]);
  });

  it('uses valid tenant B cursors for both next and previous pages', async () => {
    const pageOneSearch = new URLSearchParams({ limit: '1' });
    const pageOne = await getPage(pageOneSearch, adminCookie);
    expect(pageOne.status).toBe(200);
    expect(pageOne.page.items.map((tenant) => tenant.id)).toEqual([TENANT_A]);
    expect(pageOne.page.nextCursor).toBeTruthy();

    const pageTwoSearch = new URLSearchParams({ limit: '1', cursor: pageOne.page.nextCursor! });
    const pageTwo = await getPage(pageTwoSearch, adminCookie);
    expect(pageTwo.page.items.map((tenant) => tenant.id)).toEqual([TENANT_C]);
    expect(pageTwo.page.nextCursor).toBeTruthy();

    const pageThreeSearch = new URLSearchParams({ limit: '1', cursor: pageTwo.page.nextCursor! });
    const pageThree = await getPage(pageThreeSearch, adminCookie);
    expect(pageThree.page.items.map((tenant) => tenant.id)).toEqual([TENANT_B]);
    expect(pageThree.page.nextCursor).toBeTruthy();
    expect(pageThree.page.prevCursor).toBeTruthy();
    expect(cursorId(pageThree.page.nextCursor!)).toBe(TENANT_B);
    expect(cursorId(pageThree.page.prevCursor!)).toBe(TENANT_B);

    const nextSearch = new URLSearchParams({ limit: '1', cursor: pageThree.page.nextCursor! });
    const nextPage = await getPage(nextSearch, adminCookie);
    expect(nextPage.page.items.map((tenant) => tenant.id)).toEqual([TENANT_D]);

    const previousSearch = new URLSearchParams({ limit: '1', cursor: pageThree.page.prevCursor! });
    const previousPage = await getPage(previousSearch, adminCookie);
    expect(previousPage.page.items.map((tenant) => tenant.id)).toEqual([TENANT_C]);
  });
});
