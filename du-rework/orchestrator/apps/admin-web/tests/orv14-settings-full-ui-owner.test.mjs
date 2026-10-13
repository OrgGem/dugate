import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createAdminApiClient } from '../src/lib/api/client.ts';
import { PROMPT_PRESETS, promptIssues } from '../src/features/settings/prompt-presets.ts';
import { tenantActiveConnectorPageMatches } from '../src/features/settings/tenant-connector-catalog.ts';
import { storageSecretCatalogQuery } from '../src/features/settings/storage-secret-catalog.ts';
import { completePromptPreset, TENANT_PROMPT_PRESETS } from '../../../services/orchestrator/src/modules/global-settings/defaults.ts';

const settingsScreen = readFileSync(new URL('../src/features/settings/settings-screen.tsx', import.meta.url), 'utf8');
const tenantSettings = readFileSync(new URL('../src/features/settings/global-tenant-settings.tsx', import.meta.url), 'utf8');
const storageSettings = readFileSync(new URL('../src/features/settings/storage-generation-panel.tsx', import.meta.url), 'utf8');

describe('ORV14 full Settings UI owner checks', () => {
  it('keeps both browser presets byte-identical to the server presets and enforces exact variables', () => {
    for (const locale of ['en', 'vi']) {
      assert.deepEqual(completePromptPreset(locale), TENANT_PROMPT_PRESETS[locale]);
      assert.deepEqual(PROMPT_PRESETS[locale], TENANT_PROMPT_PRESETS[locale]);
      assert.deepEqual(promptIssues(PROMPT_PRESETS[locale]), []);
    }
    assert.deepEqual(promptIssues({ ...PROMPT_PRESETS.en, compare: '{file1}', generate: '{input_content}' }), [
      'Compare prompt must include the exact {file1} and {file2} placeholders.',
      'Generate prompt must include the exact {user_prompt} and {input_content} placeholders.',
    ]);
  });

  it('routes typed Settings operations through the session BFF with CSRF and exact idempotency keys', async () => {
    const calls = [];
    const session = {
      schemaVersion: '1', plane: 'oidc', role: 'admin',
      principal: { kind: 'platform', tenantId: null }, scope: { kind: 'platform' },
      displayName: 'Platform Admin', localUser: false, csrfToken: 'settings-csrf-proof',
    };
    const fetchImpl = async (input, init = {}) => {
      calls.push({ url: String(input), method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body, credentials: init.credentials });
      return new Response(String(input).endsWith('/session') ? JSON.stringify(session) : '{}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    };
    const client = createAdminApiClient({ fetchImpl });
    const tenantId = '11111111-1111-4111-8111-111111111111';
    await client.getGlobalSettings(tenantId);
    await client.createTenantAiDraft(tenantId, { expectedActiveRevision: null, settings: { provider: 'gemini', model: 'gemini-2.5-flash', connectorId: null, connectorRevision: null }, idempotencyKey: 'ai-draft-0001', reason: 'Create test draft' });
    await client.testTenantAiRevision(tenantId, { revision: 2, apiKeyId: '22222222-2222-4222-8222-222222222222', profileId: '33333333-3333-4333-8333-333333333333', expectedProfileRevision: 5, businessId: 'document-core', businessVersion: '1.0.0', action: 'extract', endpointSlug: 'extract:invoice', prompt: 'test', parameters: { sample: 'value' }, artifactIds: [], timeoutMs: 30000, idempotencyKey: 'ai-test-0001' });
    await client.getPlatformRetention();
    await client.createRetentionDraft({ expectedActiveRevision: 1, settings: { cacheTtlHours: 48, outputRetentionDays: 14, cleanupIntervalSeconds: 900 }, idempotencyKey: 'retention-draft-1', reason: 'Change policy' });
    await client.listStorageGenerations();
    await client.getStorageGeneration();
    await client.stageStorageGeneration({ expectedRevision: 1, backend: 'postgres', idempotencyKey: 'storage-pg-stage1', reason: 'Switch to PostgreSQL' });
    await client.stageStorageGeneration({ expectedRevision: 1, backend: 's3', endpoint: 'https://objects.example.test', bucket: 'documents', region: 'us-east-1', forcePathStyle: true, credentialVersionRef: '44444444-4444-4444-8444-444444444444@3', credentialOwnerTenantId: tenantId, urlTtlSeconds: 900, idempotencyKey: 'storage-s3-stage1', reason: 'Stage S3' });
    await client.testStorageGeneration('gen:storage:2', { idempotencyKey: 'storage-test-0001', reason: 'Test staged storage' });
    await client.activateStorageGeneration('gen:storage:2', { expectedRevision: 1, idempotencyKey: 'storage-activate1', reason: 'Activate staged storage' });
    await client.rollbackStorageGeneration('gen:storage:1', { expectedRevision: 2, idempotencyKey: 'storage-rollback1', reason: 'Restore retained storage' });
    await client.listSecrets({ tenantId, purpose: 'storage.credential', state: 'ACTIVE', limit: '200' });
    await client.createSecret({ tenantId, name: 'Storage credential', purpose: 'storage.credential', services: ['orchestrator'], provider: { kind: 'managed_value' }, value: { kind: 'literal', value: 'synthetic-secret-value' } }, 'secret-create-0001');
    await client.rotateSecret('44444444-4444-4444-8444-444444444444', { expectedRevision: 3, value: { kind: 'literal', value: 'replacement-secret-value' } }, 'secret-rotate-0001');

    const sessionCalls = calls.filter((call) => call.url === '/admin/api/session');
    assert.equal(sessionCalls.length, 1);
    assert.equal(sessionCalls[0].credentials, 'same-origin');
    const callsByPath = new Map(calls.filter((call) => !call.url.endsWith('/session')).map((call) => [call.url, call]));
    assert.equal(callsByPath.get(`/admin/api/global-settings?tenantId=${tenantId}`).method, 'GET');
    assert.equal(callsByPath.get(`/admin/api/global-settings/tenants/${tenantId}/ai/draft`).method, 'POST');
    assert.equal(callsByPath.get(`/admin/api/global-settings/tenants/${tenantId}/ai/test`).method, 'POST');
    assert.equal(callsByPath.get('/admin/api/global-settings/retention').method, 'GET');
    assert.equal(callsByPath.get('/admin/api/maintenance/storage-generations').method, 'GET');
    assert.equal(callsByPath.get('/admin/api/maintenance/storage-generations/current').method, 'GET');
    const postgresCall = calls.find((call) => call.url === '/admin/api/maintenance/storage-generations/stage' && call.body.includes('storage-pg-stage1'));
    assert.deepEqual(JSON.parse(postgresCall.body), {
      expectedRevision: 1, backend: 'postgres', idempotencyKey: 'storage-pg-stage1', reason: 'Switch to PostgreSQL',
    });
    const s3Call = calls.find((call) => call.url === '/admin/api/maintenance/storage-generations/stage' && call.body.includes('storage-s3-stage1'));
    assert.equal(JSON.parse(s3Call.body).credentialVersionRef, '44444444-4444-4444-8444-444444444444@3');
    assert.equal(JSON.parse(s3Call.body).credentialOwnerTenantId, tenantId);
    assert.equal(callsByPath.get('/admin/api/maintenance/storage-generations/gen%3Astorage%3A2/test').headers['idempotency-key'], 'storage-test-0001');
    assert.equal(callsByPath.get('/admin/api/maintenance/storage-generations/gen%3Astorage%3A2/activate').headers['idempotency-key'], 'storage-activate1');
    assert.equal(callsByPath.get('/admin/api/maintenance/storage-generations/gen%3Astorage%3A1/rollback').headers['idempotency-key'], 'storage-rollback1');
    assert.equal(callsByPath.get(`/admin/api/secrets?tenantId=${tenantId}&purpose=storage.credential&state=ACTIVE&limit=200`).method, 'GET');
    assert.equal(callsByPath.get('/admin/api/secrets').headers['idempotency-key'], 'secret-create-0001');
    assert.equal(callsByPath.get('/admin/api/secrets/44444444-4444-4444-8444-444444444444/rotate').headers['idempotency-key'], 'secret-rotate-0001');
    for (const call of calls) {
      assert.equal(call.credentials, 'same-origin');
      assert.equal(Object.keys(call.headers).some((name) => name.toLowerCase() === 'authorization'), false);
    }
    for (const call of calls.filter((item) => item.method === 'POST')) assert.equal(call.headers['x-csrf-token'], 'settings-csrf-proof');
  });

  it('replaces the legacy no-writer notice with real flows and keeps secrets write-only', () => {
    assert.match(settingsScreen, /<TenantAiSettingsPanel/);
    assert.match(settingsScreen, /<PlatformRetentionPanel/);
    assert.match(settingsScreen, /<StorageGenerationPanel/);
    assert.doesNotMatch(settingsScreen, /no global write adapter/i);
    assert.match(tenantSettings, /Typed test parameters/);
    assert.match(tenantSettings, /createTenantAiDraft/);
    assert.match(tenantSettings, /publishTenantPromptRevision/);
    assert.match(tenantSettings, /rollbackTenantAiRevision/);
    assert.match(tenantSettings, /tenantActiveConnectorPageMatches\(result\.data, tenant\)/);
    const tenantId = '11111111-1111-4111-8111-111111111111';
    assert.equal(tenantActiveConnectorPageMatches({ tenantId, items: [{ tenantId }] }, tenantId), true);
    assert.equal(tenantActiveConnectorPageMatches({ tenantId, items: [{ tenantId: '22222222-2222-4222-8222-222222222222' }] }, tenantId), false);
    assert.equal(tenantActiveConnectorPageMatches({ tenantId: '22222222-2222-4222-8222-222222222222', items: [] }, tenantId), false);
    assert.match(tenantSettings, /Connector catalog unavailable/);
    assert.match(tenantSettings, /No platform-wide catalog fallback was used/);
    assert.match(tenantSettings, /Load next Connector page/);
    assert.match(storageSettings, /safeStorageValue\('endpoint'/);
    assert.match(storageSettings, /type='password'/);
    assert.match(storageSettings, /purpose: 'storage\.credential'/);
    assert.match(storageSettings, /Load next credential page/);
    assert.deepEqual(storageSecretCatalogQuery('tenant-1', '  archive  ', 'cursor-1'), {
      tenantId: 'tenant-1', purpose: 'storage.credential', service: 'orchestrator', state: 'ACTIVE',
      limit: '200', q: 'archive', cursor: 'cursor-1',
    });
    assert.match(storageSettings, /client\.testStorageGeneration/);
    assert.match(storageSettings, /client\.activateStorageGeneration/);
    assert.match(storageSettings, /client\.rollbackStorageGeneration/);
  });
});
