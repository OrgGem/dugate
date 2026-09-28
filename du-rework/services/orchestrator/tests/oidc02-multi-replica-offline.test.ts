import { createHash } from 'node:crypto';
import {
  createIoredisSessionGateway,
  createRedisSessionRepository,
  type RedisSessionGateway,
} from '../src/modules/auth/redis-session-repository';
import { createSessionStore, type SessionRecord } from '../src/modules/auth/session-store';
import { resolveAdminActionAuthAsync } from '../src/modules/admin-actions/rbac';
import { FakeRedisSessionGateway } from './stubs/fake-redis-gateway';

/**
 * CYCLE 126+ / REVIEWER FINDING 3 (HIGH) — the OIDC-02 MULTI-REPLICA
 * SCENARIO PACK. One shared Redis (in-process fake offline; a REAL
 * connection ONLY behind DU_LIVE_INFRA=1 for Tester-1's window) with N
 * stateless store instances = N replicas. Every scenario is the failure
 * mode a single-process store cannot survive:
 *   SHARE   — session minted on A authenticates on B (incl. through the
 *             REAL dispatcher resolver: role + server-side tenant + CSRF).
 *   REVOKE  — logout/revokePrincipal on one replica is dead on all,
 *             across a simulated process restart.
 *   EXPIRY  — absolute deadline is never extended by activity, sliding
 *             idle works cross-replica, and Redis's own TTL agrees.
 * Offline: ZERO sockets (no :5433, no :6380, no mock-IdP fetch).
 */

const T0 = 1_800_000_000_000;
const ISS = 'https://idp.test/realms/du';
const PREFIX = 'du:admin:sess:';

function clocked(start = T0) {
  let t = start;
  return { now: () => t, advance: (ms: number) => { t += ms; } };
}

function replica(fake: FakeRedisSessionGateway, now: () => number, opts: { absoluteTtlMs?: number; idleTtlMs?: number } = {}) {
  return createSessionStore({
    repo: createRedisSessionRepository(fake, { now }),
    now,
    absoluteTtlMs: opts.absoluteTtlMs ?? 8 * 3_600_000,
    idleTtlMs: opts.idleTtlMs ?? 30 * 60_000,
  });
}

const sessKey = (id: string): string => PREFIX + 's:' + id;
const principalIdx = (iss: string, sub: string): string =>
  PREFIX + 'p:' + createHash('sha256')
    .update(String(iss.length) + '|' + iss + String(sub.length) + '|' + sub, 'utf8')
    .digest('hex');

function world() {
  const clock = clocked();
  const fake = new FakeRedisSessionGateway(clock.now);
  return { clock, fake, replica: (opts?: { absoluteTtlMs?: number; idleTtlMs?: number }) => replica(fake, clock.now, opts) };
}

describe('OIDC-02 SHARE: one Redis, every replica sees the same truth', () => {
  it('session minted on A authenticates on B through the REAL dispatcher resolver (role+tenant+CSRF)', async () => {
    const { fake, replica: mk } = world();
    const a = mk();
    const b = mk();
    const created = await a.create({ issuer: ISS, sub: 'share-1', tenantId: 'T-42', role: 'operator' });

    const authOk = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      { cookie: 'du_session=' + created.sessionId, 'x-csrf-token': created.csrfToken },
      b // AdminSessionStore seam — B resolves what A minted
    );
    expect(authOk).toEqual({ kind: 'cookie', role: 'operator', tenantId: 'T-42', csrfOk: true });

    const authCsrf = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      { cookie: 'du_session=' + created.sessionId, 'x-csrf-token': 'w'.repeat(43) },
      b
    );
    expect(authCsrf).not.toBeNull();
    if (authCsrf?.kind === 'cookie') expect(authCsrf.csrfOk).toBe(false); // gate decides, resolver only reports

    const authUnknown = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      { cookie: 'du_session=' + 'q'.repeat(43) },
      b
    );
    expect(authUnknown).toBeNull();
    void fake;
  });

  it('logout on B is immediately dead on A (one-key truth, not per-process tables)', async () => {
    const { replica: mk } = world();
    const a = mk();
    const b = mk();
    const created = await a.create({ issuer: ISS, sub: 'share-2', role: 'admin' });
    expect(await b.get(created.sessionId)).not.toBeNull();
    expect(await b.destroy(created.sessionId)).toBe(true);
    expect(await a.get(created.sessionId)).toBeNull();
    expect(await a.destroy(created.sessionId)).toBe(false); // idempotent across replicas
  });
});

