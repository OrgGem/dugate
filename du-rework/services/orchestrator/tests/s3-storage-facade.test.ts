import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import {
  DeleteObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import {
  ArtifactStorageError,
  createS3ArtifactStorageFacade,
} from '../src/modules/artifacts/s3-storage-facade';

const artifact = {
  artifactId: 'artifact-1',
  tenantId: 'tenant-1',
  objectKey: 'tenant-1/artifact-1',
  contentType: 'application/pdf',
  maxBytes: 7,
  expiresAt: '2030-01-01T00:15:00.000Z',
};
const payload = Buffer.from('payload');
const sha256 = createHash('sha256').update(payload).digest('hex');

function mockClient(): {
  client: S3Client;
  send: jest.Mock<Promise<unknown>, [unknown]>;
} {
  const send = jest.fn<Promise<unknown>, [unknown]>();
  return { client: { send } as unknown as S3Client, send };
}

function makeFacade(send: jest.Mock<Promise<unknown>, [unknown]>) {
  return createS3ArtifactStorageFacade({
    bucket: 'artifact-bucket',
    client: { send } as unknown as S3Client,
    now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    presignPut: async () => 'https://s3.test/presigned-upload',
  });
}

describe('S3 artifact storage facade', () => {
  test('creates a short-lived upload grant pinned to artifact, tenant, media type and declared size', async () => {
    const { send, client } = mockClient();
    const presignPut = jest.fn(async (
      _client: S3Client,
      command: PutObjectCommand,
      expiresInSeconds: number,
    ) => {
      expect(command).toBeInstanceOf(PutObjectCommand);
      expect(command.input).toMatchObject({
        Bucket: 'artifact-bucket',
        Key: artifact.objectKey,
        ContentType: artifact.contentType,
        ContentLength: artifact.maxBytes,
        Metadata: { artifactid: artifact.artifactId, tenantid: artifact.tenantId },
      });
      expect(expiresInSeconds).toBe(900);
      return 'https://s3.test/presigned-upload';
    });
    const facade = createS3ArtifactStorageFacade({
      bucket: 'artifact-bucket',
      client,
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
      presignPut,
    });

    await expect(facade.createUploadGrant(artifact)).resolves.toEqual({
      url: 'https://s3.test/presigned-upload',
      expiresAt: artifact.expiresAt,
      headers: {
        'content-type': artifact.contentType,
        'x-amz-meta-artifactid': artifact.artifactId,
        'x-amz-meta-tenantid': artifact.tenantId,
      },
    });
    expect(presignPut).toHaveBeenCalledTimes(1);
    expect(send).not.toHaveBeenCalled();
  });

  test('uses the AWS SDK v3 signer locally without sending a request to S3', async () => {
    const client = new S3Client({
      region: 'us-east-1',
      endpoint: 'https://s3.test',
      forcePathStyle: true,
      credentials: { accessKeyId: 'offline-access', secretAccessKey: 'offline-secret' },
    });
    const facade = createS3ArtifactStorageFacade({
      bucket: 'artifact-bucket',
      client,
      now: () => Date.parse('2030-01-01T00:00:00.000Z'),
    });

    try {
      const grant = await facade.createUploadGrant(artifact);
      const signedUrl = new URL(grant.url);
      expect(signedUrl.host).toBe('s3.test');
      expect(signedUrl.searchParams.get('X-Amz-Expires')).toBe('900');
      expect(signedUrl.searchParams.get('X-Amz-SignedHeaders')).toContain('content-type');
      const queryNames = Array.from(signedUrl.searchParams.keys(), (key) => key.toLowerCase());
      expect(queryNames).toContain('x-amz-meta-artifactid');
      expect(queryNames).toContain('x-amz-meta-tenantid');
    } finally {
      client.destroy();
    }
  });

  test('verifies bytes from the exact S3 generation and returns an immutable version pin', async () => {
    const { send } = mockClient();
    send
      .mockResolvedValueOnce({
        VersionId: 'generation-17',
        ContentLength: payload.byteLength,
        Metadata: { artifactid: artifact.artifactId, tenantid: artifact.tenantId },
      })
      .mockResolvedValueOnce({ Body: Readable.from([payload.subarray(0, 2), payload.subarray(2)]) });
    const facade = makeFacade(send);

    await expect(facade.verifyAndPin({
      artifactId: artifact.artifactId,
      tenantId: artifact.tenantId,
      objectKey: artifact.objectKey,
      expectedSizeBytes: payload.byteLength,
      expectedSha256: sha256,
    })).resolves.toEqual({
      objectKey: artifact.objectKey,
      versionId: 'generation-17',
      sizeBytes: payload.byteLength,
      sha256,
    });

    expect(send).toHaveBeenCalledTimes(2);
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(HeadObjectCommand);
    expect((send.mock.calls[0]?.[0] as HeadObjectCommand).input).toMatchObject({
      Bucket: 'artifact-bucket', Key: artifact.objectKey, ChecksumMode: 'ENABLED',
    });
    expect(send.mock.calls[1]?.[0]).toBeInstanceOf(GetObjectCommand);
    expect((send.mock.calls[1]?.[0] as GetObjectCommand).input).toMatchObject({
      Bucket: 'artifact-bucket', Key: artifact.objectKey, VersionId: 'generation-17',
    });
  });

  test('imports legacy PostgreSQL bytes to S3, verifies the returned version, and reuses it on retry', async () => {
    const { send } = mockClient();
    const missing = Object.assign(new Error('NoSuchKey'), {
      name: 'NoSuchKey',
      $metadata: { httpStatusCode: 404 },
    });
    send
      .mockRejectedValueOnce(missing)
      .mockResolvedValueOnce({ VersionId: 'legacy-import-v1' })
      .mockResolvedValueOnce({
        VersionId: 'legacy-import-v1',
        ContentLength: payload.byteLength,
        Metadata: { artifactid: artifact.artifactId, tenantid: artifact.tenantId },
      })
      .mockResolvedValueOnce({ Body: Readable.from([payload]) })
      .mockResolvedValueOnce({
        VersionId: 'legacy-import-v1',
        ContentLength: payload.byteLength,
        Metadata: { artifactid: artifact.artifactId, tenantid: artifact.tenantId },
      })
      .mockResolvedValueOnce({ Body: Readable.from([payload]) });
    const facade = makeFacade(send);
    const input = {
      artifactId: artifact.artifactId,
      tenantId: artifact.tenantId,
      objectKey: artifact.objectKey,
      contentType: artifact.contentType,
      bytes: payload,
      expectedSizeBytes: payload.byteLength,
      expectedSha256: sha256,
    };

    const expected = {
      objectKey: artifact.objectKey,
      versionId: 'legacy-import-v1',
      sizeBytes: payload.byteLength,
      sha256,
    };
    await expect(facade.importLegacyBlob(input)).resolves.toEqual(expected);
    await expect(facade.importLegacyBlob(input)).resolves.toEqual(expected);
    const commandNames = send.mock.calls.map(([command]) => {
      if (command instanceof HeadObjectCommand) return 'HeadObjectCommand';
      if (command instanceof PutObjectCommand) return 'PutObjectCommand';
      if (command instanceof GetObjectCommand) return 'GetObjectCommand';
      return 'unexpected';
    });
    expect(commandNames).toEqual([
      'HeadObjectCommand', 'PutObjectCommand', 'HeadObjectCommand', 'GetObjectCommand',
      'HeadObjectCommand', 'GetObjectCommand',
    ]);
    const put = send.mock.calls[1]?.[0] as PutObjectCommand;
    expect(put.input).toMatchObject({
      Bucket: 'artifact-bucket',
      Key: artifact.objectKey,
      ContentLength: payload.byteLength,
      ContentType: artifact.contentType,
      Metadata: { artifactid: artifact.artifactId, tenantid: artifact.tenantId, sha256 },
    });
    expect(put.input.Body).toEqual(payload);
  });

  test('rejects a source hash mismatch before sending any S3 request', async () => {
    const { send } = mockClient();
    const facade = makeFacade(send);
    await expect(facade.importLegacyBlob({
      artifactId: artifact.artifactId,
      tenantId: artifact.tenantId,
      objectKey: artifact.objectKey,
      contentType: artifact.contentType,
      bytes: payload,
      expectedSizeBytes: payload.byteLength,
      expectedSha256: '0'.repeat(64),
    })).rejects.toMatchObject<Partial<ArtifactStorageError>>({ code: 'CHECKSUM_MISMATCH' });
    expect(send).not.toHaveBeenCalled();
  });

  test('streams reads for the requested pinned version without buffering the object', async () => {
    const { send } = mockClient();
    send.mockResolvedValueOnce({ Body: Readable.from([payload.subarray(0, 3), payload.subarray(3)]) });
    const facade = makeFacade(send);
    const stream = await facade.openRead({ objectKey: artifact.objectKey, versionId: 'generation-17' });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
    }

    expect(Buffer.concat(chunks)).toEqual(payload);
    expect((send.mock.calls[0]?.[0] as GetObjectCommand).input).toMatchObject({
      Bucket: 'artifact-bucket', Key: artifact.objectKey, VersionId: 'generation-17',
    });
  });

  test('deletes only the requested object version', async () => {
    const { send } = mockClient();
    send.mockResolvedValueOnce({});
    const facade = makeFacade(send);

    await expect(facade.delete({ objectKey: artifact.objectKey, versionId: 'generation-17' })).resolves.toBeUndefined();
    expect(send.mock.calls[0]?.[0]).toBeInstanceOf(DeleteObjectCommand);
    expect((send.mock.calls[0]?.[0] as DeleteObjectCommand).input).toEqual({
      Bucket: 'artifact-bucket', Key: artifact.objectKey, VersionId: 'generation-17',
    });
  });

  test('fails closed when S3 versioning is disabled or suspended', async () => {
    const { send } = mockClient();
    send.mockResolvedValueOnce({
      VersionId: 'null',
      ContentLength: payload.byteLength,
      Metadata: { artifactid: artifact.artifactId, tenantid: artifact.tenantId },
    });
    const facade = makeFacade(send);

    await expect(facade.verifyAndPin({
      artifactId: artifact.artifactId,
      tenantId: artifact.tenantId,
      objectKey: artifact.objectKey,
      expectedSizeBytes: payload.byteLength,
      expectedSha256: sha256,
    })).rejects.toMatchObject<Partial<ArtifactStorageError>>({ code: 'OBJECT_VERSION_REQUIRED' });
    expect(send).toHaveBeenCalledTimes(1);
  });

  test('rejects bytes whose actual SHA-256 differs from the finalize request', async () => {
    const { send } = mockClient();
    send
      .mockResolvedValueOnce({
        VersionId: 'generation-18',
        ContentLength: payload.byteLength,
        Metadata: { artifactid: artifact.artifactId, tenantid: artifact.tenantId },
      })
      .mockResolvedValueOnce({ Body: Readable.from([payload]) });
    const facade = makeFacade(send);

    await expect(facade.verifyAndPin({
      artifactId: artifact.artifactId,
      tenantId: artifact.tenantId,
      objectKey: artifact.objectKey,
      expectedSizeBytes: payload.byteLength,
      expectedSha256: '0'.repeat(64),
    })).rejects.toMatchObject<Partial<ArtifactStorageError>>({ code: 'CHECKSUM_MISMATCH' });
  });

  test('redacts delayed provider stream errors to the stable storage code', async () => {
    const { send } = mockClient();
    const providerStream = new Readable({
      read() {
        this.destroy(new Error('AKIA_SENTINEL https://secret.invalid/object'));
      },
    });
    send.mockResolvedValueOnce({ Body: providerStream });
    const facade = makeFacade(send);
    const stream = await facade.openRead({ objectKey: artifact.objectKey, versionId: 'generation-17' });
    let failure: unknown;
    try {
      for await (const _chunk of stream) {
        // The fixture fails before yielding any bytes.
      }
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject<Partial<ArtifactStorageError>>({ code: 'STORAGE_UNAVAILABLE' });
    expect(failure).not.toHaveProperty('message', expect.stringContaining('AKIA_SENTINEL'));
    expect(failure).not.toHaveProperty('message', expect.stringContaining('secret.invalid'));
  });
});
