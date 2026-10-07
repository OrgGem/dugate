import { createHash } from 'node:crypto';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import {
  MULTIPART_FIXED_PART_BYTES,
  MultipartAbortAckSchema,
  MultipartCompleteAckSchema,
  MultipartInitAckSchema,
  MultipartPartGrantSchema,
} from '@du/contracts';
import type { MultipartPartReceipt } from '@du/contracts';
import type { Db } from '../../src/db/db';
import { createMultipartService, type MultipartServiceOptions } from '../../src/modules/artifacts/multipart-service';
import type {
  ArtifactMultipartStorage,
  CompleteMultipartUploadInput,
  CreateMultipartUploadInput,
  MultipartStoredPart,
  MultipartUploadLocator,
  PresignMultipartPartInput,
} from '../../src/modules/artifacts/multipart-storage';
import {
  ArtifactStorageError,
  type ArtifactStorageErrorCode,
  type ArtifactStorageUploadGrant,
  type StoredArtifactVersion,
  type VerifyAndPinArtifactInput,
} from '../../src/modules/artifacts/storage-facade';

export const ARTIFACT_ID = '55555555-5555-4555-8555-555555555555';

/**
 * DATA-02 multipart lifecycle service tests (Qwen-5) — offline, in-memory rows
 * plus an in-memory multipart storage port. Zero DB/Redis/network: the port
 * fake decides what storage holds, so every size/hash/etag disagreement below
 * exercises the service's own guard rather than a provider behaviour. Real S3
 * command wiring is covered by s3-multipart-storage-offline.test.ts.
 */

export const TASK_ID = '11111111-1111-4111-8111-111111111111';
export const DONE_TASK_ID = '11111111-1111-4111-8111-111111111122';
export const TENANT_ID = '22222222-2222-4222-8222-222222222222';
export const OPERATION_ID = '33333333-3333-4333-8333-333333333333';
export const UPLOAD_TOKEN = '44444444-4444-4444-8444-444444444444';
export const SIZE_70MIB = 70 * 1024 * 1024;
export const LEASE_EPOCH = 5;

export const clock = { ms: Date.parse('2026-09-25T00:00:00.000Z') };

export function initBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    leaseEpoch: LEASE_EPOCH,
    uploadToken: UPLOAD_TOKEN,
    purpose: 'output',
    mimeType: 'application/pdf',
    sizeBytes: SIZE_70MIB,
    ...overrides,
  };
}

/** Public-branch init body: no leaseEpoch, no purpose (the server forces input). */
export function publicInitBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    uploadToken: UPLOAD_TOKEN,
    mimeType: 'application/pdf',
    fileName: 'fixture.pdf',
    sizeBytes: SIZE_70MIB,
    ...overrides,
  };
}

export function partHash(partNumber: number): string {
  return partNumber.toString(16).padStart(64, '0');
}

export function wholeHash(seed: string): string {
  return createHash('sha256').update(seed).digest('hex');
}

interface MemoryArtifact {
  id: string;
  tenantId: string;
  /** Null on the public branch: a client upload has no operation or task. */
  operationId: string | null;
  taskId: string | null;
  purpose: string;
  fileName: string | null;
  mimeType: string;
  sizeBytes: number;
  state: string;
  storageKey: string;
  uploadToken: string | null;
  uploadId: string | null;
  partSizeBytes: number | null;
  partCount: number | null;
  committedVersionId: string | null;
  sha256: string | null;
  abortReason: string | null;
  expiresAt: Date;
}

interface LedgerPart {
  declaredSha256: string;
  sizeBytes: number;
}

/** In-memory rows addressed by the same SQL text the production service emits. */
class OfflineMultipartDb {
  readonly artifacts = new Map<string, MemoryArtifact>();
  readonly ledger = new Map<string, Map<number, LedgerPart>>();
  readonly tasks = new Map<string, { leaseEpoch: number; state: string; leaseActive: boolean }>([
    [TASK_ID, { leaseEpoch: LEASE_EPOCH, state: 'RUNNING', leaseActive: true }],
    [DONE_TASK_ID, { leaseEpoch: LEASE_EPOCH, state: 'SUCCEEDED', leaseActive: true }],
  ]);

