'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { inventory, hash, identityAssignmentParity, typedConnectorMappingParity } = require('../scripts/ldba-inventory.cjs');
const { appendInventoryEvidence, assertSafe } = require('../scripts/ldba-continuity-evidence.cjs');
const { TABLES, readFrozenSource, sourceSettingsSha256 } = require('../scripts/ldba-continuity-source.cjs');
const { validateConnectorMappings, validateProfileMappings } = require('../scripts/ldba-continuity-mappings.cjs');
const { legacyDisabledRetirementCommand } = require('../scripts/ldba-continuity-runner.cjs');

const tenantId = '10000000-0000-4000-8000-000000000001';
const sourceVersion = 'synthetic-v1';
const privatePrompt = 'continuity-private-prompt-sentinel';
const privateSecret = 'continuity-private-secret-sentinel';
const storageGenerationId = '40000000-0000-4000-8000-000000000001';
const apiKeyId = '20000000-0000-4000-8000-000000000001';
const profileId = '30000000-0000-4000-8000-000000000001';

test('legacy disabled Connector retirement uses manifest-bound CAS and idempotency', () => {
  const mapping = {
    sourceId: 'legacy-connection-7',
    targetState: 'RETIRED',
    expectedHeadRevision: 4,
  };
  const first = legacyDisabledRetirementCommand('a'.repeat(64), mapping, 5);
  const replay = legacyDisabledRetirementCommand('a'.repeat(64), mapping, 5);
  assert.equal(first.reason, 'LEGACY_DISABLED_IMPORT');
  assert.equal(first.expectedCurrentRevision, 4);
  assert.match(first.idempotencyKey, /^ldba14:/);
  assert.equal(first.idempotencyKey, replay.idempotencyKey);
  assert.notEqual(first.idempotencyKey, legacyDisabledRetirementCommand('b'.repeat(64), mapping, 5).idempotencyKey);
  assert.throws(() => legacyDisabledRetirementCommand('a'.repeat(64), { ...mapping, targetState: 'ACTIVE' }, 5),
    error => error.code === 'LEGACY_CONNECTOR_RETIREMENT_INPUT_INVALID');
});

