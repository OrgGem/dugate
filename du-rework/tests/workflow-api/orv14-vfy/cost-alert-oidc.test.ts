import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import IORedis from 'ioredis';
import {
  budgetQuotaScopeKey,
  quotaScopeForBudget,
  resolveBudgetQuotaWindow,
  type BudgetConfig,
} from '@du/contracts';
import { createApp, type App } from '../../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../../orchestrator/services/orchestrator/src/db/db';
import { createAuditService } from '../../../orchestrator/services/orchestrator/src/modules/audit/audit';
import { createCostControlService } from '../../../orchestrator/services/orchestrator/src/modules/cost-control/service';
import { enqueueCostBudgetAlerts } from '../../../orchestrator/services/orchestrator/src/modules/cost-alerts/enqueue';
import { createCostAlertService, runCostAlertDeliveryBatch } from '../../../orchestrator/services/orchestrator/src/modules/cost-alerts/service';
import {
  buildOidcAdminComponents,
  createIoredisSessionGateway,
  type RedisSessionGateway,
} from '../../../orchestrator/services/orchestrator/src/app/admin/oidc-boot';
import { startMockOidcIdp, type MockOidcIdp } from '../../../orchestrator/services/orchestrator/tests/stubs/mock-oidc-idp';
import { createTestIsolationContext, assertSafeIsolationConfig } from '../../isolation/namespace';
import { syntheticMetadataKeyProvider } from '../isolation';

const runId = `orv14_vfy_cost_oidc_${Date.now()}_${randomUUID().slice(0, 8)}`;
const baseDatabaseUrl = process.env.WFA_DATABASE_URL ?? 'postgresql://orv14_vfy:orv14-vfy-local-only@127.0.0.1:25414/orv14_vfy';
const baseRedisUrl = process.env.WFA_REDIS_URL ?? 'redis://127.0.0.1:26414/14';
const isolation = createTestIsolationContext({ runId, baseArtifactPath: 'tests/workflow-api/orv14-vfy/cost-alert-oidc-artifacts' });
const databaseUrl = isolation.getDatabaseUrlWithSchema(baseDatabaseUrl);
const redisUrl = isolation.getRedisUrl(baseRedisUrl);
assertSafeIsolationConfig({ databaseUrl, redisUrl, isolationCtx: isolation });

const redisPrefix = `${isolation.redisPrefix}oidc:`;
const baseDb = createDb(baseDatabaseUrl);
const tenantId = randomUUID();
const adminToken = `orv14-vfy-cost-admin-${randomUUID()}`;
const cookieSecret = `orv14-vfy-cost-cookie-${randomUUID()}-synthetic-only`;
const invocationGrantSecret = `orv14-vfy-cost-grant-${randomUUID()}`;
const previousAdminWeb = process.env.DU_ADMIN_WEB;
const previousAdminWebDist = process.env.DU_ADMIN_WEB_DIST;
const previousNoProxy = process.env.NO_PROXY;
const previousNoProxyLower = process.env.no_proxy;
let appA: App | undefined;
let appB: App | undefined;
let oidcA: ReturnType<typeof buildOidcAdminComponents> | undefined;
let oidcB: ReturnType<typeof buildOidcAdminComponents> | undefined;
let idp: MockOidcIdp | undefined;
let shellUrlA = '';
let shellUrlB = '';
let internalUrlA = '';
let schemaCreated = false;

function namespacedGateway(url: string): RedisSessionGateway {
  const raw = createIoredisSessionGateway(url);
  const key = (value: string) => `${redisPrefix}${value}`;
  return {
    get: (value) => raw.get(key(value)),
    set: (value, data, ttl) => raw.set(key(value), data, ttl),
    touchSession: (session, index, expected, lastSeen, ttl) => raw.touchSession!(key(session), key(index), expected, lastSeen, ttl),
    pinCostAlertRecipient: (session, expected, principalId, version, ttl) => raw.pinCostAlertRecipient!(key(session), expected, principalId, version, ttl),
    del: (...values) => raw.del(...values.map(key)),
    sadd: (value, member) => raw.sadd(key(value), member),
    srem: (value, member) => raw.srem(key(value), member),
    smembers: (value) => raw.smembers(key(value)),
    expire: (value, ttl) => raw.expire(key(value), ttl),
    getdel: (value) => raw.getdel(key(value)),
    ready: raw.ready ? () => raw.ready!() : undefined,
    close: raw.close ? () => raw.close!() : undefined,
  };
}

