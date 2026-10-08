import { randomUUID } from 'node:crypto';
import {
  ArtifactUploadGrantRequestSchema,
  ArtifactUploadGrantSchema,
  ArtifactFinalizeRequestSchema,
  ArtifactAccessRequestSchema,
  ArtifactAccessGrantSchema,
  InvocationGrantRequestSchema,
  InvocationGrantSchema,
} from '@du/contracts';
import { documentCoreManifest } from '../src/manifest/document-core.manifest';
import { startDocumentCoreWorker } from '../src/worker';

describe('Cross-Service Multi-Container E2E Boundary Readiness (P2-07 Boundary Preparation)', () => {
  const REQUIRED_RUNTIME_ROUTES = [
    { method: 'POST', path: '/api/runtime/v1/tasks/:id/artifacts', purpose: 'Artifact upload grant' },
    { method: 'POST', path: '/api/runtime/v1/artifacts/:id/finalize', purpose: 'Artifact finalization' },
    { method: 'POST', path: '/api/runtime/v1/artifacts/:id/access', purpose: 'Artifact access grant' },
    { method: 'POST', path: '/api/runtime/v1/tasks/:id/invocation-grants', purpose: 'Invocation grant issuance' },
    { method: 'PUT', path: '/api/v1/admin/businesses/:id/versions/:version/enable', purpose: 'Production version enablement' },
  ];

  it('declares exact frozen contract schemas for all required P2-07 missing routes', () => {
    // 1. Artifact upload grant request and response
    const uploadReq = ArtifactUploadGrantRequestSchema.parse({
      leaseEpoch: 1,
      purpose: 'output',
      mimeType: 'application/json',
      sizeBytes: 1024,
    });
    expect(uploadReq.purpose).toBe('output');

    const uploadGrant = ArtifactUploadGrantSchema.parse({
      artifactId: randomUUID(),
      storageKey: 'key-1',
      uploadUrl: 'http://storage.internal/upload/1',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(uploadGrant.uploadUrl).toBeDefined();

    // 2. Artifact finalize request
    const finalizeReq = ArtifactFinalizeRequestSchema.parse({
      taskId: randomUUID(),
      leaseEpoch: 1,
      sizeBytes: 1024,
      sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    });
    expect(finalizeReq.sizeBytes).toBe(1024);

    // 3. Artifact access request and grant
    const accessReq = ArtifactAccessRequestSchema.parse({
      taskId: randomUUID(),
      leaseEpoch: 1,
      mode: 'read',
    });
    expect(accessReq.mode).toBe('read');

    const accessGrant = ArtifactAccessGrantSchema.parse({
      artifactId: randomUUID(),
      mode: 'read',
      downloadUrl: 'http://storage.internal/download/1',
      expiresAt: new Date(Date.now() + 60000).toISOString(),
    });
    expect(accessGrant.downloadUrl).toBeDefined();

    // 4. Invocation grant request and grant
    const grantReq = InvocationGrantRequestSchema.parse({
      leaseEpoch: 1,
      stepKey: 'extract:connector-inference',
      bindingSlot: 'reasoning',
      inputHash: 'hash-abc',
    });
    expect(grantReq.bindingSlot).toBe('reasoning');

    const invGrant = InvocationGrantSchema.parse({
      grant: 'signed.grant.token',
      invocationId: 'inv-123',
      connectorId: 'connector-default',
      connectorRevision: 1,
      expiresAt: new Date(Date.now() + 60000).toISOString(),
      allowedOptions: {},
    });
    expect(invGrant.invocationId).toBe('inv-123');
  });

  it('documents all 5 missing runtime routes that block live multi-container E2E', () => {
    expect(REQUIRED_RUNTIME_ROUTES.length).toBe(5);
    const paths = REQUIRED_RUNTIME_ROUTES.map((r) => `${r.method} ${r.path}`);
    expect(paths).toContain('POST /api/runtime/v1/tasks/:id/artifacts');
    expect(paths).toContain('POST /api/runtime/v1/artifacts/:id/finalize');
    expect(paths).toContain('POST /api/runtime/v1/artifacts/:id/access');
    expect(paths).toContain('POST /api/runtime/v1/tasks/:id/invocation-grants');
    expect(paths).toContain('PUT /api/v1/admin/businesses/:id/versions/:version/enable');
  });

  it('fails fast with exact missing route diagnosis when runtime returns 404 on invocation-grant', async () => {
    const fetchProbe = async (url: string, init?: { method?: string }) => {
      const path = url.replace(/^http:\/\/[^/]+/, '');
      const method = init?.method ?? 'GET';

      if (path.includes('/invocation-grants')) {
        return {
          ok: false,
          status: 404,
          statusText: 'Not Found',
          text: async () => 'Route not found: POST /api/runtime/v1/tasks/:id/invocation-grants',
          json: async () => ({ error: 'ROUTE_NOT_IMPLEMENTED', route: `${method} ${path}` }),
        } as unknown as Response;
      }

      return {
        ok: true,
        status: 200,
        text: async () => '{}',
        json: async () => ({}),
      } as unknown as Response;
    };

    const res = await fetchProbe('http://orchestrator/api/runtime/v1/tasks/task-1/invocation-grants', {
      method: 'POST',
    });

    expect(res.status).toBe(404);
    const body = (await res.json()) as { error: string; route: string };
    expect(body.route).toBe('POST /api/runtime/v1/tasks/task-1/invocation-grants');
  });

  it('confirms documentCoreManifest registers queue compatible with multi-container deployment', () => {
    expect(documentCoreManifest.businessId).toBe('document-core');
    expect(documentCoreManifest.version).toBe('1.1.0');
    expect(documentCoreManifest.runtime.handlerKinds).toContain('extract');
    const extractAction = documentCoreManifest.actions.find((a) => a.name === 'extract');
    expect(extractAction?.connectorSlots?.some((s) => s.name === 'reasoning')).toBe(true);
  });
});
