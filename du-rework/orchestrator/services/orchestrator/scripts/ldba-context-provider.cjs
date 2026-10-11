'use strict';

const { createCipheriv, createHash, randomBytes } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

class ContextPolicyError extends Error {
  constructor(callback) {
    super('approved LDBA03 context policy is not configured for ' + callback);
    this.name = 'ContextPolicyError';
    this.code = 'CONTEXT_POLICY_REQUIRED';
    this.callback = callback;
  }
}

function requireApprovedPolicy(callback) {
  return function contextPolicyRequired() {
    throw new ContextPolicyError(callback);
  };
}

function requirePasswordReset() {
  const error = new Error(
    'legacy bcrypt cannot become a target scrypt verifier without plaintext at first login',
  );
  error.name = 'ContextPolicyError';
  error.code = 'PASSWORD_RESET_REQUIRED';
  throw error;
}

// MDB-POLICY-01: prepareConnector for ExternalApiConnection.
//
// The LDBA-03 runner (scripts/ldba-03-backfill.cjs) owns every row assertion;
// this policy only supplies the mapping. It follows the projection rules of the
// connector's LDBA-05 module (services/connector/src/db/legacy-connector-adapter.ts)
// so both paths agree on identity, adapter, credential ref and encryption.
//
// Everything else stays fail-closed. Refusals return a skip (never a throw and
// never a partially built row), because the backfill treats a skip as a reported
// omission and keeps going, while an unhandled throw would abort the run.
//
// Secret handling: authSecret is read once, encrypted with AES-256-GCM, and
// never reaches revision.config. The ciphertext layout is iv(12) || tag(16) ||
// ciphertext - byte-compatible with the connector's AesCredentialCipher, which
// is what decrypts these rows later.
const ENCRYPTION_KEY_ENV = 'CONNECTOR_ENCRYPTION_KEY';
const HTTP_HEADER_NAME = /^[!#$%&'*+.^_|~0-9A-Za-z-]+$/;
// Mirrors SECRET_HEADER_NAMES in packages/contracts/src/vault.ts: a header name
// that reads as a credential cannot live in revision config.
const SECRET_HEADER_NAMES = [
  'authorization',
  'proxy-authorization',
  'www-authenticate',
  'x-api-key',
  'x-apikey',
  'api-key',
  'apikey',
  'x-goog-api-key',
  'x-amz-security-token',
  'x-session-token',
  'password',
  'passwd',
  'secret',
  'token',
  'credential',
];

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function skipped(code, reason) {
  return { skipped: true, code, reason };
}

function headerNameIsSecret(name) {
  const lower = name.toLowerCase();
  return SECRET_HEADER_NAMES.some(function isCredentialName(candidate) {
    return lower === candidate
      || lower.startsWith(candidate + '-')
      || lower.endsWith('-' + candidate)
      || lower.startsWith(candidate + '_')
      || lower.endsWith('_' + candidate);
  });
}

function encryptionKey() {
  const raw = process.env[ENCRYPTION_KEY_ENV];
  if (typeof raw !== 'string' || raw.trim().length === 0) return undefined;
  const key = Buffer.from(raw, 'base64');
  return key.byteLength === 32 ? key : undefined;
}

function encryptSecret(secret, key) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

function splitEndpoint(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    return undefined;
  }
  const usable = (endpoint.protocol === 'http:' || endpoint.protocol === 'https:')
    && endpoint.username.length === 0
    && endpoint.password.length === 0
    && endpoint.hash.length === 0;
  return usable ? endpoint : undefined;
}

function addMapping(mapping, fieldName, sourcePath) {
  if (typeof fieldName !== 'string' || fieldName.trim().length === 0) return false;
  const existing = mapping[fieldName];
  if (existing !== undefined && existing !== sourcePath) return false;
  mapping[fieldName] = sourcePath;
  return true;
}

