// VENDORED from @du/contracts @ b088eececcb5f3df0b4edbe073a29401dafda624 (worktree 2026-10-05)
// source: packages/contracts/src/runtime.ts (lines=540) sha256=66656BD6CADFC79FA45BC2F91F089CBC94C4DF6F29B6429045ABE038A4FCA53C
// why: PinnedProfilePolicySchema, MULTIPART_MIN_TOTAL_BYTES for src/types/context.ts, src/actions/prompt-application.ts, src/pipelines/parser-budget.ts

import { z } from 'zod';
import { OperationStateSchema, TaskStateSchema } from './operations';
import { StorageEnvelopeRefSchema } from './encryption';
import { ProfilePolicySnapshotSchema } from './profile-policy';

/**
 * Runtime API DTOs (docs 07) — /api/runtime/v1.
 * Bearer service identity scoped to business/version; never public API keys.
 */

/* ------------------------------------------------------------------ */
/* Registration & heartbeat                                           */
/* ------------------------------------------------------------------ */

export const WorkerHeartbeatSchema = z.object({
  businessId: z.string().min(1),
  businessVersion: z.string().min(1),
  imageDigest: z.string().min(1),
  capacity: z.number().int().min(0),
});
export type WorkerHeartbeat = z.infer<typeof WorkerHeartbeatSchema>;

export const HeartbeatAckSchema = z.object({
  health: z.enum(['HEALTHY', 'DEGRADED', 'OFFLINE']),
  leaseExpiresAt: z.string(),
  capacity: z.number().int().min(0),
});
export type HeartbeatAck = z.infer<typeof HeartbeatAckSchema>;

/* ------------------------------------------------------------------ */
/* Claim / context                                                     */
/* ------------------------------------------------------------------ */

export const ClaimTaskRequestSchema = z.object({
  deliveryId: z.string().min(1),
  workerInstanceId: z.string().min(1),
  /** Worker manifest identity; claim is rejected unless this matches the task's business. */
  businessId: z.string().min(1),
});
export type ClaimTaskRequest = z.infer<typeof ClaimTaskRequestSchema>;

export const CheckpointRefSchema = z.object({
  stepKey: z.string().min(1),
  generation: z.number().int().min(0),
  inputHash: z.string().min(1),
  status: z.enum(['SUCCEEDED', 'FAILED', 'PENDING']),
  outputRef: z.string().optional(),
  sessionRef: z.string().nullable().optional(),
});
export type CheckpointRef = z.infer<typeof CheckpointRefSchema>;

/**
 * T-SUB-04 / PLAN04-01 — the claim carries the admission-time policy as the
 * SNAPSHOT DTO, not as the resolved `EffectiveProfilePolicy` and not as a
 * looser restatement of it.
 *
 * Re-exported from `profile-policy.ts` rather than restated here so the write
 * path (submit) and the read path (claim) cannot drift: one schema, two
 * directions.
 *
 * The change from the previous inline shape is the security fix. The old schema
 * declared `fileUrlAuthConfig` and wrapped BOTH the inner object and the outer
 * one in `.passthrough()`. `.passthrough()` copies unrecognized keys through
 * unexamined, so a stored plaintext token/header/query survived into the claim
 * no matter what the writer intended. `ProfilePolicySnapshotSchema` is
 * `.strict()`, carries `fileUrlAuthConfigured` (a boolean) instead of the
 * config, and adds the immutable `credentialRef` acquisition resolves.
 */
export const PinnedProfilePolicySchema = ProfilePolicySnapshotSchema;
export type PinnedProfilePolicy = z.infer<typeof PinnedProfilePolicySchema>;

/**
 * P745-CARRIER-IMPL-A (Δ-PC-1, adjudication 1f/1g) — one pinned prompt-override
 * row as delivered to the consumer.
 *
 * The CONTENT is sensitive: at rest it lives only inside the sealed ENC-META
 * envelope of `operations.prompt_overrides_ref`; this shape appears on the
 * wire only in the claim response (worker-authenticated, transient), mirroring
 * how `resolvedInputRef` already travels. `revision` mirrors the `sha256:`
 * marker in `pinned.promptRevisions` so the claim can cross-check carrier and
 * markers, and a consumer can tell what it applies.
 */
