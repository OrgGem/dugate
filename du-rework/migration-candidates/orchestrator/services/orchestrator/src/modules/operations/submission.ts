import { createHash, randomUUID } from 'node:crypto';
import { authorizeS3Source, parseS3Source, type S3SourceRule } from './s3-source';
import {
  BusinessManifest,
  OperationView,
  PROFILE_JOB_PRIORITY_DEFAULT,
  ProfilePolicySnapshotSchema,
  SubmissionSchema,
  canonicalRequestHash,
  normalizeRouteAction,
  adjudicateUrlDestination,
  withIngestionSource,
  type IngestionReceipt,
  type ProfilePolicySnapshot,
  type PromptOverrideRead,
  type PinnedPromptOverride,
} from '@du/contracts';
import { normalizeCorrelationId } from '@du/observability';
import type { MetadataCrypto, MetadataSlot } from '../runtime/metadata-crypto';
import { Db } from '../../db/db';
import { RegistryService } from '../registry/registry';
import {
  ProfileService,
  renderPinnedBindings,
  type EffectiveProfile,
} from '../profiles/profiles';
import { bullMqPriorityFor, extensionDeniedReason, fileUrlEntryName } from '../profiles/policy';
import { fileUrlAuthConfigCarriesSecret } from '../profiles/file-url-auth';
import type { PromptOverrideService } from '../profiles/prompt-overrides';
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
  s3SourceRules?: readonly S3SourceRule[];

  /**
   * P745-PRODUCER (step 1, marker-only): the prompt-override bucket, read
   * ONCE at admission for pinned-mode submissions. What lands on the row is
   * non-secret revision markers only (per-step content digests) — the prompt
   * content itself stays in `connector_prompt_overrides` until the phase-2
   * sealed carrier (Δ-1). Absent = the historical NULL pin; the claim then
   * keeps its zero-value `{}` map, so an unwired deployment is byte-identical.
   */
  promptOverrides?: PromptOverrideService;

  /**
   * CR28-04: seal `operations.input_ref` / `tasks.payload_ref` before the
   * writing transaction opens, so tenant content never rests as plaintext.
   *
   * Optional, exactly like the runtime seam: absent means the deployment has
   * control-plane encryption OFF and every statement below is byte-identical to
   * the historical body. It is a seam, NOT a policy: this module never
   * decides whether a key is required.
   */
  metadataCrypto?: MetadataCrypto;
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

/**
 * CR28-04: seal a submit-side control-plane value.
 *
 * Mirrors the runtime seam's `sealMetadata` (runtime.ts:206) rather than
 * importing it, because that helper is module-private and importing across
 * operations -> runtime would invert the dependency the modules currently
 * have. The duplication is three lines on purpose: if the two ever diverge,
 * the cross-check test in runtime-encryption-metadata.test.ts fails, because
 * an envelope written by one and opened by the other must still agree.
 *
 * CRX-01: the VALUE is sealed as given (an object for the control-plane JSON
 * columns), not its pre-serialized text — an opened envelope then reproduces
 * the exact JSON shape the plaintext column held (`operations.input_ref` /
 * `tasks.payload_ref` read back as objects, which is what the execution
 * snapshot the worker SDK parses requires). Sealing the JSON text instead
 * made opened values come back as strings, a shape no reader of a jsonb
 * object column expects.
 */
export async function sealSubmitMetadata(
  crypto: MetadataCrypto | undefined,
  value: unknown,
  tenantId: string,
  slot: MetadataSlot,
  refId: string
): Promise<string> {
  // The return value is the COLUMN VALUE ready to bind: these are jsonb
  // columns, so both branches produce the JSON text the driver binds. With no
  // seam this is the historical serialization byte-for-byte (a string value is
  // already text and is not double-encoded).
  if (!crypto) return typeof value === 'string' ? value : JSON.stringify(value);
  return JSON.stringify(await crypto.seal(value, { tenantId, slot, refId }));
}