function nonEmptyText(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function prepareConnector(row, request) {
  if (!isPlainObject(row) || !isPlainObject(request) || !isPlainObject(request.config)) {
    return skipped('INVALID_SOURCE', 'connector preparation needs a source row and a normalized config');
  }
  const config = request.config;
  if (!nonEmptyText(request.connectorId)) {
    return skipped('INVALID_SOURCE', 'connector identity is missing');
  }
  if (request.revisionNumber !== 1) {
    return skipped('INVALID_SOURCE', 'legacy connectors migrate as revision 1 only');
  }
  if (request.state !== 'ACTIVE' && request.state !== 'RETIRED') {
    return skipped('UNMAPPABLE_STATE', 'connector state must map to ACTIVE or RETIRED');
  }
  if (!nonEmptyText(request.createdAt)) {
    return skipped('INVALID_SOURCE', 'connector creation timestamp is missing');
  }
  if (config.httpMethod !== 'POST') {
    return skipped('UNSUPPORTED_HTTP_METHOD', 'only POST connectors have an approved adapter mapping');
  }
  if (config.authType !== 'API_KEY_HEADER') {
    return skipped('UNSUPPORTED_AUTH_TYPE', 'only API_KEY_HEADER connectors have an approved adapter mapping');
  }
  if (typeof config.authKeyHeader !== 'string'
    || !HTTP_HEADER_NAME.test(config.authKeyHeader)
    || headerNameIsSecret(config.authKeyHeader)) {
    return skipped('INVALID_AUTH_HEADER', 'credential header name is malformed or reads as a plaintext credential');
  }
  if (!Number.isInteger(config.timeoutSec) || config.timeoutSec <= 0 || config.timeoutSec > 600) {
    return skipped('INVALID_TIMEOUT', 'timeout must be 1..600 seconds to stay inside the adapter ceiling');
  }
  const endpoint = splitEndpoint(config.endpointUrl);
  if (!endpoint) {
    return skipped('INVALID_ENDPOINT', 'endpoint must be an absolute http(s) URL without userinfo or fragment');
  }
  if (!nonEmptyText(config.responseContentPath)) {
    return skipped('INVALID_SOURCE', 'response content path is missing');
  }

  const requestMapping = {};
  if (!addMapping(requestMapping, config.promptFieldName, 'input.prompt')) {
    return skipped('INVALID_SOURCE', 'prompt field name is missing or maps to more than one source path');
  }
  if (nonEmptyText(config.fileFieldName) && !addMapping(requestMapping, config.fileFieldName, 'input.artifacts')) {
    return skipped('UNSAFE_FIELD_MAPPING', 'file field name maps to more than one source path');
  }
  if (nonEmptyText(config.sessionIdFieldName)
    && !addMapping(requestMapping, config.sessionIdFieldName, 'sessionRef')) {
    return skipped('UNSAFE_FIELD_MAPPING', 'session field name maps to more than one source path');
  }
  const responseMapping = { content: config.responseContentPath };
  if (nonEmptyText(config.sessionIdResponsePath)) {
    responseMapping.sessionRef = config.sessionIdResponsePath;
  }

  let headers;
  if (config.extraHeaders !== null && config.extraHeaders !== undefined) {
    if (!isPlainObject(config.extraHeaders)) {
      return skipped('INVALID_JSON', 'extra headers must be an object of string values');
    }
    headers = {};
    for (const [name, content] of Object.entries(config.extraHeaders)) {
      if (!HTTP_HEADER_NAME.test(name) || typeof content !== 'string') {
        return skipped('INVALID_JSON', 'extra headers must use valid header names and string values');
      }
      if (headerNameIsSecret(name)) {
        return skipped(
          'SECRET_HEADER_NOT_ALLOWED',
          'credential-bearing headers cannot live in revision config; reference the secret version instead',
        );
      }
      headers[name] = content;
    }
  }

  const authSecret = row.authSecret;
  if (typeof authSecret !== 'string' || authSecret.length === 0) {
    return skipped('MISSING_SECRET', 'legacy connector row carries no auth secret to migrate');
  }
  const key = encryptionKey();
  if (!key) {
    return skipped(
      'ENCRYPTION_KEY_MISSING',
      ENCRYPTION_KEY_ENV + ' must be a base64 32-byte key before any connector row is migrated',
    );
  }
  let encrypted;
  try {
    encrypted = encryptSecret(authSecret, key);
  } catch {
    return skipped('ENCRYPTION_FAILED', 'credential encryption failed for this connector row');
  }
  if (encrypted.byteLength < 29 || encrypted.equals(Buffer.from(authSecret, 'utf8'))) {
    return skipped('ENCRYPTION_FAILED', 'credential ciphertext is not a usable AES-256-GCM envelope');
  }

  const credentialRef = 'legacy-db:connector:' + request.connectorId;
  const adapter = nonEmptyText(config.fileFieldName) ? 'multipart-http' : 'json-http';
  const revisionConfig = {
    baseUrl: endpoint.origin,
    path: endpoint.pathname + endpoint.search,
    requestMapping,
    responseMapping,
    timeoutMs: config.timeoutSec * 1000,
    credentialSlot: 'header:' + config.authKeyHeader,
  };
  if (headers !== undefined) revisionConfig.headers = headers;

  return {
    revision: {
      connector_id: request.connectorId,
      revision: 1,
      adapter,
      config: revisionConfig,
      credential_ref: credentialRef,
      state: request.state,
      credential_source: { kind: 'legacy-db', credentialRef },
      tenant_id: '',
      createdAt: request.createdAt,
    },
    secret: {
      id: 'legacy-db:secret:' + request.connectorId + ':1',
      credential_ref: credentialRef,
      encrypted_value: encrypted,
    },
  };
}

// MDB-POLICY-02: profile naming and connection-override normalization.
//
// Both callbacks are synchronous and pure: the accepted runner contract rejects
// a thenable (ldba-03-production-adapter.cjs syncContext), and each answers for
// a single legacy row without reading anything else.
//
// resolveProfileName derives a name because the legacy ProfileEndpoint has no
// name column (lib/db/schema.ts:122-137). It derives it from endpointSlug rather
// than from the resolved business/action for three reasons:
//   1. this callback receives the row only - the business/action mapping lives in
//      the runner registry (ldba-03-backfill.cjs:333-350), which this module
//      cannot see, and the legacy row carries no such columns;
//   2. that registry is keyed by manifest action name and looked up by slug
//      (ldba-03-production-adapter.cjs:463-478 and :642-648), so every row that
//      reaches this callback already has action === endpointSlug - the name built
//      below is therefore the approved Imported <action> form;
//   3. profile_names is unique on (tenant, api_key_id, business, action,
//      profile_name) (0028_profile_name.sql:33-34) while the legacy key is
//      (apiKeyId, endpointSlug). A slug-derived name stays unique even if a
//      future registry maps several slugs onto one action, where a name built
//      from the action alone would collide.
// A row that cannot name a profile answers with an empty string, which the runner
// reports as INVALID_PROFILE_NAME (ldba-03-backfill.cjs:591-593). That is a
// refusal, not a throw: an exception here aborts the whole run instead of
// reporting the row.
const PROFILE_NAME_PREFIX = 'Imported ';
const PROFILE_SLUG_MAX_LENGTH = 64;
const CLEAN_ENDPOINT_SLUG = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/;

function sanitizeProfileSlug(slug) {
  return slug
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+/, '')
    .slice(0, PROFILE_SLUG_MAX_LENGTH)
    .replace(/-+$/, '');
}

function resolveProfileName(row) {
  if (!isPlainObject(row) || typeof row.endpointSlug !== 'string') return '';
  const slug = row.endpointSlug.trim();
  if (slug.length === 0) return '';
  const token = slug.length <= PROFILE_SLUG_MAX_LENGTH && CLEAN_ENDPOINT_SLUG.test(slug)
    ? slug
    : sanitizeProfileSlug(slug);
  return token.length > 0 ? PROFILE_NAME_PREFIX + token : '';
}

// normalizeConnectionsOverride projects the legacy JSON text onto the target
// contract. Legacy stored either a bare slug list or ConnectionStep objects
// (lib/endpoints/profile-resolver.ts:118-141, app/profiles/page.tsx:801-841).
// The target is the strict ConnectionStepSchema
// (packages/contracts/src/profile-policy.ts:209-216) and the runtime read path
// keeps only entries whose slug is a string (modules/profiles/policy.ts:343-348),
// so the rules are: a hop survives when its slug is usable, only schema-valid
// fields are carried, and no step is emitted that the strict schema would reject.
// The runner only checks Array.isArray (ldba-03-backfill.cjs:596-599) and has no
// per-step channel, so a dropped step is invisible to its report; the MDB-POLICY-02
// receipt records that as a deviation.
const CONNECTION_STEP_AUXILIARY_KEYS = ['stepId', 'captureSession', 'injectSession'];