export const PinnedPromptOverrideSchema = z.object({
  connectionId: z.string().min(1),
  stepId: z.string().min(1),
  promptOverride: z.string().min(1),
  revision: z.string().regex(/^sha256:[0-9a-f]{64}$/),
});
export type PinnedPromptOverride = z.infer<typeof PinnedPromptOverrideSchema>;

export const ExecutionSnapshotSchema = z.object({
  operationId: z.string().uuid(),
  tenantId: z.string(),
  businessId: z.string(),
  businessVersion: z.string(),
  action: z.string(),
  schemaDigest: z.string(),
  manifestDigest: z.string(),
  /** Resolved input reference (artifact ref or inline JSON pointer), never raw secrets. */
  resolvedInputRef: z.record(z.string(), z.unknown()),
  /** Pinned revisions: profile revision, prompt overrides, connector bindings. */
  pinned: z.object({
    profileRevision: z.number().int(),
    promptRevisions: z.record(z.string(), z.string()).default({}),
    /**
     * P745-CARRIER-IMPL-B1 (Δ-PC-1): the pinned prompt CONTENT rows for this
     * operation, opened from the sealed `operations.prompt_overrides_ref`
     * column at claim time (orchestrator holds the key; the worker never
     * does). `null` means "no content carrier" — a legacy operation, a
     * deployment without metadata encryption (adjudication 1c: markers are
     * still written, content stays dark), or a bucket with no rows. NOT an
     * empty array, and NOT absent: the runtime always writes the key, so
     * ABSENT only appears on pre-field wire shapes and keeps its historical
     * meaning (no carrier information). Consumers keep the connector default
     * on null AND absent.
     */
    promptOverrides: z.array(PinnedPromptOverrideSchema).nullable().optional(),
    connectorBindings: z.record(z.string(), z.string()).default({}), // slot → connectorId@revision
    /**
     * T-SUB-04 / PRF-02: the admission-time policy, captured at submit into
     * `operations.profile_policy_snapshot` and read back from THAT column —
     * never from `profile_bindings`. This is the field that makes a mid-flight
     * profile revision change invisible to an in-flight operation.
     *
     * `nullable` is load-bearing and must stay: NULL means "no profile policy
     * was applied" (legacy mode, or an operation admitted before migration
     * 0026), which is a different answer from "an empty policy was applied".
     * A consumer that coalesced this to `{}` would apply default parameters to
     * an operation that was explicitly admitted without any.
     */
    profilePolicy: PinnedProfilePolicySchema.nullable().default(null),
  }),
  taskKey: z.string(),
  kind: z.string(),
  payloadRef: z.record(z.string(), z.unknown()).default({}),
  deadlineAt: z.string().nullable(),
  cancelRequested: z.boolean().default(false),
});
export type ExecutionSnapshot = z.infer<typeof ExecutionSnapshotSchema>;

export const ClaimResultSchema = z.object({
  taskId: z.string().uuid(),
  operationId: z.string().uuid(),
  leaseEpoch: z.number().int().min(1),
  leaseExpiresAt: z.string(),
  attempt: z.number().int().min(1),
  deadlineAt: z.string().nullable(),
  executionSnapshot: ExecutionSnapshotSchema,
  checkpointRefs: z.array(CheckpointRefSchema).default([]),
});
export type ClaimResult = z.infer<typeof ClaimResultSchema>;

/* ------------------------------------------------------------------ */
/* Lease-bound reports                                                 */
/* ------------------------------------------------------------------ */

export const LeaseBoundRequestSchema = z.object({
  leaseEpoch: z.number().int().min(1),
});

export const TaskHeartbeatRequestSchema = LeaseBoundRequestSchema.extend({});
export type TaskHeartbeatRequest = z.infer<typeof TaskHeartbeatRequestSchema>;

export const TaskHeartbeatAckSchema = z.object({
  leaseExpiresAt: z.string(),
  cancelRequested: z.boolean().default(false),
});
export type TaskHeartbeatAck = z.infer<typeof TaskHeartbeatAckSchema>;

export const SaveStepRequestSchema = LeaseBoundRequestSchema.extend({
  inputHash: z.string().min(1),
  outputRef: z.string().min(1),
  sessionRef: z.string().nullable().optional(),
  status: z.enum(['SUCCEEDED', 'FAILED']).default('SUCCEEDED'),
});
export type SaveStepRequest = z.infer<typeof SaveStepRequestSchema>;

