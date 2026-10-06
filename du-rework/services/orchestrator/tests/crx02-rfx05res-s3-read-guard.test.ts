/**
 * CRX-02 + RFX-05-residual — headed proof through the REAL app.
 *
 * Two defects meet in `createApp`'s S3 read wiring, and neither is provable
 * with a fake `StoredObjectReader` that merely records arguments:
 *
 *  1. CRX-02: `artifactDecryptDeps` was built without `encryptionRequired`, so
 *     an object whose sealed marker was removed read as plaintext through the
 *     runtime blob GET and the public download route. The policy must come from
 *     the S3 production config — required by default, relaxed only while the
 *     operator-signed migration window is open.
 *  2. RFX-05-residual: the concrete `s3StoredObjectReader.readManifest` ignored
 *     the committed sidecar generation, and neither decrypt call site passed
 *     `manifest_version_id`. A newer manifest written at the same key could be
 *     verified against instead of the committed one.
 *
 * So this suite boots the REAL `createApp` (scripted `pg`, real routes, real
 * HTTP listener, REAL AWS SDK client) pointed at a loopback S3 stub that
 * serves object metadata and versioned bodies. Every assertion goes through
 * `fetch()`: runtime GET and public download are exercised end to end, and the
 * stub's request log proves the manifest GET actually carried the pinned
 * VersionId on the wire.
 *
 * Offline: loopback sockets only (orchestrator + S3 stub), no PostgreSQL, no
 * live S3, no Vault.
 */
