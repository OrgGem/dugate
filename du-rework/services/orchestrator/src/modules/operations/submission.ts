import { randomUUID } from 'node:crypto';
import {
  BusinessManifest,
  OperationView,
  SubmissionSchema,
  canonicalRequestHash,
  normalizeRouteAction,
  adjudicateUrlDestination,
  withIngestionSource,
  type IngestionReceipt,
} from '@du/contracts';
import { normalizeCorrelationId } from '@du/observability';
import { Db } from '../../db/db';
import { RegistryService } from '../registry/registry';
import { ProfileService, renderPinnedBindings } from '../profiles/profiles';
import { HttpError, badRequest, conflict, notFound, unprocessable } from '../../http/errors';
import type { DbClient } from '../webhooks/webhooks';
import Ajv from 'ajv';

/**
 * Submission + idempotency + admission (docs 06, P2-04, OPS-01..03).
 *
 * One transaction writes: operation, root task, idempotency key, and the
 * outbox dispatch row. The queue publish happens AFTER commit (dispatchOutbox)
 * so a crash between DB write and publish is recovered by the outbox sweeper —
 * never a lost or double job. Idempotency scope is
 * (tenantId, apiKeyId, routeAction, key); same key + same request hash replays
 * the original operation, same key + different hash is a 409.
 *
 * Profile pinning (P2-02 / R08-02, W13-C): before writing anything, the key's
 * latest binding for (business, version, action) is resolved. The winning
 * profile (id, revision) and its connector pin map are stored on the operation
 * row; claim snapshots and grant issuance read that pin, never the live
 * profile, so a revision change affects new submissions only (PRF-02). A key
 * in profile mode (≥1 binding row) with no match for this action is rejected
 * with 403 and nothing is enqueued (PRF-01); a key with no rows stays legacy.
 */

export interface SubmitContext {
  tenantId: string;
  apiKeyId: string;
  businessId: string;
  action: string;
  alias?: string;
  idempotencyKey?: string;
  correlationId?: string;
  submission: unknown;
  /** Seconds an idempotency record is retained (>= retry/replay window). */
  idempotencyTtlSeconds?: number;
}

export interface SubmitResult {
  operation: OperationView;
  replayed: boolean;
  correlationId: string;
}

export interface SubmissionServiceOptions {
  /** Maximum aggregate size of file-like bytes embedded in input JSON. */
  maxBlobBytes?: number;
  /**
   * W-INGEST-PG-FAILCLOSED-1 (Reviewer T180-D3): the deployment artifact
   * storage backend. URL ingestion needs the version-capable private store
   * behind the ingestion gate; anything other than s3 rejects URL
   * submissions at admission instead of stranding a forever-undispatched
   * PENDING_INGESTION row (the dispatcher excludes gate-ingestion by
   * design, and no consumer exists on a non-s3 backend). Absent =
   * fail-closed: treated as non-s3.
   */
  storageBackend?: 'postgres' | 's3';
}

// W-DATA01-S3-FACADE-1 (Δ14): the receipt shape is no longer a private copy of
// this module — @du/contracts owns it, so the producer (worker SDK), the gate
// writer (this service) and the business consumer validate the same schema.
export type { IngestionReceipt } from '@du/contracts';

export interface SourceAcquirer {
  acquire(sourceUrl: string): Promise<IngestionReceipt>;
}

const ajv = new Ajv({ allErrors: true, strict: false });