export const SaveStepAckSchema = z.object({
  stepKey: z.string(),
  generation: z.number().int().min(0),
  /** true when an identical success checkpoint already existed (RUN-04 replay). */
  replayed: z.boolean(),
});
export type SaveStepAck = z.infer<typeof SaveStepAckSchema>;

export const ProgressReportSchema = LeaseBoundRequestSchema.extend({
  percent: z.number().min(0).max(100),
  message: z.string().max(512).optional(),
});
export type ProgressReport = z.infer<typeof ProgressReportSchema>;

export const ChildTaskSpecSchema = z.object({
  taskKey: z.string().min(1), // deterministic, not array index
  kind: z.string().min(1), // registered handler kind
  payloadRef: z.record(z.string(), z.unknown()),
  payloadHash: z.string().min(1),
});
export type ChildTaskSpec = z.infer<typeof ChildTaskSpecSchema>;

export const SpawnChildrenRequestSchema = LeaseBoundRequestSchema.extend({
  children: z.array(ChildTaskSpecSchema).min(1),
  joinPolicy: z.literal('all-success'), // v1: only all-success
  continuationRef: z.string().min(1),
});
export type SpawnChildrenRequest = z.infer<typeof SpawnChildrenRequestSchema>;

export const SpawnChildrenAckSchema = z.object({
  childTaskIds: z.array(z.string().uuid()),
  parentState: TaskStateSchema,
});
export type SpawnChildrenAck = z.infer<typeof SpawnChildrenAckSchema>;

export const WaitInputRequestSchema = LeaseBoundRequestSchema.extend({
  waitKey: z.string().min(1),
  inputSchema: z.record(z.string(), z.unknown()),
  uiSchema: z.record(z.string(), z.unknown()).optional(),
  contextRef: z.string().nullable().optional(),
  expiresAt: z.string().optional(),
});
export type WaitInputRequest = z.infer<typeof WaitInputRequestSchema>;

export const WaitInputAckSchema = z.object({
  waitId: z.string().min(1),
  expiresAt: z.string(),
});
export type WaitInputAck = z.infer<typeof WaitInputAckSchema>;

export const CompleteTaskRequestSchema = LeaseBoundRequestSchema.extend({
  resultRef: z.string().min(1),
  resultHash: z.string().min(1),
  /** IDs extracted from typed, successfully finalized worker output refs. */
  outputArtifactIds: z.array(z.string().uuid()).default([]),
});
export type CompleteTaskRequest = z.infer<typeof CompleteTaskRequestSchema>;

export const FailTaskRequestSchema = LeaseBoundRequestSchema.extend({
  errorCode: z.string().min(1),
  retryable: z.boolean(),
  retryAfterMs: z.number().int().min(0).optional(),
  detail: z.string().max(2048).optional(),
});
export type FailTaskRequest = z.infer<typeof FailTaskRequestSchema>;

export const TaskReportAckSchema = z.object({
  taskId: z.string().uuid(),
  state: TaskStateSchema,
  operationState: OperationStateSchema,
  /** true when the report matched an already-committed terminal state (idempotent replay). */
  replayed: z.boolean().default(false),
  nextAttemptAt: z.string().nullable().optional(),
});
export type TaskReportAck = z.infer<typeof TaskReportAckSchema>;

/* ------------------------------------------------------------------ */
/* Artifacts (runtime)                                                 */
/* ------------------------------------------------------------------ */

/** Public-facing purposes can cross operation boundaries via an explicit
 * reference. Intermediate and session artifacts are internal to one operation. */
export const ArtifactPurposeSchema = z.enum(['input', 'output', 'intermediate', 'session']);
export type ArtifactPurpose = z.infer<typeof ArtifactPurposeSchema>;

export const ArtifactUploadGrantRequestSchema = LeaseBoundRequestSchema.extend({
  purpose: ArtifactPurposeSchema,
  mimeType: z.string().min(1),
  /** Original upload name retained as declared metadata for authorized reads. */
  fileName: z.string().min(1).max(1024).optional(),
  sizeBytes: z.number().int().min(0),
});
export type ArtifactUploadGrantRequest = z.infer<typeof ArtifactUploadGrantRequestSchema>;

export const ArtifactUploadGrantSchema = z.object({
  artifactId: z.string().uuid(),
  uploadUrl: z.string().url(), // short-lived storage-facade grant URL
  expiresAt: z.string(),
});
export type ArtifactUploadGrant = z.infer<typeof ArtifactUploadGrantSchema>;

