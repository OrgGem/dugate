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
