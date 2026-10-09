/**
 * F-4 — component/render test for the REAL `TenantSelect`
 * (`apps/admin-web/src/components/ui/tenant-select.tsx`).
 *
 * The F-4 finding said the component had no component/DOM test: the only coverage was
 * `tests/tenant-select-offline.cjs` (element tree) and `tests/usage-screen-offline.cjs`, which
 * replaces it with `const TenantSelect = function TenantSelectMock() {}` (line 10). This suite
 * renders the REAL component module in two layers, offline, with no browser and no DB:
 *
 *   Layer 1 — REAL render: the component is transpiled and executed with the real `react` +
 *   real `@base-ui/react` (through the real `select.tsx`) and rendered by `react-dom/server`
 *   `renderToStaticMarkup`, so the assertions read actual HTML (trigger role/id/aria/disabled,
 *   placeholder text, label, described-by wiring). `useEffect` does not run during a server
 *   render, so this layer covers the states reachable without a roster read.
 *
 *   Layer 2 — behaviour with the roster: the same real component module is driven through a
 *   minimal React hook shim (the repo convention: `tests/tenant-select-offline.cjs`), the
 *   effects are executed, and the returned element tree is asserted. This is where the four
 *   required behaviours live: options from the roster, placeholder when `tenantId` is not in the
 *   roster, submit reports the exact tenant id, and a failed roster read re-points nothing.
 *
 * Limits (stated, not hidden): there is no jsdom / @testing-library / react-test-renderer in this
 * repo, so Layer 2 is element-tree level, not painted DOM; `@base-ui/react`'s own rendering of
 * `<SelectValue>` is covered by Layer 1 only for the initial state. Nothing here claims a browser
 * or a live BFF run.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import * as ts from 'typescript';

const ADMIN_WEB = join(__dirname, '..', '..', '..', 'apps', 'admin-web');
const TENANT_SELECT_SOURCE = join(ADMIN_WEB, 'src', 'components', 'ui', 'tenant-select.tsx');
const SELECT_SOURCE = join(ADMIN_WEB, 'src', 'components', 'ui', 'select.tsx');

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const TENANT_B = '22222222-2222-4222-8222-222222222222';
const TENANT_UNKNOWN = '99999999-9999-4999-8999-999999999999';
const ALL_TENANTS_VALUE = '__all_tenants__';

const SELECT_TAGS = [
  'SelectRoot',
  'SelectTrigger',
  'SelectValue',
  'SelectPortal',
  'SelectPositioner',
  'SelectPopup',
  'SelectItem',
] as const;

interface ElementNode {
  type: unknown;
  props: Record<string, unknown>;
  children: unknown[];
}

interface TenantRow {
  id: string;
  name: string;
  state: string;
}

interface ListTenantsResult {
  ok: boolean;
  data?: { items: TenantRow[]; nextCursor: string | null };
  problem?: { status: number; code?: string; title?: string };
}

interface TenantSelectProps {
  id: string;
  value: string | null;
  onValueChange: (value: string | null) => void;
  label?: string | null;
  allowAll?: boolean;
  disabled?: boolean;
  description?: string;
}

function compile(file: string): string {
  return ts.transpileModule(readFileSync(file, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React },
  }).outputText;
}

const tenantSelectCode = compile(TENANT_SELECT_SOURCE);

function isElementNode(value: unknown): value is ElementNode {
  return typeof value === 'object' && value !== null && 'type' in value && 'props' in value;
}

function walk(tree: unknown, visit: (node: ElementNode) => void): void {
  if (!isElementNode(tree)) return;
  visit(tree);
  for (const child of tree.children.flat(Infinity)) walk(child, visit);
}

function findAll(tree: unknown, predicate: (node: ElementNode) => boolean): ElementNode[] {
  const found: ElementNode[] = [];
  walk(tree, (node) => {
    if (predicate(node)) found.push(node);
  });
  return found;
}

function find(tree: unknown, predicate: (node: ElementNode) => boolean): ElementNode | undefined {
  return findAll(tree, predicate)[0];
}

function textOf(tree: unknown): string {
  const parts: string[] = [];
  walk(tree, (node) => {
    for (const child of node.children.flat(Infinity)) {
      if (typeof child === 'string' || typeof child === 'number') parts.push(String(child));
    }
  });
  return parts.join(' | ');
}

function optionLabels(tree: unknown): string[] {
  return findAll(tree, (node) => node.type === 'SelectItem')
    .map((node) => node.children.flat(Infinity).join(''));
}

function optionValues(tree: unknown): unknown[] {
  return findAll(tree, (node) => node.type === 'SelectItem').map((node) => node.props['value']);
}

function okPage(items: TenantRow[], nextCursor: string | null = null): ListTenantsResult {
  return { ok: true, data: { items, nextCursor } };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

/**
 * Layer 2 harness: the real component module with a React hook shim, one hook frame per component
 * identity, effects collected and executed until the tree settles.
 */
