'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createDecipheriv, createHash } = require('node:crypto');

// MDB-POLICY-03: prepareWorkflowSchema is the pure prep the LDBA-03 runner needs
// for one legacy wb_schema:<slug> AppSetting row (ldba-03-backfill.cjs:658-687).
// The runner owns the row write, so this suite pins the two values it consumes
// against the production sources rather than against the policy itself:
//   - the digest must be sha256 over the canonical pin bytes
//     (workflow-schemas.ts:70-76 -> legacy-workflow.ts:320-326), which is what
//     parseStoredPin recomputes on every catalog read;
//   - schema_ref must be the same SealedMetadata envelope the production writer
//     produces (workflow-schemas.ts:294-298 -> metadata-crypto.ts:306-335),
//     including the 32-byte AAD digest over tenantId|slot|refId.
// The suite therefore OPENS every envelope it asserts on, with its own decrypt
// and its own AAD recomputation, and it proves non-vacuity by planting a sentinel
// in the input schema and checking the sentinel never reaches the sealed column.
const provider = require('../scripts/ldba-context-provider.cjs');

const METADATA_ENABLED_ENV = 'DU_ENCRYPTION_METADATA_ENABLED';
const METADATA_SEAM_ENV = 'LDBA03_METADATA_SEAM_MODULE';
const METADATA_KEY_REF_ENV = 'LDBA03_METADATA_KEY_REF';
const SLOT = 'legacy_workflow_schemas.schema_ref';
const KEY_REF = 'du-orch-metadata-v1';
const TENANT = 'ffde5cd7-ab81-4086-afcd-14b6d82219c6';
const OTHER_TENANT = '00000000-0000-4000-8000-000000000001';
const SENTINEL = 'SENTINEL-PLAINTEXT-MUST-NOT-LEAK';
const ENVELOPE_FIELDS = ['version', 'algorithm', 'keyRef', 'dek', 'nonce', 'tag', 'aad', 'ciphertext', 'plaintextSha256'];

let seamPath;
let seam;
let previousEnv;

// The key seam is injected, exactly as createMetadataCrypto receives its
// keyProvider (metadata-crypto.ts:276-284). This double performs only the DEK
// wrap, the one step node:crypto cannot do for a Vault-backed reader.
const SEAM_SOURCE = [
  '\'use strict\';',
  'const { createHash } = require(\'node:crypto\');',
  'function keyFor(keyRef) {',
  '  return createHash(\'sha256\').update(keyRef).digest();',
  '}',
  'function xor(bytes, key) {',
  '  const out = Buffer.from(bytes);',
  '  for (let i = 0; i < out.length; i += 1) out[i] ^= key[i % key.length];',
  '  return out;',
  '}',
  'module.exports = {',
  '  async wrapDek(dek, keyRef) {',
  '    return {',
  '      version: 1,',
  '      keyName: keyRef,',
  '      keyVersion: 1,',
  '      wrappedKey: xor(dek, keyFor(keyRef)).toString(\'base64\'),',
  '    };',
  '  },',
  '  async unwrapDek(envelope) {',
  '    return xor(Buffer.from(envelope.wrappedKey, \'base64\'), keyFor(envelope.keyName));',
  '  },',
  '};',
  '',
].join('\n');

