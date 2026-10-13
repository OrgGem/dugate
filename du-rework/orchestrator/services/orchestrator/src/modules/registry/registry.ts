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
import { readBusinessAdmission } from './version-admission';

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
  enableVersion(
    businessId: string,
    version: string,
    expectedActivationRevision: number,
    client?: PoolClient,
    actor?: string,
  ): Promise<{ businessId: string; version: string; status: 'ENABLED'; activationRevision: number; replayed: boolean }>;
  setBusinessEnabled(
    businessId: string,
    enabled: boolean,
    expectedLifecycleRevision: number,
    client?: PoolClient,
    actor?: string,
  ): Promise<{ businessId: string; enabled: boolean; lifecycleRevision: number; replayed: boolean }>;
  getEnabledVersion(businessId: string, version: string): Promise<{
    manifest: BusinessManifest;
    digest: string;
    queue: string;
  }>;
  /** Activate a version as the target for new submissions (W28-C).
   *  R3-01: pass the route's open tx client to join its transaction
   *  instead of opening a private one. */
  activateVersion(
    businessId: string,
    version: string,
    expectedActivationRevision: number,
    client?: PoolClient,
    actor?: string,
  ): Promise<{
    businessId: string; version: string; active: boolean; activationRevision: number;
    previousVersion: string | null; replayed: boolean;
  }>;
  /** Deactivate/drain a version so new submissions no longer target it (W28-C). */
  deactivateVersion(
    businessId: string,
    version: string,
    expectedActivationRevision: number,
    client?: PoolClient,
    actor?: string,
  ): Promise<{
    businessId: string; version: string; active: boolean; activationRevision: number;
    previousVersion: string | null; replayed: boolean;
  }>;
  startVersionPreDrain(
    businessId: string,
    version: string,
    expectedActivationRevision: number,
    client?: PoolClient,
    actor?: string,
  ): Promise<{
    businessId: string; version: string; submissionsPaused: true; activationRevision: number;
    remainingOperations: number; replayed: boolean;
  }>;
  cancelVersionPreDrain(
    businessId: string,
    version: string,
    expectedActivationRevision: number,
    client?: PoolClient,
    actor?: string,
  ): Promise<{
    businessId: string; version: string; submissionsPaused: false; activationRevision: number;
    replayed: boolean;
  }>;
}

type ActivationEventAction =
  | 'ACTIVATED'
  | 'DEACTIVATED'
  | 'PRE_DRAIN_STARTED'
  | 'PRE_DRAIN_CANCELLED'
  | 'BUSINESS_ENABLED'
  | 'BUSINESS_DISABLED'
  | 'VERSION_ENABLED';

function staleActivationRevision(expected: number, actual: number): HttpError {
  return conflict('STATE_CONFLICT', 'business version activation changed; reload before updating it', {
    errors: [{ pointer: '/expectedActivationRevision', message: `expected ${expected}; current ${actual}` }],
  });
}

async function activationCommandWasApplied(
  client: PoolClient,
  businessId: string,
  expectedRevision: number,
  currentRevision: number,
  action: ActivationEventAction,
  activeVersion: string | null,
  previousVersion?: string,
  affectedVersion?: string,
): Promise<boolean> {
  const result = await client.query<{ found: boolean }>(
    `SELECT EXISTS (
       SELECT 1 FROM business_version_activation_events
        WHERE business_id=$1 AND expected_activation_revision=$2
          AND activation_revision=$3 AND action=$4
          AND active_version IS NOT DISTINCT FROM $5::text
          AND ($6::text IS NULL OR previous_version=$6)
          AND ($7::text IS NULL OR affected_version=$7)
     ) AS found`,
    [businessId, expectedRevision, currentRevision, action, activeVersion, previousVersion ?? null, affectedVersion ?? null],
  );
  return result.rows[0]?.found === true;
}

