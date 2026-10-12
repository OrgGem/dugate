import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { createCostAdjustmentEvidenceResolver } from '../src/modules/cost-control/evidence-resolver';
import type { Db } from '../src/db/db';
import type { ArtifactService } from '../src/modules/artifacts/artifacts';

const tenantId = '11111111-1111-4111-8111-111111111111';
const artifactId = '22222222-2222-4222-8222-222222222222';
const generationId = '33333333-3333-4333-8333-333333333333';
const storageVersionId = 'object-version-4';
const sidecarVersionId = 'sidecar-version-4';
const logicalBytes = Buffer.from('authenticated logical invoice bytes');
const objectBytes = Buffer.from('authenticated encrypted gateway object bytes');
const sidecarBytes = Buffer.from('{"kind":"public-upload-v1"}');
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

function makeFixture(rawObject = objectBytes) {
  const integrity = {
    databaseMetadata: { kind: 'gateway-ciphertext' as const, sha256: sha256(objectBytes), sizeBytes: objectBytes.length },
    content: { sha256: sha256(logicalBytes), sizeBytes: logicalBytes.length },
    storedObject: {
      sha256: sha256(objectBytes), sizeBytes: objectBytes.length,
      versionId: storageVersionId, storageGenerationId: generationId,
    },
    sidecar: { sha256: sha256(sidecarBytes), sizeBytes: sidecarBytes.length, versionId: sidecarVersionId },
    verified: true as const,
  };
  const db = {
    query: jest.fn(async () => ({ rows: [{
      id: artifactId, tenantId, fileName: 'invoice.pdf', mimeType: 'application/pdf',
      sizeBytes: String(objectBytes.length), sha256: sha256(objectBytes), storageBackend: 's3',
      storageGenerationId: generationId, storageKey: 'opaque-internal-storage-key',
      storageVersionId, sidecarVersionId, createdAt: new Date('2026-10-01T00:00:00.000Z'),
    }], rowCount: 1 })),
  } as unknown as Db;
  const artifacts = {
    readInvocationArtifacts: jest.fn(async () => ({
      pins: [{ artifactId, fileName: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: logicalBytes.length,
        sha256: sha256(logicalBytes), storageVersionId, storageGenerationId: generationId, integrity }],
      contents: [{ artifactId, fileName: 'invoice.pdf', mimeType: 'application/pdf', sizeBytes: logicalBytes.length,
        sha256: sha256(logicalBytes), storageVersionId, storageGenerationId: generationId, integrity, contentBase64: logicalBytes.toString('base64') }],
    })),
    openPinnedObjectsForMaintenanceBackup: jest.fn(async () => ({
      object: Readable.from([rawObject]), manifest: Readable.from([sidecarBytes]),
    })),
  } as unknown as Pick<ArtifactService, 'openPinnedObjectsForMaintenanceBackup' | 'readInvocationArtifacts'>;
  return { resolver: createCostAdjustmentEvidenceResolver({ db, artifacts }), artifacts };
}

describe('ORV14 cost evidence integrity binding', () => {
  it('keeps gateway ciphertext row facts distinct from authenticated logical content', async () => {
    const { resolver } = makeFixture();

    const pin = await resolver.resolveCostAdjustmentEvidencePin({ tenantId, artifactId });

    expect(pin).toEqual(expect.objectContaining({
      sizeBytes: logicalBytes.length,
      sha256: `sha256:${sha256(logicalBytes)}`,
      databaseMetadata: { kind: 'gateway-ciphertext', sizeBytes: objectBytes.length, sha256: `sha256:${sha256(objectBytes)}` },
      objectSizeBytes: objectBytes.length,
      objectSha256: `sha256:${sha256(objectBytes)}`,
      sidecarVersionId,
      sidecarSizeBytes: sidecarBytes.length,
      sidecarSha256: `sha256:${sha256(sidecarBytes)}`,
    }));
  });

  it('rejects a raw object that differs from the authenticated exact-version fact', async () => {
    const { resolver } = makeFixture(Buffer.from('different object bytes'));

    await expect(resolver.resolveCostAdjustmentEvidencePin({ tenantId, artifactId })).resolves.toBeNull();
  });
});
