import { z } from 'zod';

/** Browser-safe and host-runner DTOs for the bounded Compose control plane. */

export const COMPOSE_SAFE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
export const COMPOSE_SHA256_PATTERN = /^[a-f0-9]{64}$/;
const SafeId = z.string().regex(COMPOSE_SAFE_ID_PATTERN);
const Sha256 = z.string().regex(COMPOSE_SHA256_PATTERN);
const UtcTimestamp = z.string().datetime({ offset: true });

export const ComposeActionSchema = z.enum(['apply_release', 'rollback_release', 'restart_service']);
export type ComposeAction = z.infer<typeof ComposeActionSchema>;

export const ComposeJobStateSchema = z.enum([
  'QUEUED', 'CLAIMED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL', 'UNKNOWN', 'RECONCILED',
]);
export type ComposeJobState = z.infer<typeof ComposeJobStateSchema>;

export const ComposeAvailabilitySchema = z.enum(['FRESH', 'STALE', 'UNAVAILABLE']);
export type ComposeAvailability = z.infer<typeof ComposeAvailabilitySchema>;

export const ComposeSafeErrorCodeSchema = z.enum([
  'RUNNER_NOT_CONFIGURED',
  'SNAPSHOT_NOT_RECEIVED',
  'SNAPSHOT_INVALID',
  'MANIFEST_DIGEST_MISMATCH',
  'DOCKER_UNAVAILABLE',
  'INVENTORY_UNAVAILABLE',
  'HEALTHCHECK_FAILED',
  'COMMAND_FAILED',
  'COMMAND_TIMEOUT',
  'OUTPUT_LIMIT',
  'TARGET_BUSY',
  'STALE_SAMPLE',
  'STALE_PREVIEW',
  'TARGET_REVISION_CONFLICT',
  'IDEMPOTENCY_CONFLICT',
  'EXECUTION_UNCERTAIN',
  'RUNNER_REPORT_REJECTED',
]);
export type ComposeSafeErrorCode = z.infer<typeof ComposeSafeErrorCodeSchema>;

export const ComposeServiceStateSchema = z.enum([
  'CREATED', 'RUNNING', 'PAUSED', 'RESTARTING', 'EXITED', 'DEAD', 'REMOVING', 'UNKNOWN',
]);
export const ComposeHealthSchema = z.enum(['HEALTHY', 'UNHEALTHY', 'STARTING', 'NONE', 'UNKNOWN']).nullable();

export const ComposeObservedServiceSchema = z.object({
  serviceId: SafeId,
  containerId: z.string().max(128).nullable(),
  imageId: z.string().max(256).nullable(),
  imageDigest: z.string().max(256).nullable(),
  state: ComposeServiceStateSchema,
  health: ComposeHealthSchema,
  startedAt: UtcTimestamp.nullable(),
  finishedAt: UtcTimestamp.nullable(),
  observedReleaseId: SafeId.nullable(),
}).strict();
export type ComposeObservedService = z.infer<typeof ComposeObservedServiceSchema>;

export const ComposeCatalogServiceSchema = z.object({
  serviceId: SafeId,
  displayName: z.string().min(1).max(128),
  restartAllowed: z.boolean(),
}).strict();
export type ComposeCatalogService = z.infer<typeof ComposeCatalogServiceSchema>;

export const ComposeCatalogReleaseSchema = z.object({
  releaseId: SafeId,
  displayName: z.string().min(1).max(128),
  releaseDigest: Sha256,
  targetServices: z.array(SafeId).min(1).max(32),
  images: z.array(z.object({ serviceId: SafeId, imageDigest: z.string().max(256) }).strict()).max(32),
  migrationCompatibility: z.enum(['acknowledged', 'not_acknowledged']),
  rollbackAllowedFrom: z.array(SafeId).max(64),
}).strict();
export type ComposeCatalogRelease = z.infer<typeof ComposeCatalogReleaseSchema>;

export const ComposeActiveJobSchema = z.object({
  jobId: z.string().uuid(),
  state: z.enum(['QUEUED', 'CLAIMED', 'RUNNING', 'UNKNOWN']),
}).strict();
export type ComposeActiveJob = z.infer<typeof ComposeActiveJobSchema>;

