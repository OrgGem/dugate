import http from 'node:http';
import { createMemorySessionRepository, createSessionStore } from '../src/modules/auth/session-store';
import { resolveOpaqueSession } from '../src/app/admin/auth-dispatch';
import { dispatchShellRequest, matchShellRoute, type ShellRuntimeConfig } from '../src/app/admin/shell-router';
import { createAdminShellServer } from '../src/app/admin/shell-server';
import type { AdminShellHandle } from '../src/app/admin/shell-server';
import type { AdminShellRequest } from '../src/app/admin/shell-types';
import type { OperationFetcherInput, OperationFetchResult } from '../src/app/admin/operation-section-data';
import type { OverviewFetcherInput, OverviewFetchResult } from '../src/app/admin/overview-section-data';

const PLATFORM_TOKEN = 'platform-bearer-secret';
const TENANT_A_TOKEN = 'tenant-a-bearer-secret';
const TENANT_A = 'tenant-a';
const NOW = Date.UTC(2026, 9, 11, 8, 0, 0);

function makeConfig(
  sessions: ReturnType<typeof createSessionStore>,
  sectionFetchers: NonNullable<ShellRuntimeConfig['sectionFetchers']>,
  tenantAdminTokens: Record<string, string> = { [TENANT_A_TOKEN]: TENANT_A },
): ShellRuntimeConfig {
  return {
    cookieSecret: 'legacy-read-scope-test-secret',
    adminToken: PLATFORM_TOKEN,
    jsonBaseUrl: 'https://orchestrator.internal',
    tenantAdminTokens,
    oidcSessions: sessions,
    sectionFetchers,
  };
}

async function dispatchSession(
  config: ShellRuntimeConfig,
  sessions: ReturnType<typeof createSessionStore>,
  identity: { issuer: string; sub: string; role: 'admin' | 'operator' | 'viewer'; tenantId?: string | null },
  pathname: string,
  query: Record<string, string> = {},
) {
  const session = await sessions.create(identity);
  const request: AdminShellRequest = {
    method: 'GET',
    pathname,
    cookies: { du_session: session.sessionId },
    body: {},
    query,
  };
  const outcome = await resolveOpaqueSession(config, request);
  if (outcome.state !== 'live') throw new Error('test session did not resolve');
  return {
    outcome,
    dispatched: dispatchShellRequest(request, config, outcome.claims),
  };
}

