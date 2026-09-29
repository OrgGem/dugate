import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  MULTIPART_FIXED_PART_BYTES,
  MULTIPART_MAX_TOTAL_BYTES,
  MULTIPART_MIN_TOTAL_BYTES,
} from '@du/contracts';
import {
  ArtifactStreamError,
  DefaultTaskContext,
  LeaseLostError,
  RuntimeClient,
  RuntimeError,
  uploadArtifactMultipart,
  type MultipartUploadOptions,
  type MultipartUploadTransport,
  type TaskContextDeps,
} from '../src';

/**
 * DATA-04 Step C: multipart auto-branch over the DATA-00-M wire contract.
 * Offline only: fake transports + fake fetchers, no sockets, no DB/Redis.
 */

const TASK_ID = randomUUID();
const OPERATION_ID = randomUUID();

function jsonResponse(status: number, value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

function problemResponse(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({
      type: 'urn:du:error:' + code.toLowerCase(),
      title: code,
      status,
      code,
      detail,
    }),
    { status, headers: { 'content-type': 'application/problem+json' } }
  );
}

function leaseLostResponse(): Response {
  return problemResponse(409, 'LEASE_LOST', 'stale leaseEpoch');
}

/* ------------------------------------------------------------------ */
/* deterministic pattern source + independent digests                  */
/* ------------------------------------------------------------------ */

function patternByte(i: number): number {
  return (i * 31 + 7) % 251;
}

function patternSlice(start: number, len: number): Buffer {
  const b = Buffer.allocUnsafe(len);
  for (let i = 0; i < len; i += 1) b[i] = patternByte(start + i);
  return b;
}

function patternDigest(start: number, len: number): string {
  const h = createHash('sha256');
  let done = 0;
  while (done < len) {
    const n = Math.min(1 << 16, len - done);
    h.update(patternSlice(start + done, n));
    done += n;
  }
  return h.digest('hex');
}

function* patternChunks(total: number, chunkSize: number): Generator<Buffer> {
  let off = 0;
  while (off < total) {
    const n = Math.min(chunkSize, total - off);
    yield patternSlice(off, n);
    off += n;
  }
}

function patternSource(total: number, chunkSize: number): Readable {
  return Readable.from(patternChunks(total, chunkSize));
}

/* ------------------------------------------------------------------ */
/* fake lifecycle transport + part fetcher                             */
/* ------------------------------------------------------------------ */

interface FakeSpec {
  sizeBytes: number;
  partSizeBytes?: number;
  partCountOverride?: number;
  grantSizeOverride?: number;
  partUrlBase?: string;
  putStatus?: (partNumber: number, attempt: number) => number;
  putNoEtag?: boolean;
  completeShaOverride?: string;
}

