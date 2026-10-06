import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import type { ChildProcess } from 'node:child_process';
import { FakeRedisSessionGateway } from './stubs/fake-redis-gateway';
import { startMockOidcIdp, type MockOidcIdp } from './stubs/mock-oidc-idp';
import {
  authorizeAtIdp,
  callbackAt,
  fetchWithRetry,
  loginAt,
  logoutAt,
  makeReplica,
  SEC00,
  sidFrom,
  visit,
  type Replica,
  type ReplicaTuning,
} from './fixtures/oidc02-replica-harness';

/**
 * CYCLE 138 / REVIEWER AUDIT 132-137 — OIDC-02 SEPARATE-PROCESS REPLICA
 * scenarios, offline. Each replica is a FRESH component graph (mirrors
 * what oidc-boot builds per real process — see the fixture's doc-block);
 * replicas share ONLY the Redis gateway + the mock IdP. Every assertion
 * travels the browser surface: real IdP HTTP leg, du_session cookie,
 * the production shell router. No DB, no Redis window, no :5433/:6380.
 *
 * Covers the reviewer's list: callback on a foreign replica, cookie
 * logout, rotation, restart, expiry — under one SEC-00 issuer/origin
 * config. The child-process live expansion is a documented contract in
 * the fixture header (Tester-1, DU_LIVE_INFRA window).
 *
 * W-OIDC02-REPLICA-1 extends the OFFLINE side to mirror the live block
 * leg-for-leg: nuclear revoke EXECUTED BY A RESTARTED replica over
 * sessions it never minted, principal-surgical revoke, single-session
 * destroy across the restart boundary, and the restart × expiry
 * arbitration legs (baked absolute deadline beats any long-TTL reader;
 * the idle lastSeenAt survives process churn).
 */

let idp: MockOidcIdp;
let gateway: FakeRedisSessionGateway;

function replica(tuning: ReplicaTuning = {}): Replica {
  return makeReplica(gateway, idp.issuer, tuning);
}

/** Full browser sign-in STARTED at 'start' (callback may land anywhere). */
async function signIn(startAt: Replica, finishAt: Replica): Promise<{ sid: string; login: URL }> {
  const login = await loginAt(startAt);
  const { code, state } = await authorizeAtIdp(login);
  const cb = await callbackAt(finishAt, code, state);
  expect(cb.status).toBe(302);
  const sid = sidFrom(cb.headers['set-cookie']);
  if (!sid) throw new Error('callback minted no cookie: ' + cb.status);
  return { sid, login };
}

beforeAll(async () => {
  process.env.NO_PROXY = '127.0.0.1,localhost';
  idp = await startMockOidcIdp();
});
afterAll(async () => {
  await idp?.close();
});
beforeEach(() => {
  idp.reset();
  gateway = new FakeRedisSessionGateway();
});

describe('cross-process callback + cookie', () => {
  it('login STARTED on A COMPLETES on B; the cookie serves BOTH routers (same SEC-00 plane)', async () => {
    const a = replica();
    const b = replica();
    const loginUrlA = await loginAt(a);
    // SEC-00 consistency: both replicas mint identical plane params
    const loginUrlB = await loginAt(b);
    for (const u of [loginUrlA, loginUrlB]) {
      expect(u.searchParams.get('client_id')).toBe(SEC00.clientId);
      expect(u.searchParams.get('redirect_uri')).toBe(SEC00.redirectUri);
      expect(u.searchParams.get('code_challenge_method')).toBe('S256');
    }
    const { code, state } = await authorizeAtIdp(loginUrlA);
    const cb = await callbackAt(b, code, state); // LB sent the callback to B
    expect(cb.status).toBe(302);
    const sid = sidFrom(cb.headers['set-cookie']);
    expect(sid.length).toBe(43);
    // the session lives in SHARED storage: both processes serve the page
    for (const r of [a, b]) {
      const page = await visit(r, sid);
      expect(page.status).toBe(200);
      expect(page.body).toContain('<title>');
    }
    // the challenge was consumed by B's GETDEL — A can no longer finish it
    const replay = await callbackAt(a, code, state);
    expect(replay.status).toBe(403);
  });
});

