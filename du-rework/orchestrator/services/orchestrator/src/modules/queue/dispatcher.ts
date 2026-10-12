import { Queue } from 'bullmq';
import { jobIdForDelivery } from '@du/contracts';
import { Db } from '../../db/db';
import { lockRuntimeControlsForTask } from '../runtime/control';
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
  /** Backup-only barrier, distinct from replica DRAINING. Its row lock is
   * held for the publish transaction so the fence waits for in-flight queue
   * sends and rejects new ones after activation. */
  backupSnapshotWriteGate?: BackupSnapshotWriteGate;
  pollIntervalMs?: number;
  batchSize?: number;
}

export function createDispatcher(opts: DispatcherOptions) {
  const batchSize = opts.batchSize ?? 50;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function dispatchOnce(): Promise<number> {
    // Claim + publish + mark run in ONE transaction: FOR UPDATE SKIP LOCKED
    // only fences when held by a tx, and concurrent sweepers must not
    // double-dispatch the same row (docs 04 OPS-01).
    return opts.db.tx(async (client) => {
      if (opts.backupSnapshotWriteGate) {
        await opts.backupSnapshotWriteGate.assertWriteAllowed(client, {
          tenantId: null,
          domain: 'orchestrator-dispatch',
          requestKey: `outbox-dispatch:${Date.now()}`,
        });
      }
      // W-DATA03-CONSUMER-JOIN-1: gate 'ingestion' dispatches are durable
      // work for the ingestion consumer (modules/operations/
      // ingestion-consumer.ts), NOT business jobs. Publishing them here was
      // the audit's ungated leak: a worker claim would run the root task
      // while its source still sat behind the ingestion gate. gate 'ready'
      // rows (markIngestionReady's own dispatch) stay on this path.
      const res = await client.query(
        `SELECT id, aggregate_id, type, delivery_id, payload, attempts
         FROM outbox
         WHERE dispatched_at IS NULL
           AND (claim_until IS NULL OR claim_until < now())
           AND due_at <= now()
           AND (payload->>'gate') IS DISTINCT FROM 'ingestion'
           AND (
             type NOT IN ('task.dispatch','task.continuation')
             OR EXISTS (
               SELECT 1
                 FROM tasks t
                 JOIN operations o ON o.id=t.operation_id
                 JOIN business_catalog c ON c.business_id=o.business_id AND c.enabled=true
                WHERE t.id=outbox.aggregate_id
             )
           )
         ORDER BY due_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize]
      );
      if (!res.rowCount) return 0;

      let dispatched = 0;
      for (const row of res.rows as { id: string; aggregate_id: string; type: string; delivery_id: string; payload: Record<string, unknown> }[]) {
        const target = await resolveQueueForTask(client, row.aggregate_id);
        if (!target) continue;
        const control = await lockRuntimeControlsForTask(client, target);
        if (control.state !== 'OPEN') {
          // Keep accepted work durable and available for dispatch after a
          // resume. A short claim lease avoids one paused scope occupying the
          // same poll batch continuously.
          await client.query(
            `UPDATE outbox SET claim_until=now() + interval '5 seconds' WHERE id=$1`,
            [row.id],
          );
          continue;
        }
        const businessGate = await client.query<{ enabled: boolean }>(
          'SELECT enabled FROM business_catalog WHERE business_id=$1 FOR SHARE',
          [target.businessId],
        );
        if (!businessGate.rows[0]?.enabled) {
          // Keep accepted backlog durable while the logical business is off;
          // registration/enable recovery can publish the same outbox delivery.
          await client.query(
            `UPDATE outbox SET claim_until=now() + interval '5 seconds' WHERE id=$1`,
            [row.id],
          );
          continue;
        }
        let permitId: string | undefined;
        if (opts.dispatchAdmission) {
          const serviceControl = await opts.dispatchAdmission.readControl();
          if (serviceControl.state !== 'OPEN') {
            await client.query(
              `UPDATE outbox SET claim_until=now() + interval '5 seconds' WHERE id=$1`,
              [row.id],
            );
            continue;
          }
          const permit = await opts.dispatchAdmission.acquireDispatchPermit({
            serviceRuntimeId: opts.dispatchAdmission.serviceRuntimeId,
            expectedControlRevision: serviceControl.controlRevision,
          });
          if (!permit || permit.controlRevision !== serviceControl.controlRevision) {
            if (permit) await opts.dispatchAdmission.releaseDispatchPermit(permit.permitId);
            await client.query(
              `UPDATE outbox SET claim_until=now() + interval '5 seconds' WHERE id=$1`,
              [row.id],
            );
            continue;
          }
          permitId = permit.permitId;
        }
        try {
        const queueName = target.queueName;
        const queue = opts.getQueue(queueName);
        const jobId = jobIdForDelivery(row.delivery_id);
        // T-SUB-03: the profile's BullMQ priority was pinned into the outbox
        // payload at submit (submission.ts). Absent means a pre-profile row or
        // a legacy-mode submission, both of which enqueue with BullMQ's own
        // default — never a number invented here.
        const priority = typeof row.payload.priority === 'number' ? row.payload.priority : undefined;
        // delivery_id is the durable source of truth. Recovery generations
        // intentionally receive fresh IDs; never publish an old ID copied in
        // a legacy payload or the SDK would claim under the wrong identity.
        const jobData = { ...row.payload, deliveryId: row.delivery_id };
        delete (jobData as { gate?: unknown }).gate;
        try {
          await queue.add(row.type, jobData, {
            jobId,
            priority,
            // Delivery retries are bounded and transport-only. A worker that
            // defers before claim moves the job to its delayed state without
            // consuming a business attempt; the durable outbox recovery sweep
            // handles Redis loss after this BullMQ retry budget is exhausted.
            attempts: 8,
            backoff: { type: 'exponential', delay: 1_000, jitter: 0.25 },
            removeOnComplete: { age: 86400 },
            removeOnFail: { age: 7 * 86400 },
          });
          await client.query(
            `UPDATE outbox SET dispatched_at = now(), claim_until = NULL, attempts = attempts + 1 WHERE id = $1`,
            [row.id]
          );
          dispatched++;
        } catch (err) {
          if (isDuplicateJobIdError(err)) {
            // Deterministic job IDs mean re-enqueue dedups at the queue layer;
            // treat as dispatched (at-least-once is safe — claim fences).
            await client.query(
              `UPDATE outbox SET dispatched_at=now(), claim_until=NULL, attempts=attempts+1 WHERE id=$1`,
              [row.id],
            );
            dispatched++;
          } else {
            await client.query(
              `UPDATE outbox
                  SET claim_until=NULL,
                      attempts=attempts+1,
                      due_at=now() + (LEAST(300, GREATEST(1, power(2, attempts)) * (0.5 + random())) * interval '1 second')
                WHERE id=$1`,
              [row.id]
            );
          }
        }
        } finally {
          if (permitId) await opts.dispatchAdmission!.releaseDispatchPermit(permitId);
        }
      }
      return dispatched;
    });
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

async function resolveQueueForTask(
  db: { query: (text: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> },
  taskId: string
): Promise<{ queueName: string; tenantId: string; businessId: string } | null> {
  const res = await db.query(
    `SELECT o.tenant_id, o.business_id, o.business_version, bv.queue
     FROM tasks t
     JOIN operations o ON o.id = t.operation_id
     LEFT JOIN business_versions bv ON bv.business_id = o.business_id AND bv.version = o.business_version
     WHERE t.id = $1`,
    [taskId]
  );
  if (!res.rowCount) return null;
  const row = res.rows[0] as { tenant_id: string; business_id: string; business_version: string; queue: string | null };
  return {
    tenantId: row.tenant_id,
    businessId: row.business_id,
    queueName: row.queue ?? `du-business-${row.business_id}-${row.business_version}`,
  };
}
