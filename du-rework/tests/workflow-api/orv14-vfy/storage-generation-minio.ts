import { randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  CreateBucketCommand,
  DeleteBucketCommand,
  DeleteObjectCommand,
  GetBucketVersioningCommand,
  ListBucketsCommand,
  ListObjectVersionsCommand,
  PutBucketVersioningCommand,
  S3Client,
} from '../../../orchestrator/services/orchestrator/node_modules/@aws-sdk/client-s3';

const IMAGE = 'orv14-vfy/minio:RELEASE-2025-09-07';

export interface StorageGenerationMinioFixture {
  readonly endpoint: string;
  readonly bucket: string;
  readonly accessKeyId: string;
  readonly secretAccessKey: string;
  readonly imageId: string;
  cleanup(): Promise<{ bucketVersionsDeleted: number; bucketAbsent: boolean; containerAbsent: boolean; runLabelAbsent: boolean }>;
}

function docker(args: string[]): string {
  try {
    return execFileSync('docker', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }).trim();
  } catch {
    // Avoid surfacing argv or daemon output: the start command contains synthetic credentials.
    throw new Error(`owned storage-generation MinIO command failed (${args[0] ?? 'unknown'})`);
  }
}

function names(args: string[]): string[] {
  const value = docker(args);
  return value ? value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean) : [];
}

function listByRun(runLabel: string): string[] {
  return names(['ps', '--all', '--filter', `label=orv14.vfy.run-id=${runLabel}`, '--format', '{{.Names}}']);
}