function restoreEnv(name, value) {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

function enableSeam() {
  process.env[METADATA_ENABLED_ENV] = 'true';
  process.env[METADATA_SEAM_ENV] = seamPath;
  process.env[METADATA_KEY_REF_ENV] = KEY_REF;
}

function disableSeam() {
  delete process.env[METADATA_ENABLED_ENV];
  delete process.env[METADATA_SEAM_ENV];
  delete process.env[METADATA_KEY_REF_ENV];
}

before(() => {
  seamPath = path.join(os.tmpdir(), 'mdb-policy-03-seam-' + String(process.pid) + '.cjs');
  fs.writeFileSync(seamPath, SEAM_SOURCE);
  seam = require(seamPath);
  previousEnv = {
    enabled: process.env[METADATA_ENABLED_ENV],
    module: process.env[METADATA_SEAM_ENV],
    keyRef: process.env[METADATA_KEY_REF_ENV],
  };
});

after(() => {
  restoreEnv(METADATA_ENABLED_ENV, previousEnv.enabled);
  restoreEnv(METADATA_SEAM_ENV, previousEnv.module);
  restoreEnv(METADATA_KEY_REF_ENV, previousEnv.keyRef);
  try {
    fs.unlinkSync(seamPath);
  } catch {
    // The temp seam is best-effort cleanup; the suite result does not depend on it.
  }
});

/** A complete legacy workflow schema (legacy-workflow.ts:116-125). */
function validSchema(overrides) {
  const base = {
    slug: 'analyze',
    name: 'Analyze pipeline',
    nodes: [{ id: 'start', type: 'input', key: 'document' }],
    flow: ['start'],
    extra: SENTINEL,
  };
  return Object.assign(base, overrides || {});
}

function workflowRequest(overrides) {
  const base = { slug: 'analyze', tenantId: TENANT, revision: 1 };
  return Object.assign(base, overrides || {});
}

// Recomputed independently here from the OPENED plaintext: this is the exact
// invariant parseStoredPin checks, so a passing digest proves the value is bound
// to the sealed content rather than merely well shaped.
function canonicalBytes(value) {
  const sort = (node) => {
    if (Array.isArray(node)) return node.map(sort);
    if (node === null || typeof node !== 'object') return node;
    const out = {};
    for (const key of Object.keys(node).sort()) out[key] = sort(node[key]);
    return out;
  };
  return Buffer.from(JSON.stringify(sort(value)), 'utf8');
}

async function openSchemaRef(envelope, tenantId, refId) {
  assert.deepEqual(Object.keys(envelope).sort(), [...ENVELOPE_FIELDS].sort(), 'the envelope must carry exactly the SealedMetadata fields');
  const expectedAad = createHash('sha256').update(tenantId + '|' + SLOT + '|' + refId).digest();
  assert.deepEqual(Buffer.from(envelope.aad, 'base64'), expectedAad, 'the AAD must bind tenant, slot and row id');
  const dek = await seam.unwrapDek(envelope.dek);
  const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
  decipher.setAAD(expectedAad);
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.ciphertext, 'base64')),
    decipher.final(),
  ]).toString('utf8');
  return JSON.parse(plaintext);
}

// --- happy path ------------------------------------------------------------

test('a valid schema yields a canonical digest and a sealed envelope', async () => {
  enableSeam();
  const prepared = await provider.prepareWorkflowSchema(validSchema(), workflowRequest());
  assert.equal(prepared.skipped, undefined);
  assert.match(prepared.digest, /^sha256:[0-9a-f]{64}$/);
  assert.equal(typeof prepared.schemaRef, 'object');
  const opened = await openSchemaRef(prepared.schemaRef, TENANT, 'analyze:1');
  assert.equal(opened.schema.slug, 'analyze');
  assert.deepEqual(opened.connectorSlotMap, {});
  assert.deepEqual(opened.approvedEgressOrigins, []);
  assert.equal(prepared.schemaRef.keyRef, KEY_REF);
  assert.equal(prepared.schemaRef.version, 1);
  assert.equal(prepared.schemaRef.algorithm, 'aes-256-gcm');
});

test('the digest is sha256 over the canonical pin bytes of the sealed content', async () => {
  enableSeam();
  const prepared = await provider.prepareWorkflowSchema(validSchema(), workflowRequest());
  const opened = await openSchemaRef(prepared.schemaRef, TENANT, 'analyze:1');
  const expected = 'sha256:' + createHash('sha256').update(canonicalBytes(opened)).digest('hex');
  assert.equal(prepared.digest, expected);
  assert.equal(prepared.schemaRef.plaintextSha256, createHash('sha256').update(canonicalBytes(opened)).digest('hex'));
});

