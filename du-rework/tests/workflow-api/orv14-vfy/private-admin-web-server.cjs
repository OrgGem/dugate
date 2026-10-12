/*
 * Provisional private-bundle Admin UI verifier. Boots the actual Orchestrator
 * createApp() against an owned PostgreSQL schema and a selected empty Redis
 * DB, then serves the verifier's private Vite output through the normal shell.
 * The browser spec intercepts Admin API calls for UI-state assertions; this
 * harness does not claim API/financial behavior from those interceptions.
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createRequire } = require('node:module');
const { randomBytes, randomUUID } = require('node:crypto');
const { execFileSync, spawn, spawnSync } = require('node:child_process');
const { createServer } = require('node:net');

const REPO = '/workspace/dugate/du-rework';
const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const UI_DIST = process.env.ORV14_ADMIN_PRIVATE_DIST ?? '/workspace/scratch/orv14-primary-ui-20261012T0243Z/admin-dist';
const UI_EVIDENCE = process.env.ORV14_ADMIN_PRIVATE_EVIDENCE ?? '/workspace/scratch/orv14-primary-ui-20261012T0243Z/finance-evidence';
const DEFAULT_PRIVATE_SPEC = path.join(REPO, 'tests/browser/admin-web/orv14-cost-adjustment-journey.spec.ts');
const PRIVATE_SPEC = path.resolve(REPO, process.env.ORV14_ADMIN_PRIVATE_SPEC ?? DEFAULT_PRIVATE_SPEC);
const PRIVATE_SPEC_ROOT = `${path.join(REPO, 'tests/browser/admin-web')}${path.sep}`;
if (!PRIVATE_SPEC.startsWith(PRIVATE_SPEC_ROOT) || !fs.existsSync(PRIVATE_SPEC)) {
  throw new Error('ORV14_ADMIN_PRIVATE_SPEC must name an existing verifier-owned Admin browser spec');
}
const ADMIN_REQUIRE = createRequire(`${REPO}/orchestrator/apps/admin-web/package.json`);
const SERVICE_REQUIRE = createRequire(`${REPO}/orchestrator/services/orchestrator/package.json`);
const ts = ADMIN_REQUIRE('typescript');
const RedisModule = SERVICE_REQUIRE('ioredis');
const Redis = RedisModule.default ?? RedisModule;
const { CreateBucketCommand, DeleteBucketCommand, DeleteObjectCommand, ListObjectVersionsCommand, PutBucketVersioningCommand, S3Client } = SERVICE_REQUIRE('@aws-sdk/client-s3');

require.extensions['.ts'] = function compileTs(module, filename) {
  const source = fs.readFileSync(filename, 'utf8');
  const transpiled = ts.transpileModule(source, {
    fileName: filename,
    compilerOptions: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.CommonJS,
      moduleResolution: ts.ModuleResolutionKind.Node10,
      esModuleInterop: true,
      resolveJsonModule: true,
    },
  });
  module._compile(transpiled.outputText, filename);
};

const { createTestIsolationContext, assertSafeIsolationConfig } = require(`${REPO}/tests/isolation/namespace.ts`);
const { createDb } = require(`${REPO}/orchestrator/services/orchestrator/src/db/db.ts`);
const { migrate } = require(`${REPO}/orchestrator/services/orchestrator/src/db/migrations.ts`);
const { createApp } = require(`${REPO}/orchestrator/services/orchestrator/src/server.ts`);
const { createBackupSnapshotWriteGate } = require(`${REPO}/orchestrator/services/orchestrator/src/modules/maintenance/backup-effect-fence.ts`);
const { createSecretInDb } = require(`${REPO}/orchestrator/services/orchestrator/src/modules/secrets/secret-catalog-store.ts`);
const { SecretCatalogCreateSchema } = require(`${REPO}/orchestrator/packages/contracts/src/secret-catalog.ts`);
const { syntheticMetadataKeyProvider } = require(`${REPO}/tests/workflow-api/isolation.ts`);

const runId = `orv14_vfy_admin_ui_${Date.now()}_${randomUUID().slice(0, 8)}`;
const baseDatabaseUrl = process.env.WFA_DATABASE_URL ?? 'postgresql://orv14_vfy:orv14-vfy-local-only@127.0.0.1:25414/orv14_vfy';
const baseRedisUrl = process.env.WFA_REDIS_URL ?? 'redis://127.0.0.1:26414/14';

const adminToken = `orv14-private-ui-admin-${randomUUID()}`;
const cookieSecret = `orv14-private-ui-cookie-${randomUUID()}-synthetic-only`;
const adminShellCookieSecret = `${cookieSecret}${randomUUID()}`;
const storageBucket = `orv14-ui-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
const storageContainer = `orv14-vfy-admin-ui-minio-${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const storageAccessKeyId = randomBytes(10).toString('hex');
const storageSecretAccessKey = randomBytes(20).toString('hex');
const storageKeyring = { activeVersion: 'orv14-admin-ui-k1', keys: { 'orv14-admin-ui-k1': randomBytes(32) } };
const minioImage = 'orv14-vfy/minio:RELEASE-2025-09-07';
let ownedS3Client;
let s3ContainerCreated = false;
let s3BucketCreated = false;

function docker(args) {
  return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
}

async function availablePort() {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', resolve);
  });
  const port = probe.address().port;
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function startOwnedMinio() {
  if (spawnSync('docker', ['inspect', storageContainer], { stdio: 'ignore' }).status === 0) {
    throw new Error('refusing to reuse a pre-existing verifier MinIO container name');
  }
  docker([
    'run', '--detach', '--rm', '--name', storageContainer,
    '--publish', '127.0.0.1::9000/tcp', '--tmpfs', '/data:rw,nosuid,nodev,size=1g',
    '--env', `MINIO_ROOT_USER=${storageAccessKeyId}`,
    '--env', `MINIO_ROOT_PASSWORD=${storageSecretAccessKey}`,
    minioImage, 'server', '/data', '--address', ':9000', '--console-address', ':9001',
  ]);
  s3ContainerCreated = true;
  const binding = docker(['port', storageContainer, '9000/tcp']).split(/\r?\n/)[0]?.trim();
  const port = binding?.match(/:(\d+)$/)?.[1];
  if (!port) throw new Error('owned MinIO did not publish its private S3 listener');
  const endpoint = `http://127.0.0.1:${port}`;
  const client = new S3Client({
    endpoint,
    region: 'us-east-1',
    forcePathStyle: true,
    credentials: { accessKeyId: storageAccessKeyId, secretAccessKey: storageSecretAccessKey },
  });
  ownedS3Client = client;
  let ready = false;
  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(`${endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(1000) });
      if (response.ok) { ready = true; break; }
    } catch { /* wait for this owned endpoint */ }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  if (!ready) throw new Error('owned MinIO did not become ready');
  await client.send(new CreateBucketCommand({ Bucket: storageBucket }));
  s3BucketCreated = true;
  await client.send(new PutBucketVersioningCommand({ Bucket: storageBucket, VersioningConfiguration: { Status: 'Enabled' } }));
  process.stdout.write(`ORV14_PRIVATE_UI_S3 endpoint=${new URL(endpoint).host} bucket=${storageBucket} isolatedContainer=${storageContainer} versioning=Enabled\n`);
  return { endpoint };
}

