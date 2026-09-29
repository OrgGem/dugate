import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ArtifactStreamError,
  MULTIPART_SDK_MAX_PART_BYTES,
  uploadArtifactMultipart,
  type MultipartUploadOptions,
  type MultipartUploadTransport,
} from '../src';

/**
 * W-DATA04-RSS-1 (A): measure the REAL RSS profile of uploadArtifactMultipart
 * at production part geometry — 64 MiB parts, >= 1 GiB total — against a fake
 * transport that receives the REAL concat'd PUT bodies and keeps no reference
 * to them (only length + digest + a memory snapshot taken at PUT entry).
 *
 * Offline only: no sockets, no DB/Redis/S3. The question adjudicated here is
 * whether Cycle 140's claim "memory = exactly ONE buffered part" (subarray-
 * held chunks + Buffer.concat at PUT) is a valid *RSS budget*, or only a
 * live-set invariant that the process allocator may not honor.
 *
 * SAMPLING NOTE: a setInterval sampler gets fully starved while the upload
 * runs (the await chain is dominated by immediately-resolved microtasks +
 * CPU-bound hashing/generation), so every sample here is taken from code the
 * test controls INSIDE the data path: per source-chunk (generator) and per
 * PUT entry (fake fetcher, the logical live-set high-water moment).
 *
 * Evidence emitted: baseline/median/max RSS, marginal RSS, marginal V8
 * external bytes, per-part RSS trajectory, and a least-squares slope in
 * MiB/part. Hard assertions certify (1) DATA FIDELITY: every byte the source
 * produced reaches the transport in the geometry the server fixed, and
 * (2) the RSS/external marginal ceilings are finite-sample maxima — an empty
 * sample series fails the test, never vacuously passes.
 */

jest.setTimeout(600_000);

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const PART_BYTES = MULTIPART_SDK_MAX_PART_BYTES; // exactly 64 MiB: the cap itself
const PART_COUNT = (1 * GiB) / PART_BYTES; // 16
const TOTAL_BYTES = PART_BYTES * PART_COUNT; // 1 GiB, remainder-free geometry

/**
 * Marginal (over baseline) ceilings. Derivation: measurement passes on this
 * host (probe + R series in receipt W-DATA04-RSS-1), 1 GiB uploads, showed:
 *   - steady-state RSS at PUT entry ~= baseline + 2..3 parts: the logical
 *     live set (chunk subarrays ~1 part + Buffer.concat body exactly 1
 *     part) plus one not-yet-collected part of GC lag;
 *   - worst transient RSS marginal observed ~= 323 MiB (5.05 parts), worst
 *     marginal V8 external observed ~= 320 MiB (5.0 parts) — both GC-lag
 *     peaks, never cumulative growth across the 16 parts (slope ~0).
 * Whole-object source retention (the failure mode under test) would pin
 * >= 16 parts of live external bytes (~1 GiB marginal) and grow monotonically
 * with part number. The 8-part ceilings keep >= 1.5x headroom over the worst
 * observed spike while discriminating the catastrophic case by >= 2x.
 */
const RSS_MARGINAL_MAX_BYTES = 8 * PART_BYTES; // 512 MiB = 8 parts
const EXTERNAL_MARGINAL_MAX_BYTES = 8 * PART_BYTES; // 512 MiB = 8 parts (live external bytes, GC lag included)

/* ------------------------------------------------------------------ */
/* deterministic pattern source + independent digests (same scheme as  */
/* artifact-multipart.test.ts, but never materializes the whole body)  */
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
/* memory instrumentation                                              */
/* ------------------------------------------------------------------ */

interface MemSnapshot {
  rss: number;
  heapUsed: number;
  external: number;
}

function snapshot(): MemSnapshot {
  const m = process.memoryUsage();
  return { rss: m.rss, heapUsed: m.heapUsed, external: m.external };
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const mid1 = sorted[mid] ?? 0;
  if (sorted.length % 2 === 1) return mid1;
  const mid0 = sorted[mid - 1] ?? 0;
  return (mid0 + mid1) / 2;
}

function leastSquaresSlope(xs: number[], ys: number[]): number {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i += 1) {
    const dx = (xs[i] ?? 0) - mx;
    num += dx * ((ys[i] ?? 0) - my);
    den += dx ** 2;
  }
  return den === 0 ? 0 : num / den;
}

