import { randomUUID } from 'node:crypto';
import { AmbiguousReportError, DefaultTaskContext, LeaseLostError, RuntimeClient, RuntimeError } from '../src';

const TASK_ID = randomUUID();
const OPERATION_ID = randomUUID();
const ARTIFACT_ID = randomUUID();

/**
 * ArtifactFacade.stat (DATA-04 Step B seam) — offline contract tests.
 * stat exposes the authorized read descriptor WITHOUT bytes so businesses can
 * pre-flight size/integrity before choosing disk-backed streaming acquisition.
 */

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { 'content-type': 'application/json' } });
}

function makeContext(fetchImpl: typeof fetch, runtimeTimeoutMs = 10_000) {
  const runtime = new RuntimeClient({
    baseUrl: 'http://runtime.test/api/runtime/v1',
    token: 'offline-test-token',
    fetchImpl,
    timeoutMs: runtimeTimeoutMs,
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

describe('ArtifactFacade.stat', () => {
  it('returns the grant descriptor fields without touching blob bytes', async () => {
    const urls: string[] = [];
    let grantBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`) && init?.method === 'POST') {
        grantBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2099-01-01T00:00:00.000Z',
          fileName: 'quarterly.docx',
          mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
          sizeBytes: 70_000_000,
          sha256: 'a'.repeat(64),
          storageVersionId: 'blob-version-1',
        });
      }
      return new Response('unexpected request', { status: 404 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    const stat = await ctx.artifacts.stat!(ARTIFACT_ID);
    expect(stat).toEqual({
      fileName: 'quarterly.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      sizeBytes: 70_000_000,
      sha256: 'a'.repeat(64),
      storageVersionId: 'blob-version-1',
      grantExpiresAt: '2099-01-01T00:00:00.000Z',
    });
    expect(grantBody).toMatchObject({ taskId: TASK_ID, leaseEpoch: 1, mode: 'read' });
    // descriptor-only: the blob URL was never fetched
    expect(urls).toHaveLength(1);
  });

  it('yields undefined descriptor fields when the grant omits them', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return jsonResponse({
          artifactId: ARTIFACT_ID,
          downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
          expiresAt: '2099-01-01T00:00:00.000Z',
        });
      }
      return new Response('unexpected request', { status: 404 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    const stat = await ctx.artifacts.stat!(ARTIFACT_ID);
    expect(stat.fileName).toBeUndefined();
    expect(stat.sizeBytes).toBeUndefined();
    expect(stat.sha256).toBeUndefined();
    expect(stat.storageVersionId).toBeUndefined();
    expect(stat.grantExpiresAt).toBe('2099-01-01T00:00:00.000Z');
  });

  it.each([
    { status: 404, code: 'NOT_FOUND' },
    { status: 403, code: 'FORBIDDEN' },
  ])('rejects a $status access-grant response ($code)', async ({ status, code }) => {
    const fetchImpl = (async () => new Response(
      JSON.stringify({
        type: `urn:du:error:${code.toLowerCase()}`,
        title: code,
        status,
        code,
      }),
      { status, headers: { 'content-type': 'application/problem+json' } }
    )) as typeof fetch;
    const ctx = makeContext(fetchImpl);
    const stat = ctx.artifacts.stat!(ARTIFACT_ID);

    await expect(stat).rejects.toMatchObject({
      name: 'RuntimeError',
      status,
      code,
    });
    await expect(stat).rejects.toBeInstanceOf(RuntimeError);
  });

  it('does not probe blob storage for a non-existent artifact ID', async () => {
    const missingArtifactId = randomUUID();
    const requestedUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return new Response(JSON.stringify({
        type: 'urn:du:error:not_found',
        title: 'Not found',
        status: 404,
        code: 'NOT_FOUND',
      }), { status: 404, headers: { 'content-type': 'application/problem+json' } });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.stat!(missingArtifactId)).rejects.toMatchObject({
      name: 'RuntimeError',
      status: 404,
      code: 'NOT_FOUND',
    });
    expect(requestedUrls).toEqual([
      `http://runtime.test/api/runtime/v1/artifacts/${missingArtifactId}/access`,
    ]);
  });

  it('rejects a successful response with a malformed grant descriptor', async () => {
    const fetchImpl = (async () => jsonResponse({
      artifactId: ARTIFACT_ID,
      downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      sizeBytes: '70MB',
    })) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.stat!(ARTIFACT_ID)).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('rejects a negative content-length/sizeBytes descriptor and accepts the empty-artifact boundary', async () => {
    const negative = makeContext((async () => jsonResponse({
      artifactId: ARTIFACT_ID,
      downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      sizeBytes: -1,
    })) as typeof fetch);
    await expect(negative.artifacts.stat!(ARTIFACT_ID)).rejects.toMatchObject({ name: 'ZodError' });

    const empty = makeContext((async () => jsonResponse({
      artifactId: ARTIFACT_ID,
      downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      sizeBytes: 0,
    })) as typeof fetch);
    await expect(empty.artifacts.stat!(ARTIFACT_ID)).resolves.toMatchObject({ sizeBytes: 0 });
  });

  it('preserves a valid stat size beyond 2 GiB without fetching artifact bytes', async () => {
    const largeSizeBytes = 2 * 1024 * 1024 * 1024 + 1;
    const requestedUrls: string[] = [];
    const fetchImpl = (async (input: string | URL | Request) => {
      requestedUrls.push(String(input));
      return jsonResponse({
        artifactId: ARTIFACT_ID,
        downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
        expiresAt: '2099-01-01T00:00:00.000Z',
        sizeBytes: largeSizeBytes,
      });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.stat!(ARTIFACT_ID)).resolves.toMatchObject({ sizeBytes: largeSizeBytes });
    expect(requestedUrls).toHaveLength(1);
    expect(requestedUrls[0]).toContain(`/artifacts/${ARTIFACT_ID}/access`);
  });

  it.each([
    ['short', 'a'.repeat(63)],
    ['uppercase', 'A'.repeat(64)],
    ['non-hex', `${'a'.repeat(63)}g`],
    ['empty', ''],
    ['oversized', 'a'.repeat(65)],
    ['whitespace', `${'a'.repeat(63)} `],
  ])('rejects an invalid %s checksum in the access-grant metadata', async (_caseName, sha256) => {
    const ctx = makeContext((async () => jsonResponse({
      artifactId: ARTIFACT_ID,
      downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
      expiresAt: '2099-01-01T00:00:00.000Z',
      sizeBytes: 1,
      sha256,
    })) as typeof fetch);

    await expect(ctx.artifacts.stat!(ARTIFACT_ID)).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('rejects a non-JSON access-grant response', async () => {
    const fetchImpl = (async () => new Response('{"artifactId":', {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.stat!(ARTIFACT_ID)).rejects.toBeInstanceOf(SyntaxError);
  });

  it('fences a stale lease the same way read grants do', async () => {
    const requestedUrls: string[] = [];
    const requestBodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      requestedUrls.push(url);
      requestBodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      if (url.endsWith(`/artifacts/${ARTIFACT_ID}/access`)) {
        return new Response(
          JSON.stringify({
            type: 'urn:du:error:lease-lost',
            title: 'Lease lost',
            status: 409,
            code: 'LEASE_LOST',
            detail: 'stale leaseEpoch',
          }),
          { status: 409, headers: { 'content-type': 'application/problem+json' } }
        );
      }
      return new Response('unexpected request', { status: 404 });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.stat!(ARTIFACT_ID)).rejects.toBeInstanceOf(LeaseLostError);
    expect(requestedUrls).toEqual([
      `http://runtime.test/api/runtime/v1/artifacts/${ARTIFACT_ID}/access`,
    ]);
    expect(requestBodies).toEqual([{ taskId: TASK_ID, leaseEpoch: 1, mode: 'read' }]);
  });

  it('surfaces a runtime timeout while querying stat and preserves the ambiguous outcome', async () => {
    let observedAbort = false;
    let signal: AbortSignal | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        signal = init?.signal ?? undefined;
        const onAbort = (): void => {
          observedAbort = true;
          reject(new Error('stat request timed out'));
        };
        if (signal?.aborted) onAbort();
        else signal?.addEventListener('abort', onAbort, { once: true });
      })) as typeof fetch;
    const ctx = makeContext(fetchImpl, 10);

    await expect(ctx.artifacts.stat!(ARTIFACT_ID)).rejects.toBeInstanceOf(AmbiguousReportError);
    expect(observedAbort).toBe(true);
    expect(signal?.aborted).toBe(true);
  });

  it('does not request an artifact descriptor after its lease has been lost', async () => {
    let requests = 0;
    const ctx = makeContext((async () => {
      requests += 1;
      return jsonResponse({
        artifactId: ARTIFACT_ID,
        downloadUrl: `https://blob.test/${ARTIFACT_ID}/download`,
        expiresAt: '2099-01-01T00:00:00.000Z',
      });
    }) as typeof fetch);
    ctx.abort('lease-lost');

    await expect(ctx.artifacts.stat!(ARTIFACT_ID)).rejects.toBeInstanceOf(LeaseLostError);
    expect(requests).toBe(0);
  });

  it.each([
    ['tenant mismatch', 'TENANT_MISMATCH'],
    ['operation mismatch', 'OPERATION_MISMATCH'],
  ])('does not expose a descriptor when the runtime denies %s', async (_caseName, code) => {
    let requestBody: Record<string, unknown> | undefined;
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        type: `urn:du:error:${code.toLowerCase()}`,
        title: code,
        status: 403,
        code,
      }), { status: 403, headers: { 'content-type': 'application/problem+json' } });
    }) as typeof fetch;
    const ctx = makeContext(fetchImpl);

    await expect(ctx.artifacts.stat!(ARTIFACT_ID)).rejects.toMatchObject({
      name: 'RuntimeError',
      status: 403,
      code,
    });
    expect(requestBody).toMatchObject({ taskId: TASK_ID, leaseEpoch: 1, mode: 'read' });
  });
});
