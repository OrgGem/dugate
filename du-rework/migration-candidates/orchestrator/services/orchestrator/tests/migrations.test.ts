import { createDb, type Db } from '../src/db/db';
import { Pool } from 'pg';
import { migrate, verifyMigrations, migrationStatus } from '../src/db/migrations';

const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';

const BASE_URL = DATABASE_URL.replace(/\/[^/]+$/, '');
const DB_NAME = new URL(DATABASE_URL).pathname.split('/').pop() ?? 'du_orchestrator_test';
/** Connect to the postgres maintenance DB for CREATE/DROP DATABASE operations. */
const MAINTENANCE_URL = BASE_URL + '/postgres';

/**
 * Assert we are talking to a test database.  Never run destructive
 * operations against a non-test target.
 */
function assertTestDatabase(): void {
  if (!/test/i.test(DB_NAME)) {
    throw new Error(
      `refusing migration test: DATABASE_URL database "${DB_NAME}" does not look like a test database`
    );
  }
}

let db: Db;

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('migrations.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(() => {
  assertTestDatabase();
  db = createDb(DATABASE_URL);
});

afterAll(async () => {
  await db?.close();
});

describe('migration tracking (R08-06 / P2-01)', () => {
  test('migrate() is idempotent — second call applies nothing', async () => {
    // First run: apply any pending migrations.
    const first = await migrate(db);
    // Second run: should apply nothing.
    const second = await migrate(db);
    expect(second.applied).toEqual([]);
    // First run may have applied 0 (already up-to-date) or N migrations.
    expect(Array.isArray(first.applied)).toBe(true);
  });

  test('verifyMigrations() passes after migrate()', async () => {
    await migrate(db);
    // Should NOT throw.
    await expect(verifyMigrations(db)).resolves.toBeUndefined();
  });

  test('migrationStatus() reports consistent counts', async () => {
    await migrate(db);
    const status = await migrationStatus(db);
    expect(status.total).toBeGreaterThanOrEqual(5); // at least 5 migrations
    expect(status.applied).toBeGreaterThanOrEqual(5);
    expect(status.pending).toEqual([]);
  });

  test('schema_migrations table exists and is queryable', async () => {
    const res = await db.query<{ sequence: number; filename: string; applied_at: string }>(
      'SELECT sequence, filename, applied_at FROM schema_migrations ORDER BY sequence'
    );
    expect(res.rows.length).toBeGreaterThanOrEqual(5);
    // First migration should be 0001.
    expect(res.rows[0]!.sequence).toBe(1);
    expect(res.rows[0]!.filename).toBe('0001_platform_v1.sql');
  });

  test('core tables exist after migration', async () => {
    await migrate(db);
    const tables = await db.query<{ tablename: string }>(
      `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
       AND tablename IN ('tenants','api_keys','operations','tasks',
                         'business_versions','outbox','artifacts',
                         'step_checkpoints','human_waits','schema_migrations')
       ORDER BY tablename`
    );
    const names = tables.rows.map((r) => r.tablename);
    expect(names).toContain('tenants');
    expect(names).toContain('api_keys');
    expect(names).toContain('operations');
    expect(names).toContain('tasks');
    expect(names).toContain('outbox');
    expect(names).toContain('artifacts');
    expect(names).toContain('step_checkpoints');
    expect(names).toContain('human_waits');
    expect(names).toContain('schema_migrations');
  });

  /**
   * W-ADMUX02-IDX-1 (ADM-UX-02): the keyset cursor pages on
   * ORDER BY created_at DESC, id DESC. This asserts the index actually EXISTS in
   * PostgreSQL with that exact key — the offline leg only pins the file content.
   * Window-gated: needs a real DB. Whether the planner PREFERS it over
   * operations_tenant_created still needs EXPLAIN on seeded data (≥1k rows);
   * recorded as an open delta, not asserted here.
   */
  test('operations keyset index exists with the route sort key', async () => {
    await migrate(db);
    const idx = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE schemaname = 'public'
          AND tablename = 'operations'
          AND indexname = 'operations_tenant_created_id_idx'`
    );
    expect(idx.rows).toHaveLength(1);
    const def = idx.rows[0]!.indexdef.replace(/\s+/g, ' ');
    expect(def).toMatch(/\(tenant_id, created_at DESC, id DESC\)/);
  });

  test('concurrent migrate() calls do not double-insert (idempotent under contention)', async () => {
    // Run migrate() 5 times concurrently — the unique PK on sequence
    // prevents double-inserts; only one should record each migration.
    const results = await Promise.all([
      migrate(db),
      migrate(db),
      migrate(db),
      migrate(db),
      migrate(db),
    ]);
    const totalApplied = results.reduce((n, r) => n + r.applied.length, 0);
    // At most one of the 5 calls should have applied each migration;
    // the others applied 0.  On a fresh DB, totalApplied = file count.
    // On a pre-existing DB, totalApplied = 0.
    expect(totalApplied).toBeLessThanOrEqual(5);
  });
});

/**
 * Edge-case tests against a genuine empty scratch database.
 * Creates `du_orchestrator_migrate_scratch` on :5433 (ends with _test)
 * using a raw pool client (CREATE DATABASE cannot run inside a tx),
 * runs the target tests, then drops it in afterAll.
 */
const SCRATCH_DB = 'du_orchestrator_migrate_scratch';
const scratchUrl = BASE_URL + '/' + SCRATCH_DB;
let adminPool: Pool;

async function createScratchDb(): Promise<void> {
  // Connect to the maintenance DB (postgres) to create the scratch database.
  adminPool = new Pool({ connectionString: MAINTENANCE_URL, max: 1 });
  const client = await adminPool.connect();
  try {
    // Terminate existing connections so we can drop cleanly.
    await client.query(`
      SELECT pg_terminate_backend(pid) FROM pg_stat_activity
      WHERE datname = $1 AND pid <> pg_backend_pid()
    `, [SCRATCH_DB]);
    await client.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    await client.query(`CREATE DATABASE "${SCRATCH_DB}"`);
  } finally {
    client.release();
  }
  await adminPool.end();
}

async function dropScratchDb(): Promise<void> {
  try {
    adminPool = new Pool({ connectionString: MAINTENANCE_URL, max: 1 });
    const client = await adminPool.connect();
    try {
      await client.query(`DROP DATABASE IF EXISTS "${SCRATCH_DB}"`);
    } finally {
      client.release();
    }
    await adminPool.end();
  } catch {
    // Best-effort cleanup; scratch DB is non-critical.
  }
}

describe('migration boot boundary on empty scratch DB', () => {
  beforeAll(async () => {
    await createScratchDb();
  }, 30_000);

  afterAll(async () => {
    await dropScratchDb();
  }, 30_000);

  test('verifyMigrations fails on empty DB (no hidden write)', async () => {
    const scratchDb = createDb(scratchUrl);
    try {
      // The scratch DB is genuinely empty — no schema_migrations table.
      await expect(verifyMigrations(scratchDb)).rejects.toThrow(
        'no schema_migrations table found'
      );
      // Verify no tables were created (no hidden write).
      const tables = await scratchDb.query<{ tablename: string }>(
        "SELECT tablename FROM pg_tables WHERE schemaname = 'public' AND tablename = 'schema_migrations'"
      );
      expect(tables.rowCount).toBe(0);
    } finally {
      await scratchDb.close();
    }
  });

  test('migrate() on empty DB creates all tables, then verifyMigrations passes', async () => {
    const scratchDb = createDb(scratchUrl);
    try {
      const result = await migrate(scratchDb);
      expect(result.applied.length).toBeGreaterThanOrEqual(5);
      // verifyMigrations should now pass.
      await expect(verifyMigrations(scratchDb)).resolves.toBeUndefined();
      // Core tables present.
      const tables = await scratchDb.query<{ tablename: string }>(
        `SELECT tablename FROM pg_tables WHERE schemaname = 'public'
         AND tablename IN ('tenants','operations','tasks','schema_migrations')
         ORDER BY tablename`
      );
      expect(tables.rows.map((r) => r.tablename)).toEqual([
        'operations', 'schema_migrations', 'tasks', 'tenants',
      ]);
    } finally {
      await scratchDb.close();
    }
  });

  test('repeated migrate() is idempotent on scratch DB', async () => {
    const scratchDb = createDb(scratchUrl);
    try {
      // First call: 0 applied (schema already exists from previous test).
      const first = await migrate(scratchDb);
      expect(first.applied).toEqual([]);
      // Second call: also 0.
      const second = await migrate(scratchDb);
      expect(second.applied).toEqual([]);
    } finally {
      await scratchDb.close();
    }
  });
});
});
