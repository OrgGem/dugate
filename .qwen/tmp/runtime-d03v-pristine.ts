import { randomUUID } from 'node:crypto';
import {
  LEASE_DEFAULTS,
  contentHash,
  jobIdForDelivery,
  SpawnChildrenRequestSchema,
  WaitInputRequestSchema,
  type ClaimResult,
  type ExecutionSnapshot,
  type CheckpointRef,
  type ChildTaskSpec,
} from '@du/contracts';
import Ajv from 'ajv';
import type { PoolClient } from 'pg';
import type { Queue } from 'bullmq';
import { Db } from '../../db/db';
import { HttpError, conflict, gone, notFound, unprocessable, zodIssuesToProblem } from '../../http/errors';
import { maybeScheduleWebhook } from '../webhooks/webhooks';
import {
  MetadataCryptoError,
  type MetadataCrypto,
} from './metadata-crypto';

/**
 * Runtime surface for the worker SDK (docs 07, RUN-01..04).
 * Worker writes are fenced by authenticated business, current leaseEpoch,
 * RUNNING state, and a live lease expiry. Stale reports return 409 LEASE_LOST
 * and are never blind-retried. Ambiguous transport failures are surfaced so
 * the SDK ends the delivery for redelivery.
 */

/**
 * MM-05 (docs/38) — queue-integrity types. Candidates come from PG alone
 * (§2 predicate); the sweep confirms loss against BullMQ and re-arms the
 * ORIGINAL outbox row (§3). The health shape is the /health `queueIntegrity`
 * cache slot (§6).
 */
export interface QueueIntegrityCandidate {
  outbox_id: string;
  delivery_id: string;
  dispatched_at: Date;
  attempts: number;
  task_id: string;
  task_state: string;
  business_id: string;
  business_version: string;
  queue_name: string;
}

export interface QueueIntegritySweepResult {
  candidates: number;
  rearmed: number;
  aliveSkipped: number;
  casSkipped: number;
  stalled: number;
  unconfirmed: number;
  stalledDeliveryIds: string[];
}

export type QueueIntegrityState = 'OK' | 'RECONSTRUCTING' | 'SUSPECT';

export interface QueueIntegrityHealth {
  state: QueueIntegrityState;
  orphansLast: number;
  stalled: number;
  lastSweepAt: string;
}

/**
 * MM-05 orphan candidate predicate (docs/38 §2) — PG-only enumeration:
 * the newest task.dispatch delivery per task, stamped beyond the grace
 * window, task still unclaimed and leaseless, operation non-terminal.
 * Queue name resolves exactly like the dispatcher's fallback
 * (business_versions.queue, else du-business-<id>-<version>) so the sweep
 * reads the queue the dispatcher would have published to.
 */
const QUEUE_INTEGRITY_CANDIDATES_SQL = `
  SELECT c.outbox_id, c.delivery_id, c.dispatched_at, c.attempts,
         c.task_id, c.task_state, c.business_id, c.business_version,
         COALESCE(c.queue, 'du-business-' || c.business_id || '-' || c.business_version) AS queue_name
  FROM (
    SELECT DISTINCT ON (ob.aggregate_id)
           ob.id AS outbox_id, ob.delivery_id, ob.dispatched_at, ob.attempts,
           t.id AS task_id, t.state AS task_state,
           o.business_id, o.business_version, bv.queue
    FROM outbox ob
    JOIN tasks t       ON t.id = ob.aggregate_id
    JOIN operations o  ON o.id = t.operation_id
    LEFT JOIN business_versions bv
      ON bv.business_id = o.business_id AND bv.version = o.business_version
    WHERE ob.type = 'task.dispatch'
      AND ob.dispatched_at IS NOT NULL
      AND ob.dispatched_at < now() - ($1 * interval '1 ms')
      AND t.state IN ('READY','QUEUED')
      AND (t.lease_expires_at IS NULL OR t.lease_expires_at < now())
      AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
    ORDER BY ob.aggregate_id, ob.dispatched_at DESC
  ) c
  ORDER BY c.dispatched_at
  LIMIT $2`;

/**
 * Re-arm CAS (docs/38 §3 + packet R2-A guard): clears the dispatch stamp so
 * the UNCHANGED dispatcher republishes on its next cycle. The WHERE clause
 * is the fence — the millisecond-truncated equality on `dispatched_at`
 * (the value this sweep read) means a dispatcher/replica stamp that landed
 * after the read makes the UPDATE a no-op: a fresh stamp is NEVER
 * overwritten. WHY date_trunc('millisecond') on BOTH sides (Tester Round 7,
 * cycle 85): PostgreSQL timestamptz carries MICROsecond precision, the node
 * pg driver parses into JS Date which is MILLIsecond-only — a raw `= $2`
 * re-compare dropped the sub-millisecond residue and CAS-skipped every
 * otherwise-valid re-arm (rearmed=0). Truncating both sides matches the
 * precision the client can actually round-trip; the fence still rejects any
 * stamp from a later MILLISECOND. The row lock is held by this single
 * statement; the candidate read cannot carry FOR UPDATE because PG forbids
 * row locks through DISTINCT ON, so strictness lives on the write.
 * `attempts < $3` is the escalation cap (D1). Exponential due_at backoff
 * keeps a re-arm loop off the hot path. The EXISTS block re-verifies §2
 * eligibility AT WRITE TIME (Reviewer finding, W-PLAT-MM05-REARM-1): between
 * the candidate read and this UPDATE sits a BullMQ getJob round-trip, and a
 * cancel/terminal transition landing in that window must not be resurrected
 * — a cleared stamp would hand the dispatcher a READY-looking row for work
 * nobody wants anymore. The clause mirrors §2 exactly (task READY/QUEUED,
 * leaseless, operation non-terminal) so read-time and write-time eligibility
 * cannot diverge; it adds no bind parameters.
 */
const QUEUE_INTEGRITY_REARM_SQL = `
  UPDATE outbox
     SET dispatched_at = NULL,
         due_at = now() + (LEAST(power(2, attempts), 300) * interval '1 second'),
         claim_until = NULL,
         attempts = attempts + 1
   WHERE id = $1
     AND date_trunc('millisecond', dispatched_at) = date_trunc('millisecond', $2::timestamptz)
     AND dispatched_at IS NOT NULL
     AND attempts < $3
     AND EXISTS (
           SELECT 1
             FROM tasks t
             JOIN operations o ON o.id = t.operation_id
            WHERE t.id = outbox.aggregate_id
              AND t.state IN ('READY','QUEUED')
              AND (t.lease_expires_at IS NULL OR t.lease_expires_at < now())
              AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
         )
  RETURNING id`;

interface ActiveLeaseRow {
  lease_epoch: number;
  lease_active: boolean;
  state: string;
  business_id: string;
  /** ENC-META-01: tenant the operation belongs to; binds the metadata AAD. */
  tenant_id?: string;
}

function assertTaskBusiness(taskBusinessId: string, workerBusinessId?: string): void {
  if (workerBusinessId !== undefined && workerBusinessId !== taskBusinessId) {
    throw new HttpError(403, 'PERMISSION_DENIED', 'worker identity is not authorized for this business');
  }
}

function assertLeaseEpoch(task: Pick<ActiveLeaseRow, 'lease_epoch'>, leaseEpoch: number): void {
  if (task.lease_epoch !== leaseEpoch) throw conflict('LEASE_LOST', 'stale leaseEpoch');
}

function assertActiveLease(task: ActiveLeaseRow): void {
  if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(task.state)) {
    throw gone(`task is terminal ${task.state}`);
  }
  if (task.state !== 'RUNNING' || !task.lease_active) {
    throw conflict('LEASE_LOST', 'task lease is no longer active');
  }
}

/**
 * FR24-06: operation-level cancel signal while the task row is still RUNNING.
 * Task-level terminal states are deliberately NOT part of this check — they
 * belong to the MM-10b 410 TASK_TERMINAL contract in assertActiveLease, which
 * must keep winning for cancelled/finished tasks.
 */
function hasCancelSignal(row: { cancel_requested?: boolean; op_state?: string }): boolean {
  return (
    row.cancel_requested === true ||
    row.op_state === 'CANCEL_REQUESTED' ||
    row.op_state === 'CANCELLED'
  );
}

function leaseExpiresIso(value: Date | string | null): string {
  return new Date(value ?? Date.now()).toISOString();
}

