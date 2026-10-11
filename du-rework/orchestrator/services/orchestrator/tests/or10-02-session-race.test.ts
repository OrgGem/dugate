import {
  createMemorySessionRepository,
  createSessionStore,
  type SessionRecord,
} from '../src/modules/auth/session-store';
import type { SessionRepository } from '../src/modules/auth/session-repository';
import {
  createRedisSessionRepository,
  type RedisSessionGateway,
} from '../src/modules/auth/redis-session-repository';

const T0 = Date.UTC(2026, 9, 10, 4, 0, 0);
const IDENTITY = { issuer: 'https://idp.test/realm', sub: 'operator-1', tenantId: 'tenant-1', role: 'operator' } as const;

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function sameGeneration(current: SessionRecord, expected: SessionRecord): boolean {
  return current.sessionId === expected.sessionId &&
    current.issuer === expected.issuer &&
    current.sub === expected.sub &&
    current.tenantId === expected.tenantId &&
    current.role === expected.role &&
    current.csrfToken === expected.csrfToken &&
    current.createdAt === expected.createdAt &&
    current.expiresAt === expected.expiresAt;
}

function makeStore(repo: SessionRepository) {
  return createSessionStore({
    repo,
    now: () => T0 + 1_000,
    absoluteTtlMs: 60 * 60_000,
    idleTtlMs: 10 * 60_000,
  });
}

function controlledMemoryRepository() {
  const base = createMemorySessionRepository();
  let nextPause: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;
  const repo: SessionRepository & { size(): number } = {
    get: (id) => base.get(id),
    set: (session) => base.set(session),
    delete: (id) => base.delete(id),
    revokePrincipal: (issuer, sub) => base.revokePrincipal!(issuer, sub),
    touchIfExists: async (expected, lastSeenAt) => {
      const pause = nextPause;
      if (pause) {
        nextPause = null;
        pause.started.resolve();
        await pause.release.promise;
      }
      return base.touchIfExists!(expected, lastSeenAt);
    },
    size: () => base.size(),
  };
  return {
    repo,
    base,
    pauseNextTouch() {
      const pause = { started: deferred(), release: deferred() };
      nextPause = pause;
      return pause;
    },
  };
}

class AtomicMemoryRedis implements RedisSessionGateway {
  private readonly strings = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();
  private nextTouchPause: { started: ReturnType<typeof deferred>; release: ReturnType<typeof deferred> } | null = null;

  pauseNextTouch() {
    const pause = { started: deferred(), release: deferred() };
    this.nextTouchPause = pause;
    return pause;
  }

  async get(key: string): Promise<string | null> {
    return this.strings.get(key) ?? null;
  }

  async set(key: string, value: string, _ttlSeconds: number): Promise<void> {
    this.strings.set(key, value);
  }

  async touchSession(
    key: string,
    principalIndexKey: string,
    expected: SessionRecord,
    lastSeenAt: number,
    _ttlSeconds: number,
  ): Promise<string | null> {
    const pause = this.nextTouchPause;
    if (pause) {
      this.nextTouchPause = null;
      pause.started.resolve();
      await pause.release.promise;
    }
    const raw = this.strings.get(key);
    if (raw === undefined) return null;
    const current = JSON.parse(raw) as SessionRecord;
    if (!sameGeneration(current, expected)) return null;
    current.lastSeenAt = Math.max(current.lastSeenAt, lastSeenAt);
    const updated = JSON.stringify(current);
    this.strings.set(key, updated);
    const members = this.sets.get(principalIndexKey) ?? new Set<string>();
    members.add(current.sessionId);
    this.sets.set(principalIndexKey, members);
    return updated;
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.strings.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
    }
    return removed;
  }

  async sadd(key: string, member: string): Promise<void> {
    const members = this.sets.get(key) ?? new Set<string>();
    members.add(member);
    this.sets.set(key, members);
  }

  async srem(key: string, member: string): Promise<void> {
    this.sets.get(key)?.delete(member);
  }

  async smembers(key: string): Promise<string[]> {
    return [...(this.sets.get(key) ?? [])];
  }

  async expire(_key: string, _ttlSeconds: number): Promise<void> {}

  async getdel(key: string): Promise<string | null> {
    const value = this.strings.get(key) ?? null;
    this.strings.delete(key);
    return value;
  }
}

describe('OR10-02 session get/touch race', () => {
  it('a delayed get touch cannot restore a session after destroy()', async () => {
    const world = controlledMemoryRepository();
    const store = makeStore(world.repo);
    const created = await store.create(IDENTITY);
    const pause = world.pauseNextTouch();

    const inFlightGet = store.get(created.sessionId);
    await pause.started.promise;
    expect(await store.destroy(created.sessionId)).toBe(true);
    pause.release.resolve();

    expect(await inFlightGet).toBeNull();
    expect(await world.base.get(created.sessionId)).toBeNull();
    expect(world.base.size()).toBe(0);
  });

  it('a delayed get touch cannot restore a principal session after revokePrincipal()', async () => {
    const world = controlledMemoryRepository();
    const store = makeStore(world.repo);
    const created = await store.create(IDENTITY);
    const pause = world.pauseNextTouch();

    const inFlightGet = store.get(created.sessionId);
    await pause.started.promise;
    expect(await store.revokePrincipal(IDENTITY.issuer, IDENTITY.sub)).toBe(1);
    pause.release.resolve();

    expect(await inFlightGet).toBeNull();
    expect(await world.base.get(created.sessionId)).toBeNull();
    expect(world.base.size()).toBe(0);
  });

  it('a delayed old-generation touch loses to rotation and never recreates the old id', async () => {
    const world = controlledMemoryRepository();
    const store = makeStore(world.repo);
    const created = await store.create(IDENTITY);
    const pause = world.pauseNextTouch();

    const inFlightGet = store.get(created.sessionId);
    await pause.started.promise;
    const rotated = await store.rotate(created.sessionId);
    expect(rotated).not.toBeNull();
    expect(rotated!.sessionId).not.toBe(created.sessionId);
    pause.release.resolve();

    expect(await inFlightGet).toBeNull();
    expect(await world.base.get(created.sessionId)).toBeNull();
    expect(await world.base.get(rotated!.sessionId)).not.toBeNull();
    expect(world.base.size()).toBe(1);
  });

  it('a stale snapshot cannot overwrite a replacement generation under the same id', async () => {
    const world = controlledMemoryRepository();
    const store = makeStore(world.repo);
    const created = await store.create(IDENTITY);
    const pause = world.pauseNextTouch();

    const inFlightGet = store.get(created.sessionId);
    await pause.started.promise;
    const replacement = { ...created, csrfToken: 'R'.repeat(43) };
    await world.repo.set(replacement);
    pause.release.resolve();

    expect(await inFlightGet).toBeNull();
    expect(await world.base.get(created.sessionId)).toEqual(replacement);
    expect(world.base.size()).toBe(1);
  });

  it('the Redis repository uses its atomic touch so destroy cannot race into a stale SET', async () => {
    const redis = new AtomicMemoryRedis();
    const repository = createRedisSessionRepository(redis, { now: () => T0 + 1_000 });
    const store = makeStore(repository);
    const created = await store.create(IDENTITY);
    const pause = redis.pauseNextTouch();

    const inFlightGet = store.get(created.sessionId);
    await pause.started.promise;
    expect(await store.destroy(created.sessionId)).toBe(true);
    pause.release.resolve();

    expect(await inFlightGet).toBeNull();
    expect(await repository.get(created.sessionId)).toBeNull();
  });
});
