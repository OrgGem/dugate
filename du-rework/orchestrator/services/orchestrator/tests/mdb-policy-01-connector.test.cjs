const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { createDecipheriv } = require('node:crypto');

// MDB-POLICY-01: the LDBA-03 runner owns every row assertion, so this suite
// pins the policy against that same contract rather than against itself. The
// decryption round-trip mirrors connector/src/services.ts AesCredentialCipher
// byte for byte: if the envelope drifts, these rows become unreadable in
// production and nothing else would notice.
const provider = require('../scripts/ldba-context-provider.cjs');

const KEY = Buffer.alloc(32, 7);
const AUTH_SECRET = 'legacy-plaintext-secret-value';
const SECRET_VERSION_PREFIX = 'legacy-db:secret:';

// ConnectorRevisionConfigSchema (packages/contracts/src/vault.ts) is strict;
// only these keys may ever be persisted in connector_revisions.config.
const ALLOWED_CONFIG_KEYS = [
  'baseUrl', 'path', 'headers', 'requestMapping', 'responseMapping',
  'timeoutMs', 'capability', 'credentialSlot', 'asyncPollingMode',
];
// Legacy display fields the strict schema has no home for.
const DISPLAY_ONLY_KEYS = [
  'name', 'slug', 'description', 'endpointUrl', 'httpMethod', 'authType',
  'authKeyHeader', 'promptFieldName', 'fileFieldName', 'fileUrlFieldName',
  'defaultPrompt', 'staticFormFields', 'extraHeaders', 'responseContentPath',
  'sessionIdResponsePath', 'sessionIdFieldName', 'timeoutSec',
];

const KEY_ENV = 'CONNECTOR_ENCRYPTION_KEY';
let previousKey;

before(() => {
  previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = KEY.toString('base64');
});

after(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
});

beforeEach(() => {
  process.env[KEY_ENV] = KEY.toString('base64');
});

function connectorRequest(overrides) {
  const base = {
    connectorId: 'conn-001',
    revisionNumber: 1,
    state: 'ACTIVE',
    config: {
      name: 'Legacy connector',
      slug: 'legacy',
      description: null,
      endpointUrl: 'https://api.legacy.example/v1/run?mode=full',
      httpMethod: 'POST',
      authType: 'API_KEY_HEADER',
      authKeyHeader: 'X-Legacy-Key',
      promptFieldName: 'prompt',
      fileFieldName: null,
      fileUrlFieldName: null,
      defaultPrompt: null,
      staticFormFields: null,
      extraHeaders: null,
      responseContentPath: 'data.output',
      sessionIdResponsePath: null,
      sessionIdFieldName: null,
      timeoutSec: 30,
    },
    createdAt: '2026-01-02T03:04:05.000Z',
  };
  return Object.assign(base, overrides || {});
}

function connectorRow(overrides) {
  return Object.assign({ id: 'conn-001', authSecret: AUTH_SECRET }, overrides || {});
}

function requestWithConfig(changes) {
  const request = connectorRequest();
  request.config = Object.assign({}, request.config, changes || {});
  return request;
}

/** Byte-for-byte mirror of AesCredentialCipher.decrypt (connector/src/services.ts). */
function decryptLikeConnector(bytes, key) {
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(bytes).subarray(0, 12));
  decipher.setAuthTag(Buffer.from(bytes).subarray(12, 28));
  return Buffer.concat([
    decipher.update(Buffer.from(bytes).subarray(28)),
    decipher.final(),
  ]).toString('utf8');
}

test('happy path: revision and secret satisfy every runner assertion', () => {
  const prepared = provider.prepareConnector(connectorRow(), connectorRequest());

  assert.ok(prepared && typeof prepared === 'object');
  assert.equal(prepared.skipped, undefined, 'a migrated row must never be reported as skipped');
  const { revision, secret } = prepared;

  // Identity assertions mirrored from ldba-03-backfill.cjs:497-514.
  assert.equal(revision.connector_id, 'conn-001');
  assert.equal(revision.revision, 1);
  assert.equal(revision.state, 'ACTIVE');
  assert.equal(revision.tenant_id, '', 'legacy connector rows stay unbound');
  assert.equal(typeof revision.credential_ref, 'string');
  assert.ok(revision.credential_ref.length > 0);
  assert.equal(revision.credential_source.kind, 'legacy-db');
  assert.equal(revision.credential_source.credentialRef, revision.credential_ref);
  assert.equal(revision.account_id, undefined, 'no account binding may be invented');
  assert.equal(revision.createdAt, '2026-01-02T03:04:05.000Z');
  assert.equal(revision.adapter, 'json-http');

  // Secret identity and ciphertext (backfill:516-531).
  assert.equal(typeof secret.id, 'string');
  assert.ok(secret.id.length > 0);
  assert.equal(secret.id, SECRET_VERSION_PREFIX + 'conn-001:1');
  assert.equal(secret.credential_ref, revision.credential_ref);
  assert.ok(Buffer.isBuffer(secret.encrypted_value) || secret.encrypted_value instanceof Uint8Array);
  assert.ok(secret.encrypted_value.length >= 29, 'iv 12 + tag 16 + at least one ciphertext byte');
  assert.ok(!Buffer.from(secret.encrypted_value).equals(Buffer.from(AUTH_SECRET, 'utf8')));
});

