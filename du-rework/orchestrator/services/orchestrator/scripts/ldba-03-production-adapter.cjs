'use strict';

const path = require('node:path');
const fs = require('node:fs');
const { createHash, createDecipheriv, timingSafeEqual } = require('node:crypto');

const REQUIRED_CONTEXT_CALLBACKS = Object.freeze([
  'prepareConnector',
  'resolveProfileName',
  'normalizeConnectionsOverride',
  'prepareWorkflowSchema',
  'readFileCacheBytes',
  'artifactTokenFor',
  'artifactPurposeFor',
]);

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

const SOURCE_KEYS = Object.freeze({
  Operation: 'id',
  ApiKey: 'id',
  ExternalApiConnection: 'id',
  ExternalApiOverride: 'id',
  ProfileEndpoint: 'id',
  AppSetting: 'key',
  FileCache: 'id',
  User: 'id',
  UserProfileAssignment: 'id',
});

const TIMESTAMP_FIELDS = new Set([
  'createdAt',
  'updatedAt',
  'deletedAt',
  'webhookSentAt',
  'lastAccessedAt',
  'expiresAt',
]);

const JSON_TEXT_FIELDS = new Set([
  'pipelineJson',
  'stepsResultJson',
  'extractedData',
  'usageBreakdown',
  'filesJson',
  'parameters',
  'connectionsOverride',
  'staticFormFields',
  'extraHeaders',
]);

const DECIMAL_FIELDS = new Set(['totalCostUsd', 'spendingLimit', 'totalUsed']);

const ENTITY_SPECS = Object.freeze({
  api_keys: { key: ['id'] },
  connector_revisions: { key: ['connector_id', 'tenant_id', 'revision'] },
  secret_versions: { key: ['id'] },
  profile_bindings: { key: ['profile_id', 'revision'] },
  profile_active_revisions: { key: ['profile_id'] },
  profile_names: { key: ['profile_id'] },
  profile_api_keys: { key: ['profile_id', 'api_key_id'] },
  operations: { key: ['id'] },
  connector_prompt_overrides: {
    key: ['connection_id', 'api_key_id', 'endpoint_slug', 'step_id'],
  },
  artifacts: { key: ['id'] },
  artifact_blobs: { key: ['storage_key'] },
  admin_local_users: { key: ['id'] },
  user_profile_assignments: { key: ['user_id', 'api_key_id'] },
  legacy_workflow_schemas: { key: ['tenant_id', 'slug', 'revision'] },
  legacy_app_settings: { key: ['tenant_id', 'key'] },
});

const JSONB_COLUMNS = Object.freeze({
  admin_local_users: new Set(['legacy_identity_metadata']),
  connector_revisions: new Set(['config', 'credential_source']),
  profile_bindings: new Set([
    'connector_bindings',
    'parameters',
    'connections_override',
    'callback_policy',
    'profile_policy_snapshot',
    'request_redaction',
  ]),
  operations: new Set([
    'legacy_history',
    'input_ref',
    'connector_bindings',
    'pipeline_json',
    'steps_result_json',
    'extracted_data',
    'usage_breakdown',
    'submit_artifacts',
    'profile_policy_snapshot',
    'callback_policy',
    'prompt_revisions_pin',
    'prompt_overrides_ref',
  ]),
  connector_prompt_overrides: new Set(['prompt_overrides_ref']),
  legacy_workflow_schemas: new Set(['schema_ref']),
});

const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_$]*$/;
const QUOTE = String.fromCharCode(34);

class AdapterConfigurationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdapterConfigurationError';
    this.code = code;
  }
}

function identifier(value) {
  if (typeof value !== 'string' || !IDENTIFIER.test(value)) {
    throw new AdapterConfigurationError('INVALID_IDENTIFIER', 'database identifier is outside the adapter allowlist');
  }
  return QUOTE + value + QUOTE;
}

function qualifiedIdentifier(schema, name) {
  return identifier(schema) + '.' + identifier(name);
}

function sourceExpression(column, metadata, table) {
  const name = column.column_name;
  const quoted = identifier(name);
  if (TIMESTAMP_FIELDS.has(name)) {
    if (metadata.data_type === 'timestamp with time zone') {
      return `to_char(${quoted} AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS.US') AS ${quoted}`;
    }
    return quoted + '::text AS ' + quoted;
  }
  if (DECIMAL_FIELDS.has(name)) return quoted + '::numeric(20,6)::text AS ' + quoted;
  if (JSON_TEXT_FIELDS.has(name) || metadata.data_type === 'json' || metadata.data_type === 'jsonb') {
    return quoted + '::text AS ' + quoted;
  }
  if (table === 'AppSetting' && name === 'value') return quoted + '::text AS ' + quoted;
  return quoted;
}

function requireContextFunction(provider, name) {
  const candidate = provider && provider[name];
  if (typeof candidate !== 'function') {
    const code = name === 'prepareAdminLocalUser' ? 'PASSWORD_RESET_REQUIRED' : 'CONTEXT_POLICY_REQUIRED';
    const message = name === 'prepareAdminLocalUser'
      ? 'legacy bcrypt cannot become a target scrypt verifier without plaintext at first login'
      : 'approved context policy is not configured for ' + name;
    throw new AdapterConfigurationError(code, message);
  }
  return candidate;
}

function loadContextProvider(env) {
  const configuredPath = env.LDBA03_CONTEXT_MODULE;
  const resolved = configuredPath && configuredPath.trim().length > 0
    ? path.resolve(configuredPath)
    : path.resolve(__dirname, 'ldba-context-provider.cjs');
  let loaded;
  try {
    loaded = require(resolved);
  } catch {
    throw new AdapterConfigurationError(
      'CONTEXT_MODULE_LOAD_FAILED',
      'LDBA03 context provider module could not be loaded',
    );
  }
  const provider = loaded && loaded.default ? loaded.default : loaded;
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) {
    throw new AdapterConfigurationError('INVALID_CONTEXT_MODULE', 'context module must export a policy object');
  }
  if (REQUIRED_CONTEXT_CALLBACKS.some((name) => typeof provider[name] !== 'function')) {
    throw new AdapterConfigurationError(
      'INCOMPLETE_CONTEXT_MODULE',
      'LDBA03 context provider is missing a required callback',
    );
  }
  return provider;
}

