// tests/pipelines/worker-slots.test.ts
// P3 independent verification — Redis-backed per-(apiKey, endpoint) semaphore.
//
// Scope: unit only (no real Redis, no BullMQ). The two IORedis scripts are
// exercised through a mocked `lib/queue/redis` boundary. The Lua text itself is
// pinned by content assertions so a future edit cannot silently drop the
// properties this module promises:
//   * acquire: INCR + cap check + TTL refresh + DECR rollback, atomic in one EVAL;
//   * release: guarded DECR that can never drive the counter below 0;
//   * Redis failure: acquire fails OPEN with the distinguishable 'fail-open'
//     outcome (the caller must never release it); release never throws.
//
// The module-level connection is a lazy singleton; `createRedisConnection`
// must be called exactly once and reused (BullMQ forbids sharing blocking
// connections, so this is a dedicated connection).

let mockConnectionCreateCount = 0;

const mockEval = jest.fn();

jest.mock('../../lib/queue/redis', () => ({
  createRedisConnection: jest.fn(() => {
    mockConnectionCreateCount += 1;
    return { eval: mockEval };
  }),
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

describe('worker-slots semaphore (unit)', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEval.mockReset();
  });

  describe('tryAcquireSlot', () => {
    it('returns true when the atomic acquire script reports the slot was taken (1)', async () => {
      mockEval.mockResolvedValueOnce(1);

      await expect(tryAcquireSlot('key-1', 'extract:invoice', 2, 60)).resolves.toBe('acquired');

      expect(mockEval).toHaveBeenCalledTimes(1);
      const [script, numKeys, key, capArg, ttlArg] = mockEval.mock.calls[0];
      expect(script).toEqual(expect.stringContaining('INCR'));
      expect(numKeys).toBe(1);
      expect(key).toBe('workerslots:key-1:extract:invoice');
      expect(capArg).toBe('2');
      expect(ttlArg).toBe('60');
    });

    it('returns false when the cap is exceeded (script rolls back and returns 0)', async () => {
      mockEval.mockResolvedValueOnce(0);

      await expect(tryAcquireSlot('key-1', 'extract:invoice', 2, 60)).resolves.toBe('contended');
    });

    it('is strict: only an integer 1 counts as acquired', async () => {
      mockEval.mockResolvedValueOnce(2);
      await expect(tryAcquireSlot('key-1', 'e', 5, 5)).resolves.toBe('contended');

      mockEval.mockResolvedValueOnce('1');
      await expect(tryAcquireSlot('key-1', 'e', 5, 5)).resolves.toBe('contended');
    });

    it('fails open (true) when Redis throws — availability beats strictness', async () => {
      mockEval.mockRejectedValueOnce(new Error('ECONNREFUSED 127.0.0.1:6379'));

      await expect(tryAcquireSlot('key-1', 'extract:invoice', 2, 60)).resolves.toBe('fail-open');
      expect(warnMock).toHaveBeenCalledTimes(1);
    });

    it('fails open on non-Error rejections too', async () => {
      mockEval.mockRejectedValueOnce('redis down');

      await expect(tryAcquireSlot('key-1', 'extract:invoice', 2, 60)).resolves.toBe('fail-open');
      expect(warnMock).toHaveBeenCalledTimes(1);
    });

    it('ignores the previous failure and uses the real result on the next call', async () => {
      mockEval.mockRejectedValueOnce(new Error('transient'));
      await expect(tryAcquireSlot('key-1', 'e', 1, 30)).resolves.toBe('fail-open');

      mockEval.mockResolvedValueOnce(0);
      await expect(tryAcquireSlot('key-1', 'e', 1, 30)).resolves.toBe('contended');
    });

    it('uses independent keys per apiKeyId and per endpointSlug', async () => {
      mockEval.mockResolvedValue(1);
      await tryAcquireSlot('key-a', 'extract:invoice', 1, 30);
      await tryAcquireSlot('key-a', 'extract:receipt', 1, 30);
      await tryAcquireSlot('key-b', 'extract:invoice', 1, 30);

      const keys = mockEval.mock.calls.map((call) => call[2]);
      expect(keys).toEqual([
        'workerslots:key-a:extract:invoice',
        'workerslots:key-a:extract:receipt',
        'workerslots:key-b:extract:invoice',
      ]);
    });
  });

  describe('acquire script contract (Lua text)', () => {
    it('increments, refreshes the TTL after every successful acquire, rolls back over-cap increments, and returns only 0/1', async () => {
      mockEval.mockResolvedValue(1);
      await tryAcquireSlot('k', 'e', 2, 60);

      const script = mockEval.mock.calls[0][0] as string;
      // Atomic cap check inside one EVAL: no read-modify-write race.
      expect(script).toContain("redis.call('INCR', KEYS[1])");
      // WT-11: the TTL is refreshed on EVERY successful acquire — never only on
      // key creation, which could let an active key expire mid-flight.
      expect(script).not.toContain('if cur == 1 then');
      expect(script).toContain("redis.call('EXPIRE', KEYS[1], ARGV[2])");
      expect(script.indexOf("redis.call('EXPIRE'")).toBeGreaterThan(
        script.indexOf('if cur > tonumber'),
      );
      // Over-cap increments are rolled back so a refused attempt leaks no slot.
      expect(script).toContain('if cur > tonumber(ARGV[1]) then');
      expect(script).toContain("redis.call('DECR', KEYS[1])");
      expect(script).toContain('return 0');
      expect(script).toContain('return 1');
    });
  });

  describe('releaseSlot', () => {
    it('runs the guarded DECR on the same key (never below 0)', async () => {
      mockEval.mockResolvedValueOnce(1);

      await expect(releaseSlot('key-1', 'extract:invoice')).resolves.toBeUndefined();

      expect(mockEval).toHaveBeenCalledTimes(1);
      const [script, numKeys, key] = mockEval.mock.calls[0];
      expect(numKeys).toBe(1);
      expect(key).toBe('workerslots:key-1:extract:invoice');
      // Guard: only DECR when the key exists AND is positive.
      expect(script).toContain("redis.call('GET', KEYS[1])");
      expect(script).toContain('tonumber(cur) > 0');
      expect(script).toContain("redis.call('DECR', KEYS[1])");
      expect(script).toContain('return 0');
      // No ARGV for release.
      expect(mockEval.mock.calls[0]).toHaveLength(3);
    });

    it('resolves when the key already expired (script returns 0)', async () => {
      mockEval.mockResolvedValueOnce(0);

      await expect(releaseSlot('key-1', 'extract:invoice')).resolves.toBeUndefined();
    });

    it('never throws when Redis rejects (logs a warn instead)', async () => {
      mockEval.mockRejectedValueOnce(new Error('connection closed'));

      await expect(releaseSlot('key-1', 'extract:invoice')).resolves.toBeUndefined();
      expect(warnMock).toHaveBeenCalledTimes(1);
    });

    it('never throws on non-Error rejections (logs a warn instead)', async () => {
      mockEval.mockRejectedValueOnce({ weird: true });

      await expect(releaseSlot('key-2', 'e')).resolves.toBeUndefined();
      expect(warnMock).toHaveBeenCalledTimes(1);
    });
  });

  describe('connection lifecycle', () => {
    it('creates exactly one dedicated connection and reuses it across calls', async () => {
      mockEval.mockResolvedValue(1);
      const before = mockConnectionCreateCount;

      let fresh: typeof import('../../lib/queue/worker-slots') | undefined;
      jest.isolateModules(() => {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        fresh = require('../../lib/queue/worker-slots');
      });

      await fresh!.tryAcquireSlot('life', 'e', 1, 30);
      await fresh!.tryAcquireSlot('life', 'e', 1, 30);
      await fresh!.releaseSlot('life', 'e');

      expect(mockConnectionCreateCount - before).toBe(1);
      expect(mockEval).toHaveBeenCalledTimes(3);
    });
  });
});
