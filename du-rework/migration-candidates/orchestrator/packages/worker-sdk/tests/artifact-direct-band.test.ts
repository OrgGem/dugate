import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { MULTIPART_MAX_TOTAL_BYTES, MULTIPART_MIN_TOTAL_BYTES } from '@du/contracts';
import {
  ARTIFACT_UPLOAD_WIRE_MAX_BYTES,
  ArtifactStreamError,
  DIRECT_ARTIFACT_MAX_BYTES,
  INLINE_ARTIFACT_MAX_BYTES,
  resolveArtifactUploadBand,
  uploadArtifactStream,
} from '../src/artifact-streams';
import { uploadArtifactMultipart } from '../src/artifact-multipart';
import type { MultipartUploadTransport } from '../src/artifact-multipart';
import type { SdkFetcher } from '../src/fan-out';
import { BoundaryListener } from '../../../tests/harness/network-boundaries/mock-listener';
import { listenLoopback } from '../../../tests/harness/listen-loopback';

/**
 * DATA-04 (packet W-DATA04-STREAM-1): the 1 MiB - 64 MiB upload band that
 * Reviewer finding T20-D1 called a hole - the multipart contract starts at
 * 64 MiB + 1 and JSON ingress caps at 1 MiB, so nothing on the wire could
 * carry a 5 MiB document.
 *
 * Three evidence layers, all offline:
 *  1. POLICY (zero sockets): the band edges are DERIVED from the DATA-00-M
     wire constants, partition [0, wire ceiling] with no gap and no overlap,
     and fail closed on an unusable or over-ceiling size - including the
     multipart engine, which now refuses a past-ceiling geometry before init.
 *  2. WIRE (real 127.0.0.1 listener on the Windows quiet band): a band
     artifact is ONE streaming PUT carrying an exact content-length - no
     init/part/complete round trips, no per-part ledger - and the whole
     request stays timeout/abort fenced and fail-closed on a lying source, a
     digest mismatch or a storage refusal.
 *  3. RSS (zero sockets, the W-DATA04-RSS-1 convention): the loopback server
     shares this process, so its own HTTP parsing would be charged to the
     measurement; the memory witness therefore drives the stream through a
     draining fetcher and asserts peak marginal external memory, live memory
     after the transfer, and a non-ramping trajectory. Whole-object
     retention fails all three.
 *
 * globalThis.fetch is NEVER monkeypatched: real fetch reaches production only
 * through the declared fetcher seam; listeners are the oracle.
 */

jest.setTimeout(300_000);

const KiB = 1024;
const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const realFetch: SdkFetcher = (...args: Parameters<SdkFetcher>) => globalThis.fetch(...args);

/* Windows excluded-port-range filtering makes fresh ephemeral ports fail with
 * ETIMEDOUT (CYCLE-102 lesson); the repo convention is a per-pid quiet band. */
const QUIET_PORT_BASE = 46_400 + (process.pid % 8) * 16;
let portOffset = 0;
const listeners: BoundaryListener[] = [];
async function startListener(): Promise<BoundaryListener> {
  const listener = await BoundaryListener.start(QUIET_PORT_BASE + portOffset++);
  listeners.push(listener);
  return listener;
}
afterAll(async () => {
  await Promise.all(listeners.map((l) => l.stop()));
});

async function startMidUploadResetServer(): Promise<{
  url: string;
  receivedBytes: () => number;
  stop: () => Promise<void>;
}> {
  let received = 0;
  const server = createServer((req) => {
    req.on('data', (chunk: Buffer | string) => {
      received += typeof chunk === 'string' ? Buffer.byteLength(chunk) : chunk.byteLength;
      if (received >= 64 * KiB) req.socket.destroy();
    });
    req.on('error', () => undefined);
  });
  const port = await listenLoopback(server, QUIET_PORT_BASE + portOffset++);
  return {
    url: `http://127.0.0.1:${port}/direct-upload`,
    receivedBytes: () => received,
    stop: () => new Promise<void>((resolve, reject) => {
      server.close((err) => err ? reject(err) : resolve());
    }),
  };
}

