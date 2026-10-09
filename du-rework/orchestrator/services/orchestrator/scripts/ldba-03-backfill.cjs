'use strict';

const crypto = require('node:crypto');
const path = require('node:path');

const TENANT_KEY = 'legacy-default';
const LEGACY_TABLES = Object.freeze([
  'Operation',
  'ApiKey',
  'ExternalApiConnection',
  'ExternalApiOverride',
  'ProfileEndpoint',
  'AppSetting',
  'FileCache',
  'User',
  'UserProfileAssignment',
]);

const JSON_FIELDS = Object.freeze([
  'pipelineJson',
  'stepsResultJson',
  'extractedData',
  'usageBreakdown',
  'parameters',
  'connectionsOverride',
  'staticFormFields',
  'extraHeaders',
]);

const JSON_EXCEPTIONS = Object.freeze({
  allowedFileExtensions: 'csv-text',
  fileUrlAuthConfig: 'encrypted-iv-tag-ciphertext-text',
});

const OPERATION_STATE = Object.freeze({
  RUNNING: 'RUNNING',
  SUCCEEDED: 'SUCCEEDED',
  FAILED: 'FAILED',
});

const API_KEY_STATUS = Object.freeze({
  active: 'ACTIVE',
  ACTIVE: 'ACTIVE',
  revoked: 'REVOKED',
  REVOKED: 'REVOKED',
});

const CONNECTOR_STATE = Object.freeze({
  ENABLED: 'ACTIVE',
  DISABLED: 'RETIRED',
});

const USER_ROLE = Object.freeze({
  ADMIN: 'ADMIN',
  USER: 'USER',
  VIEWER: 'VIEWER',
});

const DESTINATION_ORDER = Object.freeze({
  api_keys: 1,
  connector_revisions: 2,
  secret_versions: 3,
  profile_bindings: 4,
  profile_active_revisions: 5,
  profile_names: 6,
  operations: 7,
  connector_prompt_overrides: 8,
  artifacts: 9,
  artifact_blobs: 10,
  admin_local_users: 11,
  user_profile_assignments: 12,
  legacy_workflow_schemas: 13,
});

const SCRYPT_HASH = /^scrypt\$32768\$8\$1\$[A-Za-z0-9_-]{22}\$[A-Za-z0-9_-]{43}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SKIP_POLICIES = Object.freeze({
  ExternalApiConnection: Object.freeze([
    'CONNECTOR_ROW_OUT_OF_SCOPE',
  ]),
  ExternalApiOverride: Object.freeze([
    'OVERRIDE_CONNECTION_ID_NOT_UUID',
    'OVERRIDE_API_KEY_ID_NOT_UUID',
    'OVERRIDE_CONNECTOR_NOT_MIGRATED',
  ]),
  User: Object.freeze([
    'IDENTITY_PENDING_REHASH',
  ]),
  UserProfileAssignment: Object.freeze([
    'ASSIGNMENT_USER_NOT_MIGRATED',
    'ASSIGNMENT_USER_ID_NOT_UUID',
    'ASSIGNMENT_API_KEY_ID_NOT_UUID',
  ]),
});
const SOURCE_KEY = Object.freeze({
  Operation: (row) => row.id,
  ApiKey: (row) => row.id,
  ExternalApiConnection: (row) => row.id,
  ExternalApiOverride: (row) => row.id,
  ProfileEndpoint: (row) => row.id,
  AppSetting: (row) => row.key,
  FileCache: (row) => row.id,
  User: (row) => row.id,
  UserProfileAssignment: (row) => row.id,
});

class RowFailure extends Error {
  constructor(table, sourceKey, field, code, message) {
    super(message);
    this.name = 'RowFailure';
    this.table = table;
    this.sourceKey = sourceKey === null || sourceKey === undefined ? '<unknown>' : String(sourceKey);
    this.field = field;
    this.code = code;
  }
}

class RowSkip extends Error {
  constructor(table, sourceKey, field, code, reason) {
    super(reason);
    this.name = 'RowSkip';
    this.table = table;
    this.sourceKey = sourceKey === null || sourceKey === undefined ? '<unknown>' : String(sourceKey);
    this.field = field;
    this.code = code;
  }
}

function fail(table, row, field, code, message) {
  throw new RowFailure(table, SOURCE_KEY[table](row), field, code, message);
}

function skip(table, row, field, code, reason) {
  throw new RowSkip(table, SOURCE_KEY[table](row), field, code, reason);
}

function skippedSourceKey(report, table, sourceKey) {
  const keys = report._skippedSourceKeys.get(table);
  return Boolean(keys && keys.has(String(sourceKey)));
}

function approvedRowSkip(error, table, row) {
  const sourceKey = SOURCE_KEY[table](row);
  const expectedSourceKey = sourceKey === null || sourceKey === undefined ? '<unknown>' : String(sourceKey);
  return error instanceof RowSkip &&
    error.table === table &&
    error.sourceKey === expectedSourceKey &&
    Object.hasOwn(SKIP_POLICIES, table) &&
    SKIP_POLICIES[table].includes(error.code);
}

function recordSkip(report, error) {
  report.skips.push({
    table: error.table,
    sourceKey: error.sourceKey,
    field: error.field,
    code: error.code,
    reason: error.message,
  });
  report.sourceRows.skipped += 1;
  report.perTable[error.table].skipped += 1;
  const keys = report._skippedSourceKeys.get(error.table) || new Set();
  keys.add(error.sourceKey);
  report._skippedSourceKeys.set(error.table, keys);
}

function recordUnapprovedSkip(report, error, table, row) {
  const rejectedCode = error && error.code !== undefined ? String(error.code) : '<missing>';
  recordFailure(
    report,
    new RowFailure(
      table,
      SOURCE_KEY[table](row),
      error && typeof error.field === 'string' ? error.field : '<row>',
      'UNAPPROVED_SKIP',
      'controlled skip code is not approved for this source row: ' + rejectedCode,
    ),
    table,
    row,
  );
}

function requireText(table, row, field, value) {
  if (typeof value !== 'string' || value.length === 0) {
    fail(table, row, field, 'INVALID_TEXT', 'expected a non-empty text value');
  }
  return value;
}

function uuid(table, row, field, value) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    fail(table, row, field, 'INVALID_UUID', 'legacy text id is not a UUID');
  }
  return value.toLowerCase();
}

function timestampUtc(table, row, field, value) {
  if (typeof value !== 'string') {
    fail(table, row, field, 'TIMESTAMP_NOT_TEXT', 'read source timestamp as text without timezone');
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) {
    fail(table, row, field, 'TIMESTAMP_NOT_NAIVE', 'expected a timestamp without timezone');
  }
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const hour = Number(match[4]);
  const minute = Number(match[5]);
  const second = Number(match[6]);
  const millis = Number((match[7] || '').padEnd(3, '0').slice(0, 3));
  const instant = new Date(Date.UTC(year, month - 1, day, hour, minute, second, millis));
  if (
    instant.getUTCFullYear() !== year ||
    instant.getUTCMonth() + 1 !== month ||
    instant.getUTCDate() !== day ||
    instant.getUTCHours() !== hour ||
    instant.getUTCMinutes() !== minute ||
    instant.getUTCSeconds() !== second
  ) {
    fail(table, row, field, 'INVALID_TIMESTAMP', 'timestamp components are out of range');
  }
  return instant.toISOString();
}

