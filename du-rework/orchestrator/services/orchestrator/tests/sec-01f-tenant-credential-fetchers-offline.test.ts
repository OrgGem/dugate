import { fetchAuditEvents } from '../src/app/admin/audit-section-data';
import { fetchBusinessVersions } from '../src/app/admin/business-section-data';
import { handleAuditGet, handleSectionGet } from '../src/app/admin/section-dispatch';
import type { AdminCookieClaims, AdminShellRequest } from '../src/app/admin/shell-types';
import type { ShellRuntimeConfig } from '../src/app/admin/shell-router';

const PLATFORM_TOKEN = 'platform-bearer-secret';
const TENANT_A_TOKEN = 'tenant-a-bearer-secret';
const TENANT_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function claims(role: AdminCookieClaims['role'], tenantId?: string): AdminCookieClaims {
  return {
    role,
    tenantId,
    iss: 'sec-01f-test',
    iat: 1,
    exp: 2,
  };
}

function request(pathname: string, query: Record<string, string> = {}): AdminShellRequest {
  return {
    method: 'GET',
    pathname,
    cookies: {},
    body: {},
    query,
  };
}

function config(
  sectionFetchers: NonNullable<ShellRuntimeConfig['sectionFetchers']>,
  tenantAdminTokens: Record<string, string> = { [TENANT_A_TOKEN]: TENANT_A },
): ShellRuntimeConfig {
  return {
    cookieSecret: 'sec-01f-offline-test-secret',
    adminToken: PLATFORM_TOKEN,
    jsonBaseUrl: 'https://orchestrator.internal',
    tenantAdminTokens,
    sectionFetchers,
  };
}

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

afterEach(() => {
  jest.restoreAllMocks();
});

describe('SEC-01F tenant credential fetchers', () => {
  it('loads tenant businesses only from the session tenant catalog route', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      items: [{
        businessId: 'tenant-a-owned',
        displayName: 'Tenant A business',
        latestVersion: 'v3',
        latestStatus: 'ENABLED',
        activeVersion: 'v3',
        versionCount: 3,
        createdAt: '2026-10-01T00:00:00.000Z',
        updatedAt: '2026-10-10T00:00:00.000Z',
      }],
      nextCursor: null,
      prevCursor: null,
      total: 1,
      limit: 100,
      generatedAt: '2026-10-11T00:00:00.000Z',
    }));
    const response = handleSectionGet(
      'businesses',
      'viewer',
      request('/admin/businesses', { businessId: 'foreign-business' }),
      claims('operator', TENANT_A),
      config({ businesses: fetchBusinessVersions }),
    );

    expect(response.status).toBe(200);
    const html = await response.deferredSectionExtras?.();
    const [input, init] = fetchSpy.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.pathname).toBe(`/api/v1/admin/tenants/${TENANT_A}/businesses`);
    expect(url.pathname).not.toBe('/api/v1/admin/businesses');
    expect(url.searchParams.get('limit')).toBe('100');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TENANT_A_TOKEN}`);
    expect(html).toContain('Tenant A business');
    expect(html).not.toContain('foreign-business');
  });

  it('pins audit fetches to the session tenant despite a foreign query tenant', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      items: [],
      nextCursor: null,
      prevCursor: null,
      total: 0,
      limit: 50,
    }));
    const response = handleAuditGet(
      'operator',
      request('/admin/audit', {
        tenantId: TENANT_B,
        jsonBaseUrl: 'https://orchestrator.internal',
      }),
      claims('operator', TENANT_A),
      config({ audit: fetchAuditEvents }),
    );

    expect(response.status).toBe(200);
    await response.deferredSectionExtras?.();
    const [input, init] = fetchSpy.mock.calls[0] ?? [];
    const url = new URL(String(input));
    expect(url.pathname).toBe('/api/v1/admin/audit');
    expect(url.searchParams.get('tenantId')).toBe(TENANT_A);
    expect(url.searchParams.get('tenantId')).not.toBe(TENANT_B);
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${TENANT_A_TOKEN}`);
  });

  it('denies viewers and unmapped operators before business or audit fetchers run', () => {
    let businessCalls = 0;
    let auditCalls = 0;
    const sectionFetchers: NonNullable<ShellRuntimeConfig['sectionFetchers']> = {
      businesses: async () => {
        businessCalls += 1;
        return { kind: 'error', businessId: '', message: 'unexpected fetch' };
      },
      audit: async () => {
        auditCalls += 1;
        return { kind: 'error', message: 'unexpected fetch' };
      },
    };
    const viewerBusiness = handleSectionGet(
      'businesses',
      'viewer',
      request('/admin/businesses'),
      claims('viewer', TENANT_A),
      config(sectionFetchers),
    );
    const unmappedBusiness = handleSectionGet(
      'businesses',
      'viewer',
      request('/admin/businesses'),
      claims('operator', TENANT_A),
      config(sectionFetchers, {}),
    );
    const unmappedAudit = handleAuditGet(
      'operator',
      request('/admin/audit'),
      claims('operator', TENANT_A),
      config(sectionFetchers, {}),
    );

    for (const response of [viewerBusiness, unmappedBusiness, unmappedAudit]) {
      expect(response.status).toBe(403);
      expect(response.body).toContain('Access denied');
      expect(response.deferredSectionExtras).toBeUndefined();
    }
    expect(businessCalls).toBe(0);
    expect(auditCalls).toBe(0);
  });

  it('keeps platform admin access on the global business route and token', async () => {
    const fetchSpy = jest.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({
      items: [{
        businessId: 'platform-business',
        version: 'v7',
        status: 'ENABLED',
        isActive: true,
        createdAt: '2026-10-01T00:00:00.000Z',
      }],
      nextCursor: null,
      prevCursor: null,
      total: 1,
      limit: 100,
    }));
    const response = handleSectionGet(
      'businesses',
      'viewer',
      request('/admin/businesses'),
      claims('admin'),
      config({ businesses: fetchBusinessVersions }),
    );

    expect(response.status).toBe(200);
    await response.deferredSectionExtras?.();
    const [input, init] = fetchSpy.mock.calls[0] ?? [];
    expect(new URL(String(input)).pathname).toBe('/api/v1/admin/businesses');
    expect(new Headers(init?.headers).get('authorization')).toBe(`Bearer ${PLATFORM_TOKEN}`);
  });

  it('keeps platform credentials for the admin-only profile, connector, and API key fetchers', async () => {
    const seen: string[] = [];
    const sectionFetchers: NonNullable<ShellRuntimeConfig['sectionFetchers']> = {
      profiles: async (input) => {
        seen.push(input.adminToken);
        return { kind: 'error', businessId: input.businessId, message: 'offline fixture' };
      },
      connectors: async (input) => {
        seen.push(input.adminToken);
        return { kind: 'error', connectorId: input.connectorId, message: 'offline fixture' };
      },
      apiKeys: async (input) => {
        seen.push(input.adminToken);
        return { kind: 'error', message: 'offline fixture' };
      },
    };

    for (const section of ['profiles', 'connectors', 'api-keys'] as const) {
      const response = handleSectionGet(
        section,
        'admin',
        request(`/admin/${section}`),
        claims('admin'),
        config(sectionFetchers),
      );
      expect(response.status).toBe(200);
      await response.deferredSectionExtras?.();
    }

    expect(seen).toEqual([PLATFORM_TOKEN, PLATFORM_TOKEN, PLATFORM_TOKEN]);
  });
});
