import { z } from 'zod';

const SafeIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const ImageDigestSchema = z.string().max(512).regex(/^.+@sha256:[a-f0-9]{64}$/);
const TimestampSchema = z.string().datetime({ offset: true });
const CountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);

/** Immutable identity expected by the host runner. All values are also pinned
 * from the Connector process environment; a request cannot select another
 * replica or image to drain. */
export const ConnectorReplicaIdentitySchema = z.object({
  slot: z.enum(['blue', 'green']),
  runtimeIdentity: SafeIdSchema,
  replicaId: SafeIdSchema,
  revision: SafeIdSchema,
  imageDigest: ImageDigestSchema,
}).strict();
export type ConnectorReplicaIdentity = z.infer<typeof ConnectorReplicaIdentitySchema>;

export const ConnectorReplicaRuntimeReadRequestSchema = ConnectorReplicaIdentitySchema;
export type ConnectorReplicaRuntimeReadRequest = z.infer<typeof ConnectorReplicaRuntimeReadRequestSchema>;

export const ConnectorReplicaControlCommandSchema = ConnectorReplicaIdentitySchema.extend({
  expectedRevision: SafeIdSchema,
  expectedImageDigest: ImageDigestSchema,
  expectedControlRevision: CountSchema,
  reason: z.enum(['maintenance-rollout', 'maintenance-rollback']),
}).strict();
export type ConnectorReplicaControlCommand = z.infer<typeof ConnectorReplicaControlCommandSchema>;

export const ConnectorReplicaControlAckSchema = z.object({
  controlRevision: CountSchema.min(1),
  requestedAt: TimestampSchema,
}).strict();
export type ConnectorReplicaControlAck = z.infer<typeof ConnectorReplicaControlAckSchema>;

export const ConnectorReplicaRuntimeObservationSchema = ConnectorReplicaIdentitySchema.extend({
  service: z.literal('connector'),
  /** Database cluster identity observed from the attached PostgreSQL server. */
  clusterName: z.string().min(1).max(256).optional(),
  readiness: z.enum(['READY', 'DEGRADED', 'DRAINING', 'OFFLINE', 'UNKNOWN']),
  observedAt: TimestampSchema,
  /** Exact process boot that took this observation and owns its effect permits. */
  bootId: z.string().uuid(),
  liveness: z.enum(['LIVE', 'NOT_LIVE', 'UNKNOWN']).optional(),
  livenessObservedAt: TimestampSchema.optional(),
  /** Independent dependency probes from this Connector process. */
  dependencies: z.object({
    postgres: z.object({ state: z.enum(['HEALTHY', 'UNAVAILABLE', 'UNKNOWN']), observedAt: TimestampSchema }).strict(),
    redis: z.object({ state: z.enum(['HEALTHY', 'UNAVAILABLE', 'UNKNOWN']), observedAt: TimestampSchema }).strict(),
  }).strict().optional(),
  /** Present only for isolated restore processes; derived from live composition controls. */
  externalEffects: z.object({
    admission: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
    dispatch: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
    providerInvocation: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
    connectorPoll: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
    usageDelivery: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
    webhookDelivery: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
    alertEmission: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
    cleanup: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
    historicalMaintenance: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
    migrations: z.enum(['DISABLED', 'ENABLED', 'UNKNOWN']),
  }).strict().optional(),
  workObservedAt: TimestampSchema,
  controlRevision: CountSchema.min(1),
  controlState: z.enum(['OPEN', 'PAUSED', 'DRAINING']),
  /** Null until this exact process has observed and acknowledged the durable
   * control revision; absence must never be treated as a fresh acknowledgement. */
  controlAcknowledgedAt: TimestampSchema.nullable(),
  /** Persisted with the acknowledgement timestamp; it must equal bootId. */
  controlAcknowledgedBootId: z.string().uuid().nullable(),
  work: z.object({
    workerLeases: z.object({ applicable: z.literal(false), count: z.null() }).strict(),
    sdkActiveTasks: z.object({ applicable: z.literal(false), count: z.null() }).strict(),
    /** Active states include IN_FLIGHT, PENDING, POLLING and UNKNOWN. */
    connectorInvocations: z.object({ applicable: z.literal(true), count: CountSchema.nullable() }).strict(),
    orchestratorRequests: z.object({ applicable: z.literal(false), count: z.null() }).strict(),
    dispatches: z.object({ applicable: z.literal(false), count: z.null() }).strict(),
  }).strict(),
}).strict();
export type ConnectorReplicaRuntimeObservation = z.infer<typeof ConnectorReplicaRuntimeObservationSchema>;

const BackupFenceRevisionSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const BackupFenceExpectedRevisionSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const BackupIdSchema = z.string().min(1).max(128).regex(/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/);
const MaintenanceJobIdSchema = z.string().uuid();
const MaintenanceItemIdSchema = SafeIdSchema;
const MaintenanceExecutionFenceSchema = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const RuntimeIdentitySchema = SafeIdSchema;
const ExecutionTokenSchema = z.string().min(32).max(512);

/** Authenticated host command for the separate backup-only effect barrier.
 * `fenceRevision` is intentionally separate from the process image revision. */
export const ConnectorBackupEffectFenceCommandSchema = ConnectorReplicaIdentitySchema.extend({
  fenceId: z.string().uuid(),
  fenceRevision: BackupFenceRevisionSchema,
  expectedFenceRevision: BackupFenceExpectedRevisionSchema,
  backupId: BackupIdSchema,
  maintenanceJobId: MaintenanceJobIdSchema,
  maintenanceItemId: MaintenanceItemIdSchema,
  maintenanceExecutionFence: MaintenanceExecutionFenceSchema,
  ownerRuntimeIdentity: RuntimeIdentitySchema,
  ownerBootId: z.string().uuid(),
  executionToken: ExecutionTokenSchema,
  action: z.enum(['HOLD', 'RELEASE']),
}).strict();
export type ConnectorBackupEffectFenceCommand = z.infer<typeof ConnectorBackupEffectFenceCommandSchema>;

export const ConnectorBackupEffectFenceObservationRequestSchema = ConnectorReplicaIdentitySchema.extend({
  fenceId: z.string().uuid(),
  expectedFenceRevision: BackupFenceRevisionSchema,
}).strict();
export type ConnectorBackupEffectFenceObservationRequest = z.infer<typeof ConnectorBackupEffectFenceObservationRequestSchema>;

const BackupFenceCountSchema = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const NullableTimestampSchema = TimestampSchema.nullable();

export const ConnectorBackupEffectFenceObservationSchema = ConnectorReplicaIdentitySchema.extend({
  fence: z.object({
    fenceId: z.string().uuid().nullable(),
    fenceRevision: BackupFenceExpectedRevisionSchema,
    state: z.enum(['OPEN', 'HELD', 'UNKNOWN']),
    acknowledgedAt: NullableTimestampSchema,
    bootId: z.string().uuid(),
  }).strict(),
  work: z.object({
    processActiveInvocations: BackupFenceCountSchema,
    processActivePolls: BackupFenceCountSchema,
    processActiveUsageSends: BackupFenceCountSchema,
    effectPermits: z.object({
      prepared: BackupFenceCountSchema,
      active: BackupFenceCountSchema,
      settling: BackupFenceCountSchema,
      unknown: BackupFenceCountSchema,
    }).strict(),
    unclosedEffectPermits: BackupFenceCountSchema,
    unresolvedInvocationHolds: BackupFenceCountSchema,
    unknownUsageDeliveries: BackupFenceCountSchema,
  }).strict(),
  observedAt: TimestampSchema,
  workObservedAt: TimestampSchema,
}).strict();
export type ConnectorBackupEffectFenceObservation = z.infer<typeof ConnectorBackupEffectFenceObservationSchema>;