function parseJsonField(table, row, field, value, required) {
  if (value === null || value === undefined) {
    if (required) fail(table, row, field, 'NULL_JSON', 'required JSON text is null');
    return null;
  }
  if (typeof value !== 'string') {
    fail(table, row, field, 'JSON_NOT_TEXT', 'source JSON column must be read as text');
  }
  try {
    return JSON.parse(value);
  } catch {
    fail(table, row, field, 'INVALID_JSON', 'source JSON text could not be parsed');
  }
}

function parseFileUrlAuthCipher(table, row, value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    fail(table, row, 'fileUrlAuthConfig', 'INVALID_CIPHER', 'cipher must be text');
  }
  const parts = value.split(':');
  if (
    parts.length !== 3 ||
    !/^[0-9a-fA-F]{24}$/.test(parts[0]) ||
    !/^[0-9a-fA-F]{32}$/.test(parts[1]) ||
    !/^(?:[0-9a-fA-F]{2})+$/.test(parts[2])
  ) {
    fail(table, row, 'fileUrlAuthConfig', 'INVALID_CIPHER', 'expected hex iv:tag:ciphertext with three parts');
  }
  return value;
}

function mapValue(table, row, field, value, mapping) {
  if (typeof value !== 'string' || !Object.prototype.hasOwnProperty.call(mapping, value)) {
    fail(table, row, field, 'UNKNOWN_VALUE', 'value is outside the explicit source-to-target map');
  }
  return mapping[value];
}

function integer(table, row, field, value, nullable) {
  if (nullable && (value === null || value === undefined)) return null;
  if (!Number.isSafeInteger(value) || value < -2147483648 || value > 2147483647) {
    fail(table, row, field, 'INVALID_INTEGER', 'expected a source integer in the PostgreSQL integer range');
  }
  return value;
}

function decimalUsd(table, row, field, value) {
  if (value === null || value === undefined) return null;
  if (typeof value !== 'string') {
    fail(table, row, field, 'UNSAFE_DECIMAL_INPUT', 'read floating USD through a decimal text projection');
  }
  const match = /^(-?)(\d+)(?:\.(\d+))?$/.exec(value);
  if (!match) {
    fail(table, row, field, 'INVALID_DECIMAL', 'expected a plain base-10 decimal string');
  }
  const fraction = match[3] || '';
  if (fraction.length > 6) {
    fail(table, row, field, 'DECIMAL_NOT_DATABASE_ROUNDED', 'source adapter must project PostgreSQL numeric rounding to six places as text');
  }
  const negative = match[1] === '-';
  const wholeText = match[2].replace(/^0+(?=\d)/, '');
  let scaled = BigInt(wholeText) * 1000000n;
  const sixPlaces = fraction.padEnd(6, '0');
  scaled += BigInt(sixPlaces || '0');
  if (wholeText.length > 14 || scaled >= 100000000000000000000n) {
    fail(table, row, field, 'DECIMAL_RANGE', 'value exceeds numeric(20,6)');
  }
  const sign = negative && scaled !== 0n ? '-' : '';
  const whole = (scaled / 1000000n).toString();
  const cents = (scaled % 1000000n).toString().padStart(6, '0');
  return sign + whole + '.' + cents;
}

function decimalRequired(table, row, field, value) {
  const result = decimalUsd(table, row, field, value);
  if (result === null) fail(table, row, field, 'NULL_DECIMAL', 'target field is non-null');
  return result;
}

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function addOmission(report, table, row, field, reason) {
  report.omissions.push({
    table,
    sourceKey: SOURCE_KEY[table](row) === undefined ? '<unknown>' : String(SOURCE_KEY[table](row)),
    field,
    reason,
  });
}

function write(entity, key, value, table, row) {
  return {
    entity,
    key: String(key),
    value,
    source: {
      table,
      sourceKey: String(SOURCE_KEY[table](row)),
    },
  };
}

function resolveBusiness(table, row, context) {
  if (typeof context.resolveBusinessAction !== 'function') {
    fail(table, row, 'endpointSlug', 'REGISTRY_ADAPTER_REQUIRED', 'existing business registry resolver is required');
  }
  const slug = requireText(table, row, 'endpointSlug', row.endpointSlug);
  const resolved = context.resolveBusinessAction(slug);
  if (
    !isPlainObject(resolved) ||
    typeof resolved.businessId !== 'string' ||
    typeof resolved.businessVersion !== 'string' ||
    typeof resolved.action !== 'string' ||
    !resolved.businessId ||
    !resolved.businessVersion ||
    !resolved.action
  ) {
    fail(table, row, 'endpointSlug', 'UNMAPPED_ENDPOINT', 'existing registry has no complete business/action mapping');
  }
  return resolved;
}

function mapOperation(row, context, report, tenantId) {
  const id = uuid('Operation', row, 'id', row.id);
  const apiKeyId = row.apiKeyId === null || row.apiKeyId === undefined
    ? null
    : uuid('Operation', row, 'apiKeyId', row.apiKeyId);
  const state = mapValue('Operation', row, 'state', row.state, OPERATION_STATE);
  if (typeof row.done !== 'boolean') {
    fail('Operation', row, 'done', 'INVALID_BOOLEAN', 'legacy done projection must be a boolean');
  }
  const expectedDone = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(state);
  if (row.done !== expectedDone) {
    fail('Operation', row, 'done', 'DONE_STATE_MISMATCH', 'legacy done value disagrees with the target terminal-state projection');
  }
  const business = resolveBusiness('Operation', row, context);
  const pipelineJson = parseJsonField('Operation', row, 'pipelineJson', row.pipelineJson, true);
  const stepsResultJson = parseJsonField('Operation', row, 'stepsResultJson', row.stepsResultJson, false);
  const extractedData = parseJsonField('Operation', row, 'extractedData', row.extractedData, false);
  const usageBreakdown = parseJsonField('Operation', row, 'usageBreakdown', row.usageBreakdown, false);
  const filesJson = parseJsonField('Operation', row, 'filesJson', row.filesJson, false);
  if (filesJson !== null && (!Array.isArray(filesJson) || filesJson.length !== 0)) {
    fail('Operation', row, 'filesJson', 'FILE_REFERENCE_MAPPING_REQUIRED', 'non-empty legacy file references need a separately verified artifact map');
  }
  if (row.webhookUrl !== null && row.webhookUrl !== undefined && row.webhookUrl !== '') {
    fail('Operation', row, 'webhookUrl', 'CALLBACK_POLICY_UNRESOLVED', 'LDBA-01 L3 requires a separate semantic decision');
  }
  if (row.webhookSentAt !== null && row.webhookSentAt !== undefined) {
    fail('Operation', row, 'webhookSentAt', 'CALLBACK_POLICY_UNRESOLVED', 'legacy delivery timestamp has no complete delivery row mapping');
  }
  if (row.filesDeleted === true) {
    fail('Operation', row, 'filesDeleted', 'FILE_DELETE_POLICY_UNRESOLVED', 'legacy file deletion flag has no target field');
  }
  if (row.createdByUserId !== null && row.createdByUserId !== undefined) {
    addOmission(report, 'Operation', row, 'createdByUserId', 'no persisted target field; per-user operation scoping is a documented behavior loss');
  }
  if (row.idempotencyKey !== null && row.idempotencyKey !== undefined && row.idempotencyKey !== '') {
    addOmission(report, 'Operation', row, 'idempotencyKey', 'not enough source values to reconstruct submission_keys safely');
  }
  addOmission(report, 'Operation', row, 'done', 'target compatibility projection derives done from terminal state');
  const createdAt = timestampUtc('Operation', row, 'createdAt', row.createdAt);
  const updatedAt = timestampUtc('Operation', row, 'updatedAt', row.updatedAt);
  const deletedAt = row.deletedAt === null || row.deletedAt === undefined
    ? null
    : timestampUtc('Operation', row, 'deletedAt', row.deletedAt);
  const target = {
    id,
    tenant_id: tenantId,
    api_key_id: apiKeyId,
    business_id: business.businessId,
    business_version: business.businessVersion,
    action: business.action,
    state,
    state_version: 1,
    error_code: row.errorCode ?? null,
    correlation_id: 'legacy-operation:' + id,
    created_at: createdAt,
    updated_at: updatedAt,
    pipeline_json: pipelineJson,
    steps_result_json: stepsResultJson,
    current_step: integer('Operation', row, 'currentStep', row.currentStep, false),
    progress_percent: integer('Operation', row, 'progressPercent', row.progressPercent, false),
    progress_message: row.progressMessage ?? null,
    endpoint_slug: row.endpointSlug,
    output_format: row.outputFormat,
    output_content: row.outputContent ?? null,
    extracted_data: extractedData,
    output_file_path: row.outputFilePath ?? null,
    total_input_tokens: integer('Operation', row, 'totalInputTokens', row.totalInputTokens, false),
    total_output_tokens: integer('Operation', row, 'totalOutputTokens', row.totalOutputTokens, false),
    pages_processed: integer('Operation', row, 'pagesProcessed', row.pagesProcessed, false),
    model_used: row.modelUsed ?? null,
    total_cost_usd: decimalUsd('Operation', row, 'totalCostUsd', row.totalCostUsd),
    usage_breakdown: usageBreakdown,
    error_message: row.errorMessage ?? null,
    failed_at_step: integer('Operation', row, 'failedAtStep', row.failedAtStep, true),
    deleted_at: deletedAt,
  };
  return [write('operations', id, target, 'Operation', row)];
}