function buildRosterHarness(listTenants: (query: Record<string, string>) => Promise<ListTenantsResult>) {
  const calls: Record<string, string>[] = [];
  const client = {
    listTenants: async (query: Record<string, string>) => {
      calls.push(query);
      return listTenants(query);
    },
  };
  const componentState = new Map<unknown, unknown[]>();
  const componentDeps = new Map<unknown, unknown[][]>();
  const frames: { fn: unknown; cursor: number; deps: unknown[][] }[] = [];
  let pendingEffects: (() => void)[] = [];

  function slotsOf(fn: unknown): unknown[] {
    let slots = componentState.get(fn);
    if (!slots) {
      slots = [];
      componentState.set(fn, slots);
    }
    return slots;
  }

  function withFrame<T>(fn: unknown, produce: () => T): T {
    const deps = componentDeps.get(fn) ?? [];
    componentDeps.set(fn, deps);
    frames.push({ fn, cursor: 0, deps });
    try {
      return produce();
    } finally {
      frames.pop();
    }
  }

  function currentFrame(): { fn: unknown; cursor: number; deps: unknown[][] } {
    const frame = frames[frames.length - 1];
    if (!frame) throw new Error('hook used outside a component frame');
    return frame;
  }

  function sameDeps(previous: unknown[], next: unknown[]): boolean {
    return previous.length === next.length && next.every((value, index) => value === previous[index]);
  }

  const react = {
    Fragment: 'Fragment',
    createElement: (type: unknown, props: unknown, ...children: unknown[]): ElementNode => {
      const resolved = type === undefined || type === null ? 'Fragment' : type;
      if (typeof resolved === 'function') {
        return withFrame(resolved, () =>
          (resolved as (p: unknown) => ElementNode)(props ?? {}),
        );
      }
      return { type: resolved, props: (props ?? {}) as Record<string, unknown>, children };
    },
    useState: (initial: unknown) => {
      const frame = currentFrame();
      const slots = slotsOf(frame.fn);
      const index = frame.cursor++;
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? (initial as () => unknown)() : initial;
      return [slots[index], (value: unknown) => { slots[index] = value; }];
    },
    useMemo: (fn: () => unknown) => {
      const frame = currentFrame();
      const slots = slotsOf(frame.fn);
      const index = frame.cursor++;
      if (!(index in slots)) slots[index] = fn();
      return slots[index];
    },
    useEffect: (fn: () => void, next: unknown[]) => {
      const frame = currentFrame();
      const index = frame.cursor++;
      const previous = frame.deps[index];
      if (!previous || !sameDeps(previous, next)) {
        frame.deps[index] = next;
        pendingEffects.push(fn);
      }
    },
  };

  const selectModule = Object.fromEntries(SELECT_TAGS.map((tag) => [tag, tag]));
  const exports: Record<string, unknown> = {};
  runInNewContext(tenantSelectCode, {
    exports,
    module: { exports },
    React: react,
    require: (name: string) => {
      if (name === 'react') return react;
      if (name === './select') return selectModule;
      if (name === '@/lib/api') return { createAdminApiClient: () => client };
      return new Proxy({}, { get: (_target, key) => (typeof key === 'string' ? key : undefined) });
    },
  });
  const TenantSelect = exports['TenantSelect'];
  if (typeof TenantSelect !== 'function') throw new Error('tenant-select.tsx did not export TenantSelect');

  /** Render, run the effects that fired, flush; repeat until the component settles. */
  async function settle(props: TenantSelectProps): Promise<ElementNode> {
    let tree: ElementNode | undefined;
    for (let i = 0; i < 12; i += 1) {
      pendingEffects = [];
      tree = withFrame(TenantSelect, () => (TenantSelect as (p: TenantSelectProps) => ElementNode)(props));
      if (pendingEffects.length === 0) return tree;
      for (const effect of pendingEffects) effect();
      await flush();
    }
    throw new Error('TenantSelect effects did not settle');
  }

  return { settle, calls };
}

