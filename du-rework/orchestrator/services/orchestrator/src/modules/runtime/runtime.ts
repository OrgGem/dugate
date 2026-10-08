import { createHash, randomUUID } from 'node:crypto';
import {
  LEASE_DEFAULTS,
  contentHash,
  jobIdForDelivery,
  SaveStepRequestSchema,
  ProgressReportSchema,
  SpawnChildrenRequestSchema,
  WaitInputRequestSchema,
  type ClaimResult,
  type ExecutionSnapshot,
  type CheckpointRef,
  type ChildTaskSpec,
  PinnedProfilePolicySchema,
  PinnedPromptOverrideSchema,
  type PinnedPromptOverride,
} from '@du/contracts';
import Ajv from 'ajv';
import type { PoolClient } from 'pg';
import type { Queue } from 'bullmq';
import { Db } from '../../db/db';
import { HttpError, conflict, gone, notFound, unprocessable, zodIssuesToProblem } from '../../http/errors';
import { maybeScheduleWebhook } from '../webhooks/webhooks';
import {
  MetadataCryptoError,
  assertReadableWithoutSeam,
  readStoredText,
  type MetadataCrypto,
} from './metadata-crypto';
import {
  compatibilityMetadataReader,
  isMetadataReader,
  type MetadataReader,
} from '../encryption/metadata-read-policy';

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

/**
 * T-SUB-04 — parse `operations.profile_policy_snapshot` into the claim
 * snapshot's `pinned.profilePolicy`.
 *
 * NULL in, NULL out: a legacy-mode or pre-0026 operation has no policy, and
 * that is NOT the same as an empty one. A value that is present but does not
 * match the shape is a corrupt admission record and fails closed — the claim
 * refuses rather than handing the worker a policy it could not read, because
 * silently running with defaults is the failure mode PRF-02 exists to prevent.
 *
 * P730-W2-B-01 // W2B-P2-FIX — shape alone is not enough: a structurally valid
 * credentialRef naming a DIFFERENT (tenant, profile, revision) than the one the
 * operation row pins would send an acquisition consumer to another identity's
 * ciphertext while the claim looked clean. The ref tuple is compared with the
 * operation's pinned identity HERE, inside the claim transaction, so the throw
 * rolls the lease and state writes back with it (qwen_4, 2026-10-04).
 */
function parsePinnedProfilePolicy(
  raw: unknown,
  identity: { tenantId: string; profileId: unknown; profileRevision: unknown }
): ExecutionSnapshot['pinned']['profilePolicy'] {
  if (raw === null || raw === undefined) return null;
  const parsed = PinnedProfilePolicySchema.safeParse(raw);
  if (!parsed.success) {
    throw unprocessable(
      'INVALID_SCHEMA',
      'operation profile_policy_snapshot does not match the pinned policy shape',
      {
        errors: parsed.error.issues.slice(0, 50).map((i) => ({
          pointer: '/profile_policy_snapshot/' + i.path.join('/'),
          message: i.message,
        })),
      }
    );
  }
  const ref = parsed.data.credentialRef;
  if (
    ref.tenantId !== identity.tenantId ||
    ref.profileId !== identity.profileId ||
    ref.profileRevision !== identity.profileRevision
  ) {
    // Same status+code family as the shape failure on purpose: a mismatch is a
    // corrupt admission record, not a lease conflict. Static message, no values
    // on the wire — the coordinates stay in the operator's row.
    throw unprocessable(
      'INVALID_SCHEMA',
      'operation profile_policy_snapshot credentialRef does not match the OPERATION pinned identity',
      {
        errors: [{ pointer: '/profile_policy_snapshot/credentialRef', message: 'does not match the OPERATION pinned identity' }],
      }
    );
  }
  return parsed.data;
}

/**
 * P745-PRODUCER (step 1): map the submit-time `prompt_revisions_pin` into the
 * claim's `promptRevisions`.
 *
 * NULL (legacy-mode or pre-0030 operation) → `{}` — the historical zero-value
 * wire shape. A value that is present but does not match the marker shape is a
 * corrupt admission record and fails closed: handing a worker a half-read pin
 * would make the prompt precedence depend on parsing luck.
 *
 * Map key is `${connectionId}::${stepId}` (composite, ALWAYS — a `_default`
 * step keeps `connectionId::_default`), so two connections with the same step
 * id can never collide into one revision.
 */