export async function startStorageGenerationMinioFixture(runId: string): Promise<StorageGenerationMinioFixture> {
  const normalizedRunId = runId.toLowerCase().replace(/[^a-z0-9_.-]/g, '-');
  const runLabel = normalizedRunId.length <= 48
    ? normalizedRunId
    : `${normalizedRunId.slice(0, 40)}-${normalizedRunId.slice(-7)}`;
  if (!runLabel) throw new Error('storage-generation MinIO run label is empty');
  const containerName = `orv14-vfy-gen-${randomUUID().replaceAll('-', '').slice(0, 16)}`;
  const bucket = `orv14-gen-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
  const accessKeyId = randomBytes(10).toString('hex');
  const secretAccessKey = randomBytes(20).toString('hex');
  const labels = {
    'orv14.vfy.task': 'VFY-ORV14-GENERATION-DOWNLOAD',
    'orv14.vfy.owner': 'orv14_verification',
    'orv14.vfy.project': 'orv14-vfy-public-runtime-storage-generation',
    'orv14.vfy.run-id': runLabel,
    'orv14.vfy.resource': 'synthetic-minio',
  };
  if (listByRun(runLabel).length || names(['ps', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}']).length) {
    throw new Error('refusing to reuse a MinIO resource with this verifier run label or generated name');
  }
  const imageId = docker(['image', 'inspect', '--format', '{{.Id}}', IMAGE]);
  if (!/^sha256:[a-f0-9]{64}$/i.test(imageId)) throw new Error('synthetic MinIO image is not pinned by an immutable local image ID');

  let started = false;
  let bucketCreated = false;
  let client: S3Client | undefined;
  try {
    docker([
      'run', '--pull=never', '--detach', '--rm', '--name', containerName,
      ...Object.entries(labels).flatMap(([key, value]) => ['--label', `${key}=${value}`]),
      '--publish', '127.0.0.1::9000/tcp', '--tmpfs', '/data:rw,nosuid,nodev,size=1g',
      '--env', `MINIO_ROOT_USER=${accessKeyId}`, '--env', `MINIO_ROOT_PASSWORD=${secretAccessKey}`,
      IMAGE, 'server', '/data', '--address', ':9000', '--console-address', ':9001',
    ]);
    started = true;
    const observedLabels = JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', containerName])) as Record<string, string>;
    if (Object.entries(labels).some(([key, value]) => observedLabels[key] !== value)) {
      throw new Error('owned MinIO container labels do not match this verifier run');
    }
    if (docker(['inspect', '--format', '{{.Image}}', containerName]) !== imageId) {
      throw new Error('owned MinIO container does not use the pinned local image');
    }
    const binding = docker(['port', containerName, '9000/tcp']).split(/\r?\n/)[0]?.trim();
    const port = binding?.match(/^127\.0\.0\.1:(\d+)$/)?.[1];
    if (!port) throw new Error('owned MinIO did not publish a loopback-only S3 port');
    const endpoint = `http://127.0.0.1:${port}`;
    client = new S3Client({ endpoint, region: 'us-east-1', forcePathStyle: true, credentials: { accessKeyId, secretAccessKey } });
    let ready = false;
    for (let attempt = 0; attempt < 80; attempt += 1) {
      try {
        const response = await fetch(`${endpoint}/minio/health/ready`, { signal: AbortSignal.timeout(1_000) });
        if (response.ok) { ready = true; break; }
      } catch { /* wait for this newly started, owned service */ }
      await new Promise((resolve) => setTimeout(resolve, 250));
    }
    if (!ready) throw new Error('owned MinIO did not become ready');
    await client.send(new CreateBucketCommand({ Bucket: bucket }));
    bucketCreated = true;
    await client.send(new PutBucketVersioningCommand({ Bucket: bucket, VersioningConfiguration: { Status: 'Enabled' } }));
    const versioning = await client.send(new GetBucketVersioningCommand({ Bucket: bucket }));
    if (versioning.Status !== 'Enabled') throw new Error('owned MinIO bucket versioning did not enable');
    const list = await client.send(new ListBucketsCommand({}));
    if (!list.Buckets?.some((item) => item.Name === bucket)) throw new Error('owned MinIO bucket is absent after creation');

    let cleaned = false;
    return {
      endpoint, bucket, accessKeyId, secretAccessKey, imageId,
      async cleanup() {
        if (cleaned) throw new Error('owned MinIO cleanup was requested twice');
        cleaned = true;
        let bucketVersionsDeleted = 0;
        let bucketAbsent = !bucketCreated;
        try {
          if (bucketCreated) {
            let keyMarker: string | undefined;
            let versionIdMarker: string | undefined;
            do {
              const page = await client!.send(new ListObjectVersionsCommand({
                Bucket: bucket,
                ...(keyMarker ? { KeyMarker: keyMarker } : {}),
                ...(versionIdMarker ? { VersionIdMarker: versionIdMarker } : {}),
              }));
              for (const entry of [
                ...(page.Versions ?? []).map((item) => ({ item, version: true })),
                ...(page.DeleteMarkers ?? []).map((item) => ({ item, version: false })),
              ]) {
                if (!entry.item.Key || !entry.item.VersionId) throw new Error('owned MinIO returned an incomplete version entry');
                await client!.send(new DeleteObjectCommand({ Bucket: bucket, Key: entry.item.Key, VersionId: entry.item.VersionId }));
                bucketVersionsDeleted += 1;
              }
              if (!page.IsTruncated) break;
              if (!page.NextKeyMarker) throw new Error('owned MinIO omitted the next version marker');
              keyMarker = page.NextKeyMarker;
              versionIdMarker = page.NextVersionIdMarker;
            } while (true);
            await client!.send(new DeleteBucketCommand({ Bucket: bucket }));
            const remaining = await client!.send(new ListBucketsCommand({}));
            bucketAbsent = !remaining.Buckets?.some((item) => item.Name === bucket);
          }
        } finally {
          client!.destroy();
          const currentNames = names(['ps', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}']);
          if (currentNames.includes(containerName)) {
            const currentLabels = JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', containerName])) as Record<string, string>;
            if (Object.entries(labels).some(([key, value]) => currentLabels[key] !== value)) {
              throw new Error('refusing to stop MinIO after its ownership labels changed');
            }
            docker(['stop', '--time', '10', containerName]);
          }
        }
        const containerAbsent = !names(['ps', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}']).includes(containerName);
        const runLabelAbsent = listByRun(runLabel).length === 0;
        if (!bucketAbsent || !containerAbsent || !runLabelAbsent) throw new Error('owned MinIO cleanup left a bucket, container, or run-labeled resource');
        return { bucketVersionsDeleted, bucketAbsent, containerAbsent, runLabelAbsent };
      },
    };
  } catch (error) {
    client?.destroy();
    try {
      const currentNames = names(['ps', '--all', '--filter', `name=^/${containerName}$`, '--format', '{{.Names}}']);
      if (started && currentNames.includes(containerName)) {
        const currentLabels = JSON.parse(docker(['inspect', '--format', '{{json .Config.Labels}}', containerName])) as Record<string, string>;
        if (Object.entries(labels).every(([key, value]) => currentLabels[key] === value)) docker(['stop', '--time', '10', containerName]);
      }
    } catch { /* preserve the setup error; never stop a resource without matching ownership */ }
    throw error instanceof Error && error.message.includes('MinIO') ? error : new Error('owned storage-generation MinIO setup failed');
  }
}
