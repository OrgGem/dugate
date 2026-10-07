import { createHash, randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import {
  ArtifactStreamError,
  DEFAULT_STALE_WORKSPACE_MS,
  TEMP_WORKSPACE_PREFIX,
  committedOutputArtifactIds,
  createTempWorkspace,
  downloadArtifact,
  downloadArtifactById,
  openArtifactStream,
  sweepStaleWorkspaces,
  touchWorkspaceMtime,
  uploadArtifactStream,
  withDownloadedArtifact,
} from '../src';
import type { DownloadedArtifact, SdkFetcher, TempWorkspace } from '../src';

/**
 * P4-05 — artifact streaming/download, temp isolation & cleanup.
 *
 * ART-01..03 at the SDK seam: every HTTP call goes through an injected
 * mock fetcher (no network, no DB, no Redis); disk I/O is real but
 * confined to a per-run test root under os.tmpdir() that is removed in
 * afterAll. Bounded-memory claims are proven by pull-counting stream
 * sources: the source must stop early when the byte limit trips.
 */

const RUNTIME = 'http://runtime.test';
const TOKEN = 'tok-cc-p405';
const TASK_ID = randomUUID();

let testRoot: string;
const workspaces: TempWorkspace[] = [];

beforeAll(async () => {
  testRoot = await mkdtemp(join(tmpdir(), 'du-p405-test-'));
});

afterAll(async () => {
  for (const ws of workspaces) await ws.dispose().catch(() => undefined);
  await rm(testRoot, { recursive: true, force: true });
});

async function makeWorkspace(taskId: string = TASK_ID): Promise<TempWorkspace> {
  const ws = await createTempWorkspace(taskId, { rootDir: testRoot });
  workspaces.push(ws);
  return ws;
}

/* -------------------------------------------------------------------- */
/* Stream-source plumbing (pull-counting, bounded-memory evidence)       */
/* -------------------------------------------------------------------- */

interface PullCounter {
  pulled: number;
  cancelled: boolean;
}

function chunkedResponse(
  chunks: Uint8Array[],
  counter: PullCounter,
  init: { status?: number; headers?: Record<string, string>; body?: Uint8Array[] | null } = {}
): Response {
  let i = 0;
  const source = init.body ?? chunks;
  const stream = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (i >= source.length) {
        controller.close();
        return;
      }
      counter.pulled++;
      controller.enqueue(source[i++]!);
    },
    cancel() {
      counter.cancelled = true;
    },
  });
  if (init.body === null) {
    return new Response(null, {
      status: init.status ?? 200,
      headers: init.headers,
    }) as unknown as Response;
  }
  return new Response(stream, {
    status: init.status ?? 200,
    headers: init.headers,
  }) as unknown as Response;
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  }) as unknown as Response;
}

function makeChunks(count: number, size: number, fill = 0x61): Uint8Array[] {
  return Array.from({ length: count }, (_, i) => new Uint8Array(size).fill((fill + i) & 0xff));
}

function sha256Of(chunks: Uint8Array[]): string {
  const h = createHash('sha256');
  for (const c of chunks) h.update(c);
  return h.digest('hex');
}

function totalBytes(chunks: Uint8Array[]): number {
  return chunks.reduce((n, c) => n + c.length, 0);
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

async function drain(stream: Readable): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += (chunk as Buffer).length;
  return bytes;
}

interface CapturedInit {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  redirect: unknown;
  signal: AbortSignal | undefined;
}

/* -------------------------------------------------------------------- */
/* createTempWorkspace — ART-02 isolation                                */
/* -------------------------------------------------------------------- */

describe('createTempWorkspace (ART-02 temp isolation)', () => {
  it('creates a unique per-task directory under the root', async () => {
    const a = await makeWorkspace();
    const b = await makeWorkspace();
    expect(a.dir).not.toBe(b.dir);
    expect(a.dir.startsWith(testRoot)).toBe(true);
    expect(a.dir).toContain(`${TEMP_WORKSPACE_PREFIX}${TASK_ID}`);
    const st = await stat(a.dir);
    expect(st.isDirectory()).toBe(true);
  });

  it('sanitizes a hostile taskId into safe characters only', async () => {
    const ws = await makeWorkspace('../../etc/passwd');
    const base = ws.dir.slice(testRoot.length + 1);
    expect(base).not.toContain('..');
    expect(base).not.toContain('/');
    expect(base).not.toContain('\\');
    expect(ws.taskId).toBe('------etc-passwd');
  });

  it('filePath resolves safe names inside the workspace dir', async () => {
    const ws = await makeWorkspace();
    const p = ws.filePath('report.pdf');
    expect(p).toBe(join(ws.dir, 'report.pdf'));
  });

  it.each([
    ['../evil.pdf', 'parent traversal'],
    ['..', 'bare parent'],
    ['.', 'bare dot'],
    ['sub/dir.pdf', 'forward separator'],
    ['sub\\dir.pdf', 'back separator'],
    ['nul.pdf', 'windows reserved device'],
    ['CON', 'windows reserved name'],
    ['bad\u0000name.pdf', 'NUL byte'],
    ['bad\u001fname.pdf', 'control character'],
    ['', 'empty name'],
    [`${'x'.repeat(256)}.pdf`, 'overlong name'],
  ])('filePath refuses traversal/hostile name %p (%s)', async (name) => {
    const ws = await makeWorkspace();
    expect(() => ws.filePath(name)).toThrow(ArtifactStreamError);
    try {
      ws.filePath(name);
    } catch (err) {
      expect((err as ArtifactStreamError).code).toBe('INVALID_FILE_NAME');
    }
  });

  it('dispose removes the whole tree and is idempotent', async () => {
    const ws = await createTempWorkspace(TASK_ID, { rootDir: testRoot });
    const file = ws.filePath('inner.txt');
    await rm(file, { force: true }); // ensure clean
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(ws.dir, 'nested'), { recursive: true });
    await writeFile(join(ws.dir, 'nested', 'deep.txt'), 'x', 'utf8');
    expect(existsSync(ws.dir)).toBe(true);
    await ws.dispose();
    expect(existsSync(ws.dir)).toBe(false);
    await ws.dispose(); // second call is a no-op, must not throw
    expect(existsSync(ws.dir)).toBe(false);
  });
});

