/* DSH2 independent probe for AWEB-20 filter consistency + cursor reset.
   READ-ONLY: loads the working-tree TypeScript source of the admin-web
   operations state module through a transpile hook and re-derives the claims
   from the source. Writes nothing to the repo. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WEB = 'D:/Git/dugate/du-rework/orchestrator/apps/admin-web';
const ts = require(path.join(WEB, 'node_modules/typescript/lib/typescript.js'));

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

const state = require(path.join(WEB, 'src/features/operations/state.ts'));
const SCREEN = fs.readFileSync(path.join(WEB, 'src/features/operations/operations-screen.tsx'), 'utf8');

const base = { limit: '20', state: 'ALL', tenantId: 'tenant-a', id: '', cursor: null, fromDate: '', toDate: '' };
const q = (v) => state.buildOperationsQuery({ ...base, ...v });
const p = (v) => state.operationsPopulation({ ...base, ...v });

// ---- A. fingerprint bounds ---------------------------------------------
check('A1 every population field changes the fingerprint; a bare re-render does not', () => {
  assert.equal(p({}), p({}), 'identical inputs must give an identical fingerprint');
  const fields = [
    ['state', { state: 'RUNNING' }], ['tenantId', { tenantId: 'tenant-b' }], ['id', { id: 'abc' }],
    ['fromDate', { fromDate: '2026-10-01' }], ['toDate', { toDate: '2026-10-10' }], ['limit', { limit: '50' }],
  ];
  for (const [name, v] of fields) assert.notEqual(p({}), p(v), name + ' must shape the fingerprint');
  return fields.length + ' fields shape it; stable otherwise';
});

check('A2 the fingerprint matches the wire for every shaping field (no missed, no invented change)', () => {
  const variants = [
    ['state', { state: 'RUNNING' }], ['tenantId', { tenantId: 'tenant-b' }], ['id', { id: 'abc' }],
    ['fromDate', { fromDate: '2026-10-01' }], ['toDate', { toDate: '2026-10-10' }], ['limit', { limit: '50' }],
    ['cursor only', { cursor: 'CURSOR' }],
  ];
  const report = [];
  for (const [name, v] of variants) {
    const queryChanged = JSON.stringify(q({})) !== JSON.stringify(q(v));
    const populationChanged = p({}) !== p(v);
    if (name === 'cursor only') {
      assert.equal(queryChanged, true, 'cursor must reach the wire');
      assert.equal(populationChanged, false, 'a cursor must not change the population it lives in');
    } else {
      assert.equal(queryChanged, true, name + ' must reach the wire');
      assert.equal(populationChanged, true, name + ' must invalidate the fingerprint');
    }
    report.push(name + (populationChanged ? '=pop' : '=nocursor'));
  }
  return report.join(' ');
});

check('A3 the one asymmetry: ALL and an empty state differ in the fingerprint but not on the wire', () => {
  assert.deepEqual(q({ state: '' }), q({ state: 'ALL' }), 'both mean no state filter on the wire');
  assert.notEqual(p({ state: '' }), p({ state: 'ALL' }), 'the fingerprint is the stricter of the two');
  return 'benign: an ALL<->empty switch drops a live cursor without changing the query';
});

check('A4 absent and empty tenant are one population (and one wire shape)', () => {
  assert.deepEqual(q({ tenantId: null }), q({ tenantId: '' }));
  assert.equal(p({ tenantId: null }), p({ tenantId: '' }));
  return 'null and empty agree on both sides';
});

check('A5 id is trimmed on both sides, so whitespace does not churn the cursor', () => {
  assert.equal(q({ id: ' op_9 ' })['id'], 'op_9');
  assert.equal(p({ id: ' op_9 ' }), p({ id: 'op_9' }));
  assert.notEqual(p({ id: 'op_9' }), p({ id: '' }));
  return 'trim agrees; a real id still shapes the population';
});

// ---- B. staleness rule --------------------------------------------------
check('B1 the staleness rule is exactly: live cursor + different origin', () => {
  const a = p({});
  const b = p({ tenantId: 'tenant-b' });
  assert.equal(state.operationsCursorIsStale(null, 'anything', 'other'), false, 'no cursor can never be stale');
  assert.equal(state.operationsCursorIsStale('c', a, a), false, 'same population keeps paging');
  assert.equal(state.operationsCursorIsStale('c', a, b), true, 'tenant A -> tenant B must drop the cursor');
  assert.equal(state.operationsCursorIsStale('c', null, a), true, 'unknown origin fails safe');
  for (const v of [{ state: 'FAILED' }, { fromDate: '2026-10-01' }, { toDate: '2026-10-10' }, { id: 'x' }, { limit: '50' }]) {
    assert.equal(state.operationsCursorIsStale('c', a, p(v)), true, JSON.stringify(v) + ' must drop the cursor');
  }
  return 'null/same/different/unknown + 5 field changes behave';
});

// ---- C. screen wiring ---------------------------------------------------
check('C1 setCursor survives in exactly three places (state, setter, effect)', () => {
  const mentions = [...SCREEN.matchAll(/setCursor/g)].map((m) => SCREEN.slice(0, m.index).split('\n').length);
  const calls = [...SCREEN.matchAll(/setCursor\(/g)].map((m) => SCREEN.slice(0, m.index).split('\n').length);
  assert.equal(mentions.length, 3, 'setCursor mentions: ' + JSON.stringify(mentions));
  assert.equal(calls.length, 2, 'setCursor calls: ' + JSON.stringify(calls));
  assert.match(SCREEN, /const \[cursor, setCursor\] = useState<string \| null>\(null\);/);
  assert.match(SCREEN, /mintedPopulation\.current = next === null \? null : selectedPopulation;\s*\n\s*setCursor\(next\);/);
  assert.match(SCREEN, /mintedPopulation\.current = null;\s*\n\s*setCursor\(null\);/);
  return 'mentions ' + mentions.join(', ') + '; calls ' + calls.join(', ') + ' (declaration is not a call)';
});

check('C2 all eight cursor-assignment paths go through applyCursor', () => {
  const calls = [...SCREEN.matchAll(/applyCursor\(/g)].length;
  assert.equal(calls, 8, 'expected 8 call sites, saw ' + calls);
  assert.match(SCREEN, /const applyCursor = useCallback\(\(next: string \| null\): void => \{/);
  for (const anchor of [
    /onChange=\{\(e\) => \{ applyCursor\(null\); setStateFilter\(e\.target\.value\); \}\}/,
    /onChange=\{e => \{ applyCursor\(null\); setLimit\(e\.target\.value\); \}\}/,
    /onChange=\{\(e\) => \{ applyCursor\(null\); setIdFilter\(e\.target\.value\); \}\}/,
    /onChange=\{\(e\) => \{ applyCursor\(null\); setFromDate\(e\.target\.value\); \}\}/,
    /onChange=\{\(e\) => \{ applyCursor\(null\); setToDate\(e\.target\.value\); \}\}/,
    /applyCursor\(page\.data\.prevCursor\)/,
    /applyCursor\(page\.data\.nextCursor\)/,
    /onClick=\{\(\) => applyCursor\(null\)\}>Newest</,
  ]) assert.match(SCREEN, anchor, 'missing path: ' + anchor);
  return '5 filters + Previous + Next + Newest all routed';
});

check('C3 applyCursor records the population it minted, and clears it when it clears the cursor', () => {
  assert.match(SCREEN, /mintedPopulation\.current = next === null \? null : selectedPopulation;/);
  assert.match(SCREEN, /const mintedPopulation = useRef<string \| null>\(null\);/);
  assert.match(SCREEN, /useCallback\(\(next: string \| null\): void => \{[\s\S]*?\}, \[selectedPopulation\]\);/,
    'the setter must close over the selected population');
  return 'ref set/cleared + dependency on selectedPopulation';
});

check('C4 the staleness effect clears both the cursor and its recorded origin', () => {
  assert.match(SCREEN, /if \(operationsCursorIsStale\(cursor, mintedPopulation\.current, selectedPopulation\)\) \{/);
  assert.match(SCREEN, /mintedPopulation\.current = null;\s*\n\s*setCursor\(null\);/);
  assert.match(SCREEN, /\}, \[cursor, selectedPopulation\]\);/);
  return 'effect guards on both deps and resets both';
});

check('C5 selectedPopulation is built from exactly the six shaping fields', () => {
  const block = /const selectedPopulation = operationsPopulation\(\{([\s\S]*?)\}\);/.exec(SCREEN);
  assert.ok(block, 'selectedPopulation not found');
  const body = block[1];
  for (const field of ['state: stateFilter', 'tenantId: globalTenantId ?? null', 'id: idFilter',
    'fromDate', 'toDate', 'limit']) {
    assert.ok(body.includes(field), 'missing ' + field + ' in: ' + body.replace(/\s+/g, ' '));
  }
  assert.ok(!/cursor/.test(body), 'the cursor must not be part of its own population');
  return 'six fields, no cursor';
});

// ---- D. residual observation: request ordering -------------------------
check('D1 (observation) the load effect is declared BEFORE the staleness effect', () => {
  const loadEffect = SCREEN.indexOf('useEffect(() => {\n    void load();\n  }, [load]);');
  const staleEffect = SCREEN.indexOf('if (operationsCursorIsStale(cursor, mintedPopulation.current, selectedPopulation))');
  assert.ok(loadEffect > 0 && staleEffect > 0, 'anchors missing');
  assert.ok(loadEffect < staleEffect, 'ordering changed - re-read this observation');
  return 'load effect at byte ' + loadEffect + ' runs before the reset at ' + staleEffect;
});

check('D2 (observation) the stale response cannot win: load() is sequence-guarded', () => {
  assert.match(SCREEN, /const seq = \+\+listRequest\.current;/);
  assert.match(SCREEN, /if \(seq !== listRequest\.current\) return;/);
  assert.match(SCREEN, /cursor,\s*\n\s*fromDate,\s*\n\s*toDate,\s*\n\s*\}\)\);/);
  assert.match(SCREEN, /\}, \[client, stateFilter, globalTenantId, idFilter, cursor, limit, fromDate, toDate\]\);/);
  return 'seq guard present; cursor is a load dependency so the corrected page is refetched';
});

const failed = results.filter((r) => !r.pass);
for (const r of results) console.log((r.pass ? 'ok   ' : 'FAIL ') + r.name + (r.detail ? ' :: ' + r.detail : ''));
console.log('PROBE_RESULT ' + (results.length - failed.length) + '/' + results.length + ' checks passed');
process.exitCode = failed.length === 0 ? 0 : 1;