function poolFactory(connector = false) {
  let inserted;
  let reconciliation = [];
  const client = {
    async query(sql, values = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT to_regclass/.test(sql)) return { rows: [{ relation: values[0] }] };
      if (/FROM legacy_migration_runs/.test(sql)) return { rows: [{
        source_sha256: 'a'.repeat(64), plan_sha256: 'b'.repeat(64),
        source_counts: { ApiKey: 0, ExternalApiConnection: 0, ExternalApiOverride: 0, ProfileEndpoint: 0, User: 0, UserProfileAssignment: 0 }, destination_counts: {},
      }] };
      if (/SELECT source_sha256,plan_sha256,target_sha256,counts,capabilities,holds,receipt/.test(sql)) {
        return { rowCount: 1, rows: [{
          source_sha256: inserted[4], plan_sha256: inserted[5], target_sha256: inserted[7],
          counts: JSON.parse(inserted[8]), capabilities: JSON.parse(inserted[9]), holds: JSON.parse(inserted[10]), receipt: JSON.parse(inserted[11]),
        }] };
      }
      if (/FROM legacy_continuity_evidence/.test(sql)) return { rows: reconciliation };
      if (/FROM legacy_app_settings/.test(sql)) return { rows: [
        { key: 'ai_image_prompt', value: privatePrompt, updated_at: '2026-10-11T00:00:00.000Z' },
        { key: 'api_secret_key', value: privateSecret, updated_at: '2026-10-11T00:00:00.000Z' },
      ] };
      if (/FROM operations WHERE tenant_id/.test(sql)) return { rows: [] };
      if (/SELECT count\(\)::int AS count FROM operations/.test(sql)) return { rows: [{ count: 0 }] };
      if (/FROM api_keys/.test(sql)) return { rows: [] };
      if (/FROM profile_bindings/.test(sql)) return { rows: [] };
      if (/FROM profile_api_keys/.test(sql)) return { rows: [] };
      if (/FROM admin_local_users/.test(sql)) return { rows: [] };
      if (/FROM user_profile_assignments/.test(sql)) return { rows: [] };
      if (/FROM admin_local_user_profile_grants/.test(sql)) return { rows: [] };
      if (/FROM admin_local_user_api_key_grants/.test(sql)) return { rows: [] };
      if (/FROM legacy_workflow_schemas/.test(sql)) return { rows: [] };
      if (/FROM connector_prompt_overrides/.test(sql)) return { rows: [] };
      if (/FROM connector_revisions/.test(sql)) return { rows: [] };
      if (/FROM connector_parity_revisions/.test(sql)) return { rows: [] };
      if (/FROM artifacts a LEFT JOIN artifact_blobs/.test(sql)) return { rows: [] };
      if (/FROM global_settings_tenant_heads/.test(sql)) return { rows: connector ? [] : [
        { stream: 'ai', active_revision: 1, draft_revision: null, next_revision: 1 },
        { stream: 'prompts', active_revision: 1, draft_revision: null, next_revision: 1 },
      ] };
      if (/FROM global_settings_tenant_revisions/.test(sql)) return { rows: connector ? [] : [
        { stream: 'ai', revision: 1, state: 'PUBLISHED', content_digest: 'sha256:' + 'c'.repeat(64), source_revision: null, tested_at: '2026-10-11T00:00:00.000Z', published_at: '2026-10-11T00:00:00.000Z' },
        { stream: 'prompts', revision: 1, state: 'PUBLISHED', content_digest: 'sha256:' + 'd'.repeat(64), source_revision: null, tested_at: null, published_at: '2026-10-11T00:00:00.000Z' },
      ] };
      if (/FROM global_settings_retention_head/.test(sql)) return { rows: connector ? [] : [{ active_revision: 1, draft_revision: null, next_revision: 1 }] };
      if (/FROM global_settings_retention_revisions/.test(sql)) return { rows: connector ? [] : [{ revision: 1, state: 'PUBLISHED', digest: 'sha256:' + 'e'.repeat(64), source_revision: 0, published_at: '2026-10-11T00:00:00.000Z' }] };
      if (/FROM storage_generation_state/.test(sql)) return { rows: connector ? [] : [{ active_generation_id: storageGenerationId, revision: 1 }] };
      if (/FROM storage_generations/.test(sql)) return { rows: connector ? [] : [{ generation_id: storageGenerationId, revision: 1, backend: 'postgres', endpoint: 'local', bucket: '', region: 'local', force_path_style: true, credential_version_ref: null, state: 'ACTIVE', tested_at: '2026-10-11T00:00:00.000Z', activated_at: '2026-10-11T00:00:00.000Z' }] };
      if (/FROM usage_events/.test(sql)) return { rows: [] };
      if (/FROM cost_budget_revisions/.test(sql)) return { rows: [] };
      if (/FROM cost_budget_heads/.test(sql)) return { rows: [] };
      if (/FROM cost_price_revisions/.test(sql)) return { rows: [] };
      if (/FROM cost_reservation_groups/.test(sql)) return { rows: [] };
      if (/FROM cost_budget_holds/.test(sql)) return { rows: [] };
      if (/FROM connector_invocations/.test(sql)) return { rows: [] };
      if (/FROM connector_usage_outbox/.test(sql)) return { rows: [{ undelivered: 0, total: 0 }] };
      if (/INSERT INTO legacy_continuity_evidence/.test(sql)) { inserted = values; return { rows: [], rowCount: 1 }; }
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return {
    connect: async () => client,
    query: client.query,
    async end() {},
    setReconciliation(rows) { reconciliation = rows; },
  };
}

test('continuity inventory hashes full target planes without returning source settings', async () => {
  const report = await inventory(poolFactory(), tenantId, sourceVersion, { connectorPool: poolFactory(true) });
  const serialized = JSON.stringify(report);
  assert.ok(!serialized.includes(privatePrompt));
  assert.ok(!serialized.includes(privateSecret));
  assert.equal(report.version, 'ldba-continuity-inventory-v2');
  assert.equal(report.capabilities.globalAi.available, true);
  assert.equal(report.capabilities.globalPrompts.available, true);
  assert.equal(report.capabilities.retention.available, true);
  assert.equal(report.capabilities.storage.activeGenerationId, storageGenerationId);
  assert.equal(report.capabilities.connectorPlane.available, true);
  assert.equal(report.capabilityReady, false);
  assert.equal(report.capabilities.configurationMapping.available, false);
  assert.ok(report.issues.some(row => row.code === 'FULL_SETTINGS_RECONCILIATION_REQUIRED'));
  assert.equal(report.continuityEvidence.rehearsalReady, false);
  assert.equal(report.cutoverReady, false);
  const retired = report.sourceRetirementEvidence.find(row => row.key === 'api_secret_key');
  assert.equal(retired.disposition, 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER');
  assert.equal(retired.sourceValuePresent, true);
  assert.ok(/canonical compatibility review/.test(retired.sourceReview));
});

test('configuration readiness requires a matching immutable mapping receipt and current target digest', async () => {
  const primary = poolFactory();
  const connector = poolFactory(true);
  const before = await inventory(primary, tenantId, sourceVersion, { connectorPool: connector });
  const apiSecretKeySha256 = before.sourceRetirementEvidence.find(row => row.key === 'api_secret_key').sourceValueSha256;
  primary.setReconciliation([{
    evidence_kind: 'reconciliation', evidence_sha256: 'f'.repeat(64),
    source_sha256: before.sourceSha256, plan_sha256: before.planSha256,
    counts: { functionalSettings: 16, retiredSettings: 3, legacyConnectors: 0, profileMappings: 0, importedUsers: 0, identityStateRows: 0, sourceIdentityAssignments: 0, apiKeys: 0, promptOverrides: 0 },
    receipt: {
      status: 'VERIFIED', mappingVersion: 'legacy-settings-map-v1',
      sourceSettingsSha256: before.sourceSettingsSha256,
      configurationSnapshotSha256: before.configurationSnapshotSha256,
      configurationCoreSha256: before.configurationCoreSha256,
      apiSecretKeyDisposition: 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER', apiSecretKeySha256,
      legacyConnectorMappings: [], profileMappings: [], identityAssignments: { users: 0, sourceRows: 0 }, identityState: [],
      promptOverrideMapping: { count: 0, sourceProjectionSha256: before.capabilities.configurationMapping.promptOverridesSha256, targetProjectionSha256: before.capabilities.configurationMapping.promptOverridesSha256 },
      apiKeyMapping: { count: 0, sourceProjectionSha256: before.capabilities.configurationMapping.apiKeysSha256, targetProjectionSha256: before.capabilities.configurationMapping.apiKeysSha256 },
    },
  }]);
  const after = await inventory(primary, tenantId, sourceVersion, { connectorPool: connector });
  assert.equal(after.capabilities.configurationMapping.available, true);
  assert.equal(after.capabilities.configurationMapping.functionalSettings, 16);
  assert.equal(after.capabilityReady, true);
  assert.equal(after.sourceSettingsDisposition.length, 19);
  const retired = after.sourceSettingsDisposition.find(row => row.key === 'api_secret_key');
  assert.equal(retired.disposition, 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER');
  assert.match(retired.valueSha256, /^[a-f0-9]{64}$/);
  assert.equal(retired.sourceValuePresent, true);
  assert.equal(after.cutoverReady, false);

  primary.setReconciliation([{
    evidence_kind: 'reconciliation', evidence_sha256: 'e'.repeat(64),
    source_sha256: before.sourceSha256, plan_sha256: before.planSha256,
    counts: { functionalSettings: 16, retiredSettings: 3 },
    receipt: { ...after.capabilities.configurationMapping, status: 'VERIFIED', mappingVersion: 'legacy-settings-map-v1',
      sourceSettingsSha256: before.sourceSettingsSha256, apiSecretKeyDisposition: 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER', apiSecretKeySha256,
      legacyConnectorMappings: [], profileMappings: [], identityAssignments: { users: 0, sourceRows: 0 }, identityState: [] },
  }]);
  const stale = await inventory(primary, tenantId, sourceVersion, { connectorPool: connector });
  assert.equal(stale.capabilities.configurationMapping.available, false);
  assert.ok(stale.issues.some(row => row.code === 'FULL_SETTINGS_RECONCILIATION_REQUIRED'));
});

test('continuity evidence is append-only and rejects credential-bearing fields', async () => {
  const report = await inventory(poolFactory(), tenantId, sourceVersion, { connectorPool: poolFactory(true) });
  const pool = poolFactory();
  const appended = await appendInventoryEvidence(pool, report);
  assert.equal(appended.replayed, true);
  assert.throws(() => assertSafe({ credential: privateSecret }), error => error.code === 'UNSAFE_EVIDENCE_FIELD');
});

test('frozen source reader binds one-time mappings to exact source snapshot, row counts, timezone, and setting archive', async () => {
  const tables = Object.fromEntries(TABLES.map(name => [name, []]));
  tables.AppSetting = [{ key: 'ai_model', value: 'synthetic-model', updatedAt: '2026-10-11 00:00:00' }];
  tables.ExternalApiConnection = [{ id: 'connector-source-1', authSecret: privateSecret }];
  const counts = Object.fromEntries(TABLES.map(name => [name, tables[name].length]));
  const sourceSha256 = require('node:crypto').createHash('sha256').update(JSON.stringify(tables)).digest('hex');
  const timezoneEvidenceSha256 = '9'.repeat(64);
  const manifest = {
    sourceVersion: 'synthetic-v1', sourceSha256, sourceRowCounts: counts,
    timezoneEvidenceSha256, archivedSettingsSha256: sourceSettingsSha256(tables.AppSetting),
  };
  const makeAdapter = overrides => ({
    source: { scan: async table => tables[table] },
    sourceSnapshot: { sha256: sourceSha256, rowCounts: counts, ...overrides?.snapshot },
    sourceVersion: 'synthetic-v1',
    timezoneEvidence: { verified: true, sourceVersion: 'synthetic-v1', timezone: 'UTC', sha256: timezoneEvidenceSha256, ...overrides?.timezone },
    async close() {},
  });
  const options = {
    manifest, sourceUrl: 'postgres://source/db', targetUrl: 'postgres://target/db', env: {}, Pool: function Pool() {},
    createAdapter: () => makeAdapter(),
  };
  const frozen = await readFrozenSource(options);
  assert.equal(frozen.sourceSha256, sourceSha256);
  assert.equal(frozen.sourceRowCounts.ExternalApiConnection, 1);
  assert.equal(frozen.tables.ExternalApiConnection[0].authSecret, privateSecret);
  await assert.rejects(readFrozenSource({ ...options, createAdapter: () => makeAdapter({ snapshot: { rowCounts: { ...counts, User: 1 } } }) }), error => error.code === 'SOURCE_ROW_COUNTS_CHANGED');
  await assert.rejects(readFrozenSource({ ...options, createAdapter: () => makeAdapter({ timezone: { sha256: '8'.repeat(64) } }) }), error => error.code === 'SOURCE_TIMEZONE_EVIDENCE_MISMATCH');
  await assert.rejects(readFrozenSource({ ...options, manifest: { ...manifest, archivedSettingsSha256: '7'.repeat(64) } }), error => error.code === 'SOURCE_SETTINGS_ARCHIVE_MISMATCH');
});

test('native connector and Profile mappings require exact source-row coverage and connector-step identity', () => {
  const connector = {
    id: 'source-connector-1', slug: 'summarize', state: 'ENABLED', authType: 'NONE', authSecret: '',
    endpointUrl: 'http://127.0.0.1:18100/infer', httpMethod: 'POST', promptFieldName: 'prompt', fileFieldName: null,
    responseContentPath: 'result.text', timeoutSec: 20, staticFormFields: '[]', extraHeaders: '{}',
    sessionIdFieldName: null, sessionIdResponsePath: null, fileUrlFieldName: null, defaultPrompt: 'legacy default',
  };
  const mapping = {
    sourceId: connector.id, sourceRowSha256: hash(connector), connectorId: 'typed-summarize', expectedHeadRevision: 0, targetState: 'ACTIVE',
    recipe: { adapter: 'json-http', endpointUrl: connector.endpointUrl, method: 'POST', auth: { kind: 'none' },
      request: { promptField: 'prompt', fields: [] }, response: { contentPath: 'result.text' }, timeoutMs: 20000,
      session: { capture: [], inject: [] }, headers: [] },
    probe: { apiKeyId, profileId, expectedProfileRevision: 1, businessId: 'synthetic-business', businessVersion: '1', action: 'summarize', endpointSlug: 'summarize', bindingSlot: 'summarize' },
    legacyDefaultPromptCompatibility: 'preserved_on_legacy_chain',
  };
  const connectorMap = validateConnectorMappings([connector], [mapping], ['http://127.0.0.1:18100']);
  const profile = { id: profileId, apiKeyId, endpointSlug: 'summarize', enabled: true, connectionsOverride: '["summarize"]' };
  const profileMapping = { sourceId: profile.id, sourceRowSha256: hash(profile), apiKeyId, endpointSlug: 'summarize',
    expectedProfileRevision: 1, expectedActiveRevision: null, businessId: 'synthetic-business', businessVersion: '1', action: 'summarize', sourceConnectionSteps: [{ slug: 'summarize' }],
    connectorBindings: { summarize: { sourceConnectorId: connector.id } } };
  assert.equal(validateProfileMappings([profile], [profileMapping], connectorMap).sourceById.size, 1);
  assert.throws(() => validateConnectorMappings([connector], [{ ...mapping, sourceRowSha256: 'f'.repeat(64) }], ['http://127.0.0.1:18100']), error => error.code === 'LEGACY_CONNECTOR_SOURCE_CHANGED');
  assert.throws(() => validateProfileMappings([profile], [{ ...profileMapping, connectorBindings: { summarize: { sourceConnectorId: 'missing' } } }], connectorMap), error => error.code === 'PROFILE_CONNECTOR_BINDING_UNRESOLVED');
});

test('typed Connector and identity grant readiness compare exact persisted revisions and full grant sets', () => {
  const mapping = { sourceIdSha256: 'a'.repeat(64), sourceRowSha256: 'b'.repeat(64), recipeSha256: 'c'.repeat(64), connectorId: 'legacy-a', revision: 2, state: 'RETIRED' };
  assert.deepEqual(typedConnectorMappingParity([mapping], [{ connector_id: 'legacy-a', revision: 2, state: 'RETIRED' }], 1), { available: true, mapped: 1 });
  assert.equal(typedConnectorMappingParity([mapping], [{ connector_id: 'legacy-a', revision: 2, state: 'PENDING' }], 1).available, false);
  assert.equal(typedConnectorMappingParity([mapping], [], 1).available, false);
  const assignment = [{ user_id: 'user-a', api_key_id: 'key-a' }];
  const profiles = [{ profile_id: 'profile-a', api_key_id: 'key-a' }];
  const grants = [{ user_id: 'user-a', profile_id: 'profile-a' }];
  const keyGrants = [{ user_id: 'user-a', api_key_id: 'key-a' }];
  assert.equal(identityAssignmentParity(assignment, profiles, grants, keyGrants).available, true);
  assert.equal(identityAssignmentParity(assignment, profiles, [], keyGrants).available, false);
  const revokedAssignments = [
    { user_id: 'user-a', api_key_id: 'key-a' },
    { user_id: 'user-a', api_key_id: 'key-revoked' },
  ];
  const activeParity = identityAssignmentParity(revokedAssignments, profiles, grants, keyGrants, ['key-a']);
  assert.equal(activeParity.available, true);
  assert.equal(activeParity.preservedSourceAssignments, 2);
  assert.equal(activeParity.excludedInactiveAssignments, 1);
  assert.equal(activeParity.expectedApiKeyGrants, 1);
});
