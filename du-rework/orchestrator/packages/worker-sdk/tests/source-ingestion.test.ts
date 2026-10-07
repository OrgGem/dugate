import { createHash } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createPinnedFetch } from '@du/egress';
import {
  INGESTION_SOURCE_FIELD,
  resolveIngestionSource,
  withIngestionSource,
} from '@du/contracts';
import {
  assertIngestionReceipt,
  createIngestionTaskHandler,
  createSourceAcquisitionIngestor,
  SourceIngestionError,
  TEMP_WORKSPACE_PREFIX,
  createTempWorkspace,
  type IngestionTask,
  type MaterializedArtifact,
  type PinnedSourceStorage,
  type SourceIngestionReceipt,
  type TempWorkspace,
} from '../src';
import type { SdkFetcher } from '../src/fan-out';
import { BoundaryListener } from '../../../../tests/harness/network-boundaries/mock-listener';

/**
 * DATA-03 producer leg (packet W-DATA03-ACQ-1 round 2): bounded URL acquisition
 * pinned into immutable private-storage versions.
 *
 * Three evidence layers, all offline:
 *  1. VALIDATOR (zero sockets, zero storage): a receipt is only ever produced
 *     over a hex-64 digest, a real byte count and printable key/version handles,
 *     and the ingestor refuses an unusable budget at construction time.
 *  2. FLOW (injected fetcher + versioned in-memory storage fixture): acquire ->
 *     stream -> cross-check -> receipt, and every disagreement (storage digest,
 *     storage key, storage failure, pin corruption, oversize, abort) yields NO
 *     receipt and NO committed version. The fixture also counts body chunks, so
 *     'streamed, never buffered whole' is witnessed rather than asserted in prose.
 *  3. REALITY (default pinned egress + 127.0.0.1 listener on the Windows quiet
 *     band): private/loopback/metadata literals are refused before connect with
 *     zero storage writes, and a 2 MiB fixture document travels the whole chain
 *     once; the second call answers the pinned receipt without any new request.
 *
 * globalThis.fetch is never monkeypatched; real HTTP enters production only
 * through the declared fetcher seam.
 */

jest.setTimeout(180_000);

const KiB = 1024;
const MiB = 1024 * 1024;
const KEY = 'du/tenants/t1/operations/op1/source';

const doc = Buffer.from('DATA-03 ingestion fixture - repeated payload block.\n'.repeat(48), 'utf8');
const docSha = createHash('sha256').update(doc).digest('hex');

const QUIET_PORT_BASE = 46_400 + (process.pid % 8) * 16;
let portOffset = 0;
const listeners: BoundaryListener[] = [];
async function startListener(): Promise<BoundaryListener> {
  const listener = await BoundaryListener.start(QUIET_PORT_BASE + portOffset++);
  listeners.push(listener);
  return listener;
}
const localPinned = (): SdkFetcher => createPinnedFetch({ allowPrivateNetworks: true });

afterAll(async () => {
  await Promise.all(listeners.map((l) => l.stop()));
});

/* ---------------- versioned storage fixture -------------------------- */

interface StoredVersion {
  storageKey: string;
  versionId: string;
  sha256: string;
  sizeBytes: number;
  bytes: Buffer;
  chunks: number;
}

interface FixtureOptions {
  failPut?: Error;
  /** Storage reports a digest that does not match the bytes it was handed. */
  disagreeDigest?: boolean;
  /** Storage commits under a different key than requested. */
  disagreeKey?: boolean;
  /** resolvePinned throws instead of answering. */
  failResolve?: Error;
}

