'use strict';

const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { isDeepStrictEqual } = require('node:util');
const test = require('node:test');

const { LEGACY_TABLES, runBackfill } = require('../scripts/ldba-03-backfill.cjs');
const { inventory } = require('../scripts/ldba-inventory.cjs');

const tenantId = 'a107ae7b-4a2b-40ee-a9a8-9b89b7ff79a2';
const sourceVersion = 'orv15-artifact-fixture-v1';
const artifactId = 'd0fd5849-9c9c-4e4e-9d6c-00cd5ee6e4a7';

function artifactSource(bytes, metadataOverrides = {}) {
  return {
    id: artifactId,
    md5Hash: createHash('md5').update(bytes).digest('hex'),
    s3Key: 'fixture-object-key',
    fileName: 'fixture.pdf',
    mimeType: 'application/pdf',
    size: bytes.length,
    refCount: 1,
    createdAt: '2026-10-12 04:00:00.000',
    lastAccessedAt: null,
    ...metadataOverrides,
  };
}

function migrationFixture(sourceRow, returnedBytes) {
  const tables = Object.fromEntries(LEGACY_TABLES.map((table) => [table, []]));
  tables.FileCache = [sourceRow];
  const target = new Map();
  let applyCalls = 0;
  const adapter = {
    a1Passed: true,
    sourceVersion,
    a1SourceVersion: sourceVersion,
    timezoneEvidence: { verified: true, sourceVersion, timezone: 'UTC', sha256: 'a'.repeat(64) },
    source: { async scan(table) { return tables[table]; } },
    sink: {
      async resolveTenantIdsByName(name) {
        assert.equal(name, 'legacy-default');
        return [tenantId];
      },
      async seedTenantByName() { throw new Error('fixture is preseeded'); },
      async assertTargetSeparation() {},
      async validatePlan() { return []; },
      async inspectImmutable(item) {
        const prior = target.get(item.entity + '|' + item.key);
        if (prior === undefined) return 'new';
        return isDeepStrictEqual(prior, item.value) ? 'identical' : 'conflict';
      },
      async applyImmutableBatch(items) {
        applyCalls += 1;
        return items.map((item) => {
          const key = item.entity + '|' + item.key;
          const prior = target.get(key);
          if (prior !== undefined) {
            if (!isDeepStrictEqual(prior, item.value)) throw new Error('fixture immutable target conflict');
            return 'identical';
          }
          target.set(key, structuredClone(item.value));
          return 'inserted';
        });
      },
    },
    context: {
      async readFileCacheBytes(key) {
        assert.equal(key, sourceRow.s3Key);
        return returnedBytes;
      },
      artifactTokenFor() { return 'a'.repeat(64); },
      artifactPurposeFor() { return 'input'; },
    },
  };
  return { adapter, target, getApplyCalls: () => applyCalls };
}

function inventoryPool(artifacts) {
  const provenance = {
    source_sha256: '1'.repeat(64),
    plan_sha256: '2'.repeat(64),
    source_counts: { FileCache: artifacts.length },
    destination_counts: { artifacts: artifacts.length, artifact_blobs: artifacts.length },
  };
  const client = {
    async query(sql, values = []) {
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(sql)) return { rows: [], rowCount: 0 };
      if (/SELECT to_regclass\(\$1\)::text AS relation/.test(sql)) return { rows: [{ relation: values[0] }] };
      if (/FROM legacy_migration_runs/.test(sql)) return { rows: [provenance] };
      if (/FROM artifacts a LEFT JOIN artifact_blobs/.test(sql)) return { rows: artifacts };
      if (/SELECT count\(\)::int AS count FROM operations/.test(sql)) return { rows: [{ count: 0 }] };
      return { rows: [], rowCount: 0 };
    },
    release() {},
  };
  return { async connect() { return client; } };
}

function inventoryArtifact(id, bytes, expectedSha256, sizeBytes) {
  return {
    id,
    operation_id: null,
    task_id: null,
    purpose: 'input',
    storage_key: 'legacy-filecache/' + id,
    sha256: expectedSha256,
    size_bytes: sizeBytes,
    state: 'READY',
    storage_backend: 'postgres',
    storage_version_id: null,
    manifest_version_id: null,
    storage_generation_id: null,
    bytes,
  };
}

