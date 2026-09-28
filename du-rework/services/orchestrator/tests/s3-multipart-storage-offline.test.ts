import { createHash } from 'node:crypto';
import {
  AbortMultipartUploadCommand,
  CompleteMultipartUploadCommand,
  CreateMultipartUploadCommand,
  ListPartsCommand,
  S3Client,
  UploadPartCommand,
} from '@aws-sdk/client-s3';
import { createS3ArtifactStorageFacade } from '../src/modules/artifacts/s3-storage-facade';
import { ArtifactStorageError } from '../src/modules/artifacts/storage-facade';
import type { ArtifactMultipartStorage } from '../src/modules/artifacts/multipart-storage';

/**
 * DATA-02 S3 multipart port (Qwen-5) — offline command-level tests.
 * These prove the lifecycle methods exist and talk to S3 with the exact
 * commands, metadata and part bindings the lifecycle depends on. The fake
 * provider decides what it stores; the signer is injected, so nothing here
 * reaches a network or a bucket. Real signed PUTs against an actual bucket
 * remain a Tester/live-window item (DATA-INT-01), not an offline claim.
 */

const BUCKET = 'du-artifacts-test';
const LOCATOR = { artifactId: 'artifact-mp-1', tenantId: 'tenant-mp-1', objectKey: 'tenant-mp-1/artifact-mp-1' };

function providerError(name: string, statusCode = 404): Error {
  return Object.assign(new Error('provider detail that must never surface'), {
    name,
    Code: name,
    $metadata: { httpStatusCode: statusCode },
  });
}

function makeS3(behaviour: {
  uploadId?: string | null;
  pages?: { Parts: unknown[]; IsTruncated?: boolean; NextPartNumberMarker?: string }[];
  completeVersion?: string | null;
  fail?: Record<string, Error>;
} = {}) {
  const sent: unknown[] = [];
  const send = jest.fn(async (command: unknown) => {
    sent.push(command);
    if (command instanceof CreateMultipartUploadCommand) {
      if (behaviour.fail?.create) throw behaviour.fail.create;
      return { UploadId: behaviour.uploadId === undefined ? 'provider-upload-1' : behaviour.uploadId };
    }
    if (command instanceof ListPartsCommand) {
      if (behaviour.fail?.list) throw behaviour.fail.list;
      const marker = command.input.PartNumberMarker;
      const index = marker ? 1 : 0;
      const page = behaviour.pages?.[index] ?? { Parts: [] };
      return page;
    }
    if (command instanceof CompleteMultipartUploadCommand) {
      if (behaviour.fail?.complete) throw behaviour.fail.complete;
      return { VersionId: behaviour.completeVersion === undefined ? 'v-1' : behaviour.completeVersion };
    }
    if (command instanceof AbortMultipartUploadCommand) {
      if (behaviour.fail?.abort) throw behaviour.fail.abort;
      return {};
    }
    throw new Error('unexpected command: ' + String((command as object)?.constructor?.name));
  });
  const client = { send } as unknown as S3Client;
  return { client, sent, send };
}

function makeFacade(behaviour: Parameters<typeof makeS3>[0] = {}, signOutcome: 'url' | 'throw' | 'invalid' = 'url') {
  const s3 = makeS3(behaviour);
  const signed: { command: UploadPartCommand; expiresIn: number }[] = [];
  const presignPart = jest.fn(async (client: S3Client, command: UploadPartCommand, expiresIn: number) => {
    signed.push({ command, expiresIn });
    if (signOutcome === 'throw') throw new Error('signer unavailable');
    if (signOutcome === 'invalid') throw new ArtifactStorageError('INVALID_UPLOAD_GRANT');
    return 'https://storage.test/' + command.input.Key + '?part=' + command.input.PartNumber + '&sig=opaque';
  });
  // A fixed clock keeps the presign window assertions independent of the
  // wall time the suite happens to run at.
  const facade = createS3ArtifactStorageFacade({
    bucket: BUCKET,
    client: s3.client,
    presignPart,
    now: () => Date.parse('2026-09-25T00:00:00.000Z'),
  });
  return { facade, s3, signed, presignPart };
}

