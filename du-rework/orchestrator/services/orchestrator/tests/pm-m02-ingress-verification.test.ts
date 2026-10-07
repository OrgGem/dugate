/**
 * PM-M02 independent live-listener verification harness (IF-01..IF-06).
 *
 * This file is deliberately opt-in: it boots the real Orchestrator against a
 * loopback test PostgreSQL database and Redis, provisions a unique schema and
 * Redis DB, and opens real TCP listeners. Run only in an approved disposable
 * infra window with DU_LIVE_INFRA=1 and DU_PM_M02_INGRESS_VERIFY=1.
 *
 * No request in this harness derives ingress identity from caller headers.
 * The two listener handles are inspected structurally so this independent test
 * can be prepared before app.internalServer lands; when enabled, a missing
 * internal listener is an explicit failure rather than a skipped assertion.
 */
import { randomUUID } from 'node:crypto';
import { request as httpRequest, type Server as HttpServer } from 'node:http';
import {
  connect as tcpConnect,
  createServer as createTcpServer,
  type AddressInfo,
  type Server as TcpServer,
} from 'node:net';
import { Pool } from 'pg';
import { createApp, type App, type ServerConfig } from '../src/server';
import {
  assertSafeIsolationConfig,
  createTestIsolationContext,
  generateSchemaSetupDdl,
  generateSchemaTeardownDdl,
  type TestIsolationContext,
} from '../../../../tests/isolation/namespace';
import {
  validateTestDatabaseTarget,
  validateTestRedisTarget,
} from './helpers/test-target-guard';

const LIVE_INFRA = process.env.DU_LIVE_INFRA === '1';
const ENABLE_PM_M02 = process.env.DU_PM_M02_INGRESS_VERIFY === '1';
if (ENABLE_PM_M02 && !LIVE_INFRA) {
  throw new Error('PM-M02 ingress harness requires DU_LIVE_INFRA=1 as well as DU_PM_M02_INGRESS_VERIFY=1.');
}
const RUN_LIVE = LIVE_INFRA && ENABLE_PM_M02;
const liveDescribe: typeof describe = RUN_LIVE ? describe : describe.skip;
if (!RUN_LIVE) {
  console.warn(
    'pm-m02-ingress-verification.test.ts: SKIPPED - enable only in an approved disposable infra window with DU_LIVE_INFRA=1 and DU_PM_M02_INGRESS_VERIFY=1.'
  );
}

const RUNTIME_TOKEN = `pm-m02-runtime-${randomUUID()}`;
const ADMIN_TOKEN = `pm-m02-admin-${randomUUID()}`;
const INVALID_TOKEN = `pm-m02-invalid-${randomUUID()}`;

interface RawResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

interface RequestOptions {
  port: number;
  path: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | Buffer;
  timeoutMs?: number;
}

interface HeldResponse extends RawResponse {
  requestFinishedBeforeResponse: boolean;
}

interface PmM02ServerConfig extends ServerConfig {
  host: string;
  internalPort: number;
  internalHost: string;
}

interface PmM02App extends App {
  internalServer: HttpServer;
}

function rawRequest(options: RequestOptions): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'GET',
        headers: { connection: 'close', ...(options.headers ?? {}) },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      }
    );
    const timeout = setTimeout(() => request.destroy(new Error('HTTP verification request timed out')), options.timeoutMs ?? 5_000);
    request.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    request.on('close', () => clearTimeout(timeout));
    if (options.body !== undefined) request.write(options.body);
    request.end();
  });
}

/**
 * Send one chunk and intentionally leave the request stream open. A compliant
 * public-ingress guard must finish the 404 without waiting for end()/body parse.
 */
function rawHeldOpenRequest(options: RequestOptions): Promise<HeldResponse> {
  return new Promise((resolve, reject) => {
    let requestFinished = false;
    let settled = false;
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port: options.port,
        path: options.path,
        method: options.method ?? 'PUT',
        headers: {
          connection: 'close',
          'content-type': 'application/octet-stream',
          'transfer-encoding': 'chunked',
          ...(options.headers ?? {}),
        },
        agent: false,
      },
      (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          settled = true;
          clearTimeout(timeout);
          const requestFinishedBeforeResponse = requestFinished;
          // The server rejected before request.end(); close the client side as
          // well so an unread-body check cannot leave a test socket behind.
          request.destroy();
          resolve({
            status: response.statusCode ?? 0,
            headers: response.headers,
            text: Buffer.concat(chunks).toString('utf8'),
            requestFinishedBeforeResponse,
          });
        });
      }
    );
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.destroy();
      reject(new Error('public runtime request waited for the held-open body instead of rejecting ingress early'));
    }, options.timeoutMs ?? 1_500);
    request.on('finish', () => {
      requestFinished = true;
    });
    request.on('error', (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      reject(error);
    });
    request.write(Buffer.from([0x00, 0x01, 0x02]));
  });
}

