import type { RedisSessionGateway } from '../../src/modules/auth/redis-session-repository';

/**
 * In-process Redis stand-in for the SESSION repository suites ONLY
 * (never the DB/Redis window). Mirrors the four semantics the
 * repository depends on: key TTL with lazy expiry, DEL counting
 * existing keys, SETADD without TTL until EXPIRE, and typed keys
 * sharing one keyspace. Tests drive a FAKE clock so TTL math is exact.
 */
export class FakeRedisSessionGateway implements RedisSessionGateway {
  private strings = new Map<string, { value: string; expiresAt: number }>();
  private sets = new Map<string, { members: Set<string>; expiresAt: number }>();
  closed = false;
  calls = 0;
  private readonly clock: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.clock = now;
  }

  /** TEST-ONLY raw write to exercise hostile payloads. */
  putRaw(key: string, value: string, ttlSeconds = 3600): void {
    this.strings.set(key, { value, expiresAt: this.clock() + ttlSeconds * 1000 });
  }

  ttlSeconds(key: string): number | null {
    const s = this.strings.get(key) ?? this.sets.get(key);
    if (!s) return null;
    if (s.expiresAt === Number.POSITIVE_INFINITY) return -1; // no TTL
    const left = (s.expiresAt - this.clock()) / 1000;
    return left > 0 ? Math.ceil(left) : null;
  }

  members(key: string): string[] {
    const e = this.sets.get(key);
    if (!e || e.expiresAt <= this.clock()) return [];
    return [...e.members];
  }

  /** Full keyspace introspection (tests prove plaintext secrets NEVER ride
   *  in key names). */
  allKeys(): string[] {
    return [...this.strings.keys(), ...this.sets.keys()];
  }

  async get(key: string): Promise<string | null> {
    this.calls += 1;
    const e = this.strings.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.clock()) {
      this.strings.delete(key);
      return null;
    }
    return e.value;
  }

  async set(key: string, value: string, ttlSeconds: number): Promise<void> {
    this.calls += 1;
    this.sets.delete(key);
    this.strings.set(key, { value, expiresAt: this.clock() + ttlSeconds * 1000 });
  }

  async del(...keys: string[]): Promise<number> {
    this.calls += 1;
    let n = 0;
    for (const key of keys) {
      const s = this.strings.get(key);
      if (s) {
        this.strings.delete(key);
        if (s.expiresAt > this.clock()) n += 1;
        else n += 1; // real Redis DEL counts logically-expired keys it purges
      }
      if (this.sets.delete(key)) n += 1;
    }
    return n;
  }

  async sadd(key: string, member: string): Promise<void> {
    this.calls += 1;
    const e = this.sets.get(key) ?? { members: new Set<string>(), expiresAt: Number.POSITIVE_INFINITY };
    e.members.add(member);
    this.sets.set(key, e);
  }

  async srem(key: string, member: string): Promise<void> {
    this.calls += 1;
    this.sets.get(key)?.members.delete(member);
  }

  async smembers(key: string): Promise<string[]> {
    this.calls += 1;
    return this.members(key);
  }

  async expire(key: string, ttlSeconds: number): Promise<void> {
    this.calls += 1;
    const e = this.sets.get(key) ?? this.strings.get(key);
    if (!e) return;
    e.expiresAt = this.clock() + ttlSeconds * 1000;
  }

  /** Atomic GETDEL: read-if-live + remove, with NO await between — a
   *  faithful stand-in for the single-command Redis GETDEL. */
  async getdel(key: string): Promise<string | null> {
    this.calls += 1;
    const e = this.strings.get(key);
    if (!e) return null;
    this.strings.delete(key);
    return e.expiresAt > this.clock() ? e.value : null;
  }

  async close(): Promise<void> {
    this.closed = true;
  }
}
