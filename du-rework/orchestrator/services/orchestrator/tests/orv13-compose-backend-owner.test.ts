import { handleInternalComposeRoutes } from '../src/http/routes/internal-compose';
import type { RouteContext } from '../src/http/route-context';
import { deriveCsrfToken } from '../src/modules/admin-actions/rbac';
import { signCookie } from '../src/app/admin/shell-auth';

const SESSION_ID = 'a'.repeat(43);
const RUNNER_TOKEN = 'runner-token-that-is-dedicated-and-at-least-32-bytes';

function makeContext(overrides: Partial<RouteContext> = {}): RouteContext {
  const calls: Array<{ operation: string; value?: unknown }> = [];
  const composeOperations = {
    getCatalog: async () => ({ configured: true, hostId: 'host-one' }),
    createPreview: async (actor: unknown, input: unknown) => {
      calls.push({ operation: 'createPreview', value: { actor, input } });
      return { previewId: 'preview' };
    },
    getJob: async (jobId: string) => {
      calls.push({ operation: 'getJob', value: jobId });
      return { jobId, hostId: 'host-one', state: 'UNKNOWN' };
    },
  };
  const base = {
    ingressAudience: 'internal',
    method: 'GET',
    pathname: '/api/internal/compose/catalog',
    searchParams: new URLSearchParams(),
    headers: {
      authorization: 'Bearer platform-admin-token',
      cookie: `du_session=${SESSION_ID}`,
      'x-csrf-token': 'session-csrf',
    },
    body: undefined,
    config: {
      adminToken: 'platform-admin-token',
      adminSessionStore: {
        get: async () => ({
          role: 'admin' as const,
          csrfToken: 'session-csrf',
          tenantId: 'local-admin-configured-tenant',
          issuer: 'du-local',
          sub: 'local-admin-subject',
        }),
      },
      composeRunner: {
        hostId: 'host-one',
        runnerToken: RUNNER_TOKEN,
        manifestDigest: 'b'.repeat(64),
      },
    },
    composeOperations,
    calls,
  };
  return { ...base, ...overrides } as unknown as RouteContext;
}

describe('UI13 Compose internal backend route', () => {
  it('accepts tenant-bearing local Admin sessions only alongside the platform bearer and records opaque identity', async () => {
    const ctx = makeContext({
      method: 'POST',
      pathname: '/api/internal/compose/previews',
      body: {
        hostId: 'host-one', projectId: 'project-one', action: 'restart_service',
        serviceId: 'api', reason: 'Restart a stuck service',
      },
    });

    const result = await handleInternalComposeRoutes(ctx);
    expect(result?.status).toBe(201);
    const call = (ctx as unknown as { calls: Array<{ value: { actor: Record<string, unknown> } }> }).calls[0]!;
    expect(call.value.actor).toEqual({
      actorLabel: 'admin-session',
      actorIssuer: 'du-local',
      actorSub: 'local-admin-subject',
    });
  });

  it('rejects cookie-only, non-Admin, and CSRF-less writes', async () => {
    const cookieOnly = makeContext({ headers: { cookie: `du_session=${SESSION_ID}`, 'x-csrf-token': 'session-csrf' } });
    await expect(handleInternalComposeRoutes(cookieOnly)).rejects.toMatchObject({ status: 401 });

    const viewer = makeContext({
      headers: { authorization: 'Bearer platform-admin-token', cookie: `du_session=${SESSION_ID}`, 'x-csrf-token': 'session-csrf' },
      config: {
        adminToken: 'platform-admin-token',
        adminSessionStore: { get: async () => ({ role: 'viewer' as const, csrfToken: 'session-csrf', tenantId: 'tenant-a' }) },
      } as unknown as RouteContext['config'],
    });
    await expect(handleInternalComposeRoutes(viewer)).rejects.toMatchObject({ status: 403 });

    const noCsrf = makeContext({
      method: 'POST',
      pathname: '/api/internal/compose/previews',
      headers: { authorization: 'Bearer platform-admin-token', cookie: `du_session=${SESSION_ID}` },
      body: {
        hostId: 'host-one', projectId: 'project-one', action: 'restart_service',
        serviceId: 'api', reason: 'Restart a stuck service',
      },
    });
    await expect(handleInternalComposeRoutes(noCsrf)).rejects.toMatchObject({ status: 403, code: 'CSRF_REJECTED' });
  });

  it('labels a legacy shell Admin without inventing a person identity', async () => {
    const secret = 'test-shell-secret-with-enough-entropy';
    const now = Date.now();
    const cookieValue = signCookie(secret, { iss: 'du-admin-shell', role: 'admin', iat: now, exp: now + 60_000 });
    expect(cookieValue).not.toBeNull();
    const ctx = makeContext({
      method: 'POST',
      pathname: '/api/internal/compose/previews',
      headers: {
        authorization: 'Bearer platform-admin-token',
        cookie: `du_admin=${cookieValue}`,
        'x-csrf-token': deriveCsrfToken(secret, cookieValue!),
      },
      config: {
        adminToken: 'platform-admin-token',
        adminShellCookieSecret: secret,
        composeRunner: { hostId: 'host-one', runnerToken: RUNNER_TOKEN, manifestDigest: 'b'.repeat(64) },
      } as unknown as RouteContext['config'],
      body: {
        hostId: 'host-one', projectId: 'project-one', action: 'restart_service',
        serviceId: 'api', reason: 'Restart a stuck service',
      },
    });
    const result = await handleInternalComposeRoutes(ctx);
    expect(result?.status).toBe(201);
    const calls = (ctx as unknown as { calls: Array<{ value: { actor: Record<string, unknown> } }> }).calls;
    expect(calls[0]?.value.actor).toEqual({ actorLabel: 'legacy:admin' });
  });

  it('keeps runner job status behind the dedicated host token', async () => {
    const path = '/api/internal/compose/runner/jobs/0b8786e0-6b42-4a81-8fc4-d27cbf2ceaaa';
    const adminBearer = makeContext({ method: 'GET', pathname: path });
    await expect(handleInternalComposeRoutes(adminBearer)).rejects.toMatchObject({ status: 401 });

    const runner = makeContext({ method: 'GET', pathname: path, headers: { authorization: `Bearer ${RUNNER_TOKEN}` } });
    const result = await handleInternalComposeRoutes(runner);
    expect(result?.status).toBe(200);
    expect((runner as unknown as { calls: Array<{ operation: string; value: unknown }> }).calls).toEqual([
      { operation: 'getJob', value: '0b8786e0-6b42-4a81-8fc4-d27cbf2ceaaa' },
    ]);
  });
});