function normalizeConnectionStep(entry) {
  if (typeof entry === 'string') {
    const slug = entry.trim();
    return slug.length > 0 ? { slug } : null;
  }
  if (!isPlainObject(entry) || typeof entry.slug !== 'string' || entry.slug.trim().length === 0) {
    return null;
  }
  const step = { slug: entry.slug.trim() };
  for (const key of CONNECTION_STEP_AUXILIARY_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(entry, key)) continue;
    const value = entry[key];
    if (key === 'stepId') {
      if (typeof value === 'string' && value.trim().length > 0) step.stepId = value.trim();
      continue;
    }
    if (typeof value === 'string') step[key] = value;
    else if (value === null) step[key] = null;
  }
  return step;
}

function normalizeConnectionSteps(value) {
  if (!Array.isArray(value)) return null;
  const steps = [];
  for (const entry of value) {
    const step = normalizeConnectionStep(entry);
    if (step !== null) steps.push(step);
  }
  return steps;
}

function normalizeConnectionsOverride(raw) {
  const steps = normalizeConnectionSteps(raw);
  if (steps !== null) return steps;
  if (!isPlainObject(raw)) return [];
  for (const value of Object.values(raw)) {
    const nested = normalizeConnectionSteps(value);
    if (nested !== null) return nested;
  }
  return [];
}


// MDB-POLICY-03: prepareWorkflowSchema - the pure prep for one legacy
// `wb_schema:<slug>` AppSetting row.
//
// The runner (scripts/ldba-03-backfill.cjs:658-687) hands this callback the
// parsed JSON plus { slug, tenantId, revision: 1 } and keeps the row write for
// itself, so this policy has to produce exactly the two values the target row
// carries: the canonical-pin digest and the sealed schema_ref object. Both are
// reproduced byte-compatibly from the production sources rather than invented:
//
//   digest    workflow-schemas.ts:70-76 -> legacy-workflow.ts:320-326
//             canonicalLegacyWorkflowPinBytes over
//             { schema, connectorSlotMap, approvedEgressOrigins: sorted }
//   schemaRef workflow-schemas.ts:294-298 -> metadata-crypto.ts:306-335, the
//             same SealedMetadata envelope and the same AAD triple
//             (tenantId | legacy_workflow_schemas.schema_ref | slug:revision)
//
// Two boundaries are load-bearing and are deliberately NOT copied wholesale.
//
//  1. The validator. parseLegacyWorkflowSchema (legacy-workflow.ts:257-296) is
//     zod-backed and needs @du/contracts, a build artifact this dependency-free
//     .cjs cannot load. This policy mirrors the plain-JavaScript parts -
//     preflightSchemaJson (:453-472), preflightNodeGraph (:409-431) and the
//     graph invariants (:268-296) - then checks every node against the required
//     fields of its own discriminated-union member (:26-91). It is strict on
//     purpose: anything not positively verified is refused. The catalog writer
//     stays the authority - parseStoredPin (workflow-schemas.ts:116-140) re-parses,
//     re-allocates and re-digests on every read - so a divergence here can only
//     ever leave a row unreadable, never readable with the wrong content.
//     The digest itself is safe against that class of drift: every object in
//     LegacyWorkflowSchemaSchema is passthrough and none of them declares a
//     .default() (legacy-workflow.ts:116-125), so zod returns the input unchanged
//     and the canonical bytes below equal the bytes the reader recomputes.
//  2. The key. Sealing needs keyProvider.wrapDek (metadata-crypto.ts:226-229),
//     which in this deployment is Vault Transit
//     (modules/encryption/vault-transit-provider.ts). node:crypto cannot wrap a
//     DEK for a reader that unwraps through Vault, so the provider is INJECTED,
//     the same choice createMetadataCrypto makes (metadata-crypto.ts:276-284).
//     With no seam this refuses and never emits an envelope-shaped value that no
//     reader can open - that would pass the runner shape check
//     (ldba-03-backfill.cjs:669-676) and write a row the catalog can never read.
//
// Egress origins follow the LDBA-06 R4 policy (PLAN-LEGACY-DB-ADAPTER-2026-10-09
// :319): derive them from the static HTTPS URLs the schema already carries,
// refuse anything dynamic, non-HTTPS or userinfo-bearing, and never invent an
// origin the schema does not name.
//
// Refusals throw instead of returning a skip because AppSetting has no skip
// channel in the accepted runner: SKIP_POLICIES (ldba-03-backfill.cjs:79-93)
// lists only 4 tables and mapWorkflowSetting has no skip branch at all, so a
// returned skip would be relabelled INVALID_WORKFLOW_ADAPTER_OUTPUT and hide
// the real reason behind a shape error.
const WORKFLOW_SCHEMA_SLOT = 'legacy_workflow_schemas.schema_ref';
const WORKFLOW_CATALOG_ROW_ID_MAX = 256;
const METADATA_ENVELOPE_VERSION = 1;
const METADATA_ALGORITHM = 'aes-256-gcm';
const METADATA_DEK_BYTES = 32;
const METADATA_NONCE_BYTES = 12;
const METADATA_TAG_BYTES = 16;
const METADATA_ENABLED_ENV = 'DU_ENCRYPTION_METADATA_ENABLED';
const METADATA_SEAM_ENV = 'LDBA03_METADATA_SEAM_MODULE';
const METADATA_KEY_REF_ENV = 'LDBA03_METADATA_KEY_REF';
const LEGACY_WORKFLOW_MAX_BYTES = 512 * 1024;
const LEGACY_WORKFLOW_MAX_NODES = 128;
const LEGACY_WORKFLOW_MAX_BRANCHES = 32;
const LEGACY_WORKFLOW_MAX_NESTING = 32;
const LEGACY_WORKFLOW_MAX_ARRAY_ITEMS = 10000;
const LEGACY_WORKFLOW_MAX_PROPERTY_NAME = 512;
const LEGACY_WORKFLOW_MAX_NAME = 256;
const LEGACY_WORKFLOW_MAX_SLUG = 128;
const LEGACY_WORKFLOW_MAX_CONNECTOR_NAME = 128;
const LEGACY_WORKFLOW_MAX_MESSAGE = 4096;
const LEGACY_WORKFLOW_MAX_DESCRIPTION = 4096;
const LEGACY_WORKFLOW_MAX_NODE_DESCRIPTION = 2048;
const LEGACY_WORKFLOW_MAX_EGRESS_ORIGIN = 2048;
const MAX_APPROVED_EGRESS_ORIGINS = 16;
const WORKFLOW_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const WORKFLOW_NODE_ID_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,63}$/;
const DYNAMIC_EGRESS_PATTERN = /^\$[A-Za-z_][A-Za-z0-9_]*(?:\..+)?$/;
const UNSAFE_PROPERTY_NAMES = ['__proto__', 'prototype', 'constructor'];
const WORKFLOW_NODE_TYPES = Object.freeze([
  'connector', 'parallel', 'join', 'file_parse', 'file_url_download',
  'callback', 'archive_compress', 'archive_extract', 'human', 'input',
]);
const WORKFLOW_JOIN_COMBINE = ['concat', 'first', 'merge'];
const WORKFLOW_FILE_PARSER = ['auto', 'excel', 'word', 'pdf'];
const WORKFLOW_CALLBACK_METHOD = ['POST', 'GET'];
const WORKFLOW_INPUT_TYPES = ['string', 'number', 'boolean', 'string[]', 'object'];
// Mirrors LEGACY_WORKFLOW_CONNECTOR_SLOTS (legacy-workflow.ts:129-132): slots
// are assigned once and never rerouted, so a name keeps its slot forever.
const WORKFLOW_CONNECTOR_SLOTS = Object.freeze(Array.from({ length: 32 }, (unused, index) => (
  'legacy-connector-' + String(index).padStart(2, '0')
)));

