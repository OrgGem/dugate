'use strict';

const { hash, fail } = require('./ldba-inventory.cjs');

const SAFE_CONNECTOR_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const SECRET_HEADER = /^(?:authorization|proxy-authorization|cookie|set-cookie|host|content-length|transfer-encoding|connection|keep-alive|proxy-connection|upgrade|te|trailer|expect|forwarded|via|origin|referer|idempotency-key|api-key|x-api-key|x-goog-api-key|x-auth-token|x-tenant-id)$/i;
const SAFE_PATH = /^[A-Za-z0-9_$.[\]-]+$/;

function validateCoveredRows(rows, mappings, options) {
  if (!Array.isArray(rows) || !Array.isArray(mappings)) fail(options.listCode);
  const sourceById = new Map();
  for (const row of rows) {
    const id = row && row[options.sourceKey];
    if (typeof id !== 'string' || id.length < 1 || id.length > 512 || sourceById.has(id)) fail(options.sourceCode);
    sourceById.set(id, row);
  }
  const seen = new Set();
  for (const mapping of mappings) {
    const id = mapping && mapping.sourceId;
    if (typeof id !== 'string' || !sourceById.has(id) || seen.has(id)) fail(options.mappingCode);
    const row = sourceById.get(id);
    if (!/^[a-f0-9]{64}$/.test(mapping.sourceRowSha256 || '') || hash(row) !== mapping.sourceRowSha256) fail(options.rowHashCode);
    seen.add(id);
    options.validate(mapping, row);
  }
  if (seen.size !== sourceById.size) fail(options.coverageCode);
  return { sourceById, mappingsBySourceId: new Map(mappings.map(mapping => [mapping.sourceId, mapping])) };
}

function parseSourceJson(value, code) {
  if (value === null || value === undefined || value === '') return null;
  if (typeof value !== 'string') fail(code);
  try { return JSON.parse(value); } catch { fail(code); }
}

function same(left, right) { return hash(left) === hash(right); }

function expectedStaticFields(row) {
  const parsed = parseSourceJson(row.staticFormFields, 'LEGACY_CONNECTOR_STATIC_FIELDS_INVALID');
  if (parsed === null) return [];
  if (!Array.isArray(parsed) || parsed.length > 32) fail('LEGACY_CONNECTOR_STATIC_FIELDS_INVALID');
  return parsed.map(field => {
    if (!field || typeof field !== 'object' || Array.isArray(field)
        || typeof field.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(field.name)
        || !['string','number','boolean'].includes(typeof field.value)
        || (typeof field.value === 'number' && !Number.isFinite(field.value))) fail('LEGACY_CONNECTOR_STATIC_FIELDS_INVALID');
    return { name: field.name, source: 'static', value: field.value };
  });
}

function expectedHeaders(row) {
  const parsed = parseSourceJson(row.extraHeaders, 'LEGACY_CONNECTOR_HEADERS_INVALID');
  if (parsed === null) return [];
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('LEGACY_CONNECTOR_HEADERS_INVALID');
  return Object.entries(parsed)
    .sort(([left], [right]) => left.toLowerCase().localeCompare(right.toLowerCase()))
    .map(([name, value]) => {
      if (!HEADER_NAME.test(name) || SECRET_HEADER.test(name) || /^x-forwarded-/i.test(name)
          || /^x-auth-/i.test(name) || /^x-provider-/i.test(name) || typeof value !== 'string') fail('LEGACY_CONNECTOR_HEADERS_UNSUPPORTED');
      return { name, value };
    });
}

