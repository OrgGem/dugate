// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source: packages/contracts/src/encryption.ts (lines=299) sha256=395E08800E3E7D6B2131C36AE85B41B70289F6C38B1970803101F266EBB7342E
// why: transitive dep of operations.ts + runtime.ts (RecipientDeliveryEnvelopeSchema, StorageEnvelopeRefSchema)

/**
 * W-ENC-01-SCHEMA (ADR-18, tasks/APP-ENCRYPTION-2026-09-27.md):
 * Application-layer envelope encryption wire-format schemas.
 *
 * These schemas define the CONTRACT for encrypted artifacts at rest
 * (S3/PG) and encrypted delivery to external recipients. They do NOT
 * implement any crypto operation - runtime encryption is ENC-03/04.
 *
 * Baseline (ADR-18):
 *   1. AES-256-GCM payload encryption with per-artifact DEK.
 *   2. DEK wrapped via Vault Transit (WrappedDekEnvelope).
 *   3. Files > 5 MB use 4 MB authenticated streaming chunks with
 *      monotonic index + per-chunk SHA-256 (EncryptedChunkManifest).
 *   4. Delivery encryption via recipient public key:
 *      Suite 1 (preferred): HPKE RFC 9180.
 *      Suite 2 (enterprise compat): RSA-OAEP-SHA256 key wrap.
 *   5. Fail-closed: no plaintext fallback when key missing/revoked.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Shared validation primitives
// ---------------------------------------------------------------------------

/** Standard base64 (RFC 4648); empty string is NOT valid. */
const BASE64_RE = /^[A-Za-z0-9+/]+={0,2}$/;

/** Lowercase hex SHA-256 digest (64 chars). */
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;

/** AES-256-GCM nonce is 12 bytes = 16 base64 chars (with padding). */
const GCM_NONCE_BYTES = 12;

/** AES-256-GCM auth tag is 16 bytes = 24 base64 chars (with padding). */
const GCM_TAG_BYTES = 16;

/** AES-256 key is 32 bytes = 44 base64 chars (with padding). */
const AES256_KEY_BYTES = 32;

/**
 * A 4 MiB chunk (ADR-18 streaming). Files <= 5 MB are single-shot;
 * files > 5 MB are split into chunks of exactly this size (last chunk
 * may be smaller).
 */
export const CHUNK_SIZE_BYTES = 4 * 1024 * 1024; // 4_194_304

/** Files at or below this threshold use single-shot encryption. */
export const SINGLE_SHOT_THRESHOLD_BYTES = 5 * 1024 * 1024; // 5_242_880

// ---------------------------------------------------------------------------
// WrappedDekEnvelope - DEK wrapped by Vault Transit
// ---------------------------------------------------------------------------

/**
 * The Data Encryption Key (DEK) for one artifact, wrapped (encrypted)
 * by Vault Transit. The plaintext DEK never persists outside the
 * encryption/decryption operation in memory.
 *
 * Fields:
 *   keyId       - Vault Transit key name (e.g. "du-artifact-v1").
 *   keyVersion  - Transit key version used for wrapping.
 *   wrappedKey  - base64 ciphertext of the DEK (32 bytes plaintext).
 *   nonce       - base64 nonce used during the wrap operation.
 *   tag         - base64 GCM auth tag of the wrap operation.
 */
export const WrappedDekEnvelopeSchema = z.object({
  version: z.literal(1),
  keyId: z.string().min(1).max(128),
  keyVersion: z.number().int().min(1),
  wrappedKey: z.string().regex(BASE64_RE, "wrappedKey must be valid base64"),
  nonce: z.string().regex(BASE64_RE, "nonce must be valid base64"),
  tag: z.string().regex(BASE64_RE, "tag must be valid base64"),
});
export type WrappedDekEnvelope = z.infer<typeof WrappedDekEnvelopeSchema>;

// ---------------------------------------------------------------------------
// EnvelopeCiphertext - single-shot encrypted artifact
// ---------------------------------------------------------------------------

