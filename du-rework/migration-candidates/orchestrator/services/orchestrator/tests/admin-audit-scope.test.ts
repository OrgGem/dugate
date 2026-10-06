import { HttpError } from '../src/http/errors';
import {
  authorizeAuditTenantRead,
  authorizeBindingTenant,
  requireResourceTenant,
  resolveAdminAuditPrincipal,
  resolveAdminPrincipal,
  type AdminAuditPrincipal,
} from '../src/server';
import { listAuthorizedAuditEvents } from '../src/modules/audit/audit';

/**
 * R3-02: GET /api/v1/admin/audit must derive the readable tenant scope
 * from the AUTHENTICATED principal, not from whatever tenantId the caller
 * typed. Offline matrix over the two exported decision functions — the
 * route composes exactly resolve → authorize → list(tenant).
 */

const PLATFORM = 'plat-token-' + 'x'.repeat(8);
const OP_A = 'op-a-token';
const OP_B = 'op-b-token';
const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

const config = {
  adminToken: PLATFORM,
  tenantAdminTokens: { [OP_A]: TENANT_A, [OP_B]: TENANT_B },
};

describe('R3-02 resolveAdminAuditPrincipal: the credential decides the role', () => {
  it('platform bearer → platform principal', () => {
    expect(resolveAdminAuditPrincipal(config, `Bearer ${PLATFORM}`)).toEqual({ role: 'platform' });
  });
  it('tenant-scoped bearer → tenant_operator bound to its configured tenant', () => {
    expect(resolveAdminAuditPrincipal(config, `Bearer ${OP_A}`)).toEqual({ role: 'tenant_operator', tenantId: TENANT_A });
    expect(resolveAdminAuditPrincipal(config, `Bearer ${OP_B}`)).toEqual({ role: 'tenant_operator', tenantId: TENANT_B });
  });
  it('unknown bearer / no header / non-Bearer scheme → null (route 401s)', () => {
    expect(resolveAdminAuditPrincipal(config, 'Bearer nope')).toBeNull();
    expect(resolveAdminAuditPrincipal(config, undefined)).toBeNull();
    expect(resolveAdminAuditPrincipal(config, '')).toBeNull();
    expect(resolveAdminAuditPrincipal(config, 'Basic Zm9v')).toBeNull();
    expect(resolveAdminAuditPrincipal(config, `not-even-bearer ${PLATFORM}`)).toBeNull();
  });
  it('fail-closed: no adminToken configured → tenant table still the only path', () => {
    expect(resolveAdminAuditPrincipal({ adminToken: undefined }, `Bearer ${PLATFORM}`)).toBeNull();
  });
  it('no tenantAdminTokens configured → only the platform bearer resolves (pre-R3-02 behavior)', () => {
    expect(resolveAdminAuditPrincipal({ adminToken: PLATFORM }, `Bearer ${OP_A}`)).toBeNull();
  });
});

describe('R3-02 authorizeAuditTenantRead: allow/deny matrix', () => {
  it('null principal → 401 UNAUTHENTICATED', () => {
    let err: HttpError | undefined;
    try {
      authorizeAuditTenantRead(null, TENANT_A);
    } catch (e) {
      err = e as HttpError;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.status).toBe(401);
    expect(err!.code).toBe('UNAUTHENTICATED');
  });
  it('platform may read any tenant (operator console); empty param stays empty scope', () => {
    const platform: AdminAuditPrincipal = { role: 'platform' };
    expect(authorizeAuditTenantRead(platform, TENANT_A)).toBe(TENANT_A);
    expect(authorizeAuditTenantRead(platform, TENANT_B)).toBe(TENANT_B);
    expect(authorizeAuditTenantRead(platform, '')).toBe('');
  });
  it('tenant_operator(A): own tenant allowed; foreign DENIED with 403', () => {
    const opA: AdminAuditPrincipal = { role: 'tenant_operator', tenantId: TENANT_A };
    expect(authorizeAuditTenantRead(opA, TENANT_A)).toBe(TENANT_A);
    let err: HttpError | undefined;
    try {
      authorizeAuditTenantRead(opA, TENANT_B);
    } catch (e) {
      err = e as HttpError;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.status).toBe(403);
    expect(err!.code).toBe('PERMISSION_DENIED');
    // No existence leak: the denial never echoes which tenant was asked for.
    expect(err!.message).not.toContain(TENANT_B);
    expect(err!.message).not.toContain(TENANT_A);
  });
  it('tenant_operator(A) with no tenantId param → falls back to OWN scope, never empty', () => {
    const opA: AdminAuditPrincipal = { role: 'tenant_operator', tenantId: TENANT_A };
    expect(authorizeAuditTenantRead(opA, '')).toBe(TENANT_A);
  });
});