/* ---------------- deterministic pattern (never materialized) -------- */

function patternByte(i: number): number {
  return (i * 31 + 7) % 251;
}

function patternSlice(start: number, len: number): Buffer {
  const b = Buffer.alloc(len);
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

/* ---------------- helpers ------------------------------------------- */

/** A fetcher that consumes the request body and counts what the wire carried. */
function drainingFetcher(): { fetcher: SdkFetcher; consumed: () => number } {
  let bytes = 0;
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body as ReadableStream<Uint8Array> | undefined;
    if (!body) throw new Error('upload carried no body stream');
    const reader = body.getReader();
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      bytes += next.value.byteLength;
    }
    return new Response(null, { status: 200, headers: { etag: '"drained"' } });
  }) as SdkFetcher;
  return { fetcher, consumed: () => bytes };
}

/** A multipart transport that records every lifecycle call it receives. */
function countingTransport(): { transport: MultipartUploadTransport; calls: string[] } {
  const calls: string[] = [];
  const unreachable = (name: string) => async (): Promise<never> => {
    calls.push(name);
    throw new Error('multipart transport must not be reached');
  };
  return {
    transport: {
      init: unreachable('init'),
      partGrant: unreachable('partGrant'),
      complete: unreachable('complete'),
      abort: unreachable('abort'),
    } as unknown as MultipartUploadTransport,
    calls,
  };
}

function expectStreamError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error('expected ArtifactStreamError ' + status + '/' + code);
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(ArtifactStreamError);
      const typed = err as ArtifactStreamError;
      expect([typed.status, typed.code]).toEqual([status, code]);
    }
  );
}

