import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Db } from '../src/db/db';
import { ArtifactStorageError } from '../src/modules/artifacts/storage-facade';
import {
  createPostgresArtifactIntegrityScanSource,
  scanArtifactStorageIntegrity,
  type ArtifactIntegrityScanCandidate,
  type ArtifactIntegrityScanSource,
} from '../src/modules/artifacts/integrity-scanner';

interface MemoryBlob {
  candidate: ArtifactIntegrityScanCandidate;
  bytes: Buffer;
}

class MemoryIntegritySource implements ArtifactIntegrityScanSource {
  readonly rows = new Map<string, MemoryBlob>();
  readError: Error | null = null;

  add(key: string, bytes: Buffer, overrides: Partial<ArtifactIntegrityScanCandidate> = {}): void {
    this.rows.set(key, {
      candidate: {
        storageKey: key,
        tenantId: 'tenant-1',
        artifactId: `artifact-${key}`,
        state: 'READY',
        storageBackend: 's3',
        storageVersionId: `version-${key}`,
        sizeBytes: bytes.byteLength,
        sha256: hash(bytes),
        ...overrides,
      },
      bytes: Buffer.from(bytes),
    });
  }

  async countLegacyBlobs(): Promise<number> {
    return this.rows.size;
  }

  async listBatch(afterStorageKey: string | null, limit: number): Promise<ArtifactIntegrityScanCandidate[]> {
    return [...this.rows.values()]
      .map((row) => row.candidate)
      .filter((row) => afterStorageKey === null || row.storageKey > afterStorageKey)
      .sort((left, right) => left.storageKey.localeCompare(right.storageKey))
      .slice(0, limit);
  }

  async readLegacyBlob(storageKey: string): Promise<Buffer | null> {
    if (this.readError) throw this.readError;
    const blob = this.rows.get(storageKey);
    return blob ? Buffer.from(blob.bytes) : null;
  }
}

class MemoryS3Facade {
  readonly versions = new Map<string, Buffer>();
  readonly openRead = jest.fn(async ({ objectKey, versionId }: { objectKey: string; versionId: string }) => {
    const bytes = this.versions.get(`${objectKey}:${versionId}`);
    if (!bytes) throw new ArtifactStorageError('OBJECT_NOT_FOUND');
    return Readable.from([Buffer.from(bytes)]);
  });

