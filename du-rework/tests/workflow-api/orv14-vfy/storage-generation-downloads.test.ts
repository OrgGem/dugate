import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { createApp, type App } from '../../../orchestrator/services/orchestrator/src/server';
import { createDb } from '../../../orchestrator/services/orchestrator/src/db/db';
import { migrate } from '../../../orchestrator/services/orchestrator/src/db/migrations';
import { SecretCatalogCreateSchema } from '../../../orchestrator/packages/contracts/src/secret-catalog';
import { createBackupSnapshotWriteGate } from '../../../orchestrator/services/orchestrator/src/modules/maintenance/backup-effect-fence';
import { createSecretInDb } from '../../../orchestrator/services/orchestrator/src/modules/secrets/secret-catalog-store';
import type { SecretCatalogKeyring } from '../../../orchestrator/services/orchestrator/src/modules/secrets/secret-revision-resolver';
import { assertSafeIsolationConfig, createTestIsolationContext, type TestIsolationContext } from '../../isolation/namespace';
import { syntheticMetadataKeyProvider } from '../isolation';
import { startStorageGenerationMinioFixture, type StorageGenerationMinioFixture } from './storage-generation-minio';
import IORedis from '../../../orchestrator/services/orchestrator/node_modules/ioredis';

type JsonObject = Record<string, unknown>;

const runId = `orv14_vfy_generation_${Date.now()}_${randomBytes(5).toString('hex')}`;
const baseDatabaseUrl = process.env.WFA_DATABASE_URL ?? 'postgresql://orv14_vfy:orv14-vfy-local-only@127.0.0.1:25414/orv14_vfy';
const baseRedisUrl = process.env.WFA_REDIS_URL ?? 'redis://127.0.0.1:26414/14';
const baseDb = createDb(baseDatabaseUrl);
let isolation: TestIsolationContext | undefined;
let databaseUrl = '';
let redisUrl = '';
let schemaCreated = false;
let app: App | undefined;
let appCloseCount = 0;
let internalUrl = '';
let publicUrl = '';
let minioA: StorageGenerationMinioFixture | undefined;
let minioB: StorageGenerationMinioFixture | undefined;
let selectedRedisDb = -1;

const tenantId = randomUUID();
const adminToken = `orv14-vfy-generation-admin-${randomUUID()}`;
const platformRuntimeToken = `orv14-vfy-generation-runtime-${randomUUID()}`;
const serviceRuntimeIdentity = `orv14-vfy-generation-${randomUUID()}`;
const serviceRuntimeControlToken = `orv14-vfy-generation-control-${randomUUID()}`;
const publicApiKey = `orv14-vfy-generation-key-${randomUUID()}`;
const publicApiKeyId = randomUUID();
const secretCatalogKeyring: SecretCatalogKeyring = {
  activeVersion: 'orv14-vfy-generation-k1',
  keys: { 'orv14-vfy-generation-k1': randomBytes(32) },
};
const encryptionProvider = syntheticMetadataKeyProvider();
const publicUploadEncryption = { keyProvider: encryptionProvider, keyRef: `${runId}:artifact-envelope` };
const metadataEncryption = { keyProvider: encryptionProvider, keyRef: `${runId}:metadata` };

