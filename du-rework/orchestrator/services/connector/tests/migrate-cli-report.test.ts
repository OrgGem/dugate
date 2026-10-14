import type { ConnectorMigrationFile, ConnectorMigrationStatus } from '../src/db/migration-runner';
import {
  connectorMigrationApplyReport,
  connectorMigrationBaselineReport,
  connectorMigrationFailureReport,
  connectorMigrationStatusReport,
} from '../src/migration-cli-report';

const files: ConnectorMigrationFile[] = [
  {
    version: '001_initial',
    filename: '001_initial.sql',
    sequence: 1,
    sql: 'CREATE TABLE IF NOT EXISTS connector_table (id integer);\nCREATE INDEX IF NOT EXISTS connector_table_state_idx ON connector_table(id);',
    checksum: 'c'.repeat(64),
  },
];

function status(overrides: Partial<ConnectorMigrationStatus> = {}): ConnectorMigrationStatus {
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

describe('Connector migration CLI reports', () => {
  it('projects unknown baselines and current checksums as explicit safe JSON fields', () => {
    const report = connectorMigrationStatusReport(status({ unknownChecksums: ['001_initial.sql'] }), files);
    expect(report).toMatchObject({
      pendingCount: 0,
      unknownChecksumCount: 1,
      unknownChecksums: ['001_initial.sql'],
      reviewedBaselineCount: 0,
      migrationProvenanceCount: 0,
      schemaObjectCheckStatus: 'skipped-unknown-checksum-baseline',
      integrityProblemCount: 0,
      migrations: [{ filename: '001_initial.sql', currentChecksum: 'c'.repeat(64), provenance: 'unknown' }],
    });
    expect(JSON.stringify(report)).not.toContain('CREATE TABLE');
  });

  it('projects checksum and schema-object drift without forwarding raw diagnostics', () => {
    const report = connectorMigrationStatusReport(status({ integrityProblems: [
      `checksum drift for 001_initial.sql: ledger ${'d'.repeat(64)}, file ${'c'.repeat(64)}`,
      '001_initial.sql has missing table/index object(s): connector_table_state_idx',
      'ledger version 999 (postgres://user:private@db/app?token=secret) has no migration file on disk',
    ] }), files);
    const serialized = JSON.stringify(report);
    expect(report).toMatchObject({
      integrityProblemCount: 3,
      migrationProvenanceCount: 0,
      schemaObjectCheckStatus: 'checked-with-findings',
      integrityProblems: [
        { code: 'MIGRATION_CHECKSUM_DRIFT', filename: '001_initial.sql', recordedChecksum: 'd'.repeat(64), currentChecksum: 'c'.repeat(64) },
        { code: 'MIGRATION_SCHEMA_OBJECT_MISSING', filename: '001_initial.sql', missingObjects: ['connector_table_state_idx'] },
        { code: 'MIGRATION_LEDGER_ORPHAN', sequence: 999 },
      ],
    });
    expect(serialized).not.toMatch(/postgres:\/\/|private|token=secret|CREATE TABLE/);
  });

  it('counts only classified current files as migration provenance when an orphan ledger row exists', () => {
    const report = connectorMigrationStatusReport(status({
      applied: 2,
      integrityProblems: ['ledger version 999 (untrusted-ledger-value) has no migration file on disk'],
    }), files);
    expect(report).toMatchObject({ appliedCount: 2, migrationProvenanceCount: 1, integrityProblemCount: 1 });
    expect(JSON.stringify(report)).not.toContain('untrusted-ledger-value');
  });

  it('reports baseline provenance and current migration checksums', () => {
    const report = connectorMigrationBaselineReport(['001_initial.sql'], status({ baselineProvenance: ['001_initial.sql'] }), files);
    expect(report).toMatchObject({
      baselinedCount: 1,
      provenance: 'reviewed-baseline',
      baselinedMigrations: [{ filename: '001_initial.sql', currentChecksum: 'c'.repeat(64), provenance: 'reviewed-baseline' }],
      reviewedBaselineCount: 1,
    });
    expect(connectorMigrationApplyReport([], status(), files)).toMatchObject({ outcome: 'up-to-date', newlyAppliedCount: 0 });
  });

  it('classifies unknown legacy checksums without exposing arbitrary error text', () => {
    const report = connectorMigrationFailureReport(
      'migrate',
      new Error('Connector migration ledger integrity check failed: checksum baseline is unknown for [001_initial.sql] token=secret'),
      files,
    );
    expect(report).toMatchObject({
      errorCode: 'MIGRATION_BASELINE_UNKNOWN',
      affectedMigrations: [{ filename: '001_initial.sql', currentChecksum: 'c'.repeat(64) }],
    });
    expect(JSON.stringify(report)).not.toMatch(/token=secret|postgres:\/\//);
  });
});
