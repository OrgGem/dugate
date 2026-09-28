import { randomUUID, createHash } from 'node:crypto';
import type { IngestionReceipt } from '@du/contracts';
import {
  createIngestionTaskHandler,
  createSourceAcquisitionIngestor,
  SourceAcquisitionError,
  SourceIngestionError,
  type PinnedSourceStorage,
  type SdkFetcher,
  type SourceIngestionErrorCode,
} from '@du/worker-sdk';
import type { Db } from '../../db/db';
import { HttpError } from '../../http/errors';
import { maybeScheduleWebhook, type DbClient } from '../webhooks/webhooks';
import { processIngestionTask, type SourceAcquirer } from './submission';

/**
 * W-DATA03-CONSUMER-JOIN-1 (Turn 160 audit HIGH 1): the durable consumer that
 * closes the production join
 * URL submission -> ingestion task -> private-S3 materialization -> immutable
 * artifactId receipt -> READY business task.
 *
 * Before this module both ends existed with zero production callers: the
 * producer (createSubmissionService) wrote a task.dispatch outbox row with
 * gate 'ingestion' and parked operation+root task in PENDING_INGESTION, while
 * the gate (processIngestionTask -> markIngestionReady) and the worker-side
 * act (createIngestionTaskHandler: acquire -> materialize a READY artifact ->
 * receipt.artifactId) waited for a caller nobody had. Nothing read the gate
 * key, so a URL operation stayed behind the gate forever - and the generic
 * dispatcher would still publish the row to the BUSINESS queue, where a claim
 * would run the task with no pinned source at all.
 *
 * Ownership after this join:
 * - dispatcher.ts excludes gate 'ingestion' rows from the business publish
 *   path (they are durable work for THIS consumer, not for workers);
 * - this consumer claims those rows out of the outbox with the same
 *   claim_until/attempts bookkeeping the dispatcher uses (FOR UPDATE SKIP
 *   LOCKED; one short claim transaction, processing happens after it commits);
 * - per row it rebuilds the trusted coordinates from the DB (tenant, root
 *   task, input envelope) - the queue payload is a pointer, never an
 *   authority;
 * - it composes the worker-sdk producer legs over an injected
 *   PinnedSourceStorage port (bounded acquisition, stream-to-version,
 *   three-measurement pin check) and the artifacts table (materialize =
 *   idempotent READY row under a deterministic id), then hands the merged
 *   receipt to processIngestionTask, which validates the URL again and
 *   commits markIngestionReady in its own transaction.
 *
 * Fail-closed policy: the READY gate opens ONLY through markIngestionReady,
 * after a contract-valid receipt carrying an artifactId. Every failure path
 * leaves operation AND root task in PENDING_INGESTION - never READY, never an
 * artifact row describing bytes nobody measured. Transport/storage/
 * materialization failures retry with a due_at backoff until maxAttempts,
 * then escalate to a visible terminal FAILED (task+operation in one tx,
 * error_code preserved, terminal webhook scheduled the same way the
 * expired-lease sweep does it). Shape/policy failures (invalid descriptor,
 * non-HTTPS, dispatch/row disagreement) are non-retryable and escalate on the
 * spot - redelivery cannot change their outcome.
 */

/** Transfer budget handed to acquireSourceUrl. maxBytes is mandatory so a
 * misconfigured deployment can never start an unbounded download. */
export interface IngestionTransferPolicy {
  maxBytes: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  maxRedirects?: number;
  /** Tests inject the fetcher seam; production omits it and gets the pinned
   * egress default (SSRF fence) inside acquireSourceUrl. */
  fetcher?: SdkFetcher;
}

