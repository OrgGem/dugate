/**
 * W-ADM-UX-03-AUDIT-ROUTE (Delta 130): route + nav tab for /admin/audit.
 *
 * Offline and pure: no DB, no Redis, no network. The fetcher is an injected
 * stub, so this suite proves the SHELL wiring - route match, role gate,
 * deferred pane hook, query forwarding, and nav tab - not the ledger
 * itself (that is admin-audit-toolbar.test.ts).
 */

import {
  buildAdminShellView,
  getCanonicalNavItems,
} from '../src/app/admin/p6-01-shell-fixtures';
import { dispatchShellRequest, matchShellRoute } from '../src/app/admin/shell-router';
import { signCookie } from '../src/app/admin/shell-auth';
import { AUDIT_NAV_PATH, renderAuditNavTab } from '../src/app/admin/shell-render';
import type { AdminCookieClaims, AdminShellRequest } from '../src/app/admin/shell-types';
import type {
  AuditFetchResult,
  AuditFetcherInput,
} from '../src/app/admin/audit-section-data';

const TOKEN = 'tok';
const SECRET = 'shh';
const NOW = 1_700_000_000_000;

type Role = 'admin' | 'operator' | 'viewer';

function cookieFor(role: Role): string {
  const c = signCookie(SECRET, { iss: 'du-admin-shell', role, iat: NOW, exp: NOW + 60_000 });
  return c ?? '';
}

function get(
  opts: { role?: Role; query?: Record<string, string>; pathname?: string } = {},
): AdminShellRequest {
  const pathname = opts.pathname ?? AUDIT_NAV_PATH;
  return {
    method: 'GET',
    pathname,
    body: {},
    cookies: opts.role ? { du_admin: cookieFor(opts.role) } : {},
    ...(opts.query ? { query: opts.query } : {}),
  } as AdminShellRequest;
}

function configWith(over: Record<string, unknown> = {}) {
  return { cookieSecret: SECRET, adminToken: TOKEN, nowMs: () => NOW, ...over };
}

describe('W-ADM-UX-03 audit route: matchShellRoute', () => {
  it('matches GET /admin/audit to admin-audit with no section', () => {
    const m = matchShellRoute('GET', '/admin/audit');
    expect(m?.id).toBe('admin-audit');
    expect(m?.section).toBeNull();
  });

  it('requires operator role', () => {
    const m = matchShellRoute('GET', '/admin/audit');
    expect(m?.requiredRole).toBe('operator');
  });

  it('does not match POST /admin/audit (no write path)', () => {
    const m = matchShellRoute('POST', '/admin/audit');
    expect(m).toBeNull();
  });
});

describe('W-ADM-UX-03 audit route: auth gate', () => {
  it('returns 401 when no cookie is presented', () => {
    const out = dispatchShellRequest(get(), configWith());
    expect(out.response.status).toBe(401);
  });

  it('returns 403 for a viewer (below operator)', () => {
    const out = dispatchShellRequest(get({ role: 'viewer' }), configWith());
    expect(out.response.status).toBe(403);
  });

  it('returns 200 for an operator', () => {
    const out = dispatchShellRequest(get({ role: 'operator' }), configWith());
    expect(out.response.status).toBe(200);
  });

  it('returns 200 for an admin', () => {
    const out = dispatchShellRequest(get({ role: 'admin' }), configWith());
    expect(out.response.status).toBe(200);
  });

  it('the 403 body names the required role', () => {
    const out = dispatchShellRequest(get({ role: 'viewer' }), configWith());
    expect(out.response.body).toContain('operator');
  });
});

describe('W-ADM-UX-03 audit nav tab', () => {
  function viewFor(role: Role, path: string) {
    return buildAdminShellView({
      role,
      path,
      navItems: getCanonicalNavItems(),
      dataAvailable: { kind: 'ready' },
    });
  }

  it('renders the Audit Log tab for an operator', () => {
    const html = renderAuditNavTab(viewFor('operator', '/admin/operations'));
    expect(html).toContain('Audit Log');
    const D = String.fromCharCode(34);
    expect(html).toContain('href=' + D + '/admin/audit' + D);
  });

  it('renders the Audit Log tab for an admin', () => {
    const html = renderAuditNavTab(viewFor('admin', '/admin/operations'));
    expect(html).toContain('Audit Log');
  });

  it('does NOT render the Audit Log tab for a viewer', () => {
    const html = renderAuditNavTab(viewFor('viewer', '/admin/operations'));
    expect(html).toBe('');
  });

  it('marks aria-current=page when already on /admin/audit', () => {
    const html = renderAuditNavTab(viewFor('operator', '/admin/audit'));
    const D = String.fromCharCode(34);
    expect(html).toContain('aria-current=' + D + 'page' + D);
  });

  it('does NOT mark aria-current when on a different page', () => {
    const html = renderAuditNavTab(viewFor('operator', '/admin/operations'));
    expect(html).not.toContain("aria-current='page'");
  });

  it('the tab href matches AUDIT_NAV_PATH', () => {
    expect(AUDIT_NAV_PATH).toBe('/admin/audit');
  });
});

