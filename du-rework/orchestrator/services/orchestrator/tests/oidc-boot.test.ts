import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildOidcAdminComponents } from '../src/app/admin/oidc-boot';
import type { RedisSessionGateway } from '../src/modules/auth/redis-session-repository';
import { FakeRedisSessionGateway } from './stubs/fake-redis-gateway';
import { startMockOidcIdp, type MockOidcIdp } from './stubs/mock-oidc-idp';

/**
 * CYCLE-108/113 REVIEW (finding 2): the DU_ADMIN_OIDC_* boot wiring that
 * main.ts feeds into createApp. OFFLINE — the only socket is the loopback
 * mock IdP. Proves the fail-closed boot contract (off | all | throw,
 * never half-mounted) and that a complete env yields a login flow that
 * really reaches the configured IdP. W-SEC-OIDC04-PROXY-1 adds the
 * delta-26 cookie Secure policy legs (env parse, boot refusal, wiring).
 */

let idp: MockOidcIdp;

beforeAll(async () => {
  process.env.NO_PROXY = '127.0.0.1,localhost';
  idp = await startMockOidcIdp();
});
afterAll(async () => {
  await idp?.close();
});

const REDIRECT = 'http://localhost:2023/admin/oidc/callback';

function baseEnv(): Record<string, string | undefined> {
  return {
    DU_ADMIN_OIDC_ISSUER: idp.issuer,
    DU_ADMIN_OIDC_CLIENT_ID: 'du-admin',
    DU_ADMIN_OIDC_CLIENT_SECRET: 'boot-secret',
    DU_ADMIN_OIDC_REDIRECT_URI: REDIRECT,
  };
}

describe('oidc-boot: env gate', () => {
  it('no OIDC env at all -> null: the pre-OIDC surfaces stay untouched', () => {
    expect(buildOidcAdminComponents({})).toBeNull();
  });
  it('partial config -> refuse to boot, naming every missing var', () => {
    let err: Error | undefined;
    try {
      buildOidcAdminComponents({ DU_ADMIN_OIDC_ISSUER: idp.issuer });
    } catch (e) { err = e as Error; }
    expect(err).toBeInstanceOf(Error);
    expect(err!.message).toContain('partially configured');
    expect(err!.message).toContain('DU_ADMIN_OIDC_CLIENT_ID');
    expect(err!.message).toContain('DU_ADMIN_OIDC_REDIRECT_URI');
    expect(err!.message).toContain('DU_ADMIN_OIDC_CLIENT_SECRET_FILE');
  });
  it('a mounted secret file wins and must be non-empty (runbook secret-file rule)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'oidc-boot-'));
    const good = join(dir, 'secret');
    writeFileSync(good, '  file-secret  \n', 'utf8');
    const env: Record<string, string | undefined> = { ...baseEnv(), DU_ADMIN_OIDC_CLIENT_SECRET_FILE: good };
    delete env.DU_ADMIN_OIDC_CLIENT_SECRET;
    expect(buildOidcAdminComponents(env)).not.toBeNull();
    const blank = join(dir, 'blank');
    writeFileSync(blank, '   ', 'utf8');
    expect(() =>
      buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_OIDC_CLIENT_SECRET_FILE: blank })
    ).toThrow(/secret file is empty/);
  });
  it('DU_ADMIN_OIDC_PKCE_METHOD only accepts S256 — never a silent downgrade', () => {
    expect(() =>
      buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_OIDC_PKCE_METHOD: 'plain' })
    ).toThrow(/S256/);
    expect(buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_OIDC_PKCE_METHOD: 's256' })).not.toBeNull();
  });
  it('issuer must sit inside the allowed-issuers list (exact-match allowlist)', () => {
    expect(buildOidcAdminComponents({
      ...baseEnv(),
      DU_ADMIN_OIDC_ALLOWED_ISSUERS: 'https://other.example.invalid,' + idp.issuer,
    })).not.toBeNull();
    expect(() =>
      buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_OIDC_ALLOWED_ISSUERS: 'https://only.other/' })
    ).toThrow(/allowedIssuers/);
  });
  it('non-loopback http issuer is rejected at boot (https-only policy)', () => {
    expect(() =>
      buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_OIDC_ISSUER: 'http://idp.production.example' })
    ).toThrow(/https/);
  });
});