describe('upload size band policy (T20-D1, zero sockets)', () => {
  it('derives every edge from the DATA-00-M wire constants', () => {
    expect(INLINE_ARTIFACT_MAX_BYTES).toBe(MiB);
    expect(DIRECT_ARTIFACT_MAX_BYTES).toBe(MULTIPART_MIN_TOTAL_BYTES - 1);
    expect(DIRECT_ARTIFACT_MAX_BYTES).toBe(64 * MiB);
    expect(ARTIFACT_UPLOAD_WIRE_MAX_BYTES).toBe(MULTIPART_MAX_TOTAL_BYTES);
    expect(ARTIFACT_UPLOAD_WIRE_MAX_BYTES).toBe(8 * GiB);
  });

  it('partitions every size in [0, wire ceiling] into exactly one band', () => {
    const sizes = [
      0,
      1,
      INLINE_ARTIFACT_MAX_BYTES - 1,
      INLINE_ARTIFACT_MAX_BYTES,
      INLINE_ARTIFACT_MAX_BYTES + 1,
      5 * MiB,
      DIRECT_ARTIFACT_MAX_BYTES - 1,
      DIRECT_ARTIFACT_MAX_BYTES,
      DIRECT_ARTIFACT_MAX_BYTES + 1,
      MULTIPART_MAX_TOTAL_BYTES - 1,
      MULTIPART_MAX_TOTAL_BYTES,
    ];
    expect(sizes.map((n) => resolveArtifactUploadBand(n))).toEqual([
      'inline',
      'inline',
      'inline',
      'inline',
      'direct',
      'direct',
      'direct',
      'direct',
      'multipart',
      'multipart',
      'multipart',
    ]);
    // Contiguity: the direct band ends exactly one byte below the contract floor.
    expect(DIRECT_ARTIFACT_MAX_BYTES + 1).toBe(MULTIPART_MIN_TOTAL_BYTES);
  });

  it.each([
    [DIRECT_ARTIFACT_MAX_BYTES - 1, 'direct'],
    [DIRECT_ARTIFACT_MAX_BYTES, 'direct'],
    [DIRECT_ARTIFACT_MAX_BYTES + 1, 'multipart'],
  ] as const)('selects the expected upload band at the 64 MiB edge (%i)', (sizeBytes, band) => {
    expect(resolveArtifactUploadBand(sizeBytes)).toBe(band);
  });

  it.each([MULTIPART_MAX_TOTAL_BYTES + 1, Number.MAX_SAFE_INTEGER])(
    'fails closed on a safe-integer size past the wire ceiling (%i)',
    (sizeBytes) => {
      let caught: ArtifactStreamError | null = null;
      try {
        resolveArtifactUploadBand(sizeBytes);
      } catch (err) {
        caught = err as ArtifactStreamError;
      }
      expect(caught).toBeInstanceOf(ArtifactStreamError);
      expect([caught?.status, caught?.code]).toEqual([413, 'TOO_LARGE']);
    },
  );

  it('rejects infinite declarations as malformed upload-band boundaries', () => {
    for (const sizeBytes of [Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY]) {
      let caught: ArtifactStreamError | null = null;
      try {
        resolveArtifactUploadBand(sizeBytes);
      } catch (err) {
        caught = err as ArtifactStreamError;
      }
      expect([caught?.status, caught?.code]).toEqual([422, 'SIZE_MISMATCH']);
    }
  });

  it('fails closed on an unusable declaration', () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 2, Number.POSITIVE_INFINITY]) {
      let caught: ArtifactStreamError | null = null;
      try {
        resolveArtifactUploadBand(bad);
      } catch (err) {
        caught = err as ArtifactStreamError;
      }
      expect([String(bad), caught?.status, caught?.code]).toEqual([String(bad), 422, 'SIZE_MISMATCH']);
    }
  });

  it('multipart engine refuses a size past the wire ceiling before init', async () => {
    const { transport, calls } = countingTransport();
    await expectStreamError(
      uploadArtifactMultipart(patternSource(1, KiB), {
        transport,
        fileName: 'too-big.bin',
        mimeType: 'application/octet-stream',
        sizeBytes: MULTIPART_MAX_TOTAL_BYTES + 1,
      }),
      413,
      'TOO_LARGE'
    );
    expect(calls).toEqual([]);
  });

  it.each([0, -1, 1.5, MiB + 1])(
    'rejects invalid stream chunk/buffer sizing %p before reading or connecting',
    async (highWaterMarkBytes) => {
      let sourceRead = false;
      let fetchCalled = false;
      const source = new Readable({
        read() {
          sourceRead = true;
          this.push(null);
        },
      });
      const fetcher: SdkFetcher = async () => {
        fetchCalled = true;
        return new Response(null, { status: 200 });
      };

      await expectStreamError(
        uploadArtifactStream(source, {
          uploadUrl: 'https://storage.invalid/grant',
          mimeType: 'application/octet-stream',
          sizeBytes: INLINE_ARTIFACT_MAX_BYTES + 1,
          maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
          highWaterMarkBytes,
          fetcher,
        }),
        0,
        'TOO_LARGE',
      );
      expect(sourceRead).toBe(false);
      expect(fetchCalled).toBe(false);
    },
  );
});

