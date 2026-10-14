import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Pool, PoolClient } from 'pg';
import {
  baselineConnectorMigrationsReviewed,
  connectorMigrationChecksum,
  connectorMigrationStatus,
  loadConnectorMigrations,
  migrateConnector,
  verifyConnectorMigrations,
} from '../src/db/migration-runner';

interface LedgerRow {
  version: string;
  filename: string | null;
  checksum: string | null;
  checksum_provenance: string | null;
  baseline_reviewed_at: Date | null;
}

interface FakeDatabase {
  tableExists: boolean;
  legacyMetadata: boolean;
  rows: LedgerRow[];
  appliedSql: string[];
  schemaObjects: Set<string>;
  failOnSql?: string;
  failOnMetadata?: boolean;
  failOnUpdate?: boolean;
  failRollback?: boolean;
  failUnlock?: boolean;
  queryLog: string[];
  releaseArguments: Array<Error | boolean | undefined>;
  lockHeld: boolean;
  lockWaiters: Array<() => void>;
  transactionSnapshot?: { tableExists: boolean; legacyMetadata: boolean; rows: LedgerRow[]; appliedSql: string[] };
}

function freshDatabase(): FakeDatabase {
  return {
    tableExists: false,
    legacyMetadata: false,
    rows: [],
    appliedSql: [],
    schemaObjects: new Set(),
    queryLog: [],
    releaseArguments: [],
    lockHeld: false,
    lockWaiters: [],
  };
}