async function deleteOwnedBucket(client) {
  let keyMarker;
  let versionIdMarker;
  let truncated = true;
  while (truncated) {
    const page = await client.send(new ListObjectVersionsCommand({
      Bucket: storageBucket,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
    }));
    for (const item of [...(page.Versions ?? []), ...(page.DeleteMarkers ?? [])]) {
      if (item.Key && item.VersionId) await client.send(new DeleteObjectCommand({ Bucket: storageBucket, Key: item.Key, VersionId: item.VersionId }));
    }
    truncated = page.IsTruncated === true;
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  }
  await client.send(new DeleteBucketCommand({ Bucket: storageBucket }));
}

async function findEmptyRedisDb() {
  const base = new URL(baseRedisUrl);
  const candidates = Array.from({ length: 14 }, (_, index) => index + 1);
  const offset = Math.floor(Math.random() * candidates.length);
  for (const index of [...candidates.slice(offset), ...candidates.slice(0, offset)]) {
    const candidate = new URL(base);
    candidate.pathname = `/${index}`;
    const inspector = new Redis(candidate.toString(), { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500 });
    try {
      await inspector.connect();
      const count = await inspector.dbsize();
      if (count === 0) return { index, url: candidate.toString() };
    } catch {
      // A candidate that cannot be positively checked is not selected.
    } finally {
      inspector.disconnect();
    }
  }
  throw new Error('no Redis DB from 1..14 was positively observed empty');
}

