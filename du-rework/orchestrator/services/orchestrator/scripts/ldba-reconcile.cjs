'use strict';
const fs = require('node:fs');
const { createHash } = require('node:crypto');
const { inventory, hash, fail } = require('./ldba-inventory.cjs');
const { appendInventoryEvidence } = require('./ldba-continuity-evidence.cjs');
const PROMPTS = new Set(['ai_image_prompt','ai_pdf_prompt','ai_docx_prompt','ai_compare_prompt','ai_generate_prompt']);
const PIN_SOURCES = new Set(['ai_provider','ai_model','openai_base_url']);
const SHA = /^[a-f0-9]{64}$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;

function loadManifest(file, expectedSha) {
  const bytes = fs.readFileSync(file);
  const digest = createHash('sha256').update(bytes).digest('hex');
  if (!SHA.test(expectedSha || '') || digest !== expectedSha) fail('MANIFEST_DIGEST_MISMATCH');
  const manifest = JSON.parse(bytes.toString('utf8'));
  if (manifest.version !== 'ldba-effective-config-v1' || !UUID.test(manifest.tenantId || '') || !manifest.sourceVersion || !manifest.reviewedBy || !SHA.test(manifest.sourceSha256 || '') || !SHA.test(manifest.archivedSettingsSha256 || '') || !SHA.test(manifest.baselineInventorySha256 || '') || !Array.isArray(manifest.scopes) || !Array.isArray(manifest.mappings)) fail('INVALID_MANIFEST');
  return { manifest, digest };
}
function pointer(value, jsonPointer) {
  // Semantic evidence may inspect provider/model routing, never credentials.
  if (typeof jsonPointer !== 'string' || !/^\/(?:baseUrl|path|model|provider|requestMapping\/[A-Za-z_]*(?:model|provider)[A-Za-z_]*)$/i.test(jsonPointer)) fail('UNSUPPORTED_SEMANTIC_POINTER');
  return jsonPointer.slice(1).split('/').reduce((item, key) => item && typeof item === 'object' ? item[key] : undefined, value);
}

