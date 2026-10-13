import { z } from 'zod';

/**
 * ORV14 Admin maintenance and host control-plane wire contracts.
 * These DTOs contain references and observations only; credentials, signed
 * URLs, object keys and raw provider payloads never cross this boundary.
 */

const SafeIdSchema = z.string().min(1).max(256).regex(/^[A-Za-z0-9._:@/-]+$/);
const IsoDateSchema = z.string().datetime({ offset: true });
const NonNegativeIntSchema = z.number().int().nonnegative();

export const MaintenanceFreshnessSchema = z.enum(['FRESH', 'STALE', 'UNAVAILABLE']);
export type MaintenanceFreshness = z.infer<typeof MaintenanceFreshnessSchema>;

export const MaintenanceSourceSchema = z.enum([
  'postgres',
  'redis',
  'runtime-heartbeat',
  'deployment-adapter',
  'artifact-storage',
  'host-agent',
]);
export type MaintenanceSource = z.infer<typeof MaintenanceSourceSchema>;

export const MaintenanceControlStateSchema = z.enum(['OPEN', 'PAUSED', 'DRAINING']);
export type MaintenanceControlState = z.infer<typeof MaintenanceControlStateSchema>;

export const MaintenanceScopeSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('platform') }).strict(),
  z.object({ kind: z.literal('tenant'), tenantId: SafeIdSchema }).strict(),
  z.object({ kind: z.literal('business'), businessId: SafeIdSchema, businessVersion: SafeIdSchema.optional() }).strict(),
]);
export type MaintenanceScope = z.infer<typeof MaintenanceScopeSchema>;

export const ServiceReplicaSchema = z.object({
  serviceId: SafeIdSchema,
  replicaId: SafeIdSchema,
  role: z.enum(['orchestrator', 'connector', 'worker']),
  businessId: SafeIdSchema.nullable(),
  businessVersion: SafeIdSchema.nullable(),
  desiredRevision: SafeIdSchema.nullable(),
  observedRevision: SafeIdSchema.nullable(),
  state: z.enum(['LIVE', 'READY', 'DRAINING', 'OFFLINE', 'DEGRADED', 'UNKNOWN']),
  lastSeenAt: IsoDateSchema.nullable(),
  activeWork: NonNegativeIntSchema.nullable(),
  controlRevision: NonNegativeIntSchema.nullable(),
  controlState: MaintenanceControlStateSchema.nullable(),
});
export type ServiceReplica = z.infer<typeof ServiceReplicaSchema>;

export const ServiceDependencySchema = z.object({
  dependencyId: SafeIdSchema,
  kind: z.enum(['postgres', 'redis', 's3', 'vault', 'connector', 'worker']),
  state: z.enum(['HEALTHY', 'DEGRADED', 'UNAVAILABLE', 'UNKNOWN']),
  observedAt: IsoDateSchema.nullable(),
  detailCode: SafeIdSchema.nullable(),
});
export type ServiceDependency = z.infer<typeof ServiceDependencySchema>;

export const ServiceInventorySchema = z.object({
  sampledAt: IsoDateSchema,
  source: z.array(MaintenanceSourceSchema).min(1),
  freshness: MaintenanceFreshnessSchema,
  services: z.array(z.object({
    serviceId: SafeIdSchema,
    kind: z.enum(['orchestrator', 'connector', 'worker']),
    dependencies: z.array(ServiceDependencySchema),
    replicas: z.array(ServiceReplicaSchema),
  }).strict()),
}).strict();
export type ServiceInventory = z.infer<typeof ServiceInventorySchema>;

