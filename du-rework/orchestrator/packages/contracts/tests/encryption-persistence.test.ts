/**
 * SEC-ENC-01 — persistence-encryption contract freeze tests.
 *
 * Pins the schema-level negatives the policy depends on: wrong AAD binding,
 * byte-length drift, reordered/truncated stream manifests, duplicate nonces
 * and the explicit-only synthetic exemption.
 */
import {
  ENFORCED_METADATA_PURPOSES,
  ENFORCED_PERSISTENCE_PURPOSES,
  EncryptedStorageStreamManifestSchema,
  MetadataAadDigestSchema,
  PERSISTENCE_PURPOSES,
  PersistencePurposeSchema,
  PLANNED_PERSISTENCE_PURPOSES,
  SealedMetadataEnvelopeSchema,
  StorageChunkAadSchema,
  StorageContextAadSchema,
  StorageSingleShotAadSchema,
  SyntheticDataExemptionSchema,
} from '../src/encryption-persistence';
import { CHUNK_SIZE_BYTES } from '../src/encryption';

const b64 = (bytes: Buffer): string => bytes.toString('base64');
const nonce = (fill = 1): string => b64(Buffer.alloc(12, fill));
const tag = (fill = 2): string => b64(Buffer.alloc(16, fill));
const digest32 = (): string => b64(Buffer.alloc(32, 3));
const sha = (fill = 'a'): string => fill.repeat(64);
const wrappedDek = {
  keyRef: 'du-artifact-v1',
  keyVersion: 1,
  ciphertext: b64(Buffer.alloc(48, 4)),
};
const contextAad = {
  format: 'du-crypto-storage-v1' as const,
  tenantId: 'tenant-1',
  artifactId: 'artifact-1',
  objectVersion: 'v1',
  purpose: 'artifact-storage',
};

describe('SEC-ENC-01 purpose taxonomy', () => {
  it('lists unique purposes and keeps enforced/planned disjoint', () => {
    expect(new Set(PERSISTENCE_PURPOSES).size).toBe(PERSISTENCE_PURPOSES.length);
    const enforced = new Set<string>(ENFORCED_PERSISTENCE_PURPOSES);
    for (const planned of PLANNED_PERSISTENCE_PURPOSES) {
      expect(enforced.has(planned)).toBe(false);
      expect(PersistencePurposeSchema.safeParse(planned).success).toBe(true);
    }
    for (const purpose of ENFORCED_METADATA_PURPOSES) {
      expect(PersistencePurposeSchema.safeParse(purpose).success).toBe(true);
    }
    expect(PersistencePurposeSchema.safeParse('unknown.purpose').success).toBe(false);
  });

  it('rejects a synthetic exemption that is missing any explicit acknowledgement field', () => {
    expect(SyntheticDataExemptionSchema.safeParse({}).success).toBe(false);
    expect(SyntheticDataExemptionSchema.safeParse({ mode: 'synthetic-data-exempt' }).success).toBe(false);
    expect(
      SyntheticDataExemptionSchema.safeParse({
        mode: 'synthetic-data-exempt',
        reason: 'local fixtures only',
        approvedBy: 'tester',
        acknowledgedAt: '2026-10-06T00:00:00.000Z',
        isolatedFromRealData: true,
      }).success,
    ).toBe(true);
  });
});

describe('SEC-ENC-01 storage AAD shapes', () => {
  it('accepts the exact facade context and rejects missing/extra binding fields', () => {
    expect(StorageContextAadSchema.safeParse(contextAad).success).toBe(true);
    expect(StorageContextAadSchema.safeParse({ ...contextAad, tenantId: '' }).success).toBe(false);
    expect(StorageContextAadSchema.safeParse({ ...contextAad, extra: 1 }).success).toBe(false);
    // Wrong format means the bytes were not produced by this policy.
    expect(StorageContextAadSchema.safeParse({ ...contextAad, format: 'du-crypto-storage-v2' }).success).toBe(false);
  });

  it('binds size/digest/index and rejects cross-format transplants', () => {
    const single = {
      format: 'du-crypto-storage-single-v1' as const,
      context: contextAad,
      sizeBytes: 123,
      sha256: sha(),
    };
    expect(StorageSingleShotAadSchema.safeParse(single).success).toBe(true);
    // A single-shot AAD is not a chunk AAD: the format field alone must refuse it.
    expect(StorageChunkAadSchema.safeParse(single).success).toBe(false);
    expect(
      StorageChunkAadSchema.safeParse({ ...single, format: 'du-crypto-storage-chunk-v1', index: 0 }).success,
    ).toBe(true);
    expect(
      StorageChunkAadSchema.safeParse({
        format: 'du-crypto-storage-chunk-v1',
        context: contextAad,
        index: 0,
        sizeBytes: CHUNK_SIZE_BYTES + 1,
        sha256: sha(),
      }).success,
    ).toBe(false);
    expect(
      StorageChunkAadSchema.safeParse({
        format: 'du-crypto-storage-chunk-v1',
        context: contextAad,
        index: 0,
        sizeBytes: 1,
        sha256: 'NOT-HEX',
      }).success,
    ).toBe(false);
  });

  it('enforces the 32-byte metadata AAD digest', () => {
    expect(MetadataAadDigestSchema.safeParse(digest32()).success).toBe(true);
    expect(MetadataAadDigestSchema.safeParse(b64(Buffer.alloc(16, 3))).success).toBe(false);
    expect(MetadataAadDigestSchema.safeParse('not-base64!').success).toBe(false);
  });
});

