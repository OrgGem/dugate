import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { ChecksumAlgorithm, PutObjectCommand } from '@aws-sdk/client-s3';
import { SourceIngestionError, type PinnedSourceStorage, type PinnedSourceWrite, type SourceIngestionReceipt } from '@du/worker-sdk';
import type { Db } from '../../db/db';

/**
 * W-DATA03-CONSUMER-JOIN-1: the PinnedSourceStorage port over private S3.
 *
 * Two legs, deliberately split by durability:
 * - putVerified streams the acquired file into a NEW immutable object version
 *   (same rule as the artifact facade: the bucket must have versioning;
 *   a missing/'null' VersionId fails closed) while re-hashing and
 *   re-counting the exact bytes handed to the SDK. When S3 reports
 *   ChecksumSHA256 it is cross-checked against that measurement, so the
 *   versionId on the receipt is a digest storage itself agreed to.
 * - resolvePinned answers from the artifacts table: the READY row the
 *   consumer materializes IS the durable pin registry (storage_key +
 *   storage_version_id + sha256 + size_bytes), so a retry after a crash
 *   answers the pin - with its artifactId - without touching the network,
 *   exactly the idempotence the producer leg was built around.
 *
 * The send seam mirrors the artifact facade's injectable client so the whole
 * leg is offline-testable; nothing here ever buffers a whole object in the
 * heap beyond SDK chunking.
 */

export interface S3PinnedSendResult {
  VersionId?: string;
  ChecksumSHA256?: string;
}

export type S3PinnedCommandSender = (command: unknown) => Promise<S3PinnedSendResult>;

export interface S3PinnedSourceStorageOptions {
  bucket: string;
  /** Real deployments pass (command) => client.send(command as never). */
  send: S3PinnedCommandSender;
  db: Db;
}

const PIN_FIND_SQL =
  'SELECT storage_version_id AS "versionId", sha256, size_bytes AS "sizeBytes", id FROM artifacts ' +
  "WHERE storage_key=$1 AND state='READY' AND storage_version_id IS NOT NULL AND sha256 IS NOT NULL " +
  'ORDER BY created_at DESC LIMIT 1';

export function createS3PinnedSourceStorage(options: S3PinnedSourceStorageOptions): PinnedSourceStorage {
  return {
    async resolvePinned(storageKey: string): Promise<SourceIngestionReceipt | null> {
      const res = await options.db.query(PIN_FIND_SQL, [storageKey]);
      const row = res.rows[0] as
        | { versionId: string; sha256: string; sizeBytes: string | number; id: string }
        | undefined;
      if (!row || typeof row.versionId !== 'string' || typeof row.sha256 !== 'string') return null;
      return {
        storageKey,
        versionId: row.versionId,
        sha256: row.sha256.toLowerCase(),
        sizeBytes: Number(row.sizeBytes),
        artifactId: row.id,
      };
    },

    async putVerified(input: {
      storageKey: string;
      contentType?: string;
      body: AsyncIterable<Uint8Array> | import('node:stream').Readable;
      maxBytes: number;
      signal?: AbortSignal;
    }): Promise<PinnedSourceWrite> {
      const hash = createHash('sha256');
      let sizeBytes = 0;
      async function* measured(): AsyncGenerator<Buffer> {
        for await (const raw of input.body as AsyncIterable<Uint8Array>) {
          if (input.signal?.aborted) {
            throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'pinned upload aborted before the version committed');
          }
          const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw as Uint8Array);
          if (chunk.length === 0) continue;
          sizeBytes += chunk.length;
          if (sizeBytes > input.maxBytes) {
            throw new SourceIngestionError(413, 'TOO_LARGE', 'pinned upload exceeded the transfer byte budget');
          }
          hash.update(chunk);
          yield chunk;
        }
      }

      let output: S3PinnedSendResult;
      try {
        output = await options.send(new PutObjectCommand({
          Bucket: options.bucket,
          Key: input.storageKey,
          // SDK v3 types Body as Readable/ReadableStream/... - an async
          // generator must enter the wire through Readable.from, never a
          // cast that hides the chunk accounting above.
          Body: Readable.from(measured()),
          ContentType: input.contentType,
          ChecksumAlgorithm: ChecksumAlgorithm.SHA256,
        }));
      } catch (err) {
        if (err instanceof SourceIngestionError) throw err;
        throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'S3 rejected the pinned object version');
      }

      const sha256 = hash.digest('hex');
      if (!output.VersionId || output.VersionId === 'null') {
        // Same fail-closed rule the artifact facade applies at finalize:
        // without an immutable version id the receipt could be overwritten.
        throw new SourceIngestionError(502, 'STORAGE_FAILURE', 'S3 returned no immutable version id (enable bucket versioning)');
      }
      if (typeof output.ChecksumSHA256 === 'string' && output.ChecksumSHA256.length > 0) {
        const reported = Buffer.from(output.ChecksumSHA256, 'base64').toString('hex');
        if (reported !== sha256) {
          throw new SourceIngestionError(502, 'PIN_MISMATCH', 'S3 checksummed different bytes than this call streamed');
        }
      }
      return { storageKey: input.storageKey, versionId: output.VersionId, sha256, sizeBytes };
    },
  };
}