test('the digest ignores input key order', async () => {
  enableSeam();
  const first = await provider.prepareWorkflowSchema(validSchema(), workflowRequest());
  const reordered = {
    flow: ['start'],
    nodes: [{ key: 'document', type: 'input', id: 'start' }],
    name: 'Analyze pipeline',
    extra: SENTINEL,
    slug: 'analyze',
  };
  const second = await provider.prepareWorkflowSchema(reordered, workflowRequest());
  assert.equal(first.digest, second.digest);
});

test('the sealed column carries no plaintext from the source schema', async () => {
  enableSeam();
  const prepared = await provider.prepareWorkflowSchema(validSchema(), workflowRequest());
  const column = JSON.stringify(prepared.schemaRef);
  assert.equal(column.includes(SENTINEL), false, 'the sealed column must not carry the source plaintext');
  const opened = await openSchemaRef(prepared.schemaRef, TENANT, 'analyze:1');
  assert.equal(opened.schema.extra, SENTINEL, 'the sentinel must really be inside the sealed plaintext');
});

test('a wrong tenant or row identity cannot open the envelope', async () => {
  enableSeam();
  const prepared = await provider.prepareWorkflowSchema(validSchema(), workflowRequest());
  const storedAad = Buffer.from(prepared.schemaRef.aad, 'base64');
  const wrongTenant = createHash('sha256').update(OTHER_TENANT + '|' + SLOT + '|analyze:1').digest();
  const wrongRef = createHash('sha256').update(TENANT + '|' + SLOT + '|extract:1').digest();
  assert.notDeepEqual(storedAad, wrongTenant);
  assert.notDeepEqual(storedAad, wrongRef);
});

test('connector slots are allocated from the first free slot in name order', async () => {
  enableSeam();
  const schema = validSchema({
    nodes: [
      { id: 'start', type: 'input', key: 'document' },
      { id: 'run_b', type: 'connector', connector: 'zeta' },
      { id: 'run_a', type: 'connector', connector: 'alpha' },
    ],
    flow: ['start', 'run_a'],
    output: { from: 'run_a' },
  });
  const prepared = await provider.prepareWorkflowSchema(schema, workflowRequest());
  const opened = await openSchemaRef(prepared.schemaRef, TENANT, 'analyze:1');
  assert.deepEqual(opened.connectorSlotMap, {
    alpha: 'legacy-connector-00',
    zeta: 'legacy-connector-01',
  });
});

test('approved origins are derived from the static https urls in the schema', async () => {
  enableSeam();
  const schema = validSchema({
    nodes: [
      { id: 'start', type: 'input', key: 'document' },
      { id: 'fetch', type: 'file_url_download', urls: ['https://files.example.test/in/a.pdf'] },
      { id: 'notify', type: 'callback', url: { url: 'https://hooks.example.test/cb' } },
    ],
    flow: ['start', 'fetch'],
    output: { from: 'fetch' },
  });
  const prepared = await provider.prepareWorkflowSchema(schema, workflowRequest());
  const opened = await openSchemaRef(prepared.schemaRef, TENANT, 'analyze:1');
  assert.deepEqual(opened.approvedEgressOrigins, ['https://files.example.test', 'https://hooks.example.test']);
});

// --- negative controls: schema --------------------------------------------

test('a malformed schema is refused before anything is sealed', () => {
  enableSeam();
  const cases = [
    null,
    'analyze',
    [],
    validSchema({ nodes: [] }),
    validSchema({ name: '' }),
    validSchema({ nodes: [{ id: 'start', type: 'unknown_type' }] }),
    validSchema({ nodes: [{ type: 'input', key: 'document' }] }),
    validSchema({ nodes: [{ id: '9bad', type: 'input', key: 'document' }] }),
    validSchema({ nodes: [{ id: 'start', type: 'human' }] }),
    validSchema({ flow: ['missing'] }),
    validSchema({ flow: ['start', 'start'] }),
    validSchema({ output: { from: 'missing' } }),
    validSchema({ input_schema: { type: 'array', properties: {} } }),
    validSchema({ input_schema: { type: 'object' } }),
    validSchema({ slug: 'Bad Slug' }),
    validSchema({ nodes: [{ id: 'a', type: 'input', key: 'k' }, { id: 'a', type: 'join' }], flow: ['a'] }),
  ];
  for (const schema of cases) {
    assert.throws(
      () => provider.prepareWorkflowSchema(schema, workflowRequest()),
      (error) => {
        assert.equal(error.name, 'WorkflowSchemaPolicyError');
        assert.equal(error.code, 'INVALID_SCHEMA');
        assert.equal(error.callback, 'prepareWorkflowSchema');
        return true;
      },
      JSON.stringify(schema) + ' must be refused as INVALID_SCHEMA',
    );
  }
});

