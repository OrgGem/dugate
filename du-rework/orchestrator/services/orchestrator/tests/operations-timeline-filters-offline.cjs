// Fail-first harness for OPU-OPS-1 (download link) + OPU-OPS-2 (live elapsed)
// + OPU-OPS-3 (timeline + correlationId) + OPU-OPS-4 (time filter, id search,
// multi-select bulk cancel) on the Operations screen.
// Plain .cjs - run with: node tests/operations-timeline-filters-offline.cjs
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

function makeHarness(pageItems, detailOverride) {
  const calls = [];
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
    listOperations: async (q) => { calls.push({ kind: 'list', q }); return { ok: true, data: { items: pageItems, total: pageItems.length, limit: 20 } }; },
    getOperation: async () => ({ ok: true, data: detailOverride ?? {
      operation: pageItems[0],
      artifacts: [
        { role: 'output', status: 'READY', downloadUrl, contentType: 'text/markdown' },
        { role: 'input', status: 'READY', downloadUrl: null, contentType: 'application/pdf' },
      ],
      tasks: [],
      serverNow: new FakeDate().toISOString(),
    } }),
    operationAction: async (id, action) => { calls.push({ kind: 'action', id, action }); return { ok: true, data: { state: 'CANCELLED' } }; },
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
    crypto: { randomUUID: () => 'k' + Math.random().toString(16).slice(2) },
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
  return { sandbox, timers, render, clock, calls };
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
// Column lookup by header text, never by position: Lane C's Select column shifts a hardcoded index.
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

  // ---- Lane C: OPU-OPS-3 timeline + correlationId, OPU-OPS-4 filters + bulk cancel ----
  const RUN = 'aaaaaaaa-1111-4111-8111-111111111111';
  const OLD = 'bbbbbbbb-2222-4222-8222-222222222222';
  const cItems = [
    { id: RUN, state: 'RUNNING', createdAt: '2026-10-08T10:00:00.000Z', action: 'extract' },
    { id: OLD, state: 'FAILED', createdAt: '2026-10-07T09:00:00.000Z', completedAt: '2026-10-07T09:00:00.000Z', errorCode: 'PROVIDER_TIMEOUT', action: 'extract' },
  ];
  const cDetail = {
    operation: { ...cItems[0], correlationId: 'corr-abc-123' },
    artifacts: [],
    tasks: [{ id: 't1', taskKey: 'root', kind: 'root', state: 'FAILED', attempt: 2, maxAttempts: 3, errorCode: 'PROVIDER_TIMEOUT' }],
    serverNow: '2026-10-08T10:00:00.000Z',
  };
  const h = makeHarness(cItems, cDetail);
  await h.render();
  let t = (await h.render()).tree;

  await check('OPS-4: toolbar renders an id search input', () => {
    const input = find(t, (n) => n.type === 'input' && /id/i.test(String(n.props['aria-label'] || '')));
    assert.ok(input, 'no id-search input in the toolbar');
  });
  await check('OPS-4: toolbar renders from/to date inputs', () => {
    const labels = collect(t, (n) => n.type === 'input').map((n) => String(n.props['aria-label'] || ''));
    assert.ok(labels.some((l) => /^from/i.test(l)), `no From input, labels=${JSON.stringify(labels)}`);
    assert.ok(labels.some((l) => /^to/i.test(l)), `no To input, labels=${JSON.stringify(labels)}`);
  });
  await check('OPS-4: typing an id substring re-queries the list with id', async () => {
    const input = find(t, (n) => n.type === 'input' && /id/i.test(String(n.props['aria-label'] || '')));
    assert.ok(input, 'no id-search input to type into');
    const before = h.calls.filter((c) => c.kind === 'list').length;
    input.props.onChange({ target: { value: 'bbbb' } });
    await new Promise((r) => setImmediate(r));
    await h.render();
    const lists = h.calls.filter((c) => c.kind === 'list');
    assert.ok(lists.length > before, 'typing an id did not trigger a list call');
    assert.equal(lists[lists.length - 1].q.id, 'bbbb', `last query=${JSON.stringify(lists[lists.length - 1].q)}`);
  });
  t = (await h.render()).tree;
  await check('OPS-4: a from/to window filters the loaded page', async () => {
    const inputs = collect(t, (n) => n.type === 'input');
    const from = inputs.find((n) => /^from/i.test(String(n.props['aria-label'] || '')));
    const to = inputs.find((n) => /^to/i.test(String(n.props['aria-label'] || '')));
    assert.ok(from && to, `from/to inputs missing (${inputs.length} inputs)`);
    from.props.onChange({ target: { value: '2026-10-08' } });
    await new Promise((r) => setImmediate(r));
    t = (await h.render()).tree;
    const to2 = collect(t, (n) => n.type === 'input').find((n) => /^to/i.test(String(n.props['aria-label'] || '')));
    to2.props.onChange({ target: { value: '2026-10-08' } });
    await new Promise((r) => setImmediate(r));
    const next = (await h.render()).tree;
    const rows = collect(next, (n) => n.type && n.type.name === 'TableRow' && textOf(n).includes('\u2026'));
    assert.ok(rows.some((r2) => textOf(r2).includes(RUN.slice(0, 8))), 'in-window row disappeared');
    assert.ok(!rows.some((r2) => textOf(r2).includes(OLD.slice(0, 8))), 'out-of-window row still rendered');
  });
  t = (await h.render()).tree;
  await check('OPS-4: rows expose selection checkboxes and a bulk cancel control', () => {
    const boxes = collect(t, (n) => n.type === 'input' && n.props.type === 'checkbox');
    assert.ok(boxes.length >= 1, `no selection checkbox, saw ${boxes.length}`);
    const bulk = find(t, (n) => (n.type === 'button' || n.type.name === 'Button') && /cancel selected/i.test(textOf(n)));
    assert.ok(bulk, 'no bulk cancel control');
  });
  await check('OPS-4: bulk cancel sends one cancel per selected non-terminal row', async () => {
    const boxes = collect(t, (n) => n.type === 'input' && n.props.type === 'checkbox');
    const target = boxes.find((b) => String(b.props['aria-label'] || '').includes(RUN.slice(0, 8)));
    assert.ok(target, 'no checkbox bound to the running row');
    target.props.onChange({ target: { checked: true } });
    await new Promise((r) => setImmediate(r));
    const next = (await h.render()).tree;
    const bulk = find(next, (n) => (n.type === 'button' || n.type.name === 'Button') && /cancel selected/i.test(textOf(n)));
    assert.ok(bulk && bulk.props.disabled !== true, 'bulk cancel stayed disabled after selecting a row');
    await bulk.props.onClick();
    await new Promise((r) => setImmediate(r));
    const cancels = h.calls.filter((c) => c.kind === 'action' && c.action === 'cancel');
    assert.equal(cancels.length, 1, `expected 1 cancel call, saw ${cancels.length}`);
    assert.equal(cancels[0].id, RUN, `cancelled ${cancels[0].id}`);
  });

  t = (await h.render()).tree;
  await check('OPS-3: detail renders the correlationId from the payload', async () => {
    const btn = find(t, (n) => n.type === 'button' && textOf(n).includes(RUN.slice(0, 8)));
    assert.ok(btn, 'row id button not clickable');
    await btn.props.onClick();
    await new Promise((r) => setImmediate(r));
    const next = (await h.render()).tree;
    t = next; // bind the detail tree BEFORE asserting, so the timeline check below is independent
    // Scoped to the correlation block: the id must render THERE, not merely
    // somewhere in the tree (an unrelated node could carry the same text).
    const row = find(next, (n) => n.props && n.props['aria-label'] === 'Operation correlation');
    assert.ok(row, 'no correlation row rendered at all');
    assert.ok(textOf(row).includes('corr-abc-123'), 'correlationId not rendered in the correlation row');
  });
  await check('OPS-3: detail renders a timeline with task/state/attempt/errorCode', () => {
    const list = find(t, (n) => n.props && n.props['aria-label'] === 'Operations timeline');
    assert.ok(list, 'no operations timeline element');
    const text = textOf(list);
    assert.ok(/root/.test(text), `timeline missing task key: ${text}`);
    assert.ok(/attempt\s*2\s*\/\s*3/i.test(text), `timeline missing attempt 2/3: ${text}`);
    assert.ok(/PROVIDER_TIMEOUT/.test(text), `timeline missing error code: ${text}`);
  });

  const h2 = makeHarness(cItems, { operation: cItems[0], artifacts: [], tasks: [], serverNow: '2026-10-08T10:00:00.000Z' });
  await h2.render();
  let t2 = (await h2.render()).tree;
  await check('OPS-3: missing correlationId renders Unavailable (never blank)', async () => {
    const btn = find(t2, (n) => n.type === 'button' && textOf(n).includes(RUN.slice(0, 8)));
    assert.ok(btn, 'row id button not clickable (no-correlation scenario)');
    await btn.props.onClick();
    await new Promise((r) => setImmediate(r));
    t2 = (await h2.render()).tree;
    // Scoped to the correlation block: an empty timeline also renders the word
    // "Unavailable", so a tree-wide check could pass for the wrong reason.
    const row = find(t2, (n) => n.props && n.props['aria-label'] === 'Operation correlation');
    assert.ok(row, 'no correlation row rendered at all');
    assert.ok(textOf(row).includes('Unavailable'), 'missing correlationId did not render Unavailable');
  });

  if (failures.length > 0) {
    console.log(`FAILED ${failures.length} assertion(s): ${failures.join(' | ')}`);
    process.exitCode = 1;
    return;
  }
  console.log('PASS operations-timeline-filters-offline.cjs - 15 assertions (OPS-1 x2, OPS-2 x4, OPS-4 x6, OPS-3 x3)');
}

main().catch((error) => { console.error(error && error.stack ? error.stack : error); process.exitCode = 1; });