describe('W-ADM-UX-03 audit route: query forwarding + pane', () => {
  function stubFetcher() {
    const calls: AuditFetcherInput[] = [];
    return {
      calls,
      fetcher: async (input: AuditFetcherInput): Promise<AuditFetchResult> => {
        calls.push(input);
        return { kind: 'list', rows: [], limit: 50, total: 0, nextCursor: null, prevCursor: null, cursor: null, pageRows: 0, filters: { severity: 'ALL', actor: null, action: null, resource: null, from: null, to: null }, sort: 'createdAt:desc', ignoredFilters: [], droppedRows: 0 };
      },
    };
  }

  it('forwards the query params to the fetcher', async () => {
    const stub = stubFetcher();
    const out = dispatchShellRequest(
      get({ role: 'admin', query: { limit: '25', severity: 'warning', actor: 'ops', from: '2026-09-01T00:00:00Z' } }),
      configWith({ sectionFetchers: { audit: stub.fetcher } }),
    );
    await out.response.deferredSectionExtras?.();
    expect(stub.calls).toHaveLength(1);
    const input = stub.calls[0]!;
    expect(input.listLimit).toBe(25);
    expect(input.severityFilter).toBe('warning');
    expect(input.actorFilter).toBe('ops');
    expect(input.fromFilter).toBe('2026-09-01T00:00:00Z');
  });

  it('renders the pane HTML from the fetcher result', async () => {
    const stub = stubFetcher();
    const out = dispatchShellRequest(
      get({ role: 'operator' }),
      configWith({ sectionFetchers: { audit: stub.fetcher } }),
    );
    const html = await out.response.deferredSectionExtras?.();
    expect(html).toBeDefined();
    expect(html).toContain('Audit ledger');
  });

  it('renders an honest NOT-WIRED error when no fetcher is configured', async () => {
    const out = dispatchShellRequest(get({ role: 'operator' }), configWith());
    const html = await out.response.deferredSectionExtras?.();
    expect(html).toBeDefined();
    expect(html).toContain('not wired');
    expect(html).not.toContain('No events match');
  });
});

describe('W-ADM-UX-05 audit route: query passthrough, tenant, authz', () => {
  function spy() {
    const calls: AuditFetcherInput[] = [];
    const fetcher = async (input: AuditFetcherInput): Promise<AuditFetchResult> => {
      calls.push(input);
      return {
        kind: 'list',
        rows: [],
        limit: 50,
        total: 0,
        nextCursor: null,
        prevCursor: null,
        cursor: null,
        pageRows: 0,
        filters: { severity: 'ALL', actor: null, action: null, resource: null, from: null, to: null },
        sort: 'createdAt:desc',
        ignoredFilters: [],
        droppedRows: 0,
      };
    };
    return { calls, fetcher };
  }

  async function forward(query: Record<string, string>) {
    const s = spy();
    const out = dispatchShellRequest(
      get({ role: 'admin', query }),
      configWith({ sectionFetchers: { audit: s.fetcher } }),
    );
    await out.response.deferredSectionExtras?.();
    return s.calls[0];
  }

  it('the route does NOT clamp limit: 0 is forwarded verbatim', async () => {
    const i = await forward({ limit: '0' });
    expect(i?.listLimit).toBe(0);
  });

  it('a negative limit is forwarded verbatim', async () => {
    const i = await forward({ limit: '-5' });
    expect(i?.listLimit).toBe(-5);
  });

  it('an oversized limit is forwarded verbatim; the bound is the fetcher job', async () => {
    const i = await forward({ limit: '9999' });
    expect(i?.listLimit).toBe(9999);
  });

  it('a non-numeric limit reaches the fetcher as NaN, not as a silent 50', async () => {
    const i = await forward({ limit: 'abc' });
    expect(Number.isNaN(i?.listLimit)).toBe(true);
  });

  it('the audit page-size ceiling is 200, so 101 is legal for THIS route', async () => {
    // 100 is the OPERATIONS ceiling. Audit uses ADMIN_LIST_LIMIT_MAX = 200, so a
    // test asserting 101 is rejected would assert a falsehood.
    const i = await forward({ limit: '101' });
    expect(i?.listLimit).toBe(101);
  });

  it('an empty cursor is forwarded as an empty string, not invented', async () => {
    const i = await forward({ cursor: '' });
    expect(i?.cursor).toBe('');
  });

  it('an over-length cursor is forwarded verbatim, not silently truncated', async () => {
    const long = 'x'.repeat(200);
    const i = await forward({ cursor: long });
    expect(i?.cursor).toBe(long);
  });

  it('a malformed cursor is forwarded verbatim so the ROUTE stays the authority', async () => {
    const i = await forward({ cursor: 'not-a-cursor' });
    expect(i?.cursor).toBe('not-a-cursor');
  });
});

