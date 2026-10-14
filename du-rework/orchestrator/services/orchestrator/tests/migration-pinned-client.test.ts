import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Db } from '../src/db/db';
import { baselineMigrationsReviewed, migrate } from '../src/db/migrations';

interface LedgerRow {
  sequence: number;
  filename: string | null;
  checksum: string | null;
  checksum_provenance: string | null;
  baseline_reviewed_at: Date | null;
}

interface FakeDbOptions {
  failMetadata?: boolean;
  failMigration?: boolean;
  failBaseline?: boolean;
  failRollback?: boolean;
  failUnlock?: boolean;
  legacyMetadata?: boolean;
  existingRows?: LedgerRow[];
}

function createFakeDb(options: FakeDbOptions = {}) {
  const rows = [...(options.existingRows ?? [])];
  let trackingTableExists = options.existingRows !== undefined;
  let legacyMetadata = options.legacyMetadata ?? false;
  let poolQueryCount = 0;
  let clientQueryCount = 0;
  const queryLog: string[] = [];
  const releaseArguments: Array<Error | boolean | undefined> = [];

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      clientQueryCount += 1;
      const sql = text.replace(/\s+/g, ' ').trim();
      queryLog.push(sql);
      if (sql.startsWith('SELECT pg_advisory_lock(')) return { rows: [], rowCount: 1 };
      if (sql.startsWith('SELECT pg_advisory_unlock(')) {
        if (options.failUnlock) throw new Error('simulated advisory unlock cleanup failure');
        return { rows: [], rowCount: 1 };
      }
      if (sql === 'BEGIN' || sql === 'COMMIT') return { rows: [], rowCount: null };
      if (sql === 'ROLLBACK') {
        if (options.failRollback) throw new Error('simulated rollback cleanup failure');
        return { rows: [], rowCount: null };
      }
      if (sql.startsWith('SELECT EXISTS (') && sql.includes('information_schema.tables')) {
        return { rows: [{ exists: String(params[0]) === 'schema_migrations' && trackingTableExists }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT column_name FROM information_schema.columns')) {
        const columns = legacyMetadata ? [] : ['checksum', 'checksum_provenance', 'baseline_reviewed_at'];
        return { rows: columns.map((column_name) => ({ column_name })), rowCount: columns.length };
      }
      if (sql.startsWith('SELECT count(*)::int AS count FROM schema_migrations')) {
        return { rows: [{ count: rows.length }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT sequence, filename, checksum, checksum_provenance')) {
        return { rows: rows.map((row) => ({ ...row })), rowCount: rows.length };
      }
      if (sql.startsWith('CREATE TABLE IF NOT EXISTS schema_migrations')) {
        trackingTableExists = true;
        return { rows: [], rowCount: null };
      }
      if (sql.startsWith('ALTER TABLE schema_migrations')) {
        if (options.failMetadata) throw new Error('simulated metadata bootstrap failure');
        legacyMetadata = false;
        return { rows: [], rowCount: null };
      }
      if (sql.startsWith('INSERT INTO schema_migrations')) {
        rows.push({
          sequence: Number(params[0]),
          filename: String(params[1]),
          checksum: String(params[2]),
          checksum_provenance: 'migration',
          baseline_reviewed_at: null,
        });
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('UPDATE schema_migrations')) {
        if (options.failBaseline) throw new Error('simulated baseline update failure');
        const row = rows.find((candidate) => candidate.sequence === Number(params[1]));
        if (!row || row.checksum !== null || row.checksum_provenance !== null) return { rows: [], rowCount: 0 };
        row.checksum = String(params[0]);
        row.checksum_provenance = 'reviewed-baseline';
        row.baseline_reviewed_at = new Date();
        return { rows: [], rowCount: 1 };
      }
      if (sql.startsWith('SELECT fail_migration;')) {
        if (options.failMigration) throw new Error('simulated migration failure');
        return { rows: [], rowCount: 1 };
      }
      if (sql === 'SELECT 1;' || sql === 'SELECT 2;') return { rows: [], rowCount: 1 };
      throw new Error(`unexpected migration query: ${sql.slice(0, 100)}`);
    },
    release: (error?: Error | boolean) => {
      releaseArguments.push(error);
    },
  };
  const db = {
    pool: {
      connect: async () => client,
      query: async () => {
        poolQueryCount += 1;
        throw new Error('pool query attempted while the migration client is pinned');
      },
    },
    query: async () => {
      poolQueryCount += 1;
      throw new Error('database query attempted outside the pinned client');
    },
    tx: async () => {
      poolQueryCount += 1;
      throw new Error('database transaction attempted outside the pinned client');
    },
    close: async () => undefined,
  } as unknown as Db;

  return { db, rows, queryLog, releaseArguments, clientQueryCount: () => clientQueryCount, poolQueryCount: () => poolQueryCount };
}

async function withMigrationFiles<T>(files: Record<string, string>, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'migration-pinned-client-'));
  for (const [filename, sql] of Object.entries(files)) writeFileSync(join(directory, filename), sql, 'utf8');
  try {
    return await run(directory);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function expectDestroyed(releaseArguments: Array<Error | boolean | undefined>, message: string): void {
  expect(releaseArguments).toHaveLength(1);
  expect(releaseArguments[0]).toBeInstanceOf(Error);
  expect((releaseArguments[0] as Error).message).toContain(message);
}

test('migration planning and apply use one pinned client when pool capacity is one', async () => {
  await withMigrationFiles({
    '0001_first.sql': 'SELECT 1;',
    '0002_second.sql': 'SELECT 2;',
  }, async (directory) => {
    const fake = createFakeDb();
    const result = await migrate(fake.db, directory);
    expect(result.applied).toEqual(['0001_first.sql', '0002_second.sql']);
    expect(fake.rows).toHaveLength(2);
    expect(fake.clientQueryCount()).toBeGreaterThan(10);
    expect(fake.poolQueryCount()).toBe(0);
    expect(fake.releaseArguments).toEqual([undefined]);
  });
});

test('metadata bootstrap rollback failure destroys its client and preserves the bootstrap error', async () => {
  await withMigrationFiles({ '0001_first.sql': 'SELECT 1;' }, async (directory) => {
    const fake = createFakeDb({ failMetadata: true, failRollback: true });
    await expect(migrate(fake.db, directory)).rejects.toThrow('simulated metadata bootstrap failure');
    expectDestroyed(fake.releaseArguments, 'simulated rollback cleanup failure');
    expect(fake.queryLog.some((sql) => sql.includes('pg_advisory_unlock('))).toBe(false);
  });
});

test('per-file rollback failure destroys its client and preserves the migration error', async () => {
  await withMigrationFiles({ '0001_fail.sql': 'SELECT fail_migration;' }, async (directory) => {
    const fake = createFakeDb({ failMigration: true, failRollback: true });
    await expect(migrate(fake.db, directory)).rejects.toThrow('simulated migration failure');
    expectDestroyed(fake.releaseArguments, 'simulated rollback cleanup failure');
    expect(fake.queryLog.some((sql) => sql.includes('pg_advisory_unlock('))).toBe(false);
  });
});

test('reviewed-baseline rollback failure destroys its client and preserves the baseline error', async () => {
  await withMigrationFiles({ '0001_first.sql': 'SELECT 1;' }, async (directory) => {
    const fake = createFakeDb({
      existingRows: [{
        sequence: 1,
        filename: '0001_first.sql',
        checksum: null,
        checksum_provenance: null,
        baseline_reviewed_at: null,
      }],
      legacyMetadata: true,
      failBaseline: true,
      failRollback: true,
    });
    await expect(baselineMigrationsReviewed(fake.db, directory)).rejects.toThrow('simulated baseline update failure');
    expectDestroyed(fake.releaseArguments, 'simulated rollback cleanup failure');
    expect(fake.queryLog.some((sql) => sql.includes('pg_advisory_unlock('))).toBe(false);
  });
});

test('standalone migration unlock failure destroys its client and rejects successful work', async () => {
  await withMigrationFiles({}, async (directory) => {
    const fake = createFakeDb({ failUnlock: true });
    await expect(migrate(fake.db, directory)).rejects.toThrow('simulated advisory unlock cleanup failure');
    expectDestroyed(fake.releaseArguments, 'simulated advisory unlock cleanup failure');
  });
});
