import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../../orchestrator/services/orchestrator/src/db/db';
import type { Db } from '../../../orchestrator/services/orchestrator/src/db/db';
import { createCostControlService } from '../../../orchestrator/services/orchestrator/src/modules/cost-control/service';
import { createUsageService } from '../../../orchestrator/services/orchestrator/src/modules/usage/usage';
import type { PoolClient } from 'pg';
import { createMemorySessionRepository, createSessionStore } from '../../../orchestrator/services/orchestrator/src/modules/auth/session-store';
import { recordWorkerHeartbeat } from '../../../orchestrator/services/orchestrator/src/modules/runtime/worker-instances';
import { SESSION_COOKIE_NAME } from '../../../orchestrator/services/orchestrator/src/modules/auth/session-store';
import { createTestIsolationContext, assertSafeIsolationConfig } from '../../isolation/namespace';
import { syntheticMetadataKeyProvider } from '../isolation';

const tenantId = randomUUID();
const otherTenantId = randomUUID();
const runId = `orv14_vfy_${Date.now()}_${randomBytes(5).toString('hex')}`;
const baseDatabaseUrl = process.env.WFA_DATABASE_URL ?? 'postgresql://orv14_vfy:orv14-vfy-local-only@127.0.0.1:25414/orv14_vfy';
const baseRedisUrl = process.env.WFA_REDIS_URL ?? 'redis://127.0.0.1:26414/14';
const isolation = createTestIsolationContext({ runId, baseArtifactPath: 'tests/workflow-api/orv14-vfy/artifacts' });
const databaseUrl = isolation.getDatabaseUrlWithSchema(baseDatabaseUrl);
const scopedRedis = new URL(isolation.getRedisUrl(baseRedisUrl));
scopedRedis.pathname = `/${isolation.redisDbIndex}`;
const redisUrl = scopedRedis.toString();
assertSafeIsolationConfig({ databaseUrl, redisUrl, isolationCtx: isolation });

const baseDb = createDb(baseDatabaseUrl);
const sessions = createSessionStore({ repo: createMemorySessionRepository() });
const adminToken = `orv14-vfy-admin-${randomUUID()}`;
const tenantToken = `orv14-vfy-tenant-${randomUUID()}`;
const workerIdentityToken = `orv14-vfy-worker-${randomUUID()}`;
const costControlToken = `orv14-vfy-cost-control-${randomUUID()}`;
const invocationGrantSecret = `orv14-vfy-invocation-grant-${randomUUID()}`;
const cookieSecret = `orv14-vfy-cookie-${randomUUID()}-synthetic-only`;
const previousAdminWeb = process.env.DU_ADMIN_WEB;
const previousAdminWebDist = process.env.DU_ADMIN_WEB_DIST;
let app: App | undefined;
let schemaCreated = false;
let publicUrl = '';
let internalUrl = '';
let shellUrl = '';
let adminSession: Awaited<ReturnType<typeof sessions.create>>;
let tenantSession: Awaited<ReturnType<typeof sessions.create>>;
let operationId = '';
let ownApiKey = '';
let ownApiKeyId = '';
let sameTenantApiKey = '';
let foreignApiKey = '';

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

