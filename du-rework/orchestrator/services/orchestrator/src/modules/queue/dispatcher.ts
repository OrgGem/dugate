import { Queue } from 'bullmq';
import { randomUUID } from 'node:crypto';
import { jobIdForDelivery } from '@du/contracts';
import { Db } from '../../db/db';
import { lockRuntimeControlsForTask } from '../runtime/control';
import { admissionReasonForVersion, readBusinessAdmission } from '../registry/version-admission';
import type { BackupSnapshotWriteGate } from '../maintenance/backup-effect-fence';

/**
 * Outbox dispatcher (docs 04, OPS-01): polls the outbox table for pending
 * rows and publishes them to BullMQ with stable job IDs. Delivery is
 * at-least-once; the runtime claim is the fencing authority (409/410 end the
 * delivery safely). Runs as a periodic sweep; also callable on demand after
 * submission.
 */

export interface DispatcherOptions {
  db: Db;
  getQueue: (queueName: string) => Queue;
  /** Per-Orchestrator durable replica admission. The permit is held across
   * the external queue publish and outbox commit boundary. */
  dispatchAdmission?: {
    serviceRuntimeId: string;
    readControl(): Promise<{ controlRevision: number; state: 'OPEN' | 'PAUSED' | 'DRAINING' }>;
    acquireDispatchPermit(input: { serviceRuntimeId: string; expectedControlRevision: number }): Promise<{ permitId: string; controlRevision: number } | null>;
    releaseDispatchPermit(permitId: string): Promise<void>;
  };
  /** Backup-only barrier, distinct from replica DRAINING. It is checked before
   * external publication and again before the durable outbox finalization; no
   * database row lock is held across the Redis call. */
  backupSnapshotWriteGate?: BackupSnapshotWriteGate;
  pollIntervalMs?: number;
  batchSize?: number;
}

/**
 * Bounded repair for work created by an already-running lease after cutover.
 * Activation parks the rows that exist at commit time; old valid leases may
 * later emit child tasks or join continuations. This scan is deliberately
 * separate from the eligible publish page so inactive backlog cannot consume
 * its limit. Each candidate rechecks admission under the common root lock and
 * then locks task → outbox, matching runtime claim lock order.
 */