describe('oidc-boot: a complete env yields a LIVE flow', () => {
  it('handleLogin 302s to the configured IdP /authorize with S256 PKCE over real discovery', async () => {
    const c = buildOidcAdminComponents(baseEnv());
    expect(c).not.toBeNull();
    const res = await c!.adminOidcFlow.handleLogin({
      method: 'GET',
      path: '/admin/login',
      query: {},
      cookies: {},
    });
    expect(res.status).toBe(302);
    const url = new URL(res.headers['location'] ?? '');
    expect(url.origin + url.pathname).toBe(idp.url + '/authorize');
    expect(url.searchParams.get('client_id')).toBe('du-admin');
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // fresh boot = empty store; unknown ids resolve through the AdminSessionStore seam
    expect(await c!.adminSessionStore.get('u'.repeat(43))).toBeNull();
  });
});

describe('session backend selector (OIDC-02 persistent store)', () => {
  it("default is memory and NO gateway is ever constructed", () => {
    let built = 0;
    const c = buildOidcAdminComponents(baseEnv(), {
      createRedisGateway: () => { built += 1; return new FakeRedisSessionGateway(); },
    });
    expect(c).not.toBeNull();
    expect(built).toBe(0);
    expect(c!.close).toBeUndefined();
  });

  it("unknown backend value refuses to boot (no silent fallback)", () => {
    expect(() =>
      buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_OIDC_SESSION_BACKEND: 'postgres' })
    ).toThrow(/DU_ADMIN_OIDC_SESSION_BACKEND/);
  });

  it("backend=redis WITHOUT REDIS_URL refuses to boot", () => {
    expect(() =>
      buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_OIDC_SESSION_BACKEND: 'redis' })
    ).toThrow(/REDIS_URL/);
  });

  it('backend=redis mints the session THROUGH the injected gateway and resolves it back', async () => {
    const fake = new FakeRedisSessionGateway();
    let seenUrl = '';
    const c = buildOidcAdminComponents(
      { ...baseEnv(), DU_ADMIN_OIDC_SESSION_BACKEND: 'redis', REDIS_URL: 'redis://127.0.0.1:6390' },
      { createRedisGateway: (url) => { seenUrl = url; return fake; } }
    );
    expect(c).not.toBeNull();
    expect(seenUrl).toBe('redis://127.0.0.1:6390');
    // Full browser-shaped round-trip against the mock IdP:
    const login = await c!.adminOidcFlow.handleLogin({ method: 'GET', path: '/admin/login', query: {}, cookies: {} });
    const loginUrl = new URL(login.headers['location'] ?? '');
    const back = await fetch(loginUrl.toString(), { redirect: 'manual' });
    const cb = new URL(back.headers.get('location') ?? '');
    const res = await c!.adminOidcFlow.handleCallback({
      method: 'GET',
      path: '/admin/oidc/callback',
      query: { code: cb.searchParams.get('code') ?? '', state: cb.searchParams.get('state') ?? '' },
      cookies: {},
    });
    expect(res.status).toBe(302);
    const sid = /du_session=([A-Za-z0-9_-]{43})/.exec(res.headers['set-cookie'] ?? '')?.[1] ?? '';
    expect(sid.length).toBe(43);
    // THE persistence proof: the record lives in the gateway (namespaced key
    // with a real TTL), not in the process that minted it.
    const view = await c!.adminSessionStore.get(sid);
    expect(view).not.toBeNull();
    expect(view!.role).toBe('admin');
    expect(fake.ttlSeconds('du:admin:sess:s:' + sid)).toBe(8 * 3600);
    // shutdown chain owns the connection
    expect(typeof c!.close).toBe('function');
    await c!.close!();
    expect(fake.closed).toBe(true);
  });
  it("REDIS_URL present with NO explicit backend auto-wires redis (sessions AND challenges)", async () => {
    const fake = new FakeRedisSessionGateway();
    let built = 0;
    const c = buildOidcAdminComponents(
      { ...baseEnv(), REDIS_URL: 'redis://127.0.0.1:6391' },
      { createRedisGateway: () => { built += 1; return fake; } }
    );
    expect(c).not.toBeNull();
    expect(built).toBe(1);
    expect(typeof c!.close).toBe('function');
    const login = await c!.adminOidcFlow.handleLogin({ method: 'GET', path: '/admin/login', query: {}, cookies: {} });
    const state = new URL(login.headers['location'] ?? '').searchParams.get('state') ?? '';
    expect(state.length).toBeGreaterThanOrEqual(43);
    // challenge lives in SHARED storage under its hashed key, ~10min TTL
    const chalKey = 'du:admin:chal:' + createHash('sha256').update(state, 'ascii').digest('hex');
    expect(fake.ttlSeconds(chalKey)).toBe(600);
    expect(fake.allKeys().every((k) => !k.includes(state))).toBe(true); // no plaintext state key
  });

  it("explicit 'memory' pins per-process EVEN WHEN REDIS_URL is set (deployments decide, not luck)", () => {
    let built = 0;
    const c = buildOidcAdminComponents(
      { ...baseEnv(), REDIS_URL: 'redis://127.0.0.1:6391', DU_ADMIN_OIDC_SESSION_BACKEND: 'memory' },
      { createRedisGateway: () => { built += 1; return new FakeRedisSessionGateway(); } }
    );
    expect(c).not.toBeNull();
    expect(built).toBe(0);
    expect(c!.close).toBeUndefined();
  });

  it('CROSS-REPLICA LOGIN: replica A starts the flow, replica B finishes it; second attempt 403s', async () => {
    const shared = new FakeRedisSessionGateway();
    const deps = { createRedisGateway: () => shared };
    const env = { ...baseEnv(), DU_ADMIN_OIDC_SESSION_BACKEND: 'redis', REDIS_URL: 'redis://127.0.0.1:6392' };
    const a = buildOidcAdminComponents(env, deps)!;
    const b = buildOidcAdminComponents(env, deps)!;
    // A mints the challenge:
    const login = await a.adminOidcFlow.handleLogin({ method: 'GET', path: '/admin/login', query: {}, cookies: {} });
    const loginUrl = new URL(login.headers['location'] ?? '');
    const back = await fetch(loginUrl.toString(), { redirect: 'manual' }); // browser leg via mock IdP
    const cb = new URL(back.headers.get('location') ?? '');
    const code = cb.searchParams.get('code') ?? '';
    const state = cb.searchParams.get('state') ?? '';
    // B (different process, shared Redis) completes the callback:
    const mint = await b.adminOidcFlow.handleCallback({
      method: 'GET', path: '/admin/oidc/callback', query: { code, state }, cookies: {},
    });
    expect(mint.status).toBe(302);
    const sid = /du_session=([A-Za-z0-9_-]{43})/.exec(mint.headers['set-cookie'] ?? '')?.[1] ?? '';
    expect(sid.length).toBe(43);
    // the SESSION B minted authenticates THROUGH A (shared store is the point):
    const view = await a.adminSessionStore.get(sid);
    expect(view).not.toBeNull();
    expect(view!.role).toBe('admin');
    // the challenge was ONE-SHOT across replicas — a replay on B (or a
    // racing callback on A) hits the same 403 denial shape:
    const replayB = await b.adminOidcFlow.handleCallback({
      method: 'GET', path: '/admin/oidc/callback', query: { code, state }, cookies: {},
    });
    expect(replayB.status).toBe(403);
    await a.close!();
    await b.close!();
    expect(shared.closed).toBe(true);
  });

  // ROOT-CAUSE FIX (Tester-1 mintLive 500): the cold-connect race. The
  // redis backend must surface gateway.ready() so main.ts can await it
  // BEFORE listen; gateways without a connect phase (fakes, memory) must
  // leave components.ready ABSENT, never a fake promise.
  it("memory backend exposes NO ready() (no connect phase to await)", () => {
    const c = buildOidcAdminComponents(baseEnv());
    expect(c).not.toBeNull();
    expect(c!.ready).toBeUndefined();
  });

  it('redis backend surfaces the gateway ready() exactly once and it resolves', async () => {
    const inner = new FakeRedisSessionGateway();
    let readyCalls = 0;
    const gw: RedisSessionGateway = {
      get: (k) => inner.get(k),
      set: (k, v, t) => inner.set(k, v, t),
      del: (...k) => inner.del(...k),
      sadd: (k, m) => inner.sadd(k, m),
      srem: (k, m) => inner.srem(k, m),
      smembers: (k) => inner.smembers(k),
      expire: (k, t) => inner.expire(k, t),
      getdel: (k) => inner.getdel(k),
      close: async () => inner.close(),
      ready: async () => { readyCalls += 1; },
    };
    const c = buildOidcAdminComponents(
      { ...baseEnv(), DU_ADMIN_OIDC_SESSION_BACKEND: 'redis', REDIS_URL: 'redis://127.0.0.1:6393' },
      { createRedisGateway: () => gw }
    );
    expect(c).not.toBeNull();
    expect(typeof c!.ready).toBe('function');
    await c!.ready!();
    expect(readyCalls).toBe(1);
    // and the plane still works after readiness:
    const view = await c!.adminSessionStore.get('z'.repeat(43));
    expect(view).toBeNull();
    await c!.close!();
    expect(inner.closed).toBe(true);
  });
});

