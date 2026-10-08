/**
 * F-3 (coverage gap, `tenant-usage-connector-verify-dsh2-2026-10-08.md` §F-3): LIVE proof for the
 * tenant roster. The existing suites prove the roster against a FAKE db that re-implements the
 * production SQL (`tenant-list-cursor-codec-offline.test.ts`) or against a STUB upstream
 * (`tenant-list-bff-offline.test.ts`); neither runs `GET /api/v1/admin/tenants` against real
 * PostgreSQL with a real `tenant_operator` credential.
 *
 * This suite closes that gap by booting the REAL app (`src/server.ts` `createApp`) on an ISOLATED
 * PostgreSQL schema (per-run `du_test_*` schema + dedicated Redis DB index, repo convention:
 * `tests/isolation/namespace.ts`) and driving the REAL route over HTTP on the INTERNAL listener
 * (`/api/v1/admin/**` is fenced off the public listener by PM-M02-ROUTE - pinned as case 0):
 *
 *   (a) tenant_operator scope B -> exactly its own row, no other tenant id/name anywhere in the
 *       response body (including the boot-seeded `default` tenant), and a foreign `?tenantId=`
 *       cannot widen the scope (the route reads the scope from the credential, not the query);
 *   (b) platform principal without `tenantId` -> the whole roster in PG's own
 *       `(lower(name), id)` order, with the strict `{id,name,state}` wire item and a non-ACTIVE
 *       (`SUSPENDED`) state projected verbatim;
 *   (c) real keyset pagination: page 1 -> nextCursor -> page 2 with no duplicate/omitted row,
 *       and prevCursor walking back to the exact previous window;
 *   (d) forged/invalid cursors -> 422 INVALID_SCHEMA problem+json (never a silent list restart),
 *       while a well-formed cursor naming an UNKNOWN tenant is an honest empty page whose `total`
 *       still counts the whole scoped population;
 *   (e) cursors minted at a boundary OUTSIDE scope B are fail-closed under scope B: an empty
 *       page with no leaked boundary row and no ordering probe (the boundary subquery carries the
 *       scope predicate, `tenant-list.ts:132-133`), while the SAME token on the platform path is
 *       a working boundary (control);
 *   (f) `limit` clamps, default, and the documented ignore-unknown-parameter allow-list behaviour.
 *
 * ORACLE / ISOLATION: every roster expectation is compared against a DIRECT SQL snapshot of the
 * SAME isolated schema (`SELECT id::text, name, state FROM tenants ORDER BY lower(name), id`), so
 * the assertions are exact equalities that do not depend on other lanes, on shared-DB churn, or on
 * the size of the boot-seeded population. This suite seeds three tenants of its own
 * (ACTIVE/ACTIVE/SUSPENDED); `createApp` additionally seeds its documented dev-fallback `default`
 * tenant under `autoMigrate: true` (RFX-10), which the snapshot naturally includes. `afterAll`
 * drops only this run's schema - the shared database and other lanes' schemas are untouched.
 *
 * WINDOW GUARD (repo convention, same as `pm-m02-ingress-verification.test.ts` /
 * `admin-audit.test.ts`): without `DU_LIVE_INFRA=1` everything below is skipped - no schema, no
 * createApp, no listen, no connection. Offline runs therefore report it as skipped, never as a
 * pass.
 */