/**
 * ENC-META-01: seal a control-plane value before it reaches a column.
 *
 * `metadataCrypto` is optional so the existing runtime callers (and every
 * suite that builds a fake db) keep working untouched; when it is absent the
 * value is stored exactly as before. That is a deliberate gap: the crypto is
 * opt-in per deployment, and the packet's inventory lists the columns so a
 * deployment can enable it slot by slot. `readStored` is the counterpart and
 * fails closed when a value is plaintext but crypto is on — a missing
 * encryption can never silently degrade into "read it anyway".
 */
async function sealMetadata(
  crypto: MetadataCrypto | undefined,
  value: unknown,
  context: { tenantId: string; slot: 'operations.input_ref' | 'tasks.payload_ref' | 'human_waits.response_ref' | 'step_checkpoints.output_ref'; refId: string },
): Promise<unknown> {
  if (!crypto) return value;
  return crypto.seal(value, context);
}

/** Open a stored control-plane value; plaintext tolerated only during the backfill window. */
async function openMetadata(
  crypto: MetadataCrypto | undefined,
  value: unknown,
  context: { tenantId: string; slot: 'operations.input_ref' | 'tasks.payload_ref' | 'human_waits.response_ref' | 'step_checkpoints.output_ref'; refId: string },
): Promise<unknown> {
  if (!crypto) return value;
  return crypto.readStored(value, context, true);
}

