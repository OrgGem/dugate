/**
 * RFX-11 + RFX-12 focused route proof.
 *
 * RFX-11 (P0, host-header injection): artifact grant URLs (upload/download/
 * part) used to be built from the request `Host` header, so any reverse proxy
 * forwarding a caller-chosen Host could make a grant token point at an
 * attacker endpoint. The route table below sends `Host: evil.example` with a
 * configured `publicBaseUrl` and asserts the configured host wins; a dev/test
 * boot with no base URL keeps the legacy Host behavior (a zero-config
 * `autoMigrate: true` boot, the mode live fixtures use, and an explicit
 * `NODE_ENV=development` boot), while a production boot with no base URL
 * answers the relative path and never echoes the Host.
 *
 * RFX-12 (P2, ops-honesty): `PUT /api/runtime/v1/workers/:instanceId/heartbeat`
 * is a compat stub with no state behind it. It must not report 'HEALTHY'
 * (autoscalers/operators would act on fabricated data); the ack is parsed
 * against the published `HeartbeatAckSchema` so it can never drift out of the
 * worker-SDK wire contract.
 *
 * Offline: `route()` is driven directly with a hand-built RouteContext (the
 * br12-isolation-offline pattern); no DB, no Redis, no sockets.
 */
import { HeartbeatAckSchema } from '@du/contracts';
import { absoluteGrantUrl, allowHostDerivedGrantUrl, route, type RouteContext } from '../src/server';

const PLATFORM_TOKEN = 'rfx11-platform-runtime-token';
const CONFIGURED_BASE = 'https://api.dugate.example';
const GRANT_HOST_PLACEHOLDER = 'evil.example';
const UPLOAD_PATH = '/api/runtime/v1/tasks/task-1/artifacts';
const ACCESS_PATH = '/api/runtime/v1/artifacts/artifact-1/access';
const PART_GRANT_PATH = '/api/runtime/v1/artifacts/artifact-1/multipart/part-grant';
const HEARTBEAT_PATH = '/api/runtime/v1/workers/worker-1/heartbeat';

const RELATIVE_GRANT = '/api/runtime/v1/artifacts/blob/storage-1?grant=opaque';
const RELATIVE_PART = '/api/runtime/v1/artifacts/blob/storage-1?grant=opaque&part=1';

function makeCtx(overrides: {
  method: string;
  pathname: string;
  publicBaseUrl?: string;
  runtimeBaseUrl?: string;
  autoMigrate?: boolean;
  body?: unknown;
}): RouteContext {
  return {
    method: overrides.method,
    pathname: overrides.pathname,
    searchParams: new URLSearchParams(),
    headers: { authorization: `Bearer ${PLATFORM_TOKEN}` },
    body: overrides.body ?? { leaseEpoch: 1 },
    rawBody: Buffer.alloc(0),
    correlationId: 'rfx11-route-test',
    host: GRANT_HOST_PLACEHOLDER,
    db: { query: jest.fn(async () => ({ rows: [], rowCount: 0 })) },
    redis: {} as never,
    registry: {} as never,
    profiles: {} as never,
    audit: {} as never,
    submission: {} as never,
    runtime: {} as never,
    usage: {} as never,
    artifacts: {
      requestUpload: jest.fn(async () => ({
        artifactId: 'artifact-1',
        uploadUrl: RELATIVE_GRANT,
        expiresAt: '2026-10-02T12:00:00.000Z',
      })),
      requestAccess: jest.fn(async () => ({
        artifactId: 'artifact-1',
        downloadUrl: RELATIVE_GRANT,
        uploadUrl: RELATIVE_GRANT,
        expiresAt: '2026-10-02T12:00:00.000Z',
      })),
    } as never,
    multipart: {
      grantPart: jest.fn(async () => ({
        artifactId: 'artifact-1',
        partNumber: 1,
        partUrl: RELATIVE_PART,
        expiresAt: '2026-10-02T12:00:00.000Z',
      })),
    } as never,
    publicUploadGateway: null,
    artifactDecryptDeps: null,
    grants: null,
    connectors: {} as never,
    lifecycle: {} as never,
    dispatcher: {} as never,
    getQueue: jest.fn() as never,
    queueIntegrity: () => undefined,
    credentialWorkflow: undefined,
    deliveryEncryption: null,
    cryptoConfig: null,
    config: {
      port: 0,
      databaseUrl: 'postgresql://unused',
      redisUrl: 'redis://unused',
      runtimeToken: PLATFORM_TOKEN,
      ...(overrides.publicBaseUrl ? { publicBaseUrl: overrides.publicBaseUrl } : {}),
      ...(overrides.runtimeBaseUrl ? { runtimeBaseUrl: overrides.runtimeBaseUrl } : {}),
      ...(overrides.autoMigrate !== undefined ? { autoMigrate: overrides.autoMigrate } : {}),
    },
  } as unknown as RouteContext;
}

