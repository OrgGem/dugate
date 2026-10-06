import { join } from 'node:path';
import {
  loadMigrationFiles,
  migrate,
  verifyMigrations,
} from '../src/db/migrations';
import { METADATA_SLOTS } from '../src/modules/runtime/metadata-crypto';

/**
 * MIGRATION-0032-ROLLBACK-PREP — offline checks for the live rollout of
 * `0032_checkpoint_session_ref.sql`.
 *
 * The migration is one statement:
 *
 *     ALTER TABLE step_checkpoints ADD COLUMN IF NOT EXISTS session_ref jsonb;
 *
 * These tests pin the properties the live window depends on, without
 * touching a database:
 *
 *   - it is idempotent, so `npm run migrate` twice is a no-op the second time;
 *   - it adds a NULLABLE column and rewrites no existing row;
 *   - the column is a SEALED metadata slot the runtime already reads and
 *     writes, so the migration must land before (or atomically with) that
 *     code — and a hand-rolled DROP COLUMN rollback is destructive;
 *   - the framework has NO down-migration mechanism, so rollback is
 *     hand-authored SQL and the ledger row must be removed by hand too.
 */

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

/**
 * A fake `Db` that models just enough of the migration runner's queries: the
 * tracking table, the ledger read/write, and the DDL itself. It records every
 * statement so a test can count how many times the DDL actually ran.
 */
class FakeMigrateDb {
  ledger = new Map<number, string>();
  statements: string[] = [];
  columns = new Set([
    'task_id', 'step_key', 'generation', 'input_hash', 'output_ref', 'status', 'created_at',
  ]);

  query(sql: string, params: unknown[] = []): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> {
    const t = String(sql).replace(/\s+/g, ' ').trim();
    const out = (rows: Record<string, unknown>[]) => Promise.resolve({ rows, rowCount: rows.length });

    if (/^CREATE TABLE IF NOT EXISTS schema_migrations/.test(t)) return out([]);
    if (/^SELECT count\(\*\)::int AS count FROM schema_migrations$/.test(t)) {
      return out([{ count: this.ledger.size }]);
    }
    if (/^SELECT sequence, filename FROM schema_migrations$/.test(t)) {
      return out([...this.ledger].map(([sequence, filename]) => ({ sequence, filename })));
    }
    if (/^SELECT EXISTS \(/.test(t)) return out([{ exists: true }]);
    if (/^INSERT INTO schema_migrations \(sequence, filename\) VALUES \(\$1, \$2\)$/.test(t)) {
      this.ledger.set(Number(params[0]), String(params[1]));
      return out([]);
    }
    // Anything else is migration DDL. Record it and model the one column this
    // packet cares about.
    this.statements.push(t);
    if (/ADD COLUMN IF NOT EXISTS session_ref jsonb/.test(t)) this.columns.add('session_ref');
    return out([]);
  }

  tx<T>(fn: (client: unknown) => Promise<T>): Promise<T> {
    return fn(this);
  }
}

function targetFile() {
  const files = loadMigrationFiles(MIGRATIONS_DIR);
  const target = files.find((f) => f.sequence === 32);
  if (!target) throw new Error('migration 0032 not found on disk');
  return { files, target };
}

describe('MIGRATION-0032: the statement itself', () => {
  test('adds a NULLABLE column and rewrites no existing row', () => {
    const { target } = targetFile();
    expect(target.filename).toBe('0032_checkpoint_session_ref.sql');
    expect(target.sql).toMatch(/ADD COLUMN IF NOT EXISTS session_ref jsonb/i);
    // Nullable: existing rows read back as NULL, which the reader treats as
    // "no session" rather than an error.
    expect(target.sql).not.toMatch(/NOT NULL/i);
    // No data-rewriting statement of any kind.
    expect(target.sql).not.toMatch(/\b(UPDATE|DELETE|TRUNCATE|DROP|ALTER COLUMN|USING|SET DEFAULT)\b/i);
  });

  test('the column is a SEALED metadata slot the runtime already depends on', () => {
    // runtime.ts INSERTs session_ref (checkpoint write) and SELECTs it
    // (checkpoint read). If this slot were not sealed, the migration would be
    // adding a plaintext control-plane column by accident.
    expect(METADATA_SLOTS).toContain('step_checkpoints.session_ref');
  });

  test('the framework has NO down-migration mechanism', async () => {
    const mod = (await import('../src/db/migrations')) as Record<string, unknown>;
    expect(mod.migrateDown).toBeUndefined();
    expect(mod.rollbackMigration).toBeUndefined();
    expect(mod.revertMigration).toBeUndefined();
  });
});

describe('MIGRATION-0032: idempotent re-run on a fresh instance', () => {
  test('two migrate() runs apply the DDL exactly once and leave one ledger row', async () => {
    const { files, target } = targetFile();
    const db = new FakeMigrateDb();
    // Pre-seed sequences 1..31 so only 0032 is pending.
    for (const f of files) if (f.sequence < 32) db.ledger.set(f.sequence, f.filename);

    const first = await migrate(db as never);
    expect(first.applied).toEqual([target.filename]);
    expect(db.columns.has('session_ref')).toBe(true);
    expect(db.ledger.get(32)).toBe(target.filename);

    const second = await migrate(db as never);
    expect(second.applied).toEqual([]);
    expect(db.ledger.size).toBe(32);
    // The DDL ran exactly once across both invocations.
    expect(db.statements.filter((s) => /ADD COLUMN IF NOT EXISTS session_ref/.test(s))).toHaveLength(1);

    // And verify passes with no throw.
    await expect(verifyMigrations(db as never)).resolves.toBeUndefined();
  });

  test('a fresh instance with an empty ledger applies 0032 among the pending set', async () => {
    const { target } = targetFile();
    const db = new FakeMigrateDb();
    const result = await migrate(db as never);
    expect(result.applied).toContain(target.filename);
    expect(db.columns.has('session_ref')).toBe(true);
  });
});

describe('MIGRATION-0032: rollback semantics (the part with no framework help)', () => {
  test('verifyMigrations compares files vs ledger, NOT ledger vs actual schema', async () => {
    // This is the trap: a hand-rolled DROP COLUMN that leaves the ledger row
    // in place still passes verifyMigrations, because verify never inspects
    // the real columns. Pinned so the live runbook cannot rely on verify to
    // catch a half-done rollback.
    const { target } = targetFile();
    const db = new FakeMigrateDb();
    await migrate(db as never);
    // Simulate the destructive rollback: the column is gone, the ledger is not.
    db.columns.delete('session_ref');
    await expect(verifyMigrations(db as never)).resolves.toBeUndefined();
    // ...and the only way to notice is to look at the schema, which nothing
    // in the runner does. Hence the pre-flight checklist in the receipt.
    expect(db.columns.has('session_ref')).toBe(false);
    expect(db.ledger.get(32)).toBe(target.filename);
  });
});