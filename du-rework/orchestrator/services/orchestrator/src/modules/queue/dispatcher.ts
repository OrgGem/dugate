import { Queue } from 'bullmq';
import { jobIdForDelivery } from '@du/contracts';
import { Db } from '../../db/db';

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
         ORDER BY due_at
         LIMIT $1
         FOR UPDATE SKIP LOCKED`,
        [batchSize]
      );
      if (!res.rowCount) return 0;

      let dispatched = 0;
      for (const row of res.rows as { id: string; aggregate_id: string; type: string; delivery_id: string; payload: Record<string, unknown> }[]) {
        const queueName = await resolveQueueForTask(client, row.aggregate_id);
        if (!queueName) continue;
        const queue = opts.getQueue(queueName);
        const jobId = jobIdForDelivery(row.delivery_id);
        // T-SUB-03: the profile's BullMQ priority was pinned into the outbox
        // payload at submit (submission.ts). Absent means a pre-profile row or
        // a legacy-mode submission, both of which enqueue with BullMQ's own
        // default — never a number invented here.
        const priority = typeof row.payload.priority === 'number' ? row.payload.priority : undefined;
        const jobData = { ...row.payload };
        delete (jobData as { gate?: unknown }).gate;
        try {
          await queue.add(row.type, jobData, {
            jobId,
            priority,
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
            await client.query(`UPDATE outbox SET dispatched_at = now() WHERE id = $1`, [row.id]);
            dispatched++;
          } else {
            await client.query(
              `UPDATE outbox SET claim_until = now() + interval '30 seconds', attempts = attempts + 1 WHERE id = $1`,
              [row.id]
            );
          }
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
): Promise<string | null> {
  const res = await db.query(
    `SELECT o.business_id, o.business_version, bv.queue
     FROM tasks t
     JOIN operations o ON o.id = t.operation_id
     LEFT JOIN business_versions bv ON bv.business_id = o.business_id AND bv.version = o.business_version
     WHERE t.id = $1`,
    [taskId]
  );
  if (!res.rowCount) return null;
  const row = res.rows[0] as { business_id: string; business_version: string; queue: string | null };
  return row.queue ?? `du-business-${row.business_id}-${row.business_version}`;
}
