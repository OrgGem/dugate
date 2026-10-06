import { Readable } from 'node:stream';
import {
  CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
  CryptoStorageError,
  CryptoStorageFacade,
  EncryptedStorageManifest,
} from '../src/modules/encryption/crypto-storage-facade';
import { KeyProvider, WrappedDek, WrapDekInput } from '../src/modules/encryption/vault-transit-provider';

class MemoryKeyProvider implements Pick<KeyProvider, 'wrapDek' | 'unwrapDek'> {
  private readonly keys = new Map<string, Buffer>();
  public wrapCalls = 0;
  public unwrapCalls = 0;
  public failWrap = false;
  public failUnwrap = false;

  public async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
    this.wrapCalls++;
    if (this.failWrap) throw new Error('offline vault');
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
    if (this.failUnwrap) throw new Error('offline vault');
    const id = value.ciphertext.split(':').at(-1) ?? '';
    const key = this.keys.get(id);
    if (!key) throw new Error('unknown wrapped key');
    return Buffer.from(key);
  }
}

const context = {
  tenantId: 'tenant-a',
  artifactId: 'artifact-42',
  objectVersion: 'v7',
};

async function collect(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk as Uint8Array));
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

function sampleBytes(length: number): Buffer {
  return Buffer.alloc(length, 0x31);
}

function cloneManifest(manifest: EncryptedStorageManifest): EncryptedStorageManifest {
  return JSON.parse(JSON.stringify(manifest)) as EncryptedStorageManifest;
}

