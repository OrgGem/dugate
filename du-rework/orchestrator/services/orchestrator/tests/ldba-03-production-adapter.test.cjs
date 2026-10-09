'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
process.env.LDBA03_ADAPTER_LIBRARY = '1';
const {
  AdapterConfigurationError,
  ENTITY_SPECS,
  LEGACY_TABLES,
  createAdapter,
} = require('../scripts/ldba-03-production-adapter.cjs');
const QUOTE = String.fromCharCode(34);
const JSONB_COLUMNS = {
  connector_revisions: new Set(['config', 'credential_source']),
  operations: new Set(['input_ref', 'connector_bindings', 'pipeline_json', 'steps_result_json', 'extracted_data', 'usage_breakdown', 'submit_artifacts']),
  profile_bindings: new Set(['connector_bindings', 'parameters', 'connections_override']),
  connector_prompt_overrides: new Set(['prompt_overrides_ref']),
  legacy_workflow_schemas: new Set(['schema_ref']),
};

function result(rows = []) {
  return { rows, rowCount: rows.length };
}

function fakeTargetPool() {
  const tables = new Map();
  const tenants = [];
  const calls = [];
  let transactionSnapshot = null;

  function rowsFor(table) {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  }

  function handle(sql, values = []) {
    calls.push({ sql, values });
    if (/^SELECT business_id, version, manifest FROM business_versions/.test(sql)) return result([]);
    if (/^SELECT pg_advisory_xact_lock/.test(sql)) return result([{}]);
    if (/^SELECT id::text AS id FROM tenants/.test(sql)) {
      return result(tenants.filter((tenant) => tenant.name === values[0]).map((tenant) => ({ id: tenant.id })));
    }
    if (/^INSERT INTO tenants \(name\)/.test(sql)) {
      const row = { id: 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2', name: values[0] };
      tenants.push(row);
      return result([{ id: row.id }]);
    }
    if (/^BEGIN$/.test(sql)) {
      transactionSnapshot = {
        tables: new Map([...tables].map(([name, rows]) => [name, rows.map((row) => ({ ...row }))])),
        tenants: tenants.map((tenant) => ({ ...tenant })),
      };
      return result();
    }
    if (/^COMMIT$/.test(sql)) {
      transactionSnapshot = null;
      return result();
    }
    if (/^ROLLBACK$/.test(sql)) {
      if (transactionSnapshot) {
        tables.clear();
        for (const [name, rows] of transactionSnapshot.tables) tables.set(name, rows);
        tenants.splice(0, tenants.length, ...transactionSnapshot.tenants);
      }
      transactionSnapshot = null;
      return result();
    }
    if (/^(SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return result();
    const insert = new RegExp('^INSERT INTO ' + QUOTE + '([A-Za-z_][A-Za-z0-9_$]*)' + QUOTE + ' \\(([^)]+)\\).* RETURNING ').exec(sql);
    if (insert) {
      const table = insert[1];
      const columns = insert[2].split(', ').map((value) => value.slice(1, -1));
      const row = Object.fromEntries(columns.map((column, index) => {
        const value = values[index];
        if (JSONB_COLUMNS[table] && JSONB_COLUMNS[table].has(column) && typeof value === 'string') {
          return [column, JSON.parse(value)];
        }
        return [column, value];
      }));
      const keyColumns = ENTITY_SPECS[table].key;
      const storedRows = rowsFor(table);
      const prior = storedRows.find((candidate) => keyColumns.every((key) => candidate[key] === row[key]));
      if (prior) return result([]);
      storedRows.push(row);
      return result([Object.fromEntries(keyColumns.map((key) => [key, row[key]]))]);
    }
    const select = new RegExp('^SELECT \\* FROM ' + QUOTE + '([A-Za-z_][A-Za-z0-9_$]*)' + QUOTE + ' WHERE (.+) LIMIT 2$').exec(sql);
    if (select) {
      const table = select[1];
      const columns = [...select[2].matchAll(new RegExp(QUOTE + '([A-Za-z_][A-Za-z0-9_$]*)' + QUOTE + ' = \\$(\\d+)', 'g'))];
      const found = rowsFor(table).filter((row) => columns.every((match) => row[match[1]] === values[Number(match[2]) - 1]));
      return result(found.slice(0, 2));
    }
    if (/^SELECT tenant_id::text AS tenant_id FROM artifacts/.test(sql)) {
      return result(rowsFor('artifacts').filter((row) => row.storage_key === values[0]).map((row) => ({ tenant_id: row.tenant_id })));
    }
    throw new Error('unexpected fake target SQL');
  }

  return {
    calls,
    tenants,
    tables,
    async query(sql, values) {
      return handle(sql, values);
    },
    async connect() {
      return {
        query: async (sql, values) => handle(sql, values),
        release() {},
      };
    },
    async end() {},
  };
}

function fakeSourcePool() {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (/information_schema\.columns/.test(sql)) {
        return result([
          { column_name: 'id', data_type: 'uuid' },
          { column_name: 'createdAt', data_type: 'timestamp with time zone' },
          { column_name: 'pipelineJson', data_type: 'jsonb' },
          { column_name: 'totalCostUsd', data_type: 'double precision' },
        ]);
      }
      if (new RegExp('FROM ' + QUOTE + 'public' + QUOTE + '\\.' + QUOTE + 'Operation' + QUOTE).test(sql)) {
        return result([{
          id: 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2',
          createdAt: '2026-01-01 00:00:00.000000',
          pipelineJson: '{}',
          totalCostUsd: '1.250000',
        }]);
      }
      throw new Error('unexpected fake source SQL');
    },
    async end() {},
  };
}

function createTestAdapter(options = {}) {
  const sourcePool = options.sourcePool || fakeSourcePool();
  const targetPool = options.targetPool || fakeTargetPool();
  const adapter = createAdapter({
    sourcePool,
    targetPool,
    env: {
      LDBA_A1_PASSED: '1',
      LDBA03_SOURCE_VERSION: 'synthetic-v1',
      LDBA_A1_SOURCE_VERSION: 'synthetic-v1',
      ...options.env,
    },
    context: options.context,
  });
  return { adapter, sourcePool, targetPool };
}

test('exports the runner shape and binds A1 claims only to explicit environment values', () => {
  const { adapter } = createTestAdapter();
  assert.equal(adapter.a1Passed, true);
  assert.equal(adapter.sourceVersion, 'synthetic-v1');
  assert.equal(adapter.a1SourceVersion, 'synthetic-v1');
  assert.deepEqual(Object.keys(adapter.source), ['scan']);
  assert.deepEqual(Object.keys(adapter.sink), [
    'resolveTenantIdsByName',
    'seedTenantByName',
    'validatePlan',
    'inspectImmutable',
    'applyImmutableBatch',
  ]);
  assert.deepEqual(Object.keys(adapter.context), [
    'resolveBusinessAction',
    'prepareConnector',
    'resolveProfileName',
    'normalizeConnectionsOverride',
    'prepareWorkflowSchema',
    'readFileCacheBytes',
    'artifactTokenFor',
    'artifactPurposeFor',
    'prepareAdminLocalUser',
  ]);
  assert.equal(LEGACY_TABLES.length, 9);
  assert.equal(adapter.context.resolveBusinessAction('missing'), null);
  assert.throws(
    () => adapter.context.prepareAdminLocalUser({ password: 'bcrypt-verifier' }, {}),
    (error) => error instanceof AdapterConfigurationError && error.code === 'PASSWORD_RESET_REQUIRED',
  );
});

test('source scan allowlists tables and projects UTC timestamps, JSON text, and rounded decimals', async () => {
  const { adapter, sourcePool } = createTestAdapter();
  const rows = await adapter.source.scan('Operation');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].createdAt, '2026-01-01 00:00:00.000000');
  assert.equal(rows[0].pipelineJson, '{}');
  assert.equal(rows[0].totalCostUsd, '1.250000');
  const select = sourcePool.calls.find((call) => new RegExp('FROM ' + QUOTE + 'public' + QUOTE + '\\.' + QUOTE + 'Operation' + QUOTE).test(call.sql));
  assert.equal(select.sql.includes('AT TIME ZONE ' + String.fromCharCode(39) + 'UTC' + String.fromCharCode(39)), true);
  assert.equal(select.sql.includes(QUOTE + 'pipelineJson' + QUOTE + '::text'), true);
  assert.equal(select.sql.includes('numeric(20,6)::text'), true);
  await assert.rejects(adapter.source.scan('pg_catalog.pg_class'), /outside the nine-table allowlist/);
});