export interface IngestionConsumerOptions {
  db: Db;
  /** Private-store port the pinned versions land in (S3 adapter in prod).
   * A resolvePinned hit means a retry answers without any network. */
  storage: PinnedSourceStorage;
  transfer: IngestionTransferPolicy;
  /** Recorded on the materialized artifact row; must match the deployment's
   * artifact storage backend (CHECK constraint in migration 0013). */
  storageBackend: 'postgres' | 's3';
  batch?: number;
  /** Ingestion attempts before the terminal FAILED escalation. The claim
   * itself counts, so maxAttempts 1 means "one try, then escalate". */
  maxAttempts?: number;
  retryBackoffSeconds?: number;
  /** Outbox claim window; must exceed the whole transfer deadline so a live
   * download is never re-claimed underneath itself. */
  claimLeaseSeconds?: number;
  pollIntervalMs?: number;
  /** Fired after markIngestionReady commits so the gate:'ready' dispatch does
   * not wait a full dispatcher tick. Best-effort: the timer is the safety
   * net, mirroring the submit route's dispatch kick. */
  onGateOpened?: (operationId: string) => void;
}

export interface IngestionSweepResult {
  claimed: number;
  opened: number;
  retried: number;
  escalated: number;
  replayed: number;
  skipped: number;
  /** T180-D1: rows where a guarded write found the claim no longer ours. */
  preempted: number;
}

interface ClaimedRow {
  id: string;
  aggregate_id: string;
  delivery_id: string;
  attempts: number;
  /** T180-D1 fencing token: attempts immediately after OUR claim stamp. */
  token: number;
  payload: Record<string, unknown>;
}

const DEFAULT_BATCH = 5;
const DEFAULT_MAX_ATTEMPTS = 8;
const DEFAULT_RETRY_BACKOFF_SECONDS = 30;
/** Comfortably above the SDK default 60s whole-acquisition deadline. */
const DEFAULT_CLAIM_LEASE_SECONDS = 300;
const DEFAULT_POLL_INTERVAL_MS = 5_000;

/**
 * RFC 4122 v5 over a lane-fixed namespace: the materialized source artifact
 * id is a pure function of the trusted coordinates and the immutable pin, so
 * a re-delivery re-derives the SAME id. ON CONFLICT (id) DO NOTHING then
 * makes double-materialization structurally impossible (the primary key is
 * the arbiter) and the envelope's artifactId stable across retries.
 */
export const SOURCE_ARTIFACT_NAMESPACE = '9f14dc40-9e6a-5c1e-a4c9-2f9a1d63b155';

export function sourceArtifactId(input: {
  tenantId: string;
  operationId: string;
  storageKey: string;
  versionId: string;
  sha256: string;
}): string {
  const name =
    'du-source|' + input.tenantId + '|' + input.operationId + '|' +
    input.storageKey + '|' + input.versionId + '|' + input.sha256;
  const hash = createHash('sha1')
    .update(Buffer.concat([
      Buffer.from(SOURCE_ARTIFACT_NAMESPACE.replace(/-/g, ''), 'hex'),
      Buffer.from(name, 'utf8'),
    ]))
    .digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  // noUncheckedIndexedAccess: the slice is exactly 16 bytes, the ?? is
  // for the type checker, never for a runtime case.
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return (
    hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-' + hex.slice(12, 16) + '-' +
    hex.slice(16, 20) + '-' + hex.slice(20)
  );
}

/** Tenant/operation-scoped pin namespace - the same shape the worker-sdk
 * fixtures and the Δ14 envelope convention already use. */
export function sourceStorageKey(tenantId: string, operationId: string): string {
  return 'du/tenants/' + tenantId + '/operations/' + operationId + '/source';
}

const CLAIM_SQL =
  'SELECT id, aggregate_id, delivery_id, attempts, payload FROM outbox ' +
  "WHERE type = 'task.dispatch' AND dispatched_at IS NULL " +
  'AND (claim_until IS NULL OR claim_until < now()) AND due_at <= now() ' +
  "AND payload->>'gate' = 'ingestion' " +
  'ORDER BY due_at LIMIT $1 FOR UPDATE SKIP LOCKED';

const CLAIM_STAMP_SQL =
  "UPDATE outbox SET claim_until = now() + ($2 * interval '1 second'), attempts = attempts + 1 WHERE id = $1";

