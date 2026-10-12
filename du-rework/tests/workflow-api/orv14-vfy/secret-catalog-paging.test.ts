import { randomBytes, randomUUID } from 'node:crypto';
import { createServer, type AddressInfo, type Server } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Db } from '../../../orchestrator/services/orchestrator/src/db/db';
import { createDb } from '../../../orchestrator/services/orchestrator/src/db/db';
import { migrate } from '../../../orchestrator/services/orchestrator/src/db/migrations';
import type { RouteContext } from '../../../orchestrator/services/orchestrator/src/http/route-context';
import { handleAdminRoutes } from '../../../orchestrator/services/orchestrator/src/http/routes/admin';
import { isHttpError } from '../../../orchestrator/services/orchestrator/src/http/errors';
import { createSecretInDb } from '../../../orchestrator/services/orchestrator/src/modules/secrets/secret-catalog-store';
import { createBackupSnapshotWriteGate } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/backup-effect-fence';
import { handleSecretsRoute, matchSecretsRoute } from '../../../orchestrator/services/orchestrator/src/app/admin/bff/secrets';
import type { AdminShellRequest } from '../../../orchestrator/services/orchestrator/src/app/admin/shell-types';
import type { ShellRuntimeConfig } from '../../../orchestrator/services/orchestrator/src/app/admin/shell-router';
import type { BffRuntimeConfig } from '../../../orchestrator/services/orchestrator/src/app/admin/bff/upstream';
import { SESSION_COOKIE_NAME, type SessionRecord } from '../../../orchestrator/services/orchestrator/src/modules/auth/session-store';
import { createTestIsolationContext, assertSafeIsolationConfig } from '../../isolation/namespace';
import type { SecretCatalogKeyring } from '../../../orchestrator/services/orchestrator/src/modules/secrets/secret-revision-resolver';

const runId = `orv14_vfy_secret_pages_${Date.now()}_${randomBytes(4).toString('hex')}`;
const baseDatabaseUrl = process.env.WFA_DATABASE_URL ?? 'postgresql://orv14_vfy:orv14-vfy-local-only@127.0.0.1:25414/orv14_vfy';
const isolation = createTestIsolationContext({ runId, baseArtifactPath: 'tests/workflow-api/orv14-vfy/artifacts' });
const databaseUrl = isolation.getDatabaseUrlWithSchema(baseDatabaseUrl);
assertSafeIsolationConfig({ databaseUrl, isolationCtx: isolation });

const tenantA = randomUUID();
const tenantB = randomUUID();
const adminToken = `orv14-vfy-secret-list-admin-${randomUUID()}`;
const platformSessionId = randomBytes(32).toString('base64url');
const operatorSessionId = randomBytes(32).toString('base64url');
const platformSession: SessionRecord = {
  sessionId: platformSessionId,
  issuer: 'https://synthetic-idp.invalid',
  sub: `admin-${randomUUID()}`,
  tenantId: null,
  role: 'admin',
  csrfToken: randomBytes(32).toString('base64url'),
  createdAt: Date.now(),
  lastSeenAt: Date.now(),
  expiresAt: Date.now() + 60_000,
};
const operatorSession: SessionRecord = {
  ...platformSession,
  sessionId: operatorSessionId,
  sub: `operator-${randomUUID()}`,
  tenantId: tenantA,
  role: 'operator',
};
const sessions = new Map([[platformSessionId, platformSession], [operatorSessionId, operatorSession]]);
const sessionStore = {
  get: async (id: string) => sessions.get(id) ?? null,
} as unknown as ShellRuntimeConfig['oidcSessions'];

const shellConfig: ShellRuntimeConfig = {
  cookieSecret: `synthetic-cookie-${randomUUID()}`,
  adminToken,
  oidcSessions: sessionStore,
};

let baseDb: Db | undefined;
let db: Db | undefined;
let schemaCreated = false;
let apiServer: Server | undefined;
let bffServer: Server | undefined;
let apiOrigin = '';
let bffOrigin = '';
let upstreamCalls = 0;
let cleanupErrors: string[] = [];
let listQueryCount = 0;
const targetIds: string[] = [];
const catalogKeyring: SecretCatalogKeyring = {
  activeVersion: 'orv14-vfy-secret-pages-v1',
  keys: { 'orv14-vfy-secret-pages-v1': randomBytes(32) },
};
const backupSnapshotWriteGate = createBackupSnapshotWriteGate();