/* ------------------------------------------------------------------ */
/* fake transport that receives REAL bodies and retains NONE of them   */
/* ------------------------------------------------------------------ */

interface PartEvidence {
  partNumber: number;
  receivedLength: number;
  receivedSha256: string;
  /** Taken inside the fetcher: the concat'd PUT body is live right now. */
  memAtPut: MemSnapshot;
}

interface RssFake {
  artifactId: string;
  transport: MultipartUploadTransport;
  fetcher: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  evidence: {
    parts: PartEvidence[];
    grants: { partNumber: number; sha256: string }[];
    complete: { parts: unknown[]; sha256: string } | null;
    aborts: string[];
  };
}

function makeRssFake(sizeBytes: number, partSizeBytes: number): RssFake {
  const artifactId = randomUUID();
  const partCount = Math.ceil(sizeBytes / partSizeBytes);
  const evidence: RssFake['evidence'] = { parts: [], grants: [], complete: null, aborts: [] };
  const transport: MultipartUploadTransport = {
    async init(body) {
      if (body.sizeBytes !== sizeBytes) {
        throw new ArtifactStreamError(422, 'SIZE_MISMATCH', 'init size disagrees with scenario');
      }
      return {
        artifactId,
        uploadHandle: 'mh_rss',
        partSizeBytes,
        partCount,
        expiresAt: '2099-01-01T00:00:00.000Z',
        replayed: false,
      };
    },
    async partGrant(id, body) {
      evidence.grants.push(body);
      const expected = Math.min(partSizeBytes, sizeBytes - (body.partNumber - 1) * partSizeBytes);
      return {
        artifactId: id,
        partNumber: body.partNumber,
        partUrl: 'http://parts.rss.test/p/' + body.partNumber + '?sig=secret-url-token',
        sizeBytes: expected,
        requiredHeaders: {
          'content-length': String(expected),
          'x-amz-checksum-sha256': 'b64-' + body.partNumber,
        },
        expiresAt: '2099-01-01T00:00:00.000Z',
      };
    },
    async complete(id, body) {
      evidence.complete = { parts: body.parts, sha256: body.sha256 };
      return { artifactId: id, sizeBytes, sha256: body.sha256, committed: true, replayed: false };
    },
    async abort(id, body) {
      evidence.aborts.push(body.reason);
      return { artifactId: id, state: 'ABORTED', replayed: false };
    },
  };
  const fetcher = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = init?.body;
    if (!Buffer.isBuffer(body)) {
      throw new ArtifactStreamError(500, 'TRANSPORT_FAILURE', 'rss fake expects a Buffer body');
    }
    const partNumber = evidence.parts.length + 1;
    // Fidelity: verify what the transport ACTUALLY received against the
    // independently generated pattern — then drop every reference to body.
    const receivedSha256 = createHash('sha256').update(body).digest('hex');
    evidence.parts.push({
      partNumber,
      receivedLength: body.length,
      receivedSha256,
      memAtPut: snapshot(),
    });
    return new Response(null, { status: 200, headers: { etag: '"etag-' + partNumber + '"' } });
  }) as unknown as RssFake['fetcher'];
  return { artifactId, transport, fetcher, evidence };
}

function smallUploadOptions(
  fake: RssFake,
  sizeBytes: number,
  overrides: Partial<MultipartUploadOptions> = {}
): MultipartUploadOptions {
  return {
    transport: fake.transport,
    fetcher: fake.fetcher,
    fileName: 'small-boundary.bin',
    mimeType: 'application/octet-stream',
    sizeBytes,
    retryBaseDelayMs: 0,
    ...overrides,
  };
}

/* ------------------------------------------------------------------ */
/* scenario runner: in-data-path sampling (generator chunks + PUTs)    */
/* ------------------------------------------------------------------ */

interface RssScenarioResult {
  baselineMedianRss: number;
  baselineMedianExternal: number;
  chunkSamples: number;
  uploadMedianRss: number;
  uploadMaxRss: number;
  marginalMaxRss: number;
  marginalMaxExternal: number;
  perPartRss: number[];
  perPartExternal: number[];
  slopeRssMiBPerPart: number;
  durationMs: number;
}

async function runRssScenario(
  label: string,
  chunkSize: number
): Promise<
  {
    result: RssScenarioResult;
    fake: RssFake;
    uploadResult: Awaited<ReturnType<typeof uploadArtifactMultipart>>;
  }
