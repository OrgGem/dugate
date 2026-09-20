import {
  LEASE_DEFAULTS,
  contentHash,
  type ClaimResult,
  type ExecutionSnapshot,
  type CheckpointRef,
} from '@du/contracts';
import { Db } from '../../db/db';
import { HttpError, conflict, gone } from '../../http/errors';

/**
 * Runtime surface for the worker SDK (docs 07, RUN-01..04).
 * All writes are fenced by leaseEpoch; stale reports are rejected with 409
 * LEASE_LOST and never blind-retried. Ambiguous transport failures are
 * surfaced so the SDK ends the delivery for redelivery.
 */

export function createRuntimeService(db: Db) {
  const leaseMs = LEASE_DEFAULTS.leaseMs;
  const heartbeatMs = LEASE_DEFAULTS.heartbeatIntervalMs;

  return {
    async claimTask(
      taskId: string,
      deliveryId: string,
      workerInstanceId: string
    ): Promise<ClaimResult> {
      return db.tx(async (client) => {
        const taskRes = await client.query(
          `SELECT t.*, o.tenant_id, o.business_id, o.business_version, o.action,
                  o.input_ref, o.deadline_at, bv.digest as manifest_digest
           FROM tasks t
           JOIN operations o ON o.id = t.operation_id
           LEFT JOIN business_versions bv
             ON bv.business_id = o.business_id AND bv.version = o.business_version
           WHERE t.id = $1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!taskRes.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        const t = taskRes.rows[0] as Record<string, unknown>;

        const terminalTask = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.state as string);
        const terminalOp = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(
          (await client.query('SELECT state FROM operations WHERE id=$1', [t.operation_id])).rows[0]?.state as string
        );
        if (terminalTask || terminalOp) {
          throw gone(`task ${taskId} is terminal`);
        }

        // Idempotent per (task, deliveryId): same delivery replayed → same lease.
        if (t.last_delivery_id === deliveryId) {
          return buildClaimResult(t, client);
        }

        // Leased elsewhere and not expired → busy.
        if (
          t.lease_expires_at &&
          new Date(t.lease_expires_at as string).getTime() > Date.now() &&
          (t.leased_by as string) !== workerInstanceId
        ) {
          throw conflict('STATE_CONFLICT', `task ${taskId} is leased by another worker`);
        }

        const nextEpoch = (t.lease_epoch as number) + 1;
        const expiresAt = new Date(Date.now() + leaseMs).toISOString();
        await client.query(
          `UPDATE tasks SET lease_epoch=$2, lease_expires_at=$3, leased_by=$4,
                  last_delivery_id=$5, state='RUNNING', attempt = attempt + 1, updated_at=now()
           WHERE id=$1`,
          [taskId, nextEpoch, expiresAt, workerInstanceId, deliveryId]
        );
        await client.query(
          `UPDATE operations SET state='RUNNING', state_version = state_version + 1, updated_at=now()
           WHERE id=$1 AND state IN ('ACCEPTED','QUEUED','WAITING_CHILDREN','WAITING_INPUT','RETRY_PENDING')`,
          [t.operation_id]
        );
        (t as Record<string, unknown>).lease_epoch = nextEpoch;
        (t as Record<string, unknown>).lease_expires_at = expiresAt;
        (t as Record<string, unknown>).leased_by = workerInstanceId;
        (t as Record<string, unknown>).attempt = (t.attempt as number) + 1;
        return buildClaimResult(t, client);
      });
    },

    async heartbeatTask(taskId: string, leaseEpoch: number): Promise<{ leaseExpiresAt: string; cancelRequested: boolean }> {
      const res = await db.query('SELECT lease_epoch, lease_expires_at FROM tasks WHERE id=$1', [taskId]);
      if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
      const row = res.rows[0] as { lease_epoch: number; lease_expires_at: string | null };
      if (row.lease_epoch !== leaseEpoch) {
        throw conflict('LEASE_LOST', `stale leaseEpoch ${leaseEpoch}, current ${row.lease_epoch}`);
      }
      const expiresAt = new Date(Date.now() + leaseMs).toISOString();
      await db.query('UPDATE tasks SET lease_expires_at=$2 WHERE id=$1', [taskId, expiresAt]);
      return { leaseExpiresAt: expiresAt, cancelRequested: false };
    },

    async saveStep(
      taskId: string,
      stepKey: string,
      body: { leaseEpoch: number; inputHash: string; outputRef: string; status: string }
    ): Promise<{ stepKey: string; generation: number; replayed: boolean }> {
      return db.tx(async (client) => {
        const taskRes = await client.query('SELECT lease_epoch FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
        if (!taskRes.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        if ((taskRes.rows[0] as { lease_epoch: number }).lease_epoch !== body.leaseEpoch) {
          throw conflict('LEASE_LOST', 'stale leaseEpoch');
        }
        const existing = await client.query(
          'SELECT generation, input_hash, status FROM step_checkpoints WHERE task_id=$1 AND step_key=$2 ORDER BY generation DESC LIMIT 1',
          [taskId, stepKey]
        );
        if (existing.rowCount) {
          const last = existing.rows[0] as { generation: number; input_hash: string; status: string };
          if (last.status === 'SUCCEEDED') {
            if (last.input_hash !== body.inputHash) {
              throw conflict('INPUT_HASH_MISMATCH', `checkpoint ${stepKey} has a different inputHash`);
            }
            return { stepKey, generation: last.generation, replayed: true };
          }
        }
        const nextGen = existing.rowCount ? (existing.rows[0] as { generation: number }).generation + 1 : 1;
        await client.query(
          `INSERT INTO step_checkpoints (task_id, step_key, generation, input_hash, output_ref, status)
           VALUES ($1,$2,$3,$4,$5,$6)`,
          [taskId, stepKey, nextGen, body.inputHash, body.outputRef, body.status]
        );
        return { stepKey, generation: nextGen, replayed: false };
      });
    },

    async reportProgress(taskId: string, body: { leaseEpoch: number; percent: number; message?: string }): Promise<void> {
      const res = await db.query('SELECT lease_epoch FROM tasks WHERE id=$1', [taskId]);
      if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
      if ((res.rows[0] as { lease_epoch: number }).lease_epoch !== body.leaseEpoch) {
        throw conflict('LEASE_LOST', 'stale leaseEpoch');
      }
      // Slice: coalesced — update operation progress only. Real impl throttles.
      const opRes = await db.query('SELECT id FROM tasks WHERE id=$1', [taskId]);
      void opRes;
    },

    async completeTask(
      taskId: string,
      body: { leaseEpoch: number; resultRef: string; resultHash: string }
    ): Promise<{ taskId: string; state: string; operationState: string; replayed: boolean }> {
      if (contentHash(body.resultRef) !== body.resultHash) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'resultHash does not match contentHash(resultRef)');
      }
      return db.tx(async (client) => {
        const tRes = await client.query('SELECT lease_epoch, state, operation_id FROM tasks WHERE id=$1 FOR UPDATE', [taskId]);
        if (!tRes.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        const t = tRes.rows[0] as { lease_epoch: number; state: string; operation_id: string };
        if (t.state === 'SUCCEEDED') {
          const opState = (await client.query('SELECT state FROM operations WHERE id=$1', [t.operation_id])).rows[0]?.state as string;
          return { taskId, state: 'SUCCEEDED', operationState: opState, replayed: true };
        }
        if (['FAILED', 'CANCELLED'].includes(t.state)) throw gone(`task ${taskId} is terminal ${t.state}`);
        if (t.lease_epoch !== body.leaseEpoch) throw conflict('LEASE_LOST', 'stale leaseEpoch');

        await client.query(
          `UPDATE tasks SET state='SUCCEEDED', result_ref=$2, updated_at=now() WHERE id=$1`,
          [taskId, body.resultRef]
        );
        await client.query(
          `UPDATE operations SET state='SUCCEEDED', state_version = state_version + 1, result_ref=$2, updated_at=now() WHERE id=$1`,
          [t.operation_id, body.resultRef]
        );
        return { taskId, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false };
      });
    },

    async failTask(
      taskId: string,
      body: { leaseEpoch: number; errorCode: string; retryable: boolean; retryAfterMs?: number; detail?: string }
    ): Promise<{ taskId: string; state: string; operationState: string; replayed: boolean }> {
      return db.tx(async (client) => {
        const tRes = await client.query(
          `SELECT t.lease_epoch, t.state, t.operation_id, t.attempt, t.max_attempts, t.kind,
                  o.business_id, o.business_version, o.action, o.correlation_id
           FROM tasks t JOIN operations o ON o.id = t.operation_id
           WHERE t.id = $1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!tRes.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        const t = tRes.rows[0] as {
          lease_epoch: number;
          state: string;
          operation_id: string;
          attempt: number;
          max_attempts: number;
          kind: string;
          business_id: string;
          business_version: string;
          action: string;
          correlation_id: string;
        };
        if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.state)) {
          const opState = (await client.query('SELECT state FROM operations WHERE id=$1', [t.operation_id])).rows[0]?.state as string;
          return { taskId, state: t.state, operationState: opState, replayed: true };
        }
        if (t.lease_epoch !== body.leaseEpoch) throw conflict('LEASE_LOST', 'stale leaseEpoch');

        if (body.retryable && t.attempt < t.max_attempts) {
          const dueAt = new Date(Date.now() + (body.retryAfterMs ?? 5000)).toISOString();
          await client.query(
            `UPDATE tasks SET state='RETRY_PENDING', error_code=$2, due_at=$3, updated_at=now() WHERE id=$1`,
            [taskId, body.errorCode, dueAt]
          );
          await client.query(
            `UPDATE operations SET state='RETRY_PENDING', state_version = state_version + 1, error_code=$2, updated_at=now() WHERE id=$1`,
            [t.operation_id, body.errorCode]
          );
          // Outbox continuation for retry. Payload is a full BusinessJobV1 so the
          // SDK's strict parse accepts the redelivery (docs 09 wire contract).
          const deliveryId = `${taskId}:retry:${t.attempt + 1}`;
          await client.query(
            `INSERT INTO outbox (aggregate_id, type, delivery_id, payload, due_at)
             VALUES ($1,'task.dispatch',$2,$3,$4)
             ON CONFLICT (delivery_id) DO NOTHING`,
            [
              taskId,
              deliveryId,
              JSON.stringify({
                contractVersion: '1',
                deliveryId,
                taskId,
                operationId: t.operation_id,
                businessId: t.business_id,
                businessVersion: t.business_version,
                action: t.action,
                kind: t.kind,
                correlationId: t.correlation_id,
              }),
              dueAt,
            ]
          );
          return { taskId, state: 'RETRY_PENDING', operationState: 'RETRY_PENDING', replayed: false };
        }

        await client.query(`UPDATE tasks SET state='FAILED', error_code=$2, updated_at=now() WHERE id=$1`, [
          taskId,
          body.errorCode,
        ]);
        await client.query(
          `UPDATE operations SET state='FAILED', state_version = state_version + 1, error_code=$2, updated_at=now() WHERE id=$1`,
          [t.operation_id, body.errorCode]
        );
        return { taskId, state: 'FAILED', operationState: 'FAILED', replayed: false };
      });
    },

    async getOperation(operationId: string) {
      const res = await db.query('SELECT * FROM operations WHERE id=$1', [operationId]);
      if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `operation ${operationId} not found`);
      return res.rows[0] as Record<string, unknown>;
    },

    async listOperations(tenantId: string, limit: number, cursor?: string) {
      const res = await db.query(
        `SELECT * FROM operations WHERE tenant_id=$1
         ${cursor ? 'AND created_at < (SELECT created_at FROM operations WHERE id=$2)' : ''}
         ORDER BY created_at DESC LIMIT $${cursor ? 3 : 2}`,
        cursor ? [tenantId, cursor, limit] : [tenantId, limit]
      );
      return res.rows as Record<string, unknown>[];
    },
  };
}