  addArtifact(partial: Partial<MemoryArtifact> & { id: string }): MemoryArtifact {
    const row: MemoryArtifact = {
      tenantId: TENANT_ID, operationId: OPERATION_ID, taskId: TASK_ID, purpose: 'output',
      fileName: null, mimeType: 'application/pdf', sizeBytes: 1024, state: 'STAGING',
      storageKey: 'art-' + partial.id, uploadToken: null, uploadId: null, partSizeBytes: null,
      partCount: null, committedVersionId: null, sha256: null, abortReason: null,
      expiresAt: new Date(clock.ms + 3_600_000),
      ...partial,
    };
    this.artifacts.set(row.id, row);
    return row;
  }

  /** A row written by the unchanged single-PUT branch: no multipart columns. */
  addSinglePutArtifact(id: string): MemoryArtifact {
    return this.addArtifact({ id });
  }

  ledgerOf(artifactId: string): Map<number, LedgerPart> {
    let entries = this.ledger.get(artifactId);
    if (!entries) {
      entries = new Map();
      this.ledger.set(artifactId, entries);
    }
    return entries;
  }

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params: unknown[] = []): Promise<QueryResult<T>> {
    return this.execute(text, params) as unknown as QueryResult<T>;
  }

  private async execute(text: string, params: unknown[]): Promise<QueryResult<QueryResultRow>> {
    const sql = text.replace(/\s+/g, ' ').trim().toUpperCase();
    const args = params;

    if (sql.startsWith('INSERT INTO ARTIFACT_MULTIPART_PARTS')) {
      const [artifactId, partNumber, declaredSha256, sizeBytes] = args as [string, number, string, number];
      const ledger = this.ledgerOf(String(artifactId));
      const key = Number(partNumber);
      // RFX-07: this INSERT is `ON CONFLICT ... DO NOTHING RETURNING part_number`.
      // The fake used to overwrite unconditionally, which mirrored the OLD
      // DO UPDATE and hid the whole defect. A second grant for the same part must
      // return NO row and must leave the first declaration untouched.
      if (ledger.has(key)) return this.result([], 'INSERT');
      ledger.set(key, {
        declaredSha256: String(declaredSha256),
        sizeBytes: Number(sizeBytes),
      });
      return this.result([{ part_number: key }], 'INSERT');
    }
    if (sql.startsWith('SELECT DECLARED_SHA256 AS "DECLAREDSHA256"')) {
      const part = this.ledgerOf(String(args[0])).get(Number(args[1]));
      return this.result(part ? [{ declaredSha256: part.declaredSha256, sizeBytes: part.sizeBytes }] : []);
    }
    if (sql.startsWith('SELECT PART_NUMBER AS "PARTNUMBER", DECLARED_SHA256')) {
      const entries = this.ledger.get(String(args[0]));
      const rows = entries
        ? [...entries.entries()]
            .sort((a, b) => a[0] - b[0])
            .map(([partNumber, part]) => ({
              partNumber, declaredSha256: part.declaredSha256, sizeBytes: part.sizeBytes,
            }))
        : [];
      return this.result(rows);
    }
    if (sql.includes('ARTIFACT_MULTIPART_PARTS')) throw new Error('unhandled ledger SQL: ' + sql.slice(0, 90));

    if (sql.startsWith('INSERT INTO ARTIFACTS')) {
      if (sql.includes("'INPUT'")) {
        // Public-branch insert: purpose is a SQL literal, operation_id/task_id
        // are absent (NULL), and the replay key is (tenant, token) with no task.
        const [id, tenantId, fileName, mimeType, sizeBytes, , storageKey,
          uploadToken, uploadId, partSizeBytes, partCount, expiresAt] = args as [
          string, string, string | null, string, number, string, string,
          string, string, number, number, Date,
        ];
        const replayKey = tenantId + ':' + uploadToken;
        const clash = [...this.artifacts.values()].some(
          (row) => row.taskId === null && row.tenantId + ':' + row.uploadToken === replayKey,
        );
        if (clash) return this.result([], 'INSERT'); // ON CONFLICT DO NOTHING
        this.artifacts.set(String(id), {
          id: String(id), tenantId: String(tenantId), operationId: null, taskId: null,
          purpose: 'input', fileName: fileName === undefined ? null : fileName, mimeType: String(mimeType),
          sizeBytes: Number(sizeBytes), state: 'STAGING', storageKey: String(storageKey),
          uploadToken: String(uploadToken), uploadId: String(uploadId), partSizeBytes: Number(partSizeBytes),
          partCount: Number(partCount), committedVersionId: null, sha256: null, abortReason: null,
          expiresAt,
        });
        return this.result([{ id: String(id) }], 'INSERT');
      }
      const [id, tenantId, operationId, taskId, purpose, fileName, mimeType, sizeBytes, , storageKey,
        uploadToken, uploadId, partSizeBytes, partCount, expiresAt] = args as [
        string, string, string, string, string, string | null, string, number, string, string,
        string, string, number, number, Date,
      ];
      const replayKey = taskId + ':' + uploadToken;
      const clash = [...this.artifacts.values()].some((row) => row.taskId + ':' + row.uploadToken === replayKey);
      if (clash) return this.result([], 'INSERT'); // ON CONFLICT DO NOTHING
      this.artifacts.set(String(id), {
        id: String(id), tenantId: String(tenantId), operationId: String(operationId), taskId: String(taskId),
        purpose: String(purpose), fileName: fileName === undefined ? null : fileName, mimeType: String(mimeType),
        sizeBytes: Number(sizeBytes), state: 'STAGING', storageKey: String(storageKey),
        uploadToken: String(uploadToken), uploadId: String(uploadId), partSizeBytes: Number(partSizeBytes),
        partCount: Number(partCount), committedVersionId: null, sha256: null, abortReason: null,
        expiresAt,
      });
      return this.result([{ id: String(id) }], 'INSERT');
    }
    if (sql.startsWith('SELECT TASK_ID')) {
      const row = this.artifacts.get(String(args[0]));
      return this.result(row ? [{ taskId: row.taskId }] : []);
    }
    if (sql.includes('FROM TASKS T JOIN OPERATIONS O')) {
      const task = this.tasks.get(String(args[0]));
      if (!task) return this.result([]);
      return this.result([{ lease_epoch: task.leaseEpoch, operation_id: OPERATION_ID, tenant_id: TENANT_ID }]);
    }
    if (sql.includes('FROM TASKS WHERE ID=$1 FOR UPDATE')) {
      const task = this.tasks.get(String(args[0]));
      if (!task) return this.result([]);
      return this.result([{ lease_epoch: task.leaseEpoch, state: task.state, lease_active: task.leaseActive }]);
    }
    if (sql.includes('ORDER BY MULTIPART_EXPIRES_AT')) {
      const cutoff = (args[0] as Date).getTime();
      const limit = Number(args[1]);
      const rows = [...this.artifacts.values()]
        .filter((row) => row.partCount !== null && (
          (row.state === 'STAGING' && row.expiresAt.getTime() <= cutoff)
          || (row.state === 'ABORTED' && row.uploadId !== null)
        ))
        .sort((a, b) => a.expiresAt.getTime() - b.expiresAt.getTime())
        .slice(0, limit)
        .map((row) => this.project(row));
      return this.result(rows);
    }
    if (sql.startsWith('UPDATE ARTIFACTS SET STORAGE_VERSION_ID')) {
      const [id, versionId, sha256, sizeBytes, taskId] = args as [string, string, string, number, string];
      const row = this.artifacts.get(String(id));
      if (!row || row.state !== 'STAGING' || row.taskId !== taskId || row.partCount === null || row.committedVersionId) {
        return this.result([], 'UPDATE');
      }
      row.committedVersionId = String(versionId);
      row.sha256 = String(sha256);
      row.sizeBytes = Number(sizeBytes);
      return this.result([{ id: row.id }], 'UPDATE');
    }
    if (sql.includes("SET STATE='ABORTED', ABORT_REASON='EXPIRED'")) {
      const row = this.artifacts.get(String(args[0]));
      if (!row || row.state !== 'STAGING' || row.partCount === null) return this.result([], 'UPDATE');
      row.state = 'ABORTED';
      row.abortReason = 'expired';
      return this.result([{ uploadId: row.uploadId }], 'UPDATE');
    }
    if (sql.includes("SET STATE='ABORTED', ABORT_REASON=$2") && sql.includes('TENANT_ID=$3')) {
      const [id, reason, tenantId] = args as [string, string, string];
      const row = this.artifacts.get(String(id));
      if (
        !row || row.state !== 'STAGING' || row.taskId !== null || row.tenantId !== tenantId
        || row.partCount === null
      ) {
        return this.result([], 'UPDATE');
      }
      row.state = 'ABORTED';
      row.abortReason = String(reason);
      return this.result([{ id: row.id }], 'UPDATE');
    }
    if (sql.includes("SET STATE='ABORTED', ABORT_REASON=$2")) {
      const [id, reason, taskId] = args as [string, string, string];
      const row = this.artifacts.get(String(id));
      if (!row || row.state !== 'STAGING' || row.taskId !== taskId || row.partCount === null) return this.result([], 'UPDATE');
      row.state = 'ABORTED';
      row.abortReason = String(reason);
      return this.result([{ id: row.id }], 'UPDATE');
    }
    if (sql.startsWith("UPDATE ARTIFACTS SET STATE='READY', STORAGE_VERSION_ID")) {
      const [id, tenantId, versionId, sha256, sizeBytes] = args as [string, string, string, string, number];
      const row = this.artifacts.get(String(id));
      if (
        !row || row.state !== 'STAGING' || row.taskId !== null || row.tenantId !== tenantId
        || row.partCount === null || row.committedVersionId
      ) {
        return this.result([], 'UPDATE');
      }
      row.state = 'READY';
      row.committedVersionId = String(versionId);
      row.sha256 = String(sha256);
      row.sizeBytes = Number(sizeBytes);
      return this.result([{ id: row.id }], 'UPDATE');
    }
    if (sql.startsWith('UPDATE ARTIFACTS SET MULTIPART_UPLOAD_ID=NULL')) {
      const row = this.artifacts.get(String(args[0]));
      if (row && row.state === 'ABORTED') row.uploadId = null;
      return this.result([], 'UPDATE');
    }
    if (sql.includes('FROM ARTIFACTS')) {
      if (sql.includes('WHERE TENANT_ID=$1 AND UPLOAD_TOKEN=$2 AND TASK_ID IS NULL')) {
        const [tenantId, token] = args as [string, string];
        const row = [...this.artifacts.values()].find(
          (r) => r.taskId === null && r.tenantId === tenantId && r.uploadToken === token,
        );
        return this.result(row ? [this.project(row)] : []);
      }
      if (sql.includes('WHERE ID=$1 AND TENANT_ID=$2 FOR UPDATE')) {
        const [id, tenantId] = args as [string, string];
        const row = this.artifacts.get(String(id));
        return this.result(row && row.tenantId === tenantId ? [this.project(row)] : []);
      }
      if (sql.includes('WHERE TASK_ID=$1 AND UPLOAD_TOKEN=$2')) {
        const [taskId, token] = args as [string, string];
        const row = [...this.artifacts.values()].find((r) => r.taskId === taskId && r.uploadToken === token);
        return this.result(row ? [this.project(row)] : []);
      }
      if (sql.includes('WHERE ID=$1 FOR UPDATE')) {
        const row = this.artifacts.get(String(args[0]));
        return this.result(row ? [this.project(row)] : []);
      }
      if (sql.includes('WHERE ID=$1')) {
        const row = this.artifacts.get(String(args[0]));
        return this.result(row ? [this.project(row)] : []);
      }
    }
    throw new Error('unhandled offline multipart SQL: ' + sql.slice(0, 110));
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    return fn({ query: this.query.bind(this) } as unknown as PoolClient);
  }

  async close(): Promise<void> { return undefined; }

  get pool(): never {
    throw new Error('the offline db has no pool');
  }

  private project(row: MemoryArtifact): QueryResultRow {
    return {
      artifactId: row.id, tenantId: row.tenantId, operationId: row.operationId, taskId: row.taskId,
      purpose: row.purpose, fileName: row.fileName, mimeType: row.mimeType, sizeBytes: row.sizeBytes,
      state: row.state, storageKey: row.storageKey, uploadToken: row.uploadToken, uploadId: row.uploadId,
      partSizeBytes: row.partSizeBytes, partCount: row.partCount, committedVersionId: row.committedVersionId,
      committedSha256: row.sha256, expiresAt: row.expiresAt,
    };
  }

  private result(rows: QueryResultRow[], command = 'SELECT'): QueryResult<QueryResultRow> {
    return { command, rowCount: rows.length, oid: 0, fields: [], rows };
  }
}

