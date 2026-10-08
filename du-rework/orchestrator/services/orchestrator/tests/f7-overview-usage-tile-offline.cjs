// Offline element-tree harness for the REAL OverviewScreen usage tile (F-7, test-only).
//
// Convention: services/orchestrator/tests/tenant-select-offline.cjs and
// services/orchestrator/tests/usage-screen-offline.cjs — the TSX is transpiled with
// `typescript` and executed in a `vm` context with a hand-rolled React hook shim; the
// component under test is the REAL module (no mock of overview-screen.tsx).
//
// F-7 defect under test: overview-screen.tsx rendered
//   <UnavailableTile title="Usage rollup" description="Per-tenant usage aggregation is not
//    exposed by the platform BFF yet. …" />
// while the BFF route already exists (src/app/admin/bff/operations.ts:61 kind 'usage',
// :199-220 GET /admin/api/usage -> upstream /api/v1/usage) and the client already exposes
// `getUsage` (apps/admin-web/src/lib/api/client.ts:126,349). The assertions below encode the
// NEW criteria: the tile must read real per-tenant usage and must NOT carry the stale claim.
//
// Limits (stated in the receipt, not hidden): no DOM and no component renderer exist in this
// repo, so this asserts on the returned ELEMENT TREE, not on painted DOM, and the API client is
// stubbed (no BFF/HTTP round trip). What IS covered: which client call the screen makes and with
// which tenant/window, that the rendered tile text comes from the stub payload, and that every
// failure mode fails closed without fabricated numbers or the stale copy.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');

const SCREEN_SOURCE = path.resolve(
  __dirname,
  '../../../apps/admin-web/src/features/overview/overview-screen.tsx',
);
const STATE_SOURCE = path.resolve(
  __dirname,
  '../../../apps/admin-web/src/features/overview/state.ts',
);