async function advanceActivationRevision(
  client: PoolClient,
  businessId: string,
  expectedRevision: number,
  transition: {
    action: ActivationEventAction;
    previousVersion: string | null;
    activeVersion: string | null;
    affectedVersion?: string | null;
    submissionsPaused?: boolean;
    preDrainVersion?: string | null;
    actor?: string;
  },
): Promise<number> {
  const updated = await client.query<{ activation_revision: number | string }>(
    `UPDATE business_catalog
        SET activation_revision=activation_revision+1,
            submissions_paused=$3,pre_drain_version=$4,updated_at=statement_timestamp()
      WHERE business_id=$1 AND activation_revision=$2
      RETURNING activation_revision`,
    [businessId, expectedRevision, transition.submissionsPaused ?? false, transition.preDrainVersion ?? null],
  );
  const revision = Number(updated.rows[0]?.activation_revision);
  if (!Number.isSafeInteger(revision) || revision !== expectedRevision + 1) {
    throw conflict('STATE_CONFLICT', 'business version activation changed; reload before updating it');
  }
  await client.query(
    `INSERT INTO business_version_activation_events
       (business_id,activation_revision,expected_activation_revision,action,previous_version,active_version,affected_version,actor)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [businessId, revision, expectedRevision, transition.action,
      transition.previousVersion, transition.activeVersion, transition.affectedVersion ?? null, transition.actor ?? 'admin'],
  );
  return revision;
}

async function countNonterminalOperations(
  client: PoolClient,
  businessId: string,
  businessVersion: string,
): Promise<number> {
  const result = await client.query<{ count: number | string }>(
    `SELECT count(*)::int AS count FROM operations
      WHERE business_id=$1 AND business_version=$2
        AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`,
    [businessId, businessVersion],
  );
  const count = Number(result.rows[0]?.count ?? 0);
  if (!Number.isSafeInteger(count) || count < 0) throw new Error('pre-drain operation count is invalid');
  return count;
}

async function parkVersionWork(
  client: PoolClient,
  businessId: string,
  version: string,
  reason: 'VERSION_NOT_ACTIVE' | 'NO_ACTIVE_VERSION' | 'BUSINESS_DISABLED',
): Promise<void> {
  await client.query(
    `UPDATE tasks t
        SET admission_parked_reason=$3,admission_parked_at=statement_timestamp(),updated_at=statement_timestamp()
       FROM operations o
      WHERE t.operation_id=o.id AND o.business_id=$1 AND o.business_version=$2
        AND t.state NOT IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
        AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`,
    [businessId, version, reason],
  );
  await client.query(
    `UPDATE outbox ob
        SET parked_reason=$3,parked_at=statement_timestamp(),claim_token=NULL,claim_until=NULL
       FROM tasks t JOIN operations o ON o.id=t.operation_id
      WHERE ob.aggregate_id=t.id AND ob.type IN ('task.dispatch','task.continuation')
        AND o.business_id=$1 AND o.business_version=$2
        AND t.state NOT IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
        AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`,
    [businessId, version, reason],
  );
}

async function unparkVersionWork(client: PoolClient, businessId: string, version: string): Promise<void> {
  await client.query(
    `UPDATE tasks t SET admission_parked_reason=NULL,admission_parked_at=NULL,updated_at=statement_timestamp()
       FROM operations o
      WHERE t.operation_id=o.id AND o.business_id=$1 AND o.business_version=$2
        AND t.state NOT IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
        AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`,
    [businessId, version],
  );
  await client.query(
    `UPDATE outbox ob
        SET parked_reason=NULL,parked_at=NULL,claim_token=NULL,claim_until=NULL
       WHERE ob.type IN ('task.dispatch','task.continuation')
         AND ob.aggregate_id IN (
           SELECT t.id FROM tasks t JOIN operations o ON o.id=t.operation_id
            WHERE o.business_id=$1 AND o.business_version=$2
              AND t.state NOT IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
              AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
         )`,
    [businessId, version],
  );
}

export function createRegistryService(db: Db): RegistryService {
  return {
    async enableVersion(businessId, version, expectedActivationRevision, activeClient, actor = 'admin') {
      const run = async (client: PoolClient) => {
        const admission = await readBusinessAdmission(client, businessId, version, 'UPDATE');
        if (!admission) throw new HttpError(404, 'NOT_FOUND', `business ${businessId} not registered`);
        const targetStatus = admission.targetStatus;
        if (targetStatus === null) throw new HttpError(404, 'NOT_FOUND', `business ${businessId}@${version} not registered`);
        if (targetStatus === 'ENABLED') {
          if (expectedActivationRevision === admission.activationRevision
            || await activationCommandWasApplied(
              client, businessId, expectedActivationRevision, admission.activationRevision,
              'VERSION_ENABLED', admission.activeVersion, undefined, version,
            )) {
            return { businessId, version, status: 'ENABLED' as const,
              activationRevision: admission.activationRevision, replayed: true };
          }
          throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
        }
        if (expectedActivationRevision !== admission.activationRevision) {
          throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
        }
        const updated = await client.query(
          `UPDATE business_versions SET status='ENABLED',updated_at=statement_timestamp()
            WHERE business_id=$1 AND version=$2 AND status=$3`,
          [businessId, version, targetStatus],
        );
        if (!updated.rowCount) throw new HttpError(404, 'NOT_FOUND', `business ${businessId}@${version} not registered`);
        const nextRevision = await advanceActivationRevision(client, businessId, expectedActivationRevision, {
          action: 'VERSION_ENABLED', previousVersion: admission.activeVersion,
          activeVersion: admission.activeVersion, affectedVersion: version,
          submissionsPaused: admission.submissionsPaused, preDrainVersion: admission.preDrainVersion,
          actor,
        });
        if (admission.activeVersion === version && admission.enabled) {
          await unparkVersionWork(client, businessId, version);
        }
        return { businessId, version, status: 'ENABLED' as const,
          activationRevision: nextRevision, replayed: false };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },

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

    async setBusinessEnabled(businessId, enabled, expectedLifecycleRevision, activeClient, actor = 'admin') {
      const run = async (client: PoolClient) => {
        const selected = await client.query<{
          enabled: boolean; lifecycle_revision: number | string; activation_revision: number | string;
          submissions_paused: boolean; pre_drain_version: string | null;
        }>(
          `SELECT enabled,lifecycle_revision,activation_revision,submissions_paused,pre_drain_version
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
        const active = await client.query<{ version: string }>(
          'SELECT version FROM business_versions WHERE business_id=$1 AND is_active=true', [businessId],
        );
        const activeVersion = active.rows[0]?.version ?? null;
        await advanceActivationRevision(client, businessId, Number(row.activation_revision), {
          action: enabled ? 'BUSINESS_ENABLED' : 'BUSINESS_DISABLED',
          previousVersion: activeVersion,
          activeVersion,
          submissionsPaused: row.submissions_paused,
          preDrainVersion: row.pre_drain_version,
          actor,
        });
        if (active.rows[0]) {
          if (enabled) await unparkVersionWork(client, businessId, active.rows[0].version);
          else await parkVersionWork(client, businessId, active.rows[0].version, 'BUSINESS_DISABLED');
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

    async activateVersion(businessId, version, expectedActivationRevision, activeClient, actor = 'admin') {
      const run = async (client: PoolClient) => {
        // The catalog row is the common business-scoped mutex. Activation
        // always locks root → versions, matching registration and the
        // claim/submission admission paths.
        const admission = await readBusinessAdmission(client, businessId, version, 'UPDATE');
        if (!admission) throw new HttpError(404, 'NOT_FOUND', `business ${businessId} not registered`);
        const versions = await client.query<{ version: string; status: string; is_active: boolean }>(
          `SELECT version,status,is_active FROM business_versions
            WHERE business_id=$1 ORDER BY version FOR UPDATE`,
          [businessId],
        );
        const target = versions.rows.find((row) => row.version === version);
        if (!target) throw new HttpError(404, 'NOT_FOUND', `business ${businessId}@${version} not registered`);
        if (target.status !== 'ENABLED') {
          throw conflict('STATE_CONFLICT', `business ${businessId}@${version} is ${target.status}, not ENABLED`);
        }
        const previousVersion = versions.rows.find((row) => row.is_active)?.version ?? null;
        if (admission.submissionsPaused && admission.preDrainVersion === version && previousVersion === version) {
          throw conflict('STATE_CONFLICT', 'cancel pre-drain explicitly to resume submissions on the active version');
        }
        const stateAlreadyMatches = previousVersion === version && !admission.submissionsPaused;
        if (stateAlreadyMatches) {
          if (expectedActivationRevision === admission.activationRevision
            || await activationCommandWasApplied(
              client, businessId, expectedActivationRevision, admission.activationRevision, 'ACTIVATED', version,
            )) {
            return {
              businessId, version, active: true, activationRevision: admission.activationRevision,
              previousVersion, replayed: true,
            };
          }
          throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
        }
        if (expectedActivationRevision !== admission.activationRevision) {
          throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
        }

        if (admission.submissionsPaused && admission.preDrainVersion && admission.preDrainVersion !== version) {
          const remainingOperations = await countNonterminalOperations(client, businessId, admission.preDrainVersion);
          if (remainingOperations > 0) {
            throw conflict('STATE_CONFLICT', 'pre-drain is still waiting for the active version to finish', {
              errors: [{ pointer: '/remainingOperations', message: String(remainingOperations) }],
            });
          }
        }

        await client.query(
          'UPDATE business_versions SET is_active=false,updated_at=now() WHERE business_id=$1 AND is_active=true',
          [businessId],
        );
        await client.query(
          'UPDATE business_versions SET is_active=true,updated_at=now() WHERE business_id=$1 AND version=$2',
          [businessId, version],
        );
        if (previousVersion && previousVersion !== version) {
          await parkVersionWork(client, businessId, previousVersion, 'VERSION_NOT_ACTIVE');
        }
        await unparkVersionWork(client, businessId, version);
        const nextRevision = await advanceActivationRevision(client, businessId, expectedActivationRevision, {
          action: 'ACTIVATED', previousVersion, activeVersion: version, actor,
        });
        return {
          businessId, version, active: true, activationRevision: nextRevision,
          previousVersion, replayed: false,
        };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },

    async deactivateVersion(businessId, version, expectedActivationRevision, activeClient, actor = 'admin') {
      const run = async (client: PoolClient) => {
        const admission = await readBusinessAdmission(client, businessId, version, 'UPDATE');
        if (!admission) throw new HttpError(404, 'NOT_FOUND', `business ${businessId} not registered`);
        const target = await client.query<{ status: string }>(
          'SELECT status FROM business_versions WHERE business_id=$1 AND version=$2',
          [businessId, version],
        );
        if (!target.rowCount) throw new HttpError(404, 'NOT_FOUND', `business ${businessId}@${version} not registered`);
        if (target.rows[0]!.status !== 'ENABLED') {
          throw conflict('STATE_CONFLICT', `business ${businessId}@${version} is ${target.rows[0]!.status}, not ENABLED`);
        }
        const previousVersion = admission.activeVersion;
        if (previousVersion !== version && !admission.submissionsPaused) {
          if (expectedActivationRevision === admission.activationRevision
            || await activationCommandWasApplied(
              client, businessId, expectedActivationRevision, admission.activationRevision, 'DEACTIVATED', null, version,
            )) {
            return {
              businessId, version, active: false, activationRevision: admission.activationRevision,
              previousVersion, replayed: true,
            };
          }
          throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
        }
        if (expectedActivationRevision !== admission.activationRevision) {
          if (await activationCommandWasApplied(
            client, businessId, expectedActivationRevision, admission.activationRevision, 'DEACTIVATED', null, version,
          )) {
            return {
              businessId, version, active: false, activationRevision: admission.activationRevision,
              previousVersion, replayed: true,
            };
          }
          throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
        }
        if (previousVersion !== version) {
          throw conflict('STATE_CONFLICT', `business ${businessId}@${version} is not the active version`);
        }

        await client.query(
          'UPDATE business_versions SET is_active=false,updated_at=now() WHERE business_id=$1 AND version=$2 AND is_active=true',
          [businessId, version],
        );
        await parkVersionWork(client, businessId, version, 'NO_ACTIVE_VERSION');
        const nextRevision = await advanceActivationRevision(client, businessId, expectedActivationRevision, {
          action: 'DEACTIVATED', previousVersion: version, activeVersion: null, actor,
        });
        return {
          businessId, version, active: false, activationRevision: nextRevision,
          previousVersion: version, replayed: false,
        };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },

    async startVersionPreDrain(businessId, version, expectedActivationRevision, activeClient, actor = 'admin') {
      const run = async (client: PoolClient) => {
        const admission = await readBusinessAdmission(client, businessId, version, 'UPDATE');
        if (!admission) throw new HttpError(404, 'NOT_FOUND', `business ${businessId} not registered`);
        if (admission.activeVersion !== version) {
          throw conflict('STATE_CONFLICT', 'pre-drain can start only for the currently active version');
        }
        if (admission.targetStatus !== 'ENABLED') {
          throw conflict('STATE_CONFLICT', `business ${businessId}@${version} is not ENABLED`);
        }
        if (admission.submissionsPaused && admission.preDrainVersion === version) {
          if (expectedActivationRevision !== admission.activationRevision
            && !(await activationCommandWasApplied(
              client, businessId, expectedActivationRevision, admission.activationRevision,
              'PRE_DRAIN_STARTED', version,
            ))) {
            throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
          }
          return {
            businessId, version, submissionsPaused: true as const,
            activationRevision: admission.activationRevision,
            remainingOperations: await countNonterminalOperations(client, businessId, version), replayed: true,
          };
        }
        if (expectedActivationRevision !== admission.activationRevision) {
          throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
        }
        const nextRevision = await advanceActivationRevision(client, businessId, expectedActivationRevision, {
          action: 'PRE_DRAIN_STARTED', previousVersion: version, activeVersion: version,
          submissionsPaused: true, preDrainVersion: version,
          actor,
        });
        return {
          businessId, version, submissionsPaused: true as const,
          activationRevision: nextRevision,
          remainingOperations: await countNonterminalOperations(client, businessId, version), replayed: false,
        };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },

    async cancelVersionPreDrain(businessId, version, expectedActivationRevision, activeClient, actor = 'admin') {
      const run = async (client: PoolClient) => {
        const admission = await readBusinessAdmission(client, businessId, version, 'UPDATE');
        if (!admission) throw new HttpError(404, 'NOT_FOUND', `business ${businessId} not registered`);
        if (!admission.submissionsPaused || admission.preDrainVersion !== version) {
          if (expectedActivationRevision === admission.activationRevision
            || await activationCommandWasApplied(
              client, businessId, expectedActivationRevision, admission.activationRevision,
              'PRE_DRAIN_CANCELLED', version, version,
            )) {
            return { businessId, version, submissionsPaused: false as const,
              activationRevision: admission.activationRevision, replayed: true };
          }
          throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
        }
        if (admission.activeVersion !== version) {
          throw conflict('STATE_CONFLICT', 'pre-drain version is no longer active');
        }
        if (expectedActivationRevision !== admission.activationRevision) {
          throw staleActivationRevision(expectedActivationRevision, admission.activationRevision);
        }
        const nextRevision = await advanceActivationRevision(client, businessId, expectedActivationRevision, {
          action: 'PRE_DRAIN_CANCELLED', previousVersion: version, activeVersion: version,
          submissionsPaused: false, preDrainVersion: null,
          actor,
        });
        return { businessId, version, submissionsPaused: false as const,
          activationRevision: nextRevision, replayed: false };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },
  };
}

/** Test/admin helper: flip a registered version to ENABLED and active (W28-C adds is_active). */
export async function enableVersionForTest(db: Db, businessId: string, version: string): Promise<void> {
  // Test fixture helper: take the same root lock as production activation.
  await db.tx(async (client) => {
    await client.query('SELECT business_id FROM business_catalog WHERE business_id=$1 FOR UPDATE', [businessId]);
    await client.query('UPDATE business_versions SET is_active = false, updated_at = now() WHERE business_id = $1', [businessId]);
    await client.query('UPDATE business_versions SET status = $3, is_active = true, updated_at = now() WHERE business_id = $1 AND version = $2', [
      businessId,
      version,
      'ENABLED',
    ]);
    await client.query(
      `UPDATE business_catalog SET submissions_paused=false,pre_drain_version=NULL,
              activation_revision=activation_revision+1,updated_at=now()
        WHERE business_id=$1`,
      [businessId],
    );
  });
}

export { hashManifest };
