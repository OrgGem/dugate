import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import type { PoolClient } from 'pg';
import { createApp, type App } from '../../orchestrator/services/orchestrator/src/server';
import type { Db } from '../../orchestrator/services/orchestrator/src/db/db';
import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { hashLocalPassword } from '../../orchestrator/services/orchestrator/src/modules/auth/local-primitives';
import { createAuditService } from '../../orchestrator/services/orchestrator/src/modules/audit/audit';
import { createIncidentService } from '../../orchestrator/services/orchestrator/src/modules/incidents/service';
import { signCookie } from '../../orchestrator/services/orchestrator/src/app/admin/shell-auth';
import { deriveCsrfToken } from '../../orchestrator/services/orchestrator/src/modules/admin-actions/rbac';
import { assertSafeIsolationConfig, createTestIsolationContext } from '../isolation/namespace';
import { syntheticMetadataKeyProvider } from './isolation';

const runId = `orv14_vfy_ops_${Date.now()}_${randomUUID().slice(0, 8)}`;
const baseDatabaseUrl = process.env.WFA_DATABASE_URL ?? 'postgresql://orv14_vfy:orv14-vfy-local-only@127.0.0.1:25414/orv14_vfy';
const baseRedisUrl = process.env.WFA_REDIS_URL ?? 'redis://127.0.0.1:26414/0';
const isolation = createTestIsolationContext({ runId, baseArtifactPath: 'tests/workflow-api/orv14-vfy/ops-artifacts' });
const databaseUrl = isolation.getDatabaseUrlWithSchema(baseDatabaseUrl);
const redisUrl = isolation.getRedisUrl(baseRedisUrl);
assertSafeIsolationConfig({ databaseUrl, redisUrl, isolationCtx: isolation });

const baseDb = createDb(baseDatabaseUrl);
const tenantId = randomUUID();
const otherTenantId = randomUUID();
const exactKeyId = randomUUID();
const siblingKeyId = randomUUID();
const globalKeyId = randomUUID();
const otherTenantKeyId = randomUUID();
const assignedProfileId = randomUUID();
const unassignedProfileId = randomUUID();
const localUserId = randomUUID();
const profileOnlyUserId = randomUUID();
const incidentOwnerId = randomUUID();
const exactKeyHash = createHash('sha256').update(`orv14-vfy-ops-key-${randomUUID()}`).digest('hex');
const siblingKeyHash = createHash('sha256').update(`orv14-vfy-ops-sibling-${randomUUID()}`).digest('hex');
const globalKeyHash = createHash('sha256').update(`orv14-vfy-ops-global-${randomUUID()}`).digest('hex');
const otherKeyHash = createHash('sha256').update(`orv14-vfy-ops-foreign-${randomUUID()}`).digest('hex');
const adminToken = `orv14-vfy-ops-platform-${randomUUID()}`;
const tenantToken = `orv14-vfy-ops-tenant-${randomUUID()}`;
const otherTenantToken = `orv14-vfy-ops-other-tenant-${randomUUID()}`;
const adminCookieSecret = `orv14-vfy-ops-cookie-${randomUUID()}-synthetic-only`;
const invocationGrantSecret = `orv14-vfy-ops-grant-${randomUUID()}`;
const username = `ops-${randomUUID().slice(0, 12)}`;
const profileOnlyUsername = `profile-${randomUUID().slice(0, 12)}`;
const incidentOwnerUsername = `owner-${randomUUID().slice(0, 12)}`;
const password = `synthetic-${randomUUID()}-password`;
const profileOnlyPassword = `synthetic-${randomUUID()}-password`;
const incidentOwnerPassword = `synthetic-${randomUUID()}-password`;
const previousAdminWeb = process.env.DU_ADMIN_WEB;
const previousAdminWebDist = process.env.DU_ADMIN_WEB_DIST;
let app: App | undefined;
let shellUrl = '';
let internalUrl = '';
let schemaCreated = false;
let localCookie = '';
let profileOnlyCookie = '';
let incidentOwnerCookie = '';
let platformCookie = '';
let platformCsrf = '';

