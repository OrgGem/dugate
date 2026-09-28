import { createHash, randomUUID } from 'node:crypto';
import { DefaultTaskContext, RuntimeClient } from '../src';

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
});
