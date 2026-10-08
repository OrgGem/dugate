import { createHash, randomUUID } from 'node:crypto';

/**
 * Public artifact creation for the legacy compat facade.
 *
 * ## Why this is a new path
 *
 * The two existing writers are both wrong for a legacy submit:
 *
 * - ArtifactService.requestUpload demands a taskId + leaseEpoch and asserts
 *   the task row, because it is the WORKER upload grant. A legacy submit has
 *   no task yet - the operation and task are created BY the submission that
 *   consumes these files.
 * - MultipartService.publicInit is the right shape but hardcodes
 *   storage_backend=s3 and calls requireStorage(), so it throws on a
 *   PostgreSQL deployment.
 *
 * So the facade needs one narrow writer: create the artifact row, put the
 * bytes, verify and pin, and mark READY - with operation_id and task_id
 * left NULL exactly as publicInit does, which is what makes the row
 * structurally unreachable from the worker lifecycle.
 *
 * ## Integrity
 *
 * verifyAndPin is mandatory: a legacy upload that skipped the size and
 * digest check would let an unverified blob become a READY artifact.
 */

export interface PublicArtifactWriterDeps {
  query(sql: string, params?: unknown[]): Promise<{ rowCount: number | null; rows: unknown[] }>;
  putBlob(storageKey: string, tenantId: string, bytes: Buffer): Promise<void>;
  verifyAndPin(input: {
    artifactId: string;
    tenantId: string;
    objectKey: string;
    expectedSizeBytes: number;
    expectedSha256: string;
  }): Promise<{ objectKey: string; versionId: string | null }>;
  /** Immediately attempt cleanup after a failure; the durable row already exists. */
  cleanupAfterFailure?(tenantId: string, artifactId: string): Promise<unknown>;
  storageBackend: 'postgres' | 's3';
  maxArtifactBytes: number;
}

export class PublicArtifactTooLargeError extends Error {
  constructor(readonly sizeBytes: number, readonly limit: number) {
    super('public artifact exceeds the configured size limit');
    this.name = 'PublicArtifactTooLargeError';
  }
}
const INSERT_ARTIFACT =
  `INSERT INTO artifacts (id, tenant_id, purpose, file_name, mime_type, size_bytes, sha256, state,
                          token, storage_key, storage_backend, upload_token, expires_at)
   VALUES ($1,$2,'input',$3,$4,$5,$6,'STAGING',$7,$8,$9,$10,now() + interval '30 minutes')`;

/**
 * Store one legacy upload and return its artifact id.
 *
 * The cap is checked BEFORE any row is written. A bounded STAGING row is then
 * recorded before storage writes so a crash or verification failure leaves a
 * durable cleanup candidate rather than an untracked blob.
 */
export async function writePublicArtifact(
  deps: PublicArtifactWriterDeps,
  input: { tenantId: string; fileName: string | null; mimeType: string; bytes: Buffer },
): Promise<{ artifactId: string; state: string }> {
  const sizeBytes = input.bytes.length;
  if (sizeBytes > deps.maxArtifactBytes) {
    throw new PublicArtifactTooLargeError(sizeBytes, deps.maxArtifactBytes);
  }

  const artifactId = randomUUID();
  const storageKey = `art-${artifactId}`;
  const sha256 = createHash('sha256').update(input.bytes).digest('hex');

  await deps.query(INSERT_ARTIFACT, [
    artifactId,
    input.tenantId,
    input.fileName,
    input.mimeType,
    sizeBytes,
    sha256,
    randomUUID(),
    storageKey,
    deps.storageBackend,
    randomUUID(),
  ]);
  let version: { objectKey: string; versionId: string | null } | undefined;
  try {
    await deps.putBlob(storageKey, input.tenantId, input.bytes);
    version = await deps.verifyAndPin({
      artifactId,
      tenantId: input.tenantId,
      objectKey: storageKey,
      expectedSizeBytes: sizeBytes,
      expectedSha256: sha256,
    });
    const committed = await deps.query(
      `UPDATE artifacts SET state='READY', storage_version_id=$2, expires_at=NULL
       WHERE id=$1 AND tenant_id=$3 AND state='STAGING' AND purpose='input'
         AND operation_id IS NULL AND task_id IS NULL`,
      [artifactId, version.versionId, input.tenantId],
    );
    if (!committed.rowCount) throw new Error('PUBLIC_ARTIFACT_COMMIT_FAILED');
  } catch (error: unknown) {
    // Storage may have accepted bytes even if pinning or the READY transition
    // failed. Persist a retry intent before attempting immediate cleanup.
    // PostgreSQL's immutable generation is the content digest and is still
    // checked by the storage facade before delete. A versioned store with no
    // pin remains retained for its owner/GC instead of deleting latest.
    await deps.query(
      `UPDATE artifacts SET state='ABORTED', abort_reason='failed',
                            storage_version_id=COALESCE($2, storage_version_id), expires_at=NULL
       WHERE id=$1 AND tenant_id=$3 AND state IN ('STAGING','READY')
         AND purpose='input' AND operation_id IS NULL AND task_id IS NULL`,
      [artifactId, version?.versionId ?? (deps.storageBackend === 'postgres' ? sha256 : null), input.tenantId],
    ).catch(() => undefined);
    if (deps.cleanupAfterFailure) {
      await deps.cleanupAfterFailure(input.tenantId, artifactId).catch(() => undefined);
    }
    throw error;
  }
  return { artifactId, state: 'READY' };
}
