'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash, createDecipheriv } = require('node:crypto');
const { hash, fail } = require('./ldba-inventory.cjs');

const CANONICAL_SETTINGS = Object.freeze([
  'ai_provider', 'ai_model', 'ai_api_key',
  'ai_image_prompt', 'ai_pdf_prompt', 'ai_docx_prompt', 'ai_compare_prompt', 'ai_generate_prompt',
  'openai_api_key', 'openai_base_url', 'api_secret_key',
  's3_endpoint', 's3_bucket', 's3_access_key', 's3_secret_key', 's3_region', 's3_cache_ttl_hours',
]);
const RETIRED_SETTINGS = Object.freeze({
  api_secret_key: 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER',
  docx_conversion_mode: 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER',
  docx_intermediate_format: 'RETIRED_NO_CURRENT_RUNTIME_CONSUMER',
});
const ALL_SETTING_KEYS = Object.freeze([...CANONICAL_SETTINGS, 'docx_conversion_mode', 'docx_intermediate_format']);
const SECRET_SETTINGS = new Set(['ai_api_key', 'openai_api_key', 's3_access_key', 's3_secret_key']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHA = /^[a-f0-9]{64}$/;

function sourceHash(bytes) { return createHash('sha256').update(bytes).digest('hex'); }

function typescript() {
  try { return require(path.resolve(__dirname, '../../../node_modules/.pnpm/typescript@5.9.3/node_modules/typescript')); }
  catch { fail('LEGACY_SETTINGS_SOURCE_PARSER_UNAVAILABLE'); }
}

function unwrap(ts, node) {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isTypeAssertionExpression(node)) node = node.expression;
  return node;
}

function evaluateStatic(ts, node, scope) {
  node = unwrap(ts, node);
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isObjectLiteralExpression(node)) {
    const out = Object.create(null);
    for (const property of node.properties) {
      if (!ts.isPropertyAssignment(property)) fail('UNSUPPORTED_LEGACY_DEFAULT_EXPRESSION');
      const name = property.name;
      if (!ts.isIdentifier(name) && !ts.isStringLiteral(name)) fail('UNSUPPORTED_LEGACY_DEFAULT_EXPRESSION');
      const key = name.text;
      if (Object.hasOwn(out, key)) fail('DUPLICATE_LEGACY_DEFAULT_KEY');
      out[key] = evaluateStatic(ts, property.initializer, scope);
    }
    return out;
  }
  if (ts.isPropertyAccessExpression(node)) {
    const parent = evaluateStatic(ts, node.expression, scope);
    if (!parent || typeof parent !== 'object' || !Object.hasOwn(parent, node.name.text)) fail('UNRESOLVED_LEGACY_DEFAULT_REFERENCE');
    return parent[node.name.text];
  }
  if (ts.isIdentifier(node)) {
    if (!Object.hasOwn(scope, node.text)) fail('UNRESOLVED_LEGACY_DEFAULT_REFERENCE');
    return scope[node.text];
  }
  fail('UNSUPPORTED_LEGACY_DEFAULT_EXPRESSION');
}

/** Evaluate only the three literal constants used by the legacy settings map. */
function extractLegacyDefaults(sourceText) {
  const ts = typescript();
  const source = ts.createSourceFile('lib/settings.ts', sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const declarations = new Map();
  for (const statement of source.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && ['PROMPT_PRESETS', 'COMPARE_PROMPT_DEFAULT', 'SETTING_DEFAULTS'].includes(declaration.name.text)) {
        if (!declaration.initializer || declarations.has(declaration.name.text)) fail('INVALID_LEGACY_SETTINGS_SOURCE');
        declarations.set(declaration.name.text, declaration.initializer);
      }
    }
  }
  for (const name of ['PROMPT_PRESETS', 'COMPARE_PROMPT_DEFAULT', 'SETTING_DEFAULTS']) {
    if (!declarations.has(name)) fail('LEGACY_SETTINGS_DEFAULTS_MISSING');
  }
  const scope = Object.create(null);
  scope.PROMPT_PRESETS = evaluateStatic(ts, declarations.get('PROMPT_PRESETS'), scope);
  scope.COMPARE_PROMPT_DEFAULT = evaluateStatic(ts, declarations.get('COMPARE_PROMPT_DEFAULT'), scope);
  scope.SETTING_DEFAULTS = evaluateStatic(ts, declarations.get('SETTING_DEFAULTS'), scope);
  const defaults = scope.SETTING_DEFAULTS;
  const keys = Object.keys(defaults).sort();
  if (keys.length !== ALL_SETTING_KEYS.length || keys.some((key, index) => key !== [...ALL_SETTING_KEYS].sort()[index])) {
    fail('LEGACY_SETTINGS_DEFAULT_KEYSET_CHANGED');
  }
  if (Object.values(defaults).some(value => typeof value !== 'string')) fail('LEGACY_SETTINGS_DEFAULT_TYPE_INVALID');
  return defaults;
}

function loadLegacyDefaults(sourcePath, expectedSourceSha256, expectedDefaultsSha256) {
  if (!sourcePath || !SHA.test(expectedSourceSha256 || '') || !SHA.test(expectedDefaultsSha256 || '')) fail('LEGACY_SETTINGS_SOURCE_PIN_REQUIRED');
  const bytes = fs.readFileSync(sourcePath);
  const actualSourceSha256 = sourceHash(bytes);
  if (actualSourceSha256 !== expectedSourceSha256) fail('LEGACY_SETTINGS_SOURCE_HASH_MISMATCH');
  const defaults = extractLegacyDefaults(bytes.toString('utf8'));
  const defaultsSha256 = hash(defaults);
  if (defaultsSha256 !== expectedDefaultsSha256) fail('LEGACY_SETTINGS_DEFAULTS_HASH_MISMATCH');
  return { defaults, actualSourceSha256, defaultsSha256 };
}