import { randomUUID } from 'node:crypto';
import type { Server as HttpServer } from 'node:http';
import type { AddressInfo, Server as TcpServer } from 'node:net';
import { Pool } from 'pg';
import {
  ADMIN_LIST_LIMIT_DEFAULT,
  ADMIN_LIST_LIMIT_MAX,
  LIST_CURSOR_MAX_LEN,
} from '@du/contracts';
import { createApp, type App, type ServerConfig } from '../src/server';
import {
  assertSafeIsolationConfig,
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../../../../tests/isolation/namespace';
import {
  validateTestDatabaseTarget,
  validateTestRedisTarget,
} from './helpers/test-target-guard';

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

const ADMIN_TOKEN = 'f3-adm-' + randomUUID();
const RUNTIME_TOKEN = 'f3-rt-' + randomUUID();
const OP_A_TOKEN = 'f3-op-a-' + randomUUID();
const OP_B_TOKEN = 'f3-op-b-' + randomUUID();

const TENANT_A = 'f3a11111-1111-4111-8111-f3a111111111';
const TENANT_B = 'f3b22222-2222-4222-8222-f3b222222222';
const TENANT_C = 'f3c33333-3333-4333-8333-f3c333333333';
const NAME_A = 'f3roster-alpha';
const NAME_B = 'f3roster-bravo';
const NAME_C = 'f3roster-charlie';
const ROSTER_PATH = '/api/v1/admin/tenants';
const WALK_LIMIT = 2;
const UNKNOWN_TENANT = '99999999-9999-4999-8999-999999999999';
/** The tenant createApp seeds under autoMigrate:true (RFX-10 dev fallback). */
const SEEDED_DEFAULT_TENANT = '00000000-0000-0000-0000-000000000001';

const ITEM_A = { id: TENANT_A, name: NAME_A, state: 'ACTIVE' };
const ITEM_B = { id: TENANT_B, name: NAME_B, state: 'ACTIVE' };
const ITEM_C = { id: TENANT_C, name: NAME_C, state: 'SUSPENDED' };

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52).
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn(
    'f3-tenants-route-live.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.'
  );
}

let app: App | undefined;
let isolation: TestIsolationContext | undefined;
let databaseUrl = '';
let redisUrl = '';
let publicPort = 0;
let internalPort = 0;

interface TenantItem {
  id: string;
  name: string;
  state: string;
}

interface RosterPage {
  items: TenantItem[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  limit: number;
}

interface Wire {
  status: number;
  contentType: string;
  body: string;
}

interface ProblemBody {
  status?: number;
  code?: string;
  items?: unknown;
}

function addressOf(server: TcpServer): AddressInfo {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('expected a bound TCP listener with an internet address');
  }
  return address;
}

function requireInternalServer(target: App): HttpServer {
  const server = (target as unknown as { internalServer?: HttpServer }).internalServer;
  if (!server) throw new Error('app.internalServer was not exposed by createApp');
  return server;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function serverConfig(): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    internalPort: 0,
    internalHost: '127.0.0.1',
    databaseUrl,
    redisUrl,
    runtimeToken: RUNTIME_TOKEN,
    adminToken: ADMIN_TOKEN,
    // R3-02 tenant principals: OP_A is bound to A, OP_B to B. Per-run random
    // tokens cannot alias the platform/runtime tokens (the boot guard refuses
    // aliases).
    tenantAdminTokens: { [OP_A_TOKEN]: TENANT_A, [OP_B_TOKEN]: TENANT_B },
    connectorBaseUrls: {},
    autoMigrate: true,
    autoDispatch: false,
    leaseRecoveryIntervalMs: 0,
    webhookDispatchIntervalMs: 0,
    shutdownTimeoutMs: 10,
    shutdownPollIntervalMs: 1,
  };
}

