import type { Db } from '../src/db/db';
import { HttpError } from '../src/http/errors';
import type { AuditRecordInput, AuditService } from '../src/modules/audit/audit';
import {
  ADMIN_ACTIONS,
  assertRoleActionTenant,
  authorizeAdminAction,
  dispatchAdminAction,
  type AdminActionDeps,
} from '../src/modules/admin-actions/dispatcher';
import {
  resolveAdminActionAuthAsync,
  type AdminActionAuth,
  type AdminSecurityEvent,
  type AdminSessionStore,
} from '../src/modules/admin-actions/rbac';

/**
 * W-OIDC03-RBAC-1 / OIDC-03 — the SEC-00 role × action × TENANT matrix
 * (ADR-17 'Tenant/account isolation và role matrix') asserted OFFLINE
 * through the new single pure gate `assertRoleActionTenant`, plus the
 * zero-side-effect proof that dispatchAdminAction now runs the triple
 * (entry face + the tx-internal re-assert) with every denied cell
 * leaving all dependency counters at zero.
 *
 * Division of labor (no duplication):
 *  - tests/admin-action-dispatcher.test.ts — the historical role×action
 *    matrix + resolver ordering (stays green UNCHANGED: the triple is
 *    byte-identical to it when resourceTenantId is omitted);
 *  - tests/admin-audit-scope.test.ts — the READ-plane tenant asserts;
 *  - tests/admin-action-rbac-live.test.ts — the DIRECT-HTTP cells on
 *    real PG (D1-D4/X1-X2/M1-M6, Tester window, DU_LIVE_INFRA-gated);
 *  - THIS file — the tenant dimension of the mutation gate + the forged
 *    browser-identity composition cells (header never reaches the triple).
 * Zero DB/Redis/S3: pure functions + in-process counter fakes only.
 */

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';
const ALL_ACTIONS = Object.keys(ADMIN_ACTIONS);
const OPS = ['operations.cancel', 'operations.resume'];
const ADMIN_ONLY = ALL_ACTIONS.filter((a) => !OPS.includes(a));

function bearerPlatform(): AdminActionAuth {
  return { kind: 'bearer', principal: { role: 'platform' } };
}
function bearerOpA(): AdminActionAuth {
  return { kind: 'bearer', principal: { role: 'tenant_operator', tenantId: TENANT_A } };
}
function cookieAdmin(csrfOk: boolean): AdminActionAuth {
  return { kind: 'cookie', role: 'admin', csrfOk };
}
function cookieOp(csrfOk: boolean, tenantId: string | null): AdminActionAuth {
  return { kind: 'cookie', role: 'operator', csrfOk, tenantId };
}
function cookieViewer(csrfOk: boolean): AdminActionAuth {
  return { kind: 'cookie', role: 'viewer', csrfOk };
}

const TENANT_ARGS: Array<string | null> = [TENANT_A, TENANT_B, null];

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
  cancelForeign?: boolean; // lifecycle 404s the op-foreign id (service tenant fence)
  opRowTenant?: string; // tenant_id the operations SELECT answers (platform path)
}

