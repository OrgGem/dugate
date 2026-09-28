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
 * Run all pending migrations in sequence order, recording each in
 * `schema_migrations`.  On failure the tracking row is NOT inserted
 * (the INSERT is inside the same transaction via `db.tx`), so the
 * next run re-attempts the failed migration.
 */
export async function migrate(db: Db): Promise<{ applied: string[] }> {
  const files = loadMigrationFiles(MIGRATIONS_DIR);
  await ensureTrackingTable(db);
  const done = await appliedMigrations(db);
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
  const done = await appliedMigrations(db);
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
  const missing = files.filter((f) => !done.has(f.sequence));
  if (missing.length > 0) {
    const names = missing.map((f) => f.filename).join(', ');
    throw new Error(
      `schema is not up-to-date: missing migrations [${names}]. Run "npm run migrate" before starting the server.`
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
