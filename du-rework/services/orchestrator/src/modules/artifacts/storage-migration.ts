import { createHash } from 'node:crypto';
import type { PoolClient, QueryResultRow } from 'pg';
import type { Db } from '../../db/db';
import { ArtifactStorageError, type StoredArtifactVersion } from './storage-facade';
import type { S3LegacyArtifactImportInput } from './s3-storage-facade';

export interface ArtifactBlobMigrationInventory {
  legacyBlobRows: number;
  eligibleReadyArtifacts: number;
  legacyArtifactReferences: number;
  orphanBlobRows: number;
  readyS3ArtifactsWithoutVersion: number;
  unresolvedReferences: number;
}

export interface LegacyArtifactBlobRecord {
  artifactId: string;
  tenantId: string;
  storageKey: string;
  contentType: string;
  state: string;
  storageBackend: string;
  sizeBytes: number | null;
  sha256: string | null;
  bytes: Buffer | null;
}

export interface ArtifactBlobMigrationStore {
  inventory(): Promise<ArtifactBlobMigrationInventory>;
  listReadyLegacyArtifactIds(): Promise<string[]>;
  /** Hold the artifact row lock through import and pointer commit for concurrency safety. */
  withLegacyArtifactLocked<T>(
    artifactId: string,
    action: (
      artifact: LegacyArtifactBlobRecord | null,
      commitS3Pin: (version: StoredArtifactVersion) => Promise<boolean>,
    ) => Promise<T>,
  ): Promise<T>;
}

export interface LegacyArtifactBlobImporter {
  importLegacyBlob(input: S3LegacyArtifactImportInput): Promise<StoredArtifactVersion>;
}

export interface ArtifactBlobMigrationIssue {
  artifactId: string;
  code: string;
}

export interface ArtifactBlobMigrationResult {
  state: 'complete' | 'incomplete';
  scannedArtifacts: number;
  migratedArtifacts: number;
  skippedArtifacts: number;
  failedArtifacts: number;
  unresolvedReferences: number;
  before: ArtifactBlobMigrationInventory;
  after: ArtifactBlobMigrationInventory;
  issues: ArtifactBlobMigrationIssue[];
  legacyBackupRetained: true;
  legacyTableDropAllowed: false;
}

/** Operator rollback guidance. The retained bytea rows are the rollback copy. */
export const ARTIFACT_BLOB_MIGRATION_ROLLBACK_PLAN = [
  'Pause artifact submissions and switch the configured write backend to PostgreSQL only after backup verification and explicit rollback sign-off.',
  'Keep artifact_blobs intact. Restore a row to PostgreSQL only when its retained bytes match the artifact size and SHA-256 metadata.',
  'Keep S3 versions and PostgreSQL blobs until the migration owner confirms rollback or roll-forward completion.',
  'Never drop artifact_blobs before a verified backup and rollback sign-off.',
].join(' ');

interface InventoryRow extends QueryResultRow {
  legacyBlobRows: number | string;
  eligibleReadyArtifacts: number | string;
  legacyArtifactReferences: number | string;
  orphanBlobRows: number | string;
  readyS3ArtifactsWithoutVersion: number | string;
}

interface LegacyArtifactRow extends QueryResultRow {
  artifactId: string;
  tenantId: string;
  storageKey: string;
  contentType: string;
  state: string;
  storageBackend: string;
  sizeBytes: number | string | null;
  sha256: string | null;
  bytes: Buffer | null;
}

function count(value: number | string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error('invalid artifact migration inventory');
  return parsed;
}

function mapInventory(row: InventoryRow): ArtifactBlobMigrationInventory {
  const legacyBlobRows = count(row.legacyBlobRows);
  const eligibleReadyArtifacts = count(row.eligibleReadyArtifacts);
  const legacyArtifactReferences = count(row.legacyArtifactReferences);
  const orphanBlobRows = count(row.orphanBlobRows);
  const readyS3ArtifactsWithoutVersion = count(row.readyS3ArtifactsWithoutVersion);
  return {
    legacyBlobRows,
    eligibleReadyArtifacts,
    legacyArtifactReferences,
    orphanBlobRows,
    readyS3ArtifactsWithoutVersion,
    unresolvedReferences: legacyArtifactReferences + orphanBlobRows + readyS3ArtifactsWithoutVersion,
  };
}