function decryptLegacySetting(value, sourceSecret) {
  if (typeof value !== 'string') fail('LEGACY_SECRET_CIPHERTEXT_INVALID');
  if (value === '') return '';
  if (typeof sourceSecret !== 'string' || sourceSecret.length < 1) fail('LEGACY_SETTINGS_ENCRYPTION_KEY_REQUIRED');
  const parts = value.split(':');
  if (parts.length !== 3 || !parts.every(part => /^[a-f0-9]+$/i.test(part))) fail('LEGACY_SECRET_CIPHERTEXT_INVALID');
  const iv = Buffer.from(parts[0], 'hex');
  const tag = Buffer.from(parts[1], 'hex');
  const ciphertext = Buffer.from(parts[2], 'hex');
  if (iv.length !== 12 || tag.length !== 16) fail('LEGACY_SECRET_CIPHERTEXT_INVALID');
  const key = createHash('sha256').update(sourceSecret).digest();
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    if (plaintext.includes('\0')) fail('LEGACY_SECRET_PLAINTEXT_INVALID');
    return plaintext;
  } catch (error) {
    if (error && error.code) throw error;
    fail('LEGACY_SECRET_DECRYPTION_FAILED');
  } finally {
    key.fill(0);
    iv.fill(0);
    tag.fill(0);
    ciphertext.fill(0);
  }
}

function mapArchivedSettings(rows, defaults, sourceSecret) {
  if (!Array.isArray(rows) || !defaults || typeof defaults !== 'object') fail('INVALID_ARCHIVED_SETTINGS');
  const values = new Map(Object.entries(defaults));
  const seen = new Set();
  for (const row of rows) {
    if (!row || typeof row.key !== 'string' || !ALL_SETTING_KEYS.includes(row.key) || seen.has(row.key) || typeof row.value !== 'string') {
      fail('UNCLASSIFIED_ARCHIVED_SETTING');
    }
    seen.add(row.key);
    // The retired api_secret_key is never decrypted or copied to an active credential store.
    if (row.key === 'api_secret_key' || RETIRED_SETTINGS[row.key]) continue;
    values.set(row.key, SECRET_SETTINGS.has(row.key) ? decryptLegacySetting(row.value, sourceSecret) : row.value);
  }
  const effective = Object.fromEntries(values);
  for (const key of ALL_SETTING_KEYS) {
    if (typeof effective[key] !== 'string') fail('LEGACY_SETTINGS_DEFAULT_KEYSET_CHANGED');
  }
  return { effective, archivedKeys: [...seen].sort(), defaultKeys: Object.keys(defaults).sort() };
}

function dispositionRows(rows) {
  const byKey = new Map(rows.map(row => [row.key, row]));
  const activeDisposition = key => {
    if (['ai_provider', 'ai_model'].includes(key)) return 'MAPPED_TENANT_AI_DEFAULT';
    if (['ai_api_key', 'openai_api_key', 'openai_base_url'].includes(key)) return 'MAPPED_APPROVED_CONNECTOR_REVISION';
    if (key.startsWith('ai_') && key.endsWith('_prompt')) return 'MAPPED_TENANT_PROMPT_DEFAULT';
    if (['s3_endpoint', 's3_bucket', 's3_access_key', 's3_secret_key', 's3_region'].includes(key)) return 'MAPPED_STORAGE_GENERATION';
    if (key === 's3_cache_ttl_hours') return 'MAPPED_RETENTION_REVISION';
    fail('UNCLASSIFIED_ARCHIVED_SETTING');
  };
  return ALL_SETTING_KEYS.map(key => ({
    key,
    disposition: RETIRED_SETTINGS[key] ?? activeDisposition(key),
    sourceValueSha256: byKey.has(key) ? hash(byKey.get(key).value) : null,
    sourceValuePresent: byKey.has(key),
  }));
}

function assertSyntheticScope(manifest, namespace) {
  if (manifest.executionScope !== 'synthetic' || typeof manifest.namespace !== 'string'
      || !/^orv14-continuity-[a-z0-9][a-z0-9-]{0,48}$/.test(manifest.namespace)
      || namespace !== manifest.namespace) fail('SYNTHETIC_NAMESPACE_REQUIRED');
}

function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object' || Array.isArray(manifest)
      || manifest.version !== 'ldba-continuity-plan-v1' || !UUID.test(manifest.tenantId || '')
      || typeof manifest.sourceVersion !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(manifest.sourceVersion)
      || !SHA.test(manifest.sourceSha256 || '') || !SHA.test(manifest.archivedSettingsSha256 || '')
      || !SHA.test(manifest.baselineInventorySha256 || '') || !SHA.test(manifest.legacySettingsSourceSha256 || '')
      || !SHA.test(manifest.legacySettingsDefaultsSha256 || '') || typeof manifest.reviewedBy !== 'string' || !manifest.reviewedBy.trim()) {
    fail('INVALID_CONTINUITY_MANIFEST');
  }
  return manifest;
}

module.exports = {
  ALL_SETTING_KEYS,
  CANONICAL_SETTINGS,
  RETIRED_SETTINGS,
  SECRET_SETTINGS,
  assertSyntheticScope,
  decryptLegacySetting,
  dispositionRows,
  extractLegacyDefaults,
  loadLegacyDefaults,
  mapArchivedSettings,
  sourceHash,
  validateManifest,
};
