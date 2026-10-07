/**
 * RFX-08 — the plaintext bound on streaming decrypt.
 *
 * The read paths do not stream what they serve: decryptStoredArtifact collects
 * every chunk the facade hands it and returns one Buffer. Without a bound, that
 * collect is whatever the artifact happens to be — up to the 8 GiB upload cap —
 * in one process' heap. The facade therefore refuses an over-limit artifact
 * BEFORE it produces plaintext, and refuses again the moment the running total
 * crosses the limit, because a caller that collects is holding every chunk it
 * has already been given.
 *
 * The bound is CRYPTO_STORAGE_MAX_DECRYPT_BYTES (64 MiB), the same number as
 * MAX_DECRYPT_BYTES in server.ts and the ingress maxBytes the encrypted
 * delivery path reads through: one cap for one process, so no path can quietly
 * raise what the others refuse.
 */
import {
  CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
  CRYPTO_STORAGE_MAX_DECRYPT_BYTES,
  CryptoStorageError,
  CryptoStorageFacade,
  type CryptoStorageContext,
  type EncryptedStorageManifest,
} from '../src/modules/encryption/crypto-storage-facade';
import type { KeyProvider, WrappedDek, WrapDekInput } from '../src/modules/encryption/vault-transit-provider';

class MemoryKeyProvider implements Pick<KeyProvider, 'wrapDek' | 'unwrapDek'> {
  private readonly keys = new Map<string, Buffer>();
  public wrapCalls = 0;
  public unwrapCalls = 0;

  public async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
    this.wrapCalls++;
    const id = 'wrapped-' + this.wrapCalls;
    this.keys.set(id, Buffer.from(input.dek));
    return {
      keyRef: input.keyRef,
      keyVersion: input.keyVersion ?? 1,
      ciphertext: 'vault:v' + (input.keyVersion ?? 1) + ':' + id,
    };
  }

  public async unwrapDek(value: WrappedDek): Promise<Buffer> {
    this.unwrapCalls++;
    const key = this.keys.get(value.ciphertext.split(':').at(-1) ?? '');
    if (!key) throw new Error('unknown wrapped key');
    return Buffer.from(key);
  }
}

const context: CryptoStorageContext = {
  tenantId: 'tenant-a',
  artifactId: 'artifact-42',
  objectVersion: 'v7',
};

const MIB = 1024 * 1024;
const ARTIFACT_BYTES = 12 * MIB;

async function collect(source: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}

async function* slices(bytes: Buffer, boundaries: readonly number[]): AsyncGenerator<Buffer> {
  let offset = 0;
  for (const boundary of boundaries) {
    if (offset >= bytes.length) break;
    const end = Math.min(bytes.length, offset + boundary);
    yield bytes.subarray(offset, end);
    offset = end;
  }
  if (offset < bytes.length) yield bytes.subarray(offset);
}

/** One real chunked artifact, encrypted by the same code path production uses. */
async function chunkedArtifact(provider: MemoryKeyProvider, bytes: number): Promise<{
  readonly manifest: EncryptedStorageManifest;
  readonly ciphertext: Buffer;
  readonly plaintext: Buffer;
}> {
  const facade = new CryptoStorageFacade(provider);
  const plaintext = Buffer.alloc(bytes, 0x41);
  const { ciphertext, manifest } = facade.encryptStream(slices(plaintext, [256 * 1024]), {
    ...context,
    keyRef: 'artifact-key',
  });
  // The manifest resolves only after the ciphertext stream has completed,
  // so the body has to be drained first.
  const body = await collect(ciphertext);
  return { manifest: await manifest, ciphertext: body, plaintext };
}

/**
 * The streaming backstop is unreachable through decryptStream by construction:
 * the eager check refuses the declared total, and validateManifest pins the
 * chunk sizes to that total. These tests drive the generator seam directly so
 * the second bound is exercised rather than assumed.
 */
