import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { chromium, type Browser, type Page } from '../browser/node_modules/@playwright/test';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { documentCoreManifest } from '../../businesses/document-core/src/manifest/document-core.manifest';
import { createApp, type App } from '../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../orchestrator/services/orchestrator/src/db/db';
import { createMemorySessionRepository, createSessionStore, SESSION_COOKIE_NAME } from '../../orchestrator/services/orchestrator/src/modules/auth/session-store';
import { deliverWebhooks } from '../../orchestrator/services/orchestrator/src/modules/webhooks/webhooks';
import { toContractUsageEvent, type UsageEvent as ConnectorUsageEvent } from '../../orchestrator/services/connector/src/usage';
import { ADMIN_AUTH_EXPIRED_EVENT, createAdminApiClient } from '../../orchestrator/apps/admin-web/src/lib/api/client';
import { createWorkflowApiIsolation, syntheticMetadataKeyProvider } from './isolation';

/** VFY-UI13: actual mounted shell/BFF, real Orchestrator HTTP listeners and isolated PG/Redis. */
const isolation = createWorkflowApiIsolation();
const baseDb = createDb(isolation.baseDatabaseUrl);
const sessions = createSessionStore({ repo: createMemorySessionRepository() });
type TestSession = Awaited<ReturnType<typeof sessions.create>>;
const tenantA = randomUUID();
const tenantB = randomUUID();
const adminToken = `orv13-vfy-admin-${randomUUID()}`;
const runtimeToken = `orv13-vfy-runtime-${randomUUID()}`;
const usageToken = `orv13-vfy-usage-${randomUUID()}`;
const tenantAToken = `orv13-vfy-tenant-a-${randomUUID()}`;
const tenantBToken = `orv13-vfy-tenant-b-${randomUUID()}`;
const cookieSecret = `orv13-vfy-cookie-${randomUUID()}-secret`;
const browserSecret = 'orv13-vfy-callback-synthetic-only';
const receiverBodies: string[] = [];
const receiver = createServer((req, res) => {
  let body = '';
  req.on('data', (chunk: Buffer | string) => { body += chunk; });
  req.on('end', () => { receiverBodies.push(body); res.writeHead(204); res.end(); });
});
const previousAdminWeb = process.env.DU_ADMIN_WEB;
const previousAdminWebDist = process.env.DU_ADMIN_WEB_DIST;
const previousSeedFallback = process.env.DU_SEED_DEV_FALLBACK;
let app: App | undefined;
let publicUrl = '';
let internalUrl = '';
let shellUrl = '';
let receiverUrl = '';
let platform: TestSession;
let tenantScopedAdminA: TestSession;
let tenantlessAdmin: TestSession;
let tenantOperatorA: TestSession;
let tenantOperatorB: TestSession;
let viewerA: TestSession;
let callbackOperationId = '';
let callbackDeliveryId = '';
let callbackPayload: Record<string, unknown> = {};
let settingsApiKeyId = '';
let settingsConnectionId = '';
let settingsProfileId = '';

const expectedCoreEndpoints = [
  'ingest:parse', 'ingest:ocr', 'ingest:digitize', 'ingest:split',
  'extract:invoice', 'extract:contract', 'extract:id-card', 'extract:receipt', 'extract:table', 'extract:custom',
  'analyze:classify', 'analyze:sentiment', 'analyze:compliance', 'analyze:fact-check', 'analyze:quality', 'analyze:risk', 'analyze:summarize-eval',
  'transform:convert', 'transform:translate', 'transform:rewrite', 'transform:redact', 'transform:template',
  'generate:summary', 'generate:outline', 'generate:report', 'generate:email', 'generate:minutes', 'generate:qa',
  'compare:diff', 'compare:semantic', 'compare:version',
];

interface SeedOperation {
  operationId: string;
  taskId: string;
  apiKeyId: string;
}

function id(): string { return randomUUID(); }

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((resolvePromise) => { resolve = resolvePromise; });
  return { promise, resolve };
}

