import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES,
  CryptoStorageError,
  type CryptoStorageContext,
  type CryptoStorageFacade,
  type EncryptedStorageManifest,
  type EncryptedStorageObject,
} from '../encryption/crypto-storage-facade';
import {
  ENCRYPTED_OBJECT_MARKER,
  ENCRYPTED_OBJECT_MARKER_VALUE,
  MANIFEST_KEY_METADATA,
  PUBLIC_UPLOAD_PURPOSE,
  manifestKeyFor,
} from '../encryption/artifact-read-decrypt';
import { ArtifactStorageError } from './storage-facade';

/**
 * SEC-ENC-04 (SD-03): server-mediated envelope encryption for WORKER artifact
 * writes.
 *
 * Why the seal lives here instead of in the worker: an untrusted worker cannot
 * be trusted to enforce storage encryption (a boolean/marker it sets proves
 * nothing), and handing every worker a Vault Transit capability would widen
 * the key surface. The Orchestrator therefore seals plaintext that arrived over
 * the internal transport (that exception is transport-only) before any byte
 * reaches PostgreSQL or S3, and only ever persists ciphertext + the
 * authenticated sidecar manifest.
 *
 * Carrier compatibility is deliberate: worker artifacts reuse the exact
 * envelope/AAD layout of the canonical `CryptoStorageFacade` and pin
 * `upload_token` as the object version, so the reviewed tenant-bound reader
 * (`modules/encryption/artifact-read-decrypt`) opens worker objects with no
 * second envelope format. The sidecar holds the RAW envelope/manifest (the
 * shape `parseManifest` consumes); identity/version are carried by the S3
 * object metadata and the artifact row and re-bound cryptographically by the
 * AAD, so a worker cannot redirect its bytes to another tenant/artifact.
 */

/** Same literal/purpose as the canonical reader; kept as its own export. */
export const WORKER_ARTIFACT_PURPOSE = PUBLIC_UPLOAD_PURPOSE;
export const ARTIFACT_MANIFEST_MARKER_VALUE = 'manifest-v1' as const;
export const ARTIFACT_CIPHERTEXT_CONTENT_TYPE = 'application/octet-stream';
export const ARTIFACT_SIDECAR_CONTENT_TYPE = 'application/json';
export { manifestKeyFor };

const SHA256_RE = /^[a-f0-9]{64}$/;

/** The injected crypto capability. Absent = this deployment does not seal. */
export interface WorkerArtifactEncryption {
  readonly facade: Pick<
    CryptoStorageFacade,
    'encrypt' | 'encryptStream' | 'decrypt' | 'decryptStream'
  >;
  /** Allowlisted storage key ref; the provider rejects anything else. */
  readonly keyRef: string;
  readonly keyVersion?: number;
  /**
   * Strict read policy: when true, a worker artifact without a sealed sidecar
   * is unreadable instead of being served as legacy plaintext. Default false
   * is the migration-window compatibility path; production wiring sets it from
   * the signed boot policy.
   */
  readonly required?: boolean;
}

export interface SealedWorkerArtifact {
  readonly ciphertext: Buffer;
  readonly ciphertextSha256: string;
  readonly ciphertextSizeBytes: number;
  readonly plaintextSha256: string;
  readonly plaintextSizeBytes: number;
  /** Sidecar JSON exactly as persisted next to the ciphertext object. */
  readonly sidecar: Buffer;
}

export interface WorkerArtifactIdentity {
  readonly tenantId: string;
  readonly artifactId: string;
  /** Pinned object version; worker rows store this in `artifacts.upload_token`. */
  readonly objectVersion: string;
}

