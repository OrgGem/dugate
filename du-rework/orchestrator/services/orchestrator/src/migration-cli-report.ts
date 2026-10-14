import type { MigrationFile, MigrationStatus } from './db/migrations';

const SAFE_FILENAME = /^\d{4}_[A-Za-z0-9_.-]+\.sql$/;
const SAFE_SHA256 = /^[a-f0-9]{64}$/;

function knownFiles(files: MigrationFile[]): MigrationFile[] {
  return files.filter((file) => SAFE_FILENAME.test(file.filename) && SAFE_SHA256.test(file.checksum));
}

function safeNames(names: string[], files: MigrationFile[]): string[] {
  const requested = new Set(names);
  return knownFiles(files).filter((file) => requested.has(file.filename)).map((file) => file.filename);
}

function safeIntegrityProblem(problem: string, files: MigrationFile[]): Record<string, unknown> {
  const file = knownFiles(files).find((candidate) => problem.includes(candidate.filename));
  if (/checksum drift/i.test(problem) && file) {
    const recordedChecksum = /ledger ([a-f0-9]{64})/i.exec(problem)?.[1];
    return {
      code: 'MIGRATION_CHECKSUM_DRIFT',
      filename: file.filename,
      ...(recordedChecksum && SAFE_SHA256.test(recordedChecksum) ? { recordedChecksum } : {}),
      currentChecksum: file.checksum,
      detail: 'The recorded SHA-256 differs from the current migration file.',
    };
  }
  if (/missing (?:table\/index )?object/i.test(problem) && file) {
    const declared = new Set<string>();
    for (const match of file.sql.matchAll(/^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$]*)/gim)) {
      declared.add(match[1]!.toLowerCase());
    }
    const reportedObjects = /missing (?:table\/index )?object(?:\(s\))?:\s*([^;]+)/i.exec(problem)?.[1] ?? '';
    const missingObjects = reportedObjects
      .split(',')
      .map((name) => name.trim().toLowerCase())
      .filter((name) => declared.has(name));
    return {
      code: 'MIGRATION_SCHEMA_OBJECT_MISSING',
      filename: file.filename,
      missingObjects,
      detail: 'A table or index declared by an applied migration is missing.',
    };
  }
  if (/sequence \d+ is recorded as/i.test(problem) && file) {
    return {
      code: 'MIGRATION_FILENAME_DRIFT',
      filename: file.filename,
      detail: 'The migration filename recorded for this sequence differs from the file on disk.',
    };
  }
  if (/no migration file on disk/i.test(problem)) {
    const sequence = /ledger sequence (\d+)/i.exec(problem)?.[1];
    return {
      code: 'MIGRATION_LEDGER_ORPHAN',
      ...(sequence ? { sequence: Number(sequence) } : {}),
      detail: 'The ledger contains an applied migration sequence with no matching file on disk.',
    };
  }
  if (/duplicate sequence/i.test(problem)) return { code: 'MIGRATION_LEDGER_DUPLICATE_SEQUENCE', detail: 'The ledger contains duplicate migration sequences.' };
  if (/row count/i.test(problem)) return { code: 'MIGRATION_LEDGER_ROW_COUNT_MISMATCH', detail: 'The migration ledger row count is inconsistent.' };
  if (/provenance/i.test(problem)) return { code: 'MIGRATION_PROVENANCE_INVALID', ...(file ? { filename: file.filename } : {}), detail: 'The ledger checksum provenance is invalid.' };
  if (/checksum/i.test(problem)) return { code: 'MIGRATION_CHECKSUM_INVALID', ...(file ? { filename: file.filename } : {}), detail: 'The ledger checksum metadata is incomplete or invalid.' };
  return { code: 'MIGRATION_LEDGER_INTEGRITY', ...(file ? { filename: file.filename } : {}), detail: 'The migration ledger contains inconsistent metadata.' };
}

function statusFields(status: MigrationStatus, files: MigrationFile[]): Record<string, unknown> {
  const pending = safeNames(status.pending, files);
  const unknownChecksums = safeNames(status.unknownChecksums, files);
  const baselineProvenance = safeNames(status.baselineProvenance, files);
  const integrityProblems = status.integrityProblems.map((problem) => safeIntegrityProblem(problem, files));
  const objectCheckStatus = status.integrityProblems.some((problem) => /missing (?:table\/index )?object/i.test(problem))
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
    filename: file.filename,
    sequence: file.sequence,
    currentChecksum: file.checksum,
    provenance: pendingSet.has(file.filename)
      ? 'pending'
      : unknownSet.has(file.filename)
        ? 'unknown'
        : uncertainFiles.has(file.filename)
          ? 'unverified'
          : baselineSet.has(file.filename)
            ? 'reviewed-baseline'
            : 'migration',
  }));
  return {
    appliedCount: status.applied,
    totalCount: status.total,
    pendingCount: pending.length,
    pending,
    unknownChecksumCount: unknownChecksums.length,
    unknownChecksums,
    reviewedBaselineCount: baselineProvenance.length,
    baselineProvenance,
    migrationProvenanceCount: migrations.filter((migration) => migration.provenance === 'migration').length,
    integrityProblemCount: integrityProblems.length,
    integrityProblems,
    schemaObjectCheckStatus: objectCheckStatus,
    migrations,
  };
}

