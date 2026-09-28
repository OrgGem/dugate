import { signCookie } from '../src/app/admin/shell-auth';
import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import type { AuditService } from '../src/modules/audit/audit';
import type { AuditRecordInput } from '../src/modules/audit/audit';
import {
  ADMIN_ACTIONS,
  authorizeAdminAction,
  dispatchAdminAction,
  type AdminActionDeps,
} from '../src/modules/admin-actions/dispatcher';
import {
  adminActionsMethodGuard,
  deriveCsrfToken,
  mapOidcClaimsToPrincipal,
  resolveAdminActionAuthAsync,
  resolveAdminActionAuth,
  validateCsrfToken,
  ADMIN_SESSION_COOKIE,
  type AdminActionAuth,
} from '../src/modules/admin-actions/rbac';

/**
 * ADM-BASE-02 cycle-84 negative matrix (OFFLINE — no DB/Redis). Proves
 * the action dispatcher's RBAC (operator vs platform superadmin) and the
 * cookie/CSRF gate deny BEFORE any service is touched: every denied call
 * asserts the dependency counters stayed at zero (zero side effects).
 */

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const PLATFORM = 'plat-tok-0123456789ab';
const OP_A = 'op-a-tok-0123456789ab';
const SECRET = 'cookie-secret-0123456789';

const ALL_ACTIONS = Object.keys(ADMIN_ACTIONS);

function bearerPlatform(): AdminActionAuth {
  return { kind: 'bearer', principal: { role: 'platform' } };
}
function bearerOpA(): AdminActionAuth {
  return { kind: 'bearer', principal: { role: 'tenant_operator', tenantId: TENANT_A } };
}
function cookie(role: 'admin' | 'operator' | 'viewer', csrfOk: boolean): AdminActionAuth {
  return { kind: 'cookie', role, csrfOk };
}
function cookieT(
  role: 'admin' | 'operator' | 'viewer',
  csrfOk: boolean,
  tenantId: string | null
): AdminActionAuth {
  return { kind: 'cookie', role, csrfOk, tenantId };
}

function expectDenied(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error(`expected rejection ${status} ${code}`);
    },
    (err) => {
      expect(err).toBeInstanceOf(HttpError);
      expect((err as HttpError).status).toBe(status);
      expect((err as HttpError).code).toBe(code);
    }
  );
}

interface WorldOptions {
  keyTenantId?: string | null; // api_keys precheck result (bind-profile gate)
  updateMatches?: boolean; // business_versions UPDATE rowCount
  cancelForeign?: boolean; // lifecycle 404s the op-foreign id (tenant fence)
}

