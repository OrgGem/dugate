"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.ARTIFACT_BLOB_MIGRATION_ROLLBACK_PLAN = void 0;
exports.createPostgresArtifactBlobMigrationStore = createPostgresArtifactBlobMigrationStore;
exports.migrateLegacyArtifactBlobs = migrateLegacyArtifactBlobs;
const node_crypto_1 = require("node:crypto");
const storage_facade_1 = require("./storage-facade");
/** Operator rollback guidance. The retained bytea rows are the rollback copy. */
exports.ARTIFACT_BLOB_MIGRATION_ROLLBACK_PLAN = [
    'Pause artifact submissions and switch the configured write backend to PostgreSQL only after backup verification and explicit rollback sign-off.',
    'Keep artifact_blobs intact. Restore a row to PostgreSQL only when its retained bytes match the artifact size and SHA-256 metadata.',
    'Keep S3 versions and PostgreSQL blobs until the migration owner confirms rollback or roll-forward completion.',
    'Never drop artifact_blobs before a verified backup and rollback sign-off.',
].join(' ');
function count(value) {
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed < 0)
        throw new Error('invalid artifact migration inventory');
    return parsed;
}
function mapInventory(row) {
    const legacyBlobRows = count(row.legacyBlobRows);
    const eligibleReadyArtifacts = count(row.eligibleReadyArtifacts);
    const legacyArtifactReferences = count(row.legacyArtifactReferences);
    const orphanBlobRows = count(row.orphanBlobRows);
    const readyS3ArtifactsWithoutVersion = count(row.readyS3ArtifactsWithoutVersion);
    return {
        legacyBlobRows,
        eligibleReadyArtifacts,
        legacyArtifactReferences,
        orphanBlobRows,
        readyS3ArtifactsWithoutVersion,
        unresolvedReferences: legacyArtifactReferences + orphanBlobRows + readyS3ArtifactsWithoutVersion,
    };
}
/** PostgreSQL repository. S3 I/O runs outside the transaction; pinning uses a short CAS update. */
function createPostgresArtifactBlobMigrationStore(db) {
    return {
        async inventory() {
            const result = await db.query(`SELECT
           (SELECT count(*) FROM artifact_blobs) AS "legacyBlobRows",
           (SELECT count(*) FROM artifacts a
             JOIN artifact_blobs b ON b.storage_key=a.storage_key AND b.tenant_id=a.tenant_id
             WHERE a.state='READY' AND a.storage_backend='postgres') AS "eligibleReadyArtifacts",
           (SELECT count(*) FROM artifacts a
             WHERE a.storage_backend='postgres' AND a.state <> 'DELETED') AS "legacyArtifactReferences",
           (SELECT count(*) FROM artifact_blobs b
             LEFT JOIN artifacts a ON a.storage_key=b.storage_key AND a.tenant_id=b.tenant_id
             WHERE a.id IS NULL) AS "orphanBlobRows",
           (SELECT count(*) FROM artifacts a
             WHERE a.storage_backend='s3' AND a.state='READY' AND a.storage_version_id IS NULL)
             AS "readyS3ArtifactsWithoutVersion"`);
            const row = result.rows[0];
            if (!row)
                throw new Error('artifact migration inventory unavailable');
            return mapInventory(row);
        },
        async listReadyLegacyArtifactIds() {
            const result = await db.query(`SELECT a.id AS "artifactId"
         FROM artifacts a
         JOIN artifact_blobs b ON b.storage_key=a.storage_key AND b.tenant_id=a.tenant_id
         WHERE a.state='READY' AND a.storage_backend='postgres'
         ORDER BY a.id`);
            return result.rows.map((row) => row.artifactId);
        },
        async withLegacyArtifactSnapshot(artifactId, action) {
            const result = await db.query(`SELECT a.id AS "artifactId", a.tenant_id AS "tenantId",
                a.storage_key AS "storageKey", a.mime_type AS "contentType",
                a.state, a.storage_backend AS "storageBackend",
                a.size_bytes AS "sizeBytes", a.sha256,
                b.bytes
         FROM artifacts a
         LEFT JOIN artifact_blobs b
           ON b.storage_key=a.storage_key AND b.tenant_id=a.tenant_id
         WHERE a.id=$1`, [artifactId]);
            const row = result.rows[0];
            const artifact = row ? {
                artifactId: row.artifactId,
                tenantId: row.tenantId,
                storageKey: row.storageKey,
                contentType: row.contentType,
                state: row.state,
                storageBackend: row.storageBackend,
                sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
                sha256: row.sha256,
                bytes: row.bytes === null ? null : Buffer.from(row.bytes),
            } : null;
            const commitS3Pin = async (version) => {
                if (!artifact?.bytes ||
                    version.objectKey !== artifact.storageKey ||
                    !version.versionId || version.versionId === 'null' ||
                    version.sizeBytes !== artifact.bytes.byteLength ||
                    !/^[a-f0-9]{64}$/i.test(version.sha256) ||
                    version.sha256.toLowerCase() !== (0, node_crypto_1.createHash)('sha256').update(artifact.bytes).digest('hex')) {
                    return false;
                }
                return db.tx(async (client) => {
                    const updated = await client.query(`UPDATE artifacts
             SET storage_backend='s3', storage_version_id=$2, size_bytes=$3, sha256=$4
             WHERE id=$1 AND state='READY' AND storage_backend='postgres'
               AND storage_version_id IS NULL AND tenant_id=$5 AND storage_key=$6
               AND size_bytes IS NOT DISTINCT FROM $7 AND sha256 IS NOT DISTINCT FROM $8
             RETURNING id`, [
                        artifact.artifactId,
                        version.versionId,
                        version.sizeBytes,
                        version.sha256,
                        artifact.tenantId,
                        artifact.storageKey,
                        artifact.sizeBytes,
                        artifact.sha256,
                    ]);
                    return Boolean(updated.rowCount);
                });
            };
            return action(artifact, commitS3Pin);
        },
    };
}
async function discardImportedVersion(storage, artifact, version) {
    if (version.objectKey !== artifact.storageKey || !version.versionId || version.versionId === 'null') {
        return false;
    }
    try {
        await storage.delete(version);
        return true;
    }
    catch {
        return false;
    }
}
/** Idempotently backfill verified PostgreSQL bytea blobs and retain every source row. */
async function migrateLegacyArtifactBlobs(store, storage) {
    const before = await store.inventory();
    const candidates = await store.listReadyLegacyArtifactIds();
    let migratedArtifacts = 0;
    let skippedArtifacts = 0;
    let failedArtifacts = 0;
    const issues = [];
    for (const artifactId of candidates) {
        let outcome;
        try {
            outcome = await store.withLegacyArtifactSnapshot(artifactId, async (artifact, commitS3Pin) => {
                if (!artifact || artifact.state !== 'READY' || artifact.storageBackend !== 'postgres')
                    return 'skipped';
                if (!artifact.bytes)
                    return { failed: 'SOURCE_NOT_FOUND' };
                const sizeBytes = artifact.bytes.byteLength;
                const sha256 = (0, node_crypto_1.createHash)('sha256').update(artifact.bytes).digest('hex');
                if ((artifact.sizeBytes !== null && artifact.sizeBytes !== sizeBytes) ||
                    (artifact.sha256 !== null && artifact.sha256.toLowerCase() !== sha256)) {
                    return { failed: 'SOURCE_INTEGRITY_MISMATCH' };
                }
                let version;
                try {
                    version = await storage.importLegacyBlob({
                        artifactId: artifact.artifactId,
                        tenantId: artifact.tenantId,
                        objectKey: artifact.storageKey,
                        contentType: artifact.contentType,
                        bytes: artifact.bytes,
                        expectedSizeBytes: sizeBytes,
                        expectedSha256: sha256,
                    });
                }
                catch (error) {
                    return { failed: error instanceof storage_facade_1.ArtifactStorageError ? error.code : 'STORAGE_UNAVAILABLE' };
                }
                if (version.objectKey !== artifact.storageKey ||
                    !version.versionId || version.versionId === 'null' ||
                    version.sizeBytes !== sizeBytes || version.sha256.toLowerCase() !== sha256) {
                    const discarded = await discardImportedVersion(storage, artifact, version);
                    if (!discarded)
                        return { failed: 'ORPHAN_VERSION_CLEANUP_FAILED' };
                    return { failed: 'STORAGE_INTEGRITY_MISMATCH' };
                }
                if (!await commitS3Pin(version)) {
                    const discarded = await discardImportedVersion(storage, artifact, version);
                    if (!discarded)
                        return { failed: 'ORPHAN_VERSION_CLEANUP_FAILED' };
                    return { failed: 'MIGRATION_COMMIT_CONFLICT' };
                }
                return 'migrated';
            });
        }
        catch {
            outcome = { failed: 'MIGRATION_STORE_UNAVAILABLE' };
        }
        if (outcome === 'migrated') {
            migratedArtifacts += 1;
        }
        else if (outcome === 'skipped') {
            skippedArtifacts += 1;
        }
        else {
            failedArtifacts += 1;
            issues.push({ artifactId, code: outcome.failed });
        }
    }
    const after = await store.inventory();
    return {
        state: after.unresolvedReferences === 0 && failedArtifacts === 0 ? 'complete' : 'incomplete',
        scannedArtifacts: candidates.length,
        migratedArtifacts,
        skippedArtifacts,
        failedArtifacts,
        unresolvedReferences: after.unresolvedReferences,
        before,
        after,
        issues,
        legacyBackupRetained: true,
        legacyTableDropAllowed: false,
    };
}
