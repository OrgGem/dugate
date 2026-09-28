import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../src/db/db';
import { loadMigrationFiles, verifyMigrations } from '../src/db/migrations';

/**
 * Cycle-84 regression guard (reviewer R1-A/R2-A finding + FULL-REWORK
 * priority-0): the collision that broke Tester Round 7 was two files
 * sharing sequence 0011 — migrate() double-inserted the schema_migrations
 * PK, and every later verify false-greens on the surviving sequence.
 * The runner must (a) REJECT duplicate prefixes at load time and (b) match
 * the recorded FILENAME, not just the sequence. Offline — a temp dir and a
 * fake ledger Db; zero PG.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function fakeLedgerDb(rows: { sequence: number; filename: string }[]): Db {
  return {
    pool: undefined,
    query: async (text: string) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT sequence, filename FROM schema_migrations')) {
        return { rows, rowCount: rows.length };
      }
      throw new Error('unexpected SQL in fake ledger db: ' + sql.slice(0, 60));
    },
    tx: async () => {
      throw new Error('verify must not write');
    },
    close: async () => undefined,
  } as unknown as Db;
}

describe('cycle-84 loadMigrationFiles rejects duplicate sequences', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mig-dup-'));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it('two files sharing a 4-digit prefix throw at LOAD time (before any write)', () => {
    writeFileSync(join(dir, '0011_alpha.sql'), 'CREATE TABLE IF NOT EXISTS alpha (id int);');
    writeFileSync(join(dir, '0011_beta.sql'), 'CREATE TABLE IF NOT EXISTS beta (id int);');
    expect(() => loadMigrationFiles(dir)).toThrow(/duplicate migration sequence 11/);
    try {
      loadMigrationFiles(dir);
    } catch (e) {
      const msg = String(e);
      expect(msg).toContain('0011_alpha.sql');
      expect(msg).toContain('0011_beta.sql');
      expect(msg).toContain('renumber');
    }
  });

  it('unique prefixes load sorted and intact', () => {
    writeFileSync(join(dir, '0002_b.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '0001_a.sql'), 'SELECT 1;');
    writeFileSync(join(dir, '0012_c.sql'), 'SELECT 1;');
    const files = loadMigrationFiles(dir);
    expect(files.map((f) => f.sequence)).toEqual([1, 2, 12]);
    expect(files.map((f) => f.filename)).toEqual(['0001_a.sql', '0002_b.sql', '0012_c.sql']);
  });

  it('the shipped migrations directory itself has no duplicate sequence (package-level pin)', () => {
    const files = loadMigrationFiles(MIGRATIONS_DIR);
    expect(files.some((f) => f.filename === '0011_artifact_finalize_epoch.sql')).toBe(true);
    expect(files.some((f) => f.filename === '0012_admin_idempotency.sql')).toBe(true);
    expect(files.some((f) => f.filename === '0013_artifact_storage_version.sql')).toBe(true);
    expect(files.some((f) => f.filename === '0011_admin_idempotency.sql')).toBe(false);
  });
});

/**
 * W-ADMUX02-IDX-1 (ADM-UX-02): the keyset cursor added in Mục 3 pages on
 * ORDER BY created_at DESC, id DESC, so the shipped migrations must carry an
 * index whose column list covers that exact sort key — including the `id`
 * tiebreak, which is what keeps rows sharing an instant from being skipped or
 * repeated across pages. This is a CONTENT pin, so it runs offline: it fails
 * if the migration is renamed away or its column order regresses. Whether
 * Postgres actually picks it is the live EXPLAIN leg (migrations.test.ts,
 * needs a DB window).
 */
describe('W-ADMUX02-IDX-1: operations keyset index is shipped', () => {
  const KEYSET_MIGRATION = '0017_operations_keyset_index.sql';

  it('the migration file exists and is picked up by the loader', () => {
    const files = loadMigrationFiles(MIGRATIONS_DIR);
    expect(files.some((f) => f.filename === KEYSET_MIGRATION)).toBe(true);
    expect(files.find((f) => f.filename === KEYSET_MIGRATION)?.sequence).toBe(17);
  });

  it('declares the composite keyset index, idempotently, in the keyset column order', () => {
    const sql = loadMigrationFiles(MIGRATIONS_DIR).find(
      (f) => f.filename === KEYSET_MIGRATION
    )!.sql.replace(/\s+/g, ' ');
    // Idempotent: re-running migrate() must be a no-op, not a duplicate-index error.
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS operations_tenant_created_id_idx/);
    // Column order and direction are load-bearing, not cosmetic: DESC DESC is
    // what lets the index satisfy the route's ORDER BY without a Sort node.
    expect(sql).toMatch(
      /ON operations \(tenant_id, created_at DESC, id DESC\)/
    );
    // The old half-covered index stays: dropping it needs live EXPLAIN evidence.
    expect(sql).not.toMatch(/DROP INDEX/);
  });

  it('also declares the cross-tenant keyset index for the platform admin list', () => {
    // W-ADMUX02-IDX-2 (delta 22): the platform bearer sends no tenant predicate,
    // so the tenant-leading index above cannot seek. This one is led straight off
    // the sort key and is what keeps the admin console from sorting.
    const sql = loadMigrationFiles(MIGRATIONS_DIR).find(
      (f) => f.filename === KEYSET_MIGRATION
    )!.sql.replace(/\s+/g, ' ');
    expect(sql).toMatch(/CREATE INDEX IF NOT EXISTS operations_created_id_idx/);
    // No tenant_id in the key -- a tenant-leading index would not help here.
    expect(sql).toMatch(/ON operations \(created_at DESC, id DESC\)/);
    // Still idempotent, and the old index is still not dropped.
    expect(sql).not.toMatch(/DROP INDEX/);
  });
});

