import { createHash } from 'node:crypto';
import type { PoolClient, QueryResult, QueryResultRow } from 'pg';
import type { Db } from '../src/db/db';
import { createArtifactService } from '../src/modules/artifacts/artifacts';
import type { StoredArtifactVersion } from '../src/modules/artifacts/storage-facade';
import {
  ARTIFACT_BLOB_MIGRATION_ROLLBACK_PLAN,
  createPostgresArtifactBlobMigrationStore,
  migrateLegacyArtifactBlobs,
  type ArtifactBlobMigrationInventory,
  type ArtifactBlobMigrationStore,
  type LegacyArtifactBlobImporter,
  type LegacyArtifactBlobRecord,
} from '../src/modules/artifacts/storage-migration';

interface MemoryArtifact extends Omit<LegacyArtifactBlobRecord, 'bytes'> {
  storageVersionId: string | null;
}

class InMemoryArtifactMigrationDb implements ArtifactBlobMigrationStore {
  readonly artifacts = new Map<string, MemoryArtifact>();
  readonly blobs = new Map<string, { tenantId: string; bytes: Buffer }>();

  addArtifact(input: {
    artifactId: string;
    tenantId: string;
    storageKey: string;
    bytes?: Buffer;
    sizeBytes?: number | null;
    sha256?: string | null;
    state?: string;
    storageBackend?: string;
    storageVersionId?: string | null;
  }): void {
    const bytes = input.bytes;
    this.artifacts.set(input.artifactId, {
      artifactId: input.artifactId,
      tenantId: input.tenantId,
      storageKey: input.storageKey,
      contentType: 'application/octet-stream',
      state: input.state ?? 'READY',
      storageBackend: input.storageBackend ?? 'postgres',
      sizeBytes: input.sizeBytes === undefined ? bytes?.byteLength ?? null : input.sizeBytes,
      sha256: input.sha256 === undefined && bytes ? hash(bytes) : input.sha256 ?? null,
      storageVersionId: input.storageVersionId ?? null,
    });
    if (bytes) this.blobs.set(input.storageKey, { tenantId: input.tenantId, bytes: Buffer.from(bytes) });
  }

  async inventory(): Promise<ArtifactBlobMigrationInventory> {
    const eligibleReadyArtifacts = [...this.artifacts.values()].filter((artifact) =>
      artifact.state === 'READY' && artifact.storageBackend === 'postgres' &&
      this.blobs.get(artifact.storageKey)?.tenantId === artifact.tenantId,
    ).length;
    const legacyArtifactReferences = [...this.artifacts.values()].filter((artifact) =>
      artifact.storageBackend === 'postgres' && artifact.state !== 'DELETED',
    ).length;
    const orphanBlobRows = [...this.blobs.entries()].filter(([storageKey, blob]) =>
      ![...this.artifacts.values()].some((artifact) =>
        artifact.storageKey === storageKey && artifact.tenantId === blob.tenantId,
      ),
    ).length;
    const readyS3ArtifactsWithoutVersion = [...this.artifacts.values()].filter((artifact) =>
      artifact.storageBackend === 's3' && artifact.state === 'READY' && !artifact.storageVersionId,
    ).length;
    return {
      legacyBlobRows: this.blobs.size,
      eligibleReadyArtifacts,
      legacyArtifactReferences,
      orphanBlobRows,
      readyS3ArtifactsWithoutVersion,
      unresolvedReferences: legacyArtifactReferences + orphanBlobRows + readyS3ArtifactsWithoutVersion,
    };
  }

  async listReadyLegacyArtifactIds(): Promise<string[]> {
    return [...this.artifacts.values()]
      .filter((artifact) => artifact.state === 'READY' && artifact.storageBackend === 'postgres')
      .filter((artifact) => this.blobs.get(artifact.storageKey)?.tenantId === artifact.tenantId)
      .map((artifact) => artifact.artifactId);
  }

