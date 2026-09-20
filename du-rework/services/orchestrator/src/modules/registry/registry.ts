import {
  BusinessManifest,
  RegistrationRecordSchema,
  businessQueueName,
  hashManifest,
  validateManifest,
} from '@du/contracts';
import { Db } from '../../db/db';
import { HttpError, conflict, unprocessable } from '../../http/errors';

/**
 * Business registry (docs 05, REG-01..04). Manifests are immutable once
 * registered; re-registering the same (businessId, version) with the same
 * digest is a safe replay (200), a different digest is a 409 conflict.
 */

export interface RegistrationResult {
  businessId: string;
  version: string;
  digest: string;
  queue: string;
  created: boolean;
  replayed: boolean;
}

export interface RegistryService {
  registerVersion(manifest: unknown): Promise<RegistrationResult>;
  getEnabledVersion(businessId: string, version: string): Promise<{
    manifest: BusinessManifest;
    digest: string;
    queue: string;
  }>;
}

export function createRegistryService(db: Db): RegistryService {
  return {
    async registerVersion(manifest: unknown): Promise<RegistrationResult> {
      const validation = validateManifest(manifest);
      if (!validation.ok) {
        throw unprocessable(
          'INVALID_SCHEMA',
          `manifest validation failed: ${validation.problems
            .map((p) => `${p.pointer}: ${p.message}`)
            .join('; ')}`,
          { errors: validation.problems.slice(0, 50).map((p) => ({ pointer: p.pointer, message: p.message })) }
        );
      }
      const { businessId, version } = validation.manifest;
      const digest = validation.digest;
      const queue = businessQueueName(businessId, version);

      return db.tx(async (client) => {
        const existing = await client.query(
          'SELECT digest, status, manifest, created_at FROM business_versions WHERE business_id = $1 AND version = $2 FOR UPDATE',
          [businessId, version]
        );
        if (existing.rowCount && existing.rowCount > 0) {
          const row = existing.rows[0] as {
            digest: string;
            status: string;
            manifest: BusinessManifest;
            created_at: Date;
          };
          if (row.digest !== digest) {
            // REG-02: same coordinates, different content → digest mismatch.
            throw conflict(
              'MANIFEST_DIGEST_MISMATCH',
              `business ${businessId}@${version} already registered with digest ${row.digest}`
            );
          }
          // REG-01 replay: identical digest is idempotent. Validate the stored
          // record still satisfies the contract shape before returning it.
          RegistrationRecordSchema.parse({
            businessId,
            version,
            contractVersion: '1',
            digest,
            manifest: row.manifest,
            status: row.status,
            queue,
            registeredAt: new Date(row.created_at).toISOString(),
          });
          return { businessId, version, digest, queue, created: false, replayed: true };
        }

        await client.query(
          `INSERT INTO business_versions (business_id, version, contract_version, manifest, digest, status, queue)
           VALUES ($1, $2, '1', $3, $4, 'REGISTERED_DISABLED', $5)`,
          [businessId, version, JSON.stringify(validation.manifest), digest, queue]
        );
        return { businessId, version, digest, queue, created: true, replayed: false };
      });
    },

    async getEnabledVersion(businessId, version) {
      const res = await db.query(
        'SELECT manifest, digest, status, queue FROM business_versions WHERE business_id = $1 AND version = $2',
        [businessId, version]
      );
      if (!res.rowCount) {
        throw new HttpError(404, 'NOT_FOUND', `business ${businessId}@${version} not registered`);
      }
      const row = res.rows[0] as { manifest: BusinessManifest; digest: string; status: string; queue: string };
      if (row.status !== 'ENABLED') {
        throw conflict('STATE_CONFLICT', `business ${businessId}@${version} is ${row.status}, not ENABLED`);
      }
      return { manifest: row.manifest, digest: row.digest, queue: row.queue };
    },
  };
}

/** Test/admin helper: flip a registered version to ENABLED (P2-02 does the full RBAC path). */
export async function enableVersionForTest(db: Db, businessId: string, version: string): Promise<void> {
  await db.query('UPDATE business_versions SET status = $3 WHERE business_id = $1 AND version = $2', [
    businessId,
    version,
    'ENABLED',
  ]);
}

export { hashManifest };