/* -------------------------------------------------------------------- */
/* downloadArtifact — ART-01/03 bounded streaming                        */
/* -------------------------------------------------------------------- */

describe('downloadArtifact (bounded-memory streaming download)', () => {
  it('streams the full body to the workspace file with correct size + sha256', async () => {
    const ws = await makeWorkspace();
    const chunks = makeChunks(64, 1024);
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const fetcher: SdkFetcher = async () => chunkedResponse(chunks, counter);

    const out = await downloadArtifact(ws, 'doc.bin', 'https://storage.example/blob/1', {
      maxBytes: 10 * 1024 * 1024,
      fetcher,
    });

    expect(out.sizeBytes).toBe(totalBytes(chunks));
    expect(out.sha256).toBe(sha256Of(chunks));
    const onDisk = await readFile(out.path);
    expect(onDisk.length).toBe(totalBytes(chunks));
    expect(createHash('sha256').update(onDisk).digest('hex')).toBe(sha256Of(chunks));
    // Every chunk was pulled exactly once: true streaming, no re-reads.
    expect(counter.pulled).toBe(64);
  });

  it('accepts exact maxBytes when chunk framing splits across the boundary', async () => {
    const ws = await makeWorkspace();
    const chunks = [
      new Uint8Array([0x00]),
      new Uint8Array(1022).fill(0x7f),
      new Uint8Array([0xff]),
    ];
    const expected = Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const fetcher: SdkFetcher = async () => chunkedResponse(chunks, counter, {
      headers: { 'content-length': String(expected.byteLength) },
    });

    const result = await downloadArtifact(ws, 'framed-at-limit.bin', 'https://storage.example/framed', {
      maxBytes: expected.byteLength,
      expectedSizeBytes: expected.byteLength,
      expectedSha256: createHash('sha256').update(expected).digest('hex'),
      fetcher,
    });

    expect(result.sizeBytes).toBe(1024);
    expect(await readFile(result.path)).toEqual(expected);
    expect(counter.pulled).toBe(3);
  });

  it('rejects a chunk stream one byte over maxBytes and removes the partial destination', async () => {
    const ws = await makeWorkspace();
    const target = ws.filePath('one-byte-over.bin');
    const chunks = [new Uint8Array([0x01]), new Uint8Array([0x02]), new Uint8Array([0x03])];
    const fetcher: SdkFetcher = async () => chunkedResponse(chunks, { pulled: 0, cancelled: false });

    await expect(downloadArtifact(ws, 'one-byte-over.bin', 'https://storage.example/over-by-one', {
      maxBytes: 2,
      expectedSizeBytes: 3,
      fetcher,
    })).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
    expect(existsSync(target)).toBe(false);
  });

  it('rejects reordered corrupt chunks even when their combined size is unchanged', async () => {
    const ws = await makeWorkspace();
    const expectedChunks = [new Uint8Array([0x10, 0x20]), new Uint8Array([0x30, 0x40])];
    const corruptedChunks = [...expectedChunks].reverse();
    const expectedBytes = Buffer.concat(expectedChunks.map((chunk) => Buffer.from(chunk)));
    const target = ws.filePath('reordered.bin');
    const fetcher: SdkFetcher = async () => chunkedResponse(corruptedChunks, { pulled: 0, cancelled: false });

    await expect(downloadArtifact(ws, 'reordered.bin', 'https://storage.example/reordered', {
      maxBytes: expectedBytes.length,
      expectedSizeBytes: expectedBytes.length,
      expectedSha256: createHash('sha256').update(expectedBytes).digest('hex'),
      fetcher,
    })).rejects.toMatchObject({ code: 'HASH_MISMATCH', status: 422 });
    expect(existsSync(target)).toBe(false);
  });

  it('preserves malformed UTF-8 sequences as opaque binary bytes', async () => {
    const ws = await makeWorkspace();
    const bytes = new Uint8Array([0xff, 0xc3, 0x28, 0x00, 0x80]);
    const fetcher: SdkFetcher = async () => chunkedResponse([bytes], { pulled: 0, cancelled: false });

    const result = await downloadArtifact(ws, 'opaque-bytes.bin', 'https://storage.example/opaque', {
      maxBytes: bytes.byteLength,
      expectedSizeBytes: bytes.byteLength,
      expectedSha256: createHash('sha256').update(bytes).digest('hex'),
      fetcher,
    });

    expect(await readFile(result.path)).toEqual(Buffer.from(bytes));
  });

  it('rejects an oversized artifact up-front via content-length (no file written)', async () => {
    const ws = await makeWorkspace();
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const fetcher: SdkFetcher = async () =>
      chunkedResponse(makeChunks(4, 1024), counter, {
        headers: { 'content-length': String(10_000_000) },
      });

    const target = ws.filePath('big.bin');
    await expect(
      downloadArtifact(ws, 'big.bin', 'https://storage.example/blob/2', { maxBytes: 1024, fetcher })
    ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
    expect(existsSync(target)).toBe(false);
    // The pre-check fires before the body is drained: undici read-aheads at
    // most one chunk into the constructed Response, but the remaining
    // chunks are never pulled and nothing is written to disk.
    expect(counter.pulled).toBeLessThan(4);
  });

  it('aborts mid-stream when maxBytes trips and deletes the partial file', async () => {
    const ws = await makeWorkspace();
    const chunks = makeChunks(100, 1024); // 100 KiB total
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const fetcher: SdkFetcher = async () => chunkedResponse(chunks, counter);

    const target = ws.filePath('bomb.bin');
    await expect(
      downloadArtifact(ws, 'bomb.bin', 'https://storage.example/blob/3', { maxBytes: 2500, fetcher })
    ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });

    expect(existsSync(target)).toBe(false); // bounded file lifetime
    expect(counter.pulled).toBeLessThan(100); // source stopped early — bounded memory
  });

  it('verifies expectedSha256 while streaming and deletes the file on mismatch', async () => {
    const ws = await makeWorkspace();
    const chunks = makeChunks(8, 512);
    const good = sha256Of(chunks);
    const fetcher: SdkFetcher = async () => chunkedResponse(chunks, { pulled: 0, cancelled: false });

    const ok = await downloadArtifact(ws, 'ok.bin', 'https://storage.example/blob/4', {
      maxBytes: 1 << 20,
      expectedSha256: good,
      fetcher,
    });
    expect(ok.sha256).toBe(good);
    expect(existsSync(ok.path)).toBe(true);

    const badTarget = ws.filePath('bad.bin');
    await expect(
      downloadArtifact(ws, 'bad.bin', 'https://storage.example/blob/4', {
        maxBytes: 1 << 20,
        expectedSha256: 'f'.repeat(64),
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'HASH_MISMATCH', status: 422 });
    expect(existsSync(badTarget)).toBe(false);
  });

  it('verifies expectedSizeBytes and deletes the file on mismatch', async () => {
    const ws = await makeWorkspace();
    const chunks = makeChunks(3, 100);
    const fetcher: SdkFetcher = async () => chunkedResponse(chunks, { pulled: 0, cancelled: false });
    await expect(
      downloadArtifact(ws, 'size.bin', 'https://storage.example/blob/5', {
        maxBytes: 1 << 20,
        expectedSizeBytes: totalBytes(chunks) + 1,
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH', status: 422 });
    expect(existsSync(ws.filePath('size.bin'))).toBe(false);
  });

  it('surfaces a non-2xx download as DOWNLOAD_REJECTED with the problem detail', async () => {
    const ws = await makeWorkspace();
    const fetcher: SdkFetcher = async () =>
      jsonResponse(403, {
        type: 'urn:du:error:forbidden',
        status: 403,
        code: 'FORBIDDEN',
        title: 'grant expired',
        detail: 'presigned URL expired',
      });
    await expect(
      downloadArtifact(ws, 'x.bin', 'https://storage.example/blob/6', { maxBytes: 1024, fetcher })
    ).rejects.toMatchObject({ code: 'DOWNLOAD_REJECTED', status: 403, message: 'presigned URL expired' });
    expect(existsSync(ws.filePath('x.bin'))).toBe(false);
  });

  it('wraps a rejected fetcher as TRANSPORT_FAILURE with no file left', async () => {
    const ws = await makeWorkspace();
    const fetcher: SdkFetcher = async () => {
      throw new Error('ECONNRESET');
    };
    await expect(
      downloadArtifact(ws, 'x.bin', 'https://storage.example/blob/7', { maxBytes: 1024, fetcher })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE', status: 0 });
    expect(existsSync(ws.filePath('x.bin'))).toBe(false);
  });

  it('maps a socket reset during the response body to TRANSPORT_FAILURE and removes partial output', async () => {
    const ws = await makeWorkspace();
    const target = ws.filePath('reset.bin');
    const socketError = Object.assign(new Error('socket reset while reading response body'), { code: 'ECONNRESET' });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls === 0) {
          pulls += 1;
          controller.enqueue(new Uint8Array(4096).fill(0x61));
          return;
        }
        pulls += 1;
        controller.error(socketError);
      },
    });
    const fetcher: SdkFetcher = async () => new Response(body) as unknown as Response;

    await expect(
      downloadArtifact(ws, 'reset.bin', 'https://storage.example/reset', { maxBytes: 1 << 20, fetcher })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE', status: 0 });
    expect(pulls).toBe(2);
    expect(existsSync(target)).toBe(false);
  });

  it('treats an error after the exact declared byte boundary as a truncated transport failure', async () => {
    const ws = await makeWorkspace();
    const target = ws.filePath('exact-boundary-truncated.bin');
    const bytes = new Uint8Array([0x21, 0x22, 0x23]);
    const sourceError = Object.assign(new Error('stream ended before a clean close'), { code: 'ERR_STREAM_PREMATURE_CLOSE' });
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) {
          controller.enqueue(bytes);
          return;
        }
        controller.error(sourceError);
      },
    });
    const fetcher: SdkFetcher = async () => new Response(body) as unknown as Response;

    await expect(downloadArtifact(ws, 'exact-boundary-truncated.bin', 'https://storage.example/truncated-at-boundary', {
      maxBytes: bytes.length,
      expectedSizeBytes: bytes.length,
      fetcher,
    })).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE', status: 0 });
    expect(existsSync(target)).toBe(false);
  });

  it('fails closed when the workspace file destination is a directory', async () => {
    const ws = await makeWorkspace();
    const target = ws.filePath('directory-target.bin');
    const { mkdir } = await import('node:fs/promises');
    await mkdir(target);
    const fetcher: SdkFetcher = async () =>
      chunkedResponse(makeChunks(2, 128), { pulled: 0, cancelled: false });

    await expect(
      downloadArtifact(ws, 'directory-target.bin', 'https://storage.example/invalid-destination', {
        maxBytes: 1024,
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE', status: 0 });
    expect((await stat(target)).isDirectory()).toBe(true);
  });

  it('refuses a 200 with an empty body as EMPTY_BODY', async () => {
    const ws = await makeWorkspace();
    const fetcher: SdkFetcher = async () =>
      chunkedResponse([], { pulled: 0, cancelled: false }, { body: null });
    await expect(
      downloadArtifact(ws, 'empty.bin', 'https://storage.example/blob/8', { maxBytes: 1024, fetcher })
    ).rejects.toMatchObject({ code: 'EMPTY_BODY', status: 502 });
  });

  it('blocks redirects by default (SSRF) and follows them only when opted in', async () => {
    const ws = await makeWorkspace();
    const captured: CapturedInit[] = [];
    const fetcher: SdkFetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      captured.push({
        url: String(input),
        method: init?.method ?? 'GET',
        headers: {},
        body: init?.body,
        redirect: init?.redirect,
        signal: init?.signal ?? undefined,
      });
      return chunkedResponse(makeChunks(1, 16), { pulled: 0, cancelled: false });
    }) as SdkFetcher;

    await downloadArtifact(ws, 'a.bin', 'https://storage.example/blob/9', { maxBytes: 1024, fetcher });
    await downloadArtifact(ws, 'b.bin', 'https://storage.example/blob/9', {
      maxBytes: 1024,
      allowRedirects: true,
      fetcher,
    });
    expect(captured).toHaveLength(2);
    expect(captured[0]!.redirect).toBe('error');
    expect(captured[1]!.redirect).toBe('follow');
  });

  it.each([
    ['file:///etc/passwd', 'file protocol'],
    ['ftp://storage.example/blob', 'ftp protocol'],
    ['gopher://internal:6379/_INFO', 'gopher protocol'],
    ['not a url', 'unparseable'],
  ])('refuses non-http(s) URL %p (%s) without calling the fetcher', async (url) => {
    const ws = await makeWorkspace();
    let called = false;
    const fetcher: SdkFetcher = async () => {
      called = true;
      return chunkedResponse(makeChunks(1, 16), { pulled: 0, cancelled: false });
    };
    await expect(
      downloadArtifact(ws, 'x.bin', url, { maxBytes: 1024, fetcher })
    ).rejects.toMatchObject({ code: 'INVALID_URL' });
    expect(called).toBe(false);
  });

  it('aborts on a pre-aborted signal and leaves no file', async () => {
    const ws = await makeWorkspace();
    const controller = new AbortController();
    controller.abort();
    const fetcher: SdkFetcher = async (_input, init) => {
      if (init?.signal?.aborted) throw new Error('The operation was aborted');
      return chunkedResponse(makeChunks(1, 16), { pulled: 0, cancelled: false });
    };
    await expect(
      downloadArtifact(ws, 'x.bin', 'https://storage.example/blob/10', {
        maxBytes: 1024,
        signal: controller.signal,
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE' });
    expect(existsSync(ws.filePath('x.bin'))).toBe(false);
  });

  it('aborts a download mid-flight and removes its partial destination', async () => {
    const ws = await makeWorkspace();
    const target = ws.filePath('aborted-mid-flight.bin');
    const outer = new AbortController();
    let capturedSignal: AbortSignal | undefined;
    let cancelled = false;
    let sentFirstChunk = false;
    let notifyPendingPull: (() => void) | undefined;
    const pendingPull = new Promise<void>((resolve) => { notifyPendingPull = resolve; });
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sentFirstChunk) {
          sentFirstChunk = true;
          controller.enqueue(new Uint8Array(4096).fill(0x61));
          return;
        }
        notifyPendingPull?.();
        return new Promise<void>((resolve) => {
          const release = (): void => {
            outer.signal.removeEventListener('abort', release);
            resolve();
          };
          outer.signal.addEventListener('abort', release, { once: true });
        });
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher: SdkFetcher = async (_input, init) => {
      capturedSignal = init?.signal ?? undefined;
      return new Response(body) as unknown as Response;
    };
    const download = downloadArtifact(ws, 'aborted-mid-flight.bin', 'https://storage.example/abort', {
      maxBytes: 1 << 20,
      signal: outer.signal,
      fetcher,
    });

    await pendingPull;
    await settle();
    outer.abort();

    await expect(download).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE', status: 0 });
    expect(capturedSignal?.aborted).toBe(true);
    expect(cancelled).toBe(true);
    expect(existsSync(target)).toBe(false);
  });
});

/* -------------------------------------------------------------------- */
/* downloadArtifactById — ART-01 grant-then-stream ownership             */
/* -------------------------------------------------------------------- */

describe('worker artifact stream helpers (DATA-04)', () => {
  it('aborts a bounded read when the whole-body timeout expires after response headers', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
      },
      cancel() {
        cancelled = true;
      },
    });
    const fetcher: SdkFetcher = async () => new Response(body) as unknown as Response;
    const stream = await openArtifactStream('https://storage.example/slow', {
      maxBytes: 1024,
      timeoutMs: 25,
      fetcher,
    });

    await expect(async () => {
      for await (const _chunk of stream) {
        // Consume until the stalled body is aborted.
      }
    }).rejects.toMatchObject({ code: 'TIMEOUT', status: 408 });
    expect(cancelled).toBe(true);
  });

  it('streams upload bytes with declared-size and SHA-256 verification', async () => {
    const chunks = [Buffer.from('first-'), Buffer.from('second')];
    const expectedBytes = Buffer.concat(chunks);
    let uploaded = Buffer.alloc(0);
    const fetcher: SdkFetcher = async (_input, init) => {
      const body = init?.body as ReadableStream<Uint8Array>;
      uploaded = Buffer.from(await new Response(body).arrayBuffer());
      return new Response(null, { status: 200 }) as unknown as Response;
    };

    const integrity = await uploadArtifactStream(Readable.from(chunks), {
      uploadUrl: 'https://storage.example/upload',
      mimeType: 'application/octet-stream',
      sizeBytes: expectedBytes.byteLength,
      maxBytes: 1024,
      expectedSha256: createHash('sha256').update(expectedBytes).digest('hex'),
      fetcher,
    });

    expect(uploaded.equals(expectedBytes)).toBe(true);
    expect(integrity).toEqual({
      sizeBytes: expectedBytes.byteLength,
      sha256: createHash('sha256').update(expectedBytes).digest('hex'),
    });
  });

  it('rejects a source decoded as text when UTF-8 replacement changes its binary size', async () => {
    const original = Buffer.from([0xff]);
    const source = new Readable({
      read() {
        this.push(original);
        this.push(null);
      },
    });
    source.setEncoding('utf8');
    const fetcher: SdkFetcher = async (_input, init) => {
      const body = init?.body as ReadableStream<Uint8Array>;
      await new Response(body).arrayBuffer();
      return new Response(null, { status: 200 }) as unknown as Response;
    };

    await expect(uploadArtifactStream(source, {
      uploadUrl: 'https://storage.example/upload',
      mimeType: 'application/octet-stream',
      sizeBytes: original.byteLength,
      maxBytes: 16,
      expectedSha256: createHash('sha256').update(original).digest('hex'),
      fetcher,
    })).rejects.toMatchObject({ code: 'SIZE_MISMATCH', status: 422 });
  });

  it('rejects upload size and hash drift before the caller can finalize', async () => {
    const bytes = Buffer.from('verified bytes');
    const fetcher: SdkFetcher = async (_input, init) => {
      const body = init?.body as ReadableStream<Uint8Array>;
      await new Response(body).arrayBuffer();
      return new Response(null, { status: 200 }) as unknown as Response;
    };
    await expect(uploadArtifactStream(Readable.from([bytes]), {
      uploadUrl: 'https://storage.example/upload',
      mimeType: 'application/octet-stream',
      sizeBytes: bytes.byteLength + 1,
      maxBytes: 1024,
      fetcher,
    })).rejects.toMatchObject({ code: 'SIZE_MISMATCH', status: 422 });

    await expect(uploadArtifactStream(Readable.from([bytes]), {
      uploadUrl: 'https://storage.example/upload',
      mimeType: 'application/octet-stream',
      sizeBytes: bytes.byteLength,
      maxBytes: 1024,
      expectedSha256: 'f'.repeat(64),
      fetcher,
    })).rejects.toMatchObject({ code: 'HASH_MISMATCH', status: 422 });
  });

  it('rejects missing, STAGING, and foreign output refs at completion', () => {
    const finalizedId = randomUUID();
    const uncommittedId = randomUUID();
    const finalized = [{ artifactId: finalizedId, role: 'output' }];
    const declared = [{ artifactId: uncommittedId, role: 'output' }];

    expect(() => committedOutputArtifactIds(declared, finalized)).toThrow(
      expect.objectContaining({ code: 'OUTPUT_NOT_COMMITTED', status: 409 })
    );
    expect(() => committedOutputArtifactIds([], [], `artifact://${uncommittedId}`)).toThrow(
      expect.objectContaining({ code: 'OUTPUT_NOT_COMMITTED', status: 409 })
    );
    expect(committedOutputArtifactIds([{ artifactId: finalizedId, role: 'output' }], finalized)).toEqual([
      finalizedId,
    ]);
  });

  it('matches output role, size, and digest to the finalized artifact ref', () => {
    const artifactId = randomUUID();
    const finalized = [{
      artifactId,
      role: 'output',
      sizeBytes: 12,
      hashSha256: 'a'.repeat(64),
    }];

    expect(() => committedOutputArtifactIds([
      { artifactId, role: 'intermediate' },
    ], finalized)).toThrow(expect.objectContaining({ code: 'OUTPUT_NOT_COMMITTED', status: 409 }));
    expect(() => committedOutputArtifactIds([
      { artifactId, role: 'intermediate' },
    ], [{ artifactId, role: 'intermediate' }])).toThrow(
      expect.objectContaining({ code: 'OUTPUT_NOT_COMMITTED', status: 409 })
    );
    expect(() => committedOutputArtifactIds([
      { artifactId, role: 'output', sizeBytes: 13 },
    ], finalized)).toThrow(expect.objectContaining({ code: 'SIZE_MISMATCH', status: 409 }));
    expect(() => committedOutputArtifactIds([
      { artifactId, role: 'output', hashSha256: 'b'.repeat(64) },
    ], finalized)).toThrow(expect.objectContaining({ code: 'HASH_MISMATCH', status: 409 }));
    expect(committedOutputArtifactIds([
      { artifactId, role: 'output', sizeBytes: 12, hashSha256: 'a'.repeat(64) },
    ], finalized)).toEqual([artifactId]);
  });
});