interface ArtifactPin {
  id: string;
  storageKey: string;
  generationId: string;
  storageVersionId: string;
  manifestVersionId: string;
  ciphertextSha256: string;
  ciphertextSizeBytes: number;
  uploadToken: string;
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function redisUrlForDatabase(index: number): string {
  const url = new URL(baseRedisUrl);
  url.pathname = `/${index}`;
  return url.toString();
}

async function redisDatabaseSize(index: number): Promise<number> {
  const client = new IORedis(redisUrlForDatabase(index), { maxRetriesPerRequest: 1, enableOfflineQueue: false });
  try {
    if (client.status !== 'ready') await new Promise<void>((resolve, reject) => {
      client.once('ready', resolve);
      client.once('error', reject);
    });
    return await client.dbsize();
  } finally {
    await client.quit();
  }
}

async function selectEmptyRedisDb(): Promise<number> {
  const start = 1 + Math.floor(Math.random() * 14);
  for (let offset = 0; offset < 14; offset += 1) {
    const candidate = 1 + ((start - 1 + offset) % 14);
    if (await redisDatabaseSize(candidate) === 0) return candidate;
  }
  throw new Error('no empty isolated Redis database is available; no database was modified');
}

async function readJson(response: Response): Promise<JsonObject> {
  const text = await response.text();
  try {
    const parsed: unknown = text ? JSON.parse(text) : {};
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed as JsonObject : {};
  } catch {
    return {};
  }
}

function safeProblem(value: JsonObject): Record<string, string | number> {
  const safe: Record<string, string | number> = {};
  for (const key of ['status', 'code', 'title', 'correlationId'] as const) {
    const item = value[key];
    if (typeof item === 'string' || typeof item === 'number') safe[key] = item;
  }
  return safe;
}

function assertHttpStatus(response: Response, body: JsonObject, expected: number, label: string): void {
  if (response.status !== expected) {
    throw new Error(`${label} returned ${response.status}, expected ${expected}; safeProblem=${JSON.stringify(safeProblem(body))}`);
  }
}

async function internalJson(path: string, init: RequestInit = {}): Promise<{ response: Response; body: JsonObject }> {
  const headers = new Headers(init.headers);
  if (!headers.has('authorization')) headers.set('authorization', `Bearer ${adminToken}`);
  if (!headers.has('content-type') && init.body !== undefined) headers.set('content-type', 'application/json');
  const response = await fetch(`${internalUrl}${path}`, { ...init, headers });
  return { response, body: await readJson(response) };
}

async function createCatalogCredential(input: { name: string; accessKeyId: string; secretAccessKey: string }): Promise<string> {
  if (!minioA || !minioB) throw new Error('owned storage endpoints are unavailable');
  const response = await internalJson('/api/v1/admin/secrets', {
    method: 'POST',
    body: JSON.stringify({
      tenantId,
      name: input.name,
      purpose: 'storage.credential',
      services: ['orchestrator'],
      provider: { kind: 'managed_value' },
      value: {
        kind: 'literal',
        value: JSON.stringify({ accessKeyId: input.accessKeyId, secretAccessKey: input.secretAccessKey }),
      },
    }),
  });
  assertHttpStatus(response.response, response.body, 201, 'normal internal Secret Catalog create');
  const id = response.body['secretId'];
  const revision = response.body['revision'];
  if (typeof id !== 'string' || typeof revision !== 'number' || revision !== 1) {
    throw new Error('normal Secret Catalog create did not return a new immutable credential revision');
  }
  return `${id}@${revision}`;
}

async function currentGeneration(): Promise<JsonObject> {
  const result = await internalJson('/api/internal/maintenance/storage-generations/current');
  assertHttpStatus(result.response, result.body, 200, 'storage-generation current read');
  return result.body;
}

async function stageTestActivateGeneration(input: {
  label: string;
  endpoint: string;
  bucket: string;
  credentialVersionRef: string;
}): Promise<string> {
  const current = await currentGeneration();
  const expectedRevision = current['controlRevision'];
  if (typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision)) {
    throw new Error('current storage-generation response omitted an integer control revision');
  }
  const stage = await internalJson('/api/internal/maintenance/storage-generations/stage', {
    method: 'POST',
    body: JSON.stringify({
      expectedRevision,
      idempotencyKey: `${runId}-${input.label}-stage-${randomUUID()}`,
      reason: `Independent ORV14 ${input.label} storage-generation download verification`,
      backend: 's3',
      endpoint: input.endpoint,
      bucket: input.bucket,
      region: 'us-east-1',
      forcePathStyle: true,
      credentialVersionRef: input.credentialVersionRef,
      credentialOwnerTenantId: tenantId,
      urlTtlSeconds: null,
    }),
  });
  assertHttpStatus(stage.response, stage.body, 201, `${input.label} storage-generation stage`);
  const generationId = stage.body['generationId'];
  if (typeof generationId !== 'string') throw new Error(`${input.label} storage-generation stage omitted its id`);

  const test = await internalJson(`/api/internal/maintenance/storage-generations/${encodeURIComponent(generationId)}/test`, {
    method: 'POST',
    body: JSON.stringify({
      idempotencyKey: `${runId}-${input.label}-test-${randomUUID()}`,
      reason: `Independent ORV14 ${input.label} immutable storage test`,
    }),
  });
  assertHttpStatus(test.response, test.body, 200, `${input.label} storage-generation test`);
  const stages = ['write', 'read', 'checksum', 'crypto', 'delete'] as const;
  if (test.body['status'] !== 'PASSED' || stages.some((name) => test.body[name] !== 'PASSED')) {
    throw new Error(`${input.label} storage-generation test did not pass every write/read/checksum/crypto/delete stage`);
  }