describe('R3-02 GET audit checks tenant scope before the ledger read', () => {
  const listForTenant = jest.fn(async (tenantId: string) => [{
    id: `audit-${tenantId}`,
    kind: 'profile_binding.bind',
    severity: 'info',
    occurredAt: '2026-09-25T00:00:00.000Z',
    tenantId,
    resourceId: 'apikey:key-1',
    actor: 'admin',
    message: 'profile_binding.bind apikey:key-1',
  }]);
  const audit = { listForTenant };

  beforeEach(() => listForTenant.mockClear());

  it('tenant operator A cannot select B with ?tenantId=B and no audit read occurs', async () => {
    const principal = resolveAdminAuditPrincipal(config, `Bearer ${OP_A}`);
    await expect(listAuthorizedAuditEvents(audit, principal, TENANT_B, 50)).rejects.toMatchObject({
      status: 403,
      code: 'PERMISSION_DENIED',
    });
    expect(listForTenant).not.toHaveBeenCalled();
  });

  it('tenant operator A without a query tenant reads only credential-bound tenant A', async () => {
    const principal = resolveAdminAuditPrincipal(config, `Bearer ${OP_A}`);
    await expect(listAuthorizedAuditEvents(audit, principal, '', 50)).resolves.toEqual({
      tenantId: TENANT_A,
      events: [{
        id: `audit-${TENANT_A}`,
        kind: 'profile_binding.bind',
        severity: 'info',
        occurredAt: '2026-09-25T00:00:00.000Z',
        tenantId: TENANT_A,
        resourceId: 'apikey:key-1',
        actor: 'admin',
        message: 'profile_binding.bind apikey:key-1',
      }],
    });
    expect(listForTenant).toHaveBeenCalledWith(TENANT_A, 50);
  });
});

/**
 * ADM-BASE-02: the R3-02 principal model now governs EVERY tenant-carrying
 * admin surface, not just the audit ledger — usage projection and the
 * api-keys list reuse authorizeAuditTenantRead (explicit-tenant reads →
 * 403); by-id reads (operations detail, api-key detail) use
 * requireResourceTenant (indistinguishable 404, R24-01 precedent);
 * tenant-targeted mutations (profile bindings) use authorizeBindingTenant
 * (explicit intent → 403). These are the pure decisions the routes call
 * 1:1 — route wiring is compile-checked, live HTTP proof is queued for
 * the DB window (report §W49-QW1-4.4).
 */
describe('ADM-BASE-02 resolveAdminPrincipal is the single shared resolver', () => {
  it('the R3-02 audit name is an ALIAS of the generic resolver (no divergent rules)', () => {
    expect(resolveAdminAuditPrincipal).toBe(resolveAdminPrincipal);
  });
});

describe('ADM-BASE-02 requireResourceTenant: by-id reads fail closed WITHOUT existence leak', () => {
  const opA: AdminAuditPrincipal = { role: 'tenant_operator', tenantId: TENANT_A };
  it('null principal → 401', () => {
    let err: HttpError | undefined;
    try { requireResourceTenant(null, TENANT_A); } catch (e) { err = e as HttpError; }
    expect(err!.status).toBe(401);
  });
  it('platform passes any resource tenant', () => {
    expect(() => requireResourceTenant({ role: 'platform' }, TENANT_B)).not.toThrow();
  });
  it('operator(A) own tenant passes; foreign fails as 404 NOT_FOUND (same shape as missing)', () => {
    expect(() => requireResourceTenant(opA, TENANT_A)).not.toThrow();
    let err: HttpError | undefined;
    try { requireResourceTenant(opA, TENANT_B); } catch (e) { err = e as HttpError; }
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.status).toBe(404);
    expect(err!.code).toBe('NOT_FOUND');
    // indistinguishable from the not-found path of the route:
    expect(err!.message).toBe('not found');
    expect(err!.message).not.toContain(TENANT_B);
  });
});

describe('ADM-BASE-02 authorizeBindingTenant: targeted mutations deny with 403', () => {
  const opA: AdminAuditPrincipal = { role: 'tenant_operator', tenantId: TENANT_A };
  it('platform may bind a key of any tenant', () => {
    expect(() => authorizeBindingTenant({ role: 'platform' }, TENANT_B)).not.toThrow();
  });
  it('operator(A) binding an own-tenant key passes', () => {
    expect(() => authorizeBindingTenant(opA, TENANT_A)).not.toThrow();
  });
  it('operator(A) binding a tenant-B key → 403 PERMISSION_DENIED, no id echo', () => {
    let err: HttpError | undefined;
    try { authorizeBindingTenant(opA, TENANT_B); } catch (e) { err = e as HttpError; }
    expect(err).toBeInstanceOf(HttpError);
    expect(err!.status).toBe(403);
    expect(err!.code).toBe('PERMISSION_DENIED');
    expect(err!.message).not.toContain(TENANT_B);
    expect(err!.message).not.toContain(TENANT_A);
  });
  it('null principal → 401', () => {
    let err: HttpError | undefined;
    try { authorizeBindingTenant(null, TENANT_A); } catch (e) { err = e as HttpError; }
    expect(err!.status).toBe(401);
  });
});

describe('ADM-BASE-02 surfaces reuse the SAME decision (usage/api-keys list)', () => {
  const opA: AdminAuditPrincipal = { role: 'tenant_operator', tenantId: TENANT_A };
  it('usage: operator(A)?tenantId=B → 403, ?tenantId=A → A, missing param → A', () => {
    let err: HttpError | undefined;
    try { authorizeAuditTenantRead(opA, TENANT_B); } catch (e) { err = e as HttpError; }
    expect(err!.status).toBe(403);
    expect(err!.code).toBe('PERMISSION_DENIED');
    expect(authorizeAuditTenantRead(opA, TENANT_A)).toBe(TENANT_A);
    expect(authorizeAuditTenantRead(opA, '')).toBe(TENANT_A);
  });
  it('api-keys list: same helper, never another tenant', () => {
    expect(authorizeAuditTenantRead(opA, '')).toBe(TENANT_A);
    expect(authorizeAuditTenantRead({ role: 'platform' }, '')).toBe('');
  });
});