export interface ParsedWorkerArtifactSidecar {
  readonly manifest: EncryptedStorageObject | EncryptedStorageManifest;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** The AAD context this identity must rebuild; callers derive it from the row. */
export function artifactEncryptionContext(identity: WorkerArtifactIdentity): CryptoStorageContext {
  return {
    tenantId: identity.tenantId,
    artifactId: identity.artifactId,
    objectVersion: identity.objectVersion,
    purpose: WORKER_ARTIFACT_PURPOSE,
  };
}

function encryptionContext(
  identity: WorkerArtifactIdentity,
  seam: WorkerArtifactEncryption,
): CryptoStorageContext & { keyRef: string; keyVersion?: number } {
  return {
    ...artifactEncryptionContext(identity),
    keyRef: seam.keyRef,
    ...(seam.keyVersion === undefined ? {} : { keyVersion: seam.keyVersion }),
  };
}

function mapCryptoError(error: unknown): never {
  if (error instanceof ArtifactStorageError) throw error;
  if (error instanceof CryptoStorageError) {
    if (error.code === 'KEY_PROVIDER_FAILED') {
      throw new ArtifactStorageError('ENCRYPTION_UNAVAILABLE');
    }
    if (error.code === 'SIZE_LIMIT') {
      throw new ArtifactStorageError('SIZE_MISMATCH');
    }
    throw new ArtifactStorageError('ENVELOPE_INVALID');
  }
  throw new ArtifactStorageError('STORAGE_UNAVAILABLE');
}

async function collectStream(stream: AsyncIterable<Uint8Array>, expectedBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += bytes.byteLength;
    if (!Number.isSafeInteger(total) || total > expectedBytes) {
      throw new ArtifactStorageError('SIZE_MISMATCH');
    }
    chunks.push(bytes);
  }
  if (total !== expectedBytes) throw new ArtifactStorageError('SIZE_MISMATCH');
  return Buffer.concat(chunks, total);
}

function toAsyncIterable(buffer: Buffer): AsyncIterable<Uint8Array> {
  return (async function* single() {
    yield buffer;
  })();
}

/**
 * Seal worker bytes for durable storage. Small objects use the single-shot
 * envelope; larger ones ride the authenticated 4 MiB chunk stream, whose
 * manifest is the only form that is safe to persist. Everything is assembled
 * in memory here because the proxy PUT already bounded the body; the format
 * itself is streaming-ready and the same facade can seal a Readable when the
 * ingress hands one over.
 */
export async function sealWorkerArtifact(input: {
  bytes: Buffer;
  identity: WorkerArtifactIdentity;
  seam: WorkerArtifactEncryption;
}): Promise<SealedWorkerArtifact> {
  const { bytes, identity, seam } = input;
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
    throw new ArtifactStorageError('INVALID_OBJECT_BODY');
  }
  try {
    let manifest: EncryptedStorageObject | EncryptedStorageManifest;
    let ciphertext: Buffer;
    if (bytes.byteLength <= CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES) {
      const encrypted = await seam.facade.encrypt(bytes, encryptionContext(identity, seam));
      manifest = encrypted;
      ciphertext = encrypted.ciphertext;
    } else {
      const stream = seam.facade.encryptStream(
        Readable.from([bytes]),
        encryptionContext(identity, seam),
      );
      const [ciphertextBuffer, encryptedManifest] = await Promise.all([
        collectStream(stream.ciphertext, bytes.byteLength),
        stream.manifest,
      ]);
      manifest = encryptedManifest;
      ciphertext = ciphertextBuffer;
    }
    const plaintextSha256 = 'chunks' in manifest
      ? manifest.fileSha256
      : manifest.plaintextSha256;
    const plaintextSizeBytes = 'chunks' in manifest
      ? manifest.totalSizeBytes
      : manifest.plaintextSizeBytes;
    if (plaintextSizeBytes !== bytes.byteLength || sha256Hex(bytes) !== plaintextSha256) {
      throw new ArtifactStorageError('ENVELOPE_INVALID');
    }
    const ciphertextSha256 = sha256Hex(ciphertext);
    // The sidecar is the RAW envelope/manifest the canonical reader parses.
    const sidecar = Buffer.from(JSON.stringify('chunks' in manifest
      ? manifest
      : {
          version: manifest.version,
          algorithm: manifest.algorithm,
          nonce: manifest.nonce,
          tag: manifest.tag,
          aad: manifest.aad,
          plaintextSizeBytes: manifest.plaintextSizeBytes,
          plaintextSha256: manifest.plaintextSha256,
          dek: manifest.dek,
        }), 'utf8');
    return {
      ciphertext,
      ciphertextSha256,
      ciphertextSizeBytes: ciphertext.byteLength,
      plaintextSha256,
      plaintextSizeBytes,
      sidecar,
    };
  } catch (error) {
    return mapCryptoError(error);
  }
}

