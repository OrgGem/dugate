/* DSH2 independent probe for the contracts operations-list alignment.
   READ-ONLY: loads the working-tree TypeScript source of packages/contracts
   through a transpile hook, so the assertions are about the source, not dist. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTRACTS = 'D:/Git/dugate/du-rework/orchestrator/packages/contracts';
const ts = require(path.join(CONTRACTS, 'node_modules/typescript/lib/typescript.js'));

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

const api = require(path.join(CONTRACTS, 'src/public-api.ts'));
const schema = api.ListOperationsQuerySchema;

check('P1 the allow-list is exactly the eight documented parameters, in order', () => {
  assert.deepEqual([...api.OPERATIONS_LIST_QUERY_PARAMS],
    ['limit', 'cursor', 'state', 'tenant', 'id', 'sort', 'from', 'to']);
  return api.OPERATIONS_LIST_QUERY_PARAMS.length + ' parameters';
});

check('P2 the schema key set cannot drift from the allow-list', () => {
  const keys = Object.keys(schema.shape).sort();
  assert.deepEqual(keys, [...api.OPERATIONS_LIST_QUERY_PARAMS].sort());
  return 'schema keys === allow-list (' + keys.length + ')';
});

check('P3 valid UTC instants are accepted on both bounds', () => {
  const ok = schema.safeParse({ from: '2026-10-10T00:00:00Z', to: '2026-10-10T23:59:59Z' });
  assert.equal(ok.success, true, JSON.stringify(ok.error?.issues));
  const withMillis = schema.safeParse({ from: '2026-10-10T00:00:00.000Z', to: '2026-10-10T23:59:59.999Z' });
  assert.equal(withMillis.success, true, 'millisecond precision must be accepted');
  const micros = schema.safeParse({ from: '2026-10-10T00:00:00.123456Z' });
  assert.equal(micros.success, true, 'six fractional digits must be accepted');
  return 'Z instants, millis and microseconds accepted';
});

check('P4 a date-only value and a non-UTC offset are refused', () => {
  for (const bad of ['2026-10-10', '2026-10-10T00:00:00', '2026-10-10T00:00:00+07:00',
    '2026-13-01T00:00:00Z', 'not-a-date']) {
    const parsed = schema.safeParse({ from: bad });
    assert.equal(parsed.success, false, 'accepted: ' + bad);
  }
  const message = schema.safeParse({ from: '2026-10-10' }).error.issues[0].message;
  assert.match(String(message), /UTC ISO timestamp/, 'message=' + message);
  return '5 malformed values refused with the documented message';
});

check('P5 an empty string is tolerated (the route treats it as absent)', () => {
  const parsed = schema.safeParse({ from: '', to: '' });
  assert.equal(parsed.success, true, JSON.stringify(parsed.error?.issues));
  return 'blank bounds pass the schema; the route decides the semantics';
});

check('P6 an inverted range is NOT the schema business (documented split of duties)', () => {
  const inverted = schema.safeParse({ from: '2026-10-10T00:00:00Z', to: '2026-10-09T00:00:00Z' });
  assert.equal(inverted.success, true, 'schema unexpectedly rejects an inverted range');
  assert.equal(typeof api.compareAdminListTimeBounds, 'function', 'the comparator must exist for the route');
  assert.ok(api.compareAdminListTimeBounds('2026-10-10T00:00:00Z', '2026-10-09T00:00:00Z') > 0);
  assert.ok(api.compareAdminListTimeBounds('2026-10-10T00:00:00.000001Z', '2026-10-10T00:00:00.000000Z') > 0,
    'microseconds must not be truncated');
  return 'schema accepts, comparator (used by the route) orders';
});

check('P7 the six pre-existing parameters keep their behaviour (and the two caps stay distinct)', () => {
  assert.equal(schema.safeParse({}).success, true, 'an empty query must stay valid');
  assert.equal(api.OPERATIONS_LIST_LIMIT_MAX, 100, 'the public operations list cap is 100');
  assert.equal(schema.safeParse({ limit: String(api.OPERATIONS_LIST_LIMIT_MAX) }).success, true, 'limit 100 must pass');
  assert.equal(schema.safeParse({ limit: '101' }).success, false, 'limit 101 must fail');
  assert.equal(schema.safeParse({ sort: 'created_at:desc' }).success, true);
  assert.equal(schema.safeParse({ sort: 'evil:desc' }).success, false);
  // The admin resource lists use a DIFFERENT cap (200); the public list schema must not adopt it.
  assert.equal(api.ADMIN_LIST_LIMIT_MAX, 200);
  assert.equal(schema.safeParse({ limit: String(api.ADMIN_LIST_LIMIT_MAX) }).success, false,
    'the public list schema must not accept the admin cap');
  return 'empty/limit<=100/sort unchanged; public cap 100 vs admin cap 200 kept apart';
});

check('P8 the built dist carries the same eight parameters (consumers import dist)', () => {
  const distFile = path.join(CONTRACTS, 'dist/public-api.js');
  assert.ok(fs.existsSync(distFile), 'dist/public-api.js missing');
  const dist = require(distFile);
  assert.deepEqual([...dist.OPERATIONS_LIST_QUERY_PARAMS], [...api.OPERATIONS_LIST_QUERY_PARAMS],
    'dist drifted from src');
  const distSrc = fs.readFileSync(distFile, 'utf8');
  assert.ok(distSrc.includes("'from'") && distSrc.includes("'to'"), 'dist has no from/to');
  const srcStat = fs.statSync(path.join(CONTRACTS, 'src/public-api.ts'));
  const distStat = fs.statSync(distFile);
  assert.ok(distStat.mtimeMs >= srcStat.mtimeMs, 'dist older than src: ' + distStat.mtime + ' vs ' + srcStat.mtime);
  return 'dist in sync; dist newer than src';
});

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exitCode = failed.length === 0 ? 0 : 1;