function makeStorageFixture(opts: FixtureOptions = {}) {
  const versions: StoredVersion[] = [];
  const pins = new Map<string, SourceIngestionReceipt>();
  let puts = 0;
  let resolves = 0;
  const storage: PinnedSourceStorage = {
    async putVerified(input) {
      puts += 1;
      if (opts.failPut) throw opts.failPut;
      const chunks: Buffer[] = [];
      let total = 0;
      let count = 0;
      for await (const raw of input.body as AsyncIterable<Uint8Array>) {
        const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
        count += 1;
        total += chunk.length;
        if (total > input.maxBytes) throw new Error('fixture byte cap exceeded');
        chunks.push(chunk);
      }
      const bytes = Buffer.concat(chunks, total);
      const sha256 = opts.disagreeDigest
        ? 'f'.repeat(64)
        : createHash('sha256').update(bytes).digest('hex');
      const versionId = 'v' + (versions.length + 1);
      versions.push({
        storageKey: input.storageKey,
        versionId,
        sha256,
        sizeBytes: total,
        bytes,
        chunks: count,
      });
      const written = {
        storageKey: opts.disagreeKey ? input.storageKey + '-x' : input.storageKey,
        versionId,
        sha256,
        sizeBytes: total,
      };
      // Mirrors the production pin-at-READY step (DATA-01 records the immutable
      // version + digest on the artifact row): committing a version makes it the
      // answer for resolvePinned, so a retry is served from the pin and never
      // re-downloads. Without this the fixture would model a storage that forgets
      // what it pinned.
      pins.set(written.storageKey, written);
      return written;
    },
    async resolvePinned(storageKey) {
      resolves += 1;
      if (opts.failResolve) throw opts.failResolve;
      return pins.get(storageKey) ?? null;
    },
  };
  return {
    storage,
    versions,
    puts: () => puts,
    resolves: () => resolves,
    pin: (receipt: SourceIngestionReceipt) => pins.set(receipt.storageKey, receipt),
  };
}

/** A fetcher that answers 200 with fixed bytes and counts its own calls. */
function bodyFetcher(bytes: Buffer, status = 200): { fetcher: SdkFetcher; calls: () => number } {
  let calls = 0;
  const fetcher = (async () => {
    calls += 1;
    if (status !== 200) return new Response(null, { status });
    return new Response(new Uint8Array(bytes), { status: 200, headers: { 'content-type': 'text/plain' } });
  }) as SdkFetcher;
  return { fetcher, calls: () => calls };
}

function throwingFetcher(): SdkFetcher {
  return (async () => {
    throw new Error('network must not be reached once a copy is pinned');
  }) as SdkFetcher;
}

async function expectNoWorkspaceLeft(taskId: string): Promise<void> {
  const entries = await readdir(tmpdir());
  expect(entries.filter((name) => name.startsWith(TEMP_WORKSPACE_PREFIX + taskId + '-'))).toEqual([]);
}

function ingestorFor(
  fixture: ReturnType<typeof makeStorageFixture>,
  fetcher: SdkFetcher,
  extra: Partial<{ maxBytes: number; taskId: string; reusePinned: boolean; signal: AbortSignal; highWaterMarkBytes: number; storageKey: string }> = {}
) {
  return createSourceAcquisitionIngestor({
    storage: fixture.storage,
    storageKey: extra.storageKey ?? KEY,
    taskId: extra.taskId ?? 'ingest-test',
    fileName: 'source.bin',
    contentType: 'text/plain',
    reusePinned: extra.reusePinned,
    highWaterMarkBytes: extra.highWaterMarkBytes,
    transfer: {
      maxBytes: extra.maxBytes ?? 8 * MiB,
      fetcher,
      signal: extra.signal,
      timeoutMs: 5_000,
      idleTimeoutMs: 2_000,
    },
  });
}

function expectIngestError(promise: Promise<unknown>, status: number, code: string): Promise<void> {
  return promise.then(
    () => {
      throw new Error('expected SourceIngestionError ' + status + '/' + code);
    },
    (err: unknown) => {
      expect(err).toBeInstanceOf(SourceIngestionError);
      const typed = err as SourceIngestionError;
      expect([typed.status, typed.code]).toEqual([status, code]);
    }
  );
}