function workflowSchemaFailure(code, reason) {
  const error = new Error('workflow schema policy refused the row: ' + reason);
  error.name = 'WorkflowSchemaPolicyError';
  error.code = code;
  error.callback = 'prepareWorkflowSchema';
  throw error;
}

// Byte-identical to canonicalizeMetadataJson (metadata-crypto.ts:187-199),
// canonicalLegacyWorkflowJsonBytes (legacy-workflow.ts:395-406) and
// stableSerialize ordering: object keys sorted recursively, array order kept
// because order is meaning.
function canonicalWorkflowJsonBytes(value) {
  const sort = (node) => {
    if (Array.isArray(node)) return node.map(sort);
    if (node === null || typeof node !== 'object') return node;
    const result = {};
    for (const key of Object.keys(node).sort()) result[key] = sort(node[key]);
    return result;
  };
  return Buffer.from(JSON.stringify(sort(value)), 'utf8');
}

function workflowAad(tenantId, refId) {
  return createHash(
    'sha256'
  ).update(tenantId + '|' + WORKFLOW_SCHEMA_SLOT + '|' + refId, 'utf8').digest();
}
function workflowSchemaText(value, maxLength, field) {
  if (typeof value !== 'string' || value.length < 1 || value.length > maxLength) {
    workflowSchemaFailure('INVALID_SCHEMA', field + ' must be a string of 1..' + String(maxLength) + ' characters');
  }
  return value;
}

function workflowOptionalInt(value, min, max, field) {
  if (value === undefined) return;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
    workflowSchemaFailure('INVALID_SCHEMA', field + ' must be an integer in ' + String(min) + '..' + String(max));
  }
}

function workflowOptionalEnum(value, allowed, field) {
  if (value === undefined) return;
  if (typeof value !== 'string' || allowed.indexOf(value) === -1) {
    workflowSchemaFailure('INVALID_SCHEMA', field + ' must be one of ' + allowed.join(', '));
  }
}

// Mirrors preflightSchemaJson (legacy-workflow.ts:453-472): plain JSON objects
// only, no cycles or shared references, bounded depth, bounded array length,
// no unsafe property paths, and a bounded serialized size.
function preflightWorkflowSchemaJson(value) {
  if (!isPlainObject(value)) workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema must be a JSON object');
  const stack = [{ value, depth: 0 }];
  const seen = new WeakSet();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current.depth > LEGACY_WORKFLOW_MAX_NESTING) {
      workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema value exceeds maximum nesting');
    }
    if (seen.has(current.value)) {
      workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema cannot contain cycles or shared object references');
    }
    seen.add(current.value);
    if (Array.isArray(current.value)) {
      if (current.value.length > LEGACY_WORKFLOW_MAX_ARRAY_ITEMS) {
        workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema array exceeds maximum size');
      }
      for (const item of current.value) {
        if (item !== null && typeof item === 'object') stack.push({ value: item, depth: current.depth + 1 });
      }
      continue;
    }
    const prototype = Object.getPrototypeOf(current.value);
    if (prototype !== Object.prototype && prototype !== null) {
      workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema must contain plain JSON objects only');
    }
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current.value))) {
      if (UNSAFE_PROPERTY_NAMES.indexOf(key) !== -1) {
        workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema contains an unsafe property path');
      }
      if (key.length > LEGACY_WORKFLOW_MAX_PROPERTY_NAME || !Object.prototype.hasOwnProperty.call(descriptor, 'value')) {
        workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema contains an invalid property');
      }
      const child = descriptor.value;
      if (child !== null && typeof child === 'object') stack.push({ value: child, depth: current.depth + 1 });
    }
  }
  let encoded;
  try {
    encoded = JSON.stringify(value);
  } catch {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema is not serializable JSON');
  }
  if (typeof encoded !== 'string' || Buffer.byteLength(encoded, 'utf8') > LEGACY_WORKFLOW_MAX_BYTES) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema exceeds the maximum serialized size');
  }
}

function validateWorkflowInputSchema(inputSchema) {
  if (!isPlainObject(inputSchema)) workflowSchemaFailure('INVALID_SCHEMA', 'workflow input_schema must be an object');
  if (inputSchema.type !== 'object') workflowSchemaFailure('INVALID_SCHEMA', 'workflow input_schema type must be object');
  if (!isPlainObject(inputSchema.properties)) workflowSchemaFailure('INVALID_SCHEMA', 'workflow input_schema properties must be an object');
  for (const [key, property] of Object.entries(inputSchema.properties)) {
    if (key.length < 1 || key.length > 128 || UNSAFE_PROPERTY_NAMES.indexOf(key) !== -1) {
      workflowSchemaFailure('INVALID_SCHEMA', 'workflow input_schema property name is not a safe key');
    }
    if (!isPlainObject(property) || WORKFLOW_INPUT_TYPES.indexOf(property.type) === -1) {
      workflowSchemaFailure('INVALID_SCHEMA', 'workflow input_schema property type is not part of the legacy property union');
    }
  }
}

