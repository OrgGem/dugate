import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import type { QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { ArtifactStorageError, type ArtifactStorageFacade } from './storage-facade';

export type ArtifactIntegrityIssueCode =
  | 'SOURCE_ARTIFACT_MISSING'
  | 'SOURCE_NOT_READY'
  | 'SOURCE_BLOB_MISSING'
  | 'SOURCE_READ_FAILED'
  | 'SOURCE_METADATA_MISSING'
  | 'SOURCE_SIZE_MISMATCH'
  | 'SOURCE_HASH_MISMATCH'
  | 'NOT_MIGRATED'
  | 'S3_OBJECT_MISSING'
  | 'S3_SIZE_MISMATCH'
  | 'S3_HASH_MISMATCH'
  | 'S3_READ_FAILED'
  | 'TIMEOUT'
  | 'SCAN_ABORTED'
  | 'SOURCE_SCAN_FAILED';

export interface ArtifactIntegrityScanCandidate {
  storageKey: string;
  tenantId: string;
  artifactId: string | null;
  state: string | null;
  storageBackend: string | null;
  storageVersionId: string | null;
  sizeBytes: number | null;
  sha256: string | null;
}

export interface ArtifactIntegrityScanSource {
  countLegacyBlobs(signal?: AbortSignal, timeoutMs?: number): Promise<number>;
  listBatch(afterStorageKey: string | null, limit: number, signal?: AbortSignal, timeoutMs?: number): Promise<ArtifactIntegrityScanCandidate[]>;
  readLegacyBlob(storageKey: string, tenantId: string, signal?: AbortSignal, timeoutMs?: number): Promise<Buffer | null>;
}

export interface ArtifactIntegrityScanOptions {
  batchSize?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  onSkippedTick?: () => void;
}

export interface ArtifactIntegrityScanSummary {
  state: 'complete' | 'incomplete' | 'aborted';
  totalBlobs: number | null;
  scannedBlobs: number;
  migratedSuccessfully: number;
  failuresOrMismatches: number;
  timedOutBlobs: number;
  unprocessedBlobs: number | null;
  issues: Array<{ code: ArtifactIntegrityIssueCode; count: number }>;
}

interface ScanCandidateRow extends QueryResultRow {
  storageKey: string;
  tenantId: string;
  artifactId: string | null;
  state: string | null;
  storageBackend: string | null;
  storageVersionId: string | null;
  sizeBytes: number | string | null;
  sha256: string | null;
}

class ScanFailure extends Error {
  constructor(readonly code: ArtifactIntegrityIssueCode) {
    super(code);
    this.name = 'ScanFailure';
  }
}

// The Db wrapper does not expose pg QueryConfig. Use a dedicated pooled client
// so each scan query has its own server-side statement_timeout. Closing that
// client on abort also cancels an in-flight bytea transfer at the socket.
async function scanQuery<T extends QueryResultRow>(
  db: Db,
  text: string,
  values: unknown[],
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<QueryResult<T>> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError('timeoutMs must be an integer between 1 and 300000');
  }
  if (signal?.aborted) throw new ScanFailure('SCAN_ABORTED');
  const client = await db.pool.connect();
  let discard = false;
  const onAbort = (): void => {
    discard = true;
    void client.end().catch(() => undefined);
  };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    if (signal?.aborted) throw new ScanFailure('SCAN_ABORTED');
    await client.query('BEGIN READ ONLY');
    await client.query(`SET LOCAL statement_timeout = ${timeoutMs}`);
    const result = await client.query<T>(text, values);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    discard = true;
    throw error;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    client.release(discard);
  }
}

/** PostgreSQL source adapter. It pages metadata and loads only one bytea at a time. */
const scanKeys = new WeakMap<ArtifactIntegrityScanSource, object>();