/**
 * A single-shot AES-256-GCM encrypted blob (artifacts <= 5 MB).
 * The DEK that produced this ciphertext is stored alongside as a
 * WrappedDekEnvelope.
 *
 * Fields:
 *   algorithm  - always "aes-256-gcm" (extensible via version bump).
 *   nonce      - base64, exactly 12 bytes decoded.
 *   tag        - base64, exactly 16 bytes decoded (GCM auth tag).
 *   ciphertext - base64 encrypted payload.
 *   aad        - optional base64 Additional Authenticated Data.
 *               Binding context (artifactId, tenantId) to prevent
 *               ciphertext transplant. Exact AAD composition is a
 *               wire-profile decision (ENC-00 open item).
 */
export const EnvelopeCiphertextSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  nonce: z.string().regex(BASE64_RE, "nonce must be valid base64"),
  tag: z.string().regex(BASE64_RE, "tag must be valid base64"),
  ciphertext: z.string().regex(BASE64_RE, "ciphertext must be valid base64"),
  aad: z.string().regex(BASE64_RE, "aad must be valid base64").optional(),
});
export type EnvelopeCiphertext = z.infer<typeof EnvelopeCiphertextSchema>;

// ---------------------------------------------------------------------------
// EncryptedChunkManifest - streaming chunks for large files
// ---------------------------------------------------------------------------

/**
 * One chunk within an EncryptedChunkManifest. Chunks are encrypted
 * independently with the SAME DEK but DISTINCT nonces (monotonic
 * derivation or random). The monotonic index prevents reorder.
 */
export const EncryptedChunkSchema = z.object({
  /** Monotonic 0-based chunk index. */
  index: z.number().int().min(0),
  /** base64 nonce for this chunk AES-256-GCM encryption. */
  nonce: z.string().regex(BASE64_RE, "chunk nonce must be valid base64"),
  /** base64 GCM auth tag for this chunk. */
  tag: z.string().regex(BASE64_RE, "chunk tag must be valid base64"),
  /** SHA-256 hex of the PLAINTEXT chunk (integrity manifest). */
  sha256: z.string().regex(SHA256_HEX_RE, "chunk sha256 must be 64-char lowercase hex"),
  /** Plaintext byte length of this chunk (<= CHUNK_SIZE_BYTES). */
  sizeBytes: z.number().int().min(1).max(CHUNK_SIZE_BYTES),
});
export type EncryptedChunk = z.infer<typeof EncryptedChunkSchema>;

/**
 * Manifest for a large file (> 5 MB) encrypted as 4 MB streaming
 * chunks. Stored alongside the ciphertext blob(s).
 *
 * Anti-truncation: totalChunks is explicit and chunks array length
 * must equal it. Anti-reorder: index is monotonic and validated.
 * Anti-tamper: per-chunk SHA-256 over plaintext.
 *
 * Fields:
 *   chunkSizeBytes  - always CHUNK_SIZE_BYTES (4 MiB) for v1.
 *   totalChunks     - number of chunks.
 *   totalSizeBytes  - total PLAINTEXT file size.
 *   fileSha256      - SHA-256 hex of the entire plaintext file.
 *   chunks          - ordered array of EncryptedChunk.
 *   dek             - the wrapped DEK used for all chunks.
 */
export const EncryptedChunkManifestSchema = z.object({
  version: z.literal(1),
  chunkSizeBytes: z.literal(CHUNK_SIZE_BYTES),
  totalChunks: z.number().int().min(1),
  totalSizeBytes: z.number().int().min(SINGLE_SHOT_THRESHOLD_BYTES + 1),
  fileSha256: z.string().regex(SHA256_HEX_RE, "fileSha256 must be 64-char lowercase hex"),
  chunks: z.array(EncryptedChunkSchema).min(1),
  dek: WrappedDekEnvelopeSchema,
}).refine(
  (m) => m.chunks.length === m.totalChunks,
  { message: "chunks array length must equal totalChunks" },
).refine(
  (m) => {
    for (let i = 0; i < m.chunks.length; i++) {
      if (m.chunks[i]!.index !== i) return false;
    }
    return true;
  },
  { message: "chunk indices must be monotonic 0..totalChunks-1" },
);
export type EncryptedChunkManifest = z.infer<typeof EncryptedChunkManifestSchema>;