function listen(server: Server): Promise<string> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function close(server: Server | undefined): Promise<void> {
  if (!server?.listening) return Promise.resolve();
  return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

function setJson(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.setHeader('cache-control', 'no-store');
  res.end(JSON.stringify(body));
}

function routeContext(input: IncomingMessage, url: URL, trackedDb: Db): RouteContext {
  const authorization = input.headers.authorization;
  return {
    ingressAudience: 'public',
    method: (input.method ?? 'GET').toUpperCase(),
    pathname: url.pathname,
    searchParams: url.searchParams,
    headers: { authorization: typeof authorization === 'string' ? authorization : '' },
    body: null,
    rawBody: Buffer.alloc(0),
    correlationId: randomUUID(),
    host: '127.0.0.1',
    db: trackedDb,
    config: { adminToken },
  } as unknown as RouteContext;
}

function parseCookies(req: IncomingMessage): Record<string, string> {
  const raw = req.headers.cookie ?? '';
  const result: Record<string, string> = {};
  for (const item of raw.split(';')) {
    const split = item.trim().indexOf('=');
    if (split <= 0) continue;
    result[item.slice(0, split).trim()] = item.slice(split + 1).trim();
  }
  return result;
}

function startApi(trackedDb: Db): Promise<string> {
  apiServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname === '/api/v1/admin/secrets' && (req.method ?? 'GET').toUpperCase() === 'GET') {
        upstreamCalls += 1;
      }
      const result = await handleAdminRoutes(routeContext(req, url, trackedDb));
      if (!result) return setJson(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
      setJson(res, result.status, result.body ?? null);
    } catch (error) {
      if (isHttpError(error)) return setJson(res, error.status, { error: { code: error.code, message: error.message } });
      setJson(res, 500, { error: { code: 'INTERNAL_ERROR', message: 'synthetic upstream route failed' } });
    }
  });
  return listen(apiServer);
}

function startBff(): Promise<string> {
  const runtime: BffRuntimeConfig = { adminToken, jsonBaseUrl: apiOrigin };
  const route = matchSecretsRoute('/secrets');
  if (!route) throw new Error('independent BFF fixture did not match the Secret Catalog list route');
  bffServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (url.pathname !== '/admin/api/secrets') return setJson(res, 404, { error: { code: 'NOT_FOUND', message: 'route not found' } });
      const request: AdminShellRequest = {
        method: 'GET',
        pathname: url.pathname,
        cookies: parseCookies(req),
        body: {},
      };
      await handleSecretsRoute(req, res, request, route, url.searchParams, shellConfig, runtime, randomUUID());
    } catch {
      if (!res.writableEnded) setJson(res, 500, { error: { code: 'BFF_FIXTURE_ERROR', message: 'synthetic BFF route failed' } });
    }
  });
  return listen(bffServer);
}

async function requestList(params: URLSearchParams, sessionId: string | null = platformSessionId): Promise<{ status: number; body: any }> {
  const response = await fetch(`${bffOrigin}/admin/api/secrets?${params.toString()}`, {
    headers: sessionId ? { cookie: `${SESSION_COOKIE_NAME}=${sessionId}` } : {},
  });
  return { status: response.status, body: await response.json() };
}

async function seed(input: {
  tenantId: string;
  name: string;
  purpose?: 'connector.credential' | 'storage.credential';
  services?: ('connector' | 'orchestrator')[];
}): Promise<string> {
  const value = `ORV14 verifier-only synthetic credential ${randomUUID()}`;
  const result = await createSecretInDb(db!, {
    tenantId: input.tenantId,
    name: input.name,
    purpose: input.purpose ?? 'connector.credential',
    services: input.services ?? ['connector'],
    provider: { kind: 'managed_value' },
    value: { kind: 'literal', value },
  }, undefined, catalogKeyring, backupSnapshotWriteGate);
  if (!result.valueConfigured) throw new Error('synthetic Secret Catalog seed was not persisted as encrypted managed value');
  return result.secretId;
}

