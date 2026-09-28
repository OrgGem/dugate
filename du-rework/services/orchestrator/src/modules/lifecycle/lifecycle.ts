import { PoolClient } from 'pg';
import { Db } from '../../db/db';
import { HttpError, conflict, notFound } from '../../http/errors';
import { maybeScheduleWebhook } from '../webhooks/webhooks';

/**
 * Cancel + deadline enforcement (P2-06). Public cancel marks the operation and
 * its leased task CANCELLED (idempotent; a terminal op is a replay). The
 * deadline sweeper flips TIMED_OUT for operations past `deadline_at` that are
 * still running and cancels the leased task. Concurrency=1 in the sweeper test.
 */

export interface LifecycleService {
  /** R3-01/OIDC-03: optional open tx client so the dispatcher can commit
   *  the cancel together with its audit row. */
  cancelOperation(
    operationId: string,
    tenantId: string,
    client?: PoolClient
  ): Promise<{ operationId: string; state: string; replayed: boolean }>;
  /** R3-01: optional open tx client to join the caller's transaction. */
  sweepDeadlines(client?: PoolClient): Promise<number>;
}

export function createLifecycleService(db: Db): LifecycleService {
  return {
    async cancelOperation(operationId, tenantId, activeClient): Promise<{ operationId: string; state: string; replayed: boolean }> {
      const run = async (client: PoolClient) => {
        // Cycle-99 (X2 audit): the 404 message is FIXED text — echoing the
        // requested id would let the admin error body parrot ids whose
        // existence the caller was probing (same rule as requireResourceTenant).
        const opRes = await client.query('SELECT id, tenant_id, state FROM operations WHERE id=$1 FOR UPDATE', [operationId]);
        if (!opRes.rowCount) throw notFound('operation not found');
        const op = opRes.rows[0] as { tenant_id: string; state: string };
        if (op.tenant_id !== tenantId) throw notFound('operation not found');

        const terminal = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(op.state);
        if (terminal) {
          return { operationId, state: op.state, replayed: true };
        }

        await client.query(
          `UPDATE operations SET state='CANCELLED', state_version=state_version+1, cancel_requested=true, updated_at=now() WHERE id=$1`,
          [operationId]
        );
        // Cancel the leased/ready root task so a claimer sees a terminal task.
        await client.query(
          `UPDATE tasks SET state='CANCELLED', updated_at=now()
           WHERE operation_id=$1 AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED')`,
          [operationId]
        );
        // Close any open human wait in the SAME transaction (P2-06 / W27-C):
        // a terminal operation must not leave an actionable OPEN wait that a
        // tenant could answer. CANCELLED is a terminal wait state; resume on
        // it fails closed (409 STATE_CONFLICT) and emits no dispatch. Races
        // with a first resume are fenced by the operations FOR UPDATE above,
        // so either resume-then-cancel (wait ANSWERED, op then CANCELLED) or
        // cancel-then-resume (op terminal -> 409, wait CANCELLED) is atomic.
        await client.query(
          `UPDATE human_waits SET status='CANCELLED'
           WHERE operation_id=$1 AND status='OPEN'`,
          [operationId]
        );
        // P2-08: schedule the terminal webhook in the same tx (idempotent).
        await maybeScheduleWebhook(client, operationId);
        return { operationId, state: 'CANCELLED', replayed: false };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },

    async sweepDeadlines(activeClient?: PoolClient): Promise<number> {
      const run = async (client: PoolClient): Promise<number> => {
        const res = await client.query(
          `UPDATE operations SET state='TIMED_OUT', state_version=state_version+1, updated_at=now()
           WHERE state IN ('ACCEPTED','QUEUED','RUNNING','WAITING_CHILDREN','WAITING_INPUT','RETRY_PENDING')
             AND deadline_at IS NOT NULL AND deadline_at < now()
           RETURNING id`,
          []
        );
        const timedOut = res.rows as { id: string }[];
        if (timedOut.length) {
          await client.query(
            `UPDATE tasks SET state='CANCELLED', updated_at=now()
             WHERE operation_id = ANY($1) AND state NOT IN ('SUCCEEDED','FAILED','CANCELLED')`,
            [timedOut.map((r) => r.id)]
          );
          // Close any open human wait transactionally (W27-C): a deadlined
          // operation must not leave an actionable OPEN wait. EXPIRED is the
          // terminal wait state for the deadline path.
          await client.query(
            `UPDATE human_waits SET status='EXPIRED'
             WHERE operation_id = ANY($1) AND status='OPEN'`,
            [timedOut.map((r) => r.id)]
          );
          // P2-08: schedule terminal webhooks for each timed-out op (idempotent).
          for (const r of timedOut) {
            await maybeScheduleWebhook(client, r.id);
          }
        }
        return timedOut.length;
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },
  };
}