/**
 * ENC-META-FIX-G1: the outbox dispatch payload carries the submission's
 * sourceUrl so the ingestion gate can cross-check it against the task row.
 * That copy is sealed with the SAME seam as the columns, under the SAME
 * binding the root task payload uses (tenant + 'tasks.payload_ref' + root
 * task id), so the pg `outbox.payload` row never holds the URL in plaintext
 * while the sealed task row holds the same value: the gate opens BOTH copies
 * with the one context it already builds. With no seam the value passes
 * through as the historical plaintext string, byte-for-byte (the seam stays
 * opt-in per deployment). Unlike `sealSubmitMetadata`, the result is the
 * envelope OBJECT, not column text: this value is embedded inside the outbox
 * payload JSON instead of bound to a jsonb column.
 */
async function sealOutboxSourceUrl(
  crypto: MetadataCrypto | undefined,
  sourceUrl: string | undefined,
  tenantId: string,
  rootTaskId: string
): Promise<unknown> {
  if (sourceUrl === undefined) return undefined;
  if (!crypto) return sourceUrl;
  return crypto.seal(sourceUrl, { tenantId, slot: 'tasks.payload_ref', refId: rootTaskId });
}

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
  // CR28-04: optional seam; absent = plaintext, historical statements.
  const metadataCrypto = options.metadataCrypto;
  // P745-PRODUCER (step 1): optional; absent = NULL pin, historical claims.
  const promptOverrides = options.promptOverrides;

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
      // RCR-03: the replay lookup is scoped by the CALLER (tenant, apiKeyId,
      // route) and decided BEFORE any admission-policy read. A version that
      // was deactivated, a profile edit, an artifact expiry, or the storage
      // backend flipping since the ORIGINAL acceptance must not turn a
      // same-key replay of an ACCEPTED operation into a 404/409 — T-SUB-04's
      // own rationale ("a profile edit cannot break a replay") extended to
      // every admission input. Current admission rules still apply to NEW
      // requests, immediately below. The key/tenant fence is untouched: the
      // lookup is scoped by (tenant, apiKeyId, routeAction).
      const correlationId = normalizeCorrelationId(ctx.correlationId);
      const canonicalAction = ctx.alias ?? ctx.action;
      const routeAction = normalizeRouteAction(ctx.businessId, ctx.action, ctx.alias);
      // T-SUB-04: the idempotency hash stays on the RAW client input, never on
      // the effective input. A profile edit between two retries of the same
      // Idempotency-Key must replay the original operation, not a second one
      // built from the new defaults — hashing the merged map would turn every
      // admin edit into an IDEMPOTENCY_CONFLICT for in-flight clients.
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
      if (submission.sourceUrl) {
        validateSourceUrl(submission.sourceUrl);
        if (submission.sourceUrl.startsWith('s3://')) {
          try { authorizeS3Source(submission.sourceUrl, ctx.tenantId, options.s3SourceRules ?? []); }
          catch { throw new HttpError(403, 'PERMISSION_DENIED', 'S3 source is not allowed for this tenant'); }
        }
      }
      assertEmbeddedInputByteBudget(submission.input, maxBlobBytes);
      const referencedArtifactIds = collectArtifactReferences(submission);
      await assertReadyTenantArtifacts(
        (ids, tenantId) => db.query<SubmissionArtifactRow>(ARTIFACT_REFERENCE_QUERY, [ids, tenantId]),
        referencedArtifactIds,
        ctx.tenantId
      );

      // Resolve the registered+enabled version (slice submits against the
      // single enabled version per business/action).
      const enabled = await resolveEnabledVersion(db, ctx.businessId, canonicalAction);
      const { version, manifest, digest, queue } = enabled;

      const actionDef = manifest.actions.find((a) => a.name === canonicalAction);
      if (!actionDef) {
        throw badRequest(`action ${canonicalAction} not declared by ${ctx.businessId}@${version}`);
      }

      // PAR-XA-03: the ONE admission seam. T-SUB-01 — everything this call can
      // refuse (profile disabled, profile unknown, unauthorized key, a locked
      // parameter) is refused HERE, before the first `randomUUID` (:314) and therefore
      // before the operations/tasks/submission_keys/outbox inserts. A denied
      // submit leaves zero rows behind.
      //
      // T-SUB-02 note: the same call that authorizes the profile also returns
      // the whole effective policy, so the snapshot below is a value we already
      // hold rather than a second read that could disagree with the decision.
      const profile = await profiles.resolveEffectiveProfile(
        ctx.apiKeyId,
        ctx.businessId,
        version,
        canonicalAction,
        submission.input as Record<string, unknown>,
        declaredParameterKeys(actionDef.inputSchema as object)
      );
      // The profile already split its managed keys from the rest; the merged
      // result is what the worker runs, and AJV still judges the remainder.
      const effectiveInput: Record<string, unknown> =
        profile.mode === 'pinned' ? profile.effectiveInput : (submission.input as Record<string, unknown>);

      // Validate the EFFECTIVE input (client values merged over profile
      // defaults) against the action's inputSchema (422 on mismatch). Validating
      // the merged map rather than the raw client body is a deliberate change:
      // it is the map the worker will actually run, so a profile default that no
      // longer satisfies the action schema fails here — at submit, with a 422
      // the caller can act on — instead of surfacing as a worker error hours
      // later. The two cases differ only when the client OMITTED a key, which
      // is exactly the case where the default decides the outcome.
      const validate = ajv.compile(actionDef.inputSchema as object);
      if (!validate(effectiveInput)) {
        throw unprocessable('INVALID_SCHEMA', 'input failed action schema', {
          errors: (validate.errors ?? []).slice(0, 50).map((e) => ({
            pointer: e.instancePath || '/',
            message: e.message ?? 'invalid',
          })),
        });
      }

      // T-SUB-04 note: the idempotency hash / replay lookup now run BEFORE
      // admission (RCR-03) — see the top of submit(). Everything from here
      // down applies to NEW requests only.

      const operationId = randomUUID();
      const rootTaskId = randomUUID();
      const deliveryId = randomUUID();
      const ttlSeconds = ctx.idempotencyTtlSeconds ?? 24 * 3600;

      // P745-CARRIER-IMPL-A (Δ-PC-1): resolve the override bucket ONCE here,
      // at admission, and build BOTH pins from the same rows so they cannot
      // disagree by construction. Caps are checked first: a 422 leaves zero
      // rows and zero Vault calls behind. Markers stay exactly the phase-1
      // shape (non-secret digests); the carrier (below) is the content.
      const promptOverrideRows =
        profile.mode === 'pinned' && promptOverrides
          ? await promptOverrides.listFor(ctx.apiKeyId, canonicalAction, ctx.tenantId)
          : [];
      const promptRevisionsPin =
        profile.mode === 'pinned' && promptOverrides
          ? JSON.stringify(buildPromptRevisionsPin(promptOverrideRows))
          : null;
      const promptCarrierRows = buildPromptCarrier(promptOverrideRows);
      assertPromptCarrierCaps(promptCarrierRows);

      // CR28-04/CRX-01: seal BEFORE the writing transaction, not inside it. Two
      // reasons, both load-bearing:
      //  1. A key-provider failure must abort the submit with nothing written.
      //     Sealing inside the tx would still roll back, but it would hold a
      //     write transaction open across a network call to Vault.
      //  2. The AAD binds each envelope to its OWN row (operationId for
      //     input_ref, rootTaskId for payload_ref), which is why these cannot
      //     be one shared value even though both derive from `submission`.
      // The sealed value replaces the plaintext in the column and opens back to
      // the same JSON shape the plaintext had (object in, object out).
      // T-SUB-02 / PRF-02: the sealed payload carries the EFFECTIVE input, the
      // same map AJV validated above — not the raw client body. The profile's
      // defaults are what the worker must run; storing the raw body would make
      // the stored input disagree with the validated one and force the worker
      // to re-derive (or ignore) the merge. The idempotency hash above is the
      // deliberate exception: it stays on the raw body so an admin edit cannot
      // turn a retry into IDEMPOTENCY_CONFLICT.
      const taskPayloadValue = submission.sourceUrl
        ? { input: effectiveInput, sourceUrl: submission.sourceUrl, ingestionState: 'PENDING' }
        : effectiveInput;
      const sealedInputRef = await sealSubmitMetadata(metadataCrypto, effectiveInput, ctx.tenantId, 'operations.input_ref', operationId);
      const sealedTaskPayload = await sealSubmitMetadata(metadataCrypto, taskPayloadValue, ctx.tenantId, 'tasks.payload_ref', rootTaskId);
      // P745-CARRIER-IMPL-A (Δ-PC-1): adjudication 1c — no seam OR no rows ⇒
      // NULL carrier (markers stay; content never degrades to plaintext). The
      // seal happens BEFORE the tx like input_ref: a key-provider failure must
      // abort the submit with nothing written (CR28-04 reasons above).
      const sealedPromptCarrier =
        metadataCrypto && promptCarrierRows.length > 0
          ? await sealSubmitMetadata(
              metadataCrypto,
              promptCarrierRows,
              ctx.tenantId,
              'operations.prompt_overrides_ref',
              operationId
            )
          : null;
      // ENC-META-FIX-G1: the outbox copy of the URL is sealed BEFORE the
      // transaction for the same reason as the columns: a key-provider
      // failure must abort the submit with nothing written, and no Vault call
      // may sit inside the write tx.
      const sealedOutboxSourceUrl = await sealOutboxSourceUrl(metadataCrypto, submission.sourceUrl, ctx.tenantId, rootTaskId);

      const created = await db.tx(async (client) => {
        // Recheck under row locks inside the write transaction so an artifact
        // cannot expire or leave READY between preflight validation and the
        // operation/outbox commit.
        const lockedArtifacts = await assertReadyTenantArtifacts(
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

        // T-SUB-03: the extension list, enforced AFTER the replay check so a
        // same-key retry still replays its original operation even if an admin
        // has since narrowed the profile, and BEFORE the first INSERT so a
        // refused submission leaves zero rows behind.
        if (profile.mode === 'pinned') {
          assertProfileExtensionAllowed(
            profile.policy.allowedFileExtensions,
            lockedArtifacts,
            effectiveInput,
            submission.sourceUrl
          );
        }

        await client.query(
          `INSERT INTO operations
             (id, tenant_id, api_key_id, business_id, business_version, action, state, state_version,
              root_task_id, input_ref, correlation_id, callback_url,
              profile_id, profile_revision, connector_bindings, submit_artifacts,
              profile_policy_snapshot, prompt_revisions_pin, prompt_overrides_ref)
             VALUES ($1,$2,$3,$4,$5,$6,$7,1,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
          [
            operationId,
            ctx.tenantId,
            ctx.apiKeyId,
            ctx.businessId,
            version,
            canonicalAction,
            submission.sourceUrl ? 'PENDING_INGESTION' : 'ACCEPTED',
            rootTaskId,
            sealedInputRef,
            correlationId,
            // P2-08: callback destination pinned at submit (docs 06). The
            // webhook scheduler reads this on the terminal transition.
            submission.callback?.url ?? null,
            profile.mode === 'pinned' ? profile.profileId : null,
            profile.mode === 'pinned' ? profile.revision : null,
            // Post-pinned snapshot, not post-live: grants and claims read this
            // row; a revision change after submit affects new ops only.
            profile.mode === 'pinned' ? JSON.stringify(renderPinnedBindings(profile.bindings)) : null,
            // CR-12/MM-02: the submission-declared artifact refs (top-level
            // [{artifactId, role}], docs 06) are otherwise discarded here —
            // only `input` reached input_ref. Storing them verbatim lets the
            // result route project input roles without re-reading the
            // request; input_ref keeps its shape (claim snapshots read it as
            // the resolved action input). Migration 0009 defaults to '[]'
            // for pre-existing rows.
            JSON.stringify(submission.artifacts ?? []),
            // T-SUB-02 / PRF-02: the admission-time policy record. NULL means
            // "no profile policy applied" (legacy mode, or a pre-0026 row) and
            // must never be coalesced into an empty policy by a consumer.
            //
            // PLAN04-01: this is the snapshot DTO, NOT the resolved
            // `profile.policy`. `profile.policy.fileUrlAuthConfig` is DECRYPTED
            // PLAINTEXT (profiles.ts decodePolicy), so serializing it here wrote
            // a live token/header/query into a jsonb column that no encryption
            // seam covers, and the claim then handed it to the worker. The
            // builder drops the secret and keeps the immutable
            // `(tenantId, profileId, profileRevision)` ref instead.
            profile.mode === 'pinned'
              ? JSON.stringify(
                  buildProfilePolicySnapshot(profile, ctx.tenantId)
                )
              : null,
            // P745-PRODUCER (step 1): the admission-time prompt-revision
            // markers (non-secret digests). NULL for legacy mode / unwired.
            promptRevisionsPin,
            // P745-CARRIER-IMPL-A (Δ-PC-1): the sealed content carrier (JSON
            // text of the ENC-META envelope), or NULL per adjudication 1c.
            sealedPromptCarrier,
          ]
        );

        await client.query(
          `INSERT INTO tasks (id, operation_id, task_key, kind, payload_ref, state, attempt, due_at)
           VALUES ($1,$2,'root',$3,$4,$5,0, now())`,
          [rootTaskId, operationId, manifest.runtime.handlerKinds.includes('root') ? 'root' : manifest.runtime.handlerKinds[0],
            sealedTaskPayload,
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
              // T-SUB-03: the BullMQ priority travels in the outbox row because
              // the outbox is what actually enqueues (dispatcher.ts). Legacy
              // mode has no profile priority, and legacy's
              // `resolveBullPriority(undefined)` returned MEDIUM — so an
              // unbound key keeps exactly the number it had before.
              priority:
                profile.mode === 'pinned'
                  ? profile.bullMqPriority
                  : bullMqPriorityFor(PROFILE_JOB_PRIORITY_DEFAULT),
              gate: submission.sourceUrl ? 'ingestion' : undefined,
              // ENC-META-FIX-G1: sealed envelope (or the historical plaintext
              // string when no seam is configured) - see sealOutboxSourceUrl.
              sourceUrl: sealedOutboxSourceUrl,
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

/**
 * T-SUB-02 / PLAN04-01 — build the admission-time policy snapshot.
 *
 * The resolved `profile.policy` carries `fileUrlAuthConfig` as DECRYPTED
 * PLAINTEXT. This builder is the single place that decides what leaves the
 * process, and the decision is: keep the effective non-secret policy, replace
 * the credential with a boolean plus an immutable ref to the pinned revision.
 *
 * `fileUrlAuthConfigCarriesSecret` is the same predicate the write path uses
 * to decide whether a config is a credential at all; reusing it here means the
 * snapshot cannot disagree with the encrypt path about what counts as a secret.
 *
 * Runtime-validated before it is written. A snapshot that does not satisfy the
 * contract fails the SUBMIT (500) rather than being persisted and failing
 * closed later at claim time — an admission record that cannot be read back
 * is not an admission record.
 */
function buildProfilePolicySnapshot(
  profile: Extract<EffectiveProfile, { mode: 'pinned' }>,
  tenantId: string
): ProfilePolicySnapshot {
  const parsed = ProfilePolicySnapshotSchema.safeParse({
    enabled: profile.policy.enabled,
    parameters: profile.policy.parameters,
    jobPriority: profile.policy.jobPriority,
    allowedFileExtensions: profile.policy.allowedFileExtensions,
    connectionsOverride: profile.policy.connectionsOverride,
    fileUrlAuthConfigured: fileUrlAuthConfigCarriesSecret(profile.policy.fileUrlAuthConfig),
    credentialRef: {
      tenantId,
      profileId: profile.profileId,
      profileRevision: profile.revision,
    },
  });
  if (!parsed.success) {
    throw new HttpError(
      500,
      'INVALID_SCHEMA',
      'resolved profile policy does not satisfy the snapshot contract',
      {
        errors: parsed.error.issues.slice(0, 50).map((i) => ({
          pointer: '/profilePolicy/' + i.path.join('/'),
          message: i.message,
        })),
      }
    );
  }
  return parsed.data;
}

/**
 * P745-PRODUCER (step 1, marker-only): the non-secret prompt-revision markers.
 *
 * One marker per override row that actually carries a prompt (named steps and
 * `_default` alike). A cleared row (`promptOverride: null`) pins NOTHING: the
 * effective prompt at that step is the default, and a marker would claim a
 * revision that does not exist. The revision is a content digest scoped to
 * its row identity; the prompt content itself never leaves
 * `connector_prompt_overrides` in this phase (Δ-1 owns the sealed carrier).
 * The array is sorted so two admissions of the same bucket pin byte-identical
 * JSON regardless of row order.
 */
export interface PromptRevisionMarker {
  connectionId: string;
  stepId: string;
  revision: string;
}

export function buildPromptRevisionsPin(
  rows: readonly PromptOverrideRead[]
): PromptRevisionMarker[] {
  return rows
    .filter((row) => typeof row.promptOverride === 'string' && row.promptOverride.length > 0)
    .map((row) => ({
      connectionId: row.connectionId,
      stepId: row.stepId,
      revision:
        'sha256:' +
        createHash('sha256')
          .update(`${row.connectionId}|${row.stepId}|${row.promptOverride}`)
          .digest('hex'),
    }))
    .sort((a, b) => {
      if (a.connectionId !== b.connectionId) return a.connectionId < b.connectionId ? -1 : 1;
      if (a.stepId !== b.stepId) return a.stepId < b.stepId ? -1 : 1;
      return 0;
    });
}

/**
 * P745-CARRIER-IMPL-A (Δ-PC-1, adjudication 1d): the content-carrier caps.
 * Exceeded ⇒ 422 `PROMPT_CARRIER_TOO_LARGE` BEFORE any seal or write, so an
 * oversized bucket can never hold a submit transaction open against Vault
 * (and can never silently truncate a prompt).
 */
export const PROMPT_CARRIER_LIMITS = {
  maxRows: 64,
  maxRowBytes: 16 * 1024,
  maxTotalBytes: 256 * 1024,
} as const;

/**
 * P745-CARRIER-IMPL-A (Δ-PC-1): the CONTENT carrier rows.
 *
 * Built from the SAME filtered/sorted row set as `buildPromptRevisionsPin`
 * (content-bearing rows only; cleared rows pin nothing in either shape), so
 * the claim's cross-check is an equality of two views of one list, not a
 * reconciliation of two reads. The revision formula is identical to the
 * marker's — phase 1 and phase 2 describe the same content with one hash.
 */
export function buildPromptCarrier(
  rows: readonly PromptOverrideRead[]
): PinnedPromptOverride[] {
  return rows
    .filter(
      (row): row is PromptOverrideRead & { promptOverride: string } =>
        typeof row.promptOverride === 'string' && row.promptOverride.length > 0
    )
    .map((row) => ({
      connectionId: row.connectionId,
      stepId: row.stepId,
      promptOverride: row.promptOverride,
      revision:
        'sha256:' +
        createHash('sha256')
          .update(`${row.connectionId}|${row.stepId}|${row.promptOverride}`)
          .digest('hex'),
    }))
    .sort((a, b) => {
      if (a.connectionId !== b.connectionId) return a.connectionId < b.connectionId ? -1 : 1;
      if (a.stepId !== b.stepId) return a.stepId < b.stepId ? -1 : 1;
      return 0;
    });
}

export function assertPromptCarrierCaps(rows: readonly PinnedPromptOverride[]): void {
  const { maxRows, maxRowBytes, maxTotalBytes } = PROMPT_CARRIER_LIMITS;
  if (rows.length > maxRows) {
    throw unprocessable('PROMPT_CARRIER_TOO_LARGE', `prompt override bucket exceeds ${maxRows} rows`);
  }
  let total = 0;
  for (const row of rows) {
    const bytes = Buffer.byteLength(row.promptOverride, 'utf8');
    if (bytes > maxRowBytes) {
      throw unprocessable('PROMPT_CARRIER_TOO_LARGE', `a prompt override exceeds ${maxRowBytes} bytes`);
    }
    total += bytes;
  }
  if (total > maxTotalBytes) {
    throw unprocessable('PROMPT_CARRIER_TOO_LARGE', `prompt override bucket exceeds ${maxTotalBytes} bytes in total`);
  }
}

/**
 * The parameter keys the action's inputSchema declares.
 *
 * These are the keys the profile is allowed to default or lock. Legacy
 * `mergeParameters` walked the union of the manifest's declared keys and the
 * DB profile's keys; the manifest half is what this extracts.
 */
export function declaredParameterKeys(inputSchema: object): string[] {
  const properties = (inputSchema as { properties?: unknown }).properties;
  if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) {
    return [];
  }
  return Object.keys(properties as Record<string, unknown>);
}

/** Validate URL syntax and the same outbound policy used by callback delivery. */
export function validateSourceUrl(value: string): URL {
  if (value.startsWith('s3://')) {
    try { parseS3Source(value); return new URL(value); }
    catch { throw unprocessable('INVALID_SCHEMA', 'sourceUrl must identify a valid S3 object'); }
  }
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
  commitGuard?: (client: DbClient) => Promise<void>,
  /** CR28-04: forwarded verbatim into the gate transaction. */
  metadataCrypto?: MetadataCrypto
): Promise<void> {
  const envelope = JSON.stringify(withIngestionSource(input, receipt));
  await db.tx(async (client) => {
    if (commitGuard) await commitGuard(client);
    await markIngestionReadyOn(client, operationId, receipt, input, dispatch, envelope, metadataCrypto);
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
  envelope: string = JSON.stringify(withIngestionSource(input, receipt)),
  /** CR28-04: seal the gate values; absent = plaintext, historical behaviour. */
  metadataCrypto?: MetadataCrypto
): Promise<void> {
    // CR28-04: the gate writes the SAME logical envelope into two columns, but
    // the AAD binds an envelope to (tenant, slot, row). One sealed value
    // therefore CANNOT serve both: a payload_ref blob copied into input_ref is
    // exactly what the slot binding exists to refuse. So each column is sealed
    // for its own row, which means the row identities have to be read first.
    // The read locks both rows in the SAME transaction as the gate writes, so
    // the id and tenant cannot change under the seal.
    let sealedOperationInput = envelope;
    let sealedTaskPayload = envelope;
    if (metadataCrypto) {
      const bound = await client.query(
        `SELECT o.tenant_id AS tenant_id, t.id AS task_id
           FROM operations o
           JOIN tasks t ON t.operation_id = o.id AND t.task_key = 'root'
          WHERE o.id=$1 AND o.state='PENDING_INGESTION' AND t.state='PENDING_INGESTION'
          FOR UPDATE OF o, t`,
        [operationId]
      );
      const row = bound.rows[0];
      // No row means the gate is already closed. The UPDATEs below are
      // rowCount-guarded and will simply not fire; sealing under a guessed
      // identity would be worse than writing nothing.
      if (row) {
        // CRX-01: seal the envelope VALUE (object), not its serialized text —
        // an opened gate envelope then has the same JSON shape the plaintext
        // column would have held, which is what the claim execution snapshot
        // (executionSnapshot.payloadRef, parsed by the worker SDK) requires.
        const readyEnvelope = withIngestionSource(input, receipt);
        sealedOperationInput = await sealSubmitMetadata(
          metadataCrypto, readyEnvelope, row.tenant_id as string, 'operations.input_ref', operationId
        );
        sealedTaskPayload = await sealSubmitMetadata(
          metadataCrypto, readyEnvelope, row.tenant_id as string, 'tasks.payload_ref', row.task_id as string
        );
      }
    }
    await client.query(
      `UPDATE operations
          SET state='QUEUED', state_version=state_version+1, input_ref=$2, updated_at=now()
        WHERE id=$1 AND state='PENDING_INGESTION'`,
      [operationId, sealedOperationInput]
    );
    await client.query(
      `UPDATE tasks
          SET state='READY', payload_ref=$2, updated_at=now()
        WHERE operation_id=$1 AND task_key='root' AND state='PENDING_INGESTION'`,
      [operationId, sealedTaskPayload]
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
  commitGuard?: (client: DbClient) => Promise<void>,
  /** CR28-04: forwarded verbatim into the gate transaction. */
  metadataCrypto?: MetadataCrypto
): Promise<IngestionReceipt> {
  validateSourceUrl(sourceUrl);
  const receipt = await acquirer.acquire(sourceUrl);
  if (!/^sha256:[0-9a-f]{64}$/i.test(`sha256:${receipt.sha256.replace(/^sha256:/i, '')}`)) {
    throw new Error('ingestion acquirer returned an invalid SHA-256 receipt');
  }
  await markIngestionReady(db, operationId, receipt, input, dispatch, commitGuard, metadataCrypto);
  return receipt;
}

interface SubmissionArtifactRow {
  id: string;
  state: string;
  expired: boolean;
  fileName: string | null;
}

const ARTIFACT_REFERENCE_QUERY = `
  SELECT id, state, file_name AS "fileName", (expires_at IS NOT NULL AND expires_at <= now()) AS expired
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
): Promise<SubmissionArtifactRow[]> {
  if (artifactIds.length === 0) return [];
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
  return result.rows;
}

/**
 * T-SUB-03 — the profile's `allowedFileExtensions` enforced at the ONE point
 * that knows which action (and therefore which profile) applies.
 *
 * Legacy enforced the same CSV in two places, both of which knew the endpoint:
 * `saveUploadedFile` at submit (lib/pipelines/submit.ts:195) and
 * `downloadAllFileUrls` at download (:278). du-rework's upload-init route
 * (`POST /api/v1/uploads`) is deliberately NOT one of them: it carries no
 * business/action, so the profile it would have to check is unknowable, and
 * guessing would 422 a legitimate upload against the wrong action's policy.
 * Submission is the gate; the download side is covered by the pinned snapshot
 * the worker reads (T-SUB-04).
 *
 * Only the EFFECTIVE input's `fileUrls` are checked — the raw body's copy is
 * what the idempotency hash covers, and a profile edit between two retries
 * must not turn a replay into a 422.
 */
function assertProfileExtensionAllowed(
  csv: string,
  artifacts: readonly SubmissionArtifactRow[],
  effectiveInput: Record<string, unknown>,
  sourceUrl: string | undefined
): void {
  // PLAN04-01: the top-level `sourceUrl` is a source acquisition path like any
  // other, and the plan names this gap explicitly. It is checked here rather
  // than left to the acquisition leg because admission is the ONE point that
  // knows which action (and therefore which profile) applies.
  //
  // The name comes from the URL path alone: this runs BEFORE any network call,
  // so it is a policy check on caller-supplied metadata, not a conclusion
  // about what the host will actually serve.
  if (sourceUrl !== undefined) {
    // `fileUrlEntryName` takes a `file_urls` ENTRY, not a bare string: it
    // returns null for anything that is not an object. Wrapping keeps the
    // extension resolution identical to the other two paths instead of
    // re-implementing the pathname rule a second time.
    const fileName = fileUrlEntryName({ url: sourceUrl });
    if (fileName !== null) {
      const reason = extensionDeniedReason(csv, fileName);
      if (reason) {
        throw unprocessable('PROFILE_EXTENSION_DENIED', `sourceUrl: ${reason}`, {
          errors: [{ pointer: '/sourceUrl', message: reason }],
        });
      }
    }
  }

  for (const artifact of artifacts) {
    if (!artifact.fileName) continue;
    const reason = extensionDeniedReason(csv, artifact.fileName);
    if (reason) {
      throw unprocessable('PROFILE_EXTENSION_DENIED', `artifact ${artifact.id}: ${reason}`, {
        errors: [{ pointer: '/artifacts', message: reason }],
      });
    }
  }

  const fileUrls = effectiveInput.fileUrls;
  if (!Array.isArray(fileUrls)) return;
  for (const [index, entry] of fileUrls.entries()) {
    // Legacy's own name resolution, minus Content-Disposition, which needs the
    // HTTP response and therefore belongs to the download leg.
    const fileName = fileUrlEntryName(entry);
    if (fileName === null) continue;
    const reason = extensionDeniedReason(csv, fileName);
    if (reason) {
      throw unprocessable('PROFILE_EXTENSION_DENIED', `file_urls[${index}]: ${reason}`, {
        errors: [{ pointer: `/fileUrls/${index}`, message: reason }],
      });
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