test('happy path: the secret never appears anywhere in the migrated row', () => {
  const prepared = provider.prepareConnector(connectorRow(), connectorRequest());
  assert.ok(!JSON.stringify(prepared).includes(AUTH_SECRET));
});

test('happy path: ciphertext decrypts with the connector credential cipher', () => {
  const prepared = provider.prepareConnector(connectorRow(), connectorRequest());
  assert.equal(decryptLikeConnector(prepared.secret.encrypted_value, KEY), AUTH_SECRET);
});

test('happy path: config stays inside the strict revision schema', () => {
  const prepared = provider.prepareConnector(connectorRow(), connectorRequest());
  const { config } = prepared.revision;
  for (const key of Object.keys(config)) {
    assert.ok(ALLOWED_CONFIG_KEYS.includes(key), key + ' is not a ConnectorRevisionConfigSchema key');
  }
  for (const key of DISPLAY_ONLY_KEYS) {
    assert.equal(Object.hasOwn(config, key), false, key + ' must not be persisted in revision config');
  }
  assert.equal(config.baseUrl, 'https://api.legacy.example');
  assert.equal(config.path, '/v1/run?mode=full');
  assert.equal(config.timeoutMs, 30000);
  assert.equal(config.credentialSlot, 'header:X-Legacy-Key');
  assert.deepEqual(config.requestMapping, { prompt: 'input.prompt' });
  assert.deepEqual(config.responseMapping, { content: 'data.output' });
});

test('happy path: extra headers are carried only when they are not credentials', () => {
  const prepared = provider.prepareConnector(
    connectorRow(),
    requestWithConfig({ extraHeaders: { 'x-tenant-slug': 'acme' } }),
  );
  assert.deepEqual(prepared.revision.config.headers, { 'x-tenant-slug': 'acme' });
});

test('multipart connector maps files and session ids', () => {
  const prepared = provider.prepareConnector(connectorRow(), requestWithConfig({
    fileFieldName: 'files',
    sessionIdFieldName: 'conversation',
    sessionIdResponsePath: 'data.session',
  }));
  assert.equal(prepared.revision.adapter, 'multipart-http');
  assert.deepEqual(prepared.revision.config.requestMapping, {
    prompt: 'input.prompt',
    files: 'input.artifacts',
    conversation: 'sessionRef',
  });
  assert.deepEqual(prepared.revision.config.responseMapping, {
    content: 'data.output',
    sessionRef: 'data.session',
  });
});

test('each call uses a fresh iv so the same secret never encrypts twice identically', () => {
  const first = provider.prepareConnector(connectorRow(), connectorRequest());
  const second = provider.prepareConnector(connectorRow(), connectorRequest());
  assert.ok(!Buffer.from(first.secret.encrypted_value).equals(Buffer.from(second.secret.encrypted_value)));
  assert.equal(decryptLikeConnector(second.secret.encrypted_value, KEY), AUTH_SECRET);
});

test('missing encryption key stops the row instead of emitting an unencrypted secret', () => {
  delete process.env[KEY_ENV];
  const prepared = provider.prepareConnector(connectorRow(), connectorRequest());
  assert.equal(prepared.skipped, true);
  assert.equal(prepared.code, 'ENCRYPTION_KEY_MISSING');
  assert.ok(prepared.reason.length > 0);
  assert.equal(prepared.revision, undefined);
  assert.equal(prepared.secret, undefined);
  assert.ok(!JSON.stringify(prepared).includes(AUTH_SECRET));
});

test('an encryption key of the wrong size stops the row', () => {
  process.env[KEY_ENV] = Buffer.alloc(16, 1).toString('base64');
  const prepared = provider.prepareConnector(connectorRow(), connectorRequest());
  assert.equal(prepared.skipped, true);
  assert.equal(prepared.code, 'ENCRYPTION_KEY_MISSING');
  assert.equal(prepared.secret, undefined);
});

test('a row without a stored secret is skipped rather than migrated empty', () => {
  const prepared = provider.prepareConnector(connectorRow({ authSecret: null }), connectorRequest());
  assert.equal(prepared.skipped, true);
  assert.equal(prepared.code, 'MISSING_SECRET');
});

test('a credential-bearing extra header stops the row and never reaches config', () => {
  const prepared = provider.prepareConnector(connectorRow(), requestWithConfig({
    extraHeaders: { 'X-Api-Key': AUTH_SECRET },
  }));
  assert.equal(prepared.skipped, true);
  assert.equal(prepared.code, 'SECRET_HEADER_NOT_ALLOWED');
  assert.equal(prepared.revision, undefined);
  assert.ok(!JSON.stringify(prepared).includes(AUTH_SECRET), 'skip reasons must not echo the secret');
});

