/* DSH2 architecture probe for OR10-01. READ-ONLY: loads the real contract
   sources through a transpile hook and asserts the schema facts the proposal
   depends on. Writes nothing to the repo. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = 'D:/Git/dugate/du-rework/orchestrator';
const CONTRACTS_SRC = path.join(ROOT, 'packages/contracts/src');
const ts = require(path.join(ROOT, 'services/orchestrator/node_modules/typescript/lib/typescript.js'));

require.extensions['.ts'] = function loadTs(module, filename) {
  const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  module._compile(out, filename);
};

const results = [];
function check(name, fn) {
  try { const d = fn(); results.push({ name, pass: true, detail: d === undefined ? '' : String(d) }); }
  catch (e) { results.push({ name, pass: false, detail: String((e && e.message) || e) }); }
}

const policy = require(path.join(CONTRACTS_SRC, 'profile-policy.ts'));
const callback = require(path.join(CONTRACTS_SRC, 'profile-callback.ts'));

const ORIGIN_OK = 'https://files.provider.example';

check('P1 write schema rejects a new top-level key today (strict ⇒ must be added explicitly)', () => {
  const before = policy.ProfileEndpointPolicySchema.safeParse({});
  assert.equal(before.success, true, 'empty partial policy must stay valid');
  const withOrigins = policy.ProfileEndpointPolicySchema.safeParse({ allowedOrigins: [ORIGIN_OK] });
  assert.equal(withOrigins.success, false, 'unknown key was accepted — schema is not strict');
  const issue = withOrigins.error.issues[0];
  assert.equal(issue.code, 'unrecognized_keys');
  return 'empty ok; allowedOrigins -> unrecognized_keys (' + issue.message + ')';
});

check('P2 read schema also rejects it today (the UI cannot see the list without a change)', () => {
  const complete = {
    enabled: true, parameters: {}, jobPriority: 'MEDIUM', allowedFileExtensions: '',
    fileUrlAuthConfigured: true, connectionsOverride: [], requestRedaction: [],
  };
  assert.equal(policy.ProfileEndpointPolicyReadSchema.safeParse(complete).success, true, 'baseline read shape must parse');
  const withOrigins = policy.ProfileEndpointPolicyReadSchema.safeParse({ ...complete, allowedOrigins: [ORIGIN_OK] });
  assert.equal(withOrigins.success, false, 'read schema accepted the key');
  assert.equal(withOrigins.error.issues[0].code, 'unrecognized_keys');
  return 'baseline ok; allowedOrigins -> unrecognized_keys';
});

check('P3 the pinned snapshot is strict too (snapshot route needs the claim schema updated or claims 422)', () => {
  const snapshot = {
    enabled: true, parameters: {}, jobPriority: 'MEDIUM', allowedFileExtensions: '',
    connectionsOverride: [], fileUrlAuthConfigured: true,
    credentialRef: { tenantId: '11111111-1111-4111-8111-111111111111', profileId: 'p-1', profileRevision: 3 },
  };
  assert.equal(policy.ProfilePolicySnapshotSchema.safeParse(snapshot).success, true, 'baseline snapshot must parse');
  const withOrigins = policy.ProfilePolicySnapshotSchema.safeParse({ ...snapshot, allowedOrigins: [ORIGIN_OK] });
  assert.equal(withOrigins.success, false, 'snapshot schema accepted the key');
  assert.equal(withOrigins.error.issues[0].code, 'unrecognized_keys');
  const runtimeSrc = fs.readFileSync(path.join(CONTRACTS_SRC, 'runtime.ts'), 'utf8');
  assert.match(runtimeSrc, /PinnedProfilePolicySchema = ProfilePolicySnapshotSchema/,
    'claim path must still validate with the snapshot schema');
  return 'extra key rejected; claim path aliases the same strict schema';
});

check('P4 CallbackApprovedOriginSchema is reusable as-is for exact https origins', () => {
  const good = [ORIGIN_OK, 'https://host.example:8443'];
  for (const value of good) assert.equal(callback.CallbackApprovedOriginSchema.safeParse(value).success, true, 'rejected ' + value);
  const bad = ['http://files.provider.example', ORIGIN_OK + '/path', ORIGIN_OK + '?q=1', ORIGIN_OK + '#frag',
    'https://user:pw@files.provider.example', 'not-a-url'];
  for (const value of bad) assert.equal(callback.CallbackApprovedOriginSchema.safeParse(value).success, false, 'accepted ' + value);
  return 'accepts exact https (incl. explicit port); rejects http/path/query/fragment/userinfo/non-url';
});

check('P5 the schema does NOT canonicalise, so entries must be normalised when validated', () => {
  const mixedCase = 'https://FILES.Provider.EXAMPLE';
  assert.equal(callback.CallbackApprovedOriginSchema.safeParse(mixedCase).success, true,
    'schema unexpectedly rejects mixed case — check the normalisation assumption');
  const decision = callback.authorizeCallbackDestination(
    'https://files.provider.example/x',
    { method: 'bearer', token: 't' },
    { approvedOrigins: [mixedCase] },
  );
  assert.equal(decision.kind, 'DENIED', 'raw-string prior art unexpectedly matched');
  assert.match(String(decision.reason), /not approved/);
  const canonical = callback.authorizeCallbackDestination(
    'https://files.provider.example/x',
    { method: 'bearer', token: 't' },
    { approvedOrigins: ['https://files.provider.example'] },
  );
  assert.equal(canonical.kind, 'ALLOWED');
  return 'mixed-case entry is stored but never matches (URL.origin is lowercased) -> validator must canonicalise';
});

check('P6 prior art denies credential-bearing traffic with an empty allowlist (fail-closed precedent)', () => {
  const empty = callback.authorizeCallbackDestination('https://files.provider.example/x',
    { method: 'bearer', token: 't' }, { approvedOrigins: [] });
  assert.equal(empty.kind, 'DENIED');
  const none = callback.authorizeCallbackDestination('https://files.provider.example/x', { method: 'none' }, null);
  assert.equal(none.kind, 'ALLOWED', 'auth-less destination should stay allowed');
  return 'empty list -> DENIED for credential-bearing; none-auth -> ALLOWED';
});

check('P7 ResolvedSourceAuth has no origin field today (union extension is required)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/orchestrator/src/modules/operations/acquisition-ref-resolver.ts'), 'utf8');
  assert.match(src, /export type ResolvedSourceAuth =\s*\n\s*\| \{ kind: 'none' \}\s*\n\s*\| \{ kind: 'bearer'; token: string \}\s*\n\s*\| \{ kind: 'header'; headerName: string; headerValue: string \};/);
  assert.ok(!/allowedOrigins/.test(src), 'resolver unexpectedly mentions allowedOrigins');
  assert.match(src, /const BINDING_CIPHER_SQL =\s*\n\s*'SELECT tenant_id AS "tenantId", file_url_auth_cipher AS "cipher" '/);
  return 'union is none|bearer|header; binding query selects the cipher only (no policy column)';
});

check('P8 PERMANENT_CODES holds the six auth codes and neither new code (the easy-to-miss step)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'services/orchestrator/src/modules/operations/ingestion-consumer.ts'), 'utf8');
  const block = /const PERMANENT_CODES = new Set\(\[([\s\S]*?)\]\);/.exec(src);
  assert.ok(block, 'PERMANENT_CODES not found');
  const codes = [...block[1].matchAll(/'([A-Z0-9_]+)'/g)].map((m) => m[1]);
  for (const existing of ['REF_INVALID', 'REF_NOT_FOUND', 'REF_TENANT_MISMATCH', 'AUTH_CONFIG_MISSING', 'AUTH_DECRYPT_FAILED', 'QUERY_AUTH_FORBIDDEN']) {
    assert.ok(codes.includes(existing), 'missing ' + existing);
  }
  assert.ok(!codes.includes('ORIGIN_NOT_ALLOWLISTED') && !codes.includes('ORIGIN_POLICY_MISSING'));
  assert.match(src, /err instanceof SourceAuthDeniedError\s*\n\s*\? err\.code/, 'failureCode must read the typed code');
  return codes.length + ' codes; new ones absent; failureCode reads err.code so taxonomy follows the class';
});

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exitCode = failed.length === 0 ? 0 : 1;