const DEFAULT_MAX_BLOB_BYTES = 64 * 1024 * 1024;
const ARTIFACT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function createSubmissionService(
  db: Db,
  registry: RegistryService,
  profiles: ProfileService,
  options: SubmissionServiceOptions = {}
) {
  const maxBlobBytes = options.maxBlobBytes ?? DEFAULT_MAX_BLOB_BYTES;
  if (!Number.isSafeInteger(maxBlobBytes) || maxBlobBytes < 0) {
    throw new Error('maxBlobBytes must be a non-negative safe integer');
  }
  // W-INGEST-PG-FAILCLOSED-1 fail-closed default: an unwired deployment
  // cannot accept URL work it has no store to materialize into.
  const storageBackend = options.storageBackend ?? 'postgres';

  return {
    async submit(ctx: SubmitContext): Promise<SubmitResult> {
      const parsed = SubmissionSchema.safeParse(ctx.submission);
      if (!parsed.success) {
        throw unprocessable('INVALID_SCHEMA', 'submission validation failed', {
          errors: parsed.error.issues.slice(0, 50).map((i) => ({
            pointer: '/' + i.path.join('/'),
            message: i.message,
          })),
        });
      }
      const submission = parsed.data;
      if (submission.sourceUrl && storageBackend !== 's3') {
        // T180-D3 admission-time fail-closed: schema parsing above is
        // pure, so this throws with ZERO database calls - no operation
        // row, no task row, no outbox row, no parked PENDING_INGESTION
        // that no consumer can ever open on a non-s3 backend.
        throw unprocessable(
          'UNSUPPORTED_STORAGE_BACKEND',
          'URL ingestion requires an S3-compatible storage backend'
        );
      }
      if (submission.sourceUrl) validateSourceUrl(submission.sourceUrl);
      assertEmbeddedInputByteBudget(submission.input, maxBlobBytes);
      const referencedArtifactIds = collectArtifactReferences(submission);
      await assertReadyTenantArtifacts(
        (ids, tenantId) => db.query<SubmissionArtifactRow>(ARTIFACT_REFERENCE_QUERY, [ids, tenantId]),
        referencedArtifactIds,
        ctx.tenantId
      );
      const correlationId = normalizeCorrelationId(ctx.correlationId);
      const canonicalAction = ctx.alias ?? ctx.action;
      const routeAction = normalizeRouteAction(ctx.businessId, ctx.action, ctx.alias);

      // Resolve the registered+enabled version (slice submits against the
      // single enabled version per business/action).
      const enabled = await resolveEnabledVersion(db, ctx.businessId, canonicalAction);
      const { version, manifest, digest, queue } = enabled;

      // Profile pin (P2-02/R08-02): resolve the key's latest binding for this
      // (business, version, action) and pin it onto the operation. 403 here
      // (PRF-01) rejects before any row is written — nothing is enqueued.
      const binding = await profiles.resolveBinding(ctx.apiKeyId, ctx.businessId, version, canonicalAction);

      // Validate input against the action's inputSchema (422 on mismatch).
      const actionDef = manifest.actions.find((a) => a.name === canonicalAction);
      if (!actionDef) {
        throw badRequest(`action ${canonicalAction} not declared by ${ctx.businessId}@${version}`);
      }
      const validate = ajv.compile(actionDef.inputSchema as object);
      if (!validate(submission.input)) {
        throw unprocessable('INVALID_SCHEMA', 'input failed action schema', {
          errors: (validate.errors ?? []).slice(0, 50).map((e) => ({
            pointer: e.instancePath || '/',
            message: e.message ?? 'invalid',
          })),
        });
      }

      const requestHash = canonicalRequestHash({
        input: submission.input,
        artifacts: submission.artifacts,
        output: submission.output,
        callback: submission.callback,
        sourceUrl: submission.sourceUrl,
      });

      // Fast path: existing idempotency record for this scope+key.
      if (ctx.idempotencyKey) {
        const existing = await findSubmissionKey(
          db,
          ctx.tenantId,
          ctx.apiKeyId,
          routeAction,
          ctx.idempotencyKey
        );
        if (existing) {
          if (existing.request_hash !== requestHash) {
            throw conflict(
              'IDEMPOTENCY_CONFLICT',
              'Idempotency-Key reused with a different request body'
            );
          }
          const op = await loadOperationView(db, existing.operation_id);
          return { operation: op, replayed: true, correlationId };
        }
      }

      const operationId = randomUUID();
      const rootTaskId = randomUUID();
      const deliveryId = randomUUID();
      const ttlSeconds = ctx.idempotencyTtlSeconds ?? 24 * 3600;

      const created = await db.tx(async (client) => {
        // Recheck under row locks inside the write transaction so an artifact
        // cannot expire or leave READY between preflight validation and the
        // operation/outbox commit.
        await assertReadyTenantArtifacts(
          (ids, tenantId) => client.query<SubmissionArtifactRow>(ARTIFACT_REFERENCE_QUERY, [ids, tenantId]),
          referencedArtifactIds,
          ctx.tenantId
        );

        // Re-check idempotency inside the tx to close the concurrent-submit race
        // (unique constraint is the ultimate authority; this avoids a duplicate
        // operation row before the constraint fires).
        if (ctx.idempotencyKey) {
          const dup = await client.query(
            `SELECT operation_id, request_hash FROM submission_keys
             WHERE tenant_id=$1 AND api_key_id=$2 AND route_action=$3 AND key=$4 FOR UPDATE`,
            [ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey]
          );
          if (dup.rowCount && dup.rowCount > 0) {
            const row = dup.rows[0] as { operation_id: string; request_hash: string };
            if (row.request_hash !== requestHash) {
              throw conflict('IDEMPOTENCY_CONFLICT', 'Idempotency-Key reused with a different request body');
            }
            return { operationId: row.operation_id, replayed: true };
          }
        }

        await client.query(
          `INSERT INTO operations
             (id, tenant_id, api_key_id, business_id, business_version, action, state, state_version,
              root_task_id, input_ref, correlation_id, callback_url,
              profile_id, profile_revision, connector_bindings, submit_artifacts)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15)`,
          [
            operationId,
            ctx.tenantId,
            ctx.apiKeyId,
            ctx.businessId,
            version,
            canonicalAction,
            submission.sourceUrl ? 'PENDING_INGESTION' : 'ACCEPTED',
            rootTaskId,
            JSON.stringify(submission.input),
            correlationId,
            // P2-08: callback destination pinned at submit (docs 06). The
            // webhook scheduler reads this on the terminal transition.
            submission.callback?.url ?? null,
            binding.mode === 'pinned' ? binding.profileId : null,
            binding.mode === 'pinned' ? binding.revision : null,
            // Post-pinned snapshot, not post-live: grants and claims read this
            // row; a revision change after submit affects new ops only.
            binding.mode === 'pinned' ? JSON.stringify(renderPinnedBindings(binding.bindings)) : null,
            // CR-12/MM-02: the submission-declared artifact refs (top-level
            // [{artifactId, role}], docs 06) are otherwise discarded here —
            // only `input` reached input_ref. Storing them verbatim lets the
            // result route project input roles without re-reading the
            // request; input_ref keeps its shape (claim snapshots read it as
            // the resolved action input). Migration 0009 defaults to '[]'
            // for pre-existing rows.
            JSON.stringify(submission.artifacts ?? []),
          ]
        );

        await client.query(
          `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, due_at)
           VALUES ($1,$2,'root',$3,$4,$5,0, now())`,
          [rootTaskId, operationId, manifest.runtime.handlerKinds.includes('root') ? 'root' : manifest.runtime.handlerKinds[0],
            JSON.stringify(submission.sourceUrl ? { input: submission.input, sourceUrl: submission.sourceUrl, ingestionState: 'PENDING' } : submission.input),
            submission.sourceUrl ? 'PENDING_INGESTION' : 'READY']
        );

        if (ctx.idempotencyKey) {
          await client.query(
            `INSERT INTO submission_keys (tenant_id, api_key_id, route_action, key, request_hash, operation_id, expires_at)
             VALUES ($1,$2,$3,$4,$5,$6, now() + ($7 || ' seconds')::interval)`,
            [ctx.tenantId, ctx.apiKeyId, routeAction, ctx.idempotencyKey, requestHash, operationId, String(ttlSeconds)]
          );
        }

        // Outbox dispatch row written in the SAME transaction as the state.
        await client.query(
          `INSERT INTO outbox (aggregate_id, type, delivery_id, payload)
           VALUES ($1,'task.dispatch',$2,$3)`,
          [
            rootTaskId,
            deliveryId,
            JSON.stringify({
              contractVersion: '1',
              deliveryId,
              taskId: rootTaskId,
              operationId,
              businessId: ctx.businessId,
              businessVersion: version,
              action: canonicalAction,
              kind: manifest.runtime.handlerKinds.includes('root') ? 'root' : manifest.runtime.handlerKinds[0],
              correlationId,
              gate: submission.sourceUrl ? 'ingestion' : undefined,
              sourceUrl: submission.sourceUrl,
            }),
          ]
        );

        return { operationId, replayed: false };
      });

      const op = await loadOperationView(db, created.operationId);
      return { operation: op, replayed: created.replayed, correlationId };
    },
  };
}

