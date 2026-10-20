/**
 * Orchestrator migration runner.
 *
 * Migration checksums use SHA-256 over UTF-8 SQL after converting CRLF to LF.
 * This keeps a Windows checkout and a Unix checkout equivalent while still
 * detecting every other content change. Existing ledgers have no trustworthy
 * checksum; operators must run the explicit reviewed-baseline command once.
 */

import { createHash } from 'node:crypto';
import { bootstrapRequiredData } from './required-data';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PoolClient } from 'pg';
import type { Db } from './db';

const MIGRATIONS_DIR = join(__dirname, '../../migrations');
const TRACKING_TABLE = 'schema_migrations';
const REQUIRED_METADATA_COLUMNS = ['checksum', 'checksum_provenance', 'baseline_reviewed_at'];
const MIGRATION_LOCK_SQL = "SELECT pg_advisory_lock(hashtext('dugate'), hashtext('schema-migrations'))";
const MIGRATION_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('dugate'), hashtext('schema-migrations'))";

export interface MigrationFile {
  filename: string;
  sequence: number;
  sql: string;
  checksum: string;
}

interface LedgerRow {
  sequence: number | string;
  filename: string;
  checksum: string | null;
  checksum_provenance: string | null;
  baseline_reviewed_at: Date | string | null;
}

interface MigrationInspection {
  hasTable: boolean;
  files: MigrationFile[];
  rows: LedgerRow[];
  rowsBySequence: Map<number, LedgerRow>;
  pending: MigrationFile[];
  unknownChecksums: string[];
  baselineProvenance: string[];
  problems: string[];
}

export interface MigrationStatus {
  total: number;
  applied: number;
  pending: string[];
  unknownChecksums: string[];
  baselineProvenance: string[];
  integrityProblems: string[];
}

/**
 * Hash SQL deterministically across Windows and Unix checkout line endings.
 * Only CRLF pairs are normalized; all other bytes remain significant.
 */
export function migrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** Load migrations sorted by their unique four-digit numeric prefix. */
export function loadMigrationFiles(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((filename) => /^\d{4}_.*\.sql$/.test(filename))
    .sort();
  const loaded = files.map((filename) => {
    const sql = readFileSync(join(dir, filename), 'utf8');
    return {
      filename,
      sequence: Number.parseInt(filename.slice(0, 4), 10),
      sql,
      checksum: migrationChecksum(sql),
    };
  });
  const seen = new Map<number, string>();
  for (const migration of loaded) {
    const previous = seen.get(migration.sequence);
    if (previous !== undefined) {
      throw new Error(
        `duplicate migration sequence ${migration.sequence}: ${previous} and ${migration.filename} — renumber one file before running`,
      );
    }
    seen.set(migration.sequence, migration.filename);
  }
  return loaded;
}

async function trackingTableExists(db: Db): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     ) AS exists`,
    [TRACKING_TABLE],
  );
  return result.rows[0]?.exists === true;
}

async function trackingMetadataColumns(db: Db): Promise<Set<string>> {
  const result = await db.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
       AND column_name = ANY($2::text[])`,
    [TRACKING_TABLE, REQUIRED_METADATA_COLUMNS],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