async function main() {
  if (!fs.existsSync(path.join(UI_DIST, 'index.html'))) throw new Error(`private Admin bundle missing: ${UI_DIST}`);
  const selectedRedis = await findEmptyRedisDb();
  const isolation = createTestIsolationContext({ runId, redisDbIndex: selectedRedis.index, baseArtifactPath: 'tests/workflow-api/orv14-vfy/admin-ui-artifacts' });
  const databaseUrl = isolation.getDatabaseUrlWithSchema(baseDatabaseUrl);
  const redisUrl = selectedRedis.url;
  assertSafeIsolationConfig({ databaseUrl, redisUrl, isolationCtx: isolation });
  process.env.NODE_ENV = 'test';
  process.env.DU_ADMIN_COOKIE_SECURE = 'auto';
  process.env.DU_ADMIN_WEB = '1';
  process.env.DU_ADMIN_WEB_DIST = UI_DIST;

  const baseDb = createDb(baseDatabaseUrl);
  let migrationDb;
  let bucketAbsent = true;
  let containerAbsent = true;
  let schemaCreated = false;
  let app;
  let resultCode = 1;
  try {
    await baseDb.query(`CREATE SCHEMA "${isolation.dbSchema}"`);
    schemaCreated = true;
    process.stdout.write(`ORV14_PRIVATE_UI_NAMESPACE runId=${runId} postgresSchema=${isolation.dbSchema} redisDb=${isolation.redisDbIndex} redisPrefix=${isolation.redisPrefix} redisDbEmptyBefore=true\n`);

    const ownedMinio = await startOwnedMinio();

    migrationDb = createDb(databaseUrl);
    const migrationResult = await migrate(migrationDb);
    const migrationLedger = await migrationDb.query('SELECT count(*)::int AS count FROM schema_migrations');
    process.stdout.write(`ORV14_PRIVATE_UI_MIGRATIONS appliedThisRun=${migrationResult.applied.length} recorded=${migrationLedger.rows[0]?.count ?? 'unknown'}\n`);
    const tenantId = randomUUID();
    await migrationDb.query('INSERT INTO tenants(id,name,state) VALUES($1,$2,\'ACTIVE\')', [tenantId, 'ORV14 private UI synthetic tenant']);
    const storageCredential = await createSecretInDb(migrationDb, SecretCatalogCreateSchema.parse({
      tenantId,
      name: 'ORV14 private UI isolated MinIO credential',
      purpose: 'storage.credential',
      services: ['orchestrator'],
      provider: { kind: 'managed_value' },
      value: { kind: 'literal', value: JSON.stringify({ accessKeyId: storageAccessKeyId, secretAccessKey: storageSecretAccessKey }) },
    }), undefined, storageKeyring, createBackupSnapshotWriteGate());
    const storageCredentialVersionRef = `${storageCredential.secretId}@${storageCredential.revision}`;
    await migrationDb.close();
    migrationDb = undefined;

    app = await createApp({
      host: '127.0.0.1',
      port: 0,
      internalHost: '127.0.0.1',
      internalPort: 0,
      databaseUrl,
      redisUrl,
      autoMigrate: true,
      autoDispatch: false,
      leaseRecoveryIntervalMs: 0,
      adminToken,
      adminLocalAuthEnabled: false,
      secretCatalogKeyring: storageKeyring,
      artifactStorage: {
        backend: 's3', bucket: storageBucket, region: 'us-east-1', endpoint: ownedMinio.endpoint,
        forcePathStyle: true, credentialVersionRef: storageCredentialVersionRef,
        credentialOwnerTenantId: tenantId,
      },
      publicUploadEncryption: { keyProvider: syntheticMetadataKeyProvider(), keyRef: `${runId}:public-upload` },
      adminShellCookieSecret,
      adminShellHost: '127.0.0.1',
      adminShellPort: 0,
    });
    await app.listen();
    const shellUrl = app.adminShell?.url;
    if (!shellUrl) throw new Error('normal createApp did not mount its Admin shell');
    const internalAddress = app.internalServer.address();
    if (!internalAddress || typeof internalAddress === 'string') throw new Error('normal createApp internal listener did not bind');
    const migrationCount = await app.db.query('SELECT count(*)::int AS count FROM schema_migrations');
    process.stdout.write(`ORV14_PRIVATE_UI_SERVER shell=${new URL(shellUrl).origin} internalPort=${internalAddress.port} migrations=${migrationCount.rows[0]?.count ?? 'unknown'} adminBundle=private-hash-recorded\n`);

    const shellProbe = await fetch(new URL('/admin', shellUrl), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    process.stdout.write(`ORV14_PRIVATE_UI_HTTP_PROBE path=/admin status=${shellProbe.status} location=${shellProbe.headers.get('location') ?? 'none'} contentType=${shellProbe.headers.get('content-type') ?? 'none'} bodyBytes=${(await shellProbe.arrayBuffer()).byteLength}\n`);
    const loginProbe = await fetch(new URL('/admin/login', shellUrl), { redirect: 'manual', signal: AbortSignal.timeout(5000) });
    process.stdout.write(`ORV14_PRIVATE_UI_HTTP_PROBE path=/admin/login status=${loginProbe.status} location=${loginProbe.headers.get('location') ?? 'none'} contentType=${loginProbe.headers.get('content-type') ?? 'none'} bodyBytes=${(await loginProbe.arrayBuffer()).byteLength}\n`);

    fs.mkdirSync(UI_EVIDENCE, { recursive: true });
    const playArgs = [
      `${REPO}/tests/browser/node_modules/@playwright/test/cli.js`,
      'test',
      '--config', `${REPO}/tests/workflow-api/orv14-vfy/private-admin-playwright.config.mjs`,
      '--output', `${UI_EVIDENCE}/playwright-output`,
    ];
    if (process.env.ORV14_ADMIN_PRIVATE_GREP) playArgs.push('--grep', process.env.ORV14_ADMIN_PRIVATE_GREP);
    playArgs.push(PRIVATE_SPEC);
    const play = spawn(NODE, playArgs, {
      cwd: REPO,
      env: {
        ...process.env,
        AWEB01B_URL: `${shellUrl}/`,
        AWEB01B_TOKEN: adminToken,
        ORV14_FINANCE_EVIDENCE: UI_EVIDENCE,
      },
      stdio: 'inherit',
    });
    resultCode = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => play.kill('SIGTERM'), 8 * 60 * 1000);
      play.once('error', (error) => {
        clearTimeout(timeout);
        reject(error);
      });
      play.once('close', (code) => {
        clearTimeout(timeout);
        resolve(code ?? 1);
      });
    });
  } finally {
    if (app) {
      await app.close({ timeoutMs: 10_000, pollIntervalMs: 100 }).catch((error) => {
        process.stderr.write(`ORV14_PRIVATE_UI_CLOSE_ERROR class=${error?.constructor?.name ?? 'Error'}\n`);
        resultCode = 1;
      });
    }
    if (migrationDb) await migrationDb.close().catch(() => undefined);
    if (ownedS3Client) {
      if (s3BucketCreated) {
        try {
          await deleteOwnedBucket(ownedS3Client);
          s3BucketCreated = false;
          bucketAbsent = true;
        } catch (error) {
          process.stderr.write(`ORV14_PRIVATE_UI_BUCKET_CLEANUP_ERROR class=${error?.constructor?.name ?? 'Error'}\n`);
          bucketAbsent = false;
          resultCode = 1;
        }
      }
      ownedS3Client.destroy();
      ownedS3Client = undefined;
    }
    if (s3ContainerCreated) {
      const stopped = spawnSync('docker', ['stop', storageContainer], { stdio: 'ignore', timeout: 30_000 });
      const afterStop = spawnSync('docker', ['inspect', storageContainer], { stdio: 'ignore' });
      containerAbsent = afterStop.status !== 0;
      if (stopped.status !== 0 && !containerAbsent) resultCode = 1;
    }
    if (schemaCreated) {
      await baseDb.query(`DROP SCHEMA "${isolation.dbSchema}" CASCADE`);
    }
    await baseDb.close();
    const schemaCheck = await createDb(baseDatabaseUrl);
    const schemaResult = await schemaCheck.query('SELECT EXISTS(SELECT 1 FROM information_schema.schemata WHERE schema_name=$1) AS present', [isolation.dbSchema]);
    const schemaAbsent = schemaResult.rows[0]?.present === false;
    await schemaCheck.close();
    const redisCheck = new Redis(redisUrl, { lazyConnect: true, maxRetriesPerRequest: 1, connectTimeout: 1500 });
    await redisCheck.connect();
    const redisKeysAfter = await redisCheck.dbsize();
    redisCheck.disconnect();
    const redisEmptyAfter = redisKeysAfter === 0;
    process.stdout.write(`ORV14_PRIVATE_UI_CLEANUP schemaAbsent=${schemaAbsent} redisEmptyAfter=${redisEmptyAfter} redisKeysAfter=${redisKeysAfter} ownedBucketAbsent=${bucketAbsent} ownedContainerAbsent=${containerAbsent}\n`);
    if (!schemaAbsent || !redisEmptyAfter || !bucketAbsent || !containerAbsent) resultCode = 1;
  }
  process.exitCode = resultCode;
}

main().catch((error) => {
  const stack = typeof error?.stack === 'string' ? error.stack.split('\n').slice(1, 9).map((line) => line.trim()).join(' | ') : '';
  process.stderr.write(`ORV14_PRIVATE_UI_FATAL class=${error?.constructor?.name ?? 'Error'} message=${String(error?.message ?? error).slice(0, 600)} stack=${stack.slice(0, 1200)}\n`);
  process.exitCode = 1;
});