export const ComposeCatalogProjectSchema = z.object({
  projectId: SafeId,
  displayName: z.string().min(1).max(128),
  catalogRevision: Sha256.nullable(),
  manifestDigest: Sha256.nullable(),
  availability: ComposeAvailabilitySchema,
  sampledAt: UtcTimestamp.nullable(),
  receivedAt: UtcTimestamp.nullable(),
  lastErrorCode: ComposeSafeErrorCodeSchema.nullable(),
  observedDigest: Sha256.nullable(),
  targetRevision: z.number().int().nonnegative(),
  desiredReleaseId: SafeId.nullable(),
  activeJob: ComposeActiveJobSchema.nullable(),
  services: z.array(ComposeCatalogServiceSchema).max(64),
  releases: z.array(ComposeCatalogReleaseSchema).max(128),
  observedServices: z.array(ComposeObservedServiceSchema).max(64),
}).strict();
export type ComposeCatalogProject = z.infer<typeof ComposeCatalogProjectSchema>;

export const ComposeCatalogSchema = z.object({
  configured: z.boolean(),
  hostId: SafeId.nullable(),
  manifestDigest: Sha256.nullable(),
  availability: ComposeAvailabilitySchema,
  receivedAt: UtcTimestamp.nullable(),
  lastErrorCode: ComposeSafeErrorCodeSchema.nullable(),
  projects: z.array(ComposeCatalogProjectSchema).max(64),
}).strict().superRefine((catalog, ctx) => {
  if (!catalog.configured && (catalog.hostId !== null || catalog.manifestDigest !== null || catalog.projects.length > 0)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'unconfigured catalog cannot claim host data', path: ['configured'] });
  }
  if (catalog.configured && (catalog.hostId === null || catalog.manifestDigest === null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'configured catalog requires host identity and manifest digest', path: ['configured'] });
  }
});
export type ComposeCatalog = z.infer<typeof ComposeCatalogSchema>;

/** The host supplies only safe manifest labels/IDs and selected Docker observations. */
export const ComposeRunnerProjectSnapshotSchema = z.object({
  projectId: SafeId,
  displayName: z.string().min(1).max(128),
  services: z.array(ComposeCatalogServiceSchema).max(64),
  releases: z.array(ComposeCatalogReleaseSchema).max(128),
  observedServices: z.array(ComposeObservedServiceSchema).max(64),
}).strict();
export type ComposeRunnerProjectSnapshot = z.infer<typeof ComposeRunnerProjectSnapshotSchema>;

export const ComposeRunnerSnapshotRequestSchema = z.object({
  hostId: SafeId,
  manifestDigest: Sha256,
  sampledAt: UtcTimestamp,
  projects: z.array(ComposeRunnerProjectSnapshotSchema).max(64),
}).strict();
export type ComposeRunnerSnapshotRequest = z.infer<typeof ComposeRunnerSnapshotRequestSchema>;

export const ComposeRunnerSnapshotAckSchema = z.object({
  hostId: SafeId,
  manifestDigest: Sha256,
  receivedAt: UtcTimestamp,
  projects: z.array(z.object({
    projectId: SafeId,
    catalogRevision: Sha256,
    observedDigest: Sha256,
    targetRevision: z.number().int().nonnegative(),
  }).strict()).max(64),
}).strict();
export type ComposeRunnerSnapshotAck = z.infer<typeof ComposeRunnerSnapshotAckSchema>;

