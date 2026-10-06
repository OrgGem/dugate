/**
 * SEC-ENC-01 — freeze parity between the contracts policy and the runtime
 * crypto that is already enforced.
 *
 * Proves the frozen shapes are not a parallel universe: the runtime metadata
 * slots equal the contract's enforced metadata purposes, a real `seal()`
 * envelope parses as `SealedMetadataEnvelope`, the storage facade's AAD and
 * streaming manifest parse as their contract schemas, and provider outages
 * fail closed instead of degrading to plaintext.
 */
import {
  ENFORCED_METADATA_PURPOSES,
  ENFORCED_PERSISTENCE_PURPOSES,
  EncryptedStorageStreamManifestSchema,
  PersistencePurposeSchema,
  SealedMetadataEnvelopeSchema,
  StorageSingleShotAadSchema,
} from '@du/contracts';
import {
  CRYPTO_STORAGE_CHUNK_SIZE_BYTES,
  CryptoStorageFacade,
} from '../src/modules/encryption/crypto-storage-facade';
import type { KeyProvider, WrapDekInput, WrappedDek } from '../src/modules/encryption/vault-transit-provider';
import { adaptKeyProviderForMetadata } from '../src/modules/encryption/metadata-key-adapter';
import {
  createMetadataCrypto,
  METADATA_SLOTS,
  type MetadataKeyProvider,
} from '../src/modules/runtime/metadata-crypto';

const XOR = 0x5a;
const xor = (bytes: Uint8Array): Buffer => {
  const out = Buffer.alloc(bytes.byteLength);
  for (let index = 0; index < bytes.byteLength; index += 1) out[index] = bytes[index]! ^ XOR;
  return out;
};

const keyProvider: KeyProvider = {
  async wrapDek(input: WrapDekInput): Promise<WrappedDek> {
    return {
      keyRef: input.keyRef,
      keyVersion: input.keyVersion ?? 1,
      ciphertext: xor(input.dek).toString('base64'),
    };
  },
  async unwrapDek(wrapped: WrappedDek): Promise<Buffer> {
    return xor(Buffer.from(wrapped.ciphertext, 'base64'));
  },
  async rewrap(wrapped: WrappedDek, targetKeyVersion?: number): Promise<WrappedDek> {
    return { ...wrapped, keyVersion: targetKeyVersion ?? wrapped.keyVersion };
  },
};

const brokenMetadataProvider: MetadataKeyProvider = {
  async wrapDek(): Promise<never> {
    throw new Error('vault transit unavailable');
  },
  async unwrapDek(): Promise<never> {
    throw new Error('vault transit unavailable');
  },
};

const brokenKeyProvider: KeyProvider = {
  async wrapDek(_input: WrapDekInput): Promise<WrappedDek> {
    throw new Error('vault transit unavailable');
  },
  async unwrapDek(_wrapped: WrappedDek): Promise<Buffer> {
    throw new Error('vault transit unavailable');
  },
  async rewrap(_wrapped: WrappedDek, _targetKeyVersion?: number): Promise<WrappedDek> {
    throw new Error('vault transit unavailable');
  },
};

describe('SEC-ENC-01 freeze parity', () => {
  it('keeps the contract purpose taxonomy equal to the enforced runtime slots', () => {
    expect([...METADATA_SLOTS].sort()).toEqual([...ENFORCED_METADATA_PURPOSES].sort());
    for (const slot of METADATA_SLOTS) {
      expect(PersistencePurposeSchema.safeParse(slot).success).toBe(true);
    }
    expect(ENFORCED_PERSISTENCE_PURPOSES).toContain('artifact-storage');
    expect(new Set(ENFORCED_PERSISTENCE_PURPOSES).size).toBe(ENFORCED_PERSISTENCE_PURPOSES.length);
  });

  it('parses a real metadata seal() envelope with the frozen schema and still refuses a foreign context', async () => {
    const crypto = createMetadataCrypto(adaptKeyProviderForMetadata(keyProvider), 'du-orch-metadata-v1');
    const sealed = await crypto.seal(
      { documentType: 'invoice', amount: 250 },
      { tenantId: 'tenant-1', slot: 'tasks.payload_ref', refId: 'task-1' },
    );

    expect(SealedMetadataEnvelopeSchema.safeParse(sealed).success).toBe(true);
    expect(JSON.stringify(sealed)).not.toContain('invoice');

    await expect(
      crypto.open(sealed, { tenantId: 'tenant-2', slot: 'tasks.payload_ref', refId: 'task-1' }),
    ).rejects.toMatchObject({ code: 'CONTEXT_MISMATCH' });
  });

  it('parses the facade single-shot AAD with the frozen schema and denies a transplanted context', async () => {
    const facade = new CryptoStorageFacade(keyProvider);
    const encrypted = await facade.encrypt(Buffer.from('SEC-ENC-01 persistence sentinel'), {
      tenantId: 'tenant-1',
      artifactId: 'artifact-1',
      objectVersion: 'v1',
      keyRef: 'du-artifact-v1',
    });

    const aad = JSON.parse(Buffer.from(encrypted.aad, 'base64').toString('utf8')) as unknown;
    expect(StorageSingleShotAadSchema.safeParse(aad).success).toBe(true);

    await expect(
      facade.decrypt(encrypted, { tenantId: 'tenant-1', artifactId: 'artifact-2', objectVersion: 'v1' }),
    ).rejects.toMatchObject({ code: 'AUTHENTICATION_FAILED' });
  });

  it('parses a real streaming manifest with the frozen schema', async () => {
    const facade = new CryptoStorageFacade(keyProvider);
    const plaintext = Buffer.alloc(CRYPTO_STORAGE_CHUNK_SIZE_BYTES + 2_000_000, 7);
    async function* source(): AsyncGenerator<Buffer> {
      yield plaintext;
    }
    const stream = facade.encryptStream(source(), {
      tenantId: 'tenant-1',
      artifactId: 'artifact-1',
      objectVersion: 'v2',
      keyRef: 'du-artifact-v1',
    });
    let ciphertextBytes = 0;
    for await (const part of stream.ciphertext) {
      ciphertextBytes += part.length;
    }
    const manifest = await stream.manifest;

    expect(ciphertextBytes).toBe(plaintext.length);
    expect(manifest.totalChunks).toBe(2);
    expect(EncryptedStorageStreamManifestSchema.safeParse(manifest).success).toBe(true);

    const tampered = { ...manifest, totalSizeBytes: manifest.totalSizeBytes + 1 };
    expect(EncryptedStorageStreamManifestSchema.safeParse(tampered).success).toBe(false);
  });

  it('fails closed on key-provider outage without returning plaintext', async () => {
    const brokenCrypto = createMetadataCrypto(brokenMetadataProvider, 'du-orch-metadata-v1');
    await expect(
      brokenCrypto.seal({ a: 1 }, { tenantId: 'tenant-1', slot: 'tasks.payload_ref', refId: 'task-1' }),
    ).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });

    const brokenFacade = new CryptoStorageFacade(brokenKeyProvider);
    await expect(
      brokenFacade.encrypt(Buffer.from('plaintext must not survive an outage'), {
        tenantId: 'tenant-1',
        artifactId: 'artifact-1',
        objectVersion: 'v1',
        keyRef: 'du-artifact-v1',
      }),
    ).rejects.toMatchObject({ code: 'KEY_PROVIDER_FAILED' });
  });
});