function compile(file) {
  return ts.transpileModule(fs.readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
}

const screenCode = compile(SCREEN_SOURCE);
const stateCode = compile(STATE_SOURCE);

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';

/** Real wire shape of GET /admin/api/usage (service UsageSummary, usage.ts:102-117). */
const USAGE_PAYLOAD = {
  tenantId: TENANT_A,
  from: '2026-10-07T00:00:00.000Z',
  to: '2026-10-08T00:00:00.000Z',
  rows: [
    { provider: 'acme', model: 'x-1', operations: 3, inputTokens: 1200, outputTokens: 300, pages: 5, costMicrousd: 4200, measurement: 'measured' },
    { provider: 'other', model: 'y-2', operations: 1, inputTokens: 10, outputTokens: 5, pages: 0, costMicrousd: 70, measurement: 'estimated' },
  ],
  totals: { operations: 4, inputTokens: 1210, outputTokens: 305, pages: 5, costMicrousd: 4270 },
};

const STALE_CLAIMS = [
  /not exposed/i,
  /requires backend/i,
  /once the usage read endpoint lands/i,
];

async function flush() {
  for (let i = 0; i < 4; i += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}

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

function sessionFor(scope) {
  return {
    schemaVersion: '1',
    plane: 'legacy',
    role: scope !== null && scope.kind === 'platform' ? 'admin' : 'operator',
    principal: {
      kind: scope === null ? 'unscoped' : scope.kind === 'platform' ? 'platform' : 'tenant_operator',
      tenantId: scope !== null && scope.kind === 'tenant' ? scope.tenantId : null,
    },
    scope,
    displayName: 'F7 User',
    csrfToken: 'C'.repeat(43),
  };
}

function okAudit() {
  return { ok: true, data: { items: [], total: 0, limit: 25 } };
}

/**
 * Build a harness around stubbed client methods. Only React's hooks, the router and the API
 * client are supplied; the screen module is the real one.
 *
 * The React shim expands FUNCTION components (OverviewScreen renders SessionCard/AuditCard and,
 * after the fix, the usage tile) with one hook frame per component identity, so each component
 * keeps its own state/deps slots across renders — the same convention as
 * tenant-select-offline.cjs, extended because that screen's tree is tag-only.
 */
function build({ session, usage, audit }) {
  const calls = { getSession: 0, listAudit: [], getUsage: [] };
  const client = {
    getSession: async () => {
      calls.getSession += 1;
      return session;
    },
    listAudit: async (query) => {
      calls.listAudit.push(query);
      return typeof audit === 'function' ? audit(query) : (audit ?? okAudit());
    },
    getUsage: async (query) => {
      calls.getUsage.push(query);
      return typeof usage === 'function' ? usage(query) : (usage ?? { ok: true, data: USAGE_PAYLOAD });
    },
  };

  const componentState = new Map();
  const componentDeps = new Map();
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
    return previous.length === next.length && next.every((value, i) => value === previous[i]);
  }

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
      return [slots[i], (value) => { slots[i] = value; }];
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
        frame.deps[i] = next;
        pendingEffects.push(fn);
      }
    },
  };
  const screenExports = {};
  vm.runInNewContext(screenCode, {
    exports: screenExports,
    React: react,
    require: (name) => {
      if (name === 'react') return react;
      if (name === '@/lib/api') return { createAdminApiClient: () => client };
      if (name === './state') return stateModule;
      // Every other import (react-router, @/components/ui/*) is an element tag by name.
      return new Proxy({}, { get: (_, key) => (typeof key === 'string' ? key : undefined) });
    },
  });
  if (typeof screenExports.OverviewScreen !== 'function') {
    throw new Error('overview-screen.tsx did not export OverviewScreen');
  }

  /** Render, run the effects that fired, flush; repeat until the screen settles. */
  async function settle() {
    let tree = null;
    for (let i = 0; i < 12; i += 1) {
      pendingEffects = [];
      tree = withFrame(screenExports.OverviewScreen, () => screenExports.OverviewScreen({}));
      if (pendingEffects.length === 0) return tree;
      for (const effect of pendingEffects) effect();
      await flush();
    }
    throw new Error('OverviewScreen effects did not settle');
  }

  return { settle, calls };
}

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

/** Every text child (strings AND numbers, as React renders both) in document order. */
function textOf(tree) {
  const out = [];
  walk(tree, (node) => {
    for (const child of (node.children ?? []).flat(Infinity)) {
      if (typeof child === 'string' || typeof child === 'number') out.push(String(child));
    }
  });
  return out.join(' | ');
}

/** The Card tile whose text contains the given title; throws when the tile is missing. */
function cardOf(tree, title) {
  const card = findAll(tree, (node) => node.type === 'Card' && textOf(node).includes(title))[0];
  assert.ok(card, 'expected a Card tile titled "' + title + '"');
  return card;
}

/** The Card tile whose text matches the given pattern; throws when the tile is missing. */
function cardMatching(tree, pattern) {
  const card = findAll(tree, (node) => node.type === 'Card' && pattern.test(textOf(node)))[0];
  assert.ok(card, 'expected a Card tile matching ' + pattern);
  return card;
}

function assertNoStaleClaim(text, label) {
  for (const claim of STALE_CLAIMS) {
    assert.ok(!claim.test(text), label + ': stale claim ' + claim + ' must be gone — got: ' + text);
  }
}

const scenarios = [];
function scenario(name, fn) {
  scenarios.push({ name, fn });
}

