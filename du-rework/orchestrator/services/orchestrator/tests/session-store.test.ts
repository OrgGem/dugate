import {
  buildSessionCookie,
  buildSessionClearCookie,
  createMemorySessionRepository,
  createSessionStore,
  isValidSessionId,
  principalFromSession,
  sessionToActionAuth,
  SessionError,
  verifySessionCsrf,
  SESSION_COOKIE_NAME,
  type SessionRecord,
  type SessionRepository,
} from '../src/modules/auth/session-store';

/**
 * OIDC-02 / SEC-02 session-store offline suite. Fake clocks + an in-memory
 * repository behind the SAME SessionRepository seam a Redis/DB adapter
 * would implement: two stores over one map == two replicas. Zero DB, zero
 * Redis, zero sockets (the dispatch's hard rule).
 */

const T0 = Date.UTC(2026, 8, 25, 6, 0, 0);
const MIN = 60_000;

function world(overrides: { absoluteTtlMs?: number; idleTtlMs?: number } = {}) {
  let clock = T0;
  const base = createMemorySessionRepository();
  let repoGets = 0;
  const repo: SessionRepository & { size(): number } = {
    async get(id) {
      repoGets += 1;
      return base.get(id);
    },
    set: (s) => base.set(s),
    delete: (id) => base.delete(id),
    revokePrincipal: (iss, sub) => base.revokePrincipal!(iss, sub),
    size: () => base.size(),
  };
  const store = createSessionStore({
    repo,
    now: () => clock,
    absoluteTtlMs: overrides.absoluteTtlMs ?? 60 * MIN,
    idleTtlMs: overrides.idleTtlMs ?? 10 * MIN,
  });
  const advance = (ms: number) => {
    clock += ms;
  };
  return { store, repo, advance, get repoGets() { return repoGets; }, clock: () => clock };
}

const ID_ADMIN = { issuer: 'http://localhost:9999/realm/du', sub: 'u-admin', role: 'admin' } as const;
const ID_OP = { issuer: 'http://localhost:9999/realm/du', sub: 'u-op', role: 'operator', tenantId: 'ten-a' } as const;

describe('OIDC-02 lifecycle', () => {
  it('create mints opaque id + server-side record with full metadata', async () => {
    const w = world();
    const s = await w.store.create(ID_OP);
    expect(isValidSessionId(s.sessionId)).toBe(true);
    expect(s).toMatchObject({ issuer: ID_OP.issuer, sub: 'u-op', tenantId: 'ten-a', role: 'operator' });
    expect(s.expiresAt).toBe(T0 + 60 * MIN);
    expect(s.csrfToken).not.toBe(s.sessionId);
    expect(w.repo.size()).toBe(1);
  });
  it('invalid identities are refused (incl. operator-without-tenant default-deny)', async () => {
    const w = world();
    await expect(w.store.create({ issuer: '', sub: 'x', role: 'admin' })).rejects.toBeInstanceOf(SessionError);
    await expect(w.store.create({ issuer: 'i', sub: '', role: 'admin' })).rejects.toThrow(/issuer and sub/);
    await expect(w.store.create({ issuer: 'i', sub: 'x', role: 'operator' })).rejects.toThrow(/operator-requires-tenant|operator/);
    expect(w.repo.size()).toBe(0);
  });
  it('get touches lastSeenAt but NEVER extends absolute expiry', async () => {
    const w = world();
    const s = await w.store.create(ID_ADMIN);
    w.advance(5 * MIN);
    const g = await w.store.get(s.sessionId);
    expect(g!.lastSeenAt).toBe(T0 + 5 * MIN);
    expect(g!.expiresAt).toBe(T0 + 60 * MIN);
    expect(g!.createdAt).toBe(T0);
  });
  it('idle expiry evicts; absolute expiry evicts', async () => {
    const w = world();
    const a = await w.store.create(ID_ADMIN);
    w.advance(10 * MIN + 1);
    expect(await w.store.get(a.sessionId)).toBeNull();
    expect(w.repo.size()).toBe(0);
    const b = await w.store.create(ID_ADMIN);
    w.advance(6 * MIN);
    await w.store.get(b.sessionId); // touch: idle stays open
    w.advance(6 * MIN); // 12min into life, absolute deadline passed (60min? no —) 
    // absoluteTtl = 60 MIN, so instead jump straight past the deadline:
    w.advance(48 * MIN + 59_000);
    expect(await w.store.get(b.sessionId)).toBeNull();
    expect(w.repo.size()).toBe(0);
  });
  it('hostile ids never reach the repository', async () => {
    const w = world();
    const before = w.repoGets;
    for (const bad of ['', 'short', 'a'.repeat(44), 'x'.repeat(42) + '!', 'has space123456789012345678901234']) {
      expect(await w.store.get(bad)).toBeNull();
    }
    expect(w.repoGets).toBe(before); // storage untouched by garbage
    // well-FORMED but unknown ids -> ONE null path, indistinguishable from
    // expired (the reason expiry also returns plain null):
    for (const forged of ['B'.repeat(43), 'A'.repeat(41) + '_-']) {
      expect(await w.store.get(forged)).toBeNull();
    }
    expect(w.repoGets).toBe(before + 2);
  });
});

