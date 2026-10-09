// Fail-first harness for OPU-OPS-1 (download link) + OPU-OPS-2 (live elapsed).
// Plain .cjs - run with: node tests/operations-download-live-offline.cjs
// (jest.unit.config.cjs testMatch is ts-only, so it never collects this file.)
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '../../../apps/admin-web/src/features/operations');
const screenSource = fs.readFileSync(path.join(ROOT, 'operations-screen.tsx'), 'utf8');
const stateSource = fs.readFileSync(path.join(ROOT, 'state.ts'), 'utf8');
const compile = (src) => ts.transpileModule(src, {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React, target: ts.ScriptTarget.ES2020 },
}).outputText;

const downloadUrl = '/api/v1/operations/11111111-1111-4111-8111-111111111111/download';
const runningId = 'aaaaaaaa-1111-4111-8111-111111111111';
const unknownStartId = 'bbbbbbbb-1111-4111-8111-111111111111';
const detailId = '11111111-1111-4111-8111-111111111111';
const T0 = '2026-10-08T10:00:00.000Z';

function wire(id, state, createdAt, completedAt) {
  return { id, state, createdAt, completedAt, action: 'extract', businessId: 'document-core' };
}

function makeHarness(pageItems) {
  const clock = { now: Date.parse(T0) };
  class FakeDate extends Date {
    constructor(...args) { if (args.length === 0) super(clock.now); else super(...args); }
    static now() { return clock.now; }
  }
  const timers = [];
  const state = [];
  const deps = [];
  const effects = [];
  let cursor = 0;
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => { const i = cursor++; if (!(i in state)) state[i] = typeof initial === 'function' ? initial() : initial;
      return [state[i], (value) => { state[i] = value; }]; },
    useRef: (initial) => { const i = cursor++; if (!(i in state)) state[i] = { current: initial }; return state[i]; },
    useMemo: (fn, next) => { const i = cursor++; if (!(i in state) || (next && next.some((v, j) => v !== deps[i][j]))) { state[i] = fn(); if (next) deps[i] = next; } return state[i]; },
    useCallback: (fn, next) => { const i = cursor++; if (!(i in state) || next.some((v, j) => v !== deps[i][j])) { state[i] = fn; deps[i] = next; } return state[i]; },
    useEffect: (fn, next) => { const i = cursor++; const changed = !(i in deps) || !next || next.some((v, j) => v !== deps[i][j]);
      if (changed) { deps[i] = next; effects.push(fn); } },
  };
  const ui = (names) => { const o = {}; for (const n of names) { const fn = function () {}; Object.defineProperty(fn, 'name', { value: n }); o[n] = fn; } return o; };
  const client = {
    getSession: async () => ({ ok: true, data: { role: 'admin' } }),
    listOperations: async () => ({ ok: true, data: { items: pageItems, total: pageItems.length, limit: 20 } }),
    getOperation: async () => ({ ok: true, data: {
      operation: pageItems[0],
      artifacts: [
        { role: 'output', status: 'READY', downloadUrl, contentType: 'text/markdown' },
        { role: 'input', status: 'READY', downloadUrl: null, contentType: 'application/pdf' },
      ],
      tasks: [],
      serverNow: new FakeDate().toISOString(),
    } }),
    operationAction: async () => ({ ok: true, data: { state: 'CANCELLED' } }),
  };
  const sandbox = {
    exports: {},
    React: react,
    Date: FakeDate,
    console,
    setTimeout, clearTimeout,
    setInterval: (fn, ms) => { timers.push({ fn, ms, cleared: false }); return timers.length; },
    clearInterval: (id) => { if (timers[id - 1]) timers[id - 1].cleared = true; },
    setImmediate,
    require: (name) => {
      if (name === 'react') return react;
      if (name === './state') return stateExports;
      if (name === '@/lib/api') return { createAdminApiClient: () => client };
      if (name === '@/lib/tenant-context') return { useTenant: () => ({ selectedTenantId: '00000000-0000-0000-0000-000000000001', setSelectedTenantId: () => {} }) };
      if (name === '@/components/ui/badge') return ui(['Badge']);
      if (name === '@/components/ui/button') return ui(['Button']);
      if (name === '@/components/ui/card') return ui(['Card', 'CardContent', 'CardDescription', 'CardHeader', 'CardTitle']);
      if (name === '@/components/ui/state-panel') return ui(['DeniedState', 'EmptyState', 'ErrorState', 'LoadingState', 'AlertBanner']);
      if (name === '@/components/ui/tenant-select') return ui(['TenantSelect']);
      if (name === '@/components/ui/table') return ui(['Table', 'TableBody', 'TableCell', 'TableContainer', 'TableHead', 'TableHeader', 'TableRow']);
      return new Proxy({}, { get: (_, key) => key });
    },
  };
  const stateExports = {};
  sandbox.exports = stateExports;
  vm.runInNewContext(compile(stateSource), sandbox, { filename: 'state.ts' });
  const screenExports = {};
  sandbox.exports = screenExports;
  vm.runInNewContext(compile(screenSource), sandbox, { filename: 'operations-screen.tsx' });

  async function render() {
    cursor = 0;
    effects.length = 0; // drop leftovers, then compute the tree so fresh effects queue
    const tree = screenExports.OperationsScreen();
    const pending = effects.splice(0, effects.length);
    for (const effect of pending) effect();
    await new Promise((resolve) => setImmediate(resolve));
    return { tree };
  }
  return { sandbox, timers, render, clock };
}