describe('artifact stream consumer backpressure boundary', () => {
  it('bounds upstream pulls while the consumer is paused and resumes without byte loss', async () => {
    const chunks = makeChunks(64, 64 * 1024);
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const stream = await openArtifactStream('https://storage.example/backpressure', {
      maxBytes: totalBytes(chunks),
      expectedSizeBytes: totalBytes(chunks),
      expectedSha256: sha256Of(chunks),
      highWaterMarkBytes: 1024,
      fetcher: (async (_input: string | URL | Request, init?: RequestInit) => {
        captured.signal = init?.signal ?? undefined;
        let i = 0;
        const body = new ReadableStream<Uint8Array>({
          pull(controller) {
            if (i >= chunks.length) {
              controller.close();
              return;
            }
            counter.pulled += 1;
            controller.enqueue(chunks[i++]!);
          },
          cancel() {
            counter.cancelled = true;
          },
        });
        return new Response(body) as unknown as Response;
      }) as SdkFetcher,
    });

    stream.pause();
    for (let i = 0; i < 8; i += 1) await settle();
    expect(counter.pulled).toBeGreaterThan(0);
    expect(counter.pulled).toBeLessThan(chunks.length);

    stream.resume();
    expect(await drain(stream)).toBe(totalBytes(chunks));
    expect(counter.pulled).toBe(chunks.length);
    expect(captured.signal?.aborted).toBe(false);
  });

  it('aborts a failing downstream pipe under backpressure and recovers on a fresh stream', async () => {
    const failedChunks = makeChunks(64, 4096);
    const failedCounter: PullCounter = { pulled: 0, cancelled: false };
    const failedCapture: { signal?: AbortSignal } = {};
    const failedStream = await openArtifactStream('https://storage.example/pipe-failure', {
      maxBytes: totalBytes(failedChunks),
      highWaterMarkBytes: 1024,
      fetcher: (async (_input: string | URL | Request, init?: RequestInit) => {
        failedCapture.signal = init?.signal ?? undefined;
        return chunkedResponse(failedChunks, failedCounter);
      }) as SdkFetcher,
    });
    let notifyWriteStarted!: () => void;
    const writeStarted = new Promise<void>((resolve) => { notifyWriteStarted = resolve; });
    let failWrite!: () => void;
    const failingDestination = new Writable({
      highWaterMark: 1,
      write(_chunk, _encoding, callback) {
        notifyWriteStarted();
        failWrite = () => callback(new Error('downstream pipe failed'));
      },
    });
    const transfer = pipeline(failedStream, failingDestination);

    await writeStarted;
    for (let i = 0; i < 8; i += 1) await settle();
    expect(failedCounter.pulled).toBeGreaterThan(0);
    expect(failedCounter.pulled).toBeLessThan(failedChunks.length);
    failWrite();
    await expect(transfer).rejects.toThrow('downstream pipe failed');
    for (let i = 0; i < 4; i += 1) await settle();
    expect(failedCapture.signal?.aborted).toBe(true);
    expect(failedCounter.cancelled).toBe(true);
    expect(failedCounter.pulled).toBeLessThan(failedChunks.length);

    const retryChunks = makeChunks(5, 32, 0x40);
    const retryCounter: PullCounter = { pulled: 0, cancelled: false };
    const retryStream = await openArtifactStream('https://storage.example/pipe-retry', {
      maxBytes: totalBytes(retryChunks),
      expectedSizeBytes: totalBytes(retryChunks),
      expectedSha256: sha256Of(retryChunks),
      fetcher: async () => chunkedResponse(retryChunks, retryCounter),
    });

    expect(await drain(retryStream)).toBe(totalBytes(retryChunks));
    expect(retryCounter.pulled).toBe(retryChunks.length);
    expect(retryCounter.cancelled).toBe(false);
  });
});

