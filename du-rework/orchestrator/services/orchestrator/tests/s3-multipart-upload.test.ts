import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import {
  MIN_S3_MULTIPART_PART_BYTES,
  S3MultipartUploadError,
  createS3ArtifactStorageFacade,
} from '../src/modules/artifacts/s3-storage-facade';
import type {
  S3MultipartCheckpoint,
  S3MultipartUploadInput,
} from '../src/modules/artifacts/s3-storage-facade';

const PART_SIZE = MIN_S3_MULTIPART_PART_BYTES;
const artifact = {
  artifactId: 'artifact-large-1',
  tenantId: 'tenant-1',
  objectKey: 'tenant-1/artifact-large-1',
  contentType: 'application/octet-stream',
  taskId: 'task-producer-1',
  leaseEpoch: 7,
};

interface MultipartState {
  key: string;
  metadata: Record<string, string>;
  parts: Map<number, Buffer>;
  etags: Map<number, string>;
}

interface VersionState {
  key: string;
  versionId: string;
  metadata: Record<string, string>;
  bytes: Buffer;
}

function makeS3Fake() {
  const uploads = new Map<string, MultipartState>();
  const versions = new Map<string, VersionState>();
  const send = jest.fn<Promise<unknown>, [unknown]>(async (command) => {
    if (command instanceof CreateMultipartUploadCommand) {
      const uploadId = `upload-${uploads.size + 1}`;
      uploads.set(uploadId, {
        key: command.input.Key!,
        metadata: command.input.Metadata ?? {},
        parts: new Map(),
        etags: new Map(),
      });
      return { UploadId: uploadId };
    }
    if (command instanceof UploadPartCommand) {
      const upload = uploads.get(command.input.UploadId!);
      if (!upload || upload.key !== command.input.Key) throw new Error('unknown multipart upload');
      const partNumber = command.input.PartNumber!;
      const body = command.input.Body;
      if (!(body instanceof Uint8Array)) throw new Error('expected bounded byte part');
      const bytes = Buffer.from(body);
      const etag = `"etag-${partNumber}-${bytes.byteLength}"`;
      upload.parts.set(partNumber, bytes);
      upload.etags.set(partNumber, etag);
      return { ETag: etag };
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      const uploadId = command.input.UploadId!;
      const upload = uploads.get(uploadId);
      if (!upload || upload.key !== command.input.Key) throw new Error('unknown multipart upload');
      const parts = command.input.MultipartUpload?.Parts ?? [];
      for (const part of parts) {
        if (upload.etags.get(part.PartNumber!) !== part.ETag) throw new Error('part mismatch');
      }
      const bytes = Buffer.concat(parts.map((part) => upload.parts.get(part.PartNumber!)!));
      const versionId = `version-${versions.size + 1}`;
      versions.set(versionId, { key: upload.key, versionId, metadata: upload.metadata, bytes });
      uploads.delete(uploadId);
      return { VersionId: versionId };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      uploads.delete(command.input.UploadId!);
      return {};
    }
    if (command instanceof DeleteObjectCommand) {
      versions.delete(command.input.VersionId!);
      return {};
    }
    if (command instanceof HeadObjectCommand) {
      const version = versions.get(command.input.VersionId!);
      if (!version || version.key !== command.input.Key) throw new Error('missing version');
      return {
        VersionId: version.versionId,
        ContentLength: version.bytes.byteLength,
        Metadata: version.metadata,
      };
    }
    if (command instanceof GetObjectCommand) {
      const version = versions.get(command.input.VersionId!);
      if (!version || version.key !== command.input.Key) throw new Error('missing version');
      return { Body: Readable.from([version.bytes]) };
    }
    throw new Error('unexpected S3 command');
  });
  const client = { send } as unknown as S3Client;
  const facade = createS3ArtifactStorageFacade({ bucket: 'offline-bucket', client });
  return { facade, send, uploads, versions };
}

