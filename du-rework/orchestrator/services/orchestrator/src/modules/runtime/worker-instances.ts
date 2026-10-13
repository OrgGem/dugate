import type { QueryResultRow } from 'pg';
import { conflict } from '../../http/errors';
import type { MaintenanceControlState, WorkerHeartbeat } from '@du/contracts';
import type { Db } from '../../db/db';
import { readWorkerControl } from './control';
import { admissionReasonForVersion, readBusinessAdmission } from '../registry/version-admission';

export const WORKER_HEARTBEAT_FRESH_FOR_MS = 60_000;
/** Keep offline worker inventory visible for one day after its last observation. */
export const WORKER_INSTANCE_RETENTION_MS = 24 * 60 * 60_000;
export const WORKER_INSTANCE_RETENTION_BATCH_SIZE = 100;

interface WorkerHeartbeatWriteRow extends QueryResultRow {
  state: 'ONLINE' | 'DRAINING' | 'OFFLINE';
  last_seen_at: Date | string;
  control_revision: number | string;
  control_state: MaintenanceControlState;
}

interface BackupFenceRow extends QueryResultRow {
  state: 'OPEN' | 'HELD' | 'UNKNOWN';
  fence_revision: number | string;
}

/** Record one authenticated worker heartbeat and refresh its active lease count. */
export async function recordWorkerHeartbeat(
  db: Db,
  instanceId: string,
  heartbeat: WorkerHeartbeat,
): Promise<{
  state: WorkerHeartbeatWriteRow['state'];
  lastSeenAt: string;
  controlRevision: number;
  controlState: MaintenanceControlState;
  activeVersion: string | null;
  activationRevision: number;
  admissionEligible: boolean;
  admissionReason: ReturnType<typeof admissionReasonForVersion>;
  backupEffectFence: { state: 'OPEN' | 'HELD' | 'UNKNOWN'; revision: number; acknowledged: boolean };
}> {
  return db.tx(async (client) => {
    // This is intentionally the first row lock. Backup activation takes an
    // exclusive lock on the same singleton and therefore cannot claim a
    // coherent snapshot while an old heartbeat is being persisted.
    const backupFenceResult = await client.query<BackupFenceRow>(
      `SELECT state,fence_revision FROM maintenance_backup_effect_gate
        WHERE singleton_id=1 FOR SHARE`,
    );
    const backupFence = backupFenceResult.rows[0];
    if (!backupFence) throw new Error('backup effect fence gate is not initialized');
    const backupFenceRevision = Number(backupFence.fence_revision);
    if (!Number.isSafeInteger(backupFenceRevision) || backupFenceRevision < 0) {
      throw new Error('backup effect fence revision is invalid');
    }
    if (heartbeat.manifestDigest !== undefined) {
      // Manifest digests are immutable after registration. This read validates
      // the heartbeat without locking the version row before we later lock the
      // worker row; registration locks root→version, while claim locks
      // worker→business root, so a version row lock here would close a cycle.
      const registration = await client.query<{ digest: string }>(
        `SELECT digest FROM business_versions
          WHERE business_id=$1 AND version=$2`,
        [heartbeat.businessId, heartbeat.businessVersion],
      );
      const registeredDigest = registration.rows[0]?.digest;
      if (!registeredDigest) {
        throw conflict('WORKER_NOT_REGISTERED', 'worker manifest version must be registered before heartbeat');
      }
      if (registeredDigest !== heartbeat.manifestDigest) {
        throw conflict('MANIFEST_DIGEST_MISMATCH', 'worker heartbeat digest does not match its registered manifest');
      }
    }
    // Keep heartbeat liveness available even for inactive versions. The root
    // lock only makes this admission observation ordered with a cutover; it
    // never changes the worker or its currently running task permission.
    const versionAdmission = await readBusinessAdmission(
      client,
      heartbeat.businessId,
      heartbeat.businessVersion,
      'SHARE',
    );
    if (!versionAdmission) {
      throw conflict('WORKER_NOT_REGISTERED', 'worker business is not registered in the catalog');
    }
    const admissionReason = admissionReasonForVersion(versionAdmission, heartbeat.businessVersion);
    const backupFenceAcknowledged = heartbeat.observedBackupFenceRevision === backupFenceRevision;
    const scoped = await readWorkerControl(client, heartbeat.businessId);
    const tenantControls = await client.query<{
      scope_id: string; revision: number | string; desired_state: MaintenanceControlState;
    }>(
      `SELECT r.scope_id,r.revision,r.desired_state
         FROM runtime_control_scopes r
        WHERE r.scope_kind='tenant'
          -- scope_id is deliberately text because this table also stores the
          -- platform sentinel (all) and business identifiers. Compare its
          -- textual form with UUID tenant IDs rather than casting untrusted
          -- scope text to uuid; tenant-scoped controls for malformed or
          -- non-tenant identifiers simply cannot match.
          AND EXISTS (SELECT 1 FROM operations o WHERE o.tenant_id::text=r.scope_id AND o.business_id=$1)
        ORDER BY r.scope_id
        FOR SHARE OF r`,
      [heartbeat.businessId],
    );
    const perWorker = await client.query<{ desired_control_revision: number | string; desired_control_state: MaintenanceControlState }>(
      `SELECT desired_control_revision,desired_control_state
         FROM worker_instances WHERE business_id=$1 AND instance_id=$2 FOR UPDATE`,
      [heartbeat.businessId, instanceId],
    );
    const workerControl = perWorker.rows[0] ?? { desired_control_revision: 0, desired_control_state: 'OPEN' as const };
    const state: MaintenanceControlState = scoped.state === 'DRAINING' || workerControl.desired_control_state === 'DRAINING'
      ? 'DRAINING'
      : scoped.state === 'PAUSED' || workerControl.desired_control_state === 'PAUSED'
        ? 'PAUSED'
        : 'OPEN';
    const revision = Math.max(scoped.revision, Number(workerControl.desired_control_revision));
    const result = await client.query<WorkerHeartbeatWriteRow>(
      `WITH lease_count AS (
       SELECT count(*)::int AS active_leases
         FROM tasks t
         JOIN operations o ON o.id = t.operation_id
        WHERE t.leased_by = $2
          AND o.business_id = $1
          AND t.state = 'RUNNING'
          AND t.lease_expires_at > statement_timestamp()
     )
     INSERT INTO worker_instances (
       business_id, instance_id, business_version, manifest_digest, image_digest, state, capacity,
       active_leases, last_seen_at, observed_at, control_revision, control_state,
       deployment_revision, active_task_count, active_task_observed_at,
       backup_effect_fence_revision, backup_effect_fence_observed_at
     )
     SELECT $1, $2, $3, $12, $8, $5, $4, lease_count.active_leases,
            statement_timestamp(), statement_timestamp(), $6, $7, $10, $9,
            CASE WHEN $9::integer IS NULL THEN NULL ELSE statement_timestamp() END,
            $11, CASE WHEN $11::bigint IS NULL THEN NULL ELSE statement_timestamp() END
       FROM lease_count
     ON CONFLICT (business_id, instance_id) DO UPDATE
       SET business_version = EXCLUDED.business_version,
           manifest_digest = CASE
             WHEN EXCLUDED.business_version = worker_instances.business_version
               THEN COALESCE(EXCLUDED.manifest_digest, worker_instances.manifest_digest)
             ELSE EXCLUDED.manifest_digest
           END,
           image_digest = EXCLUDED.image_digest,
           deployment_revision = EXCLUDED.deployment_revision,
           state = CASE WHEN EXCLUDED.control_state = 'DRAINING' THEN 'DRAINING' ELSE 'ONLINE' END,
           capacity = EXCLUDED.capacity,
           active_leases = EXCLUDED.active_leases,
           last_seen_at = EXCLUDED.last_seen_at,
           observed_at = EXCLUDED.observed_at,
           control_revision = EXCLUDED.control_revision,
           control_state = EXCLUDED.control_state,
           active_task_count = EXCLUDED.active_task_count,
           active_task_observed_at = EXCLUDED.active_task_observed_at,
           backup_effect_fence_revision = EXCLUDED.backup_effect_fence_revision,
           backup_effect_fence_observed_at = EXCLUDED.backup_effect_fence_observed_at
     RETURNING state, last_seen_at, control_revision, control_state`,
      [heartbeat.businessId, instanceId, heartbeat.businessVersion, heartbeat.capacity,
        state === 'DRAINING' ? 'DRAINING' : 'ONLINE', revision, state, heartbeat.imageDigest,
        heartbeat.activeTasks ?? null, heartbeat.deploymentRevision ?? null,
        heartbeat.observedBackupFenceRevision ?? null, heartbeat.manifestDigest ?? null],
    );
    const row = result.rows[0];
    if (!row) throw new Error('worker heartbeat upsert returned no row');
    const acknowledgedScopes = [
      ...scoped.states.map((control) => ({
        scopeKind: control.scopeKind,
        scopeId: control.scopeId,
        revision: control.revision,
        state: control.state,
      })),
      ...tenantControls.rows.map((control) => ({
        scopeKind: 'tenant' as const,
        scopeId: control.scope_id,
        revision: Number(control.revision),
        state: control.desired_state,
      })),
    ];
    for (const control of acknowledgedScopes) {
      await client.query(
        `INSERT INTO worker_control_scope_acks
           (business_id,instance_id,scope_kind,scope_id,control_revision,control_state,observed_at)
         VALUES ($1,$2,$3,$4,$5,$6,statement_timestamp())
         ON CONFLICT (business_id,instance_id,scope_kind,scope_id) DO UPDATE
           SET control_revision=EXCLUDED.control_revision,
               control_state=EXCLUDED.control_state,
               observed_at=EXCLUDED.observed_at`,
        [heartbeat.businessId, instanceId, control.scopeKind, control.scopeId, control.revision, control.state],
      );
    }
    const lastSeenAt = row.last_seen_at instanceof Date ? row.last_seen_at : new Date(row.last_seen_at);
    if (Number.isNaN(lastSeenAt.getTime())) throw new Error('worker heartbeat upsert returned an invalid timestamp');
    return {
      state: row.state,
      lastSeenAt: lastSeenAt.toISOString(),
      controlRevision: Number(row.control_revision),
      controlState: row.control_state,
      activeVersion: versionAdmission.activeVersion,
      activationRevision: versionAdmission.activationRevision,
      admissionEligible: admissionReason === 'ELIGIBLE',
      admissionReason,
      backupEffectFence: {
        state: backupFence.state,
        revision: backupFenceRevision,
        acknowledged: backupFenceAcknowledged,
      },
    };
  });
}