/** PostgreSQL repository. Each artifact row remains locked until its S3 pin commits. */
export function createPostgresArtifactBlobMigrationStore(db: Db): ArtifactBlobMigrationStore {
  return {
    async inventory(): Promise<ArtifactBlobMigrationInventory> {
      const result = await db.query<InventoryRow>(
        `SELECT
           (SELECT count(*) FROM artifact_blobs) AS "legacyBlobRows",
           (SELECT count(*) FROM artifacts a
             JOIN artifact_blobs b ON b.storage_key=a.storage_key AND b.tenant_id=a.tenant_id
             WHERE a.state='READY' AND a.storage_backend='postgres') AS "eligibleReadyArtifacts",
           (SELECT count(*) FROM artifacts a
             WHERE a.storage_backend='postgres' AND a.state <> 'DELETED') AS "legacyArtifactReferences",
           (SELECT count(*) FROM artifact_blobs b
             LEFT JOIN artifacts a ON a.storage_key=b.storage_key AND a.tenant_id=b.tenant_id
             WHERE a.id IS NULL) AS "orphanBlobRows",
           (SELECT count(*) FROM artifacts a
             WHERE a.storage_backend='s3' AND a.state='READY' AND a.storage_version_id IS NULL)
             AS "readyS3ArtifactsWithoutVersion"`,
      );
      const row = result.rows[0];
      if (!row) throw new Error('artifact migration inventory unavailable');
      return mapInventory(row);
    },

    async listReadyLegacyArtifactIds(): Promise<string[]> {
      const result = await db.query<{ artifactId: string } & QueryResultRow>(
        `SELECT a.id AS "artifactId"
         FROM artifacts a
         JOIN artifact_blobs b ON b.storage_key=a.storage_key AND b.tenant_id=a.tenant_id
         WHERE a.state='READY' AND a.storage_backend='postgres'
         ORDER BY a.id`,
      );
      return result.rows.map((row) => row.artifactId);
    },

    async withLegacyArtifactLocked<T>(
      artifactId: string,
      action: (
        artifact: LegacyArtifactBlobRecord | null,
        commitS3Pin: (version: StoredArtifactVersion) => Promise<boolean>,
      ) => Promise<T>,
    ): Promise<T> {
      return db.tx(async (client: PoolClient) => {
        const result = await client.query<LegacyArtifactRow>(
          `SELECT a.id AS "artifactId", a.tenant_id AS "tenantId",
                  a.storage_key AS "storageKey", a.mime_type AS "contentType",
                  a.state, a.storage_backend AS "storageBackend",
                  a.size_bytes AS "sizeBytes", a.sha256,
                  b.bytes
           FROM artifacts a
           LEFT JOIN artifact_blobs b
             ON b.storage_key=a.storage_key AND b.tenant_id=a.tenant_id
           WHERE a.id=$1
           FOR UPDATE OF a`,
          [artifactId],
        );
        const row = result.rows[0];
        const artifact: LegacyArtifactBlobRecord | null = row ? {
          artifactId: row.artifactId,
          tenantId: row.tenantId,
          storageKey: row.storageKey,
          contentType: row.contentType,
          state: row.state,
          storageBackend: row.storageBackend,
          sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes),
          sha256: row.sha256,
          bytes: row.bytes === null ? null : Buffer.from(row.bytes),
        } : null;

        const commitS3Pin = async (version: StoredArtifactVersion): Promise<boolean> => {
          if (
            !artifact?.bytes ||
            version.objectKey !== artifact.storageKey ||
            !version.versionId || version.versionId === 'null' ||
            version.sizeBytes !== artifact.bytes.byteLength ||
            !/^[a-f0-9]{64}$/i.test(version.sha256) ||
            version.sha256.toLowerCase() !== createHash('sha256').update(artifact.bytes).digest('hex')
          ) {
            return false;
          }
          const updated = await client.query(
            `UPDATE artifacts
             SET storage_backend='s3', storage_version_id=$2, size_bytes=$3, sha256=$4
             WHERE id=$1 AND state='READY' AND storage_backend='postgres'
             RETURNING id`,
            [artifact.artifactId, version.versionId, version.sizeBytes, version.sha256],
          );
          return Boolean(updated.rowCount);
        };
        return action(artifact, commitS3Pin);
      });
    },
  };
}

