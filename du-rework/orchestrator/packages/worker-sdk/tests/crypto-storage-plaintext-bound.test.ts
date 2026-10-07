/**
 * RFX-08 parity — the plaintext bound on streaming decrypt, worker-sdk side.
 *
 * `tests/crypto-seam.test.ts` proves the two implementations are byte-identical
 * as SOURCE. This file proves the bound actually BEHAVES on this side, because
 * source identity is a proxy: a worker build that diverged would still fail that
 * guard, but a behaviour change on either side that kept the text aligned would
 * not be caught here either. Both are wanted.
 *
 * The bound is CRYPTO_STORAGE_MAX_DECRYPT_BYTES (64 MiB) — the same number as
 * MAX_DECRYPT_BYTES in the orchestrator `server.ts` and the ingress maxBytes the
 * encrypted delivery path reads through: one cap for one process.
 */
import {
  CRYPTO_STORAGE_MAX_DECRYPT_BYTES,
  CryptoStorageError,
  CryptoStorageFacade,
  type CryptoKeyProvider,
  type CryptoStorageContext,
  type EncryptedStorageManifest,
  type WrapDekInput,
  type WrappedDek,
} from '../src/crypto-storage';

class MemoryKeyProvider implements CryptoKeyProvider {
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
// encryptStream refuses anything at or below the 5 MiB single-shot limit, so
// every chunked fixture here must clear that first.
const ARTIFACT_BYTES = 6 * MIB;

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
async function chunkedArtifact(
  provider: MemoryKeyProvider,
  bytes: number,
  maxPlaintextBytes?: number,
): Promise<{ manifest: EncryptedStorageManifest; ciphertext: Buffer; plaintext: Buffer }> {
  const facade = new CryptoStorageFacade(
    provider,
    maxPlaintextBytes === undefined ? {} : { maxPlaintextBytes },
  );
  const plaintext = Buffer.alloc(bytes, 0x41);
  const { ciphertext, manifest } = facade.encryptStream(slices(plaintext, [256 * 1024]), {
    ...context,
    keyRef: 'artifact-key',
  });
  // The manifest resolves only after the ciphertext stream completes.
  const body = await collect(ciphertext);
  return { manifest: await manifest, ciphertext: body, plaintext };
}

/**
 * The streaming backstop is unreachable through decryptStream by construction:
 * the eager check refuses the declared total and validateManifest pins chunk
 * sizes to that total. Driving the generator seam directly exercises the second
 * bound rather than assuming it.
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

describe('RFX-08 plaintext bound (worker-sdk parity)', () => {
  it('defaults the bound to the delivery cap and rejects nonsensical overrides', () => {
    // Same number as MAX_DECRYPT_BYTES (server.ts) and the ingress maxBytes.
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

    const facade = new CryptoStorageFacade(provider);
    const stream = facade.decryptStream(
      (async function* () { yield ciphertext; })(),
      manifest,
      context,
    );
    expect(await collect(stream)).toEqual(plaintext);
  });

  it('keeps an artifact at exactly the bound readable', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext, plaintext } = await chunkedArtifact(
      provider,
      ARTIFACT_BYTES,
      ARTIFACT_BYTES,
    );

    const facade = new CryptoStorageFacade(provider, { maxPlaintextBytes: ARTIFACT_BYTES });
    const stream = facade.decryptStream(
      (async function* () { yield ciphertext; })(),
      manifest,
      context,
    );
    expect(await collect(stream)).toEqual(plaintext);
  });

  it('refuses an over-limit artifact before touching the body or the key provider', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext } = await chunkedArtifact(provider, ARTIFACT_BYTES);
    const before = provider.unwrapCalls;

    const facade = new CryptoStorageFacade(provider, { maxPlaintextBytes: MIB });
    // The refusal must be eager: the check reads the manifest, never the body.
    expect(() => facade.decryptStream(
      (async function* () { yield ciphertext; })(),
      manifest,
      context,
    )).toThrow(/plaintext decryption limit/);
    expect(provider.unwrapCalls).toBe(before);
  });

  it('reports a size refusal as SIZE_LIMIT, not as an authentication failure', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext } = await chunkedArtifact(provider, ARTIFACT_BYTES);
    const facade = new CryptoStorageFacade(provider, { maxPlaintextBytes: MIB });

    try {
      facade.decryptStream((async function* () { yield ciphertext; })(), manifest, context);
      throw new Error('expected the over-limit artifact to be refused');
    } catch (error) {
      expect(error).toBeInstanceOf(CryptoStorageError);
      expect((error as CryptoStorageError).code).toBe('SIZE_LIMIT');
    }
  });

  it('stops emitting plaintext when the running total crosses the bound', async () => {
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext } = await chunkedArtifact(provider, ARTIFACT_BYTES);
    const facade = new CryptoStorageFacade(provider);
    const drive = chunkGeneratorOf(facade);

    const emitted: number[] = [];
    await expect((async () => {
      for await (const chunk of drive(
        (async function* () { yield ciphertext; })(),
        manifest,
        context,
        MIB,
      )) {
        emitted.push(chunk.length);
      }
    })()).rejects.toThrow(/plaintext decryption limit/);

    // The refusal lands before the yield, so the caller never holds the chunk
    // that crossed the limit.
    expect(emitted.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(MIB);
  });

  it('bounds what a collecting reader retains (memory evidence, not OOM)', async () => {
    // Driven through the generator seam on purpose. Through decryptStream the
    // bound cannot be observed incrementally: the eager check reads the
    // DECLARED total and refuses synchronously before any chunk is handed
    // over. What a collector must not be able to do is accumulate without
    // limit once it is reading, which is the generator's backstop.
    const provider = new MemoryKeyProvider();
    const { manifest, ciphertext } = await chunkedArtifact(provider, ARTIFACT_BYTES);
    const facade = new CryptoStorageFacade(provider);
    const drive = chunkGeneratorOf(facade);

    let retained = 0;
    await expect((async () => {
      for await (const chunk of drive(
        (async function* () { yield ciphertext; })(),
        manifest,
        context,
        MIB,
      )) {
        retained += chunk.length;
      }
    })()).rejects.toThrow(/plaintext decryption limit/);
    expect(retained).toBeLessThanOrEqual(MIB);
  });
});
