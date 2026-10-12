import { createHash, createHmac, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:net';
import type { AddressInfo } from 'node:net';
import { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, GetObjectCommand, ListObjectVersionsCommand, PutBucketVersioningCommand, S3Client } from '@aws-sdk/client-s3';
import { SecretCatalogCreateSchema } from '../../../orchestrator/packages/contracts/src/secret-catalog';
import { createApp, type App } from '../../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../../orchestrator/services/orchestrator/src/db/db';
import { migrate } from '../../../orchestrator/services/orchestrator/src/db/migrations';
import { hashLocalPassword } from '../../../orchestrator/services/orchestrator/src/modules/auth/local-primitives';
import { createMaintenanceService } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/maintenance-service';
import { PostgresBackupSnapshotFence } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/backup-effect-fence';
import { createBackupSnapshotWriteGate } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/backup-effect-fence';
import { createAuditService } from '../../../orchestrator/services/orchestrator/src/modules/audit/audit';
import { createSecretInDb } from '../../../orchestrator/services/orchestrator/src/modules/secrets/secret-catalog-store';
import type { SecretCatalogKeyring } from '../../../orchestrator/services/orchestrator/src/modules/secrets/secret-revision-resolver';
import { artifactEncryptionContext, openWorkerArtifact, parseWorkerArtifactSidecar } from '../../../orchestrator/services/orchestrator/src/modules/artifacts/artifact-encryption';
import { CryptoStorageFacade } from '../../../orchestrator/services/orchestrator/src/modules/encryption/crypto-storage-facade';
import { buildOidcAdminComponents } from '../../../orchestrator/services/orchestrator/src/app/admin/oidc-boot';
import { startMockOidcIdp, type MockOidcIdp } from '../../../orchestrator/services/orchestrator/tests/stubs/mock-oidc-idp';
import { buildUsageEventsCsv, parseAdminUsageEventPage } from '../../../orchestrator/apps/admin-web/src/features/usage/state';
import { createTestIsolationContext, assertSafeIsolationConfig } from '../../isolation/namespace';
import { syntheticMetadataKeyProvider } from '../isolation';

const runId = `orv14_vfy_finance_${Date.now()}_${randomUUID().slice(0, 8)}`;
const baseDatabaseUrl = process.env.WFA_DATABASE_URL ?? 'postgresql://orv14_vfy:orv14-vfy-local-only@127.0.0.1:25414/orv14_vfy';
const baseRedisUrl = process.env.WFA_REDIS_URL ?? 'redis://127.0.0.1:26414/14';
const isolation = createTestIsolationContext({ runId, baseArtifactPath: 'tests/workflow-api/orv14-vfy/cost-adjustments-artifacts' });
const databaseUrl = isolation.getDatabaseUrlWithSchema(baseDatabaseUrl);
const redisUrl = isolation.getRedisUrl(baseRedisUrl);
assertSafeIsolationConfig({ databaseUrl, redisUrl, isolationCtx: isolation });

const baseDb = createDb(baseDatabaseUrl);
const tenantId = randomUUID();
const foreignTenantId = randomUUID();
const adminToken = `orv14-vfy-finance-admin-${randomUUID()}`;
const usageToken = `orv14-vfy-finance-usage-${randomUUID()}`;
const connectorCostToken = `orv14-vfy-finance-connector-cost-${randomUUID()}`;
const invocationGrantSecret = `orv14-vfy-finance-grant-${randomUUID()}`;
const cookieSecret = `orv14-vfy-finance-cookie-${randomUUID()}-synthetic-only`;
const previousAdminWeb = process.env.DU_ADMIN_WEB;
const previousAdminWebDist = process.env.DU_ADMIN_WEB_DIST;
const COST_CONNECTOR_ID = 'orv14-vfy-finance-openai';
const COST_CAPABILITY_ID = 'openai-gpt-4o-2024-08-06-chat-v1';
const COST_MODEL = 'gpt-4o-2024-08-06';
const storageBucket = `orv14-fin-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
const storageContainer = `orv14-vfy-finance-minio-${randomUUID().replaceAll('-', '').slice(0, 12)}`;
const storageAccessKeyId = randomBytes(10).toString('hex');
const storageSecretAccessKey = randomBytes(20).toString('hex');
const secretCatalogKeyring: SecretCatalogKeyring = {
  activeVersion: 'orv14-vfy-finance-k1',
  keys: { 'orv14-vfy-finance-k1': randomBytes(32) },
};
const s3Image = 'orv14-vfy/minio:RELEASE-2025-09-07';
const publicUploadEncryption = { keyProvider: syntheticMetadataKeyProvider(), keyRef: `${runId}:upload` };
const metadataEncryption = { keyProvider: syntheticMetadataKeyProvider(), keyRef: `${runId}:metadata` };

let app: App | undefined;
let oidcApp: App | undefined;
let oidcComponents: ReturnType<typeof buildOidcAdminComponents> | undefined;
let idp: MockOidcIdp | undefined;
let schemaCreated = false;
let s3ContainerCreated = false;
let s3BucketCreated = false;
let s3Endpoint = '';
let s3Client: S3Client | undefined;
let migrationDb: ReturnType<typeof createDb> | undefined;
let storageCredentialVersionRef = '';
let internalUrl = '';
let shellUrl = '';
let oidcInternalUrl = '';
let oidcShellUrl = '';
let oidcAdminCookie = '';
let oidcAdminCsrf = '';
let oidcAlertPrincipalId = '';
let apiKeyId = '';
let apiKey = '';
let profileId = '';
let profileRevision = 1;
let rootEventId = '';
let operationId = '';
let taskId = '';
let invocationId = '';
let reservationGroupId = '';
let evidenceArtifactId = '';
let usageOccurredAt = '';
let usageReceivedAt = '';
let idempotencyKey = '';
let firstCommand: Record<string, unknown> | undefined;

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

function docker(args: string[]): string {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

async function startOwnedMinio(): Promise<void> {
  const absent = spawnSync('docker', ['inspect', storageContainer], { stdio: 'ignore' });
  if (absent.status === 0) throw new Error('refusing to reuse a pre-existing MinIO container name');
  docker([
    'run', '--detach', '--rm', '--name', storageContainer,
    '--publish', '127.0.0.1::9000/tcp', '--tmpfs', '/data:rw,nosuid,nodev,size=1g',
    '--env', `MINIO_ROOT_USER=${storageAccessKeyId}`,
    '--env', `MINIO_ROOT_PASSWORD=${storageSecretAccessKey}`,
    s3Image, 'server', '/data', '--address', ':9000', '--console-address', ':9001',
  ]);
  s3ContainerCreated = true;
  const binding = docker(['port', storageContainer, '9000/tcp']).split(/\r?\n/)[0]?.trim();
  const port = binding?.match(/:(\d+)$/)?.[1];
  if (!port) throw new Error('owned MinIO container did not publish its S3 listener');
  s3Endpoint = `http://127.0.0.1:${port}`;
  s3Client = new S3Client({
    endpoint: s3Endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: storageAccessKeyId, secretAccessKey: storageSecretAccessKey },
  });
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${s3Endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* wait for the owned service to become ready */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('owned MinIO readiness endpoint did not become healthy');
  await s3Client.send(new CreateBucketCommand({ Bucket: storageBucket }));
  s3BucketCreated = true;
  await s3Client.send(new PutBucketVersioningCommand({ Bucket: storageBucket, VersioningConfiguration: { Status: 'Enabled' } }));
  process.stdout.write(`ORV14_VFY_S3 endpoint=${new URL(s3Endpoint).host} bucket=${storageBucket} isolatedContainer=${storageContainer} versioning=Enabled\n`);
}

function encode(value: unknown): string { return Buffer.from(JSON.stringify(value)).toString('base64url'); }
function sha256(value: string | Buffer): string { return createHash('sha256').update(value).digest('hex'); }

async function jsonResponse(response: Response): Promise<Record<string, any>> {
  const text = await response.text();
  try { return text ? JSON.parse(text) as Record<string, any> : {}; }
  catch { return { raw: text }; }
}

function safeProblemSummary(body: Record<string, any>): Record<string, string | number> {
  const summary: Record<string, string | number> = {};
  for (const field of ['type', 'title', 'status', 'code', 'correlationId'] as const) {
    const value = body[field];
    if (typeof value === 'string' || typeof value === 'number') summary[field] = value;
  }
  return summary;
}

