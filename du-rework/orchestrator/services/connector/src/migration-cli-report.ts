import type { ConnectorMigrationFile, ConnectorMigrationStatus } from './db/migration-runner';

const SAFE_FILENAME = /^\d{3}_[A-Za-z0-9_.-]+\.sql$/;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;

function knownFiles(files: ConnectorMigrationFile[]): ConnectorMigrationFile[] {
  return files.filter((file) => SAFE_FILENAME.test(file.filename) && SAFE_SHA256.test(file.checksum));
}

function safeNames(names: string[], files: ConnectorMigrationFile[]): string[] {
  const requested = new Set(names);
  return knownFiles(files).filter((file) => requested.has(file.filename)).map((file) => file.filename);
}

function safeIntegrityProblem(problem: string, files: ConnectorMigrationFile[]): Record<string, unknown> {
  const file = knownFiles(files).find((candidate) => problem.includes(candidate.filename));
  if (/checksum drift/i.test(problem) && file) {
    const recordedChecksum = /ledger ([a-f0-9]{64})/i.exec(problem)?.[1];
    return {
      code: 'MIGRATION_CHECKSUM_DRIFT', filename: file.filename,
      ...(recordedChecksum && SAFE_SHA256.test(recordedChecksum) ? { recordedChecksum } : {}),
      currentChecksum: file.checksum, detail: 'The recorded SHA-256 differs from the current Connector migration file.',
    };
  }
  if (/missing table\/index object/i.test(problem) && file) {
    const declared = new Set<string>();
    for (const match of file.sql.matchAll(/^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$]*)/gim)) {
      declared.add(match[1]!.toLowerCase());
    }
    const reportedObjects = /missing table\/index object(?:\(s\))?:\s*([^;]+)/i.exec(problem)?.[1] ?? '';
    const missingObjects = reportedObjects
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => declared.has(name));
    return { code: 'MIGRATION_SCHEMA_OBJECT_MISSING', filename: file.filename, missingObjects, detail: 'A table or index declared by an applied Connector migration is missing.' };
  }
  if (/no migration file on disk/i.test(problem)) {
    const sequence = /ledger version (\d+)/i.exec(problem)?.[1];
    return { code: 'MIGRATION_LEDGER_ORPHAN', ...(sequence ? { sequence: Number(sequence) } : {}), detail: 'The Connector ledger contains a version with no matching migration file.' };
  }
  if (/filename or checksum metadata is incomplete/i.test(problem)) {
    return { code: 'MIGRATION_CHECKSUM_METADATA_INCOMPLETE', ...(file ? { filename: file.filename } : {}), detail: 'The Connector ledger has incomplete filename or checksum metadata.' };
  }
  if (/not a lowercase SHA-256 digest/i.test(problem)) {
    return { code: 'MIGRATION_CHECKSUM_INVALID', ...(file ? { filename: file.filename } : {}), detail: 'The recorded Connector migration checksum is invalid.' };
  }
  if (/provenance/i.test(problem)) return { code: 'MIGRATION_PROVENANCE_INVALID', ...(file ? { filename: file.filename } : {}), detail: 'The Connector ledger checksum provenance is invalid.' };
  if (/row count/i.test(problem)) return { code: 'MIGRATION_LEDGER_ROW_COUNT_MISMATCH', detail: 'The Connector migration ledger row count is inconsistent.' };
  return { code: 'MIGRATION_LEDGER_INTEGRITY', ...(file ? { filename: file.filename } : {}), detail: 'The Connector migration ledger contains inconsistent metadata.' };
}

function statusFields(status: ConnectorMigrationStatus, files: ConnectorMigrationFile[]): Record<string, unknown> {
  const pending = safeNames(status.pending, files);
  const unknownChecksums = safeNames(status.unknownChecksums, files);
  const baselineProvenance = safeNames(status.baselineProvenance, files);
  const integrityProblems = status.integrityProblems.map((problem) => safeIntegrityProblem(problem, files));
  const objectCheckStatus = status.integrityProblems.some((problem) => /missing table\/index object/i.test(problem))
    ? 'checked-with-findings'
    : status.unknownChecksums.length > 0
      ? 'skipped-unknown-checksum-baseline'
      : status.integrityProblems.length > 0
        ? 'skipped-ledger-integrity-problem'
        : status.applied > 0
          ? 'checked'
          : 'not-applicable-no-applied-migrations';
  const uncertainFiles = new Set(integrityProblems.flatMap((problem) => typeof problem.filename === 'string' ? [problem.filename] : []));
  const pendingSet = new Set(pending);
  const unknownSet = new Set(unknownChecksums);
  const baselineSet = new Set(baselineProvenance);
  const migrations = knownFiles(files).map((file) => ({
    filename: file.filename, version: file.version, sequence: file.sequence, currentChecksum: file.checksum,
    provenance: pendingSet.has(file.filename) ? 'pending'
      : unknownSet.has(file.filename) ? 'unknown'
        : uncertainFiles.has(file.filename) ? 'unverified'
          : baselineSet.has(file.filename) ? 'reviewed-baseline' : 'migration',
  }));
  return {
    appliedCount: status.applied, totalCount: status.total,
    pendingCount: pending.length, pending,
    unknownChecksumCount: unknownChecksums.length, unknownChecksums,
    reviewedBaselineCount: baselineProvenance.length, baselineProvenance,
    migrationProvenanceCount: migrations.filter((migration) => migration.provenance === 'migration').length,
    integrityProblemCount: integrityProblems.length, integrityProblems, schemaObjectCheckStatus: objectCheckStatus, migrations,
  };
}