describe('downloadArtifactById (ART-01 tokenized read grant)', () => {
  it('requests a read grant with leaseEpoch fencing, then streams from downloadUrl', async () => {
    const ws = await makeWorkspace();
    const artifactId = randomUUID();
    const chunks = makeChunks(4, 256);
    const captured: CapturedInit[] = [];
    const downloadUrl = 'https://storage.example/presigned/abc';
    const fetcher: SdkFetcher = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      captured.push({
        url,
        method: init?.method ?? 'GET',
        headers: (init?.headers as Record<string, string>) ?? {},
        body: init?.body,
        redirect: init?.redirect,
        signal: init?.signal ?? undefined,
      });
      if (url.endsWith(`/artifacts/${artifactId}/access`)) {
        return jsonResponse(200, {
          artifactId,
          downloadUrl,
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
      }
      return chunkedResponse(chunks, { pulled: 0, cancelled: false });
    }) as SdkFetcher;

    const out = await downloadArtifactById(
      { taskId: TASK_ID, leaseEpoch: 9 },
      artifactId,
      ws,
      'granted.bin',
      { runtimeBaseUrl: RUNTIME, runtimeToken: TOKEN, maxBytes: 1 << 20, fetcher }
    );

    expect(out.sha256).toBe(sha256Of(chunks));
    expect(out.sizeBytes).toBe(totalBytes(chunks));

    // Grant call: correct URL, method, fencing body, bearer auth.
    const grantCall = captured.find((c) => c.method === 'POST')!;
    expect(grantCall.url).toBe(`${RUNTIME}/artifacts/${artifactId}/access`);
    expect(grantCall.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(String(grantCall.body))).toEqual({
      taskId: TASK_ID,
      leaseEpoch: 9,
      mode: 'read',
    });
    // Download call goes to the presigned URL, redirects blocked.
    const dlCall = captured.find((c) => c.method === 'GET')!;
    expect(dlCall.url).toBe(downloadUrl);
    expect(dlCall.redirect).toBe('error');
  });

  it('surfaces a grant rejection (409 lease lost) as GRANT_REJECTED', async () => {
    const ws = await makeWorkspace();
    const fetcher: SdkFetcher = async () =>
      jsonResponse(409, {
        type: 'urn:du:error:lease_lost',
        status: 409,
        code: 'LEASE_LOST',
        title: 'lease lost',
        detail: 'epoch fenced',
      });
    await expect(
      downloadArtifactById({ taskId: TASK_ID, leaseEpoch: 1 }, randomUUID(), ws, 'x.bin', {
        runtimeBaseUrl: RUNTIME,
        runtimeToken: TOKEN,
        maxBytes: 1024,
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'GRANT_REJECTED', status: 409, message: 'epoch fenced' });
  });

  it('does not fetch storage bytes when runtime denies an unauthorized artifact reference', async () => {
    const ws = await makeWorkspace();
    const calls: { url: string; method: string; body?: string }[] = [];
    const fetcher: SdkFetcher = async (input, init) => {
      calls.push({
        url: String(input),
        method: init?.method ?? 'GET',
        body: typeof init?.body === 'string' ? init.body : undefined,
      });
      return jsonResponse(403, {
        code: 'PERMISSION_DENIED',
        detail: 'artifact is not in this operation or an authorized reference',
      });
    };

    await expect(
      downloadArtifactById({ taskId: TASK_ID, leaseEpoch: 9 }, randomUUID(), ws, 'denied.bin', {
        runtimeBaseUrl: RUNTIME,
        runtimeToken: TOKEN,
        maxBytes: 1024,
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'GRANT_REJECTED', status: 403 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(JSON.parse(calls[0]!.body ?? '{}')).toEqual({
      taskId: TASK_ID,
      leaseEpoch: 9,
      mode: 'read',
    });
    expect(existsSync(ws.filePath('denied.bin'))).toBe(false);
  });

  it('rejects a grant without downloadUrl as GRANT_REJECTED', async () => {
    const ws = await makeWorkspace();
    const fetcher: SdkFetcher = async () =>
      jsonResponse(200, { artifactId: randomUUID(), expiresAt: new Date().toISOString() });
    await expect(
      downloadArtifactById({ taskId: TASK_ID, leaseEpoch: 1 }, randomUUID(), ws, 'x.bin', {
        runtimeBaseUrl: RUNTIME,
        runtimeToken: TOKEN,
        maxBytes: 1024,
        fetcher,
      })
    ).rejects.toMatchObject({ code: 'GRANT_REJECTED', status: 502 });
  });
});

/* -------------------------------------------------------------------- */
/* withDownloadedArtifact — scoped file lifetime                          */
/* -------------------------------------------------------------------- */

describe('withDownloadedArtifact (bounded file lifetime scope)', () => {
  async function download(ws: TempWorkspace, name: string): Promise<DownloadedArtifact> {
    const fetcher: SdkFetcher = async () =>
      chunkedResponse(makeChunks(2, 64), { pulled: 0, cancelled: false });
    return downloadArtifact(ws, name, 'https://storage.example/blob/w', { maxBytes: 1024, fetcher });
  }

  it('keeps the file during fn and deletes it after success', async () => {
    const ws = await makeWorkspace();
    const artifact = await download(ws, 'scoped-ok.bin');
    let sawFile = false;
    const result = await withDownloadedArtifact(artifact, async (a) => {
      sawFile = existsSync(a.path);
      return 'done';
    });
    expect(result).toBe('done');
    expect(sawFile).toBe(true);
    expect(existsSync(artifact.path)).toBe(false);
  });

  it('deletes the file even when fn throws, and propagates the error', async () => {
    const ws = await makeWorkspace();
    const artifact = await download(ws, 'scoped-err.bin');
    await expect(
      withDownloadedArtifact(artifact, async () => {
        throw new Error('parse failed');
      })
    ).rejects.toThrow('parse failed');
    expect(existsSync(artifact.path)).toBe(false);
  });
});

/* -------------------------------------------------------------------- */
/* sweepStaleWorkspaces — ART-02 crash recovery                          */
/* -------------------------------------------------------------------- */

describe('sweepStaleWorkspaces (crash-recovery temp sweep)', () => {
  it('removes only stale du-worker-* dirs; keeps fresh and foreign entries', async () => {
    const { mkdir, writeFile } = await import('node:fs/promises');
    // W46-Q2-3 (ART-02 guard): the stale case must be a crashed-worker ORPHAN —
    // a planted dir on disk. A live createTempWorkspace dir of THIS process is
    // now deliberately kept regardless of TTL (see artifact-sweep-guard.test.ts).
    const staleDir = join(testRoot, `${TEMP_WORKSPACE_PREFIX}stale-task-orphan`);
    await mkdir(staleDir, { recursive: true });
    await writeFile(join(staleDir, 'leftover.bin'), 'crashed worker bytes', 'utf8');
    const freshWs = await createTempWorkspace('fresh-task', { rootDir: testRoot });
    const foreignDir = join(testRoot, 'other-app-temp');
    await mkdir(foreignDir, { recursive: true });
    const staleFile = join(testRoot, `${TEMP_WORKSPACE_PREFIX}not-a-dir`);
    await writeFile(staleFile, 'x', 'utf8');

    const old = new Date(Date.now() - (DEFAULT_STALE_WORKSPACE_MS + 60_000));
    await touchWorkspaceMtime(staleDir, old);
    await touchWorkspaceMtime(foreignDir, old);
    await touchWorkspaceMtime(staleFile, old);

    const result = await sweepStaleWorkspaces({ rootDir: testRoot });

    expect(result.removed).toContain(staleDir);
    expect(result.kept).toContain(freshWs.dir);
    expect(existsSync(staleDir)).toBe(false);
    expect(existsSync(freshWs.dir)).toBe(true);
    // Foreign entries are never touched, even when stale.
    expect(existsSync(foreignDir)).toBe(true);
    // A prefix-matching FILE (not a dir) is kept — the sweep only removes dirs.
    expect(existsSync(staleFile)).toBe(true);

    await rm(foreignDir, { recursive: true, force: true });
    await rm(staleFile, { force: true });
    workspaces.push(freshWs);
  });

  it('keeps everything when nothing exceeds the TTL', async () => {
    const ws = await makeWorkspace();
    const result = await sweepStaleWorkspaces({ rootDir: testRoot });
    expect(result.removed).toHaveLength(0);
    expect(result.kept).toContain(ws.dir);
  });

  it('returns empty result when the root does not exist', async () => {
    const result = await sweepStaleWorkspaces({ rootDir: join(testRoot, 'missing-root') });
    expect(result).toEqual({ removed: [], kept: [] });
  });
});

/* -------------------------------------------------------------------- */
/* Cross-task isolation (ART-02: task giữ ref, không leak chéo)          */
/* -------------------------------------------------------------------- */

describe('cross-task isolation', () => {
  it('two tasks never share workspace paths for the same file name', async () => {
    const wsA = await makeWorkspace(randomUUID());
    const wsB = await makeWorkspace(randomUUID());
    expect(wsA.filePath('output.md')).not.toBe(wsB.filePath('output.md'));

    const fetcher: SdkFetcher = async () =>
      chunkedResponse(makeChunks(2, 32), { pulled: 0, cancelled: false });
    const a = await downloadArtifact(wsA, 'output.md', 'https://storage.example/a', { maxBytes: 1024, fetcher });
    const b = await downloadArtifact(wsB, 'output.md', 'https://storage.example/b', { maxBytes: 1024, fetcher });
    expect(a.path).not.toBe(b.path);
    expect(existsSync(a.path)).toBe(true);
    expect(existsSync(b.path)).toBe(true);

    // Disposing A does not affect B (bounded lifetime is per-task).
    await wsA.dispose();
    expect(existsSync(a.path)).toBe(false);
    expect(existsSync(b.path)).toBe(true);
  });
});

/* -------------------------------------------------------------------- */
/* Bounded-memory proof at scale                                         */
/* -------------------------------------------------------------------- */

describe('bounded memory at scale', () => {
  it('streams 256 x 32KiB (8MiB) without exceeding maxBytes and with exact hash', async () => {
    const ws = await makeWorkspace();
    const chunks = makeChunks(256, 32 * 1024);
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const fetcher: SdkFetcher = async () => chunkedResponse(chunks, counter);

    const out = await downloadArtifact(ws, 'large.bin', 'https://storage.example/large', {
      maxBytes: 8 * 1024 * 1024,
      expectedSha256: sha256Of(chunks),
      expectedSizeBytes: totalBytes(chunks),
      fetcher,
    });
    expect(out.sizeBytes).toBe(8 * 1024 * 1024);
    expect(counter.pulled).toBe(256);
    const st = await stat(out.path);
    expect(st.size).toBe(8 * 1024 * 1024);
  });

  it('lists only expected entries in the workspace root after downloads', async () => {
    const ws = await makeWorkspace();
    const fetcher: SdkFetcher = async () =>
      chunkedResponse(makeChunks(1, 8), { pulled: 0, cancelled: false });
    await downloadArtifact(ws, 'one.bin', 'https://storage.example/1', { maxBytes: 64, fetcher });
    await downloadArtifact(ws, 'two.bin', 'https://storage.example/2', { maxBytes: 64, fetcher });
    const entries = (await readdir(ws.dir)).sort();
    expect(entries).toEqual(['one.bin', 'two.bin']);
  });
});
