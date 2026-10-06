"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.PublicArtifactTooLargeError = void 0;
exports.writePublicArtifact = writePublicArtifact;
const node_crypto_1 = require("node:crypto");
class PublicArtifactTooLargeError extends Error {
    sizeBytes;
    limit;
    constructor(sizeBytes, limit) {
        super('public artifact exceeds the configured size limit');
        this.sizeBytes = sizeBytes;
        this.limit = limit;
        this.name = 'PublicArtifactTooLargeError';
    }
}
exports.PublicArtifactTooLargeError = PublicArtifactTooLargeError;
const INSERT_ARTIFACT = 
// Template literal so the embedded single quotes need no escaping; the SQL has
// no backticks, so this stays readable as one line.
`INSERT INTO artifacts (id, tenant_id, purpose, file_name, mime_type, size_bytes, sha256, state, token, storage_key, storage_backend, storage_version, upload_token)
   VALUES ($1,$2,'input',$3,$4,$5,$6,'READY',$7,$8,$9,$10,$11)`;
/**
 * Store one legacy upload and return its artifact id.
 *
 * The cap is checked BEFORE any row is written, so an oversize upload leaves
 * no STAGING row to sweep and cannot be mistaken for a partial success.
 */
async function writePublicArtifact(deps, input) {
    const sizeBytes = input.bytes.length;
    if (sizeBytes > deps.maxArtifactBytes) {
        throw new PublicArtifactTooLargeError(sizeBytes, deps.maxArtifactBytes);
    }
    const artifactId = (0, node_crypto_1.randomUUID)();
    const storageKey = `art-${artifactId}`;
    const sha256 = (0, node_crypto_1.createHash)('sha256').update(input.bytes).digest('hex');
    await deps.putBlob(storageKey, input.tenantId, input.bytes);
    const version = await deps.verifyAndPin({
        artifactId,
        tenantId: input.tenantId,
        objectKey: storageKey,
        expectedSizeBytes: sizeBytes,
        expectedSha256: sha256,
    });
    await deps.query(INSERT_ARTIFACT, [
        artifactId,
        input.tenantId,
        input.fileName,
        input.mimeType,
        sizeBytes,
        sha256,
        (0, node_crypto_1.randomUUID)(),
        version.objectKey,
        deps.storageBackend,
        version.versionId,
        (0, node_crypto_1.randomUUID)(),
    ]);
    return { artifactId, state: 'READY' };
}
