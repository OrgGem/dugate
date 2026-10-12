'use strict';
const { createHash } = require('node:crypto');

const canonical = (value) => {
  if (value instanceof Date) return value.toISOString();
  if (Buffer.isBuffer(value)) return { sha256: createHash('sha256').update(value).digest('hex'), length: value.length };
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])]));
  return value;
};
const hash = value => createHash('sha256').update(JSON.stringify(canonical(value))).digest('hex');
const fail = code => { throw Object.assign(new Error(code), { code }); };
const MAX_SETTING_RETIREMENTS = Object.freeze({
  api_secret_key: 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER',
  docx_conversion_mode: 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER',
  docx_intermediate_format: 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER',
});

function boundedRows(client, sql, values, maxRows) {
  return client.query(sql + ' LIMIT ' + (maxRows + 1), values).then(result => {
    if (result.rows.length > maxRows) fail('INVENTORY_ROW_LIMIT_EXCEEDED');
    return result.rows;
  });
}

async function tableExists(client, relation) {
  const result = await client.query('SELECT to_regclass($1)::text AS relation', [relation]);
  return Boolean(result.rows[0]?.relation);
}

async function optionalRows(client, relation, sql, values, maxRows) {
  if (!(await tableExists(client, relation))) return [];
  return boundedRows(client, sql, values, maxRows);
}

async function withSnapshot(pool, callback) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    const value = await callback(client);
    await client.query('COMMIT');
    return value;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

function rollup(rows, key) {
  const out = {};
  for (const row of rows) {
    const name = String(row[key] ?? 'UNKNOWN');
    out[name] = Number(row.count ?? 0);
  }
  return out;
}

function sortedPairSet(rows, left, right) {
  return rows.map(row => [String(row[left]).toLowerCase(), String(row[right]).toLowerCase()])
    .sort((a, b) => (a[0] + '|' + a[1]).localeCompare(b[0] + '|' + b[1]));
}

function identityAssignmentParity(assignments, profiles, profileGrants, apiKeyGrants, activeApiKeyIds = null) {
  const active = activeApiKeyIds == null ? null : new Set([...activeApiKeyIds].map(value => String(value).toLowerCase()));
  const routableAssignments = active == null ? assignments : assignments.filter(row => active.has(String(row.api_key_id).toLowerCase()));
  const expectedKeys = sortedPairSet(routableAssignments, 'user_id', 'api_key_id');
  const profilesByKey = new Map();
  for (const profile of profiles) {
    const profileIds = profilesByKey.get(profile.api_key_id) || [];
    profileIds.push(profile.profile_id);
    profilesByKey.set(profile.api_key_id, profileIds);
  }
  const expectedProfiles = [];
  for (const assignment of routableAssignments) {
    for (const profileId of profilesByKey.get(assignment.api_key_id) || []) {
      expectedProfiles.push({ user_id: assignment.user_id, profile_id: profileId });
    }
  }
  const profileSet = sortedPairSet(expectedProfiles, 'user_id', 'profile_id');
  return {
    available: JSON.stringify(expectedKeys) === JSON.stringify(sortedPairSet(apiKeyGrants, 'user_id', 'api_key_id'))
      && JSON.stringify(profileSet) === JSON.stringify(sortedPairSet(profileGrants, 'user_id', 'profile_id')),
    expectedProfileGrants: profileSet.length,
    expectedApiKeyGrants: expectedKeys.length,
    preservedSourceAssignments: assignments.length,
    excludedInactiveAssignments: assignments.length - routableAssignments.length,
  };
}

function typedConnectorMappingParity(mappings, revisions, expectedCount) {
  if (!Array.isArray(mappings) || mappings.length !== expectedCount) return { available: false, mapped: mappings?.length ?? 0 };
  const byRevision = new Map(revisions.map(row => [`${row.connector_id}|${Number(row.revision)}`, row]));
  const seenSources = new Set();
  const seenTargets = new Set();
  for (const mapping of mappings) {
    if (!mapping || !/^[a-f0-9]{64}$/.test(mapping.sourceIdSha256 || '')
        || !/^[a-f0-9]{64}$/.test(mapping.sourceRowSha256 || '')
        || !/^[a-f0-9]{64}$/.test(mapping.recipeSha256 || '')
        || typeof mapping.connectorId !== 'string'
        || !Number.isSafeInteger(mapping.revision) || mapping.revision < 1
        || !['ACTIVE','RETIRED'].includes(mapping.state)
        || seenSources.has(mapping.sourceIdSha256)
        || seenTargets.has(`${mapping.connectorId}|${mapping.revision}`)) return { available: false, mapped: mappings.length };
    const key = `${mapping.connectorId}|${mapping.revision}`;
    const target = byRevision.get(key);
    if (!target || target.state !== mapping.state) return { available: false, mapped: mappings.length };
    seenSources.add(mapping.sourceIdSha256);
    seenTargets.add(key);
  }
  return { available: true, mapped: mappings.length };
}

function profileMappingParity(mappings, profiles, expectedCount) {
  if (!Array.isArray(mappings) || mappings.length !== expectedCount) return { available: false, mapped: mappings?.length ?? 0 };
  const profileByScope = new Map(profiles.map(row => [`${row.api_key_id}|${row.endpoint_slug}`, row]));
  const seenSource = new Set();
  const seenScope = new Set();
  for (const mapping of mappings) {
    const scope = `${mapping?.apiKeyId}|${mapping?.endpointSlug}`;
    if (!mapping || !/^[a-f0-9]{64}$/.test(mapping.sourceIdSha256 || '')
        || !/^[a-f0-9]{64}$/.test(mapping.sourceRowSha256 || '')
        || !/^[a-f0-9]{64}$/.test(mapping.connectorBindingsSha256 || '')
        || !/^[a-f0-9]{64}$/.test(mapping.profileContentSha256 || '')
        || !Number.isSafeInteger(mapping.profileRevision) || mapping.profileRevision < 1
        || seenSource.has(mapping.sourceIdSha256) || seenScope.has(scope)) return { available: false, mapped: mappings.length };
    const target = profileByScope.get(scope);
    if (!target || Number(target.revision) !== mapping.profileRevision
        || hash(target.connector_bindings || {}) !== mapping.connectorBindingsSha256
        || profileContentSha256(target) !== mapping.profileContentSha256) return { available: false, mapped: mappings.length };
    seenSource.add(mapping.sourceIdSha256);
    seenScope.add(scope);
  }
  return { available: true, mapped: mappings.length };
}