async function withNodeEnv<T>(value: string, fn: () => Promise<T>): Promise<T> {
  const saved = process.env.NODE_ENV;
  process.env.NODE_ENV = value;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = saved;
  }
}

describe('RFX-11: artifact grant URLs never trust the request Host in production', () => {
  it('production runtime grants use the internal origin ahead of public origin and untrusted Host', async () => {
    await withNodeEnv('production', async () => {
      for (const pathname of [UPLOAD_PATH, ACCESS_PATH, PART_GRANT_PATH]) {
        const result = await route(makeCtx({ method: 'POST', pathname, publicBaseUrl: CONFIGURED_BASE, runtimeBaseUrl: 'http://orchestrator:3002' }));
        const grant = result.body as Record<string, unknown>;
        for (const key of ['uploadUrl', 'downloadUrl', 'partUrl']) {
          if (typeof grant[key] === 'string') expect(new URL(grant[key]).origin).toBe('http://orchestrator:3002');
        }
      }
    });
  });
  it('upload grant returns the configured base host despite Host: evil.example', async () => {
    const ctx = makeCtx({ method: 'POST', pathname: UPLOAD_PATH, publicBaseUrl: CONFIGURED_BASE });
    const result = await route(ctx);
    expect(result.status).toBe(201);
    expect((result.body as { uploadUrl: string }).uploadUrl).toBe(`${CONFIGURED_BASE}${RELATIVE_GRANT}`);
  });

  it('access grant rewrites downloadUrl and uploadUrl onto the configured base host', async () => {
    const ctx = makeCtx({ method: 'POST', pathname: ACCESS_PATH, publicBaseUrl: CONFIGURED_BASE });
    const result = await route(ctx);
    expect(result.status).toBe(200);
    const body = result.body as { downloadUrl: string; uploadUrl: string };
    expect(body.downloadUrl).toBe(`${CONFIGURED_BASE}${RELATIVE_GRANT}`);
    expect(body.uploadUrl).toBe(`${CONFIGURED_BASE}${RELATIVE_GRANT}`);
  });

  it('multipart part grant rewrites partUrl onto the configured base host', async () => {
    const ctx = makeCtx({ method: 'POST', pathname: PART_GRANT_PATH, publicBaseUrl: CONFIGURED_BASE });
    const result = await route(ctx);
    expect(result.status).toBe(200);
    expect((result.body as { partUrl: string }).partUrl).toBe(`${CONFIGURED_BASE}${RELATIVE_PART}`);
  });

  it('a zero-config boot without a base URL keeps the legacy Host-derived URL', async () => {
    // autoMigrate:true is the documented dev/test zero-config boot (and what
    // every in-process live fixture passes), so the fallback stays legal.
    const ctx = makeCtx({ method: 'POST', pathname: UPLOAD_PATH, autoMigrate: true });
    const result = await route(ctx);
    expect((result.body as { uploadUrl: string }).uploadUrl).toBe(`http://${GRANT_HOST_PLACEHOLDER}${RELATIVE_GRANT}`);
  });

  it('an explicit NODE_ENV=development boot without a base URL keeps the legacy Host-derived URL', async () => {
    await withNodeEnv('development', async () => {
      const ctx = makeCtx({ method: 'POST', pathname: UPLOAD_PATH });
      const result = await route(ctx);
      expect((result.body as { uploadUrl: string }).uploadUrl).toBe(`http://${GRANT_HOST_PLACEHOLDER}${RELATIVE_GRANT}`);
    });
  });

  it('production without a configured base returns the relative path, never the Host', async () => {
    await withNodeEnv('production', async () => {
      const ctx = makeCtx({ method: 'POST', pathname: UPLOAD_PATH });
      const result = await route(ctx);
      const uploadUrl = (result.body as { uploadUrl: string }).uploadUrl;
      expect(uploadUrl).toBe(RELATIVE_GRANT);
      expect(uploadUrl).not.toContain(GRANT_HOST_PLACEHOLDER);
    });
  });

  it('absoluteGrantUrl: signed URLs pass through, bases win, and the fallback is dev/test-only', () => {
    expect(absoluteGrantUrl(GRANT_HOST_PLACEHOLDER, 'https://s3.test/signed?sig=opaque', { publicBaseUrl: CONFIGURED_BASE }))
      .toBe('https://s3.test/signed?sig=opaque');
    expect(absoluteGrantUrl(GRANT_HOST_PLACEHOLDER, '/api/x', { publicBaseUrl: 'https://api.dugate.example/' }))
      .toBe(`${CONFIGURED_BASE}/api/x`);
    // A configured base always wins, even on a zero-config boot.
    expect(absoluteGrantUrl(GRANT_HOST_PLACEHOLDER, '/api/x', { publicBaseUrl: CONFIGURED_BASE, zeroConfigBoot: true }))
      .toBe(`${CONFIGURED_BASE}/api/x`);
    expect(absoluteGrantUrl(GRANT_HOST_PLACEHOLDER, '/api/x', { env: { NODE_ENV: 'development' } }))
      .toBe(`http://${GRANT_HOST_PLACEHOLDER}/api/x`);
    expect(absoluteGrantUrl(GRANT_HOST_PLACEHOLDER, '/api/x', { env: { NODE_ENV: 'production' } }))
      .toBe('/api/x');
    expect(absoluteGrantUrl(GRANT_HOST_PLACEHOLDER, '/api/x', { env: { NODE_ENV: 'production' }, zeroConfigBoot: true }))
      .toBe(`http://${GRANT_HOST_PLACEHOLDER}/api/x`);
  });

  it('allowHostDerivedGrantUrl: only dev/test or zero-config boots qualify', () => {
    expect(allowHostDerivedGrantUrl({ NODE_ENV: 'production' })).toBe(false);
    expect(allowHostDerivedGrantUrl({})).toBe(false);
    expect(allowHostDerivedGrantUrl({ NODE_ENV: 'staging' })).toBe(false);
    expect(allowHostDerivedGrantUrl({ NODE_ENV: 'test' })).toBe(true);
    expect(allowHostDerivedGrantUrl({ NODE_ENV: 'development' })).toBe(true);
    expect(allowHostDerivedGrantUrl({ NODE_ENV: 'production' }, { zeroConfigBoot: true })).toBe(true);
  });
});

describe('RFX-12: worker heartbeat ack is an honest compat stub', () => {
  it('answers the published schema with DEGRADED and touches no runtime state', async () => {
    const ctx = makeCtx({ method: 'PUT', pathname: HEARTBEAT_PATH, body: { businessId: 'business-a' } });
    const result = await route(ctx);
    expect(result.status).toBe(200);
    const ack = result.body as { health: string; leaseExpiresAt: string; capacity: number };
    expect(ack.health).toBe('DEGRADED');
    expect(ack.health).not.toBe('HEALTHY');
    // Wire-contract lock: the worker SDK zod-parses this exact schema.
    expect(HeartbeatAckSchema.safeParse(ack).success).toBe(true);
    expect(new Date(ack.leaseExpiresAt).getTime()).toBeGreaterThan(Date.now());
    expect(ack.capacity).toBe(1);
    expect(ctx.db.query as jest.Mock).not.toHaveBeenCalled();
  });
});