function parsedBody(response: RawResponse): Record<string, unknown> {
  if (!response.text) return {};
  try {
    return JSON.parse(response.text) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function expectGenericIngress404(response: RawResponse): void {
  expect(response.status).toBe(404);
  expect(String(response.headers['content-type'])).toContain('application/problem+json');
  expect(parsedBody(response)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
}

function addressOf(server: TcpServer): AddressInfo {
  const address = server.address();
  if (!address || typeof address === 'string') {
    throw new Error('Expected a bound TCP listener with an internet address.');
  }
  return address;
}

function requireInternalServer(app: App): HttpServer {
  const server = (app as PmM02App).internalServer;
  if (!server) throw new Error('PM-M02 contract failure: app.internalServer was not exposed.');
  return server;
}

function listenTcp(server: TcpServer, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening);
      reject(error);
    };
    const onListening = (): void => {
      server.off('error', onError);
      resolve();
    };
    server.once('error', onError);
    server.once('listening', onListening);
    server.listen(port, '127.0.0.1');
  });
}

async function unusedLoopbackPort(): Promise<number> {
  const probe = createTcpServer();
  await listenTcp(probe, 0);
  const port = addressOf(probe).port;
  await new Promise<void>((resolve, reject) => {
    probe.close((error) => (error ? reject(error) : resolve()));
  });
  return port;
}

async function expectPortClosed(port: number): Promise<void> {
  try {
    const response = await rawRequest({ port, path: '/health', timeoutMs: 1_000 });
    throw new Error(`listener still answered HTTP ${response.status} after close()`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    expect(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH']).toContain(code);
  }
}

function listenErrorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function rawMalformedRequestTarget(port: number): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    const socket = tcpConnect(port, '127.0.0.1');
    const chunks: Buffer[] = [];
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error('malformed request-target did not receive a bounded response'));
    }, 2_000);
    socket.on('connect', () => {
      // Valid HTTP/1.1 framing with an invalid absolute request target. This
      // reaches the listener URL parser, which must answer a controlled 400.
      socket.write('GET http://[ HTTP/1.1\r\nHost: public.example\r\nConnection: close\r\n\r\n');
    });
    socket.on('data', (chunk) => chunks.push(chunk));
    socket.on('error', (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    socket.on('end', () => {
      clearTimeout(timeout);
      const raw = Buffer.concat(chunks).toString('utf8');
      const splitAt = raw.indexOf('\r\n\r\n');
      if (splitAt < 0) {
        reject(new Error('malformed request-target response had no HTTP header boundary'));
        return;
      }
      const headerText = raw.slice(0, splitAt);
      const firstLine = headerText.split('\r\n')[0] ?? '';
      const status = Number(firstLine.split(' ')[1]);
      const headers: Record<string, string> = {};
      for (const line of headerText.split('\r\n').slice(1)) {
        const colon = line.indexOf(':');
        if (colon < 0) continue;
        headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim();
      }
      resolve({ status, headers, text: raw.slice(splitAt + 4) });
    });
  });
}