  const activate = await internalJson(`/api/internal/maintenance/storage-generations/${encodeURIComponent(generationId)}/activate`, {
    method: 'POST',
    body: JSON.stringify({
      expectedRevision,
      idempotencyKey: `${runId}-${input.label}-activate-${randomUUID()}`,
      reason: `Independent ORV14 ${input.label} storage-generation activation`,
    }),
  });
  assertHttpStatus(activate.response, activate.body, 200, `${input.label} storage-generation activate`);
  const after = await currentGeneration();
  if (after['generationId'] !== generationId || after['state'] !== 'ACTIVE') {
    throw new Error(`${input.label} storage generation did not become the active generation`);
  }
  return generationId;
}

async function uploadArtifact(label: 'A' | 'B', bytes: Buffer, expectedGenerationId: string): Promise<ArtifactPin> {
  const response = await fetch(
    `${internalUrl}/api/internal/operations/uploads?tenantId=${encodeURIComponent(tenantId)}&apiKeyId=${encodeURIComponent(publicApiKeyId)}&fileName=orv14-generation-${label.toLowerCase()}.txt`,
    {
      method: 'POST',
      headers: {
        authorization: `Bearer ${adminToken}`,
        'content-type': 'text/plain',
        'content-length': String(bytes.byteLength),
      },
      body: new Uint8Array(bytes),
    },
  );
  const body = await readJson(response);
  assertHttpStatus(response, body, 201, `${label}-generation encrypted upload`);
  const artifactId = body['artifactId'];
  if (typeof artifactId !== 'string' || body['state'] !== 'READY') throw new Error(`${label}-generation upload did not return READY`);
  const result = await app!.db.query<{
    id: string; storage_key: string; storage_backend: string; storage_generation_id: string; storage_version_id: string | null;
    manifest_version_id: string | null; sha256: string | null; size_bytes: number | string | null; upload_token: string | null;
  }>(
    `SELECT id::text AS id,storage_key,storage_backend,storage_generation_id::text AS storage_generation_id,
            storage_version_id,manifest_version_id,sha256,size_bytes,upload_token
       FROM artifacts WHERE id=$1 AND tenant_id=$2 AND state='READY' AND purpose='input'`,
    [artifactId, tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`${label}-generation upload was not durably recorded as a READY input artifact`);
  if (row.storage_generation_id !== expectedGenerationId) {
    throw new Error(`${label}-generation upload pinned generation ${row.storage_generation_id}, expected ${expectedGenerationId}`);
  }
  if (row.storage_backend !== 's3') throw new Error(`${label}-generation upload did not persist the S3 backend pin`);
  if (!row.storage_version_id || row.storage_version_id === 'null' || !row.manifest_version_id || !row.sha256
      || row.size_bytes === null || row.size_bytes === undefined || !row.upload_token) {
    throw new Error(`${label}-generation artifact lacks its immutable ciphertext/object/sidecar pins`);
  }
  return {
    id: row.id,
    storageKey: row.storage_key,
    generationId: row.storage_generation_id,
    storageVersionId: row.storage_version_id,
    manifestVersionId: row.manifest_version_id,
    ciphertextSha256: row.sha256,
    ciphertextSizeBytes: Number(row.size_bytes),
    uploadToken: row.upload_token,
  };
}

async function seedAuthorizedReferences(pin: ArtifactPin, label: 'A' | 'B'): Promise<{ taskId: string }> {
  const publicOperationId = randomUUID();
  const runtimeOperationId = randomUUID();
  const taskId = randomUUID();
  const reference = JSON.stringify([{ artifactId: pin.id }]);
  await app!.db.query(
    `INSERT INTO operations
       (id,tenant_id,api_key_id,business_id,business_version,action,state,state_version,correlation_id,submit_artifacts,created_at,updated_at)
     VALUES ($1,$2,$3,'document-core','1.0.0','extract','SUCCEEDED',1,$4,$5::jsonb,now(),now())`,
    [publicOperationId, tenantId, publicApiKeyId, `${runId}-${label}-public-reference`, reference],
  );
  await app!.db.query(
    `INSERT INTO operations
       (id,tenant_id,api_key_id,business_id,business_version,action,state,state_version,correlation_id,submit_artifacts,created_at,updated_at)
     VALUES ($1,$2,$3,'document-core','1.0.0','extract','RUNNING',1,$4,$5::jsonb,now(),now())`,
    [runtimeOperationId, tenantId, publicApiKeyId, `${runId}-${label}-runtime-reference`, reference],
  );
  await app!.db.query(
    `INSERT INTO tasks
       (id,operation_id,task_key,kind,state,attempt,max_attempts,lease_epoch,lease_expires_at,created_at,updated_at)
     VALUES ($1,$2,$3,'document-core','RUNNING',1,1,1,now()+interval '5 minutes',now(),now())`,
    [taskId, runtimeOperationId, `${runId}-${label}-runtime-download`],
  );
  return { taskId };
}

async function downloadPublic(pin: ArtifactPin, expectedBytes: Buffer, label: string): Promise<void> {
  const response = await fetch(`${publicUrl}/api/v1/artifacts/${encodeURIComponent(pin.id)}/download`, {
    headers: { 'x-api-key': publicApiKey },
  });
  if (response.status !== 200) {
    const body = await readJson(response);
    throw new Error(`${label} public artifact download returned ${response.status}; safeProblem=${JSON.stringify(safeProblem(body))}`);
  }
  const actualBytes = Buffer.from(await response.arrayBuffer());
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error(`${label} public artifact download did not return the exact encrypted-upload plaintext`);
  }
}