describe('direct band on the wire (real loopback, quiet band)', () => {
  it('carries a 1 MiB + 1 artifact in a single PUT with an exact content-length', async () => {
    const sizeBytes = INLINE_ARTIFACT_MAX_BYTES + 1;
    const listener = await startListener();
    listener.setDefault({ kind: 'respond', status: 200, headers: { etag: '"direct-1"' } });

    const integrity = await uploadArtifactStream(patternSource(sizeBytes, 64 * KiB), {
      uploadUrl: listener.url('/grant?sig=secret-grant-token'),
      mimeType: 'application/pdf',
      sizeBytes,
      maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
      expectedSha256: patternDigest(0, sizeBytes),
      fetcher: realFetch,
    });

    expect(integrity).toEqual({ sizeBytes, sha256: patternDigest(0, sizeBytes) });
    expect(listener.requests).toBe(1);
    const record = listener.recordedRequests[0];
    expect(record?.method).toBe('PUT');
    expect(record?.bodyBytes).toBe(sizeBytes);
    expect(record?.headers['content-length']).toBe(String(sizeBytes));
    expect(record?.headers['content-type']).toBe('application/pdf');
    expect(record?.headers['content-range']).toBeUndefined();
    expect(record?.headers.range).toBeUndefined();
  });

  it.each([500, 503])('never reports storage HTTP %i as a committed artifact', async (status) => {
    const sizeBytes = INLINE_ARTIFACT_MAX_BYTES + 1;
    const listener = await startListener();
    listener.setDefault({ kind: 'respond', status, body: 'storage refused the object' });

    await expectStreamError(
      uploadArtifactStream(patternSource(sizeBytes, 64 * KiB), {
        uploadUrl: listener.url('/grant'),
        mimeType: 'application/octet-stream',
        sizeBytes,
        maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
        fetcher: realFetch,
      }),
      status,
      'DOWNLOAD_REJECTED'
    );
    expect(listener.recordedRequests[0]?.bodyBytes).toBe(sizeBytes);
  });

  it('bounds the wait when the storage peer never answers', async () => {
    const sizeBytes = INLINE_ARTIFACT_MAX_BYTES + 1;
    const listener = await startListener();
    listener.setDefault({ kind: 'hangForever' });

    await expectStreamError(
      uploadArtifactStream(patternSource(sizeBytes, 64 * KiB), {
        uploadUrl: listener.url('/grant'),
        mimeType: 'application/octet-stream',
        sizeBytes,
        maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
        timeoutMs: 150,
        fetcher: realFetch,
      }),
      408,
      'TIMEOUT'
    );
  });

  it('maps a real peer socket reset after partial direct-band bytes to transport failure', async () => {
    const sizeBytes = DIRECT_ARTIFACT_MAX_BYTES;
    const peer = await startMidUploadResetServer();
    try {
      await expectStreamError(
        uploadArtifactStream(patternSource(sizeBytes, 64 * KiB), {
          uploadUrl: peer.url,
          mimeType: 'application/octet-stream',
          sizeBytes,
          maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
          fetcher: realFetch,
        }),
        0,
        'TRANSPORT_FAILURE'
      );
      expect(peer.receivedBytes()).toBeGreaterThanOrEqual(64 * KiB);
      expect(peer.receivedBytes()).toBeLessThan(sizeBytes);
    } finally {
      await peer.stop();
    }
  });
});

