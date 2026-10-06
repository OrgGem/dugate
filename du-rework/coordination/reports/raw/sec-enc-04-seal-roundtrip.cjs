/**
 * SEC-ENC-04 offline smoke (owner evidence).
 *
 * Exercises the compiled artifact encryption seam end to end WITHOUT touching
 * source test paths outside this packet's lease:
 *   - seal/open roundtrip for single-shot and chunked envelopes
 *   - ciphertext-only persistence (unique sentinel never appears in storage)
 *   - identity/tenant mismatch and tamper refusals
 *   - PostgreSQL server-write/read facade + pinned verification
 *   - S3 facade server-write/read metadata carrier (fake S3 client)
 *   - artifact service admission -> sealed putBlob -> finalize -> getBlob with
 *     an in-memory fake Db (queries routed by shape, not by a real database)
 *
 * Exit 0 = every assertion passed; any failure prints and exits non-zero.
 */
const { createHash, randomUUID } = require('node:crypto');
const { Readable } = require('node:stream');
const path = require('node:path');
const Module = require('node:module');

// The harness compiles the artifact modules to a temp outDir; resolve
// workspace packages (@du/contracts) through the service's own node_modules.
process.env.NODE_PATH = [
  path.resolve(__dirname, '../../../services/orchestrator/node_modules'),
  process.env.NODE_PATH ?? '',
].join(path.delimiter);
Module._initPaths();

const dist = path.resolve(__dirname, 'sec-enc-04-dist/modules');
const {
  CryptoStorageFacade,
} = require(`${dist}/encryption/crypto-storage-facade.js`);
const {
  sealWorkerArtifact,
  parseWorkerArtifactSidecar,
  openWorkerArtifact,
  verifyWorkerArtifact,
  artifactEncryptionContext,
  manifestKeyFor,
  manifestObjectMetadata,
  sealedObjectMetadata,
} = require(`${dist}/artifacts/artifact-encryption.js`);
const {
  createPostgresArtifactStorageFacade,
} = require(`${dist}/artifacts/postgres-storage-facade.js`);
const {
  createS3ArtifactStorageFacade,
} = require(`${dist}/artifacts/s3-storage-facade.js`);
const {
  createArtifactService,
} = require(`${dist}/artifacts/artifacts.js`);

let checks = 0;
function check(label, condition, detail) {
  checks += 1;
  if (!condition) {
    console.error(`FAIL ${label}${detail === undefined ? '' : ' :: ' + detail}`);
    process.exitCode = 1;
    throw new Error(`assertion failed: ${label}`);
  }
  console.log(`PASS ${label}`);
}

function sha256(bytes) {
  return createHash('sha256').update(bytes).digest('hex');
}

async function expectCode(label, promise, code) {
  try {
    await promise;
    check(label, false, 'expected rejection, resolved instead');
  } catch (error) {
    check(label, error && error.code === code, `code=${error && error.code}`);
  }
}

