import { createHash, randomUUID } from 'node:crypto';
import { ArtifactStreamError, DefaultTaskContext, RuntimeClient } from '../src';

const TASK_ID = randomUUID();
const OPERATION_ID = randomUUID();
const ARTIFACT_ID = randomUUID();
const FILE_NAME = 'Quarterly Source (final).docx';
const MIME_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

async function drainBody(body: ReadableStream<Uint8Array> | null | undefined): Promise<void> {
  if (!body || typeof body !== 'object' || !('getReader' in body)) return;
  const reader = (body as ReadableStream<Uint8Array>).getReader();
  while (!(await reader.read()).done) {
    // Consume the upload stream just as the storage facade would.
  }
}

function makeContext(fetchImpl: typeof fetch): DefaultTaskContext {
  const runtime = new RuntimeClient({
    baseUrl: 'http://runtime.test/api/runtime/v1',
    token: 'offline-test-token',
    fetchImpl,
  });
  return new DefaultTaskContext(
    {
      taskId: TASK_ID,
      operationId: OPERATION_ID,
      tenantId: 'tenant-test',
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'ingest',
      kind: 'ingest',
      taskKey: 'ingest-1',
      attempt: 1,
      leaseEpoch: 1,
      leaseExpiresAt: '2099-01-01T00:00:00.000Z',
      deadlineAt: null,
      input: {},
      connectorBindings: {},
      checkpointRefs: [],
      cancelRequested: false,
    } as never,
    {
      runtime,
      fetchImpl,
      logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
      invokeConnector: async () => { throw new Error('unused'); },
    }
  );
}

function accessGrant(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    artifactId: ARTIFACT_ID,
    downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    fileName: FILE_NAME,
    mimeType: MIME_TYPE,
    sizeBytes: 1,
    sha256: '0'.repeat(64),
    storageVersionId: 'sha256:metadata-v1',
    ...overrides,
  };
}

function withoutKey(value: Record<string, unknown>, key: string): Record<string, unknown> {
  const copy = { ...value };
  delete copy[key];
  return copy;
}

