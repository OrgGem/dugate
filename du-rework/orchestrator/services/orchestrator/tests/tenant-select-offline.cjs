// Offline element-tree harness for the REAL TenantSelect (F-4, test-only).
//
// Convention: services/orchestrator/tests/usage-screen-offline.cjs — the TSX is
// transpiled with `typescript` and executed in a `vm` context with a hand-rolled
// React hook shim. Difference that matters for F-4: that file replaces the
// component under test with `const TenantSelect = function TenantSelectMock() {}`
// (usage-screen-offline.cjs:10); this harness loads the REAL component module,
// so every assertion below runs against tenant-select.tsx itself.
//
// Limits (stated in the receipt, not hidden): this repo has NO DOM and NO
// component renderer (no jsdom / @testing-library / react-test-renderer /
// happy-dom — verified by a full-tree scan), so this asserts on the returned
// ELEMENT TREE, not on painted DOM. What base-ui paints for <SelectValue> is NOT
// covered; what IS covered: option labels are tenant NAMES, no raw tenant id can
// reach any text node, <SelectValue> receives no id and no children at all, and
// the loading/failed/empty/ready states come from the component's real logic.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SOURCE = path.resolve(
  __dirname,
  '../../../apps/admin-web/src/components/ui/tenant-select.tsx',
);
const compiled = ts.transpileModule(fs.readFileSync(SOURCE, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
}).outputText;

const ALL_TENANTS_VALUE = '__all_tenants__';
const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_UNKNOWN = '99999999-9999-4999-8999-999999999999';

const SELECT_TAGS = [
  'SelectRoot',
  'SelectTrigger',
  'SelectValue',
  'SelectPortal',
  'SelectPositioner',
  'SelectPopup',
  'SelectItem',
];
const selectModule = Object.fromEntries(SELECT_TAGS.map((tag) => [tag, tag]));

/** Flush the component's async load (a few macrotask ticks cover the page loop). */
async function flush() {
  for (let i = 0; i < 3; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/**
 * Build a harness around one stubbed `client.listTenants`. The component module
 * is the real one; only React's hooks and the API client are supplied.
 */
function build(listTenants) {
  const state = [];
  const deps = [];
  let cursor = 0;
  let effects = [];
  const calls = [];
  const client = {
    listTenants: async (query) => {
      calls.push(query);
      return listTenants(query);
    },
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const i = cursor++;
      if (!(i in state)) state[i] = initial;
      return [state[i], (value) => { state[i] = value; }];
    },
    useMemo: (fn) => {
      const i = cursor++;
      if (!(i in state)) state[i] = fn();
      return state[i];
    },
    useCallback: (fn, next) => {
      const i = cursor++;
      if (!deps[i] || next.some((value, j) => value !== deps[i][j])) {
        deps[i] = next;
        state[i] = fn;
      }
      return state[i];
    },
    useEffect: (fn, next) => {
      const i = cursor++;
      if (!deps[i] || next.some((value, j) => value !== deps[i][j])) {
        deps[i] = next;
        effects.push(fn);
      }
    },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    React: react,
    require: (name) => {
      if (name === 'react') return react;
      if (name === '@/lib/api') return { createAdminApiClient: () => client };
      if (name === './select') return selectModule;
      return new Proxy({}, { get: (_, key) => key });
    },
  });
  if (typeof exports.TenantSelect !== 'function') {
    throw new Error('tenant-select.tsx did not export TenantSelect');
  }

  /** Render once, run the effects that fired, flush, and return the tree. */
  async function render(props) {
    cursor = 0;
    effects = [];
    const tree = exports.TenantSelect(props);
    for (const effect of effects) effect();
    await flush();
    return tree;
  }

  /** Render twice: the second pass sees the state the load produced. */
  async function settle(props) {
    await render(props);
    return render(props);
  }

  return { render, settle, calls };
}