export const ComposePreviewRequestSchema = z.object({
  hostId: SafeId,
  projectId: SafeId,
  action: ComposeActionSchema,
  releaseId: SafeId.optional(),
  serviceId: SafeId.optional(),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((preview, ctx) => {
  const releaseAction = preview.action === 'apply_release' || preview.action === 'rollback_release';
  if (releaseAction !== (preview.releaseId !== undefined) || releaseAction === (preview.serviceId !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'preview target does not match action', path: ['action'] });
  }
});
export type ComposePreviewRequest = z.infer<typeof ComposePreviewRequestSchema>;

export const ComposePreviewSchema = z.object({
  previewId: z.string().uuid(),
  hostId: SafeId,
  projectId: SafeId,
  action: ComposeActionSchema,
  releaseId: SafeId.nullable(),
  serviceId: SafeId.nullable(),
  reason: z.string().min(3).max(500),
  createdAt: UtcTimestamp,
  expiresAt: UtcTimestamp,
  manifestDigest: Sha256,
  observedDigest: Sha256,
  expectedTargetRevision: z.number().int().nonnegative(),
  targetServices: z.array(SafeId).max(64),
  targetReleaseDigest: Sha256.nullable(),
  impact: z.object({
    affectedServices: z.array(SafeId).max(64),
    downtime: z.enum(['possible', 'likely']),
    statefulServicesExcluded: z.literal(true),
  }).strict(),
  warnings: z.array(z.enum(['POSSIBLE_SERVICE_INTERRUPTION', 'MIGRATION_COMPATIBILITY_ACKNOWLEDGED'])).max(8),
}).strict();
export type ComposePreview = z.infer<typeof ComposePreviewSchema>;

export const ComposeSubmitJobRequestSchema = z.object({
  previewId: z.string().uuid(),
  expectedTargetRevision: z.number().int().nonnegative(),
}).strict();
export type ComposeSubmitJobRequest = z.infer<typeof ComposeSubmitJobRequestSchema>;

export const ComposePerServiceOutcomeSchema = z.object({
  serviceId: SafeId,
  status: z.enum(['SUCCEEDED', 'FAILED', 'SKIPPED', 'UNKNOWN']),
  errorCode: ComposeSafeErrorCodeSchema.nullable(),
}).strict();
export type ComposePerServiceOutcome = z.infer<typeof ComposePerServiceOutcomeSchema>;

export const ComposeUncertainReasonSchema = z.enum([
  'CLAIM_EXPIRED', 'START_ACK_LOST', 'RUNNER_LOST', 'REPORT_LOST', 'EXECUTOR_TIMEOUT', 'EXECUTION_UNCERTAIN',
]).nullable();

export const ComposeJobSchema = z.object({
  jobId: z.string().uuid(),
  previewId: z.string().uuid(),
  hostId: SafeId,
  projectId: SafeId,
  action: ComposeActionSchema,
  releaseId: SafeId.nullable(),
  serviceId: SafeId.nullable(),
  targetReleaseDigest: Sha256.nullable(),
  targetServices: z.array(SafeId).max(64),
  reason: z.string().min(3).max(500),
  actorLabel: z.string().min(1).max(128),
  state: ComposeJobStateSchema,
  stateVersion: z.number().int().positive(),
  expectedTargetRevision: z.number().int().nonnegative(),
  targetRevision: z.number().int().nonnegative(),
  createdAt: UtcTimestamp,
  startedAt: UtcTimestamp.nullable(),
  completedAt: UtcTimestamp.nullable(),
  claimExpiresAt: UtcTimestamp.nullable(),
  observedBeforeDigest: Sha256,
  startExpectedObservedDigest: Sha256,
  observedBefore: z.array(ComposeObservedServiceSchema).max(64),
  observedAfter: z.array(ComposeObservedServiceSchema).max(64).nullable(),
  observedAfterDigest: Sha256.nullable(),
  perServiceOutcomes: z.array(ComposePerServiceOutcomeSchema).max(64),
  uncertainReason: ComposeUncertainReasonSchema,
}).strict();
export type ComposeJob = z.infer<typeof ComposeJobSchema>;

export const ComposeJobListQuerySchema = z.object({
  hostId: SafeId.optional(),
  projectId: SafeId.optional(),
  state: ComposeJobStateSchema.optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict();
export type ComposeJobListQuery = z.infer<typeof ComposeJobListQuerySchema>;

export const ComposeJobPageSchema = z.object({
  items: z.array(ComposeJobSchema).max(100),
  limit: z.number().int().min(1).max(100),
  hasMore: z.boolean(),
  nextCursor: z.string().min(1).max(2048).regex(/^[A-Za-z0-9_-]+$/).optional(),
}).strict().superRefine((page, ctx) => {
  if (page.items.length > page.limit || page.hasMore !== (page.nextCursor !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid Compose job page bounds or cursor', path: ['nextCursor'] });
  }
});
export type ComposeJobPage = z.infer<typeof ComposeJobPageSchema>;

export const ComposeJobSubmissionSchema = z.object({
  job: ComposeJobSchema,
  replayed: z.boolean(),
}).strict();
export type ComposeJobSubmission = z.infer<typeof ComposeJobSubmissionSchema>;

export const ComposeRunnerClaimSchema = z.object({
  job: ComposeJobSchema,
  executionToken: z.string().min(32).max(256),
}).strict();
export type ComposeRunnerClaim = z.infer<typeof ComposeRunnerClaimSchema>;

export const ComposeRunnerClaimResponseSchema = z.object({ claim: ComposeRunnerClaimSchema.nullable() }).strict();
export type ComposeRunnerClaimResponse = z.infer<typeof ComposeRunnerClaimResponseSchema>;

export const ComposeRunnerStartRequestSchema = z.object({
  jobId: z.string().uuid(),
  executionToken: z.string().min(32).max(256),
  expectedStateVersion: z.number().int().positive(),
  manifestDigest: Sha256,
  observedDigest: Sha256,
}).strict();
export type ComposeRunnerStartRequest = z.infer<typeof ComposeRunnerStartRequestSchema>;

export const ComposeRunnerStartAckSchema = z.object({
  jobId: z.string().uuid(),
  state: z.literal('RUNNING'),
  stateVersion: z.number().int().positive(),
  startedAt: UtcTimestamp,
}).strict();
export type ComposeRunnerStartAck = z.infer<typeof ComposeRunnerStartAckSchema>;

export const ComposeRunnerCompleteRequestSchema = z.object({
  jobId: z.string().uuid(),
  executionToken: z.string().min(32).max(256),
  expectedStateVersion: z.number().int().positive(),
  manifestDigest: Sha256,
  sampledAt: UtcTimestamp,
  outcome: z.enum(['SUCCEEDED', 'FAILED', 'PARTIAL', 'UNKNOWN']),
  errorCode: ComposeSafeErrorCodeSchema.nullable(),
  uncertainReason: ComposeUncertainReasonSchema,
  observedServices: z.array(ComposeObservedServiceSchema).max(64).nullable(),
  perServiceOutcomes: z.array(ComposePerServiceOutcomeSchema).max(64),
}).strict().superRefine((input, ctx) => {
  if ((input.outcome === 'UNKNOWN') !== (input.uncertainReason !== null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'uncertainty reason must match UNKNOWN outcome', path: ['uncertainReason'] });
  }
  if (input.outcome === 'SUCCEEDED' && input.observedServices === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'success requires a fresh post-action observation', path: ['observedServices'] });
  }
});
export type ComposeRunnerCompleteRequest = z.infer<typeof ComposeRunnerCompleteRequestSchema>;

export const ComposeRunnerCompleteAckSchema = z.object({
  job: ComposeJobSchema,
}).strict();
export type ComposeRunnerCompleteAck = z.infer<typeof ComposeRunnerCompleteAckSchema>;

export const ComposeRunnerReconcileRequestSchema = z.object({
  jobId: z.string().uuid(),
  expectedStateVersion: z.number().int().positive(),
  manifestDigest: Sha256,
  sampledAt: UtcTimestamp,
  executorQuiescent: z.boolean(),
  evidenceCode: z.enum(['NO_ACTIVE_EXECUTOR', 'EXECUTOR_TERMINATED', 'MANUAL_OPERATOR_CONFIRMED', 'UNCERTAIN']),
  observedServices: z.array(ComposeObservedServiceSchema).max(64).nullable(),
  perServiceOutcomes: z.array(ComposePerServiceOutcomeSchema).max(64),
}).strict().superRefine((input, ctx) => {
  const positiveEvidence = input.evidenceCode === 'NO_ACTIVE_EXECUTOR' ||
    input.evidenceCode === 'EXECUTOR_TERMINATED' || input.evidenceCode === 'MANUAL_OPERATOR_CONFIRMED';
  if (input.executorQuiescent !== positiveEvidence) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'executorQuiescent must match the reconciliation evidence', path: ['executorQuiescent'] });
  }
  if (input.executorQuiescent && input.observedServices === null) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'quiescent reconciliation requires a fresh observation', path: ['observedServices'] });
  }
});
export type ComposeRunnerReconcileRequest = z.infer<typeof ComposeRunnerReconcileRequestSchema>;

export const ComposeRunnerReconcileAckSchema = z.object({
  job: ComposeJobSchema,
}).strict();
export type ComposeRunnerReconcileAck = z.infer<typeof ComposeRunnerReconcileAckSchema>;

export const ComposeRunnerConfigSchema = z.object({
  hostId: SafeId,
  runnerToken: z.string().min(32).max(512),
  manifestDigest: Sha256,
  maxSampleAgeMs: z.number().int().min(1_000).max(3_600_000).default(60_000),
  previewTtlMs: z.number().int().min(5_000).max(900_000).default(120_000),
  claimTtlMs: z.number().int().min(5_000).max(300_000).default(60_000),
}).strict();
export type ComposeRunnerConfig = z.infer<typeof ComposeRunnerConfigSchema>;