/** Validate URL syntax and the same outbound policy used by callback delivery. */
export function validateSourceUrl(value: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw unprocessable('INVALID_SCHEMA', 'sourceUrl must be a valid URL');
  }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
    throw unprocessable('INVALID_SCHEMA', 'sourceUrl must be an HTTPS URL without credentials');
  }
  const decision = adjudicateUrlDestination(value);
  if (decision.kind === 'DENIED') {
    throw unprocessable('INVALID_SCHEMA', 'sourceUrl destination is not allowed');
  }
  return parsed;
}

/**
 * Completes the ingestion gate after the worker has acquired and pinned the
 * source. The business task is made READY only after the immutable version
 * and SHA-256 are recorded in its payload.
 *
 * Δ14 fix: BOTH rows — `operations.input_ref` and `tasks.payload_ref` — now
 * carry the byte-identical READY envelope built by the contract
 * (`withIngestionSource`: action input + canonical `source` pin, legacy
 * `__source` dropped). The worker-SDK claim resolution picks
 * `tasks.payload_ref` when it is non-empty and `operations.input_ref`
 * otherwise, so previously the pin could exist in one view and not the other
 * — the same task resolving to two different inputs depending on a branch
 * nobody owns. Envelope validation fails closed BEFORE any write: a receipt
 * that cannot pass `IngestionReceiptSchema` can never open a READY gate.
 */
