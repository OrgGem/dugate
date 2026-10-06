import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ArtifactStorageError,
  type ArtifactStorageFacade,
  type ArtifactStorageUploadGrant,
  type ArtifactUploadGrantInput,
  type StoredArtifactVersion,
  type VerifyAndPinArtifactInput,
} from './storage-facade';

export interface PostgresArtifactBlobPort {
  read(storageKey: string): Promise<Buffer | null>;
  delete(storageKey: string): Promise<void>;
}

/** PostgreSQL fallback; a content hash acts as its immutable generation ID. */
export function createPostgresArtifactStorageFacade(
  blobs: PostgresArtifactBlobPort,
): ArtifactStorageFacade {
  return {
    async createUploadGrant(input: ArtifactUploadGrantInput): Promise<ArtifactStorageUploadGrant> {
      if (!input.proxyUrl) throw new ArtifactStorageError('INVALID_UPLOAD_GRANT');
      return { url: input.proxyUrl, expiresAt: input.expiresAt };
    },

    async verifyAndPin(input: VerifyAndPinArtifactInput): Promise<StoredArtifactVersion> {
      const bytes = await blobs.read(input.objectKey);
      if (bytes === null) throw new ArtifactStorageError('OBJECT_NOT_FOUND');
      const sizeBytes = bytes.byteLength;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (sha256 !== input.expectedSha256) {
        throw new ArtifactStorageError('CHECKSUM_MISMATCH');
      }
      if (sizeBytes !== input.expectedSizeBytes) {
        throw new ArtifactStorageError('SIZE_MISMATCH');
      }
      return { objectKey: input.objectKey, versionId: sha256, sizeBytes, sha256 };
    },

    async openRead(version): Promise<Readable> {
      const bytes = await blobs.read(version.objectKey);
      if (bytes === null) throw new ArtifactStorageError('OBJECT_NOT_FOUND');
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (!version.versionId || version.versionId !== sha256) {
        throw new ArtifactStorageError('CHECKSUM_MISMATCH');
      }
      return Readable.from([bytes]);
    },

    async delete(version): Promise<void> {
      const bytes = await blobs.read(version.objectKey);
      if (bytes === null) return;
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (!version.versionId || version.versionId !== sha256) {
        throw new ArtifactStorageError('CHECKSUM_MISMATCH');
      }
      await blobs.delete(version.objectKey);
    },
  };
}
