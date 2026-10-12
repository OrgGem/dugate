'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, randomUUID } = require('node:crypto');
const { Pool } = require('pg');
const { inventory, hash, fail, profileContentSha256, promptOverrideRowsSha256, apiKeyRowsSha256 } = require('./ldba-inventory.cjs');
const { appendEvidence, assertSafe } = require('./ldba-continuity-evidence.cjs');
const { loadLegacyDefaults, mapArchivedSettings, validateManifest, sourceHash, assertSyntheticScope } = require('./ldba-continuity-plan.cjs');
const { resolveProfileConnectorBindings, validateConnectorMappings, validateProfileMappings } = require('./ldba-continuity-mappings.cjs');
const { readFrozenSource } = require('./ldba-continuity-source.cjs');

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;
const MAPPING_VERSION = 'legacy-settings-map-v1';
const REASON = 'one-time frozen legacy continuity rehearsal';

function safeErrorCode(error) {
  return error && typeof error.code === 'string' && /^[A-Z0-9_]{1,96}$/.test(error.code)
    ? error.code : 'CONTINUITY_RECONCILIATION_FAILED';
}

function readPinnedJson(file, expectedSha256) {
  if (!file || !SHA.test(expectedSha256 || '')) fail('MANIFEST_PIN_REQUIRED');
  const bytes = fs.readFileSync(path.resolve(file));
  const actual = sourceHash(bytes);
  if (actual !== expectedSha256) fail('MANIFEST_DIGEST_MISMATCH');
  let manifest;
  try { manifest = JSON.parse(bytes.toString('utf8')); } catch { fail('MANIFEST_INVALID_JSON'); }
  return { manifest, digest: actual };
}

function isLoopbackOrigin(value) {
  let url;
  try { url = new URL(value); } catch { return false; }
  return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
    && !url.search && !url.hash && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
}

function validateContinuityManifest(manifest, digest, namespace) {
  validateManifest(manifest);
  assertSyntheticScope(manifest, namespace);
  if (!UUID.test(manifest.probe?.apiKeyId || '') || !UUID.test(manifest.probe?.profileId || '')
      || !Number.isSafeInteger(manifest.probe?.expectedProfileRevision) || manifest.probe.expectedProfileRevision < 1
      || typeof manifest.probe.businessId !== 'string' || !manifest.probe.businessId
      || typeof manifest.probe.businessVersion !== 'string' || !manifest.probe.businessVersion
      || typeof manifest.probe.action !== 'string' || !manifest.probe.action
      || typeof manifest.probe.endpointSlug !== 'string' || !manifest.probe.endpointSlug) fail('SYNTHETIC_PROFILE_PROBE_REQUIRED');
  if (!Array.isArray(manifest.synthetic?.allowedOrigins) || manifest.synthetic.allowedOrigins.length < 1
      || manifest.synthetic.allowedOrigins.some(origin => !isLoopbackOrigin(origin))) fail('SYNTHETIC_LOOPBACK_ORIGINS_REQUIRED');
  if (!manifest.aiConnector || typeof manifest.aiConnector.connectorId !== 'string'
      || !/^[A-Za-z0-9._:-]{1,128}$/.test(manifest.aiConnector.connectorId)
      || !Number.isSafeInteger(manifest.aiConnector.expectedHeadRevision) || manifest.aiConnector.expectedHeadRevision < 0
      || typeof manifest.aiConnector.bindingSlot !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(manifest.aiConnector.bindingSlot)
      || !manifest.aiConnector.recipe || typeof manifest.aiConnector.recipe !== 'object') fail('REVIEWED_AI_CONNECTOR_MAPPING_REQUIRED');
  const probeOrigin = new URL(manifest.aiConnector.recipe.endpointUrl).origin;
  if (!manifest.synthetic.allowedOrigins.includes(probeOrigin)) fail('AI_CONNECTOR_ENDPOINT_OUTSIDE_SYNTHETIC_ALLOWLIST');
  if (!['gemini', 'openai-compatible'].includes(manifest.aiConnector.recipe.adapter)) fail('AI_CONNECTOR_ADAPTER_INVALID');
  if (!['api-key-header', 'bearer'].includes(manifest.aiConnector.recipe.auth?.kind)) fail('AI_CONNECTOR_AUTH_MAPPING_UNSUPPORTED');
  if (manifest.aiConnector.recipe.adapter === 'multipart-http') fail('AI_CONNECTOR_ADAPTER_MISMATCH');
  if (!Array.isArray(manifest.connectorMappings)) fail('CONNECTOR_MAPPING_LIST_REQUIRED');
  if (!Array.isArray(manifest.profileMappings)) fail('PROFILE_MAPPING_LIST_REQUIRED');
  const connectorIds = manifest.connectorMappings.map(mapping => mapping?.connectorId);
  if (new Set(connectorIds).size !== connectorIds.length || connectorIds.includes(manifest.aiConnector.connectorId)) fail('CONNECTOR_TARGET_ID_COLLISION');
  if (!manifest.sourceRowCounts || typeof manifest.sourceRowCounts !== 'object' || Array.isArray(manifest.sourceRowCounts)
      || !SHA.test(manifest.timezoneEvidenceSha256 || '')) fail('FROZEN_SOURCE_EVIDENCE_REQUIRED');
  return { digest };
}

