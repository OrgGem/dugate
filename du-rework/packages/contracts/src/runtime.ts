import { z } from 'zod';
import { OperationStateSchema, TaskStateSchema } from './operations';

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
    connectorBindings: z.record(z.string(), z.string()).default({}), // slot → connectorId@revision
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

export const ArtifactUploadGrantRequestSchema = LeaseBoundRequestSchema.extend({
  purpose: z.enum(['input', 'output', 'intermediate', 'session']),
  mimeType: z.string().min(1),
  sizeBytes: z.number().int().min(0),
});
export type ArtifactUploadGrantRequest = z.infer<typeof ArtifactUploadGrantRequestSchema>;

export const ArtifactUploadGrantSchema = z.object({
  artifactId: z.string().uuid(),
  storageKey: z.string().min(1),
  uploadUrl: z.string().url(), // short-lived presigned
  expiresAt: z.string(),
});
export type ArtifactUploadGrant = z.infer<typeof ArtifactUploadGrantSchema>;

export const ArtifactFinalizeRequestSchema = z.object({
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
});
export type ArtifactAccessGrant = z.infer<typeof ArtifactAccessGrantSchema>;

/* ------------------------------------------------------------------ */
/* Invocation grants                                                   */
/* ------------------------------------------------------------------ */

export const InvocationGrantRequestSchema = LeaseBoundRequestSchema.extend({
  stepKey: z.string().min(1),
  bindingSlot: z.string().min(1),
  inputHash: z.string().min(1),
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
/* Lease defaults (docs 07 test values)                                */
/* ------------------------------------------------------------------ */

export const LEASE_DEFAULTS = {
  leaseMs: 60_000,
  heartbeatIntervalMs: 15_000,
} as const;