function makeKeyProvider() {
  return {
    async wrapDek({ dek }) {
      return { keyRef: 'worker-artifact-key', keyVersion: 1, ciphertext: Buffer.from(dek).toString('base64') };
    },
    async unwrapDek(wrapped) {
      return Buffer.from(wrapped.ciphertext, 'base64');
    },
  };
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function main() {
  const facade = new CryptoStorageFacade(makeKeyProvider());
  const seam = { facade, keyRef: 'worker-artifact-key' };
  const sentinel = `SENTINEL-${randomUUID()}`;

  /* ------------------------------------------------------------------ */
  /* 1. Single-shot envelope: roundtrip, ciphertext-only, refusals       */
  /* ------------------------------------------------------------------ */
  const plaintext = Buffer.concat([Buffer.from(`${sentinel}|`), Buffer.alloc(4096, 7)]);
  const identity = { tenantId: 'tenant-a', artifactId: randomUUID(), objectVersion: randomUUID() };
  const sealed = await sealWorkerArtifact({ bytes: plaintext, identity, seam });
  check('single: ciphertext differs from plaintext', !sealed.ciphertext.equals(plaintext));
  check('single: ciphertext carries no plaintext sentinel', !sealed.ciphertext.includes(Buffer.from(sentinel)));
  check('single: sidecar carries no plaintext sentinel', !sealed.sidecar.includes(Buffer.from(sentinel)));
  check('single: plaintext digest reported', sealed.plaintextSha256 === sha256(plaintext));
  check('single: plaintext size reported', sealed.plaintextSizeBytes === plaintext.length);

  const parsed = parseWorkerArtifactSidecar(JSON.parse(sealed.sidecar.toString('utf8')));
  const opened = await openWorkerArtifact({
    sidecar: parsed,
    ciphertext: sealed.ciphertext,
    context: artifactEncryptionContext(identity),
    seam,
  });
  check('single: open roundtrip equals plaintext', opened.equals(plaintext));
  const verified = await verifyWorkerArtifact({
    sidecar: parsed,
    ciphertext: sealed.ciphertext,
    context: artifactEncryptionContext(identity),
    seam,
  });
  check('single: verify reports plaintext metadata', verified.plaintextSha256 === sha256(plaintext)
    && verified.plaintextSizeBytes === plaintext.length);

  await expectCode(
    'single: wrong tenant context is refused',
    openWorkerArtifact({
      sidecar: parsed,
      ciphertext: sealed.ciphertext,
      context: artifactEncryptionContext({ ...identity, tenantId: 'tenant-b' }),
      seam,
    }),
    'ENVELOPE_INVALID',
  );
  const tampered = Buffer.from(sealed.ciphertext);
  tampered[0] = tampered[0] ^ 0xff;
  await expectCode(
    'single: tampered ciphertext is refused',
    openWorkerArtifact({
      sidecar: parsed,
      ciphertext: tampered,
      context: artifactEncryptionContext(identity),
      seam,
    }),
    'ENVELOPE_INVALID',
  );

  /* ------------------------------------------------------------------ */
  /* 2. Chunked envelope (>5 MiB)                                        */
  /* ------------------------------------------------------------------ */
  const big = Buffer.alloc(6 * 1024 * 1024, 11);
  big.write(`${sentinel}|`, 0, 'utf8');
  const bigIdentity = { tenantId: 'tenant-a', artifactId: randomUUID(), objectVersion: randomUUID() };
  const bigSealed = await sealWorkerArtifact({ bytes: big, identity: bigIdentity, seam });
  check('chunked: sidecar declares a chunk manifest', 'chunks' in JSON.parse(bigSealed.sidecar.toString('utf8')));
  check('chunked: ciphertext carries no plaintext sentinel', !bigSealed.ciphertext.includes(Buffer.from(sentinel)));
  const bigParsed = parseWorkerArtifactSidecar(JSON.parse(bigSealed.sidecar.toString('utf8')));
  const bigOpened = await openWorkerArtifact({
    sidecar: bigParsed,
    ciphertext: bigSealed.ciphertext,
    context: artifactEncryptionContext(bigIdentity),
    seam,
  });
  check('chunked: open roundtrip equals plaintext', bigOpened.equals(big));
  const bigTamper = Buffer.from(bigSealed.ciphertext);
  bigTamper[bigTamper.length - 1] = bigTamper[bigTamper.length - 1] ^ 0xff;
  await expectCode(
    'chunked: tampered ciphertext is refused',
    openWorkerArtifact({
      sidecar: bigParsed,
      ciphertext: bigTamper,
      context: artifactEncryptionContext(bigIdentity),
      seam,
    }),
    'ENVELOPE_INVALID',
  );

  /* ------------------------------------------------------------------ */
  /* 3. PostgreSQL facade: server write/read + pinned verification       */
  /* ------------------------------------------------------------------ */
  const pgBlobs = new Map();
  const postgres = createPostgresArtifactStorageFacade({
    async read(key) { return pgBlobs.has(key) ? Buffer.from(pgBlobs.get(key)) : null; },
    async delete(key) { pgBlobs.delete(key); },
    async write(key, tenantId, bytes) { pgBlobs.set(key, Buffer.from(bytes)); },
  });
  const manifestKey = manifestKeyFor('art-pg');
  const cipherWrite = await postgres.putServerObject({
    objectKey: 'art-pg', tenantId: 'tenant-a', body: sealed.ciphertext,
    contentType: 'application/octet-stream', metadata: sealedObjectMetadata({ artifactId: identity.artifactId, tenantId: 'tenant-a', manifestKey }),
  });
  const manifestWrite = await postgres.putServerObject({
    objectKey: manifestKey, tenantId: 'tenant-a', body: sealed.sidecar,
    contentType: 'application/json', metadata: manifestObjectMetadata({ artifactId: identity.artifactId, tenantId: 'tenant-a' }),
  });
  check('pg: ciphertext write returns content-hash version', cipherWrite.versionId === sealed.ciphertextSha256);
  const pinned = await postgres.verifyAndPin({
    artifactId: identity.artifactId, tenantId: 'tenant-a', objectKey: 'art-pg',
    expectedSizeBytes: sealed.ciphertextSizeBytes, expectedSha256: sealed.ciphertextSha256,
  });
  const pinnedBytes = await collect(await postgres.openRead({ objectKey: pinned.objectKey, versionId: pinned.versionId }));
  check('pg: pinned read equals stored ciphertext', pinnedBytes.equals(sealed.ciphertext));
  check('pg: manifest row content hash recorded', manifestWrite.versionId === sha256(sealed.sidecar));
  const pgSidecar = parseWorkerArtifactSidecar(
    JSON.parse((await postgres.readServerObject(manifestKey)).toString('utf8')),
  );
  const pgVerified = await verifyWorkerArtifact({
    sidecar: pgSidecar,
    ciphertext: pinnedBytes,
    context: artifactEncryptionContext(identity),
    seam,
  });
  check('pg: finalize-style verification matches plaintext', pgVerified.plaintextSha256 === sealed.plaintextSha256);

  /* ------------------------------------------------------------------ */
  /* 4. S3 facade carrier with a fake S3 client                          */
  /* ------------------------------------------------------------------ */
  const objects = new Map();
  const versions = new Map();
  let versionCounter = 0;
  const fakeClient = {
    async send(command) {
      const name = command && command.constructor ? command.constructor.name : '';
      const input = command.input;
      if (name === 'PutObjectCommand') {
        const versionId = `v${++versionCounter}`;
        objects.set(input.Key, Buffer.from(input.Body));
        versions.set(`${input.Key}#${versionId}`, {
          body: Buffer.from(input.Body),
          metadata: input.Metadata ?? {},
        });
        return { VersionId: versionId };
      }
      if (name === 'GetObjectCommand') {
        const key = input.Key;
        const entry = input.VersionId ? versions.get(`${key}#${input.VersionId}`) : undefined;
        const body = entry ? entry.body : objects.get(key);
        if (!body) {
          const error = new Error('NoSuchKey');
          error.name = 'NoSuchKey';
          throw error;
        }
        return { Body: Readable.from([body]) };
      }
      throw new Error(`unsupported fake S3 command ${name}`);
    },
  };
  const s3 = createS3ArtifactStorageFacade({ bucket: 'offline-bucket', client: fakeClient });
  const s3ManifestKey = manifestKeyFor('art-s3');
  const s3Cipher = await s3.putServerObject({
    objectKey: 'art-s3', tenantId: 'tenant-a', body: sealed.ciphertext,
    contentType: 'application/octet-stream', metadata: sealedObjectMetadata({ artifactId: identity.artifactId, tenantId: 'tenant-a', manifestKey: s3ManifestKey }),
  });
  const s3Manifest = await s3.putServerObject({
    objectKey: s3ManifestKey, tenantId: 'tenant-a', body: sealed.sidecar,
    contentType: 'application/json', metadata: manifestObjectMetadata({ artifactId: identity.artifactId, tenantId: 'tenant-a' }),
  });
  check('s3: ciphertext write returns an immutable version', typeof s3Cipher.versionId === 'string' && s3Cipher.versionId.startsWith('v'));
  check('s3: manifest write returns an immutable version', typeof s3Manifest.versionId === 'string');
  const s3Meta = versions.get(`art-s3#${s3Cipher.versionId}`).metadata;
  check('s3: sealed metadata marker present', s3Meta['du-encrypted'] === 'aes-256-gcm-v1');
  check('s3: sealed metadata identity present', s3Meta.artifactid === identity.artifactId && s3Meta.tenantid === 'tenant-a');
  check('s3: manifest pointer present', s3Meta['du-manifest-key'] === s3ManifestKey);
  const s3SidecarBytes = await s3.readServerObject(s3ManifestKey);
  check('s3: sidecar read is byte-identical', s3SidecarBytes.equals(sealed.sidecar));

  /* ------------------------------------------------------------------ */
  /* 4b. Canonical tenant-bound reader opens the worker envelope          */
  /* ------------------------------------------------------------------ */
  const { decryptStoredArtifact } = require(`${dist}/encryption/artifact-read-decrypt.js`);
  const reader = {
    async head(key) {
      const latest = [...versions.keys()].filter((entry) => entry.startsWith(`${key}#`)).pop();
      return latest ? versions.get(latest).metadata : null;
    },
    async read(key) {
      const body = objects.get(key);
      if (!body) throw new Error('missing object');
      return body;
    },
    async readManifest(key, versionId) {
      const entry = versionId ? versions.get(`${key}#${versionId}`) : undefined;
      const bytes = entry ? entry.body : objects.get(key);
      if (!bytes) throw new Error('missing manifest');
      return JSON.parse(bytes.toString('utf8'));
    },
  };
  const ref = {
    artifactId: identity.artifactId,
    tenantId: 'tenant-a',
    storageKey: 'art-s3',
    uploadToken: identity.objectVersion,
    manifestVersionId: null,
  };
  const outcome = await decryptStoredArtifact({ reader, facade, encryptionRequired: true }, ref);
  check('reader: canonical decryptStoredArtifact opens the worker envelope',
    outcome.decrypted === true && outcome.bytes.equals(plaintext));
  await expectCode(
    'reader: wrong tenant is denied by the canonical reader',
    decryptStoredArtifact({ reader, facade, encryptionRequired: true }, { ...ref, tenantId: 'tenant-b' }),
    'PERMISSION_DENIED',
  );

  /* ------------------------------------------------------------------ */
  /* 5. Artifact service flow with an in-memory fake Db                  */
  /* ------------------------------------------------------------------ */
  const TASK_ID = randomUUID();
  const OPERATION_ID = randomUUID();
  const tenantId = 'tenant-live';
  const dbRows = {
    lease: { lease_epoch: 5, operation_id: OPERATION_ID, tenant_id: tenantId, lease_active: true },
    task: { lease_epoch: 5, state: 'RUNNING', operation_id: OPERATION_ID, lease_active: true },
    artifact: null,
    blobs: new Map(),
  };
  function artifactRow() {
    return dbRows.artifact;
  }
  function route(sql, params) {
    if (sql.includes('FROM tasks t JOIN operations o')) {
      return { rowCount: 1, rows: [dbRows.lease] };
    }
    if (sql.includes('FROM tasks WHERE id=$1 FOR UPDATE')) {
      return { rowCount: 1, rows: [dbRows.task] };
    }
    if (sql.includes('FROM artifacts WHERE id=$1 FOR UPDATE')) {
      if (!dbRows.artifact) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [artifactRow()] };
    }
    if (sql.includes('FROM artifacts a')) {
      const artifact = dbRows.artifact;
      return artifact
        ? {
            rowCount: 1,
            rows: [{
              id: artifact.id,
              state: artifact.state,
              storageBackend: artifact.storageBackend,
              uploadToken: artifact.uploadToken,
            }],
          }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('INSERT INTO artifacts')) {
      dbRows.artifact = {
        id: params[0],
        tenantId: params[1],
        operationId: params[2],
        taskId: params[3],
        purpose: params[4],
        fileName: params[5],
        mimeType: params[6],
        sizeBytes: params[7],
        state: 'STAGING',
        token: params[8],
        tokenExpiresAt: params[9],
        storageKey: params[10],
        storageBackend: params[11],
        uploadToken: params[12] ?? null,
        manifestVersionId: null,
        storageVersionId: null,
        sha256: null,
        finalizedLeaseEpoch: null,
        partCount: null,
      };
      return { rowCount: 1, rows: [{ id: dbRows.artifact.id }] };
    }
    if (sql.includes('SELECT bytes FROM artifact_blobs')) {
      const key = params[0];
      return dbRows.blobs.has(key)
        ? { rowCount: 1, rows: [{ bytes: dbRows.blobs.get(key) }] }
        : { rowCount: 0, rows: [] };
    }
    if (sql.includes('INSERT INTO artifact_blobs')) {
      dbRows.blobs.set(params[0], Buffer.from(params[2]));
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('UPDATE artifacts SET storage_version_id=$2, manifest_version_id=$3')) {
      if (dbRows.artifact) {
        dbRows.artifact.storageVersionId = params[1];
        dbRows.artifact.manifestVersionId = params[2];
      }
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes('UPDATE artifacts SET manifest_version_id')) {
      if (dbRows.artifact) dbRows.artifact.manifestVersionId = params[1];
      return { rowCount: 1, rows: [] };
    }
    if (sql.includes("UPDATE artifacts SET state='READY'")) {
      const artifact = dbRows.artifact;
      artifact.state = 'READY';
      artifact.sizeBytes = params[1];
      artifact.sha256 = params[2];
      artifact.finalizedLeaseEpoch = params[4];
      artifact.storageVersionId = params[5];
      if (params.length > 6 && params[6] !== null && params[6] !== undefined) artifact.manifestVersionId = params[6];
      return { rowCount: 1, rows: [{ id: artifact.id, state: 'READY' }] };
    }
    if (sql.includes('SELECT id, tenant_id AS "tenantId", state, storage_backend AS "storageBackend"')) {
      if (!dbRows.artifact) return { rowCount: 0, rows: [] };
      return { rowCount: 1, rows: [{ ...dbRows.artifact }] };
    }
    throw new Error(`fake Db has no route for SQL: ${sql.slice(0, 120)}`);
  }
  const fakeDb = {
    async query(sql, params = []) { return route(sql, params); },
    async tx(fn) { return fn({ query: (sql, params = []) => Promise.resolve(route(sql, params)) }); },
  };

  const service = createArtifactService(fakeDb, {
    storageBackend: 'postgres',
    encryption: { facade, keyRef: 'worker-artifact-key', required: true },
  });
  const grant = await service.requestUpload(TASK_ID, 5, {
    leaseEpoch: 5, purpose: 'output', fileName: 'out.bin', mimeType: 'application/octet-stream', sizeBytes: plaintext.length,
  });
  check('service: upload grant is the server-mediated proxy URL',
    grant.uploadUrl.includes('/api/runtime/v1/artifacts/blob/') && grant.uploadUrl.includes('grant='));
  const storageKey = decodeURIComponent(grant.uploadUrl.split('/blob/')[1].split('?')[0]);
  await service.putBlob(storageKey, tenantId, plaintext);
  check('service: stored blob is ciphertext, not plaintext',
    !dbRows.blobs.get(storageKey).equals(plaintext)
    && !dbRows.blobs.get(storageKey).includes(Buffer.from(sentinel)));
  check('service: sidecar blob is persisted next to the ciphertext',
    dbRows.blobs.has(manifestKeyFor(storageKey)));
  check('service: manifest version recorded on the STAGING row',
    typeof dbRows.artifact.manifestVersionId === 'string' && dbRows.artifact.manifestVersionId.length === 64);

  const finalized = await service.finalize(grant.artifactId, {
    taskId: TASK_ID, leaseEpoch: 5, sizeBytes: plaintext.length, sha256: sha256(plaintext),
  });
  check('service: finalize commits READY', finalized.state === 'READY');
  check('service: row keeps plaintext business metadata',
    dbRows.artifact.sha256 === sha256(plaintext) && Number(dbRows.artifact.sizeBytes) === plaintext.length);
  check('service: row pins the ciphertext version',
    dbRows.artifact.storageVersionId === sha256(dbRows.blobs.get(storageKey)));

  const readBack = await collect(await service.getBlob(storageKey));
  check('service: getBlob decrypts to the original plaintext', readBack.equals(plaintext));

  // Tamper at rest -> read refuses; no ciphertext is served as success.
  const stored = dbRows.blobs.get(storageKey);
  stored[0] = stored[0] ^ 0xff;
  await expectCode('service: tampered stored ciphertext refuses the read', service.getBlob(storageKey), 'HASH_MISMATCH');
  stored[0] = stored[0] ^ 0xff; // restore

  // Strict deployment: an unsealed STAGING row cannot finalize.
  dbRows.artifact = null;
  const plainService = createArtifactService(fakeDb, {
    storageBackend: 'postgres',
    encryption: { facade, keyRef: 'worker-artifact-key', required: true },
  });
  await plainService.requestUpload(TASK_ID, 5, {
    leaseEpoch: 5, purpose: 'output', fileName: 'out2.bin', mimeType: 'application/octet-stream', sizeBytes: 8,
  });
  dbRows.artifact.uploadToken = null; // simulate a row admitted before sealing was configured
  await expectCode(
    'service: unsealed row is refused on a strict deployment',
    plainService.finalize(dbRows.artifact.id, { taskId: TASK_ID, leaseEpoch: 5, sizeBytes: 8, sha256: sha256(Buffer.alloc(8, 1)) }),
    'TEMPORARY_UNAVAILABLE',
  );

  /* ------------------------------------------------------------------ */
  /* 6. Multipart worker branch refuses before any session/DB write      */
  /* ------------------------------------------------------------------ */
  const { createMultipartService } = require(`${dist}/artifacts/multipart-service.js`);
  let guardDbCalls = 0;
  const guardDb = {
    async query() { guardDbCalls += 1; return { rowCount: 0, rows: [] }; },
    async tx(fn) { return fn({ query: async () => { guardDbCalls += 1; return { rowCount: 0, rows: [] }; } }); },
  };
  const guardedMultipart = createMultipartService(guardDb, {
    storage: { createMultipartUpload: async () => { throw new Error('storage must not be reached'); } },
    encryptionRequired: true,
  });
  await expectCode(
    'multipart: worker init refuses while encryption is required',
    guardedMultipart.init(TASK_ID, {
      leaseEpoch: 5,
      purpose: 'output',
      mimeType: 'application/octet-stream',
      fileName: 'big.bin',
      sizeBytes: 64 * 1024 * 1024 + 1,
      uploadToken: randomUUID(),
    }),
    'ENCRYPTED_MULTIPART_UNAVAILABLE',
  );
  check('multipart: refusal touched no database and no presign', guardDbCalls === 0);

  console.log(`\nSEC-ENC-04 smoke completed: ${checks} checks passed`);
}

main().catch((error) => {
  console.error('SMOKE FAILED:', error && error.message ? error.message : error);
  process.exit(1);
});