beforeAll(async () => {
  baseDb = createDb(baseDatabaseUrl);
  const prior = await baseDb.query<{ exists: boolean }>(
    'SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists', [isolation.dbSchema],
  );
  if (prior.rows[0]?.exists) throw new Error('unique Secret Catalog test schema already exists');
  await baseDb.query(`CREATE SCHEMA "${isolation.dbSchema}"`);
  schemaCreated = true;
  db = createDb(databaseUrl);
  const migrationResult = await migrate(db);
  const migrationLedger = await db.query<{ count: number | string }>('SELECT count(*)::int AS count FROM schema_migrations');
  if (Number(migrationLedger.rows[0]?.count ?? -1) < 62) {
    throw new Error(`normal migration ledger is incomplete (${Number(migrationLedger.rows[0]?.count ?? -1)} rows)`);
  }
  await db.query('INSERT INTO tenants(id,name,state) VALUES ($1,$2,\'ACTIVE\'),($3,$4,\'ACTIVE\')', [
    tenantA, 'ORV14 synthetic catalog tenant A', tenantB, 'ORV14 synthetic catalog tenant B',
  ]);

  const batch: Promise<void>[] = [];
  const create = async (input: Parameters<typeof seed>[0], target: boolean) => {
    const secretId = await seed(input);
    if (target) targetIds.push(secretId);
  };
  for (let index = 0; index < 1005; index += 1) {
    batch.push(create({ tenantId: tenantA, name: `ORV14 needle connector target ${String(index).padStart(4, '0')}` }, true));
    if (batch.length >= 40) await Promise.all(batch.splice(0));
  }
  for (let index = 0; index < 28; index += 1) {
    batch.push(create({ tenantId: tenantA, name: `ORV14 needle alternate service ${index}`, services: ['orchestrator'] }, false));
  }
  for (let index = 0; index < 19; index += 1) {
    batch.push(create({ tenantId: tenantA, name: `ORV14 needle alternate purpose ${index}`, purpose: 'storage.credential' }, false));
  }
  for (let index = 0; index < 13; index += 1) {
    batch.push(create({ tenantId: tenantA, name: `ORV14 unrelated record ${index}` }, false));
  }
  for (let index = 0; index < 9; index += 1) {
    batch.push(create({ tenantId: tenantB, name: `ORV14 needle foreign tenant ${index}` }, false));
  }
  if (batch.length > 0) await Promise.all(batch);
  if (targetIds.length !== 1005) throw new Error('Secret Catalog target seed count was incomplete');
  await db.query(
    `UPDATE secret_catalog SET created_at=$1::timestamptz WHERE secret_id = ANY($2::uuid[])`,
    ['2026-10-01T12:34:56.123456Z', targetIds],
  );

  const trackedDb = {
    pool: db.pool,
    query: async <T extends import('pg').QueryResultRow = import('pg').QueryResultRow>(sql: string, values?: unknown[]) => {
      if (sql.includes('FROM secret_catalog')) listQueryCount += 1;
      return db!.query<T>(sql, values);
    },
    tx: db.tx.bind(db),
    close: db.close.bind(db),
  } as Db;
  apiOrigin = await startApi(trackedDb);
  bffOrigin = await startBff();
  console.log('ORV14 secret-catalog fixture namespace', JSON.stringify({
    runId,
    postgresSchema: isolation.dbSchema,
    migrationsApplied: migrationResult.applied.length,
    migrationsRecorded: Number(migrationLedger.rows[0]?.count ?? -1),
    tenantA,
    tenantB,
    apiOrigin,
    bffOrigin,
    encryptedCatalogRows: 1074,
    timestampTieRows: targetIds.length,
  }));
});

afterAll(async () => {
  await close(bffServer).catch(() => cleanupErrors.push('BFF listener close failed'));
  await close(apiServer).catch(() => cleanupErrors.push('API listener close failed'));
  try { await db?.close(); } catch { cleanupErrors.push('scoped PostgreSQL pool close failed'); }
  if (baseDb && schemaCreated) {
    try {
      await baseDb.query(`DROP SCHEMA "${isolation.dbSchema}" CASCADE`);
      const remaining = await baseDb.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists', [isolation.dbSchema],
      );
      if (remaining.rows[0]?.exists) cleanupErrors.push('owned PostgreSQL schema still exists');
    } catch { cleanupErrors.push('owned PostgreSQL schema cleanup failed'); }
  }
  try { await baseDb?.close(); } catch { cleanupErrors.push('base PostgreSQL pool close failed'); }
  isolation.cleanupArtifactDir();
  if (cleanupErrors.length > 0) throw new Error(`Secret Catalog paging fixture cleanup incomplete: ${cleanupErrors.join('; ')}`);
});