  async withLegacyArtifactSnapshot<T>(
    artifactId: string,
    action: (
      artifact: LegacyArtifactBlobRecord | null,
      commitS3Pin: (version: StoredArtifactVersion) => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T> {
    const row = this.artifacts.get(artifactId);
    if (!row) return action(null, async () => false);
    const storedBlob = this.blobs.get(row.storageKey);
    const artifact: LegacyArtifactBlobRecord = {
      ...row,
      bytes: storedBlob?.tenantId === row.tenantId ? Buffer.from(storedBlob.bytes) : null,
    };
    return action(artifact, async (version) => {
      const current = this.artifacts.get(artifactId);
      if (!current || current.state !== 'READY' || current.storageBackend !== 'postgres') return false;
      if (version.objectKey !== current.storageKey || !version.versionId) return false;
      current.storageBackend = 's3';
      current.storageVersionId = version.versionId;
      current.sizeBytes = version.sizeBytes;
      current.sha256 = version.sha256;
      return true;
    });
  }
}

class FakeS3Importer implements LegacyArtifactBlobImporter {
  readonly versions = new Map<string, { objectKey: string; artifactId: string; tenantId: string; bytes: Buffer }>();
  readonly importedRefs: Array<{ artifactId: string; tenantId: string; objectKey: string }> = [];
  readonly deletedVersionIds: string[] = [];
  uploadCount = 0;
  returnWrongHash = false;
  returnWrongSize = false;
  private importBarrier?: { arrivals: number; count: number; promise: Promise<void>; release: () => void };

  holdImportsUntilConcurrent(count: number): void {
    let release!: () => void;
    const promise = new Promise<void>((resolve) => { release = resolve; });
    this.importBarrier = { arrivals: 0, count, promise, release };
  }

  async importLegacyBlob(input: Parameters<LegacyArtifactBlobImporter['importLegacyBlob']>[0]): Promise<StoredArtifactVersion> {
    this.importedRefs.push({ artifactId: input.artifactId, tenantId: input.tenantId, objectKey: input.objectKey });
    const digest = hash(input.bytes);
    if (input.bytes.byteLength !== input.expectedSizeBytes || digest !== input.expectedSha256) {
      throw new Error('fake S3 rejected non-matching input');
    }
    const current = [...this.versions.entries()].find(([, stored]) =>
      stored.objectKey === input.objectKey && stored.artifactId === input.artifactId &&
      stored.tenantId === input.tenantId && stored.bytes.equals(input.bytes),
    );
    if (current) {
      return {
        objectKey: input.objectKey,
        versionId: current[0],
        sizeBytes: this.returnWrongSize ? current[1].bytes.byteLength + 1 : current[1].bytes.byteLength,
        sha256: this.returnWrongHash ? '0'.repeat(64) : digest,
      };
    }
    const barrier = this.importBarrier;
    if (barrier) {
      barrier.arrivals += 1;
      if (barrier.arrivals >= barrier.count) {
        this.importBarrier = undefined;
        barrier.release();
      }
      await barrier.promise;
    }
    this.uploadCount += 1;
    const versionId = `version-${this.uploadCount}`;
    this.versions.set(versionId, {
      objectKey: input.objectKey,
      artifactId: input.artifactId,
      tenantId: input.tenantId,
      bytes: Buffer.from(input.bytes),
    });
    return {
      objectKey: input.objectKey,
      versionId,
      sizeBytes: this.returnWrongSize ? input.bytes.byteLength + 1 : input.bytes.byteLength,
      sha256: this.returnWrongHash ? '0'.repeat(64) : digest,
    };
  }

  async delete(version: Pick<StoredArtifactVersion, 'objectKey' | 'versionId'>): Promise<void> {
    this.deletedVersionIds.push(version.versionId);
    const stored = this.versions.get(version.versionId);
    if (stored?.objectKey === version.objectKey) this.versions.delete(version.versionId);
  }
}

const LOCK_TEST_ARTIFACT_ID = '44444444-4444-4444-8444-444444444444';
const LOCK_TEST_TASK_ID = '11111111-1111-4111-8111-111111111111';
const LOCK_TEST_OPERATION_ID = '33333333-3333-4333-8333-333333333333';
const LOCK_TEST_TENANT_ID = '22222222-2222-4222-8222-222222222222';
const LOCK_TEST_STORAGE_KEY = `art-${LOCK_TEST_ARTIFACT_ID}`;

class LockAwareMigrationDb implements Db {
  readonly pool = {} as Db['pool'];
  readonly executedQueries: string[] = [];
  private transactionTail: Promise<void> = Promise.resolve();
  committedVersionId: string | null = null;

  constructor(private readonly bytes: Buffer) {}

  async query<T extends QueryResultRow = QueryResultRow>(text: string, params?: unknown[]): Promise<QueryResult<T>> {
    return this.execute(text, params ?? []) as unknown as QueryResult<T>;
  }

  async tx<T>(fn: (client: PoolClient) => Promise<T>): Promise<T> {
    const previous = this.transactionTail;
    let release!: () => void;
    this.transactionTail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try {
      const client = { query: (text: string, params?: unknown[]) => this.query(text, params) } as unknown as PoolClient;
      return await fn(client);
    } finally {
      release();
    }
  }

  async close(): Promise<void> {}

  private result(rows: QueryResultRow[], command = 'SELECT'): QueryResult {
    return { command, rowCount: rows.length, oid: 0, fields: [], rows };
  }

  private async execute(text: string, params: unknown[]): Promise<QueryResult> {
    this.executedQueries.push(text);
    const sql = text.replace(/\s+/g, ' ').trim().toUpperCase();
    if (sql.includes('"LEGACYBLOBROWS"')) {
      const unresolved = this.committedVersionId ? 0 : 1;
      return this.result([{
        legacyBlobRows: 1,
        eligibleReadyArtifacts: unresolved,
        legacyArtifactReferences: unresolved,
        orphanBlobRows: 0,
        readyS3ArtifactsWithoutVersion: 0,
      }]);
    }
    if (sql.includes('LEFT JOIN ARTIFACT_BLOBS B')) {
      return this.result([{
        artifactId: LOCK_TEST_ARTIFACT_ID,
        tenantId: LOCK_TEST_TENANT_ID,
        storageKey: LOCK_TEST_STORAGE_KEY,
        contentType: 'application/pdf',
        state: 'READY',
        storageBackend: this.committedVersionId ? 's3' : 'postgres',
        sizeBytes: this.bytes.byteLength,
        sha256: hash(this.bytes),
        bytes: Buffer.from(this.bytes),
      }]);
    }
    if (sql.startsWith('SELECT A.ID AS "ARTIFACTID"') && sql.includes('JOIN ARTIFACT_BLOBS B')) {
      return this.result(this.committedVersionId ? [] : [{ artifactId: LOCK_TEST_ARTIFACT_ID }]);
    }
    if (sql.includes('FROM TASKS T JOIN OPERATIONS O')) {
      return this.result([{
        lease_epoch: 5,
        state: 'RUNNING',
        operationId: LOCK_TEST_OPERATION_ID,
        tenantId: LOCK_TEST_TENANT_ID,
        submitArtifacts: [],
        lease_active: true,
      }]);
    }
    if (sql.startsWith('SELECT TENANT_ID AS "TENANTID"') && sql.includes('FROM ARTIFACTS WHERE ID=$1')) {
      return this.result([{
        tenantId: LOCK_TEST_TENANT_ID,
        operationId: LOCK_TEST_OPERATION_ID,
        storageKey: LOCK_TEST_STORAGE_KEY,
        storageBackend: this.committedVersionId ? 's3' : 'postgres',
        storageVersionId: this.committedVersionId,
        fileName: 'large.pdf',
        mimeType: 'application/pdf',
        sizeBytes: this.bytes.byteLength,
        sha256: hash(this.bytes),
        state: 'READY',
        taskId: LOCK_TEST_TASK_ID,
        purpose: 'OUTPUT',
      }]);
    }
    if (sql.startsWith("UPDATE ARTIFACTS SET STORAGE_BACKEND='S3'")) {
      this.committedVersionId = String(params[1]);
      return this.result([{ id: LOCK_TEST_ARTIFACT_ID }], 'UPDATE');
    }
    if (sql.startsWith('UPDATE ARTIFACTS SET TOKEN=')) return this.result([], 'UPDATE');
    throw new Error(`Unexpected lock-aware migration SQL: ${sql}`);
  }
}

function hash(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('DATA-05 legacy PostgreSQL artifact migration (offline)', () => {
  test('backfills and verifies each READY blob, pins S3, and keeps a retry idempotent', async () => {
    const db = new InMemoryArtifactMigrationDb();
    const firstBytes = Buffer.from('legacy artifact one');
    const secondBytes = Buffer.from('legacy artifact two');
    db.addArtifact({ artifactId: 'artifact-1', tenantId: 'tenant-1', storageKey: 'art-1', bytes: firstBytes });
    db.addArtifact({ artifactId: 'artifact-2', tenantId: 'tenant-1', storageKey: 'art-2', bytes: secondBytes });
    const s3 = new FakeS3Importer();

    const firstRun = await migrateLegacyArtifactBlobs(db, s3);
    expect(firstRun).toMatchObject({
      state: 'complete',
      scannedArtifacts: 2,
      migratedArtifacts: 2,
      failedArtifacts: 0,
      unresolvedReferences: 0,
      legacyBackupRetained: true,
      legacyTableDropAllowed: false,
    });
    expect(firstRun.before).toMatchObject({
      legacyBlobRows: 2,
      eligibleReadyArtifacts: 2,
      legacyArtifactReferences: 2,
      orphanBlobRows: 0,
    });
    expect(firstRun.after).toMatchObject({
      legacyBlobRows: 2,
      eligibleReadyArtifacts: 0,
      legacyArtifactReferences: 0,
      orphanBlobRows: 0,
    });
    expect(s3.importedRefs).toEqual([
      { artifactId: 'artifact-1', tenantId: 'tenant-1', objectKey: 'art-1' },
      { artifactId: 'artifact-2', tenantId: 'tenant-1', objectKey: 'art-2' },
    ]);
    expect(db.artifacts.get('artifact-1')).toMatchObject({
      storageBackend: 's3', storageVersionId: 'version-1', sizeBytes: firstBytes.byteLength, sha256: hash(firstBytes),
    });
    expect(db.artifacts.get('artifact-2')).toMatchObject({
      storageBackend: 's3', storageVersionId: 'version-2', sizeBytes: secondBytes.byteLength, sha256: hash(secondBytes),
    });
    expect(db.blobs.get('art-1')?.bytes).toEqual(firstBytes);
    expect(db.blobs.get('art-2')?.bytes).toEqual(secondBytes);

    const retry = await migrateLegacyArtifactBlobs(db, s3);
    expect(retry).toMatchObject({ state: 'complete', scannedArtifacts: 0, migratedArtifacts: 0 });
    expect(s3.uploadCount).toBe(2);
  });

  test('deletes the losing exact S3 version when concurrent imports race', async () => {
    const db = new InMemoryArtifactMigrationDb();
    db.addArtifact({
      artifactId: 'artifact-race',
      tenantId: 'tenant-race',
      storageKey: 'art-race',
      bytes: Buffer.from('same legacy bytes'),
    });
    const s3 = new FakeS3Importer();
    s3.holdImportsUntilConcurrent(2);

    const results = await Promise.all([
      migrateLegacyArtifactBlobs(db, s3),
      migrateLegacyArtifactBlobs(db, s3),
    ]);

    const committedVersionId = db.artifacts.get('artifact-race')?.storageVersionId;
    expect(committedVersionId).toBeTruthy();
    expect(results.reduce((sum, result) => sum + result.migratedArtifacts, 0)).toBe(1);
    expect(results.reduce((sum, result) => sum + result.failedArtifacts, 0)).toBe(1);
    expect(results.flatMap((result) => result.issues)).toEqual([
      { artifactId: 'artifact-race', code: 'MIGRATION_COMMIT_CONFLICT' },
    ]);
    expect(s3.deletedVersionIds).toHaveLength(1);
    expect(s3.deletedVersionIds).not.toContain(committedVersionId);
    expect([...s3.versions.keys()]).toEqual([committedVersionId]);
    expect(s3.versions.get(committedVersionId!)?.objectKey).toBe('art-race');
  });

  test('allows requestAccess to complete while a large S3 import is still pending', async () => {
    const bytes = Buffer.alloc(4 * 1024 * 1024, 0x5a);
    const db = new LockAwareMigrationDb(bytes);
    const store = createPostgresArtifactBlobMigrationStore(db);
    const s3 = new FakeS3Importer();
    let markImportStarted!: () => void;
    let releaseImport!: () => void;
    const importStarted = new Promise<void>((resolve) => { markImportStarted = resolve; });
    const importGate = new Promise<void>((resolve) => { releaseImport = resolve; });
    const delayedStorage: LegacyArtifactBlobImporter = {
      async importLegacyBlob(input) {
        markImportStarted();
        await importGate;
        return s3.importLegacyBlob(input);
      },
      delete: (version) => s3.delete(version),
    };
    const migrationPromise = migrateLegacyArtifactBlobs(store, delayedStorage);
    await importStarted;

    const service = createArtifactService(db);
    const accessOutcome = service.requestAccess(LOCK_TEST_ARTIFACT_ID, {
      taskId: LOCK_TEST_TASK_ID,
      leaseEpoch: 5,
      mode: 'read',
    }).then(
      (grant) => ({ ok: true as const, grant }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let accessCompletedBeforeImport: boolean;
    try {
      accessCompletedBeforeImport = await Promise.race([
        accessOutcome.then(() => true),
        new Promise<boolean>((resolve) => {
          timeout = setTimeout(() => resolve(false), 250);
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
      releaseImport();
    }

    const [migration, access] = await Promise.all([migrationPromise, accessOutcome]);
    expect(accessCompletedBeforeImport).toBe(true);
    expect(access).toMatchObject({ ok: true, grant: { artifactId: LOCK_TEST_ARTIFACT_ID } });
    expect(migration).toMatchObject({ state: 'complete', migratedArtifacts: 1, failedArtifacts: 0 });
    expect(db.committedVersionId).toBeTruthy();
    expect([...s3.versions.keys()]).toEqual([db.committedVersionId]);
    const migrationRead = db.executedQueries.find((query) => query.includes('LEFT JOIN artifact_blobs'));
    expect(migrationRead).toBeDefined();
    expect(migrationRead).not.toMatch(/FOR UPDATE OF a/i);
    const casUpdate = db.executedQueries.find((query) => query.includes("SET storage_backend='s3'"));
    expect(casUpdate).toMatch(/storage_version_id IS NULL/i);
    expect(casUpdate).toMatch(/tenant_id=\$5 AND storage_key=\$6/i);
  });

  test.each(['hash', 'size'] as const)('does not pin metadata when S3 reports a different %s', async (mismatch) => {
    const db = new InMemoryArtifactMigrationDb();
    const bytes = Buffer.from('canonical legacy bytes');
    db.addArtifact({ artifactId: 'artifact-bad', tenantId: 'tenant-1', storageKey: 'art-bad', bytes });
    const s3 = new FakeS3Importer();
    if (mismatch === 'hash') s3.returnWrongHash = true;
    else s3.returnWrongSize = true;

    const result = await migrateLegacyArtifactBlobs(db, s3);
    expect(result).toMatchObject({ state: 'incomplete', failedArtifacts: 1, unresolvedReferences: 1 });
    expect(result.issues).toEqual([{ artifactId: 'artifact-bad', code: 'STORAGE_INTEGRITY_MISMATCH' }]);
    expect(db.artifacts.get('artifact-bad')).toMatchObject({ storageBackend: 'postgres', storageVersionId: null });
  });

  test('keeps tenant-mismatched blob rows unresolved and never imports them', async () => {
    const db = new InMemoryArtifactMigrationDb();
    db.addArtifact({ artifactId: 'artifact-tenant', tenantId: 'tenant-owner', storageKey: 'shared-key', bytes: Buffer.from('tenant A') });
    db.blobs.set('shared-key', { tenantId: 'different-tenant', bytes: Buffer.from('tenant B') });
    const s3 = new FakeS3Importer();

    const result = await migrateLegacyArtifactBlobs(db, s3);

    expect(result).toMatchObject({ state: 'incomplete', scannedArtifacts: 0, migratedArtifacts: 0 });
    expect(result.after).toMatchObject({ legacyBlobRows: 1, legacyArtifactReferences: 1, orphanBlobRows: 1 });
    expect(result.unresolvedReferences).toBe(2);
    expect(s3.importedRefs).toEqual([]);
    expect(db.artifacts.get('artifact-tenant')?.storageBackend).toBe('postgres');
  });

  test('fails closed when persisted PostgreSQL integrity metadata disagrees with the bytea source', async () => {
    const db = new InMemoryArtifactMigrationDb();
    db.addArtifact({
      artifactId: 'artifact-source-drift',
      tenantId: 'tenant-1',
      storageKey: 'art-source-drift',
      bytes: Buffer.from('source bytes'),
      sha256: '0'.repeat(64),
    });
    const s3 = new FakeS3Importer();

    const result = await migrateLegacyArtifactBlobs(db, s3);
    expect(result).toMatchObject({ state: 'incomplete', failedArtifacts: 1, unresolvedReferences: 1 });
    expect(result.issues).toEqual([{ artifactId: 'artifact-source-drift', code: 'SOURCE_INTEGRITY_MISMATCH' }]);
    expect(s3.uploadCount).toBe(0);
    expect(db.artifacts.get('artifact-source-drift')?.storageBackend).toBe('postgres');
  });

  test('refuses to mark migration complete while missing, orphaned, or non-ready legacy references remain', async () => {
    const db = new InMemoryArtifactMigrationDb();
    const readyBytes = Buffer.from('ready');
    db.addArtifact({ artifactId: 'artifact-ready', tenantId: 'tenant-1', storageKey: 'art-ready', bytes: readyBytes });
    db.addArtifact({ artifactId: 'artifact-missing', tenantId: 'tenant-1', storageKey: 'art-missing' });
    db.addArtifact({ artifactId: 'artifact-staging', tenantId: 'tenant-1', storageKey: 'art-staging', bytes: Buffer.from('partial'), state: 'STAGING' });
    db.blobs.set('orphan-storage-key', { tenantId: 'tenant-9', bytes: Buffer.from('orphan') });

    const result = await migrateLegacyArtifactBlobs(db, new FakeS3Importer());
    expect(result.state).toBe('incomplete');
    expect(result.migratedArtifacts).toBe(1);
    expect(result.unresolvedReferences).toBeGreaterThan(0);
    expect(result.after.orphanBlobRows).toBe(1);
    expect(result.legacyTableDropAllowed).toBe(false);
  });

  test('publishes an explicit rollback plan that retains the PostgreSQL source table', () => {
    expect(ARTIFACT_BLOB_MIGRATION_ROLLBACK_PLAN).toMatch(/backup verification/i);
    expect(ARTIFACT_BLOB_MIGRATION_ROLLBACK_PLAN).toMatch(/Never drop artifact_blobs/i);
  });
});
