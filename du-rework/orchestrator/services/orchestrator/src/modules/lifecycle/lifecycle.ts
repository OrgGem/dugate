import { retryOperation } from '../operations/retry';
import type { MetadataCrypto } from '../runtime/metadata-crypto';
import type { MetadataReader } from '../encryption/metadata-read-policy';
import { PoolClient } from 'pg';
import { Db } from '../../db/db';
import { HttpError, conflict, notFound } from '../../http/errors';
import { maybeScheduleWebhook } from '../webhooks/webhooks';

/**
 * Cancel + deadline enforcement. A running leased worker receives a durable
 * cancel signal and acknowledges it after aborting provider work. Unleased or
 * paused operations can be terminalized immediately. The
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
  retryOperation?: (operationId: string, tenantId: string, client: PoolClient) => Promise<Record<string, unknown>>;
  /** Bounded recovery for cancellation signals whose worker died or task lock was contended. */
  sweepCancellations?(limit?: number): Promise<number>;
  /** R3-01: optional open tx client to join the caller's transaction. */
  sweepDeadlines(client?: PoolClient): Promise<number>;
}

export function createLifecycleService(db: Db, crypto?: MetadataCrypto, reader?: MetadataReader): LifecycleService {
  const service: LifecycleService = {
    retryOperation: (operationId, tenantId, client) => retryOperation(client, operationId, tenantId, crypto, reader),
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

        // Claims/heartbeats lock task first, then operation. Never wait on a
        // task while holding our operation lock: NOWAIT plus a savepoint lets
        // this audited caller-owned transaction persist the signal safely.
        let activeOrContended = false;
        await client.query('SAVEPOINT operation_cancel_tasks');
        try {
          const tasks = await client.query(
            `SELECT state, (lease_expires_at IS NOT NULL AND lease_expires_at > clock_timestamp()) AS lease_active
               FROM tasks WHERE operation_id=$1 ORDER BY id FOR UPDATE NOWAIT`,
            [operationId],
          );
          activeOrContended = tasks.rows.some((task: { state: string; lease_active: boolean }) => task.state === 'RUNNING' && task.lease_active === true);
          await client.query('RELEASE SAVEPOINT operation_cancel_tasks');
        } catch (error: unknown) {
          await client.query('ROLLBACK TO SAVEPOINT operation_cancel_tasks');
          await client.query('RELEASE SAVEPOINT operation_cancel_tasks');
          if (typeof error !== 'object' || error === null || !('code' in error) || error.code !== '55P03') throw error;
          activeOrContended = true;
        }
        if (activeOrContended) {
          if (op.state !== 'CANCEL_REQUESTED') {
            await client.query(
              `UPDATE operations SET state='CANCEL_REQUESTED', cancel_requested=true,
                                     state_version=state_version+1, updated_at=now() WHERE id=$1`,
              [operationId],
            );
          }
          // Leave task RUNNING and lease intact. The heartbeat must pass its
          // lease check to deliver cancelRequested=true to the SDK, which
          // aborts the provider request before acknowledging cancellation.
          return { operationId, state: 'CANCEL_REQUESTED', replayed: op.state === 'CANCEL_REQUESTED' };
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

    async sweepCancellations(limit = 50): Promise<number> {
      const boundedLimit = Number.isSafeInteger(limit) ? Math.max(1, Math.min(limit, 100)) : 50;
      return db.tx(async (client) => {
        const pending = await client.query<{ id: string; tenant_id: string }>(
          `SELECT id, tenant_id FROM operations WHERE state='CANCEL_REQUESTED'
           ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [boundedLimit],
        );
        let terminalized = 0;
        for (const op of pending.rows) {
          const result = await service.cancelOperation(op.id, op.tenant_id, client);
          if (result.state === 'CANCELLED' && !result.replayed) terminalized++;
        }
        return terminalized;
      });
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
  return service;
}
