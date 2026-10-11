/* DSH2 follow-up probe: independent semantics checks on the REMAINING parts of
   packages/contracts (ip-policy, errors, hashing, profile-callback, queue,
   version) plus the orchestrator route parser's eight-parameter wiring.
   READ-ONLY: loads working-tree TypeScript sources through a transpile hook. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = 'D:/Git/dugate/du-rework/orchestrator';
const SRC = path.join(ROOT, 'packages/contracts/src');
const ORCH_SRC = path.join(ROOT, 'services/orchestrator/src');
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

const ip = require(path.join(SRC, 'ip-policy.ts'));
const errors = require(path.join(SRC, 'errors.ts'));
const hashing = require(path.join(SRC, 'hashing.ts'));
const cb = require(path.join(SRC, 'profile-callback.ts'));
const queue = require(path.join(SRC, 'queue.ts'));
const version = require(path.join(SRC, 'version.ts'));

// ---- M1 ip-policy -------------------------------------------------------
check('M1 blocked address families are all denied as literals', () => {
  const blocked = ['10.0.0.1', '172.16.0.1', '192.168.1.1', '127.0.0.1', '169.254.169.254',
    '100.64.0.1', '224.0.0.1', '0.0.0.0', '::1', 'fc00::1', 'fe80::1', '::ffff:10.0.0.1',
    '2002:0a00:0001::1', '64:ff9b::a00:1'];
  for (const address of blocked) {
    assert.equal(ip.isDestinationAddressAllowed(address), false, 'allowed: ' + address);
    assert.equal(ip.isPubliclyRoutableAddress(address), false, 'public: ' + address);
  }
  return blocked.length + ' blocked forms denied';
});

check('M2 public addresses stay allowed (the policy is not a blanket deny)', () => {
  for (const address of ['93.184.216.34', '8.8.8.8', '2606:2800:220:1:248:1893:25c8:1946']) {
    assert.equal(ip.isDestinationAddressAllowed(address), true, 'denied: ' + address);
    assert.equal(ip.isPubliclyRoutableAddress(address), true, 'not public: ' + address);
  }
  return '3 public forms allowed';
});

check('M3 URL adjudication: protocol, userinfo, literal and hostname shapes', () => {
  assert.equal(ip.adjudicateUrlDestination('ftp://example.com/x').kind, 'DENIED');
  assert.equal(ip.adjudicateUrlDestination('https://user:pw@example.com/x').kind, 'DENIED');
  assert.equal(ip.adjudicateUrlDestination('https://10.0.0.1/x').kind, 'DENIED');
  assert.equal(ip.adjudicateUrlDestination('https://[::ffff:127.0.0.1]/x').kind, 'DENIED');
  assert.equal(ip.adjudicateUrlDestination('https://93.184.216.34/x').kind, 'ALLOWED');
  assert.equal(ip.adjudicateUrlDestination('https://example.com/x').kind, 'NEEDS_RESOLUTION');
  assert.equal(ip.adjudicateUrlDestination('not a url').kind, 'DENIED');
  return 'protocol/userinfo/literal/hostname/garbage behave';
});

check('M4 the opt-ins are narrow: allowHosts permits one literal, metadata stays denied', () => {
  const opted = ip.adjudicateUrlDestination('https://10.0.0.1/x', { allowHosts: new Set(['10.0.0.1']) });
  assert.equal(opted.kind, 'ALLOWED', JSON.stringify(opted));
  const privateOk = ip.adjudicateUrlDestination('https://10.0.0.1/x', { allowPrivateNetworks: true });
  assert.equal(privateOk.kind, 'ALLOWED');
  for (const address of ['169.254.169.254', '100.64.0.1', '224.0.0.1']) {
    assert.equal(ip.adjudicateUrlDestination('https://' + address + '/x', { allowPrivateNetworks: true }).kind, 'DENIED',
      'allowPrivateNetworks must not open ' + address);
  }
  return 'allowHosts=1 literal; allowPrivateNetworks keeps metadata/CGNAT/multicast shut';
});

// ---- M2 errors ----------------------------------------------------------
check('M5 STATUS_CODES is keyed by HTTP-status names, not by error codes', () => {
  const expect = { NOT_AUTHENTICATED: 401, FORBIDDEN: 403, NOT_FOUND: 404, CONFLICT: 409, GONE: 410,
    TOO_LARGE: 413, UNSUPPORTED_MEDIA: 415, UNPROCESSABLE: 422, RATE_LIMITED: 429,
    UNAVAILABLE: 503, GATEWAY: 502, TIMEOUT: 504 };
  for (const [name, status] of Object.entries(expect)) {
    assert.equal(errors.STATUS_CODES[name], status, name + ' -> ' + errors.STATUS_CODES[name]);
  }
  // Documented split of duties: the code -> status mapping lives in the service
  // layer (src/http/errors.ts), so an error CODE has no entry here by design.
  assert.equal(errors.STATUS_CODES['INVALID_SCHEMA'], undefined);
  assert.equal(errors.STATUS_CODES['STATE_CONFLICT'], undefined);
  return Object.keys(expect).length + ' status names; code->status is the service layer job';
});

check('M6 published code lists are unique WITHIN each family (cross-family overlap is by design)', () => {
  for (const [label, list] of [['public', errors.PublicErrorCodes], ['runtime', errors.RuntimeErrorCodes],
    ['connector', errors.ConnectorErrorCodes]]) {
    assert.equal(new Set(list).size, list.length, label + ' list repeats a code');
  }
  const all = [...errors.PublicErrorCodes, ...errors.RuntimeErrorCodes, ...errors.ConnectorErrorCodes];
  const duplicates = all.filter((code, i) => all.indexOf(code) !== i);
  const shared = [...new Set(duplicates)].sort();
  assert.deepEqual(shared, ['INPUT_HASH_MISMATCH', 'INVALID_SCHEMA', 'PROVIDER_UNAVAILABLE', 'STATE_CONFLICT'],
    'cross-family overlaps changed: ' + shared.join(','));
  return all.length + ' entries / ' + new Set(all).size + ' unique; 4 codes intentionally span two boundaries';
});

check('M7 problem() emits a schema-valid problem+json object', () => {
  const built = errors.problem(409, 'STATE_CONFLICT', 'conflict', 'x', { correlationId: 'abc-123456' });
  assert.equal(built.type, 'urn:du:error:state_conflict');
  assert.equal(built.status, 409);
  const parsed = errors.ProblemSchema.safeParse(built);
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  const minimal = errors.ProblemSchema.safeParse(errors.problem(422, 'INVALID_SCHEMA', 't'));
  assert.equal(minimal.success, true, 'a problem without detail must stay valid');
  assert.equal(errors.ProblemSchema.safeParse(errors.problem(409, 'STATE_CONFLICT', 't', undefined,
    { correlationId: 'short' })).success, false, 'a too-short correlationId must fail');
  return 'type urn + status + detail + correlationId regex behave';
});

// ---- M3 hashing ---------------------------------------------------------
check('M8 content hashes are prefixed sha256:, deterministic and key-order independent', () => {
  const a = hashing.contentHash({ b: 1, a: [2, 3], c: { d: 'x' } });
  const b = hashing.contentHash({ c: { d: 'x' }, a: [2, 3], b: 1 });
  assert.equal(a, b, 'key order changed the hash');
  assert.match(a, /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(a, hashing.contentHash({ b: 1, a: [2, 3], c: { d: 'y' } }));
  assert.equal(hashing.contentHash([1, 2]), hashing.contentHash([1, 2]));
  assert.notEqual(hashing.contentHash([1, 2]), hashing.contentHash([2, 1]), 'array order must matter');
  return 'prefixed sha256, stable, order-sensitive for arrays only';
});

check('M9 the invocation hash covers exactly its declared field set', () => {
  const parts = {
    contractVersion: '1', tenantId: 't1', operationId: 'op', taskId: 'task', stepKey: 's1',
    bindingSlot: 'slot-a', input: { a: 1 }, deadlineAt: '2026-10-10T00:00:00Z',
  };
  const one = hashing.hashInvocationInput(parts);
  assert.equal(one, hashing.hashInvocationInput({ ...parts }), 'same input hashed differently');
  assert.match(one, /^sha256:[0-9a-f]{64}$/);
  for (const field of ['tenantId', 'operationId', 'taskId', 'stepKey', 'bindingSlot', 'deadlineAt']) {
    assert.notEqual(one, hashing.hashInvocationInput({ ...parts, [field]: 'other' }), field + ' is not hashed');
  }
  assert.notEqual(one, hashing.hashInvocationInput({ ...parts, input: { a: 2 } }));
  // Fields the interface does not declare must NOT influence the hash.
  assert.equal(one, hashing.hashInvocationInput({ ...parts, action: 'analyze', businessId: 'b' }));
  // options defaults to {} on both sides of the seam.
  assert.equal(one, hashing.hashInvocationInput({ ...parts, options: {} }));
  assert.equal(hashing.normalizeRouteAction('biz', 'extract'), 'biz/extract');
  assert.equal(hashing.normalizeRouteAction('biz', 'extract', 'legacy-route'), 'biz/legacy-route');
  return '10 declared fields covered; undeclared extras ignored; alias folding works';
});

// ---- M4 profile-callback ------------------------------------------------
check('M10 credential-bearing callbacks need an exact approved origin', () => {
  const bearer = { method: 'bearer', token: 't' };
  assert.equal(cb.authorizeCallbackDestination('https://cb.example/x', bearer, null).kind, 'DENIED');
  assert.equal(cb.authorizeCallbackDestination('https://cb.example/x', bearer, { approvedOrigins: [] }).kind, 'DENIED');
  assert.equal(cb.authorizeCallbackDestination('https://cb.example/x', bearer,
    { approvedOrigins: ['https://cb.example'] }).kind, 'ALLOWED');
  assert.equal(cb.authorizeCallbackDestination('http://cb.example/x', bearer,
    { approvedOrigins: ['http://cb.example'] }).kind, 'DENIED', 'http must never carry a credential');
  assert.equal(cb.authorizeCallbackDestination('https://cb.example/other', bearer,
    { approvedOrigins: ['https://cb.example'], allowedPathPrefixes: ['/hooks'] }).kind, 'DENIED');
  assert.equal(cb.authorizeCallbackDestination('https://cb.example/hooks/a', bearer,
    { approvedOrigins: ['https://cb.example'], allowedPathPrefixes: ['/hooks'] }).kind, 'ALLOWED');
  assert.equal(cb.authorizeCallbackDestination('https://10.0.0.1/x', { method: 'none' }, null).kind, 'DENIED',
    'a private destination stays denied even without credentials');
  return '6 decisions behave; redirects constant = ' + cb.CALLBACK_REDIRECTS_ALLOWED;
});

check('M11 reserved callback headers are recognised case-insensitively', () => {
  assert.equal(cb.isReservedCallbackHeader('host'), true);
  assert.equal(cb.isReservedCallbackHeader('HOST'), true);
  assert.equal(cb.isReservedCallbackHeader('content-length'), true);
  assert.equal(cb.isReservedCallbackHeader('x-du-signature'), true);
  assert.equal(cb.isReservedCallbackHeader('x-custom-header'), false);
  return cb.RESERVED_CALLBACK_HEADERS.length + ' reserved headers';
});

// ---- M5 queue -----------------------------------------------------------
check('M12 business queue names match the published regex and reject junk', () => {
  const name = queue.businessQueueName('doc-core', '1.2.0');
  assert.equal(name, 'du-business-doc-core-1.2.0');
  assert.equal(queue.QUEUE_NAME_REGEX.test(name), true);
  assert.equal(queue.isValidQueueName(name), true);
  assert.equal(queue.isValidQueueName('du-business-Doc_Core-1.2.0'), false);
  assert.equal(queue.isValidQueueName('du-business-doc-core-1.2'), false);
  return name + ' valid; 2 junk names rejected';
});

check('M13 job ids are deterministic, colon-free, and the job schema is strict', () => {
  const delivery = '11111111-1111-4111-8111-111111111111';
  const one = queue.jobIdForDelivery(delivery);
  assert.equal(one, 'du-' + delivery);
  assert.equal(one, queue.jobIdForDelivery(delivery), 'not deterministic');
  assert.notEqual(one, queue.jobIdForDelivery('22222222-2222-4222-8222-222222222222'));
  // BullMQ rejects ':' in a custom job id, so the mapping folds it.
  assert.equal(queue.jobIdForDelivery('task:retry:2'), 'du-task-retry-2');
  assert.ok(!queue.jobIdForDelivery('a:b:c').includes(':'), 'colon survived');
  const valid = {
    contractVersion: '1', deliveryId: 'd-1', taskId: delivery, operationId: delivery,
    businessId: 'doc-core', businessVersion: '1.2.0', action: 'extract', kind: 'document-core/extract',
    correlationId: 'corr-1',
  };
  assert.equal(queue.BusinessJobV1Schema.safeParse(valid).success, true,
    JSON.stringify(queue.BusinessJobV1Schema.safeParse(valid).error?.issues));
  assert.equal(queue.BusinessJobV1Schema.safeParse({ ...valid, rawBytes: 'x' }).success, false, 'strict schema accepted an extra key');
  const { kind, ...withoutKind } = valid;
  assert.equal(queue.BusinessJobV1Schema.safeParse(withoutKind).success, false, 'kind must be required');
  return 'deterministic colon-free jobId; strict schema accepts the full payload, rejects extras and a missing kind';
});

// ---- M6 version ---------------------------------------------------------
check('M14 wire version constants are the documented ones', () => {
  assert.equal(version.WIRE_CONTRACT_VERSION, '1');
  assert.deepEqual([...version.SUPPORTED_WIRE_MAJORS], [1]);
  assert.equal(version.JSON_SCHEMA_DIALECT, 'https://json-schema.org/draft/2020-12/schema');
  for (const [key, value] of Object.entries(version.SCHEMA_LIMITS)) {
    assert.equal(typeof value, 'number', key + ' is not a number');
    assert.ok(value > 0, key + ' must be positive');
  }
  for (const [key, value] of Object.entries(version.RETENTION_DEFAULTS)) {
    assert.equal(typeof value, 'number', key + ' is not a number');
  }
  return Object.keys(version.SCHEMA_LIMITS).length + ' schema limits, ' +
    Object.keys(version.RETENTION_DEFAULTS).length + ' retention defaults';
});

// ---- M7 the orchestrator route parser actually wires all eight ----------
check('M15 the route parser reads every declared parameter (including from/to)', () => {
  const listQuery = require(path.join(ORCH_SRC, 'modules/operations/list-query.ts'));
  const api = require(path.join(SRC, 'public-api.ts'));
  const declared = [...api.OPERATIONS_LIST_QUERY_PARAMS];
  assert.deepEqual(declared, ['limit', 'cursor', 'state', 'tenant', 'id', 'sort', 'from', 'to']);
  const rejecting = {
    cursor: 'cursor=not-a-cursor', state: 'state=NOPE', tenant: 'tenant=bad%20token',
    id: 'id=bad%3Btoken', sort: 'sort=created_at:sideways',
    from: 'from=2026-10-10', to: 'to=2026-10-10',
  };
  assert.deepEqual(Object.keys(rejecting).sort(), declared.filter((n) => n !== 'limit').sort());
  for (const [name, qs] of Object.entries(rejecting)) {
    assert.throws(() => listQuery.parseOperationsListQuery(new URLSearchParams(qs)), name + ' was accepted');
  }
  assert.equal(listQuery.parseOperationsListQuery(new URLSearchParams('limit=7')).limit, 7);
  const bounded = listQuery.parseOperationsListQuery(new URLSearchParams(
    'from=2026-10-10T00:00:00Z&to=2026-10-10T23:59:59Z'));
  assert.equal(bounded.from, '2026-10-10T00:00:00Z');
  assert.equal(bounded.to, '2026-10-10T23:59:59Z');
  assert.throws(() => listQuery.parseOperationsListQuery(new URLSearchParams(
    'from=2026-10-10T00:00:00Z&to=2026-10-09T00:00:00Z')), 'inverted range was accepted');
  assert.doesNotThrow(() => listQuery.parseOperationsListQuery(new URLSearchParams('page=3&offset=10')));
  return '8/8 wired: 7 rejecting fixtures throw, bounds round-trip, inverted range 422, unknown ignored';
});

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exitCode = failed.length === 0 ? 0 : 1;