/** One part exactly as the fake backend holds it after a presigned PUT. */
interface FakePart {
  partNumber: number;
  etag: string;
  sizeBytes: number;
  sha256: string;
}

interface FakeUpload {
  objectKey: string;
  uploadId: string;
  metadata: { artifactId: string; tenantId: string; contentType: string };
  parts: Map<number, FakePart>;
  state: 'OPEN' | 'COMPLETED' | 'ABORTED';
  versionId: string | null;
}

/**
 * In-memory stand-in for the multipart storage port. It is deliberately
 * strict about what it holds: a part PUT only lands against an open upload,
 * completion returns a version only for a part set it accepts, and every
 * disagreement is reported as a stable ArtifactStorageError code.
 */
export class FakeMultipartStorage implements ArtifactMultipartStorage {
  readonly uploads = new Map<string, FakeUpload>();
  readonly createCalls: CreateMultipartUploadInput[] = [];
  readonly presignCalls: PresignMultipartPartInput[] = [];
  readonly listCalls: MultipartUploadLocator[] = [];
  readonly completeCalls: CompleteMultipartUploadInput[] = [];
  readonly abortCalls: MultipartUploadLocator[] = [];
  readonly verifyCalls: VerifyAndPinArtifactInput[] = [];
  readonly deletedVersions: string[] = [];
  /** Set to make verifyAndPin report a different whole-object hash. */
  verifySha256: string | null = null;
  /** Set to make verifyAndPin fail with this storage code. */
  verifyFailure: ArtifactStorageErrorCode | null = null;
  private nextUpload = 0;
  private nextVersion = 0;

