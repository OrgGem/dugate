import { createHash } from 'node:crypto';
import type { StoredArtifactVersion } from '../src/modules/artifacts/storage-facade';
import {
  ARTIFACT_BLOB_MIGRATION_ROLLBACK_PLAN,
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

  async withLegacyArtifactLocked<T>(
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
  readonly objects = new Map<string, { artifactId: string; tenantId: string; bytes: Buffer; versionId: string }>();
  readonly importedRefs: Array<{ artifactId: string; tenantId: string; objectKey: string }> = [];
  uploadCount = 0;
  returnWrongHash = false;
  returnWrongSize = false;

  async importLegacyBlob(input: Parameters<LegacyArtifactBlobImporter['importLegacyBlob']>[0]): Promise<StoredArtifactVersion> {
    this.importedRefs.push({ artifactId: input.artifactId, tenantId: input.tenantId, objectKey: input.objectKey });
    const digest = hash(input.bytes);
    if (input.bytes.byteLength !== input.expectedSizeBytes || digest !== input.expectedSha256) {
      throw new Error('fake S3 rejected non-matching input');
    }
    const current = this.objects.get(input.objectKey);
    if (current && current.artifactId === input.artifactId && current.tenantId === input.tenantId &&
        current.bytes.equals(input.bytes)) {
      return {
        objectKey: input.objectKey,
        versionId: current.versionId,
        sizeBytes: this.returnWrongSize ? current.bytes.byteLength + 1 : current.bytes.byteLength,
        sha256: this.returnWrongHash ? '0'.repeat(64) : digest,
      };
    }
    this.uploadCount += 1;
    const versionId = `version-${this.uploadCount}`;
    this.objects.set(input.objectKey, {
      artifactId: input.artifactId,
      tenantId: input.tenantId,
      bytes: Buffer.from(input.bytes),
      versionId,
    });
    return {
      objectKey: input.objectKey,
      versionId,
      sizeBytes: this.returnWrongSize ? input.bytes.byteLength + 1 : input.bytes.byteLength,
      sha256: this.returnWrongHash ? '0'.repeat(64) : digest,
    };
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