export function parsePromptRevisionsPin(raw: unknown): Record<string, string> {
  if (raw === null || raw === undefined) return {};
  function fail(message: string): never {
    throw unprocessable('INVALID_SCHEMA', message, {
      errors: [{ pointer: '/prompt_revisions_pin', message }],
    });
  }
  if (!Array.isArray(raw)) {
    fail('operation prompt_revisions_pin is not an array');
  }
  const out: Record<string, string> = {};
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      fail('operation prompt_revisions_pin carries a non-object marker');
    }
    const marker = entry as Record<string, unknown>;
    const connectionId = marker['connectionId'];
    const stepId = marker['stepId'];
    const revision = marker['revision'];
    if (
      typeof connectionId !== 'string' || connectionId.length === 0 ||
      typeof stepId !== 'string' || stepId.length === 0 ||
      typeof revision !== 'string' || !/^sha256:[0-9a-f]{64}$/.test(revision)
    ) {
      fail('operation prompt_revisions_pin marker is not a valid (connectionId, stepId, sha256) tuple');
    }
    const key = `${connectionId}::${stepId}`;
    if (Object.prototype.hasOwnProperty.call(out, key)) {
      fail('operation prompt_revisions_pin declares the same step twice');
    }
    out[key] = revision;
  }
  return out;
}

/**
 * P745-CARRIER-IMPL-A (Δ-PC-1): open the sealed prompt-content carrier for a
 * claim, and cross-check it against the marker pin.
 *
 * NULL → `null` (legacy operation, no-seam deployment per adjudication 1c, or
 * an empty bucket) — never `[]`, which would be a different answer. A present
 * value MUST be a sealed envelope under the carrier slot: with crypto
 * configured but the value not an envelope, or with no crypto configured at
 * all, the claim refuses rather than guessing.
 *
 * Cross-check (adjudication 1b): the opened rows and the
 * `prompt_revisions_pin` markers are two views of ONE admission-time list, so
 * the claim requires an exact equality — same row count, no duplicate
 * `connectionId::stepId`, every row's revision identical to its marker, and
 * every revision reproducing from its own content. Any drift is a corrupt
 * admission record and fails closed as INVALID_SCHEMA before a snapshot is
 * handed out.
 *
 * Bounds (CAPFIX / IMPL-REVIEW-A gap 1): the producer's carrier caps (64 rows
 * / 16 KiB per row / 256 KiB total) are enforced HERE too, BEFORE the hash
 * cross-check — the untrusted payload is measured first, so an oversized
 * carrier always reports the SAME deterministic code the producer uses,
 * `PROMPT_CARRIER_TOO_LARGE` (422), rather than being masked by a drift error.
 * The single-bucket invariant is unchanged: this function still reconciles
 * exactly ONE opened carrier against its markers.
 *
 * Crypto-layer failures (tampered tag/ciphertext, wrong key, cross-slot or
 * cross-tenant replay) propagate as MetadataCryptoError — key/record faults,
 * not parse faults; the claim transaction rolls back either way.
 */

/**
 * Claim-side twin of `submission.ts` PROMPT_CARRIER_LIMITS (CAPFIX). Deliberate
 * duplication, same rationale the sealing helper documents above: importing
 * the producer module here would drag the whole submit stack (Ajv, registry,
 * profiles) into every runtime consumer. Both sides are pinned by tests —
 * keep the numbers and the utf8 byte measure identical.
 */
const PROMPT_CARRIER_LIMITS_CLAIM = {
  maxRows: 64,
  maxRowBytes: 16 * 1024,
  maxTotalBytes: 256 * 1024,
} as const;