> {
  const fake = makeRssFake(TOTAL_BYTES, PART_BYTES);
  const options: MultipartUploadOptions = {
    transport: fake.transport,
    fetcher: fake.fetcher,
    fileName: 'rss-probe.bin',
    mimeType: 'application/octet-stream',
    sizeBytes: TOTAL_BYTES,
    retryBaseDelayMs: 0,
  };

  // Baseline: module + fake constructed, no big allocations yet; the source
  // is a lazy generator, so nothing has materialized. 20 idle-loop spins.
  const pre: number[] = [];
  const preExt: number[] = [];
  for (let i = 0; i < 20; i += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    const m = snapshot();
    pre.push(m.rss);
    preExt.push(m.external);
  }
  const baselineMedianRss = median(pre);
  const baselineMedianExternal = median(preExt);

  // In-data-path sampling: wrap the source generator so every produced
  // chunk is a steady-state sample point, and take PUT-entry snapshots in
  // the fake fetcher. setInterval is NOT used: it is fully starved while
  // the upload's microtask-dominated await chain is running.
  const chunkRss: number[] = [];
  const chunkExternal: number[] = [];
  const sampledSource = (function* (): Generator<Buffer> {
    const it = patternChunks(TOTAL_BYTES, chunkSize);
    for (;;) {
      const next = it.next();
      if (next.done) break;
      const m = snapshot();
      chunkRss.push(m.rss);
      chunkExternal.push(m.external);
      yield next.value;
    }
  })();

  const t0 = Date.now();
  const uploadResult = await uploadArtifactMultipart(Readable.from(sampledSource), options);
  const durationMs = Date.now() - t0;

  const perPartRss = fake.evidence.parts.map((p) => p.memAtPut.rss);
  const perPartExternal = fake.evidence.parts.map((p) => p.memAtPut.external);
  const allRss = [...chunkRss, ...perPartRss];
  const allExternal = [...chunkExternal, ...perPartExternal];
  if (allRss.length < TOTAL_BYTES / chunkSize) {
    throw new Error('RSS sampling lost samples: expected >= ' + TOTAL_BYTES / chunkSize + ', got ' + allRss.length);
  }
  const partXs = fake.evidence.parts.map((p) => p.partNumber);
  const slope = leastSquaresSlope(partXs, perPartRss) / MiB;

  const uploadMaxRss = allRss.length ? Math.max(...allRss) : -1;
  const uploadMaxExternal = allExternal.length ? Math.max(...allExternal) : -1;
  const result: RssScenarioResult = {
    baselineMedianRss,
    baselineMedianExternal,
    chunkSamples: chunkRss.length,
    uploadMedianRss: median(allRss),
    uploadMaxRss,
    marginalMaxRss: uploadMaxRss - baselineMedianRss,
    marginalMaxExternal: uploadMaxExternal - baselineMedianExternal,
    perPartRss,
    perPartExternal,
    slopeRssMiBPerPart: slope,
    durationMs,
  };

  const mib = (n: number) => (n / MiB).toFixed(1);
  console.log(
    [
      'RSS-MEASURE[' + label + '] total=' + (TOTAL_BYTES / MiB).toFixed(0) + 'MiB parts=' + PART_COUNT + 'x' + (PART_BYTES / MiB).toFixed(0) + 'MiB chunk=' + (chunkSize / MiB).toFixed(0) + 'MiB',
      ' baselineRssMedian=' + mib(baselineMedianRss) + 'MiB',
      ' uploadRssMedian=' + mib(result.uploadMedianRss) + 'MiB',
      ' uploadRssMax=' + mib(result.uploadMaxRss) + 'MiB',
      ' marginalRssMax=' + mib(result.marginalMaxRss) + 'MiB',
      ' baselineExternalMedian=' + mib(baselineMedianExternal) + 'MiB',
      ' marginalExternalMax=' + mib(result.marginalMaxExternal) + 'MiB',
      ' perPartRssMiB first=' + mib(perPartRss[0] ?? 0) + ' last=' + mib(perPartRss[perPartRss.length - 1] ?? 0),
      ' rssSlope=' + slope.toFixed(3) + 'MiB/part',
      ' chunkSamples=' + result.chunkSamples + ' putSamples=' + perPartRss.length + ' duration=' + (durationMs / 1000).toFixed(1) + 's',
    ].join('')
  );
  console.log(
    'RSS-TRAJECTORY[' + label + '] perPartRssMiB=[' + perPartRss.map((n) => mib(n)).join(', ') + ']'
  );

  return { result, fake, uploadResult };
}

