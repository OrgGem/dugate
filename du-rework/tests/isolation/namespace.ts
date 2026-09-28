import { randomBytes } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';

/**
 * Per-Run Test Isolation Framework (P1-05 / MM-13 / Wave 41)
 *
 * Eliminates shared-DB, shared-Redis, and shared-artifact contention by allocating
 * strictly partitioned, dynamic namespaces per test run/process.
 *
 * Prevents catastrophic global TRUNCATE contention across concurrent test agents
 * and makes unsafe shared configs fail loudly before executing mutations.
 */

export interface TestIsolationContext {
  /** Unique, sortable run identifier (e.g. 'run_1790100000000_a1b2c3d4') */
  readonly runId: string;
  /** Isolated PostgreSQL schema name (e.g. 'du_test_run_1790100000000_a1b2c3d4') */
  readonly dbSchema: string;
  /** Isolated Redis key prefix (e.g. 'du:test:run_1790100000000_a1b2c3d4:') */
  readonly redisPrefix: string;
  /** Dedicated Redis database index (1-14) allocated per run */
  readonly redisDbIndex: number;
  /** Isolated BullMQ queue prefix (e.g. 'du:q:run_1790100000000_a1b2c3d4:') */
  readonly queuePrefix: string;
  /** Isolated scratch/artifact filesystem directory */
  readonly artifactDir: string;
  /** Isolated deterministic tenant UUID */
  readonly tenantId: string;
  /** Created timestamp */
  readonly createdAt: number;

  /** Qualify an un-namespaced logical Redis key with the per-run prefix */
  qualifyRedisKey(logicalKey: string): string;

  /** Qualify a BullMQ queue name with the per-run prefix */
  qualifyQueueName(businessId: string, version: string): string;

  /** Format a SQL table reference qualified by the isolated schema */
  qualifyTableSql(tableName: string): string;

  /** Append PostgreSQL search_path option to a connection string */
  getDatabaseUrlWithSchema(baseUrl: string): string;

  /** Append or replace Redis database index with isolated per-run DB index */
  getRedisUrl(baseUrl: string): string;

  /** Clean up isolated scratch artifact directory for this run */
  cleanupArtifactDir(): void;
}

export interface IsolationOptions {
  runId?: string;
  schema?: string;
  redisDbIndex?: number;
  baseArtifactPath?: string;
}

/**
 * Generate a cryptographically distinct, URL-safe and SQL-safe run ID.
 */
export function allocateRunId(prefix = 'run'): string {
  const timestamp = Date.now();
  const entropy = randomBytes(4).toString('hex');
  return `${prefix}_${timestamp}_${entropy}`;
}

/**
 * Allocate a fully isolated per-run context.
 */
export function createTestIsolationContext(options: IsolationOptions = {}): TestIsolationContext {
  const runId = options.runId ?? allocateRunId();
  const sanitizedRunId = runId.replace(/[^a-zA-Z0-9_]/g, '_');
  const dbSchema = options.schema ?? `du_test_${sanitizedRunId}`.toLowerCase().slice(0, 63);
  const redisPrefix = `du:test:${sanitizedRunId}:`;
  const queuePrefix = `du:q:${sanitizedRunId}:`;
  const baseArtifact = options.baseArtifactPath ?? '.du-scratch/artifacts';
  const artifactDir = `${baseArtifact}/${sanitizedRunId}`;

  // Dedicated Redis database index: 1-14 (reserving 0 for default/shared and 15 for system)
  const redisDbIndex =
    options.redisDbIndex ?? (1 + (parseInt(randomBytes(2).toString('hex'), 16) % 14));

  // Deterministic UUID for tenant using run entropy
  const entropyBytes = randomBytes(6).toString('hex');
  const tenantId = `00000000-0000-4000-a000-${entropyBytes}`;

  return {
    runId,
    dbSchema,
    redisPrefix,
    redisDbIndex,
    queuePrefix,
    artifactDir,
    tenantId,
    createdAt: Date.now(),

    qualifyRedisKey(logicalKey: string): string {
      return `${redisPrefix}${logicalKey}`;
    },

    qualifyQueueName(businessId: string, version: string): string {
      return `${queuePrefix}${businessId}-${version}`;
    },

    qualifyTableSql(tableName: string): string {
      return `"${dbSchema}"."${tableName}"`;
    },

    getDatabaseUrlWithSchema(baseUrl: string): string {
      const url = new URL(baseUrl);
      const existingOptions = url.searchParams.get('options');
      if (existingOptions && existingOptions.includes('search_path')) {
        return url.toString();
      }
      url.searchParams.set('options', `-csearch_path=${dbSchema},public`);
      return url.toString();
    },

    getRedisUrl(baseUrl: string): string {
      const url = new URL(baseUrl);
      // If URL has no path, or path is "/" or "/0" (shared default), assign isolated DB index
      if (!url.pathname || url.pathname === '/' || url.pathname === '/0') {
        url.pathname = `/${redisDbIndex}`;
      }
      return url.toString();
    },

    cleanupArtifactDir(): void {
      try {
        if (existsSync(artifactDir)) {
          rmSync(artifactDir, { recursive: true, force: true });
        }
      } catch {
        // Best effort cleanup
      }
    },
  };
}

