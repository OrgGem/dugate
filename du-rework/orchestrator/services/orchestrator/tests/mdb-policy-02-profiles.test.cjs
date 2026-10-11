'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');

// MDB-POLICY-02: resolveProfileName and normalizeConnectionsOverride are the two
// profile callbacks the LDBA-03 runner requires (ldba-03-backfill.cjs:583-599).
// The runner owns every row assertion, so this suite pins the policy against the
// contracts the runner and the rework read path actually enforce, not against
// itself:
//   - the callback must be synchronous and pure (ldba-03-production-adapter.cjs
//     syncContext rejects a thenable);
//   - a name is a refusal (empty string) or a non-empty string, never a throw
//     (ldba-03-backfill.cjs:591-593 reports INVALID_PROFILE_NAME);
//   - the normalizer always returns an array (ldba-03-backfill.cjs:596-599
//     reports INVALID_CONNECTION_OVERRIDE for anything else);
//   - every emitted step must satisfy the strict ConnectionStepSchema
//     (packages/contracts/src/profile-policy.ts:209-216), because the backfill
//     writes jsonb directly and never re-validates.
const provider = require('../scripts/ldba-context-provider.cjs');

// Strict ConnectionStepSchema keys - no other key may survive normalization.
const STEP_KEYS = ['slug', 'stepId', 'captureSession', 'injectSession'];

const KEY_ENV = 'CONNECTOR_ENCRYPTION_KEY';
const KEY = Buffer.alloc(32, 9);
let previousKey;

before(() => {
  previousKey = process.env[KEY_ENV];
  process.env[KEY_ENV] = KEY.toString('base64');
});

after(() => {
  if (previousKey === undefined) delete process.env[KEY_ENV];
  else process.env[KEY_ENV] = previousKey;
});

/** A complete legacy ProfileEndpoint row (lib/db/schema.ts:122-137). */
function legacyProfileRow(overrides) {
  const base = {
    id: '50000000-0000-4000-8000-0000000000aa',
    apiKeyId: '40000000-0000-4000-8000-0000000000bb',
    endpointSlug: 'analyze',
    enabled: true,
    parameters: null,
    connectionsOverride: null,
    jobPriority: 'MEDIUM',
    fileUrlAuthConfig: null,
    allowedFileExtensions: null,
    rateLimitPerMin: null,
    maxConcurrent: null,
    createdAt: '2026-01-02T03:04:05.000Z',
    updatedAt: '2026-01-02T03:04:05.000Z',
  };
  return Object.assign(base, overrides || {});
}

function connectorRequest() {
  return {
    connectorId: 'conn-profile-02',
    revisionNumber: 1,
    state: 'ACTIVE',
    config: {
      endpointUrl: 'https://api.legacy.example/v1/run?mode=full',
      httpMethod: 'POST',
      authType: 'API_KEY_HEADER',
      authKeyHeader: 'X-Legacy-Key',
      promptFieldName: 'prompt',
      responseContentPath: 'data.output',
      timeoutSec: 30,
    },
    createdAt: '2026-01-02T03:04:05.000Z',
  };
}

// --- resolveProfileName: happy path ---------------------------------------

test('a clean legacy slug becomes the Imported name', () => {
  const name = provider.resolveProfileName(legacyProfileRow());
  assert.equal(name, 'Imported analyze');
  assert.equal(typeof name, 'string');
  assert.ok(name.length > 0);
});

test('surrounding whitespace never leaks into the name', () => {
  assert.equal(provider.resolveProfileName(legacyProfileRow({ endpointSlug: '  analyze  ' })), 'Imported analyze');
});

test('the name is derived from the slug alone, not from any other column', () => {
  const name = provider.resolveProfileName(legacyProfileRow({
    id: '50000000-0000-4000-8000-0000000000cc',
    apiKeyId: '40000000-0000-4000-8000-0000000000dd',
    jobPriority: 'HIGH',
    rateLimitPerMin: 7,
    allowedFileExtensions: 'pdf,docx',
  }));
  assert.equal(name, 'Imported analyze');
});

test('a punctuated or upper-case slug is sanitized into a stable token', () => {
  assert.equal(provider.resolveProfileName(legacyProfileRow({ endpointSlug: 'extract:contract' })), 'Imported extract-contract');
  assert.equal(provider.resolveProfileName(legacyProfileRow({ endpointSlug: 'Foo Bar' })), 'Imported foo-bar');
  assert.equal(provider.resolveProfileName(legacyProfileRow({ endpointSlug: 'doc.extract' })), 'Imported doc.extract');
  assert.equal(provider.resolveProfileName(legacyProfileRow({ endpointSlug: 'Doc.Extract' })), 'Imported doc-extract');
});

test('the name is deterministic and stays inside the profile name budget', () => {
  const first = provider.resolveProfileName(legacyProfileRow({ endpointSlug: 'x'.repeat(200) }));
  const second = provider.resolveProfileName(legacyProfileRow({ endpointSlug: 'x'.repeat(200) }));
  assert.equal(first, second);
  assert.ok(first.startsWith('Imported '));
  assert.ok(first.length <= 73, first.length + ' characters is beyond the 9 + 64 budget');
  assert.ok(first.length < 256, 'the profile-callback contract caps profileName at 256');
});

// --- resolveProfileName: negative controls ---------------------------------