export const QueueInventorySchema = z.object({
  sampledAt: IsoDateSchema,
  source: z.array(MaintenanceSourceSchema).min(1),
  freshness: MaintenanceFreshnessSchema,
  queues: z.array(z.object({
    queueName: SafeIdSchema,
    businessId: SafeIdSchema,
    businessVersion: SafeIdSchema,
    counts: z.object({
      waiting: NonNegativeIntSchema.nullable(),
      delayed: NonNegativeIntSchema.nullable(),
      active: NonNegativeIntSchema.nullable(),
      failed: NonNegativeIntSchema.nullable(),
    }).strict(),
    oldestRunnableAgeMs: NonNegativeIntSchema.nullable(),
    admission: z.object({
      state: MaintenanceControlStateSchema,
      revision: NonNegativeIntSchema,
      activeLeases: NonNegativeIntSchema,
      freshHeartbeats: NonNegativeIntSchema,
      observedAcks: NonNegativeIntSchema,
      expectedAcks: NonNegativeIntSchema,
    }).strict(),
    workerCompatibility: z.object({
      compatibleOnline: NonNegativeIntSchema,
      compatibleDraining: NonNegativeIntSchema,
      incompatible: NonNegativeIntSchema,
      offline: NonNegativeIntSchema,
    }).strict(),
  }).strict()),
}).strict();
export type QueueInventory = z.infer<typeof QueueInventorySchema>;

export const QueueActionSchema = z.enum(['pause', 'drain', 'resume', 'retry']);
export type QueueAction = z.infer<typeof QueueActionSchema>;

export const QueueActionPreviewRequestSchema = z.object({
  queueName: SafeIdSchema,
  action: QueueActionSchema,
  scope: MaintenanceScopeSchema,
  deliveryId: SafeIdSchema.optional(),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((value, ctx) => {
  if (value.action === 'retry' && !value.deliveryId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deliveryId'], message: 'retry requires one explicit deliveryId' });
  }
  if (value.action !== 'retry' && value.deliveryId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['deliveryId'], message: 'deliveryId is only valid for retry' });
  }
});
export type QueueActionPreviewRequest = z.infer<typeof QueueActionPreviewRequestSchema>;

export const QueueActionPreviewSchema = z.object({
  previewId: SafeIdSchema,
  action: QueueActionSchema,
  queueName: SafeIdSchema,
  scope: MaintenanceScopeSchema,
  controlRevision: NonNegativeIntSchema,
  expiresAt: IsoDateSchema,
  activeLeases: NonNegativeIntSchema,
  freshWorkers: NonNegativeIntSchema,
  expectedAcks: NonNegativeIntSchema,
  observedAcks: NonNegativeIntSchema,
  eligibleDeliveries: NonNegativeIntSchema,
  skippedDeliveries: NonNegativeIntSchema,
  unknownDeliveries: NonNegativeIntSchema,
  warnings: z.array(SafeIdSchema),
}).strict();
export type QueueActionPreview = z.infer<typeof QueueActionPreviewSchema>;

export const ConfirmQueueActionSchema = z.object({
  previewId: SafeIdSchema,
  expectedRevision: NonNegativeIntSchema,
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type ConfirmQueueAction = z.infer<typeof ConfirmQueueActionSchema>;

export const QueueActionJobSchema = z.object({
  jobId: SafeIdSchema,
  action: QueueActionSchema,
  queueName: SafeIdSchema,
  scope: MaintenanceScopeSchema,
  state: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'UNKNOWN']),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  controlRevision: NonNegativeIntSchema,
  activeLeases: NonNegativeIntSchema,
  freshWorkers: NonNegativeIntSchema,
  expectedAcks: NonNegativeIntSchema,
  observedAcks: NonNegativeIntSchema,
  eligibleDeliveries: NonNegativeIntSchema,
  skippedDeliveries: NonNegativeIntSchema,
  unknownDeliveries: NonNegativeIntSchema,
  lastErrorCode: SafeIdSchema.nullable(),
}).strict();
export type QueueActionJob = z.infer<typeof QueueActionJobSchema>;

export const MaintenanceItemOutcomeSchema = z.object({
  itemId: SafeIdSchema,
  itemType: z.enum(['artifact', 'task', 'delivery', 'backup', 'restore-target', 'replica']),
  status: z.enum(['PENDING', 'RUNNING', 'APPLIED', 'SKIPPED', 'FAILED', 'UNKNOWN']),
  code: SafeIdSchema.nullable(),
  evidence: z.record(z.union([z.string().max(512), NonNegativeIntSchema, z.boolean(), z.null()])).default({}),
  updatedAt: IsoDateSchema,
}).strict();
export type MaintenanceItemOutcome = z.infer<typeof MaintenanceItemOutcomeSchema>;

