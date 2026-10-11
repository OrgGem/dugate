import { Readable } from 'node:stream';
import { handleRuntimeRoutes } from '../src/http/routes/runtime';
import type { RouteContext } from '../src/http/route-context';
import type { ArtifactDecryptDeps } from '../src/modules/encryption/artifact-read-decrypt';

const ARTIFACT_ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const TENANT_ID = 'tenant-a';
const RUNTIME_TOKEN = 'runtime-token-for-or10-05';
const DOWNLOAD_GRANT = 'download-grant-for-or10-05';
const UPLOAD_GRANT = 'upload-grant-for-or10-05';
const STORAGE_KEY = 'du/tenants/tenant-a/operations/operation-a/source 100% café 漢字 %2F';

interface Harness {
  readonly ctx: RouteContext;
  readonly grant: { token: string; mode: 'download' | 'upload' };
  readonly lookupKeys: string[];
  readonly decryptHeadKeys: string[];
  readonly decryptReadKeys: string[];
  readonly getBlobKeys: string[];
  readonly putBlobCalls: Array<{ storageKey: string; tenantId: string; bytes: Buffer }>;
}

function blobUrl(storageKey: string, grant: string): string {
  return `/api/runtime/v1/artifacts/blob/${encodeURIComponent(storageKey)}?grant=${grant}`;
}

function harness(): Harness {
  const grant = { token: DOWNLOAD_GRANT, mode: 'download' as const };
  const lookupKeys: string[] = [];
  const decryptHeadKeys: string[] = [];
  const decryptReadKeys: string[] = [];
  const getBlobKeys: string[] = [];
  const putBlobCalls: Harness['putBlobCalls'] = [];

  const db = {
    async query(sql: string, params: unknown[] = []) {
      if (sql.includes('WHERE a.storage_key=$1')) {
        lookupKeys.push(String(params[0]));
        return {
          rows: [{
            id: ARTIFACT_ID,
            upload_token: 'upload-version-or10-05',
            token: grant.token,
            tenant_id: TENANT_ID,
            token_mode: grant.mode,
            token_expires_at: '2999-01-01T00:00:00.000Z',
            business_id: null,
            manifest_version_id: null,
          }],
          rowCount: 1,
        };
      }
      if (sql.includes('UPDATE artifacts SET token_expires_at')) {
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    },
  };

  const artifactDecryptDeps: ArtifactDecryptDeps = {
    reader: {
      async head(storageKey) {
        decryptHeadKeys.push(storageKey);
        return {};
      },
      async read(storageKey) {
        decryptReadKeys.push(storageKey);
        return Buffer.from('reader bytes');
      },
      async readManifest() {
        return null;
      },
    },
  };

  const ctx = {
    method: 'GET',
    pathname: '',
    searchParams: new URLSearchParams(),
    headers: { authorization: `Bearer ${RUNTIME_TOKEN}` },
    body: {},
    rawBody: Buffer.from('uploaded bytes'),
    correlationId: 'or10-05-route-test',
    host: 'runtime.test',
    db,
    config: { runtimeToken: RUNTIME_TOKEN, runtimeBaseUrl: 'https://runtime.test' },
    artifacts: {
      requestAccess: async () => ({ downloadUrl: blobUrl(STORAGE_KEY, DOWNLOAD_GRANT) }),
      getBlob: async (storageKey: string) => {
        getBlobKeys.push(storageKey);
        return Readable.from([Buffer.from('artifact bytes')]);
      },
      putBlob: async (storageKey: string, tenantId: string, bytes: Buffer) => {
        putBlobCalls.push({ storageKey, tenantId, bytes });
      },
    },
    artifactDecryptDeps,
  } as unknown as RouteContext;

  return { ctx, grant, lookupKeys, decryptHeadKeys, decryptReadKeys, getBlobKeys, putBlobCalls };
}

async function invoke(ctx: RouteContext, method: string, url: string) {
  const parsed = new URL(url, 'https://runtime.test');
  ctx.method = method;
  ctx.pathname = parsed.pathname;
  ctx.searchParams = parsed.searchParams;
  return handleRuntimeRoutes(ctx);
}

async function collect(raw: unknown): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of raw as AsyncIterable<Uint8Array>) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

describe('OR10-05 artifact blob URL storage key decoding', () => {
  it('uses the once-decoded key from the returned download URL for lookup, decrypt, and read', async () => {
    const h = harness();
    const access = await invoke(
      h.ctx,
      'POST',
      `/api/runtime/v1/artifacts/${ARTIFACT_ID}/access`,
    );
    expect(access?.status).toBe(200);
    const body = access?.body as { downloadUrl?: unknown } | undefined;
    expect(typeof body?.downloadUrl).toBe('string');
    if (typeof body?.downloadUrl !== 'string') throw new Error('access route did not return a download URL');

    const download = await invoke(h.ctx, 'GET', body.downloadUrl);
    expect(download?.status).toBe(200);
    expect(download?.raw).toBeDefined();
    expect(await collect(download?.raw)).toEqual(Buffer.from('artifact bytes'));
    expect(h.lookupKeys).toEqual([STORAGE_KEY]);
    expect(h.decryptHeadKeys).toEqual([STORAGE_KEY]);
    expect(h.decryptReadKeys).toEqual([STORAGE_KEY]);
    expect(h.getBlobKeys).toEqual([STORAGE_KEY]);
  });

  it('uses the once-decoded key for the artifact lookup and blob write', async () => {
    const h = harness();
    h.grant.token = UPLOAD_GRANT;
    h.grant.mode = 'upload';

    const upload = await invoke(h.ctx, 'PUT', blobUrl(STORAGE_KEY, UPLOAD_GRANT));

    expect(upload?.status).toBe(204);
    expect(h.lookupKeys).toEqual([STORAGE_KEY]);
    expect(h.putBlobCalls).toEqual([{
      storageKey: STORAGE_KEY,
      tenantId: TENANT_ID,
      bytes: Buffer.from('uploaded bytes'),
    }]);
  });

  it('rejects malformed percent escapes before looking up an artifact', async () => {
    const h = harness();

    await expect(invoke(
      h.ctx,
      'GET',
      '/api/runtime/v1/artifacts/blob/invalid%2?grant=bad-escape',
    )).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_ARGUMENT',
    });
    expect(h.lookupKeys).toEqual([]);
  });
});
