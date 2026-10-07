/**
 * RFX-10 focused proof: the dev fallback rows (default tenant `…0001` + the
 * `dev-fallback` API key) are written ONLY under an explicit dev/test signal.
 *
 * The acceptance query — `SELECT * FROM api_keys WHERE prefix='dev-fallback'`
 * — is modelled by the scripted pool below: it records every boot INSERT it
 * answers, and `devFallbackRowCount()` is the row count that SELECT would
 * return after the boot. Both directions are exercised against a REAL
 * `createApp()`:
 *   - production boot (NODE_ENV=production, no flag, autoMigrate=false)
 *     writes neither row → count stays 0;
 *   - dev/test boot with `DU_SEED_DEV_FALLBACK=true` writes both → count 1.
 *
 * Offline by construction: `pg` is a scripted Pool (pattern proven in
 * tests/webhook-error-boundaries.boundary.test.ts — a DB-free offline twin of
 * a live boot); Redis points at a closed loopback port and is never queried
 * for the seed decision. No PostgreSQL :5433, no Redis :6380.
 */
import { join } from 'node:path';
import { createApp, shouldSeedDevFallback, type App } from '../src/server';
import { loadMigrationFiles } from '../src/db/migrations';

interface SeedGateMockState {
  /** Every SQL string the scripted pool answered, in order. */
  queries: string[];
  /** How many `INSERT INTO tenants (…0001)` the pool answered. */
  defaultTenantWrites: number;
  /** How many `INSERT INTO api_keys (…dev-fallback…)` the pool answered. */
  devFallbackKeyWrites: number;
  /** Ledger rows `verifyMigrations` needs so an autoMigrate=false boot can pass. */
  schemaLedger: { sequence: number; filename: string }[];
}