describe('OIDC-02 rotation / logout / revoke / replicas / restart', () => {
  it('rotate after login defeats fixation: new id lives, old id is DEAD', async () => {
    const w = world();
    const pre = await w.store.create(ID_ADMIN); // pre-login cookie
    const post = await w.store.rotate(pre.sessionId);
    expect(post!.sessionId).not.toBe(pre.sessionId);
    expect(post!.sub).toBe(pre.sub);
    expect(post!.csrfToken).toBe(pre.csrfToken); // double-submit pair stays valid
    expect(post!.expiresAt).toBe(pre.expiresAt); // rotation cannot extend life
    expect(post!.createdAt).toBe(pre.createdAt);
    expect(await w.store.get(pre.sessionId)).toBeNull();
    expect(await w.store.get(post!.sessionId)).not.toBeNull();
  });
  it('rotate on a dead id is null and creates nothing', async () => {
    const w = world();
    expect(await w.store.rotate('x'.repeat(43))).toBeNull();
    expect(w.repo.size()).toBe(0);
  });
  it('destroy is immediate + idempotent; clear-cookie kills it client-side too', async () => {
    const w = world();
    const s = await w.store.create(ID_ADMIN);
    expect(await w.store.destroy(s.sessionId)).toBe(true);
    expect(await w.store.get(s.sessionId)).toBeNull();
    expect(await w.store.destroy(s.sessionId)).toBe(false);
    expect(buildSessionClearCookie({ secure: true })).toContain('Max-Age=0');
  });
  it('revokePrincipal nukes ALL sessions of the subject and nothing else', async () => {
    const w = world();
    const a1 = await w.store.create(ID_ADMIN);
    const a2 = await w.store.create({ ...ID_ADMIN, role: 'viewer' });
    const other = await w.store.create({ issuer: ID_ADMIN.issuer, sub: 'u-other', role: 'admin' });
    expect(await w.store.revokePrincipal(ID_ADMIN.issuer, 'u-admin')).toBe(2);
    expect(await w.store.get(a1.sessionId)).toBeNull();
    expect(await w.store.get(a2.sessionId)).toBeNull();
    expect(await w.store.get(other.sessionId)).not.toBeNull();
  });
  it('revokePrincipal fails CLOSED when the repository cannot index principals', async () => {
    let clock = T0;
    const bare: SessionRepository = {
      get: async () => null,
      set: async () => undefined,
      delete: async () => false,
    };
    const store = createSessionStore({ repo: bare, now: () => clock });
    await expect(store.revokePrincipal('i', 's')).rejects.toThrow(/revoke-principal-unsupported/);
    void clock;
  });
  it('two replicas over one repository: B uses A session, B rotation kills A copy, A revoke kills B view', async () => {
    const clock = { t: T0 };
    const shared = createMemorySessionRepository();
    const A = createSessionStore({ repo: shared, now: () => clock.t });
    const B = createSessionStore({ repo: shared, now: () => clock.t });
    const s = await A.create(ID_OP);
    expect((await B.get(s.sessionId))!.sub).toBe('u-op');
    const rotated = (await B.rotate(s.sessionId))!;
    expect(await A.get(s.sessionId)).toBeNull(); // fixation cookie dead on BOTH replicas
    expect(await A.get(rotated.sessionId)).not.toBeNull();
    expect(await A.destroy(rotated.sessionId)).toBe(true);
    expect(await B.get(rotated.sessionId)).toBeNull();
  });
  it('restart (new store over same repo) keeps live sessions, never resurrects revoked ones', async () => {
    const w = world();
    const keep = await w.store.create(ID_ADMIN);
    const gone = await w.store.create(ID_OP);
    await w.store.destroy(gone.sessionId);
    const restarted = createSessionStore({ repo: w.repo, now: () => T0 + MIN });
    expect((await restarted.get(keep.sessionId))!.sub).toBe('u-admin');
    expect(await restarted.get(gone.sessionId)).toBeNull();
  });
});