export function createPostgresArtifactIntegrityScanSource(db: Db): ArtifactIntegrityScanSource {
  const source: ArtifactIntegrityScanSource = {
    async countLegacyBlobs(signal, timeoutMs): Promise<number> {
      const result = await scanQuery<{ count: number | string } & QueryResultRow>(
        db, 'SELECT count(*) AS count FROM artifact_blobs', [], signal, timeoutMs,
      );
      const value = Number(result.rows[0]?.count);
      if (!Number.isSafeInteger(value) || value < 0) throw new Error('invalid artifact blob count');
      return value;
    },

    async listBatch(afterStorageKey, limit, signal, timeoutMs): Promise<ArtifactIntegrityScanCandidate[]> {
      const result = await scanQuery<ScanCandidateRow>(
        db,
        `SELECT b.storage_key AS "storageKey", b.tenant_id AS "tenantId",
                a.id AS "artifactId", a.state,
                a.storage_backend AS "storageBackend",
                a.storage_version_id AS "storageVersionId",
                a.size_bytes AS "sizeBytes", a.sha256
         FROM artifact_blobs b
         LEFT JOIN LATERAL (
           SELECT a.id, a.state, a.storage_backend, a.storage_version_id,
                  a.size_bytes, a.sha256
           FROM artifacts a
           WHERE a.storage_key=b.storage_key AND a.tenant_id=b.tenant_id
           ORDER BY a.created_at DESC, a.id DESC
           LIMIT 1
         ) a ON true
         WHERE ($1::text IS NULL OR b.storage_key > $1)
         ORDER BY b.storage_key
         LIMIT $2`,
        [afterStorageKey, limit], signal, timeoutMs,
      );
      return result.rows.map((row) => ({
        storageKey: row.storageKey,
        tenantId: row.tenantId,
        artifactId: row.artifactId,
        state: row.state,
        storageBackend: row.storageBackend,
        storageVersionId: row.storageVersionId,
        sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
        sha256: row.sha256,
      }));
    },

    async readLegacyBlob(storageKey, tenantId, signal, timeoutMs): Promise<Buffer | null> {
      const result = await scanQuery<{ bytes: Buffer }>(
        db,
        'SELECT bytes FROM artifact_blobs WHERE storage_key=$1 AND tenant_id=$2',
        [storageKey, tenantId], signal, timeoutMs,
      );
      return result.rowCount ? result.rows[0]!.bytes : null;
    },
  };
  scanKeys.set(source, db.pool);
  return source;
}

function digest(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function classifyStorageError(error: unknown): ArtifactIntegrityIssueCode {
  if (!(error instanceof ArtifactStorageError)) return 'S3_READ_FAILED';
  switch (error.code) {
    case 'OBJECT_NOT_FOUND':
    case 'OBJECT_VERSION_REQUIRED':
      return 'S3_OBJECT_MISSING';
    case 'SIZE_MISMATCH':
      return 'S3_SIZE_MISMATCH';
    case 'CHECKSUM_MISMATCH':
      return 'S3_HASH_MISMATCH';
    default:
      return 'S3_READ_FAILED';
  }
}

function withDeadline<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  signal: AbortSignal | undefined,
  onStop: (code: 'TIMEOUT' | 'SCAN_ABORTED') => void,
  track: (operation: Promise<T>) => void,
): Promise<T> {
  if (signal?.aborted) return Promise.reject(new ScanFailure('SCAN_ABORTED'));
  return new Promise<T>((resolve, reject) => {
    const controller = new AbortController();
    let settled = false;
    let stopCode: 'TIMEOUT' | 'SCAN_ABORTED' | null = null;
    const cleanup = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const finishResolve = (value: T): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (stopCode) reject(new ScanFailure(stopCode));
      else resolve(value);
    };
    const finishReject = (error: unknown): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(stopCode ? new ScanFailure(stopCode) : error);
    };
    const onAbort = (): void => {
      stopCode = 'SCAN_ABORTED';
      clearTimeout(timer);
      controller.abort();
      onStop('SCAN_ABORTED');
    };
    const timer = setTimeout(() => {
      stopCode = 'TIMEOUT';
      controller.abort();
      onStop('TIMEOUT');
    }, timeoutMs);
    signal?.addEventListener('abort', onAbort, { once: true });
    const running = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new ScanFailure(stopCode ?? 'SCAN_ABORTED');
      return operation(controller.signal);
    });
    track(running);
    running.then(finishResolve, finishReject);
  });
}