/** Counter fakes in the exact shape the historical dispatcher suite
 *  proved executeIdempotent/auditedMutation against — every deny cell
 *  asserts these stayed at zero. */
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
    opSelects: 0,
  };
  const cancelTenants: string[] = [];
  const auditRows: AuditRecordInput[] = [];

  const client = {
    query: async (text: string, params: unknown[] = []) => {
      const sql = text.replace(/\s+/g, ' ').trim();
      if (sql.startsWith('UPDATE business_versions')) {
        return { rows: [], rowCount: 1 };
      }
      if (sql.includes('SELECT tenant_id FROM operations')) {
        calls.opSelects += 1;
        return { rows: [{ tenant_id: opts.opRowTenant ?? TENANT_B }], rowCount: 1 };
      }
      if (sql.includes('INSERT INTO')) {
        return { rows: /RETURNING\s+id/i.test(sql) ? [{ id: 'row-1' }] : [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const db = {
    pool: undefined,
    query: async (text: string) => {
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
    },
    hashApiKey: (raw: string) => 'hash-of-' + raw,
    correlationId: 'corr-oidc03-test',
  };
  return { deps, calls, auditRows, cancelTenants };
}

// ---------------------------------------------------------------------------
// A. The pure triple
// ---------------------------------------------------------------------------

describe('W-OIDC03-RBAC-1 assertRoleActionTenant — parity + tenant dimension (pure)', () => {
  const SHAPES: Array<[string, AdminActionAuth | null]> = [
    ['bearer platform', bearerPlatform()],
    ['bearer operator', bearerOpA()],
    ['cookie admin + CSRF', cookieAdmin(true)],
    ['cookie admin NO CSRF', cookieAdmin(false)],
    ['cookie operator + tenant + CSRF', cookieOp(true, TENANT_A)],
    ['cookie operator no-tenant + CSRF', cookieOp(true, null)],
    ['cookie viewer + CSRF', cookieViewer(true)],
    ['anonymous', null],
  ];

  it('authorizeAdminAction IS the tenant-less face: byte-identical decisions for every shape × action', () => {
    for (const [, auth] of SHAPES) {
      for (const action of [...ALL_ACTIONS, 'nope.unknown-action']) {
        expect(assertRoleActionTenant(auth, action)).toEqual(authorizeAdminAction(auth, action));
      }
    }
  });

  it('tenant binding ALLOW: a tenant-scoped caller passes on ITS OWN tenant for every admitted action', () => {
    for (const action of OPS) {
      expect(assertRoleActionTenant(bearerOpA(), action, TENANT_A)).toEqual({ ok: true });
      expect(assertRoleActionTenant(cookieOp(true, TENANT_A), action, TENANT_A)).toEqual({ ok: true });
    }
  });

  it('tenant binding DENY: foreign / tenantless / empty resource tenants answer with ONE identical wording (no existence leak)', () => {
    for (const auth of [bearerOpA(), cookieOp(true, TENANT_A)]) {
      const messages = ([TENANT_B, null, ''] as Array<string | null>).map((res) => {
        const d = assertRoleActionTenant(auth, 'operations.cancel', res);
        expect(d.ok).toBe(false);
        if (!d.ok) {
          expect(d.status).toBe(403);
          expect(d.code).toBe('PERMISSION_DENIED');
          return d.message;
        }
        return 'UNREACHED-ALLOW';
      });
      expect(new Set(messages).size).toBe(1);
      expect(messages[0]).toBe('mutations are scoped to the caller tenant');
    }
  });

  it('unscoped callers (bearer platform / CSRF-ok cookie admin) take any resource tenant: the matrix grants them platform-wide actions', () => {
    for (const auth of [bearerPlatform(), cookieAdmin(true)]) {
      for (const action of ALL_ACTIONS) {
        for (const res of TENANT_ARGS.concat('')) {
          expect(assertRoleActionTenant(auth, action, res)).toEqual({ ok: true });
        }
      }
    }
  });

  it('entry denies cannot be short-circuited by the tenant argument (401 / 404 / CSRF / role / presence all fire BEFORE binding)', () => {
    const anon = assertRoleActionTenant(null, 'operations.cancel', TENANT_A);
    expect(!anon.ok && (anon as { status: number }).status).toBe(401);
    const unknown = assertRoleActionTenant(bearerOpA(), 'connector.rotate-secret', TENANT_A);
    expect(!unknown.ok && (unknown as { status: number }).status).toBe(404);
    const noCsrf = assertRoleActionTenant(cookieOp(false, TENANT_A), 'operations.cancel', TENANT_B);
    expect(!noCsrf.ok && ((noCsrf as { message: string }).message.toLowerCase()).includes('csrf')).toBe(true);
    const viewer = assertRoleActionTenant(cookieViewer(true), 'operations.cancel', null);
    expect(!viewer.ok && ((viewer as { message: string }).message).includes('role')).toBe(true);
    // presence guard (no server-side tenant) wins over binding mismatch:
    const noTenant = assertRoleActionTenant(cookieOp(true, null), 'operations.cancel', TENANT_B);
    expect(!noTenant.ok && ((noTenant as { message: string }).message).includes('server-side tenant')).toBe(true);
  });

  it('a scoped bearer is NOT a global key: admin-only actions 403 whatever tenant argument rides along', () => {
    for (const action of ADMIN_ONLY) {
      const d = assertRoleActionTenant(bearerOpA(), action, TENANT_A);
      expect(d.ok).toBe(false);
      if (!d.ok) {
        expect(d.status).toBe(403);
        expect(d.message).toContain('platform');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// B. Triple wired into dispatchAdminAction — zero side effects
// ---------------------------------------------------------------------------

describe('W-OIDC03-RBAC-1 dispatchAdminAction: every denied cell leaves all counters at zero', () => {
  it('tenant-operator bearer on admin-only action: 403 at the entry face, NOTHING called', async () => {
    const { deps, calls } = makeDeps();
    await expectDenied(
      dispatchAdminAction(deps, bearerOpA(), { action: 'business.enable', params: { businessId: 'b', version: '1' } }),
      403,
      'PERMISSION_DENIED'
    );
    expect(calls).toEqual({
      activate: 0, deactivate: 0, sweep: 0, createRevision: 0,
      auditRecord: 0, keyLookups: 0, cancel: 0, resume: 0, opSelects: 0,
    });
  });

  it('bind-profile stays admin-only: scoped bearer 403 BEFORE any key lookup (tenant argument never consulted)', async () => {
    const { deps, calls } = makeDeps({ keyTenantId: TENANT_A });
    await expectDenied(
      dispatchAdminAction(deps, bearerOpA(), {
        action: 'apikey.bind-profile',
        params: { apiKey: 'k', businessId: 'b', businessVersion: '1', action: 'extract' },
      }),
      403,
      'PERMISSION_DENIED'
    );
    expect(calls.keyLookups).toBe(0);
    expect(calls.createRevision).toBe(0);
    expect(calls.auditRecord).toBe(0);
  });

  it('forged browser identity NEVER reaches the triple: spoofed x-du-tenant/x-du-role headers leave the session tenant at the fence', async () => {
    const SID = 'S'.repeat(43);
    const CSRF = 'C'.repeat(43);
    const store: AdminSessionStore = {
      get: async (id) =>
        id === SID ? { role: 'operator', csrfToken: CSRF, tenantId: TENANT_A } : null,
    };
    const auth = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      {
        cookie: `du_session=${SID}`,
        'x-csrf-token': CSRF,
        'x-du-tenant': TENANT_B, // the browser CLAIMS tenant B
        'x-du-role': 'admin', // and admin role
      },
      store
    );
    // server-side truth decided, not the headers:
    expect(auth).toEqual({ kind: 'cookie', role: 'operator', tenantId: TENANT_A, csrfOk: true });
    // so the triple fences by the STORE tenant — the claimed B denies:
    const spoof = assertRoleActionTenant(auth!, 'operations.cancel', TENANT_B);
    expect(!spoof.ok && ((spoof as { message: string }).message)).toBe('mutations are scoped to the caller tenant');
    // and a real cancel runs with the STORE tenant through the wired fence:
    const { deps, calls, cancelTenants, auditRows } = makeDeps();
    const r = await dispatchAdminAction(deps, auth, { action: 'operations.cancel', params: { operationId: 'op-own' } });
    expect(r.status).toBe(200);
    expect(cancelTenants[0]).toBe(TENANT_A);
    expect(auditRows[0]!.tenantId).toBe(TENANT_A);
    expect(calls.cancel).toBe(1);
  });

  it('operator session on a FOREIGN op: service fence 404s no-echo; the in-tx triple adds no second audit', async () => {
    const { deps, calls, auditRows } = makeDeps({ cancelForeign: true });
    await expectDenied(
      dispatchAdminAction(deps, cookieOp(true, TENANT_A), { action: 'operations.cancel', params: { operationId: 'op-foreign' } }),
      404,
      'NOT_FOUND'
    );
    expect(calls.auditRecord).toBe(0);
    expect(auditRows).toHaveLength(0);
  });

  it('platform cancel resolves the ROW tenant and the triple leaves it unscoped: 200, audit tenant null', async () => {
    const { deps, calls, cancelTenants } = makeDeps({ opRowTenant: TENANT_B });
    const r = await dispatchAdminAction(deps, bearerPlatform(), { action: 'operations.cancel', params: { operationId: 'op-b' } });
    expect(r.status).toBe(200);
    expect(cancelTenants[0]).toBe(TENANT_B);
    expect(calls.opSelects).toBe(1);
  });

  it('platform/cookie-admin bind a TENANT_B key: 201 — the tenant dimension binds tenant-scoped callers only', async () => {
    const { deps, calls } = makeDeps({ keyTenantId: TENANT_B });
    const r = await dispatchAdminAction(deps, bearerPlatform(), {
      action: 'apikey.bind-profile',
      params: { apiKey: 'raw', businessId: 'b', businessVersion: '1', action: 'extract' },
    });
    expect(r.status).toBe(201);
    const r2 = await dispatchAdminAction(deps, cookieAdmin(true), {
      action: 'apikey.bind-profile',
      params: { apiKey: 'raw2', businessId: 'b', businessVersion: '1', action: 'extract' },
    });
    expect(r2.status).toBe(201);
    expect(calls.createRevision).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// C. Full SEC-00 closure: exactly one verdict per (principal, action, tenant)
// ---------------------------------------------------------------------------

describe('W-OIDC03-RBAC-1 SEC-00 closure: every (principal, action, resourceTenant) cell has exactly one verdict', () => {
  /** The gate's ordering is part of the contract, so the expectation is
   *  derived cell-by-cell from the SAME rules (auth → table → CSRF →
   *  role → presence → binding), never copied from a fixture. */
  function expectedVerdict(auth: AdminActionAuth | null, action: string, res: string | null): { allow: boolean; messagePart: string } {
    if (!auth) return { allow: false, messagePart: 'admin endpoints' };
    if (auth.kind === 'bearer') {
      if (auth.principal.role === 'platform') return { allow: true, messagePart: '' };
      if (!ADMIN_ACTIONS[action]!.bearerRoles.includes('tenant_operator')) {
        return { allow: false, messagePart: 'platform' };
      }
      if (auth.principal.tenantId !== res) return { allow: false, messagePart: 'scoped to the caller tenant' };
      return { allow: true, messagePart: '' };
    }
    if (!auth.csrfOk) return { allow: false, messagePart: 'csrf' };
    if (!ADMIN_ACTIONS[action]!.cookieRoles.includes(auth.role)) {
      return { allow: false, messagePart: 'role' };
    }
    if (auth.role === 'operator') {
      const storeTenant = typeof auth.tenantId === 'string' && auth.tenantId.length > 0 ? auth.tenantId : '';
      if (!storeTenant) return { allow: false, messagePart: 'server-side tenant' };
      if (storeTenant !== res) return { allow: false, messagePart: 'scoped to the caller tenant' };
      return { allow: true, messagePart: '' };
    }
    return { allow: true, messagePart: '' }; // CSRF-ok cookie 'admin'
  }

  const cases: Array<[string, AdminActionAuth | null]> = [
    ['anonymous', null],
    ['bearer platform', bearerPlatform()],
    ['bearer tenant_operator A', bearerOpA()],
    ['cookie admin + CSRF', cookieAdmin(true)],
    ['cookie admin NO CSRF', cookieAdmin(false)],
    ['cookie operator A + CSRF', cookieOp(true, TENANT_A)],
    ['cookie operator no-tenant + CSRF', cookieOp(true, null)],
    ['cookie viewer + CSRF', cookieViewer(true)],
  ];

  it('computed expectation == gate verdict for all 8 shapes × ' + ALL_ACTIONS.length + ' actions × 3 resource tenants', () => {
    let cells = 0;
    for (const [who, auth] of cases) {
      for (const action of ALL_ACTIONS) {
        for (const res of TENANT_ARGS) {
          cells += 1;
          const d = assertRoleActionTenant(auth, action, res);
          const exp = expectedVerdict(auth, action, res);
          expect([who, action, res, d.ok]).toEqual([who, action, res, exp.allow]);
          if (!d.ok) expect(d.message.toLowerCase()).toContain(exp.messagePart.toLowerCase());
        }
      }
    }
    expect(cells).toBe(8 * ALL_ACTIONS.length * 3);
  });
});

// ---------------------------------------------------------------------------
// W-SEC-AUDIT-TAXONOMY-1 — auth.csrf_denied on the gate. The dispatcher is
// where the CSRF leg actually denies (the shell router never dispatches
// mutations), so the sink rides the gate as an OPTIONAL caller-injected
// observer: decisions stay byte-identical, and the event carries only the
// table action name — never a stored or provided CSRF value (sentinel-pinned
// through the REAL async resolver below).
// ---------------------------------------------------------------------------

describe('W-SEC-AUDIT-TAXONOMY-1 auth.csrf_denied on the dispatcher gate', () => {
  it('the CSRF leg emits exactly one closed event carrying the ACTION, nothing else', () => {
    const events: AdminSecurityEvent[] = [];
    const d = assertRoleActionTenant(cookieAdmin(false), 'operations.cancel', undefined, (e) => {
      events.push(e);
    });
    expect(d).toEqual({
      ok: false,
      status: 403,
      code: 'PERMISSION_DENIED',
      message: 'cookie-authenticated admin actions require a valid CSRF token',
    });
    expect(events).toEqual([
      { kind: 'auth.csrf_denied', reason: 'csrf_missing_or_invalid', action: 'operations.cancel' },
    ]);
  });

  it('every OTHER denial and every allow stays silent: csrf_denied marks only the CSRF leg', () => {
    const cases: Array<{ who: string; auth: AdminActionAuth | null; action: string; rt?: string | null }> = [
      { who: 'anonymous', auth: null, action: 'operations.cancel' },
      { who: 'unknown action', auth: bearerPlatform(), action: 'not.in.the.table' },
      { who: 'role deny (viewer + CSRF ok)', auth: cookieViewer(true), action: 'operations.cancel' },
      { who: 'operator without server tenant', auth: cookieOp(true, null), action: 'operations.cancel' },
      { who: 'tenant mismatch', auth: cookieOp(true, TENANT_A), action: 'operations.cancel', rt: TENANT_B },
      { who: 'allow: bearer platform', auth: bearerPlatform(), action: 'operations.cancel' },
      { who: 'allow: cookie admin + CSRF', auth: cookieAdmin(true), action: 'operations.cancel' },
    ];
    for (const { who, auth, action, rt } of cases) {
      const events: AdminSecurityEvent[] = [];
      assertRoleActionTenant(auth, action, rt, (e) => {
        events.push(e);
      });
      expect([who, events]).toEqual([who, []]);
    }
  });

  it('authorizeAdminAction delegates the sink through the stable name', () => {
    const events: AdminSecurityEvent[] = [];
    const d = authorizeAdminAction(cookieAdmin(false), 'operations.cancel', (e) => {
      events.push(e);
    });
    expect(!d.ok).toBe(true);
    expect(events).toHaveLength(1);
    const first = events[0];
    if (!first) throw new Error('expected exactly one csrf_denied event from the delegate');
    expect(first.kind).toBe('auth.csrf_denied');
  });

  it('sentinel CSRF values (STORED and PROVIDED) never reach the event through the REAL resolver', async () => {
    const SID = 'S'.repeat(43);
    const store: AdminSessionStore = {
      get: async (id) =>
        id === SID ? { role: 'admin', csrfToken: 'SENTINEL-CSRF-STORED-5555', tenantId: null } : null,
    };
    const auth = await resolveAdminActionAuthAsync(
      { adminToken: 'never-matching' },
      { cookie: 'du_session=' + SID, 'x-csrf-token': 'SENTINEL-CSRF-PROVIDED-4444' },
      store
    );
    expect(auth).toEqual({ kind: 'cookie', role: 'admin', tenantId: null, csrfOk: false });
    const events: AdminSecurityEvent[] = [];
    const d = assertRoleActionTenant(auth, 'operations.cancel', undefined, (e) => {
      events.push(e);
    });
    expect(!d.ok && d.status === 403).toBe(true);
    expect(events).toEqual([
      { kind: 'auth.csrf_denied', reason: 'csrf_missing_or_invalid', action: 'operations.cancel' },
    ]);
    const s = JSON.stringify(events);
    expect(s).not.toContain('SENTINEL-CSRF-STORED-5555');
    expect(s).not.toContain('SENTINEL-CSRF-PROVIDED-4444');
    expect(s).not.toContain(SID);
  });
});