function validateWorkflowOutput(output) {
  if (!isPlainObject(output)) workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema output must be an object');
  if (typeof output.from !== 'string' || !WORKFLOW_NODE_ID_PATTERN.test(output.from)) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow output from must be a node id');
  }
  if (output.extra_data_from !== undefined) {
    if (typeof output.extra_data_from !== 'string' || !WORKFLOW_NODE_ID_PATTERN.test(output.extra_data_from)) {
      workflowSchemaFailure('INVALID_SCHEMA', 'workflow output extra_data_from must be a node id');
    }
  }
}

// One discriminated-union member per legacy node type (legacy-workflow.ts:26-91).
// Required fields are enforced, optional enum and bound fields are checked when
// present, and an unknown type is refused rather than passed through.
function validateWorkflowNode(node) {
  if (!isPlainObject(node)) workflowSchemaFailure('INVALID_SCHEMA', 'workflow node must be an object');
  if (typeof node.id !== 'string' || !WORKFLOW_NODE_ID_PATTERN.test(node.id)) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow node id must match the node id pattern');
  }
  if (typeof node.type !== 'string' || WORKFLOW_NODE_TYPES.indexOf(node.type) === -1) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow node type is not part of the legacy node union');
  }
  if (node.description !== undefined) workflowSchemaText(node.description, LEGACY_WORKFLOW_MAX_NODE_DESCRIPTION, 'node description');
  switch (node.type) {
    case 'connector':
      workflowSchemaText(node.connector, LEGACY_WORKFLOW_MAX_CONNECTOR_NAME, 'connector name');
      return;
    case 'parallel':
      if (!Array.isArray(node.branches) || node.branches.length < 1 || node.branches.length > LEGACY_WORKFLOW_MAX_BRANCHES) {
        workflowSchemaFailure('INVALID_SCHEMA', 'parallel node branches must be 1..' + String(LEGACY_WORKFLOW_MAX_BRANCHES) + ' arrays');
      }
      for (const branch of node.branches) {
        if (!Array.isArray(branch)) workflowSchemaFailure('INVALID_SCHEMA', 'parallel node branch must be an array of nodes');
      }
      return;
    case 'join':
      workflowOptionalEnum(node.combine, WORKFLOW_JOIN_COMBINE, 'join combine');
      return;
    case 'file_parse':
      workflowOptionalEnum(node.parser, WORKFLOW_FILE_PARSER, 'file_parse parser');
      return;
    case 'file_url_download':
      if (node.allowedExtensions !== undefined) {
        workflowSchemaText(node.allowedExtensions, 1024, 'file_url_download allowedExtensions');
      }
      return;
    case 'callback':
      workflowOptionalEnum(node.method, WORKFLOW_CALLBACK_METHOD, 'callback method');
      return;
    case 'archive_compress':
      if (node.name !== undefined) workflowSchemaText(node.name, 255, 'archive_compress name');
      workflowOptionalInt(node.level, 0, 9, 'archive_compress level');
      return;
    case 'archive_extract':
      if (node.destName !== undefined) workflowSchemaText(node.destName, 255, 'archive_extract destName');
      workflowOptionalInt(node.maxTotalBytes, 1, 64 * 1024 * 1024, 'archive_extract maxTotalBytes');
      workflowOptionalInt(node.maxEntries, 1, 1000, 'archive_extract maxEntries');
      return;
    case 'human':
      workflowSchemaText(node.message, LEGACY_WORKFLOW_MAX_MESSAGE, 'human message');
      workflowOptionalInt(node.nextStep, 0, LEGACY_WORKFLOW_MAX_NODES, 'human nextStep');
      if (node.resumeInputs !== undefined) {
        if (!Array.isArray(node.resumeInputs) || node.resumeInputs.length > LEGACY_WORKFLOW_MAX_NODES) {
          workflowSchemaFailure('INVALID_SCHEMA', 'human resumeInputs must be at most ' + String(LEGACY_WORKFLOW_MAX_NODES) + ' node ids');
        }
        for (const resume of node.resumeInputs) {
          if (typeof resume !== 'string' || !WORKFLOW_NODE_ID_PATTERN.test(resume)) {
            workflowSchemaFailure('INVALID_SCHEMA', 'human resumeInputs must contain node ids only');
          }
        }
      }
      return;
    case 'input':
      if (typeof node.key !== 'string' || node.key.length < 1 || node.key.length > 128 || UNSAFE_PROPERTY_NAMES.indexOf(node.key) !== -1) {
        workflowSchemaFailure('INVALID_SCHEMA', 'input node key must be a safe 1..128 character name');
      }
      return;
    default:
      workflowSchemaFailure('INVALID_SCHEMA', 'workflow node type is not part of the legacy node union');
  }
}

