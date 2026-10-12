import { constants as cryptoConstants, createCipheriv, createHash, publicEncrypt, randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  assertInfrastructureHealthy,
  cleanupHostInfrastructureFixture,
  createHostInfrastructureFixture,
  stopOwnedService,
} from './infrastructure.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const RAW = path.join(REPO, 'coordination/reports/raw/orv14-host-verification');
const require = createRequire(path.join(REPO, 'orchestrator/services/orchestrator/package.json'));
const {
  S3Client,
  CreateBucketCommand,
  PutBucketVersioningCommand,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectVersionsCommand,
  DeleteBucketCommand,
} = require('@aws-sdk/client-s3');

function sha256(value) { return createHash('sha256').update(value).digest('hex'); }

function xorCounter(block, counter) {
  const result = Buffer.from(block);
  for (let index = 7; index >= 0 && counter > 0; index -= 1) {
    result[index] ^= counter & 0xff;
    counter = Math.floor(counter / 256);
  }
  return result;
}

function aesBlock(key, bytes) {
  const cipher = createCipheriv('aes-256-ecb', key, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(bytes), cipher.final()]);
}

function wrapTargetKeyKwp(kek, plaintext) {
  if (kek.length !== 32 || plaintext.length < 1) throw new Error('VAULT_BYOK_KEY_SIZE_INVALID');
  const blocks = Math.ceil(plaintext.length / 8);
  const padded = Buffer.alloc(blocks * 8);
  plaintext.copy(padded);
  const initialValue = Buffer.alloc(8);
  initialValue.writeUInt32BE(0xa65959a6, 0);
  initialValue.writeUInt32BE(plaintext.length, 4);
  const r = Array.from({ length: blocks }, (_, index) => Buffer.from(padded.subarray(index * 8, index * 8 + 8)));
  let a = initialValue;
  for (let j = 0; j < 6; j += 1) {
    for (let i = 0; i < blocks; i += 1) {
      const encrypted = aesBlock(kek, Buffer.concat([a, r[i]]));
      a = xorCounter(encrypted.subarray(0, 8), blocks * j + i + 1);
      r[i] = Buffer.from(encrypted.subarray(8));
    }
  }
  padded.fill(0);
  return Buffer.concat([a, ...r]);
}

function wrapVaultImport(publicKeyPem, targetKey) {
  const ephemeralAesKey = randomBytes(32);
  try {
    const wrappedAesKey = publicEncrypt({ key: publicKeyPem, padding: cryptoConstants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, ephemeralAesKey);
    const wrappedTargetKey = wrapTargetKeyKwp(ephemeralAesKey, targetKey);
    if (wrappedAesKey.length !== 512 || wrappedTargetKey.length < 16) throw new Error('VAULT_BYOK_WRAPPED_KEY_SIZE_INVALID');
    return Buffer.concat([wrappedAesKey, wrappedTargetKey]).toString('base64');
  } finally {
    ephemeralAesKey.fill(0);
  }
}

async function vaultRequest(baseUrl, token, route, { method = 'GET', body } = {}) {
  const response = await fetch(`${baseUrl}/v1/${route}`, {
    method,
    headers: {
      'X-Vault-Token': token,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(10_000),
  });
  let data = null;
  try { data = await response.json(); } catch { /* status below is sufficient */ }
  return { ok: response.ok, status: response.status, data };
}

async function requireVault(baseUrl, token, route, options) {
  const result = await vaultRequest(baseUrl, token, route, options);
  if (!result.ok) {
    const codes = Array.isArray(result.data?.errors) ? result.data.errors.map((item) => String(item).slice(0, 80)) : [];
    throw new Error(`VAULT_${options?.method ?? 'GET'}_${route.split('/').slice(0, 3).join('_')}_HTTP_${result.status}${codes.length ? `_${codes.join('_')}` : ''}`);
  }
  return result.data;
}

async function readBody(response) {
  return Buffer.from(await response.Body.transformToByteArray());
}

async function deleteBucketVersions(client, bucket) {
  let versions;
  try {
    versions = await client.send(new ListObjectVersionsCommand({ Bucket: bucket }));
  } catch (error) {
    if (error?.$metadata?.httpStatusCode === 404) return;
    throw new Error('MINIO_LIST_VERSIONS_CLEANUP_FAILED');
  }
  for (const item of [...(versions.Versions ?? []), ...(versions.DeleteMarkers ?? [])]) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: item.Key, VersionId: item.VersionId }));
  }
  await client.send(new DeleteBucketCommand({ Bucket: bucket }));
}