async function oidcBff(path: string, init: RequestInit = {}, csrf = true): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set('cookie', oidcAdminCookie);
  if (csrf) headers.set('x-csrf-token', oidcAdminCsrf);
  return fetch(`${oidcShellUrl}/admin/api${path}`, { ...init, headers });
}

async function bffAdjustment(command: Record<string, unknown>, key: string, cookie = oidcAdminCookie, csrf = oidcAdminCsrf, base = oidcShellUrl): Promise<Response> {
  return fetch(`${base}/admin/api/cost-control/adjustments`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(command),
  });
}

async function publishPriceBook(): Promise<void> {
  const prefix = `orv14-vfy-finance-price-${randomUUID()}`;
  const post = async (path: string, body: unknown, key: string): Promise<{ response: Response; body: Record<string, any> }> => {
    const response = await fetch(`${internalUrl}/api/internal/cost-control${path}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'application/json', 'idempotency-key': key },
      body: JSON.stringify(body),
    });
    return { response, body: await jsonResponse(response) };
  };
  const draft = await post('/prices/draft', { expectedHeadRevision: 0, tiers: [{
    provider: 'openai', modelId: COST_MODEL, priceVersion: 1, effectiveFrom: '2026-10-01T00:00:00Z',
    inputMicrousdPerMillion: 1_000_000, outputMicrousdPerMillion: 1_000_000,
  }] }, `${prefix}-draft`);
  if (draft.response.status !== 201) throw new Error(`price draft returned ${draft.response.status}: ${JSON.stringify(draft.body)}`);
  const review = await post('/prices/review', { expectedState: 'DRAFT', expectedHeadRevision: 1 }, `${prefix}-review`);
  if (review.response.status !== 200) throw new Error(`price review returned ${review.response.status}: ${JSON.stringify(review.body)}`);
  const published = await post('/prices/publish', { expectedState: 'REVIEW', expectedHeadRevision: 1, reviewerReason: 'ORV14 independent synthetic fixture' }, `${prefix}-publish`);
  if (published.response.status !== 200) throw new Error(`price publish returned ${published.response.status}: ${JSON.stringify(published.body)}`);
}

async function createAndSettleUsageRoot(label: string): Promise<{ eventId: string; operationId: string; taskId: string; invocationId: string; reservationGroupId: string; costProvenance: Record<string, unknown> }> {
  if (!app) throw new Error('finance app is not initialized');
  const opId = randomUUID();
  const tId = randomUUID();
  const callId = randomUUID();
  const groupId = randomUUID();
  const eventId = `orv14-vfy-finance-${label}-${randomUUID()}`;
  const nowSeconds = Math.floor(Date.now() / 1000);
  await app.db.query(
    `INSERT INTO operations
      (id,tenant_id,api_key_id,profile_id,profile_revision,business_id,business_version,action,state,state_version,correlation_id,created_at,updated_at)
     VALUES($1,$2,$3,$4,$5,'document-core','1.0.0','extract','RUNNING',1,$6,now(),now())`,
    [opId, tenantId, apiKeyId, profileId, profileRevision, `orv14-vfy-finance:${callId}`],
  );
  await app.db.query(
    `INSERT INTO tasks(id,operation_id,task_key,kind,state,attempt,max_attempts,created_at,updated_at)
     VALUES($1,$2,'finance-event','connector','RUNNING',1,3,now(),now())`, [tId, opId],
  );
  const claims = {
    audience: 'connector' as const, tenantId, operationId: opId, taskId: tId,
    stepKey: 'finance-event', invocationId: callId,
    inputHash: `sha256:${sha256(`orv14-vfy-finance-input:${callId}`)}`,
    connectorId: COST_CONNECTOR_ID, connectorRevision: 1, bindingSlot: 'primary', exp: nowSeconds + 600, iat: nowSeconds,
    costContext: {
      selectionState: 'DEFERRED' as const, apiKeyId, profileId, profileRevision,
      businessId: 'document-core', businessVersion: '1.0.0', action: 'extract', attempt: 1,
      priceRevision: null, budgetReservationGroupId: groupId, budgetPins: [],
    },
  };
  const head = encode({ alg: 'HS256', typ: 'JWT' });
  const payload = encode(claims);
  const grant = `${head}.${payload}.${createHmac('sha256', invocationGrantSecret).update(`${head}.${payload}`).digest('base64url')}`;
  const proof = {
    version: 'cost-bound-v1', capabilityId: COST_CAPABILITY_ID, connectorId: COST_CONNECTOR_ID, connectorRevision: 1,
    provider: 'openai', model: COST_MODEL, requestDigest: `sha256:${sha256(`orv14-vfy-finance-proof:${callId}`)}`,
    inputUpperBoundTokens: 128_000, outputLimit: 16_384, outputLimitField: 'max_tokens', artifactCount: 0,
    hasSession: false, hasTools: false, hasUnknownUnits: false, retryCount: 0,
  };
  const preflightResponse = await fetch(`${internalUrl}/api/internal/cost-control/reservations/preflight`, {
    method: 'POST', headers: { authorization: `Bearer ${connectorCostToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ grant, proof }),
  });
  const preflight = await jsonResponse(preflightResponse);
  if (preflightResponse.status !== 200) throw new Error(`cost preflight returned ${preflightResponse.status}: ${JSON.stringify(preflight)}`);
  const transition = await fetch(`${internalUrl}/api/internal/cost-control/reservations/transitions`, {
    method: 'POST', headers: { authorization: `Bearer ${connectorCostToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ grant, reservationGroupId: groupId, operationId: opId, taskId: tId, invocationId: callId, attempt: 1, target: 'RUNNING' }),
  });
  if (transition.status !== 200) throw new Error(`reservation RUNNING transition returned ${transition.status}: ${await transition.text()}`);
  const occurredAt = new Date(Date.now() - 1_000).toISOString();
  const usage = {
    eventId, invocationId: callId, operationId: opId, taskId: tId,
    units: { inputTokens: 60, outputTokens: 40 }, costMicrousd: 100,
    currency: 'USD', measurement: 'measured', provider: 'openai', model: COST_MODEL,
    costStatus: 'measured', occurredAt,
    providerReportedCost: { costMicrousd: 9_999, currency: 'USD', source: 'provider-response', status: 'unverified' },
    costProvenance: {
      version: 1, tenantId, apiKeyId, profileId, profileRevision,
      businessId: 'document-core', businessVersion: '1.0.0', action: 'extract', attempt: 1,
      stepKey: 'finance-event', connectorId: COST_CONNECTOR_ID, connectorRevision: 1, durationMs: 50,
      reservationGroupId: groupId,
      selectedAt: preflight.selection.selectedAt,
      confidence: preflight.confidence,
      priceRevision: preflight.selection.priceRevision,
      priceSnapshot: preflight.selection.pricingTier,
      budgetPins: preflight.selection.budgetPins,
      costBoundCapabilityId: COST_CAPABILITY_ID,
      inputUpperBoundTokens: 128_000, outputLimitTokens: 16_384,
    },
  };
  const ingested = await fetch(`${internalUrl}/api/runtime/v1/usage-events`, {
    method: 'POST', headers: { authorization: `Bearer ${usageToken}`, 'content-type': 'application/json' }, body: JSON.stringify(usage),
  });
  const ack = await jsonResponse(ingested);
  if (ingested.status !== 200) throw new Error(`usage ingestion returned ${ingested.status}: ${JSON.stringify(ack)}`);
  usageOccurredAt = occurredAt;
  usageReceivedAt = new Date().toISOString();
  return { eventId, operationId: opId, taskId: tId, invocationId: callId, reservationGroupId: groupId, costProvenance: usage.costProvenance };
}

async function uploadEvidence(): Promise<void> {
  const content = Buffer.from(`ORV14 synthetic financial evidence\n${randomUUID()}\n`);
  const response = await fetch(`${internalUrl}/api/internal/operations/uploads?tenantId=${tenantId}&apiKeyId=${apiKeyId}&fileName=orv14-finance-evidence.txt`, {
    method: 'POST', headers: { authorization: `Bearer ${adminToken}`, 'content-type': 'text/plain', 'content-length': String(content.length) }, body: content,
  });
  const body = await jsonResponse(response);
  if (response.status !== 201 || typeof body['artifactId'] !== 'string') throw new Error(`encrypted evidence upload returned ${response.status}: ${JSON.stringify(body)}`);
  evidenceArtifactId = body['artifactId'];
  const ready = await app!.db.query<{ state: string; purpose: string; storage_generation_id: string | null; storage_version_id: string | null; manifest_version_id: string | null }>(
    'SELECT state,purpose,storage_generation_id::text,storage_version_id,manifest_version_id FROM artifacts WHERE id=$1 AND tenant_id=$2', [evidenceArtifactId, tenantId],
  );
  expect(ready.rows[0]?.state).toBe('READY');
  expect(ready.rows[0]?.purpose).toBe('input');
  expect(ready.rows[0]?.storage_generation_id).toEqual(expect.any(String));
  expect(ready.rows[0]?.storage_version_id).toEqual(expect.any(String));
  expect(ready.rows[0]?.manifest_version_id).toEqual(expect.any(String));
}

async function localLogin(username: string, password: string): Promise<{ cookie: string; csrfToken: string }> {
  const form = await fetch(`${shellUrl}/admin/login`, { redirect: 'manual' });
  const html = await form.text();
  const csrf = /name="csrf"[^>]*value="([^"]+)"/.exec(html)?.[1];
  const loginCookie = /(?:^|[,;]\s*)du_local_login=([^;,\s]+)/.exec(form.headers.get('set-cookie') ?? '')?.[1];
  if (!csrf || !loginCookie) throw new Error('local finance login form did not provide its CSRF cookie');
  const response = await fetch(`${shellUrl}/admin/login`, {
    method: 'POST', redirect: 'manual', headers: { cookie: `du_local_login=${loginCookie}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ username, password, csrf, redirect: '/admin' }),
  });
  const sessionId = /(?:^|[,;]\s*)du_session=([A-Za-z0-9_-]{43})/.exec(response.headers.get('set-cookie') ?? '')?.[1];
  if (response.status !== 302 || !sessionId) throw new Error(`local finance login returned ${response.status}`);
  const cookie = `du_session=${sessionId}`;
  const sessionResponse = await fetch(`${shellUrl}/admin/api/session`, { headers: { cookie } });
  const sessionBody = await jsonResponse(sessionResponse);
  if (sessionResponse.status !== 200 || typeof sessionBody['csrfToken'] !== 'string') throw new Error(`local finance session read returned ${sessionResponse.status}`);
  return { cookie, csrfToken: sessionBody['csrfToken'] };
}

