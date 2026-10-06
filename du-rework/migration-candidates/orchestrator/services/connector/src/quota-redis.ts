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
local latest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
redis.call('PEXPIRE', key, math.max(1, tonumber(latest[2]) - now))
return ARGV[4]
`;

const releaseScript = `
redis.call('ZREM', KEYS[1], ARGV[1])
if redis.call('ZCARD', KEYS[1]) == 0 then
  redis.call('DEL', KEYS[1])
else
  local now = tonumber(ARGV[2])
  local latest = redis.call('ZREVRANGE', KEYS[1], 0, 0, 'WITHSCORES')
  redis.call('PEXPIRE', KEYS[1], math.max(1, tonumber(latest[2]) - now))
end
return 1
`;

const renewScript = `
local key = KEYS[1]
local leaseId = ARGV[1]
local now = tonumber(ARGV[2])
local expiry = tonumber(ARGV[3])
local current = redis.call('ZSCORE', key, leaseId)
if not current or tonumber(current) <= now or expiry <= now then return false end
redis.call('ZADD', key, expiry, leaseId)
local latest = redis.call('ZREVRANGE', key, 0, 0, 'WITHSCORES')
redis.call('PEXPIRE', key, math.max(1, tonumber(latest[2]) - now))
return expiry
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
    await this.redis.eval(releaseScript, 1, `${this.prefix}${lease.key}`, lease.leaseId, String(Date.now()));
  }

  public async renew(lease: QuotaLease, now: number, leaseMs: number): Promise<QuotaLease | undefined> {
    if (!Number.isFinite(now) || !Number.isFinite(leaseMs) || leaseMs <= 0) return undefined;
    const expiresAt = now + leaseMs;
    const result = await this.redis.eval(
      renewScript,
      1,
      `${this.prefix}${lease.key}`,
      lease.leaseId,
      String(now),
      String(expiresAt),
    );
    return Number(result) === expiresAt ? { ...lease, expiresAt } : undefined;
  }
}