/**
 * Parse one raw envelope/manifest sidecar. Shape-only here; tenant/artifact/
 * version binding is enforced cryptographically by the AAD on open, and by the
 * storage metadata/row that supplied the context.
 */
export function parseWorkerArtifactSidecar(raw: unknown): ParsedWorkerArtifactSidecar {
  if (!isRecord(raw)) throw new ArtifactStorageError('ENVELOPE_INVALID');
  if ('chunks' in raw) {
    const manifest = raw as unknown as EncryptedStorageManifest;
    if (
      !Array.isArray(manifest.chunks)
      || manifest.chunks.length < 1
      || typeof manifest.manifestMac !== 'string'
      || manifest.manifestMac.length < 1
    ) {
      throw new ArtifactStorageError('ENVELOPE_INVALID');
    }
    return { manifest };
  }
  const single = raw as unknown as EncryptedStorageObject;
  for (const field of ['version', 'algorithm', 'nonce', 'tag', 'aad', 'dek'] as const) {
    if (single[field] === undefined) throw new ArtifactStorageError('ENVELOPE_INVALID');
  }
  return { manifest: single };
}

/** Authenticated open under the caller-supplied (row-derived) context. */
export async function openWorkerArtifact(input: {
  sidecar: ParsedWorkerArtifactSidecar;
  ciphertext: Buffer;
  context: CryptoStorageContext;
  seam: Pick<WorkerArtifactEncryption, 'facade'>;
}): Promise<Buffer> {
  const { sidecar, ciphertext, context, seam } = input;
  try {
    if ('chunks' in sidecar.manifest) {
      return await collectStream(
        seam.facade.decryptStream(toAsyncIterable(ciphertext), sidecar.manifest, context),
        sidecar.manifest.totalSizeBytes,
      );
    }
    return await seam.facade.decrypt({ ...sidecar.manifest, ciphertext }, context);
  } catch (error) {
    return mapCryptoError(error);
  }
}

/** Verify plaintext business metadata against the authenticated envelope. */
export async function verifyWorkerArtifact(input: {
  sidecar: ParsedWorkerArtifactSidecar;
  ciphertext: Buffer;
  context: CryptoStorageContext;
  seam: Pick<WorkerArtifactEncryption, 'facade'>;
}): Promise<{ plaintextSha256: string; plaintextSizeBytes: number }> {
  const plaintext = await openWorkerArtifact(input);
  return {
    plaintextSha256: sha256Hex(plaintext),
    plaintextSizeBytes: plaintext.byteLength,
  };
}

/** Object metadata the canonical tenant-bound reader expects to find. */
export function sealedObjectMetadata(input: {
  artifactId: string;
  tenantId: string;
  manifestKey: string;
}): Record<string, string> {
  return {
    artifactid: input.artifactId,
    tenantid: input.tenantId,
    [ENCRYPTED_OBJECT_MARKER]: ENCRYPTED_OBJECT_MARKER_VALUE,
    [MANIFEST_KEY_METADATA]: input.manifestKey,
  };
}

/** Object metadata for the sidecar manifest itself. */
export function manifestObjectMetadata(input: {
  artifactId: string;
  tenantId: string;
}): Record<string, string> {
  return {
    artifactid: input.artifactId,
    tenantid: input.tenantId,
    [ENCRYPTED_OBJECT_MARKER]: ARTIFACT_MANIFEST_MARKER_VALUE,
  };
}