function namedMigrations(names: string[], files: ConnectorMigrationFile[], provenance: 'migration' | 'reviewed-baseline'):
  Array<{ filename: string; version: string; sequence: number; currentChecksum: string; provenance: 'migration' | 'reviewed-baseline' }> {
  const requested = new Set(names);
  return knownFiles(files).filter((file) => requested.has(file.filename)).map((file) => ({
    filename: file.filename, version: file.version, sequence: file.sequence, currentChecksum: file.checksum, provenance,
  }));
}

export function connectorMigrationStatusReport(status: ConnectorMigrationStatus, files: ConnectorMigrationFile[]): Record<string, unknown> {
  return { type: 'migration-status', service: 'connector', outcome: 'checked', ...statusFields(status, files) };
}

export function connectorMigrationApplyReport(applied: string[], status: ConnectorMigrationStatus, files: ConnectorMigrationFile[]): Record<string, unknown> {
  const appliedMigrations = namedMigrations(applied, files, 'migration');
  return {
    type: 'migration-apply', service: 'connector', outcome: appliedMigrations.length === 0 ? 'up-to-date' : 'applied',
    newlyAppliedCount: appliedMigrations.length, appliedMigrations, provenance: 'migration', ...statusFields(status, files),
  };
}

export function connectorMigrationVerifyReport(status: ConnectorMigrationStatus, files: ConnectorMigrationFile[]): Record<string, unknown> {
  return {
    type: 'migration-verify', service: 'connector', outcome: 'passed', verifiedCount: status.applied,
    provenance: 'migration-or-reviewed-baseline', ...statusFields(status, files),
  };
}

export function connectorMigrationBaselineReport(baselined: string[], status: ConnectorMigrationStatus, files: ConnectorMigrationFile[]): Record<string, unknown> {
  const baselinedMigrations = namedMigrations(baselined, files, 'reviewed-baseline');
  return {
    type: 'migration-baseline', service: 'connector', outcome: 'recorded', baselinedCount: baselinedMigrations.length,
    baselinedMigrations, provenance: 'reviewed-baseline', ...statusFields(status, files),
  };
}

export function connectorMigrationFailureReport(command: string, error: unknown, files: ConnectorMigrationFile[]): Record<string, unknown> {
  const message = error instanceof Error ? error.message : '';
  let errorCode = 'MIGRATION_COMMAND_FAILED';
  let detail = 'The Connector migration command failed. Check the database service and inspect the read-only status report.';
  if (/unknown migration command/i.test(message)) {
    errorCode = 'UNKNOWN_MIGRATION_COMMAND'; detail = 'Choose migrate, status, verify, or baseline-reviewed.';
  } else if (/checksum baseline is unknown/i.test(message)) {
    errorCode = 'MIGRATION_BASELINE_UNKNOWN'; detail = 'Previously applied Connector migrations have no reviewed checksum baseline. Review the live schema and migration history before running baseline-reviewed.';
  } else if (/checksum drift/i.test(message)) {
    errorCode = 'MIGRATION_CHECKSUM_DRIFT'; detail = 'A recorded Connector SHA-256 differs from the current migration file. Review migration history before applying changes.';
  } else if (/missing (?:table\/index )?object|incomplete schema/i.test(message)) {
    errorCode = 'MIGRATION_SCHEMA_OBJECT_DRIFT'; detail = 'A schema object declared by an applied Connector migration is missing. Restore it or reconcile the ledger after review; recorded SQL will not be replayed.';
  } else if (/missing migrations/i.test(message)) {
    errorCode = 'MIGRATIONS_PENDING'; detail = 'The Connector schema has pending migrations. Confirm both migration engines pass status before applying them.';
  } else if (/no connector_schema_migrations table/i.test(message)) {
    errorCode = 'MIGRATION_LEDGER_MISSING'; detail = 'The Connector migration ledger does not exist. Run migrate to initialize and apply migrations.';
  } else if (/Connector migration ledger integrity check failed/i.test(message)) {
    errorCode = 'MIGRATION_LEDGER_INTEGRITY'; detail = 'The Connector migration ledger has inconsistent metadata. Review the status diagnostics before applying changes.';
  } else if (/duplicate Connector migration sequence/i.test(message)) {
    errorCode = 'MIGRATION_SEQUENCE_COLLISION'; detail = 'Connector migration files contain duplicate numeric sequence prefixes.';
  }
  const affectedMigrations = knownFiles(files)
    .filter((file) => message.includes(file.filename))
    .map((file) => ({ filename: file.filename, version: file.version, currentChecksum: file.checksum }));
  const rawCode = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const databaseCode = typeof rawCode === 'string' && /^[0-9A-Z]{5}$/.test(rawCode) ? rawCode : undefined;
  const safeCommand = ['migrate', 'status', 'verify', 'baseline-reviewed'].includes(command) ? command : 'unknown';
  return {
    type: 'migration-command-error', service: 'connector', command: safeCommand, outcome: 'failed', errorCode, detail,
    affectedMigrations, ...(databaseCode ? { databaseCode } : {}),
  };
}