describe('SEC-ENC-01 small metadata envelope', () => {
  const valid = {
    version: 1 as const,
    algorithm: 'aes-256-gcm' as const,
    keyRef: 'du-orch-metadata-v1',
    dek: { version: 1, keyName: 'du-orch-metadata-v1', keyVersion: 3, wrappedKey: b64(Buffer.alloc(44, 5)) },
    nonce: nonce(),
    tag: tag(),
    aad: digest32(),
    ciphertext: b64(Buffer.from('sealed-value')),
    plaintextSha256: sha(),
  };

  it('accepts the runtime envelope shape and rejects byte-length drift', () => {
    expect(SealedMetadataEnvelopeSchema.safeParse(valid).success).toBe(true);
    expect(SealedMetadataEnvelopeSchema.safeParse({ ...valid, nonce: b64(Buffer.alloc(11, 1)) }).success).toBe(false);
    expect(SealedMetadataEnvelopeSchema.safeParse({ ...valid, tag: b64(Buffer.alloc(15, 2)) }).success).toBe(false);
    expect(SealedMetadataEnvelopeSchema.safeParse({ ...valid, aad: b64(Buffer.alloc(31, 3)) }).success).toBe(false);
    expect(SealedMetadataEnvelopeSchema.safeParse({ ...valid, plaintextSha256: sha('A') }).success).toBe(false);
    expect(SealedMetadataEnvelopeSchema.safeParse({ ...valid, extra: true }).success).toBe(false);
  });
});

describe('SEC-ENC-01 streaming artifact manifest', () => {
  const manifest = (overrides: Record<string, unknown> = {}): unknown => ({
    version: 1,
    algorithm: 'aes-256-gcm',
    chunkSizeBytes: CHUNK_SIZE_BYTES,
    totalChunks: 2,
    totalSizeBytes: CHUNK_SIZE_BYTES + 2_000_000,
    fileSha256: sha(),
    contextAad: b64(Buffer.from(JSON.stringify(contextAad), 'utf8')),
    chunks: [
      { index: 0, nonce: nonce(1), tag: tag(2), sha256: sha('b'), sizeBytes: CHUNK_SIZE_BYTES },
      { index: 1, nonce: nonce(6), tag: tag(7), sha256: sha('c'), sizeBytes: 2_000_000 },
    ],
    dek: wrappedDek,
    manifestMac: b64(Buffer.alloc(32, 8)),
    ...overrides,
  });

  it('accepts a well-formed manifest', () => {
    expect(EncryptedStorageStreamManifestSchema.safeParse(manifest()).success).toBe(true);
  });

  it('rejects a context AAD that does not encode the storage context', () => {
    expect(
      EncryptedStorageStreamManifestSchema.safeParse(manifest({ contextAad: b64(Buffer.from('{}', 'utf8')) })).success,
    ).toBe(false);
  });

  it('rejects reordered chunks, duplicate nonces, truncation and size drift', () => {
    const reordered = {
      chunks: [
        { index: 1, nonce: nonce(1), tag: tag(2), sha256: sha('b'), sizeBytes: CHUNK_SIZE_BYTES },
        { index: 0, nonce: nonce(6), tag: tag(7), sha256: sha('c'), sizeBytes: 100 },
      ],
    };
    expect(EncryptedStorageStreamManifestSchema.safeParse(manifest(reordered)).success).toBe(false);
    const duplicate = {
      chunks: [
        { index: 0, nonce: nonce(1), tag: tag(2), sha256: sha('b'), sizeBytes: CHUNK_SIZE_BYTES },
        { index: 1, nonce: nonce(1), tag: tag(7), sha256: sha('c'), sizeBytes: 100 },
      ],
    };
    expect(EncryptedStorageStreamManifestSchema.safeParse(manifest(duplicate)).success).toBe(false);
    expect(EncryptedStorageStreamManifestSchema.safeParse(manifest({ totalChunks: 3 })).success).toBe(false);
    expect(EncryptedStorageStreamManifestSchema.safeParse(manifest({ totalSizeBytes: CHUNK_SIZE_BYTES + 1_999_999 })).success).toBe(false);
    expect(EncryptedStorageStreamManifestSchema.safeParse(manifest({ manifestMac: undefined })).success).toBe(false);
    expect(EncryptedStorageStreamManifestSchema.safeParse(manifest({ chunks: [] })).success).toBe(false);
  });

  it('enforces the single-shot threshold: a stream must be larger than 5 MiB', () => {
    expect(
      EncryptedStorageStreamManifestSchema.safeParse(manifest({ totalSizeBytes: 1024 })).success,
    ).toBe(false);
  });
});