function createFakePool(state: FakeDatabase): Pool {
  const acquireLock = async (): Promise<void> => {
    if (!state.lockHeld) {
      state.lockHeld = true;
      return;
    }
    await new Promise<void>((resolve) => state.lockWaiters.push(resolve));
  };
  const releaseLock = (): void => {
    const next = state.lockWaiters.shift();
    if (next) next();
    else state.lockHeld = false;
  };

  const connect = async (): Promise<PoolClient> => {
    const client = {
      query: async (text: string, params: unknown[] = []) => {
        const sql = text.replace(/\s+/g, ' ').trim();
        state.queryLog.push(sql);
        if (sql.includes('pg_advisory_lock(')) {
          await acquireLock();
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('pg_advisory_unlock(')) {
          if (state.failUnlock) throw new Error('simulated advisory unlock cleanup failure');
          releaseLock();
          return { rows: [], rowCount: 1 };
        }
        if (sql === 'BEGIN') {
          state.transactionSnapshot = {
            tableExists: state.tableExists,
            legacyMetadata: state.legacyMetadata,
            rows: state.rows.map((row) => ({ ...row })),
            appliedSql: [...state.appliedSql],
          };
          return { rows: [], rowCount: null };
        }
        if (sql === 'COMMIT') {
          state.transactionSnapshot = undefined;
          return { rows: [], rowCount: null };
        }
        if (sql === 'ROLLBACK') {
          if (state.failRollback) throw new Error('simulated rollback cleanup failure');
          if (state.transactionSnapshot) {
            state.tableExists = state.transactionSnapshot.tableExists;
            state.legacyMetadata = state.transactionSnapshot.legacyMetadata;
            state.rows = state.transactionSnapshot.rows;
            state.appliedSql = state.transactionSnapshot.appliedSql;
            state.transactionSnapshot = undefined;
          }
          return { rows: [], rowCount: null };
        }
        if (sql.startsWith('SELECT EXISTS (') && sql.includes('information_schema.tables')) {
          const objectName = String(params[0]);
          const exists = objectName === 'connector_schema_migrations'
            ? state.tableExists
            : state.schemaObjects.has(objectName);
          return { rows: [{ exists }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT column_name FROM information_schema.columns')) {
          const columns = state.legacyMetadata
            ? []
            : ['filename', 'checksum', 'checksum_provenance', 'baseline_reviewed_at'];
          return { rows: columns.map((column_name) => ({ column_name })), rowCount: columns.length };
        }
        if (sql.startsWith('SELECT count(*)::int AS count FROM connector_schema_migrations')) {
          return { rows: [{ count: state.rows.length }], rowCount: 1 };
        }
        if (sql.startsWith('SELECT version, NULL::text AS filename')) {
          const rows = state.rows.map((row) => ({ ...row, filename: null, checksum: null, checksum_provenance: null, baseline_reviewed_at: null }));
          return { rows, rowCount: rows.length };
        }
        if (sql.startsWith('SELECT version, filename, checksum, checksum_provenance')) {
          const rows = state.rows.map((row) => ({ ...row }));
          return { rows, rowCount: rows.length };
        }
        if (sql.startsWith('CREATE TABLE IF NOT EXISTS connector_schema_migrations')) {
          state.tableExists = true;
          return { rows: [], rowCount: null };
        }
        if (sql.startsWith('ALTER TABLE connector_schema_migrations')) {
          if (state.failOnMetadata) throw new Error('simulated metadata bootstrap failure');
          state.legacyMetadata = false;
          return { rows: [], rowCount: null };
        }
        if (sql.startsWith('INSERT INTO connector_schema_migrations')) {
          state.rows.push({
            version: String(params[0]),
            filename: String(params[1]),
            checksum: String(params[2]),
            checksum_provenance: 'migration',
            baseline_reviewed_at: null,
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith('UPDATE connector_schema_migrations')) {
          if (state.failOnUpdate) throw new Error('simulated baseline update failure');
          const row = state.rows.find((candidate) => candidate.version === params[2]);
          if (!row || row.checksum !== null || row.checksum_provenance !== null) {
            return { rows: [], rowCount: 0 };
          }
          row.filename = String(params[0]);
          row.checksum = String(params[1]);
          row.checksum_provenance = 'reviewed-baseline';
          row.baseline_reviewed_at = new Date();
          return { rows: [], rowCount: 1 };
        }
        if (state.failOnSql === text) throw new Error('simulated migration failure');
        if (sql.startsWith('CREATE TABLE') || sql.startsWith('CREATE INDEX') || sql.startsWith('SELECT ')) {
          state.appliedSql.push(text);
          const declaredObject = /CREATE\s+(?:UNIQUE\s+)?(?:TABLE|INDEX)\s+(?:CONCURRENTLY\s+)?(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_$]*)/i.exec(text);
          if (declaredObject) state.schemaObjects.add(declaredObject[1]!.toLowerCase());
          return { rows: [], rowCount: null };
        }
        throw new Error(`unexpected fake PostgreSQL query: ${sql.slice(0, 80)}`);
      },
      release: (error?: Error | boolean) => {
        state.releaseArguments.push(error);
        if (error) releaseLock();
      },
    };
    return client as unknown as PoolClient;
  };
  return { connect } as unknown as Pool;
}

function withMigrations<T>(files: Record<string, string>, run: (directory: string) => Promise<T>): Promise<T> {
  const directory = mkdtempSync(join(tmpdir(), 'connector-migrations-'));
  for (const [filename, sql] of Object.entries(files)) writeFileSync(join(directory, filename), sql);
  return run(directory).finally(() => rmSync(directory, { recursive: true, force: true }));
}

test('migration checksum normalizes CRLF but detects SQL content changes', () => {
  expect(connectorMigrationChecksum('CREATE TABLE x;\r\n')).toBe(connectorMigrationChecksum('CREATE TABLE x;\n'));
  expect(connectorMigrationChecksum('CREATE TABLE x;')).not.toBe(connectorMigrationChecksum('CREATE TABLE y;'));
});

test('migration discovery follows files on disk and rejects duplicate prefixes', async () => {
  await withMigrations({
    '002_second.sql': 'SELECT 2;',
    '001_first.sql': 'SELECT 1;',
  }, async (directory) => {
    expect(loadConnectorMigrations(directory).map((file) => file.version)).toEqual(['001_first', '002_second']);
  });
  await withMigrations({
    '001_first.sql': 'SELECT 1;',
    '001_renamed.sql': 'SELECT 2;',
  }, async (directory) => {
    expect(() => loadConnectorMigrations(directory)).toThrow(/duplicate Connector migration sequence 1/);
  });
});

test('status reports legacy checksum state without writes, and verify refuses it', async () => {
  await withMigrations({ '001_first.sql': 'SELECT 1;' }, async (directory) => {
    const state = freshDatabase();
    state.tableExists = true;
    state.legacyMetadata = true;
    state.rows.push({
      version: '001_first', filename: null, checksum: null,
      checksum_provenance: null, baseline_reviewed_at: null,
    });
    const pool = createFakePool(state);
    const status = await connectorMigrationStatus(pool, directory);
    expect(status.unknownChecksums).toEqual(['001_first.sql']);
    await expect(verifyConnectorMigrations(pool, directory)).rejects.toThrow(/migrate:baseline-reviewed/);
    expect(state.legacyMetadata).toBe(true);
    expect(state.appliedSql).toEqual([]);
  });
});

test('reviewed baseline records provenance without executing migration SQL', async () => {
  await withMigrations({ '001_first.sql': 'SELECT 1;' }, async (directory) => {
    const state = freshDatabase();
    state.tableExists = true;
    state.legacyMetadata = true;
    state.rows.push({
      version: '001_first', filename: null, checksum: null,
      checksum_provenance: null, baseline_reviewed_at: null,
    });
    const pool = createFakePool(state);
    await expect(baselineConnectorMigrationsReviewed(pool, directory)).resolves.toEqual({ baselined: ['001_first.sql'] });
    expect(state.rows[0]?.checksum).toBe(connectorMigrationChecksum('SELECT 1;'));
    expect(state.rows[0]?.checksum_provenance).toBe('reviewed-baseline');
    expect(state.rows[0]?.baseline_reviewed_at).toBeInstanceOf(Date);
    expect(state.appliedSql).toEqual([]);
  });
});

test('recorded table and index drift blocks status, verification, baseline, and pending apply', async () => {
  await withMigrations({
    '001_recorded.sql': 'CREATE TABLE connector_probe (id integer);\nCREATE INDEX connector_probe_idx ON connector_probe (id);',
    '002_pending.sql': 'CREATE TABLE connector_pending (id integer);',
  }, async (directory) => {
    const files = loadConnectorMigrations(directory);
    const state = freshDatabase();
    state.tableExists = true;
    state.rows.push({
      version: files[0]!.version,
      filename: files[0]!.filename,
      checksum: files[0]!.checksum,
      checksum_provenance: 'migration',
      baseline_reviewed_at: null,
    });
    const pool = createFakePool(state);

    const status = await connectorMigrationStatus(pool, directory);
    expect(status.integrityProblems.join(' ')).toMatch(/missing table\/index object/);
    await withMigrations({
      '001_recorded.sql': 'CREATE TABLE connector_probe (id integer);\nCREATE INDEX connector_probe_idx ON connector_probe (id);',
    }, async (recordedDirectory) => {
      await expect(verifyConnectorMigrations(pool, recordedDirectory)).rejects.toThrow(/missing table\/index objects/);
    });
    await expect(migrateConnector(pool, directory)).rejects.toThrow(/incomplete schema/);
    expect(state.appliedSql).toEqual([]);
    expect(state.rows.map((row) => row.version)).toEqual([files[0]!.version]);
  });
});

test('reviewed baseline refuses to record unknown hashes over missing declared objects', async () => {
  await withMigrations({ '001_recorded.sql': 'CREATE TABLE connector_probe (id integer);' }, async (directory) => {
    const state = freshDatabase();
    state.tableExists = true;
    state.legacyMetadata = true;
    state.rows.push({
      version: '001_recorded', filename: null, checksum: null,
      checksum_provenance: null, baseline_reviewed_at: null,
    });

    await expect(baselineConnectorMigrationsReviewed(createFakePool(state), directory))
      .rejects.toThrow(/incomplete Connector schema/);
    expect(state.rows[0]?.checksum).toBeNull();
    expect(state.appliedSql).toEqual([]);
  });
});

test('apply is serialized, discovers pending files, and commits one transaction per file', async () => {
  await withMigrations({
    '001_first.sql': 'CREATE TABLE first_item (id integer);',
    '002_second.sql': 'CREATE TABLE second_item (id integer);',
  }, async (directory) => {
    const state = freshDatabase();
    const pool = createFakePool(state);
    const results = await Promise.all([
      migrateConnector(pool, directory),
      migrateConnector(pool, directory),
    ]);
    expect(results.reduce((count, result) => count + result.applied.length, 0)).toBe(2);
    expect(state.rows.map((row) => row.version)).toEqual(['001_first', '002_second']);
    expect(state.appliedSql).toEqual([
      'CREATE TABLE first_item (id integer);',
      'CREATE TABLE second_item (id integer);',
    ]);
  });
});

test('a failed migration rolls back its ledger row and stops later files', async () => {
  await withMigrations({
    '001_first.sql': 'CREATE TABLE first_item (id integer);',
    '002_fail.sql': 'SELECT fail_migration;',
    '003_after.sql': 'CREATE TABLE after_failure (id integer);',
  }, async (directory) => {
    const state = freshDatabase();
    state.failOnSql = 'SELECT fail_migration;';
    await expect(migrateConnector(createFakePool(state), directory)).rejects.toThrow('simulated migration failure');
    expect(state.rows.map((row) => row.version)).toEqual(['001_first']);
    expect(state.appliedSql).toEqual(['CREATE TABLE first_item (id integer);']);
    expect(state.releaseArguments).toEqual([undefined]);
  });
});

test('metadata bootstrap rollback failure destroys its client and preserves the bootstrap error', async () => {
  await withMigrations({ '001_first.sql': 'SELECT 1;' }, async (directory) => {
    const state = freshDatabase();
    state.failOnMetadata = true;
    state.failRollback = true;

    await expect(migrateConnector(createFakePool(state), directory)).rejects.toThrow('simulated metadata bootstrap failure');
    expect(state.releaseArguments).toHaveLength(1);
    expect(state.releaseArguments[0]).toBeInstanceOf(Error);
    expect((state.releaseArguments[0] as Error).message).toContain('simulated rollback cleanup failure');
    expect(state.queryLog.some((sql) => sql.includes('pg_advisory_unlock('))).toBe(false);
  });
});

test('per-file rollback failure destroys its client and preserves the migration error', async () => {
  await withMigrations({ '001_fail.sql': 'SELECT fail_migration;' }, async (directory) => {
    const state = freshDatabase();
    state.failOnSql = 'SELECT fail_migration;';
    state.failRollback = true;

    await expect(migrateConnector(createFakePool(state), directory)).rejects.toThrow('simulated migration failure');
    expect(state.releaseArguments).toHaveLength(1);
    expect(state.releaseArguments[0]).toBeInstanceOf(Error);
    expect((state.releaseArguments[0] as Error).message).toContain('simulated rollback cleanup failure');
    expect(state.queryLog.some((sql) => sql.includes('pg_advisory_unlock('))).toBe(false);
  });
});

test('reviewed-baseline rollback failure destroys its client and preserves the baseline error', async () => {
  await withMigrations({ '001_first.sql': 'SELECT 1;' }, async (directory) => {
    const state = freshDatabase();
    state.tableExists = true;
    state.legacyMetadata = true;
    state.rows.push({
      version: '001_first', filename: null, checksum: null,
      checksum_provenance: null, baseline_reviewed_at: null,
    });
    state.failOnUpdate = true;
    state.failRollback = true;

    await expect(baselineConnectorMigrationsReviewed(createFakePool(state), directory))
      .rejects.toThrow('simulated baseline update failure');
    expect(state.releaseArguments).toHaveLength(1);
    expect(state.releaseArguments[0]).toBeInstanceOf(Error);
    expect((state.releaseArguments[0] as Error).message).toContain('simulated rollback cleanup failure');
    expect(state.queryLog.some((sql) => sql.includes('pg_advisory_unlock('))).toBe(false);
  });
});

test('standalone migration unlock failure destroys the client and rejects successful work', async () => {
  await withMigrations({}, async (directory) => {
    const state = freshDatabase();
    state.failUnlock = true;

    await expect(migrateConnector(createFakePool(state), directory))
      .rejects.toThrow('simulated advisory unlock cleanup failure');
    expect(state.releaseArguments).toHaveLength(1);
    expect(state.releaseArguments[0]).toBeInstanceOf(Error);
    expect((state.releaseArguments[0] as Error).message).toContain('simulated advisory unlock cleanup failure');
  });
});

test('orphaned and renamed ledger entries are reported as integrity problems', async () => {
  await withMigrations({ '001_current.sql': 'SELECT 1;' }, async (directory) => {
    const state = freshDatabase();
    state.tableExists = true;
    state.legacyMetadata = false;
    state.rows.push({
      version: '001_old', filename: '001_old.sql', checksum: '0'.repeat(64),
      checksum_provenance: 'migration', baseline_reviewed_at: null,
    });
    const status = await connectorMigrationStatus(createFakePool(state), directory);
    expect(status.integrityProblems.join(' ')).toMatch(/has no migration file on disk/);
    expect(status.pending).toEqual(['001_current.sql']);
  });
});
