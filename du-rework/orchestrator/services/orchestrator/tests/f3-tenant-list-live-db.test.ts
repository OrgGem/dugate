/**
 * Focused live proof for F-3: exercise listTenantPage directly against PostgreSQL
 * and GET /api/v1/admin/tenants through createApp's real internal HTTP listener.
 * createApp is wired to the isolated real Redis database as in the other live suites.
 */
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import IORedis from 'ioredis';
import type { Server as TcpServer } from 'node:net';
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
import {
  decodeTenantListCursor,
  encodeTenantListCursor,
  listTenantPage,
  type TenantDbRow,
} from '../src/modules/admin-read/tenant-list';

const BASE_DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
const BASE_REDIS_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
const PLATFORM_TOKEN = 'f3-list-platform-' + randomUUID();
const OPERATOR_TOKEN = 'f3-list-operator-' + randomUUID();
const RUNTIME_TOKEN = 'f3-list-runtime-' + randomUUID();
const TENANT_A = randomUUID();
const TENANT_B = randomUUID();
const TENANT_C = randomUUID();
const NAME_A = 'f3-live-list-alpha';
const NAME_B = 'f3-live-list-bravo';
const NAME_C = 'f3-live-list-charlie';
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;

if (!LIVE) {
  console.warn('f3-tenant-list-live-db.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window.');
}

interface RosterItem {
  id: string;
  name: string;
  state: string;
}

interface RosterPage {
  items: RosterItem[];
  nextCursor: string | null;
  prevCursor: string | null;
  total: number;
  limit: number;
}

interface WireResponse {
  status: number;
  body: string;
}

function requireInternalServer(target: App): TcpServer {
  const server = (target as unknown as { internalServer?: TcpServer }).internalServer;
  if (!server) throw new Error('app.internalServer was not exposed by createApp');
  return server;
}

function internalPortOf(server: TcpServer): number {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('expected a bound internal TCP listener');
  return address.port;
}

function serverConfig(databaseUrl: string, redisUrl: string): ServerConfig {
  return {
    port: 0,
    host: '127.0.0.1',
    internalPort: 0,
    internalHost: '127.0.0.1',
    databaseUrl,
    redisUrl,
    runtimeToken: RUNTIME_TOKEN,
    adminToken: PLATFORM_TOKEN,
    tenantAdminTokens: { [OPERATOR_TOKEN]: TENANT_B },
    connectorBaseUrls: {},
    autoMigrate: true,
    autoDispatch: false,
    leaseRecoveryIntervalMs: 0,
    webhookDispatchIntervalMs: 0,
    shutdownTimeoutMs: 10,
    shutdownPollIntervalMs: 1,
  };
}

