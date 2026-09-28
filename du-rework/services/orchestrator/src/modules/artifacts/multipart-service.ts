import { createHash, randomUUID } from 'node:crypto';
import {
  MULTIPART_FIXED_PART_BYTES,
  MULTIPART_MAX_PARTS,
  MULTIPART_MAX_TOTAL_BYTES,
  MULTIPART_MIN_TOTAL_BYTES,
  MULTIPART_PART_URL_TTL_S,
  MULTIPART_SESSION_TTL_MS,
  MultipartAbortRequestSchema,
  MultipartCompleteRequestSchema,
  MultipartInitRequestSchema,
  MultipartPartGrantRequestSchema,
  type MultipartAbortAck,
  type MultipartCompleteAck,
  type MultipartInitAck,
  type MultipartPartGrant,
  type MultipartPartReceipt,
} from '@du/contracts';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { HttpError, conflict, forbidden, notFound, unprocessable, unavailable } from '../../http/errors';
import type { ArtifactMultipartStorage, MultipartStoredPart } from './multipart-storage';
import { multipartUploadHandle } from './multipart-storage';
import { ArtifactStorageError } from './storage-facade';

/**
 * DATA-02 server-side multipart upload lifecycle (`init` → per-part grants →
 * `complete` → `abort`), on the wire shapes in `@du/contracts` runtime.ts.
 *
 * Division of labour, and why each guard sits where it does:
 *
 * - The Zod schemas are the OUTER wire bounds. Deployment policy values are
 *   injected and may only narrow them (`resolvePolicy`), never widen them.
 * - Storage is authoritative about bytes. A client receipt is never trusted:
 *   `complete` re-reads `listMultipartParts` and refuses to publish unless
 *   every part's etag, size and checksum agree with what the server declared
 *   at grant time. The whole object is then re-hashed from the pinned
 *   generation before anything is committed.
 * - The lease fence is re-taken in every durable step. A takeover between
 *   steps makes the next step 409 `LEASE_LOST` rather than a silent write.
 * - `finalize` (single-PUT path, unchanged schema) stays the only
 *   STAGING → READY transition, so both upload branches converge on one
 *   verified-then-committed gate.
 *
 * The provider upload id stays server-side; clients see only the derived
 * opaque `uploadHandle`. Presigned part URLs are never logged.
 */

const SESSION_SELECT = `
  SELECT id AS "artifactId", tenant_id AS "tenantId", operation_id AS "operationId",
         task_id AS "taskId", purpose, file_name AS "fileName", mime_type AS "mimeType",
         size_bytes AS "sizeBytes", state, storage_key AS "storageKey",
         upload_token AS "uploadToken", multipart_upload_id AS "uploadId",
         part_size_bytes AS "partSizeBytes", part_count AS "partCount",
         storage_version_id AS "committedVersionId", sha256 AS "committedSha256",
         multipart_expires_at AS "expiresAt"
  FROM artifacts`;

/**
 * Signed §6 ceiling for one part: 64 MiB. S3 itself admits 5 GiB per part, so
 * this is not a storage limit — the producer buffers exactly one part while it
 * hashes it, and the worker SDK refuses any larger geometry outright. A
 * deployment configured above this would mint sessions no peer can fill, so
 * operators may only narrow below it (see narrow()).
 */
const MAX_PART_SIZE_BYTES = 64 * 1024 * 1024;

/* Public branch wire shapes (draft §8, packet W-DATA02-PUB-1): the SAME §2
 * bodies minus the fields a public caller cannot hold — no leaseEpoch (a
 * client upload has no producer lease) and no purpose (public uploads are
 * always 'input', server-forced). This is an orchestrator-local surface: the
 * contracts package stays frozen; the runtime wire is untouched. */
const PublicMultipartInitRequestSchema = MultipartInitRequestSchema.omit({ leaseEpoch: true, purpose: true });
const PublicMultipartPartGrantRequestSchema = MultipartPartGrantRequestSchema.omit({ leaseEpoch: true });
const PublicMultipartCompleteRequestSchema = MultipartCompleteRequestSchema.omit({ leaseEpoch: true });
const PublicMultipartAbortRequestSchema = MultipartAbortRequestSchema.omit({ leaseEpoch: true });

/**
 * Deterministic replay key for the public init when the caller authenticates
 * the retry with an Idempotency-Key header instead of a body uploadToken
 * (draft §8 left the choice to the coordinator — the route accepts both).
 * The derivation is namespaced by tenant, so two tenants replaying the same
 * header string never collide on the shared upload_token column.
 */
export function publicUploadToken(tenantId: string, idempotencyKey: string): string {
  const digest = createHash('sha256').update('du-uploads|' + tenantId + '|' + idempotencyKey).digest('hex');
  const variant = ((parseInt(digest.slice(16, 17), 16) & 0x3) | 0x8).toString(16);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    '5' + digest.slice(13, 16),
    variant + digest.slice(17, 20),
    digest.slice(20, 32),
  ].join('-');
}

const TASK_LOCK_SELECT = `SELECT lease_epoch, state,
        (lease_expires_at IS NOT NULL AND lease_expires_at > now()) AS lease_active
 FROM tasks WHERE id=$1 FOR UPDATE`;

/** The transaction-scoped handle `Db.tx` hands to its callback. */
type SqlClient = {
  query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>>;
};

interface SessionRow {
  artifactId: string;
  tenantId: string;
  operationId: string | null;
  taskId: string | null;
  purpose: string;
  fileName: string | null;
  mimeType: string;
  sizeBytes: number | string | null;
  state: string;
  storageKey: string;
  uploadToken: string | null;
  uploadId: string | null;
  partSizeBytes: number | string | null;
  partCount: number | string | null;
  committedVersionId: string | null;
  committedSha256: string | null;
  expiresAt: Date | string | null;
}

interface Session {
  artifactId: string;
  tenantId: string;
  operationId: string | null;
  /** Null on the public branch (client uploads have no producing task). */
  taskId: string | null;
  purpose: string;
  fileName: string | null;
  mimeType: string;
  declaredSizeBytes: number;
  state: string;
  storageKey: string;
  uploadToken: string;
  uploadId: string | null;
  partSizeBytes: number;
  partCount: number;
  committedVersionId: string | null;
  committedSha256: string | null;
  expiresAtMs: number;
}

interface DeclaredPart {
  partNumber: number;
  declaredSha256: string;
  sizeBytes: number;
}

