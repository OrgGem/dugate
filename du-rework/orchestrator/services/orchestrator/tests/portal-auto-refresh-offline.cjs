// Offline element-tree harness for OPU-G2 auto-refresh + data-age (test-only).
//
// Convention: services/orchestrator/tests/f7-overview-usage-tile-offline.cjs —
// the REAL TSX screen is transpiled with `typescript` and executed in a `vm`
// with a hand-rolled React hook shim; assertions run on the returned element
// tree. This harness adds three things the F-7 harness does not need:
//   - fake `setInterval`/`clearInterval` so polling can be counted and cleared;
//   - a fake clock so the data-age label is deterministic;
//   - effect-cleanup tracking so toggle-off and unmount can be proven to stop
//     the interval (no leaks).
//
// Limits (stated in the receipt, not hidden): no DOM/component renderer exists
// in this repo, so this asserts on the element tree, and the API client is
// stubbed (no BFF/HTTP round trip). What IS covered: opt-in-only polling,
// age provenance from the last successful load, stale-on-failure retention of
// the last good data, and interval cleanup on toggle-off and unmount.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const RealDate = Date;

const SCREEN_SOURCE = {
  overview: path.resolve(__dirname, '../../../apps/admin-web/src/features/overview/overview-screen.tsx'),
  usage: path.resolve(__dirname, '../../../apps/admin-web/src/features/usage/usage-screen.tsx'),
};
const STATE_SOURCE = path.resolve(__dirname, '../../../apps/admin-web/src/features/overview/state.ts');

function compile(file) {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
}

const SCREEN_CODE = {
  overview: compile(SCREEN_SOURCE.overview),
  usage: compile(SCREEN_SOURCE.usage),
};
const stateCode = compile(STATE_SOURCE);

/** The REAL features/overview/state.ts, loaded in its own vm context. */
function loadStateModule() {
  const exports = {};
  vm.runInNewContext(stateCode, {
    exports,
    require: (name) => (name === '@/lib/api' ? {} : new Proxy({}, { get: (_, key) => key })),
  });
  return exports;
}
const stateModule = loadStateModule();

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const AUTO_REFRESH_MS = 10_000;

const SESSION_TENANT = {
  ok: true,
  data: {
    schemaVersion: '1',
    plane: 'legacy',
    role: 'operator',
    principal: { kind: 'tenant_operator', tenantId: TENANT_A },
    scope: { kind: 'tenant', tenantId: TENANT_A },
    displayName: 'G2 User',
    csrfToken: 'C'.repeat(43),
  },
};

/** Real wire shape of GET /admin/api/usage (service UsageSummary). */
const USAGE_SUMMARY = {
  tenantId: TENANT_A,
  from: '2026-10-07T12:00:00.000Z',
  to: '2026-10-08T12:00:00.000Z',
  rows: [
    { provider: 'acme', model: 'x-1', operations: 3, inputTokens: 1200, outputTokens: 300, pages: 5, costMicrousd: 4200, measurement: 'measured' },
  ],
  totals: { operations: 4, inputTokens: 1210, outputTokens: 305, pages: 5, costMicrousd: 4270 },
};

const AUDIT_OK = { ok: true, data: { items: [], total: 0, limit: 25 } };

function walk(tree, visit) {
  if (!tree || typeof tree !== 'object') return;
  visit(tree);
  for (const child of (tree.children ?? []).flat(Infinity)) walk(child, visit);
}

function findAll(tree, predicate) {
  const found = [];
  walk(tree, (node) => { if (predicate(node)) found.push(node); });
  return found;
}

function find(tree, predicate) {
  return findAll(tree, predicate)[0];
}

function textOf(tree) {
  const out = [];
  walk(tree, (node) => {
    for (const child of (node.children ?? []).flat(Infinity)) {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child));
    }
  });
  return out.join(' | ');
}

