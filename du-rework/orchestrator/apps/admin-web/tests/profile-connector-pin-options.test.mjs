import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { describe, it } from 'node:test';
import ts from 'typescript';

const tenantId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const source = await readFile(new URL('../src/features/profiles/connector-pin-options.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
  fileName: 'connector-pin-options.ts',
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
}).outputText
  .replace("import { TenantActiveConnectorCatalogPageSchema } from '@du/contracts';", 'const TenantActiveConnectorCatalogPageSchema = globalThis.__connectorCatalogSchema;')
  .replace("import { parseConnectorList } from '@/features/connectors/state';", 'const parseConnectorList = globalThis.__parseConnectorList;');

globalThis.__connectorCatalogSchema = {
  safeParse(value) {
    return value && value.tenantId === tenantId && Array.isArray(value.items)
      ? { success: true, data: value }
      : { success: false };
  },
};
globalThis.__parseConnectorList = (value) => Array.isArray(value)
  ? { items: value, skipped: 0 }
  : null;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled, 'utf8').toString('base64')}`;
const { loadConnectorPinOptions } = await import(moduleUrl);

describe('Profile connector pin catalog', () => {
  it('merges tenant typed revisions with supported global and tenant legacy revisions', async () => {
    const calls = [];
    const chainCalls = [];
    const client = {
      async listConnectors() {
        return { ok: true, data: [
          { connectorId: 'shared-legacy', revision: 1, state: 'ACTIVE' },
          { connectorId: 'tenant-legacy', revision: 3, state: 'ACTIVE', tenantId },
          { connectorId: 'other-tenant', revision: 8, state: 'ACTIVE', tenantId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' },
          { connectorId: 'disabled-legacy', revision: 2, state: 'DISABLED' },
          { connectorId: 'typed-wins', revision: 5, state: 'ACTIVE' },
          { connectorId: 'shadowed-legacy', revision: 4, state: 'ACTIVE', tenantId },
        ] };
      },
      async listTenantActiveConnectorRevisions(query) {
        calls.push(query);
        return { ok: true, data: {
          tenantId,
          items: [{ tenantId, connectorId: 'typed-wins', revision: 5, adapter: 'json-http', provider: 'openai', model: 'gpt-test', credentialConfigured: true, updatedAt: '2026-10-13T00:00:00.000Z' }],
          limit: 100,
          nextCursor: null,
        } };
      },
      async hasTenantConnectorRecipeChain(input) {
        chainCalls.push(input);
        return { ok: true, data: { hasTypedChain: ['typed-wins', 'shadowed-legacy'].includes(input.connectorId) } };
      },
    };

    const result = await loadConnectorPinOptions(client, tenantId);
    assert.equal(result.problem, null);
    assert.deepEqual(result.items.map(({ connectorId, revision }) => `${connectorId}@${revision}`), [
      'shared-legacy@1', 'tenant-legacy@3', 'typed-wins@5',
    ]);
    assert.deepEqual(result.items.find((item) => item.connectorId === 'typed-wins'), {
      connectorId: 'typed-wins', revision: 5, tenantId, state: 'ACTIVE', provider: 'openai', model: 'gpt-test',
    });
    assert.deepEqual(calls, [{ tenantId, limit: 100 }]);
    assert.deepEqual(chainCalls.map(({ connectorId }) => connectorId).sort(), ['shadowed-legacy', 'shared-legacy', 'tenant-legacy', 'typed-wins']);
  });

  it('retains readable pins and reports either catalog failure', async () => {
    const client = {
      async listConnectors() { return { ok: false, status: 503 }; },
      async listTenantActiveConnectorRevisions() { return { ok: true, data: { tenantId, items: [], limit: 100, nextCursor: null } }; },
      async hasTenantConnectorRecipeChain() { return { ok: true, data: { hasTypedChain: false } }; },
    };
    const result = await loadConnectorPinOptions(client, tenantId);
    assert.equal(result.items.length, 0);
    assert.match(result.problem ?? '', /Legacy Connector catalog unavailable \(503\)/);
  });
});