describe('ingestion receipt validator and ingestor budget guards (zero sockets)', () => {
  const good: SourceIngestionReceipt = {
    storageKey: KEY,
    versionId: 'v1',
    sha256: 'a'.repeat(64),
    sizeBytes: 4096,
  };

  it('accepts a well-formed receipt and normalizes the digest case', () => {
    const upper = { ...good, sha256: 'A'.repeat(64) };
    expect(assertIngestionReceipt(upper).sha256).toBe('a'.repeat(64));
  });

  it('refuses every unusable receipt shape', () => {
    const bad: unknown[] = [
      null,
      undefined,
      'receipt',
      { ...good, sha256: 'nope' },
      { ...good, sha256: 'a'.repeat(63) },
      { ...good, sizeBytes: -1 },
      { ...good, sizeBytes: 1.5 },
      { ...good, sizeBytes: undefined },
      { ...good, storageKey: '' },
      { ...good, storageKey: 'bad\nkey' },
      { ...good, versionId: '' },
    ];
    for (const value of bad) {
      let caught: SourceIngestionError | null = null;
      try {
        assertIngestionReceipt(value);
      } catch (err) {
        caught = err as SourceIngestionError;
      }
      expect([String(value), caught?.code]).toEqual([String(value), 'RECEIPT_INVALID']);
    }
  });

  it('refuses an ingestor built without a usable key or byte budget', () => {
    const fixture = makeStorageFixture();
    expect(() =>
      createSourceAcquisitionIngestor({
        storage: fixture.storage,
        storageKey: '',
        transfer: { maxBytes: MiB, fetcher: throwingFetcher() },
      })
    ).toThrow(SourceIngestionError);
    expect(() =>
      createSourceAcquisitionIngestor({
        storage: fixture.storage,
        storageKey: KEY,
        transfer: { maxBytes: 0, fetcher: throwingFetcher() },
      })
    ).toThrow(/maxBytes/);
    expect(() =>
      createSourceAcquisitionIngestor({
        storage: fixture.storage,
        storageKey: KEY,
        highWaterMarkBytes: 2 * MiB,
        transfer: { maxBytes: MiB, fetcher: throwingFetcher() },
      })
    ).toThrow(/stream buffer/);
    expect(fixture.puts()).toBe(0);
  });
});

describe('acquire -> stream -> pin (injected fetcher, versioned fixture)', () => {
  it('commits one new immutable version and returns the cross-checked receipt', async () => {
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(doc);
    const taskId = 'ingest-happy-' + process.pid;

    const receipt = await ingestorFor(fixture, fetcher, { taskId }).acquire('https://source.example/doc.txt');

    expect(receipt).toEqual({ storageKey: KEY, versionId: 'v1', sha256: docSha, sizeBytes: doc.length });
    expect(fixture.versions).toHaveLength(1);
    expect(fixture.versions[0]?.bytes.equals(doc)).toBe(true);
    expect(fixture.versions[0]?.sizeBytes).toBe(doc.length);
    await expectNoWorkspaceLeft(taskId);
  });

  it('hands storage a STREAM, never one whole-object buffer', async () => {
    const fixture = makeStorageFixture();
    const big = Buffer.alloc(2 * MiB, 0x61);
    const { fetcher } = bodyFetcher(big);

    await ingestorFor(fixture, fetcher, {
      taskId: 'ingest-streamed-' + process.pid,
      highWaterMarkBytes: 64 * KiB,
    }).acquire('https://source.example/big.bin');

    const stored = fixture.versions[0];
    expect(stored?.sizeBytes).toBe(big.length);
    // A whole-buffer upload would be exactly one chunk; streaming yields many and
    // keeps the SDK-side live set at one chunk.
    expect(stored?.chunks).toBeGreaterThanOrEqual(Math.floor(big.length / (64 * KiB)));
  });

  it('refuses to pin when storage reports a digest that disagrees', async () => {
    const fixture = makeStorageFixture({ disagreeDigest: true });
    const { fetcher } = bodyFetcher(doc);
    await expectIngestError(
      ingestorFor(fixture, fetcher, { taskId: 'ingest-digest-' + process.pid }).acquire('https://source.example/doc.txt'),
      502,
      'PIN_MISMATCH'
    );
    expect(fixture.puts()).toBe(1);
  });

  it('refuses to pin bytes storage committed under a different key', async () => {
    const fixture = makeStorageFixture({ disagreeKey: true });
    const { fetcher } = bodyFetcher(doc);
    await expectIngestError(
      ingestorFor(fixture, fetcher, { taskId: 'ingest-key-' + process.pid }).acquire('https://source.example/doc.txt'),
      502,
      'PIN_MISMATCH'
    );
  });

  it('maps a storage failure to STORAGE_FAILURE without echoing the URL', async () => {
    const fixture = makeStorageFixture({ failPut: new Error('socket hang up') });
    const { fetcher } = bodyFetcher(doc);
    const promise = ingestorFor(fixture, fetcher, {
      taskId: 'ingest-failput-' + process.pid,
    }).acquire('https://source.example/private-doc.txt?token=secret-token');
    await expectIngestError(promise, 502, 'STORAGE_FAILURE');
    await promise.catch((err: Error) => {
      expect(err.message).not.toContain('source.example');
      expect(err.message).not.toContain('secret-token');
      expect(err.message).not.toContain('socket hang up');
    });
    expect(fixture.puts()).toBe(1);
  });

  it('fails closed when the pinned lookup itself faults', async () => {
    const fixture = makeStorageFixture({ failResolve: new Error('bucket unreadable') });
    const { fetcher, calls } = bodyFetcher(doc);
    await expectIngestError(
      ingestorFor(fixture, fetcher, { taskId: 'ingest-resolve-' + process.pid }).acquire('https://source.example/doc.txt'),
      502,
      'STORAGE_FAILURE'
    );
    expect(calls()).toBe(0);
    expect(fixture.puts()).toBe(0);
  });

  it('produces no receipt and no version for an over-budget source', async () => {
    const taskId = 'ingest-oversize-' + process.pid;
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(Buffer.alloc(3 * MiB, 0x62));
    const promise = ingestorFor(fixture, fetcher, {
      maxBytes: MiB,
      taskId,
    }).acquire('https://source.example/big.bin');
    await expect(promise).rejects.toMatchObject({ code: 'TOO_LARGE' });
    expect(fixture.puts()).toBe(0);
    await expectNoWorkspaceLeft(taskId);
  });
});