export async function markIngestionReady(
  db: Db,
  operationId: string,
  receipt: IngestionReceipt,
  input: Record<string, unknown>,
  dispatch: { deliveryId: string; kind: string; correlationId: string },
  /**
   * W-INGEST-POST-LEASE-FENCE-1 (T180-D1): optional ownership fence executed
   * INSIDE the gate transaction, before any gate write. A preempted consumer
   * must abort atomically with the gate statements un-run; checking outside
   * the tx would leave the classic check-then-write race the fence exists
   * to close. The guard throws its own typed error; markIngestionReady
   * neither invents nor swallows it.
   */
  commitGuard?: (client: DbClient) => Promise<void>
): Promise<void> {
  const envelope = JSON.stringify(withIngestionSource(input, receipt));
  await db.tx(async (client) => {
    if (commitGuard) await commitGuard(client);
    await markIngestionReadyOn(client, operationId, receipt, input, dispatch, envelope);
  });
}

/**
 * The three gate statements, split from markIngestionReady so the
 * transaction (and any commit guard) belongs to the caller - this is how
 * the ingestion consumer runs fence and gate as ONE atomic unit while
 * every existing caller keeps the exact one-call behavior. Statements are
 * byte-identical to the historical body.
 */
export async function markIngestionReadyOn(
  client: DbClient,
  operationId: string,
  receipt: IngestionReceipt,
  input: Record<string, unknown>,
  dispatch: { deliveryId: string; kind: string; correlationId: string },
  envelope: string = JSON.stringify(withIngestionSource(input, receipt))
): Promise<void> {
    await client.query(
      `UPDATE operations
          SET state='QUEUED', state_version=state_version+1, input_ref=$2, updated_at=now()
        WHERE id=$1 AND state='PENDING_INGESTION'`,
      [operationId, envelope]
    );
    await client.query(
      `UPDATE tasks
          SET state='READY', payload_ref=$2, updated_at=now()
        WHERE operation_id=$1 AND task_key='root' AND state='PENDING_INGESTION'`,
      [operationId, envelope]
    );
    await client.query(
      `INSERT INTO outbox (aggregate_id, type, delivery_id, payload)
       SELECT id, 'task.dispatch', $2, $3 FROM tasks
        WHERE operation_id=$1 AND task_key='root' AND state='READY'`,
      [operationId, dispatch.deliveryId, JSON.stringify({
        contractVersion: '1', deliveryId: dispatch.deliveryId, operationId,
        kind: dispatch.kind, correlationId: dispatch.correlationId, gate: 'ready',
      })]
    );
}

/** Execute one durable ingestion task. The acquirer owns bounded HTTP/S3
 * transfer policy; this boundary only accepts its immutable receipt and then
 * opens the READY gate, so retries can reuse the pinned copy. */
export async function processIngestionTask(
  db: Db,
  operationId: string,
  sourceUrl: string,
  acquirer: SourceAcquirer,
  input: Record<string, unknown>,
  dispatch: { deliveryId: string; kind: string; correlationId: string },
  /** W-INGEST-POST-LEASE-FENCE-1: forwarded verbatim into the gate tx (see markIngestionReady). */
  commitGuard?: (client: DbClient) => Promise<void>
): Promise<IngestionReceipt> {
  validateSourceUrl(sourceUrl);
  const receipt = await acquirer.acquire(sourceUrl);
  if (!/^sha256:[0-9a-f]{64}$/i.test(`sha256:${receipt.sha256.replace(/^sha256:/i, '')}`)) {
    throw new Error('ingestion acquirer returned an invalid SHA-256 receipt');
  }
  await markIngestionReady(db, operationId, receipt, input, dispatch, commitGuard);
  return receipt;
}