async function parkInactivePendingWork(
  db: Db,
  limit: number,
  backupSnapshotWriteGate?: BackupSnapshotWriteGate,
): Promise<number> {
  const candidates = await db.query<{
    task_id: string;
    business_id: string;
    business_version: string;
  }>(
    `SELECT t.id AS task_id,o.business_id,o.business_version
       FROM tasks t
       JOIN operations o ON o.id=t.operation_id
       JOIN business_catalog bc ON bc.business_id=o.business_id
       LEFT JOIN business_versions bv
         ON bv.business_id=o.business_id AND bv.version=o.business_version
      WHERE t.state NOT IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
        AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
        AND (bc.enabled=false OR bv.status IS DISTINCT FROM 'ENABLED' OR bv.is_active IS DISTINCT FROM true)
        AND EXISTS (
          SELECT 1 FROM outbox ob
           WHERE ob.aggregate_id=t.id AND ob.type IN ('task.dispatch','task.continuation')
             AND ob.dispatched_at IS NULL AND ob.parked_reason IS NULL
        )
      ORDER BY t.updated_at,t.id
      LIMIT $1`,
    [limit],
  );
  if (!candidates.rowCount) return 0;

  return db.tx(async (client) => {
    // Preserve the backup-fence → business-root → task → outbox order.
    if (backupSnapshotWriteGate) {
      await backupSnapshotWriteGate.assertWriteAllowed(client, {
        tenantId: null,
        domain: 'orchestrator-dispatch',
        requestKey: `outbox-park-inactive:${Date.now()}`,
      });
    }
    let parked = 0;
    for (const candidate of candidates.rows) {
      const admission = await readBusinessAdmission(
        client,
        candidate.business_id,
        candidate.business_version,
        'SHARE',
      );
      if (!admission || admissionReasonForVersion(admission, candidate.business_version) === 'ELIGIBLE') continue;
      const reason = admissionReasonForVersion(admission, candidate.business_version);
      const task = await client.query<{ state: string; operation_state: string }>(
        `SELECT t.state,o.state AS operation_state
           FROM tasks t JOIN operations o ON o.id=t.operation_id
          WHERE t.id=$1 FOR UPDATE OF t`,
        [candidate.task_id],
      );
      const taskRow = task.rows[0];
      if (!taskRow || taskRow.state === 'RUNNING'
        || ['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(taskRow.state)
        || ['SUCCEEDED','FAILED','CANCELLED','TIMED_OUT'].includes(taskRow.operation_state)) continue;
      const deliveries = await client.query<{ id: string }>(
        `SELECT id FROM outbox
          WHERE aggregate_id=$1 AND type IN ('task.dispatch','task.continuation')
            AND dispatched_at IS NULL AND parked_reason IS NULL
          ORDER BY id FOR UPDATE`,
        [candidate.task_id],
      );
      if (!deliveries.rowCount) continue;
      const parkedTask = await client.query(
        `UPDATE tasks SET admission_parked_reason=$2,
                admission_parked_at=COALESCE(admission_parked_at,statement_timestamp()),
                updated_at=statement_timestamp()
          WHERE id=$1 AND state NOT IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
          RETURNING id`,
        [candidate.task_id, reason],
      );
      if (!parkedTask.rowCount) continue;
      await client.query(
        `UPDATE outbox SET parked_reason=$2,parked_at=COALESCE(parked_at,statement_timestamp()),
                claim_token=NULL,claim_until=NULL
          WHERE aggregate_id=$1 AND type IN ('task.dispatch','task.continuation')
            AND dispatched_at IS NULL AND parked_reason IS NULL`,
        [candidate.task_id, reason],
      );
      parked += 1;
    }
    return parked;
  });
}

export function createDispatcher(opts: DispatcherOptions) {
  const batchSize = opts.batchSize ?? 50;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function dispatchOnce(): Promise<number> {
    // This bounded sweep handles child/continuation work emitted after a
    // cutover by a previously admitted lease. It does not share the publish
    // candidate limit, so inactive backlog never starves active deliveries.
    await parkInactivePendingWork(opts.db, batchSize, opts.backupSnapshotWriteGate);
    // Read a bounded candidate page without locks. The transactional claim
    // below takes locks in the shared order business -> control -> outbox;
    // Redis publication happens only after that transaction commits.
    const candidates = await opts.db.query<{
      id: string;
      aggregate_id: string;
      delivery_id: string;
      type: string;
      payload: Record<string, unknown>;
      business_id: string;
      business_version: string;
      tenant_id: string;
      queue_name: string;
    }>(
      `SELECT ob.id,ob.aggregate_id,ob.delivery_id,ob.type,ob.payload,
              o.business_id,o.business_version,o.tenant_id,
              COALESCE(bv.queue,'du-business-' || o.business_id || '-' || o.business_version) AS queue_name
         FROM outbox ob
         JOIN tasks t ON t.id=ob.aggregate_id
         JOIN operations o ON o.id=t.operation_id
         JOIN business_catalog bc ON bc.business_id=o.business_id
         JOIN business_versions bv
           ON bv.business_id=o.business_id AND bv.version=o.business_version
        WHERE ob.type IN ('task.dispatch','task.continuation')
          AND bc.enabled=true
          AND bv.status='ENABLED'
          AND bv.is_active=true
          AND ob.dispatched_at IS NULL
          AND ob.parked_reason IS NULL
          AND (ob.claim_until IS NULL OR ob.claim_until < now())
          AND ob.due_at <= now()
          AND (ob.payload->>'gate') IS DISTINCT FROM 'ingestion'
        ORDER BY ob.due_at,ob.created_at,ob.id
        LIMIT $1`,
      [batchSize],
    );
    if (!candidates.rowCount) return 0;

    const claimToken = randomUUID();
    const rows = await opts.db.tx(async (client) => {
      if (opts.backupSnapshotWriteGate) {
        await opts.backupSnapshotWriteGate.assertWriteAllowed(client, {
          tenantId: null,
          domain: 'orchestrator-dispatch',
          requestKey: `outbox-dispatch:${Date.now()}`,
        });
      }
      const claimed: DispatchRow[] = [];
      for (const candidate of candidates.rows) {
        // The business row is the common admission mutex. The version read is
        // a fresh statement after the lock, so it cannot reuse a pre-wait
        // snapshot from a SELECT that joined the active version.
        const admission = await readBusinessAdmission(
          client,
          candidate.business_id,
          candidate.business_version,
          'SHARE',
        );
        const reason = admission
          ? admissionReasonForVersion(admission, candidate.business_version)
          : 'BUSINESS_DISABLED';
        if (reason !== 'ELIGIBLE') {
          await client.query(
            `UPDATE tasks SET admission_parked_reason=$2,
                    admission_parked_at=COALESCE(admission_parked_at,statement_timestamp()),
                    updated_at=statement_timestamp()
              WHERE id=$1 AND state NOT IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`,
            [candidate.aggregate_id, reason],
          );
          await client.query(
            `UPDATE outbox SET parked_reason=$2,parked_at=statement_timestamp(),claim_token=NULL,claim_until=NULL
              WHERE id=$1 AND dispatched_at IS NULL`,
            [candidate.id, reason],
          );
          continue;
        }
        const control = await lockRuntimeControlsForTask(client, {
          tenantId: candidate.tenant_id,
          businessId: candidate.business_id,
        });
        if (control.state !== 'OPEN') {
          await client.query(
            `UPDATE outbox SET claim_until=statement_timestamp() + interval '5 seconds'
              WHERE id=$1 AND dispatched_at IS NULL AND parked_reason IS NULL`,
            [candidate.id],
          );
          continue;
        }
        const locked = await client.query<DispatchRow>(
          `SELECT ob.id,ob.aggregate_id,ob.delivery_id,ob.type,ob.payload,ob.attempts,
                  $2::text AS claim_token,$3::text AS business_id,$4::text AS business_version,
                  $5::text AS tenant_id,$6::text AS queue_name
             FROM outbox ob
            WHERE ob.id=$1 AND ob.dispatched_at IS NULL AND ob.parked_reason IS NULL
              AND (ob.claim_until IS NULL OR ob.claim_until<statement_timestamp())
              AND ob.due_at<=statement_timestamp()
            FOR UPDATE OF ob SKIP LOCKED`,
          [candidate.id, claimToken, candidate.business_id, candidate.business_version,
            candidate.tenant_id, candidate.queue_name],
        );
        if (!locked.rowCount) continue;
        await client.query(
          `UPDATE outbox SET claim_token=$2,claim_until=statement_timestamp()+interval '30 seconds'
            WHERE id=$1`,
          [candidate.id, claimToken],
        );
        claimed.push(locked.rows[0]!);
      }
      return claimed;
    });

    let dispatched = 0;
    for (const row of rows) {
      let permitId: string | undefined;
      if (opts.dispatchAdmission) {
        const serviceControl = await opts.dispatchAdmission.readControl();
        if (serviceControl.state !== 'OPEN') {
          await deferClaim(opts.db, row, 5_000);
          continue;
        }
        const permit = await opts.dispatchAdmission.acquireDispatchPermit({
          serviceRuntimeId: opts.dispatchAdmission.serviceRuntimeId,
          expectedControlRevision: serviceControl.controlRevision,
        });
        if (!permit || permit.controlRevision !== serviceControl.controlRevision) {
          if (permit) await opts.dispatchAdmission.releaseDispatchPermit(permit.permitId);
          await deferClaim(opts.db, row, 5_000);
          continue;
        }
        permitId = permit.permitId;
      }
      try {
        if (opts.backupSnapshotWriteGate) {
          try {
            await opts.db.tx((client) => opts.backupSnapshotWriteGate!.assertWriteAllowed(client, {
              tenantId: null,
              domain: 'orchestrator-dispatch',
              requestKey: `outbox-dispatch-publish:${row.id}:${row.claim_token}`,
            }));
          } catch (err) {
            if (isBackupEffectFenceActive(err)) continue;
            throw err;
          }
        }
        const queue = opts.getQueue(row.queue_name);
        const jobId = jobIdForDelivery(row.delivery_id);
        // T-SUB-03: priority remains part of the durable payload through every
        // retry/recovery generation and is passed to BullMQ unchanged.
        const priority = typeof row.payload.priority === 'number' ? row.payload.priority : undefined;
        const jobData = { ...row.payload, deliveryId: row.delivery_id };
        delete (jobData as { gate?: unknown }).gate;
        let outcome: 'dispatched' | 'retry';
        try {
          await queue.add(row.type, jobData, {
            jobId,
            priority,
            attempts: 8,
            backoff: { type: 'exponential', delay: 1_000, jitter: 0.25 },
            removeOnComplete: { age: 86400 },
            removeOnFail: { age: 7 * 86400 },
          });
          outcome = 'dispatched';
        } catch (err) {
          outcome = isDuplicateJobIdError(err) ? 'dispatched' : 'retry';
        }
        const committed = await finalizeClaim(opts.db, row, outcome, opts.backupSnapshotWriteGate)
          .catch((err: unknown) => {
            // A late publish is safe: the task claim path is fenced too, and
            // the stable BullMQ ID lets a later recovery pass converge. Leave
            // the durable claim to expire rather than stamping during backup.
            if (isBackupEffectFenceActive(err)) return false;
            throw err;
          });
        if (committed && outcome === 'dispatched') {
          dispatched++;
        }
      } finally {
        if (permitId) await opts.dispatchAdmission!.releaseDispatchPermit(permitId);
      }
    }
    return dispatched;
  }

  return {
    dispatchOnce,
    start() {
      timer = setInterval(() => {
        dispatchOnce().catch(() => undefined);
      }, opts.pollIntervalMs ?? 2000);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
    },
  };
}

interface DispatchRow {
  id: string;
  aggregate_id: string;
  type: string;
  delivery_id: string;
  payload: Record<string, unknown>;
  attempts: number | string;
  claim_token: string;
  business_id: string;
  business_version: string;
  tenant_id: string;
  queue_name: string;
}

async function deferClaim(db: Db, row: DispatchRow, delayMs: number): Promise<void> {
  await db.query(
    `UPDATE outbox SET claim_token=NULL,
            claim_until=statement_timestamp()+($3 * interval '1 millisecond')
      WHERE id=$1 AND claim_token=$2 AND dispatched_at IS NULL`,
    [row.id, row.claim_token, delayMs],
  );
}

async function finalizeClaim(
  db: Db,
  row: DispatchRow,
  outcome: 'dispatched' | 'retry',
  backupSnapshotWriteGate?: BackupSnapshotWriteGate,
): Promise<boolean> {
  return db.tx(async (client) => {
    if (backupSnapshotWriteGate) {
      await backupSnapshotWriteGate.assertWriteAllowed(client, {
        tenantId: null,
        domain: 'orchestrator-dispatch',
        requestKey: `outbox-dispatch-finalize:${row.id}:${row.claim_token}`,
      });
    }
    const admission = await readBusinessAdmission(
      client,
      row.business_id,
      row.business_version,
      'SHARE',
    );
    const reason = admission
      ? admissionReasonForVersion(admission, row.business_version)
      : 'BUSINESS_DISABLED';
    if (reason !== 'ELIGIBLE') {
      await client.query(
        `UPDATE tasks SET admission_parked_reason=$2,
                admission_parked_at=COALESCE(admission_parked_at,statement_timestamp()),
                updated_at=statement_timestamp()
          WHERE id=$1 AND state NOT IN ('RUNNING','SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')`,
        [row.aggregate_id, reason],
      );
      const parked = await client.query(
        `UPDATE outbox SET parked_reason=$3,parked_at=statement_timestamp(),claim_token=NULL,claim_until=NULL
          WHERE id=$1 AND claim_token=$2 AND dispatched_at IS NULL RETURNING id`,
        [row.id, row.claim_token, reason],
      );
      return Boolean(parked.rowCount);
    }
    const updated = outcome === 'dispatched'
      ? await client.query(
        `UPDATE outbox SET dispatched_at=statement_timestamp(),claim_token=NULL,claim_until=NULL,
                attempts=attempts+1
          WHERE id=$1 AND claim_token=$2 AND dispatched_at IS NULL RETURNING id`,
        [row.id, row.claim_token],
      )
      : await client.query(
        `UPDATE outbox SET claim_token=NULL,claim_until=NULL,attempts=attempts+1,
                due_at=statement_timestamp() +
                  (LEAST(300,GREATEST(1,power(2,attempts))*(0.5+random()))*interval '1 second')
          WHERE id=$1 AND claim_token=$2 AND dispatched_at IS NULL RETURNING id`,
        [row.id, row.claim_token],
      );
    return Boolean(updated.rowCount);
  });
}

/**
 * BullMQ exposes duplicate job IDs as a typed error in production; the
 * message fallback is retained only for older queue clients and is used for
 * control flow. It is never persisted, logged, or returned to a caller.
 */
function isDuplicateJobIdError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false;
  const candidate = err as { code?: unknown; name?: unknown; message?: unknown };
  if (candidate.code === 'JOB_ID_ALREADY_EXISTS' || candidate.name === 'JobIdAlreadyExistsError') return true;
  return typeof candidate.message === 'string'
    && (candidate.message.includes('already exists') || candidate.message.includes('JobIdAlreadyExists'));
}

function isBackupEffectFenceActive(err: unknown): boolean {
  return typeof err === 'object' && err !== null
    && (err as { code?: unknown }).code === 'BACKUP_EFFECT_FENCE_ACTIVE';
}