describe('the pinned copy wins over the live URL (retry idempotence)', () => {
  const pinned: SourceIngestionReceipt = {
    storageKey: KEY,
    versionId: 'v1',
    sha256: docSha,
    sizeBytes: doc.length,
  };

  it('answers the pinned receipt without any network or storage write', async () => {
    const fixture = makeStorageFixture();
    fixture.pin(pinned);
    const receipt = await ingestorFor(fixture, throwingFetcher(), {
      taskId: 'ingest-pinned-' + process.pid,
    }).acquire('https://source.example/gone-now.txt');
    expect(receipt).toEqual(pinned);
    expect(fixture.puts()).toBe(0);
    expect(fixture.resolves()).toBe(1);
  });

  it('keeps the pinned SHA-256 even when the URL now serves different bytes', async () => {
    const fixture = makeStorageFixture();
    fixture.pin(pinned);
    const { fetcher } = bodyFetcher(Buffer.from('totally different content', 'utf8'));
    const receipt = await ingestorFor(fixture, fetcher, {
      taskId: 'ingest-changed-' + process.pid,
    }).acquire('https://source.example/doc.txt');
    expect(receipt.sha256).toBe(docSha);
    expect(receipt.versionId).toBe('v1');
    expect(fixture.versions).toHaveLength(0);
  });

  it('reusePinned:false deliberately re-acquires into a NEW version', async () => {
    const fixture = makeStorageFixture();
    fixture.pin(pinned);
    const replacement = Buffer.from('re-ingested content', 'utf8');
    const { fetcher } = bodyFetcher(replacement);
    const receipt = await ingestorFor(fixture, fetcher, {
      reusePinned: false,
      taskId: 'ingest-force-' + process.pid,
    }).acquire('https://source.example/doc.txt');
    expect(receipt.versionId).toBe('v1');
    expect(receipt.sha256).toBe(createHash('sha256').update(replacement).digest('hex'));
    expect(receipt.sha256).not.toBe(docSha);
    expect(fixture.resolves()).toBe(0);
  });

  it('treats a corrupt pin as a fault instead of a licence to re-download', async () => {
    const fixture = makeStorageFixture();
    fixture.pin({ ...pinned, sha256: 'not-a-digest' });
    const { fetcher, calls } = bodyFetcher(doc);
    await expectIngestError(
      ingestorFor(fixture, fetcher, { taskId: 'ingest-corrupt-' + process.pid }).acquire('https://source.example/doc.txt'),
      502,
      'RECEIPT_INVALID'
    );
    expect(calls()).toBe(0);
    expect(fixture.puts()).toBe(0);
  });
});