describe('ORV14 independent actual PostgreSQL Secret Catalog search and keyset pages', () => {
  test('serves 1,005 masked rows across stable timestamp-tie pages and binds cursors to tenant and every filter', async () => {
    const anon = await requestList(new URLSearchParams('limit=200'), null);
    expect(anon.status).toBe(401);
    expect(upstreamCalls).toBe(0);

    const operatorForeignScope = await requestList(new URLSearchParams(`tenantId=${tenantB}&limit=200`), operatorSessionId);
    expect(operatorForeignScope.status).toBe(403);
    expect(upstreamCalls).toBe(0);

    const base = new URLSearchParams({
      tenantId: tenantA,
      limit: '200',
      state: 'ACTIVE',
      purpose: 'connector.credential',
      service: 'connector',
      q: 'needle connector',
      sort: 'created_at:asc',
    });
    const first = await requestList(base);
    expect(first.status).toBe(200);
    expect(first.body.items).toHaveLength(200);
    expect(first.body.nextCursor).toEqual(expect.any(String));
    expect(first.body.items[0]).toMatchObject({ tenantId: tenantA, purpose: 'connector.credential', services: ['connector'], state: 'ACTIVE', valueConfigured: true });
    expect(first.body.items[0]).not.toHaveProperty('encrypted_value');
    expect(first.body.items[0]).not.toHaveProperty('value');
    expect(JSON.stringify(first.body)).not.toContain('ORV14 verifier-only synthetic credential');
    expect(JSON.stringify(first.body)).not.toContain('encrypted_value');

    const listCount = () => listQueryCount;
    const beforeInvalidCursor = listCount();
    const invalidCases: Array<[string, string]> = [
      ['tenantId', tenantB],
      ['purpose', 'storage.credential'],
      ['service', 'orchestrator'],
      ['q', 'not-the-same-query'],
      ['state', 'DISABLED'],
      ['limit', '199'],
    ];
    for (const [key, value] of invalidCases) {
      const changed = new URLSearchParams(base);
      changed.set('cursor', first.body.nextCursor);
      changed.set(key, value);
      const response = await requestList(changed);
      expect(response.status).toBe(400);
    }
    const tamperedCursor = new URLSearchParams(base);
    tamperedCursor.set('cursor', `${first.body.nextCursor}x`);
    expect((await requestList(tamperedCursor)).status).toBe(400);
    expect(listCount()).toBe(beforeInvalidCursor);

    const repeatedFirst = await requestList(base);
    expect(repeatedFirst.status).toBe(200);
    expect(repeatedFirst.body.items.map((item: { secretId: string }) => item.secretId))
      .toEqual(first.body.items.map((item: { secretId: string }) => item.secretId));
    expect(repeatedFirst.body.nextCursor).toBe(first.body.nextCursor);

    const expectedIds = [...targetIds].sort((left, right) => left < right ? 1 : left > right ? -1 : 0);
    const observedIds: string[] = [];
    let current = new URLSearchParams(base);
    let pageNumber = 0;
    while (true) {
      const page = pageNumber === 0 ? first : await requestList(current);
      expect(page.status).toBe(200);
      observedIds.push(...page.body.items.map((item: { secretId: string }) => item.secretId));
      expect(page.body.items.every((item: { tenantId: string; services: string[] }) => item.tenantId === tenantA && item.services.includes('connector'))).toBe(true);
      if (!page.body.nextCursor) break;
      current = new URLSearchParams(base);
      current.set('cursor', page.body.nextCursor);
      if (pageNumber === 0) current.set('q', '  NEEDLE CONNECTOR  '); // same normalized filter, same signed cursor scope
      pageNumber += 1;
      expect(pageNumber).toBeLessThanOrEqual(6);
    }
    expect(pageNumber).toBe(5);
    expect(observedIds).toHaveLength(1005);
    expect(new Set(observedIds).size).toBe(1005);
    expect(observedIds).toEqual(expectedIds);
    expect(upstreamCalls).toBeGreaterThan(6);
  });
});