interface SubmissionArtifactRow {
  id: string;
  state: string;
  expired: boolean;
}

const ARTIFACT_REFERENCE_QUERY = `
  SELECT id, state, (expires_at IS NOT NULL AND expires_at <= now()) AS expired
  FROM artifacts
  WHERE id = ANY($1::uuid[]) AND tenant_id = $2
  ORDER BY id
  FOR SHARE
`;

type ArtifactReferenceLookup = (
  artifactIds: string[],
  tenantId: string
) => Promise<{ rowCount: number | null; rows: SubmissionArtifactRow[] }>;

async function assertReadyTenantArtifacts(
  lookup: ArtifactReferenceLookup,
  artifactIds: string[],
  tenantId: string
): Promise<void> {
  if (artifactIds.length === 0) return;
  const result = await lookup(artifactIds, tenantId);
  const rowsById = new Map(result.rows.map((row) => [row.id, row]));
  for (const artifactId of artifactIds) {
    const artifact = rowsById.get(artifactId);
    // Tenant-scoped lookup deliberately treats unknown and foreign artifacts
    // alike, so the public API does not confirm another tenant's resource.
    if (!artifact || artifact.expired || artifact.state === 'EXPIRED' || artifact.state === 'DELETED') {
      throw notFound('artifact not found or expired');
    }
    if (artifact.state !== 'READY') {
      throw conflict('STATE_CONFLICT', 'all submitted artifacts must be READY');
    }
  }
}

function collectArtifactReferences(value: unknown): string[] {
  const ids = new Set<string>();
  const pending: unknown[] = [value];
  while (pending.length > 0) {
    const current = pending.pop();
    if (Array.isArray(current)) {
      pending.push(...current);
      continue;
    }
    if (typeof current !== 'object' || current === null) continue;
    const record = current as Record<string, unknown>;
    const artifactId = record.artifactId;
    if (typeof artifactId === 'string' && ARTIFACT_ID_PATTERN.test(artifactId)) {
      ids.add(artifactId.toLowerCase());
    }
    pending.push(...Object.values(record));
  }
  return [...ids].sort();
}

function assertEmbeddedInputByteBudget(input: unknown, maxBytes: number): void {
  let totalBytes = 0;
  const pending: Array<{ value: unknown; key: string; inFileContainer: boolean }> = [
    { value: input, key: '', inFileContainer: false },
  ];

  const addBytes = (bytes: number): void => {
    totalBytes += bytes;
    if (totalBytes > maxBytes) {
      throw new HttpError(413, 'PAYLOAD_TOO_LARGE', 'embedded file data exceeds the configured byte limit');
    }
  };

  while (pending.length > 0) {
    const current = pending.pop()!;
    const { value, key, inFileContainer } = current;
    if (typeof value === 'string') {
      const dataUri = /^data:[^,]*;base64,([\s\S]*)$/i.exec(value);
      if (dataUri) {
        addBytes(base64ByteLength(dataUri[1]!));
      } else if (isEmbeddedByteField(key) || (inFileContainer && /^(data|content|body)$/i.test(key))) {
        addBytes(isBase64(value) ? base64ByteLength(value) : Buffer.byteLength(value, 'utf8'));
      }
      continue;
    }
    if (Array.isArray(value)) {
      if ((isEmbeddedByteField(key) || (inFileContainer && /^(data|content|body)$/i.test(key))) &&
          value.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) {
        addBytes(value.length);
        continue;
      }
      for (const item of value) pending.push({ value: item, key: '', inFileContainer });
      continue;
    }
    if (typeof value !== 'object' || value === null) continue;

    const record = value as Record<string, unknown>;
    if (record.type === 'Buffer' && Array.isArray(record.data) &&
        record.data.every((item) => typeof item === 'number' && Number.isInteger(item) && item >= 0 && item <= 255)) {
      addBytes(record.data.length);
      continue;
    }
    const objectHasFileName = Object.keys(record).some((childKey) => {
      const normalizedKey = childKey.toLowerCase().replace(/[_-]/g, '');
      return normalizedKey === 'filename' || normalizedKey === 'originalfilename';
    });
    for (const [childKey, childValue] of Object.entries(record)) {
      const normalizedKey = childKey.toLowerCase().replace(/[_-]/g, '');
      const childInFileContainer = inFileContainer || normalizedKey === 'file' || normalizedKey === 'files' ||
        normalizedKey === 'upload' || normalizedKey === 'uploads' || objectHasFileName;
      pending.push({ value: childValue, key: childKey, inFileContainer: childInFileContainer });
    }
  }
}