function canonicalNumeric(value) {
  if (typeof value !== 'bigint' && typeof value !== 'number' && typeof value !== 'string') return null;
  if (typeof value === 'number' && !Number.isFinite(value)) return null;

  const source = typeof value === 'number' || typeof value === 'bigint' ? String(value) : value;
  const match = /^([+-]?)(?:(\d+)(?:\.(\d*))?|\.(\d+))(?:[eE]([+-]?\d+))?$/.exec(source);
  if (!match) return null;

  const sign = match[1] === '-' ? '-' : '';
  const integer = match[2] || '0';
  const fraction = match[3] === undefined ? (match[4] || '') : match[3];
  const exponent = Number(match[5] || '0');
  if (!Number.isSafeInteger(exponent)) return null;

  let digits = (integer + fraction).replace(/^0+/, '');
  if (!digits) return '0e0';
  let power = exponent - fraction.length;
  const trailingZeros = /0+$/.exec(digits);
  if (trailingZeros) {
    digits = digits.slice(0, -trailingZeros[0].length);
    power += trailingZeros[0].length;
  }
  return sign + digits + 'e' + power;
}

function timestampMilliseconds(value) {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? milliseconds : null;
  }
  if (typeof value !== 'string') return null;
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}:\d{2}:\d{2}(?:\.\d+)?)(Z|[+-]\d{2}:?\d{2})?$/i.exec(value);
  if (!match) return null;
  let zone = match[3] || 'Z';
  if (/^[+-]\d{4}$/.test(zone)) zone = zone.slice(0, 3) + ':' + zone.slice(3);
  const milliseconds = Date.parse(match[1] + 'T' + match[2] + zone);
  return Number.isFinite(milliseconds) ? milliseconds : null;
}

function isComparableContainer(value) {
  return Array.isArray(value) || (value !== null && typeof value === 'object'
    && !(value instanceof Date) && !Buffer.isBuffer(value) && !(value instanceof Uint8Array));
}

function parseJsonContainer(value) {
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isComparableContainer(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeComparable(value, counterpart) {
  const numeric = canonicalNumeric(value);
  if (numeric !== null && canonicalNumeric(counterpart) !== null) return { numeric };

  const timestamp = timestampMilliseconds(value);
  if (timestamp !== null && timestampMilliseconds(counterpart) !== null) {
    return { timestamp_ms: timestamp };
  }

  if (typeof value === 'string' && isComparableContainer(counterpart)) {
    const parsed = parseJsonContainer(value);
    if (parsed !== null) return normalizeComparable(parsed, counterpart);
  }
  if (isComparableContainer(value) && typeof counterpart === 'string') {
    const parsed = parseJsonContainer(counterpart);
    if (parsed !== null) return normalizeComparable(value, parsed);
  }

  if (value instanceof Date) {
    const milliseconds = value.getTime();
    return Number.isFinite(milliseconds) ? { timestamp_ms: milliseconds } : { invalid_date: true };
  }
  if (typeof value === 'bigint') return { bigint: value.toString() };
  if (typeof value === 'number' && !Number.isFinite(value)) return { number: String(value) };
  if (Buffer.isBuffer(value) || value instanceof Uint8Array) {
    return { bytes: Buffer.from(value).toString('hex') };
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => normalizeComparable(
      entry,
      Array.isArray(counterpart) ? counterpart[index] : undefined,
    ));
  }
  if (value && typeof value === 'object') {
    const other = counterpart && typeof counterpart === 'object' && !Array.isArray(counterpart)
      ? counterpart
      : null;
    return Object.fromEntries(Object.keys(value).sort().map((key) => [
      key,
      normalizeComparable(value[key], other && Object.hasOwn(other, key) ? other[key] : undefined),
    ]));
  }
  return value;
}

function sameValue(left, right) {
  return JSON.stringify(normalizeComparable(left, right))
    === JSON.stringify(normalizeComparable(right, left));
}

function ensureWrite(item) {
  if (!item || typeof item !== 'object' || typeof item.entity !== 'string' || typeof item.key !== 'string') {
    throw new AdapterConfigurationError('INVALID_WRITE', 'write item identity is invalid');
  }
  if (!Object.hasOwn(ENTITY_SPECS, item.entity)) {
    throw new AdapterConfigurationError('UNSUPPORTED_ENTITY', 'write entity is outside the runner destination allowlist');
  }
  if (!item.value || typeof item.value !== 'object' || Array.isArray(item.value)) {
    throw new AdapterConfigurationError('INVALID_WRITE', 'write value must be a row object');
  }
  const columns = Object.keys(item.value);
  if (columns.length === 0) throw new AdapterConfigurationError('INVALID_WRITE', 'write value has no columns');
  for (const column of columns) identifier(column);
  for (const keyColumn of ENTITY_SPECS[item.entity].key) {
    if (!Object.hasOwn(item.value, keyColumn)) {
      throw new AdapterConfigurationError('INVALID_WRITE', 'write value is missing its immutable identity column');
    }
  }
  return item;
}

function insertStatement(item, conflictAction) {
  ensureWrite(item);
  const spec = ENTITY_SPECS[item.entity];
  const entries = Object.entries(item.value).filter(([, value]) => value !== undefined);
  const columns = entries.map(([key]) => identifier(key));
  const placeholders = entries.map((_, index) => '$' + (index + 1));
  const jsonbColumns = JSONB_COLUMNS[item.entity];
  const values = entries.map(([column, value]) => (
    jsonbColumns && jsonbColumns.has(column) && Array.isArray(value)
      ? JSON.stringify(value)
      : value
  ));
  const keyColumns = spec.key.map(identifier).join(', ');
  const returning = spec.key.map(identifier).join(', ');
  const sql = 'INSERT INTO ' + identifier(item.entity)
    + ' (' + columns.join(', ') + ') VALUES (' + placeholders.join(', ') + ')'
    + ' ON CONFLICT (' + keyColumns + ') ' + conflictAction
    + ' RETURNING ' + returning;
  return { sql, values };
}

function lookupStatement(item) {
  ensureWrite(item);
  const spec = ENTITY_SPECS[item.entity];
  const where = spec.key.map((column, index) => identifier(column) + ' = $' + (index + 1)).join(' AND ');
  return {
    sql: 'SELECT * FROM ' + identifier(item.entity) + ' WHERE ' + where + ' LIMIT 2',
    values: spec.key.map((column) => item.value[column]),
  };
}

function rowMatches(existing, expected) {
  return Object.entries(expected).every(([key, value]) => sameValue(existing[key], value));
}

function constraintFailure(item, code) {
  return {
    table: item.source && typeof item.source.table === 'string' ? item.source.table : item.entity,
    sourceKey: item.source && typeof item.source.sourceKey === 'string' ? item.source.sourceKey : item.key,
    field: '<target-constraints>',
    code: typeof code === 'string' && /^[0-9A-Z_]{2,32}$/.test(code) ? 'TARGET_' + code : 'TARGET_CONSTRAINT',
    message: 'target constraints rejected the mapped row; values are omitted',
  };
}

async function inTransaction(pool, callback, commit = true) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query(commit ? 'COMMIT' : 'ROLLBACK');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch {
      // Preserve the first database error.
    }
    throw error;
  } finally {
    client.release();
  }
}