function createInternalClient(origin, token, transport = fetch) {
  let base;
  try { base = new URL(origin); } catch { fail('SYNTHETIC_ADMIN_ORIGIN_REQUIRED'); }
  if (!isLoopbackOrigin(base.origin) || base.pathname !== '/' || !token) fail('SYNTHETIC_ADMIN_ORIGIN_REQUIRED');
  const call = async (method, pathname, body = undefined) => {
    const response = await transport(new URL(pathname, base), {
      method,
      redirect: 'error',
      signal: AbortSignal.timeout(60_000),
      headers: { authorization: 'Bearer ' + token, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const raw = await response.text().catch(() => '');
    if (!response.ok) fail('ADMIN_REQUEST_FAILED_' + response.status);
    let parsed;
    try { parsed = raw ? JSON.parse(raw) : {}; } catch { fail('ADMIN_RESPONSE_INVALID'); }
    return parsed;
  };
  return {
    get: pathname => call('GET', pathname),
    post: (pathname, body) => call('POST', pathname, body),
    put: (pathname, body) => call('PUT', pathname, body),
  };
}

function idempotency(manifestDigest, step) {
  return 'ldba14:' + manifestDigest.slice(0, 32) + ':' + step;
}

function providerProbeBody(manifest, probe, connectorId, revision, model, key) {
  return {
    tenantId: manifest.tenantId,
    apiKeyId: probe.apiKeyId,
    profileId: probe.profileId,
    expectedProfileRevision: probe.expectedProfileRevision,
    businessId: probe.businessId,
    businessVersion: probe.businessVersion,
    action: probe.action,
    endpointSlug: probe.endpointSlug,
    connectorId,
    revision,
    ...(probe.bindingSlot ? { bindingSlot: probe.bindingSlot } : {}),
    model,
    // Fixed synthetic health prompt; source prompts and customer text never
    // become provider-test content or appear in a receipt.
    prompt: 'Reply with OK.',
    parameters: {},
    artifactIds: [],
    timeoutMs: 20_000,
    idempotencyKey: key,
  };
}

function tenantAiTestBody(manifest, revision, bindingSlot, key) {
  return {
    revision,
    apiKeyId: manifest.probe.apiKeyId,
    profileId: manifest.probe.profileId,
    expectedProfileRevision: manifest.probe.expectedProfileRevision,
    businessId: manifest.probe.businessId,
    businessVersion: manifest.probe.businessVersion,
    action: manifest.probe.action,
    endpointSlug: manifest.probe.endpointSlug,
    ...(bindingSlot ? { bindingSlot } : {}),
    prompt: 'Reply with OK.',
    parameters: {},
    artifactIds: [],
    timeoutMs: 20_000,
    idempotencyKey: key,
  };
}

function currentConnectorIdempotencyState(result, expectedRecipe, tenantId) {
  return result && result.revision && result.revision.tenantId === tenantId
    && hash(result.revision.recipe) === hash(expectedRecipe);
}

async function importAndActivateAiConnector(manifest, manifestDigest, effective, admin, secrets) {
  const provider = effective.ai_provider;
  const secretKey = provider === 'gemini' ? 'ai_api_key' : 'openai_api_key';
  const secret = effective[secretKey];
  if (typeof secret !== 'string' || secret.length === 0) fail('ACTIVE_AI_CREDENTIAL_MISSING');
  const sourceRow = manifest.archivedSettingsSha256;
  const secretInput = {
    tenantId: manifest.tenantId,
    name: provider === 'gemini' ? 'Legacy Gemini credential' : 'Legacy OpenAI-compatible credential',
    purpose: 'connector.credential',
    services: ['connector'],
    value: secret,
    sourceSystem: 'legacy_db',
    sourceRecordRef: manifest.sourceVersion + ':AppSetting:' + secretKey,
    idempotencyKey: idempotency(manifestDigest, 'catalog-' + secretKey),
  };
  void sourceRow;
  const storedSecret = await secrets.writeImportedSecret(secretInput);
  if (!storedSecret || !UUID.test(storedSecret.secretId || '') || storedSecret.versionRef !== storedSecret.secretId + '@' + storedSecret.revision) fail('SECRET_IMPORT_RECEIPT_INVALID');

  const draftInput = {
    tenantId: manifest.tenantId,
    expectedHeadRevision: manifest.aiConnector.expectedHeadRevision,
    recipe: manifest.aiConnector.recipe,
    credentialChange: { action: 'vault-ref', reference: storedSecret.secretId },
    idempotencyKey: idempotency(manifestDigest, 'connector-ai-draft'),
  };
  const draft = await secrets.importConnectorCredential(manifest.aiConnector.connectorId, draftInput, draftInput.idempotencyKey);
  if (!currentConnectorIdempotencyState(draft, manifest.aiConnector.recipe, manifest.tenantId)) fail('CONNECTOR_DRAFT_RECEIPT_INVALID');
  const revision = Number(draft.revision.revision);
  if (!Number.isSafeInteger(revision) || revision < 1) fail('CONNECTOR_DRAFT_RECEIPT_INVALID');
  const current = await secrets.readConnectorRevision(manifest.tenantId, manifest.aiConnector.connectorId, revision);
  if (!current || hash(current.recipe) !== hash(manifest.aiConnector.recipe)) fail('CONNECTOR_RECIPE_READBACK_MISMATCH');
  if (current.state === 'PENDING') {
    const tested = await admin.post('/api/internal/parity/provider-tests', providerProbeBody(
      manifest, { ...manifest.probe, bindingSlot: manifest.aiConnector.bindingSlot },
      manifest.aiConnector.connectorId, revision, effective.ai_model,
      idempotency(manifestDigest, 'provider-test-ai-candidate'),
    ));
    if (tested.state !== 'SUCCEEDED' || !tested.usageEventId) fail('CONNECTOR_PROVIDER_TEST_NOT_CONFIRMED');
    const activated = await secrets.activateConnectorRevision(manifest.tenantId, manifest.aiConnector.connectorId, revision, manifest.aiConnector.expectedHeadRevision);
    if (activated.activated !== true || activated.currentRevision !== revision) fail('CONNECTOR_ACTIVATION_NOT_CONFIRMED');
  } else if (current.state !== 'ACTIVE') fail('CONNECTOR_REVISION_NOT_ACTIVE');
  const active = await secrets.readConnectorRevision(manifest.tenantId, manifest.aiConnector.connectorId, revision);
  if (!active || active.state !== 'ACTIVE' || hash(active.recipe) !== hash(manifest.aiConnector.recipe)) fail('CONNECTOR_ACTIVATION_READBACK_MISMATCH');
  return { connectorId: manifest.aiConnector.connectorId, revision, sourceKey: secretKey, catalogSecretId: storedSecret.secretId };
}

async function applyGlobalSettings(manifest, manifestDigest, effective, connector, admin) {
  const base = '/api/internal/global-settings';
  const urlTenant = encodeURIComponent(manifest.tenantId);
  const current = await admin.get(base + '?tenantId=' + urlTenant);
  const aiSettings = {
    provider: effective.ai_provider,
    model: effective.ai_model,
    connectorId: connector.connectorId,
    connectorRevision: connector.revision,
  };
  const activeAi = current.ai.activeRevision === null ? null : current.ai.history.find(row => row.revision === current.ai.activeRevision);
  let aiRevision = current.ai.activeRevision;
  if (!activeAi || hash(activeAi.settings) !== hash(aiSettings)) {
    const draft = await admin.post(base + '/tenants/' + urlTenant + '/ai/draft', {
      expectedActiveRevision: current.ai.activeRevision,
      sourceRevision: current.ai.activeRevision,
      settings: aiSettings,
      idempotencyKey: idempotency(manifestDigest, 'tenant-ai-draft'),
      reason: REASON,
    });
    if (!Number.isSafeInteger(draft.revision)) fail('TENANT_AI_DRAFT_RECEIPT_INVALID');
    const test = await admin.post(base + '/tenants/' + urlTenant + '/ai/test',
      tenantAiTestBody(manifest, draft.revision, undefined, idempotency(manifestDigest, 'tenant-ai-test')));
    if (test.ok !== true || test.revision !== draft.revision) fail('TENANT_AI_TEST_NOT_CONFIRMED');
    await admin.post(base + '/tenants/' + urlTenant + '/ai/publish', {
      draftRevision: draft.revision,
      expectedActiveRevision: current.ai.activeRevision,
      idempotencyKey: idempotency(manifestDigest, 'tenant-ai-publish'),
      reason: REASON,
    });
    aiRevision = draft.revision;
  }
  const prompts = {
    image: effective.ai_image_prompt,
    pdf: effective.ai_pdf_prompt,
    docx: effective.ai_docx_prompt,
    compare: effective.ai_compare_prompt,
    generate: effective.ai_generate_prompt,
  };
  const activePrompts = current.prompts.activeRevision === null ? null : current.prompts.history.find(row => row.revision === current.prompts.activeRevision);
  let promptRevision = current.prompts.activeRevision;
  if (!activePrompts || hash(activePrompts.settings) !== hash(prompts)) {
    const draft = await admin.post(base + '/tenants/' + urlTenant + '/prompts/draft', {
      expectedActiveRevision: current.prompts.activeRevision,
      sourceRevision: current.prompts.activeRevision,
      settings: prompts,
      idempotencyKey: idempotency(manifestDigest, 'tenant-prompts-draft'),
      reason: REASON,
    });
    if (!Number.isSafeInteger(draft.revision)) fail('TENANT_PROMPTS_DRAFT_RECEIPT_INVALID');
    await admin.post(base + '/tenants/' + urlTenant + '/prompts/publish', {
      draftRevision: draft.revision,
      expectedActiveRevision: current.prompts.activeRevision,
      idempotencyKey: idempotency(manifestDigest, 'tenant-prompts-publish'),
      reason: REASON,
    });
    promptRevision = draft.revision;
  }
  const readback = await admin.get(base + '?tenantId=' + urlTenant);
  const readAi = readback.ai.history.find(row => row.revision === aiRevision);
  const readPrompts = readback.prompts.history.find(row => row.revision === promptRevision);
  if (readback.ai.activeRevision !== aiRevision || !readAi || hash(readAi.settings) !== hash(aiSettings)
      || readback.prompts.activeRevision !== promptRevision || !readPrompts || hash(readPrompts.settings) !== hash(prompts)) fail('TENANT_GLOBAL_SETTINGS_READBACK_MISMATCH');
  return { aiRevision, promptRevision };
}

async function applyRetention(manifest, manifestDigest, effective, admin) {
  const base = '/api/internal/global-settings/retention';
  const current = await admin.get(base);
  const settings = { ...current.effective, cacheTtlHours: Number(effective.s3_cache_ttl_hours) };
  if (!Number.isSafeInteger(settings.cacheTtlHours) || settings.cacheTtlHours < 0 || settings.cacheTtlHours > 87_600) fail('RETENTION_VALUE_OUT_OF_RANGE');
  if (current.effective.cacheTtlHours === settings.cacheTtlHours) return current.activeRevision;
  const draft = await admin.post(base + '/draft', {
    expectedActiveRevision: current.activeRevision,
    sourceRevision: current.activeRevision,
    settings,
    idempotencyKey: idempotency(manifestDigest, 'retention-draft'),
    reason: REASON,
  });
  if (!Number.isSafeInteger(draft.revision)) fail('RETENTION_DRAFT_RECEIPT_INVALID');
  await admin.post(base + '/publish', {
    draftRevision: draft.revision,
    expectedActiveRevision: current.activeRevision,
    idempotencyKey: idempotency(manifestDigest, 'retention-publish'),
    reason: REASON,
  });
  const readback = await admin.get(base);
  if (readback.activeRevision !== draft.revision || hash(readback.effective) !== hash(settings)) fail('RETENTION_READBACK_MISMATCH');
  return draft.revision;
}

async function importStorageCredential(manifest, manifestDigest, effective, secrets) {
  const endpoint = effective.s3_endpoint;
  const bucket = effective.s3_bucket;
  const accessKeyId = effective.s3_access_key;
  const secretAccessKey = effective.s3_secret_key;
  const activeValues = [endpoint, bucket, accessKeyId, secretAccessKey].map(value => typeof value === 'string' ? value.trim() : '');
  if (activeValues.every(value => value === '')) return { backend: 'postgres', endpoint: 'postgres', bucket: '', region: 'postgres', forcePathStyle: false, credentialVersionRef: null, credentialOwnerTenantId: null };
  if (activeValues.some(value => value === '')) fail('PARTIAL_LEGACY_STORAGE_CONFIGURATION');
  let storageUrl;
  try { storageUrl = new URL(endpoint); } catch { fail('LEGACY_STORAGE_ENDPOINT_INVALID'); }
  const origin = storageUrl.origin;
  if (!manifest.synthetic.allowedOrigins.includes(origin) || !isLoopbackOrigin(origin)) fail('LEGACY_STORAGE_ENDPOINT_OUTSIDE_SYNTHETIC_ALLOWLIST');
  const region = typeof effective.s3_region === 'string' && effective.s3_region.trim() ? effective.s3_region.trim() : 'us-east-1';
  const value = JSON.stringify({ accessKeyId, secretAccessKey });
  const stored = await secrets.writeImportedSecret({
    tenantId: manifest.tenantId,
    name: 'Legacy storage credential',
    purpose: 'storage.credential',
    services: ['orchestrator'],
    value,
    sourceSystem: 'legacy_db',
    sourceRecordRef: manifest.sourceVersion + ':AppSetting:s3_access_key+s3_secret_key',
    idempotencyKey: idempotency(manifestDigest, 'catalog-storage'),
  });
  return { backend: 's3', endpoint: storageUrl.toString(), bucket, region, forcePathStyle: true,
    credentialVersionRef: stored.versionRef, credentialOwnerTenantId: manifest.tenantId };
}

async function applyStorage(manifest, manifestDigest, effective, admin, secrets) {
  const base = '/api/internal/maintenance/storage-generations';
  const current = await admin.get(base + '/current');
  const config = await importStorageCredential(manifest, manifestDigest, effective, secrets);
  const expected = { ...config, urlTtlSeconds: null };
  if (current.backend === expected.backend && current.endpoint === expected.endpoint && current.bucket === expected.bucket
      && current.region === expected.region && current.forcePathStyle === expected.forcePathStyle
      && current.credentialOwnerTenantId === expected.credentialOwnerTenantId) return current.generationId;
  const staged = await admin.post(base + '/stage', {
    expectedRevision: current.controlRevision,
    idempotencyKey: idempotency(manifestDigest, 'storage-stage'),
    ...expected,
    reason: REASON,
  });
  if (!staged.generationId || !Number.isSafeInteger(staged.controlRevision)) fail('STORAGE_STAGE_RECEIPT_INVALID');
  const tested = await admin.post(base + '/' + encodeURIComponent(staged.generationId) + '/test', {
    idempotencyKey: idempotency(manifestDigest, 'storage-test'), reason: REASON,
  });
  if (tested.status !== 'PASSED' || tested.write !== 'PASSED' || tested.read !== 'PASSED'
      || tested.checksum !== 'PASSED' || tested.crypto !== 'PASSED' || tested.delete !== 'PASSED') fail('STORAGE_TEST_NOT_CONFIRMED');
  await admin.post(base + '/' + encodeURIComponent(staged.generationId) + '/activate', {
    expectedRevision: current.controlRevision,
    idempotencyKey: idempotency(manifestDigest, 'storage-activate'), reason: REASON,
  });
  const readback = await admin.get(base + '/current');
  if (readback.generationId !== staged.generationId || readback.state !== 'ACTIVE') fail('STORAGE_ACTIVATION_READBACK_MISMATCH');
  return staged.generationId;
}

function sourceSettingsSha256(rows) {
  return hash(rows.filter(row => !row.key.startsWith('wb_schema:')).map(row => ({ key: row.key, valueSha256: hash(row.value), updatedAt: row.updated_at })));
}

function parseSourceJsonObject(value, code, fallback) {
  if (value === null || value === undefined) return fallback;
  if (typeof value !== 'string') fail(code);
  let parsed;
  try { parsed = JSON.parse(value); } catch { fail(code); }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail(code);
  return parsed;
}

async function verifyImportedProfiles(pool, tenantId, sourceRows, mappings) {
  const rows = (await pool.query(`SELECT p.profile_id,p.revision,p.api_key_id,p.business_id,p.business_version,p.action,p.endpoint_slug,p.enabled,
      p.connector_bindings,p.parameters,p.job_priority,p.allowed_file_extensions,p.file_url_auth_cipher,p.connections_override,n.profile_name
    FROM profile_bindings p JOIN profile_active_revisions a ON a.profile_id=p.profile_id AND a.revision=p.revision
    JOIN profile_names n ON n.profile_id=p.profile_id AND n.tenant_id=p.tenant_id
    WHERE p.tenant_id=$1 ORDER BY p.profile_id`, [tenantId])).rows;
  if (rows.length !== sourceRows.length || mappings.length !== sourceRows.length) fail('LEGACY_PROFILE_TARGET_SET_MISMATCH');
  const sourceById = new Map(sourceRows.map(row => [String(row.id).toLowerCase(), row]));
  const mappingById = new Map(mappings.map(row => [String(row.sourceId).toLowerCase(), row]));
  const targetById = new Map(rows.map(row => [String(row.profile_id).toLowerCase(), row]));
  if (targetById.size !== rows.length) fail('LEGACY_PROFILE_TARGET_DUPLICATE');
  const output = new Map();
  const { resolveProfileName } = require('./ldba-context-provider.cjs');
  for (const [id, source] of sourceById) {
    const target = targetById.get(id);
    const mapping = mappingById.get(id);
    if (!target || !mapping || mapping.sourceRowSha256 !== hash(source)) fail('LEGACY_PROFILE_SOURCE_TARGET_MISMATCH');
    const parameters = parseSourceJsonObject(source.parameters, 'PROFILE_PARAMETERS_SOURCE_INVALID', {});
    const connections = require('./ldba-continuity-mappings.cjs').normalizeLegacyConnectionSteps(source.connectionsOverride);
    const expectedAllowedExtensions = source.allowedFileExtensions ?? '';
    const expectedFileCipher = source.fileUrlAuthConfig ?? null;
    if (target.revision !== 1 || target.api_key_id !== String(source.apiKeyId).toLowerCase()
        || target.business_id !== mapping.businessId || target.business_version !== mapping.businessVersion
        || target.action !== mapping.action || target.endpoint_slug !== source.endpointSlug
        || target.profile_name !== resolveProfileName(source) || target.enabled !== source.enabled
        || hash(target.parameters) !== hash(parameters) || target.job_priority !== source.jobPriority
        || target.allowed_file_extensions !== expectedAllowedExtensions
        || target.file_url_auth_cipher !== expectedFileCipher
        || hash(target.connections_override) !== hash(connections)) fail('LEGACY_PROFILE_SOURCE_TARGET_MISMATCH');
    output.set(id, { profileContentSha256: profileContentSha256(target), connectorBindingsSha256: hash(target.connector_bindings || {}) });
  }
  return output;
}

async function verifyImportedPromptOverrides(pool, tenantId, sourceRows) {
  const projection = [];
  const seen = new Set();
  for (const row of sourceRows) {
    if (!UUID.test(row.id || '') || !UUID.test(row.connectionId || '') || !UUID.test(row.apiKeyId || '')
        || typeof row.endpointSlug !== 'string' || !row.endpointSlug
        || typeof row.stepId !== 'string' || !row.stepId
        || !(row.promptOverride === null || row.promptOverride === undefined || typeof row.promptOverride === 'string')) fail('LEGACY_PROMPT_OVERRIDE_SOURCE_INVALID');
    const target = {
      connection_id: row.connectionId.toLowerCase(), api_key_id: row.apiKeyId.toLowerCase(),
      endpoint_slug: row.endpointSlug, step_id: row.stepId, prompt_override: row.promptOverride ?? null, is_active: true,
    };
    const key = `${target.connection_id}|${target.api_key_id}|${target.endpoint_slug}|${target.step_id}`;
    if (seen.has(key)) fail('LEGACY_PROMPT_OVERRIDE_TARGET_DUPLICATE');
    seen.add(key);
    projection.push(target);
  }
  const targets = (await pool.query(`SELECT connection_id,api_key_id,endpoint_slug,step_id,prompt_override,is_active
    FROM connector_prompt_overrides WHERE tenant_id=$1 ORDER BY connection_id,api_key_id,endpoint_slug,step_id`, [tenantId])).rows;
  if (targets.length !== projection.length) fail('LEGACY_PROMPT_OVERRIDE_TARGET_COUNT_MISMATCH');
  const sourceProjectionSha256 = promptOverrideRowsSha256(projection);
  const targetProjectionSha256 = promptOverrideRowsSha256(targets);
  if (sourceProjectionSha256 !== targetProjectionSha256) fail('LEGACY_PROMPT_OVERRIDE_TARGET_MISMATCH');
  return { count: projection.length, sourceProjectionSha256, targetProjectionSha256 };
}

async function verifyImportedApiKeys(pool, tenantId, sourceRows) {
  const targetRows = (await pool.query(`SELECT id,status,hash,prefix,name,spending_limit::text AS spending_limit,total_used::text AS total_used,created_at,updated_at
    FROM api_keys WHERE tenant_id=$1 ORDER BY id`, [tenantId])).rows;
  if (targetRows.length !== sourceRows.length) fail('LEGACY_API_KEY_TARGET_COUNT_MISMATCH');
  const expected = sourceRows.map(row => {
    if (!UUID.test(row.id || '') || !['active','ACTIVE','revoked','REVOKED'].includes(row.status)
        || typeof row.keyHash !== 'string' || !row.keyHash || typeof row.prefix !== 'string' || typeof row.name !== 'string') fail('LEGACY_API_KEY_SOURCE_INVALID');
    return {
      id: row.id.toLowerCase(), status: row.status.toUpperCase(), hash: row.keyHash, prefix: row.prefix, name: row.name,
      spendingLimit: row.spendingLimit, totalUsed: row.totalUsed, createdAt: row.createdAt, updatedAt: row.updatedAt,
    };
  });
  const sourceProjectionSha256 = apiKeyRowsSha256(expected);
  const targetProjectionSha256 = apiKeyRowsSha256(targetRows);
  if (sourceProjectionSha256 !== targetProjectionSha256) fail('LEGACY_API_KEY_TARGET_MISMATCH');
  return { count: sourceRows.length, sourceProjectionSha256, targetProjectionSha256 };
}

async function prepare(pool, connectorPool, manifest, digest, options = {}) {
  validateContinuityManifest(manifest, digest, options.namespace);
  const source = options.source;
  if (!source || source.sourceSha256 !== manifest.sourceSha256
      || source.timezoneEvidenceSha256 !== manifest.timezoneEvidenceSha256
      || hash(source.sourceRowCounts) !== hash(manifest.sourceRowCounts)) fail('FROZEN_SOURCE_BINDING_MISMATCH');
  const report = await inventory(pool, manifest.tenantId, manifest.sourceVersion, { connectorPool });
  if (report.sourceSha256 !== manifest.sourceSha256 || report.archivedSettingsSha256 !== manifest.archivedSettingsSha256
      || report.sourceSettingsSha256 !== manifest.archivedSettingsSha256) fail('SOURCE_ARCHIVE_BINDING_MISMATCH');
  if (hash(report.sourceCounts) !== hash(source.sourceRowCounts)
      || source.sourceSettingsSha256 !== report.sourceSettingsSha256) fail('SOURCE_IMPORT_JOURNAL_MISMATCH');
  const connectorMappings = validateConnectorMappings(source.tables.ExternalApiConnection, manifest.connectorMappings, manifest.synthetic.allowedOrigins);
  const profileMappings = validateProfileMappings(source.tables.ProfileEndpoint, manifest.profileMappings, connectorMappings);
  await verifyImportedProfiles(pool, manifest.tenantId, source.tables.ProfileEndpoint, manifest.profileMappings);
  await verifyImportedPromptOverrides(pool, manifest.tenantId, source.tables.ExternalApiOverride);
  await verifyImportedApiKeys(pool, manifest.tenantId, source.tables.ApiKey);
  for (const connector of source.tables.ExternalApiConnection) {
    if (!connectorMappings.mappingsBySourceId.has(connector.id)) fail('LEGACY_CONNECTOR_MAPPING_INCOMPLETE');
  }
  const sourceProfileIds = new Set(source.tables.ProfileEndpoint.map(row => row.id));
  if (profileMappings.sourceById.size !== sourceProfileIds.size) fail('LEGACY_PROFILE_MAPPING_INCOMPLETE');
  if (report.inventorySha256 !== manifest.baselineInventorySha256) {
    const prior = (await pool.query(`SELECT evidence_sha256,source_sha256,plan_sha256,target_sha256,receipt
      FROM legacy_continuity_evidence WHERE tenant_id=$1 AND source_version=$2 AND evidence_kind='reconciliation'
      ORDER BY recorded_at DESC LIMIT 1`, [manifest.tenantId, manifest.sourceVersion])).rows[0];
    if (!prior || prior.source_sha256 !== manifest.sourceSha256 || prior.plan_sha256 !== report.planSha256
        || prior.receipt?.manifestSha256 !== digest || prior.receipt?.status !== 'VERIFIED'
        || prior.receipt?.frozenSourceSha256 !== source.sourceSha256) fail('TARGET_INVENTORY_CHANGED');
    if (prior.receipt?.configurationSnapshotSha256 === report.configurationSnapshotSha256) {
      return { report, rows: [], effective: null, source, connectorMappings, profileMappings, alreadyApplied: true, priorEvidenceSha256: prior.evidence_sha256 };
    }
    if (prior.receipt?.configurationCoreSha256 !== report.configurationCoreSha256) fail('TARGET_INVENTORY_CHANGED');
    const currentIdentityState = await readIdentityState(pool, manifest.tenantId, source.tables.User);
    validateIdentityResetTransitions(prior.receipt?.identityState, currentIdentityState, source.tables.User);
  }
  const rows = (await pool.query("SELECT key,value,updated_at FROM legacy_app_settings WHERE tenant_id=$1 AND key NOT LIKE 'wb_schema:%' ORDER BY key", [manifest.tenantId])).rows;
  if (sourceSettingsSha256(rows) !== manifest.archivedSettingsSha256) fail('SOURCE_ARCHIVE_BINDING_MISMATCH');
  const sourcePath = manifest.legacySettingsSourcePath;
  const defaults = loadLegacyDefaults(sourcePath, manifest.legacySettingsSourceSha256, manifest.legacySettingsDefaultsSha256);
  const encryptionSecret = process.env.ENCRYPTION_KEY ?? process.env.NEXTAUTH_SECRET;
  if (typeof encryptionSecret !== 'string' || encryptionSecret.length === 0) fail('LEGACY_SETTINGS_ENCRYPTION_KEY_REQUIRED');
  const mapped = mapArchivedSettings(rows, defaults.defaults, encryptionSecret);
  if (mapped.archivedKeys.length !== rows.length) fail('ARCHIVED_SETTINGS_MAP_INVALID');
  const effective = mapped.effective;
  if (!['gemini', 'openai-compatible'].includes(effective.ai_provider) || !effective.ai_model.trim()) fail('LEGACY_AI_DEFAULTS_INVALID');
  const expectedAdapter = effective.ai_provider;
  if (manifest.aiConnector.recipe.adapter !== expectedAdapter) fail('AI_CONNECTOR_PROVIDER_MISMATCH');
  if (effective.ai_provider === 'openai-compatible') {
    let base;
    try { base = new URL(effective.openai_base_url); } catch { fail('LEGACY_OPENAI_BASE_URL_INVALID'); }
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash
        || !manifest.synthetic.allowedOrigins.includes(base.origin) || !isLoopbackOrigin(base.origin)) fail('LEGACY_OPENAI_BASE_URL_OUTSIDE_SYNTHETIC_ALLOWLIST');
    const endpoint = new URL(manifest.aiConnector.recipe.endpointUrl);
    if (endpoint.origin !== base.origin || (base.pathname !== '/' && !endpoint.pathname.startsWith(base.pathname.replace(/\/$/, '') + '/'))) fail('AI_CONNECTOR_BASE_URL_MISMATCH');
  }
  if (!report.capabilities.connectorPlane.available || report.capabilities.connectorPlane.undeliveredUsage !== 0) fail('CONNECTOR_PLANE_NOT_FENCED');
  const priorReceipt = report.capabilities.configurationMapping;
  if (priorReceipt.available) fail('TARGET_ALREADY_RECONCILED_WITH_ANOTHER_PLAN');
  const readyInputs = {
    sourceSha256: report.sourceSha256,
    planSha256: report.planSha256,
    manifestSha256: digest,
    baselineInventorySha256: report.inventorySha256,
    sourceSettingsSha256: report.sourceSettingsSha256,
    archivedSettingsSha256: report.archivedSettingsSha256,
    dispositionCount: 19,
    functionalSettings: 16,
    retiredSettings: 3,
    sourceCredentialKeys: ['ai_api_key','openai_api_key','s3_access_key','s3_secret_key'].filter(key => Boolean(effective[key])),
    retiredApiSecretKeySha256: report.sourceRetirementEvidence.find(row => row.key === 'api_secret_key')?.sourceValueSha256 ?? null,
  };
  assertSafe(readyInputs);
  return { report, rows, effective, mapped, source, connectorMappings, profileMappings, alreadyApplied: false, readyInputs };
}

async function applyProfileMappings(manifest, manifestDigest, admin, connector, pool, sourceProfileRows) {
  const client = require('./ldba-reconcile.cjs').createAdminClient(
    process.env.LDBA_ADMIN_ORIGIN || process.env.LDBA_CONTINUITY_ADMIN_ORIGIN,
    process.env.LDBA_ADMIN_BEARER || process.env.LDBA_CONTINUITY_ADMIN_BEARER,
  );
  const outcomes = [];
  for (let index = 0; index < manifest.profileMappings.length; index += 1) {
    const mapping = manifest.profileMappings[index];
    const bindings = resolveProfileConnectorBindings(mapping, connector.results, connector);
    const scope = { tenantId: manifest.tenantId, apiKeyId: mapping.apiKeyId, endpointSlug: mapping.endpointSlug };
    const effective = await client.read(scope);
    const profile = effective.configuration?.profile;
    if (!profile || profile.revision !== mapping.expectedProfileRevision) fail('PROFILE_SOURCE_TARGET_MISMATCH');
    if ((effective.configuration?.activeRevision ?? null) !== mapping.expectedActiveRevision) fail('PROFILE_SETTINGS_HEAD_STALE');
    const actual = profile.connectorBindings ?? {};
    if (hash(actual) === hash(bindings)) {
    outcomes.push({ sourceIdSha256: hash(mapping.sourceId), sourceRowSha256: mapping.sourceRowSha256,
      apiKeyId: mapping.apiKeyId, endpointSlug: mapping.endpointSlug, connectorBindingsSha256: hash(bindings),
      profileRevision: profile.revision, status: 'UNCHANGED' });
      continue;
    }
    const actionKey = 'ldba14:' + manifestDigest.slice(0, 32) + ':profile-' + String(index);
    const draft = await client.action('settings.revision.create', {
      ...scope,
      expectedActiveRevision: mapping.expectedActiveRevision,
      expectedProfileRevision: mapping.expectedProfileRevision,
      changes: { connectorBindings: bindings },
    }, actionKey + ':create');
    if (!Number.isSafeInteger(draft.revision)) fail('PROFILE_REVISION_DRAFT_INVALID');
    const validation = await client.action('settings.revision.validate', { ...scope, revision: draft.revision }, actionKey + ':validate');
    if (validation.valid !== true) fail('PROFILE_REVISION_VALIDATION_FAILED');
    await client.action('settings.revision.apply', { ...scope, revision: draft.revision, expectedActiveRevision: effective.configuration?.activeRevision ?? null }, actionKey + ':apply');
    const readback = await client.read(scope);
    if (!readback.configuration?.profile || readback.configuration.profile.revision !== mapping.expectedProfileRevision
        || hash(readback.configuration.profile.connectorBindings ?? {}) !== hash(bindings)) fail('PROFILE_CONNECTOR_READBACK_MISMATCH');
    outcomes.push({ sourceIdSha256: hash(mapping.sourceId), sourceRowSha256: mapping.sourceRowSha256,
      apiKeyId: mapping.apiKeyId, endpointSlug: mapping.endpointSlug, connectorBindingsSha256: hash(bindings),
      profileRevision: readback.configuration.profile.revision, status: 'APPLIED' });
  }
  const profileReadbacks = await verifyImportedProfiles(pool, manifest.tenantId, sourceProfileRows, manifest.profileMappings);
  for (const outcome of outcomes) {
    const mapping = manifest.profileMappings.find(item => hash(item.sourceId) === outcome.sourceIdSha256);
    const target = mapping && profileReadbacks.get(String(mapping.sourceId).toLowerCase());
    if (!target || target.connectorBindingsSha256 !== outcome.connectorBindingsSha256) fail('PROFILE_CONNECTOR_READBACK_MISMATCH');
    outcome.profileContentSha256 = target.profileContentSha256;
  }
  void admin;
  return outcomes;
}

function connectorStepKey(sourceId) {
  return 'connector-' + hash(sourceId).slice(0, 24);
}

function legacyDisabledRetirementCommand(manifestDigest, mapping, revision) {
  if (!mapping || mapping.targetState !== 'RETIRED'
      || !Number.isSafeInteger(mapping.expectedHeadRevision) || mapping.expectedHeadRevision < 0
      || !Number.isSafeInteger(revision) || revision < 1) fail('LEGACY_CONNECTOR_RETIREMENT_INPUT_INVALID');
  const step = connectorStepKey(mapping.sourceId) + '-retire-' + revision;
  return {
    expectedCurrentRevision: mapping.expectedHeadRevision,
    idempotencyKey: idempotency(manifestDigest, step),
    reason: 'LEGACY_DISABLED_IMPORT',
  };
}

async function importLegacyConnectors(manifest, manifestDigest, prepared, admin, secrets) {
  if (prepared.connectorMappings.mappingsBySourceId.size === 0) return { results: new Map(), outcomes: [] };
  const hasRetired = manifest.connectorMappings.some(mapping => mapping.targetState === 'RETIRED');
  if (hasRetired && typeof secrets.retireConnectorRevision !== 'function') fail('TYPED_CONNECTOR_RETIREMENT_UNAVAILABLE');
  const results = new Map();
  const outcomes = [];
  for (const mapping of manifest.connectorMappings) {
    const source = prepared.connectorMappings.sourceById.get(mapping.sourceId);
    if (!source) fail('LEGACY_CONNECTOR_SOURCE_ROW_MISSING');
    const id = connectorStepKey(mapping.sourceId);
    const importKey = idempotency(manifestDigest, id + '-recipe');
    let draft;
    let catalogSecretId = null;
    let catalogVersionRef = null;
    const sourceSecret = typeof source.authSecret === 'string' ? source.authSecret : '';
    if (sourceSecret) {
      const stored = await secrets.writeImportedSecret({
        tenantId: manifest.tenantId,
        name: 'Legacy Connector credential ' + hash(mapping.sourceId).slice(0, 12),
        purpose: 'connector.credential',
        services: ['connector'],
        value: sourceSecret,
        sourceSystem: 'legacy_db',
        sourceRecordRef: manifest.sourceVersion + ':ExternalApiConnection:' + mapping.sourceId,
        idempotencyKey: idempotency(manifestDigest, id + '-catalog'),
      });
      if (!stored || !UUID.test(stored.secretId || '') || stored.versionRef !== stored.secretId + '@' + stored.revision) fail('CONNECTOR_CATALOG_IMPORT_RECEIPT_INVALID');
      catalogSecretId = stored.secretId;
      catalogVersionRef = stored.versionRef;
      draft = await secrets.importConnectorCredential(mapping.connectorId, {
        tenantId: manifest.tenantId,
        expectedHeadRevision: mapping.expectedHeadRevision,
        recipe: mapping.recipe,
        credentialChange: { action: 'vault-ref', reference: stored.secretId },
        idempotencyKey: importKey,
      }, importKey);
    } else {
      draft = await secrets.upsertConnectorRecipeDraft({
        tenantId: manifest.tenantId,
        connectorId: mapping.connectorId,
        expectedHeadRevision: mapping.expectedHeadRevision,
        recipe: mapping.recipe,
        credentialChange: { action: 'clear', confirm: true },
        idempotencyKey: importKey,
      });
    }
    const revision = Number(draft?.revision?.revision);
    if (!currentConnectorIdempotencyState(draft, mapping.recipe, manifest.tenantId)
        || draft.revision.connectorId !== mapping.connectorId
        || revision !== mapping.expectedHeadRevision + 1
        || draft.revision.expectedHeadRevision !== mapping.expectedHeadRevision) fail('LEGACY_CONNECTOR_DRAFT_RECEIPT_INVALID');
    let current = await secrets.readConnectorRevision(manifest.tenantId, mapping.connectorId, revision);
    if (!current || hash(current.recipe) !== hash(mapping.recipe)) fail('LEGACY_CONNECTOR_READBACK_MISMATCH');

    if (mapping.targetState === 'ACTIVE') {
      if (current.state === 'PENDING') {
        const tested = await admin.post('/api/internal/parity/provider-tests', providerProbeBody(
          manifest, mapping.probe, mapping.connectorId, revision, undefined,
          idempotency(manifestDigest, id + '-provider-test'),
        ));
        if (tested.state !== 'SUCCEEDED' || !tested.usageEventId) fail('LEGACY_CONNECTOR_PROVIDER_TEST_NOT_CONFIRMED');
        const activated = await secrets.activateConnectorRevision(manifest.tenantId, mapping.connectorId, revision, mapping.expectedHeadRevision);
        if (activated.activated !== true || activated.currentRevision !== revision) fail('LEGACY_CONNECTOR_ACTIVATION_NOT_CONFIRMED');
      } else if (current.state !== 'ACTIVE') fail('LEGACY_CONNECTOR_REVISION_NOT_ACTIVE');
    } else {
      if (current.state === 'PENDING') {
        const retirement = legacyDisabledRetirementCommand(manifestDigest, mapping, revision);
        const retired = await secrets.retireConnectorRevision(
          manifest.tenantId,
          mapping.connectorId,
          revision,
          retirement.expectedCurrentRevision,
          retirement.idempotencyKey,
          retirement.reason,
        );
        if (retired.retired !== true || retired.currentRevision !== (mapping.expectedHeadRevision || null)) {
          fail('LEGACY_DISABLED_CONNECTOR_RETIREMENT_NOT_CONFIRMED');
        }
      } else if (current.state !== 'RETIRED') fail('LEGACY_DISABLED_CONNECTOR_TARGET_ALREADY_ROUTABLE');
    }
    current = await secrets.readConnectorRevision(manifest.tenantId, mapping.connectorId, revision);
    const expectedState = mapping.targetState === 'ACTIVE' ? 'ACTIVE' : 'RETIRED';
    if (!current || current.state !== expectedState || hash(current.recipe) !== hash(mapping.recipe)) fail('LEGACY_CONNECTOR_STATE_READBACK_MISMATCH');
    const result = { sourceConnectorId: mapping.sourceId, connectorId: mapping.connectorId, revision, state: current.state, catalogSecretId };
    results.set(mapping.sourceId, result);
    outcomes.push({ sourceIdSha256: hash(mapping.sourceId), sourceRowSha256: mapping.sourceRowSha256,
      recipeSha256: hash(mapping.recipe), connectorId: mapping.connectorId, revision, state: current.state,
      catalogSecretId, catalogVersionRef });
  }
  return { results, outcomes };
}

async function reconcileIdentityAssignments(manifest, prepared, admin, pool) {
  const source = prepared.source.tables;
  const users = source.User;
  const assignments = source.UserProfileAssignment;
  const importedUsers = (await pool.query('SELECT id FROM admin_local_users WHERE tenant_id=$1 ORDER BY id', [manifest.tenantId])).rows.map(row => row.id).sort();
  const expectedUsers = users.map(row => String(row.id).toLowerCase()).sort();
  if (hash(importedUsers) !== hash(expectedUsers)) fail('LEGACY_IDENTITY_USER_SET_MISMATCH');
  const importedAssignments = (await pool.query(`SELECT user_id,api_key_id FROM user_profile_assignments
    WHERE user_id IN (SELECT id FROM admin_local_users WHERE tenant_id=$1) ORDER BY user_id,api_key_id`, [manifest.tenantId])).rows
    .map(row => [row.user_id, row.api_key_id]);
  const expectedAssignments = assignments.map(row => [String(row.userId).toLowerCase(), String(row.apiKeyId).toLowerCase()])
    .sort((left, right) => (left[0] + '|' + left[1]).localeCompare(right[0] + '|' + right[1]));
  if (hash(importedAssignments) !== hash(expectedAssignments)) fail('LEGACY_IDENTITY_SOURCE_ASSIGNMENTS_MISMATCH');
  const targetKeys = (await pool.query('SELECT id,status FROM api_keys WHERE tenant_id=$1 ORDER BY id', [manifest.tenantId])).rows;
  const targetProfiles = (await pool.query(`SELECT p.profile_id,p.api_key_id FROM profile_active_revisions a
    JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
    WHERE p.tenant_id=$1 ORDER BY p.profile_id`, [manifest.tenantId])).rows;
  const profilesByKey = new Map();
  for (const profile of targetProfiles) {
    const values = profilesByKey.get(profile.api_key_id) || [];
    values.push(profile.profile_id);
    profilesByKey.set(profile.api_key_id, values);
  }
  const activeKeys = new Set(targetKeys.filter(row => row.status === 'ACTIVE').map(row => row.id));
  const userIds = new Set(users.map(row => row.id));
  const byUser = new Map(users.map(row => [row.id, { apiKeyIds: new Set(), profileIds: new Set() }]));
  for (const assignment of assignments) {
    if (!userIds.has(assignment.userId) || !UUID.test(assignment.userId || '') || !UUID.test(assignment.apiKeyId || '')) fail('LEGACY_IDENTITY_ASSIGNMENT_UNMAPPABLE');
    // Preserve the source assignment in its imported source table for history,
    // but do not create a routable Admin grant for a revoked source API key.
    if (!activeKeys.has(assignment.apiKeyId)) continue;
    const desired = byUser.get(assignment.userId);
    desired.apiKeyIds.add(assignment.apiKeyId);
    for (const profileId of profilesByKey.get(assignment.apiKeyId) || []) desired.profileIds.add(profileId);
  }
  const outcomes = [];
  for (const user of users) {
    if (!UUID.test(user.id || '')) fail('LEGACY_IDENTITY_USER_UNMAPPABLE');
    const desired = byUser.get(user.id);
    const apiKeyIds = [...desired.apiKeyIds].sort();
    const profileIds = [...desired.profileIds].sort();
    const path = '/api/internal/parity/identity/users/' + encodeURIComponent(user.id)
      + '/assignments?tenantId=' + encodeURIComponent(manifest.tenantId);
    const current = await admin.get(path);
    if (!current || current.userId !== user.id || !Number.isSafeInteger(current.version)
        || !Array.isArray(current.profileIds) || !Array.isArray(current.apiKeyIds)) fail('IDENTITY_ASSIGNMENT_READ_INVALID');
    const exact = hash([...current.profileIds].sort()) === hash(profileIds)
      && hash([...current.apiKeyIds].sort()) === hash(apiKeyIds);
    if (!exact) {
      await admin.put(path, { expectedVersion: current.version, profileIds, apiKeyIds });
    }
    const readback = await admin.get(path);
    if (!readback || readback.userId !== user.id
        || hash([...readback.profileIds].sort()) !== hash(profileIds)
        || hash([...readback.apiKeyIds].sort()) !== hash(apiKeyIds)) fail('IDENTITY_ASSIGNMENT_READBACK_MISMATCH');
    outcomes.push({ userId: user.id, profileGrantCount: profileIds.length, apiKeyGrantCount: apiKeyIds.length, status: exact ? 'UNCHANGED' : 'REPLACED' });
  }
  return outcomes;
}

async function readIdentityState(pool, tenantId, sourceUsers) {
  const rows = (await pool.query(`SELECT id,role,is_enabled,is_locked,legacy_password_reset_required,version,assignment_version,legacy_identity_metadata
    FROM admin_local_users WHERE tenant_id=$1 ORDER BY id`, [tenantId])).rows;
  const sourceById = new Map(sourceUsers.map(row => [String(row.id).toLowerCase(), row]));
  if (rows.length !== sourceById.size) fail('LEGACY_IDENTITY_USER_SET_MISMATCH');
  return rows.map(row => {
    const id = String(row.id).toLowerCase();
    const source = sourceById.get(id);
    if (!source) fail('LEGACY_IDENTITY_USER_SET_MISMATCH');
    const metadata = row.legacy_identity_metadata || {};
    const sourcePolicy = metadata.sourcePolicy || {};
    return {
      userId: id,
      sourceRowSha256: hash(source),
      role: row.role,
      isEnabled: Boolean(row.is_enabled),
      isLocked: Boolean(row.is_locked),
      resetRequired: Boolean(row.legacy_password_reset_required),
      version: Number(row.version),
      assignmentVersion: Number(row.assignment_version),
      sourcePolicyEnabledKnown: Boolean(sourcePolicy.enabledKnown),
      sourcePolicyEnabled: typeof sourcePolicy.enabled === 'boolean' ? sourcePolicy.enabled : null,
      hasProviderIdentity: Boolean(metadata.provider || metadata.providerSub),
      metadataSha256: hash(metadata),
    };
  });
}

function validateIdentityResetTransitions(previousRows, currentRows, sourceUsers) {
  if (!Array.isArray(previousRows) || !Array.isArray(currentRows) || previousRows.length !== currentRows.length) fail('TARGET_IDENTITY_STATE_CHANGED');
  const sourceById = new Map(sourceUsers.map(row => [String(row.id).toLowerCase(), row]));
  const currentById = new Map(currentRows.map(row => [row.userId, row]));
  for (const previous of previousRows) {
    const current = currentById.get(previous.userId);
    const source = sourceById.get(previous.userId);
    if (!current || !source || previous.sourceRowSha256 !== hash(source)
        || current.sourceRowSha256 !== previous.sourceRowSha256
        || current.role !== previous.role || current.isLocked !== previous.isLocked
        || current.assignmentVersion !== previous.assignmentVersion
        || current.metadataSha256 !== previous.metadataSha256
        || current.sourcePolicyEnabledKnown !== previous.sourcePolicyEnabledKnown
        || current.sourcePolicyEnabled !== previous.sourcePolicyEnabled
        || current.hasProviderIdentity !== previous.hasProviderIdentity) fail('TARGET_IDENTITY_STATE_CHANGED');
    const unchanged = current.isEnabled === previous.isEnabled
      && current.resetRequired === previous.resetRequired
      && current.version === previous.version;
    if (unchanged) continue;
    const exactRequiredReset = previous.resetRequired === true
      && previous.isEnabled === false
      && previous.isLocked === false
      && previous.hasProviderIdentity === false
      && previous.sourcePolicyEnabled !== false
      && current.resetRequired === false
      && current.isEnabled === true
      && current.isLocked === false
      && current.version === previous.version + 1;
    if (!exactRequiredReset) fail('TARGET_IDENTITY_STATE_CHANGED');
  }
  return true;
}

async function apply(manifest, digest, prepared, admin, secrets, pool, connectorPool) {
  if (prepared.alreadyApplied) return { status: 'ALREADY_VERIFIED', evidenceSha256: prepared.priorEvidenceSha256, cutover: 'NOT_PERFORMED' };
  if (manifest.connectorMappings.some(mapping => mapping.targetState === 'RETIRED')
      && secrets.capabilities?.typedConnectorRetirement !== true) fail('TYPED_CONNECTOR_RETIREMENT_UNAVAILABLE');
  const connector = await importAndActivateAiConnector(manifest, digest, prepared.effective, admin, secrets);
  const legacyConnectors = await importLegacyConnectors(manifest, digest, prepared, admin, secrets);
  const profileMappings = await applyProfileMappings(manifest, digest, admin, { ...connector, results: legacyConnectors.results }, pool, prepared.source.tables.ProfileEndpoint);
  const promptOverrideMapping = await verifyImportedPromptOverrides(pool, manifest.tenantId, prepared.source.tables.ExternalApiOverride);
  const apiKeyMapping = await verifyImportedApiKeys(pool, manifest.tenantId, prepared.source.tables.ApiKey);
  const settings = await applyGlobalSettings(manifest, digest, prepared.effective, connector, admin);
  const retentionRevision = await applyRetention(manifest, digest, prepared.effective, admin);
  const storageGenerationId = await applyStorage(manifest, digest, prepared.effective, admin, secrets);
  const identityAssignments = await reconcileIdentityAssignments(manifest, prepared, admin, pool);
  const identityState = await readIdentityState(pool, manifest.tenantId, prepared.source.tables.User);

  const sourceRecheck = await readFrozenSource({
    manifest,
    sourceUrl: process.env.LDBA03_SOURCE_DATABASE_URL,
    targetUrl: process.env.LDBA03_TARGET_DATABASE_URL,
  });
  if (sourceRecheck.sourceSha256 !== prepared.source.sourceSha256
      || hash(sourceRecheck.sourceRowCounts) !== hash(prepared.source.sourceRowCounts)
      || sourceRecheck.timezoneEvidenceSha256 !== prepared.source.timezoneEvidenceSha256
      || sourceRecheck.sourceSettingsSha256 !== prepared.source.sourceSettingsSha256) fail('SOURCE_CHANGED_DURING_RECONCILIATION');

  const after = await inventory(pool, manifest.tenantId, manifest.sourceVersion, { connectorPool });
  if (after.sourceSha256 !== manifest.sourceSha256 || after.archivedSettingsSha256 !== manifest.archivedSettingsSha256
      || after.sourceSettingsSha256 !== manifest.archivedSettingsSha256) fail('SOURCE_CHANGED_DURING_RECONCILIATION');
  const apiSecret = after.sourceRetirementEvidence.find(row => row.key === 'api_secret_key');
  const receipt = {
    status: 'VERIFIED', scope: 'synthetic', mappingVersion: MAPPING_VERSION,
    manifestSha256: digest,
    sourceSettingsSha256: after.sourceSettingsSha256,
    frozenSourceSha256: sourceRecheck.sourceSha256,
    timezoneEvidenceSha256: sourceRecheck.timezoneEvidenceSha256,
    sourceRowCounts: sourceRecheck.sourceRowCounts,
    configurationSnapshotSha256: after.configurationSnapshotSha256,
    configurationCoreSha256: after.configurationCoreSha256,
    apiSecretKeyDisposition: 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER',
    apiSecretKeySha256: apiSecret?.sourceValueSha256 ?? null,
    functionalSettings: 16, retiredSettings: 3,
    activeAiRevision: settings.aiRevision, activePromptRevision: settings.promptRevision,
    activeRetentionRevision: retentionRevision, activeStorageGenerationId: storageGenerationId,
    connectorId: connector.connectorId, connectorRevision: connector.revision,
    legacyConnectorMappings: legacyConnectors.outcomes,
    profileMappings: profileMappings.map(({ sourceIdSha256, sourceRowSha256, apiKeyId, endpointSlug, connectorBindingsSha256, profileContentSha256, profileRevision, status }) => ({
      sourceIdSha256, sourceRowSha256, apiKeyId, endpointSlug, connectorBindingsSha256, profileContentSha256, profileRevision, status,
    })),
    promptOverrideMapping,
    apiKeyMapping,
    identityAssignments: {
      users: identityAssignments.length,
      changed: identityAssignments.filter(row => row.status === 'REPLACED').length,
      sourceRows: prepared.source.tables.UserProfileAssignment.length,
    },
    identityState,
    productionCutover: 'NOT_PERFORMED',
  };
  assertSafe(receipt);
  const appended = await appendEvidence(pool, {
    tenantId: manifest.tenantId, sourceVersion: manifest.sourceVersion, evidenceKind: 'reconciliation',
    sourceSha256: after.sourceSha256, planSha256: after.planSha256,
    targetSha256: after.configurationSnapshotSha256,
    counts: {
      functionalSettings: 16, retiredSettings: 3, legacyConnectors: legacyConnectors.outcomes.length,
      activeLegacyConnectors: legacyConnectors.outcomes.filter(row => row.state === 'ACTIVE').length,
      retiredLegacyConnectors: legacyConnectors.outcomes.filter(row => row.state === 'RETIRED').length,
      profileMappings: profileMappings.length, importedUsers: identityAssignments.length,
      identityStateRows: identityState.length,
      sourceIdentityAssignments: prepared.source.tables.UserProfileAssignment.length,
      apiKeys: apiKeyMapping.count,
      promptOverrides: promptOverrideMapping.count,
      inactiveSourceIdentityAssignments: after.capabilities.identity.inactiveSourceAssignmentRows,
      profileGrants: identityAssignments.reduce((sum, row) => sum + row.profileGrantCount, 0),
      apiKeyGrants: identityAssignments.reduce((sum, row) => sum + row.apiKeyGrantCount, 0),
    },
    capabilities: {
      globalAi: true, globalPrompts: true, retention: true, storage: true,
      connectorCredentialImport: true, legacyConnectors: legacyConnectors.outcomes.length,
      profileMappings: profileMappings.length, identityAssignments: identityAssignments.length,
    },
    holds: after.issues,
    receipt,
  });
  const verified = await inventory(pool, manifest.tenantId, manifest.sourceVersion, { connectorPool });
  if (verified.capabilities.configurationMapping.available !== true
      || verified.capabilities.configurationMapping.targetConfigurationSha256 !== verified.configurationSnapshotSha256) fail('CONTINUITY_READINESS_READBACK_FAILED');
  return {
    status: 'VERIFIED', evidenceSha256: appended.evidenceSha256,
    sourceSha256: verified.sourceSha256, planSha256: verified.planSha256,
    configurationSnapshotSha256: verified.configurationSnapshotSha256,
    sourceSettingsSha256: verified.sourceSettingsSha256,
    mappingCounts: { functional: 16, retired: 3 },
    targetCounts: verified.targetCounts,
    capabilities: verified.capabilities,
    holds: verified.issues,
    productionCutover: 'NOT_PERFORMED',
    readiness: { capabilityReady: verified.capabilityReady, rehearsalReady: verified.continuityEvidence.rehearsalReady, cutoverReady: verified.cutoverReady },
    customerEvidence: verified.customerEvidence,
  };
}

async function cli() {
  const mode = process.argv[2];
  if (!['--continuity-preflight', '--continuity-apply'].includes(mode)) fail('INVALID_COMMAND');
  const manifestFile = process.env.LDBA_CONTINUITY_MANIFEST_FILE;
  const pinned = readPinnedJson(manifestFile, process.env.LDBA_CONTINUITY_MANIFEST_SHA256);
  const namespace = process.env.LDBA_CONTINUITY_NAMESPACE;
  validateContinuityManifest(pinned.manifest, pinned.digest, namespace);
  const targetUrl = process.env.LDBA03_TARGET_DATABASE_URL;
  const connectorUrl = process.env.LDBA03_CONNECTOR_TARGET_DATABASE_URL;
  if (!targetUrl || !connectorUrl) fail('DUAL_TARGET_DATABASES_REQUIRED');
  const pool = new Pool({ connectionString: targetUrl, application_name: 'ldba14-continuity-target', max: 3 });
  const connectorPool = new Pool({ connectionString: connectorUrl, application_name: 'ldba14-continuity-connector-inventory', max: 3 });
  const admin = createInternalClient(process.env.LDBA_CONTINUITY_ADMIN_ORIGIN, process.env.LDBA_CONTINUITY_ADMIN_BEARER);
  let secrets = null;
  try {
    const source = await readFrozenSource({
      manifest: pinned.manifest,
      sourceUrl: process.env.LDBA03_SOURCE_DATABASE_URL,
      targetUrl,
    });
    const prepared = await prepare(pool, connectorPool, pinned.manifest, pinned.digest, { namespace, source });
    if (mode === '--continuity-preflight') {
      const report = {
        status: prepared.alreadyApplied ? 'ALREADY_VERIFIED' : 'PREFLIGHT_READY',
        scope: 'synthetic', namespace, manifestSha256: pinned.digest,
        sourceSha256: prepared.report.sourceSha256, planSha256: prepared.report.planSha256,
        timezoneEvidenceSha256: prepared.source.timezoneEvidenceSha256,
        sourceRowCounts: prepared.source.sourceRowCounts,
        archivedSettingsSha256: prepared.report.archivedSettingsSha256,
        baselineInventorySha256: prepared.report.inventorySha256,
        sourceSettingsDisposition: prepared.report.sourceSettingsDisposition,
        sourceRetirementEvidence: prepared.report.sourceRetirementEvidence,
        currentCapabilities: prepared.report.capabilities,
        currentHolds: prepared.report.issues,
        applyReady: !prepared.alreadyApplied,
        productionCutover: 'NOT_PERFORMED',
      };
      assertSafe(report);
      process.stdout.write(JSON.stringify(report, null, 2) + '\n');
      return;
    }
    if (process.env.LDBA_CONTINUITY_APPLY !== '1') fail('CONTINUITY_APPLY_ACK_REQUIRED');
    if (!prepared.alreadyApplied) {
      secrets = require('./ldba-continuity-runtime.cjs').createTrustedSecretImportRuntime({ databaseUrl: targetUrl });
    }
    const report = await apply(pinned.manifest, pinned.digest, prepared, admin, secrets, pool, connectorPool);
    assertSafe(report);
    process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  } finally {
    if (secrets) await secrets.close();
    await Promise.all([pool.end(), connectorPool.end()]);
  }
}

if (require.main === module) cli().catch(error => {
  process.stderr.write(JSON.stringify({ status: 'BLOCKED', code: safeErrorCode(error), productionCutover: 'NOT_PERFORMED' }) + '\n');
  process.exitCode = 1;
});

module.exports = {
  apply,
  applyGlobalSettings,
  applyRetention,
  applyStorage,
  createInternalClient,
  idempotency,
  importLegacyConnectors,
  legacyDisabledRetirementCommand,
  importAndActivateAiConnector,
  importStorageCredential,
  reconcileIdentityAssignments,
  prepare,
  readPinnedJson,
  sourceSettingsSha256,
  validateContinuityManifest,
};
