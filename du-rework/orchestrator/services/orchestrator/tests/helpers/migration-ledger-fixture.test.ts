import { mockMigrationMetadataColumnsResult } from './migration-ledger-fixture';

const metadataQuery = `SELECT column_name FROM information_schema.columns
WHERE table_schema = current_schema() AND table_name = $1 AND column_name = ANY($2::text[])`;
const metadataNames = ['checksum', 'checksum_provenance', 'baseline_reviewed_at'];

describe('mockMigrationMetadataColumnsResult', () => {
  it('returns only requested metadata columns for the current schema_migrations table', () => {
    expect(mockMigrationMetadataColumnsResult(metadataQuery, ['schema_migrations', metadataNames])).toEqual({
      rows: metadataNames.map((column_name) => ({ column_name })),
      rowCount: 3,
    });
    expect(mockMigrationMetadataColumnsResult(metadataQuery, ['schema_migrations', ['checksum', 'other_column']])).toEqual({
      rows: [{ column_name: 'checksum' }],
      rowCount: 1,
    });
  });

  it('leaves unrelated table or schema catalog queries to their normal mock behavior', () => {
    expect(mockMigrationMetadataColumnsResult(metadataQuery, ['unrelated_table', metadataNames])).toBeNull();
    expect(mockMigrationMetadataColumnsResult(metadataQuery.replace('current_schema()', '$3'), [
      'schema_migrations',
      metadataNames,
      'other_schema',
    ])).toBeNull();
  });
});