function createAdapter(options = {}) {
  const env = options.env || process.env;
  const Pool = options.Pool || require('pg').Pool;
  const sourceConnectionString = options.sourceConnectionString
    || env.LDBA03_SOURCE_DATABASE_URL
    || env.DATABASE_URL;
  const targetConnectionString = options.targetConnectionString
    || env.LDBA03_TARGET_DATABASE_URL
    || env.DATABASE_URL;
  const connectorTargetConnectionString = options.connectorTargetConnectionString
    || env.LDBA03_CONNECTOR_TARGET_DATABASE_URL;
  const sourceSchema = options.sourceSchema || env.LDBA03_SOURCE_SCHEMA || 'public';
  identifier(sourceSchema);

  if (!options.sourcePool && !sourceConnectionString) {
    throw new AdapterConfigurationError('SOURCE_DATABASE_URL_REQUIRED', 'LDBA03_SOURCE_DATABASE_URL or DATABASE_URL is required');
  }
  if (!options.targetPool && !targetConnectionString) {
    throw new AdapterConfigurationError('TARGET_DATABASE_URL_REQUIRED', 'LDBA03_TARGET_DATABASE_URL or DATABASE_URL is required');
  }
  if (!options.connectorTargetPool && !connectorTargetConnectionString) {
    throw new AdapterConfigurationError('CONNECTOR_TARGET_DATABASE_URL_REQUIRED', 'LDBA03_CONNECTOR_TARGET_DATABASE_URL is required for the separate Connector database');
  }

  const sharedPool = options.sourcePool && options.sourcePool === options.targetPool
    ? options.sourcePool
    : null;
  const sourcePool = options.sourcePool || sharedPool || new Pool({
    connectionString: sourceConnectionString,
    application_name: 'ldba03-source-adapter',
    max: 2,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  });
  const targetPool = options.targetPool || sharedPool || new Pool({
    connectionString: targetConnectionString,
    application_name: 'ldba03-target-adapter',
    max: 2,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  });
  const connectorTargetPool = options.connectorTargetPool || new Pool({
    connectionString: connectorTargetConnectionString,
    application_name: 'ldba03-connector-target-adapter',
    max: 2,
    idleTimeoutMillis: 1000,
    allowExitOnIdle: true,
  });
  const provider = options.context || loadContextProvider(env);
  const businessActions = new Map();
  const ambiguousBusinessActions = new Set();
  let businessRegistryLoaded = false;
  let resolvedImportTenant = null;

  if (!sourcePool || !targetPool || !connectorTargetPool) {
    throw new AdapterConfigurationError('DATABASE_POOL_REQUIRED', 'source, Orchestrator target, and Connector target PostgreSQL pools are required');
  }
  if (connectorTargetPool === targetPool) {
    throw new AdapterConfigurationError('TARGET_DATABASES_MUST_DIFFER', 'Orchestrator and Connector targets must use separate PostgreSQL pools');
  }
  if (!options.sourcePool && !sourceConnectionString) {
    throw new AdapterConfigurationError('SOURCE_DATABASE_URL_REQUIRED', 'LDBA03_SOURCE_DATABASE_URL or DATABASE_URL is required');
  }
  if (!options.targetPool && !targetConnectionString) {
    throw new AdapterConfigurationError('TARGET_DATABASE_URL_REQUIRED', 'LDBA03_TARGET_DATABASE_URL or DATABASE_URL is required');
  }

  let frozenTables = null;
  let snapshotPromise = null;
  let verifiedTargetIdentity = null;
  async function readDatabaseIdentity(pool, plane) {
    let result;
    try {
      result = await pool.query(`SELECT current_database() AS database_name,
          d.oid::text AS database_oid,
          (SELECT system_identifier::text FROM pg_control_system()) AS system_identifier
        FROM pg_database d WHERE d.datname = current_database()`);
    } catch {
      throw new AdapterConfigurationError('TARGET_IDENTITY_UNAVAILABLE', 'database cluster and database identity could not be verified for ' + plane);
    }
    const row = result && Array.isArray(result.rows) && result.rows.length === 1 ? result.rows[0] : null;
    if (!row || typeof row.database_name !== 'string' || !row.database_name
        || typeof row.database_oid !== 'string' || !/^\d+$/.test(row.database_oid)
        || typeof row.system_identifier !== 'string' || !/^\d+$/.test(row.system_identifier)) {
      throw new AdapterConfigurationError('TARGET_IDENTITY_INVALID', 'database cluster and database identity are incomplete for ' + plane);
    }
    return { databaseName: row.database_name, databaseOid: row.database_oid, systemIdentifier: row.system_identifier };
  }
  async function assertDistinctTargetDatabases() {
    if (verifiedTargetIdentity) return verifiedTargetIdentity;
    const [orchestrator, connector] = await Promise.all([
      readDatabaseIdentity(targetPool, 'Orchestrator target'),
      readDatabaseIdentity(connectorTargetPool, 'Connector target'),
    ]);
    if (orchestrator.systemIdentifier === connector.systemIdentifier
        && orchestrator.databaseOid === connector.databaseOid) {
      throw new AdapterConfigurationError('TARGET_DATABASES_MUST_DIFFER', 'Orchestrator and Connector target database identities are the same');
    }
    verifiedTargetIdentity = { orchestrator, connector };
    return verifiedTargetIdentity;
  }
  async function assertSnapshotGate(client, plane) {
    const table = plane === 'connector' ? 'connector_backup_effect_gate' : 'maintenance_backup_effect_gate';
    const result = await client.query('SELECT state FROM ' + identifier(table) + ' WHERE singleton_id = 1 FOR SHARE');
    if (!result.rows || result.rows.length !== 1 || result.rows[0].state !== 'OPEN') {
      throw new AdapterConfigurationError('BACKUP_SNAPSHOT_HELD', 'immutable import is blocked by the ' + plane + ' snapshot fence');
    }
  }
  const connectorEntities = new Set(['connector_revisions', 'secret_versions']);
  function planeFor(item) { return connectorEntities.has(item.entity) ? 'connector' : 'orchestrator'; }
  function poolFor(item) { return planeFor(item) === 'connector' ? connectorTargetPool : targetPool; }
  function itemsForPlane(items, plane) { return items.filter((item) => planeFor(item) === plane); }
  function connectorRevisionPinKey(tenantId, connectorId, revision) {
    return JSON.stringify([String(tenantId), String(connectorId), Number(revision)]);
  }
  async function assertProfileConnectorPins(item, validatedPlannedPins) {
    const tenantId = String(item.value.tenant_id);
    for (const pin of Object.values(item.value.connector_bindings || {})) {
      const candidates = new Set();
      const plannedTenantKeys = [tenantId, ''];
      for (const plannedTenantId of plannedTenantKeys) {
        const key = connectorRevisionPinKey(plannedTenantId, pin.connectorId, pin.revision);
        if (validatedPlannedPins.has(key)) candidates.add(plannedTenantId);
      }
      const existing = await connectorTargetPool.query(
        "SELECT tenant_id FROM connector_revisions WHERE tenant_id IN ($1, '') AND connector_id = $2 AND revision = $3",
        [tenantId, pin.connectorId, pin.revision],
      );
      for (const row of existing.rows || []) {
        if (row.tenant_id === tenantId || row.tenant_id === '') candidates.add(row.tenant_id);
      }
      if (candidates.size !== 1) {
        throw new AdapterConfigurationError('CONNECTOR_PIN_NOT_FOUND', 'profile pin must resolve to one validated immutable revision in this tenant');
      }
    }
  }
  async function readFrozenTables() {
    if (typeof sourcePool.connect !== 'function') throw new AdapterConfigurationError('SOURCE_SNAPSHOT_REQUIRED', 'source requires a dedicated repeatable-read connection');
    const client = await sourcePool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const tables = {};
      const limit = Number(env.LDBA03_MAX_ROWS_PER_TABLE || 100000);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000000) throw new AdapterConfigurationError('INVALID_ROW_LIMIT', 'row limit must be 1..1000000');
      for (const name of LEGACY_TABLES) tables[name] = await readTable(name, client, limit);
      await client.query('COMMIT');
      adapter.sourceSnapshot = { sha256: createHash('sha256').update(JSON.stringify(tables)).digest('hex'), rowCounts: Object.fromEntries(LEGACY_TABLES.map((name) => [name, tables[name].length])) };
      verifyTimezoneEvidence(tables);
      return tables;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }
  async function scan(table) {
    if (!Object.hasOwn(SOURCE_KEYS, table)) throw new AdapterConfigurationError('UNSUPPORTED_SOURCE_TABLE', 'source table outside allowlist');
    if (!snapshotPromise) snapshotPromise = readFrozenTables();
    frozenTables = await snapshotPromise;
    return frozenTables[table];
  }
  async function readTable(table, client, limit) {
    if (!Object.hasOwn(SOURCE_KEYS, table)) {
      throw new AdapterConfigurationError('UNSUPPORTED_SOURCE_TABLE', 'source table is outside the nine-table allowlist');
    }
    if (!businessRegistryLoaded) await loadBusinessRegistrySnapshot();
    const metadataResult = await client.query(
      'SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position',
      [sourceSchema, table],
    );
    if (!metadataResult.rows || metadataResult.rows.length === 0) {
      throw new AdapterConfigurationError('SOURCE_TABLE_MISSING', 'an allowlisted legacy source table is missing');
    }
    const columns = metadataResult.rows;
    const key = SOURCE_KEYS[table];
    if (!columns.some((column) => column.column_name === key)) {
      throw new AdapterConfigurationError('SOURCE_KEY_MISSING', 'an allowlisted source table has no runner source key');
    }
    const expressions = columns.map((column) => sourceExpression(column, column, table));
    const sql = 'SELECT ' + expressions.join(', ')
      + ' FROM ' + qualifiedIdentifier(sourceSchema, table)
      + ' ORDER BY ' + identifier(key) + ' LIMIT ' + String(limit + 1);
    const result = await client.query(sql);
    if (!Array.isArray(result.rows)) {
      throw new AdapterConfigurationError('INVALID_SOURCE_RESULT', 'source query did not return a row array');
    }
    if (result.rows.length > limit) throw new AdapterConfigurationError('SOURCE_ROW_LIMIT_EXCEEDED', 'source exceeds bounded import capacity; do not truncate or use deltas');
    return result.rows;
  }

  async function loadBusinessRegistrySnapshot() {
    await assertDistinctTargetDatabases();
    const result = await targetPool.query(
      'SELECT business_id, version, manifest FROM business_versions WHERE status = $1 ORDER BY business_id, version',
      ['ENABLED'],
    );
    for (const row of result.rows) {
      let manifest = row.manifest;
      if (typeof manifest === 'string') {
        try {
          manifest = JSON.parse(manifest);
        } catch {
          continue;
        }
      }
      if (!manifest || !Array.isArray(manifest.actions)) continue;
      for (const action of manifest.actions) {
        if (!action || typeof action.name !== 'string' || action.name.length === 0) continue;
        const entry = {
          businessId: row.business_id,
          businessVersion: row.version,
          action: action.name,
        };
        const prior = businessActions.get(action.name);
        if (prior && !sameValue(prior, entry)) ambiguousBusinessActions.add(action.name);
        else businessActions.set(action.name, entry);
      }
    }
    businessRegistryLoaded = true;
  }

  function artifactTenantMap(writes) {
    const tenants = new Map();
    for (const item of writes) {
      if (item && item.entity === 'artifacts' && item.value
          && typeof item.value.storage_key === 'string'
          && typeof item.value.tenant_id === 'string') {
        tenants.set(item.value.storage_key, item.value.tenant_id);
      }
    }
    return tenants;
  }

  function withArtifactTenant(item, tenants) {
    if (item.entity !== 'artifact_blobs' || Object.hasOwn(item.value, 'tenant_id')) return item;
    const tenantId = tenants.get(item.value.storage_key);
    if (typeof tenantId !== 'string') {
      throw new AdapterConfigurationError('ARTIFACT_TENANT_MISSING', 'artifact blob has no paired artifact row with a resolved tenant');
    }
    return { ...item, value: { ...item.value, tenant_id: tenantId } };
  }

  async function tenantForExistingArtifactBlob(item) {
    if (item.entity !== 'artifact_blobs') return null;
    const result = await targetPool.query(
      'SELECT tenant_id::text AS tenant_id FROM artifacts WHERE storage_key = $1 LIMIT 2',
      [item.value.storage_key],
    );
    if (result.rows.length !== 1 || typeof result.rows[0].tenant_id !== 'string') return null;
    return result.rows[0].tenant_id;
  }

  async function resolveTenantIdsByName(name) {
    await assertDistinctTargetDatabases();
    if (typeof name !== 'string' || name.length === 0) {
      throw new AdapterConfigurationError('INVALID_TENANT_NAME', 'tenant name must be non-empty text');
    }
    const result = await targetPool.query('SELECT id::text AS id FROM tenants WHERE name = $1 ORDER BY id', [name]);
    if (name === 'legacy-default' && result.rows.length === 1) resolvedImportTenant = result.rows[0].id;
    return result.rows.map((row) => row.id);
  }

  async function seedTenantByName(name) {
    await assertDistinctTargetDatabases();
    if (typeof name !== 'string' || name.length === 0) {
      throw new AdapterConfigurationError('INVALID_TENANT_NAME', 'tenant name must be non-empty text');
    }
    return inTransaction(targetPool, async (client) => {
      await assertSnapshotGate(client, 'orchestrator');
      await client.query('SELECT pg_advisory_xact_lock(hashtext($1), hashtext($2))', ['ldba03-tenant-name', name]);
      const found = await client.query('SELECT id::text AS id FROM tenants WHERE name = $1 ORDER BY id', [name]);
      if (found.rows.length > 1) {
        throw new AdapterConfigurationError('DUPLICATE_TENANT_NAME', 'tenant name resolves to multiple target UUIDs');
      }
      if (found.rows.length === 1) return found.rows[0].id;
      const inserted = await client.query('INSERT INTO tenants (name) VALUES ($1) RETURNING id::text AS id', [name]);
      if (!inserted.rows || inserted.rows.length !== 1 || typeof inserted.rows[0].id !== 'string') {
        throw new AdapterConfigurationError('TENANT_SEED_FAILED', 'name-only tenant seed did not return one generated UUID');
      }
      return inserted.rows[0].id;
    });
  }

  async function inspectImmutable(item) {
    await assertDistinctTargetDatabases();
    ensureWrite(item);
    const query = lookupStatement(item);
    const result = await poolFor(item).query(query.sql, query.values);
    if (result.rows.length === 0) return 'new';
    if (result.rows.length !== 1) return 'conflict';
    let expected = item.value;
    if (item.entity === 'artifact_blobs' && !Object.hasOwn(expected, 'tenant_id')) {
      const tenantId = await tenantForExistingArtifactBlob(item);
      if (!tenantId) return 'conflict';
      expected = { ...expected, tenant_id: tenantId };
    }
    return rowMatches(result.rows[0], expected) ? 'identical' : 'conflict';
  }

  async function validatePlan(writes) {
    if (!Array.isArray(writes)) throw new AdapterConfigurationError('INVALID_PLAN', 'write plan must be an array');
    await assertDistinctTargetDatabases();
    const failures = [];
    const artifactTenants = artifactTenantMap(writes);
    const validatedConnectorPins = new Set();
    for (const plane of ['connector', 'orchestrator']) {
      const pool = plane === 'connector' ? connectorTargetPool : targetPool;
      const planeWrites = writes.map(ensureWrite).filter((item) => planeFor(item) === plane);
      if (planeWrites.length === 0) continue;
      await inTransaction(pool, async (client) => {
        await assertSnapshotGate(client, plane);
        for (let index = 0; index < planeWrites.length; index += 1) {
        const original = planeWrites[index];
        let item;
        try {
          item = withArtifactTenant(original, artifactTenants);
        } catch (error) {
          failures.push(constraintFailure(original, error && error.code));
          continue;
        }
        await client.query('SAVEPOINT ldba03_validate_row');
        try {
          if (item.entity === 'profile_bindings') {
            await assertProfileConnectorPins(item, validatedConnectorPins);
          }
          const query = insertStatement(item, 'DO NOTHING');
          const inserted = await client.query(query.sql, query.values);
          let rowValidated = inserted.rows.length > 0;
          if (inserted.rows.length === 0) {
            const lookup = lookupStatement(item);
            const existing = await client.query(lookup.sql, lookup.values);
            if (existing.rows.length !== 1 || !rowMatches(existing.rows[0], item.value)) {
              failures.push(constraintFailure(item, 'IMMUTABLE_CONFLICT'));
            } else rowValidated = true;
          }
          await client.query('RELEASE SAVEPOINT ldba03_validate_row');
          if (rowValidated && item.entity === 'connector_revisions') {
            validatedConnectorPins.add(connectorRevisionPinKey(item.value.tenant_id, item.value.connector_id, item.value.revision));
          }
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT ldba03_validate_row');
          await client.query('RELEASE SAVEPOINT ldba03_validate_row');
          failures.push(constraintFailure(item, error && error.code));
        }
      }
      }, false);
    }
    return failures;
  }

  async function applyImmutableBatch(writes) {
    if (!Array.isArray(writes)) throw new AdapterConfigurationError('INVALID_PLAN', 'write batch must be an array');
    await assertDistinctTargetDatabases();
    const artifactTenants = artifactTenantMap(writes);
    const outcomes = new Array(writes.length);
    const indexes = { connector: [], orchestrator: [] };
    for (let index = 0; index < writes.length; index += 1) {
      const item = ensureWrite(writes[index]);
      indexes[planeFor(item)].push(index);
    }
    let connectorPhaseCommitted = false;
    const committedConnectorPins = new Set();
    let importProvenance = null;
    if (adapter.sourceSnapshot) {
      if (!resolvedImportTenant) throw new AdapterConfigurationError('IMPORT_TENANT_REQUIRED', 'snapshot provenance requires one resolved target tenant');
      const normalize = (value) => {
        if (Buffer.isBuffer(value) || value instanceof Uint8Array) return { bytesSha256: createHash('sha256').update(value).digest('hex'), byteLength: value.length };
        if (Array.isArray(value)) return value.map(normalize);
        if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])]));
        return value;
      };
      const planSha256 = createHash('sha256').update(JSON.stringify(writes.map(normalize))).digest('hex');
      const counts = {};
      for (const item of writes) counts[item.entity] = (counts[item.entity] || 0) + 1;
      importProvenance = {
        tenantId: resolvedImportTenant,
        sourceVersion,
        sourceSha256: adapter.sourceSnapshot.sha256,
        planSha256,
        sourceCounts: adapter.sourceSnapshot.rowCounts,
        destinationCounts: counts,
      };
    }
    for (const plane of ['connector', 'orchestrator']) {
      const pool = plane === 'connector' ? connectorTargetPool : targetPool;
      const planeIndexes = indexes[plane];
      if (planeIndexes.length === 0 && !(plane === 'orchestrator' && importProvenance)) {
        continue;
      }
      try {
        const phaseResult = await inTransaction(pool, async (client) => {
          await assertSnapshotGate(client, plane);
          const phaseOutcomes = [];
          for (const originalIndex of planeIndexes) {
        const item = withArtifactTenant(ensureWrite(writes[originalIndex]), artifactTenants);
        try {
          if (item.entity === 'profile_bindings') {
            await assertProfileConnectorPins(item, committedConnectorPins);
          }
          const query = insertStatement(item, 'DO NOTHING');
          const inserted = await client.query(query.sql, query.values);
          if (inserted.rows.length > 0) {
            phaseOutcomes.push('inserted');
            continue;
          }
          const lookup = lookupStatement(item);
          const existing = await client.query(lookup.sql, lookup.values);
          if (existing.rows.length === 1 && rowMatches(existing.rows[0], item.value)) {
            phaseOutcomes.push('identical');
            continue;
          }
          const error = new AdapterConfigurationError('IMMUTABLE_CONFLICT', 'immutable target row differs from the planned value');
          error.write = item;
          throw error;
        } catch (error) {
          if (!error.write) error.write = item;
          throw error;
        }
      }
          if (phaseOutcomes.length !== planeIndexes.length) throw new AdapterConfigurationError('INVALID_BATCH_RESULT', 'plane transaction result length differs from its immutable write count');
          if (plane === 'orchestrator' && importProvenance) {
            const ledger = await client.query(`INSERT INTO legacy_migration_runs
              (tenant_id,source_version,source_sha256,plan_sha256,source_counts,destination_counts)
              VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT (tenant_id,source_version) DO NOTHING RETURNING source_version`,
              [importProvenance.tenantId, importProvenance.sourceVersion, importProvenance.sourceSha256,
                importProvenance.planSha256, JSON.stringify(importProvenance.sourceCounts), JSON.stringify(importProvenance.destinationCounts)]);
            if (!ledger.rowCount) {
              const prior = await client.query('SELECT source_sha256,plan_sha256 FROM legacy_migration_runs WHERE tenant_id=$1 AND source_version=$2',
                [importProvenance.tenantId, importProvenance.sourceVersion]);
              if (prior.rows.length !== 1 || prior.rows[0].source_sha256 !== importProvenance.sourceSha256
                  || prior.rows[0].plan_sha256 !== importProvenance.planSha256) {
                throw new AdapterConfigurationError('IMPORT_PROVENANCE_CONFLICT', 'source version already belongs to different immutable source/write inventory');
              }
            }
          }
          return { outcomes: phaseOutcomes, provenanceWritten: plane === 'orchestrator' && Boolean(importProvenance) };
        });
        const phaseOutcomes = phaseResult.outcomes;
        for (let offset = 0; offset < planeIndexes.length; offset += 1) outcomes[planeIndexes[offset]] = phaseOutcomes[offset];
        if (plane === 'connector') {
          connectorPhaseCommitted = true;
          for (const index of planeIndexes) {
            const item = ensureWrite(writes[index]);
            if (item.entity === 'connector_revisions') {
              committedConnectorPins.add(connectorRevisionPinKey(item.value.tenant_id, item.value.connector_id, item.value.revision));
            }
          }
        }
        if (phaseResult.provenanceWritten && importProvenance) {
          adapter.importProvenance = {
            tenantId: importProvenance.tenantId,
            sourceVersion: importProvenance.sourceVersion,
            sourceSha256: importProvenance.sourceSha256,
            planSha256: importProvenance.planSha256,
          };
        }
      } catch (error) {
        if (plane === 'orchestrator' && connectorPhaseCommitted) {
          const partial = new AdapterConfigurationError('CROSS_PLANE_PARTIAL', 'Connector immutable rows committed, but Orchestrator projection did not; hold source cutover and replay the same source version');
          partial.write = error && error.write;
          partial.connectorRowsCommitted = indexes.connector.length;
          partial.phase = 'orchestrator';
          partial.phaseFailureCode = error && error.code ? String(error.code) : 'ORCHESTRATOR_WRITE_FAILED';
          partial.replayRequired = partial.phaseFailureCode !== 'IMPORT_PROVENANCE_CONFLICT';
          throw partial;
        }
        throw error;
      }
    }
    if (outcomes.some((outcome) => outcome !== 'inserted' && outcome !== 'identical')) {
      throw new AdapterConfigurationError('INVALID_BATCH_RESULT', 'cross-plane result does not match every immutable write');
    }
    return outcomes;
  }

  function syncContext(name, args) {
    const method = requireContextFunction(provider, name);
    const value = method(...args);
    if (value && typeof value.then === 'function') {
      throw new AdapterConfigurationError('ASYNC_SYNC_CONTEXT', name + ' must be synchronous under the accepted runner contract');
    }
    return value;
  }

  async function asyncContext(name, args) {
    const method = requireContextFunction(provider, name);
    return method(...args);
  }

  const context = {
    resolveBusinessAction: (slug) => {
      if (provider && typeof provider.resolveBusinessAction === 'function') {
        return syncContext('resolveBusinessAction', [slug]);
      }
      let action = slug;
      if (/^(ingest|extract|analyze|transform|generate|compare):/.test(slug)) action = slug.split(':')[0];
      else if (slug.startsWith('workflows:schema:')) action = 'schema-workflow';
      else if (slug.startsWith('workflows:')) action = slug.slice('workflows:'.length);
      if (ambiguousBusinessActions.has(action)) return null;
      return businessActions.get(action) || null;
    },
    resolveProfileConnectors: (row, business) => {
      if (!env.LDBA03_PROFILE_BINDINGS_FILE) return {};
      const bytes = fs.readFileSync(path.resolve(env.LDBA03_PROFILE_BINDINGS_FILE));
      if (createHash('sha256').update(bytes).digest('hex') !== env.LDBA03_PROFILE_BINDINGS_SHA256) throw new AdapterConfigurationError('PROFILE_BINDINGS_DIGEST_MISMATCH', 'reviewed connector mapping digest mismatch');
      const manifest = JSON.parse(bytes.toString('utf8'));
      if (manifest.sourceVersion !== sourceVersion || typeof manifest.reviewedBy !== 'string' || !manifest.reviewedBy.trim()) throw new AdapterConfigurationError('PROFILE_BINDINGS_SOURCE_MISMATCH', 'connector mapping must identify reviewer and frozen source');
      const entry = manifest.profiles && manifest.profiles[row.id];
      if (!entry) return {};
      if (entry.endpointSlug !== row.endpointSlug || entry.businessId !== business.businessId || entry.action !== business.action || entry.businessVersion !== business.businessVersion) throw new AdapterConfigurationError('PROFILE_BINDINGS_SCOPE_MISMATCH', 'connector pins belong to another profile scope');
      const pins = entry.connectorBindings;
      if (!pins || typeof pins !== 'object' || Array.isArray(pins)) throw new AdapterConfigurationError('INVALID_CONNECTOR_PINS', 'pins must be an object');
      for (const [slot, pin] of Object.entries(pins)) {
        if (!slot || !pin || typeof pin.connectorId !== 'string' || !pin.connectorId || !Number.isSafeInteger(pin.revision) || pin.revision < 1) throw new AdapterConfigurationError('INVALID_CONNECTOR_PINS', 'pins must identify a concrete connector revision');
      }
      return pins;
    },
    prepareConnector: async (row, request) => {
      await assertDistinctTargetDatabases();
      const prepared = await asyncContext('prepareConnector', [row, request]);
      if (!prepared || !prepared.secret || !Buffer.isBuffer(prepared.secret.encrypted_value)) return prepared;
      const existing = await connectorTargetPool.query('SELECT encrypted_value FROM secret_versions WHERE id = $1 AND credential_ref = $2', [prepared.secret.id, prepared.secret.credential_ref]);
      if (existing.rows.length === 0) return prepared;
      if (existing.rows.length !== 1 || !Buffer.isBuffer(existing.rows[0].encrypted_value)) throw new AdapterConfigurationError('SECRET_REPLAY_CONFLICT', 'existing secret is not a single valid ciphertext');
      const key = Buffer.from(env.CONNECTOR_ENCRYPTION_KEY || '', 'base64');
      if (key.length !== 32) throw new AdapterConfigurationError('SECRET_REPLAY_KEY_REQUIRED', 'authenticated secret replay requires the configured encryption key');
      const plaintexts = [];
      try {
        for (const ciphertext of [existing.rows[0].encrypted_value, prepared.secret.encrypted_value]) {
          if (ciphertext.length < 29) throw new Error('invalid envelope');
          const decipher = createDecipheriv('aes-256-gcm', key, ciphertext.subarray(0, 12));
          decipher.setAuthTag(ciphertext.subarray(12, 28));
          plaintexts.push(Buffer.concat([decipher.update(ciphertext.subarray(28)), decipher.final()]));
        }
        if (plaintexts[0].length !== plaintexts[1].length || !timingSafeEqual(plaintexts[0], plaintexts[1])) throw new Error('secret changed');
        prepared.secret.encrypted_value = existing.rows[0].encrypted_value;
      } catch {
        throw new AdapterConfigurationError('SECRET_REPLAY_CONFLICT', 'existing credential does not authenticate as the unchanged source secret');
      } finally { key.fill(0); for (const plaintext of plaintexts) plaintext.fill(0); }
      return prepared;
    },
    resolveProfileName: (row) => syncContext('resolveProfileName', [row]),
    normalizeConnectionsOverride: (raw) => syncContext('normalizeConnectionsOverride', [raw]),
    prepareWorkflowSchema: async (parsed, request) => {
      const prepared = await asyncContext('prepareWorkflowSchema', [parsed, request]);
      const existing = await targetPool.query('SELECT digest, schema_ref FROM legacy_workflow_schemas WHERE tenant_id = $1 AND slug = $2 AND revision = $3', [request.tenantId, request.slug, request.revision]);
      if (existing.rows.length === 0) return prepared;
      if (existing.rows.length !== 1 || existing.rows[0].digest !== prepared.digest) throw new AdapterConfigurationError('WORKFLOW_REPLAY_CONFLICT', 'immutable workflow definition changed');
      const modulePath = env.LDBA03_METADATA_SEAM_MODULE;
      if (!modulePath) throw new AdapterConfigurationError('WORKFLOW_REPLAY_KEY_REQUIRED', 'schema replay requires metadata unwrap seam');
      const loaded = require(path.resolve(modulePath));
      const seam = loaded.default || loaded;
      if (typeof seam.unwrapDek !== 'function') throw new AdapterConfigurationError('WORKFLOW_REPLAY_KEY_REQUIRED', 'schema replay seam must implement unwrapDek');
      const expectedAad = createHash('sha256').update(request.tenantId + '|legacy_workflow_schemas.schema_ref|' + request.slug + ':' + request.revision).digest();
      const plaintexts = [];
      try {
        for (const envelope of [existing.rows[0].schema_ref, prepared.schemaRef]) {
          if (!envelope || envelope.version !== 1 || envelope.algorithm !== 'aes-256-gcm') throw new Error('invalid metadata envelope');
          const aad = Buffer.from(envelope.aad, 'base64');
          if (aad.length !== expectedAad.length || !timingSafeEqual(aad, expectedAad)) throw new Error('context mismatch');
          const dek = await seam.unwrapDek(envelope.dek);
          if (!Buffer.isBuffer(dek) || dek.length !== 32) throw new Error('invalid metadata key');
          try {
            const decipher = createDecipheriv('aes-256-gcm', dek, Buffer.from(envelope.nonce, 'base64'), { authTagLength: 16 });
            decipher.setAAD(expectedAad);
            decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
            const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]);
            plaintexts.push(plaintext);
            if (createHash('sha256').update(plaintext).digest('hex') !== envelope.plaintextSha256) throw new Error('plaintext digest mismatch');
          } finally { dek.fill(0); }
        }
        if (plaintexts[0].length !== plaintexts[1].length || !timingSafeEqual(plaintexts[0], plaintexts[1])) throw new Error('schema plaintext changed');
        return { ...prepared, schemaRef: existing.rows[0].schema_ref };
      } catch {
        throw new AdapterConfigurationError('WORKFLOW_REPLAY_CONFLICT', 'existing schema does not authenticate as unchanged source in the same tenant/slot/revision');
      } finally { for (const plaintext of plaintexts) plaintext.fill(0); }
    },
    readFileCacheBytes: (s3Key) => asyncContext('readFileCacheBytes', [s3Key]),
    artifactTokenFor: (row, id) => syncContext('artifactTokenFor', [row, id]),
    artifactPurposeFor: (row) => syncContext('artifactPurposeFor', [row]),
    prepareAdminLocalUser: (row, request) => syncContext('prepareAdminLocalUser', [row, request]),
  };

  function verifyTimezoneEvidence(tables) {
    const evidencePath = env.LDBA03_TIMEZONE_EVIDENCE_FILE;
    if (!evidencePath) return;
    const bytes = fs.readFileSync(path.resolve(evidencePath));
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (sha256 !== env.LDBA03_TIMEZONE_EVIDENCE_SHA256) throw new AdapterConfigurationError('TIMEZONE_EVIDENCE_DIGEST_MISMATCH', 'evidence file does not match approved SHA256');
    const proof = JSON.parse(bytes.toString('utf8'));
    const sourceDigest = createHash('sha256').update(JSON.stringify(tables)).digest('hex');
    if (proof.sourceVersion !== sourceVersion || proof.timezone !== 'UTC'
        || proof.sourceDataSha256 !== sourceDigest || typeof proof.reviewedBy !== 'string' || !proof.reviewedBy.trim()
        || !Array.isArray(proof.observations) || proof.observations.length < 1) {
      throw new AdapterConfigurationError('INVALID_TIMEZONE_EVIDENCE', 'proof must bind reviewed UTC observations to this frozen source digest and version');
    }
    for (const observation of proof.observations) {
      const rows = tables[observation.table];
      const row = rows && rows.find((item) => String(item[SOURCE_KEYS[observation.table]]) === String(observation.sourceKey));
      if (!row || !TIMESTAMP_FIELDS.has(observation.field) || row[observation.field] !== observation.naive
          || typeof observation.reference !== 'string' || !observation.reference.trim()
          || typeof observation.utc !== 'string' || !observation.utc.endsWith('Z')
          || !Number.isFinite(Date.parse(observation.utc))
          || Date.parse(observation.naive.replace(' ', 'T') + 'Z') !== Date.parse(observation.utc)) {
        throw new AdapterConfigurationError('TIMEZONE_OBSERVATION_MISMATCH', 'independently sourced UTC observation disagrees with frozen legacy timestamp');
      }
    }
    adapter.timezoneEvidence = { verified: true, sourceVersion, timezone: 'UTC', sha256 };
  }
  const sourceVersion = env.LDBA03_SOURCE_VERSION || env.LDBA_SOURCE_VERSION || '';
  const a1SourceVersion = env.LDBA_A1_SOURCE_VERSION || '';
  const adapter = {
    source: { scan },
    sink: {
      resolveTenantIdsByName,
      seedTenantByName,
      assertTargetSeparation: assertDistinctTargetDatabases,
      validatePlan,
      inspectImmutable,
      applyImmutableBatch,
    },
    context,
    a1Passed: env.LDBA_A1_PASSED === '1',
    sourceVersion,
    a1SourceVersion,
    async close() {
      await Promise.all([...new Set([sourcePool, targetPool, connectorTargetPool])]
        .map((pool) => typeof pool.end === 'function' ? pool.end() : Promise.resolve()));
    },
  };
  return adapter;
}

const api = {
  AdapterConfigurationError,
  ENTITY_SPECS,
  LEGACY_TABLES,
  createAdapter,
  loadContextProvider,
};

const defaultAdapter = process.env.LDBA03_ADAPTER_LIBRARY === '1' ? null : createAdapter();
module.exports = defaultAdapter ? Object.assign(defaultAdapter, api) : api;
