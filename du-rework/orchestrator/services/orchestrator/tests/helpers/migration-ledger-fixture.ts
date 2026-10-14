import { join } from 'node:path';
import { loadMigrationFiles } from '../../src/db/migrations';

const MIGRATION_LEDGER_METADATA_COLUMNS = ['checksum', 'checksum_provenance', 'baseline_reviewed_at'] as const;

export interface MigrationLedgerFixtureRow {
  sequence: number;
  filename: string;
  checksum: string;
  checksum_provenance: 'migration';
  baseline_reviewed_at: null;
}

export function mockMigrationMetadataColumnsResult(
  sql: string,
  params: unknown[] = [],
): { rows: Array<{ column_name: string }>; rowCount: number } | null {
  const normalizedSql = String(sql).replace(/\s+/g, ' ').trim();
  const isScopedMetadataQuery =
    /\binformation_schema\.columns\b/i.test(normalizedSql) &&
    /\btable_schema\s*=\s*current_schema\s*\(\s*\)/i.test(normalizedSql) &&
    /\btable_name\s*=\s*\$1\b/i.test(normalizedSql) &&
    /\bcolumn_name\s*=\s*any\s*\(\s*\$2::text\[\]\s*\)/i.test(normalizedSql);
  if (!isScopedMetadataQuery || params[0] !== 'schema_migrations' || !Array.isArray(params[1])) return null;

  const requestedColumns = new Set((params[1] as unknown[]).filter((column): column is string => typeof column === 'string'));
  const rows = MIGRATION_LEDGER_METADATA_COLUMNS
    .filter((column_name) => requestedColumns.has(column_name))
    .map((column_name) => ({ column_name }));
  return { rows, rowCount: rows.length };
}

/** A current-runner ledger fixture for app-boot tests, with real file hashes. */
export function currentAppliedMigrationLedger(): MigrationLedgerFixtureRow[] {
  const migrationDirectory = join(__dirname, '..', '..', 'migrations');
  return loadMigrationFiles(migrationDirectory).map((migration) => ({
    sequence: migration.sequence,
    filename: migration.filename,
    checksum: migration.checksum,
    checksum_provenance: 'migration',
    baseline_reviewed_at: null,
  }));
}