describe('cookie Secure policy (W-SEC-OIDC04-PROXY-1, delta-26)', () => {
  const PROD = { NODE_ENV: 'production' };
  it('production + http public origin + no proxy trust refuses to boot (an insecure mint must be impossible)', () => {
    expect(() => buildOidcAdminComponents({ ...baseEnv(), ...PROD }))
      .toThrow(/WITHOUT the Secure flag/);
  });
  it('production + DU_ADMIN_TRUST_PROXY_PROTOCOL=true boots — per-request XFP becomes the TLS proof', () => {
    expect(buildOidcAdminComponents({ ...baseEnv(), ...PROD, DU_ADMIN_TRUST_PROXY_PROTOCOL: 'true' })).not.toBeNull();
  });
  it('production + https public origin boots without any proxy knob', () => {
    expect(buildOidcAdminComponents({
      ...baseEnv(), ...PROD, DU_ADMIN_OIDC_PUBLIC_ORIGIN: 'https://admin.example.test',
    })).not.toBeNull();
  });
  it("enforce raises the bar OUTSIDE production; 'auto' can NEVER opt out INSIDE it", () => {
    expect(() => buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_COOKIE_SECURE: 'enforce' }))
      .toThrow(/WITHOUT the Secure flag/);
    expect(buildOidcAdminComponents({
      ...baseEnv(), DU_ADMIN_COOKIE_SECURE: 'enforce', DU_ADMIN_TRUST_PROXY_PROTOCOL: '1',
    })).not.toBeNull();
    expect(() => buildOidcAdminComponents({ ...baseEnv(), ...PROD, DU_ADMIN_COOKIE_SECURE: 'auto' }))
      .toThrow(/WITHOUT the Secure flag/);
    expect(buildOidcAdminComponents({ ...baseEnv(), NODE_ENV: 'development', DU_ADMIN_COOKIE_SECURE: 'auto' })).not.toBeNull();
  });
  it('garbage knob values are boot errors, never silent defaults (mirrors the PKCE S256 rule)', () => {
    expect(() => buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_COOKIE_SECURE: 'yes' }))
      .toThrow(/DU_ADMIN_COOKIE_SECURE/);
    expect(() => buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_TRUST_PROXY_PROTOCOL: 'maybe' }))
      .toThrow(/DU_ADMIN_TRUST_PROXY_PROTOCOL/);
    expect(buildOidcAdminComponents({ ...baseEnv(), DU_ADMIN_TRUST_PROXY_PROTOCOL: '0', DU_ADMIN_COOKIE_SECURE: '' })).not.toBeNull();
  });
  it('the parsed policy REACHES the mounted flow: enforce+trust mints Secure ONLY on proven legs', async () => {
    const c = buildOidcAdminComponents({
      ...baseEnv(), NODE_ENV: 'development', DU_ADMIN_COOKIE_SECURE: 'enforce', DU_ADMIN_TRUST_PROXY_PROTOCOL: 'true',
    })!;
    const login = await c.adminOidcFlow.handleLogin({ method: 'GET', path: '/admin/login', query: {}, cookies: {} });
    const back = await fetch(new URL(login.headers['location'] ?? '').toString(), { redirect: 'manual' });
    const cb = new URL(back.headers.get('location') ?? '');
    const req = {
      method: 'GET',
      path: '/admin/oidc/callback',
      query: { code: cb.searchParams.get('code') ?? '', state: cb.searchParams.get('state') ?? '' },
      cookies: {},
    };
    // Unproven TLS: denied BEFORE the exchange — challenge and code stay
    // live, so a recovered proxy header can complete the SAME login.
    const unproven = await c.adminOidcFlow.handleCallback({ ...req });
    expect(unproven.status).toBe(403);
    expect(unproven.headers['set-cookie']).toBeUndefined();
    const proven = await c.adminOidcFlow.handleCallback({ ...req, forwardedProto: 'https' });
    expect(proven.status).toBe(302);
    const cookie = proven.headers['set-cookie'] ?? '';
    expect(cookie).toContain('Secure');
    const sid = /du_session=([A-Za-z0-9_-]{43})/.exec(cookie)?.[1] ?? '';
    expect(sid.length).toBe(43);
    expect(await c.adminSessionStore.get(sid)).not.toBeNull();
  });
});