function isEmbeddedByteField(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[_-]/g, '');
  return normalized.includes('base64') || [
    'bytes', 'file', 'filebytes', 'rawbytes', 'binary', 'binarydata', 'blob', 'blobdata', 'filedata', 'filecontent',
  ].includes(normalized);
}

function isBase64(value: string): boolean {
  const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  return /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(normalized);
}

function base64ByteLength(value: string): number {
  const normalized = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!isBase64(normalized)) return Buffer.byteLength(value, 'utf8');
  const padding = normalized.endsWith('==') ? 2 : normalized.endsWith('=') ? 1 : 0;
  return Math.max(0, (normalized.length * 3) / 4 - padding);
}

async function resolveEnabledVersion(db: Db, businessId: string, action: string) {
  // New submissions target the explicitly ACTIVE enabled version (W28-C).
  // The admin activate/deactivate routes and enableVersionForTest maintain
  // the active pointer. Fail-closed: if no version is active, the business
  // cannot receive new submissions until an operator activates a version.
  // This prevents a drained version from being silently re-selected by a
  // "newest ENABLED" ordering heuristic (W27-A Case 10 / W28-C review).
  const res = await db.query(
    `SELECT version, manifest, digest, queue FROM business_versions
     WHERE business_id=$1 AND is_active=true
     LIMIT 1`,
    [businessId]
  );
  if (!res.rowCount || res.rowCount === 0) {
    throw new HttpError(404, 'NOT_FOUND', `no active version for business ${businessId}; activate one via the admin API`);
  }
  const row = res.rows[0] as { version: string; manifest: BusinessManifest; digest: string; queue: string };
  if (!row.manifest.actions.some((a) => a.name === action)) {
    throw badRequest(`action ${action} not offered by ${businessId}@${row.version}`);
  }
  return { version: row.version, manifest: row.manifest, digest: row.digest, queue: row.queue };
}

async function findSubmissionKey(
  db: Db,
  tenantId: string,
  apiKeyId: string,
  routeAction: string,
  key: string
): Promise<{ operation_id: string; request_hash: string } | null> {
  const res = await db.query(
    `SELECT operation_id, request_hash FROM submission_keys
     WHERE tenant_id=$1 AND api_key_id=$2 AND route_action=$3 AND key=$4 AND expires_at > now()`,
    [tenantId, apiKeyId, routeAction, key]
  );
  return res.rowCount ? (res.rows[0] as { operation_id: string; request_hash: string }) : null;
}

export async function loadOperationView(db: Db, operationId: string): Promise<OperationView> {
  const res = await db.query(
    `SELECT id, tenant_id, business_id, business_version, action, state, state_version,
            created_at, updated_at, deadline_at, result_ref
     FROM operations WHERE id=$1`,
    [operationId]
  );
  if (!res.rowCount) {
    throw new HttpError(404, 'NOT_FOUND', `operation ${operationId} not found`);
  }
  const r = res.rows[0] as Record<string, unknown>;
  return {
    id: r.id as string,
    tenantId: r.tenant_id as string,
    businessId: r.business_id as string,
    businessVersion: r.business_version as string,
    action: r.action as string,
    state: r.state as OperationView['state'],
    stateVersion: r.state_version as number,
    createdAt: new Date((r.created_at as string) ?? new Date().toISOString()).toISOString(),
    updatedAt: new Date((r.updated_at as string) ?? new Date().toISOString()).toISOString(),
    deadlineAt: r.deadline_at ? new Date(r.deadline_at as string).toISOString() : null,
    progress: { percent: 0, message: r.state as string },
    links: {
      self: `/api/v1/operations/${String(r.id)}`,
      result: `/api/v1/operations/${String(r.id)}/result`,
    },
  };
}