async function buildClaimResult(
  t: Record<string, unknown>,
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> }
): Promise<ClaimResult> {
  const checkpointsRes = await client.query('SELECT step_key as "stepKey", generation, input_hash as "inputHash", status, output_ref as "outputRef" FROM step_checkpoints WHERE task_id=$1', [
    t.id,
  ]);
  const checkpointRefs: CheckpointRef[] = (checkpointsRes.rows as CheckpointRef[]).map((r) => ({
    stepKey: r.stepKey,
    generation: r.generation,
    inputHash: r.inputHash,
    status: r.status as CheckpointRef['status'],
    outputRef: r.outputRef ?? undefined,
  }));

  const snapshot: ExecutionSnapshot = {
    operationId: t.operation_id as string,
    tenantId: t.tenant_id as string,
    businessId: t.business_id as string,
    businessVersion: t.business_version as string,
    action: t.action as string,
    schemaDigest: 'sha256:slice',
    manifestDigest: (t.manifest_digest as string) ?? 'sha256:slice',
    resolvedInputRef: (t.input_ref as Record<string, unknown>) ?? {},
    pinned: { profileRevision: 1, promptRevisions: {}, connectorBindings: {} },
    taskKey: t.task_key as string,
    kind: t.kind as string,
    payloadRef: (t.payload_ref as Record<string, unknown>) ?? {},
    deadlineAt: t.deadline_at ? new Date(t.deadline_at as string).toISOString() : null,
    cancelRequested: false,
  };

  return {
    taskId: t.id as string,
    operationId: t.operation_id as string,
    leaseEpoch: t.lease_epoch as number,
    leaseExpiresAt: t.lease_expires_at as string,
    attempt: t.attempt as number,
    deadlineAt: t.deadline_at ? new Date(t.deadline_at as string).toISOString() : null,
    executionSnapshot: snapshot,
    checkpointRefs,
  };
}