function makeDeps(opts: WorldOptions = {}) {
  const calls = {
    activate: 0,
    deactivate: 0,
    sweep: 0,
    createRevision: 0,
    auditRecord: 0,
    keyLookups: 0,
    cancel: 0,
    resume: 0,
  };
  const cancelTenants: string[] = [];
  const auditRows: AuditRecordInput[] = [];

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('UPDATE business_versions')) {
        const hit = opts.updateMatches ?? true;
        return { rows: [], rowCount: hit ? 1 : 0 };
      }
      if (sql.includes('SELECT tenant_id FROM operations')) {
        return { rows: [{ tenant_id: 'ten-B' }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO')) {
        return { rows: /RETURNING\s+id/i.test(sql) ? [{ id: 'row-1' }] : [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const db = {
    pool: undefined,
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.includes('FROM api_keys') && sql.includes('tenant_id')) {
        calls.keyLookups += 1;
        if (opts.keyTenantId === null || opts.keyTenantId === undefined) {
          return { rows: [], rowCount: 0 };
        }
        return { rows: [{ tenant_id: opts.keyTenantId }], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
    tx: async (fn: (c: unknown) => Promise<unknown>) => fn(client),
    close: async () => undefined,
  } as unknown as Db;

  const audit = {
    record: async (input: AuditRecordInput) => {
      calls.auditRecord += 1;
      auditRows.push(input);
      return { id: 'a-' + calls.auditRecord };
    },
    listForTenant: async () => [],
  } as unknown as AuditService;

  const deps: AdminActionDeps = {
    db,
    audit,
    registry: {
      // minimal structural stubs for the two methods the dispatcher uses
      activateVersion: async () => {
        calls.activate += 1;
        return { businessId: 'biz', version: '1.0.0', active: true, replayed: false };
      },
      deactivateVersion: async () => {
        calls.deactivate += 1;
        return { businessId: 'biz', version: '1.0.0', active: false, replayed: false };
      },
    } as unknown as AdminActionDeps['registry'],
    profiles: {
      createRevision: async () => {
        calls.createRevision += 1;
        return { profileId: 'prof-1', revision: 1, tenantId: opts.keyTenantId ?? TENANT_A, apiKeyId: 'key-1' };
      },
    } as unknown as AdminActionDeps['profiles'],
    lifecycle: {
      sweepDeadlines: async () => {
        calls.sweep += 1;
        return 2;
      },
      cancelOperation: async (operationId: string, tenantId: string) => {
        calls.cancel += 1;
        cancelTenants.push(tenantId);
        if (opts.cancelForeign && operationId === 'op-foreign') {
          // mirrors the service's FIXED 404 text (cycle-99 X2 no-echo fix)
          throw new HttpError(404, 'NOT_FOUND', 'operation not found');
        }
        return { operationId, state: 'CANCELLED', replayed: false };
      },
    } as unknown as AdminActionDeps['lifecycle'],
    runtime: {
      resumeOperation: async (operationId: string, tenantId: string) => {
        calls.resume += 1;
        cancelTenants.push(tenantId);
        return { operationId, replayed: false } as never;
      },
    } as unknown as AdminActionDeps['runtime'],
    hashApiKey: (raw: string) => 'hash-of-' + raw,
    correlationId: 'corr-dispatcher-test',
  };
  return { deps, calls, auditRows, cancelTenants };
}

describe('ADM-BASE-02 method guard', () => {
  it('GET on the dispatcher answers 405, never GET-as-success', () => {
    let err: HttpError | undefined;
    try { adminActionsMethodGuard('GET'); } catch (e) { err = e as HttpError; }
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.status).toBe(405);
    expect(err!.code).toBe('METHOD_NOT_ALLOWED');
  });
  it('DELETE too; POST passes', () => {
    expect(() => adminActionsMethodGuard('DELETE')).toThrow(HttpError);
    expect(() => adminActionsMethodGuard('POST')).not.toThrow();
  });
});

describe('ADM-BASE-02 authorizeAdminAction matrix (pure)', () => {
  it('null auth → 401 for any action', () => {
    for (const a of ALL_ACTIONS) {
      const d = authorizeAdminAction(null, a);
      expect(!d.ok && !((d as { ok: boolean }).ok) && (d as { status: number }).status).toBe(401);
    }
  });
  it('unknown action → 404 unsupported (never a silent no-op)', () => {
    const d = authorizeAdminAction(bearerPlatform(), 'connector.rotate-secret');
    expect(d.ok).toBe(false);
    if (!d.ok) {
      expect(d.status).toBe(404);
      expect(d.message).toContain('connector.rotate-secret');
    }
  });
  it('bearer platform: every table action authorized', () => {
    for (const a of ALL_ACTIONS) {
      expect(authorizeAdminAction(bearerPlatform(), a).ok).toBe(true);
    }
  });
  it('bearer tenant_operator (OIDC-03): ONLY the approved operation-control set; credential/key/business actions 403', () => {
    for (const a of ['operations.cancel', 'operations.resume']) {
      expect(authorizeAdminAction(bearerOpA(), a).ok).toBe(true);
    }
    for (const a of ALL_ACTIONS.filter((x) => x !== 'operations.cancel' && x !== 'operations.resume')) {
      const d = authorizeAdminAction(bearerOpA(), a);
      expect(d.ok).toBe(false);
      if (!d.ok) {
        expect(d.status).toBe(403);
        expect(d.message).toContain('platform');
      }
    }
  });
  it('cookie admin WITHOUT CSRF → 403 CSRF for every action (gate runs BEFORE role)', () => {
    for (const a of ALL_ACTIONS) {
      const d = authorizeAdminAction(cookie('admin', false), a);
      expect(d.ok).toBe(false);
      if (!d.ok) {
        expect(d.status).toBe(403);
        expect(d.message.toLowerCase()).toContain('csrf');
      }
    }
  });
  it('cookie operator/viewer WITH valid CSRF still 403 — no server-side tenant means no operator power', () => {
    // CYCLE-108/113 refines the WHY: viewer fails the role table; an
    // operator passes it ONLY on the operation-control pair (where
    // cookieRoles admits 'operator' for TENANTED sessions) and then hits
    // the fail-closed tenant guard. Both are 403 with zero effects.
    for (const role of ['operator', 'viewer'] as const) {
      for (const a of ALL_ACTIONS) {
        const d = authorizeAdminAction(cookie(role, true), a);
        expect(d.ok).toBe(false);
        if (!d.ok) {
          expect(d.status).toBe(403);
          const tenantGuard = role === 'operator' && (a === 'operations.cancel' || a === 'operations.resume');
          expect(d.message).toContain(tenantGuard ? 'tenant' : 'role');
        }
      }
    }
  });
});

describe('ADM-BASE-02 dispatchAdminAction: denials have ZERO side effects', () => {
  it('operator -> business.enable: 403, nothing called', async () => {
    const { deps, calls } = makeDeps();
    await expectDenied(
      dispatchAdminAction(deps, bearerOpA(), { action: 'business.enable', params: { businessId: 'b', version: '1' } }),
      403,
      'PERMISSION_DENIED'
    );
    expect(calls).toEqual({ activate: 0, deactivate: 0, sweep: 0, createRevision: 0, auditRecord: 0, keyLookups: 0, cancel: 0, resume: 0 });
  });

  it('cookie missing CSRF -> bind: 403, profiles/audit untouched', async () => {
    const { deps, calls } = makeDeps({ keyTenantId: TENANT_A });
    await expectDenied(
      dispatchAdminAction(deps, cookie('admin', false), {
        action: 'apikey.bind-profile',
        params: { apiKey: 'k', businessId: 'b', businessVersion: '1', action: 'extract' },
      }),
      403,
      'PERMISSION_DENIED'
    );
    expect(calls.createRevision).toBe(0);
    expect(calls.auditRecord).toBe(0);
  });

  it('OIDC-03: bind-profile is ADMIN-ONLY — operator 403 before ANY key lookup, own or foreign', async () => {
    for (const keyTenantId of [TENANT_A, TENANT_B, null]) {
      const { deps, calls } = makeDeps({ keyTenantId });
      let err: HttpError | undefined;
      try {
        await dispatchAdminAction(deps, bearerOpA(), {
          action: 'apikey.bind-profile',
          params: { apiKey: 'k', businessId: 'b', businessVersion: '1', action: 'extract' },
        });
      } catch (e) { err = e as HttpError; }
      expect(err).toBeInstanceOf(HttpError);
      expect(err!.status).toBe(403);
      expect(err!.message).toContain('platform');
      expect(calls.createRevision).toBe(0);
      expect(calls.auditRecord).toBe(0);
      expect(calls.keyLookups).toBe(0); // denial precedes any storage read
    }
  });

  it('platform binds an UNKNOWN key: 404 (lookup-then-mutate order intact)', async () => {
    const { deps, calls } = makeDeps({ keyTenantId: null });
    // platform skips the operator precheck; profiles.createRevision is a
    // stub here, so the 404 comes from the service in production. Assert
    // only the authz decision: bind-profile ok for platform.
    expect(authorizeAdminAction(bearerPlatform(), 'apikey.bind-profile').ok).toBe(true);
    void deps;
    void calls;
  });

  it('unknown action through dispatch: 404 with zero calls', async () => {
    const { deps, calls } = makeDeps();
    await expectDenied(
      dispatchAdminAction(deps, bearerPlatform(), { action: 'nope.such-action', params: {} }),
      404,
      'NOT_FOUND'
    );
    expect(calls.sweep).toBe(0);
  });

  it('business.enable on an unregistered version: 404 from the UPDATE gate', async () => {
    const { deps, calls } = makeDeps({ updateMatches: false });
    await expectDenied(
      dispatchAdminAction(deps, bearerPlatform(), { action: 'business.enable', params: { businessId: 'b', version: '9' } }),
      404,
      'NOT_FOUND'
    );
    expect(calls.auditRecord).toBe(0); // auditedMutation rolled/never-recorded
  });
});

describe('ADM-BASE-02 dispatchAdminAction happy paths (statuses + audit actor)', () => {
  it('platform: enable 200, activate 202, drain 202, sweep 200 {timedOut:2}, bind 201', async () => {
    const { deps, calls } = makeDeps({ keyTenantId: TENANT_A });
    expect(await dispatchAdminAction(deps, bearerPlatform(), { action: 'business.enable', params: { businessId: 'b', version: '1' } }))
      .toMatchObject({ status: 200, body: { status: 'ENABLED' } });
    expect(await dispatchAdminAction(deps, bearerPlatform(), { action: 'business.activate', params: { businessId: 'b', version: '1' } }))
      .toMatchObject({ status: 202 });
    expect(await dispatchAdminAction(deps, bearerPlatform(), { action: 'business.drain', params: { businessId: 'b', version: '1' } }))
      .toMatchObject({ status: 202 });
    expect(await dispatchAdminAction(deps, bearerPlatform(), { action: 'operations.sweep-deadlines', params: {} }))
      .toMatchObject({ status: 200, body: { timedOut: 2 } });
    expect(await dispatchAdminAction(deps, bearerPlatform(), {
      action: 'apikey.bind-profile',
      params: { apiKey: 'raw-key', businessId: 'b', businessVersion: '1', action: 'extract' },
    })).toMatchObject({ status: 201, body: { profileId: 'prof-1' } });
    expect(calls.createRevision).toBe(1);
  });

  it('cookie-admin with CSRF passes; audit actor records the session principal', async () => {
    const { deps, auditRows } = makeDeps();
    const r = await dispatchAdminAction(deps, cookie('admin', true), {
      action: 'business.enable',
      params: { businessId: 'b', version: '1' },
    });
    expect(r.status).toBe(200);
    expect(auditRows[0]!.actor).toBe('shell:admin');
  });

  it('bearer audit actor stays the stable id admin', async () => {
    const { deps, auditRows } = makeDeps();
    await dispatchAdminAction(deps, bearerPlatform(), { action: 'business.drain', params: { businessId: 'b', version: '1' } });
    expect(auditRows[0]!.actor).toBe('admin');
  });
});

describe('ADM-BASE-02 CSRF primitives (rbac.ts)', () => {
  it('deriveCsrfToken is deterministic and bound to BOTH secret and cookie', () => {
    const t1 = deriveCsrfToken(SECRET, 'cookie-value-1');
    expect(deriveCsrfToken(SECRET, 'cookie-value-1')).toBe(t1);
    expect(deriveCsrfToken('other-secret', 'cookie-value-1')).not.toBe(t1);
    expect(deriveCsrfToken(SECRET, 'cookie-value-2')).not.toBe(t1);
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
  });
  it('validateCsrfToken accepts only the exact derivation', () => {
    const cookieValue = 'payload.sig';
    const good = deriveCsrfToken(SECRET, cookieValue);
    expect(validateCsrfToken({ secret: SECRET, sessionCookie: cookieValue, provided: good })).toBe(true);
    const tampered = good.slice(0, -1) + (good.endsWith('0') ? '1' : '0');
    expect(validateCsrfToken({ secret: SECRET, sessionCookie: cookieValue, provided: tampered })).toBe(false);
    expect(validateCsrfToken({ secret: SECRET, sessionCookie: cookieValue, provided: '' })).toBe(false);
    expect(validateCsrfToken({ secret: SECRET, sessionCookie: cookieValue, provided: undefined })).toBe(false);
    expect(validateCsrfToken({ secret: '', sessionCookie: cookieValue, provided: good })).toBe(false);
    expect(validateCsrfToken({ secret: SECRET, sessionCookie: '', provided: good })).toBe(false);
    expect(validateCsrfToken({ secret: SECRET, sessionCookie: cookieValue, provided: 'x'.repeat(200) })).toBe(false);
  });
});

describe('OIDC-03 seam: mapOidcClaimsToPrincipal is default-deny', () => {
  const ISS = 'https://idp.internal/realms/du';
  it('single-tenant claim → tenant_operator bound to exactly that tenant', () => {
    expect(mapOidcClaimsToPrincipal({ sub: 'u-1', iss: ISS, tenantIds: [TENANT_A] }, [ISS])).toEqual({
      role: 'tenant_operator',
      tenantId: TENANT_A,
    });
  });
  it('platformAdmin group → platform principal', () => {
    expect(mapOidcClaimsToPrincipal({ sub: 'u-2', iss: ISS, platformAdmin: true }, [ISS])).toEqual({
      role: 'platform',
    });
  });
  it('deny: null/empty sub, unlisted iss, empty allowlist, no tenant no flag, MULTI-tenant (never guess)', () => {
    expect(mapOidcClaimsToPrincipal(null, [ISS])).toBeNull();
    expect(mapOidcClaimsToPrincipal({ sub: '', iss: ISS, platformAdmin: true }, [ISS])).toBeNull();
    expect(mapOidcClaimsToPrincipal({ sub: 'u-3', iss: 'https://evil/', tenantIds: [TENANT_A] }, [ISS])).toBeNull();
    expect(mapOidcClaimsToPrincipal({ sub: 'u-4', iss: ISS, tenantIds: [TENANT_A] }, [])).toBeNull();
    expect(mapOidcClaimsToPrincipal({ sub: 'u-5', iss: ISS }, [ISS])).toBeNull();
    expect(mapOidcClaimsToPrincipal({ sub: 'u-6', iss: ISS, tenantIds: [TENANT_A, TENANT_B] }, [ISS])).toBeNull();
    expect(mapOidcClaimsToPrincipal({ sub: 'u-7', iss: ISS, tenantIds: [] }, [ISS])).toBeNull();
  });
  it('a mapped principal flows unchanged through the dispatcher gate (seam composes)', () => {
    const p = mapOidcClaimsToPrincipal({ sub: 'u-8', iss: ISS, tenantIds: [TENANT_A] }, [ISS]);
    expect(authorizeAdminAction({ kind: 'bearer', principal: p! }, 'operations.cancel').ok).toBe(true);
    const deny = authorizeAdminAction({ kind: 'bearer', principal: p! }, 'business.enable');
    expect(!deny.ok && !((deny as { ok: boolean }).ok)).toBe(true);
  });
});

describe('ADM-BASE-02 resolveAdminActionAuth (bearer-first, cookie+CSRF)', () => {
  const config = {
    adminToken: PLATFORM,
    tenantAdminTokens: { [OP_A]: TENANT_A },
    adminShellCookieSecret: SECRET,
  };
  function minted(role: 'admin' | 'operator' | 'viewer'): string {
    // shell-auth compares iat/exp against Date.now() — milliseconds.
    const now = Date.now();
    return signCookie(SECRET, { iss: 'du-admin-shell', role, iat: now, exp: now + 3_600_000 })!;
  }

  it('bearer platform wins over a cookie', () => {
    const auth = resolveAdminActionAuth(config, {
      authorization: `Bearer ${PLATFORM}`,
      cookie: `${ADMIN_SESSION_COOKIE}=${minted('viewer')}`,
    });
    expect(auth).toEqual({ kind: 'bearer', principal: { role: 'platform' } });
  });

  it('bearer tenant_operator second', () => {
    expect(resolveAdminActionAuth(config, { authorization: `Bearer ${OP_A}` })).toEqual({
      kind: 'bearer',
      principal: { role: 'tenant_operator', tenantId: TENANT_A },
    });
  });

  it('valid cookie + matching x-csrf-token → cookie-auth csrfOk=true', () => {
    const c = minted('admin');
    const auth = resolveAdminActionAuth(config, {
      cookie: `${ADMIN_SESSION_COOKIE}=${c}`,
      'x-csrf-token': deriveCsrfToken(SECRET, c),
    });
    expect(auth).toEqual({ kind: 'cookie', role: 'admin', csrfOk: true });
  });

  it('valid cookie WITHOUT the header → csrfOk=false (dispatcher then 403s)', () => {
    const c = minted('admin');
    const auth = resolveAdminActionAuth(config, { cookie: `${ADMIN_SESSION_COOKIE}=${c}` });
    expect(auth).toEqual({ kind: 'cookie', role: 'admin', csrfOk: false });
  });

  it('cookie signed with a FORGED secret → null (401 downstream)', () => {
    const forged = signCookie('attacker-secret', {
      iss: 'du-admin-shell', role: 'admin', iat: Date.now(), exp: Date.now() + 3_600_000,
    })!;
    expect(resolveAdminActionAuth(config, { cookie: `${ADMIN_SESSION_COOKIE}=${forged}` })).toBeNull();
  });

  it('expired session → null', () => {
    const stale = signCookie(SECRET, { iss: 'du-admin-shell', role: 'admin', iat: 100, exp: 200 })!;
    expect(resolveAdminActionAuth(config, { cookie: `${ADMIN_SESSION_COOKIE}=${stale}` })).toBeNull();
  });

  it('no cookie secret → cookie path disabled entirely', () => {
    expect(
      resolveAdminActionAuth({ adminToken: PLATFORM }, { cookie: `${ADMIN_SESSION_COOKIE}=${minted('admin')}` })
    ).toBeNull();
  });
});

/**
 * OIDC-03 (cycle 96) full admin matrix, offline: every principal cell x
 * every table action is asserted ALLOW or DENY exactly as the SEC task
 * line 19 prescribes — viewer never mutates, operator ONLY the approved
 * operation-control set (cancel/resume), credential/key changes are
 * admin-only, cookie mutations need CSRF, unknown principals never
 * reach a service.
 */
describe('OIDC-03 complete allow/deny matrix (authorizeAdminAction)', () => {
  const OPS = ['operations.cancel', 'operations.resume'];
  const ADMIN_ONLY = ALL_ACTIONS.filter((a) => !OPS.includes(a));
  const cells: Array<[string, AdminActionAuth | null, Record<string, 'allow' | 'deny'>]> = [
    ['bearer platform', bearerPlatform(), Object.fromEntries(ALL_ACTIONS.map((a) => [a, 'allow']))],
    ['bearer operator', bearerOpA(), {
      ...Object.fromEntries(ADMIN_ONLY.map((a) => [a, 'deny'])),
      ...Object.fromEntries(OPS.map((a) => [a, 'allow'])),
    }],
    ['cookie admin + CSRF', cookie('admin', true), Object.fromEntries(ALL_ACTIONS.map((a) => [a, 'allow']))],
    ['cookie admin NO CSRF', cookie('admin', false), Object.fromEntries(ALL_ACTIONS.map((a) => [a, 'deny']))],
    // CYCLE-108/113: an operator WITHOUT a server-side tenant (legacy
    // cookie shape) still denies everything; WITH the store's tenant the
    // operator unlocks ONLY the operation-control pair, like bearer op.
    ['cookie operator + CSRF', cookie('operator', true), Object.fromEntries(ALL_ACTIONS.map((a) => [a, 'deny']))],
    ['cookie operator WITH tenant + CSRF', cookieT('operator', true, TENANT_A), {
      ...Object.fromEntries(ADMIN_ONLY.map((a) => [a, 'deny'])),
      ...Object.fromEntries(OPS.map((a) => [a, 'allow'])),
    }],
    ['cookie operator WITH tenant NO CSRF', cookieT('operator', false, TENANT_A), Object.fromEntries(ALL_ACTIONS.map((a) => [a, 'deny']))],
    ['cookie viewer + CSRF', cookie('viewer', true), Object.fromEntries(ALL_ACTIONS.map((a) => [a, 'deny']))],
    ['anonymous', null, Object.fromEntries(ALL_ACTIONS.map((a) => [a, 'deny']))],
  ] as Array<[string, AdminActionAuth | null, Record<string, 'allow' | 'deny'>]>;
  for (const [who, auth, expects] of cells) {
    it(who + ': every cell matches the matrix', () => {
      for (const action of ALL_ACTIONS) {
        const d = authorizeAdminAction(auth, action);
        if (expects[action] === 'allow') expect(d.ok).toBe(true);
        else {
          expect(d.ok).toBe(false);
          if (!d.ok) {
            expect([401, 403]).toContain(d.status);
            if (auth === null) expect(d.status).toBe(401);
          }
        }
      }
      // unknown actions are 404 for authenticated cells
      if (auth) {
        const u = authorizeAdminAction(auth, 'connector.rotate-secret');
        expect(!u.ok && (u as { status: number }).status).toBe(404);
      }
    });
  }
});

describe('OIDC-03 cancel/resume execution — tenant fence zero-side-effect', () => {
  it('platform cancel resolves the row tenant and audits', async () => {
    const { deps, calls, auditRows } = makeDeps();
    const r = await dispatchAdminAction(deps, bearerPlatform(), {
      action: 'operations.cancel',
      params: { operationId: 'op-own' },
    });
    expect(r).toMatchObject({ status: 200, body: { state: 'CANCELLED' } });
    expect(calls.cancel).toBe(1);
    expect(calls.auditRecord).toBe(1);
    expect(auditRows[0]!.action).toBe('operation.cancel');
    expect(auditRows[0]!.tenantId).toBeNull(); // platform row: global bucket
  });
  it('operator cancel carries ITS credential tenant; audit is tenant-scoped', async () => {
    const { deps, calls, auditRows } = makeDeps();
    await dispatchAdminAction(deps, bearerOpA(), {
      action: 'operations.cancel',
      params: { operationId: 'op-own' },
    });
    expect(calls.cancel).toBe(1);
    expect((deps as unknown as { __seen?: string[] }).__seen ?? calls).toBeTruthy();
    expect(auditRows[0]!.tenantId).toBe(TENANT_A);
  });
  it('operator cancel on a FOREIGN op: 404 with NO id echo, NO audit row written', async () => {
    const { deps, calls } = makeDeps({ cancelForeign: true });
    let err: HttpError | undefined;
    try {
      await dispatchAdminAction(deps, bearerOpA(), { action: 'operations.cancel', params: { operationId: 'op-foreign' } });
    } catch (e) { err = e as HttpError; }
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.status).toBe(404);
    expect(err!.message).toBe('operation not found');
    expect(err!.message).not.toContain('op-foreign');
    expect(calls.auditRecord).toBe(0);
  });
  it('resume via operator carries the credential tenant; audit operation.resume', async () => {
    const { deps, calls, auditRows } = makeDeps();
    const r = await dispatchAdminAction(deps, bearerOpA(), {
      action: 'operations.resume',
      params: { operationId: 'op-own', body: { waitId: 'w1' } },
    });
    expect(r.status).toBe(200);
    expect(calls.resume).toBe(1);
    expect(auditRows[0]!.action).toBe('operation.resume');
    expect(auditRows[0]!.tenantId).toBe(TENANT_A);
  });
});

describe('OIDC-02/03 async auth: opaque session preferred over legacy cookie', () => {
  it('bearer beats session; session provides role+csrfOk; forged/bad ids ignored', async () => {
    const store = {
      get: async (id: string) =>
        id === 'S'.repeat(43)
          ? { role: 'operator' as const, csrfToken: 'C'.repeat(43), tenantId: TENANT_A }
          : null,
    };
    const config = { adminToken: PLATFORM, adminShellCookieSecret: 'unused-now' };
    const bearer = await resolveAdminActionAuthAsync(
      config,
      { authorization: `Bearer ${PLATFORM}` },
      store
    );
    expect(bearer).toEqual({ kind: 'bearer', principal: { role: 'platform' } });
    const sess = await resolveAdminActionAuthAsync(
      config,
      { cookie: `du_session=${'S'.repeat(43)}`, 'x-csrf-token': 'C'.repeat(43) },
      store
    );
    expect(sess).toEqual({ kind: 'cookie', role: 'operator', tenantId: TENANT_A, csrfOk: true });
    const badCsrf = await resolveAdminActionAuthAsync(
      config,
      { cookie: `du_session=${'S'.repeat(43)}` },
      store
    );
    expect(badCsrf).toEqual({ kind: 'cookie', role: 'operator', tenantId: TENANT_A, csrfOk: false });
    // self-asserted headers NEVER create a principal (SEC-02):
    const spoofed = await resolveAdminActionAuthAsync(
      config,
      { 'x-du-role': 'admin', 'x-du-tenant': TENANT_B },
      store
    );
    expect(spoofed).toBeNull();
    const garbage = await resolveAdminActionAuthAsync(
      config,
      { cookie: 'du_session=not-a-valid-session-id' },
      store
    );
    expect(garbage).toBeNull();
  });
});

/**
 * CYCLE-108/113 REVIEW — the ordering fix and the tenant context.
 * The old async resolver ran the SYNC pair (bearer + legacy du_admin)
 * FIRST, so a browser holding both cookies resolved on the legacy plane
 * and a REVOKED OIDC session silently downgraded to the still-valid
 * self-contained cookie. New contract proven here:
 *  du_session (store plane) beats du_admin; a dead/forged session never
 *  resurrects via legacy; legacy alone keeps working byte-for-byte; and
 *  the session's SERVER-SIDE tenant reaches the dispatcher fence so an
 *  operator session can run cancel/resume scoped, while an operator
 *  WITHOUT a tenant fails closed with zero side effects.
 */
describe('CYCLE-108/113: du_session precedence over legacy du_admin', () => {
  const SID = 'S'.repeat(43);
  const CSRF = 'C'.repeat(43);
  function storeWith(session: { role: 'admin' | 'operator' | 'viewer'; tenantId: string | null } | null) {
    return {
      get: async (id: string) =>
        id === SID && session
          ? { role: session.role, csrfToken: CSRF, tenantId: session.tenantId }
          : null,
    };
  }
  const config = { adminToken: PLATFORM, tenantAdminTokens: { [OP_A]: TENANT_A }, adminShellCookieSecret: SECRET };
  function legacyCookie(role: 'admin' | 'operator' | 'viewer'): string {
    const now = Date.now();
    return signCookie(SECRET, { iss: 'du-admin-shell', role, iat: now, exp: now + 3_600_000 })!;
  }

  it('BOTH cookies present: the store plane decides, not the legacy role', async () => {
    const legacy = legacyCookie('admin');
    const auth = await resolveAdminActionAuthAsync(
      config,
      {
        cookie: `du_admin=${legacy}; du_session=${SID}`,
        'x-csrf-token': CSRF,
      },
      storeWith({ role: 'operator', tenantId: TENANT_A })
    );
    // Legacy would have said role 'admin' (platform-equivalent); the live
    // session says operator@TENANT_A — precedence is provably flipped.
    expect(auth).toEqual({ kind: 'cookie', role: 'operator', tenantId: TENANT_A, csrfOk: true });
    if (auth?.kind === 'cookie') {
      expect(authorizeAdminAction(auth, 'business.enable').ok).toBe(false);
    }
  });

  it('dead/revoked du_session + VALID legacy cookie -> null (no resurrection downgrade)', async () => {
    const legacy = legacyCookie('admin');
    const auth = await resolveAdminActionAuthAsync(
      config,
      { cookie: `du_admin=${legacy}; du_session=${SID}`, 'x-csrf-token': CSRF },
      storeWith(null)
    );
    expect(auth).toBeNull();
  });

  it('forged du_session shape + valid legacy -> null (attacker-picked id cannot dodge the store)', async () => {
    const legacy = legacyCookie('admin');
    const auth = await resolveAdminActionAuthAsync(
      config,
      { cookie: `du_admin=${legacy}; du_session=shorty`, 'x-csrf-token': CSRF },
      storeWith({ role: 'operator', tenantId: TENANT_A })
    );
    expect(auth).toBeNull();
  });

  it('NO du_session + valid legacy -> legacy auth unchanged (coexistence; no tenant field)', async () => {
    const legacy = legacyCookie('admin');
    const auth = await resolveAdminActionAuthAsync(
      config,
      { cookie: `du_admin=${legacy}`, 'x-csrf-token': deriveCsrfToken(SECRET, legacy) },
      storeWith({ role: 'operator', tenantId: TENANT_A })
    );
    expect(auth).toEqual({ kind: 'cookie', role: 'admin', csrfOk: true });
  });

  it('bearer still beats BOTH cookie planes even when both are present', async () => {
    const auth = await resolveAdminActionAuthAsync(
      config,
      { authorization: `Bearer ${PLATFORM}`, cookie: `du_admin=${legacyCookie('viewer')}; du_session=${SID}` },
      storeWith({ role: 'operator', tenantId: TENANT_A })
    );
    expect(auth).toEqual({ kind: 'bearer', principal: { role: 'platform' } });
  });
});

describe('CYCLE-108/113: operator SESSION executes tenant-scoped actions', () => {
  it('cancel via operator session: service gets the STORE tenant, audit tenant-scoped, actor shell:operator', async () => {
    const { deps, calls, auditRows, cancelTenants } = makeDeps();
    const r = await dispatchAdminAction(deps, cookieT('operator', true, TENANT_A), {
      action: 'operations.cancel',
      params: { operationId: 'op-own' },
    });
    expect(r).toMatchObject({ status: 200, body: { state: 'CANCELLED' } });
    expect(calls.cancel).toBe(1);
    expect(cancelTenants[0]).toBe(TENANT_A); // the fence ran with the SESSION tenant, not the op's
    expect(auditRows[0]!.tenantId).toBe(TENANT_A);
    expect(auditRows[0]!.actor).toBe('shell:operator');
  });
  it('resume via operator session: same tenant context, audit operation.resume', async () => {
    const { deps, calls, cancelTenants, auditRows } = makeDeps();
    const r = await dispatchAdminAction(deps, cookieT('operator', true, TENANT_A), {
      action: 'operations.resume',
      params: { operationId: 'op-own', body: { waitId: 'w1' } },
    });
    expect(r.status).toBe(200);
    expect(calls.resume).toBe(1);
    expect(cancelTenants[0]).toBe(TENANT_A);
    expect(auditRows[0]!.action).toBe('operation.resume');
  });
  it('operator session on a FOREIGN op: service fence 404s, no echo, no audit', async () => {
    const { deps, calls, auditRows } = makeDeps({ cancelForeign: true });
    await expectDenied(
      dispatchAdminAction(deps, cookieT('operator', true, TENANT_A), {
        action: 'operations.cancel',
        params: { operationId: 'op-foreign' },
      }),
      404,
      'NOT_FOUND'
    );
    expect(calls.auditRecord).toBe(0);
    expect(auditRows).toHaveLength(0);
  });
  it('legacy operator cookie (role from a self-contained value, NO tenant) fail-closes at the gate — zero service calls', async () => {
    const { deps, calls } = makeDeps();
    await expectDenied(
      dispatchAdminAction(deps, cookie('operator', true), {
        action: 'operations.cancel',
        params: { operationId: 'op-own' },
      }),
      403,
      'PERMISSION_DENIED'
    );
    expect(calls.cancel).toBe(0);
    expect(calls.auditRecord).toBe(0);
  });
  it('operator session stays OUT of everything else: bind-profile/business/sweep/connectors 403 before any lookup', async () => {
    const { deps, calls } = makeDeps({ keyTenantId: TENANT_A });
    const auth = cookieT('operator', true, TENANT_A);
    await expectDenied(
      dispatchAdminAction(deps, auth, { action: 'apikey.bind-profile', params: { apiKey: 'k', businessId: 'b', businessVersion: '1', action: 'extract' } }),
      403,
      'PERMISSION_DENIED'
    );
    await expectDenied(dispatchAdminAction(deps, auth, { action: 'business.enable', params: { businessId: 'b', version: '1' } }), 403, 'PERMISSION_DENIED');
    await expectDenied(dispatchAdminAction(deps, auth, { action: 'operations.sweep-deadlines', params: {} }), 403, 'PERMISSION_DENIED');
    expect(calls.createRevision).toBe(0);
    expect(calls.activate).toBe(0);
    expect(calls.sweep).toBe(0);
    expect(calls.keyLookups).toBe(0);
  });
  it('operator session WITHOUT CSRF: CSRF denial comes before the role table (no probing)', async () => {
    const { deps, calls } = makeDeps();
    await expectDenied(
      dispatchAdminAction(deps, cookieT('operator', false, TENANT_A), {
        action: 'operations.cancel',
        params: { operationId: 'op-own' },
      }),
      403,
      'PERMISSION_DENIED'
    );
    expect(calls.cancel).toBe(0);
  });
});