function validateConnectorMappings(sourceRows, mappings, allowedOrigins) {
  const validated = validateCoveredRows(sourceRows, mappings, {
    sourceKey: 'id', listCode: 'CONNECTOR_MAPPING_LIST_REQUIRED', sourceCode: 'LEGACY_CONNECTOR_ID_INVALID',
    mappingCode: 'LEGACY_CONNECTOR_MAPPING_INVALID', rowHashCode: 'LEGACY_CONNECTOR_SOURCE_CHANGED',
    coverageCode: 'LEGACY_CONNECTOR_MAPPING_INCOMPLETE',
    validate(mapping, row) {
      const probe = mapping.probe;
      const recipe = mapping.recipe;
      if (!SAFE_CONNECTOR_ID.test(mapping.connectorId || '')
        || !Number.isSafeInteger(mapping.expectedHeadRevision) || mapping.expectedHeadRevision < 0
        || !['ACTIVE','RETIRED'].includes(mapping.targetState)
        || !recipe || typeof recipe !== 'object' || Array.isArray(recipe)
        || !probe || !UUID.test(probe.apiKeyId || '') || !UUID.test(probe.profileId || '')
        || !Number.isSafeInteger(probe.expectedProfileRevision) || probe.expectedProfileRevision < 1
        || typeof probe.businessId !== 'string' || !probe.businessId
        || typeof probe.businessVersion !== 'string' || !probe.businessVersion
        || typeof probe.action !== 'string' || !probe.action
        || typeof probe.endpointSlug !== 'string' || !probe.endpointSlug
        || typeof probe.bindingSlot !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(probe.bindingSlot)) fail('LEGACY_CONNECTOR_MAPPING_INVALID');
      const expectedState = row.state === 'ENABLED' ? 'ACTIVE' : row.state === 'DISABLED' ? 'RETIRED' : null;
      if (mapping.targetState !== expectedState) fail('LEGACY_CONNECTOR_STATE_MAPPING_MISMATCH');
      if (!['API_KEY_HEADER','NONE'].includes(row.authType)) fail('LEGACY_CONNECTOR_AUTH_TYPE_UNSUPPORTED');
      const hasSecret = typeof row.authSecret === 'string' && row.authSecret.length > 0;
      if ((row.authType === 'API_KEY_HEADER') !== hasSecret) fail('LEGACY_CONNECTOR_CREDENTIAL_SOURCE_INVALID');

      let endpoint;
      try { endpoint = new URL(recipe.endpointUrl); } catch { fail('LEGACY_CONNECTOR_RECIPE_INVALID'); }
      if (!['http:','https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
        || !Array.isArray(allowedOrigins) || !allowedOrigins.includes(endpoint.origin)
        || !['127.0.0.1','localhost','[::1]'].includes(endpoint.hostname)) fail('LEGACY_CONNECTOR_ENDPOINT_OUTSIDE_SYNTHETIC_ALLOWLIST');
      if (recipe.method !== row.httpMethod || recipe.endpointUrl !== row.endpointUrl || !['POST','PUT'].includes(row.httpMethod)) fail('LEGACY_CONNECTOR_RECIPE_SOURCE_MISMATCH');
      if (row.authType === 'API_KEY_HEADER') {
        if (recipe.auth?.kind !== 'api-key-header' || recipe.auth.headerName !== row.authKeyHeader
            || typeof recipe.auth.secretSlot !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(recipe.auth.secretSlot)) fail('LEGACY_CONNECTOR_AUTH_MAPPING_REQUIRED');
      } else if (recipe.auth?.kind !== 'none') fail('LEGACY_CONNECTOR_AUTH_MAPPING_REQUIRED');
      if (!['json-http','multipart-http'].includes(recipe.adapter)
        || (recipe.adapter === 'multipart-http') !== Boolean(row.fileFieldName)
        || recipe.request?.promptField !== row.promptFieldName
        || recipe.request?.fileField !== (row.fileFieldName || undefined)
        || recipe.response?.contentPath !== row.responseContentPath
        || recipe.timeoutMs !== Number(row.timeoutSec) * 1000
        || !Array.isArray(recipe.session?.capture) || recipe.session.capture.length !== 0
        || !Array.isArray(recipe.session?.inject) || recipe.session.inject.length !== 0) fail('LEGACY_CONNECTOR_RECIPE_SOURCE_MISMATCH');
      if (!Array.isArray(recipe.request?.fields) || recipe.request.fields.some(field => field.source !== 'static')
        || !same(recipe.request.fields, expectedStaticFields(row))) fail('LEGACY_CONNECTOR_STATIC_FIELDS_MISMATCH');
      if (!Array.isArray(recipe.headers) || !same(recipe.headers, expectedHeaders(row))) fail('LEGACY_CONNECTOR_HEADERS_MISMATCH');

      // These legacy behaviors stay available to already-imported operation
      // pins on the legacy chain. They cannot be silently claimed as typed
      // recipe features; the mapping manifest records that compatibility path.
      const hasSession = [row.sessionIdFieldName,row.sessionIdResponsePath].some(value => typeof value === 'string' && value.trim());
      if (hasSession && mapping.legacySessionCompatibility !== 'preserved_on_legacy_chain') fail('LEGACY_CONNECTOR_SESSION_COMPATIBILITY_REQUIRED');
      const hasFileUrl = typeof row.fileUrlFieldName === 'string' && row.fileUrlFieldName.trim().length > 0;
      if (hasFileUrl && mapping.legacyFileUrlCompatibility !== 'preserved_on_legacy_chain') fail('LEGACY_CONNECTOR_FILE_URL_COMPATIBILITY_REQUIRED');
      if (typeof mapping.legacyDefaultPromptCompatibility !== 'string'
        || !['preserved_on_legacy_chain','superseded_by_global_prompts'].includes(mapping.legacyDefaultPromptCompatibility)) fail('LEGACY_CONNECTOR_DEFAULT_PROMPT_COMPATIBILITY_REQUIRED');
      if (recipe.request.promptField.length > 128 || !SAFE_PATH.test(recipe.response.contentPath)) fail('LEGACY_CONNECTOR_RECIPE_PATH_INVALID');
    },
  });
  const connectorIds = new Set();
  for (const mapping of mappings) {
    if (connectorIds.has(mapping.connectorId)) fail('LEGACY_CONNECTOR_TARGET_ID_DUPLICATE');
    connectorIds.add(mapping.connectorId);
  }
  return { ...validated, connectorIds };
}

function normalizeLegacyConnectionSteps(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch { fail('PROFILE_SOURCE_STEPS_INVALID'); }
  }
  const normalize = input => {
    if (!Array.isArray(input)) return null;
    const result = [];
    for (const entry of input) {
      if (typeof entry === 'string' && entry.trim()) result.push({ slug: entry.trim() });
      else if (entry && typeof entry === 'object' && !Array.isArray(entry) && typeof entry.slug === 'string' && entry.slug.trim()) {
        const step = { slug: entry.slug.trim() };
        for (const key of ['stepId','captureSession','injectSession']) {
          if (typeof entry[key] === 'string' && entry[key].trim()) step[key] = entry[key].trim();
          else if (entry[key] === null) step[key] = null;
        }
        result.push(step);
      }
    }
    return result;
  };
  const direct = normalize(parsed);
  if (direct) return direct;
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const item of Object.values(parsed)) {
      const nested = normalize(item);
      if (nested) return nested;
    }
  }
  return [];
}

