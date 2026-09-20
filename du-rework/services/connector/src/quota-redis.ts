import { randomUUID } from 'node:crypto';
import type { QuotaLease, QuotaStore } from './types';

export interface RedisEvalClient {
  eval(script: string, keyCount: number, ...arguments_: string[]): Promise<unknown>;
}

const acquireScript = `
local key = KEYS[1]
local now = tonumber(ARGV[1])
local expiry = tonumber(ARGV[2])
local max = tonumber(ARGV[3])
redis.call('ZREMRANGEBYSCORE', key, '-inf', now)
if redis.call('ZCARD', key) >= max then return false end
redis.call('ZADD', key, expiry, ARGV[4])
redis.call('PEXPIRE', key, expiry - now)
return ARGV[4]
`;

const releaseScript = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then redis.call('DEL', KEYS[1]) end
return 1
`;

export class RedisQuotaStore implements QuotaStore {
  public constructor(
    private readonly redis: RedisEvalClient,
    private readonly prefix = 'connector:quota:',
  ) {}

  public async acquire(
    key: string,
    now: number,
    leaseMs: number,
    maxInFlight: number,
  ): Promise<QuotaLease | undefined> {
    if (!Number.isInteger(maxInFlight) || maxInFlight < 1) return undefined;
    const leaseId = randomUUID();
    const expiresAt = now + leaseMs;
    const result = await this.redis.eval(
      acquireScript,
      1,
      `${this.prefix}${key}`,
      String(now),
      String(expiresAt),
      String(maxInFlight),
      leaseId,
    );
    return result === leaseId ? { leaseId, key, expiresAt } : undefined;
  }

  public async release(lease: QuotaLease): Promise<void> {
    await this.redis.eval(releaseScript, 1, `${this.prefix}${lease.key}`, lease.leaseId);
  }
}
