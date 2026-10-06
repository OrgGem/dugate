"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.S3MultipartUploadError = exports.MAX_S3_MULTIPART_OBJECT_BYTES = exports.MAX_S3_MULTIPART_PARTS = exports.DEFAULT_S3_MULTIPART_PART_BYTES = exports.MIN_S3_MULTIPART_PART_BYTES = exports.ArtifactStorageError = void 0;
exports.createS3ArtifactStorageFacade = createS3ArtifactStorageFacade;
const node_crypto_1 = require("node:crypto");
const node_stream_1 = require("node:stream");
const client_s3_1 = require("@aws-sdk/client-s3");
const s3_request_presigner_1 = require("@aws-sdk/s3-request-presigner");
const storage_facade_1 = require("./storage-facade");
var storage_facade_2 = require("./storage-facade");
Object.defineProperty(exports, "ArtifactStorageError", { enumerable: true, get: function () { return storage_facade_2.ArtifactStorageError; } });
const MAX_PRESIGNED_URL_SECONDS = 7 * 24 * 60 * 60;
const MAX_SINGLE_PUT_BYTES = 5 * 1024 * 1024 * 1024;
exports.MIN_S3_MULTIPART_PART_BYTES = 5 * 1024 * 1024;
exports.DEFAULT_S3_MULTIPART_PART_BYTES = 8 * 1024 * 1024;
exports.MAX_S3_MULTIPART_PARTS = 10_000;
exports.MAX_S3_MULTIPART_OBJECT_BYTES = 5 * 1024 * 1024 * 1024 * 1024;
const MAX_MULTIPART_SOURCE_CHUNK_BYTES = 1024 * 1024;
/** Part-set cross-check pagination: 32 * 1000 pages is past the 10k part ceiling. */
const LIST_PARTS_PAGE_SIZE = 1000;
const MAX_LIST_PARTS_PAGES = 32;
class S3MultipartUploadError extends Error {
    code;
    checkpoint;
    constructor(code, checkpoint) {
        super(code);
        this.code = code;
        this.checkpoint = checkpoint;
        this.name = 'S3MultipartUploadError';
    }
}
exports.S3MultipartUploadError = S3MultipartUploadError;
/**
 * AWS S3 implementation of the internal artifact storage port.
 * The bucket must have versioning enabled. Finalization rejects missing and
 * suspended-bucket "null" versions, and hashes the exact version it pins.
 */