liveDescribe('F-3 listTenantPage and GET /api/v1/admin/tenants with real PostgreSQL and Redis', () => {
  let app: App | undefined;
  let isolation: TestIsolationContext | undefined;
  let internalPort = 0;
  let isolatedDatabaseUrl = '';
  let isolatedRedisUrl = '';
  let schemaCreated = false;

  beforeAll(async () => {
    validateTestDatabaseTarget(BASE_DATABASE_URL);
    validateTestRedisTarget(BASE_REDIS_URL);

    isolation = createTestIsolationContext({
      runId: 'f3_tenant_list_live_' + randomUUID().replace(/-/g, ''),
    });
    isolatedDatabaseUrl = isolation.getDatabaseUrlWithSchema(BASE_DATABASE_URL);
    isolatedRedisUrl = isolation.getRedisUrl(BASE_REDIS_URL);
    validateTestDatabaseTarget(isolatedDatabaseUrl);
    validateTestRedisTarget(isolatedRedisUrl);
    assertSafeIsolationConfig({
      databaseUrl: isolatedDatabaseUrl,
      redisUrl: isolatedRedisUrl,
      isolationCtx: isolation,
    });

    const redisProbe = new IORedis(isolatedRedisUrl, { maxRetriesPerRequest: null });
    try {
      await expect(redisProbe.ping()).resolves.toBe('PONG');
    } finally {
      await redisProbe.quit();
    }

    const setupPool = new Pool({ connectionString: BASE_DATABASE_URL });
    try {
      await setupPool.query(generateSchemaSetupDdl(isolation.dbSchema));
      schemaCreated = true;
    } finally {
      await setupPool.end();
    }

    app = await createApp(serverConfig(isolatedDatabaseUrl, isolatedRedisUrl));
    await app.listen();
    internalPort = internalPortOf(requireInternalServer(app));
    await app.db.query(
      'INSERT INTO tenants (id, name, state) VALUES ($1,$2,$3), ($4,$5,$6), ($7,$8,$9)',
      [
        TENANT_A, NAME_A, 'ACTIVE',
        TENANT_B, NAME_B, 'ACTIVE',
        TENANT_C, NAME_C, 'SUSPENDED',
      ],
    );
  }, 180_000);

  afterAll(async () => {
    await app?.close({ timeoutMs: 10, pollIntervalMs: 1 }).catch(() => undefined);
    if (isolation && schemaCreated && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const cleanupPool = new Pool({ connectionString: BASE_DATABASE_URL });
      try {
        await cleanupPool.query(generateSchemaTeardownDdl(isolation.dbSchema));
      } finally {
        await cleanupPool.end();
      }
    }
    isolation?.cleanupArtifactDir();
  }, 60_000);

  async function snapshot(): Promise<RosterItem[]> {
    if (!app) throw new Error('app was not booted');
    const result = await app.db.query<RosterItem & Record<string, unknown>>(
      'SELECT id::text AS id, name, state FROM tenants ORDER BY lower(name), id',
    );
    return result.rows as unknown as RosterItem[];
  }

  async function roster(query: string, token = PLATFORM_TOKEN): Promise<WireResponse> {
    const response = await fetch(
      'http://127.0.0.1:' + internalPort + '/api/v1/admin/tenants' + query,
      { headers: { authorization: 'Bearer ' + token } },
    );
    return { status: response.status, body: await response.text() };
  }

  function parsePage(response: WireResponse): RosterPage {
    return JSON.parse(response.body) as RosterPage;
  }

  function decodedCursor(value: string | null) {
    if (value === null) throw new Error('expected a cursor');
    const cursor = decodeTenantListCursor(value);
    if (!cursor) throw new Error('route returned a malformed cursor');
    return cursor;
  }

  it('matches direct listTenantPage results to real route pages and walks next/prev cursors', async () => {
    if (!app) throw new Error('app was not booted');
    const oracle = await snapshot();
    expect(oracle).toEqual(expect.arrayContaining([
      { id: TENANT_A, name: NAME_A, state: 'ACTIVE' },
      { id: TENANT_B, name: NAME_B, state: 'ACTIVE' },
      { id: TENANT_C, name: NAME_C, state: 'SUSPENDED' },
    ]));

    const directFirst = await listTenantPage(app.db, null, { limit: 2, cursor: null });
    const routeFirstResponse = await roster('?limit=2');
    expect(routeFirstResponse.status).toBe(200);
    const routeFirst = parsePage(routeFirstResponse);
    expect(routeFirst.items).toEqual(directFirst.rows);
    expect(routeFirst.items).toEqual(oracle.slice(0, 2));
    expect(routeFirst.total).toBe(oracle.length);
    expect(routeFirst.nextCursor).not.toBeNull();

    const cursor = decodedCursor(routeFirst.nextCursor);
    const directSecond = await listTenantPage(app.db, null, { limit: 2, cursor });
    const routeSecondResponse = await roster('?limit=2&cursor=' + encodeURIComponent(routeFirst.nextCursor!));
    expect(routeSecondResponse.status).toBe(200);
    const routeSecond = parsePage(routeSecondResponse);
    expect(routeSecond.items).toEqual(directSecond.rows);
    expect(routeSecond.items).toEqual(oracle.slice(2, 4));
    expect(routeSecond.prevCursor).not.toBeNull();

    const prevCursor = routeSecond.prevCursor!;
    const directBack = await listTenantPage(app.db, null, {
      limit: 2,
      cursor: decodedCursor(prevCursor),
    });
    const routeBackResponse = await roster('?limit=2&cursor=' + encodeURIComponent(prevCursor));
    expect(routeBackResponse.status).toBe(200);
    const routeBack = parsePage(routeBackResponse);
    expect(routeBack.items).toEqual(directBack.rows);
    expect(routeBack.items).toEqual(routeFirst.items);
    expect(routeBack.prevCursor).toBeNull();

    const walked = routeFirst.items.concat(routeSecond.items);
    expect(walked.map((item) => item.id)).toEqual(oracle.map((item) => item.id));
    expect(new Set(walked.map((item) => item.id)).size).toBe(walked.length);
    expect(routeSecond.total).toBe(oracle.length);
  });

  it('applies tenant_operator SQL scope and fails closed for a foreign boundary cursor', async () => {
    if (!app) throw new Error('app was not booted');

    const directScoped = await listTenantPage(app.db, TENANT_B, { limit: 2, cursor: null });
    expect(directScoped.rows).toEqual([{ id: TENANT_B, name: NAME_B, state: 'ACTIVE' }]);
    expect(directScoped.total).toBe(1);

    const routeScopedResponse = await roster('', OPERATOR_TOKEN);
    expect(routeScopedResponse.status).toBe(200);
    const routeScoped = parsePage(routeScopedResponse);
    expect(routeScoped.items).toEqual(directScoped.rows);
    expect(routeScoped.total).toBe(1);
    expect(routeScoped.nextCursor).toBeNull();
    expect(routeScoped.prevCursor).toBeNull();

    const foreignBoundary = encodeTenantListCursor(TENANT_A, 'next');
    const directForeignCursor = await listTenantPage(app.db, TENANT_B, {
      limit: 2,
      cursor: decodedCursor(foreignBoundary),
    });
    const routeForeignResponse = await roster(
      '?limit=2&cursor=' + encodeURIComponent(foreignBoundary),
      OPERATOR_TOKEN,
    );
    expect(routeForeignResponse.status).toBe(200);
    const routeForeign = parsePage(routeForeignResponse);
    expect(Object.keys(routeForeign).sort()).toEqual(['items', 'limit', 'nextCursor', 'prevCursor', 'total']);
    expect(routeForeign.items).toEqual(directForeignCursor.rows);
    expect(routeForeign.items).toEqual([]);
    expect(routeForeign.total).toBe(1);
  });
});