function profileContentSha256(row) {
  return hash({
    profileId: row.profile_id,
    revision: Number(row.revision),
    apiKeyId: row.api_key_id,
    businessId: row.business_id,
    businessVersion: row.business_version,
    action: row.action,
    endpointSlug: row.endpoint_slug,
    profileName: row.profile_name,
    enabled: row.enabled,
    parameters: row.parameters,
    jobPriority: row.job_priority,
    allowedFileExtensions: row.allowed_file_extensions,
    fileUrlAuthCipherSha256: row.file_url_auth_cipher == null ? null : hash(row.file_url_auth_cipher),
    connectionsOverride: row.connections_override,
  });
}

function promptOverrideRowsSha256(rows) {
  return hash(rows.map(row => ({
    connection_id: String(row.connection_id).toLowerCase(),
    api_key_id: String(row.api_key_id).toLowerCase(),
    endpoint_slug: row.endpoint_slug,
    step_id: row.step_id,
    prompt_override: row.prompt_override ?? null,
    is_active: Boolean(row.is_active),
  })).sort((a, b) => `${a.connection_id}|${a.api_key_id}|${a.endpoint_slug}|${a.step_id}`
    .localeCompare(`${b.connection_id}|${b.api_key_id}|${b.endpoint_slug}|${b.step_id}`)));
}

function normalizedUtc(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') return null;
  const text = value.replace(' ', 'T');
  const utcText = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?$/.test(text) ? text + 'Z' : text;
  const parsed = new Date(utcText);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : null;
}

function normalizedDecimal(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const text = String(value);
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (!match || (match[3] || '').length > 6) return null;
  const whole = match[2].replace(/^0+(?=\d)/, '');
  const fraction = (match[3] || '').padEnd(6, '0');
  const sign = match[1] === '-' && (whole !== '0' || /[1-9]/.test(fraction)) ? '-' : '';
  return `${sign}${whole}.${fraction}`;
}

function apiKeyRowsSha256(rows) {
  return hash(rows.map(row => ({
    id: String(row.id).toLowerCase(),
    status: row.status,
    keyHashSha256: hash(row.hash ?? row.keyHash),
    prefix: row.prefix,
    name: row.name,
    spendingLimit: normalizedDecimal(row.spending_limit ?? row.spendingLimit),
    totalUsed: normalizedDecimal(row.total_used ?? row.totalUsed),
    createdAt: normalizedUtc(row.created_at ?? row.createdAt),
    updatedAt: normalizedUtc(row.updated_at ?? row.updatedAt),
  })).sort((a, b) => a.id.localeCompare(b.id)));
}

function configurationSnapshotSha256(material, connectorPlane) {
  const storageGenerations = material.storageGenerations.map(row => ({
    generationId: row.generation_id,
    revision: Number(row.revision),
    backend: row.backend,
    endpointSha256: hash(row.endpoint),
    bucketSha256: hash(row.bucket),
    region: row.region,
    forcePathStyle: row.force_path_style,
    credentialVersionRefSha256: row.credential_version_ref ? hash(row.credential_version_ref) : null,
    state: row.state,
    testedAt: row.tested_at,
    activatedAt: row.activated_at,
  }));
  const identity = {
    users: material.users.map(row => ({ id: row.id, role: row.role, enabled: row.is_enabled, locked: row.is_locked,
      version: Number(row.version), assignmentVersion: Number(row.assignment_version), resetRequired: row.legacy_password_reset_required })),
    assignments: material.assignments,
    profileGrants: material.profileGrants,
    apiKeyGrants: material.apiKeyGrants,
  };
  return hash({
    settings: material.settings,
    operations: material.operations,
    keys: material.keys,
    profiles: material.profiles,
    memberships: material.memberships,
    workflows: material.workflows,
    overrides: material.overrides,
    oldConnectors: material.oldConnectors,
    blobChecks: material.blobChecks,
    globalHeads: material.aiHeads,
    globalRevisions: material.aiRevisions,
    retentionHeads: material.retentionHeads,
    retentionRevisions: material.retentionRevisions,
    storageState: material.storageState,
    storageGenerations,
    identity,
    usageEvents: material.usageEvents,
    budgets: material.budgets,
    budgetHeads: material.budgetHeads,
    priceRevisions: material.priceRevisions,
    reservationGroups: material.reservationGroups,
    budgetHolds: material.budgetHolds,
    connectorSnapshotSha256: connectorPlane.snapshotSha256,
  });
}

function configurationCoreSha256(material, connectorPlane) {
  const identity = {
    users: material.users.map(row => ({ id: row.id, role: row.role, locked: row.is_locked,
      assignmentVersion: Number(row.assignment_version), sourcePolicySha256: hash(row.legacy_identity_metadata || {}) })),
    assignments: material.assignments,
    profileGrants: material.profileGrants,
    apiKeyGrants: material.apiKeyGrants,
  };
  return hash({
    settings: material.settings,
    operations: material.operations,
    keys: material.keys,
    profiles: material.profiles,
    memberships: material.memberships,
    workflows: material.workflows,
    overrides: material.overrides,
    oldConnectors: material.oldConnectors,
    blobChecks: material.blobChecks,
    globalHeads: material.aiHeads,
    globalRevisions: material.aiRevisions,
    retentionHeads: material.retentionHeads,
    retentionRevisions: material.retentionRevisions,
    storageState: material.storageState,
    storageGenerations: material.storageGenerations.map(row => ({
      generationId: row.generation_id, revision: Number(row.revision), backend: row.backend,
      endpointSha256: hash(row.endpoint), bucketSha256: hash(row.bucket), region: row.region,
      forcePathStyle: row.force_path_style,
      credentialVersionRefSha256: row.credential_version_ref ? hash(row.credential_version_ref) : null,
      state: row.state, testedAt: row.tested_at, activatedAt: row.activated_at,
    })),
    identity,
    usageEvents: material.usageEvents,
    budgets: material.budgets,
    budgetHeads: material.budgetHeads,
    priceRevisions: material.priceRevisions,
    reservationGroups: material.reservationGroups,
    budgetHolds: material.budgetHolds,
    connectorSnapshotSha256: connectorPlane.snapshotSha256,
  });
}

/**
 * Read bounded repeatable-read snapshots of the Orchestrator and Connector
 * planes. Returned evidence contains only identifiers, hashes, counts and
 * state; no setting values, prompts, Connector request/config, credential,
 * history payload, password material or blob bytes leave this function.
 *
 * `connectorPool` is a separate pool to the Connector PostgreSQL plane. When
 * it is absent, the result explicitly says that the two-plane inventory is
 * incomplete and cannot be used as continuity readiness evidence.
 */