export const DurableJobStateSchema = z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'PARTIAL', 'FAILED', 'CANCELLED', 'UNKNOWN']);
export type DurableJobState = z.infer<typeof DurableJobStateSchema>;

export const MaintenanceKindSchema = z.enum([
  'cache_cleanup',
  'retention_cleanup',
  'orphan_reconcile',
  'stalled_lease_recovery',
  'failed_delivery_recovery',
  'backup',
  'restore',
]);
export type MaintenanceKind = z.infer<typeof MaintenanceKindSchema>;

/** Effective platform retention values are supplied by the Settings owner. */
export const RetentionPolicySnapshotSchema = z.object({
  revision: NonNegativeIntSchema,
  cacheTtlHours: z.number().int().min(0),
  outputRetentionDays: z.number().int().min(0),
  cleanupIntervalSeconds: z.number().int().min(0),
}).strict();
export type RetentionPolicySnapshot = z.infer<typeof RetentionPolicySnapshotSchema>;

export const MaintenancePreviewRequestSchema = z.object({
  kind: MaintenanceKindSchema,
  scope: MaintenanceScopeSchema,
  filters: z.object({
    olderThan: IsoDateSchema.optional(),
    artifactIds: z.array(SafeIdSchema).max(1000).optional(),
    taskIds: z.array(SafeIdSchema).max(1000).optional(),
    deliveryIds: z.array(SafeIdSchema).max(1000).optional(),
    backupId: SafeIdSchema.optional(),
    backupTarget: SafeIdSchema.optional(),
    targetGenerationId: SafeIdSchema.optional(),
    maxItems: z.number().int().min(1).max(500).default(100),
  }).strict().default({ maxItems: 100 }),
  reason: z.string().trim().min(3).max(500),
}).strict().superRefine((value, ctx) => {
  if (value.kind === 'restore' && (!value.filters.backupId || !value.filters.targetGenerationId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters'], message: 'restore requires a named backupId and new targetGenerationId' });
  }
  if (value.kind !== 'restore' && (value.filters.backupId || value.filters.targetGenerationId)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters'], message: 'backupId and targetGenerationId are only valid for restore' });
  }
  if (value.kind === 'backup' && !value.filters.backupTarget) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', 'backupTarget'], message: 'backup requires an allowlisted named target' });
  }
  if (value.kind !== 'backup' && value.filters.backupTarget) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['filters', 'backupTarget'], message: 'backupTarget is only valid for backup' });
  }
});
export type MaintenancePreviewRequest = z.infer<typeof MaintenancePreviewRequestSchema>;

export const MaintenancePreviewSchema = z.object({
  previewId: SafeIdSchema,
  kind: MaintenanceKindSchema,
  scope: MaintenanceScopeSchema,
  createdAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  retentionRevision: NonNegativeIntSchema.nullable(),
  candidateCount: NonNegativeIntSchema,
  eligibleCount: NonNegativeIntSchema,
  skippedCount: NonNegativeIntSchema,
  unknownCount: NonNegativeIntSchema,
  estimatedBytes: NonNegativeIntSchema.nullable(),
  targets: z.array(z.object({
    itemId: SafeIdSchema,
    itemType: MaintenanceItemOutcomeSchema.shape.itemType,
    eligibility: z.enum(['ELIGIBLE', 'SKIPPED', 'UNKNOWN']),
    reasonCode: SafeIdSchema.nullable(),
    estimatedBytes: NonNegativeIntSchema.nullable(),
  }).strict()).max(1000),
}).strict();
export type MaintenancePreview = z.infer<typeof MaintenancePreviewSchema>;

export const MaintenanceJobSchema = z.object({
  jobId: SafeIdSchema,
  kind: MaintenanceKindSchema,
  state: DurableJobStateSchema,
  scope: MaintenanceScopeSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  totalItems: NonNegativeIntSchema,
  completedItems: NonNegativeIntSchema,
  appliedItems: NonNegativeIntSchema,
  skippedItems: NonNegativeIntSchema,
  failedItems: NonNegativeIntSchema,
  unknownItems: NonNegativeIntSchema,
  lastErrorCode: SafeIdSchema.nullable(),
  items: z.array(MaintenanceItemOutcomeSchema),
}).strict();
export type MaintenanceJob = z.infer<typeof MaintenanceJobSchema>;

