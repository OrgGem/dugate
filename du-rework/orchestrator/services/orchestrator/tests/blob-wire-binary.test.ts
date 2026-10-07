import { createHash, randomUUID } from 'node:crypto';
import { createApp, type App } from '../src/server';

/**
 * FIX-CR-13 regression: binary artifact wire contract over real HTTP.
 *
 * The blob GET route must serve stored bytes byte-for-byte as
 * `application/octet-stream` — never base64-encoded, never JSON.stringified
 * (the old fault returned `bytes.toString('base64')` through the common
 * JSON responder, so a quoted base64 string reached SDK consumers that read
 * arrayBuffer()/stream-to-disk raw).
 *
 * Acceptance (CODE-REVIEW-2026-09-23 §CR-13):
 *  1. PUT binary bytes (incl. invalid-UTF-8) → GET returns byte-equal raw;
 *  2. JSON-looking bytes round-trip as native bytes (JSON.parse of the raw
 *     body yields the object, not a string);
 *  3. sha256 of the GET body equals sha256 of the PUT bytes (SDK hash check);
 *  4. content-length matches the stored byte length; content-type stays
 *     application/octet-stream;
 *  5. wire body is not quoted/base64 (first byte is raw, not `"`).
 */
const DATABASE_URL =
  process.env.DATABASE_URL ?? 'postgresql://du:du-test-only@localhost:5433/du_orchestrator_test';
const REDIS_URL = process.env.REDIS_URL ?? 'redis://localhost:6380';
const RUNTIME_TOKEN = 'cr13-runtime-' + randomUUID();
const ADMIN_TOKEN = 'cr13-admin-' + randomUUID();
const TENANT_ID = randomUUID();
const STORAGE_KEY = `cr13-${randomUUID()}`;
const GRANT_TOKEN = `cr13-grant-${randomUUID()}`;

function assertTestDatabase(): void {
  const dbName = new URL(DATABASE_URL).pathname.split('/').pop() ?? '.';
  if (!/test/i.test(dbName)) {
    throw new Error(`refusing test: DATABASE_URL database "${dbName}" is not a test database`);
  }
}

let app: App;
let baseUrl: string;

// WINDOW GUARD (cycle 104, fleet standard after admin-error-boundary §52): this
// suite boots the REAL app (PG :5433 / Redis :6380). Without DU_LIVE_INFRA=1
// everything below is skipped — no createApp, no listen, no connection.
const LIVE = process.env.DU_LIVE_INFRA === '1';
const liveDescribe = LIVE ? describe : describe.skip;
if (!LIVE) {
  console.warn('blob-wire-binary: SKIPPED - set DU_LIVE_INFRA=1 inside an open DB window to run.');
}

liveDescribe('WINDOW-GATED live suite (DU_LIVE_INFRA=1)', () => {
beforeAll(async () => {
  assertTestDatabase();
  app = await createApp({
    port: 0,
    databaseUrl: DATABASE_URL,
    redisUrl: REDIS_URL,
    runtimeToken: RUNTIME_TOKEN,
    adminToken: ADMIN_TOKEN,
    autoDispatch: false,
    autoMigrate: true,
  });
  await app.db.query(`INSERT INTO tenants (id, name) VALUES ($1,'cr13-suite') ON CONFLICT (id) DO NOTHING`, [
    TENANT_ID,
  ]);
  await app.db.query(
    `INSERT INTO artifacts (tenant_id, mime_type, token, token_mode, token_expires_at, storage_key)
     VALUES ($1,'application/octet-stream',$2,'upload', now() + interval '15 minutes',$3)
     ON CONFLICT DO NOTHING`,
    [TENANT_ID, GRANT_TOKEN, STORAGE_KEY]
  );
  await app.db.query(`DELETE FROM artifact_blobs WHERE storage_key=$1`, [STORAGE_KEY]);
  const server = await app.listen();
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}, 120_000);

afterAll(async () => {
  await app.db.query(`DELETE FROM artifact_blobs WHERE storage_key=$1`, [STORAGE_KEY]).catch(() => undefined);
  await app.db.query(`DELETE FROM artifacts WHERE storage_key=$1`, [STORAGE_KEY]).catch(() => undefined);
  await app.db.query(`DELETE FROM tenants WHERE id=$1`, [TENANT_ID]).catch(() => undefined);
  // W42-C5-D(2): skip the 30s production grace drain in tests. drain() counts
  // RUNNING rows server-wide (runtime.ts:30-35), so another lane's in-flight
  // row would hold close() past jest's 30s hook timeout. Production default
  // (30s) is untouched — this only opts the test teardown out of the wait.
  await app?.close({ timeoutMs: 0, pollIntervalMs: 10 });
}, 30_000);

async function putBlob(bytes: Buffer, token: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${STORAGE_KEY}?grant=${token}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/octet-stream' },
    body: bytes,
  });
  expect(res.status).toBe(204);
}