function hexOf(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('createMultipartUpload', () => {
  test('binds artifact and tenant identity into the provider object metadata', async () => {
    const { facade, s3 } = makeFacade();
    const created = await facade.createMultipartUpload({ ...LOCATOR, contentType: 'application/pdf' });
    expect(created).toEqual({ uploadId: 'provider-upload-1' });
    const command = s3.sent[0] as CreateMultipartUploadCommand;
    expect(command.input.Bucket).toBe(BUCKET);
    expect(command.input.ContentType).toBe('application/pdf');
    expect(command.input.Metadata).toEqual({ artifactid: LOCATOR.artifactId, tenantid: LOCATOR.tenantId });
  });

  test('the port has no task concept: one facade instance serves the public branch identically (W-DATA02-PUB-1)', async () => {
    const publicLocator = { artifactId: 'artifact-public-1', tenantId: 'tenant-public-1', objectKey: 'art-artifact-public-1' };
    const { facade, s3 } = makeFacade();
    await facade.createMultipartUpload({ ...publicLocator, contentType: 'application/octet-stream' });
    const command = s3.sent[0] as CreateMultipartUploadCommand;
    expect(command.input.Key).toBe(publicLocator.objectKey);
    expect(command.input.Metadata).toEqual({ artifactid: publicLocator.artifactId, tenantid: publicLocator.tenantId });
    // Neither branch puts the tenant into the object key: isolation is the
    // metadata binding above (verified on every read) plus the service fence,
    // so the presigned URL the client receives carries no tenant identifier.
    expect(command.input.Key).not.toContain('tenant');
  });

  test('refuses an incomplete request and a provider that returns no upload id', async () => {
    await expect(makeFacade().facade.createMultipartUpload({ ...LOCATOR, contentType: '' }))
      .rejects.toMatchObject({ code: 'INVALID_UPLOAD_GRANT' });
    await expect(makeFacade({ uploadId: null }).facade.createMultipartUpload({ ...LOCATOR, contentType: 'text/plain' }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });

  test('replaces a provider failure with a stable code', async () => {
    const { facade } = makeFacade({ fail: { create: providerError('AccessDenied', 403) } });
    await expect(facade.createMultipartUpload({ ...LOCATOR, contentType: 'text/plain' }))
      .rejects.toBeInstanceOf(ArtifactStorageError);
    await expect(facade.createMultipartUpload({ ...LOCATOR, contentType: 'text/plain' }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});

describe('presignUploadPart', () => {
  const input = {
    ...LOCATOR,
    uploadId: 'provider-upload-1',
    partNumber: 3,
    sizeBytes: 8 * 1024 * 1024,
    partSha256: hexOf(Buffer.from('part-3')),
    expiresAt: new Date(Date.parse('2026-09-25T01:00:00.000Z')).toISOString(),
  };

  test('signs exactly one part with its declared size and checksum', async () => {
    const now = Date.parse('2026-09-25T00:00:00.000Z');
    const s3 = makeS3();
    const signed: { command: UploadPartCommand; expiresIn: number }[] = [];
    const facade = createS3ArtifactStorageFacade({
      bucket: BUCKET,
      client: s3.client,
      now: () => now,
      presignPart: async (_client, command, expiresIn) => {
        signed.push({ command, expiresIn });
        return 'https://storage.test/signed';
      },
    });
    const grant = await facade.presignUploadPart(input);
    expect(signed).toHaveLength(1);
    expect(signed[0]!.command.input).toMatchObject({
      Bucket: BUCKET,
      Key: input.objectKey,
      UploadId: input.uploadId,
      PartNumber: 3,
      ContentLength: input.sizeBytes,
      ChecksumSHA256: Buffer.from(input.partSha256, 'hex').toString('base64'),
    });
    expect(signed[0]!.expiresIn).toBe(3600);
    expect(grant).toMatchObject({ url: 'https://storage.test/signed', expiresAt: input.expiresAt });
    expect(grant.headers).toMatchObject({
      'content-length': String(input.sizeBytes),
      'x-amz-checksum-sha256': Buffer.from(input.partSha256, 'hex').toString('base64'),
    });
  });

  test('refuses a declaration it cannot bind before signing anything', async () => {
    const { facade, signed } = makeFacade();
    const rejects: Array<[string, Partial<typeof input>]> = [
      ['a non-hex part hash', { partSha256: 'zz' + hexOf(Buffer.from('x')).slice(2) }],
      ['a part zero', { partNumber: 0 }],
      ['an empty part', { sizeBytes: 0 }],
      ['an upload without an id', { uploadId: '' }],
    ];
    for (const [, patch] of rejects) {
      await expect(facade.presignUploadPart({ ...input, expiresAt: '2026-10-01T00:00:00.000Z', ...patch } as typeof input))
        .rejects.toMatchObject({ code: 'INVALID_UPLOAD_GRANT' });
    }
    expect(signed).toHaveLength(0);
  });

  test('refuses an expiry window outside the presignable range', async () => {
    const { facade, presignPart } = makeFacade();
    await expect(facade.presignUploadPart({ ...input, expiresAt: 'not-a-date' })).rejects.toMatchObject({
      code: 'INVALID_UPLOAD_GRANT',
    });
    await expect(
      facade.presignUploadPart({ ...input, expiresAt: '2026-09-25T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_UPLOAD_GRANT' });
    await expect(
      facade.presignUploadPart({ ...input, expiresAt: '2026-10-05T00:00:00.000Z' }),
    ).rejects.toMatchObject({ code: 'INVALID_UPLOAD_GRANT' });
    expect(presignPart).not.toHaveBeenCalled();
  });

  test('turns a signer failure into a stable storage code', async () => {
    await expect(makeFacade({}, 'throw').facade.presignUploadPart({ ...input, expiresAt: '2026-09-25T01:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
    // A rejection the signer already classified keeps its own code.
    await expect(makeFacade({}, 'invalid').facade.presignUploadPart({ ...input, expiresAt: '2026-09-25T01:00:00.000Z' }))
      .rejects.toMatchObject({ code: 'INVALID_UPLOAD_GRANT' });
  });
});

describe('listMultipartParts', () => {
  const part = (partNumber: number, bytes: Buffer, etag = 'etag-' + partNumber) => ({
    PartNumber: partNumber,
    ETag: etag,
    Size: bytes.byteLength,
    ChecksumSHA256: Buffer.from(hexOf(bytes), 'hex').toString('base64'),
  });

  test('reports what storage holds, with provider checksums decoded to hex', async () => {
    const third = Buffer.from('part-3');
    const { facade, s3 } = makeFacade({
      pages: [
        { Parts: [part(1, Buffer.from('p1')), part(2, Buffer.from('p2'))], IsTruncated: true, NextPartNumberMarker: '2' },
        { Parts: [part(3, third)] },
      ],
    });
    const listed = await facade.listMultipartParts({ objectKey: LOCATOR.objectKey, uploadId: 'provider-upload-1' });
    expect(listed).toHaveLength(3);
    expect(listed[2]).toEqual({ partNumber: 3, etag: 'etag-3', sizeBytes: third.byteLength, sha256: hexOf(third) });
    const secondPage = s3.sent[1] as ListPartsCommand;
    expect(secondPage.input.PartNumberMarker).toBe('2');
  });

  test('refuses a part storage cannot account for', async () => {
    const held = part(1, Buffer.from('p1'));
    const { facade } = makeFacade({ pages: [{ Parts: [{ ...held, ChecksumSHA256: undefined }] }] });
    await expect(facade.listMultipartParts({ objectKey: LOCATOR.objectKey, uploadId: 'u' }))
      .rejects.toMatchObject({ code: 'CHECKSUM_MISMATCH' });
  });

  test('reports a discarded upload as missing bytes', async () => {
    const { facade } = makeFacade({ fail: { list: providerError('NoSuchUpload') } });
    await expect(facade.listMultipartParts({ objectKey: LOCATOR.objectKey, uploadId: 'u' }))
      .rejects.toMatchObject({ code: 'OBJECT_NOT_FOUND' });
  });

  test('stops a provider that never finishes paginating', async () => {
    const { facade, s3 } = makeFacade();
    s3.send.mockImplementation(async () => ({ Parts: [], IsTruncated: true, NextPartNumberMarker: '1' }));
    await expect(facade.listMultipartParts({ objectKey: LOCATOR.objectKey, uploadId: 'u' }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});

describe('completeMultipartUpload and abortMultipartUpload', () => {
  const parts = [
    { partNumber: 2, etag: 'etag-2' },
    { partNumber: 1, etag: 'etag-1' },
  ];

  test('submits the part list ordered and requires an immutable version', async () => {
    const { facade, s3 } = makeFacade();
    await expect(facade.completeMultipartUpload({ ...LOCATOR, uploadId: 'u', parts }))
      .resolves.toEqual({ versionId: 'v-1' });
    const command = s3.sent[0] as CompleteMultipartUploadCommand;
    expect(command.input.MultipartUpload?.Parts).toEqual([
      { PartNumber: 1, ETag: 'etag-1' },
      { PartNumber: 2, ETag: 'etag-2' },
    ]);
    await expect(makeFacade({ completeVersion: 'null' }).facade.completeMultipartUpload({ ...LOCATOR, uploadId: 'u', parts }))
      .rejects.toMatchObject({ code: 'OBJECT_VERSION_REQUIRED' });
    await expect(makeFacade({ completeVersion: null }).facade.completeMultipartUpload({ ...LOCATOR, uploadId: 'u', parts }))
      .rejects.toMatchObject({ code: 'OBJECT_VERSION_REQUIRED' });
  });

  test('refuses to complete an empty part list without asking the provider', async () => {
    const { facade, s3 } = makeFacade();
    await expect(facade.completeMultipartUpload({ ...LOCATOR, uploadId: 'u', parts: [] }))
      .rejects.toMatchObject({ code: 'INVALID_UPLOAD_GRANT' });
    expect(s3.send).not.toHaveBeenCalled();
  });

  test('treats aborting a gone upload as success', async () => {
    const gone = makeFacade({ fail: { abort: providerError('NoSuchUpload') } });
    await expect(gone.facade.abortMultipartUpload({ objectKey: LOCATOR.objectKey, uploadId: 'u' })).resolves.toBeUndefined();
    expect(gone.s3.send).toHaveBeenCalledTimes(1);

    const refused = makeFacade({ fail: { abort: providerError('AccessDenied', 403) } });
    await expect(refused.facade.abortMultipartUpload({ objectKey: LOCATOR.objectKey, uploadId: 'u' }))
      .rejects.toMatchObject({ code: 'STORAGE_UNAVAILABLE' });
  });
});

test('the S3 facade satisfies the DATA-02 multipart storage port', () => {
  const storage: ArtifactMultipartStorage = makeFacade().facade;
  expect(typeof storage.createMultipartUpload).toBe('function');
  expect(typeof storage.presignUploadPart).toBe('function');
  expect(typeof storage.listMultipartParts).toBe('function');
  expect(typeof storage.completeMultipartUpload).toBe('function');
  expect(typeof storage.abortMultipartUpload).toBe('function');
  expect(typeof storage.verifyAndPin).toBe('function');
  expect(typeof storage.delete).toBe('function');
});