const activeSources = new WeakSet<object>();

async function hashStream(stream: Readable, maxBytes: number): Promise<{ sizeBytes: number; sha256: string }> {
  const hash = createHash('sha256');
  let sizeBytes = 0;
  try {
    for await (const raw of stream) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
      sizeBytes += chunk.byteLength;
      if (sizeBytes > maxBytes) {
        stream.destroy();
        throw new ScanFailure('S3_SIZE_MISMATCH');
      }
      hash.update(chunk);
    }
  } catch (error) {
    if (error instanceof ScanFailure) throw error;
    throw new ScanFailure(classifyStorageError(error));
  }
  return { sizeBytes, sha256: hash.digest('hex') };
}

/**
 * Verify every legacy bytea row against its exact committed S3 version. This
 * function intentionally emits no logs; summaries contain only aggregate
 * counts and stable issue codes, never keys, names, or exception text.
 */
export async function scanArtifactStorageIntegrity(
  source: ArtifactIntegrityScanSource,
  storage: Pick<ArtifactStorageFacade, 'openRead'>,
  options: ArtifactIntegrityScanOptions = {},
): Promise<ArtifactIntegrityScanSummary> {
  const batchSize = options.batchSize ?? 25;
  const timeoutMs = options.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 500) {
    throw new TypeError('batchSize must be an integer between 1 and 500');
  }
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 300_000) {
    throw new TypeError('timeoutMs must be an integer between 1 and 300000');
  }

  const scanKey = scanKeys.get(source) ?? source;
  if (activeSources.has(scanKey)) {
    options.onSkippedTick?.();
    console.warn('artifact integrity scan tick skipped: previous scan still running');
    return {
      state: 'aborted', totalBlobs: null, scannedBlobs: 0, migratedSuccessfully: 0,
      failuresOrMismatches: 0, timedOutBlobs: 0, unprocessedBlobs: null,
      issues: [{ code: 'SCAN_ABORTED', count: 1 }],
    };
  }
  activeSources.add(scanKey);
  const pending = new Set<Promise<unknown>>();
  const track = <T>(operation: Promise<T>): void => {
    pending.add(operation);
    void operation.then(() => pending.delete(operation), () => pending.delete(operation));
  };

  try {

  const issueCounts = new Map<ArtifactIntegrityIssueCode, number>();
  const addIssue = (code: ArtifactIntegrityIssueCode): void => {
    issueCounts.set(code, (issueCounts.get(code) ?? 0) + 1);
  };
  let totalBlobs: number | null = null;
  let scannedBlobs = 0;
  let migratedSuccessfully = 0;
  let failuresOrMismatches = 0;
  let timedOutBlobs = 0;
  let aborted = false;

  try {
    totalBlobs = await withDeadline(
      (signal) => source.countLegacyBlobs(signal, timeoutMs), timeoutMs, options.signal, () => undefined, track,
    );
  } catch (error) {
    const code = options.signal?.aborted
      ? 'SCAN_ABORTED'
      : error instanceof ScanFailure ? error.code : 'SOURCE_SCAN_FAILED';
    addIssue(code);
    return {
      state: code === 'SCAN_ABORTED' ? 'aborted' : 'incomplete',
      totalBlobs: null,
      scannedBlobs,
      migratedSuccessfully,
      failuresOrMismatches,
      timedOutBlobs,
      unprocessedBlobs: null,
      issues: [{ code, count: 1 }],
    };
  }

  let cursor: string | null = null;
  let sourceFailed = false;
  while (scannedBlobs < totalBlobs) {
    if (options.signal?.aborted) {
      aborted = true;
      addIssue('SCAN_ABORTED');
      break;
    }
    let batch: ArtifactIntegrityScanCandidate[];
    try {
      batch = await withDeadline(
        (signal) => source.listBatch(cursor, batchSize, signal, timeoutMs), timeoutMs, options.signal, () => undefined, track,
      );
    } catch (error) {
      if (options.signal?.aborted) {
        aborted = true;
        addIssue('SCAN_ABORTED');
      } else {
        sourceFailed = true;
        addIssue(error instanceof ScanFailure ? error.code : 'SOURCE_SCAN_FAILED');
      }
      break;
    }
    if (batch.length === 0) break;

    for (const candidate of batch) {
      if (options.signal?.aborted) {
        aborted = true;
        addIssue('SCAN_ABORTED');
        break;
      }
      scannedBlobs += 1;
      let stream: Readable | undefined;
      let stopCode: 'TIMEOUT' | 'SCAN_ABORTED' | null = null;
      try {
        await withDeadline(async (signal) => {
          if (!candidate.artifactId) throw new ScanFailure('SOURCE_ARTIFACT_MISSING');
          if (candidate.state !== 'READY') throw new ScanFailure('SOURCE_NOT_READY');
          let bytes: Buffer | null;
          try {
            bytes = await source.readLegacyBlob(candidate.storageKey, candidate.tenantId, signal, timeoutMs);
          } catch {
            throw new ScanFailure('SOURCE_READ_FAILED');
          }
          if (stopCode) throw new ScanFailure(stopCode);
          if (!bytes) throw new ScanFailure('SOURCE_BLOB_MISSING');
          const sourceSize = bytes.byteLength;
          const sourceHash = digest(bytes);
          if (candidate.sizeBytes === null || !candidate.sha256) {
            throw new ScanFailure('SOURCE_METADATA_MISSING');
          }
          if (candidate.sizeBytes !== sourceSize) throw new ScanFailure('SOURCE_SIZE_MISMATCH');
          if (candidate.sha256.toLowerCase() !== sourceHash) throw new ScanFailure('SOURCE_HASH_MISMATCH');
          if (
            candidate.storageBackend !== 's3' ||
            !candidate.storageVersionId || candidate.storageVersionId === 'null'
          ) {
            throw new ScanFailure('NOT_MIGRATED');
          }
          try {
            stream = await storage.openRead({
              objectKey: candidate.storageKey,
              versionId: candidate.storageVersionId,
            });
          } catch (error) {
            throw new ScanFailure(classifyStorageError(error));
          }
          if (stopCode) {
            stream.destroy();
            throw new ScanFailure(stopCode);
          }
          const remote = await hashStream(stream, sourceSize);
          if (remote.sizeBytes !== sourceSize) throw new ScanFailure('S3_SIZE_MISMATCH');
          if (remote.sha256 !== sourceHash) throw new ScanFailure('S3_HASH_MISMATCH');
        }, timeoutMs, options.signal, (code) => {
          stopCode = code;
          stream?.destroy();
        }, track);
        migratedSuccessfully += 1;
      } catch (error) {
        const code = error instanceof ScanFailure ? error.code : 'S3_READ_FAILED';
        if (code === 'SCAN_ABORTED') {
          aborted = true;
          addIssue(code);
          break;
        }
        failuresOrMismatches += 1;
        if (code === 'TIMEOUT') timedOutBlobs += 1;
        addIssue(code);
      }
      cursor = candidate.storageKey;
    }
    if (aborted || sourceFailed || batch.length < batchSize) break;
  }

  const unprocessedBlobs = Math.max(0, totalBlobs - scannedBlobs);
  if (
    unprocessedBlobs > 0 &&
    !aborted &&
    !issueCounts.has('SOURCE_SCAN_FAILED') &&
    !issueCounts.has('TIMEOUT')
  ) {
    addIssue('SOURCE_SCAN_FAILED');
  }
  const issues = [...issueCounts.entries()].map(([code, count]) => ({ code, count }));
  const state = aborted
    ? 'aborted'
    : !sourceFailed && unprocessedBlobs === 0 && scannedBlobs === totalBlobs && failuresOrMismatches === 0
      ? 'complete'
      : 'incomplete';
  return {
    state,
    totalBlobs,
    scannedBlobs,
    migratedSuccessfully,
    failuresOrMismatches,
    timedOutBlobs,
    unprocessedBlobs,
    issues,
  };
  } finally {
    if (pending.size === 0) activeSources.delete(scanKey);
    else void Promise.allSettled([...pending]).then(() => activeSources.delete(scanKey));
  }
}