// ---------------------------------------------------------------------------
// 1. tenant session -> the tile reads REAL usage for the session tenant
// ---------------------------------------------------------------------------
scenario('1: tenant session renders real usage totals and drops the stale copy', async () => {
  const harness = build({ session: { ok: true, data: sessionFor({ kind: 'tenant', tenantId: TENANT_A }) } });
  const tree = await harness.settle();

  assert.equal(harness.calls.getUsage.length, 1, 'the usage read must be issued exactly once');
  const query = harness.calls.getUsage[0];
  assert.equal(query.tenantId, TENANT_A, 'the tenant comes from the server-side session scope');
  assert.equal(typeof query.from, 'string', 'from is forwarded');
  assert.equal(typeof query.to, 'string', 'to is forwarded');
  assert.ok(Date.parse(query.to) > Date.parse(query.from), 'the window is a non-empty [from,to)');
  assert.ok(!query.tenantId.includes(TENANT_B), 'no other tenant may be requested');

  const usageCard = cardOf(tree, 'Usage rollup');
  assert.ok(usageCard, 'the usage tile keeps its title');
  const usageText = textOf(usageCard);
  assertNoStaleClaim(usageText, 'usage tile');
  assert.ok(usageText.includes('1210'), 'real input-token total is rendered — got: ' + usageText);
  assert.ok(usageText.includes('305'), 'real output-token total is rendered');
  assert.ok(usageText.includes('acme'), 'real per-provider row is rendered');
  assert.ok(!usageText.includes(TENANT_B), 'no foreign tenant id in the tile');

  const operationsCard = cardMatching(tree, /operations list\/actions/i);
  assert.notEqual(usageCard, operationsCard, 'the two tiles are distinct');
});

// ---------------------------------------------------------------------------
// 2. platform session -> no tenant to read; must NOT call the route, must NOT claim it is missing
// ---------------------------------------------------------------------------
scenario('2: platform session without a tenant does not call usage and asks for a tenant', async () => {
  const harness = build({ session: { ok: true, data: sessionFor({ kind: 'platform' }) } });
  const tree = await harness.settle();

  assert.equal(harness.calls.getUsage.length, 0,
    'a platform session has no single tenant: the tenant-scoped route must not be called');

  const usageCard = cardOf(tree, 'Usage rollup');
  assert.ok(usageCard, 'the usage tile still renders');
  const usageText = textOf(usageCard);
  assertNoStaleClaim(usageText, 'platform usage tile');
  assert.ok(/select a tenant/i.test(usageText), 'the tile explains a tenant must be chosen');
  const link = find(usageCard, (node) => node.type === 'Link' && node.props && node.props.to === '/usage');
  assert.ok(link, 'the tile links to the Usage screen where the tenant is chosen');
});

// ---------------------------------------------------------------------------
// 3. usage read fails -> fail closed, no numbers, no stale copy
// ---------------------------------------------------------------------------
scenario('3: a denied usage read renders a denied pane and never fabricates counts', async () => {
  const harness = build({
    session: { ok: true, data: sessionFor({ kind: 'tenant', tenantId: TENANT_A }) },
    usage: { ok: false, problem: { status: 403, code: 'PERMISSION_DENIED', title: 'Access denied' } },
  });
  const tree = await harness.settle();

  assert.equal(harness.calls.getUsage.length, 1, 'the read was attempted');
  const usageCard = cardOf(tree, 'Usage rollup');
  const usageText = textOf(usageCard);
  assertNoStaleClaim(usageText, 'denied usage tile');
  assert.ok(find(usageCard, (node) => node.type === 'DeniedState' || node.type === 'ErrorState'),
    'a denied/error pane is rendered');
  assert.ok(!usageText.includes('1210') && !usageText.includes('305'),
    'no payload number may appear on a failed read');
});

// ---------------------------------------------------------------------------
// 4. unreadable payload -> fail closed (never coerce garbage into zeros)
// ---------------------------------------------------------------------------
scenario('4: an unreadable usage payload fails closed without fabricated numbers', async () => {
  const harness = build({
    session: { ok: true, data: sessionFor({ kind: 'tenant', tenantId: TENANT_A }) },
    usage: { ok: true, data: { rows: 'nope', totals: null } },
  });
  const tree = await harness.settle();

  const usageCard = cardOf(tree, 'Usage rollup');
  assert.ok(usageCard, 'the usage tile still renders');
  const usageText = textOf(usageCard);
  assertNoStaleClaim(usageText, 'unreadable usage tile');
  assert.ok(find(usageCard, (node) => node.type === 'ErrorState'),
    'an unreadable payload is an error pane');
  assert.ok(!/\d/.test(usageText),
    'no number may be rendered from an unreadable payload — got: ' + usageText);
});