describe('cross-process cookie logout', () => {
  it('logout AT B clears the cookie AND kills the session for A', async () => {
    const a = replica();
    const b = replica();
    const { sid } = await signIn(a, b);
    const out = await logoutAt(b, sid);
    expect(out.status).toBe(302);
    expect(out.headers['location']).toBe('/admin/login');
    expect(out.headers['set-cookie']).toContain('du_session=;');
    // server-side truth, checked from the OTHER process:
    expect(await a.store.get(sid)).toBeNull();
    const after = await visit(a, sid);
    expect(after.status).toBe(302); // gate bounce, not a stale 200
    expect(after.headers['location']).toBe('/admin/login');
  });
});

describe('cross-process rotation (session-fixation defense)', () => {
  it('rotate on B: OLD cookie dies everywhere, rotated cookie lives everywhere', async () => {
    const a = replica();
    const b = replica();
    const { sid } = await signIn(a, b);
    const rotated = await b.store.rotate(sid);
    expect(rotated).not.toBeNull();
    expect(rotated!.sessionId).not.toBe(sid);
    for (const r of [a, b]) {
      expect((await visit(r, sid)).status).toBe(302); // old id dead on both
      expect((await visit(r, rotated!.sessionId)).status).toBe(200); // new id live on both
    }
    expect(await a.store.get(sid)).toBeNull();
  });
});

describe('cross-process restart + revoke', () => {
  it('a RESTARTED replica serves the pre-restart session; revoke before restart stays dead after', async () => {
    const a = replica();
    const b = replica();
    const live = await signIn(a, b);
    const doomed = await signIn(a, b);
    expect(await b.store.revokePrincipal(idp.issuer, 'mock-user-1')).toBeGreaterThanOrEqual(1);
    // 'restart': fresh graphs over the SAME shared gateway
    const a2 = replica();
    const b2 = replica();
    expect(await a2.store.get(doomed.sid)).toBeNull(); // revoked stays revoked
    expect((await visit(b2, doomed.sid)).status).toBe(302);
    // NOTE: revokePrincipal hit 'mock-user-1' — BOTH sessions of that sub.
    // Re-login for the live path, then restart-persistence:
    const fresh = await signIn(a2, b2);
    const a3 = replica();
    const b3 = replica();
    expect((await visit(a3, fresh.sid)).status).toBe(200); // survives process churn
    expect((await visit(b3, fresh.sid)).status).toBe(200);
    void live;
  });
});