function mapApiKey(row, report, tenantId) {
  const id = uuid('ApiKey', row, 'id', row.id);
  const createdAt = timestampUtc('ApiKey', row, 'createdAt', row.createdAt);
  const updatedAt = timestampUtc('ApiKey', row, 'updatedAt', row.updatedAt);
  addOmission(report, 'ApiKey', row, 'role', 'rework api_keys has no role consumer');
  addOmission(report, 'ApiKey', row, 'note', 'rework api_keys has no note consumer');
  const target = {
    id,
    tenant_id: tenantId,
    hash: requireText('ApiKey', row, 'keyHash', row.keyHash),
    prefix: requireText('ApiKey', row, 'prefix', row.prefix),
    status: mapValue('ApiKey', row, 'status', row.status, API_KEY_STATUS),
    created_at: createdAt,
    updated_at: updatedAt,
    name: requireText('ApiKey', row, 'name', row.name),
    spending_limit: decimalRequired('ApiKey', row, 'spendingLimit', row.spendingLimit),
    total_used: decimalRequired('ApiKey', row, 'totalUsed', row.totalUsed),
  };
  return [write('api_keys', id, target, 'ApiKey', row)];
}

async function mapConnector(row, context, report) {
  const connectorId = requireText('ExternalApiConnection', row, 'id', row.id);
  const state = mapValue('ExternalApiConnection', row, 'state', row.state, CONNECTOR_STATE);
  const config = {
    name: requireText('ExternalApiConnection', row, 'name', row.name),
    slug: requireText('ExternalApiConnection', row, 'slug', row.slug),
    description: row.description ?? null,
    endpointUrl: requireText('ExternalApiConnection', row, 'endpointUrl', row.endpointUrl),
    httpMethod: row.httpMethod,
    authType: row.authType,
    authKeyHeader: row.authKeyHeader,
    promptFieldName: row.promptFieldName,
    fileFieldName: row.fileFieldName,
    fileUrlFieldName: row.fileUrlFieldName ?? null,
    defaultPrompt: row.defaultPrompt,
    staticFormFields: parseJsonField('ExternalApiConnection', row, 'staticFormFields', row.staticFormFields, false),
    extraHeaders: parseJsonField('ExternalApiConnection', row, 'extraHeaders', row.extraHeaders, false),
    responseContentPath: row.responseContentPath ?? null,
    sessionIdResponsePath: row.sessionIdResponsePath ?? null,
    sessionIdFieldName: row.sessionIdFieldName ?? null,
    timeoutSec: integer('ExternalApiConnection', row, 'timeoutSec', row.timeoutSec, false),
  };
  const authSecret = requireText('ExternalApiConnection', row, 'authSecret', row.authSecret);
  if (typeof context.prepareConnector !== 'function') {
    fail('ExternalApiConnection', row, 'authSecret', 'CONNECTOR_ADAPTER_REQUIRED', 'LDBA-05 must provide approved secret and tenant binding transforms');
  }
  const prepared = await context.prepareConnector(row, {
    connectorId,
    revisionNumber: 1,
    state,
    config,
    createdAt: timestampUtc('ExternalApiConnection', row, 'createdAt', row.createdAt),
  });
  if (isPlainObject(prepared) && prepared.skipped === true) {
    if (typeof prepared.reason !== 'string' || prepared.reason.length === 0) {
      fail('ExternalApiConnection', row, 'authType', 'INVALID_CONNECTOR_ADAPTER_OUTPUT', 'connector skip must include a non-empty reason');
    }
    skip(
      'ExternalApiConnection',
      row,
      'authType',
      typeof prepared.code === 'string' ? prepared.code : '<missing>',
      prepared.reason,
    );
  }
  if (!isPlainObject(prepared) || !isPlainObject(prepared.revision) || !isPlainObject(prepared.secret)) {
    fail('ExternalApiConnection', row, 'authSecret', 'INVALID_CONNECTOR_ADAPTER_OUTPUT', 'connector adapter must return a revision and secret row');
  }
  const revision = prepared.revision;
  const secret = prepared.secret;
  if (
    revision.connector_id !== connectorId ||
    revision.revision !== 1 ||
    revision.state !== state ||
    typeof revision.tenant_id !== 'string' ||
    typeof revision.credential_ref !== 'string' ||
    !revision.credential_ref ||
    !isPlainObject(revision.config) ||
    !isPlainObject(revision.credential_source)
  ) {
    fail('ExternalApiConnection', row, 'id', 'INVALID_CONNECTOR_ADAPTER_OUTPUT', 'connector revision identity or required fields differ');
  }
  if (JSON.stringify(revision.config).includes(authSecret)) {
    fail('ExternalApiConnection', row, 'authSecret', 'PLAINTEXT_SECRET', 'connector config must not contain the source secret');
  }
  if (
    typeof secret.id !== 'string' ||
    !secret.id ||
    secret.credential_ref !== revision.credential_ref ||
    !(Buffer.isBuffer(secret.encrypted_value) || secret.encrypted_value instanceof Uint8Array) ||
    secret.encrypted_value.length === 0
  ) {
    fail('ExternalApiConnection', row, 'authSecret', 'INVALID_SECRET_ADAPTER_OUTPUT', 'secret version must retain text identity and contain ciphertext bytes');
  }
  const plainSecret = Buffer.from(String(row.authSecret), 'utf8');
  if (Buffer.from(secret.encrypted_value).equals(plainSecret)) {
    fail('ExternalApiConnection', row, 'authSecret', 'PLAINTEXT_SECRET', 'secret adapter returned plaintext bytes');
  }
  if (revision.tenant_id !== '') {
    fail('ExternalApiConnection', row, 'tenant_id', 'CONNECTOR_TENANT_CONFLICT', 'legacy connector revision must remain unbound with an empty tenant id');
  }
  if (
    revision.credential_source.kind !== 'legacy-db' ||
    revision.credential_source.credentialRef !== revision.credential_ref ||
    (revision.account_id !== null && revision.account_id !== undefined)
  ) {
    fail('ExternalApiConnection', row, 'credential_source', 'CONNECTOR_BINDING_POLICY_REQUIRED', 'legacy connector revision must retain the legacy-db credential reference without an account binding');
  }
  addOmission(report, 'ExternalApiConnection', row, 'updatedAt', 'connector_revisions has no updated_at destination');
  const connectorKey = connectorId + '|' + revision.tenant_id + '|1';
  return [
    write('connector_revisions', connectorKey, revision, 'ExternalApiConnection', row),
    write('secret_versions', secret.id, secret, 'ExternalApiConnection', row),
  ];
}

