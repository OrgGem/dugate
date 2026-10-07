import { randomUUID } from 'node:crypto';
import http from 'node:http';
import { createApp, type App } from '../src/server';

/**
 * FIX-CR-11 regression: bounded ingress + caught request-stream errors.
 *
 * Real HTTP against createApp (boots the real listener with real PG/Redis —
 * this suite runs in the platform DB window). Caps are deliberately tiny
 * (256 B JSON / 128 B blob) so the 413 paths trigger without allocating
 * production-scale buffers.
 *
 * Acceptance (CODE-REVIEW-2026-09-23 §CR-11):
 *  1. unauthenticated oversize → 413 PAYLOAD_TOO_LARGE (ingress runs before
 *     route auth, so no auth header is needed and no unbounded buffer forms);
 *  2. chunked (no Content-Length) oversize → 413 PAYLOAD_TOO_LARGE;
 *  3. aborted mid-body stream → controlled outcome, NO unhandled rejection in
 *     the async listener, server answers the next request normally;
 *  4. binary blob PUT bytes arrive raw — invalid-UTF-8 and JSON-looking bytes
 *     are stored byte-equal, never utf8-decoded or JSON-parsed;
 *  5. oversize blob PUT → 413 and previously stored bytes are untouched;
 *  6. server stays responsive afterwards (GET /health → 200).
 *
 * The blob GET wire encoding is NOT asserted here — that is FIX-CR-13 scope.
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const RUNTIME_TOKEN = 'cr11-runtime-' + randomUUID();
const ADMIN_TOKEN = 'cr11-admin-' + randomUUID();
const TENANT_ID = randomUUID();
const MAX_JSON = 256;
const MAX_BLOB = 128;
const BLOB_KEY = `cr11-${randomUUID()}`;
const BLOB_TOKEN = `cr11-grant-${randomUUID()}`;

function assertTestDatabase(): void {
  const dbName = new URL(DATABASE_URL).pathname.split('/').pop() ?? '.';
  if (!/test/i.test(dbName)) {
    throw new Error(`refusing test cleanup: DATABASE_URL database "${dbName}" is not a test database`);
  }
}

interface RawResult {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  text: string;
}

let app: App;
let baseUrl: string;
let port: number;

function rawRequest(opts: {
  method: string;
  path: string;
  headers?: Record<string, string>;
  chunks?: Buffer[];
  end?: boolean;
}): Promise<RawResult> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port,
        path: opts.path,
        method: opts.method,
        headers: opts.headers ?? {},
      },
      (res) => {
        const bufs: Buffer[] = [];
        res.on('data', (c: Buffer) => bufs.push(c));
        res.on('end', () =>
          resolve({ status: res.statusCode ?? 0, headers: res.headers, text: Buffer.concat(bufs).toString('utf8') })
        );
      }
    );
    req.on('error', reject);
    for (const c of opts.chunks ?? []) req.write(c);
    if (opts.end !== false) req.end();
    // If end === false the caller owns the socket (abort test).
  });
}

function problemBody(res: RawResult): Record<string, unknown> {
  return res.text ? (JSON.parse(res.text) as Record<string, unknown>) : {};
}

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('ingress-bounded.test.ts: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    runtimeToken: RUNTIME_TOKEN,
    adminToken: ADMIN_TOKEN,
    autoDispatch: false,
    autoMigrate: true,
    maxJsonBytes: MAX_JSON,
    maxBlobBytes: MAX_BLOB,
  });
  await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1,'cr11-suite') ON CONFLICT (id) DO NOTHING`, [
    TENANT_ID,
  ]);
  await app.db.query(
    `INSERT INTO artifacts (tenant_id, mime_type, token, token_mode, token_expires_at, storage_key)
     VALUES ($1,'application/octet-stream',$2,'upload', now() + interval '15 minutes',$3)
     ON CONFLICT DO NOTHING`,
    [TENANT_ID, BLOB_TOKEN, BLOB_KEY]
  );
  // artifacts has no unique constraint on storage_key visible here; guard
  // against a stale row from an interrupted run.
  await app.db.query(`DELETE FROM artifact_blobs WHERE storage_key=$1`, [BLOB_KEY]);
  const server = await app.listen();
  port = (server.address() as { port: number }).port;
  baseUrl = `http://127.0.0.1:${port}`;
}, 120_000);

afterAll(async () => {
  await app.db
    .query(`DELETE FROM artifact_blobs WHERE storage_key=$1`, [BLOB_KEY])
    .catch(() => undefined);
  await app.db.query(`DELETE FROM artifacts WHERE storage_key=$1`, [BLOB_KEY]).catch(() => undefined);
  await app.db.query(`DELETE FROM tenants WHERE id=$1`, [TENANT_ID]).catch(() => undefined);
  // W42-C5-D(2): opt out of the 30s production grace drain (see
  // blob-wire-binary.test.ts) — drain() counts RUNNING rows server-wide, so
  // another lane's in-flight row would hold close() past the hook timeout.
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
}, 30_000);

describe('FIX-CR-11: bounded ingress (real HTTP)', () => {
  test('unauthenticated oversize JSON body fails closed with 413 before route auth', async () => {
    const big = JSON.stringify({ pad: 'x'.repeat(MAX_JSON * 4) });
    expect(big.length).toBeGreaterThan(MAX_JSON);
    // No Authorization header: ingress must reject before the route's 401.
    const res = await rawRequest({
      method: 'POST',
      path: '/api/runtime/v1/usage-events',
      headers: { 'content-type': 'application/json', 'content-length': String(Buffer.byteLength(big)) },
      chunks: [Buffer.from(big)],
    });
    expect(res.status).toBe(413);
    expect(String(res.headers['content-type'])).toContain('application/problem+json');
    expect(problemBody(res)).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  test('chunked oversize body (no Content-Length) fails closed with 413', async () => {
    const res = await rawRequest({
      method: 'POST',
      path: '/api/runtime/v1/usage-events',
      headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
      chunks: [Buffer.from('{"pad":"' + 'a'.repeat(200) + '"'), Buffer.from(',"more":"' + 'b'.repeat(200) + '"}')],
    });
    expect(res.status).toBe(413);
    expect(problemBody(res)).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
  });

  test('in-cap JSON still reaches the route (wrong bearer → 401, not 413/400)', async () => {
    const small = JSON.stringify({ events: [] });
    expect(small.length).toBeLessThan(MAX_JSON);
    const res = await rawRequest({
      method: 'POST',
      path: '/api/runtime/v1/usage-events',
      headers: {
        'content-type': 'application/json',
        'content-length': String(Buffer.byteLength(small)),
        authorization: 'Bearer wrong-token',
      },
      chunks: [Buffer.from(small)],
    });
    // 403 = reached route auth with a bad token (usage route: 403 on mismatch).
    // Either 401 or 403 proves the body parsed and routing proceeded.
    expect([401, 403]).toContain(res.status);
  });

  test('aborted mid-body stream: no unhandled rejection, server answers next request', async () => {
    const rejections: unknown[] = [];
    const onRej = (e: unknown): void => {
      rejections.push(e);
    };
    process.on('unhandledRejection', onRej);
    try {
      await new Promise<void>((resolve) => {
        const req = http.request(
          {
            host: '127.0.0.1',
            port,
            path: '/api/runtime/v1/usage-events',
            method: 'POST',
            headers: { 'content-type': 'application/json', 'transfer-encoding': 'chunked' },
          },
          (res) => {
            res.resume();
            res.on('end', () => resolve());
          }
        );
        req.on('error', () => resolve()); // ECONNRESET after destroy is expected
        req.write('{"partial":"');
        setTimeout(() => {
          req.destroy();
          // Resolve even if neither callback fires (server must not hang us).
          setTimeout(() => resolve(), 500);
        }, 50);
      });
      // Let any listener-thrown rejection surface.
      await new Promise((r) => setTimeout(r, 300));
      expect(rejections).toEqual([]);
    } finally {
      process.off('unhandledRejection', onRej);
    }
    // Server responsive afterwards: full-stack health check.
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
  });

  test('binary blob PUT stores invalid-UTF-8 bytes raw (never decoded/parsed)', async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47, 0x80, 0x81, 0x82]);
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${BLOB_KEY}?grant=${BLOB_TOKEN}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: raw,
    });
    expect(res.status).toBe(204);
    const stored = await app.db.query<{ bytes: Buffer }>(`SELECT bytes FROM artifact_blobs WHERE storage_key=$1`, [
      BLOB_KEY,
    ]);
    expect(stored.rowCount).toBe(1);
    expect(Buffer.from(stored.rows[0]!.bytes).equals(raw)).toBe(true);
  });

  test('binary blob PUT stores JSON-looking bytes raw (never JSON-parsed)', async () => {
    const raw = Buffer.from('{"staged":true,"n":42}');
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${BLOB_KEY}?grant=${BLOB_TOKEN}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: raw,
    });
    expect(res.status).toBe(204);
    const stored = await app.db.query<{ bytes: Buffer }>(`SELECT bytes FROM artifact_blobs WHERE storage_key=$1`, [
      BLOB_KEY,
    ]);
    expect(Buffer.from(stored.rows[0]!.bytes).equals(raw)).toBe(true);
  });

  test('oversize blob PUT fails closed with 413 and leaves stored bytes untouched', async () => {
    const before = await app.db.query<{ bytes: Buffer }>(`SELECT bytes FROM artifact_blobs WHERE storage_key=$1`, [
      BLOB_KEY,
    ]);
    expect(before.rowCount).toBe(1);
    const big = Buffer.alloc(MAX_BLOB * 4, 0x41);
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${BLOB_KEY}?grant=${BLOB_TOKEN}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: big,
    });
    expect(res.status).toBe(413);
    const text = await res.text();
    expect(JSON.parse(text) as Record<string, unknown>).toMatchObject({ status: 413, code: 'PAYLOAD_TOO_LARGE' });
    const after = await app.db.query<{ bytes: Buffer }>(`SELECT bytes FROM artifact_blobs WHERE storage_key=$1`, [
      BLOB_KEY,
    ]);
    expect(Buffer.from(after.rows[0]!.bytes).equals(Buffer.from(before.rows[0]!.bytes))).toBe(true);
  });

  test('server responsive after all abuse: GET /health → 200', async () => {
    const health = await fetch(`${baseUrl}/health`);
    expect(health.status).toBe(200);
    const body = (await health.json()) as Record<string, unknown>;
    expect(body).toMatchObject({ status: 'ok' });
  });
});
});