/* ------------------------------------------------------------------ */
/* expectations shared by every geometry                               */
/* ------------------------------------------------------------------ */

function assertFidelity(
  fake: RssFake,
  uploadResult: { artifactId: string; sizeBytes: number; sha256: string; partCount: number }
) {
  expect(uploadResult).toEqual({
    artifactId: fake.artifactId,
    sizeBytes: TOTAL_BYTES,
    sha256: patternDigest(0, TOTAL_BYTES),
    partCount: PART_COUNT,
  });
  expect(fake.evidence.parts).toHaveLength(PART_COUNT);
  fake.evidence.parts.forEach((p, i) => {
    const startOffset = i * PART_BYTES;
    expect([p.partNumber, p.receivedLength]).toEqual([i + 1, PART_BYTES]);
    // The bytes that ACTUALLY reached the transport equal the pattern range
    // the geometry fixed — independent of any hash the engine computed.
    expect(p.receivedSha256).toBe(patternDigest(startOffset, PART_BYTES));
    expect(p.receivedSha256).toBe(fake.evidence.grants[i]?.sha256);
  });
  expect(fake.evidence.grants.map((g) => g.partNumber)).toEqual(
    Array.from({ length: PART_COUNT }, (_, i) => i + 1)
  );
  expect(fake.evidence.complete).not.toBeNull();
  expect(fake.evidence.complete?.sha256).toBe(patternDigest(0, TOTAL_BYTES));
  expect(fake.evidence.complete?.parts).toHaveLength(PART_COUNT);
  expect(fake.evidence.aborts).toHaveLength(0);
}

function assertMemoryCeilings(result: RssScenarioResult) {
  // Non-empty, finite sample series first: a vacuous max on [] must never pass.
  expect(result.chunkSamples).toBeGreaterThanOrEqual(Math.floor(TOTAL_BYTES / (16 * MiB)));
  expect(result.uploadMaxRss).toBeGreaterThan(result.baselineMedianRss);
  // Logical live set is ~2 parts (chunk subarrays + concat body); GC lag
  // spikes and allocator retention are absorbed by the ceilings below while
  // whole-object retention (>= 16 parts marginal) can never pass them.
  expect(result.marginalMaxRss).toBeLessThanOrEqual(RSS_MARGINAL_MAX_BYTES);
  expect(result.marginalMaxExternal).toBeLessThanOrEqual(EXTERNAL_MARGINAL_MAX_BYTES);
}

describe('uploadArtifactMultipart RSS measurement (W-DATA04-RSS-1, offline)', () => {
  it('uploads 1 GiB as 16x64MiB parts with ALIGNED 16MiB source chunks: fidelity + memory ceilings', async () => {
    const { result, fake, uploadResult } = await runRssScenario('aligned-16MiB', 16 * MiB);
    assertFidelity(fake, uploadResult);
    assertMemoryCeilings(result);
  });

  it('uploads 1 GiB as 16x64MiB parts with MISALIGNED 5MiB source chunks: fidelity + memory ceilings', async () => {
    const { result, fake, uploadResult } = await runRssScenario('misaligned-5MiB', 5 * MiB);
    assertFidelity(fake, uploadResult);
    assertMemoryCeilings(result);
  });
});

describe('multipart RSS threshold guard negative boundaries', () => {
  function syntheticMeasurement(overrides: Partial<RssScenarioResult> = {}): RssScenarioResult {
    return {
      baselineMedianRss: 100,
      baselineMedianExternal: 100,
      chunkSamples: Math.floor(TOTAL_BYTES / (16 * MiB)),
      uploadMedianRss: 100,
      uploadMaxRss: 101,
      marginalMaxRss: RSS_MARGINAL_MAX_BYTES,
      marginalMaxExternal: EXTERNAL_MARGINAL_MAX_BYTES,
      perPartRss: [],
      perPartExternal: [],
      slopeRssMiBPerPart: 0,
      durationMs: 1,
      ...overrides,
    };
  }

  it('accepts measurements exactly at both RSS and external-memory ceilings', () => {
    expect(() => assertMemoryCeilings(syntheticMeasurement())).not.toThrow();
  });

  it.each([
    ['RSS', { marginalMaxRss: RSS_MARGINAL_MAX_BYTES + 1 }],
    ['external-memory', { marginalMaxExternal: EXTERNAL_MARGINAL_MAX_BYTES + 1 }],
  ])('fails the multipart sample gate when the %s threshold is breached', (_metric, breach) => {
    expect(() => assertMemoryCeilings(syntheticMeasurement(breach))).toThrow();
  });
});