  add(key: string, versionId: string, bytes: Buffer): void {
    this.versions.set(`${key}:${versionId}`, Buffer.from(bytes));
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('batch artifact storage integrity scanner (offline)', () => {
  test('uses the PostgreSQL source adapter to count, page, and load each legacy blob', async () => {
    const bytes = Buffer.from('postgres legacy artifact bytes');
    const query = jest.fn(async (statement: string) => {
      if (statement.includes('count(*)')) {
        return { rows: [{ count: '1' }], rowCount: 1 };
      }
      if (statement.includes('SELECT bytes FROM artifact_blobs')) {
        return { rows: [{ bytes }], rowCount: 1 };
      }
      return {
        rows: [{
          storageKey: 'pg-artifact-1',
          tenantId: 'tenant-1',
          artifactId: 'artifact-pg-1',
          state: 'READY',
          storageBackend: 's3',
          storageVersionId: 'pg-version-1',
          sizeBytes: String(bytes.byteLength),
          sha256: hash(bytes),
        }],
        rowCount: 1,
      };
    });
    const db = { query } as unknown as Db;
    const source = createPostgresArtifactIntegrityScanSource(db);
    const storage = new MemoryS3Facade();
    storage.add('pg-artifact-1', 'pg-version-1', bytes);

    const report = await scanArtifactStorageIntegrity(source, storage, { batchSize: 1, timeoutMs: 1000 });

    expect(report).toMatchObject({
      state: 'complete',
      totalBlobs: 1,
      scannedBlobs: 1,
      migratedSuccessfully: 1,
      failuresOrMismatches: 0,
      unprocessedBlobs: 0,
      issues: [],
    });
    expect(query).toHaveBeenCalledTimes(3);
    expect(query.mock.calls[1]?.[0]).toContain('FROM artifact_blobs b');
    expect(query.mock.calls[2]).toEqual([
      'SELECT bytes FROM artifact_blobs WHERE storage_key=$1 AND tenant_id=$2',
      ['pg-artifact-1', 'tenant-1'],
    ]);
  });

  test('pages through all legacy blobs and reports exact pinned-version matches and mismatches', async () => {
    const source = new MemoryIntegritySource();
    const storage = new MemoryS3Facade();
    const matching = Buffer.from('artifact bytes match');
    const mismatching = Buffer.from('expected source bytes');
    const notMigrated = Buffer.from('legacy only');
    const orphan = Buffer.from('orphan source row');
    source.add('art-01', matching);
    source.add('art-02', mismatching);
    source.add('art-03', notMigrated, { storageBackend: 'postgres', storageVersionId: null });
    source.add('art-04', orphan, { artifactId: null });
    storage.add('art-01', 'version-art-01', matching);
    storage.add('art-02', 'version-art-02', Buffer.from('tampered source bytes'));

    const report = await scanArtifactStorageIntegrity(source, storage, { batchSize: 2, timeoutMs: 1000 });

    expect(report).toEqual({
      state: 'incomplete',
      totalBlobs: 4,
      scannedBlobs: 4,
      migratedSuccessfully: 1,
      failuresOrMismatches: 3,
      timedOutBlobs: 0,
      unprocessedBlobs: 0,
      issues: [
        { code: 'S3_HASH_MISMATCH', count: 1 },
        { code: 'NOT_MIGRATED', count: 1 },
        { code: 'SOURCE_ARTIFACT_MISSING', count: 1 },
      ],
    });
    expect(storage.openRead).toHaveBeenCalledTimes(2);
  });

  test('redacts raw source/provider errors and never writes scanner diagnostics to console', async () => {
    const bytes = Buffer.from('protected artifact body');
    const sourceFailure = new MemoryIntegritySource();
    const sourceFailureStorage = new MemoryS3Facade();
    sourceFailure.add('art-source-secret', bytes);
    sourceFailure.readError = new Error(
      'postgres://user:DB_PASSWORD_SENTINEL@db.invalid/app Bearer SOURCE_TOKEN_SENTINEL',
    );

    const providerFailure = new MemoryIntegritySource();
    const providerFailureStorage = new MemoryS3Facade();
    providerFailure.add('art-provider-secret', bytes);
    providerFailureStorage.openRead.mockRejectedValueOnce(
      new Error('provider key PROVIDER_SECRET_SENTINEL https://s3.invalid/object?token=URL_TOKEN_SENTINEL'),
    );
    const debug = jest.spyOn(console, 'debug').mockImplementation(() => undefined);
    const info = jest.spyOn(console, 'info').mockImplementation(() => undefined);
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const sourceReport = await scanArtifactStorageIntegrity(
        sourceFailure, sourceFailureStorage, { timeoutMs: 1000 },
      );
      const providerReport = await scanArtifactStorageIntegrity(
        providerFailure, providerFailureStorage, { timeoutMs: 1000 },
      );
      const serialized = JSON.stringify({ sourceReport, providerReport });
      for (const sentinel of [
        'DB_PASSWORD_SENTINEL',
        'SOURCE_TOKEN_SENTINEL',
        'PROVIDER_SECRET_SENTINEL',
        'URL_TOKEN_SENTINEL',
      ]) {
        expect(serialized).not.toContain(sentinel);
      }
      expect(sourceReport.issues).toEqual([{ code: 'SOURCE_READ_FAILED', count: 1 }]);
      expect(providerReport.issues).toEqual([{ code: 'S3_READ_FAILED', count: 1 }]);
      expect(debug).not.toHaveBeenCalled();
      expect(info).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(error).not.toHaveBeenCalled();
    } finally {
      debug.mockRestore();
      info.mockRestore();
      log.mockRestore();
      warn.mockRestore();
      error.mockRestore();
    }
  });

  test('times out and destroys a stalled S3 stream, then continues with the next blob', async () => {
    const source = new MemoryIntegritySource();
    const storage = new MemoryS3Facade();
    const stalledBytes = Buffer.from('first artifact source');
    const goodBytes = Buffer.from('second artifact source');
    source.add('art-01-stalled', stalledBytes);
    source.add('art-02-good', goodBytes);
    const stalled = new Readable({ read() { /* intentionally never emits */ } });
    storage.openRead
      .mockImplementationOnce(async () => stalled)
      .mockImplementationOnce(async () => Readable.from([goodBytes]));

    const report = await scanArtifactStorageIntegrity(source, storage, { batchSize: 2, timeoutMs: 25 });

    expect(report).toMatchObject({
      state: 'incomplete',
      totalBlobs: 2,
      scannedBlobs: 2,
      migratedSuccessfully: 1,
      failuresOrMismatches: 1,
      timedOutBlobs: 1,
      unprocessedBlobs: 0,
      issues: [{ code: 'TIMEOUT', count: 1 }],
    });
    expect(stalled.destroyed).toBe(true);
    expect(storage.openRead).toHaveBeenCalledTimes(2);
  });

  test('destroys a stream that is returned after its artifact deadline expires', async () => {
    const source = new MemoryIntegritySource();
    const storage = new MemoryS3Facade();
    const bytes = Buffer.from('late stream source');
    source.add('art-late-stream', bytes);
    const lateStream = Readable.from([bytes]);
    storage.openRead.mockImplementationOnce(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 40));
      return lateStream;
    });

    const report = await scanArtifactStorageIntegrity(source, storage, { timeoutMs: 10 });
    await new Promise<void>((resolve) => setTimeout(resolve, 50));

    expect(report).toMatchObject({
      state: 'incomplete',
      failuresOrMismatches: 1,
      timedOutBlobs: 1,
      issues: [{ code: 'TIMEOUT', count: 1 }],
    });
    expect(lateStream.destroyed).toBe(true);
  });

  test('returns a stable timeout summary when PostgreSQL inventory count stalls', async () => {
    const source = new MemoryIntegritySource();
    const storage = new MemoryS3Facade();
    jest.spyOn(source, 'countLegacyBlobs').mockImplementation(() => new Promise<number>(() => undefined));

    const report = await scanArtifactStorageIntegrity(source, storage, { timeoutMs: 10 });

    expect(report).toEqual({
      state: 'incomplete',
      totalBlobs: null,
      scannedBlobs: 0,
      migratedSuccessfully: 0,
      failuresOrMismatches: 0,
      timedOutBlobs: 0,
      unprocessedBlobs: null,
      issues: [{ code: 'TIMEOUT', count: 1 }],
    });
  });

  test('reports an incomplete inventory when the paged source no longer matches its count', async () => {
    const source = new MemoryIntegritySource();
    const storage = new MemoryS3Facade();
    const bytes = Buffer.from('one row');
    source.add('remaining-row', bytes);
    storage.add('remaining-row', 'version-remaining-row', bytes);
    jest.spyOn(source, 'countLegacyBlobs').mockResolvedValue(2);

    const report = await scanArtifactStorageIntegrity(source, storage, { batchSize: 10, timeoutMs: 1000 });

    expect(report).toMatchObject({
      state: 'incomplete',
      totalBlobs: 2,
      scannedBlobs: 1,
      unprocessedBlobs: 1,
      issues: [{ code: 'SOURCE_SCAN_FAILED', count: 1 }],
    });
  });
});
