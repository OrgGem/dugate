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
  | 'STORAGE_UNAVAILABLE';

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
}