function createS3ArtifactStorageFacade(options) {
    const now = options.now ?? Date.now;
    const signPut = options.presignPut ?? ((client, command, expiresInSeconds) => (0, s3_request_presigner_1.getSignedUrl)(client, command, {
        expiresIn: expiresInSeconds,
        signableHeaders: new Set(['content-type']),
    }));
    const signPart = options.presignPart ?? ((client, command, expiresInSeconds) => (0, s3_request_presigner_1.getSignedUrl)(client, command, {
        expiresIn: expiresInSeconds,
        // The declared part hash is the one value worth binding into the
        // signature: it is an x-amz- header, so SigV4 covers it and storage
        // rejects bytes that do not hash to it. Part SIZE cannot be reliably
        // signed, so `listMultipartParts` settles it before anything is
        // committed instead of trusting the presigned PUT.
        signableHeaders: new Set(['x-amz-checksum-sha256']),
    }));
    const isNotFound = (error) => {
        if (typeof error !== 'object' || error === null)
            return false;
        const candidate = error;
        const names = [candidate.name, candidate.Code, candidate.code].map(String);
        return candidate.$metadata?.httpStatusCode === 404 ||
            names.some((name) => ['NoSuchKey', 'NoSuchVersion', 'NotFound'].includes(name));
    };
    const verifyPinnedVersion = async (input, requiredVersionId) => {
        let head;
        try {
            head = await options.client.send(new client_s3_1.HeadObjectCommand({
                Bucket: options.bucket,
                Key: input.objectKey,
                ...(requiredVersionId ? { VersionId: requiredVersionId } : {}),
                ChecksumMode: 'ENABLED',
            }));
        }
        catch (error) {
            if (isNotFound(error))
                throw new storage_facade_1.ArtifactStorageError('OBJECT_NOT_FOUND');
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
        const metadata = head.Metadata;
        if (metadata?.artifactid !== input.artifactId) {
            throw new storage_facade_1.ArtifactStorageError('ARTIFACT_METADATA_MISMATCH');
        }
        if (metadata?.tenantid !== input.tenantId) {
            throw new storage_facade_1.ArtifactStorageError('TENANT_METADATA_MISMATCH');
        }
        const versionId = head.VersionId;
        if (!versionId || versionId === 'null' || (requiredVersionId && versionId !== requiredVersionId)) {
            throw new storage_facade_1.ArtifactStorageError('OBJECT_VERSION_REQUIRED');
        }
        if (head.ContentLength !== undefined && head.ContentLength !== input.expectedSizeBytes) {
            throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
        }
        const stream = await openPinnedRead({ objectKey: input.objectKey, versionId });
        const hash = (0, node_crypto_1.createHash)('sha256');
        let sizeBytes = 0;
        try {
            for await (const chunk of stream) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                sizeBytes += bytes.byteLength;
                if (sizeBytes > input.expectedSizeBytes)
                    throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
                hash.update(bytes);
            }
        }
        catch (error) {
            if (error instanceof storage_facade_1.ArtifactStorageError)
                throw error;
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
        if (sizeBytes !== input.expectedSizeBytes)
            throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
        const sha256 = hash.digest('hex');
        if (sha256.toLowerCase() !== input.expectedSha256.toLowerCase()) {
            throw new storage_facade_1.ArtifactStorageError('CHECKSUM_MISMATCH');
        }
        return { objectKey: input.objectKey, versionId, sizeBytes, sha256 };
    };
    const MAX_SERVER_OBJECT_BYTES = 16 * 1024 * 1024;
    const readServerObjectBytes = async (objectKey) => {
        let output;
        try {
            output = await options.client.send(new client_s3_1.GetObjectCommand({
                Bucket: options.bucket,
                Key: objectKey,
            }));
        }
        catch (error) {
            if (isNotFound(error))
                throw new storage_facade_1.ArtifactStorageError('OBJECT_NOT_FOUND');
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
        const body = output.Body;
        if (!body || typeof body[Symbol.asyncIterator] !== 'function') {
            throw new storage_facade_1.ArtifactStorageError('INVALID_OBJECT_BODY');
        }
        const chunks = [];
        let total = 0;
        try {
            for await (const chunk of body) {
                const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
                total += bytes.byteLength;
                if (total > MAX_SERVER_OBJECT_BYTES)
                    throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
                chunks.push(bytes);
            }
        }
        catch (error) {
            if (error instanceof storage_facade_1.ArtifactStorageError)
                throw error;
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
        return Buffer.concat(chunks, total);
    };
    const putServerObject = async (input) => {
        if (!options.bucket
            || !input.objectKey
            || typeof input.tenantId !== 'string'
            || input.tenantId.length < 1
            || !Buffer.isBuffer(input.body)
            || input.body.byteLength < 1) {
            throw new storage_facade_1.ArtifactStorageError('INVALID_OBJECT_BODY');
        }
        let versionId;
        try {
            const uploaded = await options.client.send(new client_s3_1.PutObjectCommand({
                Bucket: options.bucket,
                Key: input.objectKey,
                Body: input.body,
                ContentLength: input.body.byteLength,
                ContentType: input.contentType,
                ...(input.metadata ? { Metadata: { ...input.metadata } } : {}),
            }));
            versionId = uploaded.VersionId;
        }
        catch {
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
        if (!versionId || versionId === 'null') {
            // The sealed carrier must be an immutable generation; an unversioned
            // write cannot be pinned, so remove it rather than leave an addressable
            // object the row never commits.
            try {
                await options.client.send(new client_s3_1.DeleteObjectCommand({
                    Bucket: options.bucket,
                    Key: input.objectKey,
                }));
            }
            catch {
                // Best-effort: the row stays STAGING and the sweeper owns leftovers.
            }
            throw new storage_facade_1.ArtifactStorageError('OBJECT_VERSION_REQUIRED');
        }
        return { versionId };
    };
    const openPinnedRead = async (version) => {
        if (!version.versionId || version.versionId === 'null') {
            throw new storage_facade_1.ArtifactStorageError('OBJECT_VERSION_REQUIRED');
        }
        let result;
        try {
            result = await options.client.send(new client_s3_1.GetObjectCommand({
                Bucket: options.bucket,
                Key: version.objectKey,
                VersionId: version.versionId,
            }));
        }
        catch (error) {
            if (isNotFound(error))
                throw new storage_facade_1.ArtifactStorageError('OBJECT_NOT_FOUND');
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
        const body = result.Body;
        let source;
        if (body instanceof node_stream_1.Readable) {
            source = body;
        }
        else if (body && typeof body === 'object' && Symbol.asyncIterator in body) {
            source = node_stream_1.Readable.from(body);
        }
        else {
            throw new storage_facade_1.ArtifactStorageError('INVALID_OBJECT_BODY');
        }
        const safeStream = new node_stream_1.PassThrough();
        source.on('error', () => safeStream.destroy(new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE')));
        safeStream.on('close', () => {
            if (!source.destroyed)
                source.destroy();
        });
        source.pipe(safeStream);
        return safeStream;
    };
    const uploadMultipart = async (input) => {
        const partSizeBytes = input.partSizeBytes ?? exports.DEFAULT_S3_MULTIPART_PART_BYTES;
        const expectedSha256 = typeof input.expectedSha256 === 'string'
            ? input.expectedSha256.toLowerCase()
            : '';
        const partCount = Math.ceil(input.expectedSizeBytes / partSizeBytes);
        if (!options.bucket ||
            !input.artifactId ||
            !input.tenantId ||
            !input.objectKey ||
            !input.contentType ||
            !input.taskId ||
            !Number.isSafeInteger(input.leaseEpoch) ||
            input.leaseEpoch < 0 ||
            !Number.isSafeInteger(input.expectedSizeBytes) ||
            input.expectedSizeBytes <= exports.MIN_S3_MULTIPART_PART_BYTES ||
            input.expectedSizeBytes > exports.MAX_S3_MULTIPART_OBJECT_BYTES ||
            typeof input.expectedSha256 !== 'string' ||
            !/^[a-f0-9]{64}$/i.test(input.expectedSha256) ||
            !Number.isSafeInteger(partSizeBytes) ||
            partSizeBytes < exports.MIN_S3_MULTIPART_PART_BYTES ||
            partCount > exports.MAX_S3_MULTIPART_PARTS ||
            !input.source ||
            typeof input.assertLease !== 'function' ||
            typeof input.onCheckpoint !== 'function' ||
            (input.expectedPartSha256 !== undefined &&
                (!Array.isArray(input.expectedPartSha256) ||
                    input.expectedPartSha256.length !== partCount ||
                    input.expectedPartSha256.some((hash) => typeof hash !== 'string' || !/^[a-f0-9]{64}$/i.test(hash))))) {
            throw new S3MultipartUploadError('INVALID_MULTIPART_INPUT');
        }
        let checkpoint;
        if (input.checkpoint) {
            if (typeof input.checkpoint !== 'object' ||
                !Array.isArray(input.checkpoint.parts) ||
                typeof input.checkpoint.expectedSha256 !== 'string') {
                throw new S3MultipartUploadError('INVALID_MULTIPART_INPUT');
            }
            checkpoint = { ...input.checkpoint, parts: input.checkpoint.parts.map((part) => ({ ...part })) };
        }
        if (checkpoint) {
            const checkpointIdentityMatches = checkpoint.version === 1 &&
                checkpoint.artifactId === input.artifactId &&
                checkpoint.tenantId === input.tenantId &&
                checkpoint.objectKey === input.objectKey &&
                checkpoint.taskId === input.taskId &&
                Number.isSafeInteger(checkpoint.leaseEpoch) &&
                checkpoint.leaseEpoch >= 0 &&
                checkpoint.expectedSizeBytes === input.expectedSizeBytes &&
                checkpoint.expectedSha256.toLowerCase() === expectedSha256 &&
                checkpoint.partSizeBytes === partSizeBytes &&
                typeof checkpoint.uploadId === 'string' &&
                checkpoint.uploadId.length > 0 &&
                checkpoint.parts.every((part, index) => part.partNumber === index + 1 &&
                    typeof part.etag === 'string' &&
                    part.etag.length > 0 &&
                    Number.isSafeInteger(part.sizeBytes) &&
                    part.sizeBytes === Math.min(partSizeBytes, input.expectedSizeBytes - index * partSizeBytes) &&
                    /^[a-f0-9]{64}$/i.test(part.sha256)) &&
                checkpoint.parts.length <= partCount;
            if (!checkpointIdentityMatches) {
                throw new S3MultipartUploadError('INVALID_MULTIPART_INPUT');
            }
            if (checkpoint.leaseEpoch !== input.leaseEpoch) {
                try {
                    await options.client.send(new client_s3_1.AbortMultipartUploadCommand({
                        Bucket: options.bucket,
                        Key: input.objectKey,
                        UploadId: checkpoint.uploadId,
                    }));
                }
                catch {
                    // Best-effort cleanup; the lease failure remains the public result.
                }
                throw new S3MultipartUploadError('MULTIPART_LEASE_LOST', checkpoint);
            }
        }
        let completed = false;
        let committedVersionId;
        const abortActiveUpload = async () => {
            if (!checkpoint || completed)
                return;
            try {
                await options.client.send(new client_s3_1.AbortMultipartUploadCommand({
                    Bucket: options.bucket,
                    Key: input.objectKey,
                    UploadId: checkpoint.uploadId,
                }));
            }
            catch {
                // Cleanup failure must not expose provider details or replace the cause.
            }
        };
        const deleteUnpublishedVersion = async () => {
            if (!committedVersionId)
                return;
            try {
                await options.client.send(new client_s3_1.DeleteObjectCommand({
                    Bucket: options.bucket,
                    Key: input.objectKey,
                    VersionId: committedVersionId,
                }));
            }
            catch {
                // The artifact remains STAGING; preserve the safe failure result.
            }
        };
        const persistCheckpoint = async () => {
            if (!checkpoint)
                return;
            try {
                await input.onCheckpoint(checkpoint);
            }
            catch {
                throw new S3MultipartUploadError('MULTIPART_CHECKPOINT_UNAVAILABLE', checkpoint);
            }
        };
        const assertCurrentLease = async () => {
            try {
                await input.assertLease({ taskId: input.taskId, leaseEpoch: input.leaseEpoch });
            }
            catch {
                throw new S3MultipartUploadError('MULTIPART_LEASE_LOST', checkpoint);
            }
        };
        const assertNotCancelled = () => {
            if (input.signal?.aborted) {
                throw new S3MultipartUploadError('MULTIPART_CANCELLED', checkpoint);
            }
        };
        const destroyOnCancel = () => {
            if (!input.source.destroyed)
                input.source.destroy(new Error('multipart upload cancelled'));
        };
        input.signal?.addEventListener('abort', destroyOnCancel, { once: true });
        try {
            assertNotCancelled();
            await assertCurrentLease();
            if (!checkpoint) {
                let uploadId;
                try {
                    const created = await options.client.send(new client_s3_1.CreateMultipartUploadCommand({
                        Bucket: options.bucket,
                        Key: input.objectKey,
                        ContentType: input.contentType,
                        Metadata: { artifactid: input.artifactId, tenantid: input.tenantId },
                    }));
                    uploadId = created.UploadId;
                }
                catch {
                    throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
                }
                if (!uploadId)
                    throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
                checkpoint = {
                    version: 1,
                    artifactId: input.artifactId,
                    tenantId: input.tenantId,
                    objectKey: input.objectKey,
                    taskId: input.taskId,
                    leaseEpoch: input.leaseEpoch,
                    uploadId,
                    partSizeBytes,
                    expectedSizeBytes: input.expectedSizeBytes,
                    expectedSha256,
                    parts: [],
                };
                await persistCheckpoint();
            }
            const wholeHash = (0, node_crypto_1.createHash)('sha256');
            const partBuffer = Buffer.allocUnsafe(partSizeBytes);
            let bufferedBytes = 0;
            let totalBytes = 0;
            let nextPartNumber = 1;
            const uploadPart = async (partBytes) => {
                assertNotCancelled();
                const partNumber = nextPartNumber++;
                const partSha256 = (0, node_crypto_1.createHash)('sha256').update(partBytes).digest('hex');
                const expectedPartSha256 = input.expectedPartSha256?.[partNumber - 1];
                if (expectedPartSha256 && partSha256 !== expectedPartSha256.toLowerCase()) {
                    throw new S3MultipartUploadError('MULTIPART_CHECKSUM_MISMATCH', checkpoint);
                }
                const alreadyUploaded = checkpoint.parts[partNumber - 1];
                if (alreadyUploaded) {
                    if (alreadyUploaded.sizeBytes !== partBytes.byteLength || alreadyUploaded.sha256 !== partSha256) {
                        throw new S3MultipartUploadError('MULTIPART_CHECKSUM_MISMATCH', checkpoint);
                    }
                    return;
                }
                await assertCurrentLease();
                let etag;
                try {
                    const output = await options.client.send(new client_s3_1.UploadPartCommand({
                        Bucket: options.bucket,
                        Key: input.objectKey,
                        UploadId: checkpoint.uploadId,
                        PartNumber: partNumber,
                        Body: partBytes,
                        ContentLength: partBytes.byteLength,
                        ChecksumSHA256: Buffer.from(partSha256, 'hex').toString('base64'),
                    }));
                    etag = output.ETag;
                }
                catch {
                    throw new S3MultipartUploadError('MULTIPART_UPLOAD_INTERRUPTED', checkpoint);
                }
                if (!etag)
                    throw new S3MultipartUploadError('MULTIPART_UPLOAD_INTERRUPTED', checkpoint);
                await assertCurrentLease();
                checkpoint = {
                    ...checkpoint,
                    parts: [...checkpoint.parts, {
                            partNumber,
                            etag,
                            sizeBytes: partBytes.byteLength,
                            sha256: partSha256,
                        }],
                };
                await persistCheckpoint();
            };
            for await (const rawChunk of input.source) {
                assertNotCancelled();
                const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
                if (chunk.byteLength > MAX_MULTIPART_SOURCE_CHUNK_BYTES) {
                    throw new S3MultipartUploadError('INVALID_MULTIPART_INPUT', checkpoint);
                }
                totalBytes += chunk.byteLength;
                if (totalBytes > input.expectedSizeBytes) {
                    throw new S3MultipartUploadError('MULTIPART_SIZE_MISMATCH', checkpoint);
                }
                wholeHash.update(chunk);
                let offset = 0;
                while (offset < chunk.byteLength) {
                    const copied = Math.min(partSizeBytes - bufferedBytes, chunk.byteLength - offset);
                    chunk.copy(partBuffer, bufferedBytes, offset, offset + copied);
                    bufferedBytes += copied;
                    offset += copied;
                    if (bufferedBytes === partSizeBytes) {
                        await uploadPart(partBuffer.subarray(0, bufferedBytes));
                        bufferedBytes = 0;
                    }
                }
            }
            if (bufferedBytes > 0)
                await uploadPart(partBuffer.subarray(0, bufferedBytes));
            if (totalBytes !== input.expectedSizeBytes) {
                throw new S3MultipartUploadError('MULTIPART_SIZE_MISMATCH', checkpoint);
            }
            if (checkpoint.parts.length !== partCount || wholeHash.digest('hex') !== expectedSha256) {
                throw new S3MultipartUploadError('MULTIPART_CHECKSUM_MISMATCH', checkpoint);
            }
            assertNotCancelled();
            await assertCurrentLease();
            let versionId;
            try {
                const output = await options.client.send(new client_s3_1.CompleteMultipartUploadCommand({
                    Bucket: options.bucket,
                    Key: input.objectKey,
                    UploadId: checkpoint.uploadId,
                    MultipartUpload: {
                        Parts: checkpoint.parts.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
                    },
                }));
                completed = true;
                versionId = output.VersionId;
            }
            catch {
                throw new S3MultipartUploadError('MULTIPART_UPLOAD_INTERRUPTED', checkpoint);
            }
            if (!versionId || versionId === 'null') {
                throw new storage_facade_1.ArtifactStorageError('OBJECT_VERSION_REQUIRED');
            }
            committedVersionId = versionId;
            assertNotCancelled();
            await assertCurrentLease();
            let head;
            try {
                head = await options.client.send(new client_s3_1.HeadObjectCommand({
                    Bucket: options.bucket,
                    Key: input.objectKey,
                    VersionId: versionId,
                    ChecksumMode: 'ENABLED',
                }));
            }
            catch {
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            }
            if (head.VersionId !== versionId || head.Metadata?.artifactid !== input.artifactId) {
                throw new storage_facade_1.ArtifactStorageError('ARTIFACT_METADATA_MISMATCH');
            }
            if (head.Metadata?.tenantid !== input.tenantId) {
                throw new storage_facade_1.ArtifactStorageError('TENANT_METADATA_MISMATCH');
            }
            if (head.ContentLength !== undefined && head.ContentLength !== input.expectedSizeBytes) {
                throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
            }
            const storedStream = await openPinnedRead({ objectKey: input.objectKey, versionId });
            const storedHash = (0, node_crypto_1.createHash)('sha256');
            let storedBytes = 0;
            try {
                for await (const rawChunk of storedStream) {
                    assertNotCancelled();
                    const chunk = Buffer.isBuffer(rawChunk) ? rawChunk : Buffer.from(rawChunk);
                    storedBytes += chunk.byteLength;
                    if (storedBytes > input.expectedSizeBytes) {
                        throw new S3MultipartUploadError('MULTIPART_SIZE_MISMATCH');
                    }
                    storedHash.update(chunk);
                }
            }
            catch (error) {
                if (error instanceof S3MultipartUploadError)
                    throw error;
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            }
            const storedSha256 = storedHash.digest('hex');
            if (storedBytes !== input.expectedSizeBytes) {
                throw new S3MultipartUploadError('MULTIPART_SIZE_MISMATCH');
            }
            if (storedSha256 !== expectedSha256) {
                throw new S3MultipartUploadError('MULTIPART_CHECKSUM_MISMATCH');
            }
            return { objectKey: input.objectKey, versionId, sizeBytes: storedBytes, sha256: storedSha256 };
        }
        catch (error) {
            if (committedVersionId)
                await deleteUnpublishedVersion();
            const multipartError = error instanceof S3MultipartUploadError ? error : undefined;
            if (input.signal?.aborted) {
                await abortActiveUpload();
                throw new S3MultipartUploadError('MULTIPART_CANCELLED', checkpoint);
            }
            const abortRequired = multipartError && [
                'INVALID_MULTIPART_INPUT',
                'MULTIPART_LEASE_LOST',
                'MULTIPART_CANCELLED',
                'MULTIPART_CHECKSUM_MISMATCH',
                'MULTIPART_SIZE_MISMATCH',
                'MULTIPART_CHECKPOINT_UNAVAILABLE',
            ].includes(multipartError.code);
            if (abortRequired) {
                await abortActiveUpload();
                throw new S3MultipartUploadError(multipartError.code, checkpoint);
            }
            if (error instanceof storage_facade_1.ArtifactStorageError)
                throw error;
            if (multipartError?.code === 'MULTIPART_UPLOAD_INTERRUPTED') {
                throw new S3MultipartUploadError('MULTIPART_UPLOAD_INTERRUPTED', checkpoint);
            }
            if (checkpoint && !completed) {
                throw new S3MultipartUploadError('MULTIPART_UPLOAD_INTERRUPTED', checkpoint);
            }
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
        finally {
            input.signal?.removeEventListener('abort', destroyOnCancel);
        }
    };
    /* ------------------------------------------------------------ */
    /* DATA-02 client-driven multipart lifecycle (per-part grants)   */
    /* ------------------------------------------------------------ */
    const requireBucket = () => {
        if (!options.bucket)
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        return options.bucket;
    };
    const createMultipartUpload = async (input) => {
        const Bucket = requireBucket();
        if (!input.artifactId || !input.tenantId || !input.objectKey || !input.contentType) {
            throw new storage_facade_1.ArtifactStorageError('INVALID_UPLOAD_GRANT');
        }
        try {
            const created = await options.client.send(new client_s3_1.CreateMultipartUploadCommand({
                Bucket,
                Key: input.objectKey,
                ContentType: input.contentType,
                Metadata: { artifactid: input.artifactId, tenantid: input.tenantId },
            }));
            if (!created.UploadId)
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            return { uploadId: created.UploadId };
        }
        catch (error) {
            if (error instanceof storage_facade_1.ArtifactStorageError)
                throw error;
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
    };
    const presignUploadPart = async (input) => {
        const Bucket = requireBucket();
        const expiresAtMs = Date.parse(input.expiresAt);
        const expiresInSeconds = Math.floor((expiresAtMs - now()) / 1000);
        if (!input.artifactId ||
            !input.tenantId ||
            !input.objectKey ||
            !input.uploadId ||
            !Number.isSafeInteger(input.partNumber) ||
            input.partNumber < 1 ||
            !Number.isSafeInteger(input.sizeBytes) ||
            input.sizeBytes < 1 ||
            !/^[a-f0-9]{64}$/.test(input.partSha256) ||
            !Number.isFinite(expiresAtMs) ||
            expiresInSeconds < 1 ||
            expiresInSeconds > MAX_PRESIGNED_URL_SECONDS) {
            throw new storage_facade_1.ArtifactStorageError('INVALID_UPLOAD_GRANT');
        }
        const checksumSha256 = Buffer.from(input.partSha256, 'hex').toString('base64');
        try {
            const url = await signPart(options.client, new client_s3_1.UploadPartCommand({
                Bucket,
                Key: input.objectKey,
                UploadId: input.uploadId,
                PartNumber: input.partNumber,
                ContentLength: input.sizeBytes,
                ChecksumSHA256: checksumSha256,
            }), expiresInSeconds);
            return {
                url,
                expiresAt: input.expiresAt,
                headers: {
                    'content-length': String(input.sizeBytes),
                    'x-amz-checksum-sha256': checksumSha256,
                },
            };
        }
        catch (error) {
            if (error instanceof storage_facade_1.ArtifactStorageError)
                throw error;
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
    };
    const listMultipartParts = async (input) => {
        const Bucket = requireBucket();
        if (!input.objectKey || !input.uploadId)
            throw new storage_facade_1.ArtifactStorageError('INVALID_UPLOAD_GRANT');
        const parts = [];
        let marker;
        for (let page = 0;; page += 1) {
            if (page >= MAX_LIST_PARTS_PAGES)
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            let output;
            try {
                output = await options.client.send(new client_s3_1.ListPartsCommand({
                    Bucket,
                    Key: input.objectKey,
                    UploadId: input.uploadId,
                    PartNumberMarker: marker,
                    MaxParts: LIST_PARTS_PAGE_SIZE,
                }));
            }
            catch (error) {
                if (isNotFound(error))
                    throw new storage_facade_1.ArtifactStorageError('OBJECT_NOT_FOUND');
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            }
            for (const part of output.Parts ?? []) {
                if (!part.PartNumber || !part.ETag || part.Size === undefined || !part.ChecksumSHA256) {
                    // A part storage cannot account for its checksum is not verifiable
                    // bytes; the lifecycle refuses to publish it.
                    throw new storage_facade_1.ArtifactStorageError('CHECKSUM_MISMATCH');
                }
                parts.push({
                    partNumber: part.PartNumber,
                    etag: part.ETag,
                    sizeBytes: part.Size,
                    sha256: Buffer.from(part.ChecksumSHA256, 'base64').toString('hex').toLowerCase(),
                });
            }
            if (!output.IsTruncated)
                return parts;
            const next = output.NextPartNumberMarker;
            if (!next)
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            marker = next;
        }
    };
    const completeMultipartUpload = async (input) => {
        const Bucket = requireBucket();
        if (!input.artifactId ||
            !input.tenantId ||
            !input.objectKey ||
            !input.uploadId ||
            input.parts.length === 0) {
            throw new storage_facade_1.ArtifactStorageError('INVALID_UPLOAD_GRANT');
        }
        const ordered = [...input.parts].sort((a, b) => a.partNumber - b.partNumber);
        let versionId;
        try {
            const output = await options.client.send(new client_s3_1.CompleteMultipartUploadCommand({
                Bucket,
                Key: input.objectKey,
                UploadId: input.uploadId,
                MultipartUpload: {
                    Parts: ordered.map((part) => ({ PartNumber: part.partNumber, ETag: part.etag })),
                },
            }));
            versionId = output.VersionId;
        }
        catch (error) {
            if (isNotFound(error))
                throw new storage_facade_1.ArtifactStorageError('OBJECT_NOT_FOUND');
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
        if (!versionId || versionId === 'null')
            throw new storage_facade_1.ArtifactStorageError('OBJECT_VERSION_REQUIRED');
        return { versionId };
    };
    const abortMultipartUpload = async (input) => {
        const Bucket = requireBucket();
        if (!input.objectKey || !input.uploadId)
            throw new storage_facade_1.ArtifactStorageError('INVALID_UPLOAD_GRANT');
        try {
            await options.client.send(new client_s3_1.AbortMultipartUploadCommand({
                Bucket,
                Key: input.objectKey,
                UploadId: input.uploadId,
            }));
        }
        catch (error) {
            if (isNotFound(error))
                return; // storage already discarded it: idempotent
            throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
        }
    };
    return {
        uploadMultipart,
        createMultipartUpload,
        presignUploadPart,
        listMultipartParts,
        completeMultipartUpload,
        abortMultipartUpload,
        async createUploadGrant(input) {
            const expiresAtMs = Date.parse(input.expiresAt);
            const expiresInSeconds = Math.floor((expiresAtMs - now()) / 1000);
            if (!options.bucket ||
                !input.artifactId ||
                !input.tenantId ||
                !input.objectKey ||
                !input.contentType ||
                !Number.isSafeInteger(input.maxBytes) ||
                input.maxBytes < 0 ||
                input.maxBytes > MAX_SINGLE_PUT_BYTES ||
                !Number.isFinite(expiresAtMs) ||
                expiresInSeconds < 1 ||
                expiresInSeconds > MAX_PRESIGNED_URL_SECONDS) {
                throw new storage_facade_1.ArtifactStorageError('INVALID_UPLOAD_GRANT');
            }
            const command = new client_s3_1.PutObjectCommand({
                Bucket: options.bucket,
                Key: input.objectKey,
                ContentType: input.contentType,
                // The current upload protocol declares the exact expected byte count
                // when issuing a grant, so signing ContentLength binds the PUT size.
                ContentLength: input.maxBytes,
                Metadata: {
                    artifactid: input.artifactId,
                    tenantid: input.tenantId,
                },
            });
            try {
                const url = await signPut(options.client, command, expiresInSeconds);
                return {
                    url,
                    expiresAt: input.expiresAt,
                    headers: {
                        'content-type': input.contentType,
                        'x-amz-meta-artifactid': input.artifactId,
                        'x-amz-meta-tenantid': input.tenantId,
                    },
                };
            }
            catch {
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            }
        },
        async verifyAndPin(input) {
            return verifyPinnedVersion(input);
        },
        async importLegacyBlob(input) {
            if (!options.bucket ||
                !input.artifactId ||
                !input.tenantId ||
                !input.objectKey ||
                !input.contentType ||
                !Buffer.isBuffer(input.bytes) ||
                !Number.isSafeInteger(input.expectedSizeBytes) ||
                input.expectedSizeBytes < 0 ||
                input.expectedSizeBytes > MAX_SINGLE_PUT_BYTES ||
                !/^[a-f0-9]{64}$/i.test(input.expectedSha256)) {
                throw new storage_facade_1.ArtifactStorageError('INVALID_OBJECT_BODY');
            }
            if (input.bytes.byteLength !== input.expectedSizeBytes) {
                throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
            }
            const localHash = (0, node_crypto_1.createHash)('sha256').update(input.bytes).digest('hex');
            if (localHash !== input.expectedSha256.toLowerCase()) {
                throw new storage_facade_1.ArtifactStorageError('CHECKSUM_MISMATCH');
            }
            // Reuse an already imported exact-content version so retries do not
            // create another S3 generation after a lost DB commit/response.
            try {
                return await verifyPinnedVersion(input);
            }
            catch (error) {
                if (!(error instanceof storage_facade_1.ArtifactStorageError) || ![
                    'OBJECT_NOT_FOUND', 'SIZE_MISMATCH', 'CHECKSUM_MISMATCH',
                ].includes(error.code))
                    throw error;
            }
            let versionId;
            try {
                const uploaded = await options.client.send(new client_s3_1.PutObjectCommand({
                    Bucket: options.bucket,
                    Key: input.objectKey,
                    Body: input.bytes,
                    ContentLength: input.expectedSizeBytes,
                    ContentType: input.contentType,
                    Metadata: {
                        artifactid: input.artifactId,
                        tenantid: input.tenantId,
                        sha256: localHash,
                    },
                }));
                versionId = uploaded.VersionId;
            }
            catch {
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            }
            if (!versionId || versionId === 'null')
                throw new storage_facade_1.ArtifactStorageError('OBJECT_VERSION_REQUIRED');
            try {
                return await verifyPinnedVersion(input, versionId);
            }
            catch (error) {
                try {
                    await options.client.send(new client_s3_1.DeleteObjectCommand({
                        Bucket: options.bucket,
                        Key: input.objectKey,
                        VersionId: versionId,
                    }));
                }
                catch {
                    // Best-effort removal; the PostgreSQL source remains authoritative.
                }
                if (error instanceof storage_facade_1.ArtifactStorageError)
                    throw error;
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            }
        },
        openRead: openPinnedRead,
        putServerObject,
        readServerObject: readServerObjectBytes,
        async delete(version) {
            if (!version.versionId || version.versionId === 'null') {
                throw new storage_facade_1.ArtifactStorageError('OBJECT_VERSION_REQUIRED');
            }
            try {
                await options.client.send(new client_s3_1.DeleteObjectCommand({
                    Bucket: options.bucket,
                    Key: version.objectKey,
                    VersionId: version.versionId,
                }));
            }
            catch {
                throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
            }
        },
    };
}