test('tenant seed serializes by name and inserts only the name column', async () => {
  const { adapter, targetPool } = createTestAdapter();
  const id = await adapter.sink.seedTenantByName('legacy-default');
  assert.equal(id, 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2');
  assert.deepEqual(await adapter.sink.resolveTenantIdsByName('legacy-default'), [id]);
  assert.equal(targetPool.calls.some((call) => /pg_advisory_xact_lock/.test(call.sql)), true);
  const seed = targetPool.calls.find((call) => /^INSERT INTO tenants/.test(call.sql));
  assert.equal(seed.sql, 'INSERT INTO tenants (name) VALUES ($1) RETURNING id::text AS id');
  assert.deepEqual(seed.values, ['legacy-default']);
});

test('immutable writes insert once, replay identically, and stop on changed content', async () => {
  const { adapter } = createTestAdapter();
  const item = {
    entity: 'api_keys',
    key: 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2',
    value: {
      id: 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2',
      tenant_id: 'a107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2',
      name: 'fixture',
    },
    source: { table: 'ApiKey', sourceKey: 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2' },
  };
  assert.equal(await adapter.sink.inspectImmutable(item), 'new');
  assert.deepEqual(await adapter.sink.applyImmutableBatch([item]), ['inserted']);
  assert.equal(await adapter.sink.inspectImmutable(item), 'identical');
  assert.deepEqual(await adapter.sink.applyImmutableBatch([item]), ['identical']);
  const changed = { ...item, value: { ...item.value, name: 'changed' } };
  assert.equal(await adapter.sink.inspectImmutable(changed), 'conflict');
  await assert.rejects(
    adapter.sink.applyImmutableBatch([changed]),
    (error) => error.code === 'IMMUTABLE_CONFLICT' && error.write === changed,
  );
});

test('immutable replay normalizes PostgreSQL numeric, jsonb, and timestamptz representations', async () => {
  const { adapter, targetPool } = createTestAdapter();
  const operation = {
    entity: 'operations',
    key: 'operation-serialization-drift',
    value: {
      id: 'operation-serialization-drift',
      extracted_data: '{"answer":42}',
      pipeline_json: '{"steps":[{"ordinal":1}]}',
      total_cost_usd: '0.000001',
      created_at: '2026-10-09 12:30:00.123456',
    },
  };
  const profileBinding = {
    entity: 'profile_bindings',
    key: 'profile-serialization-drift:7',
    value: {
      profile_id: 'profile-serialization-drift',
      revision: 7,
      parameters: { model: 'fixture', retries: 2 },
      connections_override: [{ service: { enabled: true } }],
    },
  };
  const artifact = {
    entity: 'artifacts',
    key: 'artifact-size-drift',
    value: { id: 'artifact-size-drift', size_bytes: 18 },
  };
  const bigintArtifact = {
    entity: 'artifacts',
    key: 'artifact-bigint-size-drift',
    value: { id: 'artifact-bigint-size-drift', size_bytes: 1800n },
  };
  const writes = [operation, profileBinding, artifact, bigintArtifact];

  assert.deepEqual(await adapter.sink.applyImmutableBatch(writes), ['inserted', 'inserted', 'inserted', 'inserted']);
  const profileInsert = targetPool.calls.find((call) => call.sql.startsWith('INSERT INTO ' + QUOTE + 'profile_bindings' + QUOTE));
  const overrideIndex = Object.keys(profileBinding.value).indexOf('connections_override');
  assert.equal(profileInsert.values[overrideIndex], JSON.stringify(profileBinding.value.connections_override));

  const storedOperation = targetPool.tables.get('operations')[0];
  storedOperation.extracted_data = { answer: 42 };
  storedOperation.pipeline_json = { steps: [{ ordinal: 1 }] };
  storedOperation.total_cost_usd = '0.0000010';
  storedOperation.created_at = new Date('2026-10-09T12:30:00.123Z');

  const storedBinding = targetPool.tables.get('profile_bindings')[0];
  storedBinding.parameters = JSON.stringify(profileBinding.value.parameters);

  targetPool.tables.get('artifacts')[0].size_bytes = '18';
  targetPool.tables.get('artifacts')[1].size_bytes = '1800';

  for (const write of writes) assert.equal(await adapter.sink.inspectImmutable(write), 'identical');
  assert.deepEqual(await adapter.sink.validatePlan(writes), []);
  assert.deepEqual(await adapter.sink.applyImmutableBatch(writes), ['identical', 'identical', 'identical', 'identical']);

  targetPool.tables.get('artifacts')[1].size_bytes = 'not-numeric';
  assert.equal(await adapter.sink.inspectImmutable(bigintArtifact), 'conflict');
});

test('target validation rolls back and supplies the artifact tenant required by the blob FK', async () => {
  const { adapter, targetPool } = createTestAdapter();
  const tenantId = 'a107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2';
  const storageKey = 'legacy-filecache/f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2';
  const writes = [
    {
      entity: 'artifacts',
      key: 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2',
      value: { id: 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2', tenant_id: tenantId, storage_key: storageKey },
      source: { table: 'FileCache', sourceKey: 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2' },
    },
    {
      entity: 'artifact_blobs',
      key: storageKey,
      value: { storage_key: storageKey, bytes: Buffer.from('fixture') },
      source: { table: 'FileCache', sourceKey: 'f107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2' },
    },
  ];
  assert.deepEqual(await adapter.sink.validatePlan(writes), []);
  assert.equal(targetPool.calls.some((call) => call.sql === 'ROLLBACK'), true);
  const blobInsert = targetPool.calls.find((call) => call.sql.startsWith('INSERT INTO ' + QUOTE + 'artifact_blobs' + QUOTE));
  assert.equal(blobInsert.sql.includes(QUOTE + 'tenant_id' + QUOTE), true);
  assert.equal(blobInsert.values.includes(tenantId), true);
  assert.equal(targetPool.tables.get('artifacts'), undefined);
  assert.equal(targetPool.tables.get('artifact_blobs'), undefined);
});