describe('SSRF fence and real HTTP end to end (default pinned egress)', () => {
  // https on every blocked literal: with http the scheme gate answers first and
  // the egress fence would never be exercised (W-DATA03-ACQ-1 rounds left this
  // at rejects.toThrow() only — now pinned at the true layer).
  const blocked = [
    'https://127.0.0.1:1/x',
    'https://169.254.169.254/latest/meta-data/',
    'https://10.0.0.5/x',
    'https://[::1]:1/x',
  ];

  it.each(blocked)('writes nothing for a refused destination %s', async (raw) => {
    const fixture = makeStorageFixture();
    // No fetcher injected: the ingestor must fall back to the pinned egress.
    const ingestor = createSourceAcquisitionIngestor({
      storage: fixture.storage,
      storageKey: KEY,
      taskId: 'ingest-ssrf-' + process.pid,
      transfer: { maxBytes: MiB, timeoutMs: 3_000 },
    });
    await expect(ingestor.acquire(raw)).rejects.toMatchObject({
      name: 'SourceAcquisitionError',
      code: 'DESTINATION_DENIED',
    });
    expect(fixture.puts()).toBe(0);
    expect(fixture.versions).toHaveLength(0);
  });

  it('carries a 2 MiB document acquire -> stream -> pin over real loopback', async () => {
    const listener = await startListener();
    const big = Buffer.alloc(2 * MiB, 0x63);
    listener.setDefault({ kind: 'respond', status: 200, body: new Uint8Array(big) });
    const fixture = makeStorageFixture();
    const ingestor = createSourceAcquisitionIngestor({
      storage: fixture.storage,
      storageKey: KEY,
      taskId: 'ingest-e2e-' + process.pid,
      fileName: 'source.bin',
      transfer: {
        maxBytes: 8 * MiB,
        fetcher: localPinned(),
        allowHttp: true,
        timeoutMs: 30_000,
        idleTimeoutMs: 15_000,
      },
    });

    const first = await ingestor.acquire(listener.url('/source.bin'));
    const expectedSha = createHash('sha256').update(big).digest('hex');
    expect(first).toEqual({ storageKey: KEY, versionId: 'v1', sha256: expectedSha, sizeBytes: big.length });
    expect(fixture.versions[0]?.bytes.equals(big)).toBe(true);
    expect(listener.requests).toBe(1);

    // Retry: the pinned version answers; the URL is never fetched again.
    const second = await ingestor.acquire(listener.url('/source.bin'));
    expect(second).toEqual(first);
    expect(listener.requests).toBe(1);
    expect(fixture.versions).toHaveLength(1);
  });

  it('does not pin when the source answers an error status', async () => {
    const listener = await startListener();
    listener.setDefault({ kind: 'respond', status: 404, body: 'gone' });
    const fixture = makeStorageFixture();
    const ingestor = createSourceAcquisitionIngestor({
      storage: fixture.storage,
      storageKey: KEY,
      taskId: 'ingest-404-' + process.pid,
      transfer: { maxBytes: MiB, fetcher: localPinned(), allowHttp: true, timeoutMs: 15_000 },
    });
    await expect(ingestor.acquire(listener.url('/missing'))).rejects.toMatchObject({ code: 'SOURCE_REJECTED' });
    expect(fixture.puts()).toBe(0);
  });
});



/* ---------------- Δ17 ingestion task handler --------------------------- */

const ART_ID = '2f4a7c81-9d3e-4b2a-8c5f-1e6d9a0b3c47';

/** A fetcher that answers 302 `limit` times before it would serve bytes. */
function redirectChainFetcher(limit: number): SdkFetcher {
  let i = 0;
  return (async () => {
    i += 1;
    if (i <= limit) {
      return new Response(null, { status: 302, headers: { location: 'https://hop' + i + '.example/x' } });
    }
    return new Response('unreachable past the hop bound', { status: 200 });
  }) as SdkFetcher;
}

const asArtifact = (value: unknown): MaterializedArtifact => value as MaterializedArtifact;