export type WorkerInstanceRetirementResult = 'REMOVED' | 'RETAINED_FOR_RUNNING_TASK' | 'STALE_IDENTITY';

/**
 * Retire an authenticated worker generation after its consumer has stopped.
 * The exact business/version/digest row is locked before checking task leases,
 * matching the claim path's worker-row fence. Historical task/operation rows
 * are never removed; RUNNING owners keep an OFFLINE inventory row until later
 * retention cleanup.
 */
export async function retireWorkerInstance(
  db: Db,
  businessId: string,
  instanceId: string,
  businessVersion: string,
  manifestDigest: string,
): Promise<WorkerInstanceRetirementResult> {
  return db.tx(async (client) => {
    const worker = await client.query<{
      business_version: string;
      manifest_digest: string | null;
    }>(
      `SELECT business_version,manifest_digest FROM worker_instances
        WHERE business_id=$1 AND instance_id=$2 FOR UPDATE`,
      [businessId, instanceId],
    );
    const row = worker.rows[0];
    if (!row || row.business_version !== businessVersion || row.manifest_digest !== manifestDigest) {
      return 'STALE_IDENTITY';
    }

    // Keep the task read in its own statement and do not lock task rows. Claims
    // lock task then worker; holding only the worker row avoids a lock cycle.
    const leases = await client.query<{
      has_running_task: boolean;
      active_leases: number | string;
    }>(
      `SELECT EXISTS (
               SELECT 1
                 FROM tasks running_task
                 JOIN operations running_operation ON running_operation.id=running_task.operation_id
                WHERE running_operation.business_id=$1
                  AND running_task.leased_by=$2
                  AND running_task.state='RUNNING'
             ) AS has_running_task,
             count(*) FILTER (WHERE t.lease_expires_at > statement_timestamp())::int AS active_leases
         FROM tasks t
         JOIN operations o ON o.id=t.operation_id
        WHERE t.leased_by=$2
          AND o.business_id=$1
          AND t.state='RUNNING'`,
      [businessId, instanceId],
    );
    const activeLeases = Number(leases.rows[0]?.active_leases ?? 0);
    if (!Number.isSafeInteger(activeLeases) || activeLeases < 0) {
      throw new Error('worker retirement lease count is invalid');
    }

    if (leases.rows[0]?.has_running_task === true) {
      await client.query(
        `UPDATE worker_instances
            SET state='OFFLINE', capacity=0, active_leases=$5,
                last_seen_at=statement_timestamp(), observed_at=statement_timestamp()
          WHERE business_id=$1 AND instance_id=$2 AND business_version=$3
            AND manifest_digest=$4 AND state<>'OFFLINE'`,
        [businessId, instanceId, businessVersion, manifestDigest, activeLeases],
      );
      return 'RETAINED_FOR_RUNNING_TASK';
    }

    await client.query(
      `DELETE FROM worker_instances
        WHERE business_id=$1 AND instance_id=$2 AND business_version=$3
          AND manifest_digest=$4`,
      [businessId, instanceId, businessVersion, manifestDigest],
    );
    return 'REMOVED';
  });
}