interface ChunkGeneratorSeam {
  decryptChunkGenerator(
    ciphertext: AsyncIterable<Uint8Array>,
    manifest: EncryptedStorageManifest,
    context: CryptoStorageContext,
    maxPlaintextBytes: number,
  ): AsyncGenerator<Buffer, void, void>;
}

function chunkGeneratorOf(facade: CryptoStorageFacade): ChunkGeneratorSeam['decryptChunkGenerator'] {
  return (facade as unknown as ChunkGeneratorSeam).decryptChunkGenerator.bind(facade);
}

describe('RFX-08 plaintext bound', () => {
  it('defaults the bound to the delivery cap and rejects nonsensical overrides', () => {
    // Same number as MAX_DECRYPT_BYTES (server.ts) and the ingress maxBytes:
    // if one of those moves, this assertion is where the drift should surface.
    expect(CRYPTO_STORAGE_MAX_DECRYPT_BYTES).toBe(64 * MIB);

    const provider = new MemoryKeyProvider();
    for (const bad of [0, -1, 1.5, Number.NaN, CRYPTO_STORAGE_MAX_DECRYPT_BYTES + 1]) {
      expect(() => new CryptoStorageFacade(provider, { maxPlaintextBytes: bad }))
        .toThrow(/maxPlaintextBytes/);
    }
    expect(() => new CryptoStorageFacade(provider, { maxPlaintextBytes: 1 })).not.toThrow();
    expect(() => new CryptoStorageFacade(provider, {
      maxPlaintextBytes: CRYPTO_STORAGE_MAX_DECRYPT_BYTES,
    })).not.toThrow();
  });

  it('round-trips a chunked artifact that stays under the bound', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext, plaintext } = await chunkedArtifact(provider, ARTIFACT_BYTES);
    expect(manifest.totalSizeBytes).toBe(ARTIFACT_BYTES);
    expect(manifest.totalSizeBytes).toBeLessThan(CRYPTO_STORAGE_MAX_DECRYPT_BYTES);

    const facade = new CryptoStorageFacade(provider);
    const decrypted = await collect(facade.decryptStream(slices(ciphertext, [1024]), manifest, context));

    expect(decrypted.equals(plaintext)).toBe(true);
    expect(provider.unwrapCalls).toBe(1);
  });

  it('keeps an artifact at exactly the bound readable', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext, plaintext } = await chunkedArtifact(provider, ARTIFACT_BYTES);

    const facade = new CryptoStorageFacade(provider, { maxPlaintextBytes: manifest.totalSizeBytes });

    const decrypted = await collect(
      facade.decryptStream(slices(ciphertext, [1024]), manifest, context),
    );

    expect(decrypted.equals(plaintext)).toBe(true);
  });

  it('refuses an over-limit artifact before touching the body or the key provider', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext } = await chunkedArtifact(provider, ARTIFACT_BYTES);
    const facade = new CryptoStorageFacade(provider, { maxPlaintextBytes: 6 * MIB });
    const unwrapsBefore = provider.unwrapCalls;

    let bodyTouched = false;
    const body = (async function* unconsumed(): AsyncGenerator<Buffer> {
      bodyTouched = true;
      yield ciphertext;
    })();

    // decryptStream validates eagerly and is not async, so the refusal is a
    // synchronous throw, exactly like the maxChunks refusal.
    let thrown: CryptoStorageError | undefined;
    try {
      facade.decryptStream(body, manifest, context);
    } catch (error) {
      thrown = error as CryptoStorageError;
    }

    expect(thrown).toBeInstanceOf(CryptoStorageError);
    expect(thrown?.code).toBe('SIZE_LIMIT');
    expect(provider.unwrapCalls).toBe(unwrapsBefore);
    expect(bodyTouched).toBe(false);
  });

  it('reports a size refusal as SIZE_LIMIT, not as an authentication failure', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext } = await chunkedArtifact(provider, ARTIFACT_BYTES);
    const facade = new CryptoStorageFacade(provider, { maxPlaintextBytes: 6 * MIB });

    // The caller must be able to tell "this artifact does not fit" from "this
    // artifact did not authenticate"; collapsing the two sends operators
    // hunting for a key problem that never existed. The refusal arrives as a
    // synchronous throw, so assert it as one rather than as a rejected stream.
    let thrown: CryptoStorageError | undefined;
    try {
      const stream = facade.decryptStream(slices(ciphertext, [1024]), manifest, context);
      void collect(stream).catch(() => undefined);
    } catch (error) {
      thrown = error as CryptoStorageError;
    }

    expect(thrown?.code).toBe('SIZE_LIMIT');
    expect(thrown?.code).not.toBe('AUTHENTICATION_FAILED');
  });

  it('stops emitting plaintext when the running total crosses the bound', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext } = await chunkedArtifact(provider, ARTIFACT_BYTES);
    const bound = 5 * MIB;
    const facade = new CryptoStorageFacade(provider);

    let handed = 0;
    let thrown: CryptoStorageError | undefined;
    try {
      const stream = chunkGeneratorOf(facade)(
        slices(ciphertext, [1024]),
        manifest,
        context,
        bound,
      );
      for await (const chunk of stream) handed += chunk.length;
    } catch (error) {
      thrown = error as CryptoStorageError;
    }

    expect(thrown?.code).toBe('SIZE_LIMIT');
    // Some plaintext really did flow, so this is a streaming stop and not a
    // refusal that never started.
    expect(handed).toBeGreaterThan(0);
    // At most the bound plus the chunk in flight, and strictly less than the
    // whole artifact: the collector can never be handed the entire file.
    expect(handed).toBeLessThanOrEqual(bound + CRYPTO_STORAGE_CHUNK_SIZE_BYTES);
    expect(handed).toBeLessThan(manifest.totalSizeBytes);
  });

  it('bounds what a collecting reader retains (RSS evidence, not OOM)', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext } = await chunkedArtifact(provider, ARTIFACT_BYTES);
    const bound = 5 * MIB;
    const facade = new CryptoStorageFacade(provider);

    // Exactly the collect decryptStoredArtifact performs: keep every chunk the
    // facade hands over, then concatenate. Retention, not throughput, is what
    // decides peak RSS here.
    const retained: Buffer[] = [];
    let retainedBytes = 0;
    let peakRss = 0;
    let thrown: CryptoStorageError | undefined;
    const baselineRss = process.memoryUsage().rss;
    try {
      const stream = chunkGeneratorOf(facade)(slices(ciphertext, [1024]), manifest, context, bound);
      for await (const chunk of stream) {
        retained.push(chunk);
        retainedBytes += chunk.length;
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      }
    } catch (error) {
      thrown = error as CryptoStorageError;
      peakRss = Math.max(peakRss, process.memoryUsage().rss);
    }

    process.stdout.write(
      '[rfx08] artifact=' + manifest.totalSizeBytes
      + ' bound=' + bound
      + ' retained=' + retainedBytes
      + ' peakRssDelta=' + (peakRss - baselineRss)
      + ' code=' + String(thrown?.code)
      + '\n',
    );

    expect(thrown?.code).toBe('SIZE_LIMIT');
    // The bound that a collect can actually hit is retention, and retention is
    // deterministic: what the reader holds never reaches the artifact size.
    // The RSS sample above is recorded rather than asserted - inside a jest
    // worker the heap is shared with the compiler and the collector, so its
    // growth is not attributable to this loop. The process-level ceiling is
    // measured separately (see the receipt) with a stable baseline.
    expect(retainedBytes).toBeLessThanOrEqual(bound + CRYPTO_STORAGE_CHUNK_SIZE_BYTES);
    expect(retainedBytes).toBeLessThan(manifest.totalSizeBytes);
  });
});
