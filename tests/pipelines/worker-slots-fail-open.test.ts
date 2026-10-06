// tests/pipelines/worker-slots-fail-open.test.ts
// Failing-first regression for the legacy semaphore findings:
//   * WT-11  — the acquire Lua must refresh EXPIRE on EVERY successful acquire,
//              not only when the counter goes 0 -> 1, so a key with active
//              holders cannot silently expire mid-flight and re-admit past cap;
//   * F-P1-01 — a Redis failure must return a DISTINGUISHABLE fail-open result so
//              the worker's `finally` never releases (DECRs) a slot owned by
//              another holder; every fail-open must log a warn.
//
// RED until lib/queue/worker-slots.ts exposes the outcome contract and the
// rolling-EXPIRE script (this file is the pre-fix evidence run).

const mockEval = jest.fn();

jest.mock('../../lib/queue/redis', () => ({
  createRedisConnection: jest.fn(() => ({ eval: mockEval })),
}));

jest.mock('../../lib/logger', () => {
  const warn = jest.fn();
  return {
    Logger: jest.fn().mockImplementation(() => ({
      warn,
      info: jest.fn(),
      debug: jest.fn(),
      error: jest.fn(),
      child: jest.fn(),
    })),
    __warnMock: warn,
  };
});

import { releaseSlot, tryAcquireSlot } from '../../lib/queue/worker-slots';

const warnMock = (jest.requireMock('../../lib/logger') as { __warnMock: jest.Mock }).__warnMock;

describe('worker-slots fail-open safety (F-P1-01) + rolling TTL (WT-11)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEval.mockReset();
  });

  it('WT-11: refreshes EXPIRE on every successful acquire, not only on key creation', async () => {
    mockEval.mockResolvedValueOnce(1);
    await tryAcquireSlot('key-1', 'extract:invoice', 2, 60);

    const script = String(mockEval.mock.calls[0][0]);
    // The old script set the TTL only under `if cur == 1 then`.
    expect(script).not.toContain('if cur == 1 then');
    const capIdx = script.indexOf('if cur > tonumber');
    const expireIdx = script.indexOf("redis.call('EXPIRE'");
    expect(capIdx).toBeGreaterThanOrEqual(0);
    expect(expireIdx).toBeGreaterThan(capIdx);
  });

  it('F-P1-01: a Redis failure yields the distinguishable fail-open outcome and logs a warn', async () => {
    mockEval.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'));

    const outcome = await tryAcquireSlot('key-1', 'extract:invoice', 2, 60);

    expect(outcome).toBe('fail-open');
    expect(warnMock).toHaveBeenCalledTimes(1);
  });

  it('F-P1-01: a fail-open never releases (DECRs) a slot owned by another holder', async () => {
    mockEval.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'));

    const outcome = await tryAcquireSlot('key-1', 'extract:invoice', 2, 60);

    // Worker-style guard: only an OWNED acquisition may release.
    if ((outcome as unknown) === 'acquired') {
      await releaseSlot('key-1', 'extract:invoice');
    }

    // The release script is identified by its GET guard; the acquire script
    // (INCR/DECR rollback) must not be mistaken for a release.
    const releaseCalls = mockEval.mock.calls.filter((call) =>
      String(call[0]).includes("redis.call('GET'"),
    );
    expect(releaseCalls).toHaveLength(0);
  });

  it('positive control: a real acquisition DOES release exactly once', async () => {
    mockEval.mockResolvedValueOnce(1); // acquire reply
    const outcome = await tryAcquireSlot('key-1', 'extract:invoice', 2, 60);

    if (outcome === 'acquired') {
      mockEval.mockResolvedValueOnce(1); // guarded DECR reply
      await releaseSlot('key-1', 'extract:invoice');
    }

    expect(outcome).toBe('acquired');
    const releaseCalls = mockEval.mock.calls.filter((call) =>
      String(call[0]).includes("redis.call('GET'"),
    );
    expect(releaseCalls).toHaveLength(1);
  });

  it('F-P1-02: a hung EVAL is bounded and yields fail-open with a timeout warn', async () => {
    // maxRetriesPerRequest: null means an outage queues the command instead of
    // rejecting; the EVAL below never answers at all.
    mockEval.mockImplementationOnce(() => new Promise(() => undefined));

    const startedAt = Date.now();
    const outcome = await tryAcquireSlot('key-1', 'extract:invoice', 2, 60, 25);
    const elapsed = Date.now() - startedAt;

    expect(outcome).toBe('fail-open');
    expect(elapsed).toBeLessThan(1000); // bounded by the timeout, not the hang
    expect(warnMock).toHaveBeenCalledTimes(1);
    expect(String(warnMock.mock.calls[0][0])).toContain('timed out');
  });

  it('F-P1-02: an EVAL answering within the bound is unaffected', async () => {
    mockEval.mockImplementationOnce(
      () => new Promise((resolve) => setTimeout(() => resolve(1), 10)),
    );

    await expect(tryAcquireSlot('key-1', 'extract:invoice', 2, 60, 500)).resolves.toBe('acquired');
    expect(warnMock).not.toHaveBeenCalled();
  });

  it('F-P1-02: a late EVAL answer after the timeout cannot change the fail-open outcome', async () => {
    let resolveLate: (value: number) => void = () => undefined;
    mockEval.mockImplementationOnce(
      () => new Promise<number>((resolve) => {
        resolveLate = resolve;
      }),
    );

    const outcome = await tryAcquireSlot('key-1', 'extract:invoice', 2, 60, 20);
    expect(outcome).toBe('fail-open');

    // The stalled Redis finally answers: the settled outcome stays fail-open,
    // no second warn, and no unhandled rejection escapes the race.
    resolveLate(1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(warnMock).toHaveBeenCalledTimes(1);
  });
});
