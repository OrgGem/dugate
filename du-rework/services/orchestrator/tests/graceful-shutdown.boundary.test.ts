/**
 * PR-Q3-11 offline functional proof for the packaged graceful-shutdown core
 * (src/shutdown.ts) — the contract main.ts installs on the real process.
 * These tests emit REAL process signals through process.emit so the listener
 * wiring itself is exercised; close()/exit() are injected fakes, so nothing
 * ever closes a DB or kills the jest worker. No PostgreSQL :5433, no Redis
 * :6380, no live infra.
 *
 * Run: pnpm --dir services/orchestrator exec jest tests/graceful-shutdown.boundary.test.ts --runInBand
 */
import { installGracefulShutdown, type GracefulShutdownHandle } from '../src/shutdown';

const handles: GracefulShutdownHandle[] = [];

function install(o: Parameters<typeof installGracefulShutdown>[0]): GracefulShutdownHandle {
  const h = installGracefulShutdown(o);
  handles.push(h);
  return h;
}

afterEach(() => {
  while (handles.length > 0) handles.pop()!.dispose();
});

const tick = (ms = 30): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe('P8-04/PR-Q3-11 - graceful shutdown contract (entry semantics)', () => {
  it('[LOCK] first SIGTERM closes exactly once and exits 0 after close resolves', async () => {
    let closes = 0;
    const exits: number[] = [];
    install({
      close: async () => {
        closes++;
        await tick(20);
      },
      exit: (code) => exits.push(code),
    });
    process.emit('SIGTERM');
    await tick(90);
    expect(closes).toBe(1);
    expect(exits).toEqual([0]);
  });

  it('[LOCK] second signal DURING close forces exit(1); close never called twice', async () => {
    let closes = 0;
    const exits: number[] = [];
    let finish: () => void = () => undefined;
    install({
      close: () => {
        closes++;
        return new Promise<void>((resolve) => {
          finish = resolve;
        });
      },
      exit: (code) => exits.push(code),
      timeoutMs: 10_000,
    });
    process.emit('SIGTERM');
    await tick(10);
    process.emit('SIGINT'); // operator insists
    expect(exits).toEqual([1]); // immediate force, nonzero
    expect(closes).toBe(1);
    finish(); // the original close still settles — no second exit(0) may land
    await tick(40);
    expect(exits).toEqual([1]);
  });

  it('[LOCK] hung close hits the hard budget: exit(1) within timeoutMs, never forever', async () => {
    const exits: number[] = [];
    install({
      close: () => new Promise<never>(() => undefined), // never settles on purpose
      exit: (code) => exits.push(code),
      timeoutMs: 60,
    });
    const t0 = Date.now();
    process.emit('SIGTERM');
    for (let w = 0; w < 2000 && exits.length === 0; w += 10) await tick(10);
    expect(exits).toEqual([1]);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(55); // waited the budget, not abandoned early
    expect(Date.now() - t0).toBeLessThan(2000); // and the wait is BOUNDED
  });

  it('[LOCK] close rejection exits 1; signals after settle are no-ops', async () => {
    const exits: number[] = [];
    install({
      close: async () => {
        throw new Error('pg pool close failed');
      },
      exit: (code) => exits.push(code),
    });
    process.emit('SIGINT');
    await tick(40);
    expect(exits).toEqual([1]);
    process.emit('SIGTERM'); // post-settle: must not resurrect or re-exit
    await tick(20);
    expect(exits).toEqual([1]);
  });

  it('[LOCK] install uses both SIGTERM+SIGINT and dispose uninstalls cleanly', () => {
    const before = { term: process.listenerCount('SIGTERM'), int: process.listenerCount('SIGINT') };
    const h = install({ close: async () => undefined, exit: () => undefined });
    expect(process.listenerCount('SIGTERM')).toBe(before.term + 1);
    expect(process.listenerCount('SIGINT')).toBe(before.int + 1);
    h.dispose();
    expect(process.listenerCount('SIGTERM')).toBe(before.term);
    expect(process.listenerCount('SIGINT')).toBe(before.int);
    expect(h.phase()).toBe('idle'); // never signaled while installed-and-released
  });
});