function validateWorkflowSchema(parsed, expectedSlug) {
  if (typeof parsed.slug !== 'string' || parsed.slug.length < 1 || parsed.slug.length > LEGACY_WORKFLOW_MAX_SLUG || !WORKFLOW_SLUG_PATTERN.test(parsed.slug)) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema slug must match the catalog slug pattern');
  }
  if (parsed.slug !== expectedSlug) {
    workflowSchemaFailure('KEY_SCHEMA_SLUG_MISMATCH', 'workflow schema slug differs from the AppSetting key slug');
  }
  workflowSchemaText(parsed.name, LEGACY_WORKFLOW_MAX_NAME, 'workflow schema name');
  if (parsed.version !== undefined) workflowOptionalInt(parsed.version, 1, Number.MAX_SAFE_INTEGER, 'workflow schema version');
  if (parsed.description !== undefined) workflowSchemaText(parsed.description, LEGACY_WORKFLOW_MAX_DESCRIPTION, 'workflow schema description');
  if (parsed.input_schema !== undefined) validateWorkflowInputSchema(parsed.input_schema);
  if (!Array.isArray(parsed.nodes) || parsed.nodes.length < 1 || parsed.nodes.length > LEGACY_WORKFLOW_MAX_NODES) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema nodes must be 1..' + String(LEGACY_WORKFLOW_MAX_NODES) + ' entries');
  }
  if (!Array.isArray(parsed.flow) || parsed.flow.length < 1 || parsed.flow.length > LEGACY_WORKFLOW_MAX_NODES) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema flow must be 1..' + String(LEGACY_WORKFLOW_MAX_NODES) + ' node ids');
  }
  for (const id of parsed.flow) {
    if (typeof id !== 'string' || !WORKFLOW_NODE_ID_PATTERN.test(id)) {
      workflowSchemaFailure('INVALID_SCHEMA', 'workflow schema flow must contain node ids only');
    }
  }
  if (parsed.output !== undefined) validateWorkflowOutput(parsed.output);

  const pending = [{ nodes: parsed.nodes, depth: 0 }];
  const allIds = new Set();
  let nodeCount = 0;
  while (pending.length > 0) {
    const current = pending.pop();
    if (current.depth > 8) workflowSchemaFailure('INVALID_SCHEMA', 'workflow nesting exceeds the maximum depth');
    for (const node of current.nodes) {
      nodeCount += 1;
      if (nodeCount > LEGACY_WORKFLOW_MAX_NODES) workflowSchemaFailure('INVALID_SCHEMA', 'workflow exceeds the maximum node count');
      validateWorkflowNode(node);
      if (allIds.has(node.id)) workflowSchemaFailure('INVALID_SCHEMA', 'workflow node ids must be unique');
      allIds.add(node.id);
      if (node.type === 'parallel') {
        for (const branch of node.branches) pending.push({ nodes: branch, depth: current.depth + 1 });
      }
    }
  }
  const topIds = new Set(parsed.nodes.map((node) => node.id));
  for (const id of parsed.flow) {
    if (!topIds.has(id)) workflowSchemaFailure('INVALID_SCHEMA', 'workflow flow references an unknown top-level node');
  }
  if (new Set(parsed.flow).size !== parsed.flow.length) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow flow cannot repeat a node id');
  }
  if (parsed.output !== undefined && !allIds.has(parsed.output.from)) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow output references an unknown node');
  }
  if (parsed.output !== undefined && parsed.output.extra_data_from !== undefined && !allIds.has(parsed.output.extra_data_from)) {
    workflowSchemaFailure('INVALID_SCHEMA', 'workflow extracted-data output references an unknown node');
  }
  return parsed;
}

// Mirrors legacyWorkflowConnectorNames (legacy-workflow.ts:152-162).
function workflowConnectorNames(schema) {
  const names = new Set();
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'connector' && typeof node.connector === 'string') names.add(node.connector);
      if (node.type === 'parallel') {
        for (const branch of node.branches) visit(branch);
      }
    }
  };
  visit(schema.nodes);
  return [...names].sort((left, right) => left.localeCompare(right, 'en'));
}

// Mirrors allocateLegacyWorkflowConnectorSlotMap (legacy-workflow.ts:179-195)
// with no prior revision: revision 1 always allocates from the first free slot.
function allocateWorkflowConnectorSlots(schema) {
  const mapping = {};
  const used = new Set();
  for (const name of workflowConnectorNames(schema)) {
    const next = WORKFLOW_CONNECTOR_SLOTS.find((slot) => !used.has(slot));
    if (next === undefined) workflowSchemaFailure('CONNECTOR_SLOT_EXHAUSTED', 'workflow exceeds the 32 connector slot limit');
    mapping[name] = next;
    used.add(next);
  }
  return mapping;
}

// Mirrors collectConfiguredUrls (legacy-workflow.ts:371-388).
function collectWorkflowUrls(value, output) {
  if (typeof value === 'string') {
    output.push(value);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectWorkflowUrls(item, output);
    return;
  }
  if (!isPlainObject(value)) return;
  if (Object.prototype.hasOwnProperty.call(value, 'url')) collectWorkflowUrls(value.url, output);
}

// LDBA-06 R4 policy: derive the approved origins from the static HTTPS URLs the
// schema already names. A dynamic binding, a non-HTTPS URL, a userinfo URL or a
// fragment is refused outright rather than auto-approved, because this runner has
// no administrator-approval channel and inventing an origin is exactly what R4
// forbids. Refusing is stricter than validateLegacyWorkflowEgressOrigins, which
// only requires a non-empty approved set, so acceptance stays inside the contract.
function deriveApprovedWorkflowOrigins(schema) {
  const origins = new Set();
  const visit = (nodes) => {
    for (const node of nodes) {
      if (node.type === 'parallel') {
        for (const branch of node.branches) visit(branch);
      }
      if (node.type !== 'file_url_download' && node.type !== 'callback') continue;
      const urls = [];
      collectWorkflowUrls(node.type === 'callback' ? node.url : node.urls, urls);
      if (urls.length === 0) {
        workflowSchemaFailure('EGRESS_WITHOUT_URL', 'workflow egress node carries no configured url');
      }
      for (const configured of urls) {
        if (DYNAMIC_EGRESS_PATTERN.test(configured)) {
          workflowSchemaFailure('DYNAMIC_EGRESS_URL', 'dynamic workflow egress needs an administrator-approved origin this runner cannot supply');
        }
        let parsed;
        try {
          parsed = new URL(configured);
        } catch {
          workflowSchemaFailure('INVALID_EGRESS_URL', 'workflow egress url is not a valid absolute url');
        }
        if (parsed.protocol !== 'https:') workflowSchemaFailure('NON_HTTPS_EGRESS_URL', 'workflow egress url must be https');
        if (parsed.username !== '' || parsed.password !== '') workflowSchemaFailure('EGRESS_URL_USERINFO', 'workflow egress url must not carry userinfo');
        if (parsed.hash !== '') workflowSchemaFailure('INVALID_EGRESS_URL', 'workflow egress url must not carry a fragment');
        if (parsed.origin.length > LEGACY_WORKFLOW_MAX_EGRESS_ORIGIN) {
          workflowSchemaFailure('INVALID_EGRESS_URL', 'workflow egress origin exceeds the approved-origin length limit');
        }
        origins.add(parsed.origin);
      }
    }
  };
  visit(schema.nodes);
  const approved = [...origins].sort();
  if (approved.length > MAX_APPROVED_EGRESS_ORIGINS) {
    workflowSchemaFailure('TOO_MANY_EGRESS_ORIGINS', 'workflow declares more approved origins than the catalog accepts');
  }
  return approved;
}