function mapOverride(row, report, tenantId) {
  const id = uuid('ExternalApiOverride', row, 'id', row.id);
  if (skippedSourceKey(report, 'ExternalApiConnection', row.connectionId)) {
    skip('ExternalApiOverride', row, 'connectionId', 'OVERRIDE_CONNECTOR_NOT_MIGRATED', 'referenced connector was intentionally skipped in this run');
  }
  if (typeof row.connectionId !== 'string' || !UUID_PATTERN.test(row.connectionId)) {
    skip('ExternalApiOverride', row, 'connectionId', 'OVERRIDE_CONNECTION_ID_NOT_UUID', 'target override requires a UUID connector identity');
  }
  if (typeof row.apiKeyId !== 'string' || !UUID_PATTERN.test(row.apiKeyId)) {
    skip('ExternalApiOverride', row, 'apiKeyId', 'OVERRIDE_API_KEY_ID_NOT_UUID', 'target override requires a UUID API key identity');
  }
  const connectionId = uuid('ExternalApiOverride', row, 'connectionId', row.connectionId);
  const apiKeyId = uuid('ExternalApiOverride', row, 'apiKeyId', row.apiKeyId);
  const createdAt = timestampUtc('ExternalApiOverride', row, 'createdAt', row.createdAt);
  const updatedAt = timestampUtc('ExternalApiOverride', row, 'updatedAt', row.updatedAt);
  const target = {
    id,
    tenant_id: tenantId,
    connection_id: connectionId,
    api_key_id: apiKeyId,
    endpoint_slug: requireText('ExternalApiOverride', row, 'endpointSlug', row.endpointSlug),
    step_id: requireText('ExternalApiOverride', row, 'stepId', row.stepId),
    prompt_override: row.promptOverride ?? null,
    is_active: true,
    created_at: createdAt,
    updated_at: updatedAt,
  };
  const key = [connectionId, apiKeyId, target.endpoint_slug, target.step_id].join('|');
  return [write('connector_prompt_overrides', key, target, 'ExternalApiOverride', row)];
}

function mapProfile(row, context, report, tenantId) {
  const id = uuid('ProfileEndpoint', row, 'id', row.id);
  const apiKeyId = uuid('ProfileEndpoint', row, 'apiKeyId', row.apiKeyId);
  const business = resolveBusiness('ProfileEndpoint', row, context);
  if (typeof context.resolveProfileName !== 'function') {
    fail('ProfileEndpoint', row, 'endpointSlug', 'PROFILE_NAME_POLICY_REQUIRED', 'profile name must come from an approved mapping');
  }
  if (typeof context.normalizeConnectionsOverride !== 'function') {
    fail('ProfileEndpoint', row, 'connectionsOverride', 'CONNECTION_NORMALIZER_REQUIRED', 'existing legacy connection-step normalizer is required');
  }
  const profileName = context.resolveProfileName(row);
  if (typeof profileName !== 'string' || !profileName) {
    fail('ProfileEndpoint', row, 'endpointSlug', 'INVALID_PROFILE_NAME', 'profile name policy returned no name');
  }
  const parametersRaw = parseJsonField('ProfileEndpoint', row, 'parameters', row.parameters, false);
  const overrideRaw = parseJsonField('ProfileEndpoint', row, 'connectionsOverride', row.connectionsOverride, false);
  const connectionsOverride = context.normalizeConnectionsOverride(overrideRaw);
  if (!Array.isArray(connectionsOverride)) {
    fail('ProfileEndpoint', row, 'connectionsOverride', 'INVALID_CONNECTION_OVERRIDE', 'normalizer must return a connection-step array');
  }
  const parameters = parametersRaw === null ? {} : parametersRaw;
  if (!isPlainObject(parameters)) {
    fail('ProfileEndpoint', row, 'parameters', 'INVALID_PARAMETERS', 'parameters must be an object');
  }
  const priority = mapValue('ProfileEndpoint', row, 'jobPriority', row.jobPriority, {
    LOW: 'LOW',
    MEDIUM: 'MEDIUM',
    HIGH: 'HIGH',
  });
  const createdAt = timestampUtc('ProfileEndpoint', row, 'createdAt', row.createdAt);
  const cipher = parseFileUrlAuthCipher('ProfileEndpoint', row, row.fileUrlAuthConfig);
  const binding = {
    profile_id: id,
    revision: 1,
    tenant_id: tenantId,
    api_key_id: apiKeyId,
    business_id: business.businessId,
    business_version: business.businessVersion,
    action: business.action,
    connector_bindings: {},
    created_at: createdAt,
    enabled: row.enabled,
    parameters,
    job_priority: priority,
    allowed_file_extensions: row.allowedFileExtensions ?? '',
    file_url_auth_cipher: cipher,
    connections_override: connectionsOverride,
  };
  if (typeof row.enabled !== 'boolean') {
    fail('ProfileEndpoint', row, 'enabled', 'INVALID_BOOLEAN', 'enabled must be a boolean');
  }
  addOmission(report, 'ProfileEndpoint', row, 'updatedAt', 'immutable profile rows have no updated_at destination');
  addOmission(report, 'ProfileEndpoint', row, 'rateLimitPerMin', 'retired by plan section 3.4; no rework consumer');
  addOmission(report, 'ProfileEndpoint', row, 'maxConcurrent', 'retired by plan section 3.4; no rework consumer');
  const nameRow = {
    profile_id: id,
    tenant_id: tenantId,
    api_key_id: apiKeyId,
    business_id: business.businessId,
    business_version: business.businessVersion,
    action: business.action,
    profile_name: profileName,
    created_at: createdAt,
  };
  const activePointer = { profile_id: id, revision: 1 };
  return [
    write('profile_bindings', id + '|1', binding, 'ProfileEndpoint', row),
    write('profile_names', id, nameRow, 'ProfileEndpoint', row),
    write('profile_active_revisions', id, activePointer, 'ProfileEndpoint', row),
  ];
}

function appSettingSlug(row) {
  if (typeof row.key !== 'string' || !row.key.startsWith('wb_schema:')) return null;
  const slug = row.key.slice('wb_schema:'.length);
  return slug.length > 0 ? slug : '';
}

