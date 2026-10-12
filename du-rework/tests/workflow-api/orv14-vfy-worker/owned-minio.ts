import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  HeadBucketCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '../../../orchestrator/services/orchestrator/node_modules/@aws-sdk/client-s3';

const MINIO_IMAGE = 'orv14-vfy/minio:RELEASE-2025-09-07';

export interface OwnedMinioReceipt {
  runId: string;
  projectLabel: string;
  containerName: string;
  image: string;
  imageId: string;
  endpoint: string;
  bucket: string;
  versioning: 'Enabled';
  accessKeyIdLength: number;
  secretAccessKeyLength: number;
}

export interface OwnedMinioCleanupReceipt {
  bucketVersionCountBeforeDelete: number;
  deleteMarkersBeforeDelete: number;
  bucketAbsent: boolean;
  bucketApiCleanup: 'deleted' | 'failed' | 'not-created';
  bucketApiFailure?: { name: string; code?: string; httpStatus?: number };
  bucketDisposedWithContainer: boolean;
  containerAbsent: boolean;
  runLabelAbsent: boolean;
}

export interface OwnedMinioFixture {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly client: S3Client;
  readonly receipt: OwnedMinioReceipt;
  cleanup(): Promise<OwnedMinioCleanupReceipt>;
}

function docker(args: string[]): string {
  try {
    return execFileSync('docker', args, {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 30_000,
    }).trim();
  } catch {
    // Never propagate Docker's argv or daemon output; it may contain the
    // synthetic root credentials passed to this one-off test container.
    throw new Error(`owned MinIO Docker operation failed: ${args[0] ?? 'unknown'}`);
  }
}

function exactNames(args: string[]): string[] {
  const value = docker(args);
  return value ? value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
}

function labelFilter(runId: string): string[] {
  return ['ps', '--all', '--filter', `label=orv14.vfy.run-id=${runId}`, '--format', '{{.Names}}'];
}

async function deleteOwnedBucket(client: S3Client, bucket: string): Promise<{
  versions: number;
  deleteMarkers: number;
}> {
  let keyMarker: string | undefined;
  let versionIdMarker: string | undefined;
  const allEntries: Array<{ key: string; versionId: string; kind: 'version' | 'delete-marker' }> = [];
  do {
    const page = await client.send(new ListObjectVersionsCommand({
      Bucket: bucket,
      ...(keyMarker ? { KeyMarker: keyMarker } : {}),
      ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
    }));
    const pageEntries = [
      ...(page.Versions ?? []).map((item) => ({ item, kind: 'version' as const })),
      ...(page.DeleteMarkers ?? []).map((item) => ({ item, kind: 'delete-marker' as const })),
    ];
    for (const { item, kind } of pageEntries) {
      if (!item.Key || !item.VersionId) throw new Error('owned MinIO returned an incomplete version listing');
      allEntries.push({ key: item.Key, versionId: item.VersionId, kind });
    }
    if (!page.IsTruncated) break;
    if (!page.NextKeyMarker) throw new Error('owned MinIO version listing omitted its continuation key');
    keyMarker = page.NextKeyMarker;
    versionIdMarker = page.NextVersionIdMarker;
  } while (true);
  let versions = 0;
  let deleteMarkers = 0;
  for (const entry of allEntries) {
    await client.send(new DeleteObjectCommand({ Bucket: bucket, Key: entry.key, VersionId: entry.versionId }));
    if (entry.kind === 'version') versions += 1;
    else deleteMarkers += 1;
  }
  return { versions, deleteMarkers };
}

