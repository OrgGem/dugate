import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { Db } from '../../db/db';
import type { ArtifactService } from '../artifacts/artifacts';
import type { CostAdjustmentEvidencePin } from './adjustments';

export type VerifiedCostAdjustmentEvidencePin = CostAdjustmentEvidencePin & {
  objectSizeBytes: number;
  objectSha256: string;
};

interface EvidenceArtifactRow {
  id: string;
  tenantId: string;
  fileName: string | null;
  mimeType: string;
  sizeBytes: string | number | null;
  sha256: string | null;
  storageBackend: string;
  storageGenerationId: string | null;
  storageKey: string;
  storageVersionId: string | null;
  sidecarVersionId: string | null;
  createdAt: Date | string;
}

export interface CostAdjustmentEvidenceResolverOptions {
  db: Db;
  artifacts: Pick<ArtifactService, 'openPinnedObjectsForMaintenanceBackup' | 'readInvocationArtifacts'>;
  /** Bounds verification of the actual immutable storage streams. */
  maxArtifactBytes?: number;
  maxSidecarBytes?: number;
}

/**
 * Resolve an evidence reference from server-owned READY metadata and verify
 * both exact immutable storage versions before exposing safe provenance.
 * Storage keys and bytes remain inside the process. Artifacts without a
 * generation, object version, or sidecar version are deliberately ineligible
 * for financial evidence.
 */
