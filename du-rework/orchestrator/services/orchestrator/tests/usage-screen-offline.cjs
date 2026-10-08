// Offline render harness: executes the actual TSX with controlled hooks and API.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const ts = require('typescript');
const source = fs.readFileSync(path.resolve(__dirname, '../../../apps/admin-web/src/features/usage/usage-screen.tsx'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, jsx: ts.JsxEmit.React } }).outputText;
const tenantId = '11111111-1111-4111-8111-111111111111';
const TenantSelect = function TenantSelectMock() {};

async function scenario(scope) {
  const state = [];
  const deps = [];
  let cursor = 0;
  let effects = [];
  const calls = [];
  const client = {
    getSession: async () => ({ ok: true, data: { scope } }),
    getUsage: async query => { calls.push(query); return { ok: true, data: { requests: 1 } }; },
  };
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: initial => { const i = cursor++; if (!(i in state)) state[i] = initial; return [state[i], value => { state[i] = value; }]; },
    useMemo: fn => { const i = cursor++; if (!(i in state)) state[i] = fn(); return state[i]; },
    useCallback: (fn, next) => { const i = cursor++; if (!deps[i] || next.some((v, j) => v !== deps[i][j])) { deps[i] = next; state[i] = fn; } return state[i]; },
    useEffect: (fn, next) => { const i = cursor++; if (!deps[i] || next.some((v, j) => v !== deps[i][j])) { deps[i] = next; effects.push(fn); } },
  };
  const exports = {};
  vm.runInNewContext(compiled, {
    exports,
    React: react,
    require: name => name === 'react'
      ? react
      : name === '@/lib/api'
        ? { createAdminApiClient: () => client }
        : name === '@/components/ui/tenant-select'
          ? { TenantSelect }
          : new Proxy({}, { get: (_, key) => key }),
  });
  async function render() {
    cursor = 0; effects = [];
    const tree = exports.UsageScreen();
    for (const effect of effects) effect();
    await new Promise(resolve => setImmediate(resolve));
    return tree;
  }
  function find(tree, predicate) {
    if (!tree || typeof tree !== 'object') return undefined;
    if (predicate(tree)) return tree;
    return tree.children.flat(Infinity).map(child => find(child, predicate)).find(Boolean);
  }
  await render();
  let tree = await render();
  if (scope.kind === 'tenant') {
    const picker = find(tree, node => node.type === TenantSelect);
    assert.equal(picker.props.value, tenantId, 'tenant session prefilled into TenantSelect');
    assert.equal(picker.props.disabled, true, 'tenant session cannot change its scope');
    assert.equal(picker.props.allowAll, false, 'tenant operator cannot select All tenants');
    assert.equal(calls.length, 1, 'tenant session automatically loads once');
    assert.equal(calls[0].tenantId, tenantId, 'session tenant forwarded by UI');
    return;
  }
  assert.equal(calls.length, 0, 'platform session must not load without tenant');
  let picker = find(tree, node => node.type === TenantSelect);
  assert.ok(picker, 'shared TenantSelect is rendered');
  assert.equal(picker.props.value, '', 'platform session starts without a tenant');
  assert.equal(picker.props.allowAll, true, 'platform can select All tenants');
  picker.props.onValueChange(tenantId);
  tree = await render();
  assert.equal(calls.length, 1, 'platform does not load before a tenant is selected');
  const button = find(tree, node => node.type === 'Button');
  assert.equal(button.props.disabled, false, 'Load enables for a selected tenant');
  picker = find(tree, node => node.type === TenantSelect);
  picker.props.onValueChange(null);
  tree = await render();
  assert.equal(calls.length, 1, 'All tenants does not issue unsupported unscoped request');
  assert.equal(find(tree, node => node.type === 'Button').props.disabled, true, 'Load is disabled for All tenants');
  assert.equal(calls[0].tenantId, tenantId);
}
(async () => {
  await scenario({ kind: 'platform' });
  await scenario({ kind: 'tenant', tenantId });
  console.log('PASS: platform gating, TenantSelect selection, All tenants guard, forwarding, tenant session prefill and lock');
})().catch(error => { console.error(error); process.exitCode = 1; });
