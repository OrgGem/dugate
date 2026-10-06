import { RuntimeClient } from '../src/runtime-client';
import { mkSentinel } from '../../../tests/harness/network-boundaries/sentinels';

const TENANT_ID = '73000000-0000-4000-8000-000000000001';
const PROFILE_ID = '73000000-0000-4000-8000-000000000003';
const OPERATION_ID = '73000000-0000-4000-8000-000000000004';
const TASK_ID = '73000000-0000-4000-8000-000000000005';
const PROFILE_REVISION = 7;

function claimDto(profilePolicy: Record<string, unknown> = {}) {
  return {
    taskId: TASK_ID,
    operationId: OPERATION_ID,
    leaseEpoch: 1,
    leaseExpiresAt: '2026-10-04T12:00:00.000Z',
    attempt: 1,
    deadlineAt: null,
    executionSnapshot: {
      operationId: OPERATION_ID,
      tenantId: TENANT_ID,
      businessId: 'document-core',
      businessVersion: '1.0.0',
      action: 'extract',
      schemaDigest: 'sha256:p730-schema',
      manifestDigest: 'sha256:p730-manifest',
      resolvedInputRef: { text: 'offline' },
      pinned: {
        profileRevision: PROFILE_REVISION,
        promptRevisions: {},
        connectorBindings: { primary: 'connector-a@3' },
        profilePolicy: {
          enabled: true,
          parameters: {},
          jobPriority: 'HIGH',
          allowedFileExtensions: '.pdf,.docx',
          connectionsOverride: [],
          fileUrlAuthConfigured: true,
          credentialRef: { tenantId: TENANT_ID, profileId: PROFILE_ID, profileRevision: PROFILE_REVISION },
          ...profilePolicy,
        },
      },
      taskKey: 'root',
      kind: 'root',
      payloadRef: { input: { text: 'offline' } },
      deadlineAt: null,
      cancelRequested: false,
    },
    checkpointRefs: [],
  };
}

function clientReturning(body: unknown, onRequest?: (body: string | undefined) => void): RuntimeClient {
  return new RuntimeClient({
    baseUrl: 'http://runtime.invalid',
    token: 'offline-token',
    fetchImpl: async (_input, init) => {
      onRequest?.(init?.body?.toString());
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
}

describe('P730 W2-B Worker SDK pinned policy claim contract', () => {
  it('parses and preserves the non-secret policy snapshot and immutable credential ref', async () => {
    let requestBody: string | undefined;
    const client = clientReturning(claimDto(), (body) => { requestBody = body; });
    const claim = await client.claimTask(TASK_ID, {
      deliveryId: 'delivery-p730',
      workerInstanceId: 'worker-p730',
      businessId: 'document-core',
    });

    expect(claim.executionSnapshot.pinned.profilePolicy).toEqual({
      enabled: true,
      parameters: {},
      jobPriority: 'HIGH',
      allowedFileExtensions: '.pdf,.docx',
      connectionsOverride: [],
      fileUrlAuthConfigured: true,
      credentialRef: { tenantId: TENANT_ID, profileId: PROFILE_ID, profileRevision: PROFILE_REVISION },
    });
    expect(JSON.parse(requestBody ?? '{}')).toEqual({
      deliveryId: 'delivery-p730',
      workerInstanceId: 'worker-p730',
      businessId: 'document-core',
    });
  });

  it('rejects legacy plaintext auth config and unknown nested policy keys', async () => {
    const sentinel = mkSentinel('p730-sdk', 'legacy-token');
    const legacy = claimDto({ fileUrlAuthConfig: { type: 'bearer', token: sentinel } });
    await expect(clientReturning(legacy).claimTask(TASK_ID, {
      deliveryId: 'delivery-p730',
      workerInstanceId: 'worker-p730',
      businessId: 'document-core',
    })).rejects.toMatchObject({ name: 'ZodError' });

    const unknownNested = claimDto({ unrecognizedCredential: sentinel });
    await expect(clientReturning(unknownNested).claimTask(TASK_ID, {
      deliveryId: 'delivery-p730',
      workerInstanceId: 'worker-p730',
      businessId: 'document-core',
    })).rejects.toMatchObject({ name: 'ZodError' });
  });

  it('rejects a malformed credential reference instead of passing an unreadable pointer through', async () => {
    const malformed = claimDto({
      credentialRef: { tenantId: TENANT_ID, profileId: PROFILE_ID, profileRevision: 0 },
    });
    await expect(clientReturning(malformed).claimTask(TASK_ID, {
      deliveryId: 'delivery-p730',
      workerInstanceId: 'worker-p730',
      businessId: 'document-core',
    })).rejects.toMatchObject({ name: 'ZodError' });
  });

  test.todo('GAP SDK-CONSUME: DefaultTaskContext and document-core do not yet consume pinned profile policy');
});