describe('ArtifactFacade.readWithMetadata', () => {
  it('round-trips the declared filename/MIME through grants and verifies byte metadata', async () => {
    const bytes = Buffer.from('offline Office artifact fixture');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    let uploadRequest: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? 'GET';

      if (url.endsWith(`/tasks/${TASK_ID}/artifacts`) && method === 'POST') {
        uploadRequest = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          uploadUrl: `https://blob.test/${ARTIFACT_ID}`,
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
      if (url === `https://blob.test/${ARTIFACT_ID}` && method === 'PUT') {
        await drainBody(init?.body as ReadableStream<Uint8Array> | null | undefined);
        return new Response(null, { status: 200 });
      }
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/finalize`) && method === 'POST') {
        return new Response(null, { status: 200 });
      }
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`) && method === 'POST') {
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: FILE_NAME,
          mimeType: MIME_TYPE,
          sizeBytes: bytes.length,
          sha256,
          storageVersionId: sha256,
        });
      }
      if (url === `https://blob.test/${ARTIFACT_ID}/download` && method === 'GET') {
        return new Response(bytes, {
          status: 200,
          headers: { 'content-length': String(bytes.length) },
        });
      }
      return new Response('unexpected request', { status: 404 });
    }) as typeof fetch;

    const runtime = new RuntimeClient({
      baseUrl: 'http://runtime.test/api/runtime/v1',
      token: 'offline-test-token',
      fetchImpl,
    });
    const ctx = new DefaultTaskContext(
      {
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        tenantId: 'tenant-test',
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: 'ingest',
        kind: 'ingest',
        taskKey: 'ingest-1',
        attempt: 1,
        leaseEpoch: 1,
        leaseExpiresAt: '2099-01-01T00:00:00.000Z',
        deadlineAt: null,
        input: {},
        connectorBindings: {},
        checkpointRefs: [],
        cancelRequested: false,
      } as never,
      {
        runtime,
        fetchImpl,
        logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
        invokeConnector: async () => { throw new Error('unused'); },
      }
    );

    const written = await ctx.artifacts.write(bytes, FILE_NAME, MIME_TYPE, 'input');
    expect(uploadRequest).toMatchObject({
      fileName: FILE_NAME,
      mimeType: MIME_TYPE,
      sizeBytes: bytes.length,
      purpose: 'input',
    });
    expect(written.fileName).toBe(FILE_NAME);

    const read = await ctx.artifacts.readWithMetadata(ARTIFACT_ID);
    expect(read).toEqual({
      buffer: bytes,
      filename: FILE_NAME,
      mimeType: MIME_TYPE,
      sizeBytes: bytes.length,
      sha256,
      storageVersionId: sha256,
      grantExpiresAt: '2099-01-01T00:00:00.000Z',
    });
  });

  it('rejects bytes that do not match the authorized grant digest', async () => {
    const declared = Buffer.from('expected bytes');
    const delivered = Buffer.from('tampered bytes');
    const sha256 = createHash('sha256').update(declared).digest('hex');
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: FILE_NAME,
          mimeType: MIME_TYPE,
          sizeBytes: declared.length,
          sha256,
          storageVersionId: sha256,
        });
      }
      if (url === `https://blob.test/${ARTIFACT_ID}/download`) {
        return new Response(delivered, { status: 200 });
      }
      return new Response('unexpected request', { status: 404 });
    }) as typeof fetch;
    const runtime = new RuntimeClient({
      baseUrl: 'http://runtime.test/api/runtime/v1',
      token: 'offline-test-token',
      fetchImpl,
    });
    const ctx = new DefaultTaskContext(
      {
        taskId: TASK_ID,
        operationId: OPERATION_ID,
        tenantId: 'tenant-test',
        businessId: 'document-core',
        businessVersion: '1.0.0',
        action: 'ingest',
        kind: 'ingest',
        taskKey: 'ingest-1',
        attempt: 1,
        leaseEpoch: 1,
        leaseExpiresAt: '2099-01-01T00:00:00.000Z',
        deadlineAt: null,
        input: {},
        connectorBindings: {},
        checkpointRefs: [],
        cancelRequested: false,
      } as never,
      {
        runtime,
        fetchImpl,
        logger: { debug() {}, info() {}, warn() {}, error() {}, child() { return this; } } as never,
        invokeConnector: async () => { throw new Error('unused'); },
      }
    );

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toMatchObject({
      code: 'HASH_MISMATCH',
    });
  });

  it('refuses an expired artifact grant before fetching its bytes', async () => {
    let blobRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2000-01-01T00:00:00.000Z',
          fileName: FILE_NAME,
          mimeType: MIME_TYPE,
          sizeBytes: 1,
          sha256: '0'.repeat(64),
          storageVersionId: 'expired-version',
        });
      }
      blobRequests += 1;
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toThrow('artifact access grant has expired');
    expect(blobRequests).toBe(0);
  });

  it('reads a grant with an extreme but representable far-future expiry without timer overflow', async () => {
    const bytes = Buffer.from('valid beyond the usual grant horizon');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const expiresAt = '9999-12-31T23:59:59.999Z';
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse(accessGrant({ expiresAt, sizeBytes: bytes.length, sha256 }));
      }
      if (url === `https://blob.test/${ARTIFACT_ID}/download`) {
        return new Response(bytes, { status: 200, headers: { 'content-length': String(bytes.length) } });
      }
      return new Response('unexpected request', { status: 404 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).resolves.toMatchObject({
      buffer: bytes,
      grantExpiresAt: expiresAt,
    });
  });

  it('refuses an expiry at the oldest supported date before fetching bytes', async () => {
    let downloadRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse(accessGrant({ expiresAt: '0000-01-01T00:00:00.000Z' }));
      }
      downloadRequests += 1;
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toThrow('artifact access grant has expired');
    expect(downloadRequests).toBe(0);
  });

  it('forwards a caller abort signal to the runtime access-grant request', async () => {
    const controller = new AbortController();
    let requestSignal: AbortSignal | null | undefined;
    const fetchImpl = ((
      _input: string | URL | Request,
      init?: RequestInit
    ) => {
      requestSignal = init?.signal;
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('grant request aborted')), { once: true });
      });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    const pending = ctx.artifacts.stat!(ARTIFACT_ID, { signal: controller.signal });
    controller.abort(new Error('caller deadline expired'));

    await expect(pending).rejects.toThrow();
    expect(requestSignal?.aborted).toBe(true);
  });

  it('refuses a read grant whose storage version changed after preflight', async () => {
    let accessRequests = 0;
    let blobRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        accessRequests += 1;
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: FILE_NAME,
          mimeType: MIME_TYPE,
          sizeBytes: 1,
          sha256: '0'.repeat(64),
          storageVersionId: accessRequests === 1 ? 'pinned-version-1' : 'pinned-version-2',
        });
      }
      blobRequests += 1;
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);
    const descriptor = await ctx.artifacts.stat!(ARTIFACT_ID);

    await expect(ctx.artifacts.readStream(ARTIFACT_ID, {
      expectedSha256: descriptor.sha256,
      expectedSizeBytes: descriptor.sizeBytes,
      expectedVersionId: descriptor.storageVersionId,
    })).rejects.toThrow('artifact storage version does not match the authorized descriptor');
    expect(blobRequests).toBe(0);
  });

  it('propagates the caller acquisition timeout signal through access-grant reads', async () => {
    let downloadSignal: AbortSignal | undefined;
    let markDownloadStarted!: () => void;
    const downloadStarted = new Promise<void>((resolve) => { markDownloadStarted = resolve; });
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: FILE_NAME,
          mimeType: MIME_TYPE,
          sizeBytes: 1,
          sha256: '0'.repeat(64),
          storageVersionId: 'pinned-version',
        });
      }
      downloadSignal = init?.signal as AbortSignal | undefined;
      markDownloadStarted();
      return new Promise<Response>((_resolve, reject) => {
        downloadSignal?.addEventListener('abort', () => reject(new Error('download aborted')), { once: true });
      });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);
    const timeout = new AbortController();
    const read = ctx.artifacts.readStream(ARTIFACT_ID, { signal: timeout.signal });

    await downloadStarted;
    timeout.abort(new Error('parser time budget elapsed'));
    await expect(read).rejects.toMatchObject({ code: 'TRANSPORT_FAILURE' });
    expect(downloadSignal?.aborted).toBe(true);
  });

  it('refuses a grant with no download descriptor before requesting artifact bytes', async () => {
    let downloadRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: FILE_NAME,
          mimeType: MIME_TYPE,
          sizeBytes: 1,
        });
      }
      downloadRequests += 1;
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toThrow(
      'access grant did not include a download URL'
    );
    expect(downloadRequests).toBe(0);
  });

  it('rejects an unparseable download descriptor before fetching bytes', async () => {
    let downloadRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: 'not a URL',
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
      downloadRequests += 1;
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toMatchObject({ name: 'ZodError' });
    expect(downloadRequests).toBe(0);
  });

  it.each(['artifactId', 'expiresAt', 'downloadUrl'])(
    'rejects an access grant missing required metadata field %s before fetching bytes',
    async (field) => {
      let downloadRequests = 0;
      const invalidGrant = withoutKey(accessGrant(), field);
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) return jsonResponse(invalidGrant);
        downloadRequests += 1;
        return new Response(new Uint8Array([0]), { status: 200 });
      }) as typeof fetch;
      const ctx = makeContext(fetchImpl);

      await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toThrow();
      expect(downloadRequests).toBe(0);
    }
  );

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
    ['string encoded', '1'],
    ['null', null],
  ])('rejects an unreadable %s grant size before fetching bytes', async (_caseName, sizeBytes) => {
    let downloadRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      if (String(input).endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse(accessGrant({ sizeBytes }));
      }
      downloadRequests += 1;
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toMatchObject({ name: 'ZodError' });
    expect(downloadRequests).toBe(0);
  });

  it.each([
    ['short digest', 'a'.repeat(63)],
    ['non-hex digest', `${'a'.repeat(63)}g`],
    ['uppercase hex encoding', 'A'.repeat(64)],
    ['base64 encoding', Buffer.alloc(32).toString('base64')],
    ['algorithm-prefixed encoding', `sha256:${'0'.repeat(64)}`],
    ['whitespace-padded encoding', `${'0'.repeat(64)} `],
  ])('rejects a read grant with a %s before fetching bytes', async (_caseName, sha256) => {
    let downloadRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) return jsonResponse(accessGrant({ sha256 }));
      downloadRequests += 1;
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toThrow();
    expect(downloadRequests).toBe(0);
  });

  it('accepts the maximum storage-version metadata length and rejects one character beyond it', async () => {
    const atLimit = makeContext((async () => jsonResponse(accessGrant({ storageVersionId: 'v'.repeat(1024) }))) as typeof fetch);
    const descriptor = await atLimit.artifacts.stat!(ARTIFACT_ID);
    expect(descriptor.storageVersionId).toHaveLength(1024);

    let downloadRequests = 0;
    const overLimit = makeContext((async (input: string | URL | Request) => {
      if (String(input).endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse(accessGrant({ storageVersionId: 'v'.repeat(1025) }));
      }
      downloadRequests += 1;
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch);

    await expect(overLimit.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toThrow();
    expect(downloadRequests).toBe(0);
  });

  it.each([
    ['malformed JSON', () => new Response('{"artifactId":', { status: 200 })],
    ['truncated download descriptor JSON', () => new Response(
      `{"artifactId":"${ARTIFACT_ID}","downloadUrl":"https://blob.test/${ARTIFACT_ID}/download","expiresAt":"2099-01-01T00:00:00.000Z","fileName":"${FILE_NAME}`,
      { status: 200, headers: { 'content-type': 'application/json' } },
    )],
    ['non-object JSON', () => jsonResponse([])],
    ['wrong metadata field type', () => jsonResponse(accessGrant({ expiresAt: 2099 }))],
  ])('fails closed for %s access-grant metadata without fetching bytes', async (_caseName, responseForMetadata) => {
    let downloadRequests = 0;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) return responseForMetadata();
      downloadRequests += 1;
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toThrow();
    expect(downloadRequests).toBe(0);
  });

  it('rejects an oversized content-length header and cancels the response body', async () => {
    let bodyCancelled = false;
    const maxArtifactBytes = 64 * 1024 * 1024;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          sizeBytes: 1,
        });
      }
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { bodyCancelled = true; },
      }), {
        status: 200,
        headers: { 'content-length': String(maxArtifactBytes + 1) },
      });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);
    const read = ctx.artifacts.readWithMetadata(ARTIFACT_ID);

    await expect(read).rejects.toBeInstanceOf(ArtifactStreamError);
    await expect(read).rejects.toMatchObject({
      code: 'TOO_LARGE',
      status: 413,
    });
    expect(bodyCancelled).toBe(true);
  });

  it('rejects a storage content-length that conflicts with the authorized grant size', async () => {
    let bodyCancelled = false;
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse(accessGrant({ sizeBytes: 1 }));
      }
      return new Response(new ReadableStream<Uint8Array>({
        cancel() { bodyCancelled = true; },
      }), {
        status: 200,
        headers: { 'content-length': '2' },
      });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toMatchObject({
      code: 'SIZE_MISMATCH',
      status: 422,
    });
    expect(bodyCancelled).toBe(true);
  });

  it.each(['not-a-size', '1.5', '-1'])(
    'does not let a corrupt content-length header bypass checksum verification (%s)',
    async (contentLength) => {
      const authorizedBytes = Buffer.from('artifact bytes');
      const corruptedBytes = Buffer.from('artifact byteS');
      const sha256 = createHash('sha256').update(authorizedBytes).digest('hex');
      const fetchImpl = (async (input: string | URL | Request) => {
        const url = String(input);
        if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
          return jsonResponse(accessGrant({ sizeBytes: authorizedBytes.length, sha256 }));
        }
        if (url === `https://blob.test/${ARTIFACT_ID}/download`) {
          return new Response(corruptedBytes, { status: 200, headers: { 'content-length': contentLength } });
        }
        return new Response('unexpected request', { status: 404 });
      }) as typeof fetch;
      const ctx = makeContext(fetchImpl);

      await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toMatchObject({ status: 422 });
    }
  );

  it.each([
    ['single-byte mutation', 'artifact bytes', 'artifact byteS'],
    ['same-length replacement', 'checksum fixture', 'checksum fixturE'],
  ])('rejects a same-size %s when the authorized checksum differs', async (_caseName, authorizedText, deliveredText) => {
    const authorizedBytes = Buffer.from(authorizedText);
    const deliveredBytes = Buffer.from(deliveredText);
    expect(deliveredBytes.length).toBe(authorizedBytes.length);
    const sha256 = createHash('sha256').update(authorizedBytes).digest('hex');
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse(accessGrant({ sizeBytes: authorizedBytes.length, sha256 }));
      }
      if (url === `https://blob.test/${ARTIFACT_ID}/download`) {
        return new Response(deliveredBytes, {
          status: 200,
          headers: { 'content-length': String(deliveredBytes.length) },
        });
      }
      return new Response('unexpected request', { status: 404 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toMatchObject({
      code: 'HASH_MISMATCH',
      status: 422,
    });
  });

  it('rejects a truncated download whose bytes do not satisfy the authorized descriptor', async () => {
    const declaredBytes = Buffer.from('complete artifact content');
    const truncatedBytes = declaredBytes.subarray(0, 5);
    const sha256 = createHash('sha256').update(declaredBytes).digest('hex');
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse(accessGrant({ sizeBytes: declaredBytes.length, sha256 }));
      }
      if (url === `https://blob.test/${ARTIFACT_ID}/download`) {
        return new Response(truncatedBytes, { status: 200 });
      }
      return new Response('unexpected request', { status: 404 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toMatchObject({
      code: 'SIZE_MISMATCH',
      status: 422,
    });
  });

  it('rejects an incomplete encryption marker in the access grant', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          sizeBytes: 1,
          encryption: { version: 1, algorithm: 'aes-256-gcm' },
        });
      }
      return new Response(new Uint8Array([0]), { status: 200 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.readWithMetadata(ARTIFACT_ID)).rejects.toMatchObject({ name: 'ZodError' });
  });
});