describe('OIDC-02 CSRF + cookie + principal mapping', () => {
  async function fresh(): Promise<{ s: SessionRecord; w: ReturnType<typeof world> }> {
    const w = world();
    return { s: await w.store.create(ID_OP), w };
  }
  it('verifySessionCsrf: exact match only, constant-time path', async () => {
    const { s } = await fresh();
    expect(verifySessionCsrf(s, s.csrfToken)).toBe(true);
    expect(verifySessionCsrf(s, 'x'.repeat(43))).toBe(false);
    expect(verifySessionCsrf(s, '')).toBe(false);
    expect(verifySessionCsrf(s, undefined)).toBe(false);
    expect(verifySessionCsrf(s, s.csrfToken + 'z')).toBe(false);
  });
  it('cookie carries ONLY the opaque id with SEC-02 posture (Lax + HttpOnly + Secure on https)', async () => {
    const { s, w } = await fresh();
    const cookie = buildSessionCookie(s, { secure: true, nowMs: w.clock() });
    expect(cookie).toContain(SESSION_COOKIE_NAME + '=' + s.sessionId);
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax'); // IdP redirect = top-level GET
    expect(cookie).toContain('Secure');
    expect(cookie).toContain('Path=/');
    expect(cookie).toContain('Max-Age=' + Math.floor((s.expiresAt - w.clock()) / 1000));
    expect(cookie).not.toContain(s.csrfToken); // the CSRF secret NEVER rides in the cookie
    expect(cookie).not.toContain('u-op'); // nor the subject
  });
  it('principalFromSession: admin->platform, operator+tenant->scoped, operator-without-tenant->null, viewer->null', async () => {
    const { s } = await fresh();
    expect(principalFromSession(s)).toEqual({ role: 'tenant_operator', tenantId: 'ten-a' });
    const { s: adm } = await fresh();
    expect(principalFromSession({ ...adm, role: 'admin' })).toEqual({ role: 'platform' });
    expect(principalFromSession({ ...adm, role: 'operator', tenantId: null })).toBeNull();
    expect(principalFromSession({ ...adm, role: 'viewer' })).toBeNull();
  });
  it('sessionToActionAuth feeds the cycle-84 dispatcher gate directly', async () => {
    const { s } = await fresh();
    // CYCLE-108/113: the stored tenant rides into the dispatcher context.
    // Δ8/T-AUD-01: the stored principal (issuer/sub) rides along too, for
    // ledger attribution — pinned explicitly, never dropped silently.
    expect(sessionToActionAuth(s, s.csrfToken)).toEqual({
      kind: 'cookie',
      role: 'operator',
      tenantId: 'ten-a',
      csrfOk: true,
      principalId: s.sub,
      issuer: s.issuer,
    });
    const wrong = sessionToActionAuth(s, 'wrong-token-0000000000000000000000000000000000000000000');
    expect(wrong.kind).toBe('cookie');
    if (wrong.kind === 'cookie') expect(wrong.csrfOk).toBe(false);
    const none = sessionToActionAuth(s, undefined);
    if (none.kind === 'cookie') expect(none.csrfOk).toBe(false);
  });
});

describe('OIDC-02 store config sanity', () => {
  it('refuses absurd TTLs at construction', () => {
    expect(() => createSessionStore({ repo: createMemorySessionRepository(), absoluteTtlMs: 25 * 3_600_000 })).toThrow(SessionError);
    expect(() => createSessionStore({ repo: createMemorySessionRepository(), absoluteTtlMs: 1000, idleTtlMs: 5000 })).toThrow(/idleTtlMs/);
  });
});