async function prepare(pool, manifest, digest, options = {}) {
  const report = await inventory(pool, manifest.tenantId, manifest.sourceVersion, options);
  if (report.sourceSha256 !== manifest.sourceSha256 || report.archivedSettingsSha256 !== manifest.archivedSettingsSha256) fail('SOURCE_ARCHIVE_BINDING_MISMATCH');
  const journal = (await pool.query('SELECT baseline_inventory_sha256,progress FROM legacy_configuration_reconciliations WHERE tenant_id=$1 AND source_version=$2 AND manifest_sha256=$3', [manifest.tenantId,manifest.sourceVersion,digest])).rows[0];
  if (journal ? journal.baseline_inventory_sha256 !== manifest.baselineInventorySha256 : report.inventorySha256 !== manifest.baselineInventorySha256) fail('TARGET_INVENTORY_CHANGED');
  const rows = (await pool.query('SELECT key,value FROM legacy_app_settings WHERE tenant_id=$1 ORDER BY key', [manifest.tenantId])).rows;
  const settings = new Map(rows.map(row => [row.key,row.value]));
  const seen = new Set();
  const groups = new Map();
  const holds = [];
  const diffs = [];
  for (const scope of manifest.scopes) {
    if (!scope || !UUID.test(scope.apiKeyId || '') || typeof scope.endpointSlug !== 'string' || !scope.endpointSlug || !(scope.expectedActiveRevision === null || Number.isSafeInteger(scope.expectedActiveRevision) && scope.expectedActiveRevision >= 0)) fail('INVALID_MAPPING_SCOPE');
    const id = hash({ apiKeyId: scope.apiKeyId, endpointSlug: scope.endpointSlug });
    if (groups.has(id)) fail('DUPLICATE_MAPPING_SCOPE');
    groups.set(id, { id, scope: { tenantId: manifest.tenantId,apiKeyId: scope.apiKeyId,endpointSlug: scope.endpointSlug }, expectedActiveRevision: scope.expectedActiveRevision, expectedProfileRevision: scope.expectedProfileRevision, changes: {}, sourceKeys: [] });
  }
  for (const mapping of manifest.mappings) {
    if (!mapping || typeof mapping.sourceKey !== 'string' || seen.has(mapping.sourceKey) || !settings.has(mapping.sourceKey)) fail('INVALID_OR_DUPLICATE_SOURCE_SETTING');
    seen.add(mapping.sourceKey);
    const value = settings.get(mapping.sourceKey);
    if (mapping.sourceValueSha256 !== hash(value)) fail('SOURCE_SETTING_CHANGED');
    if (mapping.disposition === 'deployment' || mapping.disposition === 'manual') {
      if (typeof mapping.reason !== 'string' || !mapping.reason.trim()) fail('DISPOSITION_REASON_REQUIRED');
      holds.push({ sourceKey: mapping.sourceKey, disposition: mapping.disposition, code: 'EXTERNAL_CONFIGURATION_RECONCILIATION_REQUIRED' });
      continue;
    }
    if (mapping.disposition !== 'settings-revision' || !Array.isArray(mapping.targets) || !mapping.targets.length) fail('INVALID_MAPPING_DISPOSITION');
    if (!PROMPTS.has(mapping.sourceKey) && !PIN_SOURCES.has(mapping.sourceKey)) fail('SETTING_REQUIRES_EXPLICIT_EXTERNAL_RECONCILIATION');
    for (const target of mapping.targets) {
      const id = hash({ apiKeyId: target.apiKeyId,endpointSlug: target.endpointSlug });
      const group = groups.get(id);
      if (!group || !target.semanticEvidence || typeof target.semanticEvidence !== 'string') fail('REVIEWED_SCOPE_SEMANTICS_REQUIRED');
      group.sourceKeys.push(mapping.sourceKey);
      if (PROMPTS.has(mapping.sourceKey)) {
        if (!UUID.test(target.connectionId || '') || target.stepId !== '_default' || typeof value !== 'string') fail('INVALID_PROMPT_MAPPING');
        const prompts = group.changes.prompts ||= [];
        const existing = prompts.find(p => p.connectionId === target.connectionId && p.stepId === target.stepId);
        if (existing && existing.promptOverride !== value) fail('CONFLICTING_PROMPT_MAPPING');
        if (!existing) prompts.push({ connectionId: target.connectionId,stepId: target.stepId,promptOverride: value });
        diffs.push({ sourceKey: mapping.sourceKey,scope: group.scope,consumer: 'connector_prompt_overrides',connectionId: target.connectionId,valueSha256: hash(value) });
      } else {
        if (typeof target.slot !== 'string' || !target.slot || typeof target.connectorId !== 'string' || !target.connectorId || !Number.isSafeInteger(target.revision) || target.revision < 1) fail('INVALID_PIN_MAPPING');
        const connectors = (await pool.query("SELECT config,state FROM connector_revisions WHERE connector_id=$1 AND revision=$2 AND tenant_id IN ($3::text,'')", [target.connectorId,target.revision,manifest.tenantId])).rows;
        if (connectors.length !== 1 || connectors[0].state !== 'ACTIVE') fail('CONNECTOR_REVISION_MISSING_OR_AMBIGUOUS');
        if (hash(connectors[0].config) !== target.connectorConfigSha256 || hash(pointer(connectors[0].config,target.configPointer)) !== hash(target.expectedConnectorValue)) fail('CONNECTOR_SEMANTIC_EVIDENCE_CHANGED');
        const pins = group.changes.connectorBindings ||= {};
        const pin = { connectorId: target.connectorId,revision: target.revision };
        if (pins[target.slot] && hash(pins[target.slot]) !== hash(pin)) fail('CONFLICTING_CONNECTOR_MAPPING');
        pins[target.slot] = pin;
        diffs.push({ sourceKey: mapping.sourceKey,scope: group.scope,consumer: 'profile.connectorBindings',slot: target.slot,pin,connectorConfigSha256: target.connectorConfigSha256 });
      }
    }
  }
  if (seen.size !== settings.size) fail('UNCLASSIFIED_ARCHIVED_SETTINGS');
  const plans = [...groups.values()].filter(group => group.sourceKeys.length);
  // Settings connectorBindings is a full replacement. Preserve all other slots
  // from current effective scope and bind the baseline with lifecycle CAS.
  for (const group of plans) if (group.changes.connectorBindings) {
    if (!Number.isSafeInteger(group.expectedProfileRevision) || group.expectedProfileRevision < 1) fail('EXPECTED_PROFILE_REVISION_REQUIRED');
    const profiles = (await pool.query(`SELECT p.connector_bindings FROM profile_active_revisions a JOIN profile_bindings p ON p.profile_id=a.profile_id AND p.revision=a.revision
      JOIN profile_api_keys m ON m.profile_id=p.profile_id AND m.api_key_id=$2 AND m.tenant_id=p.tenant_id AND m.state='ACTIVE'
      JOIN business_versions b ON b.business_id=p.business_id AND b.version=p.business_version AND b.is_active=true
      WHERE p.tenant_id=$1 AND p.business_id='document-core' AND p.action=$3 AND (p.endpoint_slug=$4 OR p.endpoint_slug IS NULL)
      ORDER BY (p.endpoint_slug IS NOT NULL) DESC,a.moved_at DESC,p.profile_id LIMIT 1`, [manifest.tenantId,group.scope.apiKeyId,group.scope.endpointSlug.split(':')[0],group.scope.endpointSlug])).rows;
    if (profiles.length !== 1) fail('EFFECTIVE_PROFILE_MISSING');
    // On resume use the originally journaled full-map draft to preserve the exact
    // idempotency payload instead of absorbing intervening profile edits.
    const prior = journal?.progress?.[group.id]?.connectorBindings;
    group.changes.connectorBindings = prior || { ...(profiles[0].connector_bindings || {}),...group.changes.connectorBindings };
  }
  return { plans, report: { version:'ldba-reconciliation-v1',tenantId:manifest.tenantId,sourceVersion:manifest.sourceVersion,sourceSha256:manifest.sourceSha256,manifestSha256:digest,baselineInventorySha256:manifest.baselineInventorySha256,currentInventorySha256:report.inventorySha256,resuming:!!journal,diffs,holds,cutoverReady:false }, journal };
}

