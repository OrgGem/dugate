import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import { EventEmitter } from 'node:events';
import type { ChildProcess } from 'node:child_process';
import { ManagedChildProcessTracker } from './helpers/child-process-manager';

interface MockChildProcess extends EventEmitter {
  pid: number;
  exitCode: number | null;
  signalCode: string | null;
  killed: boolean;
  connected: boolean;
  kill: (signal?: unknown) => boolean;
  emitExit: (code: number, signal: string) => void;
}

function createMockChildProcess(options?: {
  pid?: number;
  exitCode?: number | null;
  signalCode?: string | null;
  killed?: boolean;
  onKill?: (signal?: unknown) => boolean;
}): MockChildProcess {
  const emitter = new EventEmitter() as MockChildProcess;
  emitter.pid = options?.pid ?? 99999;
  emitter.exitCode = options?.exitCode ?? null;
  emitter.signalCode = options?.signalCode ?? null;
  emitter.killed = options?.killed ?? false;
  emitter.connected = true;

  emitter.emitExit = (code: number, signal: string) => {
    emitter.exitCode = code;
    emitter.signalCode = signal;
    emitter.emit('exit', code, signal);
  };

  emitter.kill = jest.fn((signal?: unknown) => {
    emitter.killed = true;
    if (options?.onKill) {
      return options.onKill(signal);
    }
    // Default mock behavior: emit exit after a tick unless custom onKill is provided
    queueMicrotask(() => {
      emitter.emitExit(0, typeof signal === 'string' ? signal : 'SIGKILL');
    });
    return true;
  });

  return emitter;
}

async function withTemporaryChild<T>(
  tracker: ManagedChildProcessTracker,
  script: string,
  run: (child: ChildProcess) => Promise<T>,
  execArgv?: string[]
): Promise<T> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'doc-core-child-lifecycle-'));
  const scriptPath = path.join(directory, 'runner.cjs');
  await fs.writeFile(scriptPath, script, 'utf8');
  const child = tracker.spawn(scriptPath, [], {
    execArgv,
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });

  try {
    return await run(child);
  } finally {
    if (tracker.hasChild(child)) {
      try {
        await tracker.terminate(child, 1500);
      } catch {
        // afterEach reports an unconfirmed survivor retained by the tracker.
      }
    }
    await fs.rm(directory, { recursive: true, force: true });
  }
}

