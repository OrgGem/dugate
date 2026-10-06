"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.manifestKeyFor = exports.ARTIFACT_SIDECAR_CONTENT_TYPE = exports.ARTIFACT_CIPHERTEXT_CONTENT_TYPE = exports.ARTIFACT_MANIFEST_MARKER_VALUE = exports.WORKER_ARTIFACT_PURPOSE = void 0;
exports.artifactEncryptionContext = artifactEncryptionContext;
exports.sealWorkerArtifact = sealWorkerArtifact;
exports.parseWorkerArtifactSidecar = parseWorkerArtifactSidecar;
exports.openWorkerArtifact = openWorkerArtifact;
exports.verifyWorkerArtifact = verifyWorkerArtifact;
exports.sealedObjectMetadata = sealedObjectMetadata;
exports.manifestObjectMetadata = manifestObjectMetadata;
const node_crypto_1 = require("node:crypto");
const node_stream_1 = require("node:stream");
const crypto_storage_facade_1 = require("../encryption/crypto-storage-facade");
const artifact_read_decrypt_1 = require("../encryption/artifact-read-decrypt");
Object.defineProperty(exports, "manifestKeyFor", { enumerable: true, get: function () { return artifact_read_decrypt_1.manifestKeyFor; } });
const storage_facade_1 = require("./storage-facade");
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
exports.WORKER_ARTIFACT_PURPOSE = artifact_read_decrypt_1.PUBLIC_UPLOAD_PURPOSE;
exports.ARTIFACT_MANIFEST_MARKER_VALUE = 'manifest-v1';
exports.ARTIFACT_CIPHERTEXT_CONTENT_TYPE = 'application/octet-stream';
exports.ARTIFACT_SIDECAR_CONTENT_TYPE = 'application/json';
const SHA256_RE = /^[a-f0-9]{64}$/;
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function sha256Hex(bytes) {
    return (0, node_crypto_1.createHash)('sha256').update(bytes).digest('hex');
}
/** The AAD context this identity must rebuild; callers derive it from the row. */
function artifactEncryptionContext(identity) {
    return {
        tenantId: identity.tenantId,
        artifactId: identity.artifactId,
        objectVersion: identity.objectVersion,
        purpose: exports.WORKER_ARTIFACT_PURPOSE,
    };
}
function encryptionContext(identity, seam) {
    return {
        ...artifactEncryptionContext(identity),
        keyRef: seam.keyRef,
        ...(seam.keyVersion === undefined ? {} : { keyVersion: seam.keyVersion }),
    };
}
function mapCryptoError(error) {
    if (error instanceof storage_facade_1.ArtifactStorageError)
        throw error;
    if (error instanceof crypto_storage_facade_1.CryptoStorageError) {
        if (error.code === 'KEY_PROVIDER_FAILED') {
            throw new storage_facade_1.ArtifactStorageError('ENCRYPTION_UNAVAILABLE');
        }
        if (error.code === 'SIZE_LIMIT') {
            throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
        }
        throw new storage_facade_1.ArtifactStorageError('ENVELOPE_INVALID');
    }
    throw new storage_facade_1.ArtifactStorageError('STORAGE_UNAVAILABLE');
}
async function collectStream(stream, expectedBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (!Number.isSafeInteger(total) || total > expectedBytes) {
            throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
        }
        chunks.push(bytes);
    }
    if (total !== expectedBytes)
        throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
    return Buffer.concat(chunks, total);
}
function toAsyncIterable(buffer) {
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
async function sealWorkerArtifact(input) {
    const { bytes, identity, seam } = input;
    if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1) {
        throw new storage_facade_1.ArtifactStorageError('INVALID_OBJECT_BODY');
    }
    try {
        let manifest;
        let ciphertext;
        if (bytes.byteLength <= crypto_storage_facade_1.CRYPTO_STORAGE_SINGLE_SHOT_LIMIT_BYTES) {
            const encrypted = await seam.facade.encrypt(bytes, encryptionContext(identity, seam));
            manifest = encrypted;
            ciphertext = encrypted.ciphertext;
        }
        else {
            const stream = seam.facade.encryptStream(node_stream_1.Readable.from([bytes]), encryptionContext(identity, seam));
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
            throw new storage_facade_1.ArtifactStorageError('ENVELOPE_INVALID');
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
    }
    catch (error) {
        return mapCryptoError(error);
    }
}
/**
 * Parse one raw envelope/manifest sidecar. Shape-only here; tenant/artifact/
 * version binding is enforced cryptographically by the AAD on open, and by the
 * storage metadata/row that supplied the context.
 */
function parseWorkerArtifactSidecar(raw) {
    if (!isRecord(raw))
        throw new storage_facade_1.ArtifactStorageError('ENVELOPE_INVALID');
    if ('chunks' in raw) {
        const manifest = raw;
        if (!Array.isArray(manifest.chunks)
            || manifest.chunks.length < 1
            || typeof manifest.manifestMac !== 'string'
            || manifest.manifestMac.length < 1) {
            throw new storage_facade_1.ArtifactStorageError('ENVELOPE_INVALID');
        }
        return { manifest };
    }
    const single = raw;
    for (const field of ['version', 'algorithm', 'nonce', 'tag', 'aad', 'dek']) {
        if (single[field] === undefined)
            throw new storage_facade_1.ArtifactStorageError('ENVELOPE_INVALID');
    }
    return { manifest: single };
}
/** Authenticated open under the caller-supplied (row-derived) context. */
async function openWorkerArtifact(input) {
    const { sidecar, ciphertext, context, seam } = input;
    try {
        if ('chunks' in sidecar.manifest) {
            return await collectStream(seam.facade.decryptStream(toAsyncIterable(ciphertext), sidecar.manifest, context), sidecar.manifest.totalSizeBytes);
        }
        return await seam.facade.decrypt({ ...sidecar.manifest, ciphertext }, context);
    }
    catch (error) {
        return mapCryptoError(error);
    }
}
/** Verify plaintext business metadata against the authenticated envelope. */
async function verifyWorkerArtifact(input) {
    const plaintext = await openWorkerArtifact(input);
    return {
        plaintextSha256: sha256Hex(plaintext),
        plaintextSizeBytes: plaintext.byteLength,
    };
}
/** Object metadata the canonical tenant-bound reader expects to find. */
function sealedObjectMetadata(input) {
    return {
        artifactid: input.artifactId,
        tenantid: input.tenantId,
        [artifact_read_decrypt_1.ENCRYPTED_OBJECT_MARKER]: artifact_read_decrypt_1.ENCRYPTED_OBJECT_MARKER_VALUE,
        [artifact_read_decrypt_1.MANIFEST_KEY_METADATA]: input.manifestKey,
    };
}
/** Object metadata for the sidecar manifest itself. */
function manifestObjectMetadata(input) {
    return {
        artifactid: input.artifactId,
        tenantid: input.tenantId,
        [artifact_read_decrypt_1.ENCRYPTED_OBJECT_MARKER]: exports.ARTIFACT_MANIFEST_MARKER_VALUE,
    };
}