/** Idempotently backfill verified PostgreSQL bytea blobs and retain every source row. */
export async function migrateLegacyArtifactBlobs(
  store: ArtifactBlobMigrationStore,
  storage: LegacyArtifactBlobImporter,
): Promise<ArtifactBlobMigrationResult> {
  const before = await store.inventory();
  const candidates = await store.listReadyLegacyArtifactIds();
  let migratedArtifacts = 0;
  let skippedArtifacts = 0;
  let failedArtifacts = 0;
  const issues: ArtifactBlobMigrationIssue[] = [];

  for (const artifactId of candidates) {
    let outcome: 'migrated' | 'skipped' | { failed: string };
    try {
      outcome = await store.withLegacyArtifactLocked(artifactId, async (artifact, commitS3Pin) => {
        if (!artifact || artifact.state !== 'READY' || artifact.storageBackend !== 'postgres') return 'skipped';
        if (!artifact.bytes) return { failed: 'SOURCE_NOT_FOUND' };

        const sizeBytes = artifact.bytes.byteLength;
        const sha256 = createHash('sha256').update(artifact.bytes).digest('hex');
        if (
          (artifact.sizeBytes !== null && artifact.sizeBytes !== sizeBytes) ||
          (artifact.sha256 !== null && artifact.sha256.toLowerCase() !== sha256)
        ) {
          return { failed: 'SOURCE_INTEGRITY_MISMATCH' };
        }

        let version: StoredArtifactVersion;
        try {
          version = await storage.importLegacyBlob({
            artifactId: artifact.artifactId,
            tenantId: artifact.tenantId,
            objectKey: artifact.storageKey,
            contentType: artifact.contentType,
            bytes: artifact.bytes,
            expectedSizeBytes: sizeBytes,
            expectedSha256: sha256,
          });
        } catch (error) {
          return { failed: error instanceof ArtifactStorageError ? error.code : 'STORAGE_UNAVAILABLE' };
        }

        if (
          version.objectKey !== artifact.storageKey ||
          !version.versionId || version.versionId === 'null' ||
          version.sizeBytes !== sizeBytes || version.sha256.toLowerCase() !== sha256
        ) {
          return { failed: 'STORAGE_INTEGRITY_MISMATCH' };
        }
        if (!await commitS3Pin(version)) return { failed: 'MIGRATION_COMMIT_CONFLICT' };
        return 'migrated';
      });
    } catch {
      outcome = { failed: 'MIGRATION_STORE_UNAVAILABLE' };
    }

    if (outcome === 'migrated') {
      migratedArtifacts += 1;
    } else if (outcome === 'skipped') {
      skippedArtifacts += 1;
    } else {
      failedArtifacts += 1;
      issues.push({ artifactId, code: outcome.failed });
    }
  }

  const after = await store.inventory();
  return {
    state: after.unresolvedReferences === 0 && failedArtifacts === 0 ? 'complete' : 'incomplete',
    scannedArtifacts: candidates.length,
    migratedArtifacts,
    skippedArtifacts,
    failedArtifacts,
    unresolvedReferences: after.unresolvedReferences,
    before,
    after,
    issues,
    legacyBackupRetained: true,
    legacyTableDropAllowed: false,
  };
}
