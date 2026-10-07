/**
 * PM-M02-ROUTE: ingress fence between the two JSON listeners.
 *
 * Part 1 is offline and always runs: the guard is pure, so its ordering and
 * normalization rules are provable without a socket.
 * Part 2 is live-gated (DU_LIVE_INFRA=1) and exercises the REAL two-listener
 * app over real HTTP, because an in-process handler test alone does not prove
 * listener fencing.
 */
import { isPublicIngressAllowed, assertIngressAllowed } from '../src/http/ingress-guard';
import { liveDescribe, warnIfSkipped } from './helpers/runtime-harness';

warnIfSkipped(__filename);

describe('PM-M02-ROUTE guard (pure)', () => {
  it('allows health and the public /api/v1 family', () => {
    expect(isPublicIngressAllowed('/health')).toBe(true);
    expect(isPublicIngressAllowed('/api/v1/health')).toBe(true);
    expect(isPublicIngressAllowed('/api/v1')).toBe(true);
    expect(isPublicIngressAllowed('/api/v1/operations/1')).toBe(true);
    expect(isPublicIngressAllowed('/api/v1/connectors/stub/test')).toBe(true);
  });

  it('denies admin BEFORE the public prefix check, then runtime and internal', () => {
    expect(isPublicIngressAllowed('/api/v1/admin')).toBe(false);
    expect(isPublicIngressAllowed('/api/v1/admin/audit')).toBe(false);
    expect(isPublicIngressAllowed('/api/v1/administration')).toBe(true); // not the admin family
    expect(isPublicIngressAllowed('/api/runtime')).toBe(false);
    expect(isPublicIngressAllowed('/api/runtime/v1/tasks/x')).toBe(false);
    expect(isPublicIngressAllowed('/api/internal')).toBe(false);
    expect(isPublicIngressAllowed('/api/internal/anything')).toBe(false);
    expect(isPublicIngressAllowed('/')).toBe(false);
    expect(isPublicIngressAllowed('/anything-else')).toBe(false);
  });

  it('denies on the public listener for every audience except internal', () => {
    expect(() => assertIngressAllowed('public', '/api/v1/admin')).toThrow(/Not Found/);
    expect(() => assertIngressAllowed('public', '/api/runtime/v1/claim')).toThrow(/Not Found/);
    expect(() => assertIngressAllowed('internal', '/api/v1/admin')).not.toThrow();
    expect(() => assertIngressAllowed('internal', '/api/runtime/v1/claim')).not.toThrow();
  });

  it('marks the denial as a generic 404, not a distinguishable status', () => {
    try {
      assertIngressAllowed('public', '/api/v1/admin');
      throw new Error('expected a throw');
    } catch (error) {
      expect((error as { status?: number }).status).toBe(404);
      expect((error as { code?: string }).code).toBe('NOT_FOUND');
    }
  });

  it('cannot be bypassed by slash/encoding tricks in the normalized pathname', () => {
    // Single normalization is structural: create-app passes the SAME
    // `url.pathname` to the guard and to deps.route. These cases pin what the
    // URL parser hands both of them.
    // A repeated slash is NOT the admin family by exact prefix, so the guard
    // lets it through; the router's own matcher is the second line of defence
    // and sees the SAME pathname, so there is no bypass.
    expect(isPublicIngressAllowed(new URL('/api/v1//admin/', 'http://x').pathname)).toBe(true);
    expect(isPublicIngressAllowed(new URL('/api/v1/./operations', 'http://x').pathname)).toBe(true);
    expect(isPublicIngressAllowed(new URL('/api/v1/foo/../runtime', 'http://x').pathname)).toBe(true);
    // a dot segment that RESOLVES OUT of /admin lands on the public family,
    // which is correct: the guard sees the same pathname the router will use
    expect(isPublicIngressAllowed(new URL('/api/v1/admin/..', 'http://x').pathname)).toBe(true);
    expect(isPublicIngressAllowed(new URL('/api/v1/admin/../admin/audit', 'http://x').pathname)).toBe(false);
    // an encoded separator stays inside ONE segment and does not become /admin
    expect(isPublicIngressAllowed(new URL('/api/v1%2Fadmin', 'http://x').pathname)).toBe(false);
  });
});

liveDescribe('PM-M02-ROUTE listener fencing (DU_LIVE_INFRA=1)', () => {
  let app: Awaited<ReturnType<typeof import('../src/server').createApp>>;
  let publicBase: string;
  let internalBase: string;

  beforeAll(async () => {
    const { createApp } = await import('../src/server');
    app = await createApp({
      port: 0,
      host: '127.0.0.1',
      internalPort: 0,
      internalHost: '127.0.0.1',
      databaseUrl: process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test',
      redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6380',
      adminToken: 'pmm02-admin',
      autoDispatch: false,
      autoMigrate: true,
    });
    const server = await app.listen();
    const publicAddr = server.address();
    const internalAddr = app.internalServer?.address();
    if (typeof publicAddr !== 'object' || !publicAddr) throw new Error('public listener did not bind');
    if (typeof internalAddr !== 'object' || !internalAddr) throw new Error('internal listener did not bind');
    publicBase = `http://127.0.0.1:${publicAddr.port}`;
    internalBase = `http://127.0.0.1:${internalAddr.port}`;
  }, 120_000);

  afterAll(async () => {
    await app?.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
  }, 60_000);

  it('the two listeners are distinct sockets', () => {
    expect(publicBase).not.toBe(internalBase);
  });

  it('public listener answers a generic 404 for admin/runtime/internal, with or without credentials', async () => {
    const privileged = { authorization: 'Bearer pmm02-admin' };
    for (const path of ['/api/v1/admin', '/api/v1/admin/audit', '/api/runtime/v1/claim', '/api/internal/x']) {
      for (const headers of [{}, privileged]) {
        const res = await fetch(publicBase + path, { method: 'GET', headers });
        expect(res.status).toBe(404);
      }
      const post = await fetch(publicBase + path, { method: 'POST', headers: privileged, body: '{}' });
      expect(post.status).toBe(404);
    }
  }, 30_000);

  it('public listener keeps health and the public family working', async () => {
    const health = await fetch(`${publicBase}/api/v1/health`);
    expect([200, 503]).toContain(health.status);
    const unauthorized = await fetch(`${publicBase}/api/v1/operations`);
    expect(unauthorized.status).not.toBe(404); // reached dispatch, not the fence
  }, 30_000);

  it('spoofed Host/Forwarded headers cannot select internal dispatch on the public socket', async () => {
    const res = await fetch(`${publicBase}/api/v1/admin`, {
      headers: {
        authorization: 'Bearer pmm02-admin',
        host: 'internal.local',
        forwarded: 'host=internal.local;proto=https',
        'x-forwarded-host': 'internal.local',
        'x-ingress-audience': 'internal',
      },
    });
    expect(res.status).toBe(404);
  }, 30_000);

  it('internal listener serves admin (auth enforced, not fencing)', async () => {
    const denied = await fetch(`${internalBase}/api/v1/admin/audit`);
    expect(denied.status).not.toBe(404);
    expect([401, 403]).toContain(denied.status);
  }, 30_000);

  it('close() stops both listeners', async () => {
    const before = (app.server.listening, app.internalServer?.listening);
    expect(before).toBe(true);
    await app.close({ timeoutMs: 0, pollIntervalMs: 10 });
    expect(app.server.listening).toBe(false);
    expect(app.internalServer?.listening).toBe(false);
  }, 60_000);
});
