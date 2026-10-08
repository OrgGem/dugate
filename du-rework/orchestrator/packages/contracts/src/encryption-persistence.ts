/**
 * SEC-ENC-01 — canonical persistence-encryption policy and envelope freeze.
 *
 * Sensitive data persisted by Orchestrator, Connector or workers MUST be
 * encrypted before it reaches S3, PostgreSQL, an outbox or any other durable
 * store. Internal HTTP transit may stay plaintext (user-confirmed transport
 * exception); the receiver encrypts before persistence. This module freezes
 * the producer/consumer interface for that policy:
 *
 *   - the closed purpose/slot taxonomy (metadata slots + storage purposes +
 *     reserved names for SEC-ENC-02/03/04 writers),
 *   - the small metadata envelope (`SealedMetadataEnvelope`),
 *   - the streaming storage manifest (`EncryptedStorageStreamManifest`) and
 *     the storage AAD shapes the facade authenticates,
 *   - the explicit synthetic-data exemption (absence of config = required),
 *   - the metadata AAD derivation contract.
 *
 * Runtime crypto lives in `services/orchestrator/src/modules/encryption` and
 * `modules/runtime/metadata-crypto.ts`; these schemas only freeze the shapes so
 * all three services cannot drift into incompatible envelopes.
 */
import { z } from 'zod';
import {
  CHUNK_SIZE_BYTES,
  SINGLE_SHOT_THRESHOLD_BYTES,
  StorageWrappedDekSchema,
} from './encryption';

/** Bump only on a breaking change to any frozen shape below. */
export const PERSISTENCE_POLICY_VERSION = 1 as const;

const BASE64_RE = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const SHA256_HEX_RE = /^[a-f0-9]{64}$/;
const GCM_NONCE_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MANIFEST_MAC_BYTES = 32;
const METADATA_AAD_DIGEST_BYTES = 32;

function base64OfBytes(bytes: number): z.ZodType<string> {
  return z.string().regex(BASE64_RE).refine((value) => Buffer.from(value, 'base64').byteLength === bytes, {
    message: `must decode to exactly ${bytes} bytes`,
  });
}

const Base64NonEmptySchema = z.string().regex(BASE64_RE).min(1);
const Sha256HexSchema = z.string().regex(SHA256_HEX_RE);

// ---------------------------------------------------------------------------
// Purpose taxonomy
// ---------------------------------------------------------------------------

/**
 * Control-plane metadata purposes that are ENFORCED today (sealed by
 * `modules/runtime/metadata-crypto.ts`; must stay equal to its METADATA_SLOTS,
 * asserted by `tests/persistence-encryption-freeze.test.ts`).
 */
export const ENFORCED_METADATA_PURPOSES = [
  'operations.input_ref',
  'tasks.payload_ref',
  'human_waits.response_ref',
  'step_checkpoints.output_ref',
  'step_checkpoints.session_ref',
  'operations.prompt_overrides_ref',
  'tasks.result_ref',
  'operations.result_ref',
  'legacy_workflow_schemas.schema_ref',
] as const;

/** Storage purpose the crypto-storage facade applies when none is named. */
export const DEFAULT_STORAGE_PURPOSE = 'artifact-storage' as const;

/** Enforced today: metadata slots plus the storage default. */
export const ENFORCED_PERSISTENCE_PURPOSES = [
  ...ENFORCED_METADATA_PURPOSES,
  DEFAULT_STORAGE_PURPOSE,
] as const;

/**
 * Reserved names frozen NOW for the parallel writers (SEC-ENC-02 Connector
 * request/result/session, SEC-ENC-03 source cache, SEC-ENC-04 worker outputs
 * and PG blobs, outbox/idempotency/webhook durable copies). A writer that
 * persists one of these classes MUST use the name declared here; an
 * unclassified field is not an approved plaintext exception.
 */
export const PLANNED_PERSISTENCE_PURPOSES = [
  'connector.invocation.request',
  'connector.invocation.result',
  'connector.invocation.session',
  'source.acquisition-cache',
  'artifact.worker-output',
  'usage.outbox.payload',
  'idempotency.response_body',
  'webhook.delivery.payload',
] as const;