test('a credential-named auth header is refused', () => {
  const prepared = provider.prepareConnector(connectorRow(), requestWithConfig({ authKeyHeader: 'Authorization' }));
  assert.equal(prepared.skipped, true);
  assert.equal(prepared.code, 'INVALID_AUTH_HEADER');
});

test('unapproved http method and auth type are refused', () => {
  const get = provider.prepareConnector(connectorRow(), requestWithConfig({ httpMethod: 'GET' }));
  assert.equal(get.code, 'UNSUPPORTED_HTTP_METHOD');
  const oauth = provider.prepareConnector(connectorRow(), requestWithConfig({ authType: 'OAUTH2' }));
  assert.equal(oauth.code, 'UNSUPPORTED_AUTH_TYPE');
});

test('endpoint with userinfo or fragment is refused', () => {
  assert.equal(
    provider.prepareConnector(connectorRow(), requestWithConfig({ endpointUrl: 'https://u:p@api.legacy.example/x' })).code,
    'INVALID_ENDPOINT',
  );
  assert.equal(
    provider.prepareConnector(connectorRow(), requestWithConfig({ endpointUrl: 'https://api.legacy.example/x#frag' })).code,
    'INVALID_ENDPOINT',
  );
});

test('timeout outside the adapter ceiling is refused', () => {
  assert.equal(
    provider.prepareConnector(connectorRow(), requestWithConfig({ timeoutSec: 601 })).code,
    'INVALID_TIMEOUT',
  );
  assert.equal(
    provider.prepareConnector(connectorRow(), requestWithConfig({ timeoutSec: 0 })).code,
    'INVALID_TIMEOUT',
  );
});

test('one field name mapped to two source paths is refused', () => {
  const prepared = provider.prepareConnector(connectorRow(), requestWithConfig({
    fileFieldName: 'prompt',
  }));
  assert.equal(prepared.skipped, true);
  assert.equal(prepared.code, 'UNSAFE_FIELD_MAPPING');
});

test('identity, state and timestamp drift out of the accepted shape are refused', () => {
  assert.equal(provider.prepareConnector(connectorRow(), connectorRequest({ revisionNumber: 2 })).code, 'INVALID_SOURCE');
  assert.equal(provider.prepareConnector(connectorRow(), connectorRequest({ state: 'PENDING' })).code, 'UNMAPPABLE_STATE');
  assert.equal(provider.prepareConnector(connectorRow(), connectorRequest({ createdAt: '' })).code, 'INVALID_SOURCE');
  assert.equal(provider.prepareConnector(connectorRow(), connectorRequest({ connectorId: '' })).code, 'INVALID_SOURCE');
});

test('a malformed request never produces a revision or a secret', () => {
  for (const bad of [null, undefined, {}, { config: null }, 'row']) {
    const prepared = provider.prepareConnector(bad, connectorRequest());
    assert.equal(prepared.skipped, true, JSON.stringify(bad) + ' must be refused');
    assert.equal(prepared.revision, undefined);
    assert.equal(prepared.secret, undefined);
  }
});

test('the boot contract still holds: every LDBA03 context callback is a function', () => {
  // MDB-01 registers this module at boot and rejects a missing callback, so a
  // policy change that dropped one would break every image boot.
  for (const callback of [
    'prepareConnector', 'resolveProfileName', 'normalizeConnectionsOverride',
    'prepareWorkflowSchema', 'readFileCacheBytes', 'artifactTokenFor',
    'artifactPurposeFor', 'prepareAdminLocalUser',
  ]) {
    assert.equal(typeof provider[callback], 'function', callback + ' must remain callable');
  }
});

test('every landed policy owns its refusal; only prepareAdminLocalUser stays fail-closed', () => {
  // MDB-POLICY-05: the stub CONTEXT_POLICY_REQUIRED must be gone from every
  // callback that has a landed policy. Codes below are MEASURED on this tree
  // with an empty input, not assumed.
  const ownsRefusal = {
    prepareWorkflowSchema: 'INVALID_SOURCE',
    readFileCacheBytes: 'INVALID_ARTIFACT_BYTES',
    artifactTokenFor: 'INVALID_ARTIFACT_TOKEN',
    artifactPurposeFor: 'INVALID_ARTIFACT_PURPOSE',
  };
  for (const [callback, code] of Object.entries(ownsRefusal)) {
    assert.throws(() => provider[callback]({}, {}), (error) => {
      assert.equal(error.code, code, callback + ' must own its refusal code');
      assert.notEqual(error.code, 'CONTEXT_POLICY_REQUIRED');
      return true;
    });
  }
  // The two lenient readers answer empty input rather than refusing it.
  assert.equal(provider.resolveProfileName({}), '');
  assert.deepEqual(provider.normalizeConnectionsOverride({}), []);
  assert.throws(() => provider.prepareAdminLocalUser(), (error) => {
    assert.equal(error.code, 'PASSWORD_RESET_REQUIRED');
    return true;
  });
});
