'use strict';

const assert = require('node:assert/strict');
const { createCipheriv, createHash } = require('node:crypto');
const test = require('node:test');

process.env.LDBA03_ADAPTER_LIBRARY = '1';
const { createAdapter, ENTITY_SPECS } = require('../scripts/ldba-03-production-adapter.cjs');
const { LEGACY_TABLES, runBackfill } = require('../scripts/ldba-03-backfill.cjs');

const tenantId = 'a107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2';
const sourceVersion = 'orv15-synthetic-native19-v1';

function result(rows = [], rowCount = rows.length) {
  return { rows, rowCount };
}

function snapshotTables(tables) {
  return new Map([...tables].map(([name, rows]) => [name, structuredClone(rows)]));
}

function fakeTargetPool(plane, identity) {
  const tables = new Map();
  const calls = [];
  const tenants = [{ id: tenantId, name: 'legacy-default' }];
  let transaction = null;

  function tableRows(name) {
    if (!tables.has(name)) tables.set(name, []);
    return tables.get(name);
  }

  async function query(sql, values = []) {
    calls.push({ sql, values });
    if (/SELECT current_database\(\) AS database_name/.test(sql)) return result([identity]);
    if (/^SELECT state FROM "(?:connector_backup_effect_gate|maintenance_backup_effect_gate)"/.test(sql)) {
      return result([{ state: 'OPEN' }]);
    }
    if (/^SELECT business_id, version, manifest FROM business_versions/.test(sql)) return result();
    if (/^SELECT id::text AS id FROM tenants WHERE name = \$1/.test(sql)) {
      return result(tenants.filter((row) => row.name === values[0]).map((row) => ({ id: row.id })));
    }
    if (/^SELECT encrypted_value FROM secret_versions WHERE id = \$1 AND credential_ref = \$2/.test(sql)) {
      return result(tableRows('secret_versions')
        .filter((row) => row.id === values[0] && row.credential_ref === values[1])
        .map((row) => ({ encrypted_value: row.encrypted_value })));
    }
    if (/^INSERT INTO legacy_migration_runs/.test(sql)) {
      const rows = tableRows('legacy_migration_runs');
      const [rowTenantId, version, sourceSha256, planSha256, sourceCounts, destinationCounts] = values;
      if (rows.some((row) => row.tenant_id === rowTenantId && row.source_version === version)) return result();
      rows.push({ tenant_id: rowTenantId, source_version: version, source_sha256: sourceSha256,
        plan_sha256: planSha256, source_counts: sourceCounts, destination_counts: destinationCounts });
      return result([{ source_version: version }]);
    }
    if (/^SELECT source_sha256,plan_sha256 FROM legacy_migration_runs/.test(sql)) {
      return result(tableRows('legacy_migration_runs')
        .filter((row) => row.tenant_id === values[0] && row.source_version === values[1])
        .map(({ source_sha256, plan_sha256 }) => ({ source_sha256, plan_sha256 })));
    }
    if (/^BEGIN$/.test(sql)) {
      transaction = snapshotTables(tables);
      return result();
    }
    if (/^COMMIT$/.test(sql)) {
      transaction = null;
      return result();
    }
    if (/^ROLLBACK$/.test(sql)) {
      if (transaction) {
        tables.clear();
        for (const [name, rows] of transaction) tables.set(name, rows);
      }
      transaction = null;
      return result();
    }
    if (/^(?:SAVEPOINT|RELEASE SAVEPOINT|ROLLBACK TO SAVEPOINT)/.test(sql)) return result();

    const insert = /^INSERT INTO "([A-Za-z_][A-Za-z0-9_$]*)" \(([^)]+)\).* RETURNING /.exec(sql);
    if (insert) {
      const [, table, columnText] = insert;
      const columns = columnText.split(', ').map((column) => column.slice(1, -1));
      const row = Object.fromEntries(columns.map((column, index) => [column, values[index]]));
      const keyColumns = ENTITY_SPECS[table].key;
      const rows = tableRows(table);
      const prior = rows.find((candidate) => keyColumns.every((column) => candidate[column] === row[column]));
      if (prior) return result();
      rows.push(row);
      return result([Object.fromEntries(keyColumns.map((column) => [column, row[column]]))]);
    }
    const select = /^SELECT \* FROM "([A-Za-z_][A-Za-z0-9_$]*)" WHERE (.+) LIMIT 2$/.exec(sql);
    if (select) {
      const [, table, where] = select;
      const columns = [...where.matchAll(/"([A-Za-z_][A-Za-z0-9_$]*)" = \$(\d+)/g)];
      const matches = tableRows(table).filter((row) => columns.every((match) =>
        row[match[1]] === values[Number(match[2]) - 1]));
      return result(matches.slice(0, 2));
    }
    throw new Error(`unexpected ${plane} target query at injected pool seam`);
  }

  return {
    plane,
    calls,
    tables,
    query,
    async connect() {
      return { query, release() {} };
    },
    async end() {},
  };
}

