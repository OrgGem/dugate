import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';

const readSource = (path) => readFile(new URL(path, import.meta.url), 'utf8');

const [connectors, parityEditor, curlPreview, settings, revisions, migration, storage] = await Promise.all([
  readSource('../src/features/connectors/connectors-screen.tsx'),
  readSource('../src/features/connectors/parity-connector-editor.tsx'),
  readSource('../src/features/connectors/curl-import-preview.tsx'),
  readSource('../src/features/settings/settings-screen.tsx'),
  readSource('../src/features/settings/configuration-revisions.tsx'),
  readSource('../src/features/settings/migration-readiness.tsx'),
  readSource('../src/features/settings/storage-generation-panel.tsx'),
]);

describe('ORV15 connector and settings workspaces', () => {
  it('keeps connector workspaces mounted and pages only the fully loaded catalog locally', () => {
    for (const value of ['catalog', 'inspector', 'recipe', 'curl-import']) {
      assert.match(connectors, new RegExp(`<TabsPanel value="${value}" keepMounted`));
    }
    assert.match(connectors, /const visibleListRows = listRows\.slice\(catalogPage \* catalogPageSize/);
    assert.match(connectors, /connectorActiveRevision\(listRows, row\.connectorId\)/);
    assert.match(connectors, /connectorIdSuggestions\(caps, scopedConnectorRows\)/);
    assert.match(connectors, /typedCatalogRows/);
    assert.match(connectors, /openTypedRecipe\(selectedTypedRecipeRevision\)/);
    assert.match(connectors, /Load legacy revision/);
    assert.match(connectors, /Showing \$\{catalogRangeStart\}–\$\{catalogRangeEnd\} of \$\{listRows\.length\} readable loaded revisions/);
    assert.match(connectors, /setActiveTab\('inspector'\);\s*void fetchRevision\(id, String\(rev\)\)/);
  });

  it('preserves the provider-test reconciliation owner while bounding long editor content', () => {
    assert.match(connectors, /<ParityConnectorEditor[\s\S]*?savedAttempt=\{savedParityAttempt\}/);
    assert.match(parityEditor, /const \[reconcileRequest, setReconcileRequest\]/);
    assert.match(parityEditor, /Boolean\(reconcileRequest\)/);
    assert.match(parityEditor, /aria-label="Advanced Connector recipe JSON" className="mt-3 min-h-64 max-h-\[60vh\]/);
    assert.match(curlPreview, /max-h-\[45vh\]/);
    assert.match(curlPreview, /<TableContainer maxHeight=\{240\}/);
    assert.match(curlPreview, /<TablePagination/);
  });

  it('offers a short provider setup flow and retains advanced typed recipe editing', () => {
    assert.match(parityEditor, /label="Name \(stable Connector ID\)"/);
    assert.match(parityEditor, /id="provider-preset" label="Provider"/);
    for (const provider of ['openai', 'anthropic', 'gemini', 'openai-compatible', 'custom']) {
      assert.match(parityEditor, new RegExp(`<option value="${provider}">`));
    }
    assert.match(parityEditor, /id="recipe-endpoint" label="Provider URL"/);
    assert.match(parityEditor, /id="provider-default-model" label="Model"/);
    assert.match(parityEditor, /id="credential-change" label="Credential action"/);
    assert.match(parityEditor, /id="provider-test-title" className="font-semibold">Test and activate/);
    assert.match(parityEditor, /Advanced recipe configuration/);
    assert.match(parityEditor, /aria-label="Advanced Connector recipe JSON"/);
    assert.doesNotMatch(parityEditor, /promptField: adapter === 'gemini' \? 'contents'/);
  });

  it('keeps the settings editors mounted in their requested tabs and bounds loaded histories', () => {
    for (const value of ['overview', 'scoped-configuration', 'ai-prompts', 'storage-retention', 'migration-reference']) {
      assert.match(settings, new RegExp(`<TabsPanel value='${value}' keepMounted`));
    }
    assert.match(settings, /<ConfigurationRevisions configuration=\{configuration\}/);
    assert.match(settings, /<TenantAiSettingsPanel/);
    assert.match(settings, /<PlatformRetentionPanel/);
    assert.match(settings, /<StorageGenerationPanel/);
    assert.match(settings, /<MigrationReadiness/);
    assert.match(settings, /<TablePagination/);
    assert.match(revisions, /configuration\.revisions\.slice\(page \* PAGE_SIZE/);
    assert.match(revisions, /Showing \$\{rangeStart\}–\$\{rangeEnd\} of \$\{configuration\.revisions\.length\} loaded revisions/);
    assert.match(migration, /runs\?\.slice\(page \* PAGE_SIZE/);
    assert.match(migration, /Showing \$\{rangeStart\}–\$\{rangeEnd\} of \$\{runCount\} loaded migration runs/);
    assert.match(storage, /history\.slice\(historyPage \* GENERATION_PAGE_SIZE/);
    assert.match(storage, /Showing \$\{historyRangeStart\}–\$\{historyRangeEnd\} of \$\{history\.length\} loaded storage generations/);
  });

  it('retains exact-request retry guards for unknown storage mutations and tests', () => {
    assert.match(storage, /unknown && !retrying/);
    assert.match(storage, /runTest\(unknownTestTarget, testUnknown\.request\)/);
    assert.match(storage, /do not activate until a passing receipt is confirmed/);
  });

  it('blocks connector catalog selection during a pending action and labels legacy disposition as future handling', () => {
    assert.match(connectors, /const busyRef = useRef\(false\)/);
    assert.match(connectors, /function inspectCatalogRevision\(id: string, rev: number\): void \{\s+if \(busyRef\.current\) return;/);
    assert.match(connectors, /aria-disabled=\{busy\}[\s\S]*?if \(!busyRef\.current\) inspectCatalogRevision\(row\.connectorId, row\.revision\)/);
    assert.match(connectors, /aria-label=\{`Inspect \$\{row\.connectorId\} revision \$\{row\.revision\}`}\s+disabled=\{busy\}/);
    assert.match(settings, /row\.disposition === 'retire' \? 'Retirement planned' : 'Port mapping'/);
  });
});