async function mapWorkflowSetting(row, slug, context, report, tenantId) {
  if (typeof context.prepareWorkflowSchema !== 'function') {
    fail('AppSetting', row, 'value', 'WORKFLOW_SCHEMA_ADAPTER_REQUIRED', 'LDBA-06 validator, digest, and sealing adapter is required');
  }
  const parsed = parseJsonField('AppSetting', row, 'value', row.value, true);
  const updatedAt = timestampUtc('AppSetting', row, 'updatedAt', row.updatedAt);
  const prepared = await context.prepareWorkflowSchema(parsed, {
    slug,
    tenantId,
    revision: 1,
  });
  if (
    !isPlainObject(prepared) ||
    typeof prepared.digest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/.test(prepared.digest) ||
    !isPlainObject(prepared.schemaRef)
  ) {
    fail('AppSetting', row, 'value', 'INVALID_WORKFLOW_ADAPTER_OUTPUT', 'workflow adapter must return a canonical digest and sealed object envelope');
  }
  addOmission(report, 'AppSetting', row, 'updatedAt', 'source timestamp selects winner only; target catalog has no updated_at');
  const target = {
    tenant_id: tenantId,
    slug,
    revision: 1,
    digest: prepared.digest,
    schema_ref: prepared.schemaRef,
    status: 'active',
  };
  return [write('legacy_workflow_schemas', [tenantId, slug, 1].join('|'), target, 'AppSetting', row)];
}

async function mapFileCache(row, context, report, tenantId) {
  const id = uuid('FileCache', row, 'id', row.id);
  const md5Hash = requireText('FileCache', row, 'md5Hash', row.md5Hash);
  if (!/^[0-9a-fA-F]{32}$/.test(md5Hash)) {
    fail('FileCache', row, 'md5Hash', 'INVALID_MD5', 'expected a 32-character hexadecimal MD5');
  }
  const size = integer('FileCache', row, 'size', row.size, false);
  if (size < 0) fail('FileCache', row, 'size', 'INVALID_SIZE', 'artifact byte size cannot be negative');
  const s3Key = requireText('FileCache', row, 's3Key', row.s3Key);
  if (typeof context.readFileCacheBytes !== 'function') {
    fail('FileCache', row, 's3Key', 'ARTIFACT_READER_REQUIRED', 'approved source object reader is required; metadata alone cannot reproduce bytes');
  }
  if (typeof context.artifactTokenFor !== 'function' || typeof context.artifactPurposeFor !== 'function') {
    fail('FileCache', row, 'id', 'ARTIFACT_POLICY_REQUIRED', 'deterministic token and artifact purpose policies are required');
  }
  const bytes = await context.readFileCacheBytes(s3Key);
  if (!(Buffer.isBuffer(bytes) || bytes instanceof Uint8Array)) {
    fail('FileCache', row, 's3Key', 'INVALID_ARTIFACT_BYTES', 'source object reader must return bytes');
  }
  const body = Buffer.from(bytes);
  if (body.length !== size) {
    fail('FileCache', row, 'size', 'ARTIFACT_SIZE_MISMATCH', 'source byte count differs from legacy metadata');
  }
  const actualMd5 = crypto.createHash('md5').update(body).digest('hex');
  if (actualMd5.toLowerCase() !== md5Hash.toLowerCase()) {
    fail('FileCache', row, 'md5Hash', 'ARTIFACT_MD5_MISMATCH', 'source bytes do not match the legacy content digest');
  }
  const token = context.artifactTokenFor(row, id);
  const purpose = context.artifactPurposeFor(row);
  if (typeof token !== 'string' || token.length < 32) {
    fail('FileCache', row, 'id', 'INVALID_ARTIFACT_TOKEN', 'artifact token policy must return at least 32 characters');
  }
  if (!['input', 'output', 'intermediate', 'session'].includes(purpose)) {
    fail('FileCache', row, 'id', 'INVALID_ARTIFACT_PURPOSE', 'artifact purpose is outside the target vocabulary');
  }
  const storageKey = 'legacy-filecache/' + id;
  const createdAt = timestampUtc('FileCache', row, 'createdAt', row.createdAt);
  const target = {
    id,
    tenant_id: tenantId,
    operation_id: null,
    task_id: null,
    purpose,
    mime_type: requireText('FileCache', row, 'mimeType', row.mimeType),
    size_bytes: size,
    file_name: requireText('FileCache', row, 'fileName', row.fileName),
    sha256: crypto.createHash('sha256').update(body).digest('hex'),
    state: 'READY',
    token,
    storage_key: storageKey,
    expires_at: null,
    created_at: createdAt,
    storage_backend: 'postgres',
    storage_version_id: null,
  };
  addOmission(report, 'FileCache', row, 'refCount', 'no target owner or reference count exists; source count is not copied');
  addOmission(report, 'FileCache', row, 'lastAccessedAt', 'no target timestamp column exists');
  return [
    write('artifacts', id, target, 'FileCache', row),
    write('artifact_blobs', storageKey, { storage_key: storageKey, bytes: body }, 'FileCache', row),
  ];
}

function mapUser(row, context, report, tenantId) {
  const id = uuid('User', row, 'id', row.id);
  const username = requireText('User', row, 'username', row.username).toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,63}$/.test(username)) {
    fail('User', row, 'username', 'INVALID_USERNAME', 'normalized username is outside the target CHECK');
  }
  const role = mapValue('User', row, 'role', row.role, USER_ROLE);
  if (typeof context.prepareAdminLocalUser !== 'function') {
    fail('User', row, 'password', 'IDENTITY_ADAPTER_REQUIRED', 'LDBA-04 must define the reset or first-login bcrypt transition');
  }
  let auth;
  try {
    auth = context.prepareAdminLocalUser(row, { username, role, tenantId });
  } catch (error) {
    if (error && error.code === 'PASSWORD_RESET_REQUIRED') {
      skip(
        'User',
        row,
        'password',
        'IDENTITY_PENDING_REHASH',
        String(error.message || 'identity requires user-presented plaintext before target scrypt hashing'),
      );
    }
    throw error;
  }
  if (isPlainObject(auth) && auth.pending === true) {
    if (typeof auth.reason !== 'string' || auth.reason.length === 0) {
      fail('User', row, 'password', 'INVALID_IDENTITY_ADAPTER_OUTPUT', 'pending identity result must include a non-empty reason');
    }
    skip('User', row, 'password', 'IDENTITY_PENDING_REHASH', auth.reason);
  }
  if (
    !isPlainObject(auth) ||
    typeof auth.password_hash !== 'string' ||
    !SCRYPT_HASH.test(auth.password_hash) ||
    typeof auth.is_enabled !== 'boolean'
  ) {
    fail('User', row, 'password', 'INVALID_IDENTITY_ADAPTER_OUTPUT', 'identity adapter must return a scrypt hash and explicit enabled state');
  }
  addOmission(report, 'User', row, 'provider/providerSub/email/displayName', 'target local-user table has no columns for legacy external identity metadata');
  const target = {
    id,
    tenant_id: tenantId,
    username_normalized: username,
    password_hash: auth.password_hash,
    role,
    is_enabled: auth.is_enabled,
    is_locked: auth.is_locked === true,
    created_at: timestampUtc('User', row, 'createdAt', row.createdAt),
    updated_at: timestampUtc('User', row, 'updatedAt', row.updatedAt),
    version: 1,
  };
  return [write('admin_local_users', id, target, 'User', row)];
}