export function createRuntimeService(
  db: Db,
  queueAccess?: { getQueue: (name: string) => Queue },
  metadataCrypto?: MetadataCrypto,
) {
  const leaseMs = LEASE_DEFAULTS.leaseMs;
  const heartbeatMs = LEASE_DEFAULTS.heartbeatIntervalMs;
  const ajv = new Ajv({ allErrors: true, strict: false });
  let draining = false;

  const getActiveLeasesCount = async (): Promise<number> => {
    const res = await db.query<{ count: string | number }>(
      "SELECT count(*)::int as count FROM tasks WHERE state = 'RUNNING'"
    );
    return Number(res.rows[0]?.count ?? 0);
  };

  const drain = async (
    timeoutMs = 30000,
    pollIntervalMs = 500
  ): Promise<{ drained: boolean; remainingLeases: number }> => {
    draining = true;
    const deadline = Date.now() + timeoutMs;
    let remaining = await getActiveLeasesCount();
    if (remaining === 0) {
      return { drained: true, remainingLeases: 0 };
    }

    while (Date.now() < deadline) {
      const sleepMs = Math.min(pollIntervalMs, Math.max(10, deadline - Date.now()));
      await new Promise((resolve) => setTimeout(resolve, sleepMs));
      remaining = await getActiveLeasesCount();
      if (remaining === 0) {
        return { drained: true, remainingLeases: 0 };
      }
    }

    return { drained: false, remainingLeases: remaining };
  };

  return {
    async claimTask(
      taskId: string,
      deliveryId: string,
      workerInstanceId: string,
      workerBusinessId: string
    ): Promise<ClaimResult> {
      if (draining) {
        throw new HttpError(503, 'SHUTTING_DOWN', 'server is shutting down');
      }
      return db.tx(async (client) => {
        const taskRes = await client.query(
          `SELECT t.*, o.tenant_id, o.business_id, o.business_version, o.action,
                  o.input_ref, o.deadline_at, bv.digest as manifest_digest,
                  o.profile_id, o.profile_revision, o.connector_bindings,
                  o.cancel_requested AS op_cancel_requested, o.state AS op_state
           FROM tasks t
           JOIN operations o ON o.id = t.operation_id
           LEFT JOIN business_versions bv
             ON bv.business_id = o.business_id AND bv.version = o.business_version
           WHERE t.id = $1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!taskRes.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        const t = taskRes.rows[0] as Record<string, unknown>;

        // BR-12: business identity comes from the worker's own manifest, not
        // the queue payload. Reject before reading/exposing the execution
        // snapshot or mutating either the task lease or operation state.
        if (t.business_id !== workerBusinessId) {
          throw new HttpError(403, 'PERMISSION_DENIED', 'worker is not authorized for this business');
        }

        const terminalTask = ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.state as string);
        const terminalOp = ['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(
          (await client.query('SELECT state FROM operations WHERE id=$1', [t.operation_id])).rows[0]?.state as string
        );
        if (terminalTask || terminalOp) {
          throw gone(`task ${taskId} is terminal`);
        }

        // DATA-03: a URL-sourced operation sits in PENDING_INGESTION until the
        // ingestion consumer has fetched the bytes, pinned an immutable
        // version, materialized a READY artifact, and opened the gate. The
        // dispatcher already refuses to publish gate-ingestion rows, but that is
        // routing, not a boundary: any other path onto a business queue (a stale
        // redelivery, a manual re-stamp, a row written before the gate existed)
        // would hand a worker a task whose input has no bytes yet, and the
        // claim would take a real lease. Refuse HERE so "not runnable until
        // READY" holds at the claim boundary itself, not only in the happy path.
        if ((t.op_state as string) === 'PENDING_INGESTION') {
          throw conflict('STATE_CONFLICT', 'task is not runnable until its ingestion source is READY');
        }

        // Idempotent per (task, deliveryId): same delivery replayed → same lease.
        if (t.last_delivery_id === deliveryId) {
          return buildClaimResult(t, client, metadataCrypto);
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
        return buildClaimResult(t, client, metadataCrypto);
      });
    },

    async heartbeatTask(
      taskId: string,
      leaseEpoch: number,
      workerBusinessId?: string
    ): Promise<{ leaseExpiresAt: string; cancelRequested: boolean }> {
      return db.tx(async (client) => {
        const res = await client.query(
          `SELECT t.lease_epoch, t.lease_expires_at, t.state, o.cancel_requested, o.state AS op_state, o.business_id,
                  (t.lease_expires_at > clock_timestamp()) AS lease_active
           FROM tasks t JOIN operations o ON o.id = t.operation_id
           WHERE t.id=$1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        const row = res.rows[0] as ActiveLeaseRow & {
          cancel_requested: boolean;
          op_state: string;
          lease_expires_at: Date | string | null;
        };
        assertTaskBusiness(row.business_id, workerBusinessId);
        assertLeaseEpoch(row, leaseEpoch);
        assertActiveLease(row);

        // FR24-06 (W-PLAT-MM10-CANCEL-1): a cancel already visible on the
        // operation must not buy the worker another lease window. Refuse the
        // extension and answer 200 + cancelRequested=true — the SDK heartbeat
        // path acts on the flag (ctx.abort('cancel')); a 410 here would be
        // swallowed by its isLeaseLost-only catch and the handler would keep
        // running to its next fenced write.
        if (hasCancelSignal(row)) {
          return { leaseExpiresAt: leaseExpiresIso(row.lease_expires_at), cancelRequested: true };
        }

        // The lease extension is atomic with task state, current epoch, live
        // expiry, worker business, AND the operation cancel fence: the cancel
        // may land after the SELECT above (its own tx queues behind our
        // FOR UPDATE OF t on the task row, but touches operations first).
        // Re-checking at write time means a successful extension is a proof
        // the operation was not cancelling — so the ack below is never a
        // stale false.
        const upd = await client.query(
          `UPDATE tasks t SET lease_expires_at=clock_timestamp() + ($2 * interval '1 millisecond')
           FROM operations o
           WHERE t.id=$1 AND t.operation_id=o.id AND t.lease_epoch=$3
             AND t.state='RUNNING' AND t.lease_expires_at > clock_timestamp()
             AND ($4::text IS NULL OR o.business_id=$4)
             AND NOT o.cancel_requested AND o.state <> 'CANCEL_REQUESTED'
           RETURNING t.lease_expires_at`,
          [taskId, leaseMs, leaseEpoch, workerBusinessId ?? null]
        );
        if (!upd.rowCount) {
          const after = await client.query(
            `SELECT t.lease_expires_at, t.state, o.cancel_requested, o.state AS op_state
             FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE t.id=$1`,
            [taskId]
          );
          const a = after.rows[0] as ActiveLeaseRow & {
            cancel_requested: boolean;
            op_state: string;
            lease_expires_at: Date | string | null;
          } | undefined;
          if (a && hasCancelSignal(a)) {
            return { leaseExpiresAt: leaseExpiresIso(a.lease_expires_at), cancelRequested: true };
          }
          throw conflict('LEASE_LOST', 'task lease is no longer active');
        }
        const expiresAt = new Date((upd.rows[0] as { lease_expires_at: Date | string }).lease_expires_at).toISOString();
        return { leaseExpiresAt: expiresAt, cancelRequested: false };
      });
    },

    async saveStep(
      taskId: string,
      stepKey: string,
      body: { leaseEpoch: number; inputHash: string; outputRef: string; status: string },
      workerBusinessId?: string
    ): Promise<{ stepKey: string; generation: number; replayed: boolean }> {
      return db.tx(async (client) => {
        const taskRes = await client.query(
          `SELECT t.lease_epoch, t.state, o.tenant_id, o.business_id,
                  (t.lease_expires_at > clock_timestamp()) AS lease_active
           FROM tasks t JOIN operations o ON o.id=t.operation_id WHERE t.id=$1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!taskRes.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        const task = taskRes.rows[0] as ActiveLeaseRow;
        assertTaskBusiness(task.business_id, workerBusinessId);
        assertLeaseEpoch(task, body.leaseEpoch);
        assertActiveLease(task);
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
        // ENC-META-01: a checkpoint output_ref can name worker-produced content,
        // so it is sealed against the checkpoint row before the insert. The
        // inputHash stays plaintext: it is the replay fence the contract
        // already pins, and it is a digest, not tenant content.
        // A missing tenant_id is NOT defaulted to a real value: seal() rejects
        // an empty binding, so a row that somehow lost its tenant fails closed
        // instead of writing an envelope anyone could open.
        const sealedOutputRef = await sealMetadata(
          metadataCrypto,
          body.outputRef,
          { tenantId: task.tenant_id ?? '', slot: 'step_checkpoints.output_ref', refId: `${taskId}:${stepKey}` }
        );
        const inserted = await client.query(
          `INSERT INTO step_checkpoints (task_id, step_key, generation, input_hash, output_ref, status)
           SELECT $1,$2,$3,$4,$5,$6
           WHERE EXISTS (
             SELECT 1 FROM tasks t JOIN operations o ON o.id=t.operation_id
             WHERE t.id=$1 AND t.lease_epoch=$7 AND t.state='RUNNING'
               AND t.lease_expires_at > clock_timestamp()
               AND ($8::text IS NULL OR o.business_id=$8)
           )`,
          [taskId, stepKey, nextGen, body.inputHash, JSON.stringify(sealedOutputRef), body.status, body.leaseEpoch, workerBusinessId ?? null]
        );
        if (!inserted.rowCount) throw conflict('LEASE_LOST', 'task lease is no longer active');
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
      body: { leaseEpoch: number; resultRef: string; resultHash: string; outputArtifactIds?: unknown },
      workerBusinessId?: string
    ): Promise<{ taskId: string; state: string; operationState: string; replayed: boolean }> {
      if (contentHash(body.resultRef) !== body.resultHash) {
        throw new HttpError(422, 'INVALID_SCHEMA', 'resultHash does not match contentHash(resultRef)');
      }
      // CR-12: the completion payload may name output artifacts by id
      // (`outputArtifactIds`, contract schema `complete` extension). Every
      // named id must resolve to a READY artifact owned by this exact
      // (operation, task) pair inside the SAME tx — a stale/finalized/foreign
      // id 409s here instead of the result route projecting dangling refs.
      const outputIds = parseOutputArtifactIds(body);
      return db.tx(async (client) => {
        const tRes = await client.query(
          `SELECT t.lease_epoch, t.state, t.operation_id, o.business_id,
                  (t.lease_expires_at > clock_timestamp()) AS lease_active
           FROM tasks t JOIN operations o ON o.id=t.operation_id
           WHERE t.id=$1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!tRes.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        const t = tRes.rows[0] as ActiveLeaseRow & { operation_id: string };
        assertTaskBusiness(t.business_id, workerBusinessId);
        assertLeaseEpoch(t, body.leaseEpoch);
        if (t.state === 'CANCELLED') throw gone(`task ${taskId} is terminal ${t.state}`);
        if (t.state === 'SUCCEEDED') {
          const opState = (await client.query('SELECT state FROM operations WHERE id=$1', [t.operation_id])).rows[0]?.state as string;
          return { taskId, state: 'SUCCEEDED', operationState: opState, replayed: true };
        }
        if (['FAILED', 'TIMED_OUT'].includes(t.state)) throw gone(`task ${taskId} is terminal ${t.state}`);
        assertActiveLease(t);
        if (outputIds.length) {
          // CR-12 completion gate: every named output must be a READY
          // artifact of THIS (operation, task) pair. STAGING (bytes never
          // finalized) or foreign rows 409 — the holder finalizes first or
          // requests a grant under its own lease. Verified before any write.
          const rows = await client.query(
            `SELECT id, state FROM artifacts WHERE id = ANY($1) AND operation_id=$2 AND task_id=$3`,
            [outputIds, t.operation_id, taskId]
          );
          const byId = new Map((rows.rows as { id: string; state: string }[]).map((r) => [r.id, r.state]));
          for (const id of outputIds) {
            const state = byId.get(id);
            if (!state) throw conflict('ARTIFACT_NOT_READY', `output artifact ${id} does not belong to task ${taskId}`);
            if (state !== 'READY') throw conflict('ARTIFACT_NOT_READY', `output artifact ${id} is ${state}, not READY`);
          }
        }

        const completed = await client.query(
          `UPDATE tasks t SET state='SUCCEEDED', result_ref=$2, updated_at=now()
           FROM operations o
           WHERE t.id=$1 AND t.operation_id=o.id AND t.lease_epoch=$3
             AND t.state='RUNNING' AND t.lease_expires_at > clock_timestamp()
             AND ($4::text IS NULL OR o.business_id=$4)
           RETURNING t.id`,
          [taskId, body.resultRef, body.leaseEpoch, workerBusinessId ?? null]
        );
        if (!completed.rowCount) throw conflict('LEASE_LOST', 'task lease is no longer active');
        // Join reconciliation (RUN-05 all-success): when this task is a
        // child, check whether the parent join just completed and, if so,
        // emit exactly one parent continuation. A child completing into an
        // OPEN join must NOT mark the operation SUCCEEDED — remaining
        // siblings still own the join, so echo the stored operation state.
        const joinAck = await reconcileParentJoin(client, taskId, t.operation_id, metadataCrypto);
        if (joinAck) return joinAck;
        const depCheck = await client.query('SELECT 1 FROM task_dependencies WHERE child_id=$1', [taskId]);
        if (depCheck.rowCount) {
          const opState = (await client.query('SELECT state FROM operations WHERE id=$1', [t.operation_id])).rows[0]
            ?.state as string;
          return { taskId, state: 'SUCCEEDED', operationState: opState, replayed: false };
        }
        await client.query(
          `UPDATE operations SET state='SUCCEEDED', state_version = state_version + 1, result_ref=$2, updated_at=now() WHERE id=$1`,
          [t.operation_id, body.resultRef]
        );
        // P2-08: schedule the terminal webhook in the same tx (idempotent).
        await maybeScheduleWebhook(client, t.operation_id);
        return { taskId, state: 'SUCCEEDED', operationState: 'SUCCEEDED', replayed: false };
      });
    },

    async failTask(
      taskId: string,
      body: { leaseEpoch: number; errorCode: string; retryable: boolean; retryAfterMs?: number; detail?: string },
      workerBusinessId?: string
    ): Promise<{ taskId: string; state: string; operationState: string; replayed: boolean }> {
      return db.tx(async (client) => {
        const tRes = await client.query(
          `SELECT t.lease_epoch, t.lease_expires_at, t.state, t.operation_id, t.attempt, t.max_attempts, t.kind,
                  o.business_id, o.business_version, o.action, o.correlation_id,
                  (t.lease_expires_at > clock_timestamp()) AS lease_active
           FROM tasks t JOIN operations o ON o.id = t.operation_id
           WHERE t.id = $1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!tRes.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        const t = tRes.rows[0] as {
          lease_epoch: number;
          lease_active: boolean;
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
        assertTaskBusiness(t.business_id, workerBusinessId);
        assertLeaseEpoch(t, body.leaseEpoch);
        if (t.state === 'CANCELLED') throw gone(`task ${taskId} is terminal ${t.state}`);
        if (['SUCCEEDED', 'FAILED'].includes(t.state)) {
          const opState = (await client.query('SELECT state FROM operations WHERE id=$1', [t.operation_id])).rows[0]?.state as string;
          return { taskId, state: t.state, operationState: opState, replayed: true };
        }
        if (t.state === 'TIMED_OUT') throw gone(`task ${taskId} is terminal ${t.state}`);
        assertActiveLease(t);

        if (body.retryable && t.attempt < t.max_attempts) {
          const dueAt = new Date(Date.now() + (body.retryAfterMs ?? 5000)).toISOString();
          const failed = await client.query(
            `UPDATE tasks t SET state='RETRY_PENDING', error_code=$2, due_at=$3, updated_at=now()
             FROM operations o
             WHERE t.id=$1 AND t.operation_id=o.id AND t.lease_epoch=$4
               AND t.state='RUNNING' AND t.lease_expires_at > clock_timestamp()
               AND ($5::text IS NULL OR o.business_id=$5)
             RETURNING t.id`,
            [taskId, body.errorCode, dueAt, body.leaseEpoch, workerBusinessId ?? null]
          );
          if (!failed.rowCount) throw conflict('LEASE_LOST', 'task lease is no longer active');
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

        const failed = await client.query(
          `UPDATE tasks t SET state='FAILED', error_code=$2, updated_at=now()
           FROM operations o
           WHERE t.id=$1 AND t.operation_id=o.id AND t.lease_epoch=$3
             AND t.state='RUNNING' AND t.lease_expires_at > clock_timestamp()
             AND ($4::text IS NULL OR o.business_id=$4)
           RETURNING t.id`,
          [taskId, body.errorCode, body.leaseEpoch, workerBusinessId ?? null]
        );
        if (!failed.rowCount) throw conflict('LEASE_LOST', 'task lease is no longer active');
        // Join reconciliation (RUN-05 all-success): a terminal child
        // failure fails the parent join exactly once (siblings cancelled).
        const joinAck = await reconcileParentJoin(client, taskId, t.operation_id, metadataCrypto);
        if (joinAck) return joinAck;
        await client.query(
          `UPDATE operations SET state='FAILED', state_version = state_version + 1, error_code=$2, updated_at=now() WHERE id=$1`,
          [t.operation_id, body.errorCode]
        );
        // P2-08: schedule the terminal webhook in the same tx (idempotent).
        await maybeScheduleWebhook(client, t.operation_id);
        return { taskId, state: 'FAILED', operationState: 'FAILED', replayed: false };
      });
    },

    /**
     * Fan-out spawn (RUN-05, docs 07): one transaction writes durable child
     * tasks + task_dependencies rows + parent WAITING_CHILDREN + one outbox
     * dispatch row per child. Idempotency rides on (operation_id, task_key):
     * same key + same payloadHash replays, same key + different payloadHash
     * is a 409. The parent never emits jobs directly — only this tx does.
     */
    async spawnChildren(
      taskId: string,
      body: { leaseEpoch: number; children: ChildTaskSpec[]; joinPolicy: 'all-success'; continuationRef: string }
    ): Promise<{ childTaskIds: string[]; parentState: string }> {
      const parsed = SpawnChildrenRequestSchema.safeParse(body);
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      const req = parsed.data;
      return db.tx(async (client) => {
        const tRes = await client.query(
          `SELECT t.lease_epoch, t.state, t.operation_id, t.kind,
                  o.tenant_id, o.business_id, o.business_version, o.action, o.correlation_id
           FROM tasks t JOIN operations o ON o.id = t.operation_id
           WHERE t.id = $1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!tRes.rowCount) throw notFound(`task ${taskId} not found`);
        const t = tRes.rows[0] as {
          lease_epoch: number;
          state: string;
          operation_id: string;
          kind: string;
          tenant_id: string;
          business_id: string;
          business_version: string;
          action: string;
          correlation_id: string;
        };
        if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.state)) {
          throw gone(`task ${taskId} is terminal ${t.state}`);
        }
        if (t.lease_epoch !== req.leaseEpoch) throw conflict('LEASE_LOST', 'stale leaseEpoch');
        // Idempotency before the RUNNING gate (RUN-05): a retry of the exact
        // same spawn after the parent already entered WAITING_CHILDREN replays
        // the stored children; a conflicting payload for a known key is
        // INPUT_HASH_MISMATCH; a partial overlap is STATE_CONFLICT. Only
        // genuinely new children require the parent to still be RUNNING.
        const existingRes = await client.query(
          `SELECT id, task_key, payload_ref FROM tasks WHERE operation_id=$1 AND task_key = ANY($2)`,
          [t.operation_id, req.children.map((c) => c.taskKey)]
        );
        const existingByKey = new Map(
          (existingRes.rows as { id: string; task_key: string; payload_ref: Record<string, unknown> }[]).map((r) => [
            r.task_key,
            r,
          ])
        );
        if (existingByKey.size === req.children.length) {
          for (const c of req.children) {
            const row = existingByKey.get(c.taskKey)!;
            // ENC-META-01: payload_ref is sealed at rest, so the stored value
            // must be OPENED before it is hashed. Hashing the envelope would
            // compare a ciphertext against a plaintext digest and report a
            // false INPUT_HASH_MISMATCH on every legitimate retry — the
            // idempotency contract has to be measured on the same value the
            // client sent.
            const storedPayload = await openMetadata(metadataCrypto, row.payload_ref ?? {}, {
              tenantId: t.tenant_id as string,
              slot: 'tasks.payload_ref',
              refId: row.id as string,
            });
            if (contentHash(storedPayload) !== c.payloadHash) {
              throw conflict('INPUT_HASH_MISMATCH', `child ${c.taskKey} exists with a different payload`);
            }
          }
          const childIds = req.children.map((c) => existingByKey.get(c.taskKey)!.id);
          const parentState = (
            await client.query('SELECT state FROM tasks WHERE id=$1', [taskId])
          ).rows[0].state as string;
          return { childTaskIds: childIds, parentState };
        }
        if (existingByKey.size > 0) {
          throw conflict(
            'STATE_CONFLICT',
            `spawn partially overlaps existing children for task ${taskId}; retry with the full identical set`
          );
        }
        if (t.state !== 'RUNNING') {
          throw conflict('STATE_CONFLICT', `task ${taskId} is ${t.state}, not RUNNING`);
        }
        const manifestRes = await client.query(
          'SELECT manifest FROM business_versions WHERE business_id=$1 AND version=$2',
          [t.business_id, t.business_version]
        );
        if (!manifestRes.rowCount) throw notFound(`business ${t.business_id}@${t.business_version} not registered`);
        const manifest = manifestRes.rows[0] as {
          manifest: {
            runtime: { handlerKinds: string[] };
            actions: { name: string; defaultLimits?: { maxParallelTasks?: number } }[];
          };
        };
        for (const c of req.children) {
          if (!manifest.manifest.runtime.handlerKinds.includes(c.kind)) {
            throw unprocessable('UNREGISTERED_HANDLER', `child kind ${c.kind} is not a registered handler kind`);
          }
          if (contentHash(c.payloadRef) !== c.payloadHash) {
            throw unprocessable('INVALID_SCHEMA', `payloadHash mismatch for child ${c.taskKey}`);
          }
        }
        const dupKeys = new Set<string>();
        for (const c of req.children) {
          if (dupKeys.has(c.taskKey)) {
            throw unprocessable('INVALID_SCHEMA', `duplicate child taskKey ${c.taskKey} in one spawn`);
          }
          dupKeys.add(c.taskKey);
        }
        const actionDef = manifest.manifest.actions.find((a) => a.name === t.action);
        const maxParallel = actionDef?.defaultLimits?.maxParallelTasks ?? Number.MAX_SAFE_INTEGER;
        const runningRes = await client.query(
          `SELECT count(*)::int AS n FROM task_dependencies d JOIN tasks c ON c.id = d.child_id
           WHERE d.parent_id = $1 AND c.state IN ('READY','RUNNING','RETRY_PENDING')`,
          [taskId]
        );
        const running = (runningRes.rows[0] as { n: number }).n;
        if (running + req.children.length > maxParallel) {
          throw conflict(
            'CAPACITY',
            `spawn would exceed maxParallelTasks ${maxParallel} (${running} already running)`
          );
        }
        const childTaskIds: string[] = [];
        for (const c of req.children) {
          const childId = randomUUID();
          // ENC-META-01: child payload is tenant-supplied business data. Seal it
          // BEFORE the insert so the plaintext never lands in a row, and bind
          // the envelope to (tenant, slot, childId) so it cannot be replayed
          // onto a different child.
          const sealedChildPayload = await sealMetadata(metadataCrypto, c.payloadRef, {
            tenantId: t.tenant_id as string,
            slot: 'tasks.payload_ref',
            refId: childId,
          });
          await client.query(
            `INSERT INTO tasks (id, operation_id, parent_id, task_key, kind, payload_ref, state, attempt, due_at)
             VALUES ($1,$2,$3,$4,$5,$6,'READY',0, now())`,
            [childId, t.operation_id, taskId, c.taskKey, c.kind, JSON.stringify(sealedChildPayload)]
          );
          await client.query(
            `INSERT INTO task_dependencies (parent_id, child_id, join_policy) VALUES ($1,$2,$3)`,
            [taskId, childId, req.joinPolicy]
          );
          const deliveryId = `${childId}:spawn:${t.lease_epoch}`;
          await client.query(
            `INSERT INTO outbox (aggregate_id, type, delivery_id, payload)
             VALUES ($1,'task.dispatch',$2,$3)
             ON CONFLICT (delivery_id) DO NOTHING`,
            [
              childId,
              deliveryId,
              JSON.stringify({
                contractVersion: '1',
                deliveryId,
                taskId: childId,
                operationId: t.operation_id,
                businessId: t.business_id,
                businessVersion: t.business_version,
                action: t.action,
                kind: c.kind,
                correlationId: t.correlation_id,
              }),
            ]
          );
          childTaskIds.push(childId);
        }
        const continuedPayload = { continuationRef: req.continuationRef, joinPolicy: req.joinPolicy };
        const sealedParentPayload = await sealMetadata(metadataCrypto, continuedPayload, {
          tenantId: t.tenant_id as string,
          slot: 'tasks.payload_ref',
          refId: taskId,
        });
        await client.query(`UPDATE tasks SET state='WAITING_CHILDREN', payload_ref=$2, updated_at=now() WHERE id=$1`, [
          taskId,
          JSON.stringify(sealedParentPayload),
        ]);
        await client.query(
          `UPDATE operations SET state='WAITING_CHILDREN', state_version = state_version + 1, updated_at=now()
           WHERE id=$1 AND state IN ('RUNNING','QUEUED')`,
          [t.operation_id]
        );
        return { childTaskIds, parentState: 'WAITING_CHILDREN' };
      });
    },

    /**
     * Child status read for join observability: every child spawned by this
     * parent with terminal state/output. Read-only; no lease required.
     */
    async getChildren(taskId: string): Promise<{
      children: { taskId: string; taskKey: string; kind: string; state: string; resultRef: string | null; errorCode: string | null }[];
    }> {
      const parentRes = await db.query('SELECT id FROM tasks WHERE id=$1', [taskId]);
      if (!parentRes.rowCount) throw notFound(`task ${taskId} not found`);
      const res = await db.query(
        `SELECT c.id, c.task_key, c.kind, c.state, c.result_ref, c.error_code
         FROM task_dependencies d JOIN tasks c ON c.id = d.child_id
         WHERE d.parent_id = $1 ORDER BY c.created_at`,
        [taskId]
      );
      return {
        children: (
          res.rows as { id: string; task_key: string; kind: string; state: string; result_ref: string | null; error_code: string | null }[]
        ).map((r) => ({
          taskId: r.id,
          taskKey: r.task_key,
          kind: r.kind,
          state: r.state,
          resultRef: r.result_ref,
          errorCode: r.error_code,
        })),
      };
    },

    /**
     * Human wait open (RUN-06, docs 07): persists the wait schema BEFORE the
     * worker releases its slot. Exactly one OPEN wait per task (partial unique
     * index); a replay of the same waitKey returns the stored waitId, a
     * conflicting schema for the same key is a 409.
     */
    async waitInput(
      taskId: string,
      body: { leaseEpoch: number; waitKey: string; inputSchema: unknown; uiSchema?: unknown; contextRef?: string | null; expiresAt?: string }
    ): Promise<{ waitId: string; expiresAt: string }> {
      const parsed = WaitInputRequestSchema.safeParse(body);
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      const req = parsed.data;
      return db.tx(async (client) => {
        const tRes = await client.query(
          'SELECT lease_epoch, state, operation_id FROM tasks WHERE id=$1 FOR UPDATE',
          [taskId]
        );
        if (!tRes.rowCount) throw notFound(`task ${taskId} not found`);
        const t = tRes.rows[0] as { lease_epoch: number; state: string; operation_id: string };
        if (['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(t.state)) {
          throw gone(`task ${taskId} is terminal ${t.state}`);
        }
        if (t.lease_epoch !== req.leaseEpoch) throw conflict('LEASE_LOST', 'stale leaseEpoch');
        let schemaJson: string;
        try {
          schemaJson = JSON.stringify(req.inputSchema);
        } catch {
          throw unprocessable('INVALID_SCHEMA', 'inputSchema is not JSON-serializable');
        }
        // Idempotency before the RUNNING gate (RUN-06): replaying the same
        // (waitKey, inputSchema) after the task already entered WAITING_INPUT
        // returns the stored waitId; a conflicting schema for a known key is
        // INPUT_HASH_MISMATCH.
        const existingRes = await client.query(
          'SELECT wait_id, input_schema, expires_at, status FROM human_waits WHERE task_id=$1 AND wait_key=$2',
          [taskId, req.waitKey]
        );
        if (existingRes.rowCount) {
          const row = existingRes.rows[0] as { wait_id: string; input_schema: unknown; expires_at: Date; status: string };
          if (row.status !== 'OPEN') {
            throw conflict('STATE_CONFLICT', `wait ${req.waitKey} for task ${taskId} is ${row.status}, not OPEN`);
          }
          if (JSON.stringify(row.input_schema) !== schemaJson) {
            throw conflict('INPUT_HASH_MISMATCH', `wait ${req.waitKey} already opened with a different inputSchema`);
          }
          return { waitId: row.wait_id, expiresAt: new Date(row.expires_at).toISOString() };
        }
        if (t.state !== 'RUNNING') {
          throw conflict('STATE_CONFLICT', `task ${taskId} is ${t.state}, not RUNNING`);
        }
        const expiresAt = req.expiresAt ?? new Date(Date.now() + 24 * 3600 * 1000).toISOString();
        if (Number.isNaN(new Date(expiresAt).getTime())) {
          throw unprocessable('INVALID_SCHEMA', 'expiresAt is not a valid timestamp');
        }
        const waitId = `wait_${randomUUID()}`;
        try {
          await client.query(
            `INSERT INTO human_waits (operation_id, task_id, wait_key, wait_id, input_schema, ui_schema, context_ref, status, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6,$7,'OPEN',$8)`,
            [
              t.operation_id,
              taskId,
              req.waitKey,
              waitId,
              schemaJson,
              req.uiSchema === undefined ? null : JSON.stringify(req.uiSchema),
              req.contextRef ?? null,
              expiresAt,
            ]
          );
        } catch {
          const raced = await client.query(
            'SELECT wait_id, input_schema, expires_at, status FROM human_waits WHERE task_id=$1 AND status=$2',
            [taskId, 'OPEN']
          );
          const sameKey = (raced.rows as { wait_id: string; input_schema: unknown; expires_at: Date; status: string }[]).find(
            (r) => JSON.stringify(r.input_schema) === schemaJson && r.status === 'OPEN'
          );
          if (sameKey) {
            return { waitId: sameKey.wait_id, expiresAt: new Date(sameKey.expires_at).toISOString() };
          }
          throw conflict('STATE_CONFLICT', `task ${taskId} already has an open human wait`);
        }
        await client.query(`UPDATE tasks SET state='WAITING_INPUT', updated_at=now() WHERE id=$1`, [taskId]);
        await client.query(
          `UPDATE operations SET state='WAITING_INPUT', state_version = state_version + 1, updated_at=now()
           WHERE id=$1 AND state IN ('RUNNING','QUEUED')`,
          [t.operation_id]
        );
        return { waitId, expiresAt: new Date(expiresAt).toISOString() };
      });
    },

    /**
     * Tenant resume (RUN-06, docs 06): validates the input against the stored
     * wait schema, CAS-guards expectedStateVersion, marks the wait ANSWERED,
     * and re-queues the task via a fresh outbox delivery. Exactly one answer
     * wins; a replay of the same waitId returns the stored ack.
     */
    async resumeOperation(
      operationId: string,
      tenantId: string,
      body: { waitId: string; input: unknown; expectedStateVersion: number },
      activeClient?: PoolClient
    ): Promise<{ operationId: string; state: string; stateVersion: number; replayed: boolean; taskId: string }> {
      const b = body as { waitId?: unknown; input?: unknown; expectedStateVersion?: unknown };
      if (typeof b.waitId !== 'string' || !b.waitId || typeof b.expectedStateVersion !== 'number') {
        throw unprocessable('INVALID_SCHEMA', 'resume requires waitId, input, expectedStateVersion');
      }
      if (!('input' in (body as Record<string, unknown>))) {
        throw unprocessable('INVALID_SCHEMA', 'resume requires waitId, input, expectedStateVersion');
      }
      // Cycle-99 (reviewer): activeClient lets the admin dispatcher run the
      // resume inside ITS transaction, so operation state + wait + outbox +
      // audit commit (or roll back) as one unit. The tenant-fence 404s keep
      // the FIXED message (no id echo — X2 rule).
      const run = async (client: PoolClient): Promise<{ operationId: string; state: string; stateVersion: number; replayed: boolean; taskId: string }> => {
        const opRes = await client.query(
          'SELECT id, tenant_id, state, state_version FROM operations WHERE id=$1 FOR UPDATE',
          [operationId]
        );
        if (!opRes.rowCount) throw notFound('operation not found');
        const op = opRes.rows[0] as { tenant_id: string; state: string; state_version: number };
        if (op.tenant_id !== tenantId) throw notFound('operation not found');
        if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(op.state)) {
          throw conflict('STATE_CONFLICT', `operation ${operationId} is terminal ${op.state}`);
        }
        if (op.state_version !== b.expectedStateVersion) {
          throw conflict(
            'STATE_CONFLICT',
            `stale expectedStateVersion ${String(b.expectedStateVersion)}, current ${op.state_version}`
          );
        }
        const waitRes = await client.query(
          'SELECT id, task_id, wait_id, input_schema, status FROM human_waits WHERE operation_id=$1 AND wait_id=$2 FOR UPDATE',
          [operationId, b.waitId]
        );
        if (!waitRes.rowCount) throw notFound(`wait ${String(b.waitId)} not found for operation ${operationId}`);
        const wait = waitRes.rows[0] as {
          id: string;
          task_id: string;
          wait_id: string;
          input_schema: unknown;
          status: string;
        };
        if (wait.status === 'ANSWERED') {
          return {
            operationId,
            state: op.state,
            stateVersion: op.state_version,
            replayed: true,
            taskId: wait.task_id,
          };
        }
        if (wait.status !== 'OPEN') {
          throw conflict('STATE_CONFLICT', `wait ${wait.wait_id} is ${wait.status}, not OPEN`);
        }
        const validate = ajv.compile(
          (typeof wait.input_schema === 'object' && wait.input_schema !== null ? wait.input_schema : {}) as object
        );
        if (!validate(b.input)) {
          throw unprocessable('INVALID_SCHEMA', 'resume input failed wait inputSchema', {
            errors: (validate.errors ?? []).slice(0, 50).map((e) => ({
              pointer: e.instancePath || '/',
              message: e.message ?? 'invalid',
            })),
          });
        }
        // ENC-META-01: the HITL answer is the most tenant-sensitive value on
        // this path — it is user-supplied content that the operation later
        // reads back. Seal it against the WAIT row, then re-queue the task with
        // a sealed resumeInput so neither column keeps the answer in plaintext.
        const answeredPayload = await sealMetadata(
          metadataCrypto,
          { input: b.input, answeredAt: new Date().toISOString() },
          { tenantId: op.tenant_id, slot: 'human_waits.response_ref', refId: wait.wait_id },
        );
        await client.query(`UPDATE human_waits SET status='ANSWERED', response_ref=$2 WHERE id=$1`, [
          wait.id,
          JSON.stringify(answeredPayload),
        ]);
        const taskRes = await client.query(
          `SELECT t.id, t.state, o.business_id, o.business_version, o.action, o.correlation_id
           FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1 FOR UPDATE OF t`,
          [wait.task_id]
        );
        if (!taskRes.rowCount) throw notFound(`task ${wait.task_id} not found`);
        const wt = taskRes.rows[0] as {
          id: string;
          state: string;
          business_id: string;
          business_version: string;
          action: string;
          correlation_id: string;
        };
        if (wt.state !== 'WAITING_INPUT') {
          throw conflict('STATE_CONFLICT', `task ${wait.task_id} is ${wt.state}, not WAITING_INPUT`);
        }
        const deliveryId = `${wt.id}:resume:${op.state_version + 1}`;
        const sealedResumePayload = await sealMetadata(
          metadataCrypto,
          { resumeInput: b.input, waitId: wait.wait_id },
          { tenantId: op.tenant_id, slot: 'tasks.payload_ref', refId: wt.id },
        );
        await client.query(`UPDATE tasks SET state='QUEUED', payload_ref=$2, updated_at=now() WHERE id=$1`, [
          wt.id,
          JSON.stringify(sealedResumePayload),
        ]);
        await client.query(
          `INSERT INTO outbox (aggregate_id, type, delivery_id, payload)
           VALUES ($1,'task.dispatch',$2,$3)
           ON CONFLICT (delivery_id) DO NOTHING`,
          [
            wt.id,
            deliveryId,
            JSON.stringify({
              contractVersion: '1',
              deliveryId,
              taskId: wt.id,
              operationId,
              businessId: wt.business_id,
              businessVersion: wt.business_version,
              action: wt.action,
              kind: 'root',
              correlationId: wt.correlation_id,
            }),
          ]
        );
        const bumped = await client.query(
          `UPDATE operations SET state='QUEUED', state_version = state_version + 1, updated_at=now()
           WHERE id=$1 RETURNING state, state_version`,
          [operationId]
        );
        const next = bumped.rows[0] as { state: string; state_version: number };
        return { operationId, state: next.state, stateVersion: next.state_version, replayed: false, taskId: wt.id };
      };
      return activeClient ? run(activeClient) : db.tx(run);
    },

    /**
     * Expired-lease recovery (P2-09). Sweeps RUNNING tasks whose lease has
     * expired and re-dispatches them through the outbox so a crashed worker
     * (not merely idle/paused) is recovered without depending on a fresh
     * inbound delivery. Fencing: leases can only expire for a worker that is
     * no longer heartbeating; recovery bumps lease_epoch and clears the lease
     * so a late old worker's writes/heartbeat/complete are rejected with 409
     * LEASE_LOST and can never resurrect a lease out-of-band. Retry budget is
     * preserved: an expired task with budget left is re-queried; one past
     * max_attempts is terminally failed (jin reconciliation runs for a child).
     *
     * Guard rails:
     * - Only `state='RUNNING'` tasks are candidates (idle READY/QUEUED tasks
     *   hold no lease; WAITING_INPUT/WAITING_CHILDREN tasks set those states,
     *   not RUNNING, so they are excluded).
     * - Operations that are terminal (SUCCEEDED/FAILED/CANCELLED/TIMED_OUT)
     *   are excluded — we never revive work under a terminal operation.
     * - Idempotency rides on a stable per-(task, epoch) deliveryId: repeated
     *   and concurrent sweepers produce at most one dispatch row per recovery.
     * - `FOR UPDATE SKIP LOCKED` serializes concurrent sweepers per-row.
     */
    async sweepExpiredLeases(limit = 50): Promise<number> {
      return db.tx(async (client) => {
        const res = await client.query(
          `SELECT t.id, t.operation_id, t.attempt, t.max_attempts, t.lease_epoch, t.kind,
                  o.business_id, o.business_version, o.action, o.correlation_id
           FROM tasks t
           JOIN operations o ON o.id = t.operation_id
           WHERE t.state = 'RUNNING'
             AND t.lease_expires_at IS NOT NULL
             AND t.lease_expires_at < now()
             AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
           ORDER BY t.lease_expires_at
           LIMIT $1
           FOR UPDATE OF t SKIP LOCKED`,
          [limit]
        );
        let handled = 0;
        for (const row of res.rows as {
          id: string;
          operation_id: string;
          attempt: number;
          max_attempts: number;
          lease_epoch: number;
          kind: string;
          business_id: string;
          business_version: string;
          action: string;
          correlation_id: string;
        }[]) {
          const taskId = row.id;
          const operationId = row.operation_id;
          if (row.attempt < row.max_attempts) {
            // Re-dispatch: bump epoch to fence the old worker, clear the lease
            // so the recovered claim isn't treated as "leased elsewhere", and
            // emit one outbox dispatch row (stable id → dedup).
            const nextEpoch = row.lease_epoch + 1;
            const deliveryId = `${taskId}:recover:${nextEpoch}`;
            await client.query(
              `UPDATE tasks SET lease_epoch=$2, lease_expires_at=NULL, leased_by=NULL,
                      state='READY', updated_at=now()
               WHERE id=$1`,
              [taskId, nextEpoch]
            );
            await client.query(
              `INSERT INTO outbox (aggregate_id, type, delivery_id, payload)
               VALUES ($1,'task.dispatch',$2,$3)
               ON CONFLICT (delivery_id) DO NOTHING`,
              [
                taskId,
                deliveryId,
                JSON.stringify({
                  contractVersion: '1',
                  deliveryId,
                  taskId,
                  operationId,
                  businessId: row.business_id,
                  businessVersion: row.business_version,
                  action: row.action,
                  kind: row.kind,
                  correlationId: row.correlation_id,
                }),
              ]
            );
          } else {
            // Retry budget exhausted → terminal fail (mirrors failTask's
            // terminal path, including join reconciliation for a child).
            await client.query(
              `UPDATE tasks SET state='FAILED', error_code='LEASE_EXPIRED', updated_at=now() WHERE id=$1`,
              [taskId]
            );
            const joinAck = await reconcileParentJoin(client, taskId, operationId, metadataCrypto);
            if (joinAck) {
              handled++;
              continue;
            }
            await client.query(
              `UPDATE operations SET state='FAILED', state_version = state_version + 1,
                      error_code='LEASE_EXPIRED', updated_at=now()
               WHERE id=$1`,
              [operationId]
            );
            // P2-08: schedule the terminal webhook in the same tx.
            await maybeScheduleWebhook(client, operationId);
          }
          handled++;
        }
        return handled;
      });
    },

    /**
     * MM-05 queue-integrity sweep (docs/38). Redis can lose jobs that PG
     * already stamped as dispatched (Redis loss between publish and claim):
     * the dispatcher only selects `dispatched_at IS NULL` and
     * sweepExpiredLeases only covers RUNNING leases, so a READY/QUEUED
     * leaseless task would stay orphaned until the manual deadline sweep —
     * which is escape hatch, not recovery.
     *
     * For every candidate (§2) the ONLY loss proof is BullMQ itself:
     * `queue.getJob(jobIdForDelivery(...))` returning empty means the job
     * is gone; a live job (waiting/delayed/active/completed) is left alone
     * and converges on its own. A confirmed-lost row is re-armed via the
     * CAS UPDATE (never a new delivery row — no schema change, stable
     * jobId makes false-positive republish dedup at the queue layer).
     * Redis errors are NOT loss: the candidate is `unconfirmed`, never
     * re-armed on transport failure.
     *
     * Test seam parity with sweepExpiredLeases: production drives this off
     * the recoveryTimer; offline/live tests call it directly.
     */
    async sweepQueueIntegrity(
      opts: { graceMs?: number; limit?: number; maxAttempts?: number } = {}
    ): Promise<QueueIntegritySweepResult> {
      if (!queueAccess) {
        throw new Error('sweepQueueIntegrity requires queue access (createRuntimeService second argument)');
      }
      const graceMs = opts.graceMs ?? 30_000;
      const limit = opts.limit ?? 50;
      const maxAttempts = opts.maxAttempts ?? 10;

      const candRes = await db.query<QueueIntegrityCandidate>(QUEUE_INTEGRITY_CANDIDATES_SQL, [
        graceMs,
        limit,
      ]);
      const result: QueueIntegritySweepResult = {
        candidates: candRes.rows.length,
        rearmed: 0,
        aliveSkipped: 0,
        casSkipped: 0,
        stalled: 0,
        unconfirmed: 0,
        stalledDeliveryIds: [],
      };

      for (const c of candRes.rows) {
        if (c.attempts >= maxAttempts) {
          // D1: stop re-arming at the cap; escalation signal goes to health
          // (SUSPECT) and the ledger (queue.integrity_stalled) by the caller.
          result.stalled++;
          result.stalledDeliveryIds.push(c.delivery_id);
          continue;
        }
        let job: unknown;
        try {
          job = await queueAccess.getQueue(c.queue_name).getJob(jobIdForDelivery(c.delivery_id));
        } catch {
          result.unconfirmed++;
          continue;
        }
        if (job) {
          result.aliveSkipped++;
          continue;
        }
        const rearm = await db.query(QUEUE_INTEGRITY_REARM_SQL, [c.outbox_id, c.dispatched_at, maxAttempts]);
        if (rearm.rowCount) result.rearmed++;
        else result.casSkipped++;
      }
      return result;
    },

    async getOperation(operationId: string) {
      const res = await db.query('SELECT * FROM operations WHERE id=$1', [operationId]);
      if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `operation ${operationId} not found`);
      return res.rows[0] as Record<string, unknown>;
    },

    /**
     * R24-01: tenant-scoped operation read for the public P2 lookup path.
     * The `AND tenant_id=$2` filter makes a foreign id indistinguishable
     * from a missing one (prompt 404, no existence leak). The public
     * `GET /api/v1/operations/:id` route injects this into `waitForTerminal`
     * so BOTH the pre-poll read and every in-poll re-read are tenant-scoped:
     * an operation that changes hands mid-poll 404s on the next 500 ms
     * iteration instead of leaking state through the full wait.
     */
    async getTenantOperation(operationId: string, tenantId: string) {
      const res = await db.query('SELECT * FROM operations WHERE id=$1 AND tenant_id=$2', [operationId, tenantId]);
      if (!res.rowCount) throw new HttpError(404, 'NOT_FOUND', `operation ${operationId} not found`);
      return res.rows[0] as Record<string, unknown>;
    },

    /**
     * W47-C1: read-only ART-02 workspace-reference lookup for the SDK
     * sweeper (`hasActiveReference` hook). Counts ACTIVE holders under
     * one tenant: non-terminal tasks (their own state), tasks under
     * non-terminal operations, OPEN human waits. No writes — one tx,
     * three bounded COUNT queries. The caller passes its worker-local
     * workspace dir; the platform answers tenant presence (no
     * workspace-path column exists — storage_key is `art-<uuid>`).
     */
    async workspaceReferenceStatus(tenantId: string, businessId?: string): Promise<{ referenced: boolean; activeHolders: number }> {
      const res = await db.query<{ holders: string | number }>(
        `WITH active AS (
           SELECT t.id FROM tasks t
           JOIN operations o ON o.id = t.operation_id
           WHERE o.tenant_id = $1
             AND ($2::text IS NULL OR o.business_id = $2)
             AND t.state NOT IN ('SUCCEEDED','FAILED','CANCELLED')
             AND o.state NOT IN ('SUCCEEDED','FAILED','CANCELLED','TIMED_OUT')
           UNION
           SELECT w.task_id AS id FROM human_waits w
           JOIN tasks t ON t.id = w.task_id
           JOIN operations o ON o.id = t.operation_id
           WHERE o.tenant_id = $1 AND ($2::text IS NULL OR o.business_id = $2)
             AND w.status = 'OPEN'
         )
         SELECT count(*)::int AS holders FROM active`,
        [tenantId, businessId ?? null]
      );
      const activeHolders = Number(res.rows[0]?.holders ?? 0);
      return { referenced: activeHolders > 0, activeHolders };
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

    isDraining: () => draining,
    setDraining: (flag: boolean) => {
      draining = flag;
    },
    getActiveLeasesCount,
    drain,
  };
}