async function availablePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  const address = server.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function localLogin(name: string, secret: string): Promise<string> {
  if (!app?.adminShell) throw new Error('isolated Admin shell did not start');
  const form = await fetch(`${shellUrl}/admin/login`, { redirect: 'manual' });
  const html = await form.text();
  const csrf = /<input[^>]*name="csrf"[^>]*value="([^"]+)"/.exec(html)?.[1];
  const localProof = /(?:^|[,;]\s*)du_local_login=([^;,\s]+)/.exec(form.headers.get('set-cookie') ?? '')?.[1];
  if (!csrf || !localProof) throw new Error('local login fixture did not return its CSRF proof');
  const response = await fetch(`${shellUrl}/admin/login`, {
    method: 'POST',
    redirect: 'manual',
    headers: { cookie: `du_local_login=${localProof}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username: name, password: secret, csrf, redirect: '/admin' }),
  });
  const sessionId = /(?:^|[,;]\s*)du_session=([^;,\s]+)/.exec(response.headers.get('set-cookie') ?? '')?.[1];
  if (response.status !== 302 || !sessionId) throw new Error(`local login returned ${response.status} without an opaque session`);
  return `du_session=${sessionId}`;
}

function makeAdminCookie(): string {
  const signed = signCookie(adminCookieSecret, {
    iss: 'du-admin-shell', role: 'admin', iat: Date.now(), exp: Date.now() + 5 * 60_000,
  });
  if (!signed) throw new Error('could not mint synthetic platform Admin cookie');
  platformCsrf = deriveCsrfToken(adminCookieSecret, signed);
  return `du_admin=${signed}`;
}

function bff(path: string, cookie: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${shellUrl}/admin/api${path}`, {
    ...init,
    headers: { ...(init.headers as Record<string, string> | undefined), cookie },
  });
}

function instrumentIncidentDb(
  base: Db,
  options: {
    afterQuery?: (sql: string, params?: unknown[], rowCount?: number) => Promise<void>;
    applicationName?: string;
  },
): Db {
  return {
    pool: base.pool,
    query: (sql, params) => base.query(sql, params),
    async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return base.tx(async (client) => {
        if (options.applicationName) {
          await client.query("SELECT set_config('application_name',$1,true)", [options.applicationName]);
        }
        const wrapped = new Proxy(client, {
          get(target, property) {
            if (property === 'query') {
              return async (sql: string, params?: unknown[]) => {
                const result = await target.query(sql, params as never[]);
                if (options.afterQuery && typeof sql === 'string') {
                  await options.afterQuery(sql, params, result.rowCount ?? 0);
                }
                return result;
              };
            }
            const value = Reflect.get(target, property, target) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as PoolClient;
        return fn(wrapped);
      });
    },
    close: async () => undefined,
  } as unknown as Db;
}

function tenantInternal(path: string, bearer = tenantToken): Promise<Response> {
  return fetch(`${internalUrl}/api/internal${path}`, { headers: { authorization: `Bearer ${bearer}` } });
}

async function seedUser(id: string, name: string, secret: string): Promise<void> {
  if (!app) throw new Error('Ops fixture app is not initialized');
  const passwordHash = await hashLocalPassword(secret);
  await app.db.query(
    `INSERT INTO admin_local_users(id,tenant_id,username_normalized,password_hash,role,is_enabled,is_locked,version,legacy_password_reset_required)
     VALUES($1,$2,$3,$4,'operator',true,false,1,false)`,
    [id, tenantId, name, passwordHash],
  );
}

async function listOperations(cookie: string, params: Record<string, string> = {}): Promise<{ response: Response; body: Record<string, any> }> {
  const query = new URLSearchParams({ tenant: tenantId, ...params });
  const response = await bff(`/operations?${query.toString()}`, cookie);
  return { response, body: await response.json() as Record<string, any> };
}

async function operationIdFor(correlationId: string): Promise<string> {
  if (!app) throw new Error('Ops fixture app is not initialized');
  const result = await app.db.query<{ id: string }>('SELECT id FROM operations WHERE correlation_id=$1', [correlationId]);
  if (!result.rows[0]) throw new Error(`missing synthetic operation ${correlationId}`);
  return result.rows[0].id;
}

async function incidentAction(id: string, action: 'assign' | 'acknowledge' | 'resolve', body: Record<string, unknown>, csrf = platformCsrf): Promise<Response> {
  return bff(`/incidents/${encodeURIComponent(id)}/${action}`, platformCookie, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...(csrf ? { 'x-csrf-token': csrf } : {}) },
    body: JSON.stringify(body),
  });
}

beforeAll(async () => {
  process.stdout.write(`ORV14_VFY_NAMESPACE suite=ops runId=${runId} postgresSchema=${isolation.dbSchema} redisDb=${isolation.redisDbIndex} redisPrefix=${isolation.redisPrefix} queuePrefix=${isolation.queuePrefix} artifactDir=${isolation.artifactDir}\n`);
  process.env.DU_ADMIN_WEB = '1';
  process.env.DU_ADMIN_WEB_DIST = 'tests/workflow-api/orv14-vfy/no-bundle';
  await baseDb.query(`CREATE SCHEMA "${isolation.dbSchema}"`);
  schemaCreated = true;
  const port = await availablePort();
  const internalPort = await availablePort();
  const tenantCredential = tenantToken;
  app = await createApp({
    host: '127.0.0.1', port,
    internalHost: '127.0.0.1', internalPort,
    databaseUrl, redisUrl, autoMigrate: true, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken, tenantAdminTokens: { [tenantCredential]: tenantId, [otherTenantToken]: otherTenantId },
    adminLocalAuthEnabled: true, adminShellCookieSecret: adminCookieSecret,
    adminShellHost: '127.0.0.1', adminShellPort: 0,
    jsonBaseUrl: `http://127.0.0.1:${internalPort}`,
    invocationGrantSecret,
    metadataEncryption: { keyProvider: syntheticMetadataKeyProvider(), keyRef: runId },
  });
  await app.listen();
  const internalAddress = app.internalServer.address();
  if (!internalAddress || typeof internalAddress === 'string') throw new Error('internal Admin API did not bind');
  internalUrl = `http://127.0.0.1:${internalAddress.port}`;
  shellUrl = app.adminShell!.url;
  await app.db.query('INSERT INTO tenants(id,name,state) VALUES($1,$2,\'ACTIVE\'),($3,$4,\'ACTIVE\')', [
    tenantId, 'ORV14 synthetic Ops tenant', otherTenantId, 'ORV14 synthetic other tenant',
  ]);
  await app.db.query(
    `INSERT INTO api_keys(id,tenant_id,hash,prefix,status,name) VALUES
      ($1,$5,$6,'ops-exact','ACTIVE','ORV14 assigned key'),
      ($2,$5,$7,'ops-sibling','ACTIVE','ORV14 sibling key'),
      ($3,$5,$8,'ops-global','ACTIVE','Global'),
      ($4,$9,$10,'ops-foreign','ACTIVE','ORV14 other tenant key')`,
    [exactKeyId, siblingKeyId, globalKeyId, otherTenantKeyId, tenantId, exactKeyHash, siblingKeyHash, globalKeyHash, otherTenantId, otherKeyHash],
  );
  await app.db.query(
    `INSERT INTO profile_names(profile_id,tenant_id,api_key_id,business_id,business_version,action,profile_name) VALUES
      ($1,$3,$4,'document-core','1.0.0','extract','ORV14 assigned review'),
      ($2,$3,$4,'document-core','1.0.0','extract','ORV14 unassigned review')`,
    [assignedProfileId, unassignedProfileId, tenantId, exactKeyId],
  );
  await seedUser(localUserId, username, password);
  await seedUser(profileOnlyUserId, profileOnlyUsername, profileOnlyPassword);
  await seedUser(incidentOwnerId, incidentOwnerUsername, incidentOwnerPassword);
  await app.db.query(
    `INSERT INTO admin_local_user_profile_grants(tenant_id,user_id,profile_id) VALUES($1,$2,$3),($1,$4,$3)`,
    [tenantId, localUserId, assignedProfileId, profileOnlyUserId],
  );
  await app.db.query(
    `INSERT INTO admin_local_user_api_key_grants(tenant_id,user_id,api_key_id) VALUES($1,$2,$3),($1,$2,$4)`,
    [tenantId, localUserId, exactKeyId, globalKeyId],
  );

  await app.db.query(
    `WITH rows AS (SELECT n FROM generate_series(1,1200) AS n)
     INSERT INTO operations(id,tenant_id,api_key_id,profile_id,profile_revision,business_id,business_version,action,state,state_version,correlation_id,created_at,updated_at)
     SELECT gen_random_uuid(),
       CASE WHEN n > 1100 THEN $2::uuid ELSE $1::uuid END,
       CASE WHEN n BETWEEN 801 AND 900 THEN $4::uuid WHEN n BETWEEN 1001 AND 1100 THEN $5::uuid WHEN n > 1100 THEN $6::uuid ELSE $3::uuid END,
       CASE WHEN n BETWEEN 401 AND 900 THEN $7::uuid WHEN n BETWEEN 901 AND 1000 THEN $8::uuid ELSE NULL END,
       CASE WHEN n BETWEEN 401 AND 1000 THEN 1 ELSE NULL END,
       'document-core','1.0.0',
       CASE WHEN n % 3 = 0 THEN 'extract' WHEN n % 3 = 1 THEN 'analyze' ELSE 'transform' END,
       'SUCCEEDED',1,
       CASE WHEN n=350 THEN 'orv14-vfy-search-deep-visible' ELSE 'orv14-vfy-row-'||n::text END,
       now()-interval '1 hour'+n*interval '1 second',
       now()-interval '1 hour'+n*interval '1 second'
     FROM rows`,
    [tenantId, otherTenantId, exactKeyId, siblingKeyId, globalKeyId, otherTenantKeyId, assignedProfileId, unassignedProfileId],
  );
  localCookie = await localLogin(username, password);
  profileOnlyCookie = await localLogin(profileOnlyUsername, profileOnlyPassword);
  incidentOwnerCookie = await localLogin(incidentOwnerUsername, incidentOwnerPassword);
  platformCookie = makeAdminCookie();
}, 120_000);

afterAll(async () => {
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
  if (schemaCreated) await baseDb.query(`DROP SCHEMA "${isolation.dbSchema}" CASCADE`);
  await baseDb.close();
  isolation.cleanupArtifactDir();
  if (previousAdminWeb === undefined) delete process.env.DU_ADMIN_WEB; else process.env.DU_ADMIN_WEB = previousAdminWeb;
  if (previousAdminWebDist === undefined) delete process.env.DU_ADMIN_WEB_DIST; else process.env.DU_ADMIN_WEB_DIST = previousAdminWebDist;
});

describe('ORV14 independent real PostgreSQL Operations and Incident Admin journeys', () => {
  test('searches, sorts, keyset-pages, deep-links, and aggregates 1,200 operations using live exact grants', async () => {
    const firstPage = await listOperations(localCookie, { limit: '40', sort: 'created_at:desc' });
    expect(firstPage.response.status).toBe(200);
    expect(firstPage.body.total).toBe(800);
    expect(firstPage.body.items).toHaveLength(40);
    expect(firstPage.body.nextCursor).toEqual(expect.any(String));
    expect(firstPage.body.items.some((item: { correlationId?: string }) => item.correlationId === 'orv14-vfy-search-deep-visible')).toBe(false);

    const next = await listOperations(localCookie, { limit: '40', sort: 'created_at:desc', cursor: firstPage.body.nextCursor });
    expect(next.response.status).toBe(200);
    expect(next.body.total).toBe(800);
    expect(next.body.items).toHaveLength(40);
    expect(next.body.prevCursor).toEqual(expect.any(String));
    const firstIds = firstPage.body.items.map((item: { id: string }) => item.id);
    const nextIds = next.body.items.map((item: { id: string }) => item.id);
    expect(nextIds.some((id: string) => firstIds.includes(id))).toBe(false);
    const previous = await listOperations(localCookie, { limit: '40', sort: 'created_at:desc', cursor: next.body.prevCursor });
    expect(previous.response.status).toBe(200);
    expect(previous.body.items.map((item: { id: string }) => item.id)).toEqual(firstIds);

    const changedFilterWithCursor = await listOperations(localCookie, {
      limit: '40', sort: 'created_at:desc', cursor: firstPage.body.nextCursor, action: 'extract',
    });
    expect(changedFilterWithCursor.response.status).toBe(422);
    expect(changedFilterWithCursor.body.code).toBe('INVALID_SCHEMA');

    const deepSearch = await listOperations(localCookie, { limit: '1', correlation: 'orv14-vfy-search-deep-visible' });
    expect(deepSearch.response.status).toBe(200);
    expect(deepSearch.body.total).toBe(1);
    expect(deepSearch.body.items).toHaveLength(1);
    expect(deepSearch.body.items[0].id).toBe(await operationIdFor('orv14-vfy-search-deep-visible'));
    expect(deepSearch.body.items[0].correlationId).toBe('orv14-vfy-search-deep-visible');
    const correlationDetail = await bff(`/operations/${deepSearch.body.items[0].id}`, localCookie);
    expect(correlationDetail.status).toBe(200);
    expect((await correlationDetail.json() as { operation: { correlationId: string } }).operation.correlationId)
      .toBe('orv14-vfy-search-deep-visible');
    const expectedVisibleNull = await operationIdFor('orv14-vfy-row-5');

    const keySearch = await listOperations(localCookie, { limit: '100', apiKey: 'ORV14 assigned key' });
    expect(keySearch.response.status).toBe(200);
    expect(keySearch.body.total).toBe(800);
    const profileSearch = await listOperations(localCookie, { limit: '100', profile: 'assigned review' });
    expect(profileSearch.response.status).toBe(200);
    expect(profileSearch.body.total).toBe(400);

    const visibleProfileId = await operationIdFor('orv14-vfy-row-600');
    const siblingKeyId = await operationIdFor('orv14-vfy-row-850');
    const unassignedProfileId = await operationIdFor('orv14-vfy-row-950');
    const globalKeyOperationId = await operationIdFor('orv14-vfy-row-1050');
    const foreignOperationId = await operationIdFor('orv14-vfy-row-1150');
    for (const [id, status] of [[expectedVisibleNull, 200], [visibleProfileId, 200], [siblingKeyId, 404], [unassignedProfileId, 404], [globalKeyOperationId, 404], [foreignOperationId, 404]] as const) {
      const detail = await bff(`/operations/${id}`, localCookie);
      expect(detail.status).toBe(status);
    }

    const from = new Date(Date.now() - 2 * 60 * 60_000).toISOString();
    const to = new Date(Date.now() + 60_000).toISOString();
    const metricsResponse = await bff(`/operations/metrics?${new URLSearchParams({ tenant: tenantId, from, to })}`, localCookie);
    const metrics = await metricsResponse.json() as Record<string, unknown>;
    expect(metricsResponse.status).toBe(200);
    expect(metrics).toMatchObject({ total: 800, success: 800, failure: 0, running: 0 });

    const profileOnlyPage = await listOperations(profileOnlyCookie, { limit: '50' });
    expect(profileOnlyPage.response.status).toBe(200);
    expect(profileOnlyPage.body.total).toBe(0);
    expect(profileOnlyPage.body.items).toEqual([]);
    const profileOnlyMetricsResponse = await bff(`/operations/metrics?${new URLSearchParams({ tenant: tenantId, from, to })}`, profileOnlyCookie);
    const profileOnlyMetrics = await profileOnlyMetricsResponse.json() as Record<string, unknown>;
    expect(profileOnlyMetricsResponse.status).toBe(200);
    expect(profileOnlyMetrics.total).toBe(0);

    const foreignTenant = await listOperations(localCookie, { tenant: otherTenantId, limit: '5' });
    expect(foreignTenant.response.status).toBe(403);
    const badOpaque = 'R'.repeat(43);
    const rejectedWithLegacyAdmin = await bff(
      `/operations?tenant=${tenantId}&limit=5`,
      `${`du_session=${badOpaque}`}; ${platformCookie}`,
    );
    expect(rejectedWithLegacyAdmin.status).toBe(401);
    const bearerWithBadOpaque = await fetch(`${internalUrl}/api/internal/operations?tenant=${tenantId}&limit=5`, {
      headers: { authorization: `Bearer ${tenantToken}`, cookie: `du_session=${badOpaque}` },
    });
    expect(bearerWithBadOpaque.status).toBe(401);

    await app!.db.query('UPDATE admin_local_users SET version=version+1 WHERE id=$1', [localUserId]);
    const revokedOldVersion = await listOperations(localCookie, { limit: '5' });
    expect(revokedOldVersion.response.status).toBe(401);
  }, 120_000);

  test('deduplicates actual source signals, preserves lifecycle history, enforces CSRF and current recovery evidence', async () => {
    const incidentService = createIncidentService(app!.db, createAuditService(app!.db));
    const sourceRef = `orv14-vfy-queue-${randomUUID().slice(0, 10)}`;
    const makeSignal = (state: 'active' | 'recovered', sampledAt: Date, evidenceRef?: string) => ({
      source: 'queue' as const,
      sourceRef,
      signalCode: 'queue-stalled',
      scope: { kind: 'tenant' as const, tenantId },
      severity: 'high' as const,
      state,
      summary: state === 'active' ? 'Synthetic isolated queue stall' : 'Synthetic isolated queue recovered',
      sampledAt: sampledAt.toISOString(),
      thresholdRevision: 'orv14-vfy-threshold-1',
      affectedResources: [{ kind: 'queue' as const, ref: sourceRef, label: 'Synthetic verifier queue' }],
      counters: { stalled: state === 'active' ? 3 : 0 },
      ...(evidenceRef ? { evidenceRef } : {}),
    });
    const t0 = new Date(Date.now() - 5 * 60_000);
    const first = await incidentService.upsertIncidentSignal(makeSignal('active', t0));
    const secondAt = new Date(t0.getTime() + 2 * 60_000);
    const repeated = await incidentService.upsertIncidentSignal(makeSignal('active', secondAt));
    const duplicateSample = await incidentService.upsertIncidentSignal(makeSignal('active', secondAt));
    expect(first?.occurrenceCount).toBe(1);
    expect(repeated?.occurrenceCount).toBe(2);
    expect(duplicateSample?.occurrenceCount).toBe(2);
    const incidentId = String(first?.id);

    const localUserRead = await bff(`/incidents?${new URLSearchParams({ tenantId, search: sourceRef })}`, incidentOwnerCookie);
    expect(localUserRead.status).toBe(403);
    const ownerlessRead = await tenantInternal(`/incidents?${new URLSearchParams({ tenantId: otherTenantId })}`, otherTenantToken);
    expect(ownerlessRead.status).toBe(200);
    const foreignTenantRead = await tenantInternal(`/incidents?${new URLSearchParams({ tenantId })}`, otherTenantToken);
    expect(foreignTenantRead.status).toBe(403);
    const foreignTenantDetail = await tenantInternal(`/incidents/${incidentId}`, otherTenantToken);
    expect(foreignTenantDetail.status).toBe(404);

    const beforeAck = await bff(`/incidents/${incidentId}`, platformCookie);
    expect(beforeAck.status).toBe(200);
    const beforeDetail = await beforeAck.json() as { incident: { stateVersion: number; sourceState: string; occurrenceCount: number }; history: Array<{ kind: string }> };
    expect(beforeDetail.incident).toMatchObject({ sourceState: 'active', occurrenceCount: 2 });
    expect(beforeDetail.history.map((event) => event.kind)).toEqual(expect.arrayContaining(['detected', 'signal_repeated']));

    const rejectedAck = await incidentAction(incidentId, 'acknowledge', { expectedVersion: beforeDetail.incident.stateVersion, reason: 'synthetic acknowledgement' }, '');
    expect(rejectedAck.status).toBe(403);
    const ackResponse = await incidentAction(incidentId, 'acknowledge', { expectedVersion: beforeDetail.incident.stateVersion, reason: 'synthetic acknowledgement' });
    expect(ackResponse.status).toBe(200);
    const ackBody = await ackResponse.json() as { incident: { stateVersion: number; sourceState: string; status: string } };
    expect(ackBody.incident).toMatchObject({ sourceState: 'active', status: 'acknowledged' });

    const assignResponse = await incidentAction(incidentId, 'assign', {
      expectedVersion: ackBody.incident.stateVersion, ownerId: incidentOwnerId, reason: 'synthetic owner assignment',
    });
    expect(assignResponse.status).toBe(200);
    const assignedBody = await assignResponse.json() as { incident: { ownerId: string; stateVersion: number; sourceState: string } };
    expect(assignedBody.incident).toMatchObject({ ownerId: incidentOwnerId, sourceState: 'active' });

    const unresolvedResolve = await incidentAction(incidentId, 'resolve', {
      expectedVersion: assignedBody.incident.stateVersion,
      reason: 'try resolving before source recovery',
      evidenceEventId: randomUUID(),
    });
    expect(unresolvedResolve.status).toBe(409);

    const recovered = await incidentService.upsertIncidentSignal(
      makeSignal('recovered', new Date(), `orv14-vfy-recovery-${randomUUID().slice(0, 8)}`),
    );
    expect(recovered?.sourceState).toBe('recovered');
    const recoveryDetailResponse = await bff(`/incidents/${incidentId}`, platformCookie);
    expect(recoveryDetailResponse.status).toBe(200);
    const recoveryDetail = await recoveryDetailResponse.json() as { incident: { stateVersion: number; sourceState: string }; history: Array<{ id: string; kind: string; sourceState: string | null }> };
    const recoveryEvent = recoveryDetail.history.find((event) => event.kind === 'source_recovered');
    expect(recoveryEvent).toBeDefined();
    const resolved = await incidentAction(incidentId, 'resolve', {
      expectedVersion: recoveryDetail.incident.stateVersion,
      reason: 'source recovered with matching evidence',
      evidenceEventId: recoveryEvent!.id,
    });
    expect(resolved.status).toBe(200);
    const resolvedBody = await resolved.json() as { incident: { status: string; sourceState: string; resolutionEvidenceRef: string }; history: Array<{ id: string; kind: string }> };
    expect(resolvedBody.incident).toMatchObject({ status: 'resolved', sourceState: 'recovered', resolutionEvidenceRef: recoveryEvent!.id });
    expect(resolvedBody.history.map((event) => event.kind)).toEqual(expect.arrayContaining(['detected', 'signal_repeated', 'acknowledged', 'assigned', 'source_recovered', 'resolved']));
    const staleActive = await incidentService.upsertIncidentSignal(makeSignal('active', new Date(Date.now() - 60_000)));
    expect(staleActive).toMatchObject({ id: incidentId, status: 'resolved', sourceState: 'recovered' });
    const afterStaleActive = await bff(`/incidents/${incidentId}`, platformCookie);
    expect(afterStaleActive.status).toBe(200);
    const afterStaleDetail = await afterStaleActive.json() as { incident: { status: string; sourceState: string }; history: Array<{ id: string; kind: string }> };
    expect(afterStaleDetail.incident).toMatchObject({ status: 'resolved', sourceState: 'recovered' });
    expect(afterStaleDetail.history.map((event) => event.id)).toEqual(resolvedBody.history.map((event) => event.id));

    const suppressionStart = new Date(Date.now() - 1_000).toISOString();
    const suppressionExpiry = new Date(Date.now() + 60 * 60_000).toISOString();
    const createSuppression = await bff('/incidents/maintenance-suppressions', platformCookie, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-csrf-token': platformCsrf },
      body: JSON.stringify({ scope: { kind: 'queue', ref: sourceRef }, startsAt: suppressionStart, expiresAt: suppressionExpiry, reason: 'synthetic maintenance window' }),
    });
    expect(createSuppression.status).toBe(201);
    const suppression = await createSuppression.json() as { id: string; active: boolean };
    expect(suppression.active).toBe(true);
    const afterCreateIncident = await bff(`/incidents/${incidentId}`, platformCookie);
    expect((await afterCreateIncident.json() as { incident: { suppressed: boolean } }).incident.suppressed).toBe(true);
    await app!.db.query('UPDATE admin_maintenance_suppressions SET expires_at=now()-interval \'1 second\' WHERE suppression_id=$1', [suppression.id]);
    const expiredListResponse = await bff('/incidents/maintenance-suppressions', platformCookie);
    expect(expiredListResponse.status).toBe(200);
    const expiredList = await expiredListResponse.json() as { items: Array<{ id: string; active: boolean }> };
    expect(expiredList.items.find((item) => item.id === suppression.id)?.active).toBe(false);
    const afterExpiryIncident = await bff(`/incidents/${incidentId}`, platformCookie);
    expect((await afterExpiryIncident.json() as { incident: { suppressed: boolean } }).incident.suppressed).toBe(false);

    const audit = await app!.db.query<{ action: string; tenant_id: string | null }>(
      `SELECT action,tenant_id FROM admin_audit_events WHERE action IN ('incident.acknowledged','incident.assigned','incident.resolved','maintenance.suppression.created') AND resource LIKE $1 ORDER BY action`,
      [`%${incidentId}%`],
    );
    expect(audit.rows.filter((row) => ['incident.acknowledged', 'incident.assigned', 'incident.resolved'].includes(row.action))).toHaveLength(3);
    expect(audit.rows.filter((row) => ['incident.acknowledged', 'incident.assigned', 'incident.resolved'].includes(row.action)).every((row) => row.tenant_id === tenantId)).toBe(true);
  }, 120_000);

  test('preserves the newest payload when first-time same-source signals interleave around an empty prior read', async () => {
    const sourceRef = `orv14-vfy-race-${randomUUID().slice(0, 10)}`;
    const dedupeKeyQuery = 'SELECT i.incident_id';
    let signalPriorRead!: () => void;
    let releasePriorRead!: () => void;
    let paused = false;
    const priorReadReached = new Promise<void>((resolve) => { signalPriorRead = resolve; });
    const continueOlder = new Promise<void>((resolve) => { releasePriorRead = resolve; });
    const olderTimestamp = new Date(Date.now() - 4 * 60_000);
    const newerTimestamp = new Date(olderTimestamp.getTime() + 90_000);
    const baseSignal = {
      source: 'queue' as const,
      sourceRef,
      signalCode: 'queue-stalled',
      scope: { kind: 'tenant' as const, tenantId },
      state: 'active' as const,
    };
    const olderSignal = {
      ...baseSignal, severity: 'low' as const, summary: 'Older interleaved source payload',
      sampledAt: olderTimestamp.toISOString(), thresholdRevision: 'orv14-vfy-old-threshold',
      affectedResources: [{ kind: 'queue' as const, ref: sourceRef, label: 'Older queue payload' }], counters: { stalled: 1 },
    };
    const newerSignal = {
      ...baseSignal, severity: 'critical' as const, summary: 'Newer committed source payload',
      sampledAt: newerTimestamp.toISOString(), thresholdRevision: 'orv14-vfy-new-threshold',
      affectedResources: [{ kind: 'queue' as const, ref: sourceRef, label: 'Newer queue payload' }], counters: { stalled: 9 },
    };
    const olderService = createIncidentService(
      instrumentIncidentDb(app!.db, {
        afterQuery: async (sql, _params, rowCount) => {
          if (!paused && sql.includes(dedupeKeyQuery) && sql.includes('FOR UPDATE') && rowCount === 0) {
            paused = true;
            signalPriorRead();
            await continueOlder;
          }
        },
      }),
      createAuditService(app!.db),
    );
    const newerApplicationName = `orv14vfyincidentrace${randomUUID().slice(0, 8)}`;
    const newerService = createIncidentService(
      instrumentIncidentDb(app!.db, { applicationName: newerApplicationName }),
      createAuditService(app!.db),
    );

    const olderOutcomePromise = olderService.upsertIncidentSignal(olderSignal).then(
      (result) => ({ result, error: undefined as unknown }),
      (error: unknown) => ({ result: null, error }),
    );
    let priorReadTimeout: NodeJS.Timeout | undefined;
    await Promise.race([
      priorReadReached,
      new Promise<void>((_resolve, reject) => {
        priorReadTimeout = setTimeout(() => reject(new Error('older incident did not reach an empty real-PG prior row read')), 2_000);
      }),
    ]).finally(() => { if (priorReadTimeout) clearTimeout(priorReadTimeout); });

    let newerSettled = false;
    const newerOutcomePromise = newerService.upsertIncidentSignal(newerSignal).then(
      (result) => { newerSettled = true; return { result, error: undefined as unknown }; },
      (error: unknown) => { newerSettled = true; return { result: null, error }; },
    );
    let newerWaitedOnLock = false;
    let newerCompletedBeforeOlderRelease = false;
    const observationDeadline = Date.now() + 2_000;
    try {
      while (Date.now() < observationDeadline && !newerSettled) {
        const activity = await app!.db.query<{ wait_event_type: string | null; state: string | null }>(
          `SELECT wait_event_type,state FROM pg_stat_activity WHERE application_name=$1 AND state='active' ORDER BY query_start DESC LIMIT 1`,
          [newerApplicationName],
        );
        if (activity.rows[0]?.wait_event_type === 'Lock') {
          newerWaitedOnLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      newerCompletedBeforeOlderRelease = newerSettled;
    } finally {
      // A source implementation may serialize by the dedupe key, in which
      // case the newer transaction waits here. Otherwise the real PG insert
      // commits while the older transaction remains paused after its empty read.
      releasePriorRead();
    }
    const [olderOutcome, newerOutcome] = await Promise.all([olderOutcomePromise, newerOutcomePromise]);
    expect(olderOutcome.error).toBeUndefined();
    expect(newerOutcome.error).toBeUndefined();
    expect(newerCompletedBeforeOlderRelease).toBe(false);
    expect(newerWaitedOnLock).toBe(true);
    expect(olderOutcome.result?.id).toBe(newerOutcome.result?.id);

    const incidentId = String(newerOutcome.result?.id);
    const stored = await app!.db.query<{
      severity: string; summary: string; threshold_revision: string; counters: unknown; affected_resources: unknown;
      occurrence_count: string; last_sampled_at: Date | string;
    }>(
      'SELECT severity,summary,threshold_revision,counters,affected_resources,occurrence_count::text,last_sampled_at FROM admin_incidents WHERE incident_id=$1',
      [incidentId],
    );
    const history = await app!.db.query<{ kind: string; summary: string }>(
      'SELECT kind,summary FROM admin_incident_events WHERE incident_id=$1 ORDER BY created_at,event_id',
      [incidentId],
    );
    process.stdout.write(`ORV14_VFY_INCIDENT_RACE ${JSON.stringify({
      olderPriorSelectWasEmpty: paused,
      newerCompletedBeforeOlderRelease,
      newerWaitedOnPgLock: newerWaitedOnLock,
      olderIncidentId: olderOutcome.result?.id,
      newerIncidentId: newerOutcome.result?.id,
      expectedNewer: { severity: newerSignal.severity, summary: newerSignal.summary, thresholdRevision: newerSignal.thresholdRevision, counters: newerSignal.counters, affectedResources: newerSignal.affectedResources, sampledAt: newerSignal.sampledAt },
      persisted: stored.rows[0],
      history: history.rows,
    })}\n`);
    expect(stored.rows[0]).toMatchObject({
      severity: 'critical', summary: newerSignal.summary, threshold_revision: newerSignal.thresholdRevision,
      counters: newerSignal.counters, affected_resources: newerSignal.affectedResources,
    });
    expect(new Date(stored.rows[0]!.last_sampled_at).toISOString()).toBe(newerSignal.sampledAt);
    expect(history.rows.filter((event) => event.kind === 'detected')).toHaveLength(1);
    expect(history.rows.map((event) => event.kind)).toEqual(['detected', 'signal_repeated']);
    expect(history.rows[1]?.summary).toBe(newerSignal.summary);
  }, 120_000);
});
