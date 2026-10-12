'use strict';

const { hash, fail } = require('./ldba-inventory.cjs');

const TABLES = Object.freeze([
  'Operation', 'ApiKey', 'ExternalApiConnection', 'ExternalApiOverride',
  'ProfileEndpoint', 'AppSetting', 'FileCache', 'User', 'UserProfileAssignment',
]);

function normalizeLegacyTimestamp(value) {
  if (value instanceof Date) return value.toISOString();
  if (typeof value !== 'string') fail('SOURCE_SETTING_TIMESTAMP_INVALID');
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?$/.exec(value);
  if (!match) fail('SOURCE_SETTING_TIMESTAMP_INVALID');
  const date = new Date(Date.UTC(
    Number(match[1]), Number(match[2]) - 1, Number(match[3]),
    Number(match[4]), Number(match[5]), Number(match[6]),
    Number((match[7] || '').padEnd(3, '0').slice(0, 3)),
  ));
  if (!Number.isFinite(date.getTime())) fail('SOURCE_SETTING_TIMESTAMP_INVALID');
  return date.toISOString();
}

function sourceSettingsSha256(rows) {
  const relevant = rows.filter(row => typeof row.key === 'string' && !row.key.startsWith('wb_schema:'));
  return hash(relevant.map(row => ({
    key: row.key,
    valueSha256: hash(row.value),
    updatedAt: normalizeLegacyTimestamp(row.updatedAt),
  })));
}

function compareCounts(actual, expected) {
  if (!expected || typeof expected !== 'object' || Array.isArray(expected)) fail('SOURCE_ROW_COUNT_PIN_REQUIRED');
  const keys = Object.keys(expected).sort();
  if (keys.join('|') !== [...TABLES].sort().join('|')) fail('SOURCE_ROW_COUNT_PIN_INVALID');
  for (const table of TABLES) {
    const count = expected[table];
    if (!Number.isSafeInteger(count) || count < 0 || actual[table] !== count) fail('SOURCE_ROW_COUNTS_CHANGED');
  }
}

/**
 * Read the nine legacy tables through the production adapter's single frozen,
 * repeatable-read snapshot. Source values remain in process memory; callers
 * receive them only for approved server-side mapping and credential import.
 */
async function readFrozenSource(options = {}) {
  const env = options.env || process.env;
  const Pool = options.Pool || require('pg').Pool;
  const sourceUrl = options.sourceUrl || env.LDBA03_SOURCE_DATABASE_URL;
  const targetUrl = options.targetUrl || env.LDBA03_TARGET_DATABASE_URL;
  if (typeof sourceUrl !== 'string' || !sourceUrl || typeof targetUrl !== 'string' || !targetUrl) fail('SOURCE_AND_TARGET_DATABASES_REQUIRED');
  if (sourceUrl === targetUrl) fail('SOURCE_TARGET_DATABASES_MUST_DIFFER');

  let adapter;
  if (typeof options.createAdapter === 'function') {
    adapter = options.createAdapter({
      env,
      Pool,
      sourceConnectionString: sourceUrl,
      targetConnectionString: targetUrl,
    });
  } else {
    const previous = process.env.LDBA03_ADAPTER_LIBRARY;
    process.env.LDBA03_ADAPTER_LIBRARY = '1';
    try {
      const adapterModule = require('./ldba-03-production-adapter.cjs');
      adapter = adapterModule.createAdapter({
        env,
        Pool,
        sourceConnectionString: sourceUrl,
        targetConnectionString: targetUrl,
      });
    } finally {
      if (previous === undefined) delete process.env.LDBA03_ADAPTER_LIBRARY;
      else process.env.LDBA03_ADAPTER_LIBRARY = previous;
    }
  }

  try {
    const tables = Object.create(null);
    for (const table of TABLES) tables[table] = await adapter.source.scan(table);
    const sourceSnapshot = adapter.sourceSnapshot;
    if (!sourceSnapshot || !/^[a-f0-9]{64}$/.test(sourceSnapshot.sha256 || '')) fail('SOURCE_SNAPSHOT_UNAVAILABLE');
    if (adapter.sourceVersion !== options.manifest.sourceVersion) fail('SOURCE_VERSION_MISMATCH');
    if (sourceSnapshot.sha256 !== options.manifest.sourceSha256) fail('SOURCE_SNAPSHOT_HASH_MISMATCH');
    compareCounts(sourceSnapshot.rowCounts, options.manifest.sourceRowCounts);
    const timezone = adapter.timezoneEvidence;
    if (!timezone || timezone.verified !== true || timezone.sourceVersion !== options.manifest.sourceVersion
        || timezone.timezone !== 'UTC' || timezone.sha256 !== options.manifest.timezoneEvidenceSha256) {
      fail('SOURCE_TIMEZONE_EVIDENCE_MISMATCH');
    }
    const settingsSha256 = sourceSettingsSha256(tables.AppSetting);
    if (settingsSha256 !== options.manifest.archivedSettingsSha256) fail('SOURCE_SETTINGS_ARCHIVE_MISMATCH');
    return {
      tables,
      sourceSha256: sourceSnapshot.sha256,
      sourceRowCounts: { ...sourceSnapshot.rowCounts },
      timezoneEvidenceSha256: timezone.sha256,
      sourceSettingsSha256: settingsSha256,
    };
  } finally {
    await adapter.close();
  }
}

module.exports = { TABLES, compareCounts, normalizeLegacyTimestamp, readFrozenSource, sourceSettingsSha256 };