async function downloadRuntime(pin: ArtifactPin, taskId: string, expectedBytes: Buffer, label: string): Promise<void> {
  const grantResponse = await fetch(`${internalUrl}/api/runtime/v1/artifacts/${encodeURIComponent(pin.id)}/access`, {
    method: 'POST',
    headers: { authorization: `Bearer ${platformRuntimeToken}`, 'content-type': 'application/json' },
    body: JSON.stringify({ taskId, leaseEpoch: 1, mode: 'read' }),
  });
  const grant = await readJson(grantResponse);
  assertHttpStatus(grantResponse, grant, 200, `${label} runtime artifact read grant`);
  const downloadUrl = grant['downloadUrl'];
  if (typeof downloadUrl !== 'string' || !downloadUrl.startsWith('http://127.0.0.1:')) {
    throw new Error(`${label} runtime grant did not provide the loopback internal download URL`);
  }
  // Do not include this URL in diagnostics: the query contains a single-use bearer grant.
  const downloaded = await fetch(downloadUrl);
  if (downloaded.status !== 200) {
    const body = await readJson(downloaded);
    throw new Error(`${label} runtime artifact download returned ${downloaded.status}; safeProblem=${JSON.stringify(safeProblem(body))}`);
  }
  const actualBytes = Buffer.from(await downloaded.arrayBuffer());
  if (!actualBytes.equals(expectedBytes)) {
    throw new Error(`${label} runtime artifact download did not return the exact encrypted-upload plaintext`);
  }
  const replay = await fetch(downloadUrl);
  if (replay.status !== 404) throw new Error(`${label} runtime single-use download grant replay returned ${replay.status}, expected 404`);
}

async function downloadBothRoutes(pin: ArtifactPin, taskId: string, bytes: Buffer, label: string): Promise<void> {
  await downloadPublic(pin, bytes, label);
  await downloadRuntime(pin, taskId, bytes, label);
}

async function bootApp(): Promise<void> {
  const minioOne = minioA;
  if (!minioOne) throw new Error('generation A MinIO fixture is unavailable');
  app = await createApp({
    host: '127.0.0.1', port: 0, internalHost: '127.0.0.1', internalPort: 0,
    databaseUrl, redisUrl, autoMigrate: true, autoDispatch: false, leaseRecoveryIntervalMs: 0,
    adminToken, runtimeToken: platformRuntimeToken,
    serviceRuntime: {
      serviceRuntimeId: serviceRuntimeIdentity,
      runtimeIdentity: serviceRuntimeIdentity,
      replicaId: serviceRuntimeIdentity,
      slot: 'green',
      revision: 'orv14-vfy-generation',
      imageDigest: `orv14-vfy-generation@sha256:${'a'.repeat(64)}`,
      controlToken: serviceRuntimeControlToken,
    },
    secretCatalogKeyring,
    artifactStorage: {
      backend: 's3', endpoint: minioOne.endpoint, bucket: minioOne.bucket,
      region: 'us-east-1', forcePathStyle: true,
      credentialVersionRef: initialCredentialVersionRef,
      credentialOwnerTenantId: tenantId,
    },
    storageEndpointAllowlist: [minioOne.endpoint, ...(minioB ? [minioB.endpoint] : [])],
    publicUploadEncryption,
    metadataEncryption,
  });
  const publicServer = await app.listen();
  const publicAddress = publicServer.address();
  const internalAddress = app.internalServer.address();
  if (!publicAddress || typeof publicAddress === 'string' || !internalAddress || typeof internalAddress === 'string') {
    throw new Error('normal Orchestrator public/internal listeners did not bind');
  }
  publicUrl = `http://127.0.0.1:${(publicAddress as AddressInfo).port}`;
  internalUrl = `http://127.0.0.1:${(internalAddress as AddressInfo).port}`;
}