function localDateTimeInput(timestamp: number): string {
  const local = new Date(timestamp - new Date(timestamp).getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

async function seedOperation(input: {
  tenantId: string;
  state?: string;
  action?: string;
  businessId?: string;
}): Promise<SeedOperation> {
  if (!app) throw new Error('ORV13 app is not started');
  const operationId = id();
  const taskId = id();
  const rawKey = `orv13-vfy-key-${id()}`;
  const key = await app.db.query<{ id: string }>(
    'INSERT INTO api_keys (tenant_id,hash,prefix,status) VALUES ($1,$2,$3,\'ACTIVE\') RETURNING id',
    [input.tenantId, createHash('sha256').update(rawKey).digest('hex'), 'orv13-vfy'],
  );
  const apiKeyId = key.rows[0]!.id;
  await app.db.query(
    `INSERT INTO operations (id,tenant_id,api_key_id,business_id,business_version,action,state,state_version,root_task_id,correlation_id,created_at,updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,now(),now())`,
    [operationId, input.tenantId, apiKeyId, input.businessId ?? 'document-core', documentCoreManifest.version, input.action ?? 'extract', input.state ?? 'SUCCEEDED', taskId, `orv13-vfy:${operationId}`],
  );
  await app.db.query(
    `INSERT INTO tasks (id,operation_id,task_key,kind,state,created_at,updated_at)
     VALUES ($1,$2,'root','document-core',$3,now(),now())`,
    [taskId, operationId, input.state === 'RUNNING' ? 'RUNNING' : 'SUCCEEDED'],
  );
  return { operationId, taskId, apiKeyId };
}

async function persistUsageEvent(input: {
  tenantId: string;
  occurredAt: string;
  usage: NonNullable<ConnectorUsageEvent['usage']>;
}): Promise<{ eventId: string; operationId: string; taskId: string }> {
  if (!app) throw new Error('ORV13 app is not started');
  const owner = await seedOperation({ tenantId: input.tenantId });
  const source: ConnectorUsageEvent = {
    eventId: `orv13-vfy-event-${id()}`,
    invocationId: `orv13-vfy-invocation-${id()}`,
    operationId: owner.operationId,
    taskId: owner.taskId,
    usage: input.usage,
    createdAt: input.occurredAt,
  };
  const event = toContractUsageEvent(source);
  const response = await fetch(`${internalUrl}/api/runtime/v1/usage-events`, {
    method: 'POST',
    headers: { authorization: `Bearer ${usageToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [event] }),
  });
  const responseText = await response.text();
  if (response.status !== 200) throw new Error(`ORV13 usage ingest returned ${response.status}: ${responseText}`);
  const stored = await app.db.query<{ payload: Record<string, unknown> }>(
    'SELECT payload FROM usage_events WHERE event_id=$1', [event.eventId],
  );
  if (!stored.rows[0]) throw new Error('ORV13 producer event was acknowledged but is absent from persisted usage_events');
  expect(stored.rows[0].payload).toMatchObject({ eventId: event.eventId, operationId: owner.operationId, taskId: owner.taskId });
  return { eventId: event.eventId, operationId: owner.operationId, taskId: owner.taskId };
}

async function persistLegacyUsageEvent(input: { tenantId: string; occurredAt: string }): Promise<{ eventId: string; operationId: string; taskId: string }> {
  if (!app) throw new Error('ORV13 app is not started');
  const owner = await seedOperation({ tenantId: input.tenantId });
  const eventId = `orv13-vfy-legacy-event-${id()}`;
  const payload = {
    eventId,
    invocationId: `orv13-vfy-legacy-invocation-${id()}`,
    operationId: owner.operationId,
    taskId: owner.taskId,
    units: { inputTokens: 7, outputTokens: 2 },
    currency: 'USD',
    measurement: 'measured',
    occurredAt: input.occurredAt,
  };
  await app.db.query(
    'INSERT INTO usage_events (event_id,operation_id,task_id,payload) VALUES ($1,$2,$3,$4::jsonb)',
    [eventId, owner.operationId, owner.taskId, JSON.stringify(payload)],
  );
  return { eventId, operationId: owner.operationId, taskId: owner.taskId };
}

async function provisionWorkflowFixture(tenantId: string, slug = `orv13-vfy-flow-${id().replaceAll('-', '').slice(0, 12)}`): Promise<{ slug: string; schema: Record<string, unknown> }> {
  const schema: Record<string, unknown> = {
    slug,
    name: 'ORV13 verifier workflow',
    version: 1,
    description: 'Initial verifier workflow description',
    input_schema: { type: 'object', properties: {} },
    nodes: [{ id: 'input', type: 'input', key: 'document' }],
    flow: ['input'],
    output: { from: 'input' },
  };
  const response = await bffAction(platform, 'workflow.provision', { tenantId, schema, expectedRevision: null });
  if (response.status !== 201) throw new Error(`ORV13 workflow fixture returned ${response.status}: ${await response.text()}`);
  return { slug, schema };
}

function sessionCookie(session: TestSession): string {
  return `${SESSION_COOKIE_NAME}=${encodeURIComponent(session.sessionId)}`;
}

async function bffRequest(session: TestSession, path: string, init: RequestInit = {}, includeCsrf = true): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('cookie', sessionCookie(session));
  if (includeCsrf) headers.set('x-csrf-token', session.csrfToken);
  return fetch(`${shellUrl}/admin/api${path}`, { ...init, headers });
}

async function bffAction(session: TestSession, action: string, params: Record<string, unknown>): Promise<Response> {
  return bffRequest(session, '/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `orv13-vfy-${id()}` },
    body: JSON.stringify({ action, params }),
  });
}

function parseJson(response: Response): Promise<Record<string, unknown>> {
  return response.json() as Promise<Record<string, unknown>>;
}

async function attachSession(page: Page, session: TestSession): Promise<void> {
  await page.context().addCookies([{
    name: SESSION_COOKIE_NAME,
    value: session.sessionId,
    url: shellUrl,
    httpOnly: true,
    sameSite: 'Lax',
  }]);
}

async function openBrowser(): Promise<Browser> {
  return chromium.launch({ executablePath: '/usr/bin/chromium', headless: true, args: ['--no-sandbox'] });
}

beforeAll(async () => {
  process.env.DU_ADMIN_WEB = '1';
  process.env.DU_ADMIN_WEB_DIST = resolve('orchestrator/apps/admin-web/dist');
  process.env.DU_SEED_DEV_FALLBACK = 'false';
  await baseDb.query(`CREATE SCHEMA "${isolation.context.dbSchema}"`);
  await new Promise<void>((resolveListen, reject) => {
    receiver.once('error', reject);
    receiver.listen(0, '127.0.0.1', () => resolveListen());
  });
  const receiverAddress = receiver.address() as AddressInfo;
  receiverUrl = `http://callback.fixture.example:${receiverAddress.port}/orv13-callback`;
  platform = await sessions.create({ issuer: 'orv13-vfy', sub: 'platform-admin', role: 'admin' });
  tenantScopedAdminA = await sessions.create({ issuer: 'orv13-vfy', sub: 'tenant-scoped-admin-a', role: 'admin', tenantId: tenantA });
  tenantlessAdmin = await sessions.create({ issuer: 'orv13-vfy', sub: 'tenantless-admin', role: 'admin' });
  tenantOperatorA = await sessions.create({ issuer: 'orv13-vfy', sub: 'tenant-operator-a', role: 'operator', tenantId: tenantA });
  tenantOperatorB = await sessions.create({ issuer: 'orv13-vfy', sub: 'tenant-operator-b', role: 'operator', tenantId: tenantB });
  viewerA = await sessions.create({ issuer: 'orv13-vfy', sub: 'tenant-viewer-a', role: 'viewer', tenantId: tenantA });
  const keyProvider = syntheticMetadataKeyProvider();
  app = await createApp({
    host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort: 0,
    databaseUrl: isolation.databaseUrl, redisUrl: isolation.redisUrl,
    autoMigrate: true, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken, runtimeToken, usageToken,
    tenantAdminTokens: { [tenantAToken]: tenantA, [tenantBToken]: tenantB },
    adminSessionStore: sessions,
    adminShellCookieSecret: cookieSecret, adminShellHost: '127.0.0.1', adminShellPort: 0,
    webhookSecret: browserSecret, webhookDispatchIntervalMs: 3_600_000,
    metadataEncryption: { keyProvider, keyRef: 'orv13-vfy-metadata' },
  });
  const publicServer = await app.listen();
  const publicAddress = publicServer.address();
  const internalAddress = app.internalServer.address();
  if (!publicAddress || typeof publicAddress === 'string' || !internalAddress || typeof internalAddress === 'string') {
    throw new Error('ORV13 app did not bind both actual HTTP listeners');
  }
  publicUrl = `http://127.0.0.1:${publicAddress.port}`;
  internalUrl = `http://127.0.0.1:${internalAddress.port}`;
  shellUrl = app.adminShell!.url;
  const registration = await fetch(`${internalUrl}/api/runtime/v1/businesses/${documentCoreManifest.businessId}/versions/${documentCoreManifest.version}`, {
    method: 'PUT',
    headers: { authorization: `Bearer ${runtimeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify(documentCoreManifest),
  });
  if (![200, 201].includes(registration.status)) throw new Error(`ORV13 document-core registration returned ${registration.status}: ${await registration.text()}`);
  for (const action of ['enable', 'activate']) {
    const response = await fetch(`${internalUrl}/api/v1/admin/businesses/${documentCoreManifest.businessId}/versions/${documentCoreManifest.version}/${action}`, {
      method: 'PUT', headers: { authorization: `Bearer ${adminToken}` },
    });
    if (!(action === 'enable' ? [200] : [200, 202]).includes(response.status)) {
      throw new Error(`ORV13 document-core ${action} returned ${response.status}: ${await response.text()}`);
    }
  }
  await app.db.query('INSERT INTO tenants (id,name,state) VALUES ($1,$2,\'ACTIVE\'),($3,$4,\'ACTIVE\')', [
    tenantA, 'ORV13 tenant alpha', tenantB, 'ORV13 tenant beta',
  ]);
  settingsConnectionId = id();
  const settingsKey = await app.db.query<{ id: string }>(
    'INSERT INTO api_keys (tenant_id,hash,prefix,status) VALUES ($1,$2,$3,\'ACTIVE\') RETURNING id',
    [tenantA, createHash('sha256').update(`orv13-vfy-settings-${id()}`).digest('hex'), 'orv13-vfy-settings'],
  );
  settingsApiKeyId = settingsKey.rows[0]!.id;
  const profileCreate = await bffRequest(platform, '/actions', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': `orv13-vfy-settings-profile-${id()}` },
    body: JSON.stringify({
      action: 'profile.upsert',
      params: {
        apiKey: { apiKeyId: settingsApiKeyId },
        businessId: documentCoreManifest.businessId,
        businessVersion: documentCoreManifest.version,
        profileName: `orv13-vfy-settings-${id()}`,
        action: 'extract',
        endpointSlug: 'extract:invoice',
        policy: {},
      },
    }),
  });
  if (profileCreate.status !== 201) throw new Error(`ORV13 settings profile fixture returned ${profileCreate.status}: ${await profileCreate.text()}`);
  const profileIdentity = await app.db.query<{ profile_id: string }>(
    'SELECT profile_id FROM profile_names WHERE api_key_id=$1 AND tenant_id=$2 ORDER BY profile_name DESC LIMIT 1',
    [settingsApiKeyId, tenantA],
  );
  settingsProfileId = profileIdentity.rows[0]!.profile_id;
  const pinFixture = await app.db.query(
    `UPDATE profile_bindings p SET connector_bindings=$2::jsonb
     FROM profile_active_revisions a WHERE p.profile_id=a.profile_id AND p.revision=a.revision AND p.profile_id=$1`,
    [settingsProfileId, JSON.stringify({ reasoning: { connectorId: settingsConnectionId, revision: 1 } })],
  );
  if (!pinFixture.rowCount) throw new Error('ORV13 settings fixture failed to pin its synthetic prompt connection');
  const callbackOwner = await seedOperation({ tenantId: tenantA, state: 'SUCCEEDED' });
  callbackOperationId = callbackOwner.operationId;
  callbackDeliveryId = id();
  callbackPayload = { operationId: callbackOperationId, state: 'SUCCEEDED', message: 'synthetic callback fixture' };
  await app.db.query(
    `INSERT INTO webhook_deliveries (delivery_id,operation_id,tenant_id,event_type,terminal_state,state_version,destination_url,payload,status,attempts,max_attempts,last_error,callback_policy)
     VALUES ($1,$2,$3,'operation.completed','SUCCEEDED',1,$4,$5::jsonb,'FAILED',4,5,'WEBHOOK_TRANSPORT_FAILED',$6::jsonb)`,
    [callbackDeliveryId, callbackOperationId, tenantA, receiverUrl, JSON.stringify(callbackPayload),
      JSON.stringify({ version: 1, mode: 'notification_only', auth: { method: 'none' } })],
  );
}, 120000);

afterAll(async () => {
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
  await new Promise<void>((resolveClose) => receiver.close(() => resolveClose()));
  await baseDb.query(`DROP SCHEMA "${isolation.context.dbSchema}" CASCADE`).catch(() => undefined);
  await baseDb.close();
  isolation.context.cleanupArtifactDir();
  if (previousAdminWeb === undefined) delete process.env.DU_ADMIN_WEB; else process.env.DU_ADMIN_WEB = previousAdminWeb;
  if (previousAdminWebDist === undefined) delete process.env.DU_ADMIN_WEB_DIST; else process.env.DU_ADMIN_WEB_DIST = previousAdminWebDist;
  if (previousSeedFallback === undefined) delete process.env.DU_SEED_DEV_FALLBACK; else process.env.DU_SEED_DEV_FALLBACK = previousSeedFallback;
}, 30000);

describe('VFY-UI13 real Admin BFF and operator journeys', () => {
  test('BASIC_ADMIN_USAGE_V1 pages persisted producer events and fences tenant/window cursors and roles', async () => {
    const now = Date.now();
    const ownRows = await Promise.all([
      persistUsageEvent({ tenantId: tenantA, occurredAt: new Date(now - 30_000).toISOString(), usage: { inputTokens: 41, outputTokens: 17, pages: 2, costMicrousd: 725, measurement: 'measured', provider: 'orv13-loopback', model: 'priced-v1' } }),
      persistUsageEvent({ tenantId: tenantA, occurredAt: new Date(now - 20_000).toISOString(), usage: { inputTokens: 5, outputTokens: 3, measurement: 'measured' } }),
      persistUsageEvent({ tenantId: tenantA, occurredAt: new Date(now - 10_000).toISOString(), usage: { inputTokens: 2, outputTokens: 1, costMicrousd: 0, measurement: 'measured', provider: 'orv13-loopback' } }),
    ]);
    const legacyRow = await persistLegacyUsageEvent({ tenantId: tenantA, occurredAt: new Date(now - 5_000).toISOString() });
    const foreignRow = await persistUsageEvent({ tenantId: tenantB, occurredAt: new Date(now - 5_000).toISOString(), usage: { inputTokens: 99, outputTokens: 44, costMicrousd: 990, measurement: 'measured', provider: 'foreign-fixture', model: 'foreign-v1' } });
    const from = new Date(now - 60_000).toISOString();
    const to = new Date(now + 10_000).toISOString();
    const query = (tenantId: string, limit: number) => `/usage/events?tenantId=${encodeURIComponent(tenantId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}`;
    const firstResponse = await bffRequest(tenantOperatorA, query(tenantA, 1));
    expect(firstResponse.status).toBe(200);
    const first = await parseJson(firstResponse);
    expect(first).toMatchObject({
      tenantId: tenantA,
      limit: 1,
      hasMore: true,
      skippedInvalidEvents: 0,
      timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' },
    });
    expect(typeof first['nextCursor']).toBe('string');
    const pageOne = Array.isArray(first['events']) ? first['events'] as Array<Record<string, unknown>> : [];
    expect(pageOne).toHaveLength(1);
    expect(pageOne[0]).toEqual(expect.objectContaining({
      eventId: expect.any(String), operationId: expect.any(String), taskId: expect.any(String),
      invocationId: expect.any(String), costStatus: expect.any(String), receivedAt: expect.any(String),
    }));
    expect(Object.keys(pageOne[0]!).sort()).toEqual([
      'costMicrousd', 'costStatus', 'eventId', 'invocationId', 'measurement', 'model', 'occurredAt',
      'operationId', 'provider', 'receivedAt', 'taskId', 'units',
    ].sort());
    const cursor = String(first['nextCursor']);
    const nextUrl = `${query(tenantA, 1)}&cursor=${encodeURIComponent(cursor)}`;
    const secondResponse = await bffRequest(tenantOperatorA, nextUrl);
    expect(secondResponse.status).toBe(200);
    const second = await parseJson(secondResponse);
    expect(second).toMatchObject({ tenantId: tenantA, limit: 1, timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' } });
    const pageTwo = Array.isArray(second['events']) ? second['events'] as Array<Record<string, unknown>> : [];
    expect(pageTwo).toHaveLength(1);
    expect(pageTwo[0]?.['eventId']).not.toBe(pageOne[0]?.['eventId']);
    expect(pageTwo[0]?.['operationId']).not.toBe(foreignRow.operationId);

    const collected = [...pageOne, ...pageTwo];
    let nextCursor = typeof second['nextCursor'] === 'string' ? second['nextCursor'] : null;
    while (nextCursor) {
      const pageResponse = await bffRequest(tenantOperatorA, `${query(tenantA, 1)}&cursor=${encodeURIComponent(nextCursor)}`);
      expect(pageResponse.status).toBe(200);
      const body = await parseJson(pageResponse);
      expect(body).toMatchObject({ tenantId: tenantA, limit: 1, timeSemantics: { field: 'receivedAt', order: 'asc', timezone: 'UTC' } });
      const rows = Array.isArray(body['events']) ? body['events'] as Array<Record<string, unknown>> : [];
      for (const row of rows) {
        expect(row['operationId']).not.toBe(foreignRow.operationId);
        collected.push(row);
      }
      nextCursor = typeof body['nextCursor'] === 'string' ? body['nextCursor'] : null;
    }
    const expectedOwnRows = [...ownRows, legacyRow];
    expect(new Set(collected.map((row) => String(row['eventId'])))).toEqual(new Set(expectedOwnRows.map((row) => row.eventId)));
    expect(new Set(collected.map((row) => String(row['operationId'])))).toEqual(new Set(expectedOwnRows.map((row) => row.operationId)));
    const byEventId = new Map(collected.map((row) => [String(row['eventId']), row]));
    expect(byEventId.get(ownRows[0]!.eventId)).toMatchObject({
      operationId: ownRows[0]!.operationId,
      taskId: ownRows[0]!.taskId,
      provider: 'orv13-loopback',
      model: 'priced-v1',
      units: { inputTokens: 41, outputTokens: 17, pages: 2 },
      costMicrousd: 725,
      costStatus: 'measured',
      measurement: 'measured',
    });
    expect(byEventId.get(ownRows[1]!.eventId)).toMatchObject({
      operationId: ownRows[1]!.operationId,
      provider: null,
      model: null,
      units: { inputTokens: 5, outputTokens: 3 },
      costMicrousd: 0,
      costStatus: 'unpriced',
      measurement: 'measured',
    });
    expect(byEventId.get(ownRows[2]!.eventId)).toMatchObject({
      operationId: ownRows[2]!.operationId,
      provider: 'orv13-loopback',
      model: null,
      costMicrousd: 0,
      costStatus: 'measured',
      measurement: 'measured',
    });
    expect(byEventId.get(legacyRow.eventId)).toMatchObject({
      operationId: legacyRow.operationId,
      taskId: legacyRow.taskId,
      provider: null,
      model: null,
      units: { inputTokens: 7, outputTokens: 2 },
      costMicrousd: null,
      costStatus: null,
      measurement: 'measured',
    });
    for (const row of collected) {
      expect(row).not.toHaveProperty('tenantId');
      expect(row).not.toHaveProperty('provenance');
    }

    const foreignRead = await bffRequest(tenantOperatorA, query(tenantB, 1));
    expect(foreignRead.status).toBe(403);
    const viewerRead = await bffRequest(viewerA, query(tenantA, 1));
    expect(viewerRead.status).toBe(403);
    const wrongTenantCursor = await bffRequest(platform, `${query(tenantB, 1)}&cursor=${encodeURIComponent(cursor)}`);
    expect(wrongTenantCursor.status).toBe(422);
    const wrongWindowCursor = await bffRequest(platform, `/usage/events?tenantId=${tenantA}&from=${encodeURIComponent(new Date(now - 120_000).toISOString())}&to=${encodeURIComponent(to)}&limit=1&cursor=${encodeURIComponent(cursor)}`);
    expect(wrongWindowCursor.status).toBe(422);
    const repeatedParameter = await bffRequest(tenantOperatorA, `${query(tenantA, 1)}&limit=2`);
    expect(repeatedParameter.status).toBe(422);
    const internalQuery = new URLSearchParams({ tenantId: tenantA, from, to, limit: '1' });
    const internalUnauthenticated = await fetch(`${internalUrl}/api/internal/usage/events?${internalQuery}`);
    expect(internalUnauthenticated.status).toBe(401);
    const internalForeignQuery = new URLSearchParams({ tenantId: tenantB, from, to, limit: '1' });
    const internalForeignRead = await fetch(`${internalUrl}/api/internal/usage/events?${internalForeignQuery}`, {
      headers: { cookie: sessionCookie(tenantOperatorA) },
    });
    expect(internalForeignRead.status).toBe(403);
    const internalOwnRead = await fetch(`${internalUrl}/api/internal/usage/events?${internalQuery}`, {
      headers: { cookie: sessionCookie(tenantOperatorA) },
    });
    expect(internalOwnRead.status).toBe(200);
    expect(await parseJson(internalOwnRead)).toMatchObject({ tenantId: tenantA, limit: 1, hasMore: true });
    const scopedAdminForeignRead = await fetch(`${internalUrl}/api/internal/usage/events?${internalForeignQuery}`, {
      headers: { cookie: sessionCookie(tenantScopedAdminA) },
    });
    expect(scopedAdminForeignRead.status).toBe(403);
    const scopedAdminOwnRead = await fetch(`${internalUrl}/api/internal/usage/events?${internalQuery}`, {
      headers: { cookie: sessionCookie(tenantScopedAdminA) },
    });
    expect(scopedAdminOwnRead.status).toBe(200);
    const internalViewerOwnRead = await fetch(`${internalUrl}/api/internal/usage/events?${internalQuery}`, {
      headers: { cookie: sessionCookie(viewerA) },
    });
    expect(internalViewerOwnRead.status).toBe(200);
    const tenantlessAdminRead = await fetch(`${internalUrl}/api/internal/usage/events?${internalQuery}`, {
      headers: { cookie: sessionCookie(tenantlessAdmin) },
    });
    expect(tenantlessAdminRead.status).toBe(403);
    expect(JSON.stringify(collected)).not.toContain('foreign-fixture');
  }, 30000);

  test('BASIC_ADMIN_USAGE_V1 counts malformed persisted rows without failing the page', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const owner = await seedOperation({ tenantId: tenantA });
    const now = Date.now();
    const nonIsoOccurredAt = new Date(now).toUTCString();
    expect(Number.isFinite(Date.parse(nonIsoOccurredAt))).toBe(true);
    expect(nonIsoOccurredAt).not.toBe(new Date(now).toISOString());
    const rows = [
      {
        eventId: `orv13-vfy-${'x'.repeat(129)}`,
        invocationId: `orv13-vfy-inv-${id()}`,
        operationId: owner.operationId,
        taskId: owner.taskId,
        units: { inputTokens: 1, outputTokens: 2 }, currency: 'USD', measurement: 'measured', occurredAt: new Date(now).toISOString(),
      },
      {
        eventId: `orv13-vfy-event-${id()}`,
        invocationId: `orv13-vfy-inv-${id()}`,
        operationId: owner.operationId,
        taskId: owner.taskId,
        units: { inputTokens: 1, outputTokens: 2 }, currency: 'USD', measurement: 'measured',
        provider: 'invalid provider id', model: 'model-v1', occurredAt: new Date(now).toISOString(),
      },
      {
        eventId: `orv13-vfy-event-${id()}`,
        invocationId: `orv13-vfy-inv-${id()}`,
        operationId: owner.operationId,
        taskId: owner.taskId,
        units: { inputTokens: 1, outputTokens: 2 }, currency: 'USD', measurement: 'measured', occurredAt: nonIsoOccurredAt,
      },
    ];
    for (const row of rows) {
      await app.db.query(
        'INSERT INTO usage_events (event_id,operation_id,task_id,payload) VALUES ($1,$2,$3,$4::jsonb)',
        [row.eventId, row.operationId, row.taskId, JSON.stringify(row)],
      );
    }

    const from = new Date(now - 10_000).toISOString();
    const to = new Date(now + 10_000).toISOString();
    const response = await bffRequest(tenantOperatorA,
      `/usage/events?tenantId=${tenantA}&operationId=${encodeURIComponent(owner.operationId)}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=10`);
    expect(response.status).toBe(200);
    const page = await parseJson(response);
    expect(page).toMatchObject({ tenantId: tenantA, hasMore: false, skippedInvalidEvents: 3, events: [] });
  }, 30000);

  test('BASIC_ADMIN_USAGE_V1 cursor advances over a malformed row at PostgreSQL microsecond precision', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const owner = await seedOperation({ tenantId: tenantA });
    const baseSecond = new Date(Date.now() - 60_000).toISOString().slice(0, 19);
    const receivedAt = [1, 2, 3].map((microseconds) => `${baseSecond}.${String(microseconds).padStart(6, '0')}Z`);
    const eventIds = [
      `orv13-vfy-invalid-${'x'.repeat(130)}`,
      `orv13-vfy-microsecond-valid-${id()}`,
      `orv13-vfy-microsecond-valid-${id()}`,
    ];
    for (let index = 0; index < eventIds.length; index++) {
      const eventId = eventIds[index]!;
      const payload = {
        eventId,
        invocationId: `orv13-vfy-microsecond-inv-${index}-${id()}`,
        operationId: owner.operationId,
        taskId: owner.taskId,
        units: { inputTokens: index + 1, outputTokens: 2 },
        currency: 'USD',
        measurement: 'measured',
        occurredAt: new Date().toISOString(),
      };
      await app.db.query(
        'INSERT INTO usage_events (event_id,operation_id,task_id,payload) VALUES ($1,$2,$3,$4::jsonb)',
        [eventId, owner.operationId, owner.taskId, JSON.stringify(payload)],
      );
      await app.db.query('UPDATE usage_events SET received_at=$2::timestamptz WHERE event_id=$1', [eventId, receivedAt[index]]);
    }

    const from = new Date(Date.now() - 120_000).toISOString();
    const to = new Date(Date.now() + 10_000).toISOString();
    const query = `/usage/events?tenantId=${tenantA}&operationId=${owner.operationId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=1`;
    const pages: Array<Record<string, unknown>> = [];
    let cursor: string | null = null;
    for (let index = 0; index < 3; index++) {
      const response = await bffRequest(tenantOperatorA, `${query}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`);
      expect(response.status).toBe(200);
      const page = await parseJson(response);
      pages.push(page);
      cursor = typeof page['nextCursor'] === 'string' ? page['nextCursor'] : null;
    }
    const firstCursor = String(pages[0]?.['nextCursor']);
    const decodedCursor = JSON.parse(Buffer.from(firstCursor, 'base64url').toString('utf8')) as Record<string, unknown>;
    const pageRows = pages.map((page) => Array.isArray(page['events']) ? page['events'] as Array<Record<string, unknown>> : []);
    expect(decodedCursor['after']).toBe(receivedAt[0]);
    expect(pages[0]).toMatchObject({ hasMore: true, skippedInvalidEvents: 1, events: [] });
    expect(pages[1]).toMatchObject({ hasMore: true, skippedInvalidEvents: 0 });
    expect(pages[2]).toMatchObject({ hasMore: false, skippedInvalidEvents: 0 });
    expect(pageRows.map((rows) => rows.map((row) => row['eventId']))).toEqual([[], [eventIds[1]], [eventIds[2]]]);
    expect(cursor).toBeNull();
    writeFileSync(resolve('reports/raw/orv13-vfy/admin-ui/usage-microsecond-pagination.json'), JSON.stringify({
      test: 'VFY-UI13 BASIC_ADMIN_USAGE_V1 malformed→valid limit=1 keyset progression',
      operationId: owner.operationId,
      receivedAt,
      eventIds,
      cursorAfterFirstScan: decodedCursor['after'],
      pages: pages.map(({ events, hasMore, skippedInvalidEvents }) => ({ events, hasMore, skippedInvalidEvents })),
      exhausted: cursor === null,
    }, null, 2));
  }, 30000);

  test('settings revision writes are role-gated at the real BFF before any revision row is created', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const before = await app.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3',
      [tenantA, settingsApiKeyId, 'extract:invoice'],
    );
    const response = await bffAction(tenantOperatorA, 'settings.revision.create', {
      tenantId: tenantA,
      apiKeyId: settingsApiKeyId,
      endpointSlug: 'extract:invoice',
      expectedActiveRevision: null,
      changes: { prompts: [{ connectionId: settingsConnectionId, stepId: '_default', promptOverride: 'operator must not write' }] },
    });
    expect(response.status).toBe(403);
    const after = await app.db.query<{ count: number }>(
      'SELECT count(*)::int AS count FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3',
      [tenantA, settingsApiKeyId, 'extract:invoice'],
    );
    expect(after.rows[0]?.count).toBe(before.rows[0]?.count);
  }, 30000);

  test('operation DELETE requires CSRF, terminal state and tenant scope through the actual BFF', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const ownTerminal = await seedOperation({ tenantId: tenantA, state: 'SUCCEEDED' });
    const foreignTerminal = await seedOperation({ tenantId: tenantB, state: 'SUCCEEDED' });
    const liveOperation = await seedOperation({ tenantId: tenantA, state: 'RUNNING' });
    const state = async (operationId: string) => (await app!.db.query<{ deleted_at: string | null }>(
      'SELECT deleted_at FROM operations WHERE id=$1', [operationId],
    )).rows[0]?.deleted_at ?? null;
    const missingCsrf = await bffRequest(tenantOperatorA, `/operations/${ownTerminal.operationId}`, { method: 'DELETE' }, false);
    expect(missingCsrf.status).toBe(403);
    expect(await state(ownTerminal.operationId)).toBeNull();
    const viewerDelete = await bffRequest(viewerA, `/operations/${ownTerminal.operationId}`, { method: 'DELETE' });
    expect(viewerDelete.status).toBe(403);
    const crossTenantDelete = await bffRequest(tenantOperatorA, `/operations/${foreignTerminal.operationId}`, { method: 'DELETE' });
    expect(crossTenantDelete.status).toBe(404);
    expect(await state(foreignTerminal.operationId)).toBeNull();
    const liveDelete = await bffRequest(tenantOperatorA, `/operations/${liveOperation.operationId}`, { method: 'DELETE' });
    expect(liveDelete.status).toBe(409);
    expect(await state(liveOperation.operationId)).toBeNull();
    const deleted = await bffRequest(tenantOperatorA, `/operations/${ownTerminal.operationId}`, { method: 'DELETE' });
    expect(deleted.status).toBe(200);
    expect(await state(ownTerminal.operationId)).not.toBeNull();
    const audit = await app.db.query<{ count: number }>(
      `SELECT count(*)::int AS count FROM admin_audit_events WHERE action='operation.delete' AND resource=$1`,
      [`operation:${ownTerminal.operationId}`],
    );
    expect(audit.rows[0]?.count).toBe(1);
  }, 30000);

  test('mounted tenant roster retries truthfully and selects a persisted tenant beyond the first real BFF page', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const dir = resolve('reports/raw/orv13-vfy/admin-ui');
    mkdirSync(dir, { recursive: true });
    const rosterCount = 125;
    const rosterIds = Array.from({ length: rosterCount }, () => id());
    const rosterNames = Array.from({ length: rosterCount }, (_, index) => `zzzz ORV13 VFY roster ${index.toString().padStart(3, '0')}`);
    const rosterStates = Array.from({ length: rosterCount }, () => 'ACTIVE');
    await app.db.query(
      `INSERT INTO tenants (id,name,state)
       SELECT fixture.id,fixture.name,fixture.state
       FROM unnest($1::uuid[],$2::text[],$3::text[]) AS fixture(id,name,state)`,
      [rosterIds, rosterNames, rosterStates],
    );
    const targetTenantId = rosterIds[rosterIds.length - 1]!;
    const targetTenantName = rosterNames[rosterNames.length - 1]!;
    const usageFixture = await persistUsageEvent({
      tenantId: targetTenantId,
      occurredAt: new Date(Date.now() - 120_000).toISOString(),
      usage: { inputTokens: 73, outputTokens: 19, costMicrousd: 0, measurement: 'measured', provider: 'roster-scope-fixture', model: 'page-two-selection' },
    });
    await app.db.query("UPDATE usage_events SET received_at=now() - interval '2 minutes' WHERE event_id=$1", [usageFixture.eventId]);

    const browser = await openBrowser();
    const injectedProblemTitle = 'Synthetic roster endpoint outage for retry verification';
    const rosterResponses: Array<{ url: string; status: number; source: string; body: Record<string, unknown> }> = [];
    const usageRequests: Array<{ url: string; status: number; body: Record<string, unknown> }> = [];
    const pendingResponseBodies: Promise<void>[] = [];
    const loadedScripts: Array<{ url: string; status: number; sha256: string }> = [];
    let injectedUrl: string | null = null;
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      context.setDefaultTimeout(20000);
      const page = await context.newPage();
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.pathname.endsWith('/admin/api/tenants')) {
          const pending = response.json().then((body: Record<string, unknown>) => {
            rosterResponses.push({
              url: response.url(),
              status: response.status(),
              source: response.url() === injectedUrl && response.status() === 503 ? 'single injected transient failure' : 'actual mounted Admin BFF response',
              body,
            });
          });
          pendingResponseBodies.push(pending);
        }
        if (url.pathname.endsWith('/admin/api/usage/events')) {
          const pending = response.json().then((body: Record<string, unknown>) => usageRequests.push({ url: response.url(), status: response.status(), body }));
          pendingResponseBodies.push(pending);
        }
        if (url.pathname.endsWith('/admin/assets/index-BO7-bJEd.js') && response.status() === 200) {
          const pending = response.body().then((body) => {
            loadedScripts.push({ url: response.url(), status: response.status(), sha256: createHash('sha256').update(body).digest('hex') });
          });
          pendingResponseBodies.push(pending);
        }
      });
      await page.route('**/admin/api/tenants**', async (route) => {
        if (injectedUrl === null) {
          injectedUrl = route.request().url();
          await route.fulfill({
            status: 503,
            contentType: 'application/problem+json',
            body: JSON.stringify({ type: 'about:blank', title: injectedProblemTitle, status: 503, code: 'UPSTREAM_UNAVAILABLE' }),
          });
          return;
        }
        await route.continue();
      });
      await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), targetTenantId);
      await attachSession(page, platform);
      await page.goto(`${shellUrl}/admin/usage`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('alert').filter({ hasText: injectedProblemTitle }).waitFor();
      expect(await page.locator('#global-tenant-select').count()).toBe(0);
      expect(await page.getByText('No tenants available', { exact: true }).count()).toBe(0);
      await page.screenshot({ path: resolve(dir, 'tenant-roster-retryable-error-desktop-1440.png'), fullPage: true });

      await page.getByRole('button', { name: 'Retry tenant roster', exact: true }).click();
      await page.waitForFunction((tenantId) => (document.querySelector('#global-tenant-select') as HTMLSelectElement | null)?.value === tenantId, targetTenantId);
      await Promise.all(pendingResponseBodies);

      const actualRosterPages = rosterResponses.filter((response) => response.source === 'actual mounted Admin BFF response');
      const pageItems = actualRosterPages.flatMap((response) => Array.isArray(response.body['items']) ? response.body['items'] as Array<Record<string, unknown>> : []);
      const firstPage = actualRosterPages[0];
      const actualPageQueries = actualRosterPages.map((response) => {
        const query = new URL(response.url).searchParams;
        return { limit: query.get('limit'), cursorPresent: query.has('cursor'), status: response.status, rows: Array.isArray(response.body['items']) ? response.body['items'].length : 0, total: response.body['total'] };
      });
      expect(rosterResponses.some((response) => response.status === 503 && response.source === 'single injected transient failure')).toBe(true);
      expect(injectedUrl).not.toBeNull();
      expect(actualRosterPages.length).toBeGreaterThanOrEqual(2);
      expect(firstPage?.status).toBe(200);
      expect(firstPage && Array.isArray(firstPage.body['items']) ? firstPage.body['items'].length : 0).toBe(100);
      expect(actualPageQueries[0]).toMatchObject({ limit: '100', cursorPresent: false, status: 200, rows: 100 });
      expect(actualPageQueries[1]).toMatchObject({ limit: '100', cursorPresent: true, status: 200 });
      expect(Number(firstPage?.body['total'] ?? 0)).toBeGreaterThanOrEqual(rosterCount + 2);
      const targetIndex = pageItems.findIndex((item) => item['id'] === targetTenantId);
      expect(targetIndex).toBeGreaterThanOrEqual(100);
      expect(pageItems.map((item) => item['id'])).toHaveLength(new Set(pageItems.map((item) => item['id'])).size);
      expect(await page.locator('#global-tenant-select').inputValue()).toBe(targetTenantId);
      expect(await page.locator('#global-tenant-select option:checked').textContent()).toBe(targetTenantName);
      expect(await page.evaluate(() => localStorage.getItem('du_global_tenant_id'))).toBe(targetTenantId);

      const usageRequestStart = usageRequests.length;
      await page.locator('#global-tenant-select').selectOption(tenantA);
      await page.waitForFunction((tenantId) => (document.querySelector('#global-tenant-select') as HTMLSelectElement | null)?.value === tenantId, tenantA);
      await page.getByText('No usage events', { exact: true }).waitFor();
      await page.locator('#global-tenant-select').selectOption(targetTenantId);
      await page.waitForFunction((tenantId) => (document.querySelector('#global-tenant-select') as HTMLSelectElement | null)?.value === tenantId, targetTenantId);
      await page.getByText(usageFixture.eventId, { exact: true }).waitFor();
      await Promise.all(pendingResponseBodies);
      expect(await page.locator('#global-tenant-select').inputValue()).toBe(targetTenantId);
      expect(await page.evaluate(() => localStorage.getItem('du_global_tenant_id'))).toBe(targetTenantId);

      const scopedUsageResponses = usageRequests.slice(usageRequestStart).filter((request) => request.status === 200);
      const tenantAUsage = scopedUsageResponses.filter((request) => new URL(request.url).searchParams.get('tenantId') === tenantA);
      const matchingUsage = scopedUsageResponses.filter((request) => {
        const query = new URL(request.url).searchParams;
        const events = Array.isArray(request.body['events']) ? request.body['events'] as Array<Record<string, unknown>> : [];
        return query.get('tenantId') === targetTenantId && request.body['tenantId'] === targetTenantId && events.some((event) => event['eventId'] === usageFixture.eventId);
      });
      expect(tenantAUsage.length).toBeGreaterThan(0);
      expect(tenantAUsage.every((request) => !(request.body['events'] as Array<Record<string, unknown>>).some((event) => event['eventId'] === usageFixture.eventId))).toBe(true);
      expect(matchingUsage.length).toBeGreaterThan(0);
      const bundleScript = loadedScripts.find((script) => script.status === 200);
      expect(bundleScript?.sha256).toBe('8e55dd6148ae91b2c18e38c4a4176742e574894bbadb36a407ce0f9ddc7c3e6a');
      await page.screenshot({ path: resolve(dir, 'tenant-roster-page-two-usage-scope-desktop-1440.png'), fullPage: true });
      writeFileSync(resolve(dir, 'tenant-roster-pagination-browser.json'), JSON.stringify({
        test: 'VFY-UI13 incremental mounted platform tenant roster: retryable load error, actual BFF cursor pagination, persisted page-two selection and usage tenant fence',
        injectedFailure: { url: injectedUrl, status: 503, title: injectedProblemTitle, emptyFallbackRendered: false, retryControlVisible: true },
        actualRosterPages: actualPageQueries,
        actualRosterTotal: firstPage?.body['total'],
        fixtureTenantRows: rosterCount,
        selectedTenant: { id: targetTenantId, name: targetTenantName, indexAcrossReturnedPages: targetIndex, beyondFirstPage: targetIndex >= 100, localStoragePersisted: true },
        usageEventId: usageFixture.eventId,
        otherTenantScopeResponse: tenantAUsage.map((request) => ({ tenantId: new URL(request.url).searchParams.get('tenantId'), status: request.status, returnedEventIds: (request.body['events'] as Array<Record<string, unknown>>).map((event) => event['eventId']) })),
        usageScopeRequest: matchingUsage.map((request) => ({ url: request.url, status: request.status, tenantId: new URL(request.url).searchParams.get('tenantId'), returnedEventIds: (request.body['events'] as Array<Record<string, unknown>>).map((event) => event['eventId']) })),
        loadedScript: bundleScript,
        shellUrl,
        publicUrl,
        internalUrl,
      }, null, 2));
      await context.close();
    } finally {
      await browser.close();
    }
  }, 120000);

  test('mounted Usage fences a late tenant response, keeps invalid draft unapplied, and exposes real RBAC denial', async () => {
    const browserEventA = await persistUsageEvent({
      tenantId: tenantA,
      occurredAt: new Date().toISOString(),
      usage: { inputTokens: 811, outputTokens: 127, costMicrousd: 811, measurement: 'measured', provider: 'race-fixture', model: 'tenant-a' },
    });
    const browserEventB = await persistUsageEvent({
      tenantId: tenantB,
      occurredAt: new Date().toISOString(),
      usage: { inputTokens: 922, outputTokens: 228, costMicrousd: 922, measurement: 'measured', provider: 'race-fixture', model: 'tenant-b' },
    });
    await app?.db.query(
      `UPDATE usage_events SET received_at=now() - interval '2 minutes'
       WHERE event_id = ANY($1::text[])`,
      [[browserEventA.eventId, browserEventB.eventId]],
    );
    const browser = await openBrowser();
    const dir = resolve('reports/raw/orv13-vfy/admin-ui');
    mkdirSync(dir, { recursive: true });
    const staleRequestPaused = deferred<void>();
    const releaseStaleRequest = deferred<void>();
    let pausedTenantA = false;
    let page: Page | null = null;
    const usageResponses: Array<{ url: string; tenantId: string | null; status: number; body: unknown }> = [];
    const usageRequestUrls: string[] = [];
    const loadedScripts = new Map<string, string>();
    const viewportMetrics: Array<{ viewport: number; scrollWidth: number; tableClientWidth: number; tableScrollWidth: number }> = [];
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      context.setDefaultTimeout(15000);
      page = await context.newPage();
      await attachSession(page, platform);
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/admin/api/usage/events') usageRequestUrls.push(request.url());
      });
      await page.route('**/admin/api/usage/events**', async (route) => {
        const url = new URL(route.request().url());
        if (!pausedTenantA && url.searchParams.get('tenantId') === tenantA) {
          pausedTenantA = true;
          const actualBffResponse = await route.fetch();
          staleRequestPaused.resolve();
          await releaseStaleRequest.promise;
          await route.fulfill({ response: actualBffResponse });
          return;
        }
        await route.continue();
      });
      page.on('response', async (response) => {
        const responseUrl = new URL(response.url());
        if (responseUrl.pathname === '/admin/api/usage/events') {
          usageResponses.push({
            url: response.url(),
            tenantId: responseUrl.searchParams.get('tenantId'),
            status: response.status(),
            body: await response.json().catch(() => null),
          });
        }
        const assetPath = new URL(response.url()).pathname;
        if (!/\/assets\/index-[^/]+\.js$/.test(assetPath) || response.status() !== 200) return;
        const bytes = await response.body().catch(() => null);
        if (bytes !== null) loadedScripts.set(assetPath, createHash('sha256').update(bytes).digest('hex'));
      });
      const shellSessionResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === '/admin/api/session' && response.request().method() === 'GET',
      );
      await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      await page.goto(`${shellUrl}/admin/usage`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Usage & Cost', exact: true }).waitFor();
      const sessionResponse = await shellSessionResponse;
      expect(sessionResponse.status()).toBe(200);
      const shellSession = await sessionResponse.json() as Record<string, unknown>;
      expect(shellSession).toMatchObject({
        role: 'admin',
        principal: { kind: 'platform', tenantId: null },
        scope: { kind: 'platform' },
      });
      await page.getByRole('link', { name: 'Health details', exact: true }).waitFor();
      await staleRequestPaused.promise;

      await page.locator('#usage-from').fill(localDateTimeInput(Date.now() + 60 * 60_000));
      await page.locator('#usage-to').fill(localDateTimeInput(Date.now()));
      await page.getByRole('button', { name: 'Apply filters', exact: true }).click();
      await page.getByRole('alert').filter({ hasText: 'The start time must be before the end time.' }).waitFor();
      expect(await page.locator('#usage-to').inputValue()).not.toBe(await page.locator('#usage-from').inputValue());
      await page.getByRole('button', { name: 'Clear filters', exact: true }).click();

      await page.locator('#global-tenant-select').selectOption(tenantB);
      await page.getByText(browserEventB.eventId, { exact: true }).waitFor();
      expect(await page.getByText(browserEventA.eventId, { exact: true }).count()).toBe(0);
      expect(await page.getByRole('link', { name: `Open operation ${browserEventB.operationId} in Operations`, exact: true }).count()).toBe(1);
      expect(await page.getByText('Model unavailable', { exact: true }).count()).toBe(0);
      await releaseStaleRequest.resolve();
      await page.waitForTimeout(250);
      expect(await page.getByText(browserEventA.eventId, { exact: true }).count()).toBe(0);
      expect(await page.getByText(browserEventB.eventId, { exact: true }).count()).toBe(1);

      await page.screenshot({ path: resolve(dir, 'usage-tenant-b-desktop-1440.png'), fullPage: true });
      const widths = [768, 390, 320];
      for (const width of widths) {
        await page.setViewportSize({ width, height: 844 });
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        const tableMetrics = await page.getByRole('table', { name: 'Usage event ledger', exact: true }).evaluate((table) => {
          const wrapper = table.parentElement;
          return {
            clientWidth: wrapper?.clientWidth ?? 0,
            scrollWidth: wrapper?.scrollWidth ?? 0,
            overflowX: wrapper ? getComputedStyle(wrapper).overflowX : 'missing',
          };
        });
        expect(scrollWidth).toBeLessThanOrEqual(width);
        expect(tableMetrics.overflowX).toMatch(/auto|scroll/);
        expect(tableMetrics.scrollWidth).toBeGreaterThan(tableMetrics.clientWidth);
        viewportMetrics.push({ viewport: width, scrollWidth, tableClientWidth: tableMetrics.clientWidth, tableScrollWidth: tableMetrics.scrollWidth });
        if (width === 320) await page.screenshot({ path: resolve(dir, 'usage-tenant-b-mobile-320.png'), fullPage: true });
      }
      const keyboardPage = await context.newPage();
      await attachSession(keyboardPage, platform);
      await keyboardPage.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantB);
      await keyboardPage.goto(`${shellUrl}/admin/usage`, { waitUntil: 'domcontentloaded' });
      await keyboardPage.getByRole('heading', { name: 'Usage & Cost', exact: true }).waitFor();
      await keyboardPage.setViewportSize({ width: 320, height: 844 });
      await keyboardPage.keyboard.press('Tab');
      expect(await keyboardPage.evaluate(() => (document.activeElement as HTMLElement | null)?.textContent?.trim())).toBe('Skip to content');
      await keyboardPage.keyboard.press('Enter');
      expect(await keyboardPage.evaluate(() => document.activeElement?.id)).toBe('admin-content');
      const ledgerRegion = keyboardPage.getByRole('region', { name: 'Usage event ledger table', exact: true });
      await ledgerRegion.focus();
      expect(await ledgerRegion.evaluate((region) => document.activeElement === region)).toBe(true);
      const navToggle = keyboardPage.getByRole('button', { name: 'Open navigation', exact: true });
      await navToggle.focus();
      await keyboardPage.keyboard.press('Enter');
      await keyboardPage.getByRole('link', { name: 'Usage', exact: true }).focus();
      await keyboardPage.keyboard.press('Enter');
      await keyboardPage.waitForURL(/\/admin\/usage$/);
      expect(await keyboardPage.getByText(browserEventB.eventId, { exact: true }).count()).toBe(1);

      const viewerContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      viewerContext.setDefaultTimeout(15000);
      const viewerPage = await viewerContext.newPage();
      await attachSession(viewerPage, viewerA);
      await viewerPage.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      const deniedResponse = viewerPage.waitForResponse((response) =>
        response.url().includes('/admin/api/usage/events') && response.status() === 403,
      );
      await viewerPage.goto(`${shellUrl}/admin/usage`, { waitUntil: 'domcontentloaded' });
      await deniedResponse;
      await viewerPage.getByRole('heading', { name: 'Access denied', exact: true }).first().waitFor();
      expect(await viewerPage.getByText(browserEventA.eventId, { exact: true }).count()).toBe(0);
      await viewerPage.screenshot({ path: resolve(dir, 'usage-viewer-denied-mobile-390.png'), fullPage: true });

      const scripts = [...loadedScripts].map(([path, sha256]) => ({ path, sha256 }));
      expect(scripts.length).toBeGreaterThan(0);
      writeFileSync(resolve(dir, 'usage-browser.json'), JSON.stringify({
        test: 'VFY-UI13 AOPS-J03 real tenant/window race + viewer RBAC denial',
        delayedBffResponse: { path: '/admin/api/usage/events', tenantId: tenantA, responseOrigin: 'actual mounted Admin BFF', releasedAfterTenantBRendered: true },
        tenantBEvent: browserEventB.eventId,
        tenantAEventNeverRenderedAfterSwitch: browserEventA.eventId,
        requestUrls: usageRequestUrls,
        actualResponses: usageResponses.map((response) => ({
          tenantId: response.tenantId,
          status: response.status,
          eventIds: ((response.body as { events?: Array<{ eventId?: string }> } | null)?.events ?? []).map((event) => event.eventId),
        })),
        fixtureReceivedAtRows: (await app?.db.query<{ event_id: string; received_at: string }>(
          `SELECT event_id,received_at::text FROM usage_events WHERE event_id = ANY($1::text[]) ORDER BY event_id`,
          [[browserEventA.eventId, browserEventB.eventId]],
        ))?.rows,
        invalidWindow: 'The start time must be before the end time.',
        actualBffViewer403: true,
        initialMountedSession: { status: sessionResponse.status(), role: shellSession['role'], principal: shellSession['principal'], scope: shellSession['scope'], platformHealthDetailsVisible: true },
        keyboard: { skipLink: 'Enter', focusedMain: 'admin-content', ledgerRegionFocusable: true, usageNav: 'Enter' },
        viewportMetrics,
        loadedScripts: scripts,
        shellUrl,
        publicUrl,
        internalUrl,
      }, null, 2));
      await viewerContext.close();
      await context.close();
    } finally {
      releaseStaleRequest.resolve();
      writeFileSync(resolve(dir, 'usage-ui-race-diagnostics.json'), JSON.stringify({
        pausedTenantA,
        usageRequestUrls,
        usageResponses,
        persistedFixtureRows: (await app?.db.query(
          `SELECT ue.event_id, ue.operation_id, ue.task_id, ue.received_at, o.tenant_id, ue.payload
           FROM usage_events ue JOIN operations o ON o.id=ue.operation_id
           WHERE ue.event_id = ANY($1::text[])`,
          [[browserEventA.eventId, browserEventB.eventId]],
        ))?.rows,
        selectedTenant: await page?.locator('#global-tenant-select').inputValue().catch(() => null),
        renderedUsageText: (await page?.locator('main').innerText().catch(() => ''))?.slice(0, 12000),
      }, null, 2));
      await browser.close();
    }
  }, 120000);

  test('mounted Settings exposes the exact core endpoint set and preserves a validated draft after an apply conflict', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const browser = await openBrowser();
    const dir = resolve('reports/raw/orv13-vfy/admin-ui');
    mkdirSync(dir, { recursive: true });
    const loadedScripts = new Map<string, string>();
    const scope = { tenantId: tenantA, apiKeyId: settingsApiKeyId, endpointSlug: 'extract:invoice' };
    let draftRevision = 0;
    let competitorRevision = 0;
    const viewportMetrics: Array<{ viewport: number; scrollWidth: number }> = [];
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      context.setDefaultTimeout(15000);
      const page = await context.newPage();
      await attachSession(page, platform);
      page.on('response', async (response) => {
        const assetPath = new URL(response.url()).pathname;
        if (!/\/assets\/index-[^/]+\.js$/.test(assetPath) || response.status() !== 200) return;
        const bytes = await response.body().catch(() => null);
        if (bytes !== null) loadedScripts.set(assetPath, createHash('sha256').update(bytes).digest('hex'));
      });
      await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      await page.goto(`${shellUrl}/admin/settings`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Settings & Deployment', exact: true }).waitFor();
      const tenantSelect = page.locator('#global-tenant-select');
      await tenantSelect.selectOption(tenantA);
      const endpointSelect = page.locator('#settings-endpoint');
      await endpointSelect.waitFor();
      const endpointValues = await endpointSelect.locator('option').evaluateAll((options) =>
        options.filter((option) => (option as HTMLOptionElement).value !== '').map((option) => (option as HTMLOptionElement).value),
      );
      expect(endpointValues).toHaveLength(31);
      expect(endpointValues).toEqual(expectedCoreEndpoints);

      const keySelect = page.locator('#settings-api-key');
      await page.waitForFunction((apiKeyId) => Array.from(document.querySelectorAll('#settings-api-key option')).some((option) => (option as HTMLOptionElement).value === apiKeyId), settingsApiKeyId);
      await keySelect.selectOption(settingsApiKeyId);
      await endpointSelect.selectOption('extract:invoice');
      await page.getByRole('button', { name: 'Load current configuration', exact: true }).click();
      await page.locator(`#settings-prompt-target option[value="${settingsConnectionId}"]`).waitFor({ state: 'attached' });
      await page.getByText(`Effective profile ${settingsProfileId}`, { exact: false }).waitFor();

      await page.locator('#settings-prompt-target').selectOption(settingsConnectionId);
      await page.locator('#settings-prompt').fill('VFY-UI13 draft text that must remain visible after a conflict');
      const createDraft = page.getByRole('button', { name: 'Create configuration draft', exact: true });
      expect(await createDraft.isEnabled()).toBe(true);
      await createDraft.click();
      const draftHeading = page.getByRole('heading', { name: /^Revision \d+$/ });
      await draftHeading.waitFor();
      draftRevision = Number((await draftHeading.innerText()).replace('Revision ', ''));
      expect(draftRevision).toBeGreaterThan(0);
      await page.getByRole('button', { name: 'Validate configuration', exact: true }).click();
      await page.getByText('Configuration validation passed', { exact: true }).waitFor();
      await page.getByText('VFY-UI13 draft text that must remain visible after a conflict', { exact: true }).waitFor();

      const competitorCreated = await bffAction(platform, 'settings.revision.create', {
        ...scope,
        expectedActiveRevision: null,
        expectedProfileRevision: 1,
        changes: { prompts: [{ connectionId: settingsConnectionId, stepId: '_default', promptOverride: 'competing independently applied revision' }] },
      });
      expect([200, 201]).toContain(competitorCreated.status);
      const revisions = await app.db.query<{ stream_id: string; revision: number }>(
        'SELECT stream_id,revision FROM settings_revisions WHERE stream_id=(SELECT id FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3) ORDER BY revision',
        [tenantA, settingsApiKeyId, 'extract:invoice'],
      );
      competitorRevision = Number(revisions.rows.at(-1)?.revision);
      expect(competitorRevision).toBeGreaterThan(draftRevision);
      expect((await bffAction(platform, 'settings.revision.validate', { ...scope, revision: competitorRevision })).status).toBe(200);
      expect((await bffAction(platform, 'settings.revision.apply', {
        ...scope, revision: competitorRevision, expectedActiveRevision: null,
      })).status).toBe(200);

      const reviewApply = page.getByRole('button', { name: `Review apply revision ${draftRevision}`, exact: true });
      await reviewApply.focus();
      await page.keyboard.press('Enter');
      const confirmation = page.getByRole('group', { name: 'Confirm configuration apply' });
      const confirmApply = confirmation.getByRole('button', { name: 'Confirm apply', exact: true });
      const applyConflictResponse = page.waitForResponse((response) => {
        const request = response.request();
        if (!response.url().endsWith('/admin/api/actions') || request.method() !== 'POST') return false;
        try { return (request.postDataJSON() as { action?: unknown }).action === 'settings.revision.apply'; } catch { return false; }
      });
      await confirmApply.focus();
      await page.keyboard.press('Enter');
      const applyConflictReply = await applyConflictResponse;
      expect(applyConflictReply.status()).toBe(409);
      await page.getByRole('alert').filter({ hasText: 'Reload the scope and inspect the new revision before retrying.' }).waitFor();
      await page.getByRole('heading', { name: `Revision ${draftRevision}`, exact: true }).waitFor();
      await page.getByText('VALIDATED', { exact: true }).waitFor();
      await page.getByText('VFY-UI13 draft text that must remain visible after a conflict', { exact: true }).waitFor();
      const revisionState = await app.db.query<{ state: string }>(
        'SELECT state FROM settings_revisions WHERE stream_id=(SELECT id FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3) AND revision=$4',
        [tenantA, settingsApiKeyId, 'extract:invoice', draftRevision],
      );
      const activeStream = await app.db.query<{ active_revision: number | null }>(
        'SELECT active_revision FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3',
        [tenantA, settingsApiKeyId, 'extract:invoice'],
      );
      expect(revisionState.rows[0]?.state).toBe('VALIDATED');
      expect(activeStream.rows[0]?.active_revision).toBe(competitorRevision);

      await page.screenshot({ path: resolve(dir, 'settings-apply-conflict-desktop-1440.png'), fullPage: true });
      for (const width of [768, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(width);
        viewportMetrics.push({ viewport: width, scrollWidth });
        if (width === 320) await page.screenshot({ path: resolve(dir, 'settings-apply-conflict-mobile-320.png'), fullPage: true });
      }
      const focusedRevisionRegion = page.getByRole('region', { name: `Revision ${draftRevision} change details`, exact: true });
      await focusedRevisionRegion.focus();
      expect(await focusedRevisionRegion.evaluate((region) => document.activeElement === region)).toBe(true);

      const loadedAssets: Array<{ path: string; sha256: string }> = [...loadedScripts].map(([path, sha256]) => ({ path, sha256 }));
      expect(loadedAssets.length).toBeGreaterThan(0);
      writeFileSync(resolve(dir, 'settings-browser.json'), JSON.stringify({
        test: 'VFY-UI13 SETTINGS endpoint selector, real revision workflow and stale apply conflict',
        endpointValues,
        selectedScope: scope,
        syntheticConnectionId: settingsConnectionId,
        draftRevision,
        competitorRevision,
        staleApplyStatus: 409,
        draftStateAfterConflict: revisionState.rows[0]?.state,
        activeRevisionAfterConflict: activeStream.rows[0]?.active_revision,
        draftContentPreserved: true,
        viewportMetrics,
        loadedScripts: loadedAssets,
        shellUrl,
        publicUrl,
        internalUrl,
      }, null, 2));
      await context.close();
    } finally {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          await page.screenshot({ path: resolve(dir, 'settings-browser-last.png'), fullPage: true }).catch(() => undefined);
          writeFileSync(resolve(dir, 'settings-browser-last.txt'), await page.locator('body').innerText().catch(() => ''));
        }
      }
      await browser.close();
    }
  }, 150000);

  test('mounted Settings fences a late tenant-scoped read and leaves non-admin controls read-only', async () => {
    const browser = await openBrowser();
    const dir = resolve('reports/raw/orv13-vfy/admin-ui');
    mkdirSync(dir, { recursive: true });
    const staleReadPaused = deferred<void>();
    const releaseStaleRead = deferred<void>();
    let delayed = false;
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      context.setDefaultTimeout(15000);
      const page = await context.newPage();
      await attachSession(page, platform);
      await page.route('**/admin/api/settings**', async (route) => {
        const url = new URL(route.request().url());
        if (!delayed && url.searchParams.get('tenantId') === tenantA && url.searchParams.get('apiKeyId') === settingsApiKeyId) {
          delayed = true;
          const actualBffResponse = await route.fetch();
          staleReadPaused.resolve();
          await releaseStaleRead.promise;
          await route.fulfill({ response: actualBffResponse });
          return;
        }
        await route.continue();
      });
      await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      await page.goto(`${shellUrl}/admin/settings`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Settings & Deployment', exact: true }).waitFor();
      await page.locator('#global-tenant-select').selectOption(tenantA);
      await page.locator('#settings-api-key').selectOption(settingsApiKeyId);
      await page.getByRole('button', { name: 'Load current configuration', exact: true }).click();
      await staleReadPaused.promise;
      await page.locator('#global-tenant-select').selectOption(tenantB);
      await page.waitForFunction((tenantId) => (document.querySelector('#global-tenant-select') as HTMLSelectElement | null)?.value === tenantId, tenantB);
      releaseStaleRead.resolve();
      await page.waitForTimeout(250);
      expect(await page.locator('#settings-api-key option').evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value))).not.toContain(settingsApiKeyId);
      expect(await page.getByText(settingsProfileId, { exact: true }).count()).toBe(0);
      await page.screenshot({ path: resolve(dir, 'settings-tenant-b-fenced-desktop-1440.png'), fullPage: true });
      const platformPageText = await page.locator('body').innerText();
      writeFileSync(resolve(dir, 'settings-tenant-fence-browser.json'), JSON.stringify({
        test: 'VFY-UI13 SETTINGS tenant change while a real upstream scope read is in flight',
        delayedBffResponse: { path: '/admin/api/settings', tenantId: tenantA, responseOrigin: 'actual mounted Admin BFF and settings service', releasedAfterTenantBSelected: true },
        currentTenant: tenantB,
        staleApiKeyAbsent: true,
        staleProfileAbsent: true,
        shellUrl,
      }, null, 2));
      expect(platformPageText).not.toContain(settingsProfileId);

      const operatorContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      operatorContext.setDefaultTimeout(15000);
      const operatorPage = await operatorContext.newPage();
      await attachSession(operatorPage, tenantOperatorA);
      await operatorPage.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      await operatorPage.goto(`${shellUrl}/admin/settings`, { waitUntil: 'domcontentloaded' });
      await operatorPage.getByRole('heading', { name: 'Settings & Deployment', exact: true }).waitFor();
      await operatorPage.getByRole('button', { name: 'Open navigation', exact: true }).click();
      await operatorPage.locator('#global-tenant-select').selectOption(tenantA);
      await operatorPage.locator('#settings-api-key').selectOption(settingsApiKeyId);
      await operatorPage.getByRole('button', { name: 'Load current configuration', exact: true }).click();
      await operatorPage.locator(`#settings-prompt-target option[value="${settingsConnectionId}"]`).waitFor({ state: 'attached' });
      expect(await operatorPage.locator('#settings-prompt-target').isDisabled()).toBe(true);
      expect(await operatorPage.locator('#settings-prompt').isDisabled()).toBe(true);
      expect(await operatorPage.getByRole('button', { name: 'Create configuration draft', exact: true }).isDisabled()).toBe(true);
      await operatorPage.screenshot({ path: resolve(dir, 'settings-operator-readonly-mobile-390.png'), fullPage: true });
      await operatorContext.close();
      await context.close();
    } finally {
      releaseStaleRead.resolve();
      await browser.close();
    }
  }, 150000);

  test('mounted system cockpit uses tenant-filtered operation projections and labels missing sources honestly', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const unknownOperation = await seedOperation({ tenantId: tenantA, state: 'FAILED' });
    await app.db.query("UPDATE operations SET error_code='PROVIDER_OUTCOME_UNKNOWN' WHERE id=$1", [unknownOperation.operationId]);
    const browser = await openBrowser();
    const dir = resolve('reports/raw/orv13-vfy/admin-ui');
    mkdirSync(dir, { recursive: true });
    const requestLog: Array<{ path: string; query: string }> = [];
    const responseLog: Array<{ path: string; status: number }> = [];
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      context.setDefaultTimeout(15000);
      const page = await context.newPage();
      await attachSession(page, platform);
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/admin/api/')) requestLog.push({ path: url.pathname, query: url.search });
      });
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/admin/api/')) responseLog.push({ path: url.pathname, status: response.status() });
      });
      await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      await page.goto(`${shellUrl}/admin/system-operations/services`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'System operations', exact: true }).waitFor();
      await page.waitForFunction((tenantId) => (document.querySelector('#global-tenant-select') as HTMLSelectElement | null)?.value === tenantId, tenantA);
      await page.getByRole('heading', { name: 'Services and dependencies', exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Workers and queue integrity', exact: true }).waitFor();
      await page.getByText('No worker heartbeat records were returned. This inventory cannot establish whether unreported deployments exist.', { exact: true }).waitFor();
      await page.getByRole('heading', { name: 'Incidents and triage signals', exact: true }).waitFor();
      await page.getByText('Unknown outcomes in latest sample', { exact: false }).waitFor();
      await page.getByText(unknownOperation.operationId, { exact: true }).waitFor();
      expect(await page.getByText('No worker heartbeat records were returned. This inventory cannot establish whether unreported deployments exist.', { exact: true }).count()).toBe(1);
      expect(await page.getByText(/No worker.*offline|0 workers offline/i).count()).toBe(0);
      const healthReplies = responseLog.filter((entry) => entry.path === '/admin/api/health' && entry.status === 200);
      const workerReplies = responseLog.filter((entry) => entry.path === '/admin/api/worker-instances' && entry.status === 200);
      expect(healthReplies.length).toBeGreaterThan(0);
      expect(workerReplies.length).toBeGreaterThan(0);
      const scopedOperationsRequest = requestLog.find((entry) => entry.path === '/admin/api/operations' && new URLSearchParams(entry.query.slice(1)).get('tenant') === tenantA);
      const scopedMetricsRequest = requestLog.find((entry) => entry.path === '/admin/api/operations/metrics' && new URLSearchParams(entry.query.slice(1)).get('tenant') === tenantA);
      expect(scopedOperationsRequest).toBeDefined();
      expect(scopedMetricsRequest).toBeDefined();
      await page.screenshot({ path: resolve(dir, 'cockpit-tenant-a-incidents-desktop-1440.png'), fullPage: true });

      await page.locator('#global-tenant-select').selectOption(tenantB);
      await page.waitForFunction((tenantId) => (document.querySelector('#global-tenant-select') as HTMLSelectElement | null)?.value === tenantId, tenantB);
      await page.waitForTimeout(250);
      expect(await page.getByText(unknownOperation.operationId, { exact: true }).count()).toBe(0);
      expect(await page.getByText('PROVIDER_OUTCOME_UNKNOWN', { exact: true }).count()).toBe(0);

      // Inject only a transient browser transport failure after the actual BFF
      // baseline succeeded; this checks stale-last-good rendering, not BFF/API behavior.
      let failRefresh = false;
      await page.route('**/admin/api/operations/metrics**', async (route) => {
        if (!failRefresh) return route.continue();
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ status: 503, code: 'VFY_TRANSIENT_REFRESH_FAILURE', title: 'Verifier transient refresh failure' }),
        });
      });
      await page.locator('#global-tenant-select').selectOption(tenantA);
      await page.waitForFunction((tenantId) => (document.querySelector('#global-tenant-select') as HTMLSelectElement | null)?.value === tenantId, tenantA);
      await page.getByText(unknownOperation.operationId, { exact: true }).waitFor();
      failRefresh = true;
      const injected503 = page.waitForResponse((response) => response.status() === 503 && response.url().includes('/admin/api/operations/metrics'));
      await page.getByRole('button', { name: 'Refresh now', exact: true }).click();
      expect((await injected503).status()).toBe(503);
      const staleProjectionNotices = page.getByRole('status').filter({ hasText: 'Refresh failed (HTTP 503' });
      await staleProjectionNotices.first().waitFor();
      expect(await staleProjectionNotices.count()).toBe(2);
      expect(await page.getByText(unknownOperation.operationId, { exact: true }).count()).toBe(1);
      await page.screenshot({ path: resolve(dir, 'cockpit-stale-last-good-triage-desktop-1440.png'), fullPage: true });

      const widths: Array<{ width: number; scrollWidth: number }> = [];
      for (const width of [768, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(width);
        widths.push({ width, scrollWidth });
        if (width === 320) await page.screenshot({ path: resolve(dir, 'cockpit-triage-mobile-320.png'), fullPage: true });
      }

      const restrictedReads: Array<{ role: string; requests: Array<{ path: string; query: string }>; scrollWidth: number }> = [];
      for (const [roleName, session] of [['operator', tenantOperatorA], ['viewer', viewerA]] as const) {
        const restrictedContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
        restrictedContext.setDefaultTimeout(15000);
        const restrictedPage = await restrictedContext.newPage();
        const observed: Array<{ path: string; query: string }> = [];
        await attachSession(restrictedPage, session);
        restrictedPage.on('request', (request) => {
          const url = new URL(request.url());
          if (url.pathname.startsWith('/admin/api/')) observed.push({ path: url.pathname, query: url.search });
        });
        await restrictedPage.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
        await restrictedPage.goto(`${shellUrl}/admin/system-operations/services`, { waitUntil: 'domcontentloaded' });
        await restrictedPage.getByRole('heading', { name: 'System operations', exact: true }).waitFor();
        await restrictedPage.getByText('Platform health is restricted to platform administrators.', { exact: true }).waitFor();
        await restrictedPage.getByText(/This view makes no host or job request for tenant operators, viewers, or unscoped sessions\./).waitFor();
        await restrictedPage.waitForTimeout(300);
        expect(observed.some((entry) => entry.path.startsWith('/admin/api/compose/'))).toBe(false);
        expect(observed.some((entry) => entry.path === '/admin/api/worker-instances')).toBe(false);
        expect(observed.some((entry) => entry.path === '/admin/api/health')).toBe(false);
        const scrollWidth = await restrictedPage.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(390);
        restrictedReads.push({ role: roleName, requests: observed, scrollWidth });
        await restrictedPage.screenshot({ path: resolve(dir, `cockpit-${roleName}-restricted-mobile-390.png`), fullPage: true });
        await restrictedContext.close();
      }
      writeFileSync(resolve(dir, 'cockpit-browser.json'), JSON.stringify({
        test: 'VFY-UI13 cockpit tenant filter, truthful empty heartbeat inventory, unknown outcome and stale last-good rendering',
        syntheticOperation: { id: unknownOperation.operationId, tenantId: tenantA, state: 'FAILED', errorCode: 'PROVIDER_OUTCOME_UNKNOWN', source: 'isolated PostgreSQL operation row' },
        actualBaselineBff: { health200: healthReplies.length, workers200: workerReplies.length, tenantAOperationsQuery: scopedOperationsRequest?.query, tenantAMetricsQuery: scopedMetricsRequest?.query },
        tenantBExcludesTenantAUnknownOperation: true,
        workerEmptyClaim: 'No worker heartbeat records were returned. This inventory cannot establish whether unreported deployments exist.',
        staleUIFaultInjection: { injectedAfterActualBffBaseline: true, path: '/admin/api/operations/metrics', status: 503, retainedUnknownOperation: true },
        restrictedRolesNoHostReads: restrictedReads,
        viewportWidths: widths,
        responses: responseLog,
        shellUrl,
      }, null, 2));
      await context.close();
    } finally {
      await browser.close();
    }
  }, 150000);

  test('mounted operation deep links follow browser history and terminal delete requires keyboard confirmation', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const operation = await seedOperation({ tenantId: tenantA, state: 'SUCCEEDED' });
    const browser = await openBrowser();
    const dir = resolve('reports/raw/orv13-vfy/admin-ui');
    mkdirSync(dir, { recursive: true });
    const actionResponses: Array<{ path: string; method: string; status: number }> = [];
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 950 } });
      context.setDefaultTimeout(15000);
      const page = await context.newPage();
      await attachSession(page, tenantOperatorA);
      page.on('response', (response) => {
        const request = response.request();
        const url = new URL(response.url());
        if (url.pathname.startsWith('/admin/api/')) actionResponses.push({ path: url.pathname, method: request.method(), status: response.status() });
      });
      await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      await page.goto(`${shellUrl}/admin/operations`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Operations', exact: true }).waitFor();
      await page.waitForFunction((tenantId) => (document.querySelector('#global-tenant-select') as HTMLSelectElement | null)?.value === tenantId, tenantA);
      await page.locator('#ops-id').fill(operation.operationId.slice(0, 8));
      const operationRow = page.getByRole('row').filter({ hasText: operation.operationId.slice(0, 8) });
      await operationRow.getByRole('button', { name: 'Detail', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.searchParams.get('operation') === operation.operationId);
      await page.getByRole('heading', { name: 'Operation Details', exact: true }).waitFor();
      const detailMobileReadability: Array<{ viewport: number; scrollWidth: number; downloadLink: { width: number; height: number; clientWidth: number; scrollWidth: number; whiteSpace: string } }> = [];
      for (const width of [390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const downloadLink = page.getByRole('link', { name: 'Download result', exact: true });
        const box = await downloadLink.evaluate((element) => {
          const rect = element.getBoundingClientRect();
          const style = getComputedStyle(element);
          return { width: rect.width, height: rect.height, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, whiteSpace: style.whiteSpace };
        });
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(width);
        expect(box.width).toBeGreaterThanOrEqual(80);
        expect(box.height).toBeLessThanOrEqual(24);
        expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
        expect(box.whiteSpace).toBe('nowrap');
        detailMobileReadability.push({ viewport: width, scrollWidth, downloadLink: box });
        await page.screenshot({ path: resolve(dir, `operations-detail-mobile-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 1440, height: 950 });
      await page.goBack();
      await page.waitForURL((url) => url.searchParams.get('operation') === null);
      await page.getByRole('heading', { name: 'Operation Details', exact: true }).waitFor({ state: 'detached' });
      await page.goForward();
      await page.waitForURL((url) => url.searchParams.get('operation') === operation.operationId);
      await page.getByRole('heading', { name: 'Operation Details', exact: true }).waitFor();

      const deleteButton = page.getByRole('button', { name: 'Delete', exact: true }).last();
      await deleteButton.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Delete this terminal operation?', exact: true }).waitFor();
      await page.getByText(/hides the terminal operation from the active list and records an audit event/i).waitFor();
      const confirm = page.getByRole('button', { name: 'Delete operation', exact: true });
      await confirm.focus();
      const deletionResponse = page.waitForResponse((response) =>
        response.request().method() === 'DELETE' && new URL(response.url()).pathname === `/admin/api/operations/${operation.operationId}`,
      );
      await page.keyboard.press('Enter');
      expect((await deletionResponse).status()).toBe(200);
      await page.waitForURL((url) => url.searchParams.get('operation') === null);
      await page.getByText('Terminal operation hidden from the active list. Retained artifacts and audit records are unchanged.', { exact: true }).waitFor();
      const deleted = await app.db.query<{ deleted_at: string | null }>('SELECT deleted_at FROM operations WHERE id=$1', [operation.operationId]);
      expect(deleted.rows[0]?.deleted_at).not.toBeNull();
      const audit = await app.db.query<{ count: number }>(
        "SELECT count(*)::int AS count FROM admin_audit_events WHERE action='operation.delete' AND resource=$1",
        [`operation:${operation.operationId}`],
      );
      expect(audit.rows[0]?.count).toBe(1);
      await page.screenshot({ path: resolve(dir, 'operations-terminal-delete-desktop-1440.png'), fullPage: true });
      const widths: Array<{ width: number; scrollWidth: number }> = [];
      for (const width of [768, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(width);
        widths.push({ width, scrollWidth });
        if (width === 320) await page.screenshot({ path: resolve(dir, 'operations-terminal-delete-mobile-320.png'), fullPage: true });
      }
      expect(actionResponses.some((item) => item.path.endsWith(`/operations/${operation.operationId}`) && item.method === 'DELETE' && item.status === 200)).toBe(true);
      writeFileSync(resolve(dir, 'operations-history-delete-browser.json'), JSON.stringify({
        test: 'VFY-UI13 operation query deep-link, Back/Forward restoration, and terminal deletion',
        operationId: operation.operationId,
        tenantId: tenantA,
        history: ['list', `?operation=${operation.operationId}`, 'Back -> list', 'Forward -> detail'],
        delete: { confirmationHeading: 'Delete this terminal operation?', confirmKey: 'Enter', status: 200, softDeleted: deleted.rows[0]?.deleted_at !== null, auditRows: audit.rows[0]?.count },
        detailMobileReadability,
        viewportWidths: widths,
        actionResponses,
      }, null, 2));
      await context.close();
    } finally {
      await browser.close();
    }
  }, 150000);

  test('mounted workflow viewer hides writes and stale admin revision publish preserves draft after real CAS conflict', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const workflow = await provisionWorkflowFixture(tenantA);
    const browser = await openBrowser();
    const dir = resolve('reports/raw/orv13-vfy/admin-ui');
    mkdirSync(dir, { recursive: true });
    const responseLog: Array<{ method: string; path: string; status: number }> = [];
    const editedSchema = { ...workflow.schema, description: 'VFY draft preserved after server revision conflict' };
    let draftRaw = '';
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
      context.setDefaultTimeout(15000);
      const page = await context.newPage();
      await attachSession(page, platform);
      page.on('response', (response) => {
        const request = response.request();
        const path = new URL(response.url()).pathname;
        if (path.startsWith('/admin/api/')) responseLog.push({ method: request.method(), path, status: response.status() });
      });
      await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      await page.goto(`${shellUrl}/admin/workflows`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Business Workflows', exact: true }).waitFor();
      await page.getByRole('button', { name: new RegExp(workflow.slug) }).click();
      await page.getByRole('button', { name: 'Edit active revision', exact: true }).waitFor();
      await page.getByRole('button', { name: 'Edit active revision', exact: true }).focus();
      await page.keyboard.press('Enter');
      const editor = page.locator('#workflow-revision-json');
      await editor.waitFor();
      const currentSchema = JSON.parse(await editor.inputValue()) as Record<string, unknown>;
      const changedSchema = { ...currentSchema, description: 'VFY draft preserved after server revision conflict' };
      draftRaw = JSON.stringify(changedSchema, null, 2);
      await editor.fill(draftRaw);
      await page.getByRole('status').filter({ hasText: `Local structure checks passed for slug "${workflow.slug}"` }).waitFor();

      const competitor = { ...workflow.schema, description: 'A competing admin published revision' };
      const competitorResponse = await bffAction(platform, 'workflow.provision', { tenantId: tenantA, schema: competitor, expectedRevision: 1 });
      expect(competitorResponse.status).toBe(201);
      const revisionsBeforeStaleApply = await app.db.query<{ revision: number; status: string }>(
        'SELECT revision,status FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 ORDER BY revision',
        [tenantA, workflow.slug],
      );
      expect(revisionsBeforeStaleApply.rows.map((row) => row.revision)).toEqual([1, 2]);

      const publish = page.getByRole('button', { name: 'Validate and publish revision', exact: true });
      await publish.focus();
      const stalePublishResponse = page.waitForResponse((response) => {
        const request = response.request();
        if (!response.url().endsWith('/admin/api/actions') || request.method() !== 'POST') return false;
        try { return (request.postDataJSON() as { action?: unknown }).action === 'workflow.provision'; } catch { return false; }
      });
      await page.keyboard.press('Enter');
      expect((await stalePublishResponse).status()).toBe(409);
      await page.getByText(/Revision 1 is no longer active\. Your draft is preserved; refresh the catalog, compare the new revision, then reopen the editor\./).waitFor();
      expect(await editor.inputValue()).toBe(draftRaw);
      expect(await page.getByRole('button', { name: 'Validate and publish revision', exact: true }).isDisabled()).toBe(true);
      const revisionsAfter = await app.db.query<{ revision: number; status: string }>(
        'SELECT revision,status FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2 ORDER BY revision',
        [tenantA, workflow.slug],
      );
      expect(revisionsAfter.rows).toEqual([{ revision: 1, status: 'retired' }, { revision: 2, status: 'active' }]);
      await page.screenshot({ path: resolve(dir, 'workflow-revision-conflict-desktop-1440.png'), fullPage: true });

      const operatorContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
      operatorContext.setDefaultTimeout(15000);
      const operatorPage = await operatorContext.newPage();
      const operatorRequests: Array<{ method: string; path: string }> = [];
      await attachSession(operatorPage, tenantOperatorA);
      operatorPage.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path.startsWith('/admin/api/')) operatorRequests.push({ method: request.method(), path });
      });
      await operatorPage.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      await operatorPage.goto(`${shellUrl}/admin/workflows`, { waitUntil: 'domcontentloaded' });
      await operatorPage.getByRole('heading', { name: 'Business Workflows', exact: true }).waitFor();
      await operatorPage.getByRole('alert').filter({ hasText: 'Read-only workflow access' }).waitFor();
      const createButton = operatorPage.getByRole('button', { name: 'Create / Import Workflow', exact: true });
      expect(await createButton.isDisabled()).toBe(true);
      await operatorPage.getByRole('button').filter({ hasText: workflow.slug }).filter({ hasText: 'v2' }).click();
      expect(await operatorPage.getByRole('button', { name: 'Edit active revision', exact: true }).count()).toBe(0);
      expect(operatorRequests.some((item) => item.method !== 'GET' && item.path === '/admin/api/actions')).toBe(false);

      const beforeViewerWrite = await app.db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2', [tenantA, workflow.slug],
      );
      const viewerWrite = await bffAction(viewerA, 'workflow.provision', { tenantId: tenantA, schema: { ...workflow.schema, description: 'viewer must not publish' }, expectedRevision: 2 });
      expect(viewerWrite.status).toBe(403);
      const afterViewerWrite = await app.db.query<{ count: number }>(
        'SELECT count(*)::int AS count FROM legacy_workflow_schemas WHERE tenant_id=$1 AND slug=$2', [tenantA, workflow.slug],
      );
      expect(afterViewerWrite.rows[0]?.count).toBe(beforeViewerWrite.rows[0]?.count);
      const operatorWidth = await operatorPage.evaluate(() => document.documentElement.scrollWidth);
      expect(operatorWidth).toBeLessThanOrEqual(390);
      await operatorPage.screenshot({ path: resolve(dir, 'workflow-operator-readonly-mobile-390.png'), fullPage: true });
      writeFileSync(resolve(dir, 'workflow-browser.json'), JSON.stringify({
        test: 'VFY-UI13 workflows viewer write gates and real stale revision compare-and-swap',
        workflow: { tenantId: tenantA, slug: workflow.slug },
        admin: { originalRevision: 1, competitorRevision: 2, staleApplyStatus: 409, draftPreserved: JSON.parse(await editor.inputValue()).description, rowsAfter: revisionsAfter.rows },
        operator: { role: 'tenant_operator', createDisabled: true, editButtonHidden: true, writeRequestsFromUI: operatorRequests.filter((item) => item.method !== 'GET') },
        viewer: { role: 'viewer', catalogDeniedByServer: true, actualBffWriteStatus: viewerWrite.status, databaseRowsUnchanged: afterViewerWrite.rows[0]?.count === beforeViewerWrite.rows[0]?.count },
        viewportWidths: { admin: 1440, operator: { width: 390, scrollWidth: operatorWidth } },
        responses: responseLog,
      }, null, 2));
      await operatorContext.close();
      await context.close();
    } finally {
      await browser.close();
    }
  }, 180000);

  test('mounted callback control retries the same failed delivery and renders its real HTTP outcome', async () => {
    if (!app) throw new Error('ORV13 app is not started');
    const before = {
      operation: (await app.db.query('SELECT * FROM operations WHERE id=$1', [callbackOperationId])).rows[0],
      tasks: (await app.db.query('SELECT * FROM tasks WHERE operation_id=$1 ORDER BY id', [callbackOperationId])).rows,
      usage: (await app.db.query('SELECT * FROM usage_events WHERE operation_id=$1 ORDER BY event_id', [callbackOperationId])).rows,
      count: (await app.db.query('SELECT (SELECT count(*)::int FROM operations) AS operations,(SELECT count(*)::int FROM tasks) AS tasks')).rows[0],
    };
    const browser = await openBrowser();
    const dir = resolve('reports/raw/orv13-vfy/admin-ui');
    mkdirSync(dir, { recursive: true });
    const scriptResponses = new Map<string, Promise<{ status: number; contentType: string; sha256: string }>>();
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      const page = await context.newPage();
      await attachSession(page, tenantOperatorA);
      page.on('response', (response) => {
        if (/\/assets\/index-[^/]+\.js/.test(response.url())) {
          const path = new URL(response.url()).pathname;
          scriptResponses.set(path, (async () => {
            const body = await response.body();
            return {
              status: response.status(),
              contentType: response.headers()['content-type'] ?? '',
              sha256: createHash('sha256').update(body).digest('hex'),
            };
          })());
        }
      });
      await page.addInitScript(() => localStorage.removeItem('du_global_tenant_id'));
      await page.goto(`${shellUrl}/admin/operations`, { waitUntil: 'networkidle' });
      await page.locator('#global-tenant-select').selectOption(tenantA);
      const operationRow = page.getByRole('row').filter({ hasText: callbackOperationId.slice(0, 8) });
      await operationRow.getByRole('button', { name: 'Detail', exact: true }).focus();
      await page.keyboard.press('Enter');
      await page.waitForURL((url) => url.searchParams.get('operation') === callbackOperationId);
      await page.getByRole('region', { name: 'Callback deliveries' }).waitFor();
      await page.getByText('FAILED · 4 / 5 attempts', { exact: true }).waitFor();
      const retry = page.getByRole('button', { name: 'Review one retry', exact: true });
      await retry.focus();
      await page.keyboard.press('Enter');
      await page.getByRole('heading', { name: 'Retry this callback once?', exact: true }).waitFor();
      const dialogDescription = await page.getByText(new RegExp(`delivery ${callbackDeliveryId.replaceAll('-', '\\-')}`)).innerText();
      expect(dialogDescription).toContain('4 of 5 attempts used');
      expect(dialogDescription).toContain('same ID and payload are reused');
      const queueOneRetry = page.getByRole('button', { name: 'Queue one retry', exact: true });
      await queueOneRetry.focus();
      const retryResponse = page.waitForResponse((response) => response.url().endsWith('/admin/api/actions') && response.request().method() === 'POST');
      await page.keyboard.press('Enter');
      const retryReply = await retryResponse;
      expect(retryReply.status()).toBe(200);
      await page.getByText(/One retry attempt was queued for the same delivery ID/i).waitFor();
      const queued = await app.db.query<{ status: string; attempts: number; payload: Record<string, unknown> }>(
        'SELECT status,attempts,payload FROM webhook_deliveries WHERE delivery_id=$1', [callbackDeliveryId],
      );
      expect(queued.rows[0]).toMatchObject({ status: 'PENDING', attempts: 4, payload: callbackPayload });
      expect((await app.db.query('SELECT * FROM operations WHERE id=$1', [callbackOperationId])).rows[0]).toEqual(before.operation);
      expect((await app.db.query('SELECT * FROM tasks WHERE operation_id=$1 ORDER BY id', [callbackOperationId])).rows).toEqual(before.tasks);
      expect((await app.db.query('SELECT * FROM usage_events WHERE operation_id=$1 ORDER BY event_id', [callbackOperationId])).rows).toEqual(before.usage);

      const dispatched = await deliverWebhooks(app.db, {
        secret: browserSecret,
        allowHosts: ['callback.fixture.example'],
        allowPrivateNetworks: true,
        lookupFn: async () => ['127.0.0.1'],
      });
      expect(dispatched).toBe(1);
      expect(receiverBodies.map((raw) => JSON.parse(raw))).toContainEqual(callbackPayload);
      const delivered = await app.db.query<{ status: string; attempts: number; payload: Record<string, unknown>; delivery_id: string }>(
        'SELECT status,attempts,payload,delivery_id FROM webhook_deliveries WHERE delivery_id=$1', [callbackDeliveryId],
      );
      expect(delivered.rows[0]).toMatchObject({ status: 'DELIVERED', attempts: 5, delivery_id: callbackDeliveryId, payload: callbackPayload });
      expect((await app.db.query('SELECT * FROM operations WHERE id=$1', [callbackOperationId])).rows[0]).toEqual(before.operation);
      expect((await app.db.query('SELECT * FROM tasks WHERE operation_id=$1 ORDER BY id', [callbackOperationId])).rows).toEqual(before.tasks);
      expect((await app.db.query('SELECT * FROM usage_events WHERE operation_id=$1 ORDER BY event_id', [callbackOperationId])).rows).toEqual(before.usage);
      expect((await app.db.query('SELECT (SELECT count(*)::int FROM operations) AS operations,(SELECT count(*)::int FROM tasks) AS tasks')).rows[0]).toEqual(before.count);

      await page.getByRole('button', { name: 'Refresh callbacks', exact: true }).click();
      await page.getByText('DELIVERED · 5 / 5 attempts', { exact: true }).waitFor();
      await page.screenshot({ path: resolve(dir, 'callback-delivered-desktop-1440.png'), fullPage: true });
      const pageWidth: Array<{ viewport: number; scrollWidth: number; downloadLink?: { width: number; height: number; clientWidth: number; scrollWidth: number; whiteSpace: string } }> = [];
      for (const width of [768, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        await page.waitForTimeout(150);
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(width);
        if (width === 390 || width === 320) {
          const link = page.getByRole('link', { name: 'Download result', exact: true });
          const box = await link.evaluate((element) => {
            const rect = element.getBoundingClientRect();
            const style = getComputedStyle(element);
            return { width: rect.width, height: rect.height, clientWidth: element.clientWidth, scrollWidth: element.scrollWidth, whiteSpace: style.whiteSpace };
          });
          expect(box.width).toBeGreaterThanOrEqual(80);
          expect(box.height).toBeLessThanOrEqual(24);
          expect(box.scrollWidth).toBeLessThanOrEqual(box.clientWidth + 1);
          expect(box.whiteSpace).toBe('nowrap');
          pageWidth.push({ viewport: width, scrollWidth, downloadLink: box });
          await page.screenshot({ path: resolve(dir, `callback-delivered-mobile-${width}.png`), fullPage: true });
        } else {
          pageWidth.push({ viewport: width, scrollWidth });
        }
      }
      const browserLoadedScripts = await Promise.all([...scriptResponses.entries()].map(async ([path, response]) => ({ path, ...await response })));
      expect(browserLoadedScripts.length).toBeGreaterThan(0);
      expect(browserLoadedScripts.every((script) => script.status === 200 && script.contentType.includes('javascript'))).toBe(true);
      const loadedScripts: Array<{ path: string; status: number; contentType: string; sha256: string; localSha256: string; finalUrl: string }> = [];
      for (const script of browserLoadedScripts) {
        const { path } = script;
        const asset = await fetch(`${shellUrl}${path}`, { headers: { cookie: sessionCookie(tenantOperatorA) } });
        expect(asset.status).toBe(200);
        const bytes = Buffer.from(await asset.arrayBuffer());
        const sha256 = createHash('sha256').update(bytes).digest('hex');
        const localFile = resolve('orchestrator/apps/admin-web/dist', path.replace(/^\/admin\//, ''));
        const localSha256 = createHash('sha256').update(readFileSync(localFile)).digest('hex');
        expect(asset.url).toBe(`${shellUrl}${path}`);
        expect(sha256).toBe(localSha256);
        expect(script.sha256).toBe(localSha256);
        loadedScripts.push({ path, status: script.status, contentType: script.contentType, sha256, localSha256, finalUrl: asset.url });
      }
      writeFileSync(resolve(dir, 'callback-browser.json'), JSON.stringify({
        test: 'VFY-UI13 AOPS-J05 callback retry through mounted Admin UI',
        operationId: callbackOperationId,
        deliveryId: callbackDeliveryId,
        failedBefore: { status: 'FAILED', attempts: 4, maxAttempts: 5 },
        queuedAfterBff: { status: queued.rows[0]?.status, attempts: queued.rows[0]?.attempts },
        deliveredAfterRealDispatcher: { status: delivered.rows[0]?.status, attempts: delivered.rows[0]?.attempts },
        actualReceiverPayloads: receiverBodies.map((body) => JSON.parse(body)),
        operationTaskUsageUnchanged: true,
        keyboard: { focusedButton: 'Review one retry', confirmation: 'accessible ConfirmDialog inspected before Queue one retry', key: 'Enter' },
        selectedDetailsAction: 'Download result',
        viewportScrollWidths: pageWidth,
        browserLoadedScripts,
        loadedScripts,
        shellUrl,
        publicUrl,
        internalUrl,
      }, null, 2));
      await context.close();
    } finally {
      for (const context of browser.contexts()) {
        for (const page of context.pages()) {
          await page.screenshot({ path: resolve(dir, 'browser-last.png'), fullPage: true }).catch(() => undefined);
          writeFileSync(resolve(dir, 'browser-last.txt'), await page.locator('body').innerText().catch(() => ''));
        }
      }
      await browser.close();
    }
  }, 120000);

  test('mounted shell pauses after a real cookie 401 and only recovers the verified session fingerprint', async () => {
    const browser = await openBrowser();
    const dir = resolve('reports/raw/orv13-vfy/admin-ui');
    mkdirSync(dir, { recursive: true });
    const initialSession = await sessions.create({ issuer: 'orv13-vfy-auth-ui', sub: 'auth-ui-platform', role: 'admin' });
    const requests: Array<{ path: string; method: string }> = [];
    const responses: Array<{ path: string; status: number }> = [];
    let requestCountAtFirst401: number | null = null;
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
      context.setDefaultTimeout(15000);
      const page = await context.newPage();
      await attachSession(page, initialSession);
      page.on('request', (request) => {
        const url = new URL(request.url());
        if (url.pathname.startsWith('/admin/api/')) requests.push({ path: url.pathname, method: request.method() });
      });
      page.on('response', (response) => {
        const url = new URL(response.url());
        if (url.pathname.startsWith('/admin/api/')) {
          responses.push({ path: url.pathname, status: response.status() });
          if (response.status() === 401 && requestCountAtFirst401 === null) requestCountAtFirst401 = requests.length;
        }
      });
      await page.addInitScript((tenantId) => localStorage.setItem('du_global_tenant_id', tenantId), tenantA);
      await page.goto(`${shellUrl}/admin/usage`, { waitUntil: 'domcontentloaded' });
      await page.getByRole('heading', { name: 'Usage & Cost', exact: true }).waitFor();
      await page.getByRole('link', { name: 'Health details', exact: true }).waitFor();

      const draftFrom = localDateTimeInput(Date.now() - 5 * 60_000);
      const draftTo = localDateTimeInput(Date.now() - 60_000);
      await page.locator('#usage-from').fill(draftFrom);
      await page.locator('#usage-to').fill(draftTo);
      const visibleDraft = { from: await page.locator('#usage-from').inputValue(), to: await page.locator('#usage-to').inputValue() };
      expect(visibleDraft).toEqual({ from: draftFrom, to: draftTo });

      expect(await sessions.destroy(initialSession.sessionId)).toBe(true);
      const response401 = page.waitForResponse((response) =>
        response.status() === 401 && response.url().includes('/admin/api/usage/'),
      );
      await page.getByRole('button', { name: 'Refresh now', exact: true }).click();
      const expiredResponse = await response401;
      await page.getByRole('alert').filter({ hasText: 'Admin session expired. Protected reads and actions are paused.' }).waitFor();
      expect(await page.locator('#admin-content').evaluate((node) => (node as HTMLElement).inert)).toBe(true);
      expect(await page.locator('#admin-navigation').evaluate((node) => (node.parentElement as HTMLElement | null)?.inert)).toBe(true);
      expect(await page.locator('#usage-from').inputValue()).toBe(draftFrom);
      expect(await page.locator('#usage-to').inputValue()).toBe(draftTo);
      await page.screenshot({ path: resolve(dir, 'auth-expired-draft-desktop-1440.png'), fullPage: true });

      await page.waitForTimeout(500);
      expect(requestCountAtFirst401).not.toBeNull();
      await page.waitForTimeout(500);
      expect(requests).toHaveLength(requestCountAtFirst401!);
      expect(requests.some((item) => item.path === '/admin/api/usage/events')).toBe(true);
      expect(responses.some((item) => item.path.startsWith('/admin/api/usage/') && item.status === 401)).toBe(true);

      const sameScopeSession = await sessions.create({ issuer: 'orv13-vfy-auth-ui', sub: 'auth-ui-platform', role: 'admin' });
      await attachSession(page, sameScopeSession);
      const verifySameResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === '/admin/api/session' && response.request().method() === 'GET',
      );
      await page.getByRole('button', { name: 'Verify session', exact: true }).click();
      expect((await verifySameResponse).status()).toBe(200);
      await page.getByRole('link', { name: 'Health details', exact: true }).waitFor();
      expect(await page.locator('#admin-content').evaluate((node) => (node as HTMLElement).inert)).toBe(false);
      expect(await page.locator('#usage-from').inputValue()).toBe(draftFrom);
      expect(await page.locator('#usage-to').inputValue()).toBe(draftTo);

      expect(await sessions.destroy(sameScopeSession.sessionId)).toBe(true);
      const secondExpiredResponse = page.waitForResponse((response) =>
        response.status() === 401 && response.url().includes('/admin/api/usage/'),
      );
      await page.getByRole('button', { name: 'Refresh now', exact: true }).click();
      expect((await secondExpiredResponse).status()).toBe(401);
      await page.getByRole('alert').filter({ hasText: 'Admin session expired. Protected reads and actions are paused.' }).waitFor();

      const changedScopeSession = await sessions.create({ issuer: 'orv13-vfy-auth-ui', sub: 'auth-ui-tenant-operator', role: 'operator', tenantId: tenantA });
      await attachSession(page, changedScopeSession);
      const requestCountBeforeChangedVerify = requests.length;
      const verifyChangedResponse = page.waitForResponse((response) =>
        new URL(response.url()).pathname === '/admin/api/session' && response.request().method() === 'GET',
      );
      await page.getByRole('button', { name: 'Verify session', exact: true }).click();
      expect((await verifyChangedResponse).status()).toBe(200);
      await page.getByRole('alert').filter({ hasText: 'The signed-in role or tenant scope changed. Protected requests remain locked.' }).waitFor();
      await page.getByRole('button', { name: 'Reload under new scope', exact: true }).waitFor();
      expect(await page.locator('#admin-content').evaluate((node) => (node as HTMLElement).inert)).toBe(true);
      expect(await page.locator('#usage-from').inputValue()).toBe(draftFrom);
      expect(await page.locator('#usage-to').inputValue()).toBe(draftTo);
      expect(requests.slice(requestCountBeforeChangedVerify)).toEqual([{ path: '/admin/api/session', method: 'GET' }]);
      await page.screenshot({ path: resolve(dir, 'auth-scope-changed-draft-desktop-1440.png'), fullPage: true });

      const responsiveWidths: Array<{ width: number; scrollWidth: number }> = [];
      for (const width of [768, 390, 320]) {
        await page.setViewportSize({ width, height: 844 });
        const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
        expect(scrollWidth).toBeLessThanOrEqual(width);
        responsiveWidths.push({ width, scrollWidth });
        if (width === 320) await page.screenshot({ path: resolve(dir, 'auth-scope-changed-mobile-320.png'), fullPage: true });
      }
      writeFileSync(resolve(dir, 'auth-recovery-browser.json'), JSON.stringify({
        test: 'VFY-UI13 mounted session expiry, same-scope recovery and changed-scope lock',
        initialScope: { role: 'admin', principal: 'platform', origin: 'actual /admin/api/session' },
        expiry: { path: new URL(expiredResponse.url()).pathname, status: expiredResponse.status(), confirmed401: true, shellAndNavigationInert: true, nonsecretDraftPreserved: visibleDraft },
        protectedRequestCountStableAfterExpiry: true,
        sameScopeVerify: { role: 'admin', scope: 'platform', responseStatus: 200, recovered: true },
        changedScopeVerify: { role: 'operator', scope: `tenant:${tenantA}`, responseStatus: 200, uiResult: 'SESSION_CHANGED / reload required', stillLocked: true },
        finalDraftPreserved: { from: await page.locator('#usage-from').inputValue(), to: await page.locator('#usage-to').inputValue() },
        responsiveWidths,
        relevantRequests: requests,
        relevantResponses: responses,
      }, null, 2));
      await context.close();
    } finally {
      await browser.close();
    }
  }, 120000);

  test('shared confirmed 401 latch aborts CSRF-protected writes and blocks other client instances until explicit recovery', async () => {
    const priorWindow = Object.getOwnPropertyDescriptor(globalThis, 'window');
    const browserEventTarget = new EventTarget();
    Object.defineProperty(globalThis, 'window', { value: browserEventTarget as unknown as Window, configurable: true });
    let expiredEvents = 0;
    const handleExpired = () => { expiredEvents += 1; };
    browserEventTarget.addEventListener(ADMIN_AUTH_EXPIRED_EVENT, handleExpired);
    const calls: Array<{ path: string; method: string }> = [];
    let cookie: string | null = null;
    const actualBffFetch: typeof fetch = async (input, init) => {
      const rawUrl = typeof input === 'string' || input instanceof URL ? String(input) : input.url;
      const target = new URL(rawUrl, shellUrl);
      const method = init?.method ?? 'GET';
      calls.push({ path: target.pathname, method });
      const headers = new Headers(init?.headers);
      if (cookie) headers.set('cookie', cookie);
      return fetch(target, { ...init, method, headers });
    };
    try {
      const firstClient = createAdminApiClient({ fetchImpl: actualBffFetch });
      const firstMutation = await firstClient.deleteOperation(id(), `orv13-vfy-auth-expired-${id()}`);
      expect(firstMutation.status).toBe(401);
      expect(calls).toEqual([{ path: '/admin/api/session', method: 'GET' }]);
      expect(expiredEvents).toBe(1);

      const secondClient = createAdminApiClient({ fetchImpl: actualBffFetch });
      const blockedRead = await secondClient.getComposeCatalog();
      const blockedWrite = await secondClient.deleteOperation(id(), `orv13-vfy-blocked-${id()}`);
      expect(blockedRead.status).toBe(401);
      expect(blockedWrite.status).toBe(401);
      expect(calls).toHaveLength(1);

      cookie = sessionCookie(platform);
      const verified = await secondClient.getSession({ recoverAuth: true });
      expect(verified.ok).toBe(true);
      expect(calls.at(-1)).toEqual({ path: '/admin/api/session', method: 'GET' });
      const recoveredRead = await firstClient.getComposeCatalog();
      expect(recoveredRead.ok).toBe(true);
      expect(calls.at(-1)).toEqual({ path: '/admin/api/compose/catalog', method: 'GET' });
    } finally {
      browserEventTarget.removeEventListener(ADMIN_AUTH_EXPIRED_EVENT, handleExpired);
      if (priorWindow) Object.defineProperty(globalThis, 'window', priorWindow);
      else Reflect.deleteProperty(globalThis, 'window');
    }
  }, 30000);
});