export interface WorkerInstanceRetentionSweepResult {
  scanned: number;
  deleted: number;
  protectedByRunningTask: number;
}

/**
 * Delete only old worker inventory rows with no RUNNING task owner.
 * Historical task/operation rows retain their leased_by text unchanged; the
 * worker_control_scope_acks cache is the only FK that cascades with this row.
 */
export async function sweepExpiredWorkerInstances(
  db: Db,
  nowMs = Date.now(),
  limit = WORKER_INSTANCE_RETENTION_BATCH_SIZE,
): Promise<WorkerInstanceRetentionSweepResult> {
  if (!Number.isSafeInteger(nowMs) || Number.isNaN(new Date(nowMs).getTime())) {
    throw new Error('worker instance retention time is invalid');
  }
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > WORKER_INSTANCE_RETENTION_BATCH_SIZE) {
    throw new Error(`worker instance retention limit must be between 1 and ${WORKER_INSTANCE_RETENTION_BATCH_SIZE}`);
  }
  const cutoff = new Date(nowMs - WORKER_INSTANCE_RETENTION_MS).toISOString();
  return db.tx(async (client) => {
    // Lock a bounded set of worker rows first. The runtime claim path also
    // fences on this row; SKIP LOCKED avoids waiting on an active claim.
    const candidates = await client.query<{ business_id: string; instance_id: string }>(
      `SELECT business_id,instance_id
         FROM worker_instances
        WHERE last_seen_at <= $1
          AND NOT EXISTS (
            SELECT 1
              FROM tasks t
              JOIN operations o ON o.id=t.operation_id
             WHERE o.business_id=worker_instances.business_id
               AND t.leased_by=worker_instances.instance_id
               AND t.state='RUNNING'
          )
        ORDER BY last_seen_at ASC,business_id ASC,instance_id ASC
        LIMIT $2 FOR UPDATE SKIP LOCKED`,
      [cutoff, limit],
    );
    let deleted = 0;
    let protectedByRunningTask = 0;
    for (const candidate of candidates.rows) {
      // Re-check the cutoff in a fresh statement while holding the row lock,
      // then check RUNNING history without taking a task-row lock.
      const stillExpired = await client.query<{ expired: boolean }>(
        `SELECT last_seen_at <= $3::timestamptz AS expired
           FROM worker_instances
          WHERE business_id=$1 AND instance_id=$2`,
        [candidate.business_id, candidate.instance_id, cutoff],
      );
      if (stillExpired.rows[0]?.expired !== true) continue;

      const running = await client.query<{ has_running_task: boolean }>(
        `SELECT EXISTS (
           SELECT 1
             FROM tasks t
             JOIN operations o ON o.id=t.operation_id
            WHERE o.business_id=$1
              AND t.leased_by=$2
              AND t.state='RUNNING'
         ) AS has_running_task`,
        [candidate.business_id, candidate.instance_id],
      );
      if (running.rows[0]?.has_running_task === true) {
        protectedByRunningTask += 1;
        continue;
      }

      const removed = await client.query(
        `DELETE FROM worker_instances
          WHERE business_id=$1 AND instance_id=$2 AND last_seen_at <= $3::timestamptz`,
        [candidate.business_id, candidate.instance_id, cutoff],
      );
      deleted += removed.rowCount ?? 0;
    }
    return { scanned: candidates.rows.length, deleted, protectedByRunningTask };
  });
}

