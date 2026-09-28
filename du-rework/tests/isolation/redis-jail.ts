import { randomUUID } from 'node:crypto';

/**
 * Isolated In-Memory Redis Client (P1-05)
 *
 * Implements prefix-isolated Redis evaluation and key-value operations.
 * Guarantees that clients with different prefixes operate in complete isolation,
 * proving that per-run prefixing prevents concurrency contention.
 */

export interface SortedSetEntry {
  score: number;
  member: string;
}

export class IsolatedRedisJail {
  // Shared underlying physical memory partition across all clients
  private static readonly globalStore = new Map<string, string>();
  private static readonly globalSets = new Map<string, Set<string>>();
  private static readonly globalSortedSets = new Map<string, Map<string, number>>();

  public constructor(public readonly prefix: string) {}

  public static clearAll(): void {
    IsolatedRedisJail.globalStore.clear();
    IsolatedRedisJail.globalSets.clear();
    IsolatedRedisJail.globalSortedSets.clear();
  }

  private qualify(key: string): string {
    return key.startsWith(this.prefix) ? key : `${this.prefix}${key}`;
  }

  public async get(key: string): Promise<string | null> {
    return IsolatedRedisJail.globalStore.get(this.qualify(key)) ?? null;
  }

  public async set(key: string, value: string, _mode?: string, _duration?: number): Promise<'OK'> {
    IsolatedRedisJail.globalStore.set(this.qualify(key), value);
    return 'OK';
  }

  public async del(...keys: string[]): Promise<number> {
    let count = 0;
    for (const key of keys) {
      const qk = this.qualify(key);
      if (IsolatedRedisJail.globalStore.delete(qk)) count++;
      if (IsolatedRedisJail.globalSets.delete(qk)) count++;
      if (IsolatedRedisJail.globalSortedSets.delete(qk)) count++;
    }
    return count;
  }

  public async exists(key: string): Promise<number> {
    const qk = this.qualify(key);
    return IsolatedRedisJail.globalStore.has(qk) ||
      IsolatedRedisJail.globalSets.has(qk) ||
      IsolatedRedisJail.globalSortedSets.has(qk) ? 1 : 0;
  }

  public async keys(pattern = '*'): Promise<string[]> {
    const results: string[] = [];
    const prefixLen = this.prefix.length;

    const check = (k: string) => {
      if (k.startsWith(this.prefix)) {
        const unqualified = k.slice(prefixLen);
        if (pattern === '*' || unqualified.includes(pattern.replace(/\*/g, ''))) {
          results.push(unqualified);
        }
      }
    };

    for (const k of IsolatedRedisJail.globalStore.keys()) check(k);
    for (const k of IsolatedRedisJail.globalSets.keys()) check(k);
    for (const k of IsolatedRedisJail.globalSortedSets.keys()) check(k);

    return results;
  }

  /**
   * Drops ONLY keys matching this jail's prefix, leaving all other clients' keys untouched.
   */
  public async flushNamespace(): Promise<number> {
    let removed = 0;
    const toDelete: string[] = [];

    for (const k of IsolatedRedisJail.globalStore.keys()) {
      if (k.startsWith(this.prefix)) toDelete.push(k);
    }
    for (const k of IsolatedRedisJail.globalSets.keys()) {
      if (k.startsWith(this.prefix)) toDelete.push(k);
    }
    for (const k of IsolatedRedisJail.globalSortedSets.keys()) {
      if (k.startsWith(this.prefix)) toDelete.push(k);
    }

    for (const k of toDelete) {
      if (IsolatedRedisJail.globalStore.delete(k)) removed++;
      if (IsolatedRedisJail.globalSets.delete(k)) removed++;
      if (IsolatedRedisJail.globalSortedSets.delete(k)) removed++;
    }

    return removed;
  }

  /**
   * Redis eval compatibility for Lua scripts (e.g. connector quota scripts).
   */
  public async eval(script: string, keyCount: number, ...args: string[]): Promise<unknown> {
    const keys = args.slice(0, keyCount).map((k) => this.qualify(k));
    const scriptArgs = args.slice(keyCount);

    // Concurrency / Quota acquire script simulation
    if (script.includes('ZREMRANGEBYSCORE') && script.includes('ZCARD')) {
      const key = keys[0]!;
      const now = Number(scriptArgs[0]);
      const expiry = Number(scriptArgs[1]);
      const max = Number(scriptArgs[2]);
      const leaseId = scriptArgs[3] ?? randomUUID();

      let zset = IsolatedRedisJail.globalSortedSets.get(key);
      if (!zset) {
        zset = new Map<string, number>();
        IsolatedRedisJail.globalSortedSets.set(key, zset);
      }

      // Evict expired
      for (const [member, score] of zset.entries()) {
        if (score <= now) zset.delete(member);
      }

      if (zset.size >= max) {
        return false;
      }

      zset.set(leaseId, expiry);
      return leaseId;
    }

    // Concurrency / Quota release script simulation
    if (script.includes('ZREM') && script.includes('ZCARD')) {
      const key = keys[0]!;
      const leaseId = scriptArgs[0]!;
      const zset = IsolatedRedisJail.globalSortedSets.get(key);
      if (zset) {
        zset.delete(leaseId);
        if (zset.size === 0) {
          IsolatedRedisJail.globalSortedSets.delete(key);
        }
      }
      return 1;
    }

    throw new Error(`Unsupported Redis Lua script in test isolation jail: ${script.slice(0, 40)}...`);
  }
}
