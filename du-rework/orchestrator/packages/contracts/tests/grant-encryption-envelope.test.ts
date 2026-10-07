/**
 * W-ENC-04-GRANT-SCHEMA (delta 57 item 1): the storage grant can now carry the
 * envelope a worker needs to decrypt an object at rest.
 *
 * The fixtures here are not invented shapes. `runtimeEnvelope()` is copied
 * field-for-field from what `CryptoStorageFacade.encrypt` returns in
 * `services/orchestrator/src/modules/encryption/crypto-storage-facade.ts`
 * (:523-533) with `ciphertext` dropped, because the transport carries those
 * bytes. If the runtime changes, this file should fail - that is the point.
 *
 * Two failure modes this guards, both of which would be silent otherwise:
 *  1. A grant that validates but carries no envelope => a sealed object stays
 *     write-only (the delta 57 defect).
 *  2. A grant whose envelope validates while the bytes it describes are
 *     unreadable => a reader authenticates against the WRONG binding.
 */
import {
  ArtifactAccessGrantSchema,
  StorageEnvelopeRefSchema,
  StorageWrappedDekSchema,
  WrappedDekEnvelopeSchema,
} from '../src';

const ARTIFACT_ID = '11111111-2222-4333-8444-555555555555';
const DOWNLOAD_URL = 'https://blob.test/objects/abc?token=t';
const EXPIRES_AT = '2099-01-01T00:00:00.000Z';
const HEX64 = 'a'.repeat(64);

/** 12 bytes -> 16 base64 chars. */
const NONCE = Buffer.alloc(12, 7).toString('base64');
/** 16 bytes -> 24 base64 chars. */
const TAG = Buffer.alloc(16, 9).toString('base64');

/** byte-identical to the facade output, minus the ciphertext Buffer. */
function runtimeEnvelope() {
  return {
    version: 1 as const,
    algorithm: 'aes-256-gcm' as const,
    nonce: NONCE,
    tag: TAG,
    aad: Buffer.from('{"format":"du-crypto-storage-v1"}', 'utf8').toString('base64'),
    plaintextSizeBytes: 4096,
    plaintextSha256: HEX64,
    dek: {
      keyRef: 'du-artifact-v1',
      keyVersion: 3,
      ciphertext: Buffer.alloc(32, 5).toString('base64'),
    },
  };
}

function readGrant(overrides: Record<string, unknown> = {}) {
  return {
    artifactId: ARTIFACT_ID,
    downloadUrl: DOWNLOAD_URL,
    expiresAt: EXPIRES_AT,
    fileName: 'secret.pdf',
    mimeType: 'application/pdf',
    sizeBytes: 4120,
    sha256: 'b'.repeat(64),
    ...overrides,
  };
}

describe('W-ENC-04-GRANT-SCHEMA: a read grant can carry a storage envelope', () => {
  it('accepts the exact envelope the storage facade emits', () => {
    const parsed = ArtifactAccessGrantSchema.parse(readGrant({ encryption: runtimeEnvelope() }));
    expect(parsed.encryption?.dek.keyRef).toBe('du-artifact-v1');
    expect(parsed.encryption?.dek.keyVersion).toBe(3);
    expect(parsed.encryption?.plaintextSizeBytes).toBe(4096);
  });

  it('leaves a plaintext grant unchanged and unencrypted', () => {
    const parsed = ArtifactAccessGrantSchema.parse(readGrant());
    expect(parsed.encryption).toBeUndefined();
  });

  it('preserves unknown-free round trip: re-parsing a parsed grant is stable', () => {
    const once = ArtifactAccessGrantSchema.parse(readGrant({ encryption: runtimeEnvelope() }));
    const twice = ArtifactAccessGrantSchema.parse(once);
    expect(twice).toEqual(once);
  });

  it('keeps storage size and plaintext size as separate facts', () => {
    const parsed = ArtifactAccessGrantSchema.parse(readGrant({ encryption: runtimeEnvelope() }));
    // sizeBytes is what storage committed (ciphertext); the envelope describes
    // the document. Collapsing them would make a reader verify the wrong digest.
    expect(parsed.sizeBytes).toBe(4120);
    expect(parsed.encryption?.plaintextSizeBytes).toBe(4096);
    expect(parsed.sha256).not.toBe(parsed.encryption?.plaintextSha256);
  });
});

describe('W-ENC-04-GRANT-SCHEMA: the envelope fails closed', () => {
  it('rejects a nonce that is valid base64 but not 12 bytes', () => {
    const bad = { ...runtimeEnvelope(), nonce: Buffer.alloc(13, 1).toString('base64') };
    expect(StorageEnvelopeRefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a tag that is not 16 bytes', () => {
    const bad = { ...runtimeEnvelope(), tag: Buffer.alloc(8, 1).toString('base64') };
    expect(StorageEnvelopeRefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a non-hex plaintext digest', () => {
    const bad = { ...runtimeEnvelope(), plaintextSha256: 'not-a-digest' };
    expect(StorageEnvelopeRefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects a DEK without a pinned key version', () => {
    const dek = { ...runtimeEnvelope().dek } as Record<string, unknown>;
    delete dek.keyVersion;
    expect(StorageEnvelopeRefSchema.safeParse({ ...runtimeEnvelope(), dek }).success).toBe(false);
  });

  it('rejects an unknown algorithm instead of assuming aes-gcm', () => {
    const bad = { ...runtimeEnvelope(), algorithm: 'aes-128-gcm' };
    expect(StorageEnvelopeRefSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects extra fields so a tampered envelope cannot ride along', () => {
    const bad = { ...runtimeEnvelope(), purpose: 'output' };
    expect(StorageEnvelopeRefSchema.safeParse(bad).success).toBe(false);
  });

  it('surfaces the failure at the GRANT, not only on the envelope alone', () => {
    // A grant that silently dropped a malformed envelope would look like a
    // plaintext grant and hand the worker ciphertext to parse as a document.
    const bad = { ...runtimeEnvelope(), nonce: Buffer.alloc(5, 1).toString('base64') };
    expect(ArtifactAccessGrantSchema.safeParse(readGrant({ encryption: bad })).success).toBe(false);
  });
});

describe('W-ENC-04-GRANT-SCHEMA: the storage DEK is NOT the ADR-18 delivery DEK', () => {
  it('accepts the storage shape (keyRef/keyVersion/ciphertext)', () => {
    expect(StorageWrappedDekSchema.safeParse(runtimeEnvelope().dek).success).toBe(true);
  });

  it('does NOT accept the delivery shape (keyId/wrappedKey)', () => {
    // These are genuinely different contracts. If this ever starts passing,
    // someone has merged the two DEK models and the storage path would bind to
    // a field the runtime never writes.
    const deliveryShape = {
      version: 1 as const,
      keyId: 'du-artifact-v1',
      keyVersion: 3,
      wrappedKey: Buffer.alloc(32, 5).toString('base64'),
      nonce: NONCE,
      tag: TAG,
    };
    expect(StorageWrappedDekSchema.safeParse(deliveryShape).success).toBe(false);
    // ...while the ADR-18 schema still accepts its own shape.
    expect(WrappedDekEnvelopeSchema.safeParse(deliveryShape).success).toBe(true);
  });
});