// Mirrors schemaDigest (workflow-schemas.ts:70-76).
function workflowSchemaDigest(schema, connectorSlotMap, approvedEgressOrigins) {
  const bytes = canonicalWorkflowJsonBytes({
    schema,
    connectorSlotMap,
    approvedEgressOrigins: [...approvedEgressOrigins].sort(),
  });
  return 'sha256:' + createHash('sha256').update(bytes).digest('hex');
}

// The injected metadata key seam. Mirrors the fail-closed order of
// backfill-metadata-cli.ts:107-109: no metadata switch, no seam, no run.
function requireMetadataSeam() {
  if (process.env[METADATA_ENABLED_ENV] !== 'true') {
    workflowSchemaFailure('METADATA_SEAM_DISABLED', METADATA_ENABLED_ENV + ' is not true, so no metadata key exists to seal schema_ref with');
  }
  const modulePath = process.env[METADATA_SEAM_ENV];
  if (typeof modulePath !== 'string' || modulePath.trim().length === 0) {
    workflowSchemaFailure('METADATA_SEAM_MODULE_REQUIRED', METADATA_SEAM_ENV + ' must name a module exporting wrapDek before any workflow schema is sealed');
  }
  const keyRef = process.env[METADATA_KEY_REF_ENV];
  if (typeof keyRef !== 'string' || keyRef.trim().length === 0) {
    workflowSchemaFailure('METADATA_KEY_REF_REQUIRED', METADATA_KEY_REF_ENV + ' must name the metadata key before any workflow schema is sealed');
  }
  let loaded;
  try {
    loaded = require(modulePath);
  } catch (error) {
    workflowSchemaFailure('METADATA_SEAM_LOAD_FAILED', 'metadata seam module could not be loaded: ' + String(error && error.message || error));
  }
  const seam = loaded && loaded.default ? loaded.default : loaded;
  if (seam === null || typeof seam !== 'object' || typeof seam.wrapDek !== 'function') {
    workflowSchemaFailure('METADATA_SEAM_INVALID', 'metadata seam must export wrapDek(dek, keyRef)');
  }
  return { seam, keyRef };
}

// Mirrors the seal half of createMetadataCrypto (metadata-crypto.ts:306-335):
// the same canonical plaintext, the same 32-byte AAD digest over
// tenantId|slot|refId, the same aes-256-gcm envelope and the same
// plaintextSha256 field. Only wrapDek is delegated, exactly as the product
// delegates it to its injected key provider.
async function sealWorkflowSchemaEnvelope(seamHandle, value, tenantId, refId) {
  const seam = seamHandle.seam;
  const keyRef = seamHandle.keyRef;
  const plaintext = canonicalWorkflowJsonBytes(value);
  const dek = randomBytes(METADATA_DEK_BYTES);
  const nonce = randomBytes(METADATA_NONCE_BYTES);
  const aad = workflowAad(tenantId, refId);
  let wrapped;
  try {
    wrapped = await seam.wrapDek(dek, keyRef);
  } catch (error) {
    workflowSchemaFailure('METADATA_KEY_PROVIDER_FAILED', 'failed to wrap the metadata DEK: ' + String(error && error.message || error));
  }
  if (wrapped === null || typeof wrapped !== 'object') {
    workflowSchemaFailure('METADATA_KEY_PROVIDER_FAILED', 'metadata seam did not return a wrapped DEK envelope');
  }
  const cipher = createCipheriv('aes-256-gcm', dek, nonce, { authTagLength: METADATA_TAG_BYTES });
  cipher.setAAD(aad);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return {
    version: METADATA_ENVELOPE_VERSION,
    algorithm: METADATA_ALGORITHM,
    keyRef,
    dek: wrapped,
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    aad: aad.toString('base64'),
    ciphertext: ciphertext.toString('base64'),
    plaintextSha256: createHash('sha256').update(plaintext).digest('hex'),
  };
}

// Synchronous validation, then the sealing promise, so a malformed row is
// refused with a synchronous throw the runner reports as a row failure, while
// the runner awaits the envelope like it awaits prepareConnector.
function prepareWorkflowSchema(parsed, request) {
  if (!isPlainObject(request)) workflowSchemaFailure('INVALID_SOURCE', 'workflow schema preparation needs a source request object');
  if (typeof request.slug !== 'string' || request.slug.length < 1 || request.slug.length > LEGACY_WORKFLOW_MAX_SLUG || !WORKFLOW_SLUG_PATTERN.test(request.slug)) {
    workflowSchemaFailure('INVALID_SOURCE', 'workflow schema slug is missing or malformed');
  }
  if (typeof request.tenantId !== 'string' || request.tenantId.trim().length === 0) {
    workflowSchemaFailure('INVALID_SOURCE', 'workflow schema tenant identity is missing');
  }
  if (request.revision !== 1) {
    workflowSchemaFailure('INVALID_SOURCE', 'legacy workflow schemas migrate as revision 1 only');
  }
  preflightWorkflowSchemaJson(parsed);
  const schema = validateWorkflowSchema(parsed, request.slug);
  const connectorSlotMap = allocateWorkflowConnectorSlots(schema);
  const approvedEgressOrigins = deriveApprovedWorkflowOrigins(schema);
  const digest = workflowSchemaDigest(schema, connectorSlotMap, approvedEgressOrigins);
  const refId = schema.slug + ':' + String(request.revision);
  if (refId.length > WORKFLOW_CATALOG_ROW_ID_MAX) {
    workflowSchemaFailure('INVALID_SOURCE', 'workflow schema identity exceeds the supported catalog row id limit');
  }
  // Resolved before the async seal so every refusal is a synchronous throw
  // the runner reports as one row failure, never a floating rejection.
  const seamHandle = requireMetadataSeam();
  return sealWorkflowSchemaEnvelope(
    seamHandle,
    { schema, connectorSlotMap, approvedEgressOrigins: [...approvedEgressOrigins].sort() },
    request.tenantId,
    refId,
  ).then((schemaRef) => ({ digest, schemaRef }));
}

// MDB-POLICY-04: the FileCache object reader, the deterministic artifact token, and
// the artifact purpose.
//
// The reader cannot fabricate bytes. The runner re-checks both the byte count and the
// MD5 of whatever the reader returns (ldba-03-backfill.cjs:704-715), so filler derived
// from the digest could only turn an honest ARTIFACT_READER_REQUIRED into a
// misleading ARTIFACT_MD5_MISMATCH. The reader therefore serves real bytes from a
// configured object root and fails closed otherwise. With no root configured the row
// fails as TRANSFORM_ERROR, which is exactly what the LDBA-09 rehearsal pins
// (scripts/ldba-09-harness.cjs:690) - that harness never sets this environment key.
const FILECACHE_OBJECT_DIR_ENV = 'LDBA03_FILECACHE_OBJECT_DIR';
const ARTIFACT_PURPOSE_INPUT = 'input';
const ARTIFACT_PURPOSE_OUTPUT = 'output';
const ARTIFACT_PURPOSE_INPUT_MARKER = 'upload';

