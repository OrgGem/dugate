/**
 * Connector migration ledger and runner.
 *
 * SHA-256 is calculated from UTF-8 SQL after CRLF pairs are normalized to LF.
 * That makes Windows and Unix checkouts equivalent while preserving every
 * other content difference. Old ledgers remain unknown until explicitly
 * recorded with the reviewed-baseline command.
 */

import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';

const TRACKING_TABLE = 'connector_schema_migrations';
const REQUIRED_METADATA_COLUMNS = ['filename', 'checksum', 'checksum_provenance', 'baseline_reviewed_at'];
const MIGRATION_LOCK_SQL = "SELECT pg_advisory_lock(hashtext('dugate'), hashtext('schema-migrations'))";
const MIGRATION_UNLOCK_SQL = "SELECT pg_advisory_unlock(hashtext('dugate'), hashtext('schema-migrations'))";

export interface ConnectorMigrationFile {
  version: string;
  filename: string;
  sequence: number;
  sql: string;
  checksum: string;
}

interface ConnectorLedgerRow {
  version: string;
  filename: string | null;
  checksum: string | null;
  checksum_provenance: string | null;
  baseline_reviewed_at: Date | string | null;
}

interface ConnectorInspection {
  hasTable: boolean;
  files: ConnectorMigrationFile[];
  rows: ConnectorLedgerRow[];
  rowsByVersion: Map<string, ConnectorLedgerRow>;
  pending: ConnectorMigrationFile[];
  unknownChecksums: string[];
  baselineProvenance: string[];
  problems: string[];
}

export interface ConnectorMigrationStatus {
  total: number;
  applied: number;
  pending: string[];
  unknownChecksums: string[];
  baselineProvenance: string[];
  integrityProblems: string[];
}