/**
 * Join reconciliation (RUN-05, v1 all-success). Called inside the child's
 * terminal tx AFTER the child row is terminal, holding the child lock.
 * Locks the parent row (FOR UPDATE) so concurrent child completions
 * serialize: exactly one of them emits the parent continuation.
 *
 * - All children SUCCEEDED → parent WAITING_CHILDREN → QUEUED with a single
 *   `task.continuation` outbox row (stable deliveryId → exactly-once
 *   enqueue); join summary merged into parent payload_ref.
 * - Any child FAILED/CANCELLED → parent FAILED with JOIN_FAILED, unfinished
 *   siblings CANCELLED, operation FAILED.
 * - Join still open → no-op (returns null; the child ack proceeds normally).
 * - Task is not a child (no dependency row) → null.
 */
type DbClient = {
  query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
};

async function reconcileParentJoin(
  client: DbClient,
  childTaskId: string,
  operationId: string,
  metadataCrypto?: MetadataCrypto,
): Promise<{ taskId: string; state: string; operationState: string; replayed: boolean } | null> {
  const depRes = await client.query('SELECT parent_id, join_policy FROM task_dependencies WHERE child_id=$1', [
    childTaskId,
  ]);
  if (!depRes.rowCount) return null;
  const parentId = (depRes.rows[0] as { parent_id: string }).parent_id;
  const parentRes = await client.query(
    `SELECT t.id, t.state, t.payload_ref, o.tenant_id, o.business_id, o.business_version, o.action, o.correlation_id
     FROM tasks t JOIN operations o ON o.id = t.operation_id
     WHERE t.id=$1 FOR UPDATE OF t`,
    [parentId]
  );
  if (!parentRes.rowCount) return null;
  const parent = parentRes.rows[0] as {
    id: string;
    state: string;
    payload_ref: Record<string, unknown>;
    tenant_id: string;
    business_id: string;
    business_version: string;
    action: string;
    correlation_id: string;
  };
  // Parent already reconciled (or left the wait some other way): the child
  // ack proceeds normally — no duplicate continuation.
  if (parent.state !== 'WAITING_CHILDREN') return null;
  const sibRes = await client.query(
    `SELECT c.id, c.task_key, c.state, c.result_ref, c.error_code
     FROM task_dependencies d JOIN tasks c ON c.id = d.child_id
     WHERE d.parent_id=$1`,
    [parentId]
  );
  const sibs = sibRes.rows as { id: string; task_key: string; state: string; result_ref: string | null; error_code: string | null }[];
  const failed = sibs.filter((s) => ['FAILED', 'CANCELLED'].includes(s.state));
  const open = sibs.filter((s) => !['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(s.state));
  if (failed.length > 0) {
    const first = failed[0]!;
    for (const s of open) {
      await client.query(`UPDATE tasks SET state='CANCELLED', updated_at=now() WHERE id=$1`, [s.id]);
    }
    await client.query(`UPDATE tasks SET state='FAILED', error_code='JOIN_FAILED', updated_at=now() WHERE id=$1`, [
      parentId,
    ]);
    await client.query(
      `UPDATE operations SET state='FAILED', state_version = state_version + 1, error_code='JOIN_FAILED', updated_at=now() WHERE id=$1`,
      [operationId]
    );
    // P2-08: schedule the terminal webhook in the same tx (idempotent).
    await maybeScheduleWebhook(client, operationId);
    return { taskId: childTaskId, state: failed[0]!.state, operationState: 'FAILED', replayed: false };
  }
  if (open.length > 0) return null;
  // All children SUCCEEDED: single continuation redelivery of the parent.
  const joinSummary: Record<string, string | null> = {};
  for (const s of sibs) joinSummary[s.task_key] = s.result_ref;
  // ENC-META-01: the parent payload is sealed, so it must be OPENED before the
  // join summary is merged back into it. Merging into the raw envelope would
  // nest one sealed blob inside another and the parent could never read it.
  const openParentPayload = (await openMetadata(metadataCrypto, parent.payload_ref ?? {}, {
    tenantId: parent.tenant_id,
    slot: 'tasks.payload_ref',
    refId: parentId,
  })) as Record<string, unknown>;
  const mergedPayload = { ...openParentPayload, joinSummary };
  const sealedMergedPayload = await sealMetadata(metadataCrypto, mergedPayload, {
    tenantId: parent.tenant_id,
    slot: 'tasks.payload_ref',
    refId: parentId,
  });
  const deliveryId = `${parentId}:join:${sibs.length}`;
  await client.query(`UPDATE tasks SET state='QUEUED', payload_ref=$2, updated_at=now() WHERE id=$1`, [
    parentId,
    JSON.stringify(sealedMergedPayload),
  ]);
  await client.query(
    `INSERT INTO outbox (aggregate_id, type, delivery_id, payload)
     VALUES ($1,'task.continuation',$2,$3)
     ON CONFLICT (delivery_id) DO NOTHING`,
    [
      parentId,
      deliveryId,
      JSON.stringify({
        contractVersion: '1',
        deliveryId,
        taskId: parentId,
        operationId,
        businessId: parent.business_id,
        businessVersion: parent.business_version,
        action: parent.action,
        kind: 'root',
        correlationId: parent.correlation_id,
      }),
    ]
  );
  await client.query(
    `UPDATE operations SET state='QUEUED', state_version = state_version + 1, updated_at=now()
     WHERE id=$1 AND state IN ('WAITING_CHILDREN','RUNNING','QUEUED')`,
    [operationId]
  );
  const opState = (
    await client.query('SELECT state FROM operations WHERE id=$1', [operationId])
  ).rows[0]?.state as string;
  return { taskId: childTaskId, state: 'SUCCEEDED', operationState: opState, replayed: false };
}

async function buildClaimResult(
  t: Record<string, unknown>,
  client: { query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }> },
  metadataCrypto?: MetadataCrypto,
): Promise<ClaimResult> {
  const checkpointsRes = await client.query('SELECT step_key as "stepKey", generation, input_hash as "inputHash", status, output_ref as "outputRef" FROM step_checkpoints WHERE task_id=$1', [
    t.id,
  ]);
  // ENC-META-01: a checkpoint output_ref is sealed at rest. The claim snapshot
  // must still carry the STRING the contract declares, so the envelope is
  // opened here — under the same tenant/row binding the checkpoint was sealed
  // with, and only after the business identity fence already ran above.
  const checkpointRefs: CheckpointRef[] = await Promise.all(
    (checkpointsRes.rows as CheckpointRef[]).map(async (r) => {
      const openedOutputRef =
        r.outputRef === undefined || r.outputRef === null
          ? undefined
          : await openMetadata(metadataCrypto, r.outputRef, {
              tenantId: t.tenant_id as string,
              slot: 'step_checkpoints.output_ref',
              refId: `${t.id as string}:${r.stepKey as string}`,
            });
      return {
        stepKey: r.stepKey,
        generation: r.generation,
        inputHash: r.inputHash,
        status: r.status as CheckpointRef['status'],
        outputRef: (openedOutputRef ?? r.outputRef ?? undefined) as string | undefined,
      };
    })
  );

  const snapshot: ExecutionSnapshot = {
    operationId: t.operation_id as string,
    tenantId: t.tenant_id as string,
    businessId: t.business_id as string,
    businessVersion: t.business_version as string,
    action: t.action as string,
    schemaDigest: 'sha256:slice',
    manifestDigest: (t.manifest_digest as string) ?? 'sha256:slice',
    // ENC-META-01: input_ref and payload_ref are sealed at rest. The claim
    // path is the ONLY place a worker learns them, so the tenant fence that
    // already ran above (business identity) plus the per-row AAD binding are
    // what make this a safe decrypt point: a payload_ref lifted from another
    // tenant fails with CONTEXT_MISMATCH rather than handing a worker foreign
    // input. openMetadata is fail-closed when the value is plaintext.
    resolvedInputRef: (await openMetadata(metadataCrypto, t.input_ref ?? {}, {
      tenantId: t.tenant_id as string,
      slot: 'operations.input_ref',
      refId: t.operation_id as string,
    })) as Record<string, unknown>,
    // P2-02/R08-02 (W13-C): the claim snapshot carries the PIN captured at
    // submit — never the live profile. Legacy operations (no pin) keep the
    // zero-value shape so the wire schema is unchanged.
    pinned: {
      profileRevision: (t.profile_revision as number) ?? 0,
      promptRevisions: {},
      connectorBindings: (t.connector_bindings as Record<string, string>) ?? {},
    },
    taskKey: t.task_key as string,
    kind: t.kind as string,
    payloadRef: (await openMetadata(metadataCrypto, t.payload_ref ?? {}, {
      tenantId: t.tenant_id as string,
      slot: 'tasks.payload_ref',
      refId: t.id as string,
    })) as Record<string, unknown>,
    deadlineAt: t.deadline_at ? new Date(t.deadline_at as string).toISOString() : null,
    // Δ4 (W-PLAT-CLAIM-CANCEL-FLAG-1): the snapshot must report the cancel state the
    // claim read actually observed, so a cooperative handler bails before doing work
    // instead of learning about the cancel on its first heartbeat. hasCancelSignal is
    // the SAME definition heartbeatTask uses, so the two channels cannot disagree.
    cancelRequested: hasCancelSignal({
      cancel_requested: Boolean(t.cancel_requested) || Boolean(t.op_cancel_requested),
      op_state: t.op_state as string | undefined,
    }),
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

/**
 * CR-12: normalize the completion-time output artifact ids.
 * `outputArtifactIds` is a local extension (the frozen complete body stays
 * leaseEpoch+resultRef+resultHash): an optional array of artifact-id UUIDs
 * the worker names as this task's execution-produced outputs. Non-array /
 * non-string entries are ignored (defensive: the gate above re-checks every
 * surviving id against READY rows, so junk can never widen the ref set).
 * Dedupes while preserving order; empty when absent.
 */
export function parseOutputArtifactIds(body: { outputArtifactIds?: unknown }): string[] {
  if (!Array.isArray(body.outputArtifactIds)) return [];
  const seen = new Set<string>();
  for (const v of body.outputArtifactIds) {
    if (typeof v !== 'string' || !v) continue;
    if (!seen.has(v)) seen.add(v);
  }
  return [...seen];
}
