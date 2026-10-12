import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const ORCH = path.join(ROOT, 'orchestrator/services/orchestrator');
const NODE = '/workspace/scratch/orv11-toolchain/node-v24.21.0-linux-x64/bin/node';
const RAW_DIR = path.join(ROOT, 'coordination/reports/raw/orv14-host-verification');
const stateFile = path.resolve(process.argv[2] || '');
if (!process.argv[2] || !path.isAbsolute(stateFile)) throw new Error('pass the absolute mode-0600 native19-state.json from a successful A2 fixture');
if (process.execPath !== NODE || process.getuid?.() !== 1000) throw new Error('run with pinned Node 24.21.0 as UID 1000');

const require = createRequire(path.join(ORCH, 'package.json'));
const { Pool } = require('pg');
const inventoryModule = require(path.join(ORCH, 'scripts/ldba-inventory.cjs'));
const { inventory, hash } = inventoryModule;
const { ALL_SETTING_KEYS, RETIRED_SETTINGS, dispositionRows, extractLegacyDefaults } = require(path.join(ORCH, 'scripts/ldba-continuity-plan.cjs'));
const { normalizeLegacyConnectionSteps } = require(path.join(ORCH, 'scripts/ldba-continuity-mappings.cjs'));
const { TABLES, sourceSettingsSha256 } = require(path.join(ORCH, 'scripts/ldba-continuity-source.cjs'));
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const safeWrite = async (filename, value) => {
  await writeFile(filename, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  await chmod(filename, 0o600);
};
const sourceFiles = [
  'services/orchestrator/scripts/ldba-03-backfill.cjs',
  'services/orchestrator/scripts/ldba-03-production-adapter.cjs',
  'services/orchestrator/scripts/ldba-context-provider.cjs',
  'services/orchestrator/scripts/ldba-inventory.cjs',
  'services/orchestrator/scripts/ldba-continuity-plan.cjs',
  'services/orchestrator/scripts/ldba-continuity-mappings.cjs',
  'services/orchestrator/scripts/ldba-continuity-source.cjs',
  'services/orchestrator/scripts/ldba-continuity-runner.cjs',
  'services/orchestrator/scripts/ldba-continuity-runtime.cjs',
  'services/orchestrator/src/modules/connectors/connector-secret-imports.ts',
  'services/orchestrator/src/modules/connectors/connector-management-store.ts',
  'services/orchestrator/src/http/routes/internal-parity.ts',
  'services/orchestrator/src/modules/global-settings/service.ts',
  'services/orchestrator/src/app/bootstrap/create-app.ts',
  'services/connector/src/db/migrations/014_connector_recipe_retirement.sql',
  'services/connector/src/db/migrations/015_backup_effect_fences.sql',
  'packages/contracts/src/connector.ts',
  'packages/contracts/src/parity.ts',
];

let state;
let targetPool;
let connectorPool;
const raw = {
  schema: 'orv14-native19-manifest/v1',
  command: `${NODE} tests/workflow-api/orv14-vfy-host/make-native19-manifest.mjs ${stateFile}`,
  cwd: ROOT,
  node: 'v24.21.0',
  verifierUid: process.getuid?.() ?? null,
  startedAt: new Date().toISOString(),
  stateFileModeVerified: false,
  fixtureNamespace: null,
  sourceHashesBefore: {},
  sourceHashesAfter: {},
  sourceRows: null,
  settingsDispositions: null,
  targetInventorySha256: null,
  continuityEvidenceKinds: null,
  manifestSha256: null,
  mappingCounts: null,
  outputFile: null,
  credentialsOrPlaintextRecorded: false,
  status: 'RUNNING',
};

async function pinnedSourceHashes() {
  const out = {};
  for (const relative of sourceFiles) out[relative] = sha(await readFile(path.join(ROOT, 'orchestrator', relative)));
  out['lib/settings.ts'] = sha(await readFile(path.resolve(ROOT, '../lib/settings.ts')));
  return out;
}

function recipeFor(row) {
  let staticSource = row.staticFormFields;
  if (typeof staticSource === 'string') staticSource = staticSource ? JSON.parse(staticSource) : [];
  let headersSource = row.extraHeaders;
  if (typeof headersSource === 'string') headersSource = headersSource ? JSON.parse(headersSource) : {};
  const fields = (staticSource ?? []).map(field => ({ name: field.name, source: 'static', value: field.value }));
  const headers = Object.entries(headersSource ?? {}).map(([name, value]) => ({ name, value }));
  return {
    adapter: row.fileFieldName ? 'multipart-http' : 'json-http',
    method: row.httpMethod,
    endpointUrl: row.endpointUrl,
    auth: row.authType === 'API_KEY_HEADER'
      ? { kind: 'api-key-header', headerName: row.authKeyHeader, secretSlot: 'credential' }
      : { kind: 'none' },
    headers,
    request: {
      promptField: row.promptFieldName,
      ...(row.fileFieldName ? { fileField: row.fileFieldName } : {}),
      fields,
    },
    response: { contentPath: row.responseContentPath },
    session: { capture: [], inject: [] },
    timeoutMs: Number(row.timeoutSec) * 1000,
    responseBytes: 65_536,
  };
}

async function main() {
  const fileInfo = await lstat(stateFile);
  assert.ok(fileInfo.isFile() && !fileInfo.isSymbolicLink(), 'continuation state must be a regular file, not a symlink');
  assert.equal(fileInfo.mode & 0o077, 0, 'continuation state must be inaccessible to group and other');
  raw.stateFileModeVerified = true;
  state = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.ok(state.fixture?.root?.startsWith('/tmp/orv14-vfy-host-'), 'only the owned synthetic Host fixture can be used');
  assert.ok(state.run?.sourceVersion && state.run?.sourceRowsSha256);
  assert.equal(state.run.settingsKeys?.length, 19, 'all 16 functional and 3 retired settings must be represented');
  assert.equal(state.run.syntheticIds?.apiKeyToken?.startsWith('orv14-vfy-'), true, 'the public API key must be synthetic');
  raw.fixtureNamespace = state.fixture.projectId;
  raw.sourceHashesBefore = await pinnedSourceHashes();

  const evidence = {
    sourceVersion: state.run.sourceVersion,
    sourceSha256: state.run.sourceRowsSha256,
    sourceRowCounts: state.run.sourceRowCounts,
    timezoneEvidenceSha256: state.run.timezoneEvidenceSha256,
  };
  const adapterEnv = {
    LDBA03_SOURCE_VERSION: state.run.sourceVersion,
    LDBA_A1_SOURCE_VERSION: state.run.sourceVersion,
    LDBA03_TIMEZONE_EVIDENCE_FILE: state.run.timezoneEvidenceFile,
    LDBA03_TIMEZONE_EVIDENCE_SHA256: state.run.timezoneEvidenceSha256,
    LDBA03_CONNECTOR_TARGET_DATABASE_URL: state.run.connectorTargetUrl,
    LDBA03_FILECACHE_OBJECT_DIR: state.run.sourceObjectRoot,
    CONNECTOR_ENCRYPTION_KEY: state.run.connectorEncryptionKey,
    LDBA_A1_PASSED: '1',
  };
  const priorMode = process.env.LDBA03_ADAPTER_LIBRARY;
  process.env.LDBA03_ADAPTER_LIBRARY = '1';
  let adapter;
  try {
    adapter = require(path.join(ORCH, 'scripts/ldba-03-production-adapter.cjs')).createAdapter({
      env: adapterEnv, Pool, sourceConnectionString: state.run.sourceUrl, targetConnectionString: state.run.targetUrl,
    });
  } finally {
    if (priorMode === undefined) delete process.env.LDBA03_ADAPTER_LIBRARY;
    else process.env.LDBA03_ADAPTER_LIBRARY = priorMode;
  }
  let source;
  try {
    const tables = Object.create(null);
    for (const table of TABLES) tables[table] = await adapter.source.scan(table);
    assert.equal(adapter.sourceSnapshot?.sha256, state.run.sourceRowsSha256);
    assert.deepEqual(adapter.sourceSnapshot?.rowCounts, state.run.sourceRowCounts);
    assert.equal(adapter.timezoneEvidence?.verified, true);
    assert.equal(adapter.timezoneEvidence?.sha256, state.run.timezoneEvidenceSha256);
    source = {
      tables,
      sourceSha256: adapter.sourceSnapshot.sha256,
      sourceRowCounts: { ...adapter.sourceSnapshot.rowCounts },
      timezoneEvidenceSha256: adapter.timezoneEvidence.sha256,
    };
  } finally { await adapter.close(); }
  const archivedSettingsSha256 = sourceSettingsSha256(source.tables.AppSetting);

  targetPool = new Pool({ connectionString: state.run.targetUrl, application_name: 'orv14-vfy-native19-manifest-orch', max: 3 });
  connectorPool = new Pool({ connectionString: state.run.connectorTargetUrl, application_name: 'orv14-vfy-native19-manifest-connector', max: 3 });
  const sourceSnapshot = source.tables;
  const tenantId = state.run.tenantId;
  const target = await inventory(targetPool, tenantId, state.run.sourceVersion, { connectorPool });
  assert.equal(target.sourceSha256, state.run.sourceRowsSha256);
  assert.equal(target.archivedSettingsSha256, archivedSettingsSha256);
  assert.equal(target.sourceSettingsSha256, archivedSettingsSha256);
  assert.equal(target.targetCounts.settings, 19);
  assert.equal(target.targetCounts.operations, 1);
  assert.equal(target.targetCounts.artifacts, 2);
  assert.equal(target.capabilities.connectorPlane.available, true);
  assert.equal(target.capabilities.connectorPlane.undeliveredUsage, 0);
  const priorEvidence = await targetPool.query(`SELECT evidence_kind FROM legacy_continuity_evidence
    WHERE tenant_id=$1 AND source_version=$2 ORDER BY evidence_kind`, [tenantId, state.run.sourceVersion]);
  raw.continuityEvidenceKinds = priorEvidence.rows.map(row => row.evidence_kind);
  assert.equal(raw.continuityEvidenceKinds.includes('reconciliation'), false,
    'this synthetic target begins without fabricated reconciliation evidence');

  const defaultsPath = path.resolve(ROOT, '../lib/settings.ts');
  const defaultsBytes = await readFile(defaultsPath);
  const defaults = extractLegacyDefaults(defaultsBytes.toString('utf8'));
  const sourceRows = sourceSnapshot;
  assert.equal(sourceRows.AppSetting.length, 19, 'all 17 canonical and 2 documented extension settings must be in the frozen source');
  const dispositions = dispositionRows(sourceRows.AppSetting);
  assert.equal(dispositions.length, 19, 'every canonical and extension setting needs one disposition');
  assert.deepEqual(dispositions.map(row => row.key).sort(), [...ALL_SETTING_KEYS].sort(),
    'each of the 17 canonical plus 2 extension setting keys must appear exactly once');
  assert.ok(dispositions.every(row => row.sourceValuePresent === true && /^[a-f0-9]{64}$/.test(row.sourceValueSha256 || '')),
    'each archived setting must be represented by presence and a digest only');
  assert.equal(dispositions.filter(row => row.disposition === 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER').length, 3,
    'the base api_secret_key and two extension settings must be explicitly retired');
  assert.deepEqual(dispositions.filter(row => Object.hasOwn(RETIRED_SETTINGS, row.key)).map(row => row.key).sort(),
    Object.keys(RETIRED_SETTINGS).sort());
  const apiKey = sourceRows.ApiKey.find(row => row.id === state.run.syntheticIds.apiKeyId);
  const profileRow = sourceRows.ProfileEndpoint.find(row => row.id === state.run.syntheticIds.profileId);
  assert.ok(apiKey && profileRow);
  const currentProfile = await targetPool.query(`SELECT p.business_id,p.business_version,p.action,p.revision,a.revision AS active_profile_revision
      FROM profile_bindings p JOIN profile_active_revisions a ON a.profile_id=p.profile_id AND a.revision=p.revision
     WHERE p.tenant_id=$1 AND p.profile_id=$2 ORDER BY p.revision DESC LIMIT 1`, [tenantId, profileRow.id]);
  assert.equal(currentProfile.rows.length, 1);
  const profileTarget = currentProfile.rows[0];
  assert.equal(Number(profileTarget.revision), 1);
  const settingsHead = await targetPool.query('SELECT active_revision FROM settings_streams WHERE tenant_id=$1 AND api_key_id=$2 AND endpoint_slug=$3',
    [tenantId, profileRow.apiKeyId, profileRow.endpointSlug]);
  const expectedActiveRevision = settingsHead.rows[0]?.active_revision ?? null;
  const probe = {
    apiKeyId: apiKey.id,
    profileId: profileRow.id,
    expectedProfileRevision: Number(profileTarget.revision),
    businessId: profileTarget.business_id,
    businessVersion: profileTarget.business_version,
    action: profileTarget.action,
    endpointSlug: profileRow.endpointSlug,
    bindingSlot: 'primary',
  };
  const connectorMappings = sourceRows.ExternalApiConnection.map(row => ({
    sourceId: row.id,
    sourceRowSha256: hash(row),
    connectorId: `legacy-${row.id}`,
    expectedHeadRevision: 0,
    targetState: row.state === 'ENABLED' ? 'ACTIVE' : 'RETIRED',
    recipe: recipeFor(row),
    probe,
    legacyDefaultPromptCompatibility: 'preserved_on_legacy_chain',
  }));
  const normalizedSteps = normalizeLegacyConnectionSteps(profileRow.connectionsOverride);
  const connectorBindings = {};
  for (const step of normalizedSteps) {
    const sourceConnector = sourceRows.ExternalApiConnection.find(row => row.slug === step.slug);
    assert.ok(sourceConnector, `fixture Profile step ${step.slug} must resolve to a source connector`);
    connectorBindings[step.stepId || step.slug] = { sourceConnectorId: sourceConnector.id };
  }
  const profileMappings = sourceRows.ProfileEndpoint.map(row => ({
    sourceId: row.id,
    sourceRowSha256: hash(row),
    apiKeyId: row.apiKeyId,
    endpointSlug: row.endpointSlug,
    expectedProfileRevision: 1,
    expectedActiveRevision,
    businessId: profileTarget.business_id,
    businessVersion: profileTarget.business_version,
    action: profileTarget.action,
    sourceConnectionSteps: normalizeLegacyConnectionSteps(row.connectionsOverride),
    connectorBindings,
  }));
  const aiConnectorId = `vfy-ai-${randomBytes(8).toString('hex')}`;
  const aiConnector = {
    connectorId: aiConnectorId,
    expectedHeadRevision: 0,
    bindingSlot: 'primary',
    recipe: {
      adapter: 'openai-compatible',
      method: 'POST',
      endpointUrl: `${state.run.providerOrigin}/v1/chat/completions`,
      auth: { kind: 'bearer', secretSlot: 'credential' },
      headers: [],
      request: { promptField: 'prompt', modelField: 'model', fields: [] },
      response: { contentPath: 'choices.0.message.content' },
      session: { capture: [], inject: [] },
      timeoutMs: 20_000,
      responseBytes: 65_536,
    },
  };
  const manifest = {
    version: 'ldba-continuity-plan-v1',
    tenantId,
    sourceVersion: state.run.sourceVersion,
    sourceSha256: source.sourceSha256,
    sourceRowCounts: source.sourceRowCounts,
    timezoneEvidenceSha256: source.timezoneEvidenceSha256,
    archivedSettingsSha256,
    baselineInventorySha256: target.inventorySha256,
    legacySettingsSourcePath: defaultsPath,
    legacySettingsSourceSha256: sha(defaultsBytes),
    legacySettingsDefaultsSha256: hash(defaults),
    reviewedBy: 'independent ORV14 synthetic Host verification',
    executionScope: 'synthetic',
    namespace: state.run.namespace,
    synthetic: { allowedOrigins: [...new Set([new URL(state.run.providerOrigin).origin, new URL(state.fixture.urls.s3Restore).origin])].sort() },
    probe,
    aiConnector,
    connectorMappings,
    profileMappings,
  };
  const manifestPath = path.join(state.fixture.root, 'native19-manifest.json');
  const manifestBytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  await safeWrite(manifestPath, manifest);
  raw.sourceRows = { sha256: source.sourceSha256, counts: source.sourceRowCounts, settings: sourceRows.AppSetting.length,
    connectorRows: sourceRows.ExternalApiConnection.length, profileRows: sourceRows.ProfileEndpoint.length,
    apiKeys: sourceRows.ApiKey.length, overrides: sourceRows.ExternalApiOverride.length,
    users: sourceRows.User.length, assignments: sourceRows.UserProfileAssignment.length };
  raw.settingsDispositions = dispositions.map(({ key, disposition, sourceValuePresent, sourceValueSha256 }) =>
    ({ key, disposition, sourceValuePresent, sourceValueSha256 }));
  raw.targetInventorySha256 = target.inventorySha256;
  raw.mappingCounts = { connectorRows: connectorMappings.length, active: connectorMappings.filter(row => row.targetState === 'ACTIVE').length,
    retired: connectorMappings.filter(row => row.targetState === 'RETIRED').length, profiles: profileMappings.length,
    canonicalSettings: 17, extensionSettings: 2, functionalSettings: 16, retiredSettings: 3 };
  raw.manifestSha256 = sha(manifestBytes);
  raw.outputFile = manifestPath;
  raw.credentialsOrPlaintextRecorded = false;
  raw.sourceHashesAfter = await pinnedSourceHashes();
  assert.deepEqual(raw.sourceHashesAfter, raw.sourceHashesBefore, 'pinned Native19 source inputs changed while creating the manifest');
  raw.status = 'PASSED_MANIFEST_PREPARATION';
}

try {
  await main();
} catch (error) {
  raw.status = 'FAILED';
  raw.error = String(error?.stack || error).slice(0, 5000);
} finally {
  await Promise.all([targetPool, connectorPool].filter(Boolean).map(pool => pool.end().catch(() => undefined)));
  raw.completedAt = new Date().toISOString();
  await mkdir(RAW_DIR, { recursive: true });
  const attemptId = Date.now().toString(36);
  raw.attemptId = attemptId;
  const receiptPath = path.join(RAW_DIR, `native19-manifest-${state?.fixture?.projectId || 'start-failed'}-${attemptId}.json`);
  await safeWrite(receiptPath, raw);
  process.stdout.write(JSON.stringify({ status: raw.status, fixtureNamespace: raw.fixtureNamespace,
    manifestSha256: raw.manifestSha256, mappingCounts: raw.mappingCounts,
    rawReceipt: path.relative(ROOT, receiptPath), error: raw.error?.split('\n')[0] || null }, null, 2) + '\n');
}
if (raw.status !== 'PASSED_MANIFEST_PREPARATION') process.exitCode = 1;