// ---------------------------------------------------------------------------
// RecipientDeliveryEnvelope - encrypted delivery to external tenant
// ---------------------------------------------------------------------------

/**
 * The two cipher suites for recipient delivery encryption.
 *   hpke-rfc9180:    HPKE (DHKEM(X25519, HKDF-SHA256), HKDF-SHA256,
 *                    AES-256-GCM). Preferred.
 *   rsa-oaep-sha256: RSA-OAEP-SHA256 key wrap + AES-256-GCM payload.
 *                    Enterprise/legacy compatibility.
 */
export const DeliverySuiteSchema = z.enum(['hpke-rfc9180', 'rsa-oaep-sha256']);
export type DeliverySuite = z.infer<typeof DeliverySuiteSchema>;

/**
 * Envelope carrying the encrypted result to an external recipient.
 * The payload ciphertext is produced with a fresh delivery DEK;
 * that DEK is then encapsulated (HPKE) or wrapped (RSA-OAEP) under
 * the recipient public key.
 *
 * Fields:
 *   version             - always 1.
 *   suite               - which cipher suite was used.
 *   recipientKeyId      - identifier of the recipient public key.
 *   recipientKeyVersion - pinned at result-generation time.
 *   enc                 - base64 encapsulated/wrapped delivery DEK.
 *   nonce               - base64 payload nonce (12 bytes for GCM).
 *   tag                 - base64 payload GCM auth tag (16 bytes).
 *   ciphertext          - base64 encrypted payload.
 *   aad                 - optional base64 AAD (wire-profile decision).
 */
export const RecipientDeliveryEnvelopeSchema = z.object({
  version: z.literal(1),
  suite: DeliverySuiteSchema,
  recipientKeyId: z.string().min(1).max(256),
  recipientKeyVersion: z.number().int().min(1),
  enc: z.string().regex(BASE64_RE, "enc must be valid base64"),
  nonce: z.string().regex(BASE64_RE, "nonce must be valid base64"),
  tag: z.string().regex(BASE64_RE, "tag must be valid base64"),
  ciphertext: z.string().regex(BASE64_RE, "ciphertext must be valid base64"),
  aad: z.string().regex(BASE64_RE, "aad must be valid base64").optional(),
}).strict();
export type RecipientDeliveryEnvelope = z.infer<typeof RecipientDeliveryEnvelopeSchema>;

// ---------------------------------------------------------------------------
// RecipientPublicKeyMetadata - registration metadata for tenant keys
// ---------------------------------------------------------------------------

/**
 * Metadata stored alongside a tenant-registered public key.
 * ADR-18: fingerprint (SHA-256), algorithm, version, effectiveAt,
 * revokedAt. Proof-of-Possession is a runtime concern (ENC-07).
 */
export const RecipientPublicKeyMetadataSchema = z.object({
  keyId: z.string().min(1).max(256),
  algorithm: z.enum(["x25519", "rsa-2048", "rsa-3072", "rsa-4096"]),
  version: z.number().int().min(1),
  /** SHA-256 hex fingerprint of the DER/SPKI public key bytes. */
  fingerprint: z.string().regex(SHA256_HEX_RE, "fingerprint must be 64-char lowercase hex"),
  /** ISO 8601 instant from which the key is valid. */
  effectiveAt: z.string().datetime(),
  /** ISO 8601 instant at which the key was revoked, or null. */
  revokedAt: z.string().datetime().nullable(),
});
export type RecipientPublicKeyMetadata = z.infer<typeof RecipientPublicKeyMetadataSchema>;

// ---------------------------------------------------------------------------
// StorageEnvelopeRef - ciphertext-at-rest envelope carried by a storage grant
// ---------------------------------------------------------------------------

