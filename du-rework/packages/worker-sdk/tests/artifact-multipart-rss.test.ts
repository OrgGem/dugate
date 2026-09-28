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
