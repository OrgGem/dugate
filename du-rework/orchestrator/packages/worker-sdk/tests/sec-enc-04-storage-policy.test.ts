import { Readable } from 'node:stream';
import { randomUUID } from 'node:crypto';
import {
  ARTIFACT_STORAGE_POLICY_CODES,
  ArtifactStreamError,
  isArtifactStoragePolicyCode,
  readErrorResponse,
  uploadArtifactMultipart,
  uploadArtifactStream,
  type MultipartUploadTransport,
} from '../src';

/**
 * SEC-ENC-04 (SD-03): the server owns persistence-encryption policy; the SDK
 * must surface its refusals as stable, non-retryable failures. Offline only:
 * fake fetchers and fake multipart transports, no sockets or storage.
 */

function problemResponse(status: number, code: string, detail: string): Response {
  return new Response(
    JSON.stringify({ type: 'urn:du:error:' + code.toLowerCase(), title: code, status, code, detail }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

describe('artifact storage-policy codes (SEC-ENC-04)', () => {
  it('recognizes the server policy codes and nothing else', () => {
    expect(isArtifactStoragePolicyCode(ARTIFACT_STORAGE_POLICY_CODES.encryptedMultipartUnavailable)).toBe(true);
    expect(isArtifactStoragePolicyCode(ARTIFACT_STORAGE_POLICY_CODES.encryptionRequired)).toBe(true);
    expect(isArtifactStoragePolicyCode(ARTIFACT_STORAGE_POLICY_CODES.envelopeInvalid)).toBe(true);
    expect(isArtifactStoragePolicyCode('TEMPORARY_UNAVAILABLE')).toBe(false);
    expect(isArtifactStoragePolicyCode(undefined)).toBe(false);
    expect(isArtifactStoragePolicyCode(42)).toBe(false);
  });

  it('readErrorResponse keeps the machine code and bounds the server-authored detail', async () => {
    const parsed = await readErrorResponse(
      problemResponse(501, 'ENCRYPTED_MULTIPART_UNAVAILABLE', 'x'.repeat(1000)),
    );
    expect(parsed.code).toBe('ENCRYPTED_MULTIPART_UNAVAILABLE');
    expect(parsed.detail.length).toBe(240);
  });
});

describe('uploadArtifactStream policy refusal (SEC-ENC-04)', () => {
  it('maps a 501 storage-policy refusal to STORAGE_POLICY_REJECTED exactly once', async () => {
    let fetches = 0;
    const fetcher = (async () => {
      fetches += 1;
      return problemResponse(501, 'ENCRYPTED_MULTIPART_UNAVAILABLE', 'worker multipart is disabled');
    }) as unknown as typeof fetch;

    const failure = await uploadArtifactStream(Readable.from([Buffer.from('abcd')]), {
      uploadUrl: 'http://orchestrator.test/api/runtime/v1/artifacts/blob/art-x?grant=g',
      mimeType: 'application/octet-stream',
      sizeBytes: 4,
      maxBytes: 16,
      fetcher,
    }).then(
      () => null,
      (error: unknown) => error as ArtifactStreamError,
    );

    expect(failure).toBeInstanceOf(ArtifactStreamError);
    expect(failure?.code).toBe('STORAGE_POLICY_REJECTED');
    expect(failure?.status).toBe(501);
    expect(fetches).toBe(1);
  });

  it('keeps a non-policy 503 mapped to the transport taxonomy', async () => {
    const fetcher = (async () =>
      problemResponse(503, 'TEMPORARY_UNAVAILABLE', 'storage is unavailable')) as unknown as typeof fetch;

    const failure = await uploadArtifactStream(Readable.from([Buffer.from('abcd')]), {
      uploadUrl: 'http://orchestrator.test/api/runtime/v1/artifacts/blob/art-x?grant=g',
      mimeType: 'application/octet-stream',
      sizeBytes: 4,
      maxBytes: 16,
      fetcher,
    }).then(
      () => null,
      (error: unknown) => error as ArtifactStreamError,
    );

    expect(failure?.code).toBe('DOWNLOAD_REJECTED');
    expect(failure?.status).toBe(503);
  });
});

describe('uploadArtifactMultipart policy refusal (SEC-ENC-04)', () => {
  function makeFake(putStatus: number) {
    const artifactId = randomUUID();
    const puts: number[] = [];
    const aborts: string[] = [];
    let completed = 0;
    const transport: MultipartUploadTransport = {
      async init() {
        return {
          artifactId,
          uploadHandle: 'mh_test',
          partSizeBytes: 1024,
          partCount: 1,
          expiresAt: '2099-01-01T00:00:00.000Z',
          replayed: false,
        };
      },
      async partGrant(id, body) {
        return {
          artifactId: id,
          partNumber: body.partNumber,
          partUrl: 'http://orchestrator.test/api/runtime/v1/artifacts/' + id + '/part/' + body.partNumber,
          sizeBytes: 1024,
          requiredHeaders: {},
          expiresAt: '2099-01-01T00:00:00.000Z',
        };
      },
      async complete() {
        completed += 1;
        throw new Error('complete must not be reached on a policy refusal');
      },
      async abort(_id, body) {
        aborts.push(body.reason);
        return { artifactId, state: 'ABORTED', replayed: false };
      },
    };
    const fetcher = (async () => {
      puts.push(puts.length + 1);
      return putStatus === 501
        ? problemResponse(501, 'ENCRYPTED_MULTIPART_UNAVAILABLE', 'worker multipart is disabled')
        : problemResponse(putStatus, 'TEMPORARY_UNAVAILABLE', 'storage is unavailable');
    }) as unknown as typeof fetch;
    return { transport, fetcher, puts, aborts, completed: () => completed, artifactId };
  }

  it('does not retry a 501 part refusal and aborts the session', async () => {
    const fake = makeFake(501);
    const failure = await uploadArtifactMultipart(Readable.from([Buffer.alloc(1024, 7)]), {
      transport: fake.transport,
      fetcher: fake.fetcher,
      fileName: 'output.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 1024,
      retryBaseDelayMs: 0,
    }).then(
      () => null,
      (error: unknown) => error as ArtifactStreamError,
    );

    expect(failure).toBeInstanceOf(ArtifactStreamError);
    expect(failure?.code).toBe('STORAGE_POLICY_REJECTED');
    expect(failure?.status).toBe(501);
    expect(fake.puts).toEqual([1]);
    expect(fake.aborts).toEqual(['failed']);
    expect(fake.completed()).toBe(0);
  });

  it('still retries a retryable 503 part refusal up to its attempt budget', async () => {
    const fake = makeFake(503);
    const failure = await uploadArtifactMultipart(Readable.from([Buffer.alloc(1024, 7)]), {
      transport: fake.transport,
      fetcher: fake.fetcher,
      fileName: 'output.bin',
      mimeType: 'application/octet-stream',
      sizeBytes: 1024,
      retryBaseDelayMs: 0,
      partPutAttempts: 3,
    }).then(
      () => null,
      (error: unknown) => error as ArtifactStreamError,
    );

    expect(failure?.code).toBe('DOWNLOAD_REJECTED');
    expect(fake.puts).toEqual([1, 2, 3]);
    expect(fake.aborts).toEqual(['failed']);
  });
});