describe('cross-process expiry (real clock, short windows)', () => {
  it('ABSOLUTE deadline evicts on every replica — activity cannot buy life', async () => {
    const tune = { absoluteTtlMs: 1_600, idleTtlMs: 1_600 };
    const a = replica(tune);
    const b = replica(tune);
    const { sid } = await signIn(a, b);
    expect((await visit(a, sid)).status).toBe(200);
    await new Promise((res) => setTimeout(res, 1_750));
    expect((await visit(a, sid)).status).toBe(302);
    expect((await visit(b, sid)).status).toBe(302);
  }, 20_000);

  it('SLIDING idle uses the SHARED lastSeenAt: a touch on B keeps A alive too', async () => {
    const tune = { absoluteTtlMs: 60_000, idleTtlMs: 1_200 };
    const a = replica(tune);
    const b = replica(tune);
    const { sid } = await signIn(a, b);
    await new Promise((res) => setTimeout(res, 700));
    expect((await visit(b, sid)).status).toBe(200); // B touches at ~0.7s
    await new Promise((res) => setTimeout(res, 700));
    expect((await visit(a, sid)).status).toBe(200); // ~1.4s: 0.7s since B's touch — alive on A
    await new Promise((res) => setTimeout(res, 1_400));
    expect((await visit(b, sid)).status).toBe(302); // silent >1.2s — idle-dead for everyone
    expect((await visit(a, sid)).status).toBe(302);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// W-OIDC02-REPLICA-1 — offline mirrors of the live legs below (nuclear
// revoke across processes, RESTART generation revoking foreign sessions,
// cross-TTL expiry arbitration) plus the revoke slices the offline block
// never had: single-session destroy, principal isolation. Same rules as
// the rest of this file: fresh component graphs over the shared fake
// gateway, browser-surface assertions, real clock, no sockets beyond the
// mock IdP.
// ---------------------------------------------------------------------------

describe('cross-process revoke slices (W-OIDC02-REPLICA-1)', () => {
  it('destroy AT A bounces B on the browser surface and stays dead across a restart', async () => {
    const d = replica();
    const e = replica();
    const { sid } = await signIn(d, e);
    expect((await visit(e, sid)).status).toBe(200);
    expect(await d.store.destroy(sid)).toBe(true);
    expect(await d.store.destroy(sid)).toBe(false); // idempotent: nothing left to delete
    expect((await visit(e, sid)).status).toBe(302); // killed on the FOREIGN replica…
    expect((await visit(d, sid)).status).toBe(302); // …and on the one that executed it
    const f = replica(); // RESTART generation over the same gateway
    expect(await f.store.get(sid)).toBeNull();
    expect((await visit(f, sid)).status).toBe(302); // reload-after-restart resurrects nothing
  });

  it('a RESTARTED replica revokes sessions it never minted; re-login serves everywhere', async () => {
    const a = replica();
    const b = replica();
    const s1 = (await signIn(a, b)).sid;
    const s2 = (await signIn(b, a)).sid; // callback on A: minted THROUGH B
    const c = replica(); // 'restart': fresh graph that has seen NEITHER mint
    expect(await c.store.revokePrincipal(idp.issuer, 'mock-user-1')).toBe(2);
    for (const r of [a, b, c]) {
      expect((await visit(r, s1)).status).toBe(302);
      expect((await visit(r, s2)).status).toBe(302);
    }
    expect(await c.store.revokePrincipal(idp.issuer, 'mock-user-1')).toBe(0); // index gone: no phantom count
    const fresh = await signIn(a, b); // revoke kills sessions, never bans the principal
    expect((await visit(c, fresh.sid)).status).toBe(200); // the revoking generation serves it
    expect((await visit(b, fresh.sid)).status).toBe(200);
  });

  it('nuclear revoke is principal-surgical: mock-user-2 sessions survive on BOTH replicas', async () => {
    const a = replica();
    const b = replica();
    const u1 = await signIn(a, b); // default principal: mock-user-1
    idp.setPrincipal({ sub: 'mock-user-2', platformAdmin: true });
    const u2 = await signIn(b, a); // second identity on the same SEC-00 plane
    expect((await visit(a, u2.sid)).status).toBe(200);
    expect(await a.store.revokePrincipal(idp.issuer, 'mock-user-1')).toBe(1);
    expect((await visit(a, u1.sid)).status).toBe(302);
    expect((await visit(b, u1.sid)).status).toBe(302);
    expect((await visit(a, u2.sid)).status).toBe(200); // the innocent keeps its session
    expect((await visit(b, u2.sid)).status).toBe(200);
    expect(await b.store.revokePrincipal(idp.issuer, 'mock-user-2')).toBe(1); // revoked AT B…
    expect((await visit(a, u2.sid)).status).toBe(302); // …dies on A too
  });
});

describe('cross-process restart × expiry arbitration (W-OIDC02-REPLICA-1)', () => {
  it('absolute deadline rides the SHARED record: no long-TTL replica resurrects a short-TTL session', async () => {
    const short = replica({ absoluteTtlMs: 1_600, idleTtlMs: 1_600 });
    const veteran = replica(); // default 8h/30min — unrelated long-TTL peer
    const { sid } = await signIn(short, short); // expiresAt = mint + 1.6s, BAKED into the record
    expect((await visit(veteran, sid)).status).toBe(200); // in-date: the veteran serves the foreign record
    await new Promise((res) => setTimeout(res, 800));
    expect((await visit(veteran, sid)).status).toBe(200); // mid-life activity on the long-TTL peer…
    await new Promise((res) => setTimeout(res, 1_000)); // …~1.8s total > baked 1.6s, ≪ 30min idle
    const reborn = replica(); // RESTART generation, also long-TTL
    expect((await visit(veteran, sid)).status).toBe(302); // dead by the READER-INDEPENDENT deadline
    expect((await visit(reborn, sid)).status).toBe(302); // a long-TTL process cannot resurrect it
    expect((await visit(short, sid)).status).toBe(302);
    expect(await reborn.store.get(sid)).toBeNull();
  }, 20_000);

  it('idle clock is storage state: a restarted replica keeps alive what B touched', async () => {
    const tune = { absoluteTtlMs: 60_000, idleTtlMs: 1_200 };
    const a = replica(tune);
    const b = replica(tune);
    const { sid } = await signIn(a, b);
    await new Promise((res) => setTimeout(res, 700));
    expect((await visit(b, sid)).status).toBe(200); // B touches at ~0.7s
    const a2 = replica(tune); // A 'RESTARTS' right after B's touch
    await new Promise((res) => setTimeout(res, 700));
    expect((await visit(a2, sid)).status).toBe(200); // ~1.4s: 0.7s since the SHARED touch — a2 re-extends
    await new Promise((res) => setTimeout(res, 1_400)); // silence since a2's own touch > 1.2s idle
    expect((await visit(a2, sid)).status).toBe(302); // idle-dead for the restarted graph…
    expect((await visit(b, sid)).status).toBe(302); // …and for a stranger generation too
    const c2 = replica(tune);
    expect((await visit(c2, sid)).status).toBe(302);
  }, 20_000);
});

// ---------------------------------------------------------------------------
// DU_LIVE_INFRA === '1' — THE REAL TWO-PROCESS ACCEPTANCE (Tester-1 window).
// Skipped offline: NO child process, NO Redis connection, NO handle. The
// children (tests/fixtures/oidc02-replica-probe.js) boot the production
// router over their OWN loopback HTTP ports against the REAL Redis via
// createIoredisSessionGateway(REDIS_URL) — this suite then behaves like a
// browser: every hop is a real fetch; the du_session cookie is carried by
// hand between the two processes; only shared Redis connects them.
//
// Tester-1 runbook (separate window, NOT the lane):
//   cd du-rework/services/orchestrator
//   pnpm run build                       (probe boots from dist/)
//   set DU_LIVE_INFRA=1
//   set REDIS_URL=redis://127.0.0.1:6380 (the window's Redis)
//   pnpm --filter @du/orchestrator test:unit -- --runTestsByPath tests/oidc02-process-replicas-offline.test.ts
// Keys live under a per-run namespaced keyPrefix; cleanup is SIGTERM of
// the children + explicit per-test revocations — never FLUSHDB/SCAN.
// ---------------------------------------------------------------------------

const LIVE = process.env.DU_LIVE_INFRA === '1' || process.env.DU_LIVE_INFRA === 'true';
const LIVE_REDIS = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';

interface ProbeChild {
  port: number;
  proc: ChildProcess;
}

(LIVE ? describe : describe.skip)(`DU_LIVE_INFRA='1' — TWO REAL PROCESSES, real Redis`, () => {
  const runTag = 'lr-' + randomBytes(5).toString('hex');
  const probeToken = randomBytes(16).toString('hex');
  let a: ProbeChild;
  let b: ProbeChild;

  function spawnProbe(tuning: { absMs?: string; idleMs?: string } = {}): Promise<ProbeChild> {
    const { spawn } = require('node:child_process') as typeof import('node:child_process');
    return new Promise<ProbeChild>((resolve, reject) => {
      const proc = spawn(
        process.execPath,
        [join(__dirname, 'fixtures', 'oidc02-replica-probe.js')],
        {
          env: {
            ...process.env,
            PROBE_ISSUER: idp.issuer,
            REDIS_URL: LIVE_REDIS,
            PROBE_TOKEN: probeToken,
            PROBE_KEY_PREFIX: `du:admin:sess:${runTag}:`,
            PROBE_CHAL_PREFIX: `du:admin:chal:${runTag}:`,
            PROBE_ABS_MS: tuning.absMs ?? '60000',
            PROBE_IDLE_MS: tuning.idleMs ?? '5000',
            NO_PROXY: process.env.NO_PROXY ?? '127.0.0.1,localhost',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        }
      );
      const fail = (why: string) => {
        try { proc.kill('SIGKILL'); } catch { /* gone */ }
        reject(new Error('probe boot failed: ' + why));
      };
      const timer = setTimeout(() => fail('no LISTENING line within 20s (is dist/ built? is REDIS_URL reachable?)'), 20_000);
      let out = '';
      proc.stdout?.on('data', (chunk: Buffer) => {
        out += chunk.toString('utf8');
        const m = /LISTENING (\d+)/.exec(out);
        if (m) {
          clearTimeout(timer);
          resolve({ port: Number(m[1]), proc });
        }
      });
      proc.stderr?.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8');
        if (s.includes('PROBE_ERROR')) {
          clearTimeout(timer);
          fail(s.trim());
        }
      });
      proc.on('exit', (code) => {
        clearTimeout(timer);
        fail('exited early with code ' + String(code));
      });
    });
  }

  const base = (c: ProbeChild): string => 'http://127.0.0.1:' + c.port;
  // W49-QW1-LIVE-001 Tester receipt: every leg goes through the retrying
  // fetch — network-layer storms self-heal, HTTP statuses never retry.
  const get = (c: ProbeChild, path: string, cookie = ''): Promise<Response> =>
    fetchWithRetry(base(c) + path, { redirect: 'manual', headers: cookie ? { cookie } : {} });
  const post = (c: ProbeChild, path: string, cookie = ''): Promise<Response> =>
    fetchWithRetry(base(c) + path, { method: 'POST', redirect: 'manual', headers: { cookie } });
  const probeCall = (c: ProbeChild, path: string): Promise<Record<string, unknown>> =>
    fetchWithRetry(base(c) + path, { headers: { 'x-probe-token': probeToken } }).then(async (r) => (await r.json()) as Record<string, unknown>);

  /** Browser-shaped sign-in started at A, callback lands at B (LB skew). */
  async function mintLive(): Promise<{ sid: string }> {
    const login = await get(a, '/admin/login');
    expect(login.status).toBe(302);
    const idpLeg = await fetchWithRetry(login.headers.get('location') ?? '', { redirect: 'manual' });
    expect(idpLeg.status).toBe(302);
    const back = new URL(idpLeg.headers.get('location') ?? 'http://x/');
    const cb = await get(b, '/admin/oidc/callback?code=' + encodeURIComponent(back.searchParams.get('code') ?? '') + '&state=' + encodeURIComponent(back.searchParams.get('state') ?? ''));
    expect(cb.status).toBe(302);
    const sid = sidFrom(cb.headers.get('set-cookie') ?? undefined);
    if (!sid) throw new Error('live callback minted no cookie');
    return { sid };
  }

  beforeAll(async () => {
    [a, b] = await Promise.all([spawnProbe(), spawnProbe()]);
  }, 90_000);
  afterAll(() => {
    for (const c of [a, b]) {
      try { c?.proc.kill('SIGTERM'); } catch { /* already gone */ }
    }
  });

  it('mint through A callback-onto-B; BOTH processes resolve the cookie (real Redis, real procs)', async () => {
    const { sid } = await mintLive();
    for (const c of [a, b]) {
      const page = await get(c, '/admin', 'du_session=' + sid);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('<title>');
      const raw = await probeCall(c, '/__probe/session?sid=' + sid);
      expect(raw.live).toBe(true);
      expect(raw.role).toBe('admin');
    }
  }, 30_000);

  it('logout AT B kills the session for A (server-side, cross-process)', async () => {
    const { sid } = await mintLive();
    const out = await post(b, '/admin/logout', 'du_session=' + sid);
    expect(out.status).toBe(302);
    expect(out.headers.get('location')).toBe('/admin/login');
    expect(out.headers.get('set-cookie') ?? '').toContain('du_session=;');
    expect((await probeCall(a, '/__probe/session?sid=' + sid)).live).toBe(false);
    const bounced = await get(a, '/admin', 'du_session=' + sid);
    expect(bounced.status).toBe(302);
  }, 30_000);

  it('rotation through B: old cookie dead on BOTH processes, rotated live on BOTH', async () => {
    const { sid } = await mintLive();
    const rotated = await probeCall(b, '/__probe/rotate?sid=' + sid);
    expect(typeof rotated.sid).toBe('string');
    const sid2 = rotated.sid as string;
    for (const c of [a, b]) {
      expect((await get(c, '/admin', 'du_session=' + sid)).status).toBe(302);
      expect((await get(c, '/admin', 'du_session=' + sid2)).status).toBe(200);
    }
  }, 30_000);

  it('idle expiry on the REAL clock evicts on every process (idle 5s window)', async () => {
    const { sid } = await mintLive();
    expect((await get(a, '/admin', 'du_session=' + sid)).status).toBe(200);
    await new Promise((res) => setTimeout(res, 5_600)); // > 5s idle, < 60s absolute
    expect((await get(a, '/admin', 'du_session=' + sid)).status).toBe(302);
    expect((await get(b, '/admin', 'du_session=' + sid)).status).toBe(302);
  }, 40_000);

  // Reviewer audit 150-155 — the two live legs the block lacked: NUCLEAR
  // REVOKE across real processes, and a RESTART probe that is a genuinely
  // NEW OS process over the same shared Redis (the offline replica() graph
  // swap, but with real process churn).
  const LIVE_SUB = 'mock-user-1'; // the mock IdP's only principal — every minted session belongs to it

  function waitForExit(proc: ChildProcess, ms = 10_000): Promise<void> {
    return new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      proc.once('exit', () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  it('nuclear revoke AT A (principal index in real Redis) kills BOTH sessions on BOTH processes', async () => {
    const first = await mintLive();
    const second = await mintLive();
    for (const sid of [first.sid, second.sid]) {
      for (const c of [a, b]) {
        expect((await probeCall(c, '/__probe/session?sid=' + sid)).live).toBe(true);
      }
    }
    const rev = await probeCall(a, '/__probe/revoke?sub=' + LIVE_SUB);
    expect(typeof rev.count).toBe('number');
    // LOWER bound only: both fresh sids are in this run's p: index, but
    // earlier tests' keys still sit under the 60s absolute TTL until DELed.
    expect(Number(rev.count)).toBeGreaterThanOrEqual(2);
    for (const sid of [first.sid, second.sid]) {
      for (const c of [a, b]) {
        expect((await probeCall(c, '/__probe/session?sid=' + sid)).live).toBe(false);
        expect((await get(c, '/admin', 'du_session=' + sid)).status).toBe(302);
      }
    }
  }, 30_000);

  it('RESTART (third real process, same Redis): serves pre-restart sessions; revoked-before-restart stays dead', async () => {
    const survivor = await mintLive();
    let c: ProbeChild | undefined;
    try {
      // A RESTART here is literal: new OS process, fresh component graph,
      // fresh gateway connection — only the shared Redis carries the state.
      c = await spawnProbe();
      expect((await probeCall(c, '/__probe/session?sid=' + survivor.sid)).live).toBe(true);
      expect((await get(c, '/admin', 'du_session=' + survivor.sid)).status).toBe(200);
      const doomed = await mintLive();
      // Revoke EXECUTED BY THE RESTARTED PROCESS reaches a session it never
      // minted (shared principal index) — and wipes its own pre-restart one.
      const rev = await probeCall(c, '/__probe/revoke?sub=' + LIVE_SUB);
      expect(Number(rev.count)).toBeGreaterThanOrEqual(2); // doomed + survivor, both live now
      for (const sid of [doomed.sid, survivor.sid]) {
        for (const proc of [a, b, c]) {
          expect((await probeCall(proc, '/__probe/session?sid=' + sid)).live).toBe(false);
        }
      }
    } finally {
      if (c) {
        try {
          c.proc.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        await waitForExit(c.proc); // no orphan pipes into the next test / jest exit
      }
    }
  }, 45_000);

  // W-OIDC02-LIVE-1R (reassignment) — the (b) leg the block still lacked:
  // a REAL kill (SIGKILL, crash semantics — no graceful close, no local
  // state left behind) + RESPAWN of process B, then BOTH halves of the
  // restart contract: (b.1) an IN-DATE session is still valid on the fresh
  // process — only shared Redis connects the two generations; (b.2) an
  // EXPIRED session dies after respawn — and dies on the peers that never
  // restarted either, because the absolute deadline rides in the SHARED
  // record (createdAt+TTL baked at mint), so a long-TTL process can never
  // resurrect a short-TTL session it never minted. (a) cross-replica
  // revoke was already covered above (nuclear-revoke-at-A leg).
  it('KILL + RESPAWN process B: in-date session still valid; expired one dies everywhere', async () => {
    const survivor = await mintLive();
    const victim = b;
    let respawned: ProbeChild | undefined;
    let shortGen: ProbeChild | undefined;
    try {
      victim.proc.kill('SIGKILL'); // crash, not shutdown: the point of the scenario
      await waitForExit(victim.proc);
      respawned = await spawnProbe();
      b = respawned; // afterAll now owns the live handle
      // (b.1) in-date survives real process death + fresh boot:
      expect((await probeCall(respawned, '/__probe/session?sid=' + survivor.sid)).live).toBe(true);
      expect((await get(respawned, '/admin', 'du_session=' + survivor.sid)).status).toBe(200);
      expect((await get(a, '/admin', 'du_session=' + survivor.sid)).status).toBe(200); // A untouched — sanity
      // (b.2) mint THROUGH a short-TTL generation (abs 2s), let its stored
      // absolute deadline pass, then prove death on ALL processes:
      shortGen = await spawnProbe({ absMs: '2000', idleMs: '1500' });
      b = shortGen; // mintLive's callback leg lands on the short-TTL process
      const doomed = await mintLive();
      b = respawned; // normal checks back on a standard-TTL process
      expect((await get(shortGen, '/admin', 'du_session=' + doomed.sid)).status).toBe(200); // live at mint
      await new Promise((res) => setTimeout(res, 2_300)); // > baked 2s absolute deadline
      expect((await probeCall(shortGen, '/__probe/session?sid=' + doomed.sid)).live).toBe(false);
      expect((await get(shortGen, '/admin', 'du_session=' + doomed.sid)).status).toBe(302);
      expect((await get(a, '/admin', 'du_session=' + doomed.sid)).status).toBe(302); // long-TTL peer refuses
      expect((await get(respawned, '/admin', 'du_session=' + doomed.sid)).status).toBe(302);
    } finally {
      b = respawned ?? b; // keep the pair slot pointing at a live-or-dead handle afterAll can ignore
      if (shortGen) {
        try {
          shortGen.proc.kill('SIGTERM');
        } catch {
          /* already gone */
        }
        await waitForExit(shortGen.proc); // no orphan pipes into jest teardown
      }
    }
  }, 90_000);
});