liveDescribe('PM-M02 independent ingress verification (real HTTP listeners)', () => {
  const baseDatabaseUrl =
    process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@127.0.0.1:5433/du_orchestrator_test';
  const baseRedisUrl = process.env.REDIS_URL ?? 'redis://127.0.0.1:6380';
  let isolation: TestIsolationContext;
  let databaseUrl: string;
  let redisUrl: string;
  let app: App | undefined;
  let publicPort: number;
  let internalPort: number;

  function serverConfig(options: {
    publicPort?: number;
    internalPort?: number;
    adminShellPort?: number;
    mountAdminShell?: boolean;
    autoMigrate?: boolean;
    autoDispatch?: boolean;
  } = {}): PmM02ServerConfig {
    return {
      port: options.publicPort ?? 0,
      host: '127.0.0.1',
      internalPort: options.internalPort ?? 0,
      internalHost: '127.0.0.1',
      adminShellHost: '127.0.0.1',
      adminShellPort: options.adminShellPort,
      adminShellCookieSecret: options.mountAdminShell ? `pm-m02-shell-${randomUUID()}` : undefined,
      databaseUrl,
      redisUrl,
      runtimeToken: RUNTIME_TOKEN,
      adminToken: ADMIN_TOKEN,
      autoMigrate: options.autoMigrate ?? false,
      autoDispatch: options.autoDispatch ?? false,
      leaseRecoveryIntervalMs: 0,
      webhookDispatchIntervalMs: 0,
      shutdownTimeoutMs: 10,
      shutdownPollIntervalMs: 1,
    };
  }

  async function createLiveApp(options: Parameters<typeof serverConfig>[0] = {}): Promise<App> {
    return createApp(serverConfig(options));
  }

  beforeAll(async () => {
    validateTestDatabaseTarget(baseDatabaseUrl);
    validateTestRedisTarget(baseRedisUrl);
    isolation = createTestIsolationContext({ runId: `pm_m02_${randomUUID().replace(/-/g, '')}` });
    databaseUrl = isolation.getDatabaseUrlWithSchema(baseDatabaseUrl);

    // Force the helper to allocate a dedicated Redis DB even if REDIS_URL was
    // explicitly pointed at a nonzero test DB; the harness must not share it.
    const redisSeed = new URL(baseRedisUrl);
    redisSeed.pathname = '/0';
    redisUrl = isolation.getRedisUrl(redisSeed.toString());
    validateTestDatabaseTarget(databaseUrl);
    validateTestRedisTarget(redisUrl);
    assertSafeIsolationConfig({ databaseUrl, redisUrl, isolationCtx: isolation });

    const setupPool = new Pool({ connectionString: baseDatabaseUrl });
    try {
      await setupPool.query(generateSchemaSetupDdl(isolation.dbSchema));
    } finally {
      await setupPool.end();
    }

    app = await createLiveApp({ autoMigrate: true, autoDispatch: false });
    const publicServer = await app.listen();
    const internalServer = requireInternalServer(app);
    publicPort = addressOf(publicServer).port;
    internalPort = addressOf(internalServer).port;
  }, 120_000);

  afterAll(async () => {
    await app?.close({ timeoutMs: 10, pollIntervalMs: 1 }).catch(() => undefined);
    if (isolation && process.env.PRESERVE_TEST_SCHEMA !== 'true') {
      const cleanupPool = new Pool({ connectionString: baseDatabaseUrl });
      try {
        await cleanupPool.query(generateSchemaTeardownDdl(isolation.dbSchema));
      } finally {
        await cleanupPool.end();
      }
    }
  }, 30_000);

  test('IF-01: public listener returns generic 404 for runtime, admin and internal paths for all credentials/methods', async () => {
    const deniedPaths = [
      '/api/runtime',
      '/api/runtime/v1/workers/pm-m02-worker/heartbeat',
      '/api/v1/admin',
      '/api/v1/admin/audit?limit=1',
      '/api/internal',
      '/api/internal/not-installed',
    ];
    const methods = ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'];
    const credentials: Array<{ name: string; headers: Record<string, string> }> = [
      { name: 'absent', headers: {} },
      { name: 'invalid', headers: { authorization: `Bearer ${INVALID_TOKEN}` } },
      { name: 'valid runtime', headers: { authorization: `Bearer ${RUNTIME_TOKEN}` } },
      { name: 'valid admin', headers: { authorization: `Bearer ${ADMIN_TOKEN}` } },
    ];

    for (const path of deniedPaths) {
      for (const method of methods) {
        for (const credential of credentials) {
          const response = await rawRequest({
            port: publicPort,
            path,
            method,
            headers: credential.headers,
          });
          try {
            expectGenericIngress404(response);
          } catch (error) {
            throw new Error(
              `IF-01 expected generic 404 for ${method} ${path} with ${credential.name} credential: ${String(error)}`
            );
          }
        }
      }
    }

    for (const path of ['/health', '/api/v1/health']) {
      const response = await rawRequest({ port: publicPort, path });
      expect(response.status).toBe(200);
      expect(parsedBody(response)).toMatchObject({ status: 'ok', db: true, redis: true });
    }
  });

  test('IF-02: held-open public runtime blob body gets rejected before body completion or route side effects', async () => {
    const activeApp = app;
    if (!activeApp) throw new Error('Orchestrator app was not booted.');

    const dbQuery = jest.spyOn(activeApp.db, 'query');
    const getQueue = jest.spyOn(activeApp, 'getQueue');
    const fetchSpy = jest.spyOn(globalThis, 'fetch');
    dbQuery.mockClear();
    getQueue.mockClear();
    fetchSpy.mockClear();
    try {
      const response = await rawHeldOpenRequest({
        port: publicPort,
        path: '/api/runtime/v1/artifacts/blob/pm-m02-held-open',
        method: 'PUT',
        headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
      });
      expectGenericIngress404(response);
      expect(response.requestFinishedBeforeResponse).toBe(false);
      expect(dbQuery).not.toHaveBeenCalled();
      expect(getQueue).not.toHaveBeenCalled();
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      getQueue.mockRestore();
      dbQuery.mockRestore();
    }
  });

  test('IF-03: spoofed ingress headers and normalized path variants cannot select internal dispatch', async () => {
    const spoofHeaders = {
      host: 'orchestrator-internal.example:3002',
      forwarded: 'host=orchestrator-internal.example:3002;proto=http',
      'x-forwarded-host': 'orchestrator-internal.example:3002',
      'x-forwarded-for': '127.0.0.1',
      'x-forwarded-proto': 'http',
      'x-forwarded-port': '3002',
      'x-ingress-audience': 'internal',
    };
    const exactProtectedCases = [
      { path: '/api/runtime/v1/workers/pm-m02-worker/heartbeat', auth: `Bearer ${RUNTIME_TOKEN}` },
      { path: '/api/v1/admin/audit?limit=1', auth: `Bearer ${ADMIN_TOKEN}` },
    ];
    for (const candidate of exactProtectedCases) {
      const response = await rawRequest({
        port: publicPort,
        path: candidate.path,
        method: candidate.path.includes('/heartbeat') ? 'PUT' : 'GET',
        headers: { ...spoofHeaders, authorization: candidate.auth },
      });
      expectGenericIngress404(response);
    }

    const normalizedVariants = [
      { path: '/api/runtime%2fv1/workers/pm-m02-worker/heartbeat', auth: `Bearer ${RUNTIME_TOKEN}` },
      { path: '/api/runtime//v1/workers/pm-m02-worker/heartbeat', auth: `Bearer ${RUNTIME_TOKEN}` },
      { path: '/api/runtime/v1/workers/pm-m02-worker/heartbeat/', auth: `Bearer ${RUNTIME_TOKEN}` },
      { path: '/api/v1/admin/../admin/audit?limit=1', auth: `Bearer ${ADMIN_TOKEN}` },
      { path: '/api/v1//admin/audit?limit=1', auth: `Bearer ${ADMIN_TOKEN}` },
      { path: '/api/v1/%61dmin/audit?limit=1', auth: `Bearer ${ADMIN_TOKEN}` },
    ];

    for (const candidate of normalizedVariants) {
      const response = await rawRequest({
        port: publicPort,
        path: candidate.path,
        method: candidate.path.includes('/heartbeat') ? 'PUT' : 'GET',
        headers: { ...spoofHeaders, authorization: candidate.auth },
      });
      expect([400, 404]).toContain(response.status);
      if (response.status === 400) {
        expect(String(response.headers['content-type'])).toContain('application/problem+json');
        expect(parsedBody(response)).toMatchObject({ status: 400 });
      }
      if (response.status === 404) {
        expect(parsedBody(response)).toMatchObject({ status: 404, code: 'NOT_FOUND' });
      }
    }

    const malformed = await rawMalformedRequestTarget(publicPort);
    expect(malformed.status).toBe(400);
    expect(String(malformed.headers['content-type'])).toContain('application/problem+json');
    expect(parsedBody(malformed)).toMatchObject({ status: 400, code: 'INVALID_REQUEST' });
  });

  test('IF-04: internal listener permits the existing runtime route only with the valid platform token', async () => {
    const accepted = await rawRequest({
      port: internalPort,
      path: '/api/runtime/v1/workers/pm-m02-worker/heartbeat',
      method: 'PUT',
      headers: {
        authorization: `Bearer ${RUNTIME_TOKEN}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({}),
    });
    expect(accepted.status).toBe(200);
    expect(parsedBody(accepted)).toMatchObject({ health: 'DEGRADED' });

    const rejected = await rawRequest({
      port: internalPort,
      path: '/api/runtime/v1/workers/pm-m02-worker/heartbeat',
      method: 'PUT',
      headers: { authorization: `Bearer ${INVALID_TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(rejected.status).toBe(401);
  });

  test('IF-04 control: internal listener still accepts a valid admin identity on the existing admin route', async () => {
    const response = await rawRequest({
      port: internalPort,
      path: '/api/v1/admin/audit?limit=1',
      headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
    });
    expect(response.status).toBe(200);
  });

  test('IF-06: both listeners bind independent ephemeral ports, loops start once, and close releases both sockets', async () => {
    const lifecycleApp = await createLiveApp({ autoMigrate: false, autoDispatch: true });
    const dispatcherStart = jest.spyOn(lifecycleApp.dispatcher, 'start');
    let internalServer: HttpServer | undefined;
    let publicAddress: AddressInfo | undefined;
    let internalAddress: AddressInfo | undefined;
    try {
      internalServer = requireInternalServer(lifecycleApp);
      const publicServer = await lifecycleApp.listen();
      publicAddress = addressOf(publicServer);
      internalAddress = addressOf(internalServer);
      expect(publicServer.listening).toBe(true);
      expect(internalServer.listening).toBe(true);
      expect(publicAddress.port).toBeGreaterThan(0);
      expect(internalAddress.port).toBeGreaterThan(0);
      expect(internalAddress.port).not.toBe(publicAddress.port);
      expect(dispatcherStart).toHaveBeenCalledTimes(1);
    } finally {
      await lifecycleApp.close({ timeoutMs: 10, pollIntervalMs: 1 });
    }

    expect(lifecycleApp.server.listening).toBe(false);
    expect(internalServer?.listening).toBe(false);
    if (publicAddress && internalAddress) {
      await expectPortClosed(publicAddress.port);
      await expectPortClosed(internalAddress.port);
    }
    dispatcherStart.mockRestore();
  });

  test('IF-06 failure cleanup: a failed second listener bind preserves EADDRINUSE and closes the first listener', async () => {
    const occupied = createTcpServer();
    await listenTcp(occupied, 0);
    const occupiedPort = addressOf(occupied).port;
    const partialApp = await createLiveApp({
      publicPort: 0,
      internalPort: occupiedPort,
      autoMigrate: false,
      autoDispatch: false,
    });
    let internalServer: HttpServer | undefined;
    let listenError: unknown;
    let attemptedPublicPort: number | undefined;
    partialApp.server.once('listening', () => {
      attemptedPublicPort = addressOf(partialApp!.server).port;
    });
    try {
      internalServer = requireInternalServer(partialApp);
      await partialApp.listen();
    } catch (error) {
      listenError = error;
    }
    try {
      expect(listenError).toBeDefined();
      expect(listenErrorCode(listenError)).toBe('EADDRINUSE');
      expect({
        publicListening: partialApp.server.listening,
        internalListening: internalServer?.listening ?? false,
      }).toEqual({ publicListening: false, internalListening: false });
      if (attemptedPublicPort !== undefined) await expectPortClosed(attemptedPublicPort);
    } finally {
      await partialApp.close({ timeoutMs: 10, pollIntervalMs: 1 }).catch(() => undefined);
      await new Promise<void>((resolve, reject) => {
        occupied.close((error) => (error ? reject(error) : resolve()));
      });
    }
  });

  test('IF-06 failure cleanup: a failed shell remount closes both JSON listeners and preserves EADDRINUSE', async () => {
    const shellPort = await unusedLoopbackPort();
    const shellApp = await createLiveApp({
      adminShellPort: shellPort,
      mountAdminShell: true,
      autoMigrate: false,
      autoDispatch: false,
    });
    let internalServer: HttpServer | undefined;
    let occupiedShellPort: TcpServer | undefined;
    let publicPortAfterFailure: number | undefined;
    let internalPortAfterFailure: number | undefined;
    let listenError: unknown;
    try {
      internalServer = requireInternalServer(shellApp);
      const shellHandle = shellApp.adminShell?.handle as { close(): Promise<void> } | undefined;
      if (!shellHandle) throw new Error('PM-M02 IF-06 setup failed: Admin shell did not mount.');
      await shellHandle.close();

      occupiedShellPort = createTcpServer();
      await listenTcp(occupiedShellPort, shellPort);
      shellApp.server.once('listening', () => {
        publicPortAfterFailure = addressOf(shellApp.server).port;
      });
      internalServer.once('listening', () => {
        internalPortAfterFailure = addressOf(internalServer!).port;
      });
      await shellApp.listen();
    } catch (error) {
      listenError = error;
    }
    try {
      expect(listenError).toBeDefined();
      expect(listenErrorCode(listenError)).toBe('EADDRINUSE');
      expect({
        publicListening: shellApp.server.listening,
        internalListening: internalServer?.listening ?? false,
      }).toEqual({ publicListening: false, internalListening: false });
      expect(occupiedShellPort?.listening).toBe(true);
      if (publicPortAfterFailure !== undefined) await expectPortClosed(publicPortAfterFailure);
      if (internalPortAfterFailure !== undefined) await expectPortClosed(internalPortAfterFailure);
    } finally {
      await shellApp.close({ timeoutMs: 10, pollIntervalMs: 1 }).catch(() => undefined);
      if (occupiedShellPort?.listening) {
        await new Promise<void>((resolve, reject) => {
          occupiedShellPort.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });
});