async function oidcLogin(startUrl: string, callbackUrl: string, subject: string): Promise<string> {
  idp!.setPrincipal({ sub: subject, platformAdmin: true });
  const start = await fetch(`${startUrl}/admin/login`, { redirect: 'manual' });
  if (start.status !== 302) throw new Error(`synthetic OIDC start returned ${start.status}`);
  const authorizeUrl = start.headers.get('location');
  if (!authorizeUrl) throw new Error('synthetic OIDC start omitted its authorize URL');
  const authorize = await fetch(authorizeUrl, { redirect: 'manual' });
  if (authorize.status !== 302) throw new Error(`synthetic IdP authorize returned ${authorize.status}`);
  const callback = new URL(authorize.headers.get('location') ?? '');
  const completed = await fetch(`${callbackUrl}${callback.pathname}${callback.search}`, { redirect: 'manual' });
  const sessionId = /(?:^|[,;]\s*)du_session=([A-Za-z0-9_-]{43})/.exec(completed.headers.get('set-cookie') ?? '')?.[1];
  if (completed.status !== 302 || !sessionId) throw new Error(`synthetic OIDC callback returned ${completed.status}`);
  return `du_session=${sessionId}`;
}

async function oidcCsrf(cookie: string): Promise<string> {
  const response = await fetch(`${oidcShellUrl}/admin/api/session`, { headers: { cookie } });
  const body = await jsonResponse(response);
  if (response.status !== 200 || typeof body['csrfToken'] !== 'string') throw new Error(`synthetic OIDC session read returned ${response.status}`);
  return body['csrfToken'];
}

async function newOidcAdmin(subject: string): Promise<{ cookie: string; csrfToken: string; principalId: string }> {
  const cookie = await oidcLogin(oidcShellUrl, oidcShellUrl, subject);
  const csrfToken = await oidcCsrf(cookie);
  const self = await fetch(`${oidcShellUrl}/admin/api/cost-alerts/recipients/self`, {
    method: 'POST', headers: { cookie, 'x-csrf-token': csrfToken, 'content-type': 'application/json' }, body: '{}',
  });
  const body = await jsonResponse(self);
  if (self.status !== 200 || typeof body['principalId'] !== 'string') {
    throw new Error(`synthetic OIDC session recipient pin returned ${self.status}: ${JSON.stringify(body)}`);
  }
  return { cookie, csrfToken, principalId: body['principalId'] };
}

async function bffAdjustmentFor(command: Record<string, unknown>, key: string, cookie: string, csrf: string): Promise<Response> {
  return fetch(`${oidcShellUrl}/admin/api/cost-control/adjustments`, {
    method: 'POST',
    headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json', 'idempotency-key': key },
    body: JSON.stringify(command),
  });
}