export const PERSISTENCE_PURPOSES = [
  ...ENFORCED_METADATA_PURPOSES,
  DEFAULT_STORAGE_PURPOSE,
  ...PLANNED_PERSISTENCE_PURPOSES,
] as const;

export const PersistencePurposeSchema = z.enum(PERSISTENCE_PURPOSES);
export type PersistencePurpose = z.infer<typeof PersistencePurposeSchema>;

/** Enforced formats available to consumers; planned families are named in docs/41. */
export const PERSISTENCE_FORMATS = [
  'sealed-metadata-v1',
  'storage-envelope-ref-v1',
  'storage-stream-manifest-v1',
  'recipient-delivery-envelope-v1',
] as const;
export const PersistenceFormatSchema = z.enum(PERSISTENCE_FORMATS);
export type PersistenceFormat = z.infer<typeof PersistenceFormatSchema>;

// ---------------------------------------------------------------------------
// Synthetic-data exemption: explicit, never enabled by omission
// ---------------------------------------------------------------------------

export const PERSISTENCE_REQUIRED_MODE = 'required' as const;

/**
 * The ONLY accepted opt-out for non-real data. All fields are required; a
 * deployment that omits configuration stays in `required` mode. Enforcement
 * of this shape at boot belongs to SEC-ENC-05.
 */
export const SyntheticDataExemptionSchema = z
  .object({
    mode: z.literal('synthetic-data-exempt'),
    reason: z.string().min(1).max(512),
    approvedBy: z.string().min(1).max(128),
    acknowledgedAt: z.string().datetime(),
    isolatedFromRealData: z.literal(true),
  })
  .strict();
export type SyntheticDataExemption = z.infer<typeof SyntheticDataExemptionSchema>;

// ---------------------------------------------------------------------------
// AAD shapes (bound into AES-256-GCM authentication)
// ---------------------------------------------------------------------------

/** Storage object identity the facade binds into every AAD. */
export const StorageContextAadSchema = z
  .object({
    format: z.literal('du-crypto-storage-v1'),
    tenantId: z.string().min(1).max(512),
    artifactId: z.string().min(1).max(512),
    objectVersion: z.string().min(1).max(512),
    purpose: z.string().min(1).max(128),
  })
  .strict();
export type StorageContextAad = z.infer<typeof StorageContextAadSchema>;

/** AAD for one single-shot encrypted storage object. */
export const StorageSingleShotAadSchema = z
  .object({
    format: z.literal('du-crypto-storage-single-v1'),
    context: StorageContextAadSchema,
    sizeBytes: z.number().int().min(0),
    sha256: Sha256HexSchema,
  })
  .strict();
export type StorageSingleShotAad = z.infer<typeof StorageSingleShotAadSchema>;

/** AAD for one streaming chunk (index/size/digest prevent reorder/truncation). */
export const StorageChunkAadSchema = z
  .object({
    format: z.literal('du-crypto-storage-chunk-v1'),
    context: StorageContextAadSchema,
    index: z.number().int().min(0),
    sizeBytes: z.number().int().min(1).max(CHUNK_SIZE_BYTES),
    sha256: Sha256HexSchema,
  })
  .strict();
export type StorageChunkAad = z.infer<typeof StorageChunkAadSchema>;

/**
 * Metadata AAD context. The runtime derives the authenticated bytes as
 * `sha256(`${tenantId}|${purpose}|${entityId}`)` so the AAD stays a fixed
 * 32 bytes and leaks no row id; `purpose` is the persisted slot.
 */
export const MetadataAadInputSchema = z
  .object({
    tenantId: z.string().min(1).max(512),
    purpose: PersistencePurposeSchema,
    entityId: z.string().min(1).max(512),
  })
  .strict();
export type MetadataAadInput = z.infer<typeof MetadataAadInputSchema>;

/** Base64 of the 32-byte digest above, exactly as stored. */
export const MetadataAadDigestSchema = base64OfBytes(METADATA_AAD_DIGEST_BYTES);
export const METADATA_AAD_DERIVATION = 'sha256(`${tenantId}|${purpose}|${entityId}`)';