let initialCredentialVersionRef = '';

beforeAll(async () => {
  selectedRedisDb = await selectEmptyRedisDb();
  isolation = createTestIsolationContext({ runId, redisDbIndex: selectedRedisDb, baseArtifactPath: 'tests/workflow-api/orv14-vfy/storage-generation-artifacts' });
  databaseUrl = isolation.getDatabaseUrlWithSchema(baseDatabaseUrl);
  redisUrl = redisUrlForDatabase(selectedRedisDb);
  assertSafeIsolationConfig({ databaseUrl, redisUrl, isolationCtx: isolation });
  process.stdout.write(`ORV14_STORAGE_GENERATION_NAMESPACE runId=${runId} postgresSchema=${isolation.dbSchema} redisDb=${selectedRedisDb} redisDbEmptyBefore=true artifactDir=${isolation.artifactDir}\n`);

  await baseDb.query(`CREATE SCHEMA "${isolation.dbSchema}"`);
  schemaCreated = true;
  minioA = await startStorageGenerationMinioFixture(`${runId}-gen-a`);
  minioB = await startStorageGenerationMinioFixture(`${runId}-gen-b`);

  const migrationDb = createDb(databaseUrl);
  try {
    const result = await migrate(migrationDb);
    const migrationLedger = await migrationDb.query<{ count: number | string }>('SELECT count(*)::int AS count FROM schema_migrations');
    process.stdout.write(`ORV14_STORAGE_GENERATION_MIGRATIONS appliedThisRun=${result.applied.length} recorded=${Number(migrationLedger.rows[0]?.count ?? -1)}\n`);
    await migrationDb.query('INSERT INTO tenants(id,name,state) VALUES($1,$2,\'ACTIVE\')', [tenantId, 'ORV14 synthetic storage generation tenant']);
    const created = await createSecretInDb(migrationDb, SecretCatalogCreateSchema.parse({
      tenantId,
      name: 'ORV14 verifier initial storage generation credential',
      purpose: 'storage.credential',
      services: ['orchestrator'],
      provider: { kind: 'managed_value' },
      value: { kind: 'literal', value: JSON.stringify({ accessKeyId: minioA.accessKeyId, secretAccessKey: minioA.secretAccessKey }) },
    }), undefined, secretCatalogKeyring, createBackupSnapshotWriteGate());
    initialCredentialVersionRef = `${created.secretId}@${created.revision}`;
  } finally {
    await migrationDb.close();
  }

  await bootApp();
  await app!.db.query(
    `INSERT INTO api_keys(id,tenant_id,hash,prefix,status,name)
     VALUES($1,$2,$3,'orv14-gen','ACTIVE','ORV14 synthetic generation key')`,
    [publicApiKeyId, tenantId, sha256(publicApiKey)],
  );
});