export const ArtifactFinalizeRequestSchema = LeaseBoundRequestSchema.extend({
  taskId: z.string().uuid(),
  sizeBytes: z.number().int().min(0),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type ArtifactFinalizeRequest = z.infer<typeof ArtifactFinalizeRequestSchema>;

export const ArtifactAccessRequestSchema = z.object({
  taskId: z.string().uuid(),
  leaseEpoch: z.number().int().min(1),
  mode: z.enum(['read', 'write']),
});
export type ArtifactAccessRequest = z.infer<typeof ArtifactAccessRequestSchema>;

export const ArtifactAccessGrantSchema = z.object({
  artifactId: z.string().uuid(),
  downloadUrl: z.string().url().optional(),
  uploadUrl: z.string().url().optional(),
  expiresAt: z.string(),
  /** Declared source identity plus finalized integrity metadata (read grants). */
  fileName: z.string().optional(),
  mimeType: z.string().optional(),
  sizeBytes: z.number().int().min(0).optional(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  /** Immutable object generation (S3 version ID or PostgreSQL content hash). */
  storageVersionId: z.string().min(1).max(1024).optional(),
  /**
   * W-ENC-04-GRANT-SCHEMA (delta 57 item 1): present only when the object at
   * `downloadUrl` is CIPHERTEXT. Absent means the bytes are plaintext and must
   * be used as-is.
   *
   * This is what makes the seam reversible. Without it a sealed object is
   * write-only: the worker receives the nonce/tag/AAD/DEK nowhere, so the
   * stored bytes cannot be opened by anyone (see the round-trip proof in
   * worker-sdk `enc-read-roundtrip-proof.test.ts`).
   *
   * `sizeBytes` above stays what STORAGE committed (ciphertext). The plaintext
   * length and digest live here, so a reader can verify after decrypting rather
   * than trusting the ciphertext digest as if it described the document.
   */
  encryption: StorageEnvelopeRefSchema.optional(),
});
export type ArtifactAccessGrant = z.infer<typeof ArtifactAccessGrantSchema>;

/* ------------------------------------------------------------------ */
/* Multipart upload lifecycle (DATA-00-M, draft W49-Q4-2 §2)           */
/*                                                                     */
/* ADDITIVE CONTRACT ONLY — no runtime handler is bound to these       */
/* schemas yet; wiring is the DATA-02/DATA-04 follow-up. Existing      */
/* single-PUT grant/finalize schemas are unchanged and remain the      */
/* terminal READY transition for BOTH branches (finalize re-use).      */
/* Policy constants below are the OUTER wire bounds; per-deployment    */
/* limits stay configurable at the route layer (values pending        */
/* DATA-00 §6 sign-off — do not read them as SLA commitments).         */
/* ------------------------------------------------------------------ */

/** Server-fixed part geometry: clients never choose part size. */
export const MULTIPART_FIXED_PART_BYTES = 8 * 1024 * 1024;
export const MULTIPART_MAX_PARTS = 10_000;
/** Above the single-PUT cap an artifact MUST use the multipart lifecycle. */
export const MULTIPART_MIN_TOTAL_BYTES = 64 * 1024 * 1024 + 1;
/** PROPOSED ceiling awaiting policy sign-off (S3 itself allows 5 TiB). */
export const MULTIPART_MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024;
/** Session deadline: init -> complete/abort. Orphans are swept to ABORTED. */
export const MULTIPART_SESSION_TTL_MS = 24 * 60 * 60 * 1000;
/** Per-part presigned PUT TTL; mirrors the single-PUT GRANT_TTL window. */
export const MULTIPART_PART_URL_TTL_S = 15 * 60;

const MultipartSha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const MultipartPartNumberSchema = z.number().int().min(1).max(MULTIPART_MAX_PARTS);

/* --- 1. init: creates the STAGING row + the provider-side upload; the raw */
/*     storage UploadId never leaves the server. --- */
export const MultipartInitRequestSchema = LeaseBoundRequestSchema.extend({
  /** Client-generated replay key: same token + same params -> same artifact. */
  uploadToken: z.string().uuid(),
  purpose: ArtifactPurposeSchema,
  mimeType: z.string().min(1),
  fileName: z.string().min(1).max(1024).optional(),
  sizeBytes: z.number().int().min(MULTIPART_MIN_TOTAL_BYTES).max(MULTIPART_MAX_TOTAL_BYTES),
});
export type MultipartInitRequest = z.infer<typeof MultipartInitRequestSchema>;

export const MultipartInitAckSchema = z.object({
  artifactId: z.string().uuid(),
  /** Opaque server-side lifecycle handle. */
  uploadHandle: z.string().min(1),
  partSizeBytes: z.number().int().min(MULTIPART_FIXED_PART_BYTES),
  /** Server-computed ceil(sizeBytes / partSizeBytes). */
  partCount: MultipartPartNumberSchema,
  expiresAt: z.string(),
  /** true when the request matched an existing uploadToken (response-loss replay). */
  replayed: z.boolean().default(false),
});
export type MultipartInitAck = z.infer<typeof MultipartInitAckSchema>;

/* --- 2. part grant: one presigned PUT per partNumber. The declared part */
/*     hash is bound into the URL so storage itself rejects altered bytes. --- */
export const MultipartPartGrantRequestSchema = LeaseBoundRequestSchema.extend({
  partNumber: MultipartPartNumberSchema,
  /** sha256 (hex) of the exact part bytes the client is about to PUT. */
  sha256: MultipartSha256Schema,
});
export type MultipartPartGrantRequest = z.infer<typeof MultipartPartGrantRequestSchema>;

export const MultipartPartGrantSchema = z.object({
  artifactId: z.string().uuid(),
  partNumber: MultipartPartNumberSchema,
  /** Single-part presigned PUT URL. NEVER log it; carries no tenant secret by design. */
  partUrl: z.string().url(),
  /** Exact part byte count fixed by the server from the init geometry. */
  sizeBytes: z.number().int().min(1),
  /** Headers the PUT must carry (content-length, x-amz-checksum-sha256 base64). */
  requiredHeaders: z.record(z.string(), z.string()),
  expiresAt: z.string(),
});
export type MultipartPartGrant = z.infer<typeof MultipartPartGrantSchema>;

/* --- 3. complete: receipts cross-checked against storage ListParts (authoritative), */
/*     then the pinned version is re-hashed whole BEFORE the commit is recorded. --- */
export const MultipartPartReceiptSchema = z.object({
  partNumber: MultipartPartNumberSchema,
  /** etag returned by storage on the part PUT. */
  etag: z.string().min(1).max(256),
  sizeBytes: z.number().int().min(1),
  sha256: MultipartSha256Schema,
});
export type MultipartPartReceipt = z.infer<typeof MultipartPartReceiptSchema>;

export const MultipartCompleteRequestSchema = LeaseBoundRequestSchema.extend({
  /** Structural only: must cover 1..partCount exactly, ascending — coverage is a
   *  server-side guard (409 PART_SET_MISMATCH), not expressible per-request here. */
  parts: z.array(MultipartPartReceiptSchema).min(1).max(MULTIPART_MAX_PARTS),
  /** Whole-object sha256; verified by server-side re-hash of the pinned version. */
  sha256: MultipartSha256Schema,
});
export type MultipartCompleteRequest = z.infer<typeof MultipartCompleteRequestSchema>;

export const MultipartCompleteAckSchema = z.object({
  artifactId: z.string().uuid(),
  sizeBytes: z.number().int().min(0),
  sha256: MultipartSha256Schema,
  /** Bytes committed to the pinned version; the row remains STAGING until finalize. */
  committed: z.literal(true),
  /** Lost-response replay: identical ack when committed bytes are unchanged. */
  replayed: z.boolean().default(false),
});
export type MultipartCompleteAck = z.infer<typeof MultipartCompleteAckSchema>;

/* --- 4. abort: terminal and idempotent. --- */
export const MultipartAbortRequestSchema = LeaseBoundRequestSchema.extend({
  reason: z.enum(['cancelled', 'superseded', 'failed']).default('cancelled'),
});
export type MultipartAbortRequest = z.infer<typeof MultipartAbortRequestSchema>;

export const MultipartAbortAckSchema = z.object({
  artifactId: z.string().uuid(),
  state: z.literal('ABORTED'),
  replayed: z.boolean().default(false),
});
export type MultipartAbortAck = z.infer<typeof MultipartAbortAckSchema>;

/* ------------------------------------------------------------------ */
/* Invocation grants                                                   */
/* ------------------------------------------------------------------ */

export const InvocationGrantRequestSchema = LeaseBoundRequestSchema.extend({
  stepKey: z.string().min(1),
  bindingSlot: z.string().min(1),
  inputHash: z.string().min(1),
  artifactIds: z.array(z.string().uuid()).max(4).default([]),
}).superRefine((request, context) => {
  if (new Set(request.artifactIds).size !== request.artifactIds.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, path: ['artifactIds'], message: 'Artifact IDs must be unique.' });
  }
});
export type InvocationGrantRequest = z.infer<typeof InvocationGrantRequestSchema>;

export const InvocationGrantSchema = z.object({
  grant: z.string().min(1), // signed short-lived token (opaque to worker)
  invocationId: z.string().min(1), // stable for the logical step; reused on transport retry
  connectorId: z.string(),
  connectorRevision: z.number().int(),
  expiresAt: z.string(),
  allowedOptions: z.record(z.string(), z.unknown()).default({}),
});
export type InvocationGrant = z.infer<typeof InvocationGrantSchema>;

/* ------------------------------------------------------------------ */
/* Usage ingestion (connector → platform)                              */
/* ------------------------------------------------------------------ */

export const UsageEventSchema = z.object({
  eventId: z.string().min(1), // unique; platform dedups on this
  invocationId: z.string().min(1),
  operationId: z.string().uuid(),
  taskId: z.string().uuid(),
  units: z.object({
    inputTokens: z.number().int().min(0).default(0),
    outputTokens: z.number().int().min(0).default(0),
    pages: z.number().int().min(0).optional(),
  }),
  costMicrousd: z.number().int().min(0).default(0),
  currency: z.literal('USD').default('USD'),
  measurement: z.enum(['measured', 'estimated']),
  occurredAt: z.string(),
});
export type UsageEvent = z.infer<typeof UsageEventSchema>;

export const UsageIngestBatchSchema = z.object({
  events: z.array(UsageEventSchema).min(1).max(500),
});
export type UsageIngestBatch = z.infer<typeof UsageIngestBatchSchema>;

export const UsageIngestAckSchema = z.object({
  accepted: z.array(z.string()),
  duplicates: z.array(z.string()),
});
export type UsageIngestAck = z.infer<typeof UsageIngestAckSchema>;

/* ------------------------------------------------------------------ */
/* Workspace reference lookup (W47-C1: ART-02 sweeper guard)            */
/* ------------------------------------------------------------------ */

/**
 * W47-C1 query: does a temp workspace still hold an ACTIVE reference —
 * a non-terminal task or operation (or an OPEN human wait) under this
 * tenant whose checkpoint/artifact metadata may still point at it?
 * Read-only: no writes, no side effects.
 *
 * Honest boundary: the platform stores `storage_key = art-<uuid>` and
 * `output_ref = artifact://<id>` — never worker-local temp paths. The
 * lookup therefore answers per-tenant ACTIVE presence keyed by `tenantId`
 * (the `workspacePath` is echoed back for the caller's diagnosis, not
 * used as a DB key — there is no workspace-path column anywhere).
 */
export const WorkspaceReferenceQuerySchema = z.object({
  /** Worker-local temp dir (echoed in the response; not a DB key). */
  workspacePath: z.string().min(1).max(1024),
  /** Tenant whose ACTIVE metadata/checkpoints are inspected. */
  tenantId: z.string().uuid(),
});
export type WorkspaceReferenceQuery = z.infer<typeof WorkspaceReferenceQuerySchema>;

export const WorkspaceReferenceResultSchema = z.object({
  workspacePath: z.string(),
  tenantId: z.string().uuid(),
  /** true when a non-terminal task/operation or OPEN wait references this tenant's metadata. */
  referenced: z.boolean(),
  /** How many ACTIVE holders were found (0 when referenced is false). */
  activeHolders: z.number().int().min(0),
});
export type WorkspaceReferenceResult = z.infer<typeof WorkspaceReferenceResultSchema>;

/* ------------------------------------------------------------------ */
/* Lease defaults (docs 07 test values)                                */
/* ------------------------------------------------------------------ */

export const LEASE_DEFAULTS = {
  leaseMs: 60_000,
  heartbeatIntervalMs: 15_000,
} as const;
