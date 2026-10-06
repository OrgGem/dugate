import { join } from 'node:path';
import type { Db } from '../src/db/db';
import { loadMigrationFiles, verifyMigrations } from '../src/db/migrations';

/**
 * MIGRATION-VERIFY-TRAP-FIX — the false-green in `verifyMigrations`.
 *
 * Before this packet, `verifyMigrations` compared ONLY files-on-disk against
 * the ledger (`done`). It never cross-checked the ledger against the table it
 * was read from, so two classes of divergence passed silently:
 *
 *   1. a ledger read that lost rows — `appliedMigrations` keys a Map by
 *      `Number(sequence)`, so rows collapsing onto one key (or a non-numeric
 *      sequence) leave the Map SMALLER than the table while every file-level
 *      check still succeeds;
 *   2. a ledger row for a sequence with no file on disk, which no check
 *      looked at because every check iterated `files`, not the ledger.
 *
 * The fix adds an independent `SELECT count(*)` cross-check plus an orphan
 * check. These tests drive `verifyMigrations` for real against a fake `Db`
 * whose count and row list can be made to disagree on purpose.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

interface LedgerRow { sequence: number; filename: string }

interface FakeOptions {
  /** Rows returned by `SELECT sequence, filename FROM schema_migrations`. */
  readonly rows: LedgerRow[];
  /** Value returned by the independent `SELECT count(*)`. Defaults to rows.length. */
  readonly count?: number;
  readonly tableExists?: boolean;
}

function fakeDb(options: FakeOptions): Db {
  return {
    pool: undefined,
    query: async (text: string) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ exists: options.tableExists !== false }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT count(*)::int AS count FROM schema_migrations')) {
        return { rows: [{ count: options.count ?? options.rows.length }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT sequence, filename FROM schema_migrations')) {
        return { rows: options.rows, rowCount: options.rows.length };
      }
      throw new Error('unexpected SQL in fake ledger db: ' + sql.slice(0, 70));
    },
    tx: async () => {
      throw new Error('verify must not write');
    },
    close: async () => undefined,
  } as unknown as Db;
}

function realRows(): LedgerRow[] {
  return loadMigrationFiles(MIGRATIONS_DIR).map((f) => ({ sequence: f.sequence, filename: f.filename }));
}

describe('verifyMigrations: consistent ledger passes', () => {
  test('every file applied exactly once, count agrees -> resolves', async () => {
    const rows = realRows();
    await expect(verifyMigrations(fakeDb({ rows }))).resolves.toBeUndefined();
  });
});

describe('verifyMigrations: mismatch reports with real evidence', () => {
  test('the table has MORE rows than the read registered -> throws with both numbers', async () => {
    const rows = realRows();
    // count says 33 rows exist, the read registered only 32 sequences.
    await expect(verifyMigrations(fakeDb({ rows, count: rows.length + 1 }))).rejects.toThrow(
      /ledger is not readable as recorded/,
    );
    await expect(verifyMigrations(fakeDb({ rows, count: rows.length + 1 }))).rejects.toThrow(
      /SELECT count\(\*\) reports 33 row\(s\)/,
    );
    await expect(verifyMigrations(fakeDb({ rows, count: rows.length + 1 }))).rejects.toThrow(
      /only 32 distinct sequence\(s\)/,
    );
  });

  test('rows collapsing onto one sequence key are caught by the count cross-check', async () => {
    const base = realRows();
    // `appliedMigrations` keys a Map by Number(sequence): two ledger rows on
    // the same sequence register as ONE entry, so the table still reports
    // N+1 rows while only N sequences survive the read.
    const rows = [...base, { sequence: base[0]!.sequence, filename: base[0]!.filename }];
    const db = fakeDb({ rows, count: rows.length });
    await expect(verifyMigrations(db)).rejects.toThrow(/ledger is not readable as recorded/);
    await expect(verifyMigrations(db)).rejects.toThrow(new RegExp(`${rows.length} row\\(s\\)`));
    await expect(verifyMigrations(db)).rejects.toThrow(new RegExp(`only ${base.length} distinct sequence`));
  });

  test('a non-numeric sequence is not silently accepted either', async () => {
    const rows = [...realRows(), { sequence: Number.NaN, filename: '0099_ghost.sql' }];
    const db = fakeDb({ rows, count: rows.length });
    await expect(verifyMigrations(db)).rejects.toThrow(
      /never trust verify past this point/,
    );
  });

  test('an ORPHAN ledger row (sequence with no file on disk) throws', async () => {
    const rows = [...realRows(), { sequence: 99, filename: '0099_ghost.sql' }];
    const db = fakeDb({ rows });
    await expect(verifyMigrations(db)).rejects.toThrow(
      /records sequence\(s\) \[99\] that have no migration file on disk/,
    );
    await expect(verifyMigrations(db)).rejects.toThrow(
      /DELETE FROM schema_migrations WHERE sequence IN \(99\)/,
    );
  });

  test('an EMPTY ledger throws (all files reported missing)', async () => {
    const db = fakeDb({ rows: [], count: 0 });
    await expect(verifyMigrations(db)).rejects.toThrow(/missing migrations/);
  });

  test('a missing schema_migrations table still throws before any count query', async () => {
    await expect(verifyMigrations(fakeDb({ rows: [], tableExists: false }))).rejects.toThrow(
      /no schema_migrations table found/,
    );
  });
});

describe('verifyMigrations: verify is READ-ONLY', () => {
  test('the fake would fail any write; resolving above proves none was issued', async () => {
    // fakeDb.tx throws unconditionally, and the fake query throws on unknown
    // SQL. Every test above therefore also asserts the runner issued no write
    // and no unexpected statement.
    await expect(verifyMigrations(fakeDb({ rows: realRows() }))).resolves.toBeUndefined();
  });
});