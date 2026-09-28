import { randomUUID } from 'node:crypto';
import { DefaultTaskContext, LeaseLostError, RuntimeClient } from '../src';

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

function makeContext(fetchImpl: typeof fetch) {
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
  });

  it('fences a stale lease the same way read grants do', async () => {
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input);
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
  });
});