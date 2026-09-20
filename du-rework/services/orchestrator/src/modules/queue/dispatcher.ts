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
      const res = await client.query(
        `SELECT id, aggregate_id, type, delivery_id, payload, attempts
         FROM outbox
         WHERE dispatched_at IS NULL
           AND (claim_until IS NULL OR claim_until < now())
           AND due_at <= now()
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
        try {
          await queue.add(row.type, row.payload, {
            jobId,
            removeOnComplete: { age: 86400 },
            removeOnFail: { age: 7 * 86400 },
          });
          await client.query(
            `UPDATE outbox SET dispatched_at = now(), claim_until = NULL, attempts = attempts + 1 WHERE id = $1`,
            [row.id]
          );
          dispatched++;
        } catch (err) {
          const msg = String(err);
          if (msg.includes('already exists') || msg.includes('JobIdAlreadyExists')) {
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