beforeAll(async () => {
  process.stdout.write(`ORV14_VFY_NAMESPACE suite=finance runId=${runId} postgresSchema=${isolation.dbSchema} redisDb=${isolation.redisDbIndex} redisPrefix=${isolation.redisPrefix} artifactDir=${isolation.artifactDir}\n`);
  process.env.DU_ADMIN_WEB = '1';
  process.env.DU_ADMIN_WEB_DIST = 'tests/workflow-api/orv14-vfy/no-bundle';
  await baseDb.query(`CREATE SCHEMA "${isolation.dbSchema}"`);
  schemaCreated = true;
  await startOwnedMinio();
  migrationDb = createDb(databaseUrl);
  const migrationResult = await migrate(migrationDb);
  const migrationLedger = await migrationDb.query<{ count: number | string }>('SELECT count(*)::int AS count FROM schema_migrations');
  process.stdout.write(`ORV14_VFY_MIGRATIONS appliedThisRun=${migrationResult.applied.length} recorded=${Number(migrationLedger.rows[0]?.count ?? -1)}\n`);
  await migrationDb.query('INSERT INTO tenants(id,name,state) VALUES($1,$2,\'ACTIVE\'),($3,$4,\'ACTIVE\')', [tenantId, 'ORV14 finance tenant', foreignTenantId, 'ORV14 finance foreign tenant']);
  const storageCredential = await createSecretInDb(migrationDb, SecretCatalogCreateSchema.parse({
    tenantId,
    name: 'ORV14 verifier isolated MinIO credential',
    purpose: 'storage.credential',
    services: ['orchestrator'],
    provider: { kind: 'managed_value' },
    value: { kind: 'literal', value: JSON.stringify({ accessKeyId: storageAccessKeyId, secretAccessKey: storageSecretAccessKey }) },
  }), undefined, secretCatalogKeyring, createBackupSnapshotWriteGate());
  storageCredentialVersionRef = `${storageCredential.secretId}@${storageCredential.revision}`;
  await migrationDb.close();
  migrationDb = undefined;
  const internalPort = await availablePort();
  const shellPort = await availablePort();
  app = await createApp({
    host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort,
    databaseUrl, redisUrl, autoMigrate: true, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken, adminLocalAuthEnabled: true,
    usageToken, costControlToken: connectorCostToken, invocationGrantSecret,
    secretCatalogKeyring,
    artifactStorage: {
      backend: 's3', bucket: storageBucket, region: 'us-east-1', endpoint: s3Endpoint, forcePathStyle: true,
      credentialVersionRef: storageCredentialVersionRef, credentialOwnerTenantId: tenantId,
    },
    adminShellCookieSecret: cookieSecret, adminShellHost: '127.0.0.1', adminShellPort: shellPort,
    jsonBaseUrl: `http://127.0.0.1:${internalPort}`,
    publicUploadEncryption,
    metadataEncryption,
  });
  await app.listen();
  const internalAddress = app.internalServer.address();
  if (!internalAddress || typeof internalAddress === 'string') throw new Error('finance internal listener did not bind');
  internalUrl = `http://127.0.0.1:${internalAddress.port}`;
  shellUrl = app.adminShell!.url;

  // Keep a real verified IdP-backed platform Admin session in the same
  // isolated schema. This is used to prove financial authority remains an
  // application role when its independent Cost Alerts recipient is revoked.
  idp = await startMockOidcIdp();
  const oidcShellPort = await availablePort();
  const oidcInternalPort = await availablePort();
  const oidcRedirectUri = `http://127.0.0.1:${oidcShellPort}/admin/oidc/callback`;
  oidcComponents = buildOidcAdminComponents({
    DU_ADMIN_OIDC_ISSUER: idp.issuer,
    DU_ADMIN_OIDC_CLIENT_ID: `orv14-vfy-finance-${randomUUID()}`,
    DU_ADMIN_OIDC_CLIENT_SECRET: `orv14-vfy-finance-secret-${randomUUID()}-synthetic`,
    DU_ADMIN_OIDC_REDIRECT_URI: oidcRedirectUri,
    DU_ADMIN_OIDC_PUBLIC_ORIGIN: new URL(oidcRedirectUri).origin,
    DU_ADMIN_OIDC_SESSION_BACKEND: 'memory',
    DU_ADMIN_OIDC_ALLOWED_ISSUERS: idp.issuer,
  });
  if (!oidcComponents) throw new Error('synthetic OIDC components did not configure');
  oidcApp = await createApp({
    host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort: oidcInternalPort,
    databaseUrl, redisUrl, autoMigrate: true, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken, adminLocalAuthEnabled: false,
    adminIdentityAuth: { mode: 'oidc', localEnabled: false, oidc: null },
    adminOidcFlow: oidcComponents.adminOidcFlow, adminSessionStore: oidcComponents.adminSessionStore,
    usageToken, costControlToken: connectorCostToken, invocationGrantSecret,
    secretCatalogKeyring,
    artifactStorage: {
      backend: 's3', bucket: storageBucket, region: 'us-east-1', endpoint: s3Endpoint, forcePathStyle: true,
      credentialVersionRef: storageCredentialVersionRef, credentialOwnerTenantId: tenantId,
    },
    adminShellCookieSecret: cookieSecret, adminShellHost: '127.0.0.1', adminShellPort: oidcShellPort,
    jsonBaseUrl: `http://127.0.0.1:${oidcInternalPort}`,
    // This instance models another replica of the same deployment and must
    // share the exact envelope key reference used by the uploading replica.
    publicUploadEncryption,
    metadataEncryption,
  });
  await oidcApp.listen();
  const oidcAddress = oidcApp.internalServer.address();
  if (!oidcAddress || typeof oidcAddress === 'string') throw new Error('finance OIDC internal listener did not bind');
  oidcInternalUrl = `http://127.0.0.1:${oidcAddress.port}`;
  oidcShellUrl = oidcApp.adminShell!.url;
  apiKey = `orv14-vfy-finance-key-${randomUUID()}`;
  const insertedKey = await app.db.query<{ id: string }>(
    'INSERT INTO api_keys(tenant_id,hash,prefix,status,name) VALUES($1,$2,$3,\'ACTIVE\',$4) RETURNING id',
    [tenantId, sha256(apiKey), 'orv14-vfy-finance', 'ORV14 synthetic finance key'],
  );
  apiKeyId = insertedKey.rows[0]!.id;
  profileId = randomUUID();
  await app.db.query(
    `INSERT INTO profile_names(profile_id,tenant_id,api_key_id,business_id,business_version,action,profile_name)
     VALUES($1,$2,$3,'document-core','1.0.0','extract','ORV14 finance Profile')`,
    [profileId, tenantId, apiKeyId],
  );
  await publishPriceBook();
  const root = await createAndSettleUsageRoot('primary');
  rootEventId = root.eventId; operationId = root.operationId; taskId = root.taskId;
  invocationId = root.invocationId; reservationGroupId = root.reservationGroupId;
  const probe = await app.db.query<{ received_at: Date | string }>('SELECT received_at FROM usage_events WHERE event_id=$1', [rootEventId]);
  usageReceivedAt = probe.rows[0]?.received_at instanceof Date ? probe.rows[0]!.received_at.toISOString() : String(probe.rows[0]?.received_at ?? '');
  await uploadEvidence();
  idempotencyKey = `orv14-vfy-finance-${randomUUID()}`;
  firstCommand = { tenantId, rootEventId, expectedAdjustmentRevision: 0, reason: 'Correct computed charge with synthetic supporting evidence', evidenceArtifactId, kind: 'correction', targetChargeMicrousd: 80 };
  const mainOidc = await newOidcAdmin(`orv14-vfy-finance-sub-${randomUUID()}`);
  oidcAdminCookie = mainOidc.cookie;
  oidcAdminCsrf = mainOidc.csrfToken;
  oidcAlertPrincipalId = mainOidc.principalId;
}, 180_000);

afterAll(async () => {
  const errors: unknown[] = [];
  try { await oidcApp?.close({ timeoutMs: 0, pollIntervalMs: 10 }); } catch (error) { errors.push(error); }
  oidcApp = undefined;
  try { await oidcComponents?.close?.(); } catch (error) { errors.push(error); }
  try { await idp?.close(); } catch (error) { errors.push(error); }
  try { await app?.close({ timeoutMs: 0, pollIntervalMs: 10 }); } catch (error) { errors.push(error); }
  app = undefined;
  try { await migrationDb?.close(); } catch (error) { errors.push(error); }
  migrationDb = undefined;
  if (schemaCreated) {
    try { await baseDb.query(`DROP SCHEMA "${isolation.dbSchema}" CASCADE`); } catch (error) { errors.push(error); }
  }
  let schemaAbsent = false;
  try {
    const remaining = await baseDb.query<{ present: boolean }>('SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS present', [isolation.dbSchema]);
    schemaAbsent = remaining.rows[0]?.present !== true;
    if (!schemaAbsent) errors.push(new Error(`owned schema remains: ${isolation.dbSchema}`));
  } catch (error) { errors.push(error); }
  try { await baseDb.close(); } catch (error) { errors.push(error); }
  let bucketAbsent = !s3BucketCreated;
  if (s3Client && s3BucketCreated) {
    try {
      let keyMarker: string | undefined;
      let versionIdMarker: string | undefined;
      let truncated = true;
      while (truncated) {
        const listed = await s3Client.send(new ListObjectVersionsCommand({
          Bucket: storageBucket,
          ...(keyMarker ? { KeyMarker: keyMarker } : {}),
          ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
        }));
        for (const version of [...(listed.Versions ?? []), ...(listed.DeleteMarkers ?? [])]) {
          if (version.Key && version.VersionId) {
            await s3Client.send(new DeleteObjectCommand({ Bucket: storageBucket, Key: version.Key, VersionId: version.VersionId }));
          }
        }
        truncated = listed.IsTruncated === true;
        keyMarker = listed.NextKeyMarker;
        versionIdMarker = listed.NextVersionIdMarker;
      }
      await s3Client.send(new DeleteBucketCommand({ Bucket: storageBucket }));
      s3BucketCreated = false;
      bucketAbsent = true;
    } catch (error) { errors.push(error); }
  }
  try { s3Client?.destroy(); } catch (error) { errors.push(error); }
  let containerAbsent = !s3ContainerCreated;
  if (s3ContainerCreated) {
    try {
      const exists = spawnSync('docker', ['inspect', storageContainer], { stdio: 'ignore' });
      if (exists.status === 0) docker(['stop', storageContainer]);
      const afterStop = spawnSync('docker', ['inspect', storageContainer], { stdio: 'ignore' });
      containerAbsent = afterStop.status !== 0;
      if (!containerAbsent) errors.push(new Error(`owned MinIO container remains: ${storageContainer}`));
    } catch (error) { errors.push(error); }
  }
  isolation.cleanupArtifactDir();
  if (previousAdminWeb === undefined) delete process.env.DU_ADMIN_WEB; else process.env.DU_ADMIN_WEB = previousAdminWeb;
  if (previousAdminWebDist === undefined) delete process.env.DU_ADMIN_WEB_DIST; else process.env.DU_ADMIN_WEB_DIST = previousAdminWebDist;
  process.stdout.write(`ORV14_VFY_CLEANUP schemaAbsent=${schemaAbsent} ownedBucketAbsent=${bucketAbsent} ownedContainerAbsent=${containerAbsent}\n`);
  if (errors.length) throw new AggregateError(errors, 'ORV14 financial fixture cleanup failed');
}, 30_000);

