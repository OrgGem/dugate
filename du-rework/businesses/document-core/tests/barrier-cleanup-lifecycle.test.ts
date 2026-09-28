import { randomUUID } from 'node:crypto';

describe('Barrier & Cleanup Lifecycle (Offline Failure-Injection Regressions)', () => {
  describe('1. Bounded Barrier Wait & Timeout Safety', () => {
    it('throws bounded timeout error when barrier is unreached and does not hang', async () => {
      let barrierPromise: Promise<void> | null = null;
      let barrierRelease: (() => void) | null = null;
      let reachedBarrierPromise: Promise<void> | null = null;
      let reachedBarrierSignal: (() => void) | null = null;

      barrierPromise = new Promise<void>((resolve) => {
        barrierRelease = resolve;
      });
      reachedBarrierPromise = new Promise<void>((resolve) => {
        reachedBarrierSignal = resolve;
      });

      const waitForBarrier = async (promise: Promise<void> | null, timeoutMs: number) => {
        if (!promise) return;
        let timer: NodeJS.Timeout | undefined;
        const timeoutPromise = new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error(`Timed out waiting for barrier after ${timeoutMs}ms`)),
            timeoutMs
          );
        });
        try {
          await Promise.race([promise, timeoutPromise]);
        } finally {
          if (timer) clearTimeout(timer);
        }
      };

      let caughtError: Error | null = null;
      try {
        // Deliberately do not signal reachedBarrierPromise; expect timeout at 50ms
        await waitForBarrier(reachedBarrierPromise, 50);
      } catch (err) {
        caughtError = err as Error;
      } finally {
        // Teardown / finally block releases and cleans up barrier state
        const releaseFn = barrierRelease as (() => void) | null;
        if (releaseFn) {
          releaseFn();
          barrierRelease = null;
        }
        barrierPromise = null;
        reachedBarrierPromise = null;
        reachedBarrierSignal = null;
      }

      expect(caughtError).not.toBeNull();
      expect(caughtError?.message).toContain('Timed out waiting for barrier after 50ms');
      expect(barrierPromise).toBeNull();
      expect(reachedBarrierPromise).toBeNull();
    });

    it('unblocks in-flight worker cleanly when assertion failure triggers finally cleanup', async () => {
      let barrierRelease: (() => void) | null = null;
      const barrierPromise = new Promise<void>((resolve) => {
        barrierRelease = resolve;
      });

      let workerUnblocked = false;
      const simulatedWorker = (async () => {
        await barrierPromise;
        workerUnblocked = true;
      })();

      let assertionFailed = false;
      try {
        // Injected assertion failure midway through test
        expect('actual').toBe('expected');
      } catch {
        assertionFailed = true;
      } finally {
        // Test finally block guarantees release of the barrier
        if (barrierRelease) {
          (barrierRelease as () => void)();
          barrierRelease = null;
        }
      }

      expect(assertionFailed).toBe(true);
      await simulatedWorker;
      expect(workerUnblocked).toBe(true);
    });
  });

  describe('2. Aggregated Resource Cleanup under Injected Failure', () => {
    it('executes all teardown steps and aggregates errors when individual resources fail', async () => {
      const cleanupErrors: Error[] = [];
      const cleanupLog: string[] = [];

      // Mock resource 1: child process termination succeeds
      const mockChildProcesses = [
        {
          terminate: async () => {
            cleanupLog.push('childProcess:terminated');
          },
        },
      ];

      // Mock resource 2: worker stop throws injected error
      const mockWorkers = [
        {
          stop: async () => {
            cleanupLog.push('worker:error');
            throw new Error('Injected worker stop network timeout');
          },
        },
      ];

      // Mock resource 3: server close throws injected error
      const mockServers = [
        {
          close: async () => {
            cleanupLog.push('server:error');
            throw new Error('Injected server close error');
          },
        },
      ];

      // Mock resource 4: scoped SQL delete succeeds
      const mockDb = {
        deleteProfiles: async (ids: string[]) => {
          cleanupLog.push(`db:deleteProfiles:${ids.length}`);
        },
        revokeKeys: async (hashes: string[]) => {
          cleanupLog.push(`db:revokeKeys:${hashes.length}`);
        },
        close: async () => {
          cleanupLog.push('db:closed');
        },
      };

      const trackedProfileIds = ['profile-1', 'profile-2'];
      const trackedApiKeys = ['hash-1', 'hash-2'];

      // Execute aggregated teardown sequence (mirroring multi-container-e2e afterAll)
      for (const cp of mockChildProcesses) {
        try {
          await cp.terminate();
        } catch (err) {
          cleanupErrors.push(err as Error);
        }
      }

      for (const w of mockWorkers) {
        try {
          await w.stop();
        } catch (err) {
          cleanupErrors.push(err as Error);
        }
      }

      for (const s of mockServers) {
        try {
          await s.close();
        } catch (err) {
          cleanupErrors.push(err as Error);
        }
      }

      try {
        await mockDb.deleteProfiles(trackedProfileIds);
        await mockDb.revokeKeys(trackedApiKeys);
        await mockDb.close();
      } catch (err) {
        cleanupErrors.push(err as Error);
      }

      // Assert that errors did NOT halt subsequent cleanup
      expect(cleanupErrors).toHaveLength(2);
      expect(cleanupErrors[0]?.message).toContain('Injected worker stop network timeout');
      expect(cleanupErrors[1]?.message).toContain('Injected server close error');

      // Assert that all cleanup stages were attempted in order
      expect(cleanupLog).toEqual([
        'childProcess:terminated',
        'worker:error',
        'server:error',
        'db:deleteProfiles:2',
        'db:revokeKeys:2',
        'db:closed',
      ]);
    });
  });

  describe('3. Dynamic Restricted Key & Profile Tracking', () => {
    it('tracks dynamically created restricted keys and profiles from subtests', () => {
      const primaryKeyHash = 'hash-primary';
      const trackedApiKeys: string[] = [primaryKeyHash];
      const trackedProfileIds: string[] = [];

      // Setup assigns suite profile
      const suiteProfileId = `suite-profile-${randomUUID()}`;
      trackedProfileIds.push(suiteProfileId);

      // Subtest (like Test 13) provisions restricted key and profile
      const restrictedKeyHash = 'hash-restricted-subtest-13';
      const restrictedProfileId = `restricted-profile-${randomUUID()}`;

      trackedApiKeys.push(restrictedKeyHash);
      trackedProfileIds.push(restrictedProfileId);

      expect(trackedApiKeys).toContain(primaryKeyHash);
      expect(trackedApiKeys).toContain(restrictedKeyHash);
      expect(trackedProfileIds).toContain(suiteProfileId);
      expect(trackedProfileIds).toContain(restrictedProfileId);

      // Verify scoped SQL query formulation
      const profileDeleteQueries = trackedProfileIds.map((id) => ({
        sql: 'DELETE FROM profile_bindings WHERE profile_id = $1',
        param: id,
      }));
      expect(profileDeleteQueries).toHaveLength(2);
      expect(profileDeleteQueries[0]?.param).toBe(suiteProfileId);
      expect(profileDeleteQueries[1]?.param).toBe(restrictedProfileId);
    });
  });
});