test('a slug that disagrees with the AppSetting key is refused', () => {
  enableSeam();
  assert.throws(
    () => provider.prepareWorkflowSchema(validSchema(), workflowRequest({ slug: 'extract' })),
    (error) => error.code === 'KEY_SCHEMA_SLUG_MISMATCH',
  );
});

test('a malformed request is refused', () => {
  enableSeam();
  const cases = [
    [validSchema(), null],
    [validSchema(), undefined],
    [validSchema(), {}],
    [validSchema(), workflowRequest({ slug: '' })],
    [validSchema(), workflowRequest({ tenantId: '   ' })],
    [validSchema(), workflowRequest({ revision: 2 })],
  ];
  for (const [schema, request] of cases) {
    assert.throws(
      () => provider.prepareWorkflowSchema(schema, request),
      (error) => error.code === 'INVALID_SOURCE',
    );
  }
});

// --- negative controls: egress --------------------------------------------

test('egress that cannot be approved is refused', () => {
  enableSeam();
  const cases = [
    [{ id: 'fetch', type: 'file_url_download', urls: ['$downloads.url'] }, 'DYNAMIC_EGRESS_URL'],
    [{ id: 'fetch', type: 'file_url_download', urls: ['http://files.example.test/a.pdf'] }, 'NON_HTTPS_EGRESS_URL'],
    [{ id: 'fetch', type: 'file_url_download', urls: ['https://user:pw@files.example.test/a.pdf'] }, 'EGRESS_URL_USERINFO'],
    [{ id: 'fetch', type: 'file_url_download' }, 'EGRESS_WITHOUT_URL'],
    [{ id: 'notify', type: 'callback' }, 'EGRESS_WITHOUT_URL'],
    [{ id: 'notify', type: 'callback', url: 'not-a-url' }, 'INVALID_EGRESS_URL'],
  ];
  for (const [node, code] of cases) {
    const schema = validSchema({ nodes: [{ id: 'start', type: 'input', key: 'document' }, node], flow: ['start'] });
    assert.throws(
      () => provider.prepareWorkflowSchema(schema, workflowRequest()),
      (error) => {
        assert.equal(error.code, code);
        return true;
      },
      JSON.stringify(node) + ' must be refused with ' + code,
    );
  }
});

// --- negative controls: the injected key seam -----------------------------

test('no metadata seam means no schema is sealed', () => {
  disableSeam();
  assert.throws(() => provider.prepareWorkflowSchema(validSchema(), workflowRequest()), (error) => error.code === 'METADATA_SEAM_DISABLED');
  process.env[METADATA_ENABLED_ENV] = 'true';
  assert.throws(() => provider.prepareWorkflowSchema(validSchema(), workflowRequest()), (error) => error.code === 'METADATA_SEAM_MODULE_REQUIRED');
  process.env[METADATA_SEAM_ENV] = seamPath;
  assert.throws(() => provider.prepareWorkflowSchema(validSchema(), workflowRequest()), (error) => error.code === 'METADATA_KEY_REF_REQUIRED');
  process.env[METADATA_KEY_REF_ENV] = KEY_REF;
  process.env[METADATA_SEAM_ENV] = path.join(os.tmpdir(), 'mdb-policy-03-absent-seam.cjs');
  assert.throws(() => provider.prepareWorkflowSchema(validSchema(), workflowRequest()), (error) => error.code === 'METADATA_SEAM_LOAD_FAILED');
  process.env[METADATA_SEAM_ENV] = seamPath;
  process.env[METADATA_KEY_REF_ENV] = '   ';
  assert.throws(() => provider.prepareWorkflowSchema(validSchema(), workflowRequest()), (error) => error.code === 'METADATA_KEY_REF_REQUIRED');
  disableSeam();
});