test('a row that cannot name a profile returns an empty string, never a throw', () => {
  const unusable = [
    null,
    undefined,
    {},
    { endpointSlug: null },
    { endpointSlug: 42 },
    { endpointSlug: {} },
    { endpointSlug: '' },
    { endpointSlug: '   ' },
    { endpointSlug: '///' },
    'analyze',
  ];
  for (const row of unusable) {
    const name = provider.resolveProfileName(row);
    assert.equal(typeof name, 'string', JSON.stringify(row) + ' must answer with a string');
    assert.equal(name, '', JSON.stringify(row) + ' must be refused as INVALID_PROFILE_NAME');
  }
});

// --- normalizeConnectionsOverride: happy path ------------------------------

test('null and undefined collapse to an empty chain', () => {
  assert.deepEqual(provider.normalizeConnectionsOverride(null), []);
  assert.deepEqual(provider.normalizeConnectionsOverride(undefined), []);
});

test('an empty array stays an empty array', () => {
  assert.deepEqual(provider.normalizeConnectionsOverride([]), []);
});

test('modern ConnectionStep entries are carried with their session wiring', () => {
  const steps = [{ slug: 'analyze', stepId: 'step-1', captureSession: 'sid', injectSession: null }];
  assert.deepEqual(provider.normalizeConnectionsOverride(steps), steps);
});

test('legacy bare slug strings become slug steps', () => {
  assert.deepEqual(provider.normalizeConnectionsOverride(['first', 'second']), [{ slug: 'first' }, { slug: 'second' }]);
});

test('a mixed chain keeps its order', () => {
  const normalized = provider.normalizeConnectionsOverride(['first', { slug: 'second', stepId: 'step-2' }, 'third']);
  assert.deepEqual(normalized, [{ slug: 'first' }, { slug: 'second', stepId: 'step-2' }, { slug: 'third' }]);
});

test('a legacy wrapper object yields its step array', () => {
  assert.deepEqual(provider.normalizeConnectionsOverride({ steps: [{ slug: 'first' }] }), [{ slug: 'first' }]);
  assert.deepEqual(provider.normalizeConnectionsOverride({ wrapper: { nested: [] } }), []);
});

test('the answer is a fresh array and never the caller value', () => {
  const input = [{ slug: 'first' }];
  const normalized = provider.normalizeConnectionsOverride(input);
  assert.notEqual(normalized, input);
  normalized.push({ slug: 'injected' });
  assert.equal(input.length, 1);
});

// --- normalizeConnectionsOverride: negative controls and fallback ----------

test('malformed or non-array input falls back to an empty chain without throwing', () => {
  for (const raw of ['not-json', 42, true, {}, { a: 1 }]) {
    assert.deepEqual(provider.normalizeConnectionsOverride(raw), [], JSON.stringify(raw) + ' must fall back');
  }
});

test('a step without a usable slug is dropped while the rest of the chain survives', () => {
  const normalized = provider.normalizeConnectionsOverride([{ slug: '' }, { slug: 'kept' }, 42, null, { stepId: 'orphan' }]);
  assert.deepEqual(normalized, [{ slug: 'kept' }]);
});

test('every emitted step stays inside the strict ConnectionStep schema', () => {
  const normalized = provider.normalizeConnectionsOverride([
    { slug: 'first', stepId: 'step-1', captureSession: 'sid', injectSession: null, retries: 3, prompt: 'PRIVATE' },
    { slug: 'second', stepId: 7, captureSession: false },
    'third',
  ]);
  assert.deepEqual(normalized, [{ slug: 'first', stepId: 'step-1', captureSession: 'sid', injectSession: null }, { slug: 'second' }, { slug: 'third' }]);
  for (const step of normalized) {
    for (const key of Object.keys(step)) {
      assert.ok(STEP_KEYS.includes(key), key + ' is not a ConnectionStepSchema key');
    }
    assert.equal(typeof step.slug, 'string');
    assert.ok(step.slug.length > 0);
  }
  assert.ok(!JSON.stringify(normalized).includes('PRIVATE'));
});

// --- regression guards -----------------------------------------------------

test('prepareConnector still maps a legacy connector row', () => {
  const prepared = provider.prepareConnector({ id: 'conn-profile-02', authSecret: 'legacy-secret' }, connectorRequest());
  assert.equal(prepared.skipped, undefined);
  assert.equal(prepared.revision.connector_id, 'conn-profile-02');
  assert.equal(typeof prepared.secret.id, 'string');
});

test('the later policies own their refusals; only prepareAdminLocalUser stays fail-closed', () => {
  // MDB-POLICY-05: MDB-POLICY-03 and MDB-POLICY-04 landed after this suite, so
  // their callbacks no longer answer with the stub error. Codes are MEASURED.
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
  assert.throws(() => provider.prepareAdminLocalUser(), (error) => {
    assert.equal(error.code, 'PASSWORD_RESET_REQUIRED');
    return true;
  });
});

test('the boot contract still holds and the two new callbacks are synchronous', () => {
  for (const callback of ['prepareConnector', 'resolveProfileName', 'normalizeConnectionsOverride',
    'prepareWorkflowSchema', 'readFileCacheBytes', 'artifactTokenFor', 'artifactPurposeFor', 'prepareAdminLocalUser']) {
    assert.equal(typeof provider[callback], 'function', callback + ' must remain callable');
  }
  const steps = provider.normalizeConnectionsOverride([{ slug: 'first' }]);
  assert.equal(typeof steps.then, 'undefined', 'syncContext rejects a thenable');
  assert.equal(typeof provider.resolveProfileName(legacyProfileRow()), 'string');
});
