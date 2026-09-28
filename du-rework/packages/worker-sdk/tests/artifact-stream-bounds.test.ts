import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { openArtifactStream, type SdkFetcher } from '../src';

/**
 * W-DATA04-STREAM-BOUNDS-1 — read-side streaming bounds (DATA-04).
 *
 * Pins, at the `openArtifactStream` seam that `ctx.readStream`/
 * `ctx.read`/`readWithMetadata` all funnel through:
 *
 * 1. EXPLICIT highWaterMark: the returned stream carries a real Node buffer
 *    bound (64 KiB default), an accepted explicit value, and fail-closed
 *    refusal of anything outside [1 byte, 1 MiB] BEFORE the network is
 *    touched.
 * 2. BYTE-LIMIT watchdog: a Content-Length pre-check stops oversized
 *    declared bodies before any drain, and the mid-stream counter trips
 *    `TOO_LARGE` while the source is still pulling — proving memory stays
 *    bounded regardless of source size (pull counting = the boundedness
 *    witness, zero sockets per the Δ8 measurement lesson).
 * 3. ABORT PROPAGATION: the request scope handed to fetch is aborted the
 *    moment the caller signal fires mid-body; a pre-aborted signal never
 *    transfers bytes; and — the product change of this packet — a consumer
 *    that ABANDONS the returned stream mid-body (for-await break) aborts
 *    the underlying request scope, so the wire stops instead of draining
 *    toward a dead pipe. A naturally drained stream must NOT abort.
 */

interface PullCounter {
  pulled: number;
  cancelled: boolean;
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

/**
 * Mock fetcher factory: returns the body as a pull-counted ReadableStream
 * (so "the source stopped early" is measurable) and captures the RequestInit
 * signal handed to fetch (so "the abort reached the wire" is measurable).
 */
function mockFetcher(
  chunks: Uint8Array[],
  counter: PullCounter,
  captured: { signal?: AbortSignal },
  opts: { headers?: Record<string, string>; rejectIfAborted?: boolean } = {}
): SdkFetcher {
  return (async (_input: string | URL | Request, init?: RequestInit) => {
    captured.signal = init?.signal ?? undefined;
    if (opts.rejectIfAborted && init?.signal?.aborted) {
      throw new Error('The operation was aborted');
    }
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i >= chunks.length) {
          controller.close();
          return;
        }
        counter.pulled++;
        controller.enqueue(chunks[i++]!);
      },
      cancel() {
        counter.cancelled = true;
      },
    });
    return new Response(stream, { status: 200, headers: opts.headers }) as unknown as Response;
  }) as SdkFetcher;
}

const URL_OK = 'https://storage.example/bounded/1';

async function drain(stream: Readable): Promise<number> {
  let bytes = 0;
  for await (const chunk of stream) bytes += (chunk as Buffer).length;
  return bytes;
}

const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/* ------------------------------------------------------------------ */
/* 1. explicit highWaterMark                                            */
/* ------------------------------------------------------------------ */