// --- regression guards -----------------------------------------------------

function connectorRequest(authKeyHeader) {
  return {
    connectorId: 'conn-policy-03',
    revisionNumber: 1,
    state: 'ACTIVE',
    createdAt: '2026-01-01 00:00:00.000000',
    config: {
      httpMethod: 'POST',
      authType: 'API_KEY_HEADER',
      authKeyHeader,
      timeoutSec: 30,
      endpointUrl: 'https://api.example.test/v1',
      responseContentPath: 'response',
      promptFieldName: 'query',
      fileFieldName: 'files',
      extraHeaders: null,
    },
  };
}

test('prepareConnector still maps a legacy connector row', () => {
  const previous = process.env.CONNECTOR_ENCRYPTION_KEY;
  process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const prepared = provider.prepareConnector(
      { id: 'conn-policy-03', authSecret: 'legacy-secret' },
      connectorRequest('x-trace-id'),
    );
    assert.equal(prepared.skipped, undefined);
    assert.equal(prepared.revision.connector_id, 'conn-policy-03');
    assert.equal(prepared.revision.config.credentialSlot, 'header:x-trace-id');
    assert.equal(typeof prepared.secret.id, 'string');
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = previous;
  }
});

// Finding, not a defect of this packet: MDB-POLICY-01 lists x-api-key in
// SECRET_HEADER_NAMES (mirrored from packages/contracts/src/vault.ts), so the
// legacy DEFAULT auth key header (lib/db/schema.ts:56) is refused as
// INVALID_AUTH_HEADER and such a connector cannot migrate under that policy.
// Pinned here so the next lane sees it instead of rediscovering it.
test('prepareConnector still refuses a credential-bearing auth header', () => {
  const previous = process.env.CONNECTOR_ENCRYPTION_KEY;
  process.env.CONNECTOR_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString('base64');
  try {
    const prepared = provider.prepareConnector(
      { id: 'conn-policy-03', authSecret: 'legacy-secret' },
      connectorRequest('x-api-key'),
    );
    assert.equal(prepared.skipped, true);
    assert.equal(prepared.code, 'INVALID_AUTH_HEADER');
  } finally {
    if (previous === undefined) delete process.env.CONNECTOR_ENCRYPTION_KEY;
    else process.env.CONNECTOR_ENCRYPTION_KEY = previous;
  }
});

test('resolveProfileName and normalizeConnectionsOverride still answer', () => {
  assert.equal(provider.resolveProfileName({ endpointSlug: 'analyze' }), 'Imported analyze');
  assert.deepEqual(provider.normalizeConnectionsOverride([{ slug: 'first' }]), [{ slug: 'first' }]);
  assert.equal(typeof provider.normalizeConnectionsOverride(null).then, 'undefined');
});

test('the FileCache policies own their refusals; only prepareAdminLocalUser stays fail-closed', () => {
  // MDB-POLICY-05: MDB-POLICY-04 landed after this suite, so these callbacks no
  // longer answer with the stub error. Codes are MEASURED on this tree.
  const ownsRefusal = {
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
  assert.throws(() => provider.prepareAdminLocalUser(), (error) => {
    assert.equal(error.code, 'PASSWORD_RESET_REQUIRED');
    return true;
  });
});

test('the boot contract still holds', () => {
  for (const callback of ['prepareConnector', 'resolveProfileName', 'normalizeConnectionsOverride',
    'prepareWorkflowSchema', 'readFileCacheBytes', 'artifactTokenFor', 'artifactPurposeFor', 'prepareAdminLocalUser']) {
    assert.equal(typeof provider[callback], 'function', callback + ' must remain callable');
  }
});