function mapAssignment(row, report) {
  if (skippedSourceKey(report, 'User', row.userId)) {
    skip('UserProfileAssignment', row, 'userId', 'ASSIGNMENT_USER_NOT_MIGRATED', 'referenced user was intentionally skipped in this run');
  }
  if (typeof row.userId !== 'string' || !UUID_PATTERN.test(row.userId)) {
    skip('UserProfileAssignment', row, 'userId', 'ASSIGNMENT_USER_ID_NOT_UUID', 'target assignment requires a UUID user identity');
  }
  if (typeof row.apiKeyId !== 'string' || !UUID_PATTERN.test(row.apiKeyId)) {
    skip('UserProfileAssignment', row, 'apiKeyId', 'ASSIGNMENT_API_KEY_ID_NOT_UUID', 'target assignment requires a UUID API key identity');
  }
  const userId = uuid('UserProfileAssignment', row, 'userId', row.userId);
  const apiKeyId = uuid('UserProfileAssignment', row, 'apiKeyId', row.apiKeyId);
  uuid('UserProfileAssignment', row, 'id', row.id);
  const grantedAt = timestampUtc('UserProfileAssignment', row, 'createdAt', row.createdAt);
  const key = userId + '|' + apiKeyId;
  return [write('user_profile_assignments', key, {
    user_id: userId,
    api_key_id: apiKeyId,
    granted_at: grantedAt,
  }, 'UserProfileAssignment', row)];
}

function emptyReport() {
  const report = {
    status: 'PREFLIGHT',
    tenant: { name: TENANT_KEY, id: null, status: 'unresolved', seeded: false },
    sourceRows: { read: 0, written: 0, skipped: 0, failed: 0 },
    destinationRows: { planned: 0, written: 0, skipped: 0 },
    perTable: Object.fromEntries(LEGACY_TABLES.map((table) => [table, {
      read: 0,
      written: 0,
      skipped: 0,
      failed: 0,
    }])),
    failures: [],
    omissions: [],
    skips: [],
    workflowDuplicates: [],
  };
  Object.defineProperty(report, '_skippedSourceKeys', {
    value: new Map(),
    enumerable: false,
  });
  return report;
}

function recordFailure(report, error, table, row) {
  const failure = error instanceof RowFailure
    ? error
    : new RowFailure(table, SOURCE_KEY[table](row), '<row>', 'TRANSFORM_ERROR', String(error && error.message || error));
  report.failures.push({
    table: failure.table,
    sourceKey: failure.sourceKey,
    field: failure.field,
    code: failure.code,
    message: failure.message,
  });
  report.sourceRows.failed += 1;
  report.perTable[failure.table].failed += 1;
}

function selectWorkflowWinners(rows, report) {
  const groups = new Map();
  const selected = [];
  for (const row of rows) {
    const slug = appSettingSlug(row);
    if (slug === null) {
      report.sourceRows.skipped += 1;
      report.perTable.AppSetting.skipped += 1;
      addOmission(report, 'AppSetting', row, 'key/value', 'non-workflow setting is deployment configuration with no generic target');
      continue;
    }
    if (!slug) {
      recordFailure(report, new RowFailure('AppSetting', row.key, 'key', 'EMPTY_WORKFLOW_SLUG', 'workflow schema key has no slug'), 'AppSetting', row);
      continue;
    }
    let timestamp;
    try {
      timestamp = timestampUtc('AppSetting', row, 'updatedAt', row.updatedAt);
    } catch (error) {
      recordFailure(report, error, 'AppSetting', row);
      continue;
    }
    const bucket = groups.get(slug) || [];
    bucket.push({ row, timestamp });
    groups.set(slug, bucket);
  }
  for (const [slug, bucket] of groups) {
    bucket.sort((left, right) => right.timestamp.localeCompare(left.timestamp) || String(left.row.key).localeCompare(String(right.row.key)));
    const winner = bucket[0];
    const latest = bucket.filter((item) => item.timestamp === winner.timestamp);
    if (latest.some((item) => item.row.value !== winner.row.value)) {
      for (const item of latest) {
        recordFailure(report, new RowFailure('AppSetting', item.row.key, 'updatedAt', 'WORKFLOW_SCHEMA_TIE', 'latest rows for this slug have different contents'), 'AppSetting', item.row);
      }
      continue;
    }
    selected.push({ row: winner.row, slug });
    for (const loser of bucket.slice(1)) {
      report.sourceRows.skipped += 1;
      report.perTable.AppSetting.skipped += 1;
      report.workflowDuplicates.push({
        slug,
        winner: String(winner.row.key),
        skipped: String(loser.row.key),
      });
    }
  }
  return selected;
}

function sourceVersionFailure(report, adapter) {
  if (
    adapter.a1Passed !== true ||
    typeof adapter.sourceVersion !== 'string' ||
    !adapter.sourceVersion ||
    adapter.a1SourceVersion !== adapter.sourceVersion
  ) {
    report.status = 'BLOCKED_A1';
    report.failures.push({
      table: '<preflight>',
      sourceKey: '<none>',
      field: 'a1Evidence',
      code: 'A1_NOT_PASSED_FOR_SOURCE_VERSION',
      message: 'A1 evidence must identify the same frozen source version before A2',
    });
    return true;
  }
  return false;
}

async function transform(table, row, context, report, workflowSlug, tenantId) {
  if (table === 'Operation') return mapOperation(row, context, report, tenantId);
  if (table === 'ApiKey') return mapApiKey(row, report, tenantId);
  if (table === 'ExternalApiConnection') return mapConnector(row, context, report);
  if (table === 'ExternalApiOverride') return mapOverride(row, report, tenantId);
  if (table === 'ProfileEndpoint') return mapProfile(row, context, report, tenantId);
  if (table === 'AppSetting') return mapWorkflowSetting(row, workflowSlug, context, report, tenantId);
  if (table === 'FileCache') return mapFileCache(row, context, report, tenantId);
  if (table === 'User') return mapUser(row, context, report, tenantId);
  if (table === 'UserProfileAssignment') return mapAssignment(row, report);
  fail(table, row, '<table>', 'UNSUPPORTED_TABLE', 'no transform is registered for this source table');
}

function stableSerialize(value) {
  if (Buffer.isBuffer(value)) return 'buffer:' + value.toString('hex');
  if (value instanceof Uint8Array) return 'buffer:' + Buffer.from(value).toString('hex');
  if (Array.isArray(value)) return '[' + value.map(stableSerialize).join(',') + ']';
  if (isPlainObject(value)) {
    return '{' + Object.keys(value).sort().map((key) => JSON.stringify(key) + ':' + stableSerialize(value[key])).join(',') + '}';
  }
  return JSON.stringify(value);
}

