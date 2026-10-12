import { PoolClient } from 'pg';
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
  setBusinessEnabled(
    businessId: string,
    enabled: boolean,
    expectedLifecycleRevision: number,
    client?: PoolClient,
  ): Promise<{ businessId: string; enabled: boolean; lifecycleRevision: number; replayed: boolean }>;
  getEnabledVersion(businessId: string, version: string): Promise<{
    manifest: BusinessManifest;
    digest: string;
    queue: string;
  }>;
  /** Activate a version as the target for new submissions (W28-C).
   *  R3-01: pass the route's open tx client to join its transaction
   *  instead of opening a private one. */
  activateVersion(businessId: string, version: string, client?: PoolClient): Promise<{ businessId: string; version: string; active: boolean; replayed: boolean }>;
  /** Deactivate/drain a version so new submissions no longer target it (W28-C). */
  deactivateVersion(businessId: string, version: string, client?: PoolClient): Promise<{ businessId: string; version: string; active: boolean; replayed: boolean }>;
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
        // The logical root is also the registration mutex. It serializes
        // concurrent first registrations of different versions without
        // assigning caller-controlled tenant ownership. Existing roots are
        // left untouched; new businesses start disabled until admin enables.
        await client.query(
          `INSERT INTO business_catalog (business_id, enabled)
           VALUES ($1, false)
           ON CONFLICT (business_id) DO NOTHING`,
          [businessId],
        );
        await client.query('SELECT business_id FROM business_catalog WHERE business_id=$1 FOR UPDATE', [businessId]);
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

    async setBusinessEnabled(businessId, enabled, expectedLifecycleRevision, activeClient) {
      const run = async (client: PoolClient) => {
        const selected = await client.query<{ enabled: boolean; lifecycle_revision: number | string }>(
          `SELECT enabled,lifecycle_revision
             FROM business_catalog
            WHERE business_id=$1
            FOR UPDATE`,
          [businessId],
        );
        const row = selected.rows[0];
        if (!row) throw new HttpError(404, 'NOT_FOUND', `business ${businessId} not registered`);
        const revision = Number(row.lifecycle_revision);
        if (!Number.isSafeInteger(revision) || revision < 1) {
          throw new Error('business lifecycle revision is invalid');
        }
        if (revision !== expectedLifecycleRevision) {
          throw conflict('STATE_CONFLICT', 'business lifecycle changed; reload before updating it');
        }
        if (row.enabled === enabled) {
          return { businessId, enabled, lifecycleRevision: revision, replayed: true };
        }
        const updated = await client.query<{ enabled: boolean; lifecycle_revision: number | string }>(
          `UPDATE business_catalog
              SET enabled=$2,lifecycle_revision=lifecycle_revision+1,updated_at=now()
            WHERE business_id=$1 AND lifecycle_revision=$3
            RETURNING enabled,lifecycle_revision`,
          [businessId, enabled, expectedLifecycleRevision],
        );
        const updatedRow = updated.rows[0];
        if (!updatedRow) throw conflict('STATE_CONFLICT', 'business lifecycle changed; reload before updating it');
        const lifecycleRevision = Number(updatedRow.lifecycle_revision);
        if (!Number.isSafeInteger(lifecycleRevision) || lifecycleRevision < 1) {
          throw new Error('business lifecycle revision is invalid');
        }
        return { businessId, enabled: updatedRow.enabled, lifecycleRevision, replayed: false };
      };
      return activeClient ? run(activeClient) : db.tx(run);
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

    async activateVersion(businessId, version, activeClient) {
      const run = async (client: PoolClient) => {
        // Lock ALL versions of this business in a deterministic order FIRST.
        // Two concurrent activates for different versions would otherwise each
        // hold their own target row and then block on the other's row in the
        // mass clear below — a classic lock-ordering deadlock (W28-C review
        // item 3). Ordered locking serializes them: last committer wins, the
        // partial unique index is never violated, final state is exactly one
        // active version.
        await client.query(
          'SELECT version FROM business_versions WHERE business_id = $1 ORDER BY version FOR UPDATE',
          [businessId]
        );
        const res = await client.query(
          'SELECT status, is_active FROM business_versions WHERE business_id = $1 AND version = $2',
          [businessId, version]
        );
        if (!res.rowCount) {
          throw new HttpError(404, 'NOT_FOUND', `business ${businessId}@${version} not registered`);
        }
        const row = res.rows[0] as { status: string; is_active: boolean };
        if (row.status !== 'ENABLED') {
          throw conflict('STATE_CONFLICT', `business ${businessId}@${version} is ${row.status}, not ENABLED`);
        }
        if (row.is_active) {
          // Idempotent retry — already the active target.
          return { businessId, version, active: true, replayed: true };
        }
        // Activating a new version implicitly deactivates the previous one.
        await client.query('UPDATE business_versions SET is_active = false, updated_at = now() WHERE business_id = $1', [businessId]);
        await client.query(
          'UPDATE business_versions SET is_active = true, updated_at = now() WHERE business_id = $1 AND version = $2',
          [businessId, version]
        );
        return { businessId, version, active: true, replayed: false };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },

    async deactivateVersion(businessId, version, activeClient) {
      const run = async (client: PoolClient) => {
        const res = await client.query(
          'SELECT status, is_active FROM business_versions WHERE business_id = $1 AND version = $2 FOR UPDATE',
          [businessId, version]
        );
        if (!res.rowCount) {
          throw new HttpError(404, 'NOT_FOUND', `business ${businessId}@${version} not registered`);
        }
        const row = res.rows[0] as { status: string; is_active: boolean };
        if (row.status !== 'ENABLED') {
          throw conflict('STATE_CONFLICT', `business ${businessId}@${version} is ${row.status}, not ENABLED`);
        }
        if (!row.is_active) {
          // Idempotent retry — already not the active target.
          return { businessId, version, active: false, replayed: true };
        }
        await client.query(
          'UPDATE business_versions SET is_active = false, updated_at = now() WHERE business_id = $1 AND version = $2',
          [businessId, version]
        );
        return { businessId, version, active: false, replayed: false };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },
  };
}

/** Test/admin helper: flip a registered version to ENABLED and active (W28-C adds is_active). */
export async function enableVersionForTest(db: Db, businessId: string, version: string): Promise<void> {
  // Transactionally: disable all other versions, then enable+activate this one.
  await db.tx(async (client) => {
    await client.query('UPDATE business_versions SET is_active = false, updated_at = now() WHERE business_id = $1', [businessId]);
    await client.query('UPDATE business_versions SET status = $3, is_active = true, updated_at = now() WHERE business_id = $1 AND version = $2', [
      businessId,
      version,
      'ENABLED',
    ]);
  });
}

export { hashManifest };