// ---------------------------------------------------------------------------
// Small metadata envelope (one JSON value per DB column/outbox row)
// ---------------------------------------------------------------------------

export const SealedMetadataEnvelopeSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('aes-256-gcm'),
    keyRef: z.string().min(1).max(256),
    dek: z
      .object({
        version: z.number().int().min(1),
        keyName: z.string().min(1).max(256),
        keyVersion: z.number().int().min(1),
        wrappedKey: Base64NonEmptySchema,
      })
      .strict(),
    nonce: base64OfBytes(GCM_NONCE_BYTES),
    tag: base64OfBytes(GCM_TAG_BYTES),
    aad: MetadataAadDigestSchema,
    ciphertext: Base64NonEmptySchema,
    plaintextSha256: Sha256HexSchema,
  })
  .strict();
export type SealedMetadataEnvelope = z.infer<typeof SealedMetadataEnvelopeSchema>;

// ---------------------------------------------------------------------------
// Streaming artifact envelope (facade manifest, > single-shot threshold)
// ---------------------------------------------------------------------------

export const EncryptedStorageChunkMetadataSchema = z
  .object({
    index: z.number().int().min(0),
    nonce: base64OfBytes(GCM_NONCE_BYTES),
    tag: base64OfBytes(GCM_TAG_BYTES),
    sha256: Sha256HexSchema,
    sizeBytes: z.number().int().min(1).max(CHUNK_SIZE_BYTES),
  })
  .strict();
export type EncryptedStorageChunkMetadata = z.infer<typeof EncryptedStorageChunkMetadataSchema>;

/**
 * The streaming artifact envelope: ordered, nonce-distinct, MAC-authenticated
 * chunks over a plaintext larger than the single-shot threshold. `manifestMac`
 * is keyed from the DEK and the context AAD (HKDF), so chunk metadata and the
 * wrapped DEK cannot be edited undetected.
 */
export const EncryptedStorageStreamManifestSchema = z
  .object({
    version: z.literal(1),
    algorithm: z.literal('aes-256-gcm'),
    chunkSizeBytes: z.literal(CHUNK_SIZE_BYTES),
    totalChunks: z.number().int().min(1),
    totalSizeBytes: z.number().int().min(SINGLE_SHOT_THRESHOLD_BYTES + 1),
    fileSha256: Sha256HexSchema,
    contextAad: Base64NonEmptySchema,
    chunks: z.array(EncryptedStorageChunkMetadataSchema).min(1),
    dek: StorageWrappedDekSchema,
    manifestMac: base64OfBytes(MANIFEST_MAC_BYTES),
  })
  .strict()
  .superRefine((manifest, ctx) => {
    let contextOk = false;
    try {
      contextOk = StorageContextAadSchema.safeParse(
        JSON.parse(Buffer.from(manifest.contextAad, 'base64').toString('utf8')) as unknown,
      ).success;
    } catch {
      contextOk = false;
    }
    if (!contextOk) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['contextAad'], message: 'contextAad must encode a StorageContextAad' });
    }
    if (manifest.chunks.length !== manifest.totalChunks) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chunks'], message: 'chunks length must equal totalChunks' });
    }
    let summed = 0;
    const nonces = new Set<string>();
    manifest.chunks.forEach((chunk, position) => {
      if (chunk.index !== position) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chunks', position], message: 'indices must be monotonic 0..totalChunks-1' });
      }
      if (position < manifest.chunks.length - 1 && chunk.sizeBytes !== CHUNK_SIZE_BYTES) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chunks', position], message: 'only the last chunk may be smaller than the chunk size' });
      }
      if (nonces.has(chunk.nonce)) {
        ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['chunks', position], message: 'chunk nonces must be unique' });
      }
      nonces.add(chunk.nonce);
      summed += chunk.sizeBytes;
    });
    if (summed !== manifest.totalSizeBytes) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['totalSizeBytes'], message: 'chunk sizes must sum to totalSizeBytes' });
    }
  });
export type EncryptedStorageStreamManifest = z.infer<typeof EncryptedStorageStreamManifestSchema>;
