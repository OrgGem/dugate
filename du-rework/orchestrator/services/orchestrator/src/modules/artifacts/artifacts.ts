import { createHash, randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  ArtifactAccessGrantSchema,
  ArtifactAccessRequestSchema,
  ArtifactFinalizeRequestSchema,
  ArtifactUploadGrantRequestSchema,
  ArtifactUploadGrantSchema,
  MULTIPART_MAX_TOTAL_BYTES,
  type ArtifactAccessGrant,
  type ArtifactUploadGrant,
} from '@du/contracts';
import { Db } from '../../db/db';
import { HttpError, conflict, forbidden, notFound, unprocessable, unavailable } from '../../http/errors';
import {
  ArtifactStorageError,
  type ArtifactStorageFacade,
  type ArtifactStorageUploadGrant,
  type StoredArtifactVersion,
} from './storage-facade';
import { createPostgresArtifactStorageFacade } from './postgres-storage-facade';
import {
  ARTIFACT_CIPHERTEXT_CONTENT_TYPE,
  ARTIFACT_SIDECAR_CONTENT_TYPE,
  artifactEncryptionContext,
  manifestKeyFor,
  manifestObjectMetadata,
  openWorkerArtifact,
  parseWorkerArtifactSidecar,
  sealWorkerArtifact,
  sealedObjectMetadata,
  verifyWorkerArtifact,
  type ParsedWorkerArtifactSidecar,
  type WorkerArtifactEncryption,
  type WorkerArtifactIdentity,
} from './artifact-encryption';
import { writePublicArtifact } from '../../compat/legacy-public-artifact';
import {
  decryptStoredArtifact,
  ENCRYPTED_OBJECT_MARKER,
  ENCRYPTED_OBJECT_MARKER_VALUE,
  MANIFEST_KEY_METADATA,
} from '../encryption/artifact-read-decrypt';
import type { StorageGenerationService } from './storage-generations';
import type { BackupArtifactEffectPort, BackupArtifactEffectProof, BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';

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

export interface ArtifactService {
  requestUpload(
    taskId: string,
    leaseEpoch: number,
    body: unknown
  ): Promise<ArtifactUploadGrant>;
  finalize(artifactId: string, body: unknown): Promise<{ artifactId: string; state: string }>;
  requestAccess(
    artifactId: string,
    body: unknown
  ): Promise<ArtifactAccessGrant>;
  /** Worker-side blob PUT (slice transport; resolves `uploadUrl`). */
  putBlob(storageKey: string, tenantId: string, bytes: Buffer): Promise<void>;
  /** Worker-side blob GET (slice transport; resolves `downloadUrl`). */
  getBlob(storageKey: string): Promise<Readable>;
  /** Verify exact tenant-owned artifact generations for Connector test execution. */
  readInvocationArtifacts(input: { tenantId: string; artifactIds: readonly string[] }): Promise<{
    contents: Array<InvocationArtifactReadContent>;
    pins: Array<InvocationArtifactReadPin>;
  }>;
  /** Exact-version deletion for the audited maintenance engine. This claims
   * an unreferenced row before touching storage and never deletes active or
   * operation/task-pinned content. Ambiguous physical deletion is UNKNOWN. */
  expireForMaintenance(artifactId: string, mode?: 'orphan' | 'retention'): Promise<{ status: 'DELETED' | 'SKIPPED' | 'UNKNOWN'; code: string | null }>;
  /** Read ciphertext plus its exact encryption sidecar for the internal
   * checksummed maintenance bundle. The caller already holds the immutable
   * metadata snapshot; this helper resolves the pinned generation only. */
  readPinnedObjectsForMaintenanceBackup(input: {
    storageBackend: string; storageGenerationId: string | null; storageKey: string;
    storageVersionId: string; manifestVersionId: string | null; maxBytes: number;
  }): Promise<{ objectBytes: Buffer; manifestBytes: Buffer | null }>;
  /** Streaming variant for full immutable backups of multipart-sized objects. */
  openPinnedObjectsForMaintenanceBackup(input: {
    storageBackend: string; storageGenerationId: string | null; storageKey: string;
    storageVersionId: string; manifestVersionId: string | null;
  }): Promise<{ object: Readable; manifest: Readable | null }>;
  /**
   * Store a caller-supplied upload that has no task yet (the legacy compat
   * facade). `requestUpload` cannot serve that case: it asserts a task row
   * because it issues a WORKER grant, and the legacy submit creates its
   * operation and task only after these files exist.
   *
   * The row is written with `operation_id`/`task_id` NULL, exactly like the
   * public upload path, so the worker lifecycle cannot reach it. Bytes are put
   * and pinned through the same `storageFor(backend)` the rest of the service
   * uses, so the digest and size checks are not bypassed.
   */
  putPublicArtifact(input: {
    tenantId: string;
    apiKeyId?: string;
    fileName: string | null;
    mimeType: string;
    bytes: Buffer;
    /** Workflow compatibility uploads must never use the plaintext fallback. */
    requireEncryption?: boolean;
  }): Promise<{ artifactId: string; state: string }>;
  /** Fail before the first artifact row when encrypted public upload is unavailable. */
  assertPublicArtifactEncryptionReady(): void;
  /**
   * Compensate only caller-uploaded, tenant-owned artifacts from this submit.
   * Failed physical deletion leaves an ABORTED/failed row for the retry sweep.
   */
  cleanupUnlinkedPublicArtifacts(tenantId: string, artifactIds: readonly string[]): Promise<{ deleted: number; deferred: number }>;
  /** Retry durable compensation intents; safe to call from the recovery loop. */
  sweepPublicArtifactCleanup(limit?: number): Promise<{ scanned: number; deleted: number; deferred: number }>;
}

/** Authenticated integrity facts keep logical content distinct from immutable
 * ciphertext and the sidecar bytes stored for that artifact. */
export interface InvocationArtifactReadIntegrity {
  databaseMetadata: {
    kind: 'gateway-ciphertext' | 'worker-plaintext' | 'legacy-plaintext';
    sha256: string;
    sizeBytes: number;
  };
  content: { sha256: string; sizeBytes: number };
  storedObject: { sha256: string; sizeBytes: number; versionId: string; storageGenerationId: string | null };
  sidecar: { sha256: string; sizeBytes: number; versionId: string } | null;
  verified: true;
}

export interface InvocationArtifactReadPin {
  artifactId: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  sha256: string;
  storageVersionId: string;
  storageGenerationId: string | null;
  integrity: InvocationArtifactReadIntegrity;
}

export interface InvocationArtifactReadContent extends InvocationArtifactReadPin {
  contentBase64: string;
}

export interface ArtifactServiceOptions {
  /** Defaults to PostgreSQL; S3 requires an explicitly injected facade. */
  storageBackend?: 'postgres' | 's3';
  storageFacade?: ArtifactStorageFacade;
  /** Explicitly approved rollback window: new writes use S3; reads may fall back to retained PostgreSQL blobs. */
  migrationWindow?: boolean;
  /** Dynamic immutable generation router. Existing rows continue through their pinned generation. */
  storageGenerations?: StorageGenerationService;
  /** Durable snapshot permit for maintenance artifact deletion. */
  backupArtifactEffects?: BackupArtifactEffectPort;
  /** Same-transaction snapshot lock for artifact metadata mutations. */
  backupSnapshotWriteGate?: BackupSnapshotWriteGate;
  /** Matches the bounded binary ingress default; S3 grants enforce it before upload. */
  maxArtifactBytes?: number;
  /**
   * SEC-ENC-04: server-mediated envelope sealing for worker artifact writes.
   * When present, every new worker upload is sealed by this service before it
   * reaches PostgreSQL or S3, reads open the authenticated envelope, and a
   * backend without a server write port fails closed. `required: true` makes
   * legacy unsealed rows unreadable (strict policy); the default compatibility
   * path serves them as plaintext during an approved migration window.
   */
  encryption?: WorkerArtifactEncryption;
}

export function createArtifactService(db: Db, options: ArtifactServiceOptions = {}): ArtifactService {
  const storageBackend = options.migrationWindow
    ? 's3'
    : options.storageBackend ?? (options.storageFacade ? 's3' : 'postgres');
  // A missing setting must fail closed. PostgreSQL fallback is allowed only
  // while an operator explicitly enables the approved migration window.
  const dualReadEnabled = options.migrationWindow === true;
  const s3OnlyCutover = storageBackend === 's3' && options.migrationWindow !== true;
  if (storageBackend === 's3' && !options.storageFacade && !options.storageGenerations) {
    throw new Error('S3 artifact storage requires a configured facade');
  }
  const maxArtifactBytes = options.maxArtifactBytes ?? 64 * 1024 * 1024;
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 0) {
    throw new Error('maxArtifactBytes must be a non-negative safe integer');
  }
  const encryption = options.encryption;
  if (encryption) {
    const facade = encryption.facade;
    if (
      !facade
      || typeof facade.encrypt !== 'function'
      || typeof facade.encryptStream !== 'function'
      || typeof facade.decrypt !== 'function'
      || typeof facade.decryptStream !== 'function'
      || typeof encryption.keyRef !== 'string'
      || encryption.keyRef.length < 1
      || encryption.keyRef.length > 256
    ) {
      throw new Error('artifact encryption requires a crypto storage facade and an allowlisted key ref');
    }
  }
  const encryptionRequired = encryption?.required === true;
  const postgresStorage = createPostgresArtifactStorageFacade({
    async read(storageKey) {
      const result = await db.query<{ bytes: Buffer }>(
        'SELECT bytes FROM artifact_blobs WHERE storage_key=$1',
        [storageKey],
      );
      return result.rowCount ? Buffer.from(result.rows[0]!.bytes) : null;
    },
    async delete(storageKey) {
      await db.query('DELETE FROM artifact_blobs WHERE storage_key=$1', [storageKey]);
    },
    async write(storageKey, tenantId, bytes) {
      await db.query(
        `INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
         ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`,
        [storageKey, tenantId, bytes],
      );
    },
  });

  function storageFor(backend: string, generationId?: string | null): ArtifactStorageFacade {
    if (generationId) {
      if (!options.storageGenerations) throw unavailable('artifact storage generation reader is not configured');
      return options.storageGenerations.forGeneration(generationId);
    }
    if (backend === 'postgres') return postgresStorage;
    if (backend === 's3' && options.storageFacade) return options.storageFacade;
    throw unavailable('artifact storage backend is not configured');
  }

  interface EncryptedArtifactRow {
    id: string;
    tenantId: string;
    storageBackend: string;
    storageGenerationId: string | null;
    storageKey: string;
    storageVersionId: string | null;
    manifestVersionId: string | null;
    sizeBytes: number | string | null;
    sha256: string | null;
    uploadToken: string | null;
  }

  async function openEncryptedArtifact(row: EncryptedArtifactRow): Promise<{
    bytes: Buffer;
    sha256: string;
    sizeBytes: number;
    logicalFacts: 'plaintext' | 'gateway-ciphertext-row';
    storedObject: { sha256: string; sizeBytes: number };
    sidecar: { sha256: string; sizeBytes: number };
  }> {
    if (!encryption || !row.uploadToken || !row.storageVersionId || row.storageVersionId === 'null'
      || !row.manifestVersionId || row.manifestVersionId === 'null' || !row.sha256) {
      throw storageErrorToHttp(new ArtifactStorageError('ENCRYPTION_REQUIRED'));
    }
    const expectedCiphertextSize = Number(row.sizeBytes);
    if (!Number.isSafeInteger(expectedCiphertextSize) || expectedCiphertextSize < 1) {
      throw conflict('STATE_CONFLICT', 'artifact ciphertext integrity metadata is invalid');
    }
    const objectStore = storageFor(row.storageBackend, row.storageGenerationId);
    const expectedManifestKey = manifestKeyFor(row.storageKey);
    let loadedManifest: unknown;
    const loadedManifestBytes: { value: Buffer | null } = { value: null };
    const loadedObjectBytes: { value: Buffer | null } = { value: null };
    let manifestLoaded = false;
    const reader = {
      async head(storageKey: string, versionId?: string) {
        if (storageKey !== row.storageKey || versionId !== row.storageVersionId) return null;
        // The standard artifact reader expects object identity metadata. This
        // facade has no HEAD metadata port, so derive those identity fields
        // from the tenant-owned row and its exact-version sidecar; the reader
        // still authenticates the wrapper's identity, ciphertext digest and
        // crypto AAD against the same immutable row pins.
        await this.readManifest(expectedManifestKey, row.manifestVersionId ?? undefined);
        return {
          [ENCRYPTED_OBJECT_MARKER]: ENCRYPTED_OBJECT_MARKER_VALUE,
          [MANIFEST_KEY_METADATA]: expectedManifestKey,
          artifactid: row.id,
          tenantid: row.tenantId,
        };
      },
      async read(storageKey: string, versionId?: string): Promise<Buffer> {
        if (storageKey !== row.storageKey || versionId !== row.storageVersionId) {
          throw new ArtifactStorageError('ARTIFACT_METADATA_MISMATCH');
        }
        loadedObjectBytes.value = await collectReadable(await objectStore.openRead({ objectKey: row.storageKey, versionId: row.storageVersionId! }), maxArtifactBytes);
        return loadedObjectBytes.value;
      },
      async readManifest(manifestKey: string, versionId?: string): Promise<unknown> {
        if (manifestKey !== expectedManifestKey || versionId !== row.manifestVersionId) {
          throw new ArtifactStorageError('ARTIFACT_METADATA_MISMATCH');
        }
        if (manifestLoaded) return loadedManifest;
        const bytes = await collectReadable(await objectStore.openRead({ objectKey: expectedManifestKey, versionId: row.manifestVersionId! }), 1024 * 1024);
        loadedManifestBytes.value = bytes;
        try { loadedManifest = JSON.parse(bytes.toString('utf8')) as unknown; }
        catch { throw new ArtifactStorageError('ENVELOPE_INVALID'); }
        manifestLoaded = true;
        return loadedManifest;
      },
    };
    const sealedRef = {
      artifactId: row.id,
      tenantId: row.tenantId,
      storageKey: row.storageKey,
      uploadToken: row.uploadToken,
      manifestVersionId: row.manifestVersionId,
      storageVersionId: row.storageVersionId,
      ciphertextSha256: row.sha256,
      ciphertextSizeBytes: expectedCiphertextSize,
    };
    const opened = await decryptStoredArtifact({ reader, facade: encryption.facade, encryptionRequired: true }, sealedRef);
    if (!opened.decrypted) throw storageErrorToHttp(new ArtifactStorageError('ENVELOPE_INVALID'));
    if (!loadedObjectBytes.value || !loadedManifestBytes.value) throw storageErrorToHttp(new ArtifactStorageError('ENVELOPE_INVALID'));
    const logicalSha256 = createHash('sha256').update(opened.bytes).digest('hex');
    const logicalSizeBytes = opened.bytes.byteLength;
    const wrapper = loadedManifest && typeof loadedManifest === 'object' && !Array.isArray(loadedManifest)
      ? loadedManifest as Record<string, unknown>
      : null;
    const gatewayWrapped = wrapper !== null && ('encryption' in wrapper || 'kind' in wrapper || 'artifactId' in wrapper);
    if (gatewayWrapped) {
      // Public encrypted uploads intentionally persist ciphertext integrity in
      // artifacts.sha256/size_bytes. decryptStoredArtifact has already checked
      // those exact physical facts against the v1 wrapper and authenticated
      // the plaintext digest in the crypto manifest. Do not compare the
      // logical plaintext digest to the historical ciphertext column.
      return {
        bytes: opened.bytes, sha256: logicalSha256, sizeBytes: logicalSizeBytes, logicalFacts: 'gateway-ciphertext-row',
        storedObject: { sha256: createHash('sha256').update(loadedObjectBytes.value).digest('hex'), sizeBytes: loadedObjectBytes.value.byteLength },
        sidecar: { sha256: createHash('sha256').update(loadedManifestBytes.value).digest('hex'), sizeBytes: loadedManifestBytes.value.byteLength },
      };
    }
    if (logicalSizeBytes !== expectedCiphertextSize || logicalSha256 !== row.sha256.toLowerCase()) {
      throw storageErrorToHttp(new ArtifactStorageError('CHECKSUM_MISMATCH'));
    }
    return {
      bytes: opened.bytes, sha256: logicalSha256, sizeBytes: logicalSizeBytes, logicalFacts: 'plaintext',
      storedObject: { sha256: createHash('sha256').update(loadedObjectBytes.value).digest('hex'), sizeBytes: loadedObjectBytes.value.byteLength },
      sidecar: { sha256: createHash('sha256').update(loadedManifestBytes.value).digest('hex'), sizeBytes: loadedManifestBytes.value.byteLength },
    };
  }

  async function storageForNewWrites(): Promise<{
    backend: string;
    generationId: string | null;
    facade: ArtifactStorageFacade;
    urlTtlSeconds: number | null;
  }> {
    if (options.storageGenerations) {
      const active = await options.storageGenerations.current();
      return {
        backend: active.backend,
        generationId: active.generationId,
        facade: options.storageGenerations.forGeneration(active.generationId),
        urlTtlSeconds: active.urlTtlSeconds,
      };
    }
    return { backend: storageBackend, generationId: null, facade: storageFor(storageBackend), urlTtlSeconds: null };
  }

  function uploadGrantTtlMs(urlTtlSeconds: number | null): number {
    if (urlTtlSeconds === null) return GRANT_TTL_MS;
    if (!Number.isSafeInteger(urlTtlSeconds) || urlTtlSeconds < 1 || urlTtlSeconds > 86_400) {
      throw unavailable('storage generation presigned URL TTL is invalid');
    }
    return urlTtlSeconds * 1000;
  }

  interface PublicArtifactCleanupRow {
    id: string;
    tenantId: string;
    storageKey: string;
    storageBackend: string;
    storageGenerationId: string | null;
    storageVersionId: string | null;
    manifestVersionId: string | null;
  }

  async function claimPublicArtifactCleanup(tenantId: string, artifactId: string): Promise<PublicArtifactCleanupRow | null> {
    return db.tx(async (client) => {
      const selected = await client.query<PublicArtifactCleanupRow & { state: string; abortReason: string | null }>(
        `SELECT id, tenant_id AS "tenantId", storage_key AS "storageKey", storage_backend AS "storageBackend",
                storage_generation_id AS "storageGenerationId",
                storage_version_id AS "storageVersionId", manifest_version_id AS "manifestVersionId",
                state, abort_reason AS "abortReason"
         FROM artifacts
         WHERE id=$1 AND tenant_id=$2 AND purpose='input' AND operation_id IS NULL AND task_id IS NULL
           AND part_count IS NULL
         FOR UPDATE`,
        [artifactId, tenantId],
      );
      if (!selected.rowCount) return null;
      const row = selected.rows[0]!;
      if (row.state === 'ABORTED' && row.abortReason === 'failed') return row;
      if (row.state !== 'READY') return null;

      // This reference check is a separate statement after the row lock. A
      // submission takes FOR SHARE on the same artifact row before inserting
      // its operation; after waiting for either lock, READ COMMITTED sees the
      // winner's committed reference state.
      const references = await client.query<{ linked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM operations o
           WHERE o.tenant_id=$1
             AND COALESCE(o.submit_artifacts, '[]'::jsonb) @>
                 jsonb_build_array(jsonb_build_object('artifactId', $2::text))
         ) AS linked`,
        [tenantId, artifactId],
      );
      if ((references.rows[0] as { linked?: unknown } | undefined)?.linked === true) return null;

      const marked = await client.query(
        `UPDATE artifacts SET state='ABORTED', abort_reason='failed'
         WHERE id=$1 AND tenant_id=$2 AND purpose='input' AND state='READY'
           AND operation_id IS NULL AND task_id IS NULL AND part_count IS NULL`,
        [artifactId, tenantId],
      );
      return marked.rowCount ? row : null;
    });
  }

  async function finishPublicArtifactCleanup(row: PublicArtifactCleanupRow): Promise<boolean> {
    if (!row.storageKey) return false;
    if (row.storageBackend === 'postgres') {
      const removeOwnedBlob = async (storageKey: string): Promise<boolean> => {
        // Both the ciphertext key and its derived sidecar key are unique to
        // this artifact. The row/tenant/ABORTED fence prevents this fallback
        // from deleting a key after ownership or linkage changed.
        const removedBlob = await db.query(
          `DELETE FROM artifact_blobs b
           WHERE b.storage_key=$1 AND b.tenant_id=$2
             AND EXISTS (SELECT 1 FROM artifacts a
                         WHERE a.id=$3 AND a.tenant_id=$2 AND a.state='ABORTED'
                           AND a.abort_reason='failed' AND a.operation_id IS NULL AND a.task_id IS NULL)`,
          [storageKey, row.tenantId, row.id],
        ).catch(() => null);
        return removedBlob !== null;
      };
      const store = storageFor(row.storageBackend, row.storageGenerationId);
      try {
        if (!row.storageVersionId || row.storageVersionId === 'null') {
          throw new ArtifactStorageError('OBJECT_VERSION_REQUIRED');
        }
        await store.delete({ objectKey: row.storageKey, versionId: row.storageVersionId });
      } catch {
        // PostgreSQL stores one immutable blob per unique artifact key. On a
        // missing/bad digest, remove the bytes by that fenced unique key.
        if (!await removeOwnedBlob(row.storageKey)) return false;
      }
      const sidecarKey = manifestKeyFor(row.storageKey);
      try {
        if (!row.manifestVersionId || row.manifestVersionId === 'null') {
          throw new ArtifactStorageError('OBJECT_VERSION_REQUIRED');
        }
        await store.delete({ objectKey: sidecarKey, versionId: row.manifestVersionId });
      } catch {
        // Sealed artifacts have a second physical object. It is cleaned with
        // the same owner fence; otherwise an admission rollback would leave a
        // durable encrypted sidecar after its artifact row was removed.
        if (!await removeOwnedBlob(sidecarKey)) return false;
      }
    } else {
      // S3 data and encrypted sidecars are removed by exact pinned versions.
      // No unversioned/latest delete is allowed. Current public inline uploads
      // fail before S3 writes; if a future versioned writer reaches this path
      // without a version pin, retain the cleanup row for the storage GC.
      if (!row.storageVersionId || row.storageVersionId === 'null') return false;
      try {
        const store = storageFor(row.storageBackend, row.storageGenerationId);
        await store.delete({ objectKey: row.storageKey, versionId: row.storageVersionId });
        if (row.manifestVersionId) {
          await store.delete({ objectKey: manifestKeyFor(row.storageKey), versionId: row.manifestVersionId });
        }
      } catch {
        return false;
      }
    }

    const removed = await db.tx(async (client) => {
      const references = await client.query<{ linked: boolean }>(
        `SELECT EXISTS (
           SELECT 1 FROM operations o
           WHERE o.tenant_id=$1
             AND COALESCE(o.submit_artifacts, '[]'::jsonb) @>
                 jsonb_build_array(jsonb_build_object('artifactId', $2::text))
         ) AS linked`,
        [row.tenantId, row.id],
      );
      if ((references.rows[0] as { linked?: unknown } | undefined)?.linked === true) return false;
      const deleted = await client.query(
        `DELETE FROM artifacts
         WHERE id=$1 AND tenant_id=$2 AND purpose='input' AND state='ABORTED'
           AND abort_reason='failed' AND operation_id IS NULL AND task_id IS NULL AND part_count IS NULL`,
        [row.id, row.tenantId],
      );
      return Boolean(deleted.rowCount);
    });
    return removed;
  }

  async function compensatePublicArtifact(tenantId: string, artifactId: string): Promise<boolean> {
    const claimed = await claimPublicArtifactCleanup(tenantId, artifactId);
    return claimed === null ? false : finishPublicArtifactCleanup(claimed);
  }

  /**
   * SEC-ENC-04: the sealed worker upload path is server-mediated, so the S3
   * presigned grant is never minted when encryption is configured. Returning
   * the tokenized proxy URL keeps the single-PUT wire shape unchanged while
   * ensuring the only writer is this service.
   */
  function serverMediatedUploadGrant(proxyUrl: string, expiresAt: string): ArtifactStorageUploadGrant {
    return { url: proxyUrl, expiresAt };
  }

  async function assertLease(taskId: string, leaseEpoch: number) {
    const res = await db.query(
      `SELECT t.lease_epoch, t.operation_id, o.tenant_id,
              (t.lease_expires_at IS NOT NULL AND t.lease_expires_at > now()) AS lease_active
       FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1`,
      [taskId]
    );
    if (!res.rowCount) throw notFound(`task ${taskId} not found`);
    const row = res.rows[0] as {
      lease_epoch: number;
      operation_id: string;
      tenant_id: string;
      lease_active: boolean;
    };
    if (row.lease_epoch !== leaseEpoch) {
      throw conflict('LEASE_LOST', `stale leaseEpoch ${leaseEpoch}, current ${row.lease_epoch}`);
    }
    if (!row.lease_active) {
      throw conflict('LEASE_LOST', `lease has expired for task ${taskId}`);
    }
    return row;
  }

  return {
    async requestUpload(taskId, leaseEpoch, body): Promise<ArtifactUploadGrant> {
      const lease = await assertLease(taskId, leaseEpoch);
      const parsed = ArtifactUploadGrantRequestSchema.safeParse(body);
      if (!parsed.success) throw unprocessable('INVALID_SCHEMA', 'artifact upload grant request failed', {
        errors: parsed.error.issues.slice(0, 20).map((i) => ({ pointer: '/' + i.path.join('/'), message: i.message })),
      });
      const req = parsed.data;
      if (req.sizeBytes > maxArtifactBytes) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the configured size limit');
      }
      const artifactId = randomUUID();
      const storageKey = `art-${artifactId}`;
      const storage = await storageForNewWrites();
      const token = randomUUID();
      // CR-12: the grant is method-scoped (upload) with a STORED expiry. The
      // blob route enforces both, so this token can never GET and dies on
      // time even if the advertised `expiresAt` is ignored by the caller.
      const directUrlTtl = !encryption && storage.backend === 's3' ? storage.urlTtlSeconds : null;
      const expiresAt = new Date(Date.now() + uploadGrantTtlMs(directUrlTtl)).toISOString();
      const proxyUrl = `/api/runtime/v1/artifacts/blob/${encodeURIComponent(storageKey)}?grant=${token}`;
      // SEC-ENC-04: when sealing is configured the object version and the
      // server-mediated proxy URL are pinned at admission. No direct backend
      // grant is minted, so bytes cannot reach storage around the seal.
      const objectVersion = encryption ? randomUUID() : null;
      let storageGrant: ArtifactStorageUploadGrant;
      if (encryption) {
        storageGrant = serverMediatedUploadGrant(proxyUrl, expiresAt);
      } else {
        try {
          storageGrant = await storage.facade.createUploadGrant({
            artifactId,
            tenantId: lease.tenant_id,
            objectKey: storageKey,
            contentType: req.mimeType,
            maxBytes: req.sizeBytes,
            expiresAt,
            proxyUrl,
          });
        } catch (error) {
          throw storageErrorToHttp(error);
        }
      }
      if (objectVersion) {
        await db.query(
          `INSERT INTO artifacts (id, tenant_id, operation_id, task_id, purpose, file_name, mime_type, size_bytes, state,
                                  token, token_mode, token_expires_at, storage_key, storage_backend, storage_generation_id, upload_token)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'STAGING',$9,'upload',$10,$11,$12,$13,$14)`,
          [artifactId, lease.tenant_id, lease.operation_id, taskId, req.purpose, req.fileName ?? null, req.mimeType, req.sizeBytes,
            token, expiresAt, storageKey, storage.backend, storage.generationId, objectVersion]
        );
      } else {
        await db.query(
          `INSERT INTO artifacts (id, tenant_id, operation_id, task_id, purpose, file_name, mime_type, size_bytes, state,
                                  token, token_mode, token_expires_at, storage_key, storage_backend, storage_generation_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'STAGING',$9,'upload',$10,$11,$12,$13)`,
          [artifactId, lease.tenant_id, lease.operation_id, taskId, req.purpose, req.fileName ?? null, req.mimeType, req.sizeBytes,
            token, expiresAt, storageKey, storage.backend, storage.generationId]
        );
      }
      return {
        artifactId,
        uploadUrl: storageGrant.url,
        expiresAt,
        ...(encryption ? { storageEncryption: 'server' as const } : {}),
      };
    },

    // A producer must prove its task and lease epoch. Locking that task row
    // makes the state/epoch check atomic with cancellation and lease takeover.
    // The artifact row is then locked in the same transaction as the blob
    // hash check and READY transition; putBlob takes the same artifact lock,
    // so an upload that races finalization either completes first and is
    // hash-checked, or observes READY and is rejected.
    async finalize(artifactId, body): Promise<{ artifactId: string; state: string }> {
      const parsed = ArtifactFinalizeRequestSchema.safeParse(body);
      if (!parsed.success) throw unprocessable('INVALID_SCHEMA', 'artifact finalize failed', {
        errors: parsed.error.issues.slice(0, 20).map((i) => ({ pointer: '/' + i.path.join('/'), message: i.message })),
      });
      const req = parsed.data;
      // Above BOTH branch ceilings there is nothing to look up: reject before
      // touching storage. A multipart row is capped by the size it declared
      // at init (already policy-checked there), so its cap is taken below,
      // where the row and its branch are known.
      if (req.sizeBytes > Math.max(maxArtifactBytes, MULTIPART_MAX_TOTAL_BYTES)) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the configured size limit');
      }
      return db.tx(async (client) => {
        const taskRes = await client.query(
          `SELECT lease_epoch, state, operation_id,
                  (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
           FROM tasks WHERE id=$1 FOR UPDATE`,
          [req.taskId]
        );
        if (!taskRes.rowCount) throw notFound(`task ${req.taskId} not found`);
        const task = taskRes.rows[0] as {
          lease_epoch: number;
          state: string;
          operation_id: string;
          lease_active: boolean;
        };

        const artifactRes = await client.query(
          `SELECT tenant_id AS "tenantId", operation_id AS "operationId", storage_key AS "storageKey", storage_backend AS "storageBackend",
                  storage_generation_id AS "storageGenerationId",
                  storage_version_id AS "storageVersionId", state,
                  task_id AS "taskId", size_bytes AS "sizeBytes", sha256,
                  upload_token AS "uploadToken", manifest_version_id AS "manifestVersionId",
                  finalized_lease_epoch AS "finalizedLeaseEpoch",
                  part_count AS "partCount"
           FROM artifacts WHERE id=$1 FOR UPDATE`,
          [artifactId]
        );
        if (!artifactRes.rowCount) throw notFound(`artifact ${artifactId} not found`);
        const art = artifactRes.rows[0] as {
          tenantId: string;
          operationId: string | null;
          storageKey: string;
          storageBackend?: string;
          storageGenerationId?: string | null;
          storageVersionId?: string | null;
          state: string;
          taskId: string;
          sizeBytes: number | string | null;
          sha256: string | null;
          uploadToken?: string | null;
          manifestVersionId?: string | null;
          finalizedLeaseEpoch: number | null;
          /** Non-null only on the multipart branch, where it bounds the cap. */
          partCount?: number | string | null;
        };
        if (art.operationId && task.operation_id && art.operationId !== task.operation_id) {
          throw conflict('PERMISSION_DENIED', 'task cannot finalize artifact of different operation');
        }
        if (art.state === 'READY') {
          if (
            art.taskId === req.taskId &&
            art.finalizedLeaseEpoch === req.leaseEpoch &&
            art.sha256 === req.sha256 &&
            Number(art.sizeBytes) === req.sizeBytes
          ) {
            // A prior finalize committed but its response may have been lost.
            // The persisted producer epoch and metadata make this replay safe
            // even if the task has since completed or its lease expired.
            return { artifactId, state: 'READY' };
          }
          throw conflict('STATE_CONFLICT', 'artifact is READY with different producer or metadata');
        }
        if (art.taskId !== req.taskId) {
          throw forbidden('artifact does not belong to task');
        }
        if (task.lease_epoch !== req.leaseEpoch || !task.lease_active) {
          if (task.lease_epoch !== req.leaseEpoch) {
            throw conflict('LEASE_LOST', 'producer lease epoch is stale');
          }
          throw forbidden('producer lease has expired');
        }
        if (task.state !== 'RUNNING') {
          throw conflict('STATE_CONFLICT', 'producer task is not RUNNING');
        }
        if (art.state !== 'STAGING') {
          throw conflict('STATE_CONFLICT', 'artifact is not STAGING and cannot be finalized');
        }
        // A multipart row was sized and admitted by `init`; its own declared
        // byte count is the cap here, never the single-PUT limit.
        const admissionCap = art.partCount == null
          ? maxArtifactBytes
          : Math.max(maxArtifactBytes, Number(art.sizeBytes ?? 0));
        if (req.sizeBytes > admissionCap) {
          throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the configured size limit');
        }

        const artifactBackend = art.storageBackend ?? 'postgres';
        const verificationStorage = artifactBackend === 'postgres'
          ? createPostgresArtifactStorageFacade({
              async read(storageKey) {
                const blob = await client.query<{ bytes: Buffer }>(
                  'SELECT bytes FROM artifact_blobs WHERE storage_key=$1',
                  [storageKey],
                );
                return blob.rowCount ? Buffer.from(blob.rows[0]!.bytes) : null;
              },
              async delete(storageKey) {
                await client.query('DELETE FROM artifact_blobs WHERE storage_key=$1', [storageKey]);
              },
            })
          : storageFor(artifactBackend, art.storageGenerationId);

        const finishFinalize = async (finalized: {
          rowCount: number | null;
          rows: unknown[];
        }): Promise<{ artifactId: string; state: string }> => {
          if (!finalized.rowCount) {
            // The task lock prevents cancel/takeover during this transaction;
            // the UPDATE predicate also checks lease expiry at the commit edge.
            const currentTaskRes = await client.query(
              `SELECT lease_epoch, state,
                      (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
               FROM tasks WHERE id=$1`,
              [req.taskId]
            );
            const currentTask = currentTaskRes.rows[0] as {
              lease_epoch: number;
              state: string;
              lease_active: boolean;
            } | undefined;
            if (!currentTask || currentTask.lease_epoch !== req.leaseEpoch) {
              throw conflict('LEASE_LOST', 'producer lease epoch changed before finalization');
            }
            if (!currentTask.lease_active) {
              throw forbidden('producer lease expired before finalization');
            }
            if (currentTask.state !== 'RUNNING') {
              throw conflict('STATE_CONFLICT', 'producer task is not RUNNING');
            }
            throw conflict('STATE_CONFLICT', 'artifact changed before finalization');
          }
          return { artifactId, state: (finalized.rows[0] as { state: string }).state };
        };

        // SEC-ENC-04: a sealed worker artifact is verified against its
        // authenticated envelope. The finalize request carries PLAINTEXT
        // business metadata; storage holds ciphertext whose pinned version and
        // hash stay separate from the plaintext sha/size committed to the row.
        if (encryption && art.uploadToken) {
          if (!art.storageVersionId) {
            throw storageErrorToHttp(new ArtifactStorageError('ENCRYPTION_REQUIRED'));
          }
          const manifestKey = manifestKeyFor(art.storageKey);
          let sidecarBytes: Buffer;
          try {
            if (!art.manifestVersionId || art.manifestVersionId === 'null') {
              throw new ArtifactStorageError('ENCRYPTION_REQUIRED');
            }
            sidecarBytes = await collectReadable(await verificationStorage.openRead({
              objectKey: manifestKey,
              versionId: art.manifestVersionId,
            }), 1024 * 1024);
          } catch (error) {
            if (error instanceof ArtifactStorageError && ['OBJECT_NOT_FOUND', 'ENCRYPTION_REQUIRED'].includes(error.code)) {
              throw storageErrorToHttp(new ArtifactStorageError('ENCRYPTION_REQUIRED'));
            }
            throw storageErrorToHttp(error);
          }
          const identity: WorkerArtifactIdentity = {
            tenantId: art.tenantId,
            artifactId,
            objectVersion: art.uploadToken,
          };
          let parsed: ParsedWorkerArtifactSidecar;
          try {
            parsed = parseWorkerArtifactSidecar(JSON.parse(sidecarBytes.toString('utf8')) as unknown);
          } catch (error) {
            throw storageErrorToHttp(error);
          }
          let verified: { plaintextSha256: string; plaintextSizeBytes: number };
          try {
            const ciphertext = await collectReadable(await verificationStorage.openRead({
              objectKey: art.storageKey,
              versionId: art.storageVersionId,
            }), maxArtifactBytes);
            verified = await verifyWorkerArtifact({
              sidecar: parsed,
              ciphertext,
              context: artifactEncryptionContext(identity),
              seam: encryption,
            });
          } catch (error) {
            throw storageErrorToHttp(error);
          }
          if (verified.plaintextSizeBytes !== req.sizeBytes) {
            throw storageErrorToHttp(new ArtifactStorageError('SIZE_MISMATCH'));
          }
          if (verified.plaintextSha256 !== req.sha256) {
            throw storageErrorToHttp(new ArtifactStorageError('CHECKSUM_MISMATCH'));
          }
          const sealedFinalized = await client.query(
            `UPDATE artifacts SET state='READY', size_bytes=$2, sha256=$3,
                                  finalized_lease_epoch=$5, storage_version_id=$6,
                                  manifest_version_id=COALESCE(manifest_version_id,$7)
             WHERE id=$1 AND task_id=$4 AND state='STAGING'
               AND EXISTS (
                 SELECT 1 FROM tasks t
                 WHERE t.id=$4 AND t.lease_epoch=$5 AND t.state='RUNNING'
                   AND t.lease_expires_at > now()
               )
             RETURNING id, state`,
            [artifactId, verified.plaintextSizeBytes, verified.plaintextSha256,
              req.taskId, req.leaseEpoch, art.storageVersionId, art.manifestVersionId ?? null]
          );
          return finishFinalize(sealedFinalized);
        }
        if (encryption && encryptionRequired && !art.uploadToken) {
          // Strict deployment: a row admitted without the sealed carrier must
          // not become READY, even if its raw bytes still verify as plaintext.
          throw storageErrorToHttp(new ArtifactStorageError('ENCRYPTION_REQUIRED'));
        }

        let pinned: StoredArtifactVersion;
        try {
          pinned = await verificationStorage.verifyAndPin({
            artifactId,
            tenantId: art.tenantId,
            objectKey: art.storageKey,
            expectedSizeBytes: req.sizeBytes,
            expectedSha256: req.sha256,
          });
        } catch (error) {
          throw storageErrorToHttp(error);
        }
        if (
          pinned.objectKey !== art.storageKey ||
          !pinned.versionId ||
          pinned.versionId === 'null' ||
          pinned.sizeBytes !== req.sizeBytes ||
          pinned.sha256 !== req.sha256
        ) {
          throw storageErrorToHttp(new ArtifactStorageError('CHECKSUM_MISMATCH'));
        }
        const finalized = await client.query(
          `UPDATE artifacts SET state='READY', size_bytes=$2, sha256=$3,
                                finalized_lease_epoch=$5, storage_version_id=$6
           WHERE id=$1 AND task_id=$4 AND state='STAGING'
             AND EXISTS (
               SELECT 1 FROM tasks t
               WHERE t.id=$4 AND t.lease_epoch=$5 AND t.state='RUNNING'
                 AND t.lease_expires_at > now()
             )
           RETURNING id, state`,
          [artifactId, pinned.sizeBytes, pinned.sha256, req.taskId, req.leaseEpoch, pinned.versionId]
        );
        return finishFinalize(finalized);
      });
    },

    async requestAccess(artifactId, body): Promise<ArtifactAccessGrant> {
      const parsed = ArtifactAccessRequestSchema.safeParse(body);
      if (!parsed.success) throw unprocessable('INVALID_SCHEMA', 'artifact access request failed', {
        errors: parsed.error.issues.slice(0, 20).map((i) => ({ pointer: '/' + i.path.join('/'), message: i.message })),
      });
      const req = parsed.data;
      return db.tx(async (client) => {
        // Lock the requester first, matching finalize's task -> artifact lock
        // order. This makes lease/state authorization atomic with grant minting.
        const taskRes = await client.query(
          `SELECT t.lease_epoch, t.state, t.operation_id AS "operationId",
                  o.tenant_id AS "tenantId", o.submit_artifacts AS "submitArtifacts",
                  (t.lease_expires_at IS NOT NULL AND t.lease_expires_at > now()) AS lease_active
           FROM tasks t JOIN operations o ON o.id = t.operation_id
           WHERE t.id=$1 FOR UPDATE OF t`,
          [req.taskId]
        );
        if (!taskRes.rowCount) throw notFound(`task ${req.taskId} not found`);
        const task = taskRes.rows[0] as {
          lease_epoch: number;
          state: string;
          operationId: string;
          tenantId: string;
          submitArtifacts: unknown;
          lease_active: boolean;
        };
        if (task.lease_epoch !== req.leaseEpoch) {
          throw conflict('LEASE_LOST', 'requester lease epoch is stale');
        }
        if (!task.lease_active) throw conflict('LEASE_LOST', 'requester lease has expired');
        if (task.state !== 'RUNNING') {
          throw conflict('STATE_CONFLICT', 'requester task is not RUNNING');
        }

        const artifactRes = await client.query(
          `SELECT tenant_id AS "tenantId", operation_id AS "operationId",
                  storage_key AS "storageKey", storage_backend AS "storageBackend",
                  storage_generation_id AS "storageGenerationId",
                  storage_version_id AS "storageVersionId", file_name AS "fileName", mime_type AS "mimeType",
                  size_bytes AS "sizeBytes", sha256,
                  state, task_id AS "taskId", purpose
            FROM artifacts WHERE id=$1 FOR UPDATE`,
          [artifactId]
        );
        if (!artifactRes.rowCount) throw notFound(`artifact ${artifactId} not found`);
        const art = artifactRes.rows[0] as {
          tenantId: string;
          operationId: string | null;
          storageKey: string;
          storageBackend?: string;
          storageGenerationId?: string | null;
          storageVersionId?: string | null;
          fileName?: string | null;
          mimeType?: string;
          sizeBytes?: number | string | null;
          sha256?: string | null;
          state: string;
          taskId: string | null;
          purpose: string;
        };
        if (art.state === 'DELETED') throw conflict('STATE_CONFLICT', 'artifact deleted');

        const sameTenant = art.tenantId === task.tenantId;
        const sameOperation = sameTenant && art.operationId === task.operationId;
        let readVersionId: string | undefined;
        if (req.mode === 'read') {
          // Parent and child tasks share an operation id. Cross-operation reads
          // require an exact submit_artifacts reference from this operation;
          // only public-purpose refs can cross this boundary. Intermediate and
          // session artifacts remain operation-internal checkpoints.
          const declaredReference =
            sameTenant &&
            isPublicArtifactPurpose(art.purpose) &&
            hasDeclaredArtifactReference(task.submitArtifacts, artifactId);
          if (!sameOperation && !declaredReference) {
            throw conflict('PERMISSION_DENIED', 'task is not authorized to read artifact');
          }
          if (art.taskId !== req.taskId && art.state !== 'READY') {
            throw conflict('PERMISSION_DENIED', 'foreign task cannot access unready artifact');
          }
          if (art.state !== 'READY') throw conflict('STATE_CONFLICT', 'artifact is not READY');
          readVersionId = art.storageVersionId ??
            ((art.storageBackend ?? 'postgres') === 'postgres' ? art.sha256 ?? undefined : undefined);
          if (
            !readVersionId ||
            ((art.storageBackend ?? 'postgres') === 's3' && readVersionId === 'null') ||
            !art.sha256 ||
            art.sizeBytes === null ||
            art.sizeBytes === undefined
          ) {
            throw conflict('STATE_CONFLICT', 'artifact has no immutable version and integrity metadata');
          }
        } else {
          // Write grants remain producer-scoped even when another task shares
          // the operation; STAGING is the only mutable artifact state.
          if (!sameTenant || art.operationId !== task.operationId || art.taskId !== req.taskId) {
            throw conflict('PERMISSION_DENIED', 'task is not authorized to write artifact');
          }
          if (art.state !== 'STAGING') {
            throw conflict('STATE_CONFLICT', 'artifact is not STAGING');
          }
        }

        const token = randomUUID();
        // CR-12: store method scope and expiry in the same transaction as the
        // authorization decision, before returning a storage-facade URL.
        const directUrlTtl = req.mode === 'write' && !encryption && art.storageBackend === 's3'
          && art.storageGenerationId && options.storageGenerations
          ? await options.storageGenerations.presignedUrlTtlSeconds(art.storageGenerationId)
          : null;
        const expiresAt = new Date(Date.now() + uploadGrantTtlMs(directUrlTtl)).toISOString();
        const scope = req.mode === 'read' ? 'download' : 'upload';
        await client.query(
          'UPDATE artifacts SET token=$2, token_mode=$3, token_expires_at=$4 WHERE id=$1',
          [artifactId, token, scope, expiresAt]
        );
        const grant: ArtifactAccessGrant = { artifactId, expiresAt };
        if (req.mode === 'read') {
          grant.downloadUrl = proxyBlobUrl(art.storageKey, token);
          grant.fileName = art.fileName ?? undefined;
          grant.mimeType = art.mimeType;
          grant.sizeBytes = art.sizeBytes === null || art.sizeBytes === undefined
            ? undefined
            : Number(art.sizeBytes);
          grant.sha256 = art.sha256 ?? undefined;
          grant.storageVersionId = readVersionId;
        } else {
          if ((art.storageBackend ?? 'postgres') === 's3') {
            try {
              const s3Grant = await storageFor('s3', art.storageGenerationId).createUploadGrant({
                artifactId,
                tenantId: art.tenantId,
                objectKey: art.storageKey,
                contentType: art.mimeType ?? 'application/octet-stream',
                maxBytes: Number(art.sizeBytes ?? 0),
                expiresAt,
              });
              grant.uploadUrl = s3Grant.url;
            } catch (error) {
              throw storageErrorToHttp(error);
            }
          } else {
            grant.uploadUrl = proxyBlobUrl(art.storageKey, token);
          }
        }
        // NOTE: URL absolutization happens at the route layer (service has no host).
        return grant;
      });
    },

    // Serialize uploads with finalize by locking the artifact row through the
    // blob write. READY (and any other non-STAGING) rows are immutable.
    async putBlob(storageKey, tenantId, bytes): Promise<void> {
      await db.tx(async (client) => {
        const cur = await client.query(
          `SELECT a.id, a.state, a.storage_backend AS "storageBackend", a.storage_generation_id AS "storageGenerationId", a.upload_token AS "uploadToken"
           FROM artifacts a
           WHERE a.storage_key=$1 AND a.tenant_id=$2 FOR UPDATE OF a`,
          [storageKey, tenantId]
        );
        if (!cur.rowCount) throw notFound('artifact upload target not found');
        const row = cur.rows[0] as {
          id: string;
          state: string;
          storageBackend?: string;
          storageGenerationId?: string | null;
          uploadToken: string | null;
        };
        const backend = row.storageBackend ?? 'postgres';
        if (row.state !== 'STAGING') {
          throw conflict('STATE_CONFLICT', 'artifact is not STAGING and its bytes are immutable');
        }
        if (encryption) {
          // SEC-ENC-04: the server seals before any byte reaches a store. A
          // row without its pinned object version cannot satisfy the policy.
          if (!row.uploadToken) {
            throw storageErrorToHttp(new ArtifactStorageError('ENCRYPTION_REQUIRED'));
          }
          const identity: WorkerArtifactIdentity = {
            tenantId,
            artifactId: row.id,
            objectVersion: row.uploadToken,
          };
          const sealed = await sealWorkerArtifact({ bytes, identity, seam: encryption });
          const manifestKey = manifestKeyFor(storageKey);
          let writtenCiphertextVersion: string | null = null;
          let writtenManifestVersion: string | null = null;
          try {
            if (backend === 'postgres') {
              await client.query(
                `INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
                 ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`,
                [storageKey, tenantId, sealed.ciphertext],
              );
              writtenCiphertextVersion = sealed.ciphertextSha256;
              await client.query(
                `INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
                 ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`,
                [manifestKey, tenantId, sealed.sidecar],
              );
              writtenManifestVersion = createHash('sha256').update(sealed.sidecar).digest('hex');
            } else {
              const writer = storageFor(backend, row.storageGenerationId);
              if (typeof writer.putServerObject !== 'function') {
                throw new ArtifactStorageError('ENCRYPTION_UNAVAILABLE');
              }
              writtenCiphertextVersion = (await writer.putServerObject({
                objectKey: storageKey,
                tenantId,
                body: sealed.ciphertext,
                contentType: ARTIFACT_CIPHERTEXT_CONTENT_TYPE,
                metadata: sealedObjectMetadata({ artifactId: row.id, tenantId, manifestKey }),
              })).versionId;
              writtenManifestVersion = (await writer.putServerObject({
                objectKey: manifestKey,
                tenantId,
                body: sealed.sidecar,
                contentType: ARTIFACT_SIDECAR_CONTENT_TYPE,
                metadata: manifestObjectMetadata({ artifactId: row.id, tenantId }),
              })).versionId;
            }
            await client.query(
              `UPDATE artifacts SET storage_version_id=$2, manifest_version_id=$3
               WHERE id=$1 AND state='STAGING'`,
              [row.id, writtenCiphertextVersion ?? null, writtenManifestVersion ?? null],
            );
          } catch (error) {
            if (backend !== 'postgres') {
              const cleanupStore = storageFor(backend, row.storageGenerationId);
              // Best-effort orphan cleanup; the row stays STAGING and the
              // recovery sweeper owns anything left behind.
              if (writtenManifestVersion) {
                await cleanupStore.delete({ objectKey: manifestKey, versionId: writtenManifestVersion }).catch(() => undefined);
              }
              if (writtenCiphertextVersion) {
                await cleanupStore.delete({ objectKey: storageKey, versionId: writtenCiphertextVersion }).catch(() => undefined);
              }
            }
            throw storageErrorToHttp(error);
          }
          return;
        }
        if (backend !== 'postgres') {
          throw conflict('STATE_CONFLICT', 'S3 uploads must use the issued storage grant');
        }
        await client.query(
          `INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
           ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`,
          [storageKey, tenantId, bytes]
        );
      });
    },


    async putPublicArtifact(input) {
      const selectedStorage = await storageForNewWrites();
      if (input.requireEncryption) {
        // This check is intentionally before writePublicArtifact inserts its
        // STAGING row. `encryption` is the same server-mediated worker
        // artifact seam used for ciphertext and sidecar storage.
        if (!encryption) throw unavailable('encrypted workflow artifact storage is not configured');
        const writer = selectedStorage.facade;
        if (typeof writer.putServerObject !== 'function' || typeof writer.openRead !== 'function') {
          throw unavailable('encrypted workflow artifact storage is not available on this backend');
        }
      }
      return writePublicArtifact(
        {
          query: (sql, params) => db.query(sql, params as unknown[]),
          putBlob: async (storageKey, tenantId, bytes) => {
            // The legacy compatibility writer creates its STAGING row before
            // invoking this callback. Pin its immutable generation before the
            // first provider write so a concurrent activation cannot redirect
            // this artifact halfway through the upload.
            if (selectedStorage.generationId) {
              const pinned = await db.query(
                `UPDATE artifacts SET storage_generation_id=$3, storage_backend=$4
                 WHERE storage_key=$1 AND tenant_id=$2 AND state='STAGING'
                   AND purpose='input' AND operation_id IS NULL AND task_id IS NULL
                 RETURNING id`,
                [storageKey, tenantId, selectedStorage.generationId, selectedStorage.backend],
              );
              if (!pinned.rowCount) throw new ArtifactStorageError('ARTIFACT_METADATA_MISMATCH');
            }
            if (encryption) {
              const rowResult = await db.query<{ id: string; uploadToken: string | null }>(
                `SELECT id, upload_token AS "uploadToken" FROM artifacts
                 WHERE storage_key=$1 AND tenant_id=$2 AND state='STAGING'
                   AND purpose='input' AND operation_id IS NULL AND task_id IS NULL`,
                [storageKey, tenantId],
              );
              if (!rowResult.rowCount) throw new ArtifactStorageError('ARTIFACT_METADATA_MISMATCH');
              const row = rowResult.rows[0]!;
              if (!row.uploadToken) throw new ArtifactStorageError('ENCRYPTION_REQUIRED');
              const identity: WorkerArtifactIdentity = {
                tenantId,
                artifactId: row.id,
                objectVersion: row.uploadToken,
              };
              const sealed = await sealWorkerArtifact({ bytes, identity, seam: encryption });
              const manifestKey = manifestKeyFor(storageKey);
              const writer = selectedStorage.facade;
              if (typeof writer.putServerObject !== 'function') {
                throw new ArtifactStorageError('ENCRYPTION_UNAVAILABLE');
              }
              let ciphertextVersion: string | null = null;
              let sidecarVersion: string | null = null;
              try {
                ciphertextVersion = (await writer.putServerObject({
                  objectKey: storageKey,
                  tenantId,
                  body: sealed.ciphertext,
                  contentType: ARTIFACT_CIPHERTEXT_CONTENT_TYPE,
                  metadata: sealedObjectMetadata({ artifactId: row.id, tenantId, manifestKey }),
                })).versionId;
                const pinnedCiphertext = await db.query(
                  `UPDATE artifacts SET storage_version_id=$2
                   WHERE id=$1 AND tenant_id=$3 AND state='STAGING' AND upload_token=$4
                     AND purpose='input' AND operation_id IS NULL AND task_id IS NULL`,
                  [row.id, ciphertextVersion, tenantId, row.uploadToken],
                );
                if (!pinnedCiphertext.rowCount) throw new ArtifactStorageError('ARTIFACT_METADATA_MISMATCH');

                sidecarVersion = (await writer.putServerObject({
                  objectKey: manifestKey,
                  tenantId,
                  body: sealed.sidecar,
                  contentType: ARTIFACT_SIDECAR_CONTENT_TYPE,
                  metadata: manifestObjectMetadata({ artifactId: row.id, tenantId }),
                })).versionId;
                const pinnedSidecar = await db.query(
                  `UPDATE artifacts SET manifest_version_id=$2
                   WHERE id=$1 AND tenant_id=$3 AND state='STAGING' AND upload_token=$4
                     AND purpose='input' AND operation_id IS NULL AND task_id IS NULL`,
                  [row.id, sidecarVersion, tenantId, row.uploadToken],
                );
                if (!pinnedSidecar.rowCount) throw new ArtifactStorageError('ARTIFACT_METADATA_MISMATCH');
              } catch (error) {
                // Remove exact generations on the immediate path. If a delete
                // fails, persist those exact pins into the existing cleanup row.
                let ciphertextDeleted = ciphertextVersion === null;
                let sidecarDeleted = sidecarVersion === null;
                if (sidecarVersion) {
                  try {
                    await writer.delete({ objectKey: manifestKey, versionId: sidecarVersion });
                    sidecarDeleted = true;
                  } catch { /* retry through the durable artifact intent */ }
                }
                if (ciphertextVersion) {
                  try {
                    await writer.delete({ objectKey: storageKey, versionId: ciphertextVersion });
                    ciphertextDeleted = true;
                  } catch { /* retry through the durable artifact intent */ }
                }
                await db.query(
                  `UPDATE artifacts SET state='ABORTED', abort_reason='failed',
                                        storage_version_id=COALESCE($2, storage_version_id),
                                        manifest_version_id=COALESCE($3, manifest_version_id), expires_at=NULL
                   WHERE id=$1 AND tenant_id=$4 AND purpose='input'
                     AND operation_id IS NULL AND task_id IS NULL AND part_count IS NULL`,
                  [row.id, ciphertextDeleted ? null : ciphertextVersion,
                    sidecarDeleted ? null : sidecarVersion, tenantId],
                ).catch(() => undefined);
                throw storageErrorToHttp(error);
              }
              return;
            }

            // Unencrypted inline bytes have no server-mediated S3 upload path.
            // Keep them on the explicit PostgreSQL compatibility backend only.
            if (selectedStorage.backend !== 'postgres') {
              throw new HttpError(
                503,
                'TEMPORARY_UNAVAILABLE',
                'inline legacy uploads require encryption when using S3 storage',
              );
            }
            await db.query(
              `INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)` +
                ' ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()',
              [storageKey, tenantId, bytes],
            );
          },
          verifyAndPin: async (pin) => {
            if (!encryption) {
              try {
                return await selectedStorage.facade.verifyAndPin(pin);
              } catch (error) {
                throw storageErrorToHttp(error);
              }
            }
            try {
              const rowResult = await db.query<{
                id: string;
                uploadToken: string | null;
                storageVersionId: string | null;
                manifestVersionId: string | null;
              }>(
                `SELECT id, upload_token AS "uploadToken", storage_version_id AS "storageVersionId",
                        manifest_version_id AS "manifestVersionId"
                 FROM artifacts WHERE id=$1 AND tenant_id=$2 AND state='STAGING'
                   AND purpose='input' AND operation_id IS NULL AND task_id IS NULL`,
                [pin.artifactId, pin.tenantId],
              );
              if (!rowResult.rowCount) throw new ArtifactStorageError('ARTIFACT_METADATA_MISMATCH');
              const row = rowResult.rows[0]!;
              if (!row.uploadToken || !row.storageVersionId || !row.manifestVersionId) {
                throw new ArtifactStorageError('ENCRYPTION_REQUIRED');
              }
              const store = selectedStorage.facade;
              const sidecarBytes = await collectReadable(await store.openRead({
                objectKey: manifestKeyFor(pin.objectKey),
                versionId: row.manifestVersionId,
              }), maxArtifactBytes);
              const sidecar = parseWorkerArtifactSidecar(JSON.parse(sidecarBytes.toString('utf8')) as unknown);
              const ciphertext = await collectReadable(await store.openRead({
                objectKey: pin.objectKey,
                versionId: row.storageVersionId,
              }), maxArtifactBytes);
              const verified = await verifyWorkerArtifact({
                sidecar,
                ciphertext,
                context: artifactEncryptionContext({
                  tenantId: pin.tenantId,
                  artifactId: pin.artifactId,
                  objectVersion: row.uploadToken,
                }),
                seam: encryption,
              });
              if (verified.plaintextSizeBytes !== pin.expectedSizeBytes) {
                throw new ArtifactStorageError('SIZE_MISMATCH');
              }
              if (verified.plaintextSha256 !== pin.expectedSha256) {
                throw new ArtifactStorageError('CHECKSUM_MISMATCH');
              }
              return {
                objectKey: pin.objectKey,
                versionId: row.storageVersionId,
                sizeBytes: verified.plaintextSizeBytes,
                sha256: verified.plaintextSha256,
              };
            } catch (error) {
              throw storageErrorToHttp(error);
            }
          },
          cleanupAfterFailure: async (tenantId, artifactId) => compensatePublicArtifact(tenantId, artifactId),
          storageBackend: selectedStorage.backend as 'postgres' | 's3',
          maxArtifactBytes,
        },
        input,
      );
    },

    assertPublicArtifactEncryptionReady() {
      if (!encryption) throw unavailable('encrypted workflow artifact storage is not configured');
      const writer = options.storageGenerations ? null : storageFor(storageBackend);
      if (writer && (typeof writer.putServerObject !== 'function' || typeof writer.openRead !== 'function')) {
        throw unavailable('encrypted workflow artifact storage is not available on this backend');
      }
    },

    async cleanupUnlinkedPublicArtifacts(tenantId, artifactIds) {
      let deleted = 0;
      let deferred = 0;
      for (const artifactId of new Set(artifactIds)) {
        try {
          if (await compensatePublicArtifact(tenantId, artifactId)) deleted += 1;
          else deferred += 1;
        } catch {
          // The durable intent may already have been marked. Count as deferred
          // and let the recovery sweep retry it rather than masking the
          // original admission failure.
          deferred += 1;
        }
      }
      return { deleted, deferred };
    },

    async sweepPublicArtifactCleanup(limit = 50) {
      const boundedLimit = Math.min(Math.max(Math.trunc(limit), 1), 1000);
      const staleStaging = await db.query<{ id: string; tenantId: string }>(
        `SELECT id, tenant_id AS "tenantId"
         FROM artifacts
         WHERE state='STAGING' AND expires_at IS NOT NULL AND expires_at <= now()
           AND purpose='input' AND operation_id IS NULL AND task_id IS NULL
           AND upload_token IS NOT NULL AND part_count IS NULL
         ORDER BY expires_at
         LIMIT $1`,
        [boundedLimit],
      );
      for (const stale of staleStaging.rows) {
        await db.tx(async (client) => {
          const locked = await client.query(
            `SELECT id FROM artifacts
             WHERE id=$1 AND tenant_id=$2 AND state='STAGING' AND expires_at <= now()
               AND purpose='input' AND operation_id IS NULL AND task_id IS NULL
               AND upload_token IS NOT NULL AND part_count IS NULL
             FOR UPDATE`,
            [stale.id, stale.tenantId],
          );
          if (!locked.rowCount) return;
          await client.query(
            `UPDATE artifacts SET state='ABORTED', abort_reason='failed', expires_at=NULL
             WHERE id=$1 AND tenant_id=$2 AND state='STAGING'`,
            [stale.id, stale.tenantId],
          );
        }).catch(() => undefined);
      }
      const candidates = await db.query<{ id: string; tenantId: string }>(
        `SELECT id, tenant_id AS "tenantId"
         FROM artifacts
         WHERE state='ABORTED' AND abort_reason='failed' AND purpose='input'
           AND operation_id IS NULL AND task_id IS NULL AND part_count IS NULL
         ORDER BY created_at
         LIMIT $1`,
        [boundedLimit],
      );
      let deleted = 0;
      let deferred = 0;
      for (const row of candidates.rows) {
        try {
          if (await compensatePublicArtifact(row.tenantId, row.id)) deleted += 1;
          else deferred += 1;
        } catch {
          deferred += 1;
        }
      }
      return { scanned: (staleStaging.rowCount ?? staleStaging.rows.length) + (candidates.rowCount ?? candidates.rows.length), deleted, deferred };
    },

    async getBlob(storageKey): Promise<Readable> {
      const result = await db.query(
        `SELECT id, tenant_id AS "tenantId", state, storage_backend AS "storageBackend",
                storage_generation_id AS "storageGenerationId",
                storage_version_id AS "storageVersionId", manifest_version_id AS "manifestVersionId",
                size_bytes AS "sizeBytes", sha256,
                upload_token AS "uploadToken"
         FROM artifacts WHERE storage_key=$1`,
        [storageKey],
      );
      if (!result.rowCount) throw notFound('artifact not found');
      const art = result.rows[0] as {
        id: string;
        tenantId: string;
        state: string;
        storageBackend: string;
        storageGenerationId: string | null;
        storageVersionId: string | null;
        manifestVersionId: string | null;
        sizeBytes: number | string | null;
        sha256: string | null;
        uploadToken: string | null;
      };
      if (art.state !== 'READY') throw conflict('STATE_CONFLICT', 'artifact is not READY');
      if (!art.sha256 || art.sizeBytes === null || art.sizeBytes === undefined) {
        throw conflict('STATE_CONFLICT', 'artifact has no integrity metadata');
      }
      const expectedSizeBytes = Number(art.sizeBytes);
      const expectedSha256 = art.sha256;
      const backend = art.storageBackend ?? 'postgres';

      // Public gateway sidecars wrap the crypto manifest and persist physical
      // ciphertext facts in the artifact row; worker sidecars are the raw
      // crypto manifest and persist logical plaintext facts. The shared
      // authenticated reader handles both formats and keeps those facts
      // distinct while binding tenant/artifact/object versions in the AAD.
      if (art.uploadToken && art.manifestVersionId) {
        const opened = await openEncryptedArtifact({
          id: art.id, tenantId: art.tenantId, storageBackend: backend,
          storageGenerationId: art.storageGenerationId, storageKey,
          storageVersionId: art.storageVersionId, manifestVersionId: art.manifestVersionId,
          sizeBytes: art.sizeBytes, sha256: art.sha256, uploadToken: art.uploadToken,
        });
        return Readable.from([opened.bytes]);
      }

      // During DATA-05 roll-forward, check S3 first. For legacy PostgreSQL rows,
      // verify the candidate S3 object against source metadata. Only the active
      // explicitly enabled dual-read window may fall back to PostgreSQL;
      // missing or false configuration keeps PostgreSQL fallback disabled.
      if (art.storageGenerationId) {
        // Every post-generation artifact is read through the exact immutable
        // backend config and object version written at admission.
        try {
          if (!art.storageVersionId || art.storageVersionId === 'null') {
            throw new ArtifactStorageError('OBJECT_VERSION_REQUIRED');
          }
          return await storageFor(backend, art.storageGenerationId).openRead({
            objectKey: storageKey,
            versionId: art.storageVersionId,
          });
        } catch (error) {
          throw storageErrorToHttp(error);
        }
      }

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
          if (
            candidate.objectKey !== storageKey ||
            !candidate.versionId || candidate.versionId === 'null' ||
            candidate.sizeBytes !== expectedSizeBytes ||
            candidate.sha256.toLowerCase() !== expectedSha256.toLowerCase()
          ) {
            throw new ArtifactStorageError('CHECKSUM_MISMATCH');
          }
          return await options.storageFacade.openRead({
            objectKey: storageKey,
            versionId: candidate.versionId,
          });
        } catch (error) {
          if (!isStorageObjectNotFound(error) || !dualReadEnabled) throw storageErrorToHttp(error);
        }
      }

      if (s3OnlyCutover) {
        throw conflict('STATE_CONFLICT', 'S3-only cutover has an unresolved artifact; PostgreSQL fallback is disabled');
      }

      // PostgreSQL remains the rollback copy throughout the migration window.
      // Re-hash it on read and use the content hash as its immutable generation.
      let postgresPin: StoredArtifactVersion;
      try {
        postgresPin = await postgresStorage.verifyAndPin({
          artifactId: art.id,
          tenantId: art.tenantId,
          objectKey: storageKey,
          expectedSizeBytes,
          expectedSha256,
        });
      } catch (error) {
        throw storageErrorToHttp(error);
      }
      if (backend === 'postgres' && !art.storageVersionId) {
        await db.query(
          `UPDATE artifacts SET storage_version_id=$2
           WHERE id=$1 AND state='READY' AND storage_version_id IS NULL
             AND storage_backend='postgres'`,
          [art.id, postgresPin.versionId],
        );
      }
      try {
        return await postgresStorage.openRead({ objectKey: storageKey, versionId: postgresPin.versionId });
      } catch (error) {
        throw storageErrorToHttp(error);
      }
    },

    /**
     * Read and verify tenant-owned immutable inputs for Connector provider
     * tests. Returned pins are safe signed locators; storage keys and
     * credentials never leave this service. The reader only admits READY
     * `input` artifacts owned by the requested tenant and enforces the same
     * byte ceiling as Connector's invocation contract.
     */
    async readInvocationArtifacts(input: { tenantId: string; artifactIds: readonly string[] }): Promise<{
      contents: Array<InvocationArtifactReadContent>;
      pins: Array<InvocationArtifactReadPin>;
    }> {
      if (input.artifactIds.length > 4 || new Set(input.artifactIds).size !== input.artifactIds.length) {
        throw unprocessable('INVALID_SCHEMA', 'provider test accepts up to four distinct artifact IDs');
      }
      const contents: InvocationArtifactReadContent[] = [];
      const pins: InvocationArtifactReadPin[] = [];
      for (const artifactId of input.artifactIds) {
        const found = await db.query<{
          id: string; tenantId: string; fileName: string | null; mimeType: string; sizeBytes: number | string | null;
          sha256: string | null; storageBackend: string; storageGenerationId: string | null;
          storageKey: string; storageVersionId: string | null; manifestVersionId: string | null; uploadToken: string | null;
        }>(
          `SELECT id,tenant_id AS "tenantId",file_name AS "fileName",mime_type AS "mimeType",size_bytes AS "sizeBytes",sha256,
                  storage_backend AS "storageBackend",storage_generation_id AS "storageGenerationId",
                  storage_key AS "storageKey",storage_version_id AS "storageVersionId",
                  manifest_version_id AS "manifestVersionId",upload_token AS "uploadToken"
             FROM artifacts
            WHERE id=$1 AND tenant_id=$2 AND purpose='input' AND state='READY'
              AND sha256 IS NOT NULL AND size_bytes BETWEEN 1 AND 10485760
              AND storage_version_id IS NOT NULL`,
          [artifactId, input.tenantId],
        );
        if (!found.rowCount) throw notFound('provider test artifact not found');
        const row = found.rows[0]!;
        if (!row.storageVersionId || row.storageVersionId === 'null') throw conflict('STATE_CONFLICT', 'provider test artifact has no immutable storage version');
        const expectedSize = Number(row.sizeBytes);
        if (!Number.isSafeInteger(expectedSize) || expectedSize < 1 || expectedSize > 10 * 1024 * 1024 || !row.sha256) {
          throw conflict('STATE_CONFLICT', 'provider test artifact integrity metadata is invalid');
        }
        let bytes: Buffer;
        let digest: string;
        let logicalSize: number;
        let objectFacts: { sha256: string; sizeBytes: number };
        let sidecarFacts: { sha256: string; sizeBytes: number } | null = null;
        let databaseMetadataKind: InvocationArtifactReadIntegrity['databaseMetadata']['kind'];
        if (encryption && row.uploadToken && row.manifestVersionId) {
          const opened = await openEncryptedArtifact({
            id: row.id, tenantId: row.tenantId, storageBackend: row.storageBackend,
            storageGenerationId: row.storageGenerationId, storageKey: row.storageKey,
            storageVersionId: row.storageVersionId, manifestVersionId: row.manifestVersionId,
            sizeBytes: row.sizeBytes, sha256: row.sha256, uploadToken: row.uploadToken,
          });
          bytes = opened.bytes;
          digest = opened.sha256;
          logicalSize = opened.sizeBytes;
          objectFacts = opened.storedObject;
          sidecarFacts = opened.sidecar;
          databaseMetadataKind = opened.logicalFacts === 'gateway-ciphertext-row' ? 'gateway-ciphertext' : 'worker-plaintext';
        } else {
          bytes = await collectReadable(await this.getBlob(row.storageKey), 10 * 1024 * 1024);
          digest = createHash('sha256').update(bytes).digest('hex');
          logicalSize = bytes.byteLength;
          if (logicalSize !== expectedSize || digest !== row.sha256.toLowerCase()) {
            throw conflict('CHECKSUM_MISMATCH', 'provider test artifact bytes no longer match their pinned integrity metadata');
          }
          objectFacts = { sha256: digest, sizeBytes: logicalSize };
          databaseMetadataKind = 'legacy-plaintext';
        }
        if (logicalSize < 1 || logicalSize > 10 * 1024 * 1024) {
          throw conflict('STATE_CONFLICT', 'provider test artifact plaintext exceeds the supported size');
        }
        const integrity: InvocationArtifactReadIntegrity = {
          databaseMetadata: { kind: databaseMetadataKind, sha256: row.sha256.toLowerCase(), sizeBytes: expectedSize },
          content: { sha256: digest, sizeBytes: logicalSize },
          storedObject: {
            sha256: objectFacts.sha256,
            sizeBytes: objectFacts.sizeBytes,
            versionId: row.storageVersionId,
            storageGenerationId: row.storageGenerationId,
          },
          sidecar: sidecarFacts ? {
            sha256: sidecarFacts.sha256,
            sizeBytes: sidecarFacts.sizeBytes,
            versionId: row.manifestVersionId!,
          } : null,
          verified: true,
        };
        const pin: InvocationArtifactReadPin = {
          artifactId: row.id,
          fileName: row.fileName ?? 'artifact',
          mimeType: row.mimeType,
          sizeBytes: logicalSize,
          sha256: digest,
          storageVersionId: row.storageVersionId,
          storageGenerationId: row.storageGenerationId,
          integrity,
        };
        pins.push(pin);
        contents.push({ ...pin, contentBase64: bytes.toString('base64') });
      }
      return { contents, pins };
    },

    async expireForMaintenance(artifactId: string, mode: 'orphan' | 'retention' = 'orphan'): Promise<{ status: 'DELETED' | 'SKIPPED' | 'UNKNOWN'; code: string | null }> {
      const effects = options.backupArtifactEffects;
      const writeGate = options.backupSnapshotWriteGate;
      if (!effects || !writeGate) return { status: 'UNKNOWN', code: 'BACKUP_EFFECTS_UNAVAILABLE' };

      interface MaintenanceArtifactRow {
        id: string; tenantId: string | null; state: string; purpose: string; operationId: string | null; taskId: string | null;
        storageKey: string | null; storageBackend: string | null; storageGenerationId: string | null;
        storageVersionId: string | null; manifestVersionId: string | null; multipartUploadId: string | null;
        sha256: string | null; sizeBytes: string | number | null;
      }
      const initialResult = await db.query<MaintenanceArtifactRow>(
        `SELECT id,tenant_id AS "tenantId",state,purpose,operation_id AS "operationId",task_id AS "taskId",
                storage_key AS "storageKey",storage_backend AS "storageBackend",
                storage_generation_id AS "storageGenerationId",storage_version_id AS "storageVersionId",
                manifest_version_id AS "manifestVersionId",multipart_upload_id AS "multipartUploadId",
                sha256,size_bytes AS "sizeBytes"
           FROM artifacts WHERE id=$1`, [artifactId],
      );
      const initial = initialResult.rows[0];
      if (!initial) return { status: 'SKIPPED', code: 'REFERENCED_OR_INELIGIBLE' };
      if (initial.state === 'DELETED') return { status: 'DELETED', code: null };
      if (!['READY','EXPIRED'].includes(initial.state) || initial.multipartUploadId !== null) {
        return { status: 'SKIPPED', code: 'REFERENCED_OR_INELIGIBLE' };
      }
      if (!initial.storageGenerationId || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(initial.storageGenerationId)
        || !initial.storageKey || !initial.storageBackend || !initial.storageVersionId || initial.storageVersionId === 'null') {
        return { status: 'UNKNOWN', code: 'IMMUTABLE_STORAGE_PIN_MISSING' };
      }
      const effectKey = `cleanup:${createHash('sha256').update(JSON.stringify([
        artifactId, initial.storageGenerationId, initial.storageKey, initial.storageVersionId, initial.manifestVersionId,
      ])).digest('hex')}`;
      if (initial.state === 'EXPIRED') {
        const prior = await effects.lookup(effectKey);
        if (prior?.state === 'COMPLETED') return { status: 'DELETED', code: null };
        return { status: 'UNKNOWN', code: prior ? 'CLEANUP_RECONCILIATION_REQUIRED' : 'CLEANUP_EFFECT_MISSING' };
      }

      let effect: Awaited<ReturnType<BackupArtifactEffectPort['begin']>>;
      try {
        effect = await effects.begin({
          effectKey, category: 'cleanup', tenantId: initial.tenantId, artifactId,
          storageGenerationId: initial.storageGenerationId,
          objectKeySha256: createHash('sha256').update(initial.storageKey).digest('hex'),
        });
      } catch (error) {
        const code = error && typeof error === 'object' && 'code' in error ? String((error as { code: unknown }).code) : '';
        if (code === 'BACKUP_EFFECT_FENCE_ACTIVE') return { status: 'SKIPPED', code };
        return { status: 'UNKNOWN', code: 'BACKUP_EFFECTS_UNAVAILABLE' };
      }
      if (effect.state === 'COMPLETED') return { status: 'DELETED', code: null };
      if (effect.state !== 'PREPARED') return { status: 'UNKNOWN', code: 'CLEANUP_RECONCILIATION_REQUIRED' };

      let preparation: { status: 'ELIGIBLE'; row: MaintenanceArtifactRow } | { status: 'INELIGIBLE' | 'FENCE_BLOCKED' };
      try {
        preparation = await db.tx(async (client) => {
          await writeGate.assertWriteAllowed(client, {
            tenantId: initial.tenantId, domain: 'artifact-metadata', requestKey: effectKey,
          });
          const found = await client.query<MaintenanceArtifactRow>(
            `SELECT id,tenant_id AS "tenantId",state,purpose,operation_id AS "operationId",task_id AS "taskId",
                    storage_key AS "storageKey",storage_backend AS "storageBackend",
                    storage_generation_id AS "storageGenerationId",storage_version_id AS "storageVersionId",
                    manifest_version_id AS "manifestVersionId",multipart_upload_id AS "multipartUploadId",
                    sha256,size_bytes AS "sizeBytes"
               FROM artifacts WHERE id=$1 FOR UPDATE`, [artifactId],
          );
          const item = found.rows[0];
          if (!item || item.state !== 'READY' || item.multipartUploadId !== null
            || item.storageGenerationId !== initial.storageGenerationId || item.storageKey !== initial.storageKey
            || item.storageVersionId !== initial.storageVersionId || item.manifestVersionId !== initial.manifestVersionId
            || item.storageBackend !== initial.storageBackend) return { status: 'INELIGIBLE' } as const;
          if (mode === 'orphan' && (item.operationId !== null || item.taskId !== null)) return { status: 'INELIGIBLE' } as const;
          if (mode === 'retention') {
            if ((item.purpose !== 'output' && item.purpose !== 'intermediate') || !item.operationId) return { status: 'INELIGIBLE' } as const;
            const owner = await client.query(
              `SELECT 1 FROM operations o
                WHERE o.id=$1 AND o.state IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
                  AND NOT COALESCE(o.cancel_requested,false) AND o.result_ref IS NULL
                  AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.operation_id=o.id AND t.state IN ('READY','QUEUED','RUNNING','RETRY_PENDING','WAITING_INPUT','WAITING_CHILDREN'))
                  AND NOT EXISTS (SELECT 1 FROM human_waits w WHERE w.operation_id=o.id AND w.status='OPEN')
                LIMIT 1`, [item.operationId],
            );
            if (!owner.rowCount) return { status: 'INELIGIBLE' } as const;
          }
          const refs = await client.query(
            `SELECT 1 FROM operations o
              WHERE COALESCE(o.submit_artifacts,'[]'::jsonb) @> jsonb_build_array(jsonb_build_object('artifactId',$1::text))
                 OR EXISTS (SELECT 1 FROM tasks t WHERE t.result_ref=$1)
                 OR EXISTS (SELECT 1 FROM step_checkpoints sc WHERE sc.output_ref=$1)
              LIMIT 1`, [artifactId],
          );
          if (refs.rowCount) return { status: 'INELIGIBLE' } as const;
          const activated = await effects.activate(effect.effectId, client);
          if (!activated) return { status: 'FENCE_BLOCKED' } as const;
          const updated = await client.query(
            `UPDATE artifacts SET state='EXPIRED' WHERE id=$1 AND state='READY' AND storage_generation_id=$2
              AND storage_version_id=$3 AND storage_key=$4 RETURNING id`,
            [artifactId,item.storageGenerationId,item.storageVersionId,item.storageKey],
          );
          if (updated.rowCount !== 1) throw conflict('ARTIFACT_STATE_CHANGED', 'Artifact changed during maintenance cleanup.');
          return { status: 'ELIGIBLE', row: item } as const;
        });
      } catch {
        await effects.cancelPrepared(effect.effectId, 'CLEANUP_PREPARE_FAILED').catch(() => false);
        return { status: 'UNKNOWN', code: 'CLEANUP_PREPARE_OUTCOME_UNKNOWN' };
      }
      if (preparation.status !== 'ELIGIBLE') {
        await effects.cancelPrepared(effect.effectId, preparation.status === 'FENCE_BLOCKED' ? 'BACKUP_EFFECT_FENCE_ACTIVE' : 'CLEANUP_INELIGIBLE').catch(() => false);
        return preparation.status === 'FENCE_BLOCKED'
          ? { status: 'SKIPPED', code: 'BACKUP_EFFECT_FENCE_ACTIVE' }
          : { status: 'SKIPPED', code: 'REFERENCED_OR_INELIGIBLE' };
      }
      const row = preparation.row;
      try {
        const facade = storageFor(row.storageBackend!, row.storageGenerationId);
        await facade.delete({ objectKey: row.storageKey!, versionId: row.storageVersionId! });
        if (row.manifestVersionId) await facade.delete({ objectKey: manifestKeyFor(row.storageKey!), versionId: row.manifestVersionId });
        let metadataRowSha256: string | null = null;
        await db.tx(async (client) => {
          await writeGate.assertWriteAllowed(client, {
            tenantId: row!.tenantId, domain: 'artifact-metadata', requestKey: effectKey,
          });
          const current = await client.query<MaintenanceArtifactRow>(
            `SELECT id,tenant_id AS "tenantId",state,purpose,operation_id AS "operationId",task_id AS "taskId",
                    storage_key AS "storageKey",storage_backend AS "storageBackend",
                    storage_generation_id AS "storageGenerationId",storage_version_id AS "storageVersionId",
                    manifest_version_id AS "manifestVersionId",multipart_upload_id AS "multipartUploadId",
                    sha256,size_bytes AS "sizeBytes"
               FROM artifacts WHERE id=$1 FOR UPDATE`, [artifactId],
          );
          const currentRow = current.rows[0];
          if (!currentRow || currentRow.state !== 'EXPIRED' || currentRow.storageGenerationId !== row!.storageGenerationId
            || currentRow.storageVersionId !== row!.storageVersionId || currentRow.manifestVersionId !== row!.manifestVersionId) {
            throw conflict('ARTIFACT_STATE_CHANGED', 'Artifact changed after the exact-version delete.');
          }
          const updated = await client.query(
            `UPDATE artifacts SET state='DELETED' WHERE id=$1 AND state='EXPIRED' RETURNING id`, [artifactId],
          );
          if (updated.rowCount !== 1) throw conflict('ARTIFACT_STATE_CHANGED', 'Artifact state changed after the exact-version delete.');
          const finalRow = await client.query<MaintenanceArtifactRow>(
            `SELECT id,tenant_id AS "tenantId",state,purpose,operation_id AS "operationId",task_id AS "taskId",
                    storage_key AS "storageKey",storage_backend AS "storageBackend",
                    storage_generation_id AS "storageGenerationId",storage_version_id AS "storageVersionId",
                    manifest_version_id AS "manifestVersionId",multipart_upload_id AS "multipartUploadId",
                    sha256,size_bytes AS "sizeBytes"
               FROM artifacts WHERE id=$1`, [artifactId],
          );
          const final = finalRow.rows[0];
          if (!final || final.state !== 'DELETED') throw conflict('ARTIFACT_READBACK_FAILED', 'Deleted artifact metadata could not be verified.');
          metadataRowSha256 = createHash('sha256').update(JSON.stringify([
            final.id,final.tenantId,final.state,final.purpose,final.operationId,final.taskId,
            final.storageKey,final.storageBackend,final.storageGenerationId,final.storageVersionId,
            final.manifestVersionId,final.multipartUploadId,final.sha256,final.sizeBytes,
          ])).digest('hex');
        });
        const proof: BackupArtifactEffectProof = {
          objectVersionId: row.storageVersionId,
          objectSha256: null,
          objectByteSize: null,
          sidecarVersionId: row.manifestVersionId,
          sidecarSha256: null,
          sidecarByteSize: null,
          metadataRowSha256,
        };
        if (!metadataRowSha256 || !await effects.settle(effect.effectId, proof)) {
          await effects.markUnknown(effect.effectId, 'CLEANUP_SETTLEMENT_UNCONFIRMED').catch(() => undefined);
          return { status: 'UNKNOWN', code: 'CLEANUP_SETTLEMENT_UNCONFIRMED' };
        }
        return { status: 'DELETED', code: null };
      } catch {
        await effects.markUnknown(effect.effectId, 'STORAGE_DELETE_OUTCOME_UNKNOWN').catch(() => undefined);
        return { status: 'UNKNOWN', code: 'STORAGE_DELETE_OUTCOME_UNKNOWN' };
      }
    },

    async readPinnedObjectsForMaintenanceBackup(input) {
      if (!input.storageKey || !input.storageVersionId || input.storageVersionId === 'null'
        || !Number.isSafeInteger(input.maxBytes) || input.maxBytes < 1 || input.maxBytes > maxArtifactBytes) {
        throw new ArtifactStorageError('OBJECT_VERSION_REQUIRED');
      }
      const facade = storageFor(input.storageBackend, input.storageGenerationId);
      const objectBytes = await collectReadable(
        await facade.openRead({ objectKey: input.storageKey, versionId: input.storageVersionId }), input.maxBytes,
      );
      const manifestBytes = input.manifestVersionId
        ? await collectReadable(await facade.openRead({ objectKey: manifestKeyFor(input.storageKey), versionId: input.manifestVersionId }), 16 * 1024)
        : null;
      return { objectBytes, manifestBytes };
    },

    async openPinnedObjectsForMaintenanceBackup(input) {
      if (!input.storageKey || !input.storageVersionId || input.storageVersionId === 'null') {
        throw new ArtifactStorageError('OBJECT_VERSION_REQUIRED');
      }
      const facade = storageFor(input.storageBackend,input.storageGenerationId);
      const object = await facade.openRead({objectKey:input.storageKey,versionId:input.storageVersionId});
      const manifest = input.manifestVersionId
        ? await facade.openRead({objectKey:manifestKeyFor(input.storageKey),versionId:input.manifestVersionId})
        : null;
      return {object,manifest};
    },
  };
}

function isPublicArtifactPurpose(purpose: string): boolean {
  return purpose === 'input' || purpose === 'output';
}

function hasDeclaredArtifactReference(value: unknown, artifactId: string): boolean {
  if (!Array.isArray(value)) return false;
  return value.some(
    (entry) =>
      typeof entry === 'object' &&
      entry !== null &&
      !Array.isArray(entry) &&
      'artifactId' in entry &&
      entry.artifactId === artifactId
  );
}

function proxyBlobUrl(storageKey: string, token: string): string {
  return `/api/runtime/v1/artifacts/blob/${encodeURIComponent(storageKey)}?grant=${token}`;
}

/** Collect one bounded server-side stream (envelope/plaintext read paths). */
async function collectReadable(stream: Readable, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    total += bytes.byteLength;
    if (total > maxBytes) {
      throw new ArtifactStorageError('SIZE_MISMATCH');
    }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}

function isStorageObjectNotFound(error: unknown): boolean {
  return error instanceof ArtifactStorageError && error.code === 'OBJECT_NOT_FOUND';
}

function storageErrorToHttp(error: unknown) {
  if (error instanceof ArtifactStorageError) {
    switch (error.code) {
      case 'INVALID_UPLOAD_GRANT':
        return unprocessable('INVALID_STORAGE_GRANT', 'artifact storage rejected the upload grant');
      case 'OBJECT_NOT_FOUND':
        return conflict('STATE_CONFLICT', 'artifact has no stored bytes');
      case 'SIZE_MISMATCH':
        return conflict('SIZE_MISMATCH', 'stored bytes do not match supplied sizeBytes');
      case 'CHECKSUM_MISMATCH':
        return conflict('HASH_MISMATCH', 'stored bytes do not match supplied sha256');
      case 'OBJECT_VERSION_REQUIRED':
      case 'ARTIFACT_METADATA_MISMATCH':
      case 'TENANT_METADATA_MISMATCH':
        return conflict('STATE_CONFLICT', 'artifact storage metadata could not be verified');
      case 'INVALID_OBJECT_BODY':
      case 'STORAGE_UNAVAILABLE':
        return unavailable('artifact storage is temporarily unavailable');
      case 'ENCRYPTION_UNAVAILABLE':
        return unavailable('artifact encryption is temporarily unavailable');
      case 'ENCRYPTION_REQUIRED':
        return unavailable('artifact encryption is required and was not satisfied');
      case 'ENVELOPE_INVALID':
        return conflict('STATE_CONFLICT', 'artifact encryption envelope could not be verified');
    }
  }
  // Never propagate provider exception messages, request IDs, URLs or paths.
  return unavailable('artifact storage is temporarily unavailable');
}