describe('ingestion task handler (DATA-03 Δ17 wiring: acquire -> materialize -> gate-ready receipt, zero DB)', () => {
  function makeMaterializer(answer: () => unknown) {
    const calls: Array<{ task: IngestionTask; receipt: SourceIngestionReceipt }> = [];
    return {
      calls,
      fn: async (task: IngestionTask, receipt: SourceIngestionReceipt): Promise<MaterializedArtifact> => {
        calls.push({ task, receipt });
        return asArtifact(answer());
      },
    };
  }

  it('runs the whole claimed-task flow: fetch, pin, materialize, receipt with artifactId', async () => {
    const fixture = makeStorageFixture();
    const { fetcher, calls } = bodyFetcher(doc);
    const taskId = 'task-happy-' + process.pid;
    const materializer = makeMaterializer(() => ART_ID);
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, fetcher, { taskId }),
      materializeArtifact: materializer.fn,
    });

    const result = await handler.run({
      operationId: 'op-1',
      sourceUrl: 'https://source.example/doc.txt',
      input: { mode: 'parse' },
    });

    expect(result).toEqual({
      storageKey: KEY,
      versionId: 'v1',
      sha256: docSha,
      sizeBytes: doc.length,
      artifactId: ART_ID,
    });
    expect(materializer.calls).toHaveLength(1);
    expect(materializer.calls[0]?.receipt).toEqual({
      storageKey: KEY, versionId: 'v1', sha256: docSha, sizeBytes: doc.length,
    });
    expect(materializer.calls[0]?.task).toEqual({
      operationId: 'op-1',
      sourceUrl: 'https://source.example/doc.txt',
      input: { mode: 'parse' },
    });
    expect(calls()).toBe(1);
    expect(fixture.versions[0]?.bytes.equals(doc)).toBe(true);
    // The exact composition the Orchestrator gate performs — the READY envelope
    // must carry the pin WITH the materialization handle under the canonical key.
    const envelope = withIngestionSource({ mode: 'parse' }, result);
    expect(envelope[INGESTION_SOURCE_FIELD]).toMatchObject({ artifactId: ART_ID, sha256: docSha });
    expect('__source' in envelope).toBe(false);
    expect(resolveIngestionSource(envelope)?.artifactId).toBe(ART_ID);
    await expectNoWorkspaceLeft(taskId);
  });

  it('replays a fully materialized pin with no network and no second row write', async () => {
    const fixture = makeStorageFixture();
    const complete: SourceIngestionReceipt = {
      storageKey: KEY, versionId: 'v1', sha256: docSha, sizeBytes: doc.length, artifactId: ART_ID,
    };
    fixture.pin(complete);
    const materializer = makeMaterializer(() => ART_ID);
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, throwingFetcher(), { taskId: 'task-replay-' + process.pid }),
      materializeArtifact: materializer.fn,
    });
    const result = await handler.run({ operationId: 'op-2', sourceUrl: 'https://source.example/doc.txt' });
    expect(result).toEqual(complete);
    expect(materializer.calls).toHaveLength(0);
    expect(fixture.resolves()).toBe(1);
    expect(fixture.puts()).toBe(0);
  });

  it('accepts a full receipt echo from the materializer port', async () => {
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(doc);
    const receiptOfPin: SourceIngestionReceipt = {
      storageKey: KEY, versionId: 'v1', sha256: docSha, sizeBytes: doc.length,
    };
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, fetcher, { taskId: 'task-echo-' + process.pid }),
      materializeArtifact: async (_task, receipt) => ({ ...receipt, artifactId: ART_ID }),
    });
    const result = await handler.run({ operationId: 'op-3', sourceUrl: 'https://source.example/doc.txt' });
    expect(result.artifactId).toBe(ART_ID);
    expect(result.sha256).toBe(docSha);
  });

  const driftCases: Array<[string, Partial<SourceIngestionReceipt>]> = [
    ['digest', { sha256: 'f'.repeat(64) }],
    ['byte count', { sizeBytes: doc.length + 1 }],
    ['version handle', { versionId: 'v2' }],
    ['object key', { storageKey: KEY + '-other' }],
  ];
  it.each(driftCases)('refuses a materialized row that drifted on the %s', async (_label, drift) => {
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(doc);
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, fetcher, { taskId: 'task-drift-' + _label.replace(/\s+/g, '-') + '-' + process.pid }),
      materializeArtifact: async (_t, receipt) => asArtifact({ ...receipt, ...drift, artifactId: ART_ID }),
    });
    await expectIngestError(
      handler.run({ operationId: 'op-drift', sourceUrl: 'https://source.example/doc.txt' }),
      502,
      'PIN_MISMATCH'
    );
  });

  it.each([null, undefined])('keeps the gate shut when the row port answers %s', async (answer) => {
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(doc);
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, fetcher, { taskId: 'task-null-' + process.pid }),
      materializeArtifact: async () => asArtifact(answer),
    });
    await expectIngestError(
      handler.run({ operationId: 'op-null', sourceUrl: 'https://source.example/doc.txt' }),
      502,
      'MATERIALIZATION_FAILED'
    );
    // The pin survives for a retry — only the row act failed.
    expect(fixture.puts()).toBe(1);
  });

  it('refuses an echoed receipt that carries no artifact id', async () => {
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(doc);
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, fetcher, { taskId: 'task-nohandle-' + process.pid }),
      materializeArtifact: async (_t, receipt) => receipt,
    });
    await expectIngestError(
      handler.run({ operationId: 'op-nohandle', sourceUrl: 'https://source.example/doc.txt' }),
      502,
      'MATERIALIZATION_FAILED'
    );
  });

  it('routes a malformed artifact handle through the contract validator', async () => {
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(doc);
    const halfEcho = { artifactId: ART_ID };
    for (const bad of ['not-a-uuid', '', halfEcho]) {
      const handler = createIngestionTaskHandler({
        acquirer: ingestorFor(fixture, fetcher, { taskId: 'task-shape-' + process.pid }),
        materializeArtifact: async () => asArtifact(bad),
      });
      await expectIngestError(
        handler.run({ operationId: 'op-shape', sourceUrl: 'https://source.example/doc.txt' }),
        502,
        'RECEIPT_INVALID'
      );
    }
    expect(fixture.versions).toHaveLength(1);
  });

  it('types a materializer fault without leaking the adapter string or the URL', async () => {
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(doc);
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, fetcher, { taskId: 'task-rowfault-' + process.pid }),
      materializeArtifact: async () => {
        throw new Error('pg connection exploded at secrets-table');
      },
    });
    const promise = handler.run({
      operationId: 'op-rowfault',
      sourceUrl: 'https://source.example/private-doc.txt?token=secret-token',
    });
    await expectIngestError(promise, 502, 'MATERIALIZATION_FAILED');
    await promise.catch((err: Error) => {
      expect(err.message).not.toContain('pg connection');
      expect(err.message).not.toContain('source.example');
      expect(err.message).not.toContain('secret-token');
    });
  });

  const badTasks: Array<[string, unknown]> = [
    ['missing operationId', { sourceUrl: 'https://ok.example/x' }],
    ['blank operationId', { operationId: '', sourceUrl: 'https://ok.example/x' }],
    ['blank sourceUrl', { operationId: 'op', sourceUrl: '' }],
    ['newline-smuggled sourceUrl', { operationId: 'op', sourceUrl: 'https://ok.example/x\nAuthorization: Bearer evil' }],
    ['non-object input', { operationId: 'op', sourceUrl: 'https://ok.example/x', input: 'nope' }],
  ];
  it.each(badTasks)('refuses a malformed task before any socket: %s', async (_label, raw) => {
    const fixture = makeStorageFixture();
    const materializer = makeMaterializer(() => ART_ID);
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, throwingFetcher(), { taskId: 'task-shape-gate-' + process.pid }),
      materializeArtifact: materializer.fn,
    });
    await expectIngestError(
      handler.run(raw as IngestionTask),
      422,
      'TASK_INVALID'
    );
    expect(materializer.calls).toHaveLength(0);
    expect(fixture.puts()).toBe(0);
  });

  it('refuses a foreign acquirer that emits an uncontractual receipt', async () => {
    const materializer = makeMaterializer(() => ART_ID);
    const bogusAcquirer: { acquire(url: string): Promise<SourceIngestionReceipt> } = {
      acquire: async () => ({ storageKey: KEY, versionId: 'v1', sha256: 'nope', sizeBytes: 1 }),
    };
    const handler = createIngestionTaskHandler({
      acquirer: bogusAcquirer,
      materializeArtifact: materializer.fn,
    });
    await expectIngestError(
      handler.run({ operationId: 'op-bogus', sourceUrl: 'https://ok.example/x' }),
      502,
      'RECEIPT_INVALID'
    );
    expect(materializer.calls).toHaveLength(0);
  });

  it.each([
    'https://127.0.0.1:1/x',
    'https://169.254.169.254/latest/meta-data/',
  ])('never touches the row port for a fenced destination %s', async (raw) => {
    const fixture = makeStorageFixture();
    const materializer = makeMaterializer(() => ART_ID);
    const ingestor = createSourceAcquisitionIngestor({
      storage: fixture.storage,
      storageKey: KEY,
      taskId: 'task-ssrf-' + process.pid,
      transfer: { maxBytes: MiB, timeoutMs: 3_000 },
    });
    const handler = createIngestionTaskHandler({ acquirer: ingestor, materializeArtifact: materializer.fn });
    await expect(handler.run({ operationId: 'op-ssrf', sourceUrl: raw })).rejects.toMatchObject({
      name: 'SourceAcquisitionError',
      code: 'DESTINATION_DENIED',
      status: 403,
    });
    expect(materializer.calls).toHaveLength(0);
    expect(fixture.puts()).toBe(0);
  });

  it('never materializes an over-budget source', async () => {
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(Buffer.alloc(3 * MiB, 0x62));
    const materializer = makeMaterializer(() => ART_ID);
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, fetcher, { maxBytes: MiB, taskId: 'task-oversize-' + process.pid }),
      materializeArtifact: materializer.fn,
    });
    await expect(handler.run({ operationId: 'op-over', sourceUrl: 'https://source.example/big.bin' }))
      .rejects.toMatchObject({ name: 'SourceAcquisitionError', code: 'TOO_LARGE' });
    expect(materializer.calls).toHaveLength(0);
    expect(fixture.versions).toHaveLength(0);
  });

  it('never materializes a source that hops past the redirect bound', async () => {
    const fixture = makeStorageFixture();
    const materializer = makeMaterializer(() => ART_ID);
    const ingestor = createSourceAcquisitionIngestor({
      storage: fixture.storage,
      storageKey: KEY,
      taskId: 'task-hops-' + process.pid,
      transfer: { maxBytes: MiB, fetcher: redirectChainFetcher(4), timeoutMs: 5_000 },
    });
    const handler = createIngestionTaskHandler({ acquirer: ingestor, materializeArtifact: materializer.fn });
    await expect(handler.run({ operationId: 'op-hops', sourceUrl: 'https://source.example/doc.txt' }))
      .rejects.toMatchObject({ name: 'SourceAcquisitionError', code: 'REDIRECT_LIMIT' });
    expect(materializer.calls).toHaveLength(0);
    expect(fixture.puts()).toBe(0);
  });

  it('never materializes bytes that disagree with the expected digest', async () => {
    const fixture = makeStorageFixture();
    const { fetcher } = bodyFetcher(doc);
    const materializer = makeMaterializer(() => ART_ID);
    const taskId = 'task-hash-' + process.pid;
    const ingestor = createSourceAcquisitionIngestor({
      storage: fixture.storage,
      storageKey: KEY,
      taskId,
      transfer: { maxBytes: 8 * MiB, fetcher, expectedSha256: 'a'.repeat(64), timeoutMs: 5_000 },
    });
    const handler = createIngestionTaskHandler({ acquirer: ingestor, materializeArtifact: materializer.fn });
    await expect(handler.run({ operationId: 'op-hash', sourceUrl: 'https://source.example/doc.txt' }))
      .rejects.toMatchObject({ name: 'SourceAcquisitionError', code: 'HASH_MISMATCH' });
    expect(materializer.calls).toHaveLength(0);
    expect(fixture.puts()).toBe(0);
    await expectNoWorkspaceLeft(taskId);
  });

  it('finishes the job on retry: a materialization fault leaves the pin, the rerun adds the row without re-fetching', async () => {
    const fixture = makeStorageFixture();
    const { fetcher, calls } = bodyFetcher(doc);
    let rowBroken = true;
    const handler = createIngestionTaskHandler({
      acquirer: ingestorFor(fixture, fetcher, { taskId: 'task-retry-' + process.pid }),
      materializeArtifact: async () => {
        if (rowBroken) throw new Error('row insert timed out');
        return ART_ID;
      },
    });
    const task: IngestionTask = { operationId: 'op-retry', sourceUrl: 'https://source.example/doc.txt' };
    await expectIngestError(handler.run(task), 502, 'MATERIALIZATION_FAILED');
    expect(calls()).toBe(1);
    expect(fixture.puts()).toBe(1);

    rowBroken = false;
    const second = await handler.run(task);
    expect(second).toEqual({
      storageKey: KEY, versionId: 'v1', sha256: docSha, sizeBytes: doc.length, artifactId: ART_ID,
    });
    expect(calls()).toBe(1); // pinned copy answers; the URL was fetched exactly once
    expect(fixture.puts()).toBe(1); // no duplicate immutable version
  });
});
