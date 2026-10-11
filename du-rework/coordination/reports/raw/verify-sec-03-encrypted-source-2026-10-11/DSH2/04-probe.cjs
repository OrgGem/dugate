/* DSH2 independent probe for the SEC-OR-03 encrypted-source wiring.
   READ-ONLY: loads working-tree TypeScript sources through a transpile hook and
   uses the REAL CryptoStorageFacade with a deterministic key provider (my own
   code, my own sentinel). No product file is written; no external network. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SVC = 'D:/Git/dugate/du-rework/orchestrator/services/orchestrator';
const ts = require(path.join(SVC, 'node_modules/typescript/lib/typescript.js'));

require.extensions['.ts'] = function loadTs(module, filename) {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(out, filename);
};

const results = [];
async function check(name, fn) {
  try { const d = await fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}
const read = (p) => fs.readFileSync(path.join(SVC, p), 'utf8');

const SENTINEL = 'DSH2-SEC03-PLAINTEXT-SENTINEL-7788';
const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATION = '22222222-2222-4222-8222-222222222222';
const SOURCE_KEY = 'tenant/source/object';
const BUCKET = 'probe-bucket';

function makeKeyProvider() {
  return {
    wrapDek: async (input) => ({ keyRef: input.keyRef, keyVersion: input.keyVersion ?? 1, ciphertext: input.dek.toString('base64') }),
    unwrapDek: async (wrapped) => Buffer.from(wrapped.ciphertext, 'base64'),
  };
}

function makeVersionedS3() {
  const objects = new Map();
  const keysSeen = [];
  let counter = 0;
  const readAll = async (body) => {
    if (Buffer.isBuffer(body)) return Buffer.from(body);
    const chunks = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  };
  return {
    keysSeen,
    bodies: objects,
    async send(command) {
      const name = command.constructor.name;
      const input = command.input;
      if (name === 'PutObjectCommand') {
        const body = await readAll(input.Body);
        counter += 1;
        const versionId = 'v' + counter;
        objects.set(String(input.Key), { body, versionId, metadata: { ...(input.Metadata ?? {}) } });
        keysSeen.push(String(input.Key));
        return { VersionId: versionId };
      }
      if (name === 'HeadObjectCommand') {
        const stored = objects.get(String(input.Key));
        if (!stored) throw new Error('NotFound');
        return { VersionId: stored.versionId, ContentLength: stored.body.length, Metadata: { ...stored.metadata } };
      }
      if (name === 'GetObjectCommand') {
        const stored = objects.get(String(input.Key));
        if (!stored) throw new Error('NotFound');
        return { Body: Buffer.from(stored.body) };
      }
      if (name === 'DeleteObjectCommand') return {};
      throw new Error('unexpected command ' + name);
    },
  };
}

(async () => {
  const bootOptions = require(path.join(SVC, 'src/modules/encryption/boot-options.ts'));
  const storage = require(path.join(SVC, 'src/modules/operations/ingestion-storage-s3.ts'));
  const facadeModule = require(path.join(SVC, 'src/modules/encryption/crypto-storage-facade.ts'));
  const emptyDb = { query: async () => ({ rows: [] }) };

  // ---- P1 data-mode semantics ------------------------------------------
  await check('P1 data mode defaults to real and real always requires encryption', async () => {
    assert.equal(bootOptions.resolveDataMode({}).mode, 'real', 'unset must be real');
    assert.equal(bootOptions.resolveDataMode({ DU_DATA_MODE: 'real' }).mode, 'real');
    assert.equal(bootOptions.encryptionIsRequired({}), true, 'real mode must require encryption');
    assert.throws(() => bootOptions.resolveDataMode({ DU_DATA_MODE: 'synthetic' }), /DU_SYNTHETIC_DATA_ACK|acknowledgement/);
    const ack = JSON.stringify({ mode: 'synthetic-data-exempt', reason: 'probe', approvedBy: 'dsh2', acknowledgedAt: '2026-10-11T00:00:00Z', isolatedFromRealData: true });
    assert.equal(bootOptions.resolveDataMode({ DU_DATA_MODE: 'synthetic', DU_SYNTHETIC_DATA_ACK: ack }).mode, 'synthetic');
    return 'unset=real, real requires encryption, synthetic needs a complete ack';
  });

  // ---- P2 boot policy --------------------------------------------------
  await check('P2 the boot policy refuses real + encryption surface + no key outside dev/test', async () => {
    const policy = { dataMode: 'real', metadataEncryption: true, publicUploadEncryption: true };
    assert.throws(() => bootOptions.assertProfileCipherBootPolicy({ NODE_ENV: 'production' }, policy), /ENCRYPTION_KEY/);
    assert.doesNotThrow(() => bootOptions.assertProfileCipherBootPolicy({ NODE_ENV: 'production', ENCRYPTION_KEY: 'k' }, policy));
    assert.doesNotThrow(() => bootOptions.assertProfileCipherBootPolicy({ NODE_ENV: 'test' }, policy));
    assert.doesNotThrow(() => bootOptions.assertProfileCipherBootPolicy({ NODE_ENV: 'production' }, { ...policy, dataMode: 'synthetic' }));
    assert.doesNotThrow(() => bootOptions.assertProfileCipherBootPolicy({ NODE_ENV: 'production' },
      { dataMode: 'real', metadataEncryption: false, publicUploadEncryption: false }));
    return '5 policy cases behave as documented';
  });

  // ---- P3 static wiring in create-app ---------------------------------
  await check('P3 create-app wires the encrypted writer and the flag from dataMode', async () => {
    const source = read('src/app/bootstrap/create-app.ts');
    assert.match(source, /const requireEncryptedSourceWrites = config\.encryptionPolicy\?\.dataMode === 'real';/);
    assert.match(source, /createS3EncryptedPinnedSourceStorage\(/, 'encrypted factory not composed');
    assert.match(source, /: createS3PinnedSourceStorage\(/, 'no plaintext fallback branch');
    assert.match(source, /requireEncryptedSourceWrites,/, 'flag not passed to the consumer');
    assert.match(source, /createS3EncryptedPinnedSourceStorage,/, 'encrypted factory not imported');
    assert.match(source, /createS3PinnedSourceStorage,/, 'plaintext factory not imported');
    const encryptedAt = source.indexOf('createS3EncryptedPinnedSourceStorage({');
    const plaintextAt = source.indexOf(': createS3PinnedSourceStorage({');
    assert.ok(encryptedAt > 0 && plaintextAt > encryptedAt, 'branch order changed');
    return 'real -> encrypted branch + flag true; fallback keeps the plaintext factory; both imported';
  });

  // ---- P4 fail-closed wrapper -----------------------------------------
  await check('P4 the encrypted wrapper refuses a plaintext-only adapter', async () => {
    const plaintextWriter = storage.createS3PinnedSourceStorage({ bucket: BUCKET, send: makeVersionedS3().send, db: emptyDb });
    assert.equal(storage.hasEncryptedSourceWriteCapability(plaintextWriter), false);
    assert.throws(
      () => storage.createEncryptedSourceStorageWrapper(plaintextWriter, { context: { tenantId: TENANT, artifactId: 'a', objectVersion: 'v' } }),
      /encrypted source writes are required but the storage adapter does not implement putEncrypted/,
    );
    return 'capability=false and the wrapper throws the documented refusal';
  });

  // ---- P5 the encrypted writer really seals ---------------------------
  await check('P5 the encrypted writer stores ciphertext plus a sidecar, the plaintext one stores the sentinel', async () => {
    const facade = new facadeModule.CryptoStorageFacade(makeKeyProvider());
    const s3 = makeVersionedS3();
    const writer = storage.createS3EncryptedPinnedSourceStorage({
      bucket: BUCKET, send: s3.send, db: emptyDb,
      encryption: { facade, keyRef: 'du-source-kv', keyVersion: 1 },
    });
    assert.equal(storage.hasEncryptedSourceWriteCapability(writer), true, 'encrypted capability missing');
    const context = {
      tenantId: TENANT,
      artifactId: storage.encryptedSourceArtifactId({ tenantId: TENANT, operationId: OPERATION, storageKey: SOURCE_KEY }),
      objectVersion: storage.encryptedSourceObjectVersion({ tenantId: TENANT, operationId: OPERATION, storageKey: SOURCE_KEY }),
    };
    const plaintext = Buffer.from('invoice bytes ' + SENTINEL + ' tail', 'utf8');
    const { write, description } = await writer.putEncrypted({
      storageKey: SOURCE_KEY, contentType: 'application/pdf',
      body: (async function* () { yield plaintext.subarray(0, 9); yield plaintext.subarray(9); })(),
      maxBytes: 1024 * 1024,
    }, context);
    assert.ok(s3.keysSeen.length >= 1, 'nothing was stored');
    const main = s3.bodies.get(SOURCE_KEY);
    assert.ok(main, 'main object missing');
    assert.equal(main.body.includes(Buffer.from(SENTINEL, 'utf8')), false, 'stored body still contains the plaintext sentinel');
    assert.ok(s3.keysSeen.length >= 2, 'no sidecar object was written: ' + JSON.stringify(s3.keysSeen));
    assert.ok(s3.keysSeen.some((k) => k !== SOURCE_KEY), 'sidecar key missing');
    assert.ok(description && description.manifestVersionId !== undefined, 'no manifest version in the description');
    assert.equal(write.sizeBytes, plaintext.byteLength, 'business size must stay the plaintext size');

    // Contrast: the plaintext writer stores the sentinel verbatim.
    const s3b = makeVersionedS3();
    const plain = storage.createS3PinnedSourceStorage({ bucket: BUCKET, send: s3b.send, db: emptyDb });
    await plain.putVerified({ storageKey: SOURCE_KEY, contentType: 'application/pdf', body: (async function* () { yield plaintext; })(), maxBytes: 1024 * 1024 });
    assert.equal(s3b.bodies.get(SOURCE_KEY).body.includes(Buffer.from(SENTINEL, 'utf8')), true, 'plaintext writer did not store the sentinel');
    return 'encrypted: sentinel absent, ' + s3.keysSeen.length + ' objects (main + sidecar), manifestVersionId=' + String(description.manifestVersionId).slice(0, 12) + '…; plaintext: sentinel present';
  });

  const failed = results.filter((r) => !r.pass);
  for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
  console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
  process.exitCode = failed.length === 0 ? 0 : 1;
})();
