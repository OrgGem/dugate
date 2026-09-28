import { createHash } from 'node:crypto';
import type {
  ArtifactStorageFacade,
  ArtifactStorageUploadGrant,
  StoredArtifactVersion,
} from './storage-facade';

/**
 * DATA-02 storage port for the client-driven multipart upload lifecycle
 * (`init` → per-part grants → `complete` → `abort`). It is deliberately a
 * SEPARATE port from `ArtifactStorageFacade`: the single-PUT facade stays the
 * only port a PostgreSQL deployment has to satisfy, and a backend that cannot
 * hold an incomplete upload simply does not implement this one — the route
 * layer then answers 409 `MULTIPART_NOT_AVAILABLE` instead of silently
 * falling back to another backend.
 *
 * The provider upload id never crosses an API boundary: `createMultipartUpload`
 * returns it to the service, which stores it server-side and hands the client
 * an opaque handle derived from it.
 *
 * Failures must be reported as `ArtifactStorageError` with a stable code so
 * provider exception text (URLs, request ids, XML) cannot reach a response
 * body or a log line (ADM-BASE-03).
 */

/** One part exactly as storage holds it. `sha256` is lowercase hex, decoded
 * from the provider's base64 part checksum. */
export interface MultipartStoredPart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
  sha256: string;
}

export interface CreateMultipartUploadInput {
  artifactId: string;
  tenantId: string;
  objectKey: string;
  contentType: string;
}

export interface PresignMultipartPartInput {
  artifactId: string;
  tenantId: string;
  objectKey: string;
  uploadId: string;
  partNumber: number;
  /** Exact part byte count fixed by the server from the init geometry. */
  sizeBytes: number;
  /** Lowercase hex sha256 of the part bytes the client is about to PUT. */
  partSha256: string;
  expiresAt: string;
}

export interface CompleteMultipartUploadInput {
  artifactId: string;
  tenantId: string;
  objectKey: string;
  uploadId: string;
  /** Part numbers with the etags storage reported for them. */
  parts: readonly { partNumber: number; etag: string }[];
}

export interface MultipartUploadLocator {
  objectKey: string;
  uploadId: string;
}

export interface ArtifactMultipartStorage
  extends Pick<ArtifactStorageFacade, 'verifyAndPin' | 'delete'> {
  createMultipartUpload(input: CreateMultipartUploadInput): Promise<{ uploadId: string }>;
  /** Presigns exactly one part PUT, bound to the declared size and checksum. */
  presignUploadPart(input: PresignMultipartPartInput): Promise<ArtifactStorageUploadGrant>;
  /** Authoritative view of what storage actually holds for the upload. */
  listMultipartParts(input: MultipartUploadLocator): Promise<MultipartStoredPart[]>;
  completeMultipartUpload(input: CompleteMultipartUploadInput): Promise<Pick<StoredArtifactVersion, 'versionId'>>;
  /** Must be idempotent: an upload storage already discarded is not an error. */
  abortMultipartUpload(input: MultipartUploadLocator): Promise<void>;
}

/** Narrows a provider upload id to the stable opaque handle on the wire. */
export function multipartUploadHandle(uploadId: string): string {
  return `mh_${createHash('sha256').update(uploadId).digest('hex').slice(0, 16)}`;
}