describe('direct band fail-closed on a lying or tampered source (zero sockets)', () => {
  it.each([-1, 1.5])('rejects invalid declared size %p before pulling or connecting', async (sizeBytes) => {
    let sourceRead = false;
    let fetchCalled = false;
    const source = new Readable({
      read() {
        sourceRead = true;
        this.push(null);
      },
    });
    const fetcher: SdkFetcher = async () => {
      fetchCalled = true;
      return new Response(null, { status: 200 });
    };

    await expectStreamError(
      uploadArtifactStream(source, {
        uploadUrl: 'https://storage.invalid/grant',
        mimeType: 'application/octet-stream',
        sizeBytes,
        maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
        fetcher,
      }),
      422,
      'SIZE_MISMATCH'
    );
    expect(sourceRead).toBe(false);
    expect(fetchCalled).toBe(false);
  });

  it('never puts the over-declared bytes on the wire', async () => {
    const sizeBytes = INLINE_ARTIFACT_MAX_BYTES + 1;
    const { fetcher, consumed } = drainingFetcher();

    await expectStreamError(
      uploadArtifactStream(patternSource(sizeBytes + 4096, 64 * KiB), {
        uploadUrl: 'https://storage.invalid/grant',
        mimeType: 'application/octet-stream',
        sizeBytes,
        maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
        fetcher,
      }),
      422,
      'SIZE_MISMATCH'
    );
    // The client refuses before the surplus can travel: whatever the wire
    // carried is at most the declared size, never sizeBytes + surplus.
    expect(consumed()).toBeLessThanOrEqual(sizeBytes);
  });

  it('never sends a truncated object as complete', async () => {
    const sizeBytes = INLINE_ARTIFACT_MAX_BYTES + 1;
    const { fetcher, consumed } = drainingFetcher();

    await expectStreamError(
      uploadArtifactStream(patternSource(sizeBytes - 4096, 64 * KiB), {
        uploadUrl: 'https://storage.invalid/grant',
        mimeType: 'application/octet-stream',
        sizeBytes,
        maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
        fetcher,
      }),
      422,
      'SIZE_MISMATCH'
    );
    expect(consumed()).toBeLessThan(sizeBytes);
  });

  it('rejects an out-of-bounds byte view as a truncated direct-band object', async () => {
    const sizeBytes = INLINE_ARTIFACT_MAX_BYTES + 1;
    const backing = Buffer.from('small source');
    const outOfBoundsView = backing.subarray(backing.byteLength + 1, backing.byteLength + sizeBytes + 1);
    const { fetcher, consumed } = drainingFetcher();

    expect(outOfBoundsView.byteLength).toBe(0);
    await expectStreamError(
      uploadArtifactStream(Readable.from([outOfBoundsView]), {
        uploadUrl: 'https://storage.invalid/grant',
        mimeType: 'application/octet-stream',
        sizeBytes,
        maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
        fetcher,
      }),
      422,
      'SIZE_MISMATCH',
    );
    expect(consumed()).toBe(0);
  });

  it('refuses a stream whose digest disagrees with the grant', async () => {
    const sizeBytes = INLINE_ARTIFACT_MAX_BYTES + 1;
    const { fetcher } = drainingFetcher();

    await expectStreamError(
      uploadArtifactStream(patternSource(sizeBytes, 64 * KiB), {
        uploadUrl: 'https://storage.invalid/grant',
        mimeType: 'application/octet-stream',
        sizeBytes,
        maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
        expectedSha256: patternDigest(0, sizeBytes - 1),
        fetcher,
      }),
      422,
      'HASH_MISMATCH'
    );
  });

  it('refuses a corrupted digest at the exact 64 MiB direct-band boundary', async () => {
    const sizeBytes = DIRECT_ARTIFACT_MAX_BYTES;
    const { fetcher, consumed } = drainingFetcher();
    const validDigest = patternDigest(0, sizeBytes);
    const corruptedDigest = (validDigest[0] === '0' ? '1' : '0') + validDigest.slice(1);

    await expectStreamError(
      uploadArtifactStream(patternSource(sizeBytes, 64 * KiB), {
        uploadUrl: 'https://storage.invalid/grant',
        mimeType: 'application/octet-stream',
        sizeBytes,
        maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
        expectedSha256: corruptedDigest,
        fetcher,
      }),
      422,
      'HASH_MISMATCH'
    );
    expect(consumed()).toBeLessThan(sizeBytes);
  });

  it('detects corrupted bytes in a non-zero-offset view during digest calculation', async () => {
    const sizeBytes = INLINE_ARTIFACT_MAX_BYTES + 1;
    const byteOffset = 17;
    const backing = new Uint8Array(sizeBytes + byteOffset + 11);
    for (let i = 0; i < sizeBytes; i += 1) backing[byteOffset + i] = patternByte(i);
    const corruptedByteOffset = byteOffset + Math.floor(sizeBytes / 2);
    backing[corruptedByteOffset] = (backing[corruptedByteOffset] ?? 0) ^ 0xff;
    const sourceView = backing.subarray(byteOffset, byteOffset + sizeBytes);
    const { fetcher, consumed } = drainingFetcher();

    await expectStreamError(
      uploadArtifactStream(Readable.from([sourceView]), {
        uploadUrl: 'https://storage.invalid/grant',
        mimeType: 'application/octet-stream',
        sizeBytes,
        maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
        expectedSha256: patternDigest(0, sizeBytes),
        fetcher,
      }),
      422,
      'HASH_MISMATCH',
    );
    expect(consumed()).toBe(sizeBytes);
  });
});

