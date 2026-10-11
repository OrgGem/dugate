'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

// MDB-POLICY-04: readFileCacheBytes, artifactTokenFor and artifactPurposeFor are
// the three FileCache callbacks the LDBA-03 runner requires (mapFileCache,
// ldba-03-backfill.cjs:690-733). This suite pins them against the contracts the
// runner actually enforces:
//   - bytes must be a Buffer or Uint8Array, and the runner then re-checks both the
//     byte count and the MD5 of what the reader returned (:704-715) - so the reader
//     can never fabricate bytes;
//   - the token must be a string of at least 32 characters (:718-720), and it must
//     be deterministic or every replay turns into an immutable conflict (MDB-02);
//   - the purpose must be one of the four values in :721-723.
const provider = require('../scripts/ldba-context-provider.cjs');

const OBJECT_DIR_ENV = 'LDBA03_FILECACHE_OBJECT_DIR';
const KEY_ENV = 'CONNECTOR_ENCRYPTION_KEY';
const PURPOSE_VOCABULARY = ['input', 'output', 'intermediate', 'session'];

let objectRoot;
let previousObjectDir;
let previousKey;

before(() => {
  previousObjectDir = process.env[OBJECT_DIR_ENV];
  previousKey = process.env[KEY_ENV];
  objectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'mdb-policy-04-'));
});

after(() => {
  if (previousObjectDir === undefined) delete process.env[OBJECT_DIR_ENV];
  else process.env[OBJECT_DIR_ENV] = previousObjectDir;
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
  if (objectRoot !== undefined) fs.rmSync(objectRoot, { recursive: true, force: true });
});

function writeObject(key, content) {
  const target = path.join(objectRoot, key);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, content);
}

function expectRefusal(action, code, callback) {
  assert.throws(action, (error) => {
    assert.equal(error.code, code);
    assert.equal(error.callback, callback);
    assert.ok(error.message.includes(code), 'the runner keeps only error.message, so the code must be visible there');
    return true;
  });
}

// --- artifactTokenFor ------------------------------------------------------

test('the artifact token is the deterministic sha256 of key and target id', () => {
  const row = { id: '60000000-0000-4000-8000-0000000000aa', s3Key: '70000000-0000-4000-8000-0000000000bb/report.pdf' };
  const id = '60000000-0000-4000-8000-0000000000cc';
  const token = provider.artifactTokenFor(row, id);
  assert.equal(token, createHash('sha256').update(row.s3Key + ':' + id).digest('hex'));
  assert.match(token, /^[0-9a-f]{64}$/);
  assert.ok(token.length >= 32, 'the runner refuses a token shorter than 32 characters');
});

test('the artifact token is stable across replays and separates its inputs', () => {
  const row = { s3Key: '70000000-0000-4000-8000-0000000000bb/report.pdf' };
  const id = '60000000-0000-4000-8000-0000000000cc';
  assert.equal(provider.artifactTokenFor(row, id), provider.artifactTokenFor(row, id));
  assert.notEqual(provider.artifactTokenFor(row, id), provider.artifactTokenFor(row, '60000000-0000-4000-8000-0000000000dd'));
  assert.notEqual(provider.artifactTokenFor(row, id), provider.artifactTokenFor({ s3Key: 'other/object.bin' }, id));
});

test('the artifact token refuses a row or an id it cannot bind', () => {
  const id = '60000000-0000-4000-8000-0000000000cc';
  for (const row of [null, undefined, {}, { s3Key: null }, { s3Key: '' }, 'row']) {
    expectRefusal(() => provider.artifactTokenFor(row, id), 'INVALID_ARTIFACT_TOKEN', 'artifactTokenFor');
  }
  expectRefusal(() => provider.artifactTokenFor({ s3Key: 'object.bin' }, ''), 'INVALID_ARTIFACT_TOKEN', 'artifactTokenFor');
  expectRefusal(() => provider.artifactTokenFor({ s3Key: 'object.bin' }, 42), 'INVALID_ARTIFACT_TOKEN', 'artifactTokenFor');
});

// --- artifactPurposeFor ----------------------------------------------------

test('the purpose stays inside the target vocabulary', () => {
  for (const key of ['70000000-0000-4000-8000-0000000000bb/report.pdf', 'uploads/form.pdf', 'contract-upload.pdf']) {
    const purpose = provider.artifactPurposeFor({ s3Key: key });
    assert.ok(PURPOSE_VOCABULARY.includes(purpose), purpose + ' is outside the artifact purpose vocabulary');
  }
});

test('the purpose follows the documented source-key rule', () => {
  assert.equal(provider.artifactPurposeFor({ s3Key: '70000000-0000-4000-8000-0000000000bb/report.pdf' }), 'output');
  assert.equal(provider.artifactPurposeFor({ s3Key: 'uploads/form.pdf' }), 'input');
  assert.equal(provider.artifactPurposeFor({ s3Key: 'UPLOAD/form.pdf' }), 'input');
  assert.equal(provider.artifactPurposeFor({ s3Key: 'contract-upload.pdf' }), 'input');
});

test('the purpose refuses a row it cannot classify', () => {
  for (const row of [null, undefined, {}, { s3Key: null }, { s3Key: 42 }]) {
    expectRefusal(() => provider.artifactPurposeFor(row), 'INVALID_ARTIFACT_PURPOSE', 'artifactPurposeFor');
  }
});