async function runBackfill(adapter, options = {}) {
  const report = emptyReport();
  const skipPolicy = options.skipPolicy ?? process.env.LDBA_SKIP_POLICY ?? 'report';
  if (skipPolicy !== 'report' && skipPolicy !== 'fail') {
    report.status = 'BLOCKED_SKIP_POLICY_CONFIG';
    report.failures.push({
      table: '<preflight>',
      sourceKey: '<none>',
      field: 'LDBA_SKIP_POLICY',
      code: 'INVALID_SKIP_POLICY',
      message: 'LDBA_SKIP_POLICY must be report or fail',
    });
    return report;
  }
  if (!adapter || !adapter.source || !adapter.sink || !adapter.context) {
    report.status = 'BLOCKED_ADAPTER';
    report.failures.push({
      table: '<preflight>',
      sourceKey: '<none>',
      field: 'adapter',
      code: 'ADAPTER_REQUIRED',
      message: 'source, sink, and transform context are required',
    });
    return report;
  }
  if (sourceVersionFailure(report, adapter)) return report;
  if (typeof adapter.source.scan !== 'function') {
    report.status = 'BLOCKED_ADAPTER';
    report.failures.push({
      table: '<preflight>',
      sourceKey: '<none>',
      field: 'source.scan',
      code: 'ADAPTER_REQUIRED',
      message: 'source adapter must expose scan(table)',
    });
    return report;
  }
  if (
    typeof adapter.sink.inspectImmutable !== 'function' ||
    typeof adapter.sink.validatePlan !== 'function' ||
    typeof adapter.sink.applyImmutableBatch !== 'function' ||
    typeof adapter.sink.resolveTenantIdsByName !== 'function' ||
    (options.apply !== false && typeof adapter.sink.seedTenantByName !== 'function')
  ) {
    report.status = 'BLOCKED_ADAPTER';
    report.failures.push({
      table: '<preflight>',
      sourceKey: '<none>',
      field: 'sink',
      code: 'ADAPTER_REQUIRED',
      message: 'sink must support tenant-name resolution, name-only seed on execute, FK and CHECK preflight, immutable inspection, and one atomic batch apply',
    });
    return report;
  }

  const tables = {};
  for (const table of LEGACY_TABLES) {
    try {
      tables[table] = await adapter.source.scan(table);
      if (!Array.isArray(tables[table])) throw new Error('scan must return an array');
      report.sourceRows.read += tables[table].length;
      report.perTable[table].read += tables[table].length;
    } catch (error) {
      report.status = 'BLOCKED_SOURCE_READ';
      report.failures.push({
        table,
        sourceKey: '<scan>',
        field: '<table>',
        code: 'SOURCE_READ_FAILED',
        message: String(error && error.message || error),
      });
      return report;
    }
  }

  // The sink must resolve every matching name and serialize seed with an advisory lock.
  // Its seed operation inserts only the name column and lets the database generate the UUID.
  let tenantIds;
  try {
    tenantIds = await adapter.sink.resolveTenantIdsByName(TENANT_KEY);
    if (!Array.isArray(tenantIds)) {
      throw Object.assign(new Error('resolveTenantIdsByName must return every matching tenant UUID'), { code: 'INVALID_TENANT_RESOLUTION' });
    }
    if (tenantIds.length > 1) {
      throw Object.assign(new Error('tenant name is not unique in the target; resolve exactly one legacy-default row before A2'), { code: 'DUPLICATE_TENANT_NAME' });
    }
    if (tenantIds.length === 0 && options.apply === false) {
      report.status = 'PREFLIGHT_TENANT_PENDING';
      report.failures.push({
        table: '<target>',
        sourceKey: TENANT_KEY,
        field: 'tenants.name',
        code: 'TENANT_NOT_SEEDED',
        message: 'read-only preflight cannot seed legacy-default; seed by name before preflight',
      });
      return report;
    }
    if (tenantIds.length === 0) {
      await adapter.sink.seedTenantByName(TENANT_KEY);
      report.tenant.seeded = true;
      report.tenant.status = 'seeded';
      report.destinationRows.planned = 1;
      report.destinationRows.written = 1;
      tenantIds = await adapter.sink.resolveTenantIdsByName(TENANT_KEY);
      if (!Array.isArray(tenantIds)) {
        throw Object.assign(new Error('resolveTenantIdsByName must return every matching tenant UUID after seed'), { code: 'INVALID_TENANT_RESOLUTION' });
      }
      if (tenantIds.length > 1) {
        throw Object.assign(new Error('tenant name resolved to multiple rows after name-only seed'), { code: 'DUPLICATE_TENANT_NAME' });
      }
    }
    if (tenantIds.length !== 1 || typeof tenantIds[0] !== 'string' || !UUID_PATTERN.test(tenantIds[0])) {
      throw Object.assign(new Error('runtime lookup by tenant name must resolve exactly one UUID'), { code: 'TENANT_UUID_UNRESOLVED' });
    }
    report.tenant.id = tenantIds[0].toLowerCase();
    if (!report.tenant.seeded) {
      report.tenant.status = 'existing';
      report.destinationRows.skipped = 1;
    }
  } catch (error) {
    report.status = 'BLOCKED_TENANT_RESOLUTION';
    report.failures.push({
      table: '<target>',
      sourceKey: TENANT_KEY,
      field: 'tenants.name',
      code: error && error.code ? String(error.code) : 'TENANT_RESOLUTION_FAILED',
      message: String(error && error.message || error),
    });
    return report;
  }

  const writes = [];
  const sourceGroups = new Map();
  const workflowWinners = selectWorkflowWinners(tables.AppSetting, report);
  const workflowByKey = new Map(workflowWinners.map((item) => [item.row.key, item.slug]));
  const usernameOwners = new Map();
  for (const row of tables.User) {
    if (typeof row.username !== 'string') continue;
    const normalized = row.username.toLowerCase();
    const prior = usernameOwners.get(normalized);
    if (prior !== undefined) {
      recordFailure(report, new RowFailure('User', row.id, 'username', 'USERNAME_COLLISION', 'two source usernames normalize to the same target value; first source id ' + prior), 'User', row);
    } else {
      usernameOwners.set(normalized, String(row.id));
    }
  }
  const collisionIds = new Set(report.failures
    .filter((failure) => failure.code === 'USERNAME_COLLISION')
    .map((failure) => failure.sourceKey));

  for (const table of LEGACY_TABLES) {
    let rows = tables[table];
    if (table === 'AppSetting') rows = workflowWinners.map((item) => item.row);
    for (const row of rows) {
      if (table === 'User' && collisionIds.has(String(row.id))) continue;
      const ref = { table, sourceKey: String(SOURCE_KEY[table](row)) };
      const startingFailures = report.failures.length;
      try {
        const workflowSlug = table === 'AppSetting' ? workflowByKey.get(row.key) : undefined;
        const planned = await transform(table, row, adapter.context, report, workflowSlug, report.tenant.id);
        if (report.failures.length !== startingFailures) continue;
        if (!Array.isArray(planned) || planned.length === 0) {
          report.sourceRows.skipped += 1;
          report.perTable[table].skipped += 1;
          continue;
        }
        sourceGroups.set(table + '|' + ref.sourceKey, { source: ref, writes: planned });
        writes.push(...planned);
      } catch (error) {
        if (error instanceof RowSkip) {
          if (approvedRowSkip(error, table, row)) recordSkip(report, error);
          else recordUnapprovedSkip(report, error, table, row);
        } else {
          recordFailure(report, error, table, row);
        }
      }
    }
  }
  if (report.failures.length > 0) {
    report.status = 'BLOCKED_TRANSFORM';
    return report;
  }
  if (skipPolicy === 'fail' && report.skips.length > 0) {
    report.status = 'BLOCKED_SKIPPED_ROWS';
    return report;
  }

  writes.sort((left, right) =>
    (DESTINATION_ORDER[left.entity] ?? 100) - (DESTINATION_ORDER[right.entity] ?? 100) ||
    left.entity.localeCompare(right.entity) ||
    left.key.localeCompare(right.key));
  report.destinationRows.planned = writes.length + 1;
  let planFailures;
  try {
    planFailures = await adapter.sink.validatePlan(writes);
  } catch (error) {
    report.status = 'BLOCKED_TARGET_PREFLIGHT';
    report.failures.push({
      table: '<target>',
      sourceKey: '<plan>',
      field: '<constraints>',
      code: 'TARGET_CONSTRAINT_PREFLIGHT_FAILED',
      message: String(error && error.message || error),
    });
    return report;
  }
  if (!Array.isArray(planFailures)) {
    report.status = 'BLOCKED_TARGET_PREFLIGHT';
    report.failures.push({
      table: '<target>',
      sourceKey: '<plan>',
      field: '<constraints>',
      code: 'INVALID_CONSTRAINT_PREFLIGHT_RESULT',
      message: 'validatePlan must return an array of row-specific failures',
    });
    return report;
  }
  for (const item of planFailures) {
    report.failures.push({
      table: item.table || '<target>',
      sourceKey: item.sourceKey || '<unknown>',
      field: item.field || '<constraint>',
      code: item.code || 'TARGET_CONSTRAINT_FAILURE',
      message: item.message || 'target constraint validation failed',
    });
    report.sourceRows.failed += 1;
    if (report.perTable[item.table]) report.perTable[item.table].failed += 1;
  }
  if (report.failures.length > 0) {
    report.status = 'BLOCKED_TARGET_CONFLICT';
    return report;
  }

  const preflight = [];
  for (const item of writes) {
    let result;
    try {
      result = await adapter.sink.inspectImmutable(item);
    } catch (error) {
      report.status = 'BLOCKED_TARGET_PREFLIGHT';
      report.failures.push({
        table: item.source.table,
        sourceKey: item.source.sourceKey,
        field: item.entity,
        code: 'TARGET_PREFLIGHT_FAILED',
        message: String(error && error.message || error),
      });
      report.sourceRows.failed += 1;
      if (report.perTable[item.source.table]) report.perTable[item.source.table].failed += 1;
      return report;
    }
    if (!['new', 'identical', 'conflict'].includes(result)) {
      report.status = 'BLOCKED_TARGET_PREFLIGHT';
      report.failures.push({
        table: item.source.table,
        sourceKey: item.source.sourceKey,
        field: item.entity,
        code: 'INVALID_TARGET_PREFLIGHT_RESULT',
        message: 'inspectImmutable must return new, identical, or conflict',
      });
      return report;
    }
    preflight.push({ item, result });
    if (result === 'conflict') {
      report.failures.push({
        table: item.source.table,
        sourceKey: item.source.sourceKey,
        field: item.entity,
        code: 'IMMUTABLE_TARGET_CONFLICT',
        message: 'target natural key exists with different content; existing row is never overwritten',
      });
    }
  }
  if (report.failures.length > 0) {
    report.status = 'BLOCKED_TARGET_CONFLICT';
    report.sourceRows.failed += report.failures.filter((failure) => failure.code === 'IMMUTABLE_TARGET_CONFLICT').length;
    for (const failure of report.failures.filter((item) => item.code === 'IMMUTABLE_TARGET_CONFLICT')) {
      if (report.perTable[failure.table]) report.perTable[failure.table].failed += 1;
    }
    return report;
  }

  report.preflight = preflight.map(({ item, result }) => ({
    entity: item.entity,
    key: item.key,
    result,
  }));
  if (options.apply === false) {
    report.status = 'PREFLIGHT_READY';
    return report;
  }

  let applied;
  try {
    applied = await adapter.sink.applyImmutableBatch(writes);
  } catch (error) {
    report.status = 'BLOCKED_TARGET_WRITE';
    const failedWrite = error && error.write;
    const table = failedWrite && failedWrite.source ? failedWrite.source.table : '<target>';
    const sourceKey = failedWrite && failedWrite.source ? failedWrite.source.sourceKey : '<batch>';
    report.failures.push({
      table,
      sourceKey,
      field: failedWrite ? failedWrite.entity : '<transaction>',
      code: error && error.code ? String(error.code) : 'ATOMIC_BATCH_FAILED',
      message: String(error && error.message || error),
    });
    report.sourceRows.failed += 1;
    if (report.perTable[table]) report.perTable[table].failed += 1;
    return report;
  }
  if (!Array.isArray(applied) || applied.length !== writes.length) {
    report.status = 'BLOCKED_TARGET_WRITE';
    report.failures.push({
      table: '<target>',
      sourceKey: '<batch>',
      field: '<transaction>',
      code: 'INVALID_BATCH_RESULT',
      message: 'atomic batch result length must match planned destination rows',
    });
    return report;
  }
  const outcomesBySource = new Map();
  for (let index = 0; index < writes.length; index += 1) {
    const outcome = applied[index];
    if (outcome !== 'inserted' && outcome !== 'identical') {
      report.status = 'BLOCKED_TARGET_WRITE';
      report.failures.push({
        table: writes[index].source.table,
        sourceKey: writes[index].source.sourceKey,
        field: writes[index].entity,
        code: 'INVALID_BATCH_OUTCOME',
        message: 'atomic batch outcomes must be inserted or identical',
      });
      return report;
    }
    if (outcome === 'inserted') report.destinationRows.written += 1;
    else report.destinationRows.skipped += 1;
    const source = writes[index].source;
    if (source.table === '<derived>') continue;
    const sourceKey = source.table + '|' + source.sourceKey;
    const existing = outcomesBySource.get(sourceKey) || { inserted: 0, identical: 0 };
    existing[outcome] += 1;
    outcomesBySource.set(sourceKey, existing);
  }
  for (const [key, outcome] of outcomesBySource) {
    const group = sourceGroups.get(key);
    if (!group) continue;
    if (outcome.inserted > 0) {
      report.sourceRows.written += 1;
      report.perTable[group.source.table].written += 1;
    } else {
      report.sourceRows.skipped += 1;
      report.perTable[group.source.table].skipped += 1;
    }
  }
  report.status = 'APPLIED';
  return report;
}