test('source artifact size and MD5 mismatches block the public import before target writes', async (t) => {
  const correctBytes = Buffer.from('synthetic-native19-artifact');
  const sizeMismatch = migrationFixture(
    artifactSource(correctBytes),
    Buffer.from('synthetic-native19-artifact-with-extra'),
  );
  const sizeReport = await runBackfill(sizeMismatch.adapter, { apply: true, skipPolicy: 'report' });
  assert.equal(sizeReport.status, 'BLOCKED_TRANSFORM');
  assert.equal(sizeReport.failures[0].code, 'ARTIFACT_SIZE_MISMATCH');
  assert.equal(sizeMismatch.getApplyCalls(), 0);
  assert.equal(sizeMismatch.target.size, 0);

  await t.test('matching byte count with a different source digest also fails closed', async () => {
    const sameLengthWrongBytes = Buffer.from('SYNTHETIC-NATIVE19-ARTIFACT');
    assert.equal(sameLengthWrongBytes.length, correctBytes.length);
    const digestMismatch = migrationFixture(artifactSource(correctBytes), sameLengthWrongBytes);
    const report = await runBackfill(digestMismatch.adapter, { apply: true, skipPolicy: 'report' });
    assert.equal(report.status, 'BLOCKED_TRANSFORM');
    assert.equal(report.failures[0].code, 'ARTIFACT_MD5_MISMATCH');
    assert.equal(digestMismatch.getApplyCalls(), 0);
    assert.equal(digestMismatch.target.size, 0);
  });
});

test('inventory verifies actual PostgreSQL blob digest and size and reports aggregate counts without bytes', async () => {
  const validBytes = Buffer.from('orv15-valid-artifact');
  const wrongDigestBytes = Buffer.from('orv15-wrong-digest');
  const wrongSizeBytes = Buffer.from('orv15-wrong-size');
  const artifacts = [
    inventoryArtifact('artifact-valid', validBytes, createHash('sha256').update(validBytes).digest('hex'), validBytes.length),
    inventoryArtifact('artifact-digest-mismatch', wrongDigestBytes, 'f'.repeat(64), wrongDigestBytes.length),
    inventoryArtifact('artifact-size-mismatch', wrongSizeBytes, createHash('sha256').update(wrongSizeBytes).digest('hex'), wrongSizeBytes.length + 1),
  ];

  const report = await inventory(inventoryPool(artifacts), tenantId, sourceVersion);
  assert.equal(report.targetCounts.artifacts, 3);
  assert.equal(report.targetCounts.postgresArtifactsVerified, 1);
  assert.equal(report.capabilities.history.artifacts, 3);
  assert.equal(report.capabilities.history.postgresArtifactsVerified, 1);
  assert.equal(report.metrics.verifiedBlobBytes, validBytes.length + wrongDigestBytes.length + wrongSizeBytes.length);
  assert.deepEqual(report.blobChecks.map((item) => [item.id, item.actualSha256 === item.expectedSha256, item.sizeMatches]), [
    ['artifact-valid', true, true],
    ['artifact-digest-mismatch', false, true],
    ['artifact-size-mismatch', true, false],
  ]);
  assert.deepEqual(report.issues.filter((item) => item.code === 'BLOB_INTEGRITY_FAILED').map((item) => item.id), [
    'artifact-digest-mismatch', 'artifact-size-mismatch',
  ]);
  const serialized = JSON.stringify(report);
  for (const bytes of artifacts.map((item) => item.bytes)) {
    assert.equal(serialized.includes(bytes.toString('utf8')), false);
  }
});

test('inventory rejects a PostgreSQL blob snapshot above its configured byte limit', async () => {
  const bytes = Buffer.from('orv15-byte-limit');
  const prior = process.env.LDBA_INVENTORY_MAX_BLOB_BYTES;
  process.env.LDBA_INVENTORY_MAX_BLOB_BYTES = String(bytes.length - 1);
  try {
    await assert.rejects(
      inventory(inventoryPool([
        inventoryArtifact('artifact-over-limit', bytes, createHash('sha256').update(bytes).digest('hex'), bytes.length),
      ]), tenantId, sourceVersion),
      (error) => error.code === 'INVENTORY_BLOB_LIMIT_EXCEEDED',
    );
  } finally {
    if (prior === undefined) delete process.env.LDBA_INVENTORY_MAX_BLOB_BYTES;
    else process.env.LDBA_INVENTORY_MAX_BLOB_BYTES = prior;
  }
});
