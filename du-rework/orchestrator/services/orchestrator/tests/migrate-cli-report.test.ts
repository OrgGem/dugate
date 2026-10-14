import type { MigrationFile, MigrationStatus } from '../src/db/migrations';
import {
  migrationApplyReport,
  migrationFailureReport,
  migrationStatusReport,
  migrationVerifyReport,
} from '../src/migration-cli-report';

const files: MigrationFile[] = [
  {
    filename: '0001_initial.sql',
    sequence: 1,
    sql: 'CREATE TABLE IF NOT EXISTS safe_table (id integer);\nCREATE INDEX IF NOT EXISTS safe_table_state_idx ON safe_table(id);',
    checksum: 'a'.repeat(64),
  },
];

function status(overrides: Partial<MigrationStatus> = {}): MigrationStatus {
  return {
    total: 1,
    applied: 1,
    pending: [],
    unknownChecksums: [],
    baselineProvenance: [],
    integrityProblems: [],
    ...overrides,
  };
}

describe('Orchestrator migration CLI reports', () => {
  it('projects unknown baselines and current checksums as explicit safe JSON fields', () => {
    const report = migrationStatusReport(status({ unknownChecksums: ['0001_initial.sql'] }), files);
    expect(report).toMatchObject({
      pendingCount: 0,
      unknownChecksumCount: 1,
      unknownChecksums: ['0001_initial.sql'],
      reviewedBaselineCount: 0,
      migrationProvenanceCount: 0,
      schemaObjectCheckStatus: 'skipped-unknown-checksum-baseline',
      integrityProblemCount: 0,
      migrations: [{ filename: '0001_initial.sql', currentChecksum: 'a'.repeat(64), provenance: 'unknown' }],
    });
    expect(JSON.stringify(report)).not.toContain('CREATE TABLE');
  });

  it('projects drift hashes and declared missing objects without forwarding raw diagnostics', () => {
    const report = migrationStatusReport(status({ integrityProblems: [
      `checksum drift for 0001_initial.sql: ledger ${'b'.repeat(64)}, file ${'a'.repeat(64)}`,
      '0001_initial.sql has missing table/index object(s): safe_table_state_idx',
      'ledger sequence 99 (postgres://user:private@db/app?token=secret) has no migration file on disk',
    ] }), files);
    const serialized = JSON.stringify(report);
    expect(report).toMatchObject({
      integrityProblemCount: 3,
      migrationProvenanceCount: 0,
      schemaObjectCheckStatus: 'checked-with-findings',
      integrityProblems: [
        { code: 'MIGRATION_CHECKSUM_DRIFT', filename: '0001_initial.sql', recordedChecksum: 'b'.repeat(64), currentChecksum: 'a'.repeat(64) },
        { code: 'MIGRATION_SCHEMA_OBJECT_MISSING', filename: '0001_initial.sql', missingObjects: ['safe_table_state_idx'] },
        { code: 'MIGRATION_LEDGER_ORPHAN', sequence: 99 },
      ],
    });
    expect(serialized).not.toMatch(/postgres:\/\/|private|token=secret|CREATE TABLE/);
  });

  it('counts only classified current files as migration provenance when an orphan ledger row exists', () => {
    const report = migrationStatusReport(status({
      applied: 2,
      integrityProblems: ['ledger sequence 99 (untrusted-ledger-value) has no migration file on disk'],
    }), files);
    expect(report).toMatchObject({ appliedCount: 2, migrationProvenanceCount: 1, integrityProblemCount: 1 });
    expect(JSON.stringify(report)).not.toContain('untrusted-ledger-value');
  });

  it('reports apply and verify counts with checksum provenance', () => {
    const applied = migrationApplyReport(['0001_initial.sql'], status(), files);
    const verified = migrationVerifyReport(status({ baselineProvenance: ['0001_initial.sql'] }), files);
    expect(applied).toMatchObject({ newlyAppliedCount: 1, provenance: 'migration', migrationProvenanceCount: 1, appliedMigrations: [{ currentChecksum: 'a'.repeat(64) }] });
    expect(verified).toMatchObject({ verifiedCount: 1, provenance: 'migration-or-reviewed-baseline', reviewedBaselineCount: 1 });
  });

  it('classifies legacy unknown and drift failures without exposing arbitrary error text', () => {
    const unknown = migrationFailureReport('migrate', new Error('checksum baseline is unknown for [0001_initial.sql] token=secret'), files);
    const drift = migrationFailureReport('migrate', Object.assign(new Error('private postgres://user:secret@db/app'), { code: '42P01' }), files);
    expect(unknown).toMatchObject({
      errorCode: 'MIGRATION_BASELINE_UNKNOWN',
      affectedFiles: [{ filename: '0001_initial.sql', currentChecksum: 'a'.repeat(64), provenance: 'unknown' }],
    });
    expect(drift).toMatchObject({ errorCode: 'MIGRATION_COMMAND_FAILED', databaseCode: '42P01' });
    expect(JSON.stringify({ unknown, drift })).not.toMatch(/token=secret|postgres:\/\/|private/);
  });
});
