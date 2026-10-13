import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const source = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [appShell, secrets, audit, usage, adjustment, policy, security, trace, apiKeys, identity, workflows, overview] = await Promise.all([
  source('../src/app-shell/app-shell.tsx'),
  source('../src/features/secrets/secrets-screen.tsx'),
  source('../src/features/audit/audit-screen.tsx'),
  source('../src/features/usage/usage-screen.tsx'),
  source('../src/features/usage/cost-adjustment-panel.tsx'),
  source('../src/features/usage/cost-policy-panel.tsx'),
  source('../src/features/security/security-screen.tsx'),
  source('../src/features/trace/trace-screen.tsx'),
  source('../src/features/api-keys/api-keys-screen.tsx'),
  source('../src/features/identity/identity-screen.tsx'),
  source('../src/features/workflows/workflows-screen.tsx'),
  source('../src/features/overview/operations-monitor-dashboard.tsx'),
]);

describe('ORV15 bounded frontend repair packet', () => {
  it('keeps secret catalog paging server-cursor based and resets cursor history with tenant scope', () => {
    assert.match(secrets, /const query: Record<string, string> = \{ limit: '50' \}/);
    assert.match(secrets, /if \(requestedCursor !== null\) query\.cursor = requestedCursor/);
    assert.match(secrets, /setNextCursor\(page\.nextCursor\)/);
    assert.match(secrets, /setPageNavigation\(\{ tenantScope, cursors: \[null\], index: 0 \}\)/);
    assert.match(secrets, /void load\(null, 'first'\)/);
    assert.match(secrets, /cursors: \[\.\.\.base\.cursors\.slice\(0, base\.index \+ 1\), requestedCursor\]/);
    assert.match(secrets, /currentCursorRef\.current = \{ tenantScope, cursor: requestedCursor \}/);
    assert.match(secrets, /cursorState\.tenantScope === tenantScope \? cursorState\.cursor : null/);
    assert.match(secrets, /if \(tenantScopeRef\.current !== tenantScope\) return/);
    assert.match(secrets, /tenantScopeRef\.current === tenantScope\s+&& sequence === loadSequenceRef\.current/);
    assert.match(secrets, /if \(isCurrentRequest\(\)\) setLoading\(false\)/);
    assert.match(secrets, /useLayoutEffect\(\(\) => \{[\s\S]*?loadSequenceRef\.current \+= 1/);
    for (const label of ['First', 'Previous', 'Next']) assert.ok(secrets.includes(`>${label}</Button>`), `missing ${label} cursor control`);
    assert.match(secrets, /setCreateDraft\(emptyCreateDraft\(\)\)/);
    assert.match(secrets, /unknown/i);
  });

  it('bounds and names long result/catalog regions while retaining their existing paging and mutation guards', () => {
    assert.match(audit, /<TableContainer maxHeight="65dvh" aria-label="Audit events table">/);
    assert.match(audit, /<Table density="compact">[\s\S]*?<TableHeader sticky>/);
    assert.match(audit, /applyCursor\(page\.data\.prevCursor\)/);
    assert.match(usage, /<TableContainer maxHeight="65dvh" role="region" aria-label="Usage event ledger table"/);
    assert.match(usage, /export contains this page only/);
    assert.match(adjustment, /max-h-\[min\(65dvh,32rem\)\][^>]*role='region' aria-label='Loaded cost adjustment history'/);
    assert.match(adjustment, /unknownPending/);
    assert.match(policy, /aria-label="Budget revision history"/);
    assert.match(policy, /aria-label="Price revision history"/);
    assert.match(apiKeys, /role="region" aria-label="Loaded API keys"/);
    assert.match(apiKeys, /noteDrafts\[key\.id\]/);
    assert.match(apiKeys, /page\.prevCursor/);
    assert.match(identity, /role="region" aria-label="Loaded Identity users"/);
    assert.match(identity, /!canWriteUsers \|\| saving/);
    assert.match(overview, /aria-label="Latest loaded operations"/);
    assert.match(workflows, /aria-label=\{`Connector slot mappings for workflow \$\{selectedWorkflow\.name\}`\}/);
  });

  it('aligns trace and security actions with control rows and constrains account text on narrow screens', () => {
    assert.match(trace, /md:items-start/);
    assert.match(trace, /md:pt-\[1\.375rem\]/);
    assert.match(security, /<CardTitle>Apply a change<\/CardTitle>[\s\S]*?<Button type="button" variant="outline" onClick=\{\(\) => void load\(\)\}/);
    assert.doesNotMatch(security, /<CardTitle>Tenant scope<\/CardTitle>/);
    assert.match(security, /state\.kind === 'idle' && !tenantId\.trim\(\)[\s\S]*?Select a tenant in the left navigator/);
    assert.match(appShell, /max-w-\[calc\(100vw-13rem\)\] truncate sm:max-w-\[12rem\]/);
    assert.match(appShell, /<span className="shrink-0"> · Profile<\/span>/);
  });
});
