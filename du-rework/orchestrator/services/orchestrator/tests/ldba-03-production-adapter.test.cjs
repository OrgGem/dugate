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

let fakePoolId = 0;
function fakeTargetPool(identity = null) {
  const id = ++fakePoolId;
  const databaseIdentity = identity || {
    database_name: 'fixture-' + id,
    database_oid: String(1000 + id),
    system_identifier: '9000',
  };
  const tables = new Map();
  const tenants = [];
  const calls = [];
  let transactionSnapshot = null;
  let failLegacyMigrationInsert = false;

  function rowsFor(table) {
    if (!tables.has(table)) tables.set(table, []);
    return tables.get(table);
  }

  function handle(sql, values = []) {
    calls.push({ sql, values });
    if (/SELECT current_database\(\) AS database_name/.test(sql)) return result([{ ...databaseIdentity }]);
    if (/SELECT state FROM "(?:connector_backup_effect_gate|maintenance_backup_effect_gate)"/.test(sql)) return result([{ state: 'OPEN' }]);
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
    if (/^SELECT tenant_id FROM connector_revisions WHERE tenant_id IN/.test(sql)) {
      return result(rowsFor('connector_revisions')
        .filter((row) => (row.tenant_id === values[0] || row.tenant_id === '')
          && row.connector_id === values[1] && Number(row.revision) === Number(values[2]))
        .map((row) => ({ tenant_id: row.tenant_id })));
    }
    if (/^INSERT INTO legacy_migration_runs/.test(sql)) {
      if (failLegacyMigrationInsert) throw new Error('fixture Orchestrator provenance failure');
      const [tenantId, sourceVersion, sourceSha, planSha, sourceCounts, destinationCounts] = values;
      const stored = rowsFor('legacy_migration_runs');
      if (stored.some((row) => row.tenant_id === tenantId && row.source_version === sourceVersion)) return result();
      stored.push({ tenant_id: tenantId, source_version: sourceVersion, source_sha256: sourceSha, plan_sha256: planSha, source_counts: sourceCounts, destination_counts: destinationCounts });
      return result([{ source_version: sourceVersion }]);
    }
    if (/^SELECT source_sha256,plan_sha256 FROM legacy_migration_runs/.test(sql)) {
      return result(rowsFor('legacy_migration_runs')
        .filter((row) => row.tenant_id === values[0] && row.source_version === values[1])
        .map((row) => ({ source_sha256: row.source_sha256, plan_sha256: row.plan_sha256 })));
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

  const pool = {
    calls,
    tenants,
    tables,
    async query(sql, values) {
      return handle(sql, values);
    },
    set failLegacyMigrationInsert(value) { failLegacyMigrationInsert = Boolean(value); },
    async connect() {
      const currentPool = this;
      return {
        query: async (sql, values) => currentPool.query(sql, values),
        release() {},
      };
    },
    async end() {},
  };
  return pool;
}

function fakeSourcePool() {
  const calls = [];
  return {
    calls,
    async query(sql, values) {
      calls.push({ sql, values });
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return result();
      if (/information_schema\.columns/.test(sql)) {
        return result([
          { column_name: values[1] === 'AppSetting' ? 'key' : 'id', data_type: 'uuid' },
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
      if (/^SELECT/.test(sql)) return result();
      throw new Error('unexpected fake source SQL');
    },
    async connect() { return { query: (sql, values) => this.query(sql, values), release() {} }; },
    async end() {},
  };
}

function createTestAdapter(options = {}) {
  const sourcePool = options.sourcePool || fakeSourcePool();
  const targetPool = options.targetPool || fakeTargetPool();
  const connectorTargetPool = options.connectorTargetPool || fakeTargetPool();
  const adapter = createAdapter({
    sourcePool,
    targetPool,
    connectorTargetPool,
    env: {
      LDBA_A1_PASSED: '1',
      LDBA03_SOURCE_VERSION: 'synthetic-v1',
      LDBA_A1_SOURCE_VERSION: 'synthetic-v1',
      ...options.env,
    },
    context: options.context,
  });
  return { adapter, sourcePool, targetPool, connectorTargetPool };
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
    'assertTargetSeparation',
    'validatePlan',
    'inspectImmutable',
    'applyImmutableBatch',
  ]);
  assert.deepEqual(Object.keys(adapter.context), [
    'resolveBusinessAction',
    'resolveProfileConnectors',
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
  assert.equal(adapter.context.prepareAdminLocalUser({ id: 'fixture' }, {}).is_enabled, false);
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
  await assert.rejects(adapter.source.scan('pg_catalog.pg_class'), /outside allowlist/);
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

test('A2 requires independently identified Orchestrator and Connector databases before source reads', async () => {
  assert.throws(() => createAdapter({ env: { DATABASE_URL: 'postgres://fixture', LDBA03_ADAPTER_LIBRARY: '1' }, sourcePool: fakeSourcePool(), targetPool: fakeTargetPool(), context: {} }), (error) => error.code === 'CONNECTOR_TARGET_DATABASE_URL_REQUIRED');
  const sameIdentity = { database_name: 'same', database_oid: '42', system_identifier: '9000' };
  const adapter = createAdapter({
    sourcePool: fakeSourcePool(),
    targetPool: fakeTargetPool(sameIdentity),
    connectorTargetPool: fakeTargetPool(sameIdentity),
    env: { LDBA_A1_PASSED: '1', LDBA03_SOURCE_VERSION: 'synthetic-v1', LDBA_A1_SOURCE_VERSION: 'synthetic-v1' },
    context: {},
  });
  await assert.rejects(adapter.sink.assertTargetSeparation(), (error) => error.code === 'TARGET_DATABASES_MUST_DIFFER');
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

test('A2 writes Connector immutable rows first, verifies replay there, then writes Orchestrator projections', async () => {
  const { adapter, targetPool, connectorTargetPool } = createTestAdapter();
  const secret = Buffer.from([1, 2, 3, 4]);
  const writes = [
    { entity: 'api_keys', key: 'orchestrator-key', value: { id: 'orchestrator-key', tenant_id: 'tenant', hash: 'h' } },
    { entity: 'connector_revisions', key: 'connector| |1', value: { connector_id: 'connector', tenant_id: '', revision: 1, state: 'RETIRED', config: {}, credential_source: { kind: 'legacy-db', credentialRef: 'opaque' } } },
    { entity: 'secret_versions', key: 'secret-version', value: { id: 'secret-version', credential_ref: 'opaque', encrypted_value: secret } },
  ];
  assert.deepEqual(await adapter.sink.applyImmutableBatch(writes), ['inserted', 'inserted', 'inserted']);
  assert.equal(targetPool.tables.get('api_keys').length, 1);
  assert.equal(targetPool.tables.has('connector_revisions'), false);
  assert.equal(targetPool.tables.has('secret_versions'), false);
  assert.equal(connectorTargetPool.tables.get('connector_revisions').length, 1);
  assert.equal(connectorTargetPool.tables.get('secret_versions').length, 1);
  assert.deepEqual(await adapter.sink.applyImmutableBatch(writes), ['identical', 'identical', 'identical']);
  assert.equal(await adapter.sink.inspectImmutable(writes[2]), 'identical');
});

test('A2 dry-run validates an exact planned Connector pin without relying on a rolled-back row', async () => {
  const { adapter, connectorTargetPool, targetPool } = createTestAdapter();
  const tenantId = 'a107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2';
  const connectorId = 'b107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2';
  const writes = [
    { entity: 'connector_revisions', key: connectorId + '|' + tenantId + '|1', value: {
      connector_id: connectorId, tenant_id: tenantId, revision: 1, state: 'RETIRED', config: {},
      credential_source: { kind: 'legacy-db', credentialRef: 'opaque' },
    } },
    { entity: 'profile_bindings', key: 'profile|1', value: {
      profile_id: 'c107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2', revision: 1, tenant_id: tenantId,
      connector_bindings: { default: { connectorId, revision: 1 } },
    } },
  ];

  assert.deepEqual(await adapter.sink.validatePlan(writes), []);
  assert.equal((connectorTargetPool.tables.get('connector_revisions') || []).length, 0);
  assert.deepEqual(await adapter.sink.applyImmutableBatch(writes), ['inserted', 'inserted']);
  assert.equal(connectorTargetPool.tables.get('connector_revisions').length, 1);
  assert.equal(targetPool.tables.get('profile_bindings').length, 1);
});

test('A2 provenance failure after Connector commit is reported as partial hold and same-source replay completes it', async () => {
  const { adapter, targetPool, connectorTargetPool } = createTestAdapter();
  await adapter.sink.seedTenantByName('legacy-default');
  await adapter.sink.resolveTenantIdsByName('legacy-default');
  adapter.sourceSnapshot = { sha256: 'd'.repeat(64), rowCounts: { Connector: 1 } };
  targetPool.failLegacyMigrationInsert = true;
  const writes = [
    { entity: 'connector_revisions', key: 'provenance-connector||1', value: {
      connector_id: 'provenance-connector', tenant_id: '', revision: 1, state: 'RETIRED', config: {},
      credential_source: { kind: 'legacy-db', credentialRef: 'opaque' },
    } },
    { entity: 'api_keys', key: 'provenance-key', value: { id: 'provenance-key', tenant_id: 'tenant', hash: 'hash' } },
  ];

  await assert.rejects(adapter.sink.applyImmutableBatch(writes), (error) => error.code === 'CROSS_PLANE_PARTIAL'
    && error.phaseFailureCode === 'ORCHESTRATOR_WRITE_FAILED' && error.replayRequired === true);
  assert.equal(connectorTargetPool.tables.get('connector_revisions').length, 1);
  assert.equal(targetPool.tables.has('api_keys'), false);
  assert.equal(targetPool.tables.has('legacy_migration_runs'), false);

  targetPool.failLegacyMigrationInsert = false;
  assert.deepEqual(await adapter.sink.applyImmutableBatch(writes), ['identical', 'inserted']);
  assert.equal(targetPool.tables.get('legacy_migration_runs').length, 1);
  assert.equal(adapter.importProvenance.sourceVersion, 'synthetic-v1');
});

test('A2 reports a held partial result when Connector commits and Orchestrator fails, then exact replay completes', async () => {
  const { adapter, targetPool, connectorTargetPool } = createTestAdapter();
  let failOrchestratorInsert = true;
  const originalTargetQuery = targetPool.query;
  targetPool.query = async (sql, values) => {
    if (failOrchestratorInsert && sql.startsWith('INSERT INTO "api_keys"')) throw new Error('fixture Orchestrator failure');
    return originalTargetQuery.call(targetPool, sql, values);
  };
  const writes = [
    { entity: 'connector_revisions', key: 'connector| |1', value: { connector_id: 'connector', tenant_id: '', revision: 1, state: 'RETIRED', config: {}, credential_source: { kind: 'legacy-db', credentialRef: 'opaque' } } },
    { entity: 'api_keys', key: 'orchestrator-key', value: { id: 'orchestrator-key', tenant_id: 'tenant', hash: 'h' } },
  ];
  await assert.rejects(adapter.sink.applyImmutableBatch(writes), (error) => error.code === 'CROSS_PLANE_PARTIAL' && error.connectorRowsCommitted === 1 && error.phase === 'orchestrator');
  assert.equal(connectorTargetPool.tables.get('connector_revisions').length, 1);
  assert.equal(targetPool.tables.has('api_keys'), false);
  failOrchestratorInsert = false;
  assert.deepEqual(await adapter.sink.applyImmutableBatch(writes), ['identical', 'inserted']);
  assert.equal(connectorTargetPool.tables.get('connector_revisions').length, 1);
  assert.equal(targetPool.tables.get('api_keys').length, 1);
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

test('ORV11 frozen scan uses one repeatable-read transaction and reuses immutable snapshot', async () => {
  const { adapter, sourcePool } = createTestAdapter();
  await adapter.source.scan('Operation');
  const calls = sourcePool.calls.length;
  await adapter.source.scan('ApiKey');
  assert.equal(sourcePool.calls.length, calls);
  assert.equal(sourcePool.calls.filter((call) => /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/.test(call.sql)).length, 1);
  assert.equal(sourcePool.calls.filter((call) => /^COMMIT$/.test(call.sql)).length, 1);
  assert.match(adapter.sourceSnapshot.sha256, /^[a-f0-9]{64}$/);
});

test('ORV11 real evidence binds approved file digest, frozen source digest and UTC observation', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { createHash } = require('node:crypto');
  const base = createTestAdapter();
  const rows = await base.adapter.source.scan('Operation');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orv11-timezone-'));
  const proofPath = path.join(dir, 'proof.json');
  const proof = {
    sourceVersion: 'synthetic-v1', timezone: 'UTC', sourceDataSha256: base.adapter.sourceSnapshot.sha256,
    reviewedBy: 'synthetic-fixture-reviewer',
    observations: [{ table: 'Operation', sourceKey: rows[0].id, field: 'createdAt', naive: rows[0].createdAt, utc: '2026-01-01T00:00:00.000Z', reference: 'isolated-fixture-known-UTC-clock' }],
  };
  const make = (value) => {
    const bytes = Buffer.from(JSON.stringify(value));
    fs.writeFileSync(proofPath, bytes);
    return createTestAdapter({ env: { LDBA03_TIMEZONE_EVIDENCE_FILE: proofPath, LDBA03_TIMEZONE_EVIDENCE_SHA256: createHash('sha256').update(bytes).digest('hex') } }).adapter;
  };
  try {
    const valid = make(proof);
    await valid.source.scan('Operation');
    assert.equal(valid.timezoneEvidence.verified, true);
    const wrongSource = make({ ...proof, sourceDataSha256: 'a'.repeat(64) });
    await assert.rejects(wrongSource.source.scan('Operation'), (error) => error.code === 'INVALID_TIMEZONE_EVIDENCE');
    const wrongClock = make({ ...proof, observations: [{ ...proof.observations[0], utc: '2026-01-01T07:00:00.000Z' }] });
    await assert.rejects(wrongClock.source.scan('Operation'), (error) => error.code === 'TIMEZONE_OBSERVATION_MISMATCH');
    const digestMismatch = make(proof);
    fs.appendFileSync(proofPath, '\n');
    await assert.rejects(digestMismatch.source.scan('Operation'), (error) => error.code === 'TIMEZONE_EVIDENCE_DIGEST_MISMATCH');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('ORV11 maps core subcases and workflow slugs through enabled business registry', async () => {
  const targetPool = fakeTargetPool();
  const oldQuery = targetPool.query;
  targetPool.query = async (sql, values) => /^SELECT business_id, version, manifest/.test(sql)
    ? result([{ business_id: 'document-core', version: '1.0.0', manifest: { actions: [{ name: 'extract' }, { name: 'schema-workflow' }] } }, { business_id: 'lc-checker', version: '1.0.0', manifest: { actions: [{ name: 'lc-checker' }] } }])
    : oldQuery.call(targetPool, sql, values);
  const { adapter } = createTestAdapter({ targetPool });
  await adapter.source.scan('Operation');
  assert.equal(adapter.context.resolveBusinessAction('extract:invoice').action, 'extract');
  assert.equal(adapter.context.resolveBusinessAction('workflows:schema:invoice').action, 'schema-workflow');
  assert.equal(adapter.context.resolveBusinessAction('workflows:lc-checker').businessId, 'lc-checker');
  assert.equal(adapter.context.resolveBusinessAction('unknown:invoice'), null);
});

test('ORV11 connector replay authenticates unchanged secret and rejects changed/corrupt ciphertext', async () => {
  const { randomBytes, createCipheriv } = require('node:crypto');
  const key = randomBytes(32);
  const encrypt = (text) => {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, iv);
    const body = Buffer.concat([cipher.update(text), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), body]);
  };
  let stored = encrypt('same-fixture-secret');
  let source = 'same-fixture-secret';
  const connectorTargetPool = fakeTargetPool();
  const query = connectorTargetPool.query;
  connectorTargetPool.query = (sql, values) => sql.startsWith('SELECT encrypted_value FROM secret_versions') ? Promise.resolve(result([{ encrypted_value: stored }])) : query.call(connectorTargetPool, sql, values);
  const { adapter } = createTestAdapter({ connectorTargetPool, env: { CONNECTOR_ENCRYPTION_KEY: key.toString('base64') }, context: { prepareConnector: () => ({ revision: {}, secret: { id: 'fixture', credential_ref: 'fixture', encrypted_value: encrypt(source) } }) } });
  assert.deepEqual((await adapter.context.prepareConnector({}, {})).secret.encrypted_value, stored);
  source = 'changed';
  await assert.rejects(adapter.context.prepareConnector({}, {}), (error) => error.code === 'SECRET_REPLAY_CONFLICT');
  source = 'same-fixture-secret';
  stored = Buffer.from(stored); stored[16] ^= 1;
  await assert.rejects(adapter.context.prepareConnector({}, {}), (error) => error.code === 'SECRET_REPLAY_CONFLICT');
});

test('ORV11 schema replay authenticates AAD/ciphertext and reuses immutable sealed bytes', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { randomBytes, createCipheriv, createHash } = require('node:crypto');
  const request = { tenantId: 'fixture-tenant', slug: 'fixture-schema', revision: 1 };
  const aad = createHash('sha256').update('fixture-tenant|legacy_workflow_schemas.schema_ref|fixture-schema:1').digest();
  const seal = (text) => {
    const key = randomBytes(32); const nonce = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', key, nonce); cipher.setAAD(aad);
    const body = Buffer.concat([cipher.update(text), cipher.final()]);
    return { version: 1, algorithm: 'aes-256-gcm', dek: { fixtureKey: key.toString('base64') }, nonce: nonce.toString('base64'), aad: aad.toString('base64'), tag: cipher.getAuthTag().toString('base64'), ciphertext: body.toString('base64'), plaintextSha256: createHash('sha256').update(text).digest('hex') };
  };
  let stored = seal('{"fixture":true}');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orv11-schema-'));
  const seam = path.join(dir, 'seam.cjs');
  fs.writeFileSync(seam, "module.exports={unwrapDek:async value=>Buffer.from(value.fixtureKey,'base64')};\n");
  const targetPool = fakeTargetPool(); const query = targetPool.query;
  targetPool.query = (sql, values) => sql.startsWith('SELECT digest, schema_ref') ? Promise.resolve(result([{ digest: 'fixture-digest', schema_ref: stored }])) : query.call(targetPool, sql, values);
  try {
    const { adapter } = createTestAdapter({ targetPool, env: { LDBA03_METADATA_SEAM_MODULE: seam }, context: { prepareWorkflowSchema: () => ({ digest: 'fixture-digest', schemaRef: seal('{"fixture":true}') }) } });
    assert.deepEqual((await adapter.context.prepareWorkflowSchema({}, request)).schemaRef, stored);
    stored = { ...stored, aad: Buffer.alloc(32).toString('base64') };
    await assert.rejects(adapter.context.prepareWorkflowSchema({}, request), (error) => error.code === 'WORKFLOW_REPLAY_CONFLICT');
    stored = seal('{"fixture":false}');
    await assert.rejects(adapter.context.prepareWorkflowSchema({}, request), (error) => error.code === 'WORKFLOW_REPLAY_CONFLICT');
    stored = seal('{"fixture":true}'); stored.tag = Buffer.alloc(16).toString('base64');
    await assert.rejects(adapter.context.prepareWorkflowSchema({}, request), (error) => error.code === 'WORKFLOW_REPLAY_CONFLICT');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
