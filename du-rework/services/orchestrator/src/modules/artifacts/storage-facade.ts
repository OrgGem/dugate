import type { Readable } from 'node:stream';

/** Internal immutable locator for one exact stored object generation.
 * Keep objectKey/versionId in Orchestrator metadata; never return them as a
 * worker or public ArtifactRef. */
export interface StoredArtifactVersion {
  objectKey: string;
  versionId: string;
  sizeBytes: number;
  sha256: string;
}

export interface ArtifactUploadGrantInput {
  artifactId: string;
  tenantId: string;
  objectKey: string;
  contentType: string;
  maxBytes: number;
  expiresAt: string;
  /** Existing Orchestrator proxy route used by the PostgreSQL fallback. */
  proxyUrl?: string;
}

export interface ArtifactStorageUploadGrant {
  url: string;
  expiresAt: string;
  headers?: Readonly<Record<string, string>>;
}

export interface VerifyAndPinArtifactInput {
  artifactId: string;
  tenantId: string;
  objectKey: string;
  expectedSizeBytes: number;
  expectedSha256: string;
}

export type ArtifactStorageErrorCode =
  | 'INVALID_UPLOAD_GRANT'
  | 'OBJECT_NOT_FOUND'
  | 'OBJECT_VERSION_REQUIRED'
  | 'ARTIFACT_METADATA_MISMATCH'
  | 'TENANT_METADATA_MISMATCH'
  | 'SIZE_MISMATCH'
  | 'CHECKSUM_MISMATCH'
  | 'INVALID_OBJECT_BODY'
  | 'STORAGE_UNAVAILABLE'
  | 'ENCRYPTION_UNAVAILABLE'
  | 'ENCRYPTION_REQUIRED'
  | 'ENVELOPE_INVALID';

/** Server-mediated write of one Orchestrator-produced object (SEC-ENC-04). */
export interface ServerObjectWriteInput {
  readonly objectKey: string;
  readonly tenantId: string;
  readonly body: Buffer;
  readonly contentType: string;
  /** Object metadata (S3) — identity/marker keys for the canonical reader. */
  readonly metadata?: Readonly<Record<string, string>>;
}

/** Stable storage failures keep provider exception text out of API responses and logs. */
export class ArtifactStorageError extends Error {
  constructor(readonly code: ArtifactStorageErrorCode) {
    super(code);
    this.name = 'ArtifactStorageError';
  }
}

/**
 * DATA-01 storage port shared by S3 and PostgreSQL fallback adapters. The
 * object key and version stay in Orchestrator metadata; worker/public refs
 * continue to carry only artifact IDs and integrity metadata.
 *
 * Implementations must scope upload grants to one tenant/artifact/key, method,
 * content type, byte limit, and expiry. `proxyUrl` is used only by the
 * PostgreSQL fallback, whose PUT still passes through the grant-protected API.
 * `verifyAndPin` verifies actual bytes
 * and returns a concrete immutable generation. `openRead` and `delete` must
 * address that exact generation, never an unpinned "latest" object. A backend
 * without version IDs must use a unique immutable key per generation.
 */
export interface ArtifactStorageFacade {
  createUploadGrant(input: ArtifactUploadGrantInput): Promise<ArtifactStorageUploadGrant>;
  verifyAndPin(input: VerifyAndPinArtifactInput): Promise<StoredArtifactVersion>;
  openRead(version: Pick<StoredArtifactVersion, 'objectKey' | 'versionId'>): Promise<Readable>;
  delete(version: Pick<StoredArtifactVersion, 'objectKey' | 'versionId'>): Promise<void>;
  /**
   * SEC-ENC-04: server-mediated write of an object the Orchestrator itself
   * produced (sealed artifact ciphertext or its manifest sidecar). Optional:
   * a backend without this port cannot host server-sealed worker artifacts,
   * and the artifact service fails closed rather than writing plaintext.
   */
  putServerObject?(input: ServerObjectWriteInput): Promise<{ versionId: string | null }>;
  /**
   * SEC-ENC-04: read one server-mediated object by key. Throws
   * `OBJECT_NOT_FOUND` when the object (or sidecar) does not exist, so the
   * caller can distinguish a legacy plaintext row from a sealed one.
   */
  readServerObject?(objectKey: string): Promise<Buffer>;
}