function makeFake(spec: FakeSpec) {
  const artifactId = randomUUID();
  const partSize = spec.partSizeBytes ?? 1024;
  const partCount = spec.partCountOverride ?? Math.ceil(spec.sizeBytes / partSize);
  const grants: { partNumber: number; sha256: string }[] = [];
  const puts: { partNumber: number; body: Buffer }[] = [];
  const aborts: { reason: string }[] = [];
  const calls = {
    init: null as Record<string, unknown> | null,
    grants,
    puts,
    complete: null as { parts: { partNumber: number; etag: string; sizeBytes: number; sha256: string }[]; sha256: string } | null,
    aborts,
  };
  const transport: MultipartUploadTransport = {
    async init(body) {
      calls.init = body as unknown as Record<string, unknown>;
      return {
        artifactId,
        uploadHandle: 'mh_test',
        partSizeBytes: partSize,
        partCount,
        expiresAt: '2099-01-01T00:00:00.000Z',
        replayed: false,
      };
    },
    async partGrant(id, body) {
      grants.push(body);
      const expected = Math.min(partSize, spec.sizeBytes - (body.partNumber - 1) * partSize);
      const sizeBytes = spec.grantSizeOverride ?? expected;
      return {
        artifactId: id,
        partNumber: body.partNumber,
        partUrl: (spec.partUrlBase ?? 'http://parts.test/p/') + body.partNumber + '?sig=secret-url-token',
        sizeBytes,
        requiredHeaders: {
          'content-length': String(sizeBytes),
          'x-amz-checksum-sha256': 'b64-' + body.partNumber,
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    },
    async complete(id, body) {
      calls.complete = body;
      return {
        artifactId: id,
        sizeBytes: spec.sizeBytes,
        sha256: spec.completeShaOverride ?? body.sha256,
        committed: true,
        replayed: false,
      };
    },
    async abort(id, body) {
      aborts.push(body);
      return { artifactId: id, state: 'ABORTED', replayed: false };
    },
  };
  const fetcher = (async (url: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(url));
    const partNumber = Number(u.pathname.split('/').pop());
    const attempt = puts.filter((p) => p.partNumber === partNumber).length + 1;
    const body = Buffer.isBuffer(init?.body) ? (init.body as Buffer) : Buffer.alloc(0);
    puts.push({ partNumber, body });
    const status = spec.putStatus ? spec.putStatus(partNumber, attempt) : 200;
    if (status !== 200) return problemResponse(status, 'TEST_REJECT', 'server-authored reject detail');
    if (spec.putNoEtag) return new Response(null, { status: 200 });
    return new Response(null, { status: 200, headers: { etag: '"etag-' + partNumber + '"' } });
  }) as typeof fetch;
  return { artifactId, partSize, partCount, sizeBytes: spec.sizeBytes, transport, calls, fetcher };
}

function engineOpts(fake: ReturnType<typeof makeFake>, over?: Partial<MultipartUploadOptions>): MultipartUploadOptions {
  return {
    transport: fake.transport,
    fetcher: fake.fetcher,
    fileName: 'x.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: fake.sizeBytes,
    retryBaseDelayMs: 0,
    ...over,
  };
}

describe('uploadArtifactMultipart (engine, offline)', () => {
  it('streams a remainder-carrying upload with per-part hashes and receipts', async () => {
    const fake = makeFake({ sizeBytes: 2500 });
    const result = await uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake));

    expect(result).toEqual({
      artifactId: fake.artifactId,
      sizeBytes: 2500,
      sha256: patternDigest(0, 2500),
      partCount: 3,
    });
    expect(fake.calls.init).toMatchObject({
      purpose: 'output',
      mimeType: 'application/octet-stream',
      fileName: 'x.bin',
      sizeBytes: 2500,
    });
    expect(String(fake.calls.init?.uploadToken)).toMatch(/^[0-9a-f-]{36}$/);
    expect(fake.calls.grants.map((g) => g.partNumber)).toEqual([1, 2, 3]);
    expect(fake.calls.grants.map((g) => g.sha256)).toEqual([
      patternDigest(0, 1024),
      patternDigest(1024, 1024),
      patternDigest(2048, 452),
    ]);
    // PUT bodies are exactly the pattern ranges the server geometry fixed
    expect(fake.calls.puts.map((p) => [p.partNumber, p.body.length])).toEqual([
      [1, 1024],
      [2, 1024],
      [3, 452],
    ]);
    expect(fake.calls.puts.map((p) => createHash('sha256').update(p.body).digest('hex'))).toEqual(
      fake.calls.grants.map((g) => g.sha256)
    );
    expect(fake.calls.complete?.parts).toEqual([
      { partNumber: 1, etag: '"etag-1"', sizeBytes: 1024, sha256: patternDigest(0, 1024) },
      { partNumber: 2, etag: '"etag-2"', sizeBytes: 1024, sha256: patternDigest(1024, 1024) },
      { partNumber: 3, etag: '"etag-3"', sizeBytes: 452, sha256: patternDigest(2048, 452) },
    ]);
    expect(fake.calls.complete?.sha256).toBe(patternDigest(0, 2500));
    expect(fake.calls.aborts).toHaveLength(0);
  });

  it('refuses a digest mismatch before complete and aborts the session', async () => {
    const fake = makeFake({ sizeBytes: 2500 });
    await expect(
      uploadArtifactMultipart(
        patternSource(2500, 777),
        engineOpts(fake, { expectedSha256: 'f'.repeat(64) })
      )
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(fake.calls.complete).toBeNull();
    expect(fake.calls.aborts).toEqual([{ reason: 'failed' }]);
  });

  it('refuses a source that overruns its declared size', async () => {
    const fake = makeFake({ sizeBytes: 2500 });
    await expect(uploadArtifactMultipart(patternSource(2600, 777), engineOpts(fake)))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(fake.calls.complete).toBeNull();
    expect(fake.calls.aborts).toHaveLength(1);
  });

  it('refuses a source that underdelivers', async () => {
    const fake = makeFake({ sizeBytes: 2600 });
    await expect(uploadArtifactMultipart(patternSource(2048, 1024), engineOpts(fake)))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(fake.calls.grants.map((g) => g.partNumber)).toEqual([1, 2]);
    expect(fake.calls.complete).toBeNull();
    expect(fake.calls.aborts).toHaveLength(1);
  });

  it('retries a failed part PUT via re-grant (grants are idempotent per part)', async () => {
    const fake = makeFake({
      sizeBytes: 2500,
      putStatus: (n, attempt) => (n === 2 && attempt === 1 ? 500 : 200),
    });
    const result = await uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake));
    expect(result.partCount).toBe(3);
    expect(fake.calls.grants.map((g) => g.partNumber)).toEqual([1, 2, 2, 3]);
    expect(fake.calls.aborts).toHaveLength(0);
  });

  it('fails fast on a non-retryable PUT rejection (never re-PUTs bad bytes)', async () => {
    const fake = makeFake({ sizeBytes: 2500, putStatus: () => 400 });
    const err = await uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake)).catch((e) => e);
    expect(err).toBeInstanceOf(ArtifactStreamError);
    expect(err.code).toBe('DOWNLOAD_REJECTED');
    expect(err.status).toBe(400);
    expect(fake.calls.puts.filter((p) => p.partNumber === 1)).toHaveLength(1);
    expect(fake.calls.aborts).toEqual([{ reason: 'failed' }]);
    // ADM-BASE-03: server-authored detail may travel; the presigned URL never does
    expect(err.message).toContain('server-authored reject detail');
    expect(err.message).not.toContain('secret-url-token');
  });

  it('aborts after bounded retries of a retryable PUT failure', async () => {
    const fake = makeFake({ sizeBytes: 2500, putStatus: () => 503 });
    await expect(
      uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake, { partPutAttempts: 2 }))
    ).rejects.toMatchObject({ code: 'DOWNLOAD_REJECTED', status: 503 });
    expect(fake.calls.puts.filter((p) => p.partNumber === 1)).toHaveLength(2);
    expect(fake.calls.aborts).toHaveLength(1);
  });

  it('treats a missing etag as a failed part and aborts when retries exhaust', async () => {
    const fake = makeFake({ sizeBytes: 2500, putNoEtag: true });
    await expect(
      uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake, { partPutAttempts: 2 }))
    ).rejects.toMatchObject({ code: 'EMPTY_BODY' });
    expect(fake.calls.complete).toBeNull();
    expect(fake.calls.aborts).toHaveLength(1);
  });

  it('refuses a grant whose size disagrees with the geometry without PUTting', async () => {
    const fake = makeFake({ sizeBytes: 2500, grantSizeOverride: 999 });
    await expect(uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake)))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(fake.calls.puts).toHaveLength(0);
    expect(fake.calls.aborts).toHaveLength(1);
  });

  it('refuses a non-http part URL before any PUT (SSRF discipline)', async () => {
    const fake = makeFake({ sizeBytes: 2500, partUrlBase: 'file:///tmp/x-' });
    await expect(uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake)))
      .rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(fake.calls.puts).toHaveLength(0);
    expect(fake.calls.aborts).toHaveLength(1);
  });

  it('refuses an init geometry the SDK cannot buffer safely', async () => {
    const fake = makeFake({ sizeBytes: 2500, partSizeBytes: 2048, partCountOverride: 2 });
    await expect(
      uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake, { maxPartBytes: 1024 }))
    ).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(fake.calls.grants).toHaveLength(0);
    expect(fake.calls.aborts).toHaveLength(1);
  });

  it('aborts when storage rejects a part whose bytes no longer match the signed digest', async () => {
    const fake = makeFake({ sizeBytes: 1024 });
    const corruptingFetcher = (async (url: string | URL | Request, init?: RequestInit) => {
      const partNumber = Number(new URL(String(url)).pathname.split('/').pop());
      const bytes = Buffer.from(init?.body as Buffer);
      bytes[0] = (bytes[0]! + 1) % 256;
      fake.calls.puts.push({ partNumber, body: bytes });
      const requestedDigest = fake.calls.grants.find((grant) => grant.partNumber === partNumber)?.sha256;
      const storedDigest = createHash('sha256').update(bytes).digest('hex');
      if (storedDigest !== requestedDigest) {
        return problemResponse(400, 'CHECKSUM_MISMATCH', 'uploaded part bytes do not match the granted digest');
      }
      return new Response(null, { status: 200, headers: { etag: '"etag-' + partNumber + '"' } });
    }) as typeof fetch;

    await expect(
      uploadArtifactMultipart(patternSource(1024, 1024), engineOpts(fake, { fetcher: corruptingFetcher }))
    ).rejects.toMatchObject({ code: 'DOWNLOAD_REJECTED', status: 400 });
    expect(fake.calls.complete).toBeNull();
    expect(fake.calls.aborts).toEqual([{ reason: 'failed' }]);
    expect(createHash('sha256').update(fake.calls.puts[0]!.body).digest('hex')).not.toBe(fake.calls.grants[0]!.sha256);
  });

  it('aborts an expired multipart session when the next part grant is rejected', async () => {
    const fake = makeFake({ sizeBytes: 2500 });
    const expiredSession = new RuntimeError(410, 'MULTIPART_SESSION_EXPIRED', null);
    fake.transport.partGrant = async () => {
      throw expiredSession;
    };

    await expect(uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake))).rejects.toBe(expiredSession);
    expect(fake.calls.puts).toHaveLength(0);
    expect(fake.calls.complete).toBeNull();
    expect(fake.calls.aborts).toEqual([{ reason: 'failed' }]);
  });

  it('times out an in-flight part PUT and cleans up the multipart session', async () => {
    const fake = makeFake({ sizeBytes: 1024 });
    const timeoutFetcher = (async (_url: string | URL | Request, init?: RequestInit) =>
      await new Promise<Response>((_resolve, reject) => {
        const signal = init?.signal;
        const onAbort = (): void => {
          const error = new Error('part PUT timed out');
          error.name = 'AbortError';
          reject(error);
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      })) as typeof fetch;

    await expect(
      uploadArtifactMultipart(
        patternSource(1024, 1024),
        engineOpts(fake, { fetcher: timeoutFetcher, timeoutMs: 10, partPutAttempts: 1 })
      )
    ).rejects.toMatchObject({ code: 'TIMEOUT' });
    expect(fake.calls.complete).toBeNull();
    expect(fake.calls.aborts).toEqual([{ reason: 'failed' }]);
  });

  it('rejects an init response missing its upload handle', async () => {
    const client = new RuntimeClient({
      baseUrl: 'http://runtime.test/api/runtime/v1',
      token: 'offline-test-token',
      fetchImpl: (async () => jsonResponse(201, {
        artifactId: randomUUID(),
        partSizeBytes: MULTIPART_FIXED_PART_BYTES,
        partCount: Math.ceil(MULTIPART_MIN_TOTAL_BYTES / MULTIPART_FIXED_PART_BYTES),
        expiresAt: '2099-01-01T00:00:00.000Z',
        replayed: false,
      })) as typeof fetch,
    });

    await expect(client.multipartInit(TASK_ID, {
      leaseEpoch: 1,
      uploadToken: randomUUID(),
      purpose: 'output',
      mimeType: 'application/octet-stream',
      sizeBytes: MULTIPART_MIN_TOTAL_BYTES,
    })).rejects.toThrow();
  });

  it('rejects a server part size below the multipart non-final-part boundary', async () => {
    const tooSmallPartSize = 5 * 1024 * 1024 - 1;
    const client = new RuntimeClient({
      baseUrl: 'http://runtime.test/api/runtime/v1',
      token: 'offline-test-token',
      fetchImpl: (async () => jsonResponse(201, {
        artifactId: randomUUID(),
        uploadHandle: 'mh_test',
        partSizeBytes: tooSmallPartSize,
        partCount: Math.ceil(MULTIPART_MIN_TOTAL_BYTES / tooSmallPartSize),
        expiresAt: '2099-01-01T00:00:00.000Z',
        replayed: false,
      })) as typeof fetch,
    });

    await expect(client.multipartInit(TASK_ID, {
      leaseEpoch: 1,
      uploadToken: randomUUID(),
      purpose: 'output',
      mimeType: 'application/octet-stream',
      sizeBytes: MULTIPART_MIN_TOTAL_BYTES,
    })).rejects.toThrow();
  });

  it('isolates cleanup when one of two concurrent multipart uploads fails a part', async () => {
    const failing = makeFake({ sizeBytes: 2048, putStatus: () => 400 });
    const succeeding = makeFake({ sizeBytes: 2048 });
    const [failedUpload, successfulUpload] = await Promise.allSettled([
      uploadArtifactMultipart(patternSource(2048, 512), engineOpts(failing)),
      uploadArtifactMultipart(patternSource(2048, 777), engineOpts(succeeding)),
    ]);

    expect(failedUpload).toMatchObject({ status: 'rejected', reason: { code: 'DOWNLOAD_REJECTED', status: 400 } });
    expect(successfulUpload.status).toBe('fulfilled');
    expect(failing.calls.complete).toBeNull();
    expect(failing.calls.aborts).toEqual([{ reason: 'failed' }]);
    expect(succeeding.calls.complete).not.toBeNull();
    expect(succeeding.calls.aborts).toHaveLength(0);
  });

  it('refuses an init partCount that disagrees with the declared size', async () => {
    const fake = makeFake({ sizeBytes: 2500, partCountOverride: 99 });
    await expect(uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake)))
      .rejects.toMatchObject({ code: 'SIZE_MISMATCH' });
    expect(fake.calls.grants).toHaveLength(0);
    expect(fake.calls.aborts).toHaveLength(1);
  });

  it('aborts mid-upload on caller signal and never completes', async () => {
    const ac = new AbortController();
    const fake = makeFake({
      sizeBytes: 2048,
      putStatus: (n) => {
        if (n === 1) ac.abort();
        return 200;
      },
    });
    await expect(
      uploadArtifactMultipart(patternSource(2048, 1024), engineOpts(fake, { signal: ac.signal }))
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE' });
    expect(fake.calls.grants.map((g) => g.partNumber)).toEqual([1]);
    expect(fake.calls.complete).toBeNull();
    expect(fake.calls.aborts).toEqual([{ reason: 'cancelled' }]);
  });

  it('never aborts when complete already committed the bytes (ack suspect instead)', async () => {
    const fake = makeFake({ sizeBytes: 2500, completeShaOverride: 'a'.repeat(64) });
    await expect(uploadArtifactMultipart(patternSource(2500, 777), engineOpts(fake)))
      .rejects.toMatchObject({ code: 'HASH_MISMATCH' });
    expect(fake.calls.aborts).toHaveLength(0);
  });
});