async function availablePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => resolve());
  });
  const address = probe.address() as AddressInfo;
  const port = address.port;
  await new Promise<void>((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

function oidcEnv(redirectUri: string) {
  return {
    DU_ADMIN_OIDC_ISSUER: idp!.issuer,
    DU_ADMIN_OIDC_CLIENT_ID: 'orv14-vfy-admin',
    DU_ADMIN_OIDC_CLIENT_SECRET: `synthetic-${randomUUID()}`,
    DU_ADMIN_OIDC_REDIRECT_URI: redirectUri,
    DU_ADMIN_OIDC_PUBLIC_ORIGIN: new URL(redirectUri).origin,
    DU_ADMIN_OIDC_SESSION_BACKEND: 'redis',
    REDIS_URL: redisUrl,
    NO_PROXY: '127.0.0.1,localhost',
    no_proxy: '127.0.0.1,localhost',
  };
}

async function startReplica(input: {
  shellPort: number;
  internalPort: number;
  oidc: NonNullable<ReturnType<typeof buildOidcAdminComponents>>;
  autoMigrate: boolean;
}): Promise<{ app: App; shellUrl: string; internalUrl: string }> {
  const app = await createApp({
    host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort: input.internalPort,
    databaseUrl, redisUrl, autoMigrate: input.autoMigrate, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken, adminLocalAuthEnabled: false,
    adminShellCookieSecret: cookieSecret,
    adminShellHost: '127.0.0.1', adminShellPort: input.shellPort,
    jsonBaseUrl: `http://127.0.0.1:${input.internalPort}`,
    adminIdentityAuth: { mode: 'oidc', localEnabled: false, oidc: null },
    adminOidcFlow: input.oidc.adminOidcFlow,
    adminSessionStore: input.oidc.adminSessionStore,
    invocationGrantSecret,
    metadataEncryption: { keyProvider: syntheticMetadataKeyProvider(), keyRef: `${runId}:metadata` },
    publicUploadEncryption: { keyProvider: syntheticMetadataKeyProvider(), keyRef: `${runId}:public-upload` },
  });
  await app.listen();
  const address = app.internalServer.address();
  if (!address || typeof address === 'string') throw new Error('ORV14 cost OIDC internal listener did not bind');
  return { app, shellUrl: app.adminShell!.url, internalUrl: `http://127.0.0.1:${address.port}` };
}

async function loginCrossReplica(startUrl: string, callbackUrl: string, subject: string): Promise<string> {
  idp!.setPrincipal({ sub: subject, platformAdmin: true });
  const start = await fetch(`${startUrl}/admin/login`, { redirect: 'manual' });
  if (start.status !== 302) throw new Error(`OIDC start expected 302, got ${start.status}`);
  const authorizeUrl = start.headers.get('location');
  if (!authorizeUrl) throw new Error('OIDC start omitted the IdP authorization redirect');
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  if (authorize.status !== 302) throw new Error(`synthetic IdP authorization expected 302, got ${authorize.status}`);
  const callback = new URL(authorize.headers.get('location') ?? '');
  if (!callback.searchParams.get('code') || !callback.searchParams.get('state')) throw new Error('synthetic IdP omitted authorization code or state');
  const response = await fetch(`${callbackUrl}${callback.pathname}${callback.search}`, { redirect: 'manual' });
  if (response.status !== 302) {
    const text = await response.text();
    throw new Error(`cross-replica OIDC callback expected 302, got ${response.status}: ${text.slice(0, 220)}`);
  }
  const setCookie = response.headers.get('set-cookie') ?? '';
  const session = /(?:^|[,;]\s*)du_session=([A-Za-z0-9_-]{43})/.exec(setCookie)?.[1];
  if (!session) throw new Error('cross-replica OIDC callback omitted the opaque session cookie');
  return `du_session=${session}`;
}

async function sessionContext(shellUrl: string, cookie: string): Promise<{ csrfToken: string; body: Record<string, unknown> }> {
  const response = await fetch(`${shellUrl}/admin/api/session`, { headers: { cookie } });
  const body = await response.json() as Record<string, unknown>;
  expect(response.status).toBe(200);
  expect(body).toMatchObject({ plane: 'oidc', role: 'admin' });
  expect(body['csrfToken']).toEqual(expect.any(String));
  return { csrfToken: String(body['csrfToken']), body };
}

async function bffJson(shellUrl: string, path: string, cookie: string, init: RequestInit = {}) {
  const response = await fetch(`${shellUrl}/admin/api${path}`, {
    ...init,
    headers: { cookie, ...(init.headers ?? {}) },
  });
  const raw = await response.text();
  let body: unknown;
  try { body = raw.length ? JSON.parse(raw) as unknown : null; } catch { body = raw; }
  return { response, body, raw };
}

beforeAll(async () => {
  process.stdout.write(`ORV14_VFY_NAMESPACE suite=cost-alert-oidc runId=${runId} postgresSchema=${isolation.dbSchema} redisDb=${isolation.redisDbIndex} redisPrefix=${redisPrefix} queuePrefix=${isolation.queuePrefix} artifactDir=${isolation.artifactDir}\n`);
  process.env.DU_ADMIN_WEB = '1';
  process.env.DU_ADMIN_WEB_DIST = 'tests/workflow-api/orv14-vfy/no-bundle';
  process.env.NO_PROXY = '127.0.0.1,localhost';
  process.env.no_proxy = '127.0.0.1,localhost';
  await baseDb.query(`CREATE SCHEMA "${isolation.dbSchema}"`);
  schemaCreated = true;
  idp = await startMockOidcIdp();
  const portA = await availablePort();
  const portB = await availablePort();
  const internalPortA = await availablePort();
  const internalPortB = await availablePort();
  const redirectUri = `http://127.0.0.1:${portA}/admin/oidc/callback`;
  oidcA = buildOidcAdminComponents(oidcEnv(redirectUri), { createRedisGateway: namespacedGateway }) ?? undefined;
  oidcB = buildOidcAdminComponents(oidcEnv(redirectUri), { createRedisGateway: namespacedGateway }) ?? undefined;
  if (!oidcA || !oidcB || !oidcA.ready || !oidcB.ready) throw new Error('OIDC Redis session components did not configure their real ready gates');
  await Promise.all([oidcA.ready(), oidcB.ready()]);
  const replicaA = await startReplica({ shellPort: portA, internalPort: internalPortA, oidc: oidcA, autoMigrate: true });
  appA = replicaA.app;
  shellUrlA = replicaA.shellUrl;
  internalUrlA = replicaA.internalUrl;
  // Both replicas use the normal one-shot migration path. The generic
  // read-only verifier currently looks for schema_migrations in public,
  // while this fixture intentionally pins it in an isolated search_path.
  const replicaB = await startReplica({ shellPort: portB, internalPort: internalPortB, oidc: oidcB, autoMigrate: true });
  appB = replicaB.app;
  shellUrlB = replicaB.shellUrl;
  await appA.db.query("INSERT INTO tenants(id,name,state) VALUES($1,$2,'ACTIVE')", [tenantId, 'ORV14 synthetic cost alerts']);
  process.stdout.write(`ORV14_VFY_APP source=shellA url=${shellUrlA} internal=${internalUrlA} callbackReplica=shellB url=${shellUrlB} idp=${idp.url}\n`);
});

afterAll(async () => {
  const errors: unknown[] = [];
  const clean = async (label: string, run: () => Promise<void>) => {
    try { await run(); } catch (error) { errors.push(new Error(`${label}: ${String(error)}`)); }
  };
  await clean('close shell B', async () => { await appB?.close({ timeoutMs: 0, pollIntervalMs: 10 }); });
  appB = undefined;
  await clean('close shell A', async () => { await appA?.close({ timeoutMs: 0, pollIntervalMs: 10 }); });
  appA = undefined;
  await clean('close OIDC gateway B', async () => { await oidcB?.close?.(); });
  await clean('close OIDC gateway A', async () => { await oidcA?.close?.(); });
  await clean('close synthetic IdP', async () => { await idp?.close(); });
  if (schemaCreated) await clean('drop owned PostgreSQL schema', async () => { await baseDb.query(`DROP SCHEMA "${isolation.dbSchema}" CASCADE`); });
  await clean('verify PostgreSQL schema cleanup', async () => {
    const schemaCheck = await baseDb.query<{ exists: boolean }>(
      'SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists', [isolation.dbSchema],
    );
    if (schemaCheck.rows[0]?.exists) throw new Error(`owned PostgreSQL schema remains: ${isolation.dbSchema}`);
  });
  await clean('clean and verify owned OIDC Redis prefix', async () => {
    const redis = new IORedis(redisUrl, { maxRetriesPerRequest: 1, enableOfflineQueue: false });
    try {
      await new Promise<void>((resolve, reject) => {
        if (redis.status === 'ready') return resolve();
        redis.once('ready', resolve);
        redis.once('error', reject);
      });
      const keys: string[] = [];
      let cursor = '0';
      do {
        const page = await redis.scan(cursor, 'MATCH', `${redisPrefix}*`, 'COUNT', 200);
        cursor = page[0];
        keys.push(...page[1]);
      } while (cursor !== '0');
      if (keys.length) await redis.del(...keys);
      const remaining = await redis.scan('0', 'MATCH', `${redisPrefix}*`, 'COUNT', 200);
      if (remaining[1].length) throw new Error(`owned prefix remains: ${remaining[1].length}`);
      process.stdout.write(`ORV14_VFY_CLEANUP postgresSchema=${isolation.dbSchema} redisDb=${isolation.redisDbIndex} redisPrefix=${redisPrefix} redisPrefixRemaining=${remaining[1].length}\n`);
    } finally {
      await redis.quit();
    }
  });
  isolation.cleanupArtifactDir();
  if (existsSync(isolation.artifactDir)) errors.push(new Error(`owned artifact directory remains: ${isolation.artifactDir}`));
  await clean('close base PostgreSQL pool', async () => { await baseDb.close(); });
  if (previousAdminWeb === undefined) delete process.env.DU_ADMIN_WEB; else process.env.DU_ADMIN_WEB = previousAdminWeb;
  if (previousAdminWebDist === undefined) delete process.env.DU_ADMIN_WEB_DIST; else process.env.DU_ADMIN_WEB_DIST = previousAdminWebDist;
  if (previousNoProxy === undefined) delete process.env.NO_PROXY; else process.env.NO_PROXY = previousNoProxy;
  if (previousNoProxyLower === undefined) delete process.env.no_proxy; else process.env.no_proxy = previousNoProxyLower;
  if (errors.length) throw new AggregateError(errors, 'ORV14 Cost Alert OIDC fixture cleanup failed');
});

describe('ORV14 independent actual PostgreSQL Cost Alert OIDC inbox path', () => {
  test('cross-replica verified IdP, private recipient pin, exact budget owner, durable delivery, isolated inbox and idempotent read', async () => {
    expect(appA).toBeDefined();
    expect(appB).toBeDefined();
    expect(internalUrlA).toMatch(/^http:\/\/127\.0\.0\.1:/);

    const privacyLeaks: string[] = [];
    const assertNoOidcIdentityEcho = (label: string, value: unknown, subject: string) => {
      const serialized = JSON.stringify(value);
      if (serialized.includes(subject)) privacyLeaks.push(`${label}:subject`);
      if (serialized.includes(idp!.issuer)) privacyLeaks.push(`${label}:issuer`);
    };
    const ownerSub = `owner-${randomUUID()}`;
    const ownerCookie = await loginCrossReplica(shellUrlA, shellUrlB, ownerSub);
    const ownerSession = await sessionContext(shellUrlA, ownerCookie);
    expect(ownerSession.body).not.toHaveProperty('principal.sub');
    expect(await oidcA!.adminSessionStore.get(ownerCookie.slice('du_session='.length))).toMatchObject({ issuer: idp!.issuer, sub: ownerSub, role: 'admin' });
    const verifiedOwner = await appA!.db.query<{ principal_id: string; state: string; authorization_version: number | string }>(
      'SELECT principal_id::text AS principal_id,state,authorization_version FROM cost_alert_oidc_recipients WHERE issuer=$1 AND subject=$2', [idp!.issuer, ownerSub],
    );
    expect(verifiedOwner.rowCount).toBe(1);
    expect(verifiedOwner.rows[0]?.state).toBe('ENABLED');
    expect(Number(verifiedOwner.rows[0]?.authorization_version)).toBe(1);
    const ownerCsrf = ownerSession.csrfToken;

    const badCsrf = await bffJson(shellUrlA, '/cost-alerts/recipients/self', ownerCookie, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    });
    expect(badCsrf.response.status).toBe(403);
    expect(badCsrf.raw).toContain('CSRF_REJECTED');
    const self = await bffJson(shellUrlA, '/cost-alerts/recipients/self', ownerCookie, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': ownerCsrf }, body: '{}',
    });
    expect(self.response.status).toBe(200);
    expect(self.body).toMatchObject({ kind: 'oidc', role: 'ADMIN', state: 'ENABLED', eligible: true });
    assertNoOidcIdentityEcho('self recipient response', self.body, ownerSub);
    const ownerPrincipalId = (self.body as { principalId: string }).principalId;
    expect(ownerPrincipalId).toBe(verifiedOwner.rows[0]!.principal_id);
    const listed = await bffJson(shellUrlA, `/cost-alerts/recipients?tenantId=${tenantId}`, ownerCookie);
    expect(listed.response.status).toBe(200);
    expect(listed.body).toMatchObject({ tenantId, items: [{ principalId: ownerPrincipalId, eligible: true }] });
    assertNoOidcIdentityEcho('recipient catalog response', listed.body, ownerSub);

    const budgetId = randomUUID();
    const config: BudgetConfig = {
      tenantId,
      period: 'daily',
      tokenThreshold: 1000,
      usdThresholdMicroUsd: 1_000_000,
      alertThresholdPercent: 75,
      policy: 'alert-only',
      notificationChannels: ['tenant-admin-inbox-v1'],
      status: 'active',
    };
    const actor = { label: 'orv14-vfy-oidc-budget', role: 'platform' };
    const cost = createCostControlService(appA!.db, createAuditService(appA!.db));
    const draft = await cost.createBudgetDraft({ expectedHeadRevision: 0, budgetId, config }, actor, `orv14-vfy-draft-${randomUUID()}`);
    expect(draft).toMatchObject({ budgetId, revision: 1, state: 'DRAFT' });
    await cost.transitionBudget(budgetId, 'review', { expectedState: 'DRAFT', expectedHeadRevision: 1 }, actor, `orv14-vfy-review-${randomUUID()}`, tenantId);
    const published = await cost.transitionBudget(budgetId, 'publish', {
      expectedState: 'REVIEW', expectedHeadRevision: 1, reviewerReason: 'Synthetic independent verifier publication',
    }, actor, `orv14-vfy-publish-${randomUUID()}`, tenantId);
    expect(published).toMatchObject({ budgetId, revision: 1, state: 'PUBLISHED' });

    const binding = await bffJson(shellUrlB, '/cost-alerts/bindings', ownerCookie, {
      method: 'PUT',
      headers: { 'content-type': 'application/json', 'x-csrf-token': ownerCsrf, 'idempotency-key': `orv14-vfy-binding-${randomUUID()}` },
      body: JSON.stringify({
        tenantId, budgetId, budgetRevision: 1, expectedBindingRevision: 0,
        owner: { kind: 'oidc', principalId: ownerPrincipalId },
        channels: [{ channelId: 'tenant-admin-inbox-v1', channelRevision: 1 }],
      }),
    });
    expect(binding.response.status).toBe(200);
    expect(binding.body).toMatchObject({ owner: { kind: 'oidc', principalId: ownerPrincipalId, authorizationVersion: 1 }, bindingRevision: 1 });
    assertNoOidcIdentityEcho('binding response', binding.body, ownerSub);

    const alertId = randomUUID();
    const window = resolveBudgetQuotaWindow('daily', new Date());
    const scopeKey = budgetQuotaScopeKey(quotaScopeForBudget(config));
    const facts = {
      tenantId, budgetId, budgetRevision: 1, quotaScopeKey: scopeKey,
      windowStart: window.from, windowEnd: window.to, source: 'preflight' as const,
      sourceEventKey: `orv14-vfy-preflight:${randomUUID()}`,
      reservationGroupId: randomUUID(), operationId: randomUUID(), taskId: randomUUID(),
      invocationId: `orv14-vfy-${randomUUID()}`, attempt: 1,
      evaluation: {
        action: 'WARN' as const, hardCapEnabled: false, warnThresholdExceeded: true,
        usagePercent: 81, limitExceeded: false, remainingTokens: 190, remainingCostMicrousd: 190_000,
      },
      trust: { confidence: 'upper-bound' as const, reasonCode: null },
    };
    await appA!.db.tx((client) => enqueueCostBudgetAlerts(client, facts));
    await appA!.db.tx((client) => enqueueCostBudgetAlerts(client, facts));
    const alertRows = await appA!.db.query<{ alert_id: string; routing_state: string; owner_oidc_principal_id: string; owner_authorization_version: number | string }>(
      `SELECT alert_id::text AS alert_id,routing_state,owner_oidc_principal_id::text AS owner_oidc_principal_id,owner_authorization_version
         FROM cost_budget_alerts WHERE tenant_id=$1 AND budget_id=$2 AND source_event_key=$3`,
      [tenantId, budgetId, facts.sourceEventKey],
    );
    expect(alertRows.rowCount).toBe(1);
    expect(alertRows.rows[0]).toMatchObject({ routing_state: 'ROUTED', owner_oidc_principal_id: ownerPrincipalId });
    expect(Number(alertRows.rows[0]?.owner_authorization_version)).toBe(1);
    const deliveryBefore = await appA!.db.query<{ state: string; recipient_kind: string; recipient_oidc_principal_id: string; recipient_authorization_version: number | string }>(
      'SELECT state,recipient_kind,recipient_oidc_principal_id::text AS recipient_oidc_principal_id,recipient_authorization_version FROM cost_alert_deliveries WHERE alert_id=$1', [alertRows.rows[0]!.alert_id],
    );
    expect(deliveryBefore.rowCount).toBe(1);
    expect(deliveryBefore.rows[0]).toMatchObject({ state: 'PENDING', recipient_kind: 'oidc', recipient_oidc_principal_id: ownerPrincipalId });
    expect(Number(deliveryBefore.rows[0]?.recipient_authorization_version)).toBe(1);

    const deliveryResult = await runCostAlertDeliveryBatch(appB!.db, { workerId: `orv14-vfy-delivery-${randomUUID()}`, limit: 10 });
    expect(deliveryResult).toMatchObject({ claimed: 1, delivered: 1, held: 0, retried: 0, exhausted: 0 });
    const repeatDelivery = await runCostAlertDeliveryBatch(appA!.db, { workerId: `orv14-vfy-delivery-replay-${randomUUID()}`, limit: 10 });
    expect(repeatDelivery).toMatchObject({ claimed: 0, delivered: 0, held: 0, retried: 0, exhausted: 0 });
    const persisted = await appA!.db.query<{ state: string; attempt_count: number; inbox_count: string; recipient_kind: string; recipient_oidc_principal_id: string; recipient_authorization_version: number | string }>(
      `SELECT d.state,d.attempt_count,(SELECT count(*)::text FROM cost_alert_inbox i WHERE i.delivery_id=d.delivery_id) AS inbox_count,
              d.recipient_kind,d.recipient_oidc_principal_id::text AS recipient_oidc_principal_id,d.recipient_authorization_version
         FROM cost_alert_deliveries d WHERE d.alert_id=$1`, [alertRows.rows[0]!.alert_id],
    );
    expect(persisted.rows[0]).toMatchObject({ state: 'DELIVERED', attempt_count: 1, inbox_count: '1', recipient_kind: 'oidc', recipient_oidc_principal_id: ownerPrincipalId });
    expect(Number(persisted.rows[0]?.recipient_authorization_version)).toBe(1);

    const secondSub = `second-${randomUUID()}`;
    const secondCookie = await loginCrossReplica(shellUrlB, shellUrlA, secondSub);
    const secondSession = await sessionContext(shellUrlB, secondCookie);
    expect(secondSession.body).not.toHaveProperty('principal.sub');
    const secondSessionRecord = await oidcB!.adminSessionStore.get(secondCookie.slice('du_session='.length));
    expect(secondSessionRecord).toMatchObject({
      issuer: idp!.issuer,
      sub: secondSub,
      role: 'admin',
      costAlertPrincipalId: expect.any(String),
      costAlertAuthorizationVersion: 1,
    });
    const secondVerified = await appA!.db.query<{ principal_id: string; state: string }>(
      'SELECT principal_id::text AS principal_id,state FROM cost_alert_oidc_recipients WHERE issuer=$1 AND subject=$2', [idp!.issuer, secondSub],
    );
    expect(secondVerified.rowCount).toBe(1);
    expect(secondVerified.rows[0]?.state).toBe('ENABLED');
    expect(secondSessionRecord?.costAlertPrincipalId).toBe(secondVerified.rows[0]?.principal_id);
    const secondInboxBeforeSelf = await bffJson(shellUrlB, `/cost-alerts/inbox?tenantId=${tenantId}`, secondCookie);
    expect(secondInboxBeforeSelf.response.status).toBe(200);
    expect(secondInboxBeforeSelf.body).toMatchObject({ tenantId, items: [] });
    const secondSelf = await bffJson(shellUrlB, '/cost-alerts/recipients/self', secondCookie, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': secondSession.csrfToken }, body: '{}',
    });
    expect(secondSelf.response.status).toBe(200);
    expect((secondSelf.body as { principalId: string }).principalId).not.toBe(ownerPrincipalId);
    const catalogNow = await bffJson(shellUrlA, `/cost-alerts/recipients?tenantId=${tenantId}`, ownerCookie);
    expect(catalogNow.response.status).toBe(200);
    expect((catalogNow.body as { items: Array<{ principalId: string }> }).items.map((item) => item.principalId).sort())
      .toEqual([ownerPrincipalId, (secondSelf.body as { principalId: string }).principalId].sort());
    assertNoOidcIdentityEcho('updated recipient catalog response', catalogNow.body, secondSub);
    assertNoOidcIdentityEcho('updated recipient catalog response', catalogNow.body, ownerSub);

    const secondInbox = await bffJson(shellUrlB, `/cost-alerts/inbox?tenantId=${tenantId}`, secondCookie);
    expect(secondInbox.response.status).toBe(200);
    expect(secondInbox.body).toMatchObject({ tenantId, items: [] });
    const foreignRead = await bffJson(shellUrlB, `/cost-alerts/inbox/${alertRows.rows[0]!.alert_id}/read`, secondCookie, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': secondSession.csrfToken }, body: JSON.stringify({ tenantId }),
    });
    expect(foreignRead.response.status).toBe(404);

    const ownerInbox = await bffJson(shellUrlA, `/cost-alerts/inbox?tenantId=${tenantId}&unreadOnly=true`, ownerCookie);
    expect(ownerInbox.response.status).toBe(200);
    expect(ownerInbox.body).toMatchObject({ tenantId, items: [{ alertId: alertRows.rows[0]!.alert_id, kind: 'threshold' }] });
    assertNoOidcIdentityEcho('owner inbox response', ownerInbox.body, ownerSub);
    const read1 = await bffJson(shellUrlA, `/cost-alerts/inbox/${alertRows.rows[0]!.alert_id}/read`, ownerCookie, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': ownerCsrf }, body: JSON.stringify({ tenantId }),
    });
    expect(read1.response.status).toBe(200);
    expect(read1.body).toMatchObject({ tenantId, alertId: alertRows.rows[0]!.alert_id });
    const read2 = await bffJson(shellUrlA, `/cost-alerts/inbox/${alertRows.rows[0]!.alert_id}/read`, ownerCookie, {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-csrf-token': ownerCsrf }, body: JSON.stringify({ tenantId }),
    });
    expect(read2.response.status).toBe(200);
    expect(read2.body).toMatchObject(read1.body as Record<string, unknown>);
    const afterRead = await bffJson(shellUrlA, `/cost-alerts/inbox?tenantId=${tenantId}&unreadOnly=true`, ownerCookie);
    expect(afterRead.response.status).toBe(200);
    expect(afterRead.body).toMatchObject({ items: [] });
    const inboxService = createCostAlertService(appA!.db, createAuditService(appA!.db));
    const dbInbox = await inboxService.listOwnerInbox({ tenantId, limit: 10, unreadOnly: false }, {
      kind: 'oidc', principalId: ownerPrincipalId,
      authorizationVersion: Number(verifiedOwner.rows[0]!.authorization_version),
    });
    expect(dbInbox.items).toHaveLength(1);
    expect(dbInbox.items[0]).toHaveProperty('readAt');
    expect(privacyLeaks).toEqual([]);
  });
});