export function createCostAdjustmentEvidenceResolver(options: CostAdjustmentEvidenceResolverOptions): {
  resolveCostAdjustmentEvidencePin(input: { tenantId: string; artifactId: string }): Promise<VerifiedCostAdjustmentEvidencePin | null>;
} {
  const maxArtifactBytes = options.maxArtifactBytes ?? 12 * 1024 * 1024;
  const maxSidecarBytes = options.maxSidecarBytes ?? 1024 * 1024;
  // ArtifactService's authenticated plaintext reader is bounded at 10 MiB.
  // Leave room for the encrypted envelope when hashing the physical object.
  if (!Number.isSafeInteger(maxArtifactBytes) || maxArtifactBytes < 1 || maxArtifactBytes > 12 * 1024 * 1024
      || !Number.isSafeInteger(maxSidecarBytes) || maxSidecarBytes < 1) {
    throw new Error('cost adjustment evidence stream bounds are invalid');
  }

  return {
    async resolveCostAdjustmentEvidencePin({ tenantId, artifactId }) {
      const found = await options.db.query<EvidenceArtifactRow>(
        `SELECT id,tenant_id AS "tenantId",file_name AS "fileName",mime_type AS "mimeType",
                size_bytes AS "sizeBytes",sha256,storage_backend AS "storageBackend",
                storage_generation_id AS "storageGenerationId",storage_key AS "storageKey",
                storage_version_id AS "storageVersionId",manifest_version_id AS "sidecarVersionId",
                created_at AS "createdAt"
           FROM artifacts
          WHERE id=$1 AND tenant_id=$2 AND state='READY'
            AND size_bytes BETWEEN 1 AND $3
            AND storage_generation_id IS NOT NULL
            AND storage_version_id IS NOT NULL AND length(storage_version_id) BETWEEN 1 AND 512
            AND manifest_version_id IS NOT NULL AND length(manifest_version_id) BETWEEN 1 AND 512`,
        [artifactId, tenantId, maxArtifactBytes],
      );
      const row = found.rows[0];
      if (!row) return null;
      const databaseSize = Number(row.sizeBytes);
      const databaseDigest = row.sha256?.toLowerCase() ?? '';
      const createdAt = row.createdAt instanceof Date ? row.createdAt.toISOString() : new Date(row.createdAt).toISOString();
      if (!Number.isSafeInteger(databaseSize) || databaseSize < 1 || databaseSize > maxArtifactBytes
          || !Number.isFinite(Date.parse(createdAt))
          || !row.storageGenerationId || !row.storageVersionId || !row.sidecarVersionId
          || !row.storageKey || !row.storageBackend || !row.mimeType
          || !/^[a-f0-9]{64}$/.test(databaseDigest)) return null;

      // Independently verify the logical file representation through the same
      // exact-generation authenticated reader used for invocation artifacts.
      const logical = await options.artifacts.readInvocationArtifacts({ tenantId, artifactIds: [artifactId] });
      const logicalPin = logical.pins.find((pin) => pin.artifactId === artifactId);
      const logicalContent = logical.contents.find((content) => content.artifactId === artifactId);
      const integrity = logicalPin?.integrity;
      const metadata = integrity?.databaseMetadata;
      const contentFacts = integrity?.content;
      const objectFacts = integrity?.storedObject;
      const sidecarFacts = integrity?.sidecar;
      const metadataKind = metadata?.kind;
      if (!logicalPin || !logicalContent || integrity?.verified !== true
          || logicalPin.storageGenerationId !== row.storageGenerationId
          || logicalPin.storageVersionId !== row.storageVersionId
          || objectFacts?.storageGenerationId !== row.storageGenerationId
          || objectFacts.versionId !== row.storageVersionId
          || !sidecarFacts || sidecarFacts.versionId !== row.sidecarVersionId
          || !Number.isSafeInteger(databaseSize) || metadata?.sizeBytes !== databaseSize
          || metadata.sha256.toLowerCase() !== databaseDigest
          || !['gateway-ciphertext', 'worker-plaintext', 'legacy-plaintext'].includes(metadataKind ?? '')
          || !contentFacts || !Number.isSafeInteger(contentFacts.sizeBytes) || contentFacts.sizeBytes < 1
          || contentFacts.sizeBytes > 10 * 1024 * 1024 || !/^[a-f0-9]{64}$/.test(contentFacts.sha256)
          || logicalPin.sizeBytes !== contentFacts.sizeBytes
          || logicalPin.sha256.toLowerCase() !== contentFacts.sha256
          || logicalContent.sizeBytes !== contentFacts.sizeBytes
          || Buffer.from(logicalContent.contentBase64, 'base64').toString('base64') !== logicalContent.contentBase64
          || createHash('sha256').update(Buffer.from(logicalContent.contentBase64, 'base64')).digest('hex') !== contentFacts.sha256
          || (metadataKind === 'gateway-ciphertext'
            ? (metadata.sizeBytes !== objectFacts.sizeBytes || metadata.sha256.toLowerCase() !== objectFacts.sha256)
            : (metadata.sizeBytes !== contentFacts.sizeBytes || metadata.sha256.toLowerCase() !== contentFacts.sha256))) {
        return null;
      }

      const pinned = await options.artifacts.openPinnedObjectsForMaintenanceBackup({
        storageBackend: row.storageBackend,
        storageGenerationId: row.storageGenerationId,
        storageKey: row.storageKey,
        storageVersionId: row.storageVersionId,
        manifestVersionId: row.sidecarVersionId,
      });
      if (!pinned.manifest) {
        pinned.object.destroy();
        return null;
      }
      const [object, sidecar] = await Promise.all([
        hashStream(pinned.object, maxArtifactBytes),
        hashStream(pinned.manifest, maxSidecarBytes),
      ]);
      if (object.sizeBytes < 1 || sidecar.sizeBytes < 1
          || object.sizeBytes !== objectFacts.sizeBytes || object.sha256 !== objectFacts.sha256
          || sidecar.sizeBytes !== sidecarFacts.sizeBytes || sidecar.sha256 !== sidecarFacts.sha256) return null;
      return {
        artifactId: row.id,
        tenantId: row.tenantId,
        fileName: row.fileName,
        mimeType: row.mimeType,
        // Logical plaintext facts are distinct from the encrypted object pin.
        sizeBytes: contentFacts.sizeBytes,
        sha256: `sha256:${contentFacts.sha256}`,
        databaseMetadata: {
          kind: metadataKind as NonNullable<typeof metadata>['kind'],
          sizeBytes: databaseSize,
          sha256: `sha256:${databaseDigest}`,
        },
        objectSizeBytes: object.sizeBytes,
        objectSha256: `sha256:${object.sha256}`,
        storageGenerationId: row.storageGenerationId,
        storageVersionId: row.storageVersionId,
        sidecarVersionId: row.sidecarVersionId,
        sidecarSha256: `sha256:${sidecar.sha256}`,
        sidecarSizeBytes: sidecar.sizeBytes,
        createdAt,
      };
    },
  };
}

async function hashStream(stream: Readable, maxBytes: number): Promise<{ sizeBytes: number; sha256: string }> {
  const digest = createHash('sha256');
  let sizeBytes = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array);
    sizeBytes += bytes.byteLength;
    if (sizeBytes > maxBytes || !Number.isSafeInteger(sizeBytes)) {
      stream.destroy();
      throw new Error('cost adjustment evidence exceeds the bounded verification size');
    }
    digest.update(bytes);
  }
  return { sizeBytes, sha256: digest.digest('hex') };
}
