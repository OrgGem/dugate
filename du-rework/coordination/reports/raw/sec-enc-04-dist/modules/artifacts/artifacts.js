"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.createArtifactService = createArtifactService;
const node_crypto_1 = require("node:crypto");
const node_stream_1 = require("node:stream");
const contracts_1 = require("@du/contracts");
const errors_1 = require("../../http/errors");
const storage_facade_1 = require("./storage-facade");
const postgres_storage_facade_1 = require("./postgres-storage-facade");
const artifact_encryption_1 = require("./artifact-encryption");
const legacy_public_artifact_1 = require("../../compat/legacy-public-artifact");
/**
 * Artifact lifecycle with either PostgreSQL fallback storage or an injected
 * storage facade. S3 upload grants go directly to the configured bucket;
 * verified object versions stay private in Orchestrator metadata. Reads use
 * the existing authorized proxy route and stream the exact pinned version.
 */
/**
 * RFX-15: the grant token rides the blob URL (`?grant=`), because the worker
 * SDK consumes grants as bare presigned-style URLs — `downloadArtifact` does a
 * plain `fetch(downloadUrl)` and `uploadArtifact` sends only content headers,
 * so an Authorization-header transport would require changing every client
 * outside this package. The token therefore lives where access logs can see
 * it: its lifetime is the only server-side bound. 2 minutes is enough for the
 * immediate use the grant flow performs (request grant -> PUT/GET at once)
 * while shrinking the leak window 7.5x versus the old 15 minutes; a caller
 * that misses the window simply re-requests a grant. The download side is
 * additionally single-use at the route (spent on first accepted GET).
 */
