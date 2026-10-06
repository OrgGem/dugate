/**
 * G-SEC offline gate prep (cycle 139, Reviewer follow-on to SEC-INT-01):
 *  - full RBAC denial matrix through the PURE authorizeAdminAction gate (zero DB,
 *    zero network — the whole matrix is a function);
 *  - CSRF token lifecycle (derive/validate) negatives;
 *  - sentinel leak negatives: every denial decision is sink-scanned for
 *    SERVER-side secrets (the vault token, admin bearer, tenant id sentinels),
 *    using the kit's redactor-invisible sentinels so a green is never bought
 *    by the redactor hiding something.
 * Run: pnpm --dir services/orchestrator exec jest tests/gsec-sentinel-rbac.boundary.test.ts --runInBand
 */
import { ADMIN_ACTIONS, authorizeAdminAction, type AdminActionDecision } from '../src/modules/admin-actions/dispatcher';
import { deriveCsrfToken, validateCsrfToken, type AdminActionAuth, type AdminPrincipal } from '../src/modules/admin-actions/rbac';
import { mkSentinel } from '../../../tests/harness/network-boundaries/sentinels';
import { scanForSentinels } from '../../../tests/harness/network-boundaries/sink-scan';

const SERVER_VAULT_TOKEN = mkSentinel('gsec', 'vaulttoken');
const SERVER_ADMIN_BEARER = mkSentinel('gsec', 'adminbearer');
const SERVER_TENANT_SECRET = mkSentinel('gsec', 'tenantctx');
const SERVER_SENTINELS = [SERVER_VAULT_TOKEN, SERVER_ADMIN_BEARER, SERVER_TENANT_SECRET];

const bearer = (role: 'platform' | 'tenant_operator'): AdminActionAuth =>
  ({ kind: 'bearer', principal: { role, tenantId: role === 'tenant_operator' ? SERVER_TENANT_SECRET : undefined } as AdminPrincipal });
const cookie = (role: 'admin' | 'operator' | 'viewer', csrfOk = true, tenantId?: string | null): AdminActionAuth =>
  ({ kind: 'cookie', role, csrfOk, tenantId });

const ADMIN_ONLY = Object.keys(ADMIN_ACTIONS).filter((a) => !ADMIN_ACTIONS[a]!.cookieRoles.includes('operator' as never));
const OPERATOR_SURFACE = ['operations.cancel', 'operations.resume'];