/** Layer 1: the real component + real select.tsx + real @base-ui/react, rendered by react-dom/server. */
function realRender(props: TenantSelectProps): string {
  const adminRequire = createRequire(join(ADMIN_WEB, 'package.json'));
  const realReact = adminRequire('react') as { createElement: (type: unknown, props: unknown) => unknown };
  const { renderToStaticMarkup } = adminRequire('react-dom/server') as {
    renderToStaticMarkup: (element: unknown) => string;
  };
  const baseUi = adminRequire('@base-ui/react');
  const lucide = adminRequire('lucide-react');

  const load = (code: string, requireMap: (name: string) => unknown): Record<string, unknown> => {
    const exports: Record<string, unknown> = {};
    runInNewContext(code, {
      exports,
      module: { exports },
      React: realReact,
      require: requireMap,
    });
    return exports;
  };

  const selectModule = load(compile(SELECT_SOURCE), (name) => {
    if (name === 'react') return realReact;
    if (name === '@base-ui/react') return baseUi;
    if (name === 'lucide-react') return lucide;
    // Only the class-name helper is replaced; every rendered element and prop is the real one.
    if (name === '@/lib/utils') return { cn: (...parts: unknown[]) => parts.filter(Boolean).join(' ') };
    throw new Error('unexpected select.tsx import: ' + name);
  });

  const componentModule = load(tenantSelectCode, (name) => {
    if (name === 'react') return realReact;
    if (name === './select') return selectModule;
    if (name === '@/lib/api') return { createAdminApiClient: () => ({ listTenants: async () => okPage([]) }) };
    throw new Error('unexpected tenant-select.tsx import: ' + name);
  });

  const TenantSelect = componentModule['TenantSelect'];
  if (typeof TenantSelect !== 'function') throw new Error('real render could not load TenantSelect');
  return renderToStaticMarkup(realReact.createElement(TenantSelect, props));
}

describe('F-4 TenantSelect — real render (react-dom/server + real @base-ui/react)', () => {
  it('renders the initial loading state as real HTML with the trigger semantics intact', () => {
    const html = realRender({ id: 'f4-tenant', value: null, onValueChange: () => {}, label: 'Tenant' });

    expect(html).toContain('<label for="f4-tenant"');
    expect(html).toContain('>Tenant</label>');
    expect(html).toContain('id="f4-tenant"');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-label="Tenant"');
    expect(html).toContain('aria-describedby="f4-tenant-status"');
    expect(html).toContain('disabled');
    expect(html).toContain('Loading tenants…');
    expect(html).toContain('Loading tenant names…');
    // No roster has arrived yet: no tenant id, no option text, no unavailable claim.
    expect(html).not.toContain(TENANT_A);
    expect(html).not.toContain(TENANT_B);
    expect(html).not.toContain('Tenant list unavailable');
    expect(html).not.toContain('All tenants');
  });

  it('wires aria-describedby to the description plus the status line and can omit the label', () => {
    const html = realRender({
      id: 'f4-tenant-desc',
      value: null,
      onValueChange: () => {},
      label: null,
      description: 'Locked to your tenant session.',
    });

    expect(html).not.toContain('<label');
    expect(html).toContain('aria-describedby="f4-tenant-desc-description f4-tenant-desc-status"');
    expect(html).toContain('Locked to your tenant session.');
    expect(html).toContain('id="f4-tenant-desc-description"');
  });

  it('renders a disabled trigger when the disabled prop is set, without inventing a selection', () => {
    const html = realRender({ id: 'f4-tenant-disabled', value: null, onValueChange: () => {}, disabled: true });

    expect(html).toContain('disabled');
    expect(html).toContain('Loading tenants…');
    expect(html).not.toContain('data-placeholder="false"');
  });
});