import http from 'node:http';
import { createHmac, createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { createApp, type App } from '../src/server';
import { CryptoStorageFacade } from '../src/modules/encryption/crypto-storage-facade';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import {
  ENCRYPTED_OBJECT_MARKER,
  ENCRYPTED_OBJECT_MARKER_VALUE,
  MANIFEST_KEY_METADATA,
  PUBLIC_UPLOAD_PURPOSE,
  manifestKeyFor,
} from '../src/modules/encryption/artifact-read-decrypt';
import { loadMigrationFiles } from '../src/db/migrations';

const BUCKET = 'du-crx02-bucket';
const KEY_REF = 'crx02-read-key-v1';
const TENANT = 'crx02-tenant';
const ARTIFACT = 'a1b2c3d4-0000-4000-8000-00000000a001';
const ARTIFACT_UNPINNED = 'a1b2c3d4-0000-4000-8000-00000000a002';
const ARTIFACT_BAD_MANIFEST = 'a1b2c3d4-0000-4000-8000-00000000a003';
const STORAGE_KEY = 'crx02-artifact-object';
const STORAGE_KEY_UNPINNED = 'crx02-artifact-unpinned';
const STORAGE_KEY_BAD = 'crx02-artifact-bad-manifest';
const UPLOAD_TOKEN = '11111111-2222-4333-8444-c00000000001';
const OTHER_TOKEN = '99999999-2222-4333-8444-c00000000002';
const RUNTIME_TOKEN = 'crx02-runtime-token';
const RAW_API_KEY = 'du_crx02_public_key';
const API_KEY_HASH = createHash('sha256').update(RAW_API_KEY).digest('hex');
const SECRET = 'CRX-02-SECRET-BYTES-4d19';
const HASH = String.fromCharCode(35);

interface ArtifactRow {
  id: string;
  tenant_id: string;
  storage_key: string;
  upload_token: string | null;
  token: string;
  token_mode: string | null;
  token_expires_at: string | null;
  business_id: string | null;
  manifest_version_id: string | null;
  state: string;
  mime_type: string;
  storage_version_id: string | null;
  size_bytes: number | null;
  sha256: string | null;
}

interface ApiKeyRow {
  id: string;
  tenant_id: string;
  hash: string;
  status: string;
}

interface ScriptedState {
  schemaLedger: { sequence: number; filename: string }[];
  artifacts: ArtifactRow[];
  apiKeys: ApiKeyRow[];
}

jest.mock('pg', () => {
  const state = {
    schemaLedger: [] as { sequence: number; filename: string }[],
    artifacts: [] as ArtifactRow[],
    apiKeys: [] as ApiKeyRow[],
  };
  interface PgResult { rows: unknown[]; rowCount: number }
  function answer(sql: string, params: unknown[] = []): PgResult {
    const text = String(sql).replace(/\s+/g, ' ').trim();
    if (/information_schema\.tables/i.test(text)) return { rows: [{ exists: true }], rowCount: 1 };
    if (/SELECT count\(\*\)::int/i.test(text)) return { rows: [{ count: state.schemaLedger.length }], rowCount: 1 }
    if (/FROM schema_migrations/i.test(text)) {
      return { rows: state.schemaLedger, rowCount: state.schemaLedger.length };
    }
    if (text.includes('SELECT a.id, a.upload_token')) {
      const hit = state.artifacts.find((row) => row.storage_key === params[0]);
      return hit ? { rows: [hit], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    if (text.includes('SELECT a.state, a.mime_type')) {
      const hit = state.artifacts.find(
        (row) => row.id === params[0] && row.tenant_id === params[1],
      );
      return hit ? { rows: [hit], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // artifacts.getBlob (the migration-window passthrough on the runtime route).
    if (text.startsWith('SELECT id, tenant_id AS "tenantId"')) {
      const hit = state.artifacts.find((row) => row.storage_key === params[0]);
      return hit
        ? {
            rows: [{
              id: hit.id,
              tenantId: hit.tenant_id,
              state: hit.state,
              storageBackend: 's3',
              storageVersionId: hit.storage_version_id,
              sizeBytes: hit.size_bytes,
              sha256: hit.sha256,
            }],
            rowCount: 1,
          }
        : { rows: [], rowCount: 0 };
    }
    if (text.includes('FROM api_keys WHERE hash=')) {
      const hit = state.apiKeys.find((row) => row.hash === params[0] && row.status === params[1]);
      return hit ? { rows: [{ id: hit.id, tenant_id: hit.tenant_id }], rowCount: 1 } : { rows: [], rowCount: 0 };
    }
    // RFX-15: the blob GET consumes the download grant; one live row wins.
    if (text.startsWith('UPDATE artifacts SET token_expires_at')) {
      const hit = state.artifacts.find(
        (row) => row.id === params[0] && row.token === params[1] && row.token_mode === 'download'
          && row.token_expires_at !== null && new Date(row.token_expires_at).getTime() > Date.now(),
      );
      if (!hit) return { rows: [], rowCount: 0 };
      hit.token_expires_at = new Date(Date.now() - 1_000).toISOString();
      return { rows: [], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }
  class ScriptedPool {
    async query(sql: string, params: unknown[] = []): Promise<PgResult> {
      return answer(sql, params);
    }
    async connect(): Promise<{ query: (sql: string, params?: unknown[]) => Promise<PgResult>; release: () => void }> {
      return { query: (sql, params = []) => Promise.resolve(answer(sql, params)), release: () => undefined };
    }
    async end(): Promise<void> {
      return undefined;
    }
  }
  return { __esModule: true, Pool: ScriptedPool, __duState: state };
});

function scripted(): ScriptedState {
  return (jest.requireMock('pg') as { __duState: ScriptedState }).__duState;
}

/* ------------------------- loopback S3 stub ------------------------------- */

interface S3Version {
  versionId: string;
  body: Buffer;
  metadata: Record<string, string>;
  contentType: string;
}

interface S3Request {
  method: string;
  key: string;
  versionId: string | undefined;
}

function startS3Stub() {
  const versions = new Map<string, S3Version[]>();
  const requests: S3Request[] = [];
  let seq = 0;

  const server = http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const parts = url.pathname.replace(/^\/+/, '').split('/');
    parts.shift(); // bucket
    const key = decodeURIComponent(parts.join('/'));
    const versionId = url.searchParams.get('versionId') ?? undefined;
    const method = req.method ?? 'GET';
    requests.push({ method, key, versionId });

    const list = versions.get(key) ?? [];
    const hit = versionId ? list.find((v) => v.versionId === versionId) : list[list.length - 1];
    if (!hit) {
      res.writeHead(404, { 'content-type': 'application/xml' });
      res.end();
      return;
    }
    const headers: Record<string, string> = {
      'x-amz-version-id': hit.versionId,
      'content-length': String(hit.body.length),
    };
    if (method === 'HEAD') {
      for (const [k, v] of Object.entries(hit.metadata)) headers[`x-amz-meta-${k}`] = v;
      res.writeHead(200, headers);
      res.end();
      return;
    }
    headers['content-type'] = hit.contentType;
    res.writeHead(200, headers);
    res.end(hit.body);
  });

  const stub = {
    /** Base URL once `listen()` resolved; '' before. */
    url: '',
    requests,
    /** Store a body at `key`; an explicit versionId pins a generation. */
    put(key: string, input: { body: Buffer; metadata?: Record<string, string>; contentType?: string; versionId?: string }): string {
      seq += 1;
      const versionId = input.versionId ?? 'v' + seq;
      const list = versions.get(key) ?? [];
      list.push({
        versionId,
        body: input.body,
        metadata: input.metadata ?? {},
        contentType: input.contentType ?? 'application/octet-stream',
      });
      versions.set(key, list);
      return versionId;
    },
    async listen(): Promise<{ server: http.Server; url: string }> {
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      const { port } = server.address() as AddressInfo;
      stub.url = `http://127.0.0.1:${port}`;
      return { server, url: stub.url };
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
  return stub;
}

/* ------------------------- sealed fixture helpers ------------------------- */

function keystream(seed: string, length: number): Buffer {
  const out = Buffer.alloc(length);
  let block = 0;
  for (let offset = 0; offset < length; offset += 32) {
    const digest = createHmac('sha256', 'crx02-read-double').update(seed + ':' + block).digest();
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

function makeKeyProvider(): KeyProvider {
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
      return xor(raw, keystream(wrapped.keyRef + HASH + wrapped.keyVersion, raw.length));
    },
    async rewrap(wrapped: WrappedDek): Promise<WrappedDek> {
      return wrapped;
    },
  };
}

interface SealedFixture {
  ciphertext: Buffer;
  manifest: Record<string, unknown>;
  metadata: Record<string, string>;
}

/** Encrypt exactly the way the upload gateway does, so the AAD must match. */
async function sealObject(
  provider: KeyProvider,
  input: { artifactId: string; objectVersion: string; storageKey: string },
): Promise<SealedFixture> {
  const facade = new CryptoStorageFacade(provider);
  const sealed = await facade.encrypt(Buffer.from(SECRET, 'utf8'), {
    tenantId: TENANT,
    artifactId: input.artifactId,
    objectVersion: input.objectVersion,
    purpose: PUBLIC_UPLOAD_PURPOSE,
    keyRef: KEY_REF,
  });
  return {
    ciphertext: Buffer.from(sealed.ciphertext),
    manifest: {
      version: sealed.version,
      algorithm: sealed.algorithm,
      nonce: sealed.nonce,
      tag: sealed.tag,
      aad: sealed.aad,
      plaintextSizeBytes: sealed.plaintextSizeBytes,
      plaintextSha256: sealed.plaintextSha256,
      dek: sealed.dek,
    },
    metadata: {
      [ENCRYPTED_OBJECT_MARKER]: ENCRYPTED_OBJECT_MARKER_VALUE,
      artifactid: input.artifactId,
      tenantid: TENANT,
      [MANIFEST_KEY_METADATA]: manifestKeyFor(input.storageKey),
    },
  };
}

/* ------------------------- app boot / HTTP helpers ------------------------ */

let s3: ReturnType<typeof startS3Stub>;
const apps: App[] = [];
const savedEnv = {
  AWS_ACCESS_KEY_ID: process.env.AWS_ACCESS_KEY_ID,
  AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
  AWS_EC2_METADATA_DISABLED: process.env.AWS_EC2_METADATA_DISABLED,
};

async function boot(input: {
  provider: KeyProvider;
  migrationWindow?: boolean;
}): Promise<{ app: App; base: string; internalBase: string }> {
  const app = await createApp({
    port: 0,
    internalPort: 0,
    databaseUrl: 'postgresql://du:du@127.0.0.1:1/du_offline_crx02',
    redisUrl: 'redis://127.0.0.1:1',
    runtimeToken: RUNTIME_TOKEN,
    autoDispatch: false,
    autoMigrate: false,
    artifactStorage: {
      backend: 's3',
      bucket: BUCKET,
      region: 'us-east-1',
      endpoint: s3.url,
      forcePathStyle: true,
      ...(input.migrationWindow ? { migrationWindow: true } : {}),
    },
    publicUploadEncryption: { keyProvider: input.provider, keyRef: KEY_REF },
  });
  apps.push(app);
  const server = await app.listen();
  const { port } = server.address() as AddressInfo;
  // PM-M02-ROUTE: runtime/admin fixtures must target the INTERNAL listener.
  const internal = app.internalServer?.address() as AddressInfo | null;
  return {
    app,
    base: `http://127.0.0.1:${port}`,
    internalBase: internal ? `http://127.0.0.1:${internal.port}` : `http://127.0.0.1:${port}`,
  };
}

async function get(
  base: string,
  path: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; contentType: string | null; code: string | null }> {
  const res = await fetch(base + path, { headers, redirect: 'manual' });
  const body = await res.text();
  let code: string | null = null;
  try {
    code = (JSON.parse(body) as { code?: string }).code ?? null;
  } catch {
    code = null;
  }
  return { status: res.status, body, contentType: res.headers.get('content-type'), code };
}

function runtimePath(storageKey: string, token: string): string {
  return `/api/runtime/v1/artifacts/blob/${encodeURIComponent(storageKey)}?grant=${token}`;
}

function seedArtifact(overrides: Partial<ArtifactRow> & { id: string; storage_key: string }): void {
  scripted().artifacts.push({
    tenant_id: TENANT,
    upload_token: UPLOAD_TOKEN,
    token: 'token-' + overrides.id,
    token_mode: 'download',
    token_expires_at: new Date(Date.now() + 60_000).toISOString(),
    business_id: null,
    manifest_version_id: null,
    state: 'READY',
    mime_type: 'application/pdf',
    storage_version_id: null,
    size_bytes: Buffer.byteLength(SECRET, 'utf8'),
    sha256: createHash('sha256').update(Buffer.from(SECRET, 'utf8')).digest('hex'),
    ...overrides,
  });
}

describe('CRX-02 + RFX-05-residual: S3 read guard and manifest-version wiring through the real app', () => {
  beforeAll(async () => {
    process.env.AWS_ACCESS_KEY_ID = 'du-crx02-test-key';
    process.env.AWS_SECRET_ACCESS_KEY = 'du-crx02-test-secret';
    process.env.AWS_EC2_METADATA_DISABLED = 'true';
    scripted().schemaLedger = loadMigrationFiles(join(__dirname, '..', 'migrations')).map(
      (file) => ({ sequence: file.sequence, filename: file.filename }),
    );
    scripted().apiKeys.push({ id: 'k1', tenant_id: TENANT, hash: API_KEY_HASH, status: 'ACTIVE' });
    s3 = startS3Stub();
    await s3.listen();
  });

  afterAll(async () => {
    for (const app of apps) {
      await app.close({ timeoutMs: 0, pollIntervalMs: 10 }).catch(() => undefined);
    }
    await s3?.close();
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  beforeEach(() => {
    scripted().artifacts.length = 0;
    s3.requests.length = 0;
  });

  it('required mode: a marker-less object fails closed on BOTH read routes', async () => {
    const provider = makeKeyProvider();
    const { base, internalBase } = await boot({ provider });
    // An object that LOOKS like a plain payload and carries no sealed marker.
    s3.put(STORAGE_KEY, {
      body: Buffer.from(SECRET, 'utf8'),
      metadata: { artifactid: ARTIFACT, tenantid: TENANT },
    });
    seedArtifact({ id: ARTIFACT, storage_key: STORAGE_KEY });

    const runtime = await get(internalBase, runtimePath(STORAGE_KEY, 'token-' + ARTIFACT), {
      authorization: `Bearer ${RUNTIME_TOKEN}`,
    });
    expect(runtime.status).toBe(503);
    expect(runtime.code).toBe('STORAGE_FAILURE');

    const download = await get(base, `/api/v1/artifacts/${ARTIFACT}/download`, {
      'x-api-key': RAW_API_KEY,
    });
    expect(download.status).toBe(503);
    expect(download.code).toBe('STORAGE_FAILURE');
  });

  it('migration window open: the same legacy object is explicitly allowed on both routes', async () => {
    const provider = makeKeyProvider();
    const { base, internalBase } = await boot({ provider, migrationWindow: true });
    const versionId = s3.put(STORAGE_KEY, {
      body: Buffer.from(SECRET, 'utf8'),
      metadata: { artifactid: ARTIFACT, tenantid: TENANT },
    });
    seedArtifact({ id: ARTIFACT, storage_key: STORAGE_KEY, storage_version_id: versionId });

    const runtime = await get(internalBase, runtimePath(STORAGE_KEY, 'token-' + ARTIFACT), {
      authorization: `Bearer ${RUNTIME_TOKEN}`,
    });
    expect(runtime.status).toBe(200);
    expect(runtime.body).toBe(SECRET);

    const download = await get(base, `/api/v1/artifacts/${ARTIFACT}/download`, {
      'x-api-key': RAW_API_KEY,
    });
    expect(download.status).toBe(200);
    expect(download.body).toBe(SECRET);
  });

  it('sealed object decrypts on both routes and pins the committed manifest VersionId on the wire', async () => {
    const provider = makeKeyProvider();
    const { base, internalBase } = await boot({ provider });
    const fixture = await sealObject(provider, { artifactId: ARTIFACT, objectVersion: UPLOAD_TOKEN, storageKey: STORAGE_KEY });
    s3.put(STORAGE_KEY, { body: fixture.ciphertext, metadata: fixture.metadata });
    // The committed sidecar generation; a newer one is written AFTER commit.
    const manifestKey = manifestKeyFor(STORAGE_KEY);
    s3.put(manifestKey, {
      body: Buffer.from(JSON.stringify(fixture.manifest), 'utf8'),
      contentType: 'application/json',
      versionId: 'mv-committed',
    });
    const newer = await sealObject(provider, { artifactId: ARTIFACT, objectVersion: OTHER_TOKEN, storageKey: STORAGE_KEY });
    s3.put(manifestKey, {
      body: Buffer.from(JSON.stringify(newer.manifest), 'utf8'),
      contentType: 'application/json',
      versionId: 'mv-newer',
    });
    seedArtifact({ id: ARTIFACT, storage_key: STORAGE_KEY, manifest_version_id: 'mv-committed' });

    const runtime = await get(internalBase, runtimePath(STORAGE_KEY, 'token-' + ARTIFACT), {
      authorization: `Bearer ${RUNTIME_TOKEN}`,
    });
    expect(runtime.status).toBe(200);
    expect(runtime.body).toBe(SECRET);

    const download = await get(base, `/api/v1/artifacts/${ARTIFACT}/download`, {
      'x-api-key': RAW_API_KEY,
    });
    expect(download.status).toBe(200);
    expect(download.body).toBe(SECRET);

    // Adapter wiring, on the wire: the manifest GET carried the pinned id,
    // never the newer generation sitting at the same key.
    const manifestGets = s3.requests.filter((r) => r.method === 'GET' && r.key === manifestKey);
    expect(manifestGets.length).toBeGreaterThanOrEqual(2);
    expect(manifestGets.every((r) => r.versionId === 'mv-committed')).toBe(true);
    expect(s3.requests.some((r) => r.versionId === 'mv-newer')).toBe(false);
  });

  it('legacy row (NULL manifest version) reads the latest sidecar — which here is foreign, so it fails closed', async () => {
    const provider = makeKeyProvider();
    const { base, internalBase } = await boot({ provider });
    const committed = await sealObject(provider, { artifactId: ARTIFACT_UNPINNED, objectVersion: UPLOAD_TOKEN, storageKey: STORAGE_KEY_UNPINNED });
    s3.put(STORAGE_KEY_UNPINNED, { body: committed.ciphertext, metadata: committed.metadata });
    const manifestKey = manifestKeyFor(STORAGE_KEY_UNPINNED);
    s3.put(manifestKey, {
      body: Buffer.from(JSON.stringify(committed.manifest), 'utf8'),
      contentType: 'application/json',
      versionId: 'mv-old',
    });
    const foreign = await sealObject(provider, { artifactId: ARTIFACT_UNPINNED, objectVersion: OTHER_TOKEN, storageKey: STORAGE_KEY_UNPINNED });
    s3.put(manifestKey, {
      body: Buffer.from(JSON.stringify(foreign.manifest), 'utf8'),
      contentType: 'application/json',
      versionId: 'mv-latest',
    });
    // Pre-0025 row: no committed manifest generation.
    seedArtifact({ id: ARTIFACT_UNPINNED, storage_key: STORAGE_KEY_UNPINNED, manifest_version_id: null });

    const runtime = await get(internalBase, runtimePath(STORAGE_KEY_UNPINNED, 'token-' + ARTIFACT_UNPINNED), {
      authorization: `Bearer ${RUNTIME_TOKEN}`,
    });
    expect(runtime.status).toBe(503);
    expect(runtime.code).toBe('STORAGE_FAILURE');
    const manifestGets = s3.requests.filter((r) => r.method === 'GET' && r.key === manifestKey);
    expect(manifestGets.every((r) => r.versionId === undefined)).toBe(true);
  });

  it('a malformed manifest fails closed on both routes', async () => {
    const provider = makeKeyProvider();
    const { base, internalBase } = await boot({ provider });
    const fixture = await sealObject(provider, { artifactId: ARTIFACT_BAD_MANIFEST, objectVersion: UPLOAD_TOKEN, storageKey: STORAGE_KEY_BAD });
    s3.put(STORAGE_KEY_BAD, { body: fixture.ciphertext, metadata: fixture.metadata });
    s3.put(manifestKeyFor(STORAGE_KEY_BAD), {
      body: Buffer.from('{ not json', 'utf8'),
      contentType: 'application/json',
      versionId: 'mv-bad',
    });
    seedArtifact({ id: ARTIFACT_BAD_MANIFEST, storage_key: STORAGE_KEY_BAD, manifest_version_id: 'mv-bad' });

    const runtime = await get(internalBase, runtimePath(STORAGE_KEY_BAD, 'token-' + ARTIFACT_BAD_MANIFEST), {
      authorization: `Bearer ${RUNTIME_TOKEN}`,
    });
    expect(runtime.status).toBe(503);
    expect(runtime.code).toBe('STORAGE_FAILURE');

    const download = await get(base, `/api/v1/artifacts/${ARTIFACT_BAD_MANIFEST}/download`, {
      'x-api-key': RAW_API_KEY,
    });
    expect(download.status).toBe(503);
    expect(download.code).toBe('STORAGE_FAILURE');
  });

  it('RFX-15: a download grant is single-use and its token never reaches stdout or problem bodies', async () => {
    const provider = makeKeyProvider();
    const { base, internalBase } = await boot({ provider });
    const fixture = await sealObject(provider, { artifactId: ARTIFACT, objectVersion: UPLOAD_TOKEN, storageKey: STORAGE_KEY });
    s3.put(STORAGE_KEY, { body: fixture.ciphertext, metadata: fixture.metadata });
    s3.put(manifestKeyFor(STORAGE_KEY), {
      body: Buffer.from(JSON.stringify(fixture.manifest), 'utf8'),
      contentType: 'application/json',
      versionId: 'mv-single',
    });
    seedArtifact({ id: ARTIFACT, storage_key: STORAGE_KEY, manifest_version_id: 'mv-single' });
    const token = 'token-' + ARTIFACT;
    const path = runtimePath(STORAGE_KEY, token);

    const captured: string[] = [];
    const originalWrite = process.stdout.write.bind(process.stdout);
    const spy = (chunk: unknown, ...rest: unknown[]): boolean => {
      captured.push(String(chunk));
      return (originalWrite as (...a: unknown[]) => boolean)(chunk, ...rest);
    };
    process.stdout.write = spy as typeof process.stdout.write;
    try {
      const first = await get(internalBase, path, { authorization: `Bearer ${RUNTIME_TOKEN}` });
      expect(first.status).toBe(200);
      expect(first.body).toBe(SECRET);

      // The spent grant is indistinguishable from one that never existed.
      const replay = await get(base, path, { authorization: `Bearer ${RUNTIME_TOKEN}` });
      expect(replay.status).toBe(404);
      expect(replay.body).not.toContain(token);
    } finally {
      process.stdout.write = originalWrite;
    }
    expect(captured.join('')).not.toContain(token);
    expect(captured.join('')).not.toContain('grant=');
  });
});