// W-INGEST-POST-LEASE-FENCE-1 (T180-D1): every terminal write a runner
// makes on its claim row carries the ATTEMPT TOKEN captured at claim time
// (attempts + 1 after the stamp). A reclaim by another replica increments
// attempts, so the stale runner can no longer complete, re-arm, or renew
// the row it no longer owns - each guarded UPDATE answers rowCount 0 and
// the runner stops as PREEMPTED instead of writing final state.
const FENCE_LOCK_SQL =
  'SELECT id FROM outbox WHERE id = $1 FOR UPDATE';

const FENCE_RENEW_SQL =
  "UPDATE outbox SET claim_until = now() + ($2 * interval '1 second') WHERE id = $1 AND attempts = $3 AND dispatched_at IS NULL AND claim_until > now()";

const COMPLETE_SQL =
  'UPDATE outbox SET dispatched_at = now(), claim_until = NULL WHERE id = $1 AND attempts = $2';

const RETRY_SQL =
  "UPDATE outbox SET claim_until = NULL, due_at = now() + ($3 * interval '1 second') WHERE id = $1 AND attempts = $2";

/** The queue payload is a pointer; every execution coordinate is re-read from
 * the DB (tenant, envelope, task state) before anything runs. */
const OPERATION_LOAD_SQL =
  'SELECT t.id AS "taskId", t.state AS "taskState", t.payload_ref AS "payloadRef", ' +
  'o.tenant_id AS "tenantId", o.state AS "opState", o.cancel_requested AS "cancelRequested" ' +
  'FROM tasks t JOIN operations o ON o.id = t.operation_id ' +
  "WHERE t.operation_id = $1 AND t.task_key = 'root'";

const FAIL_TASK_SQL =
  "UPDATE tasks SET state='FAILED', error_code=$2, updated_at=now() " +
  "WHERE operation_id=$1 AND task_key='root' AND state='PENDING_INGESTION'";

const FAIL_OPERATION_SQL =
  "UPDATE operations SET state='FAILED', state_version = state_version + 1, error_code=$2, updated_at=now() " +
  "WHERE id=$1 AND state='PENDING_INGESTION'";

// W-INGEST-POST-LEASE-FENCE-1 (T180-D2): a replay hit must PROVE it is the
// same materialization - operation, task, digest, and size are compared
// against the receipt; a divergent stored row is a conflict, never a
// silent overwrite and never an arbitrary pick among candidates.
const ARTIFACT_FIND_SQL =
  'SELECT id, operation_id, task_id, sha256, size_bytes FROM artifacts ' +
  "WHERE tenant_id=$1 AND storage_key=$2 AND storage_version_id=$3 AND state='READY' " +
  'ORDER BY created_at DESC LIMIT 2';

const ARTIFACT_BY_ID_SQL =
  'SELECT id, operation_id, task_id, sha256, size_bytes FROM artifacts WHERE id=$1';

/** token is NOT NULL in the base schema but is only a placeholder here: the
 * grant routes rotate token/token_mode on demand (artifacts.ts:410), and a
 * platform-materialized source pin was never PUT through the proxy path. */
const ARTIFACT_INSERT_SQL =
  'INSERT INTO artifacts (id, tenant_id, operation_id, task_id, purpose, mime_type, ' +
  'size_bytes, sha256, state, token, storage_key, storage_version_id, storage_backend) ' +
  "VALUES ($1,$2,$3,$4,'input','application/octet-stream',$5,$6,'READY',$7,$8,$9,$10) " +
  'ON CONFLICT (id) DO NOTHING';

/** Non-retryable: redelivery cannot change the answer. Everything that
 * depends on the outside world (transport, storage, DB) stays retryable. */
const PERMANENT_CODES = new Set(['TASK_INVALID', 'INVALID_URL', 'SCHEME_NOT_ALLOWED', 'INVALID_SCHEMA', 'MATERIALIZATION_CONFLICT']);