// --- readFileCacheBytes ----------------------------------------------------

test('the object reader fails closed when no object root is configured', () => {
  delete process.env[OBJECT_DIR_ENV];
  expectRefusal(() => provider.readFileCacheBytes('object.bin'), 'ARTIFACT_READER_REQUIRED', 'readFileCacheBytes');
});

test('the object reader serves real bytes from the configured root', () => {
  process.env[OBJECT_DIR_ENV] = objectRoot;
  writeObject(path.join('nested', 'object.bin'), Buffer.from('legacy object bytes'));
  const bytes = provider.readFileCacheBytes('nested/object.bin');
  assert.ok(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array, 'the runner only accepts a Buffer or Uint8Array');
  assert.equal(Buffer.from(bytes).toString('utf8'), 'legacy object bytes');
  writeObject('plain.bin', Buffer.from([0, 1, 2, 253, 254, 255]));
  assert.deepEqual(Buffer.from(provider.readFileCacheBytes('plain.bin')), Buffer.from([0, 1, 2, 253, 254, 255]));
});

test('the object reader refuses keys that leave the configured root', () => {
  process.env[OBJECT_DIR_ENV] = objectRoot;
  writeObject(path.join('safe', 'object.bin'), Buffer.from('safe bytes'));
  assert.equal(provider.readFileCacheBytes('safe/object.bin').length, 10);
  for (const key of [
    '../outside.bin',
    'safe/../../outside.bin',
    '/etc/passwd',
    'C:/Windows/win.ini',
    'safe\\..\\outside.bin',
    '',
    42,
    null,
  ]) {
    expectRefusal(() => provider.readFileCacheBytes(key), 'INVALID_ARTIFACT_BYTES', 'readFileCacheBytes');
  }
});

test('the object reader reports a missing object or a directory as unreadable', () => {
  process.env[OBJECT_DIR_ENV] = objectRoot;
  expectRefusal(() => provider.readFileCacheBytes('absent/object.bin'), 'INVALID_ARTIFACT_BYTES', 'readFileCacheBytes');
  fs.mkdirSync(path.join(objectRoot, 'adirectory'), { recursive: true });
  expectRefusal(() => provider.readFileCacheBytes('adirectory'), 'INVALID_ARTIFACT_BYTES', 'readFileCacheBytes');
});

test('the object reader answers with a fresh buffer every call', () => {
  process.env[OBJECT_DIR_ENV] = objectRoot;
  writeObject('twice.bin', Buffer.from('twice'));
  const first = provider.readFileCacheBytes('twice.bin');
  const second = provider.readFileCacheBytes('twice.bin');
  assert.notEqual(first, second);
  assert.deepEqual(Buffer.from(first), Buffer.from(second));
});

// --- regression guards -----------------------------------------------------

test('prepareConnector still maps a legacy connector row', () => {
  process.env[KEY_ENV] = Buffer.alloc(32, 11).toString('base64');
  const prepared = provider.prepareConnector({ id: 'conn-04', authSecret: 'legacy-secret' }, {
    connectorId: 'conn-04',
    revisionNumber: 1,
    state: 'ACTIVE',
    config: {
      endpointUrl: 'https://api.legacy.example/v1/run',
      httpMethod: 'POST',
      authType: 'API_KEY_HEADER',
      authKeyHeader: 'X-Legacy-Key',
      promptFieldName: 'prompt',
      responseContentPath: 'data.output',
      timeoutSec: 30,
    },
    createdAt: '2026-01-02T03:04:05.000Z',
  });
  assert.equal(prepared.skipped, undefined);
  assert.equal(prepared.revision.connector_id, 'conn-04');
});

test('the profile policy from MDB-POLICY-02 still answers', () => {
  assert.equal(provider.resolveProfileName({ endpointSlug: 'analyze' }), 'Imported analyze');
  assert.deepEqual(provider.normalizeConnectionsOverride(['first']), [{ slug: 'first' }]);
  assert.deepEqual(provider.normalizeConnectionsOverride(null), []);
});

test('the workflow policy from MDB-POLICY-03 still refuses on its own terms', () => {
  // Not CONTEXT_POLICY_REQUIRED: the landed policy must own its own refusals.
  assert.throws(() => provider.prepareWorkflowSchema({}, {}), (error) => {
    assert.equal(error.code, 'INVALID_SOURCE');
    assert.equal(error.name, 'WorkflowSchemaPolicyError');
    return true;
  });
});

test('prepareAdminLocalUser still demands user-presented plaintext', () => {
  assert.throws(() => provider.prepareAdminLocalUser(), (error) => {
    assert.equal(error.code, 'PASSWORD_RESET_REQUIRED');
    return true;
  });
});

test('the boot contract still holds: eight frozen callbacks', () => {
  assert.ok(Object.isFrozen(provider));
  for (const callback of ['prepareConnector', 'resolveProfileName', 'normalizeConnectionsOverride',
    'prepareWorkflowSchema', 'readFileCacheBytes', 'artifactTokenFor', 'artifactPurposeFor', 'prepareAdminLocalUser']) {
    assert.equal(typeof provider[callback], 'function', callback + ' must remain callable');
  }
});