describe('Child Process Lifecycle & Failure Cleanup Tests (Wave 15 / Wave 16)', () => {
  const runnerPath = path.resolve(__dirname, 'helpers/mock-child-lifecycle-runner.cjs');
  let tracker: ManagedChildProcessTracker;

  beforeEach(() => {
    tracker = new ManagedChildProcessTracker();
  });

  afterEach(async () => {
    // Remove any test doubles before afterEach termination so we do not wait on intentionally unkillable mocks
    for (const child of Array.from((tracker as unknown as { activeChildren: Set<ChildProcess> }).activeChildren)) {
      if ((child as unknown as { emitExit?: unknown }).emitExit) {
        (tracker as unknown as { activeChildren: Set<ChildProcess> }).activeChildren.delete(child);
      }
    }
    const errors = await tracker.terminateAll(2000);
    expect(errors).toHaveLength(0);
    expect(tracker.trackedCount).toBe(0);
  });

  describe('Real Process Lifecycle Scenarios', () => {
    test('promptly rejects waitForMessage when child exits prematurely before sending ready', async () => {
      const startTime = Date.now();
      const child = tracker.spawn(runnerPath, [], {
        env: { ...process.env, SCENARIO: 'exit-immediately' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      expect(tracker.trackedCount).toBe(1);

      await expect(tracker.waitForMessage(child, 'ready', 5000)).rejects.toThrow(
        /exited early with code 1/
      );

      // Fast rejection check: must reject within 2000ms instead of hanging for the 5000ms timeout
      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);

      // Verify all listeners cleaned up on early exit
      expect(child.listenerCount('message')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);

      // Explicitly terminate to clean up tracker
      await tracker.terminate(child);
      expect(tracker.trackedCount).toBe(0);
      expect(child.connected).toBe(false);
    });

    test('promptly rejects waitForMessage when child encounters fatal startup error', async () => {
      const startTime = Date.now();
      const child = tracker.spawn(runnerPath, [], {
        env: { ...process.env, SCENARIO: 'exit-error' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      await expect(tracker.waitForMessage(child, 'ready', 5000)).rejects.toThrow(
        /exited early with code 2/
      );

      const elapsed = Date.now() - startTime;
      expect(elapsed).toBeLessThan(2000);

      // Verify all listeners cleaned up on fatal exit
      expect(child.listenerCount('message')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);

      await tracker.terminate(child);
      expect(tracker.trackedCount).toBe(0);
      expect(child.connected).toBe(false);
    });

    test('bounded timeout rejects when child is ready but hangs before reaching step barrier', async () => {
      const child = tracker.spawn(runnerPath, [], {
        env: { ...process.env, SCENARIO: 'ready-then-hang' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      // 1. Ready arrives as expected
      const readyMsg = await tracker.waitForMessage(child, 'ready', 5000);
      expect(readyMsg.type).toBe('ready');

      // 2. Step barrier wait with a bounded 300ms timeout
      const stepStart = Date.now();
      await expect(tracker.waitForMessage(child, 'step_held', 300)).rejects.toThrow(
        /Timed out after 300ms waiting for message "step_held"/
      );
      const elapsed = Date.now() - stepStart;
      expect(elapsed).toBeGreaterThanOrEqual(250);
      expect(elapsed).toBeLessThan(1500);

      // Verify listeners cleaned up after timeout
      expect(child.listenerCount('message')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);

      // 3. Terminate child and assert clean exit
      const termRes = await tracker.terminate(child, 2000);
      expect(termRes).toBeDefined();
      expect(tracker.trackedCount).toBe(0);
      expect(child.connected).toBe(false);
    });

    test('successfully receives ready and step barrier, and cleanly awaits termination', async () => {
      const child = tracker.spawn(runnerPath, [], {
        env: { ...process.env, SCENARIO: 'ready-then-step' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      const readyMsg = await tracker.waitForMessage(child, 'ready', 5000);
      expect(readyMsg.type).toBe('ready');

      const stepMsg = await tracker.waitForMessage(child, 'step_held', 5000);
      expect(stepMsg.type).toBe('step_held');
      expect(stepMsg.step).toBe('extract:connector-inference');

      // Retained in active tracking until termination confirmed
      expect(tracker.trackedCount).toBe(1);

      const termRes = await tracker.terminate(child, 3000);
      expect(child.killed).toBe(true);
      expect(termRes).toBeDefined();
      expect(tracker.trackedCount).toBe(0);
      expect(child.connected).toBe(false);
    });

    test('retains child process in tracker until termination confirmed, then safely empties tracker', async () => {
      const child = tracker.spawn(runnerPath, [], {
        env: { ...process.env, SCENARIO: 'ready-then-step' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      expect(tracker.trackedCount).toBe(1);
      await tracker.waitForMessage(child, 'ready', 5000);

      // Child is still alive, so tracker still tracks it
      expect(tracker.trackedCount).toBe(1);

      const term = await tracker.terminate(child, 2000);
      expect(term).toBeDefined();
      // Only after terminate resolves is it removed from tracker
      expect(tracker.trackedCount).toBe(0);
      expect(child.connected).toBe(false);
    });

    test('handles already-exited process safely during terminate without error, hang, or double-kill', async () => {
      const child = tracker.spawn(runnerPath, [], {
        env: { ...process.env, SCENARIO: 'exit-immediately' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      // Wait for the process to exit naturally
      await new Promise<void>((resolve) => {
        child.once('exit', () => resolve());
      });
      expect(child.exitCode).toBe(1);

      // Terminating an already-exited process should resolve immediately and clean up tracking
      const result = await tracker.terminate(child, 1000);
      expect(result.code).toBe(1);
      expect(tracker.trackedCount).toBe(0);
      expect(child.connected).toBe(false);
    });

    test('cleans up all IPC listeners and disengages IPC channel on termination with no lingering handles', async () => {
      const child = tracker.spawn(runnerPath, [], {
        env: { ...process.env, SCENARIO: 'ready-then-step' },
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      });

      await tracker.waitForMessage(child, 'ready', 5000);
      await tracker.waitForMessage(child, 'step_held', 5000);

      // Terminate the process
      await tracker.terminate(child, 3000);

      // Assert complete listener cleanup and channel disengagement
      expect(child.listenerCount('message')).toBe(0);
      expect(child.listenerCount('exit')).toBe(0);
      expect(child.listenerCount('error')).toBe(0);
      expect(child.connected).toBe(false);
      expect(tracker.trackedCount).toBe(0);
    });
  });

  describe('Negative and Boundary Child Failure Scenarios', () => {
    test('reports a non-zero exit when a child worker crashes during a task', async () => {
      await withTemporaryChild(
        tracker,
        `
          if (process.send) process.send({ type: 'task_started' });
          setTimeout(() => process.exit(23), 100);
          setInterval(() => {}, 60_000);
        `,
        async (child) => {
          await expect(tracker.waitForMessage(child, 'task_started', 2000)).resolves.toMatchObject({
            type: 'task_started',
          });
          await expect(tracker.waitForMessage(child, 'task_complete', 2000)).rejects.toThrow(
            /exited early with code 23|already terminated \(code: 23/
          );

          expect(child.exitCode).toBe(23);
          const termination = await tracker.terminate(child, 1000);
          expect(termination.code).toBe(23);
          expect(tracker.trackedCount).toBe(0);
        }
      );
    });

    test('fails closed and reaps a child that exits on an unhandled promise rejection', async () => {
      await withTemporaryChild(
        tracker,
        `
          Promise.reject(new Error('unhandled child worker rejection'));
          setInterval(() => {}, 60_000);
        `,
        async (child) => {
          await expect(tracker.waitForMessage(child, 'task_complete', 3000)).rejects.toThrow();

          expect(child.exitCode).not.toBeNull();
          expect(child.exitCode).not.toBe(0);
          const termination = await tracker.terminate(child, 1000);
          expect(termination.code).not.toBe(0);
          expect(tracker.trackedCount).toBe(0);
        },
        ['--unhandled-rejections=strict']
      );
    });

    test('times out after the child disconnects its IPC socket mid-task', async () => {
      await withTemporaryChild(
        tracker,
        `
          if (process.send) process.send({ type: 'task_started' });
          setTimeout(() => process.disconnect(), 50);
          setInterval(() => {}, 60_000);
        `,
        async (child) => {
          await tracker.waitForMessage(child, 'task_started', 2000);
          await new Promise<void>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timed out waiting for IPC disconnect')), 2000);
            child.once('disconnect', () => {
              clearTimeout(timer);
              resolve();
            });
          });

          expect(child.connected).toBe(false);
          await expect(tracker.waitForMessage(child, 'task_complete', 75)).rejects.toThrow(
            /Timed out after 75ms waiting for message "task_complete"/
          );
          expect(child.listenerCount('message')).toBe(0);
          await tracker.terminate(child, 1000);
          expect(tracker.trackedCount).toBe(0);
        }
      );
    });

    test('escalates a missing child heartbeat to SIGKILL and confirms exit', async () => {
      await withTemporaryChild(
        tracker,
        `
          if (process.send) process.send({ type: 'ready' });
          setInterval(() => {}, 60_000);
        `,
        async (child) => {
          await tracker.waitForMessage(child, 'ready', 2000);
          const killSpy = jest.spyOn(child, 'kill');
          await expect(tracker.waitForMessage(child, 'heartbeat', 50)).rejects.toThrow(
            /Timed out after 50ms waiting for message "heartbeat"/
          );

          const termination = await tracker.terminate(child, 1000);
          expect(killSpy).toHaveBeenCalledWith('SIGKILL');
          expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
          expect(termination.code !== null || termination.signal !== null).toBe(true);
          expect(tracker.trackedCount).toBe(0);
        }
      );
    });

    test('does not forget a zombie candidate until exit is observed and reaped', async () => {
      const child = createMockChildProcess({
        pid: 99908,
        killed: true,
        exitCode: null,
        signalCode: null,
        onKill: () => true,
      });
      tracker.track(child as unknown as ChildProcess);

      expect(tracker.isConfirmedExited(child as unknown as ChildProcess)).toBe(false);
      const termination = tracker.terminate(child as unknown as ChildProcess, 1000);
      await new Promise((resolve) => setTimeout(resolve, 5));
      expect(tracker.hasChild(child as unknown as ChildProcess)).toBe(true);

      child.emitExit(0, 'SIGKILL');
      await expect(termination).resolves.toEqual({ code: 0, signal: 'SIGKILL' });
      expect(tracker.isConfirmedExited(child as unknown as ChildProcess)).toBe(true);
      expect(tracker.hasChild(child as unknown as ChildProcess)).toBe(false);
      expect(tracker.trackedCount).toBe(0);
    });
  });

  describe('Deterministic Fault-Injection Regression Tests (Wave 16, W16-A)', () => {
    test('rejects with diagnostics and retains child when kill() returns false and exit never occurs', async () => {
      const mockChild = createMockChildProcess({
        pid: 99901,
        onKill: () => false, // Signal could not be sent
      });
      tracker.track(mockChild as unknown as ChildProcess);
      expect(tracker.trackedCount).toBe(1);

      await expect(tracker.terminate(mockChild as unknown as ChildProcess, 200)).rejects.toThrow(
        /failed to confirm exit within 200ms/
      );

      // Crucial W16 invariant: child MUST be retained on unconfirmed exit
      expect(tracker.trackedCount).toBe(1);
      expect(tracker.hasChild(mockChild as unknown as ChildProcess)).toBe(true);
    });

    test('rejects with diagnostics and retains child when kill() throws an exception', async () => {
      const mockChild = createMockChildProcess({
        pid: 99902,
        onKill: () => {
          throw new Error('EPERM: operation not permitted');
        },
      });
      tracker.track(mockChild as unknown as ChildProcess);
      expect(tracker.trackedCount).toBe(1);

      await expect(tracker.terminate(mockChild as unknown as ChildProcess, 200)).rejects.toThrow(
        /EPERM: operation not permitted/
      );

      // Crucial W16 invariant: child MUST be retained on failure
      expect(tracker.trackedCount).toBe(1);
      expect(tracker.hasChild(mockChild as unknown as ChildProcess)).toBe(true);
    });

    test('times out and retains child when kill() succeeds but child refuses to emit exit', async () => {
      const mockChild = createMockChildProcess({
        pid: 99903,
        onKill: () => true, // Signal sent, but mock never emits 'exit'
      });
      tracker.track(mockChild as unknown as ChildProcess);
      expect(tracker.trackedCount).toBe(1);

      await expect(tracker.terminate(mockChild as unknown as ChildProcess, 200)).rejects.toThrow(
        /failed to confirm exit within 200ms/
      );

      // Crucial W16 invariant: child is still alive in tracker
      expect(tracker.trackedCount).toBe(1);
      expect(tracker.hasChild(mockChild as unknown as ChildProcess)).toBe(true);
    });

    test('does NOT treat already signaled process (child.killed === true) as dead if exitCode is null', async () => {
      const mockChild = createMockChildProcess({
        pid: 99904,
        killed: true, // Already marked killed, but NOT exited
        exitCode: null,
        signalCode: null,
        onKill: () => true,
      });
      tracker.track(mockChild as unknown as ChildProcess);

      let resolved = false;
      const termPromise = tracker.terminate(mockChild as unknown as ChildProcess, 1000).then((res) => {
        resolved = true;
        return res;
      });

      // Must NOT resolve synchronously just because child.killed is true!
      await new Promise((r) => setTimeout(r, 50));
      expect(resolved).toBe(false);
      expect(tracker.trackedCount).toBe(1);

      // Now emit the real exit event
      mockChild.emitExit(0, 'SIGKILL');

      const result = await termPromise;
      expect(resolved).toBe(true);
      expect(result.code).toBe(0);
      expect(tracker.trackedCount).toBe(0);
    });

    test('terminateAll aggregates errors and retains unconfirmed survivors without clearing tracker', async () => {
      // Child A: exits cleanly
      const childA = createMockChildProcess({
        pid: 99905,
        onKill: () => {
          queueMicrotask(() => {
            childA.emitExit(0, 'SIGKILL');
          });
          return true;
        },
      });

      // Child B: times out and never exits
      const childB = createMockChildProcess({
        pid: 99906,
        onKill: () => true, // Hangs
      });

      tracker.track(childA as unknown as ChildProcess);
      tracker.track(childB as unknown as ChildProcess);
      expect(tracker.trackedCount).toBe(2);

      const errors = await tracker.terminateAll(200);

      // Exactly 1 error for childB
      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toContain('failed to confirm exit');

      // Crucial W16 invariant: childA was removed, but childB survivor was RETAINED!
      expect(tracker.trackedCount).toBe(1);
      expect(tracker.hasChild(childB as unknown as ChildProcess)).toBe(true);
      expect(tracker.hasChild(childA as unknown as ChildProcess)).toBe(false);
    });

    test('deduplicates concurrent terminate() calls safely returning the same in-flight promise', async () => {
      let killCallCount = 0;
      const mockChild = createMockChildProcess({
        pid: 99907,
        onKill: () => {
          killCallCount += 1;
          setTimeout(() => {
            mockChild.emitExit(0, 'SIGKILL');
          }, 50);
          return true;
        },
      });
      tracker.track(mockChild as unknown as ChildProcess);

      const p1 = tracker.terminate(mockChild as unknown as ChildProcess, 1000);
      const p2 = tracker.terminate(mockChild as unknown as ChildProcess, 1000);

      expect(p1).toBe(p2); // Exact same promise returned

      const [res1, res2] = await Promise.all([p1, p2]);
      expect(res1.code).toBe(0);
      expect(res2.code).toBe(0);
      expect(killCallCount).toBe(1); // Kill signal was sent once, not duplicated
      expect(tracker.trackedCount).toBe(0);
    });
  });
});