jest.mock('pg', () => {
  const state = {
    queries: [] as string[],
    defaultTenantWrites: 0,
    devFallbackKeyWrites: 0,
    schemaLedger: [] as { sequence: number; filename: string }[],
  };
  class ScriptedPool {
    async query(sql: string): Promise<{ rows: unknown[]; rowCount: number }> {
      const text = String(sql);
      state.queries.push(text);
      if (text.includes('INSERT INTO tenants')) {
        state.defaultTenantWrites += 1;
        return { rows: [], rowCount: 1 };
      }
      if (text.includes('INSERT INTO api_keys')) {
        state.devFallbackKeyWrites += 1;
        return { rows: [], rowCount: 1 };
      }
      if (/information_schema\.tables/i.test(text)) {
        return { rows: [{ exists: true }], rowCount: 1 };
      }
    if (/SELECT count\(\*\)::int/i.test(text)) return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 }
      if (/FROM schema_migrations/i.test(text)) {
        return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
      }
      return { rows: [], rowCount: 0 };
    }
    async connect(): Promise<{
      query: (sql: string) => Promise<{ rows: unknown[]; rowCount: number }>;
      release: () => void;
    }> {
      const pool = this;
      return { query: (sql: string) => pool.query(sql), release: () => undefined };
    }
    async end(): Promise<void> {
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

function mockState(): SeedGateMockState {
  return (jest.requireMock('pg') as { __duState: SeedGateMockState }).__duState;
}

/** Row count the acceptance `SELECT * FROM api_keys WHERE prefix='dev-fallback'` would answer. */
function devFallbackRowCount(): number {
  return mockState().devFallbackKeyWrites;
}

function withEnv<T>(env: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    saved.set(key, process.env[key]);
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  return fn().finally(() => {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
}

async function boot(
  env: Record<string, string | undefined>,
  options: { autoMigrate?: boolean } = {},
): Promise<{ app: App; queries: string[] }> {
  const offset = mockState().queries.length;
  const app = await withEnv(env, () =>
    createApp({
      port: 0,
      databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_seed_gate',
      redisUrl: 'redis://127.0.0.1:1',
      adminToken: 'rfx10-admin-token',
      autoDispatch: false,
      // production-mode boot is verify-only (no migration write); the
      // zero-config dev/test boot applies migrations instead.
      autoMigrate: options.autoMigrate === true,
    }),
  );
  return { app, queries: mockState().queries.slice(offset) };
}

describe('RFX-10: dev fallback seed rows are gated off production boots', () => {
  const apps: App[] = [];

  beforeAll(() => {
    mockState().schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map(
      (file) => ({ sequence: file.sequence, filename: file.filename }),
    );
  });

  afterAll(async () => {
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
  });

  describe('shouldSeedDevFallback (gate matrix)', () => {
    it('only development/test, a zero-config boot, or an explicit true flag enable the seed', () => {
      expect(shouldSeedDevFallback({})).toBe(false);
      expect(shouldSeedDevFallback({ NODE_ENV: 'production' })).toBe(false);
      expect(shouldSeedDevFallback({ NODE_ENV: 'staging' })).toBe(false);
      expect(shouldSeedDevFallback({ NODE_ENV: 'development' })).toBe(true);
      expect(shouldSeedDevFallback({ NODE_ENV: 'test' })).toBe(true);
      // Zero-config boot (autoMigrate:true) is the documented dev/test mode.
      expect(shouldSeedDevFallback({ NODE_ENV: 'production' }, { zeroConfigBoot: true })).toBe(true);
      // Explicit operator opt-in wins in any environment...
      expect(shouldSeedDevFallback({ NODE_ENV: 'production', DU_SEED_DEV_FALLBACK: 'true' })).toBe(true);
      // ...and an explicit false vetoes every other signal.
      expect(shouldSeedDevFallback({ NODE_ENV: 'development', DU_SEED_DEV_FALLBACK: 'false' })).toBe(false);
      expect(shouldSeedDevFallback({ DU_SEED_DEV_FALLBACK: 'false' }, { zeroConfigBoot: true })).toBe(false);
      expect(shouldSeedDevFallback({ DU_SEED_DEV_FALLBACK: '' })).toBe(false);
      expect(shouldSeedDevFallback({ NODE_ENV: 'development' }, { zeroConfigBoot: true })).toBe(true);
    });

    it('a malformed flag fails the gate loudly instead of being ignored', () => {
      expect(() => shouldSeedDevFallback({ DU_SEED_DEV_FALLBACK: 'yes' })).toThrow(
        /DU_SEED_DEV_FALLBACK must be 'true' or 'false'/,
      );
    });
  });

  it('production boot (autoMigrate=false, no flag) inserts neither seed row', async () => {
    const before = devFallbackRowCount();
    const { app, queries } = await boot({ NODE_ENV: 'production', DU_SEED_DEV_FALLBACK: undefined });
    apps.push(app);

    const seedQueries = queries.filter(
      (sql) => sql.includes('INSERT INTO tenants') || sql.includes('INSERT INTO api_keys'),
    );
    expect(seedQueries).toEqual([]);
    // The acceptance SELECT against the modelled DB state: 0 rows.
    expect(devFallbackRowCount()).toBe(before);
  });

  it('a zero-config boot (autoMigrate=true) seeds even under NODE_ENV=production', async () => {
    // This is the documented dev/test zero-config mode that every in-process
    // live fixture uses; production composes default AUTO_MIGRATE=false, and
    // a production operator running a one-shot AUTO_MIGRATE=true boot can
    // still veto with DU_SEED_DEV_FALLBACK=false.
    const before = devFallbackRowCount();
    const { app, queries } = await boot(
      { NODE_ENV: 'production', DU_SEED_DEV_FALLBACK: undefined },
      { autoMigrate: true },
    );
    apps.push(app);

    expect(queries.filter((sql) => sql.includes('INSERT INTO tenants'))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes('INSERT INTO api_keys'))).toHaveLength(1);
    expect(devFallbackRowCount()).toBe(before + 1);
  });

  it('test boot with DU_SEED_DEV_FALLBACK=true inserts both rows', async () => {
    const before = devFallbackRowCount();
    const { app, queries } = await boot({ NODE_ENV: 'test', DU_SEED_DEV_FALLBACK: 'true' });
    apps.push(app);

    expect(queries.filter((sql) => sql.includes('INSERT INTO tenants'))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes('INSERT INTO api_keys'))).toHaveLength(1);
    const seed = queries.find((sql) => sql.includes('INSERT INTO api_keys')) ?? '';
    expect(seed).toContain("'dev-fallback'");
    expect(seed).toContain("'ACTIVE'");
    // The acceptance SELECT against the modelled DB state: exactly one row.
    expect(devFallbackRowCount()).toBe(before + 1);
  });

  it('development boot without a flag also seeds (legacy dev zero-config boot)', async () => {
    const before = devFallbackRowCount();
    const { app, queries } = await boot({ NODE_ENV: 'development', DU_SEED_DEV_FALLBACK: undefined });
    apps.push(app);

    expect(queries.filter((sql) => sql.includes('INSERT INTO tenants'))).toHaveLength(1);
    expect(queries.filter((sql) => sql.includes('INSERT INTO api_keys'))).toHaveLength(1);
    expect(devFallbackRowCount()).toBe(before + 1);
  });
});
