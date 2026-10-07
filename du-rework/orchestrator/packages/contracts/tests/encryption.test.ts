import {
  CHUNK_SIZE_BYTES,
  SINGLE_SHOT_THRESHOLD_BYTES,
  WrappedDekEnvelopeSchema,
  EnvelopeCiphertextSchema,
  EncryptedChunkSchema,
  EncryptedChunkManifestSchema,
  DeliverySuiteSchema,
  RecipientDeliveryEnvelopeSchema,
  RecipientPublicKeyMetadataSchema,
} from '../src/encryption';

/**
 * W-ENC-01-SCHEMA: offline contract tests for envelope encryption schemas.
 * Zero network, zero crypto operations - pure Zod validation.
 */

// --- Fixtures ---

const VALID_B64_12 = 'AAAAAAAAAAAAAAAA'; // 12 bytes
const VALID_B64_16 = 'AAAAAAAAAAAAAAAAAAAAAA=='; // 16 bytes
const VALID_B64_32 = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA='; // 32 bytes
const VALID_SHA256 = 'a'.repeat(64);
const VALID_SHA256_B = 'b'.repeat(64);

const VALID_DEK = {
  version: 1 as const,
  keyId: 'du-artifact-v1',
  keyVersion: 3,
  wrappedKey: VALID_B64_32,
  nonce: VALID_B64_12,
  tag: VALID_B64_16,
};

const VALID_CIPHERTEXT = {
  version: 1 as const,
  algorithm: 'aes-256-gcm' as const,
  nonce: VALID_B64_12,
  tag: VALID_B64_16,
  ciphertext: VALID_B64_32,
};

function makeChunk(index: number) {
  return {
    index,
    nonce: VALID_B64_12,
    tag: VALID_B64_16,
    sha256: VALID_SHA256,
    sizeBytes: CHUNK_SIZE_BYTES,
  };
}

const VALID_MANIFEST = {
  version: 1 as const,
  chunkSizeBytes: CHUNK_SIZE_BYTES,
  totalChunks: 3,
  totalSizeBytes: SINGLE_SHOT_THRESHOLD_BYTES + 1,
  fileSha256: VALID_SHA256,
  chunks: [makeChunk(0), makeChunk(1), makeChunk(2)],
  dek: VALID_DEK,
};

const VALID_DELIVERY = {
  version: 1 as const,
  suite: 'hpke-rfc9180' as const,
  recipientKeyId: 'tenant-alpha-key-1',
  recipientKeyVersion: 2,
  enc: VALID_B64_32,
  nonce: VALID_B64_12,
  tag: VALID_B64_16,
  ciphertext: VALID_B64_32,
};

const VALID_KEY_META = {
  keyId: 'tenant-alpha-key-1',
  algorithm: 'x25519' as const,
  version: 2,
  fingerprint: VALID_SHA256,
  effectiveAt: '2026-09-01T00:00:00.000Z',
  revokedAt: null,
};

// --- WrappedDekEnvelopeSchema ---

describe('WrappedDekEnvelopeSchema', () => {
  it('accepts a valid envelope', () => {
    expect(WrappedDekEnvelopeSchema.safeParse(VALID_DEK).success).toBe(true);
  });

  it('rejects version !== 1', () => {
    expect(WrappedDekEnvelopeSchema.safeParse({ ...VALID_DEK, version: 2 }).success).toBe(false);
  });

  it('rejects empty keyId', () => {
    expect(WrappedDekEnvelopeSchema.safeParse({ ...VALID_DEK, keyId: '' }).success).toBe(false);
  });

  it('rejects keyId > 128 chars', () => {
    expect(WrappedDekEnvelopeSchema.safeParse({ ...VALID_DEK, keyId: 'x'.repeat(129) }).success).toBe(false);
  });

  it('rejects keyVersion 0', () => {
    expect(WrappedDekEnvelopeSchema.safeParse({ ...VALID_DEK, keyVersion: 0 }).success).toBe(false);
  });

  it('rejects non-base64 wrappedKey', () => {
    expect(WrappedDekEnvelopeSchema.safeParse({ ...VALID_DEK, wrappedKey: 'not!valid' }).success).toBe(false);
  });
});

// --- EnvelopeCiphertextSchema ---

describe('EnvelopeCiphertextSchema', () => {
  it('accepts a valid ciphertext', () => {
    expect(EnvelopeCiphertextSchema.safeParse(VALID_CIPHERTEXT).success).toBe(true);
  });

  it('accepts optional aad', () => {
    expect(EnvelopeCiphertextSchema.safeParse({ ...VALID_CIPHERTEXT, aad: VALID_B64_16 }).success).toBe(true);
  });

  it('rejects algorithm !== aes-256-gcm', () => {
    expect(EnvelopeCiphertextSchema.safeParse({ ...VALID_CIPHERTEXT, algorithm: 'aes-128-gcm' }).success).toBe(false);
  });

  it('rejects non-base64 ciphertext', () => {
    expect(EnvelopeCiphertextSchema.safeParse({ ...VALID_CIPHERTEXT, ciphertext: '!!!' }).success).toBe(false);
  });

  it('rejects missing tag', () => {
    const { tag, ...rest } = VALID_CIPHERTEXT;
    expect(EnvelopeCiphertextSchema.safeParse(rest).success).toBe(false);
  });
});

// --- EncryptedChunkManifestSchema ---