export interface MultipartServiceOptions {
  /** Absent means the deployment has no backend that can hold an incomplete
   *  upload; every lifecycle call then fails 409 instead of falling back. */
  storage?: ArtifactMultipartStorage;
  /** Server-fixed geometry. Policy may only raise the contract floor. */
  partSizeBytes?: number;
  maxTotalBytes?: number;
  sessionTtlMs?: number;
  partUrlTtlMs?: number;
  now?: () => number;
}

export interface MultipartSweepSummary {
  scanned: number;
  aborted: number;
  purged: number;
  failed: number;
}

export interface MultipartService {
  init(taskId: string, body: unknown): Promise<MultipartInitAck>;
  grantPart(artifactId: string, body: unknown): Promise<MultipartPartGrant>;
  complete(artifactId: string, body: unknown): Promise<MultipartCompleteAck>;
  abort(artifactId: string, body: unknown): Promise<MultipartAbortAck>;
  sweepExpiredSessions(options?: { nowMs?: number; limit?: number }): Promise<MultipartSweepSummary>;
  /**
   * DATA-02 public branch (draft §8): the same lifecycle with a different
   * trust tier. Sessions are tenant-fenced (an artifact of another tenant is
   * indistinguishable from a missing one), carry no producer lease, and the
   * complete step is ALSO the STAGING -> READY transition — there is no
   * lease-bearing finalize route a client could call, and the byte-verification
   * gate complete already runs (ListParts + whole-object re-hash) is exactly
   * what finalize would prove. The submit guard still refuses non-READY rows.
   */
  publicInit(tenantId: string, body: unknown): Promise<MultipartInitAck>;
  publicGrantPart(artifactId: string, tenantId: string, body: unknown): Promise<MultipartPartGrant>;
  publicComplete(artifactId: string, tenantId: string, body: unknown): Promise<MultipartCompleteAck>;
  publicAbort(artifactId: string, tenantId: string, body: unknown): Promise<MultipartAbortAck>;
}

function positiveInt(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`multipart policy ${label} must be a positive safe integer`);
  }
  return value;
}

/**
 * narrows a requested value into [floor, contractCeiling]: the contract
 * constant is the widest anything on this deployment may accept, so an
 * operator typo can never open the wire beyond what peers are tested against.
 */
function narrow(value: number, floor: number, ceiling: number, label: string): number {
  positiveInt(value, label);
  if (value < floor) {
    throw new Error(`multipart policy ${label} must be at least ${floor}`);
  }
  return Math.min(value, ceiling);
}

