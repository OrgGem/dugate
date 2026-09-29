/**
 * Delta 67: prove the CR28-01 fix at the ROUTE level, over the real `route()`
 * dispatch, with a genuinely sealed object behind it.
 *
 * The cycle-28 tests called `decryptStoredArtifact` directly. That proved the
 * module, not the wiring: it could not have caught a route that simply forgot
 * to call it, or one that decrypted and then still streamed the stored bytes.
 * These tests drive the two read paths end to end and assert on the BYTES the
 * caller would actually receive.
 *
 * What is real here: the `route()` dispatcher, the artifact + api-key SQL
 * shapes, the grant check, the `CryptoStorageFacade` AAD rebuild, and a sealed
 * object produced by the same context the upload gateway uses. What is faked:
 * only the `StoredObjectReader` (so no S3) and the `db` (so no Postgres).
 *
 * The load-bearing assertion in every case is that the response is the
 * PLAINTEXT and not the stored ciphertext. That is the CR28-01 bug: before the
 * fix both routes returned the stored bytes, so a sealed download looked like
 * a successful read and handed the caller garbage.
 */
import { createHash, createHmac } from 'node:crypto';
import { Readable } from 'node:stream';
import { route, type RouteContext } from '../src/server';
import { isHttpError } from '../src/http/errors';
import { CryptoStorageFacade } from '../src/modules/encryption/crypto-storage-facade';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import {
  ENCRYPTED_OBJECT_MARKER,
  ENCRYPTED_OBJECT_MARKER_VALUE,
  MANIFEST_KEY_METADATA,
  PUBLIC_UPLOAD_PURPOSE,
  manifestKeyFor,
  type ArtifactDecryptDeps,
  type StoredObjectReader,
} from '../src/modules/encryption/artifact-read-decrypt';

const KEY_REF = 'du-route-v1';
const TENANT = 'tenant-route-a';
const ARTIFACT = 'cccccccc-dddd-4eee-8fff-000000000001';
const UPLOAD_TOKEN = '33333333-4444-4555-8666-777777777777';
const STORAGE_KEY = 'tenant-route-a-ingest-20260928-route.pdf';
const SECRET = 'CONFIDENTIAL-ROUTE-BODY-5e2c74';
const API_KEY = 'du_sk_route_test_key';
const HASH = String.fromCharCode(35);
const GRANT = 'grant-token-for-the-read-test';

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'route-double').update(seed + String.fromCharCode(58) + block).digest();
    digest.copy(out, offset, 0, Math.min(32, length - offset));
    block += 1;
  }
  return out;
}

function xor(data: Buffer, stream: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  for (let i = 0; i < data.length; i += 1) out[i] = (data[i] ?? 0) ^ (stream[i] ?? 0);
  return out;
}

function makeKeyProvider(opts: { wrongKey?: boolean } = {}): KeyProvider {
  return {
    async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
      const version = input.keyVersion ?? 1;
      return {
        keyRef: input.keyRef,
        keyVersion: version,
        ciphertext: xor(
          Buffer.from(input.dek),
          keystream(input.keyRef + HASH + version, input.dek.length),
        ).toString('base64'),
      };
    },
    async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
      const raw = Buffer.from(wrapped.ciphertext, 'base64');
      if (opts.wrongKey) return Buffer.alloc(32, 0xee);
      return xor(raw, keystream(wrapped.keyRef + HASH + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
      return wrapped;
    },
  };
}

interface Sealed {
  readonly ciphertext: Buffer;
  readonly manifest: Record<string, unknown>;
  readonly reader: StoredObjectReader;
}