// Same shape as workflowSchemaFailure (MDB-POLICY-03), with the code inlined in the
// message: the runner records only String(error.message) when it writes a
// TRANSFORM_ERROR (ldba-03-backfill.cjs:856), so a code that lives only on the error
// object would be invisible in the report it prints.
function fileCacheFailure(code, reason, callback) {
  const error = new Error(code + ': ' + reason);
  error.name = 'FileCachePolicyError';
  error.code = code;
  error.callback = callback;
  throw error;
}

function fileCacheObjectRoot() {
  const configured = process.env[FILECACHE_OBJECT_DIR_ENV];
  if (typeof configured !== 'string' || configured.trim().length === 0) return undefined;
  try {
    return fs.realpathSync(path.resolve(configured.trim()));
  } catch {
    fileCacheFailure(
      'ARTIFACT_READER_REQUIRED',
      FILECACHE_OBJECT_DIR_ENV + ' does not resolve to an existing directory',
      'readFileCacheBytes',
    );
  }
}

function readFileCacheBytes(s3Key) {
  if (typeof s3Key !== 'string' || s3Key.length === 0) {
    fileCacheFailure('INVALID_ARTIFACT_BYTES', 'legacy source object key must be a non-empty string', 'readFileCacheBytes');
  }
  const root = fileCacheObjectRoot();
  if (root === undefined) {
    fileCacheFailure(
      'ARTIFACT_READER_REQUIRED',
      FILECACHE_OBJECT_DIR_ENV + ' must point at the legacy object root before any FileCache row is migrated',
      'readFileCacheBytes',
    );
  }
  // The key comes out of the legacy row, so it may never leave the root - directly
  // (absolute, drive letter, dot segment, backslash) or through a symlink. Legacy
  // keys are '<operationId>/<sanitizedName>' (lib/upload-helper.ts:43) and legacy
  // local storage resolved them under its own root (safePath, lib/storage/local-backend.ts).
  const segments = s3Key.split('/');
  for (const segment of segments) {
    if (segment.length === 0 || segment === '.' || segment === '..'
      || segment.indexOf('\\') !== -1 || segment.indexOf(':') !== -1) {
      fileCacheFailure('INVALID_ARTIFACT_BYTES', 'legacy source object key is not a plain relative path', 'readFileCacheBytes');
    }
  }
  const resolved = path.resolve(root, ...segments);
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!resolved.startsWith(prefix)) {
    fileCacheFailure('INVALID_ARTIFACT_BYTES', 'legacy source object key resolves outside the configured object root', 'readFileCacheBytes');
  }
  let real;
  try {
    real = fs.realpathSync(resolved);
  } catch {
    fileCacheFailure('INVALID_ARTIFACT_BYTES', 'legacy object is not readable from the configured object root', 'readFileCacheBytes');
  }
  if (!real.startsWith(prefix)) {
    fileCacheFailure('INVALID_ARTIFACT_BYTES', 'legacy object resolves outside the configured object root', 'readFileCacheBytes');
  }
  let bytes;
  try {
    bytes = fs.readFileSync(real);
  } catch {
    fileCacheFailure('INVALID_ARTIFACT_BYTES', 'legacy object could not be read from the configured object root', 'readFileCacheBytes');
  }
  if (!Buffer.isBuffer(bytes) && !(bytes instanceof Uint8Array)) {
    fileCacheFailure('INVALID_ARTIFACT_BYTES', 'object reader must return a Buffer or Uint8Array', 'readFileCacheBytes');
  }
  return Buffer.from(bytes);
}

function artifactTokenFor(row, id) {
  if (!isPlainObject(row) || typeof row.s3Key !== 'string' || row.s3Key.length === 0) {
    fileCacheFailure('INVALID_ARTIFACT_TOKEN', 'artifact token policy needs the legacy source object key', 'artifactTokenFor');
  }
  if (typeof id !== 'string' || id.length === 0) {
    fileCacheFailure('INVALID_ARTIFACT_TOKEN', 'artifact token policy needs the target artifact id', 'artifactTokenFor');
  }
  // Deterministic on purpose. The replay path compares every planned value for
  // identity (applyImmutableBatch in ldba-03-production-adapter.cjs), so a random
  // token would turn every replay into an immutable conflict. 64 hex characters, far
  // above the 32 the runner requires (ldba-03-backfill.cjs:718-720).
  return createHash('sha256').update(row.s3Key + ':' + id).digest('hex');
}

function artifactPurposeFor(row) {
  if (!isPlainObject(row) || typeof row.s3Key !== 'string' || row.s3Key.length === 0) {
    fileCacheFailure('INVALID_ARTIFACT_PURPOSE', 'artifact purpose policy needs the legacy source object key', 'artifactPurposeFor');
  }
  // The runner accepts only input|output|intermediate|session
  // (ldba-03-backfill.cjs:721-723). This implements the approved marker rule: input
  // when the source key names an upload, output otherwise. The legacy row carries no
  // purpose column and no legacy writer produced a key with that marker, so the
  // MDB-POLICY-04 receipt records the resulting default as a deviation.
  const key = row.s3Key.toLowerCase();
  return key.indexOf(ARTIFACT_PURPOSE_INPUT_MARKER) === -1
    ? ARTIFACT_PURPOSE_OUTPUT
    : ARTIFACT_PURPOSE_INPUT;
}

// Only prepareAdminLocalUser stays fail-closed: the legacy bcrypt verifier cannot
// become a target scrypt hash without user-presented plaintext. Exporting the
// complete callback surface prevents missing functions from silently reaching the
// runner as undefined.
module.exports = Object.freeze({
  prepareConnector,
  resolveProfileName,
  normalizeConnectionsOverride,
  prepareWorkflowSchema,
  readFileCacheBytes,
  artifactTokenFor,
  artifactPurposeFor,
  prepareAdminLocalUser: requirePasswordReset,
});