export async function startOwnedMinioFixture(runId: string): Promise<OwnedMinioFixture> {
  const safeRunId = runId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-').slice(0, 48);
  if (!safeRunId) throw new Error('owned MinIO run label is empty');
  const projectLabel = `orv14-vfy-worker-${safeRunId}`;
  const containerName = `ow-minio-${randomUUID().replaceAll('-', '').slice(0, 20)}`;
  const bucket = `orv14-worker-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  // MinIO's documented root access-key ceiling is 20 characters. This
  // synthetic, per-container identity also meets the Orchestrator's stricter
  // managed S3 credential parser without mutating the shared MinIO account.
  const accessKeyId = randomBytes(10).toString('hex');
  const secretAccessKey = randomBytes(20).toString('hex');
  const labels = {
    'orv14.vfy.task': 'VFY-ORV14-WORKER-E2E',
    'orv14.vfy.owner': 'orv14_worker_e2e_verification',
    'orv14.vfy.project': projectLabel,
    'orv14.vfy.run-id': safeRunId,
    'orv14.vfy.resource': 'synthetic-minio',
  };
  const existingByLabel = exactNames(labelFilter(safeRunId));
  const existingByName = exactNames(['ps', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}']);
  if (existingByLabel.length || existingByName.length) {
    throw new Error('refusing to reuse an existing resource carrying the owned MinIO name or run label');
  }

  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', MINIO_IMAGE]);
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageId)) throw new Error('owned MinIO image is not pinned by a local immutable image ID');
  let containerCreated = false;
  let client: S3Client | undefined;
  let endpoint = '';
  let bucketCreated = false;
  const labelArgs = Object.entries(labels).flatMap(([name, value]) => ['--label', `${name}=${value}`]);
  try {
    docker([
      'run', '--pull=never', '--detach', '--rm', '--name', containerName,
      ...labelArgs,
      '--publish', '127.0.0.1::9000/tcp',
      '--tmpfs', '/data:rw,nosuid,nodev,size=1g',
      '--env', `MINIO_ROOT_USER=${accessKeyId}`,
      '--env', `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      MINIO_IMAGE, 'server', '/data', '--address', ':9000', '--console-address', ':9001',
    ]);
    containerCreated = true;
    const observedLabels = JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', containerName])) as Record<string, string>;
    if (Object.entries(labels).some(([name, value]) => observedLabels[name] !== value)) {
      throw new Error('owned MinIO container labels did not match the new run');
    }
    const observedImageId = docker(['inspect', '--format', '{{.Image}}', containerName]);
    if (observedImageId !== imageId) throw new Error('owned MinIO container did not use the pinned local image');
    const binding = docker(['port', containerName, '9000/tcp']).split(/\r?\n/)[0]?.trim();
    const port = binding?.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (!port) throw new Error('owned MinIO did not publish a loopback-only S3 listener');
    endpoint = `http://127.0.0.1:${port}`;
    client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
    });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`${endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) { ready = true; break; }
      } catch { /* wait for the owned, loopback-only service */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('owned MinIO readiness endpoint did not become healthy');
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
    await client.send(new PutBucketVersioningCommand({
      Bucket: bucket,
      VersioningConfiguration: { Status: 'Enabled' },
    }));
    const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== 'Enabled') throw new Error('owned MinIO bucket versioning did not enable');
    const buckets = await client.send(new ListBucketsCommand({}));
    if (!buckets.Buckets?.some((entry) => entry.Name === bucket)) throw new Error('owned MinIO did not retain the unique bucket');

    const receipt: OwnedMinioReceipt = {
      runId: safeRunId,
      projectLabel,
      containerName,
      image: MINIO_IMAGE,
      imageId,
      endpoint,
      bucket,
      versioning: 'Enabled',
      accessKeyIdLength: accessKeyId.length,
      secretAccessKeyLength: secretAccessKey.length,
    };
    let cleaned = false;
    return {
      endpoint, bucket, accessKeyId, secretAccessKey, client, receipt,
      async cleanup(): Promise<OwnedMinioCleanupReceipt> {
        if (cleaned) throw new Error('owned MinIO fixture cleanup was requested twice');
        cleaned = true;
        let versions = 0;
        let deleteMarkers = 0;
        let bucketAbsent = !bucketCreated;
        let containerAbsent = !containerCreated;
        let runLabelAbsent = false;
        let bucketApiCleanup: OwnedMinioCleanupReceipt['bucketApiCleanup'] = bucketCreated ? 'failed' : 'not-created';
        let bucketApiFailure: OwnedMinioCleanupReceipt['bucketApiFailure'];
        try {
          if (bucketCreated) {
            await client!.send(new HeadBucketCommand({ Bucket: bucket }));
            const removed = await deleteOwnedBucket(client!, bucket);
            versions = removed.versions;
            deleteMarkers = removed.deleteMarkers;
            await client!.send(new DeleteBucketCommand({ Bucket: bucket }));
            const remaining = await client!.send(new ListBucketsCommand({}));
            bucketAbsent = !remaining.Buckets?.some((entry) => entry.Name === bucket);
            if (!bucketAbsent) throw new Error('owned MinIO bucket remains after deletion');
            bucketApiCleanup = 'deleted';
          }
        } catch (error: unknown) {
          const value = typeof error === 'object' && error !== null
            ? error as { name?: unknown; Code?: unknown; code?: unknown; $metadata?: { httpStatusCode?: unknown } }
            : {};
          const name = error instanceof Error ? error.name : 'UnknownError';
          const code = typeof value.Code === 'string' ? value.Code : typeof value.code === 'string' ? value.code : undefined;
          const httpStatus = typeof value.$metadata?.httpStatusCode === 'number' ? value.$metadata.httpStatusCode : undefined;
          bucketApiFailure = {
            name: name.slice(0, 80),
            ...(code === undefined ? {} : { code: code.slice(0, 80) }),
            ...(httpStatus === undefined ? {} : { httpStatus }),
          };
        } finally {
          client!.destroy();
          const liveNames = exactNames(['ps', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}']);
          if (liveNames.includes(containerName)) {
            const currentLabels = JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', containerName])) as Record<string, string>;
            if (Object.entries(labels).some(([name, value]) => currentLabels[name] !== value)) {
              throw new Error('refusing to stop a MinIO container whose ownership labels changed');
            }
            docker(['stop', '--time', '10', containerName]);
          }
          containerAbsent = !exactNames(['ps', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}']).includes(containerName);
          runLabelAbsent = exactNames(labelFilter(safeRunId)).length === 0;
          // `/data` is a tmpfs and this exact container is `--rm`; once its
          // ownership labels and absence are verified, any remaining bucket
          // data has been disposed with the container even if MinIO's S3 API
          // refused the preceding bucket deletion.
          if (!bucketAbsent && containerAbsent && runLabelAbsent) bucketAbsent = true;
          if (!containerAbsent || !runLabelAbsent || !bucketAbsent) {
            throw new Error('owned MinIO cleanup left a bucket, container, or run-labeled resource');
          }
        }
        return {
          bucketVersionCountBeforeDelete: versions,
          deleteMarkersBeforeDelete: deleteMarkers,
          bucketAbsent,
          bucketApiCleanup,
          ...(bucketApiFailure === undefined ? {} : { bucketApiFailure }),
          bucketDisposedWithContainer: !bucketCreated || !bucketApiFailure ? false : containerAbsent && runLabelAbsent,
          containerAbsent,
          runLabelAbsent,
        };
      },
    };
  } catch (error) {
    client?.destroy();
    try {
      const liveNames = exactNames(['ps', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}']);
      if (liveNames.includes(containerName)) {
        const observedLabels = JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', containerName])) as Record<string, string>;
        if (Object.entries(labels).every(([name, value]) => observedLabels[name] === value)) docker(['stop', '--time', '10', containerName]);
      }
      if (containerCreated && exactNames(labelFilter(safeRunId)).includes(containerName)) {
        throw new Error('owned MinIO setup cleanup left the run-labeled container');
      }
    } catch { /* retain the original setup failure; never stop a mismatched resource */ }
    throw error instanceof Error && error.message.includes('owned MinIO')
      ? error
      : new Error('owned MinIO fixture setup failed');
  }
}