async function sealForRoute(provider: KeyProvider, opts: { sealed: boolean }): Promise<Sealed> {
  const facade = new CryptoStorageFacade(provider);
  const encrypted = await facade.encrypt(Buffer.from(SECRET, 'utf8'), {
    tenantId: TENANT,
    artifactId: ARTIFACT,
    objectVersion: UPLOAD_TOKEN,
    purpose: PUBLIC_UPLOAD_PURPOSE,
    keyRef: KEY_REF,
  });
  const ciphertext = Buffer.from(encrypted.ciphertext);
  const manifest: Record<string, unknown> = {
    version: encrypted.version,
    algorithm: encrypted.algorithm,
    nonce: encrypted.nonce,
    tag: encrypted.tag,
    aad: encrypted.aad,
    plaintextSizeBytes: encrypted.plaintextSizeBytes,
    plaintextSha256: encrypted.plaintextSha256,
    dek: encrypted.dek,
  };
  const metadata: Record<string, string> = { artifactid: ARTIFACT, tenantid: TENANT };
  if (opts.sealed) {
    metadata[ENCRYPTED_OBJECT_MARKER] = ENCRYPTED_OBJECT_MARKER_VALUE;
    metadata[MANIFEST_KEY_METADATA] = manifestKeyFor(STORAGE_KEY);
  }
  // Whatever the object store actually holds. In production BOTH the seam's
  // reader and ctx.artifacts.getBlob read the same S3 object, so they must
  // return the same bytes here; a harness that let them disagree would be
  // testing a wiring that cannot exist.
  const stored = opts.sealed ? ciphertext : Buffer.from(SECRET, 'utf8');
  return {
    ciphertext,
    manifest,
    reader: {
      head: async () => metadata,
      read: async () => stored,
      readManifest: async () => manifest,
    },
  };
}

interface Harness {
  readonly ctx: RouteContext;
  readonly ciphertext: Buffer;
}

function harness(o: { provider: KeyProvider; sealed: Sealed; getBlob: 'ciphertext' | 'plaintext' }): Harness {
  const apiKeyHash = createHash('sha256').update(API_KEY).digest('hex');
  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (/FROM api_keys/.test(sql)) {
        if (params[0] === apiKeyHash && params[1] === 'ACTIVE') {
          return { rows: [{ id: 'key-1', tenant_id: TENANT }], rowCount: 1 };
        }
        return { rows: [], rowCount: 0 };
      }
      // Branch ORDER matters. resolveArtifactByStorageKey's SQL also contains
      // a.storage_key, so its branch must be tested FIRST; returning the
      // download-shaped row (which has no token column) made the blob route's
      // grant check fail 403 and looked like a routing bug.
      if (/a\.token,/.test(sql)) {
        return {
          rows: [{
            id: ARTIFACT, upload_token: UPLOAD_TOKEN, token: GRANT,
            tenant_id: TENANT, token_mode: 'download',
            token_expires_at: '2999-01-01T00:00:00.000Z', business_id: null,
          }],
          rowCount: 1,
        };
      }
      if (/a\.storage_key/.test(sql)) {
        return {
          rows: [{
            state: 'READY', mime_type: 'application/pdf', tenant_id: TENANT,
            storage_key: STORAGE_KEY, upload_token: UPLOAD_TOKEN,
          }],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    },
  };
  // getBlob returns a STREAM in production (that is what the route puts in
  // `raw`). Returning a Buffer here made the unsealed fallback path produce a
  // non-stream body and the test failed in `collect` rather than on an
  // assertion about the bytes.
  const artifacts = {
    getBlob: async () =>
      Readable.from([
        o.getBlob === 'ciphertext' ? o.sealed.ciphertext : Buffer.from(SECRET, 'utf8'),
      ]),
  };
  const decryptDeps: ArtifactDecryptDeps = {
    reader: o.sealed.reader,
    facade: new CryptoStorageFacade(o.provider),
  };
  const ctx = {
    method: 'GET',
    pathname: '',
    searchParams: new URLSearchParams(''),
    headers: { 'x-api-key': API_KEY, authorization: 'Bearer runtime-token' },
    body: undefined,
    rawBody: Buffer.alloc(0),
    correlationId: 'cr28-01-route',
    host: 'localhost',
    db,
    config: {},
    artifacts,
    artifactDecryptDeps: decryptDeps,
    deliveryEncryption: null,
  } as unknown as RouteContext;
  return { ctx, ciphertext: o.sealed.ciphertext };
}

