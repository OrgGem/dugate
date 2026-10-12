import { ConnectorProviderTestEvidenceSchema, ProviderTestResultSchema } from '@du/contracts';
import {
  projectProviderTestArtifactRead,
  redactProviderTestResult,
  recoverProviderTestResult,
} from '../src/modules/connectors/provider-test';

const TENANT = '11111111-1111-4111-8111-111111111111';
const OPERATION = '22222222-2222-4222-8222-222222222222';
const TASK = '33333333-3333-4333-8333-333333333333';
const INVOCATION = '44444444-4444-4444-8444-444444444444';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function evidence(content: string | null, contentSanitized: boolean) {
  return {
    tenantId: TENANT,
    operationId: OPERATION,
    taskId: TASK,
    invocationId: INVOCATION,
    connectorId: 'tenant-provider',
    revision: 2,
    state: 'SUCCEEDED' as const,
    stateVersion: 4,
    updatedAt: '2026-10-11T21:15:00.000Z',
    errorCode: null,
    result: {
      content,
      ...(contentSanitized ? { contentSanitized: true as const } : {}),
      contentTruncated: false,
      statusCode: 200,
      latencyMs: 37,
      providerRequestId: null,
      resultDigest: DIGEST,
    },
    usageEvent: {
      eventId: `${INVOCATION}:1`,
      payloadDigest: DIGEST,
      inputTokens: 4,
      outputTokens: 3,
      costMicrousd: null,
      measurement: null,
      costStatus: null,
      occurredAt: '2026-10-11T21:14:59.000Z',
      deliveredAt: null,
    },
    evidenceDigest: DIGEST,
    recoveryReady: true,
  };
}

describe('provider-test sanitized response projection', () => {
  it('projects authenticated internal artifact facts onto strict invocation and grant DTOs', () => {
    const artifactId = '55555555-5555-4555-8555-555555555555';
    const generationId = '66666666-6666-4666-8666-666666666666';
    const logicalSha256 = 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad';
    const common = {
      artifactId,
      fileName: 'invoice.pdf',
      mimeType: 'application/pdf',
      sizeBytes: 3,
      sha256: logicalSha256,
      storageVersionId: 'exact-object-version',
      storageGenerationId: generationId,
      integrity: {
        databaseMetadata: { kind: 'gateway-ciphertext' as const, sha256: 'c'.repeat(64), sizeBytes: 16 },
        content: { sha256: logicalSha256, sizeBytes: 3 },
        storedObject: { sha256: 'c'.repeat(64), sizeBytes: 16, versionId: 'exact-object-version', storageGenerationId: generationId },
        sidecar: { sha256: 'd'.repeat(64), sizeBytes: 64, versionId: 'exact-sidecar-version' },
        verified: true as const,
      },
    };
    const projected = projectProviderTestArtifactRead({
      contents: [{ ...common, contentBase64: 'YWJj' }],
      pins: [common],
    });

    expect(projected.artifacts).toEqual([{
      artifactId, fileName: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 3,
      sha256: logicalSha256, storageVersionId: 'exact-object-version', contentBase64: 'YWJj',
    }]);
    expect(projected.artifactPins).toEqual([{
      artifactId, fileName: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: 3,
      sha256: logicalSha256, storageVersionId: 'exact-object-version', storageGenerationId: generationId,
    }]);
    expect(JSON.stringify(projected)).not.toContain('integrity');
    expect(JSON.stringify(projected)).not.toContain('exact-sidecar-version');
  });

  it('retains content only when the Connector explicitly marks the sanitized result', () => {
    const safe = redactProviderTestResult({
      invocationId: INVOCATION,
      state: 'SUCCEEDED',
      statusCode: 200,
      content: 'credential: [REDACTED]',
      contentTruncated: false,
      contentSanitized: true,
      latencyMs: 37,
      inputTokens: 4,
      outputTokens: 3,
      usageEventId: `${INVOCATION}:1`,
      errorCode: null,
    });
    expect(safe.content).toBe('credential: [REDACTED]');
    expect(safe.contentSanitized).toBe(true);
  });

  it('drops unmarked content before persistence or returning a result', () => {
    const safe = redactProviderTestResult({
      invocationId: INVOCATION,
      state: 'SUCCEEDED',
      statusCode: 200,
      content: 'could contain a credential',
      contentTruncated: true,
      latencyMs: 37,
      inputTokens: null,
      outputTokens: null,
      usageEventId: null,
      errorCode: null,
    });
    expect(safe.content).toBeNull();
    expect(safe.contentTruncated).toBe(false);
    expect(safe).not.toHaveProperty('contentSanitized');
    expect(ProviderTestResultSchema.safeParse({ ...safe, content: 'unmarked' }).success).toBe(false);
  });

  it('replays only Connector-marked content from source-bound recovery evidence', () => {
    expect(recoverProviderTestResult(ConnectorProviderTestEvidenceSchema.parse(evidence('safe response', true)))?.content).toBe('safe response');
    expect(recoverProviderTestResult(ConnectorProviderTestEvidenceSchema.parse(evidence(null, false)))?.content).toBeNull();
  });
});