/**
 * W-ENC-04-GRANT-SCHEMA (delta 57 item 1): the DEK shape the ENC-03 storage
 * facade actually produces and stores.
 *
 * This is deliberately NOT `WrappedDekEnvelopeSchema` above, and that is a
 * load-bearing difference rather than a duplicate. Two DEK shapes exist:
 *   - `WrappedDekEnvelopeSchema` = { keyId, wrappedKey, nonce, tag }  (ADR-18
 *     delivery/wrap envelope, recipient-facing).
 *   - this one                      = { keyRef, keyVersion, ciphertext }
 *     (what `EncryptedStorageObject.dek` holds on the storage path).
 * The runtime source of truth is `vault-transit-provider.WrappedDek`
 * (`keyRef`/`keyVersion`/`ciphertext`). Reusing the ADR-18 shape here would
 * produce a contract the storage facade cannot satisfy, and every real
 * object would fail for the wrong reason.
 */
export const StorageWrappedDekSchema = z.object({
  /** Vault Transit key name, e.g. "du-artifact-v1". */
  keyRef: z.string().min(1).max(256),
  /** Transit key version the DEK was wrapped under. Required, not optional: a
   *  reader that guessed "latest" could unwrap under a rotated key and then
   *  fail authentication for the wrong reason. */
  keyVersion: z.number().int().min(1),
  /** base64 Vault Transit ciphertext of the 32-byte DEK. */
  ciphertext: z.string().regex(BASE64_RE, "DEK ciphertext must be valid base64"),
}).strict();
export type StorageWrappedDek = z.infer<typeof StorageWrappedDekSchema>;

/**
 * Everything a worker needs to decrypt one stored object, MINUS the ciphertext
 * itself: the bytes arrive through the grant's `downloadUrl`, so this is a
 * REFERENCE to a ciphertext, not a copy. That is why `ciphertext` is absent
 * here while the in-process `EncryptedStorageObject` carries it as a Buffer.
 *
 * Field-for-field this mirrors `EncryptedStorageObject` in
 * `crypto-storage-facade.ts` and worker-sdk `crypto-storage.ts`.
 */
export const StorageEnvelopeRefSchema = z.object({
  version: z.literal(1),
  algorithm: z.literal("aes-256-gcm"),
  /** base64, exactly 12 bytes decoded (GCM nonce). */
  nonce: z.string().regex(BASE64_RE, "nonce must be valid base64"),
  /** base64, exactly 16 bytes decoded (GCM auth tag). */
  tag: z.string().regex(BASE64_RE, "tag must be valid base64"),
  /** base64 of the AAD JSON the facade authenticated. */
  aad: z.string().regex(BASE64_RE, "aad must be valid base64"),
  /** PLAINTEXT size. Distinct from the grant `sizeBytes`, which is what storage committed. */
  plaintextSizeBytes: z.number().int().min(0),
  /** SHA-256 hex over the plaintext, so a reader can verify after decryption. */
  plaintextSha256: z.string().regex(SHA256_HEX_RE, "plaintextSha256 must be 64-char lowercase hex"),
  dek: StorageWrappedDekSchema,
}).strict()
  // Byte lengths are enforced here rather than trusted from the regex: a
  // 13-byte nonce parses as base64 but cannot be an AES-GCM nonce, and would
  // otherwise fail deep inside the cipher with a misleading error.
  .refine((e) => Buffer.from(e.nonce, "base64").byteLength === GCM_NONCE_BYTES, {
    message: `nonce must decode to exactly ${GCM_NONCE_BYTES} bytes`,
    path: ["nonce"],
  })
  .refine((e) => Buffer.from(e.tag, "base64").byteLength === GCM_TAG_BYTES, {
    message: `tag must decode to exactly ${GCM_TAG_BYTES} bytes`,
    path: ["tag"],
  });
export type StorageEnvelopeRef = z.infer<typeof StorageEnvelopeRefSchema>;