async function collect(raw: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of raw as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

type Read = { status: number; bytes: Buffer } | { status: number; code: string };

async function read(h: Harness, pathname: string): Promise<Read> {
  const ctx = h.ctx as unknown as { pathname: string; searchParams: URLSearchParams };
  ctx.pathname = pathname;
  ctx.searchParams = new URLSearchParams(pathname.includes('/blob/') ? 'grant=' + GRANT : '');
  try {
    const res = await route(h.ctx);
    return { status: res.status, bytes: await collect(res.raw) };
  } catch (err) {
    if (!isHttpError(err)) throw err;
    return { status: err.status, code: err.code };
  }
}

const DOWNLOAD = '/api/v1/artifacts/' + ARTIFACT + '/download';
const BLOB = '/api/runtime/v1/artifacts/blob/' + encodeURIComponent(STORAGE_KEY);

describe('CR28-01 over HTTP: a sealed artifact downloads as PLAINTEXT', () => {
  it('GET /api/v1/artifacts/:id/download returns the document, not the ciphertext', async () => {
    const provider = makeKeyProvider();
    const sealed = await sealForRoute(provider, { sealed: true });
    const h = harness({ provider, sealed, getBlob: 'ciphertext' });
    const out = await read(h, DOWNLOAD);
    expect('bytes' in out).toBe(true);
    if (!('bytes' in out)) return;
    expect(out.status).toBe(200);
    expect(out.bytes.toString('utf8')).toBe(SECRET);
    expect(out.bytes.equals(h.ciphertext)).toBe(false);
  });

  it('the worker blob GET returns the document, not the ciphertext', async () => {
    const provider = makeKeyProvider();
    const sealed = await sealForRoute(provider, { sealed: true });
    const h = harness({ provider, sealed, getBlob: 'ciphertext' });
    const out = await read(h, BLOB);
    expect('bytes' in out).toBe(true);
    if (!('bytes' in out)) return;
    expect(out.status).toBe(200);
    expect(out.bytes.toString('utf8')).toBe(SECRET);
    expect(out.bytes.equals(h.ciphertext)).toBe(false);
  });
});

describe('CR28-01 over HTTP: a broken seal fails closed, it never serves ciphertext', () => {
  it('the public download refuses with 503 when the key is wrong', async () => {
    const sealed = await sealForRoute(makeKeyProvider(), { sealed: true });
    const h = harness({ provider: makeKeyProvider({ wrongKey: true }), sealed, getBlob: 'ciphertext' });
    const out = await read(h, DOWNLOAD);
    expect('code' in out).toBe(true);
    if (!('code' in out)) return;
    expect(out.status).toBe(503);
    expect(out.code).toBe('STORAGE_FAILURE');
  });

  it('the worker blob GET refuses with 503 when the key is wrong', async () => {
    const sealed = await sealForRoute(makeKeyProvider(), { sealed: true });
    const h = harness({ provider: makeKeyProvider({ wrongKey: true }), sealed, getBlob: 'ciphertext' });
    const out = await read(h, BLOB);
    expect('code' in out).toBe(true);
    if (!('code' in out)) return;
    expect(out.status).toBe(503);
    expect(out.code).toBe('STORAGE_FAILURE');
  });
});

describe('CR28-01 over HTTP: an unsealed artifact still downloads unchanged', () => {
  it('the public download passes plaintext bytes straight through', async () => {
    const provider = makeKeyProvider();
    // No marker: the object is plaintext and the seam must leave it alone.
    const sealed = await sealForRoute(provider, { sealed: false });
    const h = harness({ provider, sealed, getBlob: 'plaintext' });
    const out = await read(h, DOWNLOAD);
    expect('bytes' in out).toBe(true);
    if (!('bytes' in out)) return;
    expect(out.status).toBe(200);
    expect(out.bytes.toString('utf8')).toBe(SECRET);
  });

  it('the worker blob GET passes plaintext bytes straight through', async () => {
    const provider = makeKeyProvider();
    const sealed = await sealForRoute(provider, { sealed: false });
    const h = harness({ provider, sealed, getBlob: 'plaintext' });
    const out = await read(h, BLOB);
    expect('bytes' in out).toBe(true);
    if (!('bytes' in out)) return;
    expect(out.status).toBe(200);
    expect(out.bytes.toString('utf8')).toBe(SECRET);
  });
});