function find(node, predicate) {
  if (!node || typeof node !== 'object') return undefined;
  if (Array.isArray(node)) return node.map((child) => find(child, predicate)).find(Boolean);
  if (predicate(node)) return node;
  return find(node.children, predicate);
}
function collect(node, predicate, out = []) {
  if (!node || typeof node !== 'object') return out;
  if (Array.isArray(node)) { for (const child of node) collect(child, predicate, out); return out; }
  if (predicate(node)) out.push(node);
  collect(node.children, predicate, out);
  return out;
}
function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (typeof node === 'object') return textOf(node.children);
  return '';
}

// Row lookup by the id-cell label the screen renders (first 8 chars + ellipsis).
function rowFor(tree, idPrefix) {
  const tables = collect(tree, (n) => n.type && n.type.name === 'TableRow');
  return tables.find((row) => textOf(row).includes(`${idPrefix}…`));
}
function cellTexts(row) {
  if (!row) return [];
  return collect(row, (n) => n.type && n.type.name === 'TableCell').map(textOf);
}
// Column lookup by header text, never by position: OPU-OPS-4 inserts a Select column ahead of it.
function columnIndex(tree, header) {
  const headers = collect(tree, (n) => n.type && n.type.name === 'TableHead').map((n) => textOf(n).trim());
  const index = headers.indexOf(header);
  assert.ok(index >= 0, 'no ' + JSON.stringify(header) + ' header; saw ' + JSON.stringify(headers));
  return index;
}

const failures = [];
async function check(name, fn) {
  try { await fn(); console.log(`ok   ${name}`); }
  catch (error) { failures.push(name); console.log(`FAIL ${name}`); console.log(String(error && error.message ? error.message : error)); }
}