const GRANT_TTL_MS = 2 * 60 * 1000;
function createArtifactService(db, options = {}) {
    const storageBackend = options.migrationWindow
        ? 's3'
        : options.storageBackend ?? (options.storageFacade ? 's3' : 'postgres');
    // A missing setting must fail closed. PostgreSQL fallback is allowed only
    // while an operator explicitly enables the approved migration window.
    const dualReadEnabled = options.migrationWindow === true;
    const s3OnlyCutover = storageBackend === 's3' && options.migrationWindow !== true;
    if (storageBackend === 's3' && !options.storageFacade) {
        throw new Error('S3 artifact storage requires a configured facade');
    }
    const maxArtifactBytes = options.maxArtifactBytes ?? 64 * 1024 * 1024;
    if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 0) {
        throw new Error('maxArtifactBytes must be a non-negative safe integer');
    }
    const encryption = options.encryption;
    if (encryption) {
        const facade = encryption.facade;
        if (!facade
            || typeof facade.encrypt !== 'function'
            || typeof facade.encryptStream !== 'function'
            || typeof facade.decrypt !== 'function'
            || typeof facade.decryptStream !== 'function'
            || typeof encryption.keyRef !== 'string'
            || encryption.keyRef.length < 1
            || encryption.keyRef.length > 256) {
            throw new Error('artifact encryption requires a crypto storage facade and an allowlisted key ref');
        }
    }
    const encryptionRequired = encryption?.required === true;
    const postgresStorage = (0, postgres_storage_facade_1.createPostgresArtifactStorageFacade)({
        async read(storageKey) {
            const result = await db.query('SELECT bytes FROM artifact_blobs WHERE storage_key=$1', [storageKey]);
            return result.rowCount ? Buffer.from(result.rows[0].bytes) : null;
        },
        async delete(storageKey) {
            await db.query('DELETE FROM artifact_blobs WHERE storage_key=$1', [storageKey]);
        },
        async write(storageKey, tenantId, bytes) {
            await db.query(`INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
         ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`, [storageKey, tenantId, bytes]);
        },
    });
    function storageFor(backend) {
        if (backend === 'postgres')
            return postgresStorage;
        if (backend === 's3' && options.storageFacade)
            return options.storageFacade;
        throw (0, errors_1.unavailable)('artifact storage backend is not configured');
    }
    /**
     * SEC-ENC-04: the sealed worker upload path is server-mediated, so the S3
     * presigned grant is never minted when encryption is configured. Returning
     * the tokenized proxy URL keeps the single-PUT wire shape unchanged while
     * ensuring the only writer is this service.
     */
    function serverMediatedUploadGrant(proxyUrl, expiresAt) {
        return { url: proxyUrl, expiresAt };
    }
    async function assertLease(taskId, leaseEpoch) {
        const res = await db.query(`SELECT t.lease_epoch, t.operation_id, o.tenant_id,
              (t.lease_expires_at IS NOT NULL AND t.lease_expires_at > now()) AS lease_active
       FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1`, [taskId]);
        if (!res.rowCount)
            throw (0, errors_1.notFound)(`task ${taskId} not found`);
        const row = res.rows[0];
        if (row.lease_epoch !== leaseEpoch) {
            throw (0, errors_1.conflict)('LEASE_LOST', `stale leaseEpoch ${leaseEpoch}, current ${row.lease_epoch}`);
        }
        if (!row.lease_active) {
            throw (0, errors_1.conflict)('LEASE_LOST', `lease has expired for task ${taskId}`);
        }
        return row;
    }
    return {
        async requestUpload(taskId, leaseEpoch, body) {
            const lease = await assertLease(taskId, leaseEpoch);
            const parsed = contracts_1.ArtifactUploadGrantRequestSchema.safeParse(body);
            if (!parsed.success)
                throw (0, errors_1.unprocessable)('INVALID_SCHEMA', 'artifact upload grant request failed', {
                    errors: parsed.error.issues.slice(0, 20).map((i) => ({ pointer: '/' + i.path.join('/'), message: i.message })),
                });
            const req = parsed.data;
            if (req.sizeBytes > maxArtifactBytes) {
                throw new errors_1.HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the configured size limit');
            }
            const artifactId = (0, node_crypto_1.randomUUID)();
            const storageKey = `art-${artifactId}`;
            const token = (0, node_crypto_1.randomUUID)();
            // CR-12: the grant is method-scoped (upload) with a STORED expiry. The
            // blob route enforces both, so this token can never GET and dies on
            // time even if the advertised `expiresAt` is ignored by the caller.
            const expiresAt = new Date(Date.now() + GRANT_TTL_MS).toISOString();
            const proxyUrl = `/api/runtime/v1/artifacts/blob/${encodeURIComponent(storageKey)}?grant=${token}`;
            // SEC-ENC-04: when sealing is configured the object version and the
            // server-mediated proxy URL are pinned at admission. No direct backend
            // grant is minted, so bytes cannot reach storage around the seal.
            const objectVersion = encryption ? (0, node_crypto_1.randomUUID)() : null;
            let storageGrant;
            if (encryption) {
                storageGrant = serverMediatedUploadGrant(proxyUrl, expiresAt);
            }
            else {
                try {
                    storageGrant = await storageFor(storageBackend).createUploadGrant({
                        artifactId,
                        tenantId: lease.tenant_id,
                        objectKey: storageKey,
                        contentType: req.mimeType,
                        maxBytes: req.sizeBytes,
                        expiresAt,
                        proxyUrl,
                    });
                }
                catch (error) {
                    throw storageErrorToHttp(error);
                }
            }
            if (objectVersion) {
                await db.query(`INSERT INTO artifacts (id, tenant_id, operation_id, task_id, purpose, file_name, mime_type, size_bytes, state,
                                  token, token_mode, token_expires_at, storage_key, storage_backend, upload_token)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'STAGING',$9,'upload',$10,$11,$12,$13)`, [artifactId, lease.tenant_id, lease.operation_id, taskId, req.purpose, req.fileName ?? null, req.mimeType, req.sizeBytes,
                    token, expiresAt, storageKey, storageBackend, objectVersion]);
            }
            else {
                await db.query(`INSERT INTO artifacts (id, tenant_id, operation_id, task_id, purpose, file_name, mime_type, size_bytes, state,
                                  token, token_mode, token_expires_at, storage_key, storage_backend)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'STAGING',$9,'upload',$10,$11,$12)`, [artifactId, lease.tenant_id, lease.operation_id, taskId, req.purpose, req.fileName ?? null, req.mimeType, req.sizeBytes,
                    token, expiresAt, storageKey, storageBackend]);
            }
            return {
                artifactId,
                uploadUrl: storageGrant.url,
                expiresAt,
            };
        },
        // A producer must prove its task and lease epoch. Locking that task row
        // makes the state/epoch check atomic with cancellation and lease takeover.
        // The artifact row is then locked in the same transaction as the blob
        // hash check and READY transition; putBlob takes the same artifact lock,
        // so an upload that races finalization either completes first and is
        // hash-checked, or observes READY and is rejected.
        async finalize(artifactId, body) {
            const parsed = contracts_1.ArtifactFinalizeRequestSchema.safeParse(body);
            if (!parsed.success)
                throw (0, errors_1.unprocessable)('INVALID_SCHEMA', 'artifact finalize failed', {
                    errors: parsed.error.issues.slice(0, 20).map((i) => ({ pointer: '/' + i.path.join('/'), message: i.message })),
                });
            const req = parsed.data;
            // Above BOTH branch ceilings there is nothing to look up: reject before
            // touching storage. A multipart row is capped by the size it declared
            // at init (already policy-checked there), so its cap is taken below,
            // where the row and its branch are known.
            if (req.sizeBytes > Math.max(maxArtifactBytes, contracts_1.MULTIPART_MAX_TOTAL_BYTES)) {
                throw new errors_1.HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the configured size limit');
            }
            return db.tx(async (client) => {
                const taskRes = await client.query(`SELECT lease_epoch, state, operation_id,
                  (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
           FROM tasks WHERE id=$1 FOR UPDATE`, [req.taskId]);
                if (!taskRes.rowCount)
                    throw (0, errors_1.notFound)(`task ${req.taskId} not found`);
                const task = taskRes.rows[0];
                const artifactRes = await client.query(`SELECT tenant_id AS "tenantId", operation_id AS "operationId", storage_key AS "storageKey", storage_backend AS "storageBackend",
                  storage_version_id AS "storageVersionId", state,
                  task_id AS "taskId", size_bytes AS "sizeBytes", sha256,
                  upload_token AS "uploadToken", manifest_version_id AS "manifestVersionId",
                  finalized_lease_epoch AS "finalizedLeaseEpoch",
                  part_count AS "partCount"
           FROM artifacts WHERE id=$1 FOR UPDATE`, [artifactId]);
                if (!artifactRes.rowCount)
                    throw (0, errors_1.notFound)(`artifact ${artifactId} not found`);
                const art = artifactRes.rows[0];
                if (art.operationId && task.operation_id && art.operationId !== task.operation_id) {
                    throw (0, errors_1.conflict)('PERMISSION_DENIED', 'task cannot finalize artifact of different operation');
                }
                if (art.state === 'READY') {
                    if (art.taskId === req.taskId &&
                        art.finalizedLeaseEpoch === req.leaseEpoch &&
                        art.sha256 === req.sha256 &&
                        Number(art.sizeBytes) === req.sizeBytes) {
                        // A prior finalize committed but its response may have been lost.
                        // The persisted producer epoch and metadata make this replay safe
                        // even if the task has since completed or its lease expired.
                        return { artifactId, state: 'READY' };
                    }
                    throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact is READY with different producer or metadata');
                }
                if (art.taskId !== req.taskId) {
                    throw (0, errors_1.forbidden)('artifact does not belong to task');
                }
                if (task.lease_epoch !== req.leaseEpoch || !task.lease_active) {
                    if (task.lease_epoch !== req.leaseEpoch) {
                        throw (0, errors_1.conflict)('LEASE_LOST', 'producer lease epoch is stale');
                    }
                    throw (0, errors_1.forbidden)('producer lease has expired');
                }
                if (task.state !== 'RUNNING') {
                    throw (0, errors_1.conflict)('STATE_CONFLICT', 'producer task is not RUNNING');
                }
                if (art.state !== 'STAGING') {
                    throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact is not STAGING and cannot be finalized');
                }
                // A multipart row was sized and admitted by `init`; its own declared
                // byte count is the cap here, never the single-PUT limit.
                const admissionCap = art.partCount == null
                    ? maxArtifactBytes
                    : Math.max(maxArtifactBytes, Number(art.sizeBytes ?? 0));
                if (req.sizeBytes > admissionCap) {
                    throw new errors_1.HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the configured size limit');
                }
                const artifactBackend = art.storageBackend ?? 'postgres';
                const verificationStorage = artifactBackend === 'postgres'
                    ? (0, postgres_storage_facade_1.createPostgresArtifactStorageFacade)({
                        async read(storageKey) {
                            const blob = await client.query('SELECT bytes FROM artifact_blobs WHERE storage_key=$1', [storageKey]);
                            return blob.rowCount ? Buffer.from(blob.rows[0].bytes) : null;
                        },
                        async delete(storageKey) {
                            await client.query('DELETE FROM artifact_blobs WHERE storage_key=$1', [storageKey]);
                        },
                    })
                    : storageFor(artifactBackend);
                const finishFinalize = async (finalized) => {
                    if (!finalized.rowCount) {
                        // The task lock prevents cancel/takeover during this transaction;
                        // the UPDATE predicate also checks lease expiry at the commit edge.
                        const currentTaskRes = await client.query(`SELECT lease_epoch, state,
                      (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
               FROM tasks WHERE id=$1`, [req.taskId]);
                        const currentTask = currentTaskRes.rows[0];
                        if (!currentTask || currentTask.lease_epoch !== req.leaseEpoch) {
                            throw (0, errors_1.conflict)('LEASE_LOST', 'producer lease epoch changed before finalization');
                        }
                        if (!currentTask.lease_active) {
                            throw (0, errors_1.forbidden)('producer lease expired before finalization');
                        }
                        if (currentTask.state !== 'RUNNING') {
                            throw (0, errors_1.conflict)('STATE_CONFLICT', 'producer task is not RUNNING');
                        }
                        throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact changed before finalization');
                    }
                    return { artifactId, state: finalized.rows[0].state };
                };
                // SEC-ENC-04: a sealed worker artifact is verified against its
                // authenticated envelope. The finalize request carries PLAINTEXT
                // business metadata; storage holds ciphertext whose pinned version and
                // hash stay separate from the plaintext sha/size committed to the row.
                if (encryption && art.uploadToken) {
                    if (!art.storageVersionId) {
                        throw storageErrorToHttp(new storage_facade_1.ArtifactStorageError('ENCRYPTION_REQUIRED'));
                    }
                    const manifestKey = (0, artifact_encryption_1.manifestKeyFor)(art.storageKey);
                    let sidecarBytes;
                    try {
                        if (typeof verificationStorage.readServerObject !== 'function') {
                            throw new storage_facade_1.ArtifactStorageError('ENCRYPTION_UNAVAILABLE');
                        }
                        sidecarBytes = await verificationStorage.readServerObject(manifestKey);
                    }
                    catch (error) {
                        if (error instanceof storage_facade_1.ArtifactStorageError && error.code === 'OBJECT_NOT_FOUND') {
                            throw storageErrorToHttp(new storage_facade_1.ArtifactStorageError('ENCRYPTION_REQUIRED'));
                        }
                        throw storageErrorToHttp(error);
                    }
                    const identity = {
                        tenantId: art.tenantId,
                        artifactId,
                        objectVersion: art.uploadToken,
                    };
                    let parsed;
                    try {
                        parsed = (0, artifact_encryption_1.parseWorkerArtifactSidecar)(JSON.parse(sidecarBytes.toString('utf8')));
                    }
                    catch (error) {
                        throw storageErrorToHttp(error);
                    }
                    let verified;
                    try {
                        const ciphertext = await collectReadable(await verificationStorage.openRead({
                            objectKey: art.storageKey,
                            versionId: art.storageVersionId,
                        }), maxArtifactBytes);
                        verified = await (0, artifact_encryption_1.verifyWorkerArtifact)({
                            sidecar: parsed,
                            ciphertext,
                            context: (0, artifact_encryption_1.artifactEncryptionContext)(identity),
                            seam: encryption,
                        });
                    }
                    catch (error) {
                        throw storageErrorToHttp(error);
                    }
                    if (verified.plaintextSizeBytes !== req.sizeBytes) {
                        throw storageErrorToHttp(new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH'));
                    }
                    if (verified.plaintextSha256 !== req.sha256) {
                        throw storageErrorToHttp(new storage_facade_1.ArtifactStorageError('CHECKSUM_MISMATCH'));
                    }
                    const sealedFinalized = await client.query(`UPDATE artifacts SET state='READY', size_bytes=$2, sha256=$3,
                                  finalized_lease_epoch=$5, storage_version_id=$6,
                                  manifest_version_id=COALESCE(manifest_version_id,$7)
             WHERE id=$1 AND task_id=$4 AND state='STAGING'
               AND EXISTS (
                 SELECT 1 FROM tasks t
                 WHERE t.id=$4 AND t.lease_epoch=$5 AND t.state='RUNNING'
                   AND t.lease_expires_at > now()
               )
             RETURNING id, state`, [artifactId, verified.plaintextSizeBytes, verified.plaintextSha256,
                        req.taskId, req.leaseEpoch, art.storageVersionId, art.manifestVersionId ?? null]);
                    return finishFinalize(sealedFinalized);
                }
                if (encryption && encryptionRequired && !art.uploadToken) {
                    // Strict deployment: a row admitted without the sealed carrier must
                    // not become READY, even if its raw bytes still verify as plaintext.
                    throw storageErrorToHttp(new storage_facade_1.ArtifactStorageError('ENCRYPTION_REQUIRED'));
                }
                let pinned;
                try {
                    pinned = await verificationStorage.verifyAndPin({
                        artifactId,
                        tenantId: art.tenantId,
                        objectKey: art.storageKey,
                        expectedSizeBytes: req.sizeBytes,
                        expectedSha256: req.sha256,
                    });
                }
                catch (error) {
                    throw storageErrorToHttp(error);
                }
                if (pinned.objectKey !== art.storageKey ||
                    !pinned.versionId ||
                    pinned.versionId === 'null' ||
                    pinned.sizeBytes !== req.sizeBytes ||
                    pinned.sha256 !== req.sha256) {
                    throw storageErrorToHttp(new storage_facade_1.ArtifactStorageError('CHECKSUM_MISMATCH'));
                }
                const finalized = await client.query(`UPDATE artifacts SET state='READY', size_bytes=$2, sha256=$3,
                                finalized_lease_epoch=$5, storage_version_id=$6
           WHERE id=$1 AND task_id=$4 AND state='STAGING'
             AND EXISTS (
               SELECT 1 FROM tasks t
               WHERE t.id=$4 AND t.lease_epoch=$5 AND t.state='RUNNING'
                 AND t.lease_expires_at > now()
             )
           RETURNING id, state`, [artifactId, pinned.sizeBytes, pinned.sha256, req.taskId, req.leaseEpoch, pinned.versionId]);
                return finishFinalize(finalized);
            });
        },
        async requestAccess(artifactId, body) {
            const parsed = contracts_1.ArtifactAccessRequestSchema.safeParse(body);
            if (!parsed.success)
                throw (0, errors_1.unprocessable)('INVALID_SCHEMA', 'artifact access request failed', {
                    errors: parsed.error.issues.slice(0, 20).map((i) => ({ pointer: '/' + i.path.join('/'), message: i.message })),
                });
            const req = parsed.data;
            return db.tx(async (client) => {
                // Lock the requester first, matching finalize's task -> artifact lock
                // order. This makes lease/state authorization atomic with grant minting.
                const taskRes = await client.query(`SELECT t.lease_epoch, t.state, t.operation_id AS "operationId",
                  o.tenant_id AS "tenantId", o.submit_artifacts AS "submitArtifacts",
                  (t.lease_expires_at IS NOT NULL AND t.lease_expires_at > now()) AS lease_active
           FROM tasks t JOIN operations o ON o.id = t.operation_id
           WHERE t.id=$1 FOR UPDATE OF t`, [req.taskId]);
                if (!taskRes.rowCount)
                    throw (0, errors_1.notFound)(`task ${req.taskId} not found`);
                const task = taskRes.rows[0];
                if (task.lease_epoch !== req.leaseEpoch) {
                    throw (0, errors_1.conflict)('LEASE_LOST', 'requester lease epoch is stale');
                }
                if (!task.lease_active)
                    throw (0, errors_1.conflict)('LEASE_LOST', 'requester lease has expired');
                if (task.state !== 'RUNNING') {
                    throw (0, errors_1.conflict)('STATE_CONFLICT', 'requester task is not RUNNING');
                }
                const artifactRes = await client.query(`SELECT tenant_id AS "tenantId", operation_id AS "operationId",
                  storage_key AS "storageKey", storage_backend AS "storageBackend",
                  storage_version_id AS "storageVersionId", file_name AS "fileName", mime_type AS "mimeType",
                  size_bytes AS "sizeBytes", sha256,
                  state, task_id AS "taskId", purpose
            FROM artifacts WHERE id=$1 FOR UPDATE`, [artifactId]);
                if (!artifactRes.rowCount)
                    throw (0, errors_1.notFound)(`artifact ${artifactId} not found`);
                const art = artifactRes.rows[0];
                if (art.state === 'DELETED')
                    throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact deleted');
                const sameTenant = art.tenantId === task.tenantId;
                const sameOperation = sameTenant && art.operationId === task.operationId;
                let readVersionId;
                if (req.mode === 'read') {
                    // Parent and child tasks share an operation id. Cross-operation reads
                    // require an exact submit_artifacts reference from this operation;
                    // only public-purpose refs can cross this boundary. Intermediate and
                    // session artifacts remain operation-internal checkpoints.
                    const declaredReference = sameTenant &&
                        isPublicArtifactPurpose(art.purpose) &&
                        hasDeclaredArtifactReference(task.submitArtifacts, artifactId);
                    if (!sameOperation && !declaredReference) {
                        throw (0, errors_1.conflict)('PERMISSION_DENIED', 'task is not authorized to read artifact');
                    }
                    if (art.taskId !== req.taskId && art.state !== 'READY') {
                        throw (0, errors_1.conflict)('PERMISSION_DENIED', 'foreign task cannot access unready artifact');
                    }
                    if (art.state !== 'READY')
                        throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact is not READY');
                    readVersionId = art.storageVersionId ??
                        ((art.storageBackend ?? 'postgres') === 'postgres' ? art.sha256 ?? undefined : undefined);
                    if (!readVersionId ||
                        ((art.storageBackend ?? 'postgres') === 's3' && readVersionId === 'null') ||
                        !art.sha256 ||
                        art.sizeBytes === null ||
                        art.sizeBytes === undefined) {
                        throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact has no immutable version and integrity metadata');
                    }
                }
                else {
                    // Write grants remain producer-scoped even when another task shares
                    // the operation; STAGING is the only mutable artifact state.
                    if (!sameTenant || art.operationId !== task.operationId || art.taskId !== req.taskId) {
                        throw (0, errors_1.conflict)('PERMISSION_DENIED', 'task is not authorized to write artifact');
                    }
                    if (art.state !== 'STAGING') {
                        throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact is not STAGING');
                    }
                }
                const token = (0, node_crypto_1.randomUUID)();
                // CR-12: store method scope and expiry in the same transaction as the
                // authorization decision, before returning a storage-facade URL.
                const expiresAt = new Date(Date.now() + GRANT_TTL_MS).toISOString();
                const scope = req.mode === 'read' ? 'download' : 'upload';
                await client.query('UPDATE artifacts SET token=$2, token_mode=$3, token_expires_at=$4 WHERE id=$1', [artifactId, token, scope, expiresAt]);
                const grant = { artifactId, expiresAt };
                if (req.mode === 'read') {
                    grant.downloadUrl = proxyBlobUrl(art.storageKey, token);
                    grant.fileName = art.fileName ?? undefined;
                    grant.mimeType = art.mimeType;
                    grant.sizeBytes = art.sizeBytes === null || art.sizeBytes === undefined
                        ? undefined
                        : Number(art.sizeBytes);
                    grant.sha256 = art.sha256 ?? undefined;
                    grant.storageVersionId = readVersionId;
                }
                else {
                    if ((art.storageBackend ?? 'postgres') === 's3') {
                        try {
                            const s3Grant = await storageFor('s3').createUploadGrant({
                                artifactId,
                                tenantId: art.tenantId,
                                objectKey: art.storageKey,
                                contentType: art.mimeType ?? 'application/octet-stream',
                                maxBytes: Number(art.sizeBytes ?? 0),
                                expiresAt,
                            });
                            grant.uploadUrl = s3Grant.url;
                        }
                        catch (error) {
                            throw storageErrorToHttp(error);
                        }
                    }
                    else {
                        grant.uploadUrl = proxyBlobUrl(art.storageKey, token);
                    }
                }
                // NOTE: URL absolutization happens at the route layer (service has no host).
                return grant;
            });
        },
        // Serialize uploads with finalize by locking the artifact row through the
        // blob write. READY (and any other non-STAGING) rows are immutable.
        async putBlob(storageKey, tenantId, bytes) {
            await db.tx(async (client) => {
                const cur = await client.query(`SELECT a.id, a.state, a.storage_backend AS "storageBackend", a.upload_token AS "uploadToken"
           FROM artifacts a
           WHERE a.storage_key=$1 AND a.tenant_id=$2 FOR UPDATE OF a`, [storageKey, tenantId]);
                if (!cur.rowCount)
                    throw (0, errors_1.notFound)('artifact upload target not found');
                const row = cur.rows[0];
                const backend = row.storageBackend ?? 'postgres';
                if (row.state !== 'STAGING') {
                    throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact is not STAGING and its bytes are immutable');
                }
                if (encryption) {
                    // SEC-ENC-04: the server seals before any byte reaches a store. A
                    // row without its pinned object version cannot satisfy the policy.
                    if (!row.uploadToken) {
                        throw storageErrorToHttp(new storage_facade_1.ArtifactStorageError('ENCRYPTION_REQUIRED'));
                    }
                    const identity = {
                        tenantId,
                        artifactId: row.id,
                        objectVersion: row.uploadToken,
                    };
                    const sealed = await (0, artifact_encryption_1.sealWorkerArtifact)({ bytes, identity, seam: encryption });
                    const manifestKey = (0, artifact_encryption_1.manifestKeyFor)(storageKey);
                    let writtenCiphertextVersion = null;
                    let writtenManifestVersion = null;
                    try {
                        if (backend === 'postgres') {
                            await client.query(`INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
                 ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`, [storageKey, tenantId, sealed.ciphertext]);
                            writtenCiphertextVersion = sealed.ciphertextSha256;
                            await client.query(`INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
                 ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`, [manifestKey, tenantId, sealed.sidecar]);
                            writtenManifestVersion = (0, node_crypto_1.createHash)('sha256').update(sealed.sidecar).digest('hex');
                        }
                        else {
                            const writer = storageFor(backend);
                            if (typeof writer.putServerObject !== 'function') {
                                throw new storage_facade_1.ArtifactStorageError('ENCRYPTION_UNAVAILABLE');
                            }
                            writtenCiphertextVersion = (await writer.putServerObject({
                                objectKey: storageKey,
                                tenantId,
                                body: sealed.ciphertext,
                                contentType: artifact_encryption_1.ARTIFACT_CIPHERTEXT_CONTENT_TYPE,
                                metadata: (0, artifact_encryption_1.sealedObjectMetadata)({ artifactId: row.id, tenantId, manifestKey }),
                            })).versionId;
                            writtenManifestVersion = (await writer.putServerObject({
                                objectKey: manifestKey,
                                tenantId,
                                body: sealed.sidecar,
                                contentType: artifact_encryption_1.ARTIFACT_SIDECAR_CONTENT_TYPE,
                                metadata: (0, artifact_encryption_1.manifestObjectMetadata)({ artifactId: row.id, tenantId }),
                            })).versionId;
                        }
                        await client.query(`UPDATE artifacts SET storage_version_id=$2, manifest_version_id=$3
               WHERE id=$1 AND state='STAGING'`, [row.id, writtenCiphertextVersion ?? null, writtenManifestVersion ?? null]);
                    }
                    catch (error) {
                        if (backend !== 'postgres' && options.storageFacade) {
                            // Best-effort orphan cleanup; the row stays STAGING and the
                            // recovery sweeper owns anything left behind.
                            if (writtenManifestVersion) {
                                await options.storageFacade.delete({ objectKey: manifestKey, versionId: writtenManifestVersion }).catch(() => undefined);
                            }
                            if (writtenCiphertextVersion) {
                                await options.storageFacade.delete({ objectKey: storageKey, versionId: writtenCiphertextVersion }).catch(() => undefined);
                            }
                        }
                        throw storageErrorToHttp(error);
                    }
                    return;
                }
                if (backend !== 'postgres') {
                    throw (0, errors_1.conflict)('STATE_CONFLICT', 'S3 uploads must use the issued storage grant');
                }
                await client.query(`INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
           ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`, [storageKey, tenantId, bytes]);
            });
        },
        async putPublicArtifact(input) {
            if (encryption) {
                // The legacy compat writer owns its own INS/DELETE transaction and has
                // no envelope carrier, so it cannot satisfy the sealing policy. Refuse
                // before any plaintext byte is written rather than degrade the policy.
                throw (0, errors_1.unavailable)('legacy inline uploads are unavailable while artifact encryption is configured');
            }
            return (0, legacy_public_artifact_1.writePublicArtifact)({
                query: (sql, params) => db.query(sql, params),
                putBlob: async (storageKey, tenantId, bytes) => {
                    // PostgreSQL fallback only. On S3 the bytes must travel through a
                    // pre-signed upload grant, so a caller that already holds the bytes
                    // in memory has no supported write path here — the facade reports
                    // that as unavailable rather than pretending the object landed.
                    if (storageBackend !== 'postgres') {
                        throw new errors_1.HttpError(503, 'TEMPORARY_UNAVAILABLE', 'inline legacy uploads require the PostgreSQL storage backend');
                    }
                    await db.query(`INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)` +
                        ' ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()', [storageKey, tenantId, bytes]);
                },
                verifyAndPin: async (pin) => {
                    try {
                        return await storageFor(storageBackend).verifyAndPin(pin);
                    }
                    catch (error) {
                        throw storageErrorToHttp(error);
                    }
                },
                storageBackend,
                maxArtifactBytes,
            }, input);
        },
        async getBlob(storageKey) {
            const result = await db.query(`SELECT id, tenant_id AS "tenantId", state, storage_backend AS "storageBackend",
                storage_version_id AS "storageVersionId", size_bytes AS "sizeBytes", sha256,
                upload_token AS "uploadToken"
         FROM artifacts WHERE storage_key=$1`, [storageKey]);
            if (!result.rowCount)
                throw (0, errors_1.notFound)('artifact not found');
            const art = result.rows[0];
            if (art.state !== 'READY')
                throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact is not READY');
            if (!art.sha256 || art.sizeBytes === null || art.sizeBytes === undefined) {
                throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact has no integrity metadata');
            }
            const expectedSizeBytes = Number(art.sizeBytes);
            const expectedSha256 = art.sha256;
            const backend = art.storageBackend ?? 'postgres';
            // SEC-ENC-04: sealed worker artifacts are opened server-side, exactly
            // like the public upload route. The envelope binds tenant/artifact/pinned
            // version, so a swapped row or ciphertext is a refusal, never a raw
            // ciphertext body served under a success status.
            if (encryption && art.uploadToken) {
                const objectStore = storageFor(backend);
                if (typeof objectStore.readServerObject !== 'function') {
                    throw storageErrorToHttp(new storage_facade_1.ArtifactStorageError('ENCRYPTION_UNAVAILABLE'));
                }
                const manifestKey = (0, artifact_encryption_1.manifestKeyFor)(storageKey);
                let sidecarBytes = null;
                try {
                    sidecarBytes = await objectStore.readServerObject(manifestKey);
                }
                catch (error) {
                    if (!(error instanceof storage_facade_1.ArtifactStorageError && error.code === 'OBJECT_NOT_FOUND')) {
                        throw storageErrorToHttp(error);
                    }
                }
                if (sidecarBytes) {
                    if (!art.storageVersionId) {
                        throw (0, errors_1.conflict)('STATE_CONFLICT', 'artifact has no immutable version and integrity metadata');
                    }
                    try {
                        const manifest = (0, artifact_encryption_1.parseWorkerArtifactSidecar)(JSON.parse(sidecarBytes.toString('utf8')));
                        const ciphertext = await collectReadable(await objectStore.openRead({
                            objectKey: storageKey,
                            versionId: art.storageVersionId,
                        }), maxArtifactBytes);
                        const plaintext = await (0, artifact_encryption_1.openWorkerArtifact)({
                            sidecar: manifest,
                            ciphertext,
                            context: (0, artifact_encryption_1.artifactEncryptionContext)({
                                tenantId: art.tenantId,
                                artifactId: art.id,
                                objectVersion: art.uploadToken,
                            }),
                            seam: encryption,
                        });
                        const plaintextSha256 = (0, node_crypto_1.createHash)('sha256').update(plaintext).digest('hex');
                        if (plaintextSha256 !== expectedSha256 || plaintext.byteLength !== expectedSizeBytes) {
                            throw new storage_facade_1.ArtifactStorageError('ENVELOPE_INVALID');
                        }
                        return node_stream_1.Readable.from([plaintext]);
                    }
                    catch (error) {
                        throw storageErrorToHttp(error);
                    }
                }
                if (encryptionRequired) {
                    throw storageErrorToHttp(new storage_facade_1.ArtifactStorageError('ENCRYPTION_REQUIRED'));
                }
            }
            // During DATA-05 roll-forward, check S3 first. For legacy PostgreSQL rows,
            // verify the candidate S3 object against source metadata. Only the active
            // explicitly enabled dual-read window may fall back to PostgreSQL;
            // missing or false configuration keeps PostgreSQL fallback disabled.
            if (options.storageFacade && (backend === 's3' || dualReadEnabled || s3OnlyCutover)) {
                try {
                    if (backend === 's3' && art.storageVersionId) {
                        return await options.storageFacade.openRead({
                            objectKey: storageKey,
                            versionId: art.storageVersionId,
                        });
                    }
                    const candidate = await options.storageFacade.verifyAndPin({
                        artifactId: art.id,
                        tenantId: art.tenantId,
                        objectKey: storageKey,
                        expectedSizeBytes,
                        expectedSha256,
                    });
                    if (candidate.objectKey !== storageKey ||
                        !candidate.versionId || candidate.versionId === 'null' ||
                        candidate.sizeBytes !== expectedSizeBytes ||
                        candidate.sha256.toLowerCase() !== expectedSha256.toLowerCase()) {
                        throw new storage_facade_1.ArtifactStorageError('CHECKSUM_MISMATCH');
                    }
                    return await options.storageFacade.openRead({
                        objectKey: storageKey,
                        versionId: candidate.versionId,
                    });
                }
                catch (error) {
                    if (!isStorageObjectNotFound(error) || !dualReadEnabled)
                        throw storageErrorToHttp(error);
                }
            }
            if (s3OnlyCutover) {
                throw (0, errors_1.conflict)('STATE_CONFLICT', 'S3-only cutover has an unresolved artifact; PostgreSQL fallback is disabled');
            }
            // PostgreSQL remains the rollback copy throughout the migration window.
            // Re-hash it on read and use the content hash as its immutable generation.
            let postgresPin;
            try {
                postgresPin = await postgresStorage.verifyAndPin({
                    artifactId: art.id,
                    tenantId: art.tenantId,
                    objectKey: storageKey,
                    expectedSizeBytes,
                    expectedSha256,
                });
            }
            catch (error) {
                throw storageErrorToHttp(error);
            }
            if (backend === 'postgres' && !art.storageVersionId) {
                await db.query(`UPDATE artifacts SET storage_version_id=$2
           WHERE id=$1 AND state='READY' AND storage_version_id IS NULL
             AND storage_backend='postgres'`, [art.id, postgresPin.versionId]);
            }
            try {
                return await postgresStorage.openRead({ objectKey: storageKey, versionId: postgresPin.versionId });
            }
            catch (error) {
                throw storageErrorToHttp(error);
            }
        },
    };
}
function isPublicArtifactPurpose(purpose) {
    return purpose === 'input' || purpose === 'output';
}
function hasDeclaredArtifactReference(value, artifactId) {
    if (!Array.isArray(value))
        return false;
    return value.some((entry) => typeof entry === 'object' &&
        entry !== null &&
        !Array.isArray(entry) &&
        'artifactId' in entry &&
        entry.artifactId === artifactId);
}
function proxyBlobUrl(storageKey, token) {
    return `/api/runtime/v1/artifacts/blob/${encodeURIComponent(storageKey)}?grant=${token}`;
}
/** Collect one bounded server-side stream (envelope/plaintext read paths). */
async function collectReadable(stream, maxBytes) {
    const chunks = [];
    let total = 0;
    for await (const chunk of stream) {
        const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
        total += bytes.byteLength;
        if (total > maxBytes) {
            throw new storage_facade_1.ArtifactStorageError('SIZE_MISMATCH');
        }
        chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
}
function isStorageObjectNotFound(error) {
    return error instanceof storage_facade_1.ArtifactStorageError && error.code === 'OBJECT_NOT_FOUND';
}
function storageErrorToHttp(error) {
    if (error instanceof storage_facade_1.ArtifactStorageError) {
        switch (error.code) {
            case 'INVALID_UPLOAD_GRANT':
                return (0, errors_1.unprocessable)('INVALID_STORAGE_GRANT', 'artifact storage rejected the upload grant');
            case 'OBJECT_NOT_FOUND':
                return (0, errors_1.conflict)('STATE_CONFLICT', 'artifact has no stored bytes');
            case 'SIZE_MISMATCH':
                return (0, errors_1.conflict)('SIZE_MISMATCH', 'stored bytes do not match supplied sizeBytes');
            case 'CHECKSUM_MISMATCH':
                return (0, errors_1.conflict)('HASH_MISMATCH', 'stored bytes do not match supplied sha256');
            case 'OBJECT_VERSION_REQUIRED':
            case 'ARTIFACT_METADATA_MISMATCH':
            case 'TENANT_METADATA_MISMATCH':
                return (0, errors_1.conflict)('STATE_CONFLICT', 'artifact storage metadata could not be verified');
            case 'INVALID_OBJECT_BODY':
            case 'STORAGE_UNAVAILABLE':
                return (0, errors_1.unavailable)('artifact storage is temporarily unavailable');
            case 'ENCRYPTION_UNAVAILABLE':
                return (0, errors_1.unavailable)('artifact encryption is temporarily unavailable');
            case 'ENCRYPTION_REQUIRED':
                return (0, errors_1.unavailable)('artifact encryption is required and was not satisfied');
            case 'ENVELOPE_INVALID':
                return (0, errors_1.conflict)('STATE_CONFLICT', 'artifact encryption envelope could not be verified');
        }
    }
    // Never propagate provider exception messages, request IDs, URLs or paths.
    return (0, errors_1.unavailable)('artifact storage is temporarily unavailable');
}
