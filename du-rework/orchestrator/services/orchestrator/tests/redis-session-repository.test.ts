import { createHash } from 'node:crypto';
import {
  createIoredisSessionGateway,
  createRedisChallengeStore,
  createRedisSessionRepository,
  type RedisSessionGateway,
} from '../src/modules/auth/redis-session-repository';
import type { FlowChallenge } from '../src/app/admin/oidc-flow';
import { createSessionStore, SessionError, type SessionRecord } from '../src/modules/auth/session-store';
import { FakeRedisSessionGateway } from './stubs/fake-redis-gateway';

/**
 * OIDC-02 PERSISTENT SESSION STORE — offline proofs. The real repository
 * code runs against an in-process Redis fake on a FAKE clock (never the
 * Redis/DB window): TTL math, fail-closed parsing, the principal index,
 * and the actual acceptance shape — TWO stores (replicas) over ONE
 * shared gateway see the same sessions, and revoke on one kills on all.
 */

const T0 = 1_800_000_000_000;
const ISS = 'https://idp.test/realms/du';
const S1 = 'a'.repeat(43);
const S2 = 'b'.repeat(43);
const S3 = 'c'.repeat(43);
const CSRF = 'd'.repeat(43);
const PREFIX = 'du:admin:sess:';

function clocked(start: number = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function sessKey(id: string): string {
  return PREFIX + 's:' + id;
}

/** Mirrors the documented key contract: sha256 over a length-prefixed tuple. */
function pKey(issuer: string, sub: string): string {
  return (
    PREFIX + 'p:' + createHash('sha256')
      .update(String(issuer.length) + '|' + issuer + String(sub.length) + '|' + sub, 'utf8')
      .digest('hex')
  );
}

function record(over: Partial<SessionRecord> & { sessionId: string }, nowMs: number): SessionRecord {
  return {
    issuer: ISS,
    sub: 'user-1',
    tenantId: null,
    role: 'admin',
    csrfToken: CSRF,
    createdAt: nowMs,
    lastSeenAt: nowMs,
    expiresAt: nowMs + 3_600_000,
    ...over,
  };
}

function world(start: number = T0) {
  const clock = clocked(start);
  const fake = new FakeRedisSessionGateway(clock.now);
  const repo = createRedisSessionRepository(fake, { now: clock.now });
  return { clock, fake, repo };
}

describe('createRedisSessionRepository: TTL-correct upsert + validated reads', () => {
  it('set stores EX = remaining absolute seconds; get round-trips the record', async () => {
    const { fake, repo, clock } = world();
    const r = record({ sessionId: S1 }, clock.now());
    await repo.set(r);
    expect(fake.ttlSeconds(sessKey(S1))).toBe(3600);
    expect(await repo.get(S1)).toEqual(r);
    // the principal index rides the same TTL window
    expect(fake.ttlSeconds(pKey(ISS, 'user-1'))).toBe(3600);
    expect(fake.members(pKey(ISS, 'user-1'))).toEqual([S1]);
  });

  it('unknown id -> null; a malformed id NEVER reaches storage (SEC-02 shape gate)', async () => {
    const { fake, repo } = world();
    expect(await repo.get(S1)).toBeNull();
    const before = fake.calls;
    expect(await repo.get('../../etc/passwd')).toBeNull();
    expect(await repo.get('short')).toBeNull();
    expect(await repo.get('a'.repeat(42) + '!')).toBeNull();
    expect(fake.calls).toBe(before);
  });

  it('corrupted / hostile payloads are INDISTINGUISHABLE from absent (fail closed, no throw)', async () => {
    const { fake, repo, clock } = world();
    const good = record({ sessionId: S1 }, clock.now());
    const blobs: string[] = [
      '{oops',
      JSON.stringify([good]),
      JSON.stringify({ ...good, sessionId: S2 }),
      JSON.stringify({ ...good, role: 'superadmin' }),
      JSON.stringify({ ...good, csrfToken: 'x' }),
      JSON.stringify({ ...good, expiresAt: 'soon' }),
      JSON.stringify({ ...good, sub: '' }),
      JSON.stringify({ ...good, tenantId: 7 }),
      '{"__proto__":{"role":"admin"},"sessionId":"' + S1 + '"}',
    ];
    for (const blob of blobs) {
      fake.putRaw(sessKey(S1), blob, 3600);
      expect(await repo.get(S1)).toBeNull();
    }
  });

  it('set refuses a malformed session id — loud, never a garbage key', async () => {
    const { repo, clock } = world();
    await expect(repo.set(record({ sessionId: 'x' }, clock.now()))).rejects.toBeInstanceOf(SessionError);
  });

  it('already-expired record gets >=1s, then dies on its own TTL (never lives forever)', async () => {
    const { fake, repo, clock } = world();
    const stale = record({ sessionId: S1, expiresAt: clock.now() - 5_000 }, clock.now() - 60_000);
    await repo.set(stale);
    expect(fake.ttlSeconds(sessKey(S1))).toBe(1);
    clock.advance(2_000);
    expect(await repo.get(S1)).toBeNull();
  });

  it('delete: true only while the key exists; false after', async () => {
    const { fake, repo, clock } = world();
    await repo.set(record({ sessionId: S1 }, clock.now()));
    expect(await repo.delete(S1)).toBe(true);
    expect(await repo.delete(S1)).toBe(false);
    expect(fake.ttlSeconds(sessKey(S1))).toBeNull();
  });
});

describe('createRedisSessionRepository: principal index (revokePrincipal)', () => {
  it('kills ALL sessions of (iss,sub), spares other principals', async () => {
    const { fake, repo, clock } = world();
    await repo.set(record({ sessionId: S1 }, clock.now()));
    await repo.set(record({ sessionId: S2 }, clock.now()));
    await repo.set(record({ sessionId: S3, sub: 'user-2' }, clock.now()));
    expect(await repo.revokePrincipal!(ISS, 'user-1')).toBe(2);
    expect(await repo.get(S1)).toBeNull();
    expect(await repo.get(S2)).toBeNull();
    expect(await repo.get(S3)).not.toBeNull();
    expect(fake.members(pKey(ISS, 'user-1'))).toEqual([]);
    expect(fake.members(pKey(ISS, 'user-2'))).toEqual([S3]);
  });

  it('a POISONED index member can never delete keys outside the session namespace', async () => {
    const { fake, repo, clock } = world();
    await repo.set(record({ sessionId: S1 }, clock.now()));
    const rival = PREFIX + 's:' + 'e'.repeat(43);
    fake.putRaw(rival, 'untouchable', 3600);
    // attacker somehow injected garbage + a VALID-LOOKING foreign-format id
    await fake.sadd(pKey(ISS, 'user-1'), '../../management/console');
    await fake.sadd(pKey(ISS, 'user-1'), 'x'.repeat(20));
    expect(await repo.revokePrincipal!(ISS, 'user-1')).toBe(1); // only S1 counted
    expect(fake.ttlSeconds(rival)).toBe(3600); // foreign key untouched
  });

  it('revoke of an unknown principal is a harmless 0 (idempotent)', async () => {
    const { repo } = world();
    expect(await repo.revokePrincipal!(ISS, 'ghost')).toBe(0);
  });
});

describe('OIDC-02 acceptance shape: two replicas, one Redis, one truth', () => {
  function pair(fake: RedisSessionGateway, now: () => number) {
    const mk = () =>
      createSessionStore({
        repo: createRedisSessionRepository(fake, { now }),
        now,
        absoluteTtlMs: 8 * 3_600_000,
        idleTtlMs: 30 * 60_000,
      });
    return { storeA: mk(), storeB: mk() };
  }

  it('create on A authenticates on B; touch on B slides idle but NEVER the absolute TTL', async () => {
    const { clock, fake } = world();
    const { storeA, storeB } = pair(fake, clock.now);
    const created = await storeA.create({ issuer: ISS, sub: 'dup', tenantId: 'T-1', role: 'operator' });
    const key = sessKey(created.sessionId);
    expect(fake.ttlSeconds(key)).toBe(8 * 3600);
    clock.advance(20 * 60_000); // 20min of activity — inside the 30min idle window
    const seenB = await storeB.get(created.sessionId);
    expect(seenB).not.toBeNull();
    expect(seenB!.role).toBe('operator');
    expect(seenB!.tenantId).toBe('T-1');
    // B's sliding touch rewrote the SAME key: remaining ABSOLUTE is 7h40m, not 8h.
    expect(fake.ttlSeconds(key)).toBe(8 * 3600 - 20 * 60);
    const seenA = await storeA.get(created.sessionId);
    expect(seenA!.lastSeenAt).toBe(clock.now()); // A sees B's touch
  });

  it('rotate on B (fixation defense) is immediately visible on A; destroy on A kills B', async () => {
    const { clock, fake } = world();
    const { storeA, storeB } = pair(fake, clock.now);
    const created = await storeA.create({ issuer: ISS, sub: 'dup', role: 'admin' });
    const rotated = await storeB.rotate(created.sessionId);
    expect(rotated).not.toBeNull();
    expect(await storeA.get(created.sessionId)).toBeNull(); // old id dead everywhere
    expect(await storeA.get(rotated!.sessionId)).not.toBeNull(); // new id live everywhere
    expect(await storeB.destroy(rotated!.sessionId)).toBe(true);
    expect(await storeA.get(rotated!.sessionId)).toBeNull();
  });

  it('revokePrincipal on A kills live sessions on B; a NEW store over the SAME redis sees it too (restart)', async () => {
    const { clock, fake } = world();
    const { storeA, storeB } = pair(fake, clock.now);
    const s1 = await storeA.create({ issuer: ISS, sub: 'nuclear', role: 'admin' });
    const s2 = await storeB.create({ issuer: ISS, sub: 'nuclear', role: 'admin' });
    expect(await storeA.revokePrincipal(ISS, 'nuclear')).toBe(2);
    expect(await storeA.get(s1.sessionId)).toBeNull();
    expect(await storeB.get(s2.sessionId)).toBeNull();
    // 'restart': third replica, fresh store objects, shared storage
    const { storeA: storeC } = pair(fake, clock.now);
    expect(await storeC.get(s1.sessionId)).toBeNull();
    expect(await storeC.get(s2.sessionId)).toBeNull();
  });
});
describe('createRedisChallengeStore: one-shot login state, GETDEL semantics', () => {
  const CHAL_PREFIX = 'du:admin:chal:';
  const STATE44 = 'z'.repeat(43) + '='; // newToken() keeps base64 '=' padding
  const VERIFIER = 'v'.repeat(43);
  const NONCE = 'n'.repeat(43);
  const chalKey = (state: string): string =>
    CHAL_PREFIX + createHash('sha256').update(state, 'ascii').digest('hex');
  function challenge(nowMs: number, over: Partial<FlowChallenge> = {}): FlowChallenge {
    return { verifier: VERIFIER, nonce: NONCE, returnTo: '/admin/businesses', expiresAt: nowMs + 600_000, ...over };
  }
  function chalWorld() {
    const clock = clocked(T0);
    const fake = new FakeRedisSessionGateway(clock.now);
    const store = createRedisChallengeStore(fake, { now: clock.now });
    return { clock, fake, store };
  }

  it('put->consume round-trips; the STATE NEVER RIDES AS A PLAINTEXT KEY; second consume is null', async () => {
    const { clock, fake, store } = chalWorld();
    const ch = challenge(clock.now());
    await store.put(STATE44, ch);
    expect(fake.allKeys().every((k) => !k.includes('zzzz'))).toBe(true);
    expect(fake.ttlSeconds(chalKey(STATE44))).toBe(600);
    expect(await store.consume(STATE44)).toEqual(ch);
    expect(await store.consume(STATE44)).toBeNull(); // GETDEL already removed it
    expect(fake.ttlSeconds(chalKey(STATE44))).toBeNull();
  });

  it('cross-replica one-shot: B consumes what A stored; A then finds NOTHING (exactly one winner)', async () => {
    const { clock, fake } = chalWorld();
    const a = createRedisChallengeStore(fake, { now: clock.now });
    const b = createRedisChallengeStore(fake, { now: clock.now });
    const ch = challenge(clock.now());
    await a.put(STATE44, ch);
    expect(await b.consume(STATE44)).toEqual(ch);
    expect(await a.consume(STATE44)).toBeNull();
  });

  it('expired challenge dies on its Redis TTL; consume after the window is the same null', async () => {
    const { clock, store } = chalWorld();
    await store.put(STATE44, challenge(clock.now()));
    clock.advance(601_000);
    expect(await store.consume(STATE44)).toBeNull();
  });

  it('malformed state never reaches storage; put REFUSES garbage loudly', async () => {
    const { clock, fake, store } = chalWorld();
    const before = fake.calls;
    expect(await store.consume('not-a-state')).toBeNull();
    expect(await store.consume('../../etc/passwd')).toBeNull();
    expect(fake.calls).toBe(before);
    await expect(store.put('bad-state', challenge(clock.now()))).rejects.toBeInstanceOf(SessionError);
    await expect(store.put(STATE44, challenge(clock.now(), { verifier: 'x'.repeat(5) }))).rejects.toBeInstanceOf(SessionError);
  });

  it('poisoned payloads fail closed — and a poisoned RETURN-TO can never become a Location header', async () => {
    const { clock, fake, store } = chalWorld();
    const good = challenge(clock.now());
    const blobs: string[] = [
      '{not json',
      JSON.stringify([good]),
      JSON.stringify({ ...good, verifier: 'short' }),
      JSON.stringify({ ...good, nonce: '' }),
      JSON.stringify({ ...good, expiresAt: 'never' }),
      JSON.stringify({ ...good, returnTo: 'https://evil.example' }),
      JSON.stringify({ ...good, returnTo: '//evil.example' }),
      JSON.stringify({ ...good, returnTo: '/a/' + String.fromCharCode(13, 10) + 'Set-Cookie: x=1' }),
      JSON.stringify({ ...good, returnTo: '/../admin' }),
    ];
    for (const blob of blobs) {
      fake.putRaw(chalKey(STATE44), blob, 600);
      expect(await store.consume(STATE44)).toBeNull();
    }
  });

  it('a clock-raced future expiresAt in the payload still denies (belt AND braces)', async () => {
    const { clock, fake, store } = chalWorld();
    fake.putRaw(chalKey(STATE44), JSON.stringify(challenge(clock.now(), { expiresAt: clock.now() - 10_000 })), 600);
    expect(await store.consume(STATE44)).toBeNull();
  });
});

describe('createIoredisSessionGateway: ready() boot-race contract (offline-safe)', () => {
  it('exposes ready(); against an unreachable URL it FAILS FAST on the budget — no silent hang, no uncaught error events', async () => {
    // Port 9 (discard) on loopback: ECONNREFUSED immediately — no storm
    // risk, no dependency on :6380. The adapter keeps retrying underneath
    // (ioredis retryStrategy) while ready() waits inside its OWN 10s
    // budget; the process must survive every reconnection 'error'.
    const g = createIoredisSessionGateway('redis://127.0.0.1:9');
    expect(typeof g.ready).toBe('function');
    const started = Date.now();
    await expect(g.ready!()).rejects.toThrow(/not ready within 10s/);
    const waited = Date.now() - started;
    expect(waited).toBeGreaterThanOrEqual(9_500); // honored the budget, did not early-deny
    // close() must COMPLETE even on a never-ready client (disconnect path):
    const closed = await Promise.race([
      g.close!().then(() => 'closed' as const),
      new Promise<'slow'>((res) => setTimeout(() => res('slow'), 2_000)),
    ]);
    expect(closed).toBe('closed');
  }, 20_000);

  it('ready() short-circuits when the client is already ready (fake gateway without ready stays optional)', async () => {
    const fake = new FakeRedisSessionGateway();
    expect((fake as RedisSessionGateway).ready).toBeUndefined();
    // repositories accept both shapes — compile-time proof of the optional seam:
    const repo = createRedisSessionRepository(fake);
    const clock = clocked();
    await repo.set(record({ sessionId: S1 }, clock.now()));
    expect(await repo.get(S1)).not.toBeNull();
  });
});

