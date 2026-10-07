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
    randomUUID(),
    version.objectKey,
    deps.storageBackend,
    version.versionId,
    randomUUID(),
  ]);
  return { artifactId, state: 'READY' };
}
