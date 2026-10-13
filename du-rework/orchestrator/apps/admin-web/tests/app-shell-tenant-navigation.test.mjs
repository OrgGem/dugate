import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [appShell, shellPrimitives, audit, businesses, operations, overview, profiles, secrets, security, trace, usage, workflows, apiKeys, identity, docs, costPolicy] = await Promise.all([
  readSource('../src/app-shell/app-shell.tsx'),
  readSource('../src/components/ui/app-shell-primitives.tsx'),
  readSource('../src/features/audit/audit-screen.tsx'),
  readSource('../src/features/businesses/businesses-screen.tsx'),
  readSource('../src/features/operations/operations-screen.tsx'),
  readSource('../src/features/overview/overview-screen.tsx'),
  readSource('../src/features/profiles/profiles-screen.tsx'),
  readSource('../src/features/secrets/secrets-screen.tsx'),
  readSource('../src/features/security/security-screen.tsx'),
  readSource('../src/features/trace/trace-screen.tsx'),
  readSource('../src/features/usage/usage-screen.tsx'),
  readSource('../src/features/workflows/workflows-screen.tsx'),
  readSource('../src/features/api-keys/api-keys-screen.tsx'),
  readSource('../src/features/identity/identity-screen.tsx'),
  readSource('../src/features/docs/docs-screen.tsx'),
  readSource('../src/features/usage/cost-policy-panel.tsx'),
]);

describe('global tenant navigation presentation', () => {
  it('keeps one selector above the independently scrollable navigation links at every breakpoint', () => {
    assert.equal((appShell.match(/<GlobalTenantSelector \/>/g) ?? []).length, 1);
    assert.match(appShell, /<TenantProvider>[\s\S]*?<AppShellContent \/>[\s\S]*?<\/TenantProvider>/);
    assert.match(appShell, /className="[^"]*lg:sticky lg:top-0 lg:h-\[100dvh\][^"]*"/);
    assert.match(appShell, /<AppShellBrand title="Orchestrator Portal" \/>[\s\S]*?<GlobalTenantSelector \/>/);
    assert.match(appShell, /<GlobalTenantSelector \/>[\s\S]*?lg:hidden[\s\S]*?aria-controls="admin-navigation-links"/);
    assert.match(appShell, /id="admin-navigation-links"[\s\S]*?\$\{navOpen \? 'block' : 'hidden'\}[\s\S]*?lg:min-h-0 lg:flex-1 lg:overflow-y-auto/);
    assert.match(shellPrimitives, /sticky top-0 z-40 lg:static lg:z-auto/);
  });

  it('makes navigation hierarchy visible and keeps links grouped for assistive technology', () => {
    assert.match(appShell, /aria-label="Orchestrator Portal Navigation"/);
    assert.match(appShell, /<section key=\{group\.label\} aria-labelledby=\{`admin-navigation-group-\$\{index\}`\}/);
    assert.match(appShell, /<h2 id=\{`admin-navigation-group-\$\{index\}`\}/);
    assert.match(appShell, /<ul className="ml-5 space-y-0\.5 border-l-2 border-\[var\(--border-subtle\)\] pl-4">/);
    assert.match(appShell, /focus-visible:ring-2 focus-visible:ring-\[var\(--focus-ring\)\]/);
  });

  it('removes redundant page-level selected-tenant labels while keeping tenant guards and auth scope', () => {
    for (const [screen, pattern] of [
      [audit, /Active tenant scope/],
      [businesses, /Global Tenant:/],
      [operations, /<span className="text-\[var\(--text-sub\)\]">Tenant:<\/span>/],
      [overview, /activeTenantName|Operations are filtered to the active tenant selection/],
      [profiles, /Global Tenant:|Tenant scope:/],
      [secrets, /Inherited from Global Tenant|Active Tenant/],
      [security, /<CardTitle>Tenant scope<\/CardTitle>|Active tenant/],
      [trace, /Tenant scope: \{tenant/],
      [usage, /<span className="font-medium text-\[var\(--text-main\)\]">Active tenant<\/span>/],
      [workflows, /Organization: <strong/],
      [apiKeys, /Managing <strong>\{tenant\.name\}/],
      [identity, /Tenant: <strong>\{tenant\.name\}/],
      [docs, /Tenant scope: <code>\{tenantId\}/],
      [costPolicy, /Active tenant: \{tenantId\}/],
    ]) assert.doesNotMatch(screen, pattern);

    assert.match(appShell, /<TenantProvider>/);
    assert.match(security, /!tenantId\.trim\(\)/);
    assert.match(profiles, /!globalTenantId/);
    assert.match(identity, /sessionState\.session\.scope\?\.kind === 'tenant'/);
    assert.match(docs, /<dt>Tenant<\/dt><dd className="break-all font-mono">\{tenantId \?\? '—'\}<\/dd>/);
  });
});