describe('openArtifactStream explicit stream buffer bounds (DATA-04)', () => {
  const chunks = makeChunks(4, 512);

  it('applies the explicit 64 KiB default highWaterMark to the returned stream', async () => {
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const stream = await openArtifactStream(URL_OK, {
      maxBytes: 1 << 20,
      fetcher: mockFetcher(chunks, counter, captured),
    });
    expect(stream.readableHighWaterMark).toBe(64 * 1024);
    expect(await drain(stream)).toBe(totalBytes(chunks));
  });

  it.each([1, 1024, 16 * 1024, 64 * 1024, 1024 * 1024])(
    'honors an explicit highWaterMarkBytes of %p bytes (within the 1 MiB cap)',
    async (hwm) => {
      const counter: PullCounter = { pulled: 0, cancelled: false };
      const captured: { signal?: AbortSignal } = {};
      const stream = await openArtifactStream(URL_OK, {
        maxBytes: 1 << 20,
        highWaterMarkBytes: hwm,
        fetcher: mockFetcher(chunks, counter, captured),
      });
      expect(stream.readableHighWaterMark).toBe(hwm);
      expect(await drain(stream)).toBe(totalBytes(chunks));
    }
  );

  it.each([
    [0, 'zero'],
    [-1, 'negative'],
    [1024 * 1024 + 1, 'past the 1 MiB cap'],
    [1.5, 'fractional'],
    [Number.NaN, 'NaN'],
    [Number.MAX_SAFE_INTEGER + 1, 'unsafe integer'],
  ])('refuses a highWaterMarkBytes that is %p (%s) before touching the network', async (hwm) => {
    let called = false;
    const fetcher: SdkFetcher = async () => {
      called = true;
      return new Response(null) as unknown as Response;
    };
    await expect(
      openArtifactStream(URL_OK, { maxBytes: 1 << 20, highWaterMarkBytes: hwm as number, fetcher })
    ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 0 });
    expect(called).toBe(false);
  });

  it.each([
    [-1, 'negative'],
    [1.5, 'fractional'],
    [Number.NaN, 'NaN'],
    [Number.POSITIVE_INFINITY, 'infinite'],
    [Number.MAX_SAFE_INTEGER + 1, 'past safe-integer'],
  ])('refuses a maxBytes that is %p (%s) before touching the network', async (maxBytes) => {
    let called = false;
    const fetcher: SdkFetcher = async () => {
      called = true;
      return new Response(null) as unknown as Response;
    };
    await expect(
      openArtifactStream(URL_OK, { maxBytes: maxBytes as number, fetcher })
    ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 0 });
    expect(called).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* 2. byte-limit watchdog                                               */
/* ------------------------------------------------------------------ */

describe('openArtifactStream byte-limit watchdog (DATA-04)', () => {
  it('rejects a declared content-length above maxBytes before the body drains', async () => {
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    await expect(
      openArtifactStream(URL_OK, {
        maxBytes: 1024,
        fetcher: mockFetcher(makeChunks(8, 1024), counter, captured, {
          headers: { 'content-length': String(8 * 1024 * 1024) },
        }),
      })
    ).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
    // The declared body was cancelled, not drained: at most the one read-ahead
    // undici may take while constructing the Response reached the pipe.
    expect(counter.cancelled).toBe(true);
    expect(counter.pulled).toBeLessThanOrEqual(1);
  });

  it('rejects a declared content-length that conflicts with expectedSizeBytes before the body drains', async () => {
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    await expect(
      openArtifactStream(URL_OK, {
        maxBytes: 1 << 20,
        expectedSizeBytes: 4096,
        fetcher: mockFetcher(makeChunks(8, 1024), counter, captured, {
          headers: { 'content-length': '8192' },
        }),
      })
    ).rejects.toMatchObject({ code: 'SIZE_MISMATCH', status: 422 });
    expect(counter.cancelled).toBe(true);
    expect(counter.pulled).toBeLessThanOrEqual(1);
  });

  it('trips the mid-stream watchdog at maxBytes and stops pulling the source', async () => {
    const chunks = makeChunks(100, 1024); // 100 KiB of hostile body
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const stream = await openArtifactStream(URL_OK, {
      maxBytes: 2500,
      fetcher: mockFetcher(chunks, counter, captured),
    });
    await expect(async () => {
      await drain(stream);
    }).rejects.toMatchObject({ code: 'TOO_LARGE', status: 413 });
    // Bounded-memory witness: the watchdog tripped at 2500 bytes; a full
    // drain would have pulled all 100 chunks.
    expect(counter.pulled).toBeLessThan(100);
    expect(counter.cancelled).toBe(true);
  });

  it('fails a body that ends short of expectedSizeBytes as SIZE_MISMATCH at end of stream', async () => {
    const chunks = makeChunks(3, 100);
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const stream = await openArtifactStream(URL_OK, {
      maxBytes: 1 << 20,
      expectedSizeBytes: totalBytes(chunks) + 1,
      fetcher: mockFetcher(chunks, counter, captured),
    });
    await expect(async () => {
      await drain(stream);
    }).rejects.toMatchObject({ code: 'SIZE_MISMATCH', status: 422 });
  });

  it('fails digest drift as HASH_MISMATCH before reporting success', async () => {
    const chunks = makeChunks(4, 256);
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const stream = await openArtifactStream(URL_OK, {
      maxBytes: 1 << 20,
      expectedSha256: 'f'.repeat(64),
      fetcher: mockFetcher(chunks, counter, captured),
    });
    await expect(async () => {
      await drain(stream);
    }).rejects.toMatchObject({ code: 'HASH_MISMATCH', status: 422 });
  });

  it('streams a fully verified bounded read with every chunk pulled exactly once', async () => {
    const chunks = makeChunks(32, 1024);
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const stream = await openArtifactStream(URL_OK, {
      maxBytes: 1 << 20,
      expectedSha256: sha256Of(chunks),
      expectedSizeBytes: totalBytes(chunks),
      fetcher: mockFetcher(chunks, counter, captured),
    });
    expect(await drain(stream)).toBe(totalBytes(chunks));
    expect(counter.pulled).toBe(32);
  });
});

/* ------------------------------------------------------------------ */
/* 3. abort propagation to the underlying fetch/stream                  */
/* ------------------------------------------------------------------ */

describe('openArtifactStream abort propagation (DATA-04)', () => {
  it('aborts the fetch signal the moment the caller aborts mid-body', async () => {
    const chunks = makeChunks(50, 1024);
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const outer = new AbortController();
    const stream = await openArtifactStream(URL_OK, {
      maxBytes: 1 << 20,
      signal: outer.signal,
      fetcher: mockFetcher(chunks, counter, captured),
    });
    let saw = 0;
    await expect(async () => {
      for await (const _chunk of stream) {
        saw += 1;
        outer.abort();
      }
    }).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE', status: 0 });
    expect(saw).toBeLessThan(50);
    // The abort reached the WIRE: the very signal handed to fetch is aborted
    // and the underlying body stream was cancelled, not drained.
    expect(captured.signal?.aborted).toBe(true);
    expect(counter.cancelled).toBe(true);
    expect(counter.pulled).toBeLessThan(50);
  });

  it('never transfers bytes when the caller signal is already aborted at open', async () => {
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const outer = new AbortController();
    outer.abort();
    await expect(
      openArtifactStream(URL_OK, {
        maxBytes: 1 << 20,
        signal: outer.signal,
        fetcher: mockFetcher(makeChunks(4, 16), counter, captured, { rejectIfAborted: true }),
      })
    ).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE', status: 0 });
    expect(captured.signal?.aborted).toBe(true);
  });

  it('aborts the underlying request scope when the consumer abandons the stream mid-body', async () => {
    // W-DATA04-STREAM-BOUNDS-1 product pin: a for-await `break` (or any early
    // destroy) must cancel the FETCH, not just the local pipe — otherwise the
    // wire keeps draining toward a dead consumer until the whole-body timeout.
    const chunks = makeChunks(50, 1024);
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const stream = await openArtifactStream(URL_OK, {
      maxBytes: 1 << 20,
      fetcher: mockFetcher(chunks, counter, captured),
    });
    for await (const _chunk of stream) {
      break;
    }
    for (let i = 0; i < 4; i += 1) await settle();
    expect(captured.signal?.aborted).toBe(true);
    expect(counter.cancelled).toBe(true);
    expect(counter.pulled).toBeLessThan(50);
  });

  it('does NOT abort the request scope after a natural full drain', async () => {
    const chunks = makeChunks(16, 1024);
    const counter: PullCounter = { pulled: 0, cancelled: false };
    const captured: { signal?: AbortSignal } = {};
    const stream = await openArtifactStream(URL_OK, {
      maxBytes: 1 << 20,
      fetcher: mockFetcher(chunks, counter, captured),
    });
    expect(await drain(stream)).toBe(totalBytes(chunks));
    for (let i = 0; i < 4; i += 1) await settle();
    expect(captured.signal?.aborted).toBe(false);
    expect(counter.pulled).toBe(16);
  });
});
