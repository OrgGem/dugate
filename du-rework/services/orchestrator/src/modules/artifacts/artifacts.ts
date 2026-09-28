import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
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

/**
 * Artifact lifecycle with either PostgreSQL fallback storage or an injected
 * storage facade. S3 upload grants go directly to the configured bucket;
 * verified object versions stay private in Orchestrator metadata. Reads use
 * the existing authorized proxy route and stream the exact pinned version.
 */

const GRANT_TTL_MS = 15 * 60 * 1000;

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
}

export interface ArtifactServiceOptions {
  /** Defaults to PostgreSQL; S3 requires an explicitly injected facade. */
  storageBackend?: 'postgres' | 's3';
  storageFacade?: ArtifactStorageFacade;
  /** Explicitly approved rollback window: new writes use S3; reads may fall back to retained PostgreSQL blobs. */
  migrationWindow?: boolean;
  /** Matches the bounded binary ingress default; S3 grants enforce it before upload. */
  maxArtifactBytes?: number;
}

export function createArtifactService(db: Db, options: ArtifactServiceOptions = {}): ArtifactService {
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
  });

  function storageFor(backend: string): ArtifactStorageFacade {
    if (backend === 'postgres') return postgresStorage;
    if (backend === 's3' && options.storageFacade) return options.storageFacade;
    throw unavailable('artifact storage backend is not configured');
  }

  async function assertLease(taskId: string, leaseEpoch: number) {
    const res = await db.query(
      `SELECT t.lease_epoch, t.operation_id, o.tenant_id
       FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1`,
      [taskId]
    );
    if (!res.rowCount) throw notFound(`task ${taskId} not found`);
    const row = res.rows[0] as { lease_epoch: number; operation_id: string; tenant_id: string };
    if (row.lease_epoch !== leaseEpoch) {
      throw conflict('LEASE_LOST', `stale leaseEpoch ${leaseEpoch}, current ${row.lease_epoch}`);
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
      const token = randomUUID();
      // CR-12: the grant is method-scoped (upload) with a STORED expiry. The
      // blob route enforces both, so this token can never GET and dies on
      // time even if the advertised `expiresAt` is ignored by the caller.
      const expiresAt = new Date(Date.now() + GRANT_TTL_MS).toISOString();
      const proxyUrl = `/api/runtime/v1/artifacts/blob/${encodeURIComponent(storageKey)}?grant=${token}`;
      let storageGrant: ArtifactStorageUploadGrant;
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
      } catch (error) {
        throw storageErrorToHttp(error);
      }
      await db.query(
        `INSERT INTO artifacts (id, tenant_id, operation_id, task_id, purpose, file_name, mime_type, size_bytes, state,
                                token, token_mode, token_expires_at, storage_key, storage_backend)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'STAGING',$9,'upload',$10,$11,$12)`,
        [artifactId, lease.tenant_id, lease.operation_id, taskId, req.purpose, req.fileName ?? null, req.mimeType, req.sizeBytes,
          token, expiresAt, storageKey, storageBackend]
      );
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
          `SELECT lease_epoch, state,
                  (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
           FROM tasks WHERE id=$1 FOR UPDATE`,
          [req.taskId]
        );
        if (!taskRes.rowCount) throw notFound(`task ${req.taskId} not found`);
        const task = taskRes.rows[0] as { lease_epoch: number; state: string; lease_active: boolean };

        const artifactRes = await client.query(
          `SELECT tenant_id AS "tenantId", storage_key AS "storageKey", storage_backend AS "storageBackend",
                  storage_version_id AS "storageVersionId", state,
                  task_id AS "taskId", size_bytes AS "sizeBytes", sha256,
                  finalized_lease_epoch AS "finalizedLeaseEpoch",
                  part_count AS "partCount"
           FROM artifacts WHERE id=$1 FOR UPDATE`,
          [artifactId]
        );
        if (!artifactRes.rowCount) throw notFound(`artifact ${artifactId} not found`);
        const art = artifactRes.rows[0] as {
          tenantId: string;
          storageKey: string;
          storageBackend?: string;
          storageVersionId?: string | null;
          state: string;
          taskId: string;
          sizeBytes: number | string | null;
          sha256: string | null;
          finalizedLeaseEpoch: number | null;
          /** Non-null only on the multipart branch, where it bounds the cap. */
          partCount?: number | string | null;
        };
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
          : storageFor(artifactBackend);
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
        if (!task.lease_active) throw forbidden('requester lease has expired');
        if (task.state !== 'RUNNING') {
          throw conflict('STATE_CONFLICT', 'requester task is not RUNNING');
        }

        const artifactRes = await client.query(
          `SELECT tenant_id AS "tenantId", operation_id AS "operationId",
                  storage_key AS "storageKey", storage_backend AS "storageBackend",
                  file_name AS "fileName", mime_type AS "mimeType", size_bytes AS "sizeBytes",
                  sha256,
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
          if (art.state !== 'READY') throw conflict('STATE_CONFLICT', 'artifact is not READY');
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
        const expiresAt = new Date(Date.now() + GRANT_TTL_MS).toISOString();
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
        } else {
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
          `SELECT a.state, a.storage_backend AS "storageBackend" FROM artifacts a
           WHERE a.storage_key=$1 AND a.tenant_id=$2 FOR UPDATE OF a`,
          [storageKey, tenantId]
        );
        if (!cur.rowCount) throw notFound('artifact upload target not found');
        const row = cur.rows[0] as { state: string; storageBackend?: string };
        const state = row.state;
        if (state !== 'STAGING') {
          throw conflict('STATE_CONFLICT', 'artifact is not STAGING and its bytes are immutable');
        }
        if ((row.storageBackend ?? 'postgres') !== 'postgres') {
          throw conflict('STATE_CONFLICT', 'S3 uploads must use the issued storage grant');
        }
        await client.query(
          `INSERT INTO artifact_blobs (storage_key, tenant_id, bytes) VALUES ($1,$2,$3)
           ON CONFLICT (storage_key) DO UPDATE SET bytes=EXCLUDED.bytes, created_at=now()`,
          [storageKey, tenantId, bytes]
        );
      });
    },

    async getBlob(storageKey): Promise<Readable> {
      const result = await db.query(
        `SELECT id, tenant_id AS "tenantId", state, storage_backend AS "storageBackend",
                storage_version_id AS "storageVersionId", size_bytes AS "sizeBytes", sha256
         FROM artifacts WHERE storage_key=$1`,
        [storageKey],
      );
      if (!result.rowCount) throw notFound('artifact not found');
      const art = result.rows[0] as {
        id: string;
        tenantId: string;
        state: string;
        storageBackend: string;
        storageVersionId: string | null;
        sizeBytes: number | string | null;
        sha256: string | null;
      };
      if (art.state !== 'READY') throw conflict('STATE_CONFLICT', 'artifact is not READY');
      if (!art.sha256 || art.sizeBytes === null || art.sizeBytes === undefined) {
        throw conflict('STATE_CONFLICT', 'artifact has no integrity metadata');
      }
      const expectedSizeBytes = Number(art.sizeBytes);
      const expectedSha256 = art.sha256;
      const backend = art.storageBackend ?? 'postgres';

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
    }
  }
  // Never propagate provider exception messages, request IDs, URLs or paths.
  return unavailable('artifact storage is temporarily unavailable');
}
