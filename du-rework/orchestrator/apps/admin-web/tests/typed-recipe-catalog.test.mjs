import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import ts from 'typescript';

const tenantId = '00000000-0000-0000-0000-000000000001';
const casedTenantId = 'abcdefab-cdef-4abc-8def-abcdefabcdef';

function extractDeclarations(source, fileName, functionNames, variableNames) {
  const sourceFile = ts.createSourceFile(fileName, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const remainingFunctions = new Set(functionNames);
  const remainingVariables = new Set(variableNames);
  const declarations = [];
  for (const statement of sourceFile.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name && remainingFunctions.has(statement.name.text)) {
      declarations.push(statement.getText(sourceFile).replace(/^export\s+/, ''));
      remainingFunctions.delete(statement.name.text);
    } else if (ts.isVariableStatement(statement)) {
      const matches = statement.declarationList.declarations.filter(
        (declaration) => ts.isIdentifier(declaration.name) && remainingVariables.has(declaration.name.text),
      );
      if (matches.length > 0) {
        declarations.push(statement.getText(sourceFile).replace(/^export\s+/, ''));
        for (const declaration of matches) remainingVariables.delete(declaration.name.text);
      }
    }
  }
  assert.deepEqual([...remainingFunctions], []);
  assert.deepEqual([...remainingVariables], []);
  return declarations.join('\n\n');
}

const source = await readFile(new URL('../src/features/connectors/typed-recipe-catalog.ts', import.meta.url), 'utf8');
const declarations = extractDeclarations(source, 'typed-recipe-catalog.ts',
  ['isRecord', 'hasOnlyKeys', 'isCurrentTenantRequest', 'isCurrentTenantConnectorRequest', 'isTypedRecipeRevisionCoveredByHead', 'shouldShowTypedCatalogPageControls', 'parseTypedConnectorRecipeCatalogPage', 'resolveTypedRecipeChainHead'],
  ['TENANT_UUID', 'RECIPE_STATES', 'RECIPE_ADAPTERS', 'AUTH_KINDS', 'PAGE_KEYS', 'ITEM_KEYS', 'MAX_RECIPE_HEAD_PAGES']);
const compiled = ts.transpileModule(declarations, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
}).outputText;
const { isCurrentTenantRequest, isCurrentTenantConnectorRequest, isTypedRecipeRevisionCoveredByHead, shouldShowTypedCatalogPageControls, parseTypedConnectorRecipeCatalogPage, resolveTypedRecipeChainHead } = new Function(`${compiled}\nreturn { isCurrentTenantRequest, isCurrentTenantConnectorRequest, isTypedRecipeRevisionCoveredByHead, shouldShowTypedCatalogPageControls, parseTypedConnectorRecipeCatalogPage, resolveTypedRecipeChainHead };`)();
const editorSource = await readFile(new URL('../src/features/connectors/parity-connector-editor.tsx', import.meta.url), 'utf8');

function item(overrides = {}) {
  return {
    tenantId,
    connectorId: 'codex-ui-check-20261014',
    revision: 1,
    state: 'PENDING',
    adapter: 'json-http',
    authKind: 'none',
    credentialConfigured: false,
    ...overrides,
  };
}

function page(items = [item()], overrides = {}) {
  return { tenantId, items, limit: 50, nextCursor: null, ...overrides };
}

