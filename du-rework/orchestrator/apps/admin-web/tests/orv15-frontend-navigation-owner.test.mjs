import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [appShell, systemOperationsRoute, operationsScreen, incidentsConsole] = await Promise.all([
  readSource('../src/app-shell/app-shell.tsx'),
  readSource('../src/routes/system-operations.tsx'),
  readSource('../src/features/operations/operations-screen.tsx'),
  readSource('../src/features/system-operations/incidents-console.tsx'),
]);

describe('ORV15 admin navigation and operational page density', () => {
  it('keeps System operations in Workspace while preserving its contextual route tabs', () => {
    assert.match(appShell, /\{ label: 'Workspace', items: \[\['Overview', '\/overview'\], \['Trace', '\/trace'\], \['System operations', '\/system-operations'\], \['Usage', '\/usage'\]\] \}/);
    assert.doesNotMatch(appShell, /\{ label: 'System operations'/);
    for (const path of [
      "['Cockpit', 'cockpit', '/system-operations']",
      "['Services', 'services', '/system-operations/services']",
      "['Workers & Queues', 'workers-queues', '/system-operations/workers-queues']",
      "['Incidents', 'incidents', '/system-operations/incidents']",
      "['Deployments', 'deployments', '/system-operations/deployments']",
      "['Maintenance', 'maintenance', '/system-operations/maintenance']",
    ]) assert.ok(systemOperationsRoute.includes(path), `missing route tab ${path}`);
    assert.match(systemOperationsRoute, /\(\[, key\]\) => key !== 'incidents' \|\| canReadIncidentLedger\(session\)/);
    assert.doesNotMatch(appShell, /\['Services', '\/system-operations\/services'\]/);
  });

  it('puts Operations inside Trace and retains query-safe legacy navigation', async () => {
    const traceRoute = await readSource('../src/routes/trace.tsx');
    const operationsRoute = await readSource('../src/routes/operations.tsx');
    assert.match(traceRoute, /aria-label="Trace workspace views"/);
    assert.match(traceRoute, /searchParams\.get\('view'\) === 'operations'/);
    assert.match(traceRoute, /<OperationsWorkspaceView rawTenantId=\{searchParams\.get\('tenantId'\)\} \/>/);
    assert.match(traceRoute, /The tenant in this link is not available to this session/);
    assert.match(operationsRoute, /legacyOperationsWorkspacePath\(location\.search, location\.hash\)/);
  });

  it('keeps access and documentation paths reachable through contextual route links and the platform API-key gate', () => {
    for (const path of ["['Security', '/security']", "['Identity', '/identity']", "['API Keys', '/api-keys']", "['Secrets', '/secrets']"]) {
      assert.ok(appShell.includes(path), `missing access route ${path}`);
    }
    assert.match(appShell, /session\?\.role === 'admin' && session\.principal\.kind === 'platform'/);
    assert.ok(appShell.includes("['API Reference', '/api-docs']"));
    assert.ok(appShell.includes("['Documentation', '/docs']"));
    assert.match(appShell, /<NavLink key=\{href\} to=\{href\} end/);
  });

  it('keeps operation filtering URL-driven while bounding the results and using server cursors for paging', () => {
    assert.match(operationsScreen, /<details open=\{advancedFiltersOpen\}/);
    assert.match(operationsScreen, /<TableContainer maxHeight="65dvh" role="region" aria-label="Operations results">/);
    assert.match(operationsScreen, /hasPreviousPage=\{page\.kind === 'ready' && Boolean\(page\.data\.prevCursor\)\}/);
    assert.match(operationsScreen, /hasNextPage=\{page\.kind === 'ready' && Boolean\(page\.data\.nextCursor\)\}/);
    assert.match(operationsScreen, /onNextPage=\{page\.kind === 'ready' \? \(\) => applyCursor\(page\.data\.nextCursor \?\? null\) : undefined\}/);
  });

  it('keeps the incident keyset cursor while making the ledger region bounded and compact', () => {
    assert.match(incidentsConsole, /<TableContainer maxHeight="65dvh" role="region" aria-label="Incident results">/);
    assert.match(incidentsConsole, /<TableHeader sticky>/);
    assert.match(incidentsConsole, /onPreviousPage=\{\(\) => updateSearch\(\(params\) => params\.delete\('cursor'\)\)\}/);
    assert.match(incidentsConsole, /onNextPage=\{\(\) => updateSearch\(\(params\) => params\.set\('cursor', page\.data\.nextCursor!\)\)\}/);
    assert.match(incidentsConsole, /canReadIncidentLedger\(session\)/);
  });
});
