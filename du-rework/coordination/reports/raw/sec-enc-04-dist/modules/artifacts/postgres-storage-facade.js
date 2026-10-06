"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createPostgresArtifactStorageFacade = createPostgresArtifactStorageFacade;
const node_crypto_1 = require("node:crypto");
const node_stream_1 = require("node:stream");
const storage_facade_1 = require("./storage-facade");
/** PostgreSQL fallback; a content hash acts as its immutable generation ID. */
function createPostgresArtifactStorageFacade(blobs) {
    return {
        async createUploadGrant(input) {
            if (!input.proxyUrl)
                throw new storage_facade_1.ArtifactStorageError('INVALID_UPLOAD_GRANT');
            return { url: input.proxyUrl, expiresAt: input.expiresAt };
        },
        async verifyAndPin(input) {
            const bytes = await blobs.read(input.objectKey);
            if (bytes === null)
                throw new storage_facade_1.ArtifactStorageError('OBJECT_NOT_FOUND');
            const sizeBytes = bytes.byteLength;
            const sha256 = (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
            if (sha256 !== input.expectedSha256) {
                throw new storage_facade_1.ArtifactStorageError('CHECKSUM_MISMATCH');
            }
            if (sizeBytes !== input.expectedSizeBytes) {
                throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
            }
            return { objectKey: input.objectKey, versionId: sha256, sizeBytes, sha256 };
        },
        async openRead(version) {
            const bytes = await blobs.read(version.objectKey);
            if (bytes === null)
                throw new storage_facade_1.ArtifactStorageError('OBJECT_NOT_FOUND');
            const sha256 = (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
            if (!version.versionId || version.versionId !== sha256) {
                throw new storage_facade_1.ArtifactStorageError('CHECKSUM_MISMATCH');
            }
            return node_stream_1.Readable.from([bytes]);
        },
        async delete(version) {
            const bytes = await blobs.read(version.objectKey);
            if (bytes === null)
                return;
            const sha256 = (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
            if (!version.versionId || version.versionId !== sha256) {
                throw new storage_facade_1.ArtifactStorageError('CHECKSUM_MISMATCH');
            }
            await blobs.delete(version.objectKey);
        },
        async putServerObject(input) {
            if (!blobs.write)
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            if (!(input.body instanceof Uint8Array) || input.body.byteLength < 1) {
                throw new storage_facade_1.ArtifactStorageError('INVALID_OBJECT_BODY');
            }
            await blobs.write(input.objectKey, input.tenantId, input.body);
            return { versionId: (0, node_crypto_1.createHash)('sha256').update(input.body).digest('hex') };
        },
        async readServerObject(objectKey) {
            const bytes = await blobs.read(objectKey);
            if (bytes === null)
                throw new storage_facade_1.ArtifactStorageError('OBJECT_NOT_FOUND');
            return bytes;
        },
    };
}