/** Query-only inspection shared by status, verify, migration, and baseline. */
async function inspectMigrations(db: Db, files: MigrationFile[]): Promise<MigrationInspection> {
  const hasTable = await trackingTableExists(db);
  if (!hasTable) {
    return {
      hasTable,
      files,
      rows: [],
      rowsBySequence: new Map(),
      pending: files,
      unknownChecksums: [],
      baselineProvenance: [],
      problems: [],
    };
  }

  const metadataColumns = await trackingMetadataColumns(db);
  const hasCompleteMetadata = REQUIRED_METADATA_COLUMNS.every((column) => metadataColumns.has(column));
  const countResult = await db.query<{ count: number | string }>(
    `SELECT count(*)::int AS count FROM ${TRACKING_TABLE}`,
  );
  const count = Number(countResult.rows[0]?.count ?? 0);
  const rowSql = hasCompleteMetadata
    ? `SELECT sequence, filename, checksum, checksum_provenance, baseline_reviewed_at
       FROM ${TRACKING_TABLE} ORDER BY sequence`
    : `SELECT sequence, filename, NULL::text AS checksum, NULL::text AS checksum_provenance,
         NULL::timestamptz AS baseline_reviewed_at FROM ${TRACKING_TABLE} ORDER BY sequence`;
  const rowResult = await db.query<LedgerRow>(rowSql);
  const rows = rowResult.rows;
  const rowsBySequence = new Map<number, LedgerRow>();
  const problems: string[] = [];
  const unknownChecksums: string[] = [];
  const baselineProvenance: string[] = [];
  const filesBySequence = new Map(files.map((file) => [file.sequence, file]));

  if (!Number.isSafeInteger(count) || count < 0 || count !== rows.length) {
    problems.push(`ledger row count is ${count}, but the row query returned ${rows.length}`);
  }

  for (const row of rows) {
    const sequence = Number(row.sequence);
    if (!Number.isSafeInteger(sequence) || sequence < 0) {
      problems.push(`ledger contains an unusable sequence value '${String(row.sequence)}'`);
      continue;
    }
    if (rowsBySequence.has(sequence)) {
      problems.push(`ledger contains duplicate sequence ${sequence}`);
      continue;
    }
    rowsBySequence.set(sequence, row);

    const file = filesBySequence.get(sequence);
    if (!file) {
      problems.push(`ledger sequence ${sequence} (${row.filename}) has no migration file on disk`);
      continue;
    }
    if (row.filename !== file.filename) {
      problems.push(
        `sequence ${sequence} is recorded as '${row.filename}' but the file on disk is '${file.filename}'`,
      );
      continue;
    }

    if (row.checksum === null && row.checksum_provenance === null) {
      unknownChecksums.push(file.filename);
      continue;
    }
    if (row.checksum === null || row.checksum_provenance === null) {
      problems.push(`checksum metadata is incomplete for ${file.filename}`);
      continue;
    }
    if (!/^[a-f0-9]{64}$/.test(row.checksum)) {
      problems.push(`ledger checksum for ${file.filename} is not a lowercase SHA-256 digest`);
      continue;
    }
    if (row.checksum_provenance !== 'migration' && row.checksum_provenance !== 'reviewed-baseline') {
      problems.push(`ledger checksum provenance for ${file.filename} is unrecognized`);
      continue;
    }
    if (row.checksum_provenance === 'reviewed-baseline') {
      if (row.baseline_reviewed_at === null) {
        problems.push(`reviewed baseline timestamp is missing for ${file.filename}`);
        continue;
      }
      baselineProvenance.push(file.filename);
    } else if (row.baseline_reviewed_at !== null) {
      problems.push(`migration-applied row unexpectedly has a baseline timestamp for ${file.filename}`);
      continue;
    }
    if (row.checksum !== file.checksum) {
      problems.push(`checksum drift for ${file.filename}: ledger ${row.checksum}, file ${file.checksum}`);
    }
  }

  const pending = files.filter((file) => !rowsBySequence.has(file.sequence));
  return { hasTable, files, rows, rowsBySequence, pending, unknownChecksums, baselineProvenance, problems };
}

function ledgerProblemMessage(inspection: MigrationInspection, allowUnknown: boolean): string | undefined {
  const details = [...inspection.problems];
  if (!allowUnknown && inspection.unknownChecksums.length > 0) {
    details.push(
      `checksum baseline is unknown for [${inspection.unknownChecksums.join(', ')}]; review the existing database and run "pnpm run migrate:baseline-reviewed" once`,
    );
  }
  return details.length > 0 ? `migration ledger integrity check failed: ${details.join('; ')}` : undefined;
}

type MarkClientUnusable = (error: unknown) => void;

function clientReleaseError(error: unknown): Error {
  return error instanceof Error ? error : new Error(`migration client cleanup failed: ${String(error)}`);
}

async function runTransaction<T>(
  client: PoolClient,
  work: () => Promise<T>,
  markClientUnusable: MarkClientUnusable,
): Promise<T> {
  try {
    await client.query('BEGIN');
    const result = await work();
    await client.query('COMMIT');
    return result;
  } catch (error) {
    try {
      await client.query('ROLLBACK');
    } catch (rollbackError) {
      markClientUnusable(rollbackError);
    }
    throw error;
  }
}

/**
 * Metadata bootstrap is intentionally separate from numbered schema files.
 * Legacy rows remain NULL until the operator explicitly baselines them.
 */