/**
 * W-ADMUX02-IDX-SORT-0018 (ADM-UX-02): the two sort keys added to the operations
 * list by W-ADMUX02-SORT-ALLOWLIST-1 (updated_at, deadline_at) must ship their
 * own keyset indexes in a NEW migration -- 0017 was already applied to the live
 * test database and the runner has no checksum, so editing it there would be
 * skipped in silence (Delta 24 pin of this lane). This is a CONTENT pin and runs
 * offline; whether Postgres actually picks the indexes is the live EXPLAIN leg
 * (migrations.test.ts, DB window). The deadline_at pair carries an OPEN
 * expression caveat written into the migration itself (server.ts orders
 * COALESCE(deadline_at, <sentinel>), which a plain-column index cannot match),
 * so the last test locks that caveat text in place: the file cannot be tidied
 * into looking settled while the live evidence is still owed.
 */
describe('W-ADMUX02-IDX-SORT-0018: sort keyset indexes ship in their own migration', () => {
  const SORT_MIGRATION = '0018_operations_sort_keyset_indexes.sql';

  function sortSqlCollapsed(): string {
    const found = loadMigrationFiles(MIGRATIONS_DIR).find((f) => f.filename === SORT_MIGRATION);
    if (!found) throw new Error(SORT_MIGRATION + ' is missing from the migrations directory');
    return found.sql.replace(/\s+/g, ' ');
  }

  it('the file exists and loads with sequence 18, beside an untouched 0017', () => {
    const files = loadMigrationFiles(MIGRATIONS_DIR); // duplicate sequences would throw here
    const m18 = files.find((f) => f.filename === SORT_MIGRATION);
    expect(m18?.sequence).toBe(18);
    const m17 = files.find((f) => f.filename === '0017_operations_keyset_index.sql');
    expect(m17?.sequence).toBe(17);
    expect(m17!.sql).toContain('operations_tenant_created_id_idx');
    expect(m17!.sql).toContain('operations_created_id_idx');
  });

  it.each([
    ['operations_tenant_updated_id_idx', '(tenant_id, updated_at DESC, id DESC)'],
    ['operations_updated_id_idx', '(updated_at DESC, id DESC)'],
    ['operations_tenant_deadline_id_idx', '(tenant_id, deadline_at DESC, id DESC)'],
    ['operations_deadline_id_idx', '(deadline_at DESC, id DESC)'],
  ])('declares %s ON operations %s idempotently, exactly', (name, cols) => {
    // ONE exact string binds the name to its column list -- two separate matches
    // could both pass while two indexes had their definitions swapped.
    const sql = sortSqlCollapsed();
    expect(sql).toContain('CREATE INDEX IF NOT EXISTS ' + name + ' ON operations ' + cols + ';');
  });

  it('carries exactly the four new indexes and nothing else', () => {
    const sql = sortSqlCollapsed();
    expect((sql.match(/CREATE INDEX/g) || []).length).toBe(4);
  });

  it('removes and renumbers nothing: additive-only, like 0017', () => {
    const sql = sortSqlCollapsed();
    expect(sql).not.toMatch(/DROP INDEX/);
    expect(sql).not.toMatch(/ALTER TABLE/);
    expect(sql).not.toMatch(/TRUNCATE|DELETE FROM|UPDATE operations/);
  });

  it('keeps the deadline_at expression caveat in the file (open live question, not tidied away)', () => {
    const sql = sortSqlCollapsed();
    expect(sql).toMatch(/COALESCE\(deadline_at/);
    expect(sql).toMatch(/live EXPLAIN/);
  });
});

describe('cycle-84 verifyMigrations matches recorded filenames, not just sequences', () => {
  it('stale ledger (sequence 11 recorded under the pre-rename filename) FAILS with the repair hint', async () => {
    const real = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort();
    const rows = real
      .map((filename) => ({ sequence: parseInt(filename.slice(0, 4), 10), filename }))
      .filter((r) => r.filename !== '0011_artifact_finalize_epoch.sql');
    rows.push({ sequence: 11, filename: '0011_admin_idempotency.sql' }); // exactly what Tester Round 7's DB would contain
    await expect(verifyMigrations(fakeLedgerDb(rows))).rejects.toThrow(/does not match files on disk/);
    await expect(verifyMigrations(fakeLedgerDb(rows))).rejects.toThrow(/0011_artifact_finalize_epoch\.sql/);
    await expect(verifyMigrations(fakeLedgerDb(rows))).rejects.toThrow(/DELETE FROM schema_migrations WHERE sequence IN \(11\)/);
  });

  it('a consistent ledger covering every file on disk passes', async () => {
    const rows = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort()
      .map((filename) => ({ sequence: parseInt(filename.slice(0, 4), 10), filename }));
    await expect(verifyMigrations(fakeLedgerDb(rows))).resolves.toBeUndefined();
  });

  it('a genuinely missing migration still reports missing (not mislabeled)', async () => {
    const rows = readdirSync(MIGRATIONS_DIR)
      .filter((f) => /^\d{4}_.*\.sql$/.test(f))
      .sort()
      .map((filename) => ({ sequence: parseInt(filename.slice(0, 4), 10), filename }))
      .filter((r) => r.filename !== '0013_artifact_storage_version.sql');
    await expect(verifyMigrations(fakeLedgerDb(rows))).rejects.toThrow(/missing migrations \[0013_artifact_storage_version\.sql\]/);
  });
});