/**
 * Build a harness around stubbed client methods, fake timers and a fake clock.
 * Only React hooks, the router and the API client are supplied; the screen
 * module is the real one.
 */
function build(screenName, options = {}) {
  const clock = { now: RealDate.parse('2026-10-08T12:00:00.000Z') };
  const timers = new Map();
  const cleared = [];
  let timerSeq = 0;
  const calls = { getSession: 0, getUsage: 0, listAudit: 0 };
  const stubs = {
    session: SESSION_TENANT,
    usage: { ok: true, data: USAGE_SUMMARY },
    audit: AUDIT_OK,
    ...options,
  };
  const client = {
    getSession: async () => {
      calls.getSession += 1;
      return typeof stubs.session === 'function' ? stubs.session() : stubs.session;
    },
    getUsage: async () => {
      calls.getUsage += 1;
      return typeof stubs.usage === 'function' ? stubs.usage() : stubs.usage;
    },
    listAudit: async () => {
      calls.listAudit += 1;
      return typeof stubs.audit === 'function' ? stubs.audit() : stubs.audit;
    },
  };

  const componentState = new Map();
  const componentDeps = new Map();
  const effectCleanups = new Map();
  const frames = [];
  let pendingEffects = [];

  function slotsOf(fn) {
    let slots = componentState.get(fn);
    if (!slots) {
      slots = [];
      componentState.set(fn, slots);
    }
    return slots;
  }

  function cleanupsOf(fn) {
    let map = effectCleanups.get(fn);
    if (!map) {
      map = new Map();
      effectCleanups.set(fn, map);
    }
    return map;
  }

  function withFrame(fn, produce) {
    const deps = componentDeps.get(fn) ?? [];
    componentDeps.set(fn, deps);
    frames.push({ fn, cursor: 0, deps });
    try {
      return produce();
    } finally {
      frames.pop();
    }
  }

  function sameDeps(previous, next) {
    return (
      Array.isArray(previous) &&
      Array.isArray(next) &&
      previous.length === next.length &&
      next.every((value, i) => value === previous[i])
    );
  }

  function FakeDate(...args) {
    if (!new.target) return new RealDate(clock.now).toString();
    if (args.length === 0) return new RealDate(clock.now);
    return new RealDate(...args);
  }
  FakeDate.now = () => clock.now;
  FakeDate.parse = RealDate.parse;
  FakeDate.UTC = RealDate.UTC;
  FakeDate.prototype = RealDate.prototype;

  const react = {
    Fragment: 'Fragment',
    createElement: (type, props, ...children) => {
      const resolved = type === undefined || type === null ? 'Fragment' : type;
      if (typeof resolved === 'function') {
        return withFrame(resolved, () => resolved(props || {}));
      }
      return { type: resolved, props: props || {}, children };
    },
    useState: (initial) => {
      const frame = frames[frames.length - 1];
      const slots = slotsOf(frame.fn);
      const i = frame.cursor++;
      if (!(i in slots)) slots[i] = typeof initial === 'function' ? initial() : initial;
      return [
        slots[i],
        (value) => { slots[i] = typeof value === 'function' ? value(slots[i]) : value; },
      ];
    },
    useMemo: (fn) => {
      const frame = frames[frames.length - 1];
      const slots = slotsOf(frame.fn);
      const i = frame.cursor++;
      if (!(i in slots)) slots[i] = fn();
      return slots[i];
    },
    useCallback: (fn, next) => {
      const frame = frames[frames.length - 1];
      const slots = slotsOf(frame.fn);
      const i = frame.cursor++;
      const previous = frame.deps[i];
      if (!previous || !sameDeps(previous, next)) {
        frame.deps[i] = next;
        slots[i] = fn;
      }
      return slots[i];
    },
    useEffect: (fn, next) => {
      const frame = frames[frames.length - 1];
      const i = frame.cursor++;
      const previous = frame.deps[i];
      if (!previous || !sameDeps(previous, next)) {
        const cleanups = cleanupsOf(frame.fn);
        const previousCleanup = cleanups.get(i);
        if (typeof previousCleanup === 'function') previousCleanup();
        cleanups.delete(i);
        frame.deps[i] = next;
        pendingEffects.push({ fn, componentFn: frame.fn, slot: i });
      }
    },
  };

  const sandbox = {
    exports: {},
    React: react,
    require: (name) => {
      if (name === 'react') return react;
      if (name === '@/lib/api') return { createAdminApiClient: () => client };
      if (name === '@/lib/tenant-context') return { useTenant: () => ({ selectedTenantId: '00000000-0000-0000-0000-000000000001', setSelectedTenantId: () => {} }) };
      if (name === './state') return stateModule;
      // Every other import (react-router, @/components/ui/*) is an element tag by name.
      return new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) });
    },
    setInterval: (fn, ms) => {
      timerSeq += 1;
      timers.set(timerSeq, { fn, ms });
      return timerSeq;
    },
    clearInterval: (id) => {
      timers.delete(id);
      cleared.push(id);
    },
    Date: FakeDate,
  };
  vm.runInNewContext(SCREEN_CODE[screenName], sandbox);
  const Component = screenName === 'overview' ? sandbox.exports.OverviewScreen : sandbox.exports.UsageScreen;
  if (typeof Component !== 'function') {
    throw new Error(screenName + '-screen.tsx did not export its screen component');
  }

  function runEffects() {
    const queued = pendingEffects;
    pendingEffects = [];
    for (const effect of queued) {
      const cleanup = effect.fn();
      cleanupsOf(effect.componentFn).set(effect.slot, typeof cleanup === 'function' ? cleanup : undefined);
    }
  }

  async function flush() {
    for (let i = 0; i < 6; i += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** One render pass (plus the effects it queued, flushed once). */
  async function render() {
    pendingEffects = [];
    const tree = withFrame(Component, () => Component({}));
    runEffects();
    await flush();
    return tree;
  }

  /** Render, run effects, flush; repeat until a render queues no new effects. */
  async function settle() {
    let tree = null;
    for (let i = 0; i < 14; i += 1) {
      // Let any in-flight async work (a fired timer's load, a resolved stub)
      // land before rendering, so the tree reflects it.
      await flush();
      pendingEffects = [];
      tree = withFrame(Component, () => Component({}));
      if (pendingEffects.length === 0) return tree;
      runEffects();
    }
    throw new Error(screenName + ' screen effects did not settle');
  }

  function unmount() {
    for (const cleanups of effectCleanups.values()) {
      for (const cleanup of cleanups.values()) {
        if (typeof cleanup === 'function') cleanup();
      }
      cleanups.clear();
    }
  }

  function fireTimer(id) {
    const timer = timers.get(id);
    assert.ok(timer, 'timer ' + id + ' is not active');
    timer.fn();
  }

  function click(node) {
    assert.ok(node && node.props && typeof node.props.onClick === 'function', 'clickable node expected');
    node.props.onClick();
  }

  const toggle = (tree) => find(tree, (node) => node.props && node.props['data-portal-auto-refresh-toggle'] === 'true');
  const age = (tree) => find(tree, (node) => node.props && node.props['data-portal-data-age'] === 'true');

  return {
    clock, timers, cleared, calls, stubs,
    render, settle, unmount, fireTimer, click, toggle, age,
    find: (tree, predicate) => find(tree, predicate),
    findAll: (tree, predicate) => findAll(tree, predicate),
    textOf,
  };
}

const scenarios = [];
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

// ---------------------------------------------------------------------------
// Usage screen
// ---------------------------------------------------------------------------

scenario('usage-1: a failed first load shows Unavailable, never a zero age, and never polls', async () => {
  const h = build('usage', { usage: { ok: false, problem: { status: 500, code: 'BFF_ERROR', title: 'down' } } });
  const tree = await h.settle();

  const toggle = h.toggle(tree);
  assert.ok(toggle, 'an auto refresh toggle is rendered');
  assert.equal(toggle.props['aria-pressed'], false, 'the toggle is OFF by default (no consent)');
  assert.equal(h.timers.size, 0, 'no interval may exist before opt-in');

  const age = h.age(tree);
  assert.ok(age, 'a data age label is rendered');
  assert.equal(age.props['data-data-age-state'], 'unavailable', 'never-succeeded state is unavailable');
  const ageText = h.textOf(age);
  assert.ok(ageText.includes('Unavailable'), 'the label says Unavailable — got: ' + ageText);
  assert.ok(!/\b0s\b/.test(ageText), 'no fake zero age — got: ' + ageText);
});

scenario('usage-2: a successful load shows an age derived from when it completed', async () => {
  const h = build('usage', {});
  let tree = await h.settle();

  let age = h.age(tree);
  assert.ok(age, 'a data age label is rendered');
  assert.equal(age.props['data-data-age-state'], 'fresh', 'a successful load is fresh');
  assert.ok(/Data age: \d+s/.test(h.textOf(age)), 'age is shown — got: ' + h.textOf(age));

  h.clock.now += 30_000;
  tree = await h.render();
  age = h.age(tree);
  assert.ok(h.textOf(age).includes('30s'), 'the age follows the clock — got: ' + h.textOf(age));
});

scenario('usage-3: polling starts only after the operator opts in, on the declared cadence', async () => {
  const h = build('usage', {});
  let tree = await h.settle();
  assert.equal(h.timers.size, 0, 'off by default: no timer');

  h.click(h.toggle(tree));
  tree = await h.settle();

  const toggle = h.toggle(tree);
  assert.equal(toggle.props['aria-pressed'], true, 'the toggle reflects opt-in');
  assert.equal(h.timers.size, 1, 'exactly one interval after opt-in');
  const entry = [...h.timers.entries()][0];
  assert.equal(entry[1].ms, AUTO_REFRESH_MS, 'the poll cadence is explicit');

  const before = h.calls.getUsage;
  h.fireTimer(entry[0]);
  await h.settle();
  assert.ok(h.calls.getUsage > before, 'the interval issues the refresh read');
});

scenario('usage-4: a failed refresh keeps the last good data and marks it stale', async () => {
  const h = build('usage', {});
  let tree = await h.settle();
  assert.ok(h.textOf(tree).includes('1210'), 'baseline payload is visible');

  h.click(h.toggle(tree));
  tree = await h.settle();
  const timerId = [...h.timers.keys()][0];

  h.stubs.usage = { ok: false, problem: { status: 503, code: 'BFF_DOWN', title: 'down' } };
  h.clock.now += 45_000;
  h.fireTimer(timerId);
  tree = await h.settle();

  assert.ok(h.textOf(tree).includes('1210'), 'the last good data stays visible after a failed refresh');
  const age = h.age(tree);
  assert.equal(age.props['data-data-age-state'], 'stale', 'the label marks the data stale');
  const ageText = h.textOf(age);
  assert.ok(ageText.includes('stale'), 'stale is explicit — got: ' + ageText);
  assert.ok(ageText.includes('45s'), 'the age still derives from the last success — got: ' + ageText);
  assert.ok(!ageText.includes('Unavailable'), 'a prior success is never reported as never-loaded');
});

scenario('usage-5: turning the toggle off and unmounting both clear the interval', async () => {
  const h = build('usage', {});
  let tree = await h.settle();

  h.click(h.toggle(tree));
  tree = await h.settle();
  assert.equal(h.timers.size, 1, 'opt-in starts one interval');
  const firstId = [...h.timers.keys()][0];

  h.click(h.toggle(tree));
  tree = await h.settle();
  assert.equal(h.timers.size, 0, 'turning the toggle off clears the interval');
  assert.ok(h.cleared.includes(firstId), 'clearInterval was called for the poll timer');

  h.click(h.toggle(tree));
  tree = await h.settle();
  assert.equal(h.timers.size, 1, 'opting in again starts a fresh interval');
  h.unmount();
  assert.equal(h.timers.size, 0, 'unmount clears the interval (no leak)');
});

// ---------------------------------------------------------------------------
// Overview screen
// ---------------------------------------------------------------------------

scenario('overview-1: a failed first load shows Unavailable and never polls', async () => {
  const h = build('overview', { session: { ok: false, problem: { status: 401, code: 'UNAUTHENTICATED', title: 'Sign in' } } });
  const tree = await h.settle();

  const toggle = h.toggle(tree);
  assert.ok(toggle, 'an auto refresh toggle is rendered');
  assert.equal(toggle.props['aria-pressed'], false, 'the toggle is OFF by default');
  assert.equal(h.timers.size, 0, 'no interval may exist before opt-in');

  const age = h.age(tree);
  assert.ok(age, 'a data age label is rendered');
  assert.equal(age.props['data-data-age-state'], 'unavailable');
  assert.ok(h.textOf(age).includes('Unavailable'), 'never-succeeded age is Unavailable — got: ' + h.textOf(age));
});

scenario('overview-2: a successful load is fresh; opt-in registers one interval that polls', async () => {
  const h = build('overview', {});
  let tree = await h.settle();

  const age = h.age(tree);
  assert.equal(age.props['data-data-age-state'], 'fresh', 'a successful cycle is fresh');
  assert.ok(/Data age: \d+s/.test(h.textOf(age)), 'age is shown — got: ' + h.textOf(age));
  assert.equal(h.timers.size, 0, 'off by default: no timer');

  h.click(h.toggle(tree));
  tree = await h.settle();
  assert.equal(h.timers.size, 1, 'exactly one interval after opt-in');
  const entry = [...h.timers.entries()][0];
  assert.equal(entry[1].ms, AUTO_REFRESH_MS, 'the poll cadence is explicit');

  const before = h.calls.getSession;
  h.fireTimer(entry[0]);
  await h.settle();
  assert.ok(h.calls.getSession > before, 'the interval re-runs the load cycle');
});

scenario('overview-3: a failed refresh keeps the last good rollup and marks it stale', async () => {
  const h = build('overview', {});
  let tree = await h.settle();
  assert.ok(h.textOf(tree).includes('1210'), 'baseline usage rollup is visible');

  h.click(h.toggle(tree));
  tree = await h.settle();
  const timerId = [...h.timers.keys()][0];

  h.stubs.usage = { ok: false, problem: { status: 500, code: 'BFF_DOWN', title: 'down' } };
  h.clock.now += 25_000;
  h.fireTimer(timerId);
  tree = await h.settle();

  assert.ok(h.textOf(tree).includes('1210'), 'the last good rollup stays visible after a failed refresh');
  const age = h.age(tree);
  assert.equal(age.props['data-data-age-state'], 'stale', 'the label marks the data stale');
  const ageText = h.textOf(age);
  assert.ok(ageText.includes('stale'), 'stale is explicit — got: ' + ageText);
  assert.ok(ageText.includes('25s'), 'the age still derives from the last success — got: ' + ageText);
});

scenario('overview-4: unmount clears the interval (no leak)', async () => {
  const h = build('overview', {});
  let tree = await h.settle();

  h.click(h.toggle(tree));
  tree = await h.settle();
  assert.equal(h.timers.size, 1, 'opt-in starts one interval');
  const id = [...h.timers.keys()][0];

  h.unmount();
  assert.equal(h.timers.size, 0, 'unmount clears the interval');
  assert.ok(h.cleared.includes(id), 'clearInterval was called for the poll timer');
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
    'PASS: OPU-G2 auto refresh + data age — ' + scenarios.length +
    ' scenarios (opt-in only, age from last success, stale-on-failure retention, cleanup on toggle-off/unmount)',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