liveDescribe('F-3: GET /api/v1/admin/tenants over REAL PostgreSQL (DU_LIVE_INFRA=1)', () => {
  beforeAll(async () => {
    validateTestDatabaseTarget(BASE_DATABASE_URL);
    validateTestRedisTarget(BASE_REDIS_URL);
    isolation = createTestIsolationContext({
      runId: `f3_tenants_${randomUUID().replace(/-/g, '')}`,
    });
    databaseUrl = isolation.getDatabaseUrlWithSchema(BASE_DATABASE_URL);
    redisUrl = isolation.getRedisUrl(BASE_REDIS_URL);
    validateTestDatabaseTarget(databaseUrl);
    validateTestRedisTarget(redisUrl);
    assertSafeIsolationConfig({ databaseUrl, redisUrl, isolationCtx: isolation });

    const setupPool = new Pool({ connectionString: BASE_DATABASE_URL });
    try {
      await setupPool.query(generateSchemaSetupDdl(isolation.dbSchema));
    } finally {
      await setupPool.end();
    }

    app = await createApp(serverConfig());
    const publicServer = await app.listen();
    publicPort = addressOf(publicServer).port;
    internalPort = addressOf(requireInternalServer(app)).port;

    // Three suite-owned tenants; createApp's own dev-fallback `default` row is
    // included by the snapshot oracle below, not asserted away.
    await app.db.query(
      `INSERT INTO tenants (id, name, state)
       VALUES ($1,$2,'ACTIVE'), ($3,$4,'ACTIVE'), ($5,$6,'SUSPENDED')`,
      [TENANT_A, NAME_A, TENANT_B, NAME_B, TENANT_C, NAME_C]
    );
  }, 180_000);

  afterAll(async () => {
    await app?.close({ timeoutMs: 10, pollIntervalMs: 1 }).catch(() => undefined);
    if (isolation && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const cleanupPool = new Pool({ connectionString: BASE_DATABASE_URL });
      try {
        await cleanupPool.query(generateSchemaTeardownDdl(isolation.dbSchema));
      } finally {
        await cleanupPool.end();
      }
    }
    isolation?.cleanupArtifactDir();
  }, 60_000);

  /** Direct-SQL oracle over the SAME isolated schema, in PG's own roster order. */
  async function snapshot(): Promise<TenantItem[]> {
    if (!app) throw new Error('app is not booted');
    const result = await app.db.query<TenantItem & Record<string, unknown>>(
      `SELECT id::text AS id, name, state FROM tenants ORDER BY lower(name), id`
    );
    return result.rows as unknown as TenantItem[];
  }

  /** The roster is an admin surface: served on the internal listener only (PM-M02-ROUTE). */
  async function roster(search = '', token = ADMIN_TOKEN, port = internalPort): Promise<Wire> {
    const res = await fetch(`http://127.0.0.1:${port}${ROSTER_PATH}${search}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    return {
      status: res.status,
      contentType: res.headers.get('content-type') ?? '',
      body: await res.text(),
    };
  }

  function pageOf(wire: Wire): RosterPage {
    return JSON.parse(wire.body) as RosterPage;
  }

  function problemOf(wire: Wire): ProblemBody {
    return JSON.parse(wire.body) as ProblemBody;
  }

  /** The route's own cursor format: base64url(<uuid>) for a forward boundary. */
  function cursorOf(id: string): string {
    return Buffer.from(id, 'utf8').toString('base64url');
  }

  function withCursor(raw: string): string {
    return `&cursor=${encodeURIComponent(raw)}`;
  }

  function expectNoLeak(body: string, others: readonly TenantItem[]): void {
    for (const other of others) {
      expect({ other: other.id, leaked: body.includes(other.id) }).toEqual({
        other: other.id,
        leaked: false,
      });
      expect({ other: other.name, leaked: body.includes(other.name) }).toEqual({
        other: other.name,
        leaked: false,
      });
    }
  }

  it('(0) serves the roster on the INTERNAL listener and 404s it on the public listener', async () => {
    const internal = await roster();
    expect(internal.status).toBe(200);

    const publicWire = await roster('', ADMIN_TOKEN, publicPort);
    expect(publicWire.status).toBe(404);
    expect(problemOf(publicWire).code).toBe('NOT_FOUND');
    // The ingress fence must not describe the hidden surface or its rows.
    expect(publicWire.body).not.toContain(NAME_A);
    expect(publicWire.body).not.toContain(TENANT_A);
  });

  it('denies an anonymous roster read before any tenant row is serialized', async () => {
    const anonymous = await roster('', 'f3-not-a-token-' + randomUUID());
    expect(anonymous.status).toBe(401);
    expect(problemOf(anonymous).code).toBe('UNAUTHENTICATED');
    expect(anonymous.body).not.toContain(NAME_A);

    const missing = await fetch(`http://127.0.0.1:${internalPort}${ROSTER_PATH}`);
    expect(missing.status).toBe(401);
  });

  it('(a) tenant_operator scope B reads exactly its own row and leaks no other tenant id/name', async () => {
    const wire = await roster('', OP_B_TOKEN);

    expect(wire.status).toBe(200);
    const page = pageOf(wire);
    expect(page.items).toEqual([ITEM_B]);
    expect(page.total).toBe(1);
    expect(page.limit).toBe(ADMIN_LIST_LIMIT_DEFAULT);
    // A single-row scope has no keyset neighbours: both cursors must be absent.
    expect(page.nextCursor).toBeNull();
    expect(page.prevCursor).toBeNull();

    // No foreign tenant id or name may appear ANYWHERE in the response body.
    const foreign = (await snapshot()).filter((row) => row.id !== TENANT_B);
    expect(foreign.length).toBeGreaterThanOrEqual(3);
    expectNoLeak(wire.body, foreign);
    // ...including the boot-seeded dev-fallback tenant.
    expect(wire.body.includes(SEEDED_DEFAULT_TENANT)).toBe(false);
    expect(wire.body.includes('default')).toBe(false);
  });

  it('(a2) a foreign ?tenantId= cannot widen the operator scope (the route takes no scope param)', async () => {
    for (const foreign of [TENANT_A, TENANT_C, SEEDED_DEFAULT_TENANT, UNKNOWN_TENANT]) {
      const wire = await roster(`?tenantId=${foreign}`, OP_B_TOKEN);

      expect({ foreign, status: wire.status }).toEqual({ foreign, status: 200 });
      expect({ foreign, items: pageOf(wire).items }).toEqual({ foreign, items: [ITEM_B] });
      expect({ foreign, leaked: wire.body.includes(foreign) }).toEqual({ foreign, leaked: false });
    }
  });

  it('(b) platform principal without tenantId reads the whole roster in (lower(name), id) order', async () => {
    const oracle = await snapshot();
    const wire = await roster();

    expect(wire.status).toBe(200);
    expect(wire.contentType).toContain('application/json');
    const page = pageOf(wire);
    expect(page.items).toEqual(oracle);
    expect(page.total).toBe(oracle.length);
    expect(page.limit).toBe(ADMIN_LIST_LIMIT_DEFAULT);
    expect(page.nextCursor).toBeNull();
    expect(page.prevCursor).toBeNull();

    // The wire item is exactly { id, name, state } - nothing else is projected.
    for (const item of page.items) {
      expect(Object.keys(item).sort()).toEqual(['id', 'name', 'state']);
    }
    // The suite's three rows are present, and a non-ACTIVE state is projected verbatim.
    expect(page.items).toEqual(expect.arrayContaining([ITEM_A, ITEM_B, ITEM_C]));
    expect(page.items.find((item) => item.id === TENANT_C)?.state).toBe('SUSPENDED');
    // Live observation: the zero-config boot seeds its dev-fallback tenant, so the roster is
    // never empty (RFX-10) - the oracle carries it and so must the wire.
    const seeded = oracle.find((row) => row.id === SEEDED_DEFAULT_TENANT);
    if (seeded) expect(page.items).toContainEqual(seeded);
  });

  it('(c1) keyset walk with limit=2 visits every row exactly once, in order', async () => {
    const oracle = await snapshot();
    const expectedPages = chunk(oracle, WALK_LIMIT);
    const pages: RosterPage[] = [];
    let cursor: string | null = null;

    for (let i = 0; i < 10; i++) {
      const wire = await roster(`?limit=${WALK_LIMIT}${cursor === null ? '' : withCursor(cursor)}`);
      expect(wire.status).toBe(200);
      const page = pageOf(wire);
      pages.push(page);
      if (page.nextCursor === null) break;
      expect(page.nextCursor).not.toBe(cursor);
      cursor = page.nextCursor;
    }

    expect(pages.map((page) => page.items)).toEqual(expectedPages);
    // No duplicate row and no fabricated row.
    const seen = pages.flatMap((page) => page.items.map((item) => item.id));
    expect(new Set(seen).size).toBe(seen.length);
    expect(seen).toEqual(oracle.map((row) => row.id));
    // Cursor semantics: the walk starts with no Previous link and ends with no Next link.
    expect(pages[0]!.prevCursor).toBeNull();
    expect(pages[0]!.nextCursor).not.toBeNull();
    expect(pages[pages.length - 1]!.nextCursor).toBeNull();
    expect(pages[pages.length - 1]!.prevCursor).not.toBeNull();
    // `total` stays the whole scoped population on every page.
    for (const page of pages) expect(page.total).toBe(oracle.length);
  });

  it('(c2) prevCursor from page 2 walks back to exactly page 1', async () => {
    const oracle = await snapshot();
    const expectedPages = chunk(oracle, WALK_LIMIT);
    expect(expectedPages.length).toBeGreaterThanOrEqual(2);

    const first = await roster(`?limit=${WALK_LIMIT}`);
    const page1 = pageOf(first);
    expect(page1.items).toEqual(expectedPages[0]);
    expect(page1.nextCursor).not.toBeNull();

    const second = await roster(`?limit=${WALK_LIMIT}${withCursor(page1.nextCursor!)}`);
    const page2 = pageOf(second);
    expect(page2.items).toEqual(expectedPages[1]);
    expect(page2.prevCursor).not.toBeNull();

    const backwards = await roster(`?limit=${WALK_LIMIT}${withCursor(page2.prevCursor!)}`);
    const back = pageOf(backwards);

    expect(back.items).toEqual(page1.items);
    // Page 1 is the head of the roster, so the returned window advertises no Previous link
    // and a live forward link.
    expect(back.prevCursor).toBeNull();
    expect(back.nextCursor).not.toBeNull();
  });

  it('(d) forged or malformed cursors answer 422 INVALID_SCHEMA and never restart the list', async () => {
    const padded = Buffer.from(TENANT_B.slice(0, 35), 'utf8').toString('base64');
    expect(padded.endsWith('=')).toBe(true);
    const forged: Array<[string, string]> = [
      ['charset violation', '%%%not-a-cursor'],
      ['non-UUID payload', Buffer.from('tenant-name-is-not-a-uuid', 'utf8').toString('base64url')],
      ['padded standard base64', padded],
      ['over-long token', 'A'.repeat(LIST_CURSOR_MAX_LEN + 1)],
      ['non-canonical spelling', 'a'],
    ];

    for (const [label, bad] of forged) {
      const wire = await roster(`?limit=${WALK_LIMIT}${withCursor(bad)}`);
      expect({ label, status: wire.status }).toEqual({ label, status: 422 });
      expect({ label, contentType: wire.contentType }).toEqual({
        label,
        contentType: 'application/problem+json',
      });
      const problem = problemOf(wire);
      expect({ label, code: problem.code }).toEqual({ label, code: 'INVALID_SCHEMA' });
      expect({ label, reported: problem.status }).toEqual({ label, reported: 422 });
      // A malformed cursor must NOT be answered with page 1 (the silent-restart failure mode).
      expect({ label, items: problem.items }).toEqual({ label, items: undefined });
      expect({ label, hasItems: wire.body.includes('"items"') }).toEqual({ label, hasItems: false });
    }

    // The same fence applies on the tenant_operator path.
    const operator = await roster(`?limit=${WALK_LIMIT}&cursor=%25%25%25not-a-cursor`, OP_B_TOKEN);
    expect(operator.status).toBe(422);
    expect(problemOf(operator).code).toBe('INVALID_SCHEMA');

    // Observed live, and correct: the standard-base64 spelling of THIS 36-char UUID carries no
    // padding and no '+'/'/', so it is byte-identical to the base64url spelling and decodes
    // canonically - the route accepts it as the same boundary instead of 422ing it.
    const standard = Buffer.from(TENANT_B, 'utf8').toString('base64');
    expect(standard).toBe(cursorOf(TENANT_B));
    const oracle = await snapshot();
    const indexB = oracle.findIndex((row) => row.id === TENANT_B);
    expect(indexB).toBeGreaterThanOrEqual(0);
    const accepted = await roster(`?limit=${WALK_LIMIT}${withCursor(standard)}`);
    expect(accepted.status).toBe(200);
    expect(pageOf(accepted).items).toEqual(oracle.slice(indexB + 1));
  });

  it('(d2) a well-formed cursor naming an UNKNOWN tenant is an honest empty page, not a 422', async () => {
    const oracle = await snapshot();
    const wire = await roster(`?limit=${WALK_LIMIT}${withCursor(cursorOf(UNKNOWN_TENANT))}`);

    expect(wire.status).toBe(200);
    const page = pageOf(wire);
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    expect(page.prevCursor).toBeNull();
    // `total` counts the whole scoped population, so a boundary that matches no row does not
    // erase it (documented roster semantics, unlike a remaining-window count).
    expect(page.total).toBe(oracle.length);
  });

  it('(e) cursors minted OUTSIDE scope B are fail-closed: empty page, no leak, no order probe', async () => {
    const oracle = await snapshot();
    const indexB = oracle.findIndex((row) => row.id === TENANT_B);
    expect(indexB).toBeGreaterThan(0);
    expect(indexB).toBeLessThan(oracle.length - 1);
    const beforeB = oracle[indexB - 1]!;

    // A ROUTE-MINTED forward cursor at the row immediately before B. On the platform path the
    // same token is a real boundary (control below); under scope B the boundary tenant is
    // OUTSIDE the scope, so the scope-carrying subquery resolves to NULL and the page is empty
    // (`tenant-list.ts:132-133`). This is the hardened, fail-closed behaviour: a foreign cursor
    // cannot probe the ordering of a tenant the caller may not read.
    const minted = await roster(`?limit=${indexB}`);
    const mintedPage = pageOf(minted);
    expect(mintedPage.items).toEqual(oracle.slice(0, indexB));
    expect(mintedPage.nextCursor).not.toBeNull();

    const scoped = await roster(`?limit=${WALK_LIMIT}${withCursor(mintedPage.nextCursor!)}`, OP_B_TOKEN);
    expect(scoped.status).toBe(200);
    const scopedPage = pageOf(scoped);
    expect(scopedPage.items).toEqual([]);
    expect(scopedPage.total).toBe(1);
    expect(scopedPage.nextCursor).toBeNull();
    expect(scopedPage.prevCursor).toBeNull();
    expectNoLeak(scoped.body, [beforeB, ITEM_A, ITEM_C]);

    // CONTROL: the very same token on the platform path (no scope) IS a working boundary, so the
    // empty scoped page above is the scope fence, not a broken cursor.
    const control = await roster(`?limit=${WALK_LIMIT}${withCursor(mintedPage.nextCursor!)}`);
    expect(control.status).toBe(200);
    expect(pageOf(control).items).toEqual(oracle.slice(indexB));

    // An IN-scope boundary at B itself: the scope+cursor combination still works and there is
    // nothing beyond B inside the scope.
    const atB = await roster(`?limit=${WALK_LIMIT}${withCursor(cursorOf(TENANT_B))}`, OP_B_TOKEN);
    expect(atB.status).toBe(200);
    expect(pageOf(atB).items).toEqual([]);
    expect(pageOf(atB).total).toBe(1);
    expectNoLeak(atB.body, [ITEM_A, ITEM_C]);
  });

  it('(f) limit clamps, defaults, and unknown parameters stay ignored (no 422)', async () => {
    const oracle = await snapshot();

    const zero = pageOf(await roster('?limit=0'));
    expect(zero.limit).toBe(1);
    expect(zero.items).toEqual(oracle.slice(0, 1));

    const huge = pageOf(await roster(`?limit=${ADMIN_LIST_LIMIT_MAX + 500}`));
    expect(huge.limit).toBe(ADMIN_LIST_LIMIT_MAX);
    expect(huge.items).toEqual(oracle);

    const junk = pageOf(await roster('?limit=abc'));
    expect(junk.limit).toBe(ADMIN_LIST_LIMIT_DEFAULT);

    const inRange = pageOf(await roster(`?limit=${WALK_LIMIT}`));
    expect(inRange.limit).toBe(WALK_LIMIT);
    expect(inRange.items).toEqual(oracle.slice(0, WALK_LIMIT));

    // The parser is an allow-list: `sort`/`tenantId`/unknown names are dropped, not rejected.
    const ignored = await roster('?sort=name&note=whatever&tenantId=' + TENANT_A);
    expect(ignored.status).toBe(200);
    expect(pageOf(ignored).limit).toBe(ADMIN_LIST_LIMIT_DEFAULT);
  });
});