function walk(tree, visit) {
  if (!tree || typeof tree !== 'object') return;
  visit(tree);
  for (const child of tree.children.flat(Infinity)) walk(child, visit);
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

function find(tree, predicate) {
  return findAll(tree, predicate)[0];
}

/** Every string child in the tree, in document order. */
function textNodes(tree) {
  const out = [];
  walk(tree, (node) => {
    for (const child of node.children.flat(Infinity)) {
      if (typeof child === 'string') out.push(child);
    }
  });
  return out;
}

function baseProps(value, extra) {
  return {
    id: 'tenant-picker',
    value,
    onValueChange: () => {},
    ...extra,
  };
}

function okPage(items, nextCursor = null) {
  return { ok: true, data: { items, nextCursor } };
}

const scenarios = [];
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

// ---------------------------------------------------------------------------
// (a) roster present -> the option label is the tenant NAME, never the id
// ---------------------------------------------------------------------------
scenario('a: option labels are tenant names and no raw id reaches any text node', async () => {
  const harness = build(async () => okPage([
    { id: TENANT_A, name: 'Alpha', state: 'ACTIVE' },
    { id: TENANT_B, name: 'Beta', state: 'ACTIVE' },
  ]));
  const tree = await harness.settle(baseProps(TENANT_A));

  const options = findAll(tree, (node) => node.type === 'SelectItem');
  assert.equal(options.length, 2, 'two roster rows must produce two options');
  assert.deepEqual(
    options.map((option) => option.children.flat(Infinity).join('')),
    ['Alpha', 'Beta'],
    'option label is the tenant name',
  );
  assert.deepEqual(
    options.map((option) => option.props.value),
    [TENANT_A, TENANT_B],
    'the tenant id is the option VALUE only',
  );

  const text = textNodes(tree).join('|');
  assert.ok(text.includes('Alpha'), 'positive control: the label text really is in the tree');
  assert.ok(!text.includes(TENANT_A), 'raw tenant id must not appear in rendered text');
  assert.ok(!text.includes(TENANT_B), 'raw tenant id must not appear in rendered text');

  const selectValue = find(tree, (node) => node.type === 'SelectValue');
  assert.ok(selectValue, 'the trigger renders SelectValue');
  assert.deepEqual(selectValue.children, [], 'SelectValue gets no children, so it cannot print an id');
  assert.equal(selectValue.props.placeholder, 'Select a tenant', 'ready + non-empty roster -> Select a tenant');

  const root = find(tree, (node) => node.type === 'SelectRoot');
  assert.equal(root.props.value, TENANT_A, 'the selected value is the matching roster id');
  assert.equal(root.props.disabled, false, 'ready + non-empty roster -> enabled');
  assert.equal(find(tree, (node) => node.type === 'SelectItem' && node.props.value === ALL_TENANTS_VALUE), undefined,
    'allowAll is off by default, so there is no All tenants option');
});

// ---------------------------------------------------------------------------
// (b) non-ACTIVE state is shown in the label
// ---------------------------------------------------------------------------
scenario('b: a non-ACTIVE tenant is labelled with its state', async () => {
  const harness = build(async () => okPage([
    { id: TENANT_A, name: 'Alpha', state: 'ACTIVE' },
    { id: TENANT_B, name: 'Beta', state: 'SUSPENDED' },
  ]));
  const tree = await harness.settle(baseProps(null));

  const labels = findAll(tree, (node) => node.type === 'SelectItem')
    .map((option) => option.children.flat(Infinity).join(''));
  assert.deepEqual(labels, ['Alpha', 'Beta (SUSPENDED)'], 'ACTIVE stays bare, others get " (STATE)"');
});

// ---------------------------------------------------------------------------
// (c) value outside the roster -> nothing is silently selected
// ---------------------------------------------------------------------------
scenario('c: a value outside the roster selects nothing and never fires onValueChange', async () => {
  const harness = build(async () => okPage([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }]));
  const changes = [];
  const tree = await harness.settle(baseProps(TENANT_UNKNOWN, {
    onValueChange: (next) => changes.push(next),
  }));

  const root = find(tree, (node) => node.type === 'SelectRoot');
  assert.equal(root.props.value, null, 'an unknown value resolves to null, not to another tenant');
  assert.equal(find(tree, (node) => node.type === 'SelectValue').props.placeholder, 'Select a tenant');
  assert.deepEqual(changes, [], 'rendering never calls onValueChange by itself');

  // The change handler only propagates a value that is really in the roster.
  root.props.onValueChange(TENANT_UNKNOWN);
  assert.deepEqual(changes, [], 'an id outside the roster must not propagate');
  root.props.onValueChange(TENANT_A);
  assert.deepEqual(changes, [TENANT_A], 'a roster id propagates');
  root.props.onValueChange('not-in-roster-either');
  assert.deepEqual(changes, [TENANT_A], 'still nothing for an unknown id');

  // allowAll flips the sentinel: null <-> All tenants.
  const allHarness = build(async () => okPage([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }]));
  const allChanges = [];
  const allTree = await allHarness.settle(baseProps(null, {
    allowAll: true,
    onValueChange: (next) => allChanges.push(next),
  }));
  const allRoot = find(allTree, (node) => node.type === 'SelectRoot');
  assert.equal(allRoot.props.value, ALL_TENANTS_VALUE, 'allowAll + null renders the All tenants sentinel');
  assert.deepEqual(
    findAll(allTree, (node) => node.type === 'SelectItem').map((option) => option.children.flat(Infinity).join('')),
    ['All tenants', 'Alpha'],
    'All tenants is the first option when allowAll is on',
  );
  allRoot.props.onValueChange(ALL_TENANTS_VALUE);
  assert.deepEqual(allChanges, [null], 'the All tenants sentinel reports null');
});

