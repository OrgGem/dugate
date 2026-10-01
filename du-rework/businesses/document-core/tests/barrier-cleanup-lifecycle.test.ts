import { randomUUID } from 'node:crypto';

describe('Barrier & Cleanup Lifecycle (Offline Failure-Injection Regressions)', () => {
  type CleanupResource = { name: string; open: boolean; closeFails?: boolean };

  function createBarrierCleanupFixture(options: { markerExists?: boolean; failingResource?: string } = {}) {
    const state = {
      markerExists: options.markerExists ?? true,
      released: false,
      releaseAttempts: 0,
      releaseSignals: 0,
      expired: false,
      cleaned: false,
      cleanupRequests: 0,
      cleanupRuns: 0,
      cleanupErrors: [] as string[],
    };
    const resources: CleanupResource[] = [
      { name: 'barrier-lock', open: true, closeFails: options.failingResource === 'barrier-lock' },
      { name: 'worker-handle', open: true, closeFails: options.failingResource === 'worker-handle' },
    ];
    let signalRelease = () => {};
    const released = new Promise<void>((resolve) => {
      signalRelease = resolve;
    });
    let cleanupInFlight: Promise<void> | null = null;

    const waitForBarrier = async (timeoutMs: number): Promise<'released' | 'expired'> => {
      let timer: NodeJS.Timeout | undefined;
      const expiry = new Promise<'expired'>((resolve) => {
        timer = setTimeout(() => {
          state.expired = true;
          resolve('expired');
        }, timeoutMs);
      });
      try {
        return await Promise.race([released.then(() => 'released' as const), expiry]);
      } finally {
        if (timer) clearTimeout(timer);
      }
    };

    const releaseBarrier = (): boolean => {
      state.releaseAttempts++;
      if (state.expired || !state.markerExists || state.released) return false;
      state.released = true;
      state.releaseSignals++;
      signalRelease();
      return true;
    };

    const cleanup = async (cleanupOptions: { crashAfterMarkerUnlink?: boolean; gate?: Promise<void> } = {}): Promise<void> => {
      state.cleanupRequests++;
      if (cleanupInFlight) return cleanupInFlight;

      state.cleanupRuns++;
      const current = (async () => {
        if (state.markerExists) {
          state.markerExists = false;
        }
        if (cleanupOptions.crashAfterMarkerUnlink) {
          throw new Error('simulated process crash during cleanup');
        }
        if (cleanupOptions.gate) await cleanupOptions.gate;

        for (const resource of resources) {
          try {
            if (resource.closeFails) throw new Error(`close failed: ${resource.name}`);
            await Promise.resolve();
          } catch (error) {
            state.cleanupErrors.push((error as Error).message);
          } finally {
            // Model the forced release path even when graceful close reports an error.
            resource.open = false;
          }
        }
        state.cleaned = true;
      })();
      cleanupInFlight = current;
      try {
        await current;
      } finally {
        if (cleanupInFlight === current) cleanupInFlight = null;
      }
    };

    return { state, resources, waitForBarrier, releaseBarrier, cleanup };
  }

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

  describe('4. Barrier Cleanup Failure and Concurrency Boundaries', () => {
    it('expires a barrier before release and cleans its marker and resources', async () => {
      const fixture = createBarrierCleanupFixture();

      await expect(fixture.waitForBarrier(5)).resolves.toBe('expired');
      expect(fixture.state.expired).toBe(true);
      expect(fixture.releaseBarrier()).toBe(false);

      await Promise.all([fixture.cleanup(), fixture.cleanup()]);
      expect(fixture.state.markerExists).toBe(false);
      expect(fixture.resources.every((resource) => !resource.open)).toBe(true);
      expect(fixture.state.cleaned).toBe(true);
      expect(fixture.state.cleanupRuns).toBe(1);
    });

    it('recovers cleanup after a process crash between marker unlink and resource release', async () => {
      const fixture = createBarrierCleanupFixture();

      await expect(fixture.cleanup({ crashAfterMarkerUnlink: true })).rejects.toThrow(
        'simulated process crash during cleanup'
      );
      expect(fixture.state.markerExists).toBe(false);
      expect(fixture.resources.every((resource) => resource.open)).toBe(true);

      await fixture.cleanup();
      expect(fixture.state.cleanupRuns).toBe(2);
      expect(fixture.state.cleaned).toBe(true);
      expect(fixture.resources.every((resource) => !resource.open)).toBe(true);
    });

    it('cleans resources when the barrier marker is already missing or unlinked', async () => {
      const fixture = createBarrierCleanupFixture({ markerExists: false });

      await expect(fixture.cleanup()).resolves.toBeUndefined();
      expect(fixture.state.markerExists).toBe(false);
      expect(fixture.state.cleaned).toBe(true);
      expect(fixture.resources.every((resource) => !resource.open)).toBe(true);
    });

    it('coalesces concurrent cleanup requests for the same barrier', async () => {
      const fixture = createBarrierCleanupFixture();
      let releaseCleanupGate = () => {};
      const cleanupGate = new Promise<void>((resolve) => {
        releaseCleanupGate = resolve;
      });

      const cleanupRequests = Array.from({ length: 8 }, (_, index) =>
        index === 0 ? fixture.cleanup({ gate: cleanupGate }) : fixture.cleanup()
      );
      expect(fixture.state.cleanupRequests).toBe(8);
      expect(fixture.state.cleanupRuns).toBe(1);

      releaseCleanupGate();
      await Promise.all(cleanupRequests);

      expect(fixture.state.cleaned).toBe(true);
      expect(fixture.resources.every((resource) => !resource.open)).toBe(true);
      expect(fixture.state.cleanupRuns).toBe(1);
    });

    it('isolates partial cleanup failures so another barrier still releases all resources', async () => {
      const failingBarrier = createBarrierCleanupFixture({ failingResource: 'barrier-lock' });
      const healthyBarrier = createBarrierCleanupFixture();

      await Promise.all([failingBarrier.cleanup(), healthyBarrier.cleanup()]);

      expect(failingBarrier.state.cleanupErrors).toEqual(['close failed: barrier-lock']);
      expect(failingBarrier.state.cleaned).toBe(true);
      expect(failingBarrier.resources.every((resource) => !resource.open)).toBe(true);
      expect(healthyBarrier.state.cleanupErrors).toEqual([]);
      expect(healthyBarrier.state.cleaned).toBe(true);
      expect(healthyBarrier.resources.every((resource) => !resource.open)).toBe(true);
    });

    it('suppresses cleanup errors only after releasing every tracked resource', async () => {
      const fixture = createBarrierCleanupFixture({ failingResource: 'barrier-lock' });

      await expect(fixture.cleanup()).resolves.toBeUndefined();
      expect(fixture.state.cleanupErrors).toEqual(['close failed: barrier-lock']);
      expect(fixture.state.markerExists).toBe(false);
      expect(fixture.state.cleaned).toBe(true);
      expect(fixture.resources.every((resource) => !resource.open)).toBe(true);
    });

    it('makes repeated barrier release idempotent and signals waiters only once', async () => {
      const fixture = createBarrierCleanupFixture();
      const barrierWait = fixture.waitForBarrier(100);

      expect(fixture.releaseBarrier()).toBe(true);
      expect(fixture.releaseBarrier()).toBe(false);
      await expect(barrierWait).resolves.toBe('released');

      expect(fixture.state.released).toBe(true);
      expect(fixture.state.releaseAttempts).toBe(2);
      expect(fixture.state.releaseSignals).toBe(1);
    });
  });
});