/**
 * T180-D1: raised whenever a guarded write answers rowCount 0 - the claim
 * row moved on (reclaimed by another replica or completed elsewhere). The
 * row is NOT ours: no retry stamp, no escalate, no complete. The current
 * owner decides the operation; our partial side effects (an extra pinned
 * version, a matching deterministic artifact row) are idempotent by
 * construction, so bailing out mid-flight cannot corrupt state.
 */
export class IngestionPreemptedError extends Error {
  readonly code = 'PREEMPTED';
  constructor() {
    super('ingestion claim ownership was lost during processing');
    this.name = 'IngestionPreemptedError';
  }
}

function permanentFailure(reason: string): SourceIngestionError {
  return new SourceIngestionError(422, 'TASK_INVALID', reason);
}

function failureCode(err: unknown): string {
  const raw =
    err instanceof SourceIngestionError || err instanceof SourceAcquisitionError
      ? err.code
      : err instanceof HttpError
        ? err.code
        : 'INGESTION_FAILED';
  return typeof raw === 'string' && /^[A-Z][A-Z0-9_]{0,39}$/.test(raw) ? raw : 'INGESTION_FAILED';
}

function isPermanent(err: unknown): boolean {
  return PERMANENT_CODES.has(failureCode(err));
}

export function createIngestionConsumer(options: IngestionConsumerOptions) {
  const batch = options.batch ?? DEFAULT_BATCH;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = options.retryBackoffSeconds ?? DEFAULT_RETRY_BACKOFF_SECONDS;
  const claimLease = options.claimLeaseSeconds ?? DEFAULT_CLAIM_LEASE_SECONDS;
  if (!Number.isSafeInteger(options.transfer.maxBytes) || options.transfer.maxBytes < 1) {
    throw new Error('ingestion consumer requires a positive integer transfer.maxBytes');
  }
  // T180-D1: the claim lease must outlive the transfer it protects, or the
  // fence exists only on paper (a lease shorter than the deadline guarantees
  // mid-flight expiry). 60s default mirrors the SDK DEFAULT_SOURCE_TIMEOUT_MS.
  const transferDeadlineMs = options.transfer.timeoutMs ?? 60_000;
  if (claimLease * 1000 <= transferDeadlineMs) {
    throw new Error('ingestion consumer claimLeaseSeconds must exceed the transfer timeoutMs');
  }
  let timer: ReturnType<typeof setInterval> | undefined;
  let active: Promise<IngestionSweepResult> | undefined;

  /**
   * Renew our claim lease in-tx; rowCount 0 means the row is no longer ours.
   * The FOR UPDATE first: within a committing transaction (gate, materialize,
   * escalate) we must hold the outbox row against a concurrent reclaim, or
   * another replica could bump attempts AFTER our renew passed and the
   * in-tx check would be stale by commit. Outside any transaction (the
   * pre-acquire check) the lock is released immediately - it only narrows
   * the race window there, which is exactly what it is for.
   */
  async function assertOwnership(client: { query: (text: string, params?: unknown[]) => Promise<{ rowCount: number | null }> }, row: ClaimedRow): Promise<void> {
    const held = await client.query(FENCE_LOCK_SQL, [row.id]);
    if (!held.rowCount) throw new IngestionPreemptedError();
    const res = await client.query(FENCE_RENEW_SQL, [row.id, claimLease, row.token]);
    if (!res.rowCount) throw new IngestionPreemptedError();
  }

  interface StoredArtifactMeta {
    id: string;
    operation_id: string | null;
    task_id: string | null;
    sha256: string | null;
    size_bytes: string | number | null;
  }

  // The worker-sdk handler passes SourceIngestionError through UNTOUCHED and
  // re-wraps anything else as retryable MATERIALIZATION_FAILED. A metadata
  // conflict is DETERMINISTIC - re-delivery cannot fix a stored row that
  // disagrees with the pin - so it travels as SourceIngestionError under a
  // widened code string (the union lives in worker-sdk; the consumer owns
  // its own conflict taxonomy and the escalate path persists the raw code).
  const MATERIALIZATION_CONFLICT_CODE =
    'MATERIALIZATION_CONFLICT' as unknown as SourceIngestionErrorCode;
  function materializationConflict(detail: string): SourceIngestionError {
    return new SourceIngestionError(422, MATERIALIZATION_CONFLICT_CODE, detail);
  }

  /** T180-D2: the stored row must describe EXACTLY these bytes for THIS task. */
  function persistedMatches(
    stored: StoredArtifactMeta,
    coords: { operationId: string; taskId: string },
    receipt: IngestionReceipt
  ): boolean {
    return stored.operation_id === coords.operationId &&
      stored.task_id === coords.taskId &&
      typeof stored.sha256 === 'string' && stored.sha256.toLowerCase() === receipt.sha256 &&
      Number(stored.size_bytes) === receipt.sizeBytes;
  }

  /** Idempotent per the immutable pin: verify an existing READY row against
   * the receipt (never trust key/version alone), else insert under the
   * deterministic id and RE-READ to confirm on PK conflict. */
  async function materializeArtifactRow(
    row: ClaimedRow,
    coords: { tenantId: string; operationId: string; taskId: string },
    receipt: IngestionReceipt
  ): Promise<string> {
    const artifactId = sourceArtifactId({
      tenantId: coords.tenantId,
      operationId: coords.operationId,
      storageKey: receipt.storageKey,
      versionId: receipt.versionId,
      sha256: receipt.sha256,
    });
    return options.db.tx(async (client) => {
      await assertOwnership(client, row);
      const found = await client.query(ARTIFACT_FIND_SQL, [
        coords.tenantId, receipt.storageKey, receipt.versionId,
      ]);
      const hits = found.rows as unknown as StoredArtifactMeta[];
      if (hits.length > 1) {
        throw materializationConflict('more than one READY artifact describes this storage version');
      }
      const hit = hits[0];
      if (hit) {
        if (!persistedMatches(hit, coords, receipt)) {
          throw materializationConflict('the existing READY artifact row disagrees with the pinned bytes');
        }
        return hit.id;
      }
      const inserted = await client.query(ARTIFACT_INSERT_SQL, [
        artifactId, coords.tenantId, coords.operationId, coords.taskId,
        receipt.sizeBytes, receipt.sha256, randomUUID(),
        receipt.storageKey, receipt.versionId, options.storageBackend,
      ]);
      if (inserted.rowCount) return artifactId;
      // PK conflict: our deterministic id already exists (concurrent or
      // crashed-earlier writer). Read the PERSISTED row - the id only binds
      // coordinates, so a divergent tenant/adapter can still exist.
      const after = await client.query(ARTIFACT_BY_ID_SQL, [artifactId]);
      const persisted = after.rows[0] as unknown as StoredArtifactMeta | undefined;
      if (!persisted) {
        throw new SourceIngestionError(502, 'MATERIALIZATION_FAILED', 'the conflicting artifact row vanished before it could be verified');
      }
      if (!persistedMatches(persisted, coords, receipt)) {
        throw materializationConflict('the conflicting artifact row disagrees with the pinned bytes');
      }
      return persisted.id;
    });
  }

  async function openGate(
    row: ClaimedRow,
    coords: { tenantId: string; operationId: string; taskId: string; input: Record<string, unknown> },
    sourceUrl: string
  ): Promise<void> {
    // T180-D1: never start a download whose commit we may not own. A
    // pre-acquire renew catches leases already expired at dispatch time;
    // the in-tx fences below catch the race during flight.
    const preNew = await options.db.query(FENCE_RENEW_SQL, [row.id, claimLease, row.token]);
    if (!preNew.rowCount) throw new IngestionPreemptedError();
    const storageKey = sourceStorageKey(coords.tenantId, coords.operationId);
    const ingestor = createSourceAcquisitionIngestor({
      storage: options.storage,
      storageKey,
      transfer: options.transfer,
      taskId: coords.operationId,
    });
    const handler = createIngestionTaskHandler({
      acquirer: ingestor,
      materializeArtifact: (_task, receipt) => materializeArtifactRow(row, coords, receipt),
    });
    // The handler IS the SourceAcquirer processIngestionTask demands: the
    // audit's missing middle - acquisition plus READY-artifact
    // materialization - now runs BEFORE the gate transaction, and the merged
    // receipt (with artifactId) is exactly what markIngestionReady persists.
    const acquirer: SourceAcquirer = {
      acquire: (url) => handler.run({ operationId: coords.operationId, sourceUrl: url, input: coords.input }),
    };
    // The READY dispatch is a NEW delivery (outbox.delivery_id is UNIQUE);
    // the ingestion delivery it replaces stays durable beside it.
    await processIngestionTask(
      options.db, coords.operationId, sourceUrl, acquirer, coords.input,
      {
        deliveryId: randomUUID(),
        kind: typeof row.payload.kind === 'string' ? row.payload.kind : 'root',
        correlationId: typeof row.payload.correlationId === 'string' ? row.payload.correlationId : '',
      },
      // T180-D1: the ownership fence runs INSIDE the gate transaction -
      // gate writes and the claim check commit or roll back together.
      async (client) => {
        await assertOwnership(client, row);
      }
    );
    // Post-commit stamp is attempt-guarded too; a steal in the tiny window
    // between gate commit and here leaves the (correct) state for the new
    // owner to replay-stamp. The gate DID open - that is not undone by a
    // missed stamp, so this stays counted as opened.
    await options.db.query(COMPLETE_SQL, [row.id, row.token]);
    try {
      options.onGateOpened?.(coords.operationId);
    } catch {
      // The dispatcher timer is the safety net; a failed kick changes nothing.
    }
  }

  async function escalate(row: ClaimedRow, error: unknown): Promise<'escalated' | 'preempted'> {
    const code = failureCode(error);
    const operationId = String(row.payload.operationId);
    try {
      await options.db.tx(async (client) => {
        // T180-D1: a stale runner must not terminal-fail an operation the
        // current owner may still be opening successfully. Ownership first,
        // in the same tx as the FAIL writes.
        await assertOwnership(client, row);
        await client.query(FAIL_TASK_SQL, [operationId, code]);
        await client.query(FAIL_OPERATION_SQL, [operationId, code]);
        await maybeScheduleWebhook(client, operationId);
      });
    } catch (err) {
      if (err instanceof IngestionPreemptedError) return 'preempted';
      throw err;
    }
    await options.db.query(COMPLETE_SQL, [row.id, row.token]);
    return 'escalated';
  }

  async function retry(row: ClaimedRow): Promise<'retried' | 'preempted'> {
    // T180-D1: re-arm only OUR row. Un-guarded, a stale loser would reset
    // the newer owner’s live claim_until and double-process the delivery.
    const res = await options.db.query(RETRY_SQL, [row.id, row.token, backoff]);
    if (!res.rowCount) return 'preempted';
    return 'retried';
  }

  async function processRow(row: ClaimedRow): Promise<keyof IngestionSweepResult> {
    const payload = row.payload;
    const operationId = payload.operationId;
    const sourceUrl = payload.sourceUrl;
    const taskId = payload.taskId;
    if (
      typeof operationId !== 'string' || operationId.length === 0 ||
      typeof sourceUrl !== 'string' || sourceUrl.length === 0 ||
      typeof taskId !== 'string' || taskId.length === 0
    ) {
      // A row missing its own coordinates cannot be escalated to an
      // operation either - stop redelivering it, but touch no state (there is
      // nothing trusted to write against).
      await options.db.query(COMPLETE_SQL, [row.id, row.token]);
      return 'skipped';
    }

    const loaded = await options.db.query(OPERATION_LOAD_SQL, [operationId]);
    const record = loaded.rows[0] as {
      taskId: string;
      taskState: string;
      payloadRef: unknown;
      tenantId: string;
      opState: string;
      cancelRequested: boolean;
    } | undefined;
    if (!record) {
      await options.db.query(COMPLETE_SQL, [row.id, row.token]);
      return 'skipped';
    }
    if (record.cancelRequested === true ||
        ['CANCEL_REQUESTED', 'CANCELLED', 'SUCCEEDED', 'FAILED', 'TIMED_OUT'].includes(record.opState)) {
      // Terminal/cancelled under us: the gate must never open. Consume the
      // delivery visibly rather than re-arming forever.
      await options.db.query(COMPLETE_SQL, [row.id, row.token]);
      return 'skipped';
    }
    if (record.opState !== 'PENDING_INGESTION' || record.taskState !== 'PENDING_INGESTION') {
      // A prior attempt already opened the gate (crash before COMPLETE_SQL).
      await options.db.query(COMPLETE_SQL, [row.id, row.token]);
      return 'replayed';
    }
    if (record.taskId !== taskId) {
      return await escalate(row, permanentFailure('dispatch taskId does not match the root task row'));
    }

    const rawEnvelope = record.payloadRef as Record<string, unknown> | string | null;
    const envelope = typeof rawEnvelope === 'string' ? safeJson(rawEnvelope) : rawEnvelope;
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) {
      return await escalate(row, permanentFailure('root task payload_ref is not a JSON object'));
    }
    const input = envelope.input;
    if (!input || typeof input !== 'object' || Array.isArray(input)) {
      return await escalate(row, permanentFailure('ingestion envelope carries no action input object'));
    }
    if (envelope.sourceUrl !== sourceUrl) {
      return await escalate(row, permanentFailure('sourceUrl disagrees between dispatch payload and the task row'));
    }

    try {
      await openGate(
        row,
        {
          tenantId: record.tenantId,
          operationId,
          taskId: record.taskId,
          input: input as Record<string, unknown>,
        },
        sourceUrl
      );
      return 'opened';
    } catch (err) {
      if (err instanceof IngestionPreemptedError) return 'preempted';
      if (isPermanent(err)) return await escalate(row, err);
      if (row.attempts + 1 >= maxAttempts) return await escalate(row, err);
      return await retry(row);
    }
  }

  async function consumeOnce(): Promise<IngestionSweepResult> {
    const claimed = await options.db.tx(async (client) => {
      const res = await client.query(CLAIM_SQL, [batch]);
      const rows = res.rows as unknown as ClaimedRow[];
      for (const row of rows) {
        await client.query(CLAIM_STAMP_SQL, [row.id, claimLease]);
        // The stamp is unconditional while we hold the row lock (FOR UPDATE
        // above), so our fencing token is exactly pre-stamp attempts + 1.
        row.token = row.attempts + 1;
      }
      return rows;
    });

    const result: IngestionSweepResult = {
      claimed: claimed.length, opened: 0, retried: 0, escalated: 0, replayed: 0, skipped: 0, preempted: 0,
    };
    for (const row of claimed) {
      const outcome = await processRow(row);
      result[outcome] += 1;
    }
    return result;
  }

  return {
    /** Single-flight sweep: a tick while one runs skips (slow downloads hold
     * the claim lease, they never stack two processors on one row). */
    async runOnce(): Promise<IngestionSweepResult> {
      if (active) return active;
      const sweep = consumeOnce().finally(() => {
        if (active === sweep) active = undefined;
      });
      active = sweep;
      return sweep;
    },
    start() {
      if (timer) return;
      timer = setInterval(() => {
        void (this.runOnce() as Promise<IngestionSweepResult>).catch(() => undefined);
      }, options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

function safeJson(value: string): Record<string, unknown> | null {
  try {
    return JSON.parse(value) as Record<string, unknown>;
  } catch {
    return null;
  }
}