async function inventory(pool, tenantId, sourceVersion, options = {}) {
  if (!/^[0-9a-f-]{36}$/i.test(tenantId) || !sourceVersion) fail('INVALID_SCOPE');
  const beganAt = Date.now();
  const maxRows = Number(process.env.LDBA_INVENTORY_MAX_ROWS || 100000);
  const maxBlobBytes = Number(process.env.LDBA_INVENTORY_MAX_BLOB_BYTES || 268435456);
  if (!Number.isSafeInteger(maxRows) || maxRows < 1 || maxRows > 1000000 || !Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 1) fail('INVALID_INVENTORY_LIMIT');

  const primary = await withSnapshot(pool, async client => {
    const query = (sql, values = [tenantId]) => boundedRows(client, sql, values, maxRows);
    const provenance = (await query('SELECT source_sha256,plan_sha256,source_counts,destination_counts FROM legacy_migration_runs WHERE tenant_id=$1 AND source_version=$2', [tenantId, sourceVersion]))[0];
    if (!provenance) fail('IMPORT_PROVENANCE_MISSING');

    const settings = await query('SELECT key,value,updated_at FROM legacy_app_settings WHERE tenant_id=$1 ORDER BY key');
    const operations = await query(`SELECT id,api_key_id,profile_id,state,output_file_path,submit_artifacts,legacy_history,output_content,extracted_data,
        tenant_defaults_digest,tenant_defaults_ai_revision,tenant_defaults_prompt_revision,tenant_default_connector_id,tenant_default_connector_revision,
        connector_recipe_pins_ref,workflow_schema_slug,workflow_schema_revision,workflow_schema_digest,updated_at
      FROM operations WHERE tenant_id=$1 ORDER BY id`);
    const keys = await query('SELECT id,status,hash,prefix,name,spending_limit::text,total_used::text,created_at,updated_at FROM api_keys WHERE tenant_id=$1 ORDER BY id');
    const profiles = await query(`SELECT p.profile_id,p.revision,p.api_key_id,p.endpoint_slug,p.business_id,p.business_version,p.action,p.enabled,p.connector_bindings,p.parameters,p.connections_override,p.allowed_file_extensions,p.file_url_auth_cipher,p.job_priority,n.profile_name
      FROM profile_bindings p JOIN profile_active_revisions a ON a.profile_id=p.profile_id AND a.revision=p.revision
      JOIN profile_names n ON n.profile_id=p.profile_id WHERE p.tenant_id=$1 ORDER BY p.profile_id`);
    const memberships = await query('SELECT profile_id,api_key_id,state FROM profile_api_keys WHERE tenant_id=$1 ORDER BY profile_id,api_key_id');
    const users = await query('SELECT id,role,is_enabled,is_locked,legacy_password_reset_required,version,assignment_version,legacy_identity_metadata FROM admin_local_users WHERE tenant_id=$1 ORDER BY id');
    const assignments = await query('SELECT a.user_id,a.api_key_id FROM user_profile_assignments a JOIN admin_local_users u ON u.id=a.user_id WHERE u.tenant_id=$1 ORDER BY a.user_id,a.api_key_id');
    const profileGrants = await optionalRows(client, 'admin_local_user_profile_grants',
      'SELECT user_id,profile_id FROM admin_local_user_profile_grants WHERE tenant_id=$1 ORDER BY user_id,profile_id', [tenantId], maxRows);
    const apiKeyGrants = await optionalRows(client, 'admin_local_user_api_key_grants',
      'SELECT user_id,api_key_id FROM admin_local_user_api_key_grants WHERE tenant_id=$1 ORDER BY user_id,api_key_id', [tenantId], maxRows);
    const workflows = await query('SELECT slug,revision,digest,schema_ref FROM legacy_workflow_schemas WHERE tenant_id=$1 ORDER BY slug,revision');
    const overrides = await query('SELECT connection_id,api_key_id,endpoint_slug,step_id,prompt_override,is_active FROM connector_prompt_overrides WHERE tenant_id=$1 ORDER BY connection_id,api_key_id,endpoint_slug,step_id');
    const oldConnectors = await optionalRows(client, 'connector_revisions',
      "SELECT connector_id,tenant_id,revision,adapter,state FROM connector_revisions WHERE tenant_id IN ($1::text,'') ORDER BY connector_id,tenant_id,revision", [tenantId], maxRows);
    const operationsAllCount = Number((await client.query('SELECT count(*)::int AS count FROM operations WHERE tenant_id=$1', [tenantId])).rows[0]?.count ?? 0);
    const artifacts = await query(`SELECT a.id,a.operation_id,a.task_id,a.purpose,a.storage_key,a.sha256,a.size_bytes,a.state,a.storage_backend,a.storage_version_id,a.manifest_version_id,a.storage_generation_id,b.bytes
      FROM artifacts a LEFT JOIN artifact_blobs b ON b.storage_key=a.storage_key AND b.tenant_id=a.tenant_id
      WHERE a.tenant_id=$1 ORDER BY a.id`);
    const postgresBlobBytes = artifacts.reduce((sum, row) => sum + (row.storage_backend === 'postgres' && Buffer.isBuffer(row.bytes) ? row.bytes.length : 0), 0);
    if (postgresBlobBytes > maxBlobBytes) fail('INVENTORY_BLOB_LIMIT_EXCEEDED');
    const blobChecks = artifacts.map(row => {
      const hasLocalBytes = Buffer.isBuffer(row.bytes);
      const actualSha256 = hasLocalBytes ? createHash('sha256').update(row.bytes).digest('hex') : null;
      const sizeMatches = hasLocalBytes && Number(row.bytes.length) === Number(row.size_bytes);
      return {
        id: row.id, operationId: row.operation_id, purpose: row.purpose, state: row.state,
        backend: row.storage_backend ?? 'postgres', storageGenerationId: row.storage_generation_id ?? null,
        storageVersionPinned: Boolean(row.storage_version_id), manifestVersionPinned: Boolean(row.manifest_version_id),
        expectedSha256: row.sha256, actualSha256, sizeMatches,
      };
    });
    const validArtifactIds = new Set(blobChecks.filter(row => row.actualSha256 && row.actualSha256 === row.expectedSha256 && row.sizeMatches).map(row => row.id));

    const aiHeads = await optionalRows(client, 'global_settings_tenant_heads',
      "SELECT stream,active_revision,draft_revision,next_revision FROM global_settings_tenant_heads WHERE tenant_id=$1 ORDER BY stream", [tenantId], maxRows);
    const aiRevisions = await optionalRows(client, 'global_settings_tenant_revisions',
      'SELECT stream,revision,state,content_digest,source_revision,tested_at,published_at FROM global_settings_tenant_revisions WHERE tenant_id=$1 ORDER BY stream,revision', [tenantId], maxRows);
    const retentionHeads = await optionalRows(client, 'global_settings_retention_head',
      'SELECT active_revision,draft_revision,next_revision FROM global_settings_retention_head WHERE singleton=true', [], maxRows);
    const retentionRevisions = await optionalRows(client, 'global_settings_retention_revisions',
      'SELECT revision,state,digest,source_revision,published_at FROM global_settings_retention_revisions ORDER BY revision', [], maxRows);
    const storageState = await optionalRows(client, 'storage_generation_state',
      'SELECT active_generation_id,revision FROM storage_generation_state WHERE singleton=true', [], maxRows);
    const storageGenerations = await optionalRows(client, 'storage_generations',
      'SELECT generation_id,revision,backend,endpoint,bucket,region,force_path_style,credential_version_ref,state,tested_at,activated_at FROM storage_generations ORDER BY revision', [], maxRows);
    const usageEvents = await optionalRows(client, 'usage_events',
      'SELECT event_id,operation_id,task_id,cost_reservation_group_id,received_at FROM usage_events WHERE operation_id IN (SELECT id FROM operations WHERE tenant_id=$1) ORDER BY event_id', [tenantId], maxRows);
    const budgets = await optionalRows(client, 'cost_budget_revisions',
      'SELECT budget_id,revision,state,content_digest,published_at FROM cost_budget_revisions WHERE tenant_id=$1 ORDER BY budget_id,revision', [tenantId], maxRows);
    const budgetHeads = await optionalRows(client, 'cost_budget_heads',
      'SELECT budget_id,head_revision,active_revision FROM cost_budget_heads WHERE tenant_id=$1 ORDER BY budget_id', [tenantId], maxRows);
    const priceRevisions = await optionalRows(client, 'cost_price_revisions',
      'SELECT revision,state,content_digest,published_at FROM cost_price_revisions ORDER BY revision', [], maxRows);
    const reservationGroups = await optionalRows(client, 'cost_reservation_groups',
      `SELECT reservation_group_id,operation_id,task_id,decision,state,confidence,hard_cap_enabled,price_revision,usage_event_id
       FROM cost_reservation_groups WHERE tenant_id=$1 ORDER BY reservation_group_id`, [tenantId], maxRows);
    const budgetHolds = await optionalRows(client, 'cost_budget_holds',
      `SELECT h.reservation_group_id,h.budget_id,h.state,h.usage_event_id FROM cost_budget_holds h
       JOIN cost_reservation_groups g ON g.reservation_group_id=h.reservation_group_id WHERE g.tenant_id=$1 ORDER BY h.reservation_group_id,h.budget_id`, [tenantId], maxRows);
    const continuityEvidence = await optionalRows(client, 'legacy_continuity_evidence',
      `SELECT evidence_kind,evidence_sha256,source_sha256,plan_sha256,target_sha256,counts,capabilities,holds,receipt,recorded_at
       FROM legacy_continuity_evidence WHERE tenant_id=$1 AND source_version=$2
       AND evidence_kind IN ('reconciliation','backup','restore','runtime_probe','cutover_probe')
       ORDER BY recorded_at DESC`, [tenantId, sourceVersion], Math.min(maxRows, 1000));

    const blobChecksFailed = blobChecks.filter(row => row.backend === 'postgres' && (!row.actualSha256 || row.actualSha256 !== row.expectedSha256 || !row.sizeMatches));
    const s3Artifacts = blobChecks.filter(row => row.backend === 's3');
    const issues = [];
    for (const row of blobChecksFailed) issues.push({ code: 'BLOB_INTEGRITY_FAILED', id: row.id });
    for (const row of s3Artifacts) if (!row.storageGenerationId || !row.storageVersionPinned || !row.manifestVersionPinned) issues.push({ code: 'S3_ARTIFACT_PIN_INCOMPLETE', id: row.id });
    for (const row of operations) {
      if (!['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(row.state)) issues.push({ code: 'DRAIN_REQUIRED', id: row.id });
      if (row.output_file_path && !artifacts.some(a => a.storage_key === row.output_file_path && (a.storage_backend === 's3' || validArtifactIds.has(a.id)))) issues.push({ code: 'OUTPUT_REFERENCE_MISSING', id: row.id });
      if (row.legacy_history?.idempotencyKey) issues.push({ code: 'LEGACY_RETRY_WINDOW_RECONCILIATION_REQUIRED', id: row.id });
      if (row.legacy_history?.webhookUrl && !row.legacy_history.webhookSentAt) issues.push({ code: 'HISTORICAL_CALLBACK_RECONCILIATION_REQUIRED', id: row.id });
    }
    for (const row of profiles) {
      if (!memberships.some(m => m.profile_id === row.profile_id && m.api_key_id === row.api_key_id && m.state === 'ACTIVE')) issues.push({ code: 'PROFILE_MEMBERSHIP_MISSING', id: row.profile_id });
      if (row.enabled && !Object.keys(row.connector_bindings || {}).length) issues.push({ code: 'EFFECTIVE_CONNECTOR_MAPPING_REQUIRED', id: row.profile_id });
      for (const pin of Object.values(row.connector_bindings || {})) if (!oldConnectors.some(c => c.connector_id === pin.connectorId && Number(c.revision) === pin.revision && c.state === 'ACTIVE')) issues.push({ code: 'CONNECTOR_PIN_MISSING_OR_INACTIVE', id: row.profile_id });
    }
    for (const row of users) if (row.legacy_password_reset_required) {
      issues.push({ code: 'LEGACY_PASSWORD_RESET_REQUIRED', id: row.id });
      if (row.is_locked) issues.push({ code: 'LEGACY_USER_LOCKED', id: row.id });
    }
    const unresolvedOidcUsers = users.filter(row => {
      const metadata = row.legacy_identity_metadata || {};
      return Boolean(metadata.provider || metadata.providerSub);
    });
    for (const row of unresolvedOidcUsers) issues.push({ code: 'OIDC_IDENTITY_RECONCILIATION_REQUIRED', id: row.id });
    for (const row of users) if (!row.is_enabled && !row.legacy_password_reset_required && !(row.legacy_identity_metadata || {}).provider && !(row.legacy_identity_metadata || {}).providerSub && !((row.legacy_identity_metadata || {}).sourcePolicy || {}).enabled === false) issues.push({ code: 'IDENTITY_RECONCILIATION_REQUIRED', id: row.id });
    const activeApiKeyIds = keys.filter(row => row.status === 'ACTIVE').map(row => row.id);
    const identityParity = identityAssignmentParity(assignments, profiles, profileGrants, apiKeyGrants, activeApiKeyIds);
    if (!identityParity.available) issues.push({ code: 'IDENTITY_ASSIGNMENT_RECONCILIATION_REQUIRED' });

    const streamHead = name => aiHeads.find(row => row.stream === name)?.active_revision ?? null;
    const capabilities = {
      globalAi: { available: aiHeads.length > 0 && aiRevisions.some(row => row.stream === 'ai' && row.state === 'PUBLISHED'), activeRevision: streamHead('ai') },
      globalPrompts: { available: aiHeads.length > 0 && aiRevisions.some(row => row.stream === 'prompts' && row.state === 'PUBLISHED'), activeRevision: streamHead('prompts'), requiredSlots: ['image','pdf','docx','compare','generate'] },
      retention: { available: retentionHeads.length > 0 && retentionRevisions.some(row => Number(row.revision) === Number(retentionHeads[0]?.active_revision) && row.state === 'PUBLISHED'), activeRevision: retentionHeads[0]?.active_revision ?? null },
      storage: { available: storageState.length > 0 && storageGenerations.some(row => row.generation_id === storageState[0]?.active_generation_id && row.state === 'ACTIVE'), activeGenerationId: storageState[0]?.active_generation_id ?? null, generations: storageGenerations.length },
      identity: {
        importedUsers: users.length,
        unresolvedRequiredResets: users.filter(row => row.legacy_password_reset_required).length,
        lockedRequiredResets: users.filter(row => row.legacy_password_reset_required && row.is_locked).length,
        unresolvedOidcUsers: unresolvedOidcUsers.length,
        sourceDisabledUsers: users.filter(row => ((row.legacy_identity_metadata || {}).sourcePolicy || {}).enabled === false).length,
        importedAssignmentRows: assignments.length, profileGrantRows: profileGrants.length, apiKeyGrantRows: apiKeyGrants.length,
        inactiveSourceAssignmentRows: identityParity.excludedInactiveAssignments,
        assignmentParity: identityParity.available,
        expectedProfileGrantRows: identityParity.expectedProfileGrants,
        expectedApiKeyGrantRows: identityParity.expectedApiKeyGrants,
      },
      cost: { basicUsageEvents: usageEvents.filter(row => row.cost_reservation_group_id == null).length, richUsageEvents: usageEvents.filter(row => row.cost_reservation_group_id != null).length, budgetRevisions: budgets.length, activeBudgets: budgetHeads.filter(row => row.active_revision != null).length, priceRevisions: priceRevisions.length, reservationGroups: reservationGroups.length, budgetHolds: budgetHolds.length },
      history: { operations: operationsAllCount, importedOperations: operations.length, terminalOperations: operations.filter(row => ['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(row.state)).length, artifacts: artifacts.length, postgresArtifactsVerified: blobChecks.filter(row => row.backend === 'postgres' && row.actualSha256 === row.expectedSha256 && row.sizeMatches).length, s3ArtifactsNeedingExternalProbe: s3Artifacts.length },
      connectorPlane: { available: false, revisions: 0, invocations: 0, undeliveredUsage: 0, snapshotSha256: null },
    };
    const sourceSettingsDisposition = settings.map(row => ({ key: row.key, valueSha256: hash(row.value), disposition: MAX_SETTING_RETIREMENTS[row.key] ?? 'RECONCILIATION_REQUIRED' }));
    const sourceRetirementEvidence = Object.entries(MAX_SETTING_RETIREMENTS).map(([key, disposition]) => ({ key, disposition, sourceValuePresent: settings.some(row => row.key === key), sourceValueSha256: settings.find(row => row.key === key) ? hash(settings.find(row => row.key === key).value) : null, sourceReview: key === 'api_secret_key' ? 'canonical compatibility review §6: no current runtime consumer; never import as an Admin/bootstrap/API credential' : 'source scan found no current runtime consumer; explicit extension retirement required' }));

    const material = {
      settings: settings.map(row => ({ key: row.key, valueSha256: hash(row.value), updatedAt: row.updated_at })),
      operations: operations.map(row => ({ ...row, output_content: row.output_content == null ? null : hash(row.output_content), extracted_data: row.extracted_data == null ? null : hash(row.extracted_data) })),
      keys, profiles, memberships, users, assignments, profileGrants, apiKeyGrants, workflows, overrides, oldConnectors,
      blobChecks, aiHeads, aiRevisions, retentionHeads, retentionRevisions, storageState, storageGenerations,
      usageEvents, budgets, budgetHeads, priceRevisions, reservationGroups, budgetHolds, continuityEvidence,
    };
    const minimums = { api_keys: keys.length, profile_bindings: profiles.length, operations: operationsAllCount, connector_prompt_overrides: overrides.length, artifacts: artifacts.length, admin_local_users: users.length, user_profile_assignments: assignments.length, legacy_workflow_schemas: workflows.length, legacy_app_settings: settings.length };
    for (const [entity, actual] of Object.entries(minimums)) if (actual < Number(provenance.destination_counts?.[entity] || 0)) issues.push({ code: 'IMPORTED_ENTITY_COUNT_DEFICIT', entity });

    return {
      provenance,
      settings,
      material,
      blobChecks,
      operations,
      artifacts,
      issues,
      capabilities,
      sourceSettingsDisposition,
      sourceRetirementEvidence,
      continuityEvidence,
      counts: {
        settings: settings.length, operations: operationsAllCount, keys: keys.length, profiles: profiles.length,
        memberships: memberships.length, users: users.length, legacyAssignments: assignments.length,
        profileGrants: profileGrants.length, apiKeyGrants: apiKeyGrants.length, workflows: workflows.length,
        promptOverrides: overrides.length, legacyConnectorRevisions: oldConnectors.length, artifacts: artifacts.length,
        postgresArtifactsVerified: blobChecks.filter(row => row.backend === 'postgres' && row.actualSha256 === row.expectedSha256 && row.sizeMatches).length,
        s3Artifacts: s3Artifacts.length, globalAiRevisions: aiRevisions.filter(row => row.stream === 'ai').length,
        globalPromptRevisions: aiRevisions.filter(row => row.stream === 'prompts').length, retentionRevisions: retentionRevisions.length,
        storageGenerations: storageGenerations.length, usageEvents: usageEvents.length, budgetRevisions: budgets.length,
        priceRevisions: priceRevisions.length, reservationGroups: reservationGroups.length, budgetHolds: budgetHolds.length,
      },
      verifiedBlobBytes: postgresBlobBytes,
      provenanceCounts: provenance,
    };
  });

  let connectorPlane = { available: false, typedRecipesAvailable: false, revisions: 0, typedRecipeRevisions: 0, invocations: 0, undeliveredUsage: 0, stateCounts: {}, typedStateCounts: {}, snapshotSha256: null, issue: 'CONNECTOR_DATABASE_UNAVAILABLE' };
  if (options.connectorPool) {
    connectorPlane = await withSnapshot(options.connectorPool, async client => {
      const revisions = await optionalRows(client, 'connector_revisions',
        `SELECT connector_id,tenant_id,account_id,revision,adapter,state,config,credential_source
         FROM connector_revisions WHERE tenant_id IN ($1,'') ORDER BY connector_id,tenant_id,revision`, [tenantId], maxRows);
      const invocations = await optionalRows(client, 'connector_invocations',
        'SELECT state,count(*)::int AS count FROM connector_invocations WHERE tenant_id=$1 GROUP BY state ORDER BY state', [tenantId], maxRows);
      const outbox = await optionalRows(client, 'connector_usage_outbox',
        `SELECT count(*) FILTER (WHERE delivered_at IS NULL)::int AS undelivered,
                count(*)::int AS total FROM connector_usage_outbox WHERE invocation_id IN (SELECT invocation_id FROM connector_invocations WHERE tenant_id=$1)`, [tenantId], maxRows);
      const typedRecipesAvailable = await tableExists(client, 'connector_parity_revisions');
      const typedRevisions = typedRecipesAvailable ? await boundedRows(client,
        `SELECT tenant_id,connector_id,revision,state,recipe_envelope,credential_ref,credential_version,credential_source
         FROM connector_parity_revisions WHERE tenant_id=$1 ORDER BY connector_id,revision`, [tenantId], maxRows) : [];
      const revisionSummary = revisions.map(row => ({ connectorId: row.connector_id, tenantId: row.tenant_id, accountId: row.account_id,
        revision: Number(row.revision), adapter: row.adapter, state: row.state,
        configSha256: hash(row.config), credentialSourceSha256: hash(row.credential_source),
        credentialSourceKind: row.credential_source?.kind ?? null }));
      const typedRevisionSummary = typedRevisions.map(row => ({ connectorId: row.connector_id, tenantId: row.tenant_id,
        revision: Number(row.revision), state: row.state, recipeEnvelopeSha256: hash(row.recipe_envelope),
        credentialPinned: row.credential_ref !== null && row.credential_version !== null,
        credentialSourceSha256: row.credential_source ? hash(row.credential_source) : null,
        credentialSourceKind: row.credential_source?.kind ?? null }));
      const invocationStates = rollup(invocations, 'state');
      const typedStateCounts = {};
      for (const row of typedRevisions) typedStateCounts[row.state] = (typedStateCounts[row.state] || 0) + 1;
      const undeliveredUsage = Number(outbox[0]?.undelivered ?? 0);
      const digestMaterial = { revisions: revisionSummary, typedRevisions: typedRevisionSummary, invocationStates, typedStateCounts,
        outbox: outbox.map(row => ({ total: Number(row.total), undelivered: Number(row.undelivered) })) };
      return { available: true, typedRecipesAvailable, revisions: revisions.length, typedRecipeRevisions: typedRevisions.length,
        invocations: Object.values(invocationStates).reduce((a,b) => a+b,0), undeliveredUsage, stateCounts: invocationStates,
        typedStateCounts, typedRevisions: typedRevisions.map(row => ({ connector_id: row.connector_id, revision: Number(row.revision), state: row.state })),
        snapshotSha256: hash(digestMaterial), issue: undeliveredUsage ? 'CONNECTOR_USAGE_DELIVERY_PENDING' : null };
    });
  }
  primary.capabilities.connectorPlane = connectorPlane;
  if (!connectorPlane.available) primary.issues.push({ code: connectorPlane.issue });
  if (connectorPlane.available && !connectorPlane.typedRecipesAvailable) primary.issues.push({ code: 'CONNECTOR_TYPED_RECIPE_PLANE_UNAVAILABLE' });
  if (connectorPlane.undeliveredUsage > 0) primary.issues.push({ code: 'CONNECTOR_USAGE_DELIVERY_PENDING' });

  const targetConfigurationSha256 = configurationSnapshotSha256(primary.material, connectorPlane);
  const targetConfigurationCoreSha256 = configurationCoreSha256(primary.material, connectorPlane);
  const targetInventorySha256 = hash({ material: primary.material, connectorPlane });
  const archivedSettings = primary.settings.filter(row => !row.key.startsWith('wb_schema:'));
  const sourceSettingsSha256 = hash(archivedSettings.map(row => ({ key: row.key, valueSha256: hash(row.value), updatedAt: row.updated_at })));
  const reconciliationEvidence = primary.continuityEvidence.find(row => row.evidence_kind === 'reconciliation') ?? null;
  const reconciliationReceipt = reconciliationEvidence?.receipt && typeof reconciliationEvidence.receipt === 'object' ? reconciliationEvidence.receipt : {};
  const reconciliationCounts = reconciliationEvidence?.counts && typeof reconciliationEvidence.counts === 'object' ? reconciliationEvidence.counts : {};
  const apiSecretSourceSha256 = primary.sourceRetirementEvidence.find(row => row.key === 'api_secret_key')?.sourceValueSha256 ?? null;
  const sourceCounts = primary.provenance.source_counts || {};
  const connectorMappingParity = connectorPlane.available && connectorPlane.typedRecipesAvailable
    ? typedConnectorMappingParity(reconciliationReceipt.legacyConnectorMappings, connectorPlane.typedRevisions, Number(sourceCounts.ExternalApiConnection ?? -1))
    : { available: false, mapped: 0 };
  const profileParity = profileMappingParity(reconciliationReceipt.profileMappings, primary.material.profiles, Number(sourceCounts.ProfileEndpoint ?? -1));
  const identityState = Array.isArray(reconciliationReceipt.identityState) ? reconciliationReceipt.identityState : [];
  const targetPromptOverridesSha256 = promptOverrideRowsSha256(primary.material.overrides);
  const promptOverrideMapping = reconciliationReceipt.promptOverrideMapping && typeof reconciliationReceipt.promptOverrideMapping === 'object'
    ? reconciliationReceipt.promptOverrideMapping : {};
  const promptOverrideParity = Number(promptOverrideMapping.count) === Number(sourceCounts.ExternalApiOverride)
    && Number(promptOverrideMapping.count) === primary.material.overrides.length
    && promptOverrideMapping.sourceProjectionSha256 === targetPromptOverridesSha256
    && promptOverrideMapping.targetProjectionSha256 === targetPromptOverridesSha256;
  const targetApiKeysSha256 = apiKeyRowsSha256(primary.material.keys);
  const apiKeyMapping = reconciliationReceipt.apiKeyMapping && typeof reconciliationReceipt.apiKeyMapping === 'object'
    ? reconciliationReceipt.apiKeyMapping : {};
  const apiKeyParity = Number(apiKeyMapping.count) === Number(sourceCounts.ApiKey)
    && Number(apiKeyMapping.count) === primary.material.keys.length
    && apiKeyMapping.sourceProjectionSha256 === targetApiKeysSha256
    && apiKeyMapping.targetProjectionSha256 === targetApiKeysSha256;
  const mappingChecks = {
    provenance: Boolean(reconciliationEvidence
      && reconciliationEvidence.source_sha256 === primary.provenance.source_sha256
      && reconciliationEvidence.plan_sha256 === primary.provenance.plan_sha256),
    receiptVersion: reconciliationReceipt.status === 'VERIFIED' && reconciliationReceipt.mappingVersion === 'legacy-settings-map-v1',
    sourceSettings: reconciliationReceipt.sourceSettingsSha256 === sourceSettingsSha256,
    targetSnapshot: reconciliationReceipt.configurationSnapshotSha256 === targetConfigurationSha256,
    targetCore: reconciliationReceipt.configurationCoreSha256 === targetConfigurationCoreSha256,
    apiSecretRetirement: reconciliationReceipt.apiSecretKeyDisposition === 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER'
      && (reconciliationReceipt.apiSecretKeySha256 ?? null) === apiSecretSourceSha256,
    functionalSettings: Number(reconciliationCounts.functionalSettings) === 16,
    retiredSettings: Number(reconciliationCounts.retiredSettings) === 3,
    apiKeys: apiKeyParity && Number(reconciliationCounts.apiKeys) === Number(sourceCounts.ApiKey),
    promptOverrides: promptOverrideParity && Number(reconciliationCounts.promptOverrides) === Number(sourceCounts.ExternalApiOverride),
    connectors: connectorMappingParity.available && Number(reconciliationCounts.legacyConnectors) === Number(sourceCounts.ExternalApiConnection),
    profiles: profileParity.available && Number(reconciliationCounts.profileMappings) === Number(sourceCounts.ProfileEndpoint),
    users: Number(reconciliationCounts.importedUsers) === Number(sourceCounts.User)
      && Number(reconciliationCounts.identityStateRows) === Number(sourceCounts.User)
      && identityState.length === Number(sourceCounts.User),
    identitySourceAssignments: Number(reconciliationCounts.sourceIdentityAssignments) === Number(sourceCounts.UserProfileAssignment)
      && primary.capabilities.identity.assignmentParity === true,
  };
  const settingsMappingVerified = Object.values(mappingChecks).every(Boolean);
  const settingsDisposition = key => {
    if (MAX_SETTING_RETIREMENTS[key]) return MAX_SETTING_RETIREMENTS[key];
    if (!settingsMappingVerified) return 'RECONCILIATION_REQUIRED';
    if (['ai_provider','ai_model'].includes(key)) return 'MAPPED_TENANT_AI_DEFAULT';
    if (['ai_api_key','openai_api_key','openai_base_url'].includes(key)) return 'MAPPED_APPROVED_CONNECTOR_REVISION';
    if (key.startsWith('ai_') && key.endsWith('_prompt')) return 'MAPPED_TENANT_PROMPT_DEFAULT';
    if (['s3_endpoint','s3_bucket','s3_access_key','s3_secret_key','s3_region'].includes(key)) return 'MAPPED_STORAGE_GENERATION';
    if (key === 's3_cache_ttl_hours') return 'MAPPED_RETENTION_REVISION';
    return 'UNCLASSIFIED_ARCHIVED_SETTING';
  };
  const dispositionByKey = new Map(primary.settings.map(row => [row.key, row]));
  primary.sourceSettingsDisposition = [
    'ai_provider','ai_model','ai_api_key','ai_image_prompt','ai_pdf_prompt','ai_docx_prompt','ai_compare_prompt','ai_generate_prompt',
    'openai_api_key','openai_base_url','api_secret_key','s3_endpoint','s3_bucket','s3_access_key','s3_secret_key','s3_region','s3_cache_ttl_hours',
    'docx_conversion_mode','docx_intermediate_format',
  ].map(key => ({ key, valueSha256: dispositionByKey.has(key) ? hash(dispositionByKey.get(key).value) : null,
    sourceValuePresent: dispositionByKey.has(key), disposition: settingsDisposition(key) }));
  primary.capabilities.configurationMapping = {
    available: settingsMappingVerified,
    status: settingsMappingVerified ? 'VERIFIED' : 'RECONCILIATION_REQUIRED',
    evidenceSha256: reconciliationEvidence?.evidence_sha256 ?? null,
    functionalSettings: Number(reconciliationCounts.functionalSettings ?? 0),
    retiredSettings: Number(reconciliationCounts.retiredSettings ?? 0),
    legacyConnectorMappings: connectorMappingParity.mapped,
    connectorMappingParity: connectorMappingParity.available,
    profileMappings: profileParity.mapped,
    profileMappingParity: profileParity.available,
    promptOverrides: Number(promptOverrideMapping.count ?? 0),
    promptOverrideParity,
    promptOverridesSha256: targetPromptOverridesSha256,
    apiKeys: Number(apiKeyMapping.count ?? 0),
    apiKeyParity,
    apiKeysSha256: targetApiKeysSha256,
    sourceAssignmentRows: Number(reconciliationCounts.sourceIdentityAssignments ?? 0),
    inactiveSourceAssignmentRows: primary.capabilities.identity.inactiveSourceAssignmentRows,
    failedChecks: Object.entries(mappingChecks).filter(([, passed]) => !passed).map(([name]) => name),
    targetConfigurationSha256,
  };
  if (!settingsMappingVerified) primary.issues.push({ code: 'FULL_SETTINGS_RECONCILIATION_REQUIRED' });
  const holds = [...primary.issues];
  if (!primary.capabilities.globalAi.available) holds.push({ code: 'TENANT_GLOBAL_AI_MAPPING_REQUIRED' });
  if (!primary.capabilities.globalPrompts.available) holds.push({ code: 'TENANT_GLOBAL_PROMPTS_MAPPING_REQUIRED' });
  if (!primary.capabilities.retention.available) holds.push({ code: 'RETENTION_MAPPING_REQUIRED' });
  if (!primary.capabilities.storage.available) holds.push({ code: 'STORAGE_GENERATION_REQUIRED' });
  if (primary.capabilities.identity.unresolvedRequiredResets > 0) holds.push({ code: 'LEGACY_PASSWORD_RESET_REQUIRED', count: primary.capabilities.identity.unresolvedRequiredResets });
  if (!primary.capabilities.identity.assignmentParity) holds.push({ code: 'IDENTITY_ASSIGNMENT_RECONCILIATION_REQUIRED' });
  if (primary.capabilities.history.s3ArtifactsNeedingExternalProbe > 0) holds.push({ code: 'S3_ARTIFACT_RUNTIME_PROBE_REQUIRED', count: primary.capabilities.history.s3ArtifactsNeedingExternalProbe });
  const latestEvidence = kind => primary.continuityEvidence.find(row => row.evidence_kind === kind) ?? null;
  const restoreEvidence = latestEvidence('restore');
  const runtimeEvidence = latestEvidence('runtime_probe');
  const isolatedCutoverEvidence = primary.continuityEvidence.find(row => row.evidence_kind === 'cutover_probe' && row.receipt?.scope === 'synthetic') ?? null;
  const customerCutoverEvidence = primary.continuityEvidence.find(row => row.evidence_kind === 'cutover_probe' && row.receipt?.scope === 'customer-authorized'
    && row.source_sha256 === primary.provenance.source_sha256 && row.plan_sha256 === primary.provenance.plan_sha256) ?? null;
  const syntheticRestoreVerified = restoreEvidence?.receipt?.status === 'VERIFIED'
    && restoreEvidence.receipt?.scope === 'synthetic'
    && restoreEvidence.receipt?.cutover === 'NOT_PERFORMED';
  const runtimeProbeVerified = runtimeEvidence?.receipt?.status === 'VERIFIED'
    && runtimeEvidence.receipt?.scope === 'synthetic'
    && runtimeEvidence.receipt?.login === 'PASSED'
    && runtimeEvidence.receipt?.history === 'PASSED'
    && runtimeEvidence.receipt?.artifactDecrypt === 'PASSED'
    && runtimeEvidence.receipt?.download === 'PASSED';
  const isolatedCutoverVerified = isolatedCutoverEvidence?.receipt?.status === 'VERIFIED'
    && isolatedCutoverEvidence.receipt?.scope === 'synthetic'
    && isolatedCutoverEvidence.receipt?.productionCutover === 'NOT_PERFORMED'
    && isolatedCutoverEvidence.receipt?.rollbackProbe === 'PASSED';
  const customerReceipt = customerCutoverEvidence?.receipt ?? {};
  const customerSourceEvidenceValid = /^[a-f0-9]{64}$/.test(customerReceipt.sourceFreezeEvidenceSha256 ?? '')
    && customerReceipt.sourceFreeze === 'VERIFIED' && customerReceipt.sourceTimezone === 'VERIFIED';
  const customerAuthorizationValid = /^[a-f0-9]{64}$/.test(customerReceipt.cutoverAuthorizationEvidenceSha256 ?? '')
    && customerReceipt.cutoverAuthorization === 'APPROVED';
  const customerEvidence = {
    sourceFreeze: customerSourceEvidenceValid ? 'VERIFIED' : 'PENDING_CUSTOMER_INPUT',
    sourceTimezone: customerSourceEvidenceValid ? 'VERIFIED' : 'PENDING_CUSTOMER_INPUT',
    cutoverAuthorization: customerAuthorizationValid ? 'APPROVED' : 'PENDING_CUSTOMER_INPUT',
    evidenceSha256: customerCutoverEvidence?.evidence_sha256 ?? null,
    productionCutover: 'NOT_PERFORMED',
  };
  const capabilityReady = holds.length === 0;
  const continuityEvidence = {
    isolatedRestore: syntheticRestoreVerified ? 'VERIFIED' : 'PENDING',
    sourceOffRuntimeProbe: runtimeProbeVerified ? 'VERIFIED' : 'PENDING',
    isolatedCutoverProbe: isolatedCutoverVerified ? 'VERIFIED' : 'PENDING',
    rehearsalReady: capabilityReady && syntheticRestoreVerified && runtimeProbeVerified && isolatedCutoverVerified,
  };
  const cutoverReady = continuityEvidence.rehearsalReady
    && customerEvidence.sourceFreeze === 'VERIFIED'
    && customerEvidence.sourceTimezone === 'VERIFIED'
    && customerEvidence.cutoverAuthorization === 'APPROVED'
    && customerEvidence.productionCutover === 'NOT_PERFORMED';
  const report = {
    version: 'ldba-continuity-inventory-v2', tenantId, sourceVersion,
    sourceSha256: primary.provenance.source_sha256, planSha256: primary.provenance.plan_sha256,
    sourceCounts: primary.provenance.source_counts, importedDestinationCounts: primary.provenance.destination_counts,
    targetCounts: primary.counts, archivedSettingsSha256: hash(archivedSettings.map(row => ({ key: row.key, valueSha256: hash(row.value), updatedAt: row.updated_at }))),
    inventorySha256: targetInventorySha256, configurationSnapshotSha256: targetConfigurationSha256,
    configurationCoreSha256: targetConfigurationCoreSha256,
    sourceSettingsSha256, sourceSettingsDisposition: primary.sourceSettingsDisposition,
    sourceRetirementEvidence: primary.sourceRetirementEvidence,
    blobChecks: primary.blobChecks, capabilities: primary.capabilities, issues: holds, capabilityReady, continuityEvidence,
    customerEvidence,
    cutoverReady,
    externalGates: [
      'Frozen legacy source and timezone evidence from customer',
      'Independent encrypted backup and isolated restore with dual-plane counts',
      'Source-off login, Profile, defaults, historical result and encrypted download proof',
      'Expired client idempotency and callback window reconciliation',
      'Approved customer cutover window and rollback ownership',
      'Customer plugin inventory confirmation for api_secret_key retirement',
    ],
    metrics: { elapsedMs: Date.now() - beganAt, verifiedBlobBytes: primary.verifiedBlobBytes, maxRowsPerEntity: maxRows, maxBlobBytes, materialization: 'bounded repeatable-read metadata and PostgreSQL blob checks; S3 bytes verified by isolated runtime adapter', connectorSnapshotSha256: connectorPlane.snapshotSha256 },
  };
  return report;
}

module.exports = { inventory, hash, canonical, fail, MAX_SETTING_RETIREMENTS, identityAssignmentParity, typedConnectorMappingParity, profileMappingParity, profileContentSha256, promptOverrideRowsSha256, apiKeyRowsSha256, configurationCoreSha256 };