// CR-12: a grant is method-scoped (upload XOR download). Tests that exercise
// both phases rotate the stored token between them — mirroring production,
// where requestUpload/requestAccess mint a fresh token per grant.
async function rotateGrant(mode: 'upload' | 'download'): Promise<string> {
  const token = `cr13-${mode}-${randomUUID()}`;
  await app.db.query(
    `UPDATE artifacts SET token=$2, token_mode=$3, token_expires_at = now() + interval '15 minutes'
     WHERE storage_key=$1`,
    [STORAGE_KEY, token, mode]
  );
  return token;
}

describe('FIX-CR-13: binary artifact wire (real HTTP)', () => {
  test('invalid-UTF-8 bytes round-trip byte-equal with octet-stream content-type', async () => {
    const raw = Buffer.from([0xff, 0xfe, 0x00, 0x89, 0x50, 0x4e, 0x47, 0x80, 0x81, 0x82]);
    await putBlob(raw, await rotateGrant('upload'));
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${STORAGE_KEY}?grant=${await rotateGrant('download')}`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/octet-stream');
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(raw)).toBe(true);
  });

  test('JSON-looking bytes arrive native: JSON.parse yields the object, not a string', async () => {
    const raw = Buffer.from(JSON.stringify({ output: { ok: true } }));
    await putBlob(raw, await rotateGrant('upload'));
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${STORAGE_KEY}?grant=${await rotateGrant('download')}`);
    expect(res.status).toBe(200);
    const got = Buffer.from(await res.arrayBuffer());
    expect(got.equals(raw)).toBe(true);
    const parsed: unknown = JSON.parse(got.toString('utf8'));
    expect(parsed).toEqual({ output: { ok: true } });
  });

  test('sha256 of GET body equals sha256 of PUT bytes; content-length matches', async () => {
    const raw = Buffer.from('cr13-hash-fixture-' + randomUUID());
    const want = createHash('sha256').update(raw).digest('hex');
    await putBlob(raw, await rotateGrant('upload'));
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${STORAGE_KEY}?grant=${await rotateGrant('download')}`);
    expect(res.status).toBe(200);
    expect(Number(res.headers.get('content-length'))).toBe(raw.length);
    const got = Buffer.from(await res.arrayBuffer());
    expect(createHash('sha256').update(got).digest('hex')).toBe(want);
    expect(got.length).toBe(raw.length);
  });

  test('wire body is raw, not quoted base64: first byte is payload, not a quote', async () => {
    const raw = Buffer.from([0x01, 0x02, 0x03, 0x04]);
    await putBlob(raw, await rotateGrant('upload'));
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${STORAGE_KEY}?grant=${await rotateGrant('download')}`);
    const got = Buffer.from(await res.arrayBuffer());
    expect(got[0]).toBe(0x01);
    expect(got.toString('utf8').startsWith('"')).toBe(false);
  });

  // CR-12 negative: an upload-scoped token cannot GET (method fence).
  test('upload-scoped grant cannot GET: method mismatch is fenced with 403', async () => {
    const raw = Buffer.from([0x09, 0x08, 0x07]);
    const uploadToken = await rotateGrant('upload');
    await putBlob(raw, uploadToken);
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${STORAGE_KEY}?grant=${uploadToken}`);
    expect(res.status).toBe(403);
  });

  // CR-12 negative: a download-scoped token cannot PUT (method fence).
  test('download-scoped grant cannot PUT: method mismatch is fenced with 403', async () => {
    const downloadToken = await rotateGrant('download');
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${STORAGE_KEY}?grant=${downloadToken}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/octet-stream' },
      body: Buffer.from([0x01]),
    });
    expect(res.status).toBe(403);
  });

  // CR-12 negative: an expired token 404s (indistinguishable from missing).
  test('expired grant 404s instead of serving bytes', async () => {
    const raw = Buffer.from([0x0a, 0x0b]);
    await putBlob(raw, await rotateGrant('upload'));
    const stale = `cr13-stale-${randomUUID()}`;
    await app.db.query(
      `UPDATE artifacts SET token=$2, token_mode='download', token_expires_at = now() - interval '1 minute'
       WHERE storage_key=$1`,
      [STORAGE_KEY, stale]
    );
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${STORAGE_KEY}?grant=${stale}`);
    expect(res.status).toBe(404);
  });

  test('wrong grant is fenced with 403', async () => {
    const res = await fetch(`${baseUrl}/api/runtime/v1/artifacts/blob/${STORAGE_KEY}?grant=wrong-token`);
    expect(res.status).toBe(403);
  });
});
});
