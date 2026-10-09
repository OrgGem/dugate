/**
 * Explicit one-shot migration runner (R08-06 / P2-01).
 *
 * Tracks applied migrations in a `schema_migrations` table so each SQL file
 * runs exactly once, regardless of how many times the server boots. The
 * `migrate()` function is idempotent and safe to call on any database —
 * including test databases that already have the schema from a prior run.
 *
 * Production deployment order:
 *   1. `npm run migrate`  (apply pending SQL files, verify after)
 *   2. `npm start`        (server boots, skips migration)
 *
 * Rollback: each migration SQL is additive (CREATE IF NOT EXISTS). A
 * rollback would revert code to a prior version; the schema remains
 * forward-compatible. Down-migrations are not implemented in v1.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Db } from './db';

// Migrations live next to the package root (services/orchestrator/migrations),
// one level up from this file in both source (src/db) and compiled (dist/db).
const MIGRATIONS_DIR = join(__dirname, '../../migrations');

interface MigrationFile {
  filename: string;
  sequence: number;
  sql: string;
}

/**
 * Load migration files from disk, sorted by their numeric prefix.
 * Only filenames matching /^\d{4}_.*\.sql$/ are considered.
 */
export function loadMigrationFiles(dir: string): MigrationFile[] {
  const files = readdirSync(dir)
    .filter((f) => /^\d{4}_.*\.sql$/.test(f))
    .sort();
  const loaded = files.map((filename) => ({
    filename,
    sequence: parseInt(filename.slice(0, 4), 10),
    sql: readFileSync(join(dir, filename), 'utf8'),
  }));
  // Cycle-84 guard (reviewer R1-A/R2-A collision finding): two files
  // sharing the 4-digit prefix produced two inserts of the same
  // schema_migrations PK — migrate() crashed mid-run, the second file's
  // DDL rolled back, and EVERY later verify/migrate false-greens because
  // sequence 11 was already recorded. Duplicate prefixes are a packaging
  // bug, so fail loudly at load time (boot, migrate and verify all call
  // this) instead of corrupting the ledger.
  const seen = new Map<number, string>();
  for (const m of loaded) {
    const previous = seen.get(m.sequence);
    if (previous !== undefined) {
      throw new Error(
        `duplicate migration sequence ${m.sequence}: ${previous} and ${m.filename} — renumber one file before running`
      );
    }
    seen.set(m.sequence, m.filename);
  }
  return loaded;
}

/**
 * Ensure the tracking table exists. Uses IF NOT EXISTS — safe to run
 * on every `migrate()` call or on a database that never saw a migration.
 */
async function ensureTrackingTable(db: Db): Promise<void> {
  await db.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      sequence    integer PRIMARY KEY,
      filename    text NOT NULL,
      applied_at  timestamptz NOT NULL DEFAULT now()
    )
  `);
}

/**
 * Return the applied ledger keyed by sequence, keeping the recorded
 * filename. Cycle-84: filename matters — a sequence recorded under a
 * different filename means the ledger and the files on disk diverged
 * (renumbered/renamed migration), which sequence-only checks false-green.
 */
async function appliedMigrations(db: Db): Promise<Map<number, string>> {
  const res = await db.query<{ sequence: number; filename: string }>(
    'SELECT sequence, filename FROM schema_migrations'
  );
  return new Map(res.rows.map((r) => [Number(r.sequence), r.filename]));
}

/**
 * Read-only check that the tracking table exists. Does not create it.
 */
async function trackingTableExists(db: Db): Promise<boolean> {
  const res = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'schema_migrations'
     ) AS exists`
  );
  return res.rows[0]?.exists ?? false;
}

/**
 * MED-1 (WFA section 8): the table/index objects a migration file declares as
 * its own — `CREATE [UNIQUE] [TABLE|INDEX] [CONCURRENTLY] [IF NOT EXISTS]
 * <name>`. Comment lines are stripped first (0019 carries commented-out DDL)
 * and column-level ALTERs are deliberately not covered: a dropped table or
 * index is the drift this guard exists to catch.
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

/**
 * MED-1: does `name` still exist as a table or an index in the current
 * schema? Tables are visible through information_schema, indexes through
 * pg_indexes — both read-only catalog probes.
 */