/* ------------------------------------------------------------------ */
/* writeStream auto-branch (facade over the real RuntimeClient)        */
/* ------------------------------------------------------------------ */

const PART_SIZE = 8 * 1024 * 1024;
const BIG_SIZE = 64 * 1024 * 1024 + 1024; // 9 wire parts: 8 full + 1KiB remainder
const BIG_PARTS = Math.ceil(BIG_SIZE / PART_SIZE);
const WHOLE_SHA = patternDigest(0, BIG_SIZE);
const LEGACY_ARTIFACT_ID = '77777777-7777-4777-8777-777777777777';

function expectedPartSize(n: number): number {
  return Math.min(PART_SIZE, BIG_SIZE - (n - 1) * PART_SIZE);
}

function makeFacadeRouter(opts: { fenceGrantAt?: number; failCompleteLease?: boolean } = {}) {
  const artifactId = randomUUID();
  const seen: string[] = [];
  const grants: Record<string, unknown>[] = [];
  const puts: { size: number; sha: string }[] = [];
  const aborts: Record<string, unknown>[] = [];
  const state = {
    artifactId,
    seen,
    grants,
    puts,
    aborts,
    init: null as Record<string, unknown> | null,
    complete: null as Record<string, unknown> | null,
    finalize: null as Record<string, unknown> | null,
    legacyGrantPosts: 0,
  };
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const u = new URL(String(input));
    const path = u.pathname;
    const method = String(init?.method ?? 'GET');
    seen.push(method + ' ' + path);
    if (method === 'POST' && path === '/api/runtime/v1/tasks/' + TASK_ID + '/artifacts/multipart') {
      state.init = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(201, {
        artifactId,
        uploadHandle: 'mh_test',
        partSizeBytes: PART_SIZE,
        partCount: BIG_PARTS,
        expiresAt: '2099-01-01T00:00:00.000Z',
        replayed: false,
      });
    }
    if (method === 'POST' && path.endsWith('/multipart/part')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      const n = Number(body.partNumber);
      if (opts.fenceGrantAt === n) return leaseLostResponse();
      grants.push(body);
      return jsonResponse(200, {
        artifactId,
        partNumber: n,
        partUrl: 'http://parts.test/p/' + n + '?sig=secret-url-token',
        sizeBytes: expectedPartSize(n),
        requiredHeaders: {
          'content-length': String(expectedPartSize(n)),
          'x-amz-checksum-sha256': 'b64-' + n,
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    if (method === 'POST' && path.endsWith('/multipart/complete')) {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      if (opts.failCompleteLease) return leaseLostResponse();
      state.complete = body;
      return jsonResponse(200, {
        artifactId,
        sizeBytes: BIG_SIZE,
        sha256: String(body.sha256),
        committed: true,
        replayed: false,
      });
    }
    if (method === 'POST' && path.endsWith('/multipart/abort')) {
      aborts.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      return jsonResponse(200, { artifactId, state: 'ABORTED', replayed: false });
    }
    if (method === 'PUT' && u.hostname === 'parts.test') {
      const n = Number(path.split('/').pop());
      const headers = (init?.headers ?? {}) as Record<string, string>;
      if (headers['content-length'] !== String(expectedPartSize(n))) {
        throw new Error('part PUT lost its required content-length header');
      }
      if (headers['x-amz-checksum-sha256'] !== 'b64-' + n) {
        throw new Error('part PUT lost its required checksum header');
      }
      const body = init?.body as Buffer;
      puts.push({ size: body.length, sha: createHash('sha256').update(body).digest('hex') });
      return new Response(null, { status: 200, headers: { etag: '"etag-' + n + '"' } });
    }
    if (method === 'POST' && path === '/api/runtime/v1/tasks/' + TASK_ID + '/artifacts') {
      state.legacyGrantPosts += 1;
      return jsonResponse(201, {
        artifactId: LEGACY_ARTIFACT_ID,
        uploadUrl: 'http://blob.test/legacy-put',
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }
    if (method === 'PUT' && u.hostname === 'blob.test') {
      const stream = init?.body as ReadableStream<Uint8Array>;
      const drained = Buffer.from(await new Response(stream).arrayBuffer());
      puts.push({ size: drained.length, sha: createHash('sha256').update(drained).digest('hex') });
      return new Response(null, { status: 200 });
    }
    if (method === 'POST' && path.endsWith('/finalize')) {
      state.finalize = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return jsonResponse(200, {});
    }
    return new Response('unexpected ' + method + ' ' + path, { status: 404 });
  }) as typeof fetch;
  // same-object return: the fetch closure mutates state.init/complete/... later
  return Object.assign(state, { fetchImpl });
}

function makeContext(fetchImpl: typeof fetch, extraDeps: Partial<TaskContextDeps> = {}) {
  const runtime = new RuntimeClient({
    baseUrl: 'http://runtime.test/api/runtime/v1',
    token: 'offline-test-token',
    fetchImpl,
  });
  return new DefaultTaskContext(
    {
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      tenantId: 'tenant-test',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'ingest',
      kind: 'ingest',
      taskKey: 'ingest-1',
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      deadlineAt: null,
      input: {},
      connectorBindings: {},
      checkpointRefs: [],
      cancelRequested: false,
    } as never,
    {
      runtime,
      fetchImpl,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
      invokeConnector: async () => {
        throw new Error('unused');
      },
      ...extraDeps,
    }
  );
}

describe('writeStream multipart auto-branch (DATA-04 Step C)', () => {
  it('rides the multipart lifecycle past the single-PUT cap with zero business-side change', async () => {
    const router = makeFacadeRouter();
    const ctx = makeContext(router.fetchImpl);
    const ref = await ctx.artifacts.writeStream(
      patternSource(BIG_SIZE, 65537),
      'big.bin',
      'application/octet-stream',
      BIG_SIZE,
      'output',
      WHOLE_SHA
    );

    expect(ref).toEqual({
      artifactId: router.artifactId,
      role: 'output',
      fileName: 'big.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: BIG_SIZE,
      hashSha256: WHOLE_SHA,
    });
    expect(ctx.committedOutputArtifacts().map((r) => r.artifactId)).toEqual([router.artifactId]);

    expect(router.init).toMatchObject({
      leaseEpoch: 1,
      purpose: 'output',
      mimeType: 'application/octet-stream',
      fileName: 'big.bin',
      sizeBytes: BIG_SIZE,
    });
    expect(String(router.init?.uploadToken)).toMatch(/^[0-9a-f-]{36}$/);

    expect(router.grants).toHaveLength(BIG_PARTS);
    for (let n = 1; n <= BIG_PARTS; n += 1) {
      expect(router.grants[n - 1]).toMatchObject({
        leaseEpoch: 1,
        partNumber: n,
        sha256: patternDigest((n - 1) * PART_SIZE, expectedPartSize(n)),
      });
      expect(router.puts[n - 1]).toEqual({
        size: expectedPartSize(n),
        sha: patternDigest((n - 1) * PART_SIZE, expectedPartSize(n)),
      });
    }

    const receipts = (router.complete?.parts ?? []) as { partNumber: number }[];
    expect(receipts.map((p) => p.partNumber)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(router.complete).toMatchObject({ leaseEpoch: 1, sha256: WHOLE_SHA });
    expect(router.finalize).toEqual({ taskId: TASK_ID, leaseEpoch: 1, sizeBytes: BIG_SIZE, sha256: WHOLE_SHA });
    expect(router.aborts).toHaveLength(0);
    expect(router.legacyGrantPosts).toBe(0);
    expect(router.seen[0]).toBe('POST /api/runtime/v1/tasks/' + TASK_ID + '/artifacts/multipart');
    expect(router.seen[router.seen.length - 1]).toBe(
      'POST /api/runtime/v1/artifacts/' + router.artifactId + '/finalize'
    );
  }, 120_000);

  it('keeps the legacy single-PUT path when the operator raises both caps', async () => {
    const router = makeFacadeRouter();
    const ctx = makeContext(router.fetchImpl, {
      maxArtifactBytes: 128 * 1024 * 1024,
      multipartThresholdBytes: 128 * 1024 * 1024,
    });
    const ref = await ctx.artifacts.writeStream(
      patternSource(BIG_SIZE, 1 << 20),
      'big.bin',
      'application/octet-stream',
      BIG_SIZE,
      'output',
      WHOLE_SHA
    );
    expect(ref.artifactId).toBe(LEGACY_ARTIFACT_ID);
    expect(ref.hashSha256).toBe(WHOLE_SHA);
    expect(router.grants).toHaveLength(0);
    expect(router.legacyGrantPosts).toBe(1);
    expect(router.finalize).toMatchObject({ sizeBytes: BIG_SIZE, sha256: WHOLE_SHA });
  }, 120_000);

  it('branches on the threshold, not on the single-PUT cap alone', async () => {
    const router = makeFacadeRouter();
    const ctx = makeContext(router.fetchImpl, {
      maxArtifactBytes: 128 * 1024 * 1024,
      multipartThresholdBytes: 8 * 1024 * 1024,
    });
    const ref = await ctx.artifacts.writeStream(
      patternSource(BIG_SIZE, 1 << 20),
      'big.bin',
      'application/octet-stream',
      BIG_SIZE,
      'output',
      WHOLE_SHA
    );
    expect(ref.artifactId).toBe(router.artifactId);
    expect(router.grants).toHaveLength(BIG_PARTS);
    expect(router.legacyGrantPosts).toBe(0);
  }, 120_000);

  it('refuses above the wire ceiling without touching the network', async () => {
    const router = makeFacadeRouter();
    const ctx = makeContext(router.fetchImpl);
    await expect(
      ctx.artifacts.writeStream(
        Readable.from([]),
        'impossible.bin',
        'application/octet-stream',
        MULTIPART_MAX_TOTAL_BYTES + 1
      )
    ).rejects.toThrow('artifact size exceeds the multipart wire ceiling');
    expect(router.seen).toHaveLength(0);
  });

  it('fails closed between a shrunk cap and the contract floor', async () => {
    const router = makeFacadeRouter();
    const ctx = makeContext(router.fetchImpl, { maxArtifactBytes: 10 * 1024 * 1024 });
    await expect(
      ctx.artifacts.writeStream(
        Readable.from([]),
        'gray-zone.bin',
        'application/octet-stream',
        20 * 1024 * 1024
      )
    ).rejects.toThrow('artifact size exceeds the configured worker byte limit');
    expect(router.seen).toHaveLength(0);
  });

  it('propagates a lease fence on complete without aborting committed bytes', async () => {
    const router = makeFacadeRouter({ failCompleteLease: true });
    const ctx = makeContext(router.fetchImpl);
    await expect(
      ctx.artifacts.writeStream(
        patternSource(BIG_SIZE, 1 << 20),
        'big.bin',
        'application/octet-stream',
        BIG_SIZE
      )
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(router.grants).toHaveLength(BIG_PARTS);
    expect(router.complete).toBeNull();
    expect(router.aborts).toHaveLength(0);
    expect(router.finalize).toBeNull();
  }, 120_000);

  it('aborts best-effort when a part grant fences the lease', async () => {
    const router = makeFacadeRouter({ fenceGrantAt: 5 });
    const ctx = makeContext(router.fetchImpl);
    await expect(
      ctx.artifacts.writeStream(
        patternSource(BIG_SIZE, 1 << 20),
        'big.bin',
        'application/octet-stream',
        BIG_SIZE
      )
    ).rejects.toBeInstanceOf(LeaseLostError);
    expect(router.grants).toHaveLength(4);
    // lease loss aborts the delivery signal, so the engine files the
    // best-effort session cleanup as 'cancelled' (server still fences it)
    expect(router.aborts).toEqual([{ leaseEpoch: 1, reason: 'cancelled' }]);
    expect(router.finalize).toBeNull();
  }, 120_000);
});