async function runCli() {
  const mode = process.argv[2];
  if (mode !== '--preflight' && mode !== '--execute') {
    process.stderr.write('Refusing to run without --preflight or --execute after A1 approval.\n');
    process.exitCode = 2;
    return;
  }
  if (process.env.LDBA_A1_PASSED !== '1') {
    process.stderr.write('Refusing A2: LDBA_A1_PASSED must equal 1.\n');
    process.exitCode = 2;
    return;
  }
  const skipPolicy = process.env.LDBA_SKIP_POLICY ?? 'report';
  if (skipPolicy !== 'report' && skipPolicy !== 'fail') {
    process.stderr.write('Refusing A2: LDBA_SKIP_POLICY must be report or fail.\n');
    process.exitCode = 2;
    return;
  }
  const adapterPath = process.env.LDBA03_ADAPTER_MODULE;
  if (!adapterPath) {
    process.stderr.write('Refusing A2: LDBA03_ADAPTER_MODULE is required.\n');
    process.exitCode = 2;
    return;
  }
  const adapter = require(path.resolve(adapterPath));
  const report = await runBackfill(adapter, { apply: mode === '--execute', skipPolicy });
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.status !== 'APPLIED') process.exitCode = 1;
  if (mode === '--preflight' && report.status === 'PREFLIGHT_READY') process.exitCode = 0;
}

if (require.main === module) {
  runCli().catch((error) => {
    process.stderr.write(String(error && error.message || error) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  API_KEY_STATUS,
  CONNECTOR_STATE,
  JSON_EXCEPTIONS,
  JSON_FIELDS,
  LEGACY_TABLES,
  OPERATION_STATE,
  RowFailure,
  RowSkip,
  SKIP_POLICIES,
  USER_ROLE,
  decimalUsd,
  parseFileUrlAuthCipher,
  parseJsonField,
  runBackfill,
  timestampUtc,
  uuid,
};
