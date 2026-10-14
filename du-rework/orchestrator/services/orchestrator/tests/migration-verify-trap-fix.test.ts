import { join } from 'node:path';
import type { Db } from '../src/db/db';
import { loadMigrationFiles, migrationChecksum, migrationStatus, verifyMigrations } from '../src/db/migrations';

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
  readonly unknownChecksums?: boolean;
  readonly checksumDriftFor?: number;
}

function fakeDb(options: FakeOptions): Db {
  const files = new Map(loadMigrationFiles(MIGRATIONS_DIR).map((file) => [file.sequence, file]));
  return {
    pool: undefined,
    query: async (text: string) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ exists: options.tableExists !== false }], rowCount: 1 };
      }
      if (sql.includes('information_schema.columns')) {
        return {
          rows: options.unknownChecksums
            ? []
            : [{ column_name: 'checksum' }, { column_name: 'checksum_provenance' }, { column_name: 'baseline_reviewed_at' }],
          rowCount: options.unknownChecksums ? 0 : 3,
        };
      }
      if (sql.startsWith('SELECT count(*)::int AS count FROM schema_migrations')) {
        return { rows: [{ count: options.count ?? options.rows.length }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT sequence, filename,')) {
        const rows = options.rows.map((row) => ({
          ...row,
          checksum: options.unknownChecksums || sql.includes('NULL::text AS checksum')
            ? null
            : row.sequence === options.checksumDriftFor
              ? '0'.repeat(64)
              : files.get(row.sequence)?.checksum ?? '0'.repeat(64),
          checksum_provenance: options.unknownChecksums || sql.includes('NULL::text AS checksum_provenance') ? null : 'migration',
          baseline_reviewed_at: null,
        }));
        return { rows, rowCount: rows.length };
      }
      if (sql.startsWith('SELECT EXISTS (') && sql.includes('pg_indexes')) {
        return { rows: [{ exists: true }], rowCount: 1 };
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

describe('migration checksum normalization', () => {
  test('CRLF checkouts hash the same as LF while SQL changes alter the digest', () => {
    expect(migrationChecksum('CREATE TABLE x;\r\n')).toBe(migrationChecksum('CREATE TABLE x;\n'));
    expect(migrationChecksum('CREATE TABLE x;')).not.toBe(migrationChecksum('CREATE TABLE y;'));
  });
});

describe('verifyMigrations: mismatch reports with real evidence', () => {
  test('the table has MORE rows than the read registered -> throws with both numbers', async () => {
    const rows = realRows();
    // WT-08: derive from the real migration-directory count instead of
    // hardcoding 33/32. The directory grows (36 files as of 0001..0036), and a
    // hardcoded number turns "a migration was added" into a false red here.
    const registered = rows.length;
    const claimed = registered + 1;
    // `count` says more rows exist than the read registered.
    await expect(verifyMigrations(fakeDb({ rows, count: claimed }))).rejects.toThrow(
      /ledger row count is/,
    );
    await expect(verifyMigrations(fakeDb({ rows, count: claimed }))).rejects.toThrow(
      new RegExp(`row count is ${claimed}`),
    );
    await expect(verifyMigrations(fakeDb({ rows, count: claimed }))).rejects.toThrow(
      new RegExp(`returned ${registered}`),
    );
  });

  test('rows collapsing onto one sequence key are caught by the count cross-check', async () => {
    const base = realRows();
    // A duplicate sequence must be rejected even if every file-level row is present.
    const rows = [...base, { sequence: base[0]!.sequence, filename: base[0]!.filename }];
    const db = fakeDb({ rows, count: rows.length });
    await expect(verifyMigrations(db)).rejects.toThrow(/duplicate sequence/);
  });

  test('a non-numeric sequence is not silently accepted either', async () => {
    const rows = [...realRows(), { sequence: Number.NaN, filename: '0099_ghost.sql' }];
    const db = fakeDb({ rows, count: rows.length });
    await expect(verifyMigrations(db)).rejects.toThrow(
      /unusable sequence value/,
    );
  });

  test('an ORPHAN ledger row (sequence with no file on disk) throws', async () => {
    const rows = [...realRows(), { sequence: 99, filename: '0099_ghost.sql' }];
    const db = fakeDb({ rows });
    await expect(verifyMigrations(db)).rejects.toThrow(
      /ledger sequence 99 .* has no migration file on disk/,
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

  test('legacy rows remain unknown until an explicit reviewed baseline', async () => {
    const rows = realRows();
    const db = fakeDb({ rows, unknownChecksums: true });
    const status = await migrationStatus(db);
    expect(status.unknownChecksums).toHaveLength(rows.length);
    await expect(verifyMigrations(db)).rejects.toThrow(/checksum baseline is unknown/);
    await expect(verifyMigrations(db)).rejects.toThrow(/migrate:baseline-reviewed/);
  });

  test('changed SQL is rejected by its ledger checksum', async () => {
    const rows = realRows();
    await expect(verifyMigrations(fakeDb({ rows, checksumDriftFor: rows[0]!.sequence }))).rejects.toThrow(/checksum drift/);
  });
});