function namedMigrations(names: string[], files: MigrationFile[], provenance: 'migration' | 'reviewed-baseline'):
  Array<{ filename: string; sequence: number; currentChecksum: string; provenance: 'migration' | 'reviewed-baseline' }> {
  const requested = new Set(names);
  return knownFiles(files)
    .filter((file) => requested.has(file.filename))
    .map((file) => ({ filename: file.filename, sequence: file.sequence, currentChecksum: file.checksum, provenance }));
}

export function migrationStatusReport(status: MigrationStatus, files: MigrationFile[]): Record<string, unknown> {
  return { type: 'migration-status', service: 'orchestrator', outcome: 'checked', ...statusFields(status, files) };
}

export function migrationApplyReport(applied: string[], status: MigrationStatus, files: MigrationFile[]): Record<string, unknown> {
  const appliedMigrations = namedMigrations(applied, files, 'migration');
  return {
    type: 'migration-apply', service: 'orchestrator', outcome: appliedMigrations.length === 0 ? 'up-to-date' : 'applied',
    newlyAppliedCount: appliedMigrations.length, appliedMigrations, provenance: 'migration', ...statusFields(status, files),
  };
}

export function migrationVerifyReport(status: MigrationStatus, files: MigrationFile[]): Record<string, unknown> {
  return {
    type: 'migration-verify', service: 'orchestrator', outcome: 'passed', verifiedCount: status.applied,
    provenance: 'migration-or-reviewed-baseline', ...statusFields(status, files),
  };
}

export function migrationBaselineReport(baselined: string[], status: MigrationStatus, files: MigrationFile[]): Record<string, unknown> {
  const baselinedMigrations = namedMigrations(baselined, files, 'reviewed-baseline');
  return {
    type: 'migration-baseline', service: 'orchestrator', outcome: 'recorded', baselinedCount: baselinedMigrations.length,
    baselinedMigrations, provenance: 'reviewed-baseline', ...statusFields(status, files),
  };
}

export function migrationFailureReport(command: string, error: unknown, files: MigrationFile[]): Record<string, unknown> {
  const message = error instanceof Error ? error.message : '';
  let errorCode = 'MIGRATION_COMMAND_FAILED';
  let detail = 'The migration command failed. Check the database service and inspect the read-only status report.';
  if (/unknown migration command/i.test(message)) {
    errorCode = 'UNKNOWN_MIGRATION_COMMAND';
    detail = 'Choose migrate, status, verify, or baseline-reviewed.';
  } else if (/checksum baseline is unknown/i.test(message)) {
    errorCode = 'MIGRATION_BASELINE_UNKNOWN';
    detail = 'Previously applied migrations have no reviewed checksum baseline. Review the live schema and migration history before running baseline-reviewed.';
  } else if (/checksum drift/i.test(message)) {
    errorCode = 'MIGRATION_CHECKSUM_DRIFT';
    detail = 'A recorded SHA-256 differs from the current migration file. Restore or review migration history before applying changes.';
  } else if (/missing (?:table\/index )?object|incomplete schema/i.test(message)) {
    errorCode = 'MIGRATION_SCHEMA_OBJECT_DRIFT';
    detail = 'A schema object declared by an applied migration is missing. Restore the object or reconcile the ledger after review; recorded SQL will not be replayed.';
  } else if (/missing migrations/i.test(message)) {
    errorCode = 'MIGRATIONS_PENDING';
    detail = 'The schema has pending migrations. Confirm both migration engines pass status before applying them.';
  } else if (/no schema_migrations table/i.test(message)) {
    errorCode = 'MIGRATION_LEDGER_MISSING';
    detail = 'The Orchestrator migration ledger does not exist. Run migrate to initialize and apply migrations.';
  } else if (/migration ledger integrity check failed/i.test(message)) {
    errorCode = 'MIGRATION_LEDGER_INTEGRITY';
    detail = 'The migration ledger has inconsistent metadata. Review the status diagnostics before applying changes.';
  } else if (/duplicate migration sequence/i.test(message)) {
    errorCode = 'MIGRATION_SEQUENCE_COLLISION';
    detail = 'Migration files contain duplicate numeric sequence prefixes.';
  }
  const affectedFiles = safeNames(knownFiles(files).map((file) => file.filename).filter((filename) => message.includes(filename)), files)
    .map((filename) => {
      const file = knownFiles(files).find((candidate) => candidate.filename === filename)!;
      return {
        filename: file.filename,
        sequence: file.sequence,
        currentChecksum: file.checksum,
        provenance: errorCode === 'MIGRATION_BASELINE_UNKNOWN' ? 'unknown' : 'unverified',
      };
    });
  const rawCode = error !== null && typeof error === 'object' && 'code' in error ? (error as { code?: unknown }).code : undefined;
  const databaseCode = typeof rawCode === 'string' && /^[0-9A-Z]{5}$/.test(rawCode) ? rawCode : undefined;
  const safeCommand = ['migrate', 'status', 'verify', 'baseline-reviewed'].includes(command) ? command : 'unknown';
  return {
    type: 'migration-command-error', service: 'orchestrator', command: safeCommand, outcome: 'failed', errorCode, detail,
    affectedFiles, ...(databaseCode ? { databaseCode } : {}),
  };
}