describe('F-4 TenantSelect — roster-driven behaviour (real component, element tree)', () => {
  it('(1) renders one option per roster row: the label is the tenant NAME and the value is the id', async () => {
    const harness = buildRosterHarness(async () =>
      okPage([
        { id: TENANT_A, name: 'Alpha', state: 'ACTIVE' },
        { id: TENANT_B, name: 'Beta', state: 'SUSPENDED' },
      ]),
    );
    const tree = await harness.settle({ id: 'tenant-picker', value: TENANT_A, onValueChange: () => {} });

    expect(optionLabels(tree)).toEqual(['Alpha', 'Beta (SUSPENDED)']);
    expect(optionValues(tree)).toEqual([TENANT_A, TENANT_B]);

    const text = textOf(tree);
    expect(text).toContain('Alpha');
    expect(text).not.toContain(TENANT_A);
    expect(text).not.toContain(TENANT_B);

    const root = find(tree, (node) => node.type === 'SelectRoot');
    expect(root?.props['value']).toBe(TENANT_A);
    expect(root?.props['disabled']).toBe(false);
    expect(harness.calls).toHaveLength(1);
    expect(harness.calls[0]).toMatchObject({ limit: '100' });
  });

  it('(1b) keeps the All tenants sentinel first when allowAll is on, and never as a roster value', async () => {
    const harness = buildRosterHarness(async () =>
      okPage([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }]),
    );
    const tree = await harness.settle({
      id: 'tenant-picker',
      value: null,
      onValueChange: () => {},
      allowAll: true,
    });

    expect(optionLabels(tree)).toEqual(['All tenants', 'Alpha']);
    expect(optionValues(tree)).toEqual([ALL_TENANTS_VALUE, TENANT_A]);
    expect(find(tree, (node) => node.type === 'SelectRoot')?.props['value']).toBe(ALL_TENANTS_VALUE);
  });

  it('(2) a tenantId that is not in the roster selects nothing and shows the picker placeholder', async () => {
    const changes: (string | null)[] = [];
    const harness = buildRosterHarness(async () =>
      okPage([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }]),
    );
    const tree = await harness.settle({
      id: 'tenant-picker',
      value: TENANT_UNKNOWN,
      onValueChange: (next) => changes.push(next),
    });

    const root = find(tree, (node) => node.type === 'SelectRoot');
    expect(root?.props['value']).toBeNull();
    expect(find(tree, (node) => node.type === 'SelectValue')?.props['placeholder']).toBe('Select a tenant');
    expect(optionValues(tree)).toEqual([TENANT_A]);
    // An id outside the roster is never displayed as a selection and never re-reported.
    expect(changes).toEqual([]);
    expect(textOf(tree)).not.toContain(TENANT_UNKNOWN);
  });

  it('(2b) a tenantId is only displayed once the roster confirms it (loading shows the loading placeholder)', async () => {
    const harness = buildRosterHarness(() => new Promise(() => {}));
    const tree = await harness.settle({ id: 'tenant-picker', value: TENANT_A, onValueChange: () => {} });

    expect(find(tree, (node) => node.type === 'SelectRoot')?.props['value']).toBeNull();
    expect(find(tree, (node) => node.type === 'SelectValue')?.props['placeholder']).toBe('Loading tenants…');
    expect(find(tree, (node) => node.type === 'SelectRoot')?.props['disabled']).toBe(true);
    expect(optionValues(tree)).toEqual([]);
  });

  it('(3) submitting reports the exact roster id (never the label) and All reports null', async () => {
    const changes: (string | null)[] = [];
    const harness = buildRosterHarness(async () =>
      okPage([
        { id: TENANT_A, name: 'Alpha', state: 'ACTIVE' },
        { id: TENANT_B, name: 'Beta', state: 'ACTIVE' },
      ]),
    );
    const tree = await harness.settle({
      id: 'tenant-picker',
      value: null,
      onValueChange: (next) => changes.push(next),
    });
    const root = find(tree, (node) => node.type === 'SelectRoot');
    const onValueChange = root?.props['onValueChange'] as (value: string | null) => void;

    onValueChange(TENANT_A);
    expect(changes).toEqual([TENANT_A]);
    onValueChange(TENANT_B);
    expect(changes).toEqual([TENANT_A, TENANT_B]);
    // A label, an unknown id or a null must never reach the parent as a tenant value.
    onValueChange('Alpha');
    onValueChange(TENANT_UNKNOWN);
    onValueChange(null);
    expect(changes).toEqual([TENANT_A, TENANT_B]);

    const allChanges: (string | null)[] = [];
    const allHarness = buildRosterHarness(async () =>
      okPage([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }]),
    );
    const allTree = await allHarness.settle({
      id: 'tenant-picker',
      value: null,
      onValueChange: (next) => allChanges.push(next),
      allowAll: true,
    });
    const allRoot = find(allTree, (node) => node.type === 'SelectRoot');
    (allRoot?.props['onValueChange'] as (value: string | null) => void)(ALL_TENANTS_VALUE);
    expect(allChanges).toEqual([null]);
  });

  it('(4) a failed roster read re-points nothing, offers no stale option and fails closed', async () => {
    const changes: (string | null)[] = [];
    const harness = buildRosterHarness(async () => ({
      ok: false,
      problem: { status: 503, code: 'UPSTREAM_UNAVAILABLE', title: 'unavailable' },
    }));
    const tree = await harness.settle({
      id: 'tenant-picker',
      value: TENANT_A,
      onValueChange: (next) => changes.push(next),
    });

    // The parent's selection is NOT re-pointed to another tenant: nothing is reported at all.
    expect(changes).toEqual([]);
    const root = find(tree, (node) => node.type === 'SelectRoot');
    expect(root?.props['value']).toBeNull();
    expect(root?.props['disabled']).toBe(true);
    expect(optionValues(tree)).toEqual([]);
    expect(find(tree, (node) => node.type === 'SelectValue')?.props['placeholder']).toBe(
      'Tenant list unavailable',
    );
    const alert = find(tree, (node) => node.props['role'] === 'alert');
    expect(alert?.children.flat(Infinity).join('')).toBe('Tenant names are unavailable for this session.');

    // Adversarial: even if the picker hands back a real roster id, a failed roster read must not
    // turn it into a selection - the component holds no roster to validate against.
    (root?.props['onValueChange'] as (value: string | null) => void)(TENANT_A);
    (root?.props['onValueChange'] as (value: string | null) => void)(TENANT_B);
    expect(changes).toEqual([]);
  });

  it('(4b) a repeating roster cursor is a failed read, not an endless loop and not a selection', async () => {
    const changes: (string | null)[] = [];
    const harness = buildRosterHarness(async () =>
      okPage([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }], 'SAME-CURSOR'),
    );
    const tree = await harness.settle({
      id: 'tenant-picker',
      value: TENANT_A,
      onValueChange: (next) => changes.push(next),
    });

    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]).toMatchObject({ cursor: 'SAME-CURSOR' });
    expect(changes).toEqual([]);
    expect(find(tree, (node) => node.type === 'SelectRoot')?.props['value']).toBeNull();
    expect(optionValues(tree)).toEqual([]);
    expect(find(tree, (node) => node.type === 'SelectValue')?.props['placeholder']).toBe(
      'Tenant list unavailable',
    );
  });

  it('(4c) an empty roster is its own state: no options, disabled, and no unavailable alert', async () => {
    const harness = buildRosterHarness(async () => okPage([]));
    const tree = await harness.settle({ id: 'tenant-picker', value: null, onValueChange: () => {} });

    expect(optionValues(tree)).toEqual([]);
    expect(find(tree, (node) => node.type === 'SelectRoot')?.props['disabled']).toBe(true);
    expect(find(tree, (node) => node.type === 'SelectValue')?.props['placeholder']).toBe('No tenants available');
    expect(find(tree, (node) => node.props['role'] === 'alert')).toBeUndefined();
  });

  it('(4d) a roster read that fails AFTER a successful page discards the partial roster', async () => {
    const changes: (string | null)[] = [];
    const harness = buildRosterHarness(async (query) =>
      query['cursor'] === undefined
        ? okPage([{ id: TENANT_A, name: 'Alpha', state: 'ACTIVE' }], 'PAGE-2')
        : { ok: false, problem: { status: 503, code: 'UPSTREAM_UNAVAILABLE', title: 'unavailable' } },
    );
    const tree = await harness.settle({
      id: 'tenant-picker',
      value: TENANT_A,
      onValueChange: (next) => changes.push(next),
    });

    // Page 1 really did carry a row; page 2 failed. The partially loaded roster must not be
    // presented as if it were complete, and the parent's selection must not be re-pointed.
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[1]).toMatchObject({ cursor: 'PAGE-2' });
    expect(changes).toEqual([]);
    expect(optionValues(tree)).toEqual([]);
    expect(find(tree, (node) => node.type === 'SelectRoot')?.props['value']).toBeNull();
    expect(find(tree, (node) => node.type === 'SelectValue')?.props['placeholder']).toBe(
      'Tenant list unavailable',
    );
    expect(textOf(tree)).not.toContain('Alpha');
  });
});