/**
 * SQL DDL generator to provision per-run schema.
 * Replaces global TRUNCATE by giving each test runner its own schema sandbox.
 */
export function generateSchemaSetupDdl(schema: string): string {
  return [
    `CREATE SCHEMA IF NOT EXISTS "${schema}";`,
    `COMMENT ON SCHEMA "${schema}" IS 'DUGate isolated test sandbox - auto-dropped on completion';`,
  ].join('\n');
}

/**
 * SQL DDL generator to tear down ONLY this runner's schema.
 * Leaves all concurrent runners' schemas and data completely unaffected.
 */
export function generateSchemaTeardownDdl(schema: string): string {
  return `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`;
}

export interface SafeIsolationCheckOptions {
  databaseUrl: string;
  redisUrl?: string;
  isolationCtx?: TestIsolationContext | null;
  allowUnsafeShared?: boolean;
}

/**
 * MM-13 Guard: Make unsafe shared test configurations fail loudly before mutating state.
 *
 * Prevents overlapping test runs from executing cleanup or writes against the shared "public"
 * schema or un-partitioned Redis DB 0, which was the exact mechanism that produced the
 * 01:49 deadlock/truncation incidents across lanes.
 */
export function assertSafeIsolationConfig(options: SafeIsolationCheckOptions): void {
  if (options.allowUnsafeShared) {
    return;
  }

  const dbUrl = options.databaseUrl;
  let parsedDb: URL;
  try {
    parsedDb = new URL(dbUrl);
  } catch {
    throw new Error(`UNSAFE_SHARED_CONFIG_ERROR: Malformed database URL: "${dbUrl}"`);
  }

  const dbName = parsedDb.pathname.split('/').pop() ?? '';
  const searchPathOpt = parsedDb.searchParams.get('options') ?? '';
  const searchPathMatch = searchPathOpt.match(/search_path=([^,&]+)/);
  const primarySchema = searchPathMatch ? searchPathMatch[1] : 'public';

  // 1. Fail loudly if target database is a test DB and running against bare "public" schema
  if (!options.isolationCtx || primarySchema === 'public' || !searchPathMatch) {
    throw new Error(
      `UNSAFE_SHARED_CONFIG_ERROR: Unsafe shared database configuration detected for "${dbName}"! Target schema is "${primarySchema}". Running tests or cleanup against the un-namespaced "public" schema causes cross-suite truncation and deadlocks. Wire TestIsolationContext into DATABASE_URL (via getDatabaseUrlWithSchema) or explicitly set allowUnsafeShared=true.`
    );
  }

  // 2. Fail loudly if Redis points to shared DB 0 without key prefix isolation
  if (options.redisUrl) {
    try {
      const parsedRedis = new URL(options.redisUrl);
      const redisPath = parsedRedis.pathname.replace(/^\//, '');
      const dbNum = parseInt(redisPath, 10);
      if (
        (!redisPath || dbNum === 0 || isNaN(dbNum)) &&
        (!options.isolationCtx?.redisPrefix || options.isolationCtx.redisPrefix === '')
      ) {
        throw new Error(
          `UNSAFE_SHARED_CONFIG_ERROR: Unsafe shared Redis configuration detected! Redis URL "${options.redisUrl}" targets shared database 0 without key prefix isolation. Use getRedisUrl() or allocate a dedicated database index (1-14) to prevent BullMQ queue collisions.`
        );
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.message.startsWith('UNSAFE_SHARED_CONFIG_ERROR')) {
        throw err;
      }
    }
  }
}