describe('OIDC-02 REVOKE: one decision kills every live session of a principal', () => {
  it('two replicas each mint a session for the SAME principal; revokePrincipal on A → 0 left on B', async () => {
    const { fake, replica: mk } = world();
    const a = mk();
    const b = mk();
    const s1 = await a.create({ issuer: ISS, sub: 'nuke-me', role: 'admin' });
    const s2 = await b.create({ issuer: ISS, sub: 'nuke-me', tenantId: 'T-7', role: 'operator' });
    const sOther = await b.create({ issuer: ISS, sub: 'innocent', role: 'admin' });

    expect(await a.revokePrincipal(ISS, 'nuke-me')).toBe(2);
    expect(await a.get(s1.sessionId)).toBeNull();
    expect(await b.get(s2.sessionId)).toBeNull();
    expect(await b.get(sOther.sessionId)).not.toBeNull(); // surgical, not global
    expect(fake.members(principalIdx(ISS, 'nuke-me'))).toEqual([]);
  });

  it('revoke survives a full process restart (nothing to resurrect — deletion IS the state)', async () => {
    const { fake, replica: mk } = world();
    const old = mk();
    const s = await old.create({ issuer: ISS, sub: 'restart-me', role: 'admin' });
    expect(await old.revokePrincipal(ISS, 'restart-me')).toBe(1);
    // 'restart': every replica object discarded, fresh ones over the SAME Redis
    void fake;
    const freshA = mk();
    const freshB = mk();
    expect(await freshA.get(s.sessionId)).toBeNull();
    expect(await freshB.get(s.sessionId)).toBeNull();
  });

  it('a NEW login after revoke works (revoke kills sessions, never blacklists principals)', async () => {
    const { replica: mk } = world();
    const a = mk();
    const s = await a.create({ issuer: ISS, sub: 'returning', role: 'admin' });
    await a.revokePrincipal(ISS, 'returning');
    const again = await a.create({ issuer: ISS, sub: 'returning', role: 'admin' });
    expect(again.sessionId).not.toBe(s.sessionId);
    expect(await a.get(again.sessionId)).not.toBeNull();
  });
});

// ---------------------------------------------------------------------------
// CYCLE 127 (Qwen-2 additions): resolver-level fail-closed after a foreign
// revoke, and cross-replica SESSION ROTATION (fixation defense must hold
// when the IdP callback lands on A but the next request lands on B).
// ---------------------------------------------------------------------------

