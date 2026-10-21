import { join } from 'node:path';
import { Pool } from 'pg';
import { createDb, type Db } from '../../src/db/db';
import { loadMigrationFiles, migrate } from '../../src/db/migrations';
import { validateTestDatabaseTarget } from './test-target-guard';

/**
 * PC-09 shared live-PostgreSQL harness.
 *
 * Four accepted suites each carried their own copy of this logic
 * (`migrations.test.ts`, `profile-control-plane-migration.test.ts`,
 * `profile-resolution-pg.test.ts`, `profile-groups-v2-pg.test.ts`). This module
 * is the single implementation new suites use, so a future change to the
 * scratch-database contract (guard rules, migration runner, cleanup) lands in
 * one place. The existing suites are deliberately left untouched: they are
 * accepted evidence, and rewriting them is not this packet's business.
 *
 * Contract, in the order it runs:
 *
 *  1. The **base** `DATABASE_URL` passes `validateTestDatabaseTarget` — loopback
 *     host only, and the base database name must already look like a test
 *     database. A production URL is refused before a single connection opens.
 *  2. The derived scratch URL passes the same guard. Its name always ends in
 *     `_test`, so the guard's naming rule holds for the thing we actually
 *     migrate.
 *  3. The scratch database is dropped (with stragglers terminated), created, and
 *     migrated by the **real runner** (`migrate`), which means checksums, the
 *     one-transaction-per-file rule and the declared-object drift guard are all
 *     exercised exactly as they are at boot.
 *  4. `close()` drops the database and closes both pools, even after a partial
 *     failure.
 *
 * The database name is deterministic per `suite`, not random: a rerun reclaims
 * the previous attempt's database instead of leaking a new one per crash. The
 * repository runs these suites with `--runInBand`, so two concurrent instances
 * of the same suite are not a supported configuration — use a distinct `suite`
 * string if that ever changes.
 */

/** The default base URL the accepted live suites already use. */
const DEFAULT_TEST_DATABASE_URL = 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';

/** `<service>/migrations`, resolved from `tests/helpers/`. */
export const SCRATCH_MIGRATIONS_DIR = join(__dirname, '../../migrations');

export interface ScratchDatabase {
  /** Connection string for the freshly migrated scratch database. */
  readonly url: string;
  /** The scratch database name (always `_test`-suffixed). */
  readonly databaseName: string;
  /** Open handle, already migrated. Surrendered by `close()`. */
  readonly db: Db;
  /** Migration filenames the runner applied, in order. */
  readonly applied: readonly string[];
  /** Drops the database and closes both pools. Idempotent. */
  close(): Promise<void>;
}

export interface WithScratchDatabaseInput {
  /**
   * Stable, human-readable suite id. Becomes the database name suffix, so keep
   * it short and unique per file (for example `'pc09-matrix'`).
   */
  suite: string;
  /** Overrides `process.env.DATABASE_URL`. */
  databaseUrl?: string;
  /** Overrides the packaged migrations directory (migration-order tests). */
  migrationsDir?: string;
  /** Skip the runner entirely (a suite that wants a truly empty database). */
  applyAllMigrations?: boolean;
}

/** `pc09-matrix` → `pc09_matrix`, bounded so the name stays readable. */
function suiteSegment(suite: string): string {
  const normalized = suite
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '');
  if (normalized.length === 0) {
    throw new Error('withScratchDatabase: suite must contain at least one alphanumeric character');
  }
  return normalized.slice(0, 40);
}

function maintenanceUrlFor(base: URL): string {
  const maintenance = new URL(base.toString());
  maintenance.pathname = '/postgres';
  return maintenance.toString();
}

/**
 * Create, migrate and return a scratch database.
 *
 * The caller owns the returned handle and MUST call `close()`; `afterAll` is the
 * expected place. If migration throws, this function already cleaned up before
 * rethrowing, so a failed setup cannot strand a half-migrated database.
 */
export async function withScratchDatabase(input: WithScratchDatabaseInput): Promise<ScratchDatabase> {
  const rawBase = input.databaseUrl ?? process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL;
  // Guard first: a production target must be refused before any connection.
  validateTestDatabaseTarget(rawBase);

  const databaseName = `du_scratch_${suiteSegment(input.suite)}_test`;
  const base = new URL(rawBase);
  base.pathname = `/${databaseName}`;
  const scratchUrl = base.toString();
  validateTestDatabaseTarget(scratchUrl);

  const maintenanceUrl = maintenanceUrlFor(base);
  const admin = new Pool({ connectionString: maintenanceUrl, max: 1 });
  let db: Db | undefined;
  let dropped = false;

  const dropDatabase = async (): Promise<void> => {
    if (dropped) return;
    dropped = true;
    const client = await admin.connect();
    try {
      await client.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [databaseName],
      );
      // The identifier is generated from a sanitized slug, never caller text.
      await client.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
    } finally {
      client.release();
    }
  };

  const close = async (): Promise<void> => {
    try {
      await db?.close();
    } catch {
      /* closing a broken pool must not hide the original failure */
    }
    try {
      await dropDatabase();
    } finally {
      await admin.end();
    }
  };

  try {
    const createClient = await admin.connect();
    try {
      await createClient.query(
        'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()',
        [databaseName],
      );
      await createClient.query(`DROP DATABASE IF EXISTS "${databaseName}"`);
      // No template and no encoding tricks: a plain, empty database.
      await createClient.query(`CREATE DATABASE "${databaseName}"`);
    } finally {
      createClient.release();
    }

    db = createDb(scratchUrl);
    let applied: readonly string[] = [];
    if (input.applyAllMigrations !== false) {
      const result = await migrate(db, input.migrationsDir ?? SCRATCH_MIGRATIONS_DIR);
      applied = result.applied;
    }
    return { url: scratchUrl, databaseName, db, applied, close };
  } catch (error) {
    await close().catch(() => undefined);
    throw error;
  }
}

/** How many migration files the packaged directory declares. */
export function expectedMigrationCount(migrationsDir = SCRATCH_MIGRATIONS_DIR): number {
  return loadMigrationFiles(migrationsDir).length;
}