  createMultipartUpload = async (input: CreateMultipartUploadInput): Promise<{ uploadId: string }> => {
    this.createCalls.push(input);
    this.nextUpload += 1;
    const uploadId = 'provider-upload-' + this.nextUpload;
    this.uploads.set(uploadId, {
      objectKey: input.objectKey,
      uploadId,
      metadata: { artifactId: input.artifactId, tenantId: input.tenantId, contentType: input.contentType },
      parts: new Map(),
      state: 'OPEN',
      versionId: null,
    });
    return { uploadId };
  };

  presignUploadPart = async (input: PresignMultipartPartInput): Promise<ArtifactStorageUploadGrant> => {
    this.presignCalls.push(input);
    const upload = this.openUpload(input.uploadId, input.objectKey);
    const expiresAt = input.expiresAt;
    return {
      url: 'https://storage.test/' + upload.objectKey + '?upload=' + upload.uploadId + '&part=' + input.partNumber,
      expiresAt,
      headers: {
        'content-length': String(input.sizeBytes),
        'x-amz-checksum-sha256': Buffer.from(input.partSha256, 'hex').toString('base64'),
      },
    };
  };

  listMultipartParts = async (input: MultipartUploadLocator): Promise<MultipartStoredPart[]> => {
    this.listCalls.push(input);
    const upload = this.uploads.get(input.uploadId);
    if (!upload || upload.objectKey !== input.objectKey) throw new ArtifactStorageError('OBJECT_NOT_FOUND');
    if (upload.state !== 'OPEN') throw new ArtifactStorageError('OBJECT_NOT_FOUND');
    return [...upload.parts.values()]
      .sort((a, b) => a.partNumber - b.partNumber)
      .map((part) => ({ ...part }));
  };