export const StartMaintenanceJobSchema = z.object({
  previewId: SafeIdSchema,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type StartMaintenanceJob = z.infer<typeof StartMaintenanceJobSchema>;

export const ReplicaRolloutPreviewRequestSchema = z.object({
  service: z.enum(['orchestrator', 'connector', 'worker']),
  desiredRevision: SafeIdSchema,
  scope: MaintenanceScopeSchema,
  strategy: z.enum(['two_slot', 'per_replica']).default('two_slot'),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type ReplicaRolloutPreviewRequest = z.infer<typeof ReplicaRolloutPreviewRequestSchema>;

export const ReplicaRolloutPreviewSchema = z.object({
  previewId: SafeIdSchema,
  service: z.enum(['orchestrator', 'connector', 'worker']),
  desiredRevision: SafeIdSchema,
  scope: MaintenanceScopeSchema,
  strategy: z.enum(['two_slot', 'per_replica']),
  createdAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  currentReplicas: z.number().int().nonnegative(),
  minimumReadyReplicas: z.number().int().positive(),
  requiresIngressSwitch: z.boolean(),
  warnings: z.array(SafeIdSchema),
}).strict();
export type ReplicaRolloutPreview = z.infer<typeof ReplicaRolloutPreviewSchema>;

export const ExecuteReplicaRolloutSchema = z.object({
  previewId: SafeIdSchema,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type ExecuteReplicaRollout = z.infer<typeof ExecuteReplicaRolloutSchema>;

export const ReplicaRolloutJobSchema = z.object({
  jobId: SafeIdSchema,
  version: NonNegativeIntSchema,
  service: z.enum(['orchestrator', 'connector', 'worker']),
  desiredRevision: SafeIdSchema,
  state: DurableJobStateSchema,
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
  oldIngressTarget: SafeIdSchema.nullable(),
  activeIngressTarget: SafeIdSchema.nullable(),
  rollbackState: z.enum(['NOT_REQUIRED', 'PENDING', 'APPLIED', 'FAILED', 'UNKNOWN']),
  replicas: z.array(z.object({
    replicaId: SafeIdSchema,
    slot: SafeIdSchema.nullable(),
    desiredRevision: SafeIdSchema,
    observedRevision: SafeIdSchema.nullable(),
    state: z.enum(['PENDING', 'STARTING', 'READY', 'DRAINING', 'STOPPED', 'FAILED', 'UNKNOWN']),
    activeWork: NonNegativeIntSchema.nullable(),
    acknowledgedAt: IsoDateSchema.nullable(),
    code: SafeIdSchema.nullable(),
  }).strict()),
  lastErrorCode: SafeIdSchema.nullable(),
}).strict();
export type ReplicaRolloutJob = z.infer<typeof ReplicaRolloutJobSchema>;

export const PreviewReplicaRollbackSchema = z.object({
  reason: z.string().trim().min(3).max(500),
}).strict();
export type PreviewReplicaRollback = z.infer<typeof PreviewReplicaRollbackSchema>;

export const ReplicaRollbackPreviewSchema = z.object({
  previewId: SafeIdSchema,
  jobId: SafeIdSchema,
  createdAt: IsoDateSchema,
  expiresAt: IsoDateSchema,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  oldIngressTarget: SafeIdSchema.nullable(),
  activeIngressTarget: SafeIdSchema.nullable(),
  targetIngress: SafeIdSchema.nullable(),
  eligible: z.boolean(),
  warnings: z.array(SafeIdSchema),
}).strict();
export type ReplicaRollbackPreview = z.infer<typeof ReplicaRollbackPreviewSchema>;

export const ExecuteReplicaRollbackSchema = z.object({
  previewId: SafeIdSchema,
  expectedVersion: z.string().regex(/^[a-f0-9]{64}$/),
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type ExecuteReplicaRollback = z.infer<typeof ExecuteReplicaRollbackSchema>;

export const StorageGenerationBackendSchema = z.enum(['postgres', 's3']);
export type StorageGenerationBackend = z.infer<typeof StorageGenerationBackendSchema>;

const StorageGenerationStageBase = {
  expectedRevision: NonNegativeIntSchema,
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
};

export const StorageGenerationStageRequestSchema = z.discriminatedUnion('backend', [
  z.object({
    ...StorageGenerationStageBase,
    backend: z.literal('s3'),
    endpoint: z.string().trim().min(1).max(2048),
    bucket: z.string().trim().min(1).max(255),
    region: z.string().trim().min(1).max(128),
    forcePathStyle: z.boolean(),
  /** Immutable managed-secret revision handle; never a floating secret alias. */
    credentialVersionRef: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+@[1-9][0-9]*$/),
  /** Tenant UUID that owns the archived credential revision. */
    credentialOwnerTenantId: z.string().uuid(),
  urlTtlSeconds: z.number().int().positive().max(86400).nullable(),
  }).strict(),
  // The artifact PostgreSQL backend is selected by trusted server configuration.
  // Its connection details are never supplied by an Admin request.
  z.object({ ...StorageGenerationStageBase, backend: z.literal('postgres') }).strict(),
]);
export type StorageGenerationStageRequest = z.infer<typeof StorageGenerationStageRequestSchema>;

export const StorageGenerationTestResultSchema = z.object({
  generationId: SafeIdSchema,
  status: z.enum(['PASSED', 'FAILED', 'UNKNOWN']),
  checkedAt: IsoDateSchema,
  write: z.enum(['PASSED', 'FAILED', 'UNKNOWN']),
  read: z.enum(['PASSED', 'FAILED', 'UNKNOWN']),
  checksum: z.enum(['PASSED', 'FAILED', 'UNKNOWN']),
  crypto: z.enum(['PASSED', 'FAILED', 'UNKNOWN']),
  delete: z.enum(['PASSED', 'FAILED', 'UNKNOWN']),
  code: SafeIdSchema.nullable(),
}).strict();
export type StorageGenerationTestResult = z.infer<typeof StorageGenerationTestResultSchema>;

export const StorageGenerationTestRequestSchema = z.object({
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type StorageGenerationTestRequest = z.infer<typeof StorageGenerationTestRequestSchema>;

export const StorageGenerationActionRequestSchema = z.object({
  expectedRevision: NonNegativeIntSchema,
  idempotencyKey: z.string().min(8).max(256),
  reason: z.string().trim().min(3).max(500),
}).strict();
export type StorageGenerationActionRequest = z.infer<typeof StorageGenerationActionRequestSchema>;

export const StorageGenerationReadSchema = z.object({
  generationId: SafeIdSchema,
  revision: NonNegativeIntSchema,
  controlRevision: NonNegativeIntSchema,
  state: z.enum(['STAGED', 'ACTIVE', 'RETIRED', 'FAILED']),
  backend: StorageGenerationBackendSchema,
  endpoint: z.string().max(2048),
  bucket: z.string().max(255),
  region: z.string().max(128),
  forcePathStyle: z.boolean(),
  secretPresent: z.boolean(),
  /** Opaque immutable secret catalog reference for an operator's Keep action;
   * never contains the credential value itself. */
  credentialVersionRef: z.string().min(1).max(256).regex(/^[A-Za-z0-9._:/-]+@[1-9][0-9]*$/).nullable(),
  credentialOwnerTenantId: z.string().uuid().nullable(),
  urlTtlSeconds: z.number().int().positive().max(86400).nullable(),
  activatedAt: IsoDateSchema.nullable(),
  testedAt: IsoDateSchema.nullable(),
  lastTest: StorageGenerationTestResultSchema.nullable(),
}).strict();
export type StorageGenerationRead = z.infer<typeof StorageGenerationReadSchema>;

export const StorageGenerationMutationResultSchema = z.object({
  active: StorageGenerationReadSchema,
  previous: StorageGenerationReadSchema.nullable(),
  controlRevision: NonNegativeIntSchema,
}).strict();
export type StorageGenerationMutationResult = z.infer<typeof StorageGenerationMutationResultSchema>;