describe('multipart RSS integrity and ordering negatives (small offline geometry)', () => {
  it('rejects a truncated final part at its chunk boundary and aborts before complete', async () => {
    const sizeBytes = 14;
    const fake = makeRssFake(sizeBytes, 4);

    await expect(uploadArtifactMultipart(
      patternSource(sizeBytes - 1, 5),
      smallUploadOptions(fake, sizeBytes)
    )).rejects.toMatchObject({ status: 409, code: 'SIZE_MISMATCH' });

    expect(fake.evidence.grants.map((grant) => grant.partNumber)).toEqual([1, 2, 3, 4]);
    expect(fake.evidence.parts.map((part) => part.receivedLength)).toEqual([4, 4, 4]);
    expect(fake.evidence.complete).toBeNull();
    expect(fake.evidence.aborts).toEqual(['failed']);
  });

  it('rejects a corrupted byte exactly on a multipart boundary before completion', async () => {
    const sizeBytes = 12;
    const fake = makeRssFake(sizeBytes, 4);
    const corruptedTail = patternSlice(5, 7);
    corruptedTail[3] = (corruptedTail[3] ?? 0) ^ 0xff; // global byte 8 starts part 3
    const source = Readable.from([patternSlice(0, 5), corruptedTail]);

    await expect(uploadArtifactMultipart(
      source,
      smallUploadOptions(fake, sizeBytes, { expectedSha256: patternDigest(0, sizeBytes) })
    )).rejects.toMatchObject({ status: 422, code: 'HASH_MISMATCH' });

    expect(fake.evidence.parts).toHaveLength(3);
    expect(fake.evidence.parts[2]?.receivedSha256).not.toBe(patternDigest(8, 4));
    expect(fake.evidence.complete).toBeNull();
    expect(fake.evidence.aborts).toEqual(['failed']);
  });

  it('keeps part arrival and completion sequences ordered when source chunks straddle boundaries', async () => {
    const sizeBytes = 13;
    const fake = makeRssFake(sizeBytes, 4);
    const result = await uploadArtifactMultipart(
      patternSource(sizeBytes, 5),
      smallUploadOptions(fake, sizeBytes, { expectedSha256: patternDigest(0, sizeBytes) })
    );
    const completedParts = fake.evidence.complete?.parts as { partNumber: number }[] | undefined;

    expect(result.partCount).toBe(4);
    expect(fake.evidence.grants.map((grant) => grant.partNumber)).toEqual([1, 2, 3, 4]);
    expect(fake.evidence.parts.map((part) => part.partNumber)).toEqual([1, 2, 3, 4]);
    expect(completedParts?.map((part) => part.partNumber)).toEqual([1, 2, 3, 4]);
    expect(fake.evidence.aborts).toHaveLength(0);
  });

  it('rejects an init acknowledgement that omits the required part count', async () => {
    const sizeBytes = 12;
    const fake = makeRssFake(sizeBytes, 4);
    const init = fake.transport.init.bind(fake.transport);
    fake.transport.init = async (body) => ({ ...await init(body), partCount: undefined as unknown as number });

    await expect(uploadArtifactMultipart(
      patternSource(sizeBytes, 4),
      smallUploadOptions(fake, sizeBytes)
    )).rejects.toMatchObject({ status: 409, code: 'SIZE_MISMATCH' });

    expect(fake.evidence.grants).toHaveLength(0);
    expect(fake.evidence.parts).toHaveLength(0);
    expect(fake.evidence.complete).toBeNull();
    expect(fake.evidence.aborts).toEqual(['failed']);
  });

  it('rejects an out-of-order part arrival caused by a mis-sequenced grant URL', async () => {
    const sizeBytes = 12;
    const fake = makeRssFake(sizeBytes, 4);
    const originalPartGrant = fake.transport.partGrant.bind(fake.transport);
    fake.transport.partGrant = async (artifactId, request) => {
      const grant = await originalPartGrant(artifactId, request);
      const serverPartNumber = request.partNumber === 1 ? 2 : request.partNumber === 2 ? 1 : request.partNumber;
      return { ...grant, partUrl: `http://parts.rss.test/p/${serverPartNumber}?sig=mis-sequenced` };
    };
    const arrivalOrder: number[] = [];
    const fetcher: RssFake['fetcher'] = async (url, init) => {
      const serverPartNumber = Number(new URL(String(url)).pathname.split('/').at(-1));
      arrivalOrder.push(serverPartNumber);
      if (serverPartNumber !== arrivalOrder.length) {
        return new Response('part arrived out of order', { status: 409 });
      }
      return fake.fetcher(url, init);
    };

    await expect(uploadArtifactMultipart(
      patternSource(sizeBytes, 4),
      smallUploadOptions(fake, sizeBytes, { fetcher, partPutAttempts: 1 })
    )).rejects.toMatchObject({ status: 409, code: 'DOWNLOAD_REJECTED' });

    expect(arrivalOrder).toEqual([2]);
    expect(fake.evidence.parts).toHaveLength(0);
    expect(fake.evidence.complete).toBeNull();
    expect(fake.evidence.aborts).toEqual(['failed']);
  });

  it.each([
    ['invalid encoding', 'not-base64'],
    ['valid but mismatched digest', Buffer.alloc(32, 7).toString('base64')],
  ])('aborts when a part checksum is %s', async (_caseName, wrongChecksum) => {
    const sizeBytes = 8;
    const fake = makeRssFake(sizeBytes, 4);
    const originalPartGrant = fake.transport.partGrant.bind(fake.transport);
    fake.transport.partGrant = async (artifactId, request) => {
      const grant = await originalPartGrant(artifactId, request);
      return {
        ...grant,
        requiredHeaders: {
          ...grant.requiredHeaders,
          'x-amz-checksum-sha256': wrongChecksum,
        },
      };
    };
    const fetcher: RssFake['fetcher'] = async (url, init) => {
      const body = init?.body;
      if (!Buffer.isBuffer(body)) throw new Error('expected a buffered multipart body');
      const headers = init?.headers as Record<string, string>;
      const actualChecksum = createHash('sha256').update(body).digest('base64');
      if (headers['x-amz-checksum-sha256'] !== actualChecksum) {
        return new Response('part checksum rejected', { status: 400 });
      }
      return fake.fetcher(url, init);
    };

    await expect(uploadArtifactMultipart(
      patternSource(sizeBytes, 3),
      smallUploadOptions(fake, sizeBytes, { fetcher, partPutAttempts: 1 })
    )).rejects.toMatchObject({ status: 400, code: 'DOWNLOAD_REJECTED' });

    expect(fake.evidence.grants[0]?.sha256).toBe(patternDigest(0, 4));
    expect(fake.evidence.complete).toBeNull();
    expect(fake.evidence.aborts).toEqual(['failed']);
  });

  it('aborts the multipart session when the caller cancels an active part upload', async () => {
    const sizeBytes = 8;
    const fake = makeRssFake(sizeBytes, 4);
    const controller = new AbortController();
    let uploadSignal: AbortSignal | undefined;
    const fetcher: RssFake['fetcher'] = async (_url, init) => new Promise<Response>((_resolve, reject) => {
      uploadSignal = init?.signal ?? undefined;
      if (!uploadSignal) {
        reject(new Error('multipart part request did not receive an abort signal'));
        return;
      }
      const onAbort = (): void => reject(new Error('part request aborted by caller'));
      if (uploadSignal.aborted) onAbort();
      else uploadSignal.addEventListener('abort', onAbort, { once: true });
      setImmediate(() => controller.abort());
    });

    await expect(uploadArtifactMultipart(
      patternSource(sizeBytes, 4),
      smallUploadOptions(fake, sizeBytes, {
        signal: controller.signal,
        fetcher,
        partPutAttempts: 1,
      })
    )).rejects.toMatchObject({ status: 0, code: 'TRANSPORT_FAILURE' });

    expect(uploadSignal?.aborted).toBe(true);
    expect(fake.evidence.complete).toBeNull();
    expect(fake.evidence.aborts).toEqual(['cancelled']);
  });
});
