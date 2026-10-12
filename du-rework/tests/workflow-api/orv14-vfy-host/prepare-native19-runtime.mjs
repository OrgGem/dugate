import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const RAW_DIR = path.join(ROOT, 'coordination/reports/raw/orv14-host-verification');
const statePath = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !path.isAbsolute(statePath)) throw new Error('pass the absolute A2 Native19 continuation state file');
if (process.execPath !== NODE || process.getuid?.() !== 1000) throw new Error('run with pinned Node 24.21.0 as UID 1000');

const sha = value => createHash('sha256').update(value).digest('hex');
const now = () => new Date().toISOString();
const safeOrigin = value => {
  const parsed = new URL(value);
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname), 'fixture service must be loopback');
  assert.ok(['http:', 'https:'].includes(parsed.protocol));
  assert.equal(parsed.username, '');
  assert.equal(parsed.password, '');
  assert.equal(parsed.search, '');
  assert.equal(parsed.hash, '');
  return parsed.origin;
};
const stateInfo = await lstat(statePath);
assert.ok(stateInfo.isFile() && !stateInfo.isSymbolicLink(), 'continuation state must be a regular file');
assert.equal(stateInfo.mode & 0o077, 0, 'continuation state must be mode 0600');
const state = JSON.parse(await readFile(statePath, 'utf8'));
assert.ok(state.fixture?.root?.startsWith('/tmp/orv14-vfy-host-'), 'fixture root must belong to the verifier namespace');
assert.ok(/^orv14-vfy-host-[a-z0-9-]+$/.test(state.fixture.projectId), 'Compose project must be verifier-owned');
assert.equal(state.fixture.cleaned, false, 'Native19 fixture must still be live for the current continuity run');
assert.equal(state.run?.sourceRowCounts?.AppSetting, 19);
assert.equal(state.run?.sourceRowCounts?.ExternalApiConnection, 2);
assert.ok(state.run?.sourceUrl && state.run?.targetUrl && state.run?.connectorTargetUrl);

const secretPath = path.join(state.fixture.root, 'native19-runtime-secrets.json');
const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
const transitKeyName = `orv14_vfy_native19_meta_${suffix}`;
const transitKeyRef = `vfy-native19-meta-${suffix}`;
const encryptPolicy = `orv14-vfy-n19-enc-${suffix}`;
const decryptPolicy = `orv14-vfy-n19-dec-${suffix}`;
const bucket = state.run.syntheticIds?.s3Bucket;
assert.equal(typeof bucket, 'string');
assert.ok(bucket.startsWith('orv14-vfy-'), 'storage bucket must be synthetic and unique');
const vaultOrigin = safeOrigin(state.fixture.urls.vaultRestore);
const storageOrigin = safeOrigin(state.fixture.urls.s3Restore);
const providerOrigin = safeOrigin(state.run.providerOrigin);
const fixtureSecret = value => {
  assert.equal(typeof value, 'string');
  assert.ok(value.length > 0);
  return value;
};