function sessionCookie(session: Awaited<ReturnType<typeof sessions.create>>): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.sessionId)}`;
}

async function bffRequest(
  session: Awaited<ReturnType<typeof sessions.create>>,
  path: string,
  init: RequestInit = {},
  csrf = true,
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('cookie', sessionCookie(session));
  if (csrf) headers.set('x-csrf-token', session.csrfToken);
  return fetch(`${shellUrl}/admin/api${path}`, { ...init, headers });
}

interface CostInvocation {
  operationId: string;
  taskId: string;
  invocationId: string;
  reservationGroupId: string;
  grant: string;
}

interface CostScope {
  tenantId: string;
  apiKeyId: string;
  profileId: string;
}

const COST_CONNECTOR_ID = 'orv14-vfy-openai';
const COST_CAPABILITY_ID = 'openai-gpt-4o-2024-08-06-chat-v1';
const COST_MODEL = 'gpt-4o-2024-08-06';

async function makeCostScope(): Promise<CostScope> {
  if (!app) throw new Error('ORV14 cost fixture is not initialized');
  const scopedTenantId = randomUUID();
  const scopedProfileId = randomUUID();
  const rawKey = `orv14-vfy-cost-key-${randomUUID()}`;
  await app.db.query('INSERT INTO tenants (id,name,state) VALUES ($1,$2,\'ACTIVE\')', [scopedTenantId, 'ORV14 synthetic cost tenant']);
  const insertedKey = await app.db.query<{ id: string }>(
    'INSERT INTO api_keys (tenant_id,hash,prefix,status) VALUES ($1,$2,$3,\'ACTIVE\') RETURNING id',
    [scopedTenantId, createHash('sha256').update(rawKey).digest('hex'), 'orv14-vfy-cost'],
  );
  return { tenantId: scopedTenantId, apiKeyId: insertedKey.rows[0]!.id, profileId: scopedProfileId };
}

async function makeCostInvocation(scope: CostScope): Promise<CostInvocation> {
  if (!app) throw new Error('ORV14 cost fixture is not initialized');
  const operation = randomUUID();
  const task = randomUUID();
  const invocation = randomUUID();
  const reservationGroup = randomUUID();
  await app.db.query(
    `INSERT INTO operations
      (id,tenant_id,api_key_id,profile_id,profile_revision,business_id,business_version,action,state,state_version,correlation_id,created_at,updated_at)
     VALUES($1,$2,$3,$4,1,'document-core','1.0.0','extract','RUNNING',1,$5,now(),now())`,
    [operation, scope.tenantId, scope.apiKeyId, scope.profileId, `orv14-vfy-cost-${invocation}`],
  );
  await app.db.query(
    `INSERT INTO tasks(id,operation_id,task_key,kind,state,attempt,max_attempts,created_at,updated_at)
     VALUES($1,$2,'cost-step','connector','RUNNING',1,3,now(),now())`,
    [task, operation],
  );
  const issuedAt = Math.floor(Date.now() / 1000);
  const claims = {
    audience: 'connector' as const,
    tenantId: scope.tenantId,
    operationId: operation,
    taskId: task,
    stepKey: 'cost-step',
    invocationId: invocation,
    inputHash: `sha256:${createHash('sha256').update(`orv14-vfy-input:${invocation}`).digest('hex')}`,
    connectorId: COST_CONNECTOR_ID,
    connectorRevision: 1,
    bindingSlot: 'primary',
    exp: issuedAt + 600,
    iat: issuedAt,
    costContext: {
      selectionState: 'DEFERRED' as const,
      apiKeyId: scope.apiKeyId,
      profileId: scope.profileId,
      profileRevision: 1,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'extract',
      attempt: 1,
      priceRevision: null,
      budgetReservationGroupId: reservationGroup,
      budgetPins: [],
    },
  };
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
  const header = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode(claims);
  const signature = createHmac('sha256', invocationGrantSecret).update(`${header}.${payload}`).digest('base64url');
  return { operationId: operation, taskId: task, invocationId: invocation, reservationGroupId: reservationGroup, grant: `${header}.${payload}.${signature}` };
}

function costProof(options: { unknownUnits?: boolean } = {}) {
  return {
    version: 'cost-bound-v1' as const,
    capabilityId: COST_CAPABILITY_ID,
    connectorId: COST_CONNECTOR_ID,
    connectorRevision: 1,
    provider: 'openai',
    model: COST_MODEL,
    requestDigest: `sha256:${'a'.repeat(64)}`,
    inputUpperBoundTokens: 128_000,
    outputLimit: 16_384,
    outputLimitField: 'max_tokens' as const,
    artifactCount: 0,
    hasSession: false,
    hasTools: false,
    hasUnknownUnits: options.unknownUnits ?? false,
    retryCount: 0,
  };
}

async function preflightCost(invocation: CostInvocation, proof = costProof()): Promise<{ response: Response; body: Record<string, any> }> {
  const response = await fetch(`${internalUrl}/api/internal/cost-control/reservations/preflight`, {
    method: 'POST',
    headers: { authorization: `Bearer ${costControlToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ grant: invocation.grant, proof }),
  });
  return { response, body: await response.json() as Record<string, any> };
}