// ---------------------------------------------------------------------------
// (d) the states the component really has: loading / failed / empty / ready
// ---------------------------------------------------------------------------
scenario('d1: loading state before the roster resolves', async () => {
  const harness = build(() => new Promise(() => {}));
  const tree = await harness.render(baseProps(null));

  assert.equal(find(tree, (node) => node.type === 'SelectValue').props.placeholder, 'Loading tenants…');
  assert.equal(find(tree, (node) => node.type === 'SelectRoot').props.disabled, true, 'disabled while loading');
  assert.ok(textNodes(tree).includes('Loading tenant names…'), 'loading status line is rendered');
  assert.equal(findAll(tree, (node) => node.type === 'SelectItem').length, 0, 'no options while loading');
  assert.equal(harness.calls.length, 1, 'exactly one roster read was issued');
  assert.equal(harness.calls[0].limit, '100', 'the roster is read with the component page size');
});

scenario('d2: failed state clears the roster and raises an alert', async () => {
  const harness = build(async () => ({ ok: false, problem: { status: 500 } }));
  const tree = await harness.settle(baseProps(TENANT_A));

  assert.equal(find(tree, (node) => node.type === 'SelectValue').props.placeholder, 'Tenant list unavailable');
  assert.equal(find(tree, (node) => node.type === 'SelectRoot').props.disabled, true, 'disabled when the roster failed');
  assert.equal(findAll(tree, (node) => node.type === 'SelectItem').length, 0, 'a failed read shows no stale rows');

  const alert = find(tree, (node) => node.props && node.props.role === 'alert');
  assert.ok(alert, 'the failed state is announced');
  assert.equal(alert.children.flat(Infinity).join(''), 'Tenant names are unavailable for this session.');
});

scenario('d3: empty roster is its own state, not an error', async () => {
  const harness = build(async () => okPage([]));
  const tree = await harness.settle(baseProps(null));

  assert.equal(find(tree, (node) => node.type === 'SelectValue').props.placeholder, 'No tenants available');
  assert.equal(find(tree, (node) => node.type === 'SelectRoot').props.disabled, true, 'disabled when the roster is empty');
  assert.ok(textNodes(tree).includes('No tenants are available.'));
  assert.equal(find(tree, (node) => node.props && node.props.role === 'alert'), undefined,
    'an empty roster is not an alert');
});

scenario('d4: a repeating cursor is treated as a failed read, not an endless loop', async () => {
  const harness = build(async () => okPage([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }], 'SAME-CURSOR'));
  const tree = await harness.settle(baseProps(null));

  assert.equal(harness.calls.length, 2, 'page 1 plus one follow, then the cycle guard stops');
  assert.equal(harness.calls[1].cursor, 'SAME-CURSOR', 'the second read follows the returned cursor');
  assert.equal(find(tree, (node) => node.type === 'SelectValue').props.placeholder, 'Tenant list unavailable');
  assert.equal(findAll(tree, (node) => node.type === 'SelectItem').length, 0, 'a looping roster is discarded');
});

scenario('d5: a multi-page roster is concatenated and stays name-labelled', async () => {
  const harness = build(async (query) => (query.cursor === undefined || query.cursor === null
    ? okPage([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }], 'PAGE-2')
    : okPage([{ id: TENANT_B, name: 'Beta', state: 'ACTIVE' }])));
  const tree = await harness.settle(baseProps(TENANT_B));

  assert.equal(harness.calls.length, 2, 'both pages are read');
  assert.deepEqual(
    findAll(tree, (node) => node.type === 'SelectItem').map((option) => option.children.flat(Infinity).join('')),
    ['Alpha', 'Beta'],
    'both pages are rendered',
  );
  assert.equal(find(tree, (node) => node.type === 'SelectRoot').props.value, TENANT_B);
  assert.ok(!textNodes(tree).join('|').includes(TENANT_B), 'still no raw id in text');
});

(async () => {
  const failures = [];
  for (const { name, fn } of scenarios) {
    try {
      await fn();
      console.log('  ok  ' + name);
    } catch (error) {
      failures.push(name);
      console.error('  FAIL ' + name + '\n       ' + (error && error.message));
    }
  }
  if (failures.length > 0) {
    console.error('FAILED ' + failures.length + '/' + scenarios.length + ': ' + failures.join('; '));
    process.exitCode = 1;
    return;
  }
  console.log(
    'PASS: real TenantSelect element tree — ' + scenarios.length +
    ' scenarios (names-not-ids, state suffix, unknown value, loading/failed/empty/cycle/multi-page)',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