async function main() {
  // Scenario 1: a running op (ticks), a non-terminal op with UNKNOWN start,
  // plus a terminal op that carries the downloadUrl in its detail.
  const liveItems = [
    wire(runningId, 'RUNNING', T0, null),
    wire(unknownStartId, 'WAITING_INPUT', null, null),
    wire(detailId, 'SUCCEEDED', T0, '2026-10-08T10:00:02.000Z'),
  ];
  const live = makeHarness(liveItems);
  await live.render();
  let { tree } = await live.render();

  await check('OPS-2: a 1s tick interval exists while a non-terminal op is shown', () => {
    const active = live.timers.filter((t) => !t.cleared);
    assert.ok(active.length >= 1, `expected >=1 active interval, saw ${active.length}`);
    assert.equal(active[0].ms, 1000, 'interval period must be 1000ms');
  });

  await check('OPS-2: unknown start renders Unknown, never a fabricated 0', () => {
    const elapsed = columnIndex(tree, 'Total elapsed');
    const cells = cellTexts(rowFor(tree, unknownStartId.slice(0, 8)));
    assert.ok(cells.length > elapsed, `expected >${elapsed} cells, saw ${cells.length}`);
    assert.equal(cells[elapsed], 'Unknown', `elapsed cell for unknown start was ${JSON.stringify(cells[elapsed])}`);
    assert.notEqual(cells[elapsed], '0.0 s', 'unknown start must never render 0.0 s');
  });

  await check('OPS-2: clock ticks without a manual refresh (the interval drives the elapsed text)', async () => {
    // Without a registered interval the only way this value could change is a
    // manual re-render, which is exactly what OPU-OPS-2 forbids.
    const active = live.timers.filter((t) => !t.cleared);
    assert.ok(active.length >= 1, `no interval registered while a non-terminal op is shown (saw ${active.length})`);
    const elapsed = columnIndex(tree, 'Total elapsed');
    const before = cellTexts(rowFor(tree, runningId.slice(0, 8)))[elapsed];
    live.clock.now += 5000;
    for (const timer of active) timer.fn();
    ({ tree } = await live.render());
    const after = cellTexts(rowFor(tree, runningId.slice(0, 8)))[elapsed];
    assert.equal(before, '0.0 s', `expected 0.0 s before tick, saw ${JSON.stringify(before)}`);
    assert.equal(after, '5.0 s', `expected 5.0 s after the interval fired, saw ${JSON.stringify(after)}`);
  });

  // Scenario 2: open the detail pane (click the row id button) for OPU-OPS-1.
  const idButton = find(tree, (n) => n.type === 'button' && textOf(n).includes(detailId.slice(0, 8)));
  assert.ok(idButton && typeof idButton.props.onClick === 'function', 'row id button is clickable');
  await idButton.props.onClick();
  await new Promise((resolve) => setImmediate(resolve)); // let openDetail settle setDetail
  ({ tree } = await live.render());

  const anchors = collect(tree, (n) => n.type === 'a');
  await check('OPS-1: artifact with downloadUrl renders a real download link', () => {
    const link = anchors.find((a) => a.props.href === downloadUrl);
    assert.ok(link, `no anchor with href ${downloadUrl}; saw ${JSON.stringify(anchors.map((a) => a.props.href))}`);
    assert.ok(link.props.download !== undefined && link.props.download !== false, 'anchor must carry the download attribute');
    assert.ok(textOf(link).trim().length > 0, 'anchor must have visible text');
  });
  await check('OPS-1: artifact without downloadUrl renders unavailable text, never a broken anchor', () => {
    assert.equal(anchors.length, 1, `expected exactly 1 anchor, saw ${JSON.stringify(anchors.map((a) => a.props.href))}`);
    assert.ok(anchors.every((a) => typeof a.props.href === 'string' && a.props.href.length > 0), 'no empty/broken anchor');
    const cells = collect(tree, (n) => n.type && n.type.name === 'TableCell').map(textOf);
    assert.ok(cells.some((text) => text.includes('Unavailable')), 'missing unavailable text for the no-url artifact');
  });

  // Scenario 3: every op terminal -> the tick must not start.
  const terminal = makeHarness([
    wire(detailId, 'SUCCEEDED', T0, '2026-10-08T10:00:02.000Z'),
    wire('cccccccc-1111-4111-8111-111111111111', 'FAILED', T0, '2026-10-08T10:00:04.000Z'),
  ]);
  await terminal.render();
  await terminal.render();
  await check('OPS-2: no interval starts when every op is terminal', () => {
    const active = terminal.timers.filter((t) => !t.cleared);
    assert.equal(active.length, 0, `expected 0 intervals, saw ${active.length}`);
  });

  if (failures.length > 0) {
    console.log(`FAILED ${failures.length} assertion(s): ${failures.join(' | ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS operations-download-live-offline.cjs - 6 assertions (OPU-OPS-1 x2, OPU-OPS-2 x4)');
}

main().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; });