async function openPromptCarrier(
  crypto: MetadataCrypto | undefined,
  raw: unknown,
  markerRaw: unknown,
  coords: { tenantId: string; operationId: string }
): Promise<PinnedPromptOverride[] | null> {
  if (raw === null || raw === undefined) return null;
  function fail(message: string): never {
    throw unprocessable('INVALID_SCHEMA', message, {
      errors: [{ pointer: '/prompt_overrides_ref', message }],
    });
  }
  if (!crypto) {
    fail('operation prompt_overrides_ref is present but metadata encryption is not configured');
  }
  const opened = await crypto.readStored(
    raw,
    { tenantId: coords.tenantId, slot: 'operations.prompt_overrides_ref', refId: coords.operationId },
    false
  );
  const parsed = PinnedPromptOverrideSchema.array().safeParse(opened);
  if (!parsed.success) {
    throw unprocessable('INVALID_SCHEMA', 'operation prompt_overrides_ref does not match the pinned carrier shape', {
      errors: parsed.error.issues.slice(0, 50).map((i) => ({
        pointer: '/prompt_overrides_ref/' + i.path.join('/'),
        message: i.message,
      })),
    });
  }
  const rows = parsed.data;
  // CAPFIX (IMPL-REVIEW-A gap 1): enforce the producer's caps here as well —
  // first, before any per-row hashing or marker comparison. An oversized row
  // (a bypassed writer, corruption, or a pre-cap row) fails closed with the
  // producer's own deterministic code; redelivery cannot shrink a stored row,
  // so the escalation is permanent.
  if (rows.length > PROMPT_CARRIER_LIMITS_CLAIM.maxRows) {
    throw unprocessable(
      'PROMPT_CARRIER_TOO_LARGE',
      `prompt override carrier exceeds ${PROMPT_CARRIER_LIMITS_CLAIM.maxRows} rows`
    );
  }
  let totalBytes = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(row.promptOverride, 'utf8');
    if (bytes > PROMPT_CARRIER_LIMITS_CLAIM.maxRowBytes) {
      throw unprocessable(
        'PROMPT_CARRIER_TOO_LARGE',
        `a prompt override exceeds ${PROMPT_CARRIER_LIMITS_CLAIM.maxRowBytes} bytes`
      );
    }
    totalBytes += bytes;
  }
  if (totalBytes > PROMPT_CARRIER_LIMITS_CLAIM.maxTotalBytes) {
    throw unprocessable(
      'PROMPT_CARRIER_TOO_LARGE',
      `prompt override carrier exceeds ${PROMPT_CARRIER_LIMITS_CLAIM.maxTotalBytes} bytes in total`
    );
  }
  const markers = parsePromptRevisionsPin(markerRaw);
  const markerKeys = Object.keys(markers);
  if (rows.length !== markerKeys.length) {
    fail('operation prompt_overrides_ref and prompt_revisions_pin disagree on row count');
  }
  const seen = new Set<string>();
  for (const row of rows) {
    const key = `${row.connectionId}::${row.stepId}`;
    if (seen.has(key)) {
      fail('operation prompt_overrides_ref declares the same step twice');
    }
    seen.add(key);
    const recomputed =
      'sha256:' +
      createHash('sha256').update(`${row.connectionId}|${row.stepId}|${row.promptOverride}`).digest('hex');
    if (recomputed !== row.revision || markers[key] !== row.revision) {
      fail('operation prompt_overrides_ref revision does not match its marker or its content');
    }
  }
  return rows;
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
  context: { tenantId: string; slot: 'operations.input_ref' | 'tasks.payload_ref' | 'human_waits.response_ref' | 'step_checkpoints.output_ref' | 'step_checkpoints.session_ref' | 'operations.prompt_overrides_ref' | 'tasks.result_ref' | 'operations.result_ref'; refId: string },
): Promise<unknown> {
  if (!crypto) return value;
  return crypto.seal(value, context);
}

/**
 * Open a stored control-plane value; plaintext tolerated only while the
 * boot-built read policy says the legacy lane is open.
 *
 * BA-01: TEXT columns (`step_checkpoints.output_ref`, `tasks.result_ref`,
 * `operations.result_ref`) hold a JSON *string*, and `readStored` treats any
 * string as unsealed — returning it verbatim WITHOUT an AEAD open. So a valid
 * envelope and a tampered one were equally readable as raw JSON text. Strings
 * are routed through the reader's text path, which parses the envelope and
 * opens it for real on this context's binding; the object path keeps handling
 * the parsed jsonb slots.
 *
 * CONTROL-PLANE-IMPL-818: the `allowPlaintext` boolean is GONE from this
 * signature. It used to be a literal `true` here — the ENC-09 window was
 * implicit and uncontrollable. The decision now comes from the injected
 * `MetadataReader` (built once at boot from `DU_METADATA_PLAINTEXT_READ_MODE`);
 * a caller that supplies only a seam gets the bounded compatibility reader, so
 * no path can spell the literal itself.
 */
/** Exported so the BA-01 text-envelope decode is directly testable. */
export async function openMetadata(
  seam: MetadataCrypto | MetadataReader | undefined,
  value: unknown,
  context: { tenantId: string; slot: 'operations.input_ref' | 'tasks.payload_ref' | 'human_waits.response_ref' | 'step_checkpoints.output_ref' | 'step_checkpoints.session_ref' | 'operations.prompt_overrides_ref' | 'tasks.result_ref' | 'operations.result_ref'; refId: string },
): Promise<unknown> {
  // WRAPPER-FIX-812 (A15): the no-seam decision lives in ONE function, shared
  // with the reader below. A sealed envelope read through this wrapper used
  // to come back as raw JSON — the BA-02 guard was bypassed here — while the
  // reader threw KEY_PROVIDER_FAILED for the same value. Both now answer
  // identically. A value that was never sealed (a backfill's first copy, a
  // plaintext deployment) is not envelope-shaped and still passes through.
  const reader = isMetadataReader(seam) ? seam : compatibilityMetadataReader(seam);
  if (typeof value === 'string') {
    return reader.readStoredText(value, context);
  }
  return reader.readStored(value, context);
}

export function createRuntimeService(
  db: Db,
  queueAccess?: { getQueue: (name: string) => Queue },
  metadataCrypto?: MetadataCrypto,
  metadataReader?: MetadataReader,
) {
  // CONTROL-PLANE-IMPL-818: ONE reader for the whole service, built at boot by
  // the composition root. Absent an injected one, the bounded compatibility
  // reader is used — never a literal `true`.
  const reader = metadataReader ?? compatibilityMetadataReader(metadataCrypto);
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
                  o.profile_policy_snapshot, o.prompt_revisions_pin,
                  o.prompt_overrides_ref,
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
          return buildClaimResult(t, client, metadataCrypto, reader);
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
        return buildClaimResult(t, client, metadataCrypto, reader);
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
      body: unknown,
      workerBusinessId?: string
    ): Promise<{ stepKey: string; generation: number; replayed: boolean }> {
      const parsed = SaveStepRequestSchema.safeParse(body);
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      const req = parsed.data;
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
        assertLeaseEpoch(task, req.leaseEpoch);
        assertActiveLease(task);
        const existing = await client.query(
          'SELECT generation, input_hash, status FROM step_checkpoints WHERE task_id=$1 AND step_key=$2 ORDER BY generation DESC LIMIT 1',
          [taskId, stepKey]
        );
        if (existing.rowCount) {
          const last = existing.rows[0] as { generation: number; input_hash: string; status: string };
          if (last.status === 'SUCCEEDED') {
            if (last.input_hash !== req.inputHash) {
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
        const sealedSessionRef = req.sessionRef === undefined
          ? null
          : await sealMetadata(
              metadataCrypto,
              req.sessionRef,
              {
                tenantId: task.tenant_id ?? '',
                slot: 'step_checkpoints.session_ref',
                refId: taskId + ':' + stepKey + ':' + nextGen,
              },
            );
        const sealedOutputRef = await sealMetadata(
          metadataCrypto,
          req.outputRef,
          { tenantId: task.tenant_id ?? '', slot: 'step_checkpoints.output_ref', refId: `${taskId}:${stepKey}` }
        );
        const inserted = await client.query(
          `INSERT INTO step_checkpoints (task_id, step_key, generation, input_hash, output_ref, status, session_ref)
           SELECT $1,$2,$3,$4,$5,$6,$7
           WHERE EXISTS (
             SELECT 1 FROM tasks t JOIN operations o ON o.id=t.operation_id
             WHERE t.id=$1 AND t.lease_epoch=$8 AND t.state='RUNNING'
               AND t.lease_expires_at > clock_timestamp()
               AND ($9::text IS NULL OR o.business_id=$9)
           )`,
          [
            taskId,
            stepKey,
            nextGen,
            req.inputHash,
            JSON.stringify(sealedOutputRef),
            req.status,
            req.sessionRef === undefined ? null : JSON.stringify(sealedSessionRef),
            req.leaseEpoch,
            workerBusinessId ?? null,
          ]
        );
        if (!inserted.rowCount) throw conflict('LEASE_LOST', 'task lease is no longer active');
        return { stepKey, generation: nextGen, replayed: false };
      });
    },
    async reportProgress(
      taskId: string,
      body: { leaseEpoch: number; percent: number; message?: string },
      workerBusinessId?: string,
    ): Promise<void> {
      const parsed = ProgressReportSchema.safeParse(body);
      if (!parsed.success) throw new HttpError(422, 'INVALID_SCHEMA', 'Invalid progress report');
      await db.tx(async (client) => {
        const selected = await client.query<ActiveLeaseRow & {
          operation_id: string; task_key: string; op_state: string;
          cancel_requested: boolean; endpoint_slug: string | null;
        }>(
          `SELECT t.lease_epoch, t.state, t.operation_id, t.task_key, o.business_id,
                  o.state AS op_state, o.cancel_requested, o.endpoint_slug,
                  (t.lease_expires_at > clock_timestamp()) AS lease_active
           FROM tasks t JOIN operations o ON o.id=t.operation_id
           WHERE t.id=$1 FOR UPDATE OF t`,
          [taskId],
        );
        if (!selected.rowCount) throw notFound('task not found');
        const task = selected.rows[0]!;
        assertTaskBusiness(task.business_id, workerBusinessId);
        assertLeaseEpoch(task, parsed.data.leaseEpoch);
        assertActiveLease(task);
        if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT'].includes(task.op_state)) {
          throw gone('operation is terminal');
        }
        if (hasCancelSignal(task) || task.task_key !== 'root') return;
        // Messages from worker/provider input can contain sensitive content.
        // Only a fixed stage label is persisted in the public projection.
        // Content-bearing step results remain in encrypted checkpoints/results.
        const message = task.endpoint_slug?.startsWith('workflows:')
          ? 'Processing workflow...'
          : 'Processing...';
        await client.query(
          `UPDATE operations o SET progress_percent=$2, progress_message=$3
           FROM tasks t
           WHERE o.id=$1 AND t.id=$4 AND t.operation_id=o.id AND t.task_key='root'
             AND t.lease_epoch=$5 AND t.state='RUNNING'
             AND t.lease_expires_at > clock_timestamp()
             AND o.state='RUNNING' AND NOT o.cancel_requested`,
          [task.operation_id, Math.floor(parsed.data.percent), message, taskId, parsed.data.leaseEpoch],
        );
      });
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
          `SELECT t.lease_epoch, t.state, t.operation_id, o.tenant_id, o.business_id,
                  (t.lease_expires_at > clock_timestamp()) AS lease_active
           FROM tasks t JOIN operations o ON o.id=t.operation_id
           WHERE t.id=$1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!tRes.rowCount) throw new HttpError(404, 'NOT_FOUND', `task ${taskId} not found`);
        const t = tRes.rows[0] as ActiveLeaseRow & { operation_id: string; tenant_id: string };
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

        // ENCMETA-RESULTREF (Option A): seal the worker-supplied ref under
        // EACH row's own slot before either copy is written — the same string
        // becomes two envelopes with different AAD bindings, so neither can
        // be replayed onto the other row. result_ref is a TEXT column, so the
        // envelope is bound as JSON text (the `input_ref` convention); no seam
        // → verbatim (the historical plaintext window).
        const sealResultRef = async (
          slot: 'tasks.result_ref' | 'operations.result_ref',
          refId: string,
        ): Promise<string> => {
          const sealed = await sealMetadata(metadataCrypto, body.resultRef, {
            tenantId: t.tenant_id,
            slot,
            refId,
          });
          return metadataCrypto ? JSON.stringify(sealed) : (sealed as string);
        };
        const sealedTaskResultRef = await sealResultRef('tasks.result_ref', taskId);
        const sealedOperationResultRef = await sealResultRef('operations.result_ref', t.operation_id);
        const completed = await client.query(
          `UPDATE tasks t SET state='SUCCEEDED', result_ref=$2, updated_at=now()
           FROM operations o
           WHERE t.id=$1 AND t.operation_id=o.id AND t.lease_epoch=$3
             AND t.state='RUNNING' AND t.lease_expires_at > clock_timestamp()
             AND ($4::text IS NULL OR o.business_id=$4)
           RETURNING t.id`,
          [taskId, sealedTaskResultRef, body.leaseEpoch, workerBusinessId ?? null]
        );
        if (!completed.rowCount) throw conflict('LEASE_LOST', 'task lease is no longer active');
        // Join reconciliation (RUN-05 all-success): when this task is a
        // child, check whether the parent join just completed and, if so,
        // emit exactly one parent continuation. A child completing into an
        // OPEN join must NOT mark the operation SUCCEEDED — remaining
        // siblings still own the join, so echo the stored operation state.
        const joinAck = await reconcileParentJoin(client, taskId, t.operation_id, metadataCrypto, reader);
        if (joinAck) return joinAck;
        const depCheck = await client.query('SELECT 1 FROM task_dependencies WHERE child_id=$1', [taskId]);
        if (depCheck.rowCount) {
          const opState = (await client.query('SELECT state FROM operations WHERE id=$1', [t.operation_id])).rows[0]
            ?.state as string;
          return { taskId, state: 'SUCCEEDED', operationState: opState, replayed: false };
        }
        await client.query(
          `UPDATE operations SET state='SUCCEEDED', state_version = state_version + 1, result_ref=$2,
             progress_percent=CASE WHEN endpoint_slug LIKE 'workflows:%' THEN 100 ELSE progress_percent END,
             progress_message=CASE WHEN endpoint_slug LIKE 'workflows:%' THEN NULL ELSE progress_message END,
             updated_at=now() WHERE id=$1`,
          [t.operation_id, sealedOperationResultRef]
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
                  o.cancel_requested, o.state AS op_state,
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
          cancel_requested?: boolean | null;
          op_state?: string | null;
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

        // WFA-T27: the legacy cancel path records CANCEL_REQUESTED (and
        // cancel_requested) while a worker still holds a live lease, then
        // answers the caller 200. When that worker reports the failure produced
        // while aborting, the acknowledged cancel IS the terminal outcome:
        // writing FAILED or RETRY_PENDING here would overwrite the requested
        // cancel and contradict the response the caller already received.
        if (hasCancelSignal({ cancel_requested: t.cancel_requested ?? false, op_state: t.op_state ?? undefined })) {
          const cancelled = await client.query(
            `UPDATE tasks t SET state='CANCELLED', updated_at=now()
             FROM operations o
             WHERE t.id=$1 AND t.operation_id=o.id AND t.lease_epoch=$2
               AND t.state='RUNNING' AND t.lease_expires_at > clock_timestamp()
               AND ($3::text IS NULL OR o.business_id=$3)
             RETURNING t.id`,
            [taskId, body.leaseEpoch, workerBusinessId ?? null]
          );
          if (!cancelled.rowCount) throw conflict('LEASE_LOST', 'task lease is no longer active');
          await client.query(
            `UPDATE operations SET state='CANCELLED', state_version = state_version + 1, updated_at=now() WHERE id=$1`,
            [t.operation_id]
          );
          // P2-08: the terminal transition schedules the webhook in the same tx.
          await maybeScheduleWebhook(client, t.operation_id);
          return { taskId, state: 'CANCELLED', operationState: 'CANCELLED', replayed: false };
        }

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
        const joinAck = await reconcileParentJoin(client, taskId, t.operation_id, metadataCrypto, reader);
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
      body: { leaseEpoch: number; children: ChildTaskSpec[]; joinPolicy: 'all-success'; continuationRef: string },
      workerBusinessId?: string
    ): Promise<{ childTaskIds: string[]; parentState: string }> {
      const parsed = SpawnChildrenRequestSchema.safeParse(body);
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      const req = parsed.data;
      return db.tx(async (client) => {
        const tRes = await client.query(
          `SELECT t.lease_epoch, t.state, t.operation_id, t.kind,
                  o.tenant_id, o.business_id, o.business_version, o.action, o.correlation_id,
                  (t.lease_expires_at > clock_timestamp()) AS lease_active
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
          lease_active: boolean;
        };
        assertTaskBusiness(t.business_id, workerBusinessId);
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
            const storedPayload = await openMetadata(reader, row.payload_ref ?? {}, {
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
        if (t.state === 'RUNNING') assertActiveLease(t as ActiveLeaseRow);
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
        const parentTransition = await client.query(
          `UPDATE tasks t
           SET state='WAITING_CHILDREN', payload_ref=$2, updated_at=now()
           WHERE t.id=$1 AND t.lease_epoch=$3 AND t.state='RUNNING'
             AND t.lease_expires_at > clock_timestamp()
             AND EXISTS (
               SELECT 1 FROM operations o
               WHERE o.id=t.operation_id
                 AND ($4::text IS NULL OR o.business_id=$4)
             )
           RETURNING t.id`,
          [taskId, JSON.stringify(sealedParentPayload), req.leaseEpoch, workerBusinessId ?? null],
        );
        if (!parentTransition.rowCount) {
          throw conflict('LEASE_LOST', 'task lease is no longer active');
        }
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
        `SELECT c.id, c.task_key, c.kind, c.state, c.result_ref, c.tenant_id, c.error_code
         FROM task_dependencies d JOIN tasks c ON c.id = d.child_id
         WHERE d.parent_id = $1 ORDER BY c.created_at`,
        [taskId]
      );
      // ENCMETA-RESULTREF R2: each child ref is opened under its OWN row
      // binding; a legacy plaintext value stays readable during the backfill
      // window (the same allowPlaintext convention the other slots use), and
      // a null stays null (never sealed, never opened).
      const childRows = res.rows as {
        id: string;
        task_key: string;
        kind: string;
        state: string;
        result_ref: string | null;
        tenant_id: string;
        error_code: string | null;
      }[];
      const children = await Promise.all(
        childRows.map(async (r) => ({
          taskId: r.id,
          taskKey: r.task_key,
          kind: r.kind,
          state: r.state,
          resultRef:
            r.result_ref === null
              ? null
              : ((await reader.readStoredText(
                  r.result_ref,
                  { tenantId: r.tenant_id, slot: 'tasks.result_ref', refId: r.id }
                )) ?? null),
          errorCode: r.error_code,
        })),
      );
      return { children };
    },

    /**
     * Human wait open (RUN-06, docs 07): persists the wait schema BEFORE the
     * worker releases its slot. Exactly one OPEN wait per task (partial unique
     * index); a replay of the same waitKey returns the stored waitId, a
     * conflicting schema for the same key is a 409.
     */
    async waitInput(
      taskId: string,
      body: { leaseEpoch: number; waitKey: string; inputSchema: unknown; uiSchema?: unknown; contextRef?: string | null; expiresAt?: string },
      workerBusinessId?: string
    ): Promise<{ waitId: string; expiresAt: string }> {
      const parsed = WaitInputRequestSchema.safeParse(body);
      if (!parsed.success) throw zodIssuesToProblem(parsed.error.issues);
      const req = parsed.data;
      return db.tx(async (client) => {
        const tRes = await client.query(
          `SELECT t.lease_epoch, t.state, t.operation_id, o.tenant_id, o.business_id,
                  (t.lease_expires_at > clock_timestamp()) AS lease_active
           FROM tasks t JOIN operations o ON o.id=t.operation_id
           WHERE t.id=$1 FOR UPDATE OF t`,
          [taskId]
        );
        if (!tRes.rowCount) throw notFound(`task ${taskId} not found`);
        const t = tRes.rows[0] as ActiveLeaseRow & { operation_id: string };
        assertTaskBusiness(t.business_id, workerBusinessId);
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
        assertActiveLease(t);
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
        const taskTransition = await client.query(
          `UPDATE tasks t
           SET state='WAITING_INPUT', updated_at=now()
           WHERE t.id=$1 AND t.lease_epoch=$2 AND t.state='RUNNING'
             AND t.lease_expires_at > clock_timestamp()
             AND EXISTS (
               SELECT 1 FROM operations o
               WHERE o.id=t.operation_id
                 AND ($3::text IS NULL OR o.business_id=$3)
             )
           RETURNING t.id`,
          [taskId, req.leaseEpoch, workerBusinessId ?? null],
        );
        if (!taskTransition.rowCount) {
          throw conflict('LEASE_LOST', 'task lease is no longer active');
        }
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
          'SELECT id, tenant_id, state, state_version, endpoint_slug FROM operations WHERE id=$1 FOR UPDATE',
          [operationId]
        );
        if (!opRes.rowCount) throw notFound('operation not found');
        const op = opRes.rows[0] as { tenant_id: string; state: string; state_version: number; endpoint_slug?: string };
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
          `SELECT t.id, t.state, t.payload_ref, o.business_id, o.business_version, o.action, o.correlation_id
           FROM tasks t JOIN operations o ON o.id = t.operation_id WHERE t.id=$1 FOR UPDATE OF t`,
          [wait.task_id]
        );
        if (!taskRes.rowCount) throw notFound(`task ${wait.task_id} not found`);
        const wt = taskRes.rows[0] as {
          id: string;
          state: string;
          payload_ref?: unknown;
          business_id: string;
          business_version: string;
          action: string;
          correlation_id: string;
        };
        if (wt.state !== 'WAITING_INPUT') {
          throw conflict('STATE_CONFLICT', `task ${wait.task_id} is ${wt.state}, not WAITING_INPUT`);
        }
        const deliveryId = `${wt.id}:resume:${op.state_version + 1}`;
        let resumePayload: Record<string, unknown> = { resumeInput: b.input, waitId: wait.wait_id };
        if (wt.action === 'schema-workflow'
            || (op.endpoint_slug?.startsWith('workflows:') === true
                && (wt.action === 'disbursement' || wt.action === 'doc-compare'))) {
          // Preserve the admitted immutable schema/input through HITL resume.
          // The stored payload is opened with this task's tenant-bound AAD and
          // resealed below; a corrupt/missing pin never falls back to plaintext.
          const original = await openMetadata(reader, wt.payload_ref, {
            tenantId: op.tenant_id, slot: 'tasks.payload_ref', refId: wt.id,
          });
          if (original === null || typeof original !== 'object' || Array.isArray(original)) {
            throw conflict('STATE_CONFLICT', 'Pinned workflow resume payload is unavailable');
          }
          if (wt.action === 'schema-workflow') {
            if (!Object.hasOwn(original, 'legacyWorkflowSchema') || !Object.hasOwn(original, 'input')) {
              throw conflict('STATE_CONFLICT', 'Pinned workflow resume payload is unavailable');
            }
            resumePayload = { ...original, ...resumePayload };
          } else if (Object.hasOwn(original, 'legacyWorkflow')) {
            const marker = (original as Record<string, unknown>)['legacyWorkflow'];
            if (marker === null || typeof marker !== 'object' || Array.isArray(marker)
                || (marker as Record<string, unknown>)['version'] !== 'legacy-workflow-named-input-v1'
                || (marker as Record<string, unknown>)['process'] !== wt.action) {
              throw conflict('STATE_CONFLICT', 'Pinned named workflow resume payload is unavailable');
            }
            resumePayload = { ...original, ...resumePayload };
          } else {
            throw conflict('STATE_CONFLICT', 'Pinned named workflow resume payload is unavailable');
          }
        }
        const sealedResumePayload = await sealMetadata(
          metadataCrypto,
          resumePayload,
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
            const joinAck = await reconcileParentJoin(client, taskId, operationId, metadataCrypto, reader);
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
  // CONTROL-PLANE-IMPL-818: the boot-built reader (already resolved by the
  // caller) so the child result_refs open under the policy, not a literal.
  reader: MetadataReader = compatibilityMetadataReader(metadataCrypto),
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
  // ENCMETA-RESULTREF R3 (the sharp edge): child result_refs are sealed, and
  // the summary below is merged INTO the sealed parent payload — so each ref
  // must be OPENED first, exactly like the parent payload itself
  // (runtime.ts comment below). Merging the raw envelopes would nest sealed
  // blobs inside the parent's envelope and the parent could never read them.
  const openedChildRefs = await Promise.all(
    sibs.map(async (s) =>
      s.result_ref === null
        ? null
        : ((await reader.readStoredText(
            s.result_ref,
            { tenantId: parent.tenant_id, slot: 'tasks.result_ref', refId: s.id }
          )) ?? null),
    ),
  );
  for (let i = 0; i < sibs.length; i += 1) {
    joinSummary[sibs[i]!.task_key] = openedChildRefs[i]!;
  }
  // ENC-META-01: the parent payload is sealed, so it must be OPENED before the
  // join summary is merged back into it. Merging into the raw envelope would
  // nest one sealed blob inside another and the parent could never read it.
  const openParentPayload = (await openMetadata(reader, parent.payload_ref ?? {}, {
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
  // CONTROL-PLANE-IMPL-818: as in reconcileParentJoin — the injected reader
  // carries the plaintext decision; metadataCrypto stays for the STRICT
  // prompt-carrier read below, which must never be a plaintext path.
  reader: MetadataReader = compatibilityMetadataReader(metadataCrypto),
): Promise<ClaimResult> {
  const checkpointsRes = await client.query('SELECT step_key as "stepKey", generation, input_hash as "inputHash", status, output_ref as "outputRef", session_ref as "sessionRef" FROM step_checkpoints WHERE task_id=$1 ORDER BY step_key, generation DESC', [
    t.id,
  ]);
  // ENC-META-01: a checkpoint output_ref is sealed at rest. The claim snapshot
  // must still carry the STRING the contract declares, so the envelope is
  // opened here — under the same tenant/row binding the checkpoint was sealed
  // with, and only after the business identity fence already ran above.
  const checkpointRefs: CheckpointRef[] = await Promise.all(
    (checkpointsRes.rows as CheckpointRef[]).map(async (r) => {
      const openedSessionRef =
        r.sessionRef === undefined || r.sessionRef === null
          ? null
          : await openMetadata(reader, r.sessionRef, {
              tenantId: t.tenant_id as string,
              slot: 'step_checkpoints.session_ref',
              refId: String(t.id) + ':' + String(r.stepKey) + ':' + String(r.generation),
            });
      if (openedSessionRef !== null && typeof openedSessionRef !== 'string') {
        throw unprocessable('INVALID_SCHEMA', 'checkpoint sessionRef is not a string');
      }
      const openedOutputRef =
        r.outputRef === undefined || r.outputRef === null
          ? undefined
          : await openMetadata(reader, r.outputRef, {
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
        sessionRef: openedSessionRef as string | null,
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
    resolvedInputRef: (await openMetadata(reader, t.input_ref ?? {}, {
      tenantId: t.tenant_id as string,
      slot: 'operations.input_ref',
      refId: t.operation_id as string,
    })) as Record<string, unknown>,
    // P2-02/R08-02 (W13-C): the claim snapshot carries the PIN captured at
    // submit — never the live profile. Legacy operations (no pin) keep the
    // zero-value shape so the wire schema is unchanged.
    pinned: {
      profileRevision: (t.profile_revision as number) ?? 0,
      // P745-PRODUCER (step 1): the admission-time prompt-revision markers,
      // keyed `connectionId::stepId`. NULL keeps the legacy `{}`; a malformed
      // pin fails the claim closed (corrupt admission record).
      promptRevisions: parsePromptRevisionsPin(t.prompt_revisions_pin),
      // P745-CARRIER-IMPL-A (Δ-PC-1): the sealed content carrier, opened HERE
      // (orchestrator-side key custody) and cross-checked against the markers
      // above; `null` when there is no carrier (never `[]`).
      promptOverrides: await openPromptCarrier(metadataCrypto, t.prompt_overrides_ref, t.prompt_revisions_pin, {
        tenantId: t.tenant_id as string,
        operationId: t.operation_id as string,
      }),
      connectorBindings: (t.connector_bindings as Record<string, string>) ?? {},
      // T-SUB-04: the admission-time policy, straight from the column written
      // at submit. `?? null` is NOT a coalesce-to-empty — a NULL snapshot means
      // "no profile policy applied" (legacy mode / pre-0026 row) and must stay
      // null so the worker can tell "unmanaged" from "managed to an empty
      // policy". Never `profile_bindings`.
      //
      // Parsed, not cast: the column is jsonb, so a row that does not match
      // PinnedProfilePolicySchema is a corrupt admission record. Running the
      // job with default parameters would be exactly the silent wrong answer
      // PRF-02 exists to prevent, so this fails closed instead.
      profilePolicy: parsePinnedProfilePolicy(t.profile_policy_snapshot, {
        tenantId: t.tenant_id as string,
        profileId: t.profile_id,
        profileRevision: t.profile_revision,
      }),
    },
    taskKey: t.task_key as string,
    kind: t.kind as string,
    payloadRef: (await openMetadata(reader, t.payload_ref ?? {}, {
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