describe('EncryptedChunkManifestSchema', () => {
  it('accepts a valid 3-chunk manifest', () => {
    expect(EncryptedChunkManifestSchema.safeParse(VALID_MANIFEST).success).toBe(true);
  });

  it('rejects chunks.length !== totalChunks', () => {
    const bad = { ...VALID_MANIFEST, totalChunks: 4 };
    expect(EncryptedChunkManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects non-monotonic chunk indices', () => {
    const bad = { ...VALID_MANIFEST, chunks: [makeChunk(0), makeChunk(2), makeChunk(1)] };
    expect(EncryptedChunkManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects chunk index gap', () => {
    const bad = { ...VALID_MANIFEST, chunks: [makeChunk(0), makeChunk(1), makeChunk(5)] };
    expect(EncryptedChunkManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects totalSizeBytes <= SINGLE_SHOT_THRESHOLD', () => {
    const bad = { ...VALID_MANIFEST, totalSizeBytes: SINGLE_SHOT_THRESHOLD_BYTES };
    expect(EncryptedChunkManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects chunkSizeBytes !== CHUNK_SIZE_BYTES', () => {
    const bad = { ...VALID_MANIFEST, chunkSizeBytes: 1024 };
    expect(EncryptedChunkManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects chunk sizeBytes > CHUNK_SIZE_BYTES', () => {
    const bigChunk = { ...makeChunk(0), sizeBytes: CHUNK_SIZE_BYTES + 1 };
    const bad = { ...VALID_MANIFEST, totalChunks: 1, chunks: [bigChunk] };
    expect(EncryptedChunkManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects invalid fileSha256', () => {
    const bad = { ...VALID_MANIFEST, fileSha256: 'XYZ' };
    expect(EncryptedChunkManifestSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts last chunk smaller than CHUNK_SIZE_BYTES', () => {
    const small = { ...makeChunk(2), sizeBytes: 1000 };
    const manifest = { ...VALID_MANIFEST, chunks: [makeChunk(0), makeChunk(1), small] };
    expect(EncryptedChunkManifestSchema.safeParse(manifest).success).toBe(true);
  });
});

// --- DeliverySuiteSchema ---

describe('DeliverySuiteSchema', () => {
  it('accepts hpke-rfc9180', () => {
    expect(DeliverySuiteSchema.safeParse('hpke-rfc9180').success).toBe(true);
  });

  it('accepts rsa-oaep-sha256', () => {
    expect(DeliverySuiteSchema.safeParse('rsa-oaep-sha256').success).toBe(true);
  });

  it('rejects unknown suite', () => {
    expect(DeliverySuiteSchema.safeParse('chacha20-poly1305').success).toBe(false);
  });
});

// --- RecipientDeliveryEnvelopeSchema ---

describe('RecipientDeliveryEnvelopeSchema', () => {
  it('accepts a valid HPKE envelope', () => {
    expect(RecipientDeliveryEnvelopeSchema.safeParse(VALID_DELIVERY).success).toBe(true);
  });

  it('accepts rsa-oaep-sha256 suite', () => {
    const rsa = { ...VALID_DELIVERY, suite: 'rsa-oaep-sha256' };
    expect(RecipientDeliveryEnvelopeSchema.safeParse(rsa).success).toBe(true);
  });

  it('accepts optional aad', () => {
    expect(RecipientDeliveryEnvelopeSchema.safeParse({ ...VALID_DELIVERY, aad: VALID_B64_16 }).success).toBe(true);
  });

  it('rejects missing enc', () => {
    const { enc, ...rest } = VALID_DELIVERY;
    expect(RecipientDeliveryEnvelopeSchema.safeParse(rest).success).toBe(false);
  });

  it('rejects recipientKeyVersion 0', () => {
    expect(RecipientDeliveryEnvelopeSchema.safeParse({ ...VALID_DELIVERY, recipientKeyVersion: 0 }).success).toBe(false);
  });

  it('rejects empty recipientKeyId', () => {
    expect(RecipientDeliveryEnvelopeSchema.safeParse({ ...VALID_DELIVERY, recipientKeyId: '' }).success).toBe(false);
  });
});

// --- RecipientPublicKeyMetadataSchema ---

describe('RecipientPublicKeyMetadataSchema', () => {
  it('accepts valid x25519 metadata', () => {
    expect(RecipientPublicKeyMetadataSchema.safeParse(VALID_KEY_META).success).toBe(true);
  });

  it('accepts rsa-2048', () => {
    expect(RecipientPublicKeyMetadataSchema.safeParse({ ...VALID_KEY_META, algorithm: 'rsa-2048' }).success).toBe(true);
  });

  it('accepts rsa-4096', () => {
    expect(RecipientPublicKeyMetadataSchema.safeParse({ ...VALID_KEY_META, algorithm: 'rsa-4096' }).success).toBe(true);
  });

  it('rejects unknown algorithm', () => {
    expect(RecipientPublicKeyMetadataSchema.safeParse({ ...VALID_KEY_META, algorithm: 'ed25519' }).success).toBe(false);
  });

  it('rejects invalid fingerprint', () => {
    expect(RecipientPublicKeyMetadataSchema.safeParse({ ...VALID_KEY_META, fingerprint: 'short' }).success).toBe(false);
  });

  it('accepts revokedAt as ISO datetime', () => {
    const revoked = { ...VALID_KEY_META, revokedAt: '2026-09-27T12:00:00.000Z' };
    expect(RecipientPublicKeyMetadataSchema.safeParse(revoked).success).toBe(true);
  });

  it('rejects version 0', () => {
    expect(RecipientPublicKeyMetadataSchema.safeParse({ ...VALID_KEY_META, version: 0 }).success).toBe(false);
  });
});

// --- Constants ---

describe('constants', () => {
  it('CHUNK_SIZE_BYTES is 4 MiB', () => {
    expect(CHUNK_SIZE_BYTES).toBe(4_194_304);
  });

  it('SINGLE_SHOT_THRESHOLD_BYTES is 5 MiB', () => {
    expect(SINGLE_SHOT_THRESHOLD_BYTES).toBe(5_242_880);
  });
});