function createAdminClient(baseUrl, token, transport = fetch) {
  const base = new URL(baseUrl);
  if (base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !(base.protocol === 'http:' && ['127.0.0.1','localhost','[::1]'].includes(base.hostname)))) fail('SECURE_ADMIN_ORIGIN_REQUIRED');
  if (!token) fail('ADMIN_CREDENTIAL_REQUIRED');
  const request = async (url, options = {}) => {
    const response = await transport(url,{ ...options,redirect:'error',signal:AbortSignal.timeout(30000),headers:{ Authorization:'Bearer '+token,...options.headers } });
    const body = await response.json();
    if (!response.ok) fail('ADMIN_REQUEST_FAILED_'+response.status);
    return body;
  };
  return {
    action: (action,params,key) => request(new URL('/api/v1/admin/actions',base),{ method:'POST',headers:{'Content-Type':'application/json','Idempotency-Key':key},body:JSON.stringify({action,params}) }),
    read: scope => request(new URL('/api/v1/admin/settings?'+new URLSearchParams(scope),base)),
  };
}
async function apply(pool, manifest, digest, prepared, admin) {
  await pool.query(`INSERT INTO legacy_configuration_reconciliations (tenant_id,source_version,manifest_sha256,baseline_inventory_sha256) VALUES ($1,$2,$3,$4) ON CONFLICT DO NOTHING`,[manifest.tenantId,manifest.sourceVersion,digest,manifest.baselineInventorySha256]);
  const outcomes = [];
  for (const plan of prepared.plans) {
    const prefix = 'ldba:'+digest+':'+plan.id;
    // Persist only non-secret full-map pins for deterministic restart payloads.
    await pool.query(`UPDATE legacy_configuration_reconciliations SET progress=jsonb_set(progress,ARRAY[$4],$5::jsonb),updated_at=clock_timestamp() WHERE tenant_id=$1 AND source_version=$2 AND manifest_sha256=$3`,[manifest.tenantId,manifest.sourceVersion,digest,plan.id,JSON.stringify({ connectorBindings:plan.changes.connectorBindings || null })]);
    const draft = await admin.action('settings.revision.create',{...plan.scope,expectedActiveRevision:plan.expectedActiveRevision,...(plan.expectedProfileRevision === undefined ? {} : {expectedProfileRevision:plan.expectedProfileRevision}),changes:plan.changes},prefix+':create');
    if (!Number.isSafeInteger(draft.revision)) fail('INVALID_SETTINGS_REVISION_RESPONSE');
    const readActive = async () => (await admin.read(plan.scope)).configuration?.activeRevision;
    let active = await readActive();
    if (active !== draft.revision) {
      const validation = await admin.action('settings.revision.validate',{...plan.scope,revision:draft.revision},prefix+':validate');
      if (validation.valid !== true) fail('SETTINGS_VALIDATION_FAILED');
      await admin.action('settings.revision.apply',{...plan.scope,revision:draft.revision,expectedActiveRevision:plan.expectedActiveRevision},prefix+':apply');
      active = await readActive();
    }
    if (active !== draft.revision) fail('APPLIED_CONFIGURATION_SUPERSEDED');
    const effective = await admin.read(plan.scope);
    if (effective.configuration?.activeRevisionMatchesEffective !== true) fail('EFFECTIVE_CONFIGURATION_DRIFT');
    for (const prompt of plan.changes.prompts || []) {
      const row = effective.promptOverrides?.find(item => item.connectionId === prompt.connectionId && item.stepId === prompt.stepId);
      if (!row || hash(row.promptOverride) !== hash(prompt.promptOverride?.trim() || null)) fail('EFFECTIVE_PROMPT_DRIFT');
    }
    for (const [slot,pin] of Object.entries(plan.changes.connectorBindings || {})) {
      if (!effective.availableConnections?.some(item => item.slot === slot && item.connectionId === pin.connectorId && item.revision === pin.revision)) fail('EFFECTIVE_CONNECTOR_DRIFT');
    }
    outcomes.push({scope:plan.scope,revision:draft.revision,status:'APPLIED_AND_ACTIVE'});
  }
  return {...prepared.report,outcomes};
}
async function cli() {
  const mode = process.argv[2];
  const env = process.env;
  const { Pool } = require('pg');
  if (!['--inventory','--record-inventory','--preflight','--apply'].includes(mode) || !env.LDBA03_TARGET_DATABASE_URL) fail('INVALID_COMMAND');
  const pool = new Pool({connectionString:env.LDBA03_TARGET_DATABASE_URL});
  const connectorPool = env.LDBA03_CONNECTOR_TARGET_DATABASE_URL
    ? new Pool({ connectionString: env.LDBA03_CONNECTOR_TARGET_DATABASE_URL })
    : null;
  const inventoryOptions = connectorPool ? { connectorPool } : {};
  try {
    if (mode === '--inventory' || mode === '--record-inventory') {
      const report = await inventory(pool,env.LDBA_TENANT_ID,env.LDBA03_SOURCE_VERSION,inventoryOptions);
      if (mode === '--record-inventory') {
        await pool.query(`INSERT INTO legacy_migration_inventory_reports (tenant_id,source_version,inventory_sha256,report) VALUES ($1,$2,$3,$4) ON CONFLICT (tenant_id,source_version,inventory_sha256) DO NOTHING`,[report.tenantId,report.sourceVersion,report.inventorySha256,JSON.stringify(report)]);
        report.evidence = await appendInventoryEvidence(pool, report);
      }
      process.stdout.write(JSON.stringify(report,null,2)+'\n'); return;
    }
    const {manifest,digest} = loadManifest(env.LDBA_RECONCILIATION_MANIFEST,env.LDBA_RECONCILIATION_SHA256);
    const prepared = await prepare(pool,manifest,digest,inventoryOptions);
    const report = mode === '--apply' ? await apply(pool,manifest,digest,prepared,createAdminClient(env.LDBA_ADMIN_ORIGIN,env.LDBA_ADMIN_BEARER)) : prepared.report;
    process.stdout.write(JSON.stringify(report,null,2)+'\n');
  } finally {
    await pool.end();
    if (connectorPool) await connectorPool.end();
  }
}
if (require.main === module) cli().catch(error => { process.stderr.write(JSON.stringify({status:'BLOCKED',code:error.code && /^[A-Z0-9_]+$/.test(error.code) ? error.code : 'RECONCILIATION_FAILED'})+'\n'); process.exitCode=1; });
module.exports = {loadManifest,prepare,apply,createAdminClient,pointer};