function makePayload(size: number): Buffer {
  const payload = Buffer.allocUnsafe(size);
  for (let index = 0; index < size; index += 1) payload[index] = index % 239;
  return payload;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function expectedPartHashes(payload: Buffer): string[] {
  const hashes: string[] = [];
  for (let offset = 0; offset < payload.length; offset += PART_SIZE) {
    hashes.push(sha256(payload.subarray(offset, Math.min(offset + PART_SIZE, payload.length))));
  }
  return hashes;
}

function sourceFrom(payload: Buffer): Readable {
  async function* chunks(): AsyncGenerator<Buffer> {
    for (let offset = 0; offset < payload.length; offset += 1024 * 1024) {
      yield payload.subarray(offset, Math.min(offset + 1024 * 1024, payload.length));
    }
  }
  return Readable.from(chunks());
}

function input(
  payload: Buffer,
  overrides: Partial<S3MultipartUploadInput> = {},
) {
  return {
    ...artifact,
    expectedSizeBytes: payload.byteLength,
    expectedSha256: sha256(payload),
    expectedPartSha256: expectedPartHashes(payload),
    partSizeBytes: PART_SIZE,
    source: sourceFrom(payload),
    assertLease: async () => undefined,
    onCheckpoint: () => undefined,
    ...overrides,
  };
}

describe('S3 bounded multipart artifact uploads', () => {
  test('uploads >5 MiB chunk-by-chunk, verifies part and whole-body hashes, and pins the completed version', async () => {
    const payload = makePayload(11 * 1024 * 1024);
    const { facade, send, uploads, versions } = makeS3Fake();
    const checkpoints: number[] = [];

    await expect(facade.uploadMultipart(input(payload, {
      onCheckpoint: (checkpoint) => {
        checkpoints.push(checkpoint.parts.length);
      },
    }))).resolves.toEqual({
      objectKey: artifact.objectKey,
      versionId: 'version-1',
      sizeBytes: payload.byteLength,
      sha256: sha256(payload),
    });

    expect(Array.from(uploads.keys())).toHaveLength(0);
    expect(Buffer.compare(Array.from(versions.values())[0]!.bytes, payload)).toBe(0);
    expect(send.mock.calls.filter(([command]) => command instanceof UploadPartCommand)).toHaveLength(3);
    const partSizes = send.mock.calls
      .filter(([command]) => command instanceof UploadPartCommand)
      .map(([command]) => {
        const body = (command as UploadPartCommand).input.Body;
        return body instanceof Uint8Array ? body.byteLength : undefined;
      });
    expect(partSizes).toEqual([PART_SIZE, PART_SIZE, 1024 * 1024]);
    expect(Math.max(...partSizes.map((size) => size ?? 0))).toBe(PART_SIZE);
    expect(send.mock.calls.filter(([command]) => command instanceof CompleteMultipartUploadCommand)).toHaveLength(1);
    expect(checkpoints).toEqual([0, 1, 2, 3]);
  });

  test('fails closed and aborts when any declared chunk hash does not match', async () => {
    const payload = makePayload(11 * 1024 * 1024);
    const { facade, send, uploads, versions } = makeS3Fake();
    const partHashes = expectedPartHashes(payload);
    partHashes[1] = '0'.repeat(64);

    await expect(facade.uploadMultipart(input(payload, {
      expectedPartSha256: partHashes,
    }))).rejects.toMatchObject<Partial<S3MultipartUploadError>>({
      code: 'MULTIPART_CHECKSUM_MISMATCH',
    });

    expect(send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(send.mock.calls.some(([command]) => command instanceof CompleteMultipartUploadCommand)).toBe(false);
    expect(uploads.size).toBe(0);
    expect(versions.size).toBe(0);
  });

  test('resumes after a stream interruption by rehashing checkpointed parts under the same lease', async () => {
    const payload = makePayload(11 * 1024 * 1024);
    const { facade, send, uploads, versions } = makeS3Fake();
    const checkpoints: S3MultipartCheckpoint[] = [];
    async function* interruptedSource(): AsyncGenerator<Buffer> {
      for (let offset = 0; offset < PART_SIZE; offset += 1024 * 1024) {
        yield payload.subarray(offset, offset + 1024 * 1024);
      }
      throw new Error('temporary stream interruption');
    }
    let checkpoint: S3MultipartCheckpoint | undefined;
    try {
      await facade.uploadMultipart(input(payload, {
        source: Readable.from(interruptedSource()),
        onCheckpoint: (next) => {
          checkpoints.push(next);
        },
      }));
    } catch (error) {
      expect(error).toBeInstanceOf(S3MultipartUploadError);
      const interruption = error as S3MultipartUploadError;
      expect(interruption.code).toBe('MULTIPART_UPLOAD_INTERRUPTED');
      checkpoint = interruption.checkpoint;
    }
    expect(checkpoint?.parts).toHaveLength(1);
    expect(checkpoints.at(-1)?.parts).toHaveLength(1);

    await expect(facade.uploadMultipart(input(payload, { checkpoint }))).resolves.toMatchObject({
      versionId: 'version-1',
      sizeBytes: payload.byteLength,
      sha256: sha256(payload),
    });
    // The resumed pass revalidates part 1 locally and sends only parts 2 and 3.
    expect(send.mock.calls.filter(([command]) => command instanceof CreateMultipartUploadCommand)).toHaveLength(1);
    expect(send.mock.calls.filter(([command]) => command instanceof UploadPartCommand)).toHaveLength(3);
    expect(uploads.size).toBe(0);
    expect(Buffer.compare(versions.get('version-1')!.bytes, payload)).toBe(0);
  });

  test('cancellation aborts the active S3 multipart upload', async () => {
    const payload = makePayload(11 * 1024 * 1024);
    const { facade, send, uploads } = makeS3Fake();
    const controller = new AbortController();

    await expect(facade.uploadMultipart(input(payload, {
      signal: controller.signal,
      onCheckpoint: (checkpoint) => {
        if (checkpoint.parts.length === 1) controller.abort();
      },
    }))).rejects.toMatchObject<Partial<S3MultipartUploadError>>({ code: 'MULTIPART_CANCELLED' });

    expect(send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(uploads.size).toBe(0);
  });

  test('lease loss after a part upload aborts the active S3 multipart upload', async () => {
    const payload = makePayload(11 * 1024 * 1024);
    const { facade, send, uploads } = makeS3Fake();
    let leaseChecks = 0;

    await expect(facade.uploadMultipart(input(payload, {
      assertLease: async () => {
        leaseChecks += 1;
        if (leaseChecks === 3) throw new Error('lease expired');
      },
    }))).rejects.toMatchObject<Partial<S3MultipartUploadError>>({ code: 'MULTIPART_LEASE_LOST' });

    expect(send.mock.calls.some(([command]) => command instanceof AbortMultipartUploadCommand)).toBe(true);
    expect(send.mock.calls.some(([command]) => command instanceof CompleteMultipartUploadCommand)).toBe(false);
    expect(uploads.size).toBe(0);
  });

  test('lease loss at the completion edge removes the just-completed unpublished version', async () => {
    const payload = makePayload(11 * 1024 * 1024);
    const { facade, send, uploads, versions } = makeS3Fake();
    let leaseChecks = 0;

    await expect(facade.uploadMultipart(input(payload, {
      assertLease: async () => {
        leaseChecks += 1;
        if (leaseChecks === 9) throw new Error('lease expired after complete');
      },
    }))).rejects.toMatchObject<Partial<S3MultipartUploadError>>({ code: 'MULTIPART_LEASE_LOST' });

    expect(send.mock.calls.some(([command]) => command instanceof DeleteObjectCommand)).toBe(true);
    expect(uploads.size).toBe(0);
    expect(versions.size).toBe(0);
  });
});