  completeMultipartUpload = async (input: CompleteMultipartUploadInput): Promise<{ versionId: string }> => {
    this.completeCalls.push(input);
    const upload = this.openUpload(input.uploadId, input.objectKey);
    if (input.parts.length !== upload.parts.size) throw new ArtifactStorageError('STORAGE_UNAVAILABLE');
    for (const part of input.parts) {
      const held = upload.parts.get(part.partNumber);
      if (!held || held.etag !== part.etag) throw new ArtifactStorageError('STORAGE_UNAVAILABLE');
    }
    this.nextVersion += 1;
    upload.state = 'COMPLETED';
    upload.versionId = 'v' + this.nextVersion;
    return { versionId: upload.versionId };
  };

  abortMultipartUpload = async (input: MultipartUploadLocator): Promise<void> => {
    this.abortCalls.push(input);
    const upload = this.uploads.get(input.uploadId);
    if (!upload) return; // idempotent: storage already discarded it
    upload.state = 'ABORTED';
    upload.parts.clear();
  };

  verifyAndPin = async (input: VerifyAndPinArtifactInput): Promise<StoredArtifactVersion> => {
    this.verifyCalls.push(input);
    if (this.verifyFailure) throw new ArtifactStorageError(this.verifyFailure);
    const upload = this.completedUpload(input.objectKey);
    const sizeBytes = [...upload.parts.values()].reduce((total, part) => total + part.sizeBytes, 0);
    return {
      objectKey: input.objectKey,
      versionId: String(upload.versionId),
      sizeBytes,
      sha256: this.verifySha256 ?? input.expectedSha256,
    };
  };

  delete = async (version: { objectKey: string; versionId: string }): Promise<void> => {
    this.deletedVersions.push(version.versionId);
    const upload = this.completedUpload(version.objectKey);
    if (upload.versionId === version.versionId) {
      upload.state = 'ABORTED';
      upload.versionId = null;
    }
  };