describe('SEC-OR-20261011-01 legacy operations and overview read scope', () => {
  it('uses the session tenant credential and overrides the legacy operations tenant filter', async () => {
    const sessions = createSessionStore({ repo: createMemorySessionRepository(), now: () => NOW });
    const seen: OperationFetcherInput[] = [];
    const fetcher = async (input: OperationFetcherInput): Promise<OperationFetchResult> => {
      seen.push(input);
      return { kind: 'unauthorized', message: 'offline fixture' };
    };
    const config = makeConfig(sessions, { operations: fetcher });
    const { outcome, dispatched } = await dispatchSession(
      config,
      sessions,
      { issuer: 'issuer', sub: 'operator-a', role: 'operator', tenantId: TENANT_A },
      '/admin/operations',
      { tenant: 'tenant-b' },
    );

    expect(outcome.state).toBe('live');
    if (outcome.state !== 'live') return;
    expect(outcome.claims.tenantId).toBe(TENANT_A);
    expect(dispatched.routeId).toBe('section:operations');
    expect(dispatched.response.status).toBe(200);
    await dispatched.response.deferredSectionExtras?.();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      adminToken: TENANT_A_TOKEN,
      tenantFilter: TENANT_A,
    });
    expect(seen[0]?.adminToken).not.toBe(PLATFORM_TOKEN);

    const detail = await dispatchSession(
      config,
      sessions,
      { issuer: 'issuer', sub: 'operator-a', role: 'operator', tenantId: TENANT_A },
      '/admin/operations',
      { tenant: 'tenant-b', operationId: 'op-1' },
    );
    expect(detail.dispatched.response.status).toBe(200);
    await detail.dispatched.response.deferredSectionExtras?.();
    expect(seen).toHaveLength(2);
    expect(seen[1]).toMatchObject({ operationId: 'op-1', adminToken: TENANT_A_TOKEN });
  });

  it('uses the session tenant and tenant credential for legacy overview despite a foreign query value', async () => {
    const sessions = createSessionStore({ repo: createMemorySessionRepository(), now: () => NOW });
    const seen: OverviewFetcherInput[] = [];
    const fetcher = async (input: OverviewFetcherInput): Promise<OverviewFetchResult> => {
      seen.push(input);
      return { kind: 'unauthorized', message: 'offline fixture' };
    };
    const config = makeConfig(sessions, { overview: fetcher });
    const { dispatched } = await dispatchSession(
      config,
      sessions,
      { issuer: 'issuer', sub: 'operator-a', role: 'operator', tenantId: TENANT_A },
      '/admin/overview',
      { tenantId: 'tenant-b' },
    );

    expect(dispatched.routeId).toBe('section:overview');
    expect(dispatched.response.status).toBe(200);
    await dispatched.response.deferredSectionExtras?.();
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ tenantId: TENANT_A, adminToken: TENANT_A_TOKEN });
    expect(seen[0]?.adminToken).not.toBe(PLATFORM_TOKEN);
  });

  it('denies viewers and operators without a mapped tenant credential before either fetcher runs', async () => {
    const sessions = createSessionStore({ repo: createMemorySessionRepository(), now: () => NOW });
    let fetcherCalls = 0;
    const config = makeConfig(sessions, {
      operations: async () => {
        fetcherCalls += 1;
        return { kind: 'unauthorized', message: 'should not run' };
      },
      overview: async () => {
        fetcherCalls += 1;
        return { kind: 'unauthorized', message: 'should not run' };
      },
    });

    for (const [identity, pathname] of [
      [{ issuer: 'issuer', sub: 'viewer', role: 'viewer' as const }, '/admin/operations'],
      [{ issuer: 'issuer', sub: 'operator-no-map', role: 'operator' as const, tenantId: TENANT_A }, '/admin/overview'],
    ] as const) {
      const tenantMap = identity.role === 'operator' ? {} : undefined;
      const scopedConfig = tenantMap === undefined ? config : { ...config, tenantAdminTokens: tenantMap };
      const { dispatched } = await dispatchSession(scopedConfig, sessions, identity, pathname);
      expect(dispatched.response.status).toBe(403);
      expect(dispatched.response.body).toContain('Access denied');
    }
    expect(fetcherCalls).toBe(0);
  });

  it('preserves platform admin access and its explicitly requested tenant filters', async () => {
    const sessions = createSessionStore({ repo: createMemorySessionRepository(), now: () => NOW });
    const operationsSeen: OperationFetcherInput[] = [];
    const overviewSeen: OverviewFetcherInput[] = [];
    const config = makeConfig(sessions, {
      operations: async (input) => {
        operationsSeen.push(input);
        return { kind: 'unauthorized', message: 'offline fixture' };
      },
      overview: async (input) => {
        overviewSeen.push(input);
        return { kind: 'unauthorized', message: 'offline fixture' };
      },
    });

    const operations = await dispatchSession(
      config,
      sessions,
      { issuer: 'issuer', sub: 'platform-admin', role: 'admin' },
      '/admin/operations',
      { tenant: 'tenant-b' },
    );
    expect(operations.dispatched.response.status).toBe(200);
    await operations.dispatched.response.deferredSectionExtras?.();

    const overview = await dispatchSession(
      config,
      sessions,
      { issuer: 'issuer', sub: 'platform-admin', role: 'admin' },
      '/admin/overview',
      { tenantId: 'tenant-b' },
    );
    expect(overview.dispatched.response.status).toBe(200);
    await overview.dispatched.response.deferredSectionExtras?.();

    expect(operationsSeen[0]).toMatchObject({ tenantFilter: 'tenant-b', adminToken: PLATFORM_TOKEN });
    expect(overviewSeen[0]).toMatchObject({ tenantId: 'tenant-b', adminToken: PLATFORM_TOKEN });
  });
});

const CUTOVER_PORT_BASE = 43_940 + (process.pid % 10) * 4;
let cutoverPortOffset = 0;

function httpGet(baseUrl: string, pathname: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(baseUrl + pathname, { method: 'GET' }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({ status: res.statusCode ?? 0, body });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

describe('SEC-OR-20261011-01 cutover: legacy admin shell surface is closed', () => {
  it('no longer maps /admin/legacy or /admin/legacy/ to the admin root', () => {
    expect(matchShellRoute('GET', '/admin/legacy')).toBeNull();
    expect(matchShellRoute('GET', '/admin/legacy/')).toBeNull();
  });

  it('answers 404 over the wire for /admin/legacy and every /admin/legacy/* path', async () => {
    const handle: AdminShellHandle = createAdminShellServer({
      port: CUTOVER_PORT_BASE + cutoverPortOffset++,
      host: '127.0.0.1',
      cookieSecret: 'legacy-cutover-test-secret',
      adminToken: PLATFORM_TOKEN,
      jsonBaseUrl: 'https://orchestrator.internal',
    });
    let baseUrl = '';
    try {
      const ready = await handle.listen();
      baseUrl = ready.url;
      for (const pathname of [
        '/admin/legacy',
        '/admin/legacy/',
        '/admin/legacy/businesses',
        '/admin/legacy/audit',
      ]) {
        const response = await httpGet(baseUrl, pathname);
        expect(response.status).toBe(404);
        expect(response.body).toContain('NOT_FOUND');
        expect(response.body).toContain('Legacy Admin Shell closed');
      }
    } finally {
      await handle.close();
    }
  });
});
