// lib/queue/worker-slots.ts
// Redis-backed per-(apiKey, endpoint) concurrency semaphore for the worker.
//
// Design: one atomic Lua EVAL per operation so two workers racing for the same
// key cannot both slip through:
//   * acquire — INCR, refuse + rollback above the cap, then refresh the TTL on
//     EVERY successful acquire (WT-11). A key with active holders must not
//     silently expire mid-flight and then re-admit past the cap; EXPIRE is the
//     crash-reclaim horizon, refreshed while the key is used.
//   * release — guarded GET-then-DECR so the counter can never go below 0.
//
// Failure contract (F-P1-01): a Redis error returns the DISTINGUISHABLE
// `'fail-open'` outcome. The caller runs the job without a slot and MUST NOT
// release it — releasing a slot the caller never acquired would DECR another
// holder's counter and over-admit that key. Every fail-open and every failed
// release logs a warn through lib/logger.ts (errors are never swallowed).
//
// Resilience contract (F-P1-02): the dedicated connection uses
// `maxRetriesPerRequest: null`, so a Redis outage/hang makes the acquire EVAL
// wait instead of rejecting. Acquire is therefore BOUNDED: after
// `ACQUIRE_TIMEOUT_MS` (override per call) the attempt fails open and logs a
// warn, so a worker can never hang forever on a stalled semaphore. Any slot a
// late EVAL still takes is reclaimed by the TTL, exactly like the F-P1-01
// error path.
//
// Only call this for top-level pipeline jobs. Workflow sub-step jobs
// (queue "workflow-steps") must SKIP the semaphore — a parent holding a slot
// while waiting for its children would deadlock against the same cap.

import type IORedis from 'ioredis';
import { createRedisConnection } from './redis';
import { Logger } from '../logger';

const logger = new Logger({ service: 'worker-slots' });

// Dedicated connection: BullMQ docs forbid sharing one connection between a
// Worker and ad-hoc commands (blocking client risk). Lazy-connect is safe.
let redis: IORedis | null = null;

function getRedis(): IORedis {
  if (!redis) redis = createRedisConnection();
  return redis;
}

export type SlotAcquireOutcome =
  /** Slot acquired; the caller MUST release it in a finally block. */
  | 'acquired'
  /** Cap reached; the caller should re-delay the job (no attempt consumed). */
  | 'contended'
  /** Redis unavailable; run WITHOUT a slot and NEVER release it (F-P1-01). */
  | 'fail-open';

/**
 * F-P1-02: how long one acquire may wait before it fails open. The Redis
 * connection is created with `maxRetriesPerRequest: null` (BullMQ requirement),
 * so during an outage the EVAL can queue indefinitely; this bound keeps the
 * worker responsive. Override per call for tests/tuning.
 */
export const ACQUIRE_TIMEOUT_MS = 1500;

/** Internal marker so a timeout is distinguishable from a Redis error. */
class SlotAcquireTimeoutError extends Error {
  constructor(timeoutMs: number) {
    super(`worker-slot acquire did not answer within ${timeoutMs}ms`);
    this.name = 'SlotAcquireTimeoutError';
  }
}

/**
 * Race one Redis operation against a bounded timer. The timer is always
 * cleared, so a resolved operation leaves no open handle. A losing operation
 * that settles later is already observed by `Promise.race` (no unhandled
 * rejection), and any late side effect it caused is covered by the TTL.
 */
function withAcquireTimeout<T>(operation: Promise<T>, timeoutMs: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new SlotAcquireTimeoutError(timeoutMs)), timeoutMs);
  });
  return Promise.race([operation, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

// WT-11: EXPIRE runs after the cap check on every successful acquire, not only
// when the counter goes 0 -> 1. Over-cap increments are rolled back so a
// refused attempt leaks no slot and leaves the existing TTL untouched.
const ACQUIRE_LUA = `
local cur = redis.call('INCR', KEYS[1])
if cur > tonumber(ARGV[1]) then
  redis.call('DECR', KEYS[1])
  return 0
end
redis.call('EXPIRE', KEYS[1], ARGV[2])
return 1
`;

/**
 * Try to acquire one execution slot for (apiKeyId, endpointSlug).
 * @returns `'acquired'` (release in finally), `'contended'` (re-delay the job),
 *          or `'fail-open'` (run without a slot; NEVER release).
 * @param timeoutMs F-P1-02 bound on the Redis round-trip (default 1500 ms).
 */
export async function tryAcquireSlot(
  apiKeyId: string,
  endpointSlug: string,
  cap: number,
  ttlSec: number,
  timeoutMs: number = ACQUIRE_TIMEOUT_MS,
): Promise<SlotAcquireOutcome> {
  try {
    const result = await withAcquireTimeout(
      getRedis().eval(
        ACQUIRE_LUA,
        1,
        `workerslots:${apiKeyId}:${endpointSlug}`,
        String(cap),
        String(ttlSec),
      ),
      timeoutMs,
    );
    if (result === 1) return 'acquired';
    if (result === 0) return 'contended';
    // The script only ever returns 0/1; anything else is an anomaly. Never
    // assume ownership on an unknown reply, and surface it.
    logger.warn('worker-slot acquire returned an unexpected reply — treating as contended', {
      apiKeyId,
      endpointSlug,
      cap,
      reply: String(result),
    });
    return 'contended';
  } catch (error) {
    if (error instanceof SlotAcquireTimeoutError) {
      // F-P1-02: Redis hung past the bound. Fail open like any other outage;
      // the caller must not release, and the TTL reclaims a slot the delayed
      // EVAL may still have taken.
      logger.warn(
        'worker-slot acquire timed out (Redis hang) — running without a slot; caller must NOT release',
        { apiKeyId, endpointSlug, cap, timeoutMs },
      );
      return 'fail-open';
    }
    logger.warn(
      'worker-slot acquire failed open (Redis error) — running without a slot; caller must NOT release',
      { apiKeyId, endpointSlug, cap },
      error,
    );
    return 'fail-open';
  }
}

/** Release a previously acquired slot. Never throws. */
export async function releaseSlot(apiKeyId: string, endpointSlug: string): Promise<void> {
  try {
    const key = `workerslots:${apiKeyId}:${endpointSlug}`;
    const lua = `
      local cur = redis.call('GET', KEYS[1])
      if cur and tonumber(cur) > 0 then
        return redis.call('DECR', KEYS[1])
      end
      return 0
    `;
    await getRedis().eval(lua, 1, key);
  } catch (error) {
    // Best-effort: the TTL will reclaim the slot. Log instead of swallowing.
    logger.warn('worker-slot release failed (Redis error) — slot will be reclaimed by the TTL', {
      apiKeyId,
      endpointSlug,
    }, error);
  }
}