  /** Simulates the client's presigned PUT of one part's bytes. */
  putPart(uploadId: string, partNumber: number, declared: { sizeBytes: number; sha256: string }): MultipartStoredPart {
    const upload = this.openUpload(uploadId, this.uploads.get(uploadId)!.objectKey);
    const part: FakePart = {
      partNumber,
      etag: '"' + partNumber + '-' + declared.sha256.slice(0, 8) + '"',
      sizeBytes: declared.sizeBytes,
      sha256: declared.sha256,
    };
    upload.parts.set(partNumber, part);
    return { ...part };
  }

  /** Storage forgets one part: the declared-but-never-uploaded case. */
  dropPart(uploadId: string, partNumber: number): void {
    const upload = this.uploads.get(uploadId);
    if (!upload) throw new Error('unknown upload');
    upload.parts.delete(partNumber);
  }

  totalPartsOf(uploadId: string): number {
    const upload = this.uploads.get(uploadId);
    return upload ? [...upload.parts.values()].reduce((total, part) => total + part.sizeBytes, 0) : 0;
  }

  private openUpload(uploadId: string, objectKey: string): FakeUpload {
    const upload = this.uploads.get(uploadId);
    if (!upload || upload.objectKey !== objectKey) throw new ArtifactStorageError('OBJECT_NOT_FOUND');
    if (upload.state !== 'OPEN') throw new ArtifactStorageError('STORAGE_UNAVAILABLE');
    return upload;
  }

  private completedUpload(objectKey: string): FakeUpload {
    const upload = [...this.uploads.values()].find((candidate) => candidate.objectKey === objectKey && candidate.state === 'COMPLETED');
    if (!upload || !upload.versionId) throw new ArtifactStorageError('OBJECT_NOT_FOUND');
    return upload;
  }
}

export interface MultipartHarness {
  db: OfflineMultipartDb;
  storage: FakeMultipartStorage;
  service: ReturnType<typeof createMultipartService>;
}

export function createMultipartHarness(options: MultipartServiceOptions = {}): MultipartHarness {
  const db = new OfflineMultipartDb();
  const storage = new FakeMultipartStorage();
  const service = createMultipartService(db as unknown as Db, { storage, now: () => clock.ms, ...options });
  return { db, storage, service };
}

/** Public-branch twin of uploadEveryPart: grants go through publicGrantPart. */
export async function uploadEveryPartPublic(
  harness: MultipartHarness,
  artifactId: string,
  tenantId: string,
  geometry: { partSizeBytes: number; partCount: number; sizeBytes: number },
): Promise<MultipartPartReceipt[]> {
  const receipts: MultipartPartReceipt[] = [];
  for (let partNumber = 1; partNumber <= geometry.partCount; partNumber += 1) {
    const sizeBytes = Math.min(geometry.partSizeBytes, geometry.sizeBytes - (partNumber - 1) * geometry.partSizeBytes);
    const sha256 = partHash(partNumber);
    await harness.service.publicGrantPart(artifactId, tenantId, { partNumber, sha256 });
    const uploadId = harness.db.artifacts.get(artifactId)!.uploadId!;
    const stored = harness.storage.putPart(uploadId, partNumber, { sizeBytes, sha256 });
    receipts.push({ partNumber, etag: stored.etag, sizeBytes, sha256 });
  }
  return receipts;
}

/** Grants and "uploads" every part of an init ack, returning the receipts. */
export async function uploadEveryPart(
  harness: MultipartHarness,
  artifactId: string,
  geometry: { partSizeBytes: number; partCount: number; sizeBytes: number },
  overrides: (partNumber: number) => Partial<MultipartPartReceipt> = () => ({}),
): Promise<MultipartPartReceipt[]> {
  const receipts: MultipartPartReceipt[] = [];
  for (let partNumber = 1; partNumber <= geometry.partCount; partNumber += 1) {
    const sizeBytes = Math.min(geometry.partSizeBytes, geometry.sizeBytes - (partNumber - 1) * geometry.partSizeBytes);
    const sha256 = partHash(partNumber);
    await harness.service.grantPart(artifactId, { leaseEpoch: LEASE_EPOCH, partNumber, sha256 });
    const uploadId = harness.db.artifacts.get(artifactId)!.uploadId!;
    const stored = harness.storage.putPart(uploadId, partNumber, { sizeBytes, sha256 });
    receipts.push({ partNumber, etag: stored.etag, sizeBytes, sha256, ...overrides(partNumber) });
  }
  return receipts;
}
