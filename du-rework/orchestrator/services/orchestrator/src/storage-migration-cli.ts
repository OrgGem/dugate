import { S3Client } from '@aws-sdk/client-s3';
import { createDb } from './db/db';
import {
  createPostgresArtifactBlobMigrationStore,
  migrateLegacyArtifactBlobs,
} from './modules/artifacts/storage-migration';
import { createS3ArtifactStorageFacade } from './modules/artifacts/s3-storage-facade';

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error('MISSING_CONFIGURATION');
  return value;
}

function optional(name: string): string | undefined {
  const value = process.env[name];
  return value && value.length > 0 ? value : undefined;
}

function optionalBoolean(name: string): boolean | undefined {
  const raw = optional(name);
  if (raw === undefined) return undefined;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error('INVALID_CONFIGURATION');
}

async function run(): Promise<void> {
  let db: ReturnType<typeof createDb> | undefined;
  let s3: S3Client | undefined;
  try {
    if (
      required('ARTIFACT_STORAGE_BACKEND') !== 's3' ||
      required('ARTIFACT_STORAGE_MIGRATION_WINDOW') !== 'true' ||
      required('ARTIFACT_BLOB_BACKUP_VERIFIED') !== 'true' ||
      required('ARTIFACT_BLOB_ROLLBACK_SIGNOFF').trim().length === 0 ||
      required('ARTIFACT_BLOB_MIGRATION_CONFIRM') !== 'YES'
    ) {
      throw new Error('MIGRATION_GUARD_REJECTED');
    }

    db = createDb(required('DATABASE_URL'));
    const bucket = required('ARTIFACT_S3_BUCKET');
    s3 = new S3Client({
      region: optional('ARTIFACT_S3_REGION'),
      endpoint: optional('ARTIFACT_S3_ENDPOINT'),
      forcePathStyle: optionalBoolean('ARTIFACT_S3_FORCE_PATH_STYLE') ?? Boolean(optional('ARTIFACT_S3_ENDPOINT')),
    });
    const storage = createS3ArtifactStorageFacade({ bucket, client: s3 });
    const result = await migrateLegacyArtifactBlobs(createPostgresArtifactBlobMigrationStore(db), storage);
    process.stdout.write(`${JSON.stringify(result)}\n`);
    if (result.state !== 'complete') process.exitCode = 2;
  } catch {
    process.stderr.write('{"state":"failed","code":"ARTIFACT_MIGRATION_ABORTED"}\n');
    process.exitCode = 1;
  } finally {
    s3?.destroy();
    if (db) await db.close().catch(() => undefined);
  }
}

void run();