describe('CryptoStorageFacade', () => {
  test('encrypts and decrypts a single object with context-bound AES-256-GCM', async () => {
    const provider = new MemoryKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    const plaintext = Buffer.from('private document body', 'utf8');
    const encrypted = await facade.encrypt(plaintext, { ...context, keyRef: 'artifact-key' });

    expect(encrypted.algorithm).toBe('aes-256-gcm');
    expect(encrypted.ciphertext).not.toEqual(plaintext);
    expect(encrypted.nonce).toMatch(/^[A-Za-z0-9+/]{16}$/);
    expect(encrypted.tag).toMatch(/^[A-Za-z0-9+/]{22}==$/);
    expect(encrypted.dek.keyRef).toBe('artifact-key');
    expect(provider.wrapCalls).toBe(1);
    await expect(facade.decrypt(encrypted, context)).resolves.toEqual(plaintext);
    expect(provider.unwrapCalls).toBe(1);
  });

  test('rejects wrong tenant, artifact, or immutable object version', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    const encrypted = await facade.encrypt(Buffer.from('context-bound'), { ...context, keyRef: 'artifact-key' });

    await expect(facade.decrypt(encrypted, { ...context, tenantId: 'tenant-b' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    await expect(facade.decrypt(encrypted, { ...context, artifactId: 'artifact-other' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    await expect(facade.decrypt(encrypted, { ...context, objectVersion: 'v8' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  test('fails closed on ciphertext, tag, metadata, and key-provider tampering', async () => {
    const provider = new MemoryKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    const encrypted = await facade.encrypt(Buffer.from('tamper evidence'), { ...context, keyRef: 'artifact-key' });
    const changedCiphertext = { ...encrypted, ciphertext: Buffer.from(encrypted.ciphertext) };
    changedCiphertext.ciphertext[0] = changedCiphertext.ciphertext[0]! ^ 0x80;
    const changedTag = { ...encrypted, tag: Buffer.alloc(16).toString('base64') };
    const changedDigest = { ...encrypted, plaintextSha256: '0'.repeat(64) };

    await expect(facade.decrypt(changedCiphertext, context)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    await expect(facade.decrypt(changedTag, context)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    await expect(facade.decrypt(changedDigest, context)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });

    provider.failUnwrap = true;
    await expect(facade.decrypt(encrypted, context)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
  });

  test('does not expose plaintext when DEK wrapping fails and enforces the single-shot limit', async () => {
    const provider = new MemoryKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    provider.failWrap = true;
    await expect(facade.encrypt(Buffer.from('secret'), { ...context, keyRef: 'artifact-key' }))
      .rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
    provider.failWrap = false;
    await expect(facade.encrypt(sampleBytes(5 * 1024 * 1024 + 1), { ...context, keyRef: 'artifact-key' }))
      .rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(facade.encrypt(Buffer.alloc(0), { ...context, keyRef: 'artifact-key' }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  test('encrypts arbitrary source boundaries into ordered, unique-nonce authenticated chunks', async () => {
    const provider = new MemoryKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    const plaintext = sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 1024 * 1024 + 19);
    const encrypted = facade.encryptStream(slices(plaintext, [13, 4_000_000, 9, 500_000]), {
      ...context,
      keyRef: 'artifact-key',
      keyVersion: 3,
    });
    const [ciphertext, manifest] = await Promise.all([
      collect(encrypted.ciphertext),
      encrypted.manifest,
    ]);

    expect(ciphertext).toHaveLength(plaintext.length);
    expect(manifest.totalChunks).toBe(2);
    expect(manifest.totalSizeBytes).toBe(plaintext.length);
    expect(manifest.chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(manifest.chunks.map((chunk) => chunk.sizeBytes)).toEqual([
      CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
      plaintext.length - CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
    ]);
    expect(new Set(manifest.chunks.map((chunk) => chunk.nonce)).size).toBe(2);
    expect(manifest.manifestMac).toMatch(/^[A-Za-z0-9+/]{43}=$/);
    expect(manifest.dek.keyVersion).toBe(3);

    const decrypted = await collect(facade.decryptStream(slices(ciphertext, [1, 4_200_001, 27]), manifest, context));
    expect(decrypted.equals(plaintext)).toBe(true);
  });

  test('rejects manifest tampering, reordered chunks, and context replay before releasing plaintext', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    const plaintext = sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 2 * 1024 * 1024);
    const encrypted = facade.encryptStream(slices(plaintext, [2_000_000]), { ...context, keyRef: 'artifact-key' });
    const [ciphertext, manifest] = await Promise.all([collect(encrypted.ciphertext), encrypted.manifest]);

    const changedHash = { ...cloneManifest(manifest), fileSha256: '0'.repeat(64) };
    const reordered = {
      ...cloneManifest(manifest),
      chunks: [manifest.chunks[1]!, manifest.chunks[0]!],
    };
    const seen: Buffer[] = [];
    const changedStream = facade.decryptStream(slices(ciphertext, [ciphertext.length]), changedHash, context);
    await expect((async () => {
      for await (const chunk of changedStream) seen.push(Buffer.from(chunk as Uint8Array));
    })()).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    expect(seen).toHaveLength(0);
    expect(() => facade.decryptStream(slices(ciphertext, [ciphertext.length]), reordered, context))
      .toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
    expect(() => facade.decryptStream(slices(ciphertext, [ciphertext.length]), manifest, {
      ...context,
      objectVersion: 'v8',
    })).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });

  test('rejects ciphertext chunk swaps, tampering, truncation, and appended bytes', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    const plaintext = sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 1024 * 1024 + 64);
    const encrypted = facade.encryptStream(slices(plaintext, [plaintext.length]), { ...context, keyRef: 'artifact-key' });
    const [ciphertext, manifest] = await Promise.all([collect(encrypted.ciphertext), encrypted.manifest]);
    const tampered = Buffer.from(ciphertext);
    tampered[0] = tampered[0]! ^ 0x01;
    const swapped = Buffer.concat([
      ciphertext.subarray(CRYPTO_STORAGE_CHUNK_SIZE_BYTES),
      ciphertext.subarray(0, CRYPTO_STORAGE_CHUNK_SIZE_BYTES),
    ]);

    await expect(collect(facade.decryptStream(slices(tampered, [tampered.length]), manifest, context)))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    await expect(collect(facade.decryptStream(slices(swapped, [swapped.length]), manifest, context)))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    await expect(collect(facade.decryptStream(slices(ciphertext.subarray(0, ciphertext.length - 1), [100]), manifest, context)))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
    await expect(collect(facade.decryptStream(slices(Buffer.concat([ciphertext, Buffer.from([0])]), [ciphertext.length]), manifest, context)))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  test('fails incomplete chunked encryption and key-service outages without a usable manifest', async () => {
    const provider = new MemoryKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    const small = facade.encryptStream(slices(Buffer.from('too small'), [4]), { ...context, keyRef: 'artifact-key' });
    await expect(collect(small.ciphertext)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(small.manifest).rejects.toMatchObject({ code: 'SIZE_LIMIT' });

    provider.failWrap = true;
    const outage = facade.encryptStream(slices(sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 2 * 1024 * 1024), [1024]), {
      ...context,
      keyRef: 'artifact-key',
    });
    await expect(collect(outage.ciphertext)).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
    await expect(outage.manifest).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
  });

  test('fails a source error without resolving an authenticated manifest', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    async function* brokenSource(): AsyncGenerator<Buffer> {
      yield sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES);
      throw new Error('source disconnected');
    }
    const encrypted = facade.encryptStream(brokenSource(), { ...context, keyRef: 'artifact-key' });

    await expect(collect(encrypted.ciphertext)).rejects.toThrow('source disconnected');
    await expect(encrypted.manifest).rejects.toThrow('source disconnected');
  });

  test('enforces the configured manifest chunk bound', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider(), { maxChunks: 1 });
    const encrypted = facade.encryptStream(slices(sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 2 * 1024 * 1024), [4096]), {
      ...context,
      keyRef: 'artifact-key',
    });
    await expect(collect(encrypted.ciphertext)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(encrypted.manifest).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
  });
});

// W-CR28-01-MANIFEST-CEILING (delta 71).
//
// There are TWO different ceilings and they live in TWO different files, which
// is the whole point of this block:
//
//   1. COUNT  - the facade's own `maxChunks` (default 65_536). Exceeding it is
//      refused by `validateManifest` with `INVALID_MANIFEST`. Lives in
//      crypto-storage-facade.ts, so it is pinned HERE.
//
//   2. BYTES - `MAX_MANIFEST_BYTES = 8 MiB` in server.ts, enforced by
//      `readStreamBounded` when the S3 adapter reads the sidecar, raising
//      `HttpError(413, 'TOO_LARGE')`. That is NOT in the facade and CANNOT be
//      pinned from this file; it is asserted here only as an arithmetic fact.
//
// The two ceilings are not consistent: a manifest the facade is perfectly happy
// to EMIT at its own default ceiling is one the server adapter will REFUSE to
// read. That is a real coupling, and the test that would catch a regression in
// it does not exist outside this file.
describe('delta 71: the facade count ceiling is fail-closed', () => {
  it('a manifest declaring more chunks than maxChunks is refused', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider(), { maxChunks: 2 });
    const ctx = { ...context };
    const { ciphertext, manifest } = facade.encryptStream(
      slices(sampleBytes(12 * 1024 * 1024), [CRYPTO_STORAGE_CHUNK_SIZE_BYTES]),
      { ...ctx, keyRef: 'du-test' },
    );
    await expect(collect(ciphertext)).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
    await expect(manifest).rejects.toMatchObject({ code: 'SIZE_LIMIT' });
  });

  it('a manifest that merely CLAIMS a huge totalChunks is refused, not trusted', async () => {
    // validateManifest checks `totalChunks > maxChunks` in the same guard as
    // `chunks.length !== totalChunks`, so a manifest claiming 65_537 chunks is
    // refused before the MAC is ever verified. Cheap: no real chunk data needed.
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    const forged = {
      version: 1,
      algorithm: 'aes-256-gcm',
      chunkSizeBytes: CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
      totalChunks: 65_537,
      totalSizeBytes: 300 * 1024 * 1024,
      fileSha256: 'a'.repeat(64),
      contextAad: Buffer.from('{}', 'utf8').toString('base64'),
      chunks: new Array(65_537).fill(0).map((_, i) => ({
        index: i, nonce: 'AAAAAAAAAAAAAAAA', tag: 'AAAAAAAAAAAAAAAAAAAAAA',
        sha256: 'a'.repeat(64), sizeBytes: CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
      })),
      dek: { keyRef: 'du-test', keyVersion: 1, ciphertext: 'vault:v1:wrapped-1' },
      manifestMac: 'AAAA',
    };
    // decryptStream is NOT async: validateManifest throws synchronously, so the
    // call must sit inside a thunk or the throw escapes before expect sees it.
    expect(() =>
      facade.decryptStream(
        (async function* () { yield Buffer.from('x', 'utf8'); })(),
        forged as never,
        { ...context },
      ),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });
});

describe('delta 71: the BYTE ceiling and the COUNT ceiling disagree', () => {
  // The server adapter reads a sidecar under MAX_MANIFEST_BYTES = 8 MiB and
  // fails closed with HttpError(413, 'TOO_LARGE') past that. The facade, at its
  // own default ceiling, will happily produce a LARGER manifest. So the range of
  // chunk counts the facade accepts is wider than the range the server can read
  // back, and nothing in either file notices.
  const MAX_MANIFEST_BYTES = 8 * 1024 * 1024;
  const FACADE_DEFAULT_MAX_CHUNKS = 65_536;

  function manifestEntry(index: number) {
    return {
      index,
      nonce: Buffer.alloc(12, 0x01).toString('base64'),
      tag: Buffer.alloc(16, 0x02).toString('base64'),
      sha256: 'a'.repeat(64),
      sizeBytes: CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
    };
  }

  function serializedManifestBytes(totalChunks: number): number {
    return Buffer.byteLength(JSON.stringify({
      version: 1,
      algorithm: 'aes-256-gcm',
      chunkSizeBytes: CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
      totalChunks,
      totalSizeBytes: totalChunks * CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
      fileSha256: 'a'.repeat(64),
      contextAad: Buffer.from('{"format":"du-crypto-storage-v1"}', 'utf8').toString('base64'),
      chunks: new Array(totalChunks).fill(0).map((_, i) => manifestEntry(i)),
      dek: { keyRef: 'du-artifact-v1', keyVersion: 1, ciphertext: 'vault:v1:wrapped-1' },
      manifestMac: 'a'.repeat(64),
    }), 'utf8');
  }

  it('a manifest at the facade DEFAULT ceiling is LARGER than the 8 MiB read limit', () => {
    const bytes = serializedManifestBytes(FACADE_DEFAULT_MAX_CHUNKS);
    // The facade accepts up to 65_536 chunks, but a manifest that large is
    // ~4x past the byte ceiling the server adapter enforces. This is the
    // concrete form of delta 71: a valid object can become unreadable purely
    // because it is large.
    expect(bytes).toBeGreaterThan(MAX_MANIFEST_BYTES);
  });

  it('the byte ceiling is crossed well BEFORE the count ceiling', () => {
    // Locate the chunk count where the serialized manifest passes 8 MiB. Every
    // count at or above this is accepted by the facade and rejected by the
    // server adapter on read.
    let crossing = -1;
    for (let n = 1_000; n <= FACADE_DEFAULT_MAX_CHUNKS; n += 1_000) {
      if (serializedManifestBytes(n) > MAX_MANIFEST_BYTES) { crossing = n; break; }
    }
    expect(crossing).toBeGreaterThan(0);
    expect(crossing).toBeLessThan(FACADE_DEFAULT_MAX_CHUNKS);
  });
});

// W-CR28-01-FAILCLOSED-BYTE-LIMITS.
//
// The packet asks to pin 413 TOO_LARGE and INVALID_MANIFEST. Measured first:
//
//  - `INVALID_MANIFEST` IS reachable from this file and is pinned below.
//  - `413 TOO_LARGE` is NOT. It is raised by `readStreamBounded` in server.ts,
//    which is module-private and not exported, so there is no way to exercise it
//    from here without editing production code the task forbids. That is the
//    same wall as delta 74; see the receipt rather than a fake test here.
//
// What was ALREADY covered by the existing suite, so deliberately not duplicated:
// truncated ciphertext, appended/trailing bytes, chunk swap, body tampering
// (all AUTHENTICATION_FAILED), plus SIZE_LIMIT for single-shot and chunk-count
// ceilings. Those are the stream over/under its declared length.
//
// What this block adds is the two byte guards that had NO test at all:
//   1. a manifest whose `contextAad` exceeds the facade's 2048-char cap -> the
//      one place the facade bounds manifest CONTENT rather than chunk COUNT;
//   2. a ciphertext stream yielding a non-Uint8Array value -> INVALID_INPUT,
//      which is what stops a string/Buffer mix from being silently coerced.
describe('fail-closed byte guards: manifest content cap and stream chunk typing', () => {
  async function sealedTwoChunks() {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    const plaintext = sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 1024 * 1024 + 64);
    const encrypted = facade.encryptStream(slices(plaintext, [plaintext.length]), {
      ...context,
      keyRef: 'artifact-key',
    });
    const [ciphertext, manifest] = await Promise.all([
      collect(encrypted.ciphertext),
      encrypted.manifest,
    ]);
    return { facade, plaintext, ciphertext, manifest };
  }

  it('a manifest whose contextAad exceeds the 2048-char cap is refused', async () => {
    const { facade, ciphertext, manifest } = await sealedTwoChunks();
    // Bloating contextAad must be refused on the LENGTH rule, before the MAC is
    // ever checked — otherwise an attacker can pad the manifest field freely.
    const bloated = { ...cloneManifest(manifest), contextAad: 'A'.repeat(4096) };
    expect(bloated.contextAad.length).toBeGreaterThan(2048);
    expect(() => facade.decryptStream(slices(ciphertext, [ciphertext.length]), bloated, context))
      .toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });

  it('a contextAad just under the cap is still refused (wrong binding, not length)', async () => {
    const { facade, ciphertext, manifest } = await sealedTwoChunks();
    const wrongAad = { ...cloneManifest(manifest), contextAad: 'A'.repeat(2047) };
    expect(() => facade.decryptStream(slices(ciphertext, [ciphertext.length]), wrongAad, context))
      .toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });

  it('a ciphertext stream yielding a non-Uint8Array value fails closed as INVALID_INPUT', async () => {
    const { facade, ciphertext, manifest } = await sealedTwoChunks();
    async function* stringChunks(): AsyncGenerator<unknown, void, void> {
      yield ciphertext.subarray(0, 1024).toString('utf8');
    }
    await expect(collect(facade.decryptStream(stringChunks() as unknown as AsyncIterable<Uint8Array>, manifest, context)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('a non-Uint8Array value in the TAIL of an otherwise valid stream still fails closed', async () => {
    // The guard must hold at the tail too, not only on the first read: a stream
    // that is correct up to the declared length and then goes wrong must not be
    // accepted because the valid prefix already yielded its plaintext.
    const { facade, ciphertext, manifest } = await sealedTwoChunks();
    async function* badTail(): AsyncGenerator<unknown, void, void> {
      yield new Uint8Array(ciphertext.subarray(0, ciphertext.length - 1));
      yield 'not-bytes';
    }
    await expect(collect(facade.decryptStream(badTail() as unknown as AsyncIterable<Uint8Array>, manifest, context)))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});

// W-CR28-01 facade boundary negatives: chunk-count boundary, invalid sidecar
// manifest format, non-JSON sidecar, and a missing envelope header.
//
// Scope note, measured not assumed: the sidecar BYTES are fetched and
// JSON.parse-d by the S3 adapter in server.ts, which this task must not edit.
// What the facade owns, and what is pinned here, is the second half: given a
// value that came out of the sidecar, does the facade REFUSE it. A non-record
// (the shape a failed/absent JSON.parse would produce) must be refused rather
// than crashing or being waved through.
describe('facade boundary negatives: chunk count, manifest format, envelope header', () => {
  async function sealedManifest() {
    // ONE provider for the block: a real manifest only opens under the provider
    // that wrapped its DEK; a fresh one fails KEY_PROVIDER_FAILED and masks the boundary.
    const provider = new MemoryKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    // 4 MiB + 1 MiB + 64 => two chunks, and strictly over the 5 MiB single-shot
    // floor (an exact 5 MiB is refused at encrypt time; the existing tests use
    // the same +64 convention).
    const plaintext = sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 1024 * 1024 + 64);
    const encrypted = facade.encryptStream(slices(plaintext, [plaintext.length]), {
      ...context,
      keyRef: 'artifact-key',
    });
    const [ciphertext, manifest] = await Promise.all([
      collect(encrypted.ciphertext),
      encrypted.manifest,
    ]);
    return { provider, facade, ciphertext, manifest };
  }

  // ---- chunk count boundary ----------------------------------------------

  it('accepts a manifest at EXACTLY maxChunks and refuses one chunk fewer', async () => {
    const { provider, ciphertext, manifest } = await sealedManifest();
    // Boundary in both directions, with the ceiling equal to the real chunk count.
    const atLimit = new CryptoStorageFacade(provider, { maxChunks: manifest.totalChunks });
    const opened = await collect(
      atLimit.decryptStream(slices(ciphertext, [ciphertext.length]), manifest, context),
    );
    expect(opened).toHaveLength(ciphertext.length);
    // One chunk below the ceiling must be a hard refusal. try/catch rather than
    // .rejects: decryptStream validates EAGERLY and is not async, so the throw
    // happens before any promise exists for .rejects to attach to.
    const belowLimit = new CryptoStorageFacade(provider, { maxChunks: manifest.totalChunks - 1 });
    let code: string | undefined;
    try {
      await collect(
        belowLimit.decryptStream(slices(ciphertext, [ciphertext.length]), manifest, context),
      );
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    expect(code).toBe('INVALID_MANIFEST');
  });

  it('rejects a nonsensical maxChunks at construction instead of trusting it', () => {
    // A ceiling of 0 would make every manifest invalid; above the hard cap it
    // would silently re-open the byte-ceiling problem from delta 71.
    for (const bad of [0, -1, 65_537, 1.5, Number.NaN]) {
      expect(() => new CryptoStorageFacade(new MemoryKeyProvider(), { maxChunks: bad })).toThrow();
    }
  });

  it('rejects totalChunks = 0 and a non-integer totalChunks', async () => {
    const { ciphertext, manifest } = await sealedManifest();
    for (const bad of [0, -3, 2.5, Number.NaN]) {
      const broken = { ...cloneManifest(manifest), totalChunks: bad } as EncryptedStorageManifest;
      expect(() =>
        new CryptoStorageFacade(new MemoryKeyProvider()).decryptStream(
          slices(ciphertext, [ciphertext.length]), broken, context,
        )).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
    }
  });

  // ---- invalid sidecar manifest format ----------------------------------

  it('rejects a manifest carrying a field the format does not define', async () => {
    const { ciphertext, manifest } = await sealedManifest();
    // An allow-list, not a deny-list: an extra field means the sidecar is not
    // the shape this facade signed, so it must not be parsed leniently.
    const extra = { ...cloneManifest(manifest), note: 'smuggled' } as unknown as EncryptedStorageManifest;
    expect(() =>
      new CryptoStorageFacade(new MemoryKeyProvider()).decryptStream(
        slices(ciphertext, [ciphertext.length]), extra, context,
      )).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });

  it('rejects a manifest whose chunks array length disagrees with totalChunks', async () => {
    const { ciphertext, manifest } = await sealedManifest();
    const short = { ...cloneManifest(manifest), chunks: manifest.chunks.slice(0, 1) };
    expect(() =>
      new CryptoStorageFacade(new MemoryKeyProvider()).decryptStream(
        slices(ciphertext, [ciphertext.length]), short as EncryptedStorageManifest, context,
      )).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });

  it('rejects a manifest that duplicates a chunk nonce', async () => {
    // Nonce reuse under one DEK is catastrophic for GCM, so the manifest must
    // be refused on a duplicate even though every chunk authenticates alone.
    const { ciphertext, manifest } = await sealedManifest();
    const dup = cloneManifest(manifest);
    const second = dup.chunks[1]!;
    const first = dup.chunks[0]!;
    (second as { nonce: string }).nonce = first.nonce;
    expect(() =>
      new CryptoStorageFacade(new MemoryKeyProvider()).decryptStream(
        slices(ciphertext, [ciphertext.length]), dup, context,
      )).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });

  // ---- non-JSON sidecar --------------------------------------------------

  it('refuses a non-JSON sidecar (string, null, number, array) rather than crashing', async () => {
    const { ciphertext } = await sealedManifest();
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    // These are the shapes a failed or skipped JSON.parse hands over. The
    // facade must reject them the same way, not throw a TypeError from isRecord.
    for (const junk of ['{not json', null, 42, [], true, undefined]) {
      expect(() =>
        facade.decryptStream(slices(ciphertext, [ciphertext.length]), junk as never, context),
      ).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
    }
  });

  // ---- missing crypto envelope header ------------------------------------

  it('refuses a manifest missing the envelope header fields', async () => {
    const { ciphertext, manifest } = await sealedManifest();
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    for (const field of ['version', 'algorithm', 'chunkSizeBytes', 'totalSizeBytes', 'fileSha256', 'contextAad', 'chunks', 'dek', 'manifestMac'] as const) {
      const stripped = cloneManifest(manifest) as unknown as Record<string, unknown>;
      delete stripped[field];
      expect(() =>
        facade.decryptStream(slices(ciphertext, [ciphertext.length]), stripped as never, context),
      ).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
    }
  });

  it('refuses a wrong version or a wrong algorithm in the header', async () => {
    const { ciphertext, manifest } = await sealedManifest();
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    const wrongVersion = { ...cloneManifest(manifest), version: 2 } as unknown as EncryptedStorageManifest;
    expect(() =>
      facade.decryptStream(slices(ciphertext, [ciphertext.length]), wrongVersion, context),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
    const wrongAlgo = { ...cloneManifest(manifest), algorithm: 'aes-128-gcm' } as unknown as EncryptedStorageManifest;
    expect(() =>
      facade.decryptStream(slices(ciphertext, [ciphertext.length]), wrongAlgo, context),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });
});

// CR28-05 facade negatives: context AAD bounds, sidecar type confusion,
// stream chunk boundaries, and tampered encryption metadata.
//
// Scope discipline: every assertion here is about a guard that EXISTS. Where a
// guard turns out to be weaker than its name suggests, the test is marked
// FINDING and pins the current behaviour instead of inventing a rejection.
describe('CR28-05 facade: context AAD bounds', () => {
  it('binds the optional purpose field, which no earlier test varied', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    const encrypted = await facade.encrypt(Buffer.from('purpose bound'), { ...context, keyRef: 'artifact-key' });

    // `purpose` sits inside contextAad() but was never exercised: without this,
    // dropping it from the AAD would not fail any test in the file.
    await expect(facade.decrypt(encrypted, { ...context, purpose: 'ingest-source' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('treats an omitted purpose as exactly the documented default', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    const encrypted = await facade.encrypt(Buffer.from('default purpose'), { ...context, keyRef: 'artifact-key' });

    // If the default string ever drifts, every already-written row stops
    // opening. This pins the two spellings as equivalent.
    expect('purpose' in context).toBe(false);
    await expect(facade.decrypt(encrypted, { ...context, purpose: 'artifact-storage' }))
      .resolves.toEqual(Buffer.from('default purpose'));
  });

  it.each([
    ['an empty string', ''],
    ['a 513 character value', 'x'.repeat(513)],
    ['a NUL character', 'a' + String.fromCharCode(0) + 'b'],
    ['a newline', 'a' + String.fromCharCode(10) + 'b'],
    ['a non-string', 42],
    ['null', null],
  ])('refuses a tenantId that is %s', async (_label, tenantId) => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());

    await expect(facade.encrypt(Buffer.from('x'), { ...context, tenantId, keyRef: 'artifact-key' } as never))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([
    ['an empty string', ''],
    ['a 513 character value', 'x'.repeat(513)],
    ['a NUL character', 'a' + String.fromCharCode(0) + 'b'],
    ['a non-string', 42],
  ])('refuses an artifactId that is %s', async (_label, artifactId) => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());

    await expect(facade.encrypt(Buffer.from('x'), { ...context, artifactId, keyRef: 'artifact-key' } as never))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([
    ['an empty string', ''],
    ['a 513 character value', 'x'.repeat(513)],
    ['a NUL character', 'v' + String.fromCharCode(0)],
    ['a non-string', 7],
  ])('refuses a malformed objectVersion (%s) before any key work', async (_label, objectVersion) => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());

    // validateText runs before the cipher, so this is INVALID_INPUT and not
    // AUTHENTICATION_FAILED - a different answer from a merely-different
    // version, which the earlier suite already covers as AUTHENTICATION_FAILED.
    await expect(facade.encrypt(Buffer.from('x'), { ...context, objectVersion, keyRef: 'artifact-key' } as never))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('FINDING: a TRUNCATED objectVersion is accepted at encrypt time, not rejected', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());

    // validateText only requires length >= 1, so a version truncated from 'v7'
    // to 'v' is a perfectly legal binding. The write succeeds and the failure
    // is deferred to a much later AAD mismatch - a truncated identifier should
    // arguably be refused where it is written, not silently accepted.
    const truncated = await facade.encrypt(Buffer.from('truncated version'), { ...context, objectVersion: 'v', keyRef: 'artifact-key' });
    expect(truncated.plaintextSizeBytes).toBe(17);
    await expect(facade.decrypt(truncated, { ...context, objectVersion: 'v' })).resolves.toHaveLength(17);
    await expect(facade.decrypt(truncated, context)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('separates a padded objectVersion (authentication) from a malformed one (input)', async () => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());
    const encrypted = await facade.encrypt(Buffer.from('padded'), { ...context, keyRef: 'artifact-key' });

    // 'v7 ' is legal text, so it reaches the AAD comparison and fails there.
    await expect(facade.decrypt(encrypted, { ...context, objectVersion: 'v7 ' }))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it.each([
    ['empty', ''],
    ['129 characters', 'p'.repeat(129)],
    ['non-string', 5],
    ['with a NUL', 'p' + String.fromCharCode(0)],
  ])('refuses a purpose that is %s', async (_label, purpose) => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());

    await expect(facade.encrypt(Buffer.from('x'), { ...context, purpose, keyRef: 'artifact-key' } as never))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([
    ['empty', ''],
    ['257 characters', 'k'.repeat(257)],
    ['with a control character', 'k' + String.fromCharCode(9)],
  ])('refuses a keyRef that is %s', async (_label, keyRef) => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());

    await expect(facade.encrypt(Buffer.from('x'), { ...context, keyRef } as never))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['fractional', 1.5],
    ['NaN', Number.NaN],
    ['one past the 2^31-1 ceiling', 2_147_483_648],
  ])('refuses a keyVersion of %s', async (_label, keyVersion) => {
    const facade = new CryptoStorageFacade(new MemoryKeyProvider());

    await expect(facade.encrypt(Buffer.from('x'), { ...context, keyRef: 'artifact-key', keyVersion }))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('reports a context mismatch in the STREAM path synchronously, unlike the single-shot path', async () => {
    const provider = new MemoryKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    const plaintext = sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 1024 * 1024 + 64);
    const encrypted = facade.encryptStream(slices(plaintext, [plaintext.length]), { ...context, keyRef: 'artifact-key' });
    const [ciphertext, manifest] = await Promise.all([collect(encrypted.ciphertext), encrypted.manifest]);

    // Same class of mistake (a different purpose) surfaces as INVALID_MANIFEST
    // here and AUTHENTICATION_FAILED on the single-shot object. Pin both so a
    // future refactor cannot quietly change which one a caller sees.
    const wrong = { ...context, purpose: 'ingest-source' };
    expect(() =>
      new CryptoStorageFacade(provider).decryptStream(slices(ciphertext, [ciphertext.length]), manifest, wrong),
    ).toThrow(expect.objectContaining({ code: 'INVALID_MANIFEST' }));
  });
});

describe('CR28-05 facade: sidecar type confusion and stream boundaries', () => {
  async function sealedTwoChunks() {
    // ONE provider for the block: a manifest only opens under the provider that
    // wrapped its DEK, and a fresh one would mask every boundary with
    // KEY_PROVIDER_FAILED.
    const provider = new MemoryKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    const plaintext = sampleBytes(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 1024 * 1024 + 64);
    const encrypted = facade.encryptStream(slices(plaintext, [plaintext.length]), {
      ...context,
      keyRef: 'artifact-key',
    });
    const [ciphertext, manifest] = await Promise.all([
      collect(encrypted.ciphertext),
      encrypted.manifest,
    ]);
    return { provider, facade, plaintext, ciphertext, manifest };
  }

  function refuseSync(ciphertext: Buffer, manifest: unknown, provider: MemoryKeyProvider): string | undefined {
    let code: string | undefined;
    try {
      new CryptoStorageFacade(provider).decryptStream(slices(ciphertext, [ciphertext.length]), manifest as never, context);
    } catch (err) {
      code = (err as { code?: string }).code;
    }
    return code;
  }

  it.each([
    ['version as a string', 'version', '1'],
    ['algorithm as a number', 'algorithm', 26],
    ['chunkSizeBytes as a string', 'chunkSizeBytes', '4194304'],
    ['totalChunks as a string', 'totalChunks', '2'],
    ['totalSizeBytes as a string', 'totalSizeBytes', '999'],
    ['fileSha256 as a number', 'fileSha256', 42],
    ['contextAad as an object', 'contextAad', {}],
    ['chunks as a string', 'chunks', 'nope'],
    ['manifestMac as a number', 'manifestMac', 7],
  ])('refuses a sidecar with %s', async (_label, field, value) => {
    const { provider, ciphertext, manifest } = await sealedTwoChunks();
    const broken = cloneManifest(manifest) as unknown as Record<string, unknown>;
    broken[field] = value;

    // Every one of these must land on the metadata guard, not slip past a
    // loosely typed read and fail later with a confusing error.
    expect(refuseSync(ciphertext, broken, provider)).toBe('INVALID_MANIFEST');
  });

  it.each([
    ['index as a string', 'index', '0'],
    ['sizeBytes as a float', 'sizeBytes', 1.5],
    ['sizeBytes as a string', 'sizeBytes', '4194304'],
    ['sizeBytes of zero', 'sizeBytes', 0],
    ['sha256 that is not hex', 'sha256', 'z'.repeat(64)],
    ['sha256 as a number', 'sha256', 1],
    ['nonce as a number', 'nonce', 5],
    ['tag as an object', 'tag', {}],
    ['an undeclared field', 'extra', 'smuggled'],
  ])('refuses a chunk whose %s', async (_label, field, value) => {
    const { provider, ciphertext, manifest } = await sealedTwoChunks();
    const broken = cloneManifest(manifest) as unknown as Record<string, unknown>;
    const chunks = broken.chunks as Array<Record<string, unknown>>;
    chunks[0]![field] = value;

    expect(refuseSync(ciphertext, broken, provider)).toBe('INVALID_MANIFEST');
  });

  it('refuses a sidecar whose totalSizeBytes disagrees with the sum of its chunks', async () => {
    const { provider, ciphertext, manifest } = await sealedTwoChunks();
    const broken = { ...cloneManifest(manifest), totalSizeBytes: manifest.totalSizeBytes + 1 };

    // The MAC is verified in the async generator, AFTER validateManifest, so a
    // shape-valid but arithmetically inconsistent manifest is caught here
    // synchronously rather than surfacing later as an integrity failure.
    expect(manifest.totalSizeBytes).toBeGreaterThan(0);
    expect(refuseSync(ciphertext, broken, provider)).toBe('INVALID_MANIFEST');
  });

  it('refuses a correctly shaped sidecar whose MAC is a different valid-length value', async () => {
    const { provider, ciphertext, manifest } = await sealedTwoChunks();
    const forged = { ...cloneManifest(manifest), manifestMac: Buffer.alloc(32, 0xff).toString('base64') };

    // Proves the MAC is a REAL check and not just a shape assertion: same
    // length, same alphabet, different bytes.
    expect(forged.manifestMac).not.toBe(manifest.manifestMac);
    expect(forged.manifestMac.length).toBe(manifest.manifestMac.length);
    expect(refuseSync(ciphertext, forged, provider)).toBeUndefined();

    const stream = new CryptoStorageFacade(provider).decryptStream(
      slices(ciphertext, [ciphertext.length]), forged, context,
    );
    await expect(collect(stream)).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('accepts a ciphertext stream that ends exactly on a chunk boundary', async () => {
    const { facade, ciphertext, manifest } = await sealedTwoChunks();
    expect(ciphertext.length).toBe(manifest.totalSizeBytes);

    // The control for the truncation test: a clean boundary is not a short read.
    const opened = await collect(
      facade.decryptStream(slices(ciphertext, [manifest.chunks[0]!.sizeBytes]), manifest, context),
    );
    expect(opened).toHaveLength(ciphertext.length);
  });

  it('accepts trailing EMPTY chunks and still refuses trailing non-empty bytes', async () => {
    const { facade, ciphertext, manifest } = await sealedTwoChunks();

    // assertEnd() only rejects a trailing chunk with byteLength > 0, so an empty
    // one is legal. Pin both directions: an empty tail must not be treated as
    // truncation, and a 1-byte tail must not be treated as padding.
    async function* withEmptyTail(): AsyncGenerator<Buffer> {
      yield Buffer.from(ciphertext);
      yield Buffer.alloc(0);
    }
    await expect(collect(facade.decryptStream(withEmptyTail(), manifest, context)))
      .resolves.toHaveLength(ciphertext.length);

    await expect(collect(facade.decryptStream(slices(Buffer.concat([ciphertext, Buffer.from([0])]), [1]), manifest, context)))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('refuses a ciphertext stream missing its final chunk', async () => {
    const { facade, ciphertext, manifest } = await sealedTwoChunks();
    const truncated = ciphertext.subarray(0, manifest.chunks[0]!.sizeBytes);

    await expect(collect(facade.decryptStream(slices(truncated, [truncated.length]), manifest, context)))
      .rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });
});

describe('CR28-05 facade: tampered encryption metadata (single-shot)', () => {
  async function sealedObject() {
    const provider = new MemoryKeyProvider();
    const facade = new CryptoStorageFacade(provider);
    const plaintext = Buffer.from('single shot metadata body', 'utf8');
    const encrypted = await facade.encrypt(plaintext, { ...context, keyRef: 'artifact-key' });
    return { provider, facade, plaintext, encrypted };
  }

  it.each([
    ['a wrong version', 'version', 2],
    ['a wrong algorithm', 'algorithm', 'aes-128-gcm'],
    ['a null version', 'version', null],
  ])('refuses %s on the single-shot object with INVALID_INPUT', async (_label, field, value) => {
    const { facade, encrypted } = await sealedObject();

    // Note the taxonomy split with the sidecar path: the object path answers
    // INVALID_INPUT, the manifest path answers INVALID_MANIFEST, for the same
    // class of metadata mistake.
    await expect(facade.decrypt({ ...encrypted, [field]: value } as never, context))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('FINDING: a MISSING auth tag reports INVALID_MANIFEST on the single-shot object', async () => {
    const { facade, encrypted } = await sealedObject();
    const stripped = { ...encrypted } as unknown as Record<string, unknown>;
    delete stripped.tag;

    // decodeBase64() raises invalidManifest(), so a single-shot object - a shape
    // that has no manifest and no chunks - answers with a STREAM taxonomy code.
    // Any caller switching on the code has to handle a code that cannot apply.
    await expect(facade.decrypt(stripped as never, context))
      .rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  it.each([
    ['a 15 byte tag', 'tag', Buffer.alloc(15).toString('base64')],
    ['a 17 byte tag', 'tag', Buffer.alloc(17).toString('base64')],
    ['an 11 byte nonce', 'nonce', Buffer.alloc(11).toString('base64')],
    ['a 13 byte nonce', 'nonce', Buffer.alloc(13).toString('base64')],
    ['a non-base64 tag', 'tag', 'not base64!!'],
  ])('refuses %s with INVALID_MANIFEST, the same leak as a missing tag', async (_label, field, value) => {
    const { facade, encrypted } = await sealedObject();

    await expect(facade.decrypt({ ...encrypted, [field]: value } as never, context))
      .rejects.toMatchObject({ code: 'INVALID_MANIFEST' });
  });

  it('FINDING: a MISMATCHED DEK ciphertext is reported as KEY_PROVIDER_FAILED', async () => {
    const { facade, encrypted } = await sealedObject();
    const forged = {
      ...encrypted,
      dek: { ...encrypted.dek, ciphertext: 'vault:v1:wrapped-999' },
    };

    // The provider cannot find that wrapped key and throws; the facade maps any
    // provider throw to KEY_PROVIDER_FAILED. So a caller that tampered with a
    // row looks identical to Vault being down - the same taxonomy confusion
    // found on the metadata seam last cycle (delta 92).
    await expect(facade.decrypt(forged as never, context))
      .rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
  });

  it.each([
    ['one byte larger than the ciphertext', (n: number) => n + 1],
    ['zero', () => 0],
    ['negative', () => -1],
    ['fractional', (n: number) => n + 0.5],
  ])('refuses a plaintextSizeBytes that is %s', async (_label, make) => {
    const { facade, encrypted } = await sealedObject();
    const value = make(encrypted.plaintextSizeBytes);

    // Four different branches of the same guard: the size must be a safe
    // integer, at least 1, and exactly equal to ciphertext.byteLength.
    await expect(facade.decrypt({ ...encrypted, plaintextSizeBytes: value } as never, context))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses a ciphertext that is a base64 string instead of bytes', async () => {
    const { facade, encrypted } = await sealedObject();
    const roundTripped = {
      ...encrypted,
      ciphertext: Buffer.from(encrypted.ciphertext).toString('base64'),
    };

    // The sidecar stores chunk fields as base64 strings, so this is the shape a
    // caller gets after a JSON round trip. It must be refused, not coerced.
    expect(typeof roundTripped.ciphertext).toBe('string');
    await expect(facade.decrypt(roundTripped as never, context))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it.each([
    ['a non-hex digest', 'z'.repeat(64)],
    ['a 63 character digest', 'a'.repeat(63)],
    ['an uppercase digest', 'A'.repeat(64)],
    ['a number', 5],
  ])('refuses a plaintextSha256 that is %s', async (_label, value) => {
    const { facade, encrypted } = await sealedObject();

    await expect(facade.decrypt({ ...encrypted, plaintextSha256: value } as never, context))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });

  it('refuses an empty ciphertext buffer', async () => {
    const { facade, encrypted } = await sealedObject();

    await expect(facade.decrypt({ ...encrypted, ciphertext: Buffer.alloc(0) } as never, context))
      .rejects.toMatchObject({ code: 'INVALID_INPUT' });
  });
});