async function transitionCost(invocation: CostInvocation, target: 'RUNNING' | 'UNKNOWN'): Promise<Response> {
  return fetch(`${internalUrl}/api/internal/cost-control/reservations/transitions`, {
    method: 'POST',
    headers: { authorization: `Bearer ${costControlToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({
      grant: invocation.grant,
      reservationGroupId: invocation.reservationGroupId,
      operationId: invocation.operationId,
      taskId: invocation.taskId,
      invocationId: invocation.invocationId,
      attempt: 1,
      target,
      ...(target === 'UNKNOWN' ? { reasonCode: 'PROVIDER_ACK_UNKNOWN' } : {}),
    }),
  });
}

async function publishBudget(input: {
  tenantId: string;
  budgetId: string;
  tokenThreshold: number;
  policy: 'alert-only' | 'block-new-invocations';
  apiKeyId?: string;
  profileId?: string;
}): Promise<void> {
  const config = {
    tenantId: input.tenantId,
    ...(input.apiKeyId ? { apiKeyId: input.apiKeyId } : {}),
    ...(input.profileId ? { profileId: input.profileId } : {}),
    businessId: 'document-core',
    period: 'daily',
    tokenThreshold: input.tokenThreshold,
    usdThresholdMicroUsd: 100_000_000,
    alertThresholdPercent: 80,
    policy: input.policy,
    status: 'active',
    notificationChannels: [],
  };
  const request = async (path: string, body: unknown, idempotencyKey: string): Promise<{ response: Response; body: any }> => {
    const response = await fetch(`${internalUrl}/api/internal/cost-control${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': idempotencyKey },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  };
  const draft = await request('/budgets/draft', { budgetId: input.budgetId, expectedHeadRevision: 0, config }, `orv14-vfy-budget-draft-${input.budgetId}`);
  if (draft.response.status !== 201) throw new Error(`cost budget draft returned ${draft.response.status}: ${JSON.stringify(draft.body)}`);
  const review = await request(`/budgets/${input.budgetId}/review`, { expectedState: 'DRAFT', expectedHeadRevision: 1 }, `orv14-vfy-budget-review-${input.budgetId}`);
  if (review.response.status !== 200) throw new Error(`cost budget review returned ${review.response.status}: ${JSON.stringify(review.body)}`);
  const publish = await request(`/budgets/${input.budgetId}/publish`, { expectedState: 'REVIEW', expectedHeadRevision: 1, reviewerReason: 'Independent ORV14 synthetic verification' }, `orv14-vfy-budget-publish-${input.budgetId}`);
  if (publish.response.status !== 200) throw new Error(`cost budget publish returned ${publish.response.status}: ${JSON.stringify(publish.body)}`);
}

async function publishPriceBook(): Promise<void> {
  const prefix = `orv14-vfy-price-${randomUUID()}`;
  const request = async (path: string, body: unknown, key: string): Promise<{ response: Response; body: any }> => {
    const response = await fetch(`${internalUrl}/api/internal/cost-control${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    return { response, body: await response.json() };
  };
  const draft = await request('/prices/draft', {
    expectedHeadRevision: 0,
    tiers: [{ provider: 'openai', modelId: COST_MODEL, priceVersion: 1, effectiveFrom: '2026-10-01T00:00:00Z', inputMicrousdPerMillion: 1_000_000, outputMicrousdPerMillion: 1_000_000 }],
  }, `${prefix}-draft`);
  if (draft.response.status !== 201) throw new Error(`cost price draft returned ${draft.response.status}: ${JSON.stringify(draft.body)}`);
  const review = await request('/prices/review', { expectedState: 'DRAFT', expectedHeadRevision: 1 }, `${prefix}-review`);
  if (review.response.status !== 200) throw new Error(`cost price review returned ${review.response.status}: ${JSON.stringify(review.body)}`);
  const publish = await request('/prices/publish', { expectedState: 'REVIEW', expectedHeadRevision: 1, reviewerReason: 'Independent ORV14 synthetic verification' }, `${prefix}-publish`);
  if (publish.response.status !== 200) throw new Error(`cost price publish returned ${publish.response.status}: ${JSON.stringify(publish.body)}`);
}

function instrumentDb(
  base: Db,
  afterQuery?: (sql: string, params?: unknown[]) => Promise<void>,
  appName?: string,
  beforeQuery?: (sql: string) => Promise<void>,
): Db {
  return {
    pool: base.pool,
    query: (sql, params) => base.query(sql, params),
    async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
      return base.tx(async (client) => {
        if (appName) await client.query("SELECT set_config('application_name',$1,true)", [appName]);
        const wrapped = new Proxy(client, {
          get(target, property) {
            if (property === 'query') {
              return async (sql: string, params?: unknown[]) => {
                if (beforeQuery) await beforeQuery(sql);
                const result = await target.query(sql, params as never[]);
                if (afterQuery) await afterQuery(sql, params);
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

function testXml(slug = 'orv14-safe-flow'): string {
  return `<?xml version="1.0"?>
    <workflow slug="${slug}" name="Safe imported flow" version="2">
      <input><property name="document" type="string" required="true" /></input>
      <nodes>
        <node id="source" type="input" key="document" />
        <node id="read" type="connector" connector="ocr"><input key="document" value="$source" /></node>
        <node id="review" type="human" message="Check extracted text" resumeInputs="approved,notes" />
        <node id="notify" type="callback" url="https://callback.synthetic.example/results" method="POST" payload="{&quot;ok&quot;:true}" />
      </nodes>
      <flow><step id="source" /><step id="read" /><step id="review" /><step id="notify" /></flow>
      <output from="read" />
    </workflow>`;
}

beforeAll(async () => {
  process.stdout.write(`ORV14_VFY_NAMESPACE suite=http runId=${runId} postgresSchema=${isolation.dbSchema} redisDb=${isolation.redisDbIndex} redisPrefix=${isolation.redisPrefix} queuePrefix=${isolation.queuePrefix} artifactDir=${isolation.artifactDir}\n`);
  process.env.DU_ADMIN_WEB = '1';
  process.env.DU_ADMIN_WEB_DIST = 'tests/workflow-api/orv14-vfy/no-bundle';
  await baseDb.query(`CREATE SCHEMA "${isolation.dbSchema}"`);
  schemaCreated = true;
  const internalPort = await availablePort();
  adminSession = await sessions.create({ issuer: 'orv14-vfy', sub: 'platform-admin', role: 'admin' });
  tenantSession = await sessions.create({ issuer: 'orv14-vfy', sub: 'tenant-operator', role: 'operator', tenantId });
  app = await createApp({
    host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort,
    databaseUrl, redisUrl, autoMigrate: true, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken, tenantAdminTokens: { [tenantToken]: tenantId }, adminSessionStore: sessions,
    costControlToken, invocationGrantSecret,
    runtimeToken: `orv14-vfy-runtime-${randomUUID()}`,
    workerIdentityTokensByBusiness: { 'document-core': workerIdentityToken },
    adminShellCookieSecret: cookieSecret, adminShellHost: '127.0.0.1', adminShellPort: 0,
    jsonBaseUrl: `http://127.0.0.1:${internalPort}`,
    publicUploadEncryption: { keyProvider: syntheticMetadataKeyProvider(), keyRef: `${runId}-artifacts` },
    metadataEncryption: { keyProvider: syntheticMetadataKeyProvider(), keyRef: runId },
  });
  const publicServer = await app.listen();
  const publicAddress = publicServer.address();
  const internalAddress = app.internalServer.address();
  if (!publicAddress || typeof publicAddress === 'string' || !internalAddress || typeof internalAddress === 'string') {
    throw new Error('ORV14 verifier app failed to bind its public and internal HTTP listeners');
  }
  publicUrl = `http://127.0.0.1:${publicAddress.port}`;
  internalUrl = `http://127.0.0.1:${internalAddress.port}`;
  shellUrl = app.adminShell!.url;
  await app.db.query('INSERT INTO tenants (id,name,state) VALUES ($1,$2,\'ACTIVE\'),($3,$4,\'ACTIVE\')', [tenantId, 'ORV14 verifier tenant', otherTenantId, 'ORV14 foreign tenant']);

  const insertKey = async (tenant: string, raw: string): Promise<string> => {
    const result = await app!.db.query<{ id: string }>(
      'INSERT INTO api_keys (tenant_id,hash,prefix,status) VALUES ($1,$2,$3,\'ACTIVE\') RETURNING id',
      [tenant, createHash('sha256').update(raw).digest('hex'), 'orv14-vfy'],
    );
    return result.rows[0]!.id;
  };
  ownApiKey = `orv14-vfy-own-${randomUUID()}`;
  sameTenantApiKey = `orv14-vfy-same-tenant-${randomUUID()}`;
  foreignApiKey = `orv14-vfy-foreign-${randomUUID()}`;
  ownApiKeyId = await insertKey(tenantId, ownApiKey);
  await insertKey(tenantId, sameTenantApiKey);
  await insertKey(otherTenantId, foreignApiKey);
  operationId = randomUUID();
  await app.db.query(
    `INSERT INTO operations (id,tenant_id,api_key_id,business_id,business_version,action,state,state_version,correlation_id,output_content,output_format,created_at,updated_at)
     VALUES ($1,$2,$3,'document-core','1.0.0','extract','SUCCEEDED',1,'orv14-vfy-public-compat','exact-legacy-result-bytes','txt',now(),now())`,
    [operationId, tenantId, ownApiKeyId],
  );
});

afterAll(async () => {
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
  if (schemaCreated) await baseDb.query(`DROP SCHEMA "${isolation.dbSchema}" CASCADE`);
  await baseDb.close();
  isolation.cleanupArtifactDir();
  if (previousAdminWeb === undefined) delete process.env.DU_ADMIN_WEB; else process.env.DU_ADMIN_WEB = previousAdminWeb;
  if (previousAdminWebDist === undefined) delete process.env.DU_ADMIN_WEB_DIST; else process.env.DU_ADMIN_WEB_DIST = previousAdminWebDist;
});

describe('ORV14 source-independent HTTP regressions on isolated PostgreSQL and Redis', () => {
  test('actual worker heartbeat returns the persisted control revision acknowledgement', async () => {
    const workerInstanceId = `orv14-vfy-worker-${randomUUID()}`;
    const body = { businessId: 'document-core', businessVersion: '1.0.0', imageDigest: `sha256:${'a'.repeat(64)}`, capacity: 1, activeTasks: 0 };
    const response = await fetch(`${internalUrl}/api/runtime/v1/workers/${encodeURIComponent(workerInstanceId)}/heartbeat`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${workerIdentityToken}`, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.status !== 200) {
      const wire = await response.text();
      try {
        await recordWorkerHeartbeat(app!.db, workerInstanceId, body);
      } catch (error) {
        const pgError = error as Error & { code?: string };
        throw new Error(`heartbeat returned ${response.status} ${wire}; direct persistence failed ${pgError.name} ${pgError.code ?? ''}: ${pgError.message}`);
      }
      throw new Error(`heartbeat returned ${response.status} ${wire}; direct persistence succeeded`);
    }
    expect(await response.json()).toMatchObject({ health: 'HEALTHY', capacity: 1, controlState: 'OPEN' });
    const observed = await app!.db.query<{ active_task_count: number; control_state: string }>(
      'SELECT active_task_count,control_state FROM worker_instances WHERE business_id=$1 AND instance_id=$2',
      ['document-core', workerInstanceId],
    );
    expect(observed.rows[0]).toMatchObject({ active_task_count: 0, control_state: 'OPEN' });
  });

  test('legacy public operation GET and download remain key-scoped while every retired management URL stays internal', async () => {
    const detail = await fetch(`${publicUrl}/api/v1/operations/${operationId}`, { headers: { 'x-api-key': ownApiKey } });
    expect(detail.status).toBe(200);
    expect(await detail.text()).toContain('exact-legacy-result-bytes');
    const download = await fetch(`${publicUrl}/api/v1/operations/${operationId}/download`, { headers: { 'x-api-key': ownApiKey } });
    expect(download.status).toBe(200);
    expect(await download.text()).toBe('exact-legacy-result-bytes');
    for (const key of [sameTenantApiKey, foreignApiKey]) {
      for (const suffix of ['', '/download']) {
        const denied = await fetch(`${publicUrl}/api/v1/operations/${operationId}${suffix}`, { headers: { 'x-api-key': key } });
        expect(denied.status).toBe(404);
      }
    }
    for (const [method, suffix] of [
      ['GET', ''], ['GET', '/metrics'], ['GET', `/${operationId}/result`],
      ['POST', `/${operationId}/cancel`], ['POST', `/${operationId}/resume`],
      ['POST', `/${operationId}/retry`], ['DELETE', `/${operationId}`],
    ] as const) {
      const retired = await fetch(`${publicUrl}/api/v1/operations${suffix}`, { method, headers: { 'x-api-key': ownApiKey } });
      expect({ method, suffix, status: retired.status }).toEqual({ method, suffix, status: 404 });
    }
  });

  test('actual PostgreSQL cost groups preserve late scopes, sibling de-duplication, settlement serialization, and UNKNOWN fail-closed behavior', async () => {
    await publishPriceBook();
    const costScope = await makeCostScope();

    const noBudget = await makeCostInvocation(costScope);
    const noBudgetResult = await preflightCost(noBudget);
    expect(noBudgetResult.response.status).toBe(200);
    expect(noBudgetResult.body.selection.budgetPins).toEqual([]);
    expect(noBudgetResult.body.confidence).toBe('upper-bound');
    const noBudgetRow = await app!.db.query<{ state: string; reserved_tokens: string; reservation_bounded: boolean }>(
      'SELECT state,reserved_tokens::text,reservation_bounded FROM cost_reservation_groups WHERE reservation_group_id=$1',
      [noBudget.reservationGroupId],
    );
    expect(noBudgetRow.rows[0]).toMatchObject({ state: 'RESERVED', reserved_tokens: '144384', reservation_bounded: true });
    expect((await app!.db.query('SELECT 1 FROM cost_budget_holds WHERE reservation_group_id=$1', [noBudget.reservationGroupId])).rowCount).toBe(0);
    expect((await transitionCost(noBudget, 'RUNNING')).status).toBe(200);
    expect((await transitionCost(noBudget, 'UNKNOWN')).status).toBe(200);

    const tenantBudgetId = randomUUID();
    const keyBudgetId = randomUUID();
    const profileBudgetId = randomUUID();
    await publishBudget({ tenantId: costScope.tenantId, budgetId: tenantBudgetId, tokenThreshold: 1_000_000, policy: 'alert-only' });
    await publishBudget({ tenantId: costScope.tenantId, budgetId: keyBudgetId, tokenThreshold: 1_000_000, policy: 'alert-only', apiKeyId: costScope.apiKeyId });

    const twoSiblings = await makeCostInvocation(costScope);
    const siblingsResult = await preflightCost(twoSiblings);
    expect(siblingsResult.response.status).toBe(200);
    expect(siblingsResult.body.selection.budgetPins).toHaveLength(2);
    const siblingRows = await app!.db.query<{ count: string }>(
      'SELECT count(*)::text AS count FROM cost_budget_holds WHERE reservation_group_id=$1',
      [twoSiblings.reservationGroupId],
    );
    expect(siblingRows.rows[0]?.count).toBe('2');
    expect((await transitionCost(twoSiblings, 'RUNNING')).status).toBe(200);
    expect((await transitionCost(twoSiblings, 'UNKNOWN')).status).toBe(200);

    await publishBudget({
      tenantId: costScope.tenantId, budgetId: profileBudgetId, tokenThreshold: 450_000, policy: 'alert-only', apiKeyId: costScope.apiKeyId, profileId: costScope.profileId,
    });
    const afterPublication = await makeCostInvocation(costScope);
    const afterPublicationResult = await preflightCost(afterPublication);
    expect(afterPublicationResult.response.status).toBe(200);
    expect(afterPublicationResult.body.selection.budgetPins).toHaveLength(3);
    const profileEvaluation = afterPublicationResult.body.evaluations.find((item: { budgetId: string }) => item.budgetId === profileBudgetId);
    // The newly published tenant+key+Profile scope sees the no-child-hold
    // invocation plus the two-hold sibling invocation exactly once each,
    // plus its own proposed call: 3 * (128000 + 16384).
    expect(profileEvaluation).toMatchObject({ remainingTokens: 16_848, action: 'WARN' });

    const incoming = await makeCostInvocation(costScope);
    let signalUsageRead!: () => void;
    let releaseUsageRead!: () => void;
    let signalledUsageRead = false;
    const usageReadReached = new Promise<void>((resolve) => { signalUsageRead = resolve; });
    const continuePreflight = new Promise<void>((resolve) => { releaseUsageRead = resolve; });
    const pausedDb = instrumentDb(app!.db, async (sql, params) => {
      if (!signalledUsageRead && sql.includes('FROM usage_events ue JOIN operations o')
          && params?.[1] === costScope.apiKeyId && params?.[2] === costScope.profileId) {
        signalledUsageRead = true;
        signalUsageRead();
        await continuePreflight;
      }
    });
    const costService = createCostControlService(pausedDb, undefined, () => new Date(), { invocationGrantSecret });
    const admission = costService.preflight({ grant: incoming.grant, proof: costProof() });
    let settledDuringRead = false;
    let settlementCompletedBeforeRelease = false;
    let settlementError: unknown;
    let settleStarted!: () => void;
    const settlementStarted = new Promise<void>((resolve) => { settleStarted = resolve; });
    const appName = `orv14vfysettle${randomBytes(4).toString('hex')}`;
    const observedUsageDb = instrumentDb(app!.db, undefined, appName, async (sql) => {
      if (!sql.includes('set_config')) settleStarted();
    });
    const usageService = createUsageService(observedUsageDb);
    const frozenTier = siblingsResult.body.selection.pricingTier;
    const usageEvent = {
      eventId: `orv14-vfy-cost-settlement-${randomUUID()}`,
      invocationId: twoSiblings.invocationId,
      operationId: twoSiblings.operationId,
      taskId: twoSiblings.taskId,
      units: { inputTokens: 100, outputTokens: 20 },
      costMicrousd: 120,
      currency: 'USD' as const,
      measurement: 'measured' as const,
      provider: 'openai',
      model: COST_MODEL,
      costStatus: 'measured' as const,
      occurredAt: new Date().toISOString(),
      costProvenance: {
        version: 1 as const,
        tenantId: costScope.tenantId,
        apiKeyId: costScope.apiKeyId,
        profileId: costScope.profileId,
        profileRevision: 1,
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: 'extract',
        attempt: 1,
        stepKey: 'cost-step',
        connectorId: COST_CONNECTOR_ID,
        connectorRevision: 1,
        durationMs: 20,
        reservationGroupId: twoSiblings.reservationGroupId,
        selectedAt: siblingsResult.body.selection.selectedAt,
        confidence: 'upper-bound' as const,
        priceRevision: siblingsResult.body.selection.priceRevision,
        priceSnapshot: frozenTier,
        budgetPins: siblingsResult.body.selection.budgetPins,
        costBoundCapabilityId: COST_CAPABILITY_ID,
        inputUpperBoundTokens: 128_000,
        outputLimitTokens: 16_384,
      },
    };
    const settled = usageService.ingest(usageEvent).then((ack) => {
      settledDuringRead = true;
      return ack;
    }, (error: unknown) => {
      settlementError = error;
      settledDuringRead = true;
      throw error;
    });

    let settlementWaitedOnLock = false;
    let usageReadTimeout: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        usageReadReached,
        new Promise<void>((_resolve, reject) => {
          usageReadTimeout = setTimeout(() => reject(new Error('profile scoped committed-usage query was not reached')), 2_000);
        }),
      ]).finally(() => { if (usageReadTimeout) clearTimeout(usageReadTimeout); });
      await settlementStarted;
      const deadline = Date.now() + 2_000;
      while (Date.now() < deadline && !settledDuringRead) {
        const activity = await app!.db.query<{ wait_event_type: string | null; wait_event: string | null }>(
          'SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE application_name=$1 AND state=\'active\' ORDER BY query_start DESC LIMIT 1',
          [appName],
        );
        if (activity.rows[0]?.wait_event_type === 'Lock') {
          settlementWaitedOnLock = true;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    } finally {
      settlementCompletedBeforeRelease = settledDuringRead;
      releaseUsageRead();
    }
    const admitted = await admission;
    await settled;
    expect(settlementError).toBeUndefined();
    expect(settlementWaitedOnLock).toBe(true);
    expect(settlementCompletedBeforeRelease).toBe(false);
    const raceEvaluation = (admitted as { evaluations: Array<{ budgetId: string; remainingTokens: number }> }).evaluations
      .find((item) => item.budgetId === profileBudgetId);
    // The unresolved group's exact hold remains visible until settlement can
    // atomically publish usage and release it; no READ COMMITTED accounting gap.
    expect(raceEvaluation?.remainingTokens).toBe(0);

    const unbounded = await makeCostInvocation(costScope);
    const unboundedResult = await preflightCost(unbounded, costProof({ unknownUnits: true }));
    expect(unboundedResult.response.status).toBe(200);
    expect(unboundedResult.body.confidence).toBe('best-effort');
    const unboundedRow = await app!.db.query<{ reservation_bounded: boolean; confidence: string; reserved_tokens: string; state: string }>(
      'SELECT reservation_bounded,confidence,reserved_tokens::text,state FROM cost_reservation_groups WHERE reservation_group_id=$1',
      [unbounded.reservationGroupId],
    );
    expect(unboundedRow.rows[0]).toMatchObject({ reservation_bounded: false, confidence: 'best-effort', reserved_tokens: '0', state: 'RESERVED' });
    expect((await transitionCost(unbounded, 'RUNNING')).status).toBe(200);
    expect((await transitionCost(unbounded, 'UNKNOWN')).status).toBe(200);

    await publishBudget({
      tenantId: costScope.tenantId, budgetId: randomUUID(), tokenThreshold: 900_000, policy: 'block-new-invocations', apiKeyId: costScope.apiKeyId, profileId: costScope.profileId,
    });
    const blockProbe = await makeCostInvocation(costScope);
    const failClosed = await preflightCost(blockProbe);
    expect(failClosed.response.status).toBe(422);
    expect(failClosed.body).toMatchObject({ code: 'BUDGET_BOUND_UNSUPPORTED' });
  });

  test('internal Admin operation list uses the declared tenant query and rejects the obsolete tenantId synonym', async () => {
    const accepted = await fetch(`${internalUrl}/api/internal/operations?tenant=${encodeURIComponent(tenantId)}&limit=20`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(accepted.status).toBe(200);
    const page = await accepted.json() as Record<string, unknown>;
    expect(JSON.stringify(page)).toContain(operationId);
    const obsolete = await fetch(`${internalUrl}/api/internal/operations?tenantId=${encodeURIComponent(tenantId)}`, {
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(obsolete.status).toBe(422);
    expect(await obsolete.json()).toMatchObject({ code: 'INVALID_SCHEMA', title: 'operations query contains an unsupported or repeated parameter' });

    const bffPage = await bffRequest(adminSession, `/operations?tenant=${encodeURIComponent(tenantId)}&limit=20`);
    expect(bffPage.status).toBe(200);
    expect(JSON.stringify(await bffPage.json())).toContain(operationId);
    const tenantOwnPage = await bffRequest(tenantSession, `/operations?tenant=${encodeURIComponent(tenantId)}&limit=20`);
    expect(tenantOwnPage.status).toBe(200);
    const tenantForeignPage = await bffRequest(tenantSession, `/operations?tenant=${encodeURIComponent(otherTenantId)}&limit=20`);
    expect(tenantForeignPage.status).toBe(403);
  });

  test('actual Admin BFF previews safe XML and denies missing CSRF and tenant-operator writes', async () => {
    const source = testXml();
    const request = { tenantId, format: 'xml', source };
    const accepted = await bffRequest(adminSession, '/workflow-import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    if (accepted.status !== 200) throw new Error(`workflow import BFF returned ${accepted.status}: ${await accepted.text()}`);
    const preview = await accepted.json() as Record<string, any>;
    expect(preview).toMatchObject({
      tenantId, format: 'xml', sourceDigest: `sha256:${createHash('sha256').update(source).digest('hex')}`,
      schema: { slug: 'orv14-safe-flow', name: 'Safe imported flow', version: 2, flow: ['source', 'read', 'review', 'notify'] },
      connectorNames: ['ocr'],
      egress: [{ nodeId: 'notify', kind: 'callback', staticOrigins: ['https://callback.synthetic.example'], dynamic: false }],
    });
    expect(preview.schema.nodes[2]).toMatchObject({ type: 'human', resumeInputs: ['approved', 'notes'] });

    const noCsrf = await bffRequest(adminSession, '/workflow-import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    }, false);
    expect(noCsrf.status).toBe(403);
    const tenantWrite = await bffRequest(tenantSession, '/workflow-import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(request),
    });
    expect(tenantWrite.status).toBe(403);
  });

  test('actual Admin BFF refuses unsafe XML, graph bindings, tenant mismatch, and oversized source', async () => {
    const xxe = '<!DOCTYPE workflow [<!ENTITY x SYSTEM "file:///etc/passwd">]>' + testXml();
    const unsafe = await bffRequest(adminSession, '/workflow-import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, format: 'xml', source: xxe }),
    });
    if (unsafe.status !== 422) throw new Error(`unsafe XML returned ${unsafe.status}: ${await unsafe.text()}`);

    const dangling = JSON.stringify({ slug: 'dangling', name: 'Dangling', nodes: [{ id: 'one', type: 'connector', connector: 'ocr', inputs: { document: '$missing' } }], flow: ['one'] });
    const badGraph = await bffRequest(adminSession, '/workflow-import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, format: 'json', source: dangling }),
    });
    expect(badGraph.status).toBe(422);

    const foreign = await bffRequest(adminSession, '/workflow-import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId: otherTenantId, format: 'xml', source: testXml('foreign-flow') }),
    });
    expect(foreign.status).toBe(200);
    const foreignPreview = await foreign.json() as Record<string, unknown>;
    expect(foreignPreview['tenantId']).toBe(otherTenantId);

    const oversized = await bffRequest(adminSession, '/workflow-import/preview', {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ tenantId, format: 'xml', source: `${' '.repeat(512 * 1024)}${testXml()}` }),
    });
    expect(oversized.status).toBe(422);
  });
});