function encryptedFixtureSecret(value) {
  const key = Buffer.alloc(32, 0x5a);
  const iv = createHash('sha256').update('orv15-migration-fixture-iv').digest().subarray(0, 12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const body = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
  const envelope = Buffer.concat([iv, cipher.getAuthTag(), body]);
  key.fill(0);
  return envelope;
}

function sourceConnector() {
  return {
    id: 'native19-connector-source-1',
    name: 'Synthetic legacy connector',
    slug: 'synthetic-legacy',
    description: null,
    endpointUrl: 'https://provider.invalid/synthetic',
    httpMethod: 'POST',
    authType: 'bearer',
    authKeyHeader: 'Authorization',
    authSecret: 'never-log-this-synthetic-secret',
    promptFieldName: 'prompt',
    fileFieldName: null,
    fileUrlFieldName: null,
    defaultPrompt: 'synthetic fixture prompt',
    staticFormFields: '{}',
    extraHeaders: '{}',
    responseContentPath: null,
    sessionIdResponsePath: null,
    sessionIdFieldName: null,
    timeoutSec: 30,
    state: 'ENABLED',
    createdAt: '2026-10-12 04:00:00.000',
  };
}

function createFixture() {
  const sourcePool = { async query() { throw new Error('source query is not used by this injected scan fixture'); }, async connect() { throw new Error('source query is not used by this injected scan fixture'); } };
  const orchestratorPool = fakeTargetPool('orchestrator', {
    database_name: 'orv15-orchestrator', database_oid: '101', system_identifier: '9001',
  });
  const connectorPool = fakeTargetPool('connector', {
    database_name: 'orv15-connector', database_oid: '102', system_identifier: '9001',
  });
  const env = {
    LDBA_A1_PASSED: '1',
    LDBA_A1_SOURCE_VERSION: sourceVersion,
    LDBA03_SOURCE_VERSION: sourceVersion,
    CONNECTOR_ENCRYPTION_KEY: Buffer.alloc(32, 0x5a).toString('base64'),
  };
  const adapter = createAdapter({
    sourcePool,
    targetPool: orchestratorPool,
    connectorTargetPool: connectorPool,
    env,
    context: {
      prepareConnector(row, request) {
        const credentialRef = 'legacy-credential:' + row.id;
        return {
          revision: {
            connector_id: request.connectorId,
            tenant_id: '',
            revision: request.revisionNumber,
            state: request.state,
            config: request.config,
            credential_ref: credentialRef,
            credential_source: { kind: 'legacy-db', credentialRef },
            createdAt: request.createdAt,
            account_id: null,
          },
          secret: {
            id: 'legacy-secret:' + row.id,
            credential_ref: credentialRef,
            encrypted_value: encryptedFixtureSecret(row.authSecret),
          },
        };
      },
    },
  });
  const tables = Object.fromEntries(LEGACY_TABLES.map((table) => [table, []]));
  tables.ExternalApiConnection = [sourceConnector()];
  adapter.source.scan = async (table) => tables[table];
  adapter.sourceSnapshot = {
    sha256: createHash('sha256').update('synthetic-frozen-native19-source-v1').digest('hex'),
    rowCounts: Object.fromEntries(LEGACY_TABLES.map((table) => [table, tables[table].length])),
  };
  adapter.timezoneEvidence = { verified: true, sourceVersion, timezone: 'UTC', sha256: 'c'.repeat(64) };
  return { adapter, orchestratorPool, connectorPool };
}

test('Native A2 runner imports connector revision and secret to Connector plane and journals same-source replay', async () => {
  const { adapter, orchestratorPool, connectorPool } = createFixture();

  const first = await runBackfill(adapter, { apply: true, skipPolicy: 'report' });
  assert.equal(first.status, 'APPLIED');
  assert.equal(first.sourceRows.read, 1);
  assert.equal(first.sourceRows.written, 1);
  assert.equal(first.destinationRows.written, 2);
  assert.equal(first.importProvenance.sourceVersion, sourceVersion);

  assert.equal(connectorPool.tables.get('connector_revisions')?.length, 1);
  assert.equal(connectorPool.tables.get('secret_versions')?.length, 1);
  assert.equal(orchestratorPool.tables.has('connector_revisions'), false);
  assert.equal(orchestratorPool.tables.has('secret_versions'), false);
  assert.equal(orchestratorPool.tables.get('legacy_migration_runs')?.length, 1);
  assert.equal(connectorPool.calls.some(({ sql }) => /(?:INSERT INTO|SELECT \* FROM) "secret_versions"/.test(sql)), true);
  assert.equal(orchestratorPool.calls.some(({ sql }) => /(?:INSERT INTO|SELECT \* FROM) "secret_versions"/.test(sql)), false);

  const second = await runBackfill(adapter, { apply: true, skipPolicy: 'report' });
  assert.equal(second.status, 'APPLIED');
  assert.equal(second.sourceRows.skipped, 1);
  assert.equal(connectorPool.tables.get('connector_revisions')?.length, 1);
  assert.equal(connectorPool.tables.get('secret_versions')?.length, 1);
  assert.equal(orchestratorPool.tables.get('legacy_migration_runs')?.length, 1);
  assert.equal(adapter.importProvenance.sourceSha256, adapter.sourceSnapshot.sha256);
  assert.match(adapter.importProvenance.planSha256, /^[a-f0-9]{64}$/);
});