function safeDockerProjectCheck() {
  const result = spawnSync('docker', ['ps', '--all', '--quiet', '--filter', `label=com.docker.compose.project=${state.fixture.projectId}`], {
    encoding: 'utf8', timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  if (result.status !== 0) throw new Error('OWNED_COMPOSE_INSPECTION_FAILED');
  const ids = result.stdout.trim().split(/\r?\n/).filter(Boolean);
  assert.equal(ids.length, 10, 'the exact owned Native19 Compose project should have ten containers');
  return ids.length;
}

async function vaultRequest(token, method, endpoint, body) {
  const response = await fetch(`${vaultOrigin}${endpoint}`, {
    method,
    headers: { 'x-vault-token': token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const text = await response.text();
  let parsed;
  try { parsed = text ? JSON.parse(text) : {}; } catch { throw new Error(`VAULT_RESPONSE_INVALID_${response.status}`); }
  if (!response.ok) throw new Error(`VAULT_HTTP_${response.status}`);
  return parsed;
}

async function verifyTransitMount(rootToken) {
  const mounts = await vaultRequest(rootToken, 'GET', '/v1/sys/mounts');
  const transit = mounts?.data?.['transit/'] ?? mounts?.data?.transit;
  if (transit) {
    assert.equal(transit.type, 'transit', 'the unique restore Vault transit mount must have the expected engine type');
    return 'already-enabled';
  }
  await vaultRequest(rootToken, 'POST', '/v1/sys/mounts/transit', { type: 'transit' });
  const after = await vaultRequest(rootToken, 'GET', '/v1/sys/mounts');
  assert.equal((after?.data?.['transit/'] ?? after?.data?.transit)?.type, 'transit');
  return 'enabled';
}

async function createTransitIdentities(rootToken) {
  await vaultRequest(rootToken, 'POST', `/v1/transit/keys/${encodeURIComponent(transitKeyName)}`, {
    type: 'aes256-gcm96',
    exportable: false,
    allow_plaintext_backup: false,
  });
  const keyInfo = await vaultRequest(rootToken, 'GET', `/v1/transit/keys/${encodeURIComponent(transitKeyName)}`);
  assert.equal(keyInfo?.data?.type, 'aes256-gcm96');
  assert.equal(keyInfo?.data?.exportable, false);

  const encryptHcl = `path "transit/encrypt/${transitKeyName}" {\n  capabilities = ["update"]\n}\n`;
  const decryptHcl = `path "transit/decrypt/${transitKeyName}" {\n  capabilities = ["update"]\n}\n`;
  await vaultRequest(rootToken, 'PUT', `/v1/sys/policies/acl/${encodeURIComponent(encryptPolicy)}`, { policy: encryptHcl });
  await vaultRequest(rootToken, 'PUT', `/v1/sys/policies/acl/${encodeURIComponent(decryptPolicy)}`, { policy: decryptHcl });
  const enc = await vaultRequest(rootToken, 'POST', '/v1/auth/token/create', {
    policies: [encryptPolicy], no_default_policy: true, renewable: false, ttl: '12h',
  });
  const dec = await vaultRequest(rootToken, 'POST', '/v1/auth/token/create', {
    policies: [decryptPolicy], no_default_policy: true, renewable: false, ttl: '12h',
  });
  const encToken = enc?.auth?.client_token;
  const decToken = dec?.auth?.client_token;
  assert.ok(typeof encToken === 'string' && encToken.length > 0);
  assert.ok(typeof decToken === 'string' && decToken.length > 0);
  assert.notEqual(encToken, decToken);

  const probe = randomBytes(32);
  const wrapped = await vaultRequest(encToken, 'POST', `/v1/transit/encrypt/${encodeURIComponent(transitKeyName)}`, {
    plaintext: probe.toString('base64'),
  });
  const ciphertext = wrapped?.data?.ciphertext;
  assert.ok(typeof ciphertext === 'string' && /^vault:v[1-9][0-9]*:/.test(ciphertext));
  const unwrapped = await vaultRequest(decToken, 'POST', `/v1/transit/decrypt/${encodeURIComponent(transitKeyName)}`, { ciphertext });
  assert.equal(Buffer.from(unwrapped?.data?.plaintext || '', 'base64').equals(probe), true);

  // The encrypt token must not decrypt and the decrypt token must not encrypt.
  const encDenied = await fetch(`${vaultOrigin}/v1/transit/decrypt/${encodeURIComponent(transitKeyName)}`, {
    method: 'POST', headers: { 'x-vault-token': encToken, 'content-type': 'application/json' },
    body: JSON.stringify({ ciphertext }), signal: AbortSignal.timeout(10_000),
  });
  const decDenied = await fetch(`${vaultOrigin}/v1/transit/encrypt/${encodeURIComponent(transitKeyName)}`, {
    method: 'POST', headers: { 'x-vault-token': decToken, 'content-type': 'application/json' },
    body: JSON.stringify({ plaintext: probe.toString('base64') }), signal: AbortSignal.timeout(10_000),
  });
  assert.equal(encDenied.status, 403);
  assert.equal(decDenied.status, 403);
  return { encToken, decToken, encryptAccessorHash: sha(enc?.auth?.accessor || ''), decryptAccessorHash: sha(dec?.auth?.accessor || '') };
}

async function prepareS3Bucket() {
  const require = createRequire(path.join(ROOT, 'orchestrator/services/orchestrator/package.json'));
  const { S3Client, CreateBucketCommand, HeadBucketCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const s3 = new S3Client({
    endpoint: storageOrigin,
    region: state.run.syntheticIds.s3Region || 'us-east-1',
    forcePathStyle: true,
    credentials: {
      accessKeyId: fixtureSecret(state.fixture.credentials.s3AccessKey),
      secretAccessKey: fixtureSecret(state.fixture.credentials.s3SecretKey),
    },
  });
  try {
    let existed = false;
    try {
      await s3.send(new HeadBucketCommand({ Bucket: bucket }));
      existed = true;
    } catch (error) {
      const status = error?.$metadata?.httpStatusCode;
      const code = error?.name;
      if (status !== 404 && code !== 'NotFound' && code !== 'NoSuchBucket') throw new Error('S3_BUCKET_HEAD_FAILED');
    }
    if (!existed) await s3.send(new CreateBucketCommand({ Bucket: bucket }));
    await s3.send(new HeadBucketCommand({ Bucket: bucket }));
    const listing = await s3.send(new ListObjectsV2Command({ Bucket: bucket, MaxKeys: 1 }));
    assert.equal(Number(listing?.KeyCount || 0), 0, 'new synthetic storage generation bucket must begin empty');
    return { existed, bucketReady: true, initialObjects: Number(listing?.KeyCount || 0) };
  } finally { s3.destroy(); }
}

const raw = {
  schema: 'orv14-native19-runtime-preparation/v1',
  command: `${NODE} tests/workflow-api/orv14-vfy-host/prepare-native19-runtime.mjs ${statePath}`,
  cwd: ROOT,
  node: 'v24.21.0',
  verifierUid: process.getuid?.() ?? null,
  startedAt: now(),
  stateFile: statePath,
  stateModeVerified: true,
  fixtureNamespace: state.fixture.projectId,
  ownedComposeContainers: null,
  providerBaseline: null,
  vaultOrigin,
  storageOrigin,
  providerOrigin,
  composeFileSha256: state.fixture.composeSha256,
  imageIds: state.fixture.imageIds,
  transit: null,
  s3: null,
  secretsFile: secretPath,
  secretValuesRecorded: false,
  status: 'RUNNING',
};

try {
  raw.ownedComposeContainers = safeDockerProjectCheck();
  const provider = await fetch(`${providerOrigin}/__stats`, { signal: AbortSignal.timeout(3000) });
  assert.equal(provider.ok, true, 'synthetic provider endpoint must answer');
  const providerStats = await provider.json();
  assert.equal(Number.isSafeInteger(providerStats.count), true);
  raw.providerBaseline = { count: providerStats.count, requestMethods: providerStats.methods || null };

  let secrets;
  let reused = false;
  try {
    const info = await lstat(secretPath);
    assert.ok(info.isFile() && !info.isSymbolicLink());
    assert.equal(info.mode & 0o077, 0, 'runtime secret file must be mode 0600');
    secrets = JSON.parse(await readFile(secretPath, 'utf8'));
    reused = true;
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    const rootToken = fixtureSecret(state.fixture.credentials.vaultToken);
    raw.transitMount = await verifyTransitMount(rootToken);
    const transit = await createTransitIdentities(rootToken);
    const catalogKey = randomBytes(32);
    const invocationGrantText = randomBytes(24).toString('base64url');
    assert.equal(Buffer.byteLength(invocationGrantText, 'utf8'), 32);
    secrets = {
      createdAt: now(),
      fixtureProjectId: state.fixture.projectId,
      adminToken: randomBytes(32).toString('base64url'),
      serviceIdentitySecret: randomBytes(32).toString('base64'),
      invocationGrantSecret: invocationGrantText,
      connectorEncryptionKey: state.run.connectorEncryptionKey,
      encryptionKey: randomBytes(32).toString('base64'),
      secretCatalogKeyVersion: 'vfy-native19-k1',
      secretCatalogKey: catalogKey.toString('base64'),
      transitKeyName,
      transitKeyRef,
      encryptPolicy,
      decryptPolicy,
      vaultEncryptToken: transit.encToken,
      vaultDecryptToken: transit.decToken,
      vaultEncryptAccessorHash: transit.encryptAccessorHash,
      vaultDecryptAccessorHash: transit.decryptAccessorHash,
      storageBucket: bucket,
      storageRegion: 'us-east-1',
      hostPorts: {},
    };
    await writeFile(secretPath, JSON.stringify(secrets, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    await chmod(secretPath, 0o600);
    raw.transit = {
      mount: 'transit', keyName: transitKeyName, keyRef: transitKeyRef,
      keyType: 'aes256-gcm96', exportable: false,
      separateEncryptDecryptTokens: true,
      encryptDecryptProbe: 'PASSED',
      encryptTokenDecryptDenied: encDeniedStatusSafe(403),
      decryptTokenEncryptDenied: encDeniedStatusSafe(403),
      encryptAccessorSha256: transit.encryptAccessorHash,
      decryptAccessorSha256: transit.decryptAccessorHash,
    };
  }
  assert.equal(secrets.fixtureProjectId, state.fixture.projectId);
  assert.equal(secrets.connectorEncryptionKey, state.run.connectorEncryptionKey);
  raw.secretsFileModeVerified = true;
  raw.secretsFileSha256 = sha(await readFile(secretPath));
  raw.secretsReused = reused;
  raw.transit ??= {
    mount: 'transit', keyName: secrets.transitKeyName, keyRef: secrets.transitKeyRef,
    keyType: 'aes256-gcm96', exportable: false,
    separateEncryptDecryptTokens: true,
    encryptDecryptProbe: 'previously-passed-and-secret-file-pinned',
    encryptAccessorSha256: secrets.vaultEncryptAccessorHash,
    decryptAccessorSha256: secrets.vaultDecryptAccessorHash,
  };
  raw.s3 = await prepareS3Bucket();
  raw.s3.bucket = bucket;
  raw.s3.endpointOrigin = storageOrigin;
  raw.status = 'PASSED_SYNTHETIC_RUNTIME_PREPARATION';
} catch (error) {
  raw.status = 'FAILED';
  raw.errorCode = error?.code || null;
  raw.error = String(error?.stack || error).replace(/(client_token|rootToken|vaultEncryptToken|vaultDecryptToken)[^\n]*/gi, '$1=<redacted>').slice(0, 5000);
}

raw.completedAt = now();
await mkdir(RAW_DIR, { recursive: true });
const receipt = path.join(RAW_DIR, `native19-runtime-prep-${state.fixture.projectId}-${Date.now()}.json`);
await writeFile(receipt, JSON.stringify(raw, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
process.stdout.write(JSON.stringify({ status: raw.status, fixtureNamespace: raw.fixtureNamespace,
  ownedComposeContainers: raw.ownedComposeContainers, vaultKeyVersionConfigured: Boolean(raw.transit?.encryptDecryptProbe),
  storageBucketReady: Boolean(raw.s3?.bucketReady), secretsFileModeVerified: raw.secretsFileModeVerified || false,
  rawReceipt: path.relative(ROOT, receipt) }, null, 2) + '\n');
if (raw.status !== 'PASSED_SYNTHETIC_RUNTIME_PREPARATION') process.exitCode = 1;

function encDeniedStatusSafe(status) { return status === 403 ? 'PASSED' : 'FAILED'; }
