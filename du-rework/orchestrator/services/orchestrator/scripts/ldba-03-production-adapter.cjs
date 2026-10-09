'use strict';

const path = require('node:path');

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
  operations: { key: ['id'] },
  connector_prompt_overrides: {
    key: ['connection_id', 'api_key_id', 'endpoint_slug', 'step_id'],
  },
  artifacts: { key: ['id'] },
  artifact_blobs: { key: ['storage_key'] },
  admin_local_users: { key: ['id'] },
  user_profile_assignments: { key: ['user_id', 'api_key_id'] },
  legacy_workflow_schemas: { key: ['tenant_id', 'slug', 'revision'] },
});

const JSONB_COLUMNS = Object.freeze({
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
  const modulePath = env.LDBA03_CONTEXT_MODULE;
  if (!modulePath) return null;
  const resolved = path.resolve(modulePath);
  const loaded = require(resolved);
  const provider = loaded && loaded.default ? loaded.default : loaded;
  if (!provider || typeof provider !== 'object') {
    throw new AdapterConfigurationError('INVALID_CONTEXT_MODULE', 'context module must export a policy object');
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
  const sourceSchema = options.sourceSchema || env.LDBA03_SOURCE_SCHEMA || 'public';
  identifier(sourceSchema);

  if (!options.sourcePool && !sourceConnectionString) {
    throw new AdapterConfigurationError('SOURCE_DATABASE_URL_REQUIRED', 'LDBA03_SOURCE_DATABASE_URL or DATABASE_URL is required');
  }
  if (!options.targetPool && !targetConnectionString) {
    throw new AdapterConfigurationError('TARGET_DATABASE_URL_REQUIRED', 'LDBA03_TARGET_DATABASE_URL or DATABASE_URL is required');
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
  const provider = options.context || loadContextProvider(env);
  const businessActions = new Map();
  const ambiguousBusinessActions = new Set();
  let businessRegistryLoaded = false;

  if (!sourcePool || !targetPool) {
    throw new AdapterConfigurationError('DATABASE_POOL_REQUIRED', 'source and target PostgreSQL pools are required');
  }
  if (!options.sourcePool && !sourceConnectionString) {
    throw new AdapterConfigurationError('SOURCE_DATABASE_URL_REQUIRED', 'LDBA03_SOURCE_DATABASE_URL or DATABASE_URL is required');
  }
  if (!options.targetPool && !targetConnectionString) {
    throw new AdapterConfigurationError('TARGET_DATABASE_URL_REQUIRED', 'LDBA03_TARGET_DATABASE_URL or DATABASE_URL is required');
  }

  async function scan(table) {
    if (!Object.hasOwn(SOURCE_KEYS, table)) {
      throw new AdapterConfigurationError('UNSUPPORTED_SOURCE_TABLE', 'source table is outside the nine-table allowlist');
    }
    if (!businessRegistryLoaded) await loadBusinessRegistrySnapshot();
    const metadataResult = await sourcePool.query(
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
      + ' ORDER BY ' + identifier(key);
    const result = await sourcePool.query(sql);
    if (!Array.isArray(result.rows)) {
      throw new AdapterConfigurationError('INVALID_SOURCE_RESULT', 'source query did not return a row array');
    }
    return result.rows;
  }

  async function loadBusinessRegistrySnapshot() {
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
    if (typeof name !== 'string' || name.length === 0) {
      throw new AdapterConfigurationError('INVALID_TENANT_NAME', 'tenant name must be non-empty text');
    }
    const result = await targetPool.query('SELECT id::text AS id FROM tenants WHERE name = $1 ORDER BY id', [name]);
    return result.rows.map((row) => row.id);
  }

  async function seedTenantByName(name) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new AdapterConfigurationError('INVALID_TENANT_NAME', 'tenant name must be non-empty text');
    }
    return inTransaction(targetPool, async (client) => {
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
    ensureWrite(item);
    const query = lookupStatement(item);
    const result = await targetPool.query(query.sql, query.values);
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
    const failures = [];
    const artifactTenants = artifactTenantMap(writes);
    await inTransaction(targetPool, async (client) => {
      for (let index = 0; index < writes.length; index += 1) {
        const original = ensureWrite(writes[index]);
        let item;
        try {
          item = withArtifactTenant(original, artifactTenants);
        } catch (error) {
          failures.push(constraintFailure(original, error && error.code));
          continue;
        }
        await client.query('SAVEPOINT ldba03_validate_row');
        try {
          const query = insertStatement(item, 'DO NOTHING');
          const inserted = await client.query(query.sql, query.values);
          if (inserted.rows.length === 0) {
            const lookup = lookupStatement(item);
            const existing = await client.query(lookup.sql, lookup.values);
            if (existing.rows.length !== 1 || !rowMatches(existing.rows[0], item.value)) {
              failures.push(constraintFailure(item, 'IMMUTABLE_CONFLICT'));
            }
          }
          await client.query('RELEASE SAVEPOINT ldba03_validate_row');
        } catch (error) {
          await client.query('ROLLBACK TO SAVEPOINT ldba03_validate_row');
          await client.query('RELEASE SAVEPOINT ldba03_validate_row');
          failures.push(constraintFailure(item, error && error.code));
        }
      }
    }, false);
    return failures;
  }

  async function applyImmutableBatch(writes) {
    if (!Array.isArray(writes)) throw new AdapterConfigurationError('INVALID_PLAN', 'write batch must be an array');
    const artifactTenants = artifactTenantMap(writes);
    return inTransaction(targetPool, async (client) => {
      const outcomes = [];
      for (const value of writes) {
        const item = withArtifactTenant(ensureWrite(value), artifactTenants);
        try {
          const query = insertStatement(item, 'DO NOTHING');
          const inserted = await client.query(query.sql, query.values);
          if (inserted.rows.length > 0) {
            outcomes.push('inserted');
            continue;
          }
          const lookup = lookupStatement(item);
          const existing = await client.query(lookup.sql, lookup.values);
          if (existing.rows.length === 1 && rowMatches(existing.rows[0], item.value)) {
            outcomes.push('identical');
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
      if (outcomes.length !== writes.length) {
        throw new AdapterConfigurationError('INVALID_BATCH_RESULT', 'atomic batch produced a partial outcome list');
      }
      return outcomes;
    });
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
      if (ambiguousBusinessActions.has(slug)) return null;
      return businessActions.get(slug) || null;
    },
    prepareConnector: (row, request) => asyncContext('prepareConnector', [row, request]),
    resolveProfileName: (row) => syncContext('resolveProfileName', [row]),
    normalizeConnectionsOverride: (raw) => syncContext('normalizeConnectionsOverride', [raw]),
    prepareWorkflowSchema: (parsed, request) => asyncContext('prepareWorkflowSchema', [parsed, request]),
    readFileCacheBytes: (s3Key) => asyncContext('readFileCacheBytes', [s3Key]),
    artifactTokenFor: (row, id) => syncContext('artifactTokenFor', [row, id]),
    artifactPurposeFor: (row) => syncContext('artifactPurposeFor', [row]),
    prepareAdminLocalUser: () => {
      throw new AdapterConfigurationError(
        'PASSWORD_RESET_REQUIRED',
        'legacy bcrypt verifier requires user-presented plaintext at first login before target scrypt hashing',
      );
    },
  };

  const sourceVersion = env.LDBA03_SOURCE_VERSION || env.LDBA_SOURCE_VERSION || '';
  const a1SourceVersion = env.LDBA_A1_SOURCE_VERSION || '';
  const adapter = {
    source: { scan },
    sink: {
      resolveTenantIdsByName,
      seedTenantByName,
      validatePlan,
      inspectImmutable,
      applyImmutableBatch,
    },
    context,
    a1Passed: env.LDBA_A1_PASSED === '1',
    sourceVersion,
    a1SourceVersion,
    async close() {
      if (sourcePool === targetPool) {
        if (typeof sourcePool.end === 'function') await sourcePool.end();
        return;
      }
      await Promise.all([
        typeof sourcePool.end === 'function' ? sourcePool.end() : Promise.resolve(),
        typeof targetPool.end === 'function' ? targetPool.end() : Promise.resolve(),
      ]);
    },
  };
  return adapter;
}

const api = {
  AdapterConfigurationError,
  ENTITY_SPECS,
  LEGACY_TABLES,
  createAdapter,
};

const defaultAdapter = process.env.LDBA03_ADAPTER_LIBRARY === '1' ? null : createAdapter();
module.exports = defaultAdapter ? Object.assign(defaultAdapter, api) : api;