describe('OIDC-02 FAIL-CLOSED + ROTATION across replicas (cycle 127)', () => {
  it('A destroys; B-side dispatcher resolution is null from that instant (401 at the route)', async () => {
    const { replica: mk } = world();
    const a = mk();
    const b = mk();
    const created = await a.create({ issuer: ISS, sub: 'resolver-dead', tenantId: 'T-3', role: 'operator' });
    // alive first: B resolves A's session end-to-end
    const before = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      { cookie: 'du_session=' + created.sessionId, 'x-csrf-token': created.csrfToken },
      b
    );
    expect(before).toMatchObject({ kind: 'cookie', role: 'operator', csrfOk: true });
    expect(await a.destroy(created.sessionId)).toBe(true);
    const after = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      { cookie: 'du_session=' + created.sessionId, 'x-csrf-token': created.csrfToken },
      b
    );
    expect(after).toBeNull(); // → route layer answers 401: indistinguishable from unknown
  });

  it('revokePrincipal on A also nullifies B-side resolution for BOTH sessions of the principal', async () => {
    const { replica: mk } = world();
    const a = mk();
    const b = mk();
    const s1 = await a.create({ issuer: ISS, sub: 'resolver-nuke', role: 'admin' });
    const s2 = await b.create({ issuer: ISS, sub: 'resolver-nuke', role: 'admin' });
    expect(await a.revokePrincipal(ISS, 'resolver-nuke')).toBe(2);
    for (const s of [s1, s2]) {
      const auth = await resolveAdminActionAuthAsync(
        { adminToken: 'never-matching' },
        { cookie: 'du_session=' + s.sessionId, 'x-csrf-token': s.csrfToken },
        b
      );
      expect(auth).toBeNull();
    }
  });

  it('rotate on A (post-login fixation defense): old id dead on B, new id authenticates on B', async () => {
    const { replica: mk } = world();
    const a = mk(); // IdP callback landed on A
    const b = mk(); // the browser's NEXT request lands on B
    const preLogin = await a.create({ issuer: ISS, sub: 'rotate-x', tenantId: 'T-5', role: 'operator' });
    const rotated = await a.rotate(preLogin.sessionId);
    expect(rotated).not.toBeNull();
    const next = rotated!;
    expect(next.sessionId).not.toBe(preLogin.sessionId);
    // the planted pre-login id is globally dead — B cannot authenticate it
    expect(await b.get(preLogin.sessionId)).toBeNull();
    const oldAuth = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      { cookie: 'du_session=' + preLogin.sessionId, 'x-csrf-token': preLogin.csrfToken },
      b
    );
    expect(oldAuth).toBeNull();
    // the fresh id rides any replica: identity + CSRF carried over
    const newAuth = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      { cookie: 'du_session=' + next.sessionId, 'x-csrf-token': next.csrfToken },
      b
    );
    expect(newAuth).toEqual({ kind: 'cookie', role: 'operator', tenantId: 'T-5', csrfOk: true });
  });

  it('double rotate: the pre-rotation id can never rotate again on ANY replica', async () => {
    const { replica: mk } = world();
    const a = mk();
    const b = mk();
    const first = await a.create({ issuer: ISS, sub: 'rotate-twice', role: 'admin' });
    const second = await a.rotate(first.sessionId);
    expect(second).not.toBeNull();
    expect(await a.rotate(first.sessionId)).toBeNull(); // dead id on its own replica
    expect(await b.rotate(first.sessionId)).toBeNull(); // dead id everywhere
    // and the chain still works from the live id on the OTHER replica:
    const third = await b.rotate(second!.sessionId);
    expect(third).not.toBeNull();
    expect(await a.get(third!.sessionId)).not.toBeNull();
    expect(await a.get(second!.sessionId)).toBeNull();
  });
});

describe('OIDC-02 EXPIRY: absolute never extends, idle slides, Redis TTL agrees', () => {
  it('absolute TTL: activity on another replica must NOT buy extra life', async () => {
    const { clock, fake, replica: mk } = world();
    const a = mk({ absoluteTtlMs: 20 * 60_000, idleTtlMs: 20 * 60_000 });
    const b = mk({ absoluteTtlMs: 20 * 60_000, idleTtlMs: 20 * 60_000 });
    const created = await a.create({ issuer: ISS, sub: 'abs', role: 'admin' });
    clock.advance(10 * 60_000);
    expect(await b.get(created.sessionId)).not.toBeNull(); // mid-life touch on B
    // Redis key TTL is the REMAINING absolute (10min), never reset to 20min:
    expect(fake.ttlSeconds(sessKey(created.sessionId))).toBe(10 * 60);
    clock.advance(10 * 60_000 + 1); // 20min + 1ms after creation
    expect(await a.get(created.sessionId)).toBeNull();
    expect(fake.ttlSeconds(sessKey(created.sessionId))).toBeNull();
  });

  it('idle expiry is judged on the SHARED lastSeenAt: a stranger replica evicts it', async () => {
    const { clock, fake, replica: mk } = world();
    const a = mk({ absoluteTtlMs: 60 * 60_000, idleTtlMs: 10 * 60_000 });
    const b = mk({ absoluteTtlMs: 60 * 60_000, idleTtlMs: 10 * 60_000 });
    const created = await a.create({ issuer: ISS, sub: 'idle', role: 'admin' });
    clock.advance(9 * 60_000);
    expect(await b.get(created.sessionId)).not.toBeNull(); // B's touch lands at t+9m
    clock.advance(6 * 60_000); // now t+15m: 6m since last touch, still < 10m idle
    expect(await a.get(created.sessionId)).not.toBeNull(); // ...cross-replica sliding WORKS
    clock.advance(11 * 60_000); // now t+26m: 11m of silence on everyone
    expect(await b.get(created.sessionId)).toBeNull(); // B (or anyone) evicts: idle-dead
    expect(fake.ttlSeconds(sessKey(created.sessionId))).toBeNull();
  });

  it('Redis-native TTL fires even with ZERO readers (a totally idle cluster self-cleans)', async () => {
    const { clock, fake, replica: mk } = world();
    const a = mk({ absoluteTtlMs: 5_000, idleTtlMs: 5_000 });
    const created = await a.create({ issuer: ISS, sub: 'idle-redis', role: 'admin' });
    expect(fake.ttlSeconds(sessKey(created.sessionId))).toBe(5);
    clock.advance(6_000);
    // the key is already gone storage-side; a fresh replica cannot read it back:
    const late = mk({ absoluteTtlMs: 5_000, idleTtlMs: 5_000 });
    expect(await late.get(created.sessionId)).toBeNull();
    expect(fake.ttlSeconds(sessKey(created.sessionId))).toBeNull();
  });
});