afterAll(async () => {
  const cleanupErrors: string[] = [];
  const close = async (label: string) => {
    if (!app) return;
    try {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 });
      app = undefined;
      appCloseCount += 1;
    } catch { cleanupErrors.push(`close-${label}`); }
  };
  await close('current');

  if (schemaCreated) {
    try { if (isolation) await baseDb.query(`DROP SCHEMA "${isolation.dbSchema}" CASCADE`); }
    catch { cleanupErrors.push('drop-schema'); }
    if (isolation) {
      const check = await baseDb.query<{ exists: boolean }>(
        'SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists', [isolation.dbSchema],
      );
      if (check.rows[0]?.exists) cleanupErrors.push('schema-remains');
    }
  }
  if (selectedRedisDb >= 1) {
    try {
      const keys = await redisDatabaseSize(selectedRedisDb);
      if (keys !== 0) cleanupErrors.push(`redis-db-has-${keys}-keys`);
      const schemaExists = isolation
        ? (await baseDb.query<{ exists: boolean }>('SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS exists', [isolation.dbSchema])).rows[0]?.exists === true
        : false;
      process.stdout.write(`ORV14_STORAGE_GENERATION_CLEANUP schemaAbsent=${!schemaExists} redisDb=${selectedRedisDb} redisKeysAfter=${keys} appCloseCount=${appCloseCount}\n`);
    } catch { cleanupErrors.push('redis-cleanup-check'); }
  }
  for (const [label, fixture] of [['A', minioA], ['B', minioB]] as const) {
    if (!fixture) continue;
    try {
      const receipt = await fixture.cleanup();
      process.stdout.write(`ORV14_STORAGE_GENERATION_MINIO_CLEANUP generation=${label} bucketVersionsDeleted=${receipt.bucketVersionsDeleted} bucketAbsent=${receipt.bucketAbsent} containerAbsent=${receipt.containerAbsent} runLabelAbsent=${receipt.runLabelAbsent}\n`);
      if (!receipt.bucketAbsent || !receipt.containerAbsent || !receipt.runLabelAbsent) cleanupErrors.push(`minio-${label}-remains`);
    } catch { cleanupErrors.push(`minio-${label}-cleanup`); }
  }
  if (isolation) {
    isolation.cleanupArtifactDir();
    if (existsSync(isolation.artifactDir)) cleanupErrors.push('artifact-directory-remains');
  }
  try { await baseDb.close(); } catch { cleanupErrors.push('base-db-close'); }
  if (cleanupErrors.length) throw new Error(`storage-generation fixture cleanup incomplete: ${cleanupErrors.join(',')}`);
});

describe('ORV14 row-pinned encrypted storage-generation downloads', () => {
  test('A-old and B-new artifacts decrypt through public and runtime routes before and after application restart', async () => {
    const beforeA = await currentGeneration();
    expect(beforeA).toMatchObject({ backend: 's3', state: 'ACTIVE', bucket: minioA!.bucket });
    const generationA = beforeA['generationId'];
    if (typeof generationA !== 'string') throw new Error('trusted initial generation omitted its id');

    const bytesA = Buffer.from(`ORV14 synthetic generation A plaintext ${randomUUID()}\n`, 'utf8');
    const pinA = await uploadArtifact('A', bytesA, generationA);
    const runtimeA = await seedAuthorizedReferences(pinA, 'A');

    const credentialB = await createCatalogCredential({
      name: 'ORV14 verifier next storage generation credential',
      accessKeyId: minioB!.accessKeyId,
      secretAccessKey: minioB!.secretAccessKey,
    });
    const generationB = await stageTestActivateGeneration({
      label: 'generation-b', endpoint: minioB!.endpoint, bucket: minioB!.bucket, credentialVersionRef: credentialB,
    });
    expect(generationB).not.toBe(generationA);

    const bytesB = Buffer.from(`ORV14 synthetic generation B plaintext ${randomUUID()}\n`, 'utf8');
    const pinB = await uploadArtifact('B', bytesB, generationB);
    const runtimeB = await seedAuthorizedReferences(pinB, 'B');
    const activeBeforeRestart = await currentGeneration();
    expect(activeBeforeRestart['generationId']).toBe(generationB);

    await downloadBothRoutes(pinA, runtimeA.taskId, bytesA, 'A-old before restart');
    await downloadBothRoutes(pinB, runtimeB.taskId, bytesB, 'B-new before restart');

    await app!.close({ timeoutMs: 0, pollIntervalMs: 10 });
    app = undefined;
    appCloseCount += 1;
    await bootApp();
    const activeAfterRestart = await currentGeneration();
    expect(activeAfterRestart).toMatchObject({ generationId: generationB, state: 'ACTIVE', bucket: minioB!.bucket });

    await downloadBothRoutes(pinA, runtimeA.taskId, bytesA, 'A-old after restart');
    await downloadBothRoutes(pinB, runtimeB.taskId, bytesB, 'B-new after restart');

    process.stdout.write(`ORV14_STORAGE_GENERATION_RESULT generationA=${generationA} generationB=${generationB} artifactAGeneration=${pinA.generationId} artifactBGeneration=${pinB.generationId} artifactACipherBytes=${pinA.ciphertextSizeBytes} artifactBCipherBytes=${pinB.ciphertextSizeBytes} artifactAStoredSha=${pinA.ciphertextSha256} artifactBStoredSha=${pinB.ciphertextSha256} plaintextAsha=${sha256(bytesA)} plaintextBsha=${sha256(bytesB)} publicAndRuntimeRoutes=8 restartPreservedActiveB=true\n`);
  });
});