describe('ORV14 independent actual PostgreSQL financial adjustments', () => {
  test('diagnoses the valid cookie-authenticated internal adjustment response', async () => {
    expect(app).toBeDefined();
    const staleCommand = { ...firstCommand, expectedAdjustmentRevision: 999 };
    const rowResult = await app!.db.query<{
      storage_key: string; upload_token: string; storage_version_id: string; manifest_version_id: string;
      storage_generation_id: string; sha256: string; size_bytes: number;
    }>(`SELECT storage_key,upload_token,storage_version_id,manifest_version_id,storage_generation_id::text,sha256,size_bytes
          FROM artifacts WHERE id=$1 AND tenant_id=$2 AND state='READY'`, [evidenceArtifactId, tenantId]);
    const pin = rowResult.rows[0];
    if (!pin || !s3Client) throw new Error('diagnostic could not load the owned evidence row or S3 client');
    const sidecarObject = await s3Client.send(new GetObjectCommand({ Bucket: storageBucket, Key: `${pin.storage_key}.crypto-manifest.json`, VersionId: pin.manifest_version_id }));
    const object = await s3Client.send(new GetObjectCommand({ Bucket: storageBucket, Key: pin.storage_key, VersionId: pin.storage_version_id }));
    const sidecarRaw = JSON.parse(await sidecarObject.Body!.transformToString('utf8')) as Record<string, any>;
    const sidecar = parseWorkerArtifactSidecar(sidecarRaw['encryption'] ?? sidecarRaw);
    const manifest = sidecar.manifest as unknown as { aad: string; dek: { keyRef: string; keyVersion: number } };
    const aad = JSON.parse(Buffer.from(manifest.aad, 'base64').toString('utf8')) as { context?: Record<string, unknown> };
    let plaintextSha256Matches = false;
    let plaintextSizeMatches = false;
    let decryptSucceeded = false;
    try {
      const plaintext = await openWorkerArtifact({
        sidecar,
        ciphertext: Buffer.from(await object.Body!.transformToByteArray()),
        context: artifactEncryptionContext({ tenantId, artifactId: evidenceArtifactId, objectVersion: pin.upload_token }),
        seam: { facade: new CryptoStorageFacade(publicUploadEncryption.keyProvider) },
      });
      decryptSucceeded = true;
      plaintextSha256Matches = sha256(plaintext) === pin.sha256;
      plaintextSizeMatches = plaintext.byteLength === Number(pin.size_bytes);
      plaintext.fill(0);
    } catch { /* report only the outcome flags; never expose crypto or provider material */ }
    process.stdout.write(`ORV14_VFY_EVIDENCE_PIN_DIAGNOSTIC ${JSON.stringify({
      persistedSidecarKind: sidecarRaw['kind'],
      purpose: aad.context?.purpose,
      objectVersionMatches: aad.context?.objectVersion === pin.upload_token,
      tenantContextPresent: typeof aad.context?.tenantId === 'string',
      artifactContextPresent: typeof aad.context?.artifactId === 'string',
      wrappedKeyRefMatches: manifest.dek.keyRef === publicUploadEncryption.keyRef,
      objectVersionMatchesS3: object.VersionId === pin.storage_version_id,
      sidecarVersionMatchesS3: sidecarObject.VersionId === pin.manifest_version_id,
      hasGenerationAndPins: Boolean(pin.storage_generation_id && pin.storage_version_id && pin.manifest_version_id),
      decryptSucceeded, plaintextSha256Matches, plaintextSizeMatches,
    })}\n`);
    const response = await fetch(`${oidcInternalUrl}/api/internal/cost-control/adjustments`, {
      method: 'POST',
      headers: {
        cookie: oidcAdminCookie,
        'x-csrf-token': oidcAdminCsrf,
        'content-type': 'application/json',
        'idempotency-key': `orv14-vfy-internal-diagnostic-${randomUUID()}`,
      },
      body: JSON.stringify(staleCommand),
    });
    const body = await jsonResponse(response);
    const safe = safeProblemSummary(body);
    for (const field of ['detail', 'message'] as const) {
      const value = body[field];
      if (typeof value === 'string') safe[field] = value.replace(/[0-9a-f]{8}-[0-9a-f-]{27,}/gi, '[uuid]').slice(0, 240);
    }
    process.stdout.write(`ORV14_VFY_DIRECT_INTERNAL_DIAGNOSTIC ${JSON.stringify({ status: response.status, body: safe })}\n`);
    expect(response.status).toBe(409);
    expect(body.code).toBe('COST_ADJUSTMENT_CAS_CONFLICT');
  });

  test('records 100 → 80 → refund 30 as 50 net, exact replay once, preserves original units/time, and exports provider report separately', async () => {
    expect(app).toBeDefined();
    const created = await bffAdjustment(firstCommand!, idempotencyKey);
    const createdBody = await jsonResponse(created);
    if (created.status !== 201) {
      throw new Error(`financial adjustment returned ${created.status}; safe problem=${JSON.stringify(safeProblemSummary(createdBody))}`);
    }
    expect(createdBody).toMatchObject({ outcome: 'ADJUSTED', initialChargeMicrousd: 100, grossChargeMicrousd: 80, refundedMicrousd: 0, netChargeMicrousd: 80, adjustmentRevision: 1, replayed: false });
    const replay = await bffAdjustment(firstCommand!, idempotencyKey);
    expect(replay.status).toBe(200);
    expect(await jsonResponse(replay)).toMatchObject({ adjustmentRevision: 1, netChargeMicrousd: 80, replayed: true });
    const changedBody = await bffAdjustment({ ...firstCommand!, targetChargeMicrousd: 79 }, idempotencyKey);
    expect(changedBody.status).toBe(409);
    expect((await jsonResponse(changedBody)).code).toBe('IDEMPOTENCY_CONFLICT');

    const refund = { tenantId, rootEventId, expectedAdjustmentRevision: 1, reason: 'Record verified partial refund', evidenceArtifactId, kind: 'refund', refundMicrousd: 30 };
    const refunded = await bffAdjustment(refund, `orv14-vfy-refund-${randomUUID()}`);
    const refundBody = await jsonResponse(refunded);
    expect(refunded.status).toBe(201);
    expect(refundBody).toMatchObject({ initialChargeMicrousd: 100, grossChargeMicrousd: 80, refundedMicrousd: 30, netChargeMicrousd: 50, adjustmentRevision: 2 });

    const ledger = await app!.db.query<{ count: string }>('SELECT count(*)::text AS count FROM usage_financial_adjustments WHERE tenant_id=$1 AND root_event_id=$2', [tenantId, rootEventId]);
    expect(ledger.rows[0]?.count).toBe('2');
    const immutable = await app!.db.query<{ cost_microusd: number; input_tokens: number; output_tokens: number; occurred_at: Date | string }>(
      `SELECT (payload->>'costMicrousd')::int AS cost_microusd,(payload->'units'->>'inputTokens')::int AS input_tokens,
              (payload->'units'->>'outputTokens')::int AS output_tokens,(payload->>'occurredAt')::timestamptz AS occurred_at
         FROM usage_events WHERE event_id=$1`, [rootEventId],
    );
    expect(immutable.rows[0]).toMatchObject({ cost_microusd: 100, input_tokens: 60, output_tokens: 40 });
    const immutableOccurredAt = immutable.rows[0]?.occurred_at instanceof Date ? immutable.rows[0]!.occurred_at.toISOString() : String(immutable.rows[0]?.occurred_at);
    expect(Date.parse(immutableOccurredAt)).toBe(Date.parse(usageOccurredAt));

    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const eventsResponse = await oidcBff(`/usage/events?tenantId=${tenantId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&operationId=${operationId}`);
    expect(eventsResponse.status).toBe(200);
    const page = await eventsResponse.json() as unknown;
    const parsed = parseAdminUsageEventPage(page, tenantId);
    expect(parsed).not.toBeNull();
    expect(parsed!.events).toHaveLength(1);
    expect(parsed!.events[0]).toMatchObject({ eventId: rootEventId, costMicrousd: 100, units: { inputTokens: 60, outputTokens: 40 }, financialAccounting: { initialChargeMicrousd: 100, grossChargeMicrousd: 80, refundedMicrousd: 30, netChargeMicrousd: 50, adjustmentRevision: 2 }, providerReportedCost: { costMicrousd: 9_999, status: 'unverified' } });
    const csv = buildUsageEventsCsv(parsed!.events, tenantId);
    expect(csv).toContain('"computed_cost_microusd"');
    expect(csv).toContain('"provider_reported_cost_microusd_unverified"');
    expect(csv).toContain('"financial_initial_charge_microusd"');
    expect(csv).toContain('"financial_net_charge_microusd"');
    const row = csv.split('\r\n')[1] ?? '';
    expect(row).toContain('"100"');
    expect(row).toContain('"9999"');
    expect(row).toContain('"50"');
    expect(row).not.toContain('"9999","50"');
    const summaryResponse = await oidcBff(`/usage?tenantId=${tenantId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}`);
    expect(summaryResponse.status).toBe(200);
    const summary = await jsonResponse(summaryResponse);
    expect(summary.totals).toMatchObject({ operations: 1, inputTokens: 60, outputTokens: 40, costMicrousd: 50 });
  }, 60_000);

  test('keeps local USER financial and usage reads inside current API-key AND Profile grants', async () => {
    const password = `orv14-vfy-finance-user-${randomUUID()}-synthetic`;
    const username = `finance-user-${randomUUID()}`;
    const userId = randomUUID();
    await app!.db.query(
      `INSERT INTO admin_local_users(id,tenant_id,username_normalized,password_hash,role,is_enabled,is_locked,version,legacy_password_reset_required)
       VALUES($1,$2,$3,$4,'operator',true,false,1,false)`,
      [userId, tenantId, username, await hashLocalPassword(password)],
    );
    await app!.db.query('INSERT INTO admin_local_user_api_key_grants(tenant_id,user_id,api_key_id) VALUES($1,$2,$3)', [tenantId, userId, apiKeyId]);
    await app!.db.query('INSERT INTO admin_local_user_profile_grants(tenant_id,user_id,profile_id) VALUES($1,$2,$3)', [tenantId, userId, profileId]);
    const login = await localLogin(username, password);
    const userCookie = login.cookie;
    const userCsrf = login.csrfToken;
    const from = new Date(Date.now() - 86_400_000).toISOString();
    const to = new Date(Date.now() + 86_400_000).toISOString();
    const userRequest = (path: string) => fetch(`${shellUrl}/admin/api${path}`, { headers: { cookie: userCookie } });
    const historyPath = `/cost-control/adjustments?tenantId=${tenantId}&rootEventId=${encodeURIComponent(rootEventId)}`;
    const eventPath = `/usage/events?tenantId=${tenantId}&from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&operationId=${operationId}`;
    const hiddenHistory = (page: Record<string, unknown>) => ({
      adjustmentRevision: page['adjustmentRevision'],
      headAdjustmentEventId: page['headAdjustmentEventId'],
      eligible: page['eligible'],
      blockers: page['blockers'],
      initialChargeMicrousd: page['initialChargeMicrousd'],
      grossChargeMicrousd: page['grossChargeMicrousd'],
      refundedMicrousd: page['refundedMicrousd'],
      netChargeMicrousd: page['netChargeMicrousd'],
      originalAttribution: page['originalAttribution'],
      items: page['items'],
    });
    const history = await userRequest(historyPath);
    expect(history.status).toBe(200);
    expect(await history.json()).toMatchObject({ tenantId, rootEventId });
    const visibleEvent = await userRequest(eventPath);
    expect(visibleEvent.status).toBe(200);
    expect((await visibleEvent.json() as { events: Array<{ eventId: string }> }).events.map((item) => item.eventId)).toContain(rootEventId);

    await app!.db.query('DELETE FROM admin_local_user_api_key_grants WHERE tenant_id=$1 AND user_id=$2 AND api_key_id=$3', [tenantId, userId, apiKeyId]);
    const noKeyHistory = await userRequest(historyPath);
    expect(noKeyHistory.status).toBe(200);
    const noKeyPage = await jsonResponse(noKeyHistory);
    expect(noKeyPage).toMatchObject({
      adjustmentRevision: 0,
      headAdjustmentEventId: null,
      eligible: false,
      blockers: ['ROOT_NOT_FOUND'],
      initialChargeMicrousd: null,
      grossChargeMicrousd: null,
      refundedMicrousd: null,
      netChargeMicrousd: null,
      originalAttribution: null,
      items: [],
    });
    const unknownRootHistory = await userRequest(`/cost-control/adjustments?tenantId=${tenantId}&rootEventId=${randomUUID()}`);
    expect(unknownRootHistory.status).toBe(200);
    expect(hiddenHistory(noKeyPage as Record<string, unknown>)).toEqual(hiddenHistory(await jsonResponse(unknownRootHistory) as Record<string, unknown>));
    const noKeyEvents = await userRequest(eventPath);
    expect(noKeyEvents.status).toBe(200);
    expect((await noKeyEvents.json() as { events: Array<{ eventId: string }> }).events.map((item) => item.eventId)).not.toContain(rootEventId);

    await app!.db.query('INSERT INTO admin_local_user_api_key_grants(tenant_id,user_id,api_key_id) VALUES($1,$2,$3)', [tenantId, userId, apiKeyId]);
    await app!.db.query("UPDATE api_keys SET status='REVOKED' WHERE tenant_id=$1 AND id=$2", [tenantId, apiKeyId]);
    const revokedKeyHistory = await userRequest(historyPath);
    expect(revokedKeyHistory.status).toBe(200);
    expect(hiddenHistory(await jsonResponse(revokedKeyHistory) as Record<string, unknown>)).toEqual(hiddenHistory(noKeyPage as Record<string, unknown>));
    const revokedKeyEvents = await userRequest(eventPath);
    expect(revokedKeyEvents.status).toBe(200);
    expect((await revokedKeyEvents.json() as { events: Array<{ eventId: string }> }).events.map((item) => item.eventId)).not.toContain(rootEventId);
    await app!.db.query("UPDATE api_keys SET status='ACTIVE' WHERE tenant_id=$1 AND id=$2", [tenantId, apiKeyId]);

    await app!.db.query('DELETE FROM admin_local_user_profile_grants WHERE tenant_id=$1 AND user_id=$2 AND profile_id=$3', [tenantId, userId, profileId]);
    const noProfileHistory = await userRequest(historyPath);
    expect(noProfileHistory.status).toBe(200);
    const noProfilePage = await jsonResponse(noProfileHistory);
    expect(noProfilePage).toMatchObject({
      adjustmentRevision: 0,
      headAdjustmentEventId: null,
      eligible: false,
      blockers: ['ROOT_NOT_FOUND'],
      initialChargeMicrousd: null,
      grossChargeMicrousd: null,
      refundedMicrousd: null,
      netChargeMicrousd: null,
      originalAttribution: null,
      items: [],
    });
    expect(hiddenHistory(noProfilePage as Record<string, unknown>)).toEqual(hiddenHistory(noKeyPage as Record<string, unknown>));
    const noProfileEvents = await userRequest(eventPath);
    expect(noProfileEvents.status).toBe(200);
    expect((await noProfileEvents.json() as { events: Array<{ eventId: string }> }).events.map((item) => item.eventId)).not.toContain(rootEventId);

    await app!.db.query('UPDATE admin_local_users SET version=2 WHERE id=$1', [userId]);
    const staleSession = await userRequest(historyPath);
    expect(staleSession.status).toBe(401);
    const csrfMutation = await fetch(`${shellUrl}/admin/api/cost-control/adjustments`, {
      method: 'POST', headers: { cookie: userCookie, 'x-csrf-token': userCsrf, 'content-type': 'application/json', 'idempotency-key': `orv14-vfy-user-deny-${randomUUID()}` },
      body: JSON.stringify({ ...firstCommand, expectedAdjustmentRevision: 2, targetChargeMicrousd: 49 }),
    });
    expect([401, 403]).toContain(csrfMutation.status);
  });

  test('current verified Admin session is rechecked before an exact immutable command replay', async () => {
    const independentRoot = await createAndSettleUsageRoot('local-admin-replay');
    const command = { ...firstCommand!, rootEventId: independentRoot.eventId, expectedAdjustmentRevision: 0 };
    const key = `orv14-vfy-local-replay-${randomUUID()}`;
    const temporaryAdmin = await newOidcAdmin(`orv14-vfy-revoked-session-${randomUUID()}`);
    const committed = await bffAdjustmentFor(command, key, temporaryAdmin.cookie, temporaryAdmin.csrfToken);
    expect(committed.status).toBe(201);
    const logout = await fetch(`${oidcShellUrl}/admin/logout`, { method: 'POST', headers: { cookie: temporaryAdmin.cookie }, redirect: 'manual' });
    expect(logout.status).toBe(302);
    const replay = await bffAdjustmentFor(command, key, temporaryAdmin.cookie, temporaryAdmin.csrfToken);
    expect(replay.status).toBe(401);
    expect((await jsonResponse(replay)).code).toBe('UNAUTHENTICATED');
  });

  test('ordinary verified OIDC Admin financial authority survives separate Cost Alerts recipient revocation', async () => {
    const lifecycle = await oidcBff(`/cost-alerts/recipients/${encodeURIComponent(oidcAlertPrincipalId)}/lifecycle`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'idempotency-key': `orv14-vfy-recipient-revoke-${randomUUID()}` },
      body: JSON.stringify({ expectedAuthorizationVersion: 1, action: 'revoke', reason: 'Synthetic recipient authority separation' }),
    });
    expect(lifecycle.status).toBe(200);
    expect(await jsonResponse(lifecycle)).toMatchObject({ principalId: oidcAlertPrincipalId, state: 'REVOKED' });

    const independentRoot = await createAndSettleUsageRoot('oidc-admin-after-alert-revoke');
    const command = { ...firstCommand!, rootEventId: independentRoot.eventId, expectedAdjustmentRevision: 0 };
    const result = await bffAdjustment(command, `orv14-vfy-oidc-after-revoke-${randomUUID()}`);
    expect(result.status).toBe(201);
    expect(await jsonResponse(result)).toMatchObject({ outcome: 'ADJUSTED', netChargeMicrousd: 80, adjustmentRevision: 1 });
  });

  test('serializes competing first adjustments at the real PostgreSQL head CAS', async () => {
    const independentRoot = await createAndSettleUsageRoot('cas-race');
    const first = { ...firstCommand!, rootEventId: independentRoot.eventId, expectedAdjustmentRevision: 0, targetChargeMicrousd: 81 };
    const second = { ...first, targetChargeMicrousd: 82 };
    const [left, right] = await Promise.all([
      bffAdjustment(first, `orv14-vfy-cas-a-${randomUUID()}`),
      bffAdjustment(second, `orv14-vfy-cas-b-${randomUUID()}`),
    ]);
    const outcomes = [left.status, right.status].sort((a, b) => a - b);
    expect(outcomes).toEqual([201, 409]);
    const loser = left.status === 409 ? await jsonResponse(left) : await jsonResponse(right);
    expect(loser.code).toBe('COST_ADJUSTMENT_CAS_CONFLICT');
    const state = await app!.db.query<{ count: string; revision: string; net: string }>(
      `SELECT count(a.adjustment_event_id)::text AS count,h.adjustment_revision::text AS revision,h.net_charge_microusd::text AS net
         FROM usage_financial_adjustment_heads h LEFT JOIN usage_financial_adjustments a
           ON a.root_event_id=h.root_event_id AND a.tenant_id=h.tenant_id
        WHERE h.root_event_id=$1 AND h.tenant_id=$2 GROUP BY h.adjustment_revision,h.net_charge_microusd`,
      [independentRoot.eventId, tenantId],
    );
    expect(state.rows).toEqual([{ count: '1', revision: '1', net: left.status === 201 ? '81' : '82' }]);
  });

  test('rolls ledger, command, head, and audit back together when the real audit insert fails', async () => {
    const independentRoot = await createAndSettleUsageRoot('audit-rollback');
    const command = { ...firstCommand!, rootEventId: independentRoot.eventId, expectedAdjustmentRevision: 0 };
    const key = `orv14-vfy-audit-rollback-${randomUUID()}`;
    await app!.db.query(`CREATE FUNCTION fail_orv14_finance_audit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN IF NEW.action LIKE 'cost_adjustment.%' THEN RAISE EXCEPTION 'ORV14 intentional audit rollback probe'; END IF; RETURN NEW; END $$`);
    await app!.db.query(`CREATE TRIGGER fail_orv14_finance_audit BEFORE INSERT ON admin_audit_events FOR EACH ROW EXECUTE FUNCTION fail_orv14_finance_audit()`);
    let response: Response | undefined;
    try {
      response = await bffAdjustment(command, key);
    } finally {
      await app!.db.query('DROP TRIGGER IF EXISTS fail_orv14_finance_audit ON admin_audit_events');
      await app!.db.query('DROP FUNCTION IF EXISTS fail_orv14_finance_audit()');
    }
    expect(response!.status).toBeGreaterThanOrEqual(500);
    const state = await app!.db.query<{ heads: string; ledger: string; commands: string; audit: string }>(
      `SELECT
         (SELECT count(*)::text FROM usage_financial_adjustment_heads WHERE root_event_id=$1 AND tenant_id=$2) AS heads,
         (SELECT count(*)::text FROM usage_financial_adjustments WHERE root_event_id=$1 AND tenant_id=$2) AS ledger,
         (SELECT count(*)::text FROM usage_financial_adjustment_commands WHERE tenant_id=$2 AND idempotency_key=$3) AS commands,
         (SELECT count(*)::text FROM admin_audit_events WHERE action LIKE 'cost_adjustment.%' AND resource LIKE $4) AS audit`,
      [independentRoot.eventId, tenantId, key, `%${independentRoot.eventId}%`],
    );
    expect(state.rows[0]).toEqual({ heads: '0', ledger: '0', commands: '0', audit: '0' });
  });

  test('uses the real durable maintenance backup claim to hold the finance write gate', async () => {
    const acceptedCommand = await bffAdjustment(firstCommand!, idempotencyKey);
    expect([200, 201]).toContain(acceptedCommand.status);
    expect(await jsonResponse(acceptedCommand)).toMatchObject({ outcome: 'ADJUSTED', initialChargeMicrousd: 100, grossChargeMicrousd: 80 });
    const currentHead = await app!.db.query<{ adjustment_revision: string; gross_charge_microusd: string }>(
      'SELECT adjustment_revision::text,gross_charge_microusd::text FROM usage_financial_adjustment_heads WHERE tenant_id=$1 AND root_event_id=$2',
      [tenantId, rootEventId],
    );
    expect(currentHead.rowCount).toBe(1);
    const target = {
      name: `orv14-finance-backup-${randomUUID()}`, descriptionCode: 'ORV14_SYNTHETIC_GATE_TARGET', kind: 'postgres' as const,
      allowlisted: true as const, immutable: true as const, credentialVersionRefs: ['synthetic:backup-credential:v1'],
      encryptionKeyVersionRefs: ['synthetic:backup-key:v1'], supportedScopes: ['platform'] as const,
    };
    const releaseBundle = (() => {
      let release!: () => void;
      return { wait: new Promise<void>((resolve) => { release = resolve; }), release };
    })();
    let held!: () => void;
    const holdReady = new Promise<void>((resolve) => { held = resolve; });
    const fenceId = randomUUID();
    const runnerIdentity = `orv14-vfy-maintenance-${randomUUID()}`;
    const maintenance = createMaintenanceService({
      db: app!.db, audit: createAuditService(app!.db), artifacts: { async expireForMaintenance() { throw new Error('backup test cannot expire artifacts'); } },
      getEffectiveRetentionPolicy: async () => ({ revision: 1, retentionDays: 1, cacheTtlHours: 1, updatedAt: new Date().toISOString() } as never),
      runnerRuntimeIdentity: runnerIdentity,
      backupAdapter: {
        trusted: true,
        async listTargets() { return [target]; },
        async createBundle(input) {
          process.stdout.write(`ORV14_VFY_MAINTENANCE createBundle entered identityMatches=${input.execution.ownerRuntimeIdentity === runnerIdentity} itemType=backup\n`);
          const current = await app!.db.query<{ state: string; fence_revision: string }>('SELECT state,fence_revision::text FROM maintenance_backup_effect_gate WHERE singleton_id=1');
          process.stdout.write(`ORV14_VFY_MAINTENANCE gateBeforeHold state=${current.rows[0]?.state ?? 'missing'} revision=${current.rows[0]?.fence_revision ?? 'missing'}\n`);
          const fence = new PostgresBackupSnapshotFence(app!.db);
          let heldSnapshot: { fenceId: string; fenceRevision: number; state: 'HELD' };
          try {
            heldSnapshot = await fence.hold({
              fenceId, backupId: input.backupId, execution: input.execution, expectedFenceRevision: Number(current.rows[0]?.fence_revision), priorControlStates: {},
            });
          } catch (error) {
            const detail = error as { name?: unknown; code?: unknown; message?: unknown };
            process.stdout.write(`ORV14_VFY_MAINTENANCE holdFailed name=${String(detail.name ?? 'Error')} code=${String(detail.code ?? 'none')} message=${String(detail.message ?? 'unavailable').slice(0, 180)}\n`);
            throw error;
          }
          expect(heldSnapshot.state).toBe('HELD');
          process.stdout.write(`ORV14_VFY_MAINTENANCE held revision=${heldSnapshot.fenceRevision}\n`);
          held();
          await releaseBundle.wait;
          await fence.release({ fenceId, backupId: input.backupId, execution: input.execution, fenceRevision: heldSnapshot.fenceRevision, restorePriorState: true });
          return {
            bundleRef: `synthetic://orv14/${input.backupId}`, sha256: 'a'.repeat(64), byteSize: 1, immutable: true, verified: true,
            credentialVersionRefs: target.credentialVersionRefs, encryptionKeyVersionRefs: target.encryptionKeyVersionRefs,
            manifest: { synthetic: true },
          };
        },
        async restoreBundle() { throw new Error('restore is outside the financial gate case'); },
      },
    });
    const actor = { actor: 'ORV14 independent financial verifier', actorRole: 'platform' };
    const preview = await maintenance.createMaintenancePreview(actor, {
      kind: 'backup', scope: { kind: 'platform' }, filters: { backupTarget: target.name }, reason: 'ORV14 independent financial gate',
    });
    expect(preview.eligibleCount).toBe(1);
    const job = await maintenance.startMaintenanceJob(actor, {
      previewId: preview.previewId, expectedVersion: preview.expectedVersion,
      idempotencyKey: `orv14-vfy-maintenance-job-${randomUUID()}`, reason: 'ORV14 controlled synthetic gate hold',
    });
    process.stdout.write(`ORV14_VFY_MAINTENANCE started jobState=${job.state} totalItems=${job.totalItems} items=${job.items.map((item) => `${item.itemType}:${item.status}`).join(',') || 'none'}\n`);
    const runner = maintenance.runMaintenanceJob(job.jobId, actor, runnerIdentity, 1);
    const adapterReady = await Promise.race([
      holdReady.then(() => 'held' as const),
      runner.then((result) => {
        process.stdout.write(`ORV14_VFY_MAINTENANCE runnerFinishedBeforeHold state=${result.state} items=${result.items.map((item) => `${item.itemType}:${item.status}:${item.code ?? 'none'}`).join(',') || 'none'}\n`);
        return 'finished' as const;
      }),
    ]);
    expect(adapterReady).toBe('held');
    const heldKey = `orv14-vfy-held-${fenceId}`;
    const ledgerBefore = await app!.db.query<{ heads: string; ledger: string; commands: string; audit: string }>(
      `SELECT (SELECT count(*)::text FROM usage_financial_adjustment_heads WHERE root_event_id=$1) AS heads,
              (SELECT count(*)::text FROM usage_financial_adjustments WHERE root_event_id=$1) AS ledger,
              (SELECT count(*)::text FROM usage_financial_adjustment_commands WHERE tenant_id=$2 AND idempotency_key=$3) AS commands,
              (SELECT count(*)::text FROM admin_audit_events WHERE resource LIKE $4) AS audit`,
      [rootEventId, tenantId, heldKey, `usage-event:${rootEventId}@%`],
    );
    const heldCommand = {
      ...firstCommand!, expectedAdjustmentRevision: Number(currentHead.rows[0]!.adjustment_revision),
      targetChargeMicrousd: Number(currentHead.rows[0]!.gross_charge_microusd) - 1,
    };
    const rejected = await bffAdjustment(heldCommand, heldKey);
    expect(rejected.status).toBe(409);
    expect((await jsonResponse(rejected)).code).toBe('BACKUP_EFFECT_FENCE_ACTIVE');
    const replayKnownCommand = await bffAdjustment(firstCommand!, idempotencyKey);
    expect(replayKnownCommand.status).toBe(200);
    expect((await jsonResponse(replayKnownCommand)).replayed).toBe(true);
    const ledgerAfter = await app!.db.query<{ heads: string; ledger: string; commands: string; audit: string }>(
      `SELECT (SELECT count(*)::text FROM usage_financial_adjustment_heads WHERE root_event_id=$1) AS heads,
              (SELECT count(*)::text FROM usage_financial_adjustments WHERE root_event_id=$1) AS ledger,
              (SELECT count(*)::text FROM usage_financial_adjustment_commands WHERE tenant_id=$2 AND idempotency_key=$3) AS commands,
              (SELECT count(*)::text FROM admin_audit_events WHERE resource LIKE $4) AS audit`,
      [rootEventId, tenantId, heldKey, `usage-event:${rootEventId}@%`],
    );
    expect(ledgerAfter.rows[0]).toEqual(ledgerBefore.rows[0]);
    releaseBundle.release();
    const result = await runner;
    expect(result).toMatchObject({ state: 'SUCCEEDED' });
  }, 60_000);

  test('projects OIDC price actors as opaque principals in draft and history DTOs', async () => {
    const syntheticSubject = `orv14-vfy-price-privacy-${randomUUID()}`;
    const admin = await newOidcAdmin(syntheticSubject);
    const base = `${oidcShellUrl}/admin/api/cost-control/prices`;
    const before = await fetch(base, { headers: { cookie: admin.cookie } });
    expect(before.status).toBe(200);
    const current = await jsonResponse(before);
    const activeRevision = Number(current['activeRevision']);
    const headRevision = Number(current['headRevision']);
    const active = (current['revisions'] as Array<Record<string, any>>).find((revision) => revision['revision'] === activeRevision);
    expect(Number.isSafeInteger(headRevision)).toBe(true);
    expect(active).toBeDefined();

    const draft = await fetch(`${base}/draft`, {
      method: 'POST',
      headers: {
        cookie: admin.cookie,
        'x-csrf-token': admin.csrfToken,
        'content-type': 'application/json',
        'idempotency-key': `orv14-vfy-price-privacy-${randomUUID()}`,
      },
      body: JSON.stringify({ expectedHeadRevision: headRevision, tiers: active!['tiers'] }),
    });
    expect(draft.status).toBe(201);
    const draftBody = await jsonResponse(draft);
    const opaqueActor = `oidc-principal:${admin.principalId}`;
    expect(draftBody).toMatchObject({ revision: headRevision + 1, state: 'DRAFT', actor: opaqueActor });
    const draftWire = JSON.stringify(draftBody);
    expect(draftWire).not.toContain(syntheticSubject);
    expect(draftWire).not.toContain(idp!.issuer);

    const after = await fetch(base, { headers: { cookie: admin.cookie } });
    expect(after.status).toBe(200);
    const history = await jsonResponse(after);
    const storedDraft = (history['revisions'] as Array<Record<string, any>>).find((revision) => revision['revision'] === headRevision + 1);
    expect(storedDraft).toMatchObject({ actor: opaqueActor, state: 'DRAFT' });
    const historyWire = JSON.stringify(history);
    expect(historyWire).not.toContain(syntheticSubject);
    expect(historyWire).not.toContain(idp!.issuer);
  });
});