describe('OIDC-02 LOAD BALANCER: rotation across four replicas', () => {
  it('alternating reads keep ONE key with the newest lastSeenAt; destroy once kills four', async () => {
    const { clock, fake, replica: mk } = world();
    const fleet = [mk(), mk(), mk(), mk()];
    const created = await fleet[0]!.create({ issuer: ISS, sub: 'lb', tenantId: 'T-1', role: 'operator' });
    const key = sessKey(created.sessionId);
    const seen: Record<string, SessionRecord> = {};
    for (let i = 0; i < 4; i++) {
      clock.advance(60_000);
      const rec = await fleet[i]!.get(created.sessionId);
      expect(rec).not.toBeNull();
      seen[i] = rec!;
    }
    expect(seen[3]!.lastSeenAt).toBe(clock.now()); // newest touch visible to everyone
    expect(fake.allKeys().filter((k) => k === key)).toHaveLength(1); // still ONE session key
    expect(await fleet[2]!.destroy(created.sessionId)).toBe(true);
    for (const r of fleet) expect(await r.get(created.sessionId)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// TESTER-1 GUARD: the SAME share/revoke/expiry shape against the REAL Redis.
// Offline unit runs NEVER touch this block (describe.skip ⇒ zero sockets,
// zero :6380). Tester-1 runs (per the Finding-3 instruction):
//   set DU_LIVE_INFRA=1 && set REDIS_URL=redis://127.0.0.1:6380
//   pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/oidc02-multi-replica-offline.test.ts
// Namespaced keyPrefix per run + explicit cleanup (no FLUSHDB, no SCAN):
// other lanes' keys on the same server are structurally untouchable.
// ---------------------------------------------------------------------------

const LIVE = process.env.DU_LIVE_INFRA === '1';

function sleep(ms: number): Promise<void> {
  return new Promise((res) => setTimeout(res, ms));
}

(LIVE ? describe : describe.skip)('DU_LIVE_INFRA=1 — real Redis edition (Tester-1 window)', () => {
  const LIVE_URL = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
  const scope = PREFIX + 'live-it-' + createHash('sha1').update(String(Math.random()) + Date.now()).digest('hex').slice(0, 10) + ':';
  let gateway: RedisSessionGateway;
  const tracked: string[] = []; // keys this suite created — deleted in afterAll

  const sKey = (id: string): string => scope + 's:' + id;
  const pIdx = (iss: string, sub: string): string =>
    scope + 'p:' + createHash('sha256')
      .update(String(iss.length) + '|' + iss + String(sub.length) + '|' + sub, 'utf8')
      .digest('hex');

  function liveReplica(absoluteTtlMs: number, idleTtlMs: number) {
    return createSessionStore({
      repo: createRedisSessionRepository(gateway, { keyPrefix: scope }),
      absoluteTtlMs,
      idleTtlMs,
    });
  }

  beforeAll(async () => {
    gateway = createIoredisSessionGateway(LIVE_URL);
    // CYCLE 128 FIX (Tester-1 evidence): offline queue is DISABLED by
    // design, so any command issued before 'ready' rejects with
    // 'Stream isn't writeable'. Block until the connection is writeable —
    // 10s budget, then fail loudly rather than fail three ways downstream.
    await gateway.ready?.();
  });
  afterAll(async () => {
    try {
      if (tracked.length > 0) await gateway.del(...tracked);
    } finally {
      await gateway.close?.();
    }
  });

  it('SHARE: mint on A, authenticate on B through the dispatcher resolver', async () => {
    const a = liveReplica(60_000, 30_000);
    const b = liveReplica(60_000, 30_000);
    const created = await a.create({ issuer: ISS, sub: 'live-share', tenantId: 'T-9', role: 'operator' });
    tracked.push(sKey(created.sessionId), pIdx(ISS, 'live-share'));
    const auth = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      { cookie: 'du_session=' + created.sessionId, 'x-csrf-token': created.csrfToken },
      b
    );
    expect(auth).toEqual({ kind: 'cookie', role: 'operator', tenantId: 'T-9', csrfOk: true });
  });

  it('REVOKE: revokePrincipal on A removes both sessions from B (real clock, real Redis)', async () => {
    const a = liveReplica(60_000, 30_000);
    const b = liveReplica(60_000, 30_000);
    const s1 = await a.create({ issuer: ISS, sub: 'live-nuke', role: 'admin' });
    const s2 = await b.create({ issuer: ISS, sub: 'live-nuke', role: 'admin' });
    tracked.push(sKey(s1.sessionId), sKey(s2.sessionId), pIdx(ISS, 'live-nuke'));
    expect(await a.revokePrincipal(ISS, 'live-nuke')).toBe(2);
    expect(await b.get(s1.sessionId)).toBeNull();
    expect(await a.get(s2.sessionId)).toBeNull();
  });

  it('EXPIRY on the real clock: idle-dead while the absolute is far, then absolute-dead despite recent activity', async () => {
    // Two SEPARATE budget pairs so each verdict has exactly one cause:
    //  idle session: absolute 60s / idle 1.5s → only IDLE can kill it.
    //  abs  session: absolute 3.2s / idle 3.2s → only ABSOLUTE can kill it.
    const idleA = liveReplica(60_000, 1_500);
    const idleB = liveReplica(60_000, 1_500);
    const absA = liveReplica(3_200, 3_200);
    const idle = await idleA.create({ issuer: ISS, sub: 'live-idle', role: 'admin' });
    const abs = await absA.create({ issuer: ISS, sub: 'live-abs', role: 'admin' });
    tracked.push(sKey(idle.sessionId), sKey(abs.sessionId), pIdx(ISS, 'live-idle'), pIdx(ISS, 'live-abs'));
    await sleep(800);
    expect(await idleB.get(idle.sessionId)).not.toBeNull(); // B touches at ~0.8s
    expect(await absA.get(abs.sessionId)).not.toBeNull(); // activity at ~0.8s
    await sleep(1_700); // ~2.5s: idle silent since 0.8 (1.7 > 1.5) → DEAD; abs at 2.5/3.2, silent 1.7/3.2 → ALIVE
    expect(await idleB.get(idle.sessionId)).toBeNull(); // idle-dead on the shared lastSeen
    expect(await absA.get(abs.sessionId)).not.toBeNull(); // touch at ~2.5s buys idle life only
    await sleep(900); // ~3.4s > 3.2s absolute — dead DESPITE the 0.9s-old touch
    expect(await absA.get(abs.sessionId)).toBeNull();
    // Native agreement: Redis ITSELF no longer serves either key — the
    // store wrote a real EX (abs) / DEL (idle-eviction), no ghost data.
    expect(await gateway.get(sKey(abs.sessionId))).toBeNull();
    expect(await gateway.get(sKey(idle.sessionId))).toBeNull();
  }, 20_000);
});