describe('W-ADM-UX-05 audit route: tenant scoping and authz edges', () => {
  function spy() {
    const calls: AuditFetcherInput[] = [];
    const fetcher = async (input: AuditFetcherInput): Promise<AuditFetchResult> => {
      calls.push(input);
      return { kind: 'list', rows: [], limit: 50, total: 0, nextCursor: null, prevCursor: null, cursor: null, pageRows: 0, filters: { severity: 'ALL', actor: null, action: null, resource: null, from: null, to: null }, sort: 'createdAt:desc', ignoredFilters: [], droppedRows: 0 };
    };
    return { calls, fetcher };
  }

  it('a tenantId in the query is DROPPED, never forwarded to the ledger', async () => {
    const s = spy();
    const out = dispatchShellRequest(
      get({ role: 'admin', query: { tenantId: 'someone-elses-tenant', tenant_id: 'also-not-forwarded' } }),
      configWith({ sectionFetchers: { audit: s.fetcher } }),
    );
    await out.response.deferredSectionExtras?.();
    expect(s.calls).toHaveLength(1);
    const i = s.calls[0] as unknown as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(i, 'tenantId')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(i, 'tenant_id')).toBe(false);
  });

  it('the pane cannot widen its own scope: the token alone decides the tenant', async () => {
    // The shell has no tenant parameter by design. Tenant scope is the API
    // route job (authorizeAuditTenantRead), so a crafted URL cannot redirect
    // the pane at another tenant ledger.
    const s = spy();
    const out = dispatchShellRequest(
      get({ role: 'operator', query: { tenantId: '11111111-1111-4111-8111-111111111111' } }),
      configWith({ sectionFetchers: { audit: s.fetcher } }),
    );
    await out.response.deferredSectionExtras?.();
    expect(out.response.status).toBe(200);
    expect(Object.keys(s.calls[0] as object)).not.toContain('tenantId');
  });

  it('a cookie signed with an unknown role is refused 401, not served', () => {
    const forged = {
      iss: 'du-admin-shell',
      role: 'superuser',
      iat: NOW,
      exp: NOW + 60_000,
    } as unknown as AdminCookieClaims;
    const out = dispatchShellRequest(
      { method: 'GET', pathname: AUDIT_NAV_PATH, body: {}, cookies: { du_admin: signCookie(SECRET, forged) ?? '' } } as AdminShellRequest,
      configWith(),
    );
    expect(out.response.status).toBe(401);
  });

  it('a tampered cookie is refused 401', () => {
    const out = dispatchShellRequest(
      { method: 'GET', pathname: AUDIT_NAV_PATH, body: {}, cookies: { du_admin: 'garbage.cookie.value' } } as AdminShellRequest,
      configWith(),
    );
    expect(out.response.status).toBe(401);
  });

  it('the audit route needs NO listening port, so this suite cannot collide', () => {
    const cfg = configWith();
    expect(Object.prototype.hasOwnProperty.call(cfg, 'adminShellPort')).toBe(false);
    const out = dispatchShellRequest(get({ role: 'operator' }), cfg);
    expect(out.response.status).toBe(200);
  });
});