async function ensureTrackingMetadata(client: PoolClient, markClientUnusable: MarkClientUnusable): Promise<void> {
  await runTransaction(client, async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
        sequence integer PRIMARY KEY,
        filename text NOT NULL,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text,
        checksum_provenance text,
        baseline_reviewed_at timestamptz
      )
    `);
    await client.query(`ALTER TABLE ${TRACKING_TABLE}
      ADD COLUMN IF NOT EXISTS checksum text,
      ADD COLUMN IF NOT EXISTS checksum_provenance text,
      ADD COLUMN IF NOT EXISTS baseline_reviewed_at timestamptz`);
  }, markClientUnusable);
}

async function withMigrationLock<T>(
  db: Db,
  work: (client: PoolClient, lockedDb: Db, markClientUnusable: MarkClientUnusable) => Promise<T>,
): Promise<T> {
  const client = await db.pool.connect();
  let locked = false;
  let releaseError: Error | undefined;
  let primaryError: unknown;
  let hasPrimaryError = false;
  let result: T | undefined;
  const markClientUnusable: MarkClientUnusable = (error) => {
    releaseError ??= clientReleaseError(error);
  };

  try {
    await client.query(MIGRATION_LOCK_SQL);
    locked = true;
    result = await work(client, databaseOnClient(db, client, markClientUnusable), markClientUnusable);
  } catch (error) {
    primaryError = error;
    hasPrimaryError = true;
    if (!locked) markClientUnusable(error);
  }

  if (locked && !releaseError) {
    try {
      await client.query(MIGRATION_UNLOCK_SQL);
    } catch (unlockError) {
      markClientUnusable(unlockError);
      if (!hasPrimaryError) {
        primaryError = unlockError;
        hasPrimaryError = true;
      }
    }
  }

  try {
    if (releaseError) client.release(releaseError);
    else client.release();
  } catch (releaseFailure) {
    if (!hasPrimaryError) {
      primaryError = releaseFailure;
      hasPrimaryError = true;
    }
  }

  if (hasPrimaryError) throw primaryError;
  return result as T;
}

function databaseOnClient(db: Db, client: PoolClient, markClientUnusable: MarkClientUnusable): Db {
  const query = ((text: string, params?: unknown[]) => client.query(text, params as never[])) as Db['query'];
  return {
    pool: db.pool,
    query,
    tx: async <T>(work: (transactionClient: PoolClient) => Promise<T>): Promise<T> =>
      runTransaction(client, () => work(client), markClientUnusable),
    close: async () => undefined,
  };
}

/**
 * Apply pending files in order. The session lock covers planning and every
 * per-file transaction; each successful file and its ledger row commit as one.
 */
export async function migrate(db: Db, dir = MIGRATIONS_DIR): Promise<{ applied: string[] }> {
  const files = loadMigrationFiles(dir);
  return withMigrationLock(db, async (client, lockedDb, markClientUnusable) => {
    await ensureTrackingMetadata(client, markClientUnusable);
    const inspection = await inspectMigrations(lockedDb, files);
    const problem = ledgerProblemMessage(inspection, false);
    if (problem) throw new Error(problem);

    const alreadyApplied = new Map(
      [...inspection.rowsBySequence.entries()].map(([sequence, row]) => [sequence, row.filename]),
    );
    const drifted = await recordedMigrationsMissingObjects(lockedDb, files, alreadyApplied);
    if (drifted.length > 0) {
      throw new Error(
        `refusing to skip recorded migrations against an incomplete schema: ${drifted
          .map((entry) => `${entry.filename} → missing ${entry.objects.join(', ')}`)
          .join('; ')}. schema_migrations claims these files were applied, but the database no longer has the table/index object(s) they declare. Restore the object(s), or delete the stale ledger row(s) and re-run migrate after verifying the schema, e.g. DELETE FROM schema_migrations WHERE sequence IN (${drifted.map((entry) => entry.sequence).join(', ')});`,
      );
    }

    const applied: string[] = [];
    for (const file of inspection.pending) {
      await lockedDb.tx(async (transactionClient) => {
        await transactionClient.query(file.sql);
        await transactionClient.query(
          `INSERT INTO ${TRACKING_TABLE}
             (sequence, filename, checksum, checksum_provenance, baseline_reviewed_at)
           VALUES ($1, $2, $3, 'migration', NULL)`,
          [file.sequence, file.filename, file.checksum],
        );
      });
      applied.push(file.filename);
    }
    if (files.some((file) => file.filename === '0069_required_data.sql')) {
      await lockedDb.tx(bootstrapRequiredData);
    }
    return { applied };
  });
}

/**
 * Explicitly record current hashes for matching legacy rows whose checksums
 * are unknown. This command never rewrites a known hash or applies migration
 * SQL; the caller is responsible for reviewing the database before invoking it.
 */
export async function baselineMigrationsReviewed(
  db: Db,
  dir = MIGRATIONS_DIR,
): Promise<{ baselined: string[] }> {
  const files = loadMigrationFiles(dir);
  return withMigrationLock(db, async (client, lockedDb, markClientUnusable) => {
    await ensureTrackingMetadata(client, markClientUnusable);
    const inspection = await inspectMigrations(lockedDb, files);
    const problem = ledgerProblemMessage(inspection, true);
    if (problem) throw new Error(problem);

    const alreadyApplied = new Map(
      [...inspection.rowsBySequence.entries()].map(([sequence, row]) => [sequence, row.filename]),
    );
    const missingObjects = await recordedMigrationsMissingObjects(lockedDb, files, alreadyApplied);
    if (missingObjects.length > 0) {
      throw new Error(
        `refusing to baseline an incomplete schema: ${missingObjects
          .map((entry) => `${entry.filename} → missing ${entry.objects.join(', ')}`)
          .join('; ')}`,
      );
    }
    if (inspection.unknownChecksums.length === 0) return { baselined: [] };

    const filesByName = new Map(files.map((file) => [file.filename, file]));
    await lockedDb.tx(async (transactionClient) => {
      for (const filename of inspection.unknownChecksums) {
        const file = filesByName.get(filename);
        if (!file) throw new Error(`cannot baseline missing migration file ${filename}`);
        const result = await transactionClient.query(
          `UPDATE ${TRACKING_TABLE}
             SET checksum = $1, checksum_provenance = 'reviewed-baseline', baseline_reviewed_at = now()
           WHERE sequence = $2 AND filename = $3 AND checksum IS NULL AND checksum_provenance IS NULL`,
          [file.checksum, file.sequence, file.filename],
        );
        if (result.rowCount !== 1) {
          throw new Error(`ledger changed while baselining ${filename}; no baseline was committed`);
        }
      }
    });
    return { baselined: inspection.unknownChecksums };
  });
}

/** Verify all files against the ledger without DDL or data writes. */
export async function verifyMigrations(db: Db, dir = MIGRATIONS_DIR): Promise<void> {
  const files = loadMigrationFiles(dir);
  const inspection = await inspectMigrations(db, files);
  if (!inspection.hasTable) {
    throw new Error('schema is not up-to-date: no schema_migrations table found. Run "pnpm run migrate" before starting the server.');
  }
  const problem = ledgerProblemMessage(inspection, false);
  if (problem) throw new Error(problem);
  if (inspection.pending.length > 0) {
    throw new Error(
      `schema is not up-to-date: missing migrations [${inspection.pending.map((file) => file.filename).join(', ')}]. Run "pnpm run migrate" before starting the server.`,
    );
  }
  const done = new Map(
    [...inspection.rowsBySequence.entries()].map(([sequence, row]) => [sequence, row.filename]),
  );
  const drifted = await recordedMigrationsMissingObjects(db, files, done);
  if (drifted.length > 0) {
    throw new Error(
      `schema verification failed: recorded migrations have missing table/index objects: ${drifted
        .map((entry) => `${entry.filename} → missing ${entry.objects.join(', ')}`)
        .join('; ')}`,
    );
  }
}

/** Query-only migration state for diagnostics. */
export async function migrationStatus(db: Db, dir = MIGRATIONS_DIR): Promise<MigrationStatus> {
  const files = loadMigrationFiles(dir);
  const inspection = await inspectMigrations(db, files);
  const integrityProblems = [...inspection.problems];
  if (inspection.unknownChecksums.length === 0 && integrityProblems.length === 0 && inspection.hasTable) {
    const done = new Map(
      [...inspection.rowsBySequence.entries()].map(([sequence, row]) => [sequence, row.filename]),
    );
    const drifted = await recordedMigrationsMissingObjects(db, files, done);
    for (const entry of drifted) {
      integrityProblems.push(`${entry.filename} has missing table/index object(s): ${entry.objects.join(', ')}`);
    }
  }
  return {
    total: files.length,
    applied: inspection.rows.length,
    pending: inspection.pending.map((file) => file.filename),
    unknownChecksums: inspection.unknownChecksums,
    baselineProvenance: inspection.baselineProvenance,
    integrityProblems,
  };
}

/**
 * Return table/index declarations owned by a migration. Column ALTERs are not
 * covered: this guard detects dropped objects from additive CREATE statements.
 */
function declaredSchemaObjects(sql: string): string[] {
  const names: string[] = [];
  for (const rawLine of sql.split(/\r?\n/)) {
    const line = rawLine.replace(/--.*$/, '');
    const match = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$]*)/i.exec(line);
    if (match) names.push(match[1]!.toLowerCase());
  }
  return names;
}

async function schemaObjectExists(db: Db, name: string): Promise<boolean> {
  const result = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     ) OR EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = $1
     ) AS exists`,
    [name],
  );
  return result.rows[0]?.exists === true;
}

interface RecordedMigrationDrift {
  sequence: number;
  filename: string;
  objects: string[];
}

async function recordedMigrationsMissingObjects(
  db: Db,
  files: MigrationFile[],
  done: Map<number, string>,
): Promise<RecordedMigrationDrift[]> {
  const drift: RecordedMigrationDrift[] = [];
  for (const file of files) {
    if (done.get(file.sequence) !== file.filename) continue;
    const missing: string[] = [];
    for (const name of declaredSchemaObjects(file.sql)) {
      if (!(await schemaObjectExists(db, name))) missing.push(name);
    }
    if (missing.length > 0) drift.push({ sequence: file.sequence, filename: file.filename, objects: missing });
  }
  return drift;
}
