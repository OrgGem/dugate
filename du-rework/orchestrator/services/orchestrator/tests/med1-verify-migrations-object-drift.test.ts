import { join } from 'node:path';
import type { Db } from '../src/db/db';
import { loadMigrationFiles, verifyMigrations } from '../src/db/migrations';

const MIGRATIONS_DIR = join(__dirname, '..', 'migrations');

function fakeDbWithDroppedObject(missingObject: string) {
  const rows = loadMigrationFiles(MIGRATIONS_DIR).map(({ sequence, filename }) => ({ sequence, filename }));
  const objectProbes: string[] = [];
  const db = {
    pool: undefined,
    query: async (text: string, params: unknown[] = []) => {
      const sql = String(text).replace(/\s+/g, ' ').trim();
      if (sql.includes('pg_indexes')) {
        const name = String(params[0] ?? '');
        objectProbes.push(name);
        return { rows: [{ exists: name !== missingObject }], rowCount: 1 };
      }
      if (sql.includes('information_schema.tables')) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT count(*)::int AS count FROM schema_migrations')) {
        return { rows: [{ count: rows.length }], rowCount: 1 };
      }
      if (sql.startsWith('SELECT sequence, filename FROM schema_migrations')) {
        return { rows, rowCount: rows.length };
      }
      throw new Error('unexpected SQL in fake verify db: ' + sql.slice(0, 80));
    },
    tx: async () => {
      throw new Error('verifyMigrations must not write');
    },
    close: async () => undefined,
  } as unknown as Db;

  return { db, objectProbes };
}

describe('MED-1: verifyMigrations checks recorded migration objects', () => {
  it('rejects a fully-applied ledger when a table from migration 0001 is missing', async () => {
    // Every migration row is present, but the catalog models tenants having
    // been dropped after the migrations were applied.
    const { db, objectProbes } = fakeDbWithDroppedObject('tenants');

    await expect(verifyMigrations(db)).rejects.toThrow(/0001_platform_v1\.sql.*missing tenants/);
    expect(objectProbes).toContain('tenants');
  });
});