export function createMultipartService(db: Db, options: MultipartServiceOptions = {}): MultipartService {
  const now = options.now ?? Date.now;
  const storage = options.storage;
  const policy = {
    partSizeBytes: narrow(
      options.partSizeBytes ?? MULTIPART_FIXED_PART_BYTES,
      MULTIPART_FIXED_PART_BYTES,
      MAX_PART_SIZE_BYTES,
      'partSizeBytes',
    ),
    maxTotalBytes: narrow(
      options.maxTotalBytes ?? MULTIPART_MAX_TOTAL_BYTES,
      MULTIPART_MIN_TOTAL_BYTES,
      MULTIPART_MAX_TOTAL_BYTES,
      'maxTotalBytes',
    ),
    sessionTtlMs: narrow(options.sessionTtlMs ?? MULTIPART_SESSION_TTL_MS, 1, MULTIPART_SESSION_TTL_MS, 'sessionTtlMs'),
    partUrlTtlMs: narrow(
      options.partUrlTtlMs ?? MULTIPART_PART_URL_TTL_S * 1000,
      1,
      MULTIPART_PART_URL_TTL_S * 1000,
      'partUrlTtlMs',
    ),
  };

  function requireStorage(): ArtifactMultipartStorage {
    if (!storage) {
      throw conflict(
        'MULTIPART_NOT_AVAILABLE',
        'this deployment has no storage backend that can hold an incomplete multipart upload',
      );
    }
    return storage;
  }

  function invalidSchema(operation: string, error: { issues: { path: (string | number)[]; message: string }[] }): HttpError {
    return unprocessable('INVALID_SCHEMA', `multipart ${operation} request failed validation`, {
      errors: error.issues.slice(0, 20).map((issue) => ({
        pointer: '/' + issue.path.join('/'),
        message: issue.message,
      })),
    });
  }

  function toSession(row: SessionRow): Session | null {
    // part_count identifies the multipart branch; a purged ABORTED row keeps
    // it while its provider pointer is already gone, so uploadId stays null.
    // taskId may be null (public branch): the runtime fences reject such
    // rows via ownerTaskOf long before a session is built from them.
    if (row.partCount === null || row.partSizeBytes === null) return null;
    return {
      artifactId: row.artifactId,
      tenantId: row.tenantId,
      operationId: row.operationId,
      taskId: row.taskId,
      purpose: row.purpose,
      fileName: row.fileName,
      mimeType: row.mimeType,
      declaredSizeBytes: Number(row.sizeBytes ?? 0),
      state: row.state,
      storageKey: row.storageKey,
      uploadToken: String(row.uploadToken),
      uploadId: row.uploadId,
      partSizeBytes: Number(row.partSizeBytes),
      partCount: Number(row.partCount),
      committedVersionId: row.committedVersionId,
      committedSha256: row.committedSha256,
      expiresAtMs: row.expiresAt instanceof Date ? row.expiresAt.getTime() : Date.parse(String(row.expiresAt)),
    };
  }

  async function selectSession(sql: string, params: unknown[]): Promise<Session | null> {
    const res = await db.query<SessionRow>(sql, params);
    return res.rowCount ? toSession(res.rows[0] as SessionRow) : null;
  }

  function assertMultipartSession(session: Session | null): Session {
    if (!session) {
      throw conflict('STATE_CONFLICT', 'artifact is not an open multipart upload session');
    }
    return session;
  }

  /** A STAGING session past the guards below always has a provider upload. */
  function assertSessionLive(session: Session): Session & { uploadId: string } {
    if (session.state !== 'STAGING') {
      throw conflict('STATE_CONFLICT', `multipart upload is ${session.state}`);
    }
    if (!session.uploadId) {
      throw conflict('STATE_CONFLICT', 'multipart upload has no open provider session');
    }
    if (!(session.expiresAtMs > now())) {
      throw conflict('MULTIPART_EXPIRED', 'multipart upload session expired; start a new upload');
    }
    return session as Session & { uploadId: string };
  }

  /** Size of one part under the server-fixed geometry (the last part takes the remainder). */
  function partSizeOf(session: Session, partNumber: number): number {
    const start = (partNumber - 1) * session.partSizeBytes;
    return Math.min(session.partSizeBytes, session.declaredSizeBytes - start);
  }

  /** Read-only producer fence, mirroring the single-PUT grant path. */
  async function assertLease(taskId: string, leaseEpoch: number) {
    const res = await db.query(
      `SELECT t.lease_epoch, t.operation_id, o.tenant_id
       FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1`,
      [taskId],
    );
    if (!res.rowCount) throw notFound(`task ${taskId} not found`);
    const row = res.rows[0] as { lease_epoch: number; operation_id: string; tenant_id: string };
    if (row.lease_epoch !== leaseEpoch) {
      throw conflict('LEASE_LOST', `stale leaseEpoch ${leaseEpoch}, current ${row.lease_epoch}`);
    }
    return row;
  }

  /** Durable fence: same task → artifact lock order as `finalize`. */
  async function lockTask(
    client: SqlClient,
    taskId: string,
    leaseEpoch: number,
    guard: { requireRunning: boolean },
  ): Promise<void> {
    const res = await client.query<{ lease_epoch: number; state: string; lease_active: boolean }>(TASK_LOCK_SELECT, [taskId]);
    if (!res.rowCount) throw notFound(`task ${taskId} not found`);
    const task = res.rows[0]!;
    if (task.lease_epoch !== leaseEpoch) {
      throw conflict('LEASE_LOST', 'producer lease epoch is stale');
    }
    if (!task.lease_active) throw forbidden('producer lease has expired');
    if (guard.requireRunning && task.state !== 'RUNNING') {
      throw conflict('STATE_CONFLICT', 'producer task is not RUNNING');
    }
  }

  async function lockSession(
    client: SqlClient,
    artifactId: string,
  ): Promise<Session | null> {
    const res = await client.query<SessionRow>(`${SESSION_SELECT} WHERE id=$1 FOR UPDATE`, [artifactId]);
    return res.rowCount ? toSession(res.rows[0] as SessionRow) : null;
  }

  /**
   * Tenant-scoped lock for the public branch. A foreign row is never
   * returned, so one tenant cannot distinguish another tenant's artifact from
   * an id that does not exist (same no-leak shape as the submit guard).
   */
  async function lockSessionTenant(
    client: SqlClient,
    artifactId: string,
    tenantId: string,
  ): Promise<Session | null> {
    const res = await client.query<SessionRow>(
      `${SESSION_SELECT} WHERE id=$1 AND tenant_id=$2 FOR UPDATE`,
      [artifactId, tenantId],
    );
    return res.rowCount ? toSession(res.rows[0] as SessionRow) : null;
  }

  /** 404 -> not-a-multipart-session -> not-public, in that order. */
  function lockPublicSession(session: Session | null): Session {
    if (!session) throw notFound('multipart upload session not found');
    assertMultipartSession(session);
    if (session.taskId !== null) {
      throw conflict('STATE_CONFLICT', 'multipart session is runtime-owned; the client lifecycle cannot drive it');
    }
    return session;
  }

  /**
   * The lifecycle routes are addressed by artifact id, so the owning task is
   * resolved from the row rather than from a client-declared body field.
   */
  async function ownerTaskOf(artifactId: string): Promise<string> {
    const res = await db.query<{ taskId: string | null }>(`SELECT task_id AS "taskId" FROM artifacts WHERE id=$1`, [
      artifactId,
    ]);
    if (!res.rowCount) throw notFound(`artifact ${artifactId} not found`);
    const taskId = res.rows[0]!.taskId;
    if (!taskId) throw conflict('STATE_CONFLICT', 'artifact has no owning task');
    return taskId;
  }

  /** Records the geometry and hash the server agreed to accept for one part. */
  async function insertPartDeclaration(
    client: SqlClient,
    artifactId: string,
    partNumber: number,
    declaredSha256: string,
    sizeBytes: number,
  ): Promise<void> {
    await client.query(
      `INSERT INTO artifact_multipart_parts (artifact_id, part_number, declared_sha256, size_bytes)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (artifact_id, part_number) DO UPDATE
         SET declared_sha256=EXCLUDED.declared_sha256, size_bytes=EXCLUDED.size_bytes`,
      [artifactId, partNumber, declaredSha256, sizeBytes],
    );
  }

  /** Presigns the server-fixed part size, binding the declared hash into the URL. */
  async function presignPartGrant(
    backend: ArtifactMultipartStorage,
    session: Session,
    artifactId: string,
    partNumber: number,
    declaredSha256: string,
    sizeBytes: number,
  ): Promise<MultipartPartGrant> {
    const expiresAt = new Date(now() + policy.partUrlTtlMs).toISOString();
    let presigned: Awaited<ReturnType<ArtifactMultipartStorage['presignUploadPart']>>;
    try {
      presigned = await backend.presignUploadPart({
        artifactId,
        tenantId: session.tenantId,
        objectKey: session.storageKey,
        uploadId: providerUploadOf(session),
        partNumber,
        sizeBytes,
        partSha256: declaredSha256,
        expiresAt,
      });
    } catch (error) {
      throw storageToHttp(error, 'presign');
    }
    const requiredHeaders: Record<string, string> = {
      ...(presigned.headers ?? {}),
      'content-length': String(sizeBytes),
    };
    return { artifactId, partNumber, partUrl: presigned.url, sizeBytes, requiredHeaders, expiresAt };
  }

  async function loadDeclarations(
    client: SqlClient,
    artifactId: string,
  ): Promise<DeclaredPart[]> {
    const res = await client.query<{ partNumber: number; declaredSha256: string; sizeBytes: number | string }>(
      `SELECT part_number AS "partNumber", declared_sha256 AS "declaredSha256", size_bytes AS "sizeBytes"
       FROM artifact_multipart_parts WHERE artifact_id=$1 ORDER BY part_number`,
      [artifactId],
    );
    return res.rows.map((row) => ({
      partNumber: Number(row.partNumber),
      declaredSha256: String(row.declaredSha256),
      sizeBytes: Number(row.sizeBytes),
    }));
  }

  /** Client receipts must tile 1..partCount with the server-fixed sizes. */
  function assertReceiptGeometry(receipts: readonly MultipartPartReceipt[], session: Session): void {
    const seen = new Set<number>();
    receipts.forEach((receipt, index) => {
      if (seen.has(receipt.partNumber)) {
        throw conflict('PART_SET_MISMATCH', `part ${receipt.partNumber} is declared more than once`);
      }
      seen.add(receipt.partNumber);
      if (receipt.partNumber !== index + 1) {
        throw conflict('PART_SET_MISMATCH', `parts must cover 1..${session.partCount} in ascending order`);
      }
      if (receipt.sizeBytes !== partSizeOf(session, receipt.partNumber)) {
        throw conflict('PART_SET_MISMATCH', `part ${receipt.partNumber} size does not match the upload geometry`);
      }
    });
    if (receipts.length !== session.partCount) {
      throw conflict('PART_SET_MISMATCH', `expected ${session.partCount} parts, received ${receipts.length}`);
    }
  }

  /** The server's own grant ledger, not the client's claim, defines the set. */
  function assertDeclaredCoverage(declared: readonly DeclaredPart[], session: Session): void {
    const byNumber = new Map(declared.map((part) => [part.partNumber, part]));
    for (let partNumber = 1; partNumber <= session.partCount; partNumber += 1) {
      const part = byNumber.get(partNumber);
      if (!part) {
        throw conflict('PART_SET_MISMATCH', `part ${partNumber} was never granted`);
      }
      if (part.sizeBytes !== partSizeOf(session, partNumber)) {
        throw conflict('PART_SET_MISMATCH', `part ${partNumber} size does not match the upload geometry`);
      }
    }
    if (declared.length !== session.partCount) {
      throw conflict('PART_SET_MISMATCH', 'grant ledger covers part numbers outside the upload geometry');
    }
  }

  function assertReceiptsAgreeWithDeclarations(
    receipts: readonly MultipartPartReceipt[],
    declared: readonly DeclaredPart[],
  ): void {
    const byNumber = new Map(declared.map((part) => [part.partNumber, part]));
    for (const receipt of receipts) {
      const part = byNumber.get(receipt.partNumber)!;
      if (receipt.sha256 !== part.declaredSha256) {
        throw conflict('CHECKSUM_MISMATCH', `part ${receipt.partNumber} hash differs from the granted declaration`);
      }
    }
  }

  /**
   * Storage is authoritative: every part it holds must be one the server
   * granted, with the same size and the same checksum, and the etag the client
   * reports must be the etag storage recorded.
   */
  function assertStoredPartsAgree(
    stored: readonly MultipartStoredPart[],
    declared: readonly DeclaredPart[],
    receipts: readonly MultipartPartReceipt[],
    session: Session,
  ): void {
    const declaredByNumber = new Map(declared.map((part) => [part.partNumber, part]));
    const receiptByNumber = new Map(receipts.map((receipt) => [receipt.partNumber, receipt]));
    if (stored.length !== session.partCount) {
      throw conflict('PART_SET_MISMATCH', `storage holds ${stored.length} parts, the upload geometry has ${session.partCount}`);
    }
    for (const part of stored) {
      const grant = declaredByNumber.get(part.partNumber);
      if (!grant) {
        throw conflict('PART_SET_MISMATCH', `storage holds ungranted part ${part.partNumber}`);
      }
      const expectedSize = partSizeOf(session, part.partNumber);
      if (part.sizeBytes !== expectedSize || grant.sizeBytes !== expectedSize) {
        throw conflict('SIZE_MISMATCH', `part ${part.partNumber} size does not match the upload geometry`);
      }
      if (part.sha256 !== grant.declaredSha256) {
        throw conflict('CHECKSUM_MISMATCH', `part ${part.partNumber} bytes differ from the granted declaration`);
      }
      const receipt = receiptByNumber.get(part.partNumber);
      if (!receipt) {
        throw conflict('PART_SET_MISMATCH', `part ${part.partNumber} is missing from the completed list`);
      }
      if (normalizeEtag(receipt.etag) !== normalizeEtag(part.etag)) {
        throw conflict('PART_SET_MISMATCH', `part ${part.partNumber} etag does not match storage`);
      }
    }
  }

  function normalizeEtag(etag: string): string {
    return etag.replace(/\"/g, '').trim().toLowerCase();
  }

  /** A lifecycle step that talks to the provider needs the stored upload id. */
  function providerUploadOf(session: Session): string {
    if (!session.uploadId) {
      throw conflict('STATE_CONFLICT', 'multipart upload has no open provider session');
    }
    return session.uploadId;
  }

  function initAck(session: Session, replayed: boolean): MultipartInitAck {
    return {
      artifactId: session.artifactId,
      uploadHandle: multipartUploadHandle(providerUploadOf(session)),
      partSizeBytes: session.partSizeBytes,
      partCount: session.partCount,
      expiresAt: new Date(session.expiresAtMs).toISOString(),
      replayed,
    };
  }

  function completeAck(session: Session, replayed: boolean): MultipartCompleteAck {
    return {
      artifactId: session.artifactId,
      sizeBytes: session.declaredSizeBytes,
      sha256: String(session.committedSha256),
      committed: true,
      replayed,
    };
  }

  /**
   * A committed-but-unreferenced generation is deleted before the error is
   * returned: nothing may point at bytes that never passed the commit gate.
   */
  async function deleteUnpublishedVersion(storageKey: string, versionId: string): Promise<void> {
    try {
      await storage?.delete({ objectKey: storageKey, versionId });
    } catch {
      // Cleanup failure must not replace the public result or leak provider text.
    }
  }

  /**
   * The provider phase of completion, shared by both branches. Storage is
   * authoritative: list its parts, agree them with the grant ledger and the
   * client receipts, publish the immutable generation, then re-hash the
   * pinned version whole. The published generation is deleted again whenever
   * a later phase disagrees, so nothing can point at unverified bytes.
   */
  async function publishVerifiedBytes(
    backend: ArtifactMultipartStorage,
    session: Session,
    req: { parts: readonly MultipartPartReceipt[]; sha256: string },
    declared: readonly DeclaredPart[],
  ): Promise<{ versionId: string; pinnedSizeBytes: number; pinnedSha256: string }> {
    let stored: MultipartStoredPart[];
    try {
      stored = await backend.listMultipartParts({
        objectKey: session.storageKey,
        uploadId: providerUploadOf(session),
      });
    } catch (error) {
      throw storageToHttp(error, 'list parts');
    }
    assertStoredPartsAgree(stored, declared, req.parts, session);

    let versionId: string;
    try {
      versionId = (
        await backend.completeMultipartUpload({
          artifactId: session.artifactId,
          tenantId: session.tenantId,
          objectKey: session.storageKey,
          uploadId: providerUploadOf(session),
          parts: stored.map((part) => ({ partNumber: part.partNumber, etag: part.etag })),
        })
      ).versionId;
    } catch (error) {
      throw storageToHttp(error, 'complete');
    }
    if (!versionId || versionId === 'null') {
      throw conflict('STATE_CONFLICT', 'storage published the upload without an immutable version');
    }

    // The published generation is re-hashed whole before anything is
    // recorded, so a lost commit can be replayed without re-verifying bytes.
    let pinnedSizeBytes: number;
    let pinnedSha256: string;
    try {
      const pinned = await backend.verifyAndPin({
        artifactId: session.artifactId,
        tenantId: session.tenantId,
        objectKey: session.storageKey,
        expectedSizeBytes: session.declaredSizeBytes,
        expectedSha256: req.sha256,
      });
      pinnedSizeBytes = pinned.sizeBytes;
      pinnedSha256 = pinned.sha256;
    } catch (error) {
      await deleteUnpublishedVersion(session.storageKey, versionId);
      throw storageToHttp(error, 'verify');
    }
    if (pinnedSizeBytes !== session.declaredSizeBytes || pinnedSha256 !== req.sha256) {
      await deleteUnpublishedVersion(session.storageKey, versionId);
      throw conflict('CHECKSUM_MISMATCH', 'committed bytes do not match the declared whole-object hash');
    }
    return { versionId, pinnedSizeBytes, pinnedSha256 };
  }

  return {
    async init(taskId, body): Promise<MultipartInitAck> {
      const parsed = MultipartInitRequestSchema.safeParse(body);
      if (!parsed.success) throw invalidSchema('init', parsed.error);
      const req = parsed.data;
      const backend = requireStorage();
      if (req.purpose === 'input') {
        throw forbidden('multipart init admits only producer artifact purposes');
      }
      const lease = await assertLease(taskId, req.leaseEpoch);
      if (req.sizeBytes > policy.maxTotalBytes) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the configured multipart size limit');
      }
      const partCount = Math.ceil(req.sizeBytes / policy.partSizeBytes);
      if (partCount > MULTIPART_MAX_PARTS) {
        throw conflict('PARTS_EXCEEDED', `artifact would need ${partCount} parts (max ${MULTIPART_MAX_PARTS})`);
      }

      const existing = await selectSession(`${SESSION_SELECT} WHERE task_id=$1 AND upload_token=$2`, [
        taskId,
        req.uploadToken,
      ]);
      if (existing) {
        assertSameInitParams(existing, req);
        assertSessionLive(existing);
        return initAck(existing, true);
      }

      const artifactId = randomUUID();
      const storageKey = `art-${artifactId}`;
      const expiresAtMs = now() + policy.sessionTtlMs;
      let uploadId: string;
      try {
        uploadId = (
          await backend.createMultipartUpload({
            artifactId,
            tenantId: lease.tenant_id,
            objectKey: storageKey,
            contentType: req.mimeType,
          })
        ).uploadId;
      } catch (error) {
        throw storageToHttp(error, 'create');
      }
      if (!uploadId) throw unavailable('artifact storage is temporarily unavailable');

      // `token` keeps its NOT NULL role for the single-PUT proxy route. This
      // row is never given a method or expiry, so the blob route fails closed
      // on it (CR-12) and the multipart grants stay the only write path.
      const inserted = await db.query(
        `INSERT INTO artifacts (id, tenant_id, operation_id, task_id, purpose, file_name, mime_type,
                               size_bytes, state, token, storage_key, storage_backend,
                               upload_token, multipart_upload_id, part_size_bytes, part_count,
                               multipart_expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'STAGING',$9,$10,'s3',$11,$12,$13,$14,$15)
         ON CONFLICT (task_id, upload_token) WHERE upload_token IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          artifactId,
          lease.tenant_id,
          lease.operation_id,
          taskId,
          req.purpose,
          req.fileName ?? null,
          req.mimeType,
          req.sizeBytes,
          randomUUID(),
          storageKey,
          req.uploadToken,
          uploadId,
          policy.partSizeBytes,
          partCount,
          new Date(expiresAtMs),
        ],
      );
      if (!inserted.rowCount) {
        // Lost the race against a concurrent replay of the same token: keep the
        // winner's session and discard the provider upload just created.
        await backend.abortMultipartUpload({ objectKey: storageKey, uploadId }).catch(() => undefined);
        const winner = await selectSession(`${SESSION_SELECT} WHERE task_id=$1 AND upload_token=$2`, [
          taskId,
          req.uploadToken,
        ]);
        if (!winner) throw conflict('IDEMPOTENCY_CONFLICT', 'multipart upload could not be recorded');
        assertSameInitParams(winner, req);
        assertSessionLive(winner);
        return initAck(winner, true);
      }

      return {
        artifactId,
        uploadHandle: multipartUploadHandle(uploadId),
        partSizeBytes: policy.partSizeBytes,
        partCount,
        expiresAt: new Date(expiresAtMs).toISOString(),
        replayed: false,
      };
    },

    async grantPart(artifactId, body): Promise<MultipartPartGrant> {
      const parsed = MultipartPartGrantRequestSchema.safeParse(body);
      if (!parsed.success) throw invalidSchema('part grant', parsed.error);
      const req = parsed.data;
      const backend = requireStorage();
      const taskId = await ownerTaskOf(artifactId);

      const prepared = await db.tx(async (client) => {
        await lockTask(client, taskId, req.leaseEpoch, { requireRunning: true });
        let session = assertMultipartSession(await lockSession(client, artifactId));
        if (session.taskId !== taskId) throw forbidden('artifact does not belong to task');
        session = assertSessionLive(session);
        if (req.partNumber > session.partCount) {
          throw unprocessable('PART_OUT_OF_RANGE', `part ${req.partNumber} is outside 1..${session.partCount}`);
        }
        const sizeBytes = partSizeOf(session, req.partNumber);
        await insertPartDeclaration(client, artifactId, req.partNumber, req.sha256, sizeBytes);
        return { session, sizeBytes };
      });

      return presignPartGrant(backend, prepared.session, artifactId, req.partNumber, req.sha256, prepared.sizeBytes);
    },

    async complete(artifactId, body): Promise<MultipartCompleteAck> {
      const parsed = MultipartCompleteRequestSchema.safeParse(body);
      if (!parsed.success) throw invalidSchema('complete', parsed.error);
      const req = parsed.data;
      const backend = requireStorage();
      const taskId = await ownerTaskOf(artifactId);

      const opened = await db.tx(async (client) => {
        await lockTask(client, taskId, req.leaseEpoch, { requireRunning: true });
        let session = assertMultipartSession(await lockSession(client, artifactId));
        if (session.taskId !== taskId) throw forbidden('artifact does not belong to task');
        session = assertSessionLive(session);
        if (session.committedVersionId && session.committedSha256) {
          if (session.committedSha256 !== req.sha256) {
            throw conflict('STATE_CONFLICT', 'multipart upload is committed with different integrity metadata');
          }
          return { kind: 'replay' as const, ack: completeAck(session, true) };
        }
        assertReceiptGeometry(req.parts, session);
        const declared = await loadDeclarations(client, artifactId);
        assertDeclaredCoverage(declared, session);
        assertReceiptsAgreeWithDeclarations(req.parts, declared);
        return { kind: 'open' as const, session, declared };
      });
      if (opened.kind === 'replay') return opened.ack;

      const { session, declared } = opened;
      const published = await publishVerifiedBytes(backend, session, req, declared);
      const { versionId, pinnedSizeBytes, pinnedSha256 } = published;

      try {
        const committed = await db.tx(async (client) => {
          await lockTask(client, taskId, req.leaseEpoch, { requireRunning: true });
          const current = assertMultipartSession(await lockSession(client, artifactId));
          if (current.committedVersionId && current.committedSha256 === req.sha256) {
            return { session: current, replayed: true };
          }
          if (current.committedVersionId) {
            throw conflict('STATE_CONFLICT', 'multipart upload committed with different integrity metadata');
          }
          const updated = await client.query(
            `UPDATE artifacts SET storage_version_id=$2, sha256=$3, size_bytes=$4
             WHERE id=$1 AND task_id=$5 AND state='STAGING' AND part_count IS NOT NULL
               AND storage_version_id IS NULL
             RETURNING id`,
            [artifactId, versionId, pinnedSha256, pinnedSizeBytes, taskId],
          );
          if (!updated.rowCount) {
            throw conflict('STATE_CONFLICT', 'multipart upload changed before the commit');
          }
          return {
            session: {
              ...current,
              committedVersionId: versionId,
              committedSha256: pinnedSha256,
              declaredSizeBytes: pinnedSizeBytes,
            } as Session,
            replayed: false,
          };
        });
        if (committed.replayed) await deleteUnpublishedVersion(session.storageKey, versionId);
        return completeAck(committed.session, committed.replayed);
      } catch (error) {
        await deleteUnpublishedVersion(session.storageKey, versionId);
        throw error;
      }
    },

    async abort(artifactId, body): Promise<MultipartAbortAck> {
      const parsed = MultipartAbortRequestSchema.safeParse(body);
      if (!parsed.success) throw invalidSchema('abort', parsed.error);
      const req = parsed.data;
      const backend = requireStorage();
      const taskId = await ownerTaskOf(artifactId);
      const outcome = await abortSession(backend, { artifactId, taskId, leaseEpoch: req.leaseEpoch, reason: req.reason });
      return { artifactId, state: 'ABORTED', replayed: outcome.replayed };
    },

    async sweepExpiredSessions(sweep = {}): Promise<MultipartSweepSummary> {
      const backend = requireStorage();
      const nowMs = sweep.nowMs ?? now();
      const limit = Math.min(Math.max(Math.trunc(sweep.limit ?? 50), 1), 1000);
      const candidates = await db.query<SessionRow>(
        `${SESSION_SELECT}
         WHERE part_count IS NOT NULL
           AND ((state='STAGING' AND multipart_expires_at IS NOT NULL AND multipart_expires_at <= $1)
                OR (state='ABORTED' AND multipart_upload_id IS NOT NULL))
         ORDER BY multipart_expires_at
         LIMIT $2`,
        [new Date(nowMs), limit],
      );
      const summary: MultipartSweepSummary = { scanned: candidates.rowCount ?? 0, aborted: 0, purged: 0, failed: 0 };
      for (const row of candidates.rows) {
        const session = toSession(row);
        if (!session) continue;
        try {
          if (session.state === 'STAGING') {
            // The lease is gone by definition (the session is past its TTL), so
            // the sweep marks the row terminal under its own lock instead of
            // pretending a producer fence still applies.
            const claimed = await db.tx(async (client) => {
              const current = assertMultipartSession(await lockSession(client, session.artifactId));
              if (current.state !== 'STAGING') return null;
              const updated = await client.query<{ uploadId: string | null }>(
                `UPDATE artifacts SET state='ABORTED', abort_reason='expired'
                 WHERE id=$1 AND state='STAGING' AND part_count IS NOT NULL
                 RETURNING multipart_upload_id AS "uploadId"`,
                [session.artifactId],
              );
              return updated.rowCount ? { uploadId: String(updated.rows[0]!.uploadId ?? current.uploadId), current } : null;
            });
            if (!claimed) continue;
            summary.aborted += 1;
          }
          if (await purgeSessionStorage(backend, session.artifactId)) summary.purged += 1;
        } catch {
          summary.failed += 1;
        }
      }
      return summary;
    },

    async publicInit(tenantId, body): Promise<MultipartInitAck> {
      const parsed = PublicMultipartInitRequestSchema.safeParse(body);
      if (!parsed.success) throw invalidSchema('uploads init', parsed.error);
      const req = parsed.data;
      const backend = requireStorage();
      if (req.sizeBytes > policy.maxTotalBytes) {
        throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'artifact exceeds the configured multipart size limit');
      }
      const partCount = Math.ceil(req.sizeBytes / policy.partSizeBytes);
      if (partCount > MULTIPART_MAX_PARTS) {
        throw conflict('PARTS_EXCEEDED', `artifact would need ${partCount} parts (max ${MULTIPART_MAX_PARTS})`);
      }
      const selectPublicToken = `${SESSION_SELECT} WHERE tenant_id=$1 AND upload_token=$2 AND task_id IS NULL`;
      const publicParams = { purpose: 'input', mimeType: req.mimeType, fileName: req.fileName, sizeBytes: req.sizeBytes };

      const existing = await selectSession(selectPublicToken, [tenantId, req.uploadToken]);
      if (existing) {
        assertSameInitParams(existing, publicParams);
        assertSessionLive(existing);
        return initAck(existing, true);
      }

      const artifactId = randomUUID();
      const storageKey = `art-${artifactId}`;
      const expiresAtMs = now() + policy.sessionTtlMs;
      let uploadId: string;
      try {
        uploadId = (
          await backend.createMultipartUpload({
            artifactId,
            tenantId,
            objectKey: storageKey,
            contentType: req.mimeType,
          })
        ).uploadId;
      } catch (error) {
        throw storageToHttp(error, 'create');
      }
      if (!uploadId) throw unavailable('artifact storage is temporarily unavailable');

      // operation_id and task_id stay NULL: this is the public branch's
      // signature, and the runtime fences (ownerTaskOf, the auth JOINs) then
      // make the row structurally unreachable from the worker lifecycle.
      const inserted = await db.query(
        `INSERT INTO artifacts (id, tenant_id, purpose, file_name, mime_type, size_bytes,
                               state, token, storage_key, storage_backend,
                               upload_token, multipart_upload_id, part_size_bytes, part_count,
                               multipart_expires_at)
         VALUES ($1,$2,'input',$3,$4,$5,'STAGING',$6,$7,'s3',$8,$9,$10,$11,$12)
         ON CONFLICT (tenant_id, upload_token) WHERE task_id IS NULL AND upload_token IS NOT NULL DO NOTHING
         RETURNING id`,
        [
          artifactId,
          tenantId,
          req.fileName ?? null,
          req.mimeType,
          req.sizeBytes,
          randomUUID(),
          storageKey,
          req.uploadToken,
          uploadId,
          policy.partSizeBytes,
          partCount,
          new Date(expiresAtMs),
        ],
      );
      if (!inserted.rowCount) {
        // Lost the race against a concurrent replay of the same key: keep the
        // winner's session and discard the provider upload just created.
        await backend.abortMultipartUpload({ objectKey: storageKey, uploadId }).catch(() => undefined);
        const winner = await selectSession(selectPublicToken, [tenantId, req.uploadToken]);
        if (!winner) throw conflict('IDEMPOTENCY_CONFLICT', 'multipart upload could not be recorded');
        assertSameInitParams(winner, publicParams);
        assertSessionLive(winner);
        return initAck(winner, true);
      }

      return {
        artifactId,
        uploadHandle: multipartUploadHandle(uploadId),
        partSizeBytes: policy.partSizeBytes,
        partCount,
        expiresAt: new Date(expiresAtMs).toISOString(),
        replayed: false,
      };
    },

    async publicGrantPart(artifactId, tenantId, body): Promise<MultipartPartGrant> {
      const parsed = PublicMultipartPartGrantRequestSchema.safeParse(body);
      if (!parsed.success) throw invalidSchema('uploads part grant', parsed.error);
      const req = parsed.data;
      const backend = requireStorage();
      const prepared = await db.tx(async (client) => {
        const session = assertSessionLive(lockPublicSession(await lockSessionTenant(client, artifactId, tenantId)));
        if (req.partNumber > session.partCount) {
          throw unprocessable('PART_OUT_OF_RANGE', `part ${req.partNumber} is outside 1..${session.partCount}`);
        }
        const sizeBytes = partSizeOf(session, req.partNumber);
        await insertPartDeclaration(client, artifactId, req.partNumber, req.sha256, sizeBytes);
        return { session, sizeBytes };
      });
      return presignPartGrant(backend, prepared.session, artifactId, req.partNumber, req.sha256, prepared.sizeBytes);
    },

    async publicComplete(artifactId, tenantId, body): Promise<MultipartCompleteAck> {
      const parsed = PublicMultipartCompleteRequestSchema.safeParse(body);
      if (!parsed.success) throw invalidSchema('uploads complete', parsed.error);
      const req = parsed.data;
      const backend = requireStorage();
      const opened = await db.tx(async (client) => {
        const session = lockPublicSession(await lockSessionTenant(client, artifactId, tenantId));
        // The replay branch runs BEFORE the liveness gate on this branch: a
        // completed public upload is READY (there is no later finalize to
        // wait for), so a lost response must stay replayable after the
        // session TTL too — the commit is durable and byte-verified.
        if (session.committedVersionId && session.committedSha256) {
          if (session.committedSha256 !== req.sha256) {
            throw conflict('STATE_CONFLICT', 'multipart upload is committed with different integrity metadata');
          }
          return { kind: 'replay' as const, ack: completeAck(session, true) };
        }
        assertSessionLive(session);
        assertReceiptGeometry(req.parts, session);
        const declared = await loadDeclarations(client, artifactId);
        assertDeclaredCoverage(declared, session);
        assertReceiptsAgreeWithDeclarations(req.parts, declared);
        return { kind: 'open' as const, session, declared };
      });
      if (opened.kind === 'replay') return opened.ack;

      const { session, declared } = opened;
      const { versionId, pinnedSizeBytes, pinnedSha256 } =
        await publishVerifiedBytes(backend, session, req, declared);

      try {
        const committed = await db.tx(async (client) => {
          const current = lockPublicSession(await lockSessionTenant(client, artifactId, tenantId));
          if (current.committedVersionId && current.committedSha256 === req.sha256) {
            return { session: current, replayed: true };
          }
          if (current.committedVersionId) {
            throw conflict('STATE_CONFLICT', 'multipart upload committed with different integrity metadata');
          }
          // Public finalize: the verified commit IS the STAGING -> READY
          // edge for this branch (no producer lease exists to prove on the
          // runtime finalize route). The submit guard still only admits READY.
          const updated = await client.query(
            `UPDATE artifacts SET state='READY', storage_version_id=$3, sha256=$4, size_bytes=$5
             WHERE id=$1 AND tenant_id=$2 AND task_id IS NULL AND state='STAGING' AND part_count IS NOT NULL
               AND storage_version_id IS NULL
             RETURNING id`,
            [artifactId, tenantId, versionId, pinnedSha256, pinnedSizeBytes],
          );
          if (!updated.rowCount) {
            throw conflict('STATE_CONFLICT', 'multipart upload changed before the commit');
          }
          return {
            session: {
              ...current,
              committedVersionId: versionId,
              committedSha256: pinnedSha256,
              declaredSizeBytes: pinnedSizeBytes,
            } as Session,
            replayed: false,
          };
        });
        if (committed.replayed) await deleteUnpublishedVersion(session.storageKey, versionId);
        return completeAck(committed.session, committed.replayed);
      } catch (error) {
        await deleteUnpublishedVersion(session.storageKey, versionId);
        throw error;
      }
    },

    async publicAbort(artifactId, tenantId, body): Promise<MultipartAbortAck> {
      const parsed = PublicMultipartAbortRequestSchema.safeParse(body);
      if (!parsed.success) throw invalidSchema('uploads abort', parsed.error);
      const req = parsed.data;
      const backend = requireStorage();
      const claimed = await db.tx(async (client) => {
        const session = lockPublicSession(await lockSessionTenant(client, artifactId, tenantId));
        if (session.state === 'ABORTED') return { replayed: true };
        // A READY public artifact passed the verification gate; its bytes are
        // live input for submissions and are never purged through this door
        // (same invariant as the runtime abort of a finalized artifact).
        if (session.state !== 'STAGING') {
          throw conflict('STATE_CONFLICT', `multipart upload is ${session.state} and cannot be aborted`);
        }
        const updated = await client.query(
          `UPDATE artifacts SET state='ABORTED', abort_reason=$2
           WHERE id=$1 AND tenant_id=$3 AND task_id IS NULL AND state='STAGING' AND part_count IS NOT NULL`,
          [artifactId, req.reason, tenantId],
        );
        if (!updated.rowCount) {
          throw conflict('STATE_CONFLICT', 'multipart upload changed before the abort');
        }
        return { replayed: false };
      });
      // Mark-then-purge, exactly like the runtime abort: the row is terminal
      // before any byte is dropped; a crash between is finished by the sweep.
      await purgeSessionStorage(backend, artifactId);
      return { artifactId, state: 'ABORTED', replayed: claimed.replayed };
    },
  };

  /* ------------------------------------------------------------------ */
  /* abort / cleanup shared by the route and the sweeper                 */
  /* ------------------------------------------------------------------ */

  /**
   * Marks the row ABORTED first, then purges storage. A crash between the two
   * leaves `multipart_upload_id` set, which is exactly what
   * `sweepExpiredSessions` looks for to finish the cleanup.
   */
  async function abortSession(
    backend: ArtifactMultipartStorage,
    input: { artifactId: string; taskId: string; leaseEpoch: number; reason: string },
  ): Promise<{ replayed: boolean }> {
    const claimed = await db.tx(async (client) => {
      await lockTask(client, input.taskId, input.leaseEpoch, { requireRunning: false });
      const session = assertMultipartSession(await lockSession(client, input.artifactId));
      if (session.taskId !== input.taskId) throw forbidden('artifact does not belong to task');
      if (session.state === 'ABORTED') return { session, replayed: true };
      if (session.state !== 'STAGING') {
        throw conflict('STATE_CONFLICT', `multipart upload is ${session.state} and cannot be aborted`);
      }
      const updated = await client.query(
        `UPDATE artifacts SET state='ABORTED', abort_reason=$2
         WHERE id=$1 AND task_id=$3 AND state='STAGING' AND part_count IS NOT NULL`,
        [input.artifactId, input.reason, input.taskId],
      );
      if (!updated.rowCount) {
        throw conflict('STATE_CONFLICT', 'multipart upload changed before the abort');
      }
      return { session, replayed: false };
    });
    // Mark-then-purge: the row is terminal before any byte is dropped, so a
    // concurrent complete can never commit against a row being aborted.
    await purgeSessionStorage(backend, input.artifactId);
    return { replayed: claimed.replayed };
  }

  /** Best-effort storage cleanup for one ABORTED row; true when it completed. */
  async function purgeSessionStorage(backend: ArtifactMultipartStorage, artifactId: string): Promise<boolean> {
    const res = await db.query<SessionRow>(`${SESSION_SELECT} WHERE id=$1`, [artifactId]);
    const session = res.rowCount ? toSession(res.rows[0] as SessionRow) : null;
    if (!session) return false;
    let clean = true;
    if (session.committedVersionId) {
      try {
        await backend.delete({ objectKey: session.storageKey, versionId: session.committedVersionId });
      } catch {
        clean = false;
      }
    }
    if (session.uploadId) {
      try {
        await backend.abortMultipartUpload({ objectKey: session.storageKey, uploadId: session.uploadId });
      } catch {
        clean = false;
      }
    }
    if (clean) {
      await db.query(`UPDATE artifacts SET multipart_upload_id=NULL WHERE id=$1 AND state='ABORTED'`, [artifactId]);
    }
    return clean;
  }
}

function assertSameInitParams(
  session: Session,
  req: { purpose: string; mimeType: string; fileName?: string; sizeBytes: number; partSizeBytes?: number },
): void {
  if (
    session.purpose !== req.purpose ||
    session.mimeType !== req.mimeType ||
    (session.fileName ?? undefined) !== req.fileName ||
    session.declaredSizeBytes !== req.sizeBytes
  ) {
    throw conflict('IDEMPOTENCY_CONFLICT', 'uploadToken is already bound to different upload parameters');
  }
}

/** Stable HTTP failures; provider exception text never reaches a response. */
function storageToHttp(error: unknown, step: string): HttpError {
  if (error instanceof ArtifactStorageError) {
    switch (error.code) {
      case 'INVALID_UPLOAD_GRANT':
        return unprocessable('INVALID_STORAGE_GRANT', `multipart ${step}: storage rejected the grant`);
      case 'SIZE_MISMATCH':
        return conflict('SIZE_MISMATCH', `multipart ${step}: stored bytes do not match the declared size`);
      case 'CHECKSUM_MISMATCH':
        return conflict('CHECKSUM_MISMATCH', `multipart ${step}: stored bytes do not match the declared hash`);
      case 'OBJECT_NOT_FOUND':
        return conflict('PART_SET_MISMATCH', `multipart ${step}: storage holds no bytes for this upload`);
      case 'OBJECT_VERSION_REQUIRED':
      case 'ARTIFACT_METADATA_MISMATCH':
      case 'TENANT_METADATA_MISMATCH':
        return conflict('STATE_CONFLICT', `multipart ${step}: storage metadata could not be verified`);
      case 'INVALID_OBJECT_BODY':
      case 'STORAGE_UNAVAILABLE':
        return unavailable(`multipart ${step}: artifact storage is temporarily unavailable`);
    }
  }
  return unavailable(`multipart ${step}: artifact storage is temporarily unavailable`);
}