// ---------------------------------------------------------------------------
// 5. empty window -> empty state (a measured zero is not an error, not a stale claim)
// ---------------------------------------------------------------------------
scenario('5: an empty window renders the empty state', async () => {
  const harness = build({
    session: { ok: true, data: sessionFor({ kind: 'tenant', tenantId: TENANT_A }) },
    usage: {
      ok: true,
      data: {
        tenantId: TENANT_A,
        from: USAGE_PAYLOAD.from,
        to: USAGE_PAYLOAD.to,
        rows: [],
        totals: { operations: 0, inputTokens: 0, outputTokens: 0, pages: 0, costMicrousd: 0 },
      },
    },
  });
  const tree = await harness.settle();

  const usageCard = cardOf(tree, 'Usage rollup');
  const usageText = textOf(usageCard);
  assertNoStaleClaim(usageText, 'empty usage tile');
  assert.ok(find(usageCard, (node) => node.type === 'EmptyState'), 'the empty state is rendered');
});

// ---------------------------------------------------------------------------
// 6. the Operations tile must stay as it was (different title, still no backend)
// ---------------------------------------------------------------------------
scenario('6: the Operations tile keeps its own unavailable copy', async () => {
  const harness = build({ session: { ok: true, data: sessionFor({ kind: 'tenant', tenantId: TENANT_A }) } });
  const tree = await harness.settle();

  const operationsCard = cardMatching(tree, /operations list\/actions/i);
  const operationsText = textOf(operationsCard);
  assert.ok(/operations list\/actions/i.test(operationsText), 'the operations copy is unchanged');
  assert.ok(find(operationsCard, (node) => node.type === 'Badge' && node.props.variant === 'warning'),
    'the Operations tile keeps its requires-backend badge');
});

// ---------------------------------------------------------------------------
// 7. session failure -> the tile fails closed (no tenant is knowable)
// ---------------------------------------------------------------------------
scenario('7: a failed session fails the usage tile closed without a stale claim', async () => {
  const harness = build({
    session: { ok: false, problem: { status: 401, code: 'UNAUTHENTICATED', title: 'Sign in' } },
  });
  const tree = await harness.settle();

  assert.equal(harness.calls.getUsage.length, 0, 'no tenant is knowable, so no usage read');
  const usageCard = cardOf(tree, 'Usage rollup');
  assert.ok(usageCard, 'the usage tile still renders');
  const usageText = textOf(usageCard);
  assertNoStaleClaim(usageText, 'session-failed usage tile');
  assert.ok(find(usageCard, (node) => node.type === 'ErrorState' || node.type === 'DeniedState'),
    'the tile shows a fail-closed pane');
});

// ---------------------------------------------------------------------------
// 8. no admin principal -> honest pane, no read, no stale claim
// ---------------------------------------------------------------------------
scenario('8: a session without an admin principal renders an honest pane', async () => {
  const harness = build({ session: { ok: true, data: sessionFor(null) } });
  const tree = await harness.settle();

  assert.equal(harness.calls.getUsage.length, 0, 'no principal, no tenant, no usage read');
  const usageCard = cardOf(tree, 'Usage rollup');
  const usageText = textOf(usageCard);
  assertNoStaleClaim(usageText, 'unscoped usage tile');
  assert.ok(!usageText.includes(TENANT_A) && !usageText.includes(TENANT_B),
    'no tenant id may appear for an unscoped session');
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
    'PASS: real OverviewScreen usage tile — ' + scenarios.length +
    ' scenarios (real totals, tenant from session, platform/unscoped/failed fail-closed, ' +
    'unreadable payload, empty window, Operations tile intact)',
  );
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