describe('G-SEC offline - RBAC denial matrix (pure gate)', () => {
  it('[LOCK] unauthenticated -> 401 fail-closed with NO server secret in the decision', () => {
    const d = authorizeAdminAction(null, 'operations.cancel');
    expect(d).toMatchObject({ ok: false, status: 401, code: 'UNAUTHENTICATED' });
    expect(scanForSentinels(d, SERVER_SENTINELS)).toEqual([]);
  });

  it('[LOCK] unknown action -> 404 echoing ONLY the requested name (bounded reflection)', () => {
    const probe = 'nope.' + mkSentinel('probe', 'action');
    const d = authorizeAdminAction(bearer('platform'), probe);
    expect(d).toMatchObject({ ok: false, status: 404, code: 'NOT_FOUND' });
    // reflection is confined to the requested action string:
    expect(String((d as { message?: string }).message)).toBe("unsupported admin action '" + probe + "'");
    expect(scanForSentinels(d, SERVER_SENTINELS)).toEqual([]);
  });

  it('[LOCK] bearer platform passes the ENTIRE action table', () => {
    for (const action of Object.keys(ADMIN_ACTIONS)) {
      expect(authorizeAdminAction(bearer('platform'), action)).toEqual({ ok: true });
    }
  });

  it('[LOCK] bearer tenant_operator denied on every admin-only action, allowed on operation-control', () => {
    for (const action of ADMIN_ONLY) {
      const d = authorizeAdminAction(bearer('tenant_operator'), action);
      expect(d).toMatchObject({ ok: false, status: 403, code: 'PERMISSION_DENIED' });
      expect(scanForSentinels(d, SERVER_SENTINELS)).toEqual([]);
    }
    for (const action of OPERATOR_SURFACE) {
      expect(authorizeAdminAction(bearer('tenant_operator'), action)).toEqual({ ok: true });
    }
  });

  it('[LOCK] cookie viewer denied everywhere; admin allowed everywhere; CSRF gate first', () => {
    for (const action of Object.keys(ADMIN_ACTIONS)) {
      expect(authorizeAdminAction(cookie('viewer'), action)).toMatchObject({ ok: false, status: 403 });
      expect(authorizeAdminAction(cookie('admin'), action)).toEqual({ ok: true });
      const noCsrf = authorizeAdminAction(cookie('admin', false), action);
      expect(noCsrf).toMatchObject({ ok: false, status: 403, code: 'PERMISSION_DENIED' });
      expect((noCsrf as { message: string }).message).toMatch(/CSRF/i);
    }
  });

  it('[LOCK] cookie operator needs BOTH role-in-table AND a server-side tenant', () => {
    for (const action of OPERATOR_SURFACE) {
      expect(authorizeAdminAction(cookie('operator', true, 'tenant-a'), action)).toEqual({ ok: true });
      const fence = authorizeAdminAction(cookie('operator', true, null), action);
      expect(fence).toMatchObject({ ok: false, status: 403 });
      expect((fence as { message: string }).message).toMatch(/server-side tenant/i);
      expect(scanForSentinels(fence, SERVER_SENTINELS)).toEqual([]);
    }
    for (const action of ADMIN_ONLY) {
      expect(authorizeAdminAction(cookie('operator', true, 'tenant-a'), action)).toMatchObject({ ok: false, status: 403 });
    }
  });

  it('[LOCK] every denial of the full role x action grid is sentinel-clean', () => {
    const auths: Array<AdminActionAuth | null> = [null, bearer('tenant_operator'), cookie('viewer'), cookie('operator'), cookie('admin', false)];
    const decisions: AdminActionDecision[] = [];
    for (const auth of auths) {
      for (const action of Object.keys(ADMIN_ACTIONS)) {
        const d = authorizeAdminAction(auth, action);
        if (!d.ok) decisions.push(d);
      }
    }
    expect(decisions.length).toBeGreaterThan(20);
    expect(scanForSentinels(decisions, SERVER_SENTINELS)).toEqual([]);
  });
});

describe('G-SEC offline - CSRF lifecycle negatives', () => {
  const secret = SERVER_ADMIN_BEARER; // reuse a redactor-invisible sentinel as the cookie secret
  it('[LOCK] valid pair verifies; forged/wrong-session/short/garbage all fail', () => {
    const session = 'du_admin_value_' + SERVER_TENANT_SECRET;
    const good = deriveCsrfToken(secret, session);
    expect(validateCsrfToken({ secret, sessionCookie: session, provided: good })).toBe(true);
    const changedFinalChar = good.endsWith('0') ? '1' : '0';
    expect(validateCsrfToken({ secret, sessionCookie: session, provided: good.slice(0, -1) + changedFinalChar })).toBe(false);
    expect(validateCsrfToken({ secret, sessionCookie: session + 'x', provided: good })).toBe(false);
    expect(validateCsrfToken({ secret: 'other', sessionCookie: session, provided: good })).toBe(false);
    expect(validateCsrfToken({ secret, sessionCookie: session, provided: undefined })).toBe(false);
    expect(validateCsrfToken({ sessionCookie: session, provided: good })).toBe(false);
  });
  it('[LOCK] overlong provided token rejected before any HMAC work (DoS guard)', () => {
    expect(validateCsrfToken({ secret, sessionCookie: 'x', provided: 'a'.repeat(200) })).toBe(false);
  });
  it('[LOCK] derived token never embeds the server secret (scan the digest itself)', () => {
    const t = deriveCsrfToken(secret, 'sess-1');
    expect(t).not.toContain(secret);
    expect(scanForSentinels([t], [SERVER_ADMIN_BEARER])).toEqual([]);
  });
});