export interface WorkerInstanceRetentionSchedulerOptions {
  enabled: boolean;
  intervalMs?: number;
  onSweep?: (result: WorkerInstanceRetentionSweepResult) => void;
  onError?: (error: unknown) => void;
}

/** Single-flight lifecycle wrapper for the bounded inventory cleanup. */
export function createWorkerInstanceRetentionScheduler(
  db: Db,
  options: WorkerInstanceRetentionSchedulerOptions,
): { start(): void; run(): Promise<void>; stop(): Promise<void> } {
  const intervalMs = options.intervalMs ?? 60 * 60_000;
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) {
    throw new Error('worker instance retention interval must be a positive integer');
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<void> | undefined;

  const run = (): Promise<void> => {
    if (!options.enabled) return Promise.resolve();
    if (active) return active;
    let sweep!: Promise<void>;
    sweep = sweepExpiredWorkerInstances(db)
      .then((result) => options.onSweep?.(result))
      .catch((error: unknown) => {
        try {
          options.onError?.(error);
        } catch {
          // A reporting hook must never leave the maintenance promise rejected.
        }
      })
      .finally(() => {
        if (active === sweep) active = undefined;
      });
    active = sweep;
    return sweep;
  };

  return {
    start(): void {
      if (!options.enabled || timer) return;
      void run();
      timer = setInterval(() => { void run(); }, intervalMs);
      timer.unref?.();
    },
    run,
    async stop(): Promise<void> {
      if (timer) clearInterval(timer);
      timer = undefined;
      await active;
    },
  };
}