describe('typed recipe catalog browser reader', () => {
  it('accepts the default tenant sentinel and persisted typed lifecycle states', () => {
    for (const state of ['PENDING', 'ACTIVE', 'RETIRED']) {
      const result = parseTypedConnectorRecipeCatalogPage(page([item({ state })]), tenantId);
      assert.equal(result?.items[0]?.state, state);
    }
    assert.equal(parseTypedConnectorRecipeCatalogPage({
      tenantId: casedTenantId,
      items: [item({ tenantId: casedTenantId })],
      limit: 50,
      nextCursor: null,
    }, casedTenantId.toUpperCase())?.tenantId, casedTenantId);
  });

  it('fails closed on tenant mismatch, unknown state, and secret-bearing fields', () => {
    assert.equal(parseTypedConnectorRecipeCatalogPage(page([item({ tenantId: '22222222-2222-4222-8222-222222222222' })]), tenantId), null);
    assert.equal(parseTypedConnectorRecipeCatalogPage(page([item({ state: 'DISABLED' })]), tenantId), null);
    assert.equal(parseTypedConnectorRecipeCatalogPage(page([item({ endpointUrl: 'https://secret.invalid', staticHeader: 'secret-value' })]), tenantId), null);
    assert.equal(parseTypedConnectorRecipeCatalogPage(page(), 'invalid-tenant'), null);
    assert.equal(parseTypedConnectorRecipeCatalogPage(page([item()], { limit: 101 }), tenantId), null);
  });

  it('keeps pagination visible for an empty bounded page with a continuation cursor', () => {
    assert.equal(shouldShowTypedCatalogPageControls(page([], { nextCursor: 'continuation' }), 0), true);
    assert.equal(shouldShowTypedCatalogPageControls(page([], { nextCursor: null })), false);
    assert.equal(shouldShowTypedCatalogPageControls(page([], { nextCursor: null }), 1), true);
  });

  it('resolves the current head from every cursor page and filters exact tenant and Connector IDs', async () => {
    const connectorId = 'codex-ui-check-20261014';
    const cursors = [];
    const pages = new Map([
      [null, page([
        item({ connectorId, revision: 1 }),
        item({ connectorId: `${connectorId}-other`, revision: 99 }),
      ], { nextCursor: 'cursor-page-2' })],
      ['cursor-page-2', page([
        item({ connectorId, revision: 2, state: 'ACTIVE' }),
        item({ connectorId: 'another-connector', revision: 50 }),
      ])],
    ]);

    const head = await resolveTypedRecipeChainHead(tenantId, connectorId, async (cursor) => {
      cursors.push(cursor);
      const result = pages.get(cursor);
      assert.ok(result, `unexpected cursor ${cursor}`);
      return result;
    });

    assert.equal(head, 2);
    assert.deepEqual(cursors, [null, 'cursor-page-2']);
  });

  it('fails closed when the verified head does not cover the exact loaded revision', () => {
    assert.equal(isTypedRecipeRevisionCoveredByHead(4, 4), true);
    assert.equal(isTypedRecipeRevisionCoveredByHead(5, 4), true);
    assert.equal(isTypedRecipeRevisionCoveredByHead(3, 4), false);
    assert.equal(isTypedRecipeRevisionCoveredByHead(0, 1), false);
    assert.equal(isTypedRecipeRevisionCoveredByHead(Number.NaN, 1), false);
  });

  it('drops delayed mutation commits after tenant, request-generation, or Connector selection changes', async () => {
    const tenantA = '11111111-1111-4111-8111-111111111111';
    const tenantB = '22222222-2222-4222-8222-222222222222';
    let activeTenantId = tenantA;
    let generation = 1;
    let selectedConnectorId = 'connector-a';
    let committed = null;
    let resolveSave;
    const saveResponse = new Promise((resolve) => { resolveSave = resolve; });
    const captured = { tenantId: tenantA, generation: 1, connectorId: 'connector-a' };
    const delayedCommit = saveResponse.then((response) => {
      if (isCurrentTenantConnectorRequest(activeTenantId, captured.tenantId, captured.generation, generation, selectedConnectorId, captured.connectorId)) {
        committed = response;
      }
    });

    activeTenantId = tenantB;
    generation = 2;
    selectedConnectorId = 'connector-b';
    resolveSave({ revision: 'tenant-a-result' });
    await delayedCommit;
    assert.equal(committed, null);

    assert.equal(isCurrentTenantConnectorRequest(tenantA, tenantA, 1, 2, 'connector-a', 'connector-a'), false);
    assert.equal(isCurrentTenantConnectorRequest(tenantA, tenantA, 2, 2, 'connector-b', 'connector-a'), false);
    assert.equal(isCurrentTenantConnectorRequest(tenantB, tenantB, 2, 2, 'connector-b', 'connector-b'), true);
  });

  it('guards save, rollback, and activation reread writes and never restores a historical base as current head', () => {
    assert.equal((editorSource.match(/if \(!isCurrentMutation\(\)\) return;/g) ?? []).length, 4);
    assert.equal((editorSource.match(/setExpectedHeadRevision\(revision\.revision\)/g) ?? []).length, 2);
    assert.doesNotMatch(editorSource, /setExpectedHeadRevision\(reread\.data\.expectedHeadRevision\)/);
    assert.match(editorSource, /const currentHeadRevision = await resolveTypedRecipeChainHead|currentHeadRevision = await resolveTypedRecipeChainHead/);
  });

  it('fails closed when head pagination repeats a cursor or has not completed within its bound', async () => {
    await assert.rejects(
      resolveTypedRecipeChainHead(tenantId, 'codex-ui-check-20261014', async () => page([], { nextCursor: 'same-cursor' })),
      /repeated or invalid cursor/,
    );
    await assert.rejects(
      resolveTypedRecipeChainHead(tenantId, 'codex-ui-check-20261014', async () => page([], { limit: 101 })),
      /could not verify/,
    );
    let pageCount = 0;
    await assert.rejects(
      resolveTypedRecipeChainHead(tenantId, 'codex-ui-check-20261014', async () => {
        pageCount += 1;
        return page([], { nextCursor: `cursor-${pageCount}` });
      }),
      /safe head-check page limit/,
    );
    assert.equal(pageCount, 100);
  });

  it('rejects wrong-tenant catalog pages and items', async () => {
    await assert.rejects(
      resolveTypedRecipeChainHead(tenantId, 'codex-ui-check-20261014', async () => page([], {
        tenantId: '22222222-2222-4222-8222-222222222222',
      })),
      /could not verify the selected tenant/,
    );
    await assert.rejects(
      resolveTypedRecipeChainHead(tenantId, 'codex-ui-check-20261014', async () => page([
        item({ tenantId: '22222222-2222-4222-8222-222222222222' }),
      ])),
      /crossed the selected tenant boundary/,
    );
  });

  it('drops delayed tenant bootstrap and exact Open responses after a newer tenant request starts', async () => {
    const tenantA = '11111111-1111-4111-8111-111111111111';
    const tenantB = 'abcdefab-cdef-4abc-8def-abcdefabcdef';
    let activeTenantId = tenantA;
    let generation = 1;
    let typedReadStarted = false;
    let loaded = null;
    let resolveLegacy;
    const legacy = new Promise((resolve) => { resolveLegacy = resolve; });
    const oldBootstrap = legacy.then(() => {
      if (isCurrentTenantRequest(activeTenantId, tenantA, 1, generation)) typedReadStarted = true;
    });

    activeTenantId = tenantB;
    generation = 2;
    assert.equal(isCurrentTenantRequest(activeTenantId, tenantA, 1, generation), false);
    let resolveOpenA;
    let resolveOpenB;
    const openA = new Promise((resolve) => { resolveOpenA = resolve; });
    const openB = new Promise((resolve) => { resolveOpenB = resolve; });
    const applyOpen = (tenantId, requestGeneration, response) => {
      if (isCurrentTenantRequest(activeTenantId, tenantId, requestGeneration, generation)) loaded = response;
    };
    const aResult = openA.then((response) => applyOpen(tenantA, 1, response));
    const bResult = openB.then((response) => applyOpen(tenantB, 2, response));
    resolveOpenB({ connectorId: 'connector-b', revision: 2, recipe: 'recipe-b', head: 2 });
    await bResult;
    resolveOpenA({ connectorId: 'connector-a', revision: 1, recipe: 'recipe-a', head: 1 });
    await aResult;
    resolveLegacy();
    await oldBootstrap;

    assert.deepEqual(loaded, { connectorId: 'connector-b', revision: 2, recipe: 'recipe-b', head: 2 });
    assert.equal(typedReadStarted, false);
  });

  it('accepts equivalent uppercase UUIDs while rejecting a genuinely different tenant', () => {
    assert.equal(isCurrentTenantRequest(casedTenantId, casedTenantId.toUpperCase(), 4, 4), true);
    assert.equal(isCurrentTenantRequest(tenantId, '22222222-2222-4222-8222-222222222222', 4, 4), false);
  });
});
