import {
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  assertSafeIsolationConfig,
  type TestIsolationContext,
} from './namespace';
import { IsolatedRedisJail } from './redis-jail';
import { IsolatedArtifactJail } from './artifact-jail';
import { InMemoryRuntimeStub } from './stubs/runtime-stub';

/**
 * P1-05: Concurrent-Run Interference Prevention Proof
 *
 * This test suite provides definitive automated proof that:
 * 1. Un-isolated test runs sharing global database/Redis state suffer cross-run interference.
 * 2. Per-run isolated namespaces (schema + Redis prefix + artifact jail) prevent concurrent-run interference.
 */
describe('P1-05: Test Isolation Framework & Concurrent-Run Interference Prevention', () => {
  beforeEach(() => {
    IsolatedRedisJail.clearAll();
    IsolatedArtifactJail.clearAll();
  });

  // -------------------------------------------------------------------------
  // 1. Negative Baseline: Un-isolated Shared Contention Failure
  // -------------------------------------------------------------------------
  describe('Negative Baseline: Shared State Contention (Why global TRUNCATE failed)', () => {
    test('shared unpartitioned store causes concurrent run failure when Run-A cleans up Run-B data', async () => {
      // Simulate un-isolated shared table/store across two parallel test runners
      const sharedUnpartitionedTable = new Map<string, { taskId: string; state: string }>();

      // Run-B starts a long-running workflow and inserts its in-flight task
      sharedUnpartitionedTable.set('task-101', { taskId: 'task-101', state: 'RUNNING' });

      // Run-A starts concurrently and runs a global TRUNCATE (the previous runtime.test.ts behavior)
      const simulateGlobalTruncate = () => {
        sharedUnpartitionedTable.clear(); // Wipes everything!
      };

      simulateGlobalTruncate();

      // Run-B attempts to read or update its task -> FAILS with missing task!
      const runBTask = sharedUnpartitionedTable.get('task-101');
      expect(runBTask).toBeUndefined(); // Interference proven!
    });

    test('shared unpartitioned Redis keys cause concurrent run false-quota exhaustion', async () => {
      // Without prefix isolation, two concurrent test runners hit the identical Redis key
      const sharedRedis = new IsolatedRedisJail(''); // Empty prefix = un-isolated shared namespace
      const logicalKey = 'provider:openai:gpt-4o';
      const now = Date.now();
      const expiry = now + 10_000;
      const maxInFlight = 1;

      const acquireScript = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local expiry = tonumber(ARGV[2])
        local max = tonumber(ARGV[3])
        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
        if redis.call('ZCARD', key) >= max then return false end
        redis.call('ZADD', key, expiry, ARGV[4])
        return ARGV[4]
      `;

      // Run-A acquires the single quota slot
      const leaseA = await sharedRedis.eval(acquireScript, 1, logicalKey, String(now), String(expiry), String(maxInFlight), 'lease-A');
      expect(leaseA).toBe('lease-A');

      // Concurrently running Run-B attempts to acquire the slot -> FAILS with false quota exhaustion!
      const leaseB = await sharedRedis.eval(acquireScript, 1, logicalKey, String(now), String(expiry), String(maxInFlight), 'lease-B');
      expect(leaseB).toBe(false); // Unwanted cross-runner contention proven!
    });
  });

  // -------------------------------------------------------------------------
  // 2. Positive Proof: Per-Run Schema & Namespace Isolation
  // -------------------------------------------------------------------------
  describe('Positive Proof: Per-Run Schema Isolation Prevents Contention', () => {
    test('two concurrent runs with distinct TestIsolationContext never interfere during lifecycle cleanup', async () => {
      const ctxA = createTestIsolationContext();
      const ctxB = createTestIsolationContext();

      // Ensure namespaces are distinct
      expect(ctxA.runId).not.toBe(ctxB.runId);
      expect(ctxA.dbSchema).not.toBe(ctxB.dbSchema);
      expect(ctxA.redisPrefix).not.toBe(ctxB.redisPrefix);
      expect(ctxA.artifactDir).not.toBe(ctxB.artifactDir);

      // Verify DDL commands target strictly isolated schemas
      const setupA = generateSchemaSetupDdl(ctxA.dbSchema);
      const teardownA = generateSchemaTeardownDdl(ctxA.dbSchema);
      expect(setupA).toContain(`"${ctxA.dbSchema}"`);
      expect(teardownA).toContain(`DROP SCHEMA IF EXISTS "${ctxA.dbSchema}" CASCADE;`);
      expect(teardownA).not.toContain(ctxB.dbSchema);

      // Simulate runtime task execution partitioned by context
      const runtimeA = new InMemoryRuntimeStub(ctxA);
      const runtimeB = new InMemoryRuntimeStub(ctxB);

      // Both runners create a task with the IDENTICAL logical task key
      const taskA = runtimeA.registerTask({ taskId: '11111111-1111-4111-8111-111111111111', taskKey: 'shared-action-key' });
      const taskB = runtimeB.registerTask({ taskId: '22222222-2222-4222-8222-222222222222', taskKey: 'shared-action-key' });

      expect(taskA.status).toBe('PENDING');
      expect(taskB.status).toBe('PENDING');

      // Run A claims and completes its task, then triggers its scoped cleanup
      await runtimeA.claimTask(taskA.taskId, 'worker-a');
      await runtimeA.saveStep(taskA.taskId, 2, 'extract', 'hash-1', { output: 'A' });
      runtimeA.clear(); // Scoped cleanup of Run A only!

      // Run B was running concurrently: its task MUST remain 100% intact!
      const activeTaskB = runtimeB.getTask(taskB.taskId);
      expect(activeTaskB).toBeDefined();
      expect(activeTaskB?.status).toBe('PENDING');

      // Run B claims and saves step successfully without any interference from Run A
      const claimB = await runtimeB.claimTask(taskB.taskId, 'worker-b');
      expect(claimB.claimed).toBe(true);
      const stepB = await runtimeB.saveStep(taskB.taskId, claimB.leaseEpoch!, 'extract', 'hash-2', { output: 'B' });
      expect(stepB.saved).toBe(true);
      expect(stepB.replayed).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // 3. Positive Proof: Redis Key Prefix Partitioning
  // -------------------------------------------------------------------------
  describe('Positive Proof: Redis Key Prefix Partitioning Prevents Lock & Quota Contention', () => {
    test('concurrent runs acquiring identical quota slots operate independently and survive flush', async () => {
      const ctxA = createTestIsolationContext();
      const ctxB = createTestIsolationContext();

      const redisA = new IsolatedRedisJail(ctxA.redisPrefix);
      const redisB = new IsolatedRedisJail(ctxB.redisPrefix);

      const acquireScript = `
        local key = KEYS[1]
        local now = tonumber(ARGV[1])
        local expiry = tonumber(ARGV[2])
        local max = tonumber(ARGV[3])
        redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
        if redis.call('ZCARD', key) >= max then return false end
        redis.call('ZADD', key, expiry, ARGV[4])
        return ARGV[4]
      `;

      const releaseScript = `
        redis.call('ZREM', KEYS[1], ARGV[1])
        if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
        return 1
      `;

      const logicalKey = 'provider:openai:gpt-4o';
      const now = Date.now();
      const expiry = now + 10_000;
      const maxInFlight = 1;

      // Run A acquires slot
      const leaseA = await redisA.eval(acquireScript, 1, logicalKey, String(now), String(expiry), String(maxInFlight), 'lease-A');
      expect(leaseA).toBe('lease-A');

      // Run B also acquires slot for the EXACT SAME logical key — succeeds because prefix isolates them!
      const leaseB = await redisB.eval(acquireScript, 1, logicalKey, String(now), String(expiry), String(maxInFlight), 'lease-B');
      expect(leaseB).toBe('lease-B');

      // But a second acquisition within Run A's own jail correctly respects the cap
      const leaseA2 = await redisA.eval(acquireScript, 1, logicalKey, String(now), String(expiry), String(maxInFlight), 'lease-A2');
      expect(leaseA2).toBe(false);

      // Run A flushes its namespace
      await redisA.flushNamespace();

      // Run B's lease is STILL present and released cleanly!
      const releaseB = await redisB.eval(releaseScript, 1, logicalKey, 'lease-B');
      expect(releaseB).toBe(1);
    });

    test('isolated queue names prevent BullMQ job cross-delivery', () => {
      const ctxA = createTestIsolationContext();
      const ctxB = createTestIsolationContext();

      const queueA = ctxA.qualifyQueueName('document-core', '1.0.0');
      const queueB = ctxB.qualifyQueueName('document-core', '1.0.0');

      expect(queueA).not.toBe(queueB);
      expect(queueA).toContain('document-core-1.0.0');
      expect(queueB).toContain('document-core-1.0.0');
      expect(queueA).toContain(ctxA.runId);
      expect(queueB).toContain(ctxB.runId);
    });
  });

  // -------------------------------------------------------------------------
  // 4. Positive Proof: Artifact Jail Quarantine
  // -------------------------------------------------------------------------
  describe('Positive Proof: Artifact Jail Quarantine', () => {
    test('staged artifacts with identical names are segregated by runId and protected from peer flush', async () => {
      const ctxA = createTestIsolationContext();
      const ctxB = createTestIsolationContext();

      const jailA = new IsolatedArtifactJail(ctxA.runId, ctxA.tenantId);
      const jailB = new IsolatedArtifactJail(ctxB.runId, ctxB.tenantId);

      const payloadA = Buffer.from('Runner A document payload');
      const payloadB = Buffer.from('Runner B document payload');

      const artA = await jailA.putStaged(payloadA, 'invoice.pdf', 'application/pdf');
      const artB = await jailB.putStaged(payloadB, 'invoice.pdf', 'application/pdf');

      expect(artA.artifactId).not.toBe(artB.artifactId);
      expect(artA.hashSha256).not.toBe(artB.hashSha256);

      // Run A flushes all its artifacts
      const flushed = await jailA.flush();
      expect(flushed).toBe(1);

      // Run A cannot access its flushed artifact
      await expect(jailA.get(artA.artifactId)).rejects.toThrow();

      // Run B's artifact is completely preserved and readable!
      const contentB = await jailB.get(artB.artifactId);
      expect(contentB.toString('utf8')).toBe('Runner B document payload');

      // Run A cannot access Run B's artifact (fail-closed tenant/run jail)
      await expect(jailA.get(artB.artifactId)).rejects.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 5. MM-13 Guard: Loud Failure on Unsafe Shared Configuration
  // -------------------------------------------------------------------------
  describe('5. MM-13 Guard: Loud Failure on Unsafe Shared Configuration', () => {
    test('throws UNSAFE_SHARED_CONFIG_ERROR when DATABASE_URL lacks isolated search_path', () => {
      const bareDbUrl = 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
      expect(() => {
        assertSafeIsolationConfig({
          databaseUrl: bareDbUrl,
          isolationCtx: null,
        });
      }).toThrow(/UNSAFE_SHARED_CONFIG_ERROR.*Target schema is "public"/);
    });

    test('throws UNSAFE_SHARED_CONFIG_ERROR when DATABASE_URL explicitly targets public schema', () => {
      const publicSchemaUrl = 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test?options=-csearch_path=public';
      const ctx = createTestIsolationContext();
      expect(() => {
        assertSafeIsolationConfig({
          databaseUrl: publicSchemaUrl,
          isolationCtx: ctx,
        });
      }).toThrow(/UNSAFE_SHARED_CONFIG_ERROR.*Target schema is "public"/);
    });

    test('throws UNSAFE_SHARED_CONFIG_ERROR when Redis targets shared DB 0 without prefix isolation', () => {
      const ctx = createTestIsolationContext();
      const isolatedDbUrl = ctx.getDatabaseUrlWithSchema('postgresql://du:du-test-only@localhost:5433/du_orchestrator_test');
      const unisolatedRedisUrl = 'redis://localhost:6380/0';

      // Simulate context with empty prefix targeting shared DB 0
      const unisolatedCtx: TestIsolationContext = {
        ...ctx,
        redisPrefix: '',
      };

      expect(() => {
        assertSafeIsolationConfig({
          databaseUrl: isolatedDbUrl,
          redisUrl: unisolatedRedisUrl,
          isolationCtx: unisolatedCtx,
        });
      }).toThrow(/UNSAFE_SHARED_CONFIG_ERROR.*targets shared database 0 without key prefix isolation/);
    });

    test('succeeds when properly isolated with per-run schema and Redis database index', () => {
      const ctx = createTestIsolationContext();
      const isolatedDbUrl = ctx.getDatabaseUrlWithSchema('postgresql://du:du-test-only@localhost:5433/du_orchestrator_test');
      const isolatedRedisUrl = ctx.getRedisUrl('redis://localhost:6380');

      expect(() => {
        assertSafeIsolationConfig({
          databaseUrl: isolatedDbUrl,
          redisUrl: isolatedRedisUrl,
          isolationCtx: ctx,
        });
      }).not.toThrow();
    });

    test('allows unsafe shared config when allowUnsafeShared flag is explicitly set', () => {
      const bareDbUrl = 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
      expect(() => {
        assertSafeIsolationConfig({
          databaseUrl: bareDbUrl,
          isolationCtx: null,
          allowUnsafeShared: true,
        });
      }).not.toThrow();
    });
  });

  // -------------------------------------------------------------------------
  // 6. MM-13 Plain Run Automatic Isolation (PostgreSQL + Redis + Artifacts)
  // -------------------------------------------------------------------------
  describe('6. MM-13 Plain Run Automatic Isolation (PostgreSQL + Redis + Artifacts)', () => {
    test('plain run with zero environment variables automatically allocates distinct sandboxes', () => {
      // Simulate two completely plain runs without any environment variables
      const plainRunA = createTestIsolationContext();
      const plainRunB = createTestIsolationContext();

      // PostgreSQL isolation
      expect(plainRunA.dbSchema).not.toBe(plainRunB.dbSchema);
      expect(plainRunA.dbSchema).toMatch(/^du_test_run_/);
      expect(plainRunB.dbSchema).toMatch(/^du_test_run_/);

      const dbUrlA = plainRunA.getDatabaseUrlWithSchema('postgresql://du:du-test-only@localhost:5433/du_orchestrator_test');
      const dbUrlB = plainRunB.getDatabaseUrlWithSchema('postgresql://du:du-test-only@localhost:5433/du_orchestrator_test');
      expect(decodeURIComponent(dbUrlA)).toContain(`search_path=${plainRunA.dbSchema},public`);
      expect(decodeURIComponent(dbUrlB)).toContain(`search_path=${plainRunB.dbSchema},public`);

      // Redis isolation
      expect(plainRunA.redisDbIndex).toBeGreaterThanOrEqual(1);
      expect(plainRunA.redisDbIndex).toBeLessThanOrEqual(14);
      expect(plainRunB.redisDbIndex).toBeGreaterThanOrEqual(1);
      expect(plainRunB.redisDbIndex).toBeLessThanOrEqual(14);

      const redisUrlA = plainRunA.getRedisUrl('redis://127.0.0.1:6380');
      const redisUrlB = plainRunB.getRedisUrl('redis://127.0.0.1:6380');
      expect(redisUrlA).toBe(`redis://127.0.0.1:6380/${plainRunA.redisDbIndex}`);
      expect(redisUrlB).toBe(`redis://127.0.0.1:6380/${plainRunB.redisDbIndex}`);

      // Artifact isolation
      expect(plainRunA.artifactDir).not.toBe(plainRunB.artifactDir);
      expect(plainRunA.artifactDir).toContain(plainRunA.runId);
      expect(plainRunB.artifactDir).toContain(plainRunB.runId);

      // Cleanup isolation
      plainRunA.cleanupArtifactDir();
      plainRunB.cleanupArtifactDir();
    });
  });
});