describe('direct band RSS (zero sockets, in-data-path sampling)', () => {
  /* Ceilings derived from six measurement runs on this host (64 MiB, 64 KiB
 * source chunks, one draining fetcher): peak marginal external 32.9 / 33.1 /
 * 33.0 / 21.1 / 30.1 / 17.0 MiB and live external after the transfer 1.32 /
 * 1.38 / 4.00 / 3.13 / -13.12 MiB, over a clean GC sawtooth (0.5 -> 16.4 ->
 * 32.4 -> 16.7 -> 32.7 -> 1.2 MiB): allocation is released, never accumulated.
 * A least-squares slope was measured too and DROPPED as a witness - over a
 * sawtooth it is noise (-16k..+24k bytes/chunk across runs).
 * Whole-object retention - the failure mode under test - instead pins one live
 * copy of the file: peak >= 64 MiB and still >= 64 MiB after the transfer, so
 * it fails both ceilings by >= 1.33x and >= 8x. */
  const PEAK_EXTERNAL_MAX_BYTES = 48 * MiB;
  const RESIDENT_EXTERNAL_MAX_BYTES = 8 * MiB;

  it('streams the 64 MiB band maximum without retaining the object', async () => {
    const sizeBytes = DIRECT_ARTIFACT_MAX_BYTES;
    const chunkBytes = 64 * KiB;
    const { fetcher, consumed } = drainingFetcher();

    const pre: number[] = [];
    for (let i = 0; i < 20; i += 1) {
      await new Promise<void>((resolve) => setImmediate(resolve));
      pre.push(process.memoryUsage().external);
    }
    pre.sort((a, b) => a - b);
    const baseline = pre[10] ?? 0;

    const traj: number[] = [];
    const sampled = (function* (): Generator<Buffer> {
      for (const chunk of patternChunks(sizeBytes, chunkBytes)) {
        traj.push(process.memoryUsage().external - baseline);
        yield chunk;
      }
    })();

    const integrity = await uploadArtifactStream(Readable.from(sampled), {
      uploadUrl: 'https://storage.invalid/grant',
      mimeType: 'application/octet-stream',
      sizeBytes,
      maxBytes: DIRECT_ARTIFACT_MAX_BYTES,
      expectedSha256: patternDigest(0, sizeBytes),
      fetcher,
    });

    // Fidelity first: an empty sample series must never pass vacuously.
    expect(traj.length).toBeGreaterThanOrEqual(sizeBytes / chunkBytes);
    expect(consumed()).toBe(sizeBytes);
    expect(integrity).toEqual({ sizeBytes, sha256: patternDigest(0, sizeBytes) });

    const peak = Math.max(...traj);
    const resident = traj[traj.length - 1] ?? 0;
    const mib = (n: number) => (n / MiB).toFixed(2);
    console.log(
      'DIRECT-BAND-RSS total=64MiB chunk=64KiB samples=' + traj.length +
      ' peakMarginalExternal=' + mib(peak) + 'MiB' +
      ' residentExternal=' + mib(resident) + 'MiB'
    );

    expect(peak).toBeLessThanOrEqual(PEAK_EXTERNAL_MAX_BYTES);
    expect(resident).toBeLessThanOrEqual(RESIDENT_EXTERNAL_MAX_BYTES);
  });
});