export function connectorMigrationChecksum(sql: string): string {
  return createHash('sha256').update(sql.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

export function loadConnectorMigrations(directory: string): ConnectorMigrationFile[] {
  const filenames = readdirSync(directory)
    .filter((filename) => /^\d{3}_.+\.sql$/.test(filename))
    .sort();
  const files = filenames.map((filename) => {
    const sql = readFileSync(join(directory, filename), 'utf8');
    const version = filename.slice(0, -'.sql'.length);
    return {
      version,
      filename,
      sequence: Number.parseInt(filename.slice(0, 3), 10),
      sql,
      checksum: connectorMigrationChecksum(sql),
    };
  });
  const seen = new Map<number, string>();
  for (const file of files) {
    const previous = seen.get(file.sequence);
    if (previous !== undefined) {
      throw new Error(
        `duplicate Connector migration sequence ${file.sequence}: ${previous} and ${file.filename} — renumber one file before running`,
      );
    }
    seen.set(file.sequence, file.filename);
  }
  return files;
}

async function tableExists(client: Pick<PoolClient, 'query'>): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     ) AS exists`,
    [TRACKING_TABLE],
  );
  return result.rows[0]?.exists === true;
}

async function metadataColumns(client: Pick<PoolClient, 'query'>): Promise<Set<string>> {
  const result = await client.query<{ column_name: string }>(
    `SELECT column_name FROM information_schema.columns
     WHERE table_schema = current_schema() AND table_name = $1
       AND column_name = ANY($2::text[])`,
    [TRACKING_TABLE, REQUIRED_METADATA_COLUMNS],
  );
  return new Set(result.rows.map((row) => row.column_name));
}

async function inspectConnectorMigrations(
  client: Pick<PoolClient, 'query'>,
  files: ConnectorMigrationFile[],
): Promise<ConnectorInspection> {
  const hasTable = await tableExists(client);
  if (!hasTable) {
    return {
      hasTable,
      files,
      rows: [],
      rowsByVersion: new Map(),
      pending: files,
      unknownChecksums: [],
      baselineProvenance: [],
      problems: [],
    };
  }

  const columns = await metadataColumns(client);
  const hasCompleteMetadata = REQUIRED_METADATA_COLUMNS.every((column) => columns.has(column));
  const countResult = await client.query<{ count: number | string }>(
    `SELECT count(*)::int AS count FROM ${TRACKING_TABLE}`,
  );
  const count = Number(countResult.rows[0]?.count ?? 0);
  const rowSql = hasCompleteMetadata
    ? `SELECT version, filename, checksum, checksum_provenance, baseline_reviewed_at
       FROM ${TRACKING_TABLE} ORDER BY version`
    : `SELECT version, NULL::text AS filename, NULL::text AS checksum,
         NULL::text AS checksum_provenance, NULL::timestamptz AS baseline_reviewed_at
       FROM ${TRACKING_TABLE} ORDER BY version`;
  const rowResult = await client.query<ConnectorLedgerRow>(rowSql);
  const rows = rowResult.rows;
  const rowsByVersion = new Map<string, ConnectorLedgerRow>();
  const filesByVersion = new Map(files.map((file) => [file.version, file]));
  const problems: string[] = [];
  const unknownChecksums: string[] = [];
  const baselineProvenance: string[] = [];

  if (!Number.isSafeInteger(count) || count < 0 || count !== rows.length) {
    problems.push(`ledger row count is ${count}, but the row query returned ${rows.length}`);
  }
  for (const row of rows) {
    if (typeof row.version !== 'string' || row.version.length === 0) {
      problems.push(`ledger contains an unusable version value '${String(row.version)}'`);
      continue;
    }
    if (rowsByVersion.has(row.version)) {
      problems.push(`ledger contains duplicate version ${row.version}`);
      continue;
    }
    rowsByVersion.set(row.version, row);

    const file = filesByVersion.get(row.version);
    if (!file) {
      problems.push(`ledger version ${row.version} has no migration file on disk`);
      continue;
    }
    if (row.filename !== null && row.filename !== file.filename) {
      problems.push(`version ${row.version} is recorded as '${row.filename}' but the file on disk is '${file.filename}'`);
      continue;
    }
    if (row.checksum === null && row.checksum_provenance === null) {
      unknownChecksums.push(file.filename);
      continue;
    }
    if (row.filename === null || row.checksum === null || row.checksum_provenance === null) {
      problems.push(`filename or checksum metadata is incomplete for ${file.filename}`);
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

  const pending = files.filter((file) => !rowsByVersion.has(file.version));
  return { hasTable, files, rows, rowsByVersion, pending, unknownChecksums, baselineProvenance, problems };
}

function ledgerProblemMessage(inspection: ConnectorInspection, allowUnknown: boolean): string | undefined {
  const details = [...inspection.problems];
  if (!allowUnknown && inspection.unknownChecksums.length > 0) {
    details.push(
      `checksum baseline is unknown for [${inspection.unknownChecksums.join(', ')}]; review the existing database and run "pnpm run migrate:baseline-reviewed" once`,
    );
  }
  return details.length > 0 ? `Connector migration ledger integrity check failed: ${details.join('; ')}` : undefined;
}

/** Detect deleted tables or indexes claimed by a recorded migration. */
function declaredConnectorSchemaObjects(sql: string): string[] {
  const names: string[] = [];
  for (const rawLine of sql.split(/\r?\n/)) {
    const line = rawLine.replace(/--.*$/, '');
    const match = /^\s*CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$]*)/i.exec(line);
    if (match) names.push(match[1]!.toLowerCase());
  }
  return names;
}

async function connectorSchemaObjectExists(client: Pick<PoolClient, 'query'>, name: string): Promise<boolean> {
  const result = await client.query<{ exists: boolean }>(
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

async function recordedConnectorMigrationsMissingObjects(
  client: Pick<PoolClient, 'query'>,
  files: ConnectorMigrationFile[],
  done: Map<string, ConnectorLedgerRow>,
): Promise<Array<{ file: ConnectorMigrationFile; objects: string[] }>> {
  const drift: Array<{ file: ConnectorMigrationFile; objects: string[] }> = [];
  for (const file of files) {
    const row = done.get(file.version);
    if (!row || (row.filename !== null && row.filename !== file.filename)) continue;
    const missing: string[] = [];
    for (const name of declaredConnectorSchemaObjects(file.sql)) {
      if (!(await connectorSchemaObjectExists(client, name))) missing.push(name);
    }
    if (missing.length > 0) drift.push({ file, objects: missing });
  }
  return drift;
}

function connectorObjectDriftMessage(
  drift: Array<{ file: ConnectorMigrationFile; objects: string[] }>,
  action: 'apply' | 'verify' | 'baseline',
): string {
  const details = drift.map(({ file, objects }) => `${file.filename} → missing ${objects.join(', ')}`).join('; ');
  if (action === 'apply') {
    return `refusing to skip recorded Connector migrations against an incomplete schema: ${details}. Restore the object(s), or remove the stale connector_schema_migrations row(s) and re-run migrate after verifying the schema.`;
  }
  if (action === 'baseline') {
    return `refusing to baseline an incomplete Connector schema: ${details}`;
  }
  return `Connector schema verification failed: recorded migrations have missing table/index objects: ${details}`;
}

type MarkClientUnusable = (error: unknown) => void;

function clientReleaseError(error: unknown): Error {
  return error instanceof Error ? error : new Error(`Connector migration client cleanup failed: ${String(error)}`);
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

async function ensureTrackingMetadata(client: PoolClient, markClientUnusable: MarkClientUnusable): Promise<void> {
  await runTransaction(client, async () => {
    await client.query(`
      CREATE TABLE IF NOT EXISTS ${TRACKING_TABLE} (
        version text PRIMARY KEY,
        filename text,
        applied_at timestamptz NOT NULL DEFAULT now(),
        checksum text,
        checksum_provenance text,
        baseline_reviewed_at timestamptz
      )
    `);
    await client.query(`ALTER TABLE ${TRACKING_TABLE}
      ADD COLUMN IF NOT EXISTS filename text,
      ADD COLUMN IF NOT EXISTS checksum text,
      ADD COLUMN IF NOT EXISTS checksum_provenance text,
      ADD COLUMN IF NOT EXISTS baseline_reviewed_at timestamptz`);
  }, markClientUnusable);
}

async function withMigrationLock<T>(
  pool: Pool,
  work: (client: PoolClient, markClientUnusable: MarkClientUnusable) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
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
    result = await work(client, markClientUnusable);
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

export async function migrateConnector(pool: Pool, directory: string): Promise<{ applied: string[] }> {
  const files = loadConnectorMigrations(directory);
  return withMigrationLock(pool, async (client, markClientUnusable) => {
    await ensureTrackingMetadata(client, markClientUnusable);
    const inspection = await inspectConnectorMigrations(client, files);
    const problem = ledgerProblemMessage(inspection, false);
    if (problem) throw new Error(problem);

    const drift = await recordedConnectorMigrationsMissingObjects(client, files, inspection.rowsByVersion);
    if (drift.length > 0) throw new Error(connectorObjectDriftMessage(drift, 'apply'));

    const applied: string[] = [];
    for (const file of inspection.pending) {
      await runTransaction(client, async () => {
        await client.query(file.sql);
        await client.query(
          `INSERT INTO ${TRACKING_TABLE}
             (version, filename, checksum, checksum_provenance, baseline_reviewed_at)
           VALUES ($1, $2, $3, 'migration', NULL)`,
          [file.version, file.filename, file.checksum],
        );
      }, markClientUnusable);
      applied.push(file.filename);
    }
    return { applied };
  });
}

export async function baselineConnectorMigrationsReviewed(
  pool: Pool,
  directory: string,
): Promise<{ baselined: string[] }> {
  const files = loadConnectorMigrations(directory);
  return withMigrationLock(pool, async (client, markClientUnusable) => {
    await ensureTrackingMetadata(client, markClientUnusable);
    const inspection = await inspectConnectorMigrations(client, files);
    const problem = ledgerProblemMessage(inspection, true);
    if (problem) throw new Error(problem);
    const drift = await recordedConnectorMigrationsMissingObjects(client, files, inspection.rowsByVersion);
    if (drift.length > 0) throw new Error(connectorObjectDriftMessage(drift, 'baseline'));
    if (inspection.unknownChecksums.length === 0) return { baselined: [] };

    const filesByName = new Map(files.map((file) => [file.filename, file]));
    await runTransaction(client, async () => {
      for (const filename of inspection.unknownChecksums) {
        const file = filesByName.get(filename);
        if (!file) throw new Error(`cannot baseline missing Connector migration file ${filename}`);
        const result = await client.query(
          `UPDATE ${TRACKING_TABLE}
             SET filename = $1, checksum = $2, checksum_provenance = 'reviewed-baseline', baseline_reviewed_at = now()
           WHERE version = $3 AND checksum IS NULL AND checksum_provenance IS NULL`,
          [file.filename, file.checksum, file.version],
        );
        if (result.rowCount !== 1) {
          throw new Error(`Connector ledger changed while baselining ${filename}; no baseline was committed`);
        }
      }
    }, markClientUnusable);
    return { baselined: inspection.unknownChecksums };
  });
}

export async function verifyConnectorMigrations(pool: Pool, directory: string): Promise<void> {
  const files = loadConnectorMigrations(directory);
  const client = await pool.connect();
  try {
    const inspection = await inspectConnectorMigrations(client, files);
    if (!inspection.hasTable) {
      throw new Error('Connector schema is not up-to-date: no connector_schema_migrations table found. Run "pnpm run migrate" before starting the service.');
    }
    const problem = ledgerProblemMessage(inspection, false);
    if (problem) throw new Error(problem);
    if (inspection.pending.length > 0) {
      throw new Error(
        `Connector schema is not up-to-date: missing migrations [${inspection.pending.map((file) => file.filename).join(', ')}]. Run "pnpm run migrate" before starting the service.`,
      );
    }
    const drift = await recordedConnectorMigrationsMissingObjects(client, files, inspection.rowsByVersion);
    if (drift.length > 0) throw new Error(connectorObjectDriftMessage(drift, 'verify'));
  } finally {
    client.release();
  }
}

export async function connectorMigrationStatus(pool: Pool, directory: string): Promise<ConnectorMigrationStatus> {
  const files = loadConnectorMigrations(directory);
  const client = await pool.connect();
  try {
    const inspection = await inspectConnectorMigrations(client, files);
    const integrityProblems = [...inspection.problems];
    if (inspection.unknownChecksums.length === 0 && integrityProblems.length === 0 && inspection.hasTable) {
      const drift = await recordedConnectorMigrationsMissingObjects(client, files, inspection.rowsByVersion);
      for (const entry of drift) {
        integrityProblems.push(`${entry.file.filename} has missing table/index object(s): ${entry.objects.join(', ')}`);
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
  } finally {
    client.release();
  }
}