function validateProfileMappings(sourceRows, mappings, connectorMappings) {
  const validated = validateCoveredRows(sourceRows, mappings, {
    sourceKey: 'id', listCode: 'PROFILE_MAPPING_LIST_REQUIRED', sourceCode: 'LEGACY_PROFILE_ID_INVALID',
    mappingCode: 'LEGACY_PROFILE_MAPPING_INVALID', rowHashCode: 'LEGACY_PROFILE_SOURCE_CHANGED',
    coverageCode: 'LEGACY_PROFILE_MAPPING_INCOMPLETE',
    validate(mapping, row) {
      if (!UUID.test(mapping.apiKeyId || '') || !UUID.test(row.apiKeyId || '')
        || mapping.apiKeyId !== row.apiKeyId || mapping.endpointSlug !== row.endpointSlug
        || mapping.expectedProfileRevision !== 1
        || typeof mapping.businessId !== 'string' || !mapping.businessId
        || typeof mapping.businessVersion !== 'string' || !mapping.businessVersion
        || typeof mapping.action !== 'string' || !mapping.action
        || !(mapping.expectedActiveRevision === null || Number.isSafeInteger(mapping.expectedActiveRevision) && mapping.expectedActiveRevision >= 0)
        || !mapping.connectorBindings || typeof mapping.connectorBindings !== 'object' || Array.isArray(mapping.connectorBindings)) fail('LEGACY_PROFILE_MAPPING_INVALID');
      for (const [slot, binding] of Object.entries(mapping.connectorBindings)) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(slot)) fail('PROFILE_CONNECTOR_SLOT_INVALID');
        if (binding === '$tenant-ai') continue;
        if (!binding || typeof binding !== 'object' || Array.isArray(binding)
          || typeof binding.sourceConnectorId !== 'string'
          || !connectorMappings.mappingsBySourceId.has(binding.sourceConnectorId)) fail('PROFILE_CONNECTOR_BINDING_UNRESOLVED');
      }
      if (!Array.isArray(mapping.sourceConnectionSteps)) fail('PROFILE_SOURCE_STEPS_REQUIRED');
      const normalized = normalizeLegacyConnectionSteps(row.connectionsOverride);
      if (!same(mapping.sourceConnectionSteps, normalized)) fail('PROFILE_SOURCE_STEPS_CHANGED');
      const stepIds = normalized.map(step => step.stepId || step.slug);
      if (new Set(stepIds).size !== stepIds.length) fail('PROFILE_SOURCE_STEPS_AMBIGUOUS');
      for (const step of normalized) {
        const slot = step.stepId || step.slug;
        const connector = mapping.connectorBindings[slot];
        if (!connector || connector === '$tenant-ai') fail('PROFILE_CONNECTOR_STEP_MAPPING_MISMATCH');
        const sourceConnector = connectorMappings.sourceById.get(connector.sourceConnectorId);
        if (!sourceConnector || sourceConnector.slug !== step.slug) fail('PROFILE_CONNECTOR_STEP_MAPPING_MISMATCH');
      }
      if (row.enabled === true && normalized.length === 0 && Object.keys(mapping.connectorBindings).length === 0) fail('ACTIVE_LEGACY_PROFILE_HAS_NO_CONNECTOR_MAPPING');
      if (row.enabled === true && Object.values(mapping.connectorBindings).some(binding => binding !== '$tenant-ai'
          && connectorMappings.mappingsBySourceId.get(binding.sourceConnectorId)?.targetState !== 'ACTIVE')) fail('ACTIVE_PROFILE_REFERENCES_DISABLED_CONNECTOR');
    },
  });
  const scopes = new Set();
  for (const mapping of mappings) {
    const scope = mapping.apiKeyId + '|' + mapping.endpointSlug;
    if (scopes.has(scope)) fail('LEGACY_PROFILE_TARGET_SCOPE_DUPLICATE');
    scopes.add(scope);
  }
  return validated;
}

function resolveProfileConnectorBindings(mapping, connectorResults, tenantAi) {
  const bindings = {};
  for (const [slot, source] of Object.entries(mapping.connectorBindings)) {
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(slot)) fail('PROFILE_CONNECTOR_SLOT_INVALID');
    if (source === '$tenant-ai') {
      bindings[slot] = { connectorId: tenantAi.connectorId, revision: tenantAi.revision };
      continue;
    }
    const result = connectorResults.get(source.sourceConnectorId);
    if (!result || result.state !== 'ACTIVE') fail('PROFILE_CONNECTOR_BINDING_NOT_ACTIVE');
    bindings[slot] = { connectorId: result.connectorId, revision: result.revision };
  }
  return bindings;
}

module.exports = { normalizeLegacyConnectionSteps, resolveProfileConnectorBindings, validateConnectorMappings, validateProfileMappings };