async function schemaObjectExists(db: Db, name: string): Promise<boolean> {
  const res = await db.query<{ exists: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM information_schema.tables
       WHERE table_schema = current_schema() AND table_name = $1
     ) OR EXISTS (
       SELECT 1 FROM pg_indexes
       WHERE schemaname = current_schema() AND indexname = $1
     ) AS exists`,
    [name],
  );
  return res.rows[0]?.exists === true;
}

interface RecordedMigrationDrift {
  sequence: number;
  filename: string;
  objects: string[];
}

/**
 * MED-1 (WFA section 8 security review): a ledger row claims its file was
 * applied — but the shipped DDL is `CREATE ... IF NOT EXISTS`, so the loop in
 * `migrate()` skips the file even if the object was dropped since. Return the
 * recorded migrations whose declared table/index objects are missing so the
 * caller can fail closed instead of booting against an incomplete schema.
 */
async function recordedMigrationsMissingObjects(
  db: Db,
  files: MigrationFile[],
  done: Map<number, string>,
): Promise<RecordedMigrationDrift[]> {
  const drift: RecordedMigrationDrift[] = [];
  for (const file of files) {
    if (!done.has(file.sequence)) continue;
    const declared = declaredSchemaObjects(file.sql);
    if (declared.length === 0) continue;
    const missing: string[] = [];
    for (const name of declared) {
      if (!(await schemaObjectExists(db, name))) missing.push(name);
    }
    if (missing.length > 0) {
      drift.push({ sequence: file.sequence, filename: file.filename, objects: missing });
    }
  }
  return drift;
}

/**
 * Run all pending migrations in sequence order, recording each in
 * `schema_migrations`.  On failure the tracking row is NOT inserted
 * (the INSERT is inside the same transaction via `db.tx`), so the
 * next run re-attempts the failed migration.
 */
export async function migrate(db: Db): Promise<{ applied: string[] }> {
  const files = loadMigrationFiles(MIGRATIONS_DIR);
  await ensureTrackingTable(db);
  const done = await appliedMigrations(db);

  // MED-1 (WFA section 8 security review): the loop below SKIPS every recorded
  // sequence. Because the shipped DDL is `CREATE ... IF NOT EXISTS`, a ledger
  // row whose object was dropped would be skipped in silence and the boot
  // would false-green against an incomplete schema. Validate the recorded
  // migrations' declared tables/indexes first and refuse to skip on drift.
  const drifted = await recordedMigrationsMissingObjects(db, files, done);
  if (drifted.length > 0) {
    const detail = drifted
      .map((d) => `${d.filename} → missing ${d.objects.join(', ')}`)
      .join('; ');
    throw new Error(
      `refusing to skip recorded migrations against an incomplete schema: ${detail}. `
        + 'schema_migrations claims these files were applied, but the database no longer has the '
        + 'table/index object(s) they declare (an object was dropped while the ledger row stayed). '
        + 'Restore the object(s), or delete the stale ledger row(s) and re-run migrate after verifying '
        + `the schema, e.g. DELETE FROM schema_migrations WHERE sequence IN (${drifted.map((d) => d.sequence).join(', ')}); `
        + '— never trust the ledger past this point.'
    );
  }

  const applied: string[] = [];

  for (const file of files) {
    if (done.has(file.sequence)) continue;
    await db.tx(async (client) => {
      await client.query(file.sql);
      await client.query(
        'INSERT INTO schema_migrations (sequence, filename) VALUES ($1, $2)',
        [file.sequence, file.filename],
      );
    });
    applied.push(file.filename);
  }

  return { applied };
}

/**
 * Verify that every migration file on disk has been applied. Returns
 * without error if the database is up-to-date; throws with a clear
 * message listing missing migrations if not.  This function is
 * READ-ONLY — it never writes to the database, so a boot-time check
 * performs no hidden writes.
 */
export async function verifyMigrations(db: Db): Promise<void> {
  const files = loadMigrationFiles(MIGRATIONS_DIR);
  const hasTable = await trackingTableExists(db);
  if (!hasTable) {
    throw new Error(
      'schema is not up-to-date: no schema_migrations table found. Run "npm run migrate" before starting the server.'
    );
  }
  // Cycle-85 guard (MIGRATION-VERIFY-TRAP): the ledger read is cross-checked
  // against an independent COUNT so a read that silently dropped rows cannot
  // pass as "up to date". `appliedMigrations` keys a Map by Number(sequence),
  // so two rows collapsing onto one key (or a non-numeric sequence) leaves the
  // Map SMALLER than the table while every file-level check below still
  // succeeds — which is exactly the false-green this packet exists to close.
  const countRes = await db.query<{ count: number | string }>(
    'SELECT count(*)::int AS count FROM schema_migrations'
  );
  const ledgerRows = Number(countRes.rows[0]?.count ?? 0);
  const done = await appliedMigrations(db);

  if (!Number.isSafeInteger(ledgerRows) || ledgerRows < 0 || done.size !== ledgerRows) {
    throw new Error(
      `schema_migrations ledger is not readable as recorded: SELECT count(*) reports ${ledgerRows} row(s) `
        + `but only ${done.size} distinct sequence(s) could be registered from the same table. Either a row's `
        + `sequence is not a usable integer or rows collapsed onto one key, and the file-level checks below `
        + `would false-green past it. Inspect the ledger directly: `
        + 'SELECT sequence, filename FROM schema_migrations ORDER BY sequence; — never trust verify past this point.'
    );
  }

  // Cycle-84 guard: sequence recorded under a DIFFERENT filename means the
  // ledger was written by a file that no longer exists under that name
  // (renumber/rename). Trusting sequence alone false-greens the real
  // schema gap — fail with the exact repair hint instead.
  const mislabeled = files.filter(
    (f) => done.has(f.sequence) && done.get(f.sequence) !== f.filename
  );
  if (mislabeled.length > 0) {
    const detail = mislabeled
      .map((f) => `sequence ${f.sequence} is recorded as '${done.get(f.sequence)}' but the file on disk is '${f.filename}'`)
      .join('; ');
    throw new Error(
      `schema_migrations ledger does not match files on disk: ${detail}. Delete the stale ledger row(s) and re-run migrate after verifying the corresponding objects, e.g. DELETE FROM schema_migrations WHERE sequence IN (${mislabeled.map((f) => f.sequence).join(', ')}); — never trust verify past this point.`
    );
  }
  // A ledger row for a sequence that has no file on disk is either a leftover
  // from a deleted/renumbered migration, or a hand-rolled change that wrote
  // the ledger without writing the file. Either way the ledger claims applied
  // work the files cannot account for — a mismatch the file-level checks below
  // would never see.
  const onDisk = new Set(files.map((f) => f.sequence));
  const orphaned = [...done.keys()].filter((seq) => !onDisk.has(seq));
  if (orphaned.length > 0) {
    const listed = orphaned
      .slice()
      .sort((a, b) => {
        const d = a - b;
        return Number.isNaN(d) ? 0 : d;
      })
      .map(String)
      .join(', ');
    throw new Error(
      `schema_migrations records sequence(s) [${listed}] that have no migration file on disk: `
        + `the ledger claims applied work the files cannot account for. Delete the stale ledger row(s) and `
        + `re-run migrate after verifying the corresponding objects, e.g. `
        + `DELETE FROM schema_migrations WHERE sequence IN (${listed}); — never trust verify past this point.`
    );
  }

  const missing = files.filter((f) => !done.has(f.sequence));
  if (missing.length > 0) {
    const names = missing.map((f) => f.filename).join(', ');
    throw new Error(
      `schema is not up-to-date: missing migrations [${names}]. Run "npm run migrate" before starting the server.`
    );
  }

  const drifted = await recordedMigrationsMissingObjects(db, files, done);
  if (drifted.length > 0) {
    const detail = drifted
      .map((d) => `${d.filename} → missing ${d.objects.join(', ')}`)
      .join('; ');
    throw new Error(
      `schema verification failed: recorded migrations have missing table/index objects: ${detail}. `
        + 'schema_migrations claims these files were applied, but the database no longer has the '
        + 'table/index object(s) they declare. Restore the object(s), or delete the stale ledger '
        + 'row(s) and re-run migrate after verifying the schema, then run verify again.'
    );
  }
}

/**
 * Return the current migration state for diagnostics. Read-only.
 */
export async function migrationStatus(db: Db): Promise<{
  total: number;
  applied: number;
  pending: string[];
}> {
  const files = loadMigrationFiles(MIGRATIONS_DIR);
  const hasTable = await trackingTableExists(db);
  if (!hasTable) return { total: files.length, applied: 0, pending: files.map((f) => f.filename) };
  const done = await appliedMigrations(db);
  const pending = files.filter((f) => !done.has(f.sequence)).map((f) => f.filename);
  return { total: files.length, applied: files.length - pending.length, pending };
}