async function prepareTransitFamilyRecovery(fixture, token, family) {
  const transitKey = `orv14-${family}-${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const sample = Buffer.from(`synthetic ${family} transit archive at exact key version one`);
  await requireVault(fixture.urls.vaultSource, token, `transit/keys/${transitKey}`, {
    method: 'POST', body: { type: 'aes256-gcm96', exportable: true, allow_plaintext_backup: true },
  });
  const encryptedV1 = await requireVault(fixture.urls.vaultSource, token, `transit/encrypt/${transitKey}`, {
    method: 'POST', body: { plaintext: sample.toString('base64'), key_version: 1 },
  });
  await requireVault(fixture.urls.vaultSource, token, `transit/keys/${transitKey}/rotate`, { method: 'POST', body: {} });
  const encryptedV2 = await requireVault(fixture.urls.vaultSource, token, `transit/encrypt/${transitKey}`, {
    method: 'POST', body: { plaintext: sample.toString('base64'), key_version: 2 },
  });
  const exported = await requireVault(fixture.urls.vaultSource, token, `transit/export/encryption-key/${transitKey}/1`);
  const materialText = exported?.data?.keys?.['1'];
  if (typeof materialText !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(materialText)) {
    throw new Error(`VAULT_${family.toUpperCase()}_EXPORTED_V1_KEY_MISSING`);
  }
  const material = Buffer.from(materialText, 'base64');
  if (material.length !== 32 || material.toString('base64') !== materialText) {
    material.fill(0);
    throw new Error(`VAULT_${family.toUpperCase()}_EXPORTED_V1_KEY_INVALID`);
  }
  let wrappedImport;
  try {
    const wrappingKey = await requireVault(fixture.urls.vaultRestore, token, 'transit/wrapping_key');
    const publicKeyPem = wrappingKey?.data?.public_key;
    if (typeof publicKeyPem !== 'string' || !publicKeyPem.includes('BEGIN PUBLIC KEY')) {
      throw new Error(`VAULT_${family.toUpperCase()}_DESTINATION_WRAPPING_KEY_MISSING`);
    }
    wrappedImport = wrapVaultImport(publicKeyPem, material);
  } finally {
    material.fill(0);
  }
  await requireVault(fixture.urls.vaultRestore, token, `transit/keys/${transitKey}/import`, {
    method: 'POST', body: { type: 'aes256-gcm96', ciphertext: wrappedImport, hash_function: 'SHA256' },
  });
  wrappedImport = null;
  const decrypt = (ciphertext) => requireVault(fixture.urls.vaultRestore, token, `transit/decrypt/${transitKey}`, {
    method: 'POST', body: { ciphertext },
  });
  const recovered = await decrypt(encryptedV1?.data?.ciphertext);
  if (Buffer.from(recovered?.data?.plaintext ?? '', 'base64').compare(sample) !== 0) {
    throw new Error(`VAULT_${family.toUpperCase()}_ARCHIVED_V1_DECRYPT_FAILED`);
  }
  const v2Result = await vaultRequest(fixture.urls.vaultRestore, token, `transit/decrypt/${transitKey}`, {
    method: 'POST', body: { ciphertext: encryptedV2?.data?.ciphertext },
  });
  if (v2Result.ok) throw new Error(`VAULT_${family.toUpperCase()}_UNIMPORTED_V2_UNEXPECTEDLY_DECRYPTED`);
  return {
    keyRef: transitKey,
    sample,
    archivedCiphertext: encryptedV1?.data?.ciphertext,
    recovery: {
      family,
      sourceKeyVersions: [1, 2],
      importedKeyVersion: 1,
      archivedV1DecryptBeforeSourceOff: true,
      v2RejectedAtRestoreTarget: true,
      sampleSha256: sha256(sample),
      v1CiphertextSha256: sha256(Buffer.from(encryptedV1.data.ciphertext)),
      v2CiphertextSha256: sha256(Buffer.from(encryptedV2.data.ciphertext)),
    },
  };
}

const startedAt = new Date().toISOString();
const fixture = await createHostInfrastructureFixture();
const s3Clients = [];
const createdBuckets = [];
let outcome = 'FAILED';
let error = null;
let cleanup = null;
let health = null;
let versionedStorage = null;
let transitRecovery = null;
  let transitFamilyRecoveries = [];
let sourceVaultStopped = null;

try {
  health = await assertInfrastructureHealthy(fixture);

  const credentials = { accessKeyId: fixture.credentials.s3AccessKey, secretAccessKey: fixture.credentials.s3SecretKey };
  const sourceS3 = new S3Client({ endpoint: fixture.urls.s3Source, region: 'us-east-1', forcePathStyle: true, credentials });
  const restoreS3 = new S3Client({ endpoint: fixture.urls.s3Restore, region: 'us-east-1', forcePathStyle: true, credentials });
  s3Clients.push(sourceS3, restoreS3);
  const sourceBucket = `orv14-host-${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const restoreBucket = `orv14-host-${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  const objectKey = 'synthetic/source-version.txt';
  const version1Body = Buffer.from('orv14 synthetic generation source object version 1\n');
  const version2Body = Buffer.from('orv14 synthetic generation source object version 2\n');
  const sourceObjectBody = Buffer.from('orv14 synthetic restored generation object\n');
  await sourceS3.send(new CreateBucketCommand({ Bucket: sourceBucket }));
  createdBuckets.push({ client: sourceS3, bucket: sourceBucket });
  await sourceS3.send(new PutBucketVersioningCommand({ Bucket: sourceBucket, VersioningConfiguration: { Status: 'Enabled' } }));
  const first = await sourceS3.send(new PutObjectCommand({ Bucket: sourceBucket, Key: objectKey, Body: version1Body }));
  const second = await sourceS3.send(new PutObjectCommand({ Bucket: sourceBucket, Key: objectKey, Body: version2Body }));
  if (!first.VersionId || !second.VersionId || first.VersionId === second.VersionId) throw new Error('MINIO_SOURCE_OBJECT_VERSIONING_MISSING');
  const pinnedFirst = await sourceS3.send(new GetObjectCommand({ Bucket: sourceBucket, Key: objectKey, VersionId: first.VersionId }));
  const latest = await sourceS3.send(new GetObjectCommand({ Bucket: sourceBucket, Key: objectKey }));
  const pinnedFirstBytes = await readBody(pinnedFirst);
  const latestBytes = await readBody(latest);
  if (!pinnedFirstBytes.equals(version1Body) || !latestBytes.equals(version2Body)) throw new Error('MINIO_SOURCE_EXACT_VERSION_READ_FAILED');

  await restoreS3.send(new CreateBucketCommand({ Bucket: restoreBucket }));
  createdBuckets.push({ client: restoreS3, bucket: restoreBucket });
  await restoreS3.send(new PutBucketVersioningCommand({ Bucket: restoreBucket, VersioningConfiguration: { Status: 'Enabled' } }));
  const restoredObject = await restoreS3.send(new PutObjectCommand({ Bucket: restoreBucket, Key: objectKey, Body: sourceObjectBody }));
  if (!restoredObject.VersionId) throw new Error('MINIO_RESTORE_OBJECT_VERSIONING_MISSING');
  const independentRead = await restoreS3.send(new GetObjectCommand({ Bucket: restoreBucket, Key: objectKey, VersionId: restoredObject.VersionId }));
  if (!(await readBody(independentRead)).equals(sourceObjectBody)) throw new Error('MINIO_RESTORE_GENERATION_READ_FAILED');
  versionedStorage = {
    sourceEndpoint: 'isolated-source-minio',
    restoreEndpoint: 'isolated-restore-minio',
    sourceBucket,
    restoreBucket,
    objectKey,
    sourceVersionsDistinct: first.VersionId !== second.VersionId,
    exactOlderVersionRead: true,
    latestVersionRead: true,
    independentRestoreEndpointRead: true,
    sha256: { older: sha256(pinnedFirstBytes), latest: sha256(latestBytes), restore: sha256(sourceObjectBody) },
  };

  const token = fixture.credentials.vaultToken;
  await requireVault(fixture.urls.vaultSource, token, 'sys/mounts/transit', { method: 'POST', body: { type: 'transit' } });
  await requireVault(fixture.urls.vaultRestore, token, 'sys/mounts/transit', { method: 'POST', body: { type: 'transit' } });
  const transitKey = `orv14-host-${randomUUID().replaceAll('-', '').slice(0, 18)}`;
  await requireVault(fixture.urls.vaultSource, token, `transit/keys/${transitKey}`, {
    method: 'POST', body: { type: 'aes256-gcm96', exportable: true, allow_plaintext_backup: true },
  });
  const sample = Buffer.from('synthetic archived artifact transit key continuity probe');
  const encryptedV1 = await requireVault(fixture.urls.vaultSource, token, `transit/encrypt/${transitKey}`, {
    method: 'POST', body: { plaintext: sample.toString('base64'), key_version: 1 },
  });
  await requireVault(fixture.urls.vaultSource, token, `transit/keys/${transitKey}/rotate`, { method: 'POST', body: {} });
  const encryptedV2 = await requireVault(fixture.urls.vaultSource, token, `transit/encrypt/${transitKey}`, {
    method: 'POST', body: { plaintext: sample.toString('base64'), key_version: 2 },
  });
  const exported = await requireVault(fixture.urls.vaultSource, token, `transit/export/encryption-key/${transitKey}/1`);
  const archivedV1MaterialText = exported?.data?.keys?.['1'];
  if (typeof archivedV1MaterialText !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(archivedV1MaterialText)) {
    throw new Error('VAULT_EXPORTED_VERSION_ONE_KEY_MISSING');
  }
  const archivedV1Material = Buffer.from(archivedV1MaterialText, 'base64');
  if (archivedV1Material.length !== 32 || archivedV1Material.toString('base64') !== archivedV1MaterialText) {
    archivedV1Material.fill(0);
    throw new Error('VAULT_EXPORTED_VERSION_ONE_KEY_INVALID');
  }
  let wrappedImport = null;
  try {
    const wrappingKey = await requireVault(fixture.urls.vaultRestore, token, 'transit/wrapping_key');
    const publicKeyPem = wrappingKey?.data?.public_key;
    if (typeof publicKeyPem !== 'string' || !publicKeyPem.includes('BEGIN PUBLIC KEY')) throw new Error('VAULT_DESTINATION_WRAPPING_KEY_MISSING');
    wrappedImport = wrapVaultImport(publicKeyPem, archivedV1Material);
  } finally {
    archivedV1Material.fill(0);
  }
  await requireVault(fixture.urls.vaultRestore, token, `transit/keys/${transitKey}/import`, {
    method: 'POST', body: { type: 'aes256-gcm96', ciphertext: wrappedImport, hash_function: 'SHA256' },
  });
  wrappedImport = null;
  const decryptPinned = async (ciphertext) => requireVault(fixture.urls.vaultRestore, token, `transit/decrypt/${transitKey}`, {
    method: 'POST', body: { ciphertext },
  });
  const recoveredV1 = await decryptPinned(encryptedV1?.data?.ciphertext);
  if (Buffer.from(recoveredV1?.data?.plaintext ?? '', 'base64').compare(sample) !== 0) throw new Error('VAULT_ARCHIVED_VERSION_ONE_DECRYPT_FAILED');
  const wrongVersion = await vaultRequest(fixture.urls.vaultRestore, token, `transit/decrypt/${transitKey}`, {
    method: 'POST', body: { ciphertext: encryptedV2?.data?.ciphertext },
  });
  if (wrongVersion.ok) throw new Error('VAULT_UNIMPORTED_VERSION_TWO_UNEXPECTEDLY_DECRYPTED');
  const transitFamilyProbes = [];
  for (const family of ['metadata', 'artifact']) {
    transitFamilyProbes.push(await prepareTransitFamilyRecovery(fixture, token, family));
  }
  sourceVaultStopped = stopOwnedService(fixture, 'vault');
  const recoveredAfterSourceOff = await decryptPinned(encryptedV1?.data?.ciphertext);
  if (Buffer.from(recoveredAfterSourceOff?.data?.plaintext ?? '', 'base64').compare(sample) !== 0) throw new Error('VAULT_SOURCE_OFF_ARCHIVED_KEY_DECRYPT_FAILED');
  transitFamilyRecoveries = [];
  for (const probe of transitFamilyProbes) {
    const recovered = await requireVault(fixture.urls.vaultRestore, token, `transit/decrypt/${probe.keyRef}`, {
      method: 'POST', body: { ciphertext: probe.archivedCiphertext },
    });
    const plaintext = Buffer.from(recovered?.data?.plaintext ?? '', 'base64');
    const matched = plaintext.compare(probe.sample) === 0;
    plaintext.fill(0);
    probe.sample.fill(0);
    if (!matched) throw new Error(`VAULT_${probe.recovery.family.toUpperCase()}_ARCHIVED_V1_SOURCE_OFF_DECRYPT_FAILED`);
    transitFamilyRecoveries.push({ ...probe.recovery, archivedV1DecryptAfterSourceOff: true });
  }
  transitRecovery = {
    sourceKeyVersions: [1, 2],
    independentlyImportedVersions: [1],
    archivedVersionOneDecrypts: true,
    versionTwoAbsentFromRecoveryStore: true,
    sourceVaultStopped: sourceVaultStopped.running === false,
    archivedVersionOneDecryptAfterSourceOff: true,
    sampleSha256: sha256(sample),
    v1CiphertextSha256: sha256(Buffer.from(encryptedV1.data.ciphertext)),
    v2CiphertextSha256: sha256(Buffer.from(encryptedV2.data.ciphertext)),
    independentMetadataAndArtifactKeyFamilies: transitFamilyRecoveries,
  };

  outcome = 'PASSED';
} catch (caught) {
  const message = caught instanceof Error ? caught.message : 'unknown fabric fixture failure';
  error = message.slice(0, 500);
} finally {
  for (const bucket of createdBuckets.reverse()) {
    try { await deleteBucketVersions(bucket.client, bucket.bucket); }
    catch { error = `${error ? `${error}; ` : ''}S3_OWNED_BUCKET_CLEANUP_FAILED`; outcome = 'FAILED'; }
  }
  for (const client of s3Clients) client.destroy();
  try { cleanup = await cleanupHostInfrastructureFixture(fixture); }
  catch (caught) {
    outcome = 'FAILED';
    const message = caught instanceof Error ? caught.message.slice(0, 300) : 'unknown Compose cleanup error';
    error = `${error ? `${error}; ` : ''}COMPOSE_CLEANUP_FAILED:${message}`;
  }
}

const result = {
  task: 'VFY-ORV14-HOST-CONTINUITY',
  stage: 'source-independent isolated storage and transit recovery preparation',
  outcome,
  startedAt,
  completedAt: new Date().toISOString(),
  cwd: REPO,
  nodeVersion: process.version,
  composeProject: fixture.projectId,
  composeSha256: fixture.composeSha256,
  imageIds: fixture.imageIds,
  checks: {
    passed: outcome === 'PASSED' ? 8 : 0,
    failed: outcome === 'PASSED' ? 0 : 1,
    skipped: 0,
    health,
    versionedStorage,
    transitRecovery,
    transitFamilyRecoveries,
    sourceVaultStopped,
  },
  cleanup,
  verdict: 'Preparation evidence only. The tests used synthetic S3 objects and synthetic Transit keys; no application, source data, customer credentials, backup, restore, workflow, migration, or cutover was executed.',
  error,
};

await mkdir(RAW, { recursive: true });
const rawPath = path.join(RAW, `isolated-fabrics-preparation-${fixture.projectId}.json`);
await writeFile(rawPath, `${JSON.stringify(result, null, 2)}\n`, { mode: 0o600 });
process.stdout.write(`${JSON.stringify({ outcome, composeProject: fixture.projectId, checks: result.checks, cleanup: Boolean(cleanup), rawPath })}\n`);
if (outcome !== 'PASSED') process.exitCode